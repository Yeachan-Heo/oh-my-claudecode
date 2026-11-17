'use strict';
// Waiting for provider tasks, used by `provider-task wait`.
// Polls `omc team api list-tasks` with a growing pause of 500 ms up to 2 s (the pattern of waitForTeamJob in
// src/cli/team.ts). The evaluation (evaluateResult from task-result.cjs) is written durably to the task file
// BEFORE delivery; delivery happens exactly once through the `delivered` marker (a restarted wait does not
// deliver a second time); after delivery the task journal row is written (writeRow from provider-task-log.cjs).
// Every read and write of the task file goes under the lock `<id>.json.lock` (openSync 'wx', content
// { pid, ts }; a lock with a dead pid or older than 60 s is taken over; retries every 50 ms for 10 s, then an
// error; the lock is removed in finally only when it holds this pid; the write is atomic: a temp file in the
// same directory and rename), so `kill` and `wait` do not lose each other's fields.
// `limitS` (--limit S): total time limit counted from the `start` field of the task file; after it is exceeded
// `omc team shutdown <team> --force` runs (binary from OMC_PROVIDER_TASK_OMC_BIN) and the result is
// { status: 'failed', cause: 'timeout' }. Without limitS there is no limit.
// Limits of --timeout: min 10 s, default 30 s, max 3600 s; a value <= 0 or non-numeric is rejected (an Error
// with errorCode 2, the CLI exits with code 2).
// Order of resolving the state of a task: (a) killed in the task file gives a verdict at once through
// `evaluate` with the task file, also with a task in progress and with a missing OMC task; (b) an OMC task
// found gives the state from the task, also with start_exit_code != 0; (c) a missing OMC task with a start
// exit code other than 0 and null gives start_failed at once with the cause from the code (4 = quota), without
// grace; (d) a missing task with code 0/null goes through evaluateMissingTask (start-lock queue, grace,
// dead _start, queue ceiling). A failure of the `omc team api` call (exit code != 0, bad JSON) is not a
// missing task: waiting continues with a message on stderr. omc runs in the cwd of the task. A lock with
// unreadable content has its age from the mtime (taken over after 60 s).
// Signature: wait({ ids, timeoutS, any, limitS, env, profile, readTask, evaluate, writeJournal, taskFacts,
// workerStatus, now, sleep, sleepSync }) -> { results: [{ id, status, verified, error, handoff, cause }],
// in_progress, timed_out, handoff }.
const { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { loadProfile, statePath } = require('./profile.cjs');
const { evaluateResult, evaluateMissingTask } = require('./task-result.cjs');
const { EXIT, STATUSES, taskSubject } = require('./vocab.cjs');

// Limits of --timeout and polling pauses (the pattern of waitForTeamJob).
const TIMEOUT_DEFAULT_S = 30;
const TIMEOUT_MIN_S = 10;
const TIMEOUT_MAX_S = 3600;
const PAUSE_START_MS = 500;
const PAUSE_MAX_MS = 2000;
// Task file lock.
const LOCK_MAX_AGE_MS = 60_000;
const LOCK_PAUSE_MS = 50;
const LOCK_WAIT_MS = 10_000;
// OMC task statuses at which wait keeps waiting (TEAM_TASK_STATUSES except blocked/completed/failed; blocked
// ends the wait because a 'blocked' result must return to the lead, not hang).
const IN_PROGRESS_STATES = new Set(['pending', 'in_progress']);

const inputError = (text) => Object.assign(new Error(text), { errorCode: EXIT.CONFIG });
// Alive also when the process exists but belongs to another user (EPERM; ESRCH means not alive).
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return Boolean(e && e.code === 'EPERM'); } };

// Sleep: production waits for real; tests inject fakes (options now/sleep/sleepSync).
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepSyncDefault = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* without Atomics: do not wait */ } };

const omcBinary = (env) => env.OMC_PROVIDER_TASK_OMC_BIN || 'omc';

