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
import { randomUUID } from 'node:crypto';
import { buildWorkerArgv, clearResolvedPathCache, getWorkerEnv as getModelWorkerEnv, resolveDefaultWorkerModel, assertHeadlessSupported, resolveValidatedBinaryPath, validateWorkerLaunchDescriptor, } from './model-contract.js';
import { CANONICAL_TEAM_ROLES } from '../shared/types.js';
import { normalizeDelegationRole } from '../features/delegation-routing/types.js';
import { routeTaskToRole } from './role-router.js';
import { teamReadConfig, teamWriteWorkerIdentity, teamReadWorkerStatus, teamAppendEvent, writeAtomic, } from './team-ops.js';
import { isValidTmuxServerIdentity, } from './types.js';
import { withScalingLock, migrateTeamConfigRevision, readRevisionedTeamConfig, saveTeamConfigAtRevision } from './monitor.js';
import { adoptWorkerPaneOwnership, sanitizeName, getOwnedWorkerLiveness, killOwnedWorkerPane, spawnOwnedWorkerInPane, splitTeamWorkerPaneWithEvidence, workerPaneBelongsToOwnedProviderTarget, waitForPaneReady, } from './tmux-session.js';
import { TeamPaths, absPath, canonicalTeamCwd, canonicalTeamStatePath, teamStateRoot as resolveTeamStateRoot, } from './state-paths.js';
import { writeWorkerOverlay } from './worker-bootstrap.js';
import { ensureWorkerWorktree, installWorktreeRootAgents, prepareWorkerWorktreeForRemoval, removeWorkerWorktree, restoreWorktreeRootAgents, } from './git-worktree.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { currentProcessStartIdentity, isProcessIdentityDead } from './team-owner-epoch.js';
import { resolveRuntimeCliPath } from './runtime-owner-client.js';
import { loadWorkerLaunchAttempt, retireAndCleanupCurrentWorkerLaunchAttempt } from './worker-launch-ack.js';
import { assertTeamInstanceUnderLock, createTeamInstanceBinding, TeamInstanceError, withTeamInstanceLifecycleLock, } from './team-instance.js';
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
    return { expectedTarget };
}
async function validateSplitTargetPaneInConfiguredSession(splitTarget, tmuxSession, tmuxServerIdentity) {
    const { expectedTarget } = configuredTmuxTarget(tmuxSession);
    if (!splitTarget.trim()) {
        return 'Refusing to split pane: missing leader/worker pane target.';
    }
    if (!expectedTarget) {
        return `Refusing to split tmux pane ${splitTarget}: missing configured tmux_session.`;
    }
    const provider = expectedTarget.startsWith('cmux:') ? 'cmux' : 'tmux';
    if (provider === 'tmux' && !isValidTmuxServerIdentity(tmuxServerIdentity)) {
        return `Refusing to split tmux pane ${splitTarget}: tmux server identity is unavailable.`;
    }
    const belongs = await workerPaneBelongsToOwnedProviderTarget({
        provider,
        providerTarget: expectedTarget,
        paneId: splitTarget,
        ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
    });
    if (!belongs) {
        return `Refusing to split pane ${splitTarget}: pane is not verified in configured target ${expectedTarget}.`;
    }
    return null;
}
function scaleUpAttempt(config) {
    return config.active_scale_up;
}
/**
 * Scale operations are destructive only for one immutable team incarnation.
 * The assertion is intentionally under the caller's lifecycle lock; using the
 * convenience locking form here would recursively acquire the same name lock
 * from the reservation/fence transitions below.
 */
async function assertScalingInstanceUnderLock(config, teamName, cwd, expectedInstanceId) {
    const configuredInstanceId = config.instance_id;
    if (!configuredInstanceId)
        throw new Error('team_instance_authority_missing');
    if (config.tmux_session
        && !config.tmux_session.startsWith('cmux:')
        && !isValidTmuxServerIdentity(config.tmux_server_identity)) {
        throw new Error('tmux_server_identity_missing');
    }
    if (config.name !== teamName
        || (config.leader_cwd !== undefined && canonicalTeamCwd(config.leader_cwd) !== canonicalTeamCwd(cwd))) {
        throw new Error('team_instance_mismatch');
    }
    if (expectedInstanceId !== undefined
        && configuredInstanceId.toLowerCase() !== expectedInstanceId.toLowerCase()) {
        throw new Error('team_instance_mismatch');
    }
    const binding = createTeamInstanceBinding({
        teamName,
        cwd,
        instanceId: configuredInstanceId,
    });
    if (config.team_state_root !== undefined
        && canonicalTeamStatePath(cwd, config.team_state_root) !== binding.state_root) {
        throw new Error('team_instance_mismatch');
    }
    const assertion = await assertTeamInstanceUnderLock(binding);
    if (assertion.reservation.phase !== 'active') {
        throw new Error('team_instance_reservation_active');
    }
    if (assertion.observed_state !== 'bound') {
        throw new Error('team_instance_state_missing');
    }
    return binding;
}
function scaleInstanceError(error) {
    if (error instanceof TeamInstanceError)
        return error.code;
    return error instanceof Error ? error.message : String(error);
}
function configuredPaneOwnership(config, paneId, excludeWorkerName) {
    if (!config.tmux_session || !paneId.trim())
        return null;
    const provider = paneId.startsWith('%') ? 'tmux' : 'cmux';
    const identity = config.tmux_server_identity;
    const validIdentity = provider === 'tmux' && isValidTmuxServerIdentity(identity)
        ? identity
        : undefined;
    if (provider === 'tmux' && !validIdentity)
        return null;
    return {
        provider,
        providerTarget: config.tmux_session,
        paneId,
        splitTarget: '',
        leaderPaneId: config.leader_pane_id ?? '',
        reservedPaneIds: config.workers
            .filter(worker => worker.name !== excludeWorkerName && worker.pane_id)
            .map(worker => worker.pane_id),
        source: 'adopted',
        ...(validIdentity ? { tmuxServerIdentity: validIdentity } : {}),
    };
}
/**
 * Returns true if the active_scale_up fence blocks team mutations.
 * A 'committed' fence proves workers were durably persisted and the
 * release write failed; it may be safely reclaimed (cleared) by a
 * later operation with exact operation identity verification.
 * Historical 'effects' without commit proof always blocks — it
 * represents ambiguous partial state that requires explicit repair.
 */
