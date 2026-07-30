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

import { join, resolve } from 'path';
import { mkdir, readFile, rm } from 'fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmuxSpawn } from '../cli/tmux-utils.js';
import {
  buildWorkerArgv,
  clearResolvedPathCache,
  getWorkerEnv as getModelWorkerEnv,
  resolveClaudeWorkerModel,
  assertHeadlessSupported,
  resolveValidatedBinaryPath,
  validateWorkerLaunchDescriptor,
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
import type { TeamConfig, TeamScaleDownAttempt, TeamScaleUpAttempt } from './types.js';
import { withScalingLock, migrateTeamConfigRevision, readRevisionedTeamConfig, saveTeamConfigAtRevision } from './monitor.js';
import {
  adoptWorkerPaneOwnership,
  sanitizeName,
  getWorkerLiveness,
  killOwnedWorkerPane,
  spawnOwnedWorkerInPane,
  waitForPaneReady,
  type StartupPaneContext,
  type WorkerPaneOwnership,
} from './tmux-session.js';
import { TeamPaths, absPath } from './state-paths.js';
import { writeWorkerOverlay } from './worker-bootstrap.js';
import {
  ensureWorkerWorktree,
  installWorktreeRootAgents,
  prepareWorkerWorktreeForRemoval,
  removeWorkerWorktree,
  restoreWorktreeRootAgents,
  type TeamWorktreeMode,
} from './git-worktree.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { withProcessIdentityFileLock } from './process-identity-lock.js';
import { currentProcessStartIdentity, isProcessIdentityDead } from './team-owner-epoch.js';
import { resolveRuntimeCliPath } from './runtime-owner-client.js';
import { loadWorkerLaunchAttempt, retireAndCleanupCurrentWorkerLaunchAttempt } from './worker-launch-ack.js';

// ── Environment gate ──────────────────────────────────────────────────────────

const OMC_TEAM_SCALING_ENABLED_ENV = 'OMC_TEAM_SCALING_ENABLED';
const CLI_AGENT_TYPES = new Set<CliAgentType>(['claude', 'codex', 'gemini', 'grok', 'cursor', 'antigravity']);

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

function configuredTmuxTarget(tmuxSession: unknown): { expectedTarget: string; format: string } {
  const expectedTarget = typeof tmuxSession === 'string' ? tmuxSession.trim() : '';
  return {
    expectedTarget,
    format: expectedTarget.includes(':') ? '#{session_name}:#{window_index}' : '#{session_name}',
  };
}

function validateSplitTargetPaneInConfiguredSession(splitTarget: string, tmuxSession: unknown): string | null {
  const { expectedTarget, format } = configuredTmuxTarget(tmuxSession);
  if (!splitTarget.trim()) {
    return 'Refusing to split tmux pane: missing leader/worker pane target.';
  }
  if (!expectedTarget) {
    return `Refusing to split tmux pane ${splitTarget}: missing configured tmux_session.`;
  }

  const result = tmuxSpawn(['display-message', '-t', splitTarget, '-p', format]);
  if (result.status !== 0) {
    const reason = (result.stderr || '').trim()
      || (result.error instanceof Error ? result.error.message : undefined)
      || `tmux display-message exited with status ${result.status}`;
    return `Refusing to split tmux pane ${splitTarget}: unable to validate pane belongs to configured tmux_session ${expectedTarget} (${reason}).`;
  }

  const actualTarget = (result.stdout || '').trim().split('\n')[0]?.trim() ?? '';
  if (actualTarget !== expectedTarget) {
    return `Refusing to split tmux pane ${splitTarget}: pane belongs to tmux target ${actualTarget || '<unknown>'}, expected ${expectedTarget}.`;
  }

  return null;
}

// ── Result types ──────────────────────────────────────────────────────────────

export interface ScaleUpResult {
  ok: true;
  addedWorkers: WorkerInfo[];
  newWorkerCount: number;
  nextWorkerIndex: number;
  servicesSync: 'synced' | 'repair_required';
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

function scaleUpAttempt(config: TeamConfig): TeamScaleUpAttempt | undefined {
  return config.active_scale_up;
}

/**
 * Returns true if the active_scale_up fence blocks team mutations.
 * A 'committed' fence proves workers were durably persisted and the
 * release write failed; it may be safely reclaimed (cleared) by a
 * later operation with exact operation identity verification.
 * Historical 'effects' without commit proof always blocks — it
 * represents ambiguous partial state that requires explicit repair.
 */
export function scaleUpFenceBlocks(config: TeamConfig): boolean {
  const attempt = config.active_scale_up;
  if (!attempt) return false;
  if (attempt.phase === 'committed') return false;
  return true;
}

// ── Scale Up ──────────────────────────────────────────────────────────────────

/**
 * Add workers to a running team mid-session.
 *
 * Acquires the file-based scaling lock, reads the current config,
 * validates capacity, creates new tmux panes, and bootstraps workers.
 */
export async function scaleUpOwned(
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
    const revisioned = await migrateTeamConfigRevision(sanitized, leaderCwd);
    if (!revisioned) {
      return { ok: false, error: `Team ${sanitized} not found` };
    }
    let config = revisioned.config;
    let configRevision = revisioned.stateRevision;
    if (config.active_recovery || config.active_scale_down) return { ok: false, error: 'team_mutation_busy' };
    if (config.lifecycle_state === 'shutting_down' || config.lifecycle_state === 'stopped') {
      return { ok: false, error: 'team_mutation_busy' };
    }

    const maxWorkers = config.max_workers ?? 20;
    const currentCount = config.workers.length;
    if (currentCount + count > maxWorkers) {
      return {
        ok: false,
        error: `Cannot add ${count} workers: would exceed max_workers (${currentCount} + ${count} > ${maxWorkers})`,
      };
    }

    const operationId = randomUUID();
    const workspaceHash = createHash('sha256').update(leaderCwd).digest('hex');
    const lifecycleLock = absPath(leaderCwd, TeamPaths.recoveryLifecycleLock(workspaceHash, sanitized));
    const processStartedAt = currentProcessStartIdentity();
    if (!processStartedAt) return { ok: false, error: 'process_start_identity_unavailable' };
    const withScaleUpFenceRevision = (next: TeamConfig, stateRevision: number): TeamConfig => {
      const reservation = scaleUpAttempt(next);
      return {
        ...next,
        state_revision: stateRevision,
        ...(reservation ? { active_scale_up: { ...reservation, state_revision: stateRevision } } : {}),
      };
    };
    const saveScaleUpConfig = async (next: TeamConfig, expectedRevision: number): Promise<boolean> => {
      try {
        return await saveTeamConfigAtRevision(next, expectedRevision, leaderCwd);
      } catch {
        return false;
      }
    };
    try {
      config = await withProcessIdentityFileLock(lifecycleLock, async () => {
        const current = await migrateTeamConfigRevision(sanitized, leaderCwd);
        if (!current || current.config.active_recovery || current.config.active_scale_down
          || current.config.lifecycle_state === 'shutting_down' || current.config.lifecycle_state === 'stopped') {
          throw new Error('team_mutation_busy');
        }
        const existing = scaleUpAttempt(current.config);
        // Only a positively dead reservation can be safely replaced: no worker,
        // pane, worktree, or identity effects have begun in this phase. Effects
        // and failed attempts require explicit repair because their resources
        // cannot be attributed safely from the durable fence alone.
        if (existing && existing.phase !== 'committed'
          && (existing.phase !== 'reserved' || !isProcessIdentityDead(existing))) {
          throw new Error('team_mutation_busy');
        }
        const nextRevision = current.stateRevision + 1;
        const next: TeamConfig = { ...current.config, state_revision: nextRevision, active_scale_up: {
          operation_id: operationId, phase: 'reserved' as const, pid: process.pid,
          process_started_at: processStartedAt, state_revision: nextRevision,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        } };
        if (!await saveScaleUpConfig(next, current.stateRevision)) throw new Error('team_mutation_busy');
        configRevision = nextRevision;
        return next;
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'team_mutation_busy' };
    }
    const releaseScaleUpReservation = async (failureReason?: string): Promise<boolean> =>
      withProcessIdentityFileLock(lifecycleLock, async () => {
        const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
        const reservation = current ? scaleUpAttempt(current.config) : undefined;
        if (!current || !reservation || reservation.operation_id !== operationId
          || reservation.pid !== process.pid || reservation.process_started_at !== processStartedAt) return false;
        const nextRevision = current.stateRevision + 1;
        const next: TeamConfig = { ...current.config, state_revision: nextRevision,
          ...(failureReason ? { active_scale_up: { ...reservation, phase: 'failed' as const, failure_reason: failureReason,
            state_revision: nextRevision, updated_at: new Date().toISOString() } } : { active_scale_up: undefined }) };
        if (!await saveScaleUpConfig(next, current.stateRevision)) return false;
        config = next;
        configRevision = nextRevision;
        return !failureReason;
      });
    const reserveScaleUpEffects = async (): Promise<boolean> =>
      withProcessIdentityFileLock(lifecycleLock, async () => {
        const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
        const reservation = current ? scaleUpAttempt(current.config) : undefined;
        if (!current || !reservation || reservation.operation_id !== operationId
          || reservation.pid !== process.pid || reservation.process_started_at !== processStartedAt
          || current.config.active_recovery || current.config.active_scale_down
          || current.config.lifecycle_state === 'shutting_down' || current.config.lifecycle_state === 'stopped') return false;
        const nextRevision = current.stateRevision + 1;
        const next: TeamConfig = { ...current.config, state_revision: nextRevision, active_scale_up: {
          ...reservation, phase: 'effects' as const, state_revision: nextRevision, updated_at: new Date().toISOString(),
        } };
        if (!await saveScaleUpConfig(next, current.stateRevision)) return false;
        config = next;
        configRevision = nextRevision;
        return true;
      });
    if (!await reserveScaleUpEffects()) {
      const released = await releaseScaleUpReservation().catch(() => false);
      return { ok: false, error: released ? 'team_mutation_busy' : 'scale_up_fence_release_failed' };
    }

    const teamStateRoot = config.team_state_root ?? `${leaderCwd}/.omc/state/team/${sanitized}`;
    const worktreeMode: TeamWorktreeMode = config.worktree_mode ?? 'disabled';

    // Resolve the monotonic worker index counter
    let nextIndex = config.next_worker_index ?? (currentCount + 1);
    const addedWorkers: WorkerInfo[] = [];
    const pendingWorktrees: Array<{ workerName: string; created: boolean; path: string }> = [];
    const pendingIdentities = new Set<string>();
    const reservedWorkerNames = new Set<string>();
    const reservedLaunchDescriptors = new Map<string, WorkerInfo['launch_descriptor']>();
    const launchContexts = new Map<string, StartupPaneContext>();
    const paneOwnerships = new Map<string, WorkerPaneOwnership>();

    const cleanupScaledWorkerWorktree = (workerName: string, created: boolean): void => {
      if (created) {
        removeWorkerWorktree(sanitized, workerName, leaderCwd);
      } else {
        const restored = restoreWorktreeRootAgents(sanitized, workerName, leaderCwd);
        if (restored.reason === 'agents_dirty') {
          throw new Error(`agents_dirty: preserving modified worktree root AGENTS.md for ${workerName}`);
        }
      }
    };

    const rollbackScaleUp = async (error: string, paneId?: string, orphanFailure?: string): Promise<ScaleError> => {
      const cleanupFailures: string[] = orphanFailure ? [orphanFailure] : [];
      const cleanedWorktrees = new Set<string>();
      const cleanupPane = async (candidate: string, label: string): Promise<void> => {
        const launch = launchContexts.get(candidate);
        const ownership = paneOwnerships.get(candidate);
        const paneAlreadyDead = await getWorkerLiveness(candidate).catch(() => 'unknown' as const) === 'dead';
        if (!ownership && !paneAlreadyDead) {
          cleanupFailures.push(`${label}:pane_ownership_unverified:${candidate}`);
          return;
        }
        const killPane = async (): Promise<boolean> => {
          if (await getWorkerLiveness(candidate).catch(() => 'unknown' as const) === 'dead') return true;
          if (!ownership) return false;
          for (let attempt = 0; attempt < 2; attempt++) {
            await killOwnedWorkerPane(ownership).catch(() => undefined);
            if (await getWorkerLiveness(candidate).catch(() => 'unknown' as const) === 'dead') return true;
          }
          return false;
        };
        const cleaned = launch
          ? await retireAndCleanupCurrentWorkerLaunchAttempt(launch.attempt, 'scale_up_rollback', killPane).catch(() => false)
          : await killPane();
        if (cleaned) return;
        cleanupFailures.push(`${label}:${launch ? 'provider' : 'pane'}:${candidate}`);
      };
      const cleanupIdentity = async (workerName: string): Promise<void> => {
        const workerDir = absPath(leaderCwd, TeamPaths.workerDir(sanitized, workerName));
        for (let attempt = 0; attempt < 2 && existsSync(workerDir); attempt++) {
          await rm(workerDir, { recursive: true, force: true }).catch(() => undefined);
        }
        if (existsSync(workerDir)) cleanupFailures.push(`${workerName}:identity:${workerDir}`);
      };
      for (const worker of addedWorkers) {
        const idx = config.workers.findIndex(candidate => candidate.name === worker.name);
        if (idx >= 0) config.workers.splice(idx, 1);
        if (worker.pane_id) await cleanupPane(worker.pane_id, worker.name);
        if (worker.worktree_path) {
          let cleaned = false;
          for (let attempt = 0; attempt < 2 && !cleaned; attempt++) {
            try { cleanupScaledWorkerWorktree(worker.name, worker.worktree_created === true); cleaned = true; } catch { /* retry */ }
          }
          if (cleaned) cleanedWorktrees.add(worker.name);
          if (!cleaned || existsSync(worker.worktree_path)) cleanupFailures.push(`${worker.name}:worktree:${worker.worktree_path}`);
        }
        await cleanupIdentity(worker.name);
      }
      for (const pending of pendingWorktrees) {
        if (!cleanedWorktrees.has(pending.workerName)) {
          let cleaned = false;
          for (let attempt = 0; attempt < 2 && !cleaned; attempt++) {
            try { cleanupScaledWorkerWorktree(pending.workerName, pending.created); cleaned = true; } catch { /* retry */ }
          }
          if (!cleaned || existsSync(pending.path)) cleanupFailures.push(`${pending.workerName}:pending-worktree:${pending.path}`);
        }
        await cleanupIdentity(pending.workerName);
      }
      for (const workerName of pendingIdentities) await cleanupIdentity(workerName);
      if (paneId) await cleanupPane(paneId, 'pending');

      config.worker_count = config.workers.length;
      config.next_worker_index = nextIndex;
      if (reservedWorkerNames.size > 0) {
        const persisted = await readRevisionedTeamConfig(sanitized, leaderCwd).catch(() => null);
        const reservedRows = persisted?.config.workers.filter(worker => reservedWorkerNames.has(worker.name)) ?? [];
        if (persisted && (persisted.config.lifecycle_state ?? 'active') === 'active') {
          const addedByName = new Map(addedWorkers.map(worker => [worker.name, worker]));
          const safeToRetire = new Set<string>();
          for (const row of reservedRows) {
            const expectedLaunch = reservedLaunchDescriptors.get(row.name);
            const launchMatches = JSON.stringify(row.launch_descriptor) === JSON.stringify(expectedLaunch);
            const activated = addedByName.get(row.name);
            if (launchMatches && (row.operational_state === 'starting'
              || (row.operational_state === 'active' && activated?.pane_id === row.pane_id))) {
              safeToRetire.add(row.name);
            } else {
              cleanupFailures.push(`scale_up_reservation_fence_lost:${row.name}`);
            }
          }
          if (safeToRetire.size > 0) {
            const retired = withScaleUpFenceRevision({ ...persisted.config,
              workers: persisted.config.workers.filter(worker => !safeToRetire.has(worker.name)),
            }, persisted.stateRevision + 1);
            retired.worker_count = retired.workers.length;
            if (!await saveScaleUpConfig(retired, persisted.stateRevision)) {
              cleanupFailures.push('scale_up_reservation_retire_failed');
            } else {
              config = retired;
              configRevision = retired.state_revision ?? configRevision;
              for (const workerName of safeToRetire) reservedWorkerNames.delete(workerName);
            }
          }
        } else if (reservedRows.length > 0) {
          cleanupFailures.push('scale_up_reservation_fence_lost');
        } else {
          reservedWorkerNames.clear();
        }
      }
      if (cleanupFailures.length > 0) {
        await releaseScaleUpReservation(error).catch(() => false);
        const evidencePath = absPath(leaderCwd, TeamPaths.scalingRollbackFailure(sanitized, Date.now()));
        await writeAtomic(evidencePath, JSON.stringify({ schema_version: 1, team_name: sanitized,
          error, cleanup_failures: cleanupFailures, recorded_at: new Date().toISOString() }, null, 2));
        return { ok: false, error: `${error}; rollback incomplete (${cleanupFailures.join(', ')}) evidence=${evidencePath}` };
      }
      if (!await releaseScaleUpReservation()) return { ok: false, error: `${error}; scale_up_fence_release_failed` };
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
        // Persist the advanced index only if the authoritative revision still exists.
        const advancedConfig = withScaleUpFenceRevision({ ...config, next_worker_index: nextIndex }, configRevision + 1);
        if (!await saveScaleUpConfig(advancedConfig, configRevision)) {
          return { ok: false, error: 'team_mutation_busy' };
        }
        config = advancedConfig;
        configRevision += 1;
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

      // Validate the tmux split target before creating worker directories,
      // worktrees, or overlays so a stale/malformed pane id cannot cause side
      // effects in the wrong live tmux session.
      const splitTarget = config.workers.length > 0
        ? (config.workers[config.workers.length - 1]?.pane_id ?? config.leader_pane_id ?? '')
        : (config.leader_pane_id ?? '');
      const splitDirection = splitTarget === (config.leader_pane_id ?? '') ? '-h' : '-v';
      const splitTargetError = validateSplitTargetPaneInConfiguredSession(splitTarget, config.tmux_session);
      if (splitTargetError) {
        return await rollbackScaleUp(splitTargetError);
      }

      try {

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

      let launchBinary: string;
      try {
        assertHeadlessSupported(workerAgentType);
        clearResolvedPathCache();
        launchBinary = resolveValidatedBinaryPath(workerAgentType);
      } catch (error) {
        return await rollbackScaleUp(
          `Failed strict provider preflight for ${workerName} (${workerAgentType}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      pendingIdentities.add(workerName);
      const workerDirPath = absPath(leaderCwd, TeamPaths.workerDir(sanitized, workerName));
      await mkdir(workerDirPath, { recursive: true });
      let worktree: ReturnType<typeof ensureWorkerWorktree> = null;
      if (worktreeMode !== 'disabled') {
        const pending = { workerName, created: true,
          path: join(getOmcRoot(leaderCwd), 'team', sanitized, 'worktrees', workerName) };
        pendingWorktrees.push(pending);
        worktree = ensureWorkerWorktree(sanitized, workerName, leaderCwd, {
          mode: worktreeMode,
          requireCleanLeader: true,
        });
        if (worktree) {
          pending.created = worktree.created;
          pending.path = worktree.path;
        }
      }
      const workerCwd = worktree?.path ?? leaderCwd;
      let launchArgs: string[];
      try {
        const [, ...args] = buildWorkerArgv(workerAgentType, {
          teamName: sanitized,
          workerName,
          cwd: workerCwd,
          resolvedBinaryPath: launchBinary,
          ...(workerModel ? { model: workerModel } : {}),
        });
        launchArgs = args;
      } catch (error) {
        return await rollbackScaleUp(
          `Failed strict provider argv construction for ${workerName} (${workerAgentType}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      let launchDescriptor;
      try {
        launchDescriptor = validateWorkerLaunchDescriptor({ schema_version: 1, provider: workerAgentType,
          model: workerModel ?? null, binary: launchBinary, args: [...launchArgs] });
      } catch (error) {
        return await rollbackScaleUp(`Invalid worker launch descriptor for ${workerName}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const workerTaskRoles = tasks.filter(t => t.owner === workerName).map(t => t.role).filter(Boolean) as string[];
      const uniqueTaskRoles = new Set(workerTaskRoles);
      const workerRole = workerTaskRoles.length > 0 && uniqueTaskRoles.size === 1 ? workerTaskRoles[0]! : agentType;
      const reservedWorker: WorkerInfo = {
        name: workerName, index: workerIndex, role: workerRole, assigned_tasks: [],
        worker_cli: launchDescriptor.provider, launch_descriptor: launchDescriptor, operational_state: 'starting',
        working_dir: workerCwd, team_state_root: teamStateRoot,
        ...(worktree ? { worktree_repo_root: leaderCwd, worktree_path: worktree.path, worktree_branch: worktree.branch,
          worktree_detached: worktree.detached, worktree_created: worktree.created } : {}),
      };
      const reservationConfig = withScaleUpFenceRevision({ ...config, workers: [...config.workers, reservedWorker],
        worker_count: config.workers.length + 1, next_worker_index: nextIndex }, configRevision + 1);
      if (!await saveScaleUpConfig(reservationConfig, configRevision)) {
        return await rollbackScaleUp('Scale-up reservation lost its revision: stale_state_revision');
      }
      config = reservationConfig;
      configRevision += 1;
      reservedWorkerNames.add(workerName);
      reservedLaunchDescriptors.set(workerName, launchDescriptor);

      // Rebuild env using the final agentType (fallback may have swapped it).
      const extraEnv: Record<string, string> = {
        ...getModelWorkerEnv(sanitized, workerName, workerAgentType, env),
        OMC_TEAM_STATE_ROOT: teamStateRoot,
        OMC_TEAM_LEADER_CWD: leaderCwd,
        ...(worktree ? { OMC_TEAM_WORKTREE_PATH: worktree.path, OMC_TEAM_WORKER_CWD: workerCwd } : {}),
      };

      if (worktree) {
        try {
          const workerOverlayParams = {
            teamName: sanitized,
            workerName,
            agentType: workerAgentType,
            tasks: tasks.map((t, idx) => ({
              id: String(idx + 1),
              subject: t.subject,
              description: t.description,
            })),
            cwd: leaderCwd,
            instructionStateRoot: '$OMC_TEAM_STATE_ROOT',
          };
          const overlayPath = await writeWorkerOverlay(workerOverlayParams);
          const overlayContent = await readFile(overlayPath, 'utf-8');
          installWorktreeRootAgents(sanitized, workerName, leaderCwd, worktree.path, overlayContent);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return await rollbackScaleUp(`Failed to install worker overlay for ${workerName}: ${reason}`);
        }
      }

      // Allocate an empty pane first so the exact pane identity can be bound to
      // the durable launch attempt before any provider command executes.
      const result = tmuxSpawn([
        'split-window', splitDirection, '-t', splitTarget, '-d', '-P', '-F', '#{pane_id}', '-c', workerCwd,
      ]);
      if (result.status !== 0) {
        return await rollbackScaleUp(`Failed to create tmux pane for ${workerName}: ${(result.stderr || '').trim()}`);
      }

      const paneId = (result.stdout || '').trim().split('\n')[0]?.trim();
      if (!paneId || !paneId.startsWith('%')) {
        return await rollbackScaleUp(`Failed to capture pane ID for ${workerName}`, undefined,
          `unaddressable_spawned_pane:${(result.stdout || '').trim() || '<missing>'}`);
      }
      const ownershipResult = await adoptWorkerPaneOwnership({
        provider: paneId.startsWith('%') ? 'tmux' as const : 'cmux' as const,
        providerTarget: config.tmux_session,
        paneId,
        leaderPaneId: config.leader_pane_id ?? '',
        reservedPaneIds: config.workers.map(worker => worker.pane_id).filter((id): id is string => Boolean(id)),
      });
      if (!ownershipResult.ok) {
        return await rollbackScaleUp(`Failed to prove pane ownership for ${workerName}: ${ownershipResult.reason}`,
          undefined, `unaddressable_spawned_pane:${paneId}`);
      }
      paneOwnerships.set(paneId, ownershipResult.ownership);
      let startupContext: StartupPaneContext;
      try {
        startupContext = await spawnOwnedWorkerInPane(config.tmux_session, ownershipResult.ownership, {
          teamName: sanitized,
          workerName,
          envVars: extraEnv,
          launchArgs: [...launchDescriptor.args],
          launchBinary: launchDescriptor.binary,
          cwd: workerCwd,
          provider: workerAgentType,
          launchBootstrapPath: resolveRuntimeCliPath(),
          launchStateCwd: leaderCwd,
          launchContext: { kind: 'initial' },
        });
      } catch (error) {
        return await rollbackScaleUp(`Failed durable worker launch for ${workerName}: ${error instanceof Error ? error.message : String(error)}`, paneId);
      }
      launchContexts.set(paneId, startupContext);
      // Get PID
      let panePid: number | undefined;
      try {
        const pidResult = tmuxSpawn(['display-message', '-t', paneId, '-p', '#{pane_pid}']);
        const pidStr = (pidResult.stdout || '').trim();
        const parsed = Number.parseInt(pidStr, 10);
        if (Number.isFinite(parsed)) panePid = parsed;
      } catch { /* best-effort pid lookup */ }

      // The starting reservation already persisted role and immutable launch identity.
      const workerInfo: WorkerInfo = {
        name: workerName,
        index: workerIndex,
        role: workerRole,
        assigned_tasks: [],
        worker_cli: launchDescriptor.provider,
        launch_descriptor: launchDescriptor,
        operational_state: 'active',
        pid: panePid,
        pane_id: paneId,
        launch_attempt_id: startupContext.attempt.attempt_id,
        working_dir: workerCwd,
        team_state_root: teamStateRoot,
        ...(worktree ? {
          worktree_repo_root: leaderCwd,
          worktree_path: worktree.path,
          worktree_branch: worktree.branch,
          worktree_detached: worktree.detached,
          worktree_created: worktree.created,
        } : {}),
      };

        addedWorkers.push(workerInfo);
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

      const pendingIndex = pendingWorktrees.findIndex(pending => pending.workerName === workerName);
      if (pendingIndex >= 0) pendingWorktrees.splice(pendingIndex, 1);
      const reservedIndex = config.workers.findIndex(candidate => candidate.name === workerName);
      if (reservedIndex < 0) throw new Error(`scale_up_reservation_missing:${workerName}`);
      config = { ...config, workers: config.workers.map((candidate, index) => index === reservedIndex ? workerInfo : candidate),
        worker_count: config.workers.length, next_worker_index: nextIndex };
      pendingIdentities.delete(workerName);
      } catch (error) {
        return await rollbackScaleUp(`Scale-up post-effect failed for ${workerName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Atomically commit workers AND transition the fence to 'committed'.
    // If the config write succeeds, the workers are durable and the fence
    // phase proves it. If the subsequent release fails, the 'committed'
    // phase is reconcilable — a later operation can safely clear it.
    const committedConfig = {
      ...withScaleUpFenceRevision(config, configRevision + 1),
      active_scale_up: { ...scaleUpAttempt(config)!, phase: 'committed' as const,
        state_revision: configRevision + 1, updated_at: new Date().toISOString() },
    };
    try {
      if (!await saveScaleUpConfig(committedConfig, configRevision)) {
        return await rollbackScaleUp('Scale-up config commit lost its revision: stale_state_revision');
      }
      config = committedConfig;
      configRevision += 1;
    } catch (error) {
      return await rollbackScaleUp(`Scale-up config commit lost its revision: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Workers are durably committed. Best-effort release; if it fails,
    // the 'committed' fence is reconcilable and does not block later ops.
    if (!await releaseScaleUpReservation()) {
      await releaseScaleUpReservation().catch(() => false);
    }

    await teamAppendEvent(sanitized, {
      type: 'team_leader_nudge',
      worker: 'leader-fixed',
      reason: `scale_up: added ${count} worker(s), new count=${config.worker_count}`,
    }, leaderCwd);

    let servicesSync: 'synced' | 'repair_required' = 'synced';
    try {
      const { reconcileCommittedTeamServices } = await import('./runtime-v2.js');
      servicesSync = await reconcileCommittedTeamServices(config, leaderCwd);
    } catch {
      servicesSync = 'repair_required';
    }
    return {
      ok: true,
      addedWorkers,
      newWorkerCount: config.worker_count,
      nextWorkerIndex: nextIndex,
      servicesSync,
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
export async function scaleDownOwned(
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
    const loadedConfig = await teamReadConfig(sanitized, leaderCwd);
    if (!loadedConfig) {
      return { ok: false, error: `Team ${sanitized} not found` };
    }
    if (loadedConfig.active_recovery || scaleUpFenceBlocks(loadedConfig)) return { ok: false, error: 'team_mutation_busy' };
    let config = loadedConfig;

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
    const operationId = randomUUID();
    const workspaceHash = createHash('sha256').update(leaderCwd).digest('hex');
    const lifecycleLock = absPath(leaderCwd, TeamPaths.recoveryLifecycleLock(workspaceHash, sanitized));
    const selectedNames = targetWorkers.map(worker => worker.name);
    const workerIdentity = (worker: WorkerInfo): TeamScaleDownAttempt['workers'][number] => ({
      name: worker.name,
      ...(worker.pane_id ? { pane_id: worker.pane_id } : {}),
      ...(worker.worktree_path ? { worktree_path: worker.worktree_path } : {}),
      ...(worker.worktree_created !== undefined ? { worktree_created: worker.worktree_created } : {}),
    });
    const identitiesMatch = (workers: WorkerInfo[], expected: TeamScaleDownAttempt['workers']): boolean =>
      JSON.stringify(workers.map(workerIdentity)) === JSON.stringify(expected);
    try {
      config = await withProcessIdentityFileLock(lifecycleLock, async () => {
        const current = await migrateTeamConfigRevision(sanitized, leaderCwd);
        if (!current || current.config.active_recovery || scaleUpFenceBlocks(current.config)
          || current.config.lifecycle_state === 'shutting_down' || current.config.lifecycle_state === 'stopped') {
          throw new Error('team_mutation_busy');
        }
        const existingScaleDown = current.config.active_scale_down;
        // Reclaim policy for scale-down fences:
        // - draining + dead owner: safe (no effects started, or owner crashed before effects)
        // - failed + dead owner OR same live owner: cleanup is resumable via a new draining reservation
        // - effects (any owner): fail-closed — partial provider/pane cleanup is ambiguous
        if (existingScaleDown) {
          const ownerDead = isProcessIdentityDead(existingScaleDown);
          const processStartedAt = currentProcessStartIdentity();
          const sameOwner = Boolean(processStartedAt)
            && existingScaleDown.pid === process.pid
            && existingScaleDown.process_started_at === processStartedAt;
          const reclaimable = (existingScaleDown.phase === 'draining' && ownerDead)
            || (existingScaleDown.phase === 'failed' && (ownerDead || sameOwner));
          if (!reclaimable) throw new Error('team_mutation_busy');
        }
        const selected = selectedNames.map(name => current.config.workers.find(worker => worker.name === name));
        if (selected.some((worker): worker is undefined => !worker)
          || !identitiesMatch(selected as WorkerInfo[], targetWorkers.map(workerIdentity))) throw new Error('team_mutation_busy');
        const now = new Date().toISOString();
        const processStartedAt = currentProcessStartIdentity();
        if (!processStartedAt) throw new Error('process_start_identity_unavailable');
        const nextRevision = current.stateRevision + 1;
        const next = { ...current.config, state_revision: nextRevision,
          // Reconcile a committed scale-up fence: workers are provably
          // durable, so clearing the fence is safe and idempotent.
          ...(current.config.active_scale_up?.phase === 'committed' ? { active_scale_up: undefined } : {}),
          active_scale_down: {
          operation_id: operationId, phase: 'draining' as const, pid: process.pid,
          process_started_at: processStartedAt, workers: (selected as WorkerInfo[]).map(workerIdentity),
          state_revision: nextRevision, created_at: now, updated_at: now,
        } };
        if (!await saveTeamConfigAtRevision(next, current.stateRevision, leaderCwd)) throw new Error('team_mutation_busy');
        return next;
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'team_mutation_busy' };
    }
    targetWorkers = selectedNames.map(name => config.workers.find(worker => worker.name === name)!).filter(Boolean);

    const markScaleDownFailed = async (reason: string): Promise<void> => {
      let configMarkError: string | undefined;
      try {
        await withProcessIdentityFileLock(lifecycleLock, async () => {
          const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
          if (!current || current.config.active_scale_down?.operation_id !== operationId) return;
          const nextRevision = current.stateRevision + 1;
          if (!await saveTeamConfigAtRevision({ ...current.config, state_revision: nextRevision, active_scale_down: {
            ...current.config.active_scale_down, phase: 'failed', failure_reason: reason,
            state_revision: nextRevision, updated_at: new Date().toISOString(),
          } }, current.stateRevision, leaderCwd)) configMarkError = 'config_mark_cas_failed';
        });
      } catch (error) {
        configMarkError = error instanceof Error ? error.message : String(error);
      }
      const evidencePath = absPath(leaderCwd, TeamPaths.scalingRollbackFailure(sanitized, Date.now()));
      await writeAtomic(evidencePath, JSON.stringify({ schema_version: 1, operation: 'scale_down',
        operation_id: operationId, team_name: sanitized, workers: selectedNames, reason,
        ...(configMarkError ? { config_mark_error: configMarkError } : {}),
        recorded_at: new Date().toISOString() }, null, 2));
    };

    const reserveEffects = async (): Promise<boolean> => withProcessIdentityFileLock(lifecycleLock, async () => {
      const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
      const reservation = current?.config.active_scale_down;
      if (!current || reservation?.operation_id !== operationId || current.config.active_recovery || scaleUpFenceBlocks(current.config)
        || !identitiesMatch(selectedNames.map(name => current.config.workers.find(worker => worker.name === name)!).filter(Boolean), reservation.workers)) return false;
      const nextRevision = current.stateRevision + 1;
      const next = { ...current.config, state_revision: nextRevision, active_scale_down: {
        ...reservation, phase: 'effects' as const, state_revision: nextRevision, updated_at: new Date().toISOString(),
      } };
      if (!await saveTeamConfigAtRevision(next, current.stateRevision, leaderCwd)) return false;
      config = next;
      targetWorkers = selectedNames.map(name => next.workers.find(worker => worker.name === name)!).filter(Boolean);
      return true;
    });
    const unaddressableWorkers = targetWorkers
      .filter(worker => typeof worker.pane_id !== 'string' || worker.pane_id.trim().length === 0)
      .map(worker => worker.name);
    if (unaddressableWorkers.length > 0) {
      const reason = `scale_down_worker_liveness_unknown:missing_pane_id:${unaddressableWorkers.join(',')}`;
      await markScaleDownFailed(reason);
      return { ok: false, error: reason };
    }

    const removedNames: string[] = [];

    // Phase 1: Set workers to 'draining' status. Worktree safety is checked
    // after the drain/kill boundary so active workers can finish and clean up
    // ordinary in-progress work before removal is attempted.
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
            const liveness = w.pane_id ? await getWorkerLiveness(w.pane_id) : 'unknown';
            return status.state === 'idle' || status.state === 'done' || liveness === 'dead';
          }),
        );
        if (allDrained.every(Boolean)) break;
        await new Promise(r => setTimeout(r, 2_000));
      }
    }
    if (!await reserveEffects()) {
      await markScaleDownFailed('scale_down_fence_lost_before_effects');
      return { ok: false, error: 'team_mutation_busy' };
    }

    // Phase 3: Retire and terminate each exact provider before destructive pane cleanup.
    for (const worker of targetWorkers) {
      const paneId = worker.pane_id!;
      const provider = worker.launch_descriptor?.provider ?? worker.worker_cli;
      if (!provider || !worker.launch_attempt_id) {
        // Legacy workers may have pane_id but no launch_attempt_id.
        // Attempt ownership-safe pane cleanup without provider termination.
        if (!provider) {
          const reason = `provider_cleanup_unverified:missing_provider:${worker.name}`;
          await markScaleDownFailed(reason);
          return { ok: false, error: reason };
        }
        const legacyLiveness = await getWorkerLiveness(paneId);
        if (legacyLiveness === 'dead') continue;
        const legacyOwnership = await adoptWorkerPaneOwnership({
          provider: paneId.startsWith('%') ? 'tmux' as const : 'cmux' as const,
          providerTarget: config.tmux_session,
          paneId,
          leaderPaneId: config.leader_pane_id ?? '',
          reservedPaneIds: config.workers
            .filter(candidate => candidate.name !== worker.name)
            .map(candidate => candidate.pane_id)
            .filter((id): id is string => Boolean(id)),
        });
        if (!legacyOwnership.ok) {
          const reason = `pane_cleanup_failed:${worker.name}:${legacyOwnership.reason}`;
          await markScaleDownFailed(reason);
          return { ok: false, error: reason };
        }
        try {
          let lastLegacyLiveness: Awaited<ReturnType<typeof getWorkerLiveness>> = await getWorkerLiveness(paneId);
          for (let attempt = 0; attempt < 2 && lastLegacyLiveness !== 'dead'; attempt++) {
            await killOwnedWorkerPane(legacyOwnership.ownership);
            lastLegacyLiveness = await getWorkerLiveness(paneId);
          }
          if (lastLegacyLiveness !== 'dead') {
            const reason = `pane_cleanup_failed:${worker.name}:${lastLegacyLiveness === 'alive' ? 'pane_still_alive' : 'pane_liveness_unknown'}`;
            await markScaleDownFailed(reason);
            return { ok: false, error: reason };
          }
        } catch (cleanupError) {
          const reason = `pane_cleanup_failed:${worker.name}:${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
          await markScaleDownFailed(reason);
          return { ok: false, error: reason };
        }
        continue;
      }
      const initialPaneLiveness = await getWorkerLiveness(paneId);
      let paneOwnership: WorkerPaneOwnership | null = null;
      if (initialPaneLiveness !== 'dead') {
        const ownershipResult = await adoptWorkerPaneOwnership({
          provider: paneId.startsWith('%') ? 'tmux' as const : 'cmux' as const,
          providerTarget: config.tmux_session,
          paneId,
          leaderPaneId: config.leader_pane_id ?? '',
          reservedPaneIds: config.workers
            .filter(candidate => candidate.name !== worker.name)
            .map(candidate => candidate.pane_id)
            .filter((id): id is string => Boolean(id)),
        });
        if (!ownershipResult.ok) {
          const reason = `pane_cleanup_failed:${worker.name}:${ownershipResult.reason}`;
          await markScaleDownFailed(reason);
          return { ok: false, error: reason };
        }
        paneOwnership = ownershipResult.ownership;
      }
      const attempt = await loadWorkerLaunchAttempt({
        cwd: leaderCwd,
        teamName: sanitized,
        workerName: worker.name,
        paneId,
        provider,
        attemptId: worker.launch_attempt_id,
        runtimeCliPath: resolveRuntimeCliPath(),
      });
      if (!attempt) {
        const reason = `provider_cleanup_unverified:${worker.name}`;
        await markScaleDownFailed(reason);
        return { ok: false, error: reason };
      }
      let paneCleanupError: string | null = null;
      const cleaned = await retireAndCleanupCurrentWorkerLaunchAttempt(attempt, 'scale_down', async () => {
        try {
          let lastLiveness: Awaited<ReturnType<typeof getWorkerLiveness>> = await getWorkerLiveness(paneId);
          if (lastLiveness === 'dead') return true;
          if (!paneOwnership) return false;
          for (let cleanupAttempt = 0; cleanupAttempt < 2; cleanupAttempt++) {
            await killOwnedWorkerPane(paneOwnership);
            lastLiveness = await getWorkerLiveness(paneId);
            if (lastLiveness === 'dead') return true;
          }
          paneCleanupError = lastLiveness === 'alive' ? 'pane_still_alive' : 'pane_liveness_unknown';
          return false;
        } catch (error) {
          paneCleanupError = error instanceof Error ? error.message : String(error);
          return false;
        }
      });
      if (!cleaned) {
        const reason = paneCleanupError
          ? `pane_cleanup_failed:${worker.name}:${paneCleanupError}`
          : `provider_cleanup_unverified:${worker.name}`;
        await markScaleDownFailed(reason);
        return { ok: false, error: reason };
      }
    }

    const liveness = await Promise.all(
      targetWorkers.map(async (w) => (w.pane_id ? [w.name, await getWorkerLiveness(w.pane_id)] as const : [w.name, 'unknown'] as const)),
    );
    const aliveNames = liveness.filter(([, state]) => state === 'alive').map(([name]) => name);
    if (aliveNames.length > 0) {
      const error = `Refusing to remove worker state while pane(s) are still alive: ${aliveNames.join(', ')}`;
      await markScaleDownFailed(error);
      return { ok: false, error };
    }
    const unknownNames = liveness.filter(([, state]) => state === 'unknown').map(([name]) => name);
    if (unknownNames.length > 0) {
      const error = `Refusing to remove worker state while pane liveness is unknown: ${unknownNames.join(', ')}`;
      await markScaleDownFailed(error);
      return { ok: false, error };
    }

    for (const w of targetWorkers) {
      if (w.worktree_path) {
        try {
          if (w.worktree_created) {
            removeWorkerWorktree(sanitized, w.name, leaderCwd);
          } else {
            prepareWorkerWorktreeForRemoval(sanitized, w.name, leaderCwd, w.worktree_path);
          }
        } catch (err) {
          const reason = `Failed to remove worktree for ${w.name}: ${err instanceof Error ? err.message : String(err)}`;
          await markScaleDownFailed(reason);
          return { ok: false, error: reason };
        }
      }
      removedNames.push(w.name);
    }

    // Phase 5: Update config and release the durable scale-down reservation.
    const removedSet = new Set(removedNames);
    const committed = await withProcessIdentityFileLock(lifecycleLock, async () => {
      const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
      if (!current || current.config.active_scale_down?.operation_id !== operationId || current.config.active_recovery || scaleUpFenceBlocks(current.config)) return false;
      const workers = current.config.workers.filter(worker => !removedSet.has(worker.name));
      const nextRevision = current.stateRevision + 1;
      const next = { ...current.config, workers, worker_count: workers.length, active_scale_down: undefined,
        state_revision: nextRevision };
      if (!await saveTeamConfigAtRevision(next, current.stateRevision, leaderCwd)) return false;
      config = next;
      return true;
    });
    if (!committed) {
      await markScaleDownFailed('scale_down_config_commit_failed_after_effects');
      return { ok: false, error: 'scale_down_config_commit_failed_after_effects' };
    }

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

/** Public scale facade; the owned algorithm applies the recovery exclusion under its existing lock. */
export async function scaleUp(
  teamName: string,
  count: number,
  agentType: string,
  tasks: Array<{ subject: string; description: string; owner?: string; blocked_by?: string[]; role?: string }>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScaleUpResult | ScaleError> {
  return scaleUpOwned(teamName, count, agentType, tasks, cwd, env);
}

/** Public scale-down facade; force and drain behavior are delegated unchanged. */
export async function scaleDown(
  teamName: string,
  cwd: string,
  options: ScaleDownOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScaleDownResult | ScaleError> {
  return scaleDownOwned(teamName, cwd, options, env);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveWorkerReadyTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OMC_TEAM_READY_TIMEOUT_MS;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (Number.isFinite(parsed) && parsed >= 5_000) return parsed;
  return 45_000;
}
