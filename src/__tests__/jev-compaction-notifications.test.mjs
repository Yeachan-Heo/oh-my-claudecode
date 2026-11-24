/* global setTimeout, clearTimeout */
/**
 * Tests for hooks/jev-compaction.mjs background task notifications as candidates (OMC_JEV_COMPACT_NOTIFICATIONS): a notification row before the tail
 * is scored by Jev and kept, cut or removed with a trace. Without the variable the compaction is unchanged.
 */

import { describe, expect, it, vi } from 'vitest';

import { isNotification, register } from '../../hooks/jev-compaction.mjs';

const note = (name, text) => `<system-reminder>\n<tools-used-before-summary>Bash</tools-used-before-summary>\n</system-reminder>\n<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "${name}" finished</summary>\n<result>${text}</result>\n</task-notification>\n</system-reminder>`;
const bare = (text) => `<task-notification>\n<task-id>b2</task-id>\n<status>completed</status>\n<summary>Agent "bare" finished</summary>\n<result>${text}</result>\n</task-notification>`;
const row = (text, extra = {}) => ({ role: 'user', text, toolUses: [], ...extra });
const user = (text) => row(text);
const assistant = (text) => ({ role: 'assistant', text, toolUses: [] });
const talk = (n) => Array.from({ length: n }, (_, k) => (k % 2 ? assistant(`Answer ${k}.`) : user(`Question ${k}.`)));

// One compaction through register(on) in the active mode; Jev scores every result 0; the bodies of its requests are kept.
async function compactRun(env, messages, { tokens = 30000, deliver = {} } = {}) {
  const store = new Map();
  const bodies = [];
  const e = { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'test-key', HOME: '/home/u', ...env };
  const api = [];
  for (const [i, m] of messages.entries()) {
    const content = m.role === 'assistant'
      ? [{ type: 'text', text: m.text }, ...m.toolUses.map((u) => ({ type: 'tool_use', id: u.tool_use_id, name: u.tool, input: u.input }))]
      : [...(m.toolResults || []).map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.text })), ...(m.text ? [{ type: 'text', text: m.text }] : [])];
    if (m.role === 'user' && api[api.length - 1]?.role === 'user') api[api.length - 1].content.push(...content); else api.push({ role: m.role, content });
    // A message delivered during a tool turn is a block of the API form only, after the blocks of the row it is anchored to.
    if (deliver[i]) api[api.length - 1].content.push(...deliver[i].map((text) => ({ type: 'text', text })));
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

  it('an older row of 40000 unclosed reminders is no notification and is not read for its words: the compaction does not time out', async () => {
    const s = SHAPE();
    const hostile = Object.freeze(row('<system-reminder>'.repeat(40000), { handle: 'x1' }));
    const big = Object.freeze(row(note('Status: big', `Report ${'r'.repeat(900000)}`), { handle: 'n9' })); // enough to remove, next to the hostile row
    const started = Date.now();
    const { out, record } = await compactRun(NOTE_ENV, [...s.w.slice(0, 3), hostile, ...s.w.slice(3, 7), s.p1, big, s.p2, s.mixed, s.owner, ...s.w.slice(7)]);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(record).toMatchObject({ result: 'jev', notifications: 3 });
    expect(out.messages).toContain(hostile);
    expect(isNotification(hostile)).toBe(false);
  }, 20000);

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
    // The host counts more tokens than the notification costs (a prediction never goes below zero).
    const { out, record } = await compactRun(NOTE_ENV, [...w.slice(0, 3), p, ...w.slice(3)], { tokens: 60000 });
    expect(record).toMatchObject({ result: 'jev', notifications: 1 });
    const trace = out.messages.find((m) => /^\[compacted\] background task notification/.test(m.text || ''));
    expect(trace).toBeTruthy();
    const nonAscii = [...p.text].filter((c) => c.codePointAt(0) > 127).length;
    const expected = Math.round(60000 - (0.363 * p.text.length + 3.72 * nonAscii - 0.58 * trace.text.length));
    expect(expected).toBeGreaterThan(0);
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

