import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
const fsPromisesControl = vi.hoisted(() => ({
    renameHook: undefined,
    taskTargetWriteFileCalls: 0,
    taskTargetPath: undefined,
}));
const historicalDirectWriteControl = vi.hoisted(() => ({
    taskTargetPath: undefined,
    signalTruncation: undefined,
    awaitRelease: undefined,
}));
vi.mock('fs/promises', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        writeFile: async (path, data, options) => {
            if (path === fsPromisesControl.taskTargetPath) {
                fsPromisesControl.taskTargetWriteFileCalls++;
                throw new Error('direct task-target writeFile publication is forbidden');
            }
            await actual.writeFile(path, data, options);
        },
        rename: async (from, to) => {
            await fsPromisesControl.renameHook?.(from, to);
            await actual.rename(from, to);
        },
    };
});
import { join } from 'path';
import { tmpdir } from 'os';
import { watchdogCliWorkers } from '../runtime.js';
import { DEFAULT_MAX_TASK_RETRIES, readTaskFailure, writeTaskFailure } from '../task-file-ops.js';
const tmuxMocks = vi.hoisted(() => ({
    isWorkerAlive: vi.fn(),
    spawnWorkerInPane: vi.fn(),
    sendToWorker: vi.fn(),
    splitTeamWorkerPane: vi.fn(),
    killTeamPane: vi.fn(),
    applyMainVerticalLayout: vi.fn(),
}));
const modelContractMocks = vi.hoisted(() => ({
    buildWorkerArgv: vi.fn(() => ['codex']),
    getWorkerEnv: vi.fn(() => ({})),
    isPromptModeAgent: vi.fn(() => true),
    getPromptModeArgs: vi.fn(() => ['-p', 'stub prompt']),
    resolveValidatedBinaryPath: vi.fn(() => '/usr/bin/codex'),
}));
vi.mock('../tmux-session.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isWorkerAlive: tmuxMocks.isWorkerAlive,
    spawnWorkerInPane: tmuxMocks.spawnWorkerInPane,
    sendToWorker: tmuxMocks.sendToWorker,
    splitTeamWorkerPane: tmuxMocks.splitTeamWorkerPane,
    killTeamPane: tmuxMocks.killTeamPane,
    applyMainVerticalLayout: tmuxMocks.applyMainVerticalLayout,
}));
vi.mock('../model-contract.js', async (importOriginal) => ({
    ...(await importOriginal()),
    buildWorkerArgv: modelContractMocks.buildWorkerArgv,
    getWorkerEnv: modelContractMocks.getWorkerEnv,
    isPromptModeAgent: modelContractMocks.isPromptModeAgent,
    getPromptModeArgs: modelContractMocks.getPromptModeArgs,
    resolveValidatedBinaryPath: modelContractMocks.resolveValidatedBinaryPath,
}));
function deferred() {
    let resolve;
    return { promise: new Promise(done => { resolve = done; }), resolve };
}
function makeRuntime(cwd, teamName, tasks = [{ subject: 'Task 1', description: 'Do work' }]) {
    return {
        teamName,
        sessionName: 'test-session:0',
        leaderPaneId: '%0',
        ownsWindow: false,
        config: { teamName, workerCount: 1, agentTypes: ['codex'], tasks, cwd },
        workerNames: ['worker-1'],
        workerPaneIds: ['%1'],
        activeWorkers: new Map([['worker-1', { paneId: '%1', taskId: '1', spawnedAt: Date.now() }]]),
        cwd,
    };
}
function initTask(cwd, teamName, task = {}) {
    const root = join(cwd, '.omc', 'state', 'team', teamName);
    mkdirSync(join(root, 'tasks'), { recursive: true });
    mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
    writeFileSync(join(root, 'tasks', '1.json'), JSON.stringify({
        id: '1', subject: 'Task 1', description: 'Do work', status: 'in_progress', owner: 'worker-1',
        assignedAt: new Date().toISOString(), ...task,
    }));
    return root;
}
async function runTick() {
    await vi.advanceTimersByTimeAsync(20);
}
describe('watchdogCliWorkers dead-pane retry behavior', () => {
    let cwd;
    let warnSpy;
    beforeEach(() => {
        vi.useRealTimers();
        cwd = mkdtempSync(join(tmpdir(), 'runtime-watchdog-retry-'));
        tmuxMocks.isWorkerAlive.mockReset().mockResolvedValue(false);
        tmuxMocks.spawnWorkerInPane.mockReset().mockResolvedValue(undefined);
        tmuxMocks.sendToWorker.mockReset().mockResolvedValue(true);
        tmuxMocks.splitTeamWorkerPane.mockReset().mockResolvedValue('%42');
        tmuxMocks.killTeamPane.mockReset().mockResolvedValue(undefined);
        tmuxMocks.applyMainVerticalLayout.mockReset().mockResolvedValue(undefined);
        modelContractMocks.buildWorkerArgv.mockReset().mockReturnValue(['codex']);
        modelContractMocks.getWorkerEnv.mockReset().mockReturnValue({});
        modelContractMocks.isPromptModeAgent.mockReset().mockReturnValue(true);
        modelContractMocks.getPromptModeArgs.mockReset().mockReturnValue(['-p', 'stub prompt']);
        modelContractMocks.resolveValidatedBinaryPath.mockReset().mockReturnValue('/usr/bin/codex');
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.useFakeTimers();
    });
    afterEach(() => {
        fsPromisesControl.renameHook = undefined;
        fsPromisesControl.taskTargetPath = undefined;
        fsPromisesControl.taskTargetWriteFileCalls = 0;
        historicalDirectWriteControl.taskTargetPath = undefined;
        historicalDirectWriteControl.signalTruncation = undefined;
        historicalDirectWriteControl.awaitRelease = undefined;
        warnSpy.mockRestore();
        vi.useRealTimers();
        vi.doUnmock('../lib/atomic-write.js');
        rmSync(cwd, { recursive: true, force: true });
    });
    it('requeues once with the established five-retry budget', async () => {
        const teamName = 'dead-pane-requeue-team';
        const root = initTask(cwd, teamName);
        const stop = watchdogCliWorkers(makeRuntime(cwd, teamName), 20);
        await runTick();
        await stop();
        const task = JSON.parse(readFileSync(join(root, 'tasks', '1.json'), 'utf8'));
        expect(['pending', 'in_progress']).toContain(task.status);
        expect(task.owner === null || task.owner === 'worker-1').toBe(true);
        expect(readTaskFailure(teamName, '1', { cwd })?.retryCount).toBe(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dead pane — requeuing task 1 (retry 1/5)'));
    });
    it('reassigns the requeued first task before a later pending task', async () => {
        const teamName = 'multi-task-requeue-team';
        const root = initTask(cwd, teamName);
        writeFileSync(join(root, 'tasks', '2.json'), JSON.stringify({ id: '2', subject: 'Task 2', description: 'Done', status: 'completed', owner: 'worker-2' }));
        writeFileSync(join(root, 'tasks', '3.json'), JSON.stringify({ id: '3', subject: 'Task 3', description: 'Later', status: 'pending', owner: null }));
        const runtime = makeRuntime(cwd, teamName, [
            { subject: 'Task 1', description: 'Do work' }, { subject: 'Task 2', description: 'Done' }, { subject: 'Task 3', description: 'Later' },
        ]);
        const stop = watchdogCliWorkers(runtime, 20);
        await runTick();
        await stop();
        const task1 = JSON.parse(readFileSync(join(root, 'tasks', '1.json'), 'utf8'));
        const task3 = JSON.parse(readFileSync(join(root, 'tasks', '3.json'), 'utf8'));
        expect(['pending', 'in_progress']).toContain(task1.status);
        expect(task1.owner === null || task1.owner === 'worker-1').toBe(true);
        expect(task3).toMatchObject({ status: 'pending', owner: null });
    });
    it('fails a dead pane task at the unchanged retry limit', async () => {
        const teamName = 'dead-pane-exhausted-team';
        const root = initTask(cwd, teamName);
        for (let i = 0; i < DEFAULT_MAX_TASK_RETRIES - 1; i++)
            writeTaskFailure(teamName, '1', `pre-error-${i}`, { cwd });
        const runtime = makeRuntime(cwd, teamName);
        const stop = watchdogCliWorkers(runtime, 20);
        await runTick();
        await stop();
        const task = JSON.parse(readFileSync(join(root, 'tasks', '1.json'), 'utf8'));
        expect(task.status).toBe('failed');
        expect(task.summary).toContain('Worker pane died before done.json was written');
        expect(readTaskFailure(teamName, '1', { cwd })?.retryCount).toBe(DEFAULT_MAX_TASK_RETRIES);
        expect(tmuxMocks.spawnWorkerInPane).not.toHaveBeenCalled();
    });
    it('serializes concurrent watchdog retries for the same task', async () => {
        const teamName = 'dead-pane-contention-team';
        const root = initTask(cwd, teamName);
        const stopA = watchdogCliWorkers(makeRuntime(cwd, teamName), 20);
        const stopB = watchdogCliWorkers(makeRuntime(cwd, teamName), 20);
        await runTick();
        await Promise.all([stopA(), stopB()]);
        const task = JSON.parse(readFileSync(join(root, 'tasks', '1.json'), 'utf8'));
        expect(['pending', 'in_progress']).toContain(task.status);
        expect(task.owner === null || task.owner === 'worker-1').toBe(true);
        expect(readTaskFailure(teamName, '1', { cwd })?.retryCount).toBe(1);
    });
    it('keeps completion and owner-transfer guards ahead of retry recovery', async () => {
        const teamName = 'dead-pane-guards-team';
        const root = initTask(cwd, teamName, { status: 'completed', summary: 'done elsewhere' });
        const runtime = makeRuntime(cwd, teamName);
        const stop = watchdogCliWorkers(runtime, 20);
        await runTick();
        await stop();
        expect(JSON.parse(readFileSync(join(root, 'tasks', '1.json'), 'utf8'))).toMatchObject({ status: 'completed', summary: 'done elsewhere' });
        expect(readTaskFailure(teamName, '1', { cwd })).toBeNull();
        writeFileSync(join(root, 'tasks', '1.json'), JSON.stringify({ id: '1', subject: 'Task 1', description: 'Do work', status: 'in_progress', owner: 'worker-2' }));
        const ownerStop = watchdogCliWorkers(makeRuntime(cwd, teamName), 20);
        await runTick();
        await ownerStop();
        expect(JSON.parse(readFileSync(join(root, 'tasks', '1.json'), 'utf8'))).toMatchObject({ status: 'in_progress', owner: 'worker-2' });
        expect(readTaskFailure(teamName, '1', { cwd })).toBeNull();
    });
    it('keeps a mutating dead-pane tick alive until every retry effect completes', async () => {
        const teamName = 'watchdog-stop-quiescence-team';
        const root = initTask(cwd, teamName);
        const taskPath = join(root, 'tasks', '1.json');
        const runtime = makeRuntime(cwd, teamName);
        const spawnEntered = deferred();
        const releaseSpawn = deferred();
        tmuxMocks.spawnWorkerInPane.mockImplementationOnce(async (_sessionName, paneId) => {
            expect(paneId).toBe('%42');
            spawnEntered.resolve();
            await releaseSpawn.promise;
        });
        const stop = watchdogCliWorkers(runtime, 20);
        vi.advanceTimersByTime(20);
        let stopResolved = false;
        try {
            await spawnEntered.promise;
            const stopping = stop().then(() => { stopResolved = true; });
            await Promise.resolve();
            expect(stopResolved).toBe(false);
            expect(JSON.parse(readFileSync(taskPath, 'utf8'))).toMatchObject({ status: 'in_progress', owner: 'worker-1' });
            expect(readTaskFailure(teamName, '1', { cwd })).toMatchObject({ retryCount: 1 });
            expect(runtime.workerPaneIds).toEqual([]);
            expect(runtime.activeWorkers.size).toBe(0);
            releaseSpawn.resolve();
            await stopping;
            const snapshot = {
                task: readFileSync(taskPath, 'utf8'),
                sidecar: readTaskFailure(teamName, '1', { cwd }),
                workerPaneIds: [...runtime.workerPaneIds],
                activeWorkers: [...runtime.activeWorkers.entries()],
                warnings: warnSpy.mock.calls.length,
            };
            expect(JSON.parse(snapshot.task)).toMatchObject({ status: 'in_progress', owner: 'worker-1' });
            expect(snapshot.sidecar).toMatchObject({ retryCount: 1 });
            expect(tmuxMocks.splitTeamWorkerPane).toHaveBeenCalledWith('%0', 'right', cwd);
            expect(tmuxMocks.spawnWorkerInPane).toHaveBeenCalledTimes(1);
            expect(snapshot.workerPaneIds).toEqual(['%42']);
            expect(snapshot.activeWorkers).toHaveLength(1);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dead pane — requeuing task 1 (retry 1/5)'));
            await vi.advanceTimersByTimeAsync(100);
            expect({
                task: readFileSync(taskPath, 'utf8'),
                sidecar: readTaskFailure(teamName, '1', { cwd }),
                workerPaneIds: [...runtime.workerPaneIds],
                activeWorkers: [...runtime.activeWorkers.entries()],
                warnings: warnSpy.mock.calls.length,
            }).toEqual(snapshot);
        }
        finally {
            releaseSpawn.resolve();
            await stop();
        }
    });
    it('keeps the previous task JSON parseable until atomic task publication', async () => {
        const teamName = 'watchdog-atomic-publication-team';
        const root = initTask(cwd, teamName);
        const taskPath = join(root, 'tasks', '1.json');
        const oldTask = JSON.parse(readFileSync(taskPath, 'utf8'));
        const renameEntered = deferred();
        const releaseRename = deferred();
        fsPromisesControl.taskTargetPath = taskPath;
        fsPromisesControl.renameHook = async (_from, to) => {
            if (to === taskPath) {
                renameEntered.resolve();
                await releaseRename.promise;
            }
        };
        const stop = watchdogCliWorkers(makeRuntime(cwd, teamName), 20);
        vi.advanceTimersByTime(20);
        try {
            await renameEntered.promise;
            expect(JSON.parse(readFileSync(taskPath, 'utf8'))).toEqual(oldTask);
        }
        finally {
            releaseRename.resolve();
        }
        await stop();
        const task = JSON.parse(readFileSync(taskPath, 'utf8'));
        expect(task).toMatchObject({ status: 'in_progress', owner: 'worker-1' });
        expect(readTaskFailure(teamName, '1', { cwd })).toMatchObject({ retryCount: 1 });
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dead pane — requeuing task 1 (retry 1/5)'));
        expect(fsPromisesControl.taskTargetWriteFileCalls).toBe(0);
    });
    it('reproduces the historical direct-write parse failure as a controlled baseline', async () => {
        const teamName = 'watchdog-historical-direct-write-team';
        const root = initTask(cwd, teamName);
        const taskPath = join(root, 'tasks', '1.json');
        const truncated = deferred();
        const releaseDirectWrite = deferred();
        historicalDirectWriteControl.taskTargetPath = taskPath;
        historicalDirectWriteControl.signalTruncation = truncated.resolve;
        historicalDirectWriteControl.awaitRelease = () => releaseDirectWrite.promise;
        // This isolated mock models the rejected direct visible-target publication,
        // not the production atomic writer covered by the neighboring green test.
        vi.resetModules();
        vi.doMock('../../lib/atomic-write.js', async (importOriginal) => {
            const actual = await importOriginal();
            return {
                ...actual,
                atomicWriteJson: async (filePath, data) => {
                    if (filePath !== historicalDirectWriteControl.taskTargetPath) {
                        await actual.atomicWriteJson(filePath, data);
                        return;
                    }
                    const content = JSON.stringify(data, null, 2);
                    writeFileSync(filePath, '', 'utf8');
                    historicalDirectWriteControl.signalTruncation?.();
                    await historicalDirectWriteControl.awaitRelease?.();
                    writeFileSync(filePath, content, 'utf8');
                },
            };
        });
        let stop;
        try {
            const { watchdogCliWorkers: historicalWatchdogCliWorkers } = await import('../runtime.js');
            stop = historicalWatchdogCliWorkers(makeRuntime(cwd, teamName), 20);
            vi.advanceTimersByTime(20);
            await truncated.promise;
            let parseError;
            try {
                JSON.parse(readFileSync(taskPath, 'utf8'));
            }
            catch (error) {
                parseError = error;
            }
            expect(parseError).toBeInstanceOf(SyntaxError);
            expect(parseError.message).toBe('Unexpected end of JSON input');
        }
        finally {
            releaseDirectWrite.resolve();
            await stop?.();
            vi.doUnmock('../../lib/atomic-write.js');
            vi.resetModules();
        }
    });
});
//# sourceMappingURL=runtime-watchdog-retry.test.js.map