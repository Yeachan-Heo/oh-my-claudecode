// src/team/task-file-ops.ts

/**
 * Task File Operations for MCP Team Bridge
 *
 * Read/write/scan task JSON files with atomic writes (temp + rename).
 * Tasks live at ~/.claude/tasks/{teamName}/{id}.json
 */

import { readFileSync, readdirSync, existsSync, openSync, closeSync, unlinkSync, writeSync, statSync, constants as fsConstants } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { TaskFile, TaskFileUpdate, TaskFailureSidecar } from './types.js';
import { sanitizeName } from './tmux-session.js';
import { atomicWriteJson, validateResolvedPath, ensureDirWithMode } from './fs-utils.js';

// ─── Lock-based atomic claiming ────────────────────────────────────────────

/** Handle returned by acquireTaskLock; pass to releaseTaskLock. */
export interface LockHandle {
  fd: number;
  path: string;
}

/** Default age (ms) after which a lock file is considered stale. */
const DEFAULT_STALE_LOCK_MS = 30_000;

/**
 * Check if a process with the given PID is alive.
 * Returns false for PIDs <= 0 or if kill(pid, 0) throws ESRCH.
 */
function isPidAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM means the process exists but we don't have permission — still alive
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'EPERM') return true;
    return false;
  }
}

/**
 * Try to acquire an exclusive lock file for a task.
 *
 * Uses O_CREAT|O_EXCL|O_WRONLY which atomically creates the file only if
 * it doesn't already exist — the kernel guarantees no two openers succeed.
 *
 * If the lock file already exists, checks for staleness (age > staleLockMs
 * AND owner PID is dead) and reaps if stale, retrying once.
 *
 * Returns a LockHandle on success, or null if the lock is held by another live worker.
 */
export function acquireTaskLock(
  teamName: string,
  taskId: string,
  opts?: { staleLockMs?: number; workerName?: string },
): LockHandle | null {
  const staleLockMs = opts?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const dir = tasksDir(teamName);
  ensureDirWithMode(dir);
  const lockPath = join(dir, `${sanitizeTaskId(taskId)}.lock`);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      // Write payload so stale-detection can read PID + timestamp
      const payload = JSON.stringify({
        pid: process.pid,
        workerName: opts?.workerName ?? '',
        timestamp: Date.now(),
      });
      writeSync(fd, payload, null, 'utf-8');
      return { fd, path: lockPath };
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EEXIST') {
        // Lock file exists — check if stale
        if (attempt === 0 && isLockStale(lockPath, staleLockMs)) {
          try { unlinkSync(lockPath); } catch { /* another worker reaped it */ }
          continue; // retry once
        }
        return null; // held by a live worker
      }
      throw err; // unexpected error — bubble up
    }
  }
  return null;
}

/**
 * Release a previously acquired task lock.
 * Closes the file descriptor and removes the lock file.
 */
export function releaseTaskLock(handle: LockHandle): void {
  try { closeSync(handle.fd); } catch { /* already closed */ }
  try { unlinkSync(handle.path); } catch { /* already removed */ }
}

/**
 * Execute a function while holding an exclusive task lock.
 * Returns the function's result, or null if the lock could not be acquired.
 */
export async function withTaskLock<T>(
  teamName: string,
  taskId: string,
  fn: () => T | Promise<T>,
  opts?: { staleLockMs?: number; workerName?: string },
): Promise<T | null> {
  const handle = acquireTaskLock(teamName, taskId, opts);
  if (!handle) return null;
  try {
    return await fn();
  } finally {
    releaseTaskLock(handle);
  }
}

/**
 * Check if an existing lock file is stale.
 * A lock is stale if it's older than staleLockMs AND the owning PID is dead.
 */
function isLockStale(lockPath: string, staleLockMs: number): boolean {
  try {
    const stat = statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < staleLockMs) return false;

    // Try to read PID from the lock payload
    try {
      const raw = readFileSync(lockPath, 'utf-8');
      const payload = JSON.parse(raw) as { pid?: number };
      if (payload.pid && isPidAlive(payload.pid)) return false;
    } catch {
      // Malformed or unreadable — treat as stale if old enough
    }
    return true;
  } catch {
    // Lock file disappeared between check and stat — not stale, just gone
    return false;
  }
}

// ─── End lock helpers ──────────────────────────────────────────────────────

/** Validate task ID to prevent path traversal */
function sanitizeTaskId(taskId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new Error(`Invalid task ID: "${taskId}" contains unsafe characters`);
  }
  return taskId;
}

/** Paths helper */
function tasksDir(teamName: string): string {
  const result = join(homedir(), '.claude', 'tasks', sanitizeName(teamName));
  validateResolvedPath(result, join(homedir(), '.claude', 'tasks'));
  return result;
}

function taskPath(teamName: string, taskId: string): string {
  return join(tasksDir(teamName), `${sanitizeTaskId(taskId)}.json`);
}

function failureSidecarPath(teamName: string, taskId: string): string {
  return join(tasksDir(teamName), `${sanitizeTaskId(taskId)}.failure.json`);
}

/** Read a single task file. Returns null if not found or malformed. */
export function readTask(teamName: string, taskId: string): TaskFile | null {
  const filePath = taskPath(teamName, taskId);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as TaskFile;
  } catch {
    return null;
  }
}

/**
 * Atomic update: reads full task JSON, patches specified fields, writes back.
 * Preserves unknown fields to avoid data loss.
 *
 * When useLock is true (default), wraps the read-modify-write in an O_EXCL
 * lock to prevent lost updates from concurrent writers. Falls back to
 * unlocked write if the lock cannot be acquired within a single attempt
 * (backward-compatible degradation with a console warning).
 */
