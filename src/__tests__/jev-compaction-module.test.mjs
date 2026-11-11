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
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { boundExcerpts, classifyFailure, DEFAULT_EXCERPT_CHARS, mediumThreshold, omitSecretLines, pairingOk, parseMaxRpm, pasteMode, pasteTags, pointMode, QUESTION_CRITERIA, QUESTION_INSTRUCTIONS, register, retryAfterFromBody, retryAfterMs, sharedFailureClass } from '../../hooks/jev-compaction.mjs';
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

function fakeDollar({ env = ACTIVE_ENV, settingsEnv, respond = (body) => okResponse(scoreByMarker(body)), clockAfter, usage, messages = [], compactResult, writeThrows = false, diskPrefix, flakyBreakerRead = false, stallBreakerRead = false, stallRpmRead = false, rpmReadGate, rpmReadGates = {}, fsDelayMs = 0, brokenBreakerRead = false, breakerWriteDelayMs = 0, lockReadDelayMs = 0, initialFiles = {}, stallWrite, stallRead, onFs } = {}) {
  const files = new Map(Object.entries(initialFiles));
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
        onFs?.('read', p);
        { const hang = stallRead?.('read', p); if (hang) return hang; }
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
        onFs?.('write', p);
        if (fsDelayMs) await new Promise((resolve) => setTimeout(resolve, fsDelayMs));
        if (stallWrite?.(p)) return new Promise(() => {});
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

  it('masks a private key block before omitting the line that names a secret path, so its body is never sent from a result, an input, the user\'s words or the /compact instructions', async () => {
    const pem = (tag) => `~/.ssh/id_ed25519: -----BEGIN PRIVATE KEY-----\nPEMBODY-${tag}/MC4CAQAwBQYDK2VwBCIE/fakeOnly+Test/Body==\n-----END PRIVATE KEY-----\nAFTER-KEY-${tag}`;
    expect(omitSecretLines(`ok\n${pem('x')}`, [])).toBe('ok\n[line omitted: secret path]\nAFTER-KEY-x');
    const calls = { 5: ['Bash', { command: 'ls /srv', description: pem('INPUT'), note: 'FIELD-AFTER-KEY' }] };
    const base = conversation(20, {
      tool: (i) => (calls[i] ? calls[i][0] : 'Bash'),
      input: (i) => (calls[i] ? calls[i][1] : { command: `cat notes-${i}.txt` }),
      result: (i) => (i === 7 ? `PLAIN-RESULT-LINE\n${pem('RESULT')}` : i === 9 ? `fixture.pem:\n${pem('PLAIN').slice(pem('PLAIN').indexOf('-----BEGIN'))}` : `RESULT-${i} ${'x'.repeat(2000)}`),
    });
    const words = Object.freeze({ role: 'user', text: `PLAIN-USER-LINE\n${pem('USER')}`, toolUses: [] });
    const run = await compactOnce([base[0], words, ...base.slice(1)], {}, { instructions: `PLAIN-INSTRUCTION-LINE\n${pem('INSTR')}` });
    const body = JSON.stringify(run.calls.fetch.map((c) => c.body));
    expect(body).not.toMatch(/PEMBODY|\.ssh/);
    for (const kept of ['PLAIN-RESULT-LINE', 'PLAIN-USER-LINE', 'PLAIN-INSTRUCTION-LINE', '[line omitted: secret path]', 'AFTER-KEY-RESULT', 'AFTER-KEY-USER', 'AFTER-KEY-INSTR', 'AFTER-KEY-INPUT', 'FIELD-AFTER-KEY', 'fixture.pem', 'AFTER-KEY-PLAIN']) expect(body).toContain(kept);
  });

  it('matches the results the user names against the words as written, while the words sent still omit a line naming a secret path', async () => {
    const messages = conversation(20, { last: 'Keep notes-5.txt; do not open /home/u/.aws/credentials' });
    const run = await compactOnce(messages);
    expect(JSON.stringify(run.calls.fetch.map((c) => c.body))).not.toMatch(/\.aws/);
    expect(run.records()[0].mentioned).toBe(1);
    expect(resultOf(run.out.messages, 't5')?.text).toBe(resultOf(messages, 't5').text);
    // An omitted 5,000-character line lets the next line into the budget: the name on it still counts.
    const after = conversation(20, { last: `${'w'.repeat(5000)} /home/u/.aws/credentials\nKeep notes-5.txt` });
    const second = await compactOnce(after);
    expect(JSON.stringify(second.calls.fetch.map((c) => c.body))).toContain('Keep notes-5.txt');
    expect(second.records()[0].mentioned).toBe(1);
  });

  it('recognizes an MCP path given in parts (fields, nested objects, array segments, a key, three parts, a trailing line end) by joining the end of a .ssh, .aws or private-path part with every other string; beyond 2000 joins it fails closed', async () => {
    const strings = (n) => Array.from({ length: n }, (_, k) => `v${k}`);
    const calls = {
      3: ['mcp__fs__read_file', { directory: '/home/u/.aws', name: 'credentials' }],
      5: ['mcp__fs__read', { root: '/home/u', relative: 'secret-notes/today.md' }],
      7: ['mcp__fs__open', { file: 'credentials', mode: 'r', dir: '/home/u/.aws' }],
      9: ['mcp__fs__read', { root: `${'r'.repeat(100_000)}/home/u/.ssh`, name: 'deploy' }],
      11: ['mcp__fs__read', { segments: ['/home/u/.aws', 'credentials'] }],
      13: ['mcp__fs__read', { location: { dir: '/home/u/.aws' }, file: 'credentials' }],
      15: ['mcp__fs__read', { directory: 'C:\\Users\\u\\.aws\r\n', name: 'credentials\r\n' }],
      17: ['mcp__fs__read', { '/home/u/.aws': 'credentials' }],
      19: ['mcp__fs__read', { root: '/home/u', dir: '.ssh', name: 'deploy' }],
      21: ['mcp__db__insert', { base: '/srv/a/.config', other: '/srv/b/.config', rows: strings(1001) }],
      23: ['mcp__fs__read_file', { directory: '/srv/app', name: 'README.md' }],
      25: ['mcp__fs__list', { directory: '/home/u/.ssh', name: 'known_hosts' }],
      27: ['mcp__db__insert', { base: '/srv/a/.config', rows: strings(1500), wide: Object.fromEntries(strings(60).map((v) => [`f${v}`, v])) }],
    };
    const secret = [3, 5, 7, 9, 11, 13, 15, 17, 19, 21];
    const messages = conversation(30, {
      tool: (i) => (calls[i] ? calls[i][0] : 'Bash'),
      input: (i) => (calls[i] ? calls[i][1] : { command: `cat notes-${i}.txt` }),
      result: (i) => (calls[i] ? `MCP-${i}-END ${'x'.repeat(2000)}` : `RESULT-${i} ${'x'.repeat(2000)}`),
    });
    const run = await compactOnce(messages, { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_PRIVATE_PATHS: '~/secret-notes' } });
    const body = JSON.stringify(run.calls.fetch.map((c) => c.body));
    for (const i of secret) expect(body).not.toContain(`MCP-${i}-END`);
    for (const i of [23, 25, 27]) expect(body).toContain(`MCP-${i}-END`);
    for (const i of secret) expect(resultOf(run.out.messages, `t${i}`)).toBeUndefined();
    expect(run.records()[0]).toMatchObject({ secret_skipped: secret.length });
  });

  it('joins the .config parts of the gh credentials (a root and a relative path, segments, three fields, nested objects, CRLF) and a private path in three parts before it classifies them; a relative path that is not a secret stays clean; the joins stay bounded', async () => {
    const runCalls = async (calls, env) => {
      const messages = conversation(40, {
        tool: (i) => (calls[i] ? calls[i][0] : 'Bash'),
        input: (i) => (calls[i] ? calls[i][1] : { command: `cat notes-${i}.txt` }),
        result: (i) => (calls[i] ? `MCP-${i}-END ${'x'.repeat(2000)}` : `RESULT-${i} ${'x'.repeat(2000)}`),
      });
      const t0 = performance.now();
      const run = await compactOnce(messages, { env });
      expect(performance.now() - t0).toBeLessThan(2000);
      return { run, body: JSON.stringify(run.calls.fetch.map((c) => c.body)) };
    };
    const calls = {
      3: ['mcp__fs__read', { root: '/home/u', relative: '.config/gh/hosts.yml' }],
      5: ['mcp__fs__read', { segments: ['/home/u', '.config', 'gh', 'hosts.yml'] }],
      7: ['mcp__fs__read', { directory: '/home/u/.config', sub: 'gh', name: 'hosts.yml' }],
      9: ['mcp__fs__read', { directory: 'C:\\Users\\u\r\n', name: '.config\\gh\\hosts.yml\r\n' }],
      11: ['mcp__fs__read', { location: { root: '/home/u' }, file: { relative: '.config/gh/hosts.yml' } }],
      13: ['mcp__fs__read', { root: '~', relative: '.ssh/deploy_key' }],
      15: ['mcp__fs__read', { '/home/u': '.config/gh/hosts.yml' }],
      17: ['mcp__fs__read', { dirs: Array.from({ length: 1000 }, () => '/srv/a/.config'), subs: Array.from({ length: 1000 }, () => 'gh') }],
      19: ['mcp__fs__read', { segments: ['/home/u/.config', '/gh', '/hosts.yml'] }],
      31: ['mcp__fs__read', { base: '$HOME', relative: '.config/gh/hosts.yml' }],
      21: ['mcp__fs__read', { root: '/home/u', relative: '.configs/x' }],
      23: ['mcp__fs__read', { root: '/home/u', relative: '.config/gh/other.yml' }],
      25: ['mcp__fs__read', { segments: ['/home/u', '.config', 'gh', 'other.yml'] }],
      27: ['mcp__fs__read', { directory: '/home/u/.config', name: 'app.json' }],
      29: ['mcp__fs__read', { note: 'gh', name: 'hosts.yml' }],
      33: ['mcp__fs__list', { files: Array.from({ length: 60 }, (_, k) => `/repo/app${k}.config.js`) }],
    };
    const secret = [3, 5, 7, 9, 11, 13, 15, 17, 19, 31];
    const clean = [21, 23, 25, 27, 29, 33];
    const first = await runCalls(calls, ACTIVE_ENV);
    for (const i of secret) expect(first.body).not.toContain(`MCP-${i}-END`);
    for (const i of clean) expect(first.body).toContain(`MCP-${i}-END`);
    for (const i of secret) expect(resultOf(first.run.out.messages, `t${i}`)).toBeUndefined();
    expect(first.run.records()[0]).toMatchObject({ secret_skipped: secret.length });
    // A private path given in three parts (its first two parts are a prefix of it).
    const second = await runCalls({ 3: ['mcp__fs__read', { segments: ['/home', 'u', 'secret-notes/today.md'] }], 5: ['mcp__fs__read', { segments: ['/home', 'u', 'public/today.md'] }] }, { ...ACTIVE_ENV, OMC_JEV_COMPACT_PRIVATE_PATHS: '~/secret-notes' });
    expect(second.body).not.toContain('MCP-3-END');
    expect(second.body).toContain('MCP-5-END');
    expect(second.run.records()[0]).toMatchObject({ secret_skipped: 1 });
  });

  it('a user or /compact line too long to check whole is omitted, and one read to its end is omitted when it names a secret path, so its start is never sent', async () => {
    const base = conversation(20, { chars: 20_000 });
    const near = Object.freeze({ role: 'user', text: `PLAIN-USER-LINE\nLOWSECRET-USER ${'y'.repeat(30_000)} /home/u/.aws/credentials`, toolUses: [] });
    const far = Object.freeze({ role: 'user', text: `PLAIN-BEFORE-LINE\nLOWSECRET-FAR ${'y'.repeat(200_000)} /home/u/.aws/credentials`, toolUses: [] });
    const run = await compactOnce([base[0], near, far, ...base.slice(1)], {}, { instructions: `PLAIN-INSTRUCTION-LINE\nLOWSECRET-INSTR ${'y'.repeat(30_000)} /home/u/.ssh/id_rsa` });
    const body = JSON.stringify(run.calls.fetch.map((c) => c.body));
    expect(body).not.toMatch(/LOWSECRET|\.aws|\.ssh/);
    for (const kept of ['PLAIN-USER-LINE', 'PLAIN-BEFORE-LINE', 'PLAIN-INSTRUCTION-LINE', '[line omitted: secret path]', '[line omitted: too long to check]']) expect(body).toContain(kept);
  });

  it('a result line at the edge of the head or tail cut that does not end within the scan is omitted, so a secret path later on it never lets its start through', async () => {
    const results = {
      5: `LOWSECRET-HEAD ${'f'.repeat(102_000)} /home/u/.aws/credentials`,
      7: `/home/u/.aws/credentials ${'f'.repeat(102_000)} LOWSECRET-TAIL`,
      9: `PLAIN-FIRST\n${'f'.repeat(120_000)}\nPLAIN-LAST`,
      11: `${'j'.repeat(150_000)}-----BEGIN PRIVATE KEY-----\nPEMBODY-TAIL/MC4CAQAwBQYDK2VwBCIE/fakeOnly+Test/Body==\n-----END PRIVATE KEY-----\nPLAIN-AFTER-KEY`,
      13: `MIDLINE-HEAD ${'f'.repeat(60_000)} MIDLINE-TAIL`,
    };
    const messages = conversation(20, { result: (i) => results[i] ?? `RESULT-${i} ${'x'.repeat(2000)}` });
    const run = await compactOnce(messages);
    const body = JSON.stringify(run.calls.fetch.map((c) => c.body));
    expect(body).not.toMatch(/LOWSECRET|\.aws|PEMBODY/);
    for (const kept of ['PLAIN-FIRST', 'PLAIN-LAST', '[line omitted: too long to check]', 'PLAIN-AFTER-KEY', 'MIDLINE-HEAD', 'MIDLINE-TAIL']) expect(body).toContain(kept);
  });

  it('tracks the output file of every background call on a secret path, however many there are', async () => {
    const OUT = '/tmp/claude-0/proj/tasks';
    const launches = 30;
    const messages = conversation(45, {
      input: (i) => (i <= launches ? { command: 'cat /home/u/.ssh/id_ed25519', run_in_background: true } : i === 40 ? { file_path: `${OUT}/bjob${launches}.output` } : i === 41 ? { file_path: '/srv/docs/a1.md.bak' } : { command: `cat notes-${i}.txt` }),
      tool: (i) => (i === 40 || i === 41 ? 'Read' : 'Bash'),
      result: (i) => (i <= launches ? `Command running in background with ID: bjob${i}. Output is being written to: ${OUT}/bjob${i}.output. See /srv/docs/a${i}.md:` : i === 40 ? `SECRET-LAST-JOB ${'x'.repeat(2000)}` : i === 41 ? `PLAIN-DOC-READ ${'x'.repeat(2000)}` : `RESULT-${i} ${'x'.repeat(2000)}`),
    });
    const run = await compactOnce(messages);
    const body = JSON.stringify(run.calls.fetch.map((c) => c.body));
    expect(body).not.toMatch(/SECRET-LAST-JOB/);
    expect(body).toContain('PLAIN-DOC-READ');
    expect(resultOf(run.out.messages, 't40')).toBeUndefined();
    expect(run.records()[0]).toMatchObject({ secret_skipped: launches + 1 });
  });

  it('indexes the output files of background calls in linear time when thousands of them end in the same name', async () => {
    const launches = 190;
    const paths = (i) => Array.from({ length: 160 }, (_, k) => `/t/d${i}x${k}/same.output`).join(' ');
    const messages = conversation(launches + 5, {
      input: (i) => (i <= launches ? { command: 'cat /home/u/.ssh/id_ed25519', run_in_background: true } : { command: `cat notes-${i}.txt` }),
      result: (i) => (i <= launches ? `Command running in background with ID: bjob${i}. Output is being written to: ${paths(i)}` : `RESULT-${i} ${'x'.repeat(2000)}`),
    });
    const t0 = performance.now();
    const run = await compactOnce(messages);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(run.records()[0]).toMatchObject({ secret_skipped: launches });
  });

  it('a .ssh directory copy (.ssh.bak, .ssh2, .ssh-old) is a secret path, a directory whose name merely starts with .ssh is not', async () => {
    for (const line of ['/home/u/.ssh.bak/work', '/home/u/.ssh2/identity', '/home/u/.ssh-old/work', '/home/u/.ssh_backup/work', '/home/u/.sshbackup/work', '/home/u/.ssh~/work', '/home/u/.sshkeys/deploy']) {
      expect(omitSecretLines(`ok\n${line}`, [])).toBe('ok\n[line omitted: secret path]');
    }
    for (const line of ['~/.sshuttle/state', '/work/foo.sshlib/index.js', '/srv/x.sshd/config.yml']) expect(omitSecretLines(line, [])).toBe(line);
    const calls = { 5: ['Read', { file_path: '/home/u/.sshuttle/state' }] };
    const messages = conversation(20, {
      tool: (i) => (calls[i] ? calls[i][0] : 'Bash'),
      input: (i) => (calls[i] ? calls[i][1] : { command: `cat notes-${i}.txt` }),
      result: (i) => (i === 5 ? `SSHUTTLE-STATE ${'x'.repeat(2000)}` : `RESULT-${i} ${'x'.repeat(2000)}`),
    });
    const run = await compactOnce(messages);
    expect(JSON.stringify(run.calls.fetch.map((c) => c.body))).toContain('SSHUTTLE-STATE');
    expect(run.records()[0]).toMatchObject({ secret_skipped: 0 });
  });

  it('stays linear on a million characters: .ssh names, a single-line result and user message, and MCP fields joined in pairs', async () => {
    for (const s of ['/.ssh'.repeat(200_000), '/a.sshb'.repeat(150_000), `/${'x'.repeat(999_990)}.ssh`, '/.ssh.'.repeat(170_000)]) {
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        omitSecretLines(s, ['/home/u/secret-notes']);
        best = Math.min(best, performance.now() - t0);
      }
      expect(best).toBeLessThan(200);
    }
    const line = 'q'.repeat(1_000_000);
    const calls = { 3: ['mcp__fs__read', { a: `/${'/'.repeat(1_000_000)}`, b: 'x'.repeat(1_000_000), c: '/.ssh'.repeat(200_000) }] };
    const base = conversation(20, {
      tool: (i) => (calls[i] ? calls[i][0] : 'Bash'),
      input: (i) => (calls[i] ? calls[i][1] : { command: `cat notes-${i}.txt` }),
      result: (i) => (i === 5 ? line : `RESULT-${i} ${'x'.repeat(2000)}`),
    });
    const words = Object.freeze({ role: 'user', text: line, toolUses: [] });
    const t0 = performance.now();
    const run = await compactOnce([base[0], words, ...base.slice(1)], { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_PRIVATE_PATHS: '~/secret-notes' } });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(run.calls.fetch.length).toBeGreaterThan(0);
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
    const huge = `HEAD-1 key ${secretHead}\n` + `${'x'.repeat(99)}\n`.repeat(3000) + `TAIL-1 ${secretTail}`;
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