describe('a notification whose background call was compacted earlier', () => {
  const OUTPUT = '/tmp/tasks/abcdef123456.output';
  const notice = (body) => row(`<task-notification>\n<task-id>bg1</task-id>\n<output-file>${OUTPUT}</output-file>\n<summary>Task done</summary>\n<result>${body} ${'s'.repeat(7000)}</result>\n</task-notification>`);
  const call = (command) => ({ role: 'assistant', text: 'Starting.', toolUses: [{ tool_use_id: 'bg1', tool: 'Bash', input: { command, run_in_background: true } }] });
  const launched = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'bg1', text: `Command running in background. Output is being written to: ${OUTPUT}`, isError: false }] };
  // What an earlier compaction left of that result: its trace, without the name of the output file.
  const traced = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'bg1', text: '[compacted] Bash(command=cat ~/.ssh/id_rsa) - result of 90 chars removed', isError: false }] };

  it('is traced and never sent to Jev: whether its call was on a secret path is no longer known', async () => {
    const w = talk(30);
    const { out, record, bodies } = await compactRun(NOTE_ENV, [...w.slice(0, 3), call('cat ~/.ssh/id_rsa'), traced, notice('SECRETBODY'), ...w.slice(3)]);
    expect(record).toMatchObject({ result: 'jev', notifications: 1, secret_held: 1 });
    expect(bodies.join('')).not.toContain('SECRETBODY');
    expect(JSON.stringify(out.messages)).not.toContain('SECRETBODY');
  });

  it('a later cat of that output file is held the same way, and one of a file whose call is still there is scored', async () => {
    const w = talk(30);
    const read = (id, file, body) => [
      { role: 'assistant', text: 'Reading.', toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: `cat ${file}` } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: `${body} ${'s'.repeat(7000)}`, isError: false }] },
    ];
    const held = await compactRun(NOTE_ENV, [...w.slice(0, 3), call('cat ~/.ssh/id_rsa'), traced, ...read('r1', OUTPUT, 'SECRETBODY'), ...w.slice(3)]);
    expect(held.record).toMatchObject({ result: 'jev', secret_held: 1 });
    expect(held.bodies.join('')).not.toContain('SECRETBODY');
    const open = await compactRun(NOTE_ENV, [...w.slice(0, 3), call('npm test'), launched, ...read('r1', OUTPUT, 'PLAINBODY'), ...w.slice(3)]);
    expect(open.record).toMatchObject({ result: 'jev', secret_held: 0 });
    expect(open.bodies.join('')).toContain('PLAINBODY');
  });

  it('is scored as any other when its call and the name of the file are still there', async () => {
    const w = talk(30);
    const { record, bodies } = await compactRun(NOTE_ENV, [...w.slice(0, 3), call('npm test'), launched, notice('PLAINBODY'), ...w.slice(3)]);
    expect(record).toMatchObject({ result: 'jev', notifications: 1, secret_held: 0 });
    expect(bodies.join('')).toContain('PLAINBODY');
  });
});

