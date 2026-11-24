/**
 * A2A v1.0 surface (AR-8) — opt-in with A2A_ENABLED=1.
 *
 * A2A (Agent2Agent, now under the Agentic AI Foundation with MCP) is how
 * orchestrators discover and delegate to other agents. AnyAgent already is a
 * fleet of agents, so it publishes:
 *
 *   GET  /.well-known/agent-card.json   Agent Card, one skill per agent@machine
 *   POST /a2a                           JSON-RPC binding: SendMessage,
 *                                       GetTask, CancelTask
 *
 * Wire format follows A2A v1.0 ProtoJSON as implemented by the official
 * @a2a-js/sdk (1.3.0): TASK_STATE_* / ROLE_* enums, parts as {"text": ...},
 * SendMessage returns {"task": ...}. The same bearer tokens as MCP apply,
 * including scoped tokens (AR-5), and every call lands in the audit log.
 *
 * Choosing an agent: set `metadata.skillId` on the request or message to
 * "name@alias" (one machine), "name" (hub picks the machine) or "route"
 * (default: capability matching across agents the token may call).
 */

import { getTask, insertTask, getAgentByNameAndAlias, getNodeById, nodeDisplayAlias } from './db.js';
import {
  createTaskId, findAgentByCapability, resolveShortFormAgent, startAgentForTask,
  cancelTask, waitForTerminal, getAgentList,
} from './manager.js';
import { scopeAllows, scopeAllowsAnyNode, taskOutOfScope, type TokenScope } from './tokens.js';
import { recordMcpCall } from './audit.js';
import { getBuildInfo } from './build-info.js';
import type { AgentRow, TaskRow } from './types.js';

export const A2A_PROTOCOL_VERSION = '1.0';
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';
export const A2A_RPC_PATH = '/a2a';

export function a2aEnabled(): boolean {
  return process.env.A2A_ENABLED === '1';
}

/** How long a non-returnImmediately SendMessage waits for the agent. */
function waitMs(): number {
  const v = parseInt(process.env.A2A_WAIT_MS ?? '', 10);
  return Number.isFinite(v) && v >= 0 && v <= 120_000 ? v : 60_000;
}

// A2A JSON-RPC error codes (from @a2a-js/sdk).
const ERR = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  UNSUPPORTED_OPERATION: -32004,
} as const;

// ---------------------------------------------------------------------------
// Agent Card
// ---------------------------------------------------------------------------

function aliasFor(nodeId: string | null): string {
  if (!nodeId) return '';
  const node = getNodeById(nodeId);
  return node ? nodeDisplayAlias(node) : nodeId.replace(/^node_/, '').slice(0, 8);
}

export function buildAgentCard(baseUrl: string): Record<string, unknown> {
  const agents = getAgentList(); // approved agents only (quarantined ones are excluded)
  const skills = agents.map(a => ({
    id: `${a.name}@${a.nodeAlias}`,
    name: `${a.name} on ${a.nodeAlias}`,
    description: a.description || a.name,
    tags: a.capabilities,
    examples: [],
  }));
  skills.unshift({
    id: 'route',
    name: 'Route to the best agent',
    description: 'The hub picks an agent by matching the request against agent capabilities.',
    tags: ['routing'],
    examples: [],
  });
  return {
    name: 'AnyAgent',
    description: 'A personal fleet of agents (Claude Code, Codex, Ollama, scripts, ...) across your machines. Pick one with metadata.skillId, or let the hub route.',
    version: getBuildInfo().version,
    supportedInterfaces: [
      { url: `${baseUrl}${A2A_RPC_PATH}`, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION },
    ],
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: 'bearer', description: 'MCP_TOKEN or a scoped token from the hub CLI ("token create")' } },
    },
    securityRequirements: [{ schemes: { bearer: {} } }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills,
  };
}

// ---------------------------------------------------------------------------
// Task mapping
// ---------------------------------------------------------------------------

