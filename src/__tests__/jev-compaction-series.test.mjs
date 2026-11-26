/* global setTimeout, clearTimeout */
/**
 * Tests for the series of traces in hooks/jev-compaction.mjs (OMC_JEV_COMPACT_TRESC=off|shadow|active, off when unset): two or more neighbouring traces of the module in one row
 * are a series, and a series that is asked for merges into one line that names a file with the traces word for word. No network; files are a map in memory.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import * as module from '../../hooks/jev-compaction.mjs';

const { blockTrace, mergeSeries, pasteTrace, readConfig, register, replyTrace, seriesContext, seriesItems, seriesRuns, traceHeader } = module;

const ACTIVE_ENV = { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'test-key', HOME: '/home/u' };
const PASTES = '/home/u/.omc/state/jev/compaction-pastes/';
const SESSION = 'sess-series';
const FAR = Date.now() + 3_600_000;

const call = (n, extra = '') => `[compacted] Read(file-${n}.txt) - result of ${1000 + n} chars removed${extra}`;
const failed = (n) => `[compacted] Bash(make step-${n}) - error of ${200 + n} chars removed`;
const reply = (n) => replyTrace(900 + n, `reply number ${n} `.repeat(60), `/home/u/.omc/state/jev/compaction-pastes/${SESSION}/${String(n).repeat(32).slice(0, 32)}.txt`);
const agent = (n) => `[agent message moved at compaction, not from the user: /home/u/.omc/state/jev/compaction-pastes/${SESSION}/${String(n).repeat(32).slice(0, 32)}.txt (900 chars, 900 bytes); from worker-${n}]`;
const sha32 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** The config, read through the module's own reader with a fake `$` that holds only the environment. */
async function configOf(env) {
  return readConfig({ env: { get: async (name) => ({ ...ACTIVE_ENV, ...env })[name] }, settings: { read: async () => undefined }, clock: { after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; } } });
}

/** A fake `$` with files in a map: `failWrite` makes a write throw, `wrong` makes a read give back other text. */
function fakeDollar({ failWrite = false, wrong = false } = {}) {
  const store = new Map();
  const $ = {
    clock: { after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; } },
    fs: {
      read: async (p) => { if (!store.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return wrong ? `${store.get(p)}!` : store.get(p); },
      write: async (p, text) => { if (failWrite) throw new Error('disk full'); store.set(p, text); },
    },
  };
  return { $, store, files: () => new Map([...store.entries()].filter(([p]) => p.startsWith(PASTES))) };
}

const user = (text) => ({ role: 'user', text, toolUses: [] });
const assistant = (text) => ({ role: 'assistant', text, toolUses: [] });
const frozen = (list) => list.map((x, k) => Object.freeze({ ...x, handle: `h${k}` }));
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

/**
 * A conversation: the task, then for each text a message of the user and three assistant rows of which the middle one holds the text (the first and the last assistant row after a
 * message of the user are its direct reply, so the middle one is not), and a plain tail of ten rows. The text number i is on row `rowOf(i)`.
 */
const rowOf = (i) => 3 + 4 * i;
function conversation(texts) {
  const m = [user('Task: look at the notes and report.')];
  texts.forEach((t, i) => m.push(user(`please go on with step ${i}`), assistant(`Looking at step ${i}.`), assistant(t), assistant(`Step ${i} is done.`)));
  for (let k = 0; k < 10; k++) m.push(k % 2 ? assistant(`tail ${k}`) : user(`tail ${k}`));
  return frozen(m);
}

