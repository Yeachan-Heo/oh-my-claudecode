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
 * the last KEEP_LAST messages, every user message (also one typed during a tool turn, which only the
 * API form shows, like the messages of other sessions and the task notifications delivered then) and
 * every assistant text stay word for word. Other
 * tool results are kept whole, shortened to SHORT_CHARS characters, or removed together with their
 * call; a removed call stays as a one-line trace (tool, input up to TRACE_INPUT_CHARS, size of the
 * removed result), so the model knows what it already did. Jev scores how much each result will still
 * be needed (the `compaction` score question in src/hooks/jev/points.ts, BATCH results per request,
 * up to MAX_REQUESTS requests in parallel). Results are ranked by score and kept while they fit the
 * target budget (OMC_JEV_COMPACT_TARGET of the characters before, delivered messages that only the API
 * form shows included). In shadow mode the decision is computed and logged, and the built-in summary
 * runs.
 *
 * Assistant rows are rebuilt from their text, traces and kept calls (thinking and server blocks go, a
 * row left empty is dropped), so the host writes them with a new message.id and `--resume` cannot
 * join them with their rows from before the compaction. The rows of one API message become one
 * message with its results right after it, so the host neither joins a row to an earlier message nor
 * finds a call without its result. Between turns every assistant row is rebuilt; inside an open tool
 * loop the rows of the last assistant message keep their handles, which needs the API form of the
 * conversation ($.session.messages({ as: 'api' })) holding its calls, and no thinking row or server
 * block among them; otherwise the built-in summary runs.
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
 * made). After a compaction of the main loop (this module's or the built-in summary) it also waits
 * until the context has grown by OWN_MIN_GAIN of the window from the lowest usage since it (from the
 * threshold at most).
 *
 * What goes to the endpoint: the /compact instructions and the last USER_MESSAGES user messages
 * (together USER_CHARS characters), and for each scored result its tool, its input (STATE_INPUT_CHARS)
 * and the result's first STATE_HEAD_CHARS and last STATE_TAIL_CHARS characters, all after secret
 * masking, with every string bounded by OMC_JEV_EXCERPT_CHARS_COMPACTION (default
 * DEFAULT_EXCERPT_CHARS). Results of calls on secret paths (and on OMC_JEV_COMPACT_PRIVATE_PATHS)
 * and results without text are never sent; neither is the result of an agent, message or task call
 * whose prose names such a path (it is kept as if unanswered), nor what TaskOutput or BashOutput returns
 * (the output of a call started in the background; it is kept the same way), nor a Read or `tail` of the
 * output file of such a call on a secret or private path. A line naming such a path in a result, an
 * input, the user's words or the /compact instructions is sent as SECRET_LINE (after its private key
 * blocks are masked), and a line cut at a head or tail edge that does not end within LINE_EDGE_CHARS as
 * LONG_LINE.
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

import { maskPrivateKeys, maskSecrets } from '../scripts/lib/jev-mask.mjs';

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
// Pause after writing the breaker before it is read back (a writer without the lock may have replaced it).
const SETTLE_MS = 50;
// breaker.json.lock (see takeLock): a lock older than LOCK_STALE_MS is of a process that died or hangs, and a breaker.json that does not
// parse and was written less than LOCK_STALE_MS ago is a write in progress; LOCK_WAIT_MS is the longest wait for the lock. The module
// reads its token back LOCK_CONFIRM_MS after writing it, and gives up after LOCK_REFUSALS_TO_GIVE_UP refused writes of the lock in a row.
const LOCK_STALE_MS = 1000;
const LOCK_WAIT_MS = 1500;
const LOCK_POLL_MS = 5;
const LOCK_CONFIRM_MS = 20;
const LOCK_REFUSALS_TO_GIVE_UP = 3;
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
// Messages delivered while a tool turn runs. Claude Code keeps such a message as an attachment row
// after the result row: `messages` does not show it (the host hands such rows back only with the
// handle of the row before them), and the API form shows it as a text block of the user message with
// the results, inside an optional <system-reminder ...> wrapper: "<who> sent a message while you were
// working:" (the user: QUEUED_PREFIX, their words, then a fixed note, QUEUED_TAIL; another session or
// agent; the coordinator; a plugin), a teammate's <teammate-message>, or a background task
// notification. A result row rebuilt without its handle would lose it, so build carries every such
// block word for word into the rebuilt row, each in its own envelope (envelope); only QUEUED_PREFIX
// blocks count as the user's words. The host frames an automatic continuation and a plugin's message
// sent as the user with QUEUED_PREFIX too; the API form does not tell them apart, so they count as the
// user's.
const QUEUED_PREFIX = 'The user sent a new message while you were working:\n';
const QUEUED_TAIL = '\n\nThis is how Claude Code surfaces messages'; // the fixed note after the user's words
// The host's whole note (the same words in Claude Code 2.1.284 to 2.1.322). A user who quotes the note stops
// somewhere in it, so only a verbatim copy of all of it reads like the host's.
const QUEUED_FOOTER = `${QUEUED_TAIL} the user sends mid-turn \u2014 within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.`;
const DELIVERY_WRAP = /^(?:\s*<system-reminder[^>]*>)+\s*/; // a wrapper, also the envelope build writes around a wrapped block
// The first line of another sender's frame: "<sender> sent a message (or a report) while you were
// working:", and the bound conversation's "A message arrived ...", "Messages arrived ..." and
// "Activity ... in the bound conversation ..." frames. A line that only ends with "while you were
// working:" is no frame.
const OTHER_FRAME = /^(?:.+ sent an? (?:new )?(?:message|report)|(?:A message|Messages) arrived .+|Activity (?:was observed )?in the bound conversation) while you were working(?:,.*)?:$/;
const DELIVERY_OPENERS = ['Another Claude session sent a message:', '<agent-message', '<cross-session-message', '<teammate-message', '<task-notification', '[MESSAGE FROM NON-USER SOURCE'];
// An envelope in a row's text: the host's <system-reminder id="..."> and the one build writes around a
// carried block, each closed only by the closing tag with its own id.
const ENVELOPE_CLOSE = '</system-reminder id="';
const ENVELOPE_OPEN = /<system-reminder id="(?=([^"\n]{1,64})">)/g; // every opener, also one inside another's id
const ENVELOPE_ID = /([^"\n]{1,64})">/y; // the id and end of a closing tag, read where the tag starts
// A task notification's marker opens the block (after its own wrapper and reminders), not a line deep in a quoted file.
const DELIVERY_NOTES = ['[SYSTEM NOTIFICATION - NOT USER INPUT]', '<task-notification>'];
// A complete reminder before a block's frame (the Claude desktop app writes "<system-reminder>...</system-reminder>
// Another Claude session sent a message:"); at most PRELUDES_MAX of them are skipped.
const DELIVERY_PRELUDE = /^\s*<system-reminder[^>]*>[\s\S]*?<\/system-reminder[^>]*>\s*/;
const PRELUDES_MAX = 4;

// Secret paths: SSH keys (every file in a .ssh directory but known_hosts*, authorized_keys*, config, config.d/,
// environment, rc and *.pub, and an id_rsa, id_dsa, id_ecdsa or id_ed25519 key anywhere), git and gh credentials,
// Claude Code credentials, AWS credentials, .netrc (_netrc on Windows), .env and .envrc files (not a .example
// template), each also as a renamed copy (a prefix or a copy suffix: old_id_rsa, id_rsa.bak, backup.ssh/,
// .ssh.bak/, .ssh2/, .sshkeys/, old.netrc, backup.env, my-app.env, .env.production.local; a .ssh directory name goes
// on only with a digit, a punctuation mark, a copy word or keys, so .sshuttle/ is not one). A .netrc or .env name starts after a
// separator, a quote, or a shell or prose delimiter, never inside a code identifier (`ctx.env`, `ctx.app.env`). A
// .env name ends before such a delimiter, a glob or backup mark (* ~ #) or a dot that ends a sentence
// (`/repo/.env:2:` of grep, "edit .env, then", "in `.env`."), not before a slash (a `.env/` directory). Every prefix
// and suffix is bounded, so the check stays linear.
const SECRET_START = String.raw`(?:^|[\s"'\x60\\/=;|&<>()[\]{},:@*])`;
const SECRET_NAME = String.raw`[^\s"'\x60\\/=;|&<>()[\]{},:@*]`;
const SECRET_FILE = String.raw`[^\s"'\x60\\/;|&<>()[\]{},:]`;
const SECRET_ENV = String.raw`\.env(?:rc)?(?:[._-](?!example(?![a-z0-9]))[a-z0-9]+){0,4}(?=$|[\s"'\x60;|&<>()[\]{},:!?*~#]|\.(?![a-z0-9_-]))`;
const SECRET_PATH = new RegExp([
  String.raw`[\\/][^\s"'\\/]{0,80}\.ssh(?:(?:[^a-z\s"'\\/]|bak|backup|old|orig|save|copy|prev|new|tmp|temp|keys?|archive)[^\s"'\\/]{0,80})?[\\/]+(?!known_hosts|authorized_keys|(?:config|environment|rc)(?!${SECRET_FILE})|config\.d[\\/])(?!${SECRET_FILE}{0,255}\.pub(?!${SECRET_FILE}))${SECRET_FILE}+`,
  `${SECRET_START}${SECRET_NAME}{0,80}id_(?:rsa|dsa|ecdsa|ed25519)(?![a-z])(?!${SECRET_NAME}{0,80}\\.pub(?!${SECRET_NAME}))`,
  String.raw`\.git-credentials\b`,
  String.raw`[\\/]\.config[\\/]+gh[\\/]+hosts\.ya?ml\b`,
  String.raw`\.credentials\.json\b`,
  String.raw`[\\/][^\s"'\\/]{0,80}\.aws[^\s"'\\/]{0,80}[\\/]+credentials\b`,
  `${SECRET_START}${SECRET_NAME}{0,80}[._]netrc\\b`,
  `${SECRET_START}${SECRET_ENV}`,
  // a named env file (prod.env, backup.env, my-app.env, x_1.env); its prefix has no dot, so code such as ctx.app.env is not one
  `${SECRET_START}[^\\s"'\\x60\\\\/=;|&<>()[\\]{},:@*.]{0,80}(?:prod|production|dev|development|staging|stage|test|local|secrets?|private|credentials?|app|docker|db|database|api|backup|bak|copy|old|orig|save|[-_0-9])${SECRET_ENV}`,
].join('|'), 'i');
// Fields that name a path or run a command, in any tool (built-in or MCP).
const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'command'];
const TOOL_PATH_FIELDS = { Glob: ['pattern'], Grep: ['glob'] };
// Built-in tools whose path fields are the ones above. Any other tool (MCP, unknown) can open a path from any
// field (`code`, `sql`, a nested option), so every string and key of its input is checked, at most
// SECRET_WALK_MAX strings and keys; a larger or deeper input counts as touching a secret path.
const NAMED_FIELD_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'LS', 'Bash', 'PowerShell', 'Monitor', 'WebFetch', 'WebSearch']);
// Tools whose input is prose (an agent prompt, a message, a task). A secret or private path anywhere in it does
// not make the call a trace, since the result is the agent's own report, but the result is not sent either:
// it is kept as if its request had been held back (UNANSWERED_SCORE), because the agent may have read the path.
const PROSE_TOOLS = new Set(['Agent', 'Task', 'SendMessage', 'TaskCreate', 'TaskUpdate', 'TaskStop', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'Skill']);
// Tools that return the output of a call started in the background, by its id: their results are held.
const OUTPUT_TOOLS = new Set(['TaskOutput', 'BashOutput']);
const SECRET_WALK_MAX = 2000;
// A line longer than MASK_SLACK_CHARS at the edge of a head or tail cut is read up to LINE_EDGE_CHARS further, so
// a secret path later on that line still hides it.
const LINE_EDGE_CHARS = 4 * MASK_SLACK_CHARS;
// What Jev gets instead of a line that names a secret or private path (the path and the rest of the line,
// such as a grep hit, stay out).
const SECRET_LINE = '[line omitted: secret path]';
// What Jev gets instead of the part of a line cut at a head or tail edge that does not end within LINE_EDGE_CHARS:
// the rest of that line is not read, so it may name a secret path (fail closed).
const LONG_LINE = '[line omitted: too long to check]';
// A tool may take a path in parts ({ directory, name }, { root, relative }, segments in an array, a directory as a key).
// The last line of a string or key whose last two segments name .ssh, .aws or .config, or which ends with a private
// path up to one of its slashes, is joined by a slash with the first line of every other string and key of the input.
// A secret path the join makes spans that slash, so only JOIN_EDGE_CHARS (and the length of the longest private path)
// on each side of it are read. A join that ends at a directory that still wants a child (`.config/gh`, a private path
// cut at a slash) is joined again with every other string (`['/home/u', '.config', 'gh', 'hosts.yml']`, three parts, at
// most JOIN_PARTS_MAX of them). A string whose start is a secret path under a root (`.config/gh/hosts.yml`) is joined
// with every string that is a path (JOIN_ROOT: `{ root: '/home/u', relative: '.config/gh/hosts.yml' }`). The joins are
// not narrowed by what the other strings look like: an option next to a .ssh directory (`encoding: 'utf-8'`) is joined too,
// so such a call is held back even when its file is known_hosts (fail closed; one traced result costs less than a key sent).
const JOIN_EDGE_CHARS = 300;
const JOIN_PARTS_MAX = 3;
const JOIN_DIR = /\.(?:ssh|aws)|(?:^|\/)\.config(?:\/|$)/i;
const JOIN_ROOT = /[/~$%]|:$|^\.{0,2}$/;
const JOIN_GH_DIR = /\.config\/gh\/?$/i;

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
function maskedHeadTail(text, head, tail, privatePaths = []) {
  const clean = (part) => maskSecrets(omitSecretLines(part, privatePaths));
  if (text.length <= head + tail + 2 * MASK_SLACK_CHARS) return headTail(clean(text), head, tail);
  const first = clean(headPart(text, head + MASK_SLACK_CHARS)).slice(0, head);
  const last = clean(tailPart(text, text.length - tail - MASK_SLACK_CHARS)).slice(-tail);
  return `${first}\n[... ${text.length - head - tail} chars omitted ...]\n${last}`;
}
// The text up to `end` and the text from `start`, each widened to the whole line its edge falls in (at most
// LINE_EDGE_CHARS more), so omitSecretLines sees that line; a line that does not end within that becomes LONG_LINE.
function headPart(text, end) {
  if (end >= text.length) return text;
  const nl = text.indexOf('\n', end);
  if (nl >= 0 ? nl <= end + LINE_EDGE_CHARS : text.length <= end + LINE_EDGE_CHARS) return nl >= 0 ? text.slice(0, nl) : text;
  return text.slice(0, text.lastIndexOf('\n', end - 1) + 1) + LONG_LINE;
}
function tailPart(text, start) {
  if (start <= 0) return text;
  const pl = text.lastIndexOf('\n', start);
  if (pl + 1 >= start - LINE_EDGE_CHARS) return text.slice(pl + 1);
  // The cut line may end with a private key header: its block is masked before the line is dropped.
  const rest = maskPrivateKeys(text.slice(start - LINE_EDGE_CHARS));
  const nl = rest.indexOf('\n');
  return nl < 0 ? LONG_LINE : LONG_LINE + rest.slice(nl);
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
    cachedConfig: undefined, cachedAt: -Infinity, growthArmed: false, growthBase: undefined,
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
    OS: await $.env.get('OS'),
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
  // Home for shared-state directory: HOME on POSIX (matching jev-breaker.mjs, which uses os.homedir()),
  // USERPROFILE on Windows. On POSIX, do not use USERPROFILE as a fallback when HOME is unset,
  // because os.homedir() does not use USERPROFILE and the breaker state would be in a different location.
  // Home for private-path expansion: preserve USERPROFILE for Windows compatibility.
  const homeForState = env.OS === 'Windows_NT' ? env.USERPROFILE || env.HOME : env.HOME;
  const homeForPrivatePaths = env.USERPROFILE || env.HOME;
  const stateDir = env.OMC_JEV_LOG_DIR ? slash(env.OMC_JEV_LOG_DIR) : homeForState ? `${slash(homeForState)}/.omc/state/jev` : undefined;
  const privatePaths = String(env.OMC_JEV_COMPACT_PRIVATE_PATHS ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    // A leading ~ matches both as written (in a command) and expanded to the home directory.
    .flatMap((p) => (homeForPrivatePaths && /^~(?=$|[\\/])/.test(p) ? [p, slash(homeForPrivatePaths) + p.slice(1)] : [p]))
    // Runs of slashes and backslashes as one slash, as in namesSecretPath.
    .map((p) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase());
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
// returns `fallback`, but retains its place until the underlying work settles. Queue waiting counts
// toward the deadline too; a step that expires before starting must not do stale file work later.
function sharedStep($, work, fallback, ms = SHARED_OP_MS) {
  const deadline = Date.now() + ms;
  let expired = false;
  const pending = session.sharedQueue.then(() => expired || Date.now() >= deadline ? fallback : work());
  session.sharedQueue = pending.then(() => undefined, () => undefined);
  return withDeadline($, pending, ms).then((r) => {
    expired = true;
    return 'value' in r ? r.value : fallback;
  });
}

const minuteKey = (now) => new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 12);
const pause = ($, ms) => new Promise((resolve) => { try { $.clock.after(ms, () => resolve(undefined)); } catch { resolve(undefined); } });
async function readText($, path) {
  try { return await $.fs.read(path); } catch { return undefined; }
}
// Reads text distinguishing missing file from read error. Returns {missing: true}, {unreadable: true},
// or {text: ...}. Unreadable errors are fail-open: don't overwrite shared state.
async function readTextSafe($, path) {
  try {
    return { text: await $.fs.read(path) };
  } catch {
    try {
      const exists = await $.fs.exists(path);
      if (!exists) return { missing: true };
    } catch {
      // Cannot check existence; assume unreadable.
    }
    return { unreadable: true };
  }
}

// Adds one line to a file. $.fs cannot append, so the file is written whole and read back; a line
// another process added between the read and the write is lost, and ours is written again when a
// concurrent write took it away (at most APPEND_TRIES writes). Returns the text read last.
// Before appending on retry, check if the line is already present (idempotent retry).
async function appendLine($, path, line) {
  let text = '';
  for (let attempt = 0; attempt < APPEND_TRIES; attempt++) {
    const current = (await readText($, path)) ?? '';
    // Idempotent: if the line is already present, don't write again.
    if (current.split('\n').includes(line)) return current;
    await $.fs.write(path, `${current === '' || current.endsWith('\n') ? current : `${current}\n`}${line}\n`);
    text = (await readText($, path)) ?? '';
    if (text.split('\n').includes(line)) return text;
  }
  return text;
}

// A read or stat error means the file is missing only with ENOENT or when $.fs.exists says so.
const isMissing = async ($, path, error) => {
  if (error?.code === 'ENOENT') return true;
  try { return !(await $.fs.exists(path)); } catch { return false; }
};

// breaker.json as read, in up to 4 attempts 3 ms apart (mirror of readBreakerState in jev-breaker.mjs): {state} (the file as written,
// whatever its times; undefined when missing or not an object); {unreadable: true} when a read failed in any attempt, or the text does
// not parse in a file written less than LOCK_STALE_MS ago (a write in progress; no usable mtime counts as fresh): readers treat it as
// closed, but nothing is written over it; {state: undefined, corrupt: true} when no attempt parsed in an older file (replaced).
async function readBreakerState($, shared) {
  const path = `${shared.dir}/breaker.json`;
  let failed = false;
  let fresh = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await pause($, 3);
    let text;
    try {
      text = await $.fs.read(path);
    } catch (error) {
      if (await isMissing($, path, error)) return { state: undefined };
      failed = true;
      continue;
    }
    try {
      const state = JSON.parse(text);
      return { state: state && typeof state === 'object' ? state : undefined };
    } catch {
      try {
        const mtime = (await $.fs.stat(path)).mtimeMs;
        fresh = !Number.isFinite(mtime) || Math.abs(Date.now() - mtime) <= LOCK_STALE_MS;
      } catch (error) {
        if (await isMissing($, path, error)) return { state: undefined };
        fresh = true;
      }
    }
  }
  return failed || fresh ? { unreadable: true } : { state: undefined, corrupt: true };
}

