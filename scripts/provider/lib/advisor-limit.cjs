'use strict';
// Limit of advisor consultations per task and per group, plus a machine-wide FIFO queue for the shared top-model rate
// bucket. Library of the advisor (required from provider-advisor.cjs); no network, no provider key, no model hard-coded.
// Switch: enabled(): OMC_PROVIDER_ADVISOR_LIMIT=1 turns it on; off by default. Limits and parameters are environment
// variables with the OMC_PROVIDER_ADVISOR_ prefix (the Bash guard refuses setting them inline from a worker; the lead
// or the worker wrapper sets them); the defaults come from the profile (advisor.limits):
//   OMC_PROVIDER_ADVISOR_LIMIT_PER_TASK (default 4), OMC_PROVIDER_ADVISOR_LIMIT_PER_GROUP (default 4),
//   OMC_PROVIDER_ADVISOR_TOP_SLOTS (default 2), OMC_PROVIDER_ADVISOR_QUEUE_WAIT_MS (wait in the bucket queue, default
//   15000), OMC_PROVIDER_ADVISOR_LIMIT_FILE (path of the state file, for tests).
// State file: advisor-limit.json in the state directory (OMC_PROVIDER_ADVISOR_LIMIT_FILE wins), 0600, directory 0700.
// Every consultation call is a separate process, so the counter lives in the file, not in memory. All operations run
// under the file lock shared with advisor-journal.cjs (withLock: O_EXCL with the pid, taken over after a dead pid or
// after 300 s, waiting up to 30 s). Slot owner identity: the pid plus the process start time from /proc/<pid>/stat
// (field 19; zombie state Z = dead), so a reused pid does not take a slot from a live owner, and an orphaned slot
// (SIGKILL of the advisor or of the task group) returns to the pool at the next operation.
// A refusal does not raise the counter; a slot becomes permanent only after delivered advice (commit); the refund is
// idempotent on three error paths: a process start error, a non-zero exit code (including a rate-limit refusal) and
// a timeout. The FIFO queue: the first live waiter assigns itself a bucket slot in its own wait step; the 429 retry
// after Retry-After (default 2000 ms, at most 30000 ms) does not consume a consultation slot. The same question plus
// diff as in the last delivered consultation of the task (key: the SHA-256 input hash, stable without the verdict
// protocol, because the random control token breaks repeatability) gets the answer from the journal, without a model
// call and without a slot; a type='cache' row goes to the journal, counted separately by the summary read (outside the
// denominator of the shares). The worker gets the line "ADVISOR-LIMIT: n left" in the answer; after the limit is
// exhausted the consultation is refused without a model call, with a "what next" message naming the limit
// parameters, and a journal row with status refused-task-limit.
// CLI mode is read-only (`node advisor-limit.cjs status`); changes only go through the advisor script; the Bash guard
// refuses a direct advisor-limit call from a worker.
const { chmodSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const { randomUUID } = require('node:crypto');
const journal = require('./advisor-journal.cjs');
const { ADVISOR_STATUSES } = require('./vocab.cjs');
const { PROFILE_DEFAULTS, loadProfile, statePath } = require('./profile.cjs');

const DEFAULT_LIMITS = PROFILE_DEFAULTS.advisor.limits;
const QUEUE_WAIT_MS_DEFAULT = DEFAULT_LIMITS.queueWaitMs;
const STEP_MS_DEFAULT = 250;
const RETRY_MS_DEFAULT = 2_000;
const RETRY_MAX_MS = 30_000;

const enabled = (env = process.env) => env.OMC_PROVIDER_ADVISOR_LIMIT === '1';
const limitFile = (env = process.env, profile = null) => env.OMC_PROVIDER_ADVISOR_LIMIT_FILE || statePath(profile || {}, env, 'advisor-limit.json');
// Key of a task in the counters. Native task ids are only team-local (every team numbers its tasks from 1), so the bare id would let one team use up
// the allowance of the same id in another team. The key is qualified with the state root of the team and the team name; without an id there is no key.
const taskKey = ({ stateRoot = '', team = '', id = null } = {}) => (id === null || id === undefined || id === '' ? null : [String(stateRoot || ''), String(team || ''), String(id)].join('|'));
const positive = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
// Limits: the environment wins over the profile (advisor.limits), the profile over the built-in defaults.
const limits = (env = process.env, profile = null) => {
  const fromProfile = { ...DEFAULT_LIMITS, ...((profile && profile.advisor && profile.advisor.limits) || {}) };
  return {
    task: positive(env.OMC_PROVIDER_ADVISOR_LIMIT_PER_TASK) ?? fromProfile.perTask,
    group: positive(env.OMC_PROVIDER_ADVISOR_LIMIT_PER_GROUP) ?? fromProfile.perGroup,
    topSlots: positive(env.OMC_PROVIDER_ADVISOR_TOP_SLOTS) ?? fromProfile.topSlots,
  };
};

// Process start identity: field 19 of /proc/<pid>/stat (start time in ticks) and the process state (the field after
// ")"). Returns { start, state } or null (not recognised); start 'absent' = the process does not exist (ENOENT).
function startIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    const fields = end < 0 ? [] : stat.slice(end + 2).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] || '') ? { start: fields[19], state: fields[0] || '' } : null;
  } catch (e) {
    return e.code === 'ENOENT' ? { start: 'absent', state: '' } : null;
  }
}