// Validation: a number of seconds > 0 (a numeric string is allowed); --timeout additionally clamped to
// [10, 3600] (<= 0 and non-numeric are rejected with code 2).
const seconds = (x, name) => {
  const n = typeof x === 'number' ? x : Number(String(x ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) throw inputError(`provider-task wait: ${name} must be a number of seconds greater than zero`);
  return n;
};
const timeoutClamp = (x) => Math.min(Math.max(seconds(x, '--timeout'), TIMEOUT_MIN_S), TIMEOUT_MAX_S);

const tasksDir = (profile, env) => statePath(profile, env, 'tasks');
const taskFilePath = (profile, env, id) => join(tasksDir(profile, env), `${id}.json`);

// Atomic write of the task file: a temp file in the same directory and rename.
const writeAtomic = (file, object) => {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, JSON.stringify(object, null, 2) + '\n');
  renameSync(tmp, file);
};

// One loop taking the task file lock; a lock with a dead pid or older than 60 s is taken over.
function takeLock(lock, o) {
  const begin = o.now();
  for (;;) {
    let fd;
    try { fd = openSync(lock, 'wx'); } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let m = null;
      try { m = JSON.parse(readFileSync(lock, 'utf8')); } catch { /* empty or corrupt (the gap between openSync and writeSync) */ }
      if (m && isAlive(m.pid) && o.now() - m.ts < LOCK_MAX_AGE_MS) {
        if (o.now() - begin >= LOCK_WAIT_MS) throw inputError(`provider-task wait: lock held for more than ${LOCK_WAIT_MS / 1000} s: ${lock}`);
        o.sleepSync(LOCK_PAUSE_MS);
        continue;
      }
      // A lock with unreadable content has its age from the mtime of the lock file; taken over only when older
      // than 60 s, otherwise waiting as for a live owner.
      if (!m) {
        let age = null;
        try { age = o.now() - statSync(lock).mtimeMs; } catch { /* the lock vanished: try again */ }
        if (age != null && age < LOCK_MAX_AGE_MS) {
          if (o.now() - begin >= LOCK_WAIT_MS) throw inputError(`provider-task wait: lock held for more than ${LOCK_WAIT_MS / 1000} s: ${lock}`);
          o.sleepSync(LOCK_PAUSE_MS);
          continue;
        }
      }
      try { unlinkSync(lock); } catch { /* another process took it over */ }
      continue;
    }
    try { writeSync(fd, JSON.stringify({ pid: process.pid, ts: o.now() })); } catch (e) { closeSync(fd); throw e; }
    return fd;
  }
}

// Read and change of the task file under the lock; the lock is removed in finally only when it holds this pid.
function withLock(ctx, id, fn) {
  mkdirSync(tasksDir(ctx.profile, ctx.env), { recursive: true });
  const file = taskFilePath(ctx.profile, ctx.env, id);
  const fd = takeLock(`${file}.lock`, ctx.o);
  try {
    let d = null;
    try { d = JSON.parse(readFileSync(file, 'utf8')); } catch { d = null; }
    return fn(d);
  } finally {
    closeSync(fd);
    let m = null;
    try { m = JSON.parse(readFileSync(`${file}.lock`, 'utf8')); } catch { /* foreign or corrupt */ }
    if (m && m.pid === process.pid) { try { unlinkSync(`${file}.lock`); } catch { /* taken over by another process */ } }
  }
}
// Read of the task file under the lock; null when the file is missing.
const readTaskFile = (ctx, id) => withLock(ctx, id, (d) => d);
// Change of own fields and an atomic write under the lock; change(d) returns the object to write or null (no write).
const changeTaskFile = (ctx, id, change) => withLock(ctx, id, (d) => {
  const next = change(d);
  if (d && next) writeAtomic(taskFilePath(ctx.profile, ctx.env, id), next);
  return next;
});

