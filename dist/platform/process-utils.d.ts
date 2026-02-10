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
 */
export declare function isProcessAlive(pid: number): boolean;
/**
 * Get process start time for PID reuse detection.
 * Returns milliseconds timestamp on macOS/Windows, jiffies on Linux.
 */
export declare function getProcessStartTime(pid: number): Promise<number | undefined>;
/**
 * Gracefully terminate a process with escalation.
 */
export declare function gracefulKill(pid: number, gracePeriodMs?: number): Promise<'graceful' | 'forced' | 'failed'>;
//# sourceMappingURL=process-utils.d.ts.map