/**
 * Append-only JSON-lines file with size-based rotation (file → file.1 → … →
 * file.N). Shared by the event log and the MCP audit log. Best effort: a
 * logging failure must never take down the hub.
 */

import { mkdirSync, appendFileSync, statSync, renameSync, existsSync, unlinkSync } from 'fs';
import { dirname } from 'path';

export interface JsonlWriter {
  readonly path: string;
  append(record: object): void;
}

export function createJsonlWriter(path: string, maxBytes: number, maxFiles: number): JsonlWriter {
  function rotateIfNeeded(): void {
    try {
      if (!existsSync(path) || statSync(path).size < maxBytes) return;
      const oldest = `${path}.${maxFiles}`;
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let i = maxFiles - 1; i >= 1; i--) {
        const from = `${path}.${i}`;
        if (existsSync(from)) renameSync(from, `${path}.${i + 1}`);
      }
      renameSync(path, `${path}.1`);
    } catch {
      // ignore
    }
  }

  return {
    path,
    append(record: object): void {
      try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
      try {
        rotateIfNeeded();
        appendFileSync(path, JSON.stringify(record) + '\n', { mode: 0o600 });
      } catch {
        // best effort
      }
    },
  };
}
