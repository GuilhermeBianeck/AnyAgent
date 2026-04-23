import { createServer, IncomingMessage, ServerResponse } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { timingSafeEqual } from 'crypto';
import { getTask } from './db.js';
import {
  findAgentByCapability, createTaskId, startAgentForTask,
  getAgentList, getWorkerList,
} from './manager.js';
import { getContext } from './context.js';
import type { TaskRow } from './types.js';
import { insertTask, updateTaskStatus } from './db.js';
import { getBuildInfo, uptimeSeconds } from './build-info.js';
import { metricsEnabled, renderMetrics, setWorkersOnline } from './metrics.js';

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

async function handleToolCall(agentName: string, intent: string, timeoutMs: number | undefined, routingMethod: 'matched' | 'explicit'): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const { getAgentByName } = await import('./db.js');
  const agent = getAgentByName(agentName);
  if (!agent) {
    return { content: [{ type: 'text', text: `Agent ${agentName} not found.` }], isError: true };
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

  if (result.outcome === 'failed' || result.outcome === 'offline' || result.outcome === 'queue_full') {
    return { content: [{ type: 'text', text: `Failed: ${result.error ?? result.outcome}` }], isError: true };
  }

  // Blocking mode
  if (timeoutMs && timeoutMs > 0) {
    const completed = await waitForTask(taskId, timeoutMs);
    if (completed) {
      if (completed.status === 'complete') {
        return { content: [{ type: 'text', text: completed.result_summary ?? 'Task completed.' }] };
      }
      return { content: [{ type: 'text', text: `Task failed: ${completed.error ?? 'unknown'}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Task ${taskId} still running after ${timeoutMs}ms. Use anyagent_task_status to check.` }] };
  }

  // Async mode
  const statusMsg = result.outcome === 'queued'
    ? `Agent busy. Task ${taskId} queued.`
    : result.outcome === 'pending_approval'
    ? `Task ${taskId} pending approval. Use anyagent_task_status to check.`
    : `Task ${taskId} started on ${result.agentName}.`;
  return { content: [{ type: 'text', text: `${statusMsg} Use anyagent_task_status to check.` }] };
}

// --- Tool registration functions ---

function registerStaticTools(server: McpServer): void {
  server.tool(
    'anyagent_list_agents',
    'List all registered agents grouped by machine, with online/offline status.',
    {},
    async () => {
      const agents = getAgentList();
      if (agents.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No agents registered.' }] };
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
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );

  server.tool(
    'anyagent_route',
    'Route a task to the best available agent. Set timeout_ms to wait for the result.',
    {
      intent: z.string().describe('Natural language description of what you want done'),
      timeout_ms: z.number().max(120000).optional().describe('Block up to this many ms (max 120000) waiting for result. Omit for async.'),
    },
    async ({ intent, timeout_ms }) => {
      const routing = findAgentByCapability(intent);
      if (routing.type === 'none') {
        return { content: [{ type: 'text' as const, text: 'No online agents available.' }], isError: true };
      }
      // For MCP, if ambiguous pick first match (no interactive selection)
      const agent = routing.agent ?? routing.agents?.[0];
      if (!agent) {
        return { content: [{ type: 'text' as const, text: 'No matching agent found.' }], isError: true };
      }
      return handleToolCall(agent.name, intent, timeout_ms, 'matched');
    }
  );

  server.tool(
    'anyagent_task_status',
    'Check the status and result of a task by ID',
    { task_id: z.string().describe('The task ID returned by anyagent_route or anyagent_<agent>') },
    async ({ task_id }) => {
      const task = getTask(task_id);
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Task ${task_id} not found.` }], isError: true };
      }
      let text = `Task: ${task.task_id}\nStatus: ${task.status}\nAgent: ${task.agent_name ?? 'none'}\nIntent: ${task.intent}`;
      if (task.result_summary) text += `\nResult: ${task.result_summary}`;
      if (task.error) text += `\nError: ${task.error}`;
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.tool(
    'anyagent_context',
    'Read the operator\'s persistent context (environment info, preferences, notes)',
    {},
    async () => {
      const ctx = getContext();
      return { content: [{ type: 'text' as const, text: ctx || 'No operator context set.' }] };
    }
  );
}

function registerDynamicAgentTools(server: McpServer): void {
  const agents = getAgentList();
  for (const agent of agents) {
    const caps = agent.capabilities.length > 0 ? ` [${agent.capabilities.join(', ')}]` : '';
    server.tool(
      `anyagent_${agent.name}`,
      `${agent.description || agent.name}${caps}`,
      {
        intent: z.string().describe('What you want this agent to do'),
        timeout_ms: z.number().max(120000).optional().describe('Block up to this many ms waiting for result. Omit for async.'),
      },
      async ({ intent, timeout_ms }) => {
        return handleToolCall(agent.name, intent, timeout_ms, 'explicit');
      }
    );
  }
}

// --- HTTP Server ---

export function createMcpServer(mcpPort: number, mcpToken: string): void {
  const MAX_BODY_SIZE = 1_048_576;
  const expectedToken = Buffer.from(`Bearer ${mcpToken}`);

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

    // ---- MCP JSON-RPC endpoint — Bearer required ----
    const authHeader = req.headers.authorization ?? '';
    const authBuf = Buffer.from(authHeader);
    const valid = authBuf.length === expectedToken.length && timingSafeEqual(authBuf, expectedToken);
    if (!valid) {
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

    const server = new McpServer(
      { name: 'anyagent-hub', version: '2.0.0' },
      { capabilities: { tools: {} } }
    );
    registerStaticTools(server);
    registerDynamicAgentTools(server);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  });

  httpServer.listen(mcpPort, () => {
    console.log(`[mcp] MCP server listening on port ${mcpPort}`);
  });
}
