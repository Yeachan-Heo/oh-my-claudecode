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

function fakeDollar({ env, usage, messages, api, score = () => 0 }) {
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
        return { ok: true, status: 200, headers: {}, text: JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map((q) => [q, { type: 'score', score: score(body.state.results[q]?.result ?? ''), confidence: 0.9 }])) }) };
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

/** `batches` of `size` parallel `Bash(pwd)` calls that each answer `ok`: the text of a call with its result is shorter than the line of its trace. */
function pwdSession(batches, size) {
  const m = [{ role: 'user', text: 'Task: where are we?', toolUses: [] }];
  for (let b = 0; b < batches; b++) {
    const ids = Array.from({ length: size }, (_, k) => `p${b}-${k}`);
    m.push({ role: 'assistant', text: '', toolUses: ids.map((id) => ({ tool_use_id: id, tool: 'Bash', input: { command: 'pwd' } })) });
    m.push({ role: 'user', text: '', toolUses: [], toolResults: ids.map((id) => ({ tool_use_id: id, text: 'ok', isError: false })) });
  }
  m.push({ role: 'user', text: 'Good, now sum up the results.', toolUses: [] }, { role: 'assistant', text: 'Summary: done.', toolUses: [] });
  return m.map((x, k) => Object.freeze({ ...x, handle: `h${k}` }));
}

/** `n` steps that each update a task (a call of the task list and its result, which the cut never takes) and a last request with its answer. */
function taskSession(n) {
  const m = [{ role: 'user', text: 'Task: plan the work.', toolUses: [] }];
  for (let i = 1; i <= n; i++) {
    m.push({ role: 'assistant', text: `Step ${i}.`, toolUses: [{ tool_use_id: `t${i}`, tool: 'TaskUpdate', input: { taskId: String(i), status: 'completed' } }] });
    m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: `Updated task #${i}`, isError: false }] });
  }
  m.push({ role: 'user', text: 'Good, now sum up the results.', toolUses: [] }, { role: 'assistant', text: 'Summary: done.', toolUses: [] });
  return m.map((x, k) => Object.freeze({ ...x, handle: `h${k}` }));
}

