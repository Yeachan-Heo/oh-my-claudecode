/**
 * Tests for hooks/jev-compaction.mjs background task notifications as candidates (OMC_JEV_COMPACT_NOTIFICATIONS): a notification row before the tail
 * is scored by Jev and kept, cut or removed with a trace. Without the variable the compaction is unchanged.
 */

import { describe, expect, it } from 'vitest';

import { isNotification, register } from '../../hooks/jev-compaction.mjs';

const note = (name, text) => `<system-reminder>\n<tools-used-before-summary>Bash</tools-used-before-summary>\n</system-reminder>\n<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "${name}" finished</summary>\n<result>${text}</result>\n</task-notification>\n</system-reminder>`;
const bare = (text) => `<task-notification>\n<task-id>b2</task-id>\n<status>completed</status>\n<summary>Agent "bare" finished</summary>\n<result>${text}</result>\n</task-notification>`;
const row = (text, extra = {}) => ({ role: 'user', text, toolUses: [], ...extra });
const user = (text) => row(text);
const assistant = (text) => ({ role: 'assistant', text, toolUses: [] });
const talk = (n) => Array.from({ length: n }, (_, k) => (k % 2 ? assistant(`Answer ${k}.`) : user(`Question ${k}.`)));

// One compaction through register(on) in the active mode; Jev scores every result 0; the bodies of its requests are kept.
async function compactRun(env, messages, { tokens = 30000 } = {}) {
  const store = new Map();
  const bodies = [];
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
    http: { fetch: async (url, init) => { const b = JSON.parse(init.body); bodies.push(init.body); return { ok: true, status: 200, headers: {}, text: JSON.stringify({ answers: Object.fromEntries(Object.keys(b.questions).map((q) => [q, { type: 'score', score: 0, confidence: 0.9 }])) }) }; } },
    clock: { after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; }, sleep: async () => { throw new Error('sleep'); } },
    session: { id: async () => 'sess-note', usage: async () => ({ context: { tokens, window: 200000 } }), messages: async (o) => (o?.as === 'api' ? api : messages), compact: async () => ({}) },
    ui: { log: () => {}, toast: () => {} },
  };
  const handlers = {};
  register((event, hook) => { handlers[event] = hook; });
  const out = await handlers['session.compact']($, Object.freeze({ trigger: 'manual', messages }), async () => ({ messages: [] }));
  const record = [...store.entries()].filter(([p]) => p.includes('compaction-spool')).map(([, t]) => JSON.parse(t)).find((r) => r.event === 'compact');
  return { out, record, bodies };
}

const NOTE_ENV = { OMC_JEV_COMPACT_NOTIFICATIONS: '1', OMC_JEV_COMPACT_TARGET_PERCENT: '20' };
const SHAPE = () => {
  const w = talk(30);
  const p1 = Object.freeze(row(note('Status: registry', `Report ${'r'.repeat(8000)}`), { handle: 'n1' }));
  const p2 = Object.freeze(row(`[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\nAgent finished ${'q'.repeat(6000)}`, { handle: 'n2' }));
  const mixed = Object.freeze(row(`${note('Other', 'short')}\nThese are my words: keep the report.`, { handle: 'n3' }));
  const owner = Object.freeze(row('Please review all the files carefully.', { handle: 'n4' }));
  return { w, p1, p2, mixed, owner, all: [...w.slice(0, 3), p1, ...w.slice(3, 7), p2, mixed, owner, ...w.slice(7)] };
};

