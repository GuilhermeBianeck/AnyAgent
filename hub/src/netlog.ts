/**
 * Outbound-connection auditing + airgap guard.
 *
 * - AUDIT_NETWORK=1 logs the host/port/reason of every outbound TCP/WS/HTTP
 *   connection the hub opens, to hub/logs/network.log and an in-memory buffer
 *   the CLI `net` command can print.
 * - AIRGAP=1 refuses any outbound connection to non-loopback addresses and
 *   hard-fails if BOT_TOKEN is set. Useful for regulated or truly-local setups.
 *
 * Payloads are never logged — only metadata. Keep this module dependency-free.
 */

import { mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import net from 'net';
import http from 'http';
import https from 'https';
import { logsDir } from './paths.js';

const LOGS_DIR = logsDir();
const NET_LOG_PATH = join(LOGS_DIR, 'network.log');

const AUDIT = process.env.AUDIT_NETWORK === '1';
const AIRGAP = process.env.AIRGAP === '1';

export function auditEnabled(): boolean { return AUDIT; }
export function airgapEnabled(): boolean { return AIRGAP; }

interface NetRecord { t: string; host: string; port: number; reason: string }
const recent: NetRecord[] = [];
const MAX_RECENT = 200;

export function recentConnections(limit: number = 50): NetRecord[] {
  return recent.slice(-limit);
}

function record(host: string, port: number, reason: string): void {
  const rec: NetRecord = { t: new Date().toISOString(), host, port, reason };
  recent.push(rec);
  if (recent.length > MAX_RECENT) recent.shift();
  try {
    mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(NET_LOG_PATH, JSON.stringify(rec) + '\n');
  } catch {
    // best effort
  }
}

function isLoopback(host: string): boolean {
  if (!host) return false;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('127.') ||
    host === '0.0.0.0'
  );
}

let initialized = false;

/**
 * Install hooks. Safe to call multiple times; only the first takes effect.
 */
export function initNetlog(): void {
  if (initialized) return;
  initialized = true;
  if (!AUDIT && !AIRGAP) return;

  // AIRGAP: hard-fail if Telegram is enabled
  if (AIRGAP && process.env.BOT_TOKEN) {
    console.error('[netlog] AIRGAP=1 but BOT_TOKEN is set — refusing to start. Unset one of them.');
    process.exit(1);
  }

  // Patch net.Socket.connect — catches ws, http(s), dgram, custom sockets
  const origConnect = net.Socket.prototype.connect;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: any[]): net.Socket {
    let host = '';
    let port = 0;
    if (typeof args[0] === 'object' && args[0] !== null) {
      const opts = args[0] as { host?: string; port?: number };
      host = opts.host ?? '';
      port = opts.port ?? 0;
    } else if (typeof args[0] === 'number') {
      port = args[0];
      host = (args[1] as string) ?? '';
    }
    const reason = inferReason(host, port);
    if (AIRGAP && !isLoopback(host)) {
      const err = new Error(`AIRGAP=1: outbound connection to ${host}:${port} blocked (${reason})`);
      console.error('[netlog]', err.message);
      // Emit an async error instead of throwing, so the caller's error handler runs
      setImmediate(() => this.emit('error', err));
      return this;
    }
    if (AUDIT) record(host, port, reason);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return origConnect.apply(this, args as any);
  };

  // Also patch http/https.request so we observe the destination before the
  // socket layer sees the resolved IP. We don't try to re-type the variadic
  // request() overloads — the wrapper just forwards whatever it got.
  for (const entry of [[http, 'http'], [https, 'https']] as const) {
    const mod = entry[0];
    const name = entry[1];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const origReq = mod.request as (...args: any[]) => any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mod as any).request = function patchedRequest(...reqArgs: any[]): any {
      try {
        const opts = typeof reqArgs[0] === 'string' ? new URL(reqArgs[0]) : reqArgs[0];
        const host = (opts as { hostname?: string; host?: string }).hostname ?? (opts as { host?: string }).host ?? '';
        const port = parseInt(String((opts as { port?: number | string }).port ?? (name === 'https' ? 443 : 80)), 10);
        if (AIRGAP && !isLoopback(host)) {
          throw new Error(`AIRGAP=1: ${name} request to ${host}:${port} blocked`);
        }
        if (AUDIT) record(host || '(none)', port, `${name}:${(opts as { method?: string }).method ?? 'GET'}`);
      } catch (err) {
        if (AIRGAP) throw err;
      }
      return origReq.apply(mod, reqArgs);
    };
  }

  console.log(`[netlog] ${AIRGAP ? 'AIRGAP=on ' : ''}${AUDIT ? 'AUDIT_NETWORK=on' : ''}`);
}

function inferReason(host: string, port: number): string {
  if (host.includes('telegram')) return 'telegram';
  if (port === 443 || port === 80) return 'http';
  if (port === 8080) return 'ws-inbound'; // shouldn't happen outbound but be clear
  return 'tcp';
}
