/**
 * node-pty loader shim — swapped in at bundle time for node-pty/lib/utils.js.
 *
 * Why this exists
 * ---------------
 * node-pty ships platform-specific .node files under prebuilds/. Its original
 * loadNativeModule() does `require('./prebuilds/<platform>-<arch>/pty.node')`,
 * which depends on a real filesystem layout. SEA binaries have no filesystem
 * — there's just the blob. So we embed pty.node as a SEA asset and, at first
 * call, write it to a tempdir and dlopen() it directly.
 *
 * esbuild rewrites `require('./utils')` inside node-pty/lib/unixTerminal.js
 * (and others) to import this file. The exports match exactly what the
 * original utils.js provided: `loadNativeModule` + `assign`.
 *
 * Exists in CJS (.cjs) because it's consumed by other CJS code that's been
 * transpiled from CommonJS-source node-pty — the loader call sites use CJS
 * require, so a CJS shim keeps things uniform.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function assign(target, ...sources) {
  for (const source of sources) {
    for (const key of Object.keys(source)) target[key] = source[key];
  }
  return target;
}

// node:sea is only present in Node 22+. Wrap in try/catch so we still run on
// older Node for tests.
function seaModule() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:sea');
  } catch {
    return null;
  }
}

/** Cache: module name → loaded native module (only loaded once per process). */
const cache = new Map();

// Extract a SEA asset to a cached tmp path. Returns the absolute path.
// Reuses existing file if size matches (fast path on repeated runs).
function extractAsset(cacheDir, key, fileName, fileMode) {
  const sea = seaModule();
  const dst = path.join(cacheDir, fileName);
  let assetBuf;
  try {
    assetBuf = sea.getAsset(key);
  } catch (err) {
    throw new Error(`[node-pty-shim] SEA asset '${key}' not embedded. Rebuild the binary. ` + (err && err.message));
  }
  const incoming = Buffer.from(assetBuf);
  let needsWrite = true;
  try {
    const stat = fs.statSync(dst);
    if (stat.size === incoming.length) needsWrite = false;
  } catch { /* missing → write */ }
  if (needsWrite) {
    fs.writeFileSync(dst, incoming, { mode: fileMode });
  }
  // Always re-chmod on every run — a previous write with the wrong mode would
  // otherwise persist.
  try { fs.chmodSync(dst, fileMode); } catch { /* best effort */ }
  return dst;
}

function loadFromSea(name) {
  const sea = seaModule();
  if (!sea || typeof sea.isSea !== 'function' || !sea.isSea()) return null;

  // node-pty needs both:
  //   - pty.node          (the native addon, loaded via dlopen)
  //   - spawn-helper      (an executable the addon launches to prepare the TTY)
  // Both live in the same directory at runtime; the build script embeds them
  // as SEA assets with these keys.
  const cacheDir = path.join(os.tmpdir(), `anyagent-pty-${process.versions.node}`);
  try { fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 }); } catch { /* best effort */ }

  const nodePath = extractAsset(cacheDir, `${name}.node`, `${name}.node`, 0o600);

  // spawn-helper is only needed for the main 'pty' addon on Unix.
  if (name === 'pty' && process.platform !== 'win32') {
    try {
      // 0o700 — the binary needs the executable bit so posix_spawnp can run it.
      extractAsset(cacheDir, 'spawn-helper', 'spawn-helper', 0o700);
    } catch (err) {
      // If this fails, posix_spawnp later will throw "posix_spawnp failed"
      // with no context. Surface here so operators see the root cause.
      throw new Error('[node-pty-shim] Failed to extract spawn-helper: ' + (err && err.message));
    }
  }

  // dlopen the .node addon
  const mod = { exports: {} };
  process.dlopen(mod, nodePath);
  // `dir` ends with a separator because node-pty's code does
  // `native.dir + '/spawn-helper'` — trailing slash avoids a double slash,
  // but either works because path.resolve normalizes.
  return { dir: cacheDir + path.sep, module: mod.exports };
}

function loadFromDisk(name) {
  // Reproduces node-pty's original search order for when the shim runs outside
  // SEA context (e.g., `node dist/main.cjs` during local dev).
  const dirs = ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`];
  const relatives = ['..', '.'];
  let lastError;
  for (const d of dirs) {
    for (const r of relatives) {
      const dir = r + '/' + d + '/';
      try {
        return { dir, module: require(dir + '/' + name + '.node') };
      } catch (e) {
        lastError = e;
      }
    }
  }
  throw new Error(
    `[node-pty-shim] Failed to load native module ${name}.node outside SEA. ` +
    `Checked: ${dirs.join(', ')}. Last error: ${lastError && lastError.message}`,
  );
}

function loadNativeModule(name) {
  const cached = cache.get(name);
  if (cached) return cached;
  const viaSea = loadFromSea(name);
  const result = viaSea ?? loadFromDisk(name);
  cache.set(name, result);
  return result;
}

module.exports = { loadNativeModule, assign };
