// Uses Node's built-in node:sqlite (stable since Node 22.5). No native module,
// no node-gyp, no Python/compiler prereqs — the #1 source of install failures
// for AnyAgent users was better-sqlite3's native build.
//
// Runtime API (prepare/run/get/all/exec) is a drop-in match. The one thing that
// differs is TypeScript: node:sqlite's `.all()` returns Record<string, SQLOutputValue>[]
// rather than `unknown[]`, and `.run().changes` is `number | bigint`. The `prep()`
// helper below re-narrows both to the shapes our call sites were already using.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { join } from 'path';
import type { NodeRow, PairCodeRow, AgentRow, SessionRow, DefaultAgentRow, TaskRow, TaskStatus, TaskSource, RoutingMethod } from './types.js';
import { incTask } from './metrics.js';
import { emit as emitEvent } from './events.js';
import { dataDir as resolveDataDir } from './paths.js';

const resolvedDataDir = resolveDataDir();
mkdirSync(resolvedDataDir, { recursive: true, mode: 0o700 });

const rawDb = new DatabaseSync(join(resolvedDataDir, 'anyagent.db'));

// Thin adapter — isomorphic to the API every call site in this file already uses.
// Centralizing the `as unknown` casts + BigInt→number narrowing here keeps the
// rest of the file readable.
interface PreparedStmt {
  run(...args: unknown[]): { changes: number };
  get<T>(...args: unknown[]): T | undefined;
  all<T>(...args: unknown[]): T[];
}
const db = {
  exec(sql: string): void { rawDb.exec(sql); },
  prepare(sql: string): PreparedStmt {
    const stmt = rawDb.prepare(sql);
    return {
      run(...args: unknown[]) {
        // node:sqlite accepts null|number|bigint|string|Uint8Array for binds; all
        // our call sites pass those, so the cast is sound.
        const r = stmt.run(...(args as (null | number | bigint | string | Uint8Array)[]));
        return { changes: Number(r.changes) };
      },
      get<T>(...args: unknown[]): T | undefined {
        const row = stmt.get(...(args as (null | number | bigint | string | Uint8Array)[]));
        return (row ?? undefined) as T | undefined;
      },
      all<T>(...args: unknown[]): T[] {
        return stmt.all(...(args as (null | number | bigint | string | Uint8Array)[])) as unknown as T[];
      },
    };
  },
};

db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT UNIQUE NOT NULL,
    public_key TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    approved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pair_codes (
    code TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    ws_id TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    node_id TEXT NOT NULL,
    binary TEXT NOT NULL,
    args_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (node_id) REFERENCES nodes(node_id)
  );
