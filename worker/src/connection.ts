import { WebSocket } from 'ws';
import { generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { spawnTerminal, TerminalSession } from './terminal.js';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  PairResult,
  AuthChallengeParams,
  AuthResultParams,
  SpawnParams,
  ResizeParams,
  ExitParams,
} from './types.js';

// Module-level terminal session so resize handler can access it
let activeTerminal: TerminalSession | null = null;
// Store private key hex for use during pairing flow
let pendingPrivateKeyHex: string | null = null;

function sendJson(ws: WebSocket, obj: JsonRpcRequest | JsonRpcResponse): void {
  ws.send(JSON.stringify(obj));
}

function makeRpc(method: string, params: unknown, id?: number): JsonRpcRequest {
  return { jsonrpc: '2.0', method, params, id };
}

export function connect(hubUrl: string): void {
  const ws = new WebSocket(hubUrl);

  ws.on('open', () => {
    console.log(`[worker] Connected to hub at ${hubUrl}`);
    const nodeId = process.env.NODE_ID;
    const privateKeyHex = process.env.PRIVATE_KEY_HEX;

    if (nodeId && privateKeyHex) {
      // Auth flow: request a challenge
      sendJson(ws, makeRpc('auth', { nodeId }, 1));
    } else {
      // Pair flow: generate keys and send pair request
      const pairCode = process.env.PAIR_CODE;
      if (!pairCode) {
        console.error('[worker] PAIR_CODE env var required when NODE_ID/PRIVATE_KEY_HEX not set');
        ws.close();
        return;
      }
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
      const privKeyHex = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex');
      pendingPrivateKeyHex = privKeyHex;
      sendJson(ws, makeRpc('pair', { code: pairCode, publicKey: publicKeyHex }, 2));
      console.log('[worker] Sent pair request, waiting for approval...');
    }
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Binary frame = TTY input from hub → write to active terminal
      if (activeTerminal) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        activeTerminal.write(buf.toString('utf-8'));
      }
      return;
    }

    let msg: JsonRpcRequest | JsonRpcResponse;
    try {
      msg = JSON.parse(data.toString()) as JsonRpcRequest | JsonRpcResponse;
    } catch {
      console.error('[worker] Invalid JSON from hub');
      return;
    }

    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    console.log('[worker] Disconnected from hub. Reconnecting in 5s...');
    if (activeTerminal) {
      activeTerminal.kill();
      activeTerminal = null;
    }
    setTimeout(() => connect(hubUrl), 5000);
  });

  ws.on('error', (err) => {
    console.error('[worker] WebSocket error:', err.message);
  });
}

function handleMessage(
  ws: WebSocket,
  msg: JsonRpcRequest | JsonRpcResponse
): void {
  // Distinguish request vs response by checking for 'method' property
  if (!('method' in msg)) {
    // It's a response
    const res = msg as JsonRpcResponse;
    if (res.error) {
      console.error('[worker] RPC error from hub:', res.error.message);
    }
    return;
  }

  const req = msg as JsonRpcRequest;

  switch (req.method) {
    case 'pair_result': {
      const params = req.params as PairResult;
      if (params.success) {
        console.log('\n✅ Pairing approved!');
        console.log(`NODE_ID=${params.nodeId}`);
        console.log(`PRIVATE_KEY_HEX=${pendingPrivateKeyHex ?? ''}`);
        console.log('\nSave these to your .env file. Waiting for commands...\n');
        pendingPrivateKeyHex = null;
      } else {
        console.error('[worker] Pairing rejected:', params.error);
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
        console.error('[worker] Failed to sign challenge:', err);
        ws.close();
      }
      break;
    }

    case 'auth_result': {
      const params = req.params as AuthResultParams;
      if (params.success) {
        console.log('[worker] Authenticated successfully. Waiting for spawn commands...');
      } else {
        console.error('[worker] Authentication failed:', params.error);
        ws.close();
      }
      break;
    }

    case 'spawn': {
      const params = req.params as SpawnParams;
      console.log(`[worker] Spawning: ${params.binary} ${(params.args ?? []).join(' ')}`);
      try {
        const session = spawnTerminal(
          params.binary,
          params.args ?? [],
          ws,
          (code) => {
            sendJson(ws, makeRpc('exit', { code } as ExitParams));
            activeTerminal = null;
          }
        );
        activeTerminal = session;
        sendJson(ws, makeRpc('spawn_result', { success: true, pid: session.pid }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(ws, makeRpc('spawn_result', { success: false, error: message }));
      }
      break;
    }

    case 'resize': {
      const params = req.params as ResizeParams;
      if (activeTerminal) {
        activeTerminal.resize(params.cols, params.rows);
      }
      break;
    }

    default:
      console.log(`[worker] Unknown method: ${req.method}`);
  }
}
