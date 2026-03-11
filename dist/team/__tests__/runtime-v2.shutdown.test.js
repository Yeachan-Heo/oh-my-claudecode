import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createWorkerWorktree } from '../git-worktree.js';
describe('shutdownTeamV2 detached worktree cleanup', () => {
    let repoDir;
    beforeEach(() => {
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
});
//# sourceMappingURL=runtime-v2.shutdown.test.js.map