describe('series of traces: what is a series', () => {
  it('one trace is no series and two neighbouring traces are (the minimum is two)', () => {
    expect(seriesRuns(call(1))).toHaveLength(0);
    expect(seriesRuns(`Done.\n${call(1)}`)).toHaveLength(0);
    const two = `${call(1)}\n${call(2)}`;
    const runs = seriesRuns(two);
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe(two);
    expect(runs[0].stats.traces).toBe(2);
  });

  it('only white space may stand between the traces of a series: a blank line joins them, any other text parts them', () => {
    expect(seriesRuns(`${call(1)}\n\n  \n${call(2)}`)).toHaveLength(1);
    expect(seriesRuns(`${call(1)}\nI looked at it.\n${call(2)}`)).toHaveLength(0);
    const split = `${call(1)}\n${call(2)}\n${call(3)}\nthen the result\n${call(4)}\n${call(5)}`;
    const runs = seriesRuns(split);
    expect(runs.map((r) => r.stats.traces)).toEqual([3, 2]);
    expect(runs[0].text).toBe(`${call(1)}\n${call(2)}\n${call(3)}`);
    expect(runs[1].text).toBe(`${call(4)}\n${call(5)}`);
  });

  it('a trace stands at the start of a line: the text of a trace inside a line is no trace', () => {
    expect(seriesRuns(`see ${call(1)}\n${call(2)}`)).toHaveLength(0);
    expect(seriesRuns(`${call(1)}\nsee ${call(2)}`)).toHaveLength(0);
  });

  it('the traces of calls, of replies moved to a file and of agent messages moved to a file are members, counted by kind', () => {
    const text = [call(1), failed(2), reply(3), agent(4), call(5)].join('\n');
    const [run] = seriesRuns(text);
    expect(run.stats).toEqual({ traces: 5, calls: 3, replies: 1, others: 1, tools: { Read: 2, Bash: 1 }, errors: 1, file: true });
  });

  it('the trace of a pasted text is no member and it parts the series beside it', () => {
    const paste = pasteTrace(2500, 'pasted words '.repeat(200), '/home/u/p.txt');
    expect(seriesRuns(`${call(1)}\n${paste}\n${call(2)}`)).toHaveLength(0);
    const text = `${call(1)}\n${call(2)}\n${paste}\n${call(3)}\n${call(4)}`;
    expect(seriesRuns(text).map((r) => r.stats.traces)).toEqual([2, 2]);
  });

  it('a series of plain calls names no file; one trace that names a file makes `file` true', () => {
    expect(seriesRuns(`${call(1)}\n${call(2)}`)[0].stats.file).toBe(false);
    expect(seriesRuns(`${call(1)}\n${reply(2)}`)[0].stats.file).toBe(true);
  });

  it('a line merged by an earlier compaction joins a new series with its own counts', () => {
    const merged = '[compacted] traces merged: 4 calls, 2 replies, 1 others; list in /home/u/x.txt';
    const [run] = seriesRuns(`${merged}\n${call(1)}\n${reply(2)}`);
    expect(run.stats).toMatchObject({ traces: 9, calls: 5, replies: 3, others: 1, errors: 0, file: true });
    expect(run.stats.tools).toEqual({ Read: 1 });
  });

  it('in a direct reply the traces of a reply and of an agent message stay and part the series, calls still merge', () => {
    const text = `${call(1)}\n${call(2)}\n${reply(3)}\n${call(4)}\n${agent(5)}\n${call(6)}\n${call(7)}\n${call(8)}`;
    expect(seriesRuns(text, true).map((r) => r.stats.traces)).toEqual([2, 3]);
    expect(seriesRuns(text, false).map((r) => r.stats.traces)).toEqual([8]);
  });
});

describe('series of traces: the trace of a block', () => {
  const block = (n, mode = 'bare') => blockTrace(1200 + n, `block number ${n} `.repeat(60), `b/${sha32(`block ${n}`)}.txt`, mode);
  const header = (dir) => traceHeader(dir);

  it('a block moved to a file, by its trace or as an agent block, is a member of a series (an "other" trace with a file), and in a direct reply it stays and parts the series', () => {
    const agentBlock = blockTrace(900, 'agent words', `b/${sha32('agent block')}.txt`, 'bare', true);
    const text = `${call(1)}\n${block(2)}\n${agentBlock}\n${call(3)}`;
    const [run] = seriesRuns(text);
    expect(run.stats).toMatchObject({ traces: 4, calls: 2, replies: 0, others: 2, file: true });
    expect(seriesRuns(`${call(1)}\n${call(2)}\n${block(3)}\n${call(4)}\n${call(5)}\n${call(6)}`, true).map((r) => r.stats.traces)).toEqual([2, 3]);
  });

  it('the file of a series that holds a block trace opens with the header that says which directory the letter stands for, and the letter paths are no secret', async () => {
    const cfg = await configOf({ OMC_JEV_COMPACT_TRESC: 'active' });
    const text = `Findings.\n${call(1)}\n${block(2, 'start')}\n${call(3)}`;
    const messages = conversation([text]);
    const ctx = seriesContext(cfg, messages, apiOf(messages), messages.length);
    const fake = fakeDollar();
    const record = {};
    const items = seriesItems(cfg, messages, ctx, SESSION);
    expect(items).toHaveLength(1);
    const edited = await mergeSeries(fake.$, cfg, record, messages, ctx, new Set(items.map((x) => x.key)), SESSION, FAR);
    expect(record.series).toMatchObject({ series: 1, traces: 3, secret: 0, written: 1 });
    const body = `${call(1)}\n${block(2, 'start')}\n${call(3)}`;
    const file = `${header(`${PASTES}${SESSION}`.replace(/\/$/, ''))}\n${body}\n`;
    expect([...fake.files().values()]).toEqual([file]);
    expect(edited.get(rowOf(0))).toMatch(/^Findings\.\n\[compacted\] traces merged: 2 calls, 0 replies, 1 others; list in /);
  });
});

