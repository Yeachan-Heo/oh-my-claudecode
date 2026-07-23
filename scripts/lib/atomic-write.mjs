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

const LOCK_SCHEMA_VERSION = 2;
const LOCK_OLD_SCHEMA_VERSION = 1;
/** Pre-upgrade (v1) liveness-schema key set: has `processStart`, no `expires_at`. */
const LOCK_OLD_OWNER_KEYS = ['createdAt', 'nonce', 'pid', 'processStart', 'version'];
/**
 * Lease duration (ms) for a mutation lock. Generous enough that a single
 * acquire->mutate->release cycle (graph mutation or autopilot state write)
 * almost always completes within the lease. As a SAFETY NET against a holder
 * whose critical section overruns the lease (B11: the lease would otherwise
 * expire mid-mutation and admit a second writer), the holder re-validates its
 * OWN lease immediately before publishing (see assertMutationLockHeld) and
 * aborts with `lease_expired_during_mutation` if it has expired. Long-held
 * locks (e.g. a slow graph mutation) SHOULD additionally call renewMutationLock
 * periodically to extend `expires_at` while still working, so the lease does
 * not expire under them. If the holder crashes or fails to release, a later
 * acquirer reclaims once `now >= expires_at`.
 */
const LOCK_LEASE_MS = 300000; // 5 minutes

/**
 * Returns the current wall-clock ms. Centralised so tests can mock time by
 * planting `expires_at` values; production reads `Date.now()`.
 */
function leaseNow() {
  return Date.now();
}

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
// Lease-based mutation lock reclaim script (runs under an exclusive `flock` guard
// on `${lockPath}.reclaim.guard` so the reclaim read+unlink is atomic w.r.t.
// other reclaimers). The script reads the on-disk owner and decides:
//   exit 0 -> lock was reclaimable (expired lease OR corrupt) and has been
//             unlinked; the caller should retry linkSync to acquire.
//   exit 2 -> lock has a VALID, UNEXPIRED v2 lease (live owner); do NOT reclaim.
//   exit 3 -> the lock could not be read with a non-ENOENT I/O error
//             (EACCES/EMFILE/EIO/ENOMEM): the owner MAY be alive and we just
//             cannot read its lease. FAIL CLOSED (no steal). Operator attention.
//   exit 4 -> owner replaced between read and unlink (TOCTOU); caller retries.
//   exit 5 -> the on-disk owner is a v1 (old-liveness contract) record
//             (has processStart, no expires_at). The old owner MAY be alive; we
//             do NOT reclaim it and do NOT unlink. FAIL CLOSED (B12). The caller
//             fails closed (wait / return null). Operator attention.
// For `release` the script unlinks only if the on-disk owner exactly matches the
// expected owner (pid + nonce + createdAt); a mismatched owner (or a v1 owner,
// or a corrupt owner) is left in place.
const LOCK_REMOVAL_SCRIPT = String.raw`
const fs = require('fs');
const [operation, lockPath, expectedRaw] = process.argv.slice(1);
const leaseKeys = ['createdAt', 'expires_at', 'nonce', 'pid', 'version'];
const oldKeys = ['createdAt', 'nonce', 'pid', 'processStart', 'version'];
function readOwner() {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return 'absent';
    return 'io_error';
  }
  try {
    const value = JSON.parse(raw);
    const actual = Object.keys(value).sort();
    // v2 lease schema (the current contract): version 2, expires_at, no processStart.
    if (actual.length === leaseKeys.length && actual.every((key, index) => key === leaseKeys[index]) && value.version === 2 && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) && typeof value.expires_at === 'string' && Number.isFinite(Date.parse(value.expires_at)) && typeof value.nonce === 'string' && /^[0-9a-f-]{36}$/i.test(value.nonce)) return value;
    // v1 old-liveness schema (pre-upgrade contract): version 1, processStart, no
    // expires_at. NOT corrupt - it is a live lock held under the old contract. The
    // old owner may be alive; FAIL CLOSED (B12): never unlink, never reclaim.
    if (actual.length === oldKeys.length && actual.every((key, index) => key === oldKeys[index]) && value.version === 1 && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) && typeof value.processStart === 'string' && /^\d+$/.test(value.processStart) && typeof value.nonce === 'string' && /^[0-9a-f-]{36}$/i.test(value.nonce)) return 'old_version';
    return 'corrupt';
  } catch (error) { return 'corrupt'; }
}
if (operation === 'release') {
  let expected;
  try { expected = JSON.parse(expectedRaw); } catch { process.exit(3); }
  const current = readOwner();
  if (current === 'absent') process.exit(0);
  if (current === 'io_error') process.exit(3);
  if (current === 'old_version') process.exit(5); // not ours; leave the old-contract lock in place
  if (current === 'corrupt') process.exit(3);
  if (current.pid !== expected.pid || current.nonce !== expected.nonce || current.createdAt !== expected.createdAt) process.exit(4);
  try { fs.unlinkSync(lockPath); process.exit(0); } catch (error) { if (error && error.code === 'ENOENT') process.exit(0); process.exit(4); }
}
const current = readOwner();
if (current === 'absent') process.exit(0);
if (current === 'io_error') process.exit(3);
if (current === 'old_version') process.exit(5); // old-contract owner may be live; FAIL CLOSED (B12)
if (current === 'corrupt') { try { fs.unlinkSync(lockPath); process.exit(0); } catch (error) { if (error && error.code === 'ENOENT') process.exit(0); process.exit(4); } }
if (Date.now() >= Date.parse(current.expires_at)) { try { fs.unlinkSync(lockPath); process.exit(0); } catch (error) { if (error && error.code === 'ENOENT') process.exit(0); process.exit(4); } }
process.exit(2);
`;

