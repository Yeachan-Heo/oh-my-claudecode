import type { TaskFile, TaskFileUpdate, TaskFailureSidecar } from './types.js';
/** Handle returned by acquireTaskLock; pass to releaseTaskLock. */
export interface LockHandle {
    fd: number;
    path: string;
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
export declare function acquireTaskLock(teamName: string, taskId: string, opts?: {
    staleLockMs?: number;
    workerName?: string;
    cwd?: string;
}): LockHandle | null;
/**
 * Release a previously acquired task lock.
 * Closes the file descriptor and removes the lock file.
 */
export declare function releaseTaskLock(handle: LockHandle): void;
/**
 * Execute a function while holding an exclusive task lock.
 * Returns the function's result, or null if the lock could not be acquired.
 */
export declare function withTaskLock<T>(teamName: string, taskId: string, fn: () => T | Promise<T>, opts?: {
    staleLockMs?: number;
    workerName?: string;
    cwd?: string;
}): Promise<T | null>;
/** Read a single task file. Returns null if not found or malformed. */
export declare function readTask(teamName: string, taskId: string, opts?: {
    cwd?: string;
}): TaskFile | null;
/**
 * Atomic update: reads full task JSON, patches specified fields, writes back.
 * Preserves unknown fields to avoid data loss.
 *
 * When useLock is true (default), wraps the read-modify-write in an O_EXCL
 * lock to prevent lost updates from concurrent writers. Falls back to
 * unlocked write if the lock cannot be acquired within a single attempt
 * (backward-compatible degradation with a console warning).
 *
 * Always writes to the canonical path. If the task only exists in the legacy
 * path, it is migrated to canonical on the first update.
 */
export declare function updateTask(teamName: string, taskId: string, updates: TaskFileUpdate, opts?: {
    useLock?: boolean;
    cwd?: string;
}): void;
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
export declare function findNextTask(teamName: string, workerName: string, opts?: {
    cwd?: string;
}): Promise<TaskFile | null>;
/** Check if all blocker task IDs have status 'completed' */
export declare function areBlockersResolved(teamName: string, blockedBy: string[], opts?: {
    cwd?: string;
}): boolean;
/**
 * Write failure sidecar for a task.
 * If sidecar already exists, increments retryCount.
 * Returns the persisted sidecar payload.
 */
export declare function writeTaskFailure(teamName: string, taskId: string, error: string, opts?: {
    cwd?: string;
}): TaskFailureSidecar;
/** Read failure sidecar if it exists */
export declare function readTaskFailure(teamName: string, taskId: string, opts?: {
    cwd?: string;
}): TaskFailureSidecar | null;
/** Default maximum retries before a task is permanently failed */
export declare const DEFAULT_MAX_TASK_RETRIES = 5;
/** Check if a task has exhausted its retry budget */
export declare function isTaskRetryExhausted(teamName: string, taskId: string, maxRetries?: number, opts?: {
    cwd?: string;
}): boolean;
/** List all task IDs in a team directory, sorted ascending */
export declare function listTaskIds(teamName: string, opts?: {
    cwd?: string;
}): string[];
//# sourceMappingURL=task-file-ops.d.ts.map