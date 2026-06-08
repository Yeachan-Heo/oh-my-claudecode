import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { checkMergeConflicts, mergeWorkerBranch, mergeAllWorkerBranches, configureHarnessMergeAttributes, HARNESS_MERGE_PATHS } from '../merge-coordinator.js';
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

describe('harness-file auto-merge (#3224)', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'harness-merge-test-'));
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
    // Base tree with a tracked harness file (AGENTS.md) and a task file.
    writeFileSync(join(repoDir, 'AGENTS.md'), 'base agents\n');
    writeFileSync(join(repoDir, 'app.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  function mainBranch(): string {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoDir, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
  }

  function commitAll(cwd: string, message: string): void {
    execFileSync('git', ['add', '-A'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', message], { cwd, stdio: 'pipe' });
  }

  it('configureHarnessMergeAttributes registers the driver and is idempotent', () => {
    configureHarnessMergeAttributes(repoDir);
    configureHarnessMergeAttributes(repoDir);

    const driver = execFileSync('git', ['config', '--get', 'merge.ours.driver'], {
      cwd: repoDir, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
    expect(driver).toBe('true');

    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repoDir, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
    const attrPath = join(repoDir, commonDir, 'info', 'attributes');
    const lines = readFileSync(attrPath, 'utf-8').split('\n').filter((l) => l.trim());
    for (const p of HARNESS_MERGE_PATHS) {
      // Each harness path appears exactly once despite two calls.
      expect(lines.filter((l) => l === `${p} merge=ours`)).toHaveLength(1);
    }
  });

  it('auto-resolves AGENTS.md conflict so disjoint task work still merges', () => {
    const main = mainBranch();

    // Worker branch: per-worker AGENTS.md overlay + real disjoint work.
    execFileSync('git', ['checkout', '-q', '-b', 'wkr'], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(join(repoDir, 'AGENTS.md'), 'worker overlay\n');
    writeFileSync(join(repoDir, 'feature.ts'), 'export const y = 2;\n');
    commitAll(repoDir, 'worker change');

    // Leader branch independently changed the same harness file (e.g. an
    // earlier worker already merged its overlay).
    execFileSync('git', ['checkout', '-q', main], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(join(repoDir, 'AGENTS.md'), 'leader overlay\n');
    commitAll(repoDir, 'leader change');

    // Without the driver this is a hard AGENTS.md conflict.
    expect(checkMergeConflicts('wkr', main, repoDir)).toContain('AGENTS.md');

    configureHarnessMergeAttributes(repoDir);

    const result = mergeWorkerBranch('wkr', main, repoDir);
    expect(result.success).toBe(true);
    expect(result.conflicts).toEqual([]);
    // The real task work survived the merge.
    expect(readFileSync(join(repoDir, 'feature.ts'), 'utf-8')).toContain('export const y = 2;');
    // Harness file kept the leader-side ("ours") content.
    expect(readFileSync(join(repoDir, 'AGENTS.md'), 'utf-8')).toBe('leader overlay\n');
  });

  it('still fails on genuine conflicts in task files', () => {
    const main = mainBranch();

    execFileSync('git', ['checkout', '-q', '-b', 'wkr2'], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(join(repoDir, 'app.ts'), 'export const x = 100;\n');
    commitAll(repoDir, 'worker task change');

    execFileSync('git', ['checkout', '-q', main], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(join(repoDir, 'app.ts'), 'export const x = 200;\n');
    commitAll(repoDir, 'leader task change');

    configureHarnessMergeAttributes(repoDir);

    const result = mergeWorkerBranch('wkr2', main, repoDir);
    expect(result.success).toBe(false);
    expect(result.conflicts).toContain('app.ts');
  });
});
