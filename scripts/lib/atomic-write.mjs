/**
 * Atomic file writes for oh-my-claudecode hooks.
 * Self-contained module with no external dependencies.
 */

import { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, mkdirSync, existsSync, readFileSync, readdirSync, linkSync, statSync, fstatSync } from 'fs';
import { dirname, basename, join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { spawnSync } from 'child_process';

/**
 * Ensure directory exists
 */
export function ensureDirSync(dir) {
  if (existsSync(dir)) {
    return;
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code === 'EEXIST') {
      return;
    }
    throw err;
  }
}

function writeAllSync(fd, content, label) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) throw new Error(`${label} made no progress`);
    offset += written;
  }
  if (fstatSync(fd).size !== bytes.length) throw new Error(`${label} size verification failed`);
}


/**
 * Write string content atomically to a file.
 * Uses temp file + atomic rename pattern with fsync for durability.
 *
 * @param {string} filePath Target file path
 * @param {string} content String content to write
 */
export function atomicWriteFileSync(filePath, content) {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const tempPath = join(dir, `.${base}.tmp.${randomUUID()}`);

  let fd = null;
  let success = false;

  try {
    // Ensure parent directory exists
    ensureDirSync(dir);

    // Open temp file with exclusive creation (O_CREAT | O_EXCL | O_WRONLY)
    fd = openSync(tempPath, 'wx', 0o600);

    // Write content
    writeAllSync(fd, content, 'atomic write');

    // Sync file data to disk before rename
    fsyncSync(fd);

    // Close before rename
    closeSync(fd);
    fd = null;

    // Atomic rename - replaces target file if it exists
    renameSync(tempPath, filePath);

    success = true;

    // Best-effort directory fsync to ensure rename is durable
    try {
      const dirFd = openSync(dir, 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Some platforms don't support directory fsync - that's okay
    }
  } finally {
    // Close fd if still open
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
    // Clean up temp file on error
    if (!success) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

const LOCK_SCHEMA_VERSION = 1;
function flockPath() {
  // B8 test seam: OMC_TEST_FORCE_FLOCKLESS=1 (NODE_ENV=test only) forces the
  // flock-less linkSync branch on a host that actually has flock (Linux CI),
  // so the flock-less acquire/reclaim/release code is exercised there. Unlike
  // OMC_TEST_FLOCK_AVAILABLE=0 it does NOT trip lockingDisabledForTest(), so
  // exclusive locking stays enabled and the real flock-less path runs.
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_FORCE_FLOCKLESS === '1') return null;
  return process.env.NODE_ENV === 'test' && process.env.OMC_TEST_FLOCK_AVAILABLE === '0' ? null : existsSync('/usr/bin/flock') ? '/usr/bin/flock' : existsSync('/bin/flock') ? '/bin/flock' : null;
}
/**
 * True only when the test harness explicitly simulates a runtime with NO
 * locking primitives whatsoever (OMC_TEST_FLOCK_AVAILABLE=0). Distinct from a
 * real flock-less runtime (Windows/macOS): there, linkSync-based O_EXCL locking
 * is still a valid mutual-exclusion mechanism and may be used. Under the test
 * simulation, exclusive locks must remain unavailable (return null) so callers
 * fail closed - the same contract the dev branch established. Mirrors
 * lockingDisabledForTest() in src/lib/mode-state-io.ts.
 */
function lockingDisabledForTest() {
  return process.env.NODE_ENV === 'test' && process.env.OMC_TEST_FLOCK_AVAILABLE === '0';
}
const LOCK_REMOVAL_SCRIPT = String.raw`
const fs = require('fs');
const [operation, lockPath, expectedRaw] = process.argv.slice(1);
const keys = ['createdAt', 'nonce', 'pid', 'processStart', 'version'];
function readOwner() {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const actual = Object.keys(value).sort();
    if (actual.length !== keys.length || !actual.every((key, index) => key === keys[index]) || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.processStart !== 'string' || !/^\d+$/.test(value.processStart) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.nonce)) return null;
    return value;
  } catch (error) { if (error && error.code === 'ENOENT') process.exit(0); return null; }
}
const owner = readOwner();
if (!owner) process.exit(3);
if (operation === 'release') {
  let expected;
  try { expected = JSON.parse(expectedRaw); } catch { process.exit(3); }
  if (owner.pid !== expected.pid || owner.processStart !== expected.processStart || owner.nonce !== expected.nonce) process.exit(4);
  try { fs.unlinkSync(lockPath); process.exit(0); } catch { process.exit(3); }
}
if (process.platform !== 'linux') process.exit(3);
let currentStart;
try {
  const stat = fs.readFileSync('/proc/' + owner.pid + '/stat', 'utf8');
  const end = stat.lastIndexOf(')');
  const fields = end >= 0 ? stat.slice(end + 2).trim().split(/\s+/) : [];
  currentStart = fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null;
} catch (error) { currentStart = error && error.code === 'ENOENT' ? 'absent' : null; }
if (currentStart === null) process.exit(3);
if (currentStart !== 'absent' && currentStart === owner.processStart) process.exit(2);
try { fs.unlinkSync(lockPath); process.exit(0); } catch { process.exit(3); }
`;

// Cached process_start for the current pid on non-linux platforms. The value
// Date.now()-uptime*1000 is the process start epoch and is invariant for the
// lifetime of the process, but Math.floor of it can tick by 1s as realtime and
// uptime advance, so recomputing it on every call could make a live self-owner
// misclassified as PID-reused (dead) and its lock stolen. Cache it once.
let cachedSelfProcessStart;

function selfProcessStart() {
  if (cachedSelfProcessStart === undefined) {
    cachedSelfProcessStart = String(Math.max(1, Math.floor(Date.now() - process.uptime() * 1000)));
  }
  return cachedSelfProcessStart;
}

function processStartIdentity(pid) {
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_EMERGENCY_PROCESS_START_UNKNOWN_PID === String(pid)) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform !== 'linux') return pid === process.pid ? selfProcessStart() : null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return null;
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    return fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null;
  } catch (error) { return error?.code === 'ENOENT' ? 'absent' : null; }
}