// The open breaker {until, reason, since} (epoch ms), or undefined when it is closed, expired,
// unreadable, corrupt, or OMC_JEV_BREAKER is not set.
async function readSharedBreaker($, shared, now) {
  if (!shared?.breaker) return undefined;
  try {
    return breakerOf((await readBreakerState($, shared)).state, now);
  } catch {
    return undefined;
  }
}

// The open breaker that a breaker.json state holds at `now`, by the rules of readSharedBreaker.
function breakerOf(state, now) {
  if (!state || !Number.isFinite(state.until) || state.until <= now) return undefined;
  if (state.until > now + BREAKER_MAX_SECONDS * 1000 + CLOCK_SLACK_MS) return undefined;
  const since = Number.isFinite(state.since) ? state.since : now;
  if (since < 0 || since > now + CLOCK_SLACK_MS) return undefined;
  return { until: state.until, reason: String(state.reason ?? ''), since: Math.min(since, now) };
}

// breaker.json.lock of jev-breaker.mjs, which creates it exclusively and removes it. $.fs has neither, so the module writes its token
// when the lock is free, reads it back after LOCK_CONFIRM_MS (a script process that created the lock in the same moment finds the
// module's token before its write and starts over), checks it again right before its write, and marks the lock released afterwards
// (the next script opener removes the file). Free: missing, released, or older than LOCK_STALE_MS by its ts, else by its mtime (text not
// written yet, unreadable or corrupt); no usable mtime: taken.
async function lockFree($, path) {
  let text;
  try { text = await $.fs.read(path); } catch (error) { if (await isMissing($, path, error)) return true; }
  let lock;
  try { lock = text === undefined ? undefined : JSON.parse(text); } catch { lock = undefined; }
  if (lock && lock.released === true) return true;
  let at = lock && Number.isFinite(lock.ts) ? lock.ts : undefined;
  if (at === undefined) {
    try { at = (await $.fs.stat(path)).mtimeMs; } catch (error) { return isMissing($, path, error); }
  }
  // The clock is read after the host reads: a lock created while a slow read was under way is as young as it is, not ahead of an earlier sample.
  return Number.isFinite(at) && Math.abs(Date.now() - at) > LOCK_STALE_MS;
}
async function holdsLock($, path, token) {
  try { return JSON.parse(await $.fs.read(path)).token === token; } catch { return false; }
}
// The module's token, or undefined when the lock stays taken until `deadline` or its write is refused LOCK_REFUSALS_TO_GIVE_UP times in a row.
// The deadline is checked before every acquisition step and before a token is returned: a host read that was delayed past it
// neither writes a token nor hands one out, and a token written just before the deadline is released.
async function takeLock($, path, deadline) {
  const token = `compaction-${randomId()}`;
  let refusals = 0;
  let wroteToken = false;
  const expire = async () => {
    if (wroteToken) await releaseLock($, path, token);
    return undefined;
  };
  for (;;) {
    // A confirming read that hit the moment a script opener moved the lock away and linked it back must not leave the module
    // waiting on its own token.
    if (wroteToken && (await holdsLock($, path, token))) return Date.now() < deadline ? token : expire();
    if (Date.now() >= deadline) return expire();
    if (await lockFree($, path)) {
      if (Date.now() >= deadline) return expire();
      let written = false;
      try {
        await $.fs.write(path, JSON.stringify({ token, ts: Date.now() }));
        written = true;
        refusals = 0;
      } catch {
        // EBUSY or EPERM while a script process removes the lock: keep polling, as the script side does.
        refusals += 1;
        if (refusals >= LOCK_REFUSALS_TO_GIVE_UP) return undefined;
      }
      if (written) {
        wroteToken = true;
        await pause($, LOCK_CONFIRM_MS);
        if (await holdsLock($, path, token)) return Date.now() < deadline ? token : expire();
      }
    }
    if (Date.now() >= deadline) return expire();
    await pause($, LOCK_POLL_MS);
  }
}
async function releaseLock($, path, token) {
  try {
    if (await holdsLock($, path, token)) await $.fs.write(path, JSON.stringify({ token, ts: Date.now(), released: true }));
  } catch { /* a lock left behind goes stale */ }
}

