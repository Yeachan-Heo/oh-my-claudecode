import { mkdir, writeFile, readFile, rm, rename } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import type { CliAgentType } from './model-contract.js';
import type { WorkerInteropConfig } from '../interop/adapter-types.js';
import { getInteropMode } from '../interop/mcp-bridge.js';
import {
  bridgeBootstrapToOmx, pollOmxCompletion,
} from '../interop/worker-adapter.js';
import { appendOmxTeamEvent } from '../interop/omx-team-state.js';
import { buildWorkerArgv, validateCliAvailable, getWorkerEnv as getModelWorkerEnv, isPromptModeAgent, getPromptModeArgs } from './model-contract.js';
import { validateTeamName } from './team-name.js';
import {
  createTeamSession, spawnWorkerInPane, sendToWorker,
  isWorkerAlive, killTeamSession,
  type TeamSession, type WorkerPaneConfig,
} from './tmux-session.js';
import {
  composeInitialInbox, ensureWorkerStateDir, writeWorkerOverlay,
} from './worker-bootstrap.js';
import { withTaskLock } from './task-file-ops.js';

export interface TeamConfig {
  teamName: string;
  workerCount: number;
  agentTypes: CliAgentType[];
  tasks: Array<{ subject: string; description: string; }>;
  cwd: string;
  /** Per-worker interop config for OMC-OMX cross-platform bridging (issue #1117) */
  workerInteropConfigs?: WorkerInteropConfig[];
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
  config: TeamConfig;
  workerNames: string[];
  workerPaneIds: string[];
  activeWorkers: Map<string, ActiveWorkerState>;
  cwd: string;
  stopWatchdog?: () => void;
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

export interface WatchdogCompletionEvent {
  workerName: string;
  taskId: string;
  status: 'completed' | 'failed';
  summary: string;
}

interface DoneSignal {
  taskId: string;
  status: 'completed' | 'failed';
  summary: string;
  completedAt: string;
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

function workerName(index: number): string {
  return `worker-${index + 1}`;
}

function stateRoot(cwd: string, teamName: string): string {
  validateTeamName(teamName);
  return join(cwd, `.omc/state/team/${teamName}`);
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    // Gemini CLI sometimes replaces double-quotes with backslashes in JSON output.
    // Only attempt recovery when the content has no double-quotes at all (total
    // substitution), to avoid destroying legitimate escape sequences.
    try {
      const content = await readFile(filePath, 'utf-8');
      if (content.includes('"')) return null;
      const recovered = content.replace(/\\/g, '"');
      return JSON.parse(recovered) as T;
    } catch {
      return null;
    }
  }
}

function parseWorkerIndex(workerNameValue: string): number {
  const match = workerNameValue.match(/^worker-(\d+)$/);
  if (!match) return 0;
  const parsed = Number.parseInt(match[1], 10) - 1;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** Check if a worker uses OMX state conventions based on runtime config */
function isOmxInteropWorker(runtime: TeamRuntime, workerNameValue: string): boolean {
  const wConfig = runtime.config.workerInteropConfigs?.find(c => c.workerName === workerNameValue);
  return wConfig?.interopMode === 'omx';
}

/** Build an AdapterContext from runtime state (returns null if interop is off) */
function buildAdapterContext(runtime: TeamRuntime): import('../interop/adapter-types.js').AdapterContext | null {
  const mode = getInteropMode();
  if (mode === 'off') return null;
  return { lead: 'omc', teamName: runtime.teamName, cwd: runtime.cwd, interopMode: mode };
}

function taskPath(root: string, taskId: string): string {
  return join(root, 'tasks', `${taskId}.json`);
}

async function writePanesTrackingFileIfPresent(runtime: TeamRuntime): Promise<void> {
  const jobId = process.env.OMC_JOB_ID;
  const omcJobsDir = process.env.OMC_JOBS_DIR;
  if (!jobId || !omcJobsDir) return;

  const panesPath = join(omcJobsDir, `${jobId}-panes.json`);
  const tempPath = `${panesPath}.tmp`;
  await writeFile(
    tempPath,
    JSON.stringify({ paneIds: [...runtime.workerPaneIds], leaderPaneId: runtime.leaderPaneId }),
    'utf-8'
  );
  await rename(tempPath, panesPath);
}

async function readTask(root: string, taskId: string): Promise<TeamTaskRecord | null> {
  return readJsonSafe<TeamTaskRecord>(taskPath(root, taskId));
}

async function writeTask(root: string, task: TeamTaskRecord): Promise<void> {
  await writeJson(taskPath(root, task.id), task);
}

async function markTaskInProgress(root: string, taskId: string, owner: string, teamName: string, cwd: string): Promise<boolean> {
  const result = await withTaskLock(teamName, taskId, async () => {
    const task = await readTask(root, taskId);
    if (!task || task.status !== 'pending') return false;
    task.status = 'in_progress';
    task.owner = owner;
    task.assignedAt = new Date().toISOString();
    await writeTask(root, task);
    return true;
  }, { cwd });
  // withTaskLock returns null if the lock could not be acquired — treat as not claimed
  return result ?? false;
}

async function resetTaskToPending(root: string, taskId: string): Promise<void> {
  const task = await readTask(root, taskId);
  if (!task) return;
  task.status = 'pending';
  task.owner = null;
  task.assignedAt = undefined;
  await writeTask(root, task);
}

async function markTaskFromDone(
  root: string,
  taskId: string,
  status: 'completed' | 'failed',
  summary: string
): Promise<void> {
  const task = await readTask(root, taskId);
  if (!task) return;
  task.status = status;
  task.result = summary;
  task.summary = summary;
  if (status === 'completed') {
    task.completedAt = new Date().toISOString();
  } else {
    task.failedAt = new Date().toISOString();
  }
  await writeTask(root, task);
}

async function markTaskFailedDeadPane(root: string, taskId: string, workerNameValue: string): Promise<void> {
  const task = await readTask(root, taskId);
  if (!task) return;
  task.status = 'failed';
  task.owner = workerNameValue;
  task.summary = `Worker pane died before done.json was written (${workerNameValue})`;
  task.result = task.summary;
  task.failedAt = new Date().toISOString();
  await writeTask(root, task);
}

async function nextPendingTaskIndex(runtime: TeamRuntime): Promise<number | null> {
  const root = stateRoot(runtime.cwd, runtime.teamName);
  for (let i = 0; i < runtime.config.tasks.length; i++) {
    const task = await readTask(root, String(i + 1));
    if (task?.status === 'pending') return i;
  }
  return null;
}

async function notifyPaneWithRetry(
  sessionName: string,
  paneId: string,
  message: string,
  maxAttempts = 6,
  retryDelayMs = 350
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await sendToWorker(sessionName, paneId, message)) {
      return true;
    }
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }
  return false;
}

