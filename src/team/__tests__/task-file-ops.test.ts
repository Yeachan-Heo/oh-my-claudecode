import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, utimesSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  readTask, updateTask, findNextTask, areBlockersResolved,
  writeTaskFailure, readTaskFailure, listTaskIds, isTaskRetryExhausted,
  acquireTaskLock, releaseTaskLock, withTaskLock,
} from '../task-file-ops.js';
import type { TaskFile } from '../types.js';
import type { LockHandle } from '../task-file-ops.js';

const TEST_TEAM = 'test-team-ops';
const TASKS_DIR = join(homedir(), '.claude', 'tasks', TEST_TEAM);

function writeTask(task: TaskFile): void {
  mkdirSync(TASKS_DIR, { recursive: true });
  writeFileSync(join(TASKS_DIR, `${task.id}.json`), JSON.stringify(task, null, 2));
}

/** Remove all .lock files from the test tasks directory */
function cleanupLocks(): void {
  if (!existsSync(TASKS_DIR)) return;
  for (const f of readdirSync(TASKS_DIR)) {
    if (f.endsWith('.lock')) {
      try { rmSync(join(TASKS_DIR, f), { force: true }); } catch { /* ignore */ }
    }
  }
}

beforeEach(() => {
  mkdirSync(TASKS_DIR, { recursive: true });
});

afterEach(() => {
  cleanupLocks();
  rmSync(TASKS_DIR, { recursive: true, force: true });
});

