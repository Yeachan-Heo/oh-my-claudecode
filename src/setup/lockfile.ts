/**
 * Setup lockfile — prevents concurrent `runSetup()` invocations.
 *
 * Plan reference: /Users/peter/.claude-personal/plans/replicated-mixing-wren.md
 *   — "Concurrent invocation is guarded by a hostname+PID lockfile at `.omc/state/setup.lock`"
 *   — Risks table: NFS concern (foreign hostname) + stale lockfile handling
 *
 * Invariants:
 *   1. Acquisition is atomic via `fs.writeFileSync(path, content, { flag: 'wx' })`.
 *   2. Lockfile is released automatically on `process.exit`, SIGINT, SIGTERM.
 *   3. Foreign hostname (NFS-shared `$HOME`) is **never** auto-released — the
 *      lock is rejected with a clear message. User must delete it by hand.
 *   4. Stale detection (same host): if the recorded PID is not alive AND the
 *      lock is older than `STALE_LOCK_MS` (1 hour), the lock is auto-released
 *      and re-acquired. The age threshold prevents races where a long-running
 *      setup briefly loses its PID entry under heavy load.
 *   5. Hostname + PID alive → reject (collision with an active setup).
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';

/** Lockfile age above which a lock whose owner PID is dead is treated as stale. */
export const STALE_LOCK_MS = 60 * 60 * 1000;

export type Invoker = 'cli' | 'skill';

export interface LockContent {
  pid: number;
  hostname: string;
  startedAt: string;
  invoker: Invoker;
}

export interface LockHandle {
  readonly path: string;
  readonly content: LockContent;
  /** Release the lock (idempotent). */
  release(): void;
}

export class LockHeldError extends Error {
  constructor(
    message: string,
    public readonly existing: LockContent,
    public readonly lockPath: string,
  ) {
    super(message);
    this.name = 'LockHeldError';
  }
}

export interface AcquireLockOptions {
  /** Override `os.hostname()` — test-only. */
  hostname?: string;
  /** Override `process.pid` — test-only. */
  pid?: number;
  /** Override `Date.now()` — test-only (used for `startedAt`). */
  now?: () => number;
  /** Override the liveness check — test-only. */
  isPidAlive?: (pid: number) => boolean;
}

/**
 * Check whether a PID is currently alive.
 *
 * `process.kill(pid, 0)` throws when the process doesn't exist, or when we
 * lack permission to signal it. In the "EPERM" case the process DOES exist
 * but is owned by a different user — we treat that as alive (conservative).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH = no such process → dead
    // EPERM = exists but we can't signal it → treat as alive
    return code === 'EPERM';
  }
}

function parseLockFile(raw: string): LockContent | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockContent>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.hostname === 'string' &&
      typeof parsed.startedAt === 'string' &&
      (parsed.invoker === 'cli' || parsed.invoker === 'skill')
    ) {
      return parsed as LockContent;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function isStale(
  existing: LockContent,
  now: number,
  aliveFn: (pid: number) => boolean,
): boolean {
  const startedAtMs = Date.parse(existing.startedAt);
  if (Number.isNaN(startedAtMs)) return true; // corrupt timestamp → stale
  const ageMs = now - startedAtMs;
  if (ageMs < STALE_LOCK_MS) return false;
  return !aliveFn(existing.pid);
}

/**
 * Acquire the setup lockfile. Throws `LockHeldError` if another setup is
 * already running on the same host, or if the lockfile was written on a
 * different host (foreign hostname — NFS concern, never auto-released).
 *
 * On successful acquisition, returns a `LockHandle` with a `release()`
 * method. Callers SHOULD also register cleanup on process signals — see
 * `registerLockCleanup()` below.
 */
