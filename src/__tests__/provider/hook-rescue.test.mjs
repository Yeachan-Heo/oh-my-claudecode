/* global process */
// Rescue hook of provider workers (scripts/provider/provider-hook-rescue.cjs, lib/hook-rescue.cjs): counter of failed check runs, failure signature,
// forced consultation, park, modes off/shadow/active. The state directory is set explicitly through OMC_PROVIDER_STATE_DIR.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { makeTmp } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const SCRIPT = join(process.cwd(), 'scripts', 'provider', 'provider-hook-rescue.cjs');
const R = require('../../../scripts/provider/provider-hook-rescue.cjs');
const rescue = require('../../../scripts/provider/lib/hook-rescue.cjs');
const js = JSON.stringify;

describe.skipIf(process.platform === 'win32')('provider hook rescue', () => {
  let tmp;
  let STATE;
  beforeAll(() => { tmp = makeTmp('provider-rescue-'); STATE = join(tmp.dir, 'state'); });
  afterAll(() => { tmp.cleanup(); });

  const env = (override = {}) => ({
    PATH: process.env.PATH, HOME: tmp.home, OMC_PROVIDER: 'acme', OMC_PROVIDER_STATE_DIR: STATE,
    OMC_PROVIDER_RESCUE: 'active', OMC_PROVIDER_RESCUE_THRESHOLD: '2', OMC_PROVIDER_RESCUE_ADVISOR_LIMIT: '2', ...override,
  });
  const post = (command, response, session, override = {}) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: response, session_id: session, ...override });
  const pre = (command, session, override = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: session, ...override });
  const failedRun = (n, extra = '') => `test stdout\nExit code 1\n${n} tests failed${extra}`;
  const readState = (key) => JSON.parse(readFileSync(join(STATE, 'tasks', key, 'counter.json'), 'utf8'));
  const clean = () => rmSync(STATE, { recursive: true, force: true });
  const readLog = () => (existsSync(join(STATE, 'rescue', 'rescue.jsonl')) ? readFileSync(join(STATE, 'rescue', 'rescue.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const answer = (input, override = {}) => R.rescueResponse(input, env(override));

  it('(M1) offline measure: 100 synthetic trajectories (5 groups of 20): 0 rescues with falling failure counts; a rescue at the 2nd identical failure without progress in 100 % of the rest', () => {
    const generate = (name, texts) => Array.from({ length: 20 }, (_, i) => ({ id: `tr-${name}-${i}`, texts }));
    const groups = [
      generate('falling', ['5 tests failed', '4 tests failed', '3 tests failed', '2 tests failed']), // progress: a falling number of failures
      generate('steady', ['3 tests failed', '3 tests failed', '3 tests failed', '3 tests failed']),
      generate('rising', ['1 tests failed', '2 tests failed', '3 tests failed', '4 tests failed']),
      generate('attempt', ['attempt 1/3 timed out', 'attempt 2/3 timed out', '3 tests failed', 'attempt 3/3 timed out']),
      generate('masking', ['3 tests failed (0.412 s) a3f9c2d81b7e4f6a /tmp/r1 x.go:12', '3 tests failed (0.398 s) 8e1d4c5b9a2f3e7c /tmp/r2 x.go:13', '3 tests failed (0.521 s) 6f8e2a4c1d3b5e7f /tmp/r3 x.go:14']),
    ];
    let fallingRescues = 0;
    let okRest = 0;
    const restTotal = 80;
    for (const [gi, group] of groups.entries()) {
      for (const tr of group) {
        clean();
        const hints = [];
        for (const text of tr.texts) {
          R.rescueResponse(post(`node --test tests/${tr.id}.mjs`, `Exit code 1\n${text}`, tr.id), env());
          hints.push(readLog().filter((row) => row.event === 'hint').length);
        }
        if (gi === 0) { if (hints.some((x) => x > 0)) fallingRescues += 1; }
        else if (hints[0] === 0 && hints[1] === 1) okRest += 1;
      }
    }
    expect(fallingRescues, `falling failure counts gave a rescue in ${fallingRescues}/20 trajectories`).toBe(0);
    expect(okRest, `rescue at the 2nd failure without progress: ${okRest}/${restTotal}`).toBe(restTotal);
  }, 120000);

  it('(1) classification of a check run: test/build/lint yes, a pipe and a chain no, ordinary commands no', () => {
    const yes = ['node --test tests/x.mjs', 'pytest', 'go test ./...', 'npm run build', 'tsc --noEmit', 'eslint .', 'ruff check .', 'cargo test', 'make check', 'npm test'];
    const no = ['ls -la', 'cat file.txt', 'echo test', 'npm run build && npm test', 'go test ./... | tee log', 'pytest; echo done', 'git status'];
    expect(yes.filter((c) => !R.isCheckRun(c)), 'wrongly rejected').toEqual([]);
    expect(no.filter((c) => R.isCheckRun(c)), 'wrongly accepted').toEqual([]);
  });

  it('(2) signature: the same despite edits (masking of hex, temporary paths, time, numbers); different commands give different ones', () => {
    const a1 = R.signature('command-a', 'failed /tmp/r-2026-11-14/x a3f9c2d81b7e4f6a 0.412 s: expected 3, got 5');
    const a2 = R.signature('command-b', 'failed /tmp/r-2026-11-14/y 16-hex 0.398 s: expected 3, got 4');
    expect(a1, 'different commands gave the same signature').not.toBe(a2);
    const b1 = R.signature('command', 'failed /tmp/r-a/2026-11-14T10:00:00Z a3f9c2d81b7e4f6a 0.412 s: expected 3');
    const b2 = R.signature('command', 'failed /tmp/r-b/2026-11-14T10:00:01Z 8e1d4c5b9a2f3e7c 0.521 s: expected 3');
    expect(b1, 'normalization did not mask time, hex or a temporary path').toBe(b2);
    const c1 = R.signature('command', '3 tests failed');
    const c2 = R.signature('command', '4 tests failed');
    expect(c1, 'different failure counts not masked in the signature (numbers become markers, progress is counted by failureCount)').toBe(c2);
  });

  it('(3) progress: a falling failure count does not count toward the loop series; a steady count, a rise and attempt N/M do', () => {
    const cmd = 'node --test tests/p.mjs';
    clean();
    for (const n of [5, 4, 3]) answer(post(cmd, failedRun(n), 'p'));
    expect(readLog().filter((row) => row.event === 'hint').length, 'a falling count gave a hint').toBe(0);
    const st = readState('session-p');
    expect(st.repeats === 0 && st.failed_checks === 3, `state after a falling series: ${js(st)}`).toBe(true);
    clean();
    for (const n of [2, 2]) answer(post(cmd, failedRun(n), 'p2'));
    expect(readState('session-p2').repeats, 'a steady count did not add to the series').toBe(2);
    clean();
    for (const n of [1, 3]) answer(post(cmd, failedRun(n), 'p3'));
    expect(readState('session-p3').repeats, 'a rise did not add to the series').toBe(2);
    clean();
    answer(post(cmd, 'Exit code 124\nattempt 1/3 timed out', 'p4'));
    answer(post(cmd, 'Exit code 124\nattempt 2/3 timed out', 'p4'));
    expect(readState('session-p4').repeats, 'the attempt counter (attempt N/M) did not add to the series').toBe(2);
  });

  it('(4) measure (2), scenario 1: the second failure gives a hint, the third run: a denial in active mode with a request for a consultation', () => {
    clean();
    const cmd = 'node --test tests/x.mjs';
    expect(answer(post(cmd, failedRun(2), 's1')), 'the first failure without a decision').toBe(null);
    const r2 = answer(post(cmd, failedRun(2), 's1'));
    expect(r2 && r2.hookSpecificOutput.additionalContext && r2.hookSpecificOutput.additionalContext.includes('provider-advisor "RESCUE:'), 'a hint with the consultation command').toBeTruthy();
    const r3 = answer(pre(cmd, 's1'));
    expect(r3 && r3.hookSpecificOutput.permissionDecision === 'deny' && /provider-advisor "RESCUE:/.test(r3.hookSpecificOutput.permissionDecisionReason), 'a denial of the third run with a request for a consultation').toBeTruthy();
    expect(r3.hookSpecificOutput.permissionDecisionReason.includes('test stdout'), 'the denial has no raw command output (only the redacted error line)').toBe(false);
    expect(readLog().map((row) => row.event), 'log').toEqual(['failure', 'hint', 'denial']);
  });

  it('(5) measure (2), scenario 2: after a consultation the counter is 0; the next run is let through', () => {
    clean();
    const cmd = 'node --test tests/x.mjs';
    answer(post(cmd, failedRun(2), 's2'));
    answer(post(cmd, failedRun(2), 's2'));
    expect(answer(pre(cmd, 's2')), 'a denial before the consultation').not.toBe(null);
    expect(answer(post('provider-advisor "RESCUE: signature"', 'ADVISOR: change', 's2')), 'a consultation without a decision').toBe(null);
    const st = readState('session-s2');
    expect(st.consultations === 1 && st.rounds === 1 && st.failed_checks === 0 && st.repeats === 0 && st.awaiting_consultation === false, `state after a consultation: ${js(st)}`).toBe(true);
    expect(answer(pre(cmd, 's2')), 'a run after the consultation is let through').toBe(null);
  });

  it('(6) measure (2), scenario 3: after two consultations a park; the denial asks to close the task with fail-task and an error with NEED: (first non-empty line) and BLOCKED: (second)', () => {
    clean();
    const cmd = 'node --test tests/x.mjs';
    const step = () => answer(post(cmd, failedRun(2), 's3'));
    step(); step();
    answer(post('provider-advisor "RESCUE"', 'ADVISOR: change', 's3')); // consultation 1
    step(); step();
    answer(post('provider-advisor "RESCUE"', 'ADVISOR: change', 's3')); // consultation 2
    step(); // series 3: failure 1
    const parkResponse = step(); // failure 2: park
    const parkText = parkResponse && parkResponse.hookSpecificOutput.additionalContext;
    expect(parkText && parkText.includes('PARK'), 'park: additionalContext PARK').toBeTruthy();
    expect(parkText.indexOf('NEED:') !== -1 && parkText.indexOf('BLOCKED:') !== -1 && parkText.indexOf('NEED:') < parkText.indexOf('BLOCKED:'), 'park: NEED: before BLOCKED:').toBe(true);
    expect(parkText.includes('fail-task'), 'park: fail-task with an error field (omc team worker protocol)').toBe(true);
    const run = answer(pre(cmd, 's3'));
    const denial = run && run.hookSpecificOutput.permissionDecisionReason;
    expect(run && run.hookSpecificOutput.permissionDecision === 'deny', 'park denial').toBe(true);
    expect(denial.indexOf('NEED:') !== -1 && denial.indexOf('BLOCKED:') !== -1 && denial.indexOf('NEED:') < denial.indexOf('BLOCKED:'), 'park denial: NEED: before BLOCKED:').toBe(true);
    expect(denial.includes('fail-task'), 'park denial: fail-task in the text').toBe(true);
    expect(readState('session-s3').parked, 'parked state').toBe(true);
    expect(readLog().filter((row) => row.event === 'park').length, 'the park event written once').toBe(1);
  });

  it('(7) shadow: events written, zero denials and zero additionalContext; off: nothing, not even state files', () => {
    clean();
    const shadow = { OMC_PROVIDER_RESCUE: 'shadow' };
    const cmd = 'node --test tests/x.mjs';
    expect(answer(post(cmd, failedRun(2), 'sh'), shadow), 'shadow: a failure without output').toBe(null);
    expect(answer(post(cmd, failedRun(2), 'sh'), shadow), 'shadow: a second failure without output').toBe(null);
    expect(readLog().map((row) => row.event), 'shadow: events written').toEqual(['failure', 'hint']);
    expect(answer(pre(cmd, 'sh'), shadow), 'shadow: a run without a denial').toBe(null);
    const offState = join(tmp.dir, 'state-off');
    expect(R.rescueResponse(post(cmd, failedRun(2), 'x'), env({ OMC_PROVIDER_RESCUE: 'off', OMC_PROVIDER_STATE_DIR: offState })), 'off: a failure without a decision').toBe(null);
    expect(existsSync(offState), 'off: no state files').toBe(false);
  });

  it('(8) circuit breaker: three denials release the gate (the fourth attempt passes), a breaker row once, breaker state', () => {
    clean();
    const cmd = 'node --test tests/x.mjs';
    answer(post(cmd, failedRun(2), 'wl'));
    answer(post(cmd, failedRun(2), 'wl'));
    expect(answer(pre(cmd, 'wl')), 'denial 1').not.toBe(null);
    expect(answer(pre(cmd, 'wl')), 'denial 2').not.toBe(null);
    expect(answer(pre(cmd, 'wl')), 'denial 3').not.toBe(null);
    expect(answer(pre(cmd, 'wl')), 'the fourth attempt is let through (breaker)').toBe(null);
    expect(readLog().filter((row) => row.event === 'breaker').length, 'a breaker row once').toBe(1);
    expect(readState('session-wl').breaker === true && readState('session-wl').gate_denials === 3, 'state: breaker and gate_denials 3').toBe(true);
  });

  it('(9) parameters: a bad value of the mode, threshold or limit gives a message on stderr and the default (rescueParams)', () => {
    const errors = [];
    const p = rescue.rescueParams({ OMC_PROVIDER_RESCUE: 'TURBO', OMC_PROVIDER_RESCUE_THRESHOLD: 'x', OMC_PROVIDER_RESCUE_ADVISOR_LIMIT: '-3' }, (t) => errors.push(t));
    expect(p.mode === 'off' && p.threshold === 2 && p.limit === 2, `defaults: ${js(p)}`).toBe(true);
    expect(errors.length === 3 && errors.every((t) => /disallowed/.test(t)), `stderr messages: ${js(errors)}`).toBe(true);
    const p2 = rescue.rescueParams({ OMC_PROVIDER_RESCUE: 'shadow', OMC_PROVIDER_RESCUE_THRESHOLD: '3', OMC_PROVIDER_RESCUE_ADVISOR_LIMIT: '0' }, (t) => errors.push(t));
    expect(p2.mode === 'shadow' && p2.threshold === 3 && p2.limit === 0, 'valid values pass').toBe(true);
    const p3 = rescue.rescueParams({}, (t) => errors.push(t));
    expect(p3.mode === 'off' && p3.threshold === 2 && p3.limit === 2 && p3.model === 'opus', 'defaults: off/2/2/opus').toBe(true);
  });

  it('(9b) script process: a bad mode value: exit 0 with no decision; a damaged input: exit 0 (safeguard)', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { input: js(pre('ls', 'x')), encoding: 'utf8', env: env({ OMC_PROVIDER_RESCUE: 'bad' }) });
    expect(r.status === 0 && !r.stdout.trim(), `a bad mode value: exit 0 with no decision (status ${r.status}, stdout: ${r.stdout.slice(0, 80)})`).toBe(true);
    const u = spawnSync(process.execPath, [SCRIPT], { input: '{ this is not json', encoding: 'utf8', env: env({ OMC_PROVIDER_RESCUE: 'active' }) });
    expect(u.status === 0 && !u.stdout.trim(), `a damaged input: exit 0 (status ${u.status})`).toBe(true);
  });

  it('(10) hook without a script: with active a denial, with shadow a pass (rescueCommand)', () => {
    const script = join(tmp.dir, 'no-rescue-script');
    const a = spawnSync('/bin/sh', ['-c', rescue.rescueCommand(script, 'active')], { input: js(pre('ls', 'x')), encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(a.status === 0 && JSON.parse(a.stdout).hookSpecificOutput.permissionDecision === 'deny', 'no script in active mode: denial').toBe(true);
    const s = spawnSync('/bin/sh', ['-c', rescue.rescueCommand(script, 'shadow')], { input: js(pre('ls', 'x')), encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(s.status === 0 && s.stdout.trim() === '', 'no script in shadow mode: a safe pass').toBe(true);
    const z = spawnSync('/bin/sh', ['-c', rescue.rescueCommand(SCRIPT, 'active')], { input: js(pre('ls -la', 'x')), encoding: 'utf8', env: env() });
    expect(z.status === 0 && z.stdout.trim() === '', 'the real script: an ordinary command passes').toBe(true);
  });

  it('(17) a stale empty lock (mtime 2 min ago) is taken over (the counter is written); a fresh empty lock is not (waiting as for a live owner, no write, the foreign lock untouched)', () => {
    clean();
    const cmd = 'node --test tests/x.mjs';
    mkdirSync(join(STATE, 'tasks', 'session-z1'), { recursive: true });
    const lock1 = join(STATE, 'tasks', 'session-z1', 'counter.json.lock');
    writeFileSync(lock1, '', { mode: 0o600 });
    const old = new Date(Date.now() - 120000);
    utimesSync(lock1, old, old);
    expect(answer(post(cmd, failedRun(1), 'z1')), 'a stale empty lock: the first failure without a decision').toBe(null);
    expect(existsSync(join(STATE, 'tasks', 'session-z1', 'counter.json')), 'a stale empty lock: taken over, counter written').toBe(true);
    expect(existsSync(lock1), 'a stale empty lock: removed after the write').toBe(false);
    mkdirSync(join(STATE, 'tasks', 'session-z2'), { recursive: true });
    const lock2 = join(STATE, 'tasks', 'session-z2', 'counter.json.lock');
    writeFileSync(lock2, '', { mode: 0o600 });
    expect(answer(post(cmd, failedRun(1), 'z2')), 'a fresh empty lock: no decision').toBe(null);
    expect(existsSync(join(STATE, 'tasks', 'session-z2', 'counter.json')), 'a fresh empty lock: counter not written').toBe(false);
    expect(existsSync(lock2), 'a fresh empty lock: the foreign lock untouched').toBe(true);
  }, 30000);

  it('(18) counter.json after a failure with a secret assignment (API_KEY=x npm test) holds neither API_KEY, the secret value nor a last-command field', () => {
    clean();
    const cmd = 'API_KEY=secret-x npm test';
    answer(post(cmd, failedRun(2), 'sk'));
    answer(post(cmd, failedRun(2), 'sk'));
    const text = readFileSync(join(STATE, 'tasks', 'session-sk', 'counter.json'), 'utf8');
    expect(!text.includes('API_KEY') && !text.includes('secret-x'), 'no command text and no secret in the counter').toBe(true);
    expect(text.includes('last_command'), 'no last-command field').toBe(false);
    expect(JSON.parse(text).failed_checks, 'the counter still counts failures').toBe(2);
  });

  it('(19) PostToolUseFailure with an error field: the second failure gives a hint; is_interrupt does not count toward the counter and does not reset the series', () => {
    clean();
    const cmd = 'node --test tests/x.mjs';
    const postFailure = (session, extra = {}) => ({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: cmd }, error: 'Exit code 1\n3 tests failed', session_id: session, ...extra });
    expect(answer(postFailure('f1')), 'the first failure without a decision').toBe(null);
    const r2 = answer(postFailure('f1'));
    expect(r2 && r2.hookSpecificOutput.additionalContext.includes('RESCUE'), 'a hint at the second failure from PostToolUseFailure').toBeTruthy();
    clean();
    answer(postFailure('f2')); // failure 1
    expect(answer(postFailure('f2', { is_interrupt: true })), 'an interrupt without a decision').toBe(null);
    const st = readState('session-f2');
    expect(st.failed_checks === 1 && st.repeats === 1, `an interrupt did not count and did not reset the series: ${js(st)}`).toBe(true);
    expect(st.last_green_ts, 'an interrupt is not a green check').toBe(null);
  });

  it('(20) PostToolUse with tool_response as an object { stdout, stderr, interrupted } is recognized like a string: the second failure gives a hint, the signature equals the string version', () => {
    clean();
    const cmd = 'node --test tests/x.mjs';
    const response = { stdout: 'test stdout', stderr: 'Exit code 1\n3 tests failed', interrupted: false };
    expect(answer(post(cmd, response, 'o1')), 'the first failure (object) without a decision').toBe(null);
    const r2 = answer(post(cmd, response, 'o1'));
    expect(r2 && r2.hookSpecificOutput.additionalContext.includes('RESCUE'), 'object tool_response: a hint at the second failure').toBeTruthy();
    expect(readState('session-o1').signature, 'the signature from an object equals the string version').toBe(R.signature(cmd, 'test stdout\nExit code 1\n3 tests failed'));
  });

  it('(21) two parallel calls (separate processes) for the same key raise the counter by 2 (read under the lock)', async () => {
    clean();
    const input = js(post('node --test tests/rw.mjs', failedRun(1), 'rw'));
    const one = () => new Promise((done) => {
      const c = spawn(process.execPath, [SCRIPT], { env: env() });
      c.stdin.end(input);
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('close', () => done(out));
    });
    await Promise.all([one(), one()]);
    expect(readState('session-rw').failed_checks, `two parallel calls: counter 2 (without a lock it would be 1): ${js(readState('session-rw'))}`).toBe(2);
  }, 30000);

  it('opt-in: without OMC_PROVIDER_RESCUE (off by default) a failing series does nothing and writes nothing; addRescue registers hooks only when the mode is not off', () => {
    clean();
    const cmd = 'node --test tests/x.mjs';
    const noMode = { PATH: process.env.PATH, OMC_PROVIDER_STATE_DIR: STATE };
    expect(R.rescueResponse(post(cmd, failedRun(2), 'opt'), noMode)).toBe(null);
    expect(R.rescueResponse(post(cmd, failedRun(2), 'opt'), noMode)).toBe(null);
    expect(existsSync(STATE)).toBe(false);
    const off = rescue.addRescue({}, { env: noMode, team: 'ptask-0123abcd-x', script: SCRIPT });
    expect(off.hooks).toBeUndefined();
    expect(off.env.OMC_PROVIDER_RESCUE === 'off' && off.env.OMC_PROVIDER_TASK_ID === '0123abcd').toBe(true);
    const active = rescue.addRescue({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } }, { env: { OMC_PROVIDER_RESCUE: 'active' }, team: 'plain-team', script: SCRIPT });
    expect(Object.keys(active.hooks).sort()).toEqual(['PostToolUse', 'PostToolUseFailure', 'PreToolUse']);
    expect(active.hooks.PreToolUse.length).toBe(2);
    expect(active.env.OMC_PROVIDER_TASK_ID).toBeUndefined();
  });
});