describe('jev-compaction module: archive of cut and removed results (OMC_JEV_COMPACT_ARCHIVE)', () => {
  const ARCHIVE = `${STATE}/compaction-archive/sess-1`;
  const archiveEnv = { ...ACTIVE_ENV, OMC_JEV_COMPACT_ARCHIVE: 'active' };
  const archived = (files) => [...files.keys()].filter((p) => p.startsWith(`${ARCHIVE}/`) && !p.endsWith('/.compaction'));
  const timeless = (record) => Object.fromEntries(Object.entries(record).filter(([key]) => !['ts', 'duration_ms', 'jev_ms'].includes(key)));
  const traceOf = (messages, i) => messages.flatMap((m) => (m.text || '').split('\n')).find((l) => l.startsWith(`[compacted] Bash(cat notes-${i}.txt)`));

  it('without the variable, or with any value but shadow and active, the result and the record are those of a module without the archive and no file is written', async () => {
    const messages = conversation(30, { needed: [3, 9, 20], maybe: [5] });
    const base = await compactOnce(messages, { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET: '0.3' } });
    for (const value of ['off', '', 'on', '1', 'true', 'activ']) {
      const run = await compactOnce(messages, { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET: '0.3', OMC_JEV_COMPACT_ARCHIVE: value } });
      expect(run.out).toEqual(base.out);
      expect(timeless(run.records()[0])).toEqual(timeless(base.records()[0]));
      expect(archived(run.files)).toHaveLength(0);
      expect([...run.files.keys()].some((p) => p.includes('compaction-archive'))).toBe(false);
    }
    expect(JSON.stringify(base.out)).not.toContain('full call and result');
    // the same result and record as before the archive existed, frozen (not only equal to this branch's own other runs)
    expect(timeless(base.records()[0])).toEqual({
      point: 'compaction', event: 'compact', session_id: 'sess-1', agent_id: null, trigger: 'auto', mode: 'active', messages_before: 63, chars_before: 61653,
      target: 0.3, kept_from: 0, server_blocks: null, candidates: 28, max_reduction: 0.899, secret_skipped: 0, secret_held: 0, task_output_held: 0, non_text: 0,
      asked: 28, requests: 1, requests_ok: 1, answered: 28, mentioned: 0, messages_after: 41, chars_after: 18143, reduction: 0.706, kept_full: 6, kept_short: 0,
      traced: 22, rebuilt_unchanged: 8, kept_handle: 0, rebuilt_assistant: 31, dropped_assistant: 0, joined_rows: 0, score_hist: [24, 0, 1, 3], unanswered: 0, result: 'jev',
    });
    expect(base.out.messages.slice(1, 3).map((m) => m.text)).toEqual(['Step 1.\n[compacted] Bash(cat notes-1.txt) - result of 2009 chars removed', 'Step 2.\n[compacted] Bash(cat notes-2.txt) - result of 2009 chars removed']);
    const cut = await compactOnce(conversation(30, { chars: 3000, needed: [25, 26, 27, 28], maybe: [2] }), { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET: '0.2' } });
    expect(resultOf(cut.out.messages, 't2').text).toMatch(/^RESULT-2 MAYBE x{285}\n\[result shortened at compaction: kept 300 of 3015 chars\]$/);
  });

  it('active: every cut or traced result goes whole to <state>/compaction-archive/<session>/<tool_use_id>.txt with its masked call, and its trace or cut names the file', async () => {
    const messages = conversation(30, { chars: 3000, needed: [25, 26, 27, 28], maybe: [2] });
    const run = await compactOnce(messages, { env: { ...archiveEnv, OMC_JEV_COMPACT_TARGET: '0.2' } });
    const kept = new Set(run.out.messages.flatMap((m) => m.toolResults || []).map((r) => r.tool_use_id));
    const traced = [];
    for (let i = 1; i <= 30; i++) {
      const path = `${ARCHIVE}/t${i}.txt`;
      if (kept.has(`t${i}`) && resultOf(run.out.messages, `t${i}`).text === resultOf(messages, `t${i}`).text) { expect(run.files.has(path)).toBe(false); continue; }
      const original = resultOf(messages, `t${i}`).text;
      expect(run.files.get(path)).toBe(`[Jev compaction archive] call Bash, tool_use_id t${i}\n--- input (masked) ---\n${JSON.stringify({ command: `cat notes-${i}.txt` }, null, 2)}\n--- result (${original.length} chars, unchanged) ---\n${original}`);
      if (kept.has(`t${i}`)) expect(resultOf(run.out.messages, `t${i}`).text).toMatch(new RegExp(`\\n\\[result shortened at compaction: kept 300 of ${original.length} chars; full call and result: ${path}\\]$`));
      else { traced.push(i); expect(traceOf(run.out.messages, i)).toBe(`[compacted] Bash(cat notes-${i}.txt) - result of ${original.length} chars removed; full call and result: ${path}`); }
    }
    expect(traced.length).toBeGreaterThan(10);
    expect(resultOf(run.out.messages, 't2').text).toContain('full call and result: ');
    expect(chars(run.out.messages)).toBeLessThanOrEqual(Math.floor(chars(messages) * 0.2));
    const record = run.records()[0];
    expect(record).toMatchObject({ result: 'jev', archive_mode: 'active', archive_written: archived(run.files).length, archive_reused: 0, archive_rewritten: 0, archive_errors: 0, archive_timed_out: 0, archive_marker: true });
    expect(record.archive_bytes).toBeGreaterThan(3000 * traced.length);
    expect(run.files.has(`${ARCHIVE}/.compaction`)).toBe(true);
    // the next compaction of the same session finds the files it wrote: reused, not written again
    const again = await compactOnce(messages, { env: { ...archiveEnv, OMC_JEV_COMPACT_TARGET: '0.2' }, initialFiles: Object.fromEntries(run.files) });
    expect(again.records().at(-1)).toMatchObject({ archive_written: 0, archive_reused: record.archive_written, archive_rewritten: 0 });
    expect(again.out).toEqual(run.out);
  });

  it('a result that holds a secret, names a secret or private path, or comes from a call on one is not archived and its trace names no file', async () => {
    const results = {
      2: 'plain output ' + 'x'.repeat(500),
      3: `config\nkey = sk-ant-api03-${'A1b2C3d4'.repeat(4)}\n${'x'.repeat(500)}`,
      4: `see /home/u/.ssh/id_ed25519\n${'x'.repeat(500)}`,
      5: `copied from ~/secret-notes/today.md\n${'x'.repeat(500)}`,
      6: `Authorization: Bearer ${'abcDEF123456'.repeat(3)}\n${'x'.repeat(500)}`,
      7: 'ordinary ' + 'x'.repeat(500),
      8: 'ordinary ' + 'x'.repeat(500),
      9: 'ordinary ' + 'x'.repeat(500),
    };
    const calls = { 7: ['Read', { file_path: '/work/.env' }], 8: ['mcp__vault__read', { name: 'prod', path: '/home/u/.aws/credentials' }], 9: ['Bash', { command: 'cat ~/secret-notes/a.md' }] };
    const messages = conversation(20, {
      tool: (i) => (calls[i] ? calls[i][0] : 'Bash'),
      input: (i) => (calls[i] ? calls[i][1] : { command: `cat notes-${i}.txt` }),
      result: (i) => results[i] ?? `ordinary ${i} ${'x'.repeat(500)}`,
    });
    const env = { ...archiveEnv, OMC_JEV_COMPACT_PRIVATE_PATHS: '~/secret-notes' };
    const run = await compactOnce(messages, { env });
    const names = archived(run.files).map((p) => p.slice(ARCHIVE.length + 1));
    for (const id of [3, 4, 5, 6, 7, 8, 9]) expect(names).not.toContain(`t${id}.txt`);
    for (const i of [3, 4, 5, 6]) expect(traceOf(run.out.messages, i)).not.toContain('full call and result');
    for (const text of run.files.values()) expect(text).not.toMatch(/sk-ant-api03|id_ed25519|secret-notes|Bearer abc|\.aws/);
    expect(run.out.messages.flatMap((m) => (m.text || '').split('\n')).filter((l) => /^\[compacted\] (?:Read|mcp__vault__read)\(/.test(l) || /cat ~\/secret-notes/.test(l)).every((l) => !l.includes('full call and result'))).toBe(true);
    for (const id of [2, 10, 11]) expect(names).toContain(`t${id}.txt`);
    expect(run.records()[0].archive_skipped).toMatchObject({ secret_in_result: 4, secret: 3 });
  });

  it('shadow only counts: no file, no path in a trace, the conversation as without the archive; active needs an active compaction and a session id that is a file name', async () => {
    const messages = conversation(30, { needed: [3, 9, 20] });
    const base = await compactOnce(messages);
    const shadow = await compactOnce(messages, { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_ARCHIVE: 'shadow' } });
    expect(shadow.out).toEqual(base.out);
    expect([...shadow.files.keys()].some((p) => p.includes('compaction-archive'))).toBe(false);
    const planned = shadow.records()[0];
    expect(planned).toMatchObject({ archive_mode: 'shadow', archive_planned: (await compactOnce(messages, { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_ARCHIVE: 'active' } })).records()[0].archive_written, archive_skipped: {} });
    expect(planned.archive_written).toBeUndefined();
    const inShadowCompaction = await compactOnce(messages, { env: { ...ACTIVE_ENV, OMC_JEV: 'compaction', OMC_JEV_COMPACT_ARCHIVE: 'active' } });
    expect([...inShadowCompaction.files.keys()].some((p) => p.includes('compaction-archive'))).toBe(false);
    expect(inShadowCompaction.records()[0]).toMatchObject({ mode: 'shadow', archive_mode: 'shadow' });
    // a session id that is not a file name has no directory
    const odd = fakeDollar({ env: archiveEnv, messages: [] });
    odd.$.session.id = async () => '../x/y';
    const handlers = load();
    await handlers['session.compact'](odd.$, Object.freeze({ trigger: 'auto', messages }), summaryNext());
    expect([...odd.files.keys()].some((p) => p.includes('compaction-archive'))).toBe(false);
    expect(odd.records()[0]).toMatchObject({ archive_mode: 'shadow' });
  });

  it('a host that never finishes a write cannot hold the compaction: no call starts after the first cap, the traces name no file', async () => {
    const messages = conversation(30);
    const started = Date.now();
    const run = await compactOnce(messages, { env: archiveEnv, stallWrite: (p) => p.includes('/compaction-archive/') });
    expect(Date.now() - started).toBeLessThan(7000);
    expect(run.out.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(run.out)).not.toContain('full call and result');
    expect(archived(run.files)).toHaveLength(0);
    const record = run.records()[0];
    expect(record).toMatchObject({ result: 'jev', archive_written: 0, archive_marker: false });
    expect(record.archive_timed_out).toBeGreaterThanOrEqual(record.traced) // the allocation is repeated without the paths that did not come about;
    expect(record.archive_ms).toBeLessThan(4500);
  }, 15000);

  it('no write starts after the archive budget: on a slow host the first results are archived and the rest get no path (virtual clock)', async () => {
    const real = Date.now;
    let skew = 0;
    Date.now = () => real() + skew;
    try {
      const writes = [];
      const onFs = (kind, path) => {
        if (!path.includes('/compaction-archive/')) return;
        if (kind !== 'write') return;
        writes.push(Date.now());
        skew += 450;
      };
      const run = await compactOnce(conversation(40), { env: archiveEnv, onFs });
      const record = run.records()[0];
      expect(record.archive_written).toBeGreaterThan(0);
      expect(record.archive_timed_out).toBeGreaterThan(0);
      expect(record.archive_written + record.archive_timed_out).toBeGreaterThanOrEqual(record.traced);
      // the first write is the marker, at the start of the archive; the writes of the eight workers follow one another
      for (const t of writes) expect(t).toBeLessThan(writes[0] + 1500 + 50);
      const named = run.out.messages.flatMap((m) => (m.text || '').split('\n')).filter((l) => l.includes('full call and result: '));
      expect(named).toHaveLength(record.archive_written);
      for (const line of named) expect(run.files.has(line.split('full call and result: ')[1])).toBe(true);
    } finally { Date.now = real; }
  });

  it('no host call starts after the compaction\'s own time, and one that stalls is cut at the time left (virtual clock for the time Jev took)', async () => {
    const real = Date.now;
    let skew = 0;
    Date.now = () => real() + skew;
    try {
      // Jev answers after 8.1 s of the 8 s: no time is left, so no archive call is made at all
      let archiveCalls = 0;
      const onFs = (_kind, path) => { if (path.includes('/compaction-archive/')) archiveCalls++; };
      const respond = (body) => { skew += 8100; return okResponse(scoreByMarker(body)); };
      const late = await compactOnce(conversation(30), { env: archiveEnv, respond, onFs });
      expect(archiveCalls).toBe(0);
      expect(JSON.stringify(late.out)).not.toContain('full call and result');
      expect(late.records()[0]).toMatchObject({ result: 'jev', archive_written: 0, archive_marker: false });
      expect(late.records()[0].archive_timed_out).toBeGreaterThanOrEqual(late.records()[0].traced);
      // 0.6 s are left and the host never answers a read: the archive ends with the time left, not after the 2 s cap
      skew = 0;
      const stall = (kind, path) => (kind === 'read' && path.includes('/compaction-archive/') ? new Promise(() => {}) : undefined);
      const respond2 = (body) => { skew += 7400; return okResponse(scoreByMarker(body)); };
      const run = await compactOnce(conversation(30), { env: archiveEnv, respond: respond2, stallRead: stall });
      const record = run.records()[0];
      expect(record.archive_ms).toBeLessThan(1500);
      expect(record.archive_written).toBe(0);
      expect(record.archive_timed_out).toBeGreaterThanOrEqual(record.traced);
      expect(JSON.stringify(run.out)).not.toContain('full call and result');
    } finally { Date.now = real; }
  });

  it('a host that never answers a read cannot hold the compaction: the first read is cut at the cap and no call starts after it', async () => {
    let reads = 0;
    const started = Date.now();
    const run = await compactOnce(conversation(30), { env: archiveEnv, stallRead: (_kind, path) => { if (path.includes('/compaction-archive/') && path.endsWith('.txt')) reads++; return path.includes('/compaction-archive/') && path.endsWith('.txt') ? new Promise(() => {}) : undefined; } });
    expect(Date.now() - started).toBeLessThan(7000);
    expect(reads).toBeLessThanOrEqual(8);
    const record = run.records()[0];
    expect(record).toMatchObject({ archive_written: 0 });
    expect(record.archive_timed_out).toBeGreaterThanOrEqual(record.traced);
    expect(JSON.stringify(run.out)).not.toContain('full call and result');
  }, 20000);

  it('a file of the same name is reused only when its text is the content: another text, even of the same length, is overwritten and the trace names the right text', async () => {
    const messages = conversation(30);
    const first = await compactOnce(messages, { env: archiveEnv });
    const path = `${ARCHIVE}/t4.txt`;
    const right = first.files.get(path);
    const stale = right.replace('RESULT-4', 'RESULT-9');
    expect(stale).toHaveLength(right.length);
    const run = await compactOnce(messages, { env: archiveEnv, initialFiles: { [path]: stale, [`${ARCHIVE}/t5.txt`]: 'short' } });
    expect(run.files.get(path)).toBe(right);
    expect(run.files.get(`${ARCHIVE}/t5.txt`)).toBe(first.files.get(`${ARCHIVE}/t5.txt`));
    expect(traceOf(run.out.messages, 4)).toContain(`full call and result: ${path}`);
    expect(run.records()[0]).toMatchObject({ archive_rewritten: 2, archive_reused: 0 });
  });

  it('a write that does not read back as written leaves the trace without a path', async () => {
    const messages = conversation(30);
    const fake = fakeDollar({ env: archiveEnv });
    const write = fake.$.fs.write;
    fake.$.fs.write = async (p, text) => write(p, p.endsWith('/t6.txt') ? `${text}!` : text);
    const out = await load()['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages }), summaryNext());
    expect(traceOf(out.messages, 6)).not.toContain('full call and result');
    expect(traceOf(out.messages, 7)).toContain('full call and result');
    expect(fake.records()[0]).toMatchObject({ archive_errors: 1 });
  });

  it('a cut of an earlier compaction keeps pointing at its file when it is cut or traced again, and its text is never archived as a result', async () => {
    const path = `${ARCHIVE}/t1.txt`;
    const cut = `${'y'.repeat(300)}\n[result shortened at compaction: kept 300 of 4000 chars; full call and result: ${path}]`;
    const messages = conversation(20, { result: (i) => (i === 1 ? cut : `RESULT-${i} ${'x'.repeat(2000)}`) });
    const env = { ...archiveEnv, OMC_JEV_COMPACT_TARGET: '0.1' };
    const run = await compactOnce(messages, { env, initialFiles: { [path]: 'the full text' } });
    expect(traceOf(run.out.messages, 1)).toBe(`[compacted] Bash(cat notes-1.txt) - result of ${cut.length} chars removed; full call and result: ${path}`);
    expect(run.files.get(path)).toBe('the full text');
    expect(run.records()[0]).toMatchObject({ archive_reused: 1, archive_rewritten: 0 });
    // the file is gone: the trace names none
    const gone = await compactOnce(messages, { env });
    expect(traceOf(gone.out.messages, 1)).not.toContain('full call and result');
    expect(gone.files.has(path)).toBe(false);
  });

  it('a result or a call input over 50 000 characters is not archived, and the archive adds no masking time for it (password, KEY and mysql runs)', async () => {
    // the oldest results: with more than 240 candidates they are not among the ones sent to Jev, whose own masking is slow on them too
    const long = { 1: 'password'.repeat(6500), 2: 'KEY'.repeat(17400), 3: 'mysql '.repeat(8700) };
    const messages = conversation(250, { input: (i) => (i === 4 ? { command: `echo ${long[1]}` } : { command: `cat notes-${i}.txt` }), result: (i) => long[i] ?? `RESULT-${i} ${'x'.repeat(500)}` });
    const t0 = Date.now();
    await compactOnce(messages);
    const base = Date.now() - t0;
    const t1 = Date.now();
    const run = await compactOnce(messages, { env: archiveEnv });
    const active = Date.now() - t1;
    const shadow = await compactOnce(messages, { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_ARCHIVE: 'shadow' } });
    for (const i of [1, 2, 3, 4]) expect(run.files.has(`${ARCHIVE}/t${i}.txt`)).toBe(false);
    expect(run.records()[0].archive_skipped).toMatchObject({ too_large: 4 });
    expect(shadow.records()[0].archive_skipped).toMatchObject({ too_large: 4 });
    // masking the whole of each would take seconds longer than the module's own masking of a window of it
    expect(active - base).toBeLessThan(1500);
  }, 60000);

  it('the masking of the archive is bounded in time: once about a second of it is spent, the rest of the candidates are skipped as `time`', async () => {
    const slow = 'password'.repeat(6000); // 48 000 characters, under the limit, slow to mask
    const t = Date.now();
    maskSecrets(slow);
    const one = Date.now() - t;
    const messages = conversation(250, { result: (i) => (i <= 4 ? `${slow} ${i}` : `RESULT-${i} ${'x'.repeat(500)}`) });
    const t0 = Date.now();
    await compactOnce(messages);
    const base = Date.now() - t0;
    const t1 = Date.now();
    const run = await compactOnce(messages, { env: archiveEnv });
    const active = Date.now() - t1;
    // unbounded, the four would take four times `one` more; bounded they take about two
    expect(active - base).toBeLessThan(3 * one + 400);
    if (one > 400) expect(run.records()[0].archive_skipped.time).toBeGreaterThanOrEqual(1);
  }, 90000);

  it('an id that is not a file name is never archived: no file outside the session directory, the trace names none', async () => {
    const evil = ['../../evil', 'a/b', 'x'.repeat(81), 'tool use', '..'];
    const m = [{ role: 'user', text: 'Task: look.', toolUses: [] }];
    evil.forEach((id, i) => {
      m.push({ role: 'assistant', text: `Step ${i}.`, toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: `cat notes-${i}.txt` } }] });
      m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: `RESULT-${i} ${'x'.repeat(2000)}`, isError: false }] });
    });
    for (let i = 10; i < 30; i++) {
      m.push({ role: 'assistant', text: `Step ${i}.`, toolUses: [{ tool_use_id: `ok${i}`, tool: 'Bash', input: { command: `cat notes-${i}.txt` } }] });
      m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `ok${i}`, text: `RESULT-${i} ${'x'.repeat(2000)}`, isError: false }] });
    }
    m.push({ role: 'user', text: 'Sum up.', toolUses: [] }, { role: 'assistant', text: 'Done.', toolUses: [] });
    const messages = m.map((x, k) => Object.freeze({ ...x, handle: `h${k}` }));
    const run = await compactOnce(messages, { env: archiveEnv });
    expect([...run.files.keys()].filter((p) => p.includes('compaction-archive')).every((p) => /\/compaction-archive\/sess-1\/(?:\.compaction|ok\d+\.txt)$/.test(p))).toBe(true);
    expect(run.records()[0].archive_skipped).toMatchObject({ bad_id: 5 });
    for (let i = 0; i < 5; i++) expect(traceOf(run.out.messages, i)).not.toContain('full call and result');
  });

  it('two results of one tool_use_id are not written to one file: the first is archived, the second is skipped', async () => {
    const m = [{ role: 'user', text: 'Task: look.', toolUses: [] }];
    const use = { tool_use_id: 'dup', tool: 'Bash', input: { command: 'cat notes-dup.txt' } };
    m.push({ role: 'assistant', text: 'Step a.', toolUses: [use] }, { role: 'assistant', text: 'Step b.', toolUses: [use] });
    m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'dup', text: `FIRST ${'x'.repeat(2000)}`, isError: false }] });
    m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'dup', text: `SECOND ${'y'.repeat(2000)}`, isError: false }] });
    for (let i = 10; i < 30; i++) {
      m.push({ role: 'assistant', text: `Step ${i}.`, toolUses: [{ tool_use_id: `ok${i}`, tool: 'Bash', input: { command: `cat notes-${i}.txt` } }] });
      m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `ok${i}`, text: `RESULT-${i} ${'x'.repeat(2000)}`, isError: false }] });
    }
    m.push({ role: 'user', text: 'Sum up.', toolUses: [] }, { role: 'assistant', text: 'Done.', toolUses: [] });
    const messages = m.map((x, k) => Object.freeze({ ...x, handle: `h${k}` }));
    const run = await compactOnce(messages, { env: archiveEnv });
    const record = run.records()[0];
    expect(record.candidates).toBe(20);
    expect(record.archive_skipped).toMatchObject({ duplicate_id: 1 });
    expect(run.files.get(`${ARCHIVE}/dup.txt`)).toContain('FIRST');
    expect(run.files.get(`${ARCHIVE}/dup.txt`)).not.toContain('SECOND');
    const lines = run.out.messages.flatMap((x) => (x.text || '').split('\n')).filter((l) => l.startsWith('[compacted] Bash(cat notes-dup.txt)'));
    expect(lines.filter((l) => l.includes('full call and result: ')).length).toBeLessThanOrEqual(1);
  });

  it('the text of an archive file (a Read of it) is not archived again', async () => {
    const archiveFile = `[Jev compaction archive] call Bash, tool_use_id t9\n--- input (masked) ---\n{}\n--- result (5 chars, unchanged) ---\nhello`;
    const messages = conversation(20, { result: (i) => (i === 3 ? archiveFile + ' '.repeat(2000) : `RESULT-${i} ${'x'.repeat(2000)}`) });
    const run = await compactOnce(messages, { env: archiveEnv, });
    expect(run.files.has(`${ARCHIVE}/t3.txt`)).toBe(false);
    expect(run.records()[0].archive_skipped).toMatchObject({ after_compaction: 1 });
  });

  it('the text of an archive file read back with line numbers (a Read of it) is not archived again either', async () => {
    const head = '[Jev compaction archive] call Bash, tool_use_id t9';
    const numbered = (arrow) => `     1${arrow}${head}\n     2${arrow}--- input (masked) ---\n     3${arrow}{}\n     4${arrow}--- result (5 chars, unchanged) ---\n     5${arrow}hello`;
    const messages = conversation(20, { result: (i) => (i === 3 ? numbered('\u2192') + ' '.repeat(2000) : i === 4 ? numbered('\t') + ' '.repeat(2000) : `RESULT-${i} ${'x'.repeat(2000)}`) });
    const run = await compactOnce(messages, { env: archiveEnv });
    expect(run.files.has(`${ARCHIVE}/t3.txt`)).toBe(false);
    expect(run.files.has(`${ARCHIVE}/t4.txt`)).toBe(false);
    expect(run.records()[0].archive_skipped).toMatchObject({ after_compaction: 2 });
  });

  it('a call input is measured as the archive file holds it (indented): nested empty objects of 48 000 compact characters are not archived', async () => {
    const nest = (depth, inner) => (depth ? [nest(depth - 1, inner)] : inner);
    const input = { command: 'cat notes-3.txt', items: nest(5, Array.from({ length: 16000 }, () => ({}))) };
    expect(JSON.stringify(input).length).toBeLessThan(50_000);
    expect(JSON.stringify(input, null, 2).length).toBeGreaterThan(100_000);
    const messages = conversation(20, { input: (i) => (i === 3 ? input : { command: `cat notes-${i}.txt` }) });
    const run = await compactOnce(messages, { env: archiveEnv });
    expect(run.files.has(`${ARCHIVE}/t3.txt`)).toBe(false);
    expect(run.records()[0].archive_skipped).toMatchObject({ too_large: 1 });
    const shadow = await compactOnce(messages, { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_ARCHIVE: 'shadow' } });
    expect(shadow.records()[0].archive_skipped).toMatchObject({ too_large: 1 });
  });

  it('one compaction writes at most 240 files: the newest results are archived, the rest are skipped as `cap`', async () => {
    const messages = conversation(300, { chars: 600 });
    const run = await compactOnce(messages, { env: { ...archiveEnv, OMC_JEV_COMPACT_TARGET: '0.1' } });
    const record = run.records()[0];
    expect(archived(run.files)).toHaveLength(240);
    expect(record.archive_written).toBe(240);
    expect(record.archive_skipped.cap).toBe(record.traced + record.kept_short - 240);
    expect(run.files.has(`${ARCHIVE}/t250.txt`)).toBe(true);
    expect(run.files.has(`${ARCHIVE}/t1.txt`)).toBe(false);
    const shadow = await compactOnce(messages, { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET: '0.1', OMC_JEV_COMPACT_ARCHIVE: 'shadow' } });
    expect(shadow.records()[0].archive_planned).toBe(240);
  }, 60000);

  it('results that stay whole use none of the scan time: slow-to-mask task-list results do not make the traced ones `time`', async () => {
    const slow = 'password'.repeat(6000);
    maskSecrets(slow); // the first run is cold, the time of the second is the one that counts
    const t = Date.now();
    maskSecrets(slow);
    const one = Date.now() - t;
    const n = Math.min(40, Math.max(2, Math.ceil(2000 / Math.max(one, 1)) + 1));
    // the oldest results: with more than 240 candidates they are not among the ones sent to Jev, whose own masking is slow on them too
    const messages = conversation(250, { tool: (i) => (i <= n ? 'TaskUpdate' : 'Bash'), result: (i) => (i <= n ? `${slow} ${i}` : `RESULT-${i} ${'x'.repeat(2000)}`) });
    const run = await compactOnce(messages, { env: archiveEnv });
    const record = run.records()[0];
    for (let i = 1; i <= n; i++) expect(run.files.has(`${ARCHIVE}/t${i}.txt`)).toBe(false);
    expect(record.archive_skipped?.time).toBeUndefined();
    expect(record.archive_written + (record.archive_skipped?.cap ?? 0)).toBe(record.traced);
  }, 90000);

  it('the paths are planned until the allocation stops cutting more results: no cut result is left without a verdict (kept_full)', async () => {
    const run = await compactOnce(conversation(12, { chars: 150 }), { env: { ...archiveEnv, OMC_JEV_COMPACT_TARGET: '0.815' } });
    const record = run.records()[0];
    expect(record.archive_skipped?.kept_full).toBeUndefined();
    expect(record.archive_written).toBe(record.traced + record.kept_short);
  });

  it('when every archive write fails, the allocation is the one of a run without the archive (fail-open)', async () => {
    const messages = conversation(8, { chars: 100 });
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET: '0.7' };
    const off = await compactOnce(messages, { env });
    const fake = fakeDollar({ env: { ...env, OMC_JEV_COMPACT_ARCHIVE: 'active' } });
    const write = fake.$.fs.write;
    fake.$.fs.write = async (p, text) => { if (p.includes('/compaction-archive/')) throw new Error('EACCES'); return write(p, text); };
    await load()['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages }), summaryNext());
    expect(off.records()[0].kept_full).toBeGreaterThan(0);
    expect(fake.records()[0]).toMatchObject({ kept_full: off.records()[0].kept_full, traced: off.records()[0].traced, archive_written: 0 });
  });

  it('shadow plans what active writes when the paths cut one more result (the same rounds on copies, the conversation as without the archive)', async () => {
    const messages = conversation(8, { chars: 150 });
    const env = { ...ACTIVE_ENV, OMC_JEV_COMPACT_TARGET: '0.625' };
    const active = await compactOnce(messages, { env: { ...env, OMC_JEV_COMPACT_ARCHIVE: 'active' } });
    const shadow = await compactOnce(messages, { env: { ...env, OMC_JEV_COMPACT_ARCHIVE: 'shadow' } });
    const base = await compactOnce(messages, { env });
    expect(shadow.records()[0].archive_planned).toBe(active.records()[0].archive_written);
    expect(shadow.out.messages).toEqual(base.out.messages);
  });
});

