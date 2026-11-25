/* global setTimeout, clearTimeout */
/**
 * Tests for hooks/jev-compaction.mjs opt-in switches: the token cascade (OMC_JEV_COMPACT_TARGET_PERCENT) and the
 * question that names its result (OMC_JEV_COMPACT_QUESTION_NAME). Without the variables the compaction is unchanged.
 * Units are called through their named exports; the end-to-end cases drive register(on) with a fake `$`, the way the
 * host does. No network: the transport stub answers the scoring request.
 */

import { describe, expect, it } from 'vitest';

import { QUESTION_CRITERIA, QUESTION_INSTRUCTIONS, cascade, cutInTokens, floorPrediction, listTokens, manualPlan, ratesFrom, register, scoreQuestion, shapeOf } from '../../hooks/jev-compaction.mjs';

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
  // The host's request stream is a generator; this one ends at once with the usage as its return value.
  // eslint-disable-next-line require-yield
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
    // The target is 85 % of 20 % of the 200 000 window (at most 75 % of the 167 000 threshold, which is the larger here), so 34 000.
    expect(record).toMatchObject({ cut: 'cascade', cascade_tokens_source: 'usage', cascade_target_tokens: 34000 });
    expect(['forced', 'short_or_trace', 'trace_all', 'drop']).toContain(record.cascade_pass);
    expect(record.cascade_predicted_tokens).toBeLessThan(130000);
  });

  it('forced results (a secret path or a non-text result) go to the trace first, before any score is used', () => {
    // Target 80 % of 6 000 tokens = 4 800; the two forced results trace (about 3 500 tokens removed) and that reaches it.
    const cands = [item('a', { secret: true, score: 3 }), item('b', { textOnly: false, score: 3 }), item('c', { score: 3 })];
    const plan = cascade(cands, 6000, 4800);
    expect(plan.pass).toBe('forced');
    expect(cands.map((c) => c.keep)).toEqual(['trace', 'trace', 'full']);
  });

  it('the short_or_trace pass traces the results scored under 0.5 first, then shortens the rest, and stops at the target', () => {
    // Two results scored 0 and one scored 2/3: the target is one result's worth below the three whole.
    const cands = [item('low1', { score: 0, resIdx: 1 }), item('low2', { score: 0, resIdx: 3 }), item('mid', { score: 2 / 3, resIdx: 5 })];
    const plan = cascade(cands, 3 * 1900, 3762);
    expect(plan.pass).toBe('short_or_trace');
    expect(cands[0].keep).toBe('trace');
    expect(plan.predicted).toBeLessThanOrEqual(plan.target);
  });

  it('stops as soon as the prediction reaches the target: the rest stays whole', () => {
    const cands = [item('a', { score: 0, resIdx: 1 }), item('b', { score: 0, resIdx: 2 }), item('c', { score: 0, resIdx: 3 })];
    const plan = cascade(cands, 3 * 1900, 3989);
    expect(plan.pass).toBe('short_or_trace');
    expect(cands.map((c) => c.keep)).toEqual(['trace', 'full', 'full']);
  });

  it('the trace_all pass traces every remaining result, the drop pass removes the traced ones with their calls when the target is still out of reach; a pinned task call stays whole', () => {
    // The pinned call (4 000 characters, about 1 800 tokens) is never cut, so the target is out of reach after the short_or_trace pass and the cascade
    // goes on to the trace_all pass, which traces the one free result; the prediction stays above the target, so the drop pass removes that trace with its call.
    const cands = [item('plan', { task: true, resIdx: 1 }), item('a', { score: 3, resIdx: 2 })];
    const plan = cascade(cands, 3700, 740);
    expect(plan.pass).toBe('drop');
    expect(cands.map((c) => c.keep)).toEqual(['full', 'drop']);
    expect(plan.predicted).toBeGreaterThan(plan.target);
  });

  it('the drop pass removes a traced result with its call only once the passes before did not reach the target, least needed first', () => {
    // Two free results of 3 000 characters (about 1 370 tokens whole each). With 3 360 tokens before and a 20 % target (672 tokens), the trace_all pass
    // traces both and predicts about 690 tokens, just above the target; the drop pass then drops the lower score (y) with its trace, which
    // reaches the target (about 652), so x stays a trace. The window holds for 3 340 to 3 380 tokens.
    const cands = [item('x', { score: 2, resIdx: 1, chars: 3000 }), item('y', { score: 1, resIdx: 2, chars: 3000 })];
    const plan = cascade(cands, 3360, 672);
    expect(plan.pass).toBe('drop');
    expect(plan.predicted).toBeLessThanOrEqual(plan.target);
    expect(cands.map((c) => [c.id, c.keep])).toEqual([['x', 'trace'], ['y', 'drop']]);
  });

  it('prices a result turned into a trace at the trace rate of the trace alone, with no newline added to its length', () => {
    // Ten results scored 0, no target to reach: the manual plan traces them all, so the prediction is the tokens before less ten times (whole minus trace).
    const cands = Array.from({ length: 10 }, (_, k) => item(`r${k}`, { score: 0, resIdx: k + 1 }));
    const whole = 0.5513 * ('Bash'.length + JSON.stringify(cands[0].use.input).length) + 0.4502 * cands[0].res.text.length;
    const trace = 0.58 * cands[0].trace.length;
    expect(manualPlan(cands, 20000).predicted).toBe(Math.round(20000 - 10 * (whole - trace)));
  });

  it('floorPrediction counts the removable results and leaves the pinned ones in the floor', () => {
    expect(floorPrediction([item('plan', { task: true, resIdx: 1 })], 3700)).toBe(3700);
    expect(floorPrediction([item('a', { score: 3, resIdx: 2 })], 3700)).toBeLessThan(3700);
  });

  it('the full cost of a result counts its image blocks at RATE_IMAGE (also a configured one): the floor and every cascade step take them off, a short copy is text only', () => {
    const base = item('img', { textOnly: false, chars: 0 });
    const none = { ...base, res: { text: '', isError: false } };
    const two = { ...base, res: { text: '', isError: false, result: [{ type: 'image' }, { type: 'image' }] } };
    const nested = { ...base, res: { text: '', isError: false, result: { content: [{ type: 'image' }, { type: 'text', text: 'x' }, { type: 'image' }] } } };
    expect(floorPrediction([none], 10000) - floorPrediction([two], 10000)).toBeCloseTo(2 * 2348, 6);
    expect(floorPrediction([none], 10000) - floorPrediction([nested], 10000)).toBeCloseTo(2 * 2348, 6);
    const rates = ratesFrom('{"RATE_IMAGE":100}');
    expect(floorPrediction([none], 10000, rates) - floorPrediction([two], 10000, rates)).toBeCloseTo(200, 6);
    // The forced pass (a result that cannot be sent goes to its trace) and the drop pass count them too.
    expect(cascade([none], 10000, 1).predicted - cascade([two], 10000, 1).predicted).toBe(2 * 2348);
    expect(manualPlan([none], 10000).predicted - manualPlan([two], 10000).predicted).toBe(2 * 2348);
  });

  it('the cascade is not run without the variable: allocate keeps its own keep decisions', async () => {
    const { record } = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' });
    expect(record).not.toHaveProperty('cut');
    expect(record).toHaveProperty('tokens_before');
  });
});

