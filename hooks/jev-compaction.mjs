/**
 * Jev compaction: a Claude Code hooks module ("mod") for the judgment point `compaction`.
 *
 * Opt-in by name only. `all` and `all:active` never enable this point: it runs only when OMC_JEV
 * names it (`compaction` for shadow, `compaction:active` for active) and TYPESAFE_API_KEY is set.
 * Without that every handler passes the event on unchanged and the module reads nothing but its
 * configuration: no request, no file, no output (mirror of NAMED_ONLY_POINTS in
 * scripts/jev-resolve.mjs and src/hooks/jev/config.ts).
 *
 * session.compact (auto, /compact, a plugin's request; main loop and subagents). The first message,
 * the last KEEP_LAST messages, every user message and every assistant text stay word for word. Other
 * tool results are kept whole, shortened to SHORT_CHARS characters, or removed together with their
 * call; a removed call stays as a one-line trace (tool, input up to TRACE_INPUT_CHARS, size of the
 * removed result), so the model knows what it already did. Jev scores how much each result will still
 * be needed (the `compaction` score question in src/hooks/jev/points.ts, BATCH results per request,
 * up to MAX_REQUESTS requests in parallel). Results are ranked by score and kept while they fit the
 * target budget (OMC_JEV_COMPACT_TARGET of the characters before). In shadow mode the decision is
 * computed and logged, and the built-in summary runs.
 *
 * Every assistant row before the last KEEP_LAST messages is rebuilt from its text, traces and kept
 * calls (its thinking and server blocks go, a row left empty is dropped), so the host writes it with
 * a new message.id and `--resume` cannot join it with its rows from before the compaction. The last
 * messages keep their handles; a server block among them (server_tool_use, advisor or web search
 * results, read from the API form of the conversation) runs the built-in summary instead.
 *
 * The built-in summary (next(e)) also runs when the conversation is too short or its tool results
 * are too small for the removal to matter, while requests are paused after an endpoint failure, when
 * OMC_JEV_MAX_REQUESTS is used up, and when Jev fails, answers too little or does not answer in time.
 *
 * turn.complete. With OMC_JEV_COMPACT_AT_PERCENT (off when unset) the module asks the host to compact
 * once the context reaches that share of the compaction window: main loop only, at most once per
 * MIN_TURNS_BETWEEN turns, never during a compaction, never while requests are paused, and only when
 * the removable tool results are worth it (a request that would end in the built-in summary is not
 * made).
 *
 * What goes to the endpoint: the /compact instructions and the last USER_MESSAGES user messages
 * (together USER_CHARS characters), and for each scored result its tool, its input (STATE_INPUT_CHARS)
 * and the result's first STATE_HEAD_CHARS and last STATE_TAIL_CHARS characters, all after secret
 * masking, with every string bounded by OMC_JEV_EXCERPT_CHARS_COMPACTION (default
 * DEFAULT_EXCERPT_CHARS). Results of calls on secret paths (and on OMC_JEV_COMPACT_PRIVATE_PATHS)
 * and results without text are never sent.
 *
 * Quiet: no $.ui.log; a toast only with OMC_JEV_COMPACT_TOAST=1. One JSON file per event goes to the
 * spool directory (<state dir>/compaction-spool, $.fs cannot append); the classic SessionStart hook
 * (scripts/lib/jev-compaction-state.mjs) moves those records to compaction.jsonl next to shadow.jsonl.
 *
 * A hooks module reaches files, the network and the environment only through `$`, may import only
 * plain files of its plugin, and its hooks must be functions declared at the top of the file (the host
 * checks this when it loads the module; `claude plugin validate` runs the same check). The masking is
 * shared (scripts/lib/jev-mask.mjs); the HTTP client, the OMC_JEV parse, boundExcerpts and the
 * question are mirrors, and src/__tests__/jev-compaction-module.test.mjs locks their parity.
 */

import { maskSecrets } from '../scripts/lib/jev-mask.mjs';

const POINT = 'compaction';
// The last messages stay whole: the work in flight.
const KEEP_LAST = 6;
// Cap on the host call for the API form of the conversation: a call that never settles must not hold
// the compaction.
const HOST_MS = 2000;
// Up to BATCH * MAX_REQUESTS = 240 results are scored per compaction. A 40-question request took
// 1.4-2.9 s against the production endpoint; the deadlines leave room for a slow answer and keep the
// whole decision under TOTAL_MS, after which the built-in summary runs instead.
const BATCH = 40;
const MAX_REQUESTS = 6;
const REQUEST_MS = 6000;
const TOTAL_MS = 8000;
// Default share of the characters kept (OMC_JEV_COMPACT_TARGET, 0.1-0.9).
const DEFAULT_TARGET = 0.5;
// When removing every tool result would cut less than this share, a module compaction would free too
// little room, so the built-in summary runs.
const MIN_REDUCTION = 0.3;
// The own threshold asks for a compaction only when the removable results are also worth this share
// of the compaction window (about four characters per token).
const OWN_MIN_GAIN = 0.1;
const CHARS_PER_TOKEN = 4;
const SHORT_CHARS = 300;
const TRACE_INPUT_CHARS = 200;
const STATE_INPUT_CHARS = 300;
const STATE_HEAD_CHARS = 1000;
const STATE_TAIL_CHARS = 500;
const USER_CHARS = 4000;
// Text is cut before masking so a huge result or message costs bounded time; the cut keeps this much more
// than the part that is used, so a secret that starts inside the used part is still seen whole.
const MASK_SLACK_CHARS = 20000;
const USER_MESSAGES = 3;
// Mirror of POINT_DEFAULT_EXCERPT_CHARS.compaction in src/hooks/jev/config.ts: the longest string the
// state holds (USER_CHARS), so the default bounds nothing the limits above do not already bound.
export const DEFAULT_EXCERPT_CHARS = 4000;
const MIN_TURNS_BETWEEN = 5;
const WINDOW_REFRESH_TURNS = 20;
const CONFIG_TTL_MS = 30000;
// A request batch counts when at least this share of its questions got a score; unanswered
// questions get UNANSWERED_SCORE ("may be useful" is 2/3).
const PARTIAL_OK = 0.5;
const UNANSWERED_SCORE = 0.4;
const PROBE_MAX_CHARS = 5_000_000;
// A file or URL named in the last user messages counts as needed when its name has at least this
// many characters (shorter names match too much text).
const MENTION_MIN = 5;
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
// Pause after a failed request, by status only (response bodies are never read): Retry-After when the
// response has it, else these defaults; three requests without a response within a minute pause too.
// Three failed compactions in a row stop the requests for the rest of the session, like the resolver's
// per-point breaker.
const PAUSE_DEFAULT_MS = 60_000;
const PAUSE_AUTH_MS = 600_000;
const PAUSE_MAX_MS = 1_800_000;
const NO_RESPONSE_TO_PAUSE = 3;
const NO_RESPONSE_WINDOW_MS = 60_000;
const FAILURES_TO_OPEN = 3;

