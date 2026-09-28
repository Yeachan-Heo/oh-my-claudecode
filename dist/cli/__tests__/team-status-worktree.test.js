import { beforeEach, describe, expect, it, vi } from 'vitest';
const runtimeV2Mocks = vi.hoisted(() => ({
    isRuntimeV2Enabled: vi.fn(),
    monitorTeamV2: vi.fn(),
}));
const monitorMocks = vi.hoisted(() => ({
    readTeamConfig: vi.fn(),
}));
vi.mock('../../team/runtime-v2.js', () => runtimeV2Mocks);
vi.mock('../../team/monitor.js', () => monitorMocks);
vi.mock('../../team/runtime.js', () => ({
    monitorTeam: vi.fn(),
    resumeTeam: vi.fn(),
    shutdownTeam: vi.fn(),
}));
vi.mock('../../team/git-worktree.js', () => ({
    cleanupTeamWorktrees: vi.fn(),
}));
vi.mock('../../team/tmux-session.js', () => ({
    killWorkerPanes: vi.fn(),
    killTeamSession: vi.fn(),
}));
const { teamStatusByTeamName, TEAM_USAGE } = await import('../team.js');
describe('team CLI worktree status contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        runtimeV2Mocks.isRuntimeV2Enabled.mockReturnValue(true);
        runtimeV2Mocks.monitorTeamV2.mockResolvedValue({
            teamName: 'demo-team',
            phase: 'running',
            workers: [],
            tasks: { total: 0, pending: 0, blocked: 0, in_progress: 0, completed: 0, failed: 0, items: [] },
            allTasksTerminal: true,
            deadWorkers: [],
            nonReportingWorkers: [],
            recommendations: [],
            performance: { list_tasks_ms: 0, worker_scan_ms: 0, total_ms: 0, updated_at: new Date().toISOString() },
        });
    });
    it('returns top-level and worker worktree metadata for JSON status callers', async () => {
        const worker = {
            name: 'worker-1',
            index: 1,
            role: 'executor',
            assigned_tasks: ['1'],
            pane_id: '%1',
            working_dir: '/repo/.omc/team/demo-team/worktrees/worker-1',
            worktree_repo_root: '/repo',
            worktree_path: '/repo/.omc/team/demo-team/worktrees/worker-1',
            worktree_branch: 'omc-team/demo-team/worker-1',
            worktree_detached: false,
            worktree_created: true,
            team_state_root: '/repo/.omc/state/team/demo-team',
        };
        monitorMocks.readTeamConfig.mockResolvedValue({
            name: 'demo-team',
            task: 'demo',
            agent_type: 'codex',
            worker_launch_mode: 'interactive',
            worker_count: 1,
            max_workers: 20,
            workers: [worker],
            created_at: '2026-04-24T00:00:00.000Z',
            tmux_session: 'demo-session',
            next_task_id: 2,
            workspace_mode: 'worktree',
            worktree_mode: 'named',
            team_state_root: '/repo/.omc/state/team/demo-team',
            leader_pane_id: '%0',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
        });
        const status = await teamStatusByTeamName('demo-team', '/repo');
        expect(status).toMatchObject({
            teamName: 'demo-team',
            running: true,
            workspace_mode: 'worktree',
            worktree_mode: 'named',
            team_state_root: '/repo/.omc/state/team/demo-team',
            workers: [expect.objectContaining({
                    worktree_repo_root: '/repo',
                    worktree_path: '/repo/.omc/team/demo-team/worktrees/worker-1',
                    worktree_branch: 'omc-team/demo-team/worker-1',
                    worktree_detached: false,
                    worktree_created: true,
                })],
        });
    });
    it('documents worktree mode as opt-in/config-gated in help text', () => {
        expect(TEAM_USAGE).toContain('worktree mode is opt-in/config-gated');
        expect(TEAM_USAGE).toContain('team status');
        expect(TEAM_USAGE).toContain('worktree metadata');
    });
});
//# sourceMappingURL=team-status-worktree.test.js.map