describe('drop pass, the floor, host handoff and the after record (token cascade)', () => {
  const TARGET_20 = { ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET_PERCENT: '20' };
  const HANDOFF_20 = { ...TARGET_20, OMC_JEV_COMPACT_HOST_HANDOFF: '1' };

  it('the token accounting and the plan agree for every keep decision, a dropped result (call and result gone) included', async () => {
    const { record } = await compactRun({ ...TARGET_20, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' }, { trigger: 'manual' });
    expect(record).toMatchObject({ cut: 'cascade', cascade_pass: 'drop', result: 'jev', tokens_source: 'usage' });
    expect(record.cascade_dropped).toBeGreaterThan(0);
    // The record says no more tokens are left than the plan predicts, and no fewer: a dropped result counts as zero retained tokens.
    expect(Math.abs(record.tokens_after - record.tokens_after_pred)).toBeLessThanOrEqual(1);
  });

  it('screenshots count: a session of 60 image results and 20 text results at 190 000 tokens has a floor lower by the image tokens and does not go to the host summary', async () => {
    const m = [{ role: 'user', text: 'Task: look at the screens and the notes.', toolUses: [] }];
    for (let i = 1; i <= 80; i++) {
      const image = i % 8 !== 0 && i % 8 !== 4;
      m.push({ role: 'assistant', text: `Step ${i}.`, toolUses: [{ tool_use_id: `t${i}`, tool: image ? 'Screenshot' : 'Bash', input: image ? { screen: i } : { command: `cat notes-${i}.txt` } }] });
      m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: image ? '' : `RESULT-${i} ${'x'.repeat(4000)}`, ...(image ? { result: [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }] } : {}), isError: false }] });
    }
    m.push({ role: 'user', text: 'Good, now sum up the results.', toolUses: [] }, { role: 'assistant', text: 'Summary: done.', toolUses: [] });
    const messages = m.map((x, k) => Object.freeze({ ...x, handle: `h${k}` }));
    const usage = async (o) => ({ context: { tokens: 190000, window: 200000, ...(o?.breakdown ? { breakdown: { rawMaxTokens: 200000, autoCompactThreshold: 167000 } } : {}) } });
    const { record } = await compactRun(TARGET_20, { messages, usage });
    // The threshold less 20 % of the window is 127 000: the text results alone leave the floor above it, the images take it far below.
    expect(record.non_text).toBeGreaterThan(50);
    expect(record.result).toBe('jev');
    expect(record.floor_pred).toBeLessThanOrEqual(190000 - record.non_text * 2348);
  });

  it('the drop pass removes results with their calls, and the rebuilt list keeps every call paired with its result', async () => {
    const { record, out } = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET_PERCENT: '20' });
    expect(record).toMatchObject({ cut: 'cascade', cascade_pass: 'drop', result: 'jev' });
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
    // An automatic compaction starts at the threshold (167 000 tokens). The target (106 462) is out of reach: the 25 results give back about 44 000
    // tokens when every one is gone, a cut of about 26 %, under HOST_MIN_CUT. The floor stays under 127 000 (167 000 less 33 400).
    const messages = conversation(25, 4000);
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

