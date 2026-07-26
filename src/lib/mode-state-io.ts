/**
 * Mode State I/O Layer
 *
 * Canonical read/write/clear operations for mode state files.
 * Centralises path resolution, ghost-legacy cleanup, directory creation,
 * and file permissions so that individual mode modules don't duplicate this logic.
 */

import { closeSync, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { basename, dirname, join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import {
  getGitTopLevel,
  getOmcRoot,
  resolveStatePath,
  resolveSessionStatePath,
  ensureSessionStateDir,
  ensureOmcDir,
  listSessionIds,
} from './worktree-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

/**
 * On-disk lock schema version.
 *
 * - v1 lease = the deployed lease contract: `{ version: 1, pid, createdAt,
 *   expires_at, nonce }`. Keep emitting this version so older deployed readers
 *   do not classify a current lock as corrupt and reclaim it.
 * - v1 liveness = the older, distinct shape `{ version: 1, pid, processStart,
 *   createdAt, nonce }` (no `expires_at`). Its owner may still be alive, so we
 *   NEVER reclaim it and fail closed. See B12.
 * - Unknown lease versions are structurally valid records under an unsupported
 *   contract and likewise fail closed rather than being treated as corrupt.
 *
 * The lease's `expires_at` is the sole reclaim key for the v1 lease shape.
 *   `expires_at` is the sole reclaim key (no liveness probe). Reclaimed only when
 *   `now >= expires_at` or the JSON is corrupt. See B11/B12.
 */
const LOCK_SCHEMA_VERSION = 1;
const LOCK_OLD_SCHEMA_VERSION = 1;
/** Pre-upgrade (v1) liveness-schema key set: has `processStart`, no `expires_at`. */
const LOCK_OLD_OWNER_KEYS = ['createdAt', 'nonce', 'pid', 'processStart', 'version'] as const;
export type MutationLockOwner = { version: 1; pid: number; createdAt: string; expires_at: string; nonce: string };
export type MutationLock = { fd: number; path: string; owner: MutationLockOwner } | { unlocked: true };
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

/** Returns the current wall-clock ms; `expires_at` is compared against this. */
function leaseNow(): number {
  return Date.now();
}

function flockPath(): string | null {
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
 * fail closed - the same contract the dev branch established.
 */
function lockingDisabledForTest(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.OMC_TEST_FLOCK_AVAILABLE === '0';
}
// Lease-based mutation lock reclaim script (runs under an exclusive `flock` guard
// on `${path}.reclaim.guard` so the reclaim read+unlink is atomic w.r.t. other
// reclaimers). The script reads the on-disk owner and decides:
//   exit 0 -> lock was reclaimable (expired lease OR corrupt) and has been
//             unlinked; the caller should retry linkSync to acquire.
//   exit 2 -> lock has a VALID, UNEXPIRED v1 lease (live owner); do NOT reclaim.
//   exit 3 -> the lock could not be read with a non-ENOENT I/O error
//             (EACCES/EMFILE/EIO/ENOMEM): the owner MAY be alive and we just
//             cannot read its lease. FAIL CLOSED (no steal). Operator attention.
//   exit 4 -> owner replaced between read and unlink (TOCTOU); caller retries.
//   exit 5 -> the on-disk owner is a v1 (old-liveness contract) record
//             (has processStart, no expires_at). The old owner MAY be alive; we
//             do NOT reclaim it and do NOT unlink. FAIL CLOSED (B12). The caller
//             fails closed (wait / return null). Operator attention.
//   exit 6 -> the on-disk owner is a structurally valid lease record under an
//             unsupported schema version. It MAY be held under a newer contract;
//             fail closed rather than reclaiming it.
// For `release` the script unlinks only if the on-disk owner exactly matches the
// expected owner (pid + nonce + createdAt); a mismatched owner (or a v1 owner,
// or a corrupt owner) is left in place.
const LOCK_REMOVAL_SCRIPT = String.raw`
const fs = require('fs');
const [operation, lockPath, expectedRaw, renewalPath] = process.argv.slice(1);
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
    // v1 lease schema (the deployed current contract): expires_at, no processStart.
    const leaseShaped = actual.length === leaseKeys.length && actual.every((key, index) => key === leaseKeys[index]) && Number.isSafeInteger(value.version) && value.version > 0 && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) && typeof value.expires_at === 'string' && Number.isFinite(Date.parse(value.expires_at)) && typeof value.nonce === 'string' && /^[0-9a-f-]{36}$/i.test(value.nonce);
    if (leaseShaped && value.version === 1) return value;
    // v1 old-liveness schema (pre-upgrade contract): version 1, processStart, no
    // expires_at. NOT corrupt - it is a live lock held under the old contract. The
    // old owner may be alive; FAIL CLOSED (B12): never unlink, never reclaim.
    if (actual.length === oldKeys.length && actual.every((key, index) => key === oldKeys[index]) && value.version === 1 && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) && typeof value.processStart === 'string' && /^\d+$/.test(value.processStart) && typeof value.nonce === 'string' && /^[0-9a-f-]{36}$/i.test(value.nonce)) return 'old_version';
    if (leaseShaped) return 'unknown_version';
    // B12: a structurally-valid versioned object under a shape we don't recognise
    // (e.g. a future lease with extra/renamed fields) MAY be a live owner. FAIL
    // CLOSED (unknown_version -> exit 6): never unlink, never reclaim. Reserve
    // 'corrupt' for genuinely unparseable / non-versioned garbage.
    if (value && typeof value === 'object' && !Array.isArray(value) && Number.isSafeInteger(value.version) && value.version > 0) return 'unknown_version';
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
  if (current === 'unknown_version') process.exit(6); // not ours; leave the unsupported-contract lock in place
  if (current === 'corrupt') process.exit(3);
  if (current.pid !== expected.pid || current.nonce !== expected.nonce || current.createdAt !== expected.createdAt) process.exit(4);
  try { fs.unlinkSync(lockPath); process.exit(0); } catch (error) { if (error && error.code === 'ENOENT') process.exit(0); process.exit(4); }
}
if (operation === 'renew') {
  let expected;
  try { expected = JSON.parse(expectedRaw); } catch { process.exit(3); }
  const current = readOwner();
  if (current === 'absent') process.exit(4);
  if (current === 'io_error') process.exit(3);
  if (current === 'old_version') process.exit(5);
  if (current === 'unknown_version') process.exit(6);
  if (current === 'corrupt') process.exit(4);
  if (current.pid !== expected.pid || current.nonce !== expected.nonce || current.createdAt !== expected.createdAt) process.exit(4);
  if (Date.now() >= Date.parse(current.expires_at)) process.exit(2);
  try { fs.renameSync(renewalPath, lockPath); process.exit(0); } catch { process.exit(3); }
}
const current = readOwner();
if (current === 'absent') process.exit(0);
if (current === 'io_error') process.exit(3);
if (current === 'old_version') process.exit(5); // old-contract owner may be live; FAIL CLOSED (B12)
if (current === 'unknown_version') process.exit(6); // unknown-contract owner may be live; FAIL CLOSED
if (current === 'corrupt') { try { fs.unlinkSync(lockPath); process.exit(0); } catch (error) { if (error && error.code === 'ENOENT') process.exit(0); process.exit(4); } }
if (Date.now() >= Date.parse(current.expires_at)) { try { fs.unlinkSync(lockPath); process.exit(0); } catch (error) { if (error && error.code === 'ENOENT') process.exit(0); process.exit(4); } }
process.exit(2);
`;

// ---------------------------------------------------------------------------
// Emergency-journal process identity (NOT used by the mutation lock).
//
// The mutation lock is LEASE-based (see freshLockOwner/readLockOwner below) and
// does NOT probe process liveness. This processStartIdentity helper is retained
// exclusively for the EMERGENCY JOURNAL subsystem (recoverEmergencyStateFile /
// emergencyMutateStateFileIf and their recovery-claim script), which still
// authenticates a crashed transaction's owner by process-start identity. It is
// intentionally kept separate from the lease lock so the mutation-lock blockers
// (B5/B6/B7/B8/B9/B10) cannot recur via the emergency path's liveness probe.
// ---------------------------------------------------------------------------
let cachedSelfProcessStart: string | undefined;

function selfProcessStart(): string {
  if (cachedSelfProcessStart === undefined) {
    cachedSelfProcessStart = String(Math.max(1, Math.floor(Date.now() - process.uptime() * 1000)));
  }
  return cachedSelfProcessStart;
}

function processStartIdentity(pid: number): string | 'absent' | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform !== 'linux') return pid === process.pid ? selfProcessStart() : null;
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_EMERGENCY_PROCESS_START_UNKNOWN_PID === String(pid)) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return null;
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    return fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : null;
  }
}

/**
 * Computes the owner record written to a freshly acquired lock file. The lease
 * expires_at = now + LOCK_LEASE_MS; it is the ONLY reclaim key (no process
 * liveness is probed). pid + nonce + createdAt stay for debug/ownership identity
 * (release verifies them to avoid unlinking a lock a live owner lawfully
 * reclaimed and re-acquired).
 */
function freshLockOwner(): MutationLockOwner {
  const now = leaseNow();
  return {
    version: LOCK_SCHEMA_VERSION,
    pid: process.pid,
    createdAt: new Date(now).toISOString(),
    expires_at: new Date(now + LOCK_LEASE_MS).toISOString(),
    nonce: randomUUID(),
  };
}

function writeAllSync(fd: number, content: string, label: string): void {
  const bytes = Buffer.from(content, 'utf-8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error(`${label} made no progress`);
    }
    offset += written;
  }
  if (fstatSync(fd).size !== bytes.length) {
    throw new Error(`${label} size verification failed`);
  }
}


function guardedLockRemoval(path: string, operation: 'reclaim' | 'release', owner?: MutationLockOwner): 'retry' | 'live' | 'replaced' | 'unverifiable' | 'old_version' | 'unknown_version' {
  const flock = flockPath();
  if (!flock) return 'unverifiable';
  const result = spawnSync(flock, ['-x', `${path}.reclaim.guard`, process.execPath, '-e', LOCK_REMOVAL_SCRIPT, operation, path, owner ? JSON.stringify(owner) : ''], { stdio: 'ignore', timeout: 2000 });
  if (result.status === 0) return 'retry';
  if (result.status === 2) return 'live';
  if (result.status === 4) return 'replaced';
  if (result.status === 5) return 'old_version';
  if (result.status === 6) return 'unknown_version';
  return 'unverifiable';
}

/** Compares and replaces a lease while holding the reclaimer's guard. */
function guardedLockRenewal(path: string, owner: MutationLockOwner, renewalPath: string): boolean {
  const flock = flockPath();
  if (!flock) return false;
  const result = spawnSync(flock, ['-x', `${path}.reclaim.guard`, process.execPath, '-e', LOCK_REMOVAL_SCRIPT, 'renew', path, JSON.stringify(owner), renewalPath], { stdio: 'ignore', timeout: 2000 });
  return result.status === 0;
}

