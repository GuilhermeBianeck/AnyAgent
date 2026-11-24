/**
 * A scripted worker that pairs with the real gateway over WebSocket, so tests
 * can exercise online-agent paths (routing, spawning, structured output,
 * cancellation) end to end without node-pty or a real CLI.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocket, type WebSocketServer } from 'ws';
import { createGateway } from '../../src/gateway.js';
import { insertPairCode } from '../../src/db.js';

export interface Gateway {
  port: number;
  close(): Promise<void>;
}

export async function startGateway(): Promise<Gateway> {
  const wss: WebSocketServer = createGateway(0, null, 0);
  await new Promise<void>(r => (wss.address() ? r() : wss.once('listening', () => r())));
  const { port } = wss.address() as AddressInfo;
  return {
    port,
    close: () => new Promise<void>(r => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => r());
    }),
  };
}

export interface SpawnRequest {
  binary: string;
  args?: string[];
  taskId?: string;
  context?: string;
}

export interface FakeWorker {
  nodeId: string;
  spawns: SpawnRequest[];
  kills: number;
  /** Resolves with the next spawn request (or the oldest unconsumed one). */
  nextSpawn(): Promise<SpawnRequest>;
  output(taskId: string, type: 'status' | 'progress' | 'result' | 'error', payload: Record<string, unknown>): void;
  exit(code: number): void;
  close(): Promise<void>;
}

export async function connectWorker(
  gw: Gateway,
  name: string,
  agents: Array<{ name: string; binary: string; args?: string[]; description?: string; capabilities?: string[] }>,
): Promise<FakeWorker> {
  process.env.AUTO_APPROVE_LOOPBACK = '1';
  const code = randomBytes(8).toString('hex').toUpperCase();
  insertPairCode(code, new Date(Date.now() + 60_000), '');
  const { publicKey } = generateKeyPairSync('ed25519');
  const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');

  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}`);
  const send = (obj: object) => ws.send(JSON.stringify({ jsonrpc: '2.0', ...obj }));
  const spawns: SpawnRequest[] = [];
  let consumed = 0;
  const spawnWaiters: Array<(s: SpawnRequest) => void> = [];

  const worker: FakeWorker = {
    nodeId: '',
    spawns,
    kills: 0,
    nextSpawn() {
      if (consumed < spawns.length) return Promise.resolve(spawns[consumed++]);
      return new Promise(resolve => spawnWaiters.push(s => { consumed++; resolve(s); }));
    },
    output(taskId, type, payload) { send({ method: 'output', params: { taskId, type, payload } }); },
    exit(code) { send({ method: 'exit', params: { code } }); },
    close: () => new Promise<void>(r => { ws.once('close', () => r()); ws.close(); }),
  };

  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => send({ method: 'pair', id: 1, params: { code, publicKey: publicKeyHex, name } }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'pair_result') {
        if (!msg.params?.success) return reject(new Error(`pairing failed: ${msg.params?.error}`));
        worker.nodeId = msg.params.nodeId;
        send({ method: 'declare', id: 10, params: { name, description: '', protocolVersion: 2, agents } });
      } else if (msg.id === 10) {
        if (msg.error) return reject(new Error(msg.error.message));
        resolve();
      } else if (msg.method === 'spawn') {
        spawns.push(msg.params);
        const waiter = spawnWaiters.shift();
        if (waiter) waiter(msg.params);
      } else if (msg.method === 'kill') {
        worker.kills++;
      } else if (msg.error) {
        reject(new Error(msg.error.message));
      }
    });
  });
  return worker;
}
