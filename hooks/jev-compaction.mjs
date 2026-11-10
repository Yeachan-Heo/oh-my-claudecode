/* global crypto, TextEncoder */
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
 * The built-in summary (next(e)) also runs when the conversation is too short or its tool results
 * are too small for the removal to matter, while requests are paused after an endpoint failure, when
 * OMC_JEV_MAX_REQUESTS is used up, while the shared breaker is open or the shared request limit is
 * used up, and when Jev fails, answers too little or does not answer in time.
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
 * Shared breaker and request limit (OMC_JEV_BREAKER=1, OMC_JEV_MAX_RPM=<n>): the same files and rules as
 * the script side (scripts/lib/jev-breaker.mjs, see its header), under the same state directory and
 * scope. A hooks module cannot import Node, so the file work goes through $.fs; the rules are mirrors.
 * Before each request the module reads breaker.json (open: no request) and, with a limit, reserves a
 * slot in the UTC minute's rpm file at medium priority (a refused request takes no slot). A request
 * that fails opens the breaker by status alone (429 and 5xx; 401, 402, 403; Retry-After, for a 429
 * without one the retry time in its body), and the third request without a response within a minute
 * opens it too. $.fs can neither append nor delete: a line is added by writing the file whole and
 * reading it back, which can lose a line another process added in between (so the limit can be
 * exceeded when several sessions reserve in the same instant; this module's own file work is done one
 * step after the other), and the per-minute files of old minutes stay (the script side removes them
 * when it writes a new minute). Without these two variables nothing of this is read or written. The
 * module's own pause, its three-failures stop and OMC_JEV_MAX_REQUESTS stay as they were.
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
// Pause after a failed request, by status only (a response body is read only for the retry time of a
// 429 without a Retry-After, and only for the shared breaker): Retry-After when the response has it,
// else these defaults; three requests without a response within a minute pause too.
// Three failed compactions in a row stop the requests for the rest of the session, like the resolver's
// per-point breaker.
const PAUSE_DEFAULT_MS = 60_000;
const PAUSE_AUTH_MS = 600_000;
const PAUSE_MAX_MS = 1_800_000;
const NO_RESPONSE_TO_PAUSE = 3;
const NO_RESPONSE_WINDOW_MS = 60_000;
const FAILURES_TO_OPEN = 3;

