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
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { performance } from 'perf_hooks';
import { TeamPaths, absPath, teamStateRoot } from './state-paths.js';
import { allocateTasksToWorkers } from './allocation-policy.js';
import { readTeamConfig, readWorkerStatus, readWorkerHeartbeat, readMonitorSnapshot, writeMonitorSnapshot, writeShutdownRequest, readShutdownAck, writeWorkerInbox, listTasksFromFiles, saveTeamConfig, cleanupTeamState, } from './monitor.js';
import { appendTeamEvent, emitMonitorDerivedEvents } from './events.js';
import { DEFAULT_TEAM_GOVERNANCE, DEFAULT_TEAM_TRANSPORT_POLICY, getConfigGovernance, } from './governance.js';
import { inferPhase } from './phase-controller.js';
import { validateTeamName } from './team-name.js';
import { buildWorkerArgv, getContract, resolveValidatedBinaryPath, getWorkerEnv as getModelWorkerEnv, isPromptModeAgent, getPromptModeArgs, resolveAgentReasoningEffort, resolveClaudeWorkerModel, resolveWorkerLaunchExtraFlags, } from './model-contract.js';
import { createTeamSession, spawnWorkerInPane, sendToWorker, killTeamSession, waitForPaneReady, paneHasActiveTask, paneLooksReady, applyMainVerticalLayout, getWorkerLiveness, } from './tmux-session.js';
import { composeInitialInbox, ensureWorkerStateDir, writeWorkerOverlay, generateTriggerMessage, generatePromptModeStartupPrompt, } from './worker-bootstrap.js';
import { queueInboxInstruction } from './mcp-comm.js';
import { cleanupTeamWorktrees, inspectTeamWorktreeCleanupSafety, ensureWorkerWorktree, installWorktreeRootAgents, normalizeTeamWorktreeMode, } from './git-worktree.js';
import { formatOmcCliInvocation } from '../utils/omc-cli-rendering.js';
import { createSwallowedErrorLogger } from '../lib/swallowed-error.js';
import { CANONICAL_TEAM_ROLES } from '../shared/types.js';
import { loadConfig } from '../config/loader.js';
import { buildResolvedRoutingSnapshot, getRoleRoutingSpec } from './stage-router.js';
import { routeTaskToRole } from './role-router.js';
import { normalizeDelegationRole } from '../features/delegation-routing/types.js';
import { cliWorkerOutputFilePath, parseCliWorkerVerdict, renderCliWorkerOutputContract, shouldInjectContract, } from './cli-worker-contract.js';
import { startMergeOrchestrator, recoverFromRestart, } from './merge-orchestrator.js';
import { ensureLeaderInbox, extendLeaderBootstrapPrompt, appendToLeaderInbox } from './leader-inbox.js';
import { execFileSync } from 'node:child_process';
import { isRuntimeV2Enabled } from './runtime-flags.js';
import { installCommitCadence, startFallbackPoller, uninstallCommitCadence, } from './worker-commit-cadence.js';
// ---------------------------------------------------------------------------
// In-process orchestrator registry (per-team handle for the lifetime of the
// runtime-cli process). Lives at module scope so shutdownTeamV2 can find it.
// ---------------------------------------------------------------------------
const orchestratorByTeam = new Map();
const cadenceByTeam = new Map();
function registerTeamOrchestrator(teamName, handle) {
    orchestratorByTeam.set(teamName, handle);
}
function getTeamOrchestrator(teamName) {
    return orchestratorByTeam.get(teamName);
}
function unregisterTeamOrchestrator(teamName) {
    orchestratorByTeam.delete(teamName);
}
function registerTeamCadence(teamName, context, poller) {
    const entry = cadenceByTeam.get(teamName) ?? { pollers: [], contexts: [] };
    entry.contexts.push(context);
    if (poller)
        entry.pollers.push(poller);
    cadenceByTeam.set(teamName, entry);
}
async function stopTeamCadence(teamName) {
    const entry = cadenceByTeam.get(teamName);
    if (!entry)
        return;
    cadenceByTeam.delete(teamName);
    for (const poller of entry.pollers) {
        try {
            poller.stop();
        }
        catch { /* best-effort cleanup */ }
    }
    for (const context of entry.contexts) {
        try {
            await uninstallCommitCadence(context);
        }
        catch { /* best-effort cleanup */ }
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
function resolveTaskAssignment(task, resolvedRouting, roleRoutingConfig, resolvedBinaryPaths, fallbackAgent) {
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
function isCliAgentType(value) {
    return value === 'claude' || value === 'codex' || value === 'gemini' || value === 'cursor';
}
function normalizeCanonicalWorkerRole(role) {
    if (!role)
        return null;
    const knownAgentRoleAliases = {
        codeReviewer: 'code-reviewer',
        securityReviewer: 'security-reviewer',
        testEngineer: 'test-engineer',
        codeSimplifier: 'code-simplifier',
        documentSpecialist: 'document-specialist',
    };
    const normalized = knownAgentRoleAliases[role] ?? normalizeDelegationRole(role);
    return CANONICAL_TEAM_ROLES.includes(normalized)
        ? normalized
        : null;
}
function getWorkerOverride(overrides, workerName, workerIndex) {
    if (!overrides)
        return undefined;
    return overrides[workerName] ?? overrides[String(workerIndex + 1)];
}
function applyWorkerOverride(base, override, resolvedRouting, resolvedBinaryPaths) {
    if (!override)
        return { ...base, extraFlags: [] };
    const overrideRole = normalizeCanonicalWorkerRole(override.role ?? override.agent);
    const routedPair = overrideRole ? resolvedRouting[overrideRole] : undefined;
    let next = { ...base, ...(overrideRole ? { role: overrideRole } : {}) };
    if (override.provider) {
        if (!isCliAgentType(override.provider)) {
            throw new Error(`Unsupported team.workerOverrides provider: ${override.provider}`);
        }
        next = { ...next, agentType: override.provider };
    }
    else if (routedPair) {
        const primaryProvider = routedPair.primary.provider;
        const chosen = isCliAgentType(primaryProvider) && resolvedBinaryPaths[primaryProvider]
            ? routedPair.primary
            : routedPair.fallback;
        if (isCliAgentType(chosen.provider)) {
            next = { ...next, agentType: chosen.provider, model: chosen.model };
        }
    }
    if (override.model && override.model.trim().length > 0) {
        next = { ...next, model: override.model.trim() };
    }
    const extraFlags = Array.isArray(override.extraFlags)
        ? override.extraFlags.filter((flag) => typeof flag === 'string' && flag.trim().length > 0)
        : [];
    const reasoning = override.reasoning;
    return {
        ...next,
        extraFlags,
        ...(reasoning ? { reasoning } : {}),
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
        return 'dead';
    return getWorkerLiveness(paneId);
}
async function captureWorkerPane(paneId) {
    if (!paneId)
        return '';
    try {
        const result = await tmuxExecAsync(['capture-pane', '-t', paneId, '-p', '-S', '-80']);
        return result.stdout ?? '';
    }
    catch {
        return '';
    }
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
async function reclaimExpiredInProgressTasks(teamName, cwd, tasks) {
    const now = Date.now();
    const recommendations = [];
    const updatedTasks = [];
    for (const task of tasks) {
        const leaseUntil = task.claim?.leased_until;
        if (task.status !== 'in_progress' || !leaseUntil || Number.isNaN(Date.parse(leaseUntil)) || Date.parse(leaseUntil) > now) {
            updatedTasks.push(task);
            continue;
        }
        const reopened = {
            ...task,
            status: 'pending',
            owner: undefined,
            claim: undefined,
            version: (task.version ?? 1) + 1,
        };
        await writeFile(absPath(cwd, TeamPaths.taskFile(teamName, task.id)), JSON.stringify(reopened, null, 2));
        recommendations.push(`Reclaimed expired claim for task-${task.id}; returned task to pending`);
        updatedTasks.push(reopened);
    }
    return { tasks: updatedTasks, recommendations };
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
    const notified = await notifyPaneWithRetry(sessionName, paneId, message);
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
    const splitType = opts.existingWorkerPaneIds.length === 0 ? '-h' : '-v';
    const splitResult = await tmuxExecAsync([
        'split-window', splitType, '-t', splitTarget,
        '-d', '-P', '-F', '#{pane_id}',
        '-c', opts.workerCwd ?? opts.cwd,
    ]);
    const paneId = splitResult.stdout.split('\n')[0]?.trim();
    if (!paneId) {
        return { paneId: null, startupAssigned: false, startupFailureReason: 'pane_id_missing' };
    }
    const usePromptMode = isPromptModeAgent(opts.agentType);
    // AC-7: render the CLI-worker output contract when a reviewer-style role
    // is routed to an external provider (codex/gemini). Claude workers speak
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
    const promptModeStartupPrompt = generatePromptModeStartupPrompt(opts.teamName, opts.workerName, instructionStateRoot, cliOutputContract);
    if (usePromptMode) {
        await composeInitialInbox(opts.teamName, opts.workerName, instruction, opts.cwd, cliOutputContract);
    }
    // Build env and launch command
    const serializedTaskScope = (opts.taskScope ?? [])
        .map((taskId) => taskId.trim())
        .filter((taskId, index, all) => taskId.length > 0 && all.indexOf(taskId) === index)
        .join(',');
    const envVars = {
        ...getModelWorkerEnv(opts.teamName, opts.workerName, opts.agentType, process.env, {
            leaderCwd: opts.cwd,
            workerCwd: opts.workerCwd ?? opts.cwd,
            teamStateRoot: teamStateRoot(opts.cwd, opts.teamName),
            teamRoot: opts.teamRoot ?? opts.cwd,
            taskScope: opts.taskScope,
        }),
        OMC_TEAM_STATE_ROOT: teamStateRoot(opts.cwd, opts.teamName),
        OMX_TEAM_STATE_ROOT: teamStateRoot(opts.cwd, opts.teamName),
        OMC_TEAM_LEADER_CWD: opts.cwd,
        OMX_TEAM_LEADER_CWD: opts.cwd,
        OMC_TEAM_ROOT: opts.teamRoot ?? opts.cwd,
        OMX_TEAM_ROOT: opts.teamRoot ?? opts.cwd,
        ...(serializedTaskScope ? { OMC_TEAM_TASK_SCOPE: serializedTaskScope, OMX_TEAM_TASK_SCOPE: serializedTaskScope } : {}),
        ...(opts.worktreePath ? { OMC_TEAM_WORKTREE_PATH: opts.worktreePath, OMX_TEAM_WORKTREE_PATH: opts.worktreePath } : {}),
        ...(opts.workerCwd ? { OMC_TEAM_WORKER_CWD: opts.workerCwd, OMX_TEAM_WORKER_CWD: opts.workerCwd } : {}),
    };
    const resolvedBinaryPath = opts.resolvedBinaryPaths[opts.agentType]
        ?? resolveValidatedBinaryPath(opts.agentType);
    // Resolve model from environment variables.
    // For Claude agents on Bedrock/Vertex, resolve the provider-specific model
    // so workers don't fall back to invalid Anthropic API model names. (#1695)
    // Snapshot-provided model (from resolved_routing) takes precedence so
    // per-role routing (codex/gemini/claude-tier) is honored at spawn time.
    const modelForAgent = opts.model ?? (() => {
        if (opts.agentType === 'codex') {
            return process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL
                || process.env.OMC_CODEX_DEFAULT_MODEL
                || undefined;
        }
        if (opts.agentType === 'gemini') {
            return process.env.OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL
                || process.env.OMC_GEMINI_DEFAULT_MODEL
                || undefined;
        }
        // Claude agents: resolve Bedrock/Vertex model when on those providers
        return resolveClaudeWorkerModel();
    })();
    const workerExtraFlags = resolveWorkerLaunchExtraFlags(process.env, opts.launchExtraFlags ?? [], modelForAgent, opts.agentType === 'codex' ? (opts.reasoning ?? resolveAgentReasoningEffort(opts.role ?? undefined)) : undefined);
    const [launchBinary, ...launchArgs] = buildWorkerArgv(opts.agentType, {
        teamName: opts.teamName,
        workerName: opts.workerName,
        cwd: opts.workerCwd ?? opts.cwd,
        resolvedBinaryPath,
        model: modelForAgent,
        extraFlags: workerExtraFlags,
    });
    // For prompt-mode agents (currently gemini), keep the full instruction in
    // inbox.md and pass only a short file-pointer prompt via CLI args. This
    // avoids echoing reviewer/seed prompt text into tmux scrollback.
    if (usePromptMode) {
        launchArgs.push(...getPromptModeArgs(opts.agentType, promptModeStartupPrompt));
    }
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
        launchBinary,
        launchArgs,
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
        fallbackAllowed: false,
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
        const settled = await waitForWorkerStartupEvidence(opts.teamName, opts.workerName, opts.taskId, opts.cwd, 6);
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
async function rollbackUnpersistedNativeWorktreeStartup(teamName, cwd, cause) {
    const safety = inspectTeamWorktreeCleanupSafety(teamName, cwd);
    if (!safety.hasEvidence)
        return;
    const teamRoot = absPath(cwd, TeamPaths.root(teamName));
    const errorMessage = cause instanceof Error ? cause.message : String(cause);
    try {
        const cleanup = cleanupTeamWorktrees(teamName, cwd);
        if (cleanup.preserved.length === 0) {
            await rm(teamRoot, { recursive: true, force: true });
            return;
        }
        await mkdir(teamRoot, { recursive: true });
        await writeFile(join(teamRoot, 'startup-failure.json'), JSON.stringify({
            reason: 'startup_failed_before_config_persisted',
            error: errorMessage,
            preserved: cleanup.preserved,
            recorded_at: new Date().toISOString(),
        }, null, 2), 'utf-8');
    }
    catch (rollbackError) {
        await mkdir(teamRoot, { recursive: true });
        await writeFile(join(teamRoot, 'startup-failure.json'), JSON.stringify({
            reason: 'startup_failed_before_config_persisted',
            error: errorMessage,
            rollback_error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            recorded_at: new Date().toISOString(),
        }, null, 2), 'utf-8');
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
    const agentTypes = config.agentTypes;
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
    // (codex/gemini critic, reviewer, etc.). Missing binaries are tolerated —
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
    await mkdir(join(leaderCwd, '.omc', 'state', 'team', sanitized, 'mailbox'), { recursive: true });
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
    const startupTaskScopes = new Map();
    for (const name of workerNames)
        startupTaskScopes.set(name, []);
    for (const allocation of startupAllocations) {
        const scope = startupTaskScopes.get(allocation.workerName);
        if (!scope)
            continue;
        const taskId = String(allocation.taskIndex + 1);
        if (!scope.includes(taskId))
            scope.push(taskId);
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
            assigned_tasks: [],
            task_scope: startupTaskScopes.get(wName) ?? [],
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
        ...(pluginCfg.team?.workerOverrides ? { worker_overrides: pluginCfg.team.workerOverrides } : {}),
        workspace_mode: workspaceMode,
        worktree_mode: worktreeMode,
        auto_merge: Boolean(config.autoMerge),
    };
    try {
        await saveTeamConfig(teamConfig, leaderCwd);
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
        ...(teamConfig.worker_overrides ? { worker_overrides: teamConfig.worker_overrides } : {}),
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
            // Route the task through the team's immutable snapshot (Option E).
            // Falls back to the round-robin agentType when the inferred role is
            // outside the canonical vocabulary (preserves pre-patch behavior).
            const fallbackAgent = (agentTypes[workerIndex % agentTypes.length] ?? agentTypes[0] ?? 'claude');
            const baseAssignment = resolveTaskAssignment(task, resolvedRouting, pluginCfg.team?.roleRouting, resolvedBinaryPaths, fallbackAgent);
            const workerOverride = getWorkerOverride(teamConfig.worker_overrides, wName, workerIndex);
            const assignment = applyWorkerOverride(baseAssignment, workerOverride, resolvedRouting, resolvedBinaryPaths);
            const workerLaunch = await spawnV2Worker({
                sessionName,
                leaderPaneId,
                existingWorkerPaneIds: workerPaneIds,
                teamName: sanitized,
                workerName: wName,
                workerIndex,
                agentType: assignment.agentType,
                task,
                taskId,
                cwd: leaderCwd,
                workerCwd: workersInfo[workerIndex]?.working_dir ?? leaderCwd,
                worktreePath: workersInfo[workerIndex]?.worktree_path,
                teamRoot: leaderCwd,
                taskScope: workersInfo[workerIndex]?.task_scope ?? [],
                autoMerge: Boolean(config.autoMerge),
                resolvedBinaryPaths,
                ...(assignment.model ? { model: assignment.model } : {}),
                ...(assignment.role ? { role: assignment.role } : {}),
                ...(assignment.extraFlags.length > 0 ? { launchExtraFlags: assignment.extraFlags } : {}),
                ...(assignment.reasoning ? { reasoning: assignment.reasoning } : {}),
            });
            if (workerLaunch.paneId) {
                workerPaneIds.push(workerLaunch.paneId);
                const workerInfo = workersInfo[workerIndex];
                if (workerInfo) {
                    workerInfo.pane_id = workerLaunch.paneId;
                    workerInfo.assigned_tasks = workerLaunch.startupAssigned ? [taskId] : [];
                    workerInfo.worker_cli = assignment.agentType;
                    if (workerOverride && assignment.role)
                        workerInfo.role = assignment.role;
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
        await saveTeamConfig(teamConfig, leaderCwd);
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
            });
            registerTeamOrchestrator(sanitized, orchestrator);
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
 * Requeue tasks from dead workers by writing failure sidecars and resetting
 * task status back to pending so they can be claimed by other workers.
 */
export async function requeueDeadWorkerTasks(teamName, deadWorkerNames, cwd) {
    const logEventFailure = createSwallowedErrorLogger('team.runtime-v2.requeueDeadWorkerTasks appendTeamEvent failed');
    const sanitized = sanitizeTeamName(teamName);
    const tasks = await listTasksFromFiles(sanitized, cwd);
    const requeued = [];
    const deadSet = new Set(deadWorkerNames);
    for (const task of tasks) {
        if (task.status !== 'in_progress')
            continue;
        if (!task.owner || !deadSet.has(task.owner))
            continue;
        // Write failure sidecar
        const sidecarPath = absPath(cwd, `${TeamPaths.tasks(sanitized)}/${task.id}.failure.json`);
        const sidecar = {
            taskId: task.id,
            lastError: `worker_dead:${task.owner}`,
            retryCount: 0,
            lastFailedAt: new Date().toISOString(),
        };
        const { writeFile } = await import('fs/promises');
        await mkdir(absPath(cwd, TeamPaths.tasks(sanitized)), { recursive: true });
        await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf-8');
        // Reset task to pending (locked to prevent race with concurrent claimTask)
        const taskPath = absPath(cwd, TeamPaths.taskFile(sanitized, task.id));
        try {
            const { readFileSync, writeFileSync } = await import('fs');
            const { withFileLockSync } = await import('../lib/file-lock.js');
            withFileLockSync(taskPath + '.lock', () => {
                const raw = readFileSync(taskPath, 'utf-8');
                const taskData = JSON.parse(raw);
                // Only requeue if still in_progress — another worker may have already claimed it
                if (taskData.status === 'in_progress') {
                    taskData.status = 'pending';
                    taskData.owner = undefined;
                    taskData.claim = undefined;
                    writeFileSync(taskPath, JSON.stringify(taskData, null, 2), 'utf-8');
                    requeued.push(task.id);
                }
            });
        }
        catch {
            // Task file may have been removed or lock failed; skip
        }
        await appendTeamEvent(sanitized, {
            type: 'team_leader_nudge',
            worker: 'leader-fixed',
            task_id: task.id,
            reason: `requeue_dead_worker:${task.owner}`,
        }, cwd).catch(logEventFailure);
    }
    return requeued;
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
    let allTasks = await listTasksFromFiles(sanitized, cwd);
    const reclaimResult = await reclaimExpiredInProgressTasks(sanitized, cwd, allTasks);
    allTasks = reclaimResult.tasks;
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
    const recommendations = [...reclaimResult.recommendations];
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
    const config = await readTeamConfig(sanitized, cwd);
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
    // 1. Shutdown gate check
    if (!force) {
        const allTasks = await listTasksFromFiles(sanitized, cwd);
        const governance = getConfigGovernance(config);
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
        if (!gate.allowed) {
            const hasActiveWork = gate.pending > 0 || gate.blocked > 0 || gate.in_progress > 0;
            if (!governance.cleanup_requires_all_workers_inactive) {
                await appendTeamEvent(sanitized, {
                    type: 'team_leader_nudge',
                    worker: 'leader-fixed',
                    reason: `cleanup_override_bypassed:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`,
                }, cwd).catch(logEventFailure);
            }
            else if (ralph && !hasActiveWork) {
                // Ralph policy: bypass on failure-only scenarios
                await appendTeamEvent(sanitized, {
                    type: 'team_leader_nudge',
                    worker: 'leader-fixed',
                    reason: `gate_bypassed:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`,
                }, cwd).catch(logEventFailure);
            }
            else {
                throw new Error(`shutdown_gate_blocked:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`);
            }
        }
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
            throw new Error(`shutdown_rejected:${detail}`);
        }
        // Check if all workers have acked or exited
        const allDone = config.workers.every((w) => ackedWorkers.has(w.name));
        if (allDone)
            break;
        await new Promise((r) => setTimeout(r, 2_000));
    }
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
    const root = join(cwd, '.omc', 'state', 'team');
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