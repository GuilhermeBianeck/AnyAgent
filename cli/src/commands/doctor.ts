/**
 * `anyagent doctor` — validate a worker's config without needing to start it.
 *
 * Mirrors the worker-side `--doctor` but runs in the unified binary. Useful on
 * the HUB machine if you want to pre-flight a worker config file before copying
 * it over.
 */

import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { lookup } from 'dns';
import { promisify } from 'util';
import { resolve } from 'path';

const lookupAsync = promisify(lookup);

export async function runDoctor(argv: string[]): Promise<number> {
  const envPath = resolve(argv[0] ?? 'worker/.env');
  if (!existsSync(envPath)) {
    console.error(`[doctor] no config at ${envPath}`);
    console.error(`[doctor] usage: anyagent doctor [path/to/worker/.env]`);
    return 1;
  }

  // Parse .env manually (don't pollute this process's env)
  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
    if (m) env[m[1]] = m[2].trim();
  }

  let failed = 0;
  const ok = (label: string, detail = ''): void => { console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`); };
  const warn = (label: string, detail = ''): void => { console.log(`  ⚠ ${label}${detail ? '  ' + detail : ''}`); };
  const fail = (label: string, detail = ''): void => { console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`); failed++; };

  console.log(`anyagent doctor — ${envPath}`);

  // 1. Credentials or pair code
  if (env.NODE_ID && env.PRIVATE_KEY_HEX) ok('Credentials', `NODE_ID=${env.NODE_ID}`);
  else if (env.PAIR_CODE) warn('No saved credentials — will pair on first run', `PAIR_CODE=${env.PAIR_CODE.slice(0, 6)}…`);
  else fail('No NODE_ID/PRIVATE_KEY_HEX and no PAIR_CODE — worker cannot connect');

  // 2. Hub URL resolves
  const hubUrl = env.HUB_URL ?? 'ws://localhost:8080';
  try {
    const u = new URL(hubUrl);
    try {
      const res = await lookupAsync(u.hostname);
      ok('Hub URL resolves', `${hubUrl} → ${res.address}`);
    } catch {
      fail('Cannot resolve hub host', hubUrl);
    }
  } catch {
    fail('HUB_URL is malformed', hubUrl);
  }

  // 3. WORKER_AGENTS parses + each binary is on PATH
  if (!env.WORKER_AGENTS) {
    fail('WORKER_AGENTS not set');
  } else {
    try {
      const agents = JSON.parse(env.WORKER_AGENTS) as Array<{ name: string; binary: string }>;
      ok('WORKER_AGENTS parses', `${agents.length} agent(s)`);
      for (const a of agents) {
        const which = process.platform === 'win32' ? 'where' : 'which';
        const r = spawnSync(which, [a.binary], { encoding: 'utf-8' });
        if (r.status === 0 && r.stdout.trim()) {
          ok(`${a.name} → ${a.binary}`, r.stdout.trim().split('\n')[0]);
        } else {
          fail(`${a.name} → ${a.binary}`, 'NOT on PATH');
        }
      }
    } catch {
      fail('WORKER_AGENTS is not valid JSON');
    }
  }

  // 4. WS_SECRET hint
  if (env.WS_SECRET) ok('WS_SECRET set', 'verify it matches the hub');
  else warn('WS_SECRET not set', 'only OK if the hub has no secret');

  console.log('');
  if (failed === 0) {
    console.log('All checks passed.');
    return 0;
  }
  console.log(`${failed} check(s) failed.`);
  return 1;
}