// Shared breaker and request limit: mirrors of the constants in scripts/lib/jev-breaker.mjs
// (src/__tests__/jev-compaction-module.test.mjs locks the parity, with that library on the same files).
// Seconds a breaker stays open when the response gives no usable Retry-After; a Retry-After above the
// maximum is capped.
const BREAKER_SECONDS = { transient: 60, account: 600, noResponse: 60 };
const BREAKER_MAX_SECONDS = 1800;
// A recorded no-response time further ahead of the clock than this is a corrupt line or a clock set back.
const NO_RESPONSE_SKEW_MS = 5000;
const SAME_OUTAGE_GAP_MS = 15 * 60_000;
const EXTEND_MIN_MS = 5000;
// Pause after writing the breaker before it is read back (a concurrent opener may have replaced it).
const SETTLE_MS = 50;
const CLOCK_SLACK_MS = 60_000;
// `compaction` is a medium-priority point: it may use this share of the minute's limit.
const MEDIUM_SHARE = 0.85;
const RETRY_BODY_MAX_CHARS = 2000;
const APPEND_TRIES = 3;
// One step of file work on the shared state may take this long before the request goes on without it.
const SHARED_OP_MS = 3000;

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
    sharedQueue: Promise.resolve(), compacting: 0, pausedUntil: 0, pauseReason: null, failedInRow: 0, noResponseAt: [], requests: 0,
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
    OMC_JEV_BREAKER: await $.env.get('OMC_JEV_BREAKER'),
    OMC_JEV_MAX_RPM: await $.env.get('OMC_JEV_MAX_RPM'),
    OMC_JEV_BREAKER_DIR: await $.env.get('OMC_JEV_BREAKER_DIR'),
    USERPROFILE: await $.env.get('USERPROFILE'),
    HOME: await $.env.get('HOME'),
  };
  // Read settings to fill activation values (OMC_JEV, TYPESAFE_API_KEY) and shared settings
  // (OMC_JEV_BREAKER, OMC_JEV_MAX_RPM), but only if they're needed. With a deadline to prevent stalls.
  if (env.OMC_JEV === undefined || env.TYPESAFE_API_KEY === undefined) {
    try {
      const result = await withDeadline($, $.settings.read({ key: 'env' }), CONFIG_TTL_MS);
      const fromSettings = result && typeof result === 'object' ? (result.value || result) : result;
      if (fromSettings && typeof fromSettings === 'object') {
        for (const name of Object.keys(env)) if (env[name] === undefined && typeof fromSettings[name] === 'string') env[name] = fromSettings[name];
      }
    } catch { /* no settings: the process environment stands */ }
  }
  // Short-circuit: if mode is 'off' after filling from settings, don't read breaker/rpm settings.
  const mode = pointMode(env.OMC_JEV, env.TYPESAFE_API_KEY);
  if (mode !== 'off' && (env.OMC_JEV_BREAKER === undefined || env.OMC_JEV_MAX_RPM === undefined)) {
    try {
      const result = await withDeadline($, $.settings.read({ key: 'env' }), 1000);
      const fromSettings = result && typeof result === 'object' ? (result.value || result) : result;
      if (fromSettings && typeof fromSettings === 'object') {
        for (const name of Object.keys(env)) if (env[name] === undefined && typeof fromSettings[name] === 'string') env[name] = fromSettings[name];
      }
    } catch { /* no settings: the process environment stands */ }
  }
  // Home for shared-state directory: HOME on POSIX (matching jev-breaker.mjs), USERPROFILE on Windows.
  // Home for private-path expansion: preserve USERPROFILE for Windows compatibility.
  const homeForState = env.HOME || env.USERPROFILE;
  const homeForPrivatePaths = env.USERPROFILE || env.HOME;
  const stateDir = env.OMC_JEV_LOG_DIR ? slash(env.OMC_JEV_LOG_DIR) : homeForState ? `${slash(homeForState)}/.omc/state/jev` : undefined;
  const privatePaths = String(env.OMC_JEV_COMPACT_PRIVATE_PATHS ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    // A leading ~ matches both as written (in a command) and expanded to the home directory.
    .flatMap((p) => (homeForPrivatePaths && /^~(?=$|[\\/])/.test(p) ? [p, slash(homeForPrivatePaths) + p.slice(1)] : [p]))
    .map((p) => slash(p).toLowerCase());
  const endpoint = env.OMC_JEV_ENDPOINT || DEFAULT_ENDPOINT;
  return {
    mode,
    key: env.TYPESAFE_API_KEY,
    endpoint,
    shared: mode === 'off' ? undefined : await sharedSettings(env, endpoint, homeForState),
    spoolDir: stateDir ? `${stateDir}/compaction-spool` : undefined,
    maxRequests: positiveInt(env.OMC_JEV_MAX_REQUESTS, 0),
    excerptChars: positiveInt(env.OMC_JEV_EXCERPT_CHARS_COMPACTION, DEFAULT_EXCERPT_CHARS),
    atPercent: fraction(env.OMC_JEV_COMPACT_AT_PERCENT, undefined, 1, 99),
    target: fraction(env.OMC_JEV_COMPACT_TARGET, DEFAULT_TARGET, 0.1, 0.9),
    toast: String(env.OMC_JEV_COMPACT_TOAST ?? '').trim() === '1',
    privatePaths,
  };
}

// --- shared breaker and request limit ----------------------------------------------------------
// Mirrors of scripts/lib/jev-breaker.mjs (same files, same rules) through $.fs. Every function is
// fail-open: a file system error never holds a request back and never throws.

/** Mirror of parseMaxRpm: OMC_JEV_MAX_RPM as a positive integer, else undefined (no limit). */
export function parseMaxRpm(raw) {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw.trim())) return undefined;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Mirror of thresholdFor(limit, 'compaction'): a medium-priority point. */
export function mediumThreshold(limit) {
  return Math.max(1, Math.round(limit * MEDIUM_SHARE));
}