describe('jev-compaction module: pasted text (OMC_JEV_COMPACT_PASTES)', () => {
  // A <pasted_content> tag says that the user pasted the text, not who wrote it. The rule under test: no sentence of the user leaves the
  // conversation, so a tag moves to a file only when Jev, who read all of it, says that none of it is the user's own writing; text outside
  // tags never moves; tags never join; the default is off.
  const PASTES = { ...ACTIVE_ENV, OMC_JEV_COMPACT_PASTES: 'active' };
  const DIR = `${STATE}/compaction-pastes/sess-1`;
  const tag = (inner, id = 1) => `<pasted_content id="${id}">${inner}</pasted_content>`;
  const filler = (word, n) => `${word} `.repeat(Math.ceil(n / (word.length + 1))).slice(0, n);
  // A tag of exactly `n` characters.
  const sized = (n, id = 1) => tag(filler('alpha', n - `<pasted_content id="${id}"></pasted_content>`.length), id);
  const OUTSIDE = 'Please check the report below and tell me what you think of it.';
  const MINE = 'MY-OWN-WORDS: I decided to keep option B, do not touch the cache.';

  /** The first message, then the user messages `texts` one after the other, then 30 call/result pairs and a closing exchange. */
  function withPastes(texts, options) {
    const base = conversation(30, options);
    const rows = texts.map((text, k) => Object.freeze({ role: 'user', text, toolUses: [], handle: `p${k}` }));
    return [base[0], ...rows, ...base.slice(1)];
  }

  /** The API form of a conversation; a row in `images` also holds an image block. */
  function apiOf(messages, images = []) {
    return messages.map((m, i) => (m.role === 'assistant'
      ? { role: 'assistant', content: [...(m.text ? [{ type: 'text', text: m.text }] : []), ...(m.toolUses || []).map((u) => ({ type: 'tool_use', id: u.tool_use_id, name: u.tool, input: u.input }))] }
      : { role: 'user', content: m.toolResults?.length ? m.toolResults.map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.text })) : [{ type: 'text', text: m.text }, ...(images.includes(i) ? [{ type: 'image', source: {} }] : [])] }));
  }

  /** Jev's answer to the pasted-text question: `noul` is a probability or a function of the tag text; scoring is the usual one. */
  const jevSays = (noul) => (body) => (body.questions.pasted
    ? okResponse({ answers: { pasted: { type: 'noul', noul: typeof noul === 'function' ? noul(body.state.fragment.text) : noul } } })
    : okResponse(scoreByMarker(body)));
  const isPasteRequest = (c) => Boolean(c.body.questions.pasted);

  async function compactPastes(messages, { env = PASTES, jev = jevSays(0.95), api, images, event, ...options } = {}) {
    const handlers = load();
    const fake = fakeDollar({ env, respond: jev, messages, ...options });
    const form = api ?? apiOf(messages, images);
    fake.$.session.messages = async (opts) => (opts?.as === 'api' ? form : messages);
    const next = summaryNext();
    const out = await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages, ...event }), next);
    const requests = fake.calls.fetch.filter(isPasteRequest);
    const written = [...fake.files.keys()].filter((path) => path.startsWith(`${STATE}/compaction-pastes/`));
    return { out, next, handlers, requests, written, record: fake.records()[0], ...fake };
  }

  const userRow = (out, startsWith) => out.messages.find((m) => m.role === 'user' && m.text.startsWith(startsWith));
  const withoutTimes = (record) => { const copy = { ...record }; for (const key of ['ts', 'duration_ms', 'jev_ms']) delete copy[key]; return copy; };

  it('is off unless asked for: unset, off and any other value give the same conversation and record as without the module code', async () => {
    const report = sized(3000);
    const messages = withPastes([`${OUTSIDE} ${report}`]);
    const runs = [];
    for (const OMC_JEV_COMPACT_PASTES of [undefined, 'off', '', 'yes', '1', 'true']) {
      runs.push(await compactPastes(messages, { env: { ...ACTIVE_ENV, ...(OMC_JEV_COMPACT_PASTES === undefined ? {} : { OMC_JEV_COMPACT_PASTES }) } }));
    }
    for (const run of runs) {
      expect(run.requests).toHaveLength(0);
      expect(run.written).toHaveLength(0);
      expect(run.record).not.toHaveProperty('pastes');
      expect(JSON.stringify(run.out.messages)).toBe(JSON.stringify(runs[0].out.messages));
      expect(withoutTimes(run.record)).toEqual(withoutTimes(runs[0].record));
      expect(run.calls.fetch).toHaveLength(runs[0].calls.fetch.length);
    }
    expect(userRow(runs[0].out, OUTSIDE).text).toBe(`${OUTSIDE} ${report}`);
  });

  it('reads OMC_JEV_COMPACT_PASTES as off, shadow or active in any case; anything else is off', () => {
    expect([undefined, '', 'off', 'yes', '1', 'true', 'activ'].map(pasteMode)).toEqual(Array(7).fill('off'));
    expect(['active', 'Active', ' SHADOW ', 'shadow'].map(pasteMode)).toEqual(['active', 'active', 'shadow', 'shadow']);
  });

  it('moves a whole tag that Jev, having read all of it, clears: the file holds the tag, the trace the first 200 and last 300 characters, the words outside stay', async () => {
    const inner = `${filler('alpha', 1500)}${filler('omega', 1500)}`;
    const report = tag(inner);
    const messages = withPastes([`${OUTSIDE} ${report} Thanks, that is all.`]);
    const off = await compactPastes(messages, { env: ACTIVE_ENV });
    const run = await compactPastes(messages);
    // Jev got the whole tag, once, with the pasted-text question.
    expect(run.requests).toHaveLength(1);
    expect(run.requests[0].body.state).toEqual({ fragment: { text: report, chars: report.length } });
    expect(run.requests[0].body.questions.pasted).toMatchObject({ type: 'noul' });
    // The file holds the tag, byte for byte, under a name made from its content.
    expect(run.written).toHaveLength(1);
    const [path] = run.written;
    expect(path).toMatch(new RegExp(`^${DIR}/[0-9a-f]{32}\\.txt$`));
    expect(run.files.get(path)).toBe(report);
    // The row is rebuilt without its handle: the words around the tag, and the trace instead of the tag.
    const row = userRow(run.out, OUTSIDE);
    expect(row.handle).toBeUndefined();
    const trace = row.text.slice(OUTSIDE.length + 1, row.text.length - ' Thanks, that is all.'.length);
    expect(row.text).toBe(`${OUTSIDE} ${trace} Thanks, that is all.`);
    const match = /^\[pasted text moved at compaction: (\d+) chars, full text in (\S+); start: ("(?:[^"\\]|\\.)*"); end: ("(?:[^"\\]|\\.)*")\]$/.exec(trace);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBe(report.length);
    expect(match[2]).toBe(path);
    expect(JSON.parse(match[3])).toBe(inner.slice(0, 200));
    expect(JSON.parse(match[4])).toBe(inner.slice(-300));
    expect(trace.length).toBeLessThan(report.length);
    // The record counts it; the results kept and removed are the same as with the switch off.
    expect(run.record.pastes).toMatchObject({ mode: 'active', tags: 1, asked: 1, yes: 1, written: 1, moved: 1, moved_chars: report.length, trace_chars: trace.length, installed: true });
    for (const key of ['asked', 'requests', 'kept_full', 'kept_short', 'traced', 'score_hist', 'candidates']) expect(run.record[key]).toEqual(off.record[key]);
    expect(run.record.chars_after).toBe(off.record.chars_after - (report.length - trace.length));
    expect(run.out.messages).toHaveLength(off.out.messages.length);
  });

  it.each([
    ['below the bar', 0.79],
    ['no', 0.1],
    ['no answer', undefined],
    ['out of range', 2],
    ['not a number', 'yes'],
  ])('Jev says %s: the tag stays, nothing is written', async (_label, noul) => {
    const text = `${OUTSIDE} ${sized(3000)}`;
    const run = await compactPastes(withPastes([text]), { jev: jevSays(noul) });
    expect(run.requests).toHaveLength(1);
    expect(userRow(run.out, OUTSIDE).text).toBe(text);
    expect(run.written).toHaveLength(0);
    expect(run.record.pastes).toMatchObject({ asked: 1, yes: 0, moved: 0, installed: false });
  });

  it('moves a tag at 0.8 and keeps it when the request fails or times out', async () => {
    const text = `${OUTSIDE} ${sized(3000)}`;
    expect(userRow((await compactPastes(withPastes([text]), { jev: jevSays(0.8) })).out, OUTSIDE).text).not.toBe(text);
    const failing = (body) => (body.questions.pasted ? { ok: false, status: 500, headers: {}, text: '' } : okResponse(scoreByMarker(body)));
    const run = await compactPastes(withPastes([text]), { jev: failing });
    expect(userRow(run.out, OUTSIDE).text).toBe(text);
    expect(run.written).toHaveLength(0);
    expect(run.record.pastes).toMatchObject({ asked: 1, unanswered: 1, moved: 0 });
    // A failed request pauses the next ones like a failed scoring request.
    const second = await run.handlers['session.compact'](fakeDollar({ env: PASTES, respond: jevSays(0.95), messages: [] }).$, Object.freeze({ trigger: 'auto', messages: withPastes([text]) }), summaryNext());
    expect(second).toBe(SUMMARY);
  });

  it('a tag that ends with the user\'s own words stays when Jev sees them; when Jev errs the words in the last 300 characters still stand in the trace and every moved character was in the request', async () => {
    const text = `${OUTSIDE} ${tag(`${filler('alpha', 3000)}\n\n${MINE}`)}`;
    const careful = await compactPastes(withPastes([text]), { jev: jevSays((fragment) => (fragment.includes('MY-OWN-WORDS') ? 0.1 : 0.95)) });
    expect(userRow(careful.out, OUTSIDE).text).toBe(text);
    expect(careful.written).toHaveLength(0);
    const wrong = await compactPastes(withPastes([text]));
    const row = userRow(wrong.out, OUTSIDE);
    expect(row.text).not.toBe(text);
    expect(row.text).toContain(MINE);
    expect(wrong.requests[0].body.state.fragment.text).toContain(MINE);
    expect(wrong.files.get(wrong.written[0])).toContain(MINE);
  });

  it('never joins neighbouring tags: each is asked about and moved by itself, and a tag Jev refuses stays with the text between', async () => {
    const command = tag(`${filler('beta', 2400)} ${MINE}`, 1);
    const material = tag(filler('gamma', 3300), 2);
    const text = `${OUTSIDE}\n${command}\n${material}`;
    const run = await compactPastes(withPastes([text]), { jev: jevSays((fragment) => (fragment.includes('MY-OWN-WORDS') ? 0.05 : 0.95)) });
    expect(run.requests.map((c) => c.body.state.fragment.text).sort()).toEqual([command, material].sort());
    const row = userRow(run.out, OUTSIDE);
    expect(row.text.startsWith(`${OUTSIDE}\n${command}\n[pasted text moved at compaction: ${material.length} chars`)).toBe(true);
    expect(run.written).toHaveLength(1);
    expect(run.files.get(run.written[0])).toBe(material);
    // Both cleared: two traces, two files, the line break between them intact.
    const both = await compactPastes(withPastes([text]));
    const traces = [...userRow(both.out, OUTSIDE).text.matchAll(/\[pasted text moved at compaction: (\d+) chars/g)].map((m) => Number(m[1]));
    expect(traces).toEqual([command.length, material.length]);
    expect(both.written).toHaveLength(2);
    expect(userRow(both.out, OUTSIDE).text).toMatch(/^Please check[^\n]*\n\[pasted text moved[^\n]*\]\n\[pasted text moved[^\n]*\]$/);
  });

  it('never touches text outside a tag: a quotation with the user\'s comment in the same paragraph, a list, a code block', async () => {
    const quotation = `${filler('delta', 3000)} <- ${MINE}`;
    const code = `\`\`\`\n${filler('epsilon', 2500)}\n\`\`\``;
    const only = `${quotation}\n\n${code}`;
    const run = await compactPastes(withPastes([only, `${OUTSIDE} ${sized(3000)}\n\n${quotation}\n\n${code}`]), { jev: jevSays(0.99) });
    expect(userRow(run.out, filler('delta', 20)).text).toBe(only);
    const row = userRow(run.out, OUTSIDE);
    expect(row.text.endsWith(`\n\n${quotation}\n\n${code}`)).toBe(true);
    expect(row.text).toContain('[pasted text moved at compaction');
    expect(run.requests).toHaveLength(1);
    for (const c of run.requests) expect(c.body.state.fragment.text).not.toContain('MY-OWN-WORDS');
  });

  it('keeps a message that is nothing but the paste (alone, with a keyword, with a few characters): it sends that text as the user\'s own instruction', async () => {
    const report = sized(3000);
    const near = (outside) => `${outside}\n${report}`;
    const run = await compactPastes(withPastes([report, near('ultrathink'), near('x'.repeat(19)), `${report}\n${tag(filler('beta', 3000), 2)}`, near('x'.repeat(20))]));
    expect(run.requests).toHaveLength(1);
    expect(run.requests[0].body.state.fragment.text).toBe(report);
    const kept = run.out.messages.filter((m) => m.role === 'user' && m.text.includes('<pasted_content'));
    expect(kept.map((m) => m.text)).toEqual([report, near('ultrathink'), near('x'.repeat(19)), `${report}\n${tag(filler('beta', 3000), 2)}`]);
    expect(run.record.pastes).toMatchObject({ tags: 6, kept_whole: 5, moved: 1 });
  });

  it('leaves the first and the newest user message, the last six messages, and rows with an image alone', async () => {
    const report = sized(3000);
    const text = (k) => `${OUTSIDE} ${k} ${report}`;
    const base = conversation(30);
    const first = Object.freeze({ ...base[0], text: text('first') });
    const mid = [Object.freeze({ role: 'user', text: text('middle'), toolUses: [], handle: 'pm' }), Object.freeze({ role: 'user', text: text('image'), toolUses: [], handle: 'pi' })];
    // The newest user message and the tail rows: a paste in the closing exchange.
    const newest = Object.freeze({ ...base[base.length - 2], text: text('newest') });
    const messages = [first, ...mid, ...base.slice(1, -2), newest, base[base.length - 1]];
    const run = await compactPastes(messages, { images: [2] });
    expect(run.requests).toHaveLength(1);
    expect(userRow(run.out, `${OUTSIDE} first`).text).toBe(text('first'));
    expect(userRow(run.out, `${OUTSIDE} newest`).text).toBe(text('newest'));
    expect(userRow(run.out, `${OUTSIDE} image`).text).toBe(text('image'));
    expect(userRow(run.out, `${OUTSIDE} middle`).text).toContain('[pasted text moved at compaction');
    // The tail is the last six messages; a user message inside it stays even when it is not the newest.
    const tail = conversation(30);
    const inTail = [...tail.slice(0, -3), Object.freeze({ role: 'user', text: text('tail'), toolUses: [], handle: 'pt' }), ...tail.slice(-3)];
    const second = await compactPastes([Object.freeze({ ...inTail[0] }), Object.freeze({ role: 'user', text: text('early'), toolUses: [], handle: 'pe' }), ...inTail.slice(1)]);
    expect(userRow(second.out, `${OUTSIDE} tail`).text).toBe(text('tail'));
    expect(userRow(second.out, `${OUTSIDE} early`).text).toContain('[pasted text moved at compaction');
    expect(second.requests).toHaveLength(1);
  });

  it('moves nothing when an image message of the API form matches no row, or without the API form', async () => {
    const report = sized(3000);
    const messages = withPastes([`${OUTSIDE} ${report}`]);
    const api = apiOf(messages);
    api.splice(2, 0, { role: 'user', content: [{ type: 'text', text: 'A screenshot that no row shows.' }, { type: 'image', source: {} }] });
    const unmatched = await compactPastes(messages, { api });
    expect(unmatched.requests).toHaveLength(0);
    expect(unmatched.record.pastes).toMatchObject({ reason: 'image_unmatched', moved: 0 });
    const plain = await compactPastes(messages, { api: messages });
    expect(plain.requests).toHaveLength(0);
    expect(plain.record.pastes).toMatchObject({ reason: 'no_api_form' });
    expect(userRow(plain.out, OUTSIDE).text).toBe(`${OUTSIDE} ${report}`);
  });

  it('a tag with a secret, a secret path or a private path goes neither to Jev nor to a file', async () => {
    const key = 'sk-ant-api03-' + 'A1b2C3d4'.repeat(4);
    const secrets = [`${filler('alpha', 3000)} ANTHROPIC key ${key}`, `${filler('alpha', 3000)} cat /home/u/.ssh/id_rsa`, `${filler('alpha', 3000)} password: hunter2`, `${filler('alpha', 3000)} see /srv/clients/acme/notes`];
    const messages = withPastes([...secrets.map((s, k) => `${OUTSIDE} ${tag(s, k + 1)}`), `${OUTSIDE} PLAIN ${tag(filler('beta', 3000), 9)}`]);
    const run = await compactPastes(messages, { env: { ...PASTES, OMC_JEV_COMPACT_PRIVATE_PATHS: '/srv/clients' } });
    expect(run.requests).toHaveLength(1);
    expect(run.requests[0].body.state.fragment.text).toContain('beta');
    for (const c of run.calls.fetch) expect(JSON.stringify(c.body)).not.toMatch(/A1b2C3d4|\.ssh|hunter2|\/srv\/clients/);
    for (const path of run.written) expect(run.files.get(path)).not.toMatch(/A1b2C3d4|\.ssh|hunter2|\/srv\/clients/);
    expect(run.record.pastes).toMatchObject({ secret: 4, moved: 1 });
    for (const s of secrets) expect(run.out.messages.some((m) => m.text.includes(s))).toBe(true);
  });

  it('a tag moves only between 2000 characters and the smaller of 30000 and OMC_JEV_EXCERPT_CHARS_COMPACTION; Jev never gets a cut tag', async () => {
    const messages = withPastes([`${OUTSIDE} ${sized(1999)}`, `${OUTSIDE} ${sized(2000)}`, `${OUTSIDE} ${sized(4001)}`, `${OUTSIDE} ${sized(30001)}`]);
    const byDefault = await compactPastes(messages);
    expect(byDefault.requests.map((c) => c.body.state.fragment.text.length)).toEqual([2000]);
    expect(byDefault.record.pastes).toMatchObject({ small: 1, too_long: 2, moved: 1 });
    const raised = await compactPastes(messages, { env: { ...PASTES, OMC_JEV_EXCERPT_CHARS_COMPACTION: '100000' } });
    expect(raised.requests.map((c) => c.body.state.fragment.text.length).sort((a, b) => b - a)).toEqual([4001, 2000]);
    expect(raised.record.pastes).toMatchObject({ small: 1, too_long: 1, moved: 2 });
    for (const c of [...byDefault.requests, ...raised.requests]) expect(c.body.state.fragment.chars).toBe(c.body.state.fragment.text.length);
  });

  it('asks about the largest four tags only; the rest stay', async () => {
    const texts = [2500, 3500, 2600, 3900, 3100, 2200].map((n, k) => `${OUTSIDE} ${sized(n, k + 1)}`);
    const run = await compactPastes(withPastes(texts));
    expect(run.requests).toHaveLength(4);
    expect(run.requests.map((c) => c.body.state.fragment.text.length).sort((a, b) => a - b)).toEqual([2600, 3100, 3500, 3900]);
    expect(run.record.pastes).toMatchObject({ tags: 6, unasked: 2, asked: 4, moved: 4 });
  });

  it('shadow asks and counts but writes and changes nothing; active acts only while the point itself is active', async () => {
    const text = `${OUTSIDE} ${sized(3000)}`;
    const messages = withPastes([text]);
    const off = await compactPastes(messages, { env: ACTIVE_ENV });
    const shadow = await compactPastes(messages, { env: { ...ACTIVE_ENV, OMC_JEV_COMPACT_PASTES: 'shadow' } });
    expect(shadow.requests).toHaveLength(1);
    expect(shadow.written).toHaveLength(0);
    expect(JSON.stringify(shadow.out.messages)).toBe(JSON.stringify(off.out.messages));
    expect(shadow.record.pastes).toMatchObject({ mode: 'shadow', yes: 1, moved: 1, written: 0 });
    expect(shadow.record.pastes).not.toHaveProperty('installed');
    const pointShadow = await compactPastes(messages, { env: { ...PASTES, OMC_JEV: 'compaction' } });
    expect(pointShadow.out).toBe(SUMMARY);
    expect(pointShadow.written).toHaveLength(0);
    expect(pointShadow.record.pastes).toMatchObject({ mode: 'shadow' });
  });

  it('only in the main loop, and not without the API form, a session id or a state directory', async () => {
    const messages = withPastes([`${OUTSIDE} ${sized(3000)}`]);
    const sub = await compactPastes(messages, { event: { agentId: 'sub-1' } });
    expect(sub.requests).toHaveLength(0);
    expect(sub.record).not.toHaveProperty('pastes');
    const noDir = await compactPastes(messages, { env: { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'k', OMC_JEV_COMPACT_PASTES: 'active' } });
    expect(noDir.requests).toHaveLength(0);
    const noSession = await compactWith(messages, (fake) => { fake.$.session.id = async () => undefined; });
    expect(noSession.calls.fetch.filter(isPasteRequest)).toHaveLength(0);
    expect(noSession.record.pastes).toMatchObject({ reason: 'no_session', moved: 0 });
  });

  /** Like compactPastes, but `patch(fake)` may change the host's file interface or clock first. */
  async function compactWith(messages, patch) {
    const handlers = load();
    const fake = fakeDollar({ env: PASTES, respond: jevSays(0.95), messages });
    fake.$.session.messages = async (opts) => (opts?.as === 'api' ? apiOf(messages) : messages);
    patch?.(fake);
    const out = await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages }), summaryNext());
    return { out, record: fake.records()[0], ...fake };
  }
  const inPastes = (path) => path.includes('/compaction-pastes/');

  it('a file that cannot be written and read back whole in time leaves the tag: a write error, other content on read-back, a write that never ends', async () => {
    const report = sized(3000);
    const text = `${OUTSIDE} ${report}`;
    const messages = withPastes([text]);
    const stays = (run) => expect(userRow(run.out, OUTSIDE).text).toBe(text);
    const refusing = await compactWith(messages, (fake) => {
      const write = fake.$.fs.write;
      fake.$.fs.write = (path, body) => (inPastes(path) ? Promise.reject(new Error('EACCES')) : write(path, body));
    });
    stays(refusing);
    expect(refusing.record.pastes).toMatchObject({ yes: 1, write_failed: 1, written: 0, moved: 0, installed: false });
    const garbling = await compactWith(messages, (fake) => {
      const read = fake.$.fs.read;
      fake.$.fs.read = async (path) => { const body = await read(path); return inPastes(path) ? `${body}!` : body; };
    });
    stays(garbling);
    expect(garbling.record.pastes).toMatchObject({ write_failed: 1, moved: 0 });
    // Two cleared tags and a write that never ends: the first stays after the cap, the second is not even tried. The clock is faked
    // (timers of a second or more fire at once), so the test does not wait for the real host cap.
    const two = withPastes([`${OUTSIDE} ${sized(3000, 1)}`, `${OUTSIDE} again ${sized(3100, 2)}`]);
    let attempts = 0;
    const stalled = await compactWith(two, (fake) => {
      const write = fake.$.fs.write;
      fake.$.fs.write = (path, body) => { if (!inPastes(path)) return write(path, body); attempts++; return new Promise(() => {}); };
      fake.$.clock.after = (ms, fn) => { const t = setTimeout(fn, ms >= 1000 ? 50 : ms); return { cancel: () => clearTimeout(t) }; };
    });
    expect(attempts).toBe(1);
    expect(stalled.record.pastes).toMatchObject({ yes: 2, timed_out: 2, written: 0, moved: 0 });
    expect(stalled.record.result).toBe('jev');
    expect(userRow(stalled.out, OUTSIDE).text).toBe(`${OUTSIDE} ${sized(3000, 1)}`);
  });

  it('names the file after the sha-256 of the tag: an identical file is reused without a write, a broken one is written again', async () => {
    const report = sized(3000);
    const messages = withPastes([`${OUTSIDE} ${report}`]);
    const path = `${DIR}/${createHash('sha256').update(report).digest('hex').slice(0, 32)}.txt`;
    const reused = await compactWith(messages, (fake) => fake.files.set(path, report));
    expect(reused.record.pastes).toMatchObject({ reused: 1, written: 0, moved: 1, installed: true });
    expect(reused.calls.write).toBe(1); // the record
    const broken = await compactWith(messages, (fake) => fake.files.set(path, report.slice(0, 100)));
    expect(broken.files.get(path)).toBe(report);
    expect(broken.record.pastes).toMatchObject({ reused: 0, written: 1, moved: 1 });
  });

  it('writes no file when the compaction ends in the built-in summary, and the scoring request has the first claim on OMC_JEV_MAX_REQUESTS', async () => {
    const messages = withPastes([`${OUTSIDE} ${sized(3000)}`]);
    const scoringFails = (body) => (body.questions.pasted ? jevSays(0.95)(body) : { ok: false, status: 500, headers: {}, text: '' });
    const failed = await compactPastes(messages, { jev: scoringFails });
    expect(failed.out).toBe(SUMMARY);
    expect(failed.written).toHaveLength(0);
    expect(failed.record.pastes).toMatchObject({ yes: 1, moved: 0, installed: false });
    const capped = await compactPastes(messages, { env: { ...PASTES, OMC_JEV_MAX_REQUESTS: '1' } });
    expect(capped.calls.fetch).toHaveLength(1);
    expect(capped.requests).toHaveLength(0);
    expect(capped.record).toMatchObject({ result: 'jev' });
    expect(capped.record.pastes).toMatchObject({ held: 1, moved: 0 });
  });

  it('a trace holds no tag, even when the pasted text held tags of its own, so the next compaction leaves it alone', async () => {
    const text = `${OUTSIDE} <pasted_content id="1"><pasted_content id="9">${filler('alpha', 2900)}</pasted_content></pasted_content>`;
    const run = await compactPastes(withPastes([text]));
    const row = userRow(run.out, OUTSIDE);
    expect(row.text).toContain('[pasted text moved at compaction');
    expect(row.text).toContain('\\u003cpasted_content id=\\"9\\">alpha');
    expect(pasteTags(row.text)).toEqual([]);
    expect(row.text).not.toContain('<pasted_content');
  });

  it('pasteTags finds closed tags only, ends each at the first closing tag, never nests or joins them, and is linear on hostile text', () => {
    expect(pasteTags('no tags')).toEqual([]);
    expect(pasteTags('<pasted_content id="1">open only')).toEqual([]);
    expect(pasteTags('<pasted_content_x>no</pasted_content_x>')).toEqual([]);
    const text = 'a<pasted_content>one</pasted_content>b<pasted_content id="2">two <pasted_content>x</pasted_content> tail</pasted_content>';
    const tags = pasteTags(text);
    expect(tags.map((t) => text.slice(t.start, t.end))).toEqual(['<pasted_content>one</pasted_content>', '<pasted_content id="2">two <pasted_content>x</pasted_content>']);
    expect(tags.map((t) => text.slice(t.from, t.to))).toEqual(['one', 'two <pasted_content>x']);
    const started = performance.now();
    expect(pasteTags('<pasted_content'.repeat(30000))).toEqual([]);
    expect(pasteTags('<pasted_content>'.repeat(30000))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