// Mirror of the `compaction` score question in src/hooks/jev/points.ts (criteria low to high).
export const QUESTION_INSTRUCTIONS =
  "How much will the tool result described under this question's name in state.results still be needed for further work on the user's task (state.task)? " +
  'Judge whether further work will use it, not whether it was needed before.';
export const QUESTION_CRITERIA = [
  'Not needed: the work it served is finished, or the result is easy to reproduce (a file listing, repository status, a write confirmation, a result repeated later).',
  'Probably not needed: background from which further work needs at most a conclusion already written in the conversation.',
  'May be useful: details that further work may come back to.',
  'Needed: data that further work relies on and that is nowhere else in the conversation (file contents before an edit, numbers for later calculations, findings, an error to fix).',
];

// Blocks the host or a hook adds to a user message; they stay in the conversation but are not the
// user's words, so they are cut from the task sent to Jev.
const HOST_BLOCK = /<(system-reminder|task-notification|teammate-message|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)\b[^>]*>[\s\S]*?<\/\1>/g;
const HOST_BLOCK_OPEN = /^<(?:system-reminder|task-notification|teammate-message|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)\b/;
// Messages that start with one of these are not the user's words either: skill and interruption
// notices, the session summary, and the notices the Claude desktop app adds as entries of their own
// (side-session and CI-monitor events, scheduled tasks, messages from another session: the same
// desktop-app notices scripts/pre-tool-enforcer.mjs skips).
const NOT_USER_PREFIXES = [
  'Base directory for this skill:', 'Caveat:', '[Request interrupted', 'This session is being continued from a previous conversation',
  '<side-sessions-event>', '<ci-monitor-event>', '<scheduled-task', '<cross-session-message', 'Another Claude session sent a message:',
];

// Secret paths in the path and command fields of a call (a mention in a prompt or a result does not
// count): SSH keys, git and gh credentials, Claude Code credentials, AWS credentials, .netrc, .env and
// .envrc files (.env.example is not a secret).
const SECRET_PATH = /[\\/]\.ssh[\\/]+(?:id_[a-z0-9_]+|[^\s"'\\/]*_key)\b|\.git-credentials\b|[\\/]\.config[\\/]+gh[\\/]+hosts\.ya?ml\b|\.credentials\.json\b|[\\/]\.aws[\\/]+credentials\b|(?:^|[\s"'\\/=])\.netrc\b|(?:^|[\s"'\\/=;|&<>])\.env(?!\.example)(?:rc|\.[a-z0-9_-]+)?(?=$|[\s"';|&)<>])/i;
// Fields that name a path or run a command, in any tool (built-in or MCP).
const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'command'];
const TOOL_PATH_FIELDS = { Glob: ['pattern'], Grep: ['glob'] };

/** Mirror of parseJevEnv(POINT) in scripts/jev-resolve.mjs for a named-only point. */
export function pointMode(raw, key) {
  const value = String(raw ?? '').trim();
  if (!key || value === 'off') return 'off';
  let listed = false;
  let active = false;
  let off = false;
  for (const entry of value.split(',')) {
    const token = entry.trim();
    if (!token) continue;
    const colon = token.lastIndexOf(':');
    const name = colon === -1 ? token : token.slice(0, colon);
    if (name !== POINT) continue;
    if (colon !== -1 && token.slice(colon + 1).trim().toLowerCase() === 'off') {
      off = true;
      active = false;
      continue;
    }
    off = false;
    listed = true;
    if (colon !== -1 && token.slice(colon + 1) === 'active') active = true;
  }
  if (off || !listed) return 'off';
  return active ? 'active' : 'shadow';
}

/** Mirror of boundExcerpts in src/hooks/jev/config.ts. */
export function boundExcerpts(value, max) {
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) : value;
  if (Array.isArray(value)) return value.map((item) => boundExcerpts(item, max));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = boundExcerpts(v, max);
    return out;
  }
  return value;
}

