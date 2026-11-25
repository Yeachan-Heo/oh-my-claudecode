/* global setTimeout, clearTimeout */
/**
 * Tests for hooks/jev-compaction.mjs background task notifications as candidates (OMC_JEV_COMPACT_NOTIFICATIONS): a notification row before the tail
 * is scored by Jev and kept, cut or removed with a trace. Without the variable the compaction is unchanged.
 */

import { describe, expect, it, vi } from 'vitest';

import { isNotification, register } from '../../hooks/jev-compaction.mjs';

const note = (name, text) => `<system-reminder>\n<tools-used-before-summary>Bash</tools-used-before-summary>\n</system-reminder>\n<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n<task-notification>\n<task-id>a1b2c3</task-id>\n<status>completed</status>\n<summary>Agent "${name}" finished</summary>\n<result>${text}</result>\n</task-notification>\n</system-reminder>`;
const bare = (text) => `<task-notification>\n<task-id>b2</task-id>\n<status>completed</status>\n<summary>Agent "bare" finished</summary>\n<result>${text}</result>\n</task-notification>`;
const row = (text, extra = {}) => ({ role: 'user', text, toolUses: [], ...extra });
const user = (text) => row(text);
const assistant = (text) => ({ role: 'assistant', text, toolUses: [] });
const talk = (n) => Array.from({ length: n }, (_, k) => (k % 2 ? assistant(`Answer ${k}.`) : user(`Question ${k}.`)));