`);

// Idempotent migrations
try { db.exec(`ALTER TABLE nodes ADD COLUMN description TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE nodes ADD COLUMN alias TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE agents ADD COLUMN description TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE agents ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]'`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE agents ADD COLUMN context_aware INTEGER NOT NULL DEFAULT 1`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE agents ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
// Fix agent name collision: namespace by (name, node_id) instead of name alone
try { db.exec(`DROP INDEX IF EXISTS sqlite_autoindex_agents_1`); } catch { /* may not exist */ }
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name_node ON agents(name, node_id)`); } catch { /* already exists */ }

// Session and default agent persistence
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    agent_name TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS default_agents (
    chat_id INTEGER PRIMARY KEY,
    agent_name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS approval_config (
    chat_id INTEGER PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'off'
  );

  CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'telegram',
    chat_id INTEGER,
    intent TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted',
    routing_method TEXT,
    agent_name TEXT,
    node_id TEXT,
    result_summary TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Pair code operations
export function insertPairCode(code: string, expiresAt: Date, wsId: string): void {
  db.prepare(
    `INSERT INTO pair_codes (code, expires_at, ws_id) VALUES (?, ?, ?)`
  ).run(code, expiresAt.toISOString(), wsId);
}

export function getPairCode(code: string): PairCodeRow | undefined {
  return db.prepare(`SELECT * FROM pair_codes WHERE code = ?`).get(code) as PairCodeRow | undefined;
}

export function deletePairCode(code: string): void {
  db.prepare(`DELETE FROM pair_codes WHERE code = ?`).run(code);
}

export function deleteExpiredPairCodes(): void {
  db.prepare(`DELETE FROM pair_codes WHERE expires_at < datetime('now')`).run();
}

// Node operations

/**
 * Derive a short, human-friendly alias from a worker name.
 * Examples: "Spot.local" → "spot", "MacBook Pro" → "macbook_pro", "" → ""
 * The alias is what users see in MCP tool names (e.g. `anyagent_claude_spot`)
 * and in Telegram listings. Empty string falls back to a slice of node_id at
 * display time — we never fabricate random aliases at storage time.
 */
export function deriveAlias(name: string): string {
  const trimmed = (name ?? '').trim().toLowerCase()
    .replace(/\.(local|lan|home|arpa)$/i, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return trimmed;
}

/**
 * Resolve an alias that's guaranteed unique across approved nodes.
 * If the desired alias is already taken by a DIFFERENT node, append `-2`,
 * `-3`, etc. Used by insertNode and updateNodeName so per-node aliases stay
 * addressable without operator intervention.
 */
function uniqueAlias(desired: string, forNodeId: string): string {
  if (!desired) return '';
  const existing = db.prepare(
    `SELECT node_id FROM nodes WHERE alias = ? AND node_id != ?`
  ).get(desired, forNodeId) as { node_id: string } | undefined;
  if (!existing) return desired;
  // Collision: walk -2, -3, ... until free
  for (let i = 2; i < 100; i++) {
    const candidate = `${desired}-${i}`;
    const taken = db.prepare(
      `SELECT node_id FROM nodes WHERE alias = ? AND node_id != ?`
    ).get(candidate, forNodeId) as { node_id: string } | undefined;
    if (!taken) return candidate;
  }
  // Absurd fallback — 99 collisions on the same alias. Include node_id hex.
  return `${desired}-${forNodeId.slice(0, 8)}`;
}

export function insertNode(nodeId: string, publicKey: string, name?: string, description?: string): void {
  const alias = uniqueAlias(deriveAlias(name ?? ''), nodeId);
  db.prepare(
    `INSERT INTO nodes (node_id, public_key, name, description, alias, approved) VALUES (?, ?, ?, ?, ?, 1)`
  ).run(nodeId, publicKey, name ?? '', description ?? '', alias);
}

export function updateNodeName(nodeId: string, name: string): void {
  const alias = uniqueAlias(deriveAlias(name), nodeId);
  db.prepare(`UPDATE nodes SET name = ?, alias = ? WHERE node_id = ?`).run(name, alias, nodeId);
}

export function updateNodeDescription(nodeId: string, description: string): void {
  db.prepare(`UPDATE nodes SET description = ? WHERE node_id = ?`).run(description, nodeId);
}

export function getNodeById(nodeId: string): NodeRow | undefined {
  return db.prepare(`SELECT * FROM nodes WHERE node_id = ?`).get(nodeId) as NodeRow | undefined;
}

export function getAllNodes(): NodeRow[] {
  return db.prepare(`SELECT * FROM nodes WHERE approved = 1`).all() as NodeRow[];
}

export function nodeExists(nodeId: string): boolean {
  const row = db.prepare(`SELECT id FROM nodes WHERE node_id = ?`).get(nodeId);
  return row !== undefined;
}

/**
 * Render a user-facing alias for a node, with a stable fallback when the
 * stored alias is empty (pre-migration rows or nameless workers).
 */
export function nodeDisplayAlias(node: Pick<NodeRow, 'alias' | 'node_id' | 'name'>): string {
  if (node.alias && node.alias.length > 0) return node.alias;
  const fromName = deriveAlias(node.name || '');
  if (fromName) return fromName;
  // Last resort: short hex slice of node_id — e.g. "b033c0f0"
  return node.node_id.replace(/^node_/, '').slice(0, 8);
}

/**
 * Resolve a node_id by alias. Used when a user types `claude@spot` and we
 * need to find the corresponding worker.
 */
export function getNodeByAlias(alias: string): NodeRow | undefined {
  return db.prepare(`SELECT * FROM nodes WHERE alias = ? AND approved = 1`).get(alias) as NodeRow | undefined;
}

// One-time backfill at startup: any approved node whose alias is blank gets
// one derived from its name (or a node_id slice if nameless).
(function backfillAliases(): void {
  const rows = db.prepare(`SELECT node_id, name FROM nodes WHERE alias = '' OR alias IS NULL`).all() as Array<{ node_id: string; name: string }>;
  for (const r of rows) {
    const desired = deriveAlias(r.name) || r.node_id.replace(/^node_/, '').slice(0, 8);
    const alias = uniqueAlias(desired, r.node_id);
    db.prepare(`UPDATE nodes SET alias = ? WHERE node_id = ?`).run(alias, r.node_id);
  }
})();

// Agent operations
export function upsertAgent(name: string, nodeId: string, binary: string, args: string[], description?: string, capabilities?: string[], contextAware?: boolean): void {
  // Keyed on (name, node_id) — prevents cross-worker agent name hijacking
  db.prepare(`DELETE FROM agents WHERE name = ? AND node_id = ?`).run(name, nodeId);
  db.prepare(
    `INSERT INTO agents (name, node_id, binary, args_json, description, capabilities, context_aware) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(name, nodeId, binary, JSON.stringify(args), description ?? '', JSON.stringify(capabilities ?? []), contextAware === false ? 0 : 1);
}

