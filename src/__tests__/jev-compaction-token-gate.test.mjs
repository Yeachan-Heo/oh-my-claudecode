/* global setTimeout, clearTimeout */
/**
 * Tests for the gates on characters that decide whether a session is worth a compaction of the module (hooks/jev-compaction.mjs): the `too_few_results` gate
 * of decide and the preflight of the own threshold. With the token cascade (OMC_JEV_COMPACT_TARGET_PERCENT) a session that fails them on characters is measured
 * in tokens too, so a session of screenshots (images alone, no text, thousands of tokens each) is not sent to the host's summary or left alone for want of
 * characters. Without the variable the gates are the characters alone, as they were. The end-to-end cases drive register(on) with a fake `$` and the API form
 * of the host; no network.
 */

import { describe, expect, it } from 'vitest';

import { cutInTokens, listTokens, ratesFrom, register, worthInTokens } from '../../hooks/jev-compaction.mjs';

const ACTIVE_ENV = { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'test-key', HOME: '/home/u' };
const TARGET_20 = { ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET_PERCENT: '20' };
const SPOOL = '/home/u/.omc/state/jev/compaction-spool/';
const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };

function fakeDollar({ env, usage, messages, api }) {
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
        return { ok: true, status: 200, headers: {}, text: JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map((q) => [q, { type: 'score', score: 0, confidence: 0.9 }])) }) };
      },
    },
    clock: { after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; }, sleep: async () => { throw new Error('the module must not use $.clock.sleep'); } },
    session: { id: async () => 'sess-gate', usage, messages: async (o) => (api && o?.as === 'api' ? api : messages), compact: async () => ({}) },
    ui: { log: () => {}, toast: () => {} },
  };
  const records = () => [...store.entries()].filter(([p]) => p.startsWith(SPOOL)).map(([, t]) => JSON.parse(t));
  return { $, requests, records };
}

// The host's usage: `tokens` in the context of a 200 000 window that compacts at 167 000.
const usageOf = (tokens) => async (o) => ({ context: { tokens, window: 200000, ...(o?.breakdown ? { breakdown: { rawMaxTokens: 200000, autoCompactThreshold: 167000 } } : {}) } });

/**
 * The API form of the rows: the calls and the text as they stand, a result as its blocks (the images of a row in `result` as blocks of the result). `after` (a call
 * id to texts) adds delivered blocks after that call's result, as the host does for a message that came during the tool turn; no row shows them.
 */
function apiOf(messages, after = {}) {
  const api = [];
  for (const m of messages) {
    const content = m.role === 'assistant'
      ? [...(m.text ? [{ type: 'text', text: m.text }] : []), ...m.toolUses.map((u) => ({ type: 'tool_use', id: u.tool_use_id, name: u.tool, input: u.input }))]
      : [...(m.toolResults || []).flatMap((r) => [{ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.result ? [...(r.text ? [{ type: 'text', text: r.text }] : []), ...r.result] : r.text }, ...(after[r.tool_use_id] || []).map((text) => ({ type: 'text', text }))]), ...(m.text ? [{ type: 'text', text: m.text }] : [])];
    if (m.role === 'user' && api[api.length - 1]?.role === 'user') api[api.length - 1].content.push(...content); else api.push({ role: m.role, content });
  }
  return api;
}

/**
 * A task, `n` steps (a call and its result) and a last request with its answer. A step is a screenshot (a result of one image, no text) when `shot(i)` says
 * so, else a text result of `chars` characters; `said` is the assistant's text before each call.
 */