// The slot owner is alive: the pid is alive (EPERM = alive, no permission), is not a zombie and has the recorded start
// identity. Not recognised (/proc unreadable, not Linux) counts as alive: a live owner never loses a slot (fail-safe).
function ownerAlive(pid, recordedStart) {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  const t = startIdentity(pid);
  if (!t) return true;
  if (t.start === 'absent' || t.state === 'Z') return false;
  if (recordedStart === undefined || recordedStart === null) return true;
  return t.start === String(recordedStart);
}

// Empty state; a broken file (not JSON) is read as empty (fail-open: the limit is a cost fuse, the counter data of a
// broken file is lost anyway; the work of the worker is not blocked).
const emptyState = () => ({ v: 1, tasks: {}, groups: {}, slots: [], top: [], queue: [] });
function readState(path) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    return s && typeof s === 'object' ? { ...emptyState(), ...s } : emptyState();
  } catch { return emptyState(); }
}
function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(state) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* the mode parameter covers creation */ }
}

// Reconciliation: a slot or queue entry with a dead owner (dead pid, zombie, other start identity) returns to the
// pool: a consultation slot gives back its reservation (reserved - 1), bucket and queue entries vanish, dead waiters
// are removed from the queue. Returns the number of recovered entries.
function recover(state) {
  const alive = (entry) => entry && entry.pid && ownerAlive(entry.pid, entry.start);
  let recovered = 0;
  const liveSlots = [];
  for (const s of state.slots || []) {
    if (alive(s)) { liveSlots.push(s); continue; }
    if (s.task !== null) { const l = state.tasks[s.task]; if (l && l.reserved > 0) l.reserved -= 1; } // key null: the dimension is skipped
    if (s.group !== null) { const l = state.groups[s.group]; if (l && l.reserved > 0) l.reserved -= 1; }
    recovered += 1;
  }
  state.slots = liveSlots;
  const liveTop = [];
  for (const s of state.top || []) { if (alive(s)) liveTop.push(s); else recovered += 1; }
  state.top = liveTop;
  const liveQueue = [];
  for (const o of state.queue || []) { if (alive(o)) liveQueue.push(o); else recovered += 1; }
  state.queue = liveQueue;
  return recovered;
}

// Remaining = the minimum of the task limit and the group limit after subtracting used and reserved, clipped to zero.
// A key may be null (no identifier): such a dimension is skipped (Infinity), so with no team the limit counts only
// the task and with a team only the proper keys; the result is Infinity only when both keys are empty (the advisor
// then does not call the limit at all).
function remaining(state, task, group, lim) {
  const left = (map, key, limitName) => (key === null ? Infinity : Math.max(0, lim[limitName] - ((map[key] || {}).used || 0) - ((map[key] || {}).reserved || 0)));
  return Math.min(left(state.tasks, task, 'task'), left(state.groups, group, 'group'));
}

// Expiry of task and group entries older than 7 days (the counter would never reset for the next task of the same
// worker otherwise). An entry with ts (a number set at every change) older than 7 days and without active reservations
// (reserved 0) is removed; entries without ts (old state files) stay.
const EXPIRY_MS = 7 * 86400_000;
function expire(state, now = Date.now()) {
  const filter = (map) => {
    for (const k of Object.keys(map)) {
      const w = map[k];
      if (typeof w.ts === 'number' && now - w.ts > EXPIRY_MS && !(w.reserved > 0)) delete map[k];
    }
  };
  filter(state.tasks);
  filter(state.groups);
}

