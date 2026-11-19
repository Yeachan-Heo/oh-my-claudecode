/* global setTimeout, clearTimeout */
/**
 * Tests for hooks/jev-compaction.mjs opt-in switches: the token cascade (OMC_JEV_COMPACT_TARGET_PERCENT) and the
 * question that names its result (OMC_JEV_COMPACT_QUESTION_NAME). Without the variables the compaction is unchanged.
 * Units are called through their named exports; the end-to-end cases drive register(on) with a fake `$`, the way the
 * host does. No network: the transport stub answers the scoring request.
 */

import { describe, expect, it } from 'vitest';

import { QUESTION_CRITERIA, QUESTION_INSTRUCTIONS, cascade, floorPrediction, manualPlan, ratesFrom, register, scoreQuestion } from '../../hooks/jev-compaction.mjs';

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
