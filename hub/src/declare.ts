/**
 * Processing of a worker's `declare` RPC, extracted from gateway.ts so it can
 * be unit-tested without a WebSocket.
 *
 * Pipeline: sanitize (AR-2) → pin / quarantine (AR-3) → report.
 *
 * Pinning (rug-pull protection). OWASP's MCP guidance: pin reviewed tool
 * definitions by hash and require re-review when they change. Each agent's
 * definition (binary, args, description, capabilities, contextAware) is
 * hashed. The first time a (name, node) is seen its hash is pinned (trust on
 * first use). If a later declaration changes it, the agent is quarantined —
 * invisible to MCP, routing, Telegram and the CLI — until the operator
 * approves the new definition with `review`.
 *
 * AGENT_REVIEW=changes (default) | all (new agents also need review) | off.
 */

import {
  updateNodeName, updateNodeDescription, getAllAgents, getNodeById, nodeDisplayAlias,
  getAgentsByNodeIdAnyState, insertDeclaredAgent, updateDeclaredAgent, deleteAgentById,
  definitionHash, rowDefinition, getPendingAgents, getPendingAgentById, approveAgentDefinition,
  type AgentDefinition,
} from './db.js';
import { emit as emitEvent } from './events.js';
import { sanitizeAgents, sanitizeText, LIMITS, type SanitizeReport } from './sanitize.js';
import type { DeclareParams } from './types.js';

export const MAX_AGENTS_PER_NODE = 50;

export type ReviewMode = 'changes' | 'all' | 'off';

export function reviewMode(): ReviewMode {
  const v = (process.env.AGENT_REVIEW ?? 'changes').trim().toLowerCase();
  return v === 'all' || v === 'off' ? v : 'changes';
}

export interface DeclareOutcome {
  accepted: string[];
  rejected: SanitizeReport['rejected'];
  modified: SanitizeReport['modified'];
  /** Accepted agents that are quarantined until the operator reviews them. */
  pendingReview: string[];
  /** Agent names that also exist on other nodes (informational). */
  collisions: Array<{ name: string; otherNodes: string[] }>;
}

const DEFINITION_FIELDS: Array<keyof AgentDefinition> = ['binary', 'args', 'description', 'capabilities', 'contextAware'];

function parseApproved(json: string): AgentDefinition | null {
  if (!json) return null;
  try { return JSON.parse(json) as AgentDefinition; } catch { return null; }
}

