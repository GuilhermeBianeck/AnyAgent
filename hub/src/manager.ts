/**
 * Manager — Pure business logic for AnyAgent hub.
 * No UI dependencies (no grammy, no readline). Frontends (bot.ts, cli.ts) call these
 * functions and render the results in their own way.
 */

import { randomBytes } from 'crypto';
import {
  getAllNodes, getNodeById, getAgentByName, getAgentByNameAndNode, getAllAgents,
  nodeDisplayAlias,
  insertPairCode, insertTask, updateTaskStatus, getTask,
  getQueuedTasksByNodeId, getRecentTasksByChatId,
  purgeTasksByChatId, revokeNode as dbRevokeNode,
  getApprovalMode as dbGetApprovalMode, setApprovalMode as dbSetApprovalMode,
  isAgentTrusted as dbIsAgentTrusted, setAgentTrusted as dbSetAgentTrusted,
} from './db.js';
import {
  isNodeOnline,
  sendSpawn,
  approvePair as gwApprovePair,
  rejectPair as gwRejectPair,
  setActiveSession,
  getActiveSession,
  getActiveSessionByChatId,
  clearActiveSession,
  sendTtyInput,
  setDefaultAgent,
  getDefaultAgent,
  clearDefaultAgent,
  killForCancel,
} from './gateway.js';
import { isTerminalStatus } from './types.js';
import { buildSpawnContext } from './context.js';
import type { AgentRow, RoutingMethod, TaskRow } from './types.js';

const MAX_QUEUE_DEPTH = parseInt(process.env.MAX_QUEUE_DEPTH ?? '3', 10);

// --- Result types (UI-agnostic, frontends render these) ---

export interface TaskStartResult {
  outcome: 'started' | 'queued' | 'failed' | 'pending_approval' | 'offline' | 'queue_full';
  taskId: string;
  agentName: string;
  /**
   * Alias of the node the task was dispatched to (or would have been). Lets
   * the UI render "Started claude@spot" instead of just "Started claude" so
   * operators see WHICH machine picked up a short-form call.
   */
  nodeAlias?: string;
  error?: string;
  queuePosition?: number;
}

export interface RoutingResult {
  type: 'matched' | 'single' | 'ambiguous' | 'none';
  agent?: AgentRow;
  agents?: AgentRow[];
  method: RoutingMethod;
}

export interface QueueProcessResult {
  outcome: 'started' | 'failed' | 'empty';
  taskId?: string;
  agentName?: string;
  chatId?: number;
  error?: string;
}

// --- Utility ---

export function createTaskId(): string {
  return `task_${randomBytes(6).toString('hex')}`;
}

// --- Agent routing (shared by bot.ts, cli.ts, mcp.ts) ---

/**
 * Pick an agent by capability keywords. `allow` restricts the candidate set
 * (e.g. to the agents a scoped MCP token may call).
 */
export function findAgentByCapability(intent: string, allow?: (agent: AgentRow) => boolean): RoutingResult {
  const agents = getAllAgents().filter(a => !allow || allow(a));
  const onlineAgents = agents.filter(a => isNodeOnline(a.node_id));
  if (onlineAgents.length === 0) return { type: 'none', method: 'matched' };
  if (onlineAgents.length === 1) return { type: 'single', agent: onlineAgents[0], method: 'single' };

  const intentWords = intent.toLowerCase().split(/\s+/);
  const scored: Array<{ agent: AgentRow; score: number }> = [];

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
    scored.push({ agent, score });
  }

  scored.sort((a, b) => b.score - a.score);
  if (scored[0].score > 0 && (scored.length === 1 || scored[0].score > scored[1].score)) {
    return { type: 'matched', agent: scored[0].agent, method: 'matched' };
  }

  return { type: 'ambiguous', agents: onlineAgents, method: 'user_selected' };
}

