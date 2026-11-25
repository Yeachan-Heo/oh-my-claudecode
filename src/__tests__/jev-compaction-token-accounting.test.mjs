/* global setTimeout, clearTimeout */
/**
 * Tests for the token accounting of hooks/jev-compaction.mjs (OMC_JEV_COMPACT_TOKEN_ACCOUNTING=1):
 * the compaction window resolver, the window ceiling, the prefix and the token estimate by class.
 * Units are called directly through their named exports; the end-to-end cases drive register(on) with
 * a fake `$`, the way the host does. No network: the transport stub answers the scoring request.
 */

import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentTrace, listTokens, pasteTrace, prefixTokens, ratesFrom, register, replyTrace, resolveWindow, tokenCeiling } from '../../hooks/jev-compaction.mjs';

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

// A fake `$` with in-memory files. `files` is the initial content of the host files the module may read;
// a missing path throws ENOENT, as $.fs.read does.
function fakeDollar({ env = ACTIVE_ENV, files = {}, usage } = {}) {
  const store = new Map(Object.entries(files));
  const calls = { compact: 0 };
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
        return { ok: true, status: 200, headers: {}, text: JSON.stringify(scoreByMarker(body)) };
      },
    },
    clock: {
      after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; },
      sleep: async () => { throw new Error('the module must not use $.clock.sleep'); },
    },
    session: {
      id: async () => 'sess-token',
      usage: async (opts) => (usage ? usage(opts) : { context: { tokens: 1000, window: 200000 } }),
      messages: async () => [],
      compact: async () => { calls.compact++; return {}; },
    },
    ui: { log: () => {}, toast: () => {} },
  };
  const records = () => [...store.entries()].filter(([p]) => p.startsWith(SPOOL)).map(([, t]) => JSON.parse(t));
  return { $, calls, store, records };
}

/** A first user message, `n` call/result pairs, a last request and an answer; `chars` per result. */
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

const HOST = { context: { tokens: 130000, window: 200000, breakdown: { rawMaxTokens: 200000, autoCompactThreshold: 167000, autocompactSource: 'settings' } } };
const usageOf = (opts) => (opts?.breakdown ? HOST : { context: { tokens: 130000, window: 200000 } });

// Runs the compaction through register(on) and returns the compaction record written to the spool.
async function compactRecord(env, { messages = conversation(30), usage = usageOf } = {}) {
  const fake = fakeDollar({ env, usage });
  fake.$.session.messages = async () => messages;
  const handlers = {};
  register((event, hook) => { handlers[event] = hook; });
  const next = async () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] });
  await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages }), next);
  const [record] = fake.records();
  return { record, fake };
}

describe('token accounting: window resolver', () => {
  const model = { context: { window: 200000 } };

  it('takes the host breakdown first: rawMaxTokens is the window, autoCompactThreshold the threshold', async () => {
    const detail = { context: { breakdown: { rawMaxTokens: 180000, autoCompactThreshold: 150000, autocompactSource: 'settings' } } };
    expect(await resolveWindow({}, {}, detail, model)).toEqual({ window: 180000, threshold: 150000, source: 'host:settings' });
  });

  it('without an autoCompactThreshold the threshold is the window less HOST_BUFFER (33 000)', async () => {
    const detail = { context: { breakdown: { rawMaxTokens: 180000 } } };
    expect(await resolveWindow({}, {}, detail, model)).toEqual({ window: 180000, threshold: 147000, source: 'host:unknown' });
  });

  it('takes CLAUDE_CODE_AUTO_COMPACT_WINDOW first and caps it at the model window', async () => {
    expect(await resolveWindow({}, { autoCompactWindow: '150000' }, undefined, model)).toEqual({ window: 150000, threshold: 117000, source: 'env' });
    expect(await resolveWindow({}, { autoCompactWindow: '300000' }, undefined, model)).toEqual({ window: 200000, threshold: 167000, source: 'env' });
  });

  it('reads autoCompactWindow of settings.json under CLAUDE_CONFIG_DIR, then under the home', async () => {
    const $ = fakeDollar({ files: { '/cfg/settings.json': '{"autoCompactWindow": 120000}', '/home/u/.claude/settings.json': '{"autoCompactWindow": 90000}' } }).$;
    expect(await resolveWindow($, { configDir: '/cfg', home: '/home/u' }, undefined, model)).toEqual({ window: 120000, threshold: 87000, source: 'settings' });
    expect(await resolveWindow($, { home: '/home/u' }, undefined, model)).toEqual({ window: 90000, threshold: 57000, source: 'settings' });
  });

  it('falls back to the model window when settings.json is missing, unreadable or without the key', async () => {
    const $ = fakeDollar({ files: { '/home/u/.claude/settings.json': '{not json' } }).$;
    expect(await resolveWindow($, { home: '/home/u' }, undefined, model)).toEqual({ window: 200000, threshold: 167000, source: 'model' });
    expect(await resolveWindow(fakeDollar().$, { home: '/home/u' }, undefined, model)).toEqual({ window: 200000, threshold: 167000, source: 'model' });
    const other = fakeDollar({ files: { '/home/u/.claude/settings.json': '{"model":"x"}' } }).$;
    expect(await resolveWindow(other, { home: '/home/u' }, undefined, model)).toEqual({ window: 200000, threshold: 167000, source: 'model' });
  });

  it('gives no window when nothing is known', async () => {
    expect(await resolveWindow(fakeDollar().$, {}, undefined, undefined)).toBeUndefined();
  });
});

