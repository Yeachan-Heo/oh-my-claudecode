/**
 * Event-driven team runtime v2 — replaces the polling watchdog from runtime.ts.
 *
 * Runtime selection:
 * - Default: v2 enabled
 * - Native CLI jobs reject the legacy opt-out before startup effects.
 * NO done.json polling. Completion is detected via:
 * - CLI API lifecycle transitions (claim-task, transition-task-status)
 * - Event-driven monitor snapshots
 * - Worker heartbeat/status files
 *
 * Preserves: sentinel gate, circuit breaker, failure sidecars.
 * Removes: done.json watchdog loop, sleep-based polling.
 *
 * Architecture mirrors runtime.ts: startTeam, monitorTeam, shutdownTeam,
 * assignTask, resumeTeam as discrete operations driven by the caller.
 */
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { link, lstat, mkdir, open, readdir, readFile, rm, unlink, writeFile } from 'fs/promises';
import { performance } from 'perf_hooks';
import { TeamPaths, absPath, teamStateRoot } from './state-paths.js';
import { getOmcRoot, validateSessionId } from '../lib/worktree-paths.js';
import { allocateTasksToWorkers } from './allocation-policy.js';
import { readTeamConfig, readWorkerStatus, readWorkerHeartbeat, writeShutdownRequest, readShutdownAck, writeWorkerInbox, saveTeamConfig, commitInitialTeamConfigUnderLock, readRevisionedTeamConfig, saveTeamConfigAtRevision, migrateTeamConfigRevision, withTeamConfigMutationLock, readTeamManifest, } from './monitor.js';
import { appendTeamEvent, emitMonitorDerivedEvents } from './events.js';
import { DEFAULT_TEAM_GOVERNANCE, DEFAULT_TEAM_TRANSPORT_POLICY, getConfigGovernance, } from './governance.js';
import { inferPhase } from './phase-controller.js';
import { ABSOLUTE_MAX_WORKERS, isValidTeamInstanceId, isValidTmuxServerIdentity } from './types.js';
import { validateTeamName } from './team-name.js';
import { TASK_ID_SAFE_PATTERN, WORKER_NAME_SAFE_PATTERN } from './contracts.js';
import { buildValidatedWorkerLaunchDescriptor, clearResolvedPathCache, validateWorkerLaunchDescriptor, resolveValidatedBinaryPath, getWorkerEnv as getModelWorkerEnv, isPromptModeAgent, getPromptModeArgs, resolveDefaultWorkerModel, resolveExternalModelsDefaults, assertHeadlessSupported, } from './model-contract.js';
import { createTeamSession, spawnOwnedWorkerInPane, deliverStartupInbox, probeStartupPaneActivity, retryStartupInboxSubmit, proveWorkerPaneOwnership, adoptWorkerPaneOwnership, getOwnedWorkerLiveness, captureOwnedTeamPane, workerPaneBelongsToOwnedProviderTarget, observeTmuxServerIdentity, killOwnedWorkerPane, verifyTeamTargetOwnership, observeTeamSessionTargetPresence, redactBoundedDiagnostic, killTeamSession, paneHasActiveTask, paneLooksReady, applyMainVerticalLayout, splitTeamWorkerPaneWithEvidence, TeamSessionCreationError, } from './tmux-session.js';
import { composeInitialInbox, ensureWorkerStateDir, writeWorkerOverlay, generateTriggerMessage, generatePromptModeStartupPrompt, renderRecoveryContinuationInstruction, renderCursorWorkerGuidance, } from './worker-bootstrap.js';
import { queueInboxInstruction } from './mcp-comm.js';
import { cleanupTeamWorktrees, inspectTeamWorktreeCleanupSafety, ensureWorkerWorktree, installWorktreeRootAgents, normalizeTeamWorktreeMode, } from './git-worktree.js';
import { formatOmcCliInvocation } from '../utils/omc-cli-rendering.js';
import { createSwallowedErrorLogger } from '../lib/swallowed-error.js';
import { CANONICAL_TEAM_ROLES } from '../shared/types.js';
import { loadConfig } from '../config/loader.js';
import { buildResolvedRoutingSnapshot, getRoleRoutingSpec } from './stage-router.js';
import { routeTaskToRole } from './role-router.js';
import { normalizeDelegationRole } from '../features/delegation-routing/types.js';
import { CONTRACT_ROLES, cliWorkerOutputFilePath, isCliWorkerOutputFilePath, parseCliWorkerVerdict, renderCliWorkerOutputContract, shouldInjectContract, } from './cli-worker-contract.js';
import { startMergeOrchestrator, recoverFromRestart, } from './merge-orchestrator.js';
import { ensureLeaderInbox, extendLeaderBootstrapPrompt, appendToLeaderInbox } from './leader-inbox.js';
import { execFileSync } from 'node:child_process';
import { isRuntimeV2Enabled } from './runtime-flags.js';
import { installCommitCadence, startFallbackPoller, uninstallCommitCadence, } from './worker-commit-cadence.js';
import { createHash, randomUUID } from 'node:crypto';
import { isMatchingRecoveryFinal, isSafeRecoveryRequestId, readRecoveryFinalState, readRecoveryOutcome, readRecoveryRequestReservation, readRecoveryResult, writeRecoveryFinal } from './recovery-request-store.js';
import { parseRecoveryIntent, resolveRuntimeCliPath, teamRecoveryState, } from './runtime-owner-client.js';
import { scaleUpFenceBlocks } from './scaling.js';
import { runRecoverySaga } from './recovery-saga.js';
import { readTaskRecoveryCheckpoint, selectTaskRecoveryCheckpoint } from './task-recovery-checkpoint.js';
import { withProcessIdentityFileLock } from './process-identity-lock.js';
import { teamAdoptRecoveryReservations, teamListTasks, teamMarkTaskCompleted, teamReadMonitorSnapshot, teamReadTask, teamRequeueRecoveredTask, teamTransitionTaskStatus, teamWriteMonitorSnapshot, normalizeTaskRecord, withTaskClaimLock, writeAtomic, } from './team-ops.js';
import { createTaskRecord, validateTaskDependencies } from './state/tasks.js';
function workerInstructionStateRoot(cwd, teamName) {
    return process.platform === 'win32' ? teamStateRoot(cwd, teamName) : '$OMC_TEAM_STATE_ROOT';
}
import { currentProcessStartIdentity, isProcessIdentityDead, publishOwnerEpoch, readLatestOwnerEpoch, requireOwnerFence, requireOwnerProcessIdentity } from './team-owner-epoch.js';
import { waitForRecoveryGateRecord } from './worker-activation-gate.js';
import { isWorkerLaunchAttemptCurrent, isWorkerLaunchAttemptAccepted, loadCurrentWorkerLaunchAttempt, loadWorkerLaunchAttempt, observeWorkerLaunchProvider, retireAndCleanupCurrentWorkerLaunchAttempt, withWorkerLaunchAttemptFence, } from './worker-launch-ack.js';
import { isProcessIdentityLive } from '../platform/process-utils.js';
import { activateTeamInstanceUnderLock, assertTeamInstanceUnderLock, buildTeamInstancePendingConfig, createTeamInstanceBinding, disposeTeamInstanceUnderLock, releaseFailedStartupReservationUnderLock, reserveTeamInstanceUnderLock, retryTeamInstanceDisposal, TeamInstanceError, withTeamInstanceLifecycleLock, } from './team-instance.js';
let runtimeOwnerRecoveryClient;
/** Runtime integration point; production may bind its owner client after startup. */
export function setRuntimeOwnerRecoveryClient(client) {
    runtimeOwnerRecoveryClient = client;
}
function hasRequiredRecoveryPaneIdentities(result) {
    if (result.outcome !== 'recovered' && result.outcome !== 'already_running')
        return true;
    return Boolean(result.newPaneId.trim())
        && (result.outcome !== 'recovered' || Boolean(result.oldPaneId?.trim()));
}
/** Queue recovery with the runtime owner; this process never runs the owner saga. */
export async function recoverDeadWorkerV2(teamName, cwd, { workerName, requestId = randomUUID(), instanceId: expectedInstanceId, timeoutMs = 180_000 }) {
    try {
        validateTeamName(teamName);
    }
    catch {
        return { outcome: 'failed', committed: false, error: 'invalid_input', requestId, recoveryId: '', teamName, workerName,
            updatedAt: new Date().toISOString(), message: 'teamName is invalid.' };
    }
    if (!cwd || !WORKER_NAME_SAFE_PATTERN.test(workerName) || !isSafeRecoveryRequestId(requestId) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 180_000 || timeoutMs > 300_000) {
        return { outcome: 'failed', committed: false, error: 'invalid_input', requestId, recoveryId: '', teamName, workerName,
            updatedAt: new Date().toISOString(), message: 'cwd, workerName, and requestId are required; timeoutMs must be an integer from 180000 through 300000.' };
    }
    let instanceId = expectedInstanceId;
    try {
        const requestReservationPath = absPath(cwd, TeamPaths.recoveryRequestPending(requestId));
        const existing = readRecoveryRequestReservation(cwd, requestId);
        if (!existing && existsSync(requestReservationPath)) {
            // A request ID that already has an unreadable reservation is not a fresh
            // by-name request. Never let the current config rebind that identity.
            throw new Error('invalid_persisted_state');
        }
        if (existing) {
            const existingInstanceId = existing.instance_id.toLowerCase();
            if (instanceId !== undefined && instanceId.toLowerCase() !== existingInstanceId) {
                return { outcome: 'failed', committed: false, error: 'recovery_attempt_conflict', requestId,
                    recoveryId: existing.recovery_id, teamName, workerName, updatedAt: new Date().toISOString(),
                    message: 'Request ID is already bound to a different team instance.' };
            }
            // Existing request IDs retain their durable incarnation even after the
            // canonical team name has been replaced. Never resolve the current
            // config for this replay.
            instanceId = existingInstanceId;
        }
        else if (instanceId === undefined) {
            // A fresh by-name request may intentionally target the current team, but
            // resolve that identity while holding the canonical lifecycle lock.
            const resolved = await withTeamInstanceLifecycleLock(cwd, teamName, async () => {
                const state = await teamRecoveryState(cwd, teamName);
                if (state !== 'v2')
                    throw new Error(state);
                const current = await readRevisionedTeamConfig(teamName, cwd);
                if (!current?.config.instance_id)
                    throw new Error('team_instance_authority_missing');
                return current.config.instance_id;
            });
            instanceId = resolved;
        }
        if (instanceId === undefined)
            throw new Error('team_instance_authority_missing');
        // Validate the explicit/current binding before constructing the owner
        // input. Admission performs the authoritative under-lock assertion.
        createTeamInstanceBinding({ teamName, cwd, instanceId });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const errorCode = message === 'team_not_found'
            ? 'team_not_found'
            : message === 'runtime_v2_required'
                ? 'runtime_v2_required'
                : 'invalid_persisted_state';
        return { outcome: 'failed', committed: false, error: errorCode, requestId,
            recoveryId: '', teamName, workerName, updatedAt: new Date().toISOString(),
            message };
    }
    const ownerInput = { requestId, cwd, teamName, workerName, instanceId, timeoutMs };
    const client = runtimeOwnerRecoveryClient ?? {
        requestRuntimeOwnerRecovery: (input) => import('./runtime-owner-client.js').then(module => module.requestRuntimeOwnerRecovery(input)),
    };
    const result = await client.requestRuntimeOwnerRecovery(ownerInput);
    if (hasRequiredRecoveryPaneIdentities(result))
        return result;
    return {
        outcome: 'failed', committed: false, error: 'invalid_persisted_state',
        requestId: result.requestId, recoveryId: result.recoveryId, teamName: result.teamName, workerName: result.workerName,
        updatedAt: new Date().toISOString(), message: 'Recovery success result omitted a required actual pane identity.',
    };
}
/** Reads only the canonical durable terminal result for a request. */
export async function readRecoverDeadWorkerV2Result(requestId, cwd = process.cwd()) {
    const result = readRecoveryResult(cwd, requestId);
    return !result || hasRequiredRecoveryPaneIdentities(result) ? result : null;
}
/** Compatibility/internal reader that may return an in-progress durable outcome. */
export function readRecoverDeadWorkerV2Outcome(cwd, requestId) {
    return readRecoveryOutcome(cwd, requestId);
}
// ---------------------------------------------------------------------------
// In-process orchestrator registry (per-team handle for the lifetime of the
// runtime-cli process). Lives at module scope so shutdownTeamV2 can find it.
// ---------------------------------------------------------------------------
const orchestratorByTeam = new Map();
const cadenceByTeam = new Map();
function registerTeamOrchestrator(teamName, handle, service) {
    orchestratorByTeam.set(teamName, { handle, ...service, registeredWorkers: new Set() });
}
function getTeamOrchestrator(teamName) {
    return orchestratorByTeam.get(teamName)?.handle;
}
function unregisterTeamOrchestrator(teamName) {
    orchestratorByTeam.delete(teamName);
}
function registerTeamCadence(teamName, context, poller) {
    const entry = cadenceByTeam.get(teamName) ?? { entries: [] };
    entry.entries.push({ workerName: context.workerName, context, poller });
    cadenceByTeam.set(teamName, entry);
}
async function stopTeamCadence(teamName, strict = false) {
    const entry = cadenceByTeam.get(teamName);
    if (!entry)
        return;
    cadenceByTeam.delete(teamName);
    const failedEntries = [];
    for (const cadence of entry.entries) {
        let poller = cadence.poller;
        let context = cadence.context;
        if (poller) {
            try {
                poller.stop();
                poller = undefined;
            }
            catch { /* retain for retry */ }
        }
        if (context) {
            try {
                await uninstallCommitCadence(context);
                context = undefined;
            }
            catch { /* retain for retry */ }
        }
        if (poller || context)
            failedEntries.push({ workerName: cadence.workerName, poller, context });
    }
    if (failedEntries.length > 0) {
        cadenceByTeam.set(teamName, { entries: failedEntries });
        if (strict)
            throw new Error('service_teardown_incomplete');
    }
}
function cadenceContextMatches(candidate, expected) {
    const known = candidate.context;
    if (!known)
        return false;
    return candidate.workerName === expected.workerName
        && known.teamName === expected.teamName && known.worktreePath === expected.worktreePath
        && known.agentType === expected.agentType && known.serviceGeneration === expected.serviceGeneration
        && known.attemptId === expected.attemptId;
}
async function removeStaleTeamCadence(teamName, expectedContexts) {
    const entry = cadenceByTeam.get(teamName);
    if (!entry)
        return true;
    const retained = [];
    const matched = new Set();
    let converged = true;
    for (const cadence of entry.entries) {
        const expected = expectedContexts.find(context => context.workerName === cadence.workerName);
        const isExpected = expected && !matched.has(expected.workerName) && cadenceContextMatches(cadence, expected);
        if (isExpected) {
            matched.add(expected.workerName);
            retained.push(cadence);
            continue;
        }
        let poller = cadence.poller;
        let context = cadence.context;
        if (poller) {
            try {
                poller.stop();
                poller = undefined;
            }
            catch {
                converged = false;
            }
        }
        if (context) {
            try {
                await uninstallCommitCadence(context);
                context = undefined;
            }
            catch {
                converged = false;
            }
        }
        if (poller || context)
            retained.push({ workerName: cadence.workerName, poller, context });
    }
    if (retained.length > 0)
        cadenceByTeam.set(teamName, { entries: retained });
    else
        cadenceByTeam.delete(teamName);
    return converged;
}
export async function reconcileCommittedTeamServices(config, cwd) {
    // Only truly active (non-committed) scale-up fences block service repair.
    // A lingering phase=committed fence is reconcilable and must not wedge recovery/services.
    if (scaleUpFenceBlocks(config))
        return 'repair_required';
    /** Re-read authoritative lifecycle; abort service side effects if shutdown owns the team. */
    const assertLifecycleStillActive = async () => {
        const latest = await readRevisionedTeamConfig(config.name, cwd).catch(() => null);
        if (!latest)
            return false;
        const life = latest.config.lifecycle_state ?? 'active';
        return life === 'active';
    };
    if (!await assertLifecycleStillActive())
        return 'repair_required';
    const descriptor = config.service_descriptor;
    if (!descriptor || descriptor.schema_version !== 1 || !Number.isSafeInteger(descriptor.service_generation)
        || descriptor.service_generation < 1 || !descriptor.service_attempt_id || !descriptor.workspace_root)
        return 'repair_required';
    if (!descriptor.auto_merge_enabled) {
        if (descriptor.cadence_policy !== 'disabled')
            return 'repair_required';
        const localService = orchestratorByTeam.get(config.name);
        try {
            if (localService)
                await localService.handle.drainAndStop();
            await stopTeamCadence(config.name, true);
            unregisterTeamOrchestrator(config.name);
            return 'synced';
        }
        catch {
            return 'repair_required';
        }
    }
    if (descriptor.cadence_policy !== 'worker-auto-commit-v1' || !descriptor.leader_branch || config.worktree_mode !== 'named')
        return 'repair_required';
    try {
        for (const worker of config.workers) {
            const launch = validateWorkerLaunchDescriptor(worker.launch_descriptor);
            if (worker.worker_cli !== launch.provider || !worker.worktree_path)
                return 'repair_required';
        }
        const localService = orchestratorByTeam.get(config.name);
        if (localService && (localService.serviceGeneration !== descriptor.service_generation
            || localService.serviceAttemptId !== descriptor.service_attempt_id)) {
            await localService.handle.drainAndStop();
            await stopTeamCadence(config.name, true);
            unregisterTeamOrchestrator(config.name);
        }
        let orchestrator = getTeamOrchestrator(config.name);
        if (!orchestrator) {
            // Re-check lifecycle immediately before starting services (stale active snapshot race).
            if (!await assertLifecycleStillActive())
                return 'repair_required';
            orchestrator = await startMergeOrchestrator({ teamName: config.name, repoRoot: descriptor.workspace_root,
                leaderBranch: descriptor.leader_branch, cwd, serviceGeneration: descriptor.service_generation,
                serviceAttemptId: descriptor.service_attempt_id });
            registerTeamOrchestrator(config.name, orchestrator, { serviceGeneration: descriptor.service_generation,
                serviceAttemptId: descriptor.service_attempt_id });
        }
        const local = orchestratorByTeam.get(config.name);
        if (!local)
            return 'repair_required';
        const expectedContexts = config.workers.map(worker => {
            const launch = validateWorkerLaunchDescriptor(worker.launch_descriptor);
            return {
                teamName: config.name, workerName: worker.name, worktreePath: worker.worktree_path,
                agentType: launch.provider, enabled: true, serviceGeneration: descriptor.service_generation,
                attemptId: descriptor.service_attempt_id,
            };
        });
        const expectedWorkers = new Set(config.workers.map(worker => worker.name));
        let staleOrchestratorRemovalFailed = false;
        for (const workerName of [...local.registeredWorkers]) {
            if (expectedWorkers.has(workerName))
                continue;
            try {
                await orchestrator.unregisterWorker(workerName);
                local.registeredWorkers.delete(workerName);
            }
            catch {
                staleOrchestratorRemovalFailed = true;
            }
        }
        const cadenceRemovalsConverged = await removeStaleTeamCadence(config.name, expectedContexts);
        for (const worker of config.workers) {
            if (!local.registeredWorkers.has(worker.name)) {
                await orchestrator.registerWorker(worker.name);
                local.registeredWorkers.add(worker.name);
            }
        }
        const cadence = cadenceByTeam.get(config.name);
        for (const context of expectedContexts) {
            const installed = cadence?.entries.some(candidate => cadenceContextMatches(candidate, context));
            if (installed)
                continue;
            if (!await assertLifecycleStillActive())
                return 'repair_required';
            const installedCadence = await installCommitCadence(context);
            registerTeamCadence(config.name, context, installedCadence.method === 'fallback-poll' ? startFallbackPoller(context.worktreePath, context.workerName) : undefined);
        }
        const finalCadence = cadenceByTeam.get(config.name);
        const exactCadence = (finalCadence?.entries.length ?? 0) === expectedContexts.length
            && expectedContexts.every(context => finalCadence?.entries.some(candidate => cadenceContextMatches(candidate, context)));
        return cadenceRemovalsConverged && !staleOrchestratorRemovalFailed
            && exactCadence && local.registeredWorkers.size === expectedWorkers.size
            && [...expectedWorkers].every(workerName => local.registeredWorkers.has(workerName)) ? 'synced' : 'repair_required';
    }
    catch {
        return 'repair_required';
    }
}
/**
 * Resolve the leader's current branch via `git branch --show-current` from cwd.
 * Throws if not a git repo or HEAD is detached.
 */
function resolveLeaderBranch(cwd) {
    const out = execFileSync('git', ['branch', '--show-current'], {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    }).trim();
    if (!out) {
        throw new Error('auto-merge requires a non-detached leader branch (git branch --show-current returned empty)');
    }
    return out;
}
// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------
export { isRuntimeV2Enabled } from './runtime-flags.js';
const MONITOR_SIGNAL_STALE_MS = 30_000;
// ---------------------------------------------------------------------------
// Helper: sanitize team name
// ---------------------------------------------------------------------------
/**
 * Resolve a per-task routing assignment from the team's routing snapshot.
 *
 * Resolution order:
 *   1. Explicit `task.role` (if present) → normalize alias → snapshot lookup.
 *   2. `routeTaskToRole(subject, description, fallbackRole)` intent inference.
 *   3. Fallback to the `fallbackAgent` round-robin pick if snapshot lookup
 *      fails (role outside canonical vocabulary or snapshot missing).
 *
 * Returns the authoritative primary assignment for the selected route.
 * A missing provider binary is a startup error; routing never changes
 * providers implicitly.
 */
export function resolveTaskAssignment(task, resolvedRouting, roleRoutingConfig, fallbackAgent) {
    const canonicalRoles = new Set(CANONICAL_TEAM_ROLES);
    const hasExplicitRole = typeof task.role === 'string' && task.role.length > 0;
    const rawRole = hasExplicitRole
        ? task.role
        : routeTaskToRole(task.subject, task.description, 'executor').role;
    const normalized = normalizeDelegationRole(rawRole);
    const canonical = canonicalRoles.has(normalized) ? normalized : null;
    if (!canonical) {
        return { agentType: fallbackAgent, model: '', role: null };
    }
    // Snapshot routing only overrides the caller's CLI agentType when the user
    // has explicitly opted in — either by setting `task.role` or by configuring
    // `team.roleRouting[<canonicalRole>]` in PluginConfig. This preserves the
    // pre-patch contract: `/team N:codex ...` stays on codex when config has no
    // per-role routing, even if the task text incidentally mentions "reviewer".
    const hasConfigForRole = !!getRoleRoutingSpec(roleRoutingConfig, canonical);
    if (!hasExplicitRole && !hasConfigForRole) {
        return { agentType: fallbackAgent, model: '', role: canonical };
    }
    // Explicit provider + explicit role with NO per-role routing config: the user
    // named the provider directly on the worker spec (e.g. `1:antigravity:executor`
    // or `1:gemini:reviewer`), so honor that provider and treat the role as the
    // prompt role, not a routing key. Without this, an explicit role would always
    // opt into resolved_routing, whose default executor primary is Claude — silently
    // launching Claude instead of the requested CLI provider. When `team.roleRouting`
    // *is* configured for the role, that deliberate config still wins (below).
    if (hasExplicitRole && !hasConfigForRole && fallbackAgent !== 'claude') {
        return { agentType: fallbackAgent, model: '', role: canonical };
    }
    const pair = resolvedRouting[canonical];
    if (!pair) {
        return { agentType: fallbackAgent, model: '', role: canonical };
    }
    // A routed provider is authoritative. Missing or untrusted binaries fail later
    // before any worker launch instead of silently changing provider identity.
    const chosen = pair.primary;
    return {
        agentType: chosen.provider,
        model: chosen.model,
        role: canonical,
    };
}
function sanitizeTeamName(name) {
    const sanitized = name.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
    if (!sanitized)
        throw new Error(`Invalid team name: "${name}" produces empty slug after sanitization`);
    return sanitized;
}
function resolvePreflightBinaryPath(agentType) {
    assertHeadlessSupported(agentType);
    clearResolvedPathCache();
    return { path: resolveValidatedBinaryPath(agentType) };
}
// ---------------------------------------------------------------------------
// Helper: retain the original pane ownership binding
// ---------------------------------------------------------------------------
function tmuxServerIdentityForTarget(providerTarget, identity) {
    if (providerTarget.startsWith('cmux:'))
        return undefined;
    if (!isValidTmuxServerIdentity(identity))
        return undefined;
    return identity;
}
function requireTmuxServerIdentity(providerTarget, identity) {
    if (providerTarget.startsWith('cmux:'))
        return undefined;
    if (!isValidTmuxServerIdentity(identity))
        throw new Error('tmux_server_identity_missing');
    return identity;
}
function configuredPaneOwnership(config, worker) {
    const paneId = worker.pane_id;
    const providerTarget = config.tmux_session;
    if (!paneId || !providerTarget)
        return null;
    const provider = paneId.startsWith('%') ? 'tmux' : 'cmux';
    const identity = provider === 'tmux'
        ? tmuxServerIdentityForTarget(providerTarget, config.tmux_server_identity)
        : undefined;
    if (provider === 'tmux' && !identity)
        return null;
    return {
        provider,
        providerTarget,
        paneId,
        splitTarget: '',
        leaderPaneId: config.leader_pane_id ?? '',
        reservedPaneIds: config.workers
            .filter(candidate => candidate.pane_id && candidate.pane_id !== paneId)
            .map(candidate => candidate.pane_id),
        source: 'adopted',
        ...(identity ? { tmuxServerIdentity: identity } : {}),
    };
}
/**
 * Read provider execution health from the exact launch receipt.  A missing or
 * malformed attempt is deliberately unknown; pane liveness is not a provider
 * termination proof.
 */
async function getWorkerProviderLiveness(teamName, cwd, instanceId, worker) {
    if (!instanceId || !worker.pane_id || !worker.launch_attempt_id)
        return 'unknown';
    const provider = worker.launch_descriptor?.provider ?? worker.worker_cli;
    if (!provider)
        return 'unknown';
    const attempt = await loadWorkerLaunchAttempt({
        cwd,
        teamName,
        instanceId,
        workerName: worker.name,
        paneId: worker.pane_id,
        provider,
        attemptId: worker.launch_attempt_id,
        runtimeCliPath: resolveRuntimeCliPath(),
    }).catch(() => null);
    if (!attempt)
        return 'unknown';
    return observeWorkerLaunchProvider(attempt);
}
/**
 * Recovery only treats a positively dead provider as dead.  A live provider
 * remains protected even when its pane has disappeared, and unknown evidence
 * never authorizes replacement.
 */
async function getWorkerExecutionLiveness(teamName, cwd, instanceId, worker) {
    const providerLiveness = await getWorkerProviderLiveness(teamName, cwd, instanceId, worker);
    return providerLiveness;
}
function isTeamInstanceBoundaryError(error) {
    const code = error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    const message = error instanceof Error ? error.message : String(error);
    return (typeof code === 'string' && code.startsWith('team_instance_'))
        || message.startsWith('team_instance_');
}
function isFreshTimestamp(value, maxAgeMs = MONITOR_SIGNAL_STALE_MS) {
    if (!value)
        return false;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed))
        return false;
    return Date.now() - parsed <= maxAgeMs;
}
function findOutstandingWorkerTask(worker, taskById, inProgressByOwner) {
    if (typeof worker.assigned_tasks === 'object') {
        for (const taskId of worker.assigned_tasks) {
            const task = taskById.get(taskId);
            if (task && (task.status === 'pending' || task.status === 'in_progress')) {
                return task;
            }
        }
    }
    const owned = inProgressByOwner.get(worker.name) ?? [];
    return owned[0] ?? null;
}
function getTaskDependencyIds(task) {
    return task.depends_on ?? task.blocked_by ?? [];
}
function getMissingDependencyIds(task, taskById) {
    return getTaskDependencyIds(task).filter((dependencyId) => !taskById.has(dependencyId));
}
function taskInputDependencyIds(task, taskIndex) {
    return [...validateTaskDependencies({ ...task, id: String(taskIndex + 1) })];
}
/**
 * Validate the complete initial task graph before creating team state,
 * worktrees, panes, or provider launch attempts.
 */