export function toA2aState(task: Pick<TaskRow, 'status' | 'error'>): string {
  switch (task.status) {
    case 'running': return 'TASK_STATE_WORKING';
    case 'complete': return 'TASK_STATE_COMPLETED';
    case 'cancelled': return 'TASK_STATE_CANCELED';
    case 'failed':
      return task.error === 'Denied by operator' ? 'TASK_STATE_REJECTED' : 'TASK_STATE_FAILED';
    case 'timeout': return 'TASK_STATE_FAILED';
    // Waiting on the hub operator, not on the A2A client, so this is not
    // INPUT_REQUIRED (which would invite the client to send input).
    default: return 'TASK_STATE_SUBMITTED'; // submitted | routed | queued | pending_approval
  }
}

function isoTime(sqlite: string): string {
  // SQLite datetime('now') is UTC "YYYY-MM-DD HH:MM:SS".
  return sqlite.includes('T') ? sqlite : `${sqlite.replace(' ', 'T')}Z`;
}

export function toA2aTask(task: TaskRow): Record<string, unknown> {
  const contextId = task.task_id;
  const status: Record<string, unknown> = { state: toA2aState(task), timestamp: isoTime(task.updated_at) };
  const note = task.error
    ?? (task.status === 'pending_approval' ? 'Waiting for operator approval' : task.status === 'queued' ? 'Queued behind another task on this machine' : undefined);
  if (note) {
    status.message = { messageId: `${task.task_id}-status`, contextId, taskId: task.task_id, role: 'ROLE_AGENT', parts: [{ text: note }] };
  }
  const out: Record<string, unknown> = { id: task.task_id, contextId, status };
  if (task.result_summary) {
    out.artifacts = [{ artifactId: `${task.task_id}-result`, name: 'result', parts: [{ text: task.result_summary }] }];
  }
  out.metadata = { agent: task.agent_name ?? undefined, node: aliasFor(task.node_id) || undefined, anyagentStatus: task.status };
  return out;
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

interface RpcRequest { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
type RpcResponse = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly auditOutcome: 'error' | 'denied' = 'error') { super(message); }
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function textOf(message: Record<string, unknown>): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .map(p => asObject(p).text)
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .join('\n');
}

function pickAgent(scope: TokenScope, skillId: string, intent: string): { agent: AgentRow; method: 'matched' | 'explicit' } {
  if (skillId === 'route') {
    const r = findAgentByCapability(intent, a => scopeAllows(scope, a.name, aliasFor(a.node_id)));
    const agent = r.agent ?? r.agents?.[0];
    if (!agent) throw new RpcError(ERR.UNSUPPORTED_OPERATION, 'No online agent available to this token');
    return { agent, method: 'matched' };
  }
  const [name, alias] = skillId.split('@');
  if (alias) {
    const agent = getAgentByNameAndAlias(name, alias);
    if (!agent) throw new RpcError(ERR.INVALID_PARAMS, `Unknown skill "${skillId}"`);
    if (!scopeAllows(scope, name, alias)) throw new RpcError(ERR.UNSUPPORTED_OPERATION, `Token "${scope.token}" may not use ${skillId}`, 'denied');
    return { agent, method: 'explicit' };
  }
  if (!scopeAllowsAnyNode(scope, name)) throw new RpcError(ERR.UNSUPPORTED_OPERATION, `Token "${scope.token}" may not use ${name} on any machine`, 'denied');
  const agent = resolveShortFormAgent(name);
  if (!agent) throw new RpcError(ERR.INVALID_PARAMS, `Unknown skill "${skillId}"`);
  return { agent, method: 'explicit' };
}

function visibleTask(scope: TokenScope, id: unknown): TaskRow {
  if (typeof id !== 'string' || !id) throw new RpcError(ERR.INVALID_PARAMS, 'params.id is required');
  const task = getTask(id);
  if (!task) throw new RpcError(ERR.TASK_NOT_FOUND, `Task ${id} not found`);
  if (taskOutOfScope(scope, task)) throw new RpcError(ERR.TASK_NOT_FOUND, `Task ${id} not found`, 'denied');
  return task;
}