function session(n, { shot = () => true, chars = 50, said = (i) => `Step ${i}.` } = {}) {
  const m = [{ role: 'user', text: 'Task: look at the screens and the notes.', toolUses: [] }];
  for (let i = 1; i <= n; i++) {
    const image = shot(i);
    m.push({ role: 'assistant', text: said(i), toolUses: [{ tool_use_id: `t${i}`, tool: image ? 'Screenshot' : 'Bash', input: image ? { screen: i } : { command: `cat notes-${i}.txt` } }] });
    m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: image ? '' : `RESULT-${i} ${'x'.repeat(chars)}`, ...(image ? { result: [IMAGE] } : {}), isError: false }] });
  }
  m.push({ role: 'user', text: 'Good, now sum up the results.', toolUses: [] }, { role: 'assistant', text: 'Summary: done.', toolUses: [] });
  return m.map((x, k) => Object.freeze({ ...x, handle: `h${k}` }));
}

/**
 * `batches` of `size` parallel calls: a row of the assistant with all the calls (no text), one row with all their results, then a last request with its answer. A result
 * is `chars` characters.
 */
function parallelSession(batches, size, { chars = 300 } = {}) {
  const m = [{ role: 'user', text: 'Task: read the notes.', toolUses: [] }];
  for (let b = 0; b < batches; b++) {
    const ids = Array.from({ length: size }, (_, k) => `t${b}-${k}`);
    m.push({ role: 'assistant', text: '', toolUses: ids.map((id) => ({ tool_use_id: id, tool: 'Bash', input: { command: `cat ${id}.txt` } })) });
    m.push({ role: 'user', text: '', toolUses: [], toolResults: ids.map((id) => ({ tool_use_id: id, text: `RESULT-${id} ${'x'.repeat(chars)}`, isError: false })) });
  }
  m.push({ role: 'user', text: 'Good, now sum up the results.', toolUses: [] }, { role: 'assistant', text: 'Summary: done.', toolUses: [] });
  return m.map((x, k) => Object.freeze({ ...x, handle: `h${k}` }));
}

// The compaction through register(on): the record, the scoring requests and what the host gets back. `form: false` leaves the API form out (the host answers rows);
// `api` is the API form the host answers instead of the one made from the rows; `tokens: null` is a host with no usage to give (the tokens before are estimated).
async function compactRun(env, messages, { tokens = 190000, trigger = 'auto', form = true, after, api } = {}) {
  const fake = fakeDollar({ env, usage: usageOf(tokens), messages, api: api ?? (form ? apiOf(messages, after) : undefined) });
  const handlers = {};
  register((event, hook) => { handlers[event] = hook; });
  const out = await handlers['session.compact'](fake.$, Object.freeze({ trigger, messages }), async () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }));
  return { record: fake.records().find((r) => r.event === 'compact'), requests: fake.requests, out };
}

// The own threshold: a turn ends, the usage is at `tokens`, and the host (which compacts with the trigger `plugin`) is asked or not.
async function ownRun(env, messages, { tokens = 190000, after } = {}) {
  const fake = fakeDollar({ env, usage: usageOf(tokens), messages, api: apiOf(messages, after) });
  const handlers = {};
  register((event, hook) => { handlers[event] = hook; });
  const asked = [];
  fake.$.session.compact = async () => {
    const out = await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'plugin', messages }), async () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }));
    asked.push(out);
    return out;
  };
  await handlers['turn.complete'](fake.$, { isAborted: false }, async () => 'ok');
  return { asked, records: fake.records() };
}

