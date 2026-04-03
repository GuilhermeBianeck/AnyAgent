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
  updateNodeName,
  updateNodeDescription,
  deleteAgentsByNodeId,
  upsertAgent,
  upsertSession,
  getSessionByNodeId,
  getSessionByChatId,
  deleteSessionByNodeId,
  getAllSessions,
  touchSession,
  upsertDefaultAgent,
  getDefaultAgentByChatId,
  deleteDefaultAgentByChatId,
  updateTaskStatus,
  getRunningTasksByNodeId,
  getTask,
} from './db.js';
import { escapeHtml } from './format.js';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  PairParams,
  AuthRequestParams,
  AuthResponseParams,
  SpawnParams,
  SpawnResult,
  ExitParams,
  OutputParams,
  PendingPair,
  ActiveSession,
  DeclareParams,
} from './types.js';

interface WorkerSession {
  ws: WebSocket;
  wsId: string;
  nodeId?: string;
  authenticated: boolean;
  challenge?: string;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  pongReceived?: boolean;
}

type TtyCallback = (nodeId: string, data: Buffer) => void;
type StructuredOutputCallback = (nodeId: string, params: OutputParams) => void;
type SessionEndCallback = (nodeId: string, exitCode: number) => void;
type AgentChangeCallback = () => void;
type PairingRequestCallback = (connId: string, workerName: string, workerDesc: string) => void;

const sessions = new Map<string, WorkerSession>();
const nodeMap = new Map<string, string>();
const pendingPairs = new Map<string, PendingPair>();
let ttyOutputCallback: TtyCallback | null = null;
let structuredOutputCallback: StructuredOutputCallback | null = null;
let sessionEndCallback: SessionEndCallback | null = null;
let agentChangeCallback: AgentChangeCallback | null = null;
let pairingRequestCallback: PairingRequestCallback | null = null;

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

const HEARTBEAT_INTERVAL_MS = 30_000;

function startHeartbeat(session: WorkerSession): void {
  if (session.heartbeatTimer) return;
  session.pongReceived = true;
  session.heartbeatTimer = setInterval(() => {
    if (!session.pongReceived) {
      console.log(`[gateway] No pong from ${session.nodeId ?? session.wsId}, terminating`);
      session.ws.terminate();
      return;
    }
    session.pongReceived = false;
    session.ws.ping();
  }, HEARTBEAT_INTERVAL_MS);
}

export function isNodeOnline(nodeId: string): boolean {
  const id = nodeMap.get(nodeId);
  if (!id) return false;
  const session = sessions.get(id);
  return session?.authenticated === true;
}

export function sendSpawn(nodeId: string, binary: string, args: string[] = [], taskId?: string, context?: string): boolean {
  const id = nodeMap.get(nodeId);
  if (!id) return false;
  const session = sessions.get(id);
  if (!session?.authenticated) return false;
  const msg: SpawnParams = { binary, args, taskId, context };
  sendJson(session.ws, makeRpc('spawn', msg));
  return true;
}

export function setActiveSession(nodeId: string, chatId: number, agentName?: string): void {
  const sessionId = `sess_${randomBytes(4).toString('hex')}`;
  upsertSession(sessionId, nodeId, chatId, agentName);
}

export function getActiveSession(nodeId: string): ActiveSession | undefined {
  const row = getSessionByNodeId(nodeId);
  if (!row) return undefined;
  return { nodeId: row.node_id, chatId: row.chat_id, agentName: row.agent_name ?? undefined };
}

export function clearActiveSession(nodeId: string): void {
  deleteSessionByNodeId(nodeId);
}

export function getActiveSessionByChatId(chatId: number): ActiveSession | undefined {
  const row = getSessionByChatId(chatId);
  if (!row) return undefined;
  return { nodeId: row.node_id, chatId: row.chat_id, agentName: row.agent_name ?? undefined };
}

export function sendTtyInput(nodeId: string, data: string): boolean {
  const id = nodeMap.get(nodeId);
  if (!id) return false;
  const session = sessions.get(id);
  if (!session?.authenticated) return false;
  session.ws.send(Buffer.from(data), { binary: true });
  touchSession(nodeId);
  return true;
}

