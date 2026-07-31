/**
 * Event-driven team runtime v2 — replaces the polling watchdog from runtime.ts.
 *
 * Runtime selection:
 * - Default: v2 enabled
 * - Opt-out: set OMC_RUNTIME_V2=0|false|no|off to force legacy v1
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
import { tmuxExecAsync } from '../cli/tmux-utils.js';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { link, mkdir, open, readdir, readFile, rm, unlink, writeFile } from 'fs/promises';
import { performance } from 'perf_hooks';
import { TeamPaths, absPath, teamStateRoot } from './state-paths.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { allocateTasksToWorkers } from './allocation-policy.js';
import { readTeamConfig, readWorkerStatus, readWorkerHeartbeat, readMonitorSnapshot, writeMonitorSnapshot, writeShutdownRequest, readShutdownAck, writeWorkerInbox, listTasksFromFiles, saveTeamConfig, readRevisionedTeamConfig, saveTeamConfigAtRevision, migrateTeamConfigRevision, withTeamConfigMutationLock, cleanupTeamState, readTeamManifest, } from './monitor.js';
import { appendTeamEvent, emitMonitorDerivedEvents } from './events.js';
import { DEFAULT_TEAM_GOVERNANCE, DEFAULT_TEAM_TRANSPORT_POLICY, getConfigGovernance, } from './governance.js';
import { inferPhase } from './phase-controller.js';
import { validateTeamName } from './team-name.js';
import { WORKER_NAME_SAFE_PATTERN } from './contracts.js';
import { buildValidatedWorkerLaunchDescriptor, validateWorkerLaunchDescriptor, getContract, resolveValidatedBinaryPath, getWorkerEnv as getModelWorkerEnv, isPromptModeAgent, getPromptModeArgs, resolveClaudeWorkerModel, assertHeadlessSupported, isHeadlessSupportedOnPlatform, } from './model-contract.js';
import { createTeamSession, spawnWorkerInPane, sendToWorker, killTeamSession, waitForPaneReady, paneHasActiveTask, paneLooksReady, applyMainVerticalLayout, getWorkerLiveness, captureTeamPane, sendTeamPaneKey, splitTeamWorkerPane, splitTeamWorkerPaneWithEvidence, } from './tmux-session.js';
import { composeInitialInbox, ensureWorkerStateDir, writeWorkerOverlay, generateTriggerMessage, generatePromptModeStartupPrompt, renderRecoveryContinuationInstruction, } from './worker-bootstrap.js';
import { queueInboxInstruction } from './mcp-comm.js';
import { cleanupTeamWorktrees, inspectTeamWorktreeCleanupSafety, ensureWorkerWorktree, installWorktreeRootAgents, normalizeTeamWorktreeMode, } from './git-worktree.js';
import { formatOmcCliInvocation } from '../utils/omc-cli-rendering.js';
import { createSwallowedErrorLogger } from '../lib/swallowed-error.js';
import { CANONICAL_TEAM_ROLES, CURSOR_EXECUTOR_TEAM_ROLES } from '../shared/types.js';
import { loadConfig } from '../config/loader.js';
import { buildResolvedRoutingSnapshot, getRoleRoutingSpec } from './stage-router.js';
import { inferLaneIntent, routeTaskToRole } from './role-router.js';
import { normalizeDelegationRole } from '../features/delegation-routing/types.js';
import { cliWorkerOutputFilePath, parseCliWorkerVerdict, renderCliWorkerOutputContract, shouldInjectContract, } from './cli-worker-contract.js';
import { startMergeOrchestrator, recoverFromRestart, } from './merge-orchestrator.js';
import { ensureLeaderInbox, extendLeaderBootstrapPrompt, appendToLeaderInbox } from './leader-inbox.js';
import { execFileSync } from 'node:child_process';
import { isRuntimeV2Enabled } from './runtime-flags.js';
import { installCommitCadence, startFallbackPoller, uninstallCommitCadence, } from './worker-commit-cadence.js';
import { createHash, randomUUID } from 'node:crypto';
import { isMatchingRecoveryFinal, isSafeRecoveryRequestId, readRecoveryFinalState, readRecoveryOutcome, readRecoveryRequestReservation, readRecoveryResult, writeRecoveryFinal } from './recovery-request-store.js';
import { parseRecoveryIntent } from './runtime-owner-client.js';
import { runRecoverySaga } from './recovery-saga.js';
import { readTaskRecoveryCheckpoint, selectTaskRecoveryCheckpoint } from './task-recovery-checkpoint.js';
import { teamAdoptRecoveryReservations, teamRequeueRecoveredTask } from './team-ops.js';
import { currentProcessStartIdentity, isProcessIdentityDead, publishOwnerEpoch, readLatestOwnerEpoch, requireOwnerFence, requireOwnerProcessIdentity } from './team-owner-epoch.js';
import { withProcessIdentityFileLock } from './process-identity-lock.js';
import { waitForRecoveryGateRecord } from './worker-activation-gate.js';
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
export async function recoverDeadWorkerV2(teamName, cwd, { workerName, requestId = randomUUID(), timeoutMs = 180_000 }) {
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
    const client = runtimeOwnerRecoveryClient ?? {
        requestRuntimeOwnerRecovery: (input) => import('./runtime-owner-client.js').then(module => module.requestRuntimeOwnerRecovery(input)),
    };
    const result = await client.requestRuntimeOwnerRecovery({ requestId, cwd, teamName, workerName, timeoutMs });
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
const CURSOR_UNSUPPORTED_REVIEW_INTENT_RE = /\b(?:review|audit|critic|critique|security|vulnerabilit|cve|owasp|xss|csrf|sqli|verdict|approval|approve|final\s+decision)\b/i;
const CURSOR_EXECUTOR_CONTEXT_RE = /\b(?:implement|implementation|apply|edit|patch|fix|build|ci|lint|compile|tsc|type.?check|test|tests|debug|troubleshoot|investigate|root.?cause|diagnos|refactor|clean\s*up|simplif)\b/i;
const CURSOR_EXECUTOR_CONTEXT_INTENTS = new Set([
    'implementation',
    'build-fix',
    'debug',
    'cleanup',
    'verification',
]);
function isCursorExecutorContextTask(task) {
    const text = `${task.subject} ${task.description}`.trim();
    if (!text || CURSOR_UNSUPPORTED_REVIEW_INTENT_RE.test(text))
        return false;
    if (!CURSOR_EXECUTOR_CONTEXT_RE.test(text))
        return false;
    return CURSOR_EXECUTOR_CONTEXT_INTENTS.has(inferLaneIntent(text));
}
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
    const scaleUp = config.active_scale_up;
    if (scaleUp)
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
 * Returns the primary assignment by default; callers swap to the Claude
 * fallback if the primary provider's CLI binary is missing at spawn time.
 */
