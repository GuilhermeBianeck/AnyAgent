/**
 * MCP audit trail (AR-4). Every MCP tool call is recorded to
 * logs/audit.log (JSON lines, rotated) and to an in-memory ring buffer for the
 * CLI `audit` command.
 *
 * Kept separate from events.log on purpose: MCP calls are far more frequent
 * than worker state transitions and would push those out of the `events`
 * buffer operators rely on.
 *
 * Privacy-first: the intent text is NOT stored by default — only a SHA-256
 * prefix, which is enough to correlate repeated calls without keeping what was
 * asked. Set AUDIT_LOG_INTENT=1 to store the text as well.
 */

import { createHash } from 'crypto';
import { join } from 'path';
import { logsDir } from './paths.js';
import { createJsonlWriter } from './jsonl.js';
import { incMcpCall } from './metrics.js';

export interface McpCallRecord {
  t: string;
  type: 'mcp.call';
  tool: string;
  /** Label of the token that made the call ("admin" = MCP_TOKEN). */
  token: string;
  outcome: 'ok' | 'error' | 'exception' | 'denied';
  duration_ms: number;
  task_id?: string;
  agent?: string;
  node?: string;
  status?: string;
  intent_sha256?: string;
  intent?: string;
  detail?: string;
}

const writer = createJsonlWriter(join(logsDir(), 'audit.log'), 10 * 1024 * 1024, 5);
const recent: McpCallRecord[] = [];
const MAX_RECENT = 200;

export function auditLogPath(): string {
  return writer.path;
}

export function recentAudit(limit = 20): McpCallRecord[] {
  return recent.slice(-limit);
}

export function intentDigest(intent: string): string {
  return createHash('sha256').update(intent).digest('hex').slice(0, 16);
}

interface CallInput {
  tool: string;
  token: string;
  args: unknown;
  result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
  threw?: boolean;
  denied?: string;
  durationMs: number;
}

export function recordMcpCall(input: CallInput): McpCallRecord {
  const args = (input.args && typeof input.args === 'object' ? input.args : {}) as Record<string, unknown>;
  const sc = input.result?.structuredContent ?? {};
  const outcome: McpCallRecord['outcome'] = input.denied ? 'denied' : input.threw ? 'exception' : input.result?.isError ? 'error' : 'ok';
  const rec: McpCallRecord = {
    t: new Date().toISOString(),
    type: 'mcp.call',
    tool: input.tool,
    token: input.token,
    outcome,
    duration_ms: input.durationMs,
  };
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const taskId = str(sc.taskId) ?? str(args.task_id);
  if (taskId) rec.task_id = taskId;
  if (str(sc.agent)) rec.agent = sc.agent as string;
  if (str(sc.node)) rec.node = sc.node as string;
  if (str(sc.status)) rec.status = sc.status as string;
  if (typeof args.intent === 'string') {
    rec.intent_sha256 = intentDigest(args.intent);
    if (process.env.AUDIT_LOG_INTENT === '1') rec.intent = args.intent;
  }
  if (input.denied) rec.detail = input.denied;

  writer.append(rec);
  recent.push(rec);
  if (recent.length > MAX_RECENT) recent.shift();
  incMcpCall(input.tool, outcome);
  return rec;
}
