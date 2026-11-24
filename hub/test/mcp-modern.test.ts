/**
 * MCP 2026-07-28 (stateless core) — AR-7. Uses the v2 client pinned to the
 * modern protocol. Every other MCP test uses the v1 client (2025-11-25), so
 * together they cover both eras of the dual-stack server.
 */
import './helpers/isolate.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createToken } from '../src/tokens.js';
import { recentAudit } from '../src/audit.js';
import { startMcp, type McpHarness } from './helpers/mcp.js';
import { startGateway, connectWorker, type Gateway, type FakeWorker } from './helpers/worker.js';

const MODERN = '2026-07-28';
let mcp: McpHarness;
let gw: Gateway;
let box: FakeWorker;
const clients: Client[] = [];

before(async () => {
  gw = await startGateway();
  box = await connectWorker(gw, 'box', [{ name: 'claude', binary: 'claude', description: 'Claude Code', capabilities: ['coding'] }]);
  mcp = await startMcp('admin-secret');
});
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await box.close();
  await gw.close();
  await mcp.close();
});

async function connect(token: string, mode: 'pin' | 'auto' = 'pin'): Promise<Client> {
  const client = new Client(
    { name: 'anyagent-modern-test', version: '0.0.0' },
    { versionNegotiation: { mode: mode === 'pin' ? { pin: MODERN } : 'auto' } },
  );
  await client.connect(new StreamableHTTPClientTransport(mcp.url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  clients.push(client);
  return client;
}

test('a 2026-07-28 client negotiates the modern protocol', async () => {
  const client = await connect('admin-secret');
  assert.equal(client.getNegotiatedProtocolVersion(), MODERN);
});

test('auto negotiation also lands on the modern protocol', async () => {
  const client = await connect('admin-secret', 'auto');
  assert.equal(client.getNegotiatedProtocolVersion(), MODERN);
});

test('server/discover answers', async () => {
  const client = await connect('admin-secret');
  const res = await client.discover() as unknown as Record<string, unknown>;
  assert.ok(res && typeof res === 'object');
  assert.match(JSON.stringify(res), /anyagent-hub/);
});

test('tools keep their annotations and scoping on the modern path', async () => {
  const admin = await connect('admin-secret');
  const tools = (await admin.listTools()).tools;
  const byName = new Map(tools.map(t => [t.name, t]));
  assert.equal(byName.get('anyagent_list_agents')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('anyagent_claude_box')?.annotations?.destructiveHint, true);

  const reader = await connect(createToken('modern-reader', { readonly: true }).token);
  assert.deepEqual((await reader.listTools()).tools.map(t => t.name).sort(),
    ['anyagent_context', 'anyagent_list_agents', 'anyagent_task_status']);
});

test('a blocking agent call returns structured content and streams progress', async () => {
  const client = await connect('admin-secret');
  const progress: string[] = [];
  const call = client.callTool(
    { name: 'anyagent_claude_box', arguments: { intent: 'ship it', timeout_ms: 10_000 } },
    { onprogress: (p: { message?: string }) => { if (p.message) progress.push(p.message); } },
  );
  const spawn = await box.nextSpawn();
  box.output(spawn.taskId!, 'status', { text: 'Packaging' });
  await new Promise(r => setTimeout(r, 100));
  box.output(spawn.taskId!, 'result', { text: 'shipped' });
  const res = await call;

  const sc = res.structuredContent as { taskStatus: string; result: string; node: string };
  assert.equal(sc.taskStatus, 'completed');
  assert.equal(sc.result, 'shipped');
  assert.equal(sc.node, 'box');
  assert.deepEqual(progress, ['Started on claude@box', 'Packaging']);
  assert.equal(recentAudit(1)[0].tool, 'anyagent_claude_box');
});