/**
 * Cross-platform process liveness probe. process.kill(pid, 0) sends no signal
 * and throws only when the pid is unreachable; on every supported platform it
 * is the cheapest reliable "is this pid alive" check. Mirrors
 * src/graph/platform.ts isProcessAlive.
 *
 * B6: the error code distinguishes "dead" from "alive but not ours". ESRCH
 * means the pid does not exist (dead -> reclaimable). EPERM means the pid
 * exists but is owned by another uid (root daemon, multi-user, container uid
 * mismatch) -> it is ALIVE; collapsing EPERM into "dead" let a thief steal a
 * live other-uid owner's lock. Any other error fails closed (alive = never
 * steal), matching the "not ours" = alive contract.
 */
function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error?.code === 'ESRCH') return false; // pid does not exist -> dead
    return true; // EPERM (alive, not ours) or any other error -> fail closed (never steal)
  }
}

/**
 * Owner-liveness for the mutation lock. A live owner is one whose pid is alive
 * AND whose process_start still matches (no PID reuse). A dead pid is always a
 * dead owner (reclaimable). An alive pid with an unverifiable process_start
 * (non-linux external pid) is treated as LIVE - stealing a claim is never safe
 * when ownership cannot be disproved. Mirrors isMutationLockOwnerLive in
 * src/lib/mode-state-io.ts and the flock path's LOCK_REMOVAL_SCRIPT contract.
 */
function isLockOwnerLive(owner) {
  if (!isProcessAlive(owner.pid)) return false;
  const current = processStartIdentity(owner.pid);
  if (current === 'absent') return false;
  if (current === null) return true; // unverifiable -> never steal
  return current === owner.processStart;
}
function guardedLockRemoval(lockPath, operation, owner) {
  const flock = flockPath();
  if (!flock) return 'unverifiable';
  const result = spawnSync(flock, ['-x', `${lockPath}.reclaim.guard`, process.execPath, '-e', LOCK_REMOVAL_SCRIPT, operation, lockPath, owner ? JSON.stringify(owner) : ''], { stdio: 'ignore', timeout: 2000 });
  if (result.status === 0) return 'retry';
  if (result.status === 2) return 'live';
  if (result.status === 4) return 'replaced';
  return 'unverifiable';
}

