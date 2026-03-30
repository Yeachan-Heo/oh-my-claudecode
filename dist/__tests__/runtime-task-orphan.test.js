import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
/**
 * Regression test: when tmux pane creation fails (empty paneId),
 * spawnWorkerForTask must revert the task from in_progress back to pending
 * instead of leaving it orphaned.
 */
// --- Mocks ---
const mockExecFileAsync = vi.fn();
vi.mock('child_process', () => {
    const execFile = Object.assign(vi.fn(), {
        [Symbol.for('nodejs.util.promisify.custom')]: mockExecFileAsync,
    });
    return { execFile };
});
vi.mock('../team/model-contract.js', () => ({
    buildWorkerArgv: vi.fn(() => ['/usr/bin/claude', '--flag']),
    resolveValidatedBinaryPath: vi.fn(() => '/usr/bin/claude'),
    getWorkerEnv: vi.fn(() => ({})),
    isPromptModeAgent: vi.fn(() => false),
    getPromptModeArgs: vi.fn(() => []),
    resolveClaudeWorkerModel: vi.fn(() => undefined),
}));
vi.mock('../team/tmux-session.js', () => ({
    createTeamSession: vi.fn(),
    spawnWorkerInPane: vi.fn(),
    sendToWorker: vi.fn(() => Promise.resolve(true)),
    isWorkerAlive: vi.fn(() => Promise.resolve(true)),
    killTeamSession: vi.fn(),
    resolveSplitPaneWorkerPaneIds: vi.fn(() => []),
    waitForPaneReady: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('../team/worker-bootstrap.js', () => ({
    composeInitialInbox: vi.fn(),
    ensureWorkerStateDir: vi.fn(),
    writeWorkerOverlay: vi.fn(),
    generateTriggerMessage: vi.fn(() => 'trigger'),
}));
vi.mock('../team/git-worktree.js', () => ({
    cleanupTeamWorktrees: vi.fn(),
}));
vi.mock('../team/task-file-ops.js', () => ({
    withTaskLock: vi.fn(async (_team, _taskId, fn) => fn()),
    writeTaskFailure: vi.fn(() => ({ retryCount: 0 })),
    DEFAULT_MAX_TASK_RETRIES: 3,
}));
describe('spawnWorkerForTask task orphan prevention', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'runtime-task-orphan-'));
        mockExecFileAsync.mockReset();
    });
    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });
    it('reverts task to pending when tmux pane creation returns empty paneId', async () => {
        const { spawnWorkerForTask } = await import('../team/runtime.js');
        const teamName = 'testteam';
        const taskIndex = 0;
        const taskId = String(taskIndex + 1);
        // Create task directory and initial task file (status: pending)
        const tasksDir = join(tmpDir, '.omc', 'state', 'team', teamName, 'tasks');
        mkdirSync(tasksDir, { recursive: true });
        writeFileSync(join(tasksDir, `${taskId}.json`), JSON.stringify({
            id: taskId,
            subject: 'Test task',
            description: 'Test description',
            status: 'pending',
            owner: null,
            result: null,
            createdAt: new Date().toISOString(),
        }));
        // Mock tmux split-window to return empty stdout (pane creation failure)
        mockExecFileAsync.mockResolvedValue({ stdout: '\n', stderr: '' });
        const runtime = {
            teamName,
            sessionName: 'test-session',
            leaderPaneId: '%0',
            config: {
                teamName,
                workerCount: 1,
                agentTypes: ['claude'],
                tasks: [{ subject: 'Test task', description: 'Test description' }],
                cwd: tmpDir,
            },
            workerNames: ['worker-1'],
            workerPaneIds: [],
            activeWorkers: new Map(),
            cwd: tmpDir,
            resolvedBinaryPaths: { claude: '/usr/bin/claude' },
        };
        const result = await spawnWorkerForTask(runtime, 'worker-1', taskIndex);
        // Should return empty string (failure indicator)
        expect(result).toBe('');
        // Task must be reverted back to pending (not orphaned as in_progress)
        const taskFile = JSON.parse(readFileSync(join(tasksDir, `${taskId}.json`), 'utf-8'));
        expect(taskFile.status).toBe('pending');
        expect(taskFile.owner).toBeNull();
    });
});
//# sourceMappingURL=runtime-task-orphan.test.js.map