import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
const tmuxUtilsMocks = vi.hoisted(() => ({
    tmuxExec: vi.fn(),
    tmuxSpawn: vi.fn(),
}));
const modelContractMocks = vi.hoisted(() => ({
    buildWorkerArgv: vi.fn(),
    getWorkerEnv: vi.fn(),
}));
const teamOpsMocks = vi.hoisted(() => ({
    teamReadConfig: vi.fn(),
    teamWriteWorkerIdentity: vi.fn(),
    teamReadWorkerStatus: vi.fn(),
    teamAppendEvent: vi.fn(),
    writeAtomic: vi.fn(),
}));
const monitorMocks = vi.hoisted(() => ({
    withScalingLock: vi.fn(),
    saveTeamConfig: vi.fn(),
}));
const tmuxSessionMocks = vi.hoisted(() => ({
    sanitizeName: vi.fn((name) => name),
    isWorkerAlive: vi.fn(),
    getWorkerLiveness: vi.fn(),
    killWorkerPanes: vi.fn(),
    buildWorkerStartCommand: vi.fn(() => 'start-worker'),
    waitForPaneReady: vi.fn(),
}));
const gitWorktreeMocks = vi.hoisted(() => ({
    ensureWorkerWorktree: vi.fn(),
    installWorktreeRootAgents: vi.fn(),
    removeWorkerWorktree: vi.fn(),
    restoreWorktreeRootAgents: vi.fn(),
    checkWorkerWorktreeRemovalSafety: vi.fn(),
    prepareWorkerWorktreeForRemoval: vi.fn(),
}));
vi.mock('../../cli/tmux-utils.js', () => ({
    tmuxExec: tmuxUtilsMocks.tmuxExec,
    tmuxSpawn: tmuxUtilsMocks.tmuxSpawn,
}));
vi.mock('../model-contract.js', () => ({
    buildWorkerArgv: modelContractMocks.buildWorkerArgv,
    getWorkerEnv: modelContractMocks.getWorkerEnv,
}));
vi.mock('../team-ops.js', () => ({
    teamReadConfig: teamOpsMocks.teamReadConfig,
    teamWriteWorkerIdentity: teamOpsMocks.teamWriteWorkerIdentity,
    teamReadWorkerStatus: teamOpsMocks.teamReadWorkerStatus,
    teamAppendEvent: teamOpsMocks.teamAppendEvent,
    writeAtomic: teamOpsMocks.writeAtomic,
}));
vi.mock('../monitor.js', () => ({
    withScalingLock: monitorMocks.withScalingLock,
    saveTeamConfig: monitorMocks.saveTeamConfig,
}));
vi.mock('../tmux-session.js', () => ({
    sanitizeName: tmuxSessionMocks.sanitizeName,
    isWorkerAlive: tmuxSessionMocks.isWorkerAlive,
    getWorkerLiveness: tmuxSessionMocks.getWorkerLiveness,
    killWorkerPanes: tmuxSessionMocks.killWorkerPanes,
    buildWorkerStartCommand: tmuxSessionMocks.buildWorkerStartCommand,
    waitForPaneReady: tmuxSessionMocks.waitForPaneReady,
}));
vi.mock('../git-worktree.js', () => ({
    ensureWorkerWorktree: gitWorktreeMocks.ensureWorkerWorktree,
    installWorktreeRootAgents: gitWorktreeMocks.installWorktreeRootAgents,
    removeWorkerWorktree: gitWorktreeMocks.removeWorkerWorktree,
    restoreWorktreeRootAgents: gitWorktreeMocks.restoreWorktreeRootAgents,
    checkWorkerWorktreeRemovalSafety: gitWorktreeMocks.checkWorkerWorktreeRemovalSafety,
    prepareWorkerWorktreeForRemoval: gitWorktreeMocks.prepareWorkerWorktreeForRemoval,
}));
import { scaleDown, scaleUp } from '../scaling.js';
describe('scaleUp launch config', () => {
    let cwd;
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), 'omc-scaling-launch-config-'));
        vi.clearAllMocks();
        monitorMocks.withScalingLock.mockImplementation(async (_teamName, _leaderCwd, fn) => fn());
        teamOpsMocks.teamReadConfig.mockResolvedValue({
            name: 'demo-team',
            task: 'demo',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            worker_count: 0,
            max_workers: 20,
            workers: [],
            created_at: new Date().toISOString(),
            tmux_session: 'demo-session:0',
            next_task_id: 2,
            next_worker_index: 1,
            leader_pane_id: '%0',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
        });
        modelContractMocks.getWorkerEnv.mockImplementation((teamName, workerName, agentType) => ({
            OMC_TEAM_WORKER: `${teamName}/${workerName}`,
            OMC_TEAM_NAME: teamName,
            OMC_WORKER_AGENT_TYPE: agentType,
        }));
        tmuxUtilsMocks.tmuxSpawn.mockImplementation((args) => {
            if (args[0] === 'split-window') {
                return { status: 0, stdout: '%12\n', stderr: '' };
            }
            if (args[0] === 'display-message') {
                return { status: 0, stdout: '4321\n', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
        });
        tmuxSessionMocks.waitForPaneReady.mockResolvedValue(undefined);
        gitWorktreeMocks.ensureWorkerWorktree.mockReset();
        gitWorktreeMocks.installWorktreeRootAgents.mockReset();
        gitWorktreeMocks.installWorktreeRootAgents.mockReturnValue(undefined);
        gitWorktreeMocks.removeWorkerWorktree.mockReset();
        gitWorktreeMocks.restoreWorktreeRootAgents.mockReset();
        gitWorktreeMocks.restoreWorktreeRootAgents.mockReturnValue({ restored: true });
        gitWorktreeMocks.checkWorkerWorktreeRemovalSafety.mockReset();
        gitWorktreeMocks.prepareWorkerWorktreeForRemoval.mockReset();
    });
    afterEach(async () => {
        if (cwd) {
            await rm(cwd, { recursive: true, force: true });
        }
    });
    it.each([
        ['codex', ['/usr/bin/codex', 'exec', '--dangerously-bypass-approvals-and-sandbox']],
        ['gemini', ['/usr/bin/gemini', '--approval-mode', 'yolo']],
    ])('uses model-contract launch argv for %s scale-up workers', async (agentType, workerArgv) => {
        modelContractMocks.buildWorkerArgv.mockReturnValue(workerArgv);
        const result = await scaleUp('demo-team', 1, agentType, [{ subject: 'demo', description: 'demo task' }], cwd, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: true, newWorkerCount: 1, nextWorkerIndex: 2 });
        expect(modelContractMocks.buildWorkerArgv).toHaveBeenCalledWith(agentType, {
            teamName: 'demo-team',
            workerName: 'worker-1',
            cwd: resolve(cwd),
        });
        expect(tmuxSessionMocks.buildWorkerStartCommand).toHaveBeenCalledWith(expect.objectContaining({
            teamName: 'demo-team',
            workerName: 'worker-1',
            launchBinary: workerArgv[0],
            launchArgs: workerArgv.slice(1),
            cwd: resolve(cwd),
            envVars: expect.objectContaining({
                OMC_TEAM_WORKER: 'demo-team/worker-1',
                OMC_TEAM_NAME: 'demo-team',
                OMC_WORKER_AGENT_TYPE: agentType,
                OMC_TEAM_STATE_ROOT: `${resolve(cwd)}/.omc/state/team/demo-team`,
                OMC_TEAM_LEADER_CWD: resolve(cwd),
            }),
        }));
    });
    it('rolls back a pending worktree when scale-up fails before worker config is saved', async () => {
        modelContractMocks.buildWorkerArgv.mockReturnValue(['/usr/bin/codex']);
        teamOpsMocks.teamReadConfig.mockResolvedValueOnce({
            name: 'demo-team',
            task: 'demo',
            agent_type: 'codex',
            worker_launch_mode: 'interactive',
            worker_count: 0,
            max_workers: 20,
            workers: [],
            created_at: new Date().toISOString(),
            tmux_session: 'demo-session:0',
            next_task_id: 2,
            next_worker_index: 1,
            leader_pane_id: '%0',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            team_state_root: `${resolve(cwd)}/.omc/state/team/demo-team`,
            worktree_mode: 'named',
        });
        gitWorktreeMocks.ensureWorkerWorktree.mockReturnValue({
            path: join(resolve(cwd), '.omc', 'team', 'demo-team', 'worktrees', 'worker-1'),
            branch: 'omc-team/demo-team/worker-1',
            workerName: 'worker-1',
            teamName: 'demo-team',
            createdAt: new Date().toISOString(),
            repoRoot: resolve(cwd),
            mode: 'named',
            detached: false,
            created: true,
            reused: false,
        });
        tmuxSessionMocks.buildWorkerStartCommand.mockImplementationOnce(() => {
            throw new Error('boom');
        });
        const result = await scaleUp('demo-team', 1, 'codex', [{ subject: 'demo', description: 'demo task' }], cwd, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: false });
        expect(gitWorktreeMocks.removeWorkerWorktree).toHaveBeenCalledWith('demo-team', 'worker-1', resolve(cwd));
    });
    it('rolls back a pending worktree when root overlay installation fails', async () => {
        modelContractMocks.buildWorkerArgv.mockReturnValue(['/usr/bin/codex']);
        teamOpsMocks.teamReadConfig.mockResolvedValueOnce({
            name: 'demo-team',
            task: 'demo',
            agent_type: 'codex',
            worker_launch_mode: 'interactive',
            worker_count: 0,
            max_workers: 20,
            workers: [],
            created_at: new Date().toISOString(),
            tmux_session: 'demo-session:0',
            next_task_id: 2,
            next_worker_index: 1,
            leader_pane_id: '%0',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            team_state_root: `${resolve(cwd)}/.omc/state/team/demo-team`,
            worktree_mode: 'named',
        });
        gitWorktreeMocks.ensureWorkerWorktree.mockReturnValue({
            path: join(resolve(cwd), '.omc', 'team', 'demo-team', 'worktrees', 'worker-1'),
            branch: 'omc-team/demo-team/worker-1',
            workerName: 'worker-1',
            teamName: 'demo-team',
            createdAt: new Date().toISOString(),
            repoRoot: resolve(cwd),
            mode: 'named',
            detached: false,
            created: true,
            reused: false,
        });
        gitWorktreeMocks.installWorktreeRootAgents.mockImplementationOnce(() => {
            throw new Error('agents_dirty');
        });
        const result = await scaleUp('demo-team', 1, 'codex', [{ subject: 'demo', description: 'demo task' }], cwd, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Failed to install worker overlay') });
        expect(gitWorktreeMocks.removeWorkerWorktree).toHaveBeenCalledWith('demo-team', 'worker-1', resolve(cwd));
        expect(tmuxSessionMocks.buildWorkerStartCommand).not.toHaveBeenCalled();
    });
    it('restores managed overlays for reused worktrees during scale-down without deleting them', async () => {
        const config = {
            name: 'demo-team',
            task: 'demo',
            agent_type: 'codex',
            worker_launch_mode: 'interactive',
            worker_count: 2,
            max_workers: 20,
            workers: [
                { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%1', worktree_path: join(resolve(cwd), 'reuse'), worktree_created: false },
                { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [], pane_id: '%2' },
            ],
            created_at: new Date().toISOString(),
            tmux_session: 'demo-session:0',
            next_task_id: 2,
            next_worker_index: 3,
            leader_pane_id: '%0',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            team_state_root: `${resolve(cwd)}/.omc/state/team/demo-team`,
        };
        teamOpsMocks.teamReadConfig.mockResolvedValueOnce(config);
        teamOpsMocks.teamReadWorkerStatus.mockResolvedValue({ state: 'idle', updated_at: new Date().toISOString() });
        tmuxSessionMocks.getWorkerLiveness.mockResolvedValue('dead');
        const result = await scaleDown('demo-team', cwd, { workerNames: ['worker-1'], drainTimeoutMs: 0 }, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: true, removedWorkers: ['worker-1'], newWorkerCount: 1 });
        expect(gitWorktreeMocks.prepareWorkerWorktreeForRemoval).toHaveBeenCalledWith('demo-team', 'worker-1', resolve(cwd), join(resolve(cwd), 'reuse'));
        expect(gitWorktreeMocks.removeWorkerWorktree).not.toHaveBeenCalled();
    });
    it('keeps reused worktree worker tracked if post-drain cleanup safety fails', async () => {
        const config = {
            name: 'demo-team',
            task: 'demo',
            agent_type: 'codex',
            worker_launch_mode: 'interactive',
            worker_count: 2,
            max_workers: 20,
            workers: [
                { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%1', worktree_path: join(resolve(cwd), 'reuse'), worktree_created: false },
                { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [], pane_id: '%2' },
            ],
            created_at: new Date().toISOString(),
            tmux_session: 'demo-session:0',
            next_task_id: 2,
            next_worker_index: 3,
            leader_pane_id: '%0',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            team_state_root: `${resolve(cwd)}/.omc/state/team/demo-team`,
        };
        teamOpsMocks.teamReadConfig.mockResolvedValueOnce(config);
        teamOpsMocks.teamReadWorkerStatus.mockResolvedValue({ state: 'idle', updated_at: new Date().toISOString() });
        tmuxSessionMocks.getWorkerLiveness.mockResolvedValue('dead');
        gitWorktreeMocks.prepareWorkerWorktreeForRemoval.mockImplementationOnce(() => {
            throw new Error('worktree_dirty: preserving dirty worker worktree');
        });
        const result = await scaleDown('demo-team', cwd, { workerNames: ['worker-1'], drainTimeoutMs: 0 }, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: false, error: expect.stringContaining('worktree_dirty') });
        expect(gitWorktreeMocks.prepareWorkerWorktreeForRemoval).toHaveBeenCalledWith('demo-team', 'worker-1', resolve(cwd), join(resolve(cwd), 'reuse'));
        expect(monitorMocks.saveTeamConfig).not.toHaveBeenCalled();
    });
    it('preserves worktree and config when target pane remains alive after kill request', async () => {
        const config = {
            name: 'demo-team',
            task: 'demo',
            agent_type: 'codex',
            worker_launch_mode: 'interactive',
            worker_count: 2,
            max_workers: 20,
            workers: [
                { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%1', worktree_path: join(resolve(cwd), 'created'), worktree_created: true },
                { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [], pane_id: '%2' },
            ],
            created_at: new Date().toISOString(),
            tmux_session: 'demo-session:0',
            next_task_id: 2,
            next_worker_index: 3,
            leader_pane_id: '%0',
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            team_state_root: `${resolve(cwd)}/.omc/state/team/demo-team`,
        };
        teamOpsMocks.teamReadConfig.mockResolvedValueOnce(config);
        teamOpsMocks.teamReadWorkerStatus.mockResolvedValue({ state: 'idle', updated_at: new Date().toISOString() });
        tmuxSessionMocks.getWorkerLiveness.mockResolvedValue('alive');
        const result = await scaleDown('demo-team', cwd, { workerNames: ['worker-1'], drainTimeoutMs: 0 }, { OMC_TEAM_SCALING_ENABLED: '1' });
        expect(result).toMatchObject({ ok: false, error: expect.stringContaining('still alive') });
        expect(tmuxSessionMocks.killWorkerPanes).toHaveBeenCalled();
        expect(gitWorktreeMocks.removeWorkerWorktree).not.toHaveBeenCalled();
        expect(monitorMocks.saveTeamConfig).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=scaling-launch-config.test.js.map