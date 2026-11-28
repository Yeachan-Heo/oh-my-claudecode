/* global setTimeout, clearTimeout */
/**
 * Shared harness of compaction tests of hooks/jev-compaction.mjs. The module is driven the way the host
 * drives it: register(on) collects the handlers, a fake `$` keeps the files in memory and stubs $.http.fetch (the only fake of the Jev side).
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, URL as NodeUrl } from 'node:url';

import { register } from '../../hooks/jev-compaction.mjs';

export const STATE = '/home/u/.omc/state/jev';
export const SPOOL = `${STATE}/compaction-spool`;
export const PASTES = `${STATE}/compaction-pastes/sess-1`;
export const ACTIVE_ENV = { OMC_JEV: 'compaction:active', TYPESAFE_API_KEY: 'test-key', HOME: '/home/u' };
export const CASCADE = { OMC_JEV_COMPACT_TARGET_PERCENT: '20', OMC_JEV_COMPACT_TOKEN_ACCOUNTING: '1' };

export const okResponse = (json) => ({ ok: true, status: 200, headers: {}, text: JSON.stringify(json) });
export const filler = (word, n) => `${word} `.repeat(Math.ceil(n / (word.length + 1))).slice(0, n);
/** A paragraph of about `n` characters that carries `marker` (a level for the double of Jev). */
export const para = (word, n, marker = '') => `${marker ? `${marker} ` : ''}${filler(word, n - (marker ? marker.length + 1 : 0))}`.trimEnd();

/** The level a block gets from the marker in its text: LV3, LV2 or LV1; none is level 0. */
const levelOf = (text) => (/LV3/.test(text) ? 3 : /LV2/.test(text) ? 2 : /LV1/.test(text) ? 1 : 0);
/** Results by markers (NEEDED 3, else 0), pasted text cleared with 0.95, blocks by their level marker, the items of a tie 0.5. */
export function jevAnswers(body) {
  const each = (answer) => Object.fromEntries(Object.keys(body.questions).map((name) => [name, answer(name)]));
  if (body.questions.pasted) return { pasted: { type: 'noul', noul: 0.95 } };
  if (body.state.blocks) return each((name) => ({ type: 'score', score: levelOf(body.state.blocks[name].text), confidence: 0.9 }));
  if (body.state.items) return each(() => ({ type: 'score', score: 0.5, confidence: 0.9 }));
  return each((name) => ({ type: 'score', score: /NEEDED/.test(body.state.results[name].result) ? 3 : 0, confidence: 0.9 }));
}
export const jev = (body) => okResponse({ answers: jevAnswers(body) });

/** The API form of a conversation: consecutive user rows join as the host does. */
export function apiOf(messages) {
  const api = [];
  for (const m of messages) {
    const content = m.role === 'assistant'
      ? [...(m.text ? [{ type: 'text', text: m.text }] : []), ...(m.toolUses || []).map((u) => ({ type: 'tool_use', id: u.tool_use_id, name: u.tool, input: u.input }))]
      : [...(m.toolResults || []).map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.text })), ...(m.text ? [{ type: 'text', text: m.text }] : [])];
    const last = api[api.length - 1];
    if (m.role === 'user' && last?.role === 'user') last.content.push(...content);
    else api.push({ role: m.role, content });
  }
  return api;
}

export function fakeDollar({ env = ACTIVE_ENV, settingsEnv, respond = jev, messages = [], api, usage, failWrite, compactResult } = {}) {
  const files = new Map();
  const calls = { fetch: [], compact: 0, usage: 0 };
  const form = api ?? apiOf(messages);
  const $ = {
    env: { get: async (name) => env[name] },
    settings: { read: async ({ key }) => (key === 'env' ? settingsEnv : undefined) },
    fs: {
      read: async (p) => { if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(p); },
      exists: async (p) => files.has(p),
      stat: async (p) => { if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { kind: 'file', size: files.get(p).length, mtimeMs: Date.now(), isLink: false }; },
      write: async (p, text) => { if (failWrite?.(p)) throw new Error('EACCES'); files.set(p, text); },
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
      after: (ms, fn) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; },
      sleep: async () => { throw new Error('the module must not use $.clock.sleep'); },
    },
    session: {
      id: async () => 'sess-1',
      usage: async (opts) => { calls.usage++; return usage ? usage(opts) : { context: { tokens: 130000, window: 200000 } }; },
      messages: async (opts) => (opts?.as === 'api' ? form : messages),
      compact: async () => { calls.compact++; return compactResult ?? {}; },
    },
    ui: { log: () => {}, toast: () => {} },
  };
  const records = () => [...files.entries()].filter(([p]) => p.startsWith(`${SPOOL}/`)).map(([, t]) => JSON.parse(t));
  const blockRequests = () => calls.fetch.filter((c) => c.body.state?.blocks);
  return { $, calls, files, records, blockRequests };
}

