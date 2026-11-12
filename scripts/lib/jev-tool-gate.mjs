/* global process, Buffer */
/**
 * Jev tool gate (point `tool-gate`): EXPERIMENT, NEGATIVE RESULT, NOT FOR MERGE.
 * See docs/jev/negative-results/jev-tool-gate.md.
 *
 * A PreToolUse check that asks Jev, before a tool call runs, whether the call may go ahead.
 * Off unless OMC_JEV names `tool-gate` explicitly: `all` and `all:active` never enable it
 * (`tool-gate:off` switches it off again). `tool-gate` alone runs it in shadow (answers are
 * logged, nothing is blocked); `tool-gate:active` lets a denial block the call.
 *
 * Order of evaluation of one call:
 *   1 scope      which tools are covered (gateScope)
 *   2 fixed rules  regular expressions from OMC_JEV_GATE_RULES or the built-in core; no Jev, they
 *                  also work while Jev is down
 *   3 safe list  a few read-only commands go through without a query
 *   4 one query  six `noul` questions (five risk axes and one authorization question), see
 *                scripts/lib/jev-tool-gate-questions.json (verbatim copy of the texts that ran)
 *   5 verdict    only allow or deny (a hook never returns "ask": it blocks even under
 *                bypassPermissions), every error is fail-open
 *   6 log        one row per call in <jev log dir>/gate.jsonl
 *
 * This is a reduced port of a much larger local implementation (about 3 900 lines, with a shell
 * parser that unpacked nested interpreters to depth 3). What is kept as it ran: the six questions,
 * the state keys, the verdict arithmetic, the timeouts, the log row. What is simplified: the fixed
 * rules (three generic examples), the safe list, and the task context (read from the transcript).
 * The state keys of the questions are the Polish ones of the original (rozpakowane, skrypty,
 * zadanie, ...), because the question texts name them.
 */

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveJevLogMaxBytes, rotateJevLog } from '../jev-resolve.mjs';
import { maskSecrets } from './jev-mask.mjs';
import { jevNoulOf, recordJevShadow } from './jev-shadow.mjs';

export const GATE_POINT = 'tool-gate';
export const GATE_AXES = ['niszczace', 'wyprowadzenie', 'uprawnienia', 'sekret', 'trwala'];
export const DEFAULT_THRESHOLD = 0.9; // a risk at or above this denies (inclusive) ...
export const DEFAULT_ORDERED_MIN = 0.5; // ... when the "zlecone" (ordered) answer is below this
export const GATE_TIMEOUT_MS = 4500; // the query timeout is raised to this (the default of the resolver is 2000)
export const INPUT_HEAD_CHARS = 6000; // the tool input sent to Jev: 6000 from the start and 2000 from the end
export const INPUT_TAIL_CHARS = 2000;
export const OWNER_MESSAGES = 3; // last owner messages sent as the task
export const OWNER_MESSAGE_CHARS = 2000;
const TRANSCRIPT_TAIL_BYTES = 400_000;

const here = dirname(fileURLToPath(import.meta.url));
const questionsJson = JSON.parse(readFileSync(join(here, 'jev-tool-gate-questions.json'), 'utf8'));
export const GATE_QUESTIONS = Object.fromEntries(
  Object.entries(questionsJson).map(([name, q]) => [name, { type: 'noul', instructions: q.instructions, criteria: { true: q.criteria.true, false: q.criteria.false } }]),
);

export const AXIS_LABEL = {
  niszczace: 'an action that destroys data, a service or the system',
  wyprowadzenie: 'sending data off the machine',
  uprawnienia: 'raising privileges or weakening protection',
  sekret: 'exposing a secret',
  trwala: 'a lasting change outside the project',
};

