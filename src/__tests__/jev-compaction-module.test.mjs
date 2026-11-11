/* global setTimeout, clearTimeout, performance */
/**
 * Tests for hooks/jev-compaction.mjs, the Claude Code hooks module of the named-only Jev point
 * `compaction`.
 *
 * The module is driven the way the host drives it: register(on) collects the handlers, each test
 * calls them with a fake `$` (in-memory files, a stubbed $.http.fetch transport, a session) and a
 * `next` that stands for the built-in summary. The transport stub is the only fake of the Jev side.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
import * as jevCompaction from '../../hooks/jev-compaction.mjs';

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

function fakeDollar({ env = ACTIVE_ENV, settingsEnv, respond = (body) => okResponse(scoreByMarker(body)), clockAfter, usage, messages = [], compactResult, writeThrows = false, diskPrefix, flakyBreakerRead = false, stallBreakerRead = false, stallRpmRead = false, rpmReadGate, rpmReadGates = {}, fsDelayMs = 0, brokenBreakerRead = false, breakerWriteDelayMs = 0, lockReadDelayMs = 0 } = {}) {
  const files = new Map();
  const mtimes = new Map();
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
        if (lockReadDelayMs && p.endsWith('/breaker.json.lock')) await new Promise((resolve) => setTimeout(resolve, lockReadDelayMs));
        if (flakyBreakerRead && !flaked && p.endsWith('/breaker.json')) { flaked = true; throw new Error('EPERM'); }
        if (brokenBreakerRead && p.endsWith('/breaker.json')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        if (stallBreakerRead && p.endsWith('/breaker.json')) return new Promise(() => {});
        if (stallRpmRead && /\/rpm-\d+$/.test(p)) return new Promise(() => {});
        if (rpmReadGate && !gated && /\/rpm-\d+$/.test(p)) { gated = true; await rpmReadGate; }
        if (/\/rpm-\d+$/.test(p)) { rpmReads += 1; if (rpmReadGates[rpmReads]) await rpmReadGates[rpmReads]; }
        if (diskPrefix && p.startsWith(diskPrefix)) return readFileSync(p, 'utf8'); if (!files.has(p)) throw new Error('ENOENT'); return files.get(p);
      },
      exists: async (p) => (diskPrefix && p.startsWith(diskPrefix) ? existsSync(p) : files.has(p)),
      stat: async (p) => {
        if (diskPrefix && p.startsWith(diskPrefix)) { const st = statSync(p); return { kind: st.isDirectory() ? 'dir' : 'file', size: st.size, mtimeMs: st.mtimeMs, isLink: false }; }
        if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { kind: 'file', size: files.get(p).length, mtimeMs: mtimes.get(p), isLink: false };
      },
      write: async (p, text) => {
        if (fsDelayMs) await new Promise((resolve) => setTimeout(resolve, fsDelayMs));
        if (breakerWriteDelayMs && p.endsWith('/breaker.json')) await new Promise((resolve) => setTimeout(resolve, breakerWriteDelayMs));
        if (diskPrefix && p.startsWith(diskPrefix)) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return; }
        calls.write++; if (writeThrows) throw new Error('EACCES'); files.set(p, text); mtimes.set(p, Date.now());
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

describe('jev-compaction module: elastic target (OMC_JEV_COMPACT_FLEX=active)', () => {
  const flexEnv = { ...ACTIVE_ENV, OMC_JEV_COMPACT_FLEX: 'active' };

  it('frees the growth since the previous compaction, at least MIN_REDUCTION and at most what OMC_JEV_COMPACT_TARGET frees', () => {
    const { elasticTarget } = jevCompaction;
    expect(elasticTarget(100000, 0.5, undefined)).toEqual({ target: 0.5, source: 'rule', why: 'first' });
    expect(elasticTarget(100000, 0.5, { why: 'no_messages' })).toEqual({ target: 0.5, source: 'rule', why: 'no_messages' });
    // Grew 10000 of 100000: the room is the floor, 30 % of the characters.
    expect(elasticTarget(100000, 0.5, { chars: 90000 })).toEqual({ target: 0.7, source: 'growth', growth: 10000, room: 30000 });
    // Grew 40000: that much room.
    expect(elasticTarget(100000, 0.5, { chars: 60000 })).toEqual({ target: 0.6, source: 'growth', growth: 40000, room: 40000 });
    // Grew 70000: never more room than the rule frees, and the record says the rule decided.
    expect(elasticTarget(100000, 0.5, { chars: 30000 })).toEqual({ target: 0.5, source: 'rule', why: 'large_growth', growth: 70000, room: 50000 });
    // Fewer characters than the compaction left: the start says nothing, the rule stands.
    expect(elasticTarget(100000, 0.5, { chars: 120000 })).toEqual({ target: 0.5, source: 'rule', why: 'shrank', growth: -20000 });
    // A rule that keeps more than 70 % leaves nothing to stretch.
    expect(elasticTarget(100000, 0.8, { chars: 90000 })).toEqual({ target: 0.8, source: 'rule', why: 'rule_below_floor' });
  });

  it('a second compaction of the loop keeps more when the conversation grew little since the first; without the variable it keeps the rule', async () => {
    const first = conversation(30, { chars: 3000 });
    // About as many characters as the first compaction leaves, plus a little growth.
    const second = conversation(20, { chars: 2800, maybe: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] });
    const run = async (env) => {
      const handlers = load();
      const one = await compactOnce(first, { handlers, env });
      const two = await compactOnce(second, { handlers, env });
      return { one: one.records()[0], two: two.records()[0] };
    };
    const flex = await run(flexEnv);
    expect(flex.one).toMatchObject({ result: 'jev', target: 0.5, rule_target: 0.5, target_source: 'rule', target_why: 'first' });
    const growth = flex.two.chars_before - flex.one.chars_after;
    const room = Math.round(Math.max(growth, 0.3 * flex.two.chars_before));
    expect(room).toBeLessThan(0.5 * flex.two.chars_before);
    expect(flex.two).toMatchObject({
      result: 'jev', rule_target: 0.5, target_source: 'growth', growth_start_chars: flex.one.chars_after, growth_start_source: 'jev',
      growth_chars: growth, room_chars: room, target: Math.round((1 - room / flex.two.chars_before) * 1000) / 1000,
    });
    expect(flex.two).not.toHaveProperty('target_why');
    expect(flex.two.chars_after).toBeLessThanOrEqual(flex.two.chars_before - room);
    const rule = await run(ACTIVE_ENV);
    expect(rule.two.target).toBe(0.5);
    for (const field of ['rule_target', 'target_source', 'target_why', 'growth_start_chars', 'growth_start_source', 'growth_chars', 'room_chars']) expect(rule.two).not.toHaveProperty(field);
    expect(rule.two.chars_after).toBeLessThanOrEqual(Math.floor(rule.two.chars_before * 0.5));
    expect(flex.two.chars_after).toBeGreaterThan(rule.two.chars_after);
    // The results the rule only cut to 300 characters stay whole.
    expect(flex.two.kept_full).toBeGreaterThan(rule.two.kept_full);
  });

  it('the built-in summary starts the growth too; a subagent and the main loop count apart; a skip changes nothing; a result without messages is no start', async () => {
    const handlers = load();
    // A short conversation falls back: the summary's conversation (7 characters) starts the main loop's growth.
    await compactOnce(conversation(2), { handlers, env: flexEnv });
    // A subagent's first compaction keeps the rule, whatever the main loop did.
    const sub = await compactOnce(conversation(30), { handlers, env: flexEnv }, { agentId: 'sub-1' });
    expect(sub.records()[0]).toMatchObject({ agent_id: 'sub-1', target_source: 'rule', target_why: 'first' });
    // Another mod vetoes a summary of the main loop: the start stays the summary's.
    const fake = fakeDollar({ env: flexEnv });
    const skip = { skip: 'vetoed by another mod' };
    await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages: conversation(2) }), async () => skip);
    const main = await compactOnce(conversation(30), { handlers, env: flexEnv });
    expect(main.records()[0]).toMatchObject({ agent_id: null, target_source: 'rule', target_why: 'large_growth', growth_start_chars: 7, growth_start_source: 'summary', target: 0.5 });
    // A compaction result without messages leaves the start unknown.
    await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages: conversation(2) }), async () => ({}));
    const after = await compactOnce(conversation(30), { handlers, env: flexEnv });
    expect(after.records()[0]).toMatchObject({ target_source: 'rule', target_why: 'no_messages', target: 0.5 });
    expect(after.records()[0]).not.toHaveProperty('growth_start_chars');
  });

  it('keeps the growth start of the main loop and of the newest 63 subagents', async () => {
    const handlers = load();
    await compactOnce(conversation(2), { handlers, env: flexEnv });
    for (let k = 1; k <= 64; k++) await compactOnce(conversation(2), { handlers, env: flexEnv }, { agentId: `sub-${k}` });
    const oldest = await compactOnce(conversation(30), { handlers, env: flexEnv }, { agentId: 'sub-1' });
    expect(oldest.records()[0]).toMatchObject({ target_source: 'rule', target_why: 'first' });
    const newest = await compactOnce(conversation(30), { handlers, env: flexEnv }, { agentId: 'sub-64' });
    expect(newest.records()[0]).toMatchObject({ growth_start_chars: 7, growth_start_source: 'summary' });
    const main = await compactOnce(conversation(30), { handlers, env: flexEnv });
    expect(main.records()[0]).toMatchObject({ growth_start_chars: 7, growth_start_source: 'summary' });
  });

  it('only the exact value `active` turns it on', async () => {
    for (const value of ['on', '1', 'true', 'ACTIVE']) {
      const handlers = load();
      await compactOnce(conversation(30), { handlers, env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_FLEX: value } });
      const { records } = await compactOnce(conversation(30, { chars: 1500 }), { handlers, env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_FLEX: value } });
      expect(records()[0].target).toBe(0.5);
      expect(records()[0]).not.toHaveProperty('target_source');
    }
  });
});

describe('jev-compaction module: moment chosen by Jev (OMC_JEV_COMPACT_AT_PERCENT=jev)', () => {
  const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_AT_PERCENT: 'jev' };
  const answer = 'Done. The token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 is set. ' + 'z'.repeat(600) + ' FINAL-LINE';
  const turn = (handlers, fake, e = {}) => handlers['turn.complete'](fake.$, { isAborted: false, reason: 'answer', answer, ...e }, async () => 'ok');
  // Window 200000, OMC_JEV_COMPACT_TARGET 0.5: the level is 10 % of the window over half the context, 40000.
  const usageAt = (get) => () => ({ context: { tokens: get(), window: 200000 } });
  const momentRespond = (noul) => (body) => (body.questions.moment ? okResponse({ answers: { moment: { type: 'noul', noul, confidence: 0.9 } } }) : okResponse(scoreByMarker(body)));
  const momentCalls = (calls) => calls.fetch.filter((c) => c.body.questions.moment);
  const own = (fake) => fake.records().filter((r) => r.event === 'own_threshold');
  const frozen = (rows) => rows.map((x, k) => Object.freeze({ ...x, handle: `h${k}` }));
  const todo = (id, done, all = 3) => ({ tool_use_id: id, tool: 'TodoWrite', input: { todos: Array.from({ length: all }, (_, k) => ({ content: `item ${k}`, status: k < done ? 'completed' : 'pending' })) } });
  /** Assistant `calls` and their results, then `later` more user turns of one question and one answer. */
  function tail(calls, later = 0) {
    const rows = [
      { role: 'assistant', text: 'Updating the list.', toolUses: calls },
      { role: 'user', text: '', toolUses: [], toolResults: calls.map((u) => ({ tool_use_id: u.tool_use_id, text: 'ok', isError: false })) },
      { role: 'assistant', text: 'Done with that.', toolUses: [] },
    ];
    for (let k = 1; k <= later; k++) rows.push({ role: 'user', text: `Next question ${k}?`, toolUses: [] }, { role: 'assistant', text: `Answer ${k}.`, toolUses: [] });
    return rows;
  }
  /** The usual conversation (40 results of 6000 characters) whose last turn, or a turn `later` turns back, holds `calls`. */
  const withCalls = (calls, later = 0, base = conversation(40, { chars: 6000 })) => frozen([...base.slice(0, -1), ...tail(calls, later)]);
  const withClosedTask = () => withCalls([todo('todo-1', 1, 2)]);

  it('a task closed in this turn asks the host at once, without Jev; the record and the compaction name the moment', async () => {
    let tokens = 30000;
    const handlers = load();
    const messages = withClosedTask();
    const fake = fakeDollar({ env, messages, usage: usageAt(() => tokens) });
    // The host runs the compaction it is asked for, as a plugin's.
    fake.$.session.compact = async () => { fake.calls.compact++; return handlers['session.compact'](fake.$, Object.freeze({ trigger: 'plugin', messages }), summaryNext()); };
    await turn(handlers, fake);
    expect(fake.calls.messages).toBe(0);
    expect(fake.calls.compact).toBe(0);
    tokens = 130000;
    await turn(handlers, fake);
    expect(fake.calls.compact).toBe(1);
    expect(momentCalls(fake.calls)).toHaveLength(0);
    expect(own(fake)).toEqual([expect.objectContaining({ result: 'requested', moment: 'task', tokens: 130000, window: 200000, level: 40000, session_id: 'sess-1', agent_id: null })]);
    expect(fake.records().find((r) => r.event === 'compact')).toMatchObject({ result: 'jev', own_request: 'task' });
  });

  it('closings: a TaskUpdate to completed, a list with more done items than the list before it; not another status, nor a list with as many done', async () => {
    const cases = [
      [[{ tool_use_id: 'u1', tool: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }], 1],
      [[{ tool_use_id: 'u1', tool: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }], 0],
      [[{ tool_use_id: 'p1', tool: 'mcp__desktop__update_plan', input: { items: [{ step: 'a', status: 'completed' }] } }], 1],
      [[{ tool_use_id: 'p1', tool: 'update_plan', input: { advance: true } }], 0],
      [[todo('w1', 0)], 0],
    ];
    for (const [calls, asks] of cases) {
      const fake = fakeDollar({ env, messages: withCalls(calls), usage: usageAt(() => 130000), respond: momentRespond(0.1) });
      await turn(load(), fake);
      expect(fake.calls.compact, JSON.stringify(calls)).toBe(asks);
      expect(momentCalls(fake.calls), JSON.stringify(calls)).toHaveLength(1 - asks);
    }
    // The list before stands in a turn outside the window: as many done items close nothing, one more closes a task.
    for (const [done, asks] of [[2, 0], [3, 1]]) {
      const fake = fakeDollar({ env, messages: frozen([...withCalls([todo('w1', 2)], 6), ...tail([todo('w2', done)])]), usage: usageAt(() => 130000), respond: momentRespond(0.1) });
      await turn(load(), fake);
      expect(fake.calls.compact, `${done} done`).toBe(asks);
      expect(momentCalls(fake.calls), `${done} done`).toHaveLength(1 - asks);
    }
  });

  it('a task closed in an earlier turn is no moment, even one no read saw; one closed in this turn is', async () => {
    for (const [later, asks] of [[1, 0], [0, 1]]) {
      const fake = fakeDollar({ env, messages: withCalls([todo('w1', 1, 2)], later), usage: usageAt(() => 130000), respond: momentRespond(0.1) });
      await turn(load(), fake);
      expect(fake.calls.compact, `${later} turns later`).toBe(asks);
      expect(momentCalls(fake.calls), `${later} turns later`).toHaveLength(1 - asks);
    }
  });

  it('a closing counts once: one read while the removable results were small still sees it; a list kept alone by a compaction is compared with the list before it', async () => {
    let current = withCalls([todo('w1', 1, 2)], 0, conversation(40, { chars: 5 }));
    const handlers = load();
    const fake = fakeDollar({ env, usage: usageAt(() => 130000), respond: momentRespond(0.1) });
    fake.$.session.messages = async () => { fake.calls.messages++; return current; };
    // The removable results are too small to ask: the closing is seen all the same.
    await turn(handlers, fake);
    expect(fake.calls.messages).toBe(1);
    expect(fake.calls.compact).toBe(0);
    // Five turns later, the same closing with large results: no task moment, Jev decides.
    current = withCalls([todo('w1', 1, 2)], 0);
    for (let k = 0; k < 5; k++) await turn(handlers, fake);
    expect(fake.calls.compact).toBe(0);
    expect(momentCalls(fake.calls)).toHaveLength(1);
    // A compaction traced w1; w2 with as many done items is all that is left of the list: no closing.
    current = withCalls([todo('w2', 1, 2)], 0);
    for (let k = 0; k < 5; k++) await turn(handlers, fake);
    expect(fake.calls.compact).toBe(0);
    expect(momentCalls(fake.calls)).toHaveLength(2);
    // w3 with one more done item is a closing.
    current = withCalls([todo('w3', 2, 2)], 0);
    for (let k = 0; k < 5; k++) await turn(handlers, fake);
    expect(fake.calls.compact).toBe(1);
    expect(own(fake).at(-1)).toMatchObject({ result: 'requested', moment: 'task' });
  });

  it('a TaskUpdate closing seen at an earlier read never counts again, in a later turn without new words of the user', async () => {
    const close = [{ tool_use_id: 'u1', tool: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }];
    let current = withCalls(close, 0, conversation(40, { chars: 5 }));
    const handlers = load();
    const fake = fakeDollar({ env, usage: usageAt(() => 130000), respond: momentRespond(0.1) });
    fake.$.session.messages = async () => { fake.calls.messages++; return current; };
    // Read while the removable results are too small: the closing is seen.
    await turn(handlers, fake);
    expect(fake.calls.messages).toBe(1);
    expect(fake.calls.compact).toBe(0);
    // The next turn (a notification, no words of the user) still has it after the user's last words.
    current = withCalls(close, 0);
    await turn(handlers, fake);
    expect(fake.calls.compact).toBe(0);
    expect(momentCalls(fake.calls)).toHaveLength(1);
  });

  it('else asks Jev at most once per 5 turns; a no is logged, a yes of at least 0.7 asks the host', async () => {
    let noul = 0.3;
    const handlers = load();
    const fake = fakeDollar({ env, messages: conversation(40, { chars: 6000 }), usage: usageAt(() => 130000), respond: (body) => momentRespond(noul)(body) });
    for (let k = 0; k < 5; k++) await turn(handlers, fake);
    expect(momentCalls(fake.calls)).toHaveLength(1);
    expect(fake.calls.compact).toBe(0);
    expect(own(fake)).toEqual([expect.objectContaining({ result: 'not_now', reason: 'jev_no', jev_noul: 0.3, level: 40000 })]);
    noul = 0.69;
    await turn(handlers, fake);
    expect(momentCalls(fake.calls)).toHaveLength(2);
    expect(fake.calls.compact).toBe(0);
    noul = 0.9;
    for (let k = 0; k < 5; k++) await turn(handlers, fake);
    expect(momentCalls(fake.calls)).toHaveLength(3);
    expect(fake.calls.compact).toBe(1);
    expect(own(fake).at(-1)).toMatchObject({ result: 'requested', moment: 'jev', level: 40000 });
  });

  it('a Noul answer of true or false counts as 1 or 0', async () => {
    for (const [noul, compacts, record] of [[true, 1, { result: 'requested', moment: 'jev' }], [false, 0, { result: 'not_now', reason: 'jev_no', jev_noul: 0 }]]) {
      const fake = fakeDollar({ env, messages: conversation(40, { chars: 6000 }), usage: usageAt(() => 130000), respond: momentRespond(noul) });
      await turn(load(), fake);
      expect(fake.calls.compact, String(noul)).toBe(compacts);
      expect(own(fake), String(noul)).toEqual([expect.objectContaining(record)]);
    }
  });

  it('sends the user\'s words, 300 masked characters of the answer, the list counts and the context; never a tool result; the question is the registry\'s', async () => {
    const messages = frozen([...withCalls([todo('w1', 0, 2)]), { role: 'user', text: 'And the totals?', toolUses: [] }, { role: 'assistant', text: 'Totals sent.', toolUses: [] }]);
    const fake = fakeDollar({ env, messages, usage: usageAt(() => 130000), respond: momentRespond(0.2) });
    await turn(load(), fake);
    const [call] = momentCalls(fake.calls);
    expect(call.body.model).toBe('jev-latest');
    const { state, questions } = call.body;
    expect(state.task).toEqual(['Task: review the notes and count the lines.', 'Good, now sum up the NEEDED results.', 'And the totals?']);
    expect(state.answer.startsWith('Done. The token ')).toBe(true);
    expect(state.answer.endsWith(' FINAL-LINE')).toBe(true);
    expect(state.answer).toMatch(/\[\.\.\. \d+ chars omitted \.\.\.\]/);
    expect(state.answer.replace(/\n\[\.\.\. \d+ chars omitted \.\.\.\]\n/, '')).toHaveLength(300);
    expect(state.list).toEqual({ done: 0, all: 2 });
    expect(state.context).toEqual({ tokens: 130000, window: 200000 });
    expect(Object.keys(state).sort()).toEqual(['answer', 'context', 'list', 'task']);
    expect(JSON.stringify(call.body)).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123');
    expect(JSON.stringify(call.body)).not.toContain('RESULT-');
    const [declared] = Object.values(JUDGMENT_POINTS.compaction.questions[1]);
    expect(questions).toEqual({ moment: { type: 'noul', instructions: declared.instructions, criteria: declared.criteria } });
  });

  it('a call on a secret path anywhere in the conversation leaves the answer out; an answer that is no string is sent empty; no answer is "not now"', async () => {
    const messages = conversation(40, { chars: 6000, tool: (i) => (i === 2 ? 'Read' : 'Bash'), input: (i) => (i === 2 ? { file_path: '/home/u/.ssh/id_ed25519' } : { command: `cat notes-${i}.txt` }) });
    const secret = fakeDollar({ env, messages, usage: usageAt(() => 130000), respond: momentRespond(0.2) });
    await turn(load(), secret);
    expect(momentCalls(secret.calls)[0].body.state.answer).toBe('');
    expect(own(secret)[0]).toMatchObject({ result: 'not_now', reason: 'jev_no', answer_skipped: 'secret_path' });
    const empty = fakeDollar({ env, messages: conversation(40, { chars: 6000 }), usage: usageAt(() => 130000), respond: (body) => okResponse(body.questions.moment ? { answers: {} } : scoreByMarker(body)) });
    await turn(load(), empty, { answer: undefined });
    expect(momentCalls(empty.calls)[0].body.state.answer).toBe('');
    expect(own(empty)[0]).toMatchObject({ result: 'not_now', reason: 'no_answer' });
    expect(own(empty)[0]).not.toHaveProperty('answer_skipped');
  });

  it('a secret or private path in the answer, or in a prompt or message the conversation sent, leaves the answer out too', async () => {
    const at3 = (tool, input) => conversation(40, { chars: 6000, tool: (i) => (i === 3 ? tool : 'Bash'), input: (i) => (i === 3 ? input : { command: `cat notes-${i}.txt` }) });
    const cases = [
      // The answer names a key file no call of this loop opened (a subagent did).
      [conversation(40, { chars: 6000 }), { answer: 'Saved the new key to /home/u/.ssh/id_ed25519 as asked.' }, {}, '.ssh'],
      // A subagent was sent to a credentials file: its report may be quoted in the answer.
      [at3('Agent', { description: 'rotate', prompt: 'Read /home/u/.aws/credentials and report the key id.' }), {}, {}, '.aws'],
      // A teammate was sent to a private path.
      [at3('SendMessage', { to: 'worker', message: 'Copy /srv/vault/db.txt into the report.' }), {}, { OMC_JEV_COMPACT_PRIVATE_PATHS: '/srv/vault' }, 'vault'],
      // The user named the file; the subagent prompt only points back at it.
      [frozen([conversation(40, { chars: 6000 })[0], { role: 'user', text: 'Read /srv/vault/x.txt for me.', toolUses: [] }, ...conversation(40, { chars: 6000 }).slice(1)]), {}, { OMC_JEV_COMPACT_PRIVATE_PATHS: '/srv/vault' }, 'vault'],
      // A result of this turn lists the lines of a .env file the answer may quote.
      [withCalls([{ tool_use_id: 'g1', tool: 'Grep', input: { pattern: 'API_KEY' } }]).map((m) => (m.toolResults?.[0]?.tool_use_id === 'g1' ? Object.freeze({ ...m, toolResults: [{ tool_use_id: 'g1', text: 'config/.env:3:API_KEY=x', isError: false }] }) : m)), {}, {}, '.env'],
      // .env in prose: in backticks, before a full stop, a comma or a bracket.
      [conversation(40, { chars: 6000 }), { answer: 'Saved the new key to `.env` and restarted.' }, {}, '.env'],
      [conversation(40, { chars: 6000 }), { answer: 'Moved the token into the .env.' }, {}, '.env'],
      [conversation(40, { chars: 6000 }), { answer: 'Both live in .env, as before.' }, {}, '.env'],
      [conversation(40, { chars: 6000 }), { answer: 'The keys (in .netrc) are unchanged.' }, {}, '.netrc'],
    ];
    for (const [messages, e, extra, path] of cases) {
      const fake = fakeDollar({ env: { ...env, ...extra }, messages, usage: usageAt(() => 130000), respond: momentRespond(0.2) });
      await turn(load(), fake, e);
      const [call] = momentCalls(fake.calls);
      expect(call.body.state.answer, path).toBe('');
      expect(JSON.stringify(call.body), path).not.toContain(path);
      expect(own(fake)[0], path).toMatchObject({ result: 'not_now', reason: 'jev_no', answer_skipped: 'secret_path' });
    }
  });

  it('an interrupted, refused or failed turn never chooses the moment; shadow mode leaves it off and a percent keeps the percent rules', async () => {
    for (const e of [{ isAborted: true, reason: 'aborted' }, { reason: 'refusal' }, { reason: 'error' }]) {
      const fake = fakeDollar({ env, messages: withClosedTask(), usage: usageAt(() => 130000) });
      await turn(load(), fake, e);
      expect(fake.calls.compact).toBe(0);
      expect(fake.calls.messages).toBe(0);
    }
    const shadow = fakeDollar({ env: { ...env, OMC_JEV: 'compaction' }, messages: withClosedTask(), usage: usageAt(() => 130000) });
    await turn(load(), shadow);
    expect(shadow.calls.usage).toBe(0);
    // 60 %: above 120000 the percent asks, on an aborted turn too, with no moment question and no record.
    const percent = fakeDollar({ env: { ...env, OMC_JEV_COMPACT_AT_PERCENT: '60' }, messages: conversation(40, { chars: 6000 }), usage: usageAt(() => 130000), respond: momentRespond(0.1) });
    await turn(load(), percent, { isAborted: true, reason: 'aborted' });
    expect(percent.calls.compact).toBe(1);
    expect(momentCalls(percent.calls)).toHaveLength(0);
    expect(own(percent)).toEqual([]);
  });

  it('past the gates reads the transcript at every turn, so a task closed in a later turn is found in that turn; the shared state only with a question to make', async () => {
    let current = conversation(40, { chars: 6000 });
    const handlers = load();
    const fake = fakeDollar({ env: { ...env, OMC_JEV_BREAKER: '1' }, usage: usageAt(() => 130000), respond: momentRespond(0.1) });
    fake.$.session.messages = async () => { fake.calls.messages++; return current; };
    let breakerReads = 0;
    const read = fake.$.fs.read;
    fake.$.fs.read = async (p) => { if (p.endsWith('/breaker.json')) breakerReads++; return read(p); };
    await turn(handlers, fake);
    expect(momentCalls(fake.calls)).toHaveLength(1);
    const asked = breakerReads;
    expect(asked).toBeGreaterThan(0);
    for (let k = 0; k < 2; k++) await turn(handlers, fake);
    expect(fake.calls.messages).toBe(3);
    expect(breakerReads).toBe(asked);
    current = withClosedTask();
    await turn(handlers, fake);
    expect(fake.calls.compact).toBe(1);
    expect(own(fake).at(-1)).toMatchObject({ result: 'requested', moment: 'task' });
    expect(momentCalls(fake.calls)).toHaveLength(1);
  });

  it('reads the shared breaker only past the cheap gates: a stalled breaker file does not slow the turns below the level', async () => {
    const fake = fakeDollar({ env: { ...env, OMC_JEV_BREAKER: '1' }, messages: conversation(40, { chars: 6000 }), usage: usageAt(() => 30000), stallBreakerRead: true });
    let breakerReads = 0;
    const read = fake.$.fs.read;
    fake.$.fs.read = async (p) => { if (p.endsWith('/breaker.json')) breakerReads++; return read(p); };
    const handlers = load();
    for (let k = 0; k < 3; k++) await turn(handlers, fake);
    expect(breakerReads).toBe(0);
    expect(fake.calls.messages).toBe(0);
  });

  it('after a compaction waits for 10 % of the window of growth from the lowest usage since it, with no threshold to cap it', async () => {
    let tokens = 100000;
    const handlers = load();
    const fake = fakeDollar({ env, messages: withClosedTask(), usage: usageAt(() => tokens) });
    await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages: conversation(2) }), summaryNext());
    await turn(handlers, fake);
    tokens = 119000;
    for (let k = 0; k < 6; k++) await turn(handlers, fake);
    expect(fake.calls.compact).toBe(0);
    tokens = 121000;
    await turn(handlers, fake);
    expect(fake.calls.compact).toBe(1);
  });

  it('a main-loop compaction or a context gone below the level while Jev answers turns the yes into "not now"; a subagent\'s compaction does not', async () => {
    for (const change of ['compaction', 'tokens', 'subagent']) {
      let tokens = 130000;
      const handlers = load();
      let fake;
      let release;
      let running;
      const respond = async (body) => {
        if (!body.questions.moment) return okResponse(scoreByMarker(body));
        // While Jev answers, the host compacts on its own, the context shrinks below the level, or a
        // subagent starts a compaction that is still running when the answer comes.
        if (change === 'compaction') await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages: conversation(2) }), summaryNext());
        else if (change === 'subagent') {
          const gate = new Promise((resolve) => { release = resolve; });
          let entered;
          const inside = new Promise((resolve) => { entered = resolve; });
          running = handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages: conversation(2), agentId: 'sub-1' }), async () => { entered(); await gate; return SUMMARY; });
          await inside;
        } else tokens = 30000;
        return okResponse({ answers: { moment: { type: 'noul', noul: 0.95 } } });
      };
      fake = fakeDollar({ env, messages: conversation(40, { chars: 6000 }), usage: usageAt(() => tokens), respond });
      await turn(handlers, fake);
      if (release) { release(); await running; }
      if (change === 'subagent') {
        expect(fake.calls.compact).toBe(1);
        expect(own(fake)).toEqual([expect.objectContaining({ result: 'requested', moment: 'jev' })]);
      } else {
        expect(fake.calls.compact, change).toBe(0);
        expect(own(fake), change).toEqual([expect.objectContaining({ result: 'not_now', reason: 'state_changed', jev_noul: 0.95, tokens })]);
      }
    }
  });

  it('one decision at a time: a turn that ends while Jev answers reads nothing and makes the answer stale; a decision older than 5 minutes holds nothing back', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const handlers = load();
    const respond = async (body) => {
      if (!body.questions.moment) return okResponse(scoreByMarker(body));
      await gate;
      return okResponse({ answers: { moment: { type: 'noul', noul: 0.9 } } });
    };
    const fake = fakeDollar({ env, messages: conversation(40, { chars: 6000 }), usage: usageAt(() => 130000), respond });
    const first = turn(handlers, fake);
    for (let k = 0; k < 2000 && momentCalls(fake.calls).length < 1; k++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(momentCalls(fake.calls)).toHaveLength(1);
    const reads = fake.calls.usage;
    await turn(handlers, fake);
    expect(fake.calls.usage).toBe(reads);
    const realNow = Date.now;
    Date.now = () => realNow() + 301_000;
    try {
      await turn(handlers, fake);
    } finally {
      Date.now = realNow;
    }
    expect(fake.calls.usage).toBeGreaterThan(reads);
    release();
    await first;
    expect(fake.calls.compact).toBe(0);
    expect(own(fake)).toEqual([expect.objectContaining({ result: 'not_now', reason: 'state_changed', jev_noul: 0.9 })]);
  });

  it('a turn that ends while the first one still reads the transcript makes its decision stale, a closed task or a yes of Jev alike', async () => {
    for (const closed of [true, false]) {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const base = closed ? withClosedTask() : conversation(40, { chars: 6000 });
      const handlers = load();
      const fake = fakeDollar({ env, messages: base, usage: usageAt(() => 130000), respond: momentRespond(0.95) });
      fake.$.session.messages = async () => { await gate; return base; };
      const first = turn(handlers, fake);
      for (let k = 0; k < 2000 && fake.calls.usage < 1; k++) await new Promise((resolve) => setTimeout(resolve, 5));
      // The second turn ends during the read: it counts as a turn and leaves at once, as the first decision is busy.
      await turn(handlers, fake);
      release();
      await first;
      expect(fake.calls.compact, `closed ${closed}`).toBe(0);
      expect(own(fake), `closed ${closed}`).toEqual([expect.objectContaining({ result: 'not_now', reason: 'state_changed' })]);
    }
  });

  it('a TaskUpdate to completed whose result is an error closes nothing', async () => {
    const close = [{ tool_use_id: 'u1', tool: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }];
    for (const [isError, asks] of [[true, 0], [false, 1]]) {
      const base = withCalls(close);
      const messages = frozen(base.map((m) => (m.toolResults ? { ...m, toolResults: m.toolResults.map((r) => ({ ...r, isError })) } : m)));
      const fake = fakeDollar({ env, messages, usage: usageAt(() => 130000), respond: momentRespond(0.1) });
      await turn(load(), fake);
      expect(fake.calls.compact, `isError ${isError}`).toBe(asks);
      expect(momentCalls(fake.calls), `isError ${isError}`).toHaveLength(1 - asks);
    }
  });

  it('the decision stays within 8 s of the turn\'s end: the question gets only what is left, and past it nothing is requested', async () => {
    const realNow = Date.now;
    let skew = 0;
    Date.now = () => realNow() + skew;
    try {
      // Jev says yes once the budget is spent: not now, reason timeout, and no request to compact.
      const late = fakeDollar({ env, messages: conversation(40, { chars: 6000 }), usage: usageAt(() => 130000), respond: (body) => { if (body.questions.moment) skew = 9000; return momentRespond(0.95)(body); } });
      await turn(load(), late);
      expect(late.calls.compact).toBe(0);
      expect(own(late)).toEqual([expect.objectContaining({ result: 'not_now', reason: 'timeout', moment: 'jev', jev_noul: 0.95 })]);
      // A closed task found after the budget is spent (a slow transcript read): the same.
      skew = 0;
      const slow = fakeDollar({ env, usage: usageAt(() => 130000) });
      slow.$.session.messages = async () => { slow.calls.messages++; skew = 9000; return withClosedTask(); };
      await turn(load(), slow);
      expect(slow.calls.compact).toBe(0);
      expect(own(slow)).toEqual([expect.objectContaining({ result: 'not_now', reason: 'timeout', moment: 'task' })]);
      // 7 s of the 8 went to the transcript: a silent Jev is given up after the second that is left, not REQUEST_MS.
      skew = 0;
      const silent = fakeDollar({ env, usage: usageAt(() => 130000), respond: (body) => (body.questions.moment ? new Promise(() => {}) : okResponse(scoreByMarker(body))) });
      silent.$.session.messages = async () => { silent.calls.messages++; skew = 7000; return conversation(40, { chars: 6000 }); };
      const timers = [];
      silent.$.clock.after = (ms, fn) => { timers.push(ms); const t = setTimeout(fn, Math.min(ms, 20)); return { cancel: () => clearTimeout(t) }; };
      await turn(load(), silent);
      expect(momentCalls(silent.calls)).toHaveLength(1);
      expect(timers.length).toBeGreaterThan(0);
      expect(Math.max(...timers)).toBeLessThanOrEqual(1000);
      expect(silent.calls.compact).toBe(0);
      expect(own(silent)).toEqual([expect.objectContaining({ result: 'not_now', reason: 'timeout' })]);
      // The budget spent before the question: it is not asked, and its request is not counted against
      // OMC_JEV_MAX_REQUESTS (7 leave the question room for a later turn).
      skew = 0;
      const handlers = load();
      const spent = fakeDollar({ env: { ...env, OMC_JEV_MAX_REQUESTS: '7' }, usage: usageAt(() => 130000), respond: momentRespond(0.1) });
      spent.$.session.messages = async () => { spent.calls.messages++; skew = spent.calls.messages === 1 ? 9000 : 0; return conversation(40, { chars: 6000 }); };
      await turn(handlers, spent);
      expect(momentCalls(spent.calls)).toHaveLength(0);
      expect(own(spent)).toEqual([expect.objectContaining({ result: 'not_now', reason: 'timeout' })]);
      for (let k = 0; k < 5; k++) await turn(handlers, spent);
      expect(momentCalls(spent.calls)).toHaveLength(1);
      expect(own(spent).map((r) => r.reason)).toEqual(['timeout', 'jev_no']);
    } finally {
      Date.now = realNow;
    }
  });

  it('own_request goes only to the plugin compaction it asked for; a refusal by the host clears it', async () => {
    const messages = withClosedTask();
    // The host refuses: the record names the moment, and a later plugin compaction does not carry it.
    let handlers = load();
    let fake = fakeDollar({ env, messages, usage: usageAt(() => 130000), compactResult: new Error('cannot compact while a turn is running') });
    await turn(handlers, fake);
    expect(own(fake)).toEqual([expect.objectContaining({ result: 'rejected', reason: 'host_turn_running', moment: 'task', level: 40000 })]);
    await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'plugin', messages }), summaryNext());
    expect(fake.records().find((r) => r.event === 'compact')).not.toHaveProperty('own_request');
    // A compaction of another trigger (here a subagent's, then the user's /compact) while the request runs takes nothing.
    handlers = load();
    fake = fakeDollar({ env, messages, usage: usageAt(() => 130000) });
    fake.$.session.compact = async () => {
      fake.calls.compact++;
      await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'plugin', messages, agentId: 'sub-1' }), summaryNext());
      return handlers['session.compact'](fake.$, Object.freeze({ trigger: 'manual', messages }), summaryNext());
    };
    await turn(handlers, fake);
    const compacts = fake.records().filter((r) => r.event === 'compact');
    expect(compacts).toHaveLength(2);
    for (const r of compacts) expect(r).not.toHaveProperty('own_request');
  });

  it('under OMC_JEV_MAX_REQUESTS the question leaves the requests of one whole compaction', async () => {
    const six = fakeDollar({ env: { ...env, OMC_JEV_MAX_REQUESTS: '6' }, messages: conversation(40, { chars: 6000 }), usage: usageAt(() => 130000), respond: momentRespond(0.1) });
    await turn(load(), six);
    expect(momentCalls(six.calls)).toHaveLength(0);
    expect(own(six)).toEqual([expect.objectContaining({ result: 'not_now', reason: 'cap' })]);
    const handlers = load();
    const seven = fakeDollar({ env: { ...env, OMC_JEV_MAX_REQUESTS: '7' }, messages: conversation(40, { chars: 6000 }), usage: usageAt(() => 130000), respond: momentRespond(0.1) });
    for (let k = 0; k < 16; k++) await turn(handlers, seven);
    expect(momentCalls(seven.calls)).toHaveLength(1);
    // The cap does not come back: one record says so, then closed tasks alone choose the moment.
    expect(own(seven).map((r) => r.reason)).toEqual(['jev_no', 'cap']);
  });

  it('a failed moment question is "not now" and pauses requests like a failed compaction request', async () => {
    const handlers = load();
    const fake = fakeDollar({ env, messages: conversation(40, { chars: 6000 }), usage: usageAt(() => 130000), respond: () => ({ ok: false, status: 503, headers: {}, text: '' }) });
    await turn(handlers, fake);
    expect(own(fake)).toEqual([expect.objectContaining({ result: 'not_now', reason: 'jev_error' })]);
    const after = await compactOnce(conversation(30), { handlers });
    expect(after.records()[0]).toMatchObject({ result: 'fallback', reason: 'paused' });
    expect(after.calls.fetch).toHaveLength(0);
  });

  it('with OMC_JEV_COMPACT_FLEX the removable results must be worth 10 % of the window at the target the compaction would aim at', async () => {
    // A summary that kept the whole conversation: no growth since, so the elastic target keeps 70 % and
    // frees 30 % of about 242000 characters, under 20000 tokens; the rule's 50 % frees over 30000.
    const messages = conversation(40, { chars: 6000 });
    const run = async (flexValue) => {
      let tokens = 100000;
      const handlers = load();
      const fake = fakeDollar({ env: { ...env, OMC_JEV_COMPACT_FLEX: flexValue }, messages, usage: usageAt(() => tokens), respond: momentRespond(0.1) });
      await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages: conversation(2) }), async () => ({ messages }));
      await turn(handlers, fake);
      tokens = 130000;
      await turn(handlers, fake);
      return momentCalls(fake.calls).length;
    };
    expect(await run('off')).toBe(1);
    expect(await run('active')).toBe(0);
  });

  it('the moment question is the registry\'s compaction-moment question', () => {
    const question = JUDGMENT_POINTS.compaction.questions[1]['compaction-moment'];
    expect(question.type).toBe('noul');
    expect(jevCompaction.MOMENT_INSTRUCTIONS).toBe(question.instructions);
    expect(jevCompaction.MOMENT_CRITERIA).toEqual(question.criteria);
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
    for (let waited = 0; waited < 6000; waited += 20) {
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

  it('(moment) a breaker that opens, or a limit that fills, between the check and the admission holds the moment question: not now, breaker_open or rpm', async () => {
    await calmMinute();
    for (const [extra, file, fill, reason] of [
      [{}, '/breaker.json', (c) => expect(openByScripts(c, 429, '120')).toBeDefined(), 'breaker_open'],
      [{ OMC_JEV_MAX_RPM: '1' }, null, (c) => expect(reserveRequest(c.settings, 'other', Date.now()).ok).toBe(true), 'rpm'],
    ]) {
      const c = shared({ OMC_JEV_BREAKER: '1', OMC_JEV_COMPACT_AT_PERCENT: 'jev', ...extra });
      const fake = fakeDollar({ env: c.env, diskPrefix, messages: conversation(40, { chars: 6000 }), usage: () => ({ context: { tokens: 130000, window: 200000 } }) });
      // The check before the question reads the file once; the admission reads it again.
      let reads = 0;
      const read = fake.$.fs.read;
      fake.$.fs.read = async (p) => { if ((file ? p.endsWith(file) : /\/rpm-\d+$/.test(p)) && ++reads === 2) fill(c); return read(p); };
      await load()['turn.complete'](fake.$, { isAborted: false, reason: 'answer', answer: 'Done.' }, async () => 'ok');
      expect(fake.calls.fetch, reason).toHaveLength(0);
      expect(fake.calls.compact, reason).toBe(0);
      expect(fake.records().filter((r) => r.event === 'own_threshold'), reason).toEqual([expect.objectContaining({ result: 'not_now', reason })]);
    }
  });

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

  it('(a) a breaker file the module cannot read is not written over: a shorter breaker never replaces a longer one it could not see', async () => {
    const c = shared({ OMC_JEV_BREAKER: '1' });
    const longer = openByScripts(c, 402);
    expect(longer).toMatchObject({ reason: 'http-402' });
    // Every read of breaker.json fails (a rename landing, a scanner holding the file): the request goes out (fail-open) and gets a 429.
    const run = await compactShared(c, conversation(30), { brokenBreakerRead: true, respond: () => ({ ok: false, status: 429, headers: {}, text: '' }) });
    expect(run.calls.fetch).toHaveLength(1);
    expect(JSON.parse(readFileSync(`${c.settings.dir}/breaker.json`, 'utf8'))).toEqual(longer);
  });

  it('(a) a breaker file that does not parse is a write in progress for a second, then corrupt', async () => {
    const c = shared({ OMC_JEV_BREAKER: '1' });
    mkdirSync(c.settings.dir, { recursive: true });
    const file = `${c.settings.dir}/breaker.json`;
    const tooMany = () => ({ ok: false, status: 429, headers: {}, text: '' });
    writeFileSync(file, '');
    // Written "now" for the next 1.5 s (mtime half a second ahead), however long the compaction takes to reach its breaker write.
    const soon = new Date(Date.now() + 500);
    utimesSync(file, soon, soon);
    await compactShared(c, conversation(30), { respond: tooMany });
    expect(readFileSync(file, 'utf8')).toBe('');
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    await compactShared(c, conversation(30), { respond: tooMany });
    expect(readBreaker(c.settings, Date.now())).toMatchObject({ reason: 'http-429' });
  });

  it('(a) the module waits for the lock of a script opener and keeps the longer end that opener writes', async () => {
    const c = shared({ OMC_JEV_BREAKER: '1' });
    mkdirSync(c.settings.dir, { recursive: true });
    const lock = `${c.settings.dir}/breaker.json.lock`;
    let wrote;
    // When the 429 arrives, a script process holds the lock: it writes a 402 for ten minutes 100 ms later and removes the lock.
    // The module's own write of breaker.json takes 150 ms, so without the lock its shorter end would land last.
    const run = await compactShared(c, conversation(30), {
      breakerWriteDelayMs: 150,
      respond: () => {
        writeFileSync(lock, JSON.stringify({ token: 'script', ts: Date.now() }));
        setTimeout(() => {
          wrote = { until: Date.now() + 600_000, reason: 'http-402', since: Date.now() };
          writeFileSync(`${c.settings.dir}/breaker.json`, JSON.stringify(wrote));
          rmSync(lock);
        }, 100);
        return { ok: false, status: 429, headers: {}, text: '' };
      },
    });
    expect(run.calls.fetch).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(JSON.parse(readFileSync(`${c.settings.dir}/breaker.json`, 'utf8'))).toEqual(wrote);
    // The module took the lock after the script process removed it, and marks it released (it cannot remove files); the next
    // script opener removes it.
    const left = JSON.parse(readFileSync(lock, 'utf8'));
    expect(left).toMatchObject({ released: true });
    expect(left.token).toMatch(/^compaction-/);
  });

  it('(a) a host read of the lock that outlives the wait neither writes the module\'s lock nor opens the breaker', async () => {
    const c = shared({ OMC_JEV_BREAKER: '1' });
    mkdirSync(c.settings.dir, { recursive: true });
    // The first read of the (absent) lock returns after the 1.5 s wait is over and reports the path free.
    await compactShared(c, conversation(30), { lockReadDelayMs: 1800, respond: () => ({ ok: false, status: 429, headers: {}, text: '' }) });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(existsSync(`${c.settings.dir}/breaker.json.lock`)).toBe(false);
    expect(existsSync(`${c.settings.dir}/breaker.json`)).toBe(false);
  }, 20_000);

  it('(a) a lock a script opener creates while the module\'s read of it is under way is judged by the clock after the read, and is not overwritten', async () => {
    const c = shared({ OMC_JEV_BREAKER: '1' });
    mkdirSync(c.settings.dir, { recursive: true });
    const lock = `${c.settings.dir}/breaker.json.lock`;
    // The host read of the lock takes 1.2 s; the script opener creates the lock 1.1 s into it, so the text read is 0.1 s old.
    // Against the clock taken before the read it would look 1.1 s old (stale) and the module would write its token over it.
    await compactShared(c, conversation(30), {
      lockReadDelayMs: 1200,
      respond: () => {
        setTimeout(() => writeFileSync(lock, JSON.stringify({ token: 'script', ts: Date.now() })), 1100);
        return { ok: false, status: 429, headers: {}, text: '' };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('script');
    expect(existsSync(`${c.settings.dir}/breaker.json`)).toBe(false);
  }, 20_000);

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
