import './helpers/isolate.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { insertNode, upsertAgent, insertTask, updateTaskStatus } from '../src/db.js';
import { startMcp, type McpHarness } from './helpers/mcp.js';

let mcp: McpHarness;

before(async () => {
  insertNode('node_a', 'pk', 'spot');
  insertNode('node_b', 'pk', 'gpu');
  upsertAgent('claude', 'node_a', 'claude', ['-p'], 'Claude Code', ['coding']);
  upsertAgent('claude', 'node_b', 'claude', ['-p'], 'Claude Code', ['coding']);
  // Collides with the explicit tool for claude@spot (anyagent_claude_spot).
  upsertAgent('claude_spot', 'node_b', 'echo', [], 'Name clash');
  mcp = await startMcp();
});

after(async () => { await mcp.close(); });

test('tools/list survives MCP tool-name collisions', async () => {
  const client = await mcp.connect();
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name);
  assert.equal(names.filter(n => n === 'anyagent_claude_spot').length, 1);
  assert.ok(names.includes('anyagent_claude'));
  assert.ok(names.includes('anyagent_claude_gpu'));
});

test('every tool has a title and annotations', async () => {
  const client = await mcp.connect();
  const { tools } = await client.listTools();
  for (const t of tools) {
    assert.ok(t.title, `${t.name} has no title`);
    assert.ok(t.annotations, `${t.name} has no annotations`);
  }
});

test('read-only tools are marked read-only; agent tools are marked destructive + open-world', async () => {
  const client = await mcp.connect();
  const byName = new Map((await client.listTools()).tools.map(t => [t.name, t]));
  for (const ro of ['anyagent_list_agents', 'anyagent_task_status', 'anyagent_context']) {
    assert.equal(byName.get(ro)?.annotations?.readOnlyHint, true, ro);
  }
  for (const rw of ['anyagent_route', 'anyagent_claude', 'anyagent_claude_gpu']) {
    const a = byName.get(rw)?.annotations;
    assert.equal(a?.readOnlyHint, false, rw);
    assert.equal(a?.destructiveHint, true, rw);
    assert.equal(a?.openWorldHint, true, rw);
  }
});

test('list_agents returns structured content with tool names', async () => {
  const client = await mcp.connect();
  const res = await client.callTool({ name: 'anyagent_list_agents', arguments: {} });
  const sc = res.structuredContent as { agents: Array<{ name: string; node: string; tool: string; explicitTool: string; online: boolean }> };
  const gpu = sc.agents.find(a => a.name === 'claude' && a.node === 'gpu');
  assert.ok(gpu);
  assert.equal(gpu.tool, 'anyagent_claude');
  assert.equal(gpu.explicitTool, 'anyagent_claude_gpu');
  assert.equal(gpu.online, false);
  // Text content is still present for clients that ignore structuredContent.
  assert.equal((res.content as Array<{ type: string }>)[0].type, 'text');
});

test('task_status returns structured task with node alias', async () => {
  insertTask('task_s1', 'mcp', 'run tests', 0);
  updateTaskStatus('task_s1', 'complete', { agent_name: 'claude', node_id: 'node_b', result_summary: 'ok' });
  const client = await mcp.connect();
  const res = await client.callTool({ name: 'anyagent_task_status', arguments: { task_id: 'task_s1' } });
  assert.deepEqual(
    { ...(res.structuredContent as object), createdAt: undefined, updatedAt: undefined },
    {
      taskId: 'task_s1', status: 'complete', taskStatus: 'completed', ttlMs: 30 * 24 * 60 * 60 * 1000,
      agent: 'claude', node: 'gpu', intent: 'run tests', result: 'ok', createdAt: undefined, updatedAt: undefined,
    },
  );
});

test('calling an agent on an offline worker is an error with a structured task', async () => {
  const client = await mcp.connect();
  const res = await client.callTool({ name: 'anyagent_claude_gpu', arguments: { intent: 'hello' } });
  assert.equal(res.isError, true);
  const sc = res.structuredContent as { status: string; node: string; agent: string };
  assert.equal(sc.status, 'failed');
  assert.equal(sc.node, 'gpu');
  assert.equal(sc.agent, 'claude');
});

test('requests without the bearer token are rejected', async () => {
  const res = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
});