describe('series of traces: the rows a series may stand in', () => {
  it('the last KEEP_LAST rows and the rows from keepFrom are the tail; the tail is no place for a series', async () => {
    const cfg = await configOf({ OMC_JEV_COMPACT_TRESC: 'active' });
    const messages = conversation([`${call(1)}\n${call(2)}`]);
    expect(seriesContext(cfg, messages, apiOf(messages), messages.length).tail).toBe(messages.length - 6);
    expect(seriesContext(cfg, messages, apiOf(messages), 3).tail).toBe(3);
    expect(seriesContext(cfg, messages, apiOf(messages), 0).tail).toBe(0);
  });

  it('without the API form nothing is known, and a user message with an image that matches no row stops it too', async () => {
    const cfg = await configOf({ OMC_JEV_COMPACT_TRESC: 'active' });
    const messages = conversation([`${call(1)}\n${call(2)}`]);
    expect(seriesContext(cfg, messages, undefined, messages.length).reason).toBe('no_api_form');
    const api = apiOf(messages);
    api.push({ role: 'user', content: [{ type: 'text', text: 'a picture that no row shows' }, { type: 'image', source: {} }] });
    expect(seriesContext(cfg, messages, api, messages.length).reason).toBe('image_unmatched');
  });

  it('a user row with an image, an assistant row with a server block and a user row a delivered message hangs on are skipped', async () => {
    const cfg = await configOf({ OMC_JEV_COMPACT_TRESC: 'active' });
    const messages = conversation([`${call(1)}\n${call(2)}`, `${call(3)}\n${call(4)}`, `${call(5)}\n${call(6)}`, `${call(7)}\n${call(8)}`]);
    const api = apiOf(messages);
    // The assistant row of text `call(3)...` also holds a server block in the API form; the user message of step 2 carries an image.
    const server = api.findIndex((a) => a.role === 'assistant' && a.content.some((b) => b.text?.includes('file-3.txt')));
    api[server].content.push({ type: 'server_tool_use', id: 'srv1', name: 'web_search', input: {} });
    const withImage = api.findIndex((a) => a.role === 'user' && a.content.some((b) => b.text === 'please go on with step 2'));
    api[withImage].content.push({ type: 'image', source: {} });
    const anchored = rowOf(3) - 2; // the user row of step 3
    const ctx = seriesContext(cfg, messages, api, messages.length, new Map([[anchored, [{ kind: 'x' }]]]));
    expect(ctx.reason).toBeUndefined();
    expect(ctx.fixed.has(rowOf(1))).toBe(true);
    expect(ctx.fixed.has(rowOf(2) - 2)).toBe(true);
    expect(ctx.fixed.has(anchored)).toBe(true);
    expect(ctx.fixed.has(rowOf(0))).toBe(false);
    expect(ctx.fixed.has(rowOf(2))).toBe(false);
    const items = seriesItems(cfg, messages, ctx, SESSION);
    expect(items.map((x) => x.rows)).toEqual([[rowOf(0)], [rowOf(2)], [rowOf(3)]]);
  });

  it('the rows of a direct reply are marked so that the traces of replies in them stay', async () => {
    const cfg = await configOf({ OMC_JEV_COMPACT_TRESC: 'active' });
    const messages = frozen([user('Task: report.'), assistant('Looking.'), assistant(`${call(1)}\n${call(2)}`), assistant('Looked.'), user('what did you find out about the notes?'), assistant(`The answer is in the notes.\n${reply(3)}\n${call(4)}\n${call(5)}`), user('go on'), assistant('Next.'), ...Array.from({ length: 8 }, (_, k) => (k % 2 ? assistant(`tail ${k}`) : user(`tail ${k}`)))]);
    const ctx = seriesContext(cfg, messages, apiOf(messages), messages.length);
    expect(ctx.direct.has(5)).toBe(true);
    expect(ctx.direct.has(2)).toBe(false);
    const items = seriesItems(cfg, messages, ctx, SESSION);
    expect(items.map((x) => x.run.stats.traces)).toEqual([2, 2]);
    expect(items[1].run.text).toBe(`${call(4)}\n${call(5)}`);
    expect(items.map((x) => x.rows)).toEqual([[2], [5]]);
  });
});

