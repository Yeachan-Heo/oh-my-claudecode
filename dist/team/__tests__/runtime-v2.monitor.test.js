import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
const mocks = vi.hoisted(() => ({
    getWorkerLiveness: vi.fn(async () => 'alive'),
    execFile: vi.fn(),
    tmuxExecAsync: vi.fn(),
}));
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        execFile: mocks.execFile,
    };
});
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        tmuxExecAsync: mocks.tmuxExecAsync,
    };
});
vi.mock('../tmux-session.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        getWorkerLiveness: mocks.getWorkerLiveness,
    };
});
describe('monitorTeamV2 pane-based stall inference', () => {
    let cwd;
    beforeEach(() => {
        vi.resetModules();
        mocks.getWorkerLiveness.mockReset();
        mocks.execFile.mockReset();
        mocks.tmuxExecAsync.mockReset();
        mocks.getWorkerLiveness.mockResolvedValue('alive');
        mocks.execFile.mockImplementation((_cmd, args, cb) => {
            if (args[0] === 'capture-pane') {
                cb(null, '> \n', '');
                return;
            }
            cb(null, '', '');
        });
        mocks.tmuxExecAsync.mockImplementation(async (args) => {
            if (args[0] === 'capture-pane') {
                return { stdout: '> \n', stderr: '' };
            }
            return { stdout: '', stderr: '' };
        });
    });
    afterEach(async () => {
        if (cwd)
            await rm(cwd, { recursive: true, force: true });
    });
    async function writeConfigAndTask(taskStatus = 'pending') {
        const teamRoot = join(cwd, '.omc', 'state', 'team', 'demo-team');
        await mkdir(join(teamRoot, 'tasks'), { recursive: true });
        await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
        await writeFile(join(teamRoot, 'config.json'), JSON.stringify({
            name: 'demo-team',
            task: 'demo',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            worker_count: 1,
            max_workers: 20,
            workers: [{
                    name: 'worker-1',
                    index: 1,
                    role: 'claude',
                    assigned_tasks: ['1'],
                    pane_id: '%2',
                    working_dir: cwd,
                }],
            created_at: new Date().toISOString(),
            tmux_session: 'demo-session:0',
            leader_pane_id: '%1',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            next_task_id: 2,
            team_state_root: join(cwd, '.omc', 'state', 'team', 'demo-team'),
            workspace_mode: 'single',
        }, null, 2), 'utf-8');
        await writeFile(join(teamRoot, 'tasks', '1.json'), JSON.stringify({
            id: '1',
            subject: 'Demo task',
            description: 'Investigate a worker stall',
            status: taskStatus,
            owner: taskStatus === 'in_progress' ? 'worker-1' : undefined,
            created_at: new Date().toISOString(),
        }, null, 2), 'utf-8');
    }
    it('flags pane-idle workers with assigned work but no work-start evidence', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-monitor-'));
        await writeConfigAndTask('pending');
        const { monitorTeamV2 } = await import('../runtime-v2.js');
        const snapshot = await monitorTeamV2('demo-team', cwd);
        expect(snapshot?.nonReportingWorkers).toContain('worker-1');
        expect(snapshot?.recommendations).toContain('Investigate worker-1: assigned work but no work-start evidence; pane is idle at prompt');
    });
    it('surfaces missing blocker task ids in monitor recommendations', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-monitor-missing-blocker-'));
        await writeConfigAndTask('pending');
        const teamRoot = join(cwd, '.omc', 'state', 'team', 'demo-team');
        await writeFile(join(teamRoot, 'tasks', '1.json'), JSON.stringify({
            id: '1',
            subject: 'Blocked task',
            description: 'Depends on missing task 13',
            status: 'pending',
            owner: 'worker-1',
            blocked_by: ['13'],
            depends_on: ['13'],
            created_at: new Date().toISOString(),
        }, null, 2), 'utf-8');
        const { monitorTeamV2 } = await import('../runtime-v2.js');
        const snapshot = await monitorTeamV2('demo-team', cwd);
        expect(snapshot?.nonReportingWorkers).toContain('worker-1');
        expect(snapshot?.recommendations).toContain('Investigate worker-1: task-1 is blocked by missing task ids [13]; pane is idle at prompt');
        expect(snapshot?.recommendations).toContain('Investigate task-1: depends on missing task ids [13]');
    });
    it('does not flag a worker when pane evidence shows active work despite missing reports', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-monitor-active-'));
        await writeConfigAndTask('in_progress');
        mocks.execFile.mockImplementation((_cmd, args, cb) => {
            if (args[0] === 'capture-pane') {
                cb(null, 'Working on task...\n  esc to interrupt\n', '');
                return;
            }
            cb(null, '', '');
        });
        mocks.tmuxExecAsync.mockImplementation(async (args) => {
            if (args[0] === 'capture-pane') {
                return { stdout: 'Working on task...\n  esc to interrupt\n', stderr: '' };
            }
            return { stdout: '', stderr: '' };
        });
        const { monitorTeamV2 } = await import('../runtime-v2.js');
        const snapshot = await monitorTeamV2('demo-team', cwd);
        expect(snapshot?.nonReportingWorkers).toEqual([]);
    });
    it('does not mark unknown pane liveness as dead or recommend reassignment', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-monitor-unknown-liveness-'));
        await writeConfigAndTask('in_progress');
        const teamRoot = join(cwd, '.omc', 'state', 'team', 'demo-team');
        await writeFile(join(teamRoot, 'monitor-snapshot.json'), JSON.stringify({
            taskStatusById: { 1: 'in_progress' },
            workerAliveByName: { 'worker-1': true },
            workerLivenessByName: { 'worker-1': 'alive' },
            workerStateByName: { 'worker-1': 'working' },
            workerTurnCountByName: { 'worker-1': 1 },
            workerTaskIdByName: { 'worker-1': '1' },
            mailboxNotifiedByMessageId: {},
            completedEventTaskIds: {},
        }, null, 2), 'utf-8');
        mocks.getWorkerLiveness.mockResolvedValueOnce('unknown');
        const { monitorTeamV2 } = await import('../runtime-v2.js');
        const { readTeamEventsByType } = await import('../events.js');
        const snapshot = await monitorTeamV2('demo-team', cwd);
        expect(snapshot?.workers[0]?.alive).toBe(false);
        expect(snapshot?.workers[0]?.liveness).toBe('unknown');
        expect(snapshot?.deadWorkers).toEqual([]);
        expect(snapshot?.recommendations).not.toContain('Reassign task-1 from dead worker-1');
        await expect(readTeamEventsByType('demo-team', 'worker_stopped', cwd)).resolves.toEqual([]);
    });
    it('does not flag a worker when pane evidence shows startup bootstrapping instead of idle readiness', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-monitor-bootstrap-'));
        await writeConfigAndTask('pending');
        mocks.execFile.mockImplementation((_cmd, args, cb) => {
            if (args[0] === 'capture-pane') {
                cb(null, 'model: loading\ngpt-5.3-codex high · 80% left\n', '');
                return;
            }
            cb(null, '', '');
        });
        mocks.tmuxExecAsync.mockImplementation(async (args) => {
            if (args[0] === 'capture-pane') {
                return { stdout: 'model: loading\ngpt-5.3-codex high · 80% left\n', stderr: '' };
            }
            return { stdout: '', stderr: '' };
        });
        const { monitorTeamV2 } = await import('../runtime-v2.js');
        const snapshot = await monitorTeamV2('demo-team', cwd);
        expect(snapshot?.nonReportingWorkers).toEqual([]);
    });
    it('deduplicates duplicate worker rows from persisted config during monitoring', async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-monitor-dedup-'));
        await writeConfigAndTask('pending');
        const root = join(cwd, '.omc', 'state', 'team', 'demo-team');
        await writeFile(join(root, 'config.json'), JSON.stringify({
            name: 'demo-team',
            task: 'demo',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            worker_count: 2,
            max_workers: 20,
            workers: [
                { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: ['1'] },
                { name: 'worker-1', index: 0, role: 'claude', assigned_tasks: [], pane_id: '%2', working_dir: cwd },
            ],
            created_at: new Date().toISOString(),
            tmux_session: 'demo-session:0',
            leader_pane_id: '%1',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            next_task_id: 2,
            team_state_root: join(cwd, '.omc', 'state', 'team', 'demo-team'),
            workspace_mode: 'single',
        }, null, 2), 'utf-8');
        const { monitorTeamV2 } = await import('../runtime-v2.js');
        const snapshot = await monitorTeamV2('demo-team', cwd);
        expect(snapshot?.workers).toHaveLength(1);
        expect(snapshot?.workers[0]?.name).toBe('worker-1');
        expect(snapshot?.workers[0]?.assignedTasks).toEqual(['1']);
    });
});
//# sourceMappingURL=runtime-v2.monitor.test.js.map