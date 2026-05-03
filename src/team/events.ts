/**
 * Team event system — JSONL-based append-only event log.
 *
 * Mirrors OMX appendTeamEvent semantics. All team-significant actions
 * (task completions, failures, worker state changes, shutdown gates)
 * are recorded as structured events for observability and replay.
 *
 * Events are appended to: .omc/state/team/{teamName}/events.jsonl
 */

import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { mkdir, readFile, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { TeamPaths, absPath } from './state-paths.js';
import { isWakeableTeamEventType, type TeamEventType } from './contracts.js';
import type { TeamEvent } from './types.js';
import type { WorkerPaneLiveness } from './tmux-session.js';
import { createSwallowedErrorLogger } from '../lib/swallowed-error.js';

export interface TeamEventReadOptions {
  afterEventId?: string;
  wakeableOnly?: boolean;
  type?: TeamEventType | 'worker_idle';
  worker?: string;
  taskId?: string;
}

export interface TeamEventWaitOptions extends TeamEventReadOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export interface TeamEventWaitResult {
  status: 'event' | 'timeout';
  cursor: string;
  event?: TeamEvent;
}

function isWakeableTeamEvent(event: TeamEvent): boolean {
  return event.type === 'worker_idle' || isWakeableTeamEventType(event.type as TeamEventType);
}

function filterTeamEvents(events: TeamEvent[], options: TeamEventReadOptions = {}): TeamEvent[] {
  let afterIndex = -1;
  if (options.afterEventId) {
    afterIndex = events.findIndex((event) => event.event_id === options.afterEventId);
  }

  return events
    .slice(afterIndex >= 0 ? afterIndex + 1 : 0)
    .filter((event) => {
      if (options.wakeableOnly && !isWakeableTeamEvent(event)) return false;
      if (options.type && event.type !== options.type) return false;
      if (options.worker && event.worker !== options.worker) return false;
      if (options.taskId && event.task_id !== options.taskId) return false;
      return true;
    });
}

async function readJsonlEvents(path: string): Promise<TeamEvent[]> {
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, 'utf8');
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TeamEvent);
  } catch {
    return [];
  }
}

function mergeTeamEvents(...eventGroups: TeamEvent[][]): TeamEvent[] {
  const byId = new Map<string, TeamEvent>();
  for (const event of eventGroups.flat()) {
    if (!event?.event_id) continue;
    if (!byId.has(event.event_id)) byId.set(event.event_id, event);
  }
  return [...byId.values()].sort((left, right) => {
    const leftTime = Date.parse(left.created_at || '');
    const rightTime = Date.parse(right.created_at || '');
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return String(left.event_id).localeCompare(String(right.event_id));
  });
}

/**
 * Append a team event to the JSONL event log.
 * Thread-safe via atomic append (O_WRONLY|O_APPEND|O_CREAT).
 */
export async function appendTeamEvent(
  teamName: string,
  event: Omit<TeamEvent, 'event_id' | 'created_at' | 'team'>,
  cwd: string,
): Promise<TeamEvent> {
  const full = {
    event_id: randomUUID(),
    team: teamName,
    created_at: new Date().toISOString(),
    ...event,
  } as TeamEvent;
  const p = absPath(cwd, TeamPaths.events(teamName));
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, `${JSON.stringify(full)}\n`, 'utf8');
  return full;
}

/**
 * Read all events for a team from the JSONL log.
 * Returns empty array if no events exist.
 */
export async function readTeamEvents(
  teamName: string,
  cwd: string,
  options: TeamEventReadOptions = {},
): Promise<TeamEvent[]> {
  const canonicalPath = absPath(cwd, TeamPaths.events(teamName));
  const legacyPath = absPath(cwd, join(TeamPaths.root(teamName), 'events', 'events.ndjson'));
  const events = mergeTeamEvents(
    await readJsonlEvents(canonicalPath),
    await readJsonlEvents(legacyPath),
  );
  return filterTeamEvents(events, options);
}

