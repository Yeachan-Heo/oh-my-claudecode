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
import { dirname } from 'path';
import { mkdir, readFile, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { TeamPaths, absPath } from './state-paths.js';
import type { TeamEventType } from './contracts.js';
import type { TeamEvent } from './types.js';

/**
 * Append a team event to the JSONL event log.
 * Thread-safe via atomic append (O_WRONLY|O_APPEND|O_CREAT).
 */
export async function appendTeamEvent(
  teamName: string,
  event: Omit<TeamEvent, 'event_id' | 'created_at' | 'team'>,
  cwd: string,
): Promise<TeamEvent> {
  const full: TeamEvent = {
    event_id: randomUUID(),
    team: teamName,
    created_at: new Date().toISOString(),
    ...event,
  };
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
): Promise<TeamEvent[]> {
  const p = absPath(cwd, TeamPaths.events(teamName));
  if (!existsSync(p)) return [];
  try {
    const raw = await readFile(p, 'utf8');
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TeamEvent);
  } catch {
    return [];
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
  workers: Array<{ name: string; alive: boolean; status: { state: string } }>,
  previousSnapshot: {
    taskStatusById?: Record<string, string>;
    workerAliveByName?: Record<string, boolean>;
    workerStateByName?: Record<string, string>;
    completedEventTaskIds?: Record<string, boolean>;
  } | null,
  cwd: string,
): Promise<void> {
  if (!previousSnapshot) return;

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
      }, cwd).catch(() => {});
      completedEventTaskIds[task.id] = true;
    } else if (task.status === 'failed') {
      await appendTeamEvent(teamName, {
        type: 'task_failed',
        worker: 'leader-fixed',
        task_id: task.id,
        reason: `status_transition:${prevStatus}->${task.status}`,
      }, cwd).catch(() => {});
    }
  }

  // Detect worker state changes
  for (const worker of workers) {
    const prevAlive = previousSnapshot.workerAliveByName?.[worker.name];
    const prevState = previousSnapshot.workerStateByName?.[worker.name];

    if (prevAlive === true && !worker.alive) {
      await appendTeamEvent(teamName, {
        type: 'worker_stopped',
        worker: worker.name,
        reason: 'pane_exited',
      }, cwd).catch(() => {});
    }

    if (prevState === 'working' && worker.status.state === 'idle') {
      await appendTeamEvent(teamName, {
        type: 'worker_idle',
        worker: worker.name,
        reason: `state_transition:${prevState}->${worker.status.state}`,
      }, cwd).catch(() => {});
    }
  }
}