describe('series of traces: the items for Jev', () => {
  it('one item per text of a series, the same series in several rows is one item with its rows, and the gain is the traces less the line that replaces them', async () => {
    const cfg = await configOf({ OMC_JEV_COMPACT_TRESC: 'active' });
    const same = `${call(1)}\n${call(2)}\n${call(3)}`;
    const messages = conversation([same, `${call(7)}\n${call(8)}`, same, call(9)]);
    const ctx = seriesContext(cfg, messages, apiOf(messages), messages.length);
    const items = seriesItems(cfg, messages, ctx, SESSION);
    expect(items.map((x) => [x.key === x.body, x.rows, x.repeated, x.row])).toEqual([[true, [rowOf(0), rowOf(2)], true, rowOf(2)], [true, [rowOf(1)], false, rowOf(1)]]);
    const path = `${PASTES}${SESSION}/${'0'.repeat(32)}.txt`;
    const note = `[compacted] traces merged: 3 calls, 0 replies, 0 others; list in ${path}`;
    const rates = cfg.rates;
    expect(items[0].gain).toBeCloseTo(rates.RATE_TRACE * same.length - rates.RATE_TRACE * note.length, 6);
    expect(items[0].gain).toBeGreaterThan(0);
    expect(items[0].f2).toEqual({ kind: 'trace_series', traces: 3, calls: 3, replies: 0, others: 0, tools: { Read: 3 }, errors: 0, has_file: false, tokens: Math.round(rates.RATE_TRACE * same.length), gain_tokens: Math.round(items[0].gain) });
  });

  it('a series that is shorter than the line that replaces it gains nothing (zero, never negative)', async () => {
    const cfg = await configOf({ OMC_JEV_COMPACT_TRESC: 'active' });
    const messages = conversation(['[compacted] A() - x\n[compacted] B() - y']);
    const items = seriesItems(cfg, messages, seriesContext(cfg, messages, apiOf(messages), messages.length), SESSION);
    expect(items).toHaveLength(1);
    expect(items[0].gain).toBe(0);
  });

  it('a row with a tool result and a row from the tail hold no item', async () => {
    const cfg = await configOf({ OMC_JEV_COMPACT_TRESC: 'active' });
    const rows = [user('Task.'), { role: 'assistant', text: 'Step 1.', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'ls' } }] }, { role: 'user', text: `${call(1)}\n${call(2)}`, toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'r', isError: false }] }, assistant('ok'), user('go'), assistant('Looking.'), assistant(`${call(3)}\n${call(4)}`), assistant('Looked.'), user('go on'), assistant('a'), user('b'), assistant('c'), user('d'), assistant('e'), user('f'), assistant('g')];
    const messages = frozen(rows);
    const ctx = seriesContext(cfg, messages, apiOf(messages), messages.length);
    expect(seriesItems(cfg, messages, ctx, SESSION).map((x) => x.rows)).toEqual([[6]]);
    expect(seriesItems(cfg, messages, { ...ctx, tail: 6 }, SESSION)).toHaveLength(0);
  });

  it('a context that holds a reason gives no item', async () => {
    const cfg = await configOf({ OMC_JEV_COMPACT_TRESC: 'active' });
    const messages = conversation([`${call(1)}\n${call(2)}`]);
    expect(seriesItems(cfg, messages, { reason: 'no_api_form' }, SESSION)).toEqual([]);
  });
});