describe('a session of screenshots in the compaction (the character gate in token mode)', () => {
  // The case of the review: 80 screenshots, no text in any result, 190 000 tokens; 78 of them are older than the last six messages.
  const shots = () => session(80);

  it('with the token cascade the gate counts the tokens of the images: the floor is predicted, the screenshots go to their traces and the summary does not run', async () => {
    const { record, out, requests } = await compactRun(TARGET_20, shots());
    expect(record).toMatchObject({ result: 'jev', candidates: 78, non_text: 78, max_reduction: 0, cut: 'cascade', cascade_pass: 'forced' });
    // The characters say 0; the tokens say the share the images are of the list.
    expect(record.max_reduction_tokens).toBeGreaterThan(0.85);
    expect(record.max_reduction_tokens).toBeLessThan(1);
    // The floor is the 190 000 tokens less every result with its call (an image 2348 tokens, a call about 13) and the overhead that goes with them in the list: the
    // block of the call (45.4, its message keeps the text of the step) and the message of the result (one block, 45.4 less the message constant 40.5).
    const overhead = 45.4 + (45.4 - 40.5);
    expect(record.floor_pred).toBeGreaterThan(190000 - 78 * (2348 + 20 + overhead));
    expect(record.floor_pred).toBeLessThan(190000 - 78 * (2348 + overhead));
    expect(record.tokens_after_pred).toBeLessThan(record.cascade_target_tokens);
    expect(requests).toHaveLength(0);
    const traces = out.messages.filter((m) => (m.text || '').includes('[compacted] Screenshot('));
    expect(traces).toHaveLength(78);
    expect(traces.every((m) => m.text.includes('non-text result (image or file) removed'))).toBe(true);
    expect(JSON.stringify(out.messages)).not.toContain('SUMMARY');
  });

  it('the same session without the cascade goes to the host summary on the characters, as before: nothing in the record is new', async () => {
    const { record, out } = await compactRun(ACTIVE_ENV, shots());
    expect(record).toMatchObject({ result: 'fallback', reason: 'too_few_results', candidates: 78, max_reduction: 0 });
    expect(record).not.toHaveProperty('max_reduction_tokens');
    expect(record).not.toHaveProperty('floor_pred');
    expect(out.messages).toEqual([{ role: 'user', text: 'SUMMARY', toolUses: [] }]);
  });

  it('without the API form (the host answers rows) the images stand in the list as well, so the share is no more than the whole', async () => {
    const { record } = await compactRun(TARGET_20, shots(), { form: false });
    expect(record).toMatchObject({ result: 'jev', non_text: 78 });
    expect(record.max_reduction_tokens).toBeGreaterThan(0.85);
    expect(record.max_reduction_tokens).toBeLessThan(1);
  });

  it('a few screenshots in a session of text stay under the bound: the gate still sends it to the summary, in token mode too', async () => {
    // 3 images (about 7 000 tokens) against 80 steps of 1 500 characters of the assistant's text each (about 38 000 tokens): about 15 % of the list.
    const messages = session(80, { shot: (i) => i % 26 === 0, said: (i) => `Step ${i}. ${'The notes are read and the files are listed. '.repeat(34)}` });
    const { record, out } = await compactRun(TARGET_20, messages);
    expect(record).toMatchObject({ result: 'fallback', reason: 'too_few_results' });
    expect(record.max_reduction_tokens).toBeLessThan(0.3);
    expect(record).not.toHaveProperty('floor_pred');
    expect(out.messages).toEqual([{ role: 'user', text: 'SUMMARY', toolUses: [] }]);
  });

  // Messages that came during the tool turn stand in the API form only: they are part of the list, and build carries each in an envelope of the reminder class.
  const note = (k) => `The coordinator sent a message while you were working:\nn${k}`;
  const deliveries = { t10: Array.from({ length: 4000 }, (_, k) => note(k)) };

  // build carries the deliveries of a row as one block, so each delivery merged takes its block (RATE_BLOCK) off the list, which is more than its envelope costs.
  // A block of 1 token leaves the envelopes the larger part of what the deliveries change, which is what these cases show.
  const FEW_BLOCK_TOKENS = { ...TARGET_20, OMC_JEV_COMPACT_RATES: '{"RATE_BLOCK":1}' };
  const manyDeliveries = { t10: Array.from({ length: 8000 }, (_, k) => note(k)) };

  it('the messages delivered during the tool turn are in the list and their envelopes come off what can be cut: many short ones leave the screenshots too small a share', async () => {
    const plain = await compactRun(FEW_BLOCK_TOKENS, shots());
    expect(plain.record.max_reduction_tokens).toBeGreaterThan(0.85);
    const run = await compactRun(FEW_BLOCK_TOKENS, shots(), { after: manyDeliveries });
    expect(run.record).toMatchObject({ result: 'fallback', reason: 'too_few_results', queued_other: 8000 });
    expect(run.record.max_reduction_tokens).toBeLessThan(0.3);
  });

  it('the blocks of the deliveries that build carries as one are part of what the compaction gives back: with the usual block overhead the same deliveries do not leave too small a share', async () => {
    const run = await compactRun(TARGET_20, shots(), { after: deliveries });
    expect(run.record).toMatchObject({ result: 'jev', queued_other: 4000 });
    expect(run.record.max_reduction_tokens).toBeGreaterThan(0.3);
  });

  it('a session that passes the character gate is decided as before in token mode: the token measure is not read', async () => {
    const messages = session(30, { shot: () => false, chars: 4000 });
    const { record } = await compactRun(TARGET_20, messages, { tokens: 130000 });
    expect(record.result).toBe('jev');
    expect(record.max_reduction).toBeGreaterThanOrEqual(0.3);
    expect(record).not.toHaveProperty('max_reduction_tokens');
  });

  it('a session with nothing to cut stays with the summary in token mode', async () => {
    const { record } = await compactRun(TARGET_20, session(30, { shot: () => false, chars: 0 }), { tokens: 130000 });
    expect(record).toMatchObject({ result: 'fallback', reason: 'too_few_results', max_reduction_tokens: 0 });
  });
});