// Remaining for a task and a group (a read under the lock with in-memory reconciliation, no write): the line
// "ADVISOR-LIMIT: n left" for an answer from the journal.
function remainingFor({ path, task = '', group = '', limits: lim = limits() } = {}) {
  if (!path) throw new Error('remainingFor: path missing');
  let result = 0;
  journal.withLock(path, () => {
    const state = readState(path);
    recover(state);
    result = remaining(state, task, group, lim);
  });
  return result;
}

// Reservation of a consultation slot (before the process is started): under the lock a reconciliation, then a refusal
// without changing the counters or a reservation (reserved + 1, a slot entry with the pid and the start identity).
// Returns { ok: true, id, left } or { ok: false, left: 0, reason: 'task'|'group' }.
function reserve({ path, task = null, group = null, limits: lim = limits() } = {}) {
  if (!path) throw new Error('reserve: path missing');
  let result = null;
  journal.withLock(path, () => {
    const state = readState(path);
    recover(state);
    expire(state);
    const left = remaining(state, task, group, lim);
    if (left <= 0) {
      const taskCounter = task === null ? { used: 0, reserved: 0 } : (state.tasks[task] || { used: 0, reserved: 0 });
      result = { ok: false, left: 0, reason: taskCounter.used + taskCounter.reserved >= lim.task ? 'task' : 'group' };
      return;
    }
    const id = randomUUID();
    const entry = { id, task, group, pid: process.pid, start: (startIdentity(process.pid) || {}).start || null, ts: new Date().toISOString() };
    if (task !== null) {
      const taskCounter = state.tasks[task] || { used: 0, reserved: 0 };
      taskCounter.reserved += 1;
      taskCounter.ts = Date.now();
      state.tasks[task] = taskCounter;
    }
    if (group !== null) {
      const groupCounter = state.groups[group] || { used: 0, reserved: 0 };
      groupCounter.reserved += 1;
      groupCounter.ts = Date.now();
      state.groups[group] = groupCounter;
    }
    state.slots.push(entry);
    writeState(path, state);
    result = { ok: true, id, left: remaining(state, task, group, lim) };
  });
  return result;
}

// Commit after delivered advice (the slot becomes permanent): used + 1, reserved - 1, the slot is removed from the
// list. Without a slot of that id it does nothing (idempotent). Returns { left } or null when there was no slot.
function commit({ path, id, limits: lim = limits() } = {}) {
  let leftAfter = null;
  if (!path || !id) return null;
  journal.withLock(path, () => {
    const state = readState(path);
    const i = (state.slots || []).findIndex((s) => s.id === id);
    if (i < 0) return;
    const s = state.slots[i];
    if (s.task !== null) {
      const taskCounter = state.tasks[s.task] || { used: 0, reserved: 0 };
      taskCounter.used += 1;
      if (taskCounter.reserved > 0) taskCounter.reserved -= 1;
      taskCounter.ts = Date.now();
      state.tasks[s.task] = taskCounter;
    }
    if (s.group !== null) {
      const groupCounter = state.groups[s.group] || { used: 0, reserved: 0 };
      groupCounter.used += 1;
      if (groupCounter.reserved > 0) groupCounter.reserved -= 1;
      groupCounter.ts = Date.now();
      state.groups[s.group] = groupCounter;
    }
    state.slots.splice(i, 1);
    writeState(path, state);
    leftAfter = { left: remaining(state, s.task, s.group, lim) };
  });
  return leftAfter;
}

// Refund of a slot on the error paths, idempotent: only an existing slot, a double refund does not lower the counter.
function refund({ path, id } = {}) {
  let refunded = false;
  if (!path || !id) return false;
  journal.withLock(path, () => {
    const state = readState(path);
    const i = (state.slots || []).findIndex((s) => s.id === id);
    if (i < 0) return;
    const s = state.slots[i];
    if (s.task !== null) {
      const taskCounter = state.tasks[s.task] || { used: 0, reserved: 0 };
      if (taskCounter.reserved > 0) taskCounter.reserved -= 1;
      taskCounter.ts = Date.now();
      state.tasks[s.task] = taskCounter;
    }
    if (s.group !== null) {
      const groupCounter = state.groups[s.group] || { used: 0, reserved: 0 };
      if (groupCounter.reserved > 0) groupCounter.reserved -= 1;
      groupCounter.ts = Date.now();
      state.groups[s.group] = groupCounter;
    }
    state.slots.splice(i, 1);
    writeState(path, state);
    refunded = true;
  });
  return refunded;
}

