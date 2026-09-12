import { closeSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const SQLITE_NATIVE_BINDING = 'better_sqlite3.node';
const SQLITE_NATIVE_BINDING_REMEDIATION =
  'Run `npm rebuild better-sqlite3` in the OMC plugin directory, then restart Claude Code.';
let Database = null;
let sqliteBindingLoadError = null;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function nativeBindingDiagnostic(detail) {
  const normalizedDetail = detail?.split(/\r?\n/, 1)[0].replace(/\s+/g, ' ').trim().slice(0, 240);
  const suffix = normalizedDetail ? ` Loader error: ${normalizedDetail}` : '';
  return `better-sqlite3 native binding (${SQLITE_NATIVE_BINDING}) is unavailable. State mutation is using the file-lock fallback. ${SQLITE_NATIVE_BINDING_REMEDIATION}${suffix}`;
}

function isNativeBindingError(error) {
  return /better[_-]sqlite3(?:\.node)?|bindings(?:\.js)?|MODULE_NOT_FOUND|NODE_MODULE_VERSION|did not self-register|Could not locate the bindings file/i.test(errorMessage(error));
}

try {
  const loaded = require('better-sqlite3');
  const candidate = typeof loaded === 'function' ? loaded : loaded?.default;
  if (typeof candidate !== 'function') throw new Error('better-sqlite3 did not export a Database constructor');
  Database = candidate;
} catch (error) {
  sqliteBindingLoadError = nativeBindingDiagnostic(errorMessage(error));
}

const localLocks = new Map();
const recoveryLocks = new Map();
let ownIdentityCache = null;
let lastLockFailure = null;
let lastLockFailureDetail = null;

function ownProcessStartIdentity() {
  if (ownIdentityCache === null) ownIdentityCache = processStartIdentity(process.pid);
  return ownIdentityCache;
}

function writeAllSync(fd, content, label) {
  const bytes = Buffer.from(content, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) throw new Error(`${label} made no progress`);
    offset += written;
  }
  if (fstatSync(fd).size !== bytes.length) throw new Error(`${label} size verification failed`);
}