function acquireLockAt(path: string, requireExclusive = false): MutationLock | null {
  mkdirSync(dirname(path), { recursive: true });
  const hasFlock = !!flockPath();
  // Under the explicit test no-locking simulation, exclusive locks are
  // unavailable (fail closed), matching the dev contract. On real flock-less
  // runtimes (Windows/macOS) we still fall through to linkSync-based locking.
  if (lockingDisabledForTest()) return requireExclusive ? null : { unlocked: true };
  if (!hasFlock && !requireExclusive) return { unlocked: true };
  // No process-liveness probe: the lease (expires_at) is the sole reclaim key.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const owner = freshLockOwner();
    const tempPath = `${path}.${process.pid}.${owner.nonce}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tempPath, 'wx', 0o600);
      writeAllSync(fd, JSON.stringify(owner), 'lock owner publication');
      fsyncSync(fd);
      linkSync(tempPath, path);
      unlinkSync(tempPath);
      return { fd, path, owner };
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort descriptor cleanup */ } }
      try { unlinkSync(tempPath); } catch { /* best-effort unpublished temp cleanup */ }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      // A lock already exists. Decide reclaim by LEASE, not process liveness.
      // Both the flock and flock-less paths use the SAME policy (B7/B10
      // convergence): reclaim only when the lease is expired or the owner JSON
      // is corrupt; a valid unexpired lease blocks (fail closed); an I/O-
      // unreadable lock fails closed forever (B9: the owner MAY be alive).
      if (hasFlock) {
        const disposition = guardedLockRemoval(path, 'reclaim');
        if (disposition === 'unverifiable') {
          console.error(`[omc-lock] state_mutation_lock_unverifiable: ${path}`);
          return null;
        }
        if (disposition === 'old_version' || disposition === 'unknown_version') {
          // v1 old-liveness contract owner on disk: the pre-upgrade owner MAY be
          // alive. FAIL CLOSED (B12): never reclaim, never steal. Surface it so an
          // operator can intervene; bail rather than spin forever.
          console.error(`[omc-lock] state_mutation_lock_${disposition}: ${path}`);
          return null;
        }
        if (disposition === 'live') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        // 'retry' (reclaimed) or 'replaced' (TOCTOU): loop and re-attempt linkSync.
      } else {
        const current = readLockOwner(path);
        if (current === 'absent') {
          // Lock vanished between EEXIST and read (race): retry linkSync.
        } else if (current === null) {
          // I/O read failure (EACCES/EMFILE/EIO/ENOMEM) on a possibly-live
          // lock. The owner MAY be alive; we just cannot read its lease. FAIL
          // CLOSED (B9): no steal, no bounded reclaim, no wedge-escape. Log so
          // the event is observable for operator attention.
          console.error(`[omc-lock] state_mutation_lock_unverifiable: ${path}`);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        } else if (current === 'old_version' || current === 'unknown_version' || current === 'unrecognised') {
          // v1 old-liveness contract owner (processStart, no expires_at), an
          // exact-lease-shape owner under an unsupported version, OR a
          // structurally-valid versioned owner under a shape we don't recognise:
          // the owner MAY be alive under a contract we don't know. FAIL CLOSED
          // (B12): do NOT unlink, do NOT steal. Surface it; bail rather than spin.
          console.error(`[omc-lock] state_mutation_lock_${current}: ${path}`);
          return null;
        } else if (current === 'corrupt') {
          // Readable but unparseable/invalid owner JSON: no valid lease is on
          // record, so the owner cannot be live. RECLAIM (unlink) and retry.
          try { unlinkSync(path); } catch { /* race; retry linkSync */ }
        } else if (leaseNow() >= Date.parse(current.expires_at)) {
          // Valid owner whose lease has EXPIRED: the holder crashed or failed
          // to release. RECLAIM (unlink) and retry.
          try { unlinkSync(path); } catch { /* race; retry linkSync */ }
        } else {
          // Valid owner with an unexpired lease: LIVE. Do NOT steal; wait.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
    }
  }
  return null;
}

function acquireMutationLock(filePath: string): MutationLock | null {
  // State mutation is never best-effort: public write/clear paths must honor
  // the same lock even on flock-less hosts. `unlocked` is only for legacy
  // observational callers that explicitly request non-exclusive access. The
  // explicit no-lock test seam preserves its historical unlocked simulation;
  // real macOS/Windows hosts take the linkSync O_EXCL branch below.
  return acquireLockAt(`${filePath}.mutation.lock`, !lockingDisabledForTest());
}

function sameLockOwner(left: MutationLockOwner, right: MutationLockOwner): boolean {
  return left.pid === right.pid && left.nonce === right.nonce && left.createdAt === right.createdAt;
}

const LOCK_OWNER_KEYS = ['createdAt', 'expires_at', 'nonce', 'pid', 'version'] as const;

/**
 * True when `value` matches the pre-upgrade v1 LIVENESS-schema owner shape
 * (`processStart` present, no `expires_at`, version 1). Such a record is a lock
 * held under the OLD contract; the owner may still be alive. It is NOT corrupt
 * and must NEVER be reclaimed (B12). Distinct from a corrupt/malformed record.
 */
function isOldLivenessOwner(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  if (actual.length !== LOCK_OLD_OWNER_KEYS.length || !actual.every((key, index) => key === LOCK_OLD_OWNER_KEYS[index])) return false;
  if (record.version !== LOCK_OLD_SCHEMA_VERSION) return false;
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return false;
  if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) return false;
  if (typeof record.processStart !== 'string' || !/^\d+$/.test(record.processStart)) return false;
  if (typeof record.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.nonce)) return false;
  return true;
}

/**
 * Validates a parsed object as a lease-based (v1) MutationLockOwner using the
 * SAME checks the flock path's LOCK_REMOVAL_SCRIPT enforces: exact key set,
 * version===1, positive integer pid, parseable createdAt, parseable
 * expires_at (the lease reclaim key), and a 36-char UUID nonce. pid is kept
 * for debug/ownership identity and is NOT probed for liveness. Returns the
 * owner or null. A v1 old-liveness record is NOT null here; use
 * isOldLivenessOwner to detect it. This is the single owner validator (B4).
 */
function validateLockOwner(value: unknown): MutationLockOwner | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  if (actual.length !== LOCK_OWNER_KEYS.length || !actual.every((key, index) => key === LOCK_OWNER_KEYS[index])) return null;
  if (record.version !== LOCK_SCHEMA_VERSION) return null;
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return null;
  if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) return null;
  if (typeof record.expires_at !== 'string' || !Number.isFinite(Date.parse(record.expires_at))) return null;
  if (typeof record.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.nonce)) return null;
  return record as unknown as MutationLockOwner;
}

function isUnknownLeaseOwner(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  if (actual.length !== LOCK_OWNER_KEYS.length || !actual.every((key, index) => key === LOCK_OWNER_KEYS[index])) return false;
  if (!Number.isSafeInteger(record.version) || (record.version as number) <= 0 || record.version === LOCK_SCHEMA_VERSION) return false;
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return false;
  if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) return false;
  if (typeof record.expires_at !== 'string' || !Number.isFinite(Date.parse(record.expires_at))) return false;
  return typeof record.nonce === 'string' && /^[0-9a-f-]{36}$/i.test(record.nonce);
}

/**
 * True when `value` is a structurally-valid-but-UNRECOGNISED versioned owner: a
 * JSON object that carries a positive-integer `version` field but does NOT
 * match any schema this build knows (v1 lease, v1 old-liveness, or the exact
 * 5-key unknown-lease shape handled by `isUnknownLeaseOwner`). Such a record
 * may be a live lock held under a future contract whose shape we don't
 * recognise (B12: e.g. a #3553-era or v2 lease with extra/renamed fields). It
 * is NOT corrupt (the bytes are valid) and must NEVER be reclaimed: reclaiming
 * it would destroy a live owner's lock. Callers FAIL CLOSED on it. Reserve
 * `'corrupt'` for genuinely unparseable bytes / non-versioned garbage.
 */
function isUnrecognisedVersionedOwner(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.version) || (record.version as number) <= 0) return false;
  // Anything versioned we didn't recognise above is an unknown contract. This
  // intentionally includes records with extra/missing fields relative to the
  // known key sets, so a future-schema live owner is never stolen as 'corrupt'.
  return true;
}

/**
 * Reads and validates the on-disk lease owner. Returns:
 *  - the validated v1 lease owner on success,
 *  - 'absent' when the lock file does not exist (ENOENT),
 *  - 'corrupt' when the file is readable but genuinely unparseable/invalid
 *    (broken JSON, non-object, or a non-versioned record with no `version`):
 *    no valid lease is on record and the owner cannot be live, so reclaim.
 *  - 'old_version' when the file is a readable v1 old-liveness-schema record
 *    (processStart, no expires_at): a lock held under the OLD contract whose
 *    owner may be alive. Callers FAIL CLOSED on it (B12): never reclaim.
 *  - 'unknown_version' when the file is the exact v1-lease key set under a
 *    different positive version (unsupported contract). FAIL CLOSED (B12).
 *  - 'unrecognised' when the file is a structurally-valid versioned JSON object
 *    under a shape this build does not recognise (e.g. a future lease with
 *    extra/renamed fields). The owner MAY be live; FAIL CLOSED (B12): never
 *    reclaim, never unlink. Distinct from 'corrupt' (genuinely bad bytes).
 *  - null when the read itself failed with a non-ENOENT I/O error
 *    (EACCES/EMFILE/EIO/ENOMEM) - the owner MAY be alive; callers fail closed.
 * The 6-way result lets the caller fail closed on an unreadable lock (B9), an
 * old-contract lock (B12), or an unrecognised-but-valid lock (B12); reclaim
 * only a genuinely corrupt lock; and block on a valid unexpired lease.
 */
function readLockOwner(path: string): MutationLockOwner | 'absent' | 'corrupt' | 'old_version' | 'unknown_version' | 'unrecognised' | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'absent';
    return null; // I/O failure (EACCES/EMFILE/EIO/...) - may be a live lock we cannot read
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'corrupt'; // readable but unparseable JSON - no valid lease
  }
  if (isOldLivenessOwner(parsed)) return 'old_version';
  if (isUnknownLeaseOwner(parsed)) return 'unknown_version';
  const owner = validateLockOwner(parsed);
  if (owner !== null) return owner;
  // B12: a versioned object we don't recognise may be a live owner under a
  // future contract. Fail closed (never unlink) instead of stealing it as
  // 'corrupt'. Only non-versioned / non-object garbage stays 'corrupt'.
  if (isUnrecognisedVersionedOwner(parsed)) return 'unrecognised';
  return 'corrupt';
}

function releaseMutationLock(lock: MutationLock | null): void {
  if (!lock || 'unlocked' in lock) return;
  try { closeSync(lock.fd); } catch { /* lock metadata ownership still guards release */ }
  if (flockPath()) {
    // Flock path: the guarded removal script unlinks only if the on-disk owner
    // exactly matches ours (pid + nonce + createdAt); a mismatched owner is a
    // live owner that lawfully reclaimed after our lease expired, so we leave
    // it in place (the script exits 4 and we log).
    const disposition = guardedLockRemoval(lock.path, 'release', lock.owner);
    if (disposition === 'replaced' || disposition === 'old_version') {
      console.error(`[omc-lock] state_mutation_lock_release_owner_mismatch: ${lock.path}`);
    }
    return;
  }
  // flock-less runtime (macOS/Windows) or the explicit test simulation: the
  // holder releases its OWN lock. Re-validate immediately before unlink to close
  // the TOCTOU window between readLockOwner and unlinkSync: if the on-disk owner
  // no longer matches (our lease expired and a later acquirer reclaimed it, or a
  // concurrent release raced), leave the live owner's lock in place and log.
  const current = readLockOwner(lock.path);
  if (current === 'absent') return; // already released
  if (current === null) return; // unreadable - do not unlink what we cannot verify
  if (current === 'old_version' || current === 'unknown_version' || current === 'unrecognised') {
    // The on-disk lock is now a record under a contract we don't recognise
    // (v1 old-liveness, an unsupported lease version, or an unrecognised
    // versioned shape - e.g. a pre-upgrade owner or a future-schema owner that
    // reclaimed after our lease expired). It is NOT ours; leave it in place
    // (B12) - never unlink an owner whose schema we cannot verify.
    console.error(`[omc-lock] state_mutation_lock_release_owner_mismatch: ${lock.path}`);
    return;
  }
  if (current !== 'corrupt' && sameLockOwner(current, lock.owner)) {
    try { unlinkSync(lock.path); } catch { /* race or already removed */ }
  } else {
    console.error(`[omc-lock] state_mutation_lock_release_owner_mismatch: ${lock.path}`);
  }
}

// ---------------------------------------------------------------------------
// Test surface (B4): export the lease-owner validator and a thin acquire/
// release pair so the flock-less lock cycle can be exercised end-to-end in
// tests without going through the full state-file write path. Owner liveness
// is now lease-based (expires_at), so no processStart/jiffies seam is needed.
// ---------------------------------------------------------------------------

export function validateMutationLockOwner(value: unknown): MutationLockOwner | null {
  return validateLockOwner(value);
}

/** Acquire a mutation lock at an explicit path (test surface). */
export function acquireMutationLockAt(filePath: string, requireExclusive = false): MutationLock | null {
  return acquireLockAt(`${filePath}.mutation.lock`, requireExclusive);
}

/** Release a mutation lock previously acquired via acquireMutationLockAt. */
export function releaseMutationLockSync(lock: MutationLock | null): void {
  releaseMutationLock(lock);
}

/**
 * Re-validates that the holder's OWN lease is still live (B11). Re-reads the
 * on-disk owner at `lock.path` and confirms (a) it is still our lock
 * (`sameLockOwner`: pid + nonce + createdAt) and (b) `now < expires_at`. If the
 * lease has expired while we were still in the critical section, a second writer
 * may already have reclaimed and re-acquired the lock; publishing now would
 * silently overwrite that writer's work. To make that violation DETECTABLE
 * rather than silent, this throws `lease_expired_during_mutation` and logs the
 * two-writer overlap. Call this immediately BEFORE publishing under a lock whose
 * critical section may approach LEASE_MS; withStateFileMutationLock does so
 * automatically before invoking the callback.
 *
 * Note: this is the holder checking ITS OWN lease, not someone else's. A holder
 * that overruns its lease is the bug; this is the safety net that catches it.
 */
export function assertMutationLockHeld(lock: MutationLock | null): void {
  if (!lock || 'unlocked' in lock) return;
  const current = readLockOwner(lock.path);
  if (current === 'absent' || current === 'old_version' || current === 'unknown_version' || current === 'unrecognised' || current === 'corrupt' || current === null) {
    // Our lock is gone / unreadable / replaced by an owner under a contract we
    // don't recognise (old-liveness, unsupported lease version, or an
    // unrecognised versioned shape): a later writer may have reclaimed after our
    // lease expired. Treat as an overlap.
    console.error(`[omc-lock] state_mutation_lock_lease_expired_during_mutation: ${lock.path}`);
    throw new Error(`lease_expired_during_mutation: holder's lock is no longer live at ${lock.path}`);
  }
  if (!sameLockOwner(current, lock.owner)) {
    // A later writer reclaimed our expired lease and re-acquired: overlap.
    console.error(`[omc-lock] state_mutation_lock_lease_expired_during_mutation: ${lock.path}`);
    throw new Error(`lease_expired_during_mutation: on-disk owner replaced at ${lock.path}`);
  }
  if (leaseNow() >= Date.parse(current.expires_at)) {
    // Our lease has expired while we are still in the critical section. A second
    // writer can reclaim at any moment. Abort the publish and surface the
    // two-writer overlap so it is observable, not silent.
    console.error(`[omc-lock] state_mutation_lock_lease_expired_during_mutation: ${lock.path}`);
    throw new Error(`lease_expired_during_mutation: holder's lease expired before publish at ${lock.path}`);
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
export function renewMutationLock(lock: MutationLock | null): boolean {
  if (!lock || 'unlocked' in lock) return true;
  // A read followed by rename is not a path-level CAS. Without the shared
  // reclaimer guard there is no portable safe replacement, so fail closed.
  if (!flockPath()) return false;
  const current = readLockOwner(lock.path);
  if (current === 'absent' || current === 'old_version' || current === 'unknown_version' || current === 'unrecognised' || current === 'corrupt' || current === null) return false;
  if (!sameLockOwner(current, lock.owner)) return false; // someone else owns it now
  if (leaseNow() >= Date.parse(current.expires_at)) return false;
  const renewedExpiresAt = new Date(leaseNow() + LOCK_LEASE_MS).toISOString();
  const tempPath = `${lock.path}.${process.pid}.${lock.owner.nonce}.renew.tmp`;
  let fd: number | undefined;
  try {
    const renewed: MutationLockOwner = { ...lock.owner, expires_at: renewedExpiresAt };
    fd = openSync(tempPath, 'wx', 0o600);
    writeAllSync(fd, JSON.stringify(renewed), 'lock renewal publication');
    fsyncSync(fd);
    // Repeat identity and expiry validation under the same guard reclaimers
    // use, then replace atomically. This cannot overwrite a later owner.
    if (!guardedLockRenewal(lock.path, lock.owner, tempPath)) return false;
    lock.owner = renewed;
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort descriptor cleanup */ } }
    try { unlinkSync(tempPath); } catch { /* best-effort unpublished temp cleanup */ }
  }
}

