import { readFile } from 'fs/promises';
import { join } from 'path';
import { tmuxExecAsync } from '../cli/tmux-utils.js';
import type { CliAgentType } from './model-contract.js';
import { validateTeamName } from './team-name.js';
import {
  adoptWorkerPaneOwnership,
  observeTmuxServerIdentity,
  isWorkerAlive,
  verifyTeamTargetOwnership,
  type WorkerPaneOwnership,
} from './tmux-session.js';
import { normalizeTaskFileStem, teamStateRoot } from './state-paths.js';
import { isValidTeamInstanceId, isValidTmuxServerIdentity, type TeamInstanceId, type TmuxServerIdentity } from './types.js';

export interface TeamConfig {
  teamName: string;
  instance_id?: TeamInstanceId;
  workerCount: number;
  agentTypes: CliAgentType[];
  tasks: Array<{ subject: string; description: string; }>;
  cwd: string;
  newWindow?: boolean;
  tmuxSession?: string;
  leaderPaneId?: string;
  tmuxOwnsWindow?: boolean;
  tmuxServerIdentity?: TmuxServerIdentity;
  workerNames?: string[];
  workerPaneIds?: string[];
  workerPaneByName?: Record<string, string>;
}

export interface ActiveWorkerState {
  paneId: string;
  taskId: string;
  spawnedAt: number;
}

export interface TeamRuntime {
  teamName: string;
  sessionName: string;
  leaderPaneId: string;
  ownsWindow?: boolean;
  config: TeamConfig;
  workerNames: string[];
  workerPaneIds: string[];
  activeWorkers: Map<string, ActiveWorkerState>;
  cwd: string;
  instanceId?: TeamInstanceId;
  tmuxServerIdentity?: TmuxServerIdentity;
  workerPaneOwnership?: Map<string, WorkerPaneOwnership>;
  workerPaneByName?: Map<string, string>;
}

export interface WorkerStatus {
  workerName: string;
  alive: boolean;
  paneId: string;
  currentTaskId?: string;
  lastHeartbeat?: string;
  stalled: boolean;
}

export interface TeamSnapshot {
  teamName: string;
  phase: string;
  workers: WorkerStatus[];
  taskCounts: { pending: number; inProgress: number; completed: number; failed: number; };
  deadWorkers: string[];
  monitorPerformance: {
    listTasksMs: number;
    workerScanMs: number;
    totalMs: number;
  };
}

interface TeamTaskRecord {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  owner: string | null;
  result?: string | null;
  summary?: string;
  createdAt?: string;
  assignedAt?: string;
  completedAt?: string;
  failedAt?: string;
}

function stateRoot(cwd: string, teamName: string): string {
  validateTeamName(teamName);
  return teamStateRoot(cwd, teamName);
}

async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}


function taskPath(root: string, taskId: string): string {
  return join(root, 'tasks', `${normalizeTaskFileStem(taskId)}.json`);
}

async function readTask(root: string, taskId: string): Promise<TeamTaskRecord | null> {
  return readJsonSafe<TeamTaskRecord>(taskPath(root, taskId));
}

/**
 * Reject unsupported legacy startup before any effects.
 */
export async function startTeam(_config: TeamConfig): Promise<TeamRuntime> {
  // The legacy runtime cannot publish the immutable instance/launch receipts
  // required by safe destruction. Public startup is v2-only; reject before
  // touching state, panes, providers, or worktrees rather than retaining an
  // alternate unsafe creation route.
  throw new Error(
    'team_start_unsafe_runtime_v1: instance-bound provider cleanup requires runtime v2; set OMC_RUNTIME_V2=1',
  );
}

/**
 * Monitor team: poll worker health, detect stalls, return snapshot.
 */