export function resolveTaskAssignment(task, resolvedRouting, roleRoutingConfig, resolvedBinaryPaths, fallbackAgent) {
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
    if (fallbackAgent === 'cursor') {
        if (CURSOR_EXECUTOR_TEAM_ROLES.includes(canonical)) {
            return { agentType: fallbackAgent, model: '', role: canonical };
        }
        if (!hasExplicitRole && !hasConfigForRole && isCursorExecutorContextTask(task)) {
            return { agentType: fallbackAgent, model: '', role: 'executor' };
        }
    }
    if (!hasExplicitRole && !hasConfigForRole) {
        if (fallbackAgent === 'cursor' && !CURSOR_EXECUTOR_TEAM_ROLES.includes(canonical)) {
            throw new Error(`Cursor workers are executor-style only; inferred role "${canonical}" for task "${task.subject}" must run on a native Claude/OMC reviewer agent or another supported CLI worker.`);
        }
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
    // AC-8 fallback: if primary provider's CLI binary is missing, swap to the
    // Claude fallback (same tier + same agent) pre-baked in the snapshot.
    const primaryProvider = pair.primary.provider;
    const chosen = resolvedBinaryPaths[primaryProvider] ? pair.primary : pair.fallback;
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
function shouldUseLaunchTimeCliResolution(reason) {
    return /untrusted location|relative path/i.test(reason);
}
function resolvePreflightBinaryPath(agentType) {
    // Treat a platform-unsupported headless provider (e.g. antigravity on Windows)
    // as unavailable during preflight, so role routing falls back cleanly to Claude
    // instead of recording the binary and failing mid-spawn. Throws here are caught
    // by startTeamV2's preflight loop and recorded as missingBinaryReasons.
    assertHeadlessSupported(agentType);
    try {
        return { path: resolveValidatedBinaryPath(agentType), degraded: false };
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (shouldUseLaunchTimeCliResolution(reason)) {
            return { path: getContract(agentType).binary, degraded: true, reason };
        }
        throw err;
    }
}
// ---------------------------------------------------------------------------
// Helper: check worker liveness via tmux pane
// ---------------------------------------------------------------------------
async function getWorkerPaneLiveness(paneId) {
    if (!paneId)
        return 'unknown';
    return getWorkerLiveness(paneId);
}
async function captureWorkerPane(paneId) {
    if (!paneId)
        return '';
    return captureTeamPane(paneId);
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
// ---------------------------------------------------------------------------
// V2 task instruction builder — CLI API lifecycle, NO done.json
// ---------------------------------------------------------------------------
/**
 * Build the initial task instruction for v2 workers.
 * Workers use `omc team api` CLI commands for all lifecycle transitions.
 */
function buildV2TaskInstruction(teamName, workerName, task, taskId, cliOutputContract) {
    const claimTaskCommand = formatOmcCliInvocation(`team api claim-task --input '${JSON.stringify({ team_name: teamName, task_id: taskId, worker: workerName })}' --json`, {});
    const completeTaskCommand = formatOmcCliInvocation(`team api transition-task-status --input '${JSON.stringify({ team_name: teamName, task_id: taskId, from: 'in_progress', to: 'completed', claim_token: '<claim_token>', result: 'Summary: <what changed>\\nVerification: <tests/checks run>\\nSubagent skip reason: worker protocol forbids nested subagents; completed focused probe in-session' })}' --json`);
    const failTaskCommand = formatOmcCliInvocation(`team api transition-task-status --input '${JSON.stringify({ team_name: teamName, task_id: taskId, from: 'in_progress', to: 'failed', claim_token: '<claim_token>' })}' --json`);
    return [
        `## REQUIRED: Task Lifecycle Commands`,
        `You MUST run these commands. Do NOT skip any step.`,
        ``,
        `1. Claim your task:`,
        `   ${claimTaskCommand}`,
        `   Save the claim_token from the response.`,
        `2. Do the work described below.`,
        `3. On completion (use claim_token from step 1):`,
        `   ${completeTaskCommand}`,
        `   The result field is required for completion evidence. For broad delegated tasks, include either "Subagent skip reason: <why no nested worker was needed/allowed>" or, only when explicitly allowed by the leader, "Subagent spawn evidence: <child task names/thread ids and integrated findings>".`,
        `4. On failure (use claim_token from step 1):`,
        `   ${failTaskCommand}`,
        `5. ACK/progress replies are not a stop signal. Keep executing your assigned or next feasible work until the task is actually complete or failed, then transition and exit.`,
        ``,
        `## Task Assignment`,
        `Task ID: ${taskId}`,
        `Worker: ${workerName}`,
        `Subject: ${task.subject}`,
        ``,
        task.description,
        ``,
        `REMINDER: You MUST run transition-task-status before exiting. Do NOT write done.json or edit task files directly.`,
        ...(cliOutputContract ? [cliOutputContract] : []),
    ].join('\n');
}
// ---------------------------------------------------------------------------
// V2 worker spawning — direct tmux pane creation, no v1 delegation
// ---------------------------------------------------------------------------
async function notifyStartupInbox(sessionName, paneId, message) {
    // Startup inbox triggers are only safe to type once after readiness. If the
    // pane still rejects the send (for example Claude is showing a startup
    // banner), repeated tmux send-keys calls append duplicate trigger text.
    const notified = await notifyPaneWithRetry(sessionName, paneId, message, 1);
    return notified
        ? { ok: true, transport: 'tmux_send_keys', reason: 'worker_pane_notified' }
        : { ok: false, transport: 'tmux_send_keys', reason: 'worker_notify_failed' };
}
async function notifyPaneWithRetry(sessionName, paneId, message, maxAttempts = 6, retryDelayMs = 350) {
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
function hasWorkerStatusProgress(status, taskId) {
    if (status.current_task_id === taskId)
        return true;
    return ['working', 'blocked', 'done', 'failed'].includes(status.state);
}
async function hasWorkerTaskClaimEvidence(teamName, workerName, cwd, taskId) {
    try {
        const raw = await readFile(absPath(cwd, TeamPaths.taskFile(teamName, taskId)), 'utf-8');
        const task = JSON.parse(raw);
        return task.owner === workerName && ['in_progress', 'completed', 'failed'].includes(task.status);
    }
    catch {
        return false;
    }
}
async function hasWorkerStartupEvidence(teamName, workerName, taskId, cwd) {
    const [hasClaimEvidence, status] = await Promise.all([
        hasWorkerTaskClaimEvidence(teamName, workerName, cwd, taskId),
        readWorkerStatus(teamName, workerName, cwd),
    ]);
    return hasClaimEvidence || hasWorkerStatusProgress(status, taskId);
}
async function waitForWorkerStartupEvidence(teamName, workerName, taskId, cwd, attempts = 3, delayMs = 250) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (await hasWorkerStartupEvidence(teamName, workerName, taskId, cwd)) {
            return true;
        }
        if (attempt < attempts) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    return false;
}
/**
 * Spawn a single v2 worker in a tmux pane.
 * Writes CLI API inbox (no done.json), waits for ready, sends inbox path.
 */
async function spawnV2Worker(opts) {
    // Split new pane off the last existing pane (or leader if first worker)
    const splitTarget = opts.existingWorkerPaneIds.length === 0
        ? opts.leaderPaneId
        : opts.existingWorkerPaneIds[opts.existingWorkerPaneIds.length - 1];
    const splitDirection = opts.existingWorkerPaneIds.length === 0 ? 'right' : 'down';
    const paneId = await splitTeamWorkerPane(splitTarget, splitDirection, opts.workerCwd ?? opts.cwd);
    if (!paneId) {
        return { paneId: null, startupAssigned: false, startupFailureReason: 'pane_id_missing' };
    }
    const usePromptMode = isPromptModeAgent(opts.agentType);
    // AC-7: render the CLI-worker output contract when a reviewer-style role
    // is routed to an external provider (codex/gemini/grok). Claude workers speak
    // through the team messaging API and do not use the verdict-file contract.
    const injectContract = shouldInjectContract(opts.role ?? null, opts.agentType);
    const outputFile = injectContract && opts.role
        ? cliWorkerOutputFilePath(teamStateRoot(opts.cwd, opts.teamName), opts.workerName)
        : undefined;
    const cliOutputContract = injectContract && opts.role && outputFile
        ? renderCliWorkerOutputContract(opts.role, outputFile)
        : undefined;
    // Build v2 task instruction (CLI API, NO done.json)
    const instruction = buildV2TaskInstruction(opts.teamName, opts.workerName, opts.task, opts.taskId, cliOutputContract);
    const instructionStateRoot = opts.worktreePath ? '$OMC_TEAM_STATE_ROOT' : undefined;
    const inboxTriggerMessage = generateTriggerMessage(opts.teamName, opts.workerName, instructionStateRoot);
    if (usePromptMode) {
        await composeInitialInbox(opts.teamName, opts.workerName, instruction, opts.cwd, cliOutputContract);
    }
    // Build env and launch command
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
        workerName: opts.workerName,
        envVars,
        launchBinary: launchDescriptor.binary,
        launchArgs: [...launchDescriptor.args],
        cwd: opts.workerCwd ?? opts.cwd,
    };
    await spawnWorkerInPane(opts.sessionName, paneId, paneConfig);
    // Apply layout
    await applyMainVerticalLayout(opts.sessionName);
    // For interactive agents, wait for pane readiness before dispatching startup inbox.
    if (!usePromptMode) {
        const paneReady = await waitForPaneReady(paneId);
        if (!paneReady) {
            return {
                paneId,
                startupAssigned: false,
                startupFailureReason: 'worker_pane_not_ready',
            };
        }
    }
    const dispatchOutcome = await queueInboxInstruction({
        teamName: opts.teamName,
        workerName: opts.workerName,
        workerIndex: opts.workerIndex + 1,
        paneId,
        inbox: instruction,
        triggerMessage: inboxTriggerMessage,
        cwd: opts.cwd,
        transportPreference: usePromptMode ? 'prompt_stdin' : 'transport_direct',
        fallbackAllowed: DEFAULT_TEAM_TRANSPORT_POLICY.dispatch_mode === 'hook_preferred_with_fallback',
        inboxCorrelationKey: `startup:${opts.workerName}:${opts.taskId}`,
        notify: async (_target, triggerMessage) => {
            if (usePromptMode) {
                return { ok: true, transport: 'prompt_stdin', reason: 'prompt_mode_launch_args' };
            }
            if (opts.agentType === 'gemini') {
                const confirmed = await notifyPaneWithRetry(opts.sessionName, paneId, '1');
                if (!confirmed) {
                    return { ok: false, transport: 'tmux_send_keys', reason: 'worker_notify_failed:trust-confirm' };
                }
                await new Promise(r => setTimeout(r, 800));
            }
            return notifyStartupInbox(opts.sessionName, paneId, triggerMessage);
        },
        deps: {
            writeWorkerInbox,
        },
    });
    if (!dispatchOutcome.ok) {
        return {
            paneId,
            startupAssigned: false,
            startupFailureReason: dispatchOutcome.reason,
        };
    }
    if (opts.agentType === 'claude') {
        let settled = await waitForWorkerStartupEvidence(opts.teamName, opts.workerName, opts.taskId, opts.cwd, 6);
        // Claude Code v2.1.x sometimes swallows the Enter key sent immediately
        // after a fresh pane reports ready — the TUI is still binding input
        // handlers, so the dispatch message lands in the input buffer but is
        // never submitted. By the time the evidence wait above finishes, the
        // TUI is reliably accepting input. Resubmit Enter directly (the prompt
        // is still sitting in the input buffer) and re-check evidence. Bounded
        // retries so a truly hung worker still fails fast.
        for (let attempt = 1; !settled && attempt <= 4; attempt++) {
            try {
                await sendTeamPaneKey(paneId, 'Enter');
            }
            catch {
                break;
            }
            settled = await waitForWorkerStartupEvidence(opts.teamName, opts.workerName, opts.taskId, opts.cwd, 12);
        }
        if (!settled) {
            return {
                paneId,
                startupAssigned: false,
                startupFailureReason: 'claude_startup_evidence_missing',
            };
        }
    }
    if (usePromptMode) {
        const settled = await waitForWorkerStartupEvidence(opts.teamName, opts.workerName, opts.taskId, opts.cwd);
        if (!settled) {
            return {
                paneId,
                startupAssigned: false,
                startupFailureReason: `${opts.agentType}_startup_evidence_missing`,
            };
        }
    }
    return {
        paneId,
        startupAssigned: true,
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
            request_id: input.requestId, recovery_id: recoveryId, pane_id: pending.paneId,
            pane_attempt_id: pending.paneAttemptId, reason, liveness, recorded_at: new Date(recordedAt).toISOString() }, null, 2), 'utf8');
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
    try {
        await handle.writeFile(JSON.stringify({ schema_version: 1, team_name: input.teamName, worker_name: input.workerName,
            request_id: input.requestId, recovery_id: recoveryId, pane_id: null, pane_attempt_id: paneAttemptId,
            reason, liveness: 'unknown', unaddressable: true, split, recorded_at: new Date(recordedAt).toISOString() }, null, 2), 'utf8');
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
    const { killTeamPane } = await import('./tmux-session.js');
    let liveness = 'unknown';
    for (let attempt = 0; attempt < 2; attempt++) {
        await killTeamPane(pending.paneId).catch(() => undefined);
        liveness = await getWorkerLiveness(pending.paneId).catch(() => 'unknown');
        if (liveness === 'dead') {
            pendingRecoveryPanes.delete(recoveryId);
            return true;
        }
    }
    await recordRecoveryPaneRollbackFailure(input, recoveryId, pending, reason, liveness);
    return false;
}
function buildRecoveryPaneContext(input, sagaInput, config, worker, descriptor, paneId, paneAttemptId) {
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
    return { paneId, paneAttemptId, sessionName: config.tmux_session, config, worker, agentType, gate, promptMode };
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
            });
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
        || reservation.team_name !== teamName || reservation.worker_name !== input.workerName)
        return false;
    try {
        const intent = parseRecoveryIntent(await readFile(absPath(cwd, TeamPaths.recoveryIntent(teamName, bootstrap.recoveryId)), 'utf8'));
        if (intent.request_id !== input.requestId || intent.recovery_id !== bootstrap.recoveryId
            || intent.team_name !== teamName || intent.worker_name !== input.workerName)
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
        || orphan.process_started_at !== bootstrap.predecessorProcessStartedAt)
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
        tasks = await listTasksFromFiles(teamName, cwd);
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
async function ensureRecoveryOwner(teamName, cwd, input, waitOptions) {
    let current = await readRevisionedTeamConfig(teamName, cwd);
    if (!current)
        current = await migrateTeamConfigRevision(teamName, cwd);
    if (!current)
        throw new Error('invalid_persisted_state');
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
    let owner = await ensureRecoveryOwner(input.teamName, input.cwd, input, waitOptions);
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
        const beforeOwner = await readRevisionedTeamConfig(input.teamName, input.cwd);
        if (beforeOwner?.config.active_scale_down || beforeOwner?.config.active_scale_up) {
            return recoveryError(input, recoveryId, 'team_mutation_busy');
        }
        let owner = await ensureRecoveryOwner(input.teamName, input.cwd, input);
        ownerBound = true;
        const existingAttempt = owner.config.active_recovery;
        if (existingAttempt && (existingAttempt.request_id !== input.requestId
            || existingAttempt.recovery_id !== recoveryId || existingAttempt.worker_name !== input.workerName)) {
            return recoveryError(input, recoveryId, 'team_mutation_busy');
        }
        if (!existingAttempt) {
            const nextRevision = owner.stateRevision + 1;
            const electedConfig = {
                ...owner.config,
                state_revision: nextRevision,
                active_recovery: {
                    request_id: input.requestId,
                    recovery_id: recoveryId,
                    worker_name: input.workerName,
                    owner_epoch: owner.fence.epoch,
                    owner_nonce: owner.fence.nonce,
                    phase: 'reserved',
                    state_revision: nextRevision,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                },
            };
            if (!await saveTeamConfigAtRevision(electedConfig, owner.stateRevision, input.cwd)) {
                return recoveryError(input, recoveryId, 'stale_state_revision');
            }
            owner = { ...owner, config: electedConfig, stateRevision: nextRevision };
        }
        if (owner.config.lifecycle_state === 'shutting_down' || owner.config.lifecycle_state === 'stopped') {
            return finalizeBoundRecoveryOwnerTerminal(input, recoveryId, recoveryError(input, recoveryId, 'team_shutting_down'));
        }
        if (owner.config.active_scale_down || owner.config.active_scale_up)
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
        try {
            await tmuxExecAsync(['has-session', '-t', owner.config.tmux_session.split(':')[0]]);
        }
        catch {
            return finalizeBoundRecoveryOwnerTerminal(input, recoveryId, recoveryError(input, recoveryId, 'team_session_dead'));
        }
        const replacementGeneration = existingAttempt && worker.recovery_id === recoveryId
            && typeof worker.replacement_generation === 'number'
            ? worker.replacement_generation
            : (worker.replacement_generation ?? 0) + 1;
        const attempt = await readOrCreateRecoveryAttempt(input, recoveryId, replacementGeneration);
        const originalPaneId = existingAttempt?.original_pane_id ?? worker.pane_id;
        const ensureFence = async () => {
            requireOwnerFence(input.cwd, input.teamName, owner.fence);
            const current = await readRevisionedTeamConfig(input.teamName, input.cwd);
            if (!current || current.config.active_scale_down
                || current.config.active_scale_up
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
            getLiveness: async () => {
                const config = await ensureFence();
                const currentWorker = config.workers.find(candidate => candidate.name === input.workerName);
                const committedReplacement = existingAttempt?.recovery_id === recoveryId
                    && currentWorker?.recovery_id === recoveryId
                    && currentWorker.replacement_generation === attempt.replacement_generation
                    && Boolean(currentWorker.pane_id && currentWorker.pane_attempt_id);
                if (!committedReplacement) {
                    if (!originalPaneId?.trim() || currentWorker?.pane_id !== originalPaneId)
                        return 'unknown';
                    return getWorkerPaneLiveness(originalPaneId);
                }
                committedReplacementLiveness = await getWorkerPaneLiveness(currentWorker?.pane_id);
                return committedReplacementLiveness === 'unknown' ? 'unknown' : 'dead';
            },
            listOwnedInProgressTasks: async () => selectRecoveryReplayTasks(await listTasksFromFiles(input.teamName, input.cwd), input.workerName, recoveryId, committedReplacementLiveness),
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
                const currentTask = (await listTasksFromFiles(input.teamName, input.cwd)).find(task => task.id === taskId);
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
                const committedPane = resolveCommittedRecoveryPaneAttempt(existingAttempt, sagaInput.recoveryId, sagaInput.replacementGeneration, currentWorker);
                if (committedPane) {
                    const committedPaneLiveness = await getWorkerPaneLiveness(committedPane.paneId);
                    if (committedPaneLiveness === 'unknown')
                        return { ok: false, error: 'runtime_owner_unavailable' };
                    if (committedPaneLiveness === 'alive') {
                        let pending = pendingRecoveryPanes.get(sagaInput.recoveryId);
                        if (!pending) {
                            try {
                                pending = buildRecoveryPaneContext(input, sagaInput, config, currentWorker, launchDescriptor, committedPane.paneId, committedPane.paneAttemptId);
                                pendingRecoveryPanes.set(sagaInput.recoveryId, pending);
                            }
                            catch {
                                return { ok: false, error: 'launch_descriptor_unresolvable' };
                            }
                        }
                        const expected = { recovery_id: sagaInput.recoveryId, worker_name: sagaInput.workerName,
                            replacement_generation: sagaInput.replacementGeneration, pane_attempt_id: committedPane.paneAttemptId };
                        const ready = await waitForRecoveryGateRecord(pending.gate.readyPath, expected, 1_000);
                        const manifest = await readTeamManifest(input.teamName, input.cwd);
                        const projected = manifest?.workers.find(candidate => candidate.name === sagaInput.workerName);
                        const projectedSameAttempt = projected?.pane_id === committedPane.paneId
                            && projected.pane_attempt_id === committedPane.paneAttemptId
                            && projected.recovery_id === sagaInput.recoveryId
                            && projected.replacement_generation === sagaInput.replacementGeneration;
                        if (!ready || !projectedSameAttempt)
                            return { ok: false, error: 'worker_activation_failed' };
                        return { ok: true, paneId: pending.paneId, paneAttemptId: pending.paneAttemptId, committed: true,
                            stateRevision: config.state_revision ?? 0, manifestSync: 'synced' };
                    }
                }
                const paneAttemptId = randomUUID();
                let prepared;
                try {
                    prepared = buildRecoveryPaneContext(input, sagaInput, config, currentWorker, launchDescriptor, '', paneAttemptId);
                    if (!process.argv[1])
                        throw new Error('runtime_cli_path_missing');
                }
                catch {
                    return { ok: false, error: 'launch_descriptor_unresolvable' };
                }
                const livePaneIds = [];
                for (const candidate of config.workers) {
                    if (!candidate.pane_id || candidate.name === sagaInput.workerName)
                        continue;
                    if (await getWorkerPaneLiveness(candidate.pane_id) === 'alive')
                        livePaneIds.push(candidate.pane_id);
                }
                const splitTarget = livePaneIds.at(-1) ?? config.leader_pane_id ?? '';
                if (!splitTarget)
                    return { ok: false, error: 'spawn_failed' };
                const splitDirection = livePaneIds.length > 0 ? 'down' : 'right';
                const split = await splitTeamWorkerPaneWithEvidence(splitTarget, splitDirection, prepared.gate.cwd);
                if (!split.paneId) {
                    await recordUnaddressableRecoveryPaneFailure(input, sagaInput.recoveryId, paneAttemptId, split.commandSucceeded ? 'unaddressable_spawned_pane' : 'split_command_uncertain', split);
                    return { ok: false, error: 'spawn_failed' };
                }
                const pending = { ...prepared, paneId: split.paneId };
                pendingRecoveryPanes.set(sagaInput.recoveryId, pending);
                try {
                    await spawnWorkerInPane(config.tmux_session, pending.paneId, {
                        teamName: input.teamName,
                        workerName: sagaInput.workerName,
                        envVars: { OMC_RECOVERY_GATE_SPEC: JSON.stringify(pending.gate) },
                        launchBinary: process.execPath,
                        launchArgs: [process.argv[1], '--recovery-gate'],
                        cwd: pending.gate.cwd,
                    });
                    const ready = await waitForRecoveryGateRecord(pending.gate.readyPath, {
                        recovery_id: sagaInput.recoveryId,
                        worker_name: sagaInput.workerName,
                        replacement_generation: sagaInput.replacementGeneration,
                        pane_attempt_id: paneAttemptId,
                    }, 30_000);
                    if (!ready)
                        throw new Error('startup_ack_timeout');
                    return { ok: true, paneId: pending.paneId, paneAttemptId, committed: false };
                }
                catch (error) {
                    await cleanupRecoveryPaneAttempt(input, sagaInput.recoveryId, pending, error instanceof Error ? error.message : 'spawn_failed');
                    return { ok: false, error: error instanceof Error && error.message === 'startup_ack_timeout'
                            ? 'startup_ack_timeout' : 'spawn_failed' };
                }
            },
            persistActive: async (sagaInput, paneId) => {
                await ensureFence();
                const current = await readRevisionedTeamConfig(input.teamName, input.cwd);
                if (!current)
                    throw new Error('invalid_persisted_state');
                const pending = pendingRecoveryPanes.get(sagaInput.recoveryId);
                if (!pending)
                    throw new Error('worker_activation_failed');
                const nextWorkers = current.config.workers.map(candidate => candidate.name === sagaInput.workerName
                    ? { ...candidate, pane_id: paneId, pane_attempt_id: pending.paneAttemptId, recovery_id: sagaInput.recoveryId,
                        replacement_generation: sagaInput.replacementGeneration, operational_state: 'active' }
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
                if (!await saveTeamConfigAtRevision(next, current.stateRevision, input.cwd))
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
                const record = { recovery_id: sagaInput.recoveryId, worker_name: sagaInput.workerName,
                    replacement_generation: sagaInput.replacementGeneration, pane_attempt_id: paneAttemptId, written_at: new Date().toISOString() };
                await mkdir(join(pending.gate.activatePath, '..'), { recursive: true });
                await writeFile(pending.gate.activatePath, JSON.stringify(record), 'utf8');
                const adoptedReady = await waitForRecoveryGateRecord(`${pending.gate.readyPath}.adoption-ready`, record, 30_000);
                return adoptedReady ? { ok: true } : { ok: false, error: 'worker_activation_failed' };
            },
            adoptAll: async (sagaInput, proof, taskIds) => {
                await ensureFence();
                const results = await teamAdoptRecoveryReservations(input.teamName, input.cwd, taskIds, sagaInput.workerName, proof);
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
                if (!pending || pending.paneAttemptId !== paneAttemptId)
                    throw new Error('worker_activation_failed');
                const instruction = continuations.length > 0
                    ? continuations.map(continuation => renderRecoveryContinuationInstruction({
                        teamName: input.teamName,
                        workerName: sagaInput.workerName,
                        taskId: continuation.taskId,
                        taskVersion: continuation.taskVersion,
                        claimToken: continuation.claimToken,
                        sequence: continuation.sequence,
                        resumePayload: continuation.payload,
                    })).join('\n\n')
                    : 'Recovery completed for this idle worker. Wait for a real team task assignment and do not create or claim fake work.';
                await composeInitialInbox(input.teamName, sagaInput.workerName, instruction, input.cwd);
                const record = { recovery_id: sagaInput.recoveryId, worker_name: sagaInput.workerName,
                    replacement_generation: sagaInput.replacementGeneration, pane_attempt_id: paneAttemptId, written_at: new Date().toISOString() };
                const launchedPath = `${pending.gate.runPath}.launched`;
                if (!existsSync(launchedPath)) {
                    await writeFile(pending.gate.runPath, JSON.stringify(record), 'utf8');
                    const launched = await waitForRecoveryGateRecord(launchedPath, record, 30_000);
                    if (!launched)
                        throw new Error('startup_ack_timeout');
                }
                if (!pending.promptMode) {
                    if (!await waitForPaneReady(pending.paneId))
                        throw new Error('startup_ack_timeout');
                    const outcome = await queueInboxInstruction({
                        teamName: input.teamName,
                        workerName: sagaInput.workerName,
                        workerIndex: pending.worker.index,
                        paneId: pending.paneId,
                        inbox: instruction,
                        triggerMessage: generateTriggerMessage(input.teamName, sagaInput.workerName, pending.worker.worktree_path ? '$OMC_TEAM_STATE_ROOT' : undefined),
                        cwd: input.cwd,
                        transportPreference: 'transport_direct',
                        fallbackAllowed: DEFAULT_TEAM_TRANSPORT_POLICY.dispatch_mode === 'hook_preferred_with_fallback',
                        inboxCorrelationKey: `recovery:${sagaInput.recoveryId}`,
                        notify: async (_target, triggerMessage) => notifyStartupInbox(pending.sessionName, pending.paneId, triggerMessage),
                        deps: { writeWorkerInbox },
                    });
                    if (!outcome.ok)
                        throw new Error(outcome.reason ?? 'worker_notify_failed');
                }
                pendingRecoveryPanes.delete(sagaInput.recoveryId);
            },
            killAttemptPane: async (paneAttemptId) => {
                const pending = pendingRecoveryPanes.get(recoveryId);
                if (!pending || pending.paneAttemptId !== paneAttemptId)
                    return;
                const cleaned = await cleanupRecoveryPaneAttempt(input, recoveryId, pending, 'recovery_saga_rollback');
                if (!cleaned)
                    throw new Error('worker_cleanup_incomplete');
            },
        };
        const sagaInput = {
            requestId: input.requestId,
            recoveryId,
            teamName: input.teamName,
            workerName: input.workerName,
            replacementGeneration: attempt.replacement_generation,
            adoptionToken: attempt.adoption_token,
            originalPaneId,
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
                        : 'runtime_owner_unavailable';
        const result = recoveryError(input, recoveryId, code, message);
        return ownerBound && (code === 'team_not_found' || code === 'invalid_persisted_state')
            ? await finalizeBoundRecoveryOwnerTerminal(input, recoveryId, result)
            : code === 'team_not_found' || code === 'invalid_persisted_state'
                ? persistRecoveryFinal(input, recoveryId, result)
                : result;
    }
}
async function rollbackUnpersistedNativeWorktreeStartup(teamName, cwd, cause) {
    const safety = inspectTeamWorktreeCleanupSafety(teamName, cwd);
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
    if (!safety.hasEvidence) {
        await writeFailureMarker();
        return;
    }
    try {
        const cleanup = cleanupTeamWorktrees(teamName, cwd);
        if (cleanup.preserved.length === 0) {
            await rm(teamRoot, { recursive: true, force: true });
        }
        await writeFailureMarker({ preserved: cleanup.preserved });
    }
    catch (rollbackError) {
        await writeFailureMarker({
            rollback_error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
    }
}
async function rollbackStartedNativeWorktreeStartup(args) {
    try {
        await killTeamSession(args.sessionName, args.workerPaneIds, args.leaderPaneId ?? undefined, { sessionMode: args.sessionMode });
    }
    catch (killError) {
        process.stderr.write(`[team/runtime-v2] startup rollback tmux cleanup failed: ${killError instanceof Error ? killError.message : String(killError)}
`);
    }
    await rollbackUnpersistedNativeWorktreeStartup(args.teamName, args.cwd, args.cause);
}
// ---------------------------------------------------------------------------
// startTeamV2 — direct tmux creation, CLI API inbox, NO watchdog
// ---------------------------------------------------------------------------
/**
 * Start a team with the v2 event-driven runtime.
 * Creates state directories, writes config + task files, spawns workers via
 * tmux split-panes, and writes CLI API inbox instructions. NO done.json.
 * NO watchdog polling — the leader drives monitoring via monitorTeamV2().
 */
export async function startTeamV2(config) {
    const sanitized = sanitizeTeamName(config.teamName);
    const leaderCwd = resolve(config.cwd);
    validateTeamName(sanitized);
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
    // Validate CLIs and pin absolute binary paths for user-declared agentTypes.
    // AC-8: missing/untrusted binaries fall back to the snapshot's Claude tuple at
    // spawn time; emit a loud warning naming the binary so operators can fix it.
    // Rewrite headless-unsupported direct workers (e.g. antigravity on Windows) to
    // the Claude fallback up front, BEFORE any team state or tmux session is created.
    // Direct launches like `omc team 1:antigravity` flow through `agentTypes` as the
    // round-robin fallbackAgent for resolveTaskAssignment, so without this they would
    // pass the unsupported provider through and only fail mid-spawn. (Role-routed
    // primaries are handled separately by resolvePreflightBinaryPath's guard.)
    const declaredAgentTypes = config.agentTypes;
    const agentTypes = declaredAgentTypes.map((t) => {
        if (!isHeadlessSupportedOnPlatform(t)) {
            process.stderr.write(`[team/runtime-v2] ${t} headless mode is unsupported on this platform — using claude fallback for direct workers\n`);
            return 'claude';
        }
        return t;
    });
    const resolvedBinaryPaths = {};
    const missingBinaryReasons = [];
    for (const agentType of [...new Set(agentTypes)]) {
        try {
            resolvedBinaryPaths[agentType] = resolvePreflightBinaryPath(agentType).path;
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            missingBinaryReasons.push({ agentType, reason });
        }
    }
    // Best-effort resolve extra providers referenced by the routing snapshot
    // (codex/gemini/grok/cursor critic, reviewer, etc.). Missing binaries are tolerated —
    // the spawn path falls back to the snapshot's Claude fallback (AC-8).
    for (const { primary } of Object.values(resolvedRouting)) {
        const provider = primary.provider;
        if (resolvedBinaryPaths[provider])
            continue;
        if (missingBinaryReasons.some((m) => m.agentType === provider))
            continue;
        try {
            resolvedBinaryPaths[provider] = resolvePreflightBinaryPath(provider).path;
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            missingBinaryReasons.push({ agentType: provider, reason });
        }
    }
    // AC-8: guarantee at least the Claude fallback CLI is resolvable. If every
    // declared provider is unavailable AND Claude is not resolvable either, the
    // caller gets a loud error rather than a silently-broken team.
    if (!resolvedBinaryPaths.claude) {
        try {
            resolvedBinaryPaths.claude = resolveValidatedBinaryPath('claude');
        }
        catch {
            // Keep going — startup will emit warnings below and spawnV2Worker may
            // still succeed if Claude is resolvable via PATH at exec time.
        }
    }
    // Create state directories
    await mkdir(absPath(leaderCwd, TeamPaths.tasks(sanitized)), { recursive: true });
    await mkdir(absPath(leaderCwd, TeamPaths.workers(sanitized)), { recursive: true });
    await mkdir(join(getOmcRoot(leaderCwd), 'state', 'team', sanitized, 'mailbox'), { recursive: true });
    // AC-8: emit a loud team-event warning naming every missing/untrusted CLI
    // binary so the leader surfaces the fallback decision instead of silently
    // swapping providers.
    const missingBinaryLogFailure = createSwallowedErrorLogger('team.runtime-v2.startTeamV2 cli_binary_missing event failed');
    for (const { agentType, reason } of missingBinaryReasons) {
        process.stderr.write(`[team/runtime-v2] cli_binary_missing:${agentType}: ${reason} — falling back to claude snapshot (AC-8)\n`);
        await appendTeamEvent(sanitized, {
            type: 'team_leader_nudge',
            worker: 'leader-fixed',
            reason: `cli_binary_missing:${agentType}:${reason}`,
        }, leaderCwd).catch(missingBinaryLogFailure);
    }
    // Write task files
    for (let i = 0; i < config.tasks.length; i++) {
        const taskId = String(i + 1);
        const taskFilePath = absPath(leaderCwd, TeamPaths.taskFile(sanitized, taskId));
        await mkdir(join(taskFilePath, '..'), { recursive: true });
        await writeFile(taskFilePath, JSON.stringify({
            id: taskId,
            subject: config.tasks[i].subject,
            description: config.tasks[i].description,
            status: 'pending',
            owner: null,
            result: null,
            ...(config.tasks[i].role ? { role: config.tasks[i].role } : {}),
            ...(config.tasks[i].delegation ? { delegation: config.tasks[i].delegation } : {}),
            created_at: new Date().toISOString(),
        }, null, 2), 'utf-8');
    }
    // Build allocation inputs for the new role-aware allocator
    const workerNames = Array.from({ length: config.workerCount }, (_, index) => `worker-${index + 1}`);
    const workerWorktrees = new Map();
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
        await rollbackUnpersistedNativeWorktreeStartup(sanitized, leaderCwd, error);
        throw error;
    }
    const workerNameSet = new Set(workerNames);
    // Respect explicit owner fields first, then allocate remaining tasks
    const startupAllocations = [];
    const unownedTaskIndices = [];
    for (let i = 0; i < config.tasks.length; i++) {
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
    const startupByWorker = new Map(startupAllocations.map(item => [item.workerName, item.taskIndex]));
    const preparedLaunches = new Map();
    const resolveDefaultModel = (agentType) => {
        if (agentType === 'codex')
            return process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL || process.env.OMC_CODEX_DEFAULT_MODEL || undefined;
        if (agentType === 'gemini')
            return process.env.OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL || process.env.OMC_GEMINI_DEFAULT_MODEL || undefined;
        if (agentType === 'antigravity')
            return process.env.OMC_EXTERNAL_MODELS_DEFAULT_ANTIGRAVITY_MODEL || process.env.OMC_ANTIGRAVITY_DEFAULT_MODEL || undefined;
        if (agentType === 'grok')
            return process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL || process.env.OMC_GROK_DEFAULT_MODEL || undefined;
        if (agentType === 'cursor')
            return undefined;
        return resolveClaudeWorkerModel();
    };
    for (let i = 0; i < workerNames.length; i++) {
        const workerName = workerNames[i];
        const taskIndex = startupByWorker.get(workerName);
        const fallbackAgent = (agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? 'claude');
        const assignment = taskIndex === undefined
            ? { agentType: fallbackAgent, model: resolveDefaultModel(fallbackAgent), role: undefined }
            : resolveTaskAssignment(config.tasks[taskIndex], resolvedRouting, pluginCfg.team?.roleRouting, resolvedBinaryPaths, fallbackAgent);
        const effectiveModel = assignment.model || resolveDefaultModel(assignment.agentType);
        const worktree = workerWorktrees.get(workerName);
        const outputFile = taskIndex !== undefined && assignment.role && shouldInjectContract(assignment.role, assignment.agentType)
            ? cliWorkerOutputFilePath(teamStateRoot(leaderCwd, sanitized), workerName) : undefined;
        const outputContract = outputFile && assignment.role ? renderCliWorkerOutputContract(assignment.role, outputFile) : undefined;
        const promptArgs = taskIndex !== undefined && isPromptModeAgent(assignment.agentType)
            ? getPromptModeArgs(assignment.agentType, generatePromptModeStartupPrompt(sanitized, workerName, worktree ? '$OMC_TEAM_STATE_ROOT' : undefined, outputContract)) : [];
        const binary = resolvedBinaryPaths[assignment.agentType];
        if (!binary)
            throw new Error(`No validated binary available for ${assignment.agentType}`);
        const descriptor = buildValidatedWorkerLaunchDescriptor(assignment.agentType, {
            teamName: sanitized, workerName, cwd: worktree?.path ?? leaderCwd, resolvedBinaryPath: binary,
            model: effectiveModel,
        }, promptArgs);
        preparedLaunches.set(workerName, { agentType: assignment.agentType,
            ...(assignment.role ? { role: assignment.role } : {}), descriptor });
    }
    // Set up worker state dirs and overlays (with v2 CLI API instructions)
    try {
        for (let i = 0; i < workerNames.length; i++) {
            const wName = workerNames[i];
            const agentType = (agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? 'claude');
            await ensureWorkerStateDir(sanitized, wName, leaderCwd);
            const overlayPath = await writeWorkerOverlay({
                teamName: sanitized, workerName: wName, agentType,
                tasks: config.tasks.map((t, idx) => ({
                    id: String(idx + 1), subject: t.subject, description: t.description,
                })),
                cwd: leaderCwd,
                ...(config.rolePrompt ? { bootstrapInstructions: config.rolePrompt } : {}),
                ...(workerWorktrees.has(wName) ? { instructionStateRoot: '$OMC_TEAM_STATE_ROOT' } : {}),
            });
            const worktree = workerWorktrees.get(wName);
            if (worktree) {
                const overlayContent = await readFile(overlayPath, 'utf-8');
                installWorktreeRootAgents(sanitized, wName, leaderCwd, worktree.path, overlayContent);
            }
        }
    }
    catch (error) {
        await rollbackUnpersistedNativeWorktreeStartup(sanitized, leaderCwd, error);
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
        await rollbackUnpersistedNativeWorktreeStartup(sanitized, leaderCwd, error);
        throw error;
    }
    const sessionName = session.sessionName;
    const leaderPaneId = session.leaderPaneId;
    const ownsWindow = session.sessionMode !== 'split-pane';
    const workerPaneIds = [];
    // Build workers info for config
    const workersInfo = workerNames.map((wName, i) => {
        const worktree = workerWorktrees.get(wName);
        return {
            name: wName,
            index: i + 1,
            role: config.workerRoles?.[i]
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
        state_revision: 0,
        task: config.tasks.map(t => t.subject).join('; '),
        agent_type: agentTypes[0] || 'claude',
        worker_launch_mode: 'interactive',
        policy: DEFAULT_TEAM_TRANSPORT_POLICY,
        governance: DEFAULT_TEAM_GOVERNANCE,
        worker_count: config.workerCount,
        max_workers: 20,
        workers: workersInfo,
        created_at: new Date().toISOString(),
        tmux_session: sessionName,
        tmux_window_owned: ownsWindow,
        next_task_id: config.tasks.length + 1,
        leader_cwd: leaderCwd,
        team_state_root: teamStateRoot(leaderCwd, sanitized),
        leader_pane_id: leaderPaneId,
        hud_pane_id: null,
        resize_hook_name: null,
        resize_hook_target: null,
        resolved_routing: resolvedRouting,
        workspace_mode: workspaceMode,
        worktree_mode: worktreeMode,
        service_descriptor: config.autoMerge
            ? { schema_version: 1, service_generation: 1, service_attempt_id: randomUUID(), auto_merge_enabled: true,
                workspace_root: leaderCwd, leader_branch: autoMergeLeaderBranch, cadence_policy: 'worker-auto-commit-v1' }
            : { schema_version: 1, service_generation: 1, service_attempt_id: randomUUID(), auto_merge_enabled: false,
                workspace_root: leaderCwd, cadence_policy: 'disabled' },
    };
    try {
        await saveTeamConfig(teamConfig, leaderCwd, teamConfig.state_revision);
    }
    catch (error) {
        await rollbackStartedNativeWorktreeStartup({
            teamName: sanitized,
            cwd: leaderCwd,
            cause: error,
            sessionName,
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
        task: teamConfig.task,
        leader: {
            session_id: sessionName,
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
        service_descriptor: teamConfig.service_descriptor,
    };
    try {
        await writeFile(absPath(leaderCwd, TeamPaths.manifest(sanitized)), JSON.stringify(teamManifest, null, 2), 'utf-8');
    }
    catch (error) {
        await rollbackStartedNativeWorktreeStartup({
            teamName: sanitized,
            cwd: leaderCwd,
            cause: error,
            sessionName,
            leaderPaneId,
            workerPaneIds,
            sessionMode: session.sessionMode,
        });
        throw error;
    }
    // Spawn workers for initial tasks (at most one startup task per worker)
    const initialStartupAllocations = [];
    const seenStartupWorkers = new Set();
    for (const decision of startupAllocations) {
        if (seenStartupWorkers.has(decision.workerName))
            continue;
        initialStartupAllocations.push(decision);
        seenStartupWorkers.add(decision.workerName);
        if (initialStartupAllocations.length >= config.workerCount)
            break;
    }
    try {
        for (const decision of initialStartupAllocations) {
            const wName = decision.workerName;
            const workerIndex = Number.parseInt(wName.replace('worker-', ''), 10) - 1;
            const taskId = String(decision.taskIndex + 1);
            const task = config.tasks[decision.taskIndex];
            if (!task || workerIndex < 0)
                continue;
            const prepared = preparedLaunches.get(wName);
            if (!prepared)
                continue;
            const workerLaunch = await spawnV2Worker({
                sessionName,
                leaderPaneId,
                existingWorkerPaneIds: workerPaneIds,
                teamName: sanitized,
                workerName: wName,
                workerIndex,
                agentType: prepared.agentType,
                launchDescriptor: prepared.descriptor,
                task,
                taskId,
                cwd: leaderCwd,
                workerCwd: workersInfo[workerIndex]?.working_dir ?? leaderCwd,
                worktreePath: workersInfo[workerIndex]?.worktree_path,
                autoMerge: Boolean(config.autoMerge),
                ...(prepared.role ? { role: prepared.role } : {}),
            });
            if (workerLaunch.paneId) {
                workerPaneIds.push(workerLaunch.paneId);
                const workerInfo = workersInfo[workerIndex];
                if (workerInfo) {
                    workerInfo.pane_id = workerLaunch.paneId;
                    workerInfo.assigned_tasks = workerLaunch.startupAssigned ? [taskId] : [];
                    workerInfo.worker_cli = prepared.agentType;
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
        await rollbackStartedNativeWorktreeStartup({
            teamName: sanitized,
            cwd: leaderCwd,
            cause: error,
            sessionName,
            leaderPaneId,
            workerPaneIds,
            sessionMode: session.sessionMode,
        });
        throw error;
    }
    // Persist config with pane IDs
    teamConfig.workers = workersInfo;
    try {
        await saveTeamConfig(teamConfig, leaderCwd, teamConfig.state_revision);
    }
    catch (error) {
        await rollbackStartedNativeWorktreeStartup({
            teamName: sanitized,
            cwd: leaderCwd,
            cause: error,
            sessionName,
            leaderPaneId,
            workerPaneIds,
            sessionMode: session.sessionMode,
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
            await appendToLeaderInbox(sanitized, extendLeaderBootstrapPrompt(sanitized), leaderCwd);
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
            await rollbackStartedNativeWorktreeStartup({
                teamName: sanitized,
                cwd: leaderCwd,
                cause: orchErr,
                sessionName,
                leaderPaneId,
                workerPaneIds,
                sessionMode: session.sessionMode,
            });
            const reason = orchErr instanceof Error ? orchErr.message : String(orchErr);
            throw new Error(`auto-merge startup failed: ${reason}`);
        }
    }
    return {
        teamName: sanitized,
        sanitizedName: sanitized,
        sessionName,
        config: teamConfig,
        cwd: leaderCwd,
        ownsWindow: ownsWindow,
    };
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
/**
 * Post-exit handler for CLI workers that emitted a structured verdict
 * (AC-7). Scans workers whose panes have exited and whose WorkerInfo
 * carries `output_file`. For each:
 *   - Reads + validates the JSON payload via `parseCliWorkerVerdict`.
 *   - Locates the worker's in_progress task and writes a terminal status
 *     (completed for `approve`, failed for `revise`/`reject`) plus verdict
 *     metadata directly to the task file — the worker process is gone and
 *     cannot re-enter `transitionTaskStatus` with its claim token.
 *   - Renames `verdict.json` to `verdict.processed.json` so a subsequent
 *     monitor cycle does not reprocess it.
 *   - Emits a team event describing the outcome.
 * On parse failure, emits a warning event and leaves the task untouched
 * for human review (per plan AC-7).
 */
export async function processCliWorkerVerdicts(teamName, cwd) {
    const sanitized = sanitizeTeamName(teamName);
    const config = await readTeamConfig(sanitized, cwd);
    if (!config)
        return [];
    const results = [];
    const logEventFailure = createSwallowedErrorLogger('team.runtime-v2.processCliWorkerVerdicts appendTeamEvent failed');
    const { rename } = await import('fs/promises');
    const { readFileSync, writeFileSync, existsSync: fsExistsSync } = await import('fs');
    const { withFileLockSync } = await import('../lib/file-lock.js');
    for (const worker of config.workers) {
        const outputFile = worker.output_file;
        if (!outputFile)
            continue;
        const liveness = await getWorkerPaneLiveness(worker.pane_id);
        if (liveness !== 'dead')
            continue;
        if (!fsExistsSync(outputFile)) {
            results.push({ workerName: worker.name, taskId: null, status: 'file_missing' });
            continue;
        }
        let payload;
        try {
            const raw = await readFile(outputFile, 'utf-8');
            payload = parseCliWorkerVerdict(raw);
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            await appendTeamEvent(sanitized, {
                type: 'team_leader_nudge',
                worker: 'leader-fixed',
                reason: `cli_worker_verdict_parse_failed:${worker.name}:${reason}`,
            }, cwd).catch(logEventFailure);
            results.push({ workerName: worker.name, taskId: null, status: 'parse_failed', reason });
            continue;
        }
        const candidateTaskIds = new Set();
        if (payload.task_id)
            candidateTaskIds.add(payload.task_id);
        for (const id of worker.assigned_tasks ?? [])
            candidateTaskIds.add(id);
        let targetTaskId = null;
        let targetTaskPath = null;
        for (const taskId of candidateTaskIds) {
            const taskPath = absPath(cwd, TeamPaths.taskFile(sanitized, taskId));
            if (!fsExistsSync(taskPath))
                continue;
            try {
                const taskRaw = readFileSync(taskPath, 'utf-8');
                const taskData = JSON.parse(taskRaw);
                if (taskData.owner === worker.name && taskData.status === 'in_progress') {
                    targetTaskId = taskId;
                    targetTaskPath = taskPath;
                    break;
                }
            }
            catch {
                // skip malformed task file
            }
        }
        if (!targetTaskId || !targetTaskPath) {
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
        let transitionOk = false;
        try {
            withFileLockSync(targetTaskPath + '.lock', () => {
                const raw = readFileSync(targetTaskPath, 'utf-8');
                const taskData = JSON.parse(raw);
                if (taskData.status !== 'in_progress' || taskData.owner !== worker.name) {
                    return;
                }
                const prevMetadata = (taskData.metadata && typeof taskData.metadata === 'object')
                    ? taskData.metadata
                    : {};
                taskData.status = terminalStatus;
                taskData.completed_at = new Date().toISOString();
                taskData.claim = undefined;
                taskData.metadata = {
                    ...prevMetadata,
                    verdict: payload.verdict,
                    verdict_summary: payload.summary,
                    verdict_findings: payload.findings,
                    verdict_role: payload.role,
                    verdict_source: 'cli_worker_output_contract',
                };
                if (terminalStatus === 'failed') {
                    taskData.error = `cli_worker_verdict:${payload.verdict}:${payload.summary}`;
                }
                writeFileSync(targetTaskPath, JSON.stringify(taskData, null, 2), 'utf-8');
                transitionOk = true;
            });
        }
        catch {
            // lock or filesystem failure — leave task in_progress, do not rename verdict file
        }
        if (!transitionOk) {
            results.push({
                workerName: worker.name,
                taskId: targetTaskId,
                status: 'already_terminal',
                verdict: payload.verdict,
            });
            continue;
        }
        await appendTeamEvent(sanitized, {
            type: terminalStatus === 'completed' ? 'task_completed' : 'task_failed',
            worker: worker.name,
            task_id: targetTaskId,
            reason: `cli_worker_verdict:${payload.verdict}`,
        }, cwd).catch(logEventFailure);
        try {
            await rename(outputFile, outputFile + '.processed');
        }
        catch {
            // best-effort; reprocess is idempotent (already_terminal on rerun)
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
export async function monitorTeamV2(teamName, cwd) {
    const monitorStartMs = performance.now();
    const sanitized = sanitizeTeamName(teamName);
    const config = await readTeamConfig(sanitized, cwd);
    if (!config)
        return null;
    // AC-7: Convert CLI-worker verdict files into task transitions before counting.
    // Runs best-effort so monitor cycles never fail because of verdict handling.
    try {
        await processCliWorkerVerdicts(sanitized, cwd);
    }
    catch (err) {
        process.stderr.write(`[team/runtime-v2] processCliWorkerVerdicts failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    const previousSnapshot = await readMonitorSnapshot(sanitized, cwd);
    // Load all tasks
    const listTasksStartMs = performance.now();
    const allTasks = await listTasksFromFiles(sanitized, cwd);
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
        const liveness = await getWorkerPaneLiveness(worker.pane_id);
        const alive = liveness === 'alive';
        const [status, heartbeat, paneCapture] = await Promise.all([
            readWorkerStatus(sanitized, worker.name, cwd),
            readWorkerHeartbeat(sanitized, worker.name, cwd),
            alive ? captureWorkerPane(worker.pane_id) : Promise.resolve(''),
        ]);
        return { worker, alive, liveness, status, heartbeat, paneCapture };
    }));
    const workerScanMs = performance.now() - workerScanStartMs;
    for (const { worker: w, alive, liveness, status, heartbeat, paneCapture } of workerSignals) {
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
        if (liveness === 'dead') {
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
    // Emit monitor-derived events (task completions, worker state changes)
    await emitMonitorDerivedEvents(sanitized, allTasks, workers.map((w) => ({ name: w.name, alive: w.alive, liveness: w.liveness, status: w.status })), previousSnapshot, cwd);
    // Persist snapshot for next cycle
    const updatedAt = new Date().toISOString();
    const totalMs = performance.now() - monitorStartMs;
    await writeMonitorSnapshot(sanitized, {
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
    const workspaceHash = createHash('sha256').update(cwd).digest('hex');
    const lifecycleLock = absPath(cwd, TeamPaths.recoveryLifecycleLock(workspaceHash, sanitized));
    const assertShutdownGate = async (currentConfig) => {
        if (force)
            return;
        const allTasks = await listTasksFromFiles(sanitized, cwd);
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
    let config = await withProcessIdentityFileLock(lifecycleLock, async () => {
        const current = await migrateTeamConfigRevision(sanitized, cwd);
        if (!current)
            return null;
        if (current.config.active_recovery)
            throw new Error(`shutdown_blocked:active_recovery:${current.config.active_recovery.recovery_id}`);
        if (current.config.active_scale_down)
            throw new Error(`shutdown_blocked:active_scale_down:${current.config.active_scale_down.operation_id}`);
        if (current.config.active_scale_up) {
            throw new Error(`shutdown_blocked:active_scale_up:${current.config.active_scale_up.operation_id}`);
        }
        if (current.config.lifecycle_state === 'stopped' || current.config.lifecycle_state === 'shutting_down')
            return current.config;
        await assertShutdownGate(current.config);
        const processStartedAt = currentProcessStartIdentity();
        if (!processStartedAt)
            throw new Error('process_start_identity_unavailable');
        ownedShutdownNonce = randomUUID();
        const nextRevision = current.stateRevision + 1;
        const next = { ...current.config, lifecycle_state: 'shutting_down', state_revision: nextRevision,
            shutdown_attempt: { nonce: ownedShutdownNonce, pid: process.pid, process_started_at: processStartedAt,
                state_revision: nextRevision, created_at: new Date().toISOString() } };
        if (!await saveTeamConfigAtRevision(next, current.stateRevision, cwd))
            throw new Error('stale_state_revision');
        return next;
    });
    const revalidateShutdownFence = async () => withProcessIdentityFileLock(lifecycleLock, async () => {
        const current = await readRevisionedTeamConfig(sanitized, cwd);
        if (!current || !['shutting_down', 'stopped'].includes(current.config.lifecycle_state ?? '') || current.config.active_recovery
            || current.config.active_scale_up) {
            throw new Error(current?.config.active_recovery
                ? `shutdown_blocked:active_recovery:${current.config.active_recovery.recovery_id}` : 'shutdown_fence_lost');
        }
        return current.config;
    });
    const commitStoppedFence = async () => withProcessIdentityFileLock(lifecycleLock, async () => {
        const current = await readRevisionedTeamConfig(sanitized, cwd);
        if (!current || !['shutting_down', 'stopped'].includes(current.config.lifecycle_state ?? '') || current.config.active_recovery
            || current.config.active_scale_up) {
            throw new Error(current?.config.active_recovery
                ? `shutdown_blocked:active_recovery:${current.config.active_recovery.recovery_id}` : 'shutdown_fence_lost');
        }
        if (current.config.lifecycle_state === 'stopped')
            return;
        const stopped = { ...current.config, lifecycle_state: 'stopped', shutdown_attempt: undefined,
            state_revision: current.stateRevision + 1 };
        if (!await saveTeamConfigAtRevision(stopped, current.stateRevision, cwd))
            throw new Error('stale_state_revision');
    });
    const rollbackRejectedShutdownFence = async (expected) => withProcessIdentityFileLock(lifecycleLock, async () => {
        const current = await readRevisionedTeamConfig(sanitized, cwd);
        if (!ownedShutdownNonce || !current || current.config.lifecycle_state !== 'shutting_down' || current.config.active_recovery
            || current.config.active_scale_up
            || current.stateRevision !== expected.state_revision || current.config.shutdown_attempt?.nonce !== ownedShutdownNonce)
            return false;
        const active = { ...current.config, lifecycle_state: 'active', shutdown_attempt: undefined,
            state_revision: current.stateRevision + 1 };
        return saveTeamConfigAtRevision(active, current.stateRevision, cwd);
    });
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
        // No config means worker liveness cannot be proven. Worktree metadata and
        // root AGENTS backups live under the scoped state tree, so use non-mutating
        // inspection and preserve state whenever any worktree recovery evidence exists.
        const cleanupSafety = inspectTeamWorktreeCleanupSafety(sanitized, cwd);
        if (cleanupSafety.hasEvidence) {
            process.stderr.write('[team/runtime-v2] preserving team state because config is missing and worktree cleanup evidence remains\n');
            return;
        }
        await cleanupTeamState(sanitized, cwd);
        return;
    }
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
            const shutdownAckPath = w.worktree_path
                ? `$OMC_TEAM_STATE_ROOT/workers/${w.name}/shutdown-ack.json`
                : TeamPaths.shutdownAck(sanitized, w.name);
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
    try {
        const { killWorkerPanes, killTeamSession, resolveSplitPaneWorkerPaneIds, getWorkerLiveness } = await import('./tmux-session.js');
        const ownsWindow = config.tmux_window_owned === true;
        const workerPaneIds = ownsWindow
            ? recordedWorkerPaneIds
            : await resolveSplitPaneWorkerPaneIds(config.tmux_session, recordedWorkerPaneIds, config.leader_pane_id ?? undefined);
        await killWorkerPanes({
            paneIds: workerPaneIds,
            leaderPaneId: config.leader_pane_id ?? undefined,
            teamName: sanitized,
            cwd,
        });
        if (config.tmux_session && (ownsWindow || !config.tmux_session.includes(':'))) {
            const sessionMode = ownsWindow
                ? (config.tmux_session.includes(':') ? 'dedicated-window' : 'detached-session')
                : 'detached-session';
            await killTeamSession(config.tmux_session, workerPaneIds, config.leader_pane_id ?? undefined, { sessionMode });
        }
        const paneById = new Map(config.workers
            .filter((w) => typeof w.pane_id === 'string' && w.pane_id.trim().length > 0)
            .map((w) => [w.pane_id, w.name]));
        const liveness = await Promise.all(workerPaneIds.map(async (paneId) => [paneId, await getWorkerLiveness(paneId)]));
        const aliveWorkers = liveness
            .filter(([, state]) => state === 'alive')
            .map(([paneId]) => paneById.get(paneId) ?? paneId);
        if (aliveWorkers.length > 0) {
            process.stderr.write(`[team/runtime-v2] preserving worktrees/state because worker pane(s) are still alive: ${aliveWorkers.join(', ')}
`);
            await finalizeAutoMerge();
            return;
        }
        const unknownWorkers = liveness
            .filter(([, state]) => state === 'unknown')
            .map(([paneId]) => paneById.get(paneId) ?? paneId);
        if (unknownWorkers.length > 0) {
            process.stderr.write(`[team/runtime-v2] preserving worktrees/state because worker pane liveness is unknown: ${unknownWorkers.join(', ')}
`);
            await finalizeAutoMerge();
            return;
        }
    }
    catch (err) {
        process.stderr.write(`[team/runtime-v2] tmux cleanup: ${err}\n`);
        if (recordedWorkerPaneIds.length > 0) {
            process.stderr.write('[team/runtime-v2] preserving worktrees/state because tmux cleanup did not prove worker panes exited\n');
            await finalizeAutoMerge();
            return;
        }
    }
    // 5. Ralph completion logging
    if (ralph) {
        const finalTasks = await listTasksFromFiles(sanitized, cwd).catch(() => []);
        const completed = finalTasks.filter((t) => t.status === 'completed').length;
        const failed = finalTasks.filter((t) => t.status === 'failed').length;
        const pending = finalTasks.filter((t) => t.status === 'pending').length;
        await appendTeamEvent(sanitized, {
            type: 'team_leader_nudge',
            worker: 'leader-fixed',
            reason: `ralph_cleanup_summary: total=${finalTasks.length} completed=${completed} failed=${failed} pending=${pending} force=${force}`,
        }, cwd).catch(logEventFailure);
    }
    // 6a. Drain the merge orchestrator (if attached). Final merge sweep before
    // cleanupTeamWorktrees touches per-worker worktrees. Also used by preserve-state
    // exits above so auto-merge shutdown is not skipped when pane liveness is unknown.
    await finalizeAutoMerge();
    await commitStoppedFence();
    // 6. Clean up state. If worktree cleanup preserved dirty worktrees, keep the
    // team state directory too; it contains the metadata and root AGENTS.md backups
    // needed for a later safe cleanup attempt.
    let preservedWorktrees = 0;
    try {
        const worktreeCleanup = cleanupTeamWorktrees(sanitized, cwd);
        preservedWorktrees = worktreeCleanup.preserved.length;
    }
    catch (err) {
        preservedWorktrees = 1;
        process.stderr.write(`[team/runtime-v2] worktree cleanup: ${err}\n`);
    }
    if (preservedWorktrees === 0) {
        await cleanupTeamState(sanitized, cwd);
    }
    else {
        process.stderr.write(`[team/runtime-v2] preserved ${preservedWorktrees} worktree(s); keeping team state for follow-up cleanup\n`);
    }
}
// ---------------------------------------------------------------------------
// resumeTeam — reconstruct runtime from persisted state
// ---------------------------------------------------------------------------
export async function resumeTeamV2(teamName, cwd) {
    const sanitized = sanitizeTeamName(teamName);
    const config = await readTeamConfig(sanitized, cwd);
    if (!config)
        return null;
    // Verify tmux session is alive
    try {
        const sessionName = config.tmux_session || `omc-team-${sanitized}`;
        await tmuxExecAsync(['has-session', '-t', sessionName.split(':')[0]]);
        return {
            teamName: sanitized,
            sanitizedName: sanitized,
            sessionName,
            ownsWindow: config.tmux_window_owned === true,
            config,
            cwd,
        };
    }
    catch {
        return null; // Session not alive
    }
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