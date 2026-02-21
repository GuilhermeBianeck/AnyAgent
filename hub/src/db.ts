import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { NodeRow, PairCodeRow } from './types.js';

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
export function insertNode(nodeId: string, publicKey: string): void {
  db.prepare(
    `INSERT INTO nodes (node_id, public_key, approved) VALUES (?, ?, 1)`
  ).run(nodeId, publicKey);
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
