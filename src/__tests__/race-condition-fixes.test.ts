/**
 * Regression tests for race condition bug fixes.
 *
 * BUG 1: shared-state updateSharedTask has no file locking
 * BUG 2: git-worktree removeWorkerWorktree has unlocked metadata update
 * BUG 3: team-ops teamCreateTask has race on task ID generation
 * BUG 4: generateJobId not collision-safe
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// BUG 1: shared-state updateSharedTask must use file locking
// ---------------------------------------------------------------------------

describe('shared-state updateSharedTask locking', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'shared-state-lock-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('updateSharedTask uses withFileLockSync for read-modify-write', async () => {
    // Verify the source code contains the locking pattern
    const sourcePath = join(__dirname, '..', 'interop', 'shared-state.ts');
    const source = readFileSync(sourcePath, 'utf-8');

    // Must import withFileLockSync
    expect(source).toContain("import { withFileLockSync } from '../lib/file-lock.js'");

    // The updateSharedTask function must use withFileLockSync
    const fnMatch = source.match(/export function updateSharedTask[\s\S]*?^}/m);
    expect(fnMatch).toBeTruthy();
    const fnBody = fnMatch![0];
    expect(fnBody).toContain('withFileLockSync');
    expect(fnBody).toContain("taskPath + '.lock'");
  });

  it('updateSharedTask functionally updates a task with locking', async () => {
    const { addSharedTask, updateSharedTask, initInteropSession } = await import(
      '../interop/shared-state.js'
    );

    initInteropSession('test-session', tempDir);

    const task = addSharedTask(tempDir, {
      source: 'omc',
      target: 'omx',
      type: 'analyze',
      description: 'test task for locking',
    });

    const updated = updateSharedTask(tempDir, task.id, {
      status: 'completed',
      result: 'done',
    });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('completed');
    expect(updated!.result).toBe('done');
    expect(updated!.completedAt).toBeTruthy();

    // Verify lock file does not persist after operation
    const lockPath = join(
      tempDir, '.omc', 'state', 'interop', 'tasks', `${task.id}.json.lock`,
    );
    expect(existsSync(lockPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BUG 2: git-worktree removeWorkerWorktree must use file locking
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// BUG 3: team-ops teamCreateTask must use locking for task ID generation
// ---------------------------------------------------------------------------

describe('team-ops teamCreateTask locking', () => {
  let tempDir: string;
  const teamName = 'lock-test-team';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'team-ops-lock-test-'));
    // Set up minimal team config
    const root = join(tempDir, '.omc', 'state', 'team', teamName);
    mkdirSync(join(root, 'tasks'), { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      name: teamName,
      task: 'test',
      agent_type: 'executor',
      worker_count: 1,
      max_workers: 20,
      tmux_session: 'test-session',
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
      created_at: new Date().toISOString(),
      next_task_id: 1,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    }));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('teamCreateTask source uses locking around task creation', () => {
    const sourcePath = join(__dirname, '..', 'team', 'team-ops.ts');
    const source = readFileSync(sourcePath, 'utf-8');

    // Extract the teamCreateTask function
    const fnStart = source.indexOf('export async function teamCreateTask');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, fnStart + 2000);

    // Must use locking (either withLock or withFileLockSync)
    expect(fnBody).toContain('withLock');
    expect(fnBody).toContain('lock-create-task');
  });

  it('two sequential task creations produce different IDs', async () => {
    const { teamCreateTask } = await import('../team/team-ops.js');

    const task1 = await teamCreateTask(
      teamName,
      { subject: 'Task A', description: 'first', status: 'pending' as const },
      tempDir,
    );

    const task2 = await teamCreateTask(
      teamName,
      { subject: 'Task B', description: 'second', status: 'pending' as const },
      tempDir,
    );

    expect(task1.id).not.toBe(task2.id);
    expect(Number(task1.id)).toBeLessThan(Number(task2.id));
  });

  it('concurrent task creations produce different IDs', async () => {
    const { teamCreateTask } = await import('../team/team-ops.js');

    const results = await Promise.all([
      teamCreateTask(teamName, { subject: 'Task 1', description: 'c1', status: 'pending' as const }, tempDir),
      teamCreateTask(teamName, { subject: 'Task 2', description: 'c2', status: 'pending' as const }, tempDir),
      teamCreateTask(teamName, { subject: 'Task 3', description: 'c3', status: 'pending' as const }, tempDir),
    ]);

    const ids = results.map(t => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// BUG 4: generateJobId must be collision-safe
// ---------------------------------------------------------------------------

describe('generateJobId collision safety', () => {
  it('generateJobId includes randomness for uniqueness', () => {
    const sourcePath = join(__dirname, '..', 'cli', 'team.ts');
    const source = readFileSync(sourcePath, 'utf-8');

    // Extract the generateJobId function
    const fnMatch = source.match(/function generateJobId[\s\S]*?\n}/);
    expect(fnMatch).toBeTruthy();
    const fnBody = fnMatch![0];

    // Must include randomness (randomUUID or similar)
    expect(fnBody).toContain('randomUUID');
  });

  it('100 rapid calls produce 100 unique IDs', async () => {
    const { generateJobId } = await import('../cli/team.js');

    const ids = new Set<string>();
    const fixedTime = Date.now();
    for (let i = 0; i < 100; i++) {
      ids.add(generateJobId(fixedTime));
    }

    expect(ids.size).toBe(100);
  });

  it('generated IDs match the updated JOB_ID_PATTERN', async () => {
    const { generateJobId } = await import('../cli/team.js');
    const JOB_ID_PATTERN = /^omc-[a-z0-9]{1,16}$/;

    for (let i = 0; i < 50; i++) {
      const id = generateJobId();
      expect(JOB_ID_PATTERN.test(id)).toBe(true);
    }
  });

  it('generateJobId uses 8+ hex chars of randomness', async () => {
    const { generateJobId } = await import('../cli/team.js');

    const fixedTime = Date.now();
    const id = generateJobId(fixedTime);
    const prefix = `omc-${fixedTime.toString(36)}`;
    const randomPart = id.slice(prefix.length);

    // Must have at least 8 chars of randomness
    expect(randomPart.length).toBeGreaterThanOrEqual(8);
  });
});
