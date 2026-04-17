/**
 * Runtime path resolution — where to find .env, data/, logs/, package.json.
 *
 * Two runtime modes:
 *
 *   A. `npm start` from hub/: this module is loaded from hub/dist/paths.js,
 *      so `import.meta.url` points at hub/dist/. The canonical hub root is
 *      one directory up, and data/ + logs/ live there.
 *
 *   B. Packaged as a single-file SEA binary: `import.meta.url` points INSIDE
 *      the binary's virtual filesystem, which is useless for disk I/O. We
 *      resolve against the user's cwd (or $ANYAGENT_HUB_DIR if set by
 *      `anyagent quickstart`).
 *
 * Precedence (always):
 *   1. $ANYAGENT_HUB_DIR if set
 *   2. SEA? → process.cwd()
 *   3. hub/dist's parent (the default `npm start` layout)
 */

import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// node:sea exposes isSea() at runtime. We use createRequire rather than
// `await import(...)` so callers of hubRoot() don't need to be async — path
// resolution needs to be synchronous for the logger/db/events module-load paths.
let seaCache: boolean | null = null;
function runningUnderSea(): boolean {
  if (seaCache !== null) return seaCache;
  try {
    const r = createRequire(import.meta.url);
    const sea = r('node:sea') as { isSea?: () => boolean };
    seaCache = typeof sea.isSea === 'function' ? sea.isSea() : false;
  } catch {
    seaCache = false;
  }
  return seaCache;
}

export function hubRoot(): string {
  const fromEnv = process.env.ANYAGENT_HUB_DIR;
  if (fromEnv) return resolve(fromEnv);
  if (runningUnderSea()) return resolve(process.cwd());
  // `npm start` path: this file is hub/dist/paths.js → hub root is one up
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..');
  } catch {
    // `import.meta.url` is empty when bundled to CJS — fall back to cwd
    return resolve(process.cwd());
  }
}

export function dataDir(): string { return join(hubRoot(), 'data'); }
export function logsDir(): string { return join(hubRoot(), 'logs'); }