describe('predictions never go below zero (rates and the host usage may disagree)', () => {
  // The host's count is smaller than what the rates say the removable results cost, or a rate override makes them dear.
  const cands = () => Array.from({ length: 10 }, (_, k) => item(`r${k}`, { score: 0, resIdx: k + 1 }));

  it('the cascade, the manual plan and the floor stop at zero tokens after', () => {
    for (const target of [0, 500]) expect(cascade(cands(), 1000, target).predicted, `target ${target}`).toBe(0);
    expect(manualPlan(cands(), 1000).predicted).toBe(0);
    // Above zero nothing changes.
    expect(cascade(cands(), 20000, 18000).predicted).toBeGreaterThan(0);
    expect(manualPlan(cands(), 20000).predicted).toBeGreaterThan(0);
  });

  it('the record of a compaction with a dear RATE_OUT holds no negative token count, and the floor check still sees the unclamped floor', async () => {
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET_PERCENT: '20', OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1', OMC_JEV_COMPACT_RATES: '{"RATE_OUT":100}' };
    const { record } = await compactRun(env);
    expect(record).toMatchObject({ result: 'jev', cut: 'cascade' });
    for (const key of ['tokens_before', 'tokens_after', 'tokens_after_pred', 'cascade_predicted_tokens', 'floor_pred']) expect(record[key], key).toBeGreaterThanOrEqual(0);
    expect(record.floor_pred).toBe(0);
    expect(record.tokens_after).toBe(0);
    expect(record.cascade_predicted_tokens).toBe(0);
  });

  it('at the default rates the same compaction gives the numbers it gave', async () => {
    const { record } = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET_PERCENT: '20', OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' });
    expect(record.floor_pred).toBeGreaterThan(0);
    expect(record.tokens_after).toBeGreaterThan(0);
    const manual = await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET_PERCENT: '20', OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' }, { trigger: 'manual' });
    expect(Math.abs(manual.record.tokens_after - manual.record.tokens_after_pred)).toBeLessThanOrEqual(1);
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

describe('own threshold skip (OMC_JEV_COMPACT_OWN_THRESHOLD)', () => {
  const OWN = { ...ACTIVE_ENV, OMC_JEV_COMPACT_AT_PERCENT: '60', OMC_JEV_COMPACT_TARGET_PERCENT: '80' };
  const turn = (handlers, fake) => handlers['turn.complete'](fake.$, { isAborted: false }, async () => 'ok');

  // The own threshold asks the host to compact; the fake host runs the module's compaction with the trigger `plugin`, as the host does.
  async function ownRun(env, { messages = conversation(30, 4000), repeat = 1, usage } = {}) {
    const fake = fakeDollar({ env, usage });
    fake.$.session.messages = async () => messages;
    const handlers = {};
    register((event, hook) => { handlers[event] = hook; });
    const answers = [];
    fake.$.session.compact = async () => {
      const out = await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'plugin', messages }), async () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }));
      answers.push(out);
      return out;
    };
    for (let k = 0; k < repeat; k++) await turn(handlers, fake);
    return { answers, records: fake.records(), fake };
  }

  it('without the variable the own request is compacted as before', async () => {
    const { answers, records } = await ownRun(OWN);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toHaveProperty('messages');
    expect(answers[0]).not.toHaveProperty('skip');
    expect(records.find((r) => r.event === 'compact')).toMatchObject({ trigger: 'plugin', result: 'jev' });
  });

  it('a cut of the own request under HOST_MIN_CUT is answered with a skip and recorded as rejected', async () => {
    const { answers, records } = await ownRun({ ...OWN, OMC_JEV_COMPACT_OWN_THRESHOLD: '1' });
    expect(answers).toHaveLength(1);
    expect(typeof answers[0].skip).toBe('string');
    expect(answers[0].skip.startsWith('jev-compaction:')).toBe(true);
    expect(answers[0]).not.toHaveProperty('messages');
    expect(records.find((r) => r.event === 'compact')).toMatchObject({ result: 'fallback', reason: 'cut_below_host_min_skipped' });
    expect(records.find((r) => r.event === 'own_threshold')).toMatchObject({ result: 'rejected', reason: 'cut_below_host_min' });
  });

  it('after a skip the own threshold waits for OWN_MIN_GAIN of the window of growth from the skipped request, not only from the threshold', async () => {
    // The skipped request read 130 000 tokens of a 200 000 window. At 145 000 the growth from the threshold (120 000) is 25 000, enough for the
    // growth gate, but the growth from the skipped request is 15 000, under 10 % of the window; at 155 000 it is 25 000.
    let tokens = 130000;
    const usage = () => ({ context: { tokens, window: 200000 } });
    const env = { ...OWN, OMC_JEV_COMPACT_OWN_THRESHOLD: 'active' };
    const fake = fakeDollar({ env, usage });
    const messages = conversation(30, 4000);
    fake.$.session.messages = async () => messages;
    const handlers = {};
    register((event, hook) => { handlers[event] = hook; });
    let asks = 0;
    fake.$.session.compact = async () => {
      asks++;
      return handlers['session.compact'](fake.$, Object.freeze({ trigger: 'plugin', messages }), async () => ({ messages: [] }));
    };
    await turn(handlers, fake);
    expect(asks).toBe(1);
    for (let k = 0; k < 7; k++) await turn(handlers, fake);
    tokens = 145000;
    for (let k = 0; k < 7; k++) await turn(handlers, fake);
    expect(asks).toBe(1);
    tokens = 155000;
    await turn(handlers, fake);
    expect(asks).toBe(2);
  });

  it('without the token cascade the switch changes nothing: the preflight keeps no floor veto and the own request is compacted as without it', async () => {
    // 30 results of 3 300 characters cut about 45 000 tokens of 165 000, under the 30 % the floor veto asks for; no skip can follow without the cascade.
    const bare = { ...OWN };
    delete bare.OMC_JEV_COMPACT_TARGET_PERCENT;
    const usage = () => ({ context: { tokens: 165000, window: 200000 } });
    const messages = conversation(30, 3300);
    const off = await ownRun(bare, { messages, usage });
    expect(off.answers).toHaveLength(1);
    const on = await ownRun({ ...bare, OMC_JEV_COMPACT_OWN_THRESHOLD: '1' }, { messages, usage });
    expect(on.answers).toHaveLength(1);
    expect(on.answers[0]).toHaveProperty('messages');
    expect(on.answers[0]).not.toHaveProperty('skip');
    // With the cascade the same session is vetoed before any request.
    const cascade = await ownRun({ ...OWN, OMC_JEV_COMPACT_OWN_THRESHOLD: '1' }, { messages, usage });
    expect(cascade.answers).toHaveLength(0);
  });

  it('a compaction of another trigger is not skipped by the switch', async () => {
    const env = { ...OWN, OMC_JEV_COMPACT_OWN_THRESHOLD: '1' };
    const fake = fakeDollar({ env });
    const messages = conversation(30, 4000);
    fake.$.session.messages = async () => messages;
    const handlers = {};
    register((event, hook) => { handlers[event] = hook; });
    const out = await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'plugin', messages }), async () => ({ messages: [] }));
    expect(out).toHaveProperty('messages');
    expect(out).not.toHaveProperty('skip');
  });
});

