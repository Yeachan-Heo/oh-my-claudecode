import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  createWorkerWorktree,
  removeWorkerWorktree,
  listTeamWorktrees,
  cleanupTeamWorktrees,
} from '../git-worktree.js';

describe('git-worktree', () => {
  let repoDir: string;
  const teamName = 'test-wt';

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'git-worktree-test-'));
    // Initialize a git repo with an initial commit
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(join(repoDir, 'README.md'), '# Test\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir, stdio: 'pipe' });
  });

  afterEach(() => {
    // Clean up worktrees first (git needs this before rmSync)
    try {
      cleanupTeamWorktrees(teamName, repoDir);
    } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe('createWorkerWorktree', () => {
    it('creates worktree at correct path', () => {
      const info = createWorkerWorktree(teamName, 'worker1', repoDir);

      expect(info.path).toContain('.omc/worktrees');
      expect(info.branch).toBe(`omc-team/${teamName}/worker1`);
      expect(info.workerName).toBe('worker1');
      expect(info.teamName).toBe(teamName);
      expect(existsSync(info.path)).toBe(true);
    });

    it('branch name is properly sanitized', () => {
      const info = createWorkerWorktree(teamName, 'worker-with-special', repoDir);
      expect(info.branch).toContain('omc-team/');
      expect(existsSync(info.path)).toBe(true);
    });

    it('handles recreation of stale worktree', () => {
      const info1 = createWorkerWorktree(teamName, 'worker1', repoDir);
      expect(existsSync(info1.path)).toBe(true);

      // Recreate the same worktree
      const info2 = createWorkerWorktree(teamName, 'worker1', repoDir);
      expect(existsSync(info2.path)).toBe(true);
      expect(info2.path).toBe(info1.path);
    });
  });

  describe('removeWorkerWorktree', () => {
    it('removes worktree and branch', () => {
      const info = createWorkerWorktree(teamName, 'worker1', repoDir);
      expect(existsSync(info.path)).toBe(true);

      removeWorkerWorktree(teamName, 'worker1', repoDir);

      // Worktree directory should be gone
      expect(existsSync(info.path)).toBe(false);

      // Branch should be deleted
      const branches = execFileSync('git', ['branch'], { cwd: repoDir, encoding: 'utf-8' });
      expect(branches).not.toContain('omc-team/');
    });

    it('does not throw for non-existent worktree', () => {
      expect(() => removeWorkerWorktree(teamName, 'nonexistent', repoDir)).not.toThrow();
    });
  });

  describe('listTeamWorktrees', () => {
    it('returns empty for team with no worktrees', () => {
      const list = listTeamWorktrees(teamName, repoDir);
      expect(list).toEqual([]);
    });

    it('lists created worktrees', () => {
      createWorkerWorktree(teamName, 'worker1', repoDir);
      createWorkerWorktree(teamName, 'worker2', repoDir);

      const list = listTeamWorktrees(teamName, repoDir);
      expect(list).toHaveLength(2);
      expect(list.map(w => w.workerName)).toContain('worker1');
      expect(list.map(w => w.workerName)).toContain('worker2');
    });
  });

  describe('cleanupTeamWorktrees', () => {
    it('removes all worktrees for a team', () => {
      createWorkerWorktree(teamName, 'worker1', repoDir);
      createWorkerWorktree(teamName, 'worker2', repoDir);

      expect(listTeamWorktrees(teamName, repoDir)).toHaveLength(2);

      cleanupTeamWorktrees(teamName, repoDir);

      expect(listTeamWorktrees(teamName, repoDir)).toHaveLength(0);
    });
  });
});
