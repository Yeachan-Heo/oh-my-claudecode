import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureWorkerWorktree } from '../git-worktree.js';
import { initTeamState } from '../state.js';
import type { TeamConfig } from '../types.js';

const tmuxMocks = vi.hoisted(() => ({
  killWorkerPanes: vi.fn(async () => undefined),
  killTeamSession: vi.fn(async () => undefined),
  resolveSplitPaneWorkerPaneIds: vi.fn(async (_session: string | undefined, paneIds: string[]) => paneIds),
  getWorkerLiveness: vi.fn(async () => 'dead'),
}));

vi.mock('../tmux-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tmux-session.js')>();
  return {
    ...actual,
    killWorkerPanes: tmuxMocks.killWorkerPanes,
    killTeamSession: tmuxMocks.killTeamSession,
    resolveSplitPaneWorkerPaneIds: tmuxMocks.resolveSplitPaneWorkerPaneIds,
    getWorkerLiveness: tmuxMocks.getWorkerLiveness,
  };
});

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'omc-shutdown-fallback-'));
  execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'pipe' });
  writeFileSync(join(repo, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'pipe' });
  return repo;
}

describe('shutdown fallback worktree recovery', () => {
  it('keeps dirty detached worker worktrees and OMC state for leader follow-up cleanup', async () => {
    const repo = initRepo();
    const teamName = 'team-shutdown-fallback-report';
    const workerName = 'worker-dirty';
    const teamRoot = join(repo, '.omc', 'state', 'team', teamName);

    try {
      tmuxMocks.killWorkerPanes.mockClear();
      tmuxMocks.killTeamSession.mockClear();
      tmuxMocks.resolveSplitPaneWorkerPaneIds.mockClear();
      tmuxMocks.getWorkerLiveness.mockReset();
      tmuxMocks.getWorkerLiveness.mockResolvedValue('dead');

      const worktree = ensureWorkerWorktree(teamName, workerName, repo, {
        mode: 'detached',
        requireCleanLeader: true,
      });
      expect(worktree).not.toBeNull();
      expect(worktree?.detached).toBe(true);
      expect(worktree?.path).toContain(`.omc/team/${teamName}/worktrees/${workerName}`);

      const worktreePath = worktree?.path ?? '';
      writeFileSync(join(worktreePath, 'worker-note.txt'), 'from worker\n', 'utf-8');

      const config: TeamConfig = {
        name: teamName,
        task: 'shutdown fallback preserve report',
        agent_type: 'codex',
        worker_launch_mode: 'prompt',
        worker_count: 1,
        max_workers: 20,
        workers: [{
          name: workerName,
          index: 1,
          role: 'executor',
          worker_cli: 'codex',
          assigned_tasks: [],
          working_dir: worktreePath,
          worktree_repo_root: repo,
          worktree_path: worktreePath,
          worktree_branch: worktree?.branch,
          worktree_detached: true,
          worktree_created: true,
          team_state_root: teamRoot,
        }],
        created_at: new Date().toISOString(),
        tmux_session: '',
        next_task_id: 1,
        leader_cwd: repo,
        team_state_root: teamRoot,
        workspace_mode: 'worktree',
        worktree_mode: 'detached',
        leader_pane_id: null,
        hud_pane_id: null,
        resize_hook_name: null,
        resize_hook_target: null,
      };
      await initTeamState(config, repo);

      const { shutdownTeamV2 } = await import('../runtime-v2.js');
      await shutdownTeamV2(teamName, repo, { force: true, timeoutMs: 0 });

      expect(existsSync(worktreePath)).toBe(true);
      expect(readFileSync(join(worktreePath, 'worker-note.txt'), 'utf-8')).toBe('from worker\n');
      expect(existsSync(teamRoot)).toBe(true);
      expect(existsSync(join(teamRoot, 'worktrees.json'))).toBe(true);
      expect(readFileSync(join(teamRoot, 'workers', workerName, 'inbox.md'), 'utf-8'))
        .toContain('$OMC_TEAM_STATE_ROOT/workers/worker-dirty/shutdown-ack.json');
      expect(existsSync(join(repo, 'worker-note.txt'))).toBe(false);
      expect(existsSync(join(worktreePath, '.omx', 'diff.md'))).toBe(false);
      expect(existsSync(join(repo, '.omx', 'reports', 'team-commit-hygiene', `${teamName}.context.json`))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