// One compaction through register(on) in the active mode; Jev scores every result 0; the bodies of its requests are kept.
async function compactRun(env, messages, { tokens = 30000, deliver = {}, score = 0 } = {}) {
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
    http: { fetch: async (url, init) => { const b = JSON.parse(init.body); bodies.push(init.body); return { ok: true, status: 200, headers: {}, text: JSON.stringify({ answers: Object.fromEntries(Object.keys(b.questions).map((q) => [q, { type: 'score', score, confidence: 0.9 }])) }) }; } },
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

// The call that started the task of note() and its result: a notification whose task is tied to no call in the conversation is held, never scored.
const LAUNCH = [
  { role: 'assistant', text: 'Starting the agent.', toolUses: [{ tool_use_id: 'bgl1', tool: 'Agent', input: { prompt: 'Look at the registry.', run_in_background: true } }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'bgl1', text: 'Async agent launched successfully. agentId: a1b2c3', isError: false }] },
];
const NOTE_ENV = { OMC_JEV_COMPACT_NOTIFICATIONS: '1', OMC_JEV_COMPACT_TARGET_PERCENT: '20' };
const SHAPE = () => {
  const w = talk(30);
  const p1 = Object.freeze(row(note('Status: registry', `Report ${'r'.repeat(8000)}`), { handle: 'n1' }));
  const p2 = Object.freeze(row(`[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\nAgent finished ${'q'.repeat(6000)}`, { handle: 'n2' }));
  const mixed = Object.freeze(row(`${note('Other', 'short')}\nThese are my words: keep the report.`, { handle: 'n3' }));
  const owner = Object.freeze(row('Please review all the files carefully.', { handle: 'n4' }));
  return { w, p1, p2, mixed, owner, all: [...w.slice(0, 3), p1, ...w.slice(3, 7), p2, mixed, owner, ...w.slice(7)], launched: [...w.slice(0, 3), ...LAUNCH, p1, ...w.slice(3, 7), p2, mixed, owner, ...w.slice(7)] };
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
    const { out, record, bodies } = await compactRun(NOTE_ENV, s.launched);
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

  // The same on Windows, in two passes: the input of a call holds the path with backslashes (and a JSON form with doubled ones), a drive letter, or both kinds of separator.
  const WINDOWS = [
    ['backslashes', { tool: 'Bash', input: (f) => ({ command: `type ${f}` }), file: 'C:\\Users\\u\\AppData\\Local\\Temp\\claude\\tasks\\abcdef123456.output' }],
    ['mixed separators and a drive letter', { tool: 'Bash', input: (f) => ({ command: `cat ${f}` }), file: 'D:/work/proj\\.claude\\tasks/abcdef123456.output' }],
    ['the file_path of a Read, in its JSON form', { tool: 'Read', input: (f) => ({ file_path: f }), file: 'C:\\Users\\u\\AppData\\Local\\Temp\\claude\\tasks\\abcdef123456.output' }],
  ];
  for (const [name, { tool, input, file }] of WINDOWS) {
    it(`a later read of that output file is held on Windows too, in the second pass after the call was removed: ${name}`, async () => {
      const w = talk(30);
      const readOf = (id, f, body) => [
        { role: 'assistant', text: 'Reading.', toolUses: [{ tool_use_id: id, tool, input: input(f) }] },
        { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: `${body} ${'s'.repeat(7000)}`, isError: false }] },
      ];
      const secretLaunch = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'bg1', text: `Command running in background. Output is being written to: ${file}`, isError: false }] };
      const fillers = [1, 2, 3].flatMap((k) => [
        { role: 'assistant', text: 'Reading.', toolUses: [{ tool_use_id: `rd${k}`, tool: 'Bash', input: { command: 'cat a.txt' } }] },
        { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `rd${k}`, text: `Filler ${k} ${'s'.repeat(7000)}`, isError: false }] },
      ]);
      const first = await compactRun(NOTE_ENV, [...w.slice(0, 3), call('cat ~/.ssh/id_rsa'), secretLaunch, ...fillers, ...w.slice(3)]);
      expect(first.record).toMatchObject({ result: 'jev' });
      // The first pass took the call away with its result: nothing in the conversation names the output file or says what the task was.
      expect(JSON.stringify(first.out.messages)).not.toContain('abcdef123456');
      const second = await compactRun(NOTE_ENV, [...first.out.messages.slice(0, 4), ...readOf('r1', file, 'SECRETBODY'), ...first.out.messages.slice(4)]);
      expect(second.record).toMatchObject({ result: 'jev', secret_held: 1 });
      expect(second.bodies.join('')).not.toContain('SECRETBODY');
      expect(JSON.stringify(second.out.messages)).not.toContain('SECRETBODY');
      // A read of the same path whose call is still there is scored, so the normalized path does not hold what it should not.
      const open = await compactRun(NOTE_ENV, [...w.slice(0, 3), call('npm test'), secretLaunch, ...readOf('r1', file, 'PLAINBODY'), ...w.slice(3)]);
      expect(open.record).toMatchObject({ result: 'jev', secret_held: 0 });
      expect(open.bodies.join('')).toContain('PLAINBODY');
    });
  }

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

  const read = (id, file, body) => [
    { role: 'assistant', text: 'Reading.', toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: `cat ${file}` } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: `${body} ${'f'.repeat(7000)}`, isError: false }] },
  ];

  it('is held when its task is tied to no call in the conversation: an earlier compaction removed the call of a private path, and in the second pass the report stays out of Jev', async () => {
    const w = talk(30);
    const secretCall = call('cat ~/.ssh/id_rsa');
    const secretLaunch = launched('Command running in background with ID: bk7x2mq9. Output is being written to: /tmp/tasks/bk7x2mq9.output');
    const first = await compactRun(NOTE_ENV, [...w.slice(0, 3), secretCall, secretLaunch, ...[1, 2, 3].flatMap((k) => read(`rd${k}`, 'a.txt', `Filler ${k}`)), ...w.slice(3)]);
    expect(first.record).toMatchObject({ result: 'jev' });
    // The first pass took the call away with its result: nothing in the conversation says what the task was.
    expect(JSON.stringify(first.out.messages)).not.toContain('bk7x2mq9');
    const second = await compactRun(NOTE_ENV, [...first.out.messages.slice(0, 4), noted('bk7x2mq9', 'SECRETBODY'), ...first.out.messages.slice(4)]);
    expect(second.record).toMatchObject({ result: 'jev', notifications: 1, secret_held: 1 });
    expect(second.bodies.join('')).not.toContain('SECRETBODY');
    expect(JSON.stringify(second.out.messages)).not.toContain('SECRETBODY');
  });

  it('is scored when its task is tied to a call that is still there, and a row of several notifications is held when any one of them is of a secret path', async () => {
    const w = talk(30);
    const both = (id1, id2) => row(`${noted(id1, 'PLAINBODY').text}\n${noted(id2, 'SECRETBODY').text}`);
    const second = { role: 'assistant', text: 'Starting.', toolUses: [{ tool_use_id: 'bg2', tool: 'Bash', input: { command: 'cat ~/.ssh/id_rsa', run_in_background: true } }] };
    const secondLaunch = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'bg2', text: 'Command running in background with ID: sk5t3n1p.', isError: false }] };
    const open = await compactRun(NOTE_ENV, [...w.slice(0, 3), call('npm test'), launched('Command running in background with ID: bk7x2mq9.'), noted('bk7x2mq9', 'PLAINBODY'), ...w.slice(3)]);
    expect(open.record).toMatchObject({ result: 'jev', notifications: 1, secret_held: 0 });
    expect(open.bodies.join('')).toContain('PLAINBODY');
    const mixed = await compactRun(NOTE_ENV, [...w.slice(0, 3), call('npm test'), launched('Command running in background with ID: bk7x2mq9.'), second, secondLaunch, both('bk7x2mq9', 'sk5t3n1p'), ...w.slice(3)]);
    expect(mixed.record).toMatchObject({ result: 'jev', notifications: 1 });
    expect(mixed.bodies.join('')).not.toContain('SECRETBODY');
    expect(mixed.bodies.join('')).not.toContain('PLAINBODY');
  });
  it('a row of envelopes is held when any one holds a notification of no task, here a known task beside a report of the marker only', async () => {
    const w = talk(30);
    const wrap = (id, body) => `<system-reminder id="${id}">\n${body}\n</system-reminder id="${id}">`;
    const marker = `[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\nSECRETBODY ${'s'.repeat(7000)}`;
    const mixed = row(`${wrap('jev-1', noted('bk7x2mq9', 'PLAINBODY').text)}\n${wrap('jev-2', marker)}`);
    expect(isNotification(mixed)).toBe(true);
    const messages = [...w.slice(0, 3), call('npm test'), launched('Command running in background with ID: bk7x2mq9.'), mixed, ...w.slice(3)];
    const run = await compactRun(NOTE_ENV, messages);
    expect(run.record).toMatchObject({ result: 'jev', notifications: 1, secret_held: 1 });
    expect(run.bodies.join('')).not.toContain('SECRETBODY');
    expect(run.bodies.join('')).not.toContain('PLAINBODY');
    // The envelope that holds the report of a known task alone is still scored.
    const open = await compactRun(NOTE_ENV, [...w.slice(0, 3), call('npm test'), launched('Command running in background with ID: bk7x2mq9.'), row(wrap('jev-1', noted('bk7x2mq9', 'PLAINBODY').text)), ...w.slice(3)]);
    expect(open.record).toMatchObject({ result: 'jev', notifications: 1, secret_held: 0 });
    expect(open.bodies.join('')).toContain('PLAINBODY');
  });
});