describe('background task notifications as candidates (OMC_JEV_COMPACT_NOTIFICATIONS)', () => {
  it('without the variable the notification rows stay word for word and the record has no notification count', async () => {
    const s = SHAPE();
    const { out, record } = await compactRun({ OMC_JEV_COMPACT_TARGET_PERCENT: '20' }, s.all);
    expect(record).not.toHaveProperty('notifications');
    // Nothing else is removable here, so the built-in summary runs: the notification rows are no candidates.
    expect(record).toMatchObject({ result: 'fallback', reason: 'too_few_results', candidates: 0 });
    expect(out.messages).toEqual([]);
    expect(s.p1.text).toContain('Report');
  });

  it('traces the notification rows in a user row of their own and leaves mixed rows, the owner\'s words and the assistant\'s text as they are', async () => {
    const s = SHAPE();
    const { out, record, bodies } = await compactRun(NOTE_ENV, s.all);
    expect(record).toMatchObject({ result: 'jev', notifications: 2 });
    const after = out.messages;
    expect(after).not.toContain(s.p1);
    expect(after).not.toContain(s.p2);
    expect(after).toContain(s.mixed);
    expect(after).toContain(s.owner);
    const trace = after.find((m) => m.role === 'user' && /^\[compacted\] background task notification \(Agent "Status: registry" finished\) - \d+ chars removed$/.test(m.text || ''));
    expect(trace).toBeTruthy();
    expect(trace.handle).toBeUndefined();
    expect(trace.toolResults).toEqual([]);
    expect(trace.text).toContain(`${s.p1.text.length} chars`);
    expect(bodies.join('')).toContain('background task notification');
    for (const m of s.w.filter((x) => x.role === 'assistant')) expect(after.some((x) => x.role === 'assistant' && x.text === m.text)).toBe(true);
  });

  it('a trace of an earlier compaction is neither a task of the user nor a notification', async () => {
    const trace = row('[compacted] background task notification (Agent "x" finished) - 8000 chars removed');
    expect(isNotification(trace)).toBe(false);
    const w = talk(30);
    const { bodies } = await compactRun({ OMC_JEV_COMPACT_TARGET_PERCENT: '20', OMC_JEV_COMPACT_NOTIFICATIONS: '1' }, [...w.slice(0, 3), row(`Question ${'z'.repeat(9000)}`), ...w.slice(3, 26), trace, trace, user('A new request of the user.'), assistant('OK')]);
    const tasks = bodies.map((b) => JSON.parse(b)).flatMap((b) => JSON.stringify(b)).join('');
    expect(tasks).not.toContain('[compacted] background task notification');
  });

  it('predicts the tokens of a notification at the reminder rate, its non-ASCII characters at 3.72 and its trace at 0.58', async () => {
    const p = row(note('Status: registry', `Report ${'é'.repeat(8000)}`), { handle: 'n1' });
    const w = talk(30);
    const { out, record } = await compactRun(NOTE_ENV, [...w.slice(0, 3), p, ...w.slice(3)]);
    expect(record).toMatchObject({ result: 'jev', notifications: 1 });
    const trace = out.messages.find((m) => /^\[compacted\] background task notification/.test(m.text || ''));
    expect(trace).toBeTruthy();
    const nonAscii = [...p.text].filter((c) => c.codePointAt(0) > 127).length;
    const expected = Math.round(30000 - (0.363 * p.text.length + 3.72 * nonAscii - 0.58 * trace.text.length));
    expect(Math.abs(record.tokens_after_pred - expected)).toBeLessThanOrEqual(1);
  });

  it('a notification that names the output file of a background call on a secret path is traced and never sent to Jev', async () => {
    const w = talk(30);
    const call = { role: 'assistant', text: 'Starting.', toolUses: [{ tool_use_id: 'bg1', tool: 'Bash', input: { command: 'cat ~/.ssh/id_rsa', run_in_background: true } }] };
    const result = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'bg1', text: 'Command running in background. Output is being written to: /tmp/tasks/abcdef123456.output', isError: false }] };
    const secretNote = row(`<task-notification>\n<task-id>bg1</task-id>\n<output-file>/tmp/tasks/abcdef123456.output</output-file>\n<summary>Task done</summary>\n<result>SECRETBODY ${'s'.repeat(7000)}</result>\n</task-notification>`);
    const { out, record, bodies } = await compactRun(NOTE_ENV, [...w.slice(0, 3), call, result, secretNote, ...w.slice(3)]);
    expect(record.notifications).toBe(1);
    expect(bodies.join('')).not.toContain('SECRETBODY');
    expect(JSON.stringify(out.messages)).not.toContain('SECRETBODY');
  });
});

describe('isNotification', () => {
  it('takes a row that opens with the marker or holds only reminder and notification blocks, with or without an envelope', () => {
    expect(isNotification(row(note('a', 'x')))).toBe(true);
    expect(isNotification(row(bare('x')))).toBe(true);
    expect(isNotification(row(`<system-reminder>\n${bare('x')}\n</system-reminder>`))).toBe(true);
    expect(isNotification(row(`<system-reminder id="jev-1">\n${note('a', 'x')}\n</system-reminder id="jev-1">`))).toBe(true);
  });

  it('leaves alone a row with the user\'s words, a result row, an assistant row and a notification with a message of another sender', () => {
    expect(isNotification(row(`${bare('x')}\nThese are my words.`))).toBe(false);
    expect(isNotification(row('Quote: <task-notification> is a tag I typed about.'))).toBe(false);
    expect(isNotification(row(bare('x'), { toolResults: [{ tool_use_id: 't', text: 'r', isError: false }] }))).toBe(false);
    expect(isNotification(assistant(bare('x')))).toBe(false);
    const foreign = '<system-reminder>\nAnother Claude session sent a message while you were working:\nhello\n</system-reminder>';
    expect(isNotification(row(`${bare('x')}\n${foreign}`))).toBe(false);
  });

  it('reads a row of 40 000 unclosed reminder tags in linear time', () => {
    const t0 = Date.now();
    isNotification(row(`[SYSTEM NOTIFICATION - NOT USER INPUT]\n${'<system-reminder>'.repeat(40000)}`));
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
