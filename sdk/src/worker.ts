import { WebSocket } from 'ws';
import { generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  WorkerConfig,
  DeclareParams,
  PairResult,
  AuthChallengeParams,
  AuthResult,
  SpawnParams,
  ResizeParams,
  OutputParams,
  OutputType,
  StatusPayload,
  ProgressPayload,
  ResultPayload,
  ErrorPayload,
} from './types.js';
import { PROTOCOL_VERSION } from './types.js';

export type SpawnHandler = (params: SpawnParams) => void;
export type KillHandler = () => void;
export type ResizeHandler = (cols: number, rows: number) => void;
export type InputHandler = (data: string) => void;

export interface WorkerEvents {
  onSpawn?: SpawnHandler;
  onKill?: KillHandler;
  onResize?: ResizeHandler;
  onInput?: InputHandler;
}

export interface WorkerClient {
  /** Send a status update for the current task */
  sendStatus: (text: string) => void;
  /** Send a progress update for the current task */
  sendProgress: (current: number, total: number, label?: string) => void;
  /** Send the final result for the current task (marks task complete) */
  sendResult: (markdown: string) => void;
  /** Send an error for the current task (marks task failed) */
  sendError: (message: string) => void;
  /** Send raw binary data (legacy TTY mode) */
  sendRawOutput: (data: Buffer) => void;
  /** Current task ID (set after spawn, null when idle) */
  currentTaskId: string | null;
}

const RECONNECT_DELAY_MS = 5000;

function sendJson(ws: WebSocket, obj: JsonRpcRequest | JsonRpcResponse): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function makeRpc(method: string, params: unknown, id?: number): JsonRpcRequest {
  return { jsonrpc: '2.0', method, params, id };
}

function sendOutput(ws: WebSocket, taskId: string, type: OutputType, payload: StatusPayload | ProgressPayload | ResultPayload | ErrorPayload): void {
  const params: OutputParams = { taskId, type, payload };
  sendJson(ws, makeRpc('output', params));
}

function sendDeclare(ws: WebSocket, config: WorkerConfig): void {
  if (!config.name && config.agents.length === 0) return;
  const params: DeclareParams = {
    name: config.name,
    description: config.description,
    protocolVersion: PROTOCOL_VERSION,
    agents: config.agents,
  };
  sendJson(ws, makeRpc('declare', params, 10));
  console.log(`[sdk] Declared ${config.agents.length} agent(s), protocol v${PROTOCOL_VERSION}`);
}

function saveCredentials(nodeId: string, privateKeyHex: string): void {
  const envPath = join(process.cwd(), '.env');
  let content = '';
  if (existsSync(envPath)) {
    content = readFileSync(envPath, 'utf-8');
  }
  if (/^NODE_ID=.*/m.test(content)) {
    content = content.replace(/^NODE_ID=.*/m, `NODE_ID=${nodeId}`);
  } else {
    content += `\nNODE_ID=${nodeId}`;
  }
  if (/^PRIVATE_KEY_HEX=.*/m.test(content)) {
    content = content.replace(/^PRIVATE_KEY_HEX=.*/m, `PRIVATE_KEY_HEX=${privateKeyHex}`);
  } else {
    content += `\nPRIVATE_KEY_HEX=${privateKeyHex}`;
  }
  writeFileSync(envPath, content.replace(/^\n+/, '') + '\n');
  console.log('[sdk] Credentials saved to .env');
}

