import 'dotenv/config';
import { createBot } from './bot.js';
import { createGateway } from './gateway.js';
import { createMcpServer, onMcpTask } from './mcp.js';
import { startCli } from './cli.js';
import { failStaleTasks, clearAllSessions, cleanOldTasks } from './db.js';
import { escapeHtml } from './format.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const WS_PORT = parseInt(process.env.WS_PORT ?? '8080', 10);
const WS_SECRET = process.env.WS_SECRET;
const MCP_PORT = parseInt(process.env.MCP_PORT ?? '3000', 10);
const MCP_TOKEN = process.env.MCP_TOKEN;

if (!ALLOWED_USER_ID) throw new Error('ALLOWED_USER_ID env var required');
const allowedUserId = parseInt(ALLOWED_USER_ID, 10);

// Startup cleanup
const stale = failStaleTasks();
if (stale > 0) console.log(`[hub] Marked ${stale} stale task(s) as failed`);
clearAllSessions();
cleanOldTasks(30);

// WebSocket gateway (always starts)
const bot = BOT_TOKEN ? createBot(BOT_TOKEN, allowedUserId, { wsPort: WS_PORT, wsSecret: WS_SECRET, mcpPort: MCP_PORT, mcpToken: MCP_TOKEN }) : null;
createGateway(WS_PORT, bot, allowedUserId, WS_SECRET);

// MCP server (if token set)
if (MCP_TOKEN) {
  createMcpServer(MCP_PORT, MCP_TOKEN);

  if (bot) {
    onMcpTask((task) => {
      bot.api.sendMessage(
        allowedUserId,
        `MCP: <i>${escapeHtml(task.intent.length > 80 ? task.intent.slice(0, 80) + '...' : task.intent)}</i> → <code>${escapeHtml(task.agent_name ?? 'unknown')}</code>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    });
  }

  console.log(`[hub] MCP server on port ${MCP_PORT}`);
} else {
  console.log('[hub] MCP server disabled (set MCP_TOKEN to enable)');
}

// Telegram bot (optional — only if BOT_TOKEN set)
if (bot) {
  bot.start();
  console.log('[hub] Telegram bot started');
} else {
  console.log('[hub] Telegram bot disabled (set BOT_TOKEN to enable)');
}

// CLI always available
startCli();

// Daily cleanup
setInterval(() => cleanOldTasks(30), 24 * 60 * 60 * 1000);

console.log(`[hub] WebSocket gateway on port ${WS_PORT}`);
console.log('[hub] Ready. Type "help" for CLI commands.');
