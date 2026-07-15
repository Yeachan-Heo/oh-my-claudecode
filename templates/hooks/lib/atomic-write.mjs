/**
 * Atomic file writes for oh-my-claudecode hooks.
 * Self-contained module with no external dependencies.
 */

import { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, mkdirSync, existsSync, readFileSync, linkSync } from 'fs';
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

export function acquireStateFileLockSync(filePath, attempts = 50) {
  const lockPath = `${filePath}.mutation.lock`;
  ensureDirSync(dirname(filePath));
  if (!flockPath()) return { unlocked: true };
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

function writeEmergencyJournal(path, journal) {
  atomicWriteFileSync(path, JSON.stringify(journal, null, 2));
}

function readEmergencyJournal(path) {
  try {
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    if (journal.version !== 1 || typeof journal.transactionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(journal.transactionId) ||
      typeof journal.originalDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(journal.originalDigest) ||
      (journal.intent !== 'clear' && journal.intent !== 'publish') ||
      (journal.intent === 'publish' && (typeof journal.intendedDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(journal.intendedDigest))) ||
      typeof journal.quarantinePath !== 'string' ||
      (journal.phase !== 'prepared' && journal.phase !== 'quarantined' && journal.phase !== 'published')) return null;
    return journal;
  } catch { return null; }
}

/** Recover a previously interrupted emergency mutation. False means do not use the primary. */
export function recoverEmergencyStateFile(filePath) {
  const journalPath = emergencyJournalPath(filePath);
  if (!existsSync(journalPath)) return true;
  const journal = readEmergencyJournal(journalPath);
  if (!journal || journal.quarantinePath !== `${filePath}.emergency-quarantine.${journal.transactionId}`) return false;
  const hasPrimary = existsSync(filePath);
  const hasQuarantine = existsSync(journal.quarantinePath);
  const digest = (path) => {
    try { return stateDigest(readFileSync(path, 'utf8')); } catch { return null; }
  };
  const finalize = () => {
    try {
      if (hasQuarantine) unlinkSync(journal.quarantinePath);
      try { unlinkSync(`${journal.quarantinePath}.payload`); } catch { /* already removed */ }
      unlinkSync(journalPath);
      return true;
    } catch { return false; }
  };

  // Publication may have completed before its journal phase was persisted.
  if (hasPrimary && hasQuarantine) {
    if (journal.intent === 'publish' && digest(filePath) === journal.intendedDigest && digest(journal.quarantinePath) === journal.originalDigest) return finalize();
    // The visible primary is not our exact result. Preserve the original
    // quarantine for inspection, remove the blocking journal, and fail closed.
    try { renameSync(journal.quarantinePath, `${journal.quarantinePath}.preserved-${journal.transactionId}`); } catch { return false; }
    try { unlinkSync(journalPath); } catch { return false; }
    return false;
  }
  if (hasPrimary) {
    // A prepared journal has not made the primary undiscoverable. If it still
    // has the authenticated original bytes, finish the transaction; otherwise
    // it is a replacement and must not be touched.
    if (!hasQuarantine && journal.phase === 'prepared' && digest(filePath) === journal.originalDigest) {
      const payloadPath = `${journal.quarantinePath}.payload`;
      if (journal.intent === 'publish' && (!existsSync(payloadPath) || digest(payloadPath) !== journal.intendedDigest)) {
        try { unlinkSync(journalPath); return true; } catch { return false; }
      }
      try {
        renameSync(filePath, journal.quarantinePath);
        journal.phase = 'quarantined';
        writeEmergencyJournal(journalPath, journal);
        return recoverEmergencyStateFile(filePath);
      } catch { return false; }
    }
    return false;
  }
  if (!hasQuarantine) {
    // Clear publication is complete even if journal cleanup was interrupted.
    if (journal.intent === 'clear' && journal.phase === 'published') {
      try { unlinkSync(journalPath); return true; } catch { return false; }
    }
    return false;
  }
  if (digest(journal.quarantinePath) !== journal.originalDigest) return false;
  try {
    if (journal.intent === 'clear') {
      unlinkSync(journal.quarantinePath);
      unlinkSync(journalPath);
      return true;
    }
    const raw = readFileSync(journal.quarantinePath, 'utf8');
    // The intended bytes are stored in the quarantine only for clear; publish
    // recovery needs a persisted transformed payload alongside the journal.
    const payloadPath = `${journal.quarantinePath}.payload`;
    const payload = readFileSync(payloadPath, 'utf8');
    if (stateDigest(payload) !== journal.intendedDigest) return false;
    linkSync(payloadPath, filePath);
    unlinkSync(payloadPath);
    unlinkSync(journal.quarantinePath);
    unlinkSync(journalPath);
    void raw;
    return true;
  } catch { return false; }
}
