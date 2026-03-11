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
import { execFile } from 'child_process';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { performance } from 'perf_hooks';
import { TeamPaths, absPath, teamStateRoot } from './state-paths.js';
import { readTeamConfig, readWorkerStatus, readWorkerHeartbeat, readMonitorSnapshot, writeMonitorSnapshot, writeShutdownRequest, readShutdownAck, writeWorkerInbox, listTasksFromFiles, saveTeamConfig, cleanupTeamState, } from './monitor.js';
import { appendTeamEvent, emitMonitorDerivedEvents } from './events.js';
import { inferPhase } from './phase-controller.js';
import { validateTeamName } from './team-name.js';
import { buildWorkerArgv, resolveValidatedBinaryPath, getWorkerEnv as getModelWorkerEnv, isPromptModeAgent, getPromptModeArgs, } from './model-contract.js';
import { createTeamSession, spawnWorkerInPane, sendToWorker, waitForPaneReady, paneHasActiveTask, paneLooksReady, } from './tmux-session.js';
import { composeInitialInbox, ensureWorkerStateDir, writeWorkerOverlay, generateTriggerMessage, } from './worker-bootstrap.js';
import { queueInboxInstruction } from './mcp-comm.js';
import { cleanupTeamWorktrees } from './git-worktree.js';
// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------
export function isRuntimeV2Enabled(env = process.env) {
    const raw = env.OMC_RUNTIME_V2;
    if (!raw)
        return true;
    const normalized = raw.trim().toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(normalized);
}
const MONITOR_SIGNAL_STALE_MS = 30_000;
// ---------------------------------------------------------------------------
// Helper: sanitize team name
// ---------------------------------------------------------------------------
function sanitizeTeamName(name) {
    return name.replace(/[^a-z0-9-]/g, '').slice(0, 30);
}
// ---------------------------------------------------------------------------
// Helper: check worker liveness via tmux pane
// ---------------------------------------------------------------------------
async function isWorkerPaneAlive(paneId) {
    if (!paneId)
        return false;
    try {
        const { isWorkerAlive } = await import('./tmux-session.js');
        return await isWorkerAlive(paneId);
    }
    catch {
        return false;
    }
}
async function captureWorkerPane(paneId) {
    if (!paneId)
        return '';
    return await new Promise((resolve) => {
        execFile('tmux', ['capture-pane', '-t', paneId, '-p', '-S', '-80'], (err, stdout) => {
            if (err)
                resolve('');
            else
                resolve(stdout ?? '');
        });
    });
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
// ---------------------------------------------------------------------------
// V2 task instruction builder — CLI API lifecycle, NO done.json
// ---------------------------------------------------------------------------
/**
 * Build the initial task instruction for v2 workers.
 * Workers use `omc team api` CLI commands for all lifecycle transitions.
 */
function buildV2TaskInstruction(teamName, workerName, task, taskId) {
    return [
        `## REQUIRED: Task Lifecycle Commands`,
        `You MUST run these commands. Do NOT skip any step.`,
        ``,
        `1. Claim your task:`,
        `   omc team api claim-task --input '{"team_name":"${teamName}","task_id":"${taskId}","worker":"${workerName}"}' --json`,
        `   Save the claim_token from the response.`,
        `2. Do the work described below.`,
        `3. On completion (use claim_token from step 1):`,
        `   omc team api transition-task-status --input '{"team_name":"${teamName}","task_id":"${taskId}","from":"in_progress","to":"completed","claim_token":"<claim_token>"}' --json`,
        `4. On failure (use claim_token from step 1):`,
        `   omc team api transition-task-status --input '{"team_name":"${teamName}","task_id":"${taskId}","from":"in_progress","to":"failed","claim_token":"<claim_token>"}' --json`,
        `5. Exit immediately after transitioning.`,
        ``,
        `## Task Assignment`,
        `Task ID: ${taskId}`,
        `Worker: ${workerName}`,
        `Subject: ${task.subject}`,
        ``,
        task.description,
        ``,
        `REMINDER: You MUST run transition-task-status before exiting. Do NOT write done.json or edit task files directly.`,
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
async function hasClaudeStartupEvidence(teamName, workerName, taskId, cwd) {
    const [hasClaimEvidence, status] = await Promise.all([
        hasWorkerTaskClaimEvidence(teamName, workerName, cwd, taskId),
        readWorkerStatus(teamName, workerName, cwd),
    ]);
    return hasClaimEvidence || hasWorkerStatusProgress(status, taskId);
}
async function waitForClaudeStartupEvidence(teamName, workerName, taskId, cwd, attempts = 3, delayMs = 250) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (await hasClaudeStartupEvidence(teamName, workerName, taskId, cwd)) {
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
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    // Split new pane off the last existing pane (or leader if first worker)
    const splitTarget = opts.existingWorkerPaneIds.length === 0
        ? opts.leaderPaneId
        : opts.existingWorkerPaneIds[opts.existingWorkerPaneIds.length - 1];
    const splitType = opts.existingWorkerPaneIds.length === 0 ? '-h' : '-v';
    const splitResult = await execFileAsync('tmux', [
        'split-window', splitType, '-t', splitTarget,
        '-d', '-P', '-F', '#{pane_id}',
        '-c', opts.cwd,
    ]);
    const paneId = splitResult.stdout.split('\n')[0]?.trim();
    if (!paneId) {
        return { paneId: null, startupAssigned: false, startupFailureReason: 'pane_id_missing' };
    }
    const usePromptMode = isPromptModeAgent(opts.agentType);
    // Build v2 task instruction (CLI API, NO done.json)
    const instruction = buildV2TaskInstruction(opts.teamName, opts.workerName, opts.task, opts.taskId);
    const relInboxPath = `.omc/state/team/${opts.teamName}/workers/${opts.workerName}/inbox.md`;
    const inboxTriggerMessage = generateTriggerMessage(opts.teamName, opts.workerName);
    if (usePromptMode) {
        await composeInitialInbox(opts.teamName, opts.workerName, instruction, opts.cwd);
    }
    // Build env and launch command
    const envVars = {
        ...getModelWorkerEnv(opts.teamName, opts.workerName, opts.agentType),
        OMC_TEAM_STATE_ROOT: teamStateRoot(opts.cwd, opts.teamName),
        OMC_TEAM_LEADER_CWD: opts.cwd,
    };
    const resolvedBinaryPath = opts.resolvedBinaryPaths[opts.agentType]
        ?? resolveValidatedBinaryPath(opts.agentType);
    // Resolve model from environment variables
    const modelForAgent = (() => {
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
        return undefined;
    })();
    const [launchBinary, ...launchArgs] = buildWorkerArgv(opts.agentType, {
        teamName: opts.teamName,
        workerName: opts.workerName,
        cwd: opts.cwd,
        resolvedBinaryPath,
        model: modelForAgent,
    });
    // For prompt-mode agents (codex, gemini), pass instruction via CLI flag
    if (usePromptMode) {
        const promptArgs = getPromptModeArgs(opts.agentType, inboxTriggerMessage);
        launchArgs.push(...promptArgs);
    }
    const paneConfig = {
        teamName: opts.teamName,
        workerName: opts.workerName,
        envVars,
        launchBinary,
        launchArgs,
        cwd: opts.cwd,
    };
    await spawnWorkerInPane(opts.sessionName, paneId, paneConfig);
    // Apply layout
    try {
        await execFileAsync('tmux', [
            'select-layout', '-t', opts.sessionName, 'main-vertical',
        ]);
    }
    catch { /* layout is best-effort */ }
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
        const settled = await waitForClaudeStartupEvidence(opts.teamName, opts.workerName, opts.taskId, opts.cwd);
        if (!settled) {
            const renotified = await notifyStartupInbox(opts.sessionName, paneId, inboxTriggerMessage);
            if (!renotified.ok) {
                return {
                    paneId,
                    startupAssigned: false,
                    startupFailureReason: `${renotified.reason}:startup_evidence_missing`,
                };
            }
            const settledAfterRetry = await waitForClaudeStartupEvidence(opts.teamName, opts.workerName, opts.taskId, opts.cwd);
            if (!settledAfterRetry) {
                return {
                    paneId,
                    startupAssigned: false,
                    startupFailureReason: 'claude_startup_evidence_missing',
                };
            }
        }
    }
    return {
        paneId,
        startupAssigned: true,
    };
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
    // Validate CLIs and pin absolute binary paths
    const agentTypes = config.agentTypes;
    const resolvedBinaryPaths = {};
    for (const agentType of [...new Set(agentTypes)]) {
        resolvedBinaryPaths[agentType] = resolveValidatedBinaryPath(agentType);
    }
    // Create state directories
    await mkdir(absPath(leaderCwd, TeamPaths.tasks(sanitized)), { recursive: true });
    await mkdir(absPath(leaderCwd, TeamPaths.workers(sanitized)), { recursive: true });
    await mkdir(join(leaderCwd, '.omc', 'state', 'team', sanitized, 'mailbox'), { recursive: true });
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
            created_at: new Date().toISOString(),
        }, null, 2), 'utf-8');
    }
    // Set up worker state dirs and overlays (with v2 CLI API instructions)
    const workerNames = [];
    for (let i = 0; i < config.tasks.length; i++) {
        const wName = `worker-${i + 1}`;
        workerNames.push(wName);
        const agentType = (agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? 'claude');
        await ensureWorkerStateDir(sanitized, wName, leaderCwd);
        await writeWorkerOverlay({
            teamName: sanitized, workerName: wName, agentType,
            tasks: config.tasks.map((t, idx) => ({
                id: String(idx + 1), subject: t.subject, description: t.description,
            })),
            cwd: leaderCwd,
            ...(config.rolePrompt ? { bootstrapInstructions: config.rolePrompt } : {}),
        });
    }
    // Create tmux session (leader only — workers spawned below)
    const session = await createTeamSession(sanitized, 0, leaderCwd, {
        newWindow: Boolean(config.newWindow),
    });
    const sessionName = session.sessionName;
    const leaderPaneId = session.leaderPaneId;
    const ownsWindow = session.sessionMode !== 'split-pane';
    const workerPaneIds = [];
    // Build workers info for config
    const workersInfo = workerNames.map((wName, i) => ({
        name: wName,
        index: i + 1,
        role: (agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? 'claude'),
        assigned_tasks: [],
        working_dir: leaderCwd,
    }));
    // Write initial v2 config
    const teamConfig = {
        name: sanitized,
        task: config.tasks.map(t => t.subject).join('; '),
        agent_type: agentTypes[0] || 'claude',
        worker_launch_mode: 'interactive',
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
        ...(ownsWindow ? { workspace_mode: 'single' } : {}),
    };
    await saveTeamConfig(teamConfig, leaderCwd);
    // Spawn workers for initial tasks (up to workerCount concurrent)
    const maxConcurrent = Math.min(agentTypes.length, config.tasks.length);
    for (let i = 0; i < maxConcurrent; i++) {
        const wName = workerNames[i];
        const taskId = String(i + 1);
        const task = config.tasks[i];
        if (!task)
            break;
        const workerLaunch = await spawnV2Worker({
            sessionName,
            leaderPaneId,
            existingWorkerPaneIds: workerPaneIds,
            teamName: sanitized,
            workerName: wName,
            workerIndex: i,
            agentType: (agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? 'claude'),
            task,
            taskId,
            cwd: leaderCwd,
            resolvedBinaryPaths,
        });
        if (workerLaunch.paneId) {
            workerPaneIds.push(workerLaunch.paneId);
            const workerInfo = workersInfo[i];
            if (workerInfo) {
                workerInfo.pane_id = workerLaunch.paneId;
                workerInfo.assigned_tasks = workerLaunch.startupAssigned ? [taskId] : [];
            }
        }
        if (workerLaunch.startupFailureReason) {
            await appendTeamEvent(sanitized, {
                type: 'team_leader_nudge',
                worker: 'leader-fixed',
                reason: `startup_manual_intervention_required:${wName}:${workerLaunch.startupFailureReason}`,
            }, leaderCwd);
        }
    }
    // Persist config with pane IDs
    teamConfig.workers = workersInfo;
    await saveTeamConfig(teamConfig, leaderCwd);
    // Emit start event — NO watchdog, leader drives via monitorTeamV2()
    await appendTeamEvent(sanitized, {
        type: 'team_leader_nudge',
        worker: 'leader-fixed',
        reason: `start_team_v2: workers=${config.workerCount} tasks=${config.tasks.length} panes=${workerPaneIds.length}`,
    }, leaderCwd);
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
        // Reset task to pending (clear owner and claim)
        const taskPath = absPath(cwd, TeamPaths.taskFile(sanitized, task.id));
        try {
            const raw = await import('fs/promises').then(fs => fs.readFile(taskPath, 'utf-8'));
            const taskData = JSON.parse(raw);
            taskData.status = 'pending';
            taskData.owner = undefined;
            taskData.claim = undefined;
            await writeFile(taskPath, JSON.stringify(taskData, null, 2), 'utf-8');
            requeued.push(task.id);
        }
        catch {
            // Task file may have been removed; skip
        }
        await appendTeamEvent(sanitized, {
            type: 'team_leader_nudge',
            worker: 'leader-fixed',
            task_id: task.id,
            reason: `requeue_dead_worker:${task.owner}`,
        }, cwd).catch(() => { });
    }
    return requeued;
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
        const alive = await isWorkerPaneAlive(worker.pane_id);
        const [status, heartbeat, paneCapture] = await Promise.all([
            readWorkerStatus(sanitized, worker.name, cwd),
            readWorkerHeartbeat(sanitized, worker.name, cwd),
            alive ? captureWorkerPane(worker.pane_id) : Promise.resolve(''),
        ]);
        return { worker, alive, status, heartbeat, paneCapture };
    }));
    const workerScanMs = performance.now() - workerScanStartMs;
    for (const { worker: w, alive, status, heartbeat, paneCapture } of workerSignals) {
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
            status,
            heartbeat,
            assignedTasks: w.assigned_tasks,
            turnsWithoutProgress,
        });
        if (!alive) {
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
        let stallReason = null;
        if (paneSuggestsIdle && expectedTaskId !== '' && !hasWorkStartEvidence) {
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
            if (stallReason === 'no_work_start_evidence') {
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
    // Infer phase from task distribution
    const phase = inferPhase(allTasks.map((t) => ({
        status: t.status,
        metadata: undefined,
    })));
    // Emit monitor-derived events (task completions, worker state changes)
    await emitMonitorDerivedEvents(sanitized, allTasks, workers.map((w) => ({ name: w.name, alive: w.alive, status: w.status })), previousSnapshot, cwd);
    // Persist snapshot for next cycle
    const updatedAt = new Date().toISOString();
    const totalMs = performance.now() - monitorStartMs;
    await writeMonitorSnapshot(sanitized, {
        taskStatusById: Object.fromEntries(allTasks.map((t) => [t.id, t.status])),
        workerAliveByName: Object.fromEntries(workers.map((w) => [w.name, w.alive])),
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
    const force = options.force === true;
    const ralph = options.ralph === true;
    const timeoutMs = options.timeoutMs ?? 15_000;
    const sanitized = sanitizeTeamName(teamName);
    const config = await readTeamConfig(sanitized, cwd);
    if (!config) {
        // No config available; only clean state. We intentionally avoid guessing
        // a tmux session name here to prevent accidental self-session termination.
        await cleanupTeamState(sanitized, cwd);
        return;
    }
    // 1. Shutdown gate check
    if (!force) {
        const allTasks = await listTasksFromFiles(sanitized, cwd);
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
        }, cwd).catch(() => { });
        if (!gate.allowed) {
            const hasActiveWork = gate.pending > 0 || gate.blocked > 0 || gate.in_progress > 0;
            if (ralph && !hasActiveWork) {
                // Ralph policy: bypass on failure-only scenarios
                await appendTeamEvent(sanitized, {
                    type: 'team_leader_nudge',
                    worker: 'leader-fixed',
                    reason: `gate_bypassed:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`,
                }, cwd).catch(() => { });
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
        }, cwd).catch(() => { });
    }
    // 2. Send shutdown request to each worker
    const shutdownRequestTimes = new Map();
    for (const w of config.workers) {
        try {
            const requestedAt = new Date().toISOString();
            await writeShutdownRequest(sanitized, w.name, 'leader-fixed', cwd);
            shutdownRequestTimes.set(w.name, requestedAt);
            // Write shutdown inbox
            const shutdownInbox = `# Shutdown Request\n\nAll tasks are complete. Please wrap up and respond with a shutdown acknowledgement.\n\nWrite your ack to: ${TeamPaths.shutdownAck(sanitized, w.name)}\nFormat: {"status":"accept","reason":"ok","updated_at":"<iso>"}\n\nThen exit your session.\n`;
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
                }, cwd).catch(() => { });
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
    try {
        const { killWorkerPanes, killTeamSession } = await import('./tmux-session.js');
        const workerPaneIds = config.workers
            .map((w) => w.pane_id)
            .filter((p) => typeof p === 'string' && p.trim().length > 0);
        const ownsWindow = config.tmux_window_owned === true;
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
    }
    catch (err) {
        process.stderr.write(`[team/runtime-v2] tmux cleanup: ${err}\n`);
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
        }, cwd).catch(() => { });
    }
    // 6. Clean up state
    try {
        cleanupTeamWorktrees(sanitized, cwd);
    }
    catch (err) {
        process.stderr.write(`[team/runtime-v2] worktree cleanup: ${err}\n`);
    }
    await cleanupTeamState(sanitized, cwd);
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
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);
        const sessionName = config.tmux_session || `omc-team-${sanitized}`;
        await execFileAsync('tmux', ['has-session', '-t', sessionName.split(':')[0]]);
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