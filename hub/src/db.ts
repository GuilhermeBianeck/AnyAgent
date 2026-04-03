import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { NodeRow, PairCodeRow, AgentRow, SessionRow, DefaultAgentRow, TaskRow, TaskStatus, TaskSource, RoutingMethod } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const db = new Database(join(dataDir, 'anyagent.db'));

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
export function insertNode(nodeId: string, publicKey: string, name?: string, description?: string): void {
  db.prepare(
    `INSERT INTO nodes (node_id, public_key, name, description, approved) VALUES (?, ?, ?, ?, 1)`
  ).run(nodeId, publicKey, name ?? '', description ?? '');
}

export function updateNodeName(nodeId: string, name: string): void {
  db.prepare(`UPDATE nodes SET name = ? WHERE node_id = ?`).run(name, nodeId);
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

export function getAgentByName(name: string): AgentRow | undefined {
  return db.prepare(`SELECT * FROM agents WHERE name = ?`).get(name) as AgentRow | undefined;
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

// Startup cleanup: mark orphaned running/queued/routed tasks as failed
export function failStaleTasks(): number {
  const result = db.prepare(
    `UPDATE tasks SET status = 'failed', error = 'Hub restarted', updated_at = datetime('now')
     WHERE status IN ('running', 'queued', 'routed', 'pending_approval')`
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
