/**
 * Processing of a worker's `declare` RPC, extracted from gateway.ts so it can
 * be unit-tested without a WebSocket.
 *
 * Pipeline: sanitize (AR-2) → apply to the agent registry → report.
 */

import {
  updateNodeName, updateNodeDescription, deleteAgentsByNodeId, upsertAgent,
  getAllAgents, getNodeById,
} from './db.js';
import { emit as emitEvent } from './events.js';
import { sanitizeAgents, sanitizeText, LIMITS, type SanitizeReport } from './sanitize.js';
import type { DeclareParams } from './types.js';

export const MAX_AGENTS_PER_NODE = 50;

export interface DeclareOutcome {
  accepted: string[];
  rejected: SanitizeReport['rejected'];
  modified: SanitizeReport['modified'];
  /** Agent names that also exist on other nodes (informational). */
  collisions: Array<{ name: string; otherNodes: string[] }>;
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

  // Replace all agents for this node only — namespaced by node_id
  deleteAgentsByNodeId(nodeId);
  for (const a of report.agents) {
    upsertAgent(a.name, nodeId, a.binary, a.args, a.description, a.capabilities, a.contextAware);
  }

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
    collisions,
  };
}
