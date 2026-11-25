/**
 * hub.log must never hold secrets. It mirrors everything printed to the
 * console, so one-time secrets go through printSecret(), and writeLine masks
 * known secret shapes as a backstop.
 */
import { testHubDir } from './helpers/isolate.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

process.env.MCP_TOKEN = 'admin-token-value-123456';
process.env.WS_SECRET = 'ws-secret-value-abcdef';
const { initLogger, printSecret, redactSecrets } = await import('../src/logger.js');
const { createToken } = await import('../src/tokens.js');

const logFile = join(testHubDir, 'logs', 'hub.log');
const readLog = () => readFileSync(logFile, 'utf8');

// Keep test output clean: swallow what the logger forwards to the terminal.
const realLog = console.log, realErr = console.error;
before(() => {
  console.log = () => {};
  console.error = () => {};
  initLogger();
});
after(() => {
  console.log = realLog;
  console.error = realErr;
});

test('printSecret reaches the terminal but not hub.log', () => {
  const { token } = createToken('cursor');
  console.log('[test] marker before');
  printSecret(`  ${token}`);
  console.log('[test] marker after');
  const log = readLog();
  assert.match(log, /marker before/);
  assert.match(log, /marker after/);
  assert.ok(!log.includes(token), 'plaintext token must not be in hub.log');
});

test('a token that is console.logged by mistake is masked in hub.log', () => {
  const { token } = createToken('oops');
  console.log(`leaked ${token}`);
  const log = readLog();
  assert.ok(!log.includes(token));
  assert.match(log, /leaked \[REDACTED\]/);
});

test('configured secrets and Telegram bot tokens in error text are masked', () => {
  console.error('request to https://api.telegram.org/bot123456789:AAEhBP0av18fBgeUf6xX_9xK2y4q1aBcDeF/sendMessage failed');
  console.error(`connect with ${process.env.WS_SECRET} and ${process.env.MCP_TOKEN}`);
  const log = readLog();
  assert.ok(!log.includes('AAEhBP0av18fBgeUf6xX_9xK2y4q1aBcDeF'));
  assert.ok(!log.includes(process.env.WS_SECRET!));
  assert.ok(!log.includes(process.env.MCP_TOKEN!));
  assert.match(log, /\[WS_SECRET\] and \[MCP_TOKEN\]/);
});

test('ordinary log lines are unchanged', () => {
  assert.equal(redactSecrets('[gateway] Node node_ab12 declared 3 agent(s)'), '[gateway] Node node_ab12 declared 3 agent(s)');
});

test('hub.log is readable by its owner only', () => {
  assert.equal(statSync(logFile).mode & 0o777, 0o600);
});
