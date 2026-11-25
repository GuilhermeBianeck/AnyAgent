/**
 * Rotating file logger — no deps, no pino.
 * Writes newline-delimited JSON to hub/logs/hub.log and rotates at MAX_LOG_BYTES.
 *
 * Also mirrors console.log / console.warn / console.error to the log file so existing
 * `console.log('[module] …')` calls flow into the file without any code changes elsewhere.
 *
 * Keep this module dependency-free — it runs before anything else in index.ts.
 */

import { mkdirSync, statSync, renameSync, appendFileSync, existsSync, unlinkSync, chmodSync } from 'fs';
import { join } from 'path';
import { logsDir } from './paths.js';

const LOGS_DIR = logsDir();
const LOG_PATH = join(LOGS_DIR, 'hub.log');

const MAX_LOG_BYTES = parseInt(process.env.LOG_MAX_BYTES ?? '', 10) || 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = parseInt(process.env.LOG_MAX_FILES ?? '', 10) || 5;

let initialized = false;

function rotateIfNeeded(): void {
  try {
    if (!existsSync(LOG_PATH)) return;
    const st = statSync(LOG_PATH);
    if (st.size < MAX_LOG_BYTES) return;

    // Shift: hub.log.(N-1) -> hub.log.N, delete oldest
    const oldest = `${LOG_PATH}.${MAX_LOG_FILES}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const from = `${LOG_PATH}.${i}`;
      const to = `${LOG_PATH}.${i + 1}`;
      if (existsSync(from)) renameSync(from, to);
    }
    renameSync(LOG_PATH, `${LOG_PATH}.1`);
  } catch {
    // If rotation fails, keep writing — better than crashing the hub
  }
}

// ---------------------------------------------------------------------------
// Secret hygiene. hub.log mirrors everything printed to the console, so:
//   1. One-time secrets meant for the operator (new MCP tokens, pairing codes)
//      are printed with printSecret(), which writes to the terminal only.
//   2. As a backstop, writeLine masks known secret shapes and the configured
//      secret values before anything reaches the file (e.g. a Telegram bot
//      token embedded in a failed request URL inside a logged error).
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /aat_[A-Za-z0-9_-]{20,}/g,            // scoped MCP tokens (tokens.ts)
  /\bbot\d{5,}:[A-Za-z0-9_-]{20,}/g,    // Telegram bot token inside API URLs
  /\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g,     // Telegram bot token on its own
];
const SECRET_ENV_VARS = ['MCP_TOKEN', 'WS_SECRET', 'BOT_TOKEN'];

export function redactSecrets(text: string): string {
  let out = text;
  for (const name of SECRET_ENV_VARS) {
    const value = process.env[name];
    // Ignore unset or trivially short values so common words are never masked.
    if (value && value.length >= 8) out = out.split(value).join(`[${name}]`);
  }
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

function writeLine(level: 'info' | 'warn' | 'error', parts: unknown[]): void {
  try {
    rotateIfNeeded();
    const msg = parts.map(p => typeof p === 'string' ? p : (() => { try { return JSON.stringify(p); } catch { return String(p); } })()).join(' ');
    const line = JSON.stringify({
      t: new Date().toISOString(),
      lvl: level,
      msg: redactSecrets(msg),
    }) + '\n';
    // 0600: the log holds operational detail; only the hub's user may read it.
    appendFileSync(LOG_PATH, line, { mode: 0o600 });
  } catch {
    // Don't let logging failures kill the hub
  }
}

let terminalOnly: (...args: unknown[]) => void = (...args) => console.log(...args);

/**
 * Print to the operator's terminal WITHOUT writing to hub.log. Use for
 * one-time secrets (a new token, a pairing code) that must not persist.
 */
export function printSecret(...args: unknown[]): void {
  terminalOnly(...args);
}

/**
 * Wire console.* to also write to the rotating log file.
 * Call once at hub startup before anything else logs.
 */
export function initLogger(): void {
  if (initialized) return;
  initialized = true;

  try { mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
  // Logs created by older versions were world-readable (0644); tighten them.
  try { if (existsSync(LOG_PATH)) chmodSync(LOG_PATH, 0o600); } catch { /* best effort */ }

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  terminalOnly = origLog;

  console.log = (...args: unknown[]): void => { origLog(...args); writeLine('info', args); };
  console.warn = (...args: unknown[]): void => { origWarn(...args); writeLine('warn', args); };
  console.error = (...args: unknown[]): void => { origError(...args); writeLine('error', args); };

  // Capture unhandled crashes
  process.on('uncaughtException', (err: Error) => {
    writeLine('error', ['uncaughtException', err.message, err.stack ?? '']);
    origError('[hub] uncaughtException:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    writeLine('error', ['unhandledRejection', String(reason)]);
    origError('[hub] unhandledRejection:', reason);
  });
}

export function logPath(): string {
  return LOG_PATH;
}