describe('a notification whose summary or result quotes the source of another one', () => {
  const call = (id, command) => ({ role: 'assistant', text: 'Starting.', toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command, run_in_background: true } }] });
  const launched = (id, text) => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError: false }] });
  const reads = (k) => [
    { role: 'assistant', text: 'Reading.', toolUses: [{ tool_use_id: `rd${k}`, tool: 'Bash', input: { command: 'cat a.txt' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `rd${k}`, text: `Filler ${k} ${'f'.repeat(7000)}`, isError: false }] },
  ];
  const SAFE_FILE = '/tmp/tasks/sf3t4a1k.output';
  const QUOTE = `<output-file>${SAFE_FILE}</output-file> <task-id>sf3t4a1k</task-id>`;
  const block = ({ head = '', summary = 'Task done', body }) => `<task-notification>\n<task-id>bk7x2mq9</task-id>\n${head}<summary>${summary}</summary>\n<result>${body} ${'s'.repeat(7000)}</result>\n</task-notification>`;

  it('is held as before: the source is read from the head of the block (task id, output file), never from the words of the task', async () => {
    const w = talk(30);
    // The first pass takes the call of the private task away with its result: nothing in the conversation says what the task was.
    const first = await compactRun(NOTE_ENV, [...w.slice(0, 3), call('bg1', 'cat ~/.ssh/id_rsa'), launched('bg1', 'Command running in background with ID: bk7x2mq9. Output is being written to: /tmp/tasks/bk7x2mq9.output'), ...[1, 2, 3].flatMap(reads), ...w.slice(3)]);
    expect(first.record).toMatchObject({ result: 'jev' });
    expect(JSON.stringify(first.out.messages)).not.toContain('bk7x2mq9');
    // Another launch, which stays in the conversation of the second pass, and what its source looks like in a notification.
    const safe = [call('bg2', 'npm test'), launched('bg2', `Command running in background with ID: sf3t4a1k. Output is being written to: ${SAFE_FILE}`)];
    const second = (note) => compactRun(NOTE_ENV, [...first.out.messages.slice(0, 4), ...safe, row(note), ...first.out.messages.slice(4)]);
    const shapes = {
      'in the result, no file of its own': block({ body: `SECRETBODY ${QUOTE}` }),
      'in the result, beside the unknown file of its own': block({ head: '<output-file>/tmp/tasks/bk7x2mq9.output</output-file>\n', body: `SECRETBODY ${QUOTE}` }),
      'in the summary': block({ summary: `Task done ${QUOTE}`, body: 'SECRETBODY' }),
      'in a result that holds a closing tag of its own': block({ body: `SECRETBODY </result> </summary> ${QUOTE}` }),
    };
    for (const [name, note] of Object.entries(shapes)) {
      const run = await second(note);
      expect(run.record, name).toMatchObject({ result: 'jev', notifications: 1, secret_held: 1 });
      expect(run.bodies.join(''), name).not.toContain('SECRETBODY');
      expect(JSON.stringify(run.out.messages), name).not.toContain('SECRETBODY');
    }
    // The source of its own, in the head, that names the call that is still there: scored as any other.
    const open = await compactRun(NOTE_ENV, [...first.out.messages.slice(0, 4), ...safe, row(block({ head: `<output-file>${SAFE_FILE}</output-file>\n`, body: 'PLAINBODY' }).replace('bk7x2mq9', 'sf3t4a1k')), ...first.out.messages.slice(4)]);
    expect(open.record).toMatchObject({ result: 'jev', notifications: 1, secret_held: 0 });
    expect(open.bodies.join('')).toContain('PLAINBODY');
  });
});