/** The mode named for `tool-gate` in OMC_JEV: off | shadow | active. `all` never enables it. */
export function gateEntryMode(env = process.env) {
  const raw = String(env.OMC_JEV ?? '').trim();
  if (!raw || raw === 'off') return 'off';
  let mode = 'off';
  for (const entry of raw.split(',')) {
    const token = entry.trim();
    if (!token) continue;
    const colon = token.lastIndexOf(':');
    const name = colon === -1 ? token : token.slice(0, colon);
    if (name !== GATE_POINT) continue;
    const suffix = colon === -1 ? '' : token.slice(colon + 1).trim().toLowerCase();
    mode = suffix === 'active' ? 'active' : suffix === 'off' ? 'off' : 'shadow';
  }
  return mode;
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MCP_READONLY = /^(?:get|list|read|search|query|status|find|describe|show|view|stats?|summary|count|inspect|peek|trace|check|lsp|ast_grep_search|tabs|screenshot|snapshot|console|network|wait|resize|hover)/;

/** Which tools the gate covers. kind: shell | write | read | net | schedule | message | workflow | mcp | none; jev: may a query be asked. */
export function gateScope(toolName) {
  const name = String(toolName ?? '');
  if (SHELL_TOOLS.has(name)) return { kind: 'shell', jev: true };
  if (WRITE_TOOLS.has(name)) return { kind: 'write', jev: true };
  if (name === 'Read' || name === 'NotebookRead' || name === 'Grep' || name === 'Glob') return { kind: 'read', jev: false };
  if (name === 'WebFetch' || name === 'WebSearch') return { kind: 'net', jev: true };
  if (name === 'CronCreate' || name === 'RemoteTrigger') return { kind: 'schedule', jev: true };
  if (name === 'SendMessage') return { kind: 'message', jev: true };
  if (name === 'Workflow') return { kind: 'workflow', jev: true };
  if (name.startsWith('mcp__')) {
    const action = name.split('__').slice(2).join('__');
    return MCP_READONLY.test(action) ? { kind: 'none', jev: false } : { kind: 'mcp', jev: true };
  }
  return { kind: 'none', jev: false };
}

/** Head and tail of a long text with a marker in the middle. */
export function headTail(text, head = INPUT_HEAD_CHARS, tail = INPUT_TAIL_CHARS) {
  const s = String(text ?? '');
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)}\n[... ${s.length - head - tail} characters omitted ...]\n${s.slice(-tail)}`;
}

export function normalizeCall(data) {
  const input = data?.tool_input ?? data?.toolInput;
  return {
    tool_name: String(data?.tool_name ?? data?.toolName ?? ''),
    tool_input: input && typeof input === 'object' ? input : {},
    cwd: typeof data?.cwd === 'string' ? data.cwd : typeof data?.directory === 'string' ? data.directory : '',
    session_id: data?.session_id ?? data?.sessionId,
    agent_id: data?.agent_id ?? data?.agentId,
    transcript_path: data?.transcript_path ?? data?.transcriptPath,
    permission_mode: data?.permission_mode ?? data?.permissionMode,
  };
}

/** The text of the call: the command for a plain shell call, else the input as JSON. */
export function renderInput(call) {
  const input = call.tool_input;
  if (typeof input.command === 'string' && Object.keys(input).every((k) => ['command', 'description', 'timeout', 'run_in_background'].includes(k))) return input.command;
  try { return JSON.stringify(input); } catch { return String(input); }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Fixed rules (no Jev). The built-in core is deliberately small and generic. OMC_JEV_GATE_RULES may point at a JSON file of the same
// shape: { "rules": [{ "name", "kinds": ["shell", ...], "regex", "flags", "hint" }], "verdict": { "threshold", "ordered_min", "jev_denies" } }.
// A file that does not load or build is replaced by the core and the reason goes to the log row.
// ---------------------------------------------------------------------------------------------------------------------------

export const CORE_RULES = {
  rules: [
    {
      name: 'catastrophic-delete',
      kinds: ['shell'],
      regex: String.raw`\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:-\S+\s+)*(?:\/|\/\*|~\/?|~\/\*|\$HOME\/?)(?=\s|$|[;&|])`,
      hint: 'Delete a named directory inside the project instead of the root or the home directory.',
    },
    {
      name: 'service-or-container-stop',
      kinds: ['shell'],
      regex: String.raw`\b(?:systemctl|service)\s+(?:stop|restart|disable|mask|kill)\b|\bdocker\s+(?:stop|restart|kill|rm)\b`,
      hint: 'Stopping or restarting a service or a container needs an explicit order that names it.',
    },
    {
      name: 'private-key-file',
      kinds: ['shell', 'write', 'read', 'mcp'],
      regex: String.raw`\.ssh/id_(?:rsa|ed25519|ecdsa|dsa)(?!\.pub)\b`,
      hint: 'Private key files are not read or written by the agent.',
    },
  ],
  verdict: { threshold: DEFAULT_THRESHOLD, ordered_min: DEFAULT_ORDERED_MIN, jev_denies: true },
};

export function compileRules(json) {
  if (!json || !Array.isArray(json.rules)) throw new Error('rules: missing list');
  const rules = json.rules.map((r) => {
    if (typeof r?.name !== 'string' || typeof r.regex !== 'string') throw new Error('rule without name or regex');
    return { name: r.name, kinds: Array.isArray(r.kinds) ? r.kinds : ['shell'], re: new RegExp(r.regex, r.flags ?? 'i'), hint: r.hint ?? '' };
  });
  const v = json.verdict ?? {};
  const num = (x, d) => (Number.isFinite(Number(x)) && Number(x) > 0 && Number(x) <= 1 ? Number(x) : d);
  return { rules, threshold: num(v.threshold, DEFAULT_THRESHOLD), orderedMin: num(v.ordered_min, DEFAULT_ORDERED_MIN), jevDenies: v.jev_denies !== false };
}

export function loadRules(env = process.env) {
  const path = env.OMC_JEV_GATE_RULES;
  if (path) {
    try { return { ok: true, rules: compileRules(JSON.parse(readFileSync(path, 'utf8'))) }; } catch (error) {
      return { ok: false, error: `rules file not in force: ${String(error instanceof Error ? error.message : error).slice(0, 120)}`, rules: compileRules(CORE_RULES) };
    }
  }
  return { ok: true, rules: compileRules(CORE_RULES) };
}

export function staticHits(kind, text, rules) {
  return rules.rules.filter((r) => r.kinds.includes(kind) && r.re.test(text));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Safe list: simple read-only commands without any shell syntax go through without a query.
// ---------------------------------------------------------------------------------------------------------------------------

const SAFE_COMMANDS = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'date', 'whoami', 'which', 'stat', 'file', 'grep', 'rg', 'true']);
const SAFE_GIT = new Set(['status', 'log', 'diff', 'show']);

export function isSafeCall(kind, text) {
  if (kind !== 'shell') return false;
  const command = String(text ?? '').trim();
  if (!command || /[;&|<>`$(){}\\\n]/.test(command)) return false;
  const words = command.split(/\s+/);
  if (words[0] === 'git') return SAFE_GIT.has(words[1] ?? '') && !words.some((w) => w.startsWith('--output'));
  return SAFE_COMMANDS.has(words[0]);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Static detector of a real secret pattern in the input: decides whether the "sekret" axis of Jev counts.
