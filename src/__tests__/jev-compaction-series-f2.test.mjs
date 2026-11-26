/* global setTimeout, clearTimeout */
/**
 * Tests for the series of traces in the compaction run (hooks/jev-compaction.mjs, OMC_JEV_COMPACT_TRESC=active with the token cascade): the series stand in the queue of the second round
 * of F2 with the results and the blocks, Jev rates them with the question of the round, the ones that come down merge into one line and a file, the floor counts them, and the block
 * traces join a series. The calls of Jev are a fake `$.http.fetch`; no network.
 */

import { describe, expect, it } from 'vitest';

import { register } from '../../hooks/jev-compaction.mjs';

const ACTIVE_ENV = { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'test-key', HOME: '/home/u' };
const PASTES = '/home/u/.omc/state/jev/compaction-pastes/';
const SPOOL = '/home/u/.omc/state/jev/compaction-spool/';
const CASCADE = (percent, extra = {}) => ({ ...ACTIVE_ENV, OMC_JEV_COMPACT_TRESC: 'active', OMC_JEV_COMPACT_TARGET_PERCENT: String(percent), ...extra });

/** A fake `$`: `rate(item)` is the score (0-3) the answer to a series question gives, `blockScore(text)` that of a block; the questions about results are answered with `resultScore`. */
function fakeDollar({ env, messages, api, rate = () => 0, blockScore = () => 3, resultScore = () => 0.6 }) {
  const store = new Map();
  const asked = [];
  const $ = {
    env: { get: async (name) => env[name] },
    settings: { read: async () => undefined },
    fs: {
      read: async (p) => { if (!store.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return store.get(p); },
      exists: async (p) => store.has(p),
      stat: async (p) => { if (!store.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { kind: 'file', size: store.get(p).length, mtimeMs: Date.now(), isLink: false }; },
      write: async (p, text) => { store.set(p, text); },
      list: async (p) => [...store.keys()].filter((k) => k.startsWith(p)).map((k) => k.slice(p.length).split('/')[0]),
    },
    http: {
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        const answers = {};
        for (const q of Object.keys(body.questions)) {
          let score;
          if (body.state.items) {
            const item = body.state.items[q];
            if (item.kind === 'trace_series') asked.push({ item, f2: body.state.f2 });
            score = item.kind === 'trace_series' ? rate(item) : 3;
          } else if (body.state.blocks) score = blockScore(body.state.blocks[q].text);
          else score = resultScore(Number(/RESULT-(\d+) /.exec(JSON.stringify(body.state.results?.[q] ?? ''))?.[1]));
          answers[q] = score === undefined ? { type: 'none' } : { type: 'score', score, confidence: 0.9 };
        }
        return { ok: true, status: 200, headers: {}, text: JSON.stringify({ answers }) };
      },
    },
    clock: { after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; }, sleep: async () => { throw new Error('the module must not use $.clock.sleep'); } },
    session: {
      id: async () => 'sess-series-f2',
      usage: async (o) => ({ context: { tokens: 190000, window: 200000, ...(o?.breakdown ? { breakdown: { rawMaxTokens: 200000, autoCompactThreshold: 167000 } } : {}) } }),
      messages: async (o) => (api && o?.as === 'api' ? api : messages),
      compact: async () => ({}),
    },
    ui: { log: () => {}, toast: () => {} },
  };
  const records = () => [...store.entries()].filter(([p]) => p.startsWith(SPOOL)).map(([, t]) => JSON.parse(t));
  const files = () => new Map([...store.entries()].filter(([p]) => p.startsWith(PASTES)));
  return { $, store, asked, records, files };
}

function apiOf(messages) {
  const api = [];
  for (const m of messages) {
    const content = m.role === 'assistant'
      ? [...(m.text ? [{ type: 'text', text: m.text }] : []), ...m.toolUses.map((u) => ({ type: 'tool_use', id: u.tool_use_id, name: u.tool, input: u.input }))]
      : [...(m.toolResults || []).map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.text })), ...(m.text ? [{ type: 'text', text: m.text }] : [])];
    if (m.role === 'user' && api[api.length - 1]?.role === 'user') api[api.length - 1].content.push(...content); else api.push({ role: m.role, content });
  }
  return api;
}

const RESULT_CHARS = 5000;
const fill = (word, n) => `${word} `.repeat(Math.ceil(n / (word.length + 1))).slice(0, n).trim();
const frozen = (list) => list.map((x, k) => Object.freeze({ ...x, handle: `h${k}` }));
const call = (n) => `[compacted] Read(file-${n}.txt) - result of ${1000 + n} chars removed`;
const SERIES = (from) => [call(from), call(from + 1), call(from + 2), call(from + 3)].join('\n');