// Opens the breaker for `seconds`, or keeps it open at least that long; an open breaker is never
// shortened. The read, the comparison and the write happen under breaker.json.lock (see takeLock), so
// an opener held up between its read and its write holds the others back instead of overwriting them.
// A breaker.json that is there but cannot be read is not a closed breaker: nothing is written over it.
// When the lock stays taken for LOCK_WAIT_MS nothing is written. After each write the module pauses
// SETTLE_MS and reads the file again under the lock, and writes the later end again when a writer that
// does not take the lock replaced it with an earlier one (at most 3 writes). `since` stays the start of
// the outage while it is extended or opens again within 15 minutes.
async function openSharedBreaker($, shared, seconds, reason, now) {
  try {
    const until = now + Math.max(1, Math.min(seconds, BREAKER_MAX_SECONDS)) * 1000;
    const path = `${shared.dir}/breaker.json`;
    const lockPath = `${path}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    let since = now;
    let read = false;
    let written;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (written) await pause($, SETTLE_MS);
      const token = await takeLock($, lockPath, deadline);
      if (!token) break;
      try {
        const onDisk = await readBreakerState($, shared);
        if (onDisk.unreadable) break;
        if (!read) {
          read = true;
          const previous = onDisk.state;
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
        }
        const current = breakerOf(onDisk.state, now);
        if (current && current.until >= until - EXTEND_MIN_MS) return current;
        const state = { until, reason, since: current ? Math.min(current.since, since) : since };
        // The lock was taken over (stale, or a script opener in the same moment): read again.
        if (!(await holdsLock($, lockPath, token))) continue;
        await $.fs.write(path, JSON.stringify(state));
        written = state;
      } finally {
        await releaseLock($, lockPath, token);
      }
    }
    return (await readSharedBreaker($, shared, now)) ?? written;
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
// without a limit and whenever the files cannot be used. A read that outlives the decision deadline
// returns {expired: true} without writing: the caller already gave up, so no request will use the slot.
async function reserveRequest($, shared, now, deadline) {
  const limit = shared.maxRpm;
  if (limit === undefined) return { ok: true };
  const threshold = mediumThreshold(limit);
  try {
    if (Date.now() >= deadline) return { expired: true };
    const path = `${shared.dir}/rpm-${minuteKey(now)}`;
    const readResult = await readTextSafe($, path);
    if (Date.now() >= deadline) return { expired: true };
    // Fail-open on unreadable: an error reading the RPM file is not grounds to block a request.
    if (readResult.unreadable) return { ok: true };
    const before = foldMinute(readResult.text ?? '');
    if (before.granted >= threshold) return { ok: false, count: before.granted, threshold, limit };
    const token = randomId();
    const { granted, ok } = foldMinute(await appendLine($, path, `${token} ${threshold}`), token);
    if (ok === undefined) return { ok: true };
    return { ok, count: granted, threshold, limit };
  } catch {
    return { ok: true };
  }
}

// Admission of one request, right before the HTTP call: reserve the process cap atomically before
// awaiting shared state, and release it if the breaker or shared limit refuses the request.
// Returns {skip: {mode: 'circuit-open', breaker}} or {skip: {mode: 'cap', count, threshold, limit}}
// when the request must not go out, {} otherwise.
async function admitRequest($, cfg, deadline) {
  if (Date.now() >= deadline) return { skip: { mode: 'deadline' } };
  if (cfg.maxRequests && session.requests >= cfg.maxRequests) return { skip: { mode: 'process-cap' } };
  session.requests++;
  const admission = cfg.shared ? await sharedStep($, () => admitNow($, cfg.shared, deadline), {}, Math.min(SHARED_OP_MS, deadline - Date.now())) : {};
  if (Date.now() >= deadline) {
    session.requests--;
    return { skip: { mode: 'deadline' } };
  }
  if (admission.skip) session.requests--;
  return admission;
}
async function admitNow($, shared, deadline) {
  const now = Date.now();
  const open = await readSharedBreaker($, shared, now);
  if (open) return { skip: { mode: 'circuit-open', breaker: open } };
  // Recheck deadline after I/O to avoid writing reservations after the compaction deadline has passed.
  if (Date.now() >= deadline) return { skip: { mode: 'deadline' } };
  const slot = await reserveRequest($, shared, now, deadline);
  if (slot.expired) return { skip: { mode: 'deadline' } };
  if (!slot.ok) return { skip: { mode: 'cap', count: slot.count, threshold: slot.threshold, limit: slot.limit } };
  return {};
}

// Check if RPM capacity is available without reserving it (non-reserving peek).
async function rpmCapacityAvailable($, shared, point, now) {
  if (!shared?.maxRpm) return true; // No limit.
  try {
    const threshold = mediumThreshold(shared.maxRpm);
    const path = `${shared.dir}/rpm-${minuteKey(now)}`;
    const before = foldMinute(await readText($, path));
    return before.granted < threshold;
  } catch {
    return true; // File system error: fail-open.
  }
}

// No request goes out: paused after a failure, breaker open, OMC_JEV_MAX_REQUESTS used up, the
// shared breaker open, or RPM capacity exhausted.
async function blockedReason($, cfg, now) {
  if (session.failedInRow >= FAILURES_TO_OPEN) return 'circuit_open';
  if (now < session.pausedUntil) return 'paused';
  if (cfg.maxRequests && session.requests >= cfg.maxRequests) return 'cap';
  // Bounded like admission: a stalled shared volume falls back to "not open" after SHARED_OP_MS.
  if (cfg.shared && (await sharedStep($, () => readSharedBreaker($, cfg.shared, now), undefined))) return 'breaker_open';
  // The capacity peek is bounded the same way and fails open. Skip the peek when RPM is not enabled.
  if (cfg.shared?.maxRpm && !(await sharedStep($, () => rpmCapacityAvailable($, cfg.shared, 'compaction', now), true))) return 'rpm';
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

function namesSecretPath(value, privatePaths) {
  if (SECRET_PATH.test(value)) return true;
  if (!privatePaths.length) return false;
  // Every run of slashes and backslashes as one slash: a Windows path, its JSON form (C:\\Users\\x), an escaped
  // slash (\/home\/u) and a doubled slash all compare equal to the private path (linear, unlike slash()).
  const v = String(value).replace(/[\\/]+/g, '/').toLowerCase();
  return privatePaths.some((p) => v.includes(p));
}

// The text with every line that names a secret or private path replaced by SECRET_LINE (exported for tests). Private
// key blocks are masked first: the header of a block may be on such a line, and without it the body is not recognized.
export function omitSecretLines(text, privatePaths) {
  const s = maskPrivateKeys(text);
  if (!namesSecretPath(s, privatePaths)) return s;
  return s.split('\n').map((line) => (namesSecretPath(line, privatePaths) ? SECRET_LINE : line)).join('\n');
}

// The input of a call as sent: every string and every key through omitSecretLines.
function sentInputJson(input, privatePaths) {
  const clean = (v) => {
    if (typeof v === 'string') return omitSecretLines(v, privatePaths);
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [omitSecretLines(k, privatePaths), x]));
    return v;
  };
  try { return JSON.stringify(input ?? {}, (_k, v) => clean(v)) ?? ''; } catch { return ''; }
}

// Does any string or key of the input name a secret or private path, or a join of two or three of them (a path in
// parts, see JOIN_DIR)? At most SECRET_WALK_MAX strings and keys and SECRET_WALK_MAX joins, depth 8; beyond that it
// counts as yes (fail closed).
function anySecretPath(input, privatePaths) {
  let seen = 0;
  const parts = [];
  const edge = JOIN_EDGE_CHARS + Math.max(0, ...privatePaths.map((p) => p.length));
  // A key is a first part only (a directory as a key); as a second part a field name would make `.ssh/<field>`.
  const named = (text, key) => {
    if (namesSecretPath(text, privatePaths)) return true;
    const t = text.trim();
    const nl = t.indexOf('\n');
    const first = key ? '' : (nl < 0 ? t : t.slice(0, nl)).trimEnd().replace(/[\\/]+/g, '/').slice(0, edge);
    const last = t.slice(t.lastIndexOf('\n') + 1).trimStart().replace(/[\\/]+/g, '/').slice(-edge);
    if (first || last) parts.push({ first, last });
    return false;
  };
  const walk = (v, depth) => {
    if (depth > 8) return true;
    if (typeof v === 'string') return ++seen > SECRET_WALK_MAX || named(v, false);
    if (Array.isArray(v)) return v.some((x) => walk(x, depth + 1));
    if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => ++seen > SECRET_WALK_MAX || named(k, true) || walk(x, depth + 1));
    return false;
  };
  if (walk(input, 0)) return true;
  // A private path cut at one of its slashes: the end of a string that is its first part.
  const prefixes = privatePaths.flatMap((p) => [...p.matchAll(/(?<=.)\//g)].map((m) => p.slice(0, m.index)));
  const wantsChild = (end) => prefixes.length > 0 && prefixes.some((x) => end.toLowerCase().endsWith(x));
  const endOf = (a) => (a.last.startsWith('/') ? a.last : `/${a.last}`).replace(/\/$/, '');
  let joins = 0;
  // `end` joined by a slash with the first line of every part not in `used`; a join that still wants a child (a private
  // path cut at a slash, `.config/gh`) is joined again, up to JOIN_PARTS_MAX parts.
  const joined = (end, used) => {
    for (const [j, b] of parts.entries()) {
      if (used.includes(j) || !b.first) continue;
      if (++joins > SECRET_WALK_MAX) return true;
      const path = `${end}/${b.first}`.replace(/\/{2,}/g, '/');
      if (namesSecretPath(path, privatePaths)) return true;
      const cut = path.replace(/\/$/, '');
      if (used.length < JOIN_PARTS_MAX - 1 && (JOIN_GH_DIR.test(cut) || wantsChild(cut)) && joined(cut, [...used, j])) return true;
    }
    return false;
  };
  for (const [i, a] of parts.entries()) {
    const end = endOf(a);
    if ((JOIN_DIR.test(end.split('/').slice(-2).join('/')) || wantsChild(end)) && joined(end, [i])) return true;
  }
  // A part that is a secret path under a root (`.config/gh/hosts.yml`) is joined with every part that is a path.
  const roots = parts.flatMap((a, i) => (JOIN_ROOT.test(a.last) ? [i] : []));
  if (!roots.length) return false;
  for (const [j, b] of parts.entries()) {
    if (!b.first || !SECRET_PATH.test(`/${b.first}`)) continue;
    for (const i of roots) {
      if (i === j) continue;
      if (++joins > SECRET_WALK_MAX) return true;
      if (namesSecretPath(`${endOf(parts[i])}/${b.first}`, privatePaths)) return true;
    }
  }
  return false;
}

// The output files that calls started with run_in_background name in their results ("Output is being written to:
// <file>", "output_file: <file>"), for calls on secret or private paths (`secret`) and for prose calls naming one
// (`held`): a later Read, `tail` or `cat` of such a file reads that call's output. A file is a word of the first
// OUTPUT_SCAN_CHARS of the result with at least two slashes (not a host hint such as `/tasks`, a directory or a
// URL); it is kept whole and by its name (6 characters or more, for `cd <dir> && cat <name>` or `$D/<name>`), every one
// of them, with runs of slashes joined and in lower case.
const OUTPUT_SCAN_CHARS = 4096;
function backgroundOutputFiles(messages, privatePaths) {
  const results = new Map();
  for (const m of messages) if (m.role === 'user') for (const r of m.toolResults || []) results.set(r.tool_use_id, r.text || '');
  const out = { secret: new Set(), held: new Set() };
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const u of m.toolUses || []) {
      if (u.input?.run_in_background !== true || !results.has(u.tool_use_id)) continue;
      const list = touchesSecretPath(u.tool, u.input, privatePaths) ? out.secret : PROSE_TOOLS.has(u.tool) && anySecretPath(u.input, privatePaths) ? out.held : undefined;
      if (!list) continue;
      for (const w of results.get(u.tool_use_id).slice(0, OUTPUT_SCAN_CHARS).split(/[\s"'`|;&<>()[\]{},=]+/)) {
        const file = w.replace(/[.:]+$/, '').replace(/[\\/]+/g, '/').toLowerCase();
        if (file.includes('://') || file.endsWith('/') || (file.match(/\//g) || []).length < 2) continue;
        const name = file.slice(file.lastIndexOf('/') + 1);
        for (const f of name.length >= 6 ? [file, name] : [file]) list.add(f);
      }
    }
  }
  return { secret: fileIndex(out.secret), held: fileIndex(out.held) };
}
// Does a string of the input name one of the files as a whole name (not a part of a longer name or path)? The files
// are kept by the run of name characters they end with; where such a file ends, that run is the whole run of name
// characters of the input, so each string is read once however many files there are. A file that does not end with a
// name character is searched for whole.
const FILE_NAME_CHAR = /[a-z0-9_.-]/;
function fileIndex(files) {
  const byRun = new Map();
  const other = [];
  for (const f of files) {
    let k = f.length;
    while (k > 0 && FILE_NAME_CHAR.test(f[k - 1])) k--;
    if (k === f.length) other.push(f);
    else {
      const run = f.slice(k);
      if (byRun.has(run)) byRun.get(run).push(f);
      else byRun.set(run, [f]);
    }
  }
  return { byRun, other, size: files.size };
}
function readsFile(input, files) {
  if (!files.size) return false;
  const wholeAt = (text, f, i) => {
    const after = text[i + f.length];
    return (i === 0 || !FILE_NAME_CHAR.test(text[i - 1])) && (after === undefined || !(FILE_NAME_CHAR.test(after) || after === '/'));
  };
  const names = (text) => {
    for (const f of files.other) for (let i = text.indexOf(f); i >= 0; i = text.indexOf(f, i + 1)) if (wholeAt(text, f, i)) return true;
    let start = 0;
    for (let p = 0; p <= text.length; p++) {
      if (p < text.length && FILE_NAME_CHAR.test(text[p])) continue;
      if (p > start && text[p] !== '/') for (const f of files.byRun.get(text.slice(start, p)) ?? []) if (p >= f.length && text.startsWith(f, p - f.length) && wholeAt(text, f, p - f.length)) return true;
      start = p + 1;
    }
    return false;
  };
  let hit = false;
  try {
    JSON.stringify(input ?? {}, (_k, v) => { if (!hit && typeof v === 'string' && names(v.replace(/[\\/]+/g, '/').toLowerCase())) hit = true; return v; });
  } catch { return true; }
  return hit;
}

