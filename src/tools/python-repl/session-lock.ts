/**
 * Session Lock - Cross-platform file-based session locking
 *
 * Provides single-writer enforcement per session with:
 * - PID-reuse safety via process start time verification
 * - Cross-platform support (Linux, macOS, Windows)
 * - Stale lock detection and safe breaking
 * - Request queuing with timeout
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { LockInfo } from './types.js';
import { ensureDirSync } from '../../lib/atomic-write.js';
import { getSessionLockPath } from './paths.js';
import { getProcessStartTime } from '../../platform/index.js';

const execFileAsync = promisify(execFile);

// =============================================================================
// CONSTANTS
// =============================================================================

const STALE_LOCK_AGE_MS = 60000; // 60 seconds
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30000; // 30 seconds
const LOCK_RETRY_INTERVAL_MS = 100; // 100ms between retries
const REMOTE_LOCK_STALE_AGE_MS = 300000; // 5 minutes for remote locks

// =============================================================================
// ERRORS
// =============================================================================

export class LockTimeoutError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly timeout: number,
    public readonly lastHolder?: LockInfo
  ) {
    super(
      `Failed to acquire lock within ${timeout}ms. ` +
        (lastHolder
          ? `Held by PID ${lastHolder.pid} on ${lastHolder.hostname} since ${lastHolder.acquiredAt}`
          : 'Unknown holder') +
        `. Lock path: ${lockPath}`
    );
    this.name = 'LockTimeoutError';
  }
}

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

// =============================================================================
// LOCK RESULT TYPE
// =============================================================================

export interface LockResult {
  acquired: boolean;
  reason?: 'success' | 'held_by_other' | 'stale_broken' | 'error';
  holder?: LockInfo;
}

// =============================================================================
// PID VALIDATION
// =============================================================================

/**
 * Validate that a PID is a positive integer.
 * Defense in depth against command injection via poisoned lock files.
 */
function isValidPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

// =============================================================================
// PROCESS START TIME DETECTION
// =============================================================================

/**
 * Get the start time of the current process.
 * Used when creating lock files to enable PID reuse detection.
 */
export async function getCurrentProcessStartTime(): Promise<number | undefined> {
  return getProcessStartTime(process.pid);
}

// =============================================================================
// PROCESS LIVENESS DETECTION
// =============================================================================

/**
 * Check if a process is alive with PID-reuse detection via start time comparison.
 *
 * @param pid - Process ID to check
 * @param recordedStartTime - Start time recorded when lock was acquired
 * @returns true if process is alive AND start time matches (or wasn't recorded)
 */
export async function isProcessAlive(pid: number, recordedStartTime?: number): Promise<boolean> {
  if (!isValidPid(pid)) return false;

  if (process.platform === 'linux') {
    const currentStartTime = await getProcessStartTime(pid);
    if (currentStartTime === undefined) return false;

    // If we have a recorded start time, verify it matches
    if (recordedStartTime !== undefined && currentStartTime !== recordedStartTime) {
      return false; // PID reuse detected
    }

    return true;
  } else if (process.platform === 'darwin') {
    try {
      // First check if process exists
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'pid='], {
        env: { ...process.env, LC_ALL: 'C' },
      });
      if (stdout.trim() === '') return false;

      // If we have a recorded start time, verify it matches
      if (recordedStartTime !== undefined) {
        const currentStartTime = await getProcessStartTime(pid);
        // Fail-closed: if we can't get current start time but we have a recorded one,
        // assume PID reuse has occurred (safer than assuming same process)
        if (currentStartTime === undefined) {
          return false;
        }
        if (currentStartTime !== recordedStartTime) {
          return false; // PID reuse detected
        }
      }

      return true;
    } catch {
      return false;
    }
  } else if (process.platform === 'win32') {
    // On Windows, check process existence first and then verify start time when available.
    const exists = await isWindowsProcessAlive(pid);
    if (!exists) {
      return false;
    }

    if (recordedStartTime !== undefined) {
      const currentStartTime = await getProcessStartTime(pid);
      // If start-time metadata is unavailable, avoid misclassifying a live process as dead.
      if (currentStartTime !== undefined && currentStartTime !== recordedStartTime) {
        return false; // PID reuse detected
      }
    }

    return true;
  }

  // Unknown platform: conservative assumption that process is alive
  return true;
}

async function isWindowsProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Fallback for environments where signal probing is restricted/unreliable.
    return isWindowsProcessAlivePowerShell(pid);
  }
}

