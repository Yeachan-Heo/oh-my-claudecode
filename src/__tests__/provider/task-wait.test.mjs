/* global process, console, setTimeout, URL */
// Waiting for provider tasks (lib/task-wait.cjs): everything on fakes (readTask, evaluate, writeJournal; a fake
// omc through OMC_PROVIDER_TASK_OMC_BIN). Covered: the result is written BEFORE delivery and delivered exactly
// once (also with a wait restarted midway and after delivery), timed_out at the timeout limits, --any returns at
// the first finished task, validation of --timeout and --limit, the growing polling delay (500 ms -> 2 s),
// --limit with shutdown --force and the timeout cause, handoff, the journal exactly once, the task file written
// under a lock (killed does not get lost). The clock is injected (now/sleep/sleepSync), so tests do not wait for real.
import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, writeProfile } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const LIB = fileURLToPath(new URL('../../../scripts/provider/lib/', import.meta.url));
const { wait } = require(join(LIB, 'task-wait.cjs'));
const CLOCK0 = 1_763_100_000_000; // fixed start moment of the test clock (ms)

const sub = (id) => `ptask-${id}`;
const EVAL_OK = { status: 'success', cause: null, gaps: null, required: null, unverified: null, evidence: null, points: null, handoff: false, errors: [] };

