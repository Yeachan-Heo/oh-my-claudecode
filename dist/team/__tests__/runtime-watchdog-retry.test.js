import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DEFAULT_MAX_TASK_RETRIES, readTaskFailure, writeTaskFailure } from '../task-file-ops.js';
let watchdogCliWorkers;
const tmuxMocks = vi.hoisted(() => ({
    isWorkerAlive: vi.fn(),
    spawnWorkerInPane: vi.fn(),
    sendToWorker: vi.fn(),
}));
const modelContractMocks = vi.hoisted(() => ({
    buildWorkerArgv: vi.fn(() => ['codex']),
    getWorkerEnv: vi.fn(() => ({})),
    isPromptModeAgent: vi.fn(() => true),
    getPromptModeArgs: vi.fn(() => ['-p', 'stub prompt']),
}));
function makeRuntime(cwd, teamName) {
    return {
        teamName,
        sessionName: 'test-session:0',
        leaderPaneId: '%0',
        ownsWindow: false,
        config: {
            teamName,
            workerCount: 1,
            agentTypes: ['codex'],
            tasks: [{ subject: 'Task 1', description: 'Do work' }],
            cwd,
        },
        workerNames: ['worker-1'],
        workerPaneIds: ['%1'],
        activeWorkers: new Map([
            ['worker-1', { paneId: '%1', taskId: '1', spawnedAt: Date.now() }],
        ]),
        cwd,
    };
}
function makeRuntimeWithTask(cwd, teamName, taskId) {
    return {
        teamName,
        sessionName: 'test-session:0',
        leaderPaneId: '%0',
        ownsWindow: false,
        config: {
            teamName,
            workerCount: 1,
            agentTypes: ['codex'],
            tasks: [{ subject: 'Task 1', description: 'Do work' }],
            cwd,
        },
        workerNames: ['worker-1'],
        workerPaneIds: ['%1'],
        activeWorkers: new Map([
            ['worker-1', { paneId: '%1', taskId, spawnedAt: Date.now() }],
        ]),
        cwd,
    };
}
function initTask(cwd, teamName) {
    const root = join(cwd, '.omc', 'state', 'team', teamName);
    mkdirSync(join(root, 'tasks'), { recursive: true });
    mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
    writeFileSync(join(root, 'tasks', '1.json'), JSON.stringify({
        id: '1',
        subject: 'Task 1',
        description: 'Do work',
        status: 'in_progress',
        owner: 'worker-1',
        assignedAt: new Date().toISOString(),
    }), 'utf-8');
    return root;
}
const DEFAULT_WATCHDOG_WAIT_TIMEOUT_MS = 5000;
const WATCHDOG_WAIT_INTERVAL_MS = 20;
function mockWorkerDiesOnceThenAlive() {
    let firstCheck = true;
    tmuxMocks.isWorkerAlive.mockImplementation(async () => {
        if (firstCheck) {
            firstCheck = false;
            return false;
        }
        return true;
    });
}
async function waitFor(predicate, timeoutMs = DEFAULT_WATCHDOG_WAIT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            if (predicate()) {
                return;
            }
        }
        catch {
            // Ignore transient file-read races while the watchdog updates task files.
        }
        await new Promise((resolve) => setTimeout(resolve, WATCHDOG_WAIT_INTERVAL_MS));
    }
    expect(predicate(), 'watchdog condition should become true').toBe(true);
}
async function readJsonFileWithRetry(filePath) {
    let lastError;
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            return JSON.parse(readFileSync(filePath, 'utf-8'));
        }
        catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, WATCHDOG_WAIT_INTERVAL_MS));
        }
    }
    throw lastError;
}
async function stopWatchdogAndSettle(stop) {
    stop();
    await new Promise((resolve) => setTimeout(resolve, WATCHDOG_WAIT_INTERVAL_MS * 3));
}
describe('watchdogCliWorkers dead-pane retry behavior', { timeout: 15000 }, () => {
    let cwd;
    let warnSpy;
    beforeEach(async () => {
        vi.useRealTimers();
        vi.resetModules();
        vi.doUnmock('../tmux-session.js');
        vi.doUnmock('../model-contract.js');
        vi.doUnmock('child_process');
        cwd = mkdtempSync(join(tmpdir(), 'runtime-watchdog-retry-'));
        tmuxMocks.isWorkerAlive.mockReset();
        tmuxMocks.spawnWorkerInPane.mockReset();
        tmuxMocks.sendToWorker.mockReset();
        tmuxMocks.isWorkerAlive.mockResolvedValue(false);
        tmuxMocks.spawnWorkerInPane.mockResolvedValue(undefined);
        tmuxMocks.sendToWorker.mockResolvedValue(true);
        modelContractMocks.buildWorkerArgv.mockReset();
        modelContractMocks.getWorkerEnv.mockReset();
        modelContractMocks.isPromptModeAgent.mockReset();
        modelContractMocks.getPromptModeArgs.mockReset();
        modelContractMocks.buildWorkerArgv.mockReturnValue(['codex']);
        modelContractMocks.getWorkerEnv.mockReturnValue({});
        modelContractMocks.isPromptModeAgent.mockReturnValue(true);
        modelContractMocks.getPromptModeArgs.mockReturnValue(['-p', 'stub prompt']);
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.doMock('../tmux-session.js', async (importOriginal) => {
            const actual = await importOriginal();
            return {
                ...actual,
                isWorkerAlive: tmuxMocks.isWorkerAlive,
                spawnWorkerInPane: tmuxMocks.spawnWorkerInPane,
                sendToWorker: tmuxMocks.sendToWorker,
            };
        });
        vi.doMock('../model-contract.js', async (importOriginal) => {
            const actual = await importOriginal();
            return {
                ...actual,
                buildWorkerArgv: modelContractMocks.buildWorkerArgv,
                getWorkerEnv: modelContractMocks.getWorkerEnv,
                isPromptModeAgent: modelContractMocks.isPromptModeAgent,
                getPromptModeArgs: modelContractMocks.getPromptModeArgs,
            };
        });
        vi.doMock('child_process', async (importOriginal) => {
            const actual = await importOriginal();
            const { promisify: utilPromisify } = await import('util');
            function mockExecFile(_cmd, args, cb) {
                if (args[0] === 'split-window') {
                    cb(null, '%42\n', '');
                    return {};
                }
                cb(null, '', '');
                return {};
            }
            mockExecFile[utilPromisify.custom] = async (_cmd, args) => {
                if (args[0] === 'split-window') {
                    return { stdout: '%42\n', stderr: '' };
                }
                return { stdout: '', stderr: '' };
            };
            return {
                ...actual,
                execFile: mockExecFile,
            };
        });
        ({ watchdogCliWorkers } = await import('../runtime.js'));
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.doUnmock('../tmux-session.js');
        vi.doUnmock('../model-contract.js');
        vi.doUnmock('child_process');
        warnSpy.mockRestore();
        rmSync(cwd, { recursive: true, force: true });
    });
    it('requeues task when dead pane still has retries remaining', async () => {
        mockWorkerDiesOnceThenAlive();
        const teamName = 'dead-pane-requeue-team';
        const root = initTask(cwd, teamName);
        const runtime = makeRuntime(cwd, teamName);
        const stop = watchdogCliWorkers(runtime, 20);
        try {
            await waitFor(() => {
                const retryCount = readTaskFailure(teamName, '1', { cwd })?.retryCount ?? 0;
                const requeueWarned = warnSpy.mock.calls.some(([msg]) => (String(msg).includes('dead pane — requeuing task 1 (retry 1/5)')));
                return retryCount >= 1 && requeueWarned;
            }, 2000);
        }
        finally {
            await stopWatchdogAndSettle(stop);
        }
        const task = await readJsonFileWithRetry(join(root, 'tasks', '1.json'));
        const failure = readTaskFailure(teamName, '1', { cwd });
        expect(['pending', 'in_progress']).toContain(task.status);
        expect(task.owner === null || task.owner === 'worker-1').toBe(true);
        expect(failure?.retryCount).toBe(1);
        expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('dead pane — requeuing task 1 (retry 1/5)'))).toBe(true);
    });
    it('multi-task requeue: nextPendingTaskIndex picks requeued task, not a different pending task', async () => {
        mockWorkerDiesOnceThenAlive();
        const teamName = 'multi-task-requeue-team';
        const root = join(cwd, '.omc', 'state', 'team', teamName);
        mkdirSync(join(root, 'tasks'), { recursive: true });
        mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
        // Task 1: in_progress, assigned to worker-1 (will be requeued when pane dies)
        writeFileSync(join(root, 'tasks', '1.json'), JSON.stringify({
            id: '1',
            subject: 'Task 1',
            description: 'First task',
            status: 'in_progress',
            owner: 'worker-1',
            assignedAt: new Date().toISOString(),
        }), 'utf-8');
        // Task 2: already completed — should NOT be picked up
        writeFileSync(join(root, 'tasks', '2.json'), JSON.stringify({
            id: '2',
            subject: 'Task 2',
            description: 'Second task',
            status: 'completed',
            owner: 'worker-2',
            completedAt: new Date().toISOString(),
        }), 'utf-8');
        // Task 3: pending — this exists but task 1 should be requeued and picked first
        writeFileSync(join(root, 'tasks', '3.json'), JSON.stringify({
            id: '3',
            subject: 'Task 3',
            description: 'Third task',
            status: 'pending',
            owner: null,
        }), 'utf-8');
        const runtime = {
            teamName,
            sessionName: 'test-session:0',
            leaderPaneId: '%0',
            ownsWindow: false,
            config: {
                teamName,
                workerCount: 1,
                agentTypes: ['codex'],
                tasks: [
                    { subject: 'Task 1', description: 'First task' },
                    { subject: 'Task 2', description: 'Second task' },
                    { subject: 'Task 3', description: 'Third task' },
                ],
                cwd,
            },
            workerNames: ['worker-1'],
            workerPaneIds: ['%1'],
            activeWorkers: new Map([
                ['worker-1', { paneId: '%1', taskId: '1', spawnedAt: Date.now() }],
            ]),
            cwd,
        };
        const stop = watchdogCliWorkers(runtime, 20);
        try {
            await waitFor(() => {
                const retryCount = readTaskFailure(teamName, '1', { cwd })?.retryCount ?? 0;
                const task1 = JSON.parse(readFileSync(join(root, 'tasks', '1.json'), 'utf-8'));
                const task3 = JSON.parse(readFileSync(join(root, 'tasks', '3.json'), 'utf-8'));
                return retryCount >= 1
                    && task1.status === 'in_progress'
                    && task1.owner === 'worker-1'
                    && task3.status === 'pending'
                    && task3.owner === null;
            });
        }
        finally {
            await stopWatchdogAndSettle(stop);
        }
        // After requeue, task 1 should be pending (requeued) and task 3 stays pending.
        // nextPendingTaskIndex iterates by index, so task 1 (index 0) is picked first.
        // The spawnWorkerInPane call confirms a respawn happened.
        // The task that got re-assigned should be task 1 (not task 3),
        // because nextPendingTaskIndex scans from index 0 and task 1 was requeued to pending.
        const task1 = await readJsonFileWithRetry(join(root, 'tasks', '1.json'));
        // Task 1 should have been requeued, and may be immediately re-assigned depending on environment timing.
        expect(['pending', 'in_progress']).toContain(task1.status);
        expect(task1.owner === null || task1.owner === 'worker-1').toBe(true);
        // Task 3 should still be pending and unowned — it was NOT the one picked
        const task3 = await readJsonFileWithRetry(join(root, 'tasks', '3.json'));
        expect(task3.status).toBe('pending');
        expect(task3.owner).toBeNull();
    });
    it('permanently fails task when dead pane exhausts retry budget', async () => {
        const teamName = 'dead-pane-exhausted-team';
        const root = initTask(cwd, teamName);
        for (let i = 0; i < DEFAULT_MAX_TASK_RETRIES - 1; i++) {
            writeTaskFailure(teamName, '1', `pre-error-${i}`, { cwd });
        }
        const runtime = makeRuntime(cwd, teamName);
        const stop = watchdogCliWorkers(runtime, 20);
        try {
            await waitFor(() => runtime.activeWorkers.size === 0);
        }
        finally {
            await stopWatchdogAndSettle(stop);
        }
        const task = await readJsonFileWithRetry(join(root, 'tasks', '1.json'));
        const failure = readTaskFailure(teamName, '1', { cwd });
        expect(task.status).toBe('failed');
        expect(task.summary).toContain('Worker pane died before done.json was written');
        expect(failure?.retryCount).toBe(DEFAULT_MAX_TASK_RETRIES);
        expect(tmuxMocks.spawnWorkerInPane).not.toHaveBeenCalled();
    });
    it('serializes concurrent dead-pane retries across watchdog instances', async () => {
        mockWorkerDiesOnceThenAlive();
        const teamName = 'dead-pane-contention-team';
        const root = initTask(cwd, teamName);
        const runtimeA = makeRuntime(cwd, teamName);
        const runtimeB = makeRuntime(cwd, teamName);
        const stopA = watchdogCliWorkers(runtimeA, 20);
        const stopB = watchdogCliWorkers(runtimeB, 20);
        try {
            await waitFor(() => (readTaskFailure(teamName, '1', { cwd })?.retryCount ?? 0) >= 1);
        }
        finally {
            await Promise.all([
                stopWatchdogAndSettle(stopA),
                stopWatchdogAndSettle(stopB),
            ]);
        }
        // Give the second watchdog one more tick to observe the settled state.
        await new Promise(resolve => setTimeout(resolve, 80));
        const task = await readJsonFileWithRetry(join(root, 'tasks', '1.json'));
        const failure = readTaskFailure(teamName, '1', { cwd });
        expect(['pending', 'in_progress']).toContain(task.status);
        expect(task.owner === null || task.owner === 'worker-1').toBe(true);
        expect(failure?.retryCount).toBe(1);
    });
    it('does not requeue or increment retries when dead-pane detection races with completion', async () => {
        const teamName = 'dead-pane-completed-race-team';
        const root = join(cwd, '.omc', 'state', 'team', teamName);
        mkdirSync(join(root, 'tasks'), { recursive: true });
        mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
        writeFileSync(join(root, 'tasks', '1.json'), JSON.stringify({
            id: '1',
            subject: 'Task 1',
            description: 'Do work',
            status: 'completed',
            owner: 'worker-1',
            summary: 'already completed elsewhere',
            result: 'already completed elsewhere',
            completedAt: new Date().toISOString(),
        }), 'utf-8');
        const runtime = makeRuntimeWithTask(cwd, teamName, '1');
        const stop = watchdogCliWorkers(runtime, 20);
        try {
            await waitFor(() => runtime.activeWorkers.size === 0);
        }
        finally {
            await stopWatchdogAndSettle(stop);
        }
        const task = await readJsonFileWithRetry(join(root, 'tasks', '1.json'));
        const failure = readTaskFailure(teamName, '1', { cwd });
        expect(task.status).toBe('completed');
        expect(task.owner).toBe('worker-1');
        expect(task.summary).toBe('already completed elsewhere');
        expect(task.completedAt).toBeTruthy();
        expect(failure).toBeNull();
        expect(tmuxMocks.spawnWorkerInPane).not.toHaveBeenCalled();
        expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('dead pane — requeuing task'))).toBe(false);
    });
    it('does not requeue or increment retries when dead-pane worker no longer owns the task', async () => {
        const teamName = 'dead-pane-owner-race-team';
        const root = join(cwd, '.omc', 'state', 'team', teamName);
        mkdirSync(join(root, 'tasks'), { recursive: true });
        mkdirSync(join(root, 'workers', 'worker-1'), { recursive: true });
        writeFileSync(join(root, 'tasks', '1.json'), JSON.stringify({
            id: '1',
            subject: 'Task 1',
            description: 'Do work',
            status: 'in_progress',
            owner: 'worker-2',
            assignedAt: new Date().toISOString(),
        }), 'utf-8');
        const runtime = makeRuntimeWithTask(cwd, teamName, '1');
        const stop = watchdogCliWorkers(runtime, 20);
        try {
            await waitFor(() => runtime.activeWorkers.size === 0);
        }
        finally {
            await stopWatchdogAndSettle(stop);
        }
        const task = await readJsonFileWithRetry(join(root, 'tasks', '1.json'));
        const failure = readTaskFailure(teamName, '1', { cwd });
        expect(task.status).toBe('in_progress');
        expect(task.owner).toBe('worker-2');
        expect(failure).toBeNull();
        expect(tmuxMocks.spawnWorkerInPane).not.toHaveBeenCalled();
        expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('dead pane — requeuing task'))).toBe(false);
    });
});
//# sourceMappingURL=runtime-watchdog-retry.test.js.map