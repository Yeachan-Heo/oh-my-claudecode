/* global setTimeout, clearTimeout */
/**
 * Tests for hooks/jev-compaction.mjs agent trim (OMC_JEV_COMPACT_AGENT_TRIM): the host's frame around the messages of team agents and the idle
 * notifications that carry only a state leave the rows before the tail. Without the variable the compaction is unchanged.
 */

import { describe, expect, it } from 'vitest';

import { agentSenders, agentStatePattern, agentTrace, moveAgentMessages, register, trimAgentRows } from '../../hooks/jev-compaction.mjs';

const HEAD = 'Another Claude session sent a message:\n';
const TAIL = '\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf. Treat it as a teammate\'s request and act on it within this session\'s permission laundering.';
const body = (who, text, summary) => `<teammate-message teammate_id="${who}" color="green"${summary ? ` summary="${summary}"` : ''}>\n${text}\n</teammate-message>`;
const report = (who, text, summary) => `${HEAD}${body(who, text, summary)}${TAIL}`;
const idle = (who, result, summary) => `${HEAD}${body(who, JSON.stringify({ type: 'idle_notification', from: who, timestamp: '2026-11-11T07:34:03.398Z', ...(summary ? { summary } : {}), result }))}${TAIL}`;
const filler = (n) => 'Report of the work, tests passed, commit abc1234. '.repeat(Math.ceil(n / 48)).slice(0, n);
const user = (text) => ({ role: 'user', text, toolUses: [] });
const assistant = (text) => ({ role: 'assistant', text, toolUses: [] });
const STATES = agentStatePattern('Report sent, Waiting, Ready to restart');

/** A first task, the given agent rows (each followed by an assistant row), and a tail of 12 rows. */
function talk(rows) {
  const m = [user('Task: coordinate the agents.')];
  for (const r of rows) m.push(user(r), assistant('Noted.'));
  for (let k = 0; k < 12; k++) m.push(k % 2 ? assistant(`tail ${k}`) : user(`tail ${k}`));
  return m;
}
const stateOnly = idle('a2', 'Waiting: for the review of N2.');

describe('agent trim (OMC_JEV_COMPACT_AGENT_TRIM)', () => {
  it('cuts the host frame from a report and keeps the block word for word', () => {
    const r = report('a1', `Report a1: ${filler(500)}`, 'N1 done');
    const { rows, stats } = trimAgentRows(talk([r]), { keepFrom: 10 });
    const out = rows.get(1).text;
    expect(out).toBe(body('a1', `Report a1: ${filler(500)}`, 'N1 done'));
    expect(stats).toMatchObject({ rows: 1, pre: 1, note: 1, chars: r.length - out.length });
  });

  it('removes a row of a state-only idle notification whole, with a configured state phrase', () => {
    const { rows, stats } = trimAgentRows(talk([stateOnly]), { keepFrom: 10, statePattern: STATES });
    expect(rows.get(1)).toMatchObject({ role: 'user', text: '', trimDrop: true });
    expect(stats).toMatchObject({ rows_dropped: 1, idle_removed: 1, chars: stateOnly.length });
  });

  it('keeps a state-only idle notification when no state phrase is configured, but still cuts the frame', () => {
    const { rows } = trimAgentRows(talk([stateOnly]), { keepFrom: 10 });
    expect(rows.get(1).trimDrop).toBeUndefined();
    expect(rows.get(1).text.startsWith('<teammate-message')).toBe(true);
    expect(rows.get(1).text).toContain('Waiting: for the review of N2.');
  });

  it('removes an idle notification with an empty result or one repeating the summary of an earlier report', () => {
    const earlier = report('a1', `Report a1: ${filler(1500)}`, 'N1 done');
    const sentState = idle('a1', 'Report sent.', 'N1 done');
    const empty = idle('a3', '');
    const { rows } = trimAgentRows(talk([earlier, sentState, empty]), { keepFrom: 14, statePattern: STATES });
    expect(rows.get(3).trimDrop).toBe(true);
    expect(rows.get(5).trimDrop).toBe(true);
    expect(rows.has(1)).toBe(true);
  });

  it('keeps an idle notification that is the only carrier of a report', () => {
    const only = idle('a4', `Review N4 done: 2 medium, 3 low, commit b141178. ${filler(400)}`, 'notes for the author');
    const { rows, stats } = trimAgentRows(talk([only]), { keepFrom: 10, statePattern: STATES });
    expect(rows.get(1).trimDrop).toBeUndefined();
    expect(stats.idle_kept).toBe(1);
  });

  it('leaves rows with the owner words, anchored rows and rows the host cannot rebuild from text as they are', () => {
    const quoted = `The user sent a new message while you were working:\n${stateOnly}`;
    const m = talk([quoted, stateOnly, stateOnly]);
    const { rows, stats } = trimAgentRows(m, { keepFrom: 12, statePattern: STATES, skipRows: new Set([5]), queuedRows: new Map([[3, []]]) });
    expect(rows.size).toBe(0);
    expect(stats.anchored).toBe(2);
  });

  it('the row right before the tail keeps its notification without the frame', () => {
    const m = talk([stateOnly]);
    const { rows } = trimAgentRows(m, { keepFrom: 2, statePattern: STATES });
    expect(rows.get(1).trimDrop).toBeUndefined();
    expect(rows.get(1).text.startsWith('<teammate-message')).toBe(true);
    expect(rows.get(1).text).not.toContain('permission laundering');
  });

  it('removes the state block from a row that also carries a report, and keeps the report', () => {
    const mixed = `${HEAD}${body('a6', `Report a6: ${filler(900)}`, 'N6')}\n\n${body('a6', JSON.stringify({ type: 'idle_notification', from: 'a6', timestamp: '2026-11-11T08:00:00Z', result: 'Waiting: for a decision.' }))}${TAIL}`;
    const { rows } = trimAgentRows(talk([mixed]), { keepFrom: 10, statePattern: STATES });
    expect(rows.get(1).text).toBe(body('a6', `Report a6: ${filler(900)}`, 'N6'));
  });

  it('removes an idle notification whose result is found whole in the agent earlier messages, and keeps a different long one', () => {
    const earlier = report('a1', `Report a1: ${filler(1500)}`, 'N1 done');
    const dup = idle('a1', `Report a1: ${filler(300)}`);
    const other = idle('a1', `Another closing text ${filler(300)}`, 'N1 done');
    const { rows } = trimAgentRows(talk([earlier, dup, other]), { keepFrom: 14, statePattern: STATES });
    expect(rows.get(3).trimDrop).toBe(true);
    expect(rows.get(5).trimDrop).toBeUndefined();
  });

  it('a row opening with an agent-message block keeps the host header after the frame is cut', () => {
    const agent = `${HEAD}<agent-message from="a9">\n${filler(300)}\n</agent-message>${TAIL}`;
    const { rows } = trimAgentRows(talk([agent]), { keepFrom: 10 });
    expect(rows.get(1).text.startsWith(HEAD)).toBe(true);
    expect(rows.get(1).text).not.toContain('permission laundering');
  });
});