export function deleteAgentsByNodeId(nodeId: string): void {
  db.prepare(`DELETE FROM agents WHERE node_id = ?`).run(nodeId);
}

export function getAgentsByNodeId(nodeId: string): AgentRow[] {
  return db.prepare(`SELECT * FROM agents WHERE node_id = ?`).all(nodeId) as AgentRow[];
}

/**
 * Resolve an agent by name, with a deterministic tie-break when multiple nodes
 * declare the same agent name:
 *   1. Prefer agents on currently-approved nodes (should be all of them)
 *   2. Prefer older pairings (ORDER BY agents.created_at ASC)
 * Callers that need a specific machine's agent MUST use getAgentByNameAndAlias
 * or getAgentByNameAndNode — those never collapse name collisions.
 */
export function getAgentByName(name: string): AgentRow | undefined {
  return db.prepare(
    `SELECT a.* FROM agents a
     JOIN nodes n ON n.node_id = a.node_id
     WHERE a.name = ? AND n.approved = 1
     ORDER BY a.created_at ASC
     LIMIT 1`
  ).get(name) as AgentRow | undefined;
}

/**
 * Look up an agent by (name, node alias) — the canonical form for explicit
 * addressing like `claude@spot`. Returns undefined if either the alias doesn't
 * exist or the node has no agent by that name.
 */
export function getAgentByNameAndAlias(name: string, alias: string): AgentRow | undefined {
  return db.prepare(
    `SELECT a.* FROM agents a
     JOIN nodes n ON n.node_id = a.node_id
     WHERE a.name = ? AND n.alias = ? AND n.approved = 1
     LIMIT 1`
  ).get(name, alias) as AgentRow | undefined;
}

/**
 * Look up an agent by (name, node_id). Used when we already have the node_id
 * from a session or task record and don't want to go through alias resolution.
 */
export function getAgentByNameAndNode(name: string, nodeId: string): AgentRow | undefined {
  return db.prepare(
    `SELECT * FROM agents WHERE name = ? AND node_id = ? LIMIT 1`
  ).get(name, nodeId) as AgentRow | undefined;
}

