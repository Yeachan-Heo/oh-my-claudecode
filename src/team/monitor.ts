/**
 * Snapshot-based team monitor — mirrors OMX monitorTeam semantics.
 *
 * Reads team config, tasks, worker heartbeats/status, computes deltas
 * against previous snapshot, emits events, delivers mailbox messages,
 * and persists the new snapshot for the next cycle.
 *
 * NO polling watchdog. The caller (runtime-v2 or runtime-cli) drives
 * the monitor loop.
 */

import { existsSync } from 'fs';
import { readFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { performance } from 'perf_hooks';
import { TeamPaths, absPath } from './state-paths.js';
import { appendTeamEvent, emitMonitorDerivedEvents } from './events.js';
import type {
  TeamConfig,
  TeamManifestV2,
  TeamMonitorSnapshotState,
  TeamPhaseState,
  WorkerStatus,
  WorkerHeartbeat,
  WorkerInfo,
  TeamTask,
  TeamSummary,
  TeamSummaryPerformance,
} from './types.js';
import type { TeamPhase } from './phase-controller.js';

// ---------------------------------------------------------------------------
// State I/O helpers (self-contained, no external deps beyond fs)
// ---------------------------------------------------------------------------

async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  try {
    if (!existsSync(filePath)) return null;
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeAtomic(filePath: string, data: string): Promise<void> {
  const { writeFile } = await import('fs/promises');
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, data, 'utf-8');
  const { rename } = await import('fs/promises');
  await rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Config / Manifest readers
// ---------------------------------------------------------------------------

export async function readTeamConfig(teamName: string, cwd: string): Promise<TeamConfig | null> {
  return readJsonSafe<TeamConfig>(absPath(cwd, TeamPaths.config(teamName)));
}

export async function readTeamManifest(teamName: string, cwd: string): Promise<TeamManifestV2 | null> {
  return readJsonSafe<TeamManifestV2>(absPath(cwd, TeamPaths.manifest(teamName)));
}

// ---------------------------------------------------------------------------
// Worker status / heartbeat readers
// ---------------------------------------------------------------------------

export async function readWorkerStatus(
  teamName: string,
  workerName: string,
  cwd: string,
): Promise<WorkerStatus> {
  const data = await readJsonSafe<WorkerStatus>(absPath(cwd, TeamPaths.workerStatus(teamName, workerName)));
  return data ?? { state: 'unknown', updated_at: '' };
}

export async function writeWorkerStatus(
  teamName: string,
  workerName: string,
  status: WorkerStatus,
  cwd: string,
): Promise<void> {
  await writeAtomic(absPath(cwd, TeamPaths.workerStatus(teamName, workerName)), JSON.stringify(status, null, 2));
}

export async function readWorkerHeartbeat(
  teamName: string,
  workerName: string,
  cwd: string,
): Promise<WorkerHeartbeat | null> {
  return readJsonSafe<WorkerHeartbeat>(absPath(cwd, TeamPaths.heartbeat(teamName, workerName)));
}

// ---------------------------------------------------------------------------
// Monitor snapshot persistence
// ---------------------------------------------------------------------------

export async function readMonitorSnapshot(
  teamName: string,
  cwd: string,
): Promise<TeamMonitorSnapshotState | null> {
  const p = absPath(cwd, TeamPaths.monitorSnapshot(teamName));
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TeamMonitorSnapshotState>;
    if (!parsed || typeof parsed !== 'object') return null;
    const monitorTimings = (() => {
      const candidate = parsed.monitorTimings as TeamMonitorSnapshotState['monitorTimings'];
      if (!candidate || typeof candidate !== 'object') return undefined;
      if (
        typeof candidate.list_tasks_ms !== 'number' ||
        typeof candidate.worker_scan_ms !== 'number' ||
        typeof candidate.mailbox_delivery_ms !== 'number' ||
        typeof candidate.total_ms !== 'number' ||
        typeof candidate.updated_at !== 'string'
      ) {
        return undefined;
      }
      return candidate;
    })();
    return {
      taskStatusById: parsed.taskStatusById ?? {},
      workerAliveByName: parsed.workerAliveByName ?? {},
      workerStateByName: parsed.workerStateByName ?? {},
      workerTurnCountByName: parsed.workerTurnCountByName ?? {},
      workerTaskIdByName: parsed.workerTaskIdByName ?? {},
      mailboxNotifiedByMessageId: parsed.mailboxNotifiedByMessageId ?? {},
      completedEventTaskIds: parsed.completedEventTaskIds ?? {},
      monitorTimings,
    };
  } catch {
    return null;
  }
}

export async function writeMonitorSnapshot(
  teamName: string,
  snapshot: TeamMonitorSnapshotState,
  cwd: string,
): Promise<void> {
  await writeAtomic(absPath(cwd, TeamPaths.monitorSnapshot(teamName)), JSON.stringify(snapshot, null, 2));
}

// ---------------------------------------------------------------------------
// Phase state persistence
// ---------------------------------------------------------------------------

export async function readTeamPhaseState(teamName: string, cwd: string): Promise<TeamPhaseState | null> {
  const p = absPath(cwd, TeamPaths.phaseState(teamName));
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TeamPhaseState>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      current_phase: (parsed.current_phase as TeamPhase) ?? 'executing',
      max_fix_attempts: typeof parsed.max_fix_attempts === 'number' ? parsed.max_fix_attempts : 3,
      current_fix_attempt: typeof parsed.current_fix_attempt === 'number' ? parsed.current_fix_attempt : 0,
      transitions: Array.isArray(parsed.transitions) ? parsed.transitions : [],
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function writeTeamPhaseState(
  teamName: string,
  phaseState: TeamPhaseState,
  cwd: string,
): Promise<void> {
  await writeAtomic(absPath(cwd, TeamPaths.phaseState(teamName)), JSON.stringify(phaseState, null, 2));
}

// ---------------------------------------------------------------------------
// Shutdown request / ack I/O
// ---------------------------------------------------------------------------

export async function writeShutdownRequest(
  teamName: string,
  workerName: string,
  fromWorker: string,
  cwd: string,
): Promise<void> {
  const data = {
    from: fromWorker,
    requested_at: new Date().toISOString(),
  };
  await writeAtomic(absPath(cwd, TeamPaths.shutdownRequest(teamName, workerName)), JSON.stringify(data, null, 2));
}

export async function readShutdownAck(
  teamName: string,
  workerName: string,
  cwd: string,
  requestedAfter?: string,
): Promise<{ status: 'accept' | 'reject'; reason?: string; updated_at?: string } | null> {
  const ack = await readJsonSafe<{ status: 'accept' | 'reject'; reason?: string; updated_at?: string }>(
    absPath(cwd, TeamPaths.shutdownAck(teamName, workerName)),
  );
  if (!ack) return null;
  if (requestedAfter && ack.updated_at) {
    if (new Date(ack.updated_at).getTime() < new Date(requestedAfter).getTime()) {
      return null; // Stale ack from a previous request
    }
  }
  return ack;
}

// ---------------------------------------------------------------------------
// Worker identity I/O
// ---------------------------------------------------------------------------

export async function writeWorkerIdentity(
  teamName: string,
  workerName: string,
  workerInfo: WorkerInfo,
  cwd: string,
): Promise<void> {
  await writeAtomic(absPath(cwd, TeamPaths.workerIdentity(teamName, workerName)), JSON.stringify(workerInfo, null, 2));
}

// ---------------------------------------------------------------------------
// Task listing (reads task files from the tasks directory)
// ---------------------------------------------------------------------------

export async function listTasksFromFiles(
  teamName: string,
  cwd: string,
): Promise<TeamTask[]> {
  const tasksDir = absPath(cwd, TeamPaths.tasks(teamName));
  if (!existsSync(tasksDir)) return [];
  const { readdir } = await import('fs/promises');
  const entries = await readdir(tasksDir);
  const tasks: TeamTask[] = [];
  for (const entry of entries) {
    const match = /^(?:task-)?(\d+)\.json$/.exec(entry);
    if (!match) continue;
    const task = await readJsonSafe<TeamTask>(absPath(cwd, `${TeamPaths.tasks(teamName)}/${entry}`));
    if (task) tasks.push(task);
  }
  return tasks.sort((a, b) => Number(a.id) - Number(b.id));
}

// ---------------------------------------------------------------------------
// Worker inbox I/O
// ---------------------------------------------------------------------------

export async function writeWorkerInbox(
  teamName: string,
  workerName: string,
  content: string,
  cwd: string,
): Promise<void> {
  await writeAtomic(absPath(cwd, TeamPaths.inbox(teamName, workerName)), content);
}

// ---------------------------------------------------------------------------
// Team summary (lightweight status for HUD/monitoring)
// ---------------------------------------------------------------------------

export async function getTeamSummary(
  teamName: string,
  cwd: string,
): Promise<TeamSummary | null> {
  const summaryStartMs = performance.now();
  const config = await readTeamConfig(teamName, cwd);
  if (!config) return null;

  const tasksStartMs = performance.now();
  const tasks = await listTasksFromFiles(teamName, cwd);
  const tasksLoadedMs = performance.now() - tasksStartMs;

  const counts = { total: tasks.length, pending: 0, blocked: 0, in_progress: 0, completed: 0, failed: 0 };
  for (const t of tasks) {
    if (t.status === 'pending') counts.pending++;
    else if (t.status === 'blocked') counts.blocked++;
    else if (t.status === 'in_progress') counts.in_progress++;
    else if (t.status === 'completed') counts.completed++;
    else if (t.status === 'failed') counts.failed++;
  }

  const workerSummaries: TeamSummary['workers'] = [];
  const nonReportingWorkers: string[] = [];

  const workerPollStartMs = performance.now();
  const workerSignals = await Promise.all(
    config.workers.map(async (worker) => {
      const [hb, status] = await Promise.all([
        readWorkerHeartbeat(teamName, worker.name, cwd),
        readWorkerStatus(teamName, worker.name, cwd),
      ]);
      return { worker, hb, status };
    }),
  );
  const workersPolledMs = performance.now() - workerPollStartMs;

  for (const { worker, hb, status } of workerSignals) {
    const alive = hb?.alive ?? false;
    const lastTurnAt = hb?.last_turn_at ?? null;
    const turnsWithoutProgress = 0; // Simplified; full delta tracking done in monitorTeam

    if (alive && status.state === 'working' && (hb?.turn_count ?? 0) > 5) {
      nonReportingWorkers.push(worker.name);
    }

    workerSummaries.push({ name: worker.name, alive, lastTurnAt, turnsWithoutProgress });
  }

  const perf: TeamSummaryPerformance = {
    total_ms: Number((performance.now() - summaryStartMs).toFixed(2)),
    tasks_loaded_ms: Number(tasksLoadedMs.toFixed(2)),
    workers_polled_ms: Number(workersPolledMs.toFixed(2)),
    task_count: tasks.length,
    worker_count: config.workers.length,
  };

  return {
    teamName: config.name,
    workerCount: config.worker_count,
    tasks: counts,
    workers: workerSummaries,
    nonReportingWorkers,
    performance: perf,
  };
}

// ---------------------------------------------------------------------------
// Team config save
// ---------------------------------------------------------------------------

export async function saveTeamConfig(config: TeamConfig, cwd: string): Promise<void> {
  await writeAtomic(absPath(cwd, TeamPaths.config(config.name)), JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// Scaling lock (file-based mutex for scale up/down)
// ---------------------------------------------------------------------------

export async function withScalingLock<T>(
  teamName: string,
  cwd: string,
  fn: () => Promise<T>,
  timeoutMs: number = 10_000,
): Promise<T> {
  const lockDir = absPath(cwd, TeamPaths.scalingLock(teamName));
  const { mkdir: mkdirAsync, rm } = await import('fs/promises');
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await mkdirAsync(lockDir, { recursive: false });
      try {
        return await fn();
      } finally {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`scaling lock timeout for team ${teamName}`);
}

// ---------------------------------------------------------------------------
// Snapshot diffing — derive events from two consecutive snapshots
// ---------------------------------------------------------------------------

export interface DerivedEvent {
  type: 'task_completed' | 'task_failed' | 'worker_idle' | 'worker_stopped';
  worker: string;
  task_id?: string;
  reason: string;
}

/**
 * Compare two consecutive monitor snapshots and derive events.
 * O(N) where N = max(task count, worker count).
 */
export function diffSnapshots(
  prev: TeamMonitorSnapshotState,
  current: TeamMonitorSnapshotState,
): DerivedEvent[] {
  const events: DerivedEvent[] = [];

  // Task status transitions
  for (const [taskId, currentStatus] of Object.entries(current.taskStatusById)) {
    const prevStatus = prev.taskStatusById[taskId];
    if (!prevStatus || prevStatus === currentStatus) continue;

    if (currentStatus === 'completed' && !prev.completedEventTaskIds[taskId]) {
      events.push({
        type: 'task_completed',
        worker: 'leader-fixed',
        task_id: taskId,
        reason: `status_transition:${prevStatus}->${currentStatus}`,
      });
    } else if (currentStatus === 'failed') {
      events.push({
        type: 'task_failed',
        worker: 'leader-fixed',
        task_id: taskId,
        reason: `status_transition:${prevStatus}->${currentStatus}`,
      });
    }
  }

  // Worker state transitions
  for (const [workerName, currentAlive] of Object.entries(current.workerAliveByName)) {
    const prevAlive = prev.workerAliveByName[workerName];
    if (prevAlive === true && !currentAlive) {
      events.push({
        type: 'worker_stopped',
        worker: workerName,
        reason: 'pane_exited',
      });
    }
  }

  for (const [workerName, currentState] of Object.entries(current.workerStateByName)) {
    const prevState = prev.workerStateByName[workerName];
    if (prevState === 'working' && currentState === 'idle') {
      events.push({
        type: 'worker_idle',
        worker: workerName,
        reason: `state_transition:${prevState}->${currentState}`,
      });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// State cleanup
// ---------------------------------------------------------------------------

export async function cleanupTeamState(teamName: string, cwd: string): Promise<void> {
  const root = absPath(cwd, TeamPaths.root(teamName));
  const { rm } = await import('fs/promises');
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
