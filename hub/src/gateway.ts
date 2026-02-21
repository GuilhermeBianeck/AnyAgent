import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { randomBytes, verify as cryptoVerify, timingSafeEqual } from 'crypto';
import { Bot } from 'grammy';
import {
  getPairCode,
  deletePairCode,
  deleteExpiredPairCodes,
  insertNode,
  getNodeById,
} from './db.js';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  PairParams,
  AuthRequestParams,
  AuthResponseParams,
  SpawnParams,
  PendingPair,
  ActiveSession,
} from './types.js';

interface WorkerSession {
  ws: WebSocket;
  wsId: string;
  nodeId?: string;
  authenticated: boolean;
  challenge?: string;
}

type TtyCallback = (nodeId: string, data: Buffer) => void;

const sessions = new Map<string, WorkerSession>();
const nodeMap = new Map<string, string>();
const pendingPairs = new Map<string, PendingPair>();
const activeSessions = new Map<string, ActiveSession>(); // nodeId → ActiveSession
let ttyOutputCallback: TtyCallback | null = null;

function sendJson(ws: WebSocket, obj: JsonRpcResponse | JsonRpcRequest): void {
  ws.send(JSON.stringify(obj));
}

function makeRpc(method: string, params: unknown): JsonRpcRequest {
  return { jsonrpc: '2.0', method, params };
}

function makeResult(id: string | number | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function makeError(id: string | number | undefined, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function isNodeOnline(nodeId: string): boolean {
  const id = nodeMap.get(nodeId);
  if (!id) return false;
  const session = sessions.get(id);
  return session?.authenticated === true;
}

export function sendSpawn(nodeId: string, binary: string, args: string[] = []): boolean {
  const id = nodeMap.get(nodeId);
  if (!id) return false;
  const session = sessions.get(id);
  if (!session?.authenticated) return false;
  const msg: SpawnParams = { binary, args };
  sendJson(session.ws, makeRpc('spawn', msg));
  return true;
}

export function setActiveSession(nodeId: string, chatId: number, agentName?: string): void {
  activeSessions.set(nodeId, { nodeId, chatId, agentName });
}

export function getActiveSession(nodeId: string): ActiveSession | undefined {
  return activeSessions.get(nodeId);
}

export function clearActiveSession(nodeId: string): void {
  activeSessions.delete(nodeId);
}

export function getActiveSessionByChatId(chatId: number): ActiveSession | undefined {
  for (const session of activeSessions.values()) {
    if (session.chatId === chatId) return session;
  }
  return undefined;
}

export function sendTtyInput(nodeId: string, data: string): boolean {
  const id = nodeMap.get(nodeId);
  if (!id) return false;
  const session = sessions.get(id);
  if (!session?.authenticated) return false;
  session.ws.send(Buffer.from(data), { binary: true });
  return true;
}

export function onTtyOutput(callback: TtyCallback): void {
  ttyOutputCallback = callback;
}

export function createGateway(
  port: number,
  bot: Bot,
  allowedUserId: number,
  wsSecret?: string
): WebSocketServer {
  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    if (wsSecret) {
      const token = req.headers['x-ws-secret'];
      const tokenStr = Array.isArray(token) ? token[0] : token;
      const secretBuf = Buffer.from(wsSecret);
      const tokenBuf = Buffer.from(tokenStr ?? '');
      const valid =
        tokenBuf.length === secretBuf.length &&
        timingSafeEqual(tokenBuf, secretBuf);
      if (!valid) {
        ws.close(4401, 'Unauthorized');
        return;
      }
    }

    const connId = randomBytes(8).toString('hex');
    const session: WorkerSession = { ws, wsId: connId, authenticated: false };
    sessions.set(connId, session);

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        // Binary frames = TTY data; forward to registered callback
        if (session.nodeId && ttyOutputCallback) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          ttyOutputCallback(session.nodeId, buf);
        }
        return;
      }
      let rpcReq: JsonRpcRequest;
      try {
        rpcReq = JSON.parse(data.toString()) as JsonRpcRequest;
      } catch {
        ws.send(JSON.stringify(makeError(undefined, -32700, 'Parse error')));
        return;
      }
      await handleMessage(connId, session, rpcReq, bot, allowedUserId);
    });

    ws.on('close', () => {
      if (session.nodeId) nodeMap.delete(session.nodeId);
      sessions.delete(connId);
    });
  });

  console.log(`[gateway] WebSocket server listening on port ${port}`);
  return wss;
}

