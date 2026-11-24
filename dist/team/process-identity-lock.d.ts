/** Atomic hard-link lock with positive-death-only stale owner/reclaimer takeover. */
export declare function withProcessIdentityFileLock<T>(lockPath: string, fn: () => Promise<T> | T, timeoutMs?: number): Promise<T>;
/** Non-waiting variant for short synchronous projection repairs. */
export declare function withProcessIdentityFileLockSync<T>(lockPath: string, fn: () => T): T;
//# sourceMappingURL=process-identity-lock.d.ts.map