/**
 * `anyagent quickstart` — one-command hub-side bootstrap.
 *
 * Generates WS_SECRET + MCP_TOKEN, writes hub/.env with AUTO_APPROVE_LOOPBACK=1,
 * starts the hub as a child of this process (the binary re-execs itself with
 * `anyagent hub`), writes the MCP client config. Caller sees the hub running
 * in the foreground; Ctrl+C stops it cleanly.
 *
 * The worker side is NOT started here — that still needs npm (node-pty).
 * The final summary prints the one-liner the user runs on the worker host.
 */

import { randomBytes } from 'crypto';
import { writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join, resolve } from 'path';
import { spawn, spawnSync } from 'child_process';
import { runWireMcp } from './wire-mcp.js';

/**
 * Presets — map a detected AI CLI binary to a default capability set. Mirrors
 * the list in add-worker.sh so the binary and source paths agree.
 */
const AGENT_PRESETS: Record<string, string[]> = {
  claude:  ['coding', 'refactoring', 'testing', 'shell'],
  codex:   ['coding', 'review', 'refactoring'],
  aider:   ['coding', 'git', 'refactoring'],
  ollama:  ['llm', 'chat', 'local'],
  gemini:  ['coding', 'chat'],
  bash:    ['shell', 'scripts', 'ops'],
};
const CANDIDATES = ['claude', 'codex', 'aider', 'ollama', 'gemini', 'bash'] as const;

function whichBinary(): string | null {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  for (const bin of CANDIDATES) {
    const r = spawnSync(whichCmd, [bin], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout.trim()) return bin;
  }
  return null;
}

/**
 * Build argv for re-execing ourselves with a subcommand.
 *
 * Under SEA, `process.execPath` IS the anyagent binary, so subcommands go
 * directly as arg[0]: `anyagent hub`.
 *
 * Under `node cli/dist/main.js quickstart`, we need to pass the script path
 * as arg[0] and the subcommand as arg[1]: `node main.js hub`.
 */
function selfExecArgs(sub: string, extra: string[] = []): string[] {
  let isSea = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sea = require('node:sea') as { isSea?: () => boolean };
    isSea = typeof sea.isSea === 'function' ? sea.isSea() : false;
  } catch { /* pre-22 or no SEA — treat as non-SEA */ }
  return isSea ? [sub, ...extra] : [process.argv[1]!, sub, ...extra];
}

interface Args {
  wire: boolean;
  config?: string;
  port?: number;
  wsPort?: number;
  hubDir: string;
  workerDir: string;
  /** Skip local worker spawn even if an AI CLI is on PATH. */
  hubOnly: boolean;
  /** Force a specific binary instead of PATH-autodetect. */
  binary?: string;
}

function parseArgs(argv: string[]): Args {
  const hubDir = resolve(process.env.ANYAGENT_HUB_DIR ?? './anyagent-hub');
  const out: Args = {
    wire: true,
    hubDir,
    workerDir: resolve('./anyagent-worker'),
    hubOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--no-wire':     out.wire = false; break;
      case '--config':      out.config = next; i++; break;
      case '--port':        out.port = parseInt(next, 10); i++; break;
      case '--ws-port':     out.wsPort = parseInt(next, 10); i++; break;
      case '--dir':         out.hubDir = resolve(next); i++; break;
      case '--worker-dir':  out.workerDir = resolve(next); i++; break;
      case '--hub-only':    out.hubOnly = true; break;
      case '--binary':      out.binary = next; i++; break;
    }
  }
  return out;
}

function rand(): string {
  return randomBytes(24).toString('hex');
}

