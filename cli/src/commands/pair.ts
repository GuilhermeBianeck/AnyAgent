/**
 * `anyagent pair` — print a fresh pair code.
 *
 * This is the binary-native equivalent of `node hub/dist/tools/gen-pair.js`.
 * Opens the hub's SQLite file via its exported helpers — does not start a server.
 */

import { randomBytes } from 'crypto';

export async function runPair(_args: string[]): Promise<number> {
  // Lazy-load the db module so the CLI doesn't touch SQLite for subcommands
  // that don't need it (`--help`, etc.).
  const { insertPairCode } = await import('../../../hub/src/db.js');

  const code = randomBytes(16).toString('hex').toUpperCase();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  insertPairCode(code, expiresAt, '');
  process.stdout.write(code + '\n');
  return 0;
}