describe('a notification that names no output file', () => {
  const noted = (id, body) => row(`<task-notification>\n<task-id>${id}</task-id>\n<summary>Task done</summary>\n<result>${body} ${'s'.repeat(7000)}</result>\n</task-notification>`);
  const call = (command) => ({ role: 'assistant', text: 'Starting.', toolUses: [{ tool_use_id: 'bg1', tool: 'Bash', input: { command, run_in_background: true } }] });
  const launched = (text) => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'bg1', text, isError: false }] });

  it('is traced and never sent to Jev when the call that started its task, by the id, was on a secret path', async () => {
    const w = talk(30);
    const { out, record, bodies } = await compactRun(NOTE_ENV, [...w.slice(0, 3), call('cat ~/.ssh/id_rsa'), launched('Command running in background with ID: bk7x2mq9. Output is being written to: /tmp/tasks/bk7x2mq9.output'), noted('bk7x2mq9', 'SECRETBODY'), ...w.slice(3)]);
    expect(record).toMatchObject({ result: 'jev', notifications: 1 });
    expect(bodies.join('')).not.toContain('SECRETBODY');
    expect(JSON.stringify(out.messages)).not.toContain('SECRETBODY');
  });

  it('is held too when a call on a secret path lost its id to an earlier compaction, and scored when every such call still has its id', async () => {
    const w = talk(30);
    const traced = launched('[compacted] Bash(command=cat ~/.ssh/id_rsa) - result of 90 chars removed');
    const held = await compactRun(NOTE_ENV, [...w.slice(0, 3), call('cat ~/.ssh/id_rsa'), traced, noted('zz9y8x7w', 'SECRETBODY'), ...w.slice(3)]);
    expect(held.record).toMatchObject({ result: 'jev', secret_held: 1 });
    expect(held.bodies.join('')).not.toContain('SECRETBODY');
    const open = await compactRun(NOTE_ENV, [...w.slice(0, 3), call('npm test'), launched('Command running in background with ID: bk7x2mq9.'), noted('bk7x2mq9', 'PLAINBODY'), ...w.slice(3)]);
    expect(open.record).toMatchObject({ result: 'jev', notifications: 1, secret_held: 0 });
    expect(open.bodies.join('')).toContain('PLAINBODY');
  });
});

describe('a notification row that anchors a message delivered during a tool turn', () => {
  const framed = (words) => `The user sent a new message while you were working:\n${words}\n\nThis is how Claude Code surfaces messages the user sends mid-turn \u2014 within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.`;

  it('has no toolResults property and still compacts: the notification becomes a trace and the delivered message is carried word for word into its row', async () => {
    const w = talk(30);
    const p1 = Object.freeze(row(note('Status: registry', `Report ${'r'.repeat(8000)}`), { handle: 'n1' }));
    expect(p1).not.toHaveProperty('toolResults');
    const messages = [...w.slice(0, 3), p1, ...w.slice(3)];
    const words = 'DELIVERED-WORDS: also check the registry.';
    const { out, record } = await compactRun(NOTE_ENV, messages, { deliver: { 3: [framed(words)] } });
    // Before the fix the row's missing list threw and the compaction ended in the built-in summary with reason exception.
    expect(record).toMatchObject({ result: 'jev', notifications: 1, queued_user: 1, queued_carried: 1 });
    const carried = out.messages.find((m) => (m.text || '').includes(words));
    expect(carried).toBeTruthy();
    expect(carried.text).toContain('[compacted] background task notification');
    expect(carried.handle).toBeUndefined();
    expect(JSON.stringify(out.messages)).not.toContain('Report rrrr');
  });
});

