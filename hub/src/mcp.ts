import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getTask, getNodeById, nodeDisplayAlias } from './db.js';
import { ADMIN_SCOPE, resolveBearer, scopeAllows, scopeAllowsAnyNode, type TokenScope } from './tokens.js';
import type { AgentRow } from './types.js';
import {
  findAgentByCapability, createTaskId, startAgentForTask,
  getAgentList, getWorkerList, resolveShortFormAgent,
} from './manager.js';
import { getContext } from './context.js';
import type { TaskRow } from './types.js';
import { insertTask } from './db.js';
import { getBuildInfo, uptimeSeconds } from './build-info.js';
import { metricsEnabled, renderMetrics, setWorkersOnline } from './metrics.js';
import { recordMcpCall } from './audit.js';

// ---------------------------------------------------------------------------
// Tool metadata (AR-1). Annotations let MCP clients tell a read-only status
// query apart from "run a process on another machine", which is what they use
// to decide when to ask the user for confirmation.
// ---------------------------------------------------------------------------

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// Agent tools spawn an arbitrary declared process on a worker machine. We
// cannot know what it does, so we declare the conservative worst case.
const RUNS_AGENT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const timeoutParam = z.number().int().min(0).max(120000).optional()
  .describe('Block up to this many ms (max 120000) waiting for the result. Omit for async; poll with anyagent_task_status.');

// Shape shared by every tool that creates or reports on a task.
const taskOutputShape = {
  taskId: z.string(),
  status: z.string().describe('submitted | pending_approval | queued | routed | running | complete | failed | timeout'),
  agent: z.string().optional(),
  node: z.string().optional().describe('Alias of the machine the task runs on'),
  intent: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  queuePosition: z.number().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
};
type TaskOutput = {
  taskId: string;
  status: string;
  agent?: string;
  node?: string;
  intent?: string;
  result?: string;
  error?: string;
  queuePosition?: number;
  createdAt?: string;
  updatedAt?: string;
};

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function nodeAliasFor(nodeId: string | null | undefined): string | undefined {
  if (!nodeId) return undefined;
  const node = getNodeById(nodeId);
  return node ? nodeDisplayAlias(node) : undefined;
}

// Drop undefined keys so structuredContent round-trips through JSON unchanged.
function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

export function taskToOutput(task: TaskRow): TaskOutput {
  return compact({
    taskId: task.task_id,
    status: task.status,
    agent: task.agent_name ?? undefined,
    node: nodeAliasFor(task.node_id),
    intent: task.intent,
    result: task.result_summary ?? undefined,
    error: task.error ?? undefined,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  });
}

function textResult(text: string, structured?: Record<string, unknown>, isError?: boolean): ToolResult {
  const r: ToolResult = { content: [{ type: 'text', text }] };
  if (structured) r.structuredContent = structured;
  if (isError) r.isError = true;
  return r;
}

type McpTaskCallback = (task: TaskRow) => void;
let onMcpTaskCallback: McpTaskCallback | null = null;

export function onMcpTask(callback: McpTaskCallback): void {
  onMcpTaskCallback = callback;
}

async function waitForTask(taskId: string, timeoutMs: number): Promise<TaskRow | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = getTask(taskId);
    if (task && (task.status === 'complete' || task.status === 'failed' || task.status === 'timeout')) {
      return task;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}

// Results refused by token scope. Tracked out-of-band so the audit wrapper can
// record outcome "denied" without adding fields to what the client receives.
const deniedResults = new WeakMap<ToolResult, string>();

function deniedResult(text: string, reason: string): ToolResult {
  const r = textResult(text, undefined, true);
  deniedResults.set(r, reason);
  return r;
}

function aliasOf(agent: AgentRow): string {
  return nodeAliasFor(agent.node_id) ?? agent.node_id.replace(/^node_/, '').slice(0, 8);
}

