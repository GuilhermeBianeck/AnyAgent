/**
 * A2A v1.0 surface (AR-8), exercised with the OFFICIAL @a2a-js/sdk client so
 * the wire format is checked against a real implementation, not our reading
 * of the spec.
 */
import './helpers/isolate.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory, type Client } from '@a2a-js/sdk/client';
import { getTask } from '../src/db.js';
import { createToken } from '../src/tokens.js';
import { recentAudit } from '../src/audit.js';
import { startMcp, type McpHarness } from './helpers/mcp.js';
import { startGateway, connectWorker, type Gateway, type FakeWorker } from './helpers/worker.js';

let mcp: McpHarness;
let gw: Gateway;
let box: FakeWorker;
let base: string;

before(async () => {
  process.env.A2A_ENABLED = '1';
  process.env.A2A_WAIT_MS = '3000';
  gw = await startGateway();
  box = await connectWorker(gw, 'box', [
    { name: 'claude', binary: 'claude', description: 'Claude Code', capabilities: ['coding'] },
  ]);
  mcp = await startMcp('admin-secret');
  base = `http://127.0.0.1:${(mcp.server.address() as { port: number }).port}`;
});
after(async () => {
  delete process.env.A2A_ENABLED;
  await box.close();
  await gw.close();
  await mcp.close();
});

async function a2aClient(token: string): Promise<Client> {
  const authFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  const factory = new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    transports: [new JsonRpcTransportFactory({ fetchImpl: authFetch })],
  }));
  return factory.createFromUrl(base);
}

const textMessage = (text: string, skillId?: string) => ({
  messageId: `m-${Math.random().toString(16).slice(2)}`,
  contextId: '',
  taskId: '',
  role: 1 /* ROLE_USER */,
  parts: [{ content: { $case: 'text' as const, value: text }, metadata: undefined, filename: '', mediaType: '' }],
  metadata: skillId ? { skillId } : undefined,
  extensions: [],
  referenceTaskIds: [],
});

type SdkTask = { id: string; status?: { state: number; message?: { parts: Array<{ content?: { $case: string; value: unknown } }> } }; artifacts: Array<{ parts: Array<{ content?: { $case: string; value: unknown } }> }> };
const TASK_STATE = { SUBMITTED: 1, WORKING: 2, COMPLETED: 3, CANCELED: 5 };

test('the Agent Card is served and parsed by the official SDK', async () => {
  const res = await fetch(`${base}/.well-known/agent-card.json`);
  assert.equal(res.status, 200);
  const card = await res.json();
  assert.deepEqual(card.supportedInterfaces, [{ url: `${base}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
  assert.deepEqual(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme, 'bearer');
  assert.deepEqual(card.skills.map((s: { id: string }) => s.id), ['route', 'claude@box']);
  // createFromUrl downloads + validates the card and picks the JSON-RPC transport.
  await a2aClient('admin-secret');
});

test('SendMessage runs the agent and returns a completed task with the result artifact', async () => {
  const client = await a2aClient('admin-secret');
  const pending = client.sendMessage({ tenant: '', message: textMessage('write a haiku', 'claude@box'), configuration: undefined, metadata: undefined });
  const spawn = await box.nextSpawn();
  box.output(spawn.taskId!, 'result', { text: 'autumn moonlight' });
  const task = (await pending) as unknown as SdkTask;

  assert.equal(task.id, spawn.taskId);
  assert.equal(task.status?.state, TASK_STATE.COMPLETED);
  const part = task.artifacts[0].parts[0].content;
  assert.deepEqual(part, { $case: 'text', value: 'autumn moonlight' });
  assert.equal(getTask(task.id)?.source, 'a2a');
});

test('returnImmediately + GetTask + CancelTask', async () => {
  const client = await a2aClient('admin-secret');
  const started = (await client.sendMessage({
    tenant: '', message: textMessage('long job'), metadata: undefined,
    configuration: { acceptedOutputModes: [], taskPushNotificationConfig: undefined, returnImmediately: true },
  })) as unknown as SdkTask;
  assert.equal(started.status?.state, TASK_STATE.WORKING, 'routed (default skill) and running');
  await box.nextSpawn();

  const fetched = (await client.getTask({ tenant: '', id: started.id })) as unknown as SdkTask;
  assert.equal(fetched.status?.state, TASK_STATE.WORKING);

  const cancelled = (await client.cancelTask({ tenant: '', id: started.id, metadata: undefined })) as unknown as SdkTask;
  assert.equal(cancelled.status?.state, TASK_STATE.CANCELED);
  box.exit(137);

  await assert.rejects(client.cancelTask({ tenant: '', id: started.id, metadata: undefined }), /cancel/i);
});

test('unknown tasks and out-of-scope tasks both look "not found"', async () => {
  const admin = await a2aClient('admin-secret');
  const pending = admin.sendMessage({ tenant: '', message: textMessage('secret', 'claude@box'), configuration: undefined, metadata: undefined });
  const spawn = await box.nextSpawn();
  box.output(spawn.taskId!, 'result', { text: 'classified' });
  await pending;

  const other = createToken('elsewhere', { agents: ['claude@laptop'] }).token;
  const scoped = await a2aClient(other);
  await assert.rejects(scoped.getTask({ tenant: '', id: spawn.taskId! }), /not found/i);
  await assert.rejects(scoped.getTask({ tenant: '', id: 'task_nope' }), /not found/i);
  assert.equal(recentAudit(1)[0].tool, 'a2a.GetTask');
});

test('scoped and read-only tokens are enforced on SendMessage', async () => {
  const other = createToken('elsewhere2', { agents: ['claude@laptop'] }).token;
  const scoped = await a2aClient(other);
  await assert.rejects(
    scoped.sendMessage({ tenant: '', message: textMessage('hi', 'claude@box'), configuration: undefined, metadata: undefined }),
    /may not use claude@box/,
  );
  const reader = await a2aClient(createToken('reader', { readonly: true }).token);
  await assert.rejects(
    reader.sendMessage({ tenant: '', message: textMessage('hi'), configuration: undefined, metadata: undefined }),
    /Read-only/,
  );
  const [rec] = recentAudit(1);
  assert.equal(rec.outcome, 'denied');
  assert.equal(rec.token, 'reader');
});

test('the RPC endpoint requires a token; the card does not', async () => {
  const rpc = await fetch(`${base}/a2a`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(rpc.status, 401);
  assert.equal((await fetch(`${base}/.well-known/agent-card.json`)).status, 200);
});

test('A2A is off unless A2A_ENABLED=1', async () => {
  process.env.A2A_ENABLED = '0';
  try {
    assert.notEqual((await fetch(`${base}/.well-known/agent-card.json`)).status, 200);
  } finally {
    process.env.A2A_ENABLED = '1';
  }
});
