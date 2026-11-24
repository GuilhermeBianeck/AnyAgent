import './helpers/isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  insertNode, getNodeById, deriveAlias, upsertAgent, getAgentByName,
  getAgentByNameAndAlias, insertTask, getTask, updateTaskStatus,
} from '../src/db.js';

test('deriveAlias normalises worker names', () => {
  assert.equal(deriveAlias('Spot.local'), 'spot');
  assert.equal(deriveAlias('MacBook Pro'), 'macbook_pro');
  assert.equal(deriveAlias(''), '');
});

test('node aliases stay unique across nodes', () => {
  insertNode('node_a', 'pk', 'Laptop');
  insertNode('node_b', 'pk', 'laptop');
  assert.equal(getNodeById('node_a')?.alias, 'laptop');
  assert.equal(getNodeById('node_b')?.alias, 'laptop-2');
});

test('agents are addressable by name and by name@alias', () => {
  upsertAgent('claude', 'node_a', 'claude', ['-p'], 'Claude Code', ['coding']);
  upsertAgent('claude', 'node_b', 'claude', ['-p'], 'Claude Code', ['coding']);
  assert.equal(getAgentByNameAndAlias('claude', 'laptop-2')?.node_id, 'node_b');
  assert.ok(getAgentByName('claude'));
});

test('task lifecycle persists status and result', () => {
  insertTask('task_1', 'mcp', 'run tests', 0);
  updateTaskStatus('task_1', 'complete', { result_summary: 'all green' });
  const t = getTask('task_1');
  assert.equal(t?.status, 'complete');
  assert.equal(t?.result_summary, 'all green');
});