// The compaction through register(on): the record, the scoring requests and what the host gets back. `form: false` leaves the API form out (the host answers rows);
// `api` is the API form the host answers instead of the one made from the rows; `tokens: null` is a host with no usage to give (the tokens before are estimated).
async function compactRun(env, messages, { tokens = 190000, trigger = 'auto', form = true, after, api, score } = {}) {
  const fake = fakeDollar({ env, usage: usageOf(tokens), messages, api: api ?? (form ? apiOf(messages, after) : undefined), score });
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
  // `reads`: the reads of the API form that the preflight made before it asked the host (the compaction it asks for reads it again).
  let reads = 0;
  let asking = false;
  const read = fake.$.session.messages;
  fake.$.session.messages = async (o) => { if (o?.as === 'api' && !asking) reads++; return read(o); };
  fake.$.session.compact = async () => {
    asking = true;
    const out = await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'plugin', messages }), async () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }));
    asked.push(out);
    return out;
  };
  await handlers['turn.complete'](fake.$, { isAborted: false }, async () => 'ok');
  return { asked, records: fake.records(), reads };
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

  it('the gate counts the deliveries that build carries as one block of a row of text results even when no result of the row is cut', async () => {
    // Every result of this session is a task update, which the cut never takes, so no result gives anything back. The 2 000 messages delivered after the result of
    // step 5 are 2 000 blocks of the host's list and one block of the row that build rewrites whatever is decided (about 91 000 tokens of overhead less the envelopes
    // it adds): that is the whole cut.
    const rows = taskSession(30);
    const after = { t5: Array.from({ length: 2000 }, (_, k) => note(k)) };
    const counted = Math.round(listTokens(apiOf(rows, after)));
    const plain = await compactRun(TARGET_20, rows, { tokens: Math.round(listTokens(apiOf(rows))), trigger: 'manual' });
    expect(plain.record).toMatchObject({ result: 'fallback', reason: 'too_few_results' });
    const run = await compactRun({ ...TARGET_20, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' }, rows, { tokens: counted, trigger: 'manual', after });
    expect(run.record).toMatchObject({ result: 'jev', queued_other: 2000 });
    const installed = listTokens(apiOf(run.out.messages));
    expect(run.record.max_reduction_tokens).toBeGreaterThanOrEqual(0.3);
    expect(1 - installed / counted).toBeGreaterThanOrEqual(0.3);
    // The prediction is the list that is installed, and the gate said what that list is: the cut it measured is the cut the compaction makes.
    expect(Math.abs(run.record.tokens_after_pred - installed)).toBeLessThanOrEqual(2);
    expect(Math.abs(run.record.max_reduction_tokens - (1 - installed / counted))).toBeLessThan(0.02);
  });

  it('a session that passes the character gate is decided as before in token mode: the token measure is not read', async () => {
    const messages = session(30, { shot: () => false, chars: 4000 });
    const { record } = await compactRun(TARGET_20, messages, { tokens: 130000 });
    expect(record.result).toBe('jev');
    expect(record.max_reduction).toBeGreaterThanOrEqual(0.3);
    expect(record).not.toHaveProperty('max_reduction_tokens');
  });

  it('a session whose results are tiny stays with the summary in token mode when its cut cannot bring the host\'s tokens under the threshold', async () => {
    // 30 results of about 10 characters: by the text alone nothing is worth a trace, but the blocks of their calls and results are (about 40 % of the list: the pinning
    // counts them), and the list is far smaller than the 130 000 tokens the host counts, so the floor stays above the threshold.
    const { record } = await compactRun(TARGET_20, session(30, { shot: () => false, chars: 0 }), { tokens: 130000 });
    expect(record).toMatchObject({ result: 'fallback', reason: 'floor_above_threshold' });
    expect(record.max_reduction_tokens).toBeGreaterThan(0.3);
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

  it('results that are shorter than their traces are not pinned when the blocks of their calls and results are what makes the cut: 30 batches of 25 `Bash(pwd)` answering `ok`', async () => {
    // The text of a call with its result is about 13 tokens and its trace about 33, so by the text alone every result would stay whole and the floor would be none
    // (`too_few_results`); the 45.4 tokens of the block of each call and of each result are what the compaction gives back (about 21 000 of the 75 000 tokens stay).
    const rows = pwdSession(30, 25);
    const counted = Math.round(listTokens(apiOf(rows)));
    const { record, out } = await compactRun(ENV, rows, { tokens: counted, trigger: 'manual' });
    expect(counted).toBeGreaterThan(70000);
    expect(record.result).toBe('jev');
    expect(record.max_reduction_tokens).toBeGreaterThan(0.5);
    expect(record).toMatchObject({ cut: 'cascade', candidates: 700 }); // 50 of the 750 results are in the tail
    expect(record.cascade_pass).not.toBe('forced');
    expect(record.traced).toBeGreaterThan(0);
    expect(record.tokens_after_pred).toBeLessThanOrEqual(record.cascade_target_tokens);
    // The list that is installed is what the prediction says, within a token for each trace.
    expect(Math.abs(record.tokens_after_pred - listTokens(apiOf(out.messages)))).toBeLessThanOrEqual(0.6 * record.traced + 2);
  });

  it('the preflight of the own threshold counts them too: its floor veto lets a session through when the overhead of the blocks is what makes the cut', async () => {
    // The 450 results of 50 characters with their calls are about 19 000 tokens of text, under the 30 % of 150 000 (45 000) that the veto asks; with the blocks of
    // their calls and results (and the messages of the results) they give back about 39 000 more.
    const small = parallelSession(20, 25, { chars: 36 });
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_AT_PERCENT: '60', OMC_JEV_COMPACT_TARGET_PERCENT: '20', OMC_JEV_COMPACT_OWN_THRESHOLD: 'active' };
    expect((await ownRun(env, small, { tokens: 150000 })).asked).toHaveLength(1);
  });
});

describe('the prediction is the list that is installed: the rows of the tail that build rebuilds and the zero floor of a message', () => {
  // 210 steps of a call and a result of `chars` characters; the conversation ends inside its tool loop (no answer after the last result), so the last call and its result
  // are the tail. The row of results of the tail is rebuilt from its text (all its results are text), and the `delivered` messages that came after it, which the host
  // holds as blocks of their own, become one block of that row. `block` is the RATE_BLOCK override (none: the default 45.4).
  async function runOf({ block, chars, delivered = 0 }) {
    const rows = session(210, { shot: () => false, chars }).slice(0, -2);
    const after = delivered ? { t210: Array.from({ length: delivered }, (_, k) => `The coordinator sent a message while you were working:\nn${k}`) } : undefined;
    const raw = block === undefined ? undefined : JSON.stringify({ RATE_BLOCK: block });
    const rates = ratesFrom(raw);
    const counted = Math.round(listTokens(apiOf(rows, after), rates));
    const env = { ...TARGET_20, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1', ...(raw ? { OMC_JEV_COMPACT_RATES: raw } : {}) };
    const { record, out } = await compactRun(env, rows, { tokens: counted, trigger: 'manual', after });
    return { record, out, counted, installed: listTokens(apiOf(out.messages), rates) };
  }
  // The prediction and the tokens after are the estimate of the list that is installed, within the line break before each trace that the prediction leaves out
  // (under a token for each). A cascade that stops at the first step that reaches its target leaves the prediction just under it.
  function expectInstalled({ record, counted, installed }, label) {
    expect(record.result, label).toBe('jev');
    const slack = 0.6 * record.traced + 2;
    expect(Math.abs(record.tokens_after_pred - installed), `${label} pred`).toBeLessThanOrEqual(slack);
    expect(Math.abs(record.tokens_after - installed), `${label} after`).toBeLessThanOrEqual(slack);
    if (record.cascade_pass === 'short_or_trace') {
      expect(record.tokens_after_pred, label).toBeLessThanOrEqual(record.cascade_target_tokens);
      expect(record.tokens_after_pred, label).toBeGreaterThan(record.cascade_target_tokens - 400);
      expect(1 - installed / counted, `${label} reduction of the installed list`).toBeGreaterThanOrEqual(0.3);
    }
  }

  it('the messages delivered after the last result of an open tool loop are one block of the row build rebuilds: the cascade does not trace more results for their blocks', async () => {
    // 200 deliveries are 200 blocks in the host's list and one block in the installed one (about 9 000 tokens of overhead). A prediction that kept them as 200 blocks
    // would start 9 000 tokens too high and trace results the target does not need.
    const run = await runOf({ chars: 600, delivered: 200 });
    expectInstalled(run, 'default rates');
    const tail = run.out.messages.at(-1);
    expect(tail.toolResults).toHaveLength(1);
    expect(tail.text).toContain('n199');
  });

  it('the zero floor is on the whole cost of a message, text and structure: with RATE_BLOCK 1 the plan does not give back more than rebuilding removes', async () => {
    // A message of one block adds 1 - 40.5 tokens to its text, and a result of 600 characters keeps that sum above zero, so the 39.5 tokens are taken off the message
    // as they stand; a structure cut at zero on its own leaves them in. 210 such results went 49 400 -> 33 800 in the prediction and 35 100 in the installed list.
    const run = await runOf({ block: 1, chars: 600 });
    expect(run.counted).toBeGreaterThan(49000);
    expectInstalled(run, 'RATE_BLOCK 1');
  });

  it('the same for results so short that a message costs nothing: the list that is left is what the plan says, not none', async () => {
    // 210 results of 120 characters, all traced (a manual compaction of a list under the target): the trace lines of an assistant message are about as many tokens as the
    // constant of its message takes off, so some of the messages that are left cost zero, and the others what their text and their block cost.
    const run = await runOf({ block: 1, chars: 120 });
    expect(run.record.cascade_pass).toBe('manual');
    expect(run.installed).toBeGreaterThan(250);
    expectInstalled(run, 'RATE_BLOCK 1, short results');
  });

  const CASES = [
    { chars: 120, label: 'short results' },
    { chars: 600, label: 'results of 600 characters' },
    { chars: 600, delivered: 200, label: 'results of 600 characters, 200 deliveries after the last' },
  ];
  for (const block of [undefined, 1, 20, 40, 45.4]) {
    for (const c of CASES) {
      it(`the prediction is the installed list with RATE_BLOCK ${block ?? 'at its default'}: ${c.label}`, async () => {
        expectInstalled(await runOf({ block, chars: c.chars, delivered: c.delivered }), `${block} ${c.label}`);
      });
    }
  }
});

describe('the zero floor of a message holds the deliveries it carries: a block delivered during the tool turn is text of the message', () => {
  // 200 steps of a text result of 600 characters, with `per` messages of a coordinator after the result of every `every`th step (the API form only: no row shows them), at a block
  // rate of 10 (under the 40.5 that the constant of a message takes off, so a message that holds little text costs nothing), and four results that Jev scores needed, the others low.
  // The host counts the list plus a prefix (the system prompt and the tools) that leaves the list with only the low-scored results traced `left` tokens under the target of 34 000.
  const NEEDED = ['RESULT-20 ', 'RESULT-60 ', 'RESULT-100 ', 'RESULT-140 '];
  const score = (text) => (NEEDED.some((k) => text.startsWith(k)) ? 3 : 0);
  async function layout({ every = 0, per = 1, left = 500, raw = '{"RATE_BLOCK":10}' }) {
    const rows = session(200, { shot: () => false, chars: 600 });
    const after = {};
    if (every) for (let i = every; i <= 200; i += every) after[`t${i}`] = Array.from({ length: per }, (_, k) => `The coordinator sent a message while you were working:\nn${i}-${k}`);
    const rates = ratesFrom(raw);
    const env = { ...TARGET_20, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1', ...(raw ? { OMC_JEV_COMPACT_RATES: raw } : {}) };
    // The list with only the low-scored results traced (a compaction of a list at or under the target is decided by the scores alone).
    const low = listTokens(apiOf((await compactRun(env, rows, { tokens: 1000, trigger: 'manual', after, score })).out.messages), rates);
    const counted = Math.round(listTokens(apiOf(rows, after), rates) + 34000 - left - low);
    const prefix = counted - Math.round(listTokens(apiOf(rows, after), rates));
    // The same plan at a target high enough for the scores to decide: the estimate of the monitor for the list that keeps the four results whole.
    const plan = (await compactRun({ ...env, OMC_JEV_COMPACT_TARGET_PERCENT: '80' }, rows, { tokens: counted, trigger: 'manual', after, score })).record;
    const run = await compactRun(env, rows, { tokens: counted, trigger: 'manual', after, score });
    return { plan, run, byList: low + prefix, installed: listTokens(apiOf(run.out.messages), rates) + prefix };
  }
  // The layouts are read once: the plan and the cascade of a layout are two tests.
  const laid = new Map();
  const read = (c) => { if (!laid.has(c)) laid.set(c, layout(c)); return laid.get(c); };
  const wholeOf = (out) => out.messages.flatMap((m) => m.toolResults || []).filter((r) => NEEDED.some((k) => r.text.startsWith(k)) && r.text.endsWith('x'.repeat(600))).length;
  // The monitor's estimate of the plan, and the cascade's: the list that is installed is what listTokens counts, within the line break before each trace that the prediction leaves out.
  const planIsInstalled = async (c) => {
    const { plan, byList } = await read(c);
    expect(plan).toMatchObject({ cascade_pass: 'manual', traced: 194 });
    expect(Math.abs(plan.tokens_after_pred - byList), `monitor ${plan.tokens_after_pred}, listTokens ${byList}`).toBeLessThanOrEqual(0.6 * plan.traced + 2);
  };
  const needsStayWhole = async (c) => {
    const { run, installed } = await read(c);
    expect(run.record).toMatchObject({ result: 'jev', cascade_pass: 'short_or_trace', kept_short: 0 });
    expect(wholeOf(run.out)).toBe(4);
    expect(run.record.tokens_after_pred).toBeLessThanOrEqual(run.record.cascade_target_tokens);
    expect(Math.abs(run.record.tokens_after_pred - installed), `monitor ${run.record.tokens_after_pred}, listTokens ${installed}`).toBeLessThanOrEqual(0.6 * run.record.traced + 2);
  };
  const CASES = [
    { label: 'a message after every result', every: 1, left: 500 },
    { label: 'a message after every tenth result', every: 10, left: 300 },
    { label: 'three messages after every tenth result (one block of the row that build writes)', every: 10, per: 3, left: 300 },
  ];
  // The list that tracing only the low-scored results leaves is under the target (33 500 or 33 700 of 34 000), so no result scored needed is shortened or traced for tokens
  // that the list does not hold.
  for (const c of CASES) {
    it(`the plan that traces the low-scored results is the list that is installed: ${c.label}`, () => planIsInstalled(c));
    it(`the cascade keeps the four needed results whole: ${c.label}`, () => needsStayWhole(c));
  }

  // The same layouts where the floor of a message is not in play (a block of 45.4 leaves every message above zero) or nothing is delivered: decided as before.
  for (const [label, c] of [['the default block rate', { every: 1, left: 500, raw: null }], ['no delivery at the low block rate', { left: 500 }]]) {
    it(`unchanged, the plan: ${label}`, () => planIsInstalled(c));
    it(`unchanged, the cascade: ${label}`, () => needsStayWhole(c));
  }
});

describe('the text beside a result: the words of the user that no result stands beside any more', () => {
  // listTokens counts a text beside a result at the rate of a reminder (0.363 a character) and the words of the user alone at their own (0.287). The last result of a
  // message that goes takes that difference with it for the words that stay (a message the user typed during the tool turn, a row of its own that the host joins
  // to the message of the result, or the text of the row of the result), so the prediction counts it, as the installed list does.
  const ENV = { ...TARGET_20, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' };
  const WORDS = 100000;
  const typed = (k) => ({ role: 'user', text: `Typed during the tool turn ${k}: ${'w'.repeat(WORDS)}`, toolUses: [], handle: `u${k}` });
  // 30 steps of text results, the result of step 10 with the words after it (`how`: a row of its own, the text of its row, or two rows of their own).
  const withWords = (how) => {
    const rows = session(30, { shot: () => false, chars: 4000 });
    const at = rows.findIndex((m) => (m.toolResults || []).some((r) => r.tool_use_id === 't10'));
    if (how === 'own row') return Object.freeze(rows.map((m, k) => (k === at ? Object.freeze({ ...m, text: typed(1).text }) : m)));
    return Object.freeze([...rows.slice(0, at + 1), ...(how === 'two rows' ? [typed(1), typed(2)] : [typed(1)]), ...rows.slice(at + 1)]);
  };
  const cases = [['a row of its own after the result row', 'row'], ['the text of the row of the result', 'own row'], ['two rows of their own after the result row', 'two rows']];

  for (const [label, how] of cases) {
    it(`the prediction is the installed list when the result of the message goes: ${label}`, async () => {
      const rows = withWords(how);
      const counted = Math.round(listTokens(apiOf(rows)));
      const { record, out } = await compactRun(ENV, rows, { tokens: counted, trigger: 'manual' });
      expect(record.result).toBe('jev');
      const installed = listTokens(apiOf(out.messages));
      // The result of step 10 is traced and the words stay in a message of their own, at the rate of the user's words: 0.076 a character less than they were.
      const slack = 0.6 * record.traced + 2;
      expect(Math.abs(record.tokens_after_pred - installed), `pred ${record.tokens_after_pred}, installed ${installed}`).toBeLessThanOrEqual(slack);
      expect(Math.abs(record.tokens_after - installed), `after ${record.tokens_after}, installed ${installed}`).toBeLessThanOrEqual(slack);
    });

    it(`the cascade keeps the results it needs for the tokens that the words give back when the result of the message is traced: ${label}`, async () => {
      // 110 000 tokens and a target of 106 462: the trace of the result of step 10 (the only one that Jev scores low) gives back about 2 000 tokens, short of the 3 538 that
      // the cut needs, and the words that stay beside no result give back about 7 600 more. Counted at the rate of a text beside a result, they leave the cut short,
      // and results scored needed would be shortened for tokens that the installed list does not hold.
      const rows = withWords(how);
      const { record, out } = await compactRun({ ...ENV, OMC_JEV_COMPACT_TARGET_PERCENT: '64' }, rows, { tokens: 110000, trigger: 'manual', score: (text) => (text.startsWith('RESULT-10 ') ? 0 : 3) });
      expect(record).toMatchObject({ result: 'jev', cascade_pass: 'short_or_trace', kept_short: 0, traced: 1 });
      expect(record.tokens_after_pred).toBeLessThanOrEqual(record.cascade_target_tokens);
      expect(out.messages.filter((m) => (m.text || '').includes('[compacted]'))).toHaveLength(1);
    });
  }
});

describe('the words beside a result that stays: the drop of the calls between two user messages joins them', () => {
  // The calls of an assistant message that are all dropped leave it empty, and the host joins the user rows on both sides of it. The words typed during the tool turn then
  // stand beside the result that stays in the earlier row (a task result is never cut): at the rate of a text beside a result in the installed list, so the prediction gives
  // them the discount of the words alone only when no result is left in the joined message.
  const ENV = { ...TARGET_20, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1', OMC_JEV_COMPACT_HOST_HANDOFF: '1' };
  const WORDS = 110000;
  // A task row, a first step (a task call, which is never cut, or a read when `pin` is false), `steps` reads of 4000 characters and an answer; the words after the result of
  // read `at`, in the row of the result. The last three steps are in the last six messages and out of the cut. `said` is the assistant's text before the call of read `at`.
  function fixture({ steps, at, pin = true, said = '' }) {
    const m = [{ role: 'user', text: 'Task: plan and read the notes.', toolUses: [] }];
    const step = (id, tool, input, text, result, words = '') => {
      m.push({ role: 'assistant', text, toolUses: [{ tool_use_id: id, tool, input }] });
      m.push({ role: 'user', text: words, toolUses: [], toolResults: [{ tool_use_id: id, text: result, isError: false }] });
    };
    if (pin) step('tp', 'TaskCreate', { subject: 'plan' }, '', 'Task #1 created');
    else step('tp', 'Bash', { command: 'cat plan.txt' }, '', `RESULT-0 ${'x'.repeat(4000)}`);
    for (let i = 1; i <= steps; i++) step(`d${i}`, 'Bash', { command: `cat notes-${i}.txt` }, i === at ? said : '', `RESULT-${i} ${'x'.repeat(4000)}`, i === at ? `Typed during the tool turn: ${'w'.repeat(WORDS)}` : '');
    m.push({ role: 'assistant', text: 'Summary: done.', toolUses: [] });
    return Object.freeze(m.map((x, k) => Object.freeze({ ...x, handle: `h${k}` })));
  }
  // The result that stays and the words are one message of the list that is installed.
  const sameMessage = (messages, id) => apiOf(messages).some((a) => a.content.some((b) => b.type === 'tool_result' && b.tool_use_id === id) && a.content.some((b) => b.type === 'text' && b.text.startsWith('Typed during the tool turn')));

  it('the tokens the host is told are the list that is installed: the words stay beside the result that stays, with every read dropped', async () => {
    const rows = fixture({ steps: 20, at: 10 });
    const counted = Math.round(listTokens(apiOf(rows)));
    const { record, out } = await compactRun(ENV, rows, { tokens: counted, trigger: 'manual' });
    expect(record).toMatchObject({ result: 'jev', cascade_pass: 'drop' });
    expect(sameMessage(out.messages, 'tp')).toBe(true);
    const installed = listTokens(apiOf(out.messages));
    // The words stay at 0.363 a character: at the rate of the user's words (0.287) the prediction would be 8 400 tokens under the list that is installed.
    const slack = 0.6 * record.traced + 2;
    expect(Math.abs(record.tokens_after_pred - installed), `pred ${record.tokens_after_pred}, installed ${installed}`).toBeLessThanOrEqual(slack);
    expect(Math.abs(out.tokensAfter - installed), `told ${out.tokensAfter}, installed ${installed}`).toBeLessThanOrEqual(slack);
  });

  it('a cut that the installed list does not make is not taken for one that reaches the minimum of the host: 62 000 tokens go to about 45 500, not 37 100', async () => {
    const rows = fixture({ steps: 12, at: 6 });
    const counted = Math.round(listTokens(apiOf(rows)));
    expect(counted).toBeGreaterThan(61000);
    const { record, out } = await compactRun(ENV, rows, { tokens: counted, trigger: 'manual' });
    // The cut is 26.6 percent of the list; with the words at the rate of the user's it looked like 40.1 percent, over the 30 percent that the host asks for.
    expect(record).toMatchObject({ result: 'fallback', reason: 'cut_below_host_min' });
    expect(out.messages).toEqual([{ role: 'user', text: 'SUMMARY', toolUses: [] }]);
  });

  it('with the earlier result dropped too no result stays in the joined message: the words are given back their discount, and the prediction is the installed list', async () => {
    const rows = fixture({ steps: 20, at: 10, pin: false });
    const counted = Math.round(listTokens(apiOf(rows)));
    const { record, out } = await compactRun(ENV, rows, { tokens: counted, trigger: 'manual' });
    expect(record).toMatchObject({ result: 'jev', cascade_pass: 'drop' });
    expect(sameMessage(out.messages, 'tp')).toBe(false);
    const installed = listTokens(apiOf(out.messages));
    const slack = 0.6 * record.traced + 2;
    expect(Math.abs(record.tokens_after_pred - installed), `pred ${record.tokens_after_pred}, installed ${installed}`).toBeLessThanOrEqual(slack);
    expect(Math.abs(out.tokensAfter - installed), `told ${out.tokensAfter}, installed ${installed}`).toBeLessThanOrEqual(slack);
  });

  it('a call row that has text stays in the list and the rows are not joined: the words are given back their discount, and the prediction is the installed list', async () => {
    const rows = fixture({ steps: 20, at: 10, said: 'Reading the notes.' });
    const counted = Math.round(listTokens(apiOf(rows)));
    const { record, out } = await compactRun(ENV, rows, { tokens: counted, trigger: 'manual' });
    expect(record).toMatchObject({ result: 'jev', cascade_pass: 'drop' });
    expect(sameMessage(out.messages, 'tp')).toBe(false);
    const installed = listTokens(apiOf(out.messages));
    const slack = 0.6 * record.traced + 2;
    expect(Math.abs(record.tokens_after_pred - installed), `pred ${record.tokens_after_pred}, installed ${installed}`).toBeLessThanOrEqual(slack);
    expect(Math.abs(out.tokensAfter - installed), `told ${out.tokensAfter}, installed ${installed}`).toBeLessThanOrEqual(slack);
  });
});

describe('the words of a row that held no result, joined to a message that keeps one: the host counts them beside it', () => {
  // build drops a row of thinking alone (no text, no call), and the host joins the user rows on both sides of it. The words typed during the tool turn, which stood at the rate of
  // the user's words (0.287 a character) in a message of their own, then stand beside the result that stays (a task result is never cut) at the rate of a text beside a result
  // (0.363): the list that is installed holds them for more than the list before did, and the prediction has to count it before the cascade decides.
  const ENV = { ...TARGET_20, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1', OMC_JEV_COMPACT_HOST_HANDOFF: '1' };
  // A task row, a first step (a task call, which is never cut, or a read when `pin` is false), the words of the user (after a row of thinking alone, or in the row of the first
  // result), 48 reads of `chars` characters and an answer. The last three steps are in the last six messages and out of the cut.
  function fixture({ chars, words, pin = true, where = 'after thinking' }) {
    const typed = `Typed during the tool turn: ${'w'.repeat(words)}`;
    const m = [{ role: 'user', text: 'Task: plan and read the notes.', toolUses: [] }];
    const step = (id, tool, input, result, text = '') => {
      m.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] });
      m.push({ role: 'user', text, toolUses: [], toolResults: [{ tool_use_id: id, text: result, isError: false }] });
    };
    const inRow = where === 'in the row' ? typed : '';
    if (pin) step('tp', 'TaskCreate', { subject: 'plan' }, 'Task #1 created', inRow);
    else step('tp', 'Bash', { command: 'cat plan.txt' }, `RESULT-0 ${'x'.repeat(chars)}`, inRow);
    if (where === 'after thinking') m.push({ role: 'assistant', text: '', toolUses: [] }, { role: 'user', text: typed, toolUses: [] });
    for (let i = 1; i <= 48; i++) step(`d${i}`, 'Bash', { command: `cat notes-${i}.txt` }, `RESULT-${i} ${'x'.repeat(chars)}`);
    m.push({ role: 'assistant', text: 'Summary: done.', toolUses: [] });
    return Object.freeze(m.map((x, k) => Object.freeze({ ...x, handle: `h${k}` })));
  }
  // The host's API form keeps the block of thinking of a row that has nothing else; listTokens counts its overhead.
  const formOf = (rows) => apiOf(rows).map((a) => (a.role === 'assistant' && !a.content.length ? { ...a, content: [{ type: 'thinking', thinking: 'Considering the next step.' }] } : a));
  const sameMessage = (messages, id) => apiOf(messages).some((a) => a.content.some((b) => b.type === 'tool_result' && b.tool_use_id === id) && a.content.some((b) => b.type === 'text' && b.text.startsWith('Typed during the tool turn')));
  const run = async (opts) => {
    const rows = fixture(opts);
    const api = formOf(rows);
    const counted = Math.round(listTokens(api));
    const { record, out } = await compactRun(ENV, rows, { tokens: counted, trigger: 'manual', api });
    return { rows, counted, record, out };
  };

  it('the tokens the host is told are the list that is installed: the words stay beside the result of the task', async () => {
    const { record, out } = await run({ chars: 2500, words: 60000 });
    expect(record.result).toBe('jev');
    expect(sameMessage(out.messages, 'tp')).toBe(true);
    expect(out.messages.some((m) => m.role === 'assistant' && !m.text && !(m.toolUses || []).length)).toBe(false);
    const installed = listTokens(apiOf(out.messages));
    // The 60 000 characters are 4 560 tokens more beside the result than alone: the prediction that left them out was that much under the list.
    const slack = 0.6 * record.traced + 2;
    expect(Math.abs(record.tokens_after_pred - installed), `pred ${record.tokens_after_pred}, installed ${installed}`).toBeLessThanOrEqual(slack);
    expect(Math.abs(out.tokensAfter - installed), `told ${out.tokensAfter}, installed ${installed}`).toBeLessThanOrEqual(slack);
  });

  it('a cut that the installed list does not make is not taken for one that reaches the minimum of the host: 64 900 tokens go to about 49 000, not 39 100', async () => {
    const { counted, record, out } = await run({ chars: 1200, words: 130000 });
    expect(counted).toBeGreaterThan(64000);
    // Taking every result that can go gives the list 24.5 percent less; with the words at the rate of the user's it looked like 38 percent, over the 30 percent that the
    // gate asks for, and the handoff went ahead.
    expect(record).toMatchObject({ result: 'fallback', reason: 'too_few_results' });
    expect(out.messages).toEqual([{ role: 'user', text: 'SUMMARY', toolUses: [] }]);
  });

  it('the words in the row of the result were beside it already: the prediction is the installed list as before', async () => {
    const { record, out } = await run({ chars: 2500, words: 60000, where: 'in the row' });
    expect(record.result).toBe('jev');
    expect(sameMessage(out.messages, 'tp')).toBe(true);
    const installed = listTokens(apiOf(out.messages));
    const slack = 0.6 * record.traced + 2;
    expect(Math.abs(record.tokens_after_pred - installed), `pred ${record.tokens_after_pred}, installed ${installed}`).toBeLessThanOrEqual(slack);
    expect(Math.abs(out.tokensAfter - installed), `told ${out.tokensAfter}, installed ${installed}`).toBeLessThanOrEqual(slack);
  });

  it('the first result is cut too: no result stays in the joined message, the words keep their own rate, and the prediction is the installed list', async () => {
    const { record, out } = await run({ chars: 2500, words: 60000, pin: false });
    expect(record.result).toBe('jev');
    expect(sameMessage(out.messages, 'tp')).toBe(false);
    const installed = listTokens(apiOf(out.messages));
    const slack = 0.6 * record.traced + 2;
    expect(Math.abs(record.tokens_after_pred - installed), `pred ${record.tokens_after_pred}, installed ${installed}`).toBeLessThanOrEqual(slack);
    expect(Math.abs(out.tokensAfter - installed), `told ${out.tokensAfter}, installed ${installed}`).toBeLessThanOrEqual(slack);
  });
});

describe('a notification traced with the deliveries of a coordinator: the trace line does not make the text that stays the words of the user', () => {
  // listTokens counts a text that is not the user's at the rate of a reminder (0.363 a character) and the words of the user alone at their own (0.287). A row that
  // opens with the trace of the module is not the user's writing, so the deliveries of the coordinator that the trace row carries stay at the rate they had.
  const ENV = { ...TARGET_20, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1', OMC_JEV_COMPACT_NOTIFICATIONS: '1', OMC_JEV_COMPACT_TARGET_PERCENT: '64' };
  const DELIVERIES = 20;
  const EACH = 3550;
  const note = { role: 'user', text: `[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n<task-notification>\n<task-id>b2</task-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n<result>NOTE-REPORT ${'n'.repeat(4000)}</result>\n</task-notification>`, toolUses: [] };
  const score = (text) => (text.includes('NOTE-REPORT') || text.startsWith('RESULT-10 ') ? 0 : 3);
  // 30 steps of text results; the notification row stands right after the first row, in a message that holds no result, or right after the row of the result of step 10,
  // which Jev scores low as it does the notification. The deliveries of the coordinator are blocks of the API form only, after the notification.
  const fixture = (where) => {
    const steps = session(30, { shot: () => false, chars: 4000 });
    const at = steps.findIndex((m) => (m.toolResults || []).some((r) => r.tool_use_id === 't10'));
    const rows = where === 'no result' ? [steps[0], note, ...steps.slice(1)] : [...steps.slice(0, at + 1), note, ...steps.slice(at + 1)];
    const frozen = Object.freeze(rows.map((m, k) => Object.freeze({ ...m, handle: `h${k}` })));
    const api = apiOf(frozen);
    const target = api.find((a) => a.role === 'user' && a.content.some((b) => b.type === 'text' && b.text.includes('<task-notification>')));
    for (let k = 0; k < DELIVERIES; k++) target.content.push({ type: 'text', text: `The coordinator sent a message while you were working:\nCOORD-${k} ${'c'.repeat(EACH)}` });
    return { rows: frozen, api };
  };

  for (const [label, where] of [['in a message that holds no result', 'no result'], ['in the message of a result that goes too', 'with a result']]) {
    it(`the prediction is the installed list: ${label}`, async () => {
      const { rows, api } = fixture(where);
      const { record, out } = await compactRun(ENV, rows, { tokens: Math.round(listTokens(api)), trigger: 'manual', api, score });
      expect(record).toMatchObject({ result: 'jev', notifications: 1 });
      const carried = out.messages.find((m) => (m.text || '').startsWith('[compacted] background task notification'));
      expect(carried.text).toContain(`COORD-${DELIVERIES - 1} `);
      const installed = listTokens(apiOf(out.messages));
      // The text of the coordinator stays at 0.363 a character: 71 000 characters at the rate of the user's words would be 5 396 tokens less than the prediction.
      const slack = 0.6 * record.traced + 2;
      expect(Math.abs(record.tokens_after_pred - installed), `pred ${record.tokens_after_pred}, installed ${installed}`).toBeLessThanOrEqual(slack);
      expect(Math.abs(record.tokens_after - installed), `after ${record.tokens_after}, installed ${installed}`).toBeLessThanOrEqual(slack);
    });
  }

  it('a trace row of an earlier compaction with the deliveries it carried, beside a result that goes: they cost the same before and after, so the cascade cuts as without them', async () => {
    // The row of the trace is no notification any more and stands in the message of the result of step 10, which Jev scores low. The coordinator's text beside it is a delivered
    // message at 0.363 a character whether the result is there or not; counted as the user's words once the result is gone, it would give 5 396 tokens back that it does not.
    const envelope = (k) => `<system-reminder id="jev-${k + 1}">\nThe coordinator sent a message while you were working:\nCOORD-${k} ${'c'.repeat(EACH)}\n</system-reminder id="jev-${k + 1}">`;
    const run = async (deliveries) => {
      const steps = session(30, { shot: () => false, chars: 4000 });
      const at = steps.findIndex((m) => (m.toolResults || []).some((r) => r.tool_use_id === 't10'));
      const trace = { role: 'user', text: `[compacted] background task notification (Agent "x" finished) - 4000 chars removed\n${Array.from({ length: deliveries }, (_, k) => envelope(k)).join('\n')}`.trim(), toolUses: [] };
      const rows = Object.freeze([...steps.slice(0, at + 1), trace, ...steps.slice(at + 1)].map((m, k) => Object.freeze({ ...m, handle: `h${k}` })));
      const res = await compactRun(ENV, rows, { tokens: 110000, trigger: 'manual', score: (text) => (text.startsWith('RESULT-10 ') ? 0 : 3) });
      return { ...res, saved: listTokens(apiOf(rows)) - listTokens(apiOf(res.out.messages)) };
    };
    const without = await run(0);
    const withDeliveries = await run(DELIVERIES);
    // Without the deliveries the trace of the result of step 10 gives back too little for the target of 106 462, and results scored needed are shortened.
    expect(without.record).toMatchObject({ result: 'jev', cascade_pass: 'short_or_trace', traced: 1 });
    expect(without.record.kept_short).toBeGreaterThan(0);
    expect(withDeliveries.record).toMatchObject({ result: 'jev', cascade_pass: 'short_or_trace', traced: 1, kept_short: without.record.kept_short });
    expect(Math.abs(withDeliveries.record.tokens_after_pred - without.record.tokens_after_pred)).toBeLessThanOrEqual(1);
    // The prediction takes off what the installed list loses.
    expect(Math.abs(110000 - withDeliveries.record.tokens_after_pred - withDeliveries.saved)).toBeLessThanOrEqual(0.6 * withDeliveries.record.traced + 2 + 0.6 * withDeliveries.record.kept_short);
  });
});

describe('a notification that anchors a message of the user and the deliveries of a coordinator: the one block that replaces it is the words of the user', () => {
  // build writes a notification that is replaced (a trace, a short copy or nothing) and the blocks delivered after it as one text block. listTokens counts that block at the
  // rate of the words of the user (0.287 a character) when a message of the user is in it, the deliveries of a coordinator and the envelopes build adds included; apart, as
  // the host holds them, they are at the rate of a reminder (0.363). The prediction takes the difference of the whole block, not only that of the message of the user.
  const ENV = { ...TARGET_20, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1', OMC_JEV_COMPACT_NOTIFICATIONS: '1', OMC_JEV_COMPACT_TARGET_PERCENT: '64' };
  const EACH = 3550;
  const note = { role: 'user', text: `[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n<task-notification>\n<task-id>bk7x2mq9</task-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n<result>NOTE-REPORT ${'n'.repeat(4000)}</result>\n</task-notification>`, toolUses: [] };
  const framed = (words) => `The user sent a new message while you were working:\n${words}\n\nThis is how Claude Code surfaces messages the user sends mid-turn \u2014 within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.`;
  // 30 steps of text results; the notification row stands right after the first row (a message that holds no result) or right after the row of the result of step 10. The
  // deliveries are blocks of the API form after the notification: `users` messages of the user (300 characters), then `coords` of a coordinator.
  // With `known` the task of the notification was started by a call that stands in the conversation, so the notification is scored by Jev; without it the source is unknown and the
  // notification is held (never sent, a trace).
  const launch = [
    { role: 'assistant', text: 'Starting the task.', toolUses: [{ tool_use_id: 'bg1', tool: 'Bash', input: { command: 'sleep 1', run_in_background: true } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'bg1', text: 'Command running in background with ID: bk7x2mq9. Output is being written to: /tmp/tasks/bk7x2mq9.output', isError: false }] },
    { role: 'assistant', text: 'Waiting.', toolUses: [] },
  ];
  const fixture = (where, { users, coords, userChars, known }) => {
    const steps = session(30, { shot: () => false, chars: 4000 });
    const at = steps.findIndex((m) => (m.toolResults || []).some((r) => r.tool_use_id === 't10'));
    const start = known ? [steps[0], ...launch] : [steps[0]];
    const rows = where === 'no result' ? [...start, note, ...steps.slice(1)] : [...start, ...steps.slice(1, at + 1), note, ...steps.slice(at + 1)];
    const frozen = Object.freeze(rows.map((m, k) => Object.freeze({ ...m, handle: `h${k}` })));
    const api = apiOf(frozen);
    const target = api.find((a) => a.role === 'user' && a.content.some((b) => b.type === 'text' && b.text.includes('<task-notification>')));
    for (let k = 0; k < users; k++) target.content.push({ type: 'text', text: framed(`USER-${k} ${'u'.repeat(userChars)}`) });
    for (let k = 0; k < coords; k++) target.content.push({ type: 'text', text: `The coordinator sent a message while you were working:\nCOORD-${k} ${'c'.repeat(EACH)}` });
    return { rows: frozen, api };
  };
  // Jev scores the report of the notification `noteScore` (under 0.5 it goes to a trace, above it to a short copy), the result of step 10 low when the notification stands in
  // its message, and every other result needed.
  const run = async (where, { users = 1, coords = 20, noteScore = 0, userChars = 300, known = false } = {}) => {
    const { rows, api } = fixture(where, { users, coords, userChars, known });
    const score = (text) => (text.includes('NOTE-REPORT') ? noteScore : where === 'with a result' && text.startsWith('RESULT-10 ') ? 0 : 3);
    const res = await compactRun(ENV, rows, { tokens: 110000, trigger: 'manual', api, score });
    // The results that stay whole in the installed list (a short copy or a trace is not one).
    const whole = res.out.messages.flatMap((m) => m.toolResults || []).filter((r) => (r.text || '').endsWith('x'.repeat(4000))).length;
    // What the installed list loses against the list before, and what the prediction takes off the host's count.
    const lost = listTokens(api) - listTokens(apiOf(res.out.messages));
    // What stands in place of the notification: its trace, its short copy, or nothing.
    const copy = res.out.messages.some((m) => (m.text || '').includes('notification shortened at compaction')) ? 'short' : res.out.messages.some((m) => (m.text || '').startsWith('[compacted] background task notification')) ? 'trace' : 'none';
    return { ...res, whole, lost, copy, predicted: 110000 - res.record.tokens_after_pred };
  };

  for (const [label, where, noteScore, kind, known] of [['a trace in a message that holds no result', 'no result', 0, 'trace', false], ['a short copy of a notification of a known task in a message that holds no result', 'no result', 3, 'short', true], ['a trace in the message of a result that goes too', 'with a result', 0, 'trace', false]]) {
    it(`one message of the user and twenty of a coordinator, ${label}: the prediction is what the installed list loses, and no result scored needed is cut for the difference`, async () => {
      const { record, whole, lost, copy, predicted } = await run(where, { noteScore, known });
      expect(record).toMatchObject({ result: 'jev', notifications: 1 });
      expect(copy).toBe(kind);
      // The words of the user make the block theirs: 71 000 characters of the coordinator at 0.287 instead of 0.363 are 5 396 tokens the list loses on top of the notification.
      expect(lost).toBeGreaterThan(5000);
      // The notification alone reaches the target of 106 462, so no result scored needed is cut (the results of 30 steps, less the one of step 10 that goes with the notification).
      expect(whole).toBe(where === 'no result' ? 30 : 29);
      expect(Math.abs(predicted - lost), `predicted ${predicted}, lost ${lost}`).toBeLessThanOrEqual(0.6 * (record.traced + record.kept_short) + 2);
    });
  }

  it('a notification that stays whole in the message of a result that goes: the message of the user in its deliveries stands in a message of no result any more', async () => {
    // The report is scored needed and stays; the result of step 10 goes. The 5 000 characters of the user are counted at 0.287 instead of 0.363 once no result stands beside them.
    const { record, lost, predicted } = await run('with a result', { coords: 0, noteScore: 3, userChars: 5000 });
    expect(record).toMatchObject({ result: 'jev', notifications: 1 });
    expect(lost).toBeGreaterThan(400);
    expect(Math.abs(predicted - lost), `predicted ${predicted}, lost ${lost}`).toBeLessThanOrEqual(0.6 * (record.traced + record.kept_short) + 2);
  });

  it('a message of the user alone after the notification: the envelope build adds is counted at the rate of the words of the user too', async () => {
    const { record, lost, predicted } = await run('no result', { coords: 0 });
    expect(record).toMatchObject({ result: 'jev', notifications: 1 });
    expect(Math.abs(predicted - lost), `predicted ${predicted}, lost ${lost}`).toBeLessThanOrEqual(0.6 * (record.traced + record.kept_short) + 2);
  });

  it('the deliveries of a coordinator alone stay at the rate of a reminder: nothing to take off for them', async () => {
    const { record, lost, predicted } = await run('no result', { users: 0 });
    expect(record).toMatchObject({ result: 'jev', notifications: 1 });
    expect(Math.abs(predicted - lost), `predicted ${predicted}, lost ${lost}`).toBeLessThanOrEqual(0.6 * (record.traced + record.kept_short) + 2);
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

describe('the preflight of the own threshold with the token cascade: the vetoes on tokens come after the read of the API form', () => {
  // The messages delivered during a tool turn stand in the API form only. With the cascade a row's deliveries become one block of the row that build writes, which takes
  // their blocks off the list: the more of them, the larger the cut, so a veto that counts tokens from the rows alone (no delivery known) can turn away a session that
  // the compaction would cut by more than a third. 30 steps of text results of `chars` characters, the usage 160 000 tokens of the window of 200 000, and 1 000
  // deliveries after the result of step 10 (about 45 000 tokens of blocks, less the envelopes they get).
  const OWN = { ...ACTIVE_ENV, OMC_JEV_COMPACT_AT_PERCENT: '60', OMC_JEV_COMPACT_TARGET_PERCENT: '20' };
  const deliveries = { t10: Array.from({ length: 1000 }, (_, k) => `The coordinator sent a message while you were working:\nn${k}`) };
  const text = (chars) => session(30, { shot: () => false, chars });
  const run = (env, chars, after) => ownRun(env, text(chars), { tokens: 160000, after });

  it('the floor veto counts the deliveries: a session whose floor cuts under 30 % of the rows alone is asked for when the deliveries bring it over', async () => {
    const env = { ...OWN, OMC_JEV_COMPACT_OWN_THRESHOLD: 'active' };
    expect((await run(env, 2500)).asked).toHaveLength(0);
    expect((await run(env, 2500, deliveries)).asked).toHaveLength(1);
  });

  it('the gate on tokens counts the deliveries before it leaves a session alone: a session too small by its rows is asked for when the deliveries make the cut', async () => {
    expect((await run(OWN, 1500)).asked).toHaveLength(0);
    const delivered = await run(OWN, 1500, deliveries);
    expect(delivered.asked).toHaveLength(1);
    expect(delivered.records.find((r) => r.event === 'compact')).toMatchObject({ result: 'jev', queued_other: 1000 });
  });

  it('with the cascade a session too small to ask for is left alone after one read of the API form, and without it after none', async () => {
    // The read is the price of counting the deliveries; without the cascade they can only make the characters worse, so the characters leave the session alone before it.
    const small = await run(OWN, 600);
    expect(small.asked).toHaveLength(0);
    expect(small.reads).toBe(1);
    const without = await run({ ...ACTIVE_ENV, OMC_JEV_COMPACT_AT_PERCENT: '60' }, 600, deliveries);
    expect(without.asked).toHaveLength(0);
    expect(without.reads).toBe(0);
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

describe('the thinking of the assistant rows that build rebuilds comes off the prediction: the host counts it and no list that is installed holds it', () => {
  // A character of thinking (its text or its signature) is 0.2575 tokens in the host's count (RATE_SIG); listTokens counts none, and build rebuilds every assistant row before the
  // tail without its thinking. So the tokens after are the tokens before less the thinking of those rows, and a list estimate (a host with no usage to give) adds the thinking of
  // all rows. `think`: a thinking block of 300 characters of text and 300 of signature first in every assistant message of the API form.
  const RATE_SIG = 0.2575;
  const PER_MESSAGE = 600;
  const BLOCK = { type: 'thinking', thinking: 't'.repeat(300), signature: 's'.repeat(300) };
  const withThinking = (api) => api.map((a) => (a.role === 'assistant' ? { ...a, content: [BLOCK, ...a.content] } : a));
  const messagesIn = (api) => api.filter((a) => a.role === 'assistant').length;
  const ENV = { ...TARGET_20, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' };
  // A target of 80 % puts the host's count under the target of a list of 100 steps: a manual compaction, where only the scores decide (here every result is traced).
  const MANUAL = { ...ENV, OMC_JEV_COMPACT_TARGET_PERCENT: '80' };
  // The rows: `steps` steps of a text result of 600 characters; `open` ends inside the tool loop (the last call and its result are the tail, whose rows keep their handles and
  // their thinking), else after an answer (every assistant row is rebuilt, the answer too). The host's count is the list as rows plus the thinking characters of every assistant
  // message, whether or not the API form shows them. `rebuiltChars`: the thinking characters of the rows that build rebuilds.
  async function run({ open = false, think = true, host = 'usage', env = ENV, steps = 210 } = {}) {
    const rows = session(steps, { shot: () => false, chars: 600 }).slice(0, open ? -2 : undefined);
    const plain = apiOf(rows);
    const api = think ? withThinking(plain) : plain;
    const counted = Math.round(listTokens(plain) + RATE_SIG * PER_MESSAGE * messagesIn(plain));
    const out = await compactRun(env, rows, { tokens: host === 'usage' ? counted : null, trigger: 'manual', api });
    return { ...out, plain, api, counted, rebuiltChars: PER_MESSAGE * (messagesIn(plain) - (open ? 1 : 0)), installed: listTokens(apiOf(out.out.messages)) };
  }

  it('the floor is lower by the thinking of the rows that are rebuilt, for the same count of the host', async () => {
    for (const open of [false, true]) {
      const [without, withIt] = [await run({ open, think: false }), await run({ open, think: true })];
      expect(without.record.floor_pred, `open ${open}`).toBeGreaterThan(0);
      expect(withIt.record.floor_pred, `open ${open}`).toBeGreaterThan(0);
      expect(Math.abs(without.record.floor_pred - withIt.record.floor_pred - RATE_SIG * withIt.rebuiltChars), `open ${open}`).toBeLessThanOrEqual(1);
    }
  });

  it('the prediction of a plan decided by the scores alone is lower by the same thinking', async () => {
    for (const open of [false, true]) {
      const [without, withIt] = [await run({ open, think: false, env: MANUAL, steps: 100 }), await run({ open, think: true, env: MANUAL, steps: 100 })];
      expect(withIt.record.cascade_pass, `open ${open}`).toBe('manual');
      expect(without.record.traced, `open ${open}`).toBe(withIt.record.traced);
      for (const key of ['tokens_after_pred', 'tokens_after']) expect(Math.abs(without.record[key] - withIt.record[key] - RATE_SIG * withIt.rebuiltChars), `open ${open} ${key}`).toBeLessThanOrEqual(1);
    }
  });

  it('the cascade stops at its target and the list that is installed is what it predicted, the thinking left out', async () => {
    for (const open of [false, true]) {
      const { record, installed } = await run({ open });
      // The tail keeps its thinking in the host's list, which no estimate of rows holds.
      const kept = RATE_SIG * PER_MESSAGE * (open ? 1 : 0);
      expect(record, `open ${open}`).toMatchObject({ result: 'jev', cascade_pass: 'short_or_trace' });
      expect(record.tokens_after_pred, `open ${open}`).toBeLessThanOrEqual(record.cascade_target_tokens);
      expect(record.tokens_after_pred, `open ${open}`).toBeGreaterThan(record.cascade_target_tokens - 400);
      expect(Math.abs(record.tokens_after_pred - installed - kept), `open ${open} pred`).toBeLessThanOrEqual(0.6 * record.traced + 2);
      expect(Math.abs(record.tokens_after - installed - kept), `open ${open} after`).toBeLessThanOrEqual(0.6 * record.traced + 2);
    }
  });

  it('a host with no usage to give: the estimate adds the thinking of every message, and the prediction takes off that of the rows that are rebuilt', async () => {
    for (const open of [false, true]) {
      const [without, withIt] = [await run({ open, think: false, host: 'estimate', env: MANUAL, steps: 100 }), await run({ open, think: true, host: 'estimate', env: MANUAL, steps: 100 })];
      expect(withIt.record, `open ${open}`).toMatchObject({ result: 'jev', tokens_source: 'estimate', cascade_pass: 'manual' });
      // What the list of the API form with the blocks of thinking counts beyond the list without them (their overhead: listTokens counts a block, not what is in it).
      const blocks = listTokens(withIt.api) - listTokens(withIt.plain);
      const chars = PER_MESSAGE * messagesIn(withIt.plain);
      expect(Math.abs(withIt.record.tokens_before - without.record.tokens_before - blocks - RATE_SIG * chars), `open ${open} before`).toBeLessThanOrEqual(1);
      // After the rebuild the thinking of the tail is all that is left of it.
      for (const key of ['tokens_after_pred', 'tokens_after']) {
        expect(Math.abs(withIt.record[key] - without.record[key] - blocks - RATE_SIG * (chars - withIt.rebuiltChars)), `open ${open} ${key}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('the record says how much thinking the API form holds and how much of it sits on a row', async () => {
    const { record, plain } = await run({ open: true });
    expect(record).toMatchObject({ api_messages: true, sig_chars_total: PER_MESSAGE * messagesIn(plain), sig_chars_mapped: PER_MESSAGE * messagesIn(plain) });
    // The assistant rows that build rebuilt (all but the last message of an open loop): the same number under both names.
    expect(record).toMatchObject({ rebuilt_assistant: messagesIn(plain) - 1, rebuilt_thinking: messagesIn(plain) - 1 });
    const between = await run({ open: false });
    expect(between.record).toMatchObject({ rebuilt_assistant: messagesIn(between.plain), rebuilt_thinking: messagesIn(between.plain) });
  });

  it('thinking that sits on no row is counted in the total and not taken off: a row of thinking alone, redacted thinking, a message of text only', async () => {
    const rows = session(60, { shot: () => false, chars: 600 });
    // A row of thinking alone after step 3 (no text, no call): its API message holds the thinking block and nothing else.
    rows.splice(7, 0, Object.freeze({ role: 'assistant', text: '', toolUses: [], handle: 'thinking-alone' }));
    const thinkingOf = (n, m) => ({ type: 'thinking', thinking: 't'.repeat(n), signature: 's'.repeat(m) });
    const build = () => apiOf(rows).map((a, k) => {
      if (a.role !== 'assistant') return a;
      if (!a.content.length) return { ...a, content: [thinkingOf(100, 50)] }; // the row of thinking alone: 150 characters, on no row
      if (k === 1) return { ...a, content: [{ type: 'redacted_thinking', data: 'd'.repeat(70) }, ...a.content] }; // step 1: 70, on the row of its call
      if (k === 3) return { ...a, content: [thinkingOf(10, 20), ...a.content] }; // step 2: 30, on the row of its call
      if (a.content.every((b) => b.type === 'text')) return { ...a, content: [thinkingOf(5, 5), ...a.content] }; // the answer, of text only: 10, on the row whose text it is
      return a;
    });
    const plain = apiOf(rows);
    const counted = Math.round(listTokens(plain) + RATE_SIG * 260);
    const go = async (api) => (await compactRun(MANUAL, rows, { tokens: counted, trigger: 'manual', api })).record;
    const withIt = await go(build());
    expect(withIt).toMatchObject({ result: 'jev', api_messages: true, sig_chars_total: 260, sig_chars_mapped: 110 });
    // The prediction takes off the 110 characters on rows, not the 260 in the list.
    const without = await go(plain);
    expect(without).toMatchObject({ result: 'jev', api_messages: true, sig_chars_total: 0, sig_chars_mapped: 0 });
    expect(Math.abs(without.tokens_after_pred - withIt.tokens_after_pred - RATE_SIG * 110)).toBeLessThanOrEqual(1);
  });

  it('with no thinking in the API form nothing is taken off: the prediction is the list that is installed, as before', async () => {
    for (const open of [false, true]) {
      const rows = session(210, { shot: () => false, chars: 600 }).slice(0, open ? -2 : undefined);
      const counted = Math.round(listTokens(apiOf(rows)));
      const { record, out } = await compactRun(ENV, rows, { tokens: counted, trigger: 'manual' });
      expect(record, `open ${open}`).toMatchObject({ result: 'jev', cascade_pass: 'short_or_trace' });
      expect(Math.abs(record.tokens_after_pred - listTokens(apiOf(out.messages))), `open ${open}`).toBeLessThanOrEqual(0.6 * record.traced + 2);
    }
  });

  it('with no API form (the host answers rows, between turns) the thinking is unknown: nothing is added or taken off', async () => {
    const rows = session(210, { shot: () => false, chars: 600 });
    const counted = Math.round(listTokens(apiOf(rows)));
    const { record, out } = await compactRun(ENV, rows, { tokens: counted, trigger: 'manual', form: false });
    expect(record).toMatchObject({ result: 'jev', cascade_pass: 'short_or_trace' });
    expect(Math.abs(record.tokens_after_pred - listTokens(apiOf(out.messages)))).toBeLessThanOrEqual(0.6 * record.traced + 2);
  });

  it('the fields of the thinking come with the token accounting alone, and not on the default path', async () => {
    const rows = session(60, { shot: () => false, chars: 600 });
    const api = withThinking(apiOf(rows));
    const fields = ['api_messages', 'sig_chars_total', 'sig_chars_mapped', 'rebuilt_thinking'];
    const plain = (await compactRun(ACTIVE_ENV, rows, { tokens: 40000, trigger: 'manual', api })).record;
    expect(plain.result).toBe('jev');
    for (const key of fields) expect(plain, key).not.toHaveProperty(key);
    const accounted = (await compactRun({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' }, rows, { tokens: 40000, trigger: 'manual', api })).record;
    expect(accounted).toMatchObject({ result: 'jev', api_messages: true, sig_chars_total: PER_MESSAGE * 61, sig_chars_mapped: PER_MESSAGE * 61 });
    expect(accounted.rebuilt_thinking).toBe(accounted.rebuilt_assistant);
    expect(accounted.rebuilt_thinking).toBeGreaterThan(0);
  });

  it('with no API form the record says so, and the host with no usage estimates the list from rows without any thinking', async () => {
    const rows = session(210, { shot: () => false, chars: 600 });
    const { record } = await compactRun(ENV, rows, { tokens: null, trigger: 'manual', form: false });
    expect(record).toMatchObject({ result: 'jev', tokens_source: 'estimate', api_messages: false, sig_chars_total: 0, sig_chars_mapped: 0 });
  });
});

describe('the class of the words that stay is taken inside the zero floor of their message: a message that costs nothing gives back nothing for its words', () => {
  // `steps` steps of a text result of 400 characters, with words the user typed during the tool turn (`words` characters) in the row of each result, at a block rate of 10 (under the
  // 40.5 that the constant of a message takes off). Once the result of a row is traced, the words stay alone in a message of one block, and at the rate of the words of the user (0.287 a
  // character, where beside a result it is 0.363) 90 characters cost less than the 30.5 that block takes off: the message costs nothing before the change of class and after it, so the
  // change gives back nothing. The host counts the list plus a prefix (the system prompt and the tools); a handoff to its summary needs a cut of 30 percent.
  const ENV = { ...TARGET_20, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1', OMC_JEV_COMPACT_HOST_HANDOFF: '1' };
  const MIN_CUT = 0.3;
  async function layout({ steps = 240, words = 90, raw = '{"RATE_BLOCK":10}', prefix = 1000 }) {
    const rows = session(steps, { shot: () => false, chars: 400 }).map((m) => ((m.toolResults || []).length && words ? Object.freeze({ ...m, text: `Typed during the tool turn ${m.toolResults[0].tool_use_id}: `.padEnd(words, 'w') }) : m));
    const rates = ratesFrom(raw);
    const counted = Math.round(listTokens(apiOf(rows), rates)) + prefix;
    const { record, out } = await compactRun({ ...ENV, ...(raw ? { OMC_JEV_COMPACT_RATES: raw } : {}) }, rows, { tokens: counted, trigger: 'manual' });
    return { record, out, counted, installed: listTokens(apiOf(out.messages), rates) + prefix };
  }
  // The monitor's prediction and the tokens the host is told are the list that is installed, within the line break before each trace that the prediction leaves out.
  function agrees({ record, out, installed }, label) {
    expect(record, label).toMatchObject({ result: 'jev', cascade_pass: 'short_or_trace' });
    const slack = 0.6 * record.traced + 2;
    expect(Math.abs(record.tokens_after_pred - installed), `${label}: monitor ${record.tokens_after_pred}, listTokens ${installed}`).toBeLessThanOrEqual(slack);
    expect(Math.abs(out.tokensAfter - installed), `${label}: told ${out.tokensAfter}, listTokens ${installed}`).toBeLessThanOrEqual(slack);
  }

  it('the cascade stops when the installed list is under its target, and the cut that the host asks for is made: 48 600 tokens go to 33 900 and the list is 34 000, not 34 300', async () => {
    const run = await layout({});
    expect(run.counted).toBeGreaterThan(48000);
    expect(run.counted).toBeLessThan(49000);
    agrees(run, 'RATE_BLOCK 10');
    const slack = 0.6 * run.record.traced + 2;
    expect(run.record.tokens_after_pred).toBeLessThanOrEqual(run.record.cascade_target_tokens);
    expect(run.installed).toBeLessThanOrEqual(run.record.cascade_target_tokens + slack);
    // The words that cost nothing gave back 0.076 a character each, 400 tokens in all: the prediction said a cut of 30.2 percent (33 900) and the list that was installed was cut by 29.4 (34 300),
    // under the 30 that the host asks for.
    expect(1 - run.installed / run.counted).toBeGreaterThanOrEqual(MIN_CUT);
  });

  for (const [words, prefix] of [[40, 6000], [90, 3000], [90, 6000], [100, 4000]]) {
    it(`the prediction is the installed list: words of ${words} characters, a prefix of ${prefix} tokens`, async () => {
      agrees(await layout({ words, prefix }), `words ${words}, prefix ${prefix}`);
    });
  }

  // The floor is not in play, or the words are above it: the prediction is the list that is installed as it was.
  for (const [label, c] of [['the default block rate', { raw: null, prefix: 3000 }], ['words of 110 characters (the message costs something after the change of class)', { words: 110, prefix: 3000 }], ['words of 430 characters', { words: 430, prefix: 3000 }], ['no words (nothing changes class)', { words: 0, steps: 480, prefix: 3000 }]]) {
    it(`unchanged: ${label}`, async () => {
      agrees(await layout(c), label);
    });
  }
});
