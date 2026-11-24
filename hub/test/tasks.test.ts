/**
 * Task handles, cancellation and progress (AR-6), end to end: a scripted
 * worker paired with the real gateway, called through the real MCP server.
 */
import './helpers/isolate.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getTask, insertTask } from '../src/db.js';
import { onSessionEnd } from '../src/gateway.js';
import { processNextQueued, cancelTask } from '../src/manager.js';
import { toMcpTaskStatus } from '../src/mcp.js';
import { startMcp, type McpHarness } from './helpers/mcp.js';
import { startGateway, connectWorker, type Gateway, type FakeWorker } from './helpers/worker.js';

let mcp: McpHarness;
let gw: Gateway;
let worker: FakeWorker;

type Sc = { taskId: string; status: string; taskStatus: string; pollIntervalMs?: number; ttlMs: number; result?: string; queuePosition?: number };

before(async () => {
  // bot.ts/cli.ts normally advance the queue when a session ends.
  onSessionEnd((nodeId) => { processNextQueued(nodeId); });
  gw = await startGateway();
  worker = await connectWorker(gw, 'box', [{ name: 'claude', binary: 'claude', capabilities: ['coding'] }]);
  mcp = await startMcp();
});
after(async () => {
  await worker.close();
  await gw.close();
  await mcp.close();
});

const waitFor = async (pred: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 10));
  }
};

test('MCP Tasks status vocabulary mapping', () => {
  assert.equal(toMcpTaskStatus('running'), 'working');
  assert.equal(toMcpTaskStatus('queued'), 'working');
  assert.equal(toMcpTaskStatus('pending_approval'), 'input_required');
  assert.equal(toMcpTaskStatus('complete'), 'completed');
  assert.equal(toMcpTaskStatus('timeout'), 'failed');
  assert.equal(toMcpTaskStatus('cancelled'), 'cancelled');
});

test('async call returns a pollable handle; terminal states drop pollIntervalMs', async () => {
  const client = await mcp.connect();
  const res = await client.callTool({ name: 'anyagent_claude_box', arguments: { intent: 'say hi' } });
  const sc = res.structuredContent as Sc;
  assert.equal(sc.status, 'running');
  assert.equal(sc.taskStatus, 'working');
  assert.equal(sc.pollIntervalMs, 2000);
  assert.ok(sc.ttlMs > 0);

  const spawn = await worker.nextSpawn();
  assert.equal(spawn.taskId, sc.taskId);
  worker.output(sc.taskId, 'result', { text: 'hi' });
  await waitFor(() => getTask(sc.taskId)?.status === 'complete');

  const done = (await client.callTool({ name: 'anyagent_task_status', arguments: { task_id: sc.taskId } })).structuredContent as Sc;
  assert.equal(done.taskStatus, 'completed');
  assert.equal(done.pollIntervalMs, undefined);
  assert.equal(done.result, 'hi');
});

test('blocking call relays worker status/progress as MCP progress notifications', async () => {
  const client = await mcp.connect();
  const seen: Array<{ progress: number; message?: string }> = [];
  const call = client.callTool(
    { name: 'anyagent_claude', arguments: { intent: 'build it', timeout_ms: 10_000 } },
    undefined,
    { onprogress: (p) => { seen.push({ progress: p.progress, message: p.message }); } },
  );
  const spawn = await worker.nextSpawn();
  worker.output(spawn.taskId!, 'status', { text: 'Compiling' });
  worker.output(spawn.taskId!, 'progress', { current: 2, total: 4, label: 'tests' });
  await waitFor(() => seen.length >= 3);
  worker.output(spawn.taskId!, 'result', { text: 'built' });
  const res = await call;

  assert.equal((res.structuredContent as Sc).result, 'built');
  assert.deepEqual(seen.map(s => s.message), ['Started on claude@box', 'Compiling', '2/4 (50%) — tests']);
  assert.deepEqual(seen.map(s => s.progress), [1, 2, 3], 'progress strictly increases');
});

test('cancelling a queued task never runs it', async () => {
  const client = await mcp.connect();
  const first = (await client.callTool({ name: 'anyagent_claude_box', arguments: { intent: 'long job' } })).structuredContent as Sc;
  await worker.nextSpawn();
  const queued = (await client.callTool({ name: 'anyagent_claude_box', arguments: { intent: 'later' } })).structuredContent as Sc;
  assert.equal(queued.status, 'queued');
  assert.equal(queued.queuePosition, 1);

  const res = await client.callTool({ name: 'anyagent_task_cancel', arguments: { task_id: queued.taskId } });
  assert.equal((res.structuredContent as Sc).taskStatus, 'cancelled');
  assert.equal(worker.kills, 0, 'nothing was running for this task');

  // Finishing the first task must not start the cancelled one.
  const spawnsBefore = worker.spawns.length;
  worker.output(first.taskId, 'result', { text: 'done' });
  await waitFor(() => getTask(first.taskId)?.status === 'complete');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(worker.spawns.length, spawnsBefore);
});

test('cancelling a running task kills it, and its exit does not touch the next task', async () => {
  const client = await mcp.connect();
  const running = (await client.callTool({ name: 'anyagent_claude_box', arguments: { intent: 'stuck job' } })).structuredContent as Sc;
  await worker.nextSpawn();
  const next = (await client.callTool({ name: 'anyagent_claude_box', arguments: { intent: 'next job' } })).structuredContent as Sc;
  assert.equal(next.status, 'queued');

  const res = await client.callTool({ name: 'anyagent_task_cancel', arguments: { task_id: running.taskId } });
  assert.match((res.content as Array<{ text: string }>)[0].text, /process was stopped/);
  await waitFor(() => worker.kills === 1);
  assert.equal(getTask(running.taskId)?.status, 'cancelled');

  // A late result from the killed process is ignored…
  worker.output(running.taskId, 'result', { text: 'too late' });
  // …and its exit ends the session, which starts the queued task.
  worker.exit(137);
  const spawn = await worker.nextSpawn();
  assert.equal(spawn.taskId, next.taskId);
  await waitFor(() => getTask(next.taskId)?.status === 'running');
  assert.equal(getTask(running.taskId)?.status, 'cancelled', 'not flipped by the late result');
  assert.equal(getTask(running.taskId)?.result_summary, null);

  // The next task is still running — the killed process's exit was not applied to it.
  await new Promise(r => setTimeout(r, 50));
  assert.equal(getTask(next.taskId)?.status, 'running');
  worker.output(next.taskId, 'result', { text: 'ok' });
  await waitFor(() => getTask(next.taskId)?.status === 'complete');
});

test('finished tasks cannot be cancelled', async () => {
  insertTask('task_done', 'cli', 'x', 0);
  cancelTask('task_done');
  const again = cancelTask('task_done');
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already cancelled');
  assert.equal(cancelTask('task_nope').reason, 'not found');
});

test('a blocking call ends promptly with "cancelled" when its task is cancelled', async () => {
  const client = await mcp.connect();
  const call = client.callTool({ name: 'anyagent_claude_box', arguments: { intent: 'wait for me', timeout_ms: 10_000 } });
  const spawn = await worker.nextSpawn();
  cancelTask(spawn.taskId!);
  worker.exit(137);
  const res = await call;
  assert.equal(res.isError, true);
  assert.equal((res.structuredContent as Sc).taskStatus, 'cancelled');
});