export async function waitForTeamEvent(
  teamName: string,
  cwd: string,
  options: TeamEventWaitOptions = {},
): Promise<TeamEventWaitResult> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 30_000);
  const pollMs = Math.max(10, options.pollMs ?? 250);
  const deadline = Date.now() + timeoutMs;
  let cursor = options.afterEventId ?? '';

  while (true) {
    const events = await readTeamEvents(teamName, cwd, options);
    if (events.length > 0) {
      const event = events[0];
      return { status: 'event', cursor: event.event_id, event };
    }

    const allEvents = await readTeamEvents(teamName, cwd);
    cursor = allEvents.at(-1)?.event_id ?? cursor;

    if (Date.now() >= deadline) {
      return { status: 'timeout', cursor };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}

/**
 * Read events of a specific type for a team.
 */
export async function readTeamEventsByType(
  teamName: string,
  eventType: TeamEventType,
  cwd: string,
): Promise<TeamEvent[]> {
  const all = await readTeamEvents(teamName, cwd);
  return all.filter((e) => e.type === eventType);
}

/**
 * Emit monitor-derived events by comparing current task/worker state
 * against the previous monitor snapshot. This detects:
 * - task_completed: task transitioned to 'completed'
 * - task_failed: task transitioned to 'failed'
 * - worker_idle: worker was working but is now idle
 * - worker_stopped: worker was alive but is now dead
 */
export async function emitMonitorDerivedEvents(
  teamName: string,
  tasks: Array<{ id: string; status: string }>,
  workers: Array<{ name: string; alive: boolean; liveness?: WorkerPaneLiveness; status: { state: string } }>,
  previousSnapshot: {
    taskStatusById?: Record<string, string>;
    workerAliveByName?: Record<string, boolean>;
    workerLivenessByName?: Record<string, WorkerPaneLiveness>;
    workerStateByName?: Record<string, string>;
    completedEventTaskIds?: Record<string, boolean>;
  } | null,
  cwd: string,
): Promise<void> {
  if (!previousSnapshot) return;

  const logDerivedEventFailure = createSwallowedErrorLogger(
    'team.events.emitMonitorDerivedEvents appendTeamEvent failed',
  );

  const completedEventTaskIds = { ...(previousSnapshot.completedEventTaskIds ?? {}) };

  // Detect task status transitions
  for (const task of tasks) {
    const prevStatus = previousSnapshot.taskStatusById?.[task.id];
    if (!prevStatus || prevStatus === task.status) continue;

    if (task.status === 'completed' && !completedEventTaskIds[task.id]) {
      await appendTeamEvent(teamName, {
        type: 'task_completed',
        worker: 'leader-fixed',
        task_id: task.id,
        reason: `status_transition:${prevStatus}->${task.status}`,
      }, cwd).catch(logDerivedEventFailure);
      completedEventTaskIds[task.id] = true;
    } else if (task.status === 'failed') {
      await appendTeamEvent(teamName, {
        type: 'task_failed',
        worker: 'leader-fixed',
        task_id: task.id,
        reason: `status_transition:${prevStatus}->${task.status}`,
      }, cwd).catch(logDerivedEventFailure);
    }
  }

  // Detect worker state changes
  for (const worker of workers) {
    const prevAlive = previousSnapshot.workerAliveByName?.[worker.name];
    const prevState = previousSnapshot.workerStateByName?.[worker.name];
    const currentLiveness = worker.liveness ?? (worker.alive ? 'alive' : 'dead');

    if (prevAlive === true && currentLiveness === 'dead') {
      await appendTeamEvent(teamName, {
        type: 'worker_stopped',
        worker: worker.name,
        reason: 'pane_exited',
      }, cwd).catch(logDerivedEventFailure);
    }

    if (prevState === 'working' && worker.status.state === 'idle') {
      await appendTeamEvent(teamName, {
        type: 'worker_idle',
        worker: worker.name,
        reason: `state_transition:${prevState}->${worker.status.state}`,
      }, cwd).catch(logDerivedEventFailure);
    }
  }
}
