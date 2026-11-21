#!/usr/bin/env node
'use strict';
// Rescue trigger of a provider worker: a counter of failed check runs, a failure signature, a forced consultation, a park.
// Registered in the --settings file of the worker by addRescue (lib/hook-rescue.cjs).
// Events: PreToolUse (Bash): a gate that denies the next check run when a series of failures with the same signature and no progress reached
// the threshold, with a request for a consultation; the park and a circuit breaker. PostToolUse and PostToolUseFailure (Bash): classification
// of the check run, the failure signature, progress, the counter; a successful consultation (the advisor command by its bare name, exit code 0)
// resets the counter.
// After the consultation limit is used up and one more failure of the same signature without progress: park (denial of further runs and a
// request to close the task: in an omc team a fail-task with an error field whose first non-empty line is NEED: and whose second is
// BLOCKED: <signature>; in a session without a team these two lines at the end of the answer).
// Modes (OMC_PROVIDER_RESCUE): off (default), shadow (only rescue.jsonl, no denials, no additionalContext), active (full work).
// Progress: a falling number of failures read from the error text; a rise, no change and "attempt N/M" are no progress (a loop).
// Signature: the command plus the error after normalization (uuid, hex, temporary paths, times, numbers replaced by markers, 160 characters),
// stable between edits of the code.
// Check run: a test, build, typecheck or lint command without a pipe, &&, || or ; (those mask the exit code).
// State: <stateDir>/tasks/<key>/counter.json (key: OMC_PROVIDER_TASK_ID or session-<session_id>).
// Events log: <stateDir>/rescue/rescue.jsonl (no command text and no secrets; the error line in a denial passes through mask).
// Circuit breaker: three consecutive denials of this gate release it for the rest of the session (a breaker row, once). The park is final
// and is not subject to the breaker.
// Safety: errors of the hook itself end with exit 0 and no decision. A time signal is not used.
const { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const { mask } = require('./lib/redact.cjs');
const { rescueParams } = require('./lib/hook-rescue.cjs');
const { advisorModel, stateDirOf } = require('./lib/profile.cjs');

// Provider state directory (same rule as the other hooks: OMC_PROVIDER_STATE_DIR from the settings env block).
const stateDir = (env = process.env) => stateDirOf({ name: env.OMC_PROVIDER || 'default' }, env);

const modelOk = (model) => model !== null && model !== undefined && advisorModel({}, { OMC_PROVIDER_ADVISOR_MODEL: model }) === model; // a bad value: the advisor refuses the consultation with exit code 2; the hook warns in the denial

// ---- classification of a check run (test/build/typecheck/lint without a pipe, &&, || or ;: those mask the exit code) ----
const CHECK_BINARIES = new Set(['pytest', 'py.test', 'vitest', 'jest', 'mocha', 'tsc', 'tsgo', 'mypy', 'pyright', 'eslint', 'biome', 'ruff', 'pylint', 'rubocop', 'golangci-lint', 'shellcheck']);
const CHECK_SUBCOMMANDS = new Set(['test', 'tests', 'spec', 'specs', 'build', 'compile', 'typecheck', 'type-check', 'lint', 'check', 'checks', 'verify', 'ci']);
function isCheckRun(command) {
  const t = String(command ?? '').trim();
  if (!t || /&&|\|\||\|\s*\S|[;&]\s*\S|\n/.test(t)) return false; // a pipe or a chain: the exit code is masked, not a clean check run
  const tokens = t.split(/\s+/);
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i] === 'cd')) i += tokens[i] === 'cd' ? 2 : 1; // assignments and cd at the start
  if (i >= tokens.length) return false;
  const prog = tokens[i].split('/').pop();
  if (CHECK_BINARIES.has(prog)) return true;
  if (['npm', 'npx', 'pnpm', 'yarn', 'bun', 'pnpx'].includes(prog)) { // npm test | npm run <target>
    const rest = tokens.slice(i + 1).filter((x) => !x.startsWith('-'));
    const run = rest.findIndex((x) => x === 'run' || x === 'run-script');
    const target = run >= 0 ? rest[run + 1] : rest[0];
    return !!target && CHECK_SUBCOMMANDS.has(target);
  }
  if (prog === 'node') return tokens.slice(i + 1).includes('--test'); // node --test <files>
  if (prog === 'go') { const p = tokens.slice(i + 1).find((x) => !x.startsWith('-')); return p === 'test' || p === 'vet'; }
  if (prog === 'cargo') { const p = tokens.slice(i + 1).find((x) => !x.startsWith('-')); return ['test', 'build', 'check', 'clippy'].includes(p); }
  if (prog === 'make') { const p = tokens.slice(i + 1).find((x) => !x.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x)); return CHECK_SUBCOMMANDS.has(p); }
  return false;
}

