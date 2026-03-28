/**
 * Child Process Tracker
 *
 * Centralized tracking and cleanup of spawned child processes.
 * Prevents orphaned processes (PPID 1) from accumulating when
 * the parent Claude Code session exits without forwarding signals.
 *
 * Issue: #1724
 */

import { ChildProcess } from 'child_process';

interface TrackedProcess {
  proc: ChildProcess;
  pid: number;
  label: string;
  spawnedAt: number;
}

const trackedProcesses = new Map<number, TrackedProcess>();
let cleanupRegistered = false;

/**
 * Track a spawned child process for cleanup on exit.
 *
 * @param proc - The ChildProcess returned by spawn/fork/exec
 * @param label - Human-readable label for debugging (e.g., 'gyoshu_bridge', 'session-summary')
 * @returns The same ChildProcess (for chaining)
 */
export function trackChildProcess(proc: ChildProcess, label: string): ChildProcess {
  if (!proc.pid) {
    // Process failed to spawn; nothing to track
    return proc;
  }

  const entry: TrackedProcess = {
    proc,
    pid: proc.pid,
    label,
    spawnedAt: Date.now(),
  };

  trackedProcesses.set(proc.pid, entry);

  // Auto-remove when process exits naturally
  proc.on('exit', () => {
    trackedProcesses.delete(entry.pid);
  });
  proc.on('error', () => {
    trackedProcesses.delete(entry.pid);
  });

  ensureCleanupHandlers();

  return proc;
}

/**
 * Untrack a child process (e.g., when it is managed by another subsystem).
 */
export function untrackChildProcess(pid: number): void {
  trackedProcesses.delete(pid);
}

/**
 * Kill all tracked child processes.
 * Called automatically on exit/SIGTERM/SIGINT, but can also be invoked manually.
 *
 * Uses process group kill (negative PID) when possible to clean up
 * any grandchild processes spawned by detached children.
 */
export function killAllTrackedProcesses(): void {
  for (const [pid, entry] of trackedProcesses) {
    try {
      // Try process group kill first (catches grandchildren)
      if (process.platform !== 'win32') {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          // Process group kill failed; fall back to direct kill
          process.kill(pid, 'SIGTERM');
        }
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch {
      // Process already dead — ignore
    }
    trackedProcesses.delete(pid);
  }
}

/**
 * Get the count of currently tracked (alive) processes.
 * Useful for diagnostics.
 */
export function getTrackedProcessCount(): number {
  return trackedProcesses.size;
}

/**
 * Register process exit handlers exactly once.
 * Handles: exit, SIGTERM, SIGINT, SIGHUP.
 */
function ensureCleanupHandlers(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  // 'exit' fires synchronously — we can only do sync work here
  process.on('exit', () => {
    killAllTrackedProcesses();
  });

  // For signals, kill children but do NOT call process.exit().
  // Other signal handlers (LSP cleanup, bridge cleanup, etc.) may still need to run.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => {
      killAllTrackedProcesses();
    });
  }
}
