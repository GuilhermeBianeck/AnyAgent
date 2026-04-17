/**
 * `anyagent wire-mcp` — inject the anyagent entry into an MCP client config.
 *
 * Equivalent to `node hub/dist/tools/wire-mcp.js` but built into the binary.
 * Keeps the same flag shape so docs stay accurate:
 *
 *   anyagent wire-mcp --url URL --token TOK [--config PATH] [--name NAME] [--print]
 *
 * Auto-detects ~/.claude.json, ~/.cursor/mcp.json, or falls back to project .mcp.json.
 * Backs up the original to `<file>.bak` before writing.
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

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--url': out.url = next; i++; break;
      case '--token': out.token = next; i++; break;
      case '--config': out.config = next; i++; break;
      case '--name': out.name = next; i++; break;
      case '--print': out.print = true; break;
      default:
        if (a.startsWith('--')) {
          console.error(`[wire-mcp] unknown flag: ${a}`);
        }
    }
  }
  return out;
}

function candidateConfigs(): Array<{ path: string; client: string }> {
  const home = homedir();
  return [
    { path: join(home, '.claude.json'),           client: 'Claude Code (global)' },
    { path: join(home, '.cursor', 'mcp.json'),    client: 'Cursor (global)' },
    { path: join(process.cwd(), '.mcp.json'),     client: 'project-local .mcp.json' },
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
        url,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  }, null, 2);
}

export async function runWireMcp(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args.url || !args.token) {
    console.error('[wire-mcp] --url and --token are required');
    return 1;
  }
  const name = args.name ?? 'anyagent';

  if (args.print) {
    process.stdout.write(renderSnippet(name, args.url, args.token) + '\n');
    return 0;
  }

  let target: { path: string; client: string } | null = null;
  if (args.config) {
    target = { path: args.config, client: 'custom' };
  } else {
    for (const c of candidateConfigs()) {
      if (existsSync(c.path)) { target = c; break; }
    }
    if (!target) {
      // No known client config — fall back to project-local rather than
      // silently creating ~/.claude.json for a user that may not have Claude Code.
      target = { path: join(process.cwd(), '.mcp.json'), client: 'project-local .mcp.json (new)' };
    }
  }

  const existing = readJsonOrEmpty(target.path);
  const mcpServers = (existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers))
    ? existing.mcpServers as Record<string, unknown>
    : {};

  if (existsSync(target.path)) {
    try { copyFileSync(target.path, target.path + '.bak'); } catch { /* best effort */ }
  }

  mcpServers[name] = {
    url: args.url,
    headers: { Authorization: `Bearer ${args.token}` },
  };
  existing.mcpServers = mcpServers;

  writeFileSync(target.path, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
  console.log(`[wire-mcp] Updated ${target.client}: ${target.path}`);
  console.log(`[wire-mcp] Reopen your MCP client to pick up the new server.`);
  return 0;
}