export function createWorker(hubUrl: string, config: WorkerConfig, events: WorkerEvents = {}): WorkerClient {
  let pendingPrivateKeyHex: string | null = null;

  const client: WorkerClient = {
    currentTaskId: null,
    sendStatus(text: string) {
      if (client.currentTaskId && currentWs) {
        sendOutput(currentWs, client.currentTaskId, 'status', { text });
      }
    },
    sendProgress(current: number, total: number, label?: string) {
      if (client.currentTaskId && currentWs) {
        sendOutput(currentWs, client.currentTaskId, 'progress', { current, total, label });
      }
    },
    sendResult(markdown: string) {
      if (client.currentTaskId && currentWs) {
        sendOutput(currentWs, client.currentTaskId, 'result', { text: markdown });
      }
    },
    sendError(message: string) {
      if (client.currentTaskId && currentWs) {
        sendOutput(currentWs, client.currentTaskId, 'error', { message });
      }
    },
    sendRawOutput(data: Buffer) {
      if (currentWs?.readyState === WebSocket.OPEN) {
        currentWs.send(data, { binary: true });
      }
    },
  };

  let currentWs: WebSocket | null = null;

  function connect(): void {
    const ws = new WebSocket(hubUrl);
    currentWs = ws;

    ws.on('open', () => {
      console.log(`[sdk] Connected to hub at ${hubUrl}`);
      const nodeId = process.env.NODE_ID;
      const privateKeyHex = process.env.PRIVATE_KEY_HEX;

      if (nodeId && privateKeyHex) {
        sendJson(ws, makeRpc('auth', { nodeId }, 1));
      } else {
        const pairCode = process.env.PAIR_CODE;
        if (!pairCode) {
          console.error('[sdk] PAIR_CODE required when NODE_ID/PRIVATE_KEY_HEX not set');
          ws.close();
          return;
        }
        const { publicKey, privateKey } = generateKeyPairSync('ed25519');
        const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
        const privKeyHex = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex');
        pendingPrivateKeyHex = privKeyHex;
        sendJson(ws, makeRpc('pair', {
          code: pairCode,
          publicKey: publicKeyHex,
          name: config.name,
          description: config.description,
        }, 2));
        console.log('[sdk] Sent pair request, waiting for approval...');
      }
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        events.onInput?.(buf.toString('utf-8'));
        return;
      }

      let msg: JsonRpcRequest | JsonRpcResponse;
      try {
        msg = JSON.parse(data.toString()) as JsonRpcRequest | JsonRpcResponse;
      } catch {
        console.error('[sdk] Invalid JSON from hub');
        return;
      }

      if (!('method' in msg)) {
        const res = msg as JsonRpcResponse;
        if (res.error) {
          console.error('[sdk] RPC error:', res.error.message);
        }
        return;
      }

      const req = msg as JsonRpcRequest;

      switch (req.method) {
        case 'pair_result': {
          const params = req.params as PairResult;
          if (params.success) {
            console.log(`[sdk] Pairing approved! NODE_ID=${params.nodeId}`);
            if (pendingPrivateKeyHex) {
              saveCredentials(params.nodeId, pendingPrivateKeyHex);
              process.env.NODE_ID = params.nodeId;
              process.env.PRIVATE_KEY_HEX = pendingPrivateKeyHex;
              pendingPrivateKeyHex = null;
            }
            sendDeclare(ws, config);
          } else {
            console.error('[sdk] Pairing rejected:', params.error);
            ws.close();
          }
          break;
        }

        case 'auth_challenge': {
          const params = req.params as AuthChallengeParams;
          const nodeId = process.env.NODE_ID!;
          const privateKeyHex = process.env.PRIVATE_KEY_HEX!;
          try {
            const privateKeyBuf = Buffer.from(privateKeyHex, 'hex');
            const challengeBuf = Buffer.from(params.challenge, 'hex');
            const privateKeyObj = { key: privateKeyBuf, format: 'der' as const, type: 'pkcs8' as const };
            const signature = cryptoSign(null, challengeBuf, privateKeyObj).toString('hex');
            sendJson(ws, makeRpc('auth_response', { nodeId, challenge: params.challenge, signature }, 3));
          } catch (err) {
            console.error('[sdk] Failed to sign challenge:', err);
            ws.close();
          }
          break;
        }

        case 'auth_result': {
          const params = req.params as AuthResult;
          if (params.success) {
            console.log('[sdk] Authenticated.');
            sendDeclare(ws, config);
          } else {
            console.error('[sdk] Authentication failed:', params.error);
            ws.close();
          }
          break;
        }

        case 'spawn': {
          const params = req.params as SpawnParams;
          client.currentTaskId = params.taskId ?? null;
          console.log(`[sdk] Spawn: ${params.binary} ${(params.args ?? []).join(' ')}${params.taskId ? ` (task: ${params.taskId})` : ''}`);
          events.onSpawn?.(params);
          break;
        }

        case 'resize': {
          const params = req.params as ResizeParams;
          events.onResize?.(params.cols, params.rows);
          break;
        }

        case 'kill': {
          console.log('[sdk] Kill received');
          client.currentTaskId = null;
          events.onKill?.();
          break;
        }

        default:
          console.log(`[sdk] Unknown method: ${req.method}`);
      }
    });

    ws.on('close', () => {
      console.log('[sdk] Disconnected. Reconnecting in 5s...');
      currentWs = null;
      client.currentTaskId = null;
      events.onKill?.();
      setTimeout(connect, RECONNECT_DELAY_MS);
    });

    ws.on('error', (err) => {
      console.error('[sdk] WebSocket error:', err.message);
    });
  }

  connect();
  return client;
}