async function handleToolCall(scope: TokenScope, agentName: string, intent: string, timeoutMs: number | undefined, routingMethod: 'matched' | 'explicit', options?: { explicitAlias?: string }): Promise<ToolResult> {
  const { getAgentByNameAndAlias } = await import('./db.js');
  // If the caller targeted a specific node via `anyagent_<name>_<alias>`, resolve
  // it that way — never collapse the collision to some other node.
  const agent = options?.explicitAlias
    ? getAgentByNameAndAlias(agentName, options.explicitAlias)
    : resolveShortFormAgent(agentName);
  if (!agent) {
    const hint = options?.explicitAlias
      ? `Agent "${agentName}@${options.explicitAlias}" not found (alias may be stale — try anyagent_list_agents).`
      : `Agent "${agentName}" not found.`;
    return textResult(hint, undefined, true);
  }
  // Defence in depth: tools outside the token's scope are not even listed,
  // but re-check against the machine the call actually resolved to.
  if (!scopeAllows(scope, agent.name, aliasOf(agent))) {
    return deniedResult(`Token "${scope.token}" may not call ${agent.name}@${aliasOf(agent)}.`, `out of scope: ${agent.name}@${aliasOf(agent)}`);
  }

  const taskId = createTaskId();
  insertTask(taskId, 'mcp', intent, 0); // chatId=0 for MCP tasks

  // Use manager.startAgentForTask — includes approval gate + context injection
  const result = startAgentForTask(agent, taskId, intent, 0, routingMethod);

  // Notify via callback
  if (result.outcome !== 'offline' && result.outcome !== 'queue_full') {
    const task = getTask(taskId);
    if (task && onMcpTaskCallback) onMcpTaskCallback(task);
  }

  const current = (): TaskOutput => {
    const t = getTask(taskId);
    return t
      ? taskToOutput(t)
      : { taskId, status: 'failed', agent: result.agentName, node: result.nodeAlias };
  };

  if (result.outcome === 'failed' || result.outcome === 'offline' || result.outcome === 'queue_full') {
    return textResult(`Failed: ${result.error ?? result.outcome}`, current(), true);
  }

  // Blocking mode
  if (timeoutMs && timeoutMs > 0) {
    const completed = await waitForTask(taskId, timeoutMs);
    const ranOn = result.nodeAlias ? ` (${result.agentName}@${result.nodeAlias})` : '';
    if (completed) {
      const out = taskToOutput(completed);
      if (completed.status === 'complete') {
        return textResult(completed.result_summary ?? `Task completed${ranOn}.`, out);
      }
      return textResult(`Task failed${ranOn}: ${completed.error ?? 'unknown'}`, out, true);
    }
    return textResult(`Task ${taskId}${ranOn} still running after ${timeoutMs}ms. Use anyagent_task_status to check.`, current());
  }

  // Async mode — echo the resolved node so the operator sees WHICH machine
  // their short-form call landed on without a follow-up anyagent_task_status.
  const target = result.nodeAlias ? `${result.agentName}@${result.nodeAlias}` : result.agentName;
  const statusMsg = result.outcome === 'queued'
    ? `Agent ${target} busy. Task ${taskId} queued.`
    : result.outcome === 'pending_approval'
    ? `Task ${taskId} pending approval for ${target}.`
    : `Task ${taskId} started on ${target}.`;
  const out = current();
  if (result.queuePosition !== undefined) out.queuePosition = result.queuePosition;
  return textResult(`${statusMsg} Use anyagent_task_status to check.`, out);
}

// --- Tool registration functions ---

// MCP tool names must be `[a-zA-Z0-9_-]`. Worker-declared names are validated
// on declare, but we still defensively strip anything unusual here.
function mcpSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function shortToolName(agentName: string): string {
  return `anyagent_${mcpSafe(agentName)}`;
}

export function explicitToolName(agentName: string, nodeAlias: string): string {
  return `anyagent_${mcpSafe(agentName)}_${mcpSafe(nodeAlias)}`;
}

/**
 * Registers tools while refusing duplicates, and wraps every handler with
 * the audit trail (AR-4).
 *
 * Duplicates: two different agents can map to the same MCP name (agent
 * `claude` on node `spot` and an agent literally called `claude_spot`), and
 * the SDK throws on a duplicate — which would fail every MCP request, not
 * just the clashing tool. First registration wins.
 */
class ToolRegistry {
  private readonly names = new Set<string>();
  constructor(readonly server: McpServer, readonly ctx: TokenScope) {}

  claim(name: string): boolean {
    if (this.names.has(name)) {
      console.warn(`[mcp] Tool name "${name}" is already registered — skipping duplicate`);
      return false;
    }
    this.names.add(name);
    return true;
  }

  /** Wrap a tool handler so every call is timed and recorded. */
  handler<A>(tool: string, fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
    return async (args: A) => {
      const started = Date.now();
      let result: ToolResult | undefined;
      try {
        result = await fn(args);
        return result;
      } finally {
        recordMcpCall({
          tool, token: this.ctx.token, args, result, threw: result === undefined,
          denied: result ? deniedResults.get(result) : undefined,
          durationMs: Date.now() - started,
        });
      }
    };
  }
}

