/* global setTimeout, clearTimeout */
/**
 * Tests for hooks/jev-compaction.mjs opt-in switches: the token cascade (OMC_JEV_COMPACT_TARGET_PERCENT) and the
 * question that names its result (OMC_JEV_COMPACT_QUESTION_NAME). Without the variables the compaction is unchanged.
 * Units are called through their named exports; the end-to-end cases drive register(on) with a fake `$`, the way the
 * host does. No network: the transport stub answers the scoring request.
 */

import { describe, expect, it } from 'vitest';

import { QUESTION_CRITERIA, QUESTION_INSTRUCTIONS, cascade, register, scoreQuestion } from '../../hooks/jev-compaction.mjs';

const ACTIVE_ENV = { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'test-key', HOME: '/home/u' };
const SPOOL = '/home/u/.omc/state/jev/compaction-spool/';

function scoreByMarker(body) {
  const answers = {};
  for (const name of Object.keys(body.questions)) {
    const text = body.state.results[name].result;
    answers[name] = { type: 'score', score: /NEEDED/.test(text) ? 3 : /MAYBE/.test(text) ? 2 : 0, confidence: 0.9 };
  }
  return { answers };
}

// A fake `$` with in-memory files; `requests` collects the bodies of the scoring requests.
function fakeDollar({ env = ACTIVE_ENV, usage } = {}) {
  const store = new Map();
  const requests = [];
  const $ = {
    env: { get: async (name) => env[name] },
    settings: { read: async () => undefined },
    fs: {
      read: async (p) => { if (!store.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return store.get(p); },
      exists: async (p) => store.has(p),
      stat: async (p) => { if (!store.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { kind: 'file', size: store.get(p).length, mtimeMs: Date.now(), isLink: false }; },
      write: async (p, text) => { store.set(p, text); },
      list: async () => [],
    },
    http: {
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        requests.push(body);
        return { ok: true, status: 200, headers: {}, text: JSON.stringify(scoreByMarker(body)) };
      },
    },
    clock: {
      after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; },
      sleep: async () => { throw new Error('the module must not use $.clock.sleep'); },
    },
    session: {
      id: async () => 'sess-cascade',
      usage: async (opts) => (usage ? usage(opts) : { context: { tokens: 130000, window: 200000 } }),
      messages: async () => [],
      compact: async () => ({}),
    },
    ui: { log: () => {}, toast: () => {} },
  };
  const records = () => [...store.entries()].filter(([p]) => p.startsWith(SPOOL)).map(([, t]) => JSON.parse(t));
  return { $, requests, records };
}

/** A first user message, `n` call/result pairs, a last request and an answer; each result has `chars` characters. */
function conversation(n, chars = 4000) {
  const m = [{ role: 'user', text: 'Task: review the notes and count the lines.', toolUses: [] }];
  for (let i = 1; i <= n; i++) {
    m.push({ role: 'assistant', text: `Step ${i}.`, toolUses: [{ tool_use_id: `t${i}`, tool: 'Bash', input: { command: `cat notes-${i}.txt` } }] });
    m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: `RESULT-${i} ${'x'.repeat(chars)}`, isError: false }] });
  }
  m.push({ role: 'user', text: 'Good, now sum up the results.', toolUses: [] });
  m.push({ role: 'assistant', text: 'Summary: done.', toolUses: [] });
  return m.map((x, k) => Object.freeze({ ...x, handle: `h${k}` }));
}

// Runs the compaction through register(on); returns the record and the scoring requests sent.
async function compactRun(env, { messages = conversation(30) } = {}) {
  const fake = fakeDollar({ env });
  fake.$.session.messages = async () => messages;
  const handlers = {};
  register((event, hook) => { handlers[event] = hook; });
  const next = async () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] });
  await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages }), next);
  const [record] = fake.records();
  return { record, requests: fake.requests };
}

const CUT_FIELDS = ['cut', 'cascade_pass', 'cascade_target_tokens', 'cascade_predicted_tokens', 'cascade_tokens_source'];

/** A candidate as findCandidates leaves it: a bash result of `chars` characters with its trace. */
function item(id, { score = 0, resIdx = 1, chars = 4000, secret = false, textOnly = true, task = false } = {}) {
  const text = `RESULT-${id} ${'x'.repeat(chars)}`;
  return {
    id, resIdx, secret, textOnly, task, score, asked: true,
    use: { tool: 'Bash', input: { command: `cat notes-${id}.txt` } },
    res: { text, isError: false },
    resultChars: text.length,
    trace: `[compacted] Bash(cat notes-${id}.txt) - result of ${text.length} chars removed`,
  };
}

