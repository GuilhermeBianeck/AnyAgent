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
  setDelegateAgent,
  getDelegateAgent,
  clearDelegateAgent,
} from './gateway.js';
import { escapeHtml } from './format.js';
import type { AgentRow } from './types.js';

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

/** Start an agent by name. Returns true on success. */
async function startAgent(ctx: Context, agent: AgentRow): Promise<boolean> {
  if (!isNodeOnline(agent.node_id)) {
    await sendHtml(ctx, `❌ Agent <code>${escapeHtml(agent.name)}</code> is on node <code>${escapeHtml(agent.node_id)}</code> but the node is offline.`);
    return false;
  }
  const agentArgs: string[] = JSON.parse(agent.args_json);
  const ok = sendSpawn(agent.node_id, agent.binary, agentArgs);
  if (!ok) {
    await sendHtml(ctx, `❌ Failed to spawn agent <code>${escapeHtml(agent.name)}</code>.`);
    return false;
  }
  setActiveSession(agent.node_id, ctx.chat!.id, agent.name);
  await sendHtml(ctx, `✅ Agent <code>${escapeHtml(agent.name)}</code> started. Send messages to interact. /stop to end.`);
  return true;
}

export function createBot(token: string, allowedUserId: number): Bot {
  const bot = new Bot(token);

  // --- TTY output buffering ---
  const outputBuffers = new Map<number, string>();
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  function startFlushing(): void {
    if (flushTimer) return;
    flushTimer = setInterval(async () => {
      for (const [chatId, text] of outputBuffers) {
        if (!text) continue;
        outputBuffers.set(chatId, '');
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

  onTtyOutput((nodeId, data) => {
    const session = getActiveSession(nodeId);
    if (session) {
      appendOutput(session.chatId, data.toString('utf-8'));
    }
  });

  // --- /start ---
  bot.command('start', (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    return sendHtml(ctx,
      '<b>AnyAgent Hub</b> running.\n\n' +
      '/pair — Generate a pairing code\n' +
      '/devices — List registered devices\n' +
      '/agents — List agents (tap to call)\n' +
      '/call <code>&lt;name&gt;</code> — Start an agent session\n' +
      '/switch — Switch active agent\n' +
      '/stop — Stop the active session\n' +
      '/delegate — Set default agent for auto-spawn\n' +
      '/status — Show current status'
    );
  });

  // --- /pair ---
  bot.command('pair', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const code = randomBytes(3).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    insertPairCode(code, expiresAt, '');
    await sendHtml(ctx, `🔑 Pairing code: <code>${escapeHtml(code)}</code>\nExpires in 10 minutes.\nSet <code>PAIR_CODE=${escapeHtml(code)}</code> on your worker.`);
  });

  // --- /devices (alias: /list) ---
  async function handleDevices(ctx: Context): Promise<void> {
    if (!guardUser(ctx, allowedUserId)) return;
    const nodes = getAllNodes();
    if (nodes.length === 0) {
      await ctx.reply('No devices registered. Use /pair to add one.');
      return;
    }
    const buttons = nodes.map((n) => {
      const status = isNodeOnline(n.node_id) ? '🟢' : '🔴';
      const label = n.name || n.node_id;
      const desc = n.description ? ` — ${n.description}` : '';
      return [{ text: `${status} ${label}${desc}`, callback_data: `device:${n.node_id}` }];
    });
    await sendHtml(ctx, '<b>Devices:</b>', {
      reply_markup: { inline_keyboard: buttons },
    });
  }

  bot.command('devices', handleDevices);
  bot.command('list', handleDevices);

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
      const desc = a.description ? ` - ${a.description}` : '';
      return [{ text: `${online} ${a.name}${desc}`, callback_data: `call:${a.name}` }];
    });
    await sendHtml(ctx, '<b>Agents:</b> (tap to start)', {
      reply_markup: { inline_keyboard: buttons },
    });
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
    await sendHtml(ctx, '<b>Switch to:</b>', {
      reply_markup: { inline_keyboard: buttons },
    });
  });

  // --- /status ---
  bot.command('status', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const chatId = ctx.chat!.id;
    const session = getActiveSessionByChatId(chatId);
    const delegate = getDelegateAgent(chatId);
    const nodes = getAllNodes();
    const agents = getAllAgents();
    const onlineNodes = nodes.filter((n) => isNodeOnline(n.node_id));

    let text = '<b>Status</b>\n';
    text += session
      ? `Active session: <code>${escapeHtml(session.agentName ?? session.nodeId)}</code>\n`
      : 'Active session: none\n';
    text += delegate
      ? `Default agent: <code>${escapeHtml(delegate)}</code>\n`
      : 'Default agent: none\n';
    text += `Devices: ${onlineNodes.length}/${nodes.length} online\n`;
    text += `Agents: ${agents.length} registered`;
    await sendHtml(ctx, text);
  });

  // --- /delegate ---
  bot.command('delegate', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const name = typeof ctx.match === 'string' ? ctx.match.trim() : '';

    if (name === 'off' || name === 'clear') {
      clearDelegateAgent(ctx.chat!.id);
      await ctx.reply('Delegate agent cleared.');
      return;
    }

    if (name) {
      const agent = getAgentByName(name);
      if (!agent) {
        await sendHtml(ctx, `❌ Agent <code>${escapeHtml(name)}</code> not found.`);
        return;
      }
      setDelegateAgent(ctx.chat!.id, name);
      await sendHtml(ctx, `✅ Default agent set to <code>${escapeHtml(name)}</code>. Just type to interact.`);
      return;
    }

    // No arg: show inline keyboard
    const agents = getAllAgents().filter((a) => isNodeOnline(a.node_id));
    if (agents.length === 0) {
      await ctx.reply('No online agents available.');
      return;
    }
    const buttons = agents.map((a) => {
      const desc = a.description ? ` - ${a.description}` : '';
      return [{ text: `${a.name}${desc}`, callback_data: `delegate:${a.name}` }];
    });
    buttons.push([{ text: '❌ Clear delegate', callback_data: 'delegate:__clear__' }]);
    await sendHtml(ctx, '<b>Set default agent:</b>', {
      reply_markup: { inline_keyboard: buttons },
    });
  });

  // --- /call ---
  bot.command('call', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const matchText = ctx.match;
    const args = typeof matchText === 'string' ? matchText.trim().split(/\s+/) : [];
    if (args.length < 1 || !args[0]) {
      await ctx.reply('Usage: /call <agent_name>  or  /call <node_id> <binary> [args...]');
      return;
    }

    const agent = getAgentByName(args[0]);
    if (agent) {
      await startAgent(ctx, agent);
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

  // --- Agent management (kept for manual use) ---
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
      await sendHtml(ctx, `❌ Node <code>${escapeHtml(nodeId)}</code> not found. Use /devices to see available nodes.`);
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
  });

  bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const connId = ctx.match[1];
    rejectPair(connId);
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
    // Stop existing session if any
    const existing = getActiveSessionByChatId(ctx.chat!.id);
    if (existing) clearActiveSession(existing.nodeId);

    await ctx.answerCallbackQuery({ text: `Starting ${agentName}...` });
    await startAgent(ctx, agent);
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
    // Stop existing session
    const existing = getActiveSessionByChatId(ctx.chat!.id);
    if (existing) clearActiveSession(existing.nodeId);

    await ctx.answerCallbackQuery({ text: `Switching to ${agentName}...` });
    await startAgent(ctx, agent);
  });

  // --- Callback: device detail ---
  bot.callbackQuery(/^device:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const nodeId = ctx.match[1];
    const agents = getAllAgents().filter((a) => a.node_id === nodeId);
    const online = isNodeOnline(nodeId) ? '🟢 online' : '🔴 offline';
    const nodes = getAllNodes();
    const node = nodes.find((n) => n.node_id === nodeId);
    const name = node?.name || nodeId;
    const desc = node?.description ? `\n${escapeHtml(node.description)}` : '';

    if (agents.length === 0) {
      await ctx.editMessageText(`<b>${escapeHtml(name)}</b> ${online}${desc}\n\nNo agents on this device.`, { parse_mode: 'HTML' });
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

  // --- Callback: delegate agent ---
  bot.callbackQuery(/^delegate:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const agentName = ctx.match[1];

    if (agentName === '__clear__') {
      clearDelegateAgent(ctx.chat!.id);
      await ctx.editMessageText('Delegate agent cleared.');
      await ctx.answerCallbackQuery({ text: 'Cleared.' });
      return;
    }

    setDelegateAgent(ctx.chat!.id, agentName);
    await ctx.editMessageText(`✅ Default agent set to <b>${escapeHtml(agentName)}</b>. Just type to interact.`, { parse_mode: 'HTML' });
    await ctx.answerCallbackQuery({ text: `Delegate: ${agentName}` });
  });

  // --- Plain text → active session or delegate auto-spawn ---
  bot.on('message:text', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const chatId = ctx.chat!.id;

    // If there's an active session, route input there
    const session = getActiveSessionByChatId(chatId);
    if (session) {
      const ok = sendTtyInput(session.nodeId, ctx.message.text + '\n');
      if (!ok) {
        await ctx.reply('⚠️ Failed to send input — node may be offline.');
        clearActiveSession(session.nodeId);
      }
      return;
    }

    // No active session: check for delegate agent
    const delegateName = getDelegateAgent(chatId);
    if (delegateName) {
      const agent = getAgentByName(delegateName);
      if (!agent) {
        await sendHtml(ctx, `⚠️ Delegate agent <code>${escapeHtml(delegateName)}</code> no longer exists. Clearing.`);
        clearDelegateAgent(chatId);
        return;
      }
      const started = await startAgent(ctx, agent);
      if (started) {
        // Send the text as first input
        sendTtyInput(agent.node_id, ctx.message.text + '\n');
      }
      return;
    }

    // No session, no delegate — ignore
  });

  return bot;
}
