/**
 * Scoped MCP tokens (AR-5).
 *
 * MCP_TOKEN remains the full-access "admin" token. Additional named tokens
 * can be limited to specific agents and/or made read-only, so e.g. Cursor on
 * a laptop can call `claude@laptop` but not the shell agent on the GPU box.
 *
 * Allowlist entries:
 *   "*"              every agent
 *   "claude"         agent "claude" on any machine (enables the short-form tool)
 *   "claude@laptop"  only that machine's "claude" (explicit tool only)
 *
 * Tokens are 256-bit random values; only their SHA-256 is stored, and the
 * plaintext is shown once at creation.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import {
  insertMcpToken, getMcpTokenByHash, getMcpTokenByLabel, listMcpTokens, deleteMcpToken, touchMcpToken,
  type McpTokenRow,
} from './db.js';

export interface TokenScope {
  /** Label for the audit trail; "admin" is MCP_TOKEN. */
  token: string;
  agents: '*' | string[];
  readonly: boolean;
}

export const ADMIN_SCOPE: TokenScope = { token: 'admin', agents: '*', readonly: false };

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const ENTRY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(@[a-z0-9][a-z0-9_-]{0,63})?$/;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function rowScope(row: McpTokenRow): TokenScope {
  let agents: TokenScope['agents'] = '*';
  if (row.agents !== '*') {
    try { agents = JSON.parse(row.agents) as string[]; } catch { agents = []; }
  }
  return { token: row.label, agents, readonly: row.readonly === 1 };
}

export class TokenError extends Error {}

export function createToken(label: string, opts: { agents?: string[]; readonly?: boolean } = {}): { token: string; scope: TokenScope } {
  if (!LABEL_RE.test(label)) throw new TokenError('Label must be 1-32 chars: letters, digits, _ or -, starting alphanumeric.');
  if (label.toLowerCase() === 'admin') throw new TokenError('"admin" is reserved for MCP_TOKEN.');
  if (getMcpTokenByLabel(label)) throw new TokenError(`A token labelled "${label}" already exists.`);
  const agents = opts.agents && opts.agents.length > 0 && !opts.agents.includes('*') ? opts.agents : '*';
  if (agents !== '*') {
    for (const e of agents) {
      if (!ENTRY_RE.test(e)) throw new TokenError(`Invalid agent entry "${e}" (use name or name@alias).`);
    }
  }
  const token = `aat_${randomBytes(32).toString('base64url')}`;
  insertMcpToken(label, sha256(token), agents === '*' ? '*' : JSON.stringify(agents), opts.readonly === true);
  return { token, scope: { token: label, agents, readonly: opts.readonly === true } };
}

export function listTokens(): Array<TokenScope & { createdAt: string; lastUsedAt: string | null }> {
  return listMcpTokens().map(r => ({ ...rowScope(r), createdAt: r.created_at, lastUsedAt: r.last_used_at }));
}

export function revokeToken(label: string): boolean {
  return deleteMcpToken(label);
}

export function hasScopedTokens(): boolean {
  return listMcpTokens().length > 0;
}

/**
 * Resolve an `Authorization` header to a scope, or null if it is not a valid
 * token. The admin token is compared in constant time; scoped tokens are
 * looked up by hash, which reveals nothing useful through timing.
 */
export function resolveBearer(header: string | undefined, adminToken?: string): TokenScope | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  const presented = header.slice('Bearer '.length).trim();
  if (!presented) return null;
  if (adminToken) {
    const a = Buffer.from(presented);
    const b = Buffer.from(adminToken);
    if (a.length === b.length && timingSafeEqual(a, b)) return ADMIN_SCOPE;
  }
  const row = getMcpTokenByHash(sha256(presented));
  if (!row) return null;
  touchMcpToken(row.id);
  return rowScope(row);
}

/** May this scope call agent `name` on node `alias`? */
export function scopeAllows(scope: TokenScope, name: string, alias: string): boolean {
  if (scope.agents === '*') return true;
  return scope.agents.includes(name) || scope.agents.includes(`${name}@${alias}`);
}

/** May this scope use the short-form tool, where the hub picks the machine? */
export function scopeAllowsAnyNode(scope: TokenScope, name: string): boolean {
  return scope.agents === '*' || scope.agents.includes(name);
}