describe('agent senders: the attributes of a block are read in linear time', () => {
  it('reads a header of 58 000 characters of one name run, with and without a value after it, in well under a second', () => {
    for (const header of ['a'.repeat(58000), `${'a-'.repeat(29000)} teammate_id="a1"`]) {
      const row = `<teammate-message ${header}>\nBody.\n</teammate-message>`;
      const started = Date.now();
      const senders = agentSenders(row);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(senders).toHaveLength(1);
    }
    expect(agentSenders('<teammate-message teammate_id="a1" summary="done">x</teammate-message>')[0]).toMatchObject({ who: 'a1' });
  });
});

describe('agent trim: the search of an agent\'s earlier messages is bounded', () => {
  // Fifteen reports of 58 000 characters of one letter, then many short idle notifications whose result is nearly that text but never inside it:
  // each one is searched for in everything the agent has said (about 870 000 characters).
  const rows = () => {
    const m = [user('Task: coordinate the agents.')];
    for (let k = 0; k < 15; k++) m.push(user(report('a1', 'a'.repeat(58000), `N${k} done`)), assistant('Noted.'));
    for (let k = 0; k < 2000; k++) m.push(user(idle('a1', `${'a'.repeat(39)}b`)));
    for (let k = 0; k < 12; k++) m.push(k % 2 ? assistant(`tail ${k}`) : user(`tail ${k}`));
    return m;
  };

  it('stays within a few seconds on rows that match nothing (it took 9 s without the bound), and still finds a duplicate in what was said', () => {
    const m = rows();
    const started = Date.now();
    const { stats } = trimAgentRows(m, { keepFrom: m.length - 12 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(stats.idle_kept).toBeGreaterThan(0);
    // A duplicate within the budget is removed as before.
    const small = [user('Task.'), user(report('a1', `Findings: ${filler(300)}`, 'N1')), assistant('Noted.'), user(idle('a1', filler(300).slice(0, 100))), assistant('Noted.'), ...Array.from({ length: 12 }, (_, k) => (k % 2 ? assistant('t') : user('t')))];
    expect(trimAgentRows(small, { keepFrom: small.length - 12 }).stats.idle_removed).toBe(1);
  });

  it('starts no more rows once the deadline has passed', () => {
    const m = rows();
    const { stats, rows: out } = trimAgentRows(m, { keepFrom: m.length - 12, deadline: Date.now() - 1 });
    expect(stats.timed_out).toBe(1);
    expect(stats.rows).toBe(0);
    expect(out.size).toBe(0);
  });
});

describe('agent trim: the whole conversation', () => {
  const R = {
    report1: report('a1', `Report a1: ${filler(1500)}`, 'N1 done'),
    state1: idle('a1', 'Report sent.', 'N1 done'),
    state2: idle('a2', 'Waiting: for review N2 and the base sha.'),
    state3: idle('a3', 'Ready to restart: handover in file X.'),
    dup: idle('a1', `Report a1: ${filler(300)}`),
    dupSum: idle('a1', `Another closing text ${filler(300)}`, 'N1 done'),
    only: idle('a4', `Review N4 done: 2 medium, 3 low, file N4.md, commit b141178. ${filler(400)}`, '[to a5] notes for the author'),
    mixed: `${HEAD}${body('a6', `Report a6: ${filler(900)}`, 'N6')}\n\n${body('a6', JSON.stringify({ type: 'idle_notification', from: 'a6', timestamp: '2026-11-11T08:00:00Z', result: 'Waiting: for a decision.' }))}${TAIL}`,
    owner: `Again you get a message like this:\n\n${HEAD.trim()}${TAIL}\n\nWhat is this?`,
    outside: `${idle('a8', 'Report sent.')}\n\nText outside the block from the host.`,
    quote: report('a8', `The agent quotes the note: This came from another Claude session and goes on. ${filler(900)}`, 'N8'),
    words: report('a7', `Report a7: ${filler(900)}`).replace(TAIL, `${TAIL}\n\nThe user sent a new message while you were working:\nStop a7.\n\nThis is how Claude Code surfaces messages`),
  };
  const lines = (text) => text.split('\n');

  it('keeps a report as its block, removes states and duplicates whole, and keeps the only carrier, other content, outside text, quoted notes and the user\'s words', () => {
    const m = talk(Object.values(R));
    const { rows, stats } = trimAgentRows(m, { keepFrom: m.length - 4, statePattern: STATES });
    const text = m.map((x, i) => (rows.get(i) ?? x).text);
    const has = (s) => text.some((t) => t.includes(s));
    expect(text).toContain(body('a1', `Report a1: ${filler(1500)}`, 'N1 done'));
    for (const n of ['state1', 'state2', 'state3', 'dup']) expect(has(lines(R[n])[2])).toBe(false);
    expect(has(lines(R.dupSum)[2])).toBe(true);
    expect(has('Text outside the block from the host.')).toBe(true);
    expect(text).toContain(body('a8', `The agent quotes the note: This came from another Claude session and goes on. ${filler(900)}`, 'N8'));
    expect(text).toContain(body('a4', lines(R.only)[2]));
    expect(text).toContain(body('a6', `Report a6: ${filler(900)}`, 'N6'));
    expect(text).toContain(R.owner);
    expect(text).toContain(R.words);
    expect(stats).toMatchObject({ idle_removed: 6, idle_kept: 2, rows_dropped: 4 });
  });

  it('cuts the note after a cross-session or agent message too, and keeps the header when the row would open with another kind of block', () => {
    const cross = (n) => `${HEAD}<cross-session-message from="bridge:${n}" from-name="Session ${n}">\nMessage ${n}: ${filler(900)}\n</cross-session-message>${TAIL}`;
    const agentM = (n) => `${HEAD}<agent-message from="helper-${n}">\nResult ${n}: ${filler(900)}\n</agent-message>${TAIL}`;
    const mixed = `${HEAD}${body('s1', JSON.stringify({ type: 'idle_notification', from: 's1', timestamp: '2026-11-11T07:00:00Z', idleReason: 'available', result: 'Waiting.' }))}\n\n<agent-message from="helper-m">\nResult mixed: ${filler(900)}\n</agent-message>${TAIL}`;
    const rowsIn = [];
    for (let n = 1; n <= 6; n++) rowsIn.push(cross(n), agentM(n));
    rowsIn.push(mixed, report('a7', `Report 7: ${filler(900)}`));
    const m = talk(rowsIn);
    const { rows, stats } = trimAgentRows(m, { keepFrom: m.length - 4, statePattern: STATES });
    expect(stats.note).toBeGreaterThanOrEqual(13);
    const rebuilt = [...rows.values()];
    expect(rebuilt.every((x) => !x.text.includes('This came from'))).toBe(true);
    const mix = rebuilt.find((x) => x.text.includes('Result mixed'));
    expect(mix.text.startsWith(`${HEAD}<agent-message`)).toBe(true);
    expect(mix.text).not.toContain('idle_notification');
    expect(rebuilt.filter((x) => x.text.startsWith(HEAD)).every((x) => !/^Another Claude session sent a message:\s*<teammate-message/.test(x.text))).toBe(true);
  });

  it('a subagent compaction (agentId) is unchanged: no trim stats, the frame stays', async () => {
    const m = [...talk([stateOnly, report('a1', `Report a1: ${filler(600)}`, 'N1 done')])];
    m.splice(1, 0, { role: 'assistant', text: 'Read.', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'cat a.txt' } }] }, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: `RESULT ${'x'.repeat(30000)}`, isError: false }] });
    const frozen = m.map((x, k) => Object.freeze({ ...x, handle: `h${k}` }));
    const { out, record } = await compactRun({ OMC_JEV_COMPACT_AGENT_TRIM: '1' }, frozen, { agentId: 'sub-1' });
    expect(record).not.toHaveProperty('agent_trim');
    expect(record).not.toHaveProperty('agent_messages');
    expect(JSON.stringify(out.messages ?? [])).not.toContain('moved at compaction, not from the user');
  });
});

