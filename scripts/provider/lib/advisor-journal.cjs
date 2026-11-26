'use strict';
// Journal of advisor consultations (advisor.jsonl): explicit advice text and cost. Two rows per consultation:
// a `start` row appended before the claude process is launched and an `end` row with the result; refusals and start
// errors (before a launch attempt) have only an end row. A start without an end row (SIGKILL of the script or of the
// task group; after SIGKILL the script writes nothing) is an orphaned consultation, reported by the summary read.
// Appends are never read-modify-write: they run under a file lock (O_EXCL with the pid; taken over after a dead pid or
// after the lock is 300 s old, waiting up to 30 s), the file is 0600 and its directory 0700.
// Switch: OMC_PROVIDER_ADVISOR_JOURNAL=1 enables the protocol (two rows, the event parameter is required, advice text
// with retention); off by default. With the switch off the advisor script writes one metadata row (no type field),
// under the same lock, through appendRow.
// Event: a closed list EVENTS (plan, test-failure, final, other), a required call parameter (--event <value> or
// OMC_PROVIDER_ADVISOR_EVENT; --failure-no N only with test-failure). A value outside the list, or a missing one with
// the protocol on, is a refusal with exit code 2 (it does not depend on what the model says in prose).
// Start row fields: ts, type, consultation_id (job_id#number), job_id, task, worker, number (consultation number in the
// task), event, failure_no, input metadata (input_hash, size, files, shown, head, decision_chars, token) and diff_hash
// (SHA-256 of the diff at input time, used for the stale check). End row fields: ts, type, consultation_id, number,
// event, status (closed list STATUSES), duration_ms, question_chars, answer_chars, cost_usd, tokens_in, tokens_out,
// model_usage (the modelUsage result of --output-format json; nominal cost, no prices of its own), advice (full advice
// text, redacted of secrets, retention 30 days) and the verdict fields (verdict, citations_*, stale, token_ok, ...).
// Status groups for the summary read: delivered (ok, stale, invalid-citations, from-journal, stop), advice_unavailable
// (no-advice, empty-answer-on-zero-exit, no-verdict), refusals (refused-*, empty-question, bad-model, no-role) and
// errors (error, input-error, start-error, no-binary, timeout, aborted, json-error, response-error, queue-timeout,
// limit-error).
// Summary read: status() and the `status` mode (node advisor-journal.cjs status [--window-hours 5] [--path X]): share of
// delivered, refused, failed and unavailable consultations in the window (default 5 h), cost and tokens in the window,
// orphaned starts (over the whole file); no alarm. Retention: purge() removes the advice field from rows older than 30
// days (metadata stays), runs automatically at most once per 24 h (marker <journal>.retention) and by hand with the
// `purge [--days N]` mode. No network, no provider key, no model hard-coded.
const { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const { ADVISOR_STATUSES, ADVISOR_EVENTS } = require('./vocab.cjs');
const { loadProfile, statePath } = require('./profile.cjs');

const EVENTS = Object.values(ADVISOR_EVENTS);
// Closed list of statuses of an end row.
const STATUSES = Object.values(ADVISOR_STATUSES);
const S = ADVISOR_STATUSES;
const GROUPS = {
  delivered: [S.OK, S.STALE, S.INVALID_CITATIONS, S.FROM_JOURNAL, S.STOP],
  advice_unavailable: [S.NO_ADVICE, S.EMPTY_ANSWER_ON_ZERO_EXIT, S.NO_VERDICT],
  refusals: [S.REFUSED_LIMIT, S.REFUSED_MISSING_DECISION, S.REFUSED_PATH, S.BAD_MODEL, S.REFUSED_ENV, S.REFUSED_EVENT, S.EMPTY_QUESTION, S.REFUSED_TASK_LIMIT, S.NO_ROLE],
  errors: [S.ERROR, S.INPUT_ERROR, S.START_ERROR, S.NO_BINARY, S.TIMEOUT, S.ABORTED, S.JSON_ERROR, S.RESPONSE_ERROR, S.QUEUE_TIMEOUT, S.LIMIT_ERROR],
};
function statusGroup(status) {
  for (const [group, statuses] of Object.entries(GROUPS)) if (statuses.includes(status)) return group;
  return 'other';
}
// Rate-limit refusal: too_many_requests or a rate limit recognised in stderr or in the JSON result.
function isRateLimitRefusal(text) {
  return /too_many_request|rate.?limit/i.test(String(text || ''));
}
// Journal path: OMC_PROVIDER_ADVISOR_LOG_FILE wins, otherwise advisor.jsonl in the state directory of the profile.
function logPath(profile, env = process.env) {
  return env.OMC_PROVIDER_ADVISOR_LOG_FILE || statePath(profile || {}, env, 'advisor.jsonl');
}
// The switch lives in one place: OMC_PROVIDER_ADVISOR_JOURNAL=1.
function enabled(env = process.env) {
  return env.OMC_PROVIDER_ADVISOR_JOURNAL === '1';
}

// Event parameter: argv flags (--event <v> or --event=<v>; --failure-no <n> or =<n>) or the environment variable
// OMC_PROVIDER_ADVISOR_EVENT (set by the lead; the Bash guard refuses setting it inline from a worker).
// Returns { event, failure_no, rest } or { refusal: message }. A value outside the list, an empty flag value and
// --failure-no outside test-failure are refusals; a missing event is refused by the advisor script only when the
// protocol is on.
function parseEvent(argv, env = process.env) {
  const rest = [];
  let event = null;
  let failureNo = null;
  const valueOf = (a, name, i) => {
    if (a.includes('=')) return a.slice(name.length + 1);
    const v = argv[i + 1];
    if (v === undefined) return { missing: true };
    return String(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--event' || a.startsWith('--event=')) {
      const v = valueOf(a, '--event', i);
      if (v && v.missing) return { refusal: `--event without a value (allowed: ${EVENTS.join(', ')})` };
      event = String(v);
      if (!a.includes('=')) i++;
    } else if (a === '--failure-no' || a.startsWith('--failure-no=')) {
      const v = valueOf(a, '--failure-no', i);
      if (v && v.missing) return { refusal: '--failure-no without a value (a whole number, at least 1)' };
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) return { refusal: `--failure-no must be a whole number, at least 1, got ${JSON.stringify(v)}` };
      failureNo = n;
      if (!a.includes('=')) i++;
    } else rest.push(a);
  }
  if (!event && env && env.OMC_PROVIDER_ADVISOR_EVENT) event = String(env.OMC_PROVIDER_ADVISOR_EVENT);
  if (!event) return { event: null, failure_no: failureNo, rest };
  if (!EVENTS.includes(event)) return { refusal: `event ${JSON.stringify(event)} is outside the closed list (${EVENTS.join(', ')}); call aborted` };
  if (failureNo !== null && event !== ADVISOR_EVENTS.TEST_FAILURE) return { refusal: `--failure-no is allowed only with the ${ADVISOR_EVENTS.TEST_FAILURE} event; call aborted` };
  return { event, failure_no: failureNo, rest };
}