export async function monitorTeam(teamName: string, cwd: string, workerPaneIds: string[]): Promise<TeamSnapshot> {
  validateTeamName(teamName);
  const monitorStartedAt = Date.now();
  const root = stateRoot(cwd, teamName);

  // Read task counts
  const taskScanStartedAt = Date.now();
  const taskCounts = { pending: 0, inProgress: 0, completed: 0, failed: 0 };
  try {
    const { readdir } = await import('fs/promises');
    const taskFiles = await readdir(join(root, 'tasks'));
    for (const f of taskFiles.filter(f => f.endsWith('.json'))) {
      const task = await readJsonSafe<{ status: string }>(join(root, 'tasks', f));
      if (task?.status === 'pending') taskCounts.pending++;
      else if (task?.status === 'in_progress') taskCounts.inProgress++;
      else if (task?.status === 'completed') taskCounts.completed++;
      else if (task?.status === 'failed') taskCounts.failed++;
    }
  } catch { /* tasks dir may not exist yet */ }
  const listTasksMs = Date.now() - taskScanStartedAt;

  // Check worker health
  const workerScanStartedAt = Date.now();
  const workers: WorkerStatus[] = [];
  const deadWorkers: string[] = [];

  for (let i = 0; i < workerPaneIds.length; i++) {
    const wName = `worker-${i + 1}`;
    const paneId = workerPaneIds[i];
    const alive = await isWorkerAlive(paneId);
    const heartbeatPath = join(root, 'workers', wName, 'heartbeat.json');
    const heartbeat = await readJsonSafe<{ updatedAt: string; currentTaskId?: string }>(heartbeatPath);

    // Detect stall: no heartbeat update in 60s
    let stalled = false;
    if (heartbeat?.updatedAt) {
      const age = Date.now() - new Date(heartbeat.updatedAt).getTime();
      stalled = age > 60_000;
    }

    const status: WorkerStatus = {
      workerName: wName,
      alive,
      paneId,
      currentTaskId: heartbeat?.currentTaskId,
      lastHeartbeat: heartbeat?.updatedAt,
      stalled,
    };

    workers.push(status);
    if (!alive) deadWorkers.push(wName);
    // Note: CLI workers (codex/gemini/grok/cursor) may not write heartbeat.json — stall is advisory only
  }
  const workerScanMs = Date.now() - workerScanStartedAt;

  // Infer phase from task counts
  let phase = 'executing';
  if (taskCounts.inProgress === 0 && taskCounts.pending > 0 && taskCounts.completed === 0) {
    phase = 'planning';
  } else if (taskCounts.failed > 0 && taskCounts.pending === 0 && taskCounts.inProgress === 0) {
    phase = 'fixing';
  } else if (taskCounts.completed > 0 && taskCounts.pending === 0 && taskCounts.inProgress === 0 && taskCounts.failed === 0) {
    phase = 'completed';
  }

  return {
    teamName,
    phase,
    workers,
    taskCounts,
    deadWorkers,
    monitorPerformance: {
      listTasksMs,
      workerScanMs,
      totalMs: Date.now() - monitorStartedAt,
    },
  };
}



/**
 * Gracefully shut down all workers and clean up.
 *
 * The legacy runtime is intentionally destructive only when the caller
 * supplies an instance identity backed by the durable reservation protocol.
 * Omitting the identity preserves state rather than falling back to names or
 * pane IDs.
 */
export async function shutdownTeam(
  teamName: string,
  sessionName: string,
  cwd: string,
  timeoutMs = 30_000,
  workerPaneIds?: string[],
  leaderPaneId?: string,
  ownsWindow?: boolean,
  instanceId?: TeamInstanceId,
): Promise<boolean> {
  // V1 has no immutable launch receipts or instance reservation, so it cannot
  // safely authorize provider/process destruction. Delegate identity-bearing
  // callers to the real v2 provider cleanup protocol; all legacy/name-only
  // callers fail closed without touching panes, worktrees, or state.
  if (!instanceId) return false;
  try {
    const { shutdownTeamV2 } = await import('./runtime-v2.js');
    const result = await shutdownTeamV2(teamName, cwd, {
      instanceId,
      force: timeoutMs === 0,
      timeoutMs,
    });
    return result.outcome === 'cleaned';
  } catch {
    return false;
  }
}

/**
 * Resume an existing team from persisted state.
 * Reconstructs activeWorkers by scanning task files for in_progress tasks
 * for read-only status consumers. No legacy mutation loop is resumed.
 */