// The compaction through register(on): the active mode with a conversation of agent rows; the record says whether the trim ran.
function hostOf(env, messages) {
  const store = new Map();
  const e = { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'test-key', HOME: '/home/u', ...env };
  const api = [];
  for (const m of messages) {
    const content = m.role === 'assistant'
      ? [{ type: 'text', text: m.text }, ...m.toolUses.map((u) => ({ type: 'tool_use', id: u.tool_use_id, name: u.tool, input: u.input }))]
      : [...(m.toolResults || []).map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.text })), ...(m.text ? [{ type: 'text', text: m.text }] : [])];
    if (m.role === 'user' && api[api.length - 1]?.role === 'user') api[api.length - 1].content.push(...content); else api.push({ role: m.role, content });
  }
  const $ = {
    env: { get: async (n) => e[n] },
    settings: { read: async () => undefined },
    fs: { read: async (p) => { if (!store.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return store.get(p); }, exists: async (p) => store.has(p), stat: async () => ({ kind: 'file', size: 1, mtimeMs: Date.now(), isLink: false }), write: async (p, t) => { store.set(p, t); }, list: async () => [] },
    http: { fetch: async (url, init) => { const b = JSON.parse(init.body); return { ok: true, status: 200, headers: {}, text: JSON.stringify({ answers: Object.fromEntries(Object.keys(b.questions).map((q) => [q, { type: 'score', score: 0, confidence: 0.9 }])) }) }; } },
    clock: { after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; }, sleep: async () => { throw new Error('sleep'); } },
    session: { id: async () => 'sess-trim', usage: async () => ({ context: { tokens: 130000, window: 200000 } }), messages: async (o) => (o?.as === 'api' ? api : messages), compact: async () => ({}) },
    ui: { log: () => {}, toast: () => {} },
  };
  return { $, store };
}

