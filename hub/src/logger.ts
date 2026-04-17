/**
 * Rotating file logger — no deps, no pino.
 * Writes newline-delimited JSON to hub/logs/hub.log and rotates at MAX_LOG_BYTES.
 *
 * Also mirrors console.log / console.warn / console.error to the log file so existing
 * `console.log('[module] …')` calls flow into the file without any code changes elsewhere.
 *
 * Keep this module dependency-free — it runs before anything else in index.ts.
 */

import { mkdirSync, statSync, renameSync, appendFileSync, existsSync, unlinkSync } from 'fs';
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

function writeLine(level: 'info' | 'warn' | 'error', parts: unknown[]): void {
  try {
    rotateIfNeeded();
    const line = JSON.stringify({
      t: new Date().toISOString(),
      lvl: level,
      msg: parts.map(p => typeof p === 'string' ? p : (() => { try { return JSON.stringify(p); } catch { return String(p); } })()).join(' '),
    }) + '\n';
    appendFileSync(LOG_PATH, line);
  } catch {
    // Don't let logging failures kill the hub
  }
}

/**
 * Wire console.* to also write to the rotating log file.
 * Call once at hub startup before anything else logs.
 */
export function initLogger(): void {
  if (initialized) return;
  initialized = true;

  try { mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 }); } catch { /* best effort */ }

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

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