describe('the blocks and messages of the list in the predictions (shapeOf)', () => {
  // A message of n blocks costs n * 45.4 - 40.5 tokens at the default rates (RATE_BLOCK and the negative constant of a message), and nothing when it holds no block.
  const msg = (n) => (n > 0 ? n * 45.4 - 40.5 : 0);
  /** A first user row, `batches` of parallel calls (a row of `size` calls without text, the row of their results and the answer after them), and a last request with its answer. */
  function parallel(batches, size, { chars = 4000 } = {}) {
    const rows = [{ role: 'user', text: 'Task.', toolUses: [] }];
    const group = [-1];
    for (let b = 0; b < batches; b++) {
      const ids = Array.from({ length: size }, (_, k) => `b${b}-${k}`);
      rows.push({ role: 'assistant', text: '', toolUses: ids.map((id) => ({ tool_use_id: id, tool: 'Bash', input: { command: `cat notes-${id}.txt` } })) });
      group.push(2 * b);
      rows.push({ role: 'user', text: '', toolUses: [], toolResults: ids.map((id) => ({ tool_use_id: id, text: `RESULT-${id} ${'x'.repeat(chars)}`, isError: false })) });
      group.push(-1);
      rows.push({ role: 'assistant', text: `Batch ${b} read.`, toolUses: [] });
      group.push(2 * b + 1);
    }
    rows.push({ role: 'user', text: 'Sum up.', toolUses: [] }, { role: 'assistant', text: 'Done.', toolUses: [] });
    group.push(-1, 2 * batches);
    const candidates = [];
    rows.forEach((m, i) => (m.toolResults || []).forEach((r, k) => candidates.push({ ...item(`${i}-${k}`, { score: 0, resIdx: i, chars }), id: r.tool_use_id, useIdx: i - 1 })));
    return { rows, group, candidates, shape: shapeOf(rows, candidates, { group, keepFrom: rows.length }) };
  }

  it('the traces of the calls of one message come into one text block and the message of their results is gone: each call and each result takes its block', () => {
    const { candidates, shape } = parallel(1, 25);
    // Before: 25 calls in one message, 25 results in one. After the traces: one text block, no message of results.
    expect(shape.shed(candidates, 'trace')).toBeCloseTo(msg(25) - msg(1) + msg(25), 6);
    // After the drop: both messages are gone.
    expect(shape.shed(candidates, 'drop')).toBeCloseTo(2 * msg(25), 6);
    // A short copy keeps the call and the result in their blocks; nothing is decided: nothing is taken off.
    expect(shape.shed(candidates, 'short')).toBeCloseTo(0, 6);
    expect(shape.shed([], 'trace')).toBeCloseTo(0, 6);
  });

  it('a result decided again counts as decided last: a trace that is dropped later is a drop, and a trace taken back leaves nothing', () => {
    const { candidates, shape } = parallel(1, 25);
    const stepped = shape.tracker();
    for (const c of candidates) stepped.set(c, 'trace');
    expect(stepped.removed()).toBeCloseTo(shape.shed(candidates, 'trace'), 6);
    for (const c of candidates) stepped.set(c, 'drop');
    expect(stepped.removed()).toBeCloseTo(shape.shed(candidates, 'drop'), 6);
    for (const c of candidates) stepped.set(c, 'full');
    expect(stepped.removed()).toBeCloseTo(0, 6);
  });

  it('a message that keeps a block keeps its constant: ten results of twenty-five traced take ten blocks of the results and nine of the calls (the first trace is the text block)', () => {
    const { candidates, shape } = parallel(1, 25);
    expect(shape.shed(candidates.slice(0, 10), 'trace')).toBeCloseTo(msg(25) - msg(15) + (msg(25) - msg(16)), 6);
  });

  it('a result and its call in a message of their own take the call block (the text of the step stays) and the whole message of the result', () => {
    const rows = [{ role: 'user', text: 'Task.', toolUses: [] }, { role: 'assistant', text: 'Step 1.', toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: { command: 'cat a' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'out', isError: false }] }, { role: 'user', text: 'Last.', toolUses: [] }, { role: 'assistant', text: 'Done.', toolUses: [] }];
    const group = [-1, 0, -1, -1, 1];
    const candidates = [{ ...item('a', { resIdx: 2 }), useIdx: 1 }];
    const shape = shapeOf(rows, candidates, { group, keepFrom: rows.length });
    // The user row of the result and the user row after it are one message of the host: the result row's block comes off it, the message stays.
    expect(shape.shed(candidates, 'trace')).toBeCloseTo(msg(2) - msg(2 - 1) + (msg(2) - msg(1)), 6);
    expect(shape.shed(candidates, 'drop')).toBeCloseTo((msg(2) - msg(1)) + (msg(2) - msg(1)), 6);
  });

  it('rows from keepFrom on keep their handles and stay as they are', () => {
    const { rows, group, candidates } = parallel(2, 5);
    const shape = shapeOf(rows, candidates, { group, keepFrom: 4 });
    // Only the first batch (rows 1 to 3) is rebuilt: the candidates of the second (rows 4 and 5) change nothing.
    const [first, second] = [candidates.filter((c) => c.resIdx === 2), candidates.filter((c) => c.resIdx === 5)];
    expect(shape.shed(second, 'drop')).toBeCloseTo(0, 6);
    expect(shape.shed(first, 'drop')).toBeCloseTo(2 * msg(5), 6);
  });

  it('a row of text results from keepFrom on is rebuilt by build, and the messages delivered after it become one block of it', () => {
    const { rows, group, candidates } = parallel(2, 5);
    // 4 messages came after the results of the second batch (row 5): the host holds them as blocks of their own, build writes them into the text of the row.
    const queued = new Map([[5, ['a', 'b', 'c', 'd']]]);
    const shape = shapeOf(rows, candidates.filter((c) => c.resIdx === 2), { group, keepFrom: 4, queued });
    // The row has 5 results and 4 deliveries (9 blocks) in the host's list and 5 results and one text block (6) in the built one, whatever is decided.
    expect(shape.tracker().removed()).toBeCloseTo(msg(9) - msg(6), 6);
    // Rows that keep their handle (a result that is no text) get their deliveries back from the host as they were.
    const image = rows.map((m, i) => (i === 5 ? { ...m, toolResults: m.toolResults.map((r, k) => (k === 0 ? { ...r, result: [{ type: 'image' }] } : r)) } : m));
    expect(shapeOf(image, [], { group, keepFrom: 4, queued }).tracker().removed()).toBeCloseTo(0, 6);
  });

  it('with a low block rate the floor of a message is on its text and its blocks together: a message that costs nothing is taken off the list as nothing', () => {
    const [call, text] = ['cat notes-a.txt', `RESULT-a ${'x'.repeat(300)}`];
    const use = { tool_use_id: 'a', tool: 'Bash', input: { command: call } };
    const rows = [{ role: 'user', text: 'Task.', toolUses: [] }, { role: 'assistant', text: 'Step 1.', toolUses: [use] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text, isError: false }] }, { role: 'assistant', text: 'Done.', toolUses: [] }];
    const group = [-1, 0, -1, 1];
    const before = [{ role: 'user', content: 'Task.' }, { role: 'assistant', content: [{ type: 'text', text: 'Step 1.' }, { type: 'tool_use', id: 'a', name: 'Bash', input: { command: call } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: text }] }, { role: 'assistant', content: 'Done.' }];
    // With the call and its result dropped, the assistant keeps its text and the message of the result is gone.
    const after = [{ role: 'user', content: 'Task.' }, { role: 'assistant', content: 'Step 1.' }, { role: 'assistant', content: 'Done.' }];
    for (const raw of [undefined, '{"RATE_BLOCK":1}', '{"RATE_BLOCK":20}', '{"RATE_BLOCK":40}']) {
      const rates = ratesFrom(raw);
      const candidates = [{ ...item('a', { resIdx: 2, chars: 300 }), useIdx: 1 }];
      const shape = shapeOf(rows, candidates, { group, keepFrom: rows.length, rates });
      // At RATE_BLOCK 1 the assistant message (a short text and a call) costs nothing, and at 20 it costs nothing once the call is gone: the text of the call is no
      // part of what the list loses then.
      expect(floorPrediction(candidates, listTokens(before, rates), rates, shape), String(raw)).toBeCloseTo(listTokens(after, rates), 6);
    }
  });

  it('a row of thinking is dropped and the rows of one message are one: the overhead build takes off whatever is decided (`removed`) is apart from what the decisions take (`gain`)', () => {
    const rows = [{ role: 'user', text: 'Task.', toolUses: [] }, { role: 'assistant', text: '', toolUses: [] }, { role: 'assistant', text: 'Look.', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: { command: 'cat a' } }] }, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'out', isError: false }] },
      { role: 'user', text: 'Last.', toolUses: [] }, { role: 'assistant', text: 'Done.', toolUses: [] }];
    const group = [-1, 0, 0, 0, -1, -1, 1];
    const candidates = [{ ...item('a', { resIdx: 4 }), useIdx: 3 }];
    const shape = shapeOf(rows, candidates, { group, keepFrom: rows.length });
    const none = shape.tracker();
    // The thinking block is gone: three blocks (thinking, text, call) become two (text, call).
    expect(none.removed()).toBeCloseTo(msg(3) - msg(2), 6);
    expect(none.gain()).toBeCloseTo(0, 6);
    const traced = shape.tracker();
    traced.set(candidates[0], 'trace');
    expect(traced.gain()).toBeCloseTo(msg(2) - msg(1) + (msg(2) - msg(1)), 6);
    expect(traced.removed() - traced.gain()).toBeCloseTo(none.removed(), 6);
  });

  it('the deliveries after a row are one block of the rebuilt row: the blocks of the rest are given back', () => {
    const rows = [{ role: 'user', text: 'Task.', toolUses: [] }, { role: 'assistant', text: 'Step.', toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: { command: 'cat a' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'out', isError: false }] }, { role: 'assistant', text: 'Next.', toolUses: [] }, { role: 'user', text: 'Last.', toolUses: [] }, { role: 'assistant', text: 'Done.', toolUses: [] }];
    const group = [-1, 0, -1, 1, -1, 2];
    const candidates = [{ ...item('a', { resIdx: 2 }), useIdx: 1 }];
    const queued = new Map([[2, ['d1', 'd2', 'd3']]]);
    const shape = shapeOf(rows, candidates, { group, keepFrom: rows.length, queued });
    // The row of the result holds the result and three deliveries (4 blocks): rebuilt, it holds their one text and the result (2 blocks); traced, the one text (1).
    expect(shape.tracker().removed()).toBeCloseTo(msg(4) - msg(2), 6);
    expect(shape.shed(candidates, 'trace')).toBeCloseTo(msg(4) - msg(1) + (msg(2) - msg(1)), 6);
  });

  it('a notification row replaced by a trace is one block as before, and one removed leaves only its deliveries; a row the agent trim removes is gone', () => {
    const rows = [{ role: 'user', text: 'Task.', toolUses: [] }, { role: 'assistant', text: 'Hello.', toolUses: [] }, { role: 'user', text: 'NOTE', toolUses: [] }, { role: 'assistant', text: 'Next.', toolUses: [] },
      { role: 'user', text: 'IDLE', toolUses: [] }, { role: 'assistant', text: 'Next.', toolUses: [] }, { role: 'user', text: 'Last.', toolUses: [] }, { role: 'assistant', text: 'Done.', toolUses: [] }];
    const group = [-1, 0, -1, 1, -1, 2, -1, 3];
    const note = { ...item('note', { resIdx: 2 }), note: true, useIdx: -1 };
    const shape = shapeOf(rows, [note], { group, keepFrom: rows.length, queued: new Map([[2, ['d1', 'd2']]]) });
    // The row holds its text and two deliveries (3 blocks): a trace or a short copy carries them in one text, a drop leaves the deliveries in one text too.
    expect(shape.shed([note], 'trace')).toBeCloseTo(msg(3) - msg(1), 6);
    expect(shape.shed([note], 'drop')).toBeCloseTo(msg(3) - msg(1), 6);
    const alone = shapeOf(rows, [{ ...note, resIdx: 2 }], { group, keepFrom: rows.length });
    expect(alone.shed([note], 'trace')).toBeCloseTo(0, 6);
    expect(alone.shed([note], 'drop')).toBeCloseTo(msg(1), 6);
    const trimmed = shapeOf(rows, [], { rows: rows.map((m, i) => (i === 4 ? { ...m, trimDrop: true } : m)), group, keepFrom: rows.length });
    expect(trimmed.tracker().removed()).toBeCloseTo(msg(1), 6);
  });

  it('a result whose trace is longer than its call and result is no pinned one when its blocks pay for the difference: the floor, the manual plan, the cascade and the gate count it', () => {
    // 25 calls and results of a dozen characters: the text of each (about 25 tokens) is shorter than its trace (about 38), so by the text alone every one would stay whole; each
    // takes its call block and its result block off the list, which is worth more (a message of 2 blocks is 50.3 tokens: the one block of the calls and the one of the results that come off last).
    const text = () => parallel(1, 25, { chars: 0 });
    const { rows, candidates, shape } = text();
    expect(shape.marginal(candidates[0])).toBeCloseTo(msg(2), 6);
    // Asking is no deciding: the shape is as it was, whichever result is asked in whatever order.
    expect(shape.marginal(candidates[7])).toBeCloseTo(msg(2), 6);
    expect(shape.marginal(candidates[0])).toBeCloseTo(msg(2), 6);
    expect(shape.shed(candidates, 'trace')).toBeCloseTo(msg(25) - msg(1) + msg(25), 6);
    // Without the shape the text decides, as before: nothing is removable, the floor is the list, the cascade has nothing to cut.
    expect(floorPrediction(candidates, 100000)).toBe(100000);
    expect(manualPlan(candidates, 100000).predicted).toBe(100000);
    expect(cutInTokens(candidates, rows, undefined).removable).toBe(0);
    expect(cascade(text().candidates, 60000, 59000)).toMatchObject({ pass: 'drop', predicted: 60000 });
    // With it the blocks count: the floor is under the list less the overhead of the whole message, the plan traces them, the gate sees the cut, the cascade reaches its target.
    expect(floorPrediction(candidates, 100000, undefined, shape)).toBeLessThan(100000 - shape.shed(candidates, 'drop'));
    expect(manualPlan(candidates, 100000, undefined, shape).predicted).toBeLessThan(100000 - 1500);
    const cut = cutInTokens(candidates, rows, undefined, 0, undefined, 0, shape);
    expect(cut.removable).toBeGreaterThan(1500);
    expect(cut.removable).toBeLessThan(shape.shed(candidates, 'trace'));
    const fresh = text();
    const run = cascade(fresh.candidates, 60000, 59000, undefined, fresh.shape);
    expect(run.pass).toBe('short_or_trace');
    expect(run.predicted).toBeLessThanOrEqual(59000);
    expect(fresh.candidates.some((c) => c.keep === 'trace')).toBe(true);
  });

  it('a result stays pinned when its blocks do not pay for the difference, and a task call always does', () => {
    // A trace of 400 characters (about 230 tokens) costs more than the blocks of its call and result give back (50.3).
    const long = parallel(1, 25, { chars: 0 });
    for (const c of long.candidates) c.trace = 't'.repeat(400);
    expect(floorPrediction(long.candidates, 100000, undefined, long.shape)).toBe(100000);
    expect(manualPlan(long.candidates, 100000, undefined, long.shape).predicted).toBe(100000);
    expect(cutInTokens(long.candidates, long.rows, undefined, 0, undefined, 0, long.shape).removable).toBe(0);
    expect(cascade(long.candidates, 60000, 59000, undefined, long.shape)).toMatchObject({ pass: 'drop', predicted: 60000 });
    const tasks = parallel(1, 25, { chars: 0 });
    for (const c of tasks.candidates) c.task = true;
    expect(floorPrediction(tasks.candidates, 100000, undefined, tasks.shape)).toBe(100000);
    expect(cutInTokens(tasks.candidates, tasks.rows, undefined, 0, undefined, 0, tasks.shape).removable).toBe(0);
  });

  it('the floor, the manual plan, the cascade and the gate count the overhead on top of the costs of the candidates, from the one shape', () => {
    const { rows, candidates, shape } = parallel(1, 25);
    const drop = shape.shed(candidates, 'drop');
    const trace = shape.shed(candidates, 'trace');
    expect(drop).toBeGreaterThan(2000);
    expect(floorPrediction(candidates, 100000) - floorPrediction(candidates, 100000, undefined, shape)).toBeCloseTo(drop, 6);
    expect(Math.abs(manualPlan(candidates, 100000).predicted - manualPlan(candidates, 100000, undefined, shape).predicted - trace)).toBeLessThan(1);
    expect(cutInTokens(candidates, rows, undefined, 0, undefined, 0, shape).removable - cutInTokens(candidates, rows, undefined).removable).toBeCloseTo(trace, 6);
    // The target is under what the traces reach with the costs alone (about 15 300 tokens of 60 000), above what they reach with the overhead (about 13 100).
    const bare = cascade(candidates, 60000, 14000);
    expect(bare.pass).toBe('drop');
    expect(bare.predicted).toBeGreaterThan(14000);
    const counted = cascade(candidates, 60000, 14000, undefined, shape);
    expect(counted.pass).toBe('short_or_trace');
    expect(counted.predicted).toBeLessThanOrEqual(14000);
    expect(candidates.some((c) => c.keep === 'drop')).toBe(false);
  });
});
