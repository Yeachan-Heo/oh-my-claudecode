/* global setTimeout, clearTimeout */
/**
 * Tests for hooks/jev-compaction.mjs opt-in switches: the token cascade (OMC_JEV_COMPACT_TARGET_PERCENT) and the
 * question that names its result (OMC_JEV_COMPACT_QUESTION_NAME). Without the variables the compaction is unchanged.
 * Units are called through their named exports; the end-to-end cases drive register(on) with a fake `$`, the way the
 * host does. No network: the transport stub answers the scoring request.
 */

import { describe, expect, it } from 'vitest';

import { QUESTION_CRITERIA, QUESTION_INSTRUCTIONS, cascade, floorPrediction, manualPlan, register, scoreQuestion } from '../../hooks/jev-compaction.mjs';

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

// Runs the compaction through register(on); returns the record, the scoring requests sent and what the host gets back.
async function compactRun(env, { messages = conversation(30), usage, trigger = 'auto' } = {}) {
  const fake = fakeDollar({ env, usage });
  fake.$.session.messages = async () => messages;
  const handlers = {};
  register((event, hook) => { handlers[event] = hook; });
  const next = async () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] });
  const out = await handlers['session.compact'](fake.$, Object.freeze({ trigger, messages }), next);
  const [record] = fake.records();
  return { record, requests: fake.requests, out };
}

// The compaction, then the first model request after it (turn.step) with the given usage; returns every record written to the spool.
async function compactThenRequest(env) {
  const fake = fakeDollar({ env });
  const messages = conversation(30);
  fake.$.session.messages = async () => messages;
  const handlers = {};
  register((event, hook) => { handlers[event] = hook; });
  await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages }), async () => ({ messages: [] }));
  const step = handlers['turn.step'](fake.$, Object.freeze({}), async function* request() {
    return { usage: { input_tokens: 100000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  });
  for (let r = await step.next(); !r.done; r = await step.next());
  return fake.records();
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

  it('sends the named question with the variable set to 1 or active (other values keep the plain question)', async () => {
    for (const value of ['1', 'active']) {
      const on = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_QUESTION_NAME: value });
      expect(on.requests[0].questions.r1.instructions.question).toContain('`results.r1`');
    }
    for (const value of ['off', '0', 'true', 'yes', 'shadow', '']) {
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
    // The automatic compaction raises the tokens to the threshold (200 000 window less 33 000 = 167 000), so 20 % of them is 33 400.
    expect(record).toMatchObject({ cut: 'cascade', cascade_tokens_source: 'usage', cascade_target_tokens: 33400 });
    expect(['forced', 'A', 'B', 'D']).toContain(record.cascade_pass);
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

  it('pass B traces every remaining result, pass D removes the traced ones with their calls when the target is still out of reach; a pinned task call stays whole', () => {
    // The pinned call (4 000 characters, about 1 800 tokens) is never cut, so the target is out of reach after pass A and the cascade
    // goes on to pass B, which traces the one free result; the prediction stays above the target, so pass D removes that trace with its call.
    const cands = [item('plan', { task: true, resIdx: 1 }), item('a', { score: 3, resIdx: 2 })];
    const plan = cascade(cands, 3700, 20);
    expect(plan.pass).toBe('D');
    expect(cands.map((c) => c.keep)).toEqual(['full', 'drop']);
    expect(plan.predicted).toBeGreaterThan(plan.target);
  });

  it('pass D removes a traced result with its call only once the passes before did not reach the target, least needed first', () => {
    // Two free results of 3 000 characters (about 1 370 tokens whole each). With 3 360 tokens before and a 20 % target (672 tokens), pass B
    // traces both and predicts about 690 tokens, just above the target; pass D then drops the lower score (y) with its trace, which
    // reaches the target (about 652), so x stays a trace. The window holds for 3 340 to 3 380 tokens.
    const cands = [item('x', { score: 2, resIdx: 1, chars: 3000 }), item('y', { score: 1, resIdx: 2, chars: 3000 })];
    const plan = cascade(cands, 3360, 20);
    expect(plan.pass).toBe('D');
    expect(plan.predicted).toBeLessThanOrEqual(plan.target);
    expect(cands.map((c) => [c.id, c.keep])).toEqual([['x', 'trace'], ['y', 'drop']]);
  });

  it('floorPrediction counts the removable results and leaves the pinned ones in the floor', () => {
    expect(floorPrediction([item('plan', { task: true, resIdx: 1 })], 3700)).toBe(3700);
    expect(floorPrediction([item('a', { score: 3, resIdx: 2 })], 3700)).toBeLessThan(3700);
  });

  it('the cascade is not run without the variable: allocate keeps its own keep decisions', async () => {
    const { record } = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' });
    expect(record).not.toHaveProperty('cut');
    expect(record).toHaveProperty('tokens_before');
  });
});

describe('pass D, the floor, host handoff and the after record (token cascade)', () => {
  const TARGET_20 = { ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET_PERCENT: '20' };
  const HANDOFF_20 = { ...TARGET_20, OMC_JEV_COMPACT_HOST_HANDOFF: '1' };

  it('pass D removes results with their calls, and the rebuilt list keeps every call paired with its result', async () => {
    const { record, out } = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET_PERCENT: '20' });
    expect(record).toMatchObject({ cut: 'cascade', cascade_pass: 'D', result: 'jev' });
    expect(record.cascade_dropped).toBeGreaterThan(0);
    const calls = out.messages.flatMap((m) => (m.toolUses || []).map((u) => u.tool_use_id)).sort();
    const results = out.messages.flatMap((m) => (m.toolResults || []).map((r) => r.tool_use_id)).sort();
    expect(calls).toEqual(results);
    expect(JSON.stringify(out.messages)).not.toContain('RESULT-1 ');
  });

  it('the floor above the threshold less FLOOR_MARGIN of the window sends the compaction to the host summary before Jev is asked', async () => {
    // Two results of 1 000 characters among the first messages (the last KEEP_LAST rows stay): the floor (every removable result gone) stays
    // near the 130 000 tokens of the usage, above 127 000 (threshold 167 000 less 40 000).
    const { record, requests } = await compactRun(TARGET_20, { messages: conversation(4, 1000) });
    expect(record).toMatchObject({ result: 'fallback', reason: 'floor_above_threshold' });
    expect(record.floor_pred).toBeGreaterThan(127000);
    expect(requests).toHaveLength(0);
  });

  it('without a known window the cascade falls back to the host summary', async () => {
    const { record } = await compactRun(TARGET_20, { usage: () => ({}) });
    expect(record).toMatchObject({ result: 'fallback', reason: 'no_window' });
  });

  it('a cut under HOST_MIN_CUT of the tokens goes to the host summary only with the handoff switch', async () => {
    // An automatic compaction starts at the threshold (167 000 tokens). About 20 traced results reach the 80 % target, leaving about 132 000
    // tokens: a cut of about 21 %, under HOST_MIN_CUT. The floor (every result gone) stays under 127 000.
    const messages = conversation(30, 4000);
    const off = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET_PERCENT: '80' }, { messages });
    expect(off.record.result).toBe('jev');
    const on = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET_PERCENT: '80', OMC_JEV_COMPACT_HOST_HANDOFF: '1' }, { messages });
    expect(on.record).toMatchObject({ result: 'fallback', reason: 'cut_below_host_min' });
  });

  it('the host gets the messages only without the handoff switch, and the tokens before and after with it', async () => {
    const off = await compactRun(TARGET_20);
    expect(Object.keys(off.out).sort()).toEqual(['messages']);
    const on = await compactRun(HANDOFF_20);
    expect(on.out).toMatchObject({ tokensBefore: 167000, tokensAfter: on.record.tokens_after_pred });
    expect(on.out.tokensAfter).toBeLessThan(on.out.tokensBefore);
    const active = await compactRun({ ...TARGET_20, OMC_JEV_COMPACT_HOST_HANDOFF: 'active' });
    expect(active.out).toMatchObject({ tokensBefore: 167000 });
    const shadow = await compactRun({ ...TARGET_20, OMC_JEV_COMPACT_HOST_HANDOFF: 'shadow' });
    expect(Object.keys(shadow.out).sort()).toEqual(['messages']);
  });

  it('the after record carries the prediction and its error only with the cascade', async () => {
    const withCascade = await compactThenRequest(TARGET_20);
    const compact = withCascade.find((r) => r.event === 'compact');
    const after = withCascade.find((r) => r.event === 'after');
    expect(after).toMatchObject({ tokens_after_real: 100000, tokens_after_pred: compact.tokens_after_pred });
    expect(after.error_pct).toBe(Math.round(((compact.tokens_after_pred - 100000) / 100000) * 1000) / 10);
    const plain = await compactThenRequest(ACTIVE_ENV);
    const plainAfter = plain.find((r) => r.event === 'after');
    expect(plainAfter).toBeDefined();
    expect(plainAfter).not.toHaveProperty('tokens_after_pred');
    expect(plainAfter).not.toHaveProperty('error_pct');
  });
});