// ---------------------------------------------------------------------------
// Emergency-journal process identity (NOT used by the mutation lock).
//
// The mutation lock is LEASE-based (see freshLockOwner/readLockOwner above) and
// does NOT probe process liveness. This processStartIdentity helper is retained
// exclusively for the EMERGENCY JOURNAL subsystem (recoverEmergencyStateFile /
// emergencyMutateStateFileIf and their recovery-claim script), which still
// authenticates a crashed transaction's owner by process-start identity. It is
// intentionally kept separate from the lease lock so the mutation-lock blockers
// (B5/B6/B7/B8/B9/B10) cannot recur via the emergency path's liveness probe.
// ---------------------------------------------------------------------------
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
 * Computes the owner record written to a freshly acquired lock file. The lease
 * expires_at = now + LOCK_LEASE_MS; it is the ONLY reclaim key (no process
 * liveness is probed). pid + nonce + createdAt stay for debug/ownership identity
 * (release verifies them to avoid unlinking a lock a live owner lawfully
 * reclaimed and re-acquired).
 */
function freshLockOwner() {
  const now = leaseNow();
  return {
    version: LOCK_SCHEMA_VERSION,
    pid: process.pid,
    createdAt: new Date(now).toISOString(),
    expires_at: new Date(now + LOCK_LEASE_MS).toISOString(),
    nonce: randomUUID(),
  };
}