/** The same session as the F2 tests have (a task, `steps` steps of a call and its result, a last request), with `extra(i)` added to the text of step i. */
function session(steps, extra = () => '') {
  const m = [{ role: 'user', text: 'Task: look at the notes and report.', toolUses: [] }];
  for (let i = 1; i <= steps; i++) {
    m.push({ role: 'assistant', text: `Step ${i} note ${fill(`detail${i}`, 900)}${extra(i)}`, toolUses: [{ tool_use_id: `t${i}`, tool: 'Bash', input: { command: `cat notes-${i}.txt` } }] });
    m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: `RESULT-${i} ${'x'.repeat(RESULT_CHARS)}`, isError: false }] });
  }
  m.push({ role: 'user', text: 'Good, now sum up the results.', toolUses: [] }, { role: 'assistant', text: 'Summary: done.', toolUses: [] });
  return frozen(m);
}
const withSeries = (i) => (i === 3 ? `\n\n${SERIES(1)}` : i === 5 ? `\n\n${SERIES(11)}` : i === 7 ? `\n\n${SERIES(1)}` : '');

async function compactRun(env, messages, options = {}) {
  const fake = fakeDollar({ env, messages, api: apiOf(messages), ...options });
  const handlers = {};
  register((event, hook) => { handlers[event] = hook; });
  const out = await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages }), async () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }));
  return { ...fake, out, record: fake.records().find((r) => r.event === 'compact') };
}
const allText = (out) => (out?.messages ?? []).map((m) => m.text ?? '').join('\n');

describe('series of traces in the compaction run: the queue of the second round of F2', () => {
  it('puts the series to Jev with the question of the round, once per text, and merges the one it rates lowest into one line and a file', async () => {
    const run = await compactRun(CASCADE(60), session(40, withSeries), { rate: (item) => (item.text.includes('file-11.txt') ? 0 : 3) });
    expect(run.record.f2.series_question).toMatchObject({ items: 2, secret: 0, unchecked: 0, answered: 2 });
    expect(run.asked.map((x) => x.item.series.calls).sort()).toEqual([4, 4]);
    expect(run.asked[0].item).toMatchObject({ kind: 'trace_series', author: 'module', has_file: true, series: { kind: 'trace_series', traces: 4 } });
    expect(run.asked[0].f2).toMatchObject({ goal_tokens: expect.any(Number), to_remove_tokens: expect.any(Number) });
    expect(run.asked[0].f2.tie_group).toBeUndefined();
    expect(run.record.f2.candidates.series).toBe(2);
    expect(run.record.f2.lowered.by_kind.series).toBe(1);
    expect(run.record.series).toMatchObject({ mode: 'active', series: 1, traces: 4, files: 1, written: 1, installed: true });
    const text = allText(run.out);
    expect(text).toContain('[compacted] traces merged: 4 calls, 0 replies, 0 others; list in /home/u/.omc/state/jev/compaction-pastes/sess-series-f2/');
    expect(text).not.toContain(call(11));
    expect(text).toContain(call(1));
    const [file] = [...run.files().values()].filter((t) => t.includes(call(11)));
    expect(file).toBe(`${SERIES(11)}\n`);
  });

  it('leaves a series Jev rates high where it is, and a series that names a secret path is not sent to Jev at all', async () => {
    const run = await compactRun(CASCADE(60), session(40, (i) => (i === 3 ? `\n\n${SERIES(1)}` : i === 5 ? `\n\n[compacted] Read(/home/u/.ssh/id_rsa) - result of 1700 chars removed\n${call(12)}\n${call(13)}\n${call(14)}` : '')), { rate: () => 3 });
    expect(run.record.f2.series_question).toMatchObject({ items: 2, secret: 1, answered: 1 });
    expect(run.asked).toHaveLength(1);
    expect(JSON.stringify(run.asked)).not.toContain('id_rsa');
    expect(run.record.f2.lowered.by_kind.series).toBeUndefined();
    expect(run.record.series).toBeUndefined();
    expect(allText(run.out)).toContain(call(1));
    expect(allText(run.out)).toContain('id_rsa');
  });

  it('asks nothing about series when the prediction is already at the goal, and without the switch there is no series at all', async () => {
    const calm = await compactRun(CASCADE(80), session(40, withSeries));
    expect(calm.record.f2.reason).toBe('below_goal');
    expect(calm.record.f2.series_question).toBeUndefined();
    expect(calm.asked).toHaveLength(0);
    const off = await compactRun({ ...CASCADE(55), OMC_JEV_COMPACT_TRESC: undefined }, session(40, withSeries));
    expect(off.record.f2).toBeUndefined();
    expect(off.record.series).toBeUndefined();
    expect(allText(off.out)).not.toContain('traces merged');
  });

  it('in shadow it counts the series candidates and writes nothing', async () => {
    const shadow = await compactRun({ ...CASCADE(55), OMC_JEV_COMPACT_TRESC: 'shadow' }, session(40, withSeries));
    expect(shadow.record.f2).toMatchObject({ mode: 'shadow', candidates: { series: 2 } });
    expect(shadow.asked).toHaveLength(0);
    expect(shadow.record.series).toBeUndefined();
    expect([...shadow.files().keys()].filter((p) => !p.includes('verdict-'))).toEqual([]);
    expect(allText(shadow.out)).not.toContain('traces merged');
  });

  it('the series count in the floor like the blocks: what merging them gives back is `floor_series_tokens`', async () => {
    const run = await compactRun(CASCADE(55), session(40, withSeries), { rate: () => 3 });
    expect(run.record.floor_series_tokens).toBeGreaterThan(0);
    const none = await compactRun(CASCADE(55), session(40));
    expect(none.record.floor_series_tokens).toBeUndefined();
  });
});
