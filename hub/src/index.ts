import 'dotenv/config';
import { createBot } from './bot.js';
import { createGateway } from './gateway.js';
import { createMcpServer, onMcpTask } from './mcp.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const WS_PORT = parseInt(process.env.WS_PORT ?? '8080', 10);
const WS_SECRET = process.env.WS_SECRET;
const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : undefined;
const MCP_TOKEN = process.env.MCP_TOKEN;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN env var required');
if (!ALLOWED_USER_ID) throw new Error('ALLOWED_USER_ID env var required');

const allowedUserId = parseInt(ALLOWED_USER_ID, 10);

const bot = createBot(BOT_TOKEN, allowedUserId);
createGateway(WS_PORT, bot, allowedUserId, WS_SECRET);

// MCP server (opt-in: requires MCP_PORT and MCP_TOKEN)
if (MCP_PORT && MCP_TOKEN) {
  createMcpServer(MCP_PORT, MCP_TOKEN);

  // Notify Telegram when MCP tasks are created
  onMcpTask((task) => {
    bot.api.sendMessage(
      allowedUserId,
      `MCP: <i>${task.intent}</i> → <code>${task.agent_name}</code> on <code>${task.node_id}</code>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  });

  console.log(`[hub] MCP server enabled on port ${MCP_PORT}`);
} else if (MCP_PORT && !MCP_TOKEN) {
  console.warn('[hub] MCP_PORT set but MCP_TOKEN missing — MCP server disabled (token required for security)');
}

bot.start();
console.log('[hub] Bot started.');
