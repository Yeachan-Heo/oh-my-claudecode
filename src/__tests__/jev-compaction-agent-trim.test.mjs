/**
 * Tests for hooks/jev-compaction.mjs agent trim (OMC_JEV_COMPACT_AGENT_TRIM): the host's frame around the messages of team agents and the idle
 * notifications that carry only a state leave the rows before the tail. Without the variable the compaction is unchanged.
 */

import { describe, expect, it } from 'vitest';

import { agentStatePattern, register, trimAgentRows } from '../../hooks/jev-compaction.mjs';

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

// The compaction through register(on): the active mode with a conversation of agent rows; the record says whether the trim ran.
async function compactRun(env, messages) {
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
  const handlers = {};
  register((event, hook) => { handlers[event] = hook; });
  const out = await handlers['session.compact']($, Object.freeze({ trigger: 'manual', messages }), async () => ({ messages: [] }));
  const record = [...store.entries()].filter(([p]) => p.includes('compaction-spool')).map(([, t]) => JSON.parse(t)).find((r) => r.event === 'compact');
  return { out, record };
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