export async function resumeTeam(teamName: string, cwd: string): Promise<TeamRuntime | null> {
  const root = stateRoot(cwd, teamName);
  const configData = await readJsonSafe<TeamConfig>(join(root, 'config.json'));
  if (!configData || !isValidTeamInstanceId(configData.instance_id)) return null;

  const sName = configData.tmuxSession;
  const leaderPaneId = configData.leaderPaneId;
  const workerNames = configData.workerNames;
  const workerPaneByName = configData.workerPaneByName;
  if (!sName || !leaderPaneId || !leaderPaneId.trim()
    || !Array.isArray(workerNames)
    || new Set(workerNames).size !== workerNames.length
    || workerNames.some(name => typeof name !== 'string' || name.trim().length === 0)
    || !workerPaneByName
    || typeof workerPaneByName !== 'object'
    || Array.isArray(workerPaneByName)) {
    return null;
  }
  const workerPaneEntries = Object.entries(workerPaneByName);
  if (workerPaneEntries.some(([name, paneId]) => (
    !workerNames.includes(name)
    || typeof paneId !== 'string'
    || paneId.trim().length === 0
  ))) return null;
  const workerPaneIds = workerPaneEntries.map(([, paneId]) => paneId);
  if (new Set(workerPaneIds).size !== workerPaneIds.length) return null;
  if (Array.isArray(configData.workerPaneIds)) {
    if (new Set(configData.workerPaneIds).size !== configData.workerPaneIds.length
      || configData.workerPaneIds.length !== workerPaneIds.length
      || configData.workerPaneIds.some(paneId => !workerPaneIds.includes(paneId))) return null;
  }

  const provider = sName.startsWith('cmux:') ? 'cmux' : 'tmux';
  const tmuxServerIdentity = provider === 'tmux'
    ? configData.tmuxServerIdentity
    : undefined;
  if (provider === 'tmux') {
    if (!isValidTmuxServerIdentity(tmuxServerIdentity)) return null;
    if (await observeTmuxServerIdentity(tmuxServerIdentity) !== 'matching') return null;
    try {
      await tmuxExecAsync([
        '-S', tmuxServerIdentity.socket_path,
        'has-session',
        '-t', sName.split(':')[0]!,
      ]);
    } catch {
      return null;
    }
  }

  const leaderOwnership = await verifyTeamTargetOwnership({
    provider,
    providerTarget: sName,
    recipient: 'leader-fixed',
    recipientRole: 'leader',
    paneId: leaderPaneId,
    ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
  });
  if (leaderOwnership.kind !== 'owned') return null;

  const workerPaneOwnership = new Map<string, WorkerPaneOwnership>();
  for (let i = 0; i < workerPaneIds.length; i++) {
    const paneId = workerPaneIds[i]!;
    const ownership = await adoptWorkerPaneOwnership({
      provider,
      providerTarget: sName,
      paneId,
      leaderPaneId,
      reservedPaneIds: workerPaneIds.filter((candidate, index) => index !== i),
      ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
    });
    if (!ownership.ok) return null;
    workerPaneOwnership.set(paneId, ownership.ownership);
  }

  // Reconstruct activeWorkers by scanning task files for in_progress tasks.
  // Build a paneId lookup from the persisted creation mapping. Never use the
  // current pane order as a substitute for missing ownership evidence.
  const paneByWorker = new Map<string, string>(workerPaneEntries);

  const activeWorkers = new Map<string, ActiveWorkerState>();
  for (let i = 0; i < configData.tasks.length; i++) {
    const taskId = String(i + 1);
    const task = await readTask(root, taskId);
    if (task?.status === 'in_progress' && task.owner) {
      const paneId = paneByWorker.get(task.owner) ?? '';
      if (!paneId || !workerPaneOwnership.has(paneId)) return null;
      activeWorkers.set(task.owner, {
        paneId,
        taskId,
        spawnedAt: task.assignedAt ? new Date(task.assignedAt).getTime() : Date.now(),
      });
    }
  }

  return {
    teamName,
    sessionName: sName,
    leaderPaneId,
    config: configData,
    workerNames,
    workerPaneIds,
    activeWorkers,
    cwd,
    instanceId: configData.instance_id,
    tmuxServerIdentity,
    workerPaneOwnership,
    workerPaneByName: new Map(workerPaneEntries),
    ownsWindow: Boolean(configData.tmuxOwnsWindow),
  };
}
