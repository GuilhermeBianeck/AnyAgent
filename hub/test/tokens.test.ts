import './helpers/isolate.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { insertNode, upsertAgent, insertTask, updateTaskStatus } from '../src/db.js';
import { createToken, listTokens, revokeToken, resolveBearer, TokenError } from '../src/tokens.js';
import { recentAudit } from '../src/audit.js';
import { startMcp, type McpHarness } from './helpers/mcp.js';
import { startGateway, connectWorker } from './helpers/worker.js';

let mcp: McpHarness;
let laptopOnly: string;   // claude@laptop only
let claudeAny: string;    // claude on any machine
let reader: string;       // read-only, all agents

before(async () => {
  insertNode('node_a', 'pk', 'laptop');
  insertNode('node_b', 'pk', 'gpu');
  upsertAgent('claude', 'node_a', 'claude', [], 'Claude Code', ['coding']);
  upsertAgent('claude', 'node_b', 'claude', [], 'Claude Code', ['coding']);
  upsertAgent('shell', 'node_b', 'bash', [], 'Shell', ['shell']);
  laptopOnly = createToken('cursor-laptop', { agents: ['claude@laptop'] }).token;
  claudeAny = createToken('claude-any', { agents: ['claude'] }).token;
  reader = createToken('dashboard', { readonly: true }).token;
  mcp = await startMcp('admin-secret');
});
after(async () => { await mcp.close(); });

const toolNames = async (token: string) => (await (await mcp.connect(token)).listTools()).tools.map(t => t.name).sort();

test('token labels and agent entries are validated', () => {
  assert.throws(() => createToken('admin'), TokenError);
  assert.throws(() => createToken('cursor-laptop'), /already exists/);
  assert.throws(() => createToken('bad label'), TokenError);
  assert.throws(() => createToken('x', { agents: ['rm -rf'] }), /Invalid agent entry/);
});

test('only the hash is stored; the plaintext resolves to its scope', () => {
  assert.match(laptopOnly, /^aat_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(resolveBearer(`Bearer ${laptopOnly}`), { token: 'cursor-laptop', agents: ['claude@laptop'], readonly: false });
  assert.equal(resolveBearer(`Bearer ${laptopOnly}x`), null);
  assert.equal(resolveBearer(laptopOnly), null, 'Bearer prefix required');
  assert.deepEqual(resolveBearer('Bearer admin-secret', 'admin-secret')?.token, 'admin');
  assert.ok(listTokens().find(t => t.token === 'cursor-laptop')?.lastUsedAt, 'last use is recorded');
});

test('admin token sees every tool', async () => {
  assert.deepEqual(await toolNames('admin-secret'), [
    'anyagent_claude', 'anyagent_claude_gpu', 'anyagent_claude_laptop', 'anyagent_context',
    'anyagent_list_agents', 'anyagent_route', 'anyagent_shell', 'anyagent_shell_gpu', 'anyagent_task_status',
  ]);
});

test('a name@alias token gets only that explicit tool — no short form the hub could re-route', async () => {
  assert.deepEqual(await toolNames(laptopOnly), [
    'anyagent_claude_laptop', 'anyagent_context', 'anyagent_list_agents', 'anyagent_route', 'anyagent_task_status',
  ]);
});

test('a bare-name token gets the short form and every machine for that name', async () => {
  assert.deepEqual(await toolNames(claudeAny), [
    'anyagent_claude', 'anyagent_claude_gpu', 'anyagent_claude_laptop', 'anyagent_context',
    'anyagent_list_agents', 'anyagent_route', 'anyagent_task_status',
  ]);
});

test('a read-only token cannot run anything', async () => {
  assert.deepEqual(await toolNames(reader), ['anyagent_context', 'anyagent_list_agents', 'anyagent_task_status']);
});

test('list_agents is filtered to the token scope', async () => {
  const client = await mcp.connect(laptopOnly);
  const res = await client.callTool({ name: 'anyagent_list_agents', arguments: {} });
  const agents = (res.structuredContent as { agents: Array<{ name: string; node: string; tool: string }> }).agents;
  assert.deepEqual(agents.map(a => `${a.name}@${a.node}`), ['claude@laptop']);
  assert.equal(agents[0].tool, 'anyagent_claude_laptop', 'points at the explicit tool');
});

test('route only considers agents in scope', async () => {
  // Real workers, so the agents are online and routing has a choice to make.
  const gw = await startGateway();
  const laptop = await connectWorker(gw, 'office', [{ name: 'claude', binary: 'claude', capabilities: ['coding'] }]);
  const gpu = await connectWorker(gw, 'render', [{ name: 'shell', binary: 'bash', capabilities: ['shell', 'scripts'] }]);
  const token = createToken('office-only', { agents: ['claude@office'] }).token;
  try {
    // By capability this intent is a clear match for shell@render — out of scope.
    const admin = await mcp.connect('admin-secret');
    const adminRes = await admin.callTool({ name: 'anyagent_route', arguments: { intent: 'run shell scripts' } });
    assert.equal((adminRes.structuredContent as { agent: string }).agent, 'shell');

    const scoped = await mcp.connect(token);
    const res = await scoped.callTool({ name: 'anyagent_route', arguments: { intent: 'run shell scripts' } });
    const sc = res.structuredContent as { agent: string; node: string };
    assert.equal(sc.agent, 'claude');
    assert.equal(sc.node, 'office');
  } finally {
    await laptop.close();
    await gpu.close();
    await gw.close();
  }
});

test('task_status hides tasks of agents outside the scope, and audits the denial', async () => {
  insertTask('task_gpu', 'mcp', 'secret work', 0);
  updateTaskStatus('task_gpu', 'complete', { agent_name: 'shell', node_id: 'node_b', result_summary: 'secret result' });
  const client = await mcp.connect(laptopOnly);
  const res = await client.callTool({ name: 'anyagent_task_status', arguments: { task_id: 'task_gpu' } });
  assert.equal(res.isError, true);
  assert.equal((res.content as Array<{ text: string }>)[0].text, 'Task task_gpu not found.');
  assert.equal(res.structuredContent, undefined);
  const [rec] = recentAudit(1);
  assert.equal(rec.token, 'cursor-laptop');
  assert.equal(rec.outcome, 'denied');
  assert.match(rec.detail ?? '', /shell@gpu/);

  const admin = await mcp.connect('admin-secret');
  const ok = await admin.callTool({ name: 'anyagent_task_status', arguments: { task_id: 'task_gpu' } });
  assert.equal((ok.structuredContent as { result: string }).result, 'secret result');
});

test('revoked tokens stop working immediately', async () => {
  const { token } = createToken('temp');
  assert.ok(resolveBearer(`Bearer ${token}`));
  assert.ok(revokeToken('temp'));
  const res = await fetch(mcp.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 401);
});

test('the MCP server works with scoped tokens only (no admin token)', async () => {
  const scopedOnly = await startMcp(undefined as unknown as string);
  try {
    const client = await scopedOnly.connect(reader);
    assert.ok((await client.listTools()).tools.length > 0);
    const res = await fetch(scopedOnly.url, { method: 'POST', headers: { authorization: 'Bearer undefined' }, body: '{}' });
    assert.equal(res.status, 401);
  } finally {
    await scopedOnly.close();
  }
});