// Redaction of secrets in text fields: values of variables whose name contains TOKEN, KEY, SECRET, API_KEY or AUTH
// (at least 12 characters) are replaced by [REDACTED].
function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const w of Array.isArray(secrets) ? secrets : []) s = s.split(w).join('[REDACTED]');
  return s;
}

// --- File lock (O_EXCL with the pid and a timestamp, own CJS implementation): taken over after a dead pid
// (process.kill(pid, 0), EPERM = alive) or after the lock is 300 s old (a holder hung with a live pid); waiting in
// 50 ms steps up to 30 s, then the write is abandoned (throws; the advisor catches: a missing journal does not stop
// the consultation).
const TAKEOVER_AGE_MS = 300_000;
const WAIT_LIMIT_MS = 30_000;
const WAIT_STEP_MS = 50;
function holderAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function withLock(filePath, operation) {
  const lock = `${filePath}.lock`;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const waitStart = Date.now();
  for (;;) {
    let fd = null;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // The lock age is read with statSync in its own try (an empty or truncated file does not zero the age, so the
      // takeover after 300 s works for an empty lock too); the takeover is a rename to a unique name (atomic: two
      // waiters judging the same lock dead cannot remove the new lock of the other and enter the critical section together).
      let holder = null;
      try { holder = JSON.parse(readFileSync(lock, 'utf8')); } catch { holder = null; } // empty or truncated file: no holder
      let ageMs = 0;
      try { ageMs = Date.now() - statSync(lock).mtimeMs; } catch { continue; } // the lock vanished: a new loop
      const dead = holder && Number.isInteger(holder.pid) && !holderAlive(holder.pid);
      if (dead || ageMs > TAKEOVER_AGE_MS) {
        const name = `${lock}.takeover-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        try { renameSync(lock, name); unlinkSync(name); } catch { /* someone else removed or took it over */ }
        continue;
      }
      if (Date.now() - waitStart > WAIT_LIMIT_MS) throw new Error(`journal lock (${lock}): waited more than ${Math.round(WAIT_LIMIT_MS / 1000)} s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAIT_STEP_MS);
      continue;
    }
    // The owner is recognised by a token written into the lock, not by the inode: a file system hands the number of a removed file
    // to the next file it creates, so after a takeover the lock of the next owner can have the same inode as this one.
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let written = false;
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), token })); written = true; } catch { /* the lock is then left for the takeover rules */ }
    try { closeSync(fd); } catch { /* fd already closed */ }
    try {
      return operation();
    } finally {
      // Removed only while it still holds this process's token: after the takeover of a holder that hung for 300 s the file at this
      // path belongs to the next owner, whose critical section must not be opened by this late release.
      try { if (written && JSON.parse(readFileSync(lock, 'utf8')).token === token) unlinkSync(lock); } catch { /* release is best effort */ }
    }
  }
}