function validateStartTaskDependencies(tasks) {
    const dependencyByIndex = new Map();
    const taskCount = tasks.length;
    for (let index = 0; index < taskCount; index++) {
        const task = tasks[index];
        if (!task || typeof task !== 'object')
            throw new Error('invalid_task_dependencies');
        const dependencies = taskInputDependencyIds(task, index);
        for (const dependencyId of dependencies) {
            const dependencyIndex = Number(dependencyId) - 1;
            if (!Number.isSafeInteger(dependencyIndex) || dependencyIndex < 0 || dependencyIndex >= taskCount) {
                throw new Error(`invalid_task_dependency:task-${index + 1}:${dependencyId}`);
            }
        }
        dependencyByIndex.set(index, dependencies);
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = (index) => {
        if (visiting.has(index))
            throw new Error(`cyclic_task_dependency:task-${index + 1}`);
        if (visited.has(index))
            return;
        visiting.add(index);
        for (const dependencyId of dependencyByIndex.get(index) ?? [])
            visit(Number(dependencyId) - 1);
        visiting.delete(index);
        visited.add(index);
    };
    for (let index = 0; index < taskCount; index++)
        visit(index);
    return dependencyByIndex;
}
// ---------------------------------------------------------------------------
// V2 task instruction builder — CLI API lifecycle, NO done.json
// ---------------------------------------------------------------------------
/**
 * Build the initial task instruction for v2 workers.
 * Workers use `omc team api` CLI commands for all lifecycle transitions.
 */
function buildV2TaskInstruction(teamName, workerName, task, taskId, agentType, cliOutputContract) {
    const claimTaskCommand = formatOmcCliInvocation(`team api claim-task --input '${JSON.stringify({ team_name: teamName, task_id: taskId, worker: workerName })}' --json`, {});
    const completeTaskCommand = formatOmcCliInvocation(`team api transition-task-status --input '${JSON.stringify({ team_name: teamName, task_id: taskId, from: 'in_progress', to: 'completed', claim_token: '<claim_token>', result: 'Summary: <what changed>\\nVerification: <tests/checks run>\\nSubagent skip reason: worker protocol forbids nested subagents; completed focused probe in-session' })}' --json`);
    const failTaskCommand = formatOmcCliInvocation(`team api transition-task-status --input '${JSON.stringify({ team_name: teamName, task_id: taskId, from: 'in_progress', to: 'failed', claim_token: '<claim_token>' })}' --json`);
    const cursorReviewer = agentType === 'cursor' && Boolean(cliOutputContract);
    const lifecycleInstructions = cursorReviewer
        ? [
            `3. Write the structured verdict from the trusted reviewer contract below when the review is complete.`,
            `4. ACK/progress replies are not a stop signal. Keep the Cursor session alive for further mailbox instructions; the leader transitions this task after consuming the verdict.`,
        ]
        : [
            `3. On completion (use claim_token from step 1):`,
            `   ${completeTaskCommand}`,
            `   The result field is required for completion evidence. For broad delegated tasks, include either "Subagent skip reason: <why no nested worker was needed/allowed>" or, only when explicitly allowed by the leader, "Subagent spawn evidence: <child task names/thread ids and integrated findings>".`,
            `4. On failure (use claim_token from step 1):`,
            `   ${failTaskCommand}`,
            `5. ACK/progress replies are not a stop signal. Keep executing your assigned or next feasible work until the task is actually complete or failed, then transition and exit.`,
        ];
    return [
        `## REQUIRED: Task Lifecycle Commands`,
        `You MUST run these commands. Do NOT skip any step.`,
        ``,
        `1. Claim your task:`,
        `   ${claimTaskCommand}`,
        `   Save the claim_token from the response.`,
        `2. Do the work described below.`,
        ...lifecycleInstructions,
        ``,
        `## Task Assignment`,
        `Task ID: ${taskId}`,
        `Worker: ${workerName}`,
        `Subject: ${task.subject}`,
        ``,
        task.description,
        ``,
        cursorReviewer
            ? `REMINDER: Write the verdict before yielding the review turn. Do NOT run transition-task-status or write done.json; the leader owns the terminal transition.`
            : `REMINDER: You MUST run transition-task-status before exiting. Do NOT write done.json or edit task files directly.`,
        ...(agentType === 'cursor' ? [renderCursorWorkerGuidance(Boolean(cliOutputContract))] : []),
        ...(cliOutputContract ? [cliOutputContract] : []),
    ].join('\n');
}
function workerTaskStartupFingerprint(task) {
    return JSON.stringify({
        owner: task.owner ?? null,
        status: task.status,
        version: task.version ?? null,
        claimOwner: task.claim?.owner ?? null,
        claimToken: task.claim?.token ?? null,
        claimLaunchAttemptId: task.claim?.launch_attempt_id ?? null,
    });
}
function workerStatusStartupFingerprint(status) {
    return JSON.stringify({
        state: status.state,
        currentTaskId: status.current_task_id ?? null,
        reason: status.reason ?? null,
        updatedAt: status.updated_at,
        launchAttemptId: status.launch_attempt_id ?? null,
    });
}
function hasWorkerStatusProgress(status, taskId) {
    if (status.current_task_id === taskId)
        return true;
    return ['working', 'blocked', 'done', 'failed'].includes(status.state);
}
async function readWorkerStartupTask(teamName, taskId, cwd) {
    try {
        return JSON.parse(await readFile(absPath(cwd, TeamPaths.taskFile(teamName, taskId)), 'utf-8'));
    }
    catch {
        return null;
    }
}
async function captureWorkerStartupBaseline(teamName, workerName, taskId, cwd) {
    const [task, status] = await Promise.all([
        readWorkerStartupTask(teamName, taskId, cwd),
        readWorkerStatus(teamName, workerName, cwd),
    ]);
    return {
        taskFingerprint: task ? workerTaskStartupFingerprint(task) : null,
        statusFingerprint: workerStatusStartupFingerprint(status),
    };
}
async function hasCurrentWorkerStartupEvidence(teamName, workerName, taskId, cwd, baseline, launchAttemptId) {
    const [task, status] = await Promise.all([
        readWorkerStartupTask(teamName, taskId, cwd),
        readWorkerStatus(teamName, workerName, cwd),
    ]);
    const currentClaim = Boolean(task
        && task.owner === workerName
        && ['in_progress', 'completed', 'failed'].includes(task.status)
        && task.claim?.launch_attempt_id === launchAttemptId
        && workerTaskStartupFingerprint(task) !== baseline.taskFingerprint);
    const currentStatus = status.current_task_id === taskId
        && ['working', 'blocked', 'done', 'failed'].includes(status.state)
        && status.launch_attempt_id === launchAttemptId
        && workerStatusStartupFingerprint(status) !== baseline.statusFingerprint;
    return currentClaim || currentStatus;
}
const WORKER_STARTUP_EVIDENCE_POLL_INTERVAL_MS = 250;
const WORKER_STARTUP_EVIDENCE_POLICIES = {
    // Claude's interactive transport can lose a submit, so retain the existing
    // bounded resubmit behavior and its effective 6 + (4 * 12) poll windows.
    // An engaged pane (issue #3849: WSL2 cold starts publish first-turn claim
    // evidence well after the initial budget) gets one bounded read-only recheck
    // before teardown; idle, wrong, or dead panes keep the fast fail-closed path.
    claude: {
        initialBudgetMs: 1_250,
        finalRecheckBudgetMs: 0,
        resubmitAttempts: 4,
        resubmitBudgetMs: 2_750,
        engagedPaneRecheckBudgetMs: 30_000,
    },
    // External providers can be visibly ready before they publish task/status
    // evidence. Give that distinct evidence gate enough time for a cold start,
    // then perform one bounded read-only recheck without duplicating the inbox.
    gemini: { initialBudgetMs: 30_000, finalRecheckBudgetMs: 1_000, resubmitAttempts: 0, resubmitBudgetMs: 0, engagedPaneRecheckBudgetMs: 0 },
    // Interactive external panes can consume the trigger while their first file
    // read is still in flight. A read-only activity probe earns one bounded
    // engaged recheck; it never resends the trigger or proves startup itself.
    codex: { initialBudgetMs: 30_000, finalRecheckBudgetMs: 1_000, resubmitAttempts: 0, resubmitBudgetMs: 0, engagedPaneRecheckBudgetMs: 30_000 },
    cursor: { initialBudgetMs: 30_000, finalRecheckBudgetMs: 1_000, resubmitAttempts: 0, resubmitBudgetMs: 0, engagedPaneRecheckBudgetMs: 30_000 },
    grok: { initialBudgetMs: 30_000, finalRecheckBudgetMs: 1_000, resubmitAttempts: 0, resubmitBudgetMs: 0, engagedPaneRecheckBudgetMs: 0 },
    antigravity: { initialBudgetMs: 30_000, finalRecheckBudgetMs: 1_000, resubmitAttempts: 0, resubmitBudgetMs: 0, engagedPaneRecheckBudgetMs: 0 },
};
const ENGAGED_PANE_RECHECK_TIMEOUT_ENV = 'OMC_TEAM_ENGAGED_PANE_RECHECK_MS';
// The engaged recheck runs while the launch-attempt fence lock is held, so the
// operator override stays clamped: a runaway value would hold stop/retire
// contention for the whole window even though containment itself stays terminal.
const MAX_ENGAGED_PANE_RECHECK_BUDGET_MS = 120_000;
function resolveEngagedPaneRecheckBudgetMs(fallback) {
    const raw = process.env[ENGAGED_PANE_RECHECK_TIMEOUT_ENV];
    const value = raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isFinite(value) || value <= 0)
        return fallback;
    return Math.max(1, Math.min(Math.floor(value), MAX_ENGAGED_PANE_RECHECK_BUDGET_MS));
}
export function getWorkerStartupEvidencePolicy(agentType) {
    const policy = WORKER_STARTUP_EVIDENCE_POLICIES[agentType];
    return { ...policy, engagedPaneRecheckBudgetMs: resolveEngagedPaneRecheckBudgetMs(policy.engagedPaneRecheckBudgetMs) };
}
export async function waitForStartupEvidenceBudget(hasEvidence, budgetMs, delayMs = WORKER_STARTUP_EVIDENCE_POLL_INTERVAL_MS) {
    const deadline = Date.now() + Math.max(0, budgetMs);
    for (;;) {
        if (await hasEvidence())
            return true;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0)
            return false;
        await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, remainingMs)));
    }
}
async function waitForWorkerStartupEvidence(teamName, workerName, taskId, cwd, baseline, launchAttemptId, budgetMs, delayMs = WORKER_STARTUP_EVIDENCE_POLL_INTERVAL_MS) {
    return waitForStartupEvidenceBudget(() => hasCurrentWorkerStartupEvidence(teamName, workerName, taskId, cwd, baseline, launchAttemptId), budgetMs, delayMs);
}
async function waitForWorkerStatusTransition(teamName, workerName, cwd, baselineFingerprint, launchAttemptId, budgetMs, delayMs = 250) {
    return waitForStartupEvidenceBudget(async () => {
        const status = await readWorkerStatus(teamName, workerName, cwd);
        return status.state !== 'unknown' && status.launch_attempt_id === launchAttemptId
            && workerStatusStartupFingerprint(status) !== baselineFingerprint;
    }, budgetMs, delayMs);
}
/**
 * Settle worker startup evidence under a provider-aware policy.
 *
 * The resubmit loop exists to recover a lost interactive submit. When the probe
 * reports `pane_busy`, the owned worker demonstrably consumed the trigger and is
 * actively working, so resubmitting would duplicate the inbox and stopping the
 * wait would tear down a healthy provider (issue #3849). In that case the loop
 * stops resubmitting and one bounded read-only engaged-pane recheck runs before
 * the caller's fail-closed teardown. Interactive providers may also supply a
 * read-only activity probe when resubmission is disabled. Panes that are idle,
 * wrong, or dead never earn that recheck and keep the existing fast failure path.
 */
export async function settleStartupEvidence(policy, waitForCurrentEvidence, resubmit, probeActivity) {
    let settled = await waitForCurrentEvidence(policy.initialBudgetMs);
    let engagedPane = false;
    for (let attempt = 1; !settled && resubmit && attempt <= policy.resubmitAttempts; attempt++) {
        const outcome = await resubmit();
        if (outcome === 'pane_busy') {
            engagedPane = true;
            break;
        }
        if (outcome !== 'resubmitted')
            break;
        settled = await waitForCurrentEvidence(policy.resubmitBudgetMs);
    }
    if (!settled && !engagedPane && probeActivity) {
        try {
            engagedPane = (await probeActivity()) === 'busy';
        }
        catch {
            // A failed activity observation must not turn an unverified pane into
            // startup evidence or extend the fail-closed path.
        }
    }
    if (!settled) {
        settled = await waitForCurrentEvidence(engagedPane
            ? policy.engagedPaneRecheckBudgetMs
            : policy.finalRecheckBudgetMs);
    }
    return settled;
}
export function promptModeRecoveryRequiresProgressEvidence(promptMode, continuationCount) {
    return promptMode && continuationCount > 0;
}
async function applyRequiredLayoutBeforeOwnedLaunch(sessionName, ownership, workerName) {
    try {
        await applyMainVerticalLayout(sessionName, {
            required: true,
            ...(ownership.tmuxServerIdentity ? { tmuxServerIdentity: ownership.tmuxServerIdentity } : {}),
        });
    }
    catch (error) {
        let cleaned = false;
        try {
            await killOwnedWorkerPane(ownership);
            cleaned = await getOwnedWorkerLiveness(ownership) === 'dead';
        }
        catch {
            // Preserve the layout failure unless pane cleanup cannot be verified.
        }
        if (!cleaned) {
            const cleanupError = new Error(`worker_layout_cleanup_unverified:${workerName}:${ownership.paneId}`);
            cleanupError.cause = error;
            throw cleanupError;
        }
        throw error;
    }
}
/**
 * `spawnOwnedWorkerInPane` deliberately throws when its own cleanup cannot
 * prove termination. Recover the durable current-pointer identity so startup
 * rollback can retain that launch instead of disposing the whole instance.
 */
async function readUnresolvedStartupLaunch(opts, paneId) {
    const currentPath = absPath(opts.cwd, TeamPaths.workerLaunchCurrent(opts.teamName, opts.workerName));
    try {
        const record = JSON.parse(await readFile(currentPath, 'utf8'));
        if (record.instance_id !== opts.instanceId
            || record.team_name !== opts.teamName
            || record.worker_name !== opts.workerName
            || record.provider !== opts.agentType
            || record.pane_id !== paneId
            || typeof record.attempt_id !== 'string'
            || typeof record.pane_id !== 'string')
            return null;
        const attempt = await loadWorkerLaunchAttempt({
            cwd: opts.cwd,
            teamName: opts.teamName,
            instanceId: opts.instanceId,
            workerName: opts.workerName,
            paneId: record.pane_id,
            provider: opts.agentType,
            attemptId: record.attempt_id,
            runtimeCliPath: resolveRuntimeCliPath(),
        });
        return attempt ? {
            name: opts.workerName,
            paneId: attempt.pane_id,
            launchAttemptId: attempt.attempt_id,
            provider: attempt.provider,
        } : null;
    }
    catch {
        return null;
    }
}
/**
 * Spawn a single v2 worker in a tmux pane.
 * Writes CLI API inbox (no done.json), waits for ready, sends inbox path.
 */
