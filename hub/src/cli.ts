/**
 * CLI — Interactive terminal management interface for AnyAgent hub.
 * Works without Telegram. Uses readline for input.
 */

import { createInterface, Interface } from 'readline';
import {
  createTaskId, findAgentByCapability, startAgentForTask,
  processNextQueued, handleApprovalDecision, generatePairCode,
  approveWorkerPairing, rejectWorkerPairing, revokeWorker,
  getWorkerList, getAgentList, getRecentTasks, getTask,
  getActiveSessionByChatId, clearActiveSession, sendTtyInput,
  setDefaultAgent, getDefaultAgent, clearDefaultAgent,
  getApprovalMode, setApprovalMode, purgeTasksByChatId,
} from './manager.js';
import { getAgentByName, getAgentByNameAndAlias, insertTask, updateTaskStatus } from './db.js';
import { getContext, setContext, appendContext, clearContext } from './context.js';
import { onTtyOutput, onStructuredOutput, onSessionEnd, onPairingRequest, onWorkerOnline } from './gateway.js';
import { stripAnsi } from './output.js';
import type { OutputParams, TaskStatus } from './types.js';
import { getBuildInfo, formatUptime, uptimeSeconds } from './build-info.js';
import { recentEventsList, onEvent, eventsLogPath } from './events.js';
import { metricsEnabled } from './metrics.js';
import { recentConnections, auditEnabled, airgapEnabled } from './netlog.js';
import { logPath } from './logger.js';

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// CLI uses chatId=0 for all operations (single-user terminal)
const CLI_CHAT_ID = 0;

function statusIcon(online: boolean): string {
  return online ? `${GREEN}●${RESET}` : `${RED}●${RESET}`;
}

function taskIcon(status: TaskStatus): string {
  switch (status) {
    case 'complete': return `${GREEN}✓${RESET}`;
    case 'failed': return `${RED}✗${RESET}`;
    case 'running': return `${CYAN}▶${RESET}`;
    case 'queued': return `${YELLOW}…${RESET}`;
    case 'pending_approval': return `${YELLOW}?${RESET}`;
    case 'timeout': return `${DIM}⏰${RESET}`;
    default: return ' ';
  }
}

export function startCli(): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${DIM}anyagent>${RESET} ` });

  // Live prompt status bar — shows (N↑ M↓) for online/offline workers
  function refreshPrompt(): void {
    const workers = getWorkerList();
    const up = workers.filter(w => w.online).length;
    const down = workers.length - up;
    const bar = workers.length === 0
      ? ''
      : ` ${DIM}(${up > 0 ? GREEN : DIM}${up}↑${RESET}${DIM}${down > 0 ? ` ${RED}${down}↓${RESET}${DIM}` : ''})${RESET}`;
    rl.setPrompt(`${DIM}anyagent${bar}>${RESET} `);
  }
  refreshPrompt();
  // Refresh when a worker changes state. Don't re-draw the prompt while the user is
  // mid-typing — only update the prompt template so the next redraw uses it.
  onWorkerOnline(() => refreshPrompt());

  // --- Event handlers ---

  onTtyOutput((_nodeId, data) => {
    const session = getActiveSessionByChatId(CLI_CHAT_ID);
    if (session) {
      process.stdout.write(stripAnsi(data.toString('utf-8')));
    }
  });

  onStructuredOutput((_nodeId, params: OutputParams) => {
    const { type, payload } = params;
    switch (type) {
      case 'status': {
        const p = payload as { text?: string };
        console.log(`${DIM}${p.text ?? ''}${RESET}`);
        break;
      }
      case 'progress': {
        const p = payload as { current?: number; total?: number; label?: string };
        const pct = p.total ? Math.round(((p.current ?? 0) / p.total) * 100) : 0;
        process.stdout.write(`\r${CYAN}${p.current}/${p.total} (${pct}%)${p.label ? ' — ' + p.label : ''}${RESET}  `);
        break;
      }
      case 'result': {
        const p = payload as { text?: string };
        console.log(`\n${p.text ?? ''}`);
        break;
      }
      case 'error': {
        const p = payload as { message?: string };
        console.log(`\n${RED}Error: ${p.message ?? 'unknown'}${RESET}`);
        break;
      }
    }
  });

  onSessionEnd((nodeId, _exitCode) => {
    const qr = processNextQueued(nodeId);
    if (qr.outcome === 'started') {
      console.log(`${GREEN}▶${RESET} Queued task started: ${qr.agentName}`);
    }
  });

  onPairingRequest((connId, workerName, workerDesc) => {
    const label = workerName || connId.slice(0, 8);
    const desc = workerDesc ? ` — ${workerDesc}` : '';
    console.log(`\n${YELLOW}${BOLD}Pairing request:${RESET} ${label}${desc}`);
    rl.question(`  Approve? (y/n): `, (answer) => {
      if (answer.toLowerCase() === 'y') {
        const nodeId = approveWorkerPairing(connId);
        if (nodeId) {
          console.log(`${GREEN}✓${RESET} Approved: ${nodeId}`);
        } else {
          console.log(`${RED}✗${RESET} Pairing not found or expired.`);
        }
      } else {
        rejectWorkerPairing(connId);
        console.log(`${RED}✗${RESET} Rejected.`);
      }
      rl.prompt();
    });
  });

  // --- Command handling ---

  function handleCommand(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }

    const [cmd, ...args] = trimmed.split(/\s+/);
    const argStr = args.join(' ');

    switch (cmd.toLowerCase()) {
      case 'help': {
        console.log(`