/**
 * Pick an agent when the caller supplied only a short name like "claude" —
 * e.g. via the MCP tool `anyagent_claude`. Deterministic so the same input
 * always picks the same node on a given fleet state:
 *   1. Online agents win over offline.
 *   2. Tie-break by oldest pairing (ORDER BY agents.created_at ASC).
 *   3. Log the decision so operators can see *why* their task landed on
 *      a specific machine when they didn't pick one.
 *
 * Returns undefined when no agent with that name exists. Callers who want
 * to address a specific node should use getAgentByNameAndAlias directly.
 */
export function resolveShortFormAgent(name: string): AgentRow | undefined {
  const candidates = getAllAgents().filter(a => a.name === name);
  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => {
    const aOnline = isNodeOnline(a.node_id) ? 0 : 1;
    const bOnline = isNodeOnline(b.node_id) ? 0 : 1;
    if (aOnline !== bOnline) return aOnline - bOnline;
    // created_at is ISO-8601 from SQLite's datetime('now'); string compare works.
    return a.created_at.localeCompare(b.created_at);
  });

  const picked = candidates[0];
  if (candidates.length > 1) {
    // The alternates are useful when diagnosing "why didn't it pick Beacon?"
    const alternates = candidates.slice(1).map(c => `${c.name}@${c.node_id.slice(0, 12)}`).join(', ');
    console.log(`[router] anyagent_${name} → ${name}@${picked.node_id} (online=${isNodeOnline(picked.node_id)}, skipped: ${alternates})`);
  }
  return picked;
}

// --- Task lifecycle ---

export function startAgentForTask(
  agent: AgentRow,
  taskId: string,
  intent: string,
  chatId: number,
  routingMethod: RoutingMethod
): TaskStartResult {
  // Resolve the alias once up front so every outcome path carries it through
  // to the UI without re-querying the DB. Falls back to a short node_id slice
  // if the node row was somehow deleted mid-flight.
  const node = getNodeById(agent.node_id);
  const nodeAlias = node ? nodeDisplayAlias(node) : agent.node_id.replace(/^node_/, '').slice(0, 8);
  const result: TaskStartResult = { outcome: 'failed', taskId, agentName: agent.name, nodeAlias };

  if (!isNodeOnline(agent.node_id)) {
    updateTaskStatus(taskId, 'failed', { error: 'Worker offline', agent_name: agent.name, node_id: agent.node_id, routing_method: routingMethod });
    result.outcome = 'offline';
    return result;
  }

  // Approval gate
  const currentTask = getTask(taskId);
  const wasAlreadyApproved = currentTask?.status === 'submitted' && currentTask?.routing_method !== null;
  const approvalMode = dbGetApprovalMode(chatId);
  const needsApproval =
    !wasAlreadyApproved &&
    ((approvalMode === 'always') ||
     (approvalMode === 'mcp' && routingMethod !== 'explicit' && routingMethod !== 'default'));
  if (needsApproval && !dbIsAgentTrusted(agent.name, agent.node_id)) {
    updateTaskStatus(taskId, 'pending_approval', { agent_name: agent.name, node_id: agent.node_id, routing_method: routingMethod });
    // Auto-deny after 5 minutes
    setTimeout(() => {
      const t = getTask(taskId);
      if (t && t.status === 'pending_approval') {
        updateTaskStatus(taskId, 'failed', { error: 'Approval timed out' });
      }
    }, 5 * 60 * 1000);
    result.outcome = 'pending_approval';
    return result;
  }

  // Queue check
  const existingSession = getActiveSession(agent.node_id);
  if (existingSession) {
    const queued = getQueuedTasksByNodeId(agent.node_id);
    if (queued.length >= MAX_QUEUE_DEPTH) {
      updateTaskStatus(taskId, 'failed', { error: `Queue full (${MAX_QUEUE_DEPTH})`, agent_name: agent.name, node_id: agent.node_id, routing_method: routingMethod });
      result.outcome = 'queue_full';
      return result;
    }
    updateTaskStatus(taskId, 'queued', { agent_name: agent.name, node_id: agent.node_id, routing_method: routingMethod });
    result.outcome = 'queued';
    result.queuePosition = queued.length + 1;
    return result;
  }

  // Spawn
  const agentArgs: string[] = JSON.parse(agent.args_json);
  const isContextAware = agent.context_aware !== 0;
  const spawnContext = isContextAware ? buildSpawnContext(chatId, intent) : intent;
  const ok = sendSpawn(agent.node_id, agent.binary, agentArgs, taskId, spawnContext);
  if (!ok) {
    updateTaskStatus(taskId, 'failed', { error: 'Failed to spawn', agent_name: agent.name, node_id: agent.node_id, routing_method: routingMethod });
    result.outcome = 'failed';
    result.error = 'Failed to spawn';
    return result;
  }

  setActiveSession(agent.node_id, chatId, agent.name);
  updateTaskStatus(taskId, 'running', { agent_name: agent.name, node_id: agent.node_id, routing_method: routingMethod });
  result.outcome = 'started';
  return result;
}

