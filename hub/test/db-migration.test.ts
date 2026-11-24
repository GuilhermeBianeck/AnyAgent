/**
 * Upgrading a database created by an older hub. The legacy schema is built
 * BEFORE db.ts is imported, so the module's startup migrations run against it.
 */
import { testHubDir } from './helpers/isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = join(testHubDir, 'data');
mkdirSync(dataDir, { recursive: true });
const legacy = new DatabaseSync(join(dataDir, 'anyagent.db'));
legacy.exec(`
  CREATE TABLE nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT UNIQUE NOT NULL,
    public_key TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
    approved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT NOT NULL DEFAULT '', alias TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, node_id TEXT NOT NULL,
    binary TEXT NOT NULL, args_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT NOT NULL DEFAULT '', capabilities TEXT NOT NULL DEFAULT '[]',
    context_aware INTEGER NOT NULL DEFAULT 1, trusted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'telegram', chat_id INTEGER,
    intent TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'submitted', routing_method TEXT,
    agent_name TEXT, node_id TEXT, result_summary TEXT, error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO nodes (node_id, public_key, name, approved, alias) VALUES ('node_a', 'pk', 'laptop', 1, 'laptop');
  INSERT INTO nodes (node_id, public_key, name, approved, alias) VALUES ('node_b', 'pk', 'gpu', 1, 'gpu');
  INSERT INTO agents (name, node_id, binary, description, trusted) VALUES ('claude', 'node_a', 'claude', 'Claude Code', 1);
`);
legacy.close();

const db = await import('../src/db.js');

test('legacy global UNIQUE(name) is replaced by per-node uniqueness', () => {
  db.upsertAgent('claude', 'node_b', 'claude', [], 'Claude Code on GPU box');
  assert.equal(db.getAgentByNameAndAlias('claude', 'laptop')?.node_id, 'node_a');
  assert.equal(db.getAgentByNameAndAlias('claude', 'gpu')?.node_id, 'node_b');
});

test('existing agent rows survive the rebuild with their columns', () => {
  const a = db.getAgentByNameAndAlias('claude', 'laptop');
  assert.equal(a?.description, 'Claude Code');
  assert.equal((a as unknown as { trusted: number }).trusted, 1);
});

test('same (name, node) is still unique', () => {
  // upsertAgent deletes then inserts, so call the raw path twice via upsert and
  // confirm only one row exists for the pair.
  db.upsertAgent('claude', 'node_b', 'claude', []);
  db.upsertAgent('claude', 'node_b', 'claude', []);
  assert.equal(db.getAllAgents().filter(a => a.node_id === 'node_b' && a.name === 'claude').length, 1);
});

test('tasks.retry_count is added to legacy task tables', () => {
  db.insertTask('task_legacy', 'cli', 'hello', 0, 2);
  assert.equal(db.getTask('task_legacy')?.retry_count, 2);
});