export function setDefaultAgent(chatId: number, agentName: string): void {
  upsertDefaultAgent(chatId, agentName);
}

export function getDefaultAgent(chatId: number): string | undefined {
  return getDefaultAgentByChatId(chatId)?.agent_name;
}

export function clearDefaultAgent(chatId: number): void {
  deleteDefaultAgentByChatId(chatId);
}

export function onTtyOutput(callback: TtyCallback): void {
  ttyOutputCallback = callback;
}

export function onStructuredOutput(callback: StructuredOutputCallback): void {
  structuredOutputCallback = callback;
}

export function onSessionEnd(callback: SessionEndCallback): void {
  sessionEndCallback = callback;
}

export function onAgentChange(callback: AgentChangeCallback): void {
  agentChangeCallback = callback;
}

export function onPairingRequest(callback: PairingRequestCallback): void {
  pairingRequestCallback = callback;
}

export function createGateway(
  port: number,
  bot: Bot | null,
  allowedUserId: number,
  wsSecret?: string
): WebSocketServer {
  const wss = new WebSocketServer({ port, maxPayload: 1_048_576 }); // 1MB max per message

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
        console.warn(`[gateway] Connection rejected: invalid WS_SECRET from ${req.socket.remoteAddress}`);
        ws.close(4401, 'Invalid or missing WS_SECRET');
        return;
      }
    }

    const connId = randomBytes(8).toString('hex');
    const session: WorkerSession = { ws, wsId: connId, authenticated: false };
    sessions.set(connId, session);

    // Pong handler for heartbeat
    ws.on('pong', () => {
      session.pongReceived = true;
    });

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        // Binary frames = TTY data; only accept from authenticated workers
        if (session.authenticated && session.nodeId && ttyOutputCallback) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          ttyOutputCallback(session.nodeId, buf);
          touchSession(session.nodeId);
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
      if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
      if (session.nodeId) {
        const disconnectedNodeId = session.nodeId;
        const active = getActiveSession(disconnectedNodeId);

        // Remove from node map immediately so isNodeOnline returns false
        nodeMap.delete(disconnectedNodeId);
        if (agentChangeCallback) agentChangeCallback();

        if (active) {
          // Grace period: wait 60 seconds for reconnection before marking failed
          bot?.api.sendMessage(active.chatId, `⚠️ Worker disconnected. Waiting 60s for reconnect...`, { parse_mode: 'HTML' }).catch(() => {});
          setTimeout(() => {
            // Check if the node reconnected (new session in nodeMap)
            if (isNodeOnline(disconnectedNodeId)) {
              bot?.api.sendMessage(active.chatId, `✅ Worker reconnected.`, { parse_mode: 'HTML' }).catch(() => {});
              return; // Reconnected — don't fail the task
            }
            // Still offline — clear session and fail tasks
            const stillActive = getActiveSession(disconnectedNodeId);
            if (stillActive) {
              const label = stillActive.agentName ? `Agent <code>${escapeHtml(stillActive.agentName)}</code>` : 'Session';
              bot?.api.sendMessage(stillActive.chatId, `❌ ${label} — worker did not reconnect.`, { parse_mode: 'HTML' }).catch(() => {});
              clearActiveSession(disconnectedNodeId);
              if (sessionEndCallback) sessionEndCallback(disconnectedNodeId, 1);
            }
          }, 60_000);
        }
      }
      sessions.delete(connId);
    });
  });

  // Session timeout checker — clean up abandoned sessions
  const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS ?? '', 10) || 30 * 60 * 1000;
  setInterval(() => {
    const allSessions = getAllSessions();
    const now = Date.now();
    for (const row of allSessions) {
      const lastActivity = new Date(row.last_activity_at + 'Z').getTime();
      if (now - lastActivity > SESSION_TIMEOUT_MS) {
        // Skip timeout if there are actively running tasks on this node
        const running = getRunningTasksByNodeId(row.node_id);
        if (running.length > 0) {
          touchSession(row.node_id); // extend while tasks are running
          continue;
        }
        // Send kill to worker if online
        const wsId = nodeMap.get(row.node_id);
        if (wsId) {
          const workerSession = sessions.get(wsId);
          if (workerSession?.authenticated) {
            sendJson(workerSession.ws, makeRpc('kill', {}));
          }
        }
        // Notify user
        const label = row.agent_name ? `Agent <code>${escapeHtml(row.agent_name)}</code>` : 'Session';
        bot?.api.sendMessage(row.chat_id, `${label} timed out after inactivity.`, { parse_mode: 'HTML' }).catch(() => {});
        clearActiveSession(row.node_id);
        console.log(`[gateway] Session on ${row.node_id} timed out`);
      }
    }
  }, 60_000);

  console.log(`[gateway] WebSocket server listening on port ${port}`);
  return wss;
}