function acquireLockAt(lockPath, attempts = 50, requireExclusive = false) {
  ensureDirSync(dirname(lockPath));
  const hasFlock = !!flockPath();
  // Under the explicit test no-locking simulation, exclusive locks are
  // unavailable (fail closed), matching the dev contract. On real flock-less
  // runtimes (Windows/macOS) we still fall through to linkSync-based locking.
  if (lockingDisabledForTest()) return requireExclusive ? null : { unlocked: true };
  if (!hasFlock && !requireExclusive) return { unlocked: true };
  const processStart = processStartIdentity(process.pid);
  if (!processStart || processStart === 'absent') {
    console.error(`[omc-lock] state_mutation_lock_owner_unverifiable: ${lockPath}`);
    return null;
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const owner = { version: LOCK_SCHEMA_VERSION, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
    const tempPath = `${lockPath}.${process.pid}.${owner.nonce}.tmp`;
    let fd;
    try {
      fd = openSync(tempPath, 'wx', 0o600);
      writeAllSync(fd, JSON.stringify(owner), 'lock owner publication');
      fsyncSync(fd);
      linkSync(tempPath, lockPath);
      unlinkSync(tempPath);
      return { fd, lockPath, owner };
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      try { unlinkSync(tempPath); } catch {}
      if (error?.code !== 'EEXIST') return null;
      if (hasFlock) {
        const disposition = guardedLockRemoval(lockPath, 'reclaim');
        if (disposition === 'unverifiable') {
          console.error(`[omc-lock] state_mutation_lock_unverifiable: ${lockPath}`);
          return null;
        }
        if (disposition === 'live') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      } else {
        // flock-less runtime (macOS/Windows): reclaim ONLY a demonstrably-dead
        // owner's lock. A live owner's lock is never unlinked by a thief
        // (B2: previously this branch had no reclaim at all - guardedLockRemoval
        // returned 'unverifiable' immediately when flock was null, so a crashed
        // process wedged the lock permanently). On I/O failure or a
        // corrupt/unparseable file we initially fail closed (wait) because we
        // cannot prove the owner is dead.
        //
        // B7 convergence: the flock path (LOCK_REMOVAL_SCRIPT) reclaims as soon
        // as the owner is demonstrably dead (immediate recovery, NO age gate).
        // The flock-less path previously required stale (>1h) && dead, diverging
        // by up to 1h and wedging autopilot detection. The policies are now
        // converged: liveness-only reclaim. A validated owner is reclaimed as
        // soon as isLockOwnerLive is false (dead pid or PID reuse), matching
        // the flock path's immediate reclaim.
        //
        // B7 corrupt-lock bounded recovery: a corrupt/truncated lock file ->
        // readLockOwner returns null -> we previously logged unverifiable and
        // returned null FOREVER (permanent wedge, no operator escape). Failing
        // closed is right; failing closed forever is not. We still fail closed
        // on early attempts, but on the final attempts of the bounded loop we
        // reclaim (unlink) the corrupt lock so recovery is bounded, not
        // permanent. The owner cannot be proven live OR dead from a corrupt
        // file, so this only fires after the loop has already failed to acquire
        // for ~all of its budget - a last-resort escape, not a fast steal.
        const current = readLockOwner(lockPath);
        if (current && current !== 'absent') {
          // Validated owner present. Reclaim as soon as the owner is
          // demonstrably dead (liveness-only, matching the flock path). A live
          // owner blocks the steal.
          if (!isLockOwnerLive(current)) {
            try { unlinkSync(lockPath); } catch { /* race; retry linkSync */ }
          } else {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        } else if (current === null) {
          // Readable-but-corrupt or I/O failure on a possibly-live lock. Fail
          // closed (wait) for most of the loop; on the final attempts, reclaim
          // (unlink) the corrupt lock so a corrupt file cannot wedge the lock
          // permanently (B7 bounded recovery).
          if (attempt >= 45) {
            try { unlinkSync(lockPath); } catch { /* race; retry linkSync */ }
          } else {
            console.error(`[omc-lock] state_mutation_lock_unverifiable: ${lockPath}`);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        // 'absent' (lock vanished between EEXIST and read): retry linkSync.
      }
    }
  }
  return null;
}

export function acquireStateFileLockSync(filePath, attempts = 50, requireExclusive = false) {
  return acquireLockAt(`${filePath}.mutation.lock`, attempts, requireExclusive);
}

/**
 * B5/B8 test seam: returns the process_start value production will compute for
 * the CURRENT pid on this platform (jiffies since boot on Linux /proc/<pid>/stat
 * field 22; a ms-epoch derived from Date.now()-uptime on non-linux). Tests that
 * plant a "live" owner MUST use this - NOT a re-derived ms epoch - so the
 * planted owner matches what processStartIdentity computes on the CI platform
 * (Linux jiffies != ms epoch). Gated to NODE_ENV=test; no-op in production.
 */
export function __testCurrentProcessStart() {
  if (process.env.NODE_ENV !== 'test') return null;
  const start = processStartIdentity(process.pid);
  return typeof start === 'string' ? start : null;
}

function sameLockOwner(left, right) {
  return left.pid === right.pid && left.processStart === right.processStart && left.nonce === right.nonce;
}

const LOCK_OWNER_KEYS = ['createdAt', 'nonce', 'pid', 'processStart', 'version'];

/**
 * Validates a parsed object as a lock owner using the SAME checks the flock
 * path's LOCK_REMOVAL_SCRIPT enforces: exact key set, version===1, positive
 * integer pid, /^\d+$/ processStart, parseable createdAt, 36-char UUID nonce.
 * Single owner validator (B4: folded two divergent validators into one).
 */
function validateLockOwner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const actual = Object.keys(value).sort();
  if (actual.length !== LOCK_OWNER_KEYS.length || !actual.every((key, index) => key === LOCK_OWNER_KEYS[index])) return null;
  if (value.version !== 1) return null;
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
  if (typeof value.processStart !== 'string' || !/^\d+$/.test(value.processStart)) return null;
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return null;
  if (typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.nonce)) return null;
  return value;
}

/**
 * Reads and validates the on-disk lock owner. Returns the owner on success,
 * 'absent' when the lock file does not exist (ENOENT), or null when the file
 * is readable but unparseable/invalid OR when the read failed with a
 * non-ENOENT I/O error. Distinguishing 'absent' from null lets the caller fail
 * closed on a possibly-live-but-unreadable lock instead of unlinking it.
 */
function readLockOwner(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent';
    return null; // I/O failure (EACCES/EMFILE/EIO/...) - may be a live lock we can't read
  }
  try {
    return validateLockOwner(JSON.parse(raw));
  } catch {
    return null; // readable but corrupt JSON - cannot prove the owner is dead
  }
}

export function releaseStateFileLockSync(lock) {
  if (!lock || lock.unlocked) return;
  try { closeSync(lock.fd); } catch {}
  if (flockPath()) {
    guardedLockRemoval(lock.lockPath, 'release', lock.owner);
  } else {
    // flock-less runtime (macOS/Windows) or the explicit test simulation: verify
    // ownership before unlinking. With the B2 acquire-side fix a live owner's
    // lock can no longer be stolen, so between acquire and release the path
    // should still be ours. Re-validate immediately before unlink to close the
    // TOCTOU window between readLockOwner and unlinkSync; on mismatch leave the
    // live owner's lock in place and log the event so it is observable.
    const current = readLockOwner(lock.lockPath);
    if (current === 'absent') return; // already released
    if (current && sameLockOwner(current, lock.owner)) {
      try { unlinkSync(lock.lockPath); } catch { /* race or already removed */ }
    } else {
      console.error(`[omc-lock] state_mutation_lock_release_owner_mismatch: ${lock.lockPath}`);
    }
  }
}

export function withStateFileLockSync(filePath, callback, requireExclusive = false) {
  const lock = acquireStateFileLockSync(filePath, 50, requireExclusive);
  if (!lock) return { acquired: false, value: undefined };
  try {
    return { acquired: true, value: callback() };
  } finally {
    releaseStateFileLockSync(lock);
  }
}

/** Recover an interrupted exact emergency state mutation without touching replacements. */
function stateDigest(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

function emergencyJournalPath(filePath) {
  return `${filePath}.emergency-journal.json`;
}


function sameEmergencyOwner(left, right) {
  return left.pid === right.pid && left.processStart === right.processStart && left.nonce === right.nonce;
}

/** Unknown process identity is treated as live; only an exact start identity proves ownership. */
function isEmergencyOwnerLive(owner) {
  const currentStart = processStartIdentity(owner.pid);
  return currentStart !== 'absent' && (currentStart === null || currentStart === owner.processStart);
}

function journalIsOwned(path, transactionId, owner) {
  const current = readEmergencyJournal(path);
  return current !== null && current.transactionId === transactionId && sameEmergencyOwner(current.owner, owner);
}

function writeEmergencyJournal(path, journal, requireOwnership = true) {
  try {
    if (requireOwnership && !journalIsOwned(path, journal.transactionId, journal.owner)) return false;
    atomicWriteFileSync(path, JSON.stringify(journal, null, 2));
    return !requireOwnership || journalIsOwned(path, journal.transactionId, journal.owner);
  } catch { return false; }
}

function emergencyPublicationTempPath(path) {
  const processStart = processStartIdentity(process.pid);
  if (!processStart || processStart === 'absent') return null;
  return `${path}.${process.pid}.${processStart}.${randomUUID()}.tmp`;
}

/** Publishes a complete, durable transaction file without exposing a partial final path. */
function publishEmergencyFileExclusive(path, content) {
  const tempPath = emergencyPublicationTempPath(path);
  let fd;
  try {
    if (!tempPath) return false;
    ensureDirSync(dirname(path));
    fd = openSync(tempPath, 'wx', 0o600);
    const bytes = Buffer.from(content);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('emergency publication made no progress');
      offset += written;
    }
    fsyncSync(fd);
    if (statSync(tempPath).size !== bytes.length) throw new Error('emergency publication truncated');
    closeSync(fd);
    fd = undefined;
    linkSync(tempPath, path);
    unlinkSync(tempPath);
    return true;
  } catch { return false; }
  finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    if (tempPath) {
      const generation = fileIdentity(tempPath);
      try { if (generation && sameFile(tempPath, generation)) unlinkSync(tempPath); } catch {}
    }
  }
}

const RECOVERY_CLAIM_SCRIPT = String.raw`
const fs = require('fs');
const [operation, claimPath, expectedRaw] = process.argv.slice(1);
const keys = ['createdAt', 'nonce', 'pid', 'processStart', 'version'];
function readOwner() {
  try {
    const value = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
    const actual = Object.keys(value).sort();
    if (actual.length !== keys.length || !actual.every((key, index) => key === keys[index]) || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.processStart !== 'string' || !/^\d+$/.test(value.processStart) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.nonce)) return null;
    return value;
  } catch (error) { return error && error.code === 'ENOENT' ? 'absent' : null; }
}
function exact(left, right) { return left.pid === right.pid && left.processStart === right.processStart && left.nonce === right.nonce; }
function stale(owner) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync('/proc/' + owner.pid + '/stat', 'utf8');
    const end = stat.lastIndexOf(')');
    const fields = end >= 0 ? stat.slice(end + 2).trim().split(/\s+/) : [];
    const start = fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null;
    return start === null ? null : start !== owner.processStart;
  } catch (error) { return error && error.code === 'ENOENT' ? true : null; }
}
let expected;
try { expected = JSON.parse(expectedRaw); } catch { process.exit(3); }
if (operation === 'release') {
  const current = readOwner();
  if (current === 'absent') process.exit(0);
  if (!current || !exact(current, expected)) process.exit(4);
  try { fs.unlinkSync(claimPath); process.exit(0); } catch { process.exit(3); }
}
const current = readOwner();
if (current !== 'absent') {
  if (!current) process.exit(3);
  const isStale = stale(current);
  if (isStale !== true) process.exit(isStale === false ? 2 : 3);
  try { fs.unlinkSync(claimPath); } catch { process.exit(3); }
}
let fd;
try {
  fd = fs.openSync(claimPath, 'wx', 0o600);
  const bytes = Buffer.from(JSON.stringify(expected));
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('recovery claim made no progress');
    offset += written;
  }
  fs.fsyncSync(fd);
  if (fs.statSync(claimPath).size !== bytes.length) throw new Error('recovery claim truncated');
  fs.closeSync(fd);
  process.exit(0);
} catch { try { if (fd !== undefined) fs.closeSync(fd); } catch {} try { fs.unlinkSync(claimPath); } catch {} process.exit(3); }
`;

function guardedRecoveryClaim(path, operation, owner) {
  const flock = flockPath();
  if (!flock) return 'unverifiable';
  const result = spawnSync(flock, ['-x', `${path}.recovery.guard`, process.execPath, '-e', RECOVERY_CLAIM_SCRIPT, operation, path, JSON.stringify(owner)], { stdio: 'ignore', timeout: 2000 });
  if (result.status === 0) return 'claimed';
  if (result.status === 2) return 'live';
  if (result.status === 4) return 'replaced';
  return 'unverifiable';
}

function acquireRecoveryClaim(path) {
  const processStart = processStartIdentity(process.pid);
  if (!processStart || processStart === 'absent') return null;
  const owner = { version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
  if (!flockPath()) return publishEmergencyFileExclusive(path, JSON.stringify(owner)) ? owner : null;
  return guardedRecoveryClaim(path, 'acquire', owner) === 'claimed' ? owner : null;
}

function readRecoveryClaim(path) {
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    return owner.version === 1 && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.processStart === 'string' && typeof owner.createdAt === 'string' && typeof owner.nonce === 'string' ? owner : null;
  } catch { return null; }
}

function sameRecoveryClaim(left, right) {
  return left.pid === right.pid && left.processStart === right.processStart && left.nonce === right.nonce;
}

function releaseRecoveryClaim(path, owner) {
  if (!flockPath()) {
    try {
      const current = readRecoveryClaim(path);
      if (current && sameRecoveryClaim(current, owner)) unlinkSync(path);
    } catch { /* best-effort exact-owner release */ }
    return;
  }
  guardedRecoveryClaim(path, 'release', owner);
}

