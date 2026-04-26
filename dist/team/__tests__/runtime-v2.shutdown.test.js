import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createWorkerWorktree } from '../git-worktree.js';
const tmuxMocks = vi.hoisted(() => ({
    killWorkerPanes: vi.fn(async () => undefined),
    killTeamSession: vi.fn(async () => undefined),
    resolveSplitPaneWorkerPaneIds: vi.fn(async (_session, paneIds) => paneIds),
    isWorkerAlive: vi.fn(async () => false),
    getWorkerLiveness: vi.fn(async () => 'dead'),
}));
vi.mock('../tmux-session.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        killWorkerPanes: tmuxMocks.killWorkerPanes,
        killTeamSession: tmuxMocks.killTeamSession,
        resolveSplitPaneWorkerPaneIds: tmuxMocks.resolveSplitPaneWorkerPaneIds,
        isWorkerAlive: tmuxMocks.isWorkerAlive,
        getWorkerLiveness: tmuxMocks.getWorkerLiveness,
    };
});
describe('shutdownTeamV2 detached worktree cleanup', () => {
    let repoDir;
    beforeEach(() => {
        tmuxMocks.killWorkerPanes.mockClear();
        tmuxMocks.killTeamSession.mockClear();
        tmuxMocks.resolveSplitPaneWorkerPaneIds.mockClear();
        tmuxMocks.resolveSplitPaneWorkerPaneIds.mockImplementation(async (_session, paneIds) => paneIds);
        tmuxMocks.isWorkerAlive.mockReset();
        tmuxMocks.isWorkerAlive.mockResolvedValue(false);
        tmuxMocks.getWorkerLiveness.mockReset();
        tmuxMocks.getWorkerLiveness.mockResolvedValue('dead');
        repoDir = mkdtempSync(join(tmpdir(), 'omc-runtime-v2-shutdown-'));
        execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'pipe' });
        writeFileSync(join(repoDir, 'README.md'), '# test\n', 'utf-8');
        execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
    });
    afterEach(() => {
        rmSync(repoDir, { recursive: true, force: true });
    });
    it('removes dormant team-created worktrees during normal shutdown', async () => {
        const teamName = 'shutdown-team';
        const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
        mkdirSync(teamRoot, { recursive: true });
        writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
            name: teamName,
            task: 'demo',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            worker_count: 0,
            max_workers: 20,
            workers: [],
            created_at: new Date().toISOString(),
            tmux_session: '',
            leader_pane_id: null,
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            next_task_id: 1,
        }, null, 2), 'utf-8');
        const worktree = createWorkerWorktree(teamName, 'worker1', repoDir);
        expect(existsSync(worktree.path)).toBe(true);
        const { shutdownTeamV2 } = await import('../runtime-v2.js');
        await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });
        expect(existsSync(worktree.path)).toBe(false);
        expect(existsSync(teamRoot)).toBe(false);
    });
    it('keeps team state when dirty worktrees are preserved during shutdown', async () => {
        const teamName = 'shutdown-dirty-team';
        const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
        mkdirSync(teamRoot, { recursive: true });
        writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
            name: teamName,
            task: 'demo',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            worker_count: 0,
            max_workers: 20,
            workers: [],
            created_at: new Date().toISOString(),
            tmux_session: '',
            leader_pane_id: null,
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            next_task_id: 1,
        }, null, 2), 'utf-8');
        const worktree = createWorkerWorktree(teamName, 'worker-dirty', repoDir);
        writeFileSync(join(worktree.path, 'dirty.txt'), 'dirty', 'utf-8');
        const { shutdownTeamV2 } = await import('../runtime-v2.js');
        await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });
        expect(existsSync(worktree.path)).toBe(true);
        expect(existsSync(teamRoot)).toBe(true);
    });
    it('keeps worktrees and team state when config is missing but clean metadata exists', async () => {
        const teamName = 'shutdown-missing-config-clean-metadata';
        const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
        const worktree = createWorkerWorktree(teamName, 'worker-clean', repoDir);
        expect(existsSync(teamRoot)).toBe(true);
        expect(existsSync(join(teamRoot, 'worktrees.json'))).toBe(true);
        const { shutdownTeamV2 } = await import('../runtime-v2.js');
        await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });
        expect(existsSync(worktree.path)).toBe(true);
        expect(existsSync(teamRoot)).toBe(true);
        expect(existsSync(join(teamRoot, 'worktrees.json'))).toBe(true);
    });
    it('keeps team state when config is missing but worktree root AGENTS backup exists', async () => {
        const teamName = 'shutdown-backup-only-team';
        const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
        const backupPath = join(teamRoot, 'workers', 'worker-1', 'worktree-root-agents.json');
        mkdirSync(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
        writeFileSync(backupPath, JSON.stringify({
            worktreePath: join(repoDir, '.omc', 'team', teamName, 'worktrees', 'worker-1'),
            hadOriginal: true,
            originalContent: 'original',
            installedContent: 'managed',
            installedAt: new Date().toISOString(),
        }), 'utf-8');
        const { shutdownTeamV2 } = await import('../runtime-v2.js');
        await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });
        expect(existsSync(teamRoot)).toBe(true);
        expect(existsSync(backupPath)).toBe(true);
    });
    it('keeps team state when config is missing but worktree metadata is corrupt', async () => {
        const teamName = 'shutdown-corrupt-metadata-team';
        const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
        mkdirSync(teamRoot, { recursive: true });
        writeFileSync(join(teamRoot, 'worktrees.json'), '{not-json', 'utf-8');
        const { shutdownTeamV2 } = await import('../runtime-v2.js');
        await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });
        expect(existsSync(teamRoot)).toBe(true);
        expect(existsSync(join(teamRoot, 'worktrees.json'))).toBe(true);
    });
    it('uses the canonical team state root in worktree shutdown ack instructions', async () => {
        const teamName = 'shutdown-worktree-ack-team';
        const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
        mkdirSync(teamRoot, { recursive: true });
        const worktree = createWorkerWorktree(teamName, 'worker-wt', repoDir);
        writeFileSync(join(worktree.path, 'dirty.txt'), 'dirty', 'utf-8');
        writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
            name: teamName,
            task: 'demo',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            worker_count: 1,
            max_workers: 20,
            workers: [{
                    name: 'worker-wt',
                    index: 1,
                    role: 'executor',
                    assigned_tasks: [],
                    working_dir: worktree.path,
                    team_state_root: teamRoot,
                    worktree_path: worktree.path,
                    worktree_created: true,
                }],
            created_at: new Date().toISOString(),
            tmux_session: '',
            leader_pane_id: null,
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            next_task_id: 1,
        }, null, 2), 'utf-8');
        const { shutdownTeamV2 } = await import('../runtime-v2.js');
        await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });
        const inbox = readFileSync(join(teamRoot, 'workers', 'worker-wt', 'inbox.md'), 'utf-8');
        expect(inbox).toContain('$OMC_TEAM_STATE_ROOT/workers/worker-wt/shutdown-ack.json');
        expect(inbox).not.toContain(`Write your ack to: .omc/state/team/${teamName}`);
    });
    it('keeps worktrees and team state when a worker pane remains alive after shutdown kill', async () => {
        const teamName = 'shutdown-live-pane-team';
        const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
        mkdirSync(teamRoot, { recursive: true });
        const worktree = createWorkerWorktree(teamName, 'worker-live', repoDir);
        writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
            name: teamName,
            task: 'demo',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            worker_count: 1,
            max_workers: 20,
            workers: [{
                    name: 'worker-live',
                    index: 1,
                    role: 'executor',
                    assigned_tasks: [],
                    pane_id: '%42',
                    working_dir: worktree.path,
                    team_state_root: teamRoot,
                    worktree_path: worktree.path,
                    worktree_created: true,
                }],
            created_at: new Date().toISOString(),
            tmux_session: '',
            leader_pane_id: null,
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            next_task_id: 1,
        }, null, 2), 'utf-8');
        tmuxMocks.getWorkerLiveness.mockResolvedValue('alive');
        const { shutdownTeamV2 } = await import('../runtime-v2.js');
        await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });
        expect(tmuxMocks.killWorkerPanes).toHaveBeenCalled();
        expect(existsSync(worktree.path)).toBe(true);
        expect(existsSync(teamRoot)).toBe(true);
    });
    it('keeps worktrees and team state when pane liveness probe is unknown after shutdown kill', async () => {
        const teamName = 'shutdown-unknown-pane-team';
        const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
        mkdirSync(teamRoot, { recursive: true });
        const worktree = createWorkerWorktree(teamName, 'worker-unknown', repoDir);
        writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
            name: teamName,
            task: 'demo',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            worker_count: 1,
            max_workers: 20,
            workers: [{
                    name: 'worker-unknown',
                    index: 1,
                    role: 'executor',
                    assigned_tasks: [],
                    pane_id: '%44',
                    working_dir: worktree.path,
                    team_state_root: teamRoot,
                    worktree_path: worktree.path,
                    worktree_created: true,
                }],
            created_at: new Date().toISOString(),
            tmux_session: '',
            leader_pane_id: null,
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            next_task_id: 1,
        }, null, 2), 'utf-8');
        tmuxMocks.getWorkerLiveness.mockResolvedValue('unknown');
        const { shutdownTeamV2 } = await import('../runtime-v2.js');
        await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });
        expect(tmuxMocks.killWorkerPanes).toHaveBeenCalled();
        expect(existsSync(worktree.path)).toBe(true);
        expect(existsSync(teamRoot)).toBe(true);
    });
    it('keeps worktrees and team state when tmux cleanup fails before liveness is proven', async () => {
        const teamName = 'shutdown-kill-fails-team';
        const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
        mkdirSync(teamRoot, { recursive: true });
        const worktree = createWorkerWorktree(teamName, 'worker-kill-fails', repoDir);
        writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
            name: teamName,
            task: 'demo',
            agent_type: 'claude',
            worker_launch_mode: 'interactive',
            worker_count: 1,
            max_workers: 20,
            workers: [{
                    name: 'worker-kill-fails',
                    index: 1,
                    role: 'executor',
                    assigned_tasks: [],
                    pane_id: '%43',
                    working_dir: worktree.path,
                    team_state_root: teamRoot,
                    worktree_path: worktree.path,
                    worktree_created: true,
                }],
            created_at: new Date().toISOString(),
            tmux_session: '',
            leader_pane_id: null,
            hud_pane_id: null,
            resize_hook_name: null,
            resize_hook_target: null,
            next_task_id: 1,
        }, null, 2), 'utf-8');
        tmuxMocks.killWorkerPanes.mockRejectedValueOnce(new Error('tmux unavailable'));
        const { shutdownTeamV2 } = await import('../runtime-v2.js');
        await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });
        expect(tmuxMocks.killWorkerPanes).toHaveBeenCalled();
        expect(existsSync(worktree.path)).toBe(true);
        expect(existsSync(teamRoot)).toBe(true);
    });
});
//# sourceMappingURL=runtime-v2.shutdown.test.js.map