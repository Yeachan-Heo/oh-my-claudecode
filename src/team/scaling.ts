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
import { tmuxExec, tmuxSpawn } from '../cli/tmux-utils.js';
import {
  buildWorkerArgv,
  getWorkerEnv as getModelWorkerEnv,
  resolveClaudeWorkerModel,
  type CliAgentType,
} from './model-contract.js';
import { CANONICAL_TEAM_ROLES } from '../shared/types.js';
import type { CanonicalTeamRole } from '../shared/types.js';
import { normalizeDelegationRole } from '../features/delegation-routing/types.js';
import { routeTaskToRole } from './role-router.js';
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
const CLI_AGENT_TYPES = new Set<CliAgentType>(['claude', 'codex', 'gemini']);

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

function asCliAgentType(agentType: string): CliAgentType {
  if (CLI_AGENT_TYPES.has(agentType as CliAgentType)) {
    return agentType as CliAgentType;
  }

  throw new Error(
    `Unknown agent type: ${agentType}. Supported: ${Array.from(CLI_AGENT_TYPES).join(', ')}`,
  );
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
  const cliAgentType = asCliAgentType(agentType);

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
    const addedWorkers: WorkerInfo[] = [];

    const rollbackScaleUp = async (error: string, paneId?: string): Promise<ScaleError> => {
      for (const w of addedWorkers) {
        const idx = config.workers.findIndex((worker) => worker.name === w.name);
        if (idx >= 0) {
          config.workers.splice(idx, 1);
        }
        try {
          if (w.pane_id) {
            tmuxExec(['kill-pane', '-t', w.pane_id], { stdio: 'pipe' });
          }
        } catch { /* best-effort pane cleanup */ }
      }

      if (paneId) {
        try {
          tmuxExec(['kill-pane', '-t', paneId], { stdio: 'pipe' });
        } catch { /* best-effort pane cleanup */ }
      }

      config.worker_count = config.workers.length;
      config.next_worker_index = nextIndex;
      await saveTeamConfig(config, leaderCwd);

      return { ok: false, error };
    };

    for (let i = 0; i < count; i++) {
      // Skip past any colliding worker names so stale next_worker_index
      // values self-heal instead of causing a permanent failure loop.
      const maxSkip = config.workers.length + count;
      let skipped = 0;
      while (config.workers.some((w) => w.name === `worker-${nextIndex}`) && skipped < maxSkip) {
        nextIndex++;
        skipped++;
      }
      const workerIndex = nextIndex;
      nextIndex++;
      const workerName = `worker-${workerIndex}`;
      if (config.workers.some((worker) => worker.name === workerName)) {
        // Persist the advanced index so the next call does not repeat.
        config.next_worker_index = nextIndex;
        await saveTeamConfig(config, leaderCwd);
        await teamAppendEvent(sanitized, {
          type: 'team_leader_nudge',
          worker: 'leader-fixed',
          reason: `scale_up_duplicate_worker_blocked:${workerName}`,
        }, leaderCwd);
        return {
          ok: false,
          error: `Worker ${workerName} already exists in team ${sanitized}; refusing to spawn duplicate worker identity.`,
        };
      }

      // Create worker directory
      const workerDirPath = absPath(leaderCwd, TeamPaths.workerDir(sanitized, workerName));
      await mkdir(workerDirPath, { recursive: true });

      // Resolve per-worker provider/model from the team's routing snapshot
      // (Option E stickiness — snapshot is immutable, never re-resolved).
      // Worker's inferred role comes from the owned-task `role` field when all
      // owned tasks agree on a single role; otherwise falls back to the
      // caller-supplied agentType default.
      const workerTasks = tasks.filter(t => t.owner === workerName);
      const ownedRoles = Array.from(new Set(workerTasks.map(t => t.role).filter(Boolean) as string[]));
      const inferredRole: string | undefined = ownedRoles.length === 1
        ? ownedRoles[0]
        : (workerTasks[0]
          ? routeTaskToRole(workerTasks[0].subject, workerTasks[0].description, 'executor').role
          : undefined);
      const canonicalRoleSet = new Set<string>(CANONICAL_TEAM_ROLES as readonly string[]);
      const canonical: CanonicalTeamRole | null = inferredRole
        ? (() => {
          const normalized = normalizeDelegationRole(inferredRole);
          return canonicalRoleSet.has(normalized) ? (normalized as CanonicalTeamRole) : null;
        })()
        : null;

      let workerAgentType: CliAgentType = cliAgentType;
      let workerModel: string | undefined;
      // Only override caller's agentType when the worker's inferred role came
      // from an explicit `task.role` (user opt-in). Pre-patch semantics: callers
      // passing `--agent-type codex` stay on codex regardless of task text.
      const hasExplicitOwnedRole = ownedRoles.length === 1;
      const routedPair = hasExplicitOwnedRole && canonical
        ? config.resolved_routing?.[canonical]
        : undefined;
      if (routedPair) {
        const { primary } = routedPair;
        const primaryProvider = primary.provider as CliAgentType;
        if (CLI_AGENT_TYPES.has(primaryProvider)) {
          workerAgentType = primaryProvider;
          workerModel = primary.model;
        }
      } else if (cliAgentType === 'claude') {
        // Honor Bedrock/Vertex default-model resolution for non-routed claude workers.
        workerModel = resolveClaudeWorkerModel(env);
      }

      // AC-8: try the resolved provider first; on trust-path / not-found
      // failure, emit a loud warning and retry with the snapshot's Claude
      // fallback tuple. Aborting the scale_up silently would mask a missing
      // CLI, so we only rollback if even the fallback cannot be built.
      const tryBuildLaunch = (
        agentType: CliAgentType,
        model: string | undefined,
      ): { launchBinary: string; launchArgs: string[] } => {
        const [launchBinary, ...launchArgs] = buildWorkerArgv(agentType, {
          teamName: sanitized,
          workerName,
          cwd: leaderCwd,
          ...(model ? { model } : {}),
        });
        return { launchBinary, launchArgs };
      };

      let launchBinary: string;
      let launchArgs: string[];
      try {
        ({ launchBinary, launchArgs } = tryBuildLaunch(workerAgentType, workerModel));
      } catch (primaryError) {
        const primaryReason = primaryError instanceof Error ? primaryError.message : String(primaryError);
        const fallbackPair = routedPair?.fallback;
        const fallbackProvider = fallbackPair
          ? (fallbackPair.provider as CliAgentType)
          : ('claude' as CliAgentType);
        const fallbackModel = fallbackPair?.model;

        process.stderr.write(
          `[team/scaling] cli_binary_missing:${workerAgentType}: ${primaryReason} — falling back to ${fallbackProvider} (AC-8)\n`,
        );
        await teamAppendEvent(sanitized, {
          type: 'team_leader_nudge',
          worker: 'leader-fixed',
          reason: `cli_binary_missing:${workerAgentType}:${primaryReason}:fallback=${fallbackProvider}`,
        }, leaderCwd);

        try {
          ({ launchBinary, launchArgs } = tryBuildLaunch(fallbackProvider, fallbackModel));
          workerAgentType = fallbackProvider;
          workerModel = fallbackModel;
        } catch (fallbackError) {
          const fallbackReason = fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError);
          return await rollbackScaleUp(
            `Failed to resolve worker launch config for ${workerName} (primary=${workerAgentType}: ${primaryReason}; fallback=${fallbackProvider}: ${fallbackReason})`,
          );
        }
      }

      // Rebuild env using the final agentType (fallback may have swapped it).
      const extraEnv: Record<string, string> = {
        ...getModelWorkerEnv(sanitized, workerName, workerAgentType, env),
        OMC_TEAM_STATE_ROOT: teamStateRoot,
        OMC_TEAM_LEADER_CWD: leaderCwd,
      };

      let cmd: string;
      try {
        cmd = buildWorkerStartCommand({
          teamName: sanitized,
          workerName,
          envVars: extraEnv,
          launchArgs,
          launchBinary,
          cwd: leaderCwd,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return await rollbackScaleUp(
          `Failed to build worker start command for ${workerName}: ${reason}`,
        );
      }


      // Split from the rightmost worker pane or the leader pane
      const splitTarget = config.workers.length > 0
        ? (config.workers[config.workers.length - 1]?.pane_id ?? config.leader_pane_id ?? '')
        : (config.leader_pane_id ?? '');
      const splitDirection = splitTarget === (config.leader_pane_id ?? '') ? '-h' : '-v';

      const result = tmuxSpawn([
        'split-window', splitDirection, '-t', splitTarget, '-d', '-P', '-F', '#{pane_id}', '-c', leaderCwd, cmd,
      ]);

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
        const pidResult = tmuxSpawn(['display-message', '-t', paneId, '-p', '#{pane_pid}']);
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
            return status.state === 'idle' || status.state === 'done' || !alive;
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