describe.skipIf(process.platform === 'win32')('provider task wait', () => {
  let tmp;
  beforeAll(() => { tmp = makeTmp('provider-wait-'); });
  afterAll(() => { tmp.cleanup(); });

  let nr = 0;
  // Environment of one case: a profile with its own state dir, a task directory, an injected clock and a task file with the full schema.
  const environment = () => {
    const dir = join(tmp.dir, `case-${++nr}`);
    mkdirSync(dir, { recursive: true });
    const { env } = writeProfile(dir);
    const tasks = join(dir, 'state', 'tasks');
    mkdirSync(tasks, { recursive: true });
    const clock = { t: CLOCK0, now: () => clock.t, pauses: [] };
    clock.sleep = async (ms) => { clock.pauses.push(ms); clock.t += ms; };
    clock.sleepSync = (ms) => { clock.t += ms; };
    const file = (id) => join(tasks, `${id}.json`);
    const save = (id, fields = {}) => writeFileSync(file(id), JSON.stringify({ id, team: sub(id), start: new Date(CLOCK0 - 60_000).toISOString(), cwd: dir, brief: null, killed: null, abandon: null, limit_s: null, verdict: null, verdict_ts: null, delivered: null, ...fields }, null, 2) + '\n');
    const read = (id) => JSON.parse(readFileSync(file(id), 'utf8'));
    const common = { env, now: clock.now, sleep: clock.sleep, sleepSync: clock.sleepSync };
    return { dir, env, clock, file, save, read, common };
  };

  // Fake `omc` (CommonJS, executed through its shebang): writes argv to a file and prints a fixed JSON answer; an optional exit code.
  const fakeOmc = (dir, { argvFile, answer = '{}', code = 0 }) => {
    const p = join(dir, 'omc-fake.cjs');
    writeFileSync(p, `#!${process.execPath}
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(${JSON.stringify(answer)});
process.exit(${Number(code)});
`, { mode: 0o755 });
    return p;
  };

  it('(1) the evaluation is written durably to the task file BEFORE delivery; the journal is called once, after delivered, and sees the verdict and delivered', async () => {
    const s = environment();
    const id = 'a1b2c3d4';
    s.save(id);
    let journalCalls = 0;
    const snapshots = [];
    const r = await wait({
      ids: [id], ...s.common,
      readTask: async () => ({ id: '1', subject: `${sub(id)} test task`, status: 'completed', result: 'Status: success\nSummary: ok' }),
      evaluate: async ({ task, taskFile }) => {
        assert.equal(task.status, 'completed');
        assert.equal(taskFile.id, id);
        return { ...EVAL_OK };
      },
      writeJournal: async (i) => { journalCalls++; assert.equal(i, id); snapshots.push(s.read(i)); },
    });
    assert.deepEqual(r, { results: [{ id, status: 'success', verified: true, error: '-', handoff: false, cause: null }], in_progress: 0, timed_out: false, handoff: false });
    const d = s.read(id);
    assert.equal(d.verdict.status, 'success');
    assert.ok(d.verdict_ts && !Number.isNaN(Date.parse(d.verdict_ts)));
    assert.ok(d.delivered && !Number.isNaN(Date.parse(d.delivered)));
    assert.ok(Date.parse(d.delivered) >= Date.parse(d.verdict_ts), 'delivery not earlier than writing the verdict');
    assert.equal(journalCalls, 1);
    assert.ok(snapshots[0].verdict && snapshots[0].delivered, 'at the journal call the verdict and delivered are already written');
  });

  it('(2) delivery exactly once: a wait restarted midway (file with a verdict, without delivered): wait 2 delivers, the verdict is untouched, the journal once', async () => {
    const s = environment();
    const id = 'b2c3d4e5';
    const verdict1 = { ...EVAL_OK };
    // The intermediate state left by a wait 1 that died right after writing the verdict: verdict and verdict_ts exist, delivered does not.
    s.save(id, { verdict: verdict1, verdict_ts: new Date(CLOCK0 - 1000).toISOString() });
    let reads = 0;
    let journalCalls = 0;
    const r = await wait({
      ids: [id], ...s.common,
      readTask: async () => { reads++; return null; },
      evaluate: async () => { throw new Error('the evaluation must not run when the verdict is already in the file'); },
      writeJournal: async () => { journalCalls++; },
    });
    assert.equal(reads, 0);
    const d = s.read(id);
    assert.deepEqual(d.verdict, verdict1);
    assert.ok(d.delivered);
    assert.equal(journalCalls, 1);
    assert.deepEqual(r.results[0], { id, status: 'success', verified: true, error: '-', handoff: false, cause: null });
    assert.equal(r.in_progress, 0);
    assert.equal(r.timed_out, false);
  });

  it('(3) a wait restarted AFTER delivery does not deliver a second time: delivered untouched, the journal not called, the row from the verdict in the file', async () => {
    const s = environment();
    const id = 'c3d4e5f6';
    const verdict1 = { status: 'partial_success', cause: null, gaps: 'no linter', required: null, unverified: null, evidence: null, points: null, handoff: false, errors: [] };
    const deliveredOld = new Date(CLOCK0 - 500).toISOString();
    s.save(id, { verdict: verdict1, verdict_ts: new Date(CLOCK0 - 1000).toISOString(), delivered: deliveredOld });
    let journalCalls = 0;
    const r = await wait({
      ids: [id], ...s.common,
      readTask: async () => { throw new Error('the read must not run when the result is already delivered'); },
      evaluate: async () => { throw new Error('the evaluation must not run when the result is already delivered'); },
      writeJournal: async () => { journalCalls++; },
    });
    const d = s.read(id);
    assert.equal(d.delivered, deliveredOld);
    assert.equal(journalCalls, 0);
    assert.deepEqual(r.results[0], { id, status: 'partial_success', verified: true, error: '-', handoff: false, cause: null });
    assert.equal(r.in_progress, 0);
    assert.equal(r.timed_out, false);
  });

  it('(4) timed_out at the --timeout limit: the task in_progress up to the deadline, in_progress=1, results empty, the file without a verdict and delivered', async () => {
    const s = environment();
    const id = 'd4e5f6a7';
    s.save(id);
    const r = await wait({
      ids: [id], timeoutS: 10, ...s.common,
      readTask: async () => ({ id: '1', subject: `${sub(id)} test task`, status: 'in_progress' }),
      evaluate: async () => { throw new Error('the evaluation must not run for a task in progress'); },
    });
    assert.equal(r.timed_out, true);
    assert.equal(r.in_progress, 1);
    assert.deepEqual(r.results, []);
    assert.equal(r.handoff, false);
    assert.ok(s.clock.t >= CLOCK0 + 10_000, 'the --timeout limit reached');
    const d = s.read(id);
    assert.equal(d.verdict, null);
    assert.equal(d.delivered, null);
  });

  it('(5) --any returns at the first finished task (id1 completed, id2 in_progress): results=[id1], in_progress=1, without a single pause', async () => {
    const s = environment();
    const id1 = 'e5f6a7b8';
    const id2 = 'f6a7b8c9';
    s.save(id1);
    s.save(id2);
    const r = await wait({
      ids: [id1, id2], any: true, ...s.common,
      readTask: async (i) => (i === id1
        ? { id: '1', subject: `${sub(id1)} test task`, status: 'completed', result: 'Status: success' }
        : { id: '2', subject: `${sub(id2)} test task`, status: 'in_progress' }),
      evaluate: async () => ({ ...EVAL_OK }),
    });
    assert.deepEqual(r.results, [{ id: id1, status: 'success', verified: true, error: '-', handoff: false, cause: null }]);
    assert.equal(r.in_progress, 1);
    assert.equal(r.timed_out, false);
    assert.equal(s.clock.pauses.length, 0, 'returns at once, without polling after a finished task');
    assert.ok(s.clock.t < CLOCK0 + 30_000, 'does not wait for the deadline');
  });

  it('(6) --timeout validation: 0, -5, "abc" and "" are rejected with code 2; without the option the default is 30 s', async () => {
    const s = environment();
    const id = 'a7b8c9d0';
    s.save(id);
    const code2 = (e) => e.errorCode === 2;
    for (const bad of [0, -5, 'abc', '']) {
      await assert.rejects(wait({ ids: [id], timeoutS: bad, ...s.common, readTask: async () => null }), code2);
    }
    await assert.rejects(wait({ ids: [], env: s.env, readTask: async () => null }), code2);
    await assert.rejects(wait({ ids: ['too-short'], env: s.env, readTask: async () => null }), code2);
    // --limit is validated the same way
    await assert.rejects(wait({ ids: [id], limitS: 0, env: s.env, readTask: async () => null }), code2);
    await assert.rejects(wait({ ids: [id], limitS: 'long', env: s.env, readTask: async () => null }), code2);
    // default timeout 30 s: deadline = CLOCK0 + 30 000 (checked through timed_out with a fake in progress)
    const r = await wait({ ids: [id], ...s.common, readTask: async () => ({ status: 'in_progress' }) });
    assert.equal(r.timed_out, true);
    assert.ok(s.clock.t >= CLOCK0 + 30_000 && s.clock.t < CLOCK0 + 32_000, 'default deadline 30 s');
  });

  it('(7) --timeout clamp: 5 s stretched to the 10 s minimum (the deadline is not shorter), 999999 s cut to the 3600 s maximum', async () => {
    const s = environment();
    const id = 'b8c9d0e1';
    s.save(id);
    let r = await wait({ ids: [id], timeoutS: 5, ...s.common, readTask: async () => ({ status: 'in_progress' }) });
    assert.equal(r.timed_out, true);
    assert.ok(s.clock.t >= CLOCK0 + 10_000, 'minimum deadline 10 s (without the clamp it would be 5 s)');
    // upper clamp: 999999 -> 3600 s; the task in progress to the deadline, so the final t = deadline +- a pause
    s.clock.t = CLOCK0;
    s.clock.pauses.length = 0;
    r = await wait({ ids: [id], timeoutS: '999999', ...s.common, readTask: async () => ({ status: 'in_progress' }) });
    assert.equal(r.timed_out, true);
    assert.ok(s.clock.t >= CLOCK0 + 3_600_000 && s.clock.t <= CLOCK0 + 3_602_000, 'deadline cut to the 3600 s maximum (upper clamp)');
    assert.ok(s.clock.pauses.every((p) => p <= 2000), 'a pause never above 2000 ms');
  });

  it('(8) the polling delay grows: the first pause 500 ms, grows 1.5x up to 2000 ms (the pattern of waitForTeamJob)', async () => {
    const s = environment();
    const id = 'c9d0e1f2';
    s.save(id);
    const r = await wait({ ids: [id], timeoutS: 10, ...s.common, readTask: async () => ({ status: 'in_progress' }) });
    assert.equal(r.timed_out, true);
    assert.deepEqual(s.clock.pauses.slice(0, 4), [500, 750, 1125, 1687]);
    assert.ok(s.clock.pauses.length >= 5, 'at least several polls');
    assert.ok(s.clock.pauses.every((p) => p >= 500 && p <= 2000));
  });

  it('(9) --limit: a total limit from the start field exceeded -> shutdown <team> --force (fake omc), a failed/timeout result, delivery, the journal', async () => {
    const s = environment();
    const id = 'd0e1f2a3';
    s.save(id); // start = CLOCK0 - 60 s, limit 30 s: exceeded at once
    const argvFile = join(s.dir, 'omc-argv.json');
    const fake = fakeOmc(s.dir, { argvFile, answer: '{}' });
    let journalCalls = 0;
    const r = await wait({
      ids: [id], limitS: 30, ...s.common, env: { ...s.env, OMC_PROVIDER_TASK_OMC_BIN: fake },
      readTask: async () => ({ status: 'in_progress' }),
      writeJournal: async () => { journalCalls++; },
    });
    assert.deepEqual(JSON.parse(readFileSync(argvFile, 'utf8')), ['team', 'shutdown', sub(id), '--force']);
    const d = s.read(id);
    // The limit result in the full shape of an evaluation, with handoff: true.
    assert.deepEqual(d.verdict, { status: 'failed', cause: 'timeout', handoff: true, errors: ['total time limit exceeded'], gaps: null, required: null, unverified: null, evidence: null, points: null, escalation: null, heartbeat_age_s: null });
    assert.ok(d.verdict_ts && d.delivered);
    assert.equal(d.limit_s, 30);
    assert.equal(journalCalls, 1);
    assert.deepEqual(r.results[0], { id, status: 'failed', verified: false, error: 'total time limit exceeded; timeout', handoff: true, cause: 'timeout' });
    assert.equal(r.handoff, true);
    assert.equal(r.in_progress, 0);
    assert.equal(r.timed_out, false);
  });

  it('(10) --limit not exceeded: no shutdown and no verdict; the task in progress to the deadline (the fake omc is not called)', async () => {
    const s = environment();
    const id = 'b1c2d3e4';
    s.save(id); // start = CLOCK0 - 60 s; limit 600 s: not exceeded
    const argvFile = join(s.dir, 'omc-argv.json');
    const fake = fakeOmc(s.dir, { argvFile, answer: '{}' });
    const r = await wait({
      ids: [id], limitS: 600, ...s.common, env: { ...s.env, OMC_PROVIDER_TASK_OMC_BIN: fake },
      readTask: async () => ({ status: 'in_progress' }),
    });
    assert.equal(existsSync(argvFile), false, 'shutdown not called');
    const d = s.read(id);
    assert.equal(d.verdict, null);
    assert.equal(d.limit_s, 600);
    assert.equal(r.timed_out, true);
    assert.equal(r.in_progress, 1);
  });

  it('(11) an evaluation with handoff: true -> the result field handoff=true and r.handoff; validation errors in the error field of the row', async () => {
    const s = environment();
    const id = 'e1f2a3b4';
    s.save(id);
    const r = await wait({
      ids: [id], ...s.common,
      readTask: async () => ({ id: '1', subject: `${sub(id)} test task`, status: 'completed', result: 'Status: blocked' }),
      evaluate: async () => ({ status: 'blocked', cause: 'decision needed', gaps: null, required: 'lead decision', unverified: null, evidence: null, points: null, handoff: true, errors: ['payload outside the dictionary'] }),
    });
    assert.deepEqual(r.results[0], { id, status: 'blocked', verified: false, error: 'payload outside the dictionary; decision needed', handoff: true, cause: 'decision needed' });
    assert.equal(r.handoff, true);
    assert.equal(r.timed_out, false);
    const d = s.read(id);
    assert.equal(d.verdict.handoff, true);
    assert.ok(d.delivered);
  });

  it('(12) kill in the meantime: killed written by another process between the read and the write of wait (a held evaluate) does not get lost', async () => {
    const s = environment();
    const id = 'f2a3b4c5';
    s.save(id);
    let release;
    const gate = new Promise((res) => { release = res; });
    let evaluateReached = 0;
    const p = wait({
      ids: [id], ...s.common,
      readTask: async () => ({ id: '1', subject: `${sub(id)} test task`, status: 'completed', result: 'Status: success' }),
      evaluate: async () => { evaluateReached++; await gate; return { ...EVAL_OK }; },
      writeJournal: async () => {},
    });
    while (!evaluateReached) await new Promise((r) => setTimeout(r, 2));
    // wait hangs on evaluate (outside the lock); "another process" writes killed
    const before = s.read(id);
    writeFileSync(s.file(id), JSON.stringify({ ...before, killed: new Date(CLOCK0).toISOString() }, null, 2) + '\n');
    release();
    await p;
    const d = s.read(id);
    assert.ok(d.killed, 'killed survived the write of wait');
    assert.equal(d.verdict.status, 'success');
    assert.ok(d.delivered);
  });

  it('(15) evaluation data: the evaluation of a finished task gets the worker status (read-worker-status for the team from the file and the owner of the OMC task) and the journal facts', async () => {
    const s = environment();
    const id = 'd5e6f7a8';
    s.save(id);
    const seen = {};
    const r = await wait({
      ids: [id], ...s.common,
      readTask: async () => ({ id: '1', subject: `${sub(id)} test task`, status: 'completed', owner: 'worker-1', result: 'Status: success' }),
      taskFacts: async (i) => ({ id: i, warnings: [], bash_last_code: 0 }),
      workerStatus: async (team, owner) => { seen.team = team; seen.owner = owner; return { state: 'blocked', reason: 'R' }; },
      evaluate: async ({ workerStatus: ws, facts }) => {
        seen.ws = ws;
        seen.facts = facts;
        return { ...EVAL_OK };
      },
    });
    assert.equal(seen.team, sub(id));
    assert.equal(seen.owner, 'worker-1');
    assert.deepEqual(seen.ws, { state: 'blocked', reason: 'R' });
    assert.deepEqual(seen.facts, { id, warnings: [], bash_last_code: 0 });
    assert.deepEqual(r.results[0], { id, status: 'success', verified: true, error: '-', handoff: false, cause: null });
  });

  it('(16) taskFacts throws -> evaluate gets facts: null, the command ends normally with the evaluation result, a message on stderr', async () => {
    const s = environment();
    const id = 'e6f7a8b9';
    s.save(id);
    const messages = [];
    const original = console.error;
    let r;
    try {
      console.error = (...a) => messages.push(a.map(String).join(' '));
      r = await wait({
        ids: [id], ...s.common,
        readTask: async () => ({ id: '1', subject: `${sub(id)} test task`, status: 'completed', owner: 'worker-1', result: 'Status: success' }),
        taskFacts: async () => { throw new Error('journal broke'); },
        workerStatus: async () => null,
        evaluate: async ({ facts }) => {
          assert.equal(facts, null);
          return { ...EVAL_OK };
        },
      });
    } finally { console.error = original; }
    assert.ok(messages.some((k) => k.includes('journal broke')), JSON.stringify(messages));
    assert.deepEqual(r.results[0], { id, status: 'success', verified: true, error: '-', handoff: false, cause: null });
    const d = s.read(id);
    assert.equal(d.verdict.status, 'success');
    assert.ok(d.delivered);
  });

  it('(17) an OMC task without an owner -> workerStatus is not called, evaluate gets workerStatus: null', async () => {
    const s = environment();
    const id = 'f7a8b9c0';
    s.save(id);
    const seen = {};
    let statusCalls = 0;
    const r = await wait({
      ids: [id], ...s.common,
      readTask: async () => ({ id: '1', subject: `${sub(id)} test task`, status: 'completed', result: 'Status: success' }),
      workerStatus: async () => { statusCalls++; return { state: 'blocked', reason: 'R' }; },
      taskFacts: async () => ({ warnings: [] }),
      evaluate: async ({ workerStatus: ws }) => { seen.ws = ws; return { ...EVAL_OK }; },
    });
    assert.equal(statusCalls, 0, 'workerStatus not called without an owner');
    assert.equal(seen.ws, null);
    assert.deepEqual(r.results[0], { id, status: 'success', verified: true, error: '-', handoff: false, cause: null });
  });

  it('(18) grace of a missing OMC task: 59 s after start still in progress; after the grace a start_failed/environment evaluation written and delivered exactly once', async () => {
    const s = environment();
    const id = 'a8b9c0d1';
    const start = CLOCK0 - 59_000;
    s.save(id, { start: new Date(start).toISOString() });
    const polls = [];
    let journalCalls = 0;
    const r = await wait({
      ids: [id], timeoutS: 10, ...s.common,
      readTask: async () => { polls.push(s.clock.t); return null; },
      evaluate: async () => { throw new Error('evaluate must not run without an OMC task'); },
      writeJournal: async () => { journalCalls++; },
    });
    const sinceStart = (t) => (t - start) / 1000;
    assert.ok(polls.some((t) => sinceStart(t) === 59), `polled within the grace (59 s after start): ${JSON.stringify(polls.map(sinceStart))}`);
    assert.ok(polls.some((t) => sinceStart(t) > 60), `polled after the grace: ${JSON.stringify(polls.map(sinceStart))}`);
    const d = s.read(id);
    assert.deepEqual(d.verdict, { status: 'start_failed', cause: 'environment', handoff: true, errors: [`OMC task ${sub(id)} not found in team ${sub(id)}`] });
    assert.ok(sinceStart(Date.parse(d.verdict_ts)) > 60, 'the verdict only after the grace (60 s from the start field)');
    assert.ok(d.delivered);
    assert.equal(journalCalls, 1);
    assert.deepEqual(r.results[0], { id, status: 'start_failed', verified: false, error: `OMC task ${sub(id)} not found in team ${sub(id)}; environment`, handoff: true, cause: 'environment' });
    assert.equal(r.in_progress, 0);
    assert.equal(r.timed_out, false);
    assert.equal(r.handoff, true);
  });

  it('(19) evaluate returns in_progress for a finished task -> no verdict write and no delivery, waiting continues to the limit', async () => {
    const s = environment();
    const id = 'b9c0d1e2';
    s.save(id);
    let evaluations = 0;
    const r = await wait({
      ids: [id], timeoutS: 10, ...s.common,
      readTask: async () => ({ id: '1', subject: `${sub(id)} test task`, status: 'completed', result: 'Status: success' }),
      evaluate: async () => { evaluations++; return { status: 'in_progress', handoff: false, errors: [] }; },
    });
    assert.ok(evaluations >= 1, 'evaluate called for a finished task');
    assert.equal(r.timed_out, true);
    assert.equal(r.in_progress, 1);
    assert.deepEqual(r.results, []);
    assert.equal(r.handoff, false);
    const d = s.read(id);
    assert.equal(d.verdict, null);
    assert.equal(d.delivered, null);
  });

  it('(22) killed in the task file without an OMC task -> a killed verdict at once (without the limit and grace), written and delivered once', async () => {
    const s = environment();
    const id = 'e2f3a4b5';
    s.save(id, { killed: new Date(CLOCK0 - 1000).toISOString(), start: new Date(CLOCK0 - 120_000).toISOString() });
    let evalArgs = null;
    const r = await wait({
      ids: [id], ...s.common,
      readTask: async () => null,
      evaluate: async (a) => { evalArgs = a; return { status: 'killed', cause: null, gaps: null, required: null, unverified: null, evidence: null, points: null, escalation: null, heartbeat_age_s: null, handoff: false, errors: [] }; },
    });
    assert.equal(s.clock.pauses.length, 0, 'at once: no polling');
    assert.equal(evalArgs.task, null);
    assert.ok(evalArgs.taskFile.killed, 'evaluate gets the task file with killed');
    assert.deepEqual(r.results[0], { id, status: 'killed', verified: true, error: '-', handoff: false, cause: null });
    assert.equal(r.in_progress, 0);
    assert.equal(r.timed_out, false);
    const d = s.read(id);
    assert.equal(d.verdict.status, 'killed');
    assert.ok(d.verdict_ts && d.delivered);
  });

  it('(23) killed with a task in_progress -> a killed verdict at once (evaluate gets the task in progress), does not wait for the limit', async () => {
    const s = environment();
    const id = 'f3a4b5c6';
    s.save(id, { killed: new Date(CLOCK0 - 1000).toISOString() });
    let evalArgs = null;
    const r = await wait({
      ids: [id], ...s.common,
      readTask: async () => ({ id: '1', subject: `${sub(id)} test task`, status: 'in_progress' }),
      evaluate: async (a) => { evalArgs = a; return { status: 'killed', cause: null, gaps: null, required: null, unverified: null, evidence: null, points: null, escalation: null, heartbeat_age_s: null, handoff: false, errors: [] }; },
    });
    assert.equal(s.clock.pauses.length, 0, 'at once: no polling');
    assert.equal(evalArgs.task.status, 'in_progress');
    assert.deepEqual(r.results[0], { id, status: 'killed', verified: true, error: '-', handoff: false, cause: null });
    assert.equal(r.in_progress, 0);
    assert.equal(r.timed_out, false);
    const d = s.read(id);
    assert.equal(d.verdict.status, 'killed');
    assert.ok(d.delivered);
  });

  it('(24) start_exit_code 4 without an OMC task -> start_failed/quota at once (the real evaluateResult), start_exit_code 1 -> environment, without grace', async () => {
    const s = environment();
    const id4 = 'a4b5c6d7';
    const id1 = 'b5c6d7e8';
    s.save(id4, { start_exit_code: 4, start: new Date(CLOCK0 - 120_000).toISOString() });
    s.save(id1, { start_exit_code: 1, start: new Date(CLOCK0 - 120_000).toISOString() });
    const r = await wait({
      ids: [id4, id1], ...s.common,
      readTask: async () => null,
      // evaluate: the real validator (the default evaluateResult) - the cause comes from the start exit code mapping.
    });
    assert.equal(s.clock.pauses.length, 0, 'at once: no grace');
    assert.deepEqual(r.results[0], { id: id4, status: 'start_failed', verified: true, error: 'quota', handoff: true, cause: 'quota' });
    assert.deepEqual(r.results[1], { id: id1, status: 'start_failed', verified: true, error: 'environment', handoff: true, cause: 'environment' });
    const d4 = s.read(id4);
    assert.equal(d4.verdict.status, 'start_failed');
    assert.equal(d4.verdict.cause, 'quota');
    assert.ok(d4.verdict_ts && d4.delivered);
    const d1 = s.read(id1);
    assert.equal(d1.verdict.cause, 'environment');
    assert.ok(d1.delivered);
  });

  it('(25) start_exit_code 1 with a task in_progress -> the state from the OMC task (waiting continues), evaluate not called', async () => {
    const s = environment();
    const id = 'c6d7e8f9';
    s.save(id, { start_exit_code: 1 });
    let evaluations = 0;
    const r = await wait({
      ids: [id], timeoutS: 10, ...s.common,
      readTask: async () => ({ id: '1', subject: `${sub(id)} test task`, status: 'in_progress' }),
      evaluate: async () => { evaluations++; throw new Error('evaluate must not run for a task in progress'); },
    });
    assert.equal(evaluations, 0);
    assert.equal(r.timed_out, true);
    assert.equal(r.in_progress, 1);
    assert.deepEqual(r.results, []);
    const d = s.read(id);
    assert.equal(d.verdict, null);
    assert.equal(d.delivered, null);
  });

  it('(29) an empty lock from 2 min ago is taken over (wait works normally), a fresh empty lock is awaited up to the lock ceiling', async () => {
    // A: an old empty lock taken over: wait passes and ends with a result.
    const s = environment();
    const id = 'a0b1c2d3';
    s.save(id);
    const lock = `${s.file(id)}.lock`;
    writeFileSync(lock, '');
    utimesSync(lock, new Date(CLOCK0 - 120_000), new Date(CLOCK0 - 120_000));
    const r = await wait({
      ids: [id], ...s.common,
      readTask: async () => ({ id: '1', subject: `${sub(id)} test task`, status: 'completed', result: 'Status: success\nSummary: ok' }),
      evaluate: async () => ({ ...EVAL_OK }),
    });
    assert.deepEqual(r.results[0], { id, status: 'success', verified: true, error: '-', handoff: false, cause: null });
    const d = s.read(id);
    assert.ok(d.verdict && d.delivered);
    assert.ok(!existsSync(lock), 'the lock removed after finishing');
    // B: a fresh empty lock (mtime = the test clock now) is awaited as for a live owner: a throw with code 2 after 10 clock seconds.
    const s2 = environment();
    const id2 = 'c2d3e4f5';
    s2.save(id2);
    const lock2 = `${s2.file(id2)}.lock`;
    writeFileSync(lock2, '');
    utimesSync(lock2, new Date(CLOCK0), new Date(CLOCK0));
    await assert.rejects(
      wait({ ids: [id2], ...s2.common, readTask: async () => ({ status: 'in_progress' }) }),
      (e) => e.errorCode === 2 && /lock held/.test(e.message),
    );
    assert.ok(s2.clock.t >= CLOCK0 + 10_000, 'waiting up to the lock ceiling (10 clock seconds)');
  });

  it('(30) start-lock queue: a missing OMC task, a live start_pid (start time matches /proc) without omc_started_at -> waiting without a verdict to the limit (timed_out), the file without a verdict and delivered', async () => {
    const s = environment();
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100)'], { stdio: 'ignore' });
    try {
      const id = 'a1c2e3f4';
      s.save(id, { start: new Date(CLOCK0 - 70_000).toISOString(), start_pid: helper.pid, start_pid_starttime: null });
      const r = await wait({
        ids: [id], timeoutS: 10, ...s.common,
        readTask: async () => null,
        evaluate: async () => { throw new Error('evaluate must not run in the start-lock queue'); },
      });
      assert.equal(r.timed_out, true);
      assert.equal(r.in_progress, 1);
      assert.deepEqual(r.results, []);
      const d = s.read(id);
      assert.equal(d.verdict, null);
      assert.equal(d.delivered, null);
    } finally { try { helper.kill(); } catch { /* already dead */ } }
  });

  it('(31) a dead _start: the start_pid of an ended process without omc_started_at -> a start_failed/environment verdict at once (without grace), written and delivered', async () => {
    const s = environment();
    const id = 'b2d3f4a5';
    const dead = spawnSync('true').pid;
    assert.ok(!(() => { try { process.kill(dead, 0); return true; } catch (e) { return e.code === 'EPERM'; } })(), 'the dead pid is alive');
    s.save(id, { start: new Date(CLOCK0 - 5_000).toISOString(), start_pid: dead, start_pid_starttime: 1 });
    const r = await wait({
      ids: [id], ...s.common,
      readTask: async () => null,
      evaluate: async () => { throw new Error('evaluate must not run for a verdict from evaluateMissingTask'); },
    });
    assert.equal(s.clock.pauses.length, 0, 'at once: no polling');
    assert.deepEqual(r.results[0], { id, status: 'start_failed', verified: false, error: 'the _start process exited before it launched provider-team; environment', handoff: true, cause: 'environment' });
    const d = s.read(id);
    assert.deepEqual(d.verdict, { status: 'start_failed', cause: 'environment', handoff: true, errors: ['the _start process exited before it launched provider-team'] });
    assert.ok(d.verdict_ts && d.delivered);
  });
});
