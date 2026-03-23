import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
const mocks = vi.hoisted(() => ({
    isWorkerAlive: vi.fn(async () => true),
    execFile: vi.fn(),
}));
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        execFile: mocks.execFile,
    };
});
vi.mock('../tmux-session.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        isWorkerAlive: mocks.isWorkerAlive,
    };
});
describe('monitorTeamV2 pane-based stall inference', () => {
    let cwd;
    beforeEach(() => {
        vi.resetModules();
        mocks.isWorkerAlive.mockReset();
        mocks.execFile.mockReset();
        mocks.isWorkerAlive.mockResolvedValue(true);
        mocks.execFile.mockImplementation((_cmd, args, cb) => {
            if (args[0] === 'capture-pane') {
                cb(null, '> \n', '');
                return;
            }
            cb(null, '', '');
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
        const { monitorTeamV2 } = await import('../runtime-v2.js');
        const snapshot = await monitorTeamV2('demo-team', cwd);
        expect(snapshot?.nonReportingWorkers).toEqual([]);
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