/**
 * The agent a task is bound to. Once a task has a node_id it must stay on that
 * machine — resolving by name alone could hand a task that was queued for, or
 * approved on, claude@laptop to claude@gpu. Returns undefined if that agent is
 * gone or quarantined.
 */
export function resolveTaskAgent(task: Pick<TaskRow, 'agent_name' | 'node_id'>): AgentRow | undefined {
  if (!task.agent_name) return undefined;
  if (task.node_id) return getAgentByNameAndNode(task.agent_name, task.node_id);
  return getAgentByName(task.agent_name);
}

// --- Queue processing ---

export function processNextQueued(nodeId: string): QueueProcessResult {
  while (true) {
    const queued = getQueuedTasksByNodeId(nodeId);
    if (queued.length === 0) return { outcome: 'empty' };

    const next = queued[0];
    const agent = resolveTaskAgent({ agent_name: next.agent_name, node_id: nodeId });
    if (!agent) {
      updateTaskStatus(next.task_id, 'failed', { error: 'Agent no longer available' });
      continue;
    }

    const agentArgs: string[] = JSON.parse(agent.args_json);
    const isContextAware = agent.context_aware !== 0;
    const spawnIntent = isContextAware ? buildSpawnContext(next.chat_id, next.intent) : next.intent;
    const ok = sendSpawn(agent.node_id, agent.binary, agentArgs, next.task_id, spawnIntent);
    if (!ok) {
      updateTaskStatus(next.task_id, 'failed', { error: 'Failed to spawn from queue' });
      continue;
    }

    setActiveSession(agent.node_id, next.chat_id ?? 0, agent.name);
    updateTaskStatus(next.task_id, 'running');
    return { outcome: 'started', taskId: next.task_id, agentName: agent.name, chatId: next.chat_id ?? undefined };
  }
}

