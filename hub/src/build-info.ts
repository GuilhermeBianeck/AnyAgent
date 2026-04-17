/**
 * Build + runtime metadata — shown in /health and CLI `status`.
 *
 * `version` is read from package.json at require time. `started_at` is captured once
 * on first import so it survives throughout the hub's lifetime.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { hubRoot } from './paths.js';

interface BuildInfo {
  version: string;
  node: string;
  started_at: number;
}

// Injected by the SEA bundler (cli/bundle.mjs) via `define`. When running
// from hub/dist under `npm start`, this is undefined and we fall back to
// reading hub/package.json at runtime.
declare const __ANYAGENT_VERSION__: string | undefined;

let cached: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
  if (cached) return cached;
  let version = '0.0.0';
  if (typeof __ANYAGENT_VERSION__ === 'string' && __ANYAGENT_VERSION__.length > 0) {
    version = __ANYAGENT_VERSION__;
  } else {
    try {
      // In the `npm start` layout, package.json sits alongside hub/
      const pkgPath = join(hubRoot(), 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
      if (pkg.version) version = pkg.version;
    } catch {
      // Best effort — keep 0.0.0 placeholder
    }
  }
  cached = {
    version,
    node: process.version,
    started_at: Date.now(),
  };
  return cached;
}

export function uptimeSeconds(): number {
  return Math.floor((Date.now() - getBuildInfo().started_at) / 1000);
}

export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