async function isWindowsProcessAlivePowerShell(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue; if (-not $p) { $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue }; if ($p) { '1' }`
      ],
      { timeout: 5000, windowsHide: true }
    );
    return stdout.trim() === '1';
  } catch {
    return false;
  }
}

// =============================================================================
// SYMLINK-SAFE FILE OPERATIONS
// =============================================================================

/**
 * Open a file with O_NOFOLLOW to prevent symlink attacks.
 * Falls back to lstat check on platforms that don't support O_NOFOLLOW.
 */
async function openNoFollow(
  filePath: string,
  flags: number,
  mode: number
): Promise<fs.FileHandle> {
  // Add O_NOFOLLOW if available (Linux, macOS)
  // O_NOFOLLOW doesn't exist on Windows. Use 0 to disable the flag.
  const O_NOFOLLOW = fsSync.constants.O_NOFOLLOW ?? 0;
  const flagsWithNoFollow = flags | O_NOFOLLOW;

  try {
    return await fs.open(filePath, flagsWithNoFollow, mode);
  } catch (err: any) {
    // ELOOP means it's a symlink - reject it
    if (err.code === 'ELOOP') {
      throw new LockError(`Lock file is a symlink: ${filePath}`);
    }
    throw err;
  }
}

/**
 * Read a file safely, rejecting symlinks.
 */
async function readFileNoFollow(filePath: string): Promise<string> {
  // First check if it's a symlink via lstat
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new LockError(`Lock file is a symlink: ${filePath}`);
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw err; // File doesn't exist - propagate
    }
    if (err instanceof LockError) {
      throw err;
    }
    // Other errors - let readFile handle them
  }

  return fs.readFile(filePath, 'utf8');
}

// =============================================================================
// LOCK FILE OPERATIONS
// =============================================================================

/**
 * Read and validate a lock file.
 * Returns null if file doesn't exist, is invalid, or is a symlink.
 */
async function readLockFile(lockPath: string): Promise<LockInfo | null> {
  try {
    const content = await readFileNoFollow(lockPath);
    const lockInfo = JSON.parse(content) as LockInfo;

    // Validate required fields
    if (
      !lockInfo.lockId ||
      !isValidPid(lockInfo.pid) ||
      !lockInfo.hostname ||
      !lockInfo.acquiredAt
    ) {
      return null;
    }

    return lockInfo;
  } catch {
    // ENOENT = doesn't exist, ELOOP = symlink rejected, or parse error
    return null;
  }
}

/**
 * Create a new LockInfo for the current process.
 */
async function createLockInfo(lockId: string): Promise<LockInfo> {
  return {
    lockId,
    pid: process.pid,
    processStartTime: await getCurrentProcessStartTime(),
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };
}

/**
 * Check if a lock can be safely broken. A lock is breakable if:
 * - Age > 60 seconds AND owning process is dead OR start time differs (PID reuse)
 * - For remote hosts: Only breaks if age > 5 minutes
 */
async function canBreakLock(lockInfo: LockInfo): Promise<boolean> {
  const age = Date.now() - new Date(lockInfo.acquiredAt).getTime();

  // Lock is too fresh to break
  if (age < STALE_LOCK_AGE_MS) {
    return false;
  }

  // For remote hosts, require much longer timeout
  if (lockInfo.hostname !== os.hostname()) {
    return age > REMOTE_LOCK_STALE_AGE_MS;
  }

  // Check if owning process is still alive with same start time
  const alive = await isProcessAlive(lockInfo.pid, lockInfo.processStartTime);

  return !alive;
}

// =============================================================================
// SESSION LOCK CLASS
// =============================================================================

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
export class SessionLock {
  private lockPath: string;
  private lockId: string;
  private held: boolean = false;
  private lockInfo: LockInfo | null = null;

  constructor(sessionId: string) {
    this.lockPath = getSessionLockPath(sessionId);
    this.lockId = crypto.randomUUID();
  }

  /**
   * Acquire lock with timeout (default 30s).
   * Blocks until lock is acquired or timeout is reached.
   *
   * @param timeout - Maximum time to wait in milliseconds
   * @throws LockTimeoutError if lock cannot be acquired within timeout
   */
  async acquire(timeout: number = DEFAULT_ACQUIRE_TIMEOUT_MS): Promise<void> {
    if (this.held) {
      throw new LockError('Lock already held by this instance');
    }

    const startTime = Date.now();
    let lastHolder: LockInfo | undefined;

    while (Date.now() - startTime < timeout) {
      const result = await this.tryAcquire();

      if (result.acquired) {
        return;
      }

      if (result.holder) {
        lastHolder = result.holder;
      }

      await sleep(LOCK_RETRY_INTERVAL_MS);
    }

    throw new LockTimeoutError(this.lockPath, timeout, lastHolder);
  }

  /**
   * Try to acquire lock (non-blocking).
   * Returns immediately with result indicating success or failure.
   */
  async tryAcquire(): Promise<LockResult> {
    try {
      const existingLock = await readLockFile(this.lockPath);

      if (existingLock) {
        // Check if we can break the stale lock
        if (await canBreakLock(existingLock)) {
          try {
            await fs.unlink(this.lockPath);
          } catch {
            // Lock might have been removed by another process
          }
          // Fall through to acquire
        } else {
          return {
            acquired: false,
            reason: 'held_by_other',
            holder: existingLock,
          };
        }
      }

      // Create new lock info
      const newLockInfo = await createLockInfo(this.lockId);

      try {
        // Ensure directory exists
        ensureDirSync(path.dirname(this.lockPath));

        // Atomic exclusive create with O_NOFOLLOW
        const flags =
          fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL;

        const lockFile = await openNoFollow(this.lockPath, flags, 0o644);
        try {
          await lockFile.writeFile(JSON.stringify(newLockInfo, null, 2), { encoding: 'utf8' });
          await lockFile.sync();
        } finally {
          await lockFile.close();
        }
      } catch (err: any) {
        if (err.code === 'EEXIST') {
          // Another process created the lock file first
          return {
            acquired: false,
            reason: 'held_by_other',
          };
        }
        throw err;
      }

      // Verify our lock wasn't overwritten (race condition check)
      const verifyLock = await readLockFile(this.lockPath);
      if (!verifyLock || verifyLock.lockId !== this.lockId) {
        return {
          acquired: false,
          reason: 'error',
        };
      }

      this.held = true;
      this.lockInfo = newLockInfo;

      return {
        acquired: true,
        reason: existingLock ? 'stale_broken' : 'success',
      };
    } catch (_err: any) {
      return {
        acquired: false,
        reason: 'error',
      };
    }
  }

  /**
   * Release held lock.
   * Safe to call multiple times - subsequent calls are no-ops.
   */
  async release(): Promise<void> {
    if (!this.held) {
      return;
    }

    try {
      // Verify we still own the lock before deleting
      const currentLock = await readLockFile(this.lockPath);

      if (currentLock && currentLock.lockId === this.lockId) {
        await fs.unlink(this.lockPath);
      }
    } catch {
      // Ignore errors (lock might already be gone)
    } finally {
      this.held = false;
      this.lockInfo = null;
    }
  }

  /**
   * Force break a stale lock.
   * USE WITH CAUTION: This will break the lock regardless of who holds it.
   * Should only be used for recovery from known stale states.
   */
  async forceBreak(): Promise<void> {
    try {
      await fs.unlink(this.lockPath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
    this.held = false;
    this.lockInfo = null;
  }

  /**
   * Check if lock is held by us.
   */
  isHeld(): boolean {
    return this.held;
  }

  /**
   * Get the lock file path.
   */
  getLockPath(): string {
    return this.lockPath;
  }

  /**
   * Get current lock info (if held).
   */
  getLockInfo(): LockInfo | null {
    return this.lockInfo;
  }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function while holding a lock, releasing automatically on completion.
 *
 * @example
 * await withLock('session-id', async () => {
 *   // ... critical section ...
 * });
 */
export async function withLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
  timeout: number = DEFAULT_ACQUIRE_TIMEOUT_MS
): Promise<T> {
  const lock = new SessionLock(sessionId);
  await lock.acquire(timeout);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/**
 * Get the current status of a session lock.
 */
export async function getLockStatus(sessionId: string): Promise<{
  locked: boolean;
  lockInfo: LockInfo | null;
  canBreak: boolean;
  ownedByUs: boolean;
}> {
  const lockPath = getSessionLockPath(sessionId);
  const lockInfo = await readLockFile(lockPath);

  if (!lockInfo) {
    return {
      locked: false,
      lockInfo: null,
      canBreak: false,
      ownedByUs: false,
    };
  }

  const canBreakResult = await canBreakLock(lockInfo);
  const ownedByUs = lockInfo.pid === process.pid && lockInfo.hostname === os.hostname();

  return {
    locked: true,
    lockInfo,
    canBreak: canBreakResult,
    ownedByUs,
  };
}
