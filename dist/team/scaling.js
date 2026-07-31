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
import { tmuxExec, tmuxSpawn } from '../cli/tmux-utils.js';
import { buildWorkerArgv, getWorkerEnv as getModelWorkerEnv, resolveClaudeWorkerModel, assertHeadlessSupported, validateWorkerLaunchDescriptor, } from './model-contract.js';
import { CANONICAL_TEAM_ROLES } from '../shared/types.js';
import { normalizeDelegationRole } from '../features/delegation-routing/types.js';
import { routeTaskToRole } from './role-router.js';
import { teamReadConfig, teamWriteWorkerIdentity, teamReadWorkerStatus, teamAppendEvent, writeAtomic, } from './team-ops.js';
import { withScalingLock, migrateTeamConfigRevision, readRevisionedTeamConfig, saveTeamConfigAtRevision } from './monitor.js';
import { sanitizeName, getWorkerLiveness, killWorkerPanes, buildWorkerStartCommand, waitForPaneReady, } from './tmux-session.js';
import { TeamPaths, absPath } from './state-paths.js';
import { writeWorkerOverlay } from './worker-bootstrap.js';
import { ensureWorkerWorktree, installWorktreeRootAgents, prepareWorkerWorktreeForRemoval, removeWorkerWorktree, restoreWorktreeRootAgents, } from './git-worktree.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { withProcessIdentityFileLock } from './process-identity-lock.js';
import { currentProcessStartIdentity, isProcessIdentityDead } from './team-owner-epoch.js';
// ── Environment gate ──────────────────────────────────────────────────────────
const OMC_TEAM_SCALING_ENABLED_ENV = 'OMC_TEAM_SCALING_ENABLED';
const CLI_AGENT_TYPES = new Set(['claude', 'codex', 'gemini', 'grok', 'cursor', 'antigravity']);
export function isScalingEnabled(env = process.env) {
    const raw = env[OMC_TEAM_SCALING_ENABLED_ENV];
    if (!raw)
        return false;
    const normalized = raw.trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized);
}
function assertScalingEnabled(env = process.env) {
    if (!isScalingEnabled(env)) {
        throw new Error(`Dynamic scaling is disabled. Set ${OMC_TEAM_SCALING_ENABLED_ENV}=1 to enable.`);
    }
}
function asCliAgentType(agentType) {
    if (CLI_AGENT_TYPES.has(agentType)) {
        return agentType;
    }
    throw new Error(`Unknown agent type: ${agentType}. Supported: ${Array.from(CLI_AGENT_TYPES).join(', ')}`);
}
function configuredTmuxTarget(tmuxSession) {
    const expectedTarget = typeof tmuxSession === 'string' ? tmuxSession.trim() : '';
    return {
        expectedTarget,
        format: expectedTarget.includes(':') ? '#{session_name}:#{window_index}' : '#{session_name}',
    };
}
function validateSplitTargetPaneInConfiguredSession(splitTarget, tmuxSession) {
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
function scaleUpAttempt(config) {
    return config.active_scale_up;
}
// ── Scale Up ──────────────────────────────────────────────────────────────────
/**
 * Add workers to a running team mid-session.
 *
 * Acquires the file-based scaling lock, reads the current config,
 * validates capacity, creates new tmux panes, and bootstraps workers.
 */
export async function scaleUpOwned(teamName, count, agentType, tasks, cwd, env = process.env) {
    assertScalingEnabled(env);
    const cliAgentType = asCliAgentType(agentType);
    if (!Number.isInteger(count) || count < 1) {
        return { ok: false, error: `count must be a positive integer (got ${count})` };
    }
    const sanitized = sanitizeName(teamName);
    const leaderCwd = resolve(cwd);
    return await withScalingLock(sanitized, leaderCwd, async () => {
        const revisioned = await migrateTeamConfigRevision(sanitized, leaderCwd);
        if (!revisioned) {
            return { ok: false, error: `Team ${sanitized} not found` };
        }
        let config = revisioned.config;
        let configRevision = revisioned.stateRevision;
        if (config.active_recovery || config.active_scale_down)
            return { ok: false, error: 'team_mutation_busy' };
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
        if (!processStartedAt)
            return { ok: false, error: 'process_start_identity_unavailable' };
        const withScaleUpFenceRevision = (next, stateRevision) => {
            const reservation = scaleUpAttempt(next);
            return {
                ...next,
                state_revision: stateRevision,
                ...(reservation ? { active_scale_up: { ...reservation, state_revision: stateRevision } } : {}),
            };
        };
        const saveScaleUpConfig = async (next, expectedRevision) => {
            try {
                return await saveTeamConfigAtRevision(next, expectedRevision, leaderCwd);
            }
            catch {
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
                if (existing && (existing.phase !== 'reserved' || !isProcessIdentityDead(existing))) {
                    throw new Error('team_mutation_busy');
                }
                const nextRevision = current.stateRevision + 1;
                const next = { ...current.config, state_revision: nextRevision, active_scale_up: {
                        operation_id: operationId, phase: 'reserved', pid: process.pid,
                        process_started_at: processStartedAt, state_revision: nextRevision,
                        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                    } };
                if (!await saveScaleUpConfig(next, current.stateRevision))
                    throw new Error('team_mutation_busy');
                configRevision = nextRevision;
                return next;
            });
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'team_mutation_busy' };
        }
        const releaseScaleUpReservation = async (failureReason) => withProcessIdentityFileLock(lifecycleLock, async () => {
            const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
            const reservation = current ? scaleUpAttempt(current.config) : undefined;
            if (!current || !reservation || reservation.operation_id !== operationId
                || reservation.pid !== process.pid || reservation.process_started_at !== processStartedAt)
                return false;
            const nextRevision = current.stateRevision + 1;
            const next = { ...current.config, state_revision: nextRevision,
                ...(failureReason ? { active_scale_up: { ...reservation, phase: 'failed', failure_reason: failureReason,
                        state_revision: nextRevision, updated_at: new Date().toISOString() } } : { active_scale_up: undefined }) };
            if (!await saveScaleUpConfig(next, current.stateRevision))
                return false;
            config = next;
            configRevision = nextRevision;
            return !failureReason;
        });
        const reserveScaleUpEffects = async () => withProcessIdentityFileLock(lifecycleLock, async () => {
            const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
            const reservation = current ? scaleUpAttempt(current.config) : undefined;
            if (!current || !reservation || reservation.operation_id !== operationId
                || reservation.pid !== process.pid || reservation.process_started_at !== processStartedAt
                || current.config.active_recovery || current.config.active_scale_down
                || current.config.lifecycle_state === 'shutting_down' || current.config.lifecycle_state === 'stopped')
                return false;
            const nextRevision = current.stateRevision + 1;
            const next = { ...current.config, state_revision: nextRevision, active_scale_up: {
                    ...reservation, phase: 'effects', state_revision: nextRevision, updated_at: new Date().toISOString(),
                } };
            if (!await saveScaleUpConfig(next, current.stateRevision))
                return false;
            config = next;
            configRevision = nextRevision;
            return true;
        });
        if (!await reserveScaleUpEffects()) {
            const released = await releaseScaleUpReservation().catch(() => false);
            return { ok: false, error: released ? 'team_mutation_busy' : 'scale_up_fence_release_failed' };
        }
        const teamStateRoot = config.team_state_root ?? `${leaderCwd}/.omc/state/team/${sanitized}`;
        const worktreeMode = config.worktree_mode ?? 'disabled';
        // Resolve the monotonic worker index counter
        let nextIndex = config.next_worker_index ?? (currentCount + 1);
        const addedWorkers = [];
        const pendingWorktrees = [];
        const pendingIdentities = new Set();
        const reservedWorkerNames = new Set();
        const reservedLaunchDescriptors = new Map();
        const cleanupScaledWorkerWorktree = (workerName, created) => {
            if (created) {
                removeWorkerWorktree(sanitized, workerName, leaderCwd);
            }
            else {
                const restored = restoreWorktreeRootAgents(sanitized, workerName, leaderCwd);
                if (restored.reason === 'agents_dirty') {
                    throw new Error(`agents_dirty: preserving modified worktree root AGENTS.md for ${workerName}`);
                }
            }
        };
        const rollbackScaleUp = async (error, paneId, orphanFailure) => {
            const cleanupFailures = orphanFailure ? [orphanFailure] : [];
            const cleanedWorktrees = new Set();
            const cleanupPane = async (candidate, label) => {
                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        tmuxExec(['kill-pane', '-t', candidate], { stdio: 'pipe' });
                    }
                    catch { /* verify below */ }
                    const liveness = await getWorkerLiveness(candidate).catch(() => 'unknown');
                    if (liveness === 'dead')
                        return;
                }
                cleanupFailures.push(`${label}:pane:${candidate}`);
            };
            const cleanupIdentity = async (workerName) => {
                const workerDir = absPath(leaderCwd, TeamPaths.workerDir(sanitized, workerName));
                for (let attempt = 0; attempt < 2 && existsSync(workerDir); attempt++) {
                    await rm(workerDir, { recursive: true, force: true }).catch(() => undefined);
                }
                if (existsSync(workerDir))
                    cleanupFailures.push(`${workerName}:identity:${workerDir}`);
            };
            for (const worker of addedWorkers) {
                const idx = config.workers.findIndex(candidate => candidate.name === worker.name);
                if (idx >= 0)
                    config.workers.splice(idx, 1);
                if (worker.pane_id)
                    await cleanupPane(worker.pane_id, worker.name);
                if (worker.worktree_path) {
                    let cleaned = false;
                    for (let attempt = 0; attempt < 2 && !cleaned; attempt++) {
                        try {
                            cleanupScaledWorkerWorktree(worker.name, worker.worktree_created === true);
                            cleaned = true;
                        }
                        catch { /* retry */ }
                    }
                    if (cleaned)
                        cleanedWorktrees.add(worker.name);
                    if (!cleaned || existsSync(worker.worktree_path))
                        cleanupFailures.push(`${worker.name}:worktree:${worker.worktree_path}`);
                }
                await cleanupIdentity(worker.name);
            }
            for (const pending of pendingWorktrees) {
                if (!cleanedWorktrees.has(pending.workerName)) {
                    let cleaned = false;
                    for (let attempt = 0; attempt < 2 && !cleaned; attempt++) {
                        try {
                            cleanupScaledWorkerWorktree(pending.workerName, pending.created);
                            cleaned = true;
                        }
                        catch { /* retry */ }
                    }
                    if (!cleaned || existsSync(pending.path))
                        cleanupFailures.push(`${pending.workerName}:pending-worktree:${pending.path}`);
                }
                await cleanupIdentity(pending.workerName);
            }
            for (const workerName of pendingIdentities)
                await cleanupIdentity(workerName);
            if (paneId)
                await cleanupPane(paneId, 'pending');
            config.worker_count = config.workers.length;
            config.next_worker_index = nextIndex;
            if (reservedWorkerNames.size > 0) {
                const persisted = await readRevisionedTeamConfig(sanitized, leaderCwd).catch(() => null);
                const reservedRows = persisted?.config.workers.filter(worker => reservedWorkerNames.has(worker.name)) ?? [];
                if (persisted && (persisted.config.lifecycle_state ?? 'active') === 'active') {
                    const addedByName = new Map(addedWorkers.map(worker => [worker.name, worker]));
                    const safeToRetire = new Set();
                    for (const row of reservedRows) {
                        const expectedLaunch = reservedLaunchDescriptors.get(row.name);
                        const launchMatches = JSON.stringify(row.launch_descriptor) === JSON.stringify(expectedLaunch);
                        const activated = addedByName.get(row.name);
                        if (launchMatches && (row.operational_state === 'starting'
                            || (row.operational_state === 'active' && activated?.pane_id === row.pane_id))) {
                            safeToRetire.add(row.name);
                        }
                        else {
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
                        }
                        else {
                            config = retired;
                            configRevision = retired.state_revision ?? configRevision;
                            for (const workerName of safeToRetire)
                                reservedWorkerNames.delete(workerName);
                        }
                    }
                }
                else if (reservedRows.length > 0) {
                    cleanupFailures.push('scale_up_reservation_fence_lost');
                }
                else {
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
            if (!await releaseScaleUpReservation())
                return { ok: false, error: `${error}; scale_up_fence_release_failed` };
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
            pendingIdentities.add(workerName);
            try {
                // Track the exact prospective worktree path before creation so a partial
                // ensureWorkerWorktree failure remains independently cleanable.
                const workerDirPath = absPath(leaderCwd, TeamPaths.workerDir(sanitized, workerName));
                await mkdir(workerDirPath, { recursive: true });
                let worktree = null;
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
                // Resolve per-worker provider/model from the team's routing snapshot
                // (Option E stickiness — snapshot is immutable, never re-resolved).
                // Worker's inferred role comes from the owned-task `role` field when all
                // owned tasks agree on a single role; otherwise falls back to the
                // caller-supplied agentType default.
                const workerTasks = tasks.filter(t => t.owner === workerName);
                const ownedRoles = Array.from(new Set(workerTasks.map(t => t.role).filter(Boolean)));
                const inferredRole = ownedRoles.length === 1
                    ? ownedRoles[0]
                    : (workerTasks[0]
                        ? routeTaskToRole(workerTasks[0].subject, workerTasks[0].description, 'executor').role
                        : undefined);
                const canonicalRoleSet = new Set(CANONICAL_TEAM_ROLES);
                const canonical = inferredRole
                    ? (() => {
                        const normalized = normalizeDelegationRole(inferredRole);
                        return canonicalRoleSet.has(normalized) ? normalized : null;
                    })()
                    : null;
                let workerAgentType = cliAgentType;
                let workerModel;
                // Only override caller's agentType when the worker's inferred role came
                // from an explicit `task.role` (user opt-in). Pre-patch semantics: callers
                // passing `--agent-type codex` stay on codex regardless of task text.
                const hasExplicitOwnedRole = ownedRoles.length === 1;
                const routedPair = hasExplicitOwnedRole && canonical
                    ? config.resolved_routing?.[canonical]
                    : undefined;
                if (routedPair) {
                    const { primary } = routedPair;
                    const primaryProvider = primary.provider;
                    if (CLI_AGENT_TYPES.has(primaryProvider)) {
                        workerAgentType = primaryProvider;
                        workerModel = primary.model;
                    }
                }
                else if (cliAgentType === 'claude') {
                    // Honor Bedrock/Vertex default-model resolution for non-routed claude workers.
                    workerModel = resolveClaudeWorkerModel(env);
                }
                // AC-8: try the resolved provider first; on trust-path / not-found
                // failure, emit a loud warning and retry with the snapshot's Claude
                // fallback tuple. Aborting the scale_up silently would mask a missing
                // CLI, so we only rollback if even the fallback cannot be built.
                const tryBuildLaunch = (agentType, model) => {
                    // Platform guard (parity with startTeamV2 preflight): a headless-unsupported
                    // provider (e.g. antigravity on Windows) throws here so scale-up falls back
                    // to the routed Claude fallback instead of spawning an unusable primary.
                    assertHeadlessSupported(agentType);
                    const [launchBinary, ...launchArgs] = buildWorkerArgv(agentType, {
                        teamName: sanitized,
                        workerName,
                        cwd: workerCwd,
                        ...(model ? { model } : {}),
                    });
                    return { launchBinary, launchArgs };
                };
                let launchBinary;
                let launchArgs;
                try {
                    ({ launchBinary, launchArgs } = tryBuildLaunch(workerAgentType, workerModel));
                }
                catch (primaryError) {
                    const primaryReason = primaryError instanceof Error ? primaryError.message : String(primaryError);
                    const fallbackPair = routedPair?.fallback;
                    const fallbackProvider = fallbackPair
                        ? fallbackPair.provider
                        : 'claude';
                    const fallbackModel = fallbackPair?.model;
                    process.stderr.write(`[team/scaling] cli_binary_missing:${workerAgentType}: ${primaryReason} — falling back to ${fallbackProvider} (AC-8)\n`);
                    await teamAppendEvent(sanitized, {
                        type: 'team_leader_nudge',
                        worker: 'leader-fixed',
                        reason: `cli_binary_missing:${workerAgentType}:${primaryReason}:fallback=${fallbackProvider}`,
                    }, leaderCwd);
                    try {
                        ({ launchBinary, launchArgs } = tryBuildLaunch(fallbackProvider, fallbackModel));
                        workerAgentType = fallbackProvider;
                        workerModel = fallbackModel;
                    }
                    catch (fallbackError) {
                        const fallbackReason = fallbackError instanceof Error
                            ? fallbackError.message
                            : String(fallbackError);
                        return await rollbackScaleUp(`Failed to resolve worker launch config for ${workerName} (primary=${workerAgentType}: ${primaryReason}; fallback=${fallbackProvider}: ${fallbackReason})`);
                    }
                }
                let launchDescriptor;
                try {
                    launchDescriptor = validateWorkerLaunchDescriptor({ schema_version: 1, provider: workerAgentType,
                        model: workerModel ?? null, binary: launchBinary, args: [...launchArgs] });
                }
                catch (error) {
                    return await rollbackScaleUp(`Invalid worker launch descriptor for ${workerName}: ${error instanceof Error ? error.message : String(error)}`);
                }
                const workerTaskRoles = tasks.filter(t => t.owner === workerName).map(t => t.role).filter(Boolean);
                const uniqueTaskRoles = new Set(workerTaskRoles);
                const workerRole = workerTaskRoles.length > 0 && uniqueTaskRoles.size === 1 ? workerTaskRoles[0] : agentType;
                const reservedWorker = {
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
                const extraEnv = {
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
                    }
                    catch (error) {
                        const reason = error instanceof Error ? error.message : String(error);
                        return await rollbackScaleUp(`Failed to install worker overlay for ${workerName}: ${reason}`);
                    }
                }
                let cmd;
                try {
                    cmd = buildWorkerStartCommand({
                        teamName: sanitized,
                        workerName,
                        envVars: extraEnv,
                        launchArgs: [...launchDescriptor.args],
                        launchBinary: launchDescriptor.binary,
                        cwd: workerCwd,
                    });
                }
                catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    return await rollbackScaleUp(`Failed to build worker start command for ${workerName}: ${reason}`);
                }
                // Split from the rightmost worker pane or the leader pane
                const result = tmuxSpawn([
                    'split-window', splitDirection, '-t', splitTarget, '-d', '-P', '-F', '#{pane_id}', '-c', workerCwd, cmd,
                ]);
                if (result.status !== 0) {
                    return await rollbackScaleUp(`Failed to create tmux pane for ${workerName}: ${(result.stderr || '').trim()}`);
                }
                const paneId = (result.stdout || '').trim().split('\n')[0]?.trim();
                if (!paneId || !paneId.startsWith('%')) {
                    return await rollbackScaleUp(`Failed to capture pane ID for ${workerName}`, undefined, `unaddressable_spawned_pane:${(result.stdout || '').trim() || '<missing>'}`);
                }
                // Get PID
                let panePid;
                try {
                    const pidResult = tmuxSpawn(['display-message', '-t', paneId, '-p', '#{pane_pid}']);
                    const pidStr = (pidResult.stdout || '').trim();
                    const parsed = Number.parseInt(pidStr, 10);
                    if (Number.isFinite(parsed))
                        panePid = parsed;
                }
                catch { /* best-effort pid lookup */ }
                // The starting reservation already persisted role and immutable launch identity.
                const workerInfo = {
                    name: workerName,
                    index: workerIndex,
                    role: workerRole,
                    assigned_tasks: [],
                    worker_cli: launchDescriptor.provider,
                    launch_descriptor: launchDescriptor,
                    operational_state: 'active',
                    pid: panePid,
                    pane_id: paneId,
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
                    }
                    catch {
                        // Non-fatal: worker may still become ready
                    }
                }
                const pendingIndex = pendingWorktrees.findIndex(pending => pending.workerName === workerName);
                if (pendingIndex >= 0)
                    pendingWorktrees.splice(pendingIndex, 1);
                const reservedIndex = config.workers.findIndex(candidate => candidate.name === workerName);
                if (reservedIndex < 0)
                    throw new Error(`scale_up_reservation_missing:${workerName}`);
                config = { ...config, workers: config.workers.map((candidate, index) => index === reservedIndex ? workerInfo : candidate),
                    worker_count: config.workers.length, next_worker_index: nextIndex };
                pendingIdentities.delete(workerName);
            }
            catch (error) {
                return await rollbackScaleUp(`Scale-up post-effect failed for ${workerName}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        const committedConfig = withScaleUpFenceRevision(config, configRevision + 1);
        try {
            if (!await saveScaleUpConfig(committedConfig, configRevision)) {
                return await rollbackScaleUp('Scale-up config commit lost its revision: stale_state_revision');
            }
            config = committedConfig;
            configRevision += 1;
        }
        catch (error) {
            return await rollbackScaleUp(`Scale-up config commit lost its revision: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!await releaseScaleUpReservation()) {
            return { ok: false, error: 'scale_up_fence_release_failed_after_commit' };
        }
        await teamAppendEvent(sanitized, {
            type: 'team_leader_nudge',
            worker: 'leader-fixed',
            reason: `scale_up: added ${count} worker(s), new count=${config.worker_count}`,
        }, leaderCwd);
        let servicesSync = 'synced';
        try {
            const { reconcileCommittedTeamServices } = await import('./runtime-v2.js');
            servicesSync = await reconcileCommittedTeamServices(config, leaderCwd);
        }
        catch {
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
/**
 * Remove workers from a running team.
 *
 * Sets targeted workers to 'draining' status, waits for them to finish
 * current work (or force kills), then removes tmux panes and updates config.
 */
export async function scaleDownOwned(teamName, cwd, options = {}, env = process.env) {
    assertScalingEnabled(env);
    const sanitized = sanitizeName(teamName);
    const leaderCwd = resolve(cwd);
    const force = options.force === true;
    const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
    return await withScalingLock(sanitized, leaderCwd, async () => {
        const loadedConfig = await teamReadConfig(sanitized, leaderCwd);
        if (!loadedConfig) {
            return { ok: false, error: `Team ${sanitized} not found` };
        }
        if (loadedConfig.active_recovery || scaleUpAttempt(loadedConfig))
            return { ok: false, error: 'team_mutation_busy' };
        let config = loadedConfig;
        // Determine which workers to remove
        let targetWorkers;
        if (options.workerNames && options.workerNames.length > 0) {
            targetWorkers = [];
            for (const name of options.workerNames) {
                const w = config.workers.find(w => w.name === name);
                if (!w) {
                    return { ok: false, error: `Worker ${name} not found in team ${sanitized}` };
                }
                targetWorkers.push(w);
            }
        }
        else {
            const count = options.count ?? 1;
            if (!Number.isInteger(count) || count < 1) {
                return { ok: false, error: `count must be a positive integer (got ${count})` };
            }
            // Find idle workers to remove
            const idleWorkers = [];
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
        const workerIdentity = (worker) => ({
            name: worker.name,
            ...(worker.pane_id ? { pane_id: worker.pane_id } : {}),
            ...(worker.worktree_path ? { worktree_path: worker.worktree_path } : {}),
            ...(worker.worktree_created !== undefined ? { worktree_created: worker.worktree_created } : {}),
        });
        const identitiesMatch = (workers, expected) => JSON.stringify(workers.map(workerIdentity)) === JSON.stringify(expected);
        try {
            config = await withProcessIdentityFileLock(lifecycleLock, async () => {
                const current = await migrateTeamConfigRevision(sanitized, leaderCwd);
                if (!current || current.config.active_recovery || scaleUpAttempt(current.config)
                    || current.config.lifecycle_state === 'shutting_down' || current.config.lifecycle_state === 'stopped') {
                    throw new Error('team_mutation_busy');
                }
                const existingScaleDown = current.config.active_scale_down;
                if (existingScaleDown && (existingScaleDown.phase !== 'draining'
                    || !isProcessIdentityDead(existingScaleDown)))
                    throw new Error('team_mutation_busy');
                const selected = selectedNames.map(name => current.config.workers.find(worker => worker.name === name));
                if (selected.some((worker) => !worker)
                    || !identitiesMatch(selected, targetWorkers.map(workerIdentity)))
                    throw new Error('team_mutation_busy');
                const now = new Date().toISOString();
                const processStartedAt = currentProcessStartIdentity();
                if (!processStartedAt)
                    throw new Error('process_start_identity_unavailable');
                const nextRevision = current.stateRevision + 1;
                const next = { ...current.config, state_revision: nextRevision, active_scale_down: {
                        operation_id: operationId, phase: 'draining', pid: process.pid,
                        process_started_at: processStartedAt, workers: selected.map(workerIdentity),
                        state_revision: nextRevision, created_at: now, updated_at: now,
                    } };
                if (!await saveTeamConfigAtRevision(next, current.stateRevision, leaderCwd))
                    throw new Error('team_mutation_busy');
                return next;
            });
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'team_mutation_busy' };
        }
        targetWorkers = selectedNames.map(name => config.workers.find(worker => worker.name === name)).filter(Boolean);
        const markScaleDownFailed = async (reason) => {
            let configMarkError;
            try {
                await withProcessIdentityFileLock(lifecycleLock, async () => {
                    const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
                    if (!current || current.config.active_scale_down?.operation_id !== operationId)
                        return;
                    const nextRevision = current.stateRevision + 1;
                    if (!await saveTeamConfigAtRevision({ ...current.config, state_revision: nextRevision, active_scale_down: {
                            ...current.config.active_scale_down, phase: 'failed', failure_reason: reason,
                            state_revision: nextRevision, updated_at: new Date().toISOString(),
                        } }, current.stateRevision, leaderCwd))
                        configMarkError = 'config_mark_cas_failed';
                });
            }
            catch (error) {
                configMarkError = error instanceof Error ? error.message : String(error);
            }
            const evidencePath = absPath(leaderCwd, TeamPaths.scalingRollbackFailure(sanitized, Date.now()));
            await writeAtomic(evidencePath, JSON.stringify({ schema_version: 1, operation: 'scale_down',
                operation_id: operationId, team_name: sanitized, workers: selectedNames, reason,
                ...(configMarkError ? { config_mark_error: configMarkError } : {}),
                recorded_at: new Date().toISOString() }, null, 2));
        };
        const reserveEffects = async () => withProcessIdentityFileLock(lifecycleLock, async () => {
            const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
            const reservation = current?.config.active_scale_down;
            if (!current || reservation?.operation_id !== operationId || current.config.active_recovery || scaleUpAttempt(current.config)
                || !identitiesMatch(selectedNames.map(name => current.config.workers.find(worker => worker.name === name)).filter(Boolean), reservation.workers))
                return false;
            const nextRevision = current.stateRevision + 1;
            const next = { ...current.config, state_revision: nextRevision, active_scale_down: {
                    ...reservation, phase: 'effects', state_revision: nextRevision, updated_at: new Date().toISOString(),
                } };
            if (!await saveTeamConfigAtRevision(next, current.stateRevision, leaderCwd))
                return false;
            config = next;
            targetWorkers = selectedNames.map(name => next.workers.find(worker => worker.name === name)).filter(Boolean);
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
        const removedNames = [];
        // Phase 1: Set workers to 'draining' status. Worktree safety is checked
        // after the drain/kill boundary so active workers can finish and clean up
        // ordinary in-progress work before removal is attempted.
        for (const w of targetWorkers) {
            const drainingStatus = {
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
                const allDrained = await Promise.all(targetWorkers.map(async (w) => {
                    const status = await teamReadWorkerStatus(sanitized, w.name, leaderCwd);
                    const liveness = w.pane_id ? await getWorkerLiveness(w.pane_id) : 'unknown';
                    return status.state === 'idle' || status.state === 'done' || liveness === 'dead';
                }));
                if (allDrained.every(Boolean))
                    break;
                await new Promise(r => setTimeout(r, 2_000));
            }
        }
        if (!await reserveEffects()) {
            await markScaleDownFailed('scale_down_fence_lost_before_effects');
            return { ok: false, error: 'team_mutation_busy' };
        }
        // Phase 3: Kill tmux panes after workers have had a chance to drain.
        const targetPaneIds = targetWorkers
            .map((w) => w.pane_id)
            .filter((paneId) => typeof paneId === 'string' && paneId.trim().length > 0);
        try {
            await killWorkerPanes({
                paneIds: targetPaneIds,
                leaderPaneId: config.leader_pane_id ?? undefined,
                teamName: sanitized,
                cwd: leaderCwd,
            });
        }
        catch (error) {
            const reason = `pane_cleanup_failed:${error instanceof Error ? error.message : String(error)}`;
            await markScaleDownFailed(reason);
            return { ok: false, error: reason };
        }
        const liveness = await Promise.all(targetWorkers.map(async (w) => (w.pane_id ? [w.name, await getWorkerLiveness(w.pane_id)] : [w.name, 'unknown'])));
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
                    }
                    else {
                        prepareWorkerWorktreeForRemoval(sanitized, w.name, leaderCwd, w.worktree_path);
                    }
                }
                catch (err) {
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
            if (!current || current.config.active_scale_down?.operation_id !== operationId || current.config.active_recovery || scaleUpAttempt(current.config))
                return false;
            const workers = current.config.workers.filter(worker => !removedSet.has(worker.name));
            const nextRevision = current.stateRevision + 1;
            const next = { ...current.config, workers, worker_count: workers.length, active_scale_down: undefined,
                state_revision: nextRevision };
            if (!await saveTeamConfigAtRevision(next, current.stateRevision, leaderCwd))
                return false;
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
export async function scaleUp(teamName, count, agentType, tasks, cwd, env = process.env) {
    return scaleUpOwned(teamName, count, agentType, tasks, cwd, env);
}
/** Public scale-down facade; force and drain behavior are delegated unchanged. */
export async function scaleDown(teamName, cwd, options = {}, env = process.env) {
    return scaleDownOwned(teamName, cwd, options, env);
}
// ── Helpers ───────────────────────────────────────────────────────────────────
function resolveWorkerReadyTimeoutMs(env) {
    const raw = env.OMC_TEAM_READY_TIMEOUT_MS;
    const parsed = Number.parseInt(String(raw ?? ''), 10);
    if (Number.isFinite(parsed) && parsed >= 5_000)
        return parsed;
    return 45_000;
}
//# sourceMappingURL=scaling.js.map