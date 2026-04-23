/**
 * runWorker() — the worker's actual lifecycle, as an importable function.
 *
 * Split from index.ts so the unified SEA binary (`anyagent worker`) can call
 * into the same code without triggering top-level side effects at import time.
 *
 * Configuration precedence is unchanged from the original index.ts:
 *   CLI args  >  env vars  >  defaults
 *
 * Args can come from process.argv (default) or an explicit argv passed in —
 * the latter is useful if a subcommand wants to strip its own flag first.
 */

import 'dotenv/config';
import { createWorker } from '@anyagent/sdk';
import type { WorkerConfig, SpawnParams } from '@anyagent/sdk';
import { spawnTerminal, TerminalSession } from './terminal.js';

export interface RunWorkerOptions {
  /** argv slice to parse flags from. Defaults to process.argv. */
  argv?: string[];
  /** If set, print help + exit cleanly when --help is passed (default true). */
  allowHelp?: boolean;
}

function getArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

export async function runWorker(opts: RunWorkerOptions = {}): Promise<void> {
  const argv = opts.argv ?? process.argv;
  const allowHelp = opts.allowHelp !== false;

  // --doctor is handled upstream (worker/src/index.ts) or via `anyagent doctor`.
  // Help flag
  if (allowHelp && (argv.includes('--help') || argv.includes('-h'))) {
    console.log(`
AnyAgent Worker — connect this machine to your hub

Usage:
  anyagent worker [options]                 (single-binary form)
  node worker/dist/index.js [options]       (source form)

Options:
  --hub <url>       Hub WebSocket URL (default: ws://localhost:8080)
  --pair <code>     Pairing code from /pair command (first-time only)
  --secret <token>  WS_SECRET to match hub (if hub requires it)
  --name <name>     Worker display name
  --desc <text>     Worker description
  --agents <json>   Agent declarations as JSON array
  --doctor          Self-check: validate env, agents, hub DNS, and exit
  -h, --help        Show this help

Environment variables (overridden by CLI args):
  HUB_URL, PAIR_CODE, WS_SECRET, WORKER_NAME, WORKER_DESCRIPTION, WORKER_AGENTS

Example:
  anyagent worker --hub ws://192.168.1.5:8080 --pair ABC123 --name my-server \\
    --agents '[{"name":"claude","binary":"claude","args":[],"capabilities":["coding"]}]'
`);
    return;
  }

  const HUB_URL = getArg(argv, '--hub') ?? process.env.HUB_URL ?? 'ws://localhost:8080';
  const PAIR_CODE = getArg(argv, '--pair') ?? process.env.PAIR_CODE;
  const WS_SECRET = getArg(argv, '--secret') ?? process.env.WS_SECRET;
  const WORKER_NAME = getArg(argv, '--name') ?? process.env.WORKER_NAME ?? '';
  const WORKER_DESC = getArg(argv, '--desc') ?? process.env.WORKER_DESCRIPTION ?? '';
  const WORKER_AGENTS_RAW = getArg(argv, '--agents') ?? process.env.WORKER_AGENTS;

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

  let activeTerminal: TerminalSession | null = null;

  const allowedBinaries = new Set(config.agents.map(a => a.binary));

  console.log(`[worker] Connecting to hub: ${HUB_URL}`);
  console.log(`[worker] Allowed binaries: ${[...allowedBinaries].join(', ') || '(none)'}`);

  const worker = createWorker(HUB_URL, config, {
    onSpawn(params: SpawnParams) {
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
        if (params.context) {
          // MCP's model is one-shot: we have the full intent up front and won't
          // stream more input later. Write the context line, then send Ctrl+D
          // (0x04) — the canonical-mode EOF byte — so CLIs like `codex exec`
          // and `claude -p` that read stdin to EOF actually see EOF and start
          // processing. Without this they hang waiting for more input in the PTY.
          //
          // For CLIs that would otherwise stay interactive, EOF just means "no
          // more user input for now" and the REPL exits cleanly — which is
          // exactly what MCP wants.
          session.write(params.context + '\n');
          session.write('\x04');
        }
      } catch (err: unknown) {
        // Surface the real error so SEA-asset-load / binary-missing failures
        // don't look like generic "Spawn failed" in the hub.
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[worker] spawn error:', msg);
        if (err instanceof Error && err.stack) console.error(err.stack);
        worker.sendSpawnResult(false, undefined, msg);
        worker.sendError(msg);
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

  // This function resolves only when the worker process is asked to exit.
  // createWorker() runs the WebSocket loop forever; we wait on SIGINT/SIGTERM.
  await new Promise<void>((resolvePromise) => {
    const shutdown = (): void => { resolvePromise(); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
