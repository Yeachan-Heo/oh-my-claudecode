import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { listDispatchRequests } from '../dispatch-queue.js';
const mocks = vi.hoisted(() => ({
    createTeamSession: vi.fn(),
    spawnWorkerInPane: vi.fn(),
    sendToWorker: vi.fn(),
    waitForPaneReady: vi.fn(),
    execFile: vi.fn(),
}));
vi.mock('child_process', () => ({
    execFile: mocks.execFile,
}));
vi.mock('../model-contract.js', () => ({
    buildWorkerArgv: vi.fn(() => ['/usr/bin/claude']),
    resolveValidatedBinaryPath: vi.fn(() => '/usr/bin/claude'),
    getWorkerEnv: vi.fn(() => ({ OMC_TEAM_WORKER: 'dispatch-team/worker-1' })),
    isPromptModeAgent: vi.fn(() => false),
    getPromptModeArgs: vi.fn(() => []),
}));
vi.mock('../tmux-session.js', () => ({
    createTeamSession: mocks.createTeamSession,
    spawnWorkerInPane: mocks.spawnWorkerInPane,
    sendToWorker: mocks.sendToWorker,
    waitForPaneReady: mocks.waitForPaneReady,
}));
describe('runtime v2 startup inbox dispatch', () => {
    let cwd;
    beforeEach(() => {
        vi.resetModules();
        mocks.createTeamSession.mockReset();
        mocks.spawnWorkerInPane.mockReset();
        mocks.sendToWorker.mockReset();
        mocks.waitForPaneReady.mockReset();
        mocks.execFile.mockReset();
        mocks.createTeamSession.mockResolvedValue({
            sessionName: 'dispatch-session',
            leaderPaneId: '%1',
            workerPaneIds: [],
            sessionMode: 'split-pane',
        });
        mocks.spawnWorkerInPane.mockResolvedValue(undefined);
        mocks.waitForPaneReady.mockResolvedValue(true);
        mocks.sendToWorker.mockResolvedValue(true);
        mocks.execFile.mockImplementation((file, args, cb) => {
            if (args[0] === 'split-window') {
                cb(null, '%2\n', '');
                return;
            }
            cb(null, '', '');
        });
        mocks.execFile[promisify.custom] = async (_file, args) => {
            if (args[0] === 'split-window') {
                return { stdout: '%2\n', stderr: '' };
            }
            return { stdout: '', stderr: '' };
        };
    });
    afterEach(async () => {
        if (cwd)
            await rm(cwd, { recursive: true, force: true });
    });
    it('writes durable inbox dispatch evidence when startup worker notification succeeds', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-dispatch-'));
        const { startTeamV2 } = await import('../runtime-v2.js');
        const runtime = await startTeamV2({
            teamName: 'dispatch-team',
            workerCount: 1,
            agentTypes: ['claude'],
            tasks: [{ subject: 'Dispatch test', description: 'Verify startup dispatch evidence' }],
            cwd,
        });
        expect(runtime.teamName).toBe('dispatch-team');
        expect(mocks.createTeamSession).toHaveBeenCalledWith('dispatch-team', 0, cwd, { newWindow: false });
        const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.to_worker).toBe('worker-1');
        expect(requests[0]?.status).toBe('notified');
        expect(requests[0]?.inbox_correlation_key).toBe('startup:worker-1:1');
        expect(requests[0]?.trigger_message).toContain('.omc/state/team/dispatch-team/workers/worker-1/inbox.md');
        expect(requests[0]?.trigger_message).toContain('start work now');
        const inboxPath = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'workers', 'worker-1', 'inbox.md');
        const inbox = await readFile(inboxPath, 'utf-8');
        expect(inbox).toContain('Dispatch test');
        expect(mocks.sendToWorker).toHaveBeenCalledWith('dispatch-session', '%2', expect.stringContaining('concrete progress'));
        expect(mocks.spawnWorkerInPane).toHaveBeenCalledWith('dispatch-session', '%2', expect.objectContaining({
            envVars: expect.objectContaining({
                OMC_TEAM_WORKER: 'dispatch-team/worker-1',
                OMC_TEAM_STATE_ROOT: join(cwd, '.omc', 'state', 'team', 'dispatch-team'),
                OMC_TEAM_LEADER_CWD: cwd,
            }),
        }));
    });
    it('passes through dedicated-window startup requests', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-new-window-'));
        const { startTeamV2 } = await import('../runtime-v2.js');
        await startTeamV2({
            teamName: 'dispatch-team',
            workerCount: 1,
            agentTypes: ['claude'],
            tasks: [{ subject: 'Dispatch test', description: 'Verify new-window startup wiring' }],
            cwd,
            newWindow: true,
        });
        expect(mocks.createTeamSession).toHaveBeenCalledWith('dispatch-team', 0, cwd, { newWindow: true });
    });
    it('does not auto-kill a worker pane when startup readiness fails', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-no-autokill-ready-'));
        mocks.waitForPaneReady.mockResolvedValue(false);
        const { startTeamV2 } = await import('../runtime-v2.js');
        const runtime = await startTeamV2({
            teamName: 'dispatch-team',
            workerCount: 1,
            agentTypes: ['claude'],
            tasks: [{ subject: 'Dispatch test', description: 'Verify worker pane is preserved for leader cleanup' }],
            cwd,
        });
        expect(runtime.config.workers[0]?.pane_id).toBe('%2');
        expect(runtime.config.workers[0]?.assigned_tasks).toEqual([]);
        expect(mocks.execFile.mock.calls.some((call) => call[1]?.[0] === 'kill-pane')).toBe(false);
    });
    it('does not auto-kill a worker pane when startup notification fails', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-no-autokill-notify-'));
        mocks.sendToWorker.mockResolvedValue(false);
        const { startTeamV2 } = await import('../runtime-v2.js');
        const runtime = await startTeamV2({
            teamName: 'dispatch-team',
            workerCount: 1,
            agentTypes: ['claude'],
            tasks: [{ subject: 'Dispatch test', description: 'Verify notify failure leaves pane for leader action' }],
            cwd,
        });
        expect(runtime.config.workers[0]?.pane_id).toBe('%2');
        expect(runtime.config.workers[0]?.assigned_tasks).toEqual([]);
        expect(mocks.execFile.mock.calls.some((call) => call[1]?.[0] === 'kill-pane')).toBe(false);
        const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.status).toBe('failed');
        expect(requests[0]?.last_reason).toBe('worker_notify_failed');
    });
    it('requires Claude startup evidence beyond the initial notify and retries once before failing', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-claude-evidence-missing-'));
        const { startTeamV2 } = await import('../runtime-v2.js');
        const runtime = await startTeamV2({
            teamName: 'dispatch-team',
            workerCount: 1,
            agentTypes: ['claude'],
            tasks: [{ subject: 'Dispatch test', description: 'Verify Claude startup evidence gate' }],
            cwd,
        });
        expect(runtime.config.workers[0]?.pane_id).toBe('%2');
        expect(runtime.config.workers[0]?.assigned_tasks).toEqual([]);
        expect(mocks.sendToWorker).toHaveBeenCalledTimes(2);
        const requests = await listDispatchRequests('dispatch-team', cwd, { kind: 'inbox' });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.status).toBe('notified');
    });
    it('does not treat ACK-only mailbox replies as Claude startup evidence', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-claude-evidence-ack-'));
        mocks.sendToWorker.mockImplementation(async () => {
            const mailboxDir = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'mailbox');
            await mkdir(mailboxDir, { recursive: true });
            await writeFile(join(mailboxDir, 'leader-fixed.json'), JSON.stringify({
                worker: 'leader-fixed',
                messages: [{
                        message_id: 'msg-1',
                        from_worker: 'worker-1',
                        to_worker: 'leader-fixed',
                        body: 'ACK: worker-1 initialized',
                        created_at: new Date().toISOString(),
                    }],
            }, null, 2), 'utf-8');
            return true;
        });
        const { startTeamV2 } = await import('../runtime-v2.js');
        const runtime = await startTeamV2({
            teamName: 'dispatch-team',
            workerCount: 1,
            agentTypes: ['claude'],
            tasks: [{ subject: 'Dispatch test', description: 'Verify Claude mailbox ack evidence' }],
            cwd,
        });
        expect(runtime.config.workers[0]?.assigned_tasks).toEqual([]);
        expect(mocks.sendToWorker).toHaveBeenCalledTimes(2);
    });
    it('accepts Claude startup once the worker claims the task', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-claude-evidence-claim-'));
        mocks.sendToWorker.mockImplementation(async () => {
            const taskDir = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'tasks');
            const taskPath = join(taskDir, 'task-1.json');
            const existing = JSON.parse(await readFile(taskPath, 'utf-8'));
            await writeFile(taskPath, JSON.stringify({
                ...existing,
                status: 'in_progress',
                owner: 'worker-1',
            }, null, 2), 'utf-8');
            return true;
        });
        const { startTeamV2 } = await import('../runtime-v2.js');
        const runtime = await startTeamV2({
            teamName: 'dispatch-team',
            workerCount: 1,
            agentTypes: ['claude'],
            tasks: [{ subject: 'Dispatch test', description: 'Verify Claude claim evidence' }],
            cwd,
        });
        expect(runtime.config.workers[0]?.assigned_tasks).toEqual(['1']);
        expect(mocks.sendToWorker).toHaveBeenCalledTimes(1);
    });
    it('accepts Claude startup once worker status shows task progress', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-claude-evidence-status-'));
        mocks.sendToWorker.mockImplementation(async () => {
            const workerDir = join(cwd, '.omc', 'state', 'team', 'dispatch-team', 'workers', 'worker-1');
            await mkdir(workerDir, { recursive: true });
            await writeFile(join(workerDir, 'status.json'), JSON.stringify({
                state: 'working',
                current_task_id: '1',
                updated_at: new Date().toISOString(),
            }, null, 2), 'utf-8');
            return true;
        });
        const { startTeamV2 } = await import('../runtime-v2.js');
        const runtime = await startTeamV2({
            teamName: 'dispatch-team',
            workerCount: 1,
            agentTypes: ['claude'],
            tasks: [{ subject: 'Dispatch test', description: 'Verify Claude status evidence' }],
            cwd,
        });
        expect(runtime.config.workers[0]?.assigned_tasks).toEqual(['1']);
        expect(mocks.sendToWorker).toHaveBeenCalledTimes(1);
    });
});
//# sourceMappingURL=runtime-v2.dispatch.test.js.map