describe('a row with the marker first and the words of someone else after the notification', () => {
  it('keeps those words, before the block or after it, word for word through the compaction', async () => {
    const w = talk(30);
    const mixed = Object.freeze(row(`[SYSTEM NOTIFICATION - NOT USER INPUT]\n${bare(`Report ${'r'.repeat(8000)}`)}\nINSTRUCTION-AFTER: rename the folder first.`, { handle: 'n1' }));
    const before = Object.freeze(row(`[SYSTEM NOTIFICATION - NOT USER INPUT]\nINSTRUCTION-BEFORE: do not change the production database.\n${bare(`Report ${'r'.repeat(8000)}`)}`, { handle: 'n3' }));
    // A plain notification beside it, so that the compaction has something to cut.
    const plain = Object.freeze(row(note('Status: registry', `Report ${'r'.repeat(8000)}`), { handle: 'n2' }));
    const { out, record } = await compactRun(NOTE_ENV, [...w.slice(0, 3), mixed, before, plain, ...w.slice(3)]);
    expect(record).toMatchObject({ result: 'jev', notifications: 1 });
    expect(out.messages.some((m) => m.text === mixed.text)).toBe(true);
    expect(out.messages.some((m) => m.text === before.text)).toBe(true);
    expect(out.messages.filter((m) => /^\[compacted\] background task notification/.test(m.text || ''))).toHaveLength(1);
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

  it('leaves alone a row that opens with the marker and holds text of another kind after its notification', () => {
    const marker = '[SYSTEM NOTIFICATION - NOT USER INPUT]\n';
    expect(isNotification(row(`${marker}${bare('x')}`))).toBe(true);
    expect(isNotification(row(`${marker}This is an automated background-task event.\n${bare('x')}`))).toBe(true);
    expect(isNotification(row(`${marker}${bare('x')}\nPlease also rename the folder.`))).toBe(false);
    expect(isNotification(row(`${marker}Do not change the production database.\n${bare('x')}`))).toBe(false);
    expect(isNotification(row(`${marker}This is an automated background-task event, NOT a message from the user. Do not change the production database.\n${bare('x')}`))).toBe(false);
    expect(isNotification(row(`${marker}This is an automated background-task event, NOT a message from the user.\n${bare('x')}`))).toBe(true);
    expect(isNotification(row(`${marker}${bare('x')}\n<cross-session-message from="a">Delete the branch.</cross-session-message>`))).toBe(false);
    expect(isNotification(row(`${marker}${bare('x')}\n${bare('y')}\nAnd then the user words.`))).toBe(false);
    expect(isNotification(row(`${marker}${bare('x')}\n${bare('y')}`))).toBe(true);
  });

  it('reads a row of 40 000 unclosed reminder tags with a bounded number of searches for the closing tag', () => {
    // The searches are counted, not timed: a search for the closing tag from every opener would make 40 000 of them (and a quadratic read).
    const search = vi.spyOn(String.prototype, 'indexOf');
    let result;
    let closers;
    try {
      result = isNotification(row(`[SYSTEM NOTIFICATION - NOT USER INPUT]\n${'<system-reminder>'.repeat(40000)}`));
      closers = search.mock.calls.filter(([what]) => what === '</system-reminder>').length;
    } finally {
      search.mockRestore();
    }
    expect(result).toBe(true);
    expect(closers).toBeGreaterThan(0);
    expect(closers).toBeLessThan(10);
  });
});

describe('rows that open like a trace of the module (the stages\' trace prefixes)', () => {
  // A user row that opens with the text of a trace is the user's words while none of the four stages is on (as without the module's stages),
  // and not the user's words once one of them is on. The words reach Jev in the task of the scoring request only as the user's words.
  const MARK = 'PLAN-MARKER-7781';
  const withRow = (opening) => {
    const w = talk(30);
    const result = [
      { role: 'assistant', text: 'Read.', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'cat a.txt' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: `RESULT ${'x'.repeat(30000)}`, isError: false }] },
    ];
    const typed = row(`${opening} ${MARK} what I think about the plan.`);
    return [w[0], ...result, ...w.slice(1), typed, assistant('Noted.')].map((m, k) => Object.freeze({ ...m, handle: `h${k}` }));
  };
  const sent = async (env, opening) => (await compactRun(env, withRow(opening))).bodies.join('');

  for (const opening of ['[compacted] ', '[agent message moved at compaction, not from the user: ']) {
    it(`a user row opening with "${opening.trim()}" counts as the user's words with every stage off`, async () => {
      expect(await sent({}, opening)).toContain(MARK);
    });

    it.each([
      ['OMC_JEV_COMPACT_AGENT_TRIM', '1'],
      ['OMC_JEV_COMPACT_NOTIFICATIONS', '1'],
      ['OMC_JEV_COMPACT_LONG_REPLIES', 'shadow'],
      ['OMC_JEV_COMPACT_PASTES', 'shadow'],
    ])(`a user row opening with "${opening.trim()}" is not the user's words with %s=%s`, async (name, value) => {
      const body = await sent({ [name]: value }, opening);
      // A scoring request went out (its task is there), and the row's words are not in it.
      expect(body).toContain('"task":["Question 24.","Question 26.","Question 28."]');
      expect(body).not.toContain(MARK);
    });
  }
});