async function sendMessage(scope: TokenScope, params: Record<string, unknown>): Promise<{ result: unknown; task: TaskRow }> {
  if (scope.readonly) throw new RpcError(ERR.UNSUPPORTED_OPERATION, 'Read-only token cannot send messages', 'denied');
  const message = asObject(params.message);
  const intent = textOf(message);
  if (!intent) throw new RpcError(ERR.INVALID_PARAMS, 'params.message needs at least one text part');
  const skillRaw = asObject(params.metadata).skillId ?? asObject(message.metadata).skillId ?? 'route';
  if (typeof skillRaw !== 'string') throw new RpcError(ERR.INVALID_PARAMS, 'metadata.skillId must be a string');

  const { agent, method } = pickAgent(scope, skillRaw, intent);
  const taskId = createTaskId();
  insertTask(taskId, 'a2a', intent, 0);
  startAgentForTask(agent, taskId, intent, 0, method);

  const returnImmediately = asObject(params.configuration).returnImmediately === true;
  if (!returnImmediately) await waitForTerminal(taskId, waitMs());
  const task = getTask(taskId)!;
  return { result: { task: toA2aTask(task) }, task };
}

/** Handle one A2A JSON-RPC request for an authenticated caller. */
export async function handleA2aRpc(scope: TokenScope, body: unknown): Promise<RpcResponse> {
  const req = asObject(body) as RpcRequest;
  const id = typeof req.id === 'string' || typeof req.id === 'number' ? req.id : null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = asObject(req.params);
  const started = Date.now();
  let task: TaskRow | undefined;
  let outcome: { isError: boolean; denied?: string } = { isError: false };

  try {
    if (req.jsonrpc !== '2.0' || !method) throw new RpcError(ERR.INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request');
    let result: unknown;
    switch (method) {
      case 'SendMessage': {
        const r = await sendMessage(scope, params);
        task = r.task;
        result = r.result;
        break;
      }
      case 'GetTask': {
        task = visibleTask(scope, params.id);
        result = toA2aTask(task);
        break;
      }
      case 'CancelTask': {
        if (scope.readonly) throw new RpcError(ERR.UNSUPPORTED_OPERATION, 'Read-only token cannot cancel tasks', 'denied');
        task = visibleTask(scope, params.id);
        const res = cancelTask(task.task_id, `a2a:${scope.token}`);
        if (!res.ok) throw new RpcError(ERR.TASK_NOT_CANCELABLE, `Task ${task.task_id} is ${task.status}`);
        task = res.task ?? task;
        result = toA2aTask(task);
        break;
      }
      default:
        throw new RpcError(ERR.METHOD_NOT_FOUND, `Method ${method || '(none)'} not supported (supported: SendMessage, GetTask, CancelTask)`);
    }
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    const e = err instanceof RpcError ? err : new RpcError(ERR.INTERNAL, 'Internal error');
    if (!(err instanceof RpcError)) console.error('[a2a] handler error:', err);
    outcome = { isError: true, denied: e.auditOutcome === 'denied' ? e.message : undefined };
    return { jsonrpc: '2.0', id, error: { code: e.code, message: e.message } };
  } finally {
    recordMcpCall({
      tool: `a2a.${method || 'invalid'}`,
      token: scope.token,
      args: { intent: method === 'SendMessage' ? textOf(asObject(params.message)) : undefined, task_id: params.id },
      result: {
        isError: outcome.isError,
        structuredContent: task ? { taskId: task.task_id, status: task.status, agent: task.agent_name ?? undefined, node: aliasFor(task.node_id) || undefined } : {},
      },
      denied: outcome.denied,
      durationMs: Date.now() - started,
    });
  }
}