${BOLD}AnyAgent CLI${RESET}

${BOLD}Setup${RESET}
  pair                Generate a pairing code
  workers             List registered workers
  revoke <node_id>    Revoke a worker

${BOLD}Usage${RESET}
  agents              List agents with capabilities
  call <name>         Start a specific agent
  route <intent>      Route by capability matching
  switch              Switch to a different agent
  stop                Stop the active session
  tasks               Show recent task history
  history [task_id]   Full history (detail with ID)
  retry <task_id>     Retry a failed task
  cancel <task_id>    Cancel a queued task
  y / yes             Approve pending task
  n / no              Deny pending task
  trust               Trust agent + approve

${BOLD}Config${RESET}
  default [name|off]  Set/clear default agent
  approve [off|mcp|always]  Set approval mode
  context [set|add|clear] <text>  Manage operator context
  purge               Delete all task history

  status              Show version, uptime, workers, approval mode
  events [watch]      Recent worker state transitions (watch tails live)
  net                 Recent outbound connections (AUDIT_NETWORK=1)
  help                Show this help
  quit                Exit
`);
        break;
      }

      case 'pair': {
        const { code } = generatePairCode();
        console.log(`${YELLOW}Pairing code:${RESET} ${BOLD}${code}${RESET}`);
        console.log(`${DIM}Expires in 10 minutes. Set PAIR_CODE=${code} on your worker.${RESET}`);
        break;
      }

      case 'workers': {
        const workers = getWorkerList();
        if (workers.length === 0) {
          console.log('No workers registered. Use "pair" to add one.');
        } else {
          console.log(`${BOLD}Workers:${RESET}`);
          for (const w of workers) {
            const nameSuffix = w.name && w.name !== w.alias ? ` (${w.name})` : '';
            const desc = w.description ? ` — ${w.description}` : '';
            console.log(`  ${statusIcon(w.online)} ${w.alias}${nameSuffix}${desc} ${DIM}(${w.nodeId})${RESET}`);
          }
        }
        break;
      }

      case 'agents': {
        const agents = getAgentList();
        if (agents.length === 0) {
          console.log('No agents registered. Connect a worker to declare agents.');
          break;
        }
        // Group by node so the operator sees which machine owns each agent.
        const byNode = new Map<string, { nodeName: string; online: boolean; items: typeof agents }>();
        for (const a of agents) {
          if (!byNode.has(a.nodeAlias)) {
            byNode.set(a.nodeAlias, { nodeName: a.nodeName, online: a.online, items: [] });
          }
          const g = byNode.get(a.nodeAlias)!;
          g.items.push(a);
          if (a.online) g.online = true;
        }
        console.log(`${BOLD}Agents:${RESET}`);
        const aliases = [...byNode.keys()].sort();
        for (const alias of aliases) {
          const g = byNode.get(alias)!;
          const nameSuffix = g.nodeName && g.nodeName !== alias ? ` ${DIM}(${g.nodeName})${RESET}` : '';
          console.log(`  ${statusIcon(g.online)} ${BOLD}${alias}${RESET}${nameSuffix}`);
          for (const a of g.items) {
            const caps = a.capabilities.length > 0 ? ` [${a.capabilities.join(', ')}]` : '';
            const desc = a.description ? ` — ${a.description}` : '';
            console.log(`      ${statusIcon(a.online)} ${a.name}${desc}${caps}`);
          }
        }
        console.log('');
        console.log(`${DIM}Call short form:  call <name>${RESET}`);
        console.log(`${DIM}Target a machine: call <name>@<alias>${RESET}`);
        break;
      }

      case 'call': {
        if (!argStr) { console.log('Usage: call <name> | call <name>@<alias>'); break; }
        // Allow `call claude@spot` to target a specific machine when multiple
        // nodes have an agent of the same name. Falls back to name-only lookup.
        const atIdx = argStr.lastIndexOf('@');
        const agentName = atIdx >= 0 ? argStr.slice(0, atIdx) : argStr;
        const alias = atIdx >= 0 ? argStr.slice(atIdx + 1) : '';
        const agent = alias
          ? (getAgentByNameAndAlias(agentName, alias) ?? getAgentByName(agentName))
          : getAgentByName(agentName);
        if (!agent) {
          console.log(`${RED}Agent "${argStr}" not found.${RESET}`);
          break;
        }
        const existing = getActiveSessionByChatId(CLI_CHAT_ID);
        if (existing) clearActiveSession(existing.nodeId);
        const taskId = createTaskId();
        insertTask(taskId, 'cli', `call:${argStr}`, CLI_CHAT_ID);
        const result = startAgentForTask(agent, taskId, `call:${argStr}`, CLI_CHAT_ID, 'explicit');
        renderStartResult(result);
        break;
      }

      case 'route': {
        if (!argStr) { console.log('Usage: route <intent>'); break; }
        const taskId = createTaskId();
        insertTask(taskId, 'cli', argStr, CLI_CHAT_ID);
        const routing = findAgentByCapability(argStr);
        if (routing.type === 'none') {
          updateTaskStatus(taskId, 'failed', { error: 'No agents online' });
          console.log(`${RED}No agents online.${RESET}`);
          break;
        }
        if (routing.type === 'ambiguous' && routing.agents) {
          console.log('Multiple agents available:');
          routing.agents.forEach((a, i) => {
            const caps: string[] = JSON.parse(a.capabilities || '[]');
            console.log(`  ${i + 1}. ${a.name} [${caps.join(', ')}]`);
          });
          rl.question('Pick (number): ', (answer) => {
            const idx = parseInt(answer) - 1;
            const picked = routing.agents![idx];
            if (!picked) { console.log('Invalid choice.'); rl.prompt(); return; }
            const result = startAgentForTask(picked, taskId, argStr, CLI_CHAT_ID, 'user_selected');
            renderStartResult(result);
            rl.prompt();
          });
          return; // don't prompt — question callback will
        }
        if (routing.agent) {
          const result = startAgentForTask(routing.agent, taskId, argStr, CLI_CHAT_ID, routing.method);
          renderStartResult(result);
        }
        break;
      }

      case 'stop': {
        const session = getActiveSessionByChatId(CLI_CHAT_ID);
        if (!session) { console.log('No active session.'); break; }
        clearActiveSession(session.nodeId);
        console.log(`${RED}■${RESET} Session ended${session.agentName ? ': ' + session.agentName : ''}`);
        const qr = processNextQueued(session.nodeId);
        if (qr.outcome === 'started') {
          console.log(`${GREEN}▶${RESET} Queued task started: ${qr.agentName}`);
        }
        break;
      }

      case 'tasks': {
        const tasks = getRecentTasks(CLI_CHAT_ID, 10);
        if (tasks.length === 0) { console.log('No tasks yet.'); break; }
        console.log(`${BOLD}Recent tasks:${RESET}`);
        for (const t of tasks) {
          const intent = t.intent.length > 50 ? t.intent.slice(0, 50) + '...' : t.intent;
          const agent = t.agent_name ? ` → ${t.agent_name}` : '';
          const src = t.source === 'mcp' ? ' (MCP)' : '';
          console.log(`  ${taskIcon(t.status as TaskStatus)} ${DIM}${t.task_id.slice(0, 12)}${RESET}${agent}${src}  ${intent}`);
          if (t.result_summary) {
            const s = t.result_summary.length > 60 ? t.result_summary.slice(0, 60) + '...' : t.result_summary;
            console.log(`    ${DIM}→ ${s}${RESET}`);
          }
          if (t.error) {
            console.log(`    ${RED}✗ ${t.error}${RESET}`);
          }
        }
        break;
      }

      case 'history': {
        if (argStr) {
          // history <task_id> — show full detail
          const task = getTask(argStr);
          if (!task) { console.log(`${RED}Task "${argStr}" not found.${RESET}`); break; }
          console.log(`${BOLD}Task Detail${RESET}`);
          console.log(`  ID:      ${task.task_id}`);
          console.log(`  Status:  ${taskIcon(task.status as TaskStatus)} ${task.status}`);
          console.log(`  Source:  ${task.source}`);
          if (task.agent_name) console.log(`  Agent:   ${task.agent_name}`);
          if (task.node_id) console.log(`  Node:    ${task.node_id}`);
          if (task.routing_method) console.log(`  Routing: ${task.routing_method}`);
          if (task.retry_count > 0) console.log(`  Retries: ${task.retry_count}`);
          console.log(`  Created: ${task.created_at}`);
          console.log(`  Updated: ${task.updated_at}`);
          console.log(`\n  ${BOLD}Intent:${RESET}\n  ${task.intent}`);
          if (task.result_summary) console.log(`\n  ${BOLD}Result:${RESET}\n  ${task.result_summary}`);
          if (task.error) console.log(`\n  ${RED}Error: ${task.error}${RESET}`);
        } else {
          // history — show last 20 tasks
          const tasks = getRecentTasks(CLI_CHAT_ID, 20);
          if (tasks.length === 0) { console.log('No task history yet.'); break; }
          console.log(`${BOLD}Task history:${RESET}`);
          for (const t of tasks) {
            const intent = t.intent.length > 40 ? t.intent.slice(0, 40) + '...' : t.intent;
            const agent = t.agent_name ? ` → ${t.agent_name}` : '';
            const src = t.source === 'mcp' ? ' (MCP)' : t.source === 'telegram' ? ' (TG)' : '';
            console.log(`  ${taskIcon(t.status as TaskStatus)} ${DIM}${t.task_id.slice(0, 12)}${RESET}${agent}${src}  ${intent}`);
            if (t.result_summary) {
              const s = t.result_summary.length > 60 ? t.result_summary.slice(0, 60) + '...' : t.result_summary;
              console.log(`    ${DIM}→ ${s}${RESET}`);
            }
            if (t.error) {
              console.log(`    ${RED}✗ ${t.error}${RESET}`);
            }
          }
          console.log(`\n${DIM}Use "history <task_id>" for full detail.${RESET}`);
        }
        break;
      }

      case 'status': {
        const workers = getWorkerList();
        const agents = getAgentList();
        const session = getActiveSessionByChatId(CLI_CHAT_ID);
        const def = getDefaultAgent(CLI_CHAT_ID);
        const mode = getApprovalMode(CLI_CHAT_ID);
        const info = getBuildInfo();
        const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
        console.log(`${BOLD}Status${RESET}`);
        console.log(`  Version:  v${info.version} on ${info.node}`);
        console.log(`  Uptime:   ${formatUptime(uptimeSeconds())}`);
        console.log(`  Memory:   ${rss} MB RSS`);
        console.log(`  Workers:  ${workers.filter(w => w.online).length}/${workers.length} online`);
        console.log(`  Agents:   ${agents.length} registered`);
        console.log(`  Active:   ${session?.agentName ?? 'none'}`);
        console.log(`  Default:  ${def ?? 'none'}`);
        console.log(`  Approval: ${mode}`);
        console.log(`  Metrics:  ${metricsEnabled() ? 'on' : 'off'}${airgapEnabled() ? ', airgap=on' : ''}${auditEnabled() ? ', audit=on' : ''}`);
        console.log(`  Logs:     ${logPath()}`);
        break;
      }

      case 'events': {
        // events                 → show last 20 events
        // events watch           → tail events live
        if (argStr === 'watch') {
          console.log(`${DIM}Tailing event log. Press Ctrl+C to stop.${RESET}`);
          onEvent((evt) => {
            const parts = [evt.t.slice(11, 19), evt.type];
            if (evt.name) parts.push(evt.name);
            if (evt.node_id) parts.push(DIM + evt.node_id + RESET);
            if (evt.detail) parts.push(`— ${evt.detail}`);
            console.log(parts.join(' '));
          });
          return; // don't re-prompt; user Ctrl+Cs
        }
        const events = recentEventsList(20);
        if (events.length === 0) {
          console.log('No events yet.');
        } else {
          console.log(`${BOLD}Recent events${RESET} ${DIM}(${eventsLogPath()})${RESET}`);
          for (const e of events) {
            const name = e.name ? ` ${e.name}` : '';
            const detail = e.detail ? ` ${DIM}— ${e.detail}${RESET}` : '';
            console.log(`  ${DIM}${e.t.slice(11, 19)}${RESET}  ${e.type}${name}${detail}`);
          }
        }
        break;
      }

      case 'net': {
        if (!auditEnabled()) {
          console.log(`${DIM}Network audit is off. Start hub with AUDIT_NETWORK=1 to enable.${RESET}`);
          break;
        }
        const conns = recentConnections(50);
        if (conns.length === 0) {
          console.log('No outbound connections recorded.');
        } else {
          console.log(`${BOLD}Recent outbound connections${RESET}`);
          for (const c of conns) {
            console.log(`  ${DIM}${c.t.slice(11, 19)}${RESET}  ${c.host}:${c.port}  ${DIM}${c.reason}${RESET}`);
          }
        }
        break;
      }

      case 'default': {
        if (!argStr) {
          const def = getDefaultAgent(CLI_CHAT_ID);
          console.log(`Default agent: ${def ?? 'none'}`);
        } else if (argStr === 'off' || argStr === 'clear') {
          clearDefaultAgent(CLI_CHAT_ID);
          console.log('Default agent cleared.');
        } else {
          const agent = getAgentByName(argStr);
          if (!agent) { console.log(`${RED}Agent "${argStr}" not found.${RESET}`); break; }
          setDefaultAgent(CLI_CHAT_ID, argStr);
          console.log(`${GREEN}✓${RESET} Default agent set to ${argStr}.`);
        }
        break;
      }

      case 'approve': {
        if (!argStr) {
          console.log(`Approval mode: ${getApprovalMode(CLI_CHAT_ID)}`);
          console.log('  approve off    — all tasks auto-run');
          console.log('  approve mcp    — MCP tasks need approval');
          console.log('  approve always — all tasks need approval');
        } else if (argStr === 'off' || argStr === 'mcp' || argStr === 'always') {
          setApprovalMode(CLI_CHAT_ID, argStr);
          console.log(`${GREEN}✓${RESET} Approval mode: ${argStr}`);
        } else {
          console.log('Usage: approve [off|mcp|always]');
        }
        break;
      }

      case 'context': {
        const [sub, ...rest] = args;
        const text = rest.join(' ');
        if (!sub) {
          const ctx = getContext();
          console.log(ctx ? `${BOLD}Context:${RESET}\n${ctx}` : 'No context set.');
        } else if (sub === 'set' && text) {
          setContext(text);
          console.log(`${GREEN}✓${RESET} Context updated.`);
        } else if (sub === 'add' && text) {
          appendContext(text);
          console.log(`${GREEN}✓${RESET} Appended.`);
        } else if (sub === 'clear') {
          clearContext();
          console.log(`${GREEN}✓${RESET} Context cleared.`);
        } else {
          console.log('Usage: context [set <text> | add <line> | clear]');
        }
        break;
      }

      case 'revoke': {
        if (!argStr) { console.log('Usage: revoke <node_id>'); break; }
        const ok = revokeWorker(argStr);
        if (ok) console.log(`${GREEN}✓${RESET} Node ${argStr} revoked.`);
        else console.log(`${RED}Node "${argStr}" not found.${RESET}`);
        break;
      }

      case 'purge': {
        const count = purgeTasksByChatId(CLI_CHAT_ID);
        clearDefaultAgent(CLI_CHAT_ID);
        const session = getActiveSessionByChatId(CLI_CHAT_ID);
        if (session) clearActiveSession(session.nodeId);
        console.log(`${GREEN}✓${RESET} Purged ${count} task(s).`);
        break;
      }

      case 'switch': {
        const onlineAgents = getAgentList().filter(a => a.online);
        if (onlineAgents.length === 0) { console.log('No online agents.'); break; }
        console.log('Online agents:');
        onlineAgents.forEach((a, i) => console.log(`  ${i + 1}. ${a.name} — ${a.description}`));
        rl.question('Switch to (number): ', (answer) => {
          const idx = parseInt(answer) - 1;
          const picked = onlineAgents[idx];
          if (!picked) { console.log('Invalid choice.'); rl.prompt(); return; }
          const existing = getActiveSessionByChatId(CLI_CHAT_ID);
          if (existing) clearActiveSession(existing.nodeId);
          const agent = getAgentByName(picked.name);
          if (!agent) { console.log('Agent not found.'); rl.prompt(); return; }
          const taskId = createTaskId();
          insertTask(taskId, 'cli', `switch:${picked.name}`, CLI_CHAT_ID);
          const result = startAgentForTask(agent, taskId, `switch:${picked.name}`, CLI_CHAT_ID, 'user_selected');
          renderStartResult(result);
          rl.prompt();
        });
        return;
      }

      case 'retry': {
        if (!argStr) { console.log('Usage: retry <task_id>'); break; }
        const original = getTask(argStr);
        if (!original) { console.log(`${RED}Task not found.${RESET}`); break; }
        if (!original.agent_name) { console.log(`${RED}No agent on this task.${RESET}`); break; }
        if (original.retry_count >= 3) { console.log(`${RED}Max retries (3) reached.${RESET}`); break; }
        const retryAgent = getAgentByName(original.agent_name);
        if (!retryAgent) { console.log(`${RED}Agent no longer exists.${RESET}`); break; }
        const retryIntent = original.error ? `${original.intent}\n[Previous: ${original.error}]` : original.intent;
        const retryTaskId = createTaskId();
        insertTask(retryTaskId, 'cli', retryIntent, CLI_CHAT_ID, original.retry_count + 1);
        const retryResult = startAgentForTask(retryAgent, retryTaskId, retryIntent, CLI_CHAT_ID, 'explicit');
        renderStartResult(retryResult);
        break;
      }

      case 'cancel': {
        if (!argStr) { console.log('Usage: cancel <task_id>'); break; }
        const cancelTask = getTask(argStr);
        if (!cancelTask || cancelTask.status !== 'queued') { console.log(`${RED}Task not found or not queued.${RESET}`); break; }
        updateTaskStatus(argStr, 'failed', { error: 'Cancelled by user' });
        console.log(`${GREEN}✓${RESET} Task cancelled.`);
        break;
      }

      case 'yes':
      case 'y': {
        // Approve the most recent pending_approval task
        const tasks = getRecentTasks(CLI_CHAT_ID, 5);
        const pending = tasks.find(t => t.status === 'pending_approval');
        if (!pending) { console.log('No pending approvals.'); break; }
        const decision = handleApprovalDecision(pending.task_id, 'approve');
        if (decision.ok && decision.task && decision.agentName) {
          const agent = getAgentByName(decision.agentName);
          if (agent) {
            const r = startAgentForTask(agent, pending.task_id, decision.task.intent, CLI_CHAT_ID, 'explicit');
            renderStartResult(r);
          }
        }
        break;
      }

      case 'no':
      case 'n': {
        const tasks2 = getRecentTasks(CLI_CHAT_ID, 5);
        const pending2 = tasks2.find(t => t.status === 'pending_approval');
        if (!pending2) { console.log('No pending approvals.'); break; }
        handleApprovalDecision(pending2.task_id, 'deny');
        console.log(`${RED}✗${RESET} Task denied.`);
        break;
      }

      case 'trust': {
        const tasks3 = getRecentTasks(CLI_CHAT_ID, 5);
        const pending3 = tasks3.find(t => t.status === 'pending_approval');
        if (!pending3) { console.log('No pending approvals.'); break; }
        const decision3 = handleApprovalDecision(pending3.task_id, 'trust');
        if (decision3.ok && decision3.task && decision3.agentName) {
          console.log(`${GREEN}✓${RESET} Agent ${decision3.agentName} trusted.`);
          const agent3 = getAgentByName(decision3.agentName);
          if (agent3) {
            const r3 = startAgentForTask(agent3, pending3.task_id, decision3.task.intent, CLI_CHAT_ID, 'explicit');
            renderStartResult(r3);
          }
        }
        break;
      }

      case 'quit':
      case 'exit': {
        console.log('Bye.');
        process.exit(0);
      }

      default: {
        // If there's an active session, send as TTY input
        const session = getActiveSessionByChatId(CLI_CHAT_ID);
        if (session) {
          const ok = sendTtyInput(session.nodeId, trimmed + '\n');
          if (!ok) {
            console.log(`${RED}Failed to send input — worker may be offline.${RESET}`);
            clearActiveSession(session.nodeId);
          }
        } else {
          // Try routing as intent if default agent is set
          const defaultName = getDefaultAgent(CLI_CHAT_ID);
          if (defaultName) {
            const agent = getAgentByName(defaultName);
            if (agent) {
              const taskId = createTaskId();
              insertTask(taskId, 'cli', trimmed, CLI_CHAT_ID);
              const result = startAgentForTask(agent, taskId, trimmed, CLI_CHAT_ID, 'default');
              renderStartResult(result);
              break;
            }
          }
          console.log(`Unknown command: "${cmd}". Type "help" for commands.`);
        }
      }
    }

    rl.prompt();
  }

  function renderStartResult(result: ReturnType<typeof startAgentForTask>): void {
    const target = result.nodeAlias ? `${result.agentName}@${result.nodeAlias}` : result.agentName;
    switch (result.outcome) {
      case 'started':
        console.log(`${GREEN}✓${RESET} ${target} started. Type to interact, "stop" to end.`);
        break;
      case 'queued':
        console.log(`${YELLOW}…${RESET} ${target} busy. Queued (position #${result.queuePosition}).`);
        break;
      case 'pending_approval':
        console.log(`${YELLOW}?${RESET} Approval required for ${target}. Auto-denies in 5 min.`);
        // CLI auto-approves for now (operator is at the terminal)
        // A future version could prompt y/n
        break;
      case 'offline':
        console.log(`${RED}✗${RESET} ${target} — worker offline.`);
        break;
      case 'queue_full':
        console.log(`${RED}✗${RESET} ${target} — queue full.`);
        break;
      case 'failed':
        console.log(`${RED}✗${RESET} Failed: ${result.error ?? 'unknown'}`);
        break;
    }
  }

  // --- Start ---

  console.log(`${BOLD}${CYAN}AnyAgent${RESET} — type "help" for commands\n`);
  rl.on('line', handleCommand);
  rl.prompt();
}
