/* global process */
// The consultation limit per task and per group and the FIFO queue for the top-model bucket (scripts/provider/lib/advisor-limit.cjs)
// and its integration in provider-advisor.cjs: on a fake claude, no network, no real key.
// Switch: OMC_PROVIDER_ADVISOR_LIMIT=1 (off by default).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fakeAdvisorClaude, readRows, runAdvisor } from './_advisor-helpers.mjs';
import { makeTmp } from './_helpers.mjs';

// Each case starts several node processes; on a loaded machine that takes longer than the default limit.
vi.setConfig({ testTimeout: 180000 });

const require = createRequire(import.meta.url);
const LIMIT_MODULE = require.resolve('../../../scripts/provider/lib/advisor-limit.cjs');
const lim = require('../../../scripts/provider/lib/advisor-limit.cjs');
const journalLib = require('../../../scripts/provider/lib/advisor-journal.cjs');
const guard = require('../../../scripts/provider/provider-bash-guard.cjs');

const js = JSON.stringify;
const check = (condition, message) => expect(Boolean(condition), typeof message === 'function' ? message() : message).toBe(true);

describe.skipIf(process.platform === 'win32')('advisor limit and queue', () => {
  let tmp; let TMP; let FAKE; let JOURNAL; let STATE; let STATE_ROOT; let Z1; let n = 0; // Z1: the task key of the fixture task (state root, team and task id)
  const base = () => ({
    PATH: process.env.PATH, HOME: TMP, OMC_PROVIDER_ADVISOR_CLAUDE_BIN: FAKE, OMC_PROVIDER_ADVISOR_LOG_FILE: JOURNAL, OMC_PROVIDER_ADVISOR_LIMIT_FILE: STATE,
    OMC_TEAM_WORKER: 'team-l/worker-l', OMC_TEAM_STATE_ROOT: STATE_ROOT, OMC_PROVIDER_ADVISOR_LIMIT: '1', OMC_PROVIDER_ADVISOR_LIMIT_PER_TASK: '4', OMC_PROVIDER_ADVISOR_LIMIT_PER_GROUP: '4', OMC_PROVIDER_ADVISOR_TOP_SLOTS: '2', OMC_PROVIDER_ADVISOR_QUEUE_WAIT_MS: '4000',
  });
  const advisor = (env = {}, argv = ['limit-question'], options = {}) => runAdvisor({ env: { ...base(), ...env }, argv, fakeOut: join(TMP, `w${++n}`), ...options });
  const rows = () => readRows(JOURNAL);
  const state = (file = STATE) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
  const emptyState = (extra) => ({ v: 1, tasks: {}, groups: {}, slots: [], top: [], queue: [], ...extra });

  beforeAll(() => {
    tmp = makeTmp('provider-advisor-limit-');
    TMP = tmp.dir;
    FAKE = fakeAdvisorClaude(TMP);
    JOURNAL = join(TMP, 'data', 'advisor.jsonl');
    STATE = join(TMP, 'data', 'advisor-limit.json');
    STATE_ROOT = join(TMP, 'team-state');
    Z1 = JSON.stringify([STATE_ROOT, 'team-l', 'z-1']);
    mkdirSync(join(STATE_ROOT, 'tasks'), { recursive: true });
    writeFileSync(join(STATE_ROOT, 'tasks', 'z-1.json'), js({ id: 'z-1', subject: 'limit task', description: 'x', status: 'in_progress', owner: 'worker-l' }));
  });
  afterAll(() => tmp.cleanup());

  it('(L1) off (no OMC_PROVIDER_ADVISOR_LIMIT): the consultation as without a limit: no state file, no ADVISOR-LIMIT line, a journal row without the limit fields', () => {
    const r = advisor({ OMC_PROVIDER_ADVISOR_LIMIT: undefined, OMC_PROVIDER_ADVISOR_LIMIT_FILE: join(TMP, 'limit-off.json') });
    check(r.status === 0 && r.called && r.stdout.includes('STUB-ANSWER') && !r.stdout.includes('ADVISOR-LIMIT'), js({ s: r.status, o: r.stdout }));
    check(!existsSync(join(TMP, 'limit-off.json')), 'the state file was created with the limit off');
    const w = rows().at(-1);
    check(!('type' in w) && !('limit_reason' in w) && !('retry_429' in w), js(Object.keys(w)));
  });

  // ===== (L2-L8) unit cases on the module advisor-limit.cjs =====
  it('(L2) reservation: left falls (the minimum of the task and group limits); a refusal on exhaustion WITHOUT raising the counter; the reason task or group', () => {
    const sc = join(TMP, 'l2.json');
    const L = { task: 2, group: 5, topSlots: 2 };
    const a = lim.reserve({ path: sc, task: 'z', group: 't', limits: L });
    check(a.ok && a.left === 1, js(a));
    const b = lim.reserve({ path: sc, task: 'z', group: 't', limits: L });
    check(b.ok && b.left === 0, js(b));
    const c = lim.reserve({ path: sc, task: 'z', group: 't', limits: L });
    check(!c.ok && c.left === 0 && c.reason === 'task', js(c));
    check(state(sc).tasks.z.used === 0 && state(sc).tasks.z.reserved === 2 && typeof state(sc).tasks.z.ts === 'number', 'the refusal raised the counter or the entry has no timestamp (expiry)'); // a refusal does not raise the counter
    const d = lim.reserve({ path: sc, task: 'z2', group: 't', limits: L });
    check(d.ok && d.left === 1, js(d)); // after its own reservation: min(2-1, 5-2-1) = 1
  });
  it('(L3) the minimum of the limits: a group limit lower than the task limit decides; the refund is idempotent (a double refund does not lower); commit moves reserved to used', () => {
    const sc = join(TMP, 'l3.json');
    const L = { task: 4, group: 2, topSlots: 2 };
    const a = lim.reserve({ path: sc, task: 'z', group: 't', limits: L });
    check(a.ok && a.left === 1, js(a)); // min(4, 2-1=1)
    check(lim.refund({ path: sc, id: a.id }), 'refund false');
    check(!lim.refund({ path: sc, id: a.id }), 'a double refund lowered the counter');
    const afterRefund = lim.reserve({ path: sc, task: 'z', group: 't', limits: L });
    check(afterRefund.ok && afterRefund.left === 1, js(afterRefund));
    check(js(lim.commit({ path: sc, id: afterRefund.id, limits: L })) === js({ left: 1 }), 'commit left');
    const st = state(sc);
    check(st.tasks.z.used === 1 && st.tasks.z.reserved === 0 && st.groups.t.used === 1 && st.groups.t.reserved === 0 && typeof st.tasks.z.ts === 'number' && st.slots.length === 0, js(st));
  });
  it('(L4) concurrency: 2 processes on limit 1 give exactly 1 ok and 1 refusal; 4 processes on limit 2 give exactly 2 ok (the counter under the lock, no race)', () => {
    const sc = join(TMP, 'l4.json');
    const sc2 = join(TMP, 'l4b.json');
    const reserveOne = join(TMP, 'reserve-one.cjs');
    writeFileSync(reserveOne, `const lim = require(${js(LIMIT_MODULE)});
const [sc, task, group, lt, lg] = process.argv.slice(2);
const w = lim.reserve({ path: sc, task, group, limits: { task: Number(lt), group: Number(lg), topSlots: 2 } });
console.log(JSON.stringify(w));
// the process lasts after the reservation (500 ms): the slot has a live owner, so the reconciliation does not recover it;
// without this the child ends at once, the slot is legitimately orphaned and recovered by the next reservation
const t0 = Date.now(); while (Date.now() - t0 < 500) {}
process.exit(w.ok ? 0 : 3);
`);
    const runs = (file, count, limitTask, limitGroup) => {
      const lines = [
        `const { spawn } = require('node:child_process');`,
        `let ok = 0; let finished = 0;`,
        `for (let i = 0; i < ${count}; i++) {`,
        `  const d = spawn(process.execPath, [${js(reserveOne)}, ${js(file)}, 'z', 't', '${limitTask}', '${limitGroup}'], { stdio: ['ignore', 'ignore', 'ignore'] });`,
        `  d.on('exit', (code) => { if (code === 0) ok++; if (++finished === ${count}) console.log('RESULT ' + ok); });`,
        `}`,
      ];
      const g = spawnSync(process.execPath, ['-e', lines.join('\n')], { encoding: 'utf8' });
      return Number(/RESULT (\d+)/.exec(g.stdout)?.[1] ?? -1);
    };
    check(runs(sc, 2, 1, 1) === 1, '2 processes on limit 1: expected 1 ok');
    check(runs(sc2, 4, 2, 2) === 2, '4 processes on limit 2: expected 2 ok');
    const st = state(sc2);
    check(st.tasks.z.used === 0 && st.tasks.z.reserved === 2 && typeof st.tasks.z.ts === 'number', js(st.tasks));
  });
  it('(L5) the FIFO queue: 2 bucket slots taken, the third waits in the queue; after one slot is released the waiting one gets a slot before the timeout; after the releases the bucket is empty', () => {
    const sc = join(TMP, 'l5.json');
    const L = { task: 9, group: 9, topSlots: 2 };
    const a = lim.waitForTop({ path: sc, limits: L, waitMs: 3000, stepMs: 100 });
    const b = lim.waitForTop({ path: sc, limits: L, waitMs: 3000, stepMs: 100 });
    check(a.ok && b.ok, js({ a: a.ok, b: b.ok }));
    // the third waiter and the release in one wrapper (the test cannot wait for the child and release a slot at the same time)
    const script = `const { spawn } = require('node:child_process');
const lim = require(${js(LIMIT_MODULE)});
const d = spawn(process.execPath, ['-e', 'const lim = require(${js(LIMIT_MODULE)}); const w = lim.waitForTop({ path: ${js(sc)}, limits: ${js(L)}, waitMs: 8000, stepMs: 100 }); console.log(JSON.stringify(w));']);
let out = '';
d.stdout.on('data', (c) => { out += c; });
d.on('exit', (code) => { console.log('EXIT ' + code); console.log(out); });
const waitState = (want, tries = 60) => new Promise((done) => { // waiting for the state, not a fixed 500 ms sleep
  const step = () => {
    let current = null;
    try { current = JSON.parse(require('node:fs').readFileSync(${js(sc)}, 'utf8')); } catch { current = null; }
    if (current && current.top.length === want.top && current.queue.length === want.queue) return done(current);
    if (--tries <= 0) return done(current);
    setTimeout(step, 100);
  };
  step();
});
waitState({ top: 2, queue: 1 }).then((seen) => {
  if (!seen || seen.top.length !== 2 || seen.queue.length !== 1) { console.error('STATE ' + JSON.stringify(seen)); process.exit(4); }
  lim.releaseTop({ path: ${js(sc)}, id: seen.top[0].id });
});
setTimeout(() => process.exit(0), 3000);
`;
    const g = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15000 });
    check(/EXIT 0/.test(g.stdout) && /"ok":true/.test(g.stdout), js({ o: g.stdout, e: g.stderr.slice(0, 160) }));
    const idC = JSON.parse(g.stdout.trim().split('\n').find((l) => l.startsWith('{')));
    const after = state(sc);
    check(after.top.length === 2 && after.queue.length === 0, js(after));
    check(lim.releaseTop({ path: sc, id: idC.id }) && lim.releaseTop({ path: sc, id: b.id }), 'releases false');
    check(state(sc).top.length === 0, 'the bucket is not empty after the releases');
  });
  it('(L6) the queue timeout: 2 slots taken, waitMs 300 ms gives a failure; the waiter entry is removed from the queue (a clean queue)', () => {
    const sc = join(TMP, 'l6.json');
    const L = { task: 9, group: 9, topSlots: 2 };
    const a = lim.waitForTop({ path: sc, limits: L, waitMs: 100, stepMs: 50 });
    const b = lim.waitForTop({ path: sc, limits: L, waitMs: 100, stepMs: 50 });
    const c = lim.waitForTop({ path: sc, limits: L, waitMs: 300, stepMs: 50 });
    check(a.ok && b.ok && !c.ok, js({ a: a.ok, b: b.ok, c: c.ok }));
    check(state(sc).queue.length === 0, js(state(sc).queue));
    lim.releaseTop({ path: sc, id: a.id });
    lim.releaseTop({ path: sc, id: b.id });
  });
  it('(L7) recovery: a slot with a dead pid recovered (a reservation passes despite the exhaustion), a dead bucket slot released at once, a pid reuse (a live pid, another start identity) recovered; a slot of a live owner with the right identity untouched', () => {
    const sc = join(TMP, 'l7.json');
    const L = { task: 1, group: 1, topSlots: 1 };
    const dead = spawnSync('true').pid;
    const deadEntry = { id: 'x1', task: 'z', group: 't', pid: dead, start: '1', ts: '2026-11-01T00:00:00Z' };
    writeFileSync(sc, js(emptyState({ tasks: { z: { used: 0, reserved: 1 } }, groups: { t: { used: 0, reserved: 1 } }, slots: [deadEntry] })));
    const r = lim.reserve({ path: sc, task: 'z', group: 't', limits: L });
    check(r.ok, js(r));
    check(state(sc).slots.every((s) => s.id !== 'x1'), 'the slot of the dead owner was not recovered');
    writeFileSync(sc, js(emptyState({ top: [{ id: 'o1', pid: dead, start: '1', ts: '2026-11-01T00:00:00Z' }] })));
    const w = lim.waitForTop({ path: sc, limits: L, waitMs: 1000, stepMs: 100 });
    check(w.ok, js(w));
    writeFileSync(sc, js(emptyState({ tasks: { z: { used: 0, reserved: 1 } }, groups: { t: { used: 0, reserved: 1 } }, slots: [{ id: 'x2', task: 'z', group: 't', pid: process.pid, start: '999999', ts: '2026-11-01T00:00:00Z' }] })));
    const r3 = lim.reserve({ path: sc, task: 'z', group: 't', limits: L });
    check(r3.ok, 'a pid reuse was not recovered');
    const t = lim.startIdentity(process.pid);
    writeFileSync(sc, js(emptyState({ tasks: { z: { used: 0, reserved: 1 } }, groups: { t: { used: 0, reserved: 1 } }, slots: [{ id: 'x3', task: 'z', group: 't', pid: process.pid, start: t.start, ts: '2026-11-01T00:00:00Z' }] })));
    const r4 = lim.reserve({ path: sc, task: 'z', group: 't', limits: L });
    check(!r4.ok && r4.reason === 'task', 'the slot of a live owner with the right identity was recovered');
  });
  it('(L8) retryDelayMs: Retry-After 5 s -> 5000, none -> 2000 (the default), 100 s -> 30000 (the cap), 0 -> 2000; startIdentity of the own process = a number; the CLI status prints JSON and does not write the state', () => {
    check(lim.retryDelayMs('too_many_requests (429), Retry-After: 5') === 5000, 'retry 5');
    check(lim.retryDelayMs('rate limit reached') === 2000, 'no Retry-After');
    check(lim.retryDelayMs('too_many_requests Retry-After: 100') === 30000, 'cap 30000');
    check(lim.retryDelayMs('x') === 2000, 'empty text');
    check(lim.retryDelayMs('Retry-After: 0') === 2000, 'zero');
    check(/^\d+$/.test(String(lim.startIdentity(process.pid)?.start || '')), 'startIdentity is a number');
    const sc = join(TMP, 'l8.json');
    lim.reserve({ path: sc, task: 'z', group: 't', limits: { task: 4, group: 4, topSlots: 2 } });
    const before = readFileSync(sc, 'utf8');
    const s = spawnSync(process.execPath, [LIMIT_MODULE, 'status', '--path', sc], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: TMP } });
    check(s.status === 0 && JSON.parse(s.stdout).top_taken === 0, js({ s: s.status, o: s.stdout.slice(0, 160) }));
    check(readFileSync(sc, 'utf8') === before, 'the CLI status changed the state');
  });

  // ===== (L9-L14) integration in provider-advisor (OMC_PROVIDER_ADVISOR_LIMIT=1) =====
  const QUESTION_PLAN = [
    'DECISION: whether to push the fix to b.go; if so, I will change the test, if not, I go back to the plan',
    'TRIED: attempt-1: an import change',
    'TEST TAIL: FAIL b_test.go:12',
    'HYPOTHESIS: the import order',
    'EVIDENCE: rg "func b" shows a.go:3',
  ].join('\n');
  it('(L9) a refusal after the task limit is exhausted: exit 2, no model call, a "what next" message (continue without the advisor or report to the lead) and the names of the parameters OMC_PROVIDER_ADVISOR_LIMIT_*, status refused-task-limit with a journal record, the counter untouched by the refusal', () => {
    const r1 = advisor({}, ['question-L9-first']);
    check(r1.status === 0 && r1.called && r1.stdout.includes('ADVISOR-LIMIT: 3 left'), js({ s: r1.status, o: r1.stdout.slice(-80) }));
    const r2 = advisor({ OMC_PROVIDER_ADVISOR_LIMIT_PER_TASK: '1' }, ['question-L9-second']);
    check(r2.status === 2 && !r2.called, js({ s: r2.status, e: r2.stderr.slice(0, 120) }));
    check(/continue without the advisor or report to the lead/.test(r2.stderr) && /OMC_PROVIDER_ADVISOR_LIMIT_PER_TASK/.test(r2.stderr), js(r2.stderr.slice(0, 200)));
    const w = rows().at(-1);
    check(w.status === 'refused-task-limit' && w.limit_reason === 'task' && w.limit_left === 0, js(w));
    check(state().tasks[Z1].used === 1 && state().tasks[Z1].reserved === 0, js(state().tasks)); // the refusal did not raise it
  });
  it('(L9b) task ids are team-local: the same task id in another team (its own state root) does not share the per-task counter, while the same team and task is still refused; the counters of both teams are kept apart in the state file', () => {
    const file = join(TMP, 'l9b.json');
    const rootOf = (name) => {
      const root = join(TMP, `team-state-${name}`);
      mkdirSync(join(root, 'tasks'), { recursive: true });
      writeFileSync(join(root, 'tasks', '1.json'), js({ id: '1', subject: 'native task', description: 'x', status: 'in_progress', owner: 'worker-l' }));
      return root;
    };
    const one = { OMC_PROVIDER_ADVISOR_LIMIT_FILE: file, OMC_PROVIDER_ADVISOR_LIMIT_PER_TASK: '1', OMC_PROVIDER_ADVISOR_LIMIT_PER_GROUP: '5' };
    const a = { ...one, OMC_TEAM_WORKER: 'team-one/worker-l', OMC_TEAM_STATE_ROOT: rootOf('one') };
    const b = { ...one, OMC_TEAM_WORKER: 'team-two/worker-l', OMC_TEAM_STATE_ROOT: rootOf('two') };
    const first = advisor(a, ['question-L9b-first']);
    check(first.status === 0 && first.called, js({ s: first.status, e: first.stderr.slice(0, 150) }));
    const other = advisor(b, ['question-L9b-other-team']);
    check(other.status === 0 && other.called && other.stdout.includes('ADVISOR-LIMIT: 0 left'), js({ s: other.status, e: other.stderr.slice(0, 150), o: other.stdout.slice(-60) }));
    const again = advisor(a, ['question-L9b-same-team']);
    check(again.status === 2 && !again.called && rows().at(-1).limit_reason === 'task', js({ s: again.status, e: again.stderr.slice(0, 150) }));
    const counters = Object.values(state(file).tasks);
    check(counters.length === 2 && counters.every((c) => c.used === 1 && c.reserved === 0), js(state(file).tasks));
  });
  it('(L9c) the task key is injective: a separator character inside the state root, the team or the id does not merge two different triples; no id gives no key', () => {
    const triples = [['/srv/a|b', 'c', '1'], ['/srv/a', 'b|c', '1'], ['/srv/a', 'b', 'c|1'], ['/srv/a|b|c', '', '1'], ['/srv/a', 'b', 'c', ], ['', 'a|b', '1']];
    const keys = triples.map(([stateRoot, team, id]) => lim.taskKey({ stateRoot, team, id }));
    check(new Set(keys).size === triples.length, js(keys));
    check(lim.taskKey({ stateRoot: '/r', team: 't', id: null }) === null && lim.taskKey({ stateRoot: '/r', team: 't', id: '' }) === null, 'a key without an id');
    check(lim.taskKey({ stateRoot: '/r', team: 't', id: 7 }) === lim.taskKey({ stateRoot: '/r', team: 't', id: '7' }), 'a numeric id and its string differ');
  });
  it('(L10) ok with the limit: the line "ADVISOR-LIMIT: 3 left" in the answer; commit: used + 1, slots empty, the bucket released (top 0); permissions of the state 0600, the directory 0700', () => {
    const file = join(TMP, 'l10', 'limit.json');
    const r = advisor({ OMC_PROVIDER_ADVISOR_LIMIT_FILE: file }, ['question-L10']);
    check(r.status === 0 && r.stdout.includes('STUB-ANSWER') && r.stdout.includes('ADVISOR-LIMIT: 3 left'), js(r.stdout.slice(-100)));
    const st = state(file);
    check(st.tasks[Z1].used === 1 && st.tasks[Z1].reserved === 0 && st.slots.length === 0 && st.top.length === 0, js(st));
    check((statSync(file).mode & 0o777) === 0o600, (statSync(file).mode & 0o777).toString(8));
    check((statSync(dirname(file)).mode & 0o777) === 0o700, (statSync(dirname(file)).mode & 0o777).toString(8));
  });
  it('(L11) the 429 retry: the first attempt a rate-limit refusal (exit 5, Retry-After 1 s), the second OK -> status ok, the fake called twice, retry_429 in the journal row, the slot committed (used 1), the bucket released, the slot NOT consumed twice', () => {
    const file = join(TMP, 'l11.json');
    const r = advisor({ OMC_PROVIDER_ADVISOR_TIMEOUT_MS: '30000', OMC_PROVIDER_ADVISOR_LIMIT_FILE: file }, ['question-L11'], { scenario: '429-then-ok' });
    check(r.status === 0 && /ANSWER-AFTER-RETRY/.test(r.stdout) && r.calls === 2, js({ s: r.status, n: r.calls, o: r.stdout.slice(-80) }));
    const w = rows().at(-1);
    check(w.status === 'ok' && w.retry_429 === 1, js(w));
    const st = state(file);
    check(st.tasks[Z1].used === 1 && st.tasks[Z1].reserved === 0 && st.top.length === 0, js(st));
  });
  it('(L12) an answer from the journal: the same question plus diff (the input hash) -> advice from the journal with no model call and no slot; a type=cache row in the journal; status() counts journal_hits outside the consultations', () => {
    const on = { OMC_PROVIDER_ADVISOR_JOURNAL: '1', OMC_PROVIDER_ADVISOR_INPUT: '1', OMC_PROVIDER_ADVISOR_LIMIT_FILE: join(TMP, 'l12.json') };
    const a = advisor(on, ['--event', 'plan', QUESTION_PLAN]);
    check(a.status === 0 && a.called && a.calls === 1, js({ s: a.status, n: a.calls, e: a.stderr.slice(0, 120) }));
    const endA = rows().at(-1);
    check(endA.status === 'ok' && endA.advice === 'STUB-ANSWER: confirm', js(endA.status));
    const beforeCount = rows().length;
    const b = advisor(on, ['--event', 'plan', QUESTION_PLAN]);
    check(b.status === 0 && !b.called && b.stdout.includes('STUB-ANSWER: confirm') && b.stdout.includes('ADVISOR-LIMIT'), js({ s: b.status, o: b.stdout.slice(-100), e: b.stderr.slice(0, 120) }));
    check(rows().length === beforeCount + 1, 'cache: the row count');
    const wc = rows().at(-1);
    check(wc.type === 'cache' && wc.source_id === endA.consultation_id && wc.status === 'from-journal' && !('advice' in wc), js(wc));
    const st = state(on.OMC_PROVIDER_ADVISOR_LIMIT_FILE);
    check(st.tasks[Z1].used === 1 && st.tasks[Z1].reserved === 0, js(st.tasks)); // the cache did not consume a slot
    const stat = journalLib.status({ path: JOURNAL, windowHours: 5 });
    check(stat.journal_hits >= 1, js(stat.journal_hits));
  });
  it('(L13) queue-timeout: the bucket full (1 slot blocked by a live process), OMC_PROVIDER_ADVISOR_TOP_SLOTS=1 and a short wait -> exit 2, status queue-timeout, the consultation slot REFUNDED (reserved 0), no model call', () => {
    const blocked = join(TMP, 'l13.json');
    const startIdentity = lim.startIdentity(process.pid);
    const block = { id: 'block', pid: process.pid, start: startIdentity.start, ts: new Date().toISOString() };
    writeFileSync(blocked, js(emptyState({ top: [block] })));
    const r = advisor({ OMC_PROVIDER_ADVISOR_TOP_SLOTS: '1', OMC_PROVIDER_ADVISOR_QUEUE_WAIT_MS: '400', OMC_PROVIDER_ADVISOR_LIMIT_FILE: blocked }, ['question-L13']);
    check(r.status === 2 && !r.called, js({ s: r.status, e: r.stderr.slice(0, 140) }));
    check(/TOP-MODEL QUEUE BUSY/.test(r.stderr), js(r.stderr.slice(0, 160)));
    check(rows().at(-1).status === 'queue-timeout', js(rows().at(-1).status));
    const st = state(blocked);
    check(st.top.length === 1 && st.top[0].id === 'block' && !st.slots.length, js(st)); // the consultation slot refunded, the block untouched
  });
  it('(L14) refunds of the slot on the error paths: (a) a rate-limit refusal twice (after the retry is exhausted): exit 5, status refused-limit, a refund (reserved 0); (b) a fake timeout: exit 124, status timeout, a refund (reserved 0); the bucket released in both', () => {
    const file = join(TMP, 'l14.json');
    const a2 = advisor({ OMC_PROVIDER_ADVISOR_TIMEOUT_MS: '30000', OMC_PROVIDER_ADVISOR_LIMIT_FILE: file }, ['question-L14a'], { scenario: '429-twice' });
    check(a2.status === 5 && rows().at(-1).status === 'refused-limit' && state(file).tasks[Z1].used === 0 && state(file).tasks[Z1].reserved === 0, js({ s: a2.status, w: rows().at(-1).status, z: state(file).tasks }));
    check(rows().at(-1).retry_429 === 1, 'no trace of the retry with refused-limit');
    const t2 = advisor({ OMC_PROVIDER_ADVISOR_TIMEOUT_MS: '500', OMC_PROVIDER_ADVISOR_LIMIT_FILE: file }, ['question-L14b'], { scenario: 'sleep' });
    check(t2.status === 124 && rows().at(-1).status === 'timeout' && state(file).tasks[Z1].used === 0 && state(file).tasks[Z1].reserved === 0, js({ s: t2.status, w: rows().at(-1).status, z: state(file).tasks }));
    check(state(file).top.length === 0, 'the bucket was not released after the errors');
  });

  // ===== The Bash guard of the worker: the advisor counter is refused, the advisor command passes =====
  const guardEnv = { OMC_PROVIDER: 'acme', OMC_PROVIDER_GUARD: js({ allowedCommands: ['provider-advisor'] }) };
  const denied = (command) => guard.guardResponse({ tool_name: 'Bash', tool_input: { command } }, guardEnv)?.hookSpecificOutput?.permissionDecision === 'deny';
  it('(L15) the Bash guard: a refusal of advisor-limit by the bare name and by a path (status and write); the exception of the bare advisor command untouched (provider-advisor passes)', () => {
    check(denied('advisor-limit status'), 'the bare advisor-limit was let through');
    check(denied(`node ${LIMIT_MODULE} status`), 'the advisor-limit.cjs path was let through');
    check(denied('node /x/advisor-limit.cjs --path /y'), 'advisor-limit.cjs with flags was let through');
    check(!denied('provider-advisor "question"'), 'provider-advisor refused');
    check(denied('/tmp/provider-advisor "question"'), 'a path of the advisor was let through (the exception of the bare name)'); // the limit does not change the exception of the bare name
  });
  it('(L15b) the guard after the correction: cat, git add, rg and git diff on the file advisor-limit.cjs pass (work in the repository); still refused: the bare name, a path, node/bash with the module as the first script argument; the test file of the limit passes', () => {
    check(!denied(`cat ${LIMIT_MODULE}`), 'cat on advisor-limit.cjs refused');
    check(!denied('git add scripts/provider/lib/advisor-limit.cjs'), 'git add advisor-limit.cjs refused');
    check(!denied(`rg -n reserve ${LIMIT_MODULE}`), 'rg on advisor-limit.cjs refused');
    check(!denied(`git diff -- ${LIMIT_MODULE}`), 'git diff advisor-limit.cjs refused');
    check(!denied('grep -n advisor-limit README.md'), 'grep with the file name in the arguments refused');
    check(denied('advisor-limit status'), 'the bare name let through (a refusal expected)');
    check(denied(`node ${LIMIT_MODULE} status`), 'node with the module as the first script argument must be refused');
    check(denied('bash /x/advisor-limit.cjs'), 'bash with the module must be refused');
    check(!denied('npx vitest run src/__tests__/provider/advisor-limit.test.mjs'), 'the test file of the limit refused');
  });
  it('(L16) static limits of advisor-limit.cjs: no URL, no provider key, no model hard-coded, no key reads; the exports complete', () => {
    const code = readFileSync(LIMIT_MODULE, 'utf8').split('\n').filter((l) => !l.startsWith('//')).join('\n');
    check(!/https?:\/\//.test(code), 'a URL in the code');
    check(!/readKey|keyHelper|key-helper|apiKey|baseUrl/.test(code), 'the module reaches for a provider key or address');
    check(!/\w+_MODEL\s*[=:]/.test(code), 'a model hard-coded in the code');
    for (const e of ['enabled', 'limitFile', 'limits', 'reserve', 'commit', 'refund', 'waitForTop', 'releaseTop', 'closeSlots', 'retryDelayMs', 'findInJournal', 'appendHit', 'remainingFor', 'limitStatus', 'cliMode']) check(typeof lim[e] === 'function', `missing export ${e}`);
  });
  it('(L17) expiry of counters older than 7 days: an 8-day entry without reservations disappears (the limit returns to full), an entry with an active reservation (reserved > 0) stays, an entry without ts stays; ts is refreshed on a change', () => {
    const sc = join(TMP, 'l17.json');
    const old = Date.now() - 8 * 86400_000;
    writeFileSync(sc, js(emptyState({
      tasks: { 'z-old': { used: 4, reserved: 0, ts: old }, 'z-res': { used: 0, reserved: 1, ts: old }, 'z-nots': { used: 4, reserved: 0 } },
      groups: { 't-old': { used: 4, reserved: 0, ts: old } },
      slots: [{ id: 's1', task: 'z-res', group: 't-old', pid: process.pid, start: lim.startIdentity(process.pid).start, ts: '2026-11-01T00:00:00Z' }],
    })));
    const L = { task: 4, group: 4, topSlots: 2 };
    const r = lim.reserve({ path: sc, task: 'z-new', group: 't-new', limits: L });
    check(r.ok && r.left === 3, `left after the expiry and the reservation is not 3: ${js(state(sc).tasks)}`);
    check(!('z-old' in state(sc).tasks) && !('t-old' in state(sc).groups), 'the expired entry is still there');
    check('z-res' in state(sc).tasks, 'the entry with an active reservation was removed');
    check('z-nots' in state(sc).tasks, 'the entry without ts was removed');
  });
  it('(L18) the FIFO queue without jumping the queue: a free slot and a non-empty queue: a new process appends itself at the end and does not take the slot ahead of a waiter', () => {
    const sc = join(TMP, 'l18.json');
    const L = { task: 9, group: 9, topSlots: 2 };
    const mine = lim.startIdentity(process.pid).start;
    const entryA = { id: 'a-top', pid: process.pid, start: mine, ts: new Date().toISOString() };
    const entryB = { id: 'b-waits', pid: process.pid, start: mine, ts: new Date().toISOString() };
    writeFileSync(sc, js(emptyState({ top: [entryA], queue: [entryB] })));
    const script = `const lim = require(${js(LIMIT_MODULE)});
console.log(JSON.stringify(lim.waitForTop({ path: ${js(sc)}, limits: ${js(L)}, waitMs: 2500, stepMs: 50 })));`;
    const g = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
    check(g.stdout.trim().startsWith('{"ok":false'), `C took the slot (the old logic would give ok:true): ${js({ o: g.stdout, e: g.stderr.slice(0, 200) })}`);
    const after = state(sc);
    check(after.top.length === 1 && after.top[0].id === 'a-top', `C jumped the queue to the slot: ${js(after.top)}`);
    check(after.queue.length === 1 && after.queue[0].id === 'b-waits', `C did not append behind B or did not remove itself after the timeout: ${js(after.queue)}`);
  });
  it('(L19) retryDelayMs after the correction: an HTTP date in Retry-After gives no number (the default 2000); the form `Retry-After 12` without a colon is the default too (the pattern needs : or =)', () => {
    check(lim.retryDelayMs('Retry-After: Wed, 21 Oct 2026 07:28:00 GMT') === 2000, 'an HTTP date read as seconds');
    check(lim.retryDelayMs('too_many_requests, retry-after=30') === 30000, 'retry-after=30');
    check(lim.retryDelayMs('delay Retry-After 12 s') === 2000, 'a number without : and =');
  });
  it('(L20) the guard of limit calls: an unwritable state path (ENOTDIR) -> exit 0 with the answer of the fake, a limit-error message on stderr, a limit-error row in the journal, never an exception stack', () => {
    const badPath = join(TMP, 'plain-file', 'x', 'limit.json'); // ENOTDIR: plain-file is a file
    writeFileSync(join(TMP, 'plain-file'), 'x');
    const r = advisor({ OMC_PROVIDER_ADVISOR_LIMIT_FILE: badPath }, ['question-L20']);
    check(r.status === 0 && r.stdout.includes('STUB-ANSWER'), js({ s: r.status, o: r.stdout.slice(0, 80), e: r.stderr.slice(0, 200) }));
    check(/limit error/.test(r.stderr), js(r.stderr.slice(0, 200)));
    const w = rows().find((x) => x.status === 'limit-error');
    check(w && typeof w.limit_error === 'string', js(rows().map((x) => x.status)));
  });
  it('(L21) a zombie: a child that exits without being reaped is in state Z, ownerAlive is false, the slot is recovered', () => {
    const child = spawn('sleep', ['5']); // the parent (the test) does not reap: after the child exits the state is Z
    child.unref();
    const pid = child.pid;
    let zombie = false;
    const t = lim.startIdentity(pid);
    check(t && t.start !== 'absent', 'the start identity of the child is unreadable');
    child.kill('SIGKILL'); // an exit with no wait by the parent: a zombie
    let tries = 60;
    while (tries-- > 0) { const x = lim.startIdentity(pid); if (x && x.state === 'Z') { zombie = true; break; } spawnSync('sleep', ['0.05']); } // synchronous waits: the event loop must not reap the child
    check(zombie, `the child did not become a zombie (reaped by wait: ${js(lim.startIdentity(pid))})`);
    check(lim.ownerAlive(pid, t.start) === false, 'a zombie counted as alive');
    const sc = join(TMP, 'l21.json');
    writeFileSync(sc, js(emptyState({ tasks: { z: { used: 0, reserved: 1, ts: Date.now() } }, groups: { t: { used: 0, reserved: 1, ts: Date.now() } }, slots: [{ id: 'zz', task: 'z', group: 't', pid, start: t.start, ts: '2026-11-01T00:00:00Z' }] })));
    const r = lim.reserve({ path: sc, task: 'z', group: 't', limits: { task: 1, group: 1, topSlots: 1 } });
    check(r.ok, `the zombie slot was not recovered: ${js(r)}`);
  });
});
