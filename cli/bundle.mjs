#!/usr/bin/env node
/**
 * bundle.mjs — produce a single JS file for SEA embedding.
 *
 * Reads cli/src/main.ts (and its transitive imports, which include hub/src/*).
 * Outputs packaging/sea/build/main.cjs. esbuild handles TypeScript-to-JS,
 * ESM-to-CJS (SEA wants CJS), and dependency tree-shaking.
 *
 * Externals:
 *   - node:* modules (built-in, never bundled)
 *   - @modelcontextprotocol/sdk's URL/crypto-heavy deeps that esbuild sometimes
 *     can't statically resolve — we let them resolve at runtime.
 *
 * Everything else (ws, grammy, zod, dotenv) is bundled.
 *
 * To run:
 *   node packaging/sea/bundle.mjs
 */

import esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, mkdirSync } from 'fs';

// This script lives in cli/ so `import esbuild from 'esbuild'` resolves against
// cli/node_modules. The output still goes to packaging/sea/build/ so the SEA
// config + generated blob stay colocated.
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const cliEntry = join(__dirname, 'src', 'main.ts');
const outDir = join(repoRoot, 'packaging', 'sea', 'build');
// Node 22 SEA only supports CJS entry points (ESM support is unshipped).
// esbuild rewrites ESM sources → CJS, polyfills `import.meta.url` via
// `pathToFileURL(__filename)`, and our code avoids top-level await.
const outFile = join(outDir, 'main.cjs');

mkdirSync(outDir, { recursive: true });

// Read version from hub/package.json so builds are self-identifying
const hubPkg = JSON.parse(readFileSync(join(repoRoot, 'hub', 'package.json'), 'utf-8'));
const version = hubPkg.version ?? '0.0.0';

await esbuild.build({
  entryPoints: [cliEntry],
  bundle: true,
  outfile: outFile,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // SEA bundles are self-contained — `import.meta.url` points INSIDE the
  // blob, which is useless for locating data/log directories at runtime.
  // Instead, we let hub/src/paths.ts resolve via cwd + env var.
  // (No banner: cli/src/main.ts already starts with a shebang, and ESM
  // rejects a duplicate on line 2.)
  // The only things left external are:
  //   node:* — built-in modules
  //   node-gyp-build / bindings / native-loader-y packages we don't actually
  //   use (ws has optional zlib bindings that fall back to pure JS)
  external: [
    // node: built-ins — esbuild handles these, listing for clarity
    'node:*',
    // ws optional deps — fall back to JS implementations when not installed
    'bufferutil',
    'utf-8-validate',
  ],
  define: {
    // Injected into cli/src/main.ts
    __ANYAGENT_VERSION__: JSON.stringify(version),
  },
  // SEA wants a single file — don't split
  splitting: false,
  // Slight win: strip legal comments (license text) from transitive deps
  legalComments: 'none',
  // Keep stacktraces pointing at meaningful locations
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

// Report size
const { statSync } = await import('fs');
const sizeMb = (statSync(outFile).size / 1024 / 1024).toFixed(2);
console.log(`[bundle] wrote ${outFile} (${sizeMb} MB, version ${version})`);
