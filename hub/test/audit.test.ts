import { testHubDir } from './helpers/isolate.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { insertNode, upsertAgent } from '../src/db.js';
import { recentAudit, intentDigest } from '../src/audit.js';
import { startMcp, type McpHarness } from './helpers/mcp.js';

let mcp: McpHarness;
before(async () => {
  insertNode('node_a', 'pk', 'spot');
  upsertAgent('claude', 'node_a', 'claude', [], 'Claude Code', ['coding']);
  mcp = await startMcp();
});
after(async () => {
  delete process.env.AUDIT_LOG_INTENT;
  await mcp.close();
});

const auditFile = () => readFileSync(join(testHubDir, 'logs', 'audit.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('every MCP tool call is recorded with tool, token, outcome and timing', async () => {
  const client = await mcp.connect();
  await client.callTool({ name: 'anyagent_list_agents', arguments: {} });
  const [rec] = recentAudit(1);
  assert.equal(rec.type, 'mcp.call');
  assert.equal(rec.tool, 'anyagent_list_agents');
  assert.equal(rec.token, 'admin');
  assert.equal(rec.outcome, 'ok');
  assert.equal(typeof rec.duration_ms, 'number');
  assert.deepEqual(auditFile().at(-1), rec, 'persisted to logs/audit.log');
});

test('agent calls record the resolved agent, node, task and outcome — but not the intent text', async () => {
  const client = await mcp.connect();
  await client.callTool({ name: 'anyagent_claude_spot', arguments: { intent: 'deploy the secret project' } });
  const [rec] = recentAudit(1);
  assert.equal(rec.tool, 'anyagent_claude_spot');
  assert.equal(rec.agent, 'claude');
  assert.equal(rec.node, 'spot');
  assert.match(rec.task_id ?? '', /^task_/);
  assert.equal(rec.outcome, 'error', 'worker is offline');
  assert.equal(rec.intent_sha256, intentDigest('deploy the secret project'));
  assert.equal(rec.intent, undefined);
  assert.ok(!readFileSync(join(testHubDir, 'logs', 'audit.log'), 'utf8').includes('secret project'));
});

test('AUDIT_LOG_INTENT=1 opts in to storing the intent text', async () => {
  process.env.AUDIT_LOG_INTENT = '1';
  const client = await mcp.connect();
  await client.callTool({ name: 'anyagent_claude', arguments: { intent: 'run the tests' } });
  assert.equal(recentAudit(1)[0].intent, 'run the tests');
  delete process.env.AUDIT_LOG_INTENT;
});

test('status lookups record the task id they asked about', async () => {
  const client = await mcp.connect();
  await client.callTool({ name: 'anyagent_task_status', arguments: { task_id: 'task_missing' } });
  const [rec] = recentAudit(1);
  assert.equal(rec.task_id, 'task_missing');
  assert.equal(rec.outcome, 'error');
});
