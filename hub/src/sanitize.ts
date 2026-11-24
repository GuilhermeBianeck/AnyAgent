/**
 * Sanitization of worker-declared metadata (AR-2).
 *
 * Agent descriptions and capabilities flow from a worker, through the hub, into
 * the MCP tool list that every connected client (Claude Code, Cursor, ...)
 * hands to its model. That makes them a prompt-injection surface ("tool
 * poisoning"): a compromised worker could plant instructions that target
 * clients on OTHER machines. OWASP's MCP guidance is to treat the whole tool
 * schema as untrusted input.
 *
 * This module is pure (no DB, no I/O) so it is trivially testable. It is a
 * first line of defence: it removes invisible/structural tricks and bounds the
 * payload size. Definition pinning (AR-3) is the control that catches a worker
 * changing its story later.
 */

export const LIMITS = {
  agentName: 64,
  description: 300,
  nodeName: 64,
  nodeDescription: 300,
  capability: 32,
  capabilities: 16,
  binary: 512,
  arg: 1024,
  args: 64,
} as const;

const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// Characters that render invisibly or reorder text, and are the standard way
// to hide instructions from a human reviewer while the model still reads them.
const INVISIBLE_RE = new RegExp(
  [
    '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]', // C0/C1 controls (keeps \t \n \r for whitespace pass)
    '[\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180E]',    // soft hyphen, CGJ, ALM, fillers
    '[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F]', // zero-width, bidi embeddings/isolates
    '[\\uFEFF\\uFFF9-\\uFFFB]',                                        // BOM, interlinear annotations
    '\\uDB40[\\uDC00-\\uDC7F]',                                        // U+E0000–E007F tag chars ("ASCII smuggling")
    '\\uDB40[\\uDD00-\\uDDEF]',                                        // U+E0100–E01EF variation selectors supplement
  ].join('|'),
  'g',
);

// Tool descriptions are plain text. HTML/XML-like tags (`<IMPORTANT>`,
// `<system>`) are the classic tool-poisoning marker and have no legitimate use.
const TAG_RE = /<\/?[A-Za-z][A-Za-z0-9_:-]{0,40}(\s[^<>]{0,200})?\/?>/g;

export interface TextResult {
  value: string;
  changed: boolean;
}

/** Strip invisible characters and tags, collapse whitespace, cap length. */
export function sanitizeText(input: unknown, maxLen: number): TextResult {
  const original = typeof input === 'string' ? input : input == null ? '' : String(input);
  let s = original.normalize('NFC');
  s = s.replace(INVISIBLE_RE, '');
  s = s.replace(TAG_RE, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + '…';
  return { value: s, changed: s !== original };
}

export function isValidAgentName(name: unknown): name is string {
  return typeof name === 'string' && AGENT_NAME_RE.test(name);
}

/** Lower-case, restrict to [a-z0-9_-], dedupe, cap count and length. */
export function sanitizeCapabilities(input: unknown): { value: string[]; changed: boolean } {
  const raw = Array.isArray(input) ? input : [];
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c !== 'string') continue;
    const v = c.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, LIMITS.capability);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= LIMITS.capabilities) break;
  }
  const changed = !Array.isArray(input) ? input !== undefined : out.length !== input.length || out.some((v, i) => v !== input[i]);
  return { value: out, changed };
}

export interface DeclaredAgentInput {
  name?: unknown;
  binary?: unknown;
  args?: unknown;
  description?: unknown;
  capabilities?: unknown;
  contextAware?: unknown;
}

export interface CleanAgent {
  name: string;
  binary: string;
  args: string[];
  description: string;
  capabilities: string[];
  contextAware: boolean;
}

export interface SanitizeReport {
  agents: CleanAgent[];
  /** Agents dropped entirely, with the reason. */
  rejected: Array<{ name: string; reason: string }>;
  /** Agents kept but altered; `fields` lists what changed. */
  modified: Array<{ name: string; fields: string[] }>;
}

function cleanArgs(input: unknown): string[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > LIMITS.args) return null;
  const out: string[] = [];
  for (const a of input) {
    if (typeof a !== 'string' || a.length > LIMITS.arg || a.includes('\0')) return null;
    out.push(a);
  }
  return out;
}

/**
 * Validate and clean the `agents` array of a `declare` RPC. Structural problems
 * (bad name, unusable binary/args) reject the agent; cosmetic problems in
 * human-readable fields are cleaned and reported.
 */
export function sanitizeAgents(input: unknown, maxAgents: number): SanitizeReport {
  const report: SanitizeReport = { agents: [], rejected: [], modified: [] };
  if (input === undefined) return report;
  if (!Array.isArray(input)) {
    report.rejected.push({ name: '(all)', reason: 'agents must be an array' });
    return report;
  }
  const seen = new Set<string>();
  for (const raw of input as DeclaredAgentInput[]) {
    const label = typeof raw?.name === 'string' ? raw.name.slice(0, LIMITS.agentName) : '(unnamed)';
    if (report.agents.length >= maxAgents) {
      report.rejected.push({ name: label, reason: `exceeds ${maxAgents} agents per node` });
      continue;
    }
    if (!raw || typeof raw !== 'object') {
      report.rejected.push({ name: label, reason: 'not an object' });
      continue;
    }
    if (!isValidAgentName(raw.name)) {
      report.rejected.push({ name: label, reason: 'invalid name (allowed: letters, digits, _ . -, max 64, must start alphanumeric)' });
      continue;
    }
    if (seen.has(raw.name)) {
      report.rejected.push({ name: raw.name, reason: 'duplicate name in declaration' });
      continue;
    }
    const binary = raw.binary;
    if (typeof binary !== 'string' || !binary.trim() || binary.length > LIMITS.binary || /[\0\r\n]/.test(binary)) {
      report.rejected.push({ name: raw.name, reason: 'invalid binary' });
      continue;
    }
    const args = cleanArgs(raw.args);
    if (!args) {
      report.rejected.push({ name: raw.name, reason: `invalid args (strings only, max ${LIMITS.args} × ${LIMITS.arg} chars)` });
      continue;
    }

    const fields: string[] = [];
    const desc = sanitizeText(raw.description ?? '', LIMITS.description);
    if (desc.changed && raw.description !== undefined) fields.push('description');
    const caps = sanitizeCapabilities(raw.capabilities);
    if (caps.changed) fields.push('capabilities');

    seen.add(raw.name);
    report.agents.push({
      name: raw.name,
      binary,
      args,
      description: desc.value,
      capabilities: caps.value,
      contextAware: raw.contextAware !== false,
    });
    if (fields.length > 0) report.modified.push({ name: raw.name, fields });
  }
  return report;
}
