import 'dotenv/config';
import { createWorker } from '@anyagent/sdk';
import type { WorkerConfig, SpawnParams } from '@anyagent/sdk';
import { spawnTerminal, TerminalSession } from './terminal.js';

// CLI args override env vars: --hub, --pair, --secret, --name, --desc, --agents
function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const HUB_URL = getArg('--hub') ?? process.env.HUB_URL ?? 'ws://localhost:8080';
const PAIR_CODE = getArg('--pair') ?? process.env.PAIR_CODE;
const WS_SECRET = getArg('--secret') ?? process.env.WS_SECRET;
const WORKER_NAME = getArg('--name') ?? process.env.WORKER_NAME ?? '';
const WORKER_DESC = getArg('--desc') ?? process.env.WORKER_DESCRIPTION ?? '';
const WORKER_AGENTS_RAW = getArg('--agents') ?? process.env.WORKER_AGENTS;

// Set env vars so the SDK picks them up (SDK reads process.env for auth)
if (PAIR_CODE) process.env.PAIR_CODE = PAIR_CODE;
if (WS_SECRET) process.env.WS_SECRET = WS_SECRET;

const config: WorkerConfig = {
  name: WORKER_NAME,
  description: WORKER_DESC,
  agents: [],
};

if (WORKER_AGENTS_RAW) {
  try {
    const parsed = JSON.parse(WORKER_AGENTS_RAW);
    config.agents = parsed.map((a: Record<string, unknown>) => ({
      name: a.name as string,
      binary: a.binary as string,
      args: (a.args as string[]) ?? [],
      description: (a.description as string) ?? '',
      capabilities: (a.capabilities as string[]) ?? [],
    }));
  } catch (err) {
    console.error('[worker] Failed to parse agents:', err instanceof Error ? err.message : err);
    console.error('[worker] WARNING: No agents will be declared. Fix --agents JSON or WORKER_AGENTS in .env');
  }
}

// Help flag
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
AnyAgent Worker — connect this machine to your hub

Usage:
  node dist/index.js [options]

Options:
  --hub <url>       Hub WebSocket URL (default: ws://localhost:8080)
  --pair <code>     Pairing code from /pair command (first-time only)
  --secret <token>  WS_SECRET to match hub (if hub requires it)
  --name <name>     Worker display name
  --desc <text>     Worker description
  --agents <json>   Agent declarations as JSON array
  -h, --help        Show this help

Environment variables (overridden by CLI args):
  HUB_URL, PAIR_CODE, WS_SECRET, WORKER_NAME, WORKER_DESCRIPTION, WORKER_AGENTS

Example:
  node dist/index.js --hub ws://192.168.1.5:8080 --pair ABC123 --name my-server \\
    --agents '[{"name":"claude","binary":"claude","args":[],"capabilities":["coding"]}]'
`);
  process.exit(0);
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
      // Send the task intent/context as the first stdin input so the agent knows what to do
      if (params.context) {
        session.write(params.context + '\n');
      }
    } catch (err: unknown) {
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
