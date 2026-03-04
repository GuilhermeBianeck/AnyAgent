import 'dotenv/config';
import { connect } from './connection.js';
import type { WorkerConfig } from './types.js';

const HUB_URL = process.env.HUB_URL ?? 'ws://localhost:8080';

const config: WorkerConfig = {
  name: process.env.WORKER_NAME ?? '',
  description: process.env.WORKER_DESCRIPTION ?? '',
  agents: [],
};

if (process.env.WORKER_AGENTS) {
  try {
    config.agents = JSON.parse(process.env.WORKER_AGENTS);
  } catch (err) {
    console.error('[worker] Failed to parse WORKER_AGENTS:', err);
  }
}

console.log(`[worker] Connecting to hub: ${HUB_URL}`);
connect(HUB_URL, config);
