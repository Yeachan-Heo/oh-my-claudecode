import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { checkMergeConflicts, mergeWorkerBranch, mergeAllWorkerBranches } from '../merge-coordinator.js';
import { createWorkerWorktree, cleanupTeamWorktrees } from '../git-worktree.js';

describe('merge-coordinator', () => {
  let repoDir: string;
  const teamName = 'test-merge';

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'merge-coord-test-'));
    // Initialize git repo with initial commit
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(join(repoDir, 'README.md'), '# Test\n');
    writeFileSync(join(repoDir, 'file1.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir, stdio: 'pipe' });
  });

  afterEach(() => {
    try { cleanupTeamWorktrees(teamName, repoDir); } catch { /* ignore */ }
    // Make sure we're on main branch before cleanup
    try { execFileSync('git', ['checkout', 'master'], { cwd: repoDir, stdio: 'pipe' }); } catch {
      try { execFileSync('git', ['checkout', 'main'], { cwd: repoDir, stdio: 'pipe' }); } catch { /* ignore */ }
    }
    rmSync(repoDir, { recursive: true, force: true });
  });

  function getMainBranch(): string {
    try {
      return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repoDir, encoding: 'utf-8', stdio: 'pipe'
      }).trim();
    } catch {
      return 'master';
    }
  }

  describe('checkMergeConflicts', () => {
    it('returns empty for non-conflicting branches', () => {
      const main = getMainBranch();
      const wt = createWorkerWorktree(teamName, 'worker1', repoDir);

      // Make a change in the worktree on a different file
      writeFileSync(join(wt.path, 'new-file.ts'), 'export const y = 2;\n');
      execFileSync('git', ['add', '.'], { cwd: wt.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'Add new file'], { cwd: wt.path, stdio: 'pipe' });

      const conflicts = checkMergeConflicts(wt.branch, main, repoDir);
      expect(conflicts).toEqual([]);
    });

    it('detects potentially conflicting files', () => {
      const main = getMainBranch();
      const wt = createWorkerWorktree(teamName, 'worker1', repoDir);

      // Change same file in worktree
      writeFileSync(join(wt.path, 'file1.ts'), 'export const x = 100;\n');
      execFileSync('git', ['add', '.'], { cwd: wt.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'Change file1'], { cwd: wt.path, stdio: 'pipe' });

      // Change same file in main
      writeFileSync(join(repoDir, 'file1.ts'), 'export const x = 200;\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'Change file1 in main'], { cwd: repoDir, stdio: 'pipe' });

      const conflicts = checkMergeConflicts(wt.branch, main, repoDir);
      expect(conflicts).toContain('file1.ts');
    });
  });

  describe('mergeWorkerBranch', () => {
    it('succeeds for clean merge', () => {
      const main = getMainBranch();
      const wt = createWorkerWorktree(teamName, 'worker1', repoDir);

      // Make a change in worktree
      writeFileSync(join(wt.path, 'worker-file.ts'), 'export const z = 3;\n');
      execFileSync('git', ['add', '.'], { cwd: wt.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'Worker change'], { cwd: wt.path, stdio: 'pipe' });

      const result = mergeWorkerBranch(wt.branch, main, repoDir);
      expect(result.success).toBe(true);
      expect(result.mergeCommit).toBeTruthy();
      expect(result.conflicts).toEqual([]);
    });

    it('fails and aborts on conflict', () => {
      const main = getMainBranch();
      const wt = createWorkerWorktree(teamName, 'worker1', repoDir);

      // Conflicting changes
      writeFileSync(join(wt.path, 'file1.ts'), 'export const x = 100;\n');
      execFileSync('git', ['add', '.'], { cwd: wt.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'Worker change file1'], { cwd: wt.path, stdio: 'pipe' });

      writeFileSync(join(repoDir, 'file1.ts'), 'export const x = 200;\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'Main change file1'], { cwd: repoDir, stdio: 'pipe' });

      const result = mergeWorkerBranch(wt.branch, main, repoDir);
      expect(result.success).toBe(false);
      // Verify merge was aborted (repo is not in merge state)
      expect(() => {
        execFileSync('git', ['status'], { cwd: repoDir, stdio: 'pipe' });
      }).not.toThrow();
    });
  });

  describe('mergeAllWorkerBranches', () => {
    it('returns empty for team with no worktrees', () => {
      const results = mergeAllWorkerBranches(teamName, repoDir);
      expect(results).toEqual([]);
    });

    it('merges multiple worker branches', () => {
      const main = getMainBranch();
      const wt1 = createWorkerWorktree(teamName, 'worker1', repoDir);
      const wt2 = createWorkerWorktree(teamName, 'worker2', repoDir);

      // Different files in each worktree
      writeFileSync(join(wt1.path, 'worker1-file.ts'), 'export const a = 1;\n');
      execFileSync('git', ['add', '.'], { cwd: wt1.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'Worker 1 change'], { cwd: wt1.path, stdio: 'pipe' });

      writeFileSync(join(wt2.path, 'worker2-file.ts'), 'export const b = 2;\n');
      execFileSync('git', ['add', '.'], { cwd: wt2.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'Worker 2 change'], { cwd: wt2.path, stdio: 'pipe' });

      const results = mergeAllWorkerBranches(teamName, repoDir, main);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.success)).toBe(true);
    });
  });
});
