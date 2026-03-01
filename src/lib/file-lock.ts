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

import {
  openSync,
  closeSync,
  unlinkSync,
  writeSync,
  readFileSync,
  statSync,
  constants as fsConstants,
} from "fs";
import * as path from "path";
import { ensureDirSync } from "./atomic-write.js";

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 50;

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Check if a process with the given PID is alive.
 * Returns false for invalid PIDs or if kill(pid, 0) throws ESRCH.
 */
function isPidAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM means the process exists but we lack permission -- still alive
    if (
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code: string }).code === "EPERM"
    )
      return true;
    return false;
  }
}

/**
 * Check if an existing lock file is stale.
 * A lock is stale if older than staleLockMs AND the owning PID is dead.
 */
function isLockStale(lockPath: string, staleLockMs: number): boolean {
  try {
    const stat = statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < staleLockMs) return false;

    // Try to read PID from the lock payload
    try {
      const raw = readFileSync(lockPath, "utf-8");
      const payload = JSON.parse(raw) as { pid?: number };
      if (payload.pid && isPidAlive(payload.pid)) return false;
    } catch {
      // Malformed or unreadable -- treat as stale if old enough
    }
    return true;
  } catch {
    // Lock file disappeared -- not stale, just gone
    return false;
  }
}

/**
 * Derive the lock file path from a data file path.
 * e.g. /path/to/data.json -> /path/to/data.json.lock
 */
export function lockPathFor(filePath: string): string {
  return filePath + ".lock";
}

// ============================================================================
// Synchronous API
// ============================================================================

/**
 * Try to acquire an exclusive file lock (synchronous, single attempt).
 *
 * Creates a lock file adjacent to the target using O_CREAT|O_EXCL.
 * On first failure due to EEXIST, checks for staleness and retries once.
 *
 * @returns LockHandle on success, null if lock is held
 */
function tryAcquireSync(
  lockPath: string,
  staleLockMs: number,
): FileLockHandle | null {
  ensureDirSync(path.dirname(lockPath));

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      const payload = JSON.stringify({
        pid: process.pid,
        timestamp: Date.now(),
      });
      writeSync(fd, payload, null, "utf-8");
      return { fd, path: lockPath };
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "EEXIST"
      ) {
        if (attempt === 0 && isLockStale(lockPath, staleLockMs)) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* another process reaped it */
          }
          continue;
        }
        return null;
      }
      throw err;
    }
  }
  return null;
}

/**
 * Acquire an exclusive file lock with optional retry/timeout (synchronous).
 *
 * @param lockPath Path for the lock file
 * @param opts Lock options
 * @returns FileLockHandle on success, null if lock could not be acquired
 */
export function acquireFileLockSync(
  lockPath: string,
  opts?: FileLockOptions,
): FileLockHandle | null {
  const staleLockMs = opts?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const timeoutMs = opts?.timeoutMs ?? 0;
  const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  const handle = tryAcquireSync(lockPath, staleLockMs);
  if (handle || timeoutMs <= 0) return handle;

  // Retry loop with busy-wait using Atomics (avoids blocking the event loop
  // in a way that prevents signal handling, but is acceptable for short locks)
  const deadline = Date.now() + timeoutMs;
  const sharedBuf = new SharedArrayBuffer(4);
  const sharedArr = new Int32Array(sharedBuf);

  while (Date.now() < deadline) {
    Atomics.wait(sharedArr, 0, 0, Math.min(retryDelayMs, deadline - Date.now()));
    const retryHandle = tryAcquireSync(lockPath, staleLockMs);
    if (retryHandle) return retryHandle;
  }

  return null;
}

/**
 * Release a previously acquired file lock (synchronous).
 */
export function releaseFileLockSync(handle: FileLockHandle): void {
  try {
    closeSync(handle.fd);
  } catch {
    /* already closed */
  }
  try {
    unlinkSync(handle.path);
  } catch {
    /* already removed */
  }
}

/**
 * Execute a function while holding an exclusive file lock (synchronous).
 *
 * @param lockPath Path for the lock file
 * @param fn Function to execute under lock
 * @param opts Lock options
 * @returns The function's return value
 * @throws Error if the lock cannot be acquired
 */
export function withFileLockSync<T>(
  lockPath: string,
  fn: () => T,
  opts?: FileLockOptions,
): T {
  const handle = acquireFileLockSync(lockPath, opts);
  if (!handle) {
    throw new Error(`Failed to acquire file lock: ${lockPath}`);
  }
  try {
    return fn();
  } finally {
    releaseFileLockSync(handle);
  }
}

// ============================================================================
// Asynchronous API
// ============================================================================

/**
 * Sleep for a given number of milliseconds (async).
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire an exclusive file lock with optional retry/timeout (asynchronous).
 *
 * @param lockPath Path for the lock file
 * @param opts Lock options
 * @returns FileLockHandle on success, null if lock could not be acquired
 */
export async function acquireFileLock(
  lockPath: string,
  opts?: FileLockOptions,
): Promise<FileLockHandle | null> {
  const staleLockMs = opts?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const timeoutMs = opts?.timeoutMs ?? 0;
  const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  const handle = tryAcquireSync(lockPath, staleLockMs);
  if (handle || timeoutMs <= 0) return handle;

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(Math.min(retryDelayMs, deadline - Date.now()));
    const retryHandle = tryAcquireSync(lockPath, staleLockMs);
    if (retryHandle) return retryHandle;
  }

  return null;
}

/**
 * Release a previously acquired file lock (async-compatible, delegates to sync).
 */
export function releaseFileLock(handle: FileLockHandle): void {
  releaseFileLockSync(handle);
}

/**
 * Execute an async function while holding an exclusive file lock.
 *
 * @param lockPath Path for the lock file
 * @param fn Async function to execute under lock
 * @param opts Lock options
 * @returns The function's return value
 * @throws Error if the lock cannot be acquired
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  opts?: FileLockOptions,
): Promise<T> {
  const handle = await acquireFileLock(lockPath, opts);
  if (!handle) {
    throw new Error(`Failed to acquire file lock: ${lockPath}`);
  }
  try {
    return await fn();
  } finally {
    releaseFileLock(handle);
  }
}