function guardedLockRemoval(lockPath, operation, owner) {
  const flock = flockPath();
  if (!flock) return 'unverifiable';
  const result = spawnSync(flock, ['-x', `${lockPath}.reclaim.guard`, process.execPath, '-e', LOCK_REMOVAL_SCRIPT, operation, lockPath, owner ? JSON.stringify(owner) : ''], { stdio: 'ignore', timeout: 2000 });
  if (result.status === 0) return 'retry';
  if (result.status === 2) return 'live';
  if (result.status === 4) return 'replaced';
  if (result.status === 5) return 'old_version';
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
  // No process-liveness probe: the lease (expires_at) is the sole reclaim key.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const owner = freshLockOwner();
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
      // A lock already exists. Decide reclaim by LEASE, not process liveness.
      // Both the flock and flock-less paths use the SAME policy (B7/B10
      // convergence): reclaim only when the lease is expired or the owner JSON
      // is corrupt; a valid unexpired lease blocks (fail closed); an I/O-
      // unreadable lock fails closed forever (B9: the owner MAY be alive).
      if (hasFlock) {
        const disposition = guardedLockRemoval(lockPath, 'reclaim');
        if (disposition === 'unverifiable') {
          console.error(`[omc-lock] state_mutation_lock_unverifiable: ${lockPath}`);
          return null;
        }
        if (disposition === 'old_version') {
          // v1 old-liveness contract owner on disk: the pre-upgrade owner MAY be
          // alive. FAIL CLOSED (B12): never reclaim, never steal. Surface it so an
          // operator can intervene; bail rather than spin forever.
          console.error(`[omc-lock] state_mutation_lock_old_version: ${lockPath}`);
          return null;
        }
        if (disposition === 'live') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        // 'retry' (reclaimed) or 'replaced' (TOCTOU): loop and re-attempt linkSync.
      } else {
        const current = readLockOwner(lockPath);
        if (current === 'absent') {
          // Lock vanished between EEXIST and read (race): retry linkSync.
        } else if (current === null) {
          // I/O read failure (EACCES/EMFILE/EIO/ENOMEM) on a possibly-live
          // lock. The owner MAY be alive; we just cannot read its lease. FAIL
          // CLOSED (B9): no steal, no bounded reclaim, no wedge-escape. Log so
          // the event is observable for operator attention.
          console.error(`[omc-lock] state_mutation_lock_unverifiable: ${lockPath}`);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        } else if (current === 'old_version') {
          // v1 old-liveness contract owner (processStart, no expires_at): the
          // pre-upgrade owner MAY be alive. FAIL CLOSED (B12): do NOT unlink, do
          // NOT steal. Surface it; bail rather than spin forever.
          console.error(`[omc-lock] state_mutation_lock_old_version: ${lockPath}`);
          return null;
        } else if (current === 'corrupt') {
          // Readable but unparseable/invalid owner JSON: no valid lease is on
          // record, so the owner cannot be live. RECLAIM (unlink) and retry.
          try { unlinkSync(lockPath); } catch { /* race; retry linkSync */ }
        } else if (leaseNow() >= Date.parse(current.expires_at)) {
          // Valid owner whose lease has EXPIRED: the holder crashed or failed
          // to release. RECLAIM (unlink) and retry.
          try { unlinkSync(lockPath); } catch { /* race; retry linkSync */ }
        } else {
          // Valid owner with an unexpired lease: LIVE. Do NOT steal; wait.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
    }
  }
  return null;
}

export function acquireStateFileLockSync(filePath, attempts = 50, requireExclusive = false) {
  return acquireLockAt(`${filePath}.mutation.lock`, attempts, requireExclusive);
}

function sameLockOwner(left, right) {
  return left.pid === right.pid && left.nonce === right.nonce && left.createdAt === right.createdAt;
}

const LOCK_OWNER_KEYS = ['createdAt', 'expires_at', 'nonce', 'pid', 'version'];

/**
 * True when `value` matches the pre-upgrade v1 LIVENESS-schema owner shape
 * (`processStart` present, no `expires_at`, version 1). Such a record is a lock
 * held under the OLD contract; the owner may still be alive. It is NOT corrupt
 * and must NEVER be reclaimed (B12). Distinct from a corrupt/malformed record.
 */
function isOldLivenessOwner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  if (actual.length !== LOCK_OLD_OWNER_KEYS.length || !actual.every((key, index) => key === LOCK_OLD_OWNER_KEYS[index])) return false;
  if (value.version !== LOCK_OLD_SCHEMA_VERSION) return false;
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return false;
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return false;
  if (typeof value.processStart !== 'string' || !/^\d+$/.test(value.processStart)) return false;
  if (typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.nonce)) return false;
  return true;
}