describe('readTask', () => {
  it('reads existing task', () => {
    const task: TaskFile = {
      id: '1', subject: 'Test', description: 'Desc', status: 'pending',
      owner: 'worker1', blocks: [], blockedBy: [],
    };
    writeTask(task);
    const result = readTask(TEST_TEAM, '1');
    expect(result).toEqual(task);
  });

  it('returns null for missing task', () => {
    expect(readTask(TEST_TEAM, 'nonexistent')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    mkdirSync(TASKS_DIR, { recursive: true });
    writeFileSync(join(TASKS_DIR, 'bad.json'), '{invalid json');
    expect(readTask(TEST_TEAM, 'bad')).toBeNull();
  });
});

describe('updateTask', () => {
  it('updates status while preserving other fields', () => {
    const task: TaskFile = {
      id: '1', subject: 'Test', description: 'Desc', status: 'pending',
      owner: 'worker1', blocks: [], blockedBy: [],
    };
    writeTask(task);
    updateTask(TEST_TEAM, '1', { status: 'in_progress' });
    const result = readTask(TEST_TEAM, '1');
    expect(result?.status).toBe('in_progress');
    expect(result?.subject).toBe('Test');
  });

  it('preserves unknown fields', () => {
    mkdirSync(TASKS_DIR, { recursive: true });
    const taskWithExtra = { id: '1', subject: 'Test', description: 'Desc', status: 'pending', owner: 'w', blocks: [], blockedBy: [], customField: 'keep' };
    writeFileSync(join(TASKS_DIR, '1.json'), JSON.stringify(taskWithExtra));
    updateTask(TEST_TEAM, '1', { status: 'completed' });
    const raw = JSON.parse(readFileSync(join(TASKS_DIR, '1.json'), 'utf-8'));
    expect(raw.customField).toBe('keep');
    expect(raw.status).toBe('completed');
  });

  it('works with useLock=false', () => {
    const task: TaskFile = {
      id: '1', subject: 'Test', description: 'Desc', status: 'pending',
      owner: 'w1', blocks: [], blockedBy: [],
    };
    writeTask(task);
    updateTask(TEST_TEAM, '1', { status: 'in_progress' }, { useLock: false });
    expect(readTask(TEST_TEAM, '1')?.status).toBe('in_progress');
  });

  it('falls back gracefully when lock is held by another caller', () => {
    const task: TaskFile = {
      id: '1', subject: 'Test', description: 'Desc', status: 'pending',
      owner: 'w1', blocks: [], blockedBy: [],
    };
    writeTask(task);
    // Hold the lock
    const handle = acquireTaskLock(TEST_TEAM, '1');
    expect(handle).not.toBeNull();
    // updateTask should still succeed (fallback without lock)
    updateTask(TEST_TEAM, '1', { status: 'in_progress' });
    expect(readTask(TEST_TEAM, '1')?.status).toBe('in_progress');
    releaseTaskLock(handle!);
  });
});

describe('findNextTask', () => {
  it('finds pending task assigned to worker and claims it', async () => {
    writeTask({ id: '1', subject: 'T1', description: 'D', status: 'pending', owner: 'w1', blocks: [], blockedBy: [] });
    const result = await findNextTask(TEST_TEAM, 'w1');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('1');
    expect(result?.status).toBe('in_progress');
    expect(result?.claimedBy).toBe('w1');
    expect(result?.claimPid).toBe(process.pid);
  });

  it('skips completed tasks', async () => {
    writeTask({ id: '1', subject: 'T1', description: 'D', status: 'completed', owner: 'w1', blocks: [], blockedBy: [] });
    expect(await findNextTask(TEST_TEAM, 'w1')).toBeNull();
  });

  it('skips tasks owned by other workers', async () => {
    writeTask({ id: '1', subject: 'T1', description: 'D', status: 'pending', owner: 'w2', blocks: [], blockedBy: [] });
    expect(await findNextTask(TEST_TEAM, 'w1')).toBeNull();
  });

  it('skips tasks with unresolved blockers', async () => {
    writeTask({ id: '1', subject: 'T1', description: 'D', status: 'pending', owner: 'w1', blocks: [], blockedBy: [] });
    writeTask({ id: '2', subject: 'T2', description: 'D', status: 'pending', owner: 'w1', blocks: [], blockedBy: ['1'] });
    const result = await findNextTask(TEST_TEAM, 'w1');
    expect(result?.id).toBe('1');
  });

  it('returns blocked task when blockers resolved', async () => {
    writeTask({ id: '1', subject: 'T1', description: 'D', status: 'completed', owner: 'w1', blocks: [], blockedBy: [] });
    writeTask({ id: '2', subject: 'T2', description: 'D', status: 'pending', owner: 'w1', blocks: [], blockedBy: ['1'] });
    const result = await findNextTask(TEST_TEAM, 'w1');
    expect(result?.id).toBe('2');
  });

  it('returns null for empty dir', async () => {
    expect(await findNextTask(TEST_TEAM, 'w1')).toBeNull();
  });

  it('writes claim marker with claimedBy and claimPid', async () => {
    writeTask({ id: '1', subject: 'T1', description: 'D', status: 'pending', owner: 'w1', blocks: [], blockedBy: [] });
    const result = await findNextTask(TEST_TEAM, 'w1');
    expect(result).not.toBeNull();
    const raw = JSON.parse(readFileSync(join(TASKS_DIR, '1.json'), 'utf-8'));
    expect(raw.claimedBy).toBe('w1');
    expect(raw.claimPid).toBe(process.pid);
    expect(typeof raw.claimedAt).toBe('number');
    expect(raw.status).toBe('in_progress');
  });

  it('sets task status to in_progress on disk', async () => {
    writeTask({ id: '1', subject: 'T1', description: 'D', status: 'pending', owner: 'w1', blocks: [], blockedBy: [] });
    await findNextTask(TEST_TEAM, 'w1');
    const raw = JSON.parse(readFileSync(join(TASKS_DIR, '1.json'), 'utf-8'));
    expect(raw.status).toBe('in_progress');
  });

  it('lock file is cleaned up after claiming', async () => {
    writeTask({ id: '1', subject: 'T1', description: 'D', status: 'pending', owner: 'w1', blocks: [], blockedBy: [] });
    await findNextTask(TEST_TEAM, 'w1');
    expect(existsSync(join(TASKS_DIR, '1.lock'))).toBe(false);
  });

  it('prevents double-claim: second sequential call returns null', async () => {
    writeTask({ id: '1', subject: 'T1', description: 'D', status: 'pending', owner: 'w1', blocks: [], blockedBy: [] });
    const first = await findNextTask(TEST_TEAM, 'w1');
    expect(first).not.toBeNull();
    // Task is now in_progress — second call should find nothing pending
    const second = await findNextTask(TEST_TEAM, 'w1');
    expect(second).toBeNull();
  });
});

describe('acquireTaskLock / releaseTaskLock', () => {
  it('acquires and releases a lock', () => {
    const handle = acquireTaskLock(TEST_TEAM, 'lock-test-1');
    expect(handle).not.toBeNull();
    expect(existsSync(handle!.path)).toBe(true);
    releaseTaskLock(handle!);
    expect(existsSync(handle!.path)).toBe(false);
  });

  it('second acquire fails while first is held', () => {
    const handle1 = acquireTaskLock(TEST_TEAM, 'lock-test-2');
    expect(handle1).not.toBeNull();
    const handle2 = acquireTaskLock(TEST_TEAM, 'lock-test-2');
    expect(handle2).toBeNull();
    releaseTaskLock(handle1!);
  });

  it('lock is re-acquirable after release', () => {
    const handle1 = acquireTaskLock(TEST_TEAM, 'lock-test-3');
    expect(handle1).not.toBeNull();
    releaseTaskLock(handle1!);
    const handle2 = acquireTaskLock(TEST_TEAM, 'lock-test-3');
    expect(handle2).not.toBeNull();
    releaseTaskLock(handle2!);
  });

  it('lock file contains PID and workerName payload', () => {
    const handle = acquireTaskLock(TEST_TEAM, 'lock-test-4', { workerName: 'test-worker' });
    expect(handle).not.toBeNull();
    const raw = readFileSync(handle!.path, 'utf-8');
    const payload = JSON.parse(raw);
    expect(payload.pid).toBe(process.pid);
    expect(payload.workerName).toBe('test-worker');
    expect(typeof payload.timestamp).toBe('number');
    releaseTaskLock(handle!);
  });

  it('reaps stale lock with dead PID and expired age', () => {
    // Create a fake stale lock file with a dead PID
    mkdirSync(TASKS_DIR, { recursive: true });
    const lockPath = join(TASKS_DIR, 'lock-test-5.lock');
    // PID 999999999 is almost certainly dead
    const stalePayload = JSON.stringify({ pid: 999999999, workerName: 'dead-worker', timestamp: Date.now() - 60_000 });
    writeFileSync(lockPath, stalePayload, { mode: 0o600 });
    // Backdate the file's mtime so isLockStale sees it as old
    const pastTime = new Date(Date.now() - 60_000);
    utimesSync(lockPath, pastTime, pastTime);
    const handle = acquireTaskLock(TEST_TEAM, 'lock-test-5', { staleLockMs: 1000 });
    expect(handle).not.toBeNull();
    releaseTaskLock(handle!);
  });

  it('does NOT reap lock held by live PID (our own process)', () => {
    // Create a lock file with our own PID (definitely alive)
    mkdirSync(TASKS_DIR, { recursive: true });
    const lockPath = join(TASKS_DIR, 'lock-test-6.lock');
    const livePayload = JSON.stringify({ pid: process.pid, workerName: 'live-worker', timestamp: Date.now() - 60_000 });
    writeFileSync(lockPath, livePayload, { mode: 0o600 });
    // Even with staleLockMs=1, should NOT reap because PID is alive
    const handle = acquireTaskLock(TEST_TEAM, 'lock-test-6', { staleLockMs: 1 });
    expect(handle).toBeNull();
    // Clean up the manually created lock
    try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }
  });

  it('handles malformed lock file as stale when old enough', () => {
    mkdirSync(TASKS_DIR, { recursive: true });
    const lockPath = join(TASKS_DIR, 'lock-test-7.lock');
    writeFileSync(lockPath, 'not valid json', { mode: 0o600 });
    // With staleLockMs=1, malformed file should be treated as stale
    const handle = acquireTaskLock(TEST_TEAM, 'lock-test-7', { staleLockMs: 1 });
    expect(handle).not.toBeNull();
    releaseTaskLock(handle!);
  });
});

