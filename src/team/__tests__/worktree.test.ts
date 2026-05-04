import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ensureWorktree,
  parseWorktreeMode,
  planWorktreeTarget,
  rollbackProvisionedWorktrees,
} from '../worktree.js';

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omc-worktree-test-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

async function cleanupRepo(repo: string): Promise<void> {
  await rm(`${repo}.omx-worktrees`, { recursive: true, force: true });
  await rm(join(repo, '.omx', 'worktrees'), { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('worktree parser', () => {
  it('parses detached mode from --worktree', () => {
    const parsed = parseWorktreeMode(['--worktree', '--yolo']);
    expect(parsed.mode).toEqual({ enabled: true, detached: true, name: null });
    expect(parsed.remainingArgs).toEqual(['--yolo']);
  });

  it('parses named branch forms without leaking branch args', () => {
    expect(parseWorktreeMode(['--worktree=feature/foo', 'task'])).toEqual({
      mode: { enabled: true, detached: false, name: 'feature/foo' },
      remainingArgs: ['task'],
    });
    expect(parseWorktreeMode(['--worktree', 'feat/issue-203', '--yolo'])).toEqual({
      mode: { enabled: true, detached: false, name: 'feat/issue-203' },
      remainingArgs: ['--yolo'],
    });
    expect(parseWorktreeMode(['-w', 'my-branch'])).toEqual({
      mode: { enabled: true, detached: false, name: 'my-branch' },
      remainingArgs: [],
    });
  });

  it('keeps args unchanged when worktree flag is absent', () => {
    const parsed = parseWorktreeMode(['team', '2:executor', 'task']);
    expect(parsed.mode).toEqual({ enabled: false });
    expect(parsed.remainingArgs).toEqual(['team', '2:executor', 'task']);
  });
});

describe('worktree planning', () => {
  it('plans dedicated autoresearch branch and path naming', async () => {
    const repo = await initRepo();
    try {
      const planned = planWorktreeTarget({
        cwd: repo,
        scope: 'autoresearch' as never,
        mode: { enabled: true, detached: false, name: 'demo-mission' },
        worktreeTag: '20260314T000000Z',
      });
      expect(planned.enabled).toBe(true);
      if (!planned.enabled) return;

      expect(planned.branchName).toBe('autoresearch/demo-mission/20260314t000000z');
      expect(planned.worktreePath.replace(/\\/g, '/')).toMatch(/\.omx\/worktrees\/autoresearch-demo-mission-20260314t000000z$/);
    } finally {
      await cleanupRepo(repo);
    }
  });
});

describe('worktree ensure + rollback', () => {
  it('creates and reuses detached worktree idempotently', async () => {
    const repo = await initRepo();
    try {
      const planned = planWorktreeTarget({ cwd: repo, scope: 'launch', mode: { enabled: true, detached: true, name: null } });
      expect(planned.enabled).toBe(true);
      if (!planned.enabled) return;

      const created = ensureWorktree(planned);
      expect(created.enabled).toBe(true);
      if (!created.enabled) return;
      expect(created.created).toBe(true);
      expect(existsSync(created.worktreePath)).toBe(true);

      const reused = ensureWorktree(planned);
      expect(reused.enabled).toBe(true);
      if (!reused.enabled) return;
      expect(reused.reused).toBe(true);
      expect(reused.created).toBe(false);
    } finally {
      await cleanupRepo(repo);
    }
  });

  it('records named launch baselines under .omc/state', async () => {
    const repo = await initRepo();
    try {
      const planned = planWorktreeTarget({ cwd: repo, scope: 'launch', mode: { enabled: true, detached: false, name: 'feature/baseline' } });
      expect(planned.enabled).toBe(true);
      if (!planned.enabled) return;

      const created = ensureWorktree(planned);
      expect(created.enabled).toBe(true);
      if (!created.enabled) return;
      expect(existsSync(join(repo, '.omc', 'state', 'current-task-baseline.json'))).toBe(true);
    } finally {
      await cleanupRepo(repo);
    }
  });

  it('rejects reusing a dirty worktree unless explicitly allowed', async () => {
    const repo = await initRepo();
    try {
      const planned = planWorktreeTarget({ cwd: repo, scope: 'launch', mode: { enabled: true, detached: true, name: null } });
      expect(planned.enabled).toBe(true);
      if (!planned.enabled) return;

      const created = ensureWorktree(planned);
      expect(created.enabled).toBe(true);
      if (!created.enabled) return;

      await writeFile(join(created.worktreePath, 'DIRTY.txt'), 'dirty\n', 'utf-8');
      expect(() => ensureWorktree(planned)).toThrow(/worktree_dirty/);
      const reused = ensureWorktree(planned, { allowDirtyReuse: true });
      expect(reused.enabled).toBe(true);
      if (!reused.enabled) return;
      expect(reused.dirty).toBe(true);
    } finally {
      await cleanupRepo(repo);
    }
  });

  it('creates per-worker named branch and blocks branch-in-use collisions', async () => {
    const repo = await initRepo();
    try {
      const workerPlan = planWorktreeTarget({
        cwd: repo,
        scope: 'team',
        mode: { enabled: true, detached: false, name: 'feat' },
        teamName: 'alpha',
        workerName: 'worker-1',
      });
      expect(workerPlan.enabled).toBe(true);
      if (!workerPlan.enabled) return;

      const created = ensureWorktree(workerPlan);
      expect(created.enabled).toBe(true);
      if (!created.enabled) return;
      expect(created.created).toBe(true);
      expect(created.createdBranch).toBe(true);
      expect(branchExists(repo, 'feat/worker-1')).toBe(true);

      const conflictingLaunchPlan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feat/worker-1' },
      });
      expect(conflictingLaunchPlan.enabled).toBe(true);
      if (!conflictingLaunchPlan.enabled) return;

      expect(() => ensureWorktree(conflictingLaunchPlan)).toThrow(/branch_in_use/);
    } finally {
      await cleanupRepo(repo);
    }
  });

  it('reuses existing worktree when target path already exists as a valid alias', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({ cwd: repo, scope: 'launch', mode: { enabled: true, detached: false, name: 'feature/reuse-alias' } });
      expect(plan.enabled).toBe(true);
      if (!plan.enabled) return;

      const created = ensureWorktree(plan);
      expect(created.enabled).toBe(true);
      if (!created.enabled) return;

      const aliasPath = `${created.worktreePath}-alias`;
      await symlink(created.worktreePath, aliasPath);

      const reused = ensureWorktree({ ...plan, worktreePath: aliasPath });
      expect(reused.enabled).toBe(true);
      if (!reused.enabled) return;
      expect(reused.reused).toBe(true);
      expect(reused.created).toBe(false);
    } finally {
      await cleanupRepo(repo);
    }
  });

  it('rollback removes newly created worktree and branch unless branch deletion is skipped', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({ cwd: repo, scope: 'launch', mode: { enabled: true, detached: false, name: 'feature/rollback' } });
      expect(plan.enabled).toBe(true);
      if (!plan.enabled) return;

      const ensured = ensureWorktree(plan);
      expect(ensured.enabled).toBe(true);
      if (!ensured.enabled) return;
      expect(existsSync(ensured.worktreePath)).toBe(true);
      expect(branchExists(repo, 'feature/rollback')).toBe(true);

      await rollbackProvisionedWorktrees([ensured]);
      expect(existsSync(ensured.worktreePath)).toBe(false);
      expect(branchExists(repo, 'feature/rollback')).toBe(false);
    } finally {
      await cleanupRepo(repo);
    }
  });
});