// Number of consultation starts of a task in the journal (the consultation number in the task = starts + 1).
function countStarts(filePath, jobId) {
  let text = '';
  try { text = readFileSync(filePath, 'utf8'); } catch { return 0; } // no file = no earlier consultations
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row = null;
    try { row = JSON.parse(line); } catch { continue; }
    if (row && row.type === 'start' && row.job_id === jobId) count++;
  }
  return count;
}

// Appending a row: with the protocol on, under the lock, with redaction of all text fields (not only the advice),
// chmod 0600 after the write (an existing file with other permissions gets 0600 on append too) and retention at most
// once per 24 h; with the protocol OFF the write has no lock and no retention. Throws on failure (the advisor
// catches it and writes a line about the unwritten journal).
function appendRow(filePath, row, { secrets = [] } = {}) {
  const redacted = (() => {
    if (!Array.isArray(secrets) || secrets.length === 0) return row;
    const w = { ...row };
    for (const [k, v] of Object.entries(w)) if (typeof v === 'string' && v) w[k] = redact(v, secrets);
    return w;
  })();
  const line = JSON.stringify(redacted) + '\n';
  if (!enabled()) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(filePath, 0o600); } catch { /* permissions are best effort */ }
    return true;
  }
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(filePath, 0o600); } catch { /* permissions are best effort */ }
  });
  if (retentionNeeded(filePath)) { try { purge(filePath, { days: RETENTION_DAYS }); } catch { /* retention is best effort */ } }
  return true;
}

// Opening a consultation: the consultation number in the task (starts of the task + 1, under the lock) and the start
// row with the input metadata and diff_hash; the metadata only on the start row (the state of the input), not on the
// end row. Returns { key, number }; throws on failure (the advisor catches: the consultation works without a journal too).
function openConsultation({ path, job_id, task = null, worker = null, event, failure_no = null, meta = null, diff_hash = null, model = null }) {
  const jobId = String(job_id ?? '');
  let number = 0;
  let key = null;
  withLock(path, () => {
    number = countStarts(path, jobId) + 1;
    key = `${jobId}#${number}`;
    const row = { type: 'start', ts: new Date().toISOString(), consultation_id: key, job_id: jobId || null, task, worker, number, event };
    if (model) row.model = model; // the model is part of the journal-hit key
    if (failure_no) row.failure_no = failure_no;
    if (meta && typeof meta === 'object') {
      for (const k of ['input_hash', 'size', 'files', 'shown', 'head', 'decision_chars', 'token']) if (meta[k] !== undefined && meta[k] !== null) row[k] = meta[k];
    }
    if (diff_hash) row.diff_hash = diff_hash;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* permissions are best effort */ }
  });
  if (retentionNeeded(path)) { try { purge(path, { days: RETENTION_DAYS }); } catch { /* retention is best effort */ } }
  return { key, number };
}

