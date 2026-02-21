import 'dotenv/config';
import { connect } from './connection.js';

const HUB_URL = process.env.HUB_URL ?? 'ws://localhost:8080';

console.log(`[worker] Connecting to hub: ${HUB_URL}`);
connect(HUB_URL);