/**
 * Validates a parsed object as a lease-based (v2) lock owner using the SAME checks
 * the flock path's LOCK_REMOVAL_SCRIPT enforces: exact key set, version===2,
 * positive integer pid, parseable createdAt, parseable expires_at (the lease
 * reclaim key), and a 36-char UUID nonce. pid is kept for debug/ownership
 * identity and is NOT probed for liveness. Returns the owner or null. A v1
 * old-liveness record is NOT null here; use isOldLivenessOwner to detect it.
 * Single owner validator (B4: folded the two divergent validators into one).
 */
function validateLockOwner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const actual = Object.keys(value).sort();
  if (actual.length !== LOCK_OWNER_KEYS.length || !actual.every((key, index) => key === LOCK_OWNER_KEYS[index])) return null;
  if (value.version !== LOCK_SCHEMA_VERSION) return null;
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return null;
  if (typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))) return null;
  if (typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.nonce)) return null;
  return value;
}

/**
 * Reads and validates the on-disk lease owner. Returns:
 *  - the validated v2 owner on success,
 *  - 'absent' when the lock file does not exist (ENOENT),
 *  - 'corrupt' when the file is readable but unparseable/invalid (no valid lease),
 *  - 'old_version' when the file is a readable v1 old-liveness-schema record
 *    (processStart, no expires_at): a lock held under the OLD contract whose
 *    owner may be alive. Callers FAIL CLOSED on it (B12): never reclaim.
 *  - null when the read itself failed with a non-ENOENT I/O error
 *    (EACCES/EMFILE/EIO/ENOMEM) - the owner MAY be alive; callers fail closed.
 * The 5-way result lets the caller fail closed on an unreadable lock (B9) or an
 * old-contract lock (B12), reclaim a corrupt lock, and block on a valid
 * unexpired lease.
 */
function readLockOwner(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent';
    return null; // I/O failure - may be a live lock we cannot read
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'corrupt'; // readable but unparseable JSON - no valid lease
  }
  if (isOldLivenessOwner(parsed)) return 'old_version';
  const owner = validateLockOwner(parsed);
  return owner === null ? 'corrupt' : owner;
}

export function releaseStateFileLockSync(lock) {
  if (!lock || lock.unlocked) return;
  try { closeSync(lock.fd); } catch {}
  if (flockPath()) {
    // Flock path: the guarded removal script unlinks only if the on-disk owner
    // exactly matches ours (pid + nonce + createdAt); a mismatched owner is a
    // live owner that lawfully reclaimed after our lease expired, so we leave
    // it in place (the script exits 4 and we log).
    const disposition = guardedLockRemoval(lock.lockPath, 'release', lock.owner);
    if (disposition === 'replaced' || disposition === 'old_version') {
      console.error(`[omc-lock] state_mutation_lock_release_owner_mismatch: ${lock.lockPath}`);
    }
    return;
  }
  // flock-less runtime (macOS/Windows) or the explicit test simulation: the
  // holder releases its OWN lock. Re-validate immediately before unlink to close
  // the TOCTOU window between readLockOwner and unlinkSync: if the on-disk owner
  // no longer matches (our lease expired and a later acquirer reclaimed it, or a
  // concurrent release raced), leave the live owner's lock in place and log.
  const current = readLockOwner(lock.lockPath);
  if (current === 'absent') return; // already released
  if (current === null) return; // unreadable - do not unlink what we cannot verify
  if (current === 'old_version') {
    // The on-disk lock is now a v1 old-liveness record (e.g. a pre-upgrade owner
    // reclaimed after our lease expired). It is NOT ours; leave it in place (B12).
    console.error(`[omc-lock] state_mutation_lock_release_owner_mismatch: ${lock.lockPath}`);
    return;
  }
  if (current !== 'corrupt' && sameLockOwner(current, lock.owner)) {
    try { unlinkSync(lock.lockPath); } catch { /* race or already removed */ }
  } else {
    console.error(`[omc-lock] state_mutation_lock_release_owner_mismatch: ${lock.lockPath}`);
  }
}

