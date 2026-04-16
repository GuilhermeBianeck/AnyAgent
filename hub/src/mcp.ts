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
    'List all registered agents with their capabilities and online/offline status',
    {},
    async () => {
      const agents = getAgentList();
      const list = agents.map(a => {
        const caps = a.capabilities.length > 0 ? a.capabilities.join(', ') : 'no capabilities';
        return `${a.online ? '🟢' : '🔴'} ${a.name} — ${a.description || 'no description'} [${caps}]`;
      });
      return { content: [{ type: 'text' as const, text: list.length > 0 ? list.join('\n') : 'No agents registered.' }] };
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