export function getAllAgents(): AgentRow[] {
  return db.prepare(`SELECT * FROM agents`).all() as AgentRow[];
}

export function deleteAgent(name: string): boolean {
  const result = db.prepare(`DELETE FROM agents WHERE name = ?`).run(name);
  return result.changes > 0;
}

// Session operations
export function upsertSession(sessionId: string, nodeId: string, chatId: number, agentName?: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO sessions (session_id, node_id, chat_id, agent_name, started_at, last_activity_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(sessionId, nodeId, chatId, agentName ?? null);
}

export function getSessionByNodeId(nodeId: string): SessionRow | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE node_id = ?`).get(nodeId) as SessionRow | undefined;
}

export function getSessionByChatId(chatId: number): SessionRow | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE chat_id = ?`).get(chatId) as SessionRow | undefined;
}

export function deleteSessionByNodeId(nodeId: string): void {
  db.prepare(`DELETE FROM sessions WHERE node_id = ?`).run(nodeId);
}

export function getAllSessions(): SessionRow[] {
  return db.prepare(`SELECT * FROM sessions`).all() as SessionRow[];
}

export function touchSession(nodeId: string): void {
  db.prepare(`UPDATE sessions SET last_activity_at = datetime('now') WHERE node_id = ?`).run(nodeId);
}

// Default agent operations
export function upsertDefaultAgent(chatId: number, agentName: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO default_agents (chat_id, agent_name) VALUES (?, ?)`
  ).run(chatId, agentName);
}

export function getDefaultAgentByChatId(chatId: number): DefaultAgentRow | undefined {
  return db.prepare(`SELECT * FROM default_agents WHERE chat_id = ?`).get(chatId) as DefaultAgentRow | undefined;
}

export function deleteDefaultAgentByChatId(chatId: number): void {
  db.prepare(`DELETE FROM default_agents WHERE chat_id = ?`).run(chatId);
}

// Task operations
export function insertTask(taskId: string, source: TaskSource, intent: string, chatId?: number, retryCount?: number): void {
  db.prepare(
    `INSERT INTO tasks (task_id, source, chat_id, intent, status, retry_count) VALUES (?, ?, ?, ?, 'submitted', ?)`
  ).run(taskId, source, chatId ?? null, intent, retryCount ?? 0);
}

export function getTask(taskId: string): TaskRow | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE task_id = ?`).get(taskId) as TaskRow | undefined;
}

const TERMINAL_STATUSES: TaskStatus[] = ['complete', 'failed', 'timeout'];

export function updateTaskStatus(taskId: string, status: TaskStatus, extra?: { agent_name?: string; node_id?: string; routing_method?: RoutingMethod; result_summary?: string; error?: string }): void {
  const sets = [`status = ?`, `updated_at = datetime('now')`];
  const values: unknown[] = [status];
  if (extra?.agent_name !== undefined) { sets.push('agent_name = ?'); values.push(extra.agent_name); }
  if (extra?.node_id !== undefined) { sets.push('node_id = ?'); values.push(extra.node_id); }
  if (extra?.routing_method !== undefined) { sets.push('routing_method = ?'); values.push(extra.routing_method); }
  if (extra?.result_summary !== undefined) { sets.push('result_summary = ?'); values.push(extra.result_summary); }
  if (extra?.error !== undefined) { sets.push('error = ?'); values.push(extra.error); }
  values.push(taskId);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`).run(...values);

  // Emit terminal-state metrics + event log once per task
  if (TERMINAL_STATUSES.includes(status)) {
    const row = db.prepare(`SELECT source FROM tasks WHERE task_id = ?`).get(taskId) as { source?: string } | undefined;
    const source = row?.source ?? 'unknown';
    incTask(status, source);
    if (status === 'complete') {
      emitEvent('task.complete', { task_id: taskId });
    } else {
      emitEvent('task.failed', { task_id: taskId, detail: extra?.error });
    }
  }
}

export function getRecentTasks(limit: number = 10): TaskRow[] {
  return db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`).all(limit) as TaskRow[];
}