export function updateTask(
  teamName: string,
  taskId: string,
  updates: TaskFileUpdate,
  opts?: { useLock?: boolean },
): void {
  const useLock = opts?.useLock ?? true;

  const doUpdate = () => {
    const filePath = taskPath(teamName, taskId);
    let task: Record<string, unknown>;
    try {
      const raw = readFileSync(filePath, 'utf-8');
      task = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`Task file not found or malformed: ${taskId}`);
    }
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        task[key] = value;
      }
    }
    atomicWriteJson(filePath, task);
  };

  if (!useLock) {
    doUpdate();
    return;
  }

  const handle = acquireTaskLock(teamName, taskId);
  if (!handle) {
    // Fallback: another worker holds the lock — proceed without lock + warn
    // This maintains backward compatibility while logging the degradation
    if (typeof process !== 'undefined' && process.stderr) {
      process.stderr.write(`[task-file-ops] WARN: could not acquire lock for task ${taskId}, updating without lock\n`);
    }
    doUpdate();
    return;
  }

  try {
    doUpdate();
  } finally {
    releaseTaskLock(handle);
  }
}

/**
 * Find next executable task for this worker.
 * Returns first task where:
 *   - owner === workerName
 *   - status === 'pending'
 *   - all blockedBy tasks have status 'completed'
 * Sorted by ID ascending.
 *
 * Uses O_EXCL lock files for atomic claiming — no sleep/jitter needed.
 * The kernel guarantees only one worker can create the lock file.
 */
export async function findNextTask(teamName: string, workerName: string): Promise<TaskFile | null> {
  const dir = tasksDir(teamName);
  if (!existsSync(dir)) return null;

  const taskIds = listTaskIds(teamName);

  for (const id of taskIds) {
    // Quick pre-check without lock (avoid lock overhead for obvious skips)
    const task = readTask(teamName, id);
    if (!task) continue;
    if (task.status !== 'pending') continue;
    if (task.owner !== workerName) continue;
    if (!areBlockersResolved(teamName, task.blockedBy)) continue;

    // Attempt atomic lock
    const handle = acquireTaskLock(teamName, id, { workerName });
    if (!handle) continue; // another worker holds the lock — skip

    try {
      // Re-read under lock to verify state hasn't changed
      const freshTask = readTask(teamName, id);
      if (
        !freshTask ||
        freshTask.status !== 'pending' ||
        freshTask.owner !== workerName ||
        !areBlockersResolved(teamName, freshTask.blockedBy)
      ) {
        continue; // state changed between pre-check and lock acquisition
      }

      // Claim the task atomically
      const filePath = join(tasksDir(teamName), `${sanitizeTaskId(id)}.json`);
      let taskData: Record<string, unknown>;
      try {
        const raw = readFileSync(filePath, 'utf-8');
        taskData = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }

      taskData.claimedBy = workerName;
      taskData.claimedAt = Date.now();
      taskData.claimPid = process.pid;
      taskData.status = 'in_progress';
      atomicWriteJson(filePath, taskData);

      return { ...freshTask, claimedBy: workerName, claimedAt: taskData.claimedAt as number, claimPid: process.pid, status: 'in_progress' };
    } finally {
      releaseTaskLock(handle);
    }
  }

  return null;
}

/** Check if all blocker task IDs have status 'completed' */
export function areBlockersResolved(teamName: string, blockedBy: string[]): boolean {
  if (!blockedBy || blockedBy.length === 0) return true;
  for (const blockerId of blockedBy) {
    const blocker = readTask(teamName, blockerId);
    if (!blocker || blocker.status !== 'completed') return false;
  }
  return true;
}

/**
 * Write failure sidecar for a task.
 * If sidecar already exists, increments retryCount.
 */
export function writeTaskFailure(teamName: string, taskId: string, error: string): void {
  const filePath = failureSidecarPath(teamName, taskId);
  const existing = readTaskFailure(teamName, taskId);
  const sidecar: TaskFailureSidecar = {
    taskId,
    lastError: error,
    retryCount: existing ? existing.retryCount + 1 : 1,
    lastFailedAt: new Date().toISOString(),
  };
  atomicWriteJson(filePath, sidecar);
}

/** Read failure sidecar if it exists */
export function readTaskFailure(teamName: string, taskId: string): TaskFailureSidecar | null {
  const filePath = failureSidecarPath(teamName, taskId);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as TaskFailureSidecar;
  } catch {
    return null;
  }
}

/** Default maximum retries before a task is permanently failed */
export const DEFAULT_MAX_TASK_RETRIES = 5;

/** Check if a task has exhausted its retry budget */
export function isTaskRetryExhausted(
  teamName: string,
  taskId: string,
  maxRetries: number = DEFAULT_MAX_TASK_RETRIES
): boolean {
  const failure = readTaskFailure(teamName, taskId);
  if (!failure) return false;
  return failure.retryCount >= maxRetries;
}

/** List all task IDs in a team directory, sorted ascending */
export function listTaskIds(teamName: string): string[] {
  const dir = tasksDir(teamName);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.json') && !f.includes('.tmp.') && !f.includes('.failure.'))
      .map(f => f.replace('.json', ''))
      .sort((a, b) => {
        const numA = parseInt(a, 10);
        const numB = parseInt(b, 10);
        if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
        return a.localeCompare(b);
      });
  } catch {
    return [];
  }
}