// Machine-wide FIFO queue for the top-model bucket: every waiter polls in steps; the slot goes to the first live
// waiter of the queue (order of appending), so nobody jumps ahead of one who waited longer. Dead waiters are removed
// (recover). The slot is held until releaseTop. Returns { ok: true, id } or { ok: false } after waitMs.
function waitForTop({ path, limits: lim = limits(), waitMs = QUEUE_WAIT_MS_DEFAULT, stepMs = STEP_MS_DEFAULT } = {}) {
  if (!path) throw new Error('waitForTop: path missing');
  const me = { id: randomUUID(), pid: process.pid, start: (startIdentity(process.pid) || {}).start || null, ts: new Date().toISOString() };
  const waitStart = Date.now();
  for (;;) {
    let assigned = false;
    journal.withLock(path, () => {
      const state = readState(path);
      recover(state);
      const queue = state.queue || [];
      const idx = queue.findIndex((o) => o.id === me.id);
      if ((state.top || []).length < lim.topSlots) {
        if (idx > 0) return; // live waiters ahead of me: wait (FIFO)
        if (idx === 0) state.queue = queue.slice(1); // I leave the queue and take the slot
        else if (queue.length > 0) { // a free slot and a non-empty queue without me: I append myself at the end
          // and do not jump ahead of one who waited longer
          state.queue = [...queue, me];
          writeState(path, state);
          return;
        }
        state.top.push({ id: me.id, pid: me.pid, start: me.start, ts: me.ts });
        writeState(path, state);
        assigned = true;
        return;
      }
      if (idx < 0) { // slots taken: put me into the queue
        state.queue = [...queue, me];
        writeState(path, state);
      }
    });
    if (assigned) return { ok: true, id: me.id };
    if (Date.now() - waitStart > waitMs) {
      journal.withLock(path, () => { // failure: remove my entry from the queue
        const state = readState(path);
        const before = (state.queue || []).length;
        state.queue = (state.queue || []).filter((o) => o.id !== me.id);
        if ((state.queue || []).length !== before) writeState(path, state);
      });
      return { ok: false };
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stepMs);
  }
}

// Release of the bucket slot after the consultation ends (also on an error), idempotent.
function releaseTop({ path, id } = {}) {
  if (!path || !id) return false;
  let released = false;
  journal.withLock(path, () => {
    const state = readState(path);
    const j = (state.top || []).findIndex((o) => o.id === id);
    if (j < 0) return;
    state.top.splice(j, 1);
    writeState(path, state);
    released = true;
  });
  return released;
}

// Closing the slots at the end of a consultation: a commit when the advice was delivered (ok, stale,
// invalid-citations), a refund otherwise; the bucket slot is always released. Without slots it does nothing. Returns
// { left } (after the operation) or null when there were no slots. The advisor script calls it from its end function.
function closeSlots({ path, consultation = null, top = null, commit: doCommit = false, limits: lim = limits() } = {}) {
  if (!consultation && !top) return null;
  if (!path) throw new Error('closeSlots: path missing');
  let result = null;
  journal.withLock(path, () => {
    const state = readState(path);
    recover(state);
    let idTask = null;
    let idGroup = null;
    if (consultation) {
      const idK = consultation.id || consultation;
      const i = (state.slots || []).findIndex((s) => s.id === idK);
      if (i >= 0) {
        const s = state.slots[i];
        idTask = s.task;
        idGroup = s.group;
        if (s.task !== null) { // key null: no identifier, the dimension is skipped
          const taskCounter = state.tasks[s.task] || { used: 0, reserved: 0 };
          if (doCommit) taskCounter.used += 1;
          if (taskCounter.reserved > 0) taskCounter.reserved -= 1;
          taskCounter.ts = Date.now();
          state.tasks[s.task] = taskCounter;
        }
        if (s.group !== null) {
          const groupCounter = state.groups[s.group] || { used: 0, reserved: 0 };
          if (doCommit) groupCounter.used += 1;
          if (groupCounter.reserved > 0) groupCounter.reserved -= 1;
          groupCounter.ts = Date.now();
          state.groups[s.group] = groupCounter;
        }
        state.slots.splice(i, 1);
      }
    }
    if (top) {
      const idO = top.id || top;
      const j = (state.top || []).findIndex((o) => o.id === idO);
      if (j >= 0) state.top.splice(j, 1);
    }
    writeState(path, state);
    result = { left: remaining(state, idTask, idGroup, lim) };
  });
  return result;
}

