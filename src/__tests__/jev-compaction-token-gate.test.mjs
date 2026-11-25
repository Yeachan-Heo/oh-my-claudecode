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
