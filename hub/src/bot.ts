import { Bot, Context } from 'grammy';
import { randomBytes } from 'crypto';
import { insertPairCode, getAllNodes, insertAgent, getAgentByName, getAllAgents, deleteAgent, nodeExists } from './db.js';
import {
  isNodeOnline,
  sendSpawn,
  approvePair,
  rejectPair,
  onTtyOutput,
  setActiveSession,
  getActiveSession,
  getActiveSessionByChatId,
  clearActiveSession,
  sendTtyInput,
} from './gateway.js';
import { escapeHtml } from './format.js';

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

/**
 * Send a Telegram message with HTML parse mode. If Telegram rejects the HTML,
 * retry once as plain text (following openclaw's fallback pattern).
 */
async function sendHtml(ctx: Context, html: string, extra: Record<string, unknown> = {}): Promise<void> {
  try {
    await ctx.reply(html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  } catch {
    // Fallback: strip HTML tags and send as plain text.
    // Loop until stable to handle nested/malformed fragments like <scr<b>ipt>.
    let plain = html;
    let prev: string;
    do {
      prev = plain;
      plain = plain.replace(/<[^>]*>/g, '');
    } while (plain !== prev);
    await ctx.reply(plain);
  }
}

export function createBot(token: string, allowedUserId: number): Bot {
  const bot = new Bot(token);

  // --- TTY output buffering ---
  const outputBuffers = new Map<number, string>(); // chatId → buffered text
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  function startFlushing(): void {
    if (flushTimer) return;
    flushTimer = setInterval(async () => {
      for (const [chatId, text] of outputBuffers) {
        if (!text) continue;
        outputBuffers.set(chatId, '');
        // Telegram max message length is 4096
        const chunks = splitMessage(text, 4000);
        for (const chunk of chunks) {
          try {
            const escaped = escapeHtml(chunk);
            await bot.api.sendMessage(chatId, `<pre>${escaped}</pre>`, { parse_mode: 'HTML' });
          } catch (err) {
            console.error('[bot] Failed to send TTY output:', err);
          }
        }
      }
    }, 1000);
  }

  function appendOutput(chatId: number, data: string): void {
    const existing = outputBuffers.get(chatId) ?? '';
    outputBuffers.set(chatId, existing + data);
    startFlushing();
  }

  // Register TTY output callback
  onTtyOutput((nodeId, data) => {
    const session = getActiveSession(nodeId);
    if (session) {
      appendOutput(session.chatId, data.toString('utf-8'));
    }
  });

  bot.command('start', (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    return sendHtml(ctx,
      '<b>AnyAgent Hub</b> running.\n\n' +
      '/pair — Generate a pairing code for a new worker\n' +
      '/list — List registered workers\n' +
      '/agents — List registered agents\n' +
      '/register <code>&lt;name&gt; &lt;node_id&gt; &lt;binary&gt; [args]</code> — Register an agent\n' +
      '/unregister <code>&lt;name&gt;</code> — Remove an agent\n' +
      '/call <code>&lt;agent_name&gt;</code> — Start an agent session\n' +
      '/stop — Stop the active session\n\n' +
      'Send plain text to interact with the active session.'
    );
  });

  bot.command('pair', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const code = randomBytes(3).toString('hex').toUpperCase(); // 6-char hex
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
    insertPairCode(code, expiresAt, '');
    await sendHtml(ctx, `🔑 Pairing code: <code>${escapeHtml(code)}</code>\nExpires in 10 minutes.\nSet <code>PAIR_CODE=${escapeHtml(code)}</code> on your worker.`);
  });

  bot.command('list', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const nodes = getAllNodes();
    if (nodes.length === 0) {
      await ctx.reply('No approved workers found.');
      return;
    }
    const lines = nodes.map((n) => {
      const status = isNodeOnline(n.node_id) ? '🟢 online' : '🔴 offline';
      return `• <code>${escapeHtml(n.node_id)}</code> ${status}`;
    });
    await sendHtml(ctx, `<b>Workers:</b>\n${lines.join('\n')}`);
  });

  bot.command('call', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const matchText = ctx.match;
    const args = typeof matchText === 'string' ? matchText.trim().split(/\s+/) : [];
    if (args.length < 1 || !args[0]) {
      await ctx.reply('Usage: /call <agent_name>  or  /call <node_id> <binary> [args...]');
      return;
    }

    // Check if first arg is a registered agent name
    const agent = getAgentByName(args[0]);
    if (agent) {
      if (!isNodeOnline(agent.node_id)) {
        await sendHtml(ctx, `❌ Agent <code>${escapeHtml(agent.name)}</code> is registered on node <code>${escapeHtml(agent.node_id)}</code> but the node is offline.`);
        return;
      }
      const agentArgs: string[] = JSON.parse(agent.args_json);
      const ok = sendSpawn(agent.node_id, agent.binary, agentArgs);
      if (!ok) {
        await sendHtml(ctx, `❌ Failed to spawn agent <code>${escapeHtml(agent.name)}</code>.`);
        return;
      }
      setActiveSession(agent.node_id, ctx.chat!.id, agent.name);
      await sendHtml(ctx, `✅ Agent <code>${escapeHtml(agent.name)}</code> started on <code>${escapeHtml(agent.node_id)}</code>.\nSend messages here to interact. Use /stop to end.`);
      return;
    }

    // Fallback: treat as node_id + binary
    if (args.length < 2) {
      await sendHtml(ctx, `❌ Agent <code>${escapeHtml(args[0])}</code> not found. For direct call use: /call <code>&lt;node_id&gt; &lt;binary&gt; [args...]</code>`);
      return;
    }
    const [nodeId, binary, ...rest] = args as [string, string, ...string[]];
    const ok = sendSpawn(nodeId, binary, rest);
    if (!ok) {
      await sendHtml(ctx, `❌ Node <code>${escapeHtml(nodeId)}</code> is not online or not found.`);
    } else {
      setActiveSession(nodeId, ctx.chat!.id);
      await sendHtml(ctx, `✅ Sent spawn(<code>${escapeHtml(binary)}</code>) to <code>${escapeHtml(nodeId)}</code>.\nSend messages here to interact. Use /stop to end.`);
    }
  });

  // --- Agent management commands ---

  bot.command('agents', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const agents = getAllAgents();
    if (agents.length === 0) {
      await ctx.reply('No agents registered. Use /register <name> <node_id> <binary> [args...]');
      return;
    }
    const lines = agents.map((a) => {
      const online = isNodeOnline(a.node_id) ? '🟢' : '🔴';
      const agentArgs: string[] = JSON.parse(a.args_json);
      const argsStr = agentArgs.length > 0 ? ` ${agentArgs.join(' ')}` : '';
      return `${online} <code>${escapeHtml(a.name)}</code> → <code>${escapeHtml(a.node_id)}</code> (<code>${escapeHtml(a.binary + argsStr)}</code>)`;
    });
    await sendHtml(ctx, `<b>Agents:</b>\n${lines.join('\n')}`);
  });

  bot.command('register', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const matchText = ctx.match;
    const args = typeof matchText === 'string' ? matchText.trim().split(/\s+/) : [];
    if (args.length < 3 || !args[0]) {
      await ctx.reply('Usage: /register <name> <node_id> <binary> [args...]');
      return;
    }
    const [name, nodeId, binary, ...rest] = args as [string, string, string, ...string[]];
    if (!nodeExists(nodeId)) {
      await sendHtml(ctx, `❌ Node <code>${escapeHtml(nodeId)}</code> not found. Use /list to see available nodes.`);
      return;
    }
    const existing = getAgentByName(name);
    if (existing) {
      await sendHtml(ctx, `❌ Agent <code>${escapeHtml(name)}</code> is already registered. Use /unregister first.`);
      return;
    }
    try {
      insertAgent(name, nodeId, binary, rest);
      await sendHtml(ctx, `✅ Agent <code>${escapeHtml(name)}</code> registered: <code>${escapeHtml(binary)}</code> on <code>${escapeHtml(nodeId)}</code>.`);
    } catch (err) {
      await ctx.reply(`❌ Failed to register agent: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command('unregister', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const name = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (!name) {
      await ctx.reply('Usage: /unregister <name>');
      return;
    }
    const deleted = deleteAgent(name);
    if (deleted) {
      await sendHtml(ctx, `✅ Agent <code>${escapeHtml(name)}</code> removed.`);
    } else {
      await sendHtml(ctx, `❌ Agent <code>${escapeHtml(name)}</code> not found.`);
    }
  });

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
  });

  // Inline keyboard callbacks for approve/reject
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
  });

  bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const connId = ctx.match[1];
    rejectPair(connId);
    await ctx.editMessageText('❌ Pair request rejected.');
    await ctx.answerCallbackQuery({ text: 'Rejected.' });
  });

  // --- Plain text → active session TTY input ---
  bot.on('message:text', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const session = getActiveSessionByChatId(ctx.chat!.id);
    if (!session) return; // No active session, ignore
    const ok = sendTtyInput(session.nodeId, ctx.message.text + '\n');
    if (!ok) {
      await ctx.reply('⚠️ Failed to send input — node may be offline.');
      clearActiveSession(session.nodeId);
    }
  });

  return bot;
}