describe('a notification of a task whose call is still there, and the files its result quotes', () => {
  const call = (id, command) => ({ role: 'assistant', text: 'Starting.', toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command, run_in_background: true } }] });
  const launched = (id, task, file) => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: `Command running in background with ID: ${task}. Output is being written to: ${file}`, isError: false }] });
  const reads = (k) => [
    { role: 'assistant', text: 'Reading.', toolUses: [{ tool_use_id: `rd${k}`, tool: 'Bash', input: { command: 'cat a.txt' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `rd${k}`, text: `Filler ${k} ${'f'.repeat(7000)}`, isError: false }] },
  ];
  const SAFE_FILE = '/tmp/tasks/sf3t4a1k.output';
  const SECRET_FILE = '/tmp/tasks/bk7x2mq9.output';
  const STRANGER = '/tmp/tasks/zz9y8x7w.output';
  // Two launches that stay in the conversation: one on a secret path and one that is not.
  const launches = [call('bg1', 'cat ~/.ssh/id_rsa'), launched('bg1', 'bk7x2mq9', SECRET_FILE), call('bg2', 'npm test'), launched('bg2', 'sf3t4a1k', SAFE_FILE)];
  const report = ({ head = '', quote = '' }) => `<task-notification>\n<task-id>sf3t4a1k</task-id>\n<output-file>${SAFE_FILE}</output-file>\n${head}<summary>Tests finished</summary>\n<result>PLAINBODY ${quote} ${'s'.repeat(7000)}</result>\n</task-notification>`;
  const CASES = [
    { name: 'a file that no call in the conversation produced, quoted in its result', note: report({ quote: `<output-file>${STRANGER}</output-file>` }), sent: true, held: 0 },
    { name: 'a file that no call in the conversation produced, quoted in its result with a task id of no call', note: report({ quote: `<output-file>${STRANGER}</output-file> <task-id>qq1w2e3r</task-id>` }), sent: true, held: 0 },
    { name: 'the file of a call on a secret path, quoted in its result', note: report({ quote: `<output-file>${SECRET_FILE}</output-file>` }), sent: false },
    { name: 'a file that no call in the conversation produced, named in its own head', note: report({ head: `<output-file>${STRANGER}</output-file>\n` }), sent: false, held: 1 },
  ];

  for (const c of CASES) {
    it(`${c.sent ? 'is scored as any other' : 'is held, never sent to Jev'} with ${c.name}`, async () => {
      const w = talk(30);
      const run = await compactRun(NOTE_ENV, [...w.slice(0, 3), ...launches, ...[1, 2, 3].flatMap(reads), row(c.note), ...w.slice(3)]);
      expect(run.record).toMatchObject({ result: 'jev', notifications: 1, ...(c.held === undefined ? {} : { secret_held: c.held }) });
      expect(run.bodies.join('').includes('PLAINBODY'), c.name).toBe(c.sent);
      expect(JSON.stringify(run.out.messages).includes('PLAINBODY'), c.name).toBe(false);
    });
  }
});

