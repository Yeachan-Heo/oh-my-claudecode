/**
 * CLI entry point for team runtime.
 * Reads JSON config from stdin, runs startTeam/monitorTeam/shutdownTeam,
 * writes structured JSON result to stdout.
 *
 * Bundled as CJS via esbuild (scripts/build-runtime-cli.mjs).
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { startTeam, monitorTeam, shutdownTeam } from './runtime.js';
function collectTaskResults(stateRoot) {
    const tasksDir = join(stateRoot, 'tasks');
    try {
        const files = readdirSync(tasksDir).filter(f => f.endsWith('.json'));
        return files.map(f => {
            try {
                const raw = readFileSync(join(tasksDir, f), 'utf-8');
                const task = JSON.parse(raw);
                return {
                    taskId: task.id ?? f.replace('.json', ''),
                    status: task.status ?? 'unknown',
                    summary: (task.result ?? task.summary) ?? '',
                };
            }
            catch {
                return { taskId: f.replace('.json', ''), status: 'unknown', summary: '' };
            }
        });
    }
    catch {
        return [];
    }
}
async function main() {
    const startTime = Date.now();
    // Read stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    const rawInput = Buffer.concat(chunks).toString('utf-8').trim();
    let input;
    try {
        input = JSON.parse(rawInput);
    }
    catch (err) {
        process.stderr.write(`[runtime-cli] Failed to parse stdin JSON: ${err}\n`);
        process.exit(1);
    }
    // Validate required fields
    const missing = [];
    if (!input.teamName)
        missing.push('teamName');
    if (!input.agentTypes || !Array.isArray(input.agentTypes) || input.agentTypes.length === 0)
        missing.push('agentTypes');
    if (!input.tasks || !Array.isArray(input.tasks) || input.tasks.length === 0)
        missing.push('tasks');
    if (!input.cwd)
        missing.push('cwd');
    if (missing.length > 0) {
        process.stderr.write(`[runtime-cli] Missing required fields: ${missing.join(', ')}\n`);
        process.exit(1);
    }
    const { teamName, agentTypes, tasks, cwd, timeoutSeconds = 300, pollIntervalMs = 5000, } = input;
    const workerCount = input.workerCount ?? agentTypes.length;
    const stateRoot = join(cwd, `.omc/state/team/${teamName}`);
    const timeoutMs = timeoutSeconds * 1000;
    const config = {
        teamName,
        workerCount,
        agentTypes: agentTypes,
        tasks,
        cwd,
    };
    let runtime = null;
    let finalStatus = 'timeout';
    let pollActive = true;
    async function doShutdown(status) {
        pollActive = false;
        finalStatus = status;
        // 1. Collect task results before shutdown destroys state
        const taskResults = collectTaskResults(stateRoot);
        // 2. Stop watchdog if running
        if (runtime?.stopWatchdog) {
            runtime.stopWatchdog();
        }
        // 3. Shutdown team with 2s timeout (non-Claude workers never write shutdown-ack.json)
        if (runtime) {
            try {
                await shutdownTeam(runtime.teamName, runtime.sessionName, runtime.cwd, 2_000, runtime.workerPaneIds, runtime.leaderPaneId);
            }
            catch (err) {
                process.stderr.write(`[runtime-cli] shutdownTeam error: ${err}\n`);
            }
        }
        const duration = (Date.now() - startTime) / 1000;
        const output = {
            status: finalStatus,
            teamName,
            taskResults,
            duration,
            workerCount,
        };
        // 4. Write result to stdout
        process.stdout.write(JSON.stringify(output) + '\n');
        // 5. Exit
        process.exit(0);
    }
    // Register signal handlers before poll loop
    process.on('SIGINT', () => {
        process.stderr.write('[runtime-cli] Received SIGINT, shutting down...\n');
        doShutdown('failed').catch(() => process.exit(1));
    });
    process.on('SIGTERM', () => {
        process.stderr.write('[runtime-cli] Received SIGTERM, shutting down...\n');
        doShutdown('failed').catch(() => process.exit(1));
    });
    // Start the team
    try {
        runtime = await startTeam(config);
    }
    catch (err) {
        process.stderr.write(`[runtime-cli] startTeam failed: ${err}\n`);
        process.exit(1);
    }
    // Poll loop
    const deadline = Date.now() + timeoutMs;
    while (pollActive && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollIntervalMs));
        if (!pollActive)
            break;
        let snap;
        try {
            snap = await monitorTeam(teamName, cwd, runtime.workerPaneIds);
        }
        catch (err) {
            process.stderr.write(`[runtime-cli] monitorTeam error: ${err}\n`);
            continue;
        }
        process.stderr.write(`[runtime-cli] phase=${snap.phase} pending=${snap.taskCounts.pending} inProgress=${snap.taskCounts.inProgress} completed=${snap.taskCounts.completed} failed=${snap.taskCounts.failed} dead=${snap.deadWorkers.length}\n`);
        // Check completion
        if (snap.phase === 'completed') {
            await doShutdown('completed');
            return;
        }
        // Check failure heuristics
        const allWorkersDead = snap.deadWorkers.length === runtime.workerPaneIds.length;
        const hasOutstandingWork = (snap.taskCounts.pending + snap.taskCounts.inProgress) > 0;
        const deadWorkerFailure = allWorkersDead && hasOutstandingWork;
        const fixingWithNoWorkers = snap.phase === 'fixing' && allWorkersDead;
        if (deadWorkerFailure || fixingWithNoWorkers) {
            process.stderr.write(`[runtime-cli] Failure detected: deadWorkerFailure=${deadWorkerFailure} fixingWithNoWorkers=${fixingWithNoWorkers}\n`);
            await doShutdown('failed');
            return;
        }
    }
    // Timed out
    if (pollActive) {
        process.stderr.write(`[runtime-cli] Timeout after ${timeoutSeconds}s\n`);
        await doShutdown('timeout');
    }
}
if (require.main === module) {
    main().catch(err => {
        process.stderr.write(`[runtime-cli] Fatal error: ${err}\n`);
        process.exit(1);
    });
}
//# sourceMappingURL=runtime-cli.js.map