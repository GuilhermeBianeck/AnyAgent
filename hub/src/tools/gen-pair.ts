/**
 * gen-pair — emit a fresh pair code to stdout and exit.
 *
 * Used by quickstart.sh to generate a pair code without going through the
 * interactive CLI. Opens its own SQLite connection to the same hub.db file —
 * safe because SQLite serializes writes via file locks.
 *
 * Usage:
 *   node dist/tools/gen-pair.js
 *   # prints: ABCD1234...
 *
 * Exit 0 on success, 1 on error.
 */

import { randomBytes } from 'crypto';
import { insertPairCode } from '../db.js';

try {
  const code = randomBytes(16).toString('hex').toUpperCase();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  insertPairCode(code, expiresAt, '');
  // Only the code goes to stdout — the caller captures it with $(...)
  process.stdout.write(code + '\n');
  process.exit(0);
} catch (err) {
  console.error('[gen-pair]', err instanceof Error ? err.message : err);
  process.exit(1);
}