function registerStaticTools(reg: ToolRegistry): void {
  const server = reg.server;
  const scope = reg.ctx;
  reg.claim('anyagent_list_agents');
  server.registerTool(
    'anyagent_list_agents',
    {
      title: 'List agents',
      description: 'List all registered agents grouped by machine, with online/offline status and the MCP tool name for each.',
      annotations: READ_ONLY,
      outputSchema: {
        agents: z.array(z.object({
          name: z.string(),
          node: z.string().describe('Machine alias'),
          nodeName: z.string(),
          online: z.boolean(),
          description: z.string(),
          capabilities: z.array(z.string()),
          tool: z.string().describe('Short-form tool; the hub picks the machine'),
          explicitTool: z.string().describe('Tool that always targets this machine'),
        })),
      },
    },
    reg.handler('anyagent_list_agents', async () => {
      const agents = getAgentList().filter(a => scopeAllows(scope, a.name, a.nodeAlias));
      const structured = {
        agents: agents.map(a => ({
          name: a.name,
          node: a.nodeAlias,
          nodeName: a.nodeName,
          online: a.online,
          description: a.description,
          capabilities: a.capabilities,
          // A token scoped to name@alias has no short-form tool for this agent.
          tool: scopeAllowsAnyNode(scope, a.name) ? shortToolName(a.name) : explicitToolName(a.name, a.nodeAlias),
          explicitTool: explicitToolName(a.name, a.nodeAlias),
        })),
      };
      if (agents.length === 0) {
        return textResult('No agents registered.', structured);
      }

      // Group by nodeAlias so the user can see which agents live on which machine.
      const byNode = new Map<string, { nodeName: string; online: boolean; items: typeof agents }>();
      for (const a of agents) {
        const key = a.nodeAlias;
        if (!byNode.has(key)) {
          byNode.set(key, { nodeName: a.nodeName, online: a.online, items: [] });
        }
        const group = byNode.get(key)!;
        group.items.push(a);
        // A node is "online" in the header if ANY of its agents are online,
        // which today is equivalent to the worker being connected.
        if (a.online) group.online = true;
      }

      const lines: string[] = [];
      // Sort nodes alphabetically by alias for stable output
      const sortedAliases = [...byNode.keys()].sort();
      for (const alias of sortedAliases) {
        const group = byNode.get(alias)!;
        const header = `${group.online ? '🟢' : '🔴'} ${alias}${group.nodeName && group.nodeName !== alias ? ` (${group.nodeName})` : ''}`;
        lines.push(header);
        for (const a of group.items) {
          const caps = a.capabilities.length > 0 ? ` [${a.capabilities.join(', ')}]` : '';
          const desc = a.description ? ` — ${a.description}` : '';
          lines.push(`   ${a.online ? '🟢' : '🔴'} ${a.name}${desc}${caps}`);
        }
      }
      lines.push('');
      lines.push('Call short form (hub picks the node):  anyagent_<name>');
      lines.push('Call a specific machine:               anyagent_<name>_<alias>');
      return textResult(lines.join('\n'), structured);
    })
  );

  if (!scope.readonly) {
  reg.claim('anyagent_route');
  server.registerTool(
    'anyagent_route',
    {
      title: 'Route task to best agent',
      description: 'Route a task to the best available agent by capability. Runs a process on a worker machine. Set timeout_ms to wait for the result.',
      annotations: RUNS_AGENT,
      inputSchema: {
        intent: z.string().describe('Natural language description of what you want done'),
        timeout_ms: timeoutParam,
      },
      outputSchema: taskOutputShape,
    },
    reg.handler('anyagent_route', async ({ intent, timeout_ms }: { intent: string; timeout_ms?: number }) => {
      // Only agents this token may call are candidates.
      const routing = findAgentByCapability(intent, a => scopeAllows(scope, a.name, aliasOf(a)));
      if (routing.type === 'none') {
        return textResult('No online agents available.', undefined, true);
      }
      // For MCP, if ambiguous pick first match (no interactive selection)
      const agent = routing.agent ?? routing.agents?.[0];
      if (!agent) {
        return textResult('No matching agent found.', undefined, true);
      }
      // Pin to the machine routing chose, so short-form resolution cannot
      // move the task to a same-named agent elsewhere.
      return handleToolCall(scope, agent.name, intent, timeout_ms, 'matched', { explicitAlias: aliasOf(agent) });
    })
  );
  }

  reg.claim('anyagent_task_status');
  server.registerTool(
    'anyagent_task_status',
    {
      title: 'Task status',
      description: 'Check the status and result of a task by ID.',
      annotations: READ_ONLY,
      inputSchema: { task_id: z.string().describe('The task ID returned by anyagent_route or anyagent_<agent>') },
      outputSchema: taskOutputShape,
    },
    reg.handler('anyagent_task_status', async ({ task_id }: { task_id: string }) => {
      const task = getTask(task_id);
      if (!task) {
        return textResult(`Task ${task_id} not found.`, undefined, true);
      }
      // A scoped token must not read results of agents it cannot call. Answer
      // "not found" rather than confirming the task exists.
      if (scope.agents !== '*') {
        const alias = nodeAliasFor(task.node_id) ?? '';
        if (!task.agent_name || !scopeAllows(scope, task.agent_name, alias)) {
          return deniedResult(`Task ${task_id} not found.`, `out of scope: ${task.agent_name ?? 'unrouted'}@${alias}`);
        }
      }
      // Surface WHICH machine the task ran on so the operator knows which
      // worker to look at for logs, CLI state, etc. when they didn't pick.
      const out = taskToOutput(task);
      const onNode = out.node ? `@${out.node}` : '';
      let text = `Task: ${task.task_id}\nStatus: ${task.status}\nAgent: ${task.agent_name ? task.agent_name + onNode : 'none'}\nIntent: ${task.intent}`;
      if (task.result_summary) text += `\nResult: ${task.result_summary}`;
      if (task.error) text += `\nError: ${task.error}`;
      return textResult(text, out);
    })
  );

  reg.claim('anyagent_context');
  server.registerTool(
    'anyagent_context',
    {
      title: 'Operator context',
      description: 'Read the operator\'s persistent context (environment info, preferences, notes).',
      annotations: READ_ONLY,
      outputSchema: { context: z.string() },
    },
    reg.handler('anyagent_context', async () => {
      const ctx = getContext();
      return textResult(ctx || 'No operator context set.', { context: ctx ?? '' });
    })
  );
}