/**
 * Reports whether `renewMutationLock` can actually extend the lease for `lock`
 * on the current runtime (B11). On a flock-capable runtime it returns true; on
 * a flock-less runtime (macOS/Windows) it returns false, because a portable
 * atomic rename-over-the-live-lock is unavailable without the shared reclaimer
 * guard, so `renewMutationLock` returns false there regardless of whether the
 * lock is still held. Unlocked locks are trivially "supported" (renewal is a
 * no-op that returns true).
 *
 * Callers that gate on renewal failure should use this to distinguish
 * "renewal unsupported on this runtime" (the lock is NOT lost - it is still
 * held via the O_EXCL linkSync and its lease is still valid for LEASE_MS; the
 * holder should NO-OP, relying on `assertMutationLockHeld` before publish as the
 * safety net) from "renewal attempted on a supported runtime and failed" (the
 * lock WAS lost - owner replaced / lease expired / I/O error - and the caller
 * must abort). Treating the unsupported case as `lock_lost` would break every
 * mutation on macOS/Windows.
 */
export function mutationLockRenewalSupported(lock: MutationLock | null): boolean {
  if (!lock || 'unlocked' in lock) return true;
  return !!flockPath();
}

/** Executes a read or mutation against a state file under its mutation lock. */
export function withStateFileMutationLock<T>(
  filePath: string,
  callback: (assertHeld: () => void) => T,
  requireExclusive = false,
): { acquired: boolean; value: T | undefined } {
  const lock = acquireLockAt(`${filePath}.mutation.lock`, requireExclusive);
  if (!lock) return { acquired: false, value: undefined };
  try {
    // Callers with a publication inside the callback invoke this immediately
    // before it. Zero-argument callbacks remain source-compatible.
    return { acquired: true, value: callback(() => assertMutationLockHeld(lock)) };
  } finally {
    releaseMutationLock(lock);
  }
}

// ===========================================================================
// OCC (optimistic concurrency control) journal - root cure for B11.
//
// The lease lock above cannot atomically (check-ownership + write) an EXISTING
// state file on a flock-less runtime (macOS/Windows): renewMutationLock returns
// false there and assertMutationLockHeld is a read-then-write TOCTOU, so a
// stale holder whose lease expired mid-mutation can overwrite a successor's
// publish (B11), and a stale releaser can unlink a successor's lock (release
// race). No combination of rename/link/unlink atomically fences an EXISTING
// file on flock-less. OCC fixes it using ONLY O_EXCL (portable, no flock, no
// liveness probe, testable on mac): every mutation sequences a NEW journal
// entry under an O_EXCL name and validates its parent against the current
// committed sequence; a stale writer that forks off an old parent is DETECTED
// and re-sequenced AFTER its successor instead of overwriting it. There is no
// shared lock to unlink - cleanup only ever touches the writer's OWN entries.
//
// Journal layout per state file `filePath`:
//   dir:        filePath.journal/
//   entry:      <seq>.<owner_token>.json        = { seq, parent_seq, owner_token, state }
//   commit:     <seq>.<owner_token>.complete    (O_EXCL file = committed)
//   aborted:    <seq>.<owner_token>.aborted     (marker for a detected dead fork)
// "current" = the entry with the MAX seq bearing a .complete marker. Readers
// scan the directory for the max complete seq (small N; entries with seq <
// current - K are pruned, K=8) and read that entry's state. The canonical
// `filePath` is re-published (atomicWriteJsonSync) right after each commit so
// existing readers that do not understand the journal keep working.
//
// The JS mirror lives in scripts/lib/atomic-write.mjs (byte-identical to
// templates/hooks/lib/atomic-write.mjs); this TS copy mirrors it semantically.
// ===========================================================================

/** Prune window: keep entries whose seq >= currentSeq - OCC_JOURNAL_PRUNE_BEHIND. */
const OCC_JOURNAL_PRUNE_BEHIND = 8;
/** Bounded O_EXCL claim retries per commit attempt (defends against live contention). */
const OCC_JOURNAL_MAX_RETRIES = 50;

/**
 * Test seam for the deterministic B11 probe (stale-holder-publishes-after-reclaim).
 * When `pauseAfterClaim` is set, `occCommitMutation` invokes its `fn` AFTER
 * claiming an entry and BEFORE the fence revalidation, letting a test
 * deschedule writer A, commit writer B fully, then resume A so A must detect
 * its fork. Unused in production (the hook object stays empty).
 */
export interface OccTestHooks {
  pauseAfterClaim?: { filePath: string; fn: (seq: number, ownerToken: string, parentSeq: number) => void };
}
export const OCC_TEST_HOOKS: OccTestHooks = {};

type OccReadCurrentResult = {
  seq: number;
  state: unknown;
  empty: boolean;
  ioError: boolean;
  reservedSeq: number;
};

function occJournalDir(filePath: string): string {
  return `${filePath}.journal`;
}

function occEntryPath(dir: string, seq: number, token: string): string {
  return join(dir, `${seq}.${token}.json`);
}

function occCompletePath(dir: string, seq: number, token: string): string {
  return join(dir, `${seq}.${token}.complete`);
}

function occAbortedPath(dir: string, seq: number, token: string): string {
  return join(dir, `${seq}.${token}.aborted`);
}

/** A sequence-level O_EXCL reservation: one sequence has exactly one writer. */
function occClaimPath(dir: string, seq: number): string {
  return join(dir, `${seq}.claim`);
}

const OCC_ENTRY_NAME_RE = /^(\d+)\.([0-9a-f-]{36})\.(json|complete|aborted)$/i;
const OCC_CLAIM_NAME_RE = /^(\d+)\.claim$/;

