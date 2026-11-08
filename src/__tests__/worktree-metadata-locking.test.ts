import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

describe('git-worktree removeWorkerWorktree locking', () => {
  let repoDir: string;
  const teamName = 'lock-test-wt';

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'git-worktree-lock-test-'));
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(join(repoDir, 'README.md'), '# Test\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir, stdio: 'pipe' });
  });

  afterEach(() => {
    try {
      const { cleanupTeamWorktrees } = require('../team/git-worktree.js');
      cleanupTeamWorktrees(teamName, repoDir);
    } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('removeWorkerWorktree uses withFileLockSync for metadata update', () => {
    const sourcePath = join(__dirname, '..', 'team', 'git-worktree.ts');
    const source = readFileSync(sourcePath, 'utf-8');

    // Extract the removeWorkerWorktree function
    const fnStart = source.indexOf('export function removeWorkerWorktree');
    expect(fnStart).toBeGreaterThan(-1);

    // Find the matching closing brace
    const fnBody = source.slice(fnStart);
    const bodyEnd = fnBody.indexOf('\n}\n');
    const fnContent = fnBody.slice(0, bodyEnd + 2);

    // Must contain withFileLockSync for metadata update
    expect(fnContent).toContain('withFileLockSync');
    expect(fnContent).toContain('metaLockPath');
  });

  it('removeWorkerWorktree correctly removes metadata entries', async () => {
    const { createWorkerWorktree, removeWorkerWorktree, listTeamWorktrees } = await import(
      '../team/git-worktree.js'
    );

    createWorkerWorktree(teamName, 'worker-a', repoDir);
    createWorkerWorktree(teamName, 'worker-b', repoDir);
    expect(listTeamWorktrees(teamName, repoDir)).toHaveLength(2);

    removeWorkerWorktree(teamName, 'worker-a', repoDir);

    const remaining = listTeamWorktrees(teamName, repoDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].workerName).toBe('worker-b');
  });
});
