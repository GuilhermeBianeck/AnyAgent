import { Bot, Context } from 'grammy';
import {
  createTaskId, findAgentByCapability, startAgentForTask,
  processNextQueued, handleApprovalDecision, generatePairCode,
  approveWorkerPairing, rejectWorkerPairing, revokeWorker,
  getWorkerList, getAgentList, getRecentTasks, getTask,
  getActiveSessionByChatId, clearActiveSession, sendTtyInput,
  setDefaultAgent, getDefaultAgent, clearDefaultAgent,
  getApprovalMode, setApprovalMode, purgeTasksByChatId,
  getActiveSession,
} from './manager.js';
import { randomBytes } from 'crypto';
import {
  getAgentByName, getAgentByNameAndAlias, insertTask, updateTaskStatus, getRunningTasksByNodeId,
  insertPairCode, getRecentTasksByChatId, getAllNodes, getAllAgents,
  setAgentTrusted,
} from './db.js';
import {
  isNodeOnline,
  approvePair,
  rejectPair,
  onTtyOutput,
  onStructuredOutput,
  onSessionEnd,
  onPairingRequest,
} from './gateway.js';
import { escapeHtml } from './format.js';
import { stripAnsi } from './output.js';
import { getContext, setContext, appendContext, clearContext } from './context.js';
import type { OutputParams, TaskStatus } from './types.js';

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

// --- Helper to render TaskStartResult from manager to Telegram ---
async function renderTaskStart(bot: Bot, chatId: number, result: ReturnType<typeof startAgentForTask>, taskId: string): Promise<void> {
  switch (result.outcome) {
    case 'started':
      await sendHtmlDirect(bot, chatId, `✅ <code>${escapeHtml(result.agentName)}</code> started. Send messages to interact. /stop to end.`);
      break;
    case 'queued':
      await sendHtmlDirect(bot, chatId, `⏳ <code>${escapeHtml(result.agentName)}</code> is busy. Queued (position #${result.queuePosition}).`, {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: `cancel:${taskId}` }]] },
      });
      break;
    case 'pending_approval': {
      const task = getTask(taskId);
      const intentPreview = (task?.intent ?? '').length > 80 ? (task?.intent ?? '').slice(0, 80) + '...' : (task?.intent ?? '');
      await sendHtmlDirect(bot, chatId,
        `📋 <b>Task approval required</b>\n<i>${escapeHtml(intentPreview)}</i>\n→ <code>${escapeHtml(result.agentName)}</code>`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Approve', callback_data: `taskapprove:${taskId}` }],
              [{ text: '🔓 Always Allow Agent', callback_data: `tasttrust:${taskId}` }],
              [{ text: '❌ Deny', callback_data: `taskdeny:${taskId}` }],
            ],
          },
        });
      break;
    }
    case 'offline':
      await sendHtmlDirect(bot, chatId, `❌ Agent <code>${escapeHtml(result.agentName)}</code> — worker is offline.`);
      break;
    case 'queue_full':
      await sendHtmlDirect(bot, chatId, `❌ Agent <code>${escapeHtml(result.agentName)}</code> — queue is full.`);
      break;
    case 'failed':
      await sendHtmlDirect(bot, chatId, `❌ Failed to start <code>${escapeHtml(result.agentName)}</code>.`, {
        reply_markup: { inline_keyboard: [[{ text: '🔄 Retry', callback_data: `retry:${taskId}` }]] },
      });
      break;
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