function touchesSecretPath(tool, input, privatePaths) {
  if (!input || typeof input !== 'object') return false;
  const values = [];
  for (const f of [...PATH_FIELDS, ...(TOOL_PATH_FIELDS[tool] || [])]) if (typeof input[f] === 'string') values.push(input[f]);
  if (Array.isArray(input.paths)) for (const p of input.paths) if (typeof p === 'string') values.push(p);
  if (typeof input.url === 'string' && /^file:/i.test(input.url)) values.push(input.url);
  if (values.some((v) => namesSecretPath(v, privatePaths))) return true;
  if (NAMED_FIELD_TOOLS.has(tool) || PROSE_TOOLS.has(tool)) return false;
  return anySecretPath(input, privatePaths);
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

// The text from the point `starts` accepts: past the wrapper that opens it (also the envelope build
// writes around a block) and past the complete reminders before it; undefined when none does.
function bodyOf(text, starts) {
  let t = text;
  for (let k = 0; k <= PRELUDES_MAX; k++) {
    const body = t.replace(DELIVERY_WRAP, '');
    if (starts(body)) return body;
    const prelude = DELIVERY_PRELUDE.exec(t);
    if (!prelude) return undefined;
    t = t.slice(prelude[0].length);
  }
  return undefined;
}
const startsFrame = (t) => t.startsWith(QUEUED_PREFIX) || OTHER_FRAME.test(t.split('\n', 1)[0]) || DELIVERY_OPENERS.some((p) => t.startsWith(p));
const startsNote = (t) => DELIVERY_NOTES.some((k) => t.startsWith(k));

// The frame a text opens with, after an optional <system-reminder ...> wrapper and complete reminders: 'user',
// 'other' (another session, agent, coordinator, plugin, teammate) or undefined.
function frameOf(text) {
  const body = bodyOf(text, startsFrame);
  if (body === undefined) return undefined;
  return body.startsWith(QUEUED_PREFIX) ? 'user' : 'other';
}

// What a text block delivered with the results is: 'user', 'other' (another session, agent,
// coordinator, plugin, teammate, task notification) or undefined (a reminder that may go).
function deliveryOf(text) {
  if (typeof text !== 'string') return undefined;
  return frameOf(text) || (bodyOf(text, startsNote) !== undefined ? 'other' : undefined);
}

// A row's own text that opens with a delivered message: a frame, or a task notification's marker (after an
// optional wrapper). A prompt that quotes the marker further on stays the user's.
const opensDelivery = (text) => frameOf(text) || bodyOf(text, startsNote) !== undefined;

// The envelopes of a text, in order: {from, to, text}. Read from the end, each closing tag with the
// last opener of its id before it, so an envelope build appended (whose id nothing before it holds)
// is found whole even when it quotes a closing tag that an opener without its closing tag earlier in
// the text would take, and a quoted envelope inside one stays inside it. An unpaired tag is text.
// The openers are indexed in one pass and each closing tag reads only its own id, so a text full of
// unpaired tags (a truncated transcript pasted in) is read in linear time.
function envelopesOf(text) {
  const openers = new Map();
  for (const o of text.matchAll(ENVELOPE_OPEN)) { const at = openers.get(o[1]); if (at) at.push(o.index); else openers.set(o[1], [o.index]); }
  const found = [];
  for (let end = text.length; end > 0;) {
    const close = text.lastIndexOf(ENVELOPE_CLOSE, end - 1);
    if (close < 0) break;
    ENVELOPE_ID.lastIndex = close + ENVELOPE_CLOSE.length;
    const id = ENVELOPE_ID.exec(text);
    const to = ENVELOPE_ID.lastIndex;
    const at = id && to <= end ? openers.get(id[1]) || [] : [];
    // The last opener of this id before the closing tag (the openers stand in text order).
    let lo = 0;
    for (let hi = at.length; lo < hi;) { const mid = (lo + hi) >> 1; if (at[mid] < close) lo = mid + 1; else hi = mid; }
    const open = lo > 0 ? at[lo - 1] : -1;
    if (open >= 0) found.push({ from: open, to, text: text.slice(open, to) });
    end = open >= 0 ? open : close;
  }
  return found.reverse();
}

const rawChars = (blocks) => blocks.reduce((n, t) => n + t.length, 0);

// The delivered blocks of a row (queuedOf left out the ones a row shows), and the row's text with each
// of them after it as one envelope, so that a later compaction reads it as one message whatever it
// quotes and whatever follows it. A block that is one envelope already stays as it is; another gets the
// lowest jev id that neither it nor the row's text so far holds (not the host's hex form, so the host
// leaves the envelope as text). The ids are collected in one pass over each block and the text is
// joined once, so many blocks stay linear. A copy an earlier compaction carried into the row's text
// does not hide a new delivery of the same text.
function carriedText(m, blocks = []) {
  const parts = m.text ? [m.text] : [];
  const taken = new Set();
  const note = (text) => { for (const x of text.matchAll(/id="jev-(\d+)"/g)) taken.add(x[1]); };
  note(m.text || '');
  // A row with words of its own outside its envelopes gets even a host envelope in one of ours: after such
  // text a jev envelope is what a later compaction reads as carried (userWords), a host one as a quote.
  let mixed = false;
  if (m.text && blocks.length) {
    let at = 0;
    const outside = [];
    for (const e of envelopesOf(m.text)) { outside.push(m.text.slice(at, e.from)); at = e.to; }
    outside.push(m.text.slice(at));
    mixed = outside.join('').trim() !== '';
  }
  let k = 1;
  for (const block of blocks) {
    note(block);
    const e = envelopesOf(block);
    if (!mixed && e.length === 1 && e[0].from === 0 && e[0].to === block.length) { parts.push(block); continue; }
    while (taken.has(String(k))) k++;
    taken.add(String(k));
    parts.push(`<system-reminder id="jev-${k}">\n${block}\n</system-reminder id="jev-${k}">`);
  }
  return { own: blocks, text: parts.join('\n') };
}

// The user's words in one delivered block: from the user's header to the last framing note of the
// block (the user may write the note's words too); none for a block of another sender. Nothing inside
// a block is read as a frame of its own, so a header another sender quotes is not the user's.
function blockWords(block) {
  if (frameOf(block) !== 'user') return [];
  const body = bodyOf(block, startsFrame).slice(QUEUED_PREFIX.length);
  const tail = body.lastIndexOf(QUEUED_TAIL);
  const words = (tail < 0 ? body.replace(/(?:\s*<\/system-reminder[^>]*>)+\s*$/, '') : body.slice(0, tail)).trim();
  return words ? [words] : [];
}

// The regions of a text that are quotes to the user's block around them: `opaque`, in text order and not
// overlapping, holds every paired envelope and the quotes below; `quotes` holds just those, which can hold whole
// envelopes (a delivery in one is part of the quote). A quote is a paired plain <system-reminder> that holds no
// delivery (a reminder that wraps one is read by its frame) and a paired <task-notification> (its result is
// text of a task). Opening and closing tags pair by nesting; tags inside an envelope belong to it, and a tag
// without its partner is text. The tags are indexed in one pass and nest at most QUOTE_DEPTH_MAX deep, so a
// text full of unpaired or nested tags is read in linear time.
const QUOTE_TAGS = [
  // Bounded openers: a text full of unclosed tags stays linear.
  { open: /<system-reminder(?![^>]{0,200}\bid=)[^>]{0,200}>/g, close: '</system-reminder>', quote: (t) => !deliveryOf(t) },
  { open: /<task-notification(?:\s[^>]{0,200})?>/g, close: '</task-notification>', quote: () => true },
];
const QUOTE_DEPTH_MAX = 8;
const NATIVE_NOTIFICATION = /^\s*(?:\[SYSTEM NOTIFICATION - NOT USER INPUT\]\s*)?(<task-notification(?:\s[^>]{0,200})?>)/;
const unionOf = (list) => {
  const out = [];
  for (const e of [...list].sort((x, y) => x.from - y.from)) {
    const last = out[out.length - 1];
    if (last && e.from < last.to) last.to = Math.max(last.to, e.to);
    else out.push({ from: e.from, to: e.to });
  }
  return out;
};
function opaqueOf(text, envelopes = envelopesOf(text)) {
  const found = [];
  // A row that is one native notification (it opens with the tag, maybe after its marker line, and ends with the
  // closing tag) is one quote whatever its result holds, an unbalanced tag included.
  const native = NATIVE_NOTIFICATION.exec(text);
  const tail = text.trimEnd();
  if (native && tail.endsWith(QUOTE_TAGS[1].close)) found.push({ from: native.index + native[0].length - native[1].length, to: tail.length });
  for (const tag of QUOTE_TAGS) {
    const closers = positionsOf(text, tag.close);
    if (!closers.length) continue;
    const inClose = insideOf(envelopes);
    const free = closers.filter((c) => !inClose(c));
    const inOpen = insideOf(envelopes);
    const openers = [...text.matchAll(tag.open)].filter((o) => !inOpen(o.index));
    // Tags pair by nesting (a quote can quote another), as a stack; deeper than QUOTE_DEPTH_MAX they are text.
    const stack = [];
    let over = 0; // openers skipped below a full stack: their closers are text too and pop nothing
    for (let i = 0, j = 0; j < free.length;) {
      if (i < openers.length && openers[i].index < free[j]) {
        if (stack.length < QUOTE_DEPTH_MAX) stack.push(openers[i].index);
        else over++;
        i++;
        continue;
      }
      if (over > 0) { over--; j++; continue; }
      const from = stack.pop();
      const to = free[j++] + tag.close.length;
      if (from !== undefined && tag.quote(text.slice(from, to))) found.push({ from, to });
    }
  }
  const quotes = unionOf(found);
  return { opaque: unionOf([...envelopes, ...quotes]), quotes };
}

// Whether a position lies inside one of the envelopes `spans` (in text order), after its opener; asked for in
// increasing order.
function insideOf(spans) {
  let k = 0;
  return (pos) => {
    while (k < spans.length && spans[k].to <= pos) k++;
    return k < spans.length && spans[k].from < pos;
  };
}

// The first index of the sorted list `a` whose value is at least `x`.
function lowerBound(a, x) {
  let lo = 0;
  for (let hi = a.length; lo < hi;) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

// What the user's blocks of a text read from, indexed once per text: the positions of the host's whole footer
// outside every envelope that holds a delivered message (`spans`, in text order; a footer inside one is that
// message's), and, once a block asks for it, the start of every line that opens a frame.
function blockIndex(text, spans) {
  const footers = [];
  let k = 0;
  for (const f of positionsOf(text, QUEUED_FOOTER)) {
    while (k < spans.length && spans[k].to <= f) k++;
    if (!(k < spans.length && spans[k].from <= f)) footers.push(f);
  }
  return { footers, frames: undefined };
}
function frameLines(text) {
  const out = [];
  for (let p = 0; p < text.length;) {
    const nl = text.indexOf('\n', p);
    if (frameOf(`${text.slice(p, nl < 0 ? text.length : nl)}\n`)) out.push(p);
    p = nl < 0 ? text.length : nl + 1;
  }
  return out;
}

// The end of a user's block that opens at `from` in a row's text: the end of the line of its framing
// note, the last one before the first frame (a user's header or another sender's) after its first note
// (a header the user quotes before the note stays in the block, and the user may write the note's words
// too); -1 without a note. The first note is the host's whole footer outside the envelopes when the text has
// one after `from` (`index`), so the part of it the user quotes does not end the search early. A note
// inside an envelope that holds a delivered message (`spans`, in text order) is that message's, not the user's, so a
// block stops before a carried envelope that quotes the note. Each call reads only up to that frame and skips an
// envelope in one step, so the blocks of a row stay linear. In a row rebuilt before blocks got envelopes, one user's
// block that quotes the footer word for word, all of it, and then a header has the same bytes as two blocks in a row, so
// it is read as two; rows written now keep every block in an envelope of its own.
function userBlockEnd(text, from, spans, index) {
  const inside = (i) => {
    let lo = 0;
    for (let hi = spans.length; lo < hi;) { const mid = (lo + hi) >> 1; if (spans[mid].from <= i) lo = mid + 1; else hi = mid; }
    return lo > 0 && i < spans[lo - 1].to ? spans[lo - 1] : undefined;
  };
  const f = lowerBound(index.footers, from);
  const first = f < index.footers.length ? index.footers[f] : text.indexOf(QUEUED_TAIL, from);
  if (first < 0) return -1;
  index.frames ??= frameLines(text);
  const after = first + QUEUED_TAIL.length;
  const header = text.indexOf(QUEUED_PREFIX, after);
  const limit = Math.min(header < 0 ? text.length : header, index.frames[lowerBound(index.frames, after)] ?? text.length);
  let t = text.lastIndexOf(QUEUED_TAIL, limit - QUEUED_TAIL.length);
  for (let e; t >= from && (e = inside(t)); t = text.lastIndexOf(QUEUED_TAIL, e.from - 1));
  if (t < from) return -1;
  const nl = text.indexOf('\n', t + QUEUED_TAIL.length);
  return nl < 0 ? text.length : Math.min(nl, limit);
}

// The positions of `s` in `text`, in order.
function positionsOf(text, s) {
  const out = [];
  for (let i = text.indexOf(s); i >= 0; i = text.indexOf(s, i + s.length)) out.push(i);
  return out;
}

// Text outside envelopes (a row rebuilt before carried blocks got envelopes) split at each line that
// opens a frame: one piece {text, at} per delivered message. A user's block runs to its framing note
// (userBlockEnd), so a frame line the user quotes before the note stays in it.
function piecesOf(text) {
  const pieces = [];
  const spans = opaqueOf(text).opaque; // a footer or header inside an envelope or a plain reminder is a quote to the user's block around it
  const index = blockIndex(text, spans);
  const quoted = insideOf(spans);
  const lastTail = text.lastIndexOf(QUEUED_TAIL);
  let end = -1;
  let at = 0;
  for (const line of text.split('\n')) {
    const frame = at >= end && !quoted(at) ? frameOf(`${line}\n`) : undefined;
    if (!pieces.length || frame) {
      pieces.push({ text: line, at });
      end = frame === 'user' && at < lastTail ? userBlockEnd(text, at, spans, index) : -1;
    } else pieces[pieces.length - 1].text += `\n${line}`;
    at += line.length + 1;
  }
  return pieces;
}

// The envelopes of a row's text that hold a delivered message, except one inside a user's block before
// its framing note: that one is a quote the user pasted and stays in their block.
function deliveredOf(text) {
  const envelopes = envelopesOf(text);
  const { opaque, quotes } = opaqueOf(text, envelopes); // quotes to the user's block around them
  const all = envelopes.filter((e) => deliveryOf(e.text));
  const index = blockIndex(text, opaque);
  const quoted = insideOf(opaque);
  const inQuote = insideOf(quotes); // a delivery pasted into a plain reminder is part of that quote
  const lastTail = text.lastIndexOf(QUEUED_TAIL);
  const out = [];
  let end = -1;
  let k = 0;
  for (let p = 0; p < text.length;) {
    if (k < all.length && all[k].from <= p) {
      if (all[k].from >= end && !inQuote(all[k].from)) { out.push(all[k]); p = Math.max(p, all[k].to); }
      k++;
      continue;
    }
    const nl = text.indexOf('\n', p);
    const stop = Math.min(nl < 0 ? text.length : nl, k < all.length ? all[k].from : text.length);
    if (p >= end && p < lastTail && !quoted(p) && frameOf(`${text.slice(p, stop)}\n`) === 'user') end = userBlockEnd(text, p, opaque, index);
    p = stop === nl ? nl + 1 : stop;
  }
  return out;
}

// The user's own words in a message: none for host notices and summaries; host blocks inside a
// message are cut out. A delivered message counts only as a whole block, by its opening frame (one
// rule): each envelope of the text that holds a delivered message (the host's, or one a row rebuilt
// by an earlier compaction carries; deliveredOf), and the text outside them, read by its pieces (piecesOf) when it
// opens with a delivered message (opensDelivery) or the row holds results. A result row's own text
// gives words only so. An envelope counts as carried only in such a row or in one whose text outside
// the envelopes gives no words of the user (build carries blocks only into result rows); in a prompt
// the user typed it is a quote they pasted.
function userWords(m) {
  if (m.role !== 'user' || !m.text) return [];
  const delivered = deliveredOf(m.text);
  // The text outside the envelopes, as the parts between them, each with where it stands in the row.
  const outside = [];
  let at = 0;
  for (const e of delivered) { outside.push({ from: at, text: m.text.slice(at, e.from) }); at = e.to; }
  outside.push({ from: at, text: m.text.slice(at) });
  const own = outside.map((o) => o.text).join('\n').trim();
  if (opensDelivery(own) || (m.toolResults && m.toolResults.length)) {
    // Every message in the order it stands in the row, a legacy one (outside the envelopes) and an enveloped one alike.
    const found = delivered.map((e) => ({ at: e.from, words: blockWords(e.text) }));
    for (const o of outside) for (const p of piecesOf(o.text)) found.push({ at: o.from + p.at, words: blockWords(p.text) });
    return found.sort((x, y) => x.at - y.at).flatMap((f) => f.words);
  }
  const text = own.replace(HOST_BLOCK, '').trim();
  const carried = delivered.flatMap((e) => blockWords(e.text));
  if (!text || HOST_BLOCK_OPEN.test(text) || NOT_USER_PREFIXES.some((p) => text.startsWith(p))) return carried;
  // A prompt the user typed: an envelope in it is a quote they pasted, so the whole prompt is theirs. Except
  // the jev envelopes build appends at the end of a row it rebuilt from a result row (it has a toolResults list,
  // whatever it holds; a result row keeps its own text before them): those stay messages of their senders.
  let cut = m.text.length;
  if (Array.isArray(m.toolResults)) for (let k = delivered.length - 1; k >= 0 && /^<system-reminder id="jev-\d+">/.test(delivered[k].text) && !m.text.slice(delivered[k].to, cut).trim(); k--) cut = delivered[k].from;
  const typed = m.text.slice(0, cut).replace(HOST_BLOCK, '').trim();
  return [...(typed ? [typed] : []), ...delivered.filter((e) => e.from >= cut).flatMap((e) => blockWords(e.text))];
}

// Messages delivered during a tool turn that the API form shows and `messages` does not (deliveryOf):
// row -> its blocks, word for word, with the counts by kind; null without the API form (they cannot
// be seen then). A block belongs to the row the host wrote the attachment after, whose handle brings
// it back: the row of the result or of the shown text that stands last before the block in its API
// message (the API form keeps the order of the rows it joins, so with parallel results in rows of
// their own that is the result before it, and a row shown after the results, such as an
// interruption notice, takes the blocks after its text). A block is shown already only by the row at
// its position in the API form (matchShown).
function queuedOf(messages, api) {
  if (!api) return null;
  const rows = new Map();
  const counts = { user: 0, other: 0 };
  const rowOfResult = new Map();
  // The rows of one API message are a run of consecutive user rows (the host joins them): `runStart` is
  // the first row of the run that holds a row, `runs` the first row of every run.
  const runStart = [];
  const runs = [];
  messages.forEach((m, i) => {
    if (m.role !== 'user') { runStart.push(-1); return; }
    if (i > 0 && messages[i - 1].role === 'user') runStart.push(runStart[i - 1]);
    else { runStart.push(i); runs.push(i); }
    for (const r of m.toolResults || []) if (!rowOfResult.has(r.tool_use_id)) rowOfResult.set(r.tool_use_id, i);
  });
  // The first row at or after each index that the API form shows a block of (text or results), or an
  // assistant row, which ends a user message; messages.length when none.
  const nextAt = new Array(messages.length + 1).fill(messages.length);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    nextAt[i] = m.role !== 'user' || m.text || (m.toolResults || []).length ? i : nextAt[i + 1];
  }
  // For a text-only row: how many text-only rows with the same text follow it before the next row with
  // results (the rows of one stretch of the API message, between two results).
  const rowsAfter = new Array(messages.length).fill(0);
  const seenRows = new Map();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || (m.toolResults || []).length) seenRows.clear();
    else if (m.text) { rowsAfter[i] = seenRows.get(m.text) || 0; seenRows.set(m.text, rowsAfter[i] + 1); }
  }
  const shown = new Set();
  // The API form joins the rows of one message in order, each row's results before its text. So a text
  // block at row `at` (the row of the block before it; before the first one, the message starts at row
  // `lead`) is shown by that row's own text not matched yet, or by the next row when that row has text
  // and no results; otherwise no row shows it. The same text elsewhere (a block an earlier compaction
  // carried, a repeated "continue") is another delivery, and two rows with the same text show two blocks.
  // After a row (`at` set), a block that more blocks of its stretch repeat than text-only rows follow the next
  // row is not shown by it: the last block with that text is (`later` counts the blocks after it), the earlier
  // ones are deliveries of the row before, which stand before the shown one (a duplicate carried at worst, never
  // one lost). Before the first block nothing owns a delivery, so the first block with that text is the row's.
  const matchShown = (at, text, lead, later) => {
    if (at !== undefined && !shown.has(at) && messages[at].text === text) return at;
    const k = nextAt[at === undefined ? lead : at + 1];
    const m = messages[k];
    return m && m.role === 'user' && !(m.toolResults || []).length && m.text === text && (at === undefined || later <= rowsAfter[k]) ? k : undefined;
  };
  // A message without results is matched to the run of rows at its place in the order (when both lists
  // hold the same number of them; a user message with a plain string counts, only the blocks of an array
  // are read): a kept notice row can own a delivery after its result was traced.
  const users = api.filter((a) => a.role === 'user');
  let ordinal = -1;
  for (const a of users) {
    ordinal++;
    if (!Array.isArray(a.content)) continue;
    let row;
    let results = false;
    for (const b of a.content) {
      if (b?.type !== 'tool_result') continue;
      results = true;
      if (rowOfResult.has(b.tool_use_id)) row = Math.max(row ?? 0, rowOfResult.get(b.tool_use_id));
    }
    const lead = row !== undefined ? runStart[row] : !results && runs.length === users.length ? runs[ordinal] : undefined;
    if (lead === undefined) continue;
    // For each text block, how many blocks with the same text follow it before the next result.
    const later = new Array(a.content.length).fill(0);
    const seen = new Map();
    for (let p = a.content.length - 1; p >= 0; p--) {
      const b = a.content[p];
      if (b?.type === 'tool_result') seen.clear();
      else if (b?.type === 'text' && typeof b.text === 'string') { later[p] = seen.get(b.text) || 0; seen.set(b.text, later[p] + 1); }
    }
    let anchor = row;
    let at;
    for (const [p, b] of a.content.entries()) {
      if (b?.type === 'tool_result' && rowOfResult.has(b.tool_use_id)) at = anchor = rowOfResult.get(b.tool_use_id);
      if (b?.type !== 'text') continue;
      const r = matchShown(at, b.text, lead, later[p]);
      if (r !== undefined) {
        shown.add(r);
        at = anchor = r;
        continue;
      }
      const kind = deliveryOf(b.text);
      if (!kind || anchor === undefined) continue;
      if (!rows.has(anchor)) rows.set(anchor, []);
      rows.get(anchor).push(b.text);
      counts[kind]++;
    }
  }
  return { rows, ...counts };
}

