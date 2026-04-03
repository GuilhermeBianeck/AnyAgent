import { Bot, Context } from 'grammy';
import { randomBytes } from 'crypto';
import {
  insertPairCode, getAllNodes, getAgentByName, getAllAgents,
  insertTask, updateTaskStatus, getRecentTasksByChatId, getTask,
  getQueuedTasksByNodeId, getRunningTasksByNodeId,
  purgeTasksByChatId, revokeNode,
  getApprovalMode, setApprovalMode, isAgentTrusted, setAgentTrusted,
} from './db.js';
import {
  isNodeOnline,
  sendSpawn,
  approvePair,
  rejectPair,
  onTtyOutput,
  onStructuredOutput,
  onSessionEnd,
  setActiveSession,
  getActiveSession,
  getActiveSessionByChatId,
  clearActiveSession,
  sendTtyInput,
  setDefaultAgent,
  getDefaultAgent,
  clearDefaultAgent,
} from './gateway.js';
import { escapeHtml } from './format.js';
import { stripAnsi } from './output.js';
import { getContext, setContext, appendContext, clearContext, buildSpawnContext } from './context.js';
import type { AgentRow, OutputParams, TaskStatus } from './types.js';

const MAX_QUEUE_DEPTH = parseInt(process.env.MAX_QUEUE_DEPTH ?? '3', 10);

function guardUser(ctx: Context, allowedUserId: number): boolean {
  if (ctx.from?.id !== allowedUserId) {
    ctx.reply('⛔ Unauthorized').catch(() => {});
    return false;
  }
  return true;
}

function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks.length > 0 ? chunks : [''];
}

async function sendHtml(ctx: Context, html: string, extra: Record<string, unknown> = {}): Promise<void> {
  try {
    await ctx.reply(html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  } catch {
    let plain = html;
    let prev: string;
    do {
      prev = plain;
      plain = plain.replace(/<[^>]*>/g, '');
    } while (plain !== prev);
    await ctx.reply(plain);
  }
}

async function sendHtmlDirect(bot: Bot, chatId: number, html: string, extra: Record<string, unknown> = {}): Promise<number | undefined> {
  try {
    const msg = await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', ...extra });
    return msg.message_id;
  } catch {
    return undefined;
  }
}

// --- Capability-based routing (P0-5) ---
function findAgentByCapability(intent: string): { agent: AgentRow; method: 'default' | 'single' | 'matched' } | { agents: AgentRow[]; method: 'ambiguous' } | null {
  const agents = getAllAgents();
  const onlineAgents = agents.filter(a => isNodeOnline(a.node_id));
  if (onlineAgents.length === 0) return null;
  if (onlineAgents.length === 1) return { agent: onlineAgents[0], method: 'single' };

  const intentWords = intent.toLowerCase().split(/\s+/);
  const scored: Array<{ agent: AgentRow; score: number }> = [];

  for (const agent of onlineAgents) {
    const capabilities: string[] = JSON.parse(agent.capabilities || '[]');
    let score = 0;
    for (const cap of capabilities) {
      const capLower = cap.toLowerCase();
      for (const word of intentWords) {
        if (word.length >= 3 && (word.includes(capLower) || capLower.includes(word))) {
          score++;
        }
      }
    }
    scored.push({ agent, score });
  }

  scored.sort((a, b) => b.score - a.score);
  if (scored[0].score > 0 && (scored.length === 1 || scored[0].score > scored[1].score)) {
    return { agent: scored[0].agent, method: 'matched' };
  }

  // Ambiguous or no match — return all online for user selection
  return { agents: onlineAgents, method: 'ambiguous' };
}

// --- Task-aware agent start ---
function createTaskId(): string {
  return `task_${randomBytes(6).toString('hex')}`;
}

async function startAgentForTask(
  bot: Bot,
  chatId: number,
  agent: AgentRow,
  taskId: string,
  intent: string,
  routingMethod: 'default' | 'single' | 'matched' | 'explicit' | 'user_selected'
): Promise<boolean> {
  if (!isNodeOnline(agent.node_id)) {
    updateTaskStatus(taskId, 'failed', { error: 'Worker offline', agent_name: agent.name, node_id: agent.node_id, routing_method: routingMethod });
    await sendHtmlDirect(bot, chatId, `❌ Agent <code>${escapeHtml(agent.name)}</code> — worker is offline.`);
    return false;
  }

  // Approval gate — check if this task needs human approval before spawning
  // Skip if task was already approved (status reset to 'submitted' by approval callback)
  const currentTask = getTask(taskId);
  const wasAlreadyApproved = currentTask?.status === 'submitted' && currentTask?.routing_method !== null;
  const approvalMode = getApprovalMode(chatId);
  const needsApproval =
    !wasAlreadyApproved &&
    ((approvalMode === 'always') ||
     (approvalMode === 'mcp' && routingMethod !== 'explicit' && routingMethod !== 'default'));
  if (needsApproval && !isAgentTrusted(agent.name)) {
    updateTaskStatus(taskId, 'pending_approval', { agent_name: agent.name, node_id: agent.node_id, routing_method: routingMethod });
    const intentPreview = intent.length > 80 ? intent.slice(0, 80) + '...' : intent;
    await sendHtmlDirect(bot, chatId,
      `📋 <b>Task approval required</b>\n<i>${escapeHtml(intentPreview)}</i>\n→ <code>${escapeHtml(agent.name)}</code>`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Approve', callback_data: `taskapprove:${taskId}` }],
            [{ text: '🔓 Always Allow Agent', callback_data: `tasttrust:${taskId}` }],
            [{ text: '❌ Deny', callback_data: `taskdeny:${taskId}` }],
          ],
        },
      });
    // Auto-deny after 5 minutes
    setTimeout(() => {
      const t = getTask(taskId);
      if (t && t.status === 'pending_approval') {
        updateTaskStatus(taskId, 'failed', { error: 'Approval timed out' });
      }
    }, 5 * 60 * 1000);
    return true; // Task created, waiting for approval
  }

  // Check queue (P0-6)
  const existingSession = getActiveSession(agent.node_id);
  if (existingSession) {
    const queued = getQueuedTasksByNodeId(agent.node_id);
    if (queued.length >= MAX_QUEUE_DEPTH) {
      updateTaskStatus(taskId, 'failed', { error: `Queue full (${MAX_QUEUE_DEPTH})`, agent_name: agent.name, node_id: agent.node_id, routing_method: routingMethod });
      await sendHtmlDirect(bot, chatId, `❌ Agent <code>${escapeHtml(agent.name)}</code> is busy and queue is full (${MAX_QUEUE_DEPTH}). Try again later.`);
      return false;
    }
    updateTaskStatus(taskId, 'queued', { agent_name: agent.name, node_id: agent.node_id, routing_method: routingMethod });
    const position = queued.length + 1;
    await sendHtmlDirect(bot, chatId, `⏳ Agent <code>${escapeHtml(agent.name)}</code> is busy. Task queued (position #${position}).`, {
      reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `cancel:${taskId}` }]] },
    });
    return true; // Queued, will start later
  }

  const agentArgs: string[] = JSON.parse(agent.args_json);
  // Build full context for context-aware agents
  const isContextAware = agent.context_aware !== 0;
  const spawnContext = isContextAware ? buildSpawnContext(chatId, intent) : intent;
  const ok = sendSpawn(agent.node_id, agent.binary, agentArgs, taskId, spawnContext);
  if (!ok) {
    updateTaskStatus(taskId, 'failed', { error: 'Failed to spawn', agent_name: agent.name, node_id: agent.node_id, routing_method: routingMethod });
    await sendHtmlDirect(bot, chatId, `❌ Failed to spawn agent <code>${escapeHtml(agent.name)}</code>.`, {
      reply_markup: { inline_keyboard: [[{ text: '🔄 Retry', callback_data: `retry:${taskId}` }]] },
    });
    return false;
  }

  setActiveSession(agent.node_id, chatId, agent.name);
  updateTaskStatus(taskId, 'running', { agent_name: agent.name, node_id: agent.node_id, routing_method: routingMethod });
  await sendHtmlDirect(bot, chatId, `✅ <code>${escapeHtml(agent.name)}</code> started. Send messages to interact. /stop to end.`);
  return true;
}