async function handleMessage(
  connId: string,
  session: WorkerSession,
  req: JsonRpcRequest,
  bot: Bot | null,
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
      pendingPairs.set(connId, {
        wsId: connId,
        code: params.code,
        publicKey: params.publicKey,
        name: params.name,
        description: params.description,
      });
      deletePairCode(params.code);
      // Notify management interface(s) about the pairing request
      if (pairingRequestCallback) {
        pairingRequestCallback(connId, params.name ?? '', params.description ?? '');
      } else {
        // No management interface registered — auto-reject
        console.warn('[gateway] Pairing request received but no management interface registered');
        sendJson(session.ws, makeError(req.id, -32002, 'No management interface available'));
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
      // Verify nodeId matches what was set during auth request
      if (params.nodeId !== session.nodeId) {
        sendJson(session.ws, makeError(req.id, -32004, 'NodeId mismatch'));
        return;
      }
      if (!session.challenge || session.challenge !== params.challenge) {
        sendJson(session.ws, makeError(req.id, -32004, 'Challenge mismatch'));
        return;
      }
      const node = getNodeById(params.nodeId);
      if (!node || !node.approved) {
        sendJson(session.ws, makeError(req.id, -32003, 'Unknown or revoked node'));
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
        // Terminate any existing session for this nodeId (prevent dual-session takeover)
        const existingWsId = nodeMap.get(params.nodeId);
        if (existingWsId && existingWsId !== connId) {
          const oldSession = sessions.get(existingWsId);
          if (oldSession) {
            oldSession.authenticated = false;
            oldSession.ws.close(4409, 'Superseded by new connection');
          }
        }
        session.authenticated = true;
        session.challenge = undefined;
        nodeMap.set(params.nodeId, connId);
        startHeartbeat(session);
        sendJson(session.ws, makeResult(req.id, { success: true }));
      } catch (err) {
        console.error('[gateway] Signature verification failed for node', params.nodeId);
        sendJson(session.ws, makeError(req.id, -32005, 'Verification failed'));
      }
      break;
    }

    case 'spawn_result': {
      if (!session.authenticated) return;
      const params = req.params as SpawnResult;
      console.log(`[gateway] spawn_result from node ${session.nodeId}: success=${params.success}`);
      if (!params.success && session.nodeId) {
        const active = getActiveSession(session.nodeId);
        if (active) {
          const label = active.agentName ? `Agent <code>${escapeHtml(active.agentName)}</code>` : 'Process';
          const reason = params.error ? `: ${escapeHtml(params.error)}` : '';
          bot?.api.sendMessage(active.chatId, `❌ ${label} failed to start${reason}`, { parse_mode: 'HTML' }).catch(() => {});
          clearActiveSession(session.nodeId);
        }
      }
      break;
    }

    case 'exit': {
      if (!session.authenticated) return;
      const params = req.params as ExitParams;
      console.log(`[gateway] exit from node ${session.nodeId}: code=${params.code}`);
      if (session.nodeId) {
        const active = getActiveSession(session.nodeId);
        if (active) {
          const label = active.agentName ? `Agent <code>${escapeHtml(active.agentName)}</code>` : 'Session';
          const codeStr = params.code === 0 ? 'normally' : `with code ${params.code}`;
          bot?.api.sendMessage(active.chatId, `${label} exited ${codeStr}.`, { parse_mode: 'HTML' }).catch(() => {});
        }
        // Mark running tasks on this node as complete/failed (legacy TTY agents don't send structured output)
        const runningTasks = getRunningTasksByNodeId(session.nodeId);
        for (const task of runningTasks) {
          if (params.code === 0) {
            updateTaskStatus(task.task_id, 'complete');
          } else {
            updateTaskStatus(task.task_id, 'failed', { error: `Process exited with code ${params.code}` });
          }
        }
        clearActiveSession(session.nodeId);
        // Notify bot to process queued tasks
        if (sessionEndCallback) sessionEndCallback(session.nodeId, params.code);
      }
      break;
    }

    case 'output': {
      if (!session.authenticated || !session.nodeId) return;
      const params = req.params as OutputParams;
      // Validate required fields
      if (!params?.taskId || !params?.type || !params?.payload) {
        console.warn('[gateway] Malformed output message, ignoring');
        break;
      }
      // Verify this worker owns the task (prevent cross-worker spoofing)
      const taskForOutput = getTask(params.taskId);
      if (taskForOutput && taskForOutput.node_id !== session.nodeId) {
        console.warn(`[gateway] Node ${session.nodeId} sent output for task owned by ${taskForOutput.node_id}, ignoring`);
        break;
      }
      // Update task status based on output type
      if (params.type === 'result') {
        const payload = params.payload as { text?: string };
        updateTaskStatus(params.taskId, 'complete', { result_summary: payload.text ?? '' });
      } else if (params.type === 'error') {
        const payload = params.payload as { message?: string };
        updateTaskStatus(params.taskId, 'failed', { error: payload.message ?? 'Unknown error' });
      }
      // Forward to callback (bot.ts will render to Telegram)
      if (structuredOutputCallback) {
        structuredOutputCallback(session.nodeId, params);
      }
      // Clear session and process queue on terminal output types
      if (params.type === 'result' || params.type === 'error') {
        clearActiveSession(session.nodeId);
        if (sessionEndCallback) sessionEndCallback(session.nodeId, params.type === 'result' ? 0 : 1);
      }
      break;
    }

    case 'declare': {
      if (!session.authenticated || !session.nodeId) {
        sendJson(session.ws, makeError(req.id, -32006, 'Not authenticated'));
        return;
      }
      const MAX_AGENTS_PER_NODE = 50;
      const params = req.params as DeclareParams;
      if ((params.agents?.length ?? 0) > MAX_AGENTS_PER_NODE) {
        sendJson(session.ws, makeError(req.id, -32602, `Too many agents (max ${MAX_AGENTS_PER_NODE})`));
        return;
      }
      if (params.name) updateNodeName(session.nodeId, params.name);
      if (params.description) updateNodeDescription(session.nodeId, params.description);
      // Replace all agents for this node only — namespaced by node_id
      deleteAgentsByNodeId(session.nodeId);
      for (const agent of params.agents ?? []) {
        upsertAgent(agent.name, session.nodeId, agent.binary, agent.args ?? [], agent.description, agent.capabilities, agent.contextAware);
      }
      const pv = params.protocolVersion ?? 1;
      console.log(`[gateway] Node ${session.nodeId} declared ${params.agents?.length ?? 0} agent(s), protocol v${pv}`);
      sendJson(session.ws, makeResult(req.id, { success: true }));
      if (agentChangeCallback) agentChangeCallback();
      break;
    }

    default:
      sendJson(session.ws, makeError(req.id, -32601, 'Method not found'));
  }
}

export function approvePair(connId: string): string | null {
  const pending = pendingPairs.get(connId);
  if (!pending) return null;
  pendingPairs.delete(connId);
  const nodeId = `node_${randomBytes(4).toString('hex')}`;
  insertNode(nodeId, pending.publicKey, pending.name, pending.description);
  const session = sessions.get(connId);
  if (session) {
    session.nodeId = nodeId;
    session.authenticated = true;
    nodeMap.set(nodeId, connId);
    startHeartbeat(session);
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