export function acquireLock(
  lockPath: string,
  invoker: Invoker,
  opts: AcquireLockOptions = {},
): LockHandle {
  const host = opts.hostname ?? hostname();
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now;
  const aliveFn = opts.isPidAlive ?? isPidAlive;

  mkdirSync(dirname(lockPath), { recursive: true });

  // Fast-path: file does not exist — try atomic create.
  // If it does exist, inspect it and decide.
  if (existsSync(lockPath)) {
    let raw = '';
    try {
      raw = readFileSync(lockPath, 'utf8');
    } catch {
      /* treat as corrupt → break below */
    }
    const existing = parseLockFile(raw);
    if (!existing) {
      // Corrupt or unreadable: reset and re-acquire.
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    } else if (existing.hostname !== host) {
      // Foreign hostname — never auto-release (NFS concern).
      throw new LockHeldError(
        `setup lockfile at ${lockPath} was created on a different host `
        + `(${existing.hostname}, pid ${existing.pid}). Refusing to auto-release. `
        + `If you are sure no other setup is running, delete the file manually `
        + `or run \`omc setup --state-clear\`.`,
        existing,
        lockPath,
      );
    } else if (!isStale(existing, now(), aliveFn)) {
      // Same host, still owned — collision.
      throw new LockHeldError(
        `another \`omc setup\` is already running (pid ${existing.pid}, `
        + `started ${existing.startedAt}). If the other process is hung, `
        + `kill it and re-run; or delete ${lockPath} manually.`,
        existing,
        lockPath,
      );
    } else {
      // Stale on this host: auto-release.
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }

  const content: LockContent = {
    pid,
    hostname: host,
    startedAt: new Date(now()).toISOString(),
    invoker,
  };

  // Atomic create with `wx` flag — fails if the file sprang into existence
  // between our existsSync check and this write (defeats a TOCTOU race).
  try {
    writeFileSync(lockPath, JSON.stringify(content, null, 2), { flag: 'wx' });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      // Lost a race — re-read and surface as LockHeldError.
      let raw = '';
      try { raw = readFileSync(lockPath, 'utf8'); } catch { /* ignore */ }
      const existing = parseLockFile(raw) ?? {
        pid: -1, hostname: 'unknown', startedAt: new Date(now()).toISOString(), invoker: 'cli',
      };
      throw new LockHeldError(
        `another \`omc setup\` acquired the lock concurrently (pid ${existing.pid}).`,
        existing,
        lockPath,
      );
    }
    throw err;
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      // Only remove if the file still contains OUR content — don't clobber
      // a lock that was taken over after auto-release.
      if (existsSync(lockPath)) {
        const raw = readFileSync(lockPath, 'utf8');
        const parsed = parseLockFile(raw);
        if (parsed && parsed.pid === content.pid && parsed.hostname === content.hostname) {
          unlinkSync(lockPath);
        }
      }
    } catch {
      /* swallow — best-effort cleanup */
    }
  };

  return { path: lockPath, content, release };
}

/**
 * Register signal handlers that release the lock on unclean termination.
 *
 * Handlers installed:
 *   - `exit`        → sync release (no async work allowed)
 *   - `SIGINT`      → release, then re-raise (default) to exit 130
 *   - `SIGTERM`     → release, then re-raise to exit 143
 *   - `uncaughtException` → release, then re-throw so node's default handler runs
 *
 * Returns a deregister function the caller should invoke on normal exit so
 * the handlers don't accumulate across test runs.
 */
export function registerLockCleanup(handle: LockHandle): () => void {
  const onExit = (): void => handle.release();
  const onSigint = (): void => {
    handle.release();
    // Re-raise the default SIGINT behavior: exit 130
    process.exit(130);
  };
  const onSigterm = (): void => {
    handle.release();
    process.exit(143);
  };
  const onUncaught = (err: Error): void => {
    handle.release();
    // Re-throw so node's default "unhandled error" printing runs.
    // Using `nextTick` avoids swallowing by the current listener.
    process.nextTick(() => { throw err; });
  };

  process.on('exit', onExit);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('uncaughtException', onUncaught);

  return (): void => {
    process.off('exit', onExit);
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.off('uncaughtException', onUncaught);
  };
}
