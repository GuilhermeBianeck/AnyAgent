/**
 * Worker self-check — `npm run doctor` (or `node dist/index.js --doctor`).
 *
 * Answers the operator's "is this machine set up correctly?" question without
 * waiting for a task to fail:
 *   - Do we have credentials, or just a pair code?
 *   - Is each declared agent's binary actually on PATH?
 *   - Do those binaries answer to --version within a short timeout?
 *   - Can we resolve the hub's hostname?
 *
 * Exits 0 on clean, 1 on any failure — usable from systemd ExecStartPre.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { lookup } from 'dns';
import { promisify } from 'util';

const lookupAsync = promisify(lookup);

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function ok(label: string, detail = ''): void {
  console.log(`  ${GREEN}✓${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
}
function warn(label: string, detail = ''): void {
  console.log(`  ${YELLOW}⚠${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
}
function fail(label: string, detail = ''): void {
  console.log(`  ${RED}✗${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
}

export async function runDoctor(): Promise<number> {
  console.log(`${BOLD}AnyAgent Worker — doctor${RESET}`);
  let failed = 0;

  // 1. .env present
  const envPath = join(process.cwd(), '.env');
  if (existsSync(envPath)) ok('.env present', envPath);
  else { fail('.env missing', 'run ./add-worker.sh to create one'); failed++; }

  // 2. Credentials or pair code
  const nodeId = process.env.NODE_ID;
  const privKey = process.env.PRIVATE_KEY_HEX;
  const pair = process.env.PAIR_CODE;
  if (nodeId && privKey) {
    ok('Credentials', `NODE_ID=${nodeId}`);
  } else if (pair) {
    warn('No saved credentials — will pair on first run', `PAIR_CODE=${pair.slice(0, 6)}…`);
  } else {
    fail('No NODE_ID/PRIVATE_KEY_HEX and no PAIR_CODE — worker cannot connect');
    failed++;
  }

  // 3. Hub URL resolves
  const hubUrl = process.env.HUB_URL ?? 'ws://localhost:8080';
  try {
    const u = new URL(hubUrl);
    try {
      const res = await lookupAsync(u.hostname);
      ok('Hub URL resolves', `${hubUrl} → ${res.address}`);
    } catch {
      fail('Cannot resolve hub host', hubUrl);
      failed++;
    }
  } catch {
    fail('HUB_URL is malformed', hubUrl);
    failed++;
  }

  // 4. WORKER_AGENTS parses + each binary is on PATH
  const rawAgents = process.env.WORKER_AGENTS;
  if (!rawAgents) {
    fail('WORKER_AGENTS not set', 'the worker has nothing to expose');
    failed++;
  } else {
    let agents: Array<{ name: string; binary: string }>;
    try {
      agents = JSON.parse(rawAgents) as Array<{ name: string; binary: string }>;
      ok('WORKER_AGENTS parses', `${agents.length} agent(s)`);
    } catch {
      fail('WORKER_AGENTS is not valid JSON');
      failed++;
      agents = [];
    }
    for (const agent of agents) {
      // `command -v` via shell would be simpler but not portable to Windows.
      // spawnSync with `which`/`where` keeps us deterministic.
      const whichBin = process.platform === 'win32' ? 'where' : 'which';
      const r = spawnSync(whichBin, [agent.binary], { encoding: 'utf-8' });
      if (r.status === 0 && r.stdout.trim()) {
        const path = r.stdout.trim().split('\n')[0];
        // Optional --version probe, 2s cap
        const v = spawnSync(agent.binary, ['--version'], { encoding: 'utf-8', timeout: 2000 });
        const version = (v.stdout || v.stderr).split('\n')[0].slice(0, 60).trim();
        ok(`${agent.name} → ${agent.binary}`, `${path}${version ? ` — ${version}` : ''}`);
      } else {
        fail(`${agent.name} → ${agent.binary}`, 'NOT on PATH; install it before the hub asks to spawn');
        failed++;
      }
    }
  }

  // 5. WS_SECRET consistency hint
  if (process.env.WS_SECRET) {
    ok('WS_SECRET set', 'make sure it matches the hub');
  } else {
    warn('WS_SECRET not set', 'only OK if the hub also has no secret');
  }

  console.log('');
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}All checks passed.${RESET}`);
    return 0;
  }
  console.log(`${RED}${BOLD}${failed} check(s) failed.${RESET} Fix the issues above and re-run.`);
  return 1;
}
