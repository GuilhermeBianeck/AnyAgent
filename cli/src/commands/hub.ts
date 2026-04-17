/**
 * `anyagent hub` — boot the hub.
 *
 * The hub's source module hub/src/index.ts has top-level side effects that
 * start the gateway + MCP server + CLI. Importing it is all we need.
 *
 * When the binary is run, its cwd may be anywhere. The hub expects:
 *   hub/.env     — config
 *   hub/data/    — SQLite file
 *   hub/logs/    — log output
 *
 * If $ANYAGENT_HUB_DIR is set, we cwd there. Otherwise we stay in the current
 * directory (so `cd myhub && anyagent hub` works intuitively).
 */

/**
 * Exported as `runHub()` rather than side-effectful top-level code, because:
 *   - SEA only supports CJS entry points, and CJS can't use top-level await
 *   - main.ts calls `await runHub()` from inside `async function main()`,
 *     which is fine
 */

import { chdir } from 'process';
import { existsSync } from 'fs';
import { resolve } from 'path';

export async function runHub(): Promise<number> {
  const hubDir = process.env.ANYAGENT_HUB_DIR;
  if (hubDir) {
    const abs = resolve(hubDir);
    if (!existsSync(abs)) {
      console.error(`[anyagent] ANYAGENT_HUB_DIR does not exist: ${abs}`);
      return 1;
    }
    chdir(abs);
  }

  // Top-level side effects in hub/src/index.ts initialize the hub (start
  // gateway, MCP server, CLI). The dynamic import triggers them.
  await import('../../../hub/src/index.js');
  // index.ts doesn't exit — it keeps servers running. Return a value just so
  // Promise<number> shape holds; we never reach here in practice.
  return new Promise<number>(() => { /* never resolves */ });
}