// 429 retry: the delay in ms from Retry-After (only the form of a number of seconds, also "Ns"; the HTTP date form
// gives no number: after the header name stands text, so the pattern needs a digit right after the `:` or `=`
// separator), at least 1000 ms, 2000 ms by default, at most 30000 ms. A rate-limit refusal is recognised by
// isRateLimitRefusal from advisor-journal.cjs (/too_many_request|rate.?limit/i).
function retryDelayMs(text) {
  const m = /retry.?after\s*[=:]\s*(\d{1,5})/i.exec(String(text || ''));
  const seconds = m ? Number(m[1]) : null;
  if (!seconds) return RETRY_MS_DEFAULT;
  return Math.min(RETRY_MAX_MS, Math.max(1000, seconds * 1000));
}

// An answer from the journal without a model call: the last pair (start + end) of this job_id with a delivered status
// (ok, stale, invalid-citations) and the input hash on the start row; the advice text comes from the end row (written
// by the journal, redacted of secrets at write time). The key includes the model (compared with the model field of the
// start row), so after a model change the advice of another model does not come back; a start row without a model
// field (old rows) does not match when a model is given. Returns { advice, source_id, ts } or null.
function findInJournal({ path, jobId, inputHash, model = null }) {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  const pairs = new Map();
  let best = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let w = null;
    try { w = JSON.parse(line); } catch { continue; }
    if (!w || w.type === 'cache') continue; // hit rows are not a source of advice
    if (w.type === 'start' && w.job_id === jobId && w.input_hash === inputHash && (model === null || w.model === model)) { pairs.set(w.consultation_id, { start: w, end: null }); continue; }
    if (w.type === 'end' && w.consultation_id) { const p = pairs.get(w.consultation_id); if (p) p.end = w; continue; }
  }
  for (const p of pairs.values()) {
    const k = p.end;
    if (!k || ![ADVISOR_STATUSES.OK, ADVISOR_STATUSES.STALE, ADVISOR_STATUSES.INVALID_CITATIONS].includes(k.status) || typeof k.advice !== 'string' || !k.advice) continue;
    const ts = Date.parse(k.ts);
    if (!best || (Number.isFinite(ts) && ts > best.ts)) best = { advice: k.advice, source_id: k.consultation_id, ts };
  }
  return best;
}

// A hit row (type='cache') in the journal: a trace of the use without the advice text (the text is not copied);
// the summary read counts these separately as journal_hits, outside the denominator of the shares.
function appendHit({ path, jobId, task = null, worker = null, inputHash, source_id, answer_chars, secrets = [] }) {
  return journal.appendRow(path, {
    type: 'cache', ts: new Date().toISOString(), job_id: jobId, task, worker, input_hash: inputHash, source_id, status: ADVISOR_STATUSES.FROM_JOURNAL, answer_chars,
  }, { secrets });
}

// Summary of the limit (CLI status mode, read-only; changes only go through the advisor script).
function limitStatus({ path, limits: lim = limits() } = {}) {
  const state = readState(path);
  recover(state);
  const sum = (map) => Object.entries(map).map(([k, v]) => ({ key: k, used: v.used || 0, reserved: v.reserved || 0 }));
  return { limits: lim, tasks: sum(state.tasks), groups: sum(state.groups), top_taken: (state.top || []).length, queue: (state.queue || []).length, path, ts: new Date().toISOString() };
}

// --- CLI mode: status only (read); writes only through the advisor script; the Bash guard refuses advisor-limit from a worker ---
function cliMode(argv, env = process.env) {
  const mode = String(argv[0] || '');
  if (mode !== 'status') return null;
  let profile = {};
  try { profile = loadProfile(env).profile; } catch { profile = {}; }
  let path = limitFile(env, profile);
  for (let i = 1; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--path' && argv[i + 1]) { path = String(argv[i + 1]); i++; }
    else if (a.startsWith('--path=')) path = a.slice(7);
  }
  process.stdout.write(JSON.stringify(limitStatus({ path, limits: limits(env, profile) }), null, 2) + '\n');
  process.exit(0);
}
if (require.main === module) cliMode(process.argv.slice(2));

module.exports = { enabled, limitFile, taskKey, limits, startIdentity, ownerAlive, remaining, remainingFor, reserve, commit, refund, waitForTop, releaseTop, closeSlots, retryDelayMs, findInJournal, appendHit, limitStatus, cliMode, withLock: journal.withLock };
