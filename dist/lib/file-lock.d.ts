/**
 * Cross-process advisory file locking for shared-memory coordination.
 *
 * Uses O_CREAT|O_EXCL (exclusive-create) for atomic lock acquisition.
 * The kernel guarantees at most one process succeeds in creating the file.
 * Includes PID-based stale lock detection and automatic reaping.
 *
 * Provides both synchronous and asynchronous variants:
 * - Sync: for notepad (readFileSync-based) and state operations
 * - Async: for project-memory operations
 */
/** Handle returned by lock acquisition; pass to release. */
export interface FileLockHandle {
    fd: number;
    path: string;
}
/** Options for lock acquisition. */
export interface FileLockOptions {
    /** Maximum time (ms) to wait for lock acquisition. 0 = single attempt. Default: 0 */
    timeoutMs?: number;
    /** Delay (ms) between retry attempts. Default: 50 */
    retryDelayMs?: number;
    /** Age (ms) after which a lock held by a dead PID is considered stale. Default: 30000 */
    staleLockMs?: number;
}
/**
 * Derive the lock file path from a data file path.
 * e.g. /path/to/data.json -> /path/to/data.json.lock
 */
export declare function lockPathFor(filePath: string): string;
/**
 * Acquire an exclusive file lock with optional retry/timeout (synchronous).
 *
 * @param lockPath Path for the lock file
 * @param opts Lock options
 * @returns FileLockHandle on success, null if lock could not be acquired
 */
export declare function acquireFileLockSync(lockPath: string, opts?: FileLockOptions): FileLockHandle | null;
/**
 * Release a previously acquired file lock (synchronous).
 */
export declare function releaseFileLockSync(handle: FileLockHandle): void;
/**
 * Execute a function while holding an exclusive file lock (synchronous).
 *
 * @param lockPath Path for the lock file
 * @param fn Function to execute under lock
 * @param opts Lock options
 * @returns The function's return value
 * @throws Error if the lock cannot be acquired
 */
export declare function withFileLockSync<T>(lockPath: string, fn: () => T, opts?: FileLockOptions): T;
/**
 * Acquire an exclusive file lock with optional retry/timeout (asynchronous).
 *
 * @param lockPath Path for the lock file
 * @param opts Lock options
 * @returns FileLockHandle on success, null if lock could not be acquired
 */
export declare function acquireFileLock(lockPath: string, opts?: FileLockOptions): Promise<FileLockHandle | null>;
/**
 * Release a previously acquired file lock (async-compatible, delegates to sync).
 */
export declare function releaseFileLock(handle: FileLockHandle): void;
/**
 * Execute an async function while holding an exclusive file lock.
 *
 * @param lockPath Path for the lock file
 * @param fn Async function to execute under lock
 * @param opts Lock options
 * @returns The function's return value
 * @throws Error if the lock cannot be acquired
 */
export declare function withFileLock<T>(lockPath: string, fn: () => T | Promise<T>, opts?: FileLockOptions): Promise<T>;
//# sourceMappingURL=file-lock.d.ts.map