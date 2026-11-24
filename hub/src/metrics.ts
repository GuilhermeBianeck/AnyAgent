/**
 * Prometheus metrics — hand-rolled text format, no dependency.
 * Enabled when ENABLE_METRICS=1. Exposed at GET /metrics on the MCP HTTP server
 * (no auth — metrics are non-sensitive counters/gauges).
 *
 * Emits:
 *   anyagent_tasks_total{status,source}    counter
 *   anyagent_mcp_calls_total{tool,outcome} counter
 *   anyagent_workers_online                gauge
 *   anyagent_worker_reconnects_total       counter
 *   anyagent_auth_failures_total           counter
 *   anyagent_build_info{version}           gauge (always 1)
 *   anyagent_uptime_seconds                gauge
 */

import { getBuildInfo } from './build-info.js';

const startedAt = Date.now();
const ENABLED = process.env.ENABLE_METRICS === '1';

// counters (monotonic)
const taskCounters = new Map<string, number>(); // key: `${status}|${source}`
const mcpCallCounters = new Map<string, number>(); // key: `${tool}|${outcome}`
let reconnects = 0;
let authFailures = 0;

// gauges (set externally)
let workersOnline = 0;

export function metricsEnabled(): boolean {
  return ENABLED;
}

export function incTask(status: string, source: string): void {
  if (!ENABLED) return;
  const key = `${status}|${source}`;
  taskCounters.set(key, (taskCounters.get(key) ?? 0) + 1);
}

export function incMcpCall(tool: string, outcome: string): void {
  if (!ENABLED) return;
  const key = `${tool}|${outcome}`;
  mcpCallCounters.set(key, (mcpCallCounters.get(key) ?? 0) + 1);
}

export function incReconnect(): void {
  if (!ENABLED) return;
  reconnects++;
}

export function incAuthFailure(): void {
  if (!ENABLED) return;
  authFailures++;
}

export function setWorkersOnline(n: number): void {
  if (!ENABLED) return;
  workersOnline = n;
}

export function renderMetrics(): string {
  const lines: string[] = [];
  const info = getBuildInfo();

  lines.push('# HELP anyagent_build_info Build metadata');
  lines.push('# TYPE anyagent_build_info gauge');
  lines.push(`anyagent_build_info{version="${info.version}"} 1`);

  lines.push('# HELP anyagent_uptime_seconds Hub process uptime in seconds');
  lines.push('# TYPE anyagent_uptime_seconds gauge');
  lines.push(`anyagent_uptime_seconds ${((Date.now() - startedAt) / 1000).toFixed(1)}`);

  lines.push('# HELP anyagent_workers_online Number of authenticated workers currently connected');
  lines.push('# TYPE anyagent_workers_online gauge');
  lines.push(`anyagent_workers_online ${workersOnline}`);

  lines.push('# HELP anyagent_worker_reconnects_total Worker WebSocket reconnects observed by the hub');
  lines.push('# TYPE anyagent_worker_reconnects_total counter');
  lines.push(`anyagent_worker_reconnects_total ${reconnects}`);

  lines.push('# HELP anyagent_auth_failures_total Worker authentication failures');
  lines.push('# TYPE anyagent_auth_failures_total counter');
  lines.push(`anyagent_auth_failures_total ${authFailures}`);

  lines.push('# HELP anyagent_tasks_total Tasks observed by terminal status');
  lines.push('# TYPE anyagent_tasks_total counter');
  for (const [key, count] of taskCounters.entries()) {
    const [status, source] = key.split('|');
    lines.push(`anyagent_tasks_total{status="${status}",source="${source}"} ${count}`);
  }

  lines.push('# HELP anyagent_mcp_calls_total MCP tool calls by tool and outcome');
  lines.push('# TYPE anyagent_mcp_calls_total counter');
  for (const [key, count] of mcpCallCounters.entries()) {
    const [tool, outcome] = key.split('|');
    lines.push(`anyagent_mcp_calls_total{tool="${tool}",outcome="${outcome}"} ${count}`);
  }

  return lines.join('\n') + '\n';
}
