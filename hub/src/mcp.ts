import { createServer, IncomingMessage, ServerResponse } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { getAllAgents, insertTask, updateTaskStatus, getTask } from './db.js';
import { isNodeOnline, sendSpawn } from './gateway.js';
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

  // Keyword matching: check if intent words overlap with capabilities
  const intentWords = intent.toLowerCase().split(/\s+/);
  let bestMatch: AgentRow | undefined;
  let bestScore = 0;

  for (const agent of onlineAgents) {
    const capabilities: string[] = JSON.parse(agent.capabilities || '[]');
    let score = 0;
    for (const cap of capabilities) {
      const capLower = cap.toLowerCase();
      for (const word of intentWords) {
        if (word.includes(capLower) || capLower.includes(word)) {
          score++;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = agent;
    }
  }

  // If no capability match, return first online agent
  return bestMatch ?? onlineAgents[0];
}

export function createMcpServer(mcpPort: number, mcpToken: string): void {
  const server = new McpServer(
    { name: 'anyagent-hub', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );

  // Tool: list all agents with capabilities and online status
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

  // Tool: route a task to the best available agent
  server.tool(
    'anyagent_route',
    'Route a task to the best available agent based on intent. Returns task ID for tracking.',
    { intent: z.string().describe('Natural language description of what you want done') },
    async ({ intent }) => {
      const agent = findAgentByCapability(intent);
      if (!agent) {
        return {
          content: [{ type: 'text' as const, text: 'No online agents available to handle this task.' }],
          isError: true,
        };
      }

      const taskId = `task_${randomBytes(6).toString('hex')}`;
      insertTask(taskId, 'mcp', intent);

      const agentArgs: string[] = JSON.parse(agent.args_json);
      const ok = sendSpawn(agent.node_id, agent.binary, agentArgs, taskId, intent);
      if (!ok) {
        updateTaskStatus(taskId, 'failed', { error: 'Failed to spawn agent', agent_name: agent.name, node_id: agent.node_id });
        return {
          content: [{ type: 'text' as const, text: `Failed to spawn agent ${agent.name} — worker may be offline.` }],
          isError: true,
        };
      }

      updateTaskStatus(taskId, 'running', {
        agent_name: agent.name,
        node_id: agent.node_id,
        routing_method: 'matched',
      });

      // Notify via callback (bot.ts will send Telegram notification)
      const task = getTask(taskId);
      if (task && onMcpTaskCallback) {
        onMcpTaskCallback(task);
      }

      return {
        content: [{ type: 'text' as const, text: `Task ${taskId} started on agent ${agent.name} (${agent.node_id}). Use anyagent_task_status to check progress.` }],
      };
    }
  );

  // Per-agent tools: each agent gets its own tool
  // These are registered dynamically but we need to register them at server start
  // and the agent list can change. For now, register a generic per-name caller.
  const agents = getAllAgents();
  for (const agent of agents) {
    const caps: string[] = JSON.parse(agent.capabilities || '[]');
    server.tool(
      `anyagent_${agent.name}`,
      `${agent.description || agent.name}${caps.length > 0 ? ` [capabilities: ${caps.join(', ')}]` : ''}`,
      { intent: z.string().describe('What you want this agent to do') },
      async ({ intent }) => {
        if (!isNodeOnline(agent.node_id)) {
          return {
            content: [{ type: 'text' as const, text: `Agent ${agent.name} is offline.` }],
            isError: true,
          };
        }

        const taskId = `task_${randomBytes(6).toString('hex')}`;
        insertTask(taskId, 'mcp', intent);

        const agentArgs: string[] = JSON.parse(agent.args_json);
        const ok = sendSpawn(agent.node_id, agent.binary, agentArgs, taskId, intent);
        if (!ok) {
          updateTaskStatus(taskId, 'failed', { error: 'Failed to spawn', agent_name: agent.name, node_id: agent.node_id });
          return {
            content: [{ type: 'text' as const, text: `Failed to spawn ${agent.name}.` }],
            isError: true,
          };
        }

        updateTaskStatus(taskId, 'running', {
          agent_name: agent.name,
          node_id: agent.node_id,
          routing_method: 'explicit',
        });

        const task = getTask(taskId);
        if (task && onMcpTaskCallback) onMcpTaskCallback(task);

        return {
          content: [{ type: 'text' as const, text: `Task ${taskId} started on ${agent.name}. Use anyagent_task_status to check progress.` }],
        };
      }
    );
  }

  // Tool: check task status
  server.tool(
    'anyagent_task_status',
    'Check the status and result of a task by ID',
    { task_id: z.string().describe('The task ID returned by anyagent_route or anyagent_<agent>') },
    async ({ task_id }) => {
      const task = getTask(task_id);
      if (!task) {
        return {
          content: [{ type: 'text' as const, text: `Task ${task_id} not found.` }],
          isError: true,
        };
      }

      let text = `Task: ${task.task_id}\nStatus: ${task.status}\nAgent: ${task.agent_name ?? 'none'}\nIntent: ${task.intent}`;
      if (task.result_summary) text += `\nResult: ${task.result_summary}`;
      if (task.error) text += `\nError: ${task.error}`;

      return {
        content: [{ type: 'text' as const, text }],
      };
    }
  );

  // HTTP server with bearer token auth
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Bearer token auth
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${mcpToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Parse body for POST requests
    let body: string | undefined;
    if (req.method === 'POST') {
      body = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () => resolve(data));
      });
    }

    // Create transport per request (stateless mode)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);

    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });

  httpServer.listen(mcpPort, () => {
    console.log(`[mcp] MCP server listening on port ${mcpPort}`);
  });
}