export function scaleUpFenceBlocks(config) {
    const attempt = config.active_scale_up;
    if (!attempt)
        return false;
    if (attempt.phase === 'committed')
        return false;
    return true;
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
        if (!config.instance_id)
            return { ok: false, error: 'team_instance_authority_missing' };
        let originalInstanceId = config.instance_id;
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
        const saveScaleUpConfig = async (next, expectedRevision, options) => {
            try {
                return await saveTeamConfigAtRevision(next, expectedRevision, leaderCwd, undefined, options);
            }
            catch {
                return false;
            }
        };
        try {
            config = await withTeamInstanceLifecycleLock(leaderCwd, sanitized, async () => {
                const current = await migrateTeamConfigRevision(sanitized, leaderCwd);
                if (current) {
                    try {
                        const binding = await assertScalingInstanceUnderLock(current.config, sanitized, leaderCwd, originalInstanceId);
                        originalInstanceId = binding.instance_id;
                    }
                    catch (error) {
                        throw new Error(scaleInstanceError(error));
                    }
                }
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
                if (existing) {
                    const existingInstanceId = existing.instance_id;
                    if (!existingInstanceId)
                        throw new Error('team_mutation_busy');
                    if (existingInstanceId.toLowerCase() !== originalInstanceId.toLowerCase()) {
                        throw new Error('team_instance_mismatch');
                    }
                }
                const nextRevision = current.stateRevision + 1;
                const next = { ...current.config, state_revision: nextRevision, active_scale_up: ({
                        operation_id: operationId, phase: 'reserved', pid: process.pid,
                        process_started_at: processStartedAt, state_revision: nextRevision,
                        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                        // Keep the immutable incarnation on the operation fence.  A later
                        // same-name config can never be adopted by this operation.
                        instance_id: originalInstanceId,
                    }) };
                // Replacing an existing fence (dead reserved, or reconciling committed) is foreign install.
                if (!await saveScaleUpConfig(next, current.stateRevision, existing ? { reclaim: { active_scale_up: true } } : undefined))
                    throw new Error('team_mutation_busy');
                configRevision = nextRevision;
                return next;
            });
        }
        catch (error) {
            return { ok: false, error: scaleInstanceError(error) };
        }
        const releaseScaleUpReservation = async (failureReason) => withTeamInstanceLifecycleLock(leaderCwd, sanitized, async () => {
            const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
            const reservation = current ? scaleUpAttempt(current.config) : undefined;
            if (!current || !reservation || reservation.operation_id !== operationId
                || reservation.pid !== process.pid || reservation.process_started_at !== processStartedAt)
                return false;
            try {
                await assertScalingInstanceUnderLock(current.config, sanitized, leaderCwd, originalInstanceId);
            }
            catch {
                return false;
            }
            const reservationInstanceId = reservation.instance_id;
            if (!reservationInstanceId
                || reservationInstanceId.toLowerCase() !== originalInstanceId.toLowerCase())
                return false;
            // Never clear a committed fence or advance state while shutdown owns the team.
            if (!failureReason && current.config.lifecycle_state && current.config.lifecycle_state !== 'active') {
                return false;
            }
            const nextRevision = current.stateRevision + 1;
            const next = { ...current.config, state_revision: nextRevision,
                ...(failureReason ? { active_scale_up: { ...reservation, phase: 'failed', failure_reason: failureReason,
                        state_revision: nextRevision, updated_at: new Date().toISOString() } } : { active_scale_up: undefined }) };
            const saveOpts = failureReason
                ? undefined // same-owner phase transition reserved/effects/committed → failed
                : { release: { active_scale_up: true } };
            if (!await saveScaleUpConfig(next, current.stateRevision, saveOpts))
                return false;
            config = next;
            configRevision = nextRevision;
            return !failureReason;
        });
        const reserveScaleUpEffects = async () => withTeamInstanceLifecycleLock(leaderCwd, sanitized, async () => {
            const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
            const reservation = current ? scaleUpAttempt(current.config) : undefined;
            if (!current || !reservation || reservation.operation_id !== operationId
                || reservation.pid !== process.pid || reservation.process_started_at !== processStartedAt
                || reservation.phase !== 'reserved'
                || current.config.active_recovery || current.config.active_scale_down
                || current.config.lifecycle_state === 'shutting_down' || current.config.lifecycle_state === 'stopped')
                return false;
            try {
                await assertScalingInstanceUnderLock(current.config, sanitized, leaderCwd, originalInstanceId);
            }
            catch {
                return false;
            }
            const reservationInstanceId = reservation.instance_id;
            if (!reservationInstanceId
                || reservationInstanceId.toLowerCase() !== originalInstanceId.toLowerCase())
                return false;
            const nextRevision = current.stateRevision + 1;
            const next = { ...current.config, state_revision: nextRevision, active_scale_up: ({
                    ...reservation, phase: 'effects', state_revision: nextRevision, updated_at: new Date().toISOString(),
                }) };
            if (!await saveScaleUpConfig(next, current.stateRevision))
                return false;
            config = next;
            configRevision = nextRevision;
            return true;
        });
        const assertScaleUpEffectsAuthority = async () => withTeamInstanceLifecycleLock(leaderCwd, sanitized, async () => {
            const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
            const reservation = current ? scaleUpAttempt(current.config) : undefined;
            if (!current || !reservation || reservation.operation_id !== operationId
                || reservation.phase !== 'effects'
                || reservation.pid !== process.pid || reservation.process_started_at !== processStartedAt)
                return false;
            try {
                await assertScalingInstanceUnderLock(current.config, sanitized, leaderCwd, originalInstanceId);
            }
            catch {
                return false;
            }
            const reservationInstanceId = reservation.instance_id;
            if (!reservationInstanceId)
                return false;
            return reservationInstanceId.toLowerCase() === originalInstanceId.toLowerCase();
        }).catch(() => false);
        if (!await reserveScaleUpEffects().catch(() => false)) {
            const released = await releaseScaleUpReservation().catch(() => false);
            return { ok: false, error: released ? 'team_mutation_busy' : 'scale_up_fence_release_failed' };
        }
        const teamStateRoot = config.team_state_root ?? resolveTeamStateRoot(leaderCwd, sanitized);
        const worktreeMode = config.worktree_mode ?? 'disabled';
        // Resolve the monotonic worker index counter
        let nextIndex = config.next_worker_index ?? (currentCount + 1);
        const addedWorkers = [];
        const pendingWorktrees = [];
        const pendingIdentities = new Set();
        const reservedWorkerNames = new Set();
        const reservedLaunchDescriptors = new Map();
        const launchContexts = new Map();
        const unresolvedLaunchPanes = new Set();
        const paneWorkerNames = new Map();
        const pendingPanes = new Map();
        const paneOwnerships = new Map();
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
            let authorityFailure;
            try {
                await withTeamInstanceLifecycleLock(leaderCwd, sanitized, async () => {
                    const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
                    const reservation = current ? scaleUpAttempt(current.config) : undefined;
                    if (!current || !reservation || reservation.operation_id !== operationId
                        || reservation.pid !== process.pid || reservation.process_started_at !== processStartedAt) {
                        throw new Error('scale_up_instance_fence_lost');
                    }
                    await assertScalingInstanceUnderLock(current.config, sanitized, leaderCwd, originalInstanceId);
                    const reservationInstanceId = reservation.instance_id;
                    if (!reservationInstanceId
                        || reservationInstanceId.toLowerCase() !== originalInstanceId.toLowerCase()) {
                        throw new Error('team_instance_mismatch');
                    }
                });
            }
            catch (authorityError) {
                authorityFailure = scaleInstanceError(authorityError);
            }
            if (authorityFailure) {
                // Do not infer ownership from pane/worktree names when the instance
                // authority disappeared or changed.  In particular, never clean a
                // replacement team's resources during rollback.
                return {
                    ok: false,
                    error: `${error}; rollback incomplete (instance_authority_unverified:${authorityFailure})`,
                };
            }
            const cleanedWorktrees = new Set();
            // Preserve launch/termination evidence when provider/pane cleanup is not proven.
            const preserveIdentity = new Set();
            const cleanupPane = async (candidate, label, workerName) => {
                const launch = launchContexts.get(candidate);
                const launchCleanupUnverified = unresolvedLaunchPanes.has(candidate);
                const ownership = paneOwnerships.get(candidate);
                const paneAlreadyDead = ownership
                    ? await getOwnedWorkerLiveness(ownership).catch(() => 'unknown') === 'dead'
                    : false;
                const attributableWorkerName = workerName ?? paneWorkerNames.get(candidate);
                const markPreserve = () => {
                    if (attributableWorkerName)
                        preserveIdentity.add(attributableWorkerName);
                    if (launch?.attempt?.worker_name)
                        preserveIdentity.add(String(launch.attempt.worker_name));
                };
                if (!ownership && !paneAlreadyDead) {
                    cleanupFailures.push(`${label}:pane_ownership_unverified:${candidate}`);
                    markPreserve();
                    return false;
                }
                if (launchCleanupUnverified && !launch) {
                    // Once an owned launch was attempted, pane state is not enough to
                    // authorize provider teardown. Preserve the pane and launch evidence
                    // until the provider boundary can be retried with its exact receipt.
                    cleanupFailures.push(`${label}:provider_launch_authority_unavailable:${candidate}`);
                    markPreserve();
                    return false;
                }
                ;
                const killPane = async () => {
                    if (ownership && await getOwnedWorkerLiveness(ownership).catch(() => 'unknown') === 'dead')
                        return true;
                    if (!ownership)
                        return false;
                    for (let attempt = 0; attempt < 2; attempt++) {
                        await killOwnedWorkerPane(ownership).catch(() => undefined);
                        if (await getOwnedWorkerLiveness(ownership).catch(() => 'unknown') === 'dead')
                            return true;
                    }
                    return false;
                };
                const cleaned = launch
                    ? await retireAndCleanupCurrentWorkerLaunchAttempt(launch.attempt, 'scale_up_rollback', killPane).catch(() => false)
                    : await killPane();
                if (cleaned)
                    return true;
                cleanupFailures.push(`${label}:${launch ? 'provider' : 'pane'}:${candidate}`);
                markPreserve();
                return false;
            };
            const cleanupIdentity = async (workerName) => {
                if (preserveIdentity.has(workerName))
                    return;
                const workerDir = absPath(leaderCwd, TeamPaths.workerDir(sanitized, workerName));
                for (let attempt = 0; attempt < 2 && existsSync(workerDir); attempt++) {
                    await rm(workerDir, { recursive: true, force: true }).catch(() => undefined);
                }
                if (existsSync(workerDir))
                    cleanupFailures.push(`${workerName}:identity:${workerDir}`);
            };
            // A launch may have created a durable provider receipt before its
            // wrapper rejects. Classify and attempt every such pane first, before
            // touching its worktree, receipt directory, or reserved worker row.
            for (const [pendingPaneId, pendingWorkerName] of pendingPanes) {
                await cleanupPane(pendingPaneId, pendingWorkerName, pendingWorkerName);
            }
            for (const worker of addedWorkers) {
                const idx = config.workers.findIndex(candidate => candidate.name === worker.name);
                if (worker.pane_id)
                    await cleanupPane(worker.pane_id, worker.name, worker.name);
                if (worker.worktree_path) {
                    if (preserveIdentity.has(worker.name)) {
                        cleanupFailures.push(`${worker.name}:worktree_authority_unverified:${worker.worktree_path}`);
                    }
                    else {
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
                }
                await cleanupIdentity(worker.name);
                if (idx >= 0 && !preserveIdentity.has(worker.name))
                    config.workers.splice(idx, 1);
            }
            for (const pending of pendingWorktrees) {
                if (preserveIdentity.has(pending.workerName)) {
                    cleanupFailures.push(`${pending.workerName}:pending_worktree_authority_unverified:${pending.path}`);
                }
                else if (!cleanedWorktrees.has(pending.workerName)) {
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
            if (paneId && !pendingPanes.has(paneId))
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
                        if (preserveIdentity.has(row.name)) {
                            cleanupFailures.push(`scale_up_reservation_preserved:${row.name}`);
                        }
                        else if (launchMatches && (row.operational_state === 'starting'
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
                    instance_id: originalInstanceId,
                    error, cleanup_failures: cleanupFailures, recorded_at: new Date().toISOString() }, null, 2));
                return { ok: false, error: `${error}; rollback incomplete (${cleanupFailures.join(', ')}) evidence=${evidencePath}` };
            }
            if (!await releaseScaleUpReservation())
                return { ok: false, error: `${error}; scale_up_fence_release_failed` };
            return { ok: false, error };
        };
        for (let i = 0; i < count; i++) {
            if (!await assertScaleUpEffectsAuthority()) {
                return await rollbackScaleUp('scale_up_instance_authority_lost');
            }
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
            const splitTargetError = await validateSplitTargetPaneInConfiguredSession(splitTarget, config.tmux_session, config.tmux_server_identity);
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
                const resolvedRoute = canonical === null ? undefined : config.resolved_routing?.[canonical];
                const hasLegacyConfiguredRoute = config.resolved_routing_roles === undefined && resolvedRoute !== undefined;
                const hasConfiguredRoute = canonical !== null
                    && (config.resolved_routing_roles?.includes(canonical) === true || hasLegacyConfiguredRoute);
                const routedPair = canonical && hasExplicitOwnedRole && (hasConfiguredRoute || workerAgentType === 'claude')
                    ? resolvedRoute
                    : undefined;
                if (routedPair) {
                    const { primary } = routedPair;
                    const primaryProvider = primary.provider;
                    if (CLI_AGENT_TYPES.has(primaryProvider)) {
                        workerAgentType = primaryProvider;
                        workerModel = primary.model;
                    }
                    if (!workerModel) {
                        const modelEnv = workerAgentType === 'claude' || config.external_models_defaults === undefined ? env : {};
                        workerModel = resolveDefaultWorkerModel(workerAgentType, modelEnv, config.external_models_defaults);
                    }
                }
                else {
                    // Honor provider-specific default-model resolution for non-routed workers.
                    const modelEnv = workerAgentType === 'claude' || config.external_models_defaults === undefined ? env : {};
                    workerModel = resolveDefaultWorkerModel(workerAgentType, modelEnv, config.external_models_defaults);
                }
                let launchBinary;
                try {
                    assertHeadlessSupported(workerAgentType);
                    clearResolvedPathCache();
                    launchBinary = resolveValidatedBinaryPath(workerAgentType);
                }
                catch (error) {
                    return await rollbackScaleUp(`Failed strict provider preflight for ${workerName} (${workerAgentType}): ${error instanceof Error ? error.message : String(error)}`);
                }
                pendingIdentities.add(workerName);
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
                let launchArgs;
                try {
                    const [, ...args] = buildWorkerArgv(workerAgentType, {
                        teamName: sanitized,
                        workerName,
                        cwd: workerCwd,
                        resolvedBinaryPath: launchBinary,
                        ...(workerModel ? { model: workerModel } : {}),
                    });
                    launchArgs = args;
                }
                catch (error) {
                    return await rollbackScaleUp(`Failed strict provider argv construction for ${workerName} (${workerAgentType}): ${error instanceof Error ? error.message : String(error)}`);
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
                // Allocate an empty pane through the guarded provider API so the exact
                // server incarnation remains bound from split through launch.
                const splitEvidence = await splitTeamWorkerPaneWithEvidence(splitTarget, splitDirection === '-h' ? 'right' : 'down', workerCwd, config.tmux_session.startsWith('cmux:') ? 'cmux' : 'tmux', config.tmux_server_identity);
                if (!splitEvidence.commandSucceeded) {
                    return await rollbackScaleUp(`Failed to create pane for ${workerName}: ${splitEvidence.stderr || 'split_unverified'}`);
                }
                const paneId = splitEvidence.paneId?.trim();
                if (!paneId || (splitEvidence.provider === 'tmux' && !paneId.startsWith('%'))) {
                    return await rollbackScaleUp(`Failed to capture pane ID for ${workerName}`, undefined, `unaddressable_spawned_pane:${splitEvidence.rawOutput.trim() || '<missing>'}`);
                }
                pendingPanes.set(paneId, workerName);
                paneWorkerNames.set(paneId, workerName);
                const ownershipResult = await adoptWorkerPaneOwnership({
                    provider: paneId.startsWith('%') ? 'tmux' : 'cmux',
                    providerTarget: config.tmux_session,
                    paneId,
                    leaderPaneId: config.leader_pane_id ?? '',
                    reservedPaneIds: config.workers.map(worker => worker.pane_id).filter((id) => Boolean(id)),
                    ...(config.tmux_server_identity
                        ? { tmuxServerIdentity: config.tmux_server_identity }
                        : {}),
                });
                if (!ownershipResult.ok) {
                    return await rollbackScaleUp(`Failed to prove pane ownership for ${workerName}: ${ownershipResult.reason}`, undefined, `unaddressable_spawned_pane:${paneId}`);
                }
                paneOwnerships.set(paneId, ownershipResult.ownership);
                let startupContext;
                try {
                    startupContext = await spawnOwnedWorkerInPane(config.tmux_session, ownershipResult.ownership, {
                        teamName: sanitized,
                        workerName,
                        instanceId: originalInstanceId,
                        envVars: extraEnv,
                        launchArgs: [...launchDescriptor.args],
                        launchBinary: launchDescriptor.binary,
                        cwd: workerCwd,
                        provider: workerAgentType,
                        launchBootstrapPath: resolveRuntimeCliPath(),
                        launchStateCwd: leaderCwd,
                        launchContext: { kind: 'initial' },
                        ...(ownershipResult.ownership.tmuxServerIdentity
                            ? { tmuxServerIdentity: ownershipResult.ownership.tmuxServerIdentity }
                            : {}),
                    });
                }
                catch (error) {
                    const launchError = error instanceof Error ? error.message : String(error);
                    if (launchError.startsWith('worker_launch_cleanup_unverified:')) {
                        unresolvedLaunchPanes.add(paneId);
                    }
                    return await rollbackScaleUp(`Failed durable worker launch for ${workerName}: ${launchError}`, paneId);
                }
                launchContexts.set(paneId, startupContext);
                // The starting reservation already persisted role and immutable launch identity.
                const workerInfo = {
                    name: workerName,
                    index: workerIndex,
                    role: workerRole,
                    assigned_tasks: [],
                    worker_cli: launchDescriptor.provider,
                    launch_descriptor: launchDescriptor,
                    operational_state: 'active',
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
                pendingPanes.delete(paneId);
                await teamWriteWorkerIdentity(sanitized, workerName, workerInfo, leaderCwd);
                // Wait for worker readiness
                const readyTimeoutMs = resolveWorkerReadyTimeoutMs(env);
                const skipReadyWait = env.OMC_TEAM_SKIP_READY_WAIT === '1';
                // tmux pane IDs are only meaningful on the captured server incarnation;
                // waitForPaneReady is an observational legacy helper without an
                // identity argument, so do not query tmux by pane ID here. The owned
                // launch protocol already proves provider startup; retain the legacy
                // readiness probe only for CMUX surfaces.
                if (!skipReadyWait && !paneId.startsWith('%')) {
                    try {
                        await waitForPaneReady(paneId, { timeoutMs: readyTimeoutMs, provider: workerAgentType });
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
        // Atomically commit workers AND transition the fence to 'committed'.
        // If the config write succeeds, the workers are durable and the fence
        // phase proves it. If the subsequent release fails, the 'committed'
        // phase is reconcilable — a later operation can safely clear it.
        const committedConfig = {
            ...withScaleUpFenceRevision(config, configRevision + 1),
            active_scale_up: { ...scaleUpAttempt(config), phase: 'committed',
                state_revision: configRevision + 1, updated_at: new Date().toISOString() },
        };
        try {
            const commitAuthority = await withTeamInstanceLifecycleLock(leaderCwd, sanitized, async () => {
                const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
                const reservation = current ? scaleUpAttempt(current.config) : undefined;
                if (!current || !reservation || reservation.operation_id !== operationId
                    || reservation.phase !== 'effects'
                    || reservation.pid !== process.pid || reservation.process_started_at !== processStartedAt)
                    return false;
                try {
                    await assertScalingInstanceUnderLock(current.config, sanitized, leaderCwd, originalInstanceId);
                }
                catch {
                    return false;
                }
                const reservationInstanceId = reservation.instance_id;
                if (!reservationInstanceId
                    || reservationInstanceId.toLowerCase() !== originalInstanceId.toLowerCase())
                    return false;
                return true;
            });
            if (!commitAuthority || !await saveScaleUpConfig(committedConfig, configRevision)) {
                return await rollbackScaleUp('Scale-up config commit lost its revision: stale_state_revision');
            }
            config = committedConfig;
            configRevision += 1;
        }
        catch (error) {
            return await rollbackScaleUp(`Scale-up config commit lost its revision: ${error instanceof Error ? error.message : String(error)}`);
        }
        // Workers are durably committed under the committed fence. Finalize services
        // WHILE the fence is still held so shutdown cannot race teardown, then release.
        await teamAppendEvent(sanitized, {
            type: 'team_leader_nudge',
            worker: 'leader-fixed',
            reason: `scale_up: added ${count} worker(s), new count=${config.worker_count}`,
        }, leaderCwd);
        let servicesSync = 'synced';
        // Re-read lifecycle under lock semantics: never restart services during shutdown.
        const postCommit = await readRevisionedTeamConfig(sanitized, leaderCwd);
        if (!postCommit || (postCommit.config.lifecycle_state && postCommit.config.lifecycle_state !== 'active')) {
            servicesSync = 'repair_required';
        }
        else {
            try {
                const { reconcileCommittedTeamServices } = await import('./runtime-v2.js');
                servicesSync = await reconcileCommittedTeamServices(postCommit.config, leaderCwd);
            }
            catch {
                servicesSync = 'repair_required';
            }
        }
        // Best-effort release after finalization. If release fails, the committed fence
        // remains reconcilable and does not block later ops once lifecycle is active.
        if (!await releaseScaleUpReservation()) {
            await releaseScaleUpReservation().catch(() => false);
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
        if (!loadedConfig.instance_id)
            return { ok: false, error: 'team_instance_authority_missing' };
        let originalInstanceId = loadedConfig.instance_id;
        if (loadedConfig.active_recovery || scaleUpFenceBlocks(loadedConfig))
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
        let operationId = randomUUID();
        let selectedNames = targetWorkers.map(worker => worker.name);
        const workerIdentity = (worker) => {
            const launchDescriptor = worker.launch_descriptor
                ? { ...worker.launch_descriptor, args: [...worker.launch_descriptor.args] }
                : undefined;
            return {
                name: worker.name,
                ...(worker.pane_id ? { pane_id: worker.pane_id } : {}),
                ...(worker.worktree_path ? { worktree_path: worker.worktree_path } : {}),
                ...(worker.worktree_created !== undefined ? { worktree_created: worker.worktree_created } : {}),
                ...(worker.launch_attempt_id ? { launch_attempt_id: worker.launch_attempt_id } : {}),
                ...(launchDescriptor?.provider || worker.worker_cli
                    ? { provider: launchDescriptor?.provider ?? worker.worker_cli } : {}),
                ...(launchDescriptor ? { launch_descriptor: launchDescriptor } : {}),
            };
        };
        const identitiesMatch = (workers, expected) => JSON.stringify(workers.map(workerIdentity)) === JSON.stringify(expected);
        try {
            config = await withTeamInstanceLifecycleLock(leaderCwd, sanitized, async () => {
                const current = await migrateTeamConfigRevision(sanitized, leaderCwd);
                if (current) {
                    const binding = await assertScalingInstanceUnderLock(current.config, sanitized, leaderCwd, originalInstanceId);
                    originalInstanceId = binding.instance_id;
                }
                if (!current || current.config.active_recovery || scaleUpFenceBlocks(current.config)
                    || current.config.lifecycle_state === 'shutting_down' || current.config.lifecycle_state === 'stopped') {
                    throw new Error('team_mutation_busy');
                }
                const existingScaleDown = current.config.active_scale_down;
                if (existingScaleDown
                    && (!existingScaleDown.instance_id
                        || existingScaleDown.instance_id.toLowerCase() !== originalInstanceId.toLowerCase())) {
                    throw new Error('team_mutation_busy');
                }
                // Reclaim/resume policy:
                // - draining + dead owner: replace with new draining (no effects started)
                // - failed + same/dead owner: RESUME the exact operation_id + workers (never retarget)
                // - effects (any owner): fail-closed
                let resumeFailed = null;
                if (existingScaleDown) {
                    const ownerDead = isProcessIdentityDead(existingScaleDown);
                    const processStartedAtProbe = currentProcessStartIdentity();
                    const sameOwner = Boolean(processStartedAtProbe)
                        && existingScaleDown.pid === process.pid
                        && existingScaleDown.process_started_at === processStartedAtProbe;
                    if (existingScaleDown.phase === 'failed' && (ownerDead || sameOwner)) {
                        resumeFailed = existingScaleDown;
                    }
                    else if (existingScaleDown.phase === 'draining' && ownerDead) {
                        // fall through to new reservation over dead draining
                    }
                    else {
                        throw new Error('team_mutation_busy');
                    }
                }
                const now = new Date().toISOString();
                const processStartedAt = currentProcessStartIdentity();
                if (!processStartedAt)
                    throw new Error('process_start_identity_unavailable');
                const nextRevision = current.stateRevision + 1;
                if (resumeFailed) {
                    // Resume exact failed transaction — same operation_id and worker set.
                    const resumeWorkers = resumeFailed.workers;
                    const selected = resumeWorkers.map(w => current.config.workers.find(worker => worker.name === w.name));
                    // Workers may still be present (cleanup incomplete) — required for discoverability.
                    if (selected.some((worker) => !worker)
                        || !identitiesMatch(selected, resumeWorkers))
                        throw new Error('team_mutation_busy');
                    const next = { ...current.config, state_revision: nextRevision,
                        ...(current.config.active_scale_up?.phase === 'committed' ? { active_scale_up: undefined } : {}),
                        active_scale_down: {
                            ...resumeFailed,
                            phase: 'draining',
                            pid: process.pid,
                            process_started_at: processStartedAt,
                            workers: resumeWorkers,
                            state_revision: nextRevision,
                            updated_at: now,
                            failure_reason: undefined,
                        },
                    };
                    // Same operation_id but possibly new pid (dead-owner adopt) => reclaim if owner changed.
                    const sameOpOwner = resumeFailed.pid === process.pid
                        && resumeFailed.process_started_at === processStartedAt;
                    if (!await saveTeamConfigAtRevision(next, current.stateRevision, leaderCwd, undefined, {
                        ...(sameOpOwner ? {} : { reclaim: { active_scale_down: true } }),
                        ...(next.active_scale_up === undefined && current.config.active_scale_up
                            ? { release: { active_scale_up: true } } : {}),
                    }))
                        throw new Error('team_mutation_busy');
                    return next;
                }
                const selected = selectedNames.map(name => current.config.workers.find(worker => worker.name === name));
                if (selected.some((worker) => !worker)
                    || !identitiesMatch(selected, targetWorkers.map(workerIdentity)))
                    throw new Error('team_mutation_busy');
                const next = { ...current.config, state_revision: nextRevision,
                    // Reconcile a committed scale-up fence: workers are provably
                    // durable, so clearing the fence is safe and idempotent.
                    ...(current.config.active_scale_up?.phase === 'committed' ? { active_scale_up: undefined } : {}),
                    active_scale_down: ({
                        operation_id: operationId, phase: 'draining', pid: process.pid,
                        instance_id: originalInstanceId,
                        process_started_at: processStartedAt, workers: selected.map(workerIdentity),
                        state_revision: nextRevision, created_at: now, updated_at: now,
                    }) };
                // New install or reclaim over dead draining.
                if (!await saveTeamConfigAtRevision(next, current.stateRevision, leaderCwd, undefined, {
                    ...(existingScaleDown ? { reclaim: { active_scale_down: true } } : {}),
                    ...(next.active_scale_up === undefined && current.config.active_scale_up
                        ? { release: { active_scale_up: true } } : {}),
                }))
                    throw new Error('team_mutation_busy');
                return next;
            });
        }
        catch (error) {
            return { ok: false, error: scaleInstanceError(error) };
        }
        // Bind cleanup authority to the durable fence (resume may retain a prior operation_id).
        const activeFence = config.active_scale_down;
        if (!activeFence)
            return { ok: false, error: 'team_mutation_busy' };
        if (!activeFence.instance_id
            || activeFence.instance_id.toLowerCase() !== originalInstanceId.toLowerCase()) {
            return { ok: false, error: 'team_mutation_busy' };
        }
        operationId = activeFence.operation_id;
        selectedNames = activeFence.workers.map(w => w.name);
        targetWorkers = selectedNames
            .map(name => config.workers.find(worker => worker.name === name))
            .filter(Boolean);
        if (targetWorkers.length !== selectedNames.length
            || !identitiesMatch(targetWorkers, activeFence.workers)) {
            return { ok: false, error: 'team_mutation_busy' };
        }
        const markScaleDownFailed = async (reason) => {
            let configMarkError;
            let authorityVerified = false;
            let authorityCheckFailed = false;
            try {
                await withTeamInstanceLifecycleLock(leaderCwd, sanitized, async () => {
                    const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
                    if (!current || current.config.active_scale_down?.operation_id !== operationId) {
                        authorityCheckFailed = true;
                        return;
                    }
                    await assertScalingInstanceUnderLock(current.config, sanitized, leaderCwd, originalInstanceId);
                    const currentAttempt = current.config.active_scale_down;
                    if (!currentAttempt?.instance_id
                        || currentAttempt.instance_id.toLowerCase() !== originalInstanceId.toLowerCase()
                        || !identitiesMatch(selectedNames.map(name => current.config.workers.find(worker => worker.name === name)).filter(Boolean), currentAttempt.workers)) {
                        authorityCheckFailed = true;
                        return;
                    }
                    authorityVerified = true;
                    const nextRevision = current.stateRevision + 1;
                    if (!await saveTeamConfigAtRevision({ ...current.config, state_revision: nextRevision, active_scale_down: ({
                            ...current.config.active_scale_down, phase: 'failed', failure_reason: reason,
                            state_revision: nextRevision, updated_at: new Date().toISOString(),
                        }) }, current.stateRevision, leaderCwd))
                        configMarkError = 'config_mark_cas_failed';
                });
            }
            catch (error) {
                authorityCheckFailed = true;
                configMarkError = scaleInstanceError(error);
            }
            // Never write failure evidence into a replacement state root after the
            // instance authority has disappeared or changed.
            if (!authorityVerified && authorityCheckFailed
                && configMarkError?.startsWith('team_instance_'))
                return;
            if (!authorityVerified && authorityCheckFailed && !configMarkError)
                return;
            const evidencePath = absPath(leaderCwd, TeamPaths.scalingRollbackFailure(sanitized, Date.now()));
            await writeAtomic(evidencePath, JSON.stringify({ schema_version: 1, operation: 'scale_down',
                operation_id: operationId, team_name: sanitized, instance_id: originalInstanceId, workers: selectedNames, reason,
                ...(configMarkError ? { config_mark_error: configMarkError } : {}),
                recorded_at: new Date().toISOString() }, null, 2));
        };
        const reserveEffects = async () => withTeamInstanceLifecycleLock(leaderCwd, sanitized, async () => {
            const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
            const reservation = current?.config.active_scale_down;
            if (!current || reservation?.operation_id !== operationId || current.config.active_recovery || scaleUpFenceBlocks(current.config)
                || reservation.phase !== 'draining'
                || reservation.pid !== process.pid || reservation.process_started_at !== currentProcessStartIdentity()
                || !identitiesMatch(selectedNames.map(name => current.config.workers.find(worker => worker.name === name)).filter(Boolean), reservation.workers))
                return false;
            try {
                await assertScalingInstanceUnderLock(current.config, sanitized, leaderCwd, originalInstanceId);
            }
            catch {
                return false;
            }
            if (!reservation.instance_id
                || reservation.instance_id.toLowerCase() !== originalInstanceId.toLowerCase())
                return false;
            const nextRevision = current.stateRevision + 1;
            const next = { ...current.config, state_revision: nextRevision, active_scale_down: ({
                    ...reservation, phase: 'effects', state_revision: nextRevision, updated_at: new Date().toISOString(),
                }) };
            if (!await saveTeamConfigAtRevision(next, current.stateRevision, leaderCwd))
                return false;
            config = next;
            targetWorkers = selectedNames.map(name => next.workers.find(worker => worker.name === name)).filter(Boolean);
            return true;
        });
        const assertScaleDownEffectsAuthority = async () => withTeamInstanceLifecycleLock(leaderCwd, sanitized, async () => {
            const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
            const reservation = current?.config.active_scale_down;
            if (!current || !reservation || reservation.operation_id !== operationId
                || reservation.phase !== 'effects'
                || reservation.pid !== process.pid
                || reservation.process_started_at !== currentProcessStartIdentity())
                return false;
            try {
                await assertScalingInstanceUnderLock(current.config, sanitized, leaderCwd, originalInstanceId);
            }
            catch {
                return false;
            }
            return Boolean(reservation.instance_id
                && reservation.instance_id.toLowerCase() === originalInstanceId.toLowerCase()
                && identitiesMatch(selectedNames.map(name => current.config.workers.find(worker => worker.name === name)).filter(Boolean), reservation.workers));
        }).catch(() => false);
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
                    const ownership = w.pane_id ? configuredPaneOwnership(config, w.pane_id, w.name) : null;
                    const liveness = ownership ? await getOwnedWorkerLiveness(ownership) : 'unknown';
                    return status.state === 'idle' || status.state === 'done' || liveness === 'dead';
                }));
                if (allDrained.every(Boolean))
                    break;
                await new Promise(r => setTimeout(r, 2_000));
            }
        }
        if (!await reserveEffects().catch(() => false)) {
            await markScaleDownFailed('scale_down_fence_lost_before_effects');
            return { ok: false, error: 'team_mutation_busy' };
        }
        // Phase 3: Retire and terminate each exact provider before destructive pane cleanup.
        for (const worker of targetWorkers) {
            const paneId = worker.pane_id;
            const provider = worker.launch_descriptor?.provider ?? worker.worker_cli;
            if (!provider || !worker.launch_attempt_id) {
                // A pane is not provider-death authority.  Missing or corrupt launch
                // receipts preserve the worker claim, pane, and worktree for a
                // retryable failed operation.
                const reason = `provider_cleanup_unverified:${worker.name}`;
                await markScaleDownFailed(reason);
                return { ok: false, error: reason };
            }
            const initialOwnership = configuredPaneOwnership(config, paneId, worker.name);
            const initialPaneLiveness = initialOwnership
                ? await getOwnedWorkerLiveness(initialOwnership)
                : 'unknown';
            let paneOwnership = null;
            if (initialPaneLiveness !== 'dead') {
                const ownershipResult = await adoptWorkerPaneOwnership({
                    provider: paneId.startsWith('%') ? 'tmux' : 'cmux',
                    providerTarget: config.tmux_session,
                    paneId,
                    leaderPaneId: config.leader_pane_id ?? '',
                    reservedPaneIds: config.workers
                        .filter(candidate => candidate.name !== worker.name)
                        .map(candidate => candidate.pane_id)
                        .filter((id) => Boolean(id)),
                    ...(config.tmux_server_identity
                        ? { tmuxServerIdentity: config.tmux_server_identity }
                        : {}),
                });
                if (!ownershipResult.ok) {
                    const reason = `pane_cleanup_failed:${worker.name}:${ownershipResult.reason}`;
                    await markScaleDownFailed(reason);
                    return { ok: false, error: reason };
                }
                paneOwnership = ownershipResult.ownership;
            }
            let attempt = null;
            try {
                attempt = await loadWorkerLaunchAttempt({
                    cwd: leaderCwd,
                    teamName: sanitized,
                    workerName: worker.name,
                    instanceId: originalInstanceId,
                    paneId,
                    provider,
                    attemptId: worker.launch_attempt_id,
                    runtimeCliPath: resolveRuntimeCliPath(),
                });
            }
            catch {
                // Malformed/unreadable receipts are not cleanup authority.
            }
            if (!attempt) {
                const reason = `provider_cleanup_unverified:${worker.name}`;
                await markScaleDownFailed(reason);
                return { ok: false, error: reason };
            }
            let paneCleanupError = null;
            let cleaned = false;
            try {
                cleaned = await retireAndCleanupCurrentWorkerLaunchAttempt(attempt, 'scale_down', async () => {
                    try {
                        let lastLiveness = paneOwnership
                            ? await getOwnedWorkerLiveness(paneOwnership)
                            : initialPaneLiveness;
                        if (lastLiveness === 'dead')
                            return true;
                        if (!paneOwnership)
                            return false;
                        for (let cleanupAttempt = 0; cleanupAttempt < 2; cleanupAttempt++) {
                            await killOwnedWorkerPane(paneOwnership);
                            lastLiveness = await getOwnedWorkerLiveness(paneOwnership);
                            if (lastLiveness === 'dead')
                                return true;
                        }
                        paneCleanupError = lastLiveness === 'alive' ? 'pane_still_alive' : 'pane_liveness_unknown';
                        return false;
                    }
                    catch (error) {
                        paneCleanupError = error instanceof Error ? error.message : String(error);
                        return false;
                    }
                });
            }
            catch {
                cleaned = false;
            }
            if (!cleaned) {
                const reason = paneCleanupError
                    ? `pane_cleanup_failed:${worker.name}:${paneCleanupError}`
                    : `provider_cleanup_unverified:${worker.name}`;
                await markScaleDownFailed(reason);
                return { ok: false, error: reason };
            }
        }
        if (!await assertScaleDownEffectsAuthority()) {
            await markScaleDownFailed('scale_down_instance_authority_lost_before_worktree_cleanup');
            return { ok: false, error: 'team_mutation_busy' };
        }
        const liveness = await Promise.all(targetWorkers.map(async (w) => {
            const ownership = w.pane_id ? configuredPaneOwnership(config, w.pane_id, w.name) : null;
            return [w.name, ownership ? await getOwnedWorkerLiveness(ownership) : 'unknown'];
        }));
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
        const committed = await withTeamInstanceLifecycleLock(leaderCwd, sanitized, async () => {
            const current = await readRevisionedTeamConfig(sanitized, leaderCwd);
            const reservation = current?.config.active_scale_down;
            if (!current || !reservation || reservation.operation_id !== operationId
                || reservation.phase !== 'effects'
                || reservation.pid !== process.pid
                || reservation.process_started_at !== currentProcessStartIdentity()
                || current.config.active_recovery || scaleUpFenceBlocks(current.config))
                return false;
            try {
                await assertScalingInstanceUnderLock(current.config, sanitized, leaderCwd, originalInstanceId);
            }
            catch {
                return false;
            }
            if (!reservation.instance_id
                || reservation.instance_id.toLowerCase() !== originalInstanceId.toLowerCase()
                || !identitiesMatch(selectedNames.map(name => current.config.workers.find(worker => worker.name === name)).filter(Boolean), reservation.workers))
                return false;
            const workers = current.config.workers.filter(worker => !removedSet.has(worker.name));
            const nextRevision = current.stateRevision + 1;
            const next = { ...current.config, workers, worker_count: workers.length, active_scale_down: undefined,
                state_revision: nextRevision };
            if (!await saveTeamConfigAtRevision(next, current.stateRevision, leaderCwd, undefined, {
                release: { active_scale_down: true },
            }))
                return false;
            config = next;
            return true;
        }).catch(() => false);
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