// {breaker, maxRpm, dir} for this endpoint and key, or undefined when neither OMC_JEV_BREAKER=1 nor
// OMC_JEV_MAX_RPM is set. dir is <base>/<scope>, the scope the first 16 hex digits of the SHA-256 of
// the endpoint, a newline and the key; the key itself is never written.
async function sharedSettings(env, endpoint, home) {
  const breaker = String(env.OMC_JEV_BREAKER ?? '').trim() === '1';
  const maxRpm = parseMaxRpm(env.OMC_JEV_MAX_RPM);
  if (!env.TYPESAFE_API_KEY || (!breaker && maxRpm === undefined)) return undefined;
  // Asked for but not usable (no home directory, no crypto): nothing is shared and the record says so.
  const unavailable = { unavailable: true, breaker: false, maxRpm: undefined, dir: undefined };
  const base = env.OMC_JEV_BREAKER_DIR ? slash(env.OMC_JEV_BREAKER_DIR) : home ? `${slash(home)}/.omc/state/jev/breaker` : undefined;
  if (!base) return unavailable;
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${endpoint}\n${env.TYPESAFE_API_KEY}`));
    const scope = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
    return { breaker, maxRpm, dir: `${base}/${scope}` };
  } catch {
    return unavailable;
  }
}

// One step of file work on the shared state after the other (this module writes whole files, so two
// steps at once would lose each other's lines). A step that takes longer than SHARED_OP_MS (or throws)
// ends with `fallback`, and the next step goes on.
function sharedStep($, work, fallback) {
  const done = session.sharedQueue.then(() => withDeadline($, work(), SHARED_OP_MS)).then((r) => ('value' in r ? r.value : fallback));
  session.sharedQueue = done;
  return done;
}

const minuteKey = (now) => new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 12);
const pause = ($, ms) => new Promise((resolve) => { try { $.clock.after(ms, () => resolve(undefined)); } catch { resolve(undefined); } });
async function readText($, path) {
  try { return await $.fs.read(path); } catch { return undefined; }
}

// Adds one line to a file. $.fs cannot append, so the file is written whole and read back; a line
// another process added between the read and the write is lost, and ours is written again when a
// concurrent write took it away (at most APPEND_TRIES writes). Returns the text read last.
async function appendLine($, path, line) {
  let text = '';
  for (let attempt = 0; attempt < APPEND_TRIES; attempt++) {
    const current = (await readText($, path)) ?? '';
    await $.fs.write(path, `${current === '' || current.endsWith('\n') ? current : `${current}\n`}${line}\n`);
    text = (await readText($, path)) ?? '';
    if (text.split('\n').includes(line)) return text;
  }
  return text;
}

// breaker.json as written, whatever its times; undefined when missing or unreadable. A partial text
// (a write landing) is read again.
async function readBreakerFile($, shared) {
  const path = `${shared.dir}/breaker.json`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const text = await readText($, path);
    if (text === undefined) {
      // Missing: closed. Present but unreadable (a rename landing): read again shortly.
      let present = false;
      try { present = await $.fs.exists(path); } catch { /* not there, or no check */ }
      if (!present) return undefined;
      if (attempt < 3) await pause($, 3);
      continue;
    }
    try {
      const state = JSON.parse(text);
      return state && typeof state === 'object' ? state : undefined;
    } catch {
      if (attempt < 3) await pause($, 3);
    }
  }
  return undefined;
}

// The open breaker {until, reason, since} (epoch ms), or undefined when it is closed, expired,
// unreadable, corrupt, or OMC_JEV_BREAKER is not set.
async function readSharedBreaker($, shared, now) {
  if (!shared?.breaker) return undefined;
  try {
    const state = await readBreakerFile($, shared);
    if (!state || !Number.isFinite(state.until) || state.until <= now) return undefined;
    if (state.until > now + BREAKER_MAX_SECONDS * 1000 + CLOCK_SLACK_MS) return undefined;
    const since = Number.isFinite(state.since) ? state.since : now;
    if (since < 0 || since > now + CLOCK_SLACK_MS) return undefined;
    return { until: state.until, reason: String(state.reason ?? ''), since: Math.min(since, now) };
  } catch {
    return undefined;
  }
}

// Opens the breaker for `seconds`, or keeps it open at least that long; an open breaker is never
// shortened. After each write the module pauses SETTLE_MS and reads the file again, and writes the
// later end again when a concurrent opener replaced it with an earlier one (at most 3 writes).
// `since` stays the start of the outage while it is extended or opens again within 15 minutes.
async function openSharedBreaker($, shared, seconds, reason, now) {
  try {
    const until = now + Math.max(1, Math.min(seconds, BREAKER_MAX_SECONDS)) * 1000;
    let since = now;
    const previous = await readBreakerFile($, shared);
    if (
      previous &&
      Number.isFinite(previous.until) &&
      Number.isFinite(previous.since) &&
      previous.since >= 0 &&
      previous.since <= now &&
      now - previous.until < SAME_OUTAGE_GAP_MS
    ) {
      since = previous.since;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await pause($, SETTLE_MS);
      const current = await readSharedBreaker($, shared, now);
      if (current && current.until >= until - EXTEND_MIN_MS) return current;
      await $.fs.write(`${shared.dir}/breaker.json`, JSON.stringify({ until, reason, since: current ? Math.min(current.since, since) : since }));
    }
    await pause($, SETTLE_MS);
    return await readSharedBreaker($, shared, now);
  } catch {
    return undefined;
  }
}

/** Mirror of retryAfterFromBody: the wait a 429 body states in words ("retry after 30 seconds", "Retry after ~178s"), else undefined. */
export function retryAfterFromBody(text) {
  if (typeof text !== 'string') return undefined;
  const match = /\bretry[\s_-]*after\b\s*[:=]?\s*~?\s*(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\b/i.exec(text.slice(0, RETRY_BODY_MAX_CHARS));
  return match ? Math.max(1, Math.ceil(Number(match[1]))) : undefined;
}

/**
 * Mirror of classifyFailure of the shared breaker: {reason, opens, seconds?} for a failed request
 * {status?, retryAfter?, body?, noResponse?}, or undefined when the failure says nothing about the
 * endpoint (another 4xx, an invalid 2xx body).
 */
export function sharedFailureClass(failure, now = Date.now()) {
  const status = Number.isInteger(failure?.status) ? failure.status : undefined;
  if (status === undefined) return failure?.noResponse ? { reason: 'no-response', opens: false } : undefined;
  let seconds;
  if (status === 429 || (status >= 500 && status <= 599)) seconds = BREAKER_SECONDS.transient;
  else if (status === 401 || status === 402 || status === 403) seconds = BREAKER_SECONDS.account;
  else return undefined;
  const header = retryAfterMs(failure.retryAfter, now);
  const retry = header !== undefined ? Math.max(1, Math.ceil(header / 1000)) : status === 429 ? retryAfterFromBody(failure.body) : undefined;
  return { reason: `http-${status}`, opens: true, seconds: Math.min(retry ?? seconds, BREAKER_MAX_SECONDS) };
}

// Requests without a response within the window, this one included, and the newest time recorded.
// The window ends at the newest time, not at this clock (concurrent processes sample their clocks
// before they append).
async function noteNoResponse($, shared, now) {
  try {
    await appendLine($, `${shared.dir}/noresp-${minuteKey(now)}`, String(now));
    const times = [];
    for (const key of [minuteKey(now - 60_000), minuteKey(now), minuteKey(now + 60_000)]) {
      const text = await readText($, `${shared.dir}/noresp-${key}`);
      if (text === undefined) continue;
      for (const line of text.split('\n')) {
        const time = Number(line);
        if (line && Number.isFinite(time) && time <= now + NO_RESPONSE_SKEW_MS) times.push(time);
      }
    }
    const newest = times.reduce((latest, time) => Math.max(latest, time), now);
    return { count: times.filter((time) => time > newest - NO_RESPONSE_WINDOW_MS).length, newest };
  } catch {
    return { count: 0, newest: now };
  }
}

// Records a failed request (a sharedFailureClass result): opens or extends the breaker, or counts a
// request without a response; the third within a minute opens it for a minute from the newest one.
async function recordSharedFailureClass($, shared, failure, now) {
  if (!shared?.breaker || !failure) return undefined;
  if (failure.opens) return openSharedBreaker($, shared, failure.seconds, failure.reason, now);
  if (failure.reason === 'no-response') {
    const { count, newest } = await noteNoResponse($, shared, now);
    if (count >= NO_RESPONSE_TO_PAUSE) return openSharedBreaker($, shared, BREAKER_SECONDS.noResponse, 'no-response', newest);
  }
  return undefined;
}

// A request that ended without a value (withDeadline's {timeout} or {error}), recorded with the shared
// breaker, as one step of file work after the other.
function recordSharedFailure($, cfg, result) {
  if (!cfg.shared?.breaker || result.value) return Promise.resolve();
  return sharedStep($, () => writeSharedFailure($, cfg, result), undefined);
}
async function writeSharedFailure($, cfg, result) {
  try {
    // A request that had less than a second because of the compaction's own deadline says nothing about the endpoint.
    if (result.timeout && result.short) return;
    const error = result.error;
    let failure;
    if (result.timeout) failure = { noResponse: true };
    else if (error?.invalid) failure = undefined;
    else if (error && Number.isInteger(error.status)) failure = { status: error.status, retryAfter: error.retryAfter, body: error.body };
    else failure = { noResponse: true };
    const now = Date.now();
    await recordSharedFailureClass($, cfg.shared, sharedFailureClass(failure, now), now);
  } catch { /* the breaker never breaks a compaction */ }
}

// Folds a minute file: a line "<token> <threshold>" is granted when fewer than <threshold> lines were
// granted before it. With `token` the fold stops at that line. Returns {granted, ok} (ok undefined
// when the token is absent or not given).
function foldMinute(text, token) {
  let granted = 0;
  for (const line of String(text ?? '').split('\n')) {
    const [lineToken, thresholdText] = line.split(' ');
    if (!lineToken || thresholdText === undefined) continue;
    const ok = granted < Number(thresholdText);
    if (ok) granted += 1;
    if (token !== undefined && lineToken === token) return { granted, ok };
  }
  return { granted, ok: undefined };
}

// Reserves one request in the current UTC minute: refused without writing anything when the minute
// already reached the threshold; otherwise the line is added and the file folded again. ok is true
// without a limit and whenever the files cannot be used.
async function reserveRequest($, shared, now) {
  const limit = shared.maxRpm;
  if (limit === undefined) return { ok: true };
  const threshold = mediumThreshold(limit);
  try {
    const path = `${shared.dir}/rpm-${minuteKey(now)}`;
    const before = foldMinute(await readText($, path));
    if (before.granted >= threshold) return { ok: false, count: before.granted, threshold, limit };
    const token = randomId();
    const { granted, ok } = foldMinute(await appendLine($, path, `${token} ${threshold}`), token);
    if (ok === undefined) return { ok: true };
    return { ok, count: granted, threshold, limit };
  } catch {
    return { ok: true };
  }
}

// Admission of one request, right before the HTTP call: the open breaker first, then the limit.
// Returns {skip: {mode: 'circuit-open', breaker}} or {skip: {mode: 'cap', count, threshold, limit}}
// when the request must not go out, {} otherwise.
function admitRequest($, shared) {
  return sharedStep($, () => admitNow($, shared), {});
}
async function admitNow($, shared) {
  const now = Date.now();
  const open = await readSharedBreaker($, shared, now);
  if (open) return { skip: { mode: 'circuit-open', breaker: open } };
  const slot = await reserveRequest($, shared, now);
  if (!slot.ok) return { skip: { mode: 'cap', count: slot.count, threshold: slot.threshold, limit: slot.limit } };
  return {};
}

// No request goes out: paused after a failure, breaker open, OMC_JEV_MAX_REQUESTS used up, or the
// shared breaker open.
async function blockedReason($, cfg, now) {
  if (session.failedInRow >= FAILURES_TO_OPEN) return 'circuit_open';
  if (now < session.pausedUntil) return 'paused';
  if (cfg.maxRequests && session.requests >= cfg.maxRequests) return 'cap';
  // Bounded like admission: a stalled shared volume falls back to "not open" after SHARED_OP_MS.
  if (cfg.shared && (await sharedStep($, () => readSharedBreaker($, cfg.shared, now), undefined))) return 'breaker_open';
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

// A user message with tool results kept by its engine handle is written after the compact boundary
// with its original parent, which points before the boundary, so `--resume` (and every `-p` turn)
// rebuilt the conversation from before the compaction (measured on Claude Code 2.1.318). Such a
// message is therefore rebuilt from its own text, unchanged for the model, whenever all its results
// are text. A message with an image or another non-text result in the last KEEP_LAST messages keeps
// its handle (counted in kept_handle) and has that limit.
function build(messages, candidates, stats) {
  const byId = new Map();
  for (const c of candidates) byId.set(c.id, c);
  const out = [];
  stats.rebuiltUnchanged = 0;
  stats.keptHandle = 0;
  for (const m of messages) {
    if (m.role === 'assistant' && (m.toolUses || []).some((u) => byId.get(u.tool_use_id)?.keep === 'trace')) {
      const traces = [];
      const kept = [];
      for (const u of m.toolUses) {
        const c = byId.get(u.tool_use_id);
        if (c && c.keep === 'trace') traces.push(c.trace);
        else kept.push({ tool_use_id: u.tool_use_id, tool: u.tool, input: u.input });
      }
      out.push({ role: 'assistant', text: [m.text || '', ...traces].filter(Boolean).join('\n'), toolUses: kept });
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
export function pairingOk(original, built) {
  const a = pairing(original);
  const b = pairing(built);
  return b.orphanResults <= a.orphanResults && b.openCalls <= a.openCalls;
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
    // Only for the retry time of a 429 without a usable Retry-After, and only for the shared breaker.
    if (cfg.shared?.breaker && response.status === 429 && retryAfterMs(failure.retryAfter) === undefined) {
      failure.body = String(response.text ?? '').slice(0, RETRY_BODY_MAX_CHARS);
    }
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
  const candidates = findCandidates(messages, cfg.privatePaths);
  record.candidates = candidates.length;
  const removable = removableChars(candidates);
  record.max_reduction = before ? Math.round((removable / before) * 1000) / 1000 : 0;
  if (!before || removable / before < MIN_REDUCTION) return { fallback: 'too_few_results' };
  const blocked = await blockedReason($, cfg, Date.now());
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
  let held;
  for (let b = 0; b * BATCH < asked.length; b++) {
    // The process cap is checked and taken in one step, before any await: a concurrent compaction
    // that passed blockedReason() meanwhile cannot also go over OMC_JEV_MAX_REQUESTS.
    if (cfg.maxRequests && session.requests >= cfg.maxRequests) { held = { mode: 'process-cap' }; break; }
    session.requests++;
    if (cfg.shared) {
      const admission = await admitRequest($, cfg.shared);
      if (admission.skip) { session.requests--; held = admission.skip; break; }
    }
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
    const timeoutMs = Math.max(500, Math.min(REQUEST_MS, deadline - t0));
    runs.push(
      withDeadline($, askJev($, cfg, state, questions), timeoutMs).then(async (r) => {
        await recordSharedFailure($, cfg, { ...r, short: timeoutMs < 1000 });
        return { ...r, batch, ms: Date.now() - t0 };
      }),
    );
  }
  // Recheck the process cap after awaiting: when two compactions pass blockedReason() concurrently,
  // both might compute capacity and enter the loop. After the first increments and one awaits, the second
  // resumes with stale capacity and empty asked; the loop never runs, so held is unset. If no requests
  // were made and the cap is now reached, treat it as a cap hit so the result goes to unanswered fallback.
  if (!runs.length && !held && cfg.maxRequests && session.requests >= cfg.maxRequests) {
    held = { mode: 'process-cap' };
  }
  if (held) {
    // A request held back by the shared breaker or limit is no failure of the endpoint. The results it
    // would have scored count as unanswered, as after a failed request: the budget decides about them.
    const unscored = asked.slice(runs.length * BATCH);
    for (const c of unscored) { c.asked = true; c.score = UNANSWERED_SCORE; }
    record.unscored = unscored.length;
    record.requests = runs.length;
    if (held.mode === 'circuit-open') Object.assign(record, { held: 'breaker', breaker_until: new Date(held.breaker.until).toISOString(), breaker_reason: held.breaker.reason });
    else if (held.mode === 'process-cap') record.held = 'cap';
    else Object.assign(record, { held: 'rpm', rpm: { count: held.count, threshold: held.threshold, limit: held.limit } });
    if (!runs.length) return { fallback: held.mode === 'circuit-open' ? 'breaker_open' : held.mode === 'process-cap' ? 'cap' : 'rpm' };
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
  const built = build(messages, candidates, stats);
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
  if (e.trigger === 'precompute') return cfg.mode === 'active' && !(await blockedReason($, cfg, Date.now())) ? { skip: 'jev-compaction replaces the summary' } : next(e);
  const started = Date.now();
  session.compacting++;
  try {
    let sessionId;
    try { sessionId = await $.session.id(); } catch { sessionId = undefined; }
    const record = {
      ts: isoNow(), point: POINT, event: 'compact', session_id: sessionId ?? null, agent_id: e.agentId ?? null,
      trigger: e.trigger, mode: cfg.mode, messages_before: Array.isArray(e.messages) ? e.messages.length : 0,
      chars_before: 0, target: cfg.target,
      ...(cfg.shared?.unavailable ? { shared_unavailable: true } : {}),
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
    if (cfg.mode !== 'active' || cfg.atPercent === undefined || (await blockedReason($, cfg, Date.now()))) return result;
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