// Default read of the OMC task: task file under the lock -> real team name -> `omc team api list-tasks
// --input '{"team_name":...}' --json` and the task whose subject starts with the task subject (the start
// command begins the task subject with `ptask-<id> `; the OMC task_id does not follow from the task id).
// A failure of the omc call (exit code != 0, bad JSON) is NOT a missing task: it throws (wait keeps waiting
// with a message on stderr); null only for a successful read without a match (only then grace applies).
// The call runs in the cwd of the task.
const readTaskDefault = (ctx) => (id) => {
  const d = readTaskFile(ctx, id);
  if (!d || !d.team) return null;
  const w = spawnSync(omcBinary(ctx.env), ['team', 'api', 'list-tasks', '--input', JSON.stringify({ team_name: d.team }), '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: d.cwd || process.cwd() });
  if (w.status !== 0) throw new Error(`omc team api list-tasks ${d.team}: exit code ${w.status}${w.stderr ? `: ${w.stderr.trim().split('\n').at(-1)}` : ''}`);
  let answer = null;
  try { answer = JSON.parse(w.stdout); } catch { throw new Error(`omc team api list-tasks ${d.team}: output is not JSON`); }
  const tasks = answer && answer.ok && answer.data && Array.isArray(answer.data.tasks) ? answer.data.tasks : [];
  const subject = taskSubject(id);
  return tasks.find((t) => t && typeof t.subject === 'string' && (t.subject === subject || t.subject.startsWith(`${subject} `))) || null;
};

// Journal and facts defaults: writeRow / taskRow from provider-task-log.cjs; a missing module or a throw does not
// stop the command (the message on stderr comes from wait itself when the facts are unavailable or null).
const taskLogModule = () => {
  try { return require('../provider-task-log.cjs'); } catch { return null; }
};
const writeJournalDefault = (ctx) => {
  const m = taskLogModule();
  return m && typeof m.writeRow === 'function' ? (id) => m.writeRow(id, { env: ctx.env, profile: ctx.profile }) : null;
};
const taskFactsDefault = (ctx) => {
  const m = taskLogModule();
  return m && typeof m.taskRow === 'function' ? (id) => m.taskRow(id, { env: ctx.env, profile: ctx.profile }) : null;
};

// Worker status from `omc team api read-worker-status --input '{"team_name":...,"worker":...}' --json` (field
// data.status); a spawn failure or invalid JSON gives null. It does not read the heartbeat (tasks in progress
// are not evaluated). The call runs in the cwd of the task (third argument).
const workerStatusDefault = (env) => (team, owner, d) => {
  const w = spawnSync(omcBinary(env), ['team', 'api', 'read-worker-status', '--input', JSON.stringify({ team_name: team, worker: owner }), '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: (d && d.cwd) || process.cwd() });
  if (w.status !== 0) return null;
  try {
    const answer = JSON.parse(w.stdout);
    return answer && answer.ok && answer.data ? (answer.data.status ?? null) : null;
  } catch { return null; }
};

// Shutdown of the team after the limit; a shutdown failure does not change the limit result (a message on
// stderr, the failed/timeout result is always written). The call runs in the cwd of the task.
const shutdownSync = (env, team, d) => {
  const w = spawnSync(omcBinary(env), ['team', 'shutdown', team, '--force'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: (d && d.cwd) || process.cwd() });
  if (w.status) console.error(`provider-task wait: shutdown ${team} --force returned exit code ${w.status}${w.stderr ? `: ${w.stderr.trim().split('\n').at(-1)}` : ''}`);
};

// Waiting for provider tasks and one-time delivery of the result.
async function wait(options) {
  const env = options.env || process.env;
  const any = Boolean(options.any);
  const o = { now: options.now || Date.now, sleepSync: options.sleepSync || sleepSyncDefault };
  const sleep = options.sleep || sleepDefault;
  const timeout = options.timeoutS == null ? TIMEOUT_DEFAULT_S : timeoutClamp(options.timeoutS);
  let limit = options.limitS == null ? null : seconds(options.limitS, '--limit');
  // Use profile's task timeout as fallback when no explicit limit is supplied
  if (limit === null && options.profile === undefined) {
    const profileData = loadProfile(options.env || process.env).profile;
    if (profileData?.limits?.taskTimeoutSeconds) limit = profileData.limits.taskTimeoutSeconds;
  } else if (limit === null && options.profile?.limits?.taskTimeoutSeconds) {
    limit = options.profile.limits.taskTimeoutSeconds;
  }
  const ids = options.ids;
  if (!Array.isArray(ids) || !ids.length) throw inputError('provider-task wait: give at least one task id');
  const bad = ids.filter((x) => !/^[0-9a-f]{8}$/.test(x));
  if (bad.length) throw inputError(`provider-task wait: an id must be 8 characters [0-9a-f] (${bad.join(', ')})`);

  const profile = options.profile || loadProfile(env).profile;
  const ctx = { env, profile, o };
  const readTask = options.readTask || readTaskDefault(ctx);
  const evaluate = options.evaluate || ((a) => evaluateResult(a));
  const writeJournal = options.writeJournal === undefined ? writeJournalDefault(ctx) : options.writeJournal;
  // Data for the evaluation is injected (tests: fakes); by default the journal row and read-worker-status through omc.
  const taskFacts = options.taskFacts === undefined ? taskFactsDefault(ctx) : options.taskFacts;
  const workerStatus = options.workerStatus === undefined ? workerStatusDefault(env) : options.workerStatus;
  // Start-lock limit from the environment (OMC_PROVIDER_TASK_START_LOCK_LIMIT_MS), the default of
  // evaluateMissingTask otherwise (passing undefined = the default value of the function).
  const startLockLimitMs = Number(env.OMC_PROVIDER_TASK_START_LOCK_LIMIT_MS) > 0 ? Number(env.OMC_PROVIDER_TASK_START_LOCK_LIMIT_MS) : undefined;

  // The task file of every id must exist; --limit is written at once (limit_s) so other processes see it.
  for (const id of ids) {
    if (readTaskFile(ctx, id) === null) throw inputError(`provider-task wait: no task file ${taskFilePath(profile, env, id)}`);
  }
  if (limit != null) for (const id of ids) changeTaskFile(ctx, id, (d) => ({ ...d, limit_s: limit }));

  const deadline = o.now() + Math.round(timeout * 1000);
  const results = [];
  const pending = new Set(ids);
  let pauseMs = PAUSE_START_MS;

  // Delivery exactly once: the delivered marker under the lock; the journal only when this process delivered; its throw does not stop.
  const deliver = async (id) => {
    let delivered = false;
    changeTaskFile(ctx, id, (x) => { if (!x.delivered) { x.delivered = new Date(o.now()).toISOString(); delivered = true; } return x; });
    if (delivered && typeof writeJournal === 'function') {
      try { await writeJournal(id); } catch (e) { console.error(`provider-task wait: journal ${id}: ${e.message}`); }
    }
  };
  // Result row; verified: the evaluation has no errors (an imposed result, e.g. the limit, without validation: verified=false).
  const finish = async (id, result, fromEvaluation) => {
    pending.delete(id);
    const errors = Array.isArray(result.errors) ? result.errors : [];
    results.push({
      id,
      status: String(result.status || STATUSES.UNKNOWN),
      verified: fromEvaluation ? !errors.length : Array.isArray(result.errors) && !errors.length,
      error: [...errors, result.cause].filter(Boolean).join('; ') || '-',
      handoff: Boolean(result.handoff),
      cause: result.cause || null,
    });
    await deliver(id);
  };
  // Verdict: the evaluation is written BEFORE delivery under the lock, without overwriting a foreign one (a
  // parallel wait won); in_progress from the evaluation is not a verdict. Shared by: killed, finished tasks,
  // start_exit_code and the limit.
  const verdict = async (id, evaluation, fromEvaluation) => {
    if (!evaluation || evaluation.status === STATUSES.IN_PROGRESS) return;
    const accepted = changeTaskFile(ctx, id, (x) => { if (!x.verdict) { x.verdict = evaluation; x.verdict_ts = new Date(o.now()).toISOString(); } return x; });
    await finish(id, accepted && accepted.verdict ? accepted.verdict : evaluation, fromEvaluation);
  };

  while (o.now() < deadline) {
    for (const id of [...pending]) {
      const d = readTaskFile(ctx, id);
      if (!d) continue; // the task file vanished meanwhile: treat as in progress
      // A verdict already written (a restarted wait or another wait): finished from the file, no new evaluation.
      if (d.verdict) { await finish(id, d.verdict, Array.isArray(d.verdict.errors)); continue; }
      let task = null;
      // A failure of the read call (omc exit code != 0, bad JSON) is not a missing task: keep waiting (no
      // grace), a message on stderr; null from readTask is a successful read without a match.
      let readFailed = false;
      try { task = await readTask(id); } catch (e) { readFailed = true; console.error(`provider-task wait: reading task ${id}: ${e.message}`); }
      // killed always takes precedence and at once: a verdict from the task file through evaluate, also with a
      // pending/in_progress task and with a missing OMC task (before the limit and the grace).
      if (d.killed) {
        await verdict(id, await evaluate({ task, workerStatus: null, taskFile: d, facts: null }), true);
        continue;
      }
      // Finished (the state and evaluation come from the OMC task, also with start_exit_code != 0): evaluation
      // with data: the worker status from read-worker-status for the team from the task file and the owner of
      // the OMC task (without an owner, an error or bad JSON: null) and the facts from the journal (a missing
      // module, an exception or null: null and a message on stderr). The heartbeat is not read.
      if (task && !IN_PROGRESS_STATES.has(task.status)) {
        let status = null;
        if (typeof task.owner === 'string' && task.owner) {
          try { status = await workerStatus(d.team, task.owner, d); } catch (e) { console.error(`provider-task wait: ${id}: worker status: ${e.message}`); }
        }
        let facts = null;
        if (typeof taskFacts !== 'function') console.error(`provider-task wait: ${id}: journal facts unavailable (no task log module)`);
        else {
          try {
            facts = await taskFacts(id);
            if (facts == null) console.error(`provider-task wait: ${id}: no journal facts (taskRow returned null)`);
          } catch (e) { console.error(`provider-task wait: ${id}: journal facts: ${e.message}`); facts = null; }
        }
        await verdict(id, await evaluate({ task, workerStatus: status, taskFile: d, facts }), true);
        continue;
      }
      // A missing OMC task (successful read) with a start exit code other than 0 and null: start_failed at once,
      // without grace, with the cause from the code (4 = quota). Before the limit: the team did not start and shutdown has nothing to close.
      if (!task && !readFailed && typeof d.start_exit_code === 'number' && d.start_exit_code !== 0) {
        await verdict(id, await evaluate({ task: null, workerStatus: null, taskFile: d, facts: null }), true);
        continue;
      }
      // Total time limit, counted from the start field; after it is exceeded shutdown --force and a failed/timeout
      // result (delivered like any). The full shape of the evaluation with handoff: true (wait exits with code 2 and a HANDOFF line).
      if (limit != null && d.start) {
        const elapsed = (o.now() - Date.parse(d.start)) / 1000;
        if (Number.isFinite(elapsed) && elapsed > limit) {
          if (typeof d.team === 'string' && d.team) shutdownSync(env, d.team, d);
          else console.error(`provider-task wait: ${id}: time limit exceeded and the task file has no team name; shutdown skipped`);
          await verdict(id, { status: 'failed', cause: 'timeout', handoff: true, errors: ['total time limit exceeded'], gaps: null, required: null, unverified: null, evidence: null, points: null, escalation: null, heartbeat_age_s: null }, false);
        }
      }
      // The start-lock queue and grace are evaluated in one function, evaluateMissingTask: the queue and grace
      // leave the task in progress without a verdict (keep waiting), start_failed (dead _start, queue ceiling,
      // grace from omc_started_at or from start after 60 s) gives a verdict written and delivered like any. The
      // guard pending.has(id): after the timeout verdict in the same iteration the task is finished and gets no second result row.
      if (pending.has(id) && !task && !readFailed && d.start) {
        const startState = evaluateMissingTask(d, { now: o.now(), startLockLimitMs });
        if (startState.verdict) await verdict(id, startState.verdict, true);
      }
    }
    if (!pending.size) break;
    if (any && results.length) break; // --any: return at the first finished (the rest stay in progress)
    await sleep(pauseMs);
    pauseMs = Math.min(Math.floor(pauseMs * 1.5), PAUSE_MAX_MS);
  }
  // timed_out only when the time limits were actually reached; --any returns with tasks in progress BEFORE the deadline and timed_out is not true.
  return { results, in_progress: pending.size, timed_out: pending.size > 0 && o.now() >= deadline, handoff: results.some((w) => w.handoff) };
}

module.exports = { wait };