describe('question naming its result (OMC_JEV_COMPACT_QUESTION_NAME)', () => {
  it('is the plain question by default and when the variable is not 1', () => {
    expect(scoreQuestion('r3', false)).toEqual({ type: 'score', instructions: QUESTION_INSTRUCTIONS, criteria: QUESTION_CRITERIA });
  });

  it('names the result key in the question text, compare and criteria as the documented shape', () => {
    const q = scoreQuestion('r3', true);
    expect(q.instructions.question).toContain('`results.r3`');
    expect(q.instructions.compare).toEqual(['`results.r3`', '`task`']);
    expect(q.instructions.focus).toBe('Judge whether further work will use it, not whether it was needed before.');
    expect(q.criteria).toEqual(QUESTION_CRITERIA.map((what) => ({ what })));
  });

  it('sends the named question only with the variable set to 1 (other values keep the plain question)', async () => {
    const on = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_QUESTION_NAME: '1' });
    expect(on.requests[0].questions.r1.instructions.question).toContain('`results.r1`');
    for (const value of ['off', '0', 'true', 'yes', '']) {
      const off = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_QUESTION_NAME: value });
      expect(off.requests[0].questions.r1).toEqual({ type: 'score', instructions: QUESTION_INSTRUCTIONS, criteria: QUESTION_CRITERIA });
    }
  });
});

describe('token cascade (OMC_JEV_COMPACT_TARGET_PERCENT)', () => {
  it('writes no cut field while the variable is unset (the default path)', async () => {
    const { record } = await compactRun(ACTIVE_ENV);
    expect(record).toBeDefined();
    for (const key of CUT_FIELDS) expect(record).not.toHaveProperty(key);
  });

  it('ignores a value that is not a two-digit share from 20 to 80', async () => {
    for (const value of ['90', '19', '81', 'abc', '5', '050']) {
      const { record } = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET_PERCENT: value });
      for (const key of CUT_FIELDS) expect(record).not.toHaveProperty(key);
    }
  });

  it('with a valid share writes the cascade record: target in tokens from the host usage, and the pass reached', async () => {
    const { record } = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET_PERCENT: '20' });
    expect(record).toMatchObject({ cut: 'cascade', cascade_tokens_source: 'usage', cascade_target_tokens: 26000 });
    expect(['forced', 'A', 'B']).toContain(record.cascade_pass);
    expect(record.cascade_predicted_tokens).toBeLessThan(130000);
  });

  it('forced results (a secret path or a non-text result) go to the trace first, before any score is used', () => {
    // Target 80 % of 6 000 tokens = 4 800; the two forced results trace (about 3 500 tokens removed) and that reaches it.
    const cands = [item('a', { secret: true, score: 3 }), item('b', { textOnly: false, score: 3 }), item('c', { score: 3 })];
    const plan = cascade(cands, 6000, 80);
    expect(plan.pass).toBe('forced');
    expect(cands.map((c) => c.keep)).toEqual(['trace', 'trace', 'full']);
  });

  it('pass A traces the results scored under 0.5 first, then shortens the rest, and stops at the target', () => {
    // Two results scored 0 and one scored 2/3: the target is one result's worth below the three whole.
    const cands = [item('low1', { score: 0, resIdx: 1 }), item('low2', { score: 0, resIdx: 3 }), item('mid', { score: 2 / 3, resIdx: 5 })];
    const plan = cascade(cands, 3 * 1900, 66);
    expect(plan.pass).toBe('A');
    expect(cands[0].keep).toBe('trace');
    expect(plan.predicted).toBeLessThanOrEqual(plan.target);
  });

  it('stops as soon as the prediction reaches the target: the rest stays whole', () => {
    const cands = [item('a', { score: 0, resIdx: 1 }), item('b', { score: 0, resIdx: 2 }), item('c', { score: 0, resIdx: 3 })];
    const plan = cascade(cands, 3 * 1900, 70);
    expect(plan.pass).toBe('A');
    expect(cands.map((c) => c.keep)).toEqual(['trace', 'full', 'full']);
  });

  it('pass B traces every remaining result when the passes before do not reach the target; a pinned task call stays whole', () => {
    // The pinned call (4 000 characters, about 1 800 tokens) is never cut, so the target is out of reach after pass A and the cascade
    // goes on to pass B, which traces the one free result; the prediction then stays above the target and nothing is dropped.
    const cands = [item('plan', { task: true, resIdx: 1 }), item('a', { score: 3, resIdx: 2 })];
    const plan = cascade(cands, 3700, 20);
    expect(plan.pass).toBe('B');
    expect(cands.map((c) => c.keep)).toEqual(['full', 'trace']);
    expect(plan.predicted).toBeGreaterThan(plan.target);
  });

  it('the cascade is not run without the variable: allocate keeps its own keep decisions', async () => {
    const { record } = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' });
    expect(record).not.toHaveProperty('cut');
    expect(record).toHaveProperty('tokens_before');
  });
});