// --- Process next queued task for a node ---
// Iterative (not recursive) queue processing — prevents stack overflow
async function processNextQueued(bot: Bot, nodeId: string): Promise<void> {
  while (true) {
    const queued = getQueuedTasksByNodeId(nodeId);
    if (queued.length === 0) return;

    const next = queued[0];
    const agent = next.agent_name ? getAgentByName(next.agent_name) : undefined;
    if (!agent || !next.chat_id) {
      updateTaskStatus(next.task_id, 'failed', { error: 'Agent no longer available' });
      continue; // try next
    }

    const agentArgs: string[] = JSON.parse(agent.args_json);
    const ok = sendSpawn(agent.node_id, agent.binary, agentArgs, next.task_id, next.intent);
    if (!ok) {
      updateTaskStatus(next.task_id, 'failed', { error: 'Failed to spawn from queue' });
      await sendHtmlDirect(bot, next.chat_id, `❌ Queued task failed to start on <code>${escapeHtml(agent.name)}</code>.`, {
        reply_markup: { inline_keyboard: [[{ text: '🔄 Retry', callback_data: `retry:${next.task_id}` }]] },
      });
      continue; // try next
    }

    setActiveSession(agent.node_id, next.chat_id, agent.name);
    updateTaskStatus(next.task_id, 'running');
    await sendHtmlDirect(bot, next.chat_id, `▶️ Queued task started on <code>${escapeHtml(agent.name)}</code>.`);
    return; // successfully started one task, stop
  }
}

// --- Status emoji helper ---
function statusEmoji(status: TaskStatus): string {
  switch (status) {
    case 'submitted': return '📝';
    case 'queued': return '⏳';
    case 'routed': return '🔀';
    case 'running': return '🔄';
    case 'complete': return '✅';
    case 'failed': return '❌';
    case 'timeout': return '⏰';
    default: return '❓';
  }
}

export interface BotConfig {
  wsPort: number;
  wsSecret?: string;
  mcpPort: number;
  mcpToken?: string;
}

