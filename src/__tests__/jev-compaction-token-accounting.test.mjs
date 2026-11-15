/* global setTimeout, clearTimeout */
/**
 * Tests for the token accounting of hooks/jev-compaction.mjs (OMC_JEV_COMPACT_TOKEN_ACCOUNTING=1):
 * the compaction window resolver, the window ceiling, the prefix and the token estimate by class.
 * Units are called directly through their named exports; the end-to-end cases drive register(on) with
 * a fake `$`, the way the host does. No network: the transport stub answers the scoring request.
 */

import { describe, expect, it } from 'vitest';

import { listTokens, prefixTokens, register, resolveWindow, tokenCeiling } from '../../hooks/jev-compaction.mjs';

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

  it('prices a reminder beside a result at the note rate, and a trace line at the trace rate', () => {
    const block = 45.4 - 40.5;
    const trace = '\n[compacted] Bash({"command":"ls"}) - result of 10 chars removed';
    expect(listTokens([{ role: 'assistant', content: `Hi${trace}` }])).toBeCloseTo(0.58 * trace.length + 0.315 * 2 + block, 6);
    // A user message with a text and a result: the text is a reminder beside a result (RATE_NOTE), each of the two blocks costs its share of the message.
    expect(listTokens([{ role: 'user', content: [{ type: 'text', text: 'note' }, { type: 'tool_result', tool_use_id: 't1', content: '' }] }]))
      .toBeCloseTo(0.363 * 4 + 2 * (45.4 - 40.5 / 2), 6);
  });

  it('adds RATE_NON_ASCII for each non-ASCII character', () => {
    const block = 45.4 - 40.5;
    expect(listTokens([{ role: 'user', content: 'é' }])).toBeCloseTo(0.287 * 1 + 3.72 + block, 6);
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
