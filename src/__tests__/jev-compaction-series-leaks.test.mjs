/* global setTimeout, clearTimeout */
/**
 * What leaves with a series of traces (OMC_JEV_COMPACT_BLOCKS=active with the token cascade): every request body sent to Jev and every file the module writes are read whole.
 * Covered: ids of the shape a host makes as tool names and as directory or file names of the module's own paths, token prefixes, private paths written with escapes, and own
 * paths whose files are there, are missing, cannot be read or are not read in time; and which tool names keep a series whole. Every value is made up and put together at run time. No network; files are a map in memory.
 */

import { describe, expect, it } from 'vitest';

import { archiveSegment, register } from '../../hooks/jev-compaction.mjs';

const SESSION = 'sess-series-leaks';
const STATE = '/home/u/.omc/state/jev/';
const PASTES = `${STATE}compaction-pastes/`;
const ARCHIVE = `${STATE}compaction-archive/`;
const ENV = { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'test-key', HOME: '/home/u', OMC_JEV_COMPACT_BLOCKS: 'active', OMC_JEV_COMPACT_TARGET_PERCENT: '60' };

const join = (...parts) => parts.join('');
const call = (n) => `[compacted] Read(file-${n}.txt) - result of ${1000 + n} chars removed`;
// Enough plain traces that merging a series gives tokens back (a series with no gain is not asked about).
const calls = (from) => Array.from({ length: 6 }, (_, k) => call(from + k)).join('\n');
const named = (name) => `[compacted] ${name}(x) - result of 20 chars removed`;
const bash = (command) => `[compacted] Bash(${command}) - result of 20 chars removed`;

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
 * A whole compaction of forty steps; `series` stands in the text of step 3 and a control series of plain traces in the text of step 7. Jev rates every series 0, so
 * both come down. `there`: files of the module that exist before; `broken`: reads that fail; `hung`: reads that never come back. `steps`: the command and result of a step.
 */