async function spawnV2Worker(opts) {
    const splitTarget = opts.existingWorkerPaneIds.length === 0
        ? opts.leaderPaneId
        : opts.existingWorkerPaneIds[opts.existingWorkerPaneIds.length - 1];
    const splitDirection = opts.existingWorkerPaneIds.length === 0 ? 'right' : 'down';
    const launchProvider = opts.sessionName.startsWith('cmux:') ? 'cmux' : 'tmux';
    const tmuxServerIdentity = requireTmuxServerIdentity(opts.sessionName, opts.tmuxServerIdentity);
    if (!await workerPaneBelongsToOwnedProviderTarget({
        provider: launchProvider,
        providerTarget: opts.sessionName,
        paneId: splitTarget,
        ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
    }))
        throw new Error('worker_pane_split_target_unverified');
    const split = await splitTeamWorkerPaneWithEvidence(splitTarget, splitDirection, opts.workerCwd ?? opts.cwd, launchProvider, tmuxServerIdentity);
    const ownershipResult = proveWorkerPaneOwnership(split, {
        providerTarget: opts.sessionName,
        leaderPaneId: opts.leaderPaneId,
        reservedPaneIds: opts.existingWorkerPaneIds,
        ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
    });
    if (!ownershipResult.ok) {
        return { paneId: null, startupAssigned: false, startupFailureReason: `pane_identity_${ownershipResult.reason}` };
    }
    if (!await workerPaneBelongsToOwnedProviderTarget({
        provider: ownershipResult.ownership.provider,
        providerTarget: ownershipResult.ownership.providerTarget,
        paneId: ownershipResult.ownership.paneId,
        ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
    }))
        throw new Error(`worker_pane_membership_unverified:${ownershipResult.ownership.paneId}`);
    const ownership = ownershipResult.ownership;
    const paneId = ownership.paneId;
    if (launchProvider === 'tmux') {
        await applyRequiredLayoutBeforeOwnedLaunch(opts.sessionName, ownership, opts.workerName);
    }
    const usePromptMode = isPromptModeAgent(opts.agentType);
    const injectContract = shouldInjectContract(opts.role ?? null, opts.agentType);
    const outputFile = injectContract && opts.role
        ? cliWorkerOutputFilePath(teamStateRoot(opts.cwd, opts.teamName), opts.workerName, {
            taskId: opts.taskId,
            assignmentId: opts.verdictAssignmentId,
        })
        : undefined;
    const cliOutputContract = injectContract && opts.role && outputFile
        ? renderCliWorkerOutputContract(opts.role, outputFile)
        : undefined;
    const instruction = buildV2TaskInstruction(opts.teamName, opts.workerName, opts.task, opts.taskId, opts.agentType, cliOutputContract);
    const instructionStateRoot = workerInstructionStateRoot(opts.cwd, opts.teamName);
    const startupBaseline = await captureWorkerStartupBaseline(opts.teamName, opts.workerName, opts.taskId, opts.cwd);
    if (usePromptMode) {
        await composeInitialInbox(opts.teamName, opts.workerName, instruction, opts.cwd, cliOutputContract);
    }
    const envVars = {
        ...getModelWorkerEnv(opts.teamName, opts.workerName, opts.agentType),
        OMC_TEAM_STATE_ROOT: teamStateRoot(opts.cwd, opts.teamName),
        OMC_TEAM_LEADER_CWD: opts.cwd,
        ...(opts.worktreePath ? { OMC_TEAM_WORKTREE_PATH: opts.worktreePath } : {}),
        ...(opts.workerCwd ? { OMC_TEAM_WORKER_CWD: opts.workerCwd } : {}),
    };
    const launchDescriptor = opts.launchDescriptor;
    if (opts.autoMerge && opts.worktreePath) {
        const cadenceContext = {
            teamName: opts.teamName,
            workerName: opts.workerName,
            worktreePath: opts.worktreePath,
            agentType: opts.agentType,
            enabled: true,
        };
        const cadence = await installCommitCadence(cadenceContext);
        const poller = cadence.method === 'fallback-poll'
            ? startFallbackPoller(opts.worktreePath, opts.workerName)
            : undefined;
        registerTeamCadence(opts.teamName, cadenceContext, poller);
    }
    const paneConfig = {
        teamName: opts.teamName,
        instanceId: opts.instanceId,
        workerName: opts.workerName,
        envVars,
        launchBinary: launchDescriptor.binary,
        launchArgs: [...launchDescriptor.args],
        cwd: opts.workerCwd ?? opts.cwd,
        provider: opts.agentType,
        launchBootstrapPath: resolveRuntimeCliPath(),
        launchStateCwd: opts.cwd,
        launchContext: { kind: 'initial' },
        ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
    };
    let startupContext;
    try {
        startupContext = await spawnOwnedWorkerInPane(opts.sessionName, ownership, paneConfig);
    }
    catch (error) {
        const unresolvedLaunch = await readUnresolvedStartupLaunch(opts, paneId);
        if (unresolvedLaunch || (error instanceof Error && error.message.startsWith('worker_launch_cleanup_unverified'))) {
            const enriched = error instanceof Error
                ? error
                : new Error(String(error));
            enriched.unresolvedLaunch = unresolvedLaunch ?? {
                name: opts.workerName,
                paneId,
                provider: opts.agentType,
            };
            throw enriched;
        }
        throw error;
    }
    const inboxTriggerMessage = `${generateTriggerMessage(opts.teamName, opts.workerName, instructionStateRoot)} ` +
        `[launch:${startupContext.attempt.attempt_id.slice(0, 12)}]`;
    const cleanupStartedLaunch = async (reason) => {
        const cleaned = await retireAndCleanupCurrentWorkerLaunchAttempt(startupContext.attempt, reason, async () => {
            try {
                if (await getOwnedWorkerLiveness(ownership) === 'dead')
                    return true;
                await killOwnedWorkerPane(ownership);
                return await getOwnedWorkerLiveness(ownership) === 'dead';
            }
            catch {
                return false;
            }
        }).catch(() => false);
        if (!cleaned)
            throw new Error(`worker_startup_cleanup_unverified:${opts.workerName}:${paneId}`);
    };
    const evidencePolicy = getWorkerStartupEvidencePolicy(opts.agentType);
    const waitForCurrentEvidence = (budgetMs) => waitForWorkerStartupEvidence(opts.teamName, opts.workerName, opts.taskId, opts.cwd, startupBaseline, startupContext.attempt.attempt_id, budgetMs);
    const probeActivity = opts.agentType === 'cursor' || opts.agentType === 'codex'
        ? () => probeStartupPaneActivity(startupContext, { attemptAlreadyFenced: true })
        : undefined;
    const waitForBoundedStartupEvidence = (resubmit) => settleStartupEvidence(evidencePolicy, waitForCurrentEvidence, resubmit, probeActivity);
    const fencedDispatch = await (async () => {
        try {
            return await withWorkerLaunchAttemptFence(startupContext.attempt, async () => {
                if (!await workerPaneBelongsToOwnedProviderTarget({
                    provider: startupContext.ownership.provider,
                    providerTarget: startupContext.ownership.providerTarget,
                    paneId: startupContext.ownership.paneId,
                    ...(startupContext.ownership.tmuxServerIdentity
                        ? { tmuxServerIdentity: startupContext.ownership.tmuxServerIdentity }
                        : {}),
                }))
                    return { ok: false, reason: 'worker_pane_membership_unverified' };
                return queueInboxInstruction({
                    teamName: opts.teamName,
                    workerName: opts.workerName,
                    workerIndex: opts.workerIndex + 1,
                    paneId,
                    inbox: instruction,
                    triggerMessage: inboxTriggerMessage,
                    cwd: opts.cwd,
                    transportPreference: usePromptMode ? 'prompt_stdin' : 'transport_direct',
                    fallbackAllowed: DEFAULT_TEAM_TRANSPORT_POLICY.dispatch_mode === 'hook_preferred_with_fallback',
                    inboxCorrelationKey: `startup:${opts.workerName}:${opts.taskId}:${startupContext.attempt.attempt_id}`,
                    notify: async (_target, triggerMessage) => {
                        if (usePromptMode) {
                            const settled = await waitForBoundedStartupEvidence();
                            return settled
                                ? { ok: true, transport: 'prompt_stdin', reason: 'prompt_mode_worker_confirmed' }
                                : { ok: false, transport: 'prompt_stdin', reason: `${opts.agentType}_startup_evidence_missing` };
                        }
                        const attempted = await deliverStartupInbox(startupContext, triggerMessage, { attemptAlreadyFenced: true });
                        if (!attempted.ok) {
                            return { ok: false, transport: 'tmux_send_keys', reason: `worker_notify_failed:${attempted.reason}` };
                        }
                        const settled = await waitForBoundedStartupEvidence(opts.agentType === 'cursor' || opts.agentType === 'codex'
                            ? undefined
                            : () => retryStartupInboxSubmit(startupContext, triggerMessage, { attemptAlreadyFenced: true }));
                        return settled
                            ? { ok: true, transport: 'tmux_send_keys', reason: 'worker_startup_confirmed' }
                            : { ok: false, transport: 'tmux_send_keys', reason: 'worker_startup_evidence_missing' };
                    },
                    deps: { writeWorkerInbox },
                });
            });
        }
        catch (error) {
            try {
                await cleanupStartedLaunch('startup_dispatch_exception');
            }
            catch (cleanupError) {
                const enriched = cleanupError instanceof Error
                    ? cleanupError
                    : new Error(String(cleanupError));
                enriched.unresolvedLaunch = {
                    name: opts.workerName,
                    paneId,
                    launchAttemptId: startupContext.attempt.attempt_id,
                    provider: startupContext.attempt.provider,
                };
                throw enriched;
            }
            throw error;
        }
    })();
    const dispatchOutcome = fencedDispatch.ok
        ? fencedDispatch.value
        : { ok: false, reason: 'worker_launch_attempt_superseded' };
    if (!dispatchOutcome.ok) {
        try {
            await cleanupStartedLaunch('startup_dispatch_failed');
        }
        catch (error) {
            const enriched = error instanceof Error
                ? error
                : new Error(String(error));
            enriched.unresolvedLaunch = {
                name: opts.workerName,
                paneId,
                launchAttemptId: startupContext.attempt.attempt_id,
                provider: startupContext.attempt.provider,
            };
            throw enriched;
        }
        return {
            paneId,
            startupAssigned: false,
            startupFailureReason: dispatchOutcome.reason,
            launchAttemptId: startupContext.attempt.attempt_id,
        };
    }
    return {
        paneId,
        startupAssigned: true,
        launchAttemptId: startupContext.attempt.attempt_id,
        ...(outputFile ? { outputFile } : {}),
    };
}
function validateRecoveryAttemptSecret(value, input, recoveryId, replacementGeneration) {
    const secret = value;
    if (secret?.schema_version !== 1 || secret.request_id !== input.requestId || secret.recovery_id !== recoveryId
        || secret.worker_name !== input.workerName || secret.replacement_generation !== replacementGeneration
        || typeof secret.adoption_token !== 'string' || secret.adoption_token.length === 0
        || typeof secret.created_at !== 'string' || !Number.isFinite(Date.parse(secret.created_at))) {
        throw new Error('invalid_persisted_state');
    }
    return secret;
}
const pendingRecoveryPanes = new Map();
async function recordRecoveryPaneRollbackFailure(input, recoveryId, pending, reason, liveness) {
    const recordedAt = Date.now();
    const path = absPath(input.cwd, TeamPaths.recoveryPaneRollbackFailure(input.teamName, recoveryId, pending.paneAttemptId, recordedAt));
    const candidate = `${path}.candidate.${process.pid}.${randomUUID()}`;
    await mkdir(join(path, '..'), { recursive: true });
    const handle = await open(candidate, 'wx', 0o600);
    try {
        await handle.writeFile(JSON.stringify({ schema_version: 1, team_name: input.teamName, worker_name: input.workerName,
            request_id: input.requestId, recovery_id: recoveryId, pane_id: pending.ownership.paneId,
            pane_attempt_id: pending.paneAttemptId, reason: redactBoundedDiagnostic(reason, 500), liveness, recorded_at: new Date(recordedAt).toISOString() }, null, 2), 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await link(candidate, path);
    }
    finally {
        await unlink(candidate).catch(() => undefined);
    }
    return path;
}
async function recordUnaddressableRecoveryPaneFailure(input, recoveryId, paneAttemptId, reason, split) {
    const recordedAt = Date.now();
    const path = absPath(input.cwd, TeamPaths.recoveryPaneRollbackFailure(input.teamName, recoveryId, paneAttemptId, recordedAt));
    const candidate = `${path}.candidate.${process.pid}.${randomUUID()}`;
    await mkdir(join(path, '..'), { recursive: true });
    const handle = await open(candidate, 'wx', 0o600);
    const boundedSplit = split ? {
        ...split,
        rawOutput: redactBoundedDiagnostic(split.rawOutput, 500),
        stderr: redactBoundedDiagnostic(split.stderr, 500),
    } : null;
    try {
        await handle.writeFile(JSON.stringify({ schema_version: 1, team_name: input.teamName, worker_name: input.workerName,
            request_id: input.requestId, recovery_id: recoveryId, pane_id: null, pane_attempt_id: paneAttemptId,
            reason: redactBoundedDiagnostic(reason, 500), liveness: 'unknown', unaddressable: true, split: boundedSplit, recorded_at: new Date(recordedAt).toISOString() }, null, 2), 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await link(candidate, path);
    }
    finally {
        await unlink(candidate).catch(() => undefined);
    }
    return path;
}
async function cleanupRecoveryPaneAttempt(input, recoveryId, pending, reason) {
    // A spawn rejection can occur after its bootstrap created an owned process
    // but before it returned the launch context. Without that context, cleanup
    // containment is unproven and the pane must be retained for investigation.
    let providerStopped = false;
    if (pending.startupContext) {
        providerStopped = await retireAndCleanupCurrentWorkerLaunchAttempt(pending.startupContext.attempt, reason, async () => {
            try {
                await killOwnedWorkerPane(pending.ownership);
                return await getOwnedWorkerLiveness(pending.ownership) === 'dead';
            }
            catch {
                return false;
            }
        }).catch(() => false);
    }
    if (!providerStopped) {
        const liveness = await getOwnedWorkerLiveness(pending.ownership).catch(() => 'unknown');
        await recordRecoveryPaneRollbackFailure(input, recoveryId, pending, `${reason}:provider_cleanup_unverified`, liveness);
        return false;
    }
    let liveness = 'unknown';
    for (let attempt = 0; attempt < 2; attempt++) {
        await killOwnedWorkerPane(pending.ownership).catch(() => undefined);
        liveness = await getOwnedWorkerLiveness(pending.ownership).catch(() => 'unknown');
        if (liveness === 'dead' && providerStopped) {
            pendingRecoveryPanes.delete(recoveryId);
            return true;
        }
    }
    await recordRecoveryPaneRollbackFailure(input, recoveryId, pending, providerStopped ? reason : `${reason}:provider_cleanup_unverified`, liveness);
    return false;
}
async function buildRecoveryPaneContext(input, sagaInput, worker, descriptor, ownership, paneAttemptId, instanceId) {
    const currentProviderPath = resolvePreflightBinaryPath(descriptor.provider).path;
    const sameProviderPath = process.platform === 'win32'
        ? currentProviderPath.toLowerCase() === descriptor.binary.toLowerCase()
        : currentProviderPath === descriptor.binary;
    if (!sameProviderPath)
        throw new Error('provider path changed');
    const agentType = descriptor.provider;
    const workerCwd = worker.working_dir ?? input.cwd;
    const promptMode = isPromptModeAgent(agentType);
    const providerEnv = {
        ...getModelWorkerEnv(input.teamName, sagaInput.workerName, agentType),
        OMC_TEAM_STATE_ROOT: teamStateRoot(input.cwd, input.teamName),
        OMC_TEAM_LEADER_CWD: input.cwd,
        ...(worker.worktree_path ? { OMC_TEAM_WORKTREE_PATH: worker.worktree_path } : {}),
    };
    const gate = {
        recoveryId: sagaInput.recoveryId, workerName: sagaInput.workerName,
        replacementGeneration: sagaInput.replacementGeneration, paneAttemptId,
        readyPath: absPath(input.cwd, TeamPaths.recoveryReady(input.teamName, sagaInput.recoveryId, paneAttemptId)),
        activatePath: absPath(input.cwd, TeamPaths.recoveryActivate(input.teamName, sagaInput.recoveryId, paneAttemptId)),
        runPath: absPath(input.cwd, TeamPaths.recoveryRun(input.teamName, sagaInput.recoveryId, paneAttemptId)),
        providerArgv: [descriptor.binary, ...descriptor.args], cwd: workerCwd, env: providerEnv, timeoutMs: 300_000,
    };
    let startupContext;
    if (worker.launch_attempt_id) {
        const attempt = await loadWorkerLaunchAttempt({
            cwd: input.cwd,
            teamName: input.teamName,
            instanceId,
            workerName: sagaInput.workerName,
            paneId: ownership.paneId,
            provider: agentType,
            attemptId: worker.launch_attempt_id,
            runtimeCliPath: resolveRuntimeCliPath(),
        });
        if (attempt)
            startupContext = { ownership, attempt, provider: agentType };
    }
    return {
        ownership,
        paneAttemptId,
        instanceId,
        worker,
        agentType,
        gate,
        promptMode,
        ...(startupContext ? { startupContext } : {}),
    };
}
function recoveryError(input, recoveryId, error, message) {
    return {
        outcome: 'failed',
        committed: false,
        error,
        message,
        requestId: input.requestId,
        recoveryId,
        teamName: input.teamName,
        workerName: input.workerName,
        updatedAt: new Date().toISOString(),
    };
}
function persistRecoveryFinal(input, recoveryId, result) {
    if (result.requestId !== input.requestId || result.recoveryId !== recoveryId
        || result.teamName !== input.teamName || result.workerName !== input.workerName) {
        throw new Error('invalid_persisted_state');
    }
    const existingFinalState = readRecoveryFinalState(input.cwd, input.requestId);
    if (existingFinalState.kind === 'invalid')
        throw new Error('invalid_persisted_state');
    const existing = readRecoveryOutcome(input.cwd, input.requestId);
    if (isMatchingRecoveryFinal(existing, { requestId: input.requestId, recoveryId,
        teamName: input.teamName, workerName: input.workerName }))
        return existing.result;
    const succeeded = result.outcome === 'recovered' || result.outcome === 'already_running';
    const failureResult = succeeded ? undefined : result;
    writeRecoveryFinal(input.cwd, {
        schema_version: 1,
        kind: 'final',
        request_id: input.requestId,
        recovery_id: recoveryId,
        team_name: input.teamName,
        worker_name: input.workerName,
        outcome: succeeded ? 'succeeded' : result.outcome === 'commit_unknown' ? 'commit_unknown' : 'failed',
        result,
        error: failureResult ? { code: failureResult.error, message: failureResult.message, commit_uncertain: failureResult.outcome === 'commit_unknown' } : undefined,
        continuation: succeeded && result.requeuedTaskIds.length > 0 ? 'adopted' : 'none',
        adoption: succeeded && result.requeuedTaskIds.length > 0 ? 'adopted' : 'not_started',
        services: succeeded ? result.servicesSync : 'terminal_degraded',
        manifest: succeeded ? result.manifestSync : 'repair_required',
        completed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    });
    return result;
}
export async function finalizeRecoveryOwnerResult(input, recoveryId, result, deps = {
    readRevisionedConfig: readRevisionedTeamConfig,
    saveConfigAtRevision: saveTeamConfigAtRevision,
    publishFinal: persistRecoveryFinal,
    withConfigLock: withTeamConfigMutationLock,
}) {
    if (!hasRequiredRecoveryPaneIdentities(result)) {
        return recoveryError(input, recoveryId, 'invalid_persisted_state', 'Recovery success result omitted a required actual pane identity.');
    }
    const durableContinuation = deps.readDurableContinuation
        ? deps.readDurableContinuation(input.cwd, input.requestId, recoveryId)
        : (() => {
            const outcome = readRecoveryOutcome(input.cwd, input.requestId);
            return outcome?.kind === 'phase' && outcome.recovery_id === recoveryId ? outcome.continuation : 'none';
        })();
    const transientFailure = result.outcome === 'commit_unknown'
        || (result.outcome === 'recovered' && result.activation === 'services_pending')
        || (result.outcome === 'failed' && durableContinuation === 'reserved')
        || (result.outcome === 'failed' && result.reservationsWritten === true)
        || (result.outcome === 'failed' && [
            'spawn_failed',
            'startup_ack_timeout',
            'config_commit_failed',
            'worker_activation_failed',
            'auto_merge_unavailable',
            'stale_state_revision',
            'worker_liveness_unknown',
            'runtime_owner_unavailable',
            'runtime_owner_fence_lost',
            'worker_cleanup_incomplete',
        ].includes(result.error));
    if (transientFailure) {
        const pending = await deps.readRevisionedConfig(input.teamName, input.cwd);
        if (pending?.config.active_recovery?.recovery_id === recoveryId) {
            const phase = result.outcome === 'recovered' && result.activation === 'services_pending'
                ? 'services_pending'
                : pending.config.active_recovery.phase;
            const nextRevision = pending.stateRevision + 1;
            await deps.saveConfigAtRevision({
                ...pending.config,
                state_revision: nextRevision,
                active_recovery: {
                    ...pending.config.active_recovery,
                    phase,
                    state_revision: nextRevision,
                    updated_at: new Date().toISOString(),
                },
            }, pending.stateRevision, input.cwd);
        }
        return result;
    }
    const terminal = await deps.readRevisionedConfig(input.teamName, input.cwd);
    const active = terminal?.config.active_recovery;
    if (terminal && active?.recovery_id === recoveryId
        && active.request_id === input.requestId && active.worker_name === input.workerName
        && active.owner_epoch === terminal.config.runtime_owner_epoch?.epoch
        && active.owner_nonce === terminal.config.runtime_owner_epoch?.nonce) {
        const phase = result.outcome === 'recovered' || result.outcome === 'already_running'
            ? 'adopted'
            : 'failed';
        const finalRevision = terminal.stateRevision + 1;
        const finalConfig = {
            ...terminal.config,
            active_recovery: undefined,
            last_recovery: {
                ...active,
                phase,
                state_revision: finalRevision,
                updated_at: new Date().toISOString(),
            },
            state_revision: finalRevision,
        };
        let published = null;
        let saved = false;
        try {
            saved = await deps.saveConfigAtRevision(finalConfig, terminal.stateRevision, input.cwd, async () => {
                const verified = await deps.readRevisionedConfig(input.teamName, input.cwd);
                const verifiedLast = verified?.config.last_recovery;
                if (verified && !verified.config.active_recovery && verifiedLast?.recovery_id === recoveryId
                    && verifiedLast.request_id === input.requestId && verifiedLast.worker_name === input.workerName
                    && verifiedLast.phase === phase && verifiedLast.state_revision === finalRevision
                    && verifiedLast.owner_epoch === verified.config.runtime_owner_epoch?.epoch
                    && verifiedLast.owner_nonce === verified.config.runtime_owner_epoch?.nonce
                    && verified.stateRevision === finalRevision) {
                    published = deps.publishFinal(input, recoveryId, result);
                }
            }, { release: { active_recovery: true } });
        }
        catch {
            saved = false;
        }
        if (!saved || !published) {
            return { ...recoveryError(input, recoveryId, 'stale_state_revision', 'Recovery reached a terminal state, but config cleanup could not be verified.'), outcome: 'commit_unknown' };
        }
        return published;
    }
    const withLock = deps.withConfigLock ?? (async (_teamName, _cwd, fn) => fn());
    return withLock(input.teamName, input.cwd, async () => {
        const verified = await deps.readRevisionedConfig(input.teamName, input.cwd);
        const expectedPhase = result.outcome === 'recovered' || result.outcome === 'already_running' ? 'adopted' : 'failed';
        const verifiedLast = verified?.config.last_recovery;
        if (verified && !verified.config.active_recovery && verifiedLast?.recovery_id === recoveryId
            && verifiedLast.request_id === input.requestId && verifiedLast.worker_name === input.workerName
            && verifiedLast.phase === expectedPhase && verifiedLast.state_revision === verified.stateRevision
            && verifiedLast.owner_epoch === verified.config.runtime_owner_epoch?.epoch
            && verifiedLast.owner_nonce === verified.config.runtime_owner_epoch?.nonce) {
            return deps.publishFinal(input, recoveryId, result);
        }
        return { ...recoveryError(input, recoveryId, 'stale_state_revision', 'Recovery terminal state is no longer the active or last revision-checked attempt.'), outcome: 'commit_unknown' };
    });
}
async function finalizeBoundRecoveryOwnerTerminal(input, recoveryId, result) {
    try {
        const current = await readRevisionedTeamConfig(input.teamName, input.cwd);
        const active = current?.config.active_recovery;
        if (active?.request_id === input.requestId && active.recovery_id === recoveryId
            && active.worker_name === input.workerName) {
            return finalizeRecoveryOwnerResult(input, recoveryId, result);
        }
    }
    catch { /* owner-bound state is uncertain; retain intent and attempt */ }
    return { ...recoveryError(input, recoveryId, 'stale_state_revision', 'Recovery terminal cleanup could not prove the exact active attempt.'), outcome: 'commit_unknown' };
}
export function selectRecoveryReplayTasks(tasks, workerName, recoveryId, committedPaneLiveness) {
    return tasks.filter(task => task.recovery_reservation?.recovery_id === recoveryId
        || task.recovery_adoption?.recovery_id === recoveryId
        || ((committedPaneLiveness === null || committedPaneLiveness === 'dead')
            && task.status === 'in_progress' && task.owner === workerName));
}
export async function resolveCommittedRecoveryManifestSync(readManifest, expected) {
    try {
        const manifest = await readManifest();
        const projected = manifest?.workers.find(candidate => candidate.name === expected.workerName);
        return projected?.pane_id === expected.paneId && projected.pane_attempt_id === expected.paneAttemptId
            && projected.recovery_id === expected.recoveryId
            && projected.replacement_generation === expected.replacementGeneration
            ? 'synced' : 'repair_required';
    }
    catch {
        return 'repair_required';
    }
}
export function resolveCommittedRecoveryPaneAttempt(activeRecovery, recoveryId, replacementGeneration, worker) {
    return activeRecovery?.recovery_id === recoveryId && worker.recovery_id === recoveryId
        && worker.replacement_generation === replacementGeneration && worker.pane_id && worker.pane_attempt_id
        ? { paneId: worker.pane_id, paneAttemptId: worker.pane_attempt_id }
        : null;
}
async function readOrCreateRecoveryAttempt(input, recoveryId, replacementGeneration) {
    const path = absPath(input.cwd, TeamPaths.recoveryAttempt(input.teamName, recoveryId));
    try {
        return validateRecoveryAttemptSecret(JSON.parse(await readFile(path, 'utf8')), input, recoveryId, replacementGeneration);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const secret = {
        schema_version: 1,
        request_id: input.requestId,
        recovery_id: recoveryId,
        worker_name: input.workerName,
        replacement_generation: replacementGeneration,
        adoption_token: randomUUID(),
        created_at: new Date().toISOString(),
    };
    await mkdir(join(path, '..'), { recursive: true });
    const candidate = `${path}.candidate.${process.pid}.${randomUUID()}`;
    const candidateHandle = await open(candidate, 'wx', 0o600);
    try {
        await candidateHandle.writeFile(JSON.stringify(secret, null, 2), 'utf8');
        await candidateHandle.sync();
    }
    finally {
        await candidateHandle.close();
    }
    try {
        await link(candidate, path);
        return validateRecoveryAttemptSecret(JSON.parse(await readFile(path, 'utf8')), input, recoveryId, replacementGeneration);
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        return validateRecoveryAttemptSecret(JSON.parse(await readFile(path, 'utf8')), input, recoveryId, replacementGeneration);
    }
    finally {
        await unlink(candidate).catch(() => undefined);
    }
}
const BOOTSTRAP_RECOVERY_EVIDENCE_POLL_MS = 25;
const BOOTSTRAP_RECOVERY_EVIDENCE_MAX_WAIT_MS = 1_000;
function waitForBootstrapRecoveryEvidence(delayMs, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new Error('bootstrap_recovery_evidence_aborted'));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, delayMs);
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(signal?.reason ?? new Error('bootstrap_recovery_evidence_aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
async function hasBootstrapRecoveryEvidence(teamName, cwd, input, waitOptions = {}) {
    const bootstrap = input.bootstrap;
    if (!bootstrap)
        return true;
    const reservation = readRecoveryRequestReservation(cwd, input.requestId);
    if (!reservation || reservation.kind !== 'reservation' || reservation.recovery_id !== bootstrap.recoveryId
        || reservation.team_name !== teamName || reservation.worker_name !== input.workerName
        || reservation.instance_id.toLowerCase() !== input.instanceId.toLowerCase())
        return false;
    try {
        const intent = parseRecoveryIntent(await readFile(absPath(cwd, TeamPaths.recoveryIntent(teamName, bootstrap.recoveryId)), 'utf8'));
        if (intent.request_id !== input.requestId || intent.recovery_id !== bootstrap.recoveryId
            || intent.team_name !== teamName || intent.worker_name !== input.workerName
            || intent.instance_id.toLowerCase() !== input.instanceId.toLowerCase())
            return false;
        const now = waitOptions.now ?? Date.now;
        const timeoutMs = waitOptions.timeoutMs === undefined
            ? BOOTSTRAP_RECOVERY_EVIDENCE_MAX_WAIT_MS
            : Number.isFinite(waitOptions.timeoutMs)
                ? Math.min(Math.max(waitOptions.timeoutMs, 0), BOOTSTRAP_RECOVERY_EVIDENCE_MAX_WAIT_MS)
                : 0;
        const deadline = now() + timeoutMs;
        const sleep = waitOptions.sleep ?? waitForBootstrapRecoveryEvidence;
        for (let attempt = 0; attempt <= Math.ceil(timeoutMs / BOOTSTRAP_RECOVERY_EVIDENCE_POLL_MS)
            && !waitOptions.signal?.aborted; attempt++) {
            const candidate = await readRecoveryOwnerBootstrapCandidate(teamName, cwd, bootstrap.expectedEpoch, bootstrap.nonce);
            if (candidate && candidateMatchesBootstrap(candidate, input))
                return true;
            const owner = readLatestOwnerEpoch(cwd, teamName);
            if (owner && (owner.epoch > bootstrap.expectedEpoch
                || (owner.epoch === bootstrap.expectedEpoch && (owner.pid !== bootstrap.pid
                    || owner.process_started_at !== bootstrap.processStartedAt || owner.nonce !== bootstrap.nonce))))
                return false;
            const remainingMs = deadline - now();
            if (remainingMs <= 0)
                return false;
            await sleep(Math.min(BOOTSTRAP_RECOVERY_EVIDENCE_POLL_MS, remainingMs), waitOptions.signal);
        }
        return false;
    }
    catch {
        return false;
    }
}
function recoveryOwnerBootstrapCandidatePath(teamName, expectedEpoch, nonce) {
    return TeamPaths.recoveryOwnerBootstrapCandidate(teamName, expectedEpoch, nonce);
}
function isCanonicalBootstrapCandidate(value, expectedEpoch) {
    const candidate = value;
    if (!candidate || candidate.schema_version !== 1 || candidate.expected_epoch !== expectedEpoch
        || typeof candidate.request_id !== 'string' || candidate.request_id.length === 0
        || typeof candidate.recovery_id !== 'string' || candidate.recovery_id.length === 0
        || typeof candidate.team_name !== 'string' || candidate.team_name.length === 0
        || typeof candidate.worker_name !== 'string' || candidate.worker_name.length === 0
        || !isValidTeamInstanceId(candidate.instance_id)
        || typeof candidate.nonce !== 'string' || candidate.nonce.length === 0
        || typeof candidate.pid !== 'number' || !Number.isSafeInteger(candidate.pid) || candidate.pid < 1
        || typeof candidate.process_started_at !== 'string' || candidate.process_started_at.length === 0
        || typeof candidate.predecessor_epoch !== 'number' || !Number.isSafeInteger(candidate.predecessor_epoch) || candidate.predecessor_epoch < 0
        || candidate.expected_epoch !== candidate.predecessor_epoch + 1
        || (candidate.predecessor_epoch === 0 && (candidate.predecessor_nonce !== null
            || candidate.predecessor_pid !== null || candidate.predecessor_process_started_at !== null))
        || (candidate.predecessor_epoch > 0 && (typeof candidate.predecessor_nonce !== 'string'
            || candidate.predecessor_nonce.length === 0 || typeof candidate.predecessor_pid !== 'number'
            || !Number.isSafeInteger(candidate.predecessor_pid)
            || candidate.predecessor_pid < 1 || typeof candidate.predecessor_process_started_at !== 'string'
            || candidate.predecessor_process_started_at.length === 0))
        || typeof candidate.created_at !== 'string' || !Number.isFinite(Date.parse(candidate.created_at))
        || typeof candidate.payload_hash !== 'string')
        return false;
    const { payload_hash, ...unsigned } = candidate;
    return createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') === payload_hash;
}
async function readRecoveryOwnerBootstrapCandidate(teamName, cwd, expectedEpoch, nonce) {
    try {
        const value = JSON.parse(await readFile(absPath(cwd, recoveryOwnerBootstrapCandidatePath(teamName, expectedEpoch, nonce)), 'utf8'));
        return isCanonicalBootstrapCandidate(value, expectedEpoch) && value.nonce === nonce ? value : null;
    }
    catch {
        return null;
    }
}
function candidateMatchesBootstrap(candidate, input) {
    const bootstrap = input.bootstrap;
    return !!bootstrap && candidate.request_id === input.requestId && candidate.recovery_id === bootstrap.recoveryId
        && candidate.team_name === input.teamName && candidate.worker_name === input.workerName
        && candidate.instance_id.toLowerCase() === input.instanceId.toLowerCase()
        && candidate.expected_epoch === bootstrap.expectedEpoch && candidate.nonce === bootstrap.nonce
        && candidate.pid === bootstrap.pid && candidate.process_started_at === bootstrap.processStartedAt
        && candidate.predecessor_epoch === bootstrap.predecessorEpoch
        && candidate.predecessor_nonce === bootstrap.predecessorNonce
        && candidate.predecessor_pid === bootstrap.predecessorPid
        && candidate.predecessor_process_started_at === bootstrap.predecessorProcessStartedAt;
}
async function isExactDeadOrphanBootstrapCandidate(teamName, cwd, input, config, orphan) {
    const bootstrap = input.bootstrap;
    if (!bootstrap || !orphan || !isProcessIdentityDead(orphan) || orphan.epoch !== bootstrap.predecessorEpoch
        || orphan.nonce !== bootstrap.predecessorNonce || orphan.pid !== bootstrap.predecessorPid
        || orphan.process_started_at !== bootstrap.predecessorProcessStartedAt
        || !config.instance_id || config.instance_id.toLowerCase() !== input.instanceId.toLowerCase())
        return false;
    let expectedEpoch = bootstrap.expectedEpoch;
    let candidateNonce = bootstrap.nonce;
    let predecessor = orphan;
    for (;;) {
        const candidate = await readRecoveryOwnerBootstrapCandidate(teamName, cwd, expectedEpoch, candidateNonce);
        if (!candidate)
            return false;
        if (expectedEpoch === bootstrap.expectedEpoch) {
            if (!candidateMatchesBootstrap(candidate, input))
                return false;
        }
        else if (candidate.request_id !== input.requestId || candidate.recovery_id !== bootstrap.recoveryId
            || candidate.team_name !== teamName || candidate.worker_name !== input.workerName
            || candidate.instance_id.toLowerCase() !== input.instanceId.toLowerCase()
            || candidate.nonce !== predecessor.nonce || candidate.pid !== predecessor.pid
            || candidate.process_started_at !== predecessor.process_started_at) {
            return false;
        }
        if (candidate.predecessor_epoch === 0) {
            return !config.runtime_owner_epoch && !config.active_recovery;
        }
        const candidatePredecessor = candidate.predecessor_epoch === 0 ? null : {
            pid: candidate.predecessor_pid,
            process_started_at: candidate.predecessor_process_started_at,
        };
        if (candidatePredecessor && !isProcessIdentityDead(candidatePredecessor))
            return false;
        if (config.runtime_owner_epoch?.epoch === candidate.predecessor_epoch
            && config.runtime_owner_epoch.nonce === candidate.predecessor_nonce
            && config.runtime_owner_epoch.pid === candidate.predecessor_pid
            && config.runtime_owner_epoch.process_started_at === candidate.predecessor_process_started_at) {
            const active = config.active_recovery;
            return !!active && active.request_id === input.requestId && active.recovery_id === bootstrap.recoveryId
                && active.worker_name === input.workerName && active.owner_epoch === candidate.predecessor_epoch
                && active.owner_nonce === candidate.predecessor_nonce;
        }
        if (expectedEpoch <= 1 || candidate.predecessor_epoch !== expectedEpoch - 1)
            return false;
        predecessor = {
            epoch: candidate.predecessor_epoch,
            nonce: candidate.predecessor_nonce,
            pid: candidate.predecessor_pid,
            process_started_at: candidate.predecessor_process_started_at,
        };
        expectedEpoch = candidate.predecessor_epoch;
        candidateNonce = predecessor.nonce;
    }
}
function isExactRecoverySidecar(value, task, input, active, replacementGeneration, adoptionToken) {
    const sidecar = value;
    const persisted = task.recovery_reservation ?? task.recovery_adoption;
    if (!sidecar || !persisted || sidecar.schema_version !== 1 || sidecar.recovery_id !== active.recovery_id
        || sidecar.request_id !== input.requestId || sidecar.task_id !== task.id || sidecar.old_owner !== input.workerName
        || typeof sidecar.old_task_version !== 'number' || !Number.isSafeInteger(sidecar.old_task_version) || sidecar.old_task_version < 1
        || typeof sidecar.old_claim_token !== 'string' || sidecar.old_claim_token.length === 0
        || typeof sidecar.old_claim_leased_until !== 'string' || !Number.isFinite(Date.parse(sidecar.old_claim_leased_until))
        || typeof sidecar.continuation_sequence !== 'number' || !Number.isSafeInteger(sidecar.continuation_sequence) || sidecar.continuation_sequence < 1
        || typeof sidecar.checkpoint_path !== 'string' || sidecar.checkpoint_path.length === 0
        || typeof sidecar.checkpoint_hash !== 'string' || !/^[a-f0-9]{64}$/.test(sidecar.checkpoint_hash)
        || sidecar.replacement_worker !== input.workerName || sidecar.replacement_generation !== replacementGeneration
        || sidecar.adoption_token_hash !== createHash('sha256').update(adoptionToken).digest('hex')
        || typeof sidecar.created_at !== 'string' || !Number.isFinite(Date.parse(sidecar.created_at)))
        return false;
    const sameReservation = persisted.recovery_id === sidecar.recovery_id && persisted.request_id === sidecar.request_id
        && persisted.continuation_sequence === sidecar.continuation_sequence && persisted.checkpoint_path === sidecar.checkpoint_path
        && persisted.checkpoint_hash === sidecar.checkpoint_hash && persisted.replacement_worker === sidecar.replacement_worker
        && persisted.replacement_generation === sidecar.replacement_generation;
    if (!sameReservation)
        return false;
    if ('adoption_token_hash' in persisted && persisted.adoption_token_hash !== sidecar.adoption_token_hash)
        return false;
    if (task.recovery_reservation) {
        return task.status === 'pending' && task.version === sidecar.old_task_version + 1 && !task.owner && !task.claim;
    }
    return task.status === 'in_progress' && task.version === sidecar.old_task_version + 2 && task.owner === input.workerName
        && !!task.claim && task.claim.owner === input.workerName;
}
async function hasBootstrapActiveRecoveryEvidence(teamName, cwd, input, config) {
    const bootstrap = input.bootstrap;
    const active = config.active_recovery;
    if (!bootstrap || !active)
        return true;
    if (!config.instance_id || config.instance_id.toLowerCase() !== input.instanceId.toLowerCase())
        return false;
    if (active.request_id !== input.requestId || active.recovery_id !== bootstrap.recoveryId
        || active.worker_name !== input.workerName)
        return false;
    const worker = config.workers.find(candidate => candidate.name === input.workerName);
    const replacementGeneration = worker?.recovery_id === active.recovery_id && Number.isSafeInteger(worker.replacement_generation)
        ? worker.replacement_generation
        : (worker?.replacement_generation ?? 0) + 1;
    let attempt;
    try {
        attempt = validateRecoveryAttemptSecret(JSON.parse(await readFile(absPath(cwd, TeamPaths.recoveryAttempt(teamName, active.recovery_id)), 'utf8')), input, active.recovery_id, replacementGeneration);
    }
    catch {
        return false;
    }
    let tasks;
    try {
        tasks = await teamListTasks(teamName, cwd);
    }
    catch {
        return false;
    }
    const continuations = tasks.filter(task => task.recovery_reservation?.recovery_id === active.recovery_id
        || task.recovery_adoption?.recovery_id === active.recovery_id);
    const untouchedClaims = tasks.filter(task => task.status === 'in_progress' && task.owner === input.workerName
        && !continuations.some(continuation => continuation.id === task.id));
    if (continuations.length === 0 && untouchedClaims.length === 0)
        return true;
    for (const task of continuations) {
        let sidecar;
        try {
            sidecar = JSON.parse(await readFile(absPath(cwd, TeamPaths.taskRecoverySidecar(teamName, active.recovery_id, task.id)), 'utf8'));
        }
        catch {
            return false;
        }
        if (!isExactRecoverySidecar(sidecar, task, input, active, replacementGeneration, attempt.adoption_token))
            return false;
        const verified = sidecar;
        const checkpoint = await readTaskRecoveryCheckpoint(verified.checkpoint_path);
        if (!checkpoint.ok || checkpoint.checkpoint.team_name !== teamName || checkpoint.checkpoint.task_id !== task.id
            || checkpoint.checkpoint.worker_name !== verified.old_owner || checkpoint.checkpoint.task_version !== verified.old_task_version
            || checkpoint.checkpoint.claim_token !== verified.old_claim_token || checkpoint.checkpoint.sequence !== verified.continuation_sequence
            || checkpoint.checkpoint.resume_payload_hash !== verified.checkpoint_hash)
            return false;
    }
    for (const task of untouchedClaims) {
        const checkpoint = await selectTaskRecoveryCheckpoint(teamName, { ...task, version: task.version ?? 1 }, cwd);
        if (!checkpoint.ok)
            return false;
    }
    return true;
}
async function ensureRecoveryOwner(teamName, cwd, input, waitOptions, instance) {
    let current = await readRevisionedTeamConfig(teamName, cwd);
    if (!current)
        current = await migrateTeamConfigRevision(teamName, cwd);
    if (!current)
        throw new Error('invalid_persisted_state');
    await assertTeamInstanceUnderLock(instance);
    const processStartedAt = currentProcessStartIdentity();
    if (!processStartedAt)
        throw new Error('process_start_identity_unavailable');
    const bootstrap = input.bootstrap;
    let owner = readLatestOwnerEpoch(cwd, teamName);
    let bootstrapPredecessor = null;
    let exactDeadOrphan = false;
    if (bootstrap) {
        if (bootstrap.expectedEpoch !== bootstrap.predecessorEpoch + 1 || bootstrap.pid !== process.pid
            || bootstrap.processStartedAt !== processStartedAt || bootstrap.nonce.length === 0
            || !await hasBootstrapRecoveryEvidence(teamName, cwd, input, waitOptions)) {
            throw new Error('runtime_owner_bootstrap_fence_lost');
        }
        const predecessor = owner;
        bootstrapPredecessor = predecessor;
        const alreadyPublished = predecessor?.epoch === bootstrap.expectedEpoch && predecessor.pid === bootstrap.pid
            && predecessor.process_started_at === bootstrap.processStartedAt && predecessor.nonce === bootstrap.nonce;
        exactDeadOrphan = !alreadyPublished && await isExactDeadOrphanBootstrapCandidate(teamName, cwd, input, current.config, predecessor);
        if (alreadyPublished) {
            const configAlreadyBound = current.config.runtime_owner_epoch?.epoch === bootstrap.expectedEpoch
                && current.config.runtime_owner_epoch?.nonce === bootstrap.nonce;
            const retryFromNoOwner = bootstrap.predecessorEpoch === 0 && !current.config.runtime_owner_epoch
                && (!current.config.active_recovery || await hasBootstrapActiveRecoveryEvidence(teamName, cwd, input, current.config));
            const retryFromPredecessor = bootstrap.predecessorEpoch > 0
                && current.config.runtime_owner_epoch?.epoch === bootstrap.predecessorEpoch
                && current.config.runtime_owner_epoch?.nonce === bootstrap.predecessorNonce
                && current.config.active_recovery?.owner_epoch === bootstrap.predecessorEpoch
                && current.config.active_recovery?.owner_nonce === bootstrap.predecessorNonce
                && await hasBootstrapActiveRecoveryEvidence(teamName, cwd, input, current.config);
            if (!configAlreadyBound && !retryFromNoOwner && !retryFromPredecessor) {
                throw new Error('runtime_owner_bootstrap_rebind_rejected');
            }
            owner = predecessor;
        }
        else {
            const bootstrapFromNoOwner = bootstrap.predecessorEpoch === 0;
            if (bootstrapFromNoOwner) {
                if (predecessor || current.config.runtime_owner_epoch
                    || (current.config.active_recovery && !await hasBootstrapActiveRecoveryEvidence(teamName, cwd, input, current.config))) {
                    throw new Error('runtime_owner_bootstrap_fence_lost');
                }
            }
            else if (!exactDeadOrphan && (!predecessor || predecessor.epoch !== bootstrap.predecessorEpoch
                || predecessor.nonce !== bootstrap.predecessorNonce || predecessor.pid !== bootstrap.predecessorPid
                || predecessor.process_started_at !== bootstrap.predecessorProcessStartedAt || !isProcessIdentityDead(predecessor)
                || current.config.runtime_owner_epoch?.epoch !== predecessor.epoch
                || current.config.runtime_owner_epoch?.nonce !== predecessor.nonce
                || current.config.active_recovery?.owner_epoch !== predecessor.epoch
                || current.config.active_recovery?.owner_nonce !== predecessor.nonce
                || !await hasBootstrapActiveRecoveryEvidence(teamName, cwd, input, current.config))) {
                throw new Error('runtime_owner_bootstrap_fence_lost');
            }
            owner = publishOwnerEpoch(cwd, teamName, bootstrap.expectedEpoch, {
                pid: bootstrap.pid,
                processStartedAt: bootstrap.processStartedAt,
                nonce: bootstrap.nonce,
            });
            if (owner.epoch !== bootstrap.expectedEpoch || owner.pid !== bootstrap.pid
                || owner.process_started_at !== bootstrap.processStartedAt || owner.nonce !== bootstrap.nonce) {
                throw new Error('runtime_owner_bootstrap_fence_lost');
            }
        }
    }
    else if (!owner) {
        owner = publishOwnerEpoch(cwd, teamName, 1);
    }
    else if (owner.pid !== process.pid || owner.process_started_at !== processStartedAt) {
        throw new Error('runtime_owner_fence_lost');
    }
    const fence = { epoch: owner.epoch, nonce: owner.nonce };
    requireOwnerFence(cwd, teamName, fence);
    requireOwnerProcessIdentity(owner, process.pid, processStartedAt);
    for (let bindAttempt = 0; bindAttempt < 3 && (current.config.runtime_owner_epoch?.epoch !== owner.epoch
        || current.config.runtime_owner_epoch?.nonce !== owner.nonce); bindAttempt++) {
        await assertTeamInstanceUnderLock(instance);
        if (current.config.runtime_owner_epoch && (current.config.runtime_owner_epoch.epoch !== owner.epoch
            || current.config.runtime_owner_epoch.nonce !== owner.nonce)
            && !(bootstrap && exactDeadOrphan && await isExactDeadOrphanBootstrapCandidate(teamName, cwd, input, current.config, bootstrapPredecessor))) {
            throw new Error('runtime_owner_bootstrap_rebind_rejected');
        }
        if (bootstrap && current.config.active_recovery
            && !await hasBootstrapActiveRecoveryEvidence(teamName, cwd, input, current.config)) {
            throw new Error('runtime_owner_bootstrap_fence_lost');
        }
        const nextRevision = current.stateRevision + 1;
        const bootstrapWorker = bootstrap
            ? current.config.workers.find(candidate => candidate.name === input.workerName)
            : undefined;
        const next = {
            ...current.config,
            state_revision: nextRevision,
            runtime_owner_epoch: owner,
            ...(current.config.service_descriptor ? {
                service_descriptor: {
                    ...current.config.service_descriptor,
                    service_generation: current.config.service_descriptor.service_generation + 1,
                    service_attempt_id: `${owner.epoch}:${owner.nonce}`,
                },
            } : {}),
            lifecycle_state: current.config.lifecycle_state ?? 'active',
            active_recovery: current.config.active_recovery
                ? { ...current.config.active_recovery, owner_epoch: owner.epoch, owner_nonce: owner.nonce,
                    state_revision: nextRevision, updated_at: new Date().toISOString() }
                : bootstrap ? {
                    request_id: input.requestId,
                    recovery_id: bootstrap.recoveryId,
                    worker_name: input.workerName,
                    owner_epoch: owner.epoch,
                    owner_nonce: owner.nonce,
                    phase: 'reserved',
                    state_revision: nextRevision,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    ...(bootstrapWorker?.pane_id?.trim() ? { original_pane_id: bootstrapWorker.pane_id } : {}),
                } : undefined,
        };
        if (await saveTeamConfigAtRevision(next, current.stateRevision, cwd)) {
            current = { config: next, stateRevision: nextRevision };
            break;
        }
        await assertTeamInstanceUnderLock(instance);
        const retry = await readRevisionedTeamConfig(teamName, cwd);
        if (!retry)
            throw new Error('invalid_persisted_state');
        current = retry;
    }
    if (!current)
        throw new Error('invalid_persisted_state');
    if (current.config.runtime_owner_epoch?.epoch !== owner.epoch
        || current.config.runtime_owner_epoch?.nonce !== owner.nonce)
        throw new Error('stale_state_revision');
    return { fence, config: current.config, stateRevision: current.stateRevision };
}
/** Establish the exact successor/config binding before a detached owner may execute or maintain. */
export async function prepareRecoveryOwnerBootstrap(input, waitOptions) {
    const bootstrap = input.bootstrap;
    if (!bootstrap)
        throw new Error('runtime_owner_bootstrap_fence_lost');
    if (!isValidTeamInstanceId(input.instanceId))
        throw new Error('team_instance_identity_missing');
    const expectedInstanceId = input.instanceId;
    const initial = await readRevisionedTeamConfig(input.teamName, input.cwd);
    if (!initial?.config.instance_id)
        throw new Error('team_instance_authority_missing');
    if (initial.config.instance_id.toLowerCase() !== expectedInstanceId.toLowerCase()) {
        throw new Error('team_instance_mismatch');
    }
    const instance = createTeamInstanceBinding({
        teamName: input.teamName,
        cwd: input.cwd,
        instanceId: expectedInstanceId,
    });
    const owner = await withTeamInstanceLifecycleLock(instance.cwd, instance.team_name, () => ensureRecoveryOwner(input.teamName, input.cwd, input, waitOptions, instance));
    if (owner.fence.epoch !== bootstrap.expectedEpoch
        || owner.config.runtime_owner_epoch?.epoch !== owner.fence.epoch
        || owner.config.runtime_owner_epoch.nonce !== owner.fence.nonce) {
        throw new Error('runtime_owner_bootstrap_rebind_rejected');
    }
    const active = owner.config.active_recovery;
    if (!active || active.request_id !== input.requestId || active.recovery_id !== bootstrap.recoveryId
        || active.worker_name !== input.workerName || active.owner_epoch !== owner.fence.epoch
        || active.owner_nonce !== owner.fence.nonce) {
        throw new Error('runtime_owner_bootstrap_rebind_rejected');
    }
}
/** Private runtime-owner executor. It never calls the public recovery facade. */
export async function executeRecoverDeadWorkerV2Owner(input) {
    const reservation = readRecoveryRequestReservation(input.cwd, input.requestId);
    const recoveryId = reservation?.recovery_id ?? randomUUID();
    let ownerBound = false;
    try {
        if (!isValidTeamInstanceId(input.instanceId)) {
            return recoveryError(input, recoveryId, 'invalid_persisted_state', 'team_instance_identity_missing');
        }
        if (reservation && (reservation.team_name !== input.teamName
            || reservation.worker_name !== input.workerName
            || reservation.instance_id.toLowerCase() !== input.instanceId.toLowerCase())) {
            return recoveryError(input, recoveryId, 'invalid_persisted_state', 'recovery_instance_mismatch');
        }
        const expectedInstanceId = input.instanceId;
        const beforeOwner = await readRevisionedTeamConfig(input.teamName, input.cwd);
        if (beforeOwner?.config.active_scale_down || (beforeOwner?.config && scaleUpFenceBlocks(beforeOwner.config))) {
            return recoveryError(input, recoveryId, 'team_mutation_busy');
        }
        if (!beforeOwner?.config.instance_id) {
            return recoveryError(input, recoveryId, 'invalid_persisted_state', 'team_instance_identity_unknown');
        }
        if (beforeOwner.config.instance_id.toLowerCase() !== expectedInstanceId.toLowerCase()) {
            return recoveryError(input, recoveryId, 'invalid_persisted_state', 'team_instance_mismatch');
        }
        const instance = createTeamInstanceBinding({
            teamName: input.teamName,
            cwd: input.cwd,
            instanceId: expectedInstanceId,
        });
        let existingAttempt;
        const owner = await withTeamInstanceLifecycleLock(instance.cwd, instance.team_name, async () => {
            await assertTeamInstanceUnderLock(instance);
            let electedOwner = await ensureRecoveryOwner(input.teamName, input.cwd, input, undefined, instance);
            existingAttempt = electedOwner.config.active_recovery;
            if (!existingAttempt) {
                const nextRevision = electedOwner.stateRevision + 1;
                const electedConfig = {
                    ...electedOwner.config,
                    state_revision: nextRevision,
                    active_recovery: {
                        request_id: input.requestId,
                        recovery_id: recoveryId,
                        worker_name: input.workerName,
                        owner_epoch: electedOwner.fence.epoch,
                        owner_nonce: electedOwner.fence.nonce,
                        phase: 'reserved',
                        state_revision: nextRevision,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    },
                };
                if (!await saveTeamConfigAtRevision(electedConfig, electedOwner.stateRevision, input.cwd)) {
                    throw new Error('stale_state_revision');
                }
                existingAttempt = electedConfig.active_recovery;
                electedOwner = { ...electedOwner, config: electedConfig, stateRevision: nextRevision };
            }
            await assertTeamInstanceUnderLock(instance);
            return electedOwner;
        });
        ownerBound = true;
        if (existingAttempt && (existingAttempt.request_id !== input.requestId
            || existingAttempt.recovery_id !== recoveryId || existingAttempt.worker_name !== input.workerName)) {
            return recoveryError(input, recoveryId, 'team_mutation_busy');
        }
        if (owner.config.lifecycle_state === 'shutting_down' || owner.config.lifecycle_state === 'stopped') {
            return finalizeBoundRecoveryOwnerTerminal(input, recoveryId, recoveryError(input, recoveryId, 'team_shutting_down'));
        }
        if (owner.config.active_scale_down || scaleUpFenceBlocks(owner.config))
            return recoveryError(input, recoveryId, 'team_mutation_busy');
        const worker = owner.config.workers.find(candidate => candidate.name === input.workerName);
        if (!worker)
            return finalizeBoundRecoveryOwnerTerminal(input, recoveryId, recoveryError(input, recoveryId, 'worker_not_found'));
        if (!worker.launch_descriptor)
            return finalizeBoundRecoveryOwnerTerminal(input, recoveryId, recoveryError(input, recoveryId, 'launch_metadata_incomplete'));
        let launchDescriptor;
        try {
            launchDescriptor = validateWorkerLaunchDescriptor(worker.launch_descriptor);
            if (worker.worker_cli !== launchDescriptor.provider)
                throw new Error('provider mismatch');
        }
        catch {
            return finalizeBoundRecoveryOwnerTerminal(input, recoveryId, recoveryError(input, recoveryId, 'launch_descriptor_unresolvable'));
        }
        if (!owner.config.tmux_session)
            return finalizeBoundRecoveryOwnerTerminal(input, recoveryId, recoveryError(input, recoveryId, 'team_session_dead'));
        if (owner.config.tmux_session.startsWith('cmux:')) {
            if (!owner.config.leader_pane_id || !await workerPaneBelongsToOwnedProviderTarget({
                provider: 'cmux',
                providerTarget: owner.config.tmux_session,
                paneId: owner.config.leader_pane_id,
            }))
                return finalizeBoundRecoveryOwnerTerminal(input, recoveryId, recoveryError(input, recoveryId, 'team_session_dead'));
        }
        else {
            const tmuxServerIdentity = owner.config.tmux_server_identity;
            if (!isValidTmuxServerIdentity(tmuxServerIdentity)) {
                return finalizeBoundRecoveryOwnerTerminal(input, recoveryId, recoveryError(input, recoveryId, 'team_session_dead'));
            }
            const serverState = await observeTmuxServerIdentity(tmuxServerIdentity);
            if (serverState === 'unknown') {
                return finalizeBoundRecoveryOwnerTerminal(input, recoveryId, recoveryError(input, recoveryId, 'team_session_dead'));
            }
            if (serverState === 'matching'
                && (!owner.config.leader_pane_id || !await workerPaneBelongsToOwnedProviderTarget({
                    provider: 'tmux',
                    providerTarget: owner.config.tmux_session,
                    paneId: owner.config.leader_pane_id,
                    tmuxServerIdentity,
                }))) {
                return finalizeBoundRecoveryOwnerTerminal(input, recoveryId, recoveryError(input, recoveryId, 'team_session_dead'));
            }
        }
        const replacementGeneration = existingAttempt && worker.recovery_id === recoveryId
            && typeof worker.replacement_generation === 'number'
            ? worker.replacement_generation
            : (worker.replacement_generation ?? 0) + 1;
        const attempt = await readOrCreateRecoveryAttempt(input, recoveryId, replacementGeneration);
        const originalPaneId = existingAttempt?.original_pane_id ?? worker.pane_id;
        const sagaInput = {
            requestId: input.requestId,
            recoveryId,
            teamName: input.teamName,
            workerName: input.workerName,
            replacementGeneration: attempt.replacement_generation,
            adoptionToken: attempt.adoption_token,
            originalPaneId,
        };
        const ensureFence = async () => {
            requireOwnerFence(input.cwd, input.teamName, owner.fence);
            await withTeamInstanceLifecycleLock(instance.cwd, instance.team_name, () => assertTeamInstanceUnderLock(instance));
            const current = await readRevisionedTeamConfig(input.teamName, input.cwd);
            if (!current || current.config.active_scale_down
                || scaleUpFenceBlocks(current.config)
                || current.config.active_recovery?.recovery_id !== recoveryId
                || current.config.active_recovery.owner_epoch !== owner.fence.epoch
                || current.config.active_recovery.owner_nonce !== owner.fence.nonce) {
                throw new Error('runtime_owner_fence_lost');
            }
            return current.config;
        };
        let committedReplacementLiveness = null;
        const deps = {
            cwd: input.cwd,
            isCommittedReplacement: async (sagaInput) => {
                const current = await ensureFence();
                const currentWorker = current.workers.find(candidate => candidate.name === sagaInput.workerName);
                if (!currentWorker)
                    return false;
                return resolveCommittedRecoveryPaneAttempt(current.active_recovery, sagaInput.recoveryId, sagaInput.replacementGeneration, currentWorker) !== null;
            },
            getLiveness: async () => {
                const config = await ensureFence();
                const currentWorker = config.workers.find(candidate => candidate.name === input.workerName);
                const committedReplacement = existingAttempt?.recovery_id === recoveryId
                    && currentWorker?.recovery_id === recoveryId
                    && currentWorker.replacement_generation === attempt.replacement_generation
                    && Boolean(currentWorker.pane_id && currentWorker.pane_attempt_id);
                if (!committedReplacement) {
                    if (!originalPaneId?.trim() || currentWorker?.pane_id !== originalPaneId) {
                        const currentLaunch = await loadCurrentWorkerLaunchAttempt({
                            cwd: input.cwd,
                            teamName: input.teamName,
                            instanceId: instance.instance_id,
                            workerName: input.workerName,
                            provider: launchDescriptor.provider,
                        });
                        if (!currentLaunch)
                            return 'unknown';
                        if (!config.leader_pane_id)
                            return 'unknown';
                        let currentPaneLiveness;
                        let adoptedOwnership = null;
                        if (currentLaunch.pane_id.startsWith('%')) {
                            const serverIdentity = config.tmux_server_identity;
                            if (!isValidTmuxServerIdentity(serverIdentity))
                                return 'unknown';
                            const serverState = await observeTmuxServerIdentity(serverIdentity);
                            if (serverState === 'unknown')
                                return 'unknown';
                            if (serverState === 'dead') {
                                // A dead original tmux server proves its panes absent, but
                                // provider cleanup below still relies on the launch receipt.
                                currentPaneLiveness = 'dead';
                            }
                            else {
                                const adopted = await adoptWorkerPaneOwnership({
                                    provider: 'tmux',
                                    providerTarget: config.tmux_session,
                                    paneId: currentLaunch.pane_id,
                                    leaderPaneId: config.leader_pane_id,
                                    reservedPaneIds: config.workers
                                        .filter(candidate => candidate.name !== input.workerName)
                                        .map(candidate => candidate.pane_id)
                                        .filter((paneId) => Boolean(paneId)),
                                    tmuxServerIdentity: serverIdentity,
                                });
                                if (!adopted.ok)
                                    return 'unknown';
                                adoptedOwnership = adopted.ownership;
                                currentPaneLiveness = await getOwnedWorkerLiveness(adopted.ownership);
                            }
                        }
                        else {
                            const adopted = await adoptWorkerPaneOwnership({
                                provider: 'cmux',
                                providerTarget: config.tmux_session,
                                paneId: currentLaunch.pane_id,
                                leaderPaneId: config.leader_pane_id,
                                reservedPaneIds: config.workers
                                    .filter(candidate => candidate.name !== input.workerName)
                                    .map(candidate => candidate.pane_id)
                                    .filter((paneId) => Boolean(paneId)),
                            });
                            if (!adopted.ok)
                                return 'unknown';
                            adoptedOwnership = adopted.ownership;
                            currentPaneLiveness = await getOwnedWorkerLiveness(adopted.ownership);
                        }
                        const currentLiveness = await getWorkerExecutionLiveness(input.teamName, input.cwd, instance.instance_id, {
                            name: input.workerName,
                            pane_id: currentLaunch.pane_id,
                            worker_cli: launchDescriptor.provider,
                            launch_attempt_id: currentLaunch.attempt_id,
                            launch_descriptor: launchDescriptor,
                        });
                        if (currentLaunch.context?.kind === 'recovery') {
                            if (currentLaunch.context.recovery_id !== recoveryId
                                || currentLaunch.context.replacement_generation !== attempt.replacement_generation)
                                return 'unknown';
                            if (currentLiveness === 'unknown')
                                return 'unknown';
                            if (currentLiveness === 'alive' && currentPaneLiveness !== 'alive')
                                return 'alive';
                            return 'dead';
                        }
                        if (currentLaunch.context?.kind !== 'initial' || currentLiveness !== 'alive' || !currentWorker) {
                            return currentLiveness;
                        }
                        if (currentPaneLiveness !== 'alive')
                            return 'alive';
                        if (!adoptedOwnership)
                            return currentLiveness;
                        const reconciled = await withWorkerLaunchAttemptFence(currentLaunch, async () => {
                            await ensureFence();
                            const latest = await readRevisionedTeamConfig(input.teamName, input.cwd);
                            if (!latest)
                                return false;
                            const latestWorker = latest.config.workers.find(candidate => candidate.name === input.workerName);
                            if (!latestWorker)
                                return false;
                            const nextRevision = latest.stateRevision + 1;
                            const next = {
                                ...latest.config,
                                state_revision: nextRevision,
                                active_recovery: latest.config.active_recovery
                                    ? { ...latest.config.active_recovery, state_revision: nextRevision, updated_at: new Date().toISOString() }
                                    : undefined,
                                workers: latest.config.workers.map(candidate => candidate.name === input.workerName
                                    ? {
                                        ...candidate,
                                        pane_id: currentLaunch.pane_id,
                                        launch_attempt_id: currentLaunch.attempt_id,
                                        worker_cli: currentLaunch.provider,
                                        operational_state: 'active',
                                    }
                                    : candidate),
                            };
                            return saveTeamConfigAtRevision(next, latest.stateRevision, input.cwd);
                        });
                        if (!reconciled.ok || !reconciled.value)
                            return 'unknown';
                        sagaInput.originalPaneId = currentLaunch.pane_id;
                        return 'alive';
                    }
                    if (!currentWorker?.launch_attempt_id || !currentWorker.pane_id)
                        return 'unknown';
                    const originalLaunch = await loadWorkerLaunchAttempt({
                        cwd: input.cwd,
                        teamName: input.teamName,
                        instanceId: instance.instance_id,
                        workerName: input.workerName,
                        paneId: currentWorker.pane_id,
                        provider: launchDescriptor.provider,
                        attemptId: currentWorker.launch_attempt_id,
                        runtimeCliPath: resolveRuntimeCliPath(),
                    });
                    if (!originalLaunch)
                        return 'unknown';
                    return getWorkerExecutionLiveness(input.teamName, input.cwd, instance.instance_id, {
                        name: input.workerName,
                        pane_id: currentWorker.pane_id,
                        worker_cli: launchDescriptor.provider,
                        launch_attempt_id: currentWorker.launch_attempt_id,
                        launch_descriptor: launchDescriptor,
                    });
                }
                committedReplacementLiveness = currentWorker
                    ? await getWorkerExecutionLiveness(input.teamName, input.cwd, instance.instance_id, currentWorker)
                    : 'unknown';
                return committedReplacementLiveness;
            },
            listOwnedInProgressTasks: async () => selectRecoveryReplayTasks(await teamListTasks(input.teamName, input.cwd), input.workerName, recoveryId, committedReplacementLiveness),
            validateCheckpoint: async (teamName, task) => {
                const persisted = task.recovery_reservation ?? task.recovery_adoption;
                if (persisted?.recovery_id === recoveryId) {
                    const selected = await readTaskRecoveryCheckpoint(persisted.checkpoint_path);
                    if (selected.ok && selected.checkpoint.sequence === persisted.continuation_sequence
                        && selected.checkpoint.resume_payload_hash === persisted.checkpoint_hash) {
                        return { ok: true, sequence: selected.checkpoint.sequence };
                    }
                    return { ok: false, error: selected.ok ? 'recovery_checkpoint_stale'
                            : `recovery_checkpoint_${selected.error}` };
                }
                const selected = await selectTaskRecoveryCheckpoint(teamName, { ...task, version: task.version ?? 1 }, input.cwd);
                if (selected.ok)
                    return { ok: true, sequence: selected.checkpoint.sequence };
                const errorByState = {
                    missing: 'recovery_checkpoint_missing',
                    malformed: 'recovery_checkpoint_malformed',
                    stale: 'recovery_checkpoint_stale',
                    ambiguous: 'recovery_checkpoint_ambiguous',
                };
                return { ok: false, error: errorByState[selected.error] };
            },
            requeue: async (sagaInput, taskId, adoptionTokenHash) => {
                await ensureFence();
                const currentTask = await teamReadTask(input.teamName, taskId, input.cwd);
                if (currentTask?.recovery_adoption?.recovery_id === sagaInput.recoveryId) {
                    return { ok: true, sequence: currentTask.recovery_adoption.continuation_sequence };
                }
                const result = await teamRequeueRecoveredTask(input.teamName, input.cwd, {
                    recoveryId: sagaInput.recoveryId,
                    requestId: sagaInput.requestId,
                    taskId,
                    replacementWorker: sagaInput.workerName,
                    replacementGeneration: sagaInput.replacementGeneration,
                    adoptionTokenHash,
                });
                return result.ok
                    ? { ok: true, sequence: result.reservation.continuation_sequence }
                    : { ok: false, error: result.error.startsWith('checkpoint_')
                            ? `recovery_${result.error}`
                            : 'task_requeue_failed' };
            },
            spawnGatedPane: async (sagaInput) => {
                const config = await ensureFence();
                const currentWorker = config.workers.find(candidate => candidate.name === sagaInput.workerName);
                if (!currentWorker)
                    return { ok: false, error: 'worker_not_found' };
                const reservedPaneIds = config.workers
                    .filter(candidate => candidate.name !== sagaInput.workerName)
                    .map(candidate => candidate.pane_id)
                    .filter((paneId) => Boolean(paneId));
                const leaderPaneId = config.leader_pane_id ?? '';
                if (!leaderPaneId)
                    return { ok: false, error: 'spawn_failed' };
                const committedPane = resolveCommittedRecoveryPaneAttempt(existingAttempt, sagaInput.recoveryId, sagaInput.replacementGeneration, currentWorker);
                if (committedPane) {
                    const committedOwnership = configuredPaneOwnership(config, { pane_id: committedPane.paneId });
                    const committedPaneLiveness = committedOwnership
                        ? await getOwnedWorkerLiveness(committedOwnership)
                        : 'unknown';
                    if (committedPaneLiveness === 'unknown')
                        return { ok: false, error: 'runtime_owner_unavailable' };
                    if (committedPaneLiveness === 'alive') {
                        let pending = pendingRecoveryPanes.get(sagaInput.recoveryId);
                        if (!pending) {
                            const adopted = await adoptWorkerPaneOwnership({
                                provider: committedPane.paneId.startsWith('%') ? 'tmux' : 'cmux',
                                providerTarget: owner.config.tmux_session,
                                paneId: committedPane.paneId,
                                leaderPaneId,
                                reservedPaneIds,
                                ...(tmuxServerIdentityForTarget(owner.config.tmux_session, owner.config.tmux_server_identity)
                                    ? { tmuxServerIdentity: tmuxServerIdentityForTarget(owner.config.tmux_session, owner.config.tmux_server_identity) }
                                    : {}),
                            });
                            if (!adopted.ok)
                                return { ok: false, error: 'worker_activation_failed' };
                            try {
                                pending = await buildRecoveryPaneContext(input, sagaInput, currentWorker, launchDescriptor, adopted.ownership, committedPane.paneAttemptId, instance.instance_id);
                                if (!pending.startupContext)
                                    return { ok: false, error: 'worker_activation_failed' };
                                pendingRecoveryPanes.set(sagaInput.recoveryId, pending);
                            }
                            catch {
                                return { ok: false, error: 'launch_descriptor_unresolvable' };
                            }
                        }
                        const expected = {
                            recovery_id: sagaInput.recoveryId,
                            worker_name: sagaInput.workerName,
                            replacement_generation: sagaInput.replacementGeneration,
                            pane_attempt_id: committedPane.paneAttemptId,
                            launch_attempt_id: pending.startupContext.attempt.attempt_id,
                            launch_nonce: pending.startupContext.attempt.nonce,
                        };
                        const ready = await waitForRecoveryGateRecord(pending.gate.readyPath, expected, 1_000);
                        const manifest = await readTeamManifest(input.teamName, input.cwd);
                        const projected = manifest?.workers.find(candidate => candidate.name === sagaInput.workerName);
                        const projectedSameAttempt = projected?.pane_id === committedPane.paneId
                            && projected.pane_attempt_id === committedPane.paneAttemptId
                            && projected.recovery_id === sagaInput.recoveryId
                            && projected.replacement_generation === sagaInput.replacementGeneration;
                        if (!ready || !projectedSameAttempt)
                            return { ok: false, error: 'worker_activation_failed' };
                        return {
                            ok: true,
                            paneId: pending.ownership.paneId,
                            paneAttemptId: pending.paneAttemptId,
                            committed: true,
                            stateRevision: config.state_revision ?? 0,
                            manifestSync: 'synced',
                        };
                    }
                }
                const runtimeCliPath = resolveRuntimeCliPath();
                const currentLaunch = await loadCurrentWorkerLaunchAttempt({
                    cwd: input.cwd,
                    teamName: input.teamName,
                    instanceId: instance.instance_id,
                    workerName: sagaInput.workerName,
                    provider: launchDescriptor.provider,
                });
                if (currentLaunch) {
                    const currentLiveness = await getWorkerExecutionLiveness(input.teamName, input.cwd, instance.instance_id, {
                        name: sagaInput.workerName,
                        pane_id: currentLaunch.pane_id,
                        worker_cli: launchDescriptor.provider,
                        launch_attempt_id: currentLaunch.attempt_id,
                        launch_descriptor: launchDescriptor,
                    });
                    if (currentLiveness !== 'dead') {
                        const context = currentLaunch.context;
                        if (context?.kind !== 'recovery' || context.recovery_id !== sagaInput.recoveryId
                            || context.replacement_generation !== sagaInput.replacementGeneration) {
                            return { ok: false, error: 'worker_activation_failed' };
                        }
                        const adopted = await adoptWorkerPaneOwnership({
                            provider: currentLaunch.pane_id.startsWith('%') ? 'tmux' : 'cmux',
                            providerTarget: owner.config.tmux_session,
                            paneId: currentLaunch.pane_id,
                            leaderPaneId,
                            reservedPaneIds,
                            ...(tmuxServerIdentityForTarget(owner.config.tmux_session, owner.config.tmux_server_identity)
                                ? { tmuxServerIdentity: tmuxServerIdentityForTarget(owner.config.tmux_session, owner.config.tmux_server_identity) }
                                : {}),
                        });
                        if (!adopted.ok)
                            return { ok: false, error: 'worker_activation_failed' };
                        const resumed = await buildRecoveryPaneContext(input, sagaInput, currentWorker, launchDescriptor, adopted.ownership, context.pane_attempt_id, instance.instance_id);
                        resumed.startupContext = {
                            ownership: adopted.ownership,
                            attempt: currentLaunch,
                            provider: launchDescriptor.provider,
                        };
                        pendingRecoveryPanes.set(sagaInput.recoveryId, resumed);
                        const ready = await waitForRecoveryGateRecord(resumed.gate.readyPath, {
                            recovery_id: sagaInput.recoveryId,
                            worker_name: sagaInput.workerName,
                            replacement_generation: sagaInput.replacementGeneration,
                            pane_attempt_id: context.pane_attempt_id,
                            launch_attempt_id: currentLaunch.attempt_id,
                            launch_nonce: currentLaunch.nonce,
                        }, 5_000);
                        return ready
                            ? { ok: true, paneId: currentLaunch.pane_id, paneAttemptId: context.pane_attempt_id, committed: false }
                            : { ok: false, error: 'startup_ack_timeout' };
                    }
                }
                const priorLaunches = currentLaunch ? [currentLaunch] : [];
                if (currentWorker.launch_attempt_id) {
                    if (!currentWorker.pane_id)
                        return { ok: false, error: 'worker_cleanup_incomplete' };
                    if (currentLaunch?.attempt_id === currentWorker.launch_attempt_id) {
                        if (currentLaunch.pane_id !== currentWorker.pane_id) {
                            return { ok: false, error: 'worker_cleanup_incomplete' };
                        }
                    }
                    else {
                        const persistedLaunch = await loadWorkerLaunchAttempt({
                            cwd: input.cwd,
                            teamName: input.teamName,
                            instanceId: instance.instance_id,
                            workerName: sagaInput.workerName,
                            paneId: currentWorker.pane_id,
                            provider: launchDescriptor.provider,
                            attemptId: currentWorker.launch_attempt_id,
                            runtimeCliPath,
                        });
                        if (!persistedLaunch || !await isWorkerLaunchAttemptAccepted(persistedLaunch)) {
                            return { ok: false, error: 'worker_cleanup_incomplete' };
                        }
                        priorLaunches.push(persistedLaunch);
                    }
                }
                else if (currentWorker.pane_id) {
                    // A pane without an exact launch attempt has no provider
                    // termination authority. Never fall back to pane-only cleanup.
                    return { ok: false, error: 'worker_cleanup_incomplete' };
                }
                for (const priorLaunch of priorLaunches) {
                    const cleaned = await retireAndCleanupCurrentWorkerLaunchAttempt(priorLaunch, 'recovery_replacement', async () => {
                        const priorOwnership = configuredPaneOwnership(owner.config, { pane_id: priorLaunch.pane_id });
                        let paneLiveness = priorOwnership
                            ? await getOwnedWorkerLiveness(priorOwnership).catch(() => 'unknown')
                            : 'unknown';
                        if (paneLiveness === 'dead')
                            return true;
                        if (paneLiveness !== 'alive' || !owner.config.tmux_session || !leaderPaneId)
                            return false;
                        const adopted = await adoptWorkerPaneOwnership({
                            provider: priorLaunch.pane_id.startsWith('%') ? 'tmux' : 'cmux',
                            providerTarget: owner.config.tmux_session,
                            paneId: priorLaunch.pane_id,
                            leaderPaneId,
                            reservedPaneIds,
                            ...(tmuxServerIdentityForTarget(owner.config.tmux_session, owner.config.tmux_server_identity)
                                ? { tmuxServerIdentity: tmuxServerIdentityForTarget(owner.config.tmux_session, owner.config.tmux_server_identity) }
                                : {}),
                        });
                        if (!adopted.ok)
                            return false;
                        for (let cleanupAttempt = 0; cleanupAttempt < 2; cleanupAttempt++) {
                            await killOwnedWorkerPane(adopted.ownership).catch(() => undefined);
                            paneLiveness = await getOwnedWorkerLiveness(adopted.ownership).catch(() => 'unknown');
                            if (paneLiveness === 'dead')
                                return true;
                            if (paneLiveness !== 'alive')
                                return false;
                        }
                        return false;
                    });
                    if (!cleaned)
                        return { ok: false, error: 'worker_cleanup_incomplete' };
                }
                try {
                    const currentProviderPath = resolvePreflightBinaryPath(launchDescriptor.provider).path;
                    const sameProviderPath = process.platform === 'win32'
                        ? currentProviderPath.toLowerCase() === launchDescriptor.binary.toLowerCase()
                        : currentProviderPath === launchDescriptor.binary;
                    if (!sameProviderPath)
                        throw new Error('provider path changed');
                }
                catch {
                    return { ok: false, error: 'launch_descriptor_unresolvable' };
                }
                const paneAttemptId = randomUUID();
                const livePaneIds = [];
                for (const candidate of config.workers) {
                    if (!candidate.pane_id || candidate.name === sagaInput.workerName)
                        continue;
                    const candidateOwnership = configuredPaneOwnership(config, candidate);
                    if (candidateOwnership && await getOwnedWorkerLiveness(candidateOwnership) === 'alive') {
                        livePaneIds.push(candidate.pane_id);
                    }
                }
                const splitTarget = livePaneIds.at(-1) ?? leaderPaneId;
                const splitDirection = livePaneIds.length > 0 ? 'down' : 'right';
                const workerCwd = currentWorker.working_dir ?? input.cwd;
                const recoveryProvider = owner.config.tmux_session.startsWith('cmux:') ? 'cmux' : 'tmux';
                const tmuxServerIdentity = requireTmuxServerIdentity(owner.config.tmux_session, owner.config.tmux_server_identity);
                if (!await workerPaneBelongsToOwnedProviderTarget({
                    provider: recoveryProvider,
                    providerTarget: owner.config.tmux_session,
                    paneId: splitTarget,
                    ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
                }))
                    return { ok: false, error: 'worker_activation_failed' };
                const split = await splitTeamWorkerPaneWithEvidence(splitTarget, splitDirection, workerCwd, recoveryProvider, tmuxServerIdentity);
                const ownershipResult = proveWorkerPaneOwnership(split, {
                    providerTarget: owner.config.tmux_session,
                    leaderPaneId,
                    reservedPaneIds,
                    ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
                });
                if (!ownershipResult.ok) {
                    await recordUnaddressableRecoveryPaneFailure(input, sagaInput.recoveryId, paneAttemptId, `pane_identity_${ownershipResult.reason}`, split);
                    return { ok: false, error: 'spawn_failed' };
                }
                if (!await workerPaneBelongsToOwnedProviderTarget({
                    provider: ownershipResult.ownership.provider,
                    providerTarget: ownershipResult.ownership.providerTarget,
                    paneId: ownershipResult.ownership.paneId,
                    ...(ownershipResult.ownership.tmuxServerIdentity
                        ? { tmuxServerIdentity: ownershipResult.ownership.tmuxServerIdentity }
                        : {}),
                })) {
                    await recordUnaddressableRecoveryPaneFailure(input, sagaInput.recoveryId, paneAttemptId, 'pane_membership_unverified', split);
                    return { ok: false, error: 'worker_activation_failed' };
                }
                if (recoveryProvider === 'tmux') {
                    try {
                        await applyRequiredLayoutBeforeOwnedLaunch(owner.config.tmux_session, ownershipResult.ownership, sagaInput.workerName);
                    }
                    catch (error) {
                        return {
                            ok: false,
                            error: error instanceof Error && error.message.startsWith('worker_layout_cleanup_unverified:')
                                ? 'worker_cleanup_incomplete'
                                : 'spawn_failed',
                        };
                    }
                }
                let pending;
                try {
                    pending = await buildRecoveryPaneContext(input, sagaInput, currentWorker, launchDescriptor, ownershipResult.ownership, paneAttemptId, instance.instance_id);
                }
                catch {
                    return { ok: false, error: 'launch_descriptor_unresolvable' };
                }
                pendingRecoveryPanes.set(sagaInput.recoveryId, pending);
                try {
                    pending.startupContext = await spawnOwnedWorkerInPane(config.tmux_session, pending.ownership, {
                        teamName: input.teamName,
                        instanceId: instance.instance_id,
                        workerName: sagaInput.workerName,
                        envVars: { OMC_RECOVERY_GATE_SPEC: JSON.stringify(pending.gate) },
                        launchBinary: process.execPath,
                        launchArgs: [runtimeCliPath, '--recovery-gate'],
                        cwd: pending.gate.cwd,
                        provider: pending.agentType,
                        launchBootstrapPath: runtimeCliPath,
                        launchStateCwd: input.cwd,
                        launchContext: {
                            kind: 'recovery',
                            recovery_id: sagaInput.recoveryId,
                            replacement_generation: sagaInput.replacementGeneration,
                            pane_attempt_id: paneAttemptId,
                        },
                        ...(ownershipResult.ownership.tmuxServerIdentity
                            ? { tmuxServerIdentity: ownershipResult.ownership.tmuxServerIdentity }
                            : {}),
                    });
                    const ready = await waitForRecoveryGateRecord(pending.gate.readyPath, {
                        recovery_id: sagaInput.recoveryId,
                        worker_name: sagaInput.workerName,
                        replacement_generation: sagaInput.replacementGeneration,
                        pane_attempt_id: paneAttemptId,
                        launch_attempt_id: pending.startupContext.attempt.attempt_id,
                        launch_nonce: pending.startupContext.attempt.nonce,
                    }, 30_000);
                    if (!ready)
                        throw new Error('startup_ack_timeout');
                    return { ok: true, paneId: pending.ownership.paneId, paneAttemptId, committed: false };
                }
                catch (error) {
                    await withTeamInstanceLifecycleLock(instance.cwd, instance.team_name, async () => {
                        await assertTeamInstanceUnderLock(instance);
                        await cleanupRecoveryPaneAttempt(input, sagaInput.recoveryId, pending, error instanceof Error ? error.message : 'spawn_failed');
                    });
                    return {
                        ok: false,
                        error: error instanceof Error && error.message === 'startup_ack_timeout'
                            ? 'startup_ack_timeout'
                            : 'spawn_failed',
                    };
                }
            },
            persistActive: async (sagaInput, paneId) => {
                await ensureFence();
                const current = await readRevisionedTeamConfig(input.teamName, input.cwd);
                if (!current)
                    throw new Error('invalid_persisted_state');
                const pending = pendingRecoveryPanes.get(sagaInput.recoveryId);
                if (!pending?.startupContext)
                    throw new Error('worker_activation_failed');
                const nextWorkers = current.config.workers.map(candidate => candidate.name === sagaInput.workerName
                    ? {
                        ...candidate,
                        pane_id: paneId,
                        pane_attempt_id: pending.paneAttemptId,
                        recovery_id: sagaInput.recoveryId,
                        replacement_generation: sagaInput.replacementGeneration,
                        operational_state: 'active',
                        ...(pending.startupContext ? { launch_attempt_id: pending.startupContext.attempt.attempt_id } : {}),
                        ...(pending.agentType === 'cursor'
                            && shouldInjectContract(normalizeDelegationRole(pending.worker.role), pending.agentType)
                            ? { output_file: cliWorkerOutputFilePath(teamStateRoot(input.cwd, input.teamName), sagaInput.workerName, {
                                    taskId: pending.worker.assigned_tasks?.[0],
                                    assignmentId: `${sagaInput.recoveryId}-${sagaInput.replacementGeneration}`,
                                }) }
                            : {}),
                    }
                    : candidate);
                const nextRevision = current.stateRevision + 1;
                const next = {
                    ...current.config,
                    workers: nextWorkers,
                    state_revision: nextRevision,
                    active_recovery: current.config.active_recovery
                        ? { ...current.config.active_recovery, phase: 'active', state_revision: nextRevision, updated_at: new Date().toISOString() }
                        : current.config.active_recovery,
                };
                const persisted = await withWorkerLaunchAttemptFence(pending.startupContext.attempt, () => (saveTeamConfigAtRevision(next, current.stateRevision, input.cwd)));
                if (!persisted.ok)
                    throw new Error('worker_activation_failed');
                if (!persisted.value)
                    throw new Error('stale_state_revision');
                const manifestSync = await resolveCommittedRecoveryManifestSync(() => readTeamManifest(input.teamName, input.cwd), { workerName: sagaInput.workerName, paneId, paneAttemptId: pending.paneAttemptId,
                    recoveryId: sagaInput.recoveryId, replacementGeneration: sagaInput.replacementGeneration });
                return { stateRevision: nextRevision, manifestSync };
            },
            activatePane: async (sagaInput, paneAttemptId) => {
                await ensureFence();
                const pending = pendingRecoveryPanes.get(sagaInput.recoveryId);
                if (!pending || pending.paneAttemptId !== paneAttemptId)
                    return { ok: false, error: 'worker_activation_failed' };
                if (!pending.startupContext || !await isWorkerLaunchAttemptCurrent(pending.startupContext.attempt)) {
                    return { ok: false, error: 'worker_activation_failed' };
                }
                const record = { recovery_id: sagaInput.recoveryId, worker_name: sagaInput.workerName,
                    replacement_generation: sagaInput.replacementGeneration, pane_attempt_id: paneAttemptId,
                    launch_attempt_id: pending.startupContext.attempt.attempt_id,
                    launch_nonce: pending.startupContext.attempt.nonce,
                    written_at: new Date().toISOString() };
                await mkdir(join(pending.gate.activatePath, '..'), { recursive: true });
                await writeFile(pending.gate.activatePath, JSON.stringify(record), 'utf8');
                const adoptedReady = await waitForRecoveryGateRecord(`${pending.gate.readyPath}.adoption-ready`, record, 30_000);
                return adoptedReady && await isWorkerLaunchAttemptCurrent(pending.startupContext.attempt)
                    ? { ok: true }
                    : { ok: false, error: 'worker_activation_failed' };
            },
            adoptAll: async (sagaInput, proof, taskIds) => {
                const pending = pendingRecoveryPanes.get(sagaInput.recoveryId);
                if (!pending?.startupContext)
                    return { ok: false, error: 'worker_activation_failed' };
                const startupAttemptId = pending.startupContext.attempt.attempt_id;
                const adoption = await withWorkerLaunchAttemptFence(pending.startupContext.attempt, async () => {
                    await ensureFence();
                    return teamAdoptRecoveryReservations(input.teamName, input.cwd, taskIds, sagaInput.workerName, proof, startupAttemptId);
                });
                if (!adoption.ok)
                    return { ok: false, error: 'worker_activation_failed' };
                const results = adoption.value;
                const failed = results.find(result => !result.ok);
                if (failed && !failed.ok) {
                    return { ok: false, error: failed.error.startsWith('checkpoint_')
                            ? `recovery_${failed.error}`
                            : 'worker_activation_failed' };
                }
                const continuations = results
                    .filter((result) => result.ok)
                    .map(result => ({ taskId: result.task.id, taskVersion: result.task.version ?? 1,
                    sequence: result.checkpoint.sequence, payload: result.checkpoint.resume_payload, claimToken: result.claimToken }));
                return { ok: true, continuations };
            },
            repairServices: async () => {
                await ensureFence();
                const config = await readTeamConfig(input.teamName, input.cwd);
                return config ? reconcileCommittedTeamServices(config, input.cwd) : 'repair_required';
            },
            writeRun: async (sagaInput, paneAttemptId, continuations) => {
                await ensureFence();
                const pending = pendingRecoveryPanes.get(sagaInput.recoveryId);
                if (!pending || pending.paneAttemptId !== paneAttemptId || !pending.startupContext) {
                    throw new Error('worker_activation_failed');
                }
                const startupContext = pending.startupContext;
                const startupAttemptId = startupContext.attempt.attempt_id;
                const primaryTaskId = continuations[0]?.taskId;
                const startupBaseline = primaryTaskId
                    ? await captureWorkerStartupBaseline(input.teamName, sagaInput.workerName, primaryTaskId, input.cwd)
                    : null;
                const statusBaseline = startupBaseline?.statusFingerprint
                    ?? workerStatusStartupFingerprint(await readWorkerStatus(input.teamName, sagaInput.workerName, input.cwd));
                const evidencePolicy = getWorkerStartupEvidencePolicy(pending.agentType);
                const waitForCurrentEvidence = (budgetMs) => primaryTaskId && startupBaseline
                    ? waitForWorkerStartupEvidence(input.teamName, sagaInput.workerName, primaryTaskId, input.cwd, startupBaseline, startupAttemptId, budgetMs)
                    : waitForWorkerStatusTransition(input.teamName, sagaInput.workerName, input.cwd, statusBaseline, startupAttemptId, budgetMs);
                const probeActivity = pending.agentType === 'cursor' || pending.agentType === 'codex'
                    ? () => probeStartupPaneActivity(startupContext, { attemptAlreadyFenced: true })
                    : undefined;
                const waitForBoundedStartupEvidence = (resubmit) => settleStartupEvidence(evidencePolicy, waitForCurrentEvidence, resubmit, probeActivity);
                const instruction = continuations.length > 0
                    ? continuations.map(continuation => {
                        const continuationInstruction = renderRecoveryContinuationInstruction({
                            teamName: input.teamName,
                            workerName: sagaInput.workerName,
                            taskId: continuation.taskId,
                            taskVersion: continuation.taskVersion,
                            claimToken: continuation.claimToken,
                            sequence: continuation.sequence,
                            resumePayload: continuation.payload,
                        });
                        const recoveryRole = normalizeDelegationRole(pending.worker.role);
                        const recoveryContract = pending.agentType === 'cursor'
                            && shouldInjectContract(recoveryRole, pending.agentType)
                            ? renderCliWorkerOutputContract(recoveryRole, cliWorkerOutputFilePath(teamStateRoot(input.cwd, input.teamName), sagaInput.workerName, {
                                taskId: continuation.taskId,
                                assignmentId: `${sagaInput.recoveryId}-${sagaInput.replacementGeneration}`,
                            }), {
                                taskId: continuation.taskId,
                                claimToken: continuation.claimToken,
                                taskVersion: continuation.taskVersion,
                                launchAttemptId: startupAttemptId,
                            })
                            : '';
                        return `${continuationInstruction}${recoveryContract ? `\n${recoveryContract}` : ''}`;
                    }).join('\n\n')
                    : 'Recovery completed for this idle worker. Wait for a real team task assignment and do not create or claim fake work.';
                const inboxPublished = await withWorkerLaunchAttemptFence(startupContext.attempt, async () => {
                    await ensureFence();
                    await composeInitialInbox(input.teamName, sagaInput.workerName, instruction, input.cwd);
                    return true;
                });
                if (!inboxPublished.ok || !inboxPublished.value)
                    throw new Error('worker_activation_failed');
                const record = {
                    recovery_id: sagaInput.recoveryId,
                    worker_name: sagaInput.workerName,
                    replacement_generation: sagaInput.replacementGeneration,
                    pane_attempt_id: paneAttemptId,
                    launch_attempt_id: startupContext.attempt.attempt_id,
                    launch_nonce: startupContext.attempt.nonce,
                    written_at: new Date().toISOString(),
                };
                const launchedPath = `${pending.gate.runPath}.launched`;
                let launched = await waitForRecoveryGateRecord(launchedPath, record, 25, 5);
                if (!launched) {
                    const runPublished = await withWorkerLaunchAttemptFence(startupContext.attempt, async () => {
                        await ensureFence();
                        await writeFile(pending.gate.runPath, JSON.stringify(record), 'utf8');
                        return true;
                    });
                    if (!runPublished.ok || !runPublished.value)
                        throw new Error('worker_activation_failed');
                    launched = await waitForRecoveryGateRecord(launchedPath, record, 30_000);
                }
                if (!launched)
                    throw new Error('startup_ack_timeout');
                let providerLive = false;
                try {
                    const launchedRecord = JSON.parse(await readFile(launchedPath, 'utf8'));
                    providerLive = Number.isInteger(launchedRecord.provider_pid)
                        && typeof launchedRecord.provider_start_identity === 'string'
                        && (launchedRecord.supervisor_completion_path === undefined
                            || (typeof launchedRecord.supervisor_completion_path === 'string'
                                && launchedRecord.supervisor_completion_path.trim().length > 0
                                && !existsSync(launchedRecord.supervisor_completion_path)))
                        && await isProcessIdentityLive(launchedRecord.provider_pid, launchedRecord.provider_start_identity, Date.now() + 1_000) === 'live';
                }
                catch { /* malformed or stale provider-start evidence fails closed */ }
                if (!providerLive)
                    throw new Error('worker_activation_failed');
                if (!await isWorkerLaunchAttemptCurrent(startupContext.attempt)
                    || await getOwnedWorkerLiveness(pending.ownership) !== 'alive') {
                    throw new Error('worker_activation_failed');
                }
                const effects = await withWorkerLaunchAttemptFence(startupContext.attempt, async () => {
                    await ensureFence();
                    if (promptModeRecoveryRequiresProgressEvidence(pending.promptMode, continuations.length)) {
                        if (!await waitForBoundedStartupEvidence())
                            return { ok: false, error: `${pending.agentType}_startup_evidence_missing` };
                    }
                    else if (pending.promptMode) {
                        // Idle prompt-mode recoveries (for example Gemini with no owned tasks)
                        // intentionally have no task/status progress to prove. At this point
                        // the activation gate has published launched evidence and the provider
                        // identity has been verified live, so waiting for fabricated progress
                        // would turn a successful idle recovery into a deterministic timeout.
                    }
                    else {
                        const recoveryTriggerMessage = `${generateTriggerMessage(input.teamName, sagaInput.workerName, workerInstructionStateRoot(input.cwd, input.teamName))} [launch:${startupContext.attempt.attempt_id.slice(0, 12)}]`;
                        const outcome = await queueInboxInstruction({
                            teamName: input.teamName,
                            workerName: sagaInput.workerName,
                            workerIndex: pending.worker.index,
                            paneId: pending.ownership.paneId,
                            inbox: instruction,
                            triggerMessage: recoveryTriggerMessage,
                            cwd: input.cwd,
                            transportPreference: 'transport_direct',
                            fallbackAllowed: DEFAULT_TEAM_TRANSPORT_POLICY.dispatch_mode === 'hook_preferred_with_fallback',
                            inboxCorrelationKey: `recovery:${sagaInput.recoveryId}:${startupContext.attempt.attempt_id}`,
                            notify: async (_target, triggerMessage) => {
                                const attempted = await deliverStartupInbox(startupContext, triggerMessage, { attemptAlreadyFenced: true });
                                if (!attempted.ok) {
                                    return { ok: false, transport: 'tmux_send_keys', reason: `worker_notify_failed:${attempted.reason}` };
                                }
                                const settled = await waitForBoundedStartupEvidence(pending.agentType === 'cursor' || pending.agentType === 'codex'
                                    ? undefined
                                    : () => retryStartupInboxSubmit(startupContext, triggerMessage, { attemptAlreadyFenced: true }));
                                return settled
                                    ? { ok: true, transport: 'tmux_send_keys', reason: 'worker_startup_confirmed' }
                                    : { ok: false, transport: 'tmux_send_keys', reason: 'worker_startup_evidence_missing' };
                            },
                            deps: { writeWorkerInbox },
                        });
                        if (!outcome.ok)
                            return { ok: false, error: outcome.reason ?? 'worker_notify_failed' };
                    }
                    return { ok: true };
                });
                if (!effects.ok)
                    throw new Error('worker_activation_failed');
                if (!effects.value.ok)
                    throw new Error(effects.value.error);
                pendingRecoveryPanes.delete(sagaInput.recoveryId);
            },
            killAttemptPane: async (paneAttemptId) => {
                const pending = pendingRecoveryPanes.get(recoveryId);
                if (!pending || pending.paneAttemptId !== paneAttemptId)
                    return;
                await withTeamInstanceLifecycleLock(instance.cwd, instance.team_name, async () => {
                    await assertTeamInstanceUnderLock(instance);
                    const cleaned = await cleanupRecoveryPaneAttempt(input, recoveryId, pending, 'recovery_saga_rollback');
                    if (!cleaned)
                        throw new Error('worker_cleanup_incomplete');
                });
            },
        };
        const result = await runRecoverySaga(sagaInput, deps);
        return finalizeRecoveryOwnerResult(input, recoveryId, result);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = message === 'team_not_found'
            ? 'team_not_found'
            : message === 'invalid_persisted_state'
                ? 'invalid_persisted_state'
                : message === 'stale_state_revision'
                    ? 'stale_state_revision'
                    : message === 'runtime_owner_fence_lost'
                        ? 'runtime_owner_fence_lost'
                        : message === 'worker_cleanup_incomplete'
                            ? 'worker_cleanup_incomplete'
                            : message.startsWith('team_instance_')
                                ? 'invalid_persisted_state'
                                : 'runtime_owner_unavailable';
        const result = recoveryError(input, recoveryId, code, message);
        return ownerBound && (code === 'team_not_found' || code === 'invalid_persisted_state')
            ? await finalizeBoundRecoveryOwnerTerminal(input, recoveryId, result)
            : code === 'team_not_found' || code === 'invalid_persisted_state'
                ? persistRecoveryFinal(input, recoveryId, result)
                : result;
    }
}
const TEAM_INSTANCE_FINAL_DISPOSAL_AUTHORIZATION = {
    protocol: 'caller-owned-final-state-v1',
    providers: 'disposed',
    panes: 'disposed',
    worktrees: 'disposed',
};
/**
 * Roll back effects that occurred before an identity-bearing config was
 * committed.  When an instance binding is supplied this helper is called
 * under the shared lifecycle lock and releases the pending reservation only
 * after the state root has been removed and verified.
 */
async function rollbackUnpersistedNativeWorktreeStartup(teamName, cwd, cause, instance) {
    const teamRoot = absPath(cwd, TeamPaths.root(teamName));
    const errorMessage = cause instanceof Error ? cause.message : String(cause);
    const recordedAt = new Date().toISOString();
    const writeFailureMarker = async (extra = {}) => {
        await mkdir(teamRoot, { recursive: true });
        await writeFile(join(teamRoot, 'startup-failure.json'), JSON.stringify({
            reason: 'startup_failed_before_config_persisted',
            error: errorMessage,
            recorded_at: recordedAt,
            ...extra,
        }, null, 2), 'utf-8');
    };
    // createTeamSession can have created a tmux/cmux resource before its
    // identity-bound cleanup proof is available.  Do not remove the pending
    // config/worktrees or release the external reservation in that case: the
    // partial session and creation evidence are the only durable authority left
    // for a later, explicitly bound cleanup attempt.
    if (cause instanceof TeamSessionCreationError && cause.cleanupStatus !== 'verified') {
        try {
            await writeFailureMarker({
                instance_id: instance.instance_id,
                instance_binding: instance,
                partial_session: cause.partialSession,
                ...(cause.creationEvidence ? { creation_evidence: cause.creationEvidence } : {}),
                cleanup_status: cause.cleanupStatus ?? 'unknown',
                cleanup_incomplete: true,
            });
        }
        catch {
            // Preserve the reservation and pending state even if evidence
            // publication itself fails; callers must surface cleanup uncertainty.
        }
        return false;
    }
    const safety = inspectTeamWorktreeCleanupSafety(teamName, cwd);
    try {
        if (safety.hasEvidence) {
            const cleanup = cleanupTeamWorktrees(teamName, cwd);
            if (cleanup.preserved.length > 0) {
                await writeFailureMarker({ preserved: cleanup.preserved });
                return true;
            }
        }
        await rm(teamRoot, { recursive: true, force: true });
        if (existsSync(teamRoot)) {
            await writeFailureMarker({ rollback_error: 'startup_state_removal_unverified' });
            return false;
        }
        try {
            await releaseFailedStartupReservationUnderLock(instance);
        }
        catch {
            // Keep the reservation as durable retry authority when release cannot
            // be verified, even though the disposable state root is gone.
            return false;
        }
        return true;
    }
    catch (rollbackError) {
        try {
            await writeFailureMarker({
                rollback_error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                cleanup_incomplete: true,
            });
        }
        catch {
            // Preserve the original failure; inability to write evidence is itself unverified cleanup.
        }
        return false;
    }
}
async function writeStartedStartupRollbackEvidence(args) {
    const teamRoot = absPath(args.cwd, TeamPaths.root(args.teamName));
    await mkdir(teamRoot, { recursive: true });
    await writeFile(join(teamRoot, 'startup-failure.json'), JSON.stringify({
        reason: args.markerReason ?? 'startup_rollback_cleanup_incomplete',
        error: args.cause instanceof Error ? args.cause.message : String(args.cause),
        rollback_error: args.reason,
        ...(args.worker ? { worker: args.worker } : {}),
        ...(args.launchedWorkers && args.launchedWorkers.length > 0
            ? { launch_attempts: args.launchedWorkers.map(launch => ({
                    worker: launch.name,
                    pane_id: launch.paneId,
                    provider: launch.provider,
                    ...(launch.launchAttemptId ? { launch_attempt_id: launch.launchAttemptId } : {}),
                })) }
            : {}),
        cleanup_incomplete: args.markerReason === undefined,
        recorded_at: new Date().toISOString(),
    }, null, 2), 'utf-8');
}
function startupCleanupIncompleteError(cause) {
    const error = new Error('worker_cleanup_incomplete');
    error.cause = cause;
    return error;
}
async function rollbackStartedNativeWorktreeStartup(args) {
    const worktreeCleanupRequired = inspectTeamWorktreeCleanupSafety(args.teamName, args.cwd).hasEvidence;
    const sessionCleanupRequired = (args.launchedWorkers?.length ?? 0) > 0
        || args.workerPaneIds.length > 0
        || args.sessionMode !== 'split-pane';
    try {
        await writeStartedStartupRollbackEvidence({
            ...args,
            reason: 'startup_failure',
            markerReason: 'startup_failed_before_config_persisted',
        });
    }
    catch {
        // Preserve the initiating startup error; evidence write failure is handled
        // as cleanup uncertainty only when cleanup is otherwise required.
    }
    try {
        for (const worker of args.launchedWorkers ?? []) {
            if (!worker.launchAttemptId) {
                await writeStartedStartupRollbackEvidence({ ...args, reason: 'missing_launch_attempt_id', worker: worker.name });
                throw new Error(`worker_cleanup_incomplete:${worker.name}:missing_launch_attempt_id`);
            }
            const attempt = await loadWorkerLaunchAttempt({
                cwd: args.cwd, teamName: args.teamName,
                instanceId: args.instance.instance_id,
                workerName: worker.name,
                paneId: worker.paneId, provider: worker.provider,
                attemptId: worker.launchAttemptId, runtimeCliPath: resolveRuntimeCliPath(),
            });
            if (!attempt || attempt.attempt_id !== worker.launchAttemptId || attempt.pane_id !== worker.paneId) {
                await writeStartedStartupRollbackEvidence({ ...args, reason: 'launch_attempt_identity_unverified', worker: worker.name });
                throw new Error(`worker_cleanup_incomplete:${worker.name}:launch_attempt_identity_unverified`);
            }
            const cleaned = await retireAndCleanupCurrentWorkerLaunchAttempt(attempt, 'startup_rollback', async () => {
                const ownership = {
                    provider: worker.paneId.startsWith('%') ? 'tmux' : 'cmux',
                    providerTarget: args.sessionName,
                    paneId: worker.paneId,
                    splitTarget: '',
                    leaderPaneId: args.leaderPaneId ?? '',
                    reservedPaneIds: args.workerPaneIds.filter(p => p !== worker.paneId),
                    source: 'adopted',
                    ...(worker.paneId.startsWith('%') && args.tmuxServerIdentity
                        ? { tmuxServerIdentity: args.tmuxServerIdentity }
                        : {}),
                };
                if (await getOwnedWorkerLiveness(ownership) === 'dead')
                    return true;
                await killOwnedWorkerPane({
                    ...ownership,
                });
                return await getOwnedWorkerLiveness(ownership) === 'dead';
            });
            if (cleaned !== true) {
                await writeStartedStartupRollbackEvidence({ ...args, reason: 'provider_cleanup_unverified', worker: worker.name });
                throw new Error(`worker_cleanup_incomplete:${worker.name}:provider_cleanup_unverified`);
            }
        }
        if (sessionCleanupRequired && !(args.workerPaneIds.length === 0 && args.sessionMode === 'split-pane' && (args.launchedWorkers?.length ?? 0) > 0)) {
            const sessionCleaned = await killTeamSession(args.sessionName, args.workerPaneIds, args.leaderPaneId ?? undefined, {
                sessionMode: args.sessionMode,
                ...(args.tmuxServerIdentity ? { tmuxServerIdentity: args.tmuxServerIdentity } : {}),
            });
            if (sessionCleaned === false) {
                await writeStartedStartupRollbackEvidence({ ...args, reason: 'session_cleanup_unverified' });
                throw new Error('worker_cleanup_incomplete:session_cleanup_unverified');
            }
        }
        if (worktreeCleanupRequired) {
            const cleanup = cleanupTeamWorktrees(args.teamName, args.cwd);
            if (cleanup.preserved.length > 0) {
                throw new Error('worker_cleanup_incomplete:worktree_cleanup_unverified');
            }
        }
        try {
            await disposeTeamInstanceUnderLock(args.instance, TEAM_INSTANCE_FINAL_DISPOSAL_AUTHORIZATION);
        }
        catch (error) {
            throw new Error(`worker_cleanup_incomplete:state_cleanup_unverified:${error instanceof Error ? error.message : String(error)}`);
        }
    }
    catch (error) {
        try {
            await writeStartedStartupRollbackEvidence({ ...args, reason: error instanceof Error ? error.message : String(error) });
        }
        catch {
            // Evidence write failures remain a cleanup failure.
        }
        throw startupCleanupIncompleteError(error);
    }
}
// ---------------------------------------------------------------------------
// startTeamV2 — direct tmux creation, CLI API inbox, NO watchdog
// ---------------------------------------------------------------------------
function resolveLeaderClaudeSessionId() {
    for (const raw of [process.env.CLAUDE_SESSION_ID, process.env.OMC_SESSION_ID]) {
        const candidate = typeof raw === 'string' ? raw.trim() : '';
        if (!candidate)
            continue;
        try {
            validateSessionId(candidate);
            return candidate;
        }
        catch {
            // Invalid ids cannot authorize SessionEnd cleanup.
        }
    }
    return undefined;
}
/**
 * Start a team with the v2 event-driven runtime.
 * Creates state directories, writes config + task files, spawns workers via
 * tmux split-panes, and writes CLI API inbox instructions. NO done.json.
 * NO watchdog polling — the leader drives monitoring via monitorTeamV2().
 */
export async function startTeamV2(config) {
    if (!Array.isArray(config.agentTypes) || config.agentTypes.length === 0) {
        throw new Error('Invalid agent types. Expected at least one provider.');
    }
    if (!Number.isInteger(config.workerCount) || config.workerCount < 1 || config.workerCount > ABSOLUTE_MAX_WORKERS) {
        throw new Error(`Invalid worker count "${config.workerCount}". Expected 1-${ABSOLUTE_MAX_WORKERS}.`);
    }
    const sanitized = sanitizeTeamName(config.teamName);
    validateTeamName(sanitized);
    if (!Array.isArray(config.tasks))
        throw new Error('invalid_task_dependencies');
    const dependencyByIndex = validateStartTaskDependencies(config.tasks);
    const workerNames = Array.from({ length: config.workerCount }, (_, index) => `worker-${index + 1}`);
    const workerNameSet = new Set(workerNames);
    for (let index = 0; index < config.tasks.length; index++) {
        const task = config.tasks[index];
        const owner = task.owner;
        if (owner === undefined)
            continue;
        if (typeof owner !== 'string' || owner.trim() === '' || !workerNameSet.has(owner)) {
            throw new Error(`invalid_task_owner:task-${index + 1}`);
        }
    }
    const instance = createTeamInstanceBinding({
        teamName: sanitized,
        cwd: resolve(config.cwd),
        ...(config.instanceId !== undefined ? { instanceId: config.instanceId } : {}),
    });
    const leaderCwd = instance.cwd;
    // Resolve routing snapshot ONCE at team creation. The snapshot is immutable
    // for the team's lifetime (stickiness per plan AC-10): spawn/scaleUp/restart
    // all read this snapshot and never re-resolve. Config edits mid-lifetime
    // do NOT change routing — user must recreate the team to pick up changes.
    const pluginCfg = config.pluginConfig ?? loadConfig();
    const resolvedRouting = buildResolvedRoutingSnapshot(pluginCfg);
    let worktreeMode = normalizeTeamWorktreeMode(process.env.OMC_TEAM_WORKTREE_MODE ?? pluginCfg.team?.ops?.worktreeMode);
    // Auto-merge gate (M5 + M3 hardening). Forces worktreeMode='named' so each
    // worker has a real branch the orchestrator can merge from.
    let autoMergeLeaderBranch;
    if (config.autoMerge) {
        if (!isRuntimeV2Enabled()) {
            throw new Error('auto-merge requires OMC_RUNTIME_V2=1 (this feature is v2-only).');
        }
        autoMergeLeaderBranch = resolveLeaderBranch(leaderCwd);
        const stripped = autoMergeLeaderBranch.replace(/^refs\/heads\//i, '').toLowerCase();
        if (stripped === 'main' || stripped === 'master') {
            throw new Error('auto-merge refuses main/master leader branch — use a feature branch');
        }
        if (worktreeMode !== 'named') {
            // Force named-branch worktree mode so workers get a real branch.
            worktreeMode = 'named';
        }
    }
    const workspaceMode = worktreeMode === 'disabled' ? 'single' : 'worktree';
    const agentTypes = config.agentTypes;
    const externalModelsDefaults = resolveExternalModelsDefaults(pluginCfg.externalModels?.defaults, process.env);
    const resolveDefaultModel = (agentType) => {
        return resolveDefaultWorkerModel(agentType, process.env, externalModelsDefaults);
    };
    // Resolve the exact startup allocation before any side effects so preflight
    // covers only providers that can actually be launched. Explicit owners win;
    // the remaining tasks use the same role-aware allocator as startup below.
    const startupAllocations = [];
    const unownedTaskIndices = [];
    for (let i = 0; i < config.tasks.length; i++) {
        const dependencies = dependencyByIndex.get(i) ?? [];
        if (dependencies.length > 0)
            continue;
        const owner = config.tasks[i]?.owner;
        if (typeof owner === 'string' && workerNameSet.has(owner)) {
            startupAllocations.push({ workerName: owner, taskIndex: i });
        }
        else {
            unownedTaskIndices.push(i);
        }
    }
    if (unownedTaskIndices.length > 0) {
        const allocationTasks = unownedTaskIndices.map(idx => ({
            id: String(idx),
            subject: config.tasks[idx].subject,
            description: config.tasks[idx].description,
            ...(config.tasks[idx].role ? { role: config.tasks[idx].role } : {}),
        }));
        const allocationWorkers = workerNames.map((name, i) => ({
            name,
            role: config.workerRoles?.[i]
                ?? (agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? 'claude'),
            currentLoad: 0,
        }));
        for (const r of allocateTasksToWorkers(allocationTasks, allocationWorkers)) {
            startupAllocations.push({ workerName: r.workerName, taskIndex: Number(r.taskId) });
        }
    }
    // Keep the first allocation for each worker as the initial startup task.
    // Explicit owners are appended before allocator results, so this preserves
    // owner priority when a worker also receives later unowned work.
    const startupByWorker = new Map();
    for (const allocation of startupAllocations) {
        if (!startupByWorker.has(allocation.workerName)) {
            startupByWorker.set(allocation.workerName, allocation.taskIndex);
        }
    }
    // Validate CLIs and pin absolute binary paths for effective startup
    // assignments only. Unsupported, relative, missing, or untrusted selected
    // providers fail before any team state or multiplexer side effect is created.
    const resolvedBinaryPaths = {};
    const missingBinaryReasons = [];
    const startupAssignments = new Map();
    const effectiveAgentTypes = new Set();
    for (let i = 0; i < workerNames.length; i++) {
        const workerName = workerNames[i];
        const taskIndex = startupByWorker.get(workerName);
        const fallbackAgent = (agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? 'claude');
        const resolvedAssignment = taskIndex === undefined
            ? { agentType: fallbackAgent, model: '', role: undefined }
            : resolveTaskAssignment(config.tasks[taskIndex], resolvedRouting, pluginCfg.team?.roleRouting, fallbackAgent);
        const assignment = {
            agentType: resolvedAssignment.agentType,
            model: resolvedAssignment.model || resolveDefaultModel(resolvedAssignment.agentType),
            ...(resolvedAssignment.role ? { role: resolvedAssignment.role } : {}),
        };
        startupAssignments.set(workerName, assignment);
        effectiveAgentTypes.add(assignment.agentType);
    }
    for (const agentType of effectiveAgentTypes) {
        try {
            resolvedBinaryPaths[agentType] = resolvePreflightBinaryPath(agentType).path;
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            missingBinaryReasons.push({ agentType, reason });
        }
    }
    if (missingBinaryReasons.length > 0) {
        const missing = missingBinaryReasons.map(({ agentType, reason }) => `${agentType}:${reason}`).join(';');
        throw new Error(`cli_binary_preflight_failed:${missing}`);
    }
    return withTeamInstanceLifecycleLock(leaderCwd, sanitized, async () => {
        // Reserve the name before creating any state, worktree, pane, or provider
        // effect.  The reservation remains external and blocks same-name startup
        // until this incarnation is either fully activated or safely released.
        const reservation = await reserveTeamInstanceUnderLock({
            teamName: instance.team_name,
            cwd: instance.cwd,
            instanceId: instance.instance_id,
        });
        if (reservation.phase === 'active') {
            throw new Error('team_instance_reservation_conflict');
        }
        let startupRollbackIssued = false;
        const rollbackBeforeConfig = async (cause) => {
            if (startupRollbackIssued)
                return true;
            startupRollbackIssued = true;
            return rollbackUnpersistedNativeWorktreeStartup(sanitized, leaderCwd, cause, instance);
        };
        const rollbackAfterConfig = async (args) => {
            if (startupRollbackIssued)
                return;
            startupRollbackIssued = true;
            await rollbackStartedNativeWorktreeStartup({ ...args, instance });
        };
        try {
            const pendingConfig = buildTeamInstancePendingConfig(instance);
            const pendingConfigPath = absPath(leaderCwd, TeamPaths.config(sanitized));
            await mkdir(join(pendingConfigPath, '..'), { recursive: true });
            await writeFile(pendingConfigPath, JSON.stringify(pendingConfig, null, 2), 'utf-8');
        }
        catch (error) {
            if (!await rollbackBeforeConfig(error))
                throw startupCleanupIncompleteError(error);
            throw error;
        }
        const workerWorktrees = new Map();
        const preparedLaunches = new Map();
        try {
            // Create state directories
            await mkdir(absPath(leaderCwd, TeamPaths.tasks(sanitized)), { recursive: true });
            await mkdir(absPath(leaderCwd, TeamPaths.workers(sanitized)), { recursive: true });
            await mkdir(join(getOmcRoot(leaderCwd), 'state', 'team', sanitized, 'mailbox'), { recursive: true });
            // Write task files
            for (let i = 0; i < config.tasks.length; i++) {
                const taskId = String(i + 1);
                const task = config.tasks[i];
                const taskFilePath = absPath(leaderCwd, TeamPaths.taskFile(sanitized, taskId));
                const taskRecord = normalizeTaskRecord(createTaskRecord(taskId, {
                    subject: task.subject,
                    description: task.description,
                    status: 'pending',
                    ...(task.owner !== undefined ? { owner: task.owner } : {}),
                    ...(task.role !== undefined ? { role: task.role } : {}),
                    ...(task.blocked_by !== undefined ? { blocked_by: [...task.blocked_by] } : {}),
                    ...(dependencyByIndex.get(i)?.length
                        ? { depends_on: [...dependencyByIndex.get(i)] }
                        : {}),
                    ...(task.delegation !== undefined ? { delegation: task.delegation } : {}),
                }));
                await writeAtomic(taskFilePath, JSON.stringify(taskRecord, null, 2));
            }
            try {
                if (worktreeMode !== 'disabled') {
                    for (const workerName of workerNames) {
                        const worktree = ensureWorkerWorktree(sanitized, workerName, leaderCwd, {
                            mode: worktreeMode,
                            requireCleanLeader: true,
                        });
                        if (worktree)
                            workerWorktrees.set(workerName, worktree);
                    }
                }
            }
            catch (error) {
                if (!await rollbackBeforeConfig(error))
                    throw startupCleanupIncompleteError(error);
                throw error;
            }
            for (let i = 0; i < workerNames.length; i++) {
                const workerName = workerNames[i];
                const taskIndex = startupByWorker.get(workerName);
                const assignment = startupAssignments.get(workerName);
                if (!assignment)
                    throw new Error(`Missing startup assignment for ${workerName}`);
                const worktree = workerWorktrees.get(workerName);
                const verdictAssignmentId = taskIndex !== undefined ? randomUUID() : undefined;
                const outputFile = taskIndex !== undefined && assignment.role && shouldInjectContract(assignment.role, assignment.agentType)
                    ? cliWorkerOutputFilePath(teamStateRoot(leaderCwd, sanitized), workerName, {
                        taskId: String(taskIndex + 1),
                        assignmentId: verdictAssignmentId,
                    }) : undefined;
                const outputContract = outputFile && assignment.role ? renderCliWorkerOutputContract(assignment.role, outputFile) : undefined;
                const binary = resolvedBinaryPaths[assignment.agentType];
                if (!binary)
                    throw new Error(`No validated binary available for ${assignment.agentType}`);
                const startupPrompt = taskIndex !== undefined && isPromptModeAgent(assignment.agentType)
                    ? generatePromptModeStartupPrompt(sanitized, workerName, workerInstructionStateRoot(leaderCwd, sanitized), outputContract)
                    : undefined;
                const transportPrompt = startupPrompt && process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(binary)
                    ? startupPrompt.replace(/\s*\r?\n\s*/g, ' ')
                    : startupPrompt;
                const promptArgs = transportPrompt ? getPromptModeArgs(assignment.agentType, transportPrompt) : [];
                const descriptor = buildValidatedWorkerLaunchDescriptor(assignment.agentType, {
                    teamName: sanitized, workerName, cwd: worktree?.path ?? leaderCwd, resolvedBinaryPath: binary,
                    model: assignment.model,
                }, promptArgs);
                preparedLaunches.set(workerName, { agentType: assignment.agentType,
                    ...(assignment.role ? { role: assignment.role } : {}), descriptor,
                    ...(verdictAssignmentId ? { verdictAssignmentId } : {}) });
            }
        }
        catch (error) {
            if (!await rollbackBeforeConfig(error))
                throw startupCleanupIncompleteError(error);
            throw error;
        }
        // Set up worker state dirs and overlays (with v2 CLI API instructions)
        try {
            for (let i = 0; i < workerNames.length; i++) {
                const wName = workerNames[i];
                const prepared = preparedLaunches.get(wName);
                if (!prepared)
                    throw new Error(`Missing prepared launch for ${wName}`);
                await ensureWorkerStateDir(sanitized, wName, leaderCwd);
                const overlayPath = await writeWorkerOverlay({
                    teamName: sanitized, workerName: wName, agentType: prepared.agentType,
                    tasks: config.tasks.map((t, idx) => ({
                        id: String(idx + 1), subject: t.subject, description: t.description,
                    })),
                    cwd: leaderCwd,
                    ...(config.rolePrompt ? { bootstrapInstructions: config.rolePrompt } : {}),
                    instructionStateRoot: workerInstructionStateRoot(leaderCwd, sanitized),
                    ...(prepared.role && shouldInjectContract(prepared.role, prepared.agentType)
                        ? { reviewerRole: true } : {}),
                });
                const worktree = workerWorktrees.get(wName);
                if (worktree) {
                    const overlayContent = await readFile(overlayPath, 'utf-8');
                    installWorktreeRootAgents(sanitized, wName, leaderCwd, worktree.path, overlayContent);
                }
            }
        }
        catch (error) {
            if (!await rollbackBeforeConfig(error))
                throw startupCleanupIncompleteError(error);
            throw error;
        }
        // Create tmux session (leader only — workers spawned below)
        let session;
        try {
            session = await createTeamSession(sanitized, 0, leaderCwd, {
                newWindow: Boolean(config.newWindow),
            });
        }
        catch (error) {
            if (!await rollbackBeforeConfig(error))
                throw startupCleanupIncompleteError(error);
            throw error;
        }
        const sessionName = session.sessionName;
        const leaderPaneId = session.leaderPaneId;
        const ownsWindow = session.sessionMode !== 'split-pane';
        const workerPaneIds = [];
        const leaderSessionId = resolveLeaderClaudeSessionId();
        // Build workers info for config
        const workersInfo = workerNames.map((wName, i) => {
            const worktree = workerWorktrees.get(wName);
            return {
                name: wName,
                index: i + 1,
                role: preparedLaunches.get(wName)?.role
                    ?? config.workerRoles?.[i]
                    ?? (agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? 'claude'),
                worker_cli: preparedLaunches.get(wName).descriptor.provider,
                launch_descriptor: preparedLaunches.get(wName).descriptor,
                assigned_tasks: [],
                working_dir: worktree?.path ?? leaderCwd,
                team_state_root: teamStateRoot(leaderCwd, sanitized),
                ...(worktree ? {
                    worktree_repo_root: leaderCwd,
                    worktree_path: worktree.path,
                    worktree_branch: worktree.branch,
                    worktree_detached: worktree.detached,
                    worktree_created: worktree.created,
                } : {}),
            };
        });
        // Write initial v2 config
        const teamConfig = {
            name: sanitized,
            instance_id: instance.instance_id,
            ...(session.tmuxServerIdentity ? { tmux_server_identity: session.tmuxServerIdentity } : {}),
            state_revision: 0,
            task: config.tasks.map(t => t.subject).join('; '),
            agent_type: agentTypes[0] || 'claude',
            worker_launch_mode: 'interactive',
            policy: DEFAULT_TEAM_TRANSPORT_POLICY,
            governance: DEFAULT_TEAM_GOVERNANCE,
            worker_count: config.workerCount,
            max_workers: ABSOLUTE_MAX_WORKERS,
            workers: workersInfo,
            created_at: new Date().toISOString(),
            tmux_session: sessionName,
            tmux_window_owned: ownsWindow,
            next_task_id: config.tasks.length + 1,
            ...(leaderSessionId ? { leader_session_id: leaderSessionId } : {}),
            leader_cwd: leaderCwd,
            team_state_root: teamStateRoot(leaderCwd, sanitized),
            leader_pane_id: leaderPaneId,
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            resolved_routing: resolvedRouting,
            resolved_routing_roles: Object.keys(pluginCfg.team?.roleRouting ?? {})
                .map(role => normalizeDelegationRole(role))
                .filter((role) => CANONICAL_TEAM_ROLES.includes(role)),
            external_models_defaults: externalModelsDefaults,
            workspace_mode: workspaceMode,
            worktree_mode: worktreeMode,
            lifecycle_state: 'starting',
            service_descriptor: config.autoMerge
                ? { schema_version: 1, service_generation: 1, service_attempt_id: randomUUID(), auto_merge_enabled: true,
                    workspace_root: leaderCwd, leader_branch: autoMergeLeaderBranch, cadence_policy: 'worker-auto-commit-v1' }
                : { schema_version: 1, service_generation: 1, service_attempt_id: randomUUID(), auto_merge_enabled: false,
                    workspace_root: leaderCwd, cadence_policy: 'disabled' },
        };
        try {
            await commitInitialTeamConfigUnderLock(teamConfig, leaderCwd, instance);
        }
        catch (error) {
            await rollbackAfterConfig({
                teamName: sanitized,
                cwd: leaderCwd,
                cause: error,
                sessionName,
                ...(session.tmuxServerIdentity ? { tmuxServerIdentity: session.tmuxServerIdentity } : {}),
                leaderPaneId,
                workerPaneIds,
                sessionMode: session.sessionMode,
            });
            throw error;
        }
        const permissionsSnapshot = {
            approval_mode: process.env.OMC_APPROVAL_MODE || 'default',
            sandbox_mode: process.env.OMC_SANDBOX_MODE || 'default',
            network_access: process.env.OMC_NETWORK_ACCESS === '1',
        };
        const teamManifest = {
            schema_version: 2,
            state_revision: 0,
            name: sanitized,
            instance_id: instance.instance_id,
            ...(session.tmuxServerIdentity ? { tmux_server_identity: session.tmuxServerIdentity } : {}),
            task: teamConfig.task,
            leader: {
                session_id: leaderSessionId ?? sessionName,
                worker_id: 'leader-fixed',
                role: 'leader',
            },
            policy: DEFAULT_TEAM_TRANSPORT_POLICY,
            governance: DEFAULT_TEAM_GOVERNANCE,
            permissions_snapshot: permissionsSnapshot,
            tmux_session: sessionName,
            worker_count: teamConfig.worker_count,
            workers: workersInfo,
            next_task_id: teamConfig.next_task_id,
            created_at: teamConfig.created_at,
            leader_cwd: leaderCwd,
            team_state_root: teamConfig.team_state_root,
            workspace_mode: teamConfig.workspace_mode,
            worktree_mode: teamConfig.worktree_mode,
            leader_pane_id: leaderPaneId,
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            next_worker_index: teamConfig.next_worker_index,
            resolved_routing: teamConfig.resolved_routing,
            resolved_routing_roles: teamConfig.resolved_routing_roles,
            external_models_defaults: teamConfig.external_models_defaults,
            service_descriptor: teamConfig.service_descriptor,
        };
        try {
            await writeFile(absPath(leaderCwd, TeamPaths.manifest(sanitized)), JSON.stringify(teamManifest, null, 2), 'utf-8');
            await activateTeamInstanceUnderLock(instance);
        }
        catch (error) {
            await rollbackAfterConfig({
                teamName: sanitized,
                cwd: leaderCwd,
                cause: error,
                sessionName,
                ...(session.tmuxServerIdentity ? { tmuxServerIdentity: session.tmuxServerIdentity } : {}),
                leaderPaneId,
                workerPaneIds,
                sessionMode: session.sessionMode,
            });
            throw error;
        }
        const launchedWorkers = [];
        try {
            // Reuse the same first-per-worker selection used by assignment and
            // preflight; no second dedupe policy may diverge from startupByWorker.
            for (const [wName, taskIndex] of startupByWorker) {
                const workerIndex = Number.parseInt(wName.replace('worker-', ''), 10) - 1;
                const taskId = String(taskIndex + 1);
                const task = config.tasks[taskIndex];
                if (!task || workerIndex < 0)
                    continue;
                const prepared = preparedLaunches.get(wName);
                if (!prepared)
                    continue;
                const workerInfo = workersInfo[workerIndex];
                if (!workerInfo)
                    continue;
                const workerLaunch = await spawnV2Worker({
                    sessionName,
                    ...(session.tmuxServerIdentity ? { tmuxServerIdentity: session.tmuxServerIdentity } : {}),
                    leaderPaneId,
                    existingWorkerPaneIds: workerPaneIds,
                    teamName: sanitized,
                    instanceId: instance.instance_id,
                    workerName: wName,
                    workerIndex,
                    agentType: prepared.agentType,
                    launchDescriptor: prepared.descriptor,
                    task,
                    taskId,
                    cwd: leaderCwd,
                    workerCwd: workerInfo.working_dir ?? leaderCwd,
                    worktreePath: workerInfo.worktree_path,
                    autoMerge: Boolean(config.autoMerge),
                    ...(prepared.role ? { role: prepared.role } : {}),
                    ...(prepared.verdictAssignmentId ? { verdictAssignmentId: prepared.verdictAssignmentId } : {}),
                });
                if (workerLaunch.paneId) {
                    if (workerLaunch.startupAssigned)
                        workerPaneIds.push(workerLaunch.paneId);
                    launchedWorkers.push({
                        name: wName, paneId: workerLaunch.paneId,
                        ...(workerLaunch.launchAttemptId ? { launchAttemptId: workerLaunch.launchAttemptId } : {}),
                        provider: prepared.agentType,
                    });
                    {
                        workerInfo.pane_id = workerLaunch.paneId;
                        workerInfo.assigned_tasks = workerLaunch.startupAssigned ? [taskId] : [];
                        workerInfo.worker_cli = prepared.agentType;
                        if (workerLaunch.launchAttemptId) {
                            workerInfo.launch_attempt_id = workerLaunch.launchAttemptId;
                        }
                        if (workerLaunch.outputFile) {
                            workerInfo.output_file = workerLaunch.outputFile;
                        }
                    }
                }
                if (workerLaunch.startupFailureReason) {
                    const logEventFailure = createSwallowedErrorLogger('team.runtime-v2.startTeamV2 appendTeamEvent failed');
                    appendTeamEvent(sanitized, {
                        type: 'team_leader_nudge',
                        worker: 'leader-fixed',
                        reason: `startup_manual_intervention_required:${wName}:${workerLaunch.startupFailureReason}`,
                    }, leaderCwd).catch(logEventFailure);
                }
            }
        }
        catch (error) {
            const unresolvedLaunch = error && typeof error === 'object' && 'unresolvedLaunch' in error
                ? error.unresolvedLaunch
                : undefined;
            if (unresolvedLaunch && !launchedWorkers.some(candidate => candidate.launchAttemptId === unresolvedLaunch.launchAttemptId)) {
                launchedWorkers.push(unresolvedLaunch);
                const workerInfo = workersInfo.find(candidate => candidate.name === unresolvedLaunch.name);
                if (workerInfo) {
                    workerInfo.pane_id = unresolvedLaunch.paneId;
                    workerInfo.launch_attempt_id = unresolvedLaunch.launchAttemptId;
                    workerInfo.worker_cli = unresolvedLaunch.provider;
                    workerInfo.operational_state = 'starting';
                    teamConfig.workers = workersInfo;
                    try {
                        await saveTeamConfig(teamConfig, leaderCwd, teamConfig.state_revision);
                    }
                    catch {
                        // The durable launch receipt and rollback marker remain the
                        // fallback evidence; never proceed to destructive cleanup without
                        // the unresolved launch in `launchedWorkers`.
                    }
                }
            }
            await rollbackAfterConfig({
                teamName: sanitized,
                cwd: leaderCwd,
                cause: error,
                sessionName,
                ...(session.tmuxServerIdentity ? { tmuxServerIdentity: session.tmuxServerIdentity } : {}),
                leaderPaneId,
                workerPaneIds,
                sessionMode: session.sessionMode,
                launchedWorkers,
            });
            throw error;
        }
        // Persist config with pane IDs
        teamConfig.workers = workersInfo;
        teamConfig.lifecycle_state = 'active';
        try {
            await saveTeamConfig(teamConfig, leaderCwd, teamConfig.state_revision);
        }
        catch (error) {
            await rollbackAfterConfig({
                teamName: sanitized,
                cwd: leaderCwd,
                cause: error,
                sessionName,
                ...(session.tmuxServerIdentity ? { tmuxServerIdentity: session.tmuxServerIdentity } : {}),
                leaderPaneId,
                workerPaneIds,
                sessionMode: session.sessionMode,
                launchedWorkers,
            });
            throw error;
        }
        const logEventFailure = createSwallowedErrorLogger('team.runtime-v2.startTeamV2 appendTeamEvent failed');
        // Emit start event — NO watchdog, leader drives via monitorTeamV2()
        appendTeamEvent(sanitized, {
            type: 'team_leader_nudge',
            worker: 'leader-fixed',
            reason: `start_team_v2: workers=${config.workerCount} tasks=${config.tasks.length} panes=${workerPaneIds.length}`,
        }, leaderCwd).catch(logEventFailure);
        // Auto-merge orchestrator startup. Because --auto-merge is an explicit
        // safety opt-in, startup/registration failures are fatal: continuing would
        // leave users believing worker edits are being merged when they are not.
        if (config.autoMerge && autoMergeLeaderBranch) {
            try {
                await ensureLeaderInbox(sanitized, leaderCwd);
                // Seed an introductory leader-inbox note so the leader knows the inbox
                // exists and where to read it. This mirrors the worker bootstrap pattern.
                await appendToLeaderInbox(sanitized, extendLeaderBootstrapPrompt(sanitized, leaderCwd), leaderCwd);
                // M6: try to recover from a previous run before starting fresh.
                try {
                    await recoverFromRestart({
                        teamName: sanitized,
                        repoRoot: leaderCwd,
                        leaderBranch: autoMergeLeaderBranch,
                        cwd: leaderCwd,
                    });
                }
                catch (recErr) {
                    process.stderr.write(`[team/runtime-v2] auto-merge recover-from-restart failed: ${recErr}\n`);
                }
                const orchestrator = await startMergeOrchestrator({
                    teamName: sanitized,
                    repoRoot: leaderCwd,
                    leaderBranch: autoMergeLeaderBranch,
                    cwd: leaderCwd,
                    serviceGeneration: teamConfig.service_descriptor.service_generation,
                    serviceAttemptId: teamConfig.service_descriptor.service_attempt_id,
                });
                registerTeamOrchestrator(sanitized, orchestrator, { serviceGeneration: teamConfig.service_descriptor.service_generation,
                    serviceAttemptId: teamConfig.service_descriptor.service_attempt_id });
                // Register every spawned worker (named worktree mode is enforced above
                // when autoMerge is on, so worker branches exist). A single failed
                // registration makes the auto-merge contract unsafe, so fail loudly.
                for (const w of workersInfo) {
                    await orchestrator.registerWorker(w.name);
                }
            }
            catch (orchErr) {
                await stopTeamCadence(sanitized);
                unregisterTeamOrchestrator(sanitized);
                await rollbackAfterConfig({
                    teamName: sanitized,
                    cwd: leaderCwd,
                    cause: orchErr,
                    sessionName,
                    ...(session.tmuxServerIdentity ? { tmuxServerIdentity: session.tmuxServerIdentity } : {}),
                    leaderPaneId,
                    workerPaneIds,
                    sessionMode: session.sessionMode,
                    launchedWorkers,
                });
                const reason = orchErr instanceof Error ? orchErr.message : String(orchErr);
                throw new Error(`auto-merge startup failed: ${reason}`);
            }
        }
        return {
            teamName: sanitized,
            sanitizedName: sanitized,
            instanceId: instance.instance_id,
            sessionName,
            config: teamConfig,
            cwd: leaderCwd,
            ownsWindow: ownsWindow,
        };
    });
}
// ---------------------------------------------------------------------------
// Circuit breaker — 3 consecutive failures -> write watchdog-failed.json
// ---------------------------------------------------------------------------
const CIRCUIT_BREAKER_THRESHOLD = 3;
export async function writeWatchdogFailedMarker(teamName, cwd, reason) {
    const { writeFile } = await import('fs/promises');
    const marker = {
        failedAt: Date.now(),
        reason,
        writtenBy: 'runtime-v2',
    };
    const root = absPath(cwd, TeamPaths.root(sanitizeTeamName(teamName)));
    const markerPath = join(root, 'watchdog-failed.json');
    await mkdir(root, { recursive: true });
    await writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf-8');
}
/**
 * Circuit breaker context for tracking consecutive monitor failures.
 * The caller (runtime-cli v2 loop) should call recordSuccess on each
 * successful monitor cycle and recordFailure on each error. When the
 * threshold is reached, the breaker trips and writes watchdog-failed.json.
 */
export class CircuitBreakerV2 {
    teamName;
    cwd;
    threshold;
    consecutiveFailures = 0;
    tripped = false;
    constructor(teamName, cwd, threshold = CIRCUIT_BREAKER_THRESHOLD) {
        this.teamName = teamName;
        this.cwd = cwd;
        this.threshold = threshold;
    }
    recordSuccess() {
        this.consecutiveFailures = 0;
    }
    async recordFailure(reason) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.threshold && !this.tripped) {
            this.tripped = true;
            await writeWatchdogFailedMarker(this.teamName, this.cwd, reason);
            return true; // breaker tripped
        }
        return false;
    }
    isTripped() {
        return this.tripped;
    }
}
// ---------------------------------------------------------------------------
// Failure sidecars — requeue tasks from dead workers
// ---------------------------------------------------------------------------
/**
 * Compatibility wrapper that routes legacy dead-worker requeue requests through
 * the strict runtime-owner recovery transaction.
 */
export async function requeueDeadWorkerTasks(teamName, deadWorkerNames, cwd) {
    const sanitized = sanitizeTeamName(teamName);
    const requeued = new Set();
    for (const workerName of deadWorkerNames) {
        const outcome = await recoverDeadWorkerV2(sanitized, cwd, { workerName });
        if (outcome.outcome === 'recovered') {
            for (const taskId of outcome.requeuedTaskIds)
                requeued.add(taskId);
        }
    }
    return [...requeued];
}
function nonCursorVerdictBindingPath(outputFile) {
    return `${outputFile}.binding`;
}
function nonCursorVerdictStalePath(outputFile, artifactFingerprint) {
    return `${outputFile}.stale.${artifactFingerprint}`;
}
function nonCursorVerdictStaleMarkerPath(outputFile, artifactFingerprint) {
    return `${nonCursorVerdictStalePath(outputFile, artifactFingerprint)}.marker`;
}
function nonCursorVerdictFileIdentity(stats) {
    // ctime is deliberately excluded: permission/metadata changes must not
    // make an unchanged retained verdict look like a new publication.
    return [
        String(stats.dev),
        String(stats.ino),
        String(stats.size),
        String(stats.mtimeMs),
    ].join('-');
}
function fingerprintCliWorkerVerdictArtifact(raw, stats) {
    const contentSha256 = createHash('sha256').update(raw, 'utf8').digest('hex');
    return `${contentSha256}-${nonCursorVerdictFileIdentity(stats)}`;
}
async function readNonCursorVerdictArtifact(outputFile) {
    const before = await lstat(outputFile);
    const raw = await readFile(outputFile, 'utf8');
    const after = await lstat(outputFile);
    if (nonCursorVerdictFileIdentity(before) !== nonCursorVerdictFileIdentity(after)) {
        throw new Error('verdict_artifact_changed');
    }
    return {
        raw,
        artifactFingerprint: fingerprintCliWorkerVerdictArtifact(raw, after),
    };
}
function isNonCursorVerdictBinding(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const candidate = value;
    const fingerprintParts = typeof candidate.artifact_fingerprint === 'string'
        ? candidate.artifact_fingerprint.split('-')
        : [];
    return candidate.schema_version === 1
        && typeof candidate.artifact_fingerprint === 'string'
        && fingerprintParts.length === 5
        && /^[a-f0-9]{64}$/.test(fingerprintParts[0] ?? '')
        && fingerprintParts.slice(1).every(part => part.length > 0 && Number.isFinite(Number(part)))
        && typeof candidate.worker_name === 'string'
        && candidate.worker_name.length > 0
        && typeof candidate.task_id === 'string'
        && TASK_ID_SAFE_PATTERN.test(candidate.task_id)
        && Number.isSafeInteger(candidate.task_version)
        && candidate.task_version >= 1;
}
async function readNonCursorVerdictBinding(path) {
    let raw;
    try {
        raw = await readFile(path, 'utf8');
    }
    catch (error) {
        return error.code === 'ENOENT'
            ? { kind: 'missing' }
            : { kind: 'invalid' };
    }
    try {
        const value = JSON.parse(raw);
        return isNonCursorVerdictBinding(value)
            ? { kind: 'valid', binding: value }
            : { kind: 'invalid' };
    }
    catch {
        return { kind: 'invalid' };
    }
}
/**
 * Completion handler for CLI workers that emitted a structured verdict
 * (AC-7). Scans workers whose panes have exited, plus live Cursor panes whose
 * persistent reviewer session has published a verdict, and whose WorkerInfo
 * carries `output_file`. For each:
 *   - Reads + validates the JSON payload via `parseCliWorkerVerdict`.
 *   - Cursor reviewers use the claim-token transition path so lease,
 *     delegation, event, and monitor-snapshot invariants remain authoritative.
 *   - Other providers retain the post-exit no-token contract: under the
 *     consumer-owned artifact lock, a durable binding records the exact
 *     verdict bytes and filesystem publication fingerprint plus original task
 *     id/version before publication. Retries reuse that binding; under the
 *     canonical task claim lock they re-read and version-check the task,
 *     validate an incremented terminal candidate, and publish it atomically.
 *     Their best-effort events run only after that publication succeeds.
 *     Proven identity conflicts quarantine the artifact (or persist a stale
 *     marker if the rename fails) instead of rebinding it.
 *   - Renames the assignment-scoped verdict artifact to `.processed` so a
 *     subsequent monitor cycle does not reprocess it.
 *   - Quarantines stale `.processing` artifacts when replacement output exists.
 * On parse failure, emits a warning event and leaves the task untouched
 * for human review (per plan AC-7).
 */
export async function processCliWorkerVerdicts(teamName, cwd, expectedInstanceId) {
    const sanitized = sanitizeTeamName(teamName);
    let instanceId = expectedInstanceId;
    if (instanceId === undefined) {
        const current = await readTeamConfig(sanitized, cwd);
        // Legacy/name-only state is readable for diagnosis but cannot authorize
        // verdict task mutation.
        if (!current?.instance_id)
            return [];
        instanceId = current.instance_id;
    }
    const instance = createTeamInstanceBinding({ teamName: sanitized, cwd, instanceId });
    return withTeamInstanceLifecycleLock(instance.cwd, instance.team_name, async () => {
        await assertTeamInstanceUnderLock(instance);
        return processCliWorkerVerdictsUnderLock(teamName, cwd, instance.instance_id);
    });
}
/** Mutating verdict body; callers must already hold the instance lifecycle lock. */
async function processCliWorkerVerdictsUnderLock(teamName, cwd, expectedInstanceId) {
    const sanitized = sanitizeTeamName(teamName);
    const config = await readTeamConfig(sanitized, cwd);
    if (!config)
        return [];
    if (!config.instance_id || config.instance_id.toLowerCase() !== expectedInstanceId)
        return [];
    const results = [];
    const logEventFailure = createSwallowedErrorLogger('team.runtime-v2.processCliWorkerVerdicts appendTeamEvent failed');
    const logCompletionMarkerFailure = createSwallowedErrorLogger('team.runtime-v2.processCliWorkerVerdicts teamMarkTaskCompleted failed');
    const { rename } = await import('fs/promises');
    const { renameSync, readFileSync, existsSync: fsExistsSync } = await import('fs');
    const { withFileLockSync } = await import('../lib/file-lock.js');
    const quarantineNonCursorVerdict = async (outputFile, artifactFingerprint, workerName, taskId, taskVersion, reason) => {
        const stalePath = nonCursorVerdictStalePath(outputFile, artifactFingerprint);
        let moved = false;
        try {
            await rename(outputFile, stalePath);
            moved = true;
        }
        catch {
            // Keep the original artifact in place when the evidence rename fails.
        }
        try {
            await writeFile(nonCursorVerdictStaleMarkerPath(outputFile, artifactFingerprint), JSON.stringify({
                schema_version: 1,
                artifact_fingerprint: artifactFingerprint,
                worker_name: workerName,
                task_id: taskId,
                task_version: taskVersion,
                reason,
                quarantined_at: new Date().toISOString(),
            }), 'utf8');
            return true;
        }
        catch {
            // A successful rename still makes the original artifact non-selectable.
            return moved;
        }
    };
    for (const worker of config.workers) {
        const outputFile = worker.output_file;
        if (!outputFile)
            continue;
        const paneOwnership = configuredPaneOwnership(config, worker);
        const liveness = paneOwnership
            ? await getOwnedWorkerLiveness(paneOwnership)
            : 'unknown';
        const workerRole = normalizeDelegationRole(worker.role);
        const cursorReviewer = worker.worker_cli === 'cursor'
            && CONTRACT_ROLES.has(workerRole);
        const liveCursorReviewer = liveness === 'alive'
            && worker.worker_cli === 'cursor'
            && CONTRACT_ROLES.has(workerRole);
        // Cursor reviewers remain in their interactive pane after publishing a
        // verdict. A valid output file is the explicit completion signal for that
        // reviewer task; do not wait for the pane to exit. Other providers retain
        // the post-exit contract so their live output cannot be consumed early.
        if (liveness !== 'dead' && !liveCursorReviewer)
            continue;
        const processedOutputFile = outputFile + '.processed';
        const processingOutputFile = outputFile + '.processing';
        if (cursorReviewer) {
            if (!isCliWorkerOutputFilePath(teamStateRoot(cwd, sanitized), worker.name, outputFile)) {
                results.push({
                    workerName: worker.name,
                    taskId: null,
                    status: 'skipped',
                    reason: 'cursor_verdict_output_path_unverified',
                });
                continue;
            }
        }
        if (!fsExistsSync(outputFile)) {
            if (cursorReviewer && fsExistsSync(processingOutputFile)) {
                // A prior cycle claimed the file and may have crashed after the task
                // transition. Reuse that durable in-flight artifact instead of waiting
                // for a replacement verdict.
            }
            else {
                // A processed verdict is an intentional no-op on later monitor cycles,
                // not a missing verdict. This keeps the handler idempotent for persistent
                // Cursor panes and avoids repeated file_missing results/events.
                if (liveCursorReviewer && fsExistsSync(processedOutputFile))
                    continue;
                results.push({ workerName: worker.name, taskId: null, status: 'file_missing' });
                continue;
            }
        }
        let verdictFile = outputFile;
        if (cursorReviewer && !fsExistsSync(outputFile) && fsExistsSync(processingOutputFile)) {
            verdictFile = processingOutputFile;
        }
        let payload;
        let nonCursorArtifactFingerprint;
        let nonCursorBinding = null;
        try {
            if (cursorReviewer && verdictFile === outputFile) {
                // Claim a complete verdict before mutating task state. The per-output
                // lock makes concurrent monitor cycles single-consumer and the
                // `.processing` name lets a later cycle finish an interrupted commit.
                withFileLockSync(outputFile + '.lock', () => {
                    if (fsExistsSync(processingOutputFile)) {
                        // A replacement assignment may publish a fresh verdict while a
                        // previous monitor cycle is still holding an interrupted claim.
                        // The fresh assignment file wins; retain the old claim as audit
                        // evidence instead of allowing it to mask replacement output.
                        if (fsExistsSync(outputFile)) {
                            const stalePath = `${processingOutputFile}.stale`;
                            try {
                                renameSync(processingOutputFile, stalePath);
                            }
                            catch { /* leave it for the next cycle */ }
                        }
                        else {
                            verdictFile = processingOutputFile;
                            return;
                        }
                    }
                    const raw = readFileSync(outputFile, 'utf-8');
                    parseCliWorkerVerdict(raw);
                    renameSync(outputFile, processingOutputFile);
                    verdictFile = processingOutputFile;
                });
            }
            if (cursorReviewer) {
                const raw = await readFile(verdictFile, 'utf-8');
                payload = parseCliWorkerVerdict(raw);
            }
            else {
                const artifactState = await withProcessIdentityFileLock(`${outputFile}.lock`, async () => {
                    const artifact = await readNonCursorVerdictArtifact(outputFile);
                    if (fsExistsSync(nonCursorVerdictStaleMarkerPath(outputFile, artifact.artifactFingerprint))) {
                        return { kind: 'quarantined', artifactFingerprint: artifact.artifactFingerprint };
                    }
                    const parsed = parseCliWorkerVerdict(artifact.raw);
                    const bindingPath = nonCursorVerdictBindingPath(outputFile);
                    const bindingRead = await readNonCursorVerdictBinding(bindingPath);
                    if (bindingRead.kind === 'invalid') {
                        const quarantined = await quarantineNonCursorVerdict(outputFile, artifact.artifactFingerprint, worker.name, parsed.task_id, 1, 'verdict_binding_malformed');
                        return {
                            kind: quarantined ? 'quarantined' : 'quarantine_failed',
                            artifactFingerprint: artifact.artifactFingerprint,
                        };
                    }
                    let binding = bindingRead.kind === 'valid' ? bindingRead.binding : null;
                    if (binding && binding.artifact_fingerprint !== artifact.artifactFingerprint) {
                        await rm(bindingPath, { force: true });
                        binding = null;
                    }
                    if (binding && binding.worker_name !== worker.name) {
                        const quarantined = await quarantineNonCursorVerdict(outputFile, artifact.artifactFingerprint, worker.name, binding.task_id, binding.task_version, 'verdict_binding_worker_mismatch');
                        return {
                            kind: quarantined ? 'quarantined' : 'quarantine_failed',
                            artifactFingerprint: artifact.artifactFingerprint,
                        };
                    }
                    return { kind: 'ready', payload: parsed, artifactFingerprint: artifact.artifactFingerprint, binding };
                }, 100);
                if (artifactState.kind !== 'ready') {
                    results.push({
                        workerName: worker.name,
                        taskId: null,
                        status: 'skipped',
                        reason: artifactState.kind === 'quarantined'
                            ? 'stale_verdict_quarantined'
                            : 'verdict_quarantine_failed',
                    });
                    continue;
                }
                payload = artifactState.payload;
                nonCursorArtifactFingerprint = artifactState.artifactFingerprint;
                nonCursorBinding = artifactState.binding;
            }
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            if (!cursorReviewer && reason === 'process_identity_lock_timeout') {
                results.push({
                    workerName: worker.name,
                    taskId: null,
                    status: 'skipped',
                    reason: 'verdict_artifact_lock_contention',
                });
                continue;
            }
            if (!cursorReviewer && reason === 'verdict_artifact_changed') {
                results.push({
                    workerName: worker.name,
                    taskId: null,
                    status: 'skipped',
                    reason,
                });
                continue;
            }
            await appendTeamEvent(sanitized, {
                type: 'team_leader_nudge',
                worker: 'leader-fixed',
                reason: `cli_worker_verdict_parse_failed:${worker.name}:${reason}`,
            }, cwd).catch(logEventFailure);
            results.push({ workerName: worker.name, taskId: null, status: 'parse_failed', reason });
            continue;
        }
        if (cursorReviewer && payload.role !== workerRole) {
            await appendTeamEvent(sanitized, {
                type: 'team_leader_nudge',
                worker: 'leader-fixed',
                reason: `cli_worker_verdict_role_mismatch:${worker.name}:expected=${workerRole}:actual=${payload.role}`,
            }, cwd).catch(logEventFailure);
            if (verdictFile === processingOutputFile) {
                try {
                    await rename(verdictFile, processedOutputFile);
                }
                catch { /* best-effort quarantine */ }
            }
            results.push({
                workerName: worker.name,
                taskId: payload.task_id,
                status: 'skipped',
                verdict: payload.verdict,
                reason: 'cursor_verdict_role_mismatch',
            });
            continue;
        }
        const candidateTaskIds = new Set();
        if (!cursorReviewer && nonCursorBinding) {
            candidateTaskIds.add(nonCursorBinding.task_id);
        }
        else {
            if (payload.task_id)
                candidateTaskIds.add(payload.task_id);
        }
        if (!cursorReviewer && !nonCursorBinding) {
            for (const id of worker.assigned_tasks ?? [])
                candidateTaskIds.add(id);
        }
        let targetTaskId = null;
        let targetTaskPath = null;
        let targetTaskVersion = null;
        if (!cursorReviewer && nonCursorBinding) {
            targetTaskId = nonCursorBinding.task_id;
            targetTaskPath = absPath(cwd, TeamPaths.taskFile(sanitized, nonCursorBinding.task_id));
            targetTaskVersion = nonCursorBinding.task_version;
        }
        for (const taskId of candidateTaskIds) {
            if (targetTaskId)
                break;
            if (!TASK_ID_SAFE_PATTERN.test(taskId))
                continue;
            const taskPath = absPath(cwd, TeamPaths.taskFile(sanitized, taskId));
            let taskData;
            try {
                taskData = await teamReadTask(sanitized, taskId, cwd);
            }
            catch {
                // A selected task must pass the canonical persisted schema before it
                // can be considered for a verdict publication.
                continue;
            }
            if (!taskData)
                continue;
            try {
                const taskRole = typeof taskData.role === 'string'
                    ? normalizeDelegationRole(taskData.role)
                    : null;
                const claim = taskData.claim && typeof taskData.claim === 'object'
                    ? taskData.claim
                    : null;
                const claimMatchesCursorWorker = !cursorReviewer || (claim?.owner === worker.name
                    && payload.claim_token === claim.token
                    && payload.task_version === taskData.version
                    && (worker.launch_attempt_id === undefined || claim.launch_attempt_id === worker.launch_attempt_id)
                    && (worker.launch_attempt_id === undefined || payload.launch_attempt_id === worker.launch_attempt_id));
                if (taskData.owner === worker.name
                    && taskData.status === 'in_progress'
                    && (!cursorReviewer || taskRole === workerRole)
                    && claimMatchesCursorWorker) {
                    targetTaskId = taskId;
                    targetTaskPath = taskPath;
                    targetTaskVersion = taskData.version ?? 1;
                    break;
                }
            }
            catch {
                // skip a task that cannot be compared to this verdict
            }
        }
        if (!targetTaskId || !targetTaskPath || targetTaskVersion === null) {
            if (cursorReviewer && verdictFile === processingOutputFile) {
                const processedTaskPath = absPath(cwd, TeamPaths.taskFile(sanitized, payload.task_id));
                try {
                    const processedTask = JSON.parse(readFileSync(processedTaskPath, 'utf-8'));
                    const metadata = processedTask.metadata && typeof processedTask.metadata === 'object'
                        ? processedTask.metadata
                        : undefined;
                    const processedTaskRole = typeof processedTask.role === 'string'
                        ? normalizeDelegationRole(processedTask.role)
                        : null;
                    const taskAlreadyRecorded = processedTask.owner === worker.name
                        && (processedTask.status === 'completed' || processedTask.status === 'failed')
                        && (!cursorReviewer || processedTaskRole === workerRole)
                        && metadata?.verdict_source === 'cli_worker_output_contract'
                        && (!cursorReviewer
                            || (metadata.verdict_claim_token === payload.claim_token
                                && metadata.verdict_task_version === payload.task_version))
                        && (worker.launch_attempt_id === undefined
                            || metadata.verdict_worker_launch_attempt_id === worker.launch_attempt_id)
                        && metadata.verdict === payload.verdict;
                    if (taskAlreadyRecorded) {
                        try {
                            await rename(verdictFile, processedOutputFile);
                        }
                        catch { /* best-effort */ }
                        results.push({
                            workerName: worker.name,
                            taskId: payload.task_id,
                            status: 'already_terminal',
                            verdict: payload.verdict,
                        });
                        continue;
                    }
                    const currentClaim = processedTask.claim && typeof processedTask.claim === 'object'
                        ? processedTask.claim
                        : null;
                    const activeClaimMismatch = processedTask.owner === worker.name
                        && processedTask.status === 'in_progress'
                        && currentClaim?.owner === worker.name
                        && (!cursorReviewer || processedTaskRole === workerRole);
                    if (activeClaimMismatch) {
                        try {
                            await rename(verdictFile, processedOutputFile);
                        }
                        catch { /* best-effort quarantine */ }
                        results.push({
                            workerName: worker.name,
                            taskId: payload.task_id,
                            status: 'skipped',
                            verdict: payload.verdict,
                            reason: 'cursor_verdict_claim_mismatch',
                        });
                        continue;
                    }
                }
                catch {
                    // Fall through to the existing no-in-progress warning.
                }
            }
            await appendTeamEvent(sanitized, {
                type: 'team_leader_nudge',
                worker: 'leader-fixed',
                reason: `cli_worker_verdict_no_in_progress_task:${worker.name}:verdict=${payload.verdict}`,
            }, cwd).catch(logEventFailure);
            results.push({
                workerName: worker.name,
                taskId: payload.task_id,
                status: 'no_in_progress_task',
                verdict: payload.verdict,
            });
            continue;
        }
        const terminalStatus = payload.verdict === 'approve' ? 'completed' : 'failed';
        const canonicalTaskPath = targetTaskPath;
        const observedTaskVersion = targetTaskVersion;
        let transitionOk = false;
        let publishFailureReason;
        try {
            if (cursorReviewer) {
                const transition = await teamTransitionTaskStatus(sanitized, targetTaskId, 'in_progress', terminalStatus, payload.claim_token, cwd, terminalStatus === 'completed'
                    ? {
                        result: payload.summary,
                        metadata: {
                            verdict: payload.verdict,
                            verdict_summary: payload.summary,
                            verdict_findings: payload.findings,
                            verdict_role: payload.role,
                            verdict_source: 'cli_worker_output_contract',
                            verdict_claim_token: payload.claim_token,
                            verdict_task_version: payload.task_version,
                            ...(worker.launch_attempt_id
                                ? { verdict_worker_launch_attempt_id: worker.launch_attempt_id }
                                : {}),
                        },
                    }
                    : {
                        error: `cli_worker_verdict:${payload.verdict}:${payload.summary}`,
                        metadata: {
                            verdict: payload.verdict,
                            verdict_summary: payload.summary,
                            verdict_findings: payload.findings,
                            verdict_role: payload.role,
                            verdict_source: 'cli_worker_output_contract',
                            verdict_claim_token: payload.claim_token,
                            verdict_task_version: payload.task_version,
                            ...(worker.launch_attempt_id
                                ? { verdict_worker_launch_attempt_id: worker.launch_attempt_id }
                                : {}),
                        },
                    });
                transitionOk = transition.ok;
            }
            else {
                const artifactResult = await withProcessIdentityFileLock(`${outputFile}.lock`, async () => {
                    let artifact;
                    try {
                        artifact = await readNonCursorVerdictArtifact(outputFile);
                    }
                    catch (error) {
                        return {
                            ok: false,
                            reason: error instanceof Error && error.message === 'verdict_artifact_changed'
                                ? 'verdict_artifact_changed'
                                : 'verdict_artifact_missing',
                        };
                    }
                    const artifactFingerprint = artifact.artifactFingerprint;
                    if (artifactFingerprint !== nonCursorArtifactFingerprint) {
                        return { ok: false, reason: 'verdict_artifact_changed' };
                    }
                    if (fsExistsSync(nonCursorVerdictStaleMarkerPath(outputFile, artifactFingerprint))) {
                        return { ok: false, reason: 'stale_verdict_quarantined' };
                    }
                    const bindingPath = nonCursorVerdictBindingPath(outputFile);
                    const bindingRead = await readNonCursorVerdictBinding(bindingPath);
                    if (bindingRead.kind === 'invalid') {
                        const quarantined = await quarantineNonCursorVerdict(outputFile, artifactFingerprint, worker.name, targetTaskId, observedTaskVersion, 'verdict_binding_malformed');
                        return {
                            ok: false,
                            reason: quarantined
                                ? 'stale_verdict_quarantined'
                                : 'verdict_quarantine_failed',
                        };
                    }
                    let binding = bindingRead.kind === 'valid' ? bindingRead.binding : null;
                    if (binding && (binding.artifact_fingerprint !== artifactFingerprint
                        || binding.worker_name !== worker.name
                        || binding.task_id !== targetTaskId
                        || binding.task_version !== observedTaskVersion)) {
                        const quarantined = await quarantineNonCursorVerdict(outputFile, artifactFingerprint, worker.name, binding.task_id, binding.task_version, 'verdict_binding_identity_conflict');
                        return {
                            ok: false,
                            reason: quarantined
                                ? 'stale_verdict_quarantined'
                                : 'verdict_quarantine_failed',
                        };
                    }
                    if (!binding) {
                        binding = {
                            schema_version: 1,
                            artifact_fingerprint: artifactFingerprint,
                            worker_name: worker.name,
                            task_id: targetTaskId,
                            task_version: observedTaskVersion,
                        };
                        try {
                            await writeAtomic(bindingPath, JSON.stringify(binding, null, 2));
                        }
                        catch {
                            const quarantined = await quarantineNonCursorVerdict(outputFile, artifactFingerprint, worker.name, targetTaskId, observedTaskVersion, 'verdict_binding_persist_failed');
                            return {
                                ok: false,
                                reason: quarantined
                                    ? 'verdict_binding_persist_failed'
                                    : 'verdict_quarantine_failed',
                            };
                        }
                    }
                    const lock = await withTaskClaimLock(sanitized, targetTaskId, cwd, async () => {
                        let current;
                        try {
                            current = await teamReadTask(sanitized, targetTaskId, cwd);
                        }
                        catch {
                            return { ok: false, reason: 'task_schema_conflict' };
                        }
                        if (!current)
                            return { ok: false, reason: 'task_missing' };
                        const currentVersion = current.version ?? 1;
                        if (currentVersion !== observedTaskVersion) {
                            return { ok: false, reason: 'task_version_conflict' };
                        }
                        if (current.status !== 'in_progress' || current.owner !== worker.name) {
                            return { ok: false, reason: 'task_claim_conflict' };
                        }
                        let terminalCandidate;
                        try {
                            terminalCandidate = normalizeTaskRecord({
                                ...current,
                                status: terminalStatus,
                                completed_at: new Date().toISOString(),
                                claim: undefined,
                                version: currentVersion + 1,
                                metadata: {
                                    ...(current.metadata ?? {}),
                                    verdict: payload.verdict,
                                    verdict_summary: payload.summary,
                                    verdict_findings: payload.findings,
                                    verdict_role: payload.role,
                                    verdict_source: 'cli_worker_output_contract',
                                },
                                ...(terminalStatus === 'failed'
                                    ? { error: `cli_worker_verdict:${payload.verdict}:${payload.summary}` }
                                    : {}),
                            });
                        }
                        catch {
                            return { ok: false, reason: 'task_schema_conflict' };
                        }
                        try {
                            await writeAtomic(canonicalTaskPath, JSON.stringify(terminalCandidate, null, 2));
                        }
                        catch {
                            return { ok: false, reason: 'task_publish_failed' };
                        }
                        return { ok: true };
                    });
                    if (!lock.ok) {
                        return { ok: false, reason: 'task_claim_lock_contention' };
                    }
                    if (!lock.value.ok) {
                        if (lock.value.reason === 'task_publish_failed') {
                            return lock.value;
                        }
                        const quarantined = await quarantineNonCursorVerdict(outputFile, artifactFingerprint, worker.name, targetTaskId, observedTaskVersion, lock.value.reason);
                        return {
                            ok: false,
                            reason: quarantined
                                ? `stale_${lock.value.reason}_quarantined`
                                : 'verdict_quarantine_failed',
                        };
                    }
                    return { ok: true };
                }, 100);
                if (!artifactResult.ok) {
                    publishFailureReason = artifactResult.reason;
                }
                else {
                    transitionOk = true;
                }
            }
        }
        catch (error) {
            // Leave the verdict artifact retryable when the canonical publication
            // cannot be completed.
            publishFailureReason = !cursorReviewer
                && error instanceof Error
                && error.message === 'process_identity_lock_timeout'
                ? 'verdict_artifact_lock_contention'
                : 'task_publish_failed';
        }
        if (!transitionOk) {
            results.push({
                workerName: worker.name,
                taskId: targetTaskId,
                status: cursorReviewer ? 'already_terminal' : 'skipped',
                verdict: payload.verdict,
                ...(cursorReviewer
                    ? {}
                    : { reason: publishFailureReason ?? 'task_transition_rejected' }),
            });
            continue;
        }
        if (!cursorReviewer) {
            let eventAppended = false;
            try {
                await appendTeamEvent(sanitized, {
                    type: terminalStatus === 'completed' ? 'task_completed' : 'task_failed',
                    worker: worker.name,
                    task_id: targetTaskId,
                    reason: `cli_worker_verdict:${payload.verdict}`,
                }, cwd);
                eventAppended = true;
            }
            catch (error) {
                logEventFailure(error);
            }
            if (terminalStatus === 'completed' && eventAppended) {
                await teamMarkTaskCompleted(sanitized, targetTaskId, cwd).catch(logCompletionMarkerFailure);
            }
        }
        if (!cursorReviewer) {
            try {
                await withProcessIdentityFileLock(`${outputFile}.lock`, async () => {
                    const artifact = await readNonCursorVerdictArtifact(verdictFile);
                    if (artifact.artifactFingerprint !== nonCursorArtifactFingerprint)
                        return;
                    const bindingPath = nonCursorVerdictBindingPath(outputFile);
                    const binding = await readNonCursorVerdictBinding(bindingPath);
                    if (binding.kind !== 'valid'
                        || binding.binding.artifact_fingerprint !== nonCursorArtifactFingerprint
                        || binding.binding.worker_name !== worker.name
                        || binding.binding.task_id !== targetTaskId
                        || binding.binding.task_version !== observedTaskVersion)
                        return;
                    // Only consume this invocation's artifact. A failed rename leaves
                    // its binding intact so retries cannot adopt a replacement claim.
                    await rename(verdictFile, processedOutputFile);
                    await rm(bindingPath, { force: true });
                }, 100);
            }
            catch {
                // Task publication already committed. Cleanup remains best-effort.
            }
        }
        else {
            try {
                await rename(verdictFile, processedOutputFile);
            }
            catch {
                // best-effort; reprocess is idempotent (already_terminal on rerun)
            }
        }
        results.push({
            workerName: worker.name,
            taskId: targetTaskId,
            status: terminalStatus,
            verdict: payload.verdict,
        });
    }
    return results;
}
// ---------------------------------------------------------------------------
// monitorTeam — snapshot-based, event-driven (no watchdog)
// ---------------------------------------------------------------------------
/**
 * Take a single monitor snapshot of team state.
 * Caller drives the loop (e.g., runtime-cli poll interval or event trigger).
 */
export async function monitorTeamV2(teamName, cwd, expectedInstanceId) {
    const monitorStartMs = performance.now();
    const sanitized = sanitizeTeamName(teamName);
    const config = await readTeamConfig(sanitized, cwd);
    if (!config)
        return null;
    if (!config.instance_id) {
        if (expectedInstanceId !== undefined)
            throw new Error('team_instance_authority_missing');
        return null;
    }
    if (expectedInstanceId !== undefined && config.instance_id.toLowerCase() !== expectedInstanceId.toLowerCase()) {
        throw new Error('team_instance_mismatch');
    }
    const monitorInstance = createTeamInstanceBinding({
        teamName: sanitized,
        cwd,
        instanceId: expectedInstanceId ?? config.instance_id,
    });
    // AC-7: Convert CLI-worker verdict files into task transitions before counting.
    // Runs best-effort so monitor cycles never fail because of verdict handling.
    try {
        await processCliWorkerVerdicts(sanitized, cwd, monitorInstance.instance_id);
    }
    catch (err) {
        if (isTeamInstanceBoundaryError(err))
            throw err;
        process.stderr.write(`[team/runtime-v2] processCliWorkerVerdicts failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    const previousSnapshot = await teamReadMonitorSnapshot(sanitized, cwd);
    // Load all tasks
    const listTasksStartMs = performance.now();
    const allTasks = await teamListTasks(sanitized, cwd);
    const listTasksMs = performance.now() - listTasksStartMs;
    const taskById = new Map(allTasks.map((task) => [task.id, task]));
    const inProgressByOwner = new Map();
    for (const task of allTasks) {
        if (task.status !== 'in_progress' || !task.owner)
            continue;
        const existing = inProgressByOwner.get(task.owner) || [];
        existing.push(task);
        inProgressByOwner.set(task.owner, existing);
    }
    // Scan workers
    const workers = [];
    const deadWorkers = [];
    const nonReportingWorkers = [];
    const recommendations = [];
    const workerScanStartMs = performance.now();
    const workerSignals = await Promise.all(config.workers.map(async (worker) => {
        const ownership = configuredPaneOwnership(config, worker);
        const liveness = ownership ? await getOwnedWorkerLiveness(ownership) : 'unknown';
        const providerLiveness = await getWorkerProviderLiveness(sanitized, cwd, config.instance_id, worker);
        const paneAlive = liveness === 'alive';
        const [status, heartbeat, paneCapture] = await Promise.all([
            readWorkerStatus(sanitized, worker.name, cwd),
            readWorkerHeartbeat(sanitized, worker.name, cwd),
            paneAlive && ownership ? captureOwnedTeamPane(ownership) : Promise.resolve(''),
        ]);
        return { worker, alive: paneAlive, liveness, providerLiveness, status, heartbeat, paneCapture };
    }));
    const workerScanMs = performance.now() - workerScanStartMs;
    for (const { worker: w, alive, liveness, providerLiveness, status, heartbeat, paneCapture } of workerSignals) {
        const currentTask = status.current_task_id ? taskById.get(status.current_task_id) ?? null : null;
        const outstandingTask = currentTask ?? findOutstandingWorkerTask(w, taskById, inProgressByOwner);
        const expectedTaskId = status.current_task_id ?? outstandingTask?.id ?? w.assigned_tasks[0] ?? '';
        const previousTurns = previousSnapshot ? (previousSnapshot.workerTurnCountByName[w.name] ?? 0) : null;
        const previousTaskId = previousSnapshot?.workerTaskIdByName[w.name] ?? '';
        const currentTaskId = status.current_task_id ?? '';
        const turnsWithoutProgress = heartbeat &&
            previousTurns !== null &&
            status.state === 'working' &&
            currentTask &&
            (currentTask.status === 'pending' || currentTask.status === 'in_progress') &&
            currentTaskId !== '' &&
            previousTaskId === currentTaskId
            ? Math.max(0, heartbeat.turn_count - previousTurns)
            : 0;
        workers.push({
            name: w.name,
            alive,
            liveness,
            providerLiveness,
            status,
            heartbeat,
            assignedTasks: w.assigned_tasks,
            working_dir: w.working_dir,
            worktree_repo_root: w.worktree_repo_root,
            worktree_path: w.worktree_path,
            worktree_branch: w.worktree_branch,
            worktree_detached: w.worktree_detached,
            worktree_created: w.worktree_created,
            team_state_root: w.team_state_root,
            turnsWithoutProgress,
        });
        if (providerLiveness === 'dead') {
            deadWorkers.push(w.name);
            const deadWorkerTasks = inProgressByOwner.get(w.name) || [];
            for (const t of deadWorkerTasks) {
                recommendations.push(`Reassign task-${t.id} from dead ${w.name}`);
            }
        }
        const paneSuggestsIdle = alive && paneLooksReady(paneCapture) && !paneHasActiveTask(paneCapture);
        const statusFresh = isFreshTimestamp(status.updated_at);
        const heartbeatFresh = isFreshTimestamp(heartbeat?.last_turn_at);
        const hasWorkStartEvidence = expectedTaskId !== '' && hasWorkerStatusProgress(status, expectedTaskId);
        const missingDependencyIds = outstandingTask
            ? getMissingDependencyIds(outstandingTask, taskById)
            : [];
        let stallReason = null;
        if (paneSuggestsIdle && missingDependencyIds.length > 0) {
            stallReason = 'missing_dependency';
        }
        else if (paneSuggestsIdle && expectedTaskId !== '' && !hasWorkStartEvidence) {
            stallReason = 'no_work_start_evidence';
        }
        else if (paneSuggestsIdle && expectedTaskId !== '' && (!statusFresh || !heartbeatFresh)) {
            stallReason = 'stale_or_missing_worker_reports';
        }
        else if (paneSuggestsIdle && turnsWithoutProgress > 5) {
            stallReason = 'no_meaningful_turn_progress';
        }
        if (stallReason) {
            nonReportingWorkers.push(w.name);
            if (stallReason === 'missing_dependency') {
                recommendations.push(`Investigate ${w.name}: task-${outstandingTask?.id ?? expectedTaskId} is blocked by missing task ids [${missingDependencyIds.join(', ')}]; pane is idle at prompt`);
            }
            else if (stallReason === 'no_work_start_evidence') {
                recommendations.push(`Investigate ${w.name}: assigned work but no work-start evidence; pane is idle at prompt`);
            }
            else if (stallReason === 'stale_or_missing_worker_reports') {
                recommendations.push(`Investigate ${w.name}: pane is idle while status/heartbeat are stale or missing`);
            }
            else {
                recommendations.push(`Investigate ${w.name}: no meaningful turn progress and pane is idle at prompt`);
            }
        }
    }
    // Count tasks
    const taskCounts = {
        total: allTasks.length,
        pending: allTasks.filter((t) => t.status === 'pending').length,
        blocked: allTasks.filter((t) => t.status === 'blocked').length,
        in_progress: allTasks.filter((t) => t.status === 'in_progress').length,
        completed: allTasks.filter((t) => t.status === 'completed').length,
        failed: allTasks.filter((t) => t.status === 'failed').length,
    };
    const allTasksTerminal = taskCounts.pending === 0 && taskCounts.blocked === 0 && taskCounts.in_progress === 0;
    for (const task of allTasks) {
        const missingDependencyIds = getMissingDependencyIds(task, taskById);
        if (missingDependencyIds.length === 0) {
            continue;
        }
        recommendations.push(`Investigate task-${task.id}: depends on missing task ids [${missingDependencyIds.join(', ')}]`);
    }
    // Infer phase from task distribution
    const phase = inferPhase(allTasks.map((t) => ({
        status: t.status,
        metadata: undefined,
    })));
    const updatedAt = new Date().toISOString();
    const totalMs = performance.now() - monitorStartMs;
    await withTeamInstanceLifecycleLock(monitorInstance.cwd, monitorInstance.team_name, async () => {
        // Revalidate the originally observed incarnation immediately before all
        // monitor mutations. A cycle that scanned A must never emit/write into B.
        await assertTeamInstanceUnderLock(monitorInstance);
        await emitMonitorDerivedEvents(sanitized, allTasks, workers.map((w) => ({ name: w.name, alive: w.alive, liveness: w.liveness, status: w.status })), previousSnapshot, cwd);
        await assertTeamInstanceUnderLock(monitorInstance);
        await teamWriteMonitorSnapshot(sanitized, {
            taskStatusById: Object.fromEntries(allTasks.map((t) => [t.id, t.status])),
            workerAliveByName: Object.fromEntries(workers.map((w) => [w.name, w.alive])),
            workerLivenessByName: Object.fromEntries(workers.map((w) => [w.name, w.liveness])),
            workerStateByName: Object.fromEntries(workers.map((w) => [w.name, w.status.state])),
            workerTurnCountByName: Object.fromEntries(workers.map((w) => [w.name, w.heartbeat?.turn_count ?? 0])),
            workerTaskIdByName: Object.fromEntries(workers.map((w) => [w.name, w.status.current_task_id ?? ''])),
            mailboxNotifiedByMessageId: previousSnapshot?.mailboxNotifiedByMessageId ?? {},
            completedEventTaskIds: previousSnapshot?.completedEventTaskIds ?? {},
            monitorTimings: {
                list_tasks_ms: Number(listTasksMs.toFixed(2)),
                worker_scan_ms: Number(workerScanMs.toFixed(2)),
                mailbox_delivery_ms: 0,
                total_ms: Number(totalMs.toFixed(2)),
                updated_at: updatedAt,
            },
        }, cwd);
    });
    return {
        teamName: sanitized,
        phase,
        workers,
        tasks: {
            ...taskCounts,
            items: allTasks,
        },
        allTasksTerminal,
        deadWorkers,
        nonReportingWorkers,
        recommendations,
        performance: {
            list_tasks_ms: Number(listTasksMs.toFixed(2)),
            worker_scan_ms: Number(workerScanMs.toFixed(2)),
            total_ms: Number(totalMs.toFixed(2)),
            updated_at: updatedAt,
        },
    };
}
// ---------------------------------------------------------------------------
// shutdownTeam — graceful shutdown with gate, ack, force kill
// ---------------------------------------------------------------------------
/**
 * Graceful team shutdown:
 * 1. Shutdown gate check (unless force)
 * 2. Send shutdown request to all workers via inbox
 * 3. Wait for ack or timeout
 * 4. Force kill remaining tmux panes
 * 5. Clean up state
 */
export async function shutdownTeamV2(teamName, cwd, options = {}) {
    const logEventFailure = createSwallowedErrorLogger('team.runtime-v2.shutdownTeamV2 appendTeamEvent failed');
    const force = options.force === true;
    const ralph = options.ralph === true;
    const timeoutMs = options.timeoutMs ?? 15_000;
    const sanitized = sanitizeTeamName(teamName);
    if (options.instanceId !== undefined) {
        const originalInstance = createTeamInstanceBinding({
            teamName: sanitized,
            cwd,
            instanceId: options.instanceId,
        });
        try {
            // A retained receipt authorizes only this original transaction, even
            // when a replacement now occupies the canonical team name.
            await retryTeamInstanceDisposal(originalInstance, TEAM_INSTANCE_FINAL_DISPOSAL_AUTHORIZATION);
            return { outcome: 'cleaned' };
        }
        catch (error) {
            if (!(error instanceof TeamInstanceError && error.code === 'team_instance_authority_missing')) {
                return { outcome: 'failed', reason: 'state_cleanup_failed', detail: error instanceof Error ? error.message : String(error) };
            }
        }
    }
    const assertShutdownGate = async (currentConfig) => {
        if (force)
            return;
        const allTasks = await teamListTasks(sanitized, cwd);
        const governance = getConfigGovernance(currentConfig);
        const gate = {
            total: allTasks.length,
            pending: allTasks.filter((t) => t.status === 'pending').length,
            blocked: allTasks.filter((t) => t.status === 'blocked').length,
            in_progress: allTasks.filter((t) => t.status === 'in_progress').length,
            completed: allTasks.filter((t) => t.status === 'completed').length,
            failed: allTasks.filter((t) => t.status === 'failed').length,
            allowed: false,
        };
        gate.allowed = gate.pending === 0 && gate.blocked === 0 && gate.in_progress === 0 && gate.failed === 0;
        await appendTeamEvent(sanitized, {
            type: 'shutdown_gate',
            worker: 'leader-fixed',
            reason: `allowed=${gate.allowed} total=${gate.total} pending=${gate.pending} blocked=${gate.blocked} in_progress=${gate.in_progress} completed=${gate.completed} failed=${gate.failed}${ralph ? ' policy=ralph' : ''}`,
        }, cwd).catch(logEventFailure);
        if (gate.allowed)
            return;
        const hasActiveWork = gate.pending > 0 || gate.blocked > 0 || gate.in_progress > 0;
        if (!governance.cleanup_requires_all_workers_inactive) {
            await appendTeamEvent(sanitized, {
                type: 'team_leader_nudge',
                worker: 'leader-fixed',
                reason: `cleanup_override_bypassed:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`,
            }, cwd).catch(logEventFailure);
            return;
        }
        if (ralph && !hasActiveWork) {
            await appendTeamEvent(sanitized, {
                type: 'team_leader_nudge',
                worker: 'leader-fixed',
                reason: `gate_bypassed:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`,
            }, cwd).catch(logEventFailure);
            return;
        }
        throw new Error(`shutdown_gate_blocked:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`);
    };
    let ownedShutdownNonce = null;
    let instance;
    let config = await withTeamInstanceLifecycleLock(cwd, sanitized, async () => {
        const observed = await readTeamConfig(sanitized, cwd);
        if (observed && options.instanceId !== undefined
            && (!observed.instance_id || observed.instance_id.toLowerCase() !== options.instanceId.toLowerCase())) {
            throw new Error(observed.instance_id ? 'team_instance_mismatch' : 'team_instance_authority_missing');
        }
        const current = await migrateTeamConfigRevision(sanitized, cwd);
        if (!current)
            return null;
        if (!current.config.instance_id)
            throw new Error('team_instance_authority_missing');
        if (options.instanceId !== undefined && current.config.instance_id.toLowerCase() !== options.instanceId.toLowerCase()) {
            throw new Error('team_instance_mismatch');
        }
        const boundInstance = createTeamInstanceBinding({
            teamName: sanitized,
            cwd,
            instanceId: current.config.instance_id,
        });
        instance = boundInstance;
        await assertTeamInstanceUnderLock(boundInstance);
        if (!current.config.tmux_session
            || (!current.config.tmux_session.startsWith('cmux:')
                && !isValidTmuxServerIdentity(current.config.tmux_server_identity))) {
            throw new Error('tmux_server_identity_missing');
        }
        if (current.config.active_recovery)
            throw new Error(`shutdown_blocked:active_recovery:${current.config.active_recovery.recovery_id}`);
        if (current.config.active_scale_down)
            throw new Error(`shutdown_blocked:active_scale_down:${current.config.active_scale_down.operation_id}`);
        if (current.config.active_scale_up && current.config.active_scale_up.phase !== 'committed') {
            throw new Error(`shutdown_blocked:active_scale_up:${current.config.active_scale_up.operation_id}`);
        }
        if (current.config.lifecycle_state === 'shutting_down') {
            const attempt = current.config.shutdown_attempt;
            if (!attempt || !Number.isInteger(attempt.pid) || attempt.pid <= 0 || !attempt.process_started_at) {
                throw new Error('shutdown_fence_unowned');
            }
            const attemptInstanceId = attempt.instance_id;
            if (attemptInstanceId !== boundInstance.instance_id) {
                throw new Error('shutdown_fence_unowned');
            }
            // Verify all-dead-expiry provenance: the nonce must encode the
            // deadline, and the state_revision must match the config (proving
            // the shutdown_attempt was written atomically with lifecycle_state).
            const isAllDeadExpiry = attempt.nonce.startsWith('all-dead-expiry:')
                && attempt.state_revision === current.config.state_revision;
            const ownerIsDead = isProcessIdentityDead({ pid: attempt.pid, process_started_at: attempt.process_started_at });
            // Allow the exact same owner to adopt/resume their own all-dead-expiry
            // attempt (same pid + start identity). This handles the case where the
            // expiry and shutdown run in the same process. Also allow adoption when
            // the owner is dead. Reject all other live owners.
            const isSameOwner = attempt.pid === process.pid
                && attempt.process_started_at === currentProcessStartIdentity();
            if (!ownerIsDead && !isAllDeadExpiry) {
                throw new Error('shutdown_in_progress');
            }
            if (isAllDeadExpiry && !ownerIsDead && !isSameOwner) {
                throw new Error('shutdown_in_progress');
            }
        }
        else if (current.config.lifecycle_state !== 'stopped') {
            await assertShutdownGate(current.config);
        }
        const processStartedAt = currentProcessStartIdentity();
        if (!processStartedAt)
            throw new Error('process_start_identity_unavailable');
        ownedShutdownNonce = randomUUID();
        const nextRevision = current.stateRevision + 1;
        const next = { ...current.config, lifecycle_state: 'shutting_down', state_revision: nextRevision,
            shutdown_attempt: { nonce: ownedShutdownNonce, pid: process.pid, process_started_at: processStartedAt,
                state_revision: nextRevision, created_at: new Date().toISOString(),
                instance_id: boundInstance.instance_id },
            // Clearing all_dead_recovery when adopting into a real shutdown attempt.
            all_dead_recovery: undefined, };
        if (!await saveTeamConfigAtRevision(next, current.stateRevision, cwd, undefined, {
            ...(current.config.shutdown_attempt ? { reclaim: { shutdown_attempt: true } } : {}),
            ...(current.config.all_dead_recovery ? { release: { all_dead_recovery: true } } : {}),
        }))
            throw new Error('stale_state_revision');
        return next;
    });
    const revalidateShutdownFence = async () => withTeamInstanceLifecycleLock(cwd, sanitized, async () => {
        const current = await readRevisionedTeamConfig(sanitized, cwd);
        const attempt = current?.config.shutdown_attempt;
        const attemptInstanceId = attempt?.instance_id;
        if (!ownedShutdownNonce || !current || current.config.lifecycle_state !== 'shutting_down' || current.config.active_recovery
            || (current.config.active_scale_up && current.config.active_scale_up.phase !== 'committed') || !attempt || attempt.nonce !== ownedShutdownNonce
            || attempt.pid !== process.pid || attempt.process_started_at !== currentProcessStartIdentity()
            || !instance || attemptInstanceId !== instance.instance_id) {
            throw new Error(current?.config.active_recovery
                ? `shutdown_blocked:active_recovery:${current.config.active_recovery.recovery_id}` : 'shutdown_fence_lost');
        }
        return current.config;
    });
    const commitStoppedFenceUnderLock = async () => {
        const current = await readRevisionedTeamConfig(sanitized, cwd);
        const attempt = current?.config.shutdown_attempt;
        const attemptInstanceId = attempt?.instance_id;
        if (!ownedShutdownNonce || !current || current.config.lifecycle_state !== 'shutting_down' || current.config.active_recovery
            || (current.config.active_scale_up && current.config.active_scale_up.phase !== 'committed') || !attempt || attempt.nonce !== ownedShutdownNonce
            || attempt.pid !== process.pid || attempt.process_started_at !== currentProcessStartIdentity()
            || !instance || attemptInstanceId !== instance.instance_id) {
            throw new Error(current?.config.active_recovery
                ? `shutdown_blocked:active_recovery:${current.config.active_recovery.recovery_id}` : 'shutdown_fence_lost');
        }
        const stopped = { ...current.config, lifecycle_state: 'stopped', shutdown_attempt: undefined,
            state_revision: current.stateRevision + 1 };
        if (!await saveTeamConfigAtRevision(stopped, current.stateRevision, cwd, undefined, {
            release: { shutdown_attempt: true },
        }))
            throw new Error('stale_state_revision');
    };
    const rollbackRejectedShutdownFence = async (expected) => withTeamInstanceLifecycleLock(cwd, sanitized, async () => {
        const current = await readRevisionedTeamConfig(sanitized, cwd);
        const attemptInstanceId = current?.config.shutdown_attempt?.instance_id;
        if (!ownedShutdownNonce || !current || current.config.lifecycle_state !== 'shutting_down' || current.config.active_recovery
            || (current.config.active_scale_up && current.config.active_scale_up.phase !== 'committed')
            || current.stateRevision !== expected.state_revision || current.config.shutdown_attempt?.nonce !== ownedShutdownNonce
            || !instance || attemptInstanceId !== instance.instance_id)
            return false;
        const active = { ...current.config, lifecycle_state: 'active', shutdown_attempt: undefined,
            state_revision: current.stateRevision + 1 };
        return saveTeamConfigAtRevision(active, current.stateRevision, cwd, undefined, {
            release: { shutdown_attempt: true },
        });
    });
    const rollbackShutdownForRetry = async () => {
        if (!config)
            return false;
        const rolled = await rollbackRejectedShutdownFence(config).catch(() => false);
        if (rolled) {
            // Fence was rolled back to 'active'; update local config snapshot.
            // Do NOT call finalizeAutoMerge — the team is going back to active
            // and must preserve its orchestrator, cadence, and worker registrations
            // for retry.
            const refreshed = await readRevisionedTeamConfig(sanitized, cwd);
            if (refreshed)
                config = refreshed.config;
            return true;
        }
        // If rollback failed (e.g. CAS lost or fence superseded), leave the
        // fence as-is — the config remains in shutting_down and orchestration
        // cleanup via finalizeAutoMerge is appropriate.
        return false;
    };
    const finalizeAutoMerge = async () => {
        const orchestrator = getTeamOrchestrator(sanitized);
        if (orchestrator) {
            try {
                const drainResult = await orchestrator.drainAndStop();
                if (drainResult.unmerged.length > 0) {
                    await appendTeamEvent(sanitized, {
                        type: 'team_leader_nudge',
                        worker: 'leader-fixed',
                        reason: `auto_merge_drain_unmerged:${drainResult.unmerged.map((u) => `${u.workerName}:${u.reason}`).join(',')}`,
                    }, cwd).catch(logEventFailure);
                }
                for (const w of config?.workers ?? []) {
                    try {
                        await orchestrator.unregisterWorker(w.name);
                    }
                    catch (err) {
                        process.stderr.write(`[team/runtime-v2] orchestrator.unregisterWorker(${w.name}) failed: ${err}\n`);
                    }
                }
            }
            catch (err) {
                process.stderr.write(`[team/runtime-v2] orchestrator drainAndStop: ${err}\n`);
            }
            finally {
                await stopTeamCadence(sanitized);
                unregisterTeamOrchestrator(sanitized);
            }
        }
        else {
            await stopTeamCadence(sanitized);
        }
    };
    if (!config) {
        // Receipt-only retry was attempted before reading the canonical name.
        // Missing config alone cannot establish provider termination or cleanup.
        // Worktree metadata and root AGENTS backups live under the scoped state
        // tree, so use non-mutating inspection and preserve state whenever any
        // recovery evidence exists.
        const cleanupSafety = inspectTeamWorktreeCleanupSafety(sanitized, cwd);
        if (cleanupSafety.hasEvidence || existsSync(absPath(cwd, TeamPaths.root(sanitized)))) {
            process.stderr.write('[team/runtime-v2] preserving team state because config is missing and worktree cleanup evidence remains\n');
            return { outcome: 'preserved', reason: 'config_missing_cleanup_evidence', workers: [] };
        }
        return { outcome: 'preserved', reason: 'config_missing_cleanup_evidence', workers: [] };
    }
    const shutdownInstance = instance;
    if (force) {
        await appendTeamEvent(sanitized, {
            type: 'shutdown_gate_forced',
            worker: 'leader-fixed',
            reason: 'force_bypass',
        }, cwd).catch(logEventFailure);
    }
    // 2. Send shutdown request to each worker
    const shutdownRequestTimes = new Map();
    for (const w of config.workers) {
        try {
            const requestedAt = new Date().toISOString();
            await writeShutdownRequest(sanitized, w.name, 'leader-fixed', cwd);
            shutdownRequestTimes.set(w.name, requestedAt);
            // Write shutdown inbox
            const shutdownRoot = workerInstructionStateRoot(cwd, sanitized);
            const shutdownAckPath = `${shutdownRoot}/workers/${w.name}/shutdown-ack.json`;
            const shutdownInbox = `# Shutdown Request\n\nAll tasks are complete. Please wrap up and respond with a shutdown acknowledgement.\n\nWrite your ack to: ${shutdownAckPath}\nFormat: {"status":"accept","reason":"ok","updated_at":"<iso>"}\n\nThen exit your session.\n`;
            await writeWorkerInbox(sanitized, w.name, shutdownInbox, cwd);
        }
        catch (err) {
            process.stderr.write(`[team/runtime-v2] shutdown request failed for ${w.name}: ${err}\n`);
        }
    }
    // 3. Wait for ack or timeout
    const deadline = Date.now() + timeoutMs;
    const rejected = [];
    const ackedWorkers = new Set();
    while (Date.now() < deadline) {
        for (const w of config.workers) {
            if (ackedWorkers.has(w.name))
                continue;
            const ack = await readShutdownAck(sanitized, w.name, cwd, shutdownRequestTimes.get(w.name));
            if (ack) {
                ackedWorkers.add(w.name);
                await appendTeamEvent(sanitized, {
                    type: 'shutdown_ack',
                    worker: w.name,
                    reason: ack.status === 'reject' ? `reject:${ack.reason || 'no_reason'}` : 'accept',
                }, cwd).catch(logEventFailure);
                if (ack.status === 'reject') {
                    rejected.push({ worker: w.name, reason: ack.reason || 'no_reason' });
                }
            }
        }
        if (rejected.length > 0 && !force) {
            const detail = rejected.map((r) => `${r.worker}:${r.reason}`).join(',');
            if (!await rollbackRejectedShutdownFence(config)) {
                throw new Error(`shutdown_rejected_fence_lost:${detail}`);
            }
            throw new Error(`shutdown_rejected:${detail}`);
        }
        // Check if all workers have acked or exited
        const allDone = config.workers.every((w) => ackedWorkers.has(w.name));
        if (allDone)
            break;
        await new Promise((r) => setTimeout(r, 2_000));
    }
    config = await revalidateShutdownFence();
    // 4. Force kill remaining tmux panes
    const recordedWorkerPaneIds = config.workers
        .map((w) => w.pane_id)
        .filter((p) => typeof p === 'string' && p.trim().length > 0);
    const providerCleanupFailures = [];
    const paneCleanupAlive = [];
    const paneCleanupUnknown = [];
    for (const worker of config.workers) {
        if (!worker.pane_id) {
            providerCleanupFailures.push(worker.name);
            continue;
        }
        if (!worker.launch_attempt_id) {
            // Provider termination cannot be proven without its exact launch
            // attempt. Preserve this worker rather than deriving authority from a
            // pane alone.
            providerCleanupFailures.push(worker.name);
            continue;
        }
        const provider = worker.launch_descriptor?.provider ?? worker.worker_cli;
        if (!provider || !config.tmux_session) {
            providerCleanupFailures.push(worker.name);
            continue;
        }
        const initialOwnership = configuredPaneOwnership(config, worker);
        const initialPaneLiveness = initialOwnership
            ? await getOwnedWorkerLiveness(initialOwnership)
            : 'unknown';
        let paneOwnership = null;
        if (initialPaneLiveness !== 'dead') {
            const ownership = await adoptWorkerPaneOwnership({
                provider: worker.pane_id.startsWith('%') ? 'tmux' : 'cmux',
                providerTarget: config.tmux_session,
                paneId: worker.pane_id,
                leaderPaneId: config.leader_pane_id ?? '',
                reservedPaneIds: config.workers.filter(candidate => candidate.name !== worker.name)
                    .map(candidate => candidate.pane_id).filter((paneId) => Boolean(paneId)),
                ...(config.tmux_server_identity
                    ? { tmuxServerIdentity: config.tmux_server_identity }
                    : {}),
            });
            if (!ownership.ok) {
                providerCleanupFailures.push(worker.name);
                continue;
            }
            paneOwnership = ownership.ownership;
        }
        const attempt = await loadWorkerLaunchAttempt({
            cwd,
            teamName: sanitized,
            instanceId: shutdownInstance.instance_id,
            workerName: worker.name,
            paneId: worker.pane_id,
            provider,
            attemptId: worker.launch_attempt_id,
            runtimeCliPath: resolveRuntimeCliPath(),
        });
        if (!attempt || !await retireAndCleanupCurrentWorkerLaunchAttempt(attempt, 'team_shutdown', async () => {
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
                if (lastLiveness === 'alive')
                    paneCleanupAlive.push(worker.name);
                else
                    paneCleanupUnknown.push(worker.name);
                return false;
            }
            catch {
                paneCleanupUnknown.push(worker.name);
                return false;
            }
        }))
            providerCleanupFailures.push(worker.name);
    }
    if (paneCleanupAlive.length > 0) {
        if (!await rollbackShutdownForRetry())
            await finalizeAutoMerge();
        return { outcome: 'preserved', reason: 'worker_panes_alive', workers: paneCleanupAlive };
    }
    if (paneCleanupUnknown.length > 0) {
        if (!await rollbackShutdownForRetry())
            await finalizeAutoMerge();
        return { outcome: 'preserved', reason: 'worker_pane_liveness_unknown', workers: paneCleanupUnknown };
    }
    if (providerCleanupFailures.length > 0) {
        process.stderr.write(`[team/runtime-v2] preserving panes/worktrees/state because provider cleanup is unverified: ${providerCleanupFailures.join(', ')}\n`);
        if (!await rollbackShutdownForRetry())
            await finalizeAutoMerge();
        return { outcome: 'preserved', reason: 'provider_cleanup_unverified', workers: providerCleanupFailures };
    }
    try {
        const { killTeamSession: killOwnedTeamSession, } = await import('./tmux-session.js');
        const ownsWindow = config.tmux_window_owned === true;
        const workerPaneIds = recordedWorkerPaneIds;
        const splitPaneMode = Boolean(config.tmux_session && !ownsWindow && config.tmux_session.includes(':'));
        if (!splitPaneMode && config.tmux_session) {
            if (!config.leader_pane_id) {
                if (!await rollbackShutdownForRetry())
                    await finalizeAutoMerge();
                return { outcome: 'preserved', reason: 'provider_cleanup_unverified', workers: ['leader-fixed'] };
            }
            const serverState = config.tmux_session.startsWith('cmux:')
                ? 'matching'
                : isValidTmuxServerIdentity(config.tmux_server_identity)
                    ? await observeTmuxServerIdentity(config.tmux_server_identity)
                    : 'unknown';
            if (serverState === 'unknown') {
                if (!await rollbackShutdownForRetry())
                    await finalizeAutoMerge();
                return { outcome: 'preserved', reason: 'provider_cleanup_unverified', workers: ['leader-fixed'] };
            }
            const sessionMode = ownsWindow
                ? (config.tmux_session.includes(':') ? 'dedicated-window' : 'detached-session')
                : 'detached-session';
            if (serverState === 'matching') {
                const leaderPresence = await observeTeamSessionTargetPresence({
                    sessionName: config.tmux_session,
                    sessionMode,
                    leaderPaneId: config.leader_pane_id,
                    ...(config.tmux_server_identity
                        ? { tmuxServerIdentity: config.tmux_server_identity }
                        : {}),
                });
                if (leaderPresence.kind !== 'owned' && leaderPresence.kind !== 'absent') {
                    if (!await rollbackShutdownForRetry())
                        await finalizeAutoMerge();
                    return { outcome: 'preserved', reason: 'provider_cleanup_unverified', workers: ['leader-fixed'] };
                }
            }
            if (!await killOwnedTeamSession(config.tmux_session, [], config.leader_pane_id, {
                sessionMode,
                ...(config.tmux_server_identity
                    ? { tmuxServerIdentity: config.tmux_server_identity }
                    : {}),
            })) {
                throw new Error('tmux cleanup unverified');
            }
        }
        const cleanupConfig = config;
        const paneById = new Map(cleanupConfig.workers
            .filter((w) => typeof w.pane_id === 'string' && w.pane_id.trim().length > 0)
            .map((w) => [w.pane_id, w.name]));
        const liveness = await Promise.all(workerPaneIds.map(async (paneId) => {
            const worker = cleanupConfig.workers.find(candidate => candidate.pane_id === paneId);
            const ownership = worker
                ? configuredPaneOwnership(cleanupConfig, worker)
                : configuredPaneOwnership(cleanupConfig, { pane_id: paneId });
            return [paneId, ownership ? await getOwnedWorkerLiveness(ownership) : 'unknown'];
        }));
        const aliveWorkers = liveness
            .filter(([, state]) => state === 'alive')
            .map(([paneId]) => paneById.get(paneId) ?? paneId);
        if (aliveWorkers.length > 0) {
            process.stderr.write(`[team/runtime-v2] preserving worktrees/state because worker pane(s) are still alive: ${aliveWorkers.join(', ')}
`);
            if (!await rollbackShutdownForRetry())
                await finalizeAutoMerge();
            return { outcome: 'preserved', reason: 'worker_panes_alive', workers: aliveWorkers };
        }
        const unknownWorkers = liveness
            .filter(([, state]) => state === 'unknown')
            .map(([paneId]) => paneById.get(paneId) ?? paneId);
        if (unknownWorkers.length > 0) {
            process.stderr.write(`[team/runtime-v2] preserving worktrees/state because worker pane liveness is unknown: ${unknownWorkers.join(', ')}
`);
            if (!await rollbackShutdownForRetry())
                await finalizeAutoMerge();
            return { outcome: 'preserved', reason: 'worker_pane_liveness_unknown', workers: unknownWorkers };
        }
    }
    catch (err) {
        process.stderr.write(`[team/runtime-v2] tmux cleanup: ${err}\n`);
        if (recordedWorkerPaneIds.length > 0) {
            process.stderr.write('[team/runtime-v2] preserving worktrees/state because tmux cleanup did not prove worker panes exited\n');
            if (!await rollbackShutdownForRetry())
                await finalizeAutoMerge();
            return { outcome: 'failed', reason: 'tmux_cleanup_failed', detail: err instanceof Error ? err.message : String(err) };
        }
    }
    // 5. Ralph completion logging
    if (ralph) {
        try {
            const finalTasks = await teamListTasks(sanitized, cwd);
            const completed = finalTasks.filter((t) => t.status === 'completed').length;
            const failed = finalTasks.filter((t) => t.status === 'failed').length;
            const pending = finalTasks.filter((t) => t.status === 'pending').length;
            await appendTeamEvent(sanitized, {
                type: 'team_leader_nudge',
                worker: 'leader-fixed',
                reason: `ralph_cleanup_summary: total=${finalTasks.length} completed=${completed} failed=${failed} pending=${pending} force=${force}`,
            }, cwd).catch(logEventFailure);
        }
        catch (error) {
            const detail = redactBoundedDiagnostic(error instanceof Error ? error.message : String(error), 500);
            const reason = `ralph_cleanup_summary_unavailable:${detail}`;
            process.stderr.write(`[team/runtime-v2] ${reason}\n`);
            await appendTeamEvent(sanitized, {
                type: 'team_leader_nudge',
                worker: 'leader-fixed',
                reason,
            }, cwd).catch(logEventFailure);
        }
    }
    // 6a. Drain the merge orchestrator (if attached). Final merge sweep before
    // cleanupTeamWorktrees touches per-worker worktrees. Also used by preserve-state
    // exits above so auto-merge shutdown is not skipped when pane liveness is unknown.
    await finalizeAutoMerge();
    // 6. Worktree cleanup and final state disposal are one instance-protected
    // transaction.  The external receipt is published before detaching the
    // disposable state root, so a later retry never discovers authority by name.
    return withTeamInstanceLifecycleLock(cwd, sanitized, async () => {
        await assertTeamInstanceUnderLock(shutdownInstance);
        await commitStoppedFenceUnderLock();
        let worktreeCleanupFailure = null;
        let preservedWorktrees = 0;
        try {
            const worktreeCleanup = cleanupTeamWorktrees(sanitized, cwd);
            preservedWorktrees = worktreeCleanup.preserved.length;
        }
        catch (err) {
            preservedWorktrees = 1;
            worktreeCleanupFailure = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[team/runtime-v2] worktree cleanup: ${err}\n`);
        }
        if (worktreeCleanupFailure) {
            return { outcome: 'failed', reason: 'worktree_cleanup_failed', detail: worktreeCleanupFailure };
        }
        if (preservedWorktrees > 0) {
            process.stderr.write(`[team/runtime-v2] preserved ${preservedWorktrees} worktree(s); keeping team state for follow-up cleanup\n`);
            return { outcome: 'preserved', reason: 'worktrees_preserved', workers: [] };
        }
        try {
            await disposeTeamInstanceUnderLock(shutdownInstance, TEAM_INSTANCE_FINAL_DISPOSAL_AUTHORIZATION);
        }
        catch (err) {
            return {
                outcome: 'failed',
                reason: 'state_cleanup_failed',
                detail: err instanceof Error ? err.message : String(err),
            };
        }
        return { outcome: 'cleaned' };
    });
}
// ---------------------------------------------------------------------------
// resumeTeam — reconstruct runtime from persisted state
// ---------------------------------------------------------------------------
export async function resumeTeamV2(teamName, cwd) {
    const sanitized = sanitizeTeamName(teamName);
    const config = await readTeamConfig(sanitized, cwd);
    if (!config?.instance_id)
        return null;
    // Verify tmux session is alive
    const sessionName = config.tmux_session || `omc-team-${sanitized}`;
    if (sessionName.startsWith('cmux:')) {
        return {
            teamName: sanitized,
            sanitizedName: sanitized,
            instanceId: config.instance_id,
            sessionName,
            ownsWindow: config.tmux_window_owned === true,
            config,
            cwd,
        };
    }
    if (!isValidTmuxServerIdentity(config.tmux_server_identity)
        || await observeTmuxServerIdentity(config.tmux_server_identity) !== 'matching') {
        return null;
    }
    if (!config.leader_pane_id)
        return null;
    const targetOwnership = await verifyTeamTargetOwnership({
        provider: 'tmux',
        providerTarget: sessionName,
        recipient: 'leader-fixed',
        recipientRole: 'leader',
        paneId: config.leader_pane_id,
        tmuxServerIdentity: config.tmux_server_identity,
    });
    if (targetOwnership.kind !== 'owned')
        return null;
    return {
        teamName: sanitized,
        sanitizedName: sanitized,
        instanceId: config.instance_id,
        sessionName,
        ownsWindow: config.tmux_window_owned === true,
        config,
        cwd,
    };
}
// ---------------------------------------------------------------------------
// findActiveTeams — discover running teams
// ---------------------------------------------------------------------------
export async function findActiveTeamsV2(cwd) {
    const root = join(getOmcRoot(cwd), 'state', 'team');
    if (!existsSync(root))
        return [];
    const entries = await readdir(root, { withFileTypes: true });
    const active = [];
    for (const e of entries) {
        if (!e.isDirectory())
            continue;
        const teamName = e.name;
        const config = await readTeamConfig(teamName, cwd);
        if (config) {
            active.push(teamName);
        }
    }
    return active;
}
//# sourceMappingURL=runtime-v2.js.map