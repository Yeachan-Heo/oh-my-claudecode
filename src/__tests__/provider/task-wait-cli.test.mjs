/* global process, URL */
// `provider-task wait` as a command: argument parsing, the output rows, exit codes and the working directory of the omc calls
// (a fake omc through OMC_PROVIDER_TASK_OMC_BIN). The loop itself is covered by task-wait.test.mjs.
import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, writeProfile } from './_helpers.mjs';

const TASK = fileURLToPath(new URL('../../../scripts/provider/provider-task.cjs', import.meta.url));
const sub = (id) => `ptask-${id}`;

describe.skipIf(process.platform === 'win32')('provider-task wait command', () => {
  let tmp;
  beforeAll(() => { tmp = makeTmp('provider-wait-cli-'); });
  afterAll(() => { tmp.cleanup(); });

  let nr = 0;
  // One case: a profile with its own state dir and a task directory.
  const environment = () => {
    const dir = join(tmp.dir, `case-${++nr}`);
    mkdirSync(dir, { recursive: true });
    const { env } = writeProfile(dir);
    const tasks = join(dir, 'state', 'tasks');
    mkdirSync(tasks, { recursive: true });
    const file = (id) => join(tasks, `${id}.json`);
    const save = (id, fields = {}) => writeFileSync(file(id), JSON.stringify({ id, team: sub(id), start: new Date(Date.now() - 60_000).toISOString(), cwd: dir, brief: null, killed: null, abandon: null, limit_s: null, verdict: null, verdict_ts: null, delivered: null, ...fields }, null, 2) + '\n');
    const read = (id) => JSON.parse(readFileSync(file(id), 'utf8'));
    return { dir, env, save, read };
  };
  const run = (s, args, extraEnv = {}, cwd = undefined) => spawnSync(process.execPath, [TASK, 'wait', ...args], { encoding: 'utf8', cwd, env: { ...s.env, ...extraEnv } });

  // Fake `omc`: appends { argv, cwd } to a JSONL file and prints the answer chosen by the third argument (the api operation).
  const fakeOmc = (dir, { logFile, answers = {}, code = 0 }) => {
    const p = join(dir, 'omc-fake.cjs');
    writeFileSync(p, `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv, cwd: process.cwd() }) + '\\n');
const answers = ${JSON.stringify(answers)};
console.log(answers[argv[2]] ?? '{}');
process.exit(${Number(code)});
`, { mode: 0o755 });
    return p;
  };
  const listTasks = (id, status = 'completed', result = 'Status: success\nSummary: work done\nVerification: tests OK', owner = undefined) => JSON.stringify({
    ok: true, operation: 'list-tasks', data: { count: 1, tasks: [{ id: '1', subject: `${sub(id)} test task`, status, result, ...(owner ? { owner } : {}) }] },
  });
  const calls = (logFile) => readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  it('CLI: parsing of wait - no id, a bad id, an unknown flag, --timeout 0, --timeout abc, --limit 0 give exit code 2 and a message on stderr', () => {
    const s = environment();
    const cases = [
      [[], 'id'],
      [['too-short', '--timeout', '10'], '8 characters'],
      [['a1b2c3d4', '--unknown'], 'unknown flag'],
      [['a1b2c3d4', '--timeout', '0'], '--timeout'],
      [['a1b2c3d4', '--timeout', 'abc'], '--timeout'],
      [['a1b2c3d4', '--timeout', '10', '--limit', '0'], '--limit'],
    ];
    for (const [args, fragment] of cases) {
      const r = run(s, args);
      assert.equal(r.status, 2, `exit code 2 for ${JSON.stringify(args)}: ${JSON.stringify({ o: r.stdout, e: r.stderr })}`);
      assert.ok(r.stderr.includes(fragment), `${fragment} in stderr: ${r.stderr}`);
      assert.ok(!r.stderr.includes(tmp.dir), 'temp paths do not leak into configuration messages');
    }
  });

  it('CLI e2e: wait <id> --timeout 10 with a fake omc (list-tasks completed) -> exit code 0, the row `id -> success verified=yes error=-`, `in progress: 0`, no HANDOFF; the file: verdict + delivered', () => {
    const s = environment();
    const id = 'a9b0c1d2';
    s.save(id);
    const logFile = join(s.dir, 'omc-log.jsonl');
    const omc = fakeOmc(s.dir, { logFile, answers: { 'list-tasks': listTasks(id) } });
    const r = run(s, [id, '--timeout', '10'], { OMC_PROVIDER_TASK_OMC_BIN: omc });
    assert.equal(r.status, 0, JSON.stringify({ o: r.stdout, e: r.stderr }));
    // The status in the row comes from the real evaluation of the result module: 'success' from the DoneClaim payload, not the raw OMC status 'completed'.
    assert.ok(r.stdout.includes(`${id} -> success verified=yes error=-`), r.stdout);
    assert.ok(r.stdout.includes('in progress: 0'), r.stdout);
    assert.ok(!r.stdout.includes('HANDOFF'), 'without a handoff there is no HANDOFF line');
    assert.deepEqual(calls(logFile)[0].argv, ['team', 'api', 'list-tasks', '--input', JSON.stringify({ team_name: sub(id) }), '--json']);
    const d = s.read(id);
    assert.ok(d.verdict && typeof d.verdict.status === 'string', 'the evaluation is written to the task file');
    assert.ok(d.verdict_ts && d.delivered);
  });

  it('CLI e2e (the real evaluation): completed with an empty result -> failed/empty_response, exit code 2 and a HANDOFF line; verdict and delivered in the file', () => {
    const s = environment();
    const id = 'c0d1e2f3';
    s.save(id);
    const logFile = join(s.dir, 'omc-log.jsonl');
    const omc = fakeOmc(s.dir, { logFile, answers: { 'list-tasks': listTasks(id, 'completed', '') } });
    const r = run(s, [id, '--timeout', '10'], { OMC_PROVIDER_TASK_OMC_BIN: omc });
    assert.equal(r.status, 2, JSON.stringify({ o: r.stdout, e: r.stderr }));
    assert.ok(r.stdout.includes(`${id} -> failed verified=yes error=empty_response`), r.stdout);
    assert.ok(r.stdout.includes(`HANDOFF ${id} failed empty_response`), r.stdout);
    const d = s.read(id);
    assert.equal(d.verdict.status, 'failed');
    assert.equal(d.verdict.cause, 'empty_response');
    assert.equal(d.verdict.handoff, true);
    assert.ok(d.verdict_ts && d.delivered);
  });

  it('CLI e2e (the real evaluation): blocked with owner worker-1, read-worker-status {state: blocked, reason: R} -> the row blocked, exit code 0, no HANDOFF; the argv of read-worker-status asserted', () => {
    const s = environment();
    const id = 'd1e2f3a4';
    s.save(id);
    const logFile = join(s.dir, 'omc-log.jsonl');
    // The owner in the OMC task is needed: wait reads the worker status only for a task with an owner.
    const omc = fakeOmc(s.dir, { logFile, answers: {
      'list-tasks': listTasks(id, 'blocked', '', 'worker-1'),
      'read-worker-status': JSON.stringify({ ok: true, data: { worker: 'worker-1', status: { state: 'blocked', reason: 'R' } } }),
    } });
    const r = run(s, [id, '--timeout', '10'], { OMC_PROVIDER_TASK_OMC_BIN: omc });
    assert.equal(r.status, 0, JSON.stringify({ o: r.stdout, e: r.stderr }));
    assert.ok(r.stdout.includes(`${id} -> blocked verified=yes error=-`), r.stdout);
    assert.ok(!r.stdout.includes('HANDOFF'), 'blocked without a handoff: no HANDOFF line');
    assert.deepEqual(calls(logFile)[1].argv, ['team', 'api', 'read-worker-status', '--input', JSON.stringify({ team_name: sub(id), worker: 'worker-1' }), '--json']);
    const d = s.read(id);
    assert.equal(d.verdict.status, 'blocked');
    assert.equal(d.verdict.required, 'R');
    assert.ok(d.verdict_ts && d.delivered);
  });

  it('CLI e2e: a failed read (fake list-tasks exits with 1) is not a missing task: waiting goes on despite the grace period (start 2 min ago), no start_failed', () => {
    const s = environment();
    const id = 'd7e8f9a0';
    s.save(id, { start: new Date(Date.now() - 120_000).toISOString() });
    const logFile = join(s.dir, 'omc-log.jsonl');
    const omc = fakeOmc(s.dir, { logFile, answers: {}, code: 1 });
    const r = run(s, [id, '--timeout', '10'], { OMC_PROVIDER_TASK_OMC_BIN: omc });
    assert.equal(r.status, 1, `timed_out -> exit code 1: ${JSON.stringify({ o: r.stdout, e: r.stderr })}`);
    assert.ok(!r.stdout.includes('start_failed'), r.stdout);
    assert.ok(r.stderr.includes('list-tasks'), `the read message on stderr: ${r.stderr}`);
    const d = s.read(id);
    assert.equal(d.verdict, null);
    assert.equal(d.delivered, null);
  }, 30000);

  it('omc is called in the cwd of the task (list-tasks and read-worker-status), not in the cwd of the wait process', () => {
    const s = environment();
    const id = 'e8f9a0b1';
    s.save(id); // the cwd field of the task file = the case directory
    const logFile = join(s.dir, 'omc-log.jsonl');
    const omc = fakeOmc(s.dir, { logFile, answers: {
      'list-tasks': listTasks(id, 'blocked', '', 'worker-1'),
      'read-worker-status': JSON.stringify({ ok: true, data: { worker: 'worker-1', status: { state: 'blocked', reason: 'R' } } }),
    } });
    const runDir = join(s.dir, 'run');
    mkdirSync(runDir, { recursive: true });
    const r = run(s, [id, '--timeout', '10'], { OMC_PROVIDER_TASK_OMC_BIN: omc }, runDir);
    assert.equal(r.status, 0, JSON.stringify({ o: r.stdout, e: r.stderr }));
    const rows = calls(logFile);
    assert.deepEqual(rows.map((w) => w.argv[2]), ['list-tasks', 'read-worker-status']);
    assert.ok(rows.every((w) => w.cwd === s.dir), `omc called in the cwd of the task: ${JSON.stringify(rows.map((w) => w.cwd))}`);
    assert.equal(s.read(id).verdict.status, 'blocked');
  });

  it('shutdown after the limit also runs in the cwd of the task', () => {
    const s = environment();
    const id = 'f9a0b1c2';
    s.save(id, { start: new Date(Date.now() - 120_000).toISOString() }); // the limit of 30 s is exceeded at once
    const logFile = join(s.dir, 'omc-log.jsonl');
    const omc = fakeOmc(s.dir, { logFile, answers: {} });
    const runDir = join(s.dir, 'run');
    mkdirSync(runDir, { recursive: true });
    const r = run(s, [id, '--timeout', '10', '--limit', '30'], { OMC_PROVIDER_TASK_OMC_BIN: omc }, runDir);
    assert.equal(r.status, 2, JSON.stringify({ o: r.stdout, e: r.stderr }));
    const rows = calls(logFile);
    assert.deepEqual(rows.map((w) => w.argv), [
      ['team', 'api', 'list-tasks', '--input', JSON.stringify({ team_name: sub(id) }), '--json'],
      ['team', 'shutdown', sub(id), '--force'],
    ]);
    assert.ok(rows.every((w) => w.cwd === s.dir), `omc called in the cwd of the task: ${JSON.stringify(rows.map((w) => w.cwd))}`);
    const d = s.read(id);
    assert.equal(d.verdict.status, 'failed');
    assert.equal(d.verdict.cause, 'timeout');
  });
});