describe('series of traces: merging', () => {
  const SERIES_A = `${call(1)}\n${failed(2)}\n${reply(3)}`;
  const SERIES_B = `${call(4)}\n${call(5)}`;

  async function run({ env = { OMC_JEV_COMPACT_TRESC: 'active' }, texts = [`Findings.\n${SERIES_A}\nAnd more.\n${SERIES_B}`], keys, fake = fakeDollar(), deadline = FAR, sessionId = SESSION } = {}) {
    const cfg = await configOf(env);
    const messages = conversation(texts);
    const ctx = seriesContext(cfg, messages, apiOf(messages), messages.length);
    const record = {};
    const wanted = keys ?? new Set(seriesItems(cfg, messages, ctx, SESSION).map((x) => x.key));
    const edited = await mergeSeries(fake.$, cfg, record, messages, ctx, wanted, sessionId, deadline);
    return { cfg, messages, edited, record, fake };
  }

  it('active: each asked-for series is one line with the counts and its file, the file holds the traces word for word, the rest of the row stays', async () => {
    const { edited, record, fake } = await run();
    const fileA = `${SERIES_A}\n`;
    const fileB = `${SERIES_B}\n`;
    const pathA = `${PASTES}${SESSION}/${sha32(fileA)}.txt`;
    const pathB = `${PASTES}${SESSION}/${sha32(fileB)}.txt`;
    expect([...edited.keys()]).toEqual([rowOf(0)]);
    expect(edited.get(rowOf(0))).toBe(`Findings.\n[compacted] traces merged: 2 calls, 1 replies, 0 others; list in ${pathA}\nAnd more.\n[compacted] traces merged: 2 calls, 0 replies, 0 others; list in ${pathB}`);
    expect(fake.files().get(pathA)).toBe(fileA);
    expect(fake.files().get(pathB)).toBe(fileB);
    expect(fake.files().size).toBe(2);
    expect(record.series).toMatchObject({ mode: 'active', series: 2, traces: 5, files: 2, written: 2, reused: 0, write_failed: 0, secret: 0, unchecked: 0, timed_out: 0, installed: false });
    expect(record.series.tokens_before).toBeGreaterThan(record.series.tokens_after);
  });

  it('only the series whose keys are asked for merge', async () => {
    const { edited, record, fake } = await run({ keys: new Set([SERIES_B]) });
    expect(edited.get(rowOf(0))).toContain(SERIES_A);
    expect(edited.get(rowOf(0))).not.toContain(SERIES_B);
    expect(record.series.series).toBe(1);
    expect(fake.files().size).toBe(1);
  });

  it('a series asked for with no key in the set is not merged: no key, no edit, no file', async () => {
    const { edited, record, fake } = await run({ keys: new Set() });
    expect(edited.size).toBe(0);
    expect(fake.files().size).toBe(0);
    expect(record.series).toMatchObject({ series: 0, traces: 0, files: 0 });
  });

  it('the same series in two rows is merged in both and written once', async () => {
    const { edited, record, fake } = await run({ texts: [SERIES_B, 'in between', SERIES_B] });
    expect([...edited.keys()]).toEqual([rowOf(0), rowOf(2)]);
    expect(edited.get(rowOf(0))).toBe(edited.get(rowOf(2)));
    expect(record.series).toMatchObject({ series: 2, traces: 4, files: 1, written: 1, reused: 0 });
    expect(fake.files().size).toBe(1);
  });

  it('a file that holds the series already is reused and not counted as written', async () => {
    const fake = fakeDollar();
    fake.store.set(`${PASTES}${SESSION}/${sha32(`${SERIES_B}\n`)}.txt`, `${SERIES_B}\n`);
    const { record } = await run({ texts: [SERIES_B], fake });
    expect(record.series).toMatchObject({ series: 1, written: 0, reused: 1, files: 1 });
  });

  it('shadow: counts what would merge, writes nothing, edits nothing', async () => {
    const { edited, record, fake } = await run({ env: { OMC_JEV_COMPACT_TRESC: 'shadow' } });
    expect(edited.size).toBe(0);
    expect(fake.files().size).toBe(0);
    expect(record.series).toMatchObject({ mode: 'shadow', series: 2, traces: 5, files: 2, written: 0 });
    expect(record.series.installed).toBeUndefined();
  });

  it('active needs the point itself active: with the point in shadow the series only count', async () => {
    const { edited, record, fake } = await run({ env: { OMC_JEV_COMPACT_TRESC: 'active', OMC_JEV: 'compaction' } });
    expect(edited.size).toBe(0);
    expect(fake.files().size).toBe(0);
    expect(record.series.mode).toBe('shadow');
  });

  it('a series that names a secret path is held: it stays, no file', async () => {
    const secret = `[compacted] Read(/home/u/.ssh/id_rsa) - result of 1700 chars removed\n${call(2)}`;
    const { edited, record, fake } = await run({ texts: [secret, SERIES_B] });
    expect(edited.get(rowOf(1))).toBeDefined();
    expect(edited.get(rowOf(0))).toBeUndefined();
    expect(record.series).toMatchObject({ series: 1, secret: 1 });
    expect(fake.files().size).toBe(1);
  });

  it('the paths of the module\'s own files in a series are no secret, though their name is 32 hexadecimal digits; the same name anywhere else is held', async () => {
    const own = `${PASTES}${SESSION}/a87affd3def94e9fbfe945090b906d08.txt`;
    const ours = `[compacted] traces merged: 2 calls, 0 replies, 0 others; list in ${own}\n${call(1)}`;
    const first = await run({ texts: [ours] });
    expect(first.record.series).toMatchObject({ series: 1, secret: 0, written: 1 });
    const elsewhere = `[compacted] Read(/srv/data/a87affd3def94e9fbfe945090b906d08.txt) - result of 1700 chars removed\n${call(1)}`;
    const second = await run({ texts: [elsewhere] });
    expect(second.record.series).toMatchObject({ series: 0, secret: 1 });
  });

  it('a series that holds a secret value is held', async () => {
    const withToken = `${call(1)}\n[compacted] Bash(curl -H "Authorization: Bearer sk-ant-api03-AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789") - result of 300 chars removed`;
    const { edited, record } = await run({ texts: [withToken] });
    expect(edited.size).toBe(0);
    expect(record.series).toMatchObject({ series: 0, secret: 1 });
  });

  it('a series longer than the check can read stays whole (unchecked), and so does one beyond the budget of the scan', async () => {
    const long = Array.from({ length: 160 }, (_, k) => call(100000 + k, ` ${'x'.repeat(200)}`)).join('\n');
    const first = await run({ texts: [long] });
    expect(first.record.series).toMatchObject({ series: 0, unchecked: 1 });
    const mid = Array.from({ length: 80 }, (_, k) => call(k, ` ${'y'.repeat(280)}`)).join('\n'); // about 27 000 characters, four of them fit the budget of 120 000 and the fifth does not
    const texts = [1, 2, 3, 4, 5].map((n) => mid.replaceAll('file-', `f${n}-`));
    const second = await run({ texts });
    expect(second.record.series).toMatchObject({ series: 4, unchecked: 1 });
  });

  it('a write that fails leaves the series as it is and is counted', async () => {
    const { edited, record } = await run({ fake: fakeDollar({ failWrite: true }) });
    expect(edited.size).toBe(0);
    expect(record.series).toMatchObject({ series: 0, files: 0, write_failed: 2 });
  });

  it('a file that reads back as other text leaves the series as it is', async () => {
    const { edited, record } = await run({ fake: fakeDollar({ wrong: true }), texts: [SERIES_B] });
    expect(edited.size).toBe(0);
    expect(record.series).toMatchObject({ series: 0, write_failed: 1 });
  });

  it('a deadline that has passed starts no write and no scan: the series stay and are counted as timed out', async () => {
    const { edited, record, fake } = await run({ deadline: Date.now() - 1 });
    expect(edited.size).toBe(0);
    expect(fake.files().size).toBe(0);
    expect(record.series.timed_out).toBeGreaterThan(0);
    expect(record.series.series).toBe(0);
  });

  it('without a state directory, a session or the API form nothing merges and the reason is in the record', async () => {
    const cfg = await configOf({ OMC_JEV_COMPACT_TRESC: 'active' });
    const messages = conversation([SERIES_B]);
    const ctx = seriesContext(cfg, messages, apiOf(messages), messages.length);
    const noDir = {};
    expect((await mergeSeries(fakeDollar().$, { ...cfg, pasteDir: undefined }, noDir, messages, ctx, new Set([SERIES_B]), SESSION, FAR)).size).toBe(0);
    expect(noDir.series.reason).toBe('no_state_dir');
    const noSession = {};
    await mergeSeries(fakeDollar().$, cfg, noSession, messages, ctx, new Set([SERIES_B]), undefined, FAR);
    expect(noSession.series.reason).toBe('no_session');
    const noApi = {};
    await mergeSeries(fakeDollar().$, cfg, noApi, messages, seriesContext(cfg, messages, undefined, messages.length), new Set([SERIES_B]), SESSION, FAR);
    expect(noApi.series.reason).toBe('no_api_form');
  });

  it('the rows of the tail and the rows that were skipped are never edited', async () => {
    const cfg = await configOf({ OMC_JEV_COMPACT_TRESC: 'active' });
    const messages = conversation([SERIES_B, SERIES_B]);
    const ctx = seriesContext(cfg, messages, apiOf(messages), messages.length);
    ctx.fixed.add(rowOf(0));
    const record = {};
    const edited = await mergeSeries(fakeDollar().$, cfg, record, messages, ctx, new Set([SERIES_B]), SESSION, FAR);
    expect([...edited.keys()]).toEqual([rowOf(1)]);
    const tailRow = messages.length - 2;
    const tail = await mergeSeries(fakeDollar().$, cfg, {}, messages.map((m, i) => (i === tailRow ? { ...m, text: SERIES_B } : m)), ctx, new Set([SERIES_B]), SESSION, FAR);
    expect(tail.has(tailRow)).toBe(false);
  });

  it('a series merged twice in two compactions folds into one line with the sum of the counts', async () => {
    const first = await run({ texts: [SERIES_B] });
    const line = first.edited.get(rowOf(0));
    const second = await run({ texts: [`${line}\n${call(9)}`] });
    expect(second.edited.get(rowOf(0))).toMatch(/^\[compacted\] traces merged: 3 calls, 0 replies, 0 others; list in /);
    expect(second.record.series).toMatchObject({ series: 1, traces: 3 });
  });
});

