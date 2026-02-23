import { mkdir, writeFile, readFile, rm, appendFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { buildWorkerCommand, validateCliAvailable, getWorkerEnv as getModelWorkerEnv } from './model-contract.js';
import { createTeamSession, spawnWorkerInPane, sendToWorker, waitForWorkerReady, isWorkerAlive, killTeamSession, injectToLeaderPane, } from './tmux-session.js';
import { composeInitialInbox, ensureWorkerStateDir, writeWorkerOverlay, } from './worker-bootstrap.js';
import { queueInboxInstruction } from './tmux-comm.js';
function workerName(index) {
    return `worker-${index + 1}`;
}
function stateRoot(cwd, teamName) {
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
    ].join('\n');
}
/**
 * Start a new team: create tmux session, spawn workers, wait for ready.
 */
export async function startTeam(config) {
    const { teamName, workerCount, agentTypes, tasks, cwd } = config;
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
    // Set up worker state dirs and overlays
    const workerNames = [];
    for (let i = 0; i < workerCount; i++) {
        const wName = workerName(i);
        workerNames.push(wName);
        const agentType = agentTypes[i] ?? agentTypes[0] ?? 'claude';
        await ensureWorkerStateDir(teamName, wName, cwd);
        await writeWorkerOverlay({
            teamName, workerName: wName, agentType,
            tasks: tasks.map((t, idx) => ({ id: String(idx + 1), subject: t.subject, description: t.description })),
            cwd,
        });
        await composeInitialInbox(teamName, wName, `# Welcome, ${wName}\n\nRead your AGENTS.md overlay at .omc/state/team/${teamName}/workers/${wName}/AGENTS.md\n\nWrite your ready sentinel first, then claim tasks from .omc/state/team/${teamName}/tasks/`, cwd);
    }
    // Create tmux session with split panes
    const session = await createTeamSession(teamName, workerCount, cwd);
    // Spawn CLI agents in each pane
    for (let i = 0; i < workerCount; i++) {
        const wName = workerNames[i];
        const agentType = agentTypes[i] ?? agentTypes[0] ?? 'claude';
        const paneId = session.workerPaneIds[i];
        const envVars = getModelWorkerEnv(teamName, wName, agentType);
        const launchCmd = buildWorkerCommand(agentType, { teamName, workerName: wName, cwd });
        const paneConfig = { teamName, workerName: wName, envVars, launchCmd, cwd };
        await spawnWorkerInPane(session.sessionName, paneId, paneConfig);
    }
    // Wait for workers to be ready / seed them with initial tasks
    await Promise.all(workerNames.map(async (wName, i) => {
        const agentType = agentTypes[i] ?? agentTypes[0] ?? 'claude';
        const paneId = session.workerPaneIds[i];
        if (agentType === 'claude') {
            // Claude workers write .ready sentinel after reading their AGENTS.md overlay
            const ready = await waitForWorkerReady(teamName, wName, cwd, 30_000);
            if (!ready)
                console.warn(`[runtime] Claude worker ${wName} not ready within 30s`);
            // Deliver full task via inbox file to avoid 200-char tmux limit
            const task = tasks[i] ?? tasks[0];
            if (task) {
                const taskId = String(i + 1);
                await queueInboxInstruction(teamName, wName, buildInitialTaskInstruction(teamName, wName, task, taskId), paneId, cwd);
            }
        }
        else {
            // Non-Claude workers (codex/gemini): wait for CLI startup, then send initial task via tmux
            // These CLIs don't understand the sentinel protocol
            await new Promise(r => setTimeout(r, 4000));
            // Gemini shows a "Trust folder?" dialog before accepting input — send '1' to trust
            if (agentType === 'gemini') {
                await sendToWorker(session.sessionName, paneId, '1');
                await new Promise(r => setTimeout(r, 800));
            }
            // Deliver full task via inbox file to avoid 200-char tmux limit.
            // Non-Claude CLIs (codex/gemini) don't understand 'check-inbox' protocol,
            // so we write to the inbox file and send a natural-language read trigger.
            const task = tasks[i] ?? tasks[0];
            if (task) {
                const taskId = String(i + 1);
                const instruction = buildInitialTaskInstruction(teamName, wName, task, taskId);
                const inboxPath = join(cwd, `.omc/state/team/${teamName}/workers/${wName}/inbox.md`);
                await appendFile(inboxPath, `\n\n---\n${instruction}\n_queued: ${new Date().toISOString()}_\n`, 'utf-8');
                const relPath = `.omc/state/team/${teamName}/workers/${wName}/inbox.md`;
                await sendToWorker(session.sessionName, paneId, `Read and execute your task from: ${relPath}`);
            }
        }
    }));
    // Start watchdog for non-Claude CLI workers
    const hasCliWorkers = agentTypes.some(t => t !== 'claude');
    let stopWatchdog;
    if (hasCliWorkers) {
        stopWatchdog = watchdogCliWorkers(teamName, workerNames, agentTypes, cwd, 3000, async (event) => {
            // Inject completion message into leader pane
            const msg = `[${event.workerName} ${event.status}] ${event.summary}`;
            const ok = await injectToLeaderPane(session.sessionName, session.leaderPaneId, msg);
            if (!ok) {
                console.warn(`[watchdog] Failed to inject completion message for ${event.workerName}`);
            }
            // Update task file status
            const taskPath = join(root, 'tasks', `${event.taskId}.json`);
            const task = await readJsonSafe(taskPath);
            if (task && task.status !== 'completed') {
                task.status = event.status === 'completed' ? 'completed' : 'failed';
                task.result = event.summary;
                task.completedAt = new Date().toISOString();
                await writeJson(taskPath, task);
            }
        });
    }
    return {
        teamName,
        sessionName: session.sessionName,
        leaderPaneId: session.leaderPaneId,
        config,
        workerNames,
        workerPaneIds: session.workerPaneIds,
        cwd,
        stopWatchdog,
    };
}
/**
 * Monitor team: poll worker health, detect stalls, return snapshot.
 */
