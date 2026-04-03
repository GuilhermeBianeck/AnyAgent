import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getRecentCompletedTasksByChatId } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTEXT_PATH = join(__dirname, '..', 'data', 'context.md');

export function getContext(): string {
  if (!existsSync(CONTEXT_PATH)) return '';
  return readFileSync(CONTEXT_PATH, 'utf-8').trim();
}

export function setContext(text: string): void {
  writeFileSync(CONTEXT_PATH, text.trim() + '\n', { mode: 0o600 });
}

export function appendContext(line: string): void {
  const clean = line.trim();
  if (!clean) return;
  if (existsSync(CONTEXT_PATH)) {
    appendFileSync(CONTEXT_PATH, clean + '\n', { mode: 0o600 });
  } else {
    writeFileSync(CONTEXT_PATH, clean + '\n', { mode: 0o600 });
  }
}

export function clearContext(): void {
  if (existsSync(CONTEXT_PATH)) {
    unlinkSync(CONTEXT_PATH);
  }
}

/**
 * Build the full spawn context for a task.
 * Combines: operator context (context.md) + recent completed tasks + current intent.
 */
export function buildSpawnContext(chatId: number | null, intent: string): string {
  const parts: string[] = [];

  // Operator context
  const ctx = getContext();
  if (ctx) {
    parts.push('[Operator context]');
    parts.push(ctx);
    parts.push('');
  }

  // Recent completed tasks (last 5)
  if (chatId) {
    const recent = getRecentCompletedTasksByChatId(chatId, 5);
    if (recent.length > 0) {
      parts.push('[Recent tasks]');
      for (const t of recent) {
        const summary = t.result_summary ? t.result_summary.slice(0, 100) : 'no output';
        parts.push(`- ${t.intent.slice(0, 80)} → ${t.status}: ${summary}`);
      }
      parts.push('');
    }
  }

  // Current intent
  parts.push('[Current task]');
  parts.push(intent);

  return parts.join('\n');
}