function registerDynamicAgentTools(reg: ToolRegistry): void {
  const server = reg.server;
  const scope = reg.ctx;
  if (scope.readonly) return; // read-only tokens cannot run agents
  const agents = getAgentList().filter(a => scopeAllows(scope, a.name, a.nodeAlias));

  // ---- Short-form tools (one per distinct agent NAME, regardless of node) ----
  // Register `anyagent_<name>` once per distinct name. The handler uses the
  // deterministic picker in manager.resolveShortFormAgent so the user can't see
  // the shape change under them as workers come online/offline — the same input
  // on the same fleet state always picks the same node.
  const byName = new Map<string, typeof agents>();
  for (const a of agents) {
    if (!byName.has(a.name)) byName.set(a.name, []);
    byName.get(a.name)!.push(a);
  }

  for (const [name, variants] of byName.entries()) {
    // The short form lets the hub pick the machine, so it needs the bare name
    // in scope — a token limited to claude@laptop only gets the explicit tool.
    if (!scopeAllowsAnyNode(scope, name)) continue;
    const toolName = shortToolName(name);
    if (!reg.claim(toolName)) continue;
    const caps = variants[0].capabilities.length > 0 ? ` [${variants[0].capabilities.join(', ')}]` : '';
    const nodeCount = variants.length;
    const nodeHint = nodeCount > 1
      ? ` (available on ${nodeCount} machines: ${variants.map(v => v.nodeAlias).sort().join(', ')} — hub picks the oldest online pairing by default; use ${toolName}_<alias> to target a specific one)`
      : '';
    server.registerTool(
      toolName,
      {
        title: name,
        description: `${variants[0].description || name}${caps}${nodeHint}`,
        annotations: RUNS_AGENT,
        inputSchema: {
          intent: z.string().describe('What you want this agent to do'),
          timeout_ms: timeoutParam,
        },
        outputSchema: taskOutputShape,
      },
      reg.handler(toolName, async ({ intent, timeout_ms }: { intent: string; timeout_ms?: number }) => {
        return handleToolCall(scope, name, intent, timeout_ms, 'explicit');
      })
    );
  }

  // ---- Explicit per-machine tools ----
  // For every registered agent, expose `anyagent_<name>_<alias>` so callers
  // that know which machine they want can address it unambiguously. This is
  // the recommended form when more than one node has an agent with the same
  // name — the short form falls back to the picker, which can surprise you.
  for (const a of agents) {
    const toolName = explicitToolName(a.name, a.nodeAlias);
    if (!reg.claim(toolName)) continue;
    const caps = a.capabilities.length > 0 ? ` [${a.capabilities.join(', ')}]` : '';
    const nodeName = a.nodeName && a.nodeName !== a.nodeAlias ? ` (${a.nodeName})` : '';
    server.registerTool(
      toolName,
      {
        title: `${a.name} on ${a.nodeAlias}`,
        description: `${a.description || a.name} on ${a.nodeAlias}${nodeName}${caps}`,
        annotations: RUNS_AGENT,
        inputSchema: {
          intent: z.string().describe('What you want this agent to do'),
          timeout_ms: timeoutParam,
        },
        outputSchema: taskOutputShape,
      },
      reg.handler(toolName, async ({ intent, timeout_ms }: { intent: string; timeout_ms?: number }) => {
        return handleToolCall(scope, a.name, intent, timeout_ms, 'explicit', { explicitAlias: a.nodeAlias });
      })
    );
  }
}