describe('token accounting: window ceiling', () => {
  it('is absent without OMC_JEV_COMPACT_MAX_WINDOW_TOKENS', () => {
    expect(tokenCeiling(undefined)).toBeUndefined();
  });

  it('divides the limit by 1 + PREDICTION_SHORTFALL (0.012)', () => {
    expect(tokenCeiling(120000)).toBe(118577);
    expect(tokenCeiling(96463)).toBe(95319);
  });
});

describe('token accounting: prefix and estimate', () => {
  it('counts the used rows but the messages row as the prefix', () => {
    const detail = { context: { breakdown: { categories: [
      { name: 'System prompt', kind: 'used', tokens: 1000 },
      { name: 'Tools', kind: 'used', tokens: 500 },
      { name: 'Messages', kind: 'used', tokens: 5000 },
      { name: 'Free space', kind: 'free', tokens: 9000 },
    ] } } };
    expect(prefixTokens(detail)).toBe(1500);
  });

  it('has no prefix without a messages row (it would count the messages twice)', () => {
    expect(prefixTokens({ context: { breakdown: { categories: [{ name: 'System prompt', kind: 'used', tokens: 1000 }] } } })).toBe(0);
    expect(prefixTokens(undefined)).toBe(0);
  });

  it('prices the user words, the assistant text, results and traces by their class', () => {
    const block = 45.4 - 40.5; // one block in a one-block message
    expect(listTokens([{ role: 'user', content: 'hello' }])).toBeCloseTo(0.287 * 5 + block, 6);
    expect(listTokens([{ role: 'assistant', content: 'abc' }])).toBeCloseTo(0.315 * 3 + block, 6);
    expect(listTokens([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'xy' }] }])).toBeCloseTo(0.4502 * 2 + block, 6);
  });

  it('prices a session summary, a Caveat notice and an interruption notice at the note rate, as the rest of the module does not read them as the user\'s words', () => {
    const block = 45.4 - 40.5;
    const body = 'x'.repeat(10000);
    const notices = [
      'This session is being continued from a previous conversation that ran out of context. ',
      'Caveat: The messages below were generated by the user while running local commands. ',
      '[Request interrupted by user for tool use] ',
      'Base directory for this skill: /skills/x\n',
      '<system-reminder>\n',
    ];
    for (const lead of notices) {
      const text = `${lead}${body}`;
      expect(listTokens([{ role: 'user', content: [{ type: 'text', text }] }]), lead).toBeCloseTo(0.363 * text.length + block, 6);
    }
    const typed = `Please review the files. ${body}`;
    expect(listTokens([{ role: 'user', content: [{ type: 'text', text: typed }] }])).toBeCloseTo(0.287 * typed.length + block, 6);
  });

  it('prices a reminder beside a result at the note rate, and a trace line at the trace rate', () => {
    const block = 45.4 - 40.5;
    const trace = '\n[compacted] Bash({"command":"ls"}) - result of 10 chars removed';
    expect(listTokens([{ role: 'assistant', content: `Hi${trace}` }])).toBeCloseTo(0.58 * trace.length + 0.315 * 2 + block, 6);
    // A user message with a text and a result: the text is a reminder beside a result (RATE_NOTE), each of the two blocks costs its share of the message.
    expect(listTokens([{ role: 'user', content: [{ type: 'text', text: 'note' }, { type: 'tool_result', tool_use_id: 't1', content: '' }] }]))
      .toBeCloseTo(0.363 * 4 + 2 * (45.4 - 40.5 / 2), 6);
  });

  it('prices the text that stays in a row beside a trace of the module by whose it is: the trace line does not make it the user\'s words', () => {
    const block = 45.4 - 40.5;
    const coordinator = `<system-reminder id="jev-1">\nThe coordinator sent a message while you were working:\n${'c'.repeat(5000)}\n</system-reminder id="jev-1">`;
    const traces = [
      '[compacted] background task notification (Agent "x" finished) - 900 chars removed',
      '[agent message moved at compaction, not from the user: /spool/a.txt (900 chars, 900 bytes); from lead]',
      '[reply moved at compaction: 900 chars, full text in /spool/b.txt; start: "a"; end: "b"]',
    ];
    for (const trace of traces) {
      // The trace line at the trace rate; the delivered text of someone else after it at the rate of a reminder, as it was before the trace stood in front of it.
      const text = `${trace}\n${coordinator}`;
      expect(listTokens([{ role: 'user', content: [{ type: 'text', text }] }]), trace).toBeCloseTo(0.58 * trace.length + 0.363 * (1 + coordinator.length) + block, 6);
      // The words of the user after a trace line stay their own.
      const words = `${trace}\nPlease review the files.`;
      expect(listTokens([{ role: 'user', content: [{ type: 'text', text: words }] }]), trace).toBeCloseTo(0.58 * trace.length + 0.287 * (1 + 'Please review the files.'.length) + block, 6);
    }
  });

  it('adds RATE_NON_ASCII for each non-ASCII character', () => {
    const block = 45.4 - 40.5;
    expect(listTokens([{ role: 'user', content: 'é' }])).toBeCloseTo(0.287 * 1 + 3.72 + block, 6);
  });
});