export async function monitorTeam(teamName, cwd, workerPaneIds) {
    const root = stateRoot(cwd, teamName);
    // Read task counts
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
    // Check worker health
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
        if (stalled)
            console.warn(`[runtime] Worker ${wName} appears stalled (no heartbeat for 60s)`);
    }
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
    return { teamName, phase, workers, taskCounts, deadWorkers };
}
/**
 * Poll for CLI worker completion via done.json sentinel files.
 * Skips Claude workers (they use the sentinel/.ready protocol).
 * Returns a stop function that clears the interval.
 */
export function watchdogCliWorkers(teamName, workerNames, agentTypes, cwd, intervalMs, onComplete) {
    const processed = new Set();
    const tick = async () => {
        for (let i = 0; i < workerNames.length; i++) {
            const wName = workerNames[i];
            const agentType = agentTypes[i] ?? agentTypes[0];
            if (agentType === 'claude')
                continue;
            if (processed.has(wName))
                continue;
            const donePath = join(stateRoot(cwd, teamName), 'workers', wName, 'done.json');
            const signal = await readJsonSafe(donePath);
            if (!signal)
                continue;
            // Add to processed FIRST to prevent re-processing
            processed.add(wName);
            // Delete done.json so it is not processed again
            try {
                const { unlink } = await import('fs/promises');
                await unlink(donePath);
            }
            catch {
                // Already deleted or never existed — OK
            }
            // Call onComplete wrapped in try/catch to prevent watchdog crash
            try {
                await onComplete({
                    workerName: wName,
                    taskId: signal.taskId,
                    status: signal.status,
                    summary: signal.summary,
                });
            }
            catch (err) {
                console.warn(`[watchdog] onComplete error for ${wName}:`, err);
            }
        }
    };
    const intervalId = setInterval(() => { tick().catch(err => console.warn('[watchdog] tick error:', err)); }, intervalMs);
    return () => clearInterval(intervalId);
}
/**
 * Assign a task to a specific worker via inbox + tmux trigger.
 */
export async function assignTask(teamName, taskId, targetWorkerName, paneId, sessionName, cwd) {
    const root = stateRoot(cwd, teamName);
    const taskPath = join(root, 'tasks', `${taskId}.json`);
    // Update task ownership atomically (using file write — task-file-ops withTaskLock not directly applicable here)
    const task = await readJsonSafe(taskPath);
    if (task) {
        task.owner = targetWorkerName;
        task.status = 'in_progress';
        task.assignedAt = new Date().toISOString();
        await writeJson(taskPath, task);
    }
    // Write to worker inbox
    const inboxPath = join(root, 'workers', targetWorkerName, 'inbox.md');
    await mkdir(join(inboxPath, '..'), { recursive: true });
    const msg = `\n\n---\n## New Task Assignment\nTask ID: ${taskId}\nClaim and execute task from: .omc/state/team/${teamName}/tasks/${taskId}.json\n`;
    const { appendFile } = await import('fs/promises');
    await appendFile(inboxPath, msg, 'utf-8');
    // Send tmux trigger
    await sendToWorker(sessionName, paneId, `new-task:${taskId}`);
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
    // Poll for ACK files (timeout 30s)
    const deadline = Date.now() + timeoutMs;
    const configData = await readJsonSafe(join(root, 'config.json'));
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
    return {
        teamName,
        sessionName: sName,
        leaderPaneId: allPanes[0] ?? '',
        config: configData,
        workerNames,
        workerPaneIds,
        cwd,
    };
}
//# sourceMappingURL=runtime.js.map