/**
 * Re-validates that the holder's OWN lease is still live (B11). Re-reads the
 * on-disk owner at `lock.lockPath` and confirms (a) it is still our lock
 * (`sameLockOwner`: pid + nonce + createdAt) and (b) `now < expires_at`. If the
 * lease has expired while we were still in the critical section, a second writer
 * may already have reclaimed and re-acquired the lock; publishing now would
 * silently overwrite that writer's work. To make that violation DETECTABLE
 * rather than silent, this throws `lease_expired_during_mutation` and logs the
 * two-writer overlap. Call this immediately BEFORE publishing under a lock whose
 * critical section may approach LEASE_MS; withStateFileLockSync does so
 * automatically before invoking the callback.
 *
 * Note: this is the holder checking ITS OWN lease, not someone else's. A holder
 * that overruns its lease is the bug; this is the safety net that catches it.
 */
export function assertMutationLockHeld(lock) {
  if (!lock || lock.unlocked) return;
  const current = readLockOwner(lock.lockPath);
  if (current === 'absent' || current === 'old_version' || current === 'corrupt' || current === null) {
    console.error(`[omc-lock] state_mutation_lock_lease_expired_during_mutation: ${lock.lockPath}`);
    throw new Error(`lease_expired_during_mutation: holder's lock is no longer live at ${lock.lockPath}`);
  }
  if (!sameLockOwner(current, lock.owner)) {
    console.error(`[omc-lock] state_mutation_lock_lease_expired_during_mutation: ${lock.lockPath}`);
    throw new Error(`lease_expired_during_mutation: on-disk owner replaced at ${lock.lockPath}`);
  }
  if (leaseNow() >= Date.parse(current.expires_at)) {
    console.error(`[omc-lock] state_mutation_lock_lease_expired_during_mutation: ${lock.lockPath}`);
    throw new Error(`lease_expired_during_mutation: holder's lease expired before publish at ${lock.lockPath}`);
  }
}

/**
 * Extends the holder's lease by re-writing `expires_at = now + LEASE_MS` while
 * still holding the lock (B11). For long critical sections (e.g. a slow graph
 * mutation that may approach or exceed LEASE_MS), callers should renew
 * periodically so the lease does not expire under them and admit a second
 * writer. Renewal re-validates that the on-disk owner is still ours (otherwise a
 * later writer has already reclaimed our expired lease and we must NOT publish);
 * on owner mismatch or I/O failure it returns false and the caller should abort.
 * Returns true on a successful renewal. No-op (returns true) for unlocked locks.
 */
export function renewMutationLock(lock) {
  if (!lock || lock.unlocked) return true;
  const current = readLockOwner(lock.lockPath);
  if (current === 'absent' || current === 'old_version' || current === 'corrupt' || current === null) return false;
  if (!sameLockOwner(current, lock.owner)) return false; // someone else owns it now
  const renewedExpiresAt = new Date(leaseNow() + LOCK_LEASE_MS).toISOString();
  const tempPath = `${lock.lockPath}.${process.pid}.${lock.owner.nonce}.renew.tmp`;
  let fd;
  try {
    const renewed = { ...lock.owner, expires_at: renewedExpiresAt };
    fd = openSync(tempPath, 'wx', 0o600);
    writeAllSync(fd, JSON.stringify(renewed), 'lock renewal publication');
    fsyncSync(fd);
    try { unlinkSync(lock.lockPath); } catch { /* a reclaimer may have unlinked it */ }
    linkSync(tempPath, lock.lockPath);
    unlinkSync(tempPath);
    lock.owner = renewed;
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    try { unlinkSync(tempPath); } catch {}
  }
}

export function withStateFileLockSync(filePath, callback, requireExclusive = false) {
  const lock = acquireStateFileLockSync(filePath, 50, requireExclusive);
  if (!lock) return { acquired: false, value: undefined };
  try {
    // B11: re-validate the holder's OWN lease is still live immediately before
    // the callback publishes. If the lease expired while we waited/worked, a
    // second writer may already hold the lock; abort (throw) rather than publish
    // over it silently. Unlocked locks (flock-less, non-exclusive) skip this.
    assertMutationLockHeld(lock);
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
