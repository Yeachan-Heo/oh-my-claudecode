/**
 * Session Registry Module
 *
 * Maps platform message IDs to tmux pane IDs for reply correlation.
 * Uses JSONL append format for atomic writes, following the pattern from
 * session-replay.ts with secure file permissions from daemon.ts.
 *
 * Registry location: ~/.omc/state/reply-session-registry.jsonl (global, not worktree-local)
 * File permissions: 0600 (owner read/write only)
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  unlinkSync,
  statSync,
  constants,
} from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

// ============================================================================
// Constants
// ============================================================================

/** Secure file permissions (owner read/write only) */
const SECURE_FILE_MODE = 0o600;

/** Maximum age for entries (24 hours) */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Lock settings */
const LOCK_TIMEOUT_MS = 2000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 10000;
const LOCK_MAX_WAIT_MS = 10000;

/**
 * Return the registry state directory.
 * OMC_TEST_REGISTRY_DIR overrides the default (~/.omc/state) so that tests
 * can redirect all I/O to a temporary directory without touching global state.
 */
function getRegistryStateDir(): string {
  return process.env['OMC_TEST_REGISTRY_DIR'] ?? join(homedir(), '.omc', 'state');
}

/** Global registry JSONL path */
function getRegistryPath(): string {
  return join(getRegistryStateDir(), 'reply-session-registry.jsonl');
}

/** Lock file path for cross-process synchronization */
function getLockPath(): string {
  return join(getRegistryStateDir(), 'reply-session-registry.lock');
}

// Shared array for Atomics.wait-based synchronous sleep
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

interface RegistryLockHandle {
  fd: number;
  token: string;
}

interface LockFileSnapshot {
  raw: string;
  pid: number | null;
  token: string | null;
}

// ============================================================================
// Types
// ============================================================================

export interface SessionMapping {
  platform: "discord-bot" | "telegram";
  messageId: string;
  sessionId: string;
  tmuxPaneId: string;
  tmuxSessionName: string;
  event: string;
  createdAt: string; // ISO timestamp
  projectPath?: string;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Ensure registry directory exists with secure permissions
 */
function ensureRegistryDir(): void {
  const registryDir = dirname(getRegistryPath());
  if (!existsSync(registryDir)) {
    mkdirSync(registryDir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Synchronous sleep helper used while waiting for lock acquisition.
 */
function sleepMs(ms: number): void {
  Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
}

/**
 * Check whether a process is alive.
 * EPERM indicates a live process we can't signal.
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code === 'EPERM';
  }
}

/**
 * Read/parse lock snapshot.
 *
 * Supports:
 * - current JSON format: {"pid":123,"token":"...","acquiredAt":...}
 * - legacy text format: "123:1700000000000"
 */
function readLockSnapshot(): LockFileSnapshot | null {
  try {
    const raw = readFileSync(getLockPath(), 'utf-8');
    const trimmed = raw.trim();

    if (!trimmed) {
      return { raw, pid: null, token: null };
    }

    try {
      const parsed = JSON.parse(trimmed) as { pid?: unknown; token?: unknown };
      const pid = typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) ? parsed.pid : null;
      const token = typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null;
      return { raw, pid, token };
    } catch {
      const [pidStr] = trimmed.split(':');
      const parsedPid = Number.parseInt(pidStr ?? '', 10);
      return {
        raw,
        pid: Number.isFinite(parsedPid) && parsedPid > 0 ? parsedPid : null,
        token: null,
      };
    }
  } catch {
    return null;
  }
}

/**
 * Remove lock file only if content still matches expected snapshot.
 */
function removeLockIfUnchanged(snapshot: LockFileSnapshot): boolean {
  try {
    const currentRaw = readFileSync(getLockPath(), 'utf-8');
    if (currentRaw !== snapshot.raw) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    unlinkSync(getLockPath());
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire registry lock (cross-process) using O_EXCL lock file semantics.
 * Returns lock file descriptor when acquired, null on timeout.
 */
function acquireRegistryLock(): RegistryLockHandle | null {
  ensureRegistryDir();
  const started = Date.now();

  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    try {
      const token = randomUUID();
      const fd = openSync(
        getLockPath(),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        SECURE_FILE_MODE,
      );
      // Write lock payload for stale-lock checks + ownership-safe unlock.
      const lockPayload = JSON.stringify({
        pid: process.pid,
        acquiredAt: Date.now(),
        token,
      });
      writeSync(fd, lockPayload, null, 'utf-8');
      return { fd, token };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw error;
      }

      // Remove stale lock only if ownership checks indicate it's safe.
      try {
        const lockAgeMs = Date.now() - statSync(getLockPath()).mtimeMs;
        if (lockAgeMs > LOCK_STALE_MS) {
          const snapshot = readLockSnapshot();
          if (!snapshot) {
            sleepMs(LOCK_RETRY_MS);
            continue;
          }

          // Never reap an active lock held by a live process.
          if (snapshot.pid !== null && isPidAlive(snapshot.pid)) {
            sleepMs(LOCK_RETRY_MS);
            continue;
          }

          if (removeLockIfUnchanged(snapshot)) {
            continue;
          }
        }
      } catch {
        // Lock may disappear between stat/unlink attempts
      }

      sleepMs(LOCK_RETRY_MS);
    }
  }

  return null;
}

/**
 * Acquire registry lock with retries up to a cumulative deadline.
 * Returns null if the deadline is exceeded (e.g. lock holder is a hung process).
 */
function acquireRegistryLockOrWait(maxWaitMs: number = LOCK_MAX_WAIT_MS): RegistryLockHandle | null {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const lock = acquireRegistryLock();
    if (lock !== null) {
      return lock;
    }
    sleepMs(LOCK_RETRY_MS);
  }
  return null;
}

/**
 * Release registry lock.
 */
function releaseRegistryLock(lock: RegistryLockHandle): void {
  try {
    closeSync(lock.fd);
  } catch {
    // Ignore close errors
  }

  // Ownership-safe unlock: only remove lock if token still matches our lock.
  const snapshot = readLockSnapshot();
  if (!snapshot || snapshot.token !== lock.token) {
    return;
  }

  removeLockIfUnchanged(snapshot);
}

/**
 * Execute critical section with registry lock, waiting up to cumulative deadline.
 * If the lock cannot be acquired within the deadline, proceeds best-effort without lock.
 */
function withRegistryLockOrWait<T>(onLocked: () => T): T {
  const lock = acquireRegistryLockOrWait();
  if (lock === null) {
    // Lock timed out (hung lock holder). Proceed best-effort without lock.
    return onLocked();
  }
  try {
    return onLocked();
  } finally {
    releaseRegistryLock(lock);
  }
}

/**
 * Execute critical section with registry lock.
 */
function withRegistryLock<T>(onLocked: () => T, onLockUnavailable: () => T): T {
  const lock = acquireRegistryLock();
  if (lock === null) {
    return onLockUnavailable();
  }

  try {
    return onLocked();
  } finally {
    releaseRegistryLock(lock);
  }
}

/**
 * Register a message mapping (atomic JSONL append).
 *
 * Uses O_WRONLY | O_APPEND | O_CREAT for atomic appends (up to PIPE_BUF bytes on Linux).
 * Each mapping serializes to well under 4096 bytes, making this operation atomic.
 */
export function registerMessage(mapping: SessionMapping): void {
  withRegistryLockOrWait(
    () => {
      ensureRegistryDir();

      const line = JSON.stringify(mapping) + '\n';
      const fd = openSync(
        getRegistryPath(),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
        SECURE_FILE_MODE,
      );

      try {
        const buf = Buffer.from(line, 'utf-8');
        writeSync(fd, buf);
      } finally {
        closeSync(fd);
      }
    },
  );
}

/**
 * Load all mappings from the JSONL file
 */
export function loadAllMappings(): SessionMapping[] {
  return withRegistryLockOrWait(() => readAllMappingsUnsafe());
}

/**
 * Load all mappings without lock.
 * Caller must already hold lock (or accept race risk).
 */
function readAllMappingsUnsafe(): SessionMapping[] {
  if (!existsSync(getRegistryPath())) {
    return [];
  }

  try {
    const content = readFileSync(getRegistryPath(), 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line) as SessionMapping;
        } catch {
          return null;
        }
      })
      .filter((m): m is SessionMapping => m !== null);
  } catch {
    return [];
  }
}

/**
 * Look up a mapping by platform and message ID.
 * Returns the most recent entry when duplicates exist (last match in append-ordered JSONL).
 */
export function lookupByMessageId(platform: string, messageId: string): SessionMapping | null {
  const mappings = loadAllMappings();

  // Use findLast so that the most recently appended entry wins when duplicates exist.
  return mappings.findLast(m => m.platform === platform && m.messageId === messageId) ?? null;
}

/**
 * Remove all entries for a given session ID.
 * This is a rewrite operation (infrequent - only on session-end).
 */
export function removeSession(sessionId: string): void {
  withRegistryLock(
    () => {
      const mappings = readAllMappingsUnsafe();
      const filtered = mappings.filter(m => m.sessionId !== sessionId);

      if (filtered.length === mappings.length) {
        // No changes needed
        return;
      }

      rewriteRegistryUnsafe(filtered);
    },
    () => {
      // Best-effort cleanup: if lock unavailable, leave entries as-is.
    },
  );
}

/**
 * Remove all entries for a given pane ID.
 * Called by reply listener when pane verification fails (stale pane cleanup).
 */
export function removeMessagesByPane(paneId: string): void {
  withRegistryLock(
    () => {
      const mappings = readAllMappingsUnsafe();
      const filtered = mappings.filter(m => m.tmuxPaneId !== paneId);

      if (filtered.length === mappings.length) {
        // No changes needed
        return;
      }

      rewriteRegistryUnsafe(filtered);
    },
    () => {
      // Best-effort cleanup: if lock unavailable, leave entries as-is.
    },
  );
}

/**
 * Remove entries older than MAX_AGE_MS (24 hours).
 * This is a rewrite operation (infrequent - called periodically by daemon).
 */
export function pruneStale(): void {
  withRegistryLock(
    () => {
      const now = Date.now();
      const mappings = readAllMappingsUnsafe();
      const filtered = mappings.filter(m => {
        try {
          const age = now - new Date(m.createdAt).getTime();
          return age < MAX_AGE_MS;
        } catch {
          // Invalid timestamp, remove it
          return false;
        }
      });

      if (filtered.length === mappings.length) {
        // No changes needed
        return;
      }

      rewriteRegistryUnsafe(filtered);
    },
    () => {
      // Best-effort cleanup: if lock unavailable, leave entries as-is.
    },
  );
}

/**
 * Rewrite the entire registry file with new mappings.
 * Used by removeSession, removeMessagesByPane, and pruneStale.
 */
function rewriteRegistryUnsafe(mappings: SessionMapping[]): void {
  ensureRegistryDir();

  if (mappings.length === 0) {
    // Empty registry - write empty file
    writeFileSync(getRegistryPath(), '', { mode: SECURE_FILE_MODE });
    return;
  }

  const content = mappings.map(m => JSON.stringify(m)).join('\n') + '\n';
  writeFileSync(getRegistryPath(), content, { mode: SECURE_FILE_MODE });
}
