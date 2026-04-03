import { createServer, IncomingMessage, ServerResponse } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomBytes, timingSafeEqual } from 'crypto';
import { getAllAgents, insertTask, updateTaskStatus, getTask, getQueuedTasksByNodeId } from './db.js';
import { isNodeOnline, sendSpawn, getActiveSession, setActiveSession } from './gateway.js';
import { getContext } from './context.js';
import type { AgentRow, TaskRow } from './types.js';

type McpTaskCallback = (task: TaskRow) => void;
let onMcpTaskCallback: McpTaskCallback | null = null;

export function onMcpTask(callback: McpTaskCallback): void {
  onMcpTaskCallback = callback;
}

function findAgentByCapability(intent: string): AgentRow | undefined {
  const agents = getAllAgents();
  const onlineAgents = agents.filter(a => isNodeOnline(a.node_id));
  if (onlineAgents.length === 0) return undefined;
  if (onlineAgents.length === 1) return onlineAgents[0];

  const intentWords = intent.toLowerCase().split(/\s+/);
  let bestMatch: AgentRow | undefined;
  let bestScore = 0;

  for (const agent of onlineAgents) {
    const capabilities: string[] = JSON.parse(agent.capabilities || '[]');
    let score = 0;
    for (const cap of capabilities) {
      const capLower = cap.toLowerCase();
      for (const word of intentWords) {
        if (word.length >= 3 && (word.includes(capLower) || capLower.includes(word))) {
          score++;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = agent;
    }
  }

  return bestMatch ?? onlineAgents[0];
}

const MAX_QUEUE_DEPTH = parseInt(process.env.MAX_QUEUE_DEPTH ?? '3', 10);

function spawnAgentTaskSync(agent: AgentRow, intent: string, routingMethod: 'matched' | 'explicit' = 'matched'): { taskId: string; status: 'running' | 'queued' | 'failed' } {
  const taskId = `task_${randomBytes(6).toString('hex')}`;
  insertTask(taskId, 'mcp', intent);

  const existingSession = getActiveSession(agent.node_id);
  if (existingSession) {
    const queued = getQueuedTasksByNodeId(agent.node_id);
    if (queued.length >= MAX_QUEUE_DEPTH) {
      updateTaskStatus(taskId, 'failed', { error: `Queue full (${MAX_QUEUE_DEPTH})`, agent_name: agent.name, node_id: agent.node_id, routing_method: routingMethod });
      return { taskId, status: 'failed' };
    }
    updateTaskStatus(taskId, 'queued', { agent_name: agent.name, node_id: agent.node_id, routing_method: routingMethod });
    const task = getTask(taskId);
    if (task && onMcpTaskCallback) onMcpTaskCallback(task);
    return { taskId, status: 'queued' };
  }

  const agentArgs: string[] = JSON.parse(agent.args_json);
  const ok = sendSpawn(agent.node_id, agent.binary, agentArgs, taskId, intent);
  if (!ok) {
    updateTaskStatus(taskId, 'failed', { error: 'Failed to spawn', agent_name: agent.name, node_id: agent.node_id, routing_method: routingMethod });
    return { taskId, status: 'failed' };
  }

  setActiveSession(agent.node_id, 0, agent.name);
  updateTaskStatus(taskId, 'running', { agent_name: agent.name, node_id: agent.node_id, routing_method: routingMethod });
  const task = getTask(taskId);
  if (task && onMcpTaskCallback) onMcpTaskCallback(task);
  return { taskId, status: 'running' };
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

async function handleToolCall(agent: AgentRow, intent: string, timeoutMs: number | undefined, routingMethod: 'matched' | 'explicit'): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (!isNodeOnline(agent.node_id)) {
    return { content: [{ type: 'text', text: `Agent ${agent.name} is offline.` }], isError: true };
  }

  const { taskId, status } = spawnAgentTaskSync(agent, intent, routingMethod);

  if (status === 'failed') {
    return { content: [{ type: 'text', text: `Failed to spawn ${agent.name}.` }], isError: true };
  }

  if (timeoutMs && timeoutMs > 0 && (status === 'running' || status === 'queued')) {
    const result = await waitForTask(taskId, timeoutMs);
    if (result) {
      if (result.status === 'complete') {
        return { content: [{ type: 'text', text: result.result_summary ?? 'Task completed (no output).' }] };
      }
      if (result.status === 'failed') {
        return { content: [{ type: 'text', text: `Task failed: ${result.error ?? 'unknown error'}` }], isError: true };
      }
    }
    return { content: [{ type: 'text', text: `Task ${taskId} still running after ${timeoutMs}ms. Use anyagent_task_status to check.` }] };
  }

  if (status === 'queued') {
    return { content: [{ type: 'text', text: `Agent ${agent.name} is busy. Task ${taskId} queued. Use anyagent_task_status to check.` }] };
  }
  return { content: [{ type: 'text', text: `Task ${taskId} started on ${agent.name}. Use anyagent_task_status to check.` }] };
}

// --- Tool registration functions (called per-request on fresh McpServer instances) ---

function registerStaticTools(server: McpServer): void {
  server.tool(
    'anyagent_list_agents',
    'List all registered agents with their capabilities and online/offline status',
    {},
    async () => {
      const agents = getAllAgents();
      const list = agents.map(a => {
        const caps: string[] = JSON.parse(a.capabilities || '[]');
        const online = isNodeOnline(a.node_id);
        return `${online ? '🟢' : '🔴'} ${a.name} — ${a.description || 'no description'} [${caps.join(', ') || 'no capabilities'}]`;
      });
      return {
        content: [{ type: 'text' as const, text: list.length > 0 ? list.join('\n') : 'No agents registered.' }],
      };
    }
  );

  server.tool(
    'anyagent_route',
    'Route a task to the best available agent based on intent. Set timeout_ms to wait for the result.',
    {
      intent: z.string().describe('Natural language description of what you want done'),
      timeout_ms: z.number().max(120000).optional().describe('Block up to this many ms (max 120000) waiting for result. Omit for async.'),
    },
    async ({ intent, timeout_ms }) => {
      const agent = findAgentByCapability(intent);
      if (!agent) {
        return { content: [{ type: 'text' as const, text: 'No online agents available.' }], isError: true };
      }
      return handleToolCall(agent, intent, timeout_ms, 'matched');
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
      return {
        content: [{ type: 'text' as const, text: ctx || 'No operator context set.' }],
      };
    }
  );
}

function registerDynamicAgentTools(server: McpServer): void {
  const agents = getAllAgents();
  for (const agent of agents) {
    const caps: string[] = JSON.parse(agent.capabilities || '[]');
    const description = `${agent.description || agent.name}${caps.length > 0 ? ` [${caps.join(', ')}]` : ''}`;
    server.tool(
      `anyagent_${agent.name}`,
      description,
      {
        intent: z.string().describe('What you want this agent to do'),
        timeout_ms: z.number().max(120000).optional().describe('Block up to this many ms (max 120000) waiting for result. Omit for async.'),
      },
      async ({ intent, timeout_ms }) => {
        return handleToolCall(agent, intent, timeout_ms, 'explicit');
      }
    );
  }
}

// --- HTTP Server ---

export function createMcpServer(mcpPort: number, mcpToken: string): void {
  const MAX_BODY_SIZE = 1_048_576; // 1MB
  const expectedToken = Buffer.from(`Bearer ${mcpToken}`);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Timing-safe bearer token comparison
    const authHeader = req.headers.authorization ?? '';
    const authBuf = Buffer.from(authHeader);
    const valid = authBuf.length === expectedToken.length && timingSafeEqual(authBuf, expectedToken);
    if (!valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Read body with size limit
    let body: string | undefined;
    if (req.method === 'POST') {
      body = await new Promise<string>((resolve, reject) => {
        let data = '';
        let size = 0;
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_SIZE) {
            req.destroy();
            reject(new Error('Body too large'));
            return;
          }
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

    // Safe JSON parse
    let parsed: unknown;
    if (body) {
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
    }

    // Fresh server+transport per request — avoids SDK's "Already connected" error.
    // Tool handlers close over module-level functions so state is shared correctly.
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