function readEmergencyJournal(path) {
  try {
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    if (journal.version !== 1 || typeof journal.transactionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(journal.transactionId) ||
      !journal.owner || !Number.isInteger(journal.owner.pid) || journal.owner.pid <= 0 || typeof journal.owner.processStart !== 'string' ||
      typeof journal.owner.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(journal.owner.nonce) ||
      (journal.originalDigest !== undefined && (typeof journal.originalDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(journal.originalDigest))) ||
      (journal.intendedDigest !== undefined && (typeof journal.intendedDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(journal.intendedDigest))) ||
      (journal.intent !== undefined && journal.intent !== 'clear' && journal.intent !== 'publish') ||
      typeof journal.quarantinePath !== 'string' ||
      (journal.phase !== 'preparing' && journal.phase !== 'prepared' && journal.phase !== 'quarantined' && journal.phase !== 'published')) return null;
    const complete = typeof journal.originalDigest === 'string' && (journal.intent === 'clear' || (journal.intent === 'publish' && typeof journal.intendedDigest === 'string'));
    return journal.phase === 'preparing' || complete ? journal : null;
  } catch { return null; }
}

function fileIdentity(path) {
  try {
    const stat = statSync(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch { return null; }
}

function sameFile(path, expected) {
  const actual = fileIdentity(path);
  return actual !== null && actual.dev === expected.dev && actual.ino === expected.ino;
}

function reconcileEmergencyPublicationTemps(filePath, authorizeState) {
  const directory = dirname(filePath);
  const base = filePath.slice(directory.length + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${base}\\.emergency-(journal\\.json|recovery\\.claim|quarantine\\.[0-9a-f-]{36}\\.payload)\\.(\\d+)\\.(\\d+)\\.([0-9a-f-]{36})\\.tmp$`, 'i');
  let names;
  try { names = readdirSync(directory); } catch (error) { return error?.code === 'ENOENT'; }
  for (const name of names) {
    const match = pattern.exec(name);
    if (!match) continue;
    const path = join(directory, name);
    const currentStart = processStartIdentity(Number(match[2]));
    if (currentStart === null || currentStart === match[3]) return false;
    const generation = fileIdentity(path);
    try {
      if (!generation) return false;
      const raw = readFileSync(path, 'utf8');
      if (authorizeState) {
        if (match[1] === 'journal.json') {
          const journal = readEmergencyJournal(path);
          if (!journal || !recoveryGenerationsAuthorized(filePath, journal, authorizeState)) return false;
        } else if (match[1].startsWith('quarantine.')) {
          const state = JSON.parse(raw);
          if (!state || typeof state !== 'object' || Array.isArray(state) || !authorizeState(state)) return false;
        } else {
          const claim = readRecoveryClaim(path);
          if (!claim || claim.pid !== Number(match[2]) || claim.processStart !== match[3] || claim.nonce !== match[4]) return false;
        }
      }
      if (!sameFile(path, generation) || stateDigest(readFileSync(path, 'utf8')) !== stateDigest(raw)) return false;
      unlinkSync(path);
    } catch { return false; }
  }
  return true;
}

function recoveryGenerationsAuthorized(filePath, journal, authorizeState) {
  if (!authorizeState) return true;
  const paths = [filePath, ...(journal ? [journal.quarantinePath, `${journal.quarantinePath}.payload`] : [])];
  let authenticatedJournalGeneration = journal === null;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let raw;
    let state;
    try {
      raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      state = parsed;
    } catch { return false; }
    if (!authorizeState(state)) return false;
    if (journal && (stateDigest(raw) === journal.originalDigest || (journal.intent === 'publish' && stateDigest(raw) === journal.intendedDigest))) authenticatedJournalGeneration = true;
  }
  return authenticatedJournalGeneration;
}

/** Shared-home recovery claims contain no project identity, so pre-existing
 * claim publications are never attributable to the caller and must survive. */
function hasUnattributableRecoveryClaimArtifact(filePath, recoveryClaim) {
  const directory = dirname(filePath);
  const base = filePath.slice(directory.length + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tempPattern = new RegExp(`^${base}\\.emergency-recovery\\.claim\\.\\d+\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`, 'i');
  try {
    if (readdirSync(directory).some((name) => tempPattern.test(name))) return true;
    const claimPath = `${filePath}.emergency-recovery.claim`;
    if (!existsSync(claimPath)) return recoveryClaim !== undefined;
    if (!recoveryClaim) return true;
    const current = readRecoveryClaim(claimPath);
    return !current || !sameRecoveryClaim(current, recoveryClaim);
  } catch {
    return true;
  }
}

function sharedRecoveryArtifactsAuthorized(filePath, authorizeState, recoveryClaim) {
  if (!authorizeState) return true;
  if (hasUnattributableRecoveryClaimArtifact(filePath, recoveryClaim)) return false;
  const journalPath = emergencyJournalPath(filePath);
  if (!existsSync(journalPath)) {
    if (!existsSync(filePath)) return true;
    try {
      const state = JSON.parse(readFileSync(filePath, 'utf8'));
      return state !== null && typeof state === 'object' && !Array.isArray(state) && authorizeState(state);
    } catch { return false; }
  }
  const journal = readEmergencyJournal(journalPath);
  return journal !== null && recoveryGenerationsAuthorized(filePath, journal, authorizeState);
}

function replacePrimaryDuringRecoveryForTest(filePath) {
  if (process.env.NODE_ENV !== 'test' || process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_PATH !== filePath || !process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_BASE64) return;
  try {
    atomicWriteFileSync(filePath, Buffer.from(process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_BASE64, 'base64').toString('utf8'));
  } finally {
    delete process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_PATH;
    delete process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_BASE64;
  }
}

/** Captures only the authenticated source generation and never unlinks a replacement. */
function captureAndUnlinkPrimary(filePath, quarantinePath, expectedDigest) {
  try {
    linkSync(filePath, quarantinePath);
    const captured = fileIdentity(quarantinePath);
    if (!captured || stateDigest(readFileSync(quarantinePath, 'utf8')) !== expectedDigest || !sameFile(filePath, captured)) return false;
    replacePrimaryDuringRecoveryForTest(filePath);
    if (!sameFile(filePath, captured) || stateDigest(readFileSync(filePath, 'utf8')) !== expectedDigest) return false;
    unlinkSync(filePath);
    return true;
  } catch { return false; }
}

function removeOwnedEmergencyArtifacts(journalPath, journal, removeQuarantine) {
  try {
    if (!journalIsOwned(journalPath, journal.transactionId, journal.owner)) return false;
    if (removeQuarantine) try { unlinkSync(journal.quarantinePath); } catch { /* absent */ }
    try { unlinkSync(`${journal.quarantinePath}.payload`); } catch { /* absent */ }
    if (!journalIsOwned(journalPath, journal.transactionId, journal.owner)) return false;
    unlinkSync(journalPath);
    return true;
  } catch { return false; }
}

/** A dead transaction is recovered under a state-scoped, generation-verified exclusive claim. */
export function recoverEmergencyStateFile(filePath, options) {
  const authorizeState = options?.authorizeState;
  const journalPath = emergencyJournalPath(filePath);
  // Prefilter before taking a claim so stale shared-home artifacts cannot be
  // reclaimed solely because their process owner is dead. Revalidate while
  // holding our own claim below.
  if (!sharedRecoveryArtifactsAuthorized(filePath, authorizeState)) return false;
  if (!existsSync(journalPath)) {
    if (!authorizeState) return reconcileEmergencyPublicationTemps(filePath);
    const claimPath = `${filePath}.emergency-recovery.claim`;
    const claim = acquireRecoveryClaim(claimPath);
    if (!claim) return false;
    try {
      if (existsSync(journalPath) || !sharedRecoveryArtifactsAuthorized(filePath, authorizeState, claim)) return false;
      return reconcileEmergencyPublicationTemps(filePath, authorizeState);
    } finally { releaseRecoveryClaim(claimPath, claim); }
  }
  const journal = readEmergencyJournal(journalPath);
  if (!journal) {
    if (authorizeState) return false;
    const claimPath = `${filePath}.emergency-recovery.claim`;
    const claim = acquireRecoveryClaim(claimPath);
    if (!claim) return false;
    try {
      const generation = fileIdentity(journalPath);
      if (!reconcileEmergencyPublicationTemps(filePath)) return false;
      if (!generation || readEmergencyJournal(journalPath) !== null || !existsSync(filePath) || !sameFile(journalPath, generation)) return false;
      unlinkSync(journalPath);
      return true;
    } catch { return false; } finally { releaseRecoveryClaim(claimPath, claim); }
  }
  const claimPath = `${filePath}.emergency-recovery.claim`;
  const claim = acquireRecoveryClaim(claimPath);
  if (!claim) return false;
  try {
    if (!sharedRecoveryArtifactsAuthorized(filePath, authorizeState, claim)) return false;
    const current = readEmergencyJournal(journalPath);
    if (!recoveryGenerationsAuthorized(filePath, current, authorizeState)) return true;
    if (!reconcileEmergencyPublicationTemps(filePath, authorizeState)) return false;
    if (!current || current.quarantinePath !== `${filePath}.emergency-quarantine.${current.transactionId}` || isEmergencyOwnerLive(current.owner)) return false;
    return recoverDeadEmergencyStateFile(filePath, authorizeState);
  } finally { releaseRecoveryClaim(claimPath, claim); }
}

/** Recover a previously interrupted emergency mutation while holding the recovery claim. */
function recoverDeadEmergencyStateFile(filePath, authorizeState) {
  const journalPath = emergencyJournalPath(filePath);
  if (!existsSync(journalPath)) return true;
  const journal = readEmergencyJournal(journalPath);
  if (!journal || journal.quarantinePath !== `${filePath}.emergency-quarantine.${journal.transactionId}` || isEmergencyOwnerLive(journal.owner)) return false;
  if (!recoveryGenerationsAuthorized(filePath, journal, authorizeState)) return true;
  const owned = () => journalIsOwned(journalPath, journal.transactionId, journal.owner);
  if (!owned()) return false;
  const payloadPath = `${journal.quarantinePath}.payload`;
  const digest = (path) => { try { return stateDigest(readFileSync(path, 'utf8')); } catch { return null; } };
  if (journal.phase === 'preparing') {
    const complete = typeof journal.originalDigest === 'string' && (journal.intent === 'clear' || (journal.intent === 'publish' && typeof journal.intendedDigest === 'string'));
    if (!complete) {
      if (existsSync(journal.quarantinePath) || existsSync(payloadPath)) return false;
      return removeOwnedEmergencyArtifacts(journalPath, journal, false);
    }
    const originalStillPrimary = !existsSync(journal.quarantinePath) && digest(filePath) === journal.originalDigest;
    if (journal.intent === 'publish' && digest(payloadPath) !== journal.intendedDigest) return originalStillPrimary && removeOwnedEmergencyArtifacts(journalPath, journal, false);
    if (journal.intent === 'clear' && existsSync(payloadPath)) return originalStillPrimary && removeOwnedEmergencyArtifacts(journalPath, journal, false);
    journal.phase = 'prepared';
    return writeEmergencyJournal(journalPath, journal) && recoverDeadEmergencyStateFile(filePath, authorizeState);
  }
  const originalDigest = journal.originalDigest;
  const intent = journal.intent;
  const intendedDigest = journal.intendedDigest;
  const hasPrimary = existsSync(filePath);
  const hasQuarantine = existsSync(journal.quarantinePath);
  const finalize = () => removeOwnedEmergencyArtifacts(journalPath, journal, hasQuarantine);
  if (hasPrimary && hasQuarantine) {
    if (intent === 'publish' && digest(filePath) === intendedDigest && digest(journal.quarantinePath) === originalDigest) return finalize();
    return removeOwnedEmergencyArtifacts(journalPath, journal, true);
  }
  if (hasPrimary) {
    if (!hasQuarantine && journal.phase === 'prepared' && digest(filePath) === originalDigest) {
      if (intent === 'publish' && digest(payloadPath) !== intendedDigest) return false;
      if (!owned()) return false;
      if (!captureAndUnlinkPrimary(filePath, journal.quarantinePath, originalDigest)) {
        if (owned() && existsSync(filePath) && existsSync(journal.quarantinePath) && digest(filePath) !== originalDigest) removeOwnedEmergencyArtifacts(journalPath, journal, true);
        return false;
      }
      journal.phase = 'quarantined';
      return writeEmergencyJournal(journalPath, journal) && recoverDeadEmergencyStateFile(filePath, authorizeState);
    }
    return false;
  }
  if (!hasQuarantine) return intent === 'clear' && journal.phase === 'published' && removeOwnedEmergencyArtifacts(journalPath, journal, false);
  if (digest(journal.quarantinePath) !== originalDigest || !owned()) return false;
  try {
    if (intent === 'clear') return removeOwnedEmergencyArtifacts(journalPath, journal, true);
    const payload = readFileSync(payloadPath, 'utf8');
    if (stateDigest(payload) !== intendedDigest || !owned()) return false;
    linkSync(payloadPath, filePath);
    journal.phase = 'published';
    if (!writeEmergencyJournal(journalPath, journal)) return false;
    return removeOwnedEmergencyArtifacts(journalPath, journal, true);
  } catch { return false; }
}