describe('a notification of a background task that reads the output file of a task on a secret path', () => {
  const file = (task) => `/tmp/work/tasks/${task}.output`;
  const start = (id, tool, input) => ({ role: 'assistant', text: 'Starting.', toolUses: [{ tool_use_id: id, tool, input: { ...input, run_in_background: true } }] });
  const launched = (id, task) => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: `Async task launched. ID: ${task}. Output is being written to: ${file(task)}`, isError: false }] });
  const reads = (k) => [
    { role: 'assistant', text: 'Reading.', toolUses: [{ tool_use_id: `rd${k}`, tool: 'Bash', input: { command: 'cat a.txt' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `rd${k}`, text: `Filler ${k} ${'f'.repeat(7000)}`, isError: false }] },
  ];
  const report = (task, body) => row(`<task-notification>\n<task-id>${task}</task-id>\n<output-file>${file(task)}</output-file>\n<summary>Task done</summary>\n<result>${body} ${'s'.repeat(7000)}</result>\n</task-notification>`);
  // Links: the first task runs on a secret path; each next one is an Agent whose prompt reads the output file of the one before it (`reader`: the file it reads).
  const chain = (links, firstRead) => {
    const tasks = ['bk7x2mq9', 'ag1b2c3d', 'ag4e5f6g'].slice(0, links + 1);
    const rows = [start('c0', 'Bash', { command: 'cat ~/.ssh/id_rsa' }), launched('c0', tasks[0])];
    for (let k = 1; k <= links; k++) rows.push(start(`c${k}`, 'Agent', { prompt: `Summarize ${k === 1 ? firstRead ?? file(tasks[0]) : file(tasks[k - 1])} for the report.` }), launched(`c${k}`, tasks[k]));
    return { rows, last: tasks[links] };
  };

  for (const links of [1, 2]) {
    it(`is traced and never sent to Jev: ${links === 1 ? 'an Agent that reads the file' : 'an Agent that reads the file of an Agent that reads the file'}`, async () => {
      const { rows, last } = chain(links);
      const w = talk(30);
      const run = await compactRun(NOTE_ENV, [...w.slice(0, 3), ...rows, ...[1, 2, 3].flatMap(reads), report(last, 'SECRETBODY'), ...w.slice(3)]);
      expect(run.record).toMatchObject({ result: 'jev', notifications: 1 });
      expect(run.bodies.join('')).not.toContain('SECRETBODY');
      expect(JSON.stringify(run.out.messages)).not.toContain('SECRETBODY');
    });
  }

  it('is scored as any other when the Agent reads a file of its own, whatever the first task was', async () => {
    const { rows, last } = chain(1, '/tmp/work/notes.txt');
    const w = talk(30);
    const run = await compactRun(NOTE_ENV, [...w.slice(0, 3), ...rows, ...[1, 2, 3].flatMap(reads), report(last, 'PLAINBODY'), ...w.slice(3)]);
    expect(run.record).toMatchObject({ result: 'jev', notifications: 1, secret_held: 0 });
    expect(run.bodies.join('')).toContain('PLAINBODY');
  });
});

