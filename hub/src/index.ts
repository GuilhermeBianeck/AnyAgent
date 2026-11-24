import { initLogger } from './logger.js';
import { initNetlog } from './netlog.js';
import 'dotenv/config';
// Order matters: dotenv loads .env, then logger + netlog read env flags.
initLogger();
initNetlog();
import { createBot } from './bot.js';
import { createGateway, onWorkerOnline } from './gateway.js';
import { createMcpServer, onMcpTask } from './mcp.js';
import { hasScopedTokens } from './tokens.js';
import { startCli } from './cli.js';
import { failStaleTasks, clearAllSessions, cleanOldTasks } from './db.js';
import { escapeHtml } from './format.js';
import { emit as emitEvent } from './events.js';
import { processNextQueued } from './manager.js';
import { getBuildInfo } from './build-info.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const WS_PORT = parseInt(process.env.WS_PORT ?? '8080', 10);
const WS_SECRET = process.env.WS_SECRET;
const MCP_PORT = parseInt(process.env.MCP_PORT ?? '3000', 10);
const MCP_TOKEN = process.env.MCP_TOKEN;

if (BOT_TOKEN && !ALLOWED_USER_ID) throw new Error('ALLOWED_USER_ID env var required when BOT_TOKEN is set');
const allowedUserId = parseInt(ALLOWED_USER_ID ?? '0', 10);

// Startup cleanup. NOTE: failStaleTasks only marks 'running'/'routed'/'pending_approval'
// as failed — queued tasks are intentionally preserved so they can be re-offered to
// workers when they reconnect (see onWorkerOnline below).
const stale = failStaleTasks();
if (stale > 0) console.log(`[hub] Marked ${stale} stale task(s) as failed (hub restart)`);
clearAllSessions();
cleanOldTasks(30);

const buildInfo = getBuildInfo();
console.log(`[hub] AnyAgent v${buildInfo.version} on ${buildInfo.node}`);
emitEvent('hub.started', { detail: `v${buildInfo.version}` });

// Graceful shutdown — let ongoing requests finish
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`[hub] Received ${sig}, shutting down...`);
    emitEvent('hub.stopped', { detail: sig });
    setTimeout(() => process.exit(0), 500);
  });
}

// WebSocket gateway (always starts)
const bot = BOT_TOKEN ? createBot(BOT_TOKEN, allowedUserId, { wsPort: WS_PORT, wsSecret: WS_SECRET, mcpPort: MCP_PORT, mcpToken: MCP_TOKEN }) : null;
createGateway(WS_PORT, bot, allowedUserId, WS_SECRET);

// Re-offer any queued tasks whenever a worker comes online. This covers:
//   - Hub was restarted and the worker reconnects with queued rows waiting
//   - Worker briefly dropped, reconnected within the grace window
// Loop until empty so a chain of queued tasks doesn't stall at 1-per-reconnect.
onWorkerOnline((nodeId) => {
  // processNextQueued spawns the next queued task and returns 'started' or 'empty'.
  // If the worker becomes busy immediately after spawning one, that's fine —
  // the next one will fire on the next 'session end' event.
  const result = processNextQueued(nodeId);
  if (result.outcome === 'started') {
    console.log(`[hub] Worker ${nodeId} came back — dispatched queued task ${result.taskId}`);
  }
});

// MCP server — enabled by MCP_TOKEN (admin) and/or scoped tokens from `token create`
if (MCP_TOKEN || hasScopedTokens()) {
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

  console.log(`[hub] MCP server on port ${MCP_PORT}${MCP_TOKEN ? '' : ' (scoped tokens only; MCP_TOKEN unset)'}`);
} else {
  console.log('[hub] MCP server disabled (set MCP_TOKEN, or run "token create <label>" and restart)');
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