export async function allTasksTerminal(runtime: TeamRuntime): Promise<boolean> {
  const root = stateRoot(runtime.cwd, runtime.teamName);
  for (let i = 0; i < runtime.config.tasks.length; i++) {
    const task = await readTask(root, String(i + 1));
    if (!task) return false;
    if (task.status !== 'completed' && task.status !== 'failed') return false;
  }
  return true;
}

/**
 * Build the initial task instruction written to a worker's inbox.
 * Includes task ID, subject, full description, and done-signal path.
 */
function buildInitialTaskInstruction(
  teamName: string,
  workerName: string,
  task: { subject: string; description: string },
  taskId: string
): string {
  const readyPath = `.omc/state/team/${teamName}/workers/${workerName}/.ready`;
  const donePath = `.omc/state/team/${teamName}/workers/${workerName}/done.json`;
  const doneDir = `.omc/state/team/${teamName}/workers/${workerName}`;
  return [
    `## Initial Task Assignment`,
    `Task ID: ${taskId}`,
    `Worker: ${workerName}`,
    `Subject: ${task.subject}`,
    ``,
    `## FIRST ACTION REQUIRED`,
    `Before doing anything else, write your ready sentinel file:`,
    '```bash',
    `mkdir -p $(dirname ${readyPath}) && touch ${readyPath}`,
    '```',
    ``,
    task.description,
    ``,
    `When complete, write done signal using a bash command (do NOT use a file-write tool):`,
    '```bash',
    `mkdir -p ${doneDir} && echo '{"taskId":"${taskId}","status":"completed","summary":"done","completedAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > ${donePath}`,
    '```',
    `For failures, set status to "failed" and include the error in summary.`,
    ``,
    `IMPORTANT: Execute ONLY the task assigned to you in this inbox. After writing done.json, exit immediately. Do not read from the task directory or claim other tasks.`,
  ].join('\n');
}