describe('withTaskLock', () => {
  it('executes function while holding lock', async () => {
    let executed = false;
    const result = await withTaskLock(TEST_TEAM, 'with-lock-1', () => {
      executed = true;
      return 42;
    });
    expect(executed).toBe(true);
    expect(result).toBe(42);
  });

  it('returns null when lock cannot be acquired', async () => {
    const handle = acquireTaskLock(TEST_TEAM, 'with-lock-2');
    expect(handle).not.toBeNull();
    const result = await withTaskLock(TEST_TEAM, 'with-lock-2', () => 42);
    expect(result).toBeNull();
    releaseTaskLock(handle!);
  });

  it('releases lock even if function throws', async () => {
    const lockPath = join(TASKS_DIR, 'with-lock-3.lock');
    await expect(
      withTaskLock(TEST_TEAM, 'with-lock-3', () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');
    // Lock file should be cleaned up
    expect(existsSync(lockPath)).toBe(false);
  });

  it('works with async functions', async () => {
    const result = await withTaskLock(TEST_TEAM, 'with-lock-4', async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return 'async-result';
    });
    expect(result).toBe('async-result');
  });
});

describe('areBlockersResolved', () => {
  it('returns true for empty blockers', () => {
    expect(areBlockersResolved(TEST_TEAM, [])).toBe(true);
  });

  it('returns true when all blockers completed', () => {
    writeTask({ id: '1', subject: 'T', description: 'D', status: 'completed', owner: 'w', blocks: [], blockedBy: [] });
    expect(areBlockersResolved(TEST_TEAM, ['1'])).toBe(true);
  });

  it('returns false when blocker still pending', () => {
    writeTask({ id: '1', subject: 'T', description: 'D', status: 'pending', owner: 'w', blocks: [], blockedBy: [] });
    expect(areBlockersResolved(TEST_TEAM, ['1'])).toBe(false);
  });
});

describe('writeTaskFailure / readTaskFailure', () => {
  it('creates failure sidecar', () => {
    writeTaskFailure(TEST_TEAM, '1', 'timeout error');
    const failure = readTaskFailure(TEST_TEAM, '1');
    expect(failure?.taskId).toBe('1');
    expect(failure?.lastError).toBe('timeout error');
    expect(failure?.retryCount).toBe(1);
  });

  it('increments retryCount', () => {
    writeTaskFailure(TEST_TEAM, '1', 'err1');
    writeTaskFailure(TEST_TEAM, '1', 'err2');
    const failure = readTaskFailure(TEST_TEAM, '1');
    expect(failure?.retryCount).toBe(2);
    expect(failure?.lastError).toBe('err2');
  });

  it('returns null for missing sidecar', () => {
    expect(readTaskFailure(TEST_TEAM, '999')).toBeNull();
  });
});

describe('listTaskIds', () => {
  it('lists task IDs sorted numerically', () => {
    writeTask({ id: '3', subject: 'T', description: 'D', status: 'pending', owner: 'w', blocks: [], blockedBy: [] });
    writeTask({ id: '1', subject: 'T', description: 'D', status: 'pending', owner: 'w', blocks: [], blockedBy: [] });
    writeTask({ id: '2', subject: 'T', description: 'D', status: 'pending', owner: 'w', blocks: [], blockedBy: [] });
    expect(listTaskIds(TEST_TEAM)).toEqual(['1', '2', '3']);
  });

  it('excludes tmp, failure, and lock files', () => {
    writeTask({ id: '1', subject: 'T', description: 'D', status: 'pending', owner: 'w', blocks: [], blockedBy: [] });
    writeFileSync(join(TASKS_DIR, '1.json.tmp.123'), '{}');
    writeFileSync(join(TASKS_DIR, '1.failure.json'), '{}');
    writeFileSync(join(TASKS_DIR, '1.lock'), '{}');
    expect(listTaskIds(TEST_TEAM)).toEqual(['1']);
  });

  it('returns empty for nonexistent team', () => {
    expect(listTaskIds('nonexistent_team_xyz')).toEqual([]);
  });
});

describe('isTaskRetryExhausted', () => {
  it('returns true after 5 failures (default max)', () => {
    for (let i = 0; i < 5; i++) {
      writeTaskFailure(TEST_TEAM, '1', `error-${i}`);
    }
    expect(isTaskRetryExhausted(TEST_TEAM, '1')).toBe(true);
  });

  it('returns false after 4 failures (below default max)', () => {
    for (let i = 0; i < 4; i++) {
      writeTaskFailure(TEST_TEAM, '1', `error-${i}`);
    }
    expect(isTaskRetryExhausted(TEST_TEAM, '1')).toBe(false);
  });

  it('returns false when no failure sidecar exists', () => {
    expect(isTaskRetryExhausted(TEST_TEAM, '999')).toBe(false);
  });

  it('respects custom maxRetries parameter', () => {
    for (let i = 0; i < 3; i++) {
      writeTaskFailure(TEST_TEAM, '1', `error-${i}`);
    }
    expect(isTaskRetryExhausted(TEST_TEAM, '1', 3)).toBe(true);
    expect(isTaskRetryExhausted(TEST_TEAM, '1', 4)).toBe(false);
  });
});