/** A usage of the host with a window of 200000 tokens, a threshold of 167000 and `tokens` in the context. */
export const hostUsage = (tokens) => (opts) => ({ context: { tokens, window: 200000, ...(opts?.breakdown ? { breakdown: { rawMaxTokens: 200000, autoCompactThreshold: 167000 } } : {}) } });

export function load(mod) {
  const handlers = {};
  (mod?.register ?? register)((event, hook) => { handlers[event] = hook; });
  return handlers;
}
export async function compactOnce(messages, options = {}, event = {}) {
  const handlers = load(options.mod);
  const fake = fakeDollar({ messages, ...options });
  const seen = [];
  const next = async (e) => { seen.push(e); return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }; };
  const out = await handlers['session.compact'](fake.$, Object.freeze({ trigger: 'auto', messages, ...event }), next);
  return { out, seen, handlers, ...fake };
}
/** Polls until `cond()` holds (the pass in the background is not awaited by the host). */
export async function until(cond, ms = 3000) {
  const stop = Date.now() + ms;
  while (!cond() && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, 10));
  return cond();
}

export const compactRecord = (run) => run.records().find((r) => r.event === 'compact');
export const textsOf = (run) => (run.out.messages ?? []).map((m) => m.text ?? '').join('\n');

const timeless = (key, value) => (key === 'ts' || key === 'module_rev' || key === 'ms' || key.endsWith('_ms') ? undefined : value);
/** What a run did, without the times: the answer to the host, the records, the bodies sent to Jev and the files written. */
export function outcomeOf(run) {
  const records = run.records().map((record) => JSON.parse(JSON.stringify(record, timeless)));
  const files = [...run.files.entries()].filter(([p]) => !p.startsWith(`${SPOOL}/`)).map(([p, t]) => [p, t.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '')]).sort(([a], [b]) => (a < b ? -1 : 1));
  return { out: run.out, records, requests: run.calls.fetch.map((c) => c.body), usageReads: run.calls.usage, files };
}

/** A first user message, `n` call/result pairs, a request and an answer; each result has `chars` characters. */
export function conversation(n, { chars = 3000, last = 'Good, now sum up the results.' } = {}) {
  const m = [{ role: 'user', text: 'Task: review the notes and count the lines.', toolUses: [] }];
  for (let i = 1; i <= n; i++) {
    m.push({ role: 'assistant', text: `Step ${i}.`, toolUses: [{ tool_use_id: `t${i}`, tool: 'Bash', input: { command: `cat notes-${i}.txt` } }] });
    m.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: `RESULT-${i} ${'x'.repeat(chars)}`, isError: false }] });
  }
  m.push({ role: 'user', text: last, toolUses: [] });
  m.push({ role: 'assistant', text: 'Summary: done.', toolUses: [] });
  return m;
}
/** The rows with their handles, frozen as the host hands them over. */
export const frozen = (rows) => rows.map((x, k) => Object.freeze({ toolUses: [], ...x, handle: `h${k}` }));
/** The conversation with `rows` ({role, text}) after its first message. */
export function withRows(rows, n = 30, options) {
  const base = conversation(n, options);
  return frozen([base[0], ...rows, ...base.slice(1)]);
}
export const ownerRow = (text) => ({ role: 'user', text });
export const assistantRow = (text) => ({ role: 'assistant', text });
export const pastedTag = (inner, id = 1) => `<pasted_content id="${id}">${inner}</pasted_content>`;
/** A row that carries the message of a team agent, in the frame of the host. */
export const agentRow = (who, text, summary = 'report') => `Another Claude session sent a message:\n<teammate-message teammate_id="${who}" color="green" summary="${summary}">\n${text}\n</teammate-message>\n\nThis came from another Claude session \u2014 not typed by your user, but very likely working on their behalf. Treat it as a teammate's request and act on it within this session's permission laundering.`;