/**
 * Start a new team: create tmux session, spawn workers, wait for ready.
 */
export async function startTeam(config: TeamConfig): Promise<TeamRuntime> {
  const { teamName, agentTypes, tasks, cwd } = config;
  validateTeamName(teamName);

  // Validate CLIs are available
  for (const agentType of [...new Set(agentTypes)]) {
    validateCliAvailable(agentType);
  }

  const root = stateRoot(cwd, teamName);
  await mkdir(join(root, 'tasks'), { recursive: true });
  await mkdir(join(root, 'mailbox'), { recursive: true });

  // Write config
  await writeJson(join(root, 'config.json'), config);

  // Create task files
  for (let i = 0; i < tasks.length; i++) {
    const taskId = String(i + 1);
    await writeJson(join(root, 'tasks', `${taskId}.json`), {
      id: taskId,
      subject: tasks[i].subject,
      description: tasks[i].description,
      status: 'pending',
      owner: null,
      result: null,
      createdAt: new Date().toISOString(),
    });
  }

  // Set up worker state dirs and overlays for all potential workers up front
  // (overlays are cheap; workers are spawned on-demand later)
  const workerNames: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const wName = workerName(i);
    workerNames.push(wName);
    const agentType = agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? 'claude';
    await ensureWorkerStateDir(teamName, wName, cwd);
    await writeWorkerOverlay({
      teamName, workerName: wName, agentType,
      tasks: tasks.map((t, idx) => ({ id: String(idx + 1), subject: t.subject, description: t.description })),
      cwd,
    });
  }

  // Create tmux session with ZERO worker panes (leader only).
  // Workers are spawned on-demand by the orchestrator.
  const session: TeamSession = await createTeamSession(teamName, 0, cwd);
  const runtime: TeamRuntime = {
    teamName,
    sessionName: session.sessionName,
    leaderPaneId: session.leaderPaneId,
    config,
    workerNames,
    workerPaneIds: session.workerPaneIds, // initially empty []
    activeWorkers: new Map(),
    cwd,
  };

  const maxConcurrentWorkers = agentTypes.length;
  for (let i = 0; i < maxConcurrentWorkers; i++) {
    const taskIndex = await nextPendingTaskIndex(runtime);
    if (taskIndex == null) break;
    await spawnWorkerForTask(runtime, workerName(i), taskIndex);
  }

  runtime.stopWatchdog = watchdogCliWorkers(runtime, 1000);
  return runtime;
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
    // Note: CLI workers (codex/gemini) may not write heartbeat.json — stall is advisory only
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
 * Runtime-owned worker watchdog/orchestrator loop.
 * Handles done.json completion, dead pane failures, and next-task spawning.
 */
