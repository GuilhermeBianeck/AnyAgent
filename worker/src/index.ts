import 'dotenv/config';
import { createWorker } from '@anyagent/sdk';
import type { WorkerConfig, SpawnParams } from '@anyagent/sdk';
import { spawnTerminal, TerminalSession } from './terminal.js';

const HUB_URL = process.env.HUB_URL ?? 'ws://localhost:8080';

const config: WorkerConfig = {
  name: process.env.WORKER_NAME ?? '',
  description: process.env.WORKER_DESCRIPTION ?? '',
  agents: [],
};

if (process.env.WORKER_AGENTS) {
  try {
    const parsed = JSON.parse(process.env.WORKER_AGENTS);
    // Support both v1 format (no capabilities) and v2 format (with capabilities)
    config.agents = parsed.map((a: Record<string, unknown>) => ({
      name: a.name as string,
      binary: a.binary as string,
      args: (a.args as string[]) ?? [],
      description: (a.description as string) ?? '',
      capabilities: (a.capabilities as string[]) ?? [],
    }));
  } catch (err) {
    console.error('[worker] Failed to parse WORKER_AGENTS:', err);
  }
}

let activeTerminal: TerminalSession | null = null;

// Build allowlist from declared agents — only these binaries can be spawned
const allowedBinaries = new Set(config.agents.map(a => a.binary));

console.log(`[worker] Connecting to hub: ${HUB_URL}`);
console.log(`[worker] Allowed binaries: ${[...allowedBinaries].join(', ') || '(none)'}`);

const worker = createWorker(HUB_URL, config, {
  onSpawn(params: SpawnParams) {
    // Security: reject binaries not in the declared agent allowlist
    if (!allowedBinaries.has(params.binary)) {
      const msg = `Spawn rejected: binary "${params.binary}" not in allowlist`;
      console.warn(`[worker] ${msg}`);
      worker.sendSpawnResult(false, undefined, msg);
      return;
    }

    try {
      const session = spawnTerminal(
        params.binary,
        params.args ?? [],
        (data: Buffer) => worker.sendRawOutput(data),
        (code: number) => {
          activeTerminal = null;
          worker.sendExit(code);
        }
      );
      activeTerminal = session;
      worker.sendSpawnResult(true, session.pid);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      worker.sendSpawnResult(false, undefined, 'Spawn failed');
      worker.sendError('Spawn failed');
    }
  },

  onKill() {
    if (activeTerminal) {
      activeTerminal.kill();
      activeTerminal = null;
    }
  },

  onResize(cols: number, rows: number) {
    activeTerminal?.resize(cols, rows);
  },

  onInput(data: string) {
    activeTerminal?.write(data);
  },
});