// --- Retention: full advice text is kept 30 days (starting value) ---
const RETENTION_DAYS = 30;
const RETENTION_EVERY_MS = 24 * 3600_000;
function retentionMarker(filePath) { return `${filePath}.retention`; }
// Retention is needed when the marker is missing or older than 24 h (now is a parameter for tests).
function retentionNeeded(filePath, now = Date.now()) {
  try { const m = JSON.parse(readFileSync(retentionMarker(filePath), 'utf8')); return !(typeof m.ts === 'number' && now - m.ts < RETENTION_EVERY_MS); } catch { return true; }
}
// Retention: removes the advice field from rows older than `days` (metadata stays for the summary read), rewrites the
// file through a 0600 temporary file and rename under the lock; returns { reviewed, removed }. Broken rows stay
// unchanged (no guessing). After a run the marker <journal>.retention is written.
function purge(filePath, { days = RETENTION_DAYS, now = Date.now() } = {}) {
  const boundary = now - days * 86400_000;
  return withLock(filePath, () => {
    let text = '';
    try { text = readFileSync(filePath, 'utf8'); } catch { return { reviewed: 0, removed: 0 }; }
    if (!text.trim()) return { reviewed: 0, removed: 0 };
    const kept = [];
    let removed = 0;
    let reviewed = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row = null;
      try { row = JSON.parse(line); } catch { kept.push(line); continue; } // broken rows stay
      reviewed++;
      const tsMs = Date.parse(row.ts);
      if (Number.isFinite(tsMs) && tsMs < boundary && 'advice' in row) { delete row.advice; removed++; }
      kept.push(JSON.stringify(row));
    }
    if (removed > 0) {
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      try {
        writeFileSync(tmp, kept.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, filePath);
      } finally { try { unlinkSync(tmp); } catch { /* the rename succeeded */ } }
    }
    try { writeFileSync(retentionMarker(filePath), JSON.stringify({ ts: Date.now() }) + '\n', { encoding: 'utf8', mode: 0o600 }); } catch { /* marker is best effort */ }
    return { reviewed, removed };
  });
}