/**
 * Scans the OCC journal directory and returns the current committed state: the
 * entry with the maximum `seq` that bears a `.complete` marker. Returns
 * { seq: -1, state: null, empty: true } when no committed entry exists yet (the
 * journal is empty). Returns ioError=true ONLY when the journal directory is
 * present but unreadable with a non-ENOENT I/O error - in that case the caller
 * FAILS CLOSED (operator attention): an OCC commit cannot proceed safely
 * without being able to read the committed sequence fence.
 */
function occReadCurrent(filePath: string): OccReadCurrentResult {
  const dir = occJournalDir(filePath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { seq: -1, state: null, empty: true, ioError: false, reservedSeq: -1 };
    return { seq: -1, state: null, empty: false, ioError: true, reservedSeq: -1 };
  }
  const completeBySeq = new Map<number, string | null>();
  const entryBySeq = new Map<number, string>();
  let reservedSeq = -1;
  for (const name of names) {
    const claim = OCC_CLAIM_NAME_RE.exec(name);
    if (claim) {
      const seq = Number(claim[1]);
      if (Number.isInteger(seq) && seq >= 0) reservedSeq = Math.max(reservedSeq, seq);
      continue;
    }
    const match = OCC_ENTRY_NAME_RE.exec(name);
    if (!match) continue;
    const seq = Number(match[1]);
    if (!Number.isInteger(seq) || seq < 0) continue;
    const token = match[2];
    const kind = match[3];
    if (kind === 'complete') {
      const existing = completeBySeq.get(seq);
      completeBySeq.set(seq, existing === undefined ? token : existing === token ? token : null);
    } else if (kind === 'json') {
      const existing = entryBySeq.get(seq);
      if (existing === undefined) entryBySeq.set(seq, token);
      else if (existing !== token) return { seq: -1, state: null, empty: false, ioError: true, reservedSeq };
    }
  }
  if (completeBySeq.size === 0) return { seq: -1, state: null, empty: true, ioError: false, reservedSeq };
  let maxSeq = -1;
  for (const seq of completeBySeq.keys()) if (seq > maxSeq) maxSeq = seq;
  const completeToken = completeBySeq.get(maxSeq);
  const token = entryBySeq.get(maxSeq);
  if (!token || !completeToken || completeToken !== token) {
    // A complete marker exists without its entry json: the entry was pruned or
    // never written. Treat the journal as unreadable at this fence and fail
    // closed rather than guessing a parent.
    return { seq: maxSeq, state: null, empty: false, ioError: true, reservedSeq };
  }
  let raw: string;
  try {
    raw = readFileSync(occEntryPath(dir, maxSeq, token), 'utf8');
  } catch {
    return { seq: maxSeq, state: null, empty: false, ioError: true, reservedSeq };
  }
  let entry: unknown;
  try {
    entry = JSON.parse(raw);
  } catch {
    return { seq: maxSeq, state: null, empty: false, ioError: true, reservedSeq };
  }
  const record = entry as Record<string, unknown> | null;
  if (!record || typeof record !== 'object' || record.seq !== maxSeq || record.owner_token !== token || !('state' in record)) {
    return { seq: maxSeq, state: null, empty: false, ioError: true, reservedSeq };
  }
  return { seq: maxSeq, state: record.state, empty: false, ioError: false, reservedSeq };
}

type OccCanonicalSnapshot = { state: unknown; fingerprint: string; ioError: boolean };

/**
 * The canonical file is an integrity fence as well as a compatibility cache.
 * Non-OCC paths still exist in deployed installs, so an OCC retry must see a
 * valid canonical replacement instead of committing against a stale journal.
 */
function occReadCanonicalSnapshot(filePath: string): OccCanonicalSnapshot {
  try {
    const state = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return { state, fingerprint: JSON.stringify(state), ioError: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: null, fingerprint: 'absent', ioError: false };
    return { state: null, fingerprint: '', ioError: true };
  }
}

function occStateFingerprint(state: unknown): string {
  return state === null ? 'absent' : JSON.stringify(state);
}

/** Removes only the caller's OWN incomplete entry + any markers for (seq, token). */
function occCleanupOwn(dir: string, seq: number, token: string): void {
  try { unlinkSync(occClaimPath(dir, seq)); } catch { /* absent */ }
  try { unlinkSync(occEntryPath(dir, seq, token)); } catch { /* absent */ }
  try { unlinkSync(occCompletePath(dir, seq, token)); } catch { /* absent */ }
  try { unlinkSync(occAbortedPath(dir, seq, token)); } catch { /* absent */ }
}

/** Prunes committed entries older than currentSeq - K (keeps the history tail bounded). */
function occPruneOld(dir: string, currentSeq: number): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  const cutoff = currentSeq - OCC_JOURNAL_PRUNE_BEHIND;
  for (const name of names) {
    const match = OCC_ENTRY_NAME_RE.exec(name) ?? OCC_CLAIM_NAME_RE.exec(name);
    if (!match) continue;
    const seq = Number(match[1]);
    if (Number.isInteger(seq) && seq < cutoff) {
      try { unlinkSync(join(dir, name)); } catch { /* race; ignore */ }
    }
  }
}

export type OccMutate<TState, TResult> = (currentState: unknown, ownerToken: string) => { state: TState; result: TResult } | null;

export interface OccCommitOptions {
  ownerToken?: string;
  /** Called at the commit/publish boundary by public mutation-lock holders. */
  assertHeld?: () => void;
}

/**
 * OCC commit protocol (replaces writeAtomic-under-lock for concurrency fencing).
 *
 * `mutate(currentState)` is PURE: it returns { state, result } (or `null` to
 * cancel without committing). The wrapper handles claim, parent-validation,
 * commit, re-publication, and retry. Returns the committed result, or `null`
 * if every retry forked (extremely live contention) or on a journal-directory
 * I/O error (fail closed) or a thrown/cancelled mutation.
 */
export function occCommitMutation<TState, TResult>(
  filePath: string,
  mutate: OccMutate<TState, TResult>,
  options?: OccCommitOptions,
): { state: TState; result: TResult } | null {
  const dir = occJournalDir(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  const ownerToken = options?.ownerToken ?? randomUUID();
  let parentSeq = -1;
  let parentState: unknown = null;
  for (let attempt = 0; attempt < OCC_JOURNAL_MAX_RETRIES; attempt += 1) {
    const current = occReadCurrent(filePath);
    if (current.ioError) return null; // fail closed: cannot fence without reading
    const canonical = occReadCanonicalSnapshot(filePath);
    if (canonical.ioError) return null;
    if (current.empty) {
      parentSeq = -1;
      parentState = canonical.state;
    } else {
      parentSeq = current.seq;
      parentState = occStateFingerprint(current.state) === canonical.fingerprint ? current.state : canonical.state;
    }
    let produced: { state: TState; result: TResult } | null;
    produced = mutate(parentState, ownerToken);
    if (produced === null || produced === undefined) return null; // cancelled, no commit
    const next = produced.state;
    const seq = Math.max(parentSeq, current.reservedSeq) + 1;
    const entryPath = occEntryPath(dir, seq, ownerToken);
    let fd: number | undefined;
    try {
      // Claim the sequence itself, not a token-qualified child. Otherwise two
      // writers can both create `<seq>.<token>.json` and lose one mutation.
      fd = openSync(occClaimPath(dir, seq), 'wx', 0o600);
      writeAllSync(fd, ownerToken, 'occ sequence claim');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      fd = openSync(entryPath, 'wx', 0o600);
      const entry = { seq, parent_seq: parentSeq, owner_token: ownerToken, state: next };
      writeAllSync(fd, JSON.stringify(entry), 'occ journal entry');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort descriptor cleanup */ } }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        // Another writer owns this exact sequence. Re-read its reservation and
        // claim a later sequence rather than sharing a token-qualified child.
        continue;
      }
      occCleanupOwn(dir, seq, ownerToken);
      return null;
    }
    // Test seam (B11 probe): when a pause hook is registered for this filePath,
    // invoke it AFTER the entry is claimed but BEFORE the fence revalidation.
    // This deterministically forces the stale-holder-publishes-after-reclaim
    // interleaving: A claims, yields here, B commits fully, A resumes and must
    // detect the fork. No-op in production (no hook registered).
    if (OCC_TEST_HOOKS.pauseAfterClaim && OCC_TEST_HOOKS.pauseAfterClaim.filePath === filePath) {
      try { OCC_TEST_HOOKS.pauseAfterClaim.fn(seq, ownerToken, parentSeq); } catch { /* test seam; ignore */ }
    }
    // RE-VALIDATE (the fence): re-scan the current committed max. If a successor
    // committed in the window (current.seq > parentSeq), this entry is a DEAD
    // FORK off a stale parent: mark it aborted, re-run the mutation on the
    // successor's state, and re-sequence AFTER it. It NEVER overwrites.
    const fence = occReadCurrent(filePath);
    if (fence.ioError) {
      occCleanupOwn(dir, seq, ownerToken);
      return null;
    }
    if (!fence.empty && fence.seq > parentSeq) {
      try { unlinkSync(occEntryPath(dir, seq, ownerToken)); } catch { /* absent */ }
      // mark the fork as aborted so it is distinguishable from a live claim
      try { closeSync(openSync(occAbortedPath(dir, seq, ownerToken), 'wx', 0o600)); } catch { /* already marked */ }
      continue; // re-run mutate on the successor's state
    }
    try {
      options?.assertHeld?.();
    } catch {
      occCleanupOwn(dir, seq, ownerToken);
      return null;
    }
    // This is deliberately adjacent to marker publication. A canonical-only
    // replacement observed after the mutation was calculated invalidates this
    // attempt so conditional writers cannot overwrite it from stale state.
    const canonicalFence = occReadCanonicalSnapshot(filePath);
    if (canonicalFence.ioError) {
      occCleanupOwn(dir, seq, ownerToken);
      return null;
    }
    if (canonicalFence.fingerprint !== canonical.fingerprint) {
      occCleanupOwn(dir, seq, ownerToken);
      continue;
    }
    // COMMIT: create the .complete marker via O_EXCL.
    let markerFd: number | undefined;
    try {
      markerFd = openSync(occCompletePath(dir, seq, ownerToken), 'wx', 0o600);
      fsyncSync(markerFd);
      closeSync(markerFd);
    } catch (error) {
      if (markerFd !== undefined) { try { closeSync(markerFd); } catch { /* best-effort descriptor cleanup */ } }
      occCleanupOwn(dir, seq, ownerToken);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue; // marker already exists for this (seq, token); retry
      return null;
    }
    // Re-validate this seq is still the max complete (else a successor committed
    // between our fence read and our marker; we still committed a valid child of
    // `parentSeq`, which is fine - the successor simply sequences ahead). If our
    // entry is now NOT the max, it remains a valid committed ancestor: leave it.
    occPruneOld(dir, seq);
    // Re-publish the canonical file so legacy readers see the latest state.
    try {
      atomicWriteJsonSync(filePath, next);
    } catch {
      // The journal IS the source of truth; a failed canonical re-publish is
      // non-fatal (the committed entry already advances current). Return success.
    }
    return produced;
  }
  return null; // exhausted retries under extreme live contention
}

