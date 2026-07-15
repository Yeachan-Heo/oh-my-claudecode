/**
 * Atomic file writes for oh-my-claudecode hooks.
 * Self-contained module with no external dependencies.
 */

import { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, mkdirSync, existsSync, readFileSync, linkSync, statSync } from 'fs';
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
    writeSync(fd, content, 0, 'utf-8');

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
function flockPath() { return process.env.NODE_ENV === 'test' && process.env.OMC_TEST_FLOCK_AVAILABLE === '0' ? null : existsSync('/usr/bin/flock') ? '/usr/bin/flock' : existsSync('/bin/flock') ? '/bin/flock' : null; }
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

function processStartIdentity(pid) {
  if (process.env.NODE_ENV === 'test' && process.env.OMC_TEST_EMERGENCY_PROCESS_START_UNKNOWN_PID === String(pid)) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform !== 'linux') return pid === process.pid ? String(Math.max(1, Math.floor(Date.now() - process.uptime() * 1000))) : null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return null;
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    return fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null;
  } catch (error) { return error?.code === 'ENOENT' ? 'absent' : null; }
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
  if (!flockPath()) return requireExclusive ? null : { unlocked: true };
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
      writeSync(fd, JSON.stringify(owner));
      fsyncSync(fd);
      linkSync(tempPath, lockPath);
      unlinkSync(tempPath);
      return { fd, lockPath, owner };
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      try { unlinkSync(tempPath); } catch {}
      if (error?.code !== 'EEXIST') return null;
      const disposition = guardedLockRemoval(lockPath, 'reclaim');
      if (disposition === 'unverifiable') {
        console.error(`[omc-lock] state_mutation_lock_unverifiable: ${lockPath}`);
        return null;
      }
      if (disposition === 'live') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return null;
}

export function acquireStateFileLockSync(filePath, attempts = 50) {
  return acquireLockAt(`${filePath}.mutation.lock`, attempts);
}

export function releaseStateFileLockSync(lock) {
  if (!lock || lock.unlocked) return;
  try { closeSync(lock.fd); } catch {}
  guardedLockRemoval(lock.lockPath, 'release', lock.owner);
}

export function withStateFileLockSync(filePath, callback) {
  const lock = acquireStateFileLockSync(filePath);
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

/** Publishes a complete, durable transaction file without exposing a partial final path. */
function publishEmergencyFileExclusive(path, content) {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    ensureDirSync(dirname(path));
    fd = openSync(tempPath, 'wx', 0o600);
    writeSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(tempPath, path);
    unlinkSync(tempPath);
    return true;
  } catch { return false; }
  finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(tempPath); } catch {}
  }
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

function acquireRecoveryClaim(path) {
  const processStart = processStartIdentity(process.pid);
  if (!processStart || processStart === 'absent') return null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const owner = { version: 1, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
    if (publishEmergencyFileExclusive(path, JSON.stringify(owner))) return owner;
    const observed = readRecoveryClaim(path);
    if (!observed) return null;
    const currentStart = processStartIdentity(observed.pid);
    if (currentStart === null || currentStart === observed.processStart) return null;
    const tombstone = `${path}.stale.${randomUUID()}`;
    try {
      renameSync(path, tombstone);
      const moved = readRecoveryClaim(tombstone);
      if (!moved || !sameRecoveryClaim(moved, observed)) {
        if (!existsSync(path)) renameSync(tombstone, path);
        return null;
      }
      unlinkSync(tombstone);
    } catch { return null; }
  }
  return null;
}

function releaseRecoveryClaim(path, owner) {
  try {
    const current = readRecoveryClaim(path);
    if (current && sameRecoveryClaim(current, owner)) unlinkSync(path);
  } catch { /* best-effort exact-owner release */ }
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
export function recoverEmergencyStateFile(filePath) {
  const journalPath = emergencyJournalPath(filePath);
  if (!existsSync(journalPath)) return true;
  const journal = readEmergencyJournal(journalPath);
  if (journal && (journal.quarantinePath !== `${filePath}.emergency-quarantine.${journal.transactionId}` || isEmergencyOwnerLive(journal.owner))) return false;
  const claimPath = `${filePath}.emergency-recovery.claim`;
  const claim = acquireRecoveryClaim(claimPath);
  if (!claim) return false;
  try {
    if (!journal) {
      const generation = fileIdentity(journalPath);
      if (!generation || readEmergencyJournal(journalPath) !== null || !existsSync(filePath) || !sameFile(journalPath, generation)) return false;
      unlinkSync(journalPath);
      return true;
    }
    const current = readEmergencyJournal(journalPath);
    if (!current || current.quarantinePath !== `${filePath}.emergency-quarantine.${current.transactionId}` || isEmergencyOwnerLive(current.owner)) return false;
    return recoverDeadEmergencyStateFile(filePath);
  } catch { return false; }
  finally { releaseRecoveryClaim(claimPath, claim); }
}

/** Recover a previously interrupted emergency mutation while holding the recovery claim. */
function recoverDeadEmergencyStateFile(filePath) {
  const journalPath = emergencyJournalPath(filePath);
  if (!existsSync(journalPath)) return true;
  const journal = readEmergencyJournal(journalPath);
  if (!journal || journal.quarantinePath !== `${filePath}.emergency-quarantine.${journal.transactionId}` || isEmergencyOwnerLive(journal.owner)) return false;
  const owned = () => journalIsOwned(journalPath, journal.transactionId, journal.owner);
  if (!owned()) return false;
  const payloadPath = `${journal.quarantinePath}.payload`;
  const digest = (path) => {
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
    return writeEmergencyJournal(journalPath, journal) && recoverDeadEmergencyStateFile(filePath);
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
        if (owned() && existsSync(filePath) && existsSync(journal.quarantinePath) && digest(filePath) !== originalDigest) {
          removeOwnedEmergencyArtifacts(journalPath, journal, true);
        }
        return false;
      }
      journal.phase = 'quarantined';
      return writeEmergencyJournal(journalPath, journal) && recoverDeadEmergencyStateFile(filePath);
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