describe('the envelopes of the deliveries after a notification', () => {
  const words = Array.from({ length: 40 }, (_, k) => `The coordinator sent a message while you were working:\nd${k}`);
  const deliver = (i) => ({ [i]: words });
  const plain = row(note('Status: registry', `Report ${'r'.repeat(30000)}`), { handle: 'n1' });
  const messages = () => { const w = talk(30); return [...w.slice(0, 3), ...LAUNCH, plain, ...w.slice(3)]; };

  it('are charged only when the notification is rebuilt: one kept whole keeps its row and adds nothing to the prediction', async () => {
    const env = { OMC_JEV_COMPACT_NOTIFICATIONS: '1', OMC_JEV_COMPACT_TARGET_PERCENT: '80', OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' };
    // Jev scores the notification 3 (needed): it stays whole, and the host gives its deliveries back with its row.
    const whole = await compactRun(env, messages(), { tokens: 30000, deliver: deliver(5), score: 3 });
    const none = await compactRun(env, messages(), { tokens: 30000, score: 3 });
    expect(whole.record).toMatchObject({ result: 'jev', notifications: 1, queued_carried: 0 });
    expect(whole.out.messages.some((m) => m.handle === 'n1')).toBe(true);
    for (const key of ['tokens_after_pred', 'tokens_after']) expect(whole.record[key], key).toBe(none.record[key]);
    // The same notification traced is rebuilt, and its envelopes are in the row: the prediction and the record rise by their tokens. The 40 deliveries become one
    // block of the row's text, and each block gone takes its overhead (RATE_BLOCK 45.4) off the list, so the rise is the envelopes less 40 blocks.
    const traced = await compactRun(env, messages(), { tokens: 30000, deliver: deliver(5), score: 0 });
    const tracedNone = await compactRun(env, messages(), { tokens: 30000, score: 0 });
    expect(traced.record.queued_carried).toBeGreaterThan(0);
    const carried = traced.out.messages.find((m) => /^\[compacted\] background task notification/.test(m.text || ''));
    expect(carried).toBeTruthy();
    const trace = carried.text.slice(0, carried.text.indexOf('\n'));
    const wrapper = carried.text.length - trace.length - words.reduce((n, b) => n + b.length, 0);
    expect(wrapper).toBeGreaterThan(40 * 20);
    const extra = 0.363 * wrapper - 40 * 45.4;
    for (const key of ['tokens_after_pred', 'tokens_after']) {
      const grew = traced.record[key] - tracedNone.record[key];
      expect(grew, key).toBeGreaterThan(extra - 2);
      expect(grew, key).toBeLessThan(extra + 8);
    }
  });
});

describe('the envelopes of the deliveries after a notification: the rows that build writes', () => {
  const words = Array.from({ length: 60 }, (_, k) => `The coordinator sent a message while you were working:\nd${k}`);
  const enveloped = words.map((w, k) => `<system-reminder id="jev-${k + 50}">\n${w}\n</system-reminder id="jev-${k + 50}">`);
  const result = (id, body) => [
    { role: 'assistant', text: 'Reading.', toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: `cat ${id}.txt` } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: `${body} ${'x'.repeat(7000)}`, isError: false }] },
  ];

  it('without the token cascade a notification kept whole charges nothing: the results are cut as with no delivery', async () => {
    const plain = row(note('Status: registry', `Report ${'r'.repeat(20000)}`), { handle: 'n1' });
    const messages = () => [...talk(3), ...LAUNCH, ...result('r1', 'RES1'), ...result('r2', 'RES2'), ...result('r3', 'RES3'), ...result('r4', 'RES4'), plain, ...talk(30)];
    const at = messages().indexOf(plain);
    const env = { OMC_JEV_COMPACT_NOTIFICATIONS: '1', OMC_JEV_COMPACT_TARGET: '0.9' };
    const none = await compactRun(env, messages(), { score: 3 });
    const delivered = await compactRun(env, messages(), { score: 3, deliver: { [at]: words } });
    expect(none.record).toMatchObject({ result: 'jev', notifications: 1 });
    expect(delivered.record).toMatchObject({ result: 'jev', notifications: 1, queued_carried: 0 });
    expect(delivered.out.messages.some((m) => m.handle === 'n1')).toBe(true);
    expect(delivered.record.traced).toBe(none.record.traced);
    expect(delivered.record.kept_full).toBe(none.record.kept_full);
  });

  it('without the token cascade a small notification kept whole gives back the envelopes that cost more than it does: the results are cut as with no delivery', async () => {
    const small = row(note('Status: registry', `Report ${'r'.repeat(1500)}`), { handle: 'n1' });
    const many = Array.from({ length: 200 }, (_, k) => `The coordinator sent a message while you were working:\nd${k}`);
    const messages = () => [...talk(3), ...LAUNCH, ...Array.from({ length: 12 }, (_, k) => result(`q${k}`, `RES${k}`)).flat(), small, ...talk(30)];
    const at = messages().indexOf(small);
    const env = { OMC_JEV_COMPACT_NOTIFICATIONS: '1', OMC_JEV_COMPACT_TARGET: '0.9' };
    const none = await compactRun(env, messages(), { score: 3 });
    const delivered = await compactRun(env, messages(), { score: 3, deliver: { [at]: many } });
    expect(delivered.record).toMatchObject({ result: 'jev', notifications: 1, queued_carried: 0 });
    expect(delivered.out.messages.some((m) => m.handle === 'n1')).toBe(true);
    expect(delivered.record.traced).toBe(none.record.traced);
    expect(delivered.record.kept_full).toBe(none.record.kept_full);
  });

  it('without the token cascade the results are cut as with no delivery whatever the place of the notification kept whole in the ranking: before the results, after them and between them', async () => {
    const small = row(note('Status: registry', `Report ${'r'.repeat(1500)}`), { handle: 'n1' });
    const many = Array.from({ length: 1000 }, (_, k) => `The coordinator sent a message while you were working:\nd${k}`);
    const steps = Array.from({ length: 30 }, (_, k) => [
      { role: 'assistant', text: 'Reading.', toolUses: [{ tool_use_id: `s${k}`, tool: 'Bash', input: { command: `cat s${k}.txt` } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `s${k}`, text: `STEP${k} ${'x'.repeat(3000)}`, isError: false }] },
    ]);
    const env = { OMC_JEV_COMPACT_NOTIFICATIONS: '1', OMC_JEV_COMPACT_TARGET: '0.9' };
    for (const [place, at] of [['before the results', 0], ['between them', 15], ['after them', 30]]) {
      const messages = () => [...talk(3), ...LAUNCH, ...steps.slice(0, at).flat(), small, ...steps.slice(at).flat(), ...talk(30)];
      const row5 = messages().indexOf(small);
      const none = await compactRun(env, messages(), { score: 3 });
      const delivered = await compactRun(env, messages(), { score: 3, deliver: { [row5]: many } });
      expect(delivered.record, place).toMatchObject({ result: 'jev', notifications: 1, queued_carried: 0 });
      expect(delivered.out.messages.some((m) => m.handle === 'n1'), place).toBe(true);
      // The envelopes of the deliveries are written only into a row that is rebuilt, and the notification is not: no result is traced for their sake.
      expect(delivered.record.traced, place).toBeLessThanOrEqual(none.record.traced);
    }
  });

  it('a notification of envelopes only, replaced by a trace, is charged the envelopes that its replacement row holds', async () => {
    const env = { OMC_JEV_COMPACT_NOTIFICATIONS: '1', OMC_JEV_COMPACT_TARGET_PERCENT: '80', OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' };
    const only = row(`<system-reminder id="jev-1">\n${note('Status: registry', `Report ${'r'.repeat(30000)}`)}\n</system-reminder id="jev-1">`, { handle: 'n1' });
    expect(isNotification(only)).toBe(true);
    const messages = () => { const w = talk(30); return [...w.slice(0, 3), ...LAUNCH, only, ...w.slice(3)]; };
    const at = messages().indexOf(only);
    const none = await compactRun(env, messages(), { tokens: 30000 });
    const run = await compactRun(env, messages(), { tokens: 30000, deliver: { [at]: enveloped } });
    expect(run.record).toMatchObject({ result: 'jev', notifications: 1 });
    const carried = run.out.messages.find((m) => /^\[compacted\] background task notification/.test(m.text || ''));
    expect(carried).toBeTruthy();
    // What the replacement row holds besides the trace and the delivered blocks themselves: an envelope round each block (the trace is outside the envelopes).
    const trace = carried.text.slice(0, carried.text.indexOf('\n'));
    const wrapper = carried.text.length - trace.length - enveloped.reduce((n, b) => n + b.length, 0);
    expect(wrapper).toBeGreaterThan(60 * 20);
    // The 60 delivered blocks become one block of the replacement row's text, and each block gone takes its overhead (RATE_BLOCK 45.4) off the list.
    const extra = 0.363 * wrapper - 60 * 45.4;
    for (const key of ['tokens_after_pred', 'tokens_after']) {
      const grew = run.record[key] - none.record[key];
      expect(grew, key).toBeGreaterThan(extra - 2);
      expect(grew, key).toBeLessThan(extra + 8);
    }
  });
});