export function getRecentTasksByChatId(chatId: number, limit: number = 10): TaskRow[] {
  return db.prepare(`SELECT * FROM tasks WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?`).all(chatId, limit) as TaskRow[];
}

export function getLastCompletedTask(chatId: number): TaskRow | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE chat_id = ? AND status = 'complete' ORDER BY updated_at DESC LIMIT 1`).get(chatId) as TaskRow | undefined;
}

export function getRecentCompletedTasksByChatId(chatId: number, limit: number = 5): TaskRow[] {
  return db.prepare(`SELECT * FROM tasks WHERE chat_id = ? AND status = 'complete' ORDER BY updated_at DESC LIMIT ?`).all(chatId, limit) as TaskRow[];
}

export function getQueuedTasksByNodeId(nodeId: string): TaskRow[] {
  return db.prepare(`SELECT * FROM tasks WHERE node_id = ? AND status = 'queued' ORDER BY created_at ASC`).all(nodeId) as TaskRow[];
}

export function cleanOldTasks(daysToKeep: number = 30): void {
  db.prepare(`DELETE FROM tasks WHERE created_at < datetime('now', '-' || ? || ' days')`).run(daysToKeep);
}

// Startup cleanup: mark orphaned running/routed/pending_approval tasks as failed.
// IMPORTANT: queued tasks are intentionally preserved — index.ts re-offers them to
// workers via onWorkerOnline, so a hub restart doesn't lose queued work.
export function failStaleTasks(): number {
  const result = db.prepare(
    `UPDATE tasks SET status = 'failed', error = 'Hub restarted', updated_at = datetime('now')
     WHERE status IN ('running', 'routed', 'pending_approval')`
  ).run();
  return result.changes;
}

export function clearAllSessions(): void {
  db.prepare(`DELETE FROM sessions`).run();
}

// Query running tasks by node (targeted, not scanning recent)
export function getRunningTasksByNodeId(nodeId: string): TaskRow[] {
  return db.prepare(`SELECT * FROM tasks WHERE node_id = ? AND status = 'running'`).all(nodeId) as TaskRow[];
}

// Revoke a node — delete it and all its agents
export function revokeNode(nodeId: string): boolean {
  deleteAgentsByNodeId(nodeId);
  deleteSessionByNodeId(nodeId);
  const result = db.prepare(`DELETE FROM nodes WHERE node_id = ?`).run(nodeId);
  return result.changes > 0;
}

// Purge all task data for a specific chat
export function purgeTasksByChatId(chatId: number): number {
  const result = db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(chatId);
  return result.changes;
}

// Purge all tasks regardless of chat
export function purgeAllTasks(): number {
  const result = db.prepare(`DELETE FROM tasks`).run();
  return result.changes;
}

// Approval config
export type ApprovalMode = 'off' | 'mcp' | 'always';

export function getApprovalMode(chatId: number): ApprovalMode {
  const row = db.prepare(`SELECT mode FROM approval_config WHERE chat_id = ?`).get(chatId) as { mode: string } | undefined;
  return (row?.mode as ApprovalMode) ?? 'off';
}

export function setApprovalMode(chatId: number, mode: ApprovalMode): void {
  db.prepare(`INSERT OR REPLACE INTO approval_config (chat_id, mode) VALUES (?, ?)`).run(chatId, mode);
}

// Agent trust (per-agent, skips approval when trusted)
export function isAgentTrusted(agentName: string): boolean {
  const row = db.prepare(`SELECT trusted FROM agents WHERE name = ?`).get(agentName) as { trusted: number } | undefined;
  return row?.trusted === 1;
}

export function setAgentTrusted(agentName: string, trusted: boolean): void {
  db.prepare(`UPDATE agents SET trusted = ? WHERE name = ?`).run(trusted ? 1 : 0, agentName);
}