async function compactRun(env, messages, event = {}) {
  const { $, store } = hostOf(env, messages);
  const handlers = {};
  register((event, hook) => { handlers[event] = hook; });
  const out = await handlers['session.compact']($, Object.freeze({ trigger: 'manual', messages, ...event }), async () => ({ messages: [] }));
  const record = [...store.entries()].filter(([p]) => p.includes('compaction-spool')).map(([, t]) => JSON.parse(t)).find((r) => r.event === 'compact');
  return { out, record, store };
}

// The own threshold: a turn ends at 130 000 of 200 000 tokens; the host compacts with the trigger `plugin` when it is asked. Returns what the host was asked.
async function ownRun(env, messages) {
  const { $, store } = hostOf({ OMC_JEV_COMPACT_AT_PERCENT: '60', ...env }, messages);
  const handlers = {};
  register((event, hook) => { handlers[event] = hook; });
  const asked = [];
  $.session.compact = async () => {
    const out = await handlers['session.compact']($, Object.freeze({ trigger: 'plugin', messages }), async () => ({ messages: [] }));
    asked.push(out);
    return out;
  };
  await handlers['turn.complete']($, { isAborted: false }, async () => 'ok');
  return { asked, store };
}

describe('agent trim in the compaction', () => {
  const rows = [stateOnly, report('a1', `Report a1: ${filler(600)}`, 'N1 done'), stateOnly];
  const messages = () => {
    const m = talk(rows);
    // A result carrying text to cut, so the compaction has something to do.
    m.splice(1, 0, { role: 'assistant', text: 'Read.', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'cat a.txt' } }] }, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: `RESULT ${'x'.repeat(30000)}`, isError: false }] });
    return m.map((x, k) => Object.freeze({ ...x, handle: `h${k}` }));
  };

  it('without the variable the rows are not trimmed and the record has no trim stats', async () => {
    const { out, record } = await compactRun({}, messages());
    expect(record).not.toHaveProperty('agent_trim');
    expect(JSON.stringify(out.messages)).toContain('permission laundering');
  });

  it('with the variable the frame and the state rows go, and the record carries the stats', async () => {
    const { out, record } = await compactRun({ OMC_JEV_COMPACT_AGENT_TRIM: '1', OMC_JEV_COMPACT_AGENT_STATES: 'Waiting' }, messages());
    expect(record).toMatchObject({ result: 'jev' });
    expect(record.agent_trim).toMatchObject({ rows: 3, rows_dropped: 2 });
    expect(JSON.stringify(out.messages)).not.toContain('permission laundering');
    expect(JSON.stringify(out.messages)).toContain('Report a1:');
  });
});

// Agent messages to files (the same variable): an older agent row moves whole to a file and a one-line trace takes its place.
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nKEYBODY-1\n-----END RSA PRIVATE KEY-----';
const CFG = { pasteDir: '/state/compaction-pastes', privatePaths: [] };
const KEEP = new Set();
function fakeHost(failWrite = false) {
  const files = new Map();
  const $ = {
    clock: { after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; }, sleep: async () => {} },
    fs: {
      read: async (p) => { if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(p); },
      write: async (p, t) => { if (failWrite) throw new Error('EIO'); files.set(p, t); },
    },
  };
  return { files, $ };
}
const rowsOf = (n, make) => Array.from({ length: n }, (_, k) => make(k));
const longReport = (k, who = 'a1') => report(who, `Report ${k}: ${filler(1200)}`, `N${k} done`);
const run = (host, messages, extra = {}) => moveAgentMessages(host.$, CFG, messages, { sessionId: 'sess-1', skipRows: KEEP, keepFrom: messages.length - 12, ...extra });

