import 'dotenv/config';
import { createBot } from './bot.js';
import { createGateway } from './gateway.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const WS_PORT = parseInt(process.env.WS_PORT ?? '8080', 10);
const WS_SECRET = process.env.WS_SECRET;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN env var required');
if (!ALLOWED_USER_ID) throw new Error('ALLOWED_USER_ID env var required');

const allowedUserId = parseInt(ALLOWED_USER_ID, 10);

const bot = createBot(BOT_TOKEN, allowedUserId);
createGateway(WS_PORT, bot, allowedUserId, WS_SECRET);

bot.start();
console.log('[hub] Bot started.');