async function compact(series, { env = {}, there = [], broken = [], hung = [], steps = () => undefined } = {}) {
  const rows = [{ role: 'user', text: 'Task: look at the notes and report.', toolUses: [] }];
  for (let i = 1; i <= 40; i++) {
    const extra = i === 3 ? `\n\n${series}` : i === 7 ? `\n\n${calls(71)}` : '';
    const [command, result] = steps(i) ?? [`cat notes-${i}.txt`, `RESULT-${i} ${'x'.repeat(5000)}`];
    rows.push({ role: 'assistant', text: `Step ${i} note ${`detail${i} `.repeat(100)}${extra}`, toolUses: [{ tool_use_id: `t${i}`, tool: 'Bash', input: { command } }] });
    rows.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: result, isError: false }] });
  }
  rows.push({ role: 'user', text: 'Good, now sum up the results.', toolUses: [] }, { role: 'assistant', text: 'Summary: done.', toolUses: [] });
  const messages = frozen(rows);
  const all = { ...ENV, ...env };
  const store = new Map(there.map((p) => [p, 'written earlier']));
  const written = [];
  const bodies = [];
  const $ = {
    env: { get: async (name) => all[name] },
    settings: { read: async () => undefined },
    clock: { after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; }, sleep: async () => { throw new Error('no sleep'); } },
    fs: {
      read: async (p) => {
        if (hung.includes(p)) return new Promise(() => {});
        if (broken.includes(p)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        if (!store.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return store.get(p);
      },
      exists: async (p) => store.has(p),
      stat: async (p) => { if (!store.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { kind: 'file', size: store.get(p).length, mtimeMs: Date.now(), isLink: false }; },
      write: async (p, text) => { store.set(p, text); written.push(text); },
      list: async (p) => [...store.keys()].filter((k) => k.startsWith(p)).map((k) => k.slice(p.length).split('/')[0]),
    },
    http: {
      fetch: async (url, init) => {
        bodies.push(init.body);
        const body = JSON.parse(init.body);
        const answers = {};
        for (const q of Object.keys(body.questions)) {
          const item = body.state.items?.[q];
          answers[q] = { type: 'score', score: item ? (item.kind === 'trace_series' ? 0 : 3) : body.state.blocks ? 3 : 0.6, confidence: 0.9 };
        }
        return { ok: true, status: 200, headers: {}, text: JSON.stringify({ answers }) };
      },
    },
    session: {
      id: async () => SESSION,
      usage: async (o) => ({ context: { tokens: 190000, window: 200000, ...(o?.breakdown ? { breakdown: { rawMaxTokens: 200000, autoCompactThreshold: 167000 } } : {}) } }),
      messages: async (o) => (o?.as === 'api' ? apiOf(messages) : messages),
      compact: async () => ({}),
    },
    ui: { log: () => {}, toast: () => {} },
  };
  const handlers = {};
  register((event, hook) => { handlers[event] = hook; });
  const out = await handlers['session.compact']($, Object.freeze({ trigger: 'auto', messages }), async () => ({ messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }));
  const asked = bodies.flatMap((body) => Object.values(JSON.parse(body).state.items ?? {})).filter((item) => item.kind === 'trace_series');
  const record = [...store.entries()].filter(([p]) => p.startsWith(`${STATE}compaction-spool/`)).map(([, text]) => JSON.parse(text)).find((r) => r.event === 'compact');
  return { bodies, sent: bodies.join('\n'), written: written.join('\n'), asked, record, conversation: (out?.messages ?? []).map((m) => m.text ?? '').join('\n') };
}

// Whether any twelve characters in a row of `value` (the whole of a shorter one) stand in the text.
function holds(text, value) {
  const n = Math.min(12, value.length);
  for (let i = 0; i + n <= value.length; i++) if (text.includes(value.slice(i, i + n))) return true;
  return false;
}
/** The control series was asked about and written, so the run did send and write; neither a body nor a written file holds the value. */
function expectKeptIn(run, value) {
  expect(run.asked.map((item) => item.text).join('\n')).toContain('file-71.txt');
  expect(run.written).toContain(call(76));
  expect({ sent: holds(run.sent, value), written: holds(run.written, value) }).toEqual({ sent: false, written: false });
}
const seriesOf = (line) => `${line}\n${calls(31)}`;

// --- ids of the shape a host makes ----------------------------------------------------------------------------------------------------
const HEX32 = join('7f3a9c1e5b2d4a60', '8e4c1f9b3d7a2c58');
const HEX40 = join(HEX32, 'a91f04bd');
const UUID = join('7f3a9c1e-5b2d-4a60-', '8e4c-1f9b3d7a2c58');
const ALNUM = join('01Zq8Tr4Lm2XpB9KwD7c', 'Vn3Hs5Jy6Gt1Rf0PaQeW');
const VRTX = join('toolu_vrtx_', ALNUM.slice(0, 24));
const LONG_TOOLU = join('toolu_', ALNUM);
const TAIL = join('7cVn3Hs5Jy6Gt1', 'Rf0Pa');
const FILE = join('0123456789abcdef', '0123456789abcdef');
const pasted = (segment) => `[compacted] Read(${PASTES}${segment}/${FILE}.txt) - result of 20 chars removed`;
const archived = (name) => `[compacted] Read(x) - result of 20 chars removed; full call and result: ${ARCHIVE}s/${name}.txt`;

const IDS = [
  ['32 hex digits as the session directory of a paste path', pasted(HEX32), HEX32],
  ['a UUID as the session directory of a paste path', pasted(UUID), UUID],
  ['a long toolu id as the session directory of a paste path', pasted(VRTX), VRTX],
  ['a toolu id longer than a host id as the session directory of a paste path', pasted(LONG_TOOLU), LONG_TOOLU],
  ['a toolu id longer than a host id as the name of an archive file', archived(LONG_TOOLU), LONG_TOOLU],
  ['32 hex digits as a tool name', named(HEX32), HEX32],
  ['a UUID as a tool name', named(UUID), UUID],
  ['a long toolu id as a tool name', named(VRTX), VRTX],
  ['a toolu id longer than a host id as a tool name', named(LONG_TOOLU), LONG_TOOLU],
  ['32 hex digits as the tool part of an MCP name', named(`mcp__srv__${HEX32}`), HEX32],
  ['32 hex digits as the server part of an MCP name', named(`mcp__${HEX32}__read`), HEX32],
  ['a UUID as the tool part of an MCP name', named(`mcp__srv__${UUID}`), UUID],
  ['a long toolu id as a part of an MCP name', named(`mcp__srv__${LONG_TOOLU}`), LONG_TOOLU],
  ['32 hex digits behind a toolu id in an MCP name', named(`mcp__toolu_${ALNUM.slice(0, 32)}__${HEX32}`), HEX32],
  ['a prefixed token cut by two underscores in an MCP name', named(join('mcp__srv__s', 'k-proj-Zq8Tr4', '__', ALNUM.slice(8, 38))), ALNUM.slice(8, 38)],
  ['a long mixed string cut by two underscores inside an MCP name', named(join('mcp__server__Zq8Tr4Lm2XpB9KwD', '__', TAIL)), TAIL],
  ['32 hex digits behind three underscores', named(`mcp___${HEX32}`), HEX32],
  ['32 hex digits behind two underscores of a name that is no MCP name', named(`foo__${HEX32}`), HEX32],
  ['a long mixed string cut by two underscores as a tool name', named(join('Zq8Tr4Lm2XpB9KwD', '__', TAIL)), TAIL],
  ...[['sk-', HEX32], [join('gs', 'k_'), HEX32], [join('gh', 'p_'), HEX32], ['sk-', UUID], ['', HEX40]].flatMap(([prefix, body]) => [
    [`${prefix || 'more hex than an id: '}${body.length} characters as a directory`, pasted(`${prefix}${body}`), body],
    [`${prefix || 'more hex than an id: '}${body.length} characters as a tool name`, named(`${prefix}${body}`), body],
  ]),
  ['sk- and 32 hex digits as the tool part of an MCP name', named(`mcp__server__sk-${HEX32}`), HEX32],
  ['sk- and 32 hex digits as the name of an archive file', archived(`sk-${HEX32}`), HEX32],
  ['40 hex digits as the name of an archive file', archived(HEX40), HEX40],
];

// --- token prefixes -------------------------------------------------------------------------------------------------------------------
const SHORT = 'Zq8Tr4Lm2XpB';
const GSK = join('gs', 'k_', SHORT);
const XAI = join('xa', 'i-', SHORT);
const ASIA = join('AS', 'IA', 'QZ7RT4LM2XPB9KWD');
const PREFIXED = [['a gsk_ key', GSK, SHORT], ['an xai- key', XAI, SHORT], ['a temporary AWS key id', ASIA, ASIA.slice(4)]].flatMap(([name, token, body]) => [
  [`${name} in a command`, bash(`curl https://api.example.test/v1?q=${token}`), body],
  [`${name} as a tool name`, named(token), body],
  [`${name} as the name of an archive file`, archived(token), body],
  [`${name} as the session directory of a paste path`, pasted(token), body],
]);

describe('what leaves with a series: no request body and no written file holds the value', () => {
  it.each(IDS)('%s', async (_, line, value) => {
    expectKeptIn(await compact(seriesOf(line)), value);
  });

  it.each(PREFIXED)('%s', async (_, line, value) => {
    expectKeptIn(await compact(seriesOf(line)), value);
  });
});

describe('what leaves with a series: the names of the tools in the numbers about a series', () => {
  it('counts a name a mask changes, or one that is too long, under a neutral name and keeps the others', async () => {
    const names = ['Read', HEX32, `mcp__${UUID}__list`, XAI, 'mcp__claude_ai_Google_Calendar__list_events', 'a'.repeat(201), 'b'.repeat(200)];
    const run = await compact(names.map(named).join('\n'));
    expect(run.record.series).toMatchObject({ series: 2 });
    const [item] = run.asked.filter((x) => x.text.includes('Google_Calendar'));
    expect(item.series.tools).toEqual({ Read: 1, masked_tool: 4, 'mcp__claude_ai_Google_Calendar__list_events': 1, ['b'.repeat(200)]: 1 });
    expect(item.series.calls).toBe(names.length);
  });

  it('counts a name that a mask changes at the start of its trace under the neutral name too', async () => {
    const run = await compact(seriesOf(named('password=')));
    const { tools } = run.asked.find((x) => x.text.includes('file-31.txt')).series;
    expect(Object.keys(tools).sort()).toEqual(['Read', 'masked_tool']);
    expect(tools.masked_tool).toBe(1);
  });
});

describe('what leaves with a series: where an id of the shape a host makes is set aside', () => {
  it.each([
    ['behind a token prefix', `sk-${HEX32}`],
    ['behind a token prefix in a part of an MCP name', `mcp__server__sk-${UUID}`],
    ['a tool use id behind other characters', `x_${VRTX}`],
    ['with more hexadecimal digits after it', HEX40],
    ['a UUID with more characters after it', `${UUID}-tail`],
    ['cut by two underscores out of a name that is no MCP name', join('Zq8Tr4Lm2XpB9KwD', '__', TAIL)],
  ])('a series with a tool name that holds one elsewhere stays whole: %s', async (_, name) => {
    const run = await compact(seriesOf(named(name)));
    expect(run.record.f2.series_question).toMatchObject({ items: 2, secret: 1 });
    expect(run.conversation).toContain(seriesOf(named(name)));
  });

  it.each([
    ['32 hexadecimal digits', HEX32],
    ['a UUID', UUID],
    ['a tool use id', join('toolu_', ALNUM.slice(0, 24))],
    ['a UUID as a part of an MCP name', `mcp__${UUID}__list`],
  ])('a series with a tool name that is one, or has one as a part, merges: %s', async (_, name) => {
    const run = await compact(seriesOf(named(name)));
    expect(run.record.f2.series_question).toMatchObject({ items: 2, secret: 0, answered: 2 });
    expect(run.record.series).toMatchObject({ series: 2, secret: 0 });
  });
});

// --- private paths written with escapes -----------------------------------------------------------------------------------------------
const PRIVATE = { OMC_JEV_COMPACT_PRIVATE_PATHS: '/srv/quarterly-ledger,C:\\Users\\u\\Ledger,/srv/caf\u00e9-books,C:\\data\\ubeef' };
const MARK = 'figures-of-q3';
const ENCODED = [
  ['a URL with %2F', `curl file:///srv%2Fquarterly-ledger%2F${MARK}.csv`],
  ['a URL with %2f in lower case, the whole path', `open %2fsrv%2fquarterly-ledger%2f${MARK}.csv`],
  ['an escaped letter in a URL', `open /srv/quarterly%2Dledger/${MARK}.csv`],
  ['JSON with \\u002f', `echo {"path":"\\u002fsrv\\u002fquarterly-ledger\\u002f${MARK}.csv"}`],
  ['JSON with \\u002F behind two backslashes', `echo {"cmd":"{\\"path\\":\\"\\\\u002Fsrv\\\\u002Fquarterly-ledger\\\\u002F${MARK}.csv\\"}"}`],
  ['a Windows path in a URL', `open C%3A%5CUsers%5Cu%5CLedger%5C${MARK}.txt`],
  ['a Windows path with \\u005c', `echo C:\\u005cUsers\\u005cu\\u005cLedger\\u005c${MARK}.txt`],
  ['a letter beyond ASCII as UTF-8 bytes in a URL', `open %2Fsrv%2Fcaf%C3%A9-books%2F${MARK}.jpg`],
  ['bytes that are no character beside the path', `open %FF%C0%AF%2Fsrv%2Fquarterly-ledger%2F${MARK}.csv`],
  ['a listed path that holds what looks like an escape', `type C:\\data\\ubeef\\${MARK}.txt`],
];

describe('what leaves with a series: a private path of the list written with escapes', () => {
  it.each(ENCODED)('a series that names it is not sent and not written: %s', async (_, command) => {
    const run = await compact(seriesOf(bash(command)), { env: PRIVATE });
    expectKeptIn(run, MARK);
    expect(run.conversation).toContain(bash(command));
  });

  it.each(ENCODED)('a call and its result that name it are not sent and not written: %s', async (_, command) => {
    const run = await compact(calls(31), { env: PRIVATE, steps: (i) => (i === 5 ? [command, `${command}\nsum: ${MARK} ${'x'.repeat(5000)}`] : undefined) });
    expect(run.bodies.length).toBeGreaterThan(0);
    expect({ sent: holds(run.sent, MARK), written: holds(run.written, MARK) }).toEqual({ sent: false, written: false });
  });

  it('a URL with escapes that names no listed path leaves as before', async () => {
    const line = bash(`curl https://example.test/%2Fsrv%2Fpublic-notes%2F${MARK}.csv`);
    const run = await compact(seriesOf(line), { env: PRIVATE });
    expect(run.sent).toContain(MARK);
    expect(run.written).toContain(MARK);
  });

  it('without a list an escaped path is no private path', async () => {
    const run = await compact(seriesOf(bash(ENCODED[0][1])));
    expect(run.sent).toContain(MARK);
    expect(run.written).toContain(MARK);
  });
});

// --- own paths --------------------------------------------------------------------------------------------------------------------------
const LONG_ID = `toolu_bdrk_${ALNUM}.extra.part`;
const SHORT_DIR = archiveSegment('sess.probe.with.dots');
const TOOL_ID = join('toolu_', '01Zq8Tr4Lm2XpB9KwD7cVn3H');
const one = (path) => [path, [path]];
// [name, the path in the trace, the files it names]
const OWN = [
  ['a notification in the archive of a session named by a UUID', ...one(`${ARCHIVE}${UUID}/notification-0123456789abcdef.txt`)],
  ['a long id the archive shortened', ...one(`${ARCHIVE}${UUID}/${archiveSegment(LONG_ID)}.txt`)],
  ['a tool use id in a session directory the archive shortened', ...one(`${ARCHIVE}${SHORT_DIR}/${TOOL_ID}.txt`)],
  ['a shortened id in a shortened session directory', ...one(`${ARCHIVE}${SHORT_DIR}/${archiveSegment(LONG_ID)}.txt`)],
  ['a paste file of a session named by a UUID', ...one(`${PASTES}${UUID}/${HEX32}.txt`)],
  ['a tool use id of another provider', ...one(`${ARCHIVE}${UUID}/toolu_bdrk_01Zq8Tr4Lm2XpB9KwD7cVn3H.txt`)],
  ['the list of a merged line', `${ARCHIVE}${UUID}/ (${TOOL_ID}.txt, ${HEX32}.txt)`, [`${ARCHIVE}${UUID}/${TOOL_ID}.txt`, `${ARCHIVE}${UUID}/${HEX32}.txt`]],
  ['a block file named by its letter', `b/${HEX32}.txt`, [`${PASTES}${SESSION}/${HEX32}.txt`]],
];
const ownLine = (path) => `[compacted] Read(x) - result of 20 chars removed; full call and result: ${path}`;

describe('what leaves with a series: the paths of the module\'s own files', () => {
  it.each(OWN)('the file of a series keeps the path as it was when its files are there: %s', async (_, path, files) => {
    const run = await compact(seriesOf(ownLine(path)), { there: files });
    expect(run.written).toContain(`${ownLine(path)}\n`);
    expect(run.record.series).toMatchObject({ series: 2, secret: 0, timed_out: 0 });
  });

  it.each(OWN)('without its files the path is masked in the written file: %s', async (_, path) => {
    const run = await compact(seriesOf(ownLine(path)));
    expect(run.written).toContain(call(36));
    expect(run.written).not.toContain(path);
    expect(run.record.series).toMatchObject({ series: 2, secret: 0 });
  });

  it.each(OWN)('a path whose file cannot be read is masked: %s', async (_, path, files) => {
    const run = await compact(seriesOf(ownLine(path)), { there: files, broken: files.slice(-1) });
    expect(run.written).toContain(call(36));
    expect(run.written).not.toContain(path);
  });

  it('the list of a merged line stays only when every file of it is there', async () => {
    const [, path, files] = OWN.find(([name]) => name === 'the list of a merged line');
    for (const some of [files.slice(0, 1), files.slice(1)]) {
      const run = await compact(seriesOf(ownLine(path)), { there: some });
      expect(run.written).toContain(call(36));
      expect(run.written).not.toContain(HEX32);
    }
  });

  it('a read that does not come back in time leaves no file with the path: the series stays whole and is counted timed out', async () => {
    const [, path, files] = OWN[0];
    const run = await compact(seriesOf(ownLine(path)), { there: files, hung: files });
    expect(run.asked.map((item) => item.text).join('\n')).toContain('file-36.txt');
    expect(run.written).not.toContain(path);
    expect(run.written).not.toContain(call(36));
    expect(run.conversation).toContain(seriesOf(ownLine(path)));
    expect(run.record.series.timed_out).toBeGreaterThan(0);
  }, 20000);
});
