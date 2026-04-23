/**
 * wire-mcp — add AnyAgent to an MCP client's config.
 *
 * Detects common config locations for Claude Code, Cursor, and project-local
 * .mcp.json. Backs up the original (config.bak) before writing.
 *
 * Usage:
 *   node dist/tools/wire-mcp.js --url http://localhost:3000 --token MCP_TOKEN
 *   node dist/tools/wire-mcp.js --url ... --token ... --config /path/to/file
 *   node dist/tools/wire-mcp.js --url ... --token ... --print      # stdout only
 *
 * Exit 0 on success (wrote or printed), 1 on error, 2 if no client detected
 * and --print wasn't passed (so the caller can print guidance).
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface Args {
  url?: string;
  token?: string;
  config?: string;
  print?: boolean;
  name?: string;
}

function parseArgs(): Args {
  const out: Args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--url': out.url = next; i++; break;
      case '--token': out.token = next; i++; break;
      case '--config': out.config = next; i++; break;
      case '--name': out.name = next; i++; break;
      case '--print': out.print = true; break;
    }
  }
  return out;
}

// Well-known MCP client config locations, in preferred order.
// We update the FIRST one that exists — don't touch all of them.
function candidateConfigs(): Array<{ path: string; client: string }> {
  const home = homedir();
  return [
    { path: join(home, '.claude.json'),                   client: 'Claude Code (global)' },
    { path: join(home, '.cursor', 'mcp.json'),            client: 'Cursor (global)' },
    { path: join(process.cwd(), '.mcp.json'),             client: 'project-local .mcp.json' },
  ];
}

function readJsonOrEmpty(p: string): Record<string, unknown> {
  if (!existsSync(p)) return {};
  try {
    const text = readFileSync(p, 'utf-8');
    if (!text.trim()) return {};
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function renderSnippet(name: string, url: string, token: string): string {
  return JSON.stringify({
    mcpServers: {
      [name]: {
        // `type` is REQUIRED for Claude Code to recognize an HTTP server.
        // Without it, the CLI treats the entry as stdio and silently ignores
        // it at session start. Confirmed against `claude mcp add --transport http`
        // which writes the same shape.
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  }, null, 2);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.url || !args.token) {
    console.error('[wire-mcp] --url and --token are required');
    process.exit(1);
  }
  const name = args.name ?? 'anyagent';

  // --print: just emit the snippet for humans to copy
  if (args.print) {
    process.stdout.write(renderSnippet(name, args.url, args.token) + '\n');
    return;
  }

  // Pick target config: explicit --config, else first candidate that exists,
  // else a project-local .mcp.json (which we'll create fresh).
  let target: { path: string; client: string } | null = null;
  if (args.config) {
    target = { path: args.config, client: 'custom' };
  } else {
    for (const c of candidateConfigs()) {
      if (existsSync(c.path)) { target = c; break; }
    }
    if (!target) {
      // No existing client config found. Don't silently create ~/.claude.json —
      // the user may not have Claude Code installed. Fall back to project .mcp.json
      // which is the portable, widely-supported location.
      target = { path: join(process.cwd(), '.mcp.json'), client: 'project-local .mcp.json (new)' };
    }
  }

  const existing = readJsonOrEmpty(target.path);
  const mcpServers = (existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers))
    ? existing.mcpServers as Record<string, unknown>
    : {};

  // Back up the original IFF it existed, before we overwrite
  if (existsSync(target.path)) {
    try { copyFileSync(target.path, target.path + '.bak'); } catch { /* best effort */ }
  }

  mcpServers[name] = {
    // `type: 'http'` is required — see renderSnippet() for the rationale.
    type: 'http',
    url: args.url,
    headers: { Authorization: `Bearer ${args.token}` },
  };
  existing.mcpServers = mcpServers;

  writeFileSync(target.path, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
  console.log(`[wire-mcp] Updated ${target.client}: ${target.path}`);
  console.log(`[wire-mcp] Reopen your MCP client to pick up the new server.`);
}

main().catch((err) => {
  console.error('[wire-mcp]', err instanceof Error ? err.message : err);
  process.exit(1);
});
