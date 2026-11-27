/* global setTimeout, clearTimeout */
/**
 * Tests for the series of traces in the compaction run (hooks/jev-compaction.mjs, OMC_JEV_COMPACT_BLOCKS=active with the token cascade): the series stand in the queue of the second round
 * with the results and the blocks, Jev rates them with the question of the round, the ones that come down merge into one line and a file, the floor counts them, and the block
 * traces join a series. The calls of Jev are a fake `$.http.fetch`; no network.
 */

import { describe, expect, it, vi } from 'vitest';

import { register } from '../../hooks/jev-compaction.mjs';

const ACTIVE_ENV = { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'test-key', HOME: '/home/u' };
const PASTES = '/home/u/.omc/state/jev/compaction-pastes/';
const SPOOL = '/home/u/.omc/state/jev/compaction-spool/';
const CASCADE = (percent, extra = {}) => ({ ...ACTIVE_ENV, OMC_JEV_COMPACT_BLOCKS: 'active', OMC_JEV_COMPACT_TARGET_PERCENT: String(percent), ...extra });

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

/** The same session as the second-round tests have (a task, `steps` steps of a call and its result, a last request), with `extra(i)` added to the text of step i. */
function session(steps, extra = () => '', asks = () => undefined) {
  const m = [{ role: 'user', text: 'Task: look at the notes and report.', toolUses: [] }];
  for (let i = 1; i <= steps; i++) {
    const owner = asks(i);
    if (owner) m.push({ role: 'user', text: owner, toolUses: [] }, { role: 'assistant', text: `Answer to the message ${i}.`, toolUses: [] });
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

describe('series of traces in the compaction run: the queue of the second round', () => {
  it('puts the series to Jev with the question of the round, once per text, and merges the one it rates lowest into one line and a file', async () => {
    const run = await compactRun(CASCADE(60), session(40, withSeries), { rate: (item) => (item.text.includes('file-11.txt') ? 0 : 3) });
    expect(run.record.f2.series_question).toMatchObject({ items: 2, answered: 2 });
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

  it('puts a series in the last row, the newest row before the end of the conversation, to Jev and merges it when Jev rates it lowest; a series of the same row that holds a secret value is sent masked', async () => {
    const base = session(40, withSeries);
    const last = base.length - 1;
    const SECRET_SERIES = `${call(31)}\n${call(32)}\n${call(33)}\n[compacted] Bash(export API_TOKEN=abc123def456) - result of 20 chars removed`;
    const messages = frozen(base.map((m, i) => (i === last ? { ...m, text: `Summary: done.\n\n${SERIES(21)}\nand then\n${SECRET_SERIES}` } : m)));
    const run = await compactRun(CASCADE(60), messages, { rate: (item) => (item.text.includes('file-21.txt') ? 0 : 3) });
    expect(run.asked.map((x) => x.item.series.calls).sort()).toEqual([4, 4, 4, 4]);
    expect(run.record.f2.series_question).toMatchObject({ items: 4, answered: 4 });
    expect(JSON.stringify(run.asked)).not.toContain('abc123def456');
    expect(JSON.stringify(run.asked)).toContain('Bash(export API_TOKEN=***');
    expect(run.record.series).toMatchObject({ mode: 'active', series: 1, traces: 4, files: 1, written: 1, installed: true });
    const text = allText(run.out);
    expect(text).toContain('Summary: done.\n\n[compacted] traces merged: 4 calls, 0 replies, 0 others; list in /home/u/.omc/state/jev/compaction-pastes/sess-series-f2/');
    expect(text).not.toContain(call(21));
    expect(text).toContain(SECRET_SERIES);
    expect([...run.files().values()].filter((t) => t.includes(call(21)))).toEqual([`${SERIES(21)}\n`]);
    expect([...run.files().values()].join('')).not.toContain('abc123def456');
  });

  it.each([['a series of an early row', 3], ['a series of the newest row', undefined]])('a password named in words only reaches neither Jev nor the file: %s', async (_, step) => {
    const PROSE = `${call(41)}\n[compacted] Bash(echo "the password is Zaq12wsx9" > note.txt) - result of 20 chars removed\n${call(43)}\n${call(44)}`;
    const base = session(40, (i) => (i === step ? `\n\n${PROSE}` : ''));
    const messages = step ? base : frozen(base.map((m, i) => (i === base.length - 1 ? { ...m, text: `Summary: done.\n\n${PROSE}` } : m)));
    const run = await compactRun(CASCADE(60), messages, { rate: () => 0 });
    expect(run.asked).toHaveLength(1);
    expect(run.asked[0].item.text).toContain('the password is ***');
    expect(JSON.stringify(run.asked)).not.toContain('Zaq12wsx9');
    expect(run.record.series).toMatchObject({ mode: 'active', series: 1, traces: 4, written: 1, secret: 0, installed: true });
    const files = [...run.files().values()].join('');
    expect(files).toContain('the password is ***');
    expect(files).not.toContain('Zaq12wsx9');
    expect(allText(run.out)).not.toContain('Zaq12wsx9');
  });

  it('leaves a series Jev rates high where it is, and a series that names a secret path is sent to Jev with that line replaced', async () => {
    const run = await compactRun(CASCADE(60), session(40, (i) => (i === 3 ? `\n\n${SERIES(1)}` : i === 5 ? `\n\n[compacted] Read(/home/u/.ssh/id_rsa) - result of 1700 chars removed\n${call(12)}\n${call(13)}\n${call(14)}` : '')), { rate: () => 3 });
    expect(run.record.f2.series_question).toMatchObject({ items: 2, secret: 0, answered: 2 });
    expect(run.asked).toHaveLength(2);
    expect(JSON.stringify(run.asked)).not.toContain('id_rsa');
    expect(JSON.stringify(run.asked)).toContain('[line omitted: secret path]');
    expect(run.record.f2.lowered.by_kind.series).toBeUndefined();
    expect(run.record.series).toBeUndefined();
    expect(allText(run.out)).toContain(call(1));
    expect(allText(run.out)).toContain('id_rsa');
  });

  it('a series that names a private path of the list is not sent to Jev at all and stays', async () => {
    const env = CASCADE(60, { OMC_JEV_COMPACT_PRIVATE_PATHS: '/srv/diary' });
    const run = await compactRun(env, session(40, (i) => (i === 3 ? `\n\n${SERIES(1)}` : i === 5 ? `\n\n[compacted] Read(/srv/diary/may.md) - result of 1700 chars removed\n${call(12)}\n${call(13)}\n${call(14)}` : '')), { rate: () => 0 });
    expect(run.record.f2.series_question).toMatchObject({ items: 2, secret: 1, answered: 1 });
    expect(JSON.stringify(run.asked)).not.toContain('diary');
    expect(allText(run.out)).toContain('/srv/diary/may.md');
    expect(run.record.series).toMatchObject({ series: 1, secret: 0 });
    const only = await compactRun(env, session(40, (i) => (i === 5 ? `\n\n[compacted] Read(/srv/diary/may.md) - result of 1700 chars removed\n${call(12)}\n${call(13)}\n${call(14)}` : '')), { rate: () => 0 });
    expect(only.record.floor_series_tokens).toBeUndefined();
  });

  // Literals the mask lets through and the check of the other stages finds: the floor, the question and the file give one answer.
  it.each([
    ['a German word for a secret', 'Bash(echo "kennwort: Zq8Tr4Lm2Xp" > a.txt)'],
    ['escaped JSON, found in the text of the question only', 'Bash(echo {\\"password\\": \\"Zq8Tr4Lm2Xp\\"})'],
    ['a .ssh directory with a suffix', 'Read(/home/u/.ssh_backup/Zq8Tr4Lm2Xp)'],
  ])('a series the check holds is not sent to Jev, not written and not counted in the floor: %s', async (_, literal) => {
    const HELD = `[compacted] ${literal} - result of 20 chars removed\n${call(12)}\n${call(13)}\n${call(14)}`;
    const run = await compactRun(CASCADE(60), session(40, (i) => (i === 3 ? `\n\n${SERIES(1)}` : i === 5 ? `\n\n${HELD}` : '')), { rate: () => 0 });
    expect(run.record.f2.series_question).toMatchObject({ items: 2, secret: 1, unchecked: 0, answered: 1 });
    expect(JSON.stringify(run.asked)).not.toContain('Zq8Tr4Lm2Xp');
    expect([...run.files().values()].join('')).not.toContain('Zq8Tr4Lm2Xp');
    expect(run.record.series).toMatchObject({ series: 1, secret: 0 });
    expect(allText(run.out)).toContain(HELD);
    const alone = await compactRun(CASCADE(60), session(40, (i) => (i === 3 ? `\n\n${SERIES(1)}` : '')), { rate: () => 0 });
    expect(alone.record.floor_series_tokens).toBeGreaterThan(0);
    expect(run.record.floor_series_tokens).toBe(alone.record.floor_series_tokens);
    const only = await compactRun(CASCADE(60), session(40, (i) => (i === 5 ? `\n\n${HELD}` : '')), { rate: () => 0 });
    expect(only.record.floor_series_tokens).toBeUndefined();
    expect(only.asked).toHaveLength(0);
    const shadow = await compactRun({ ...CASCADE(60), OMC_JEV_COMPACT_BLOCKS: 'shadow' }, session(40, (i) => (i === 5 ? `\n\n${HELD}` : '')));
    expect(shadow.record.f2).toMatchObject({ mode: 'shadow', candidates: { series: 1 } });
    expect(allText(shadow.out)).toContain(HELD);
  });

  // Forms the mask of a series cuts apart and the shared mask of the other stages reads: neither the question nor the file holds the value.
  it.each([
    ['a value behind an escaped quote', 'Bash(curl {"cmd":"export DB_PASSWORD=\\"Zq8Tr4Lm2Xp\\""})'],
    ['a secret name after a secret name', 'Bash(curl secret: x-api-key: Zq8Tr4Lm2Xp)'],
    ['a value with a bracket behind an escaped quote', 'Bash(curl {"cmd":"API_KEY=\\"ab(cd)Zq8Tr4Lm2Xp\\""})'],
  ])('the question and the file of a series hold no value of %s', async (_, literal) => {
    const form = `[compacted] ${literal} - result of 20 chars removed\n${call(12)}\n${call(13)}`;
    const run = await compactRun(CASCADE(60), session(40, (i) => (i === 5 ? `\n\n${form}` : '')), { rate: () => 0 });
    expect(run.record.series).toMatchObject({ series: 1, secret: 0 });
    expect(run.asked).toHaveLength(1);
    expect(run.asked[0].item.text).toContain('file-12.txt');
    expect(JSON.stringify(run.asked)).not.toContain('Zq8Tr4Lm2Xp');
    const files = [...run.files().values()].join('');
    expect(files).toContain(call(13));
    expect(files).not.toContain('Zq8Tr4Lm2Xp');
  });

  it.each([
    ['a token', `ghp_${'abcdefghijklmnopqrstuvwxyz0123'}`],
    ['an assignment', 'password=Zaq12wsx9'],
    ['a token as the tool part of an MCP name', `mcp__server__ghp_${'abcdefghijklmnopqrstuvwxyz0123'}`],
  ])('a series with a tool name that holds a secret (%s) is not sent to Jev and stays', async (_, name) => {
    const held = `[compacted] ${name}(x) - result of 20 chars removed\n${call(12)}\n${call(13)}`;
    const run = await compactRun(CASCADE(60), session(40, (i) => (i === 3 ? `\n\n${SERIES(1)}` : i === 5 ? `\n\n${held}` : '')), { rate: () => 0 });
    expect(run.record.f2.series_question).toMatchObject({ items: 2, secret: 1, answered: 1 });
    expect(JSON.stringify(run.asked)).not.toContain(name.replace('mcp__server__', ''));
    expect(allText(run.out)).toContain(held);
  });

  it('real tool names hold no series back, long MCP names with digits and server ids among them', async () => {
    const names = ['Read', 'mcp__plugin_context7_context7__resolve-library-id', 'mcp__plugin_oh-my-claudecode_t__ast_grep_search', 'mcp__9f0e1c2a-1111-4222-8333-944455566677__list_events', 'mcp__claude_ai_Google_Calendar__get_token'];
    const series = names.map((name) => `[compacted] ${name}(x) - result of 20 chars removed`).join('\n');
    const run = await compactRun(CASCADE(60), session(40, (i) => (i === 5 ? `\n\n${series}` : '')), { rate: () => 0 });
    expect(run.record.f2.series_question).toMatchObject({ items: 1, secret: 0, answered: 1 });
    expect(Object.keys(run.asked[0].item.series.tools)).toEqual(names);
  });

  it('a deadline that has passed when a series is checked keeps it whole and counts it timed out in the question of the second round', async () => {
    const now = Date.now.bind(Date);
    // The clock is past every deadline inside the check of a series and as usual everywhere else.
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 40;
      const inCheck = new Error().stack.includes('checkSeries');
      Error.stackTraceLimit = limit;
      return inCheck ? now() + 3_600_000 : now();
    });
    let run;
    try { run = await compactRun(CASCADE(60), session(40, withSeries), { rate: () => 0 }); } finally { clock.mockRestore(); }
    expect(run.record.f2.series_question).toMatchObject({ items: 2, timed_out: 2, secret: 0 });
    expect(run.asked).toEqual([]);
    expect(allText(run.out)).toContain(call(11));
  });

  it('a series is checked once for the floor, the question and the file, so three long series fit the amount one compaction checks', async () => {
    const long = (base) => Array.from({ length: 100 }, (_, k) => call(base + k)).map((line) => `${line} ${'x'.repeat(200)}`).join('\n');
    const run = await compactRun(CASCADE(60), session(40, (i) => ([3, 5, 7].includes(i) ? `\n\n${long(i * 100000)}` : '')), { rate: () => 0 });
    expect(run.record.f2.series_question).toMatchObject({ items: 3, secret: 0, unchecked: 0, answered: 3 });
    expect(run.record.series.unchecked).toBe(0);
    expect(run.record.series.series).toBeGreaterThan(0);
  });

  it('asks nothing about series when the prediction is already at the goal, and without the switch there is no series at all', async () => {
    const calm = await compactRun(CASCADE(80), session(40, withSeries));
    expect(calm.record.f2.reason).toBe('below_goal');
    expect(calm.record.f2.series_question).toBeUndefined();
    expect(calm.asked).toHaveLength(0);
    const off = await compactRun({ ...CASCADE(55), OMC_JEV_COMPACT_BLOCKS: undefined }, session(40, withSeries));
    expect(off.record.f2).toBeUndefined();
    expect(off.record.series).toBeUndefined();
    expect(allText(off.out)).not.toContain('traces merged');
  });

  it('a series Jev gives no rating is not in the queue: nothing merges', async () => {
    const run = await compactRun(CASCADE(60), session(40, withSeries), { rate: () => undefined });
    expect(run.record.f2.series_question).toMatchObject({ items: 2, answered: 0 });
    expect(run.record.f2.candidates.series).toBeUndefined();
    expect(run.record.series).toBeUndefined();
    expect(allText(run.out)).not.toContain('traces merged');
  });

  it('a row another stage changes keeps its series: the long reply stage moves the reply in the row, the series beside it is neither asked about nor merged', async () => {
    const env = CASCADE(54, { OMC_JEV_COMPACT_LONG_REPLIES: 'active' });
    const asks = (i) => (i % 6 === 0 ? `Owner request ${i} ${fill(`ask${i}`, 300)}` : undefined);
    const run = await compactRun(env, session(40, (i) => (i === 3 ? `\n\n${SERIES(1)}` : ''), asks), { rate: () => 0 });
    expect(run.record.replies.moved).toBeGreaterThan(0);
    expect(allText(run.out)).toContain('[reply moved at compaction: ');
    expect(run.record.f2.series_question?.items ?? 0).toBe(0);
    expect(run.record.series).toBeUndefined();
  });

  it('in shadow it counts the series candidates and writes nothing', async () => {
    const shadow = await compactRun({ ...CASCADE(55), OMC_JEV_COMPACT_BLOCKS: 'shadow' }, session(40, withSeries));
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
    // The same traces apart (a word between each) are no series: the floor stands higher by what the series gives back.
    const apart = await compactRun(CASCADE(55), session(40, (i) => withSeries(i).replace(/\n(?=\[compacted\])/g, '\nand\n')), { rate: () => 3 });
    expect(apart.record.floor_series_tokens).toBeUndefined();
    expect(Math.abs(apart.record.floor_pred - run.record.floor_pred - run.record.floor_series_tokens)).toBeLessThanOrEqual(2);
  });
});