export function changedFields(before: AgentDefinition | null, after: AgentDefinition): Array<keyof AgentDefinition> {
  if (!before) return [];
  return DEFINITION_FIELDS.filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

/**
 * Reconcile a node's declared agents with the registry, applying pinning.
 * Rows keep their id, created_at and trust while their definition is
 * unchanged — so reconnects no longer reset the short-form picker's "oldest
 * pairing" order or silently drop trust.
 */
function applyAgents(nodeId: string, agents: SanitizeReport['agents']): string[] {
  const mode = reviewMode();
  const existing = new Map(getAgentsByNodeIdAnyState(nodeId).map(r => [r.name, r]));
  const pending: string[] = [];

  for (const a of agents) {
    const def: AgentDefinition = {
      binary: a.binary, args: a.args, description: a.description,
      capabilities: a.capabilities, contextAware: a.contextAware,
    };
    const hash = definitionHash(def);
    const row = existing.get(a.name);
    existing.delete(a.name);

    if (!row) {
      const approve = mode !== 'all';
      insertDeclaredAgent(nodeId, a.name, def, approve);
      if (!approve) {
        pending.push(a.name);
        emitEvent('agent.quarantined', { node_id: nodeId, name: a.name, detail: 'new agent (AGENT_REVIEW=all)' });
      }
      continue;
    }

    // Rows from before pinning existed (both hashes empty) were already live:
    // pin whatever they declare now. NB: a NEW agent quarantined under
    // AGENT_REVIEW=all has approved_hash '' but a non-empty definition_hash,
    // so it does not qualify — otherwise it would self-approve on reconnect.
    const legacy = row.approved_hash === '' && row.definition_hash === '';
    if (legacy || hash === row.approved_hash) {
      updateDeclaredAgent(row.id, def, { approve: true, resetTrust: false });
      continue;
    }
    if (mode === 'off') {
      updateDeclaredAgent(row.id, def, { approve: true, resetTrust: true });
      continue;
    }

    // Definition differs from the approved one → quarantine. Trust was granted
    // to the old definition, so it does not carry over.
    const alreadyPendingSame = row.definition_hash === hash;
    updateDeclaredAgent(row.id, def, { approve: false, resetTrust: true });
    pending.push(a.name);
    if (!alreadyPendingSame) {
      const fields = changedFields(parseApproved(row.approved_json), def);
      const detail = row.approved_hash === '' ? 'new agent awaiting review' : `changed: ${fields.join(', ') || 'definition'}`;
      console.warn(`[declare] Agent "${a.name}" on node ${nodeId} quarantined (${detail}). Approve with: review`);
      emitEvent('agent.quarantined', { node_id: nodeId, name: a.name, detail });
    }
  }

  // Agents the worker no longer declares are removed.
  for (const row of existing.values()) deleteAgentById(row.id);
  return pending;
}

// ---------------------------------------------------------------------------
// Review (used by CLI `review` and Telegram `/review`)
// ---------------------------------------------------------------------------

export interface PendingReview {
  id: number;
  name: string;
  nodeId: string;
  nodeAlias: string;
  /** null when the agent was never approved (new under AGENT_REVIEW=all). */
  before: AgentDefinition | null;
  after: AgentDefinition;
  changed: Array<keyof AgentDefinition>;
}

function toReview(row: ReturnType<typeof getPendingAgents>[number]): PendingReview {
  const node = getNodeById(row.node_id);
  const before = parseApproved(row.approved_json);
  const after = rowDefinition(row);
  return {
    id: row.id,
    name: row.name,
    nodeId: row.node_id,
    nodeAlias: node ? nodeDisplayAlias(node) : row.node_id.slice(0, 12),
    before,
    after,
    changed: before ? changedFields(before, after) : [...DEFINITION_FIELDS],
  };
}

export function listPendingReviews(): PendingReview[] {
  return getPendingAgents().map(toReview);
}

export function getPendingReview(id: number): PendingReview | undefined {
  const row = getPendingAgentById(id);
  return row ? toReview(row) : undefined;
}

/** Approve a quarantined agent's current definition. */
export function approvePendingAgent(id: number): PendingReview | undefined {
  const review = getPendingReview(id);
  if (!review || !approveAgentDefinition(id)) return undefined;
  emitEvent('agent.approved', { node_id: review.nodeId, name: review.name, detail: review.changed.join(',') });
  return review;
}

export function processDeclaration(nodeId: string, params: DeclareParams): DeclareOutcome {
  // ---- Node metadata ----
  if (params.name) {
    const n = sanitizeText(params.name, LIMITS.nodeName);
    if (n.changed) emitEvent('worker.metadata_sanitized', { node_id: nodeId, detail: 'node name' });
    if (n.value) updateNodeName(nodeId, n.value);
  }
  if (params.description) {
    const d = sanitizeText(params.description, LIMITS.nodeDescription);
    if (d.changed) emitEvent('worker.metadata_sanitized', { node_id: nodeId, detail: 'node description' });
    if (d.value) updateNodeDescription(nodeId, d.value);
  }

  // ---- Agents ----
  const report = sanitizeAgents(params.agents, MAX_AGENTS_PER_NODE);
  for (const r of report.rejected) {
    console.warn(`[declare] Node ${nodeId}: rejected agent "${r.name}": ${r.reason}`);
    emitEvent('worker.agent_rejected', { node_id: nodeId, name: r.name, detail: r.reason });
  }
  for (const m of report.modified) {
    console.warn(`[declare] Node ${nodeId}: sanitized ${m.fields.join(', ')} of agent "${m.name}"`);
    emitEvent('worker.metadata_sanitized', { node_id: nodeId, name: m.name, detail: m.fields.join(',') });
  }

  // Detect cross-node name collisions BEFORE replacing this node's agents, so
  // the result reflects the true "other nodes already have this" state.
  // Non-blocking — operators may intentionally run the same agent on several
  // machines as a fleet.
  const otherNodesByName = new Map<string, string[]>();
  for (const existing of getAllAgents()) {
    if (existing.node_id === nodeId) continue;
    const list = otherNodesByName.get(existing.name) ?? [];
    list.push(existing.node_id);
    otherNodesByName.set(existing.name, list);
  }

  const pendingReview = applyAgents(nodeId, report.agents);

  const collisions: DeclareOutcome['collisions'] = [];
  for (const a of report.agents) {
    const others = otherNodesByName.get(a.name);
    if (!others?.length) continue;
    const aliases = others
      .map(id => getNodeById(id))
      .filter((n): n is NonNullable<typeof n> => !!n)
      .map(n => n.alias || n.node_id.slice(0, 12));
    collisions.push({ name: a.name, otherNodes: aliases });
    console.warn(`[declare] Agent "${a.name}" on node ${nodeId} collides with ${aliases.length} other node(s): ${aliases.join(', ')}. MCP will expose anyagent_${a.name}_<alias> for each.`);
  }

  return {
    accepted: report.agents.map(a => a.name),
    rejected: report.rejected,
    modified: report.modified,
    pendingReview,
    collisions,
  };
}
