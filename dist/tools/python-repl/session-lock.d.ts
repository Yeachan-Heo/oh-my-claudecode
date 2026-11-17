/**
 * Session Lock - Cross-platform file-based session locking
 *
 * Provides single-writer enforcement per session with:
 * - PID-reuse safety via process start time verification
 * - Cross-platform support (Linux, macOS, Windows)
 * - Stale lock detection and safe breaking
 * - Request queuing with timeout
 */
import { LockInfo } from './types.js';
export declare class LockTimeoutError extends Error {
    readonly lockPath: string;
    readonly timeout: number;
    readonly lastHolder?: LockInfo | undefined;
    constructor(lockPath: string, timeout: number, lastHolder?: LockInfo | undefined);
}
export declare class LockError extends Error {
    constructor(message: string);
}
export interface LockResult {
    acquired: boolean;
    reason?: 'success' | 'held_by_other' | 'stale_broken' | 'error';
    holder?: LockInfo;
}
/**
 * Get the start time of the current process.
 * Used when creating lock files to enable PID reuse detection.
 */
export declare function getCurrentProcessStartTime(): Promise<number | undefined>;
/**
 * Check if a process is alive with PID-reuse detection via start time comparison.
 *
 * @param pid - Process ID to check
 * @param recordedStartTime - Start time recorded when lock was acquired
 * @returns true if process is alive AND start time matches (or wasn't recorded)
 */
export declare function isProcessAlive(pid: number, recordedStartTime?: number): Promise<boolean>;
/**
 * SessionLock manages a single lock file for session coordination.
 *
 * @example
 * const lock = new SessionLock('my-session-id');
 * try {
 *   await lock.acquire();
 *   // ... do work ...
 * } finally {
 *   await lock.release();
 * }
 */
export declare class SessionLock {
    private lockPath;
    private lockId;
    private held;
    private lockInfo;
    constructor(sessionId: string);
    /**
     * Acquire lock with timeout (default 30s).
     * Blocks until lock is acquired or timeout is reached.
     *
     * @param timeout - Maximum time to wait in milliseconds
     * @throws LockTimeoutError if lock cannot be acquired within timeout
     */
    acquire(timeout?: number): Promise<void>;
    /**
     * Try to acquire lock (non-blocking).
     * Returns immediately with result indicating success or failure.
     */
    tryAcquire(): Promise<LockResult>;
    /**
     * Release held lock.
     * Safe to call multiple times - subsequent calls are no-ops.
     */
    release(): Promise<void>;
    /**
     * Force break a stale lock.
     * USE WITH CAUTION: This will break the lock regardless of who holds it.
     * Should only be used for recovery from known stale states.
     */
    forceBreak(): Promise<void>;
    /**
     * Check if lock is held by us.
     */
    isHeld(): boolean;
    /**
     * Get the lock file path.
     */
    getLockPath(): string;
    /**
     * Get current lock info (if held).
     */
    getLockInfo(): LockInfo | null;
}
/**
 * Execute a function while holding a lock, releasing automatically on completion.
 *
 * @example
 * await withLock('session-id', async () => {
 *   // ... critical section ...
 * });
 */
export declare function withLock<T>(sessionId: string, fn: () => Promise<T>, timeout?: number): Promise<T>;
/**
 * Get the current status of a session lock.
 */
export declare function getLockStatus(sessionId: string): Promise<{
    locked: boolean;
    lockInfo: LockInfo | null;
    canBreak: boolean;
    ownedByUs: boolean;
}>;
//# sourceMappingURL=session-lock.d.ts.map