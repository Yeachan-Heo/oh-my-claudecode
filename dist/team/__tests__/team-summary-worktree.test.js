import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getTeamSummary } from '../monitor.js';
import { executeTeamApiOperation } from '../api-interop.js';
describe('team summary worktree metadata', () => {
    it('surfaces workspace and worker worktree contract fields', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'omc-summary-worktree-'));
        const teamName = 'summary-team';
        const teamRoot = join(cwd, '.omc', 'state', 'team', teamName);
        const teamStateRoot = join(cwd, '.omc', 'state', 'team', teamName);
        const worktreePath = join(cwd, '.omc', 'team', teamName, 'worktrees', 'worker-1');
        try {
            mkdirSync(teamRoot, { recursive: true });
            writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
                name: teamName,
                task: 'demo',
                agent_type: 'codex',
                worker_launch_mode: 'interactive',
                worker_count: 1,
                max_workers: 20,
                workers: [{
                        name: 'worker-1',
                        index: 1,
                        role: 'executor',
                        assigned_tasks: [],
                        working_dir: worktreePath,
                        worktree_repo_root: cwd,
                        worktree_path: worktreePath,
                        worktree_branch: 'omc-team/summary-team/worker-1',
                        worktree_detached: false,
                        worktree_created: true,
                        team_state_root: teamStateRoot,
                    }],
                created_at: new Date().toISOString(),
                tmux_session: 'omc-summary-team',
                next_task_id: 1,
                leader_cwd: cwd,
                team_state_root: teamStateRoot,
                workspace_mode: 'worktree',
                worktree_mode: 'named',
                leader_pane_id: null,
                hud_pane_id: null,
                resize_hook_name: null,
                resize_hook_target: null,
            }, null, 2), 'utf-8');
            const summary = await getTeamSummary(teamName, cwd);
            expect(summary?.workspace_mode).toBe('worktree');
            expect(summary?.worktree_mode).toBe('named');
            expect(summary?.team_state_root).toBe(teamStateRoot);
            expect(summary?.workers[0]).toMatchObject({
                working_dir: worktreePath,
                worktree_repo_root: cwd,
                worktree_path: worktreePath,
                worktree_branch: 'omc-team/summary-team/worker-1',
                worktree_detached: false,
                worktree_created: true,
                team_state_root: teamStateRoot,
            });
            const apiResult = await executeTeamApiOperation('get-summary', { team_name: teamName }, cwd);
            expect(apiResult.ok).toBe(true);
            if (!apiResult.ok)
                throw new Error('expected get-summary success');
            expect(apiResult.data.summary).toMatchObject({
                workspace_mode: 'worktree',
                worktree_mode: 'named',
                team_state_root: teamStateRoot,
                workers: [expect.objectContaining({
                        working_dir: worktreePath,
                        worktree_repo_root: cwd,
                        worktree_path: worktreePath,
                        worktree_branch: 'omc-team/summary-team/worker-1',
                        worktree_detached: false,
                        worktree_created: true,
                        team_state_root: teamStateRoot,
                    })],
            });
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=team-summary-worktree.test.js.map