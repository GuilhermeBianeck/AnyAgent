/**
 * Event log — writes JSON-lines to hub/logs/events.log so operators can audit
 * worker state transitions (online/offline/auth_fail/flap) without re-deriving
 * them from the general log.
 *
 * Also powers flap detection: if a worker's online/offline events pass the
 * threshold in a window, we emit `worker.flapping` and notify listeners.
 */

import { join } from 'path';
import { logsDir } from './paths.js';
import { createJsonlWriter } from './jsonl.js';

const EVENTS_PATH = join(logsDir(), 'events.log');
const writer = createJsonlWriter(EVENTS_PATH, 5 * 1024 * 1024 /* 5MB */, 3);

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

export function emit(type: EventType, extra: Partial<HubEvent> = {}): void {
  const evt: HubEvent = {
    t: new Date().toISOString(),
    type,
    ...extra,
  };
  writer.append(evt);
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
