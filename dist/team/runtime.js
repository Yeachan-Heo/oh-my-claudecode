import { mkdir, writeFile, readFile, rm, rename } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { buildWorkerArgv, validateCliAvailable, getWorkerEnv as getModelWorkerEnv, isPromptModeAgent, getPromptModeArgs } from './model-contract.js';
import { validateTeamName } from './team-name.js';
import { createTeamSession, spawnWorkerInPane, sendToWorker, isWorkerAlive, killTeamSession, } from './tmux-session.js';
import { composeInitialInbox, ensureWorkerStateDir, writeWorkerOverlay, } from './worker-bootstrap.js';
import { withTaskLock } from './task-file-ops.js';
function workerName(index) {
    return `worker-${index + 1}`;
}
function stateRoot(cwd, teamName) {
    validateTeamName(teamName);
    return join(cwd, `.omc/state/team/${teamName}`);
}
async function writeJson(filePath, data) {
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}
async function readJsonSafe(filePath) {
    try {
        const content = await readFile(filePath, 'utf-8');
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
function parseWorkerIndex(workerNameValue) {
    const match = workerNameValue.match(/^worker-(\d+)$/);
    if (!match)
        return 0;
    const parsed = Number.parseInt(match[1], 10) - 1;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
function taskPath(root, taskId) {
    return join(root, 'tasks', `${taskId}.json`);
}
async function writePanesTrackingFileIfPresent(runtime) {
    const jobId = process.env.OMC_JOB_ID;
    const omcJobsDir = process.env.OMC_JOBS_DIR;
    if (!jobId || !omcJobsDir)
        return;
    const panesPath = join(omcJobsDir, `${jobId}-panes.json`);
    const tempPath = `${panesPath}.tmp`;
    await writeFile(tempPath, JSON.stringify({ paneIds: [...runtime.workerPaneIds], leaderPaneId: runtime.leaderPaneId }), 'utf-8');
    await rename(tempPath, panesPath);
}
async function readTask(root, taskId) {
    return readJsonSafe(taskPath(root, taskId));
}
async function writeTask(root, task) {
    await writeJson(taskPath(root, task.id), task);
}
async function markTaskInProgress(root, taskId, owner, teamName, cwd) {
    const result = await withTaskLock(teamName, taskId, async () => {
        const task = await readTask(root, taskId);
        if (!task || task.status !== 'pending')
            return false;
        task.status = 'in_progress';
        task.owner = owner;
        task.assignedAt = new Date().toISOString();
        await writeTask(root, task);
        return true;
    }, { cwd });
    // withTaskLock returns null if the lock could not be acquired — treat as not claimed
    return result ?? false;
}
async function resetTaskToPending(root, taskId) {
    const task = await readTask(root, taskId);
    if (!task)
        return;
    task.status = 'pending';
    task.owner = null;
    task.assignedAt = undefined;
    await writeTask(root, task);
}
async function markTaskFromDone(root, taskId, status, summary) {
    const task = await readTask(root, taskId);
    if (!task)
        return;
    task.status = status;
    task.result = summary;
    task.summary = summary;
    if (status === 'completed') {
        task.completedAt = new Date().toISOString();
    }
    else {
        task.failedAt = new Date().toISOString();
    }
    await writeTask(root, task);
}
async function markTaskFailedDeadPane(root, taskId, workerNameValue) {
    const task = await readTask(root, taskId);
    if (!task)
        return;
    task.status = 'failed';
    task.owner = workerNameValue;
    task.summary = `Worker pane died before done.json was written (${workerNameValue})`;
    task.result = task.summary;
    task.failedAt = new Date().toISOString();
    await writeTask(root, task);
}
async function nextPendingTaskIndex(runtime) {
    const root = stateRoot(runtime.cwd, runtime.teamName);
    for (let i = 0; i < runtime.config.tasks.length; i++) {
        const task = await readTask(root, String(i + 1));
        if (task?.status === 'pending')
            return i;
    }
    return null;
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
export async function allTasksTerminal(runtime) {
    const root = stateRoot(runtime.cwd, runtime.teamName);
    for (let i = 0; i < runtime.config.tasks.length; i++) {
        const task = await readTask(root, String(i + 1));
        if (!task)
            return false;
        if (task.status !== 'completed' && task.status !== 'failed')
            return false;
    }
    return true;
}
/**
 * Build the initial task instruction written to a worker's inbox.
 * Includes task ID, subject, full description, and done-signal path.
 */
function buildInitialTaskInstruction(teamName, workerName, task, taskId) {
    const donePath = `.omc/state/team/${teamName}/workers/${workerName}/done.json`;
    return [
        `## Initial Task Assignment`,
        `Task ID: ${taskId}`,
        `Worker: ${workerName}`,
        `Subject: ${task.subject}`,
        ``,
        task.description,
        ``,
        `When complete, write done signal to ${donePath}:`,
        `{"taskId":"${taskId}","status":"completed","summary":"<brief summary>","completedAt":"<ISO timestamp>"}`,
        ``,
        `IMPORTANT: Execute ONLY the task assigned to you in this inbox. After writing done.json, exit immediately. Do not read from the task directory or claim other tasks.`,
    ].join('\n');
}
/**
 * Start a new team: create tmux session, spawn workers, wait for ready.
 */
export async function startTeam(config) {
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
    const workerNames = [];
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
    const session = await createTeamSession(teamName, 0, cwd);
    const runtime = {
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
        if (taskIndex == null)
            break;
        await spawnWorkerForTask(runtime, workerName(i), taskIndex);
    }
    runtime.stopWatchdog = watchdogCliWorkers(runtime, 1000);
    return runtime;
}
/**
 * Monitor team: poll worker health, detect stalls, return snapshot.
 */
export async function monitorTeam(teamName, cwd, workerPaneIds) {
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
            const task = await readJsonSafe(join(root, 'tasks', f));
            if (task?.status === 'pending')
                taskCounts.pending++;
            else if (task?.status === 'in_progress')
                taskCounts.inProgress++;
            else if (task?.status === 'completed')
                taskCounts.completed++;
            else if (task?.status === 'failed')
                taskCounts.failed++;
        }
    }
    catch { /* tasks dir may not exist yet */ }
    const listTasksMs = Date.now() - taskScanStartedAt;
    // Check worker health
    const workerScanStartedAt = Date.now();
    const workers = [];
    const deadWorkers = [];
    for (let i = 0; i < workerPaneIds.length; i++) {
        const wName = `worker-${i + 1}`;
        const paneId = workerPaneIds[i];
        const alive = await isWorkerAlive(paneId);
        const heartbeatPath = join(root, 'workers', wName, 'heartbeat.json');
        const heartbeat = await readJsonSafe(heartbeatPath);
        // Detect stall: no heartbeat update in 60s
        let stalled = false;
        if (heartbeat?.updatedAt) {
            const age = Date.now() - new Date(heartbeat.updatedAt).getTime();
            stalled = age > 60_000;
        }
        const status = {
            workerName: wName,
            alive,
            paneId,
            currentTaskId: heartbeat?.currentTaskId,
            lastHeartbeat: heartbeat?.updatedAt,
            stalled,
        };
        workers.push(status);
        if (!alive)
            deadWorkers.push(wName);
        // Note: CLI workers (codex/gemini) may not write heartbeat.json — stall is advisory only
    }
    const workerScanMs = Date.now() - workerScanStartedAt;
    // Infer phase from task counts
    let phase = 'executing';
    if (taskCounts.inProgress === 0 && taskCounts.pending > 0 && taskCounts.completed === 0) {
        phase = 'planning';
    }
    else if (taskCounts.failed > 0 && taskCounts.pending === 0 && taskCounts.inProgress === 0) {
        phase = 'fixing';
    }
    else if (taskCounts.completed > 0 && taskCounts.pending === 0 && taskCounts.inProgress === 0 && taskCounts.failed === 0) {
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
export function watchdogCliWorkers(runtime, intervalMs) {
    let tickInFlight = false;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;
    // Track consecutive unresponsive ticks per worker
    const unresponsiveCounts = new Map();
    const UNRESPONSIVE_KILL_THRESHOLD = 3;
    const tick = async () => {
        if (tickInFlight)
            return;
        tickInFlight = true;
        try {
            const workers = [...runtime.activeWorkers.entries()];
            if (workers.length === 0)
                return;
            const root = stateRoot(runtime.cwd, runtime.teamName);
            // Collect done signals and alive checks in parallel to avoid O(N×300ms) sequential tmux calls.
            const [doneSignals, aliveResults] = await Promise.all([
                Promise.all(workers.map(([wName]) => {
                    const donePath = join(root, 'workers', wName, 'done.json');
                    return readJsonSafe(donePath);
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
                    }
                    catch {
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
                const heartbeat = await readJsonSafe(heartbeatPath);
                const isStalled = heartbeat?.updatedAt
                    ? Date.now() - new Date(heartbeat.updatedAt).getTime() > 60_000
                    : false;
                if (isStalled) {
                    const count = (unresponsiveCounts.get(wName) ?? 0) + 1;
                    unresponsiveCounts.set(wName, count);
                    if (count < UNRESPONSIVE_KILL_THRESHOLD) {
                        console.warn(`[watchdog] worker ${wName} unresponsive (${count}/${UNRESPONSIVE_KILL_THRESHOLD}), task ${active.taskId}`);
                    }
                    else {
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
                }
                else {
                    // Worker is responsive — reset counter
                    unresponsiveCounts.delete(wName);
                }
            }
            // Reset failure counter on a successful tick
            consecutiveFailures = 0;
        }
        catch (err) {
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
                }
                catch {
                    // best-effort
                }
                clearInterval(intervalId);
            }
        }
        finally {
            tickInFlight = false;
        }
    };
    const intervalId = setInterval(() => { tick(); }, intervalMs);
    return () => clearInterval(intervalId);
}
/**
 * Spawn a worker pane for an explicit task assignment.
 */
export async function spawnWorkerForTask(runtime, workerNameValue, taskIndex) {
    const root = stateRoot(runtime.cwd, runtime.teamName);
    const taskId = String(taskIndex + 1);
    const task = runtime.config.tasks[taskIndex];
    if (!task)
        return '';
    const marked = await markTaskInProgress(root, taskId, workerNameValue, runtime.teamName, runtime.cwd);
    if (!marked)
        return '';
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
    if (!paneId)
        return '';
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
    // For prompt-mode agents (e.g. Gemini Ink TUI), pass instruction via CLI
    // flag so tmux send-keys never needs to interact with the TUI input widget.
    if (usePromptMode) {
        const promptArgs = getPromptModeArgs(agentType, `Read and execute your task from: ${relInboxPath}`);
        launchArgs.push(...promptArgs);
    }
    const paneConfig = {
        teamName: runtime.teamName,
        workerName: workerNameValue,
        envVars,
        launchBinary,
        launchArgs,
        cwd: runtime.cwd,
    };
    await spawnWorkerInPane(runtime.sessionName, paneId, paneConfig);
    runtime.workerPaneIds.push(paneId);
    runtime.activeWorkers.set(workerNameValue, { paneId, taskId, spawnedAt: Date.now() });
    try {
        await execFileAsync('tmux', ['select-layout', '-t', runtime.sessionName, 'main-vertical']);
    }
    catch {
        // layout update is best-effort
    }
    try {
        await writePanesTrackingFileIfPresent(runtime);
    }
    catch {
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
        const notified = await notifyPaneWithRetry(runtime.sessionName, paneId, `Read and execute your task from: ${relInboxPath}`);
        if (!notified) {
            await killWorkerPane(runtime, workerNameValue, paneId);
            await resetTaskToPending(root, taskId);
            throw new Error(`worker_notify_failed:${workerNameValue}:initial-inbox`);
        }
    }
    // Prompt-mode agents: instruction already passed via CLI flag at spawn.
    // No trust-confirm or tmux send-keys interaction needed.
    return paneId;
}
/**
 * Kill a single worker pane and update runtime state.
 */
export async function killWorkerPane(runtime, workerNameValue, paneId) {
    try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);
        await execFileAsync('tmux', ['kill-pane', '-t', paneId]);
    }
    catch {
        // idempotent: pane may already be gone
    }
    const paneIndex = runtime.workerPaneIds.indexOf(paneId);
    if (paneIndex >= 0) {
        runtime.workerPaneIds.splice(paneIndex, 1);
    }
    runtime.activeWorkers.delete(workerNameValue);
    try {
        await writePanesTrackingFileIfPresent(runtime);
    }
    catch {
        // panes tracking is best-effort
    }
}
/**
 * Assign a task to a specific worker via inbox + tmux trigger.
 */
export async function assignTask(teamName, taskId, targetWorkerName, paneId, sessionName, cwd) {
    const root = stateRoot(cwd, teamName);
    const taskFilePath = join(root, 'tasks', `${taskId}.json`);
    let previousTaskState = null;
    let lockedTask = null;
    await withTaskLock(teamName, taskId, async () => {
        const t = await readJsonSafe(taskFilePath);
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
            const rollback = lockedTask;
            rollback.status = previousTaskState.status;
            rollback.owner = previousTaskState.owner;
            rollback.assignedAt = previousTaskState.assignedAt;
            await writeJson(taskFilePath, rollback);
        }
        throw new Error(`worker_notify_failed:${targetWorkerName}:new-task:${taskId}`);
    }
}
/**
 * Gracefully shut down all workers and clean up.
 */
export async function shutdownTeam(teamName, sessionName, cwd, timeoutMs = 30_000, workerPaneIds, leaderPaneId) {
    const root = stateRoot(cwd, teamName);
    // Write shutdown request
    await writeJson(join(root, 'shutdown.json'), {
        requestedAt: new Date().toISOString(),
        teamName,
    });
    const configData = await readJsonSafe(join(root, 'config.json'));
    // CLI workers (claude/codex/gemini tmux pane processes) never write shutdown-ack.json.
    // Polling for ACK files on CLI worker teams wastes the full timeoutMs on every shutdown.
    // Detect CLI worker teams by checking if all agent types are known CLI types, and skip
    // ACK polling — the tmux kill below handles process cleanup instead.
    const CLI_AGENT_TYPES = new Set(['claude', 'codex', 'gemini']);
    const agentTypes = configData?.agentTypes ?? [];
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
    // Kill tmux session (or just worker panes in split-pane mode)
    await killTeamSession(sessionName, workerPaneIds, leaderPaneId);
    // Clean up state
    try {
        await rm(root, { recursive: true, force: true });
    }
    catch {
        // Ignore cleanup errors
    }
}
/**
 * Resume an existing team from persisted state.
 * Reconstructs activeWorkers by scanning task files for in_progress tasks
 * so the watchdog loop can continue processing without stalling.
 */
export async function resumeTeam(teamName, cwd) {
    const root = stateRoot(cwd, teamName);
    const configData = await readJsonSafe(join(root, 'config.json'));
    if (!configData)
        return null;
    // Check if session is alive
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const sName = `omc-team-${teamName}`;
    try {
        await execFileAsync('tmux', ['has-session', '-t', sName]);
    }
    catch {
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
    const paneByWorker = new Map(workerNames.map((wName, i) => [wName, workerPaneIds[i] ?? '']));
    const activeWorkers = new Map();
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
//# sourceMappingURL=runtime.js.map