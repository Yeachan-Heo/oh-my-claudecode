/**
 * Session Registry Module
 *
 * Maps platform message IDs to tmux pane IDs for reply correlation.
 * Uses JSONL append format for atomic writes, following the pattern from
 * session-replay.ts with secure file permissions from daemon.ts.
 *
 * Registry location: XDG-aware global OMC state (legacy ~/.omc/state fallback for reads)
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
import { randomUUID } from 'crypto';
import { isProcessAlive } from '../platform/index.js';
import { getGlobalOmcStateCandidates, getGlobalOmcStateRoot } from '../utils/paths.js';

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
 * OMC_TEST_REGISTRY_DIR overrides the default global state dir so that tests
 * can redirect all I/O to a temporary directory without touching global state.
 */
function getRegistryStateDir(): string {
  return process.env['OMC_TEST_REGISTRY_DIR'] ?? getGlobalOmcStateRoot();
}

/** Global registry JSONL path */
function getRegistryPath(): string {
  return join(getRegistryStateDir(), 'reply-session-registry.jsonl');
}

function getRegistryReadPaths(): string[] {
  if (process.env['OMC_TEST_REGISTRY_DIR']) {
    return [getRegistryPath()];
  }

  return getGlobalOmcStateCandidates('reply-session-registry.jsonl');
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
  platform: "discord-bot" | "telegram" | "slack-bot";
  messageId: string;
  sessionId: string;
  tmuxPaneId: string;
  tmuxSessionName: string;
  event: string;
  createdAt: string; // ISO timestamp
  projectPath?: string;
  /** AskUserQuestion metadata used to target the Other/free-text field for mobile replies. */
  askUserQuestionOptionCount?: number;
  askUserQuestionAllowOther?: boolean;
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
  try {
    Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
  } catch {
    // Main thread: Atomics.wait throws on Node <22
    const waitUntil = Date.now() + ms;
    while (Date.now() < waitUntil) { /* spin */ }
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
          if (snapshot.pid !== null && isProcessAlive(snapshot.pid)) {
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
 * Execute a mutation while holding the registry lock. Mutations never proceed
 * without ownership: callers receive `null` and can retry after lock failure.
 */
function withRegistryLock<T>(onLocked: () => T): T | null {
  const lock = acquireRegistryLockOrWait();

  if (lock === null) return null;
  try {
    return onLocked();
  } finally {
    releaseRegistryLock(lock);
  }
}

/**
 * Reserve an empty registry while the exact listener generation is stopped.
 * Holding this lock prevents a concurrent notification registration from being
 * lost between its empty check and process termination.
 */
export function lockRegistryIfEmpty(): (() => void) | 'active' | null {
  const lock = acquireRegistryLock();
  if (lock === null) return null;
  if (readAllMappingsUnsafe().length > 0) {
    releaseRegistryLock(lock);
    return 'active';
  }
  let released = false;
  return () => {
    if (!released) {
      released = true;
      releaseRegistryLock(lock);
    }
  };
}


/**
 * Register a message mapping (atomic JSONL append).
 *
 * Uses O_WRONLY | O_APPEND | O_CREAT for atomic appends (up to PIPE_BUF bytes on Linux).
 * Each mapping serializes to well under 4096 bytes, making this operation atomic.
 */
export function registerMessage(mapping: SessionMapping): boolean {
  return withRegistryLock(() => {
    ensureRegistryDir();
    const existing = readAllMappingsUnsafe().find((candidate) =>
      candidate.platform === mapping.platform &&
      candidate.messageId === mapping.messageId &&
      candidate.sessionId === mapping.sessionId &&
      candidate.tmuxPaneId === mapping.tmuxPaneId,
    );
    if (existing) return true;

    const line = JSON.stringify(mapping) + '\n';
    const fd = openSync(
      getRegistryPath(),
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
      SECURE_FILE_MODE,
    );

    try {
      writeSync(fd, Buffer.from(line, 'utf-8'));
      return true;
    } finally {
      closeSync(fd);
    }
  }) ?? false;
}


/**
 * Load all mappings from the JSONL file
 */
export function loadAllMappings(): SessionMapping[] {
  return withRegistryLock(() => readAllMappingsUnsafe()) ?? readAllMappingsUnsafe();
}

/**
 * Load all mappings without lock.
 * Caller must already hold lock (or accept race risk).
 */
function readAllMappingsUnsafe(): SessionMapping[] {
  for (const registryPath of getRegistryReadPaths()) {
    if (!existsSync(registryPath)) {
      continue;
    }

    try {
      const content = readFileSync(registryPath, 'utf-8');
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
      continue;
    }
  }

  return [];
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
export function removeSession(sessionId: string): boolean {
  return withRegistryLock(() => {
    const mappings = readAllMappingsUnsafe();
    const filtered = mappings.filter(m => m.sessionId !== sessionId);
    if (filtered.length !== mappings.length) rewriteRegistryUnsafe(filtered);
    return true;
  }) ?? false;
}


/**
 * Remove all entries for a given pane ID.
 * Called by reply listener when pane verification fails (stale pane cleanup).
 */
export function removeMessagesByPane(paneId: string): boolean {
  return withRegistryLock(() => {
    const mappings = readAllMappingsUnsafe();
    const filtered = mappings.filter(m => m.tmuxPaneId !== paneId);
    if (filtered.length !== mappings.length) rewriteRegistryUnsafe(filtered);
    return true;
  }) ?? false;
}


/**
 * Remove entries older than MAX_AGE_MS (24 hours).
 * This is a rewrite operation (infrequent - called periodically by daemon).
 */
export function pruneStale(): boolean {
  return withRegistryLock(() => {
    const now = Date.now();
    const mappings = readAllMappingsUnsafe();
    const filtered = mappings.filter(m => {
      try {
        return now - new Date(m.createdAt).getTime() < MAX_AGE_MS;
      } catch {
        return false;
      }
    });
    if (filtered.length !== mappings.length) rewriteRegistryUnsafe(filtered);
    return true;
  }) ?? false;
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
