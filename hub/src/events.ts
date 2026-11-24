/**
 * Event log — writes JSON-lines to hub/logs/events.log so operators can audit
 * worker state transitions (online/offline/auth_fail/flap) without re-deriving
 * them from the general log.
 *
 * Also powers flap detection: if a worker's online/offline events pass the
 * threshold in a window, we emit `worker.flapping` and notify listeners.
 */

import { mkdirSync, appendFileSync, statSync, renameSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { logsDir } from './paths.js';

const LOGS_DIR = logsDir();
const EVENTS_PATH = join(LOGS_DIR, 'events.log');

const MAX_EVENTS_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_EVENTS_FILES = 3;

export type EventType =
  | 'worker.online'
  | 'worker.offline'
  | 'worker.auth_fail'
  | 'worker.heartbeat_miss'
  | 'worker.flapping'
  | 'worker.metadata_sanitized'
  | 'worker.agent_rejected'
  | 'agent.quarantined'
  | 'agent.approved'
  | 'task.submitted'
  | 'task.complete'
  | 'task.failed'
  | 'hub.started'
  | 'hub.stopped';

export interface HubEvent {
  t: string;
  type: EventType;
  node_id?: string;
  name?: string;
  task_id?: string;
  detail?: string;
}

type Listener = (evt: HubEvent) => void;
const listeners: Listener[] = [];

export function onEvent(listener: Listener): void {
  listeners.push(listener);
}

// Recent events buffer for `watch` commands without tailing the file
const recentEvents: HubEvent[] = [];
const MAX_RECENT = 100;

export function recentEventsList(limit: number = 20): HubEvent[] {
  return recentEvents.slice(-limit);
}

// Flap detection
interface FlapState { connects: number[]; alerted: boolean }
const flapStates = new Map<string, FlapState>();
const FLAP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const FLAP_THRESHOLD = 3;               // 3 connects in window → flapping

function checkFlap(nodeId: string): boolean {
  const now = Date.now();
  const state = flapStates.get(nodeId) ?? { connects: [], alerted: false };
  state.connects = state.connects.filter(t => now - t < FLAP_WINDOW_MS);
  state.connects.push(now);
  flapStates.set(nodeId, state);
  if (state.connects.length >= FLAP_THRESHOLD && !state.alerted) {
    state.alerted = true;
    return true;
  }
  // Reset alert flag once the worker has been stable for a full window
  if (state.connects.length === 1) state.alerted = false;
  return false;
}

function rotateIfNeeded(): void {
  try {
    if (!existsSync(EVENTS_PATH)) return;
    if (statSync(EVENTS_PATH).size < MAX_EVENTS_BYTES) return;
    const oldest = `${EVENTS_PATH}.${MAX_EVENTS_FILES}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = MAX_EVENTS_FILES - 1; i >= 1; i--) {
      const from = `${EVENTS_PATH}.${i}`;
      if (existsSync(from)) renameSync(from, `${EVENTS_PATH}.${i + 1}`);
    }
    renameSync(EVENTS_PATH, `${EVENTS_PATH}.1`);
  } catch {
    // ignore
  }
}

export function emit(type: EventType, extra: Partial<HubEvent> = {}): void {
  try { mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
  const evt: HubEvent = {
    t: new Date().toISOString(),
    type,
    ...extra,
  };
  try {
    rotateIfNeeded();
    appendFileSync(EVENTS_PATH, JSON.stringify(evt) + '\n');
  } catch {
    // best effort
  }
  recentEvents.push(evt);
  if (recentEvents.length > MAX_RECENT) recentEvents.shift();
  for (const l of listeners) {
    try { l(evt); } catch { /* listener isolation */ }
  }

  // Flap detection runs on worker.online events
  if (type === 'worker.online' && evt.node_id) {
    if (checkFlap(evt.node_id)) {
      emit('worker.flapping', { node_id: evt.node_id, name: evt.name, detail: `${FLAP_THRESHOLD}+ reconnects in ${FLAP_WINDOW_MS / 60000}min` });
    }
  }
}

export function eventsLogPath(): string {
  return EVENTS_PATH;
}