function formatTaskDetail(t: import('./types.js').TaskRow): string {
  const emoji = statusEmoji(t.status as TaskStatus);
  let text = `${emoji} <b>Task Detail</b>\n\n`;
  text += `<b>ID:</b> <code>${escapeHtml(t.task_id)}</code>\n`;
  text += `<b>Status:</b> ${t.status}\n`;
  text += `<b>Source:</b> ${t.source}\n`;
  if (t.agent_name) text += `<b>Agent:</b> ${escapeHtml(t.agent_name)}\n`;
  if (t.node_id) text += `<b>Node:</b> <code>${escapeHtml(t.node_id)}</code>\n`;
  if (t.routing_method) text += `<b>Routing:</b> ${t.routing_method}\n`;
  if (t.retry_count > 0) text += `<b>Retries:</b> ${t.retry_count}\n`;
  text += `<b>Created:</b> ${escapeHtml(t.created_at)}\n`;
  text += `<b>Updated:</b> ${escapeHtml(t.updated_at)}\n`;
  text += `\n<b>Intent:</b>\n${escapeHtml(t.intent)}\n`;
  if (t.result_summary) {
    text += `\n<b>Result:</b>\n${escapeHtml(t.result_summary)}\n`;
  }
  if (t.error) {
    text += `\n<b>Error:</b>\n❌ ${escapeHtml(t.error)}\n`;
  }
  return text;
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
    { const _qr = processNextQueued(nodeId); if (_qr.outcome === "started" && _qr.chatId) sendHtmlDirect(bot, _qr.chatId, `▶️ Queued task started on <code>${escapeHtml(_qr.agentName ?? "")}</code>.`); }
    updatePinnedStatus();
  });

  // --- Pinned status message (P0-8) ---
  let pinnedChatId: number | null = null;
  let pinnedMessageId: number | null = null;

  async function updatePinnedStatus(): Promise<void> {
    if (!pinnedChatId || !pinnedMessageId) return;
    const workers = getWorkerList();      // includes alias
    const agents = getAgentList();        // includes nodeAlias
    const onlineWorkers = workers.filter(w => w.online);
    const defaultAgent = getDefaultAgent(pinnedChatId);
    const session = getActiveSessionByChatId(pinnedChatId);
    const recentTasks = getRecentTasksByChatId(pinnedChatId, 3);
    const mcpPort = process.env.MCP_PORT;

    // Pre-tally agents per node so each worker line can show how many agents
    // it exposes — at a glance the operator sees "spot has 3, beacon has 2"
    // which is the info they were previously fishing for in /agents.
    const agentCountByNode = new Map<string, number>();
    for (const a of agents) {
      agentCountByNode.set(a.nodeAlias, (agentCountByNode.get(a.nodeAlias) ?? 0) + 1);
    }

    let text = '<b>📍 AnyAgent Status</b>\n\n';
    text += `<b>Workers:</b> ${onlineWorkers.length}/${workers.length} online\n`;
    for (const w of workers) {
      const status = w.online ? '🟢' : '🔴';
      const count = agentCountByNode.get(w.alias) ?? 0;
      const label = w.name && w.name !== w.alias ? `${w.alias} (${w.name})` : w.alias;
      text += `  ${status} ${escapeHtml(label)} — ${count} agent${count === 1 ? '' : 's'}\n`;
    }
    text += `\n<b>Agents:</b> ${agents.length} registered across ${workers.length} worker${workers.length === 1 ? '' : 's'}\n`;
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
      '/workers — List registered workers\n' +
      '/nodes — Machines + their agents in one view\n\n' +
      '<b>Usage</b>\n' +
      '/agents — List agents grouped by machine (tap to start)\n' +
      '/call <code>&lt;name&gt;</code> or <code>&lt;name&gt;@&lt;alias&gt;</code> — Start an agent; use @alias to target a specific machine\n' +
      '/tasks — Recent task history\n' +
      '/history — Full task history (tap for detail)\n' +
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
    const workers = getWorkerList();
    if (workers.length === 0) {
      await ctx.reply('No workers registered. Use /pair to add one.');
      return;
    }
    const buttons = workers.map((w) => {
      const status = w.online ? '🟢' : '🔴';
      const label = w.alias || w.name;
      // If the friendly name differs from the alias, show both so operators
      // can recognise the machine either way.
      const suffix = w.name && w.name !== w.alias ? ` (${w.name})` : '';
      const desc = w.description ? ` — ${w.description}` : '';
      return [{ text: `${status} ${label}${suffix}${desc}`, callback_data: `worker:${w.nodeId}` }];
    });
    await sendHtml(ctx, '<b>Workers:</b>', { reply_markup: { inline_keyboard: buttons } });
  }
  bot.command('workers', handleWorkers);
  bot.command('devices', handleWorkers);
  bot.command('list', handleWorkers);

  // --- /nodes — shortcut view showing each machine and the agents it carries ---
  // `/workers` lists the machines alone; `/nodes` folds the agent inventory
  // into each entry so the operator sees, in one shot, which agents run
  // where without having to drill in.
  bot.command('nodes', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const workers = getWorkerList();
    const agents = getAgentList();
    if (workers.length === 0) {
      await ctx.reply('No workers registered. Use /pair to add one.');
      return;
    }
    const byNode = new Map<string, typeof agents>();
    for (const a of agents) {
      if (!byNode.has(a.nodeAlias)) byNode.set(a.nodeAlias, []);
      byNode.get(a.nodeAlias)!.push(a);
    }
    const lines: string[] = ['<b>Nodes:</b>'];
    // Sort workers alphabetically by alias for stable output.
    const sorted = [...workers].sort((a, b) => a.alias.localeCompare(b.alias));
    for (const w of sorted) {
      const status = w.online ? '🟢' : '🔴';
      const nameSuffix = w.name && w.name !== w.alias ? ` (${escapeHtml(w.name)})` : '';
      const desc = w.description ? ` — ${escapeHtml(w.description)}` : '';
      lines.push(`\n${status} <b>${escapeHtml(w.alias)}</b>${nameSuffix}${desc}`);
      const mine = byNode.get(w.alias) ?? [];
      if (mine.length === 0) {
        lines.push('   <i>(no agents declared)</i>');
      } else {
        for (const a of mine) {
          const caps = a.capabilities.length > 0 ? ` [${a.capabilities.join(', ')}]` : '';
          lines.push(`   ${a.online ? '🟢' : '🔴'} <code>${escapeHtml(a.name)}@${escapeHtml(w.alias)}</code>${caps}`);
        }
      }
    }
    // Offer inline buttons to start any agent directly from this view.
    const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const w of sorted) {
      for (const a of byNode.get(w.alias) ?? []) {
        if (!a.online) continue;
        buttons.push([{ text: `▶️ ${a.name}@${w.alias}`, callback_data: `call:${a.name}@${w.alias}` }]);
      }
    }
    await sendHtml(ctx, lines.join('\n'), buttons.length > 0 ? { reply_markup: { inline_keyboard: buttons } } : undefined);
  });

  // --- /agents (grouped by machine) ---
  bot.command('agents', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const agents = getAgentList();
    if (agents.length === 0) {
      await ctx.reply('No agents registered. Connect a worker with WORKER_AGENTS to declare agents.');
      return;
    }
    // Bucket agents by node alias so the operator can see, at a glance, which
    // machine owns each agent instead of a flat list that collides on names.
    const byNode = new Map<string, { nodeName: string; online: boolean; items: typeof agents }>();
    for (const a of agents) {
      if (!byNode.has(a.nodeAlias)) {
        byNode.set(a.nodeAlias, { nodeName: a.nodeName, online: a.online, items: [] });
      }
      const g = byNode.get(a.nodeAlias)!;
      g.items.push(a);
      if (a.online) g.online = true;
    }

    const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
    const aliases = [...byNode.keys()].sort();
    const textParts: string[] = [];
    for (const alias of aliases) {
      const g = byNode.get(alias)!;
      const nameSuffix = g.nodeName && g.nodeName !== alias ? ` (${escapeHtml(g.nodeName)})` : '';
      textParts.push(`${g.online ? '🟢' : '🔴'} <b>${escapeHtml(alias)}</b>${nameSuffix}`);
      for (const a of g.items) {
        const capsStr = a.capabilities.length > 0 ? ` [${a.capabilities.join(', ')}]` : '';
        const desc = a.description ? ` — ${a.description}` : '';
        // Label shows name@alias so the user always knows which machine they
        // are targeting when they tap. callback_data carries both pieces to
        // let future routing disambiguate explicitly (Phase 2 + 4).
        const label = `${a.online ? '🟢' : '🔴'} ${a.name}@${alias}${desc}${capsStr}`;
        buttons.push([{ text: label, callback_data: `call:${a.name}@${alias}` }]);
      }
    }
    await sendHtml(ctx, `<b>Agents:</b> (tap to start)\n\n${textParts.join('\n')}`, { reply_markup: { inline_keyboard: buttons } });
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

  // --- /history (P1-1: Task History) ---
  bot.command('history', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';

    // /history <task_id> — show full detail for a specific task
    if (arg) {
      const task = getTask(arg);
      if (!task) {
        await sendHtml(ctx, `❌ Task <code>${escapeHtml(arg)}</code> not found.`);
        return;
      }
      await sendHtml(ctx, formatTaskDetail(task));
      return;
    }

    // /history — show last 20 tasks with inline buttons for detail view
    const tasks = getRecentTasksByChatId(ctx.chat!.id, 20);
    if (tasks.length === 0) {
      await ctx.reply('No task history yet.');
      return;
    }
    let text = '<b>Task history:</b>\n\n';
    const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const t of tasks) {
      const emoji = statusEmoji(t.status as TaskStatus);
      const intent = t.intent.length > 40 ? t.intent.slice(0, 40) + '...' : t.intent;
      const agent = t.agent_name ? ` → ${escapeHtml(t.agent_name)}` : '';
      const src = t.source === 'mcp' ? ' (MCP)' : t.source === 'cli' ? ' (CLI)' : '';
      const result = t.result_summary
        ? `\n   → ${escapeHtml(t.result_summary.length > 50 ? t.result_summary.slice(0, 50) + '...' : t.result_summary)}`
        : '';
      text += `${emoji} <code>${escapeHtml(t.task_id.slice(0, 8))}</code>${agent}${src} ${escapeHtml(intent)}${result}\n`;
      buttons.push([{ text: `${emoji} ${t.task_id.slice(0, 8)} — ${intent}`, callback_data: `taskdetail:${t.task_id}` }]);
    }
    await sendHtml(ctx, text, { reply_markup: { inline_keyboard: buttons } });
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
      await ctx.reply('Usage: /call <name> — or /call <name>@<alias> to target a specific machine');
      return;
    }
    // `/call claude@spot` → target that machine's claude. `/call claude` →
    // hub picks with resolveShortFormAgent rules (via getAgentByName).
    const spec = args[0];
    const atIdx = spec.lastIndexOf('@');
    const agentName = atIdx >= 0 ? spec.slice(0, atIdx) : spec;
    const alias = atIdx >= 0 ? spec.slice(atIdx + 1) : '';
    const agent = alias
      ? (getAgentByNameAndAlias(agentName, alias) ?? getAgentByName(agentName))
      : getAgentByName(agentName);
    if (!agent) {
      await sendHtml(ctx, `❌ Agent <code>${escapeHtml(spec)}</code> not found. Try /agents to see available ones.`);
      return;
    }
    // Stop existing session
    const existing = getActiveSessionByChatId(ctx.chat!.id);
    if (existing) clearActiveSession(existing.nodeId);

    const taskId = createTaskId();
    insertTask(taskId, 'telegram', `/call ${spec}`, ctx.chat!.id);
    { const r = startAgentForTask(agent, taskId, `/call ${spec}`, ctx.chat!.id, 'explicit'); await renderTaskStart(bot, ctx.chat!.id, r, taskId); }
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
    { const _qr = processNextQueued(session.nodeId); if (_qr.outcome === "started" && _qr.chatId) sendHtmlDirect(bot, _qr.chatId, `▶️ Queued task started on <code>${escapeHtml(_qr.agentName ?? "")}</code>.`); }
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
    const revoked = revokeWorker(nodeId);
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
    { const _r = startAgentForTask(agent, taskId, task.intent, ctx.chat!.id, 'explicit'); await renderTaskStart(bot, ctx.chat!.id, _r, taskId); }
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
    { const _r = startAgentForTask(agent, taskId, task.intent, ctx.chat!.id, 'explicit'); await renderTaskStart(bot, ctx.chat!.id, _r, taskId); }
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

  // --- Pairing request handler (from gateway) ---
  onPairingRequest((connId, workerName, workerDesc) => {
    const label = workerName ? `<b>${escapeHtml(workerName)}</b>${workerDesc ? ` — ${escapeHtml(workerDesc)}` : ''}` : `Connection ${escapeHtml(connId.slice(0, 8))}`;
    bot.api.sendMessage(allowedUserId, `🔗 New worker wants to pair.\n${label}\nApprove?`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `approve:${connId}` },
          { text: '❌ Reject', callback_data: `reject:${connId}` },
        ]],
      },
    }).catch((err) => console.error('[bot] Failed to send pairing request:', err));
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
    const token = ctx.match[1];
    // Accept both `call:<name>` (pre-v2.1 buttons, short form) and
    // `call:<name>@<alias>` (explicit — unambiguous when multiple nodes
    // have an agent with the same name).
    const atIdx = token.lastIndexOf('@');
    const agentName = atIdx >= 0 ? token.slice(0, atIdx) : token;
    const alias = atIdx >= 0 ? token.slice(atIdx + 1) : '';
    const agent = alias
      ? (getAgentByNameAndAlias(agentName, alias) ?? getAgentByName(agentName))
      : getAgentByName(agentName);
    if (!agent) {
      await ctx.answerCallbackQuery({ text: 'Agent not found.' });
      return;
    }
    const existing = getActiveSessionByChatId(ctx.chat!.id);
    if (existing) clearActiveSession(existing.nodeId);

    const label = alias ? `${agentName}@${alias}` : agentName;
    await ctx.answerCallbackQuery({ text: `Starting ${label}...` });
    const taskId = createTaskId();
    insertTask(taskId, 'telegram', `call:${label}`, ctx.chat!.id);
    { const _r = startAgentForTask(agent, taskId, `call:${label}`, ctx.chat!.id, 'explicit'); await renderTaskStart(bot, ctx.chat!.id, _r, taskId); }
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
    { const _r = startAgentForTask(agent, taskId, `switch:${agentName}`, ctx.chat!.id, 'user_selected'); await renderTaskStart(bot, ctx.chat!.id, _r, taskId); }
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
    // Prefer the short alias in buttons; falls back to the node's short id slice.
    const alias = (node?.alias && node.alias.length > 0) ? node.alias : nodeId.replace(/^node_/, '').slice(0, 8);
    const desc = node?.description ? `\n${escapeHtml(node.description)}` : '';

    if (agents.length === 0) {
      await ctx.editMessageText(`<b>${escapeHtml(name)}</b> ${online}${desc}\n\nNo agents on this worker.`, { parse_mode: 'HTML' });
    } else {
      const buttons = agents.map((a) => {
        const agentDesc = a.description ? ` - ${a.description}` : '';
        return [{ text: `▶️ ${a.name}@${alias}${agentDesc}`, callback_data: `call:${a.name}@${alias}` }];
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
    { const _r = startAgentForTask(agent, taskId, retryIntent, ctx.chat!.id, 'explicit'); await renderTaskStart(bot, ctx.chat!.id, _r, taskId); }
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

    { const _r = startAgentForTask(agent, taskId, task.intent, ctx.chat!.id, 'user_selected'); await renderTaskStart(bot, ctx.chat!.id, _r, taskId); }
    updatePinnedStatus();
  });

  // --- Callback: task detail (P1-1 inline history) ---
  bot.callbackQuery(/^taskdetail:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const taskId = ctx.match[1];
    const task = getTask(taskId);
    if (!task) {
      await ctx.answerCallbackQuery({ text: 'Task not found.' });
      return;
    }
    await ctx.answerCallbackQuery();
    await sendHtml(ctx, formatTaskDetail(task));
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
      { const _r = startAgentForTask(agent, taskId, text, chatId, 'default'); await renderTaskStart(bot, chatId, _r, taskId); }
      updatePinnedStatus();
      return;
    }

    // Capability-based routing (P0-5)
    const result = findAgentByCapability(text);
    if (result.type === 'none') {
      updateTaskStatus(taskId, 'failed', { error: 'No agents available' });
      await sendHtml(ctx, 'No agents online. Use /workers to check connectivity.');
      return;
    }

    if (result.type === 'matched' || result.type === 'single') {
      // Clear match — route directly
      { const _r = startAgentForTask(result.agent!, taskId, text, chatId, result.method); await renderTaskStart(bot, chatId, _r, taskId); }
      updatePinnedStatus();
      return;
    }

    // Ambiguous — ask user to pick
    updateTaskStatus(taskId, 'routed', { routing_method: 'user_selected' });
    const buttons = (result.agents ?? []).map(a => {
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
