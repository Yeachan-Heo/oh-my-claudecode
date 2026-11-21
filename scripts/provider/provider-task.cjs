#!/usr/bin/env node
'use strict';
// provider-task: lifecycle of one provider task on top of `omc team`. A task is a team of one worker of the
// `executor` role started through provider-team; the worker runs on the provider of the profile.
// Subcommands: doctor | start | status | result | kill | list | wait (and the internal `_start`).
//
// doctor: a smoke test of the provider executor: `claude -p "Reply with just: ok" --output-format json` with
// the settings of a provider worker (the provider env block without the key in the file, the Bash guard, the
// shims, the subagent model, no MCP). The model and effort come from the profile (worker.model, worker.effort).
// Exit codes: 0 the answer came from the expected model (the id of that model in the profile, with or without
// the suffix [1m]); 4 quota exhausted (failure class quota: a pause, not a configuration error); 3 no key;
// 2 bad configuration (bad model or effort, bad base URL, an answer from another model); 127 no usable claude
// binary; 1 any other failure of the executor (also a plain 429, class throttle). The key is never printed.
//
// Task model. The id is 8 characters [0-9a-f] (the start of a random UUID); the team name comes from the task text
// through slugifyTask (a copy of the function of the `omc team` command); the task text starts with `ptask-<id> `.
// The task file is <stateDir>/tasks/<id>.json. Every read, change and write of it goes under the lock
// <id>.json.lock: a dead owner is taken over, retries every 50 ms up to 10 s, the write is atomic (temp file in the
// same directory and rename), the lock is removed in finally only when it holds this pid. A lock with unreadable
// content has its age from the mtime of the lock file and is taken over after 60 s.
// Exit codes of the lifecycle subcommands: 0 ok; 2 bad configuration, bad arguments or usage; 3 no free session
// slot; 4 quota gate refusal; 1 a failed run (also a lock held longer than the limit).
//
// start [--cwd DIR] [--brief FILE] [--max-tool-calls N] [--] TEXT: quota gate (refusal: exit 4), a check of a free
// session slot without taking it (none: exit 3), the task file, then a detached `_start` process; prints the id at
// once. `_start` takes the start lock <stateDir>/locks/start-<sha1(realpath cwd)>.lock (starts in one directory do
// not run in parallel), records omc_started_at, runs provider-team with `1:claude:executor --no-decompose TEXT`,
// confirms the real team name from the team state directory and records start_exit_code and start_error (the last
// stderr line through the redaction; null on exit code 0). The start lock limit is counted from the ts of the owner
// in the lock (a change of the owner restarts the count); a live owner over the limit does not start a parallel
// start: start_exit_code 1 and start_error "start lock: process <pid> held the lock for more than <N> s".
// status ID: JSON { id, team, ..., status, worker, task }. The order: killed; the OMC task found (also with
// start_exit_code != 0); a failed `omc team api` call is not a missing task (in_progress with a message on stderr);
// start_exit_code other than 0 and null: start_failed at once; otherwise the missing-task evaluation of the result
// module (queue, grace, a dead _start, the queue ceiling) gives pending or start_failed.
// result ID: the evaluation of the result module with the facts of the task journal and the heartbeat of the worker;
// the verdict is written to the task file BEFORE it is printed and without overwriting a verdict of a parallel
// process (one verdict per task); in_progress is not a verdict.
// kill ID: records killed in the task file, then `omc team shutdown <team> --force`.
// list [--refresh]: all task files with their status.
// wait ID... [--timeout S] [--any] [--limit S]: see lib/task-wait.cjs; exit 2 on a handoff line, 1 at the time limits, 0 otherwise.
// Without --limit the limit is limits.taskTimeoutSeconds of the profile.
//
// Test variables (loopback and fakes only): OMC_PROVIDER_TASK_OMC_BIN (fake omc), OMC_PROVIDER_TASK_TEAM_BIN (fake
// provider-team), OMC_PROVIDER_TASK_RESULT_MODULE and OMC_PROVIDER_TASK_LOG_MODULE (injected modules),
// OMC_PROVIDER_TASK_LOCK_LIMIT_MS (lock limit), OMC_PROVIDER_TASK_START_LOCK_LIMIT_MS (start lock limit),
// OMC_PROVIDER_TASK_POLL_MS (poll of the team name in _start), OMC_PROVIDER_TASK_NOW (clock of the grace period in
// status and result, ms or ISO), OMC_PROVIDER_CLAUDE_BIN (real or fake claude for doctor).
const { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, closeSync, writeFileSync, writeSync, unlinkSync, statSync, realpathSync, chmodSync } = require('node:fs');
const { spawnSync, spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { dirname, join, resolve } = require('node:path');
const { ProfileError, loadProfile, statePath } = require('./lib/profile.cjs');
const { executorEnv, isForeignProvider } = require('./lib/env.cjs');
const { mask } = require('./lib/redact.cjs');
const settingsLib = require('./lib/settings.cjs');
const { gate } = require('./lib/quota.cjs');
const { SLOT_MAX_AGE_MS } = require('./lib/slots.cjs');
const { failureClass } = require('./lib/failure-class.cjs');
const { CAUSES, EXIT, FAILURE_CLASSES, STATUSES, taskSubject } = require('./lib/vocab.cjs');
const { resolveOmcStateRoot } = require('../lib/state-root.cjs');

const fail = (code, text) => { console.error(`provider-task: ${mask(text)}`); process.exit(code); }; // messages go through the redaction
const argv = process.argv.slice(2);
const self = realpathSync(process.argv[1]);
const env = process.env;
const helperPath = join(__dirname, 'provider-key-helper.cjs');

// The profile is loaded when a subcommand needs it (after its own argument checks).
let loaded = null;
const profileOf = () => {
  if (loaded) return loaded.profile;
  try { loaded = loadProfile(env); } catch (e) {
    if (e instanceof ProfileError) fail(e.exit, e.message);
    throw e;
  }
  return loaded.profile;
};
const tasksDir = () => statePath(profileOf(), env, 'tasks');
const taskPath = (id) => join(tasksDir(), `${id}.json`);

// All calls of omc go through one function; the binary comes from the environment (tests).
function callOmc(e, args, options = {}) {
  return spawnSync(e.OMC_PROVIDER_TASK_OMC_BIN || 'omc', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
}
// The command that starts a team: the fake of the tests, otherwise provider-team next to this script.
const teamCommand = (e) => (e.OMC_PROVIDER_TASK_TEAM_BIN ? [e.OMC_PROVIDER_TASK_TEAM_BIN] : [process.execPath, join(__dirname, 'provider-team.cjs')]);
// Clock injected by OMC_PROVIDER_TASK_NOW (ms or ISO): the grace period of a missing OMC task in status and result
// can be tested without sleeping. Without the variable, or with a bad value, Date.now().
const nowMs = (e) => {
  const t = e.OMC_PROVIDER_TASK_NOW;
  if (t === undefined || t === '') return Date.now();
  const n = Number(t);
  if (Number.isFinite(n) && String(t).trim() !== '') return n;
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : Date.now();
};
// The OMC task of a provider task: its subject is `ptask-<id>` or starts with `ptask-<id> `.
const matchTask = (id, list) => (Array.isArray(list) ? list : []).find((t) => t && typeof t.subject === 'string' && (t.subject === taskSubject(id) || t.subject.startsWith(`${taskSubject(id)} `)));

// Team name: a copy of slugifyTask of src/cli/commands/team.ts (CommonJS cannot import TypeScript without a build).
// Mirrors src/cli/commands/team.ts
function slugifyTask(task) {
  const compact = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return compact.slice(0, 30).replace(/^-|-$/g, '') || 'team-task';
}
// Directory with the team states: <omc root>/state/team (the omc root from resolveOmcStateRoot, as getOmcRoot in the team command).
async function teamStateDir(cwd) {
  return join(await resolveOmcStateRoot(cwd), 'state', 'team');
}
// Free team name: the pattern of resolveAvailableTeamName of src/cli/commands/team.ts over the team state directory;
// the first free candidate: the base slug, then the base with -2..-99 appended.
// Mirrors src/cli/commands/team.ts
async function freeTeamName(text, cwd) {
  const base = slugifyTask(text);
  const taken = new Set();
  let entries = [];
  try { entries = readdirSync(await teamStateDir(cwd)); } catch { entries = []; }
  for (const name of entries) if (/^[a-z0-9][a-z0-9-]*$/.test(name)) taken.add(name);
  if (!taken.has(base)) return base;
  for (let s = 2; s <= 99; s++) {
    const ending = `-${s}`;
    const candidate = `${base.slice(0, 30 - ending.length).replace(/-$/g, '')}${ending}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 30).replace(/-$/g, '')}-99`;
}

// Lock of the task file (see the header). The limit of the lock and of the team-name poll can be shortened by test variables.
const LOCK_MAX_AGE_MS = 60_000;
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return Boolean(e && e.code === 'EPERM'); } };
// Start time of a process from /proc/<pid>/stat (field 22; after the last ')' the fields count from the state = field 3,
// so the start time has index 19); null when the process is missing or the read fails. Stored by `start` (start_pid_starttime);
// the liveness check of a _start process in the missing-task evaluation has its own copy.
const readStarttime = (pid) => {
  try {
    const t = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(t.slice(t.lastIndexOf(')') + 2).split(' ')[19]);
  } catch { return null; }
};
// Start lock limit from the environment, 300 s by default. A literal copy of START_LOCK_LIMIT_MS of lib/task-result.cjs: this script must not
// require the evaluation module before it checks that the module is available.
const startLockLimitMs = (e) => (Number(e.OMC_PROVIDER_TASK_START_LOCK_LIMIT_MS) > 0 ? Number(e.OMC_PROVIDER_TASK_START_LOCK_LIMIT_MS) : 300_000);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function underLock(file, e, fn) {
  const lock = `${file}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const limitMs = Number(e.OMC_PROVIDER_TASK_LOCK_LIMIT_MS) > 0 ? Number(e.OMC_PROVIDER_TASK_LOCK_LIMIT_MS) : 10000;
  const begin = Date.now();
  for (;;) {
    let fd = null;
    try { fd = openSync(lock, 'wx'); } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      let m = null;
      try { m = JSON.parse(readFileSync(lock, 'utf8')); } catch { /* empty or corrupt: the age comes from the mtime */ }
      // Unreadable content (the gap between openSync(wx) and writeSync) is not a dead lock: the age comes from the mtime of the lock file;
      // a fresh one waits as for a live owner, an old one (over 60 s) is taken over.
      if (!m) {
        const fresh = (() => { try { return Date.now() - statSync(lock).mtimeMs <= LOCK_MAX_AGE_MS; } catch { return false; } })();
        if (fresh) { if (Date.now() - begin > limitMs) throw new Error(`lock ${lock} held longer than the limit of ${limitMs} ms`); pause(50); continue; }
        try { unlinkSync(lock); } catch { /* taken over by another process */ }
        continue;
      }
      if (!isAlive(m.pid) || Date.now() - m.ts > LOCK_MAX_AGE_MS) { try { unlinkSync(lock); } catch { /* taken over by another process */ } }
      if (Date.now() - begin > limitMs) throw new Error(`lock ${lock} held longer than the limit of ${limitMs} ms`);
      pause(50);
      continue;
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      return fn();
    } finally {
      try { closeSync(fd); } catch { /* already closed */ }
      let m = null;
      try { m = JSON.parse(readFileSync(lock, 'utf8')); } catch { /* another process took it over and removed it: not removed here */ }
      if (m && m.pid === process.pid) { try { unlinkSync(lock); } catch { /* race */ } }
    }
  }
}
// Read of the task file under the lock; null when the file is missing or corrupt.
function readTask(id, e) {
  const file = taskPath(id);
  if (!existsSync(file)) return null;
  return underLock(file, e, () => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  });
}
// Write of the task file under the lock: read, change(data) returns the new object (or null for no write), atomic write
// (temp file and rename) with all keys kept. Returns the written object, or null when nothing was written (also when a
// parallel process had already written the verdict), so that `result` can recognize being overtaken.
function changeTask(id, e, change) {
  const file = taskPath(id);
  let result = null;
  underLock(file, e, () => {
    let data = {};
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { data = {}; }
    result = change(data);
    if (!result) return null;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(result, null, 2) + '\n');
    renameSync(tmp, file);
  });
  return result;
}
// Writes that only complete an existing task do not create the file or the directory: a missing file means no lock and no
// directory, and null is returned; under the lock an object without an id gives null without a write. A late _start after the
// task file or the state directory was removed does not recreate a stub task file.
function completeTask(id, e, change) {
  const file = taskPath(id);
  if (!existsSync(file)) return null;
  let result = null;
  underLock(file, e, () => {
    let data = null;
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { data = null; }
    if (!data || typeof data !== 'object' || !data.id) return null;
    result = change(data);
    if (!result) return null;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(result, null, 2) + '\n');
    renameSync(tmp, file);
  });
  return result;
}

// Check of a free session slot WITHOUT taking one (read only): live slots are counted by the rules of the slot module in
// <stateDir>/slots (dead and corrupt ones are ignored, not removed); the limit is limits.maxSessions of the profile; none free: exit 3.
function liveSlots() {
  const profile = profileOf();
  const limit = profile.limits.maxSessions;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1024) fail(EXIT.CONFIG, 'limits.maxSessions has a value that is not allowed (an integer from 1 to 1024)');
  const dir = statePath(profile, env, 'slots');
  const live = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return { live: [], limit }; }
  for (const f of entries) {
    if (!/^slot-/.test(f)) continue;
    let d = null;
    try { d = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    if (!d || typeof d.pid !== 'number' || !isAlive(d.pid) || d.pid === process.pid || Date.now() - (d.ts || 0) > SLOT_MAX_AGE_MS) continue;
    live.push(d);
  }
  return { live, limit };
}
function checkSlot() {
  const { live, limit } = liveSlots();
  if (live.length >= limit) fail(EXIT.MISSING, `no free provider session slot (limit ${limit}, live ${live.length}); start refused without taking a slot`);
  return { count: live.length, limit };
}

// Read of the OMC task through `omc team api`: list-tasks, the choice of the task by subject (matchTask), then read-task for the
// full object. Returns { task, error }: a non-null error is a failure of the omc call (exit code != 0, empty output, bad JSON) and
// is NOT a missing task (the callers show in_progress with a message on stderr, not start_failed); a null error with a null task means
// no matching task. A failure of read-task for a found task keeps the row of list-tasks (not an error).
function readOmcTask(z, e) {
  const cwd = z.cwd || process.cwd();
  const failed = (text) => ({ task: null, error: text });
  const r = callOmc(e, ['team', 'api', 'list-tasks', '--input', JSON.stringify({ team_name: z.team }), '--json'], { cwd });
  if (r.status !== 0) return failed(`list-tasks ended with exit code ${r.status ?? 'not started'}`);
  if (!r.stdout) return failed('list-tasks: empty output');
  let d = null;
  try { d = JSON.parse(r.stdout); } catch { return failed('list-tasks: the output is not JSON'); }
  const list = d && d.ok && d.data && Array.isArray(d.data.tasks) ? d.data.tasks : [];
  const task = matchTask(z.id, list);
  if (!task) return { task: null, error: null };
  const r2 = callOmc(e, ['team', 'api', 'read-task', '--input', JSON.stringify({ team_name: z.team, task_id: task.id }), '--json'], { cwd });
  if (r2.status !== 0 || !r2.stdout) return { task, error: null };
  let answer2 = null;
  try { answer2 = JSON.parse(r2.stdout); } catch { return { task, error: null }; }
  return { task: (answer2 && answer2.ok && answer2.data && answer2.data.task) ? answer2.data.task : task, error: null };
}

// Modules next to the script: the result module (evaluation) and the task journal module; tests inject their own through
// OMC_PROVIDER_TASK_RESULT_MODULE and OMC_PROVIDER_TASK_LOG_MODULE. A module that is missing or throws does not stop the
// command (a message on stderr, the output without that field).
function moduleFile(kind, e) {
  if (kind === 'result') return e.OMC_PROVIDER_TASK_RESULT_MODULE || join(__dirname, 'lib', 'task-result.cjs');
  return e.OMC_PROVIDER_TASK_LOG_MODULE || join(__dirname, 'provider-task-log.cjs');
}

// ===== doctor =====
// Alias of the worker model -> the id of the profile (with the context suffix), or the value itself.
const modelId = (profile, alias) => (profile.models[alias] && profile.models[alias].id) || alias;
function doctor() {
  const profile = profileOf();
  const alias = profile.worker.model;
  const effort = profile.worker.effort;
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-[\]]*$/.test(alias) || !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) fail(EXIT.CONFIG, 'worker.model or worker.effort of the profile has a value that is not allowed; the smoke test is aborted');
  // The model the answer must come from: the id of the worker model in the profile without a context suffix, which may be present or absent in the answer (the suffix [1m] is accepted).
  const expected = modelId(profile, alias).replace(/\[\d+[mk]\]$/, '');
  const accepted = new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\[1m\\])?$`);
  const real = settingsLib.resolveClaudeBinary(profile, env, self);
  if (!real) fail(EXIT.NO_BINARY, 'no usable claude binary (set OMC_PROVIDER_CLAUDE_BIN or profile.claudeBinary)');
  const read = settingsLib.readKey(profile, env, helperPath);
  if (read.error) fail(EXIT.MISSING, read.error);
  const file = join(statePath(profile, env, 'worker-settings'), `doctor-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  // The context window is read from the built settings.
  let window = String(profile.contextWindow);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    settingsLib.sweepCopies(dirname(file));
    const shimEnv = { ...env, OMC_PROVIDER_SHIM_DIR: env.OMC_PROVIDER_SHIM_DIR || settingsLib.shimDir(profile, env, 'worker') };
    const settings = settingsLib.addProvider({}, {
      profile,
      baseUrl: profile.baseUrl,
      helperPath,
      env: shimEnv,
      file,
      target: join(__dirname, 'provider-worker.cjs'),
      guardPath: join(__dirname, 'provider-bash-guard.cjs'),
      keyInProcessEnv: true,
      executor: true,
    });
    // Subagents of the executor run on the subagent model of the profile, and without Jev unless the profile keeps it on.
    const aliasId = (name) => (profile.models[name] && profile.models[name].id) || null;
    const subagent = profile.subagentModel ? (aliasId(profile.subagentModel) || profile.subagentModel) : aliasId(profile.models.haiku ? 'haiku' : profile.models.default);
    Object.assign(settings.env, { ...(subagent ? { CLAUDE_CODE_SUBAGENT_MODEL: subagent } : {}), ...(profile.worker.disableJev ? { OMC_JEV: 'off' } : {}) });
    writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
    window = (settings.env && settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) || window;
  } catch (e) { fail(EXIT.CONFIG, `cannot prepare the provider settings (${e.message}); the smoke test is aborted`); }
  // The environment of the child is built from the allow-list of the executor; the key goes in explicitly: a process with the provider key does not get the rest of the environment of the lead.
  const childEnv = executorEnv(env, { explicit: { ANTHROPIC_AUTH_TOKEN: read.key }, profile });
  const args = ['-p', 'Reply with just: ok', '--output-format', 'json', '--model', alias, '--effort', effort, '--settings', file, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  const begin = Date.now();
  const w = spawnSync(real, args, { encoding: 'utf8', env: childEnv, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  const took = ((Date.now() - begin) / 1000).toFixed(1);
  const output = `${w.stdout || ''}\n${w.stderr || ''}`;
  if (w.error) fail(EXIT.NO_BINARY, `cannot start claude: ${w.error.code || w.error.message}`);
  if (w.status !== 0) {
    const cls = failureClass({ text: output }, profile);
    if (cls === FAILURE_CLASSES.QUOTA) console.log(`provider-task doctor: QUOTA (pause): the provider quota is exhausted after ${took}s; this is a pause, not a configuration error`);
    else console.log(`provider-task doctor: FAILURE (${cls}) after ${took}s; exit code of the executor ${w.status}`);
    process.exit(cls === FAILURE_CLASSES.QUOTA ? EXIT.QUOTA_REFUSED : EXIT.FAILURE);
  }
  // The JSON of `claude -p --output-format json` has no model field at the top level: the model is a key of the modelUsage object.
  // The model is answer.model, otherwise the first key of modelUsage; the "not JSON" message appears only when JSON.parse fails,
  // valid JSON without a model has its own message.
  let answer = null;
  let badJson = false;
  try { answer = JSON.parse(w.stdout); } catch { badJson = true; }
  const model = (() => {
    if (answer && typeof answer.model === 'string' && answer.model) return answer.model;
    const usage = answer && answer.modelUsage;
    if (usage && typeof usage === 'object' && !Array.isArray(usage)) return Object.keys(usage)[0] || '';
    return '';
  })();
  if (accepted.test(model)) {
    console.log(`provider-task doctor: OK: model ${model} (context window ${window}) in ${took}s`);
    process.exit(EXIT.OK);
  }
  if (model) fail(EXIT.CONFIG, `the executor answered with another model (${model}), expected ${expected}; check worker.model and the provider env of the profile`);
  if (badJson) fail(EXIT.CONFIG, `the executor did not answer with valid JSON with a model field (output ${w.stdout ? 'present, not JSON' : 'empty'}); check the provider configuration`);
  fail(EXIT.CONFIG, 'the executor answered with valid JSON without a model (no model field and no modelUsage keys); check the provider configuration');
}

// ===== wait =====
// Parsing of the arguments and the call of the wait loop; the output: a row per task `id -> status verified=... error=...`, the
// number of tasks in progress, HANDOFF lines for evaluations with a handoff.
function waitCommand(args) {
  const ids = [];
  let timeoutS = null;
  let limitS = null;
  let any = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--any') any = true;
    else if (a === '--timeout') timeoutS = args[++i];
    else if (a === '--limit') limitS = args[++i];
    else if (a.startsWith('--')) fail(EXIT.CONFIG, `wait: unknown flag ${a}`);
    else ids.push(a);
  }
  if (!ids.length) fail(EXIT.CONFIG, 'wait: give at least one task id (8 characters [0-9a-f])');
  const { wait } = require('./lib/task-wait.cjs');
  // Without --limit the task deadline of the profile applies (limits.taskTimeoutSeconds, 1800 by default): past it the wait loop shuts the
  // team down and records failed/timeout, so repeated waits cannot leave an overdue worker running.
  const profile = profileOf();
  wait({ ids, timeoutS, any, limitS: limitS ?? profile.limits.taskTimeoutSeconds, env, profile })
    .then((r) => {
      for (const w of r.results) console.log(`${w.id} -> ${w.status} verified=${w.verified ? 'yes' : 'no'} error=${w.error}`);
      console.log(`in progress: ${r.in_progress}`);
      for (const w of r.results) if (w.handoff) console.log(`HANDOFF ${w.id} ${w.status} ${w.error}`);
      if (r.timed_out) console.error(`provider-task wait: the time limits were reached, ${r.in_progress} tasks in progress; run wait again`);
      process.exit(r.handoff ? EXIT.CONFIG : r.timed_out ? EXIT.FAILURE : EXIT.OK);
    })
    .catch((e) => fail(e && e.errorCode ? e.errorCode : EXIT.FAILURE, e && e.message));
}

// ===== start =====
// start [--cwd DIR] [--brief FILE] [--max-tool-calls N] [--] TEXT
function parseStart(rest) {
  const o = { cwd: null, brief: null, maxToolCalls: null, text: [] };
  let afterDashes = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (afterDashes) { o.text.push(a); continue; }
    if (a === '--') { afterDashes = true; continue; }
    if (a === '--cwd' || a === '--brief' || a === '--max-tool-calls') {
      const v = rest[++i];
      if (v === undefined) fail(EXIT.CONFIG, `start: ${a} needs a value`);
      if (a === '--cwd') o.cwd = v;
      else if (a === '--brief') o.brief = v;
      else o.maxToolCalls = v;
      continue;
    }
    if (a.startsWith('--')) fail(EXIT.CONFIG, `start: unknown flag ${a}`);
    o.text.push(a);
  }
  const text = o.text.join(' ').trim();
  if (!text && !o.brief) fail(EXIT.CONFIG, 'Usage: provider-task start [--cwd <dir>] [--brief <file>] [--max-tool-calls N] [--] <task text>');
  return {
    cwd: resolve(o.cwd || process.cwd()),
    brief: o.brief ? resolve(o.brief) : null,
    maxToolCalls: o.maxToolCalls,
    text,
  };
}

async function startCommand(rest) {
  const o = parseStart(rest);
  if (!existsSync(o.cwd) || !statSync(o.cwd).isDirectory()) fail(EXIT.CONFIG, `start: the --cwd directory does not exist: ${o.cwd}`);
  if (o.brief && !existsSync(o.brief)) fail(EXIT.CONFIG, `start: the --brief file does not exist: ${o.brief}`);
  if (o.maxToolCalls !== null && (!/^\d+$/.test(String(o.maxToolCalls)) || Number(o.maxToolCalls) < 1)) fail(EXIT.CONFIG, 'start: --max-tool-calls needs an integer of at least 1');
  const maxToolCalls = o.maxToolCalls !== null ? Number(o.maxToolCalls) : null;
  if (env.OMC_PROVIDER || isForeignProvider(env)) fail(EXIT.CONFIG, 'a process with a foreign provider address, or a provider session, does not start a team; run from the session of the lead (Claude)');
  const profile = profileOf();
  const dir = tasksDir();
  mkdirSync(dir, { recursive: true });
  const id = randomUUID().replace(/-/g, '').slice(0, 8);
  const fullText = `${taskSubject(id)} ${o.brief ? `Read ${o.brief} in full and carry it out.` : o.text}`;
  // Quota gate as in provider-team: the key from the helper next to this script (no key lets the gate pass); a refusal: exit 4 and a message on stderr, provider-team does not start.
  let gateKey = null;
  try { const r = settingsLib.readKey(profile, env, helperPath); if (r.key) gateKey = r.key; } catch { /* no helper: the gate passes */ }
  const verdict = await gate(profile, env, gateKey);
  if (verdict.refuse) fail(verdict.code, verdict.message);
  // Check of a free slot without taking it (read only); none: exit 3.
  checkSlot();
  // The team field is the real team name: start derives it with slugifyTask and a numeric suffix over the team state directory, and _start
  // confirms it from that directory after the start (poll OMC_PROVIDER_TASK_POLL_MS, 2000 ms by default).
  const team = await freeTeamName(fullText, o.cwd);
  const startIso = new Date().toISOString();
  changeTask(id, env, (d) => ({ ...d, id, team, start: startIso, cwd: o.cwd, brief: o.brief, text: fullText, max_tool_calls: maxToolCalls }));
  // Detached process: the internal `_start` runs provider-team, confirms the team name and after provider-team ends records start_exit_code and start_error.
  const log = openSync(join(dir, `${id}.log`), 'a');
  const child = spawn(process.execPath, [self, '_start', id], { detached: true, stdio: ['ignore', log, log], env: { ...env }, cwd: o.cwd });
  child.unref();
  closeSync(log);
  // The pid of the child and its start time from /proc (field 22) are added under the lock of the task file; the grace period of a missing
  // OMC task counts from omc_started_at (written by _start after the start lock), and without it from the actual _start, not from the start entry.
  // A failed /proc read gives null. A failure of the task file lock: a message on stderr, the id is returned as usual and the evaluation
  // without start_pid uses the grace period from the start field.
  let starttime = null;
  try { starttime = readStarttime(child.pid); } catch { /* no /proc: null */ }
  try { completeTask(id, env, (d) => ({ ...d, start_pid: child.pid, start_pid_starttime: starttime })); } catch (e) { console.error(`provider-task: writing start_pid failed (${e.message}); the grace period counts from start`); }
  console.log(id);
}

// Internal subcommand `_start <id>`: runs provider-team 1:claude:executor --no-decompose "<text>" (one worker gets the whole text
// as the subject `ptask-<id> ...`, owner worker-1), confirms the real team name from the team state directory while it runs (poll up to
// OMC_PROVIDER_TASK_POLL_MS, 2000 ms by default), and after provider-team ends records start_exit_code (a number) and start_error (the last
// stderr line through the redaction).
async function startInternal(id) {
  const dir = tasksDir();
  const z = readTask(id, env);
  if (!z || !z.team || !z.text) fail(EXIT.CONFIG, `_start: no task file ${id} or no team/text fields (start writes the task file first)`);
  const cwd = z.cwd || process.cwd();
  // Serialization of starts per --cwd directory by the start lock <stateDir>/locks/start-<sha1(realpath cwd)>.lock before provider-team runs,
  // released after the child ends. A dead owner: taken over. Unreadable content (an empty file or the gap between openSync(wx) and writeSync):
  // waits as for a live owner, and after 60 s from the mtime taken over. A live owner: waits while it holds the lock for less than the limit
  // (OMC_PROVIDER_TASK_START_LOCK_LIMIT_MS, 300 s by default) counted from the ts of the owner in the lock, not from the begin of this wait; a change of the owner
  // restarts the count, so a long queue with progress does not fail. A live owner over the limit (hung): no parallel start - start_exit_code 1 and
  // start_error "start lock: process <pid> held the lock for more than <N> s", the end of _start without a start.
  const startLock = join(statePath(profileOf(), env, 'locks'), `start-${createHash('sha1').update(realpathSync(cwd)).digest('hex')}.lock`);
  mkdirSync(dirname(startLock), { recursive: true });
  const lockLimit = startLockLimitMs(env);
  const pollMs = Number(env.OMC_PROVIDER_TASK_POLL_MS) > 0 ? Number(env.OMC_PROVIDER_TASK_POLL_MS) : 2000;
  // (the child is spawned after the start lock loop)
  let lockFd = null;
  let gaveUp = null; // { pid, limitS } when a live owner holds the lock over the limit: the end without a start
  // queue_ts (ISO) is the last progress of the start lock queue, written under the lock of the task file at the first read of the owner and at every
  // observed change of the owner (key pid:ts, or unreadable:mtime). The queue ceiling of the missing-task evaluation counts from max(start, queue_ts).
  // A failed write (a busy task file lock): a message on stderr, the wait goes on.
  let lastKey = null;
  const queueProgress = (key) => {
    if (key === lastKey) return;
    lastKey = key;
    try { completeTask(id, env, (d) => ({ ...d, queue_ts: new Date().toISOString() })); }
    catch (e4) { console.error(`_start: writing queue_ts failed (${e4.message}); the queue ceiling counts from the previous write`); }
  };
  while (lockFd === null && !gaveUp) {
    let fd = null;
    try { fd = openSync(startLock, 'wx'); } catch (err2) {
      if (!err2 || err2.code !== 'EEXIST') throw err2;
      let m = null;
      try { const x = JSON.parse(readFileSync(startLock, 'utf8')); if (x && typeof x.pid === 'number' && typeof x.ts === 'number') m = x; } catch { /* unreadable content */ }
      // Every observed change of the owner (pid or ts in the content) is queue progress; so is the takeover of a dead lock.
      if (m) queueProgress(`${m.pid}:${m.ts}`);
      if (m && !isAlive(m.pid)) { try { unlinkSync(startLock); } catch { /* taken over by another process */ } continue; }
      if (!m) {
        // Unreadable content: the age from the mtime of the lock file; a fresh one waits as for a live owner, after 60 s it is taken over.
        let age = null;
        let mtime = null;
        try { mtime = statSync(startLock).mtimeMs; age = Date.now() - mtime; } catch { /* the lock vanished: try again */ continue; }
        queueProgress(`unreadable:${mtime}`);
        if (age < LOCK_MAX_AGE_MS) { pause(200); continue; }
        try { unlinkSync(startLock); } catch { /* taken over by another process */ }
        continue;
      }
      // A live owner: wait while it holds the lock for less than the limit from the ts in the lock.
      if (Date.now() - m.ts > lockLimit) { gaveUp = { pid: m.pid, limitS: Math.round(lockLimit / 1000) }; break; }
      pause(200);
      continue;
    }
    writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    lockFd = fd;
  }
  if (gaveUp) {
    // A parallel start never happens: start_exit_code is written and _start ends without provider-team.
    const lockError = mask(`start lock: process ${gaveUp.pid} held the lock for more than ${gaveUp.limitS} s`);
    try { completeTask(id, env, (d) => ({ ...d, start_exit_code: 1, start_error: lockError })); } catch { /* the task file lock is busy: the evaluation uses start_pid */ }
    process.exit(0);
  }
  // Release of the start lock: removed only when it holds this pid.
  const releaseStartLock = () => {
    if (lockFd === null) return;
    try { closeSync(lockFd); } catch { /* already closed */ }
    let m2 = null;
    try { m2 = JSON.parse(readFileSync(startLock, 'utf8')); } catch { /* another process took it over and removed it: not removed here */ }
    if (m2 && m2.pid === process.pid) { try { unlinkSync(startLock); } catch { /* race */ } }
  };
  // The moment of the actual start is taking the start lock: omc_started_at (ISO) goes under the lock of the task file BEFORE provider-team
  // runs - the grace period of a missing OMC task counts from it, not from the start entry. The same write checks cancellation (one critical
  // section): a task that was killed, or already has a verdict (a `kill`, the time limit of `wait`, a start_failed of the queue ceiling), while
  // this launcher waited for the start lock must not start a team. `kill` and the limit shut down a team that does not exist yet (omc answers
  // "No team state found"), so nothing else would stop it; `wait` and `kill` write killed or the verdict before they shut down.
  const isCancelled = (d) => Boolean(d && (d.killed || d.verdict));
  let cancelled = false;
  try {
    completeTask(id, env, (d) => {
      if (isCancelled(d)) { cancelled = true; return { ...d, start_error: 'cancelled before the team was started' }; }
      return { ...d, omc_started_at: new Date().toISOString() };
    });
  } catch (e3) {
    console.error(`_start: writing omc_started_at failed (${e3.message}); the grace period is evaluated from start_pid`);
    // The task file lock stayed busy, so the check above did not run: read the file without the lock rather than start a team for a task that may be
    // cancelled (writes are a temp file and a rename, so a lock-free read never sees half a file). Unreadable: the start goes on.
    try { cancelled = isCancelled(JSON.parse(readFileSync(taskPath(id), 'utf8'))); } catch { /* unreadable: not treated as cancelled */ }
  }
  if (cancelled) { releaseStartLock(); process.exit(0); }
  // Resolved before the spawn: an `error` event of the child (e.g. ENOENT) must not fire while no listener is registered yet.
  const teamDir = await teamStateDir(cwd);
  const out = openSync(join(dir, `${id}.log`), 'a');
  const err = openSync(join(dir, `${id}.err.log`), 'a');
  const [command, ...commandArgs] = teamCommand(env);
  const child = spawn(command, [...commandArgs, '1:claude:executor', '--no-decompose', z.text], { stdio: ['ignore', out, err], cwd, env: { ...env } });
  closeSync(out);
  closeSync(err);
  // Poll of the team name (up to pollMs, every 200 ms): a state directory matching /^ptask-<id>(?:-|$)/ and different from the base corrects the team
  // field; a directory equal to the base confirms it; after the limit the name from slugifyTask stays. Errors of the task file lock in the poll are ignored.
  const re = new RegExp(`^ptask-${id}(?:-|$)`);
  const pollEnd = Date.now() + pollMs;
  let correction = null;
  while (Date.now() < pollEnd) {
    let hit = null;
    let entries = [];
    try { entries = readdirSync(teamDir); } catch { entries = []; }
    if (entries.includes(z.team)) hit = 'confirmed';
    else {
      const foreign = entries.find((w) => re.test(w) && w !== z.team);
      if (foreign) hit = foreign;
    }
    if (hit) {
      correction = hit === 'confirmed' ? null : hit;
      break;
    }
    pause(200);
  }
  if (correction) { try { completeTask(id, env, (d) => ({ ...d, team: correction })); } catch { /* the lock is busy: the name from slugifyTask stays */ } }
  // The child cannot be started (e.g. ENOENT): start_exit_code 127 and start_error from e.code, instead of an uncaught exception and a start that looks pending.
  let startError = null;
  const code = await new Promise((done) => {
    let settled = false;
    child.once('close', (c) => { if (!settled) { settled = true; done(c ?? 1); } });
    child.once('error', (e) => { if (!settled) { settled = true; startError = String(e.code || e.message); done(127); } });
  });
  // After provider-team ends: start_exit_code goes to the task file. start_error only on a non-zero code (the last stderr line through the
  // redaction, or the message of the start error); on exit code 0 it is null: a field called "error" on a successful start would mislead, and stderr stays in <id>.err.log.
  let lastLine = null;
  if (code !== 0) {
    if (startError) lastLine = mask(startError);
    else {
      try {
        const t = readFileSync(join(dir, `${id}.err.log`), 'utf8').trim();
        if (t) lastLine = mask(t.split('\n').at(-1));
      } catch { /* no file or empty: null */ }
    }
  }
  // The final write only completes the task: a missing task file (removed while _start ran) ends quietly with exit code 0, without a stub file.
  completeTask(id, env, (d) => ({ ...d, start_exit_code: code, start_error: lastLine }));
  // Release of the start lock after the child ends.
  releaseStartLock();
  process.exit(0);
}

// ===== status =====
// status <id>: the task file, the OMC task through omc team api (list-tasks and read-task); prints one JSON line { id, team, status, worker, ... }.
function statusCommand(rest) {
  const id = rest[0];
  if (!id) fail(EXIT.CONFIG, 'Usage: provider-task status <id>');
  const z = readTask(id, env);
  if (!z) fail(EXIT.CONFIG, `status: no task file ${id} in ${tasksDir()}`);
  const out = { id: z.id || id, team: z.team, start: z.start ?? null, cwd: z.cwd ?? null, brief: z.brief ?? null, start_exit_code: z.start_exit_code ?? null, start_error: z.start_error ?? null, max_tool_calls: z.max_tool_calls ?? null, verdict_ts: z.verdict_ts ?? null, status: STATUSES.UNKNOWN, worker: null, task: null };
  if (z.killed) out.status = 'killed';
  else if (z.verdict) out.status = z.verdict.status || STATUSES.UNKNOWN;
  else {
    const { task, error } = readOmcTask(z, env);
    if (task) {
      // An OMC task that was found wins over start_exit_code (omc team may end with exit code 1 for tasks that ran).
      out.status = task.status ?? STATUSES.UNKNOWN;
      out.worker = task.owner ?? null;
      out.task = task;
    } else if (error) {
      // A failure of the omc call is not a missing task: in_progress with a message on stderr.
      out.status = STATUSES.IN_PROGRESS;
      console.error(`provider-task: ${error}; showing in_progress instead of start_failed`);
    } else if (z.start_exit_code != null && z.start_exit_code !== 0) {
      out.status = 'start_failed';
    } else {
      // The start-lock queue and the grace period are evaluated in one function of the result module: the queue and the grace period give
      // pending, start_failed (a dead _start, the queue ceiling, the grace period after 60 s) gives start_failed.
      const evaluation = missingTaskEvaluation(z, env);
      out.status = evaluation.verdict ? 'start_failed' : 'pending';
    }
    // omc team status <team> --json (the flag may be ignored and the output is text): the name of the worker from the line worker=,
    // only for no matching OMC task (with an error omc failed, with a task the owner of the task is enough).
    if (!out.worker && !task && !error) {
      const st = callOmc(env, ['team', 'status', z.team, '--json'], { cwd: z.cwd || process.cwd() });
      const row = (st.stdout || '').split('\n').find((l) => l.startsWith('worker='));
      if (row) out.worker = row.slice('worker='.length).split(' ')[0] || null;
    }
  }
  console.log(JSON.stringify(out));
  process.exit(EXIT.OK);
}

// Heartbeat of the worker from omc team api read-worker-heartbeat (data.heartbeat; null when there is no file); a failed call, no owner or bad JSON gives null.
// The worker is the owner of the OMC task; the call runs in the cwd of the task.
function readHeartbeat(z, worker, e) {
  if (!worker) return null;
  const r = callOmc(e, ['team', 'api', 'read-worker-heartbeat', '--input', JSON.stringify({ team_name: z.team, worker }), '--json'], { cwd: z.cwd || process.cwd() });
  if (r.status !== 0 || !r.stdout) return null;
  try { const d = JSON.parse(r.stdout); return d && d.ok && d.data ? (d.data.heartbeat ?? null) : null; } catch { return null; }
}

// Status of the worker from omc team api read-worker-status (data.status; the team state files go through omc team api, the same
// source as in lib/task-wait.cjs), in the cwd of the task. A failed spawn or bad JSON gives null.
function readWorkerStatus(z, worker, e) {
  if (!worker) return null;
  const r = callOmc(e, ['team', 'api', 'read-worker-status', '--input', JSON.stringify({ team_name: z.team, worker }), '--json'], { cwd: z.cwd || process.cwd() });
  if (r.status !== 0 || !r.stdout) return null;
  try { const d = JSON.parse(r.stdout); return d && d.ok && d.data ? (d.data.status ?? null) : null; } catch { return null; }
}

// Facts for the evaluation from the task journal module (taskRow); an error of the module (also its absence, or a null row) does not stop the
// command: null (a message on stderr). The facts are taken BEFORE the verdict is written (the state before the evaluation), the header AFTER it.
function evaluationFacts(id, e) {
  try {
    const journal = require(moduleFile('log', e));
    return journal.taskRow(id, { env: e, profile: profileOf() }) || null;
  } catch (e2) { console.error(`provider-task: the task journal is unavailable (${e2.message})`); return null; }
}
// Header from the task journal: resultHeader(taskRow(id)); null without a row; an error of the module does not stop the command.
// A fresh read after the verdict is written: the header shows the status of the verdict of this call, not `?`.
function taskHeader(id, e) {
  try {
    const journal = require(moduleFile('log', e));
    const row = journal.taskRow(id, { env: e, profile: profileOf() });
    return row ? journal.resultHeader(row) : null;
  } catch (e2) { console.error(`provider-task: the task journal is unavailable (${e2.message})`); return null; }
}
// Evaluation of a missing OMC task by evaluateMissingTask of the result module (one function for status, result and wait).
// Without the module, or without that function: the fallback rule, a grace period of 60 s from the start field.
function missingTaskEvaluation(z, e) {
  const file = moduleFile('result', e);
  if (existsSync(file)) {
    try {
      const m = require(file);
      if (typeof m.evaluateMissingTask === 'function') return m.evaluateMissingTask(z, { now: nowMs(e), startLockLimitMs: startLockLimitMs(e) });
    } catch (e2) { console.error(`provider-task: the missing-task evaluation is unavailable (${e2.message}); fallback grace period of 60 s from start`); }
  }
  const sinceStart = (nowMs(e) - Date.parse(z.start)) / 1000;
  const afterGrace = Number.isFinite(sinceStart) && sinceStart > 60; // fallback: a constant 60 s (START_GRACE_MS of the result module)
  return { state: afterGrace ? 'start_failed' : 'grace',
    verdict: afterGrace ? { status: 'start_failed', cause: CAUSES.ENVIRONMENT, handoff: true, errors: [`OMC task ${taskSubject(z.id)} not found in team ${z.team}`] } : null };
}

// Verdict for killed and for a non-zero start_exit_code without an OMC task: the evaluation of the result module with the task file (it handles both),
// and without the module the full shape of the evaluation (killed without a handoff, exit code 4 = quota, other codes = environment with a handoff).
function verdictWithoutTask(z, e) {
  const file = moduleFile('result', e);
  if (existsSync(file)) {
    try { return require(file).evaluateResult({ task: null, workerStatus: null, taskFile: z, facts: null, heartbeat: null }, { now: nowMs(e) }); }
    catch (e2) { console.error(`provider-task: the evaluation is unavailable (${e2.message}); fallback verdict without the result module`); }
  }
  const full = { status: STATUSES.UNKNOWN, cause: null, gaps: null, required: null, unverified: null, evidence: null, points: null, escalation: null, heartbeat_age_s: null, handoff: false, errors: [] };
  if (z.killed) full.status = 'killed';
  else if (typeof z.start_exit_code === 'number' && z.start_exit_code !== 0) {
    full.status = 'start_failed';
    full.cause = z.start_exit_code === EXIT.QUOTA_REFUSED ? CAUSES.QUOTA : CAUSES.ENVIRONMENT;
    full.handoff = true;
  } else { full.errors.push('no decision: the task is in progress or there is no input data'); full.handoff = true; }
  return full;
}

// Printing of the saved verdict (the saved one wins: a second result after the evaluation of a parallel wait does not evaluate again).
// result_raw comes from the OMC task, header from the task journal; killed after the verdict wins in the output.
function printSavedVerdict(z, id, e) {
  if (!z) { console.log(JSON.stringify({ id, team: null, status: STATUSES.UNKNOWN, errors: ['the task file vanished'] })); process.exit(EXIT.OK); }
  const { task } = readOmcTask(z, e);
  const header = taskHeader(id, e);
  const out = { id, team: z.team, ...z.verdict, result_raw: (task && task.result) ?? null };
  if (z.killed) out.status = 'killed';
  if (header) out.header = header;
  console.log(JSON.stringify(out));
  process.exit(EXIT.OK);
}

// ===== result =====
// result <id>: reads the OMC task (omc team api), the worker status (read-worker-status), the task file and the heartbeat of the worker; with the
// result module available (lib/task-result.cjs, or OMC_PROVIDER_TASK_RESULT_MODULE) calls evaluateResult({ task, workerStatus, taskFile, facts,
// heartbeat }, { now }) and prints JSON { id, team, ...evaluation, result_raw } (plus header from the task journal when available); without the module it
// prints { id, team, status: <OMC status>, result_raw }. verdict and verdict_ts are written to the task file BEFORE printing.
// The order of the state: (a) killed: the verdict killed at once; (b) the OMC task found: the state and evaluation come from the task, also
// with start_exit_code != 0; (c) not found and start_exit_code other than 0: start_failed with the cause from the code at once, without a grace period;
// (d) not found and the code 0/null: the missing-task evaluation (queue, grace period, dead _start); a failed omc call is not a missing task:
// in_progress with a message on stderr. A write of the verdict does not overwrite a parallel one (d.verdict ? null : ...); when overtaken, result prints the saved one.
function resultCommand(rest) {
  const id = rest[0];
  if (!id) fail(EXIT.CONFIG, 'Usage: provider-task result <id>');
  const z = readTask(id, env);
  if (!z) fail(EXIT.CONFIG, `result: no task file ${id} in ${tasksDir()}`);
  // A saved verdict: printed without a new evaluation and without a write (one evaluation per task); killed after the verdict wins in the output.
  if (z.verdict) printSavedVerdict(z, id, env);
  const { task, error } = readOmcTask(z, env);
  if (!task) {
    if (z.killed || (typeof z.start_exit_code === 'number' && z.start_exit_code !== 0)) {
      const verdict = verdictWithoutTask(z, env);
      const written = changeTask(id, env, (d) => (d.verdict ? null : { ...d, verdict, verdict_ts: new Date().toISOString() }));
      if (written === null) printSavedVerdict(readTask(id, env), id, env); // overtaken by a parallel wait
      const out = { id, team: z.team, ...verdict, result_raw: null };
      const header = taskHeader(id, env); // the header AFTER the write: the status of the verdict of this call
      if (header) out.header = header;
      console.log(JSON.stringify(out));
      process.exit(EXIT.OK);
    }
    if (error) {
      console.error(`provider-task: ${error}; evaluation deferred, state in_progress`);
      console.log(JSON.stringify({ id, team: z.team, status: STATUSES.IN_PROGRESS, cause: null, handoff: false, errors: [] }));
      process.exit(EXIT.OK);
    }
    // (d) The start-lock queue and the grace period: in_progress is printed without a write and with exit code 0;
    // start_failed (dead _start, queue ceiling, grace period over) is written without overwriting (a parallel verdict) with the header after the write.
    const startState = missingTaskEvaluation(z, env);
    if (startState.verdict) {
      const verdict = startState.verdict;
      const written = changeTask(id, env, (d) => (d.verdict ? null : { ...d, verdict: startState.verdict, verdict_ts: new Date().toISOString() }));
      if (written === null) printSavedVerdict(readTask(id, env), id, env);
      const out = { id, team: z.team, ...verdict, result_raw: null };
      const header = taskHeader(id, env);
      if (header) out.header = header;
      console.log(JSON.stringify(out));
      process.exit(EXIT.OK);
    }
    console.log(JSON.stringify({ id, team: z.team, status: STATUSES.IN_PROGRESS, cause: null, handoff: false, errors: [] }));
    process.exit(EXIT.OK);
  }
  const worker = (task && task.owner) || null;
  // The heartbeat of the worker (a failed call, no owner or bad JSON: null).
  const heartbeat = readHeartbeat(z, worker, env);
  // The worker status from omc team api read-worker-status (data.status), the same source as lib/task-wait.cjs.
  const workerStatus = readWorkerStatus(z, worker, env);
  // Facts from the task journal BEFORE the evaluation; an error of the module does not stop the command (stderr).
  const facts = evaluationFacts(id, env);
  let out = { id, team: z.team, status: (task && task.status) ?? null, result_raw: (task && task.result) ?? null };
  const resultModule = moduleFile('result', env);
  if (existsSync(resultModule)) {
    try {
      const evaluation = require(resultModule).evaluateResult({ task, workerStatus, taskFile: z, facts, heartbeat }, { now: nowMs(env) });
      out = { id, team: z.team, ...evaluation, result_raw: (task && task.result) ?? null };
    } catch (e) { console.error(`provider-task: the evaluation is unavailable (${e.message}); the result without an evaluation`); }
  }
  // in_progress from the evaluation is not a verdict: no write, the output and exit code 0 as for a task in progress.
  const inProgress = out.status === STATUSES.IN_PROGRESS;
  const evaluated = { ...out };
  delete evaluated.result_raw;
  // The write only when a parallel wait has not written a verdict earlier; when overtaken, the saved one is printed (not this one).
  const written = !inProgress ? changeTask(id, env, (d) => (d.verdict ? null : { ...d, verdict: evaluated, verdict_ts: new Date().toISOString() })) : null;
  if (written === null && !inProgress) printSavedVerdict(readTask(id, env), id, env);
  if (written !== null && written.killed) out.status = 'killed'; // killed after the verdict wins in the output (a fresh object from under the lock)
  const header = taskHeader(id, env); // the header AFTER the write (with in_progress without a write the status in the file is still absent: `?`)
  if (header) out.header = header;
  console.log(JSON.stringify(out));
  process.exit(EXIT.OK);
}

// ===== kill =====
// kill <id>: killed (ISO) is written to the task file BEFORE `omc team shutdown <team> --force`; the process tree of the worker pane is closed by omc, here only the call; the exit code is that of omc (127 when it cannot be started).
function killCommand(rest) {
  const id = rest[0];
  if (!id) fail(EXIT.CONFIG, 'Usage: provider-task kill <id>');
  const z = readTask(id, env);
  if (!z || !z.team) fail(EXIT.CONFIG, `kill: no task file ${id} or no team field`);
  changeTask(id, env, (d) => ({ ...d, killed: new Date().toISOString() }));
  const r = callOmc(env, ['team', 'shutdown', z.team, '--force'], { cwd: z.cwd || process.cwd() });
  process.exit(r.status ?? (r.error ? EXIT.NO_BINARY : EXIT.FAILURE));
}

// ===== list =====
// list [--refresh]: all task files with id, team, start and the status from the file (killed -> killed, start_exit_code != 0 -> start_failed, otherwise unknown),
// without calling omc for each task; --refresh calls omc team api list-tasks per task and replaces the status with the status of the OMC task.
function listCommand(rest) {
  const refresh = rest.includes('--refresh');
  const dir = tasksDir();
  let entries = [];
  try { entries = readdirSync(dir); } catch { entries = []; }
  const out = [];
  for (const f of entries.filter((name) => /^([0-9a-f]{8})\.json$/.test(name)).sort()) {
    const id = f.slice(0, 8);
    const z = readTask(id, env);
    if (!z) continue;
    const row = { id: z.id || id, team: z.team ?? null, start: z.start ?? null, status: STATUSES.UNKNOWN };
    if (z.killed) row.status = 'killed';
    else if (z.start_exit_code != null && z.start_exit_code !== 0) row.status = 'start_failed';
    if (refresh) {
      // An OMC task that was found wins over start_exit_code; a failed omc call is not a missing task: in_progress with a message on stderr;
      // without a match the status from the file stays (start_failed).
      const { task, error } = readOmcTask(z, env);
      if (task) row.status = task.status ?? STATUSES.UNKNOWN;
      else if (error) { row.status = STATUSES.IN_PROGRESS; console.error(`provider-task: ${error}; showing in_progress`); }
    }
    out.push(row);
  }
  console.log(JSON.stringify(out));
  process.exit(EXIT.OK);
}

const USAGE = `Usage: provider-task <subcommand>
  doctor   - smoke test of the provider executor (claude -p with the settings of a provider worker)
  start [--cwd <dir>] [--brief <file>] [--max-tool-calls N] [--] <task text> - starts a task (a team of one worker); prints the id at once
  status <id>    - status of the task as JSON
  result <id>    - evaluation of the result as JSON (lib/task-result.cjs, or the injected module)
  kill <id>      - ends the team of the task (omc team shutdown --force; killed is written first)
  list [--refresh] - tasks from the state files (statuses from the files; --refresh asks omc)
  wait <id...> [--timeout S] [--any] [--limit S] - waits for tasks and delivers the result (lib/task-wait.cjs)`;
switch (argv[0]) {
  case 'doctor': doctor(); break;
  case 'start': startCommand(argv.slice(1)); break;
  case '_start': startInternal(argv[1]); break;
  case 'status': statusCommand(argv.slice(1)); break;
  case 'result': resultCommand(argv.slice(1)); break;
  case 'kill': killCommand(argv.slice(1)); break;
  case 'list': listCommand(argv.slice(1)); break;
  case 'wait': waitCommand(argv.slice(1)); break;
  default: fail(EXIT.CONFIG, USAGE);
}