export function watchdogCliWorkers(runtime: TeamRuntime, intervalMs: number): () => void {
  let tickInFlight = false;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;
  // Track consecutive unresponsive ticks per worker
  const unresponsiveCounts = new Map<string, number>();
  const UNRESPONSIVE_KILL_THRESHOLD = 3;

  const tick = async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const workers = [...runtime.activeWorkers.entries()];
      if (workers.length === 0) return;

      const root = stateRoot(runtime.cwd, runtime.teamName);

      // Interop: poll OMX task files for completion and synthesize done.json shims (issue #1117).
      // This runs BEFORE the done.json collection below so the shim is available on the same tick.
      const adapterCtx = buildAdapterContext(runtime);
      if (adapterCtx) {
        await Promise.all(workers
          .filter(([wName]) => isOmxInteropWorker(runtime, wName))
          .map(([wName, active]) => pollOmxCompletion(adapterCtx, wName, active.taskId).catch(() => null))
        );
      }

      // Collect done signals and alive checks in parallel to avoid O(N×300ms) sequential tmux calls.
      const [doneSignals, aliveResults] = await Promise.all([
        Promise.all(workers.map(([wName]) => {
          const donePath = join(root, 'workers', wName, 'done.json');
          return readJsonSafe<DoneSignal>(donePath);
        })),
        Promise.all(workers.map(([, active]) => isWorkerAlive(active.paneId))),
      ]);

      for (let i = 0; i < workers.length; i++) {
        const [wName, active] = workers[i];
        const donePath = join(root, 'workers', wName, 'done.json');
        const signal = doneSignals[i];

        // Process done.json first if present
        if (signal) {
          unresponsiveCounts.delete(wName);
          await markTaskFromDone(root, signal.taskId || active.taskId, signal.status, signal.summary);
          try {
            const { unlink } = await import('fs/promises');
            await unlink(donePath);
          } catch {
            // no-op
          }
          await killWorkerPane(runtime, wName, active.paneId);
          if (!(await allTasksTerminal(runtime))) {
            const nextTaskIndexValue = await nextPendingTaskIndex(runtime);
            if (nextTaskIndexValue != null) {
              await spawnWorkerForTask(runtime, wName, nextTaskIndexValue);
            }
          }
          continue;
        }

        // Dead pane without done.json => fail task, do not requeue
        const alive = aliveResults[i];
        if (!alive) {
          unresponsiveCounts.delete(wName);
          await markTaskFailedDeadPane(root, active.taskId, wName);
          await killWorkerPane(runtime, wName, active.paneId);
          if (!(await allTasksTerminal(runtime))) {
            const nextTaskIndexValue = await nextPendingTaskIndex(runtime);
            if (nextTaskIndexValue != null) {
              await spawnWorkerForTask(runtime, wName, nextTaskIndexValue);
            }
          }
          continue;
        }

        // Pane is alive but no done.json — check heartbeat for stall detection
        const heartbeatPath = join(root, 'workers', wName, 'heartbeat.json');
        const heartbeat = await readJsonSafe<{ updatedAt: string }>(heartbeatPath);
        const isStalled = heartbeat?.updatedAt
          ? Date.now() - new Date(heartbeat.updatedAt).getTime() > 60_000
          : false;

        if (isStalled) {
          const count = (unresponsiveCounts.get(wName) ?? 0) + 1;
          unresponsiveCounts.set(wName, count);
          if (count < UNRESPONSIVE_KILL_THRESHOLD) {
            console.warn(`[watchdog] worker ${wName} unresponsive (${count}/${UNRESPONSIVE_KILL_THRESHOLD}), task ${active.taskId}`);
          } else {
            console.warn(`[watchdog] worker ${wName} unresponsive ${count} consecutive ticks — killing and reassigning task ${active.taskId}`);
            unresponsiveCounts.delete(wName);
            await markTaskFailedDeadPane(root, active.taskId, wName);
            await killWorkerPane(runtime, wName, active.paneId);
            if (!(await allTasksTerminal(runtime))) {
              const nextTaskIndexValue = await nextPendingTaskIndex(runtime);
              if (nextTaskIndexValue != null) {
                await spawnWorkerForTask(runtime, wName, nextTaskIndexValue);
              }
            }
          }
        } else {
          // Worker is responsive — reset counter
          unresponsiveCounts.delete(wName);
        }
      }
      // Reset failure counter on a successful tick
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      console.warn('[watchdog] tick error:', err);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(`[watchdog] ${consecutiveFailures} consecutive failures — marking team as failed`);
        try {
          const root = stateRoot(runtime.cwd, runtime.teamName);
          await writeJson(join(root, 'watchdog-failed.json'), {
            failedAt: new Date().toISOString(),
            consecutiveFailures,
            lastError: err instanceof Error ? err.message : String(err),
          });
        } catch {
          // best-effort
        }
        clearInterval(intervalId);
      }
    } finally {
      tickInFlight = false;
    }
  };

  const intervalId = setInterval(() => { tick(); }, intervalMs);

  return () => clearInterval(intervalId);
}

/**
 * Spawn a worker pane for an explicit task assignment.
 */