/** Poll until a task reaches a terminal state, or null on timeout. */
export async function waitForTerminal(taskId: string, timeoutMs: number, pollMs = 250): Promise<TaskRow | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = getTask(taskId);
    if (task && isTerminalStatus(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return null;
}

// --- Cancellation (AR-6) ---

export interface CancelResult {
  ok: boolean;
  task?: TaskRow;
  reason?: string;
  /** True if a running process was asked to stop. */
  killed?: boolean;
}

/**
 * Cancel any non-terminal task. Queued / pending-approval / routed tasks are
 * simply marked cancelled; a running task's process is killed on its worker
 * (gateway.killForCancel handles the exit that follows).
 */
export function cancelTask(taskId: string, by: string = 'user'): CancelResult {
  const task = getTask(taskId);
  if (!task) return { ok: false, reason: 'not found' };
  if (isTerminalStatus(task.status)) return { ok: false, task, reason: `already ${task.status}` };

  const wasRunning = task.status === 'running';
  updateTaskStatus(taskId, 'cancelled', { error: `Cancelled by ${by}` });
  let killed = false;
  if (wasRunning && task.node_id) {
    killed = killForCancel(task.node_id);
    // Worker offline: nothing to kill. Free the node; its queue resumes on reconnect.
    if (!killed) clearActiveSession(task.node_id);
  }
  return { ok: true, task: getTask(taskId), killed };
}

// --- Approval ---

export function handleApprovalDecision(taskId: string, decision: 'approve' | 'deny' | 'trust'): { ok: boolean; task?: TaskRow; agentName?: string; agent?: AgentRow } {
  const task = getTask(taskId);
  if (!task || task.status !== 'pending_approval') return { ok: false };

  if (decision === 'deny') {
    updateTaskStatus(taskId, 'failed', { error: 'Denied by operator' });
    return { ok: true, task };
  }

  if (decision === 'trust' && task.agent_name && task.node_id) {
    dbSetAgentTrusted(task.agent_name, task.node_id, true);
  }

  // Reset to submitted so startAgentForTask can proceed past approval gate
  updateTaskStatus(taskId, 'submitted');
  // The operator approved THIS machine's agent — never re-resolve by name.
  return { ok: true, task, agentName: task.agent_name ?? undefined, agent: resolveTaskAgent(task) };
}

// --- Pairing ---

export function generatePairCode(): { code: string; expiresAt: Date } {
  const code = randomBytes(16).toString('hex').toUpperCase();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  insertPairCode(code, expiresAt, '');
  return { code, expiresAt };
}

export function approveWorkerPairing(connId: string): string | null {
  return gwApprovePair(connId);
}

export function rejectWorkerPairing(connId: string): void {
  gwRejectPair(connId);
}

// --- Worker management ---

export function revokeWorker(nodeId: string): boolean {
  return dbRevokeNode(nodeId);
}

export function getWorkerList(): Array<{ nodeId: string; name: string; alias: string; description: string; online: boolean }> {
  return getAllNodes().map(n => ({
    nodeId: n.node_id,
    name: n.name || n.node_id,
    alias: nodeDisplayAlias(n),
    description: n.description,
    online: isNodeOnline(n.node_id),
  }));
}

export function getAgentList(): Array<{ name: string; description: string; capabilities: string[]; nodeId: string; nodeAlias: string; nodeName: string; online: boolean; contextAware: boolean }> {
  // Pre-load nodes into a map so we don't N+1 across agent rows.
  const nodesByIdMap = new Map<string, { alias: string; name: string }>();
  for (const n of getAllNodes()) {
    nodesByIdMap.set(n.node_id, { alias: nodeDisplayAlias(n), name: n.name || n.node_id });
  }
  return getAllAgents().map(a => {
    const n = nodesByIdMap.get(a.node_id);
    // Fallback if the node row was somehow deleted but the agent wasn't — use a
    // single DB call rather than silently drop the agent from the UI.
    let alias = n?.alias;
    let nodeName = n?.name;
    if (alias === undefined) {
      const row = getNodeById(a.node_id);
      alias = row ? nodeDisplayAlias(row) : a.node_id.replace(/^node_/, '').slice(0, 8);
      nodeName = row?.name || a.node_id;
    }
    return {
      name: a.name,
      description: a.description,
      capabilities: JSON.parse(a.capabilities || '[]'),
      nodeId: a.node_id,
      nodeAlias: alias,
      nodeName: nodeName ?? a.node_id,
      online: isNodeOnline(a.node_id),
      contextAware: a.context_aware !== 0,
    };
  });
}

// --- Session ---

export { getActiveSession, getActiveSessionByChatId, clearActiveSession, sendTtyInput };
export { setDefaultAgent, getDefaultAgent, clearDefaultAgent };

// --- Task queries ---

export function getRecentTasks(chatId: number, limit: number = 10): TaskRow[] {
  return getRecentTasksByChatId(chatId, limit);
}

export { getTask, purgeTasksByChatId };

// --- Approval config ---

export function getApprovalMode(chatId: number): string {
  return dbGetApprovalMode(chatId);
}

export function setApprovalMode(chatId: number, mode: 'off' | 'mcp' | 'always'): void {
  dbSetApprovalMode(chatId, mode);
}

export { dbIsAgentTrusted as isAgentTrusted };

// --- Agent definition review (AR-3) ---

export { listPendingReviews, getPendingReview, approvePendingAgent, reviewMode, type PendingReview } from './declare.js';