export async function runQuickstart(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  // 1. Ensure the hub directory exists with data/ + logs/
  mkdirSync(join(args.hubDir, 'data'), { recursive: true, mode: 0o700 });
  mkdirSync(join(args.hubDir, 'logs'), { recursive: true, mode: 0o700 });

  // 2. Generate or reuse config
  const envPath = join(args.hubDir, '.env');
  let mcpToken: string;
  if (existsSync(envPath)) {
    // Reuse the existing token so a re-run doesn't invalidate wired MCP configs
    const { readFileSync } = await import('fs');
    const text = readFileSync(envPath, 'utf-8');
    const m = text.match(/^MCP_TOKEN=(.+)$/m);
    mcpToken = m ? m[1].trim() : rand();
    console.log(`[quickstart] reusing existing ${envPath}`);
  } else {
    mcpToken = rand();
    const wsSecret = rand();
    const mcpPort = args.port ?? 3000;
    const wsPort = args.wsPort ?? 8080;
    const envBody = [
      'ALLOWED_USER_ID=0',
      `WS_PORT=${wsPort}`,
      `WS_SECRET=${wsSecret}`,
      `MCP_PORT=${mcpPort}`,
      `MCP_TOKEN=${mcpToken}`,
      'AUTO_APPROVE_LOOPBACK=1',
      '',
    ].join('\n');
    writeFileSync(envPath, envBody, { mode: 0o600 });
    chmodSync(envPath, 0o600);
    console.log(`[quickstart] wrote ${envPath}`);
  }

  // 3. Wire MCP config (optional)
  if (args.wire) {
    const port = args.port ?? 3000;
    const wireArgs = ['--url', `http://127.0.0.1:${port}`, '--token', mcpToken];
    if (args.config) wireArgs.push('--config', args.config);
    const rc = await runWireMcp(wireArgs);
    if (rc !== 0) {
      console.error('[quickstart] wire-mcp failed; continuing with hub start');
    }
  }

  // 4. Detect an AI CLI for the local worker, unless --hub-only / no-binary.
  //    AUTO_APPROVE_LOOPBACK=1 in hub/.env means the worker auto-pairs on
  //    127.0.0.1 without any human approval.
  let workerSpec: { binary: string; caps: string[] } | null = null;
  if (!args.hubOnly) {
    const binary = args.binary ?? whichBinary();
    if (binary) {
      const caps = AGENT_PRESETS[binary] ?? ['general'];
      workerSpec = { binary, caps };
      // Seed the worker .env on first run. On subsequent runs we keep the
      // existing file (it may have a saved NODE_ID from prior pairing).
      mkdirSync(args.workerDir, { recursive: true });
      const workerEnvPath = join(args.workerDir, '.env');
      if (!existsSync(workerEnvPath)) {
        const wsPort = args.wsPort ?? 8080;
        const { readFileSync } = await import('fs');
        // Re-read WS_SECRET from hub .env (either freshly-generated or reused)
        const hubEnvText = readFileSync(envPath, 'utf-8');
        const wsSecret = (hubEnvText.match(/^WS_SECRET=(.+)$/m) ?? [,''])[1]?.trim() ?? '';
        const agents = JSON.stringify([{
          name: binary,
          binary,
          args: [],
          description: `${binary} on localhost`,
          capabilities: caps,
        }]);
        writeFileSync(workerEnvPath, [
          `HUB_URL=ws://127.0.0.1:${wsPort}`,
          `WS_SECRET=${wsSecret}`,
          `WORKER_NAME=${binary}-local`,
          'WORKER_DESCRIPTION=Quickstart local worker',
          `WORKER_AGENTS=${agents}`,
          // PAIR_CODE gets filled in below once the hub has generated one.
          '',
        ].join('\n'), { mode: 0o600 });
        chmodSync(workerEnvPath, 0o600);
      }
    }
  }

  // 5. Start the hub as a child process.
  console.log('');
  console.log(`[quickstart] starting hub (Ctrl+C to stop)...`);
  console.log(`[quickstart] MCP endpoint: http://127.0.0.1:${args.port ?? 3000}`);

  const hubChild = spawn(process.execPath, selfExecArgs('hub'), {
    stdio: 'inherit',
    env: { ...process.env, ANYAGENT_HUB_DIR: args.hubDir },
  });

  // 6. If we detected a binary, start a worker alongside. We generate a pair
  //    code via `anyagent pair` (which talks to the same SQLite file the hub
  //    is using), inject it into the worker .env, and spawn the worker.
  //    node:sqlite handles concurrent open — the two processes both hold
  //    read-write handles safely.
  let workerChild: ReturnType<typeof spawn> | null = null;
  if (workerSpec) {
    // Wait briefly for the hub to bind + schema-init before we poke its DB.
    await new Promise(r => setTimeout(r, 800));

    // Generate a pair code through the same binary (ANYAGENT_HUB_DIR points
    // at the hub's data dir so the insert hits the right SQLite file).
    const pairResult = spawnSync(process.execPath, selfExecArgs('pair'), {
      env: { ...process.env, ANYAGENT_HUB_DIR: args.hubDir },
      encoding: 'utf-8',
    });
    const code = pairResult.stdout.trim();
    if (!/^[A-F0-9]{32}$/.test(code)) {
      console.error('[quickstart] Failed to generate pair code — skipping local worker.');
    } else {
      // Splice the PAIR_CODE into the worker env (only needed on first run —
      // subsequent runs reuse saved NODE_ID/PRIVATE_KEY_HEX).
      const workerEnvPath = join(args.workerDir, '.env');
      const { readFileSync } = await import('fs');
      const text = readFileSync(workerEnvPath, 'utf-8');
      const hasCreds = /^NODE_ID=.+$/m.test(text) && /^PRIVATE_KEY_HEX=.+$/m.test(text);
      if (!hasCreds) {
        const withCode = /^PAIR_CODE=.*/m.test(text)
          ? text.replace(/^PAIR_CODE=.*/m, `PAIR_CODE=${code}`)
          : text + `PAIR_CODE=${code}\n`;
        writeFileSync(workerEnvPath, withCode, { mode: 0o600 });
      }
      console.log(`[quickstart] starting local worker (${workerSpec.binary})...`);
      workerChild = spawn(process.execPath, selfExecArgs('worker'), {
        stdio: 'inherit',
        cwd: args.workerDir,
      });
    }
  } else {
    console.log(`[quickstart] No AI CLI detected on PATH. Worker not started.`);
    console.log(`[quickstart] To add a worker yourself:`);
    console.log(`   anyagent worker --hub ws://127.0.0.1:${args.wsPort ?? 8080} --pair $(anyagent pair)`);
  }

  return new Promise<number>((resolvePromise) => {
    const forward = (sig: NodeJS.Signals): void => {
      hubChild.kill(sig);
      workerChild?.kill(sig);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    hubChild.on('exit', (code) => {
      workerChild?.kill('SIGTERM');
      resolvePromise(code ?? 0);
    });
  });
}
