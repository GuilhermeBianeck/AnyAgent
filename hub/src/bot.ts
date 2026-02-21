import { Bot, Context } from 'grammy';
import { randomBytes } from 'crypto';
import { insertPairCode, getAllNodes } from './db.js';
import { isNodeOnline, sendSpawn, approvePair, rejectPair } from './gateway.js';

function guardUser(ctx: Context, allowedUserId: number): boolean {
  if (ctx.from?.id !== allowedUserId) {
    ctx.reply('⛔ Unauthorized').catch(() => {});
    return false;
  }
  return true;
}

export function createBot(token: string, allowedUserId: number): Bot {
  const bot = new Bot(token);

  bot.command('start', (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    return ctx.reply('AnyAgent Hub running. Commands: /pair, /list, /call <node_id> <binary>');
  });

  bot.command('pair', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const code = randomBytes(3).toString('hex').toUpperCase(); // 6-char hex
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
    insertPairCode(code, expiresAt, '');
    await ctx.reply(`🔑 Pairing code: \`${code}\`\nExpires in 10 minutes.\nSet PAIR_CODE=${code} on your worker.`, {
      parse_mode: 'Markdown',
    });
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
      return `• \`${n.node_id}\` ${status}`;
    });
    await ctx.reply(`Workers:\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
  });

  bot.command('call', async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const matchText = ctx.match;
    const args = typeof matchText === 'string' ? matchText.trim().split(/\s+/) : [];
    if (args.length < 2 || !args[0]) {
      await ctx.reply('Usage: /call <node_id> <binary> [args...]');
      return;
    }
    const [nodeId, binary, ...rest] = args as [string, string, ...string[]];
    const ok = sendSpawn(nodeId, binary, rest);
    if (!ok) {
      await ctx.reply(`❌ Node \`${nodeId}\` is not online or not found.`, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(`✅ Sent spawn(\`${binary}\`) to \`${nodeId}\`.`, { parse_mode: 'Markdown' });
    }
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
    await ctx.editMessageText(`✅ Approved. Node ID: \`${nodeId}\``, { parse_mode: 'Markdown' });
    await ctx.answerCallbackQuery({ text: `Approved! Node: ${nodeId}` });
  });

  bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
    if (!guardUser(ctx, allowedUserId)) return;
    const connId = ctx.match[1];
    rejectPair(connId);
    await ctx.editMessageText('❌ Pair request rejected.');
    await ctx.answerCallbackQuery({ text: 'Rejected.' });
  });

  return bot;
}
