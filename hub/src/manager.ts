/**
 * Manager — Pure business logic for AnyAgent hub.
 * No UI dependencies (no grammy, no readline). Frontends (bot.ts, cli.ts) call these
 * functions and render the results in their own way.
 */

import { randomBytes } from 'crypto';
import {
  getAllNodes, getAgentByName, getAllAgents,
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
} from './gateway.js';
import { buildSpawnContext } from './context.js';
import type { AgentRow, RoutingMethod, TaskRow } from './types.js';

const MAX_QUEUE_DEPTH = parseInt(process.env.MAX_QUEUE_DEPTH ?? '3', 10);

// --- Result types (UI-agnostic, frontends render these) ---

export interface TaskStartResult {
  outcome: 'started' | 'queued' | 'failed' | 'pending_approval' | 'offline' | 'queue_full';
  taskId: string;
  agentName: string;
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

export function findAgentByCapability(intent: string): RoutingResult {
  const agents = getAllAgents();
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

// --- Task lifecycle ---

export function startAgentForTask(
  agent: AgentRow,
  taskId: string,
  intent: string,
  chatId: number,
  routingMethod: RoutingMethod
): TaskStartResult {
  const result: TaskStartResult = { outcome: 'failed', taskId, agentName: agent.name };

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
  if (needsApproval && !dbIsAgentTrusted(agent.name)) {
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

// --- Queue processing ---

export function processNextQueued(nodeId: string): QueueProcessResult {
  while (true) {
    const queued = getQueuedTasksByNodeId(nodeId);
    if (queued.length === 0) return { outcome: 'empty' };

    const next = queued[0];
    const agent = next.agent_name ? getAgentByName(next.agent_name) : undefined;
    if (!agent || !next.chat_id) {
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

    setActiveSession(agent.node_id, next.chat_id, agent.name);
    updateTaskStatus(next.task_id, 'running');
    return { outcome: 'started', taskId: next.task_id, agentName: agent.name, chatId: next.chat_id };
  }
}

// --- Approval ---

export function handleApprovalDecision(taskId: string, decision: 'approve' | 'deny' | 'trust'): { ok: boolean; task?: TaskRow; agentName?: string } {
  const task = getTask(taskId);
  if (!task || task.status !== 'pending_approval') return { ok: false };

  if (decision === 'deny') {
    updateTaskStatus(taskId, 'failed', { error: 'Denied by operator' });
    return { ok: true, task };
  }

  if (decision === 'trust' && task.agent_name) {
    dbSetAgentTrusted(task.agent_name, true);
  }

  // Reset to submitted so startAgentForTask can proceed past approval gate
  updateTaskStatus(taskId, 'submitted');
  return { ok: true, task, agentName: task.agent_name ?? undefined };
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

export function getWorkerList(): Array<{ nodeId: string; name: string; description: string; online: boolean }> {
  return getAllNodes().map(n => ({
    nodeId: n.node_id,
    name: n.name || n.node_id,
    description: n.description,
    online: isNodeOnline(n.node_id),
  }));
}

export function getAgentList(): Array<{ name: string; description: string; capabilities: string[]; nodeId: string; online: boolean; contextAware: boolean }> {
  return getAllAgents().map(a => ({
    name: a.name,
    description: a.description,
    capabilities: JSON.parse(a.capabilities || '[]'),
    nodeId: a.node_id,
    online: isNodeOnline(a.node_id),
    contextAware: a.context_aware !== 0,
  }));
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