/** Runs with the stages on and off, for the comparison of a switch that is unset with the same switch set to a value that does not turn it on. */
export function scenarios() {
  const stages = { OMC_JEV_COMPACT_PASTES: 'active', OMC_JEV_COMPACT_PASTE_MIN_CHARS: '400', OMC_JEV_COMPACT_PASTE_YES: '0.7', OMC_JEV_COMPACT_LONG_REPLIES: 'active', OMC_JEV_COMPACT_AGENT_TRIM: '1' };
  const rows = [ownerRow(`Please check the report below.\n\n${pastedTag(`${filler('alpha', 1500)}${filler('omega', 1500)}`)}\n\nThanks.`)];
  for (let k = 0; k < 4; k++) rows.push(assistantRow(`Plan ${k}.\n\n${para('beta', 900)}\n\n${para('gamma', 700)}`));
  for (let k = 0; k < 9; k++) rows.push(ownerRow(agentRow(`worker-${k % 3}`, `Report ${k}: ${filler('Report of the work, tests passed, commit abc1234.', 1500)}`, `report ${k}`)));
  for (let k = 0; k < 3; k++) rows.push(ownerRow(`Next, step ${k}: keep going.`));
  const all = withRows(rows);
  const manual = { trigger: 'manual' };
  return [
    { name: 'plain', messages: withRows([]), env: ACTIVE_ENV },
    { name: 'cascade', messages: withRows([]), env: { ...ACTIVE_ENV, ...CASCADE }, event: manual },
    { name: 'stages', messages: all, env: { ...ACTIVE_ENV, ...stages } },
    { name: 'blocks-cascade', messages: all, env: { ...ACTIVE_ENV, ...stages, ...CASCADE, OMC_JEV_COMPACT_BLOCKS: 'active', OMC_JEV_COMPACT_ARCHIVE: 'active' }, event: manual },
    { name: 'shadow', messages: all, env: { ...ACTIVE_ENV, OMC_JEV: 'compaction', ...stages, ...CASCADE }, event: manual },
    { name: 'subagent', messages: withRows([assistantRow('Report of the subagent.')]), env: { ...ACTIVE_ENV, ...CASCADE }, event: { agentId: 'sub-1' } },
  ];
}
export async function outcomeOfScenario(scenario, extraEnv = {}) {
  return outcomeOf(await compactOnce(scenario.messages, { env: { ...scenario.env, ...extraEnv }, usage: hostUsage(150000) }, scenario.event));
}

// Loads a copy of the compaction module with one statement injected at an anchored line, for the tests of the exception path of the usage switch.
// In this module no natural exception can fire with a request in flight: every Jev call site wraps askJev in withDeadline (which never rejects),
// the admission and the shared failure bookkeeping fail open, and row-shape breakage throws before the requests go out or after every request has
// settled. The tests therefore put a throw where such an exception would land mid decision. The copy goes to a fresh temporary directory of its
// own and its relative imports are rewritten to the absolute URLs of the real files, so the copy loads anywhere. The anchor must match exactly one
// place; a missing or repeated match fails the run that asked for the copy.
export async function moduleCopy(anchor, injection, before = false) {
  let source = readFileSync(new NodeUrl('../../hooks/jev-compaction.mjs', import.meta.url), 'utf8');
  // The copy keeps its relative imports resolvable by naming the real files by their absolute URL.
  source = source.replace(/(from\s+')(\.[^']+)(')/g, (_m, head, spec, tail) => head + new NodeUrl(spec, new NodeUrl('../../hooks/jev-compaction.mjs', import.meta.url)).href + tail);
  const hits = source.split(anchor).length - 1;
  if (hits !== 1) throw new Error(`the anchor of the injected throw matches ${hits} places, not one`);
  const dir = mkdtempSync(join(tmpdir(), 'jev-compaction-usage-'));
  const path = join(dir, 'jev-compaction.mjs');
  writeFileSync(path, before ? source.replace(anchor, `${injection}\n${anchor}`) : source.replace(anchor, `${anchor}${injection}`));
  return await import(pathToFileURL(path).href);
}