/** Retry-After in milliseconds (delay seconds, a decimal value rounded up to whole seconds, or an HTTP date), else undefined. */
export function retryAfterMs(value, now = Date.now()) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.ceil(Number(text)) * 1000;
  // The three HTTP-date forms (IMF-fixdate, RFC 850, asctime); any other text is not a Retry-After.
  const httpDate =
    /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text) ||
    /^[A-Za-z]{6,9}, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT$/.test(text) ||
    /^[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/.test(text);
  if (!httpDate) return undefined;
  const at = Date.parse(/GMT$/.test(text) ? text : `${text} GMT`);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** A failed request: {kind, pauseMs?, noResponse?}. Status codes only; bodies are never read. */
export function classifyFailure(result, now = Date.now()) {
  if (result.timeout) return { kind: 'timeout', noResponse: true };
  if (result.error?.invalid) return { kind: 'invalid_response' };
  const status = result.error && Number.isInteger(result.error.status) ? result.error.status : undefined;
  if (status === undefined) return { kind: 'no_response', noResponse: true };
  const header = retryAfterMs(result.error.retryAfter, now);
  const capped = (ms) => Math.min(Math.max(ms, 1000), PAUSE_MAX_MS);
  if (status === 429 || status >= 500) return { kind: `http_${status}`, pauseMs: capped(header ?? PAUSE_DEFAULT_MS) };
  if (status === 401 || status === 402 || status === 403) return { kind: `http_${status}`, pauseMs: capped(header ?? PAUSE_AUTH_MS) };
  return { kind: `http_${status}` };
}

// First `head` and last `tail` characters of the masked text. A long text is masked only where those parts
// come from (with MASK_SLACK_CHARS more on each side); the omitted count is of the original.
function maskedHeadTail(text, head, tail) {
  if (text.length <= head + tail + 2 * MASK_SLACK_CHARS) return headTail(maskSecrets(text), head, tail);
  const first = maskSecrets(text.slice(0, head + MASK_SLACK_CHARS)).slice(0, head);
  const last = maskSecrets(text.slice(-(tail + MASK_SLACK_CHARS))).slice(-tail);
  return `${first}\n[... ${text.length - head - tail} chars omitted ...]\n${last}`;
}
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const clip = (text, max) => (text.length > max ? text.slice(0, max) : text);
const headTail = (text, head, tail) =>
  text.length <= head + tail ? text : `${text.slice(0, head)}\n[... ${text.length - head - tail} chars omitted ...]\n${text.slice(-tail)}`;
const randomId = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
const isoNow = () => new Date().toISOString();
const slash = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const safeName = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function inputJson(input) {
  try { return JSON.stringify(input ?? {}); } catch { return ''; }
}

const fraction = (raw, fallback, min, max) => {
  const text = String(raw ?? '').trim();
  const n = Number(text);
  return text !== '' && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};
// Mirror of positiveInt in scripts/jev-resolve.mjs.
function positiveInt(raw, fallback) {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

// Session state. A Claude Code process loads the module once per session and calls register once.
function freshState() {
  return {
    compacting: 0, pausedUntil: 0, pauseReason: null, failedInRow: 0, noResponseAt: [], requests: 0,
    turnCount: 0, lastAttempt: -Infinity, hostCannot: false, compactWindow: undefined, windowTurn: -Infinity,
    cachedConfig: undefined, cachedAt: -Infinity,
  };
}
let session = freshState();

// Configuration from the process environment, with the settings' env as a fallback for a host that did
// not put it into its environment. $.env.get takes literal names only. Without a state directory
// nothing is written.
async function readConfig($) {
  const env = {
    OMC_JEV: await $.env.get('OMC_JEV'),
    TYPESAFE_API_KEY: await $.env.get('TYPESAFE_API_KEY'),
    OMC_JEV_ENDPOINT: await $.env.get('OMC_JEV_ENDPOINT'),
    OMC_JEV_LOG_DIR: await $.env.get('OMC_JEV_LOG_DIR'),
    OMC_JEV_MAX_REQUESTS: await $.env.get('OMC_JEV_MAX_REQUESTS'),
    OMC_JEV_EXCERPT_CHARS_COMPACTION: await $.env.get('OMC_JEV_EXCERPT_CHARS_COMPACTION'),
    OMC_JEV_COMPACT_AT_PERCENT: await $.env.get('OMC_JEV_COMPACT_AT_PERCENT'),
    OMC_JEV_COMPACT_TARGET: await $.env.get('OMC_JEV_COMPACT_TARGET'),
    OMC_JEV_COMPACT_TOAST: await $.env.get('OMC_JEV_COMPACT_TOAST'),
    OMC_JEV_COMPACT_PRIVATE_PATHS: await $.env.get('OMC_JEV_COMPACT_PRIVATE_PATHS'),
    USERPROFILE: await $.env.get('USERPROFILE'),
    HOME: await $.env.get('HOME'),
  };
  if (env.OMC_JEV === undefined || env.TYPESAFE_API_KEY === undefined) {
    try {
      const fromSettings = await $.settings.read({ key: 'env' });
      if (fromSettings && typeof fromSettings === 'object') {
        for (const name of Object.keys(env)) if (env[name] === undefined && typeof fromSettings[name] === 'string') env[name] = fromSettings[name];
      }
    } catch { /* no settings: the process environment stands */ }
  }
  const home = env.USERPROFILE || env.HOME;
  const stateDir = env.OMC_JEV_LOG_DIR ? slash(env.OMC_JEV_LOG_DIR) : home ? `${slash(home)}/.omc/state/jev` : undefined;
  const privatePaths = String(env.OMC_JEV_COMPACT_PRIVATE_PATHS ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    // A leading ~ matches both as written (in a command) and expanded to the home directory.
    .flatMap((p) => (home && /^~(?=$|[\\/])/.test(p) ? [p, slash(home) + p.slice(1)] : [p]))
    .map((p) => slash(p).toLowerCase());
  return {
    mode: pointMode(env.OMC_JEV, env.TYPESAFE_API_KEY),
    key: env.TYPESAFE_API_KEY,
    endpoint: env.OMC_JEV_ENDPOINT || DEFAULT_ENDPOINT,
    spoolDir: stateDir ? `${stateDir}/compaction-spool` : undefined,
    maxRequests: positiveInt(env.OMC_JEV_MAX_REQUESTS, 0),
    excerptChars: positiveInt(env.OMC_JEV_EXCERPT_CHARS_COMPACTION, DEFAULT_EXCERPT_CHARS),
    atPercent: fraction(env.OMC_JEV_COMPACT_AT_PERCENT, undefined, 1, 99),
    target: fraction(env.OMC_JEV_COMPACT_TARGET, DEFAULT_TARGET, 0.1, 0.9),
    toast: String(env.OMC_JEV_COMPACT_TOAST ?? '').trim() === '1',
    privatePaths,
  };
}

// No request goes out: paused after a failure, breaker open, or OMC_JEV_MAX_REQUESTS used up.
function blockedReason(cfg, now) {
  if (session.failedInRow >= FAILURES_TO_OPEN) return 'circuit_open';
  if (now < session.pausedUntil) return 'paused';
  if (cfg.maxRequests && session.requests >= cfg.maxRequests) return 'cap';
  return undefined;
}

// The input of a call in a few words: the field that says what the call did, else its JSON. It stays
// in the conversation only (the call was there already); what goes to Jev is masked separately.
function inputSummary(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  const pick = (...keys) => keys.map((k) => (typeof i[k] === 'string' ? i[k] : undefined)).filter(Boolean).join(' ');
  let text = '';
  if (tool === 'Bash' || tool === 'PowerShell' || tool === 'Monitor') text = pick('command');
  else if (tool === 'Read' || tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') text = pick('file_path', 'notebook_path');
  else if (tool === 'Grep') text = pick('pattern', 'path', 'glob');
  else if (tool === 'Glob') text = pick('pattern', 'path');
  else if (tool === 'WebFetch') text = pick('url');
  else if (tool === 'WebSearch') text = pick('query');
  else if (tool === 'Agent' || tool === 'Task') text = pick('subagent_type', 'description');
  if (!text) text = inputJson(i);
  return oneLine(text);
}

function touchesSecretPath(tool, input, privatePaths) {
  if (!input || typeof input !== 'object') return false;
  const values = [];
  for (const f of [...PATH_FIELDS, ...(TOOL_PATH_FIELDS[tool] || [])]) if (typeof input[f] === 'string') values.push(input[f]);
  if (Array.isArray(input.paths)) for (const p of input.paths) if (typeof p === 'string') values.push(p);
  if (typeof input.url === 'string' && /^file:/i.test(input.url)) values.push(input.url);
  return values.some((v) => {
    if (SECRET_PATH.test(v)) return true;
    const value = slash(v).toLowerCase();
    return privatePaths.some((p) => value.includes(p));
  });
}

// A result the host can rebuild from its text alone: anything but an image or another binary record.
const textOnlyMemo = new WeakMap();
function textOnlyResult(r) {
  if (r && typeof r === 'object' && textOnlyMemo.has(r)) return textOnlyMemo.get(r);
  const v = textOnlyProbe(r);
  try { textOnlyMemo.set(r, v); } catch { /* not an object */ }
  return v;
}
function textOnlyProbe(r) {
  if (r.result === undefined || r.result === null || typeof r.result !== 'object') return true;
  let probe;
  try { probe = JSON.stringify(r.result); } catch { return false; }
  if (probe.length > PROBE_MAX_CHARS) return false;
  return !/"type"\s*:\s*"(?:image|document|file)"|"base64"|"media_type"/.test(probe);
}

function messageChars(m) {
  let n = (m.text || '').length;
  for (const u of m.toolUses || []) n += (u.tool || '').length + inputJson(u.input).length;
  for (const r of m.toolResults || []) n += (r.text || '').length;
  return n;
}

// The user's own words in a message: '' for tool results, host notices and summaries; host blocks
// inside a message are cut out.
function userWords(m) {
  if (m.role !== 'user' || (m.toolResults && m.toolResults.length) || !m.text) return '';
  const text = m.text.replace(HOST_BLOCK, '').trim();
  if (!text || HOST_BLOCK_OPEN.test(text) || NOT_USER_PREFIXES.some((p) => text.startsWith(p))) return '';
  return text;
}

// The task for the state: the /compact instructions first, then the last USER_MESSAGES user
// messages, together USER_CHARS characters.
function userTask(messages, instructions) {
  let left = USER_CHARS;
  const instr = instructions ? clip(maskSecrets(String(instructions).slice(0, left + MASK_SLACK_CHARS)), left) : undefined;
  if (instr) left -= instr.length;
  const picked = [];
  for (let i = messages.length - 1; i >= 0 && picked.length < USER_MESSAGES && left > 0; i--) {
    const words = userWords(messages[i]);
    if (!words) continue;
    const text = clip(maskSecrets(words.slice(0, left + MASK_SLACK_CHARS)), left);
    picked.unshift(text);
    left -= text.length;
  }
  return { task: picked, instructions: instr };
}

// Results the user names: a file (by its name) or a URL the call opened that one of the last user
// messages or the /compact instructions mention as a whole word. Jev sees only the start and the end
// of a long result, so a result the user said would be needed later could lose the part they meant.
// Such a result counts as needed (score 1) and comes first for the budget; it is still cut or traced
// when even it does not fit.
function targetsOf(input) {
  const i = input && typeof input === 'object' ? input : {};
  const out = new Set();
  for (const k of ['file_path', 'notebook_path', 'path', 'url']) if (typeof i[k] === 'string') out.add(i[k]);
  if (typeof i.command === 'string') for (const m of i.command.matchAll(/[^\s"'`|;&<>()]+\.[A-Za-z0-9]{1,6}\b|https?:\/\/[^\s"'`]+/g)) out.add(m[0]);
  const names = new Set();
  for (const t of out) {
    if (/^https?:/i.test(t)) names.add(t.toLowerCase());
    const base = t.replace(/[\\/]+$/, '').split(/[\\/]/).pop().toLowerCase();
    if (base.length >= MENTION_MIN) names.add(base);
  }
  return names;
}
function mentions(text, name) {
  return new RegExp(`(?:^|[\\s"'\`(<\\[/\\\\=:])${escapeRegExp(name)}(?=$|[\\s"'\`)>\\],.;:!?])`).test(text);
}
function markMentioned(candidates, user) {
  const text = [user.instructions || '', ...user.task].join('\n').toLowerCase();
  let n = 0;
  for (const c of candidates) {
    if (c.secret || !c.textOnly) continue;
    for (const name of targetsOf(c.use.input)) {
      if (mentions(text, name)) { c.score = Math.max(c.score, 1); c.asked = true; n++; break; }
    }
  }
  return n;
}

function traceLine(c) {
  const what = !c.textOnly ? 'non-text result (image or file) removed' : `${c.res.isError ? 'error' : 'result'} of ${c.resultChars} chars removed`;
  return `[compacted] ${c.use.tool}(${clip(c.summary, TRACE_INPUT_CHARS)}) - ${what}`;
}

function shortText(c) {
  return `${c.res.text.slice(0, SHORT_CHARS)}\n[result shortened at compaction: kept ${SHORT_CHARS} of ${c.resultChars} chars]`;
}

// The task list stays: every TaskCreate and TaskUpdate call, the newest TodoWrite call and the newest
// call of a plan tool (`update_plan`, as in the Claude desktop app) that carries the whole list
// (`todos`, `items`), and every later call of that tool (a plan tool also takes incremental calls).
const TASK_STEP = /^(?:TaskCreate|TaskUpdate)$/;
const TASK_LIST = /^TodoWrite$|(?:^|__)update_plan$/;

// Candidates: tool results outside the first message and the last KEEP_LAST messages whose call is
// in an earlier assistant message.
function findCandidates(messages, privatePaths) {
  const uses = new Map();
  messages.forEach((m, i) => { if (m.role === 'assistant') for (const u of m.toolUses || []) uses.set(u.tool_use_id, { i, u }); });
  const tailStart = Math.max(1, messages.length - KEEP_LAST);
  const out = [];
  for (let i = 1; i < tailStart; i++) {
    const m = messages[i];
    if (m.role !== 'user' || !m.toolResults || !m.toolResults.length) continue;
    for (const r of m.toolResults) {
      const found = uses.get(r.tool_use_id);
      if (!found || found.i >= i) continue;
      const c = {
        id: r.tool_use_id, resIdx: i, use: found.u, res: r,
        summary: inputSummary(found.u.tool, found.u.input),
        inputChars: (found.u.tool || '').length + inputJson(found.u.input).length,
        resultChars: (r.text || '').length,
        secret: touchesSecretPath(found.u.tool, found.u.input, privatePaths),
        textOnly: textOnlyResult(r),
        score: 0, asked: false, answered: false,
      };
      c.trace = traceLine(c);
      c.fullCost = c.inputChars + c.resultChars;
      c.traceCost = c.trace.length + 1; // the newline that joins it to the assistant text
      c.shortCost = c.resultChars > SHORT_CHARS ? c.inputChars + shortText(c).length : c.fullCost;
      c.task = TASK_STEP.test(c.use.tool || '');
      out.push(c);
    }
  }
  const carriesList = (c) => Array.isArray(c.use.input?.todos) || Array.isArray(c.use.input?.items);
  const newestList = new Map();
  for (const c of out) {
    if (TASK_LIST.test(c.use.tool || '') && carriesList(c) && (!newestList.has(c.use.tool) || newestList.get(c.use.tool).resIdx < c.resIdx)) newestList.set(c.use.tool, c);
  }
  for (const c of out) {
    const list = newestList.get(c.use.tool);
    if (list && c.resIdx >= list.resIdx && TASK_LIST.test(c.use.tool || '')) c.task = true;
  }
  return out;
}

const removableChars = (candidates) => candidates.reduce((s, c) => s + Math.max(0, c.fullCost - c.traceCost), 0);

// Rank and fill the budget: highest score first while the upgrade from a trace fits; a result that
// does not fit whole and scores at least "may be useful" is cut to SHORT_CHARS when that fits; the rest
// is traced. A result not asked about (secret path, no text, beyond the questions) is traced; a call
// not longer than its trace and the task list stay whole.
function allocate(candidates, before, target) {
  const fixed = before - candidates.reduce((s, c) => s + c.fullCost - c.traceCost, 0);
  let avail = Math.floor(before * target) - fixed;
  const ranked = [...candidates].sort((a, b) => b.score - a.score || b.resIdx - a.resIdx);
  for (const c of ranked) {
    const upFull = c.fullCost - c.traceCost;
    const upShort = c.shortCost - c.traceCost;
    if (c.secret || !c.textOnly) c.keep = 'trace';
    else if (upFull <= 0 || c.task) c.keep = 'full';
    else if (!c.asked) c.keep = 'trace';
    else if (upFull <= avail) { c.keep = 'full'; avail -= upFull; }
    else if (c.score >= 0.5 && c.shortCost < c.fullCost && upShort <= avail) { c.keep = 'short'; avail -= Math.max(0, upShort); }
    else c.keep = 'trace';
  }
}

// On `--resume` the host joins the assistant rows of one message.id from the whole transcript, rows
// from before the compact boundary included, and repeats every block of them but tool_use (measured
// on Claude Code 2.1.321: a repeated server_tool_use fails the request with API 400 "ids must be
// unique", and a call that became a trace comes back without its result). A row kept by its handle is
// written after the boundary with its message.id, one built without a handle gets a new one; so no
// assistant row before the tail keeps its handle. The tail keeps its handles, and the rows of one API
// message do not straddle its start: it starts at the first row of the run of assistant rows it opens
// in (the rows of a message are consecutive assistant rows unless a result streams in between).
function keepFromOf(messages, tailStart) {
  let k = tailStart;
  while (k > 0 && k < messages.length && messages[k].role === 'assistant' && messages[k - 1].role === 'assistant') k--;
  return k;
}

// A block the API runs itself: server_tool_use, mcp_tool_use and their results
// (advisor_tool_result, web_search_tool_result, ...).
const isServerBlock = (b) => Boolean(b) && typeof b.type === 'string' && b.type !== 'tool_use' && b.type !== 'tool_result' && /_tool_(?:use|result)$/.test(b.type);

// Assistant API messages with a server block, and whether one may stand in the tail: its row is found
// by a tool use, else by a text block equal to a row's text (any such row in the tail counts); a
// message found nowhere counts as in the tail. Without the API form (refused, late, empty, or a list
// without `content` blocks, as from a host that ignores `as: 'api'`) a tail assistant row with neither
// text nor calls (thinking or a server block, which `messages` does not tell apart) counts as one.
function serverBlocks(messages, api, keepFrom) {
  const tailEmpty = () => messages.some((m, i) => i >= keepFrom && m.role === 'assistant' && !m.text && !(m.toolUses || []).length);
  if (!Array.isArray(api) || !api.some((a) => a && Array.isArray(a.content))) return { count: null, inTail: tailEmpty() };
  const rowOfUse = new Map();
  const rowsOfText = new Map();
  messages.forEach((m, i) => {
    if (m.role !== 'assistant') return;
    for (const u of m.toolUses || []) if (!rowOfUse.has(u.tool_use_id)) rowOfUse.set(u.tool_use_id, i);
    if (m.text) { if (!rowsOfText.has(m.text)) rowsOfText.set(m.text, []); rowsOfText.get(m.text).push(i); }
  });
  let count = 0;
  let inTail = false;
  for (const a of api) {
    if (!a || a.role !== 'assistant' || !Array.isArray(a.content) || !a.content.some(isServerBlock)) continue;
    count++;
    const rows = [];
    for (const b of a.content) {
      if (b && b.type === 'tool_use' && rowOfUse.has(b.id)) rows.push(rowOfUse.get(b.id));
      else if (b && b.type === 'text' && typeof b.text === 'string') rows.push(...(rowsOfText.get(b.text) || []));
    }
    if (!rows.length || rows.some((r) => r >= keepFrom)) inTail = true;
  }
  return { count, inTail };
}

// A user message with tool results kept by its engine handle is written after the compact boundary
// with its original parent, which points before the boundary, so `--resume` (and every `-p` turn)
// rebuilt the conversation from before the compaction (measured on Claude Code 2.1.318). Such a
// message is therefore rebuilt from its own text, unchanged for the model, whenever all its results
// are text. A message with an image or another non-text result in the last KEEP_LAST messages keeps
// its handle (counted in kept_handle) and has that limit. Every assistant row before `keepFrom` is
// rebuilt (text, traces and kept calls; thinking and server blocks dropped, an empty row removed), so
// none keeps its handle and the host gives it a new message.id (keepFromOf).
function build(messages, candidates, keepFrom, stats) {
  const byId = new Map();
  for (const c of candidates) byId.set(c.id, c);
  const out = [];
  stats.rebuiltUnchanged = 0;
  stats.keptHandle = 0;
  stats.rebuiltAssistant = 0;
  stats.droppedAssistant = 0;
  for (const [i, m] of messages.entries()) {
    if (m.role === 'assistant' && (i < keepFrom || (m.toolUses || []).some((u) => byId.get(u.tool_use_id)?.keep === 'trace'))) {
      stats.rebuiltAssistant++;
      const traces = [];
      const kept = [];
      for (const u of m.toolUses || []) {
        const c = byId.get(u.tool_use_id);
        if (c && c.keep === 'trace') traces.push(c.trace);
        else kept.push({ tool_use_id: u.tool_use_id, tool: u.tool, input: u.input });
      }
      const text = [m.text || '', ...traces].filter(Boolean).join('\n');
      if (!text && !kept.length) { stats.droppedAssistant++; continue; }
      out.push({ role: 'assistant', text, toolUses: kept });
      continue;
    }
    if (m.role === 'user' && (m.toolResults || []).length) {
      const changed = m.toolResults.some((r) => byId.has(r.tool_use_id) && byId.get(r.tool_use_id).keep !== 'full');
      if (!changed && !m.toolResults.every(textOnlyResult)) { stats.keptHandle++; out.push(m); continue; }
      const results = [];
      for (const r of m.toolResults) {
        const c = byId.get(r.tool_use_id);
        if (c && c.keep === 'trace') continue;
        if (c && c.keep === 'short') results.push({ tool_use_id: r.tool_use_id, text: shortText(c), isError: Boolean(r.isError) });
        else if (textOnlyResult(r)) results.push({ tool_use_id: r.tool_use_id, text: r.text || '', isError: Boolean(r.isError) });
        else results.push({ tool_use_id: r.tool_use_id, text: '[non-text result (image or file) removed at compaction]', isError: Boolean(r.isError) });
      }
      if (!changed) stats.rebuiltUnchanged++;
      if (!results.length && !m.text) continue;
      out.push({ role: 'user', text: m.text || '', toolUses: [], toolResults: results });
      continue;
    }
    out.push(m);
  }
  return out;
}

// The built list may not add results without a call or calls without a result to what the host gave.
// Calls and results of one id are always kept or removed together, so this guards against message
// shapes not foreseen here: an API request with an orphaned tool result would fail.
function pairing(messages) {
  const open = new Set();
  const seen = new Set();
  let orphanResults = 0;
  for (const m of messages) {
    for (const u of m.toolUses || []) { open.add(u.tool_use_id); seen.add(u.tool_use_id); }
    for (const r of m.toolResults || []) {
      if (!seen.has(r.tool_use_id)) orphanResults++;
      open.delete(r.tool_use_id);
    }
  }
  return { orphanResults, openCalls: open.size };
}
// Pairing as the host checks it before a request (measured on Claude Code 2.1.321). The host joins
// consecutive user rows, and joins an assistant row to an earlier assistant message of the same
// message.id while only result-only user rows stand between them; then every call of assistant
// message k needs its result in message k + 1, else the host puts "[Tool result missing due to
// internal error]" in its place and drops the real result. A row a hook built gets a new message.id,
// so it joins nothing; a run of rows with the engine's handle is taken as one message (a built
// assistant row or a user row with text ends the run). Counts calls without a result in the next
// message and results without a call in the previous one. The host keeps joining a handle row to its
// message across a built row; this model does not, which is exact for what build() returns: every
// assistant row before the tail is built and every one in it keeps its handle, so no built assistant
// row stands after a kept one.
function adjacencyBreaks(messages) {
  const msgs = [];
  let run = -1;
  for (const m of messages) {
    if (m.role === 'assistant') {
      const uses = (m.toolUses || []).map((u) => u.tool_use_id);
      if (m.handle && run >= 0) { msgs[run].uses.push(...uses); continue; }
      msgs.push({ role: 'assistant', uses });
      run = m.handle ? msgs.length - 1 : -1;
      continue;
    }
    const results = (m.toolResults || []).map((r) => r.tool_use_id);
    if (m.text || !results.length) run = -1;
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'user') last.results.push(...results);
    else msgs.push({ role: 'user', results });
  }
  let breaks = 0;
  const seen = new Set();
  msgs.forEach((mm, k) => {
    if (mm.role !== 'assistant') return;
    const uses = mm.uses.filter((id) => !seen.has(id));
    for (const id of uses) seen.add(id);
    const next = msgs[k + 1];
    if (!next) return;
    const got = new Set(next.role === 'user' ? next.results : []);
    for (const id of uses) if (!got.has(id)) breaks++;
    for (const id of got) if (!mm.uses.includes(id)) breaks++;
  });
  return breaks;
}
export function pairingOk(original, built) {
  const a = pairing(original);
  const b = pairing(built);
  return b.orphanResults <= a.orphanResults && b.openCalls <= a.openCalls && adjacencyBreaks(built) <= adjacencyBreaks(original);
}

// Resolves {value}, {timeout: true} or {error}; never rejects. $.clock.after is a timer, not the
// hook's own time (only $.clock.sleep would be), and $.http.fetch time does not count either.
function withDeadline($, promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    try {
      timer = $.clock.after(ms, () => { if (!settled) { settled = true; resolve({ timeout: true }); } });
    } catch { /* no timer: the request alone decides */ }
    promise.then(
      (value) => { if (!settled) { settled = true; try { timer?.cancel(); } catch { /* gone */ } resolve({ value }); } },
      (error) => { if (!settled) { settled = true; try { timer?.cancel(); } catch { /* gone */ } resolve({ error }); } },
    );
  });
}

async function askJev($, cfg, state, questions) {
  const response = await $.http.fetch(cfg.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
  });
  if (!response.ok) {
    const failure = new Error(`HTTP ${response.status}`);
    failure.status = response.status;
    failure.retryAfter = response.headers?.['retry-after'];
    throw failure;
  }
  let body;
  try { body = JSON.parse(response.text); } catch { body = undefined; }
  if (!body || typeof body.answers !== 'object' || body.answers === null || Array.isArray(body.answers)) {
    const invalid = new Error('invalid response: no answers');
    invalid.invalid = true;
    throw invalid;
  }
  return body.answers;
}

// Score 0-1 from an answer on the four levels (0-3), else undefined.
function scoreOf(answer) {
  const s = answer && typeof answer === 'object' ? answer.score : undefined;
  return typeof s === 'number' && Number.isFinite(s) && s >= 0 && s <= QUESTION_CRITERIA.length - 1 ? s / (QUESTION_CRITERIA.length - 1) : undefined;
}

async function writeRecord($, cfg, record) {
  if (!cfg.spoolDir) return;
  try {
    await $.fs.write(`${cfg.spoolDir}/${safeName(record.session_id ?? 'unknown')}--${Date.now()}-${randomId()}.json`, JSON.stringify(record));
  } catch { /* the log never breaks a compaction */ }
}

function noteFailures(failures, now) {
  for (const f of failures) {
    if (f.pauseMs && now + f.pauseMs > session.pausedUntil) { session.pausedUntil = now + f.pauseMs; session.pauseReason = f.kind; }
    if (f.noResponse) session.noResponseAt.push(now);
  }
  session.noResponseAt = session.noResponseAt.filter((t) => now - t < NO_RESPONSE_WINDOW_MS);
  if (session.noResponseAt.length >= NO_RESPONSE_TO_PAUSE && now + PAUSE_DEFAULT_MS > session.pausedUntil) {
    session.pausedUntil = now + PAUSE_DEFAULT_MS;
    session.pauseReason = 'no_response';
    session.noResponseAt = [];
  }
}

// Decides one compaction: {messages} to install or {fallback: reason}. Fills `record`; never calls next.
async function decide($, e, cfg, record, started) {
  const messages = Array.isArray(e.messages) ? e.messages : [];
  const before = messages.reduce((s, m) => s + messageChars(m), 0);
  record.chars_before = before;
  if (messages.length <= KEEP_LAST + 1) return { fallback: 'too_few_messages' };
  const keepFrom = keepFromOf(messages, Math.max(1, messages.length - KEEP_LAST));
  const asApi = e.agentId === undefined ? { as: 'api' } : { as: 'api', agentId: e.agentId };
  const api = await withDeadline($, Promise.resolve().then(() => $.session.messages(asApi)), HOST_MS);
  const server = serverBlocks(messages, api.value, keepFrom);
  record.server_blocks = server.count;
  if (server.inTail) return { fallback: 'server_block_in_tail' };
  const candidates = findCandidates(messages, cfg.privatePaths);
  record.candidates = candidates.length;
  const removable = removableChars(candidates);
  record.max_reduction = before ? Math.round((removable / before) * 1000) / 1000 : 0;
  if (!before || removable / before < MIN_REDUCTION) return { fallback: 'too_few_results' };
  const blocked = blockedReason(cfg, Date.now());
  if (blocked) {
    if (blocked === 'paused') Object.assign(record, { paused_until: new Date(session.pausedUntil).toISOString(), pause_reason: session.pauseReason });
    return { fallback: blocked };
  }

  // Newest results first; only text results of calls outside secret paths are asked about.
  const askable = [...candidates].sort((a, b) => b.resIdx - a.resIdx).filter((c) => !c.secret && c.textOnly);
  record.secret_skipped = candidates.filter((c) => c.secret).length;
  record.non_text = candidates.filter((c) => !c.textOnly).length;
  const left = cfg.maxRequests ? cfg.maxRequests - session.requests : MAX_REQUESTS;
  const asked = askable.slice(0, BATCH * Math.min(MAX_REQUESTS, left));
  record.asked = asked.length;

  const user = userTask(messages, typeof e.instructions === 'string' && e.instructions.trim() ? e.instructions : undefined);
  const deadline = started + TOTAL_MS;
  const runs = [];
  for (let b = 0; b * BATCH < asked.length; b++) {
    const batch = asked.slice(b * BATCH, (b + 1) * BATCH);
    const results = {};
    const questions = {};
    batch.forEach((c, k) => {
      c.question = `r${k + 1}`;
      results[c.question] = {
        tool: c.use.tool,
        input: clip(oneLine(maskSecrets(inputJson(c.use.input).slice(0, STATE_INPUT_CHARS * 4 + MASK_SLACK_CHARS))), STATE_INPUT_CHARS),
        result: maskedHeadTail(c.res.text || '', STATE_HEAD_CHARS, STATE_TAIL_CHARS),
        chars: c.resultChars,
        ...(c.res.isError ? { error: true } : {}),
      };
      questions[c.question] = { type: 'score', instructions: QUESTION_INSTRUCTIONS, criteria: QUESTION_CRITERIA };
    });
    const state = boundExcerpts({ task: user.task, ...(user.instructions ? { compact_instructions: user.instructions } : {}), results }, cfg.excerptChars);
    const t0 = Date.now();
    session.requests++;
    runs.push(withDeadline($, askJev($, cfg, state, questions), Math.max(500, Math.min(REQUEST_MS, deadline - t0))).then((r) => ({ ...r, batch, ms: Date.now() - t0 })));
  }
  record.requests = runs.length;
  const results = await Promise.all(runs);
  record.jev_ms = results.map((r) => r.ms);
  let answered = 0;
  const failures = [];
  for (const r of results) {
    for (const c of r.batch) {
      c.asked = true;
      const s = r.value ? scoreOf(r.value[c.question]) : undefined;
      if (s === undefined) c.score = UNANSWERED_SCORE;
      else { c.score = s; c.answered = true; answered++; }
    }
    if (!r.value) failures.push(classifyFailure(r));
  }
  record.requests_ok = results.filter((r) => r.value).length;
  record.answered = answered;
  if (failures.length) {
    record.failure = failures.map((f) => f.kind).join(',');
    noteFailures(failures, Date.now());
    if (!asked.length || answered / asked.length < PARTIAL_OK) {
      session.failedInRow++;
      return { fallback: failures.every((f) => f.kind === 'timeout') ? 'timeout' : 'jev_error' };
    }
  }
  session.failedInRow = 0;

  record.mentioned = markMentioned(candidates, user);
  allocate(candidates, before, cfg.target);
  const stats = {};
  const built = build(messages, candidates, keepFrom, stats);
  if (!pairingOk(messages, built)) return { fallback: 'build_error' };
  const after = built.reduce((s, m) => s + messageChars(m), 0);
  const hist = [0, 0, 0, 0];
  for (const c of asked) if (c.answered) hist[Math.min(3, Math.round(c.score * 3))]++;
  Object.assign(record, {
    messages_after: built.length,
    chars_after: after,
    reduction: before ? Math.round((1 - after / before) * 1000) / 1000 : 0,
    kept_full: candidates.filter((c) => c.keep === 'full').length,
    kept_short: candidates.filter((c) => c.keep === 'short').length,
    traced: candidates.filter((c) => c.keep === 'trace').length,
    rebuilt_unchanged: stats.rebuiltUnchanged,
    kept_handle: stats.keptHandle,
    rebuilt_assistant: stats.rebuiltAssistant,
    dropped_assistant: stats.droppedAssistant,
    score_hist: hist,
    unanswered: asked.length - answered,
  });
  return { messages: built, before, after };
}

async function compact($, e, next) {
  let cfg;
  try { cfg = await readConfig($); } catch { return next(e); }
  if (cfg.mode === 'off') return next(e);
  // An active point replaces the summary, so a summary computed ahead of time would be wasted; while
  // the breaker is open the summary will run, so the host may compute it ahead.
  if (e.trigger === 'precompute') return cfg.mode === 'active' && !blockedReason(cfg, Date.now()) ? { skip: 'jev-compaction replaces the summary' } : next(e);
  const started = Date.now();
  session.compacting++;
  try {
    let sessionId;
    try { sessionId = await $.session.id(); } catch { sessionId = undefined; }
    const record = {
      ts: isoNow(), point: POINT, event: 'compact', session_id: sessionId ?? null, agent_id: e.agentId ?? null,
      trigger: e.trigger, mode: cfg.mode, messages_before: Array.isArray(e.messages) ? e.messages.length : 0,
      chars_before: 0, target: cfg.target,
    };
    let decision;
    try {
      decision = await decide($, e, cfg, record, started);
    } catch (error) {
      decision = { fallback: 'exception' };
      record.error = clip(oneLine(maskSecrets(String(error?.message ?? error))), 200);
    }
    record.duration_ms = Date.now() - started;
    if (decision.fallback) Object.assign(record, { result: 'fallback', reason: decision.fallback });
    else record.result = cfg.mode === 'active' ? 'jev' : 'shadow';
    // Written before next(e): the classic SessionStart:compact hook can run while the built-in summary
    // is still being installed.
    await writeRecord($, cfg, record);
    if (decision.fallback || cfg.mode !== 'active') return await next(e);
    if (cfg.toast) { try { $.ui.toast(`Jev compaction: ${decision.before} -> ${decision.after} chars`); } catch { /* optional */ } }
    return { messages: decision.messages };
  } finally {
    session.compacting--;
  }
}

async function ownThreshold($, e, next) {
  const result = await next(e);
  try {
    if (e.agentId !== undefined || session.compacting > 0 || session.hostCannot) return result;
    session.turnCount++;
    if (session.turnCount - session.lastAttempt < MIN_TURNS_BETWEEN) return result;
    if (!session.cachedConfig || Date.now() - session.cachedAt > CONFIG_TTL_MS) { session.cachedConfig = await readConfig($); session.cachedAt = Date.now(); }
    const cfg = session.cachedConfig;
    if (cfg.mode !== 'active' || cfg.atPercent === undefined || blockedReason(cfg, Date.now())) return result;
    const usage = await $.session.usage();
    const tokens = usage?.context?.tokens;
    if (!Number.isFinite(tokens) || tokens <= 0) return result;
    // context.percent counts from the model's window; the threshold counts from the window the host
    // compacts at (rawMaxTokens).
    if (session.compactWindow === undefined || session.turnCount - session.windowTurn >= WINDOW_REFRESH_TURNS) {
      session.windowTurn = session.turnCount;
      try {
        const detail = await $.session.usage({ breakdown: 'summary' });
        const raw = detail?.context?.breakdown?.rawMaxTokens;
        session.compactWindow = Number.isFinite(raw) && raw > 0 ? raw : usage.context.window;
      } catch { session.compactWindow = usage.context.window; }
    }
    const window = session.compactWindow;
    if (!Number.isFinite(window) || window <= 0 || tokens * 100 < cfg.atPercent * window) return result;
    // The tokens include the fixed prefix (system prompt, tools, instructions): ask only when the
    // removable tool results are worth it, so the threshold never forces the built-in summary.
    session.lastAttempt = session.turnCount;
    const messages = await $.session.messages();
    const before = messages.reduce((s, m) => s + messageChars(m), 0);
    const removable = removableChars(findCandidates(messages, cfg.privatePaths));
    if (!before || removable / before < MIN_REDUCTION || removable / CHARS_PER_TOKEN < OWN_MIN_GAIN * window) return result;
    let reason;
    let detailText = '';
    try {
      const done = await $.session.compact();
      if (done && typeof done.skip === 'string') { reason = 'host_skipped'; detailText = done.skip; }
    } catch (error) {
      detailText = String(error?.message ?? error);
      reason = /headless|sdk|-p\b/i.test(detailText) ? 'host_cannot_compact' : /turn|in flight|running/i.test(detailText) ? 'host_turn_running' : 'host_error';
      if (reason === 'host_cannot_compact') session.hostCannot = true;
    }
    if (reason) {
      let sessionId;
      try { sessionId = await $.session.id(); } catch { sessionId = undefined; }
      await writeRecord($, cfg, {
        ts: isoNow(), point: POINT, event: 'own_threshold', session_id: sessionId ?? null, agent_id: null, result: 'rejected',
        reason, tokens, window, at_percent: cfg.atPercent, detail: clip(oneLine(maskSecrets(detailText)), 200),
      });
    }
  } catch { /* the threshold never breaks a turn */ }
  return result;
}

/** Registers the handlers; the session state starts fresh. */
export function register(on) {
  session = freshState();
  on('session.compact', compact);
  on('turn.complete', ownThreshold);
}