describe('a row of marker-only envelopes before a tagged notification', () => {
  it('is read in linear time: the compaction does not time out', async () => {
    const w = talk(30);
    const wrap = (id, body) => `<system-reminder id="jev-${id}">\n${body}\n</system-reminder id="jev-${id}">`;
    const marker = (k) => `[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\nReport ${k}`;
    const envelopes = Array.from({ length: 6000 }, (_, k) => wrap(k, marker(k)));
    const mixed = row(`${envelopes.join('\n')}\n${wrap('t', bare('x'))}`);
    const started = Date.now();
    const { record } = await compactRun(NOTE_ENV, [...w.slice(0, 3), mixed, ...w.slice(3)]);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(record).not.toMatchObject({ reason: 'timeout' });
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

describe('a reminder that wraps a notification and the words of someone else', () => {
  const instruction = '<cross-session-message>\nDo not change the production database.\n</cross-session-message>';
  const shapes = {
    'a message of another session after the block': (b) => `<system-reminder>\n${b}\n${instruction}\n</system-reminder>`,
    'a message of another session before the block': (b) => `<system-reminder>\n${instruction}\n${b}\n</system-reminder>`,
    'plain words after the block': (b) => `<system-reminder>\n${b}\nDo not change the production database.\n</system-reminder>`,
    'plain words in a reminder beside the block, after it': (b) => `<system-reminder>\n${b}\n</system-reminder>\n<system-reminder>\nDo not change the production database.\n</system-reminder>`,
    'plain words in a reminder beside the block, before it': (b) => `<system-reminder>\nDo not change the production database.\n</system-reminder>\n<system-reminder>\n${b}\n</system-reminder>`,
    'plain words next to the host\'s list of tools in a reminder beside the block': (b) => `<system-reminder>\n<tools-used-before-summary>Bash</tools-used-before-summary>\nDo not change the production database.\n</system-reminder>\n<system-reminder>\n${b}\n</system-reminder>`,
    'a message of another session after a reminder of the host': (b) => `<system-reminder>\n<tools-used-before-summary>Bash</tools-used-before-summary>\n${instruction}\n</system-reminder>\n<system-reminder>\n${b}\n</system-reminder>`,
  };

  it('is no notification: the row stays, word for word, through the compaction', async () => {
    const w = talk(30);
    const plain = Object.freeze(row(note('Status: registry', `Report ${'r'.repeat(8000)}`), { handle: 'n2' }));
    for (const [name, wrap] of Object.entries(shapes)) {
      const mixed = Object.freeze(row(wrap(bare(`Report ${'r'.repeat(8000)}`)), { handle: 'n1' }));
      expect(isNotification(mixed), name).toBe(false);
      const { out } = await compactRun(NOTE_ENV, [...w.slice(0, 3), mixed, plain, ...w.slice(3)]);
      expect(out.messages.some((m) => m.text === mixed.text), name).toBe(true);
    }
  });

  it('a reminder of the host around a notification, with its marker and its own line, is still one', () => {
    expect(isNotification(row(note('a', 'x')))).toBe(true);
    expect(isNotification(row(`<system-reminder>\n${bare('x')}\n</system-reminder>`))).toBe(true);
    expect(isNotification(row(`<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n${bare('x')}\n</system-reminder>`))).toBe(true);
  });

  it('a reminder beside the block that holds only the host\'s list of the tools used keeps the row a notification, before the block or after it', () => {
    const tools = '<system-reminder>\n<tools-used-before-summary>Read, Write, advisor</tools-used-before-summary>\n</system-reminder>';
    expect(isNotification(row(`${tools}\n<system-reminder>\n${bare('x')}\n</system-reminder>`))).toBe(true);
    expect(isNotification(row(`<system-reminder>\n${bare('x')}\n</system-reminder>\n${tools}`))).toBe(true);
    expect(isNotification(row(`<system-reminder id="jev-1">\n${tools}\n<system-reminder>\n${bare('x')}\n</system-reminder>\n</system-reminder id="jev-1">`))).toBe(true);
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

  it('reads a notification block that opens with an attribute as a block: the words that follow it make a row that opens with the marker a mixed one', () => {
    const marker = '[SYSTEM NOTIFICATION - NOT USER INPUT]\n';
    const opens = ['<task-notification status="done">', '<task-notification >', `<task-notification note="${'a'.repeat(300)}">`, '<task-notification\nstatus="done">'];
    for (const open of opens) {
      const block = (text) => bare(text).replace('<task-notification>', open);
      expect(isNotification(row(`${marker}${block('x')}`)), open).toBe(true);
      expect(isNotification(row(`${marker}${block('x')}\n${block('y')}`)), open).toBe(true);
      expect(isNotification(row(`${marker}${block('x')}\nDo not change the production database.`)), open).toBe(false);
      expect(isNotification(row(`${marker}${block('x')}\n${block('y')}\nDo not change the production database.`)), open).toBe(false);
      expect(isNotification(row(`${marker}Do not change the production database.\n${block('x')}`)), open).toBe(false);
      expect(isNotification(row(`${block('x')}\nDo not change the production database.`)), open).toBe(false);
    }
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
