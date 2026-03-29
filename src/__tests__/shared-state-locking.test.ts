/**
 * Regression tests for race condition bug fixes.
 *
 * BUG 1: shared-state updateSharedTask has no file locking
 * BUG 2: git-worktree removeWorkerWorktree has unlocked metadata update
 * BUG 3: team-ops teamCreateTask has race on task ID generation
 * BUG 4: generateJobId not collision-safe
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
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