// The task for the state: the /compact instructions first, then the last USER_MESSAGES user
// messages, together USER_CHARS characters. A message the user typed during a tool turn (queuedOf)
// counts as one, after its row; other delivered messages do not. The part of each that is cleaned, as written
// (`mention`, in lower case; an omitted line can let a later line into the budget), is only matched against the
// results the user names (markMentioned) and is never sent.
function userTask(messages, instructions, queued = new Map(), privatePaths = []) {
  let left = USER_CHARS;
  const clean = (text) => maskSecrets(omitSecretLines(text, privatePaths));
  const mention = [];
  const raw = instructions ? headPart(String(instructions), left + MASK_SLACK_CHARS) : '';
  const instr = instructions ? clip(clean(raw), left) : undefined;
  if (instr) {
    mention.push(raw);
    left -= instr.length;
  }
  const picked = [];
  for (let i = messages.length - 1; i >= 0 && picked.length < USER_MESSAGES && left > 0; i--) {
    const words = [...userWords(messages[i]), ...(queued.get(i) || []).flatMap(blockWords)];
    for (let k = words.length - 1; k >= 0 && picked.length < USER_MESSAGES && left > 0; k--) {
      const part = headPart(words[k], left + MASK_SLACK_CHARS);
      const text = clip(clean(part), left);
      picked.unshift(text);
      mention.push(part);
      left -= text.length;
    }
  }
  return { task: picked, instructions: instr, mention: mention.join('\n').toLowerCase() };
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
  // A file name starts only where a token starts (the same matches: from inside a token the pattern read on to the
  // token's end, quadratic on a long token), and runs of slashes are joined before the trailing one is cut.
  if (typeof i.command === 'string') for (const m of i.command.matchAll(/(?<![^\s"'`|;&<>()])[^\s"'`|;&<>()]+\.[A-Za-z0-9]{1,6}\b|https?:\/\/[^\s"'`]+/g)) out.add(m[0]);
  const names = new Set();
  for (const t of out) {
    if (/^https?:/i.test(t)) names.add(t.toLowerCase());
    const base = t.replace(/[\\/]+/g, '/').replace(/\/$/, '').split('/').pop().toLowerCase();
    if (base.length >= MENTION_MIN) names.add(base);
  }
  return names;
}
function mentions(text, name) {
  return new RegExp(`(?:^|[\\s"'\`(<\\[/\\\\=:])${escapeRegExp(name)}(?=$|[\\s"'\`)>\\],.;:!?])`).test(text);
}
function markMentioned(candidates, user) {
  const text = user.mention;
  let n = 0;
  for (const c of candidates) {
    if (c.secret || !c.textOnly) continue;
    for (const name of targetsOf(c.use.input)) {
      if (text.includes(name) && mentions(text, name)) { c.score = Math.max(c.score, 1); c.asked = true; n++; break; }
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
  const outputs = backgroundOutputFiles(messages, privatePaths);
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
        id: r.tool_use_id, resIdx: i, useIdx: found.i, use: found.u, res: r,
        summary: inputSummary(found.u.tool, found.u.input),
        inputChars: (found.u.tool || '').length + inputJson(found.u.input).length,
        resultChars: (r.text || '').length,
        secret: touchesSecretPath(found.u.tool, found.u.input, privatePaths) || readsFile(found.u.input, outputs.secret),
        proseSecret: (PROSE_TOOLS.has(found.u.tool) && anySecretPath(found.u.input, privatePaths)) || readsFile(found.u.input, outputs.held),
        taskOutput: OUTPUT_TOOLS.has(found.u.tool),
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
// not longer than its trace and the task list stay whole. `added`: characters the built list adds
// whatever is decided (the envelopes of carried messages).
function allocate(candidates, before, target, added = 0) {
  const fixed = before + added - candidates.reduce((s, c) => s + c.fullCost - c.traceCost, 0);
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

// Claude Code writes one transcript row per content block, so one API message is several assistant
// rows sharing a message.id. On `--resume` the host joins the assistant rows of one message.id from
// the whole transcript, rows from before the compact boundary included, and repeats every block of
// them but tool_use (measured on Claude Code 2.1.321: a repeated server_tool_use fails the request
// with API 400 "server_tool_use ids must be unique per assistant turn", and a call that became a trace
// comes back without its result). Before a request it joins the rows of one message.id the same way
// (also across result-only user rows: a streamed tool run puts a result between rows of one message)
// and then needs every call's result in the next message. A row kept by its handle is written after
// the boundary with its message.id, one built without a handle gets a new one. So the rows of one API
// message are rebuilt together: one message with their text, traces and kept calls, the result rows
// after it (groupsOf, build). Only the last message with calls keeps its rows' handles, when the
// conversation ends inside its tool loop (the API wants that message to begin with its thinking,
// which a built message cannot carry); between turns no assistant row keeps its handle
// (openLoopStart).

// Rows of one API message: consecutive assistant rows; an assistant row after result-only user rows
// while a call of the group still has no result (a valid transcript starts a new message only once
// every call has its result); and, with the API form, groups whose calls belong to one API message (a
// call whose result came back quickly). A user row with text ends a group, as it ends the host's
// joining. Returns the group of every row (-1 for user rows).
function groupsOf(messages, api) {
  const groupOf = new Array(messages.length).fill(-1);
  const parent = [];
  let cur = -1;
  let prevAssistant = false;
  let open = new Set();
  messages.forEach((m, i) => {
    if (m.role === 'assistant') {
      if (cur < 0 || !(prevAssistant || open.size)) { cur = parent.length; parent.push(cur); open = new Set(); }
      groupOf[i] = cur;
      for (const u of m.toolUses || []) open.add(u.tool_use_id);
      prevAssistant = true;
      return;
    }
    prevAssistant = false;
    const results = m.toolResults || [];
    if (m.text || !results.length) { cur = -1; open = new Set(); return; }
    for (const r of results) open.delete(r.tool_use_id);
  });
  const find = (g) => { while (parent[g] !== g) g = parent[g] = parent[parent[g]]; return g; };
  if (Array.isArray(api)) {
    const groupOfUse = new Map();
    messages.forEach((m, i) => { if (m.role === 'assistant') for (const u of m.toolUses || []) if (!groupOfUse.has(u.tool_use_id)) groupOfUse.set(u.tool_use_id, groupOf[i]); });
    for (const a of api) {
      if (!a || a.role !== 'assistant' || !Array.isArray(a.content)) continue;
      const gs = a.content.filter((b) => b && b.type === 'tool_use' && groupOfUse.has(b.id)).map((b) => find(groupOfUse.get(b.id)));
      // Joined only across result-only user rows (a user row with text ends the host's joining too).
      for (const g of gs.slice(1)) {
        const [x, y] = [find(gs[0]), find(g)].sort((p, q) => p - q);
        if (x !== y && sameRun(messages, groupOf, find, x, y)) parent[y] = x;
      }
    }
  }
  return messages.map((m, i) => (groupOf[i] < 0 ? -1 : find(groupOf[i])));
}

// Whether groups x < y stand in one stretch of the conversation with only assistant rows and
// result-only user rows between them.
function sameRun(messages, groupOf, find, x, y) {
  const first = groupOf.findIndex((g) => g >= 0 && find(g) === x);
  const last = groupOf.findIndex((g) => g >= 0 && find(g) === y);
  for (let i = first + 1; i < last; i++) {
    const m = messages[i];
    if (m.role === 'user' && (m.text || !(m.toolResults || []).length)) return false;
  }
  return true;
}

// The first row that keeps its handle: the first row of the last assistant group when that group has
// calls (the conversation ends inside that message's tool loop), else messages.length (between turns,
// after a final answer without calls, every assistant row is rebuilt). User rows after that group do
// not end the loop: a message typed during the tool turn (queued, written as a separate row) joins the
// result message in the API, and the API still wants the last assistant message to begin with its
// thinking.
function openLoopStart(messages, group) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue;
    const g = group[i];
    return messages.some((x, k) => group[k] === g && (x.toolUses || []).length) ? group.indexOf(g) : messages.length;
  }
  return messages.length;
}

// Whether a delivery would be carried into a result row that stands between the kept rows of the last
// message (the rows from keepFrom on, which keep their handles). Text in a user row ends the host's joining
// of assistant rows (groupsOf), so the rows after it would become a message of their own, without the thinking
// the API wants the last message to begin with. A delivery after the last kept row of the message is fine.
function splitsTail(messages, queued, keepFrom, group) {
  let lastKept = -1;
  for (let j = messages.length - 1; j > keepFrom && lastKept < 0; j--) if (messages[j].role === 'assistant' && group[j] === group[keepFrom]) lastKept = j;
  for (const [i, blocks] of queued) {
    const m = messages[i];
    if (blocks.length && i > keepFrom && i < lastKept && (m.toolResults || []).length && m.toolResults.every(textOnlyResult)) return true;
  }
  return false;
}

// The API form of the conversation, or undefined: a list whose every entry has `content` as an array
// or a string, with at least one assistant message whose content is an array (a host that ignores
// `as: 'api'` answers the plain messages, which have neither).
function apiFormOf(value) {
  if (!Array.isArray(value) || !value.length) return undefined;
  if (!value.every((a) => a && (Array.isArray(a.content) || typeof a.content === 'string'))) return undefined;
  return value.some((a) => a.role === 'assistant' && Array.isArray(a.content)) ? value : undefined;
}

// Whether every call of the rows that keep their handles (from keepFrom on) stands in the API form.
function keptCallsIn(messages, keepFrom, api) {
  const ids = new Set();
  for (const a of api) if (a.role === 'assistant' && Array.isArray(a.content)) for (const b of a.content) if (b && b.type === 'tool_use') ids.add(b.id);
  return messages.every((m, i) => i < keepFrom || m.role !== 'assistant' || (m.toolUses || []).every((u) => ids.has(u.tool_use_id)));
}

// Blocks a kept assistant message may carry and still keep its handle: text, client calls and signed
// thinking. Anything else (redacted_thinking, or an opaque output block such as container_upload that
// serverBlocks() does not classify) runs the summary.
const KEEPABLE_TAIL_BLOCKS = new Set(['text', 'tool_use', 'thinking']);

// Whether an assistant API message of the rows that keep their handles (from keepFrom on) carries a
// block outside KEEPABLE_TAIL_BLOCKS. Those rows stand in the API form from the first message holding one of their
// calls, together with the assistant messages right before it (no user message between: one turn for
// the API, e.g. after split message ids), to the end. No such rows: false; rows whose message the API
// form does not show: true (the summary).
export function tailRedacted(messages, api, keepFrom) {
  if (keepFrom >= messages.length) return false;
  const ids = new Set();
  for (let i = keepFrom; i < messages.length; i++) for (const u of messages[i].toolUses || []) ids.add(u.tool_use_id);
  const holds = (a) => a && a.role === 'assistant' && Array.isArray(a.content) && a.content.some((b) => b && b.type === 'tool_use' && ids.has(b.id));
  let first = Array.isArray(api) ? api.findIndex(holds) : -1;
  if (first < 0) return true;
  while (first > 0 && api[first - 1] && api[first - 1].role === 'assistant') first--;
  return api.slice(first).some((a) => a && a.role === 'assistant' && Array.isArray(a.content) && a.content.some((b) => !b || !KEEPABLE_TAIL_BLOCKS.has(b.type)));
}

// A block the API runs itself: server_tool_use, mcp_tool_use and their results
// (advisor_tool_result, web_search_tool_result, ...).
const isServerBlock = (b) => Boolean(b) && typeof b.type === 'string' && b.type !== 'tool_use' && b.type !== 'tool_result' && /_tool_(?:use|result)$/.test(b.type);

// Assistant API messages with a server block, and whether one stands among the rows that keep their
// handles (from keepFrom on). An API message is placed by its first call's row, else by a text block
// equal to the text of a row at or after the row of the API message before it (a cursor in order); one
// placed nowhere takes the row of the next placed message and counts as kept when that row is at or
// after keepFrom (or, with none following, when any row keeps its handle). Without the API form
// nothing is counted (count null).
function serverBlocks(messages, api, keepFrom) {
  if (!api) return { count: null, inTail: false };
  const rowOfUse = new Map();
  messages.forEach((m, i) => { if (m.role === 'assistant') for (const u of m.toolUses || []) if (!rowOfUse.has(u.tool_use_id)) rowOfUse.set(u.tool_use_id, i); });
  const placed = [];
  let cursor = 0;
  for (const a of api) {
    if (!a || a.role !== 'assistant' || !Array.isArray(a.content)) continue;
    let row;
    for (const b of a.content) if (b && b.type === 'tool_use' && rowOfUse.has(b.id)) { row = rowOfUse.get(b.id); break; }
    if (row === undefined) {
      const texts = a.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text).map((b) => b.text);
      for (let i = cursor; i < messages.length && texts.length; i++) if (messages[i].role === 'assistant' && texts.includes(messages[i].text)) { row = i; break; }
    }
    if (row !== undefined) cursor = Math.max(cursor, row);
    placed.push({ row, server: a.content.some(isServerBlock) });
  }
  let next;
  for (let k = placed.length - 1; k >= 0; k--) { if (placed[k].row === undefined) placed[k].row = next; else next = placed[k].row; }
  let count = 0;
  let inTail = false;
  for (const p of placed) {
    if (!p.server) continue;
    count++;
    if (p.row === undefined ? keepFrom < messages.length : p.row >= keepFrom) inTail = true;
  }
  return { count, inTail };
}

// A user message with tool results kept by its engine handle is written after the compact boundary
// with its original parent, which points before the boundary, so `--resume` (and every `-p` turn)
// rebuilt the conversation from before the compaction (measured on Claude Code 2.1.318). Such a
// message is therefore rebuilt from its own text, unchanged for the model, whenever all its results
// are text. A message with an image or another non-text result in the last KEEP_LAST messages keeps
// its handle (counted in kept_handle) and has that limit. Every assistant row before `keepFrom` is
// rebuilt (text, traces and kept calls; thinking and server blocks dropped, an empty row removed) into
// the one message of its group (groupsOf), placed at the group's first row with content, so the result
// rows that follow pair with it and the host gives it a new message.id; from keepFrom on
// (openLoopStart) the rows keep their handles.
function build(messages, candidates, keepFrom, group, stats, queued = new Map()) {
  const byId = new Map();
  for (const c of candidates) byId.set(c.id, c);
  const out = [];
  stats.rebuiltUnchanged = 0;
  stats.keptHandle = 0;
  stats.rebuiltAssistant = 0;
  stats.droppedAssistant = 0;
  stats.joinedRows = 0;
  stats.queuedCarried = 0;
  stats.queuedKeptChars = 0;
  const merged = new Map();
  for (const [i, m] of messages.entries()) {
    if (m.role === 'assistant' && i < keepFrom) {
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
      const at = merged.get(group[i]);
      if (at !== undefined) {
        const t = out[at];
        out[at] = { role: 'assistant', text: [t.text, text].filter(Boolean).join('\n'), toolUses: [...t.toolUses, ...kept] };
        stats.joinedRows++;
        continue;
      }
      merged.set(group[i], out.length);
      out.push({ role: 'assistant', text, toolUses: kept });
      continue;
    }
    if (m.role === 'user' && (m.toolResults || []).length) {
      const changed = m.toolResults.some((r) => byId.has(r.tool_use_id) && byId.get(r.tool_use_id).keep !== 'full');
      if (!changed && !m.toolResults.every(textOnlyResult)) {
        stats.keptHandle++;
        stats.queuedKeptChars += rawChars(carriedText(m, queued.get(i)).own);
        out.push(m);
        continue;
      }
      const results = [];
      for (const r of m.toolResults) {
        const c = byId.get(r.tool_use_id);
        if (c && c.keep === 'trace') continue;
        if (c && c.keep === 'short') results.push({ tool_use_id: r.tool_use_id, text: shortText(c), isError: Boolean(r.isError) });
        else if (textOnlyResult(r)) results.push({ tool_use_id: r.tool_use_id, text: r.text || '', isError: Boolean(r.isError) });
        else results.push({ tool_use_id: r.tool_use_id, text: '[non-text result (image or file) removed at compaction]', isError: Boolean(r.isError) });
      }
      if (!changed) stats.rebuiltUnchanged++;
      // A message delivered after this row goes with the rebuilt row, in its own envelope (a row that
      // keeps its handle brings it back itself).
      const { own, text } = carriedText(m, queued.get(i));
      stats.queuedCarried += own.length;
      if (!results.length && !text) continue;
      out.push({ role: 'user', text, toolUses: [], toolResults: results });
      continue;
    }
    // A row kept as it is gets the messages delivered after it back from the host.
    if (m.role === 'user') stats.queuedKeptChars += rawChars(carriedText(m, queued.get(i)).own);
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
  const orphanResults = new Set();
  for (const m of messages) {
    for (const u of m.toolUses || []) { open.add(u.tool_use_id); seen.add(u.tool_use_id); }
    for (const r of m.toolResults || []) {
      if (!seen.has(r.tool_use_id)) orphanResults.add(r.tool_use_id);
      open.delete(r.tool_use_id);
    }
  }
  return { orphanResults, openCalls: open };
}
// Pairing as the host checks it before a request (measured on Claude Code 2.1.321). The host joins
// consecutive user rows, and joins an assistant row to an earlier assistant message of the same
// message.id while only result-only user rows stand between them; then every call of assistant
// message k needs its result in message k + 1, else the host puts "[Tool result missing due to
// internal error]" in its place and drops the real result. A row a hook built gets a new message.id,
// so it joins nothing; the rows with the engine's handle since the last user row with text are taken
// as one message, also across a built assistant row (the host keeps joining by message.id past it).
// Returns the ids of calls without a result in the next message (`u:<id>`) and of results without a
// call in the previous one (`r:<id>`).
function adjacencyBreaks(messages) {
  const msgs = [];
  let run = -1;
  for (const m of messages) {
    if (m.role === 'assistant') {
      const uses = (m.toolUses || []).map((u) => u.tool_use_id);
      if (m.handle && run >= 0) { msgs[run].uses.push(...uses); continue; }
      msgs.push({ role: 'assistant', uses });
      if (m.handle) run = msgs.length - 1;
      continue;
    }
    const results = (m.toolResults || []).map((r) => r.tool_use_id);
    if (m.text || !results.length) run = -1;
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'user') last.results.push(...results);
    else msgs.push({ role: 'user', results });
  }
  const breaks = new Set();
  const seen = new Set();
  msgs.forEach((mm, k) => {
    if (mm.role !== 'assistant') return;
    const uses = mm.uses.filter((id) => !seen.has(id));
    for (const id of uses) seen.add(id);
    const next = msgs[k + 1];
    if (!next) return;
    const got = new Set(next.role === 'user' ? next.results : []);
    for (const id of uses) if (!got.has(id)) breaks.add(`u:${id}`);
    for (const id of got) if (!mm.uses.includes(id)) breaks.add(`r:${id}`);
  });
  return breaks;
}
const subset = (x, y) => [...x].every((id) => y.has(id));
// Every break of the built list (by id) is already a break of the list the host handed over.
export function pairingOk(original, built) {
  const a = pairing(original);
  const b = pairing(built);
  return subset(b.orphanResults, a.orphanResults) && subset(b.openCalls, a.openCalls) && subset(adjacencyBreaks(built), adjacencyBreaks(original));
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

// The characters build adds in envelopes to the rows it rebuilds: a result row whose results are all text,
// or one with a result that may change (a candidate); a row kept by its handle gets its blocks back as they were.
function envelopeChars(messages, queued, candidates) {
  const changing = new Set(candidates.map((c) => c.resIdx));
  let envelopes = 0;
  for (const [i, blocks] of queued) {
    const m = messages[i];
    if (!(m.toolResults || []).length || !(m.toolResults.every(textOnlyResult) || changing.has(i))) continue;
    const c = carriedText(m, blocks);
    envelopes += c.text.length - (m.text || '').length - rawChars(c.own);
  }
  return envelopes;
}

// Decides one compaction: {messages} to install or {fallback: reason}. Fills `record`; never calls next.
async function decide($, e, cfg, record, started) {
  const messages = Array.isArray(e.messages) ? e.messages : [];
  let before = messages.reduce((s, m) => s + messageChars(m), 0);
  record.chars_before = before;
  if (messages.length <= KEEP_LAST + 1) return { fallback: 'too_few_messages' };
  // The rows of one API message are rebuilt together (groupsOf); only the last message of an open tool
  // loop keeps its handles, and then the API form has to hold every call of it: without it a call whose
  // result came back quickly starts a group of its own, and that message would be split.
  const asApi = e.agentId === undefined ? { as: 'api' } : { as: 'api', agentId: e.agentId };
  const apiRead = await withDeadline($, Promise.resolve().then(() => $.session.messages(asApi)), HOST_MS);
  let api = apiFormOf(apiRead.value);
  const group = groupsOf(messages, api);
  const keepFrom = openLoopStart(messages, group);
  if (api && !keptCallsIn(messages, keepFrom, api)) api = undefined;
  record.kept_from = messages.length - keepFrom;
  // Delivered messages no row shows are part of the context too (build carries them, a kept row gets
  // them back from the host), so they count in the characters before and in the budget as fixed text,
  // with the envelopes build adds. Their counts go into the record of every later outcome.
  const delivered = queuedOf(messages, api);
  Object.assign(record, { queued_user: delivered ? delivered.user : null, queued_other: delivered ? delivered.other : null });
  // A read that timed out or failed leaves the delivered messages unknown, between turns too: a rebuilt
  // row would drop one that only the API form holds (a host that answers another shape is a different case).
  if (!api && (keepFrom < messages.length || !('value' in apiRead))) return { fallback: 'no_api_form' };
  const queued = delivered ? delivered.rows : new Map();
  for (const blocks of queued.values()) before += rawChars(blocks);
  record.chars_before = before;
  const server = serverBlocks(messages, api, keepFrom);
  record.server_blocks = server.count;
  if (server.inTail) return { fallback: 'server_block_in_tail' };
  // A kept row with neither text nor calls is thinking (server blocks are caught above); such rows keep
  // their handles like the other rows of the open loop. On `--resume` the host may join them with their
  // copies from before the boundary, so the last assistant message carries each signed thinking block
  // twice. The API takes that (measured on Claude Code 2.1.322, Opus 5.5: a resumed request whose last
  // assistant message held 6 thinking blocks, each signature two or three times, before its tool results
  // and the host's "Continue from where you left off." was answered without an error). Redacted thinking
  // was never tested, so a redacted_thinking block in an API message of those rows still runs the
  // summary, also without a thinking-only row (the block may share a row with text or a call). Should a
  // resumed request fail with 400 after a record with kept_thinking > 0, returning the summary whenever
  // keptThinking > 0 restores the earlier rule.
  const keptThinking = messages.filter((m, i) => i >= keepFrom && m.role === 'assistant' && m.handle && !m.text && !(m.toolUses || []).length).length;
  record.kept_thinking = keptThinking;
  if (tailRedacted(messages, api, keepFrom)) return { fallback: 'thinking_in_tail' };
  // The host restores a delivery after a row that keeps its handle, but a result row that is rebuilt carries it as
  // text, which would split the kept message: the summary runs instead.
  if (splitsTail(messages, queued, keepFrom, group)) return { fallback: 'queued_in_tail' };
  // Results of the calls that keep their handles stay whole (a built row may not stand among them).
  const candidates = findCandidates(messages, cfg.privatePaths).filter((c) => c.useIdx < keepFrom);
  record.candidates = candidates.length;
  const envelopes = envelopeChars(messages, queued, candidates);
  const removable = removableChars(candidates);
  // The envelopes build adds stay in every rebuilt row, so they come off what the results can give back.
  const net = removable - envelopes;
  record.max_reduction = before ? Math.round((net / before) * 1000) / 1000 : 0;
  if (!before || net / before < MIN_REDUCTION) return { fallback: 'too_few_results' };
  const blocked = await blockedReason($, cfg, Date.now());
  if (blocked) {
    if (blocked === 'paused') Object.assign(record, { paused_until: new Date(session.pausedUntil).toISOString(), pause_reason: session.pauseReason });
    else if (blocked === 'rpm') Object.assign(record, { held: 'rpm' });
    else if (blocked === 'breaker_open') Object.assign(record, { held: 'breaker' });
    else if (blocked === 'cap') Object.assign(record, { held: 'cap' });
    return { fallback: blocked };
  }

  // Newest results first; only text results of calls outside secret paths are asked about.
  const askable = [...candidates].sort((a, b) => b.resIdx - a.resIdx).filter((c) => !c.secret && !c.proseSecret && !c.taskOutput && c.textOnly);
  record.secret_skipped = candidates.filter((c) => c.secret).length;
  // A prose call that names a secret path: its result is never sent; it stays as if its request were held back.
  record.secret_held = 0;
  for (const c of candidates) if (c.proseSecret && !c.secret && c.textOnly) { c.asked = true; c.score = UNANSWERED_SCORE; record.secret_held++; }
  // A TaskOutput result whose source task may have accessed a secret: conservatively hold it.
  record.task_output_held = 0;
  for (const c of candidates) if (c.taskOutput && !c.secret && c.textOnly) { c.asked = true; c.score = UNANSWERED_SCORE; record.task_output_held++; }
  record.non_text = candidates.filter((c) => !c.textOnly).length;
  let left = cfg.maxRequests ? cfg.maxRequests - session.requests : MAX_REQUESTS;
  if (left <= 0) {
    Object.assign(record, { asked: 0, requests: 0, held: 'cap' });
    return { fallback: 'cap' };
  }
  let asked = askable.slice(0, BATCH * Math.min(MAX_REQUESTS, left));
  record.asked = asked.length;

  const user = userTask(messages, typeof e.instructions === 'string' && e.instructions.trim() ? e.instructions : undefined, queued, cfg.privatePaths);
  const deadline = started + TOTAL_MS;
  const runs = [];
  let held;
  for (let b = 0; b * BATCH < asked.length; b++) {
    const admission = await admitRequest($, cfg, deadline);
    if (admission.skip) { held = admission.skip; break; }
    const batch = asked.slice(b * BATCH, (b + 1) * BATCH);
    const results = {};
    const questions = {};
    batch.forEach((c, k) => {
      c.question = `r${k + 1}`;
      results[c.question] = {
        tool: c.use.tool,
        input: clip(oneLine(maskSecrets(sentInputJson(c.use.input, cfg.privatePaths).slice(0, STATE_INPUT_CHARS * 4 + MASK_SLACK_CHARS))), STATE_INPUT_CHARS),
        result: maskedHeadTail(c.res.text || '', STATE_HEAD_CHARS, STATE_TAIL_CHARS, cfg.privatePaths),
        chars: c.resultChars,
        ...(c.res.isError ? { error: true } : {}),
      };
      questions[c.question] = { type: 'score', instructions: QUESTION_INSTRUCTIONS, criteria: QUESTION_CRITERIA };
    });
    const state = boundExcerpts({ task: user.task, ...(user.instructions ? { compact_instructions: user.instructions } : {}), results }, cfg.excerptChars);
    const t0 = Date.now();
    if (t0 >= deadline) { session.requests--; held = { mode: 'deadline' }; break; }
    const timeoutMs = Math.min(REQUEST_MS, deadline - t0);
    runs.push(
      withDeadline($, askJev($, cfg, state, questions), timeoutMs).then(async (r) => {
        // Shared failure bookkeeping may finish later, but cannot extend this decision's budget.
        const recording = recordSharedFailure($, cfg, { ...r, short: timeoutMs < 1000 });
        if (Date.now() < deadline) await withDeadline($, recording, deadline - Date.now());
        return { ...r, batch, ms: Date.now() - t0 };
      }),
    );
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
    else if (held.mode === 'deadline') record.held = 'deadline';
    else Object.assign(record, { held: 'rpm', rpm: { count: held.count, threshold: held.threshold, limit: held.limit } });
    if (!runs.length) return { fallback: held.mode === 'circuit-open' ? 'breaker_open' : held.mode === 'process-cap' ? 'cap' : held.mode === 'deadline' ? 'timeout' : 'rpm' };
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
      // A deadline hold still records the failures of the requests that did go out.
      if (held?.mode === 'deadline') return { fallback: 'timeout' };
      return { fallback: failures.every((f) => f.kind === 'timeout') ? 'timeout' : 'jev_error' };
    }
  }
  session.failedInRow = 0;
  if (held?.mode === 'deadline') return { fallback: 'timeout' };

  record.mentioned = markMentioned(candidates, user);
  allocate(candidates, before, cfg.target, envelopes);
  const stats = {};
  const built = build(messages, candidates, keepFrom, group, stats, queued);
  if (!pairingOk(messages, built)) return { fallback: 'build_error' };
  const after = built.reduce((s, m) => s + messageChars(m), stats.queuedKeptChars);
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
    joined_rows: stats.joinedRows,
    queued_carried: stats.queuedCarried,
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
  // Any compaction of the main loop that actually replaced the messages, this module's or the built-in
  // summary, arms the own threshold's growth gate again (ownThreshold). A skip leaves the context as it
  // was, so the gate stays as it was too.
  const armGrowthGate = (out) => {
    if (e.agentId === undefined && !out?.skip) { session.growthArmed = true; session.growthBase = undefined; }
    return out;
  };
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
    if (decision.fallback || cfg.mode !== 'active') return armGrowthGate(await next(e));
    if (cfg.toast) { try { $.ui.toast(`Jev compaction: ${decision.before} -> ${decision.after} chars`); } catch { /* optional */ } }
    return armGrowthGate({ messages: decision.messages });
  } finally {
    session.compacting--;
  }
}

async function ownThreshold($, e, next) {
  const result = await next(e);
  try {
    if (e.agentId !== undefined || session.compacting > 0 || session.hostCannot) return result;
    session.turnCount++;
    // While the growth gate is armed every turn reads the usage, not only every MIN_TURNS_BETWEEN turns.
    if (!session.growthArmed && session.turnCount - session.lastAttempt < MIN_TURNS_BETWEEN) return result;
    if (!session.cachedConfig || Date.now() - session.cachedAt > CONFIG_TTL_MS) { session.cachedConfig = await readConfig($); session.cachedAt = Date.now(); }
    // The base of the growth gate is the lowest usage since the compaction: the first reading may still
    // count the request from before it. It is read before the pause check, so a compaction that ran
    // while requests were paused still gets its base. The first reading never asks.
    if (session.growthArmed && session.cachedConfig.mode === 'active' && session.cachedConfig.atPercent !== undefined) {
      const reading = (await $.session.usage())?.context?.tokens;
      if (!Number.isFinite(reading) || reading <= 0) return result;
      const first = session.growthBase === undefined;
      session.growthBase = first ? reading : Math.min(session.growthBase, reading);
      if (first || session.turnCount - session.lastAttempt < MIN_TURNS_BETWEEN) return result;
    }
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
    // After a compaction the context has to grow by OWN_MIN_GAIN of the window first, counted from the
    // lowest usage since it and at most from the threshold: a compaction that ends above the threshold
    // would else be asked for again as soon as the turn gap allows (right away after /compact or the
    // host's own compaction), and one that ends just below it after a few thousand tokens.
    if (session.growthBase !== undefined && tokens - Math.min(session.growthBase, (cfg.atPercent * window) / 100) < OWN_MIN_GAIN * window) return result;
    session.growthArmed = false;
    // The tokens include the fixed prefix (system prompt, tools, instructions): ask only when the
    // removable tool results are worth it, so the threshold never forces the built-in summary.
    session.lastAttempt = session.turnCount;
    const messages = await $.session.messages();
    let before = messages.reduce((s, m) => s + messageChars(m), 0);
    const candidates = findCandidates(messages, cfg.privatePaths);
    let removable = removableChars(candidates);
    const tooSmall = () => !before || removable / before < MIN_REDUCTION || removable / CHARS_PER_TOKEN < OWN_MIN_GAIN * window;
    // The delivered messages can only make this worse (they add to `before`, their envelopes come off
    // `removable`), so a transcript that fails here needs no API read, which may hold the turn for HOST_MS.
    if (tooSmall()) return result;
    // Messages delivered during a tool turn are in the API form only; decide counts them, so the
    // preflight does too (else it could ask for a compaction that decide hands back to the summary).
    const apiRead = await withDeadline($, Promise.resolve().then(() => $.session.messages({ as: 'api' })), HOST_MS);
    // A read that timed out or failed leaves the delivered text unknown: decide could hand a large one
    // back to the summary, so the preflight does not ask.
    if (!('value' in apiRead)) return result;
    const api = apiFormOf(apiRead.value);
    const delivered = queuedOf(messages, api);
    if (delivered) {
      for (const blocks of delivered.rows.values()) before += rawChars(blocks);
      removable -= envelopeChars(messages, delivered.rows, candidates);
    }
    if (tooSmall()) return result;
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