export async function spawnWorkerForTask(
  runtime: TeamRuntime,
  workerNameValue: string,
  taskIndex: number
): Promise<string> {
  const root = stateRoot(runtime.cwd, runtime.teamName);
  const taskId = String(taskIndex + 1);
  const task = runtime.config.tasks[taskIndex];
  if (!task) return '';
  const marked = await markTaskInProgress(root, taskId, workerNameValue, runtime.teamName, runtime.cwd);
  if (!marked) return '';

  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const splitTarget = runtime.workerPaneIds.length === 0
    ? runtime.leaderPaneId
    : runtime.workerPaneIds[runtime.workerPaneIds.length - 1];
  const splitType = runtime.workerPaneIds.length === 0 ? '-h' : '-v';
  const splitResult = await execFileAsync('tmux', [
    'split-window', splitType, '-t', splitTarget,
    '-d', '-P', '-F', '#{pane_id}',
    '-c', runtime.cwd,
  ]);
  const paneId = splitResult.stdout.split('\n')[0]?.trim();
  if (!paneId) return '';

  const workerIndex = parseWorkerIndex(workerNameValue);
  const agentType = runtime.config.agentTypes[workerIndex % runtime.config.agentTypes.length]
    ?? runtime.config.agentTypes[0]
    ?? 'claude';
  const usePromptMode = isPromptModeAgent(agentType);

  // Build the initial task instruction and write inbox before spawn.
  // For prompt-mode agents the instruction is passed via CLI flag;
  // for interactive agents it is sent via tmux send-keys after startup.
  const instruction = buildInitialTaskInstruction(runtime.teamName, workerNameValue, task, taskId);
  await composeInitialInbox(runtime.teamName, workerNameValue, instruction, runtime.cwd);
  const relInboxPath = `.omc/state/team/${runtime.teamName}/workers/${workerNameValue}/inbox.md`;

  const envVars = getModelWorkerEnv(runtime.teamName, workerNameValue, agentType);
  const [launchBinary, ...launchArgs] = buildWorkerArgv(agentType, {
    teamName: runtime.teamName,
    workerName: workerNameValue,
    cwd: runtime.cwd,
  });

  // For prompt-mode agents (e.g. Gemini Ink TUI), pass the full task
  // instruction inline via CLI flag. This bypasses gitignore restrictions
  // (e.g. Gemini's respectGitIgnore=true ignoring .omc/ paths) by embedding
  // the task content directly in the CLI argument instead of referencing an
  // inbox file that may be invisible to the worker. See #1148.
  if (usePromptMode) {
    const promptArgs = getPromptModeArgs(agentType, instruction);
    launchArgs.push(...promptArgs);
  }

  const paneConfig: WorkerPaneConfig = {
    teamName: runtime.teamName,
    workerName: workerNameValue,
    envVars,
    launchBinary,
    launchArgs,
    cwd: runtime.cwd,
  };

  // For promptMode agents, wait for the shell to be ready before sending keys
  // to avoid the race condition where send-keys fires before zsh is ready (#1144).
  // Non-promptMode agents already have a 4s post-spawn delay, so skip the wait.
  await spawnWorkerInPane(runtime.sessionName, paneId, paneConfig, {
    waitForShell: usePromptMode,
  });

  runtime.workerPaneIds.push(paneId);
  runtime.activeWorkers.set(workerNameValue, { paneId, taskId, spawnedAt: Date.now() });

  try {
    await execFileAsync('tmux', ['select-layout', '-t', runtime.sessionName, 'main-vertical']);
  } catch {
    // layout update is best-effort
  }

  try {
    await writePanesTrackingFileIfPresent(runtime);
  } catch {
    // panes tracking is best-effort
  }

  if (!usePromptMode) {
    // Interactive mode: wait for CLI startup, handle trust-confirm, then
    // send instruction via tmux send-keys.
    await new Promise(r => setTimeout(r, 4000));
    if (agentType === 'gemini') {
      const confirmed = await notifyPaneWithRetry(runtime.sessionName, paneId, '1');
      if (!confirmed) {
        await killWorkerPane(runtime, workerNameValue, paneId);
        await resetTaskToPending(root, taskId);
        throw new Error(`worker_notify_failed:${workerNameValue}:trust-confirm`);
      }
      await new Promise(r => setTimeout(r, 800));
    }

    const notified = await notifyPaneWithRetry(
      runtime.sessionName,
      paneId,
      `Read and execute your task from: ${relInboxPath}`
    );
    if (!notified) {
      await killWorkerPane(runtime, workerNameValue, paneId);
      await resetTaskToPending(root, taskId);
      throw new Error(`worker_notify_failed:${workerNameValue}:initial-inbox`);
    }
  }
  // Prompt-mode agents: instruction already passed via CLI flag at spawn.
  // No trust-confirm or tmux send-keys interaction needed.

  // Interop: bridge bootstrap to OMX format for cross-platform workers (issue #1117)
  if (isOmxInteropWorker(runtime, workerNameValue)) {
    const ctx = buildAdapterContext(runtime);
    if (ctx) {
      try {
        await bridgeBootstrapToOmx(ctx, workerNameValue, { id: taskId, subject: task.subject, description: task.description });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[spawnWorkerForTask] interop bootstrap failed for ${workerNameValue} task ${taskId}: ${message}`);
      }
    }
  }

  return paneId;
}

/**
 * Kill a single worker pane and update runtime state.
 */
export async function killWorkerPane(
  runtime: TeamRuntime,
  workerNameValue: string,
  paneId: string
): Promise<void> {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('tmux', ['kill-pane', '-t', paneId]);
  } catch {
    // idempotent: pane may already be gone
  }

  const paneIndex = runtime.workerPaneIds.indexOf(paneId);
  if (paneIndex >= 0) {
    runtime.workerPaneIds.splice(paneIndex, 1);
  }
  runtime.activeWorkers.delete(workerNameValue);

  try {
    await writePanesTrackingFileIfPresent(runtime);
  } catch {
    // panes tracking is best-effort
  }
}

/**
 * Assign a task to a specific worker via inbox + tmux trigger.
 */
export async function assignTask(
  teamName: string,
  taskId: string,
  targetWorkerName: string,
  paneId: string,
  sessionName: string,
  cwd: string
): Promise<void> {
  const root = stateRoot(cwd, teamName);
  const taskFilePath = join(root, 'tasks', `${taskId}.json`);

  // Update task ownership under an exclusive lock to prevent concurrent double-claims
  type TaskSnapshot = { status: string; owner: string | null; assignedAt: string | undefined };
  let previousTaskState: TaskSnapshot | null = null;
  let lockedTask: TeamTaskRecord | null = null;
  await withTaskLock(teamName, taskId, async () => {
    const t = await readJsonSafe<TeamTaskRecord>(taskFilePath);
    lockedTask = t;
    previousTaskState = t ? {
      status: t.status,
      owner: t.owner,
      assignedAt: t.assignedAt,
    } : null;
    if (t) {
      t.owner = targetWorkerName;
      t.status = 'in_progress';
      t.assignedAt = new Date().toISOString();
      await writeJson(taskFilePath, t);
    }
  }, { cwd });

  // Write to worker inbox
  const inboxPath = join(root, 'workers', targetWorkerName, 'inbox.md');
  await mkdir(join(inboxPath, '..'), { recursive: true });
  const msg = `\n\n---\n## New Task Assignment\nTask ID: ${taskId}\nClaim and execute task from: .omc/state/team/${teamName}/tasks/${taskId}.json\n`;
  const { appendFile } = await import('fs/promises');
  await appendFile(inboxPath, msg, 'utf-8');

  // Send tmux trigger
  const notified = await notifyPaneWithRetry(sessionName, paneId, `new-task:${taskId}`);
  if (!notified) {
    if (lockedTask && previousTaskState) {
      const rollback = lockedTask as TeamTaskRecord;
      rollback.status = (previousTaskState as TaskSnapshot).status as TeamTaskRecord['status'];
      rollback.owner = (previousTaskState as TaskSnapshot).owner;
      rollback.assignedAt = (previousTaskState as TaskSnapshot).assignedAt;
      await writeJson(taskFilePath, rollback);
    }
    throw new Error(`worker_notify_failed:${targetWorkerName}:new-task:${taskId}`);
  }
}

/**
 * Gracefully shut down all workers and clean up.
 */
export async function shutdownTeam(
  teamName: string,
  sessionName: string,
  cwd: string,
  timeoutMs = 30_000,
  workerPaneIds?: string[],
  leaderPaneId?: string
): Promise<void> {
  const root = stateRoot(cwd, teamName);

  // Write shutdown request
  await writeJson(join(root, 'shutdown.json'), {
    requestedAt: new Date().toISOString(),
    teamName,
  });

  const configData = await readJsonSafe<TeamConfig>(join(root, 'config.json'));

  // CLI workers (claude/codex/gemini tmux pane processes) never write shutdown-ack.json.
  // Polling for ACK files on CLI worker teams wastes the full timeoutMs on every shutdown.
  // Detect CLI worker teams by checking if all agent types are known CLI types, and skip
  // ACK polling — the tmux kill below handles process cleanup instead.
  const CLI_AGENT_TYPES = new Set<string>(['claude', 'codex', 'gemini']);
  const agentTypes: string[] = configData?.agentTypes ?? [];
  const isCliWorkerTeam = agentTypes.length > 0 && agentTypes.every(t => CLI_AGENT_TYPES.has(t));

  if (!isCliWorkerTeam) {
    // Bridge daemon workers do write shutdown-ack.json — poll for them.
    const deadline = Date.now() + timeoutMs;
    const workerCount = configData?.workerCount ?? 0;
    const expectedAcks = Array.from({ length: workerCount }, (_, i) => `worker-${i + 1}`);

    while (Date.now() < deadline && expectedAcks.length > 0) {
      for (const wName of [...expectedAcks]) {
        const ackPath = join(root, 'workers', wName, 'shutdown-ack.json');
        if (existsSync(ackPath)) {
          expectedAcks.splice(expectedAcks.indexOf(wName), 1);
        }
      }
      if (expectedAcks.length > 0) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }
  // CLI worker teams: skip ACK polling — process exit is handled by tmux kill below.

  // Interop: write shutdown event to OMX event log for cross-platform workers (issue #1117)
  const interopMode = getInteropMode();
  if (interopMode !== 'off' && configData?.workerInteropConfigs) {
    const omxWorkers = configData.workerInteropConfigs.filter(c => c.interopMode === 'omx');
    for (const wConfig of omxWorkers) {
      try {
        await appendOmxTeamEvent(teamName, {
          type: 'worker_stopped',
          worker: wConfig.workerName,
          task_id: undefined,
        }, cwd);
      } catch {
        // best-effort: OMX event log may not exist
      }
    }
  }

  // Kill tmux session (or just worker panes in split-pane mode)
  await killTeamSession(sessionName, workerPaneIds, leaderPaneId);

  // Clean up state
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Resume an existing team from persisted state.
 * Reconstructs activeWorkers by scanning task files for in_progress tasks
 * so the watchdog loop can continue processing without stalling.
 */
export async function resumeTeam(teamName: string, cwd: string): Promise<TeamRuntime | null> {
  const root = stateRoot(cwd, teamName);
  const configData = await readJsonSafe<TeamConfig>(join(root, 'config.json'));
  if (!configData) return null;

  // Check if session is alive
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const sName = `omc-team-${teamName}`;

  try {
    await execFileAsync('tmux', ['has-session', '-t', sName]);
  } catch {
    return null; // Session not alive
  }

  // Read saved pane IDs (if we save them — for now derive from session)
  const panesResult = await execFileAsync('tmux', [
    'list-panes', '-t', sName, '-F', '#{pane_id}'
  ]);
  const allPanes = panesResult.stdout.trim().split('\n').filter(Boolean);
  // First pane is leader, rest are workers
  const workerPaneIds = allPanes.slice(1);
  const workerNames = workerPaneIds.map((_, i) => `worker-${i + 1}`);

  // Reconstruct activeWorkers by scanning task files for in_progress tasks.
  // Build a paneId lookup: worker-N maps to workerPaneIds[N-1].
  const paneByWorker = new Map<string, string>(
    workerNames.map((wName, i) => [wName, workerPaneIds[i] ?? ''])
  );

  const activeWorkers = new Map<string, ActiveWorkerState>();
  for (let i = 0; i < configData.tasks.length; i++) {
    const taskId = String(i + 1);
    const task = await readTask(root, taskId);
    if (task?.status === 'in_progress' && task.owner) {
      const paneId = paneByWorker.get(task.owner) ?? '';
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
    leaderPaneId: allPanes[0] ?? '',
    config: configData,
    workerNames,
    workerPaneIds,
    activeWorkers,
    cwd,
  };
}