export function createBot(token: string, allowedUserId: number, config?: BotConfig): Bot {
  const bot = new Bot(token);

  // --- TTY output buffering (legacy, edit-in-place) ---
  interface OutputBuffer {
    text: string;
    messageId?: number;
  }
  const outputBuffers = new Map<number, OutputBuffer>();
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  function startFlushing(): void {
    if (flushTimer) return;
    flushTimer = setInterval(async () => {
      for (const [chatId, buf] of outputBuffers) {
        if (!buf.text) continue;
        const raw = buf.text;
        buf.text = '';
        const cleaned = stripAnsi(raw);
        if (!cleaned.trim()) continue;

        const escaped = escapeHtml(cleaned);
        const html = `<pre>${escaped}</pre>`;

        if (buf.messageId && html.length <= 4000) {
          try {
            await bot.api.editMessageText(chatId, buf.messageId, html, { parse_mode: 'HTML' });
            continue;
          } catch {
            buf.messageId = undefined;
          }
        }

        const chunks = splitMessage(escaped, 3900);
        for (const chunk of chunks) {
          try {
            const sent = await bot.api.sendMessage(chatId, `<pre>${chunk}</pre>`, { parse_mode: 'HTML' });
            buf.messageId = sent.message_id;
          } catch (err) {
            console.error('[bot] Failed to send TTY output:', err);
          }
        }
      }
    }, 1000);
  }

  function appendOutput(chatId: number, data: string): void {
    const buf = outputBuffers.get(chatId);
    if (buf) {
      buf.text += data;
    } else {
      outputBuffers.set(chatId, { text: data });
    }
    startFlushing();
    bot.api.sendChatAction(chatId, 'typing').catch(() => {});
  }

  // Legacy TTY output callback — suppressed for tasks using structured output
  onTtyOutput((nodeId, data) => {
    const session = getActiveSession(nodeId);
    if (!session) return;
    // Fix 4: check if this node's running task is using structured output
    const running = getRunningTasksByNodeId(nodeId);
    const isStructured = running.some(t => structuredTasks.has(t.task_id));
    if (isStructured) return; // suppress TTY — structured output is handling rendering
    appendOutput(session.chatId, data.toString('utf-8'));
  });

  // --- Structured output rendering (P0-4 Telegram side) ---
  const structuredMessageIds = new Map<string, number>(); // taskId → messageId for progress edits
  const structuredTasks = new Set<string>(); // taskIds using structured output (suppress TTY for these)

  onStructuredOutput((nodeId, params: OutputParams) => {
    const session = getActiveSession(nodeId);
    const chatId = session?.chatId;
    if (!chatId) return;

    const { taskId, type, payload } = params;

    // Fix 4: mark this task as using structured output
    structuredTasks.add(taskId);

    switch (type) {
      case 'status': {
        const p = payload as { text?: string };
        bot.api.sendMessage(chatId, `<i>${escapeHtml(p.text ?? '')}</i>`, { parse_mode: 'HTML' }).catch(() => {});
        break;
      }
      case 'progress': {
        const p = payload as { current?: number; total?: number; label?: string };
        const pct = p.total ? Math.round(((p.current ?? 0) / p.total) * 100) : 0;
        const label = p.label ? ` — ${escapeHtml(p.label)}` : '';
        const text = `🔄 ${p.current ?? 0}/${p.total ?? '?'} (${pct}%)${label}`;
        const existingMsgId = structuredMessageIds.get(taskId);
        if (existingMsgId) {
          bot.api.editMessageText(chatId, existingMsgId, text, { parse_mode: 'HTML' }).catch(() => {});
        } else {
          bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' }).then(msg => {
            structuredMessageIds.set(taskId, msg.message_id);
          }).catch(() => {});
        }
        break;
      }
      case 'result': {
        const p = payload as { text?: string };
        structuredMessageIds.delete(taskId);
        structuredTasks.delete(taskId);
        const resultText = p.text ?? '';
        const chunks = splitMessage(escapeHtml(resultText), 3900);
        for (const chunk of chunks) {
          bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' }).catch(() => {});
        }
        // Session clearing + queue processing now handled by gateway via onSessionEnd
        break;
      }
      case 'error': {
        const p = payload as { message?: string };
        structuredMessageIds.delete(taskId);
        structuredTasks.delete(taskId);
        bot.api.sendMessage(chatId, `❌ ${escapeHtml(p.message ?? 'Unknown error')}`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔄 Retry', callback_data: `retry:${taskId}` }]] },
        }).catch(() => {});
        // Session clearing + queue processing now handled by gateway via onSessionEnd
        break;
      }
    }
  });

  // --- Session end → process queue + update status ---
  onSessionEnd((nodeId, _exitCode) => {
    processNextQueued(bot, nodeId);
    updatePinnedStatus();
  });

  // --- Pinned status message (P0-8) ---
  let pinnedChatId: number | null = null;
  let pinnedMessageId: number | null = null;

  async function updatePinnedStatus(): Promise<void> {
    if (!pinnedChatId || !pinnedMessageId) return;
    const nodes = getAllNodes();
    const agents = getAllAgents();
    const onlineNodes = nodes.filter(n => isNodeOnline(n.node_id));
    const defaultAgent = getDefaultAgent(pinnedChatId);
    const session = getActiveSessionByChatId(pinnedChatId);
    const recentTasks = getRecentTasksByChatId(pinnedChatId, 3);
    const mcpPort = process.env.MCP_PORT;

    let text = '<b>📍 AnyAgent Status</b>\n\n';
    text += `<b>Workers:</b> ${onlineNodes.length}/${nodes.length} online\n`;
    for (const n of nodes) {
      const status = isNodeOnline(n.node_id) ? '🟢' : '🔴';
      text += `  ${status} ${escapeHtml(n.name || n.node_id)}\n`;
    }
    text += `\n<b>Agents:</b> ${agents.length} registered\n`;
    if (mcpPort) {
      text += `<b>MCP:</b> port ${escapeHtml(mcpPort)}\n`;
    }
    text += '\n';
    if (session) {
      text += `<b>Active:</b> <code>${escapeHtml(session.agentName ?? session.nodeId)}</code>\n`;
    }
    if (defaultAgent) {
      text += `<b>Default:</b> <code>${escapeHtml(defaultAgent)}</code>\n`;
    }
    if (recentTasks.length > 0) {
      text += '\n<b>Recent tasks:</b>\n';
      for (const t of recentTasks) {
        const emoji = statusEmoji(t.status as TaskStatus);
        const intent = t.intent.length > 40 ? t.intent.slice(0, 40) + '...' : t.intent;
        text += `  ${emoji} ${escapeHtml(intent)}\n`;
      }
    }

    try {
      await bot.api.editMessageText(pinnedChatId, pinnedMessageId, text, { parse_mode: 'HTML' });
    } catch {
      // Message may have been deleted
      pinnedMessageId = null;
    }
  }

  // Update pinned status every 30 seconds
  setInterval(updatePinnedStatus, 30_000);

  // --- /start ---
  bot.command('start', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;

    await sendHtml(ctx,
      '<b>AnyAgent</b> — personal MCP bridge for distributed agents.\n\n' +
      '<b>Setup</b>\n' +
      '/pair — Pair a new worker\n' +
      '/workers — List registered workers\n\n' +
      '<b>Usage</b>\n' +
      '/agents — List agents (tap to start)\n' +
      '/call <code>&lt;name&gt;</code> — Start an agent session\n' +
      '/tasks — Recent task history\n' +
      '/stop — Stop the active session\n\n' +
      '<b>Config</b>\n' +
      '/default — Set an auto-start agent\n' +
      '/status — Show and pin live status\n' +
      '/context — Manage persistent operator context\n' +
      '/approve — Set task approval mode\n' +
      '/revoke — Revoke a paired worker\n' +
      '/purge — Delete all task history'
    );

    // Create/update pinned status
    if (!pinnedMessageId) {
      pinnedChatId = ctx.chat!.id;
      const nodes = getAllNodes();
      const onlineNodes = nodes.filter(n => isNodeOnline(n.node_id));
      const text = `<b>📍 AnyAgent Status</b>\n\nWorkers: ${onlineNodes.length}/${nodes.length} online\nAgents: ${getAllAgents().length} registered`;
      try {
        const msg = await bot.api.sendMessage(ctx.chat!.id, text, { parse_mode: 'HTML' });
        pinnedMessageId = msg.message_id;
        await bot.api.pinChatMessage(ctx.chat!.id, msg.message_id, { disable_notification: true }).catch(() => {});
      } catch { /* ignore pin failures in non-group chats */ }
    }
  });

  // --- /pair ---
  bot.command('pair', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const code = randomBytes(16).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    insertPairCode(code, expiresAt, '');

    // Build ready-to-paste commands
    const wsPort = config?.wsPort ?? 8080;
    const wsSecret = config?.wsSecret;
    const hubHost = 'YOUR_HUB_IP';
    const hubUrl = `ws://${hubHost}:${wsPort}`;
    const secretArg = wsSecret ? ` --secret ${escapeHtml(wsSecret)}` : '';
    const secretEnv = wsSecret ? ` -e WS_SECRET=${escapeHtml(wsSecret)}` : '';

    let msg = `🔑 Pairing code generated. Expires in 10 minutes.\n\n`;
    msg += `<b>Run on your worker machine:</b>\n\n`;
    msg += `<b>If already cloned:</b>\n`;
    msg += `<code>cd AnyAgent/worker && node dist/index.js --hub ${escapeHtml(hubUrl)} --pair ${escapeHtml(code)}${secretArg}</code>\n\n`;
    msg += `<b>Docker:</b>\n`;
    msg += `<code>docker run -e HUB_URL=${escapeHtml(hubUrl)} -e PAIR_CODE=${escapeHtml(code)}${secretEnv} anyagent/worker</code>\n\n`;
    msg += `Replace <code>${escapeHtml(hubHost)}</code> with your hub machine's IP.\n`;
    msg += `Then tap ✅ Approve when prompted.`;

    await sendHtml(ctx, msg);
  });

  // --- /workers ---
  async function handleWorkers(ctx: Context): Promise<void> {
    if (!guardUser(ctx, allowedUserId)) return;
    const nodes = getAllNodes();
    if (nodes.length === 0) {
      await ctx.reply('No workers registered. Use /pair to add one.');
      return;
    }
    const buttons = nodes.map((n) => {
      const status = isNodeOnline(n.node_id) ? '🟢' : '🔴';
      const label = n.name || n.node_id;
      const desc = n.description ? ` — ${n.description}` : '';
      return [{ text: `${status} ${label}${desc}`, callback_data: `worker:${n.node_id}` }];
    });
    await sendHtml(ctx, '<b>Workers:</b>', { reply_markup: { inline_keyboard: buttons } });
  }
  bot.command('workers', handleWorkers);
  bot.command('devices', handleWorkers);
  bot.command('list', handleWorkers);

  // --- /agents ---
  bot.command('agents', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const agents = getAllAgents();
    if (agents.length === 0) {
      await ctx.reply('No agents registered. Connect a worker with WORKER_AGENTS to declare agents.');
      return;
    }
    const buttons = agents.map((a) => {
      const online = isNodeOnline(a.node_id) ? '🟢' : '🔴';
      const caps: string[] = JSON.parse(a.capabilities || '[]');
      const capsStr = caps.length > 0 ? ` [${caps.join(', ')}]` : '';
      const desc = a.description ? ` - ${a.description}` : '';
      return [{ text: `${online} ${a.name}${desc}${capsStr}`, callback_data: `call:${a.name}` }];
    });
    await sendHtml(ctx, '<b>Agents:</b> (tap to start)', { reply_markup: { inline_keyboard: buttons } });
  });

  // --- /tasks (P1-1 but useful now) ---
  bot.command('tasks', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const tasks = getRecentTasksByChatId(ctx.chat!.id, 10);
    if (tasks.length === 0) {
      await ctx.reply('No tasks yet.');
      return;
    }
    let text = '<b>Recent tasks:</b>\n\n';
    for (const t of tasks) {
      const emoji = statusEmoji(t.status as TaskStatus);
      const intent = t.intent.length > 50 ? t.intent.slice(0, 50) + '...' : t.intent;
      const agent = t.agent_name ? ` → ${escapeHtml(t.agent_name)}` : '';
      const src = t.source === 'mcp' ? ' (MCP)' : '';
      text += `${emoji} <code>${escapeHtml(t.task_id.slice(0, 12))}</code>${agent}${src}\n   ${escapeHtml(intent)}\n`;
      if (t.result_summary) {
        const summary = t.result_summary.length > 60 ? t.result_summary.slice(0, 60) + '...' : t.result_summary;
        text += `   → ${escapeHtml(summary)}\n`;
      }
      if (t.error) {
        text += `   ❌ ${escapeHtml(t.error)}\n`;
      }
      text += '\n';
    }
    await sendHtml(ctx, text);
  });

  // --- /switch ---
  bot.command('switch', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const agents = getAllAgents().filter((a) => isNodeOnline(a.node_id));
    if (agents.length === 0) {
      await ctx.reply('No online agents available.');
      return;
    }
    const buttons = agents.map((a) => {
      const desc = a.description ? ` - ${a.description}` : '';
      return [{ text: `🟢 ${a.name}${desc}`, callback_data: `switch:${a.name}` }];
    });
    await sendHtml(ctx, '<b>Switch to:</b>', { reply_markup: { inline_keyboard: buttons } });
  });

  // --- /status ---
  bot.command('status', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    pinnedChatId = ctx.chat!.id;

    // If no pinned message, create one
    if (!pinnedMessageId) {
      const text = '<b>📍 AnyAgent Status</b>\n\nLoading...';
      try {
        const msg = await bot.api.sendMessage(ctx.chat!.id, text, { parse_mode: 'HTML' });
        pinnedMessageId = msg.message_id;
        await bot.api.pinChatMessage(ctx.chat!.id, msg.message_id, { disable_notification: true }).catch(() => {});
      } catch { /* ignore */ }
    }

    await updatePinnedStatus();
    await ctx.reply('Status updated and pinned.');
  });

  // --- /default ---
  async function handleDefault(ctx: Context): Promise<void> {
    if (!guardUser(ctx, allowedUserId)) return;
    const name = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (name === 'off' || name === 'clear') {
      clearDefaultAgent(ctx.chat!.id);
      await ctx.reply('Default agent cleared.');
      return;
    }
    if (name) {
      const agent = getAgentByName(name);
      if (!agent) {
        await sendHtml(ctx, `❌ Agent <code>${escapeHtml(name)}</code> not found.`);
        return;
      }
      setDefaultAgent(ctx.chat!.id, name);
      await sendHtml(ctx, `✅ Default agent set to <code>${escapeHtml(name)}</code>. Just type to interact.`);
      return;
    }
    const agents = getAllAgents().filter((a) => isNodeOnline(a.node_id));
    if (agents.length === 0) {
      await ctx.reply('No online agents available.');
      return;
    }
    const buttons = agents.map((a) => {
      const desc = a.description ? ` - ${a.description}` : '';
      return [{ text: `${a.name}${desc}`, callback_data: `default:${a.name}` }];
    });
    buttons.push([{ text: '❌ Clear default', callback_data: 'default:__clear__' }]);
    await sendHtml(ctx, '<b>Set default agent:</b>', { reply_markup: { inline_keyboard: buttons } });
  }
  bot.command('default', handleDefault);
  bot.command('delegate', handleDefault);

  // --- /call ---
  bot.command('call', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const matchText = ctx.match;
    const args = typeof matchText === 'string' ? matchText.trim().split(/\s+/) : [];
    if (args.length < 1 || !args[0]) {
      await ctx.reply('Usage: /call <agent_name>');
      return;
    }
    const agent = getAgentByName(args[0]);
    if (!agent) {
      await sendHtml(ctx, `❌ Agent <code>${escapeHtml(args[0])}</code> not found.`);
      return;
    }
    // Stop existing session
    const existing = getActiveSessionByChatId(ctx.chat!.id);
    if (existing) clearActiveSession(existing.nodeId);

    const taskId = createTaskId();
    insertTask(taskId, 'telegram', `/call ${args[0]}`, ctx.chat!.id);
    await startAgentForTask(bot, ctx.chat!.id, agent, taskId, `/call ${args[0]}`, 'explicit');
    updatePinnedStatus();
  });

  // --- /stop ---
  bot.command('stop', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const session = getActiveSessionByChatId(ctx.chat!.id);
    if (!session) {
      await ctx.reply('No active session to stop.');
      return;
    }
    clearActiveSession(session.nodeId);
    const label = session.agentName ? `Agent <code>${escapeHtml(session.agentName)}</code>` : `Session on <code>${escapeHtml(session.nodeId)}</code>`;
    await sendHtml(ctx, `🛑 ${label} session ended.`);
    // Process queued tasks
    processNextQueued(bot, session.nodeId);
    updatePinnedStatus();
  });

  // --- /purge ---
  bot.command('purge', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    await sendHtml(ctx, '⚠️ This will permanently delete all your task history. Continue?', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗑️ Purge all tasks', callback_data: 'purge:confirm' }],
          [{ text: '❌ Cancel', callback_data: 'purge:cancel' }],
        ],
      },
    });
  });

  // --- Callback: purge confirmation ---
  bot.callbackQuery(/^purge:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const action = ctx.match[1];
    if (action === 'cancel') {
      await ctx.editMessageText('Purge cancelled.');
      await ctx.answerCallbackQuery({ text: 'Cancelled.' });
      return;
    }
    if (action === 'confirm') {
      const chatId = ctx.chat!.id;
      const count = purgeTasksByChatId(chatId);
      clearDefaultAgent(chatId);
      const session = getActiveSessionByChatId(chatId);
      if (session) clearActiveSession(session.nodeId);
      await ctx.editMessageText(`🗑️ Purged ${count} task(s). Default agent and active session cleared.`);
      await ctx.answerCallbackQuery({ text: `${count} tasks purged.` });
      updatePinnedStatus();
    }
  });

  // --- /revoke <node_id> ---
  bot.command('revoke', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const nodeId = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (!nodeId) {
      await ctx.reply('Usage: /revoke <node_id>');
      return;
    }
    const revoked = revokeNode(nodeId);
    if (revoked) {
      await sendHtml(ctx, `✅ Node <code>${escapeHtml(nodeId)}</code> revoked. All agents removed.`);
      updatePinnedStatus();
    } else {
      await sendHtml(ctx, `❌ Node <code>${escapeHtml(nodeId)}</code> not found.`);
    }
  });

  // --- /approve ---
  bot.command('approve', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const mode = typeof ctx.match === 'string' ? ctx.match.trim().toLowerCase() : '';
    if (mode === 'off' || mode === 'mcp' || mode === 'always') {
      setApprovalMode(ctx.chat!.id, mode);
      const desc = mode === 'off' ? 'disabled' : mode === 'mcp' ? 'required for MCP tasks' : 'required for all tasks';
      await ctx.reply(`✅ Approval ${desc}.`);
    } else {
      const current = getApprovalMode(ctx.chat!.id);
      await sendHtml(ctx,
        `<b>Task approval mode:</b> <code>${escapeHtml(current)}</code>\n\n` +
        '/approve off — all tasks auto-run\n' +
        '/approve mcp — MCP tasks need approval\n' +
        '/approve always — all tasks need approval'
      );
    }
  });

  // --- Callback: task approval ---
  bot.callbackQuery(/^taskapprove:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const taskId = ctx.match[1];
    const task = getTask(taskId);
    if (!task || task.status !== 'pending_approval') {
      await ctx.answerCallbackQuery({ text: 'Task not found or already handled.' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Approved!' });
    await ctx.editMessageText(`✅ Approved: <i>${escapeHtml(task.intent.slice(0, 60))}</i>`, { parse_mode: 'HTML' });
    // Now actually spawn the agent
    const agent = task.agent_name ? getAgentByName(task.agent_name) : undefined;
    if (!agent) {
      updateTaskStatus(taskId, 'failed', { error: 'Agent no longer exists' });
      return;
    }
    updateTaskStatus(taskId, 'submitted'); // reset to submitted so startAgentForTask can proceed
    await startAgentForTask(bot, ctx.chat!.id, agent, taskId, task.intent, 'explicit');
    updatePinnedStatus();
  });

  bot.callbackQuery(/^tasttrust:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const taskId = ctx.match[1];
    const task = getTask(taskId);
    if (!task || task.status !== 'pending_approval') {
      await ctx.answerCallbackQuery({ text: 'Task not found or already handled.' });
      return;
    }
    // Trust the agent for future tasks
    if (task.agent_name) setAgentTrusted(task.agent_name, true);
    await ctx.answerCallbackQuery({ text: `Agent ${task.agent_name} trusted!` });
    await ctx.editMessageText(`🔓 Trusted <code>${escapeHtml(task.agent_name ?? '')}</code>. Approved: <i>${escapeHtml(task.intent.slice(0, 60))}</i>`, { parse_mode: 'HTML' });
    // Spawn
    const agent = task.agent_name ? getAgentByName(task.agent_name) : undefined;
    if (!agent) {
      updateTaskStatus(taskId, 'failed', { error: 'Agent no longer exists' });
      return;
    }
    updateTaskStatus(taskId, 'submitted');
    await startAgentForTask(bot, ctx.chat!.id, agent, taskId, task.intent, 'explicit');
    updatePinnedStatus();
  });

  bot.callbackQuery(/^taskdeny:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const taskId = ctx.match[1];
    const task = getTask(taskId);
    if (!task || task.status !== 'pending_approval') {
      await ctx.answerCallbackQuery({ text: 'Task not found or already handled.' });
      return;
    }
    updateTaskStatus(taskId, 'failed', { error: 'Denied by operator' });
    await ctx.editMessageText(`❌ Denied: <i>${escapeHtml(task.intent.slice(0, 60))}</i>`, { parse_mode: 'HTML' });
    await ctx.answerCallbackQuery({ text: 'Denied.' });
  });

  // --- /context ---
  bot.command('context', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';

    if (!arg) {
      const current = getContext();
      if (!current) {
        await ctx.reply('No context set. Use /context set <text> to add operator context.');
      } else {
        await sendHtml(ctx, `<b>Operator context:</b>\n<pre>${escapeHtml(current)}</pre>`);
      }
      return;
    }

    if (arg.startsWith('set ')) {
      const text = arg.slice(4).trim();
      if (!text) { await ctx.reply('Usage: /context set <text>'); return; }
      setContext(text);
      await ctx.reply('✅ Context updated.');
      return;
    }

    if (arg.startsWith('add ')) {
      const line = arg.slice(4).trim();
      if (!line) { await ctx.reply('Usage: /context add <line>'); return; }
      appendContext(line);
      await ctx.reply('✅ Line appended to context.');
      return;
    }

    if (arg === 'clear') {
      clearContext();
      await ctx.reply('✅ Context cleared.');
      return;
    }

    await ctx.reply('Usage: /context [set <text> | add <line> | clear]');
  });

  // --- Callback: approve/reject pair ---
  bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const connId = ctx.match[1];
    const nodeId = approvePair(connId);
    if (!nodeId) {
      await ctx.answerCallbackQuery({ text: 'Pair request not found or already handled.' });
      return;
    }
    await ctx.editMessageText(`✅ Approved. Node ID: <code>${escapeHtml(nodeId)}</code>`, { parse_mode: 'HTML' });
    await ctx.answerCallbackQuery({ text: `Approved! Node: ${nodeId}` });
    updatePinnedStatus();
  });

  bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    rejectPair(ctx.match[1]);
    await ctx.editMessageText('❌ Pair request rejected.');
    await ctx.answerCallbackQuery({ text: 'Rejected.' });
  });

  // --- Callback: call agent ---
  bot.callbackQuery(/^call:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const agentName = ctx.match[1];
    const agent = getAgentByName(agentName);
    if (!agent) {
      await ctx.answerCallbackQuery({ text: 'Agent not found.' });
      return;
    }
    const existing = getActiveSessionByChatId(ctx.chat!.id);
    if (existing) clearActiveSession(existing.nodeId);

    await ctx.answerCallbackQuery({ text: `Starting ${agentName}...` });
    const taskId = createTaskId();
    insertTask(taskId, 'telegram', `call:${agentName}`, ctx.chat!.id);
    await startAgentForTask(bot, ctx.chat!.id, agent, taskId, `call:${agentName}`, 'explicit');
    updatePinnedStatus();
  });

  // --- Callback: switch agent ---
  bot.callbackQuery(/^switch:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const agentName = ctx.match[1];
    const agent = getAgentByName(agentName);
    if (!agent) {
      await ctx.answerCallbackQuery({ text: 'Agent not found.' });
      return;
    }
    const existing = getActiveSessionByChatId(ctx.chat!.id);
    if (existing) clearActiveSession(existing.nodeId);

    await ctx.answerCallbackQuery({ text: `Switching to ${agentName}...` });
    const taskId = createTaskId();
    insertTask(taskId, 'telegram', `switch:${agentName}`, ctx.chat!.id);
    await startAgentForTask(bot, ctx.chat!.id, agent, taskId, `switch:${agentName}`, 'user_selected');
    updatePinnedStatus();
  });

  // --- Callback: worker detail ---
  bot.callbackQuery(/^worker:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const nodeId = ctx.match[1];
    const agents = getAllAgents().filter((a) => a.node_id === nodeId);
    const online = isNodeOnline(nodeId) ? '🟢 online' : '🔴 offline';
    const nodes = getAllNodes();
    const node = nodes.find((n) => n.node_id === nodeId);
    const name = node?.name || nodeId;
    const desc = node?.description ? `\n${escapeHtml(node.description)}` : '';

    if (agents.length === 0) {
      await ctx.editMessageText(`<b>${escapeHtml(name)}</b> ${online}${desc}\n\nNo agents on this worker.`, { parse_mode: 'HTML' });
    } else {
      const buttons = agents.map((a) => {
        const agentDesc = a.description ? ` - ${a.description}` : '';
        return [{ text: `▶️ ${a.name}${agentDesc}`, callback_data: `call:${a.name}` }];
      });
      await ctx.editMessageText(`<b>${escapeHtml(name)}</b> ${online}${desc}`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      });
    }
    await ctx.answerCallbackQuery();
  });

  // --- Callback: default agent ---
  bot.callbackQuery(/^default:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const agentName = ctx.match[1];
    if (agentName === '__clear__') {
      clearDefaultAgent(ctx.chat!.id);
      await ctx.editMessageText('Default agent cleared.');
      await ctx.answerCallbackQuery({ text: 'Cleared.' });
      return;
    }
    setDefaultAgent(ctx.chat!.id, agentName);
    await ctx.editMessageText(`✅ Default agent set to <b>${escapeHtml(agentName)}</b>. Just type to interact.`, { parse_mode: 'HTML' });
    await ctx.answerCallbackQuery({ text: `Default: ${agentName}` });
  });

  // --- Callback: retry task (P0-7) ---
  bot.callbackQuery(/^retry:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const originalTaskId = ctx.match[1];
    const original = getTask(originalTaskId);
    if (!original) {
      await ctx.answerCallbackQuery({ text: 'Task not found.' });
      return;
    }
    if (!original.agent_name) {
      await ctx.answerCallbackQuery({ text: 'Cannot retry — no agent associated.' });
      return;
    }

    const agent = getAgentByName(original.agent_name);
    if (!agent) {
      await ctx.answerCallbackQuery({ text: 'Agent no longer exists.' });
      return;
    }

    // Fix 2: enforce max 3 retries
    if (original.retry_count >= 3) {
      await ctx.answerCallbackQuery({ text: 'Max retries reached (3).' });
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Retrying...' });

    const taskId = createTaskId();
    // Retry intent includes the error so the agent knows what failed
    const retryIntent = original.error
      ? `${original.intent}\n[Previous attempt failed: ${original.error}]`
      : original.intent;
    insertTask(taskId, original.source, retryIntent, original.chat_id ?? undefined, original.retry_count + 1);
    await startAgentForTask(bot, ctx.chat!.id, agent, taskId, retryIntent, 'explicit');
    updatePinnedStatus();
  });

  // --- Callback: cancel queued task ---
  bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const taskId = ctx.match[1];
    const task = getTask(taskId);
    if (!task || task.status !== 'queued') {
      await ctx.answerCallbackQuery({ text: 'Task not found or already started.' });
      return;
    }
    updateTaskStatus(taskId, 'failed', { error: 'Cancelled by user' });
    await ctx.editMessageText('❌ Queued task cancelled.');
    await ctx.answerCallbackQuery({ text: 'Cancelled.' });
  });

  // --- Callback: route to specific agent (from ambiguous routing) ---
  bot.callbackQuery(/^route:([^:]+):(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const taskId = ctx.match[1];
    const agentName = ctx.match[2];
    const agent = getAgentByName(agentName);
    const task = getTask(taskId);
    if (!agent || !task) {
      await ctx.answerCallbackQuery({ text: 'Agent or task not found.' });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Routing to ${agentName}...` });
    await ctx.editMessageText(`Routing to <code>${escapeHtml(agentName)}</code>...`, { parse_mode: 'HTML' });

    await startAgentForTask(bot, ctx.chat!.id, agent, taskId, task.intent, 'user_selected');
    updatePinnedStatus();
  });

  // --- Plain text → route via capability matching ---
  bot.on('message:text', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const chatId = ctx.chat!.id;
    const text = ctx.message.text;

    // If there's an active session, route input there
    const session = getActiveSessionByChatId(chatId);
    if (session) {
      const ok = sendTtyInput(session.nodeId, text + '\n');
      if (!ok) {
        await ctx.reply('⚠️ Failed to send input — worker may be offline.');
        clearActiveSession(session.nodeId);
      }
      return;
    }

    // No active session — create a task and route it
    const taskId = createTaskId();
    insertTask(taskId, 'telegram', text, chatId);

    // Check default agent first
    const defaultName = getDefaultAgent(chatId);
    if (defaultName) {
      const agent = getAgentByName(defaultName);
      if (!agent) {
        await sendHtml(ctx, `⚠️ Default agent <code>${escapeHtml(defaultName)}</code> no longer exists. Clearing.`);
        clearDefaultAgent(chatId);
        updateTaskStatus(taskId, 'failed', { error: 'Default agent not found' });
        return;
      }
      await startAgentForTask(bot, chatId, agent, taskId, text, 'default');
      updatePinnedStatus();
      return;
    }

    // Capability-based routing (P0-5)
    const result = findAgentByCapability(text);
    if (!result) {
      updateTaskStatus(taskId, 'failed', { error: 'No agents available' });
      await sendHtml(ctx, 'No agents online. Use /workers to check connectivity.');
      return;
    }

    if ('agent' in result) {
      // Clear match — route directly
      await startAgentForTask(bot, chatId, result.agent, taskId, text, result.method);
      updatePinnedStatus();
      return;
    }

    // Ambiguous — ask user to pick
    updateTaskStatus(taskId, 'routed', { routing_method: 'user_selected' });
    const buttons = result.agents.map(a => {
      const caps: string[] = JSON.parse(a.capabilities || '[]');
      const capsStr = caps.length > 0 ? ` [${caps.join(', ')}]` : '';
      return [{ text: `${a.name}${capsStr}`, callback_data: `route:${taskId}:${a.name}` }];
    });
    await sendHtml(ctx, 'Multiple agents available. Which should handle this?', {
      reply_markup: { inline_keyboard: buttons },
    });

    // Timeout: if user doesn't pick within 5 minutes, mark as timeout
    const routedTaskId = taskId;
    setTimeout(() => {
      const t = getTask(routedTaskId);
      if (t && t.status === 'routed') {
        updateTaskStatus(routedTaskId, 'timeout', { error: 'No agent selected within 5 minutes' });
      }
    }, 5 * 60 * 1000);
  });

  return bot;
}
