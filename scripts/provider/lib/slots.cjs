// Session slots: a machine-wide limit on concurrently running provider sessions.
// A slot is a JSON file { pid, ts } in <stateDir>/slots. Dead owners, slots of this same pid
// (a previous life of a recycled pid) and corrupt or very old slots are removed while a slot is taken.
// Starts above the limit wait (polling) for profile.limits.slotWaitMs; 0 means refuse at once.
// Races between parallel starts are serialized by a lock file (O_EXCL, owner pid and timestamp inside).
const { closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } = require('node:fs');
const { join } = require('node:path');
const { ProfileError, statePath } = require('./profile.cjs');

const POLL_MS = 200;
const LOCK_MAX_AGE_MS = 60_000;
// Slots older than this are treated as stale: 24 days (24 * 86400 * 1000 ms).
const SLOT_MAX_AGE_MS = 24 * 86400_000;

// True when the process exists, including one owned by another user (EPERM).
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return Boolean(e && e.code === 'EPERM'); }
};

// Takes a slot for this process. Returns { ok: true, file, waitedMs } or { ok: false, reason }.
function acquireSlot(profile, env = process.env) {
  const limit = profile.limits.maxSessions;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1024) {
    throw new ProfileError('config', 'limits.maxSessions must be an integer from 1 to 1024');
  }
  const waitMs = profile.limits.slotWaitMs;
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new ProfileError('config', 'limits.slotWaitMs must be a number of ms >= 0');
  const dir = statePath(profile, env, 'slots');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const start = Date.now();
  const deadline = start + waitMs;
  for (;;) {
    const file = tryAcquireSlot(dir, limit);
    if (file) return { ok: true, file, waitedMs: Date.now() - start };
    if (Date.now() >= deadline) {
      return { ok: false, reason: `no free provider session slot (limit ${limit}); waited ${Date.now() - start} ms and the start was aborted` };
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
  }
}

// One attempt under the lock. Returns the slot file path, or null when the lock is held or no slot is free.
function tryAcquireSlot(dir, limit) {
  const lock = join(dir, '.lock');
  let fd;
  try {
    fd = openSync(lock, 'wx');
  } catch (e) {
    if (e && e.code !== 'EEXIST') throw e;
    let owner = null;
    try { owner = JSON.parse(readFileSync(lock, 'utf8')); } catch {
      // Empty or corrupt lock: check age before taking over (avoid race with fresh locks being written).
      let st = null;
      try { st = statSync(lock); } catch { /* vanished */ }
      if (st && Date.now() - st.mtimeMs < 1000) return null; // Fresh lock (less than 1 second old): assume it's being written
    }
    if (owner && alive(owner.pid) && Date.now() - owner.ts < LOCK_MAX_AGE_MS) return null;
    try { unlinkSync(lock); } catch { /* another process took it over */ }
    return null;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    const live = [];
    for (const name of readdirSync(dir)) {
      if (!/^slot-/.test(name)) continue;
      const file = join(dir, name);
      let slot = null;
      try { slot = JSON.parse(readFileSync(file, 'utf8')); } catch {
        try { unlinkSync(file); } catch { /* race */ }
        continue;
      }
      if (!alive(slot.pid) || slot.pid === process.pid || Date.now() - slot.ts > SLOT_MAX_AGE_MS) {
        try { unlinkSync(file); } catch { /* race */ }
        continue;
      }
      live.push(slot);
    }
    if (live.length >= limit) return null;
    const file = join(dir, `slot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    writeFileSync(file, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    return file;
  } finally {
    closeSync(fd);
    try { unlinkSync(lock); } catch { /* taken over by another process */ }
  }
}

// Releases a slot owned by this process. A slot with another pid (pid recycled during our life) stays.
function releaseSlot(file) {
  let slot = null;
  try { slot = JSON.parse(readFileSync(file, 'utf8')); } catch { return false; }
  if (!slot || slot.pid !== process.pid) return false;
  try { unlinkSync(file); return true; } catch { return false; }
}

module.exports = { acquireSlot, tryAcquireSlot, releaseSlot, SLOT_MAX_AGE_MS };