async function handleMessage(
  connId: string,
  session: WorkerSession,
  req: JsonRpcRequest,
  bot: Bot,
  allowedUserId: number
): Promise<void> {
  deleteExpiredPairCodes();

  switch (req.method) {
    case 'pair': {
      const params = req.params as PairParams;
      if (!params?.code || !params?.publicKey) {
        sendJson(session.ws, makeError(req.id, -32602, 'Invalid params'));
        return;
      }
      const codeRow = getPairCode(params.code);
      if (!codeRow || new Date(codeRow.expires_at) < new Date()) {
        if (codeRow) deletePairCode(params.code);
        sendJson(session.ws, makeError(req.id, -32001, 'Invalid or expired pairing code'));
        return;
      }
      pendingPairs.set(connId, { wsId: connId, code: params.code, publicKey: params.publicKey });
      deletePairCode(params.code);
      try {
        await bot.api.sendMessage(
          allowedUserId,
          `🔗 New worker wants to pair.\nPublic Key: <code>${params.publicKey.slice(0, 16).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}...</code>\nApprove?`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Approve', callback_data: `approve:${connId}` },
                { text: '❌ Reject', callback_data: `reject:${connId}` },
              ]],
            },
          }
        );
      } catch (err) {
        console.error('[gateway] Failed to send Telegram approval:', err);
        sendJson(session.ws, makeError(req.id, -32002, 'Failed to send approval request'));
        pendingPairs.delete(connId);
      }
      break;
    }

    case 'auth': {
      const params = req.params as AuthRequestParams;
      if (!params?.nodeId) {
        sendJson(session.ws, makeError(req.id, -32602, 'Invalid params'));
        return;
      }
      const node = getNodeById(params.nodeId);
      if (!node) {
        sendJson(session.ws, makeError(req.id, -32003, 'Unknown node'));
        return;
      }
      const challenge = randomBytes(32).toString('hex');
      session.challenge = challenge;
      session.nodeId = params.nodeId;
      sendJson(session.ws, makeRpc('auth_challenge', { challenge }));
      break;
    }

    case 'auth_response': {
      const params = req.params as AuthResponseParams;
      if (!params?.nodeId || !params?.challenge || !params?.signature) {
        sendJson(session.ws, makeError(req.id, -32602, 'Invalid params'));
        return;
      }
      if (!session.challenge || session.challenge !== params.challenge) {
        sendJson(session.ws, makeError(req.id, -32004, 'Challenge mismatch'));
        return;
      }
      const node = getNodeById(params.nodeId);
      if (!node) {
        sendJson(session.ws, makeError(req.id, -32003, 'Unknown node'));
        return;
      }
      try {
        const publicKeyBuf = Buffer.from(node.public_key, 'hex');
        const signatureBuf = Buffer.from(params.signature, 'hex');
        const challengeBuf = Buffer.from(params.challenge, 'hex');
        const valid = cryptoVerify(
          null,
          challengeBuf,
          { key: publicKeyBuf, format: 'der', type: 'spki' },
          signatureBuf
        );
        if (!valid) {
          sendJson(session.ws, makeResult(req.id, { success: false, error: 'Invalid signature' }));
          return;
        }
        session.authenticated = true;
        session.challenge = undefined;
        nodeMap.set(params.nodeId, connId);
        sendJson(session.ws, makeResult(req.id, { success: true }));
      } catch (err) {
        console.error('[gateway] Signature verification error:', err);
        sendJson(session.ws, makeError(req.id, -32005, 'Verification failed'));
      }
      break;
    }

    case 'spawn_result':
      console.log(`[gateway] Received ${req.method} from node ${session.nodeId}:`, req.params);
      break;

    case 'exit':
      console.log(`[gateway] Received ${req.method} from node ${session.nodeId}:`, req.params);
      if (session.nodeId) {
        activeSessions.delete(session.nodeId);
      }
      break;

    default:
      sendJson(session.ws, makeError(req.id, -32601, 'Method not found'));
  }
}

export function approvePair(connId: string): string | null {
  const pending = pendingPairs.get(connId);
  if (!pending) return null;
  pendingPairs.delete(connId);
  const nodeId = `node_${randomBytes(4).toString('hex')}`;
  insertNode(nodeId, pending.publicKey);
  const session = sessions.get(connId);
  if (session) {
    session.nodeId = nodeId;
    session.authenticated = true;
    nodeMap.set(nodeId, connId);
    sendJson(session.ws, makeRpc('pair_result', { nodeId, success: true }));
  }
  return nodeId;
}

export function rejectPair(connId: string): void {
  const pending = pendingPairs.get(connId);
  if (!pending) return;
  pendingPairs.delete(connId);
  const session = sessions.get(connId);
  if (session) {
    sendJson(session.ws, makeRpc('pair_result', { success: false, error: 'Rejected by admin' }));
    session.ws.close();
  }
}