describe('series of traces: the switch', () => {
  it('is off when unset, shadow or active by its value in any case, and any other value is off', async () => {
    expect((await configOf({})).blocks).toBe('off');
    expect((await configOf({ OMC_JEV_COMPACT_TRESC: 'shadow' })).blocks).toBe('shadow');
    expect((await configOf({ OMC_JEV_COMPACT_TRESC: ' Active ' })).blocks).toBe('active');
    expect((await configOf({ OMC_JEV_COMPACT_TRESC: '1' })).blocks).toBe('off');
    expect((await configOf({ OMC_JEV_COMPACT_TRESC: 'on' })).blocks).toBe('off');
  });

  it('a compaction without the token cascade leaves neighbouring traces as they are whatever the switch says (series merge only in the second round)', async () => {
    const SERIES = `${call(1)}\n${call(2)}\n${call(3)}`;
    const rows = [user('Task: look at the notes and report.')];
    for (let k = 0; k < 8; k++) rows.push({ role: 'assistant', text: `Step ${k}.`, toolUses: [{ tool_use_id: `t${k}`, tool: 'Bash', input: { command: `cat n-${k}.txt` } }] }, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${k}`, text: `RESULT-${k} ${'x'.repeat(5000)}`, isError: false }] });
    rows.push(assistant(SERIES), user('go on'), assistant('Next.'), user('and now sum up'), assistant('Done.'));
    const messages = frozen(rows);
    const outs = [];
    for (const value of [undefined, 'shadow', 'active']) {
      const env = { ...ACTIVE_ENV, ...(value ? { OMC_JEV_COMPACT_TRESC: value } : {}) };
      const store = new Map();
      const $ = {
        env: { get: async (name) => env[name] },
        settings: { read: async () => undefined },
        fs: { read: async (p) => { if (!store.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return store.get(p); }, exists: async (p) => store.has(p), write: async (p, t) => { store.set(p, t); }, list: async () => [] },
        http: { fetch: async (url, init) => ({ ok: true, status: 200, headers: {}, text: JSON.stringify({ answers: Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map((q) => [q, { type: 'score', score: 0, confidence: 0.9 }])) }) }) },
        clock: { after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; }, sleep: async () => {} },
        session: { id: async () => 'sess-off', usage: async (o) => ({ context: { tokens: 190000, window: 200000, ...(o?.breakdown ? { breakdown: { rawMaxTokens: 200000, autoCompactThreshold: 167000 } } : {}) } }), messages: async (o) => (o?.as === 'api' ? apiOf(messages) : messages), compact: async () => ({}) },
        ui: { log: () => {}, toast: () => {} },
      };
      const handlers = {};
      register((event, hook) => { handlers[event] = hook; });
      const out = await handlers['session.compact']($, Object.freeze({ trigger: 'auto', messages }), async () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }));
      outs.push(JSON.stringify(out.messages));
      expect(out.messages.map((m) => m.text ?? '').some((t) => t.includes(SERIES))).toBe(true);
    }
    expect(outs[1]).toBe(outs[0]);
    expect(outs[2]).toBe(outs[0]);
  });
});