export function processStartIdentity(pid) {
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_EMERGENCY_PROCESS_START_UNKNOWN_PID === String(pid)) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      const fields = end < 0 ? [] : stat.slice(end + 2).trim().split(/\s+/);
      return fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null;
    } catch (error) {
      return error?.code === 'ENOENT' ? 'absent' : null;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' },
      });
      if (result.status === 0 && result.stdout) {
        const time = new Date(result.stdout.trim()).getTime();
        if (!Number.isNaN(time)) return String(time);
      }
    } catch {}
  }
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction Stop; if ($p -and $p.StartTime) { $p.StartTime.ToUniversalTime().Ticks }`,
      ], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      const ticks = result.status === 0 ? result.stdout.trim().match(/^\d+$/)?.[0] : null;
      if (ticks) return `ticks:${ticks}`;
    } catch {}
  }
  try {
    process.kill(pid, 0);
    return null;
  } catch (error) {
    return error?.code === 'ESRCH' ? 'absent' : null;
  }
}

function mutationDbPath(lockPath) {
  let current = dirname(lockPath);
  while (basename(current) !== 'state') {
    const parent = dirname(current);
    if (parent === current) return join(dirname(lockPath), '.state-mutation-locks.db');
    current = parent;
  }
  return join(current, '.state-mutation-locks.db');
}

function canonicalKey(lockPath) {
  try { return resolve(realpathSync(dirname(lockPath)), basename(lockPath)); }
  catch { return resolve(lockPath); }
}

function stateFileLockingTestOverride() {
  if (process.env.NODE_ENV !== 'test') return null;
  return process.env.OMC_TEST_FLOCK_AVAILABLE === '0' || process.env.OMC_TEST_BETTER_SQLITE3_LOAD_FAILURE === '1'
    ? false
    : null;
}

function readOwner(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const pid = value.pid;
    if (
      value.version !== 1 || !Number.isSafeInteger(pid) || pid <= 0 ||
      typeof value.processStart !== 'string' || !/^\S+$/.test(value.processStart) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.nonce)
    ) return null;
    return value;
  } catch (error) {
    return error?.code === 'ENOENT' ? 'absent' : null;
  }
}

function ownerLive(owner) {
  const current = processStartIdentity(owner.pid);
  return current === null ? null : current === 'absent' ? false : current === owner.processStart;
}

function sameOwner(left, right) {
  return Boolean(left && right && left.pid === right.pid && left.processStart === right.processStart && left.nonce === right.nonce);
}

function ownerArtifactIdentity(path) {
  try {
    const stats = statSync(path);
    return stats.isFile() ? { dev: stats.dev, ino: stats.ino } : null;
  } catch {
    return null;
  }
}

/** Remove only the exact dead publication that was inspected. */
function reclaimDeadOwner(path, observed, identity) {
  const quarantinePath = `${path}.reclaim.${process.pid}.${randomUUID()}`;
  try {
    renameSync(path, quarantinePath);
  } catch (error) {
    return error?.code === 'ENOENT' ? 'changed' : 'failed';
  }

  let moved = null;
  let movedIdentity = null;
  try {
    moved = readOwner(quarantinePath);
    movedIdentity = ownerArtifactIdentity(quarantinePath);
    if (moved !== 'absent' && moved && movedIdentity &&
        movedIdentity.dev === identity.dev && movedIdentity.ino === identity.ino &&
        sameOwner(moved, observed)) {
      try {
        unlinkSync(quarantinePath);
        return 'removed';
      } catch {}
    }
  } catch {}

  // A replacement owner must survive. Restore the moved artifact only when no
  // newer publication has already claimed the final pathname.
  try {
    linkSync(quarantinePath, path);
    try { unlinkSync(quarantinePath); } catch {}
  } catch {}
  return 'changed';
}

function publishOwner(path, owner) {
  const tempPath = `${path}.${owner.pid}.${owner.nonce}.tmp`;
  let fd;
  try {
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(tempPath, 'wx', 0o600);
    writeAllSync(fd, JSON.stringify(owner), 'lock owner publication');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(tempPath, path);
    try {
      unlinkSync(tempPath);
    } catch (error) {
      const code = error?.code;
      if (code !== 'EPERM' && code !== 'EBUSY') throw error;
    }
    return true;
  } catch {
    try { if (fd !== undefined) closeSync(fd); } catch {}
    try { unlinkSync(tempPath); } catch {}
    return false;
  }
}

function openMutationDb(lockPath) {
  if (stateFileLockingTestOverride() === false || !Database) return null;
  let db = null;
  try {
    const dbPath = mutationDbPath(lockPath);
    for (const sidecar of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      try {
        const stats = statSync(sidecar);
        if (!stats.isFile() || stats.nlink !== 1) return null;
      } catch (error) {
        if (error?.code !== 'ENOENT') return null;
      }
    }
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 2000');
    db.exec('CREATE TABLE IF NOT EXISTS state_mutation_locks (lock_key TEXT PRIMARY KEY, version INTEGER NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL, created_at TEXT NOT NULL, nonce TEXT NOT NULL)');
    return db;
  } catch (error) {
    const detail = isNativeBindingError(error)
      ? errorMessage(error)
      : `SQLite backend initialization failed: ${errorMessage(error)}`;
    sqliteBindingLoadError = nativeBindingDiagnostic(detail);
    try { db?.close(); } catch {}
    return null;
  }
}

function recordFailure(kind, detail) {
  lastLockFailure = kind;
  lastLockFailureDetail = detail || null;
}

export function getStateFileLockDiagnostic() {
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_BETTER_SQLITE3_LOAD_FAILURE === '1') {
    sqliteBindingLoadError = nativeBindingDiagnostic('simulated native binding load failure');
  }
  return sqliteBindingLoadError;
}

export function getStateFileLockFailureMessage() {
  getStateFileLockDiagnostic();
  if (lastLockFailureDetail) return lastLockFailureDetail;
  if (lastLockFailure === 'contention') {
    return sqliteBindingLoadError
      ? `State mutation lock contention prevented the file-lock fallback. ${sqliteBindingLoadError}`
      : 'State mutation lock contention prevented acquisition.';
  }
  if (lastLockFailure === 'unverifiable') {
    return sqliteBindingLoadError
      ? `${sqliteBindingLoadError} The file-lock fallback metadata could not be verified.`
      : 'State mutation lock metadata could not be verified.';
  }
  return sqliteBindingLoadError || 'state mutation lock unavailable';
}

export function isStateFileLockingSupported() {
  // The owner-file fallback is a real exclusive backend, so callers must not
  // downgrade to an unlocked read when SQLite is unavailable.
  return true;
}

/**
 * Whether exclusive acquisition can be relied on right now. This is a
 * different question from "is any locking backend present": the flock
 * simulation used by the pre-SQLite fallback tests describes a host where an
 * exclusive-required caller has no backend to fail closed against, while
 * emergency recovery still has SQLite. Callers that authenticate state before
 * acting on it (cancel-signal validation) must ask this one.
 */
export function isExclusiveStateLockingAvailable() {
  const override = stateFileLockingTestOverride();
  return override !== null ? override : true;
}

function acquireFileLock(lockPath, attempts) {
  // This publication is also checked by SQLite contenders, so mixed backend
  // processes still serialize on one exact owner artifact.
  lastLockFailureDetail = null;
  const key = canonicalKey(lockPath);
  const processStart = ownProcessStartIdentity();
  if (!processStart || processStart === 'absent') {
    recordFailure('unverifiable');
    return null;
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const owner = {
      version: 1,
      pid: process.pid,
      processStart,
      createdAt: new Date().toISOString(),
      nonce: randomUUID(),
    };
    const tempPath = `${lockPath}.${owner.pid}.${owner.nonce}.tmp`;
    let fd;
    try {
      fd = openSync(tempPath, 'wx', 0o600);
      writeAllSync(fd, JSON.stringify(owner), 'lock owner publication');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      linkSync(tempPath, lockPath);
      try { unlinkSync(tempPath); } catch (error) {
        if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error;
      }
      const lock = { backend: 'file', key, path: lockPath, owner, depth: 1 };
      localLocks.set(key, lock);
      recordFailure(null);
      return lock;
    } catch (error) {
      try { if (fd !== undefined) closeSync(fd); } catch {}
      try { unlinkSync(tempPath); } catch {}
      if (error?.code !== 'EEXIST') {
        recordFailure('unverifiable');
        return null;
      }

      const existing = readOwner(lockPath);
      if (existing === 'absent') continue;
      if (!existing) {
        recordFailure('unverifiable');
        console.error(`[omc-lock] state_mutation_lock_unverifiable: ${lockPath}`);
        return null;
      }
      const live = ownerLive(existing);
      if (live === null) {
        recordFailure('unverifiable');
        return null;
      }
      if (live) {
        recordFailure('contention');
        if (attempt + 1 < attempts) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          continue;
        }
        return null;
      }
      const identity = ownerArtifactIdentity(lockPath);
      if (!identity) {
        recordFailure('unverifiable');
        return null;
      }
      const reclaimed = reclaimDeadOwner(lockPath, existing, identity);
      if (reclaimed === 'failed') {
        recordFailure('unverifiable');
        return null;
      }
    }
  }
  recordFailure('contention');
  return null;
}

export function acquireStateFileLockSync(filePath, attempts = 50, requireExclusive = false, bypassTestOverride = false) {
  lastLockFailureDetail = null;
  void requireExclusive;
  const lockPath = `${filePath}.mutation.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const key = canonicalKey(lockPath);
  const held = localLocks.get(key);
  if (held) {
    held.depth += 1;
    return held;
  }

  if (!bypassTestOverride && stateFileLockingTestOverride() === false) {
    if (process.env.OMC_TEST_BETTER_SQLITE3_LOAD_FAILURE === '1') {
      sqliteBindingLoadError = nativeBindingDiagnostic('simulated native binding load failure');
    }
    return acquireFileLock(lockPath, attempts);
  }

  const db = openMutationDb(lockPath);
  if (!db) {
    if (sqliteBindingLoadError) return acquireFileLock(lockPath, attempts);
    if (attempts <= 1) {
      recordFailure('unverifiable');
      return null;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    return acquireStateFileLockSync(filePath, attempts - 1, requireExclusive, bypassTestOverride);
  }

  const processStart = ownProcessStartIdentity();
  if (!processStart || processStart === 'absent') {
    try { db.close(); } catch {}
    if (attempts <= 1) {
      recordFailure('unverifiable');
      return null;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    return acquireStateFileLockSync(filePath, attempts - 1, requireExclusive, bypassTestOverride);
  }

  const owner = {
    version: 1,
    pid: process.pid,
    processStart,
    createdAt: new Date().toISOString(),
    nonce: randomUUID(),
  };
  const retry = code => code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'OMC_LOCK_PUBLICATION_RACE' || code === 'OMC_LOCK_RECLAIM_RACE';
  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare('SELECT version, pid, process_start, created_at, nonce FROM state_mutation_locks WHERE lock_key = ?').get(key);
    if (row) {
      if (row.version !== 1 || !Number.isSafeInteger(row.pid) || typeof row.process_start !== 'string' || typeof row.created_at !== 'string' || typeof row.nonce !== 'string') {
        db.exec('ROLLBACK');
        db.close();
        recordFailure('unverifiable');
        return null;
      }
      const live = ownerLive({ pid: row.pid, processStart: row.process_start });
      if (live === null || live) {
        db.exec('ROLLBACK');
        db.close();
        if (live === null || attempts <= 1) {
          recordFailure(live === null ? 'unverifiable' : 'contention');
          return null;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        return acquireStateFileLockSync(filePath, attempts - 1, requireExclusive, bypassTestOverride);
      }
      db.prepare('DELETE FROM state_mutation_locks WHERE lock_key = ?').run(key);
    }

    const artifact = readOwner(lockPath);
    if (artifact !== 'absent') {
      if (!artifact) {
        db.exec('ROLLBACK');
        db.close();
        recordFailure('unverifiable');
        console.error(`[omc-lock] state_mutation_lock_unverifiable: ${lockPath}`);
        return null;
      }
      const live = ownerLive(artifact);
      if (live === null || live) {
        db.exec('ROLLBACK');
        db.close();
        if (live === null || attempts <= 1) {
          recordFailure(live === null ? 'unverifiable' : 'contention');
          return null;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        return acquireStateFileLockSync(filePath, attempts - 1, requireExclusive, bypassTestOverride);
      }
      const identity = ownerArtifactIdentity(lockPath);
      if (!identity) {
        db.exec('ROLLBACK');
        db.close();
        recordFailure('unverifiable');
        return null;
      }
      const reclaimed = reclaimDeadOwner(lockPath, artifact, identity);
      if (reclaimed !== 'removed') {
        db.exec('ROLLBACK');
        db.close();
        if (reclaimed === 'changed' && attempts > 1) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          return acquireStateFileLockSync(filePath, attempts - 1, requireExclusive, bypassTestOverride);
        }
        recordFailure(reclaimed === 'changed' ? 'contention' : 'unverifiable');
        return null;
      }
    }

    db.prepare('INSERT INTO state_mutation_locks (lock_key, version, pid, process_start, created_at, nonce) VALUES (?, 1, ?, ?, ?, ?)').run(key, owner.pid, owner.processStart, owner.createdAt, owner.nonce);
    if (!publishOwner(lockPath, owner)) {
      db.exec('ROLLBACK');
      db.close();
      if (attempts <= 1) {
        recordFailure('contention');
        return null;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      return acquireStateFileLockSync(filePath, attempts - 1, requireExclusive, bypassTestOverride);
    }
    db.exec('COMMIT');
    const lock = { backend: 'sqlite', db, key, path: lockPath, owner, depth: 1 };
    localLocks.set(key, lock);
    recordFailure(null);
    return lock;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    try { db.close(); } catch {}
    if (isNativeBindingError(error)) sqliteBindingLoadError = nativeBindingDiagnostic(errorMessage(error));
    if (retry(error?.code) && attempts > 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      return acquireStateFileLockSync(filePath, attempts - 1, requireExclusive, bypassTestOverride);
    }
    recordFailure(error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED' ? 'contention' : 'unverifiable');
    return null;
  }
}

export function releaseStateFileLockSync(lock) {
  if (!lock) return true;
  if (lock.depth > 1) {
    lock.depth -= 1;
    return true;
  }
  localLocks.delete(lock.key);

  if (lock.backend === 'file') {
    try {
      const current = readOwner(lock.path);
      if (current === 'absent') return true;
      if (!current || !sameOwner(current, lock.owner)) {
        recordFailure('unverifiable', `State mutation lock release failed; owner metadata changed or disappeared: ${lock.path}`);
        console.error(`[omc-lock] state_mutation_lock_release_failed: ${lock.path}`);
        return false;
      }
      unlinkSync(lock.path);
      return true;
    } catch (error) {
      recordFailure('unverifiable', `State mutation lock release failed for ${lock.path}: ${error?.code || 'unknown error'}`);
      console.error(`[omc-lock] state_mutation_lock_release_failed: ${lock.path} ${error?.code || ''}`.trim());
      return false;
    }
  }

  try {
    lock.db.exec('BEGIN IMMEDIATE');
    const row = lock.db.prepare('SELECT version, pid, process_start, created_at, nonce FROM state_mutation_locks WHERE lock_key = ?').get(lock.key);
    const current = readOwner(lock.path);
    if (!row || row.version !== 1 || !sameOwner({ pid: row.pid, processStart: row.process_start, nonce: row.nonce }, lock.owner) || !sameOwner(current === 'absent' ? null : current, lock.owner)) {
      lock.db.exec('ROLLBACK');
      recordFailure('unverifiable', `State mutation lock release failed; owner metadata changed or disappeared: ${lock.path}`);
      console.error(`[omc-lock] state_mutation_lock_release_failed: ${lock.path}`);
      return false;
    }
    unlinkSync(lock.path);
    lock.db.prepare('DELETE FROM state_mutation_locks WHERE lock_key = ?').run(lock.key);
    lock.db.exec('COMMIT');
    return true;
  } catch (error) {
    try { lock.db.exec('ROLLBACK'); } catch {}
    recordFailure('unverifiable', `State mutation lock release failed for ${lock.path}: ${error?.code || 'unknown error'}`);
    console.error(`[omc-lock] state_mutation_lock_release_failed: ${lock.path} ${error?.code || ''}`.trim());
    return false;
  } finally {
    try { lock.db.close(); } catch {}
  }
}

export function withStateFileLockSync(filePath, callback, requireExclusive = false) {
  const lock = acquireStateFileLockSync(filePath, 50, requireExclusive);
  if (!lock) return { acquired: false, value: undefined };
  let value;
  let releaseFailed = false;
  try {
    value = callback();
  } finally {
    releaseFailed = !releaseStateFileLockSync(lock);
  }
  return releaseFailed ? { acquired: false, value: undefined } : { acquired: true, value };
}

export function acquireRecoveryClaim(path, attempts = 50) {
  const lock = acquireStateFileLockSync(path, attempts, true, true);
  if (!lock) return null;
  const existing = readOwner(path);
  if (existing !== 'absent') {
    if (!existing || ownerLive(existing) !== false) {
      releaseStateFileLockSync(lock);
      return null;
    }
    const identity = ownerArtifactIdentity(path);
    const reclaimed = identity ? reclaimDeadOwner(path, existing, identity) : 'failed';
    if (reclaimed !== 'removed') {
      releaseStateFileLockSync(lock);
      return null;
    }
  }
  const processStart = ownProcessStartIdentity();
  if (!processStart || processStart === 'absent') {
    releaseStateFileLockSync(lock);
    if (attempts <= 1) return null;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    return acquireRecoveryClaim(path, attempts - 1);
  }
  const owner = {
    version: 1,
    pid: process.pid,
    processStart,
    createdAt: new Date().toISOString(),
    nonce: randomUUID(),
  };
  if (!publishOwner(path, owner)) {
    releaseStateFileLockSync(lock);
    return null;
  }
  recoveryLocks.set(path, { lock, owner });
  return owner;
}

export function readRecoveryClaim(path) {
  const owner = readOwner(path);
  return owner === 'absent' ? null : owner;
}

export function releaseRecoveryClaim(path, owner) {
  const held = recoveryLocks.get(path);
  const lock = held?.lock || localLocks.get(canonicalKey(`${path}.mutation.lock`));
  if (!lock) return false;
  let released = true;
  try {
    const current = readRecoveryClaim(path);
    if (sameOwner(current, owner)) {
      try { unlinkSync(path); }
      catch (error) {
        recordFailure('unverifiable', `Recovery claim release failed for ${path}: ${error?.code || 'unknown error'}`);
        console.error(`[omc-lock] recovery_claim_release_failed: ${path} ${error?.code || ''}`.trim());
        released = false;
      }
    }
  } finally {
    recoveryLocks.delete(path);
    if (!releaseStateFileLockSync(lock)) released = false;
  }
  return released;
}

export function sameRecoveryClaim(left, right) {
  return sameOwner(left, right);
}

export function isEmergencyOwnerLive(owner) {
  return ownerLive(owner) !== false;
}
