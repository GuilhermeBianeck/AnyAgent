import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { NodeRow, PairCodeRow, AgentRow } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });

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

// Idempotent migrations: add description columns
try { db.exec(`ALTER TABLE nodes ADD COLUMN description TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE agents ADD COLUMN description TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }

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
export function insertAgent(name: string, nodeId: string, binary: string, args: string[], description?: string): void {
  db.prepare(
    `INSERT INTO agents (name, node_id, binary, args_json, description) VALUES (?, ?, ?, ?, ?)`
  ).run(name, nodeId, binary, JSON.stringify(args), description ?? '');
}

export function upsertAgent(name: string, nodeId: string, binary: string, args: string[], description?: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO agents (name, node_id, binary, args_json, description) VALUES (?, ?, ?, ?, ?)`
  ).run(name, nodeId, binary, JSON.stringify(args), description ?? '');
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
