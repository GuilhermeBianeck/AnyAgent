import 'dotenv/config';
import { createBot } from './bot.js';
import { createGateway } from './gateway.js';
import { createMcpServer, onMcpTask } from './mcp.js';
import { failStaleTasks, clearAllSessions, cleanOldTasks } from './db.js';
import { escapeHtml } from './format.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const WS_PORT = parseInt(process.env.WS_PORT ?? '8080', 10);
const WS_SECRET = process.env.WS_SECRET;
const MCP_PORT = parseInt(process.env.MCP_PORT ?? '3000', 10);
const MCP_TOKEN = process.env.MCP_TOKEN;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN env var required');
if (!ALLOWED_USER_ID) throw new Error('ALLOWED_USER_ID env var required');

const allowedUserId = parseInt(ALLOWED_USER_ID, 10);

// Startup cleanup: fail any tasks orphaned by prior hub crash
const stale = failStaleTasks();
if (stale > 0) console.log(`[hub] Marked ${stale} stale task(s) as failed`);
clearAllSessions();
cleanOldTasks(30);

const bot = createBot(BOT_TOKEN, allowedUserId);
createGateway(WS_PORT, bot, allowedUserId, WS_SECRET);

// MCP server (opt-in: requires MCP_TOKEN to enable)
if (MCP_TOKEN) {
  createMcpServer(MCP_PORT, MCP_TOKEN);

  onMcpTask((task) => {
    bot.api.sendMessage(
      allowedUserId,
      `MCP: <i>${escapeHtml(task.intent.length > 80 ? task.intent.slice(0, 80) + '...' : task.intent)}</i> → <code>${escapeHtml(task.agent_name ?? 'unknown')}</code>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  });

  console.log(`[hub] MCP server enabled on port ${MCP_PORT}`);
} else {
  console.log('[hub] MCP server disabled (set MCP_TOKEN to enable)');
}

// Daily cleanup of old tasks
setInterval(() => cleanOldTasks(30), 24 * 60 * 60 * 1000);

bot.start();
console.log('[hub] Bot started.');