// ---------------------------------------------------------------------------------------------------------------------------

const REAL_SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/,
  /\b(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-)[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}/,
  /:\/\/[^/\s:@]+:[^/\s@]{4,}@/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
];
const SECRET_ASSIGNMENT = /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)\w*["']?\s*[:=]\s*["']?([^\s"'&;|,}]{8,})/gi;
const PLACEHOLDER_VALUE = /^(?:<[^>]*>|\$[\w{(]|%\w|\*{3}|x{4,}|\.{3}|changeme|your[-_]|example|placeholder|process\.env|os\.environ|\$\{)/i;

/** true when the text holds a real secret pattern (a key, a token, a password whose value is not a placeholder). */
export function detectRealSecret(text) {
  const s = String(text ?? '');
  if (REAL_SECRET_PATTERNS.some((re) => re.test(s))) return true;
  SECRET_ASSIGNMENT.lastIndex = 0;
  for (let m = SECRET_ASSIGNMENT.exec(s); m; m = SECRET_ASSIGNMENT.exec(s)) {
    const value = m[1];
    if (PLACEHOLDER_VALUE.test(value) || /^test[-_]?token/i.test(value)) continue;
    if ((/[0-9]/.test(value) && /[A-Za-z]/.test(value)) || (/[^A-Za-z0-9]/.test(value) && value.length >= 10)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Task context: the last owner messages and the assistant question before them, read from the end of the session transcript.
// (The original kept the task in a state file written at UserPromptSubmit and also sent the first message and the plan.)
// ---------------------------------------------------------------------------------------------------------------------------

function readTail(path, bytes) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  if (content.some((b) => b?.type === 'tool_result')) return '';
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

export function readOwnerTask(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) return null;
  const lines = readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES).split('\n').slice(1); // the first line may be cut
  const owner = [];
  let assistantBeforeLast = null;
  let lastAssistant = null;
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.isSidechain) continue;
    if (row?.type === 'assistant') {
      const text = textOf(row.message);
      if (text) lastAssistant = text;
    } else if (row?.type === 'user') {
      const text = textOf(row.message).trim();
      if (!text || text.startsWith('<')) continue;
      owner.push(text);
      assistantBeforeLast = lastAssistant;
      lastAssistant = null;
    }
  }
  return { owner_messages: owner.slice(-OWNER_MESSAGES), assistant_before_last: assistantBeforeLast };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The state sent to Jev (secrets masked first).
// ---------------------------------------------------------------------------------------------------------------------------

export function buildGateState(call, inputText, task) {
  const mask = (t) => maskSecrets(String(t ?? ''));
  const zadanie = {
    wiadomosci_wlasciciela: (task?.owner_messages ?? []).map((m) => mask(m).slice(0, OWNER_MESSAGE_CHARS)),
    pytanie_asystenta: task?.assistant_before_last ? mask(task.assistant_before_last).slice(-OWNER_MESSAGE_CHARS) : null,
  };
  return {
    toolName: call.tool_name,
    toolInput: headTail(mask(inputText)),
    cwd: call.cwd || null,
    permissionMode: call.permission_mode || null,
    podmiot: call.agent_id ? 'subagent' : 'agent',
    zadanie,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Verdict: only allow or deny.
// answers: { niszczace, wyprowadzenie, uprawnienia, sekret, trwala, zlecone } as numbers 0..1 (missing ones undefined).
// The highest risk axis is compared with the threshold (inclusive); the call is denied when the risk reaches it and the task does not
// clearly order the call ("zlecone" below orderedMin). Without a real secret pattern in the input the "sekret" axis is zeroed
// (text about keys is not a key). No answer at all means allow.
// ---------------------------------------------------------------------------------------------------------------------------

export function verdictFromAnswers(answers, { secretFound = false, threshold = DEFAULT_THRESHOLD, orderedMin = DEFAULT_ORDERED_MIN } = {}) {
  let risk = 0;
  let axis = null;
  let answered = 0;
  for (const name of GATE_AXES) {
    let value = answers?.[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    answered++;
    if (name === 'sekret' && !secretFound) value = 0;
    if (value > risk) { risk = value; axis = name; }
  }
  const orderedRaw = answers?.zlecone;
  const ordered = typeof orderedRaw === 'number' && Number.isFinite(orderedRaw) ? orderedRaw : 0;
  if (answered === 0) return { decision: 'allow', risk: 0, axis: null, ordered, answered: 0 };
  const deny = risk >= threshold && ordered < orderedMin;
  return { decision: deny ? 'deny' : 'allow', risk, axis, ordered, answered };
}

const pct = (n) => Math.round(Number(n) * 100) / 100;

export function denyMessages(toolName, finding) {
  if (finding.source === 'static') {
    return {
      reason: `Blocked by the tool gate: fixed rule "${finding.rule.name}". ${finding.rule.hint}`.trim(),
      systemMessage: `The tool gate blocked ${toolName}: rule ${finding.rule.name}.`,
    };
  }
  const label = AXIS_LABEL[finding.axis] ?? 'a high-risk action';
  return {
    reason: `Blocked by the tool gate: ${label}, and the task does not order it explicitly (risk ${pct(finding.risk)}, ordered ${pct(finding.ordered)}). If the owner wants this, ask for it by name.`,
    systemMessage: `The tool gate blocked ${toolName}: ${label}; the task does not order it explicitly.`,
  };
}

/** The verdict of one call from Jev's answers (shared by runGate and the replay script). */
export function decideWithAnswers(call, answers, secretFound, rules) {
  const verdict = verdictFromAnswers(answers, { secretFound, threshold: rules.threshold, orderedMin: rules.orderedMin });
  const extra = {
    axes: Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== undefined).map(([k, v]) => [k, pct(v)])),
    risk: pct(verdict.risk), axis: verdict.axis, ordered: pct(verdict.ordered), secret_pattern: secretFound,
  };
  if (verdict.decision === 'deny' && !rules.jevDenies) return { decision: 'allow', extra: { ...extra, would_deny: true }, verdict };
  if (verdict.decision === 'deny') Object.assign(extra, denyMessages(call.tool_name, { source: 'jev', axis: verdict.axis, risk: verdict.risk, ordered: verdict.ordered }));
  return { decision: verdict.decision, extra, verdict };
}

function withEnv(patch, fn) {
  const saved = {};
  for (const key of Object.keys(patch)) {
    saved[key] = process.env[key];
    process.env[key] = patch[key];
  }
  try { return fn(); } finally {
    for (const key of Object.keys(patch)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
}

function logRow(row, env, stateDir) {
  try {
    const dir = env.OMC_JEV_LOG_DIR || join(stateDir ?? process.cwd(), 'jev');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'gate.jsonl');
    rotateJevLog(path, resolveJevLogMaxBytes(env));
    appendFileSync(path, JSON.stringify(row) + '\n');
  } catch { /* the log never breaks the hook */ }
}

const ms = (started) => Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10;

/**
 * The hook entry point. Never throws: on any error the call goes through (fail-open) and the error is logged.
 * options: { env, stateDir, rules, task, query }. `query` replaces the request to Jev (tests and replays); it gets
 * { point, state, questions, heuristic, permissionMode } and returns what recordJevShadow returns.
 * Returns { handled, decision, enforced, source, reason?, systemMessage? } and writes one gate.jsonl row.
 */
export function runGate(data, options = {}) {
  const started = process.hrtime.bigint();
  const env = options.env ?? process.env;
  const mode = gateEntryMode(env);
  const base = { handled: false, decision: 'allow', enforced: false, source: 'off' };
  if (mode === 'off') return base;
  const call = normalizeCall(data);
  const scope = gateScope(call.tool_name);
  if (scope.kind === 'none') return base;
  const row = { ts: new Date().toISOString(), point: GATE_POINT, tool_name: call.tool_name, session_id: call.session_id ?? null, mode };
  try {
    const loaded = options.rules ? { ok: true, rules: options.rules } : loadRules(env);
    if (!loaded.ok) row.rules_error = loaded.error;
    const text = renderInput(call);
    const finish = (decision, source, extra = {}) => {
      const enforced = decision === 'deny' && mode === 'active';
      Object.assign(row, { decision, enforced, source }, extra);
      if (decision === 'deny' || extra.would_deny) row.command = maskSecrets(text).slice(0, 300);
      row.durationMs = ms(started);
      logRow(row, env, options.stateDir);
      return { handled: true, decision, enforced, source, ...extra };
    };
    const hits = staticHits(scope.kind, text, loaded.rules);
    if (hits.length) return finish('deny', 'static', { rule: hits[0].name, ...denyMessages(call.tool_name, { source: 'static', rule: hits[0] }) });
    if (!scope.jev) return finish('allow', 'scope');
    if (isSafeCall(scope.kind, text)) return finish('allow', 'safe');
    const task = options.task !== undefined ? options.task : readOwnerTask(call.transcript_path);
    const state = buildGateState(call, text, task);
    row.state_chars = JSON.stringify(state).length;
    const timeoutMs = Math.max(Number(env.OMC_JEV_TIMEOUT_MS) || 0, GATE_TIMEOUT_MS);
    // Only this point is resolved in the query: the env is narrowed to it, so `all` and other points play no part.
    const patch = { OMC_JEV: mode === 'active' ? `${GATE_POINT}:active` : GATE_POINT, OMC_JEV_TIMEOUT_MS: String(timeoutMs) };
    const send = options.query ?? ((q) => withEnv(patch, () => recordJevShadow(q)));
    const queryStarted = process.hrtime.bigint();
    const result = send({ point: GATE_POINT, state, questions: GATE_QUESTIONS, heuristic: false, permissionMode: call.permission_mode });
    row.jev_ms = ms(queryStarted);
    const answers = {};
    for (const name of [...GATE_AXES, 'zlecone']) answers[name] = jevNoulOf(result, name);
    if (!Object.values(answers).some((v) => v !== undefined)) {
      return finish('allow', result ? 'jev-degraded' : mode === 'shadow' ? 'shadow-sent' : 'jev-none', { jev: result?.mode ?? null });
    }
    const forced = Number(String(env.OMC_JEV_GATE_THRESHOLD ?? '').replace(',', '.'));
    const rules = forced > 0 && forced <= 1 ? { ...loaded.rules, threshold: forced } : loaded.rules; // OMC_JEV_GATE_THRESHOLD wins over the rules file
    const decided = decideWithAnswers(call, answers, detectRealSecret(text), rules);
    return finish(decided.decision, 'jev', { ...decided.extra, jev: result?.mode ?? null });
  } catch (error) {
    Object.assign(row, { decision: 'allow', enforced: false, source: 'error', error: String(error instanceof Error ? error.message : error).slice(0, 300), durationMs: ms(started) });
    logRow(row, env, options.stateDir);
    return { handled: true, decision: 'allow', enforced: false, source: 'error' };
  }
}

/** The hook output for a denial. */
export function gateHookOutput(result) {
  return {
    continue: true,
    systemMessage: result.systemMessage,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason },
  };
}
