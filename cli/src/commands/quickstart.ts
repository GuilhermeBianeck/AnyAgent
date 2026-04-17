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
import { spawn } from 'child_process';
import { runWireMcp } from './wire-mcp.js';

interface Args {
  wire: boolean;
  config?: string;
  port?: number;
  wsPort?: number;
  hubDir: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { wire: true, hubDir: resolve(process.env.ANYAGENT_HUB_DIR ?? './anyagent-hub') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--no-wire':   out.wire = false; break;
      case '--config':    out.config = next; i++; break;
      case '--port':      out.port = parseInt(next, 10); i++; break;
      case '--ws-port':   out.wsPort = parseInt(next, 10); i++; break;
      case '--dir':       out.hubDir = resolve(next); i++; break;
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

  // 4. Start the hub as a child process so we can see its logs but still own
  //    the terminal for Ctrl+C. Re-exec ourselves with `hub` subcommand to get
  //    the full hub boot sequence.
  console.log('');
  console.log(`[quickstart] starting hub (Ctrl+C to stop)...`);
  console.log(`[quickstart] MCP endpoint: http://127.0.0.1:${args.port ?? 3000}`);
  console.log(`[quickstart] Worker one-liner:`);
  console.log(`   npm i -g @anyagent/worker && anyagent-worker --hub ws://127.0.0.1:${args.wsPort ?? 8080} --pair $(anyagent pair)`);
  console.log('');

  const child = spawn(process.execPath, [process.argv[1], 'hub'], {
    stdio: 'inherit',
    env: { ...process.env, ANYAGENT_HUB_DIR: args.hubDir },
  });

  return new Promise<number>((resolvePromise) => {
    const forward = (sig: NodeJS.Signals): void => { child.kill(sig); };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.on('exit', (code) => resolvePromise(code ?? 0));
  });
}