/** Build a fully-registered MCP server instance (one per HTTP request). */
export function buildMcpServer(ctx: TokenScope = ADMIN_SCOPE): McpServer {
  const server = new McpServer(
    { name: 'anyagent-hub', title: 'AnyAgent', version: getBuildInfo().version },
    { capabilities: { tools: {} } }
  );
  const reg = new ToolRegistry(server, ctx);
  registerStaticTools(reg);
  registerDynamicAgentTools(reg);
  return server;
}

// --- HTTP Server ---

let running = false;

/** Whether the MCP HTTP server was started in this process. */
export function mcpServerRunning(): boolean {
  return running;
}

/**
 * Start the MCP HTTP server. `adminToken` (MCP_TOKEN) grants full access;
 * scoped tokens from the `token` CLI command are also accepted. With no admin
 * token, only scoped tokens can authenticate.
 */
export function createMcpServer(mcpPort: number, adminToken?: string): Server {
  const MAX_BODY_SIZE = 1_048_576;
  running = true;

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // ---- Unauthenticated liveness / readiness / metrics endpoints ----
    // Deliberately before the Bearer gate so orchestrators can probe without
    // needing the MCP token.
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    if (method === 'GET' && (url === '/health' || url.startsWith('/health?'))) {
      const workers = getWorkerList();
      const onlineCount = workers.filter(w => w.online).length;
      setWorkersOnline(onlineCount);
      const info = getBuildInfo();
      const body = {
        ok: true,
        version: info.version,
        node: info.node,
        uptime_s: uptimeSeconds(),
        workers: { total: workers.length, online: onlineCount },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    if (method === 'GET' && (url === '/ready' || url.startsWith('/ready?'))) {
      // Ready = at least one worker online, OR READY_ALLOW_EMPTY=1 for bootstrap.
      const workers = getWorkerList();
      const onlineCount = workers.filter(w => w.online).length;
      const allowEmpty = process.env.READY_ALLOW_EMPTY === '1';
      const ready = onlineCount > 0 || allowEmpty;
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready, workers_online: onlineCount }));
      return;
    }

    if (method === 'GET' && url === '/metrics') {
      if (!metricsEnabled()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('metrics disabled (set ENABLE_METRICS=1)\n');
        return;
      }
      const workers = getWorkerList();
      setWorkersOnline(workers.filter(w => w.online).length);
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(renderMetrics());
      return;
    }

    // ---- MCP JSON-RPC endpoint — Bearer required (admin or scoped token) ----
    const scope = resolveBearer(req.headers.authorization, adminToken);
    if (!scope) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body: string | undefined;
    if (req.method === 'POST') {
      body = await new Promise<string>((resolve, reject) => {
        let data = '';
        let size = 0;
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_SIZE) { req.destroy(); reject(new Error('Body too large')); return; }
          data += chunk;
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
      }).catch(() => undefined);
      if (body === undefined) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return;
      }
    }

    let parsed: unknown;
    if (body) {
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
    }

    const server = buildMcpServer(scope);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  });

  httpServer.listen(mcpPort, () => {
    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : mcpPort;
    console.log(`[mcp] MCP server listening on port ${port}`);
  });
  return httpServer;
}