describe('token accounting: every trace the module writes is priced at the trace rate when the list is counted again', () => {
  // A later estimate (a subagent, or no usage of the host) counts the text a compaction left, so the trace of each stage must cost RATE_TRACE a character
  // there, as it did when the stage took it off the prediction (RATE_MOVED * moved characters less RATE_TRACE * trace characters).
  const block = 45.4 - 40.5; // one block in a one-block message
  const rates = ratesFrom(undefined);
  const text = (role, value) => [{ role, content: [{ type: 'text', text: value }] }];
  const compacted = '[compacted] Bash({"command":"ls"}) - result of 10 chars removed';
  const note = '[compacted] a background task notification (the build finished) - 900 chars removed';
  const paste = pasteTrace(5000, `${'p'.repeat(300)}\n"quoted" [bracket] ${'q'.repeat(300)}`, '/home/u/.omc/state/jev/compaction-pastes/s/abc.txt');
  const reply = replyTrace(900, `${'r'.repeat(500)}\nsecond [line] "quote"`, '/home/u/.omc/state/jev/compaction-pastes/s/def.txt');
  const agent = agentTrace('/home/u/.omc/state/jev/compaction-pastes/s/ghi.txt', `<teammate-message teammate_id="worker-1" summary="the report">${'w'.repeat(900)}</teammate-message>`);
  const FORMATS = [['a removed result', compacted], ['a removed notification', note], ['pasted text', paste], ['a reply', reply], ['an agent message', agent]];

  it.each(FORMATS)('%s: the trace alone costs RATE_TRACE a character, in a user row and in an assistant text', (_name, trace) => {
    for (const role of ['user', 'assistant']) expect(listTokens(text(role, trace)), role).toBeCloseTo(0.58 * trace.length + block, 6);
    // The configured rate prices it the same way.
    expect(listTokens(text('user', trace), ratesFrom('{"RATE_TRACE":2}'))).toBeCloseTo(2 * trace.length + block, 6);
    expect(listTokens(text('user', trace), ratesFrom('{"RATE_TRACE":2,"RATE_OWN":9,"RATE_NOTE":9,"RATE_ATXT":9}'))).toBeCloseTo(2 * trace.length + block, 6);
  });

  it('a trace of a line stands apart from the words around it: the line break before it is part of the trace, the words keep their class', () => {
    for (const [, trace] of [FORMATS[0], FORMATS[3], FORMATS[4]]) {
      const assistant = `Intro line\n${trace}\nOutro line`;
      expect(listTokens(text('assistant', assistant))).toBeCloseTo(0.58 * (1 + trace.length) + 0.315 * 'Intro line\nOutro line'.length + block, 6);
      const twice = `Intro\n${trace}\n${trace}\nOutro`;
      expect(listTokens(text('assistant', twice))).toBeCloseTo(0.58 * 2 * (1 + trace.length) + 0.315 * 'Intro\nOutro'.length + block, 6);
    }
  });

  it('a trace of pasted text inside the user\'s words is priced at the trace rate, the words on both sides at the user rate, also with two traces on one line', () => {
    const one = `Please read this: ${paste} and tell me what you think.`;
    expect(listTokens(text('user', one))).toBeCloseTo(0.58 * paste.length + 0.287 * (one.length - paste.length) + block, 6);
    const two = `first ${paste} between ${paste} last`;
    expect(listTokens(text('user', two))).toBeCloseTo(0.58 * 2 * paste.length + 0.287 * (two.length - 2 * paste.length) + block, 6);
    // Beside a tool result the remaining words are reminder-class text, the trace is a trace all the same.
    const beside = [{ role: 'user', content: [{ type: 'text', text: one }, { type: 'tool_result', tool_use_id: 't1', content: 'xy' }] }];
    expect(listTokens(beside)).toBeCloseTo(0.58 * paste.length + 0.363 * (one.length - paste.length) + 0.4502 * 2 + 2 * (45.4 - 40.5 / 2), 6);
    // Words only, and a trace that stands in a quoted tag's place before the words.
    expect(listTokens(text('user', `${paste}\n${one}`))).toBeCloseTo(0.58 * 2 * paste.length + 0.287 * (one.length - paste.length + 1) + block, 6);
  });

  it('a mark that does not open a whole trace is the user\'s text and costs the user rate', () => {
    for (const partial of [`[pasted text moved at compaction: 5 chars, full text in /x; start: "abc`, `[pasted text moved at compaction: nothing here]`, `[reply moved at compaction in the middle of a line`]) {
      const words = `I typed ${partial} myself`;
      expect(listTokens(text('user', words)), partial).toBeCloseTo(0.287 * words.length + block, 6);
    }
  });

  it('lists every format of trace the module writes: a source with a new one fails here until the estimate prices it', () => {
    const source = readFileSync(join(fileURLToPath(import.meta.url), '..', '..', '..', 'hooks', 'jev-compaction.mjs'), 'utf8');
    const moved = new Set([...source.matchAll(/'\[([a-z ]+) moved at compaction/g)].map((m) => m[1]));
    expect([...moved].sort()).toEqual(['agent message', 'pasted text', 'reply']);
    expect(source.match(/`\[compacted\] /g)?.length).toBeGreaterThan(0);
    for (const trace of [paste, reply, agent]) expect(trace).toMatch(/^\[(?:pasted text|reply|agent message) moved at compaction/);
  });

  it('the cost of a trace when counted again is the cost the stage took off, whatever the rates', () => {
    for (const raw of [undefined, '{"RATE_TRACE":1.5,"RATE_OWN":0.1,"RATE_NOTE":0.1,"RATE_ATXT":0.1}']) {
      const r = ratesFrom(raw);
      for (const [name, trace] of FORMATS) expect(listTokens(text('user', trace), r) - (r.RATE_BLOCK - 40.5), name).toBeCloseTo(r.RATE_TRACE * trace.length, 6);
    }
    expect(rates.RATE_TRACE).toBe(0.58);
  });
});

describe('token accounting: no estimate goes below zero', () => {
  // The per-message term of the estimate is negative (RATE_MESSAGE), so a low RATE_BLOCK override would make a short message cost less than nothing.
  const LOW_BLOCK = ['{"RATE_BLOCK":0.001}', '{"RATE_BLOCK":1}', '{"RATE_BLOCK":20}', '{"RATE_BLOCK":40.4}'];
  const shortMessages = [
    { role: 'user', content: '' },
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: '' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'X', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '' }] },
    { role: 'user', content: [{ type: 'text', text: 'note' }, { type: 'tool_result', tool_use_id: 't1', content: 'xy' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'one' }, { type: 'tool_use', id: 't2', name: 'Y', input: { a: 1 } }] },
  ];

  it('a message costs zero, never less, with any positive RATE_BLOCK', () => {
    for (const raw of LOW_BLOCK) {
      const rates = ratesFrom(raw);
      for (const m of shortMessages) expect(listTokens([m], rates), `${raw} ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(0);
      expect(listTokens([{ role: 'user', content: [{ type: 'text', text: '' }] }], rates), raw).toBe(0);
      expect(listTokens(Array.from({ length: 300 }, (_, k) => shortMessages[k % shortMessages.length]), rates), raw).toBeGreaterThanOrEqual(0);
    }
  });

  it('a message that stays above zero keeps its estimate, and so does one at the default rates', () => {
    const rates = ratesFrom('{"RATE_BLOCK":1}');
    const long = 'y'.repeat(1000);
    expect(listTokens([{ role: 'user', content: long }], rates)).toBeCloseTo(0.287 * 1000 + 1 - 40.5, 6);
    expect(listTokens([{ role: 'user', content: [{ type: 'text', text: long }, { type: 'tool_result', tool_use_id: 't1', content: long }] }], rates))
      .toBeCloseTo(0.363 * 1000 + 0.4502 * 1000 + 2 * 1 - 40.5, 6);
    // One negative message does not take tokens off its neighbours.
    expect(listTokens([{ role: 'user', content: '' }, { role: 'user', content: long }], rates)).toBeCloseTo(0.287 * 1000 + 1 - 40.5, 6);
    for (const m of shortMessages) expect(listTokens([m])).toBeGreaterThan(0);
  });

  it('the estimate of a subagent (no usage of the host) is not negative with a low RATE_BLOCK, and neither is any prediction in the record', async () => {
    const messages = conversation(30, 200);
    for (const raw of LOW_BLOCK) {
      for (const target of [{}, { OMC_JEV_COMPACT_TARGET_PERCENT: '20' }]) {
        const fake = fakeDollar({ env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1', OMC_JEV_COMPACT_RATES: raw, ...target }, usage: usageOf });
        fake.$.session.messages = async () => messages;
        const handlers = {};
        register((event, hook) => { handlers[event] = hook; });
        await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', agentId: 'agent-1', messages }), async () => ({ messages: [] }));
        const [record] = fake.records();
        const numbers = ['tokens_before', 'tokens_after', 'tokens_after_pred', 'cascade_predicted_tokens', 'floor_pred'].filter((key) => key in record);
        expect(numbers.length, `${raw} ${JSON.stringify(target)}`).toBeGreaterThan(0);
        for (const key of numbers) expect(record[key], `${raw} ${JSON.stringify(target)} ${key}`).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('token accounting: record of a compaction', () => {
  it('writes no token field while the switch is off (the default path)', async () => {
    const { record } = await compactRecord(ACTIVE_ENV);
    expect(record).toBeDefined();
    for (const key of ['tokens_before', 'tokens_after', 'target_tokens', 'target_tokens_capped', 'window', 'threshold', 'window_source', 'tokens_source']) {
      expect(record).not.toHaveProperty(key);
    }
  });

  it('writes the window, the tokens before and after, and the target with its ceiling while the switch is on', async () => {
    const { record } = await compactRecord({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' });
    expect(record).toMatchObject({ window: 200000, threshold: 167000, window_source: 'host:settings', tokens_source: 'usage', tokens_before: 130000, target_tokens: 65000, target_tokens_capped: 65000 });
    expect(record.tokens_after).toBeLessThan(record.tokens_before);
    expect(record.tokens_after).toBeGreaterThan(0);
  });

  it('caps the target at the ceiling of OMC_JEV_COMPACT_MAX_WINDOW_TOKENS, and leaves it when the cap is above it', async () => {
    const capped = await compactRecord({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1', OMC_JEV_COMPACT_MAX_WINDOW_TOKENS: '50000' });
    expect(capped.record).toMatchObject({ target_tokens: 65000, target_tokens_capped: 49407 });
    const above = await compactRecord({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1', OMC_JEV_COMPACT_MAX_WINDOW_TOKENS: '120000' });
    expect(above.record).toMatchObject({ target_tokens: 65000, target_tokens_capped: 65000 });
  });

  it('estimates the tokens before from the API form when the usage is not the main loop (a subagent)', async () => {
    const messages = conversation(30);
    const fake = fakeDollar({ env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' }, usage: usageOf });
    fake.$.session.messages = async () => messages;
    const handlers = {};
    register((event, hook) => { handlers[event] = hook; });
    const next = async () => ({ messages: [] });
    await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', agentId: 'agent-1', messages }), next);
    const [record] = fake.records();
    expect(record).toMatchObject({ tokens_source: 'estimate' });
    expect(record.tokens_before).toBeGreaterThan(0);
    expect(record.tokens_before).not.toBe(130000);
  });

  it('counts the images of results in the estimate from rows (the host answers no API form): before and after', async () => {
    const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    const messages = conversation(30, 4000).map((m) => {
      const image = m.toolResults?.length && Number(m.toolResults[0].tool_use_id.slice(1)) % 2 === 0;
      return image ? Object.freeze({ ...m, toolResults: [{ ...m.toolResults[0], result: [IMAGE, IMAGE] }] }) : m;
    });
    const imagesCount = messages.reduce((s, m) => s + (m.toolResults || []).reduce((t, r) => t + (r.result || []).length, 0), 0);
    expect(imagesCount).toBe(30);
    // The list the host would have sent, built from the rows: a text, the calls, the results with the blocks of their images.
    const api = messages.map((m) => ({
      role: m.role,
      content: [
        ...(m.text ? [{ type: 'text', text: m.text }] : []),
        ...(m.toolUses || []).map((u) => ({ type: 'tool_use', id: u.tool_use_id, name: u.tool, input: u.input })),
        ...(m.toolResults || []).map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: [{ type: 'text', text: r.text }, ...(r.result || [])] })),
      ],
    }));
    const expected = Math.round(listTokens(api));
    const fake = fakeDollar({ env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' }, usage: usageOf });
    // The host answers the rows for the API read too: no API form, so the estimate comes from the rows.
    fake.$.session.messages = async () => messages;
    const handlers = {};
    register((event, hook) => { handlers[event] = hook; });
    await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', agentId: 'agent-1', messages }), async () => ({ messages: [] }));
    const [record] = fake.records();
    expect(record).toMatchObject({ result: 'jev', tokens_source: 'estimate', tokens_before: expected });
    // The results the cut keeps still hold their images: the tokens after cannot stand under them (30 images at 2348 tokens, the default RATE_IMAGE).
    expect(record.tokens_before).toBeGreaterThan(30 * 2348);
    expect(record.tokens_after).toBeLessThan(record.tokens_before);
    expect(record.tokens_after).toBeGreaterThan(0);
  });
});

describe('token accounting: the window of the cascade', () => {
  // An automatic compaction of a subagent whose estimate is under the threshold: the cascade narrows the window to the estimate (`+agent`).
  async function agentRecord(extra) {
    const messages = conversation(30);
    const fake = fakeDollar({ env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET_PERCENT: '20', ...extra }, usage: usageOf });
    fake.$.session.messages = async () => messages;
    const handlers = {};
    register((event, hook) => { handlers[event] = hook; });
    await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', agentId: 'agent-1', messages }), async () => ({ messages: [] }));
    return fake.records()[0];
  }

  it('keeps the window, the threshold and the source the cascade planned with when token accounting is on', async () => {
    const plain = await agentRecord({});
    expect(plain.window_source).toMatch(/\+agent$/);
    expect(plain.window).toBeLessThan(200000);
    const accounted = await agentRecord({ OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' });
    expect(accounted).toMatchObject({ window: plain.window, threshold: plain.threshold, window_source: plain.window_source });
    expect(accounted.cascade_target_tokens).toBe(plain.cascade_target_tokens);
    expect(accounted).toHaveProperty('tokens_before');
  });
});

describe('token accounting: own threshold window', () => {
  // A host breakdown without rawMaxTokens: the window is the one the settings give (100 000) with the switch on, the model's (200 000) without it.
  const noRaw = (opts) => (opts?.breakdown ? { context: { tokens: 130000, window: 200000, breakdown: {} } } : { context: { tokens: 130000, window: 200000 } });
  async function turnRecords(env) {
    const messages = conversation(30);
    const fake = fakeDollar({ env: { ...env, OMC_JEV_COMPACT_AT_PERCENT: '80', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000' }, usage: noRaw });
    fake.$.session.messages = async (opts) => (opts?.as === 'api' ? messages.map((m) => ({ role: m.role, content: [{ type: 'text', text: m.text || '' }] })) : messages);
    const handlers = {};
    register((event, hook) => { handlers[event] = hook; });
    await handlers['turn.complete'](fake.$, Object.freeze({ turn: 1 }), async () => ({}));
    return fake.calls.compact;
  }

  it('reads the own threshold window from the resolver only with the switch on', async () => {
    // 130 000 tokens against 80 % of 100 000 asks the host to compact; against 80 % of the model's 200 000 it does not.
    expect(await turnRecords({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' })).toBe(1);
    expect(await turnRecords(ACTIVE_ENV)).toBe(0);
  });
});

describe('token accounting: rates as configuration (OMC_JEV_COMPACT_RATES)', () => {
  const DEFAULTS = {
    PREDICTION_SHORTFALL: 0.012, RATE_IN: 0.5513, RATE_OUT: 0.4502, RATE_NOTE: 0.363, RATE_OWN: 0.287, RATE_ATXT: 0.315, RATE_ATT: 0.43,
    RATE_TRACE: 0.58, RATE_MOVED: 0.455, RATE_NON_ASCII: 3.72, RATE_BLOCK: 45.4, RATE_IMAGE: 2348,
  };

  it('keeps the measured values when the variable is unset, empty or not a JSON object', () => {
    for (const raw of [undefined, '', '   ', 'not json', '[1,2]', '42', 'null', '"RATE_OUT"']) expect(ratesFrom(raw)).toEqual(DEFAULTS);
  });

  it('overrides the named rates one by one and keeps the others', () => {
    expect(ratesFrom('{"RATE_OUT":0.5,"RATE_ATT":0.2}')).toEqual({ ...DEFAULTS, RATE_OUT: 0.5, RATE_ATT: 0.2 });
    expect(ratesFrom('{"PREDICTION_SHORTFALL":0}').PREDICTION_SHORTFALL).toBe(0);
  });

  it('ignores unknown names, non-finite, non-positive and non-number values, and a negative shortfall', () => {
    const bad = '{"RATE_UNKNOWN":3,"RATE_OUT":0,"RATE_IN":-1,"RATE_NOTE":"0.5","RATE_OWN":null,"RATE_ATXT":true,"RATE_TRACE":1e999,"RATE_MOVED":[1],"PREDICTION_SHORTFALL":-0.1}';
    expect(ratesFrom(bad)).toEqual(DEFAULTS);
    expect(ratesFrom('{"RATE_OUT":0.5,"RATE_IN":-1}')).toEqual({ ...DEFAULTS, RATE_OUT: 0.5 });
  });

  it('prices the API list and the window ceiling with the given rates, and with the defaults when none are given', () => {
    const block = 45.4 - 40.5;
    expect(listTokens([{ role: 'user', content: 'hello' }], ratesFrom('{"RATE_OWN":1}'))).toBeCloseTo(5 + block, 6);
    expect(listTokens([{ role: 'user', content: 'hello' }], ratesFrom(undefined))).toBe(listTokens([{ role: 'user', content: 'hello' }]));
    expect(tokenCeiling(120000, ratesFrom('{"PREDICTION_SHORTFALL":0}'))).toBe(120000);
    expect(tokenCeiling(120000, ratesFrom('{"PREDICTION_SHORTFALL":0.1}'))).toBe(109090);
  });

  it('gives the same record without the variable as with a variable that holds nothing usable', async () => {
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1', OMC_JEV_COMPACT_MAX_WINDOW_TOKENS: '50000' };
    const plain = await compactRecord(env);
    for (const raw of ['{}', 'oops', '{"RATE_OUT":-3,"NOPE":1}']) {
      const same = await compactRecord({ ...env, OMC_JEV_COMPACT_RATES: raw });
      for (const key of ['tokens_before', 'tokens_after', 'target_tokens', 'target_tokens_capped']) expect(same.record[key]).toBe(plain.record[key]);
    }
  });

  it('changes the prediction and the ceiling in the record when the variable names rates', async () => {
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1', OMC_JEV_COMPACT_MAX_WINDOW_TOKENS: '50000' };
    const plain = await compactRecord(env);
    const heavy = await compactRecord({ ...env, OMC_JEV_COMPACT_RATES: '{"RATE_OUT":0.9004,"PREDICTION_SHORTFALL":0}' });
    expect(heavy.record.tokens_before).toBe(plain.record.tokens_before);
    expect(heavy.record.tokens_after).toBeLessThan(plain.record.tokens_after);
    expect(plain.record.target_tokens_capped).toBe(49407);
    expect(heavy.record.target_tokens_capped).toBe(50000);
  });
});
