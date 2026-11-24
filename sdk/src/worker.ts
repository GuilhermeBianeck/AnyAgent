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
  /** Notify hub that the spawned process exited */
  sendExit: (code: number) => void;
  /** Notify hub of spawn success/failure */
  sendSpawnResult: (success: boolean, pid?: number, error?: string) => void;
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

const NODE_ID_RE = /^node_[a-f0-9]+$/;

function saveCredentials(nodeId: string, privateKeyHex: string): void {
  // Validate nodeId to prevent .env injection via newlines or special chars
  if (!NODE_ID_RE.test(nodeId)) {
    console.error('[sdk] Invalid nodeId format, refusing to save:', nodeId.slice(0, 20));
    return;
  }
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
  writeFileSync(envPath, content.replace(/^\n+/, '') + '\n', { mode: 0o600 });
  console.log('[sdk] Credentials saved to .env (permissions: owner-only)');
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
    sendExit(code: number) {
      if (currentWs) {
        sendJson(currentWs, makeRpc('exit', { code }));
      }
      client.currentTaskId = null;
    },
    sendSpawnResult(success: boolean, pid?: number, error?: string) {
      if (currentWs) {
        sendJson(currentWs, makeRpc('spawn_result', { success, pid, error }));
      }
    },
  };

  let currentWs: WebSocket | null = null;

  function connect(): void {
    const headers: Record<string, string> = {};
    const wsSecret = process.env.WS_SECRET;
    if (wsSecret) {
      headers['x-ws-secret'] = wsSecret;
    }
    const ws = new WebSocket(hubUrl, { headers });
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
        // JSON-RPC response (not a request with a method)
        const res = msg as JsonRpcResponse;
        if (res.error) {
          console.error('[sdk] RPC error:', res.error.message);
        } else if (res.id === 3 && res.result) {
          // Response to auth_response (id=3) — handle auth success/failure
          const result = res.result as AuthResult;
          if (result.success) {
            console.log('[sdk] Authenticated.');
            sendDeclare(ws, config);
          } else {
            console.error('[sdk] Auth failed:', result.error);
            ws.close();
          }
        } else if (res.id === 10 && res.result) {
          // Response to declare (id=10). Newer hubs report agents they rejected
          // or sanitized; surface that here so the worker operator sees it.
          const result = res.result as {
            accepted?: string[];
            rejected?: Array<{ name: string; reason: string }>;
            sanitized?: Array<{ name: string; fields: string[] }>;
            pendingReview?: string[];
          };
          for (const r of result.rejected ?? []) {
            console.error(`[sdk] Hub rejected agent "${r.name}": ${r.reason}`);
          }
          for (const s of result.sanitized ?? []) {
            console.warn(`[sdk] Hub sanitized ${s.fields.join(', ')} of agent "${s.name}"`);
          }
          for (const name of result.pendingReview ?? []) {
            console.warn(`[sdk] Agent "${name}" changed since the hub last approved it — hidden until the hub operator runs "review"`);
          }
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
            // Clear PAIR_CODE to prevent infinite retry with consumed code
            delete process.env.PAIR_CODE;
            console.error('[sdk] NOT retrying (pairing was rejected). Get a new code and restart.');
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
            console.error('[sdk] Failed to sign challenge:', err instanceof Error ? err.message : 'unknown error');
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

    ws.on('close', (code: number, reason: Buffer) => {
      currentWs = null;
      client.currentTaskId = null;
      events.onKill?.();

      if (code === 4401) {
        console.error('[sdk] Connection rejected: WS_SECRET mismatch. Check WS_SECRET env var on this worker.');
        console.error('[sdk] NOT retrying (fix WS_SECRET and restart).');
        return; // Do not retry — wrong secret will fail forever
      }

      // Don't retry if pairing was rejected (code consumed, no point retrying)
      if (!process.env.NODE_ID && !process.env.PAIR_CODE) {
        console.error('[sdk] No credentials and no pair code. Cannot reconnect. Restart with a new PAIR_CODE.');
        return;
      }

      if (code === 1000) {
        console.log('[sdk] Disconnected normally.');
      } else {
        const reasonStr = reason.toString() || 'unknown';
        console.log(`[sdk] Disconnected (code=${code}, reason=${reasonStr}). Reconnecting in 5s...`);
      }
      setTimeout(connect, RECONNECT_DELAY_MS);
    });

    ws.on('error', (err) => {
      console.error('[sdk] WebSocket error:', err.message);
    });
  }

  connect();
  return client;
}