describe('agent messages to files', () => {
  it('moves the older agent rows whole to a file, keeps the last six, and leaves a trace that says the row is not the user\'s', async () => {
    const host = fakeHost();
    const m = talk(rowsOf(8, (k) => longReport(k)));
    const { rows, stats } = await run(host, m);
    expect([...rows.keys()]).toEqual([1, 3]);
    expect(stats).toMatchObject({ mode: 'active', agent_rows: 8, limit_row: 5, kept_last: 6, moved: 2, written: 2, moved_chars: m[1].text.length + m[3].text.length });
    const row = rows.get(1);
    expect(row).toMatchObject({ role: 'user', toolUses: [] });
    expect(row.handle).toBeUndefined();
    expect(row.text.startsWith('[agent message moved at compaction, not from the user: /state/compaction-pastes/sess-1/')).toBe(true);
    expect(row.text).toContain(`(${m[1].text.length} chars, `);
    expect(row.text).toContain('from a1');
    expect(row.text).toContain('"N0 done"');
    const path = /: (\/state\/[^ ]+) \(/.exec(row.text)[1];
    expect(host.files.get(path)).toBe(m[1].text);
    expect(stats.trace_chars).toBe(row.text.length + rows.get(3).text.length);
  });

  it('plans without writing when write is false', async () => {
    const host = fakeHost();
    const { rows, stats } = await run(host, talk(rowsOf(8, (k) => longReport(k))), { write: false });
    expect(rows.size).toBe(0);
    expect(host.files.size).toBe(0);
    expect(stats).toMatchObject({ mode: 'plan', moved: 2, written: 0 });
  });

  it('keeps the first row, the lead\'s rows, rows with the user\'s words, pending requests, short rows and rows with a secret', async () => {
    const host = fakeHost();
    const pending = report('a3', JSON.stringify({ type: 'permission_request', request_id: 'r1', note: filler(900) }));
    const rowsIn = [
      longReport(1, 'team-lead'), `${longReport(2)}\n\nThe user sent a new message while you were working:\nplease also check N9`, pending, report('a4', 'short'),
      report('a5', `Report with a key ${PEM} ${filler(900)}`), longReport(6), ...rowsOf(6, (k) => longReport(10 + k)),
    ];
    const { rows, stats } = await run(host, talk(rowsIn));
    expect(stats).toMatchObject({ lead: 1, owner_words: 1, pending_json: 1, too_short: 1, secret: 1, moved: 1 });
    expect([...rows.keys()]).toEqual([11]);
  });

  it('keeps a row whose trace would carry a secret', async () => {
    const host = fakeHost();
    const withKey = report('a1', filler(1200), PEM);
    const { rows, stats } = await run(host, talk([withKey, ...rowsOf(6, (k) => longReport(k))]));
    expect(rows.size).toBe(0);
    expect(stats.secret).toBe(1);
  });

  it('a row of state-only idle notifications takes no place among the last six', async () => {
    const host = fakeHost();
    const states = rowsOf(3, () => idle('a2', 'Waiting: for the review.'));
    const m = talk([longReport(1), longReport(2), ...rowsOf(6, (k) => longReport(10 + k)), ...states]);
    const { stats } = await run(host, m, { statePattern: STATES });
    expect(stats).toMatchObject({ agent_rows: 11, limit_row: 5, moved: 2 });
  });

  it('keeps every row when a row of the API form cannot be rebuilt from text, and when there is no API form', async () => {
    const host = fakeHost();
    const m = talk(rowsOf(8, (k) => longReport(k)));
    expect((await run(host, m, { skipRows: Object.assign(new Set(), { unmatched: 1 }) })).stats).toMatchObject({ reason: 'image_unmatched', moved: 0 });
    expect((await run(host, m, { skipRows: undefined })).stats).toMatchObject({ reason: 'no_api_form', moved: 0 });
    expect((await run(host, m, { skipRows: new Set([1]) })).stats).toMatchObject({ skipped_blocks: 1, moved: 1 });
    expect(host.files.size).toBe(1);
  });

  it('a row stays when its file cannot be written, and an identical file counts as reused', async () => {
    const m = talk(rowsOf(8, (k) => longReport(k)));
    const bad = await run(fakeHost(true), m);
    expect(bad.rows.size).toBe(0);
    expect(bad.stats).toMatchObject({ write_failed: 2, moved: 0 });
    const host = fakeHost();
    await run(host, m);
    const again = await run(host, m);
    expect(again.stats).toMatchObject({ reused: 2, written: 0, moved: 2 });
  });

  it('reads senders, time and summary of each block', () => {
    const text = `${HEAD}${body('a1', 'Done.', 'first')}\n\n${body('a2', JSON.stringify({ type: 'idle_notification', from: 'a2', timestamp: '2026-11-11T07:34:03.398Z', summary: 'sent N5', result: 'Waiting: for N6.' }))}`;
    const senders = agentSenders(text, STATES);
    expect(senders.map((x) => x.who)).toEqual(['a1', 'a2']);
    expect(senders[1]).toMatchObject({ idle: true, state: true, sent: 'sent N5', when: '2026-11-11T07:34:03.398Z' });
    const trace = agentTrace('/p/f.txt', text, STATES);
    expect(trace).toContain('from a2 (idle, last: "sent N5"), 2026-11-11 07:34:03 UTC: "Waiting: for N6."');
    expect(trace.endsWith(']')).toBe(true);
  });
});

describe('agent messages to files in the compaction', () => {
  const agentRows = rowsOf(8, (k) => longReport(k));
  const messages = () => {
    const m = talk(agentRows);
    m.splice(1, 0, { role: 'assistant', text: 'Read.', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'cat a.txt' } }] }, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: `RESULT ${'x'.repeat(30000)}`, isError: false }] });
    return m.map((x, k) => Object.freeze({ ...x, handle: `h${k}` }));
  };
  const spilled = (store) => [...store.keys()].filter((p) => p.includes('/compaction-pastes/'));

  it('without the variable no row moves and the record has no stats', async () => {
    const { out, record, store } = await compactRun({}, messages());
    expect(record).not.toHaveProperty('agent_messages');
    expect(spilled(store)).toHaveLength(0);
    expect(JSON.stringify(out.messages)).toContain('Report 0:');
  });

  it('with the variable the older reports go to files and the rows carry traces', async () => {
    const { out, record, store } = await compactRun({ OMC_JEV_COMPACT_AGENT_TRIM: '1' }, messages());
    expect(record.result).toBe('jev');
    expect(record.agent_messages).toMatchObject({ mode: 'active', moved: 2, written: 2, installed: true });
    expect(spilled(store)).toHaveLength(2);
    const text = JSON.stringify(out.messages);
    expect(text).not.toContain('Report 0:');
    expect(text).toContain('[agent message moved at compaction, not from the user: ');
    expect(text).toContain('Report 7:');
  });

  it('a row with words of someone else after its closing tag stays whole in the conversation: it is no agent row to move, and the instruction is not lost', async () => {
    const instruction = 'Do not change the production database.';
    const rows = [`${longReport(0)}\n${instruction}`, ...agentRows.slice(1)];
    const m = talk(rows);
    m.splice(1, 0, { role: 'assistant', text: 'Read.', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'cat a.txt' } }] }, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: `RESULT ${'x'.repeat(30000)}`, isError: false }] });
    const { out, record, store } = await compactRun({ OMC_JEV_COMPACT_AGENT_TRIM: '1' }, m.map((x, k) => Object.freeze({ ...x, handle: `h${k}` })));
    expect(record.agent_messages).toMatchObject({ moved: 1, owner_words: 1 });
    expect(spilled(store)).toHaveLength(1);
    expect(JSON.stringify(out.messages)).toContain(instruction);
    expect(JSON.stringify(out.messages)).toContain('Report 0:');
  });

  it('through the token cascade the floor counts the files and their saving comes off the prediction', async () => {
    const env = { OMC_JEV_COMPACT_TARGET_PERCENT: '20' };
    const off = await compactRun(env, messages());
    const on = await compactRun({ ...env, OMC_JEV_COMPACT_AGENT_TRIM: '1' }, messages());
    expect(on.record).toMatchObject({ result: 'jev', agent_messages: { moved: 2, installed: true } });
    expect(on.record.floor_agents_tokens).toBeGreaterThan(0);
    const st = on.record.agent_messages;
    const saved = 0.43 * on.record.agent_trim.chars + 0.455 * st.moved_chars - 0.58 * st.trace_chars;
    expect(Math.abs(off.record.tokens_after_pred - on.record.tokens_after_pred - saved)).toBeLessThanOrEqual(1);
  });

  it('predicts the trimmed frame at RATE_ATT, which OMC_JEV_COMPACT_RATES sets', async () => {
    const env = { OMC_JEV_COMPACT_TARGET_PERCENT: '20', OMC_JEV_COMPACT_AGENT_TRIM: '1' };
    const byDefault = await compactRun(env, messages());
    const doubled = await compactRun({ ...env, OMC_JEV_COMPACT_RATES: '{"RATE_ATT":0.86}' }, messages());
    const chars = byDefault.record.agent_trim.chars;
    expect(chars).toBeGreaterThan(0);
    expect(doubled.record.agent_trim.chars).toBe(chars);
    // Only the trim's rate changed: the prediction falls by the extra 0.43 tokens per character of the frame (rounded once at the end).
    expect(Math.abs(byDefault.record.tokens_after_pred - doubled.record.tokens_after_pred - 0.43 * chars)).toBeLessThanOrEqual(1);
  });

  it('with the point in shadow mode the stage only plans: no file, no change', async () => {
    const { record, store } = await compactRun({ OMC_JEV: 'compaction:shadow', OMC_JEV_COMPACT_AGENT_TRIM: '1' }, messages());
    expect(record.agent_messages).toMatchObject({ mode: 'plan', moved: 2, written: 0 });
    expect(spilled(store)).toHaveLength(0);
  });

  it('a compaction that the cascade then rejects (host handoff, the cut under the host minimum) leaves the files written but does not say the stage is installed', async () => {
    const env = { OMC_JEV_COMPACT_TARGET_PERCENT: '20', OMC_JEV_COMPACT_AGENT_TRIM: '1', OMC_JEV_COMPACT_HOST_HANDOFF: '1' };
    const { out, record, store } = await compactRun(env, messages());
    expect(record).toMatchObject({ result: 'fallback', reason: 'cut_below_host_min', agent_messages: { moved: 2, written: 2, installed: false } });
    expect(spilled(store)).toHaveLength(2);
    expect(JSON.stringify(out.messages)).not.toContain('[agent message moved at compaction');
    // The same session without the handoff veto is installed, and says so.
    const accepted = await compactRun({ ...env, OMC_JEV_COMPACT_HOST_HANDOFF: '' }, messages());
    expect(accepted.record).toMatchObject({ result: 'jev', agent_messages: { installed: true } });
  });

  // Many long reports and results that each cut little: the results alone give back under the bound of the too-few-results gate, the reports moved to files do the rest.
  const reportHeavy = () => {
    const m = [user('Task: coordinate the agents.')];
    for (let k = 0; k < 24; k++) {
      m.push(user(report('a1', `Report ${k}: ${filler(11000)}`, `N${k} done`)), assistant('Noted.'));
      if (k < 23) {
        m.push({ role: 'assistant', text: 'Read.', toolUses: [{ tool_use_id: `t${k}`, tool: 'Bash', input: { command: `cat a${k}.txt` } }] });
        m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${k}`, text: `RESULT ${k} ${'x'.repeat(3000)}`, isError: false }] });
      }
    }
    for (let k = 0; k < 12; k++) m.push(k % 2 ? assistant(`tail ${k}`) : user(`tail ${k}`));
    return m.map((x, k) => Object.freeze({ ...x, handle: `h${k}` }));
  };

  it('with the token cascade the gate counts what the agent stage saves: reports that carry the cut are not handed to the summary for the results alone', async () => {
    const env = { OMC_JEV_COMPACT_TARGET_PERCENT: '20' };
    // The results alone are short of the bound, so without the stage the summary runs.
    const off = await compactRun(env, reportHeavy(), { trigger: 'auto' });
    expect(off.record).toMatchObject({ result: 'fallback', reason: 'too_few_results' });
    expect(off.record.max_reduction_tokens).toBeLessThan(0.3);
    const on = await compactRun({ ...env, OMC_JEV_COMPACT_AGENT_TRIM: '1' }, reportHeavy(), { trigger: 'auto' });
    expect(on.record).toMatchObject({ result: 'jev', agent_messages: { installed: true } });
    expect(on.record.agent_messages.moved).toBeGreaterThan(0);
    expect(on.record.max_reduction_tokens).toBeGreaterThanOrEqual(0.3);
    expect(spilled(on.store).length).toBe(on.record.agent_messages.moved);
  });

  it('the own threshold counts the agent stage too: a session of reports that no result carries is still asked to compact, and one the stage cannot help is not', async () => {
    const env = { OMC_JEV_COMPACT_TARGET_PERCENT: '20' };
    // The results alone are too little (the same session as the gate above), so without the stage the request is not made.
    expect((await ownRun(env, reportHeavy())).asked).toHaveLength(0);
    const on = await ownRun({ ...env, OMC_JEV_COMPACT_AGENT_TRIM: '1' }, reportHeavy());
    expect(on.asked).toHaveLength(1);
    expect(on.asked[0]).toHaveProperty('messages');
    expect(spilled(on.store).length).toBeGreaterThan(0);
    // A stage in shadow mode moves nothing, so it carries nothing.
    expect((await ownRun({ ...env, OMC_JEV: 'compaction:shadow', OMC_JEV_COMPACT_AGENT_TRIM: '1' }, reportHeavy())).asked).toHaveLength(0);
  });

  it('a stage in shadow mode saves nothing, so the gate still hands a session of short results to the summary', async () => {
    const { record, store } = await compactRun({ OMC_JEV: 'compaction:shadow', OMC_JEV_COMPACT_TARGET_PERCENT: '20', OMC_JEV_COMPACT_AGENT_TRIM: '1' }, reportHeavy(), { trigger: 'auto' });
    expect(record).toMatchObject({ result: 'fallback', reason: 'too_few_results' });
    expect(spilled(store)).toHaveLength(0);
  });
});

// Only the host's outer frame leaves a report: a report that quotes a whole envelope (its header, its block and its note) keeps the quoted copy as written.
const KINDS = ['teammate-message', 'agent-message', 'cross-session-message'];
const ATTRS = {
  'teammate-message': (who) => `teammate_id="${who}" color="green"`,
  'agent-message': (who) => `from="${who}"`,
  'cross-session-message': (who) => `from="bridge:${who}" from-name="Session ${who}"`,
};
const envelope = (kind, who, text) => `${HEAD}<${kind} ${ATTRS[kind](who)}>\n${text}\n</${kind}>${TAIL}`;
const QUOTING = {
  plain: (q) => q,
  fenced: (q) => `\`\`\`\n${q}\n\`\`\``,
  blockquote: (q) => q.split('\n').map((l) => `> ${l}`).join('\n'),
};
const reportQuoting = (kind, quoted, style) => `<${kind} ${ATTRS[kind]('a1')}>\nDiagnosis of the framing, the delivery was:\n${QUOTING[style](quoted)}\nEnd of the report.\n</${kind}>`;
const trimmed = (m, keepFrom = 10) => { const { rows, stats } = trimAgentRows(m, { keepFrom }); return { rows, stats, text: (i) => (rows.get(i) ?? m[i]).text }; };

describe('agent trim keeps the text of a report as written', () => {
  const grid = [];
  for (const outer of KINDS) for (const inner of KINDS) for (const style of Object.keys(QUOTING)) for (const framed of [true, false]) {
    if (!framed && outer !== 'teammate-message') continue; // a row that opens with another block has no frame of the host: it is the user's words
    grid.push([outer, inner, style, framed]);
  }

  it.each(grid)('report of kind %s quoting a %s envelope (%s), outer frame: %s', (outer, inner, style, framed) => {
    const quoted = envelope(inner, 'q1', 'Quoted message with its own header and note.');
    const block = reportQuoting(outer, quoted, style);
    const row = framed ? `${HEAD}${block}${TAIL}` : block;
    const t = trimmed(talk([row]));
    const expected = outer === 'teammate-message' ? block : `${HEAD}${block}`; // a row that would open with another block keeps the host's header
    expect(t.text(1)).toBe(expected);
    expect(t.text(1)).toContain(QUOTING[style](quoted));
    expect(t.stats).toMatchObject({ rows: 1, unbalanced: 0 });
    expect(t.stats.note).toBe(framed ? 1 : 0);
  });

  it('cuts the frame of each of two blocks in a row and the blank space between them, and nothing inside them', () => {
    const quoted = envelope('teammate-message', 'q1', 'Quoted.');
    const row = `${HEAD}${body('a1', `Report a1 quotes:\n${quoted}`)}${TAIL}\n\n${HEAD}${body('a2', 'Report a2.')}${TAIL}`;
    const t = trimmed(talk([row]));
    expect(t.text(1)).toBe(`${body('a1', `Report a1 quotes:\n${quoted}`)}\n\n${body('a2', 'Report a2.')}`);
  });

  it('leaves a row with a tag that has no partner as it is, and counts it', () => {
    for (const stray of [`${HEAD}${body('a1', 'Report.')}</teammate-message>${TAIL}`, `${HEAD}${body('a1', 'Report.')}${TAIL}\n<agent-message from="a2">`, `${HEAD}<teammate-message teammate_id="a1">Report</agent-message>${TAIL}`]) {
      const t = trimmed(talk([stray]));
      expect(t.rows.size).toBe(0);
      expect(t.stats).toMatchObject({ rows: 0, unbalanced: 1 });
    }
  });

  it('removes an idle notification that stands outside every block, and keeps one that a report quotes', () => {
    const quotedIdle = body('a2', JSON.stringify({ type: 'idle_notification', from: 'a2', timestamp: '2026-11-11T07:34:03.398Z', result: '' }));
    const t = trimmed(talk([`${HEAD}${body('a1', `Report quoting an idle notification:\n${quotedIdle}`)}${TAIL}`, idle('a2', '')]));
    expect(t.text(1)).toBe(body('a1', `Report quoting an idle notification:\n${quotedIdle}`));
    expect(t.rows.get(3)).toMatchObject({ trimDrop: true });
  });

  it('moves the row to the file as it came, not as the trim left it, and counts the tokens of the trimmed row', async () => {
    const quoted = envelope('teammate-message', 'q1', `Quoted: ${filler(300)}`);
    const original = report('a1', `Report that quotes:\n\`\`\`\n${quoted}\n\`\`\`\n${filler(900)}`, 'N1 done');
    const messages = talk([original, ...rowsOf(6, (k) => longReport(k))]);
    const trim = trimAgentRows(messages, { keepFrom: messages.length - 12 });
    const after = messages.map((m, i) => trim.rows.get(i) ?? m);
    expect(after[1].text.length).toBeLessThan(original.length);
    const host = fakeHost();
    const { rows, stats } = await run(host, after, { source: messages });
    expect([...rows.keys()]).toEqual([1]);
    const path = /: (\/state\/[^ ]+) \(/.exec(rows.get(1).text)[1];
    expect(host.files.get(path)).toBe(original);
    expect(rows.get(1).text).toContain(`(${original.length} chars, `);
    expect(stats.moved_chars).toBe(after[1].text.length);
  });

  it('a row that quotes an opener without its closing tag is no agent row: not trimmed, not moved, and never taken for the quoted sender', async () => {
    const stray = `${HEAD}<teammate-message teammate_id="a1">\nSaw <teammate-message teammate_id="q9"> with no end. ${filler(900)}\n</teammate-message>${TAIL}`;
    const messages = talk([stray, ...rowsOf(6, (k) => longReport(k))]);
    const trim = trimAgentRows(messages, { keepFrom: messages.length - 12 });
    expect(trim.rows.has(1)).toBe(false);
    expect(trim.stats.unbalanced).toBe(1);
    const { rows, stats } = await run(fakeHost(), messages, { source: messages });
    expect(rows.has(1)).toBe(false);
    expect(stats).toMatchObject({ agent_rows: 6, moved: 0 });
  });
});
