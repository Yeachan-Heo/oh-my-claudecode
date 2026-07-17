/**
 * Cross-Platform Process Utilities
 * Provides unified process management across Windows, macOS, and Linux.
 */
/**
 * Kill a process and optionally its entire process tree.
 *
 * On Windows: Uses taskkill /T for tree kill, /F for force
 * On Unix: Uses negative PID for process group, falls back to direct kill
 */
export declare function killProcessTree(pid: number, signal?: NodeJS.Signals): Promise<boolean>;
/**
 * Check if a process is alive.
 * Works cross-platform by attempting signal 0.
 * EPERM means the process exists but we lack permission to signal it.
 */
export declare function isProcessAlive(pid: number): boolean;
/**
 * Get process start time for PID reuse detection.
 * Returns milliseconds timestamp on macOS/Windows, jiffies on Linux.
 */
export declare function getProcessStartTime(pid: number, deadlineAt?: number): Promise<number | undefined>;
/**
 * Gracefully terminate a process with escalation.
 */
export declare function gracefulKill(pid: number, gracePeriodMs?: number): Promise<'graceful' | 'forced' | 'failed'>;
/** Stable PID-reuse identity suitable for a durable worker manifest. */
export declare function getProcessStartIdentity(pid: number, deadlineAt?: number): Promise<string | null>;
export declare function isProcessIdentityLive(pid: number, expectedStartIdentity: string, deadlineAt?: number): Promise<'live' | 'dead' | 'mismatch' | 'unknown'>;
export interface TerminateOwnedProcessTreeOptions {
    pid: number;
    expectedStartIdentity: string;
    deadlineAt: string;
    force?: boolean;
}
/**
 * Terminate only a process whose durable start identity still matches. The
 * Windows path is asynchronous and receives the worker's remaining deadline,
 * preventing taskkill from holding SessionEnd for its legacy five seconds.
 */
export declare function terminateOwnedProcessTree(options: TerminateOwnedProcessTreeOptions): Promise<'terminated' | 'already-dead' | 'identity-mismatch' | 'unknown' | 'deadline-exceeded'>;
//# sourceMappingURL=process-utils.d.ts.map