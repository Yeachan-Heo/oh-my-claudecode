/**
 * Dynamic worker scaling for team mode — Phase 1: Manual Scaling.
 *
 * Provides scale_up (add workers mid-session) and scale_down (drain + remove idle workers).
 * Gated behind the OMC_TEAM_SCALING_ENABLED environment variable.
 *
 * Key design decisions:
 * - Monotonic worker index counter (next_worker_index in config) ensures unique names
 * - File-based scaling lock prevents concurrent scale operations
 * - 'draining' worker status for graceful transitions during scale_down
 */

import { resolve } from 'path';
import { mkdir } from 'fs/promises';
import { execFileSync, spawnSync } from 'child_process';
import {
  teamReadConfig,
  teamWriteWorkerIdentity,
  teamReadWorkerStatus,
  teamAppendEvent,
  writeAtomic,
  type WorkerInfo,
  type WorkerStatus,
} from './team-ops.js';
import { withScalingLock, saveTeamConfig } from './monitor.js';
import {
  sanitizeName,
  isWorkerAlive,
  killWorkerPanes,
  buildWorkerStartCommand,
  waitForPaneReady,
} from './tmux-session.js';
import { TeamPaths, absPath } from './state-paths.js';

// ── Environment gate ──────────────────────────────────────────────────────────

const OMC_TEAM_SCALING_ENABLED_ENV = 'OMC_TEAM_SCALING_ENABLED';

export function isScalingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OMC_TEAM_SCALING_ENABLED_ENV];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized);
}

function assertScalingEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!isScalingEnabled(env)) {
    throw new Error(
      `Dynamic scaling is disabled. Set ${OMC_TEAM_SCALING_ENABLED_ENV}=1 to enable.`,
    );
  }
}

// ── Result types ──────────────────────────────────────────────────────────────

export interface ScaleUpResult {
  ok: true;
  addedWorkers: WorkerInfo[];
  newWorkerCount: number;
  nextWorkerIndex: number;
}

export interface ScaleDownResult {
  ok: true;
  removedWorkers: string[];
  newWorkerCount: number;
}

export interface ScaleError {
  ok: false;
  error: string;
}

// ── Scale Up ──────────────────────────────────────────────────────────────────

/**
 * Add workers to a running team mid-session.
 *
 * Acquires the file-based scaling lock, reads the current config,
 * validates capacity, creates new tmux panes, and bootstraps workers.
 */
export async function scaleUp(
  teamName: string,
  count: number,
  agentType: string,
  tasks: Array<{ subject: string; description: string; owner?: string; blocked_by?: string[]; role?: string }>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScaleUpResult | ScaleError> {
  assertScalingEnabled(env);

  if (!Number.isInteger(count) || count < 1) {
    return { ok: false, error: `count must be a positive integer (got ${count})` };
  }

  const sanitized = sanitizeName(teamName);
  const leaderCwd = resolve(cwd);

  return await withScalingLock(sanitized, leaderCwd, async (): Promise<ScaleUpResult | ScaleError> => {
    const config = await teamReadConfig(sanitized, leaderCwd);
    if (!config) {
      return { ok: false, error: `Team ${sanitized} not found` };
    }

    const maxWorkers = config.max_workers ?? 20;
    const currentCount = config.workers.length;
    if (currentCount + count > maxWorkers) {
      return {
        ok: false,
        error: `Cannot add ${count} workers: would exceed max_workers (${currentCount} + ${count} > ${maxWorkers})`,
      };
    }

    const teamStateRoot = config.team_state_root ?? `${leaderCwd}/.omc/state`;

    // Resolve the monotonic worker index counter
    let nextIndex = config.next_worker_index ?? (currentCount + 1);
    const initialNextIndex = nextIndex;
    const addedWorkers: WorkerInfo[] = [];

    const rollbackScaleUp = async (error: string, paneId?: string): Promise<ScaleError> => {
      for (const w of addedWorkers) {
        const idx = config.workers.findIndex((worker) => worker.name === w.name);
        if (idx >= 0) {
          config.workers.splice(idx, 1);
        }
        try {
          if (w.pane_id) {
            execFileSync('tmux', ['kill-pane', '-t', w.pane_id], { stdio: 'pipe' });
          }
        } catch { /* best-effort pane cleanup */ }
      }

      if (paneId) {
        try {
          execFileSync('tmux', ['kill-pane', '-t', paneId], { stdio: 'pipe' });
        } catch { /* best-effort pane cleanup */ }
      }

      config.worker_count = config.workers.length;
      config.next_worker_index = initialNextIndex;
      await saveTeamConfig(config, leaderCwd);

      return { ok: false, error };
    };

    for (let i = 0; i < count; i++) {
      const workerIndex = nextIndex;
      nextIndex++;
      const workerName = `worker-${workerIndex}`;

      // Create worker directory
      const workerDirPath = absPath(leaderCwd, TeamPaths.workerDir(sanitized, workerName));
      await mkdir(workerDirPath, { recursive: true });

      // Build startup command and create tmux pane
      const extraEnv: Record<string, string> = {
        OMC_TEAM_STATE_ROOT: teamStateRoot,
        OMC_TEAM_LEADER_CWD: leaderCwd,
        OMC_TEAM_WORKER: `${sanitized}/${workerName}`,
      };

      const cmd = buildWorkerStartCommand({
        teamName: sanitized,
        workerName,
        envVars: extraEnv,
        launchArgs: [],
        launchBinary: 'claude',
        launchCmd: '',
        cwd: leaderCwd,
      });

      // Split from the rightmost worker pane or the leader pane
      const splitTarget = config.workers.length > 0
        ? (config.workers[config.workers.length - 1]?.pane_id ?? config.leader_pane_id ?? '')
        : (config.leader_pane_id ?? '');
      const splitDirection = splitTarget === (config.leader_pane_id ?? '') ? '-h' : '-v';

      const result = spawnSync('tmux', [
        'split-window', splitDirection, '-t', splitTarget, '-d', '-P', '-F', '#{pane_id}', '-c', leaderCwd, cmd,
      ], { encoding: 'utf-8' });

      if (result.status !== 0) {
        return await rollbackScaleUp(`Failed to create tmux pane for ${workerName}: ${(result.stderr || '').trim()}`);
      }

      const paneId = (result.stdout || '').trim().split('\n')[0]?.trim();
      if (!paneId || !paneId.startsWith('%')) {
        return await rollbackScaleUp(`Failed to capture pane ID for ${workerName}`);
      }

      // Get PID
      let panePid: number | undefined;
      try {
        const pidResult = spawnSync('tmux', ['display-message', '-t', paneId, '-p', '#{pane_pid}'], { encoding: 'utf-8' });
        const pidStr = (pidResult.stdout || '').trim();
        const parsed = Number.parseInt(pidStr, 10);
        if (Number.isFinite(parsed)) panePid = parsed;
      } catch { /* best-effort pid lookup */ }

      // Resolve per-worker role from assigned task roles
      const workerTaskRoles = tasks.filter(t => t.owner === workerName).map(t => t.role).filter(Boolean) as string[];
      const uniqueTaskRoles = new Set(workerTaskRoles);
      const workerRole = workerTaskRoles.length > 0 && uniqueTaskRoles.size === 1
        ? workerTaskRoles[0]!
        : agentType;

      const workerInfo: WorkerInfo = {
        name: workerName,
        index: workerIndex,
        role: workerRole,
        assigned_tasks: [],
        pid: panePid,
        pane_id: paneId,
        working_dir: leaderCwd,
        team_state_root: teamStateRoot,
      };

      await teamWriteWorkerIdentity(sanitized, workerName, workerInfo, leaderCwd);

      // Wait for worker readiness
      const readyTimeoutMs = resolveWorkerReadyTimeoutMs(env);
      const skipReadyWait = env.OMC_TEAM_SKIP_READY_WAIT === '1';
      if (!skipReadyWait) {
        try {
          await waitForPaneReady(paneId, { timeoutMs: readyTimeoutMs });
        } catch {
          // Non-fatal: worker may still become ready
        }
      }

      addedWorkers.push(workerInfo);
      config.workers.push(workerInfo);
      config.worker_count = config.workers.length;
      config.next_worker_index = nextIndex;
      await saveTeamConfig(config, leaderCwd);
    }

    await teamAppendEvent(sanitized, {
      type: 'team_leader_nudge',
      worker: 'leader-fixed',
      reason: `scale_up: added ${count} worker(s), new count=${config.worker_count}`,
    }, leaderCwd);

    return {
      ok: true,
      addedWorkers,
      newWorkerCount: config.worker_count,
      nextWorkerIndex: nextIndex,
    };
  });
}

// ── Scale Down ────────────────────────────────────────────────────────────────

export interface ScaleDownOptions {
  /** Worker names to remove. If empty, removes idle workers up to `count`. */
  workerNames?: string[];
  /** Number of idle workers to remove (used when workerNames is not specified). */
  count?: number;
  /** Force kill without waiting for drain. Default: false. */
  force?: boolean;
  /** Drain timeout in milliseconds. Default: 30000. */
  drainTimeoutMs?: number;
}

/**
 * Remove workers from a running team.
 *
 * Sets targeted workers to 'draining' status, waits for them to finish
 * current work (or force kills), then removes tmux panes and updates config.
 */
export async function scaleDown(
  teamName: string,
  cwd: string,
  options: ScaleDownOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScaleDownResult | ScaleError> {
  assertScalingEnabled(env);

  const sanitized = sanitizeName(teamName);
  const leaderCwd = resolve(cwd);
  const force = options.force === true;
  const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;

  return await withScalingLock(sanitized, leaderCwd, async (): Promise<ScaleDownResult | ScaleError> => {
    const config = await teamReadConfig(sanitized, leaderCwd);
    if (!config) {
      return { ok: false, error: `Team ${sanitized} not found` };
    }

    // Determine which workers to remove
    let targetWorkers: WorkerInfo[];
    if (options.workerNames && options.workerNames.length > 0) {
      targetWorkers = [];
      for (const name of options.workerNames) {
        const w = config.workers.find(w => w.name === name);
        if (!w) {
          return { ok: false, error: `Worker ${name} not found in team ${sanitized}` };
        }
        targetWorkers.push(w);
      }
    } else {
      const count = options.count ?? 1;
      if (!Number.isInteger(count) || count < 1) {
        return { ok: false, error: `count must be a positive integer (got ${count})` };
      }
      // Find idle workers to remove
      const idleWorkers: WorkerInfo[] = [];
      for (const w of config.workers) {
        const status = await teamReadWorkerStatus(sanitized, w.name, leaderCwd);
        if (status.state === 'idle' || status.state === 'done' || status.state === 'unknown') {
          idleWorkers.push(w);
        }
      }
      if (idleWorkers.length < count && !force) {
        return {
          ok: false,
          error: `Not enough idle workers to remove: found ${idleWorkers.length}, requested ${count}. Use force=true to remove busy workers.`,
        };
      }
      targetWorkers = idleWorkers.slice(0, count);
      if (force && targetWorkers.length < count) {
        const remaining = count - targetWorkers.length;
        const targetNames = new Set(targetWorkers.map(w => w.name));
        const nonIdle = config.workers.filter(w => !targetNames.has(w.name));
        targetWorkers.push(...nonIdle.slice(0, remaining));
      }
    }

    if (targetWorkers.length === 0) {
      return { ok: false, error: 'No workers selected for removal' };
    }

    // Minimum worker guard: must keep at least 1 worker
    if (config.workers.length - targetWorkers.length < 1) {
      return { ok: false, error: 'Cannot remove all workers — at least 1 must remain' };
    }

    const removedNames: string[] = [];

    // Phase 1: Set workers to 'draining' status
    for (const w of targetWorkers) {
      const drainingStatus: WorkerStatus = {
        state: 'draining',
        reason: 'scale_down requested by leader',
        updated_at: new Date().toISOString(),
      };
      const statusPath = absPath(leaderCwd, TeamPaths.workerStatus(sanitized, w.name));
      await writeAtomic(statusPath, JSON.stringify(drainingStatus, null, 2));
    }

    // Phase 2: Wait for draining workers to finish or timeout
    if (!force) {
      const deadline = Date.now() + drainTimeoutMs;
      while (Date.now() < deadline) {
        const allDrained = await Promise.all(
          targetWorkers.map(async (w) => {
            const status = await teamReadWorkerStatus(sanitized, w.name, leaderCwd);
            const alive = w.pane_id ? await isWorkerAlive(w.pane_id) : false;
            return status.state === 'idle' || status.state === 'done' ||
                   status.state === 'draining' || !alive;
          }),
        );
        if (allDrained.every(Boolean)) break;
        await new Promise(r => setTimeout(r, 2_000));
      }
    }

    // Phase 3: Kill tmux panes and remove from config
    const targetPaneIds = targetWorkers
      .map((w) => w.pane_id)
      .filter((paneId): paneId is string => typeof paneId === 'string' && paneId.trim().length > 0);

    await killWorkerPanes({
      paneIds: targetPaneIds,
      leaderPaneId: config.leader_pane_id ?? undefined,
      teamName: sanitized,
      cwd: leaderCwd,
    });

    for (const w of targetWorkers) {
      removedNames.push(w.name);
    }

    // Phase 4: Update config
    const removedSet = new Set(removedNames);
    config.workers = config.workers.filter(w => !removedSet.has(w.name));
    config.worker_count = config.workers.length;
    await saveTeamConfig(config, leaderCwd);

    await teamAppendEvent(sanitized, {
      type: 'team_leader_nudge',
      worker: 'leader-fixed',
      reason: `scale_down: removed ${removedNames.length} worker(s) [${removedNames.join(', ')}], new count=${config.worker_count}`,
    }, leaderCwd);

    return {
      ok: true,
      removedWorkers: removedNames,
      newWorkerCount: config.worker_count,
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveWorkerReadyTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OMC_TEAM_READY_TIMEOUT_MS;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (Number.isFinite(parsed) && parsed >= 5_000) return parsed;
  return 45_000;
}
