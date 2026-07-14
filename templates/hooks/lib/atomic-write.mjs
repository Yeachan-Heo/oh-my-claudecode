/**
 * Atomic file writes for oh-my-claudecode hooks.
 * Self-contained module with no external dependencies.
 */

import { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, mkdirSync, existsSync, readFileSync, linkSync } from 'fs';
import { dirname, basename, join } from 'path';
import { randomUUID } from 'crypto';
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
function readLockOwner(path) {
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    const keys = Object.keys(owner).sort();
    return keys.length === 5 && keys.every((key, index) => key === ['createdAt', 'nonce', 'pid', 'processStart', 'version'][index]) && owner.version === 1 && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.processStart === 'string' && /^\d+$/.test(owner.processStart) && typeof owner.createdAt === 'string' && Number.isFinite(Date.parse(owner.createdAt)) && typeof owner.nonce === 'string' && /^[0-9a-f-]{36}$/i.test(owner.nonce) ? owner : null;
  } catch { return null; }
}
function ownerDisposition(owner) {
  if (process.platform === 'linux') {
    const current = processStartIdentity(owner.pid);
    if (current === 'absent') return 'retry';
    return current === null ? 'unverifiable' : current === owner.processStart ? 'live' : 'retry';
  }
  try { process.kill(owner.pid, 0); return 'live'; } catch (error) { return error?.code === 'ESRCH' ? 'retry' : 'unverifiable'; }
}
function sameOwner(left, right) { return !!left && left.pid === right?.pid && left.processStart === right?.processStart && left.nonce === right?.nonce; }
function acquireReclaimGuard(path) {
  const guardPath = `${path}.reclaim.guard`;
  const processStart = processStartIdentity(process.pid);
  if (!processStart || processStart === 'absent') return null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const owner = { version: LOCK_SCHEMA_VERSION, pid: process.pid, processStart, createdAt: new Date().toISOString(), nonce: randomUUID() };
    const tempPath = `${guardPath}.${process.pid}.${owner.nonce}.tmp`;
    let fd;
    try {
      fd = openSync(tempPath, 'wx', 0o600); writeSync(fd, JSON.stringify(owner)); fsyncSync(fd);
      linkSync(tempPath, guardPath); unlinkSync(tempPath);
      return { fd, lockPath: guardPath, owner };
    } catch (error) {
      if (fd !== undefined) try { closeSync(fd); } catch {}
      try { unlinkSync(tempPath); } catch {}
      if (error?.code !== 'EEXIST') return null;
      const existing = readLockOwner(guardPath);
      if (!existing || ownerDisposition(existing) !== 'retry') return null;
      try { unlinkSync(guardPath); } catch {}
    }
  }
  return null;
}
function releaseOwnedLockWithoutFlock(lockPath, owner) {
  const current = readLockOwner(lockPath);
  if (!current) return 'unverifiable';
  if (!sameOwner(current, owner)) return 'replaced';
  try { unlinkSync(lockPath); return 'retry'; } catch { return 'unverifiable'; }
}
function guardedLockRemoval(lockPath, operation, owner) {
  const flock = flockPath();
  if (flock) {
    const result = spawnSync(flock, ['-x', `${lockPath}.reclaim.guard`, process.execPath, '-e', LOCK_REMOVAL_SCRIPT, operation, lockPath, owner ? JSON.stringify(owner) : ''], { stdio: 'ignore', timeout: 2000 });
    if (result.status === 0) return 'retry';
    if (result.status === 2) return 'live';
    if (result.status === 4) return 'replaced';
    return 'unverifiable';
  }
  const guard = acquireReclaimGuard(lockPath);
  if (!guard) return 'unverifiable';
  try {
    const current = readLockOwner(lockPath);
    if (!current) return 'unverifiable';
    if (operation === 'release') return releaseOwnedLockWithoutFlock(lockPath, owner);
    const disposition = ownerDisposition(current);
    if (disposition !== 'retry') return disposition;
    try { unlinkSync(lockPath); return 'retry'; } catch { return 'unverifiable'; }
  } finally {
    try { closeSync(guard.fd); } catch {}
    releaseOwnedLockWithoutFlock(guard.lockPath, guard.owner);
  }
}

export function acquireStateFileLockSync(filePath, attempts = 50) {
  const lockPath = `${filePath}.mutation.lock`;
  ensureDirSync(dirname(filePath));
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
  if (!lock) return;
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