// ---- failure signature: the command plus the error after normalization; stable between edits of the code ----
function normalize(text) {
  let s = String(text ?? '');
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{uuid}');
  s = s.replace(/\b[0-9a-f]{16,}\b/gi, '{hex}');
  s = s.replace(/(?:\/var\/tmp|\/tmp|\/\.claude|\.tmp)\/[^\s:'"`,;)]+/g, '{path}');
  s = s.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '{time}');
  s = s.replace(/\b\d{1,2}:\d{2}:\d{2}\b/g, '{time}');
  s = s.replace(/\b\d+(\.\d+)?\s*ms\b/gi, '{ms}');
  s = s.replace(/\b\d+(\.\d+)?\s*s\b/gi, '{s}');
  s = s.replace(/\d+/g, '{n}');
  return s.trim().slice(0, 160);
}
const signature = (command, error) => createHash('sha256').update(`${String(command ?? '').trim()}\n${normalize(error)}`).digest('hex').slice(0, 16);

// ---- progress: a falling number of failures; a rise, no change and "attempt N/M" are no progress ----
function failureCount(text) {
  const s = String(text ?? '');
  const patterns = [/(\d+)\s+(?:test|tests|spec|specs)\s+(failed|failing)/i, /(\d+)\s+(?:failed|failing|failures?)/i, /(\d+)\s+(?:errors?|problems?|assertions?)\b/i, /\battempt\s+(\d+)\s*\/\s*\d+/i, /(\d+)\s*\/\s*\d+\s+(?:passed|failed|tests)/i];
  for (const pattern of patterns) { const m = pattern.exec(s); if (m) return Number(m[1]); }
  return null;
}

// ---- consultation: the advisor command (OMC_PROVIDER_ADVISOR_COMMAND), only by its bare name (no slash; the guard lets only the bare name through) ----
const advisorCommand = (env) => String(env.OMC_PROVIDER_ADVISOR_COMMAND || '').trim() || 'provider-advisor';
const isBareAdvisor = (command, env = process.env) => { const first = String(command ?? '').trim().split(/\s+/)[0] || ''; return first === advisorCommand(env) && !first.includes('/'); };

// ---- PostToolUse result: the Bash exit code is not a separate field of the hook input; read tool_response and the "Exit code N" prefix (a Claude Code prefix) and the isError field of the response object ----
function postToolResult(event) {
  const response = event?.tool_response;
  // a real PostToolUse event has tool_response as an object (stdout, stderr, interrupted, ...); join stdout+stderr+result into one text so an error in stderr is visible as it is in a string
  const text = typeof response === 'string' ? response : response && typeof response === 'object' ? [response.stdout, response.stderr, response.result].filter((x) => typeof x === 'string' && x.length > 0).join('\n') : String(response ?? '');
  const m = /Exit code (\d+)/.exec(text);
  const code = m ? Number(m[1]) : null;
  if (response && typeof response === 'object' && response.isError === true) return { failed: true, code, text };
  if (event?.isError === true) return { failed: true, code, text };
  if (code === null && /^\s*\d+\s+(?:tests?|specs?)\s+(?:failed|failing)\b/im.test(text)) return { failed: true, code: null, text }; // a silent failure: the result text reports an error, no code prefix
  if (code === null) return { failed: false, code: 0, text }; // no prefix: the command ended with code 0
  return { failed: code !== 0, code, text };
}

// ---- state under a lock (for the counter.json file; the wait is cut to 2 s: the hook timeout is 10 s) ----
const PID_ALIVE = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } };
function tryLock(lockFile) {
  let pid = null;
  try {
    const fd = openSync(lockFile, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    closeSync(fd);
    return true;
  } catch (e) {
    if (!e || e.code !== 'EEXIST') throw e;
    try { pid = JSON.parse(readFileSync(lockFile, 'utf8')).pid; } catch { pid = null; } // empty or bad JSON (a hook interrupted between wx and write) is not a dead lock forever: unreadable content is judged by age (next line)
  }
  if (Number.isInteger(pid) && !PID_ALIVE(pid)) { try { unlinkSync(lockFile); } catch { /* race */ } return false; }
  try { if (Date.now() - statSync(lockFile).mtimeMs > 60000) { try { unlinkSync(lockFile); } catch { /* race */ } return false; } } catch { /* someone removed it */ }
  return false;
}
function withLock(file, fn) {
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + 2000;
  for (;;) {
    if (tryLock(lockFile)) {
      try { return fn(); } finally {
        try { const mine = JSON.parse(readFileSync(lockFile, 'utf8')); if (mine.pid === process.pid) unlinkSync(lockFile); } catch { /* taken over: do not touch someone else's lock */ }
      }
    }
    if (Date.now() > deadline) throw new Error(`lock ${lockFile} held longer than 2 s`);
    const t = Date.now();
    while (Date.now() - t < 50) { /* 50 ms */ }
  }
}
const atomicWrite = (file, data) => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`); renameSync(tmp, file); };

// ---- event row for rescue.jsonl (no command text and no secrets) ----
function logEvent(env, input, name, sig, counter, exitCode) {
  try {
    const dir = join(stateDir(env), 'rescue');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const row = { ts: new Date().toISOString(), session_id: typeof input?.session_id === 'string' ? input.session_id : null, job_id: env.OMC_TEAM_WORKER || null, event: name, signature_hash: sig || null, counter, exit_code: exitCode === null || exitCode === undefined ? null : Number(exitCode), diff_change: null }; // diff_change: the hook does not read the diff, the field stays
    appendFileSync(join(dir, 'rescue.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
  } catch { /* a missing log does not stop the session */ }
}

// ---- rescue package (text of the hint and of the denial; the error line passes through mask, no secrets and no quotes) ----
function rescuePackage(sig, repeats, line, state, p, advisor) {
  const lineMasked = mask(String(line ?? '')).replace(/["\n]/g, ' ').slice(0, 200) || 'no error text';
  const modelNote = modelOk(p.model) ? '' : '\nNOTE: OMC_PROVIDER_ADVISOR_MODEL has a disallowed value; the consultation will end with exit code 2. Do not loop: only the lead can fix the parameter.';
  return `RESCUE: the check run (test/build/typecheck/lint) has failed ${repeats} times without progress (signature ${sig}); the run was blocked before it started.
Last error (redacted): ${lineMasked}
Last green check: ${state.last_green_ts || 'none'}; whether the code changed since: unknown.
Before you retry the check, call the consultation with exactly this command (by its bare name):
  ${advisor} "RESCUE: signature ${sig} | attempts without progress: ${repeats} | last error: ${lineMasked}"
A successful consultation (exit code 0) resets the counter and releases this run. Consultations used: ${state.consultations}/${p.limit}.${modelNote}`;
}

// ---- park message (after the consultation limit is used up); in an omc team: fail-task with an error field (first non-empty line NEED:, second BLOCKED: <signature>), in a session without a team these two lines at the end of the answer ----
function parkMessage(sig, repeats, state, p) {
  return `PARK: the consultation limit (${state.consultations}/${p.limit}) is used up and the check run (signature ${sig}) has failed ${repeats} times without progress. Do not start further edits or checks.
In an omc team close the task with fail-task and an error field whose first non-empty line is NEED: <what exactly blocks progress> and whose second line is BLOCKED: ${sig}; in a session without a team end the answer with these two lines in this order.`;
}

// ---- helpers ----
function lastLine(text, command) {
  const lines = String(text ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
  if (lines.length) return lines[lines.length - 1].slice(0, 300);
  return String(command ?? '').slice(0, 120);
}
function failureDeclared(input) { return !(input && input.is_interrupt === true); } // PostToolUseFailure: a failure by the kind of event; an interrupt by a human does not count
function codeFromText(t) { const m = /Exit code (\d+)/.exec(String(t ?? '')); return m ? Number(m[1]) : null; }

// ---- initial state of the counter ----
const initialState = () => ({ failed_checks: 0, gate_denials: 0, rounds: 0, repeats: 0, signature: null, failures: null, failures_previous: null, consultations: 0, awaiting_consultation: false, parked: false, parked_written: false, breaker: false, last_green_ts: null, last_denial_ts: null, last_error: null });

// ---- main response of the hook: returns a decision object or null (let through) ----
function rescueResponse(data, env = process.env) {
  const p = rescueParams(env);
  if (p.mode === 'off') return null;
  let input;
  try { input = typeof data === 'string' ? JSON.parse(data) : data; } catch { return null; }
  const tool = String(input?.tool_name || '');
  const event = String(input?.hook_event_name || '');
  if (tool !== 'Bash') return null;
  const command = String(input?.tool_input?.command ?? '');
  const key = String(env.OMC_PROVIDER_TASK_ID || '').trim() || (typeof input?.session_id === 'string' && input.session_id ? `session-${input.session_id.replace(/[^A-Za-z0-9._-]/g, '_')}` : null);
  if (!key) return null;

  const taskDir = join(stateDir(env), 'tasks', key);
  const log = (name, sig, counter, code) => { try { logEvent(env, input, name, sig, counter, code); } catch { /* the log is best effort */ } };

  // no lock when the state is not needed: PostToolUse (PostToolUseFailure) of an ordinary command (not a check run and not the advisor) and PreToolUse in shadow (no denials and no counter write)
  if ((event === 'PostToolUse' || event === 'PostToolUseFailure') && !isBareAdvisor(command, env) && !isCheckRun(command)) return null;
  if (event === 'PreToolUse' && p.mode === 'shadow') return null;

  // read, change and write of the counter under one lock; a lock held longer than 2 s or an I/O error: the hook safeguard, let through with no decision
  let decision = null;
  try {
    mkdirSync(taskDir, { recursive: true, mode: 0o700 });
    decision = withLock(join(taskDir, 'counter.json'), () => {
      let state = initialState();
      try { state = { ...initialState(), ...JSON.parse(readFileSync(join(taskDir, 'counter.json'), 'utf8')) }; } catch { /* no counter: initial state */ }
      const save = () => { try { atomicWrite(join(taskDir, 'counter.json'), state); } catch { /* a failed counter write does not stop the session */ } };
      return eventDecision(input, command, event, state, { p, env, save, log });
    });
  } catch { decision = null; }
  return decision;
}

// ---- decision of an event: called under the counter lock (the state is read under the lock); ctx: p, env, save, log ----
function eventDecision(input, command, event, state, ctx) {
  const { p, env, save, log } = ctx;

  // a successful consultation resets the counter (a fresh window); an event other than PreToolUse, checked before the classification of a check run
  if (event !== 'PreToolUse' && isBareAdvisor(command, env)) {
    const r = event === 'PostToolUseFailure' ? { failed: true, code: null } : postToolResult(input);
    if (!r.failed) {
      state.consultations += 1;
      state.rounds += 1;
      state.repeats = 0;
      state.failed_checks = 0;
      state.signature = null;
      state.failures = null;
      state.awaiting_consultation = false;
      save();
      log('consultation', null, state.consultations, r.code);
      log('reset', null, 0, r.code);
      return null;
    }
    log('consultation-failure', null, state.consultations, r.code);
    return null;
  }

  // ---- PreToolUse: gate that denies the next check run (and the park); shadow is filtered out by the pre-filter before the lock ----
  if (event === 'PreToolUse') {
    if (!isCheckRun(command) || state.breaker) return null;
    if (state.parked) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: parkMessage(state.signature || '', state.repeats, state, p) } };
    if (state.awaiting_consultation) {
      if (state.gate_denials >= 3) { // circuit breaker: three denials happened, the fourth attempt is let through
        state.breaker = true;
        save();
        log('breaker', state.signature, state.gate_denials, null);
        return null;
      }
      state.gate_denials += 1;
      state.last_denial_ts = new Date().toISOString();
      const body = rescuePackage(state.signature, state.repeats, state.last_error, state, p, advisorCommand(env));
      save();
      log('denial', state.signature, state.gate_denials, null);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: body } };
    }
    return null;
  }

  // ---- PostToolUse / PostToolUseFailure: classification, signature, progress, counter; hint and park; ordinary commands are filtered out by the pre-filter before the lock ----
  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    if (event === 'PostToolUseFailure' && input?.is_interrupt === true) return null; // an interrupt by a human: no classification and no write; it neither resets the series nor sets last_green_ts
    const post = event === 'PostToolUseFailure' ? { failed: failureDeclared(input), code: codeFromText(input?.error), text: String(input?.error ?? '') } : postToolResult(input);
    const line = lastLine(post.text, command);
    if (!post.failed) { // a green check: the series is reset, the reference point for the rescue package
      state.repeats = 0; state.failed_checks = 0; state.signature = null; state.failures = null; state.awaiting_consultation = false; state.last_green_ts = new Date().toISOString();
      save();
      return null;
    }
    const sig = signature(command, post.text);
    state.failed_checks += 1;
    const count = failureCount(post.text);
    const same = state.signature === sig;
    const progress = same && state.failures !== null && count !== null && count < state.failures;
    if (same && !progress) state.repeats += 1;
    else { state.repeats = same && progress ? 0 : 1; state.failures_previous = state.failures; }
    state.failures = count;
    state.signature = sig;
    state.last_error = mask(String(line ?? '').slice(0, 200)); // the state has no secrets (the package is built from this field); the command text does not go to the state (nobody reads it, and assignments such as API_KEY=x do not pass through mask)
    if (state.parked) { save(); log('failure', sig, state.repeats, post.code); return null; }
    if (state.repeats >= p.threshold) {
      if (state.consultations >= p.limit) { // park: the limit is used up and one more failure of the same signature without progress
        state.parked = true;
        if (!state.parked_written) { state.parked_written = true; log('park', sig, state.repeats, post.code); }
        save();
        if (p.mode === 'shadow') return null; // shadow: no additionalContext
        return { continue: true, hookSpecificOutput: { hookEventName: event, additionalContext: parkMessage(sig, state.repeats, state, p) } };
      }
      state.awaiting_consultation = true;
      log('hint', sig, state.repeats, post.code);
      save();
      if (p.mode === 'shadow') return null; // shadow: no additionalContext
      return { continue: true, hookSpecificOutput: { hookEventName: event, additionalContext: rescuePackage(sig, state.repeats, line, state, p, advisorCommand(env)) } };
    }
    save();
    log('failure', sig, state.repeats, post.code);
  }
  return null;
}

module.exports = { rescueResponse, isCheckRun, normalize, signature, failureCount, isBareAdvisor, postToolResult, stateDir };
Object.assign(module.exports, { advisorCommand, failureDeclared, codeFromText, initialState, rescuePackage, parkMessage, logEvent });

if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('end', () => {
    let response = null;
    try { response = rescueResponse(data, process.env); } catch { response = null; } // safeguard: a hook error = exit 0 with no decision (the hook does not block work because of its own fault)
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    process.exit(0);
  });
}
