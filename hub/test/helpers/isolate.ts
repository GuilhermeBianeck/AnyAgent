/**
 * Side-effect module: point the hub at a throwaway data/logs directory.
 *
 * MUST be the first import in every test file. ESM evaluates imports in order,
 * so this runs before db.ts opens `anyagent.db`. `node --test` runs each test
 * file in its own process, so every file gets a fresh, empty database.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'anyagent-test-'));
process.env.ANYAGENT_HUB_DIR = dir;
// Keep test output quiet and deterministic.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

process.on('exit', () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

export const testHubDir = dir;