describe('the prediction counts the envelopes build adds to the rows it rebuilds', () => {
  // One message that came during the tool turn, after the result of step 10 (a screenshot that goes to its trace): build carries it into that row in an envelope
  // of the host's reminder class, and the host's count does not hold the envelope.
  const DELIVERED = 'The coordinator sent a message while you were working:\nd1';

  it('the floor and the tokens after rise by the tokens of the envelope that is installed, and by nothing else', async () => {
    const env = { ...TARGET_20, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' };
    const plain = await compactRun(env, session(80));
    const run = await compactRun(env, session(80), { after: { t10: [DELIVERED] } });
    expect(run.record).toMatchObject({ result: 'jev', queued_other: 1 });
    // What the installed row holds besides the delivery: the envelope (its tags, by the text of the row itself).
    const row = run.out.messages.find((m) => (m.text || '').includes(DELIVERED));
    expect(row).toBeTruthy();
    const wrapper = row.text.length - DELIVERED.length - row.text.slice(0, row.text.indexOf('<system-reminder')).length;
    expect(wrapper).toBeGreaterThan(20);
    // The delivery stands in the message of the result: when the result goes, that message stays with the delivery's block, so the message constant (-40.5) is
    // not taken off as it is with the whole message gone in the plain run.
    const extra = 0.363 * wrapper - 40.5;
    for (const key of ['floor_pred', 'tokens_after_pred', 'tokens_after']) {
      const grew = run.record[key] - plain.record[key];
      expect(grew, key).toBeGreaterThan(extra - 2);
      expect(grew, key).toBeLessThan(extra + 8);
    }
  });
});

describe('parallel calls: the predictions count the blocks and messages that build removes or merges', () => {
  // 20 batches of 25 calls. 450 of the 500 results are before the tail (the last six messages), and each is 300 characters. The host's count is the estimate of the
  // list itself, so the prediction can be held to the estimate of the list that is installed.
  const ENV = { ...TARGET_20, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' };
  const rows = parallelSession(20, 25);
  const counted = Math.round(listTokens(apiOf(rows)));

  it('the cascade stops at traces, and the floor and the tokens after are the estimate of the list that is installed', async () => {
    const { record, out } = await compactRun(ENV, rows, { tokens: counted, trigger: 'manual' });
    expect(record).toMatchObject({ result: 'jev', candidates: 450, cascade_pass: 'short_or_trace', cascade_dropped: 0, tokens_before: counted });
    // A trace stands in the list with the line break before it, which the prediction leaves out: under a token for each.
    const slack = 0.6 * record.traced + 2;
    const installed = listTokens(apiOf(out.messages));
    expect(Math.abs(record.tokens_after_pred - installed)).toBeLessThanOrEqual(slack);
    expect(Math.abs(record.tokens_after - installed)).toBeLessThanOrEqual(slack);
    // It stops at the first step that reaches the target: a result more kept whole would leave it above (a step is about 200 tokens).
    expect(record.tokens_after_pred).toBeLessThanOrEqual(record.cascade_target_tokens);
    expect(record.tokens_after_pred).toBeGreaterThan(record.cascade_target_tokens - 300);
    expect(record.kept_full).toBeGreaterThan(0);
    // The floor is the list without any of the 450 results and the calls of them: the tail from row 37 on and the first request.
    expect(Math.abs(record.floor_pred - listTokens(apiOf([rows[0], ...rows.slice(37)])))).toBeLessThanOrEqual(2);
    // The calls that stay are those of the results kept whole and the 50 of the tail.
    expect(out.messages.reduce((n, m) => n + (m.toolUses || []).length, 0)).toBe(record.kept_full + 50);
  });

  it('the gate on characters counts them too: results that give back almost nothing in text, with 25 calls to a message, are worth a compaction', async () => {
    // A result of 50 characters is about as long as its trace (61), so the characters (21 %) and the text of the tokens (about 6 of the 130 of each result with its
    // call) are under the bound, and the 45.4 tokens of the block of each call and of each result are what the compaction gives back.
    const small = parallelSession(20, 25, { chars: 36 });
    const { record } = await compactRun(ENV, small, { tokens: Math.round(listTokens(apiOf(small))), trigger: 'manual' });
    expect(record.max_reduction).toBeLessThan(0.3);
    expect(record.max_reduction_tokens).toBeGreaterThan(0.3);
    expect(record.result).toBe('jev');
  });

  it('the preflight of the own threshold counts them too: its floor veto lets a session through when the overhead of the blocks is what makes the cut', async () => {
    // The 450 results of 50 characters with their calls are about 19 000 tokens of text, under the 30 % of 150 000 (45 000) that the veto asks; with the blocks of
    // their calls and results (and the messages of the results) they give back about 39 000 more.
    const small = parallelSession(20, 25, { chars: 36 });
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_AT_PERCENT: '60', OMC_JEV_COMPACT_TARGET_PERCENT: '20', OMC_JEV_COMPACT_OWN_THRESHOLD: 'active' };
    expect((await ownRun(env, small, { tokens: 150000 })).asked).toHaveLength(1);
  });
});

describe('a session of screenshots and the own threshold (OMC_JEV_COMPACT_AT_PERCENT)', () => {
  const OWN = { ...ACTIVE_ENV, OMC_JEV_COMPACT_AT_PERCENT: '60' };

  it('with the token cascade the preflight counts the tokens of the images and asks the host to compact', async () => {
    const { asked, records } = await ownRun({ ...OWN, OMC_JEV_COMPACT_TARGET_PERCENT: '20' }, session(80));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveProperty('messages');
    expect(records.find((r) => r.event === 'compact')).toMatchObject({ trigger: 'plugin', result: 'jev', non_text: 78 });
  });

  it('without the cascade it does not ask: the characters of the screenshots are none', async () => {
    const { asked, records } = await ownRun(OWN, session(80));
    expect(asked).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  it('the preflight counts the messages delivered during the tool turn once the API form is read: a large one leaves the screenshots too small a share to ask', async () => {
    const note = `<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<result>${'y'.repeat(1500000)}</result>\n</task-notification>\n</system-reminder>`;
    const env = { ...OWN, OMC_JEV_COMPACT_TARGET_PERCENT: '20' };
    expect((await ownRun(env, session(80))).asked).toHaveLength(1);
    expect((await ownRun(env, session(80), { after: { t10: [note] } })).asked).toHaveLength(0);
  });

  it('the preflight takes the envelopes build adds off what can be cut: many short deliveries leave the screenshots too small a share to ask', async () => {
    // A block of 1 token: the deliveries become one block, and with the usual 45.4 tokens a block that would give back more than their envelopes cost.
    const after = { t10: Array.from({ length: 8000 }, (_, k) => `The coordinator sent a message while you were working:\nn${k}`) };
    expect((await ownRun({ ...OWN, OMC_JEV_COMPACT_TARGET_PERCENT: '20', OMC_JEV_COMPACT_RATES: '{"RATE_BLOCK":1}' }, session(80), { after })).asked).toHaveLength(0);
  });

  it('with the cascade, a few screenshots in a session of text are still too little to ask', async () => {
    const messages = session(80, { shot: (i) => i % 26 === 0, said: (i) => `Step ${i}. ${'The notes are read and the files are listed. '.repeat(34)}` });
    const { asked } = await ownRun({ ...OWN, OMC_JEV_COMPACT_TARGET_PERCENT: '20' }, messages);
    expect(asked).toHaveLength(0);
  });

  it('with the cascade, screenshots that give back under a tenth of the window are too little to ask, though they are a large share of the list', async () => {
    // Three screenshots among 77 steps of short text results: about 7 000 tokens of a list of about 19 000 (the share passes), under the 20 000 tokens of a tenth of
    // the 200 000 window (the second bound of the own threshold does not).
    const messages = session(80, { shot: (i) => i <= 3, chars: 30 });
    const { asked } = await ownRun({ ...OWN, OMC_JEV_COMPACT_TARGET_PERCENT: '20' }, messages, { tokens: 190000 });
    expect(asked).toHaveLength(0);
  });
});

describe('cutInTokens and worthInTokens', () => {
  const candidate = (id, { images = 1, text = '', task = false } = {}) => ({
    id, resIdx: 2 * id, useIdx: 2 * id - 1, secret: false, textOnly: images === 0, task, score: 0, asked: false,
    use: { tool: 'Screenshot', input: { screen: id } }, res: { text, isError: false, result: Array.from({ length: images }, () => IMAGE) },
    resultChars: text.length, trace: `[compacted] Screenshot(screen=${id}) - non-text result (image or file) removed`,
  });

  it('counts what every result that is no pinned one gives back as a trace, and nothing when no candidate saves a token', () => {
    const rows = session(10);
    const two = cutInTokens([candidate(1), candidate(2, { images: 2 })], rows, undefined);
    expect(two.removable).toBeGreaterThan(3 * 2348 - 300);
    expect(two.removable).toBeLessThan(3 * 2348 + 100);
    expect(cutInTokens([], rows, undefined)).toEqual({ removable: 0, listed: 0 });
    // A pinned result (a task list) stays whole and is no part of what can be cut.
    expect(cutInTokens([candidate(1, { images: 0, text: 'x'.repeat(5000), task: true })], rows, undefined)).toEqual({ removable: 0, listed: 0 });
    expect(cutInTokens([candidate(1, { images: 0, text: 'x'.repeat(5000) })], rows, undefined).removable).toBeGreaterThan(2000);
  });

  it('takes the tokens of the envelopes off, and gives the list as the API form, or as the rows with their images', () => {
    const rows = session(10);
    const bare = cutInTokens([candidate(1)], rows, undefined);
    const wrapped = cutInTokens([candidate(1)], rows, undefined, 1000);
    expect(bare.removable - wrapped.removable).toBeCloseTo(363, 6);
    expect(bare.listed).toBeGreaterThan(10 * 2348);
    // The rows and the API form are one list (the API form joins two user rows into one message, so the figures differ by a few tokens only).
    expect(Math.abs(bare.listed - cutInTokens([candidate(1)], rows, apiOf(rows)).listed) / bare.listed).toBeLessThan(0.02);
  });

  it('adds the tokens that the text stages take off to what can be cut, also when no candidate saves a token, and never a negative amount', () => {
    const rows = session(10);
    const bare = cutInTokens([candidate(1)], rows, undefined);
    expect(cutInTokens([candidate(1)], rows, undefined, 0, undefined, 700).removable).toBeCloseTo(bare.removable + 700, 6);
    expect(cutInTokens([candidate(1)], rows, undefined, 0, undefined, -700)).toEqual(bare);
    const only = cutInTokens([], rows, undefined, 0, undefined, 700);
    expect(only.removable).toBe(700);
    expect(only.listed).toBe(bare.listed);
  });

  it('is worth it from MIN_REDUCTION of the list, and also from minGain tokens for the own threshold', () => {
    expect(worthInTokens({ removable: 300, listed: 1000 })).toBe(true);
    expect(worthInTokens({ removable: 299, listed: 1000 })).toBe(false);
    expect(worthInTokens({ removable: 900, listed: 1000 }, 901)).toBe(false);
    expect(worthInTokens({ removable: 900, listed: 1000 }, 900)).toBe(true);
    expect(worthInTokens({ removable: 0, listed: 0 })).toBe(false);
  });

  it('the list of the API form counts an image of a result at the image rate', () => {
    expect(listTokens(apiOf(session(3)))).toBeGreaterThan(3 * 2348);
  });

  // A standalone image block of a message (a screenshot the user attached) is a block like the others: the image rate and the overhead of a block, and the message
  // costs its constant once.
  const RATES = ratesFrom('{"RATE_IMAGE":1000,"RATE_BLOCK":50}');
  it('a standalone image block costs the image rate and the overhead of a block, as every other block of its message', () => {
    const images = (n) => Array.from({ length: n }, () => IMAGE);
    // 80 images in one message: 80 blocks of 1050 and the constant of the message (-40.5) once.
    expect(listTokens([{ role: 'user', content: images(80) }], RATES)).toBeCloseTo(80 * 1050 - 40.5, 6);
    // The same images beside a text and a call of the assistant: each block takes its overhead, the images no less than the others.
    const withText = listTokens([{ role: 'user', content: [{ type: 'text', text: 'Look at these.' }, ...images(3)] }], RATES) - listTokens([{ role: 'user', content: [{ type: 'text', text: 'Look at these.' }] }], RATES);
    expect(withText).toBeCloseTo(3 * 1050, 6);
    // The image inside a result is no block of the message: the result's own block holds it, at the image rate.
    const inResult = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [IMAGE] }] }];
    expect(listTokens(inResult, RATES)).toBeCloseTo(1000 + 50 - 40.5, 6);
  });

  it('the tokens before and the prediction of a compaction with no usage from the host count each standalone image at its rate and the overhead of its block', async () => {
    const env = { ...TARGET_20, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1', OMC_JEV_COMPACT_RATES: '{"RATE_IMAGE":1000,"RATE_BLOCK":50}' };
    const rows = session(30, { shot: () => false, chars: 600 });
    const run = async (n) => {
      const api = apiOf(rows);
      api[0].content.push(...Array.from({ length: n }, () => IMAGE));
      return (await compactRun(env, rows, { tokens: null, trigger: 'manual', api })).record;
    };
    const none = await run(0);
    const some = await run(20);
    expect(none).toMatchObject({ result: 'jev', tokens_source: 'estimate' });
    expect(some).toMatchObject({ result: 'jev', tokens_source: 'estimate' });
    // 20 more blocks in the first message: 20 images of 1000 and 20 blocks of 50, the same cut.
    for (const key of ['tokens_before', 'tokens_after_pred']) expect(some[key] - none[key], key).toBeGreaterThanOrEqual(20 * 1050 - 1);
    for (const key of ['tokens_before', 'tokens_after_pred']) expect(some[key] - none[key], key).toBeLessThanOrEqual(20 * 1050 + 1);
  });
});