/** Reads the current committed state via the OCC journal (test + reader surface). */
export function occReadCurrentState(filePath: string): unknown {
  const current = occReadCurrent(filePath);
  if (current.ioError) return null;
  if (current.empty) {
    try { return JSON.parse(readFileSync(filePath, 'utf8')); } catch { return null; }
  }
  return current.state;
}

/**
 * Record a completed non-OCC publication while the caller holds the same
 * mutation lock used by public writes and clears. Emergency transactions use
 * this after their crash-safe canonical publish so later OCC reads cannot see
 * a stale journal generation. An absent canonical file is an explicit
 * tombstone; it is restored to absent after the journal commit.
 */
export function occReconcileCanonicalState(filePath: string, assertHeld?: () => void): boolean {
  const snapshot = occReadCanonicalSnapshot(filePath);
  if (snapshot.ioError) return false;
  const committed = occCommitMutation<unknown, boolean>(
    filePath,
    () => ({ state: snapshot.state, result: true }),
    { assertHeld },
  );
  if (committed === null) return false;
  if (snapshot.state === null) {
    try { unlinkSync(filePath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  return true;
}

/** Cleans up only this owner token's stale INCOMPLETE entries (release race cure). */
export function occCleanupOwner(filePath: string, ownerToken: string): void {
  const dir = occJournalDir(filePath);
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const match = OCC_ENTRY_NAME_RE.exec(name);
    if (!match) continue;
    if (match[2] !== ownerToken) continue; // never touch another writer's entries
    const seq = Number(match[1]);
    void seq;
    const kind = match[3];
    // Only remove entries that lack a .complete marker (incomplete forks).
    if (kind === 'json' || kind === 'aborted') {
      const hasComplete = names.some((other) => {
        const om = OCC_ENTRY_NAME_RE.exec(other);
        return om && om[1] === match[1] && om[2] === ownerToken && om[3] === 'complete';
      });
      if (!hasComplete) {
        try { unlinkSync(join(dir, name)); } catch { /* race */ }
      }
    }
  }
}

export function writeStateFileLocked(filePath: string, state: Record<string, unknown>): boolean {
  if (!recoverEmergencyStateFile(filePath)) return false;
  // OCC commit (B11 root cure): the publish is fenced by an O_EXCL journal
  // sequence, so a stale holder whose lease expired mid-mutation is
  // re-sequenced AFTER any successor instead of overwriting it. The mutation is
  // pure (returns `state` regardless of current); the OCC wrapper commits.
  const lock = acquireMutationLock(filePath);
  if (!lock) return false;
  try {
    const committed = occCommitMutation<Record<string, unknown>, boolean>(
      filePath,
      () => ({ state, result: true }),
      { assertHeld: () => assertMutationLockHeld(lock) },
    );
    return committed !== null;
  } finally {
    releaseMutationLock(lock);
  }
}

export function clearStateFileLocked(filePath: string): boolean {
  // NOTE: clear stays on the lease lock (NOT the OCC tombstone path). The OCC
  // tombstone migration was reverted: it broke ~242 tests because the tombstone
  // commit did not reliably unlink the canonical file for clear / runtime-
  // artifact paths (clearModeState leaves marker files present). The maintainer's
  // B11 "release" is satisfied by the lock-release path + occCleanupOwner (no
  // shared lock file under OCC for writes) + release probe #2; the state-clear
  // on the lease lock is fail-closed: assertMutationLockHeld aborts on overlap,
  // and under (B) the canonical is a derived cache so a stale clear is harmless.
  if (!recoverEmergencyStateFile(filePath)) return false;
  const lock = acquireMutationLock(filePath);
  if (!lock) return false;
  try {
    assertMutationLockHeld(lock); // B11: abort mutation if our lease expired mid-mutation
    if (existsSync(filePath)) unlinkSync(filePath);
    return true;
  } catch {
    return false;
  } finally {
    releaseMutationLock(lock);
  }
}

export type EmergencyStateAuthorization = (state: Record<string, unknown>) => boolean;
export interface EmergencyRecoveryOptions {
  /** Evaluated under the recovery claim before a recovered generation is mutated. */
  authorizeState?: EmergencyStateAuthorization;
}

export type ConditionalClearResult = 'cleared' | 'skipped' | 'failed';

export function clearStateFileLockedIf(
  filePath: string,
  predicate: (current: Record<string, unknown>) => boolean,
  recoveryOptions?: EmergencyRecoveryOptions,
): ConditionalClearResult {
  // NOTE: conditional clear stays on the lease lock (see clearStateFileLocked
  // above). The OCC tombstone migration was reverted for breaking clears.
  if (!recoverEmergencyStateFile(filePath, recoveryOptions)) return 'failed';
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH === filePath && process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64) {
    try {
      const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64, 'base64').toString('utf8')) as Record<string, unknown>;
      atomicWriteJsonSync(filePath, replacement);
    } finally {
      delete process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_PATH;
      delete process.env.OMC_TEST_CONDITIONAL_CLEAR_REPLACEMENT_BASE64;
    }
  }
  const lock = acquireMutationLock(filePath);
  if (!lock) return 'failed';
  try {
    if (!existsSync(filePath)) return 'skipped';
    let current: Record<string, unknown>;
    try {
      current = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
      return 'failed';
    }
    if (!predicate(current)) return 'skipped';
    assertMutationLockHeld(lock); // B11: abort mutation if our lease expired mid-mutation
    unlinkSync(filePath);
    return 'cleared';
  } catch {
    return 'failed';
  } finally {
    releaseMutationLock(lock);
  }
}

export type ConditionalWriteResult = 'written' | 'skipped' | 'failed';

export function writeStateFileLockedIf(
  filePath: string,
  predicate: (current: Record<string, unknown>) => boolean,
  transform: (current: Record<string, unknown>) => Record<string, unknown>,
): ConditionalWriteResult {
  if (!recoverEmergencyStateFile(filePath)) return 'failed';
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_PATH === filePath && process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_BASE64) {
    try {
      const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_BASE64, 'base64').toString('utf8')) as Record<string, unknown>;
      atomicWriteJsonSync(filePath, replacement);
    } finally {
      delete process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_PATH;
      delete process.env.OMC_TEST_CONDITIONAL_WRITE_REPLACEMENT_BASE64;
    }
  }
  // OCC commit (B11 root cure): predicate + transform run against the OCC-
  // validated current committed state on each retry, so a stale writer that
  // forked off an old parent re-runs against the successor's state. A
  // predicate that no longer holds returns null (skip) without committing.
  const lock = acquireMutationLock(filePath);
  if (!lock) return 'failed';
  try {
    let skipped = false;
    const committed = occCommitMutation<Record<string, unknown>, ConditionalWriteResult>(filePath, (currentRaw) => {
      if (currentRaw === null || currentRaw === undefined || typeof currentRaw !== 'object' || Array.isArray(currentRaw)) return null;
      const current = currentRaw as Record<string, unknown>;
      if (!predicate(current)) {
        skipped = true;
        return null;
      }
      return { state: transform(current), result: 'written' as ConditionalWriteResult };
    }, { assertHeld: () => assertMutationLockHeld(lock) });
    if (committed === null) return skipped ? 'skipped' : 'failed';
    return committed.result;
  } finally {
    releaseMutationLock(lock);
  }
}

export function writeStateFileLockedCreateIf(
  filePath: string,
  predicate: (current: Record<string, unknown> | null) => boolean,
  transform: (current: Record<string, unknown> | null) => Record<string, unknown>,
): ConditionalWriteResult {
  if (!recoverEmergencyStateFile(filePath)) return 'failed';
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_PATH === filePath && process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_BASE64) {
    try {
      const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_BASE64, 'base64').toString('utf8')) as Record<string, unknown>;
      atomicWriteJsonSync(filePath, replacement);
    } finally {
      delete process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_PATH;
      delete process.env.OMC_TEST_CONDITIONAL_CREATE_REPLACEMENT_BASE64;
    }
  }
  // OCC commit (B11 root cure): the create-if mutation runs against the OCC-
  // validated current (null when absent). The predicate gates whether a state
  // is produced at all; a falsy predicate returns null (skip, no commit).
  const lock = acquireMutationLock(filePath);
  if (!lock) return 'failed';
  try {
    let skipped = false;
    const committed = occCommitMutation<Record<string, unknown>, ConditionalWriteResult>(filePath, (currentRaw) => {
      let current: Record<string, unknown> | null = null;
      if (currentRaw !== null && currentRaw !== undefined) {
        if (typeof currentRaw !== 'object' || Array.isArray(currentRaw)) return null;
        current = currentRaw as Record<string, unknown>;
      }
      if (!predicate(current)) {
        skipped = true;
        return null;
      }
      return { state: transform(current), result: 'written' as ConditionalWriteResult };
    }, { assertHeld: () => assertMutationLockHeld(lock) });
    if (committed === null) return skipped ? 'skipped' : 'failed';
    return committed.result;
  } finally {
    releaseMutationLock(lock);
  }
}

/**
 * Durable exact mutation for named workflow emergency cancellation. The journal
 * records every externally-visible step so a later reader can finish a partial
 * transaction without guessing whether the primary is a replacement.
 */
type EmergencyJournalOwner = {
  pid: number;
  processStart: string;
  nonce: string;
};

/**
 * Owner record for an emergency recovery claim. This is the EMERGENCY subsystem
 * (crash-recovery of an interrupted exact mutation), NOT the mutation lock: it
 * authenticates the claimant by process-start identity (processStart) so a dead
 * or recycled pid's stale claim can be reclaimed. It is intentionally kept
 * separate from the lease-based MutationLockOwner so the mutation-lock liveness
 * blockers cannot recur here. The on-disk schema is validated by
 * RECOVERY_CLAIM_SCRIPT (processStart required).
 */
type RecoveryClaimOwner = {
  version: 1;
  pid: number;
  processStart: string;
  createdAt: string;
  nonce: string;
};

type EmergencyMutationJournal = {
  version: 1;
  transactionId: string;
  owner: EmergencyJournalOwner;
  sessionOwner?: string;
  originalDigest?: string;
  intendedDigest?: string;
  intent?: 'clear' | 'publish';
  quarantinePath: string;
  phase: 'preparing' | 'prepared' | 'quarantined' | 'published';
};

type FileIdentity = { dev: number; ino: number };