describe('manual plan below the usual target (migrated rule: scores decide, no cascade)', () => {
  it('traces the forced results and the free results Jev scored under 0.5; a pinned call and the rest stay whole', () => {
    const cands = [
      item('a', { score: 0, resIdx: 1 }),
      item('b', { score: 3, resIdx: 2 }),
      item('s', { score: 3, resIdx: 3, secret: true }),
      item('plan', { task: true, score: 0, resIdx: 4 }),
    ];
    const plan = manualPlan(cands, 10000);
    expect(plan.pass).toBe('manual');
    expect(cands.map((c) => c.keep)).toEqual(['trace', 'full', 'trace', 'full']);
    expect(plan.predicted).toBeLessThan(10000);
  });

  it('an unrated result (score at the threshold) is not cut by the manual plan', () => {
    const cands = [item('u', { score: 0.5, resIdx: 1 })];
    manualPlan(cands, 10000);
    expect(cands[0].keep).toBe('full');
  });
});

describe('manual compaction against the rule target (migrated rule: scores first, the owner ceiling lowers the target)', () => {
  const MANUAL_20 = { ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET_PERCENT: '20' };
  // 200 000 window: usual target 40 000, rule target 34 000 (85 %); the threshold is 167 000, so 30 000 tokens is manual.
  const usage30k = () => ({ context: { tokens: 30000, window: 200000 } });

  it('a manual compaction at or below the rule target is decided by the scores: the target is 34 000 tokens', async () => {
    const { record } = await compactRun(MANUAL_20, { messages: conversation(4, 4000), usage: usage30k, trigger: 'manual' });
    expect(record).toMatchObject({ result: 'jev', cut: 'manual_scores', cascade_pass: 'manual', cascade_target_tokens: 34000, cascade_tokens_source: 'usage' });
  });

  it('the configured window ceiling (OMC_JEV_COMPACT_MAX_WINDOW_TOKENS) lowers the rule target; the scores then go on to the cascade', async () => {
    const { record } = await compactRun({ ...MANUAL_20, OMC_JEV_COMPACT_MAX_WINDOW_TOKENS: '20000' }, { messages: conversation(4, 4000), usage: usage30k, trigger: 'manual' });
    expect(record).toMatchObject({ cut: 'cascade', cascade_target_tokens: Math.floor(20000 / 1.012) });
  });
});