// --- Summary read ---
// Rows without a type field are end rows (protocol off, or refusals before the start); type start = consultation start.
// Pairs by consultation_id; an orphaned consultation = a start without an end row (SIGKILL of the script or the group).
function readRows(filePath) {
  let text = '';
  try { text = readFileSync(filePath, 'utf8'); } catch { return { rows: [], broken: 0 }; }
  const rows = [];
  let broken = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { broken++; }
  }
  return { rows, broken };
}
function status({ path, windowHours = 5, now = Date.now() }) {
  const { rows, broken } = readRows(path);
  const boundary = now - windowHours * 3600_000;
  const pairs = new Map(); // consultation_id -> { start, end }
  const endsWithoutId = [];
  let duplicateEnds = 0;
  let hits = 0; // type='cache' rows (answer from the journal, no model call) are counted separately
  for (const w of rows) {
    if (w && w.type === 'cache') {
      const tsCache = Date.parse(w.ts);
      if (Number.isFinite(tsCache) && tsCache >= boundary && tsCache <= now) hits += 1;
      continue;
    }
    if (w && w.type === 'start') {
      if (!pairs.has(w.consultation_id)) pairs.set(w.consultation_id, { start: w, end: null });
      else pairs.get(w.consultation_id).start = w;
    } else if (w && w.consultation_id) {
      if (!pairs.has(w.consultation_id)) pairs.set(w.consultation_id, { start: null, end: w });
      else if (pairs.get(w.consultation_id).end) duplicateEnds++;
      else pairs.get(w.consultation_id).end = w;
    } else endsWithoutId.push(w || {});
  }
  const consultationTime = (p) => (p.start && Date.parse(p.start.ts)) || (p.end && Date.parse(p.end.ts)) || NaN;
  const inWindow = [];
  for (const p of pairs.values()) { const t = consultationTime(p); if (Number.isFinite(t) && t >= boundary && t <= now) inWindow.push(p); }
  for (const w of endsWithoutId) { const t = Date.parse(w.ts); if (Number.isFinite(t) && t >= boundary && t <= now) inWindow.push({ end: w }); }
  const stat = { consultations_total: inWindow.length, delivered: 0, refusals: 0, errors: 0, advice_unavailable: 0, other: 0, orphaned: 0, duplicate_ends: duplicateEnds, broken_rows: broken, cost_usd_total: 0, tokens_in_total: 0, tokens_out_total: 0, statuses: {}, events: {} };
  const bump = (map, k) => { map[k] = (map[k] || 0) + 1; };
  for (const p of inWindow) {
    const k = p.end;
    if (!k) continue; // orphaned starts are counted below over the whole file
    const st = typeof k.status === 'string' && k.status ? k.status : 'other';
    stat[statusGroup(st)] += 1;
    bump(stat.statuses, st);
    stat.cost_usd_total += Number(k.cost_usd) || 0;
    stat.tokens_in_total += Number(k.tokens_in) || 0;
    stat.tokens_out_total += Number(k.tokens_out) || 0;
    const event = k.event || (p.start && p.start.event) || null;
    if (event) bump(stat.events, event);
    if (!p.start) stat.end_without_start = (stat.end_without_start || 0) + 1; // an end without a start (should not happen)
  }
  // Orphaned starts: over the whole file (a start without an end row), not only in the window.
  for (const p of pairs.values()) if (p.start && !p.end) stat.orphaned += 1;
  stat.journal_hits = hits; // answers from the journal (no model call) in the window, outside the denominator of the shares
  const n = stat.consultations_total || 1;
  stat.delivered_pct = Math.round((stat.delivered / n) * 1000) / 10;
  stat.refusals_pct = Math.round((stat.refusals / n) * 1000) / 10;
  stat.errors_pct = Math.round((stat.errors / n) * 1000) / 10;
  stat.advice_unavailable_pct = Math.round((stat.advice_unavailable / n) * 1000) / 10;
  stat.ts = new Date().toISOString();
  stat.path = path;
  stat.window_hours = windowHours;
  return stat;
}

// --- CLI modes: status (summary read) and purge (manual retention); the advisor script calls the functions via require ---
function cliMode(argv) {
  const mode = String(argv[0] || '');
  if (mode !== 'status' && mode !== 'purge') return null;
  const option = (name, fallback) => {
    let v = fallback;
    for (let i = 1; i < argv.length; i++) {
      const a = String(argv[i]);
      if (a === `--${name}` && argv[i + 1] !== undefined) { v = argv[i + 1]; i++; }
      else if (a.startsWith(`--${name}=`)) v = a.slice(name.length + 3);
    }
    return v;
  };
  const numberOption = (name, fallback) => { const v = Number(option(name, fallback)); return Number.isFinite(v) && v > 0 ? v : fallback; };
  const defaultPath = () => {
    let profile = {};
    try { profile = loadProfile(process.env).profile; } catch { profile = {}; }
    return logPath(profile, process.env);
  };
  if (mode === 'status') {
    const path = String(option('path', defaultPath()));
    const windowHours = numberOption('window-hours', 5);
    process.stdout.write(JSON.stringify(status({ path, windowHours }), null, 2) + '\n');
    process.exit(0);
  }
  const path = String(option('path', defaultPath()));
  const days = numberOption('days', RETENTION_DAYS);
  const result = purge(path, { days });
  process.stdout.write(JSON.stringify({ mode: 'purge', path, days, ...result }) + '\n');
  process.exit(0);
}
if (require.main === module) cliMode(process.argv.slice(2));

// withLock and readRows are shared with advisor-limit.cjs (one file lock, one row reader); advisor-limit.cjs only requires them.
module.exports = { EVENTS, STATUSES, GROUPS, enabled, logPath, parseEvent, redact, isRateLimitRefusal, statusGroup, appendRow, openConsultation, status, purge, retentionNeeded, withLock, readRows };