function stateDigest(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function emergencyJournalPath(filePath: string): string {
  return `${filePath}.emergency-journal.json`;
}

function emergencyOwner(): EmergencyJournalOwner | null {
  const processStart = processStartIdentity(process.pid);
  return typeof processStart === 'string' ? { pid: process.pid, processStart, nonce: randomUUID() } : null;
}

function sameEmergencyOwner(left: EmergencyJournalOwner, right: EmergencyJournalOwner): boolean {
  return left.pid === right.pid && left.processStart === right.processStart && left.nonce === right.nonce;
}

/** Unknown process identity is treated as live: stealing a claim is never safe. */
function isEmergencyOwnerLive(owner: EmergencyJournalOwner): boolean {
  const current = processStartIdentity(owner.pid);
  return current === null || (current !== 'absent' && current === owner.processStart);
}

function journalIsOwned(path: string, transactionId: string, owner: EmergencyJournalOwner): boolean {
  const current = readEmergencyJournal(path);
  return current !== null && current.transactionId === transactionId && sameEmergencyOwner(current.owner, owner);
}

function writeEmergencyJournal(path: string, journal: EmergencyMutationJournal, requireOwnership = true): boolean {
  try {
    if (requireOwnership && !journalIsOwned(path, journal.transactionId, journal.owner)) return false;
    atomicWriteJsonSync(path, journal);
    return !requireOwnership || journalIsOwned(path, journal.transactionId, journal.owner);
  } catch { return false; }
}

function emergencyPublicationTempPath(path: string): string | null {
  const processStart = processStartIdentity(process.pid);
  if (!processStart || processStart === 'absent') return null;
  return `${path}.${process.pid}.${processStart}.${randomUUID()}.tmp`;
}

/** Publishes a complete, durable transaction file without exposing a partial final path. */
function publishEmergencyFileExclusive(path: string, content: string): boolean {
  const tempPath = emergencyPublicationTempPath(path);
  let fd: number | undefined;
  try {
    if (!tempPath) return false;
    mkdirSync(dirname(path), { recursive: true });
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
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort descriptor cleanup */ } }
    if (tempPath) {
      const generation = fileIdentity(tempPath);
      try { if (generation && sameFile(tempPath, generation)) unlinkSync(tempPath); } catch { /* best-effort unpublished temp cleanup */ }
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

function guardedRecoveryClaim(path: string, operation: 'acquire' | 'release', owner: RecoveryClaimOwner): 'claimed' | 'live' | 'replaced' | 'unverifiable' {
  const flock = flockPath();
  if (!flock) return 'unverifiable';
  const result = spawnSync(flock, ['-x', `${path}.recovery.guard`, process.execPath, '-e', RECOVERY_CLAIM_SCRIPT, operation, path, JSON.stringify(owner)], { stdio: 'ignore', timeout: 2000 });
  if (result.status === 0) return 'claimed';
  if (result.status === 2) return 'live';
  if (result.status === 4) return 'replaced';
  return 'unverifiable';
}

function acquireRecoveryClaim(path: string): RecoveryClaimOwner | null {
  const processStart = processStartIdentity(process.pid);
  if (!processStart || processStart === 'absent') return null;
  const owner: RecoveryClaimOwner = { version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
  if (!flockPath()) return publishEmergencyFileExclusive(path, JSON.stringify(owner)) ? owner : null;
  return guardedRecoveryClaim(path, 'acquire', owner) === 'claimed' ? owner : null;
}

function readRecoveryClaim(path: string): RecoveryClaimOwner | null {
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8')) as RecoveryClaimOwner;
    return owner.version === 1 && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.processStart === 'string' && typeof owner.createdAt === 'string' && typeof owner.nonce === 'string' ? owner : null;
  } catch { return null; }
}

function sameRecoveryClaim(left: RecoveryClaimOwner, right: RecoveryClaimOwner): boolean {
  return left.pid === right.pid && left.processStart === right.processStart && left.nonce === right.nonce;
}

function releaseRecoveryClaim(path: string, owner: RecoveryClaimOwner): void {
  if (!flockPath()) {
    try {
      const current = readRecoveryClaim(path);
      if (current && sameRecoveryClaim(current, owner)) unlinkSync(path);
    } catch { /* best-effort exact-owner release */ }
    return;
  }
  guardedRecoveryClaim(path, 'release', owner);
}

/** Claims a transaction journal without replacing a concurrent transaction. */
function createEmergencyJournal(path: string, journal: EmergencyMutationJournal): boolean {
  return publishEmergencyFileExclusive(path, JSON.stringify(journal));
}

function readEmergencyJournal(path: string): EmergencyMutationJournal | null {
  try {
    const journal = JSON.parse(readFileSync(path, 'utf8')) as EmergencyMutationJournal;
    if (journal.version !== 1 || typeof journal.transactionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(journal.transactionId) ||
      !journal.owner || !Number.isInteger(journal.owner.pid) || journal.owner.pid <= 0 || typeof journal.owner.processStart !== 'string' ||
      typeof journal.owner.nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(journal.owner.nonce) ||
      (journal.sessionOwner !== undefined && typeof journal.sessionOwner !== 'string') ||
      (journal.originalDigest !== undefined && (typeof journal.originalDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(journal.originalDigest))) ||
      (journal.intendedDigest !== undefined && (typeof journal.intendedDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(journal.intendedDigest))) ||
      (journal.intent !== undefined && journal.intent !== 'clear' && journal.intent !== 'publish') ||
      typeof journal.quarantinePath !== 'string' ||
      (journal.phase !== 'preparing' && journal.phase !== 'prepared' && journal.phase !== 'quarantined' && journal.phase !== 'published')) return null;
    const complete = typeof journal.originalDigest === 'string' && (journal.intent === 'clear' || (journal.intent === 'publish' && typeof journal.intendedDigest === 'string'));
    return journal.phase === 'preparing' || complete ? journal : null;
  } catch { return null; }
}

function fileIdentity(path: string): FileIdentity | null {
  try {
    const stat = statSync(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch { return null; }
}

function sameFile(path: string, expected: FileIdentity): boolean {
  const actual = fileIdentity(path);
  return actual !== null && actual.dev === expected.dev && actual.ino === expected.ino;
}

function reconcileEmergencyPublicationTemps(filePath: string, authorizeState?: EmergencyStateAuthorization): boolean {
  const directory = dirname(filePath);
  const base = filePath.slice(directory.length + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${base}\\.emergency-(journal\\.json|recovery\\.claim|quarantine\\.[0-9a-f-]{36}\\.payload)\\.(\\d+)\\.(\\d+)\\.([0-9a-f-]{36})\\.tmp$`, 'i');
  let names: string[];
  try { names = readdirSync(directory); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
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
          const state = JSON.parse(raw) as unknown;
          if (!state || typeof state !== 'object' || Array.isArray(state) || !authorizeState(state as Record<string, unknown>)) return false;
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

/** Captures only the authenticated source generation and never unlinks a replacement. */
function captureAndUnlinkPrimary(filePath: string, quarantinePath: string, expectedDigest: string): boolean {
  try {
    linkSync(filePath, quarantinePath);
    const captured = fileIdentity(quarantinePath);
    if (!captured || stateDigest(readFileSync(quarantinePath, 'utf8')) !== expectedDigest || !sameFile(filePath, captured)) return false;
    emergencyReplaceAtCaptureBoundary(filePath);
    if (!sameFile(filePath, captured) || stateDigest(readFileSync(filePath, 'utf8')) !== expectedDigest) return false;
    unlinkSync(filePath);
    return true;
  } catch { return false; }
}

function removeOwnedEmergencyArtifacts(journalPath: string, journal: EmergencyMutationJournal, removeQuarantine: boolean): boolean {
  try {
    if (!journalIsOwned(journalPath, journal.transactionId, journal.owner)) return false;
    if (removeQuarantine) {
      try { unlinkSync(journal.quarantinePath); } catch { /* absent */ }
    }
    try { unlinkSync(`${journal.quarantinePath}.payload`); } catch { /* absent */ }
    if (!journalIsOwned(journalPath, journal.transactionId, journal.owner)) return false;
    unlinkSync(journalPath);
    return true;
  } catch { return false; }
}

function recoveryGenerationsAuthorized(
  filePath: string,
  journal: EmergencyMutationJournal | null,
  authorizeState: EmergencyStateAuthorization | undefined,
): boolean {
  if (!authorizeState) return true;
  const paths = [
    filePath,
    ...(journal ? [journal.quarantinePath, `${journal.quarantinePath}.payload`] : []),
  ];
  let authenticatedJournalGeneration = journal === null;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let raw: string;
    let state: Record<string, unknown>;
    try {
      raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      state = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
    if (!authorizeState(state)) return false;
    if (journal && (
      stateDigest(raw) === journal.originalDigest ||
      (journal.intent === 'publish' && stateDigest(raw) === journal.intendedDigest)
    )) authenticatedJournalGeneration = true;
  }
  return authenticatedJournalGeneration;
}

/** Shared-home recovery claims contain no project identity, so pre-existing
 * claim publications are never attributable to the caller and must survive. */
function hasUnattributableRecoveryClaimArtifact(filePath: string, recoveryClaim?: RecoveryClaimOwner): boolean {
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

function sharedRecoveryArtifactsAuthorized(
  filePath: string,
  authorizeState: EmergencyStateAuthorization | undefined,
  recoveryClaim?: RecoveryClaimOwner,
): boolean {
  if (!authorizeState) return true;
  if (hasUnattributableRecoveryClaimArtifact(filePath, recoveryClaim)) return false;
  const journalPath = emergencyJournalPath(filePath);
  if (!existsSync(journalPath)) {
    if (!existsSync(filePath)) return true;
    try {
      const state = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
      return state !== null && typeof state === 'object' && !Array.isArray(state) && authorizeState(state as Record<string, unknown>);
    } catch {
      return false;
    }
  }
  const journal = readEmergencyJournal(journalPath);
  return journal !== null && recoveryGenerationsAuthorized(filePath, journal, authorizeState);
}

function emergencyReplaceAtRecoveryBoundary(filePath: string): void {
  if (process.env.NODE_ENV !== 'test' || process.env.OMC_TEST_EMERGENCY_RECOVERY_REPLACEMENT_PATH !== filePath || !process.env.OMC_TEST_EMERGENCY_RECOVERY_REPLACEMENT_BASE64) return;
  try {
    const replacements = JSON.parse(Buffer.from(process.env.OMC_TEST_EMERGENCY_RECOVERY_REPLACEMENT_BASE64, 'base64').toString('utf8')) as Array<{ path: string; content: string }>;
    const directory = dirname(filePath);
    for (const name of readdirSync(directory)) {
      if (name === basename(filePath) || name.startsWith(`${basename(filePath)}.emergency-`)) unlinkSync(join(directory, name));
    }
    for (const replacement of replacements) {
      if (dirname(replacement.path) !== directory) throw new Error('invalid recovery replacement path');
      writeFileSync(replacement.path, replacement.content);
    }
  } finally {
    delete process.env.OMC_TEST_EMERGENCY_RECOVERY_REPLACEMENT_PATH;
    delete process.env.OMC_TEST_EMERGENCY_RECOVERY_REPLACEMENT_BASE64;
  }
}

/** A dead transaction is recovered under a state-scoped, generation-verified exclusive claim. */
export function recoverEmergencyStateFile(filePath: string, options?: EmergencyRecoveryOptions): boolean {
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
    } finally {
      releaseRecoveryClaim(claimPath, claim);
    }
  }
  const journal = readEmergencyJournal(journalPath);
  if (!journal) {
    if (authorizeState) return false;
    const claimPath = `${filePath}.emergency-recovery.claim`;
    const claim = acquireRecoveryClaim(claimPath);
    if (!claim) return false;
    try {
      const generation = fileIdentity(journalPath);
      emergencyReplaceAtRecoveryBoundary(filePath);
      const current = readEmergencyJournal(journalPath);
      if (!recoveryGenerationsAuthorized(filePath, current, authorizeState)) return true;
      if (!reconcileEmergencyPublicationTemps(filePath, authorizeState)) return false;
      if (!generation || readEmergencyJournal(journalPath) !== null || !existsSync(filePath) || !sameFile(journalPath, generation)) return false;
      unlinkSync(journalPath);
      return true;
    } catch { return false; } finally {
      releaseRecoveryClaim(claimPath, claim);
    }
  }
  const claimPath = `${filePath}.emergency-recovery.claim`;
  const claim = acquireRecoveryClaim(claimPath);
  if (!claim) return false;
  try {
    if (!sharedRecoveryArtifactsAuthorized(filePath, authorizeState, claim)) return false;
    emergencyReplaceAtRecoveryBoundary(filePath);
    const current = readEmergencyJournal(journalPath);
    if (!recoveryGenerationsAuthorized(filePath, current, authorizeState)) return true;
    if (!reconcileEmergencyPublicationTemps(filePath, authorizeState)) return false;
    if (!current || current.quarantinePath !== `${filePath}.emergency-quarantine.${current.transactionId}` || isEmergencyOwnerLive(current.owner)) return false;
    return recoverDeadEmergencyStateFile(filePath, authorizeState);
  } finally {
    releaseRecoveryClaim(claimPath, claim);
  }
}

/** Recover a previously interrupted emergency mutation while holding the recovery claim. */
function recoverDeadEmergencyStateFile(filePath: string, authorizeState?: EmergencyStateAuthorization): boolean {
  const journalPath = emergencyJournalPath(filePath);
  if (!existsSync(journalPath)) return true;
  const journal = readEmergencyJournal(journalPath);
  if (!journal || journal.quarantinePath !== `${filePath}.emergency-quarantine.${journal.transactionId}`) return false;
  if (isEmergencyOwnerLive(journal.owner)) return false;
  if (!recoveryGenerationsAuthorized(filePath, journal, authorizeState)) return true;
  const owned = () => journalIsOwned(journalPath, journal.transactionId, journal.owner);
  if (!owned()) return false;
  const payloadPath = `${journal.quarantinePath}.payload`;
  const digest = (path: string): string | null => {
    try { return stateDigest(readFileSync(path, 'utf8')); } catch { return null; }
  };
  if (journal.phase === 'preparing') {
    const complete = typeof journal.originalDigest === 'string' && (journal.intent === 'clear' || (journal.intent === 'publish' && typeof journal.intendedDigest === 'string'));
    if (!complete) {
      if (existsSync(journal.quarantinePath) || existsSync(payloadPath)) return false;
      return removeOwnedEmergencyArtifacts(journalPath, journal, false);
    }
    const originalStillPrimary = !existsSync(journal.quarantinePath) && digest(filePath) === journal.originalDigest;
    if (journal.intent === 'publish' && digest(payloadPath) !== journal.intendedDigest) {
      return originalStillPrimary && removeOwnedEmergencyArtifacts(journalPath, journal, false);
    }
    if (journal.intent === 'clear' && existsSync(payloadPath)) {
      return originalStillPrimary && removeOwnedEmergencyArtifacts(journalPath, journal, false);
    }
    journal.phase = 'prepared';
    return writeEmergencyJournal(journalPath, journal) && recoverDeadEmergencyStateFile(filePath, authorizeState);
  }
  const originalDigest = journal.originalDigest!;
  const intent = journal.intent!;
  const intendedDigest = journal.intendedDigest;
  const hasPrimary = existsSync(filePath);
  const hasQuarantine = existsSync(journal.quarantinePath);
  const finalize = (): boolean => removeOwnedEmergencyArtifacts(journalPath, journal, hasQuarantine);

  if (hasPrimary && hasQuarantine) {
    if (intent === 'publish' && digest(filePath) === intendedDigest && digest(journal.quarantinePath) === originalDigest) return finalize();
    // The primary is an unrelated replacement. It wins; discard only this transaction.
    return removeOwnedEmergencyArtifacts(journalPath, journal, true);
  }
  if (hasPrimary) {
    if (!hasQuarantine && journal.phase === 'prepared' && digest(filePath) === originalDigest) {
      if (intent === 'publish' && digest(payloadPath) !== intendedDigest) return false;
      if (!owned()) return false;
      if (!captureAndUnlinkPrimary(filePath, journal.quarantinePath, originalDigest)) {
        if (owned() && existsSync(filePath) && existsSync(journal.quarantinePath) && digest(filePath) !== originalDigest) {
          removeOwnedEmergencyArtifacts(journalPath, journal, true);
        }
        return false;
      }
      journal.phase = 'quarantined';
      return writeEmergencyJournal(journalPath, journal) && recoverDeadEmergencyStateFile(filePath, authorizeState);
    }
    return false;
  }
  if (!hasQuarantine) {
    return intent === 'clear' && journal.phase === 'published' && removeOwnedEmergencyArtifacts(journalPath, journal, false);
  }
  if (digest(journal.quarantinePath) !== originalDigest || !owned()) return false;
  try {
    if (intent === 'clear') return removeOwnedEmergencyArtifacts(journalPath, journal, true);
    const payload = readFileSync(payloadPath, 'utf8');
    if (stateDigest(payload) !== intendedDigest || !owned()) return false;
    linkSync(payloadPath, filePath); // exclusive: never overwrite a replacement
    journal.phase = 'published';
    if (!writeEmergencyJournal(journalPath, journal)) return false;
    return removeOwnedEmergencyArtifacts(journalPath, journal, true);
  } catch { return false; }
}

function emergencyCrashAt(phase: string): boolean {
  return process.env.NODE_ENV === 'test' && process.env.OMC_TEST_EMERGENCY_CRASH_PHASE === phase;
}

/** A writer that cannot capture its authenticated source relinquishes its claim. */
function abandonEmergencyJournal(journalPath: string, journal: EmergencyMutationJournal): void {
  if (!journalIsOwned(journalPath, journal.transactionId, journal.owner)) return;
  journal.owner = { ...journal.owner, pid: 999999999, processStart: 'abandoned' };
  try { atomicWriteJsonSync(journalPath, journal); } catch { /* original claim remains safe */ }
}

/** Test crashes must relinquish ownership; a real crashed process is not live. */
function abandonEmergencyJournalForTest(journalPath: string, journal: EmergencyMutationJournal): void {
  if (!emergencyCrashAt('after-payload') && !emergencyCrashAt('before-rename') && !emergencyCrashAt('after-rename') && !emergencyCrashAt('after-publication') && !emergencyCrashAt('before-cleanup')) return;
  abandonEmergencyJournal(journalPath, journal);
}

function emergencyReplaceAfterPredicate(filePath: string): void {
  if (process.env.NODE_ENV !== 'test' || process.env.OMC_TEST_EMERGENCY_REPLACEMENT_PATH !== filePath || !process.env.OMC_TEST_EMERGENCY_REPLACEMENT_BASE64) return;
  try {
    const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_EMERGENCY_REPLACEMENT_BASE64, 'base64').toString('utf8')) as Record<string, unknown>;
    atomicWriteJsonSync(filePath, replacement);
  } finally {
    delete process.env.OMC_TEST_EMERGENCY_REPLACEMENT_PATH;
    delete process.env.OMC_TEST_EMERGENCY_REPLACEMENT_BASE64;
  }
}

function emergencyReplaceAtCaptureBoundary(filePath: string): void {
  if (process.env.NODE_ENV !== 'test' || process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_PATH !== filePath || !process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_BASE64) return;
  try {
    const replacement = JSON.parse(Buffer.from(process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_BASE64, 'base64').toString('utf8')) as Record<string, unknown>;
    atomicWriteJsonSync(filePath, replacement);
  } finally {
    delete process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_PATH;
    delete process.env.OMC_TEST_EMERGENCY_CAPTURE_REPLACEMENT_BASE64;
  }
}

export function emergencyMutateStateFileIf(
  filePath: string,
  predicate: (current: Record<string, unknown>) => boolean,
  transform: ((current: Record<string, unknown>) => Record<string, unknown>) | null,
  recoveryOptions?: EmergencyRecoveryOptions,
): boolean {
  if (!recoverEmergencyStateFile(filePath, recoveryOptions)) return false;
  const lock = acquireMutationLock(filePath);
  if (!lock) return false;
  try {
  const owner = emergencyOwner();
  if (!owner) return false;
  const transactionId = randomUUID();
  const quarantinePath = `${filePath}.emergency-quarantine.${transactionId}`;
  const journalPath = emergencyJournalPath(filePath);
  const payloadPath = `${quarantinePath}.payload`;
  let journal: EmergencyMutationJournal | null = null;
  try {
    journal = { version: 1, transactionId, owner, quarantinePath, phase: 'preparing' };
    if (!createEmergencyJournal(journalPath, journal)) return false;
    const owns = () => journal !== null && journalIsOwned(journalPath, transactionId, owner);
    if (!existsSync(filePath)) { removeOwnedEmergencyArtifacts(journalPath, journal, false); return false; }
    const originalRaw = readFileSync(filePath, 'utf8');
    const current = JSON.parse(originalRaw) as Record<string, unknown>;
    if (!predicate(current)) { removeOwnedEmergencyArtifacts(journalPath, journal, false); return false; }
    const transformedRaw = transform ? JSON.stringify(transform(current)) : undefined;
    Object.assign(journal, {
      ...(getStateSessionOwner(current) ? { sessionOwner: getStateSessionOwner(current) } : {}),
      originalDigest: stateDigest(originalRaw),
      ...(transformedRaw === undefined ? { intent: 'clear' as const } : { intent: 'publish' as const, intendedDigest: stateDigest(transformedRaw) }),
    });
    if (!owns() || !writeEmergencyJournal(journalPath, journal)) return false;
    if (transformedRaw !== undefined) {
      if (!owns()) return false;
      if (!publishEmergencyFileExclusive(payloadPath, transformedRaw)) return false;
      if (!owns()) return false;
    }
    if (emergencyCrashAt('after-payload')) { abandonEmergencyJournalForTest(journalPath, journal); return false; }
    journal.phase = 'prepared';
    if (!writeEmergencyJournal(journalPath, journal)) return false;
    const authenticatedRaw = readFileSync(filePath, 'utf8');
    const authenticated = JSON.parse(authenticatedRaw) as Record<string, unknown>;
    if (!owns() || stateDigest(authenticatedRaw) !== journal.originalDigest || !predicate(authenticated)) {
      removeOwnedEmergencyArtifacts(journalPath, journal, false);
      return false;
    }
    emergencyReplaceAfterPredicate(filePath);
    if (emergencyCrashAt('before-rename')) { abandonEmergencyJournalForTest(journalPath, journal); return false; }
    if (!owns() || !captureAndUnlinkPrimary(filePath, quarantinePath, journal.originalDigest!)) {
      removeOwnedEmergencyArtifacts(journalPath, journal, true);
      return false;
    }
    journal.phase = 'quarantined';
    if (!writeEmergencyJournal(journalPath, journal)) return false;
    if (emergencyCrashAt('after-rename')) { abandonEmergencyJournalForTest(journalPath, journal); return false; }
    if (transformedRaw !== undefined) {
      if (!owns()) return false;
      linkSync(payloadPath, filePath);
      journal.phase = 'published';
      if (!writeEmergencyJournal(journalPath, journal)) return false;
      if (emergencyCrashAt('after-publication')) { abandonEmergencyJournalForTest(journalPath, journal); return false; }
    } else {
      journal.phase = 'published';
      if (!writeEmergencyJournal(journalPath, journal)) return false;
    }
    if (emergencyCrashAt('before-cleanup')) { abandonEmergencyJournalForTest(journalPath, journal); return false; }
    return removeOwnedEmergencyArtifacts(journalPath, journal, true) &&
      occReconcileCanonicalState(filePath, () => assertMutationLockHeld(lock));
  } catch {
    if (journal) abandonEmergencyJournal(journalPath, journal);
    return false;
  }
  } finally {
    releaseMutationLock(lock);
  }
}

export function getStateSessionOwner(state: Record<string, unknown> | null | undefined): string | undefined {
  if (!state || typeof state !== 'object') {
    return undefined;
  }

  const meta = state._meta;
  if (meta && typeof meta === 'object') {
    const metaSessionId = (meta as Record<string, unknown>).sessionId;
    if (typeof metaSessionId === 'string' && metaSessionId) {
      return metaSessionId;
    }
  }

  const topLevelSessionId = state.session_id;
  return typeof topLevelSessionId === 'string' && topLevelSessionId
    ? topLevelSessionId
    : undefined;
}

export function canClearStateForSession(
  state: Record<string, unknown> | null | undefined,
  sessionId: string,
): boolean {
  const ownerSessionId = getStateSessionOwner(state);
  return !ownerSessionId || ownerSessionId === sessionId;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveStateRoot(directory?: string): string {
  const baseDir = directory || process.cwd();
  return getGitTopLevel(baseDir) || baseDir;
}

/**
 * Resolve the state file path for a given mode.
 * When sessionId is provided, returns the session-scoped path.
 * Otherwise returns the legacy (global) path.
 */
function resolveFile(mode: string, directory?: string, sessionId?: string): string {
  const baseDir = resolveStateRoot(directory);
  if (sessionId) {
    return resolveSessionStatePath(mode, sessionId, baseDir);
  }
  return resolveStatePath(mode, baseDir);
}

function getLegacyStateCandidates(mode: string, directory?: string): string[] {
  const baseDir = resolveStateRoot(directory);
  const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;

  return [
    resolveStatePath(mode, baseDir),
    join(getOmcRoot(baseDir), `${normalizedName}.json`),
  ];
}

function getRuntimeArtifactCandidates(mode: string, directory?: string, sessionId?: string): string[] {
  const baseDir = resolveStateRoot(directory);
  const stateRoot = join(getOmcRoot(baseDir), 'state');
  const artifactNames = [
    `${mode}-stop-breaker.json`,
    `${mode}-last-steer-at`,
    `${mode}-continue-steer.lock`,
  ];
  const candidateDirs = new Set<string>([stateRoot]);

  if (sessionId) {
    candidateDirs.add(join(stateRoot, 'sessions', sessionId));
  } else {
    for (const sid of listSessionIds(baseDir)) {
      candidateDirs.add(join(stateRoot, 'sessions', sid));
    }
  }

  return [...candidateDirs].flatMap((dir) => artifactNames.map((name) => join(dir, name)));
}


/**
 * Find session-scoped state files that belong to the requested session.
 *
 * Normally the state file lives under `.omc/state/sessions/{sessionId}/`.
 * When a file is stranded under a different session directory (for example
 * after session continuation or manual recovery), this scans all session
 * directories and returns any file whose embedded owner still matches the
 * requested session.
 */
export interface StateFileDiscovery {
  path: string;
  snapshot: string;
  state: Record<string, unknown>;
  ownerSessionId?: string;
  workflowRunId?: string;
  completedSessionId?: string;
  completionEvidencePath?: string;
}

function discoverStateFile(path: string, extra: Partial<StateFileDiscovery> = {}): StateFileDiscovery | null {
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    return {
      path,
      snapshot: JSON.stringify(state),
      state,
      ownerSessionId: getStateSessionOwner(state),
      workflowRunId: typeof state.workflowRunId === 'string' ? state.workflowRunId : undefined,
      ...extra,
    };
  } catch {
    return null;
  }
}

export function findSessionOwnedStateCandidates(
  mode: string,
  sessionId: string,
  directory?: string,
): StateFileDiscovery[] {
  const matches = new Map<string, StateFileDiscovery>();
  const baseDir = resolveStateRoot(directory);
  const expectedPath = resolveSessionStatePath(mode, sessionId, baseDir);
  const expected = discoverStateFile(expectedPath);
  if (expected) matches.set(expectedPath, expected);

  for (const sid of listSessionIds(baseDir)) {
    const candidatePath = resolveSessionStatePath(mode, sid, baseDir);
    const candidate = discoverStateFile(candidatePath);
    if (candidate?.ownerSessionId === sessionId) matches.set(candidatePath, candidate);
  }
  return [...matches.values()];
}

export function findSessionOwnedStateFiles(mode: string, sessionId: string, directory?: string): string[] {
  return findSessionOwnedStateCandidates(mode, sessionId, directory).map((candidate) => candidate.path);
}

/**
 * Find active session-scoped state files that are safe to treat as orphaned.
 *
 * A fresh `/cancel` invocation may run in a new Claude session id while the
 * state files that keep the Stop hook alive still live under the completed
 * session's directory.  We intentionally require durable completion evidence
 * (`.omc/sessions/{sessionId}.json`) before returning a sibling session's file
 * so active parallel sessions are not cleared just because their ids differ
 * from the caller's fresh cancel session.
 */
export function findCompletedSessionStateCandidates(
  mode: string,
  directory?: string,
  requesterSessionId?: string,
): StateFileDiscovery[] {
  const matches: StateFileDiscovery[] = [];
  const baseDir = resolveStateRoot(directory);

  for (const sid of listSessionIds(baseDir)) {
    if (requesterSessionId && sid === requesterSessionId) continue;
    const completionEvidencePath = join(getOmcRoot(baseDir), 'sessions', `${sid}.json`);
    if (!existsSync(completionEvidencePath)) continue;
    const candidatePath = resolveSessionStatePath(mode, sid, baseDir);
    const candidate = discoverStateFile(candidatePath, { completedSessionId: sid, completionEvidencePath });
    if (candidate?.state.active === true) matches.push(candidate);
  }
  return matches;
}

export function findCompletedSessionStateFiles(mode: string, directory?: string, requesterSessionId?: string): string[] {
  return findCompletedSessionStateCandidates(mode, directory, requesterSessionId).map((candidate) => candidate.path);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write mode state to disk.
 *
 * - Ensures parent directories exist.
 * - Writes with mode 0o600 (owner-only) for security.
 * - Adds `_meta` envelope with write timestamp.
 *
 * @returns true on success, false on failure
 */
export function writeModeState(
  mode: string,
  state: Record<string, unknown>,
  directory?: string,
  sessionId?: string,
): boolean {
  try {
    const baseDir = resolveStateRoot(directory);
    if (sessionId) {
      ensureSessionStateDir(sessionId, baseDir);
    } else {
      ensureOmcDir('state', baseDir);
    }
    const filePath = resolveFile(mode, directory, sessionId);
    // owner_pid is written at the top level (not only inside _meta) so external
    // hook scripts can perform process-liveness checks without parsing _meta.
    // Existing state shapes carry session_id at top level; owner_pid follows
    // the same convention. Readers that don't know the field ignore it.
    const ownerPid = typeof process.pid === 'number' ? process.pid : undefined;
    const envelope = {
      ...state,
      ...(ownerPid !== undefined && (state.owner_pid === undefined) ? { owner_pid: ownerPid } : {}),
      _meta: {
        written_at: new Date().toISOString(),
        mode,
        ...(sessionId ? { sessionId } : {}),
        ...(ownerPid !== undefined ? { ownerPid } : {}),
      },
    };
    return writeStateFileLocked(filePath, envelope);
  } catch {
    return false;
  }
}

/**
 * Read mode state from disk.
 *
 * When sessionId is provided, ONLY reads the session-scoped file (no legacy fallback)
 * to prevent cross-session state leakage.
 *
 * Strips the `_meta` envelope so callers get the original state shape.
 * Handles files written before _meta was introduced (no-op strip).
 *
 * @returns The parsed state (without _meta) or null if not found / unreadable.
 */
export function readModeState<T = Record<string, unknown>>(
  mode: string,
  directory?: string,
  sessionId?: string,
): T | null {
  const filePath = resolveFile(mode, directory, sessionId);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    // Strip _meta envelope if present
    if (parsed && typeof parsed === 'object' && '_meta' in parsed) {
      const { _meta: _, ...rest } = parsed;
      return rest as T;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

/**
 * Clear (delete) a mode state file from disk.
 *
 * When sessionId is provided:
 * 1. Deletes the session-scoped file.
 * 2. Ghost-legacy cleanup: also removes the legacy file if it belongs to
 *    this session or has no session_id (orphaned).
 *
 * @returns true on success (or file already absent), false on failure.
 */
export function clearModeStateFile(
  mode: string,
  directory?: string,
  sessionId?: string,
  expectedState?: Record<string, unknown>,
): boolean {
  let success = true;
  const baseDir = resolveStateRoot(directory);
  const unlinkIfPresent = (filePath: string): void => {
    if (!clearStateFileLocked(filePath)) success = false;
  };

  if (sessionId) {
    const directPath = resolveFile(mode, directory, sessionId);
    if (expectedState) {
      const expectedSnapshot = JSON.stringify(Object.fromEntries(Object.entries(expectedState).filter(([key]) => key !== '_meta')));
      const result = clearStateFileLockedIf(
        directPath,
        (current) => JSON.stringify(Object.fromEntries(Object.entries(current).filter(([key]) => key !== '_meta'))) === expectedSnapshot,
      );
      if (result === 'failed' || (result === 'skipped' && existsSync(directPath))) return false;
    } else {
      unlinkIfPresent(directPath);
    }
    for (const artifactPath of getRuntimeArtifactCandidates(mode, baseDir, sessionId)) {
      unlinkIfPresent(artifactPath);
    }
  } else if (expectedState) {
    const directPath = resolveFile(mode, directory);
    const expectedSnapshot = JSON.stringify(Object.fromEntries(Object.entries(expectedState).filter(([key]) => key !== '_meta')));
    const result = clearStateFileLockedIf(
      directPath,
      (current) => JSON.stringify(Object.fromEntries(Object.entries(current).filter(([key]) => key !== '_meta'))) === expectedSnapshot,
    );
    if (result === 'failed' || (result === 'skipped' && existsSync(directPath))) return false;
    for (const artifactPath of getRuntimeArtifactCandidates(mode, baseDir)) unlinkIfPresent(artifactPath);
  } else {
    for (const legacyPath of getLegacyStateCandidates(mode, baseDir)) unlinkIfPresent(legacyPath);
    for (const sid of listSessionIds(baseDir)) unlinkIfPresent(resolveSessionStatePath(mode, sid, baseDir));
    for (const artifactPath of getRuntimeArtifactCandidates(mode, baseDir)) unlinkIfPresent(artifactPath);
  }

  // Ghost-legacy cleanup: if sessionId provided, also check legacy path
  if (sessionId) {
    for (const legacyPath of getLegacyStateCandidates(mode, baseDir)) {
      if (!existsSync(legacyPath)) {
        continue;
      }

      try {
        const observed = JSON.parse(readFileSync(legacyPath, 'utf-8')) as Record<string, unknown>;
        if (!canClearStateForSession(observed, sessionId)) continue;
        const observedSnapshot = JSON.stringify(observed);
        const result = clearStateFileLockedIf(
          legacyPath,
          (current) => canClearStateForSession(current, sessionId) && JSON.stringify(current) === observedSnapshot,
        );
        if (result === 'failed') success = false;
      } catch {
        // Can't read/parse — leave it alone.
      }
    }
  }

  return success;
}
