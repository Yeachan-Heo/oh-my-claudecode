/* global crypto, TextEncoder, URL */
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
 * used up, and when Jev fails, answers too little or does not answer in time. A batch the API refuses
 * (HTTP 400, 413, 422) and ends the compaction in the built-in summary keeps that agent (the main loop, or a
 * subagent) from asking again for BATCH_REFUSED_MS (reason batch_refused; no shared breaker opens, the refusal
 * is about the conversation). A result Jev did not rate (failed or
 * unstarted batch, missing answer) has no rating: it counts as UNRATED_SCORE, so it is cut for lack of
 * room only after the results rated lower.
 *
 * turn.complete. With OMC_JEV_COMPACT_AT_PERCENT (off when unset) the module asks the host to compact
 * once the context reaches that share of the compaction window: main loop only, at most once per
 * MIN_TURNS_BETWEEN turns, never during a compaction, never while requests are paused, and only when
 * the removable tool results are worth it (a request that would end in the built-in summary is not
 * made). After a compaction of the main loop (this module's or the built-in summary) it also waits
 * until the context has grown by OWN_MIN_GAIN of the window from the lowest usage since it (from the
 * threshold at most).
 *
 * turn.step. After a compaction of the main loop that this module installed, the first model request
 * that carries usage writes an `after` record: the input tokens the API counted for it
 * (tokens_after_real) next to chars_after of the compaction record (compact_ts). Every record carries
 * module_rev, the sha256 of the module file the process loaded (null when it cannot be read).
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
 * Pasted text (OMC_JEV_COMPACT_PASTES=off|shadow|active; off when unset or anything else; main loop only). A
 * `<pasted_content>` tag in an older user message can move to a file and leave a trace: its length, the path, and its first
 * PASTE_TRACE_HEAD and last PASTE_TRACE_TAIL characters word for word. The tag says that the user pasted the text, not who wrote
 * it (notes, mails and commands of the user's own are pasted too), so nothing moves on the tag alone; no sentence of the user
 * may leave the conversation. A tag moves only if every one of these holds:
 * - it is a whole closed tag between PASTE_MIN_CHARS (OMC_JEV_COMPACT_PASTE_MIN_CHARS) and PASTE_MAX_CHARS
 *   (OMC_JEV_COMPACT_PASTE_MAX_CHARS) characters, and moves by itself: neighbouring tags are never joined into one fragment, and nothing outside a tag is ever
 *   removed (a quotation with the user's comment in the same paragraph, a code block, a list);
 * - its message holds at least PASTE_OWN_MIN_CHARS characters of other words of the user: a message that is nothing but the
 *   paste (or the paste and a keyword) sends that text as the user's own instruction and stays whole;
 * - the message is not the first or the newest user message (a row that a hook or the host puts in does not count as one: a row
 *   flagged isMeta, or one that opens with a prefix of HOOK_ROW_PREFIXES or OMC_JEV_COMPACT_HOOK_ROW_PREFIXES), lies before the last
 *   KEEP_LAST messages and the open tool loop, and holds no image or file block (the API form of the conversation has to be available to tell);
 * - it names no secret or private path and masking leaves it unchanged (it goes neither to Jev nor to a file otherwise);
 * - it carries none of the user's own style as OMC_JEV_COMPACT_OWNER_MARKERS describes it (comma separated regular expression
 *   sources; empty by default, so no tag is held back by it);
 * - Jev, who gets the whole tag (one request per tag, at most PASTE_MAX_ASKS of the largest, so every removed character was
 *   read), says yes with a probability of PASTE_YES (OMC_JEV_COMPACT_PASTE_YES) or more to "is all of it pasted material, none of it the user's own writing"
 *   (the requests start after the scoring ones and count against OMC_JEV_MAX_REQUESTS, the breaker and OMC_JEV_MAX_RPM);
 * - its file was written and read back whole, and the trace is shorter than the tag.
 * Anything else, a failed or unanswered request included, leaves the tag in the conversation. Tool-result decisions do not depend
 * on this: the results kept or removed are the same with the switch off, and a compaction that ends in the built-in summary
 * moves nothing (the files are written once the module's own result is certain; with OMC_JEV_COMPACT_TARGET_PERCENT, before the plan, so the
 * text they move comes off the prediction, and a fallback after that leaves the files). `shadow` asks and counts but writes
 * nothing and changes nothing; `active` acts only while the point itself is active. Files:
 * <state dir>/compaction-pastes/<session>/<sha256 of the tag, 32 hex>.txt, named by their content so two compactions write the
 * same text; scripts/lib/jev-compaction-state.mjs removes old session directories (OMC_JEV_PASTES_DAYS). The record gets
 * `pastes` with the counts (tags, why they stayed, requests, answers, files, characters moved, installed) and, for each tag
 * asked about, the name its file has (so shadow can be checked against the transcript), its size and Jev's probability.
 *
 * Long replies (OMC_JEV_COMPACT_LONG_REPLIES=off|shadow|active; off when unset or anything else; main loop only). A run of assistant
 * text of at least REPLY_MIN_CHARS characters (lines between trace lines) in a row before the REPLY_KEEP_OWNERS-th last user message, the
 * REPLY_KEEP_TURNS-th last turn and the last KEEP_LAST rows can move to a file and leave a trace of its length, the path and its first
 * REPLY_TRACE_HEAD and last REPLY_TRACE_TAIL characters word for word, without a request to Jev. It stays when its row holds an image
 * or server block, when it is the first or the last reply to a user message that still holds words of its own (directReplyRows), when
 * it names a secret or masking changes it, or when the trace would save less than REPLY_MIN_SAVING characters. The files are written
 * and read back like those of the pastes (same directory, same retention), when the module's own result is certain, or before the plan with
 * OMC_JEV_COMPACT_TARGET_PERCENT; `shadow` counts only; the record gets `replies`.
 *
 * Secrets in the paste, reply and agent stages: a tag, run or agent message that names a secret or private path, or that masking changes, stays
 * in the conversation unmoved, and no file is written for it. This is deliberate: a copy with the secrets masked is not archived in its place, so
 * a session with secrets in such text keeps that text whole in the conversation until masked archiving is added. The check is bounded (maskSecrets
 * is quadratic on one long word): a text beyond SCAN_MAX_CHARS, or beyond the SCAN_BUDGET_CHARS one stage checks in one compaction, counts as unchecked
 * and stays whole the same way; the preflight of the own threshold hands the rows it checked to the compaction it asks for, which does not check them again. A row that holds tool results or a delivered message's anchor is never rebuilt by the paste stage.
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
 * Token accounting (OMC_JEV_COMPACT_TOKEN_ACCOUNTING=1, off by default; without it nothing below runs and
 * no record gains a field). The compaction window and threshold come from one resolver (resolveWindow): the
 * host's breakdown first (rawMaxTokens, autoCompactThreshold), else CLAUDE_CODE_AUTO_COMPACT_WINDOW, the
 * autoCompactWindow of settings.json under CLAUDE_CONFIG_DIR (or ~/.claude), capped at the model's window,
 * else the model's window; the threshold is that window less HOST_BUFFER. With the switch on, the own
 * threshold reads the same window. The tokens before are the host's usage in the main loop, else an
 * estimate of the API form by class (listTokens, RATE_* constants); the tokens after are predicted from the
 * removed text by the same rates. OMC_JEV_COMPACT_MAX_WINDOW_TOKENS (positive integer, unset: no cap) caps the
 * kept target at that window divided by 1 + PREDICTION_SHORTFALL (tokenCeiling). The rates and PREDICTION_SHORTFALL come from one measurement of
 * one model on one host; OMC_JEV_COMPACT_RATES (a JSON object of rate name to number) overrides them one by one (ratesFrom). These figures go to the
 * compaction record only (target_tokens, target_tokens_capped, tokens_before, tokens_after, window, threshold,
 * window_source, tokens_source); the cut itself still follows the character budget of allocate.
 *
 * Token cascade (OMC_JEV_COMPACT_TARGET_PERCENT, two digits from 20 to 80 enable it; unset: off. The name stays as it is although the value is a share of the window, not a switch). The cut then follows tokens: the target is that
 * share of the window, at most TARGET_OF_THRESHOLD of the threshold, times TARGET_UNCALIBRATED (the rule's target), and cascade (passes forced, short_or_trace, trace_all) steps the results down from the least needed, predicting the tokens
 * after each step, until the prediction reaches the target; the last pass (drop) removes a result with its call. A compaction at or below the usual
 * target is manual: only the scores decide (manualPlan), and the cascade runs only when that still leaves the prediction above the target. In
 * any other case, before Jev is asked, the floor (every removable result gone) is predicted: above the threshold less FLOOR_MARGIN of the window
 * the host's summary runs (floor_above_threshold; no_window when the window is unknown). The gates on characters (too_few_results of decide, the preflight of the own
 * threshold) are also measured in tokens (cutInTokens): an image has no characters and costs RATE_IMAGE, so a session that fails them on characters goes on when its
 * tokens reach the same bounds (the agent stage's trim and, with the stage active, the reports it plans to move to files count in decide's gate and in the preflight of the own threshold), and the record has max_reduction_tokens. The compaction record gains cut, cascade_pass,
 * cascade_target_tokens, cascade_predicted_tokens, cascade_tokens_source, cascade_dropped, floor_pred and tokens_after_pred. Host handoff
 * (OMC_JEV_COMPACT_HOST_HANDOFF=1, opt-in with caution: the host's contract is not documented in this repository): the result also carries
 * tokensBefore and tokensAfter, and a manual or automatic cut under HOST_MIN_CUT goes to the host's summary (cut_below_host_min). Question naming
 * (OMC_JEV_COMPACT_QUESTION_NAME=1; unset: off): the score question names its result's key in state.results in its text.
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
// Token accounting (OMC_JEV_COMPACT_TOKEN_ACCOUNTING=1). The host compacts HOST_BUFFER tokens below its window (window minus
// the 20 000 output reserve and the 13 000 autocompact buffer, the /context panel's 33k); used only when the host gives no threshold.
const HOST_BUFFER = 33000;
// The floor rule of the token cascade: the predicted floor must stay under the threshold less this share of the window; a compaction
// that cannot get below it would fire again within a few turns.
const FLOOR_MARGIN = 0.2;
// Host handoff (OMC_JEV_COMPACT_HOST_HANDOFF=1): a manual or automatic compaction that would remove less than this share of the tokens
// goes to the host's own summary, so the module does not ask Jev for a cut the host would not have needed.
const HOST_MIN_CUT = 0.3;
// The text of the skip the module answers its own request with (ownThreshold tells it from another mod's skip).
const OWN_SKIP_PREFIX = 'jev-compaction:';
// The usual target of the token cascade's rule: the share of the window (OMC_JEV_COMPACT_TARGET_PERCENT), capped at 75 % of the threshold, then
// 85 % of that. A compaction at or below it is manual: only the scores decide (manualPlan), and the floor is not checked.
const TARGET_OF_THRESHOLD = 0.75;
const TARGET_UNCALIBRATED = 0.85;
const usualTarget = (win, targetPercent) => Math.min(Math.floor((win.window * targetPercent) / 100), Math.floor(TARGET_OF_THRESHOLD * win.threshold));
// The rates below and the shortfall come from one measurement of one model on one host (Opus 5.5, Claude Code 2.1.322): the defaults are an
// estimate to be measured again for another model or host, and OMC_JEV_COMPACT_RATES overrides them (a JSON object of name to number).
// The prediction after a compaction falls short of the window the host measures by PREDICTION_SHORTFALL (1.2 % after the rates; a share, 0 or
// more); the window ceiling divides by 1 + this share. The rest is the cost of a class of text in API tokens, from a regression on 374 usage
// increments. Only the costs the module uses are listed.
const DEFAULT_RATES = Object.freeze({
  PREDICTION_SHORTFALL: 0.012,
  RATE_IN: 0.5513, // a character of a tool call's name and input
  RATE_OUT: 0.4502, // a character of a tool result
  RATE_NOTE: 0.363, // a character of a reminder, notification or delivered message (user text beside a result)
  RATE_OWN: 0.287, // a character of the user's own words
  RATE_ATXT: 0.315, // a character of the assistant's text
  RATE_ATT: 0.43, // a character of the frame cut from an agent's message (reminder-class text of tags, no measurement of its own: an upper bound)
  RATE_TRACE: 0.58, // a character of a one-line trace
  RATE_MOVED: 0.455, // a character of text moved to a file (assistant text 0.315 plus the non-ASCII share of long messages); a slight overstatement of what leaves
  RATE_NON_ASCII: 3.72, // one more token per non-ASCII character
  RATE_BLOCK: 45.4, // per content block
  RATE_IMAGE: 2348, // per image (flat; the size from the file header is not read)
});
// OMC_JEV_COMPACT_RATES: a JSON object of rate name to number laid over the defaults. A name that is not listed, a value that is not a finite
// number above 0 (PREDICTION_SHORTFALL: 0 or above) and a text that is not a JSON object leave the default in place.
export function ratesFrom(raw) {
  const rates = { ...DEFAULT_RATES };
  let given;
  try { given = JSON.parse(String(raw ?? '')); } catch { return rates; }
  if (!given || typeof given !== 'object' || Array.isArray(given)) return rates;
  for (const name of Object.keys(DEFAULT_RATES)) {
    const v = given[name];
    if (typeof v === 'number' && Number.isFinite(v) && (name === 'PREDICTION_SHORTFALL' ? v >= 0 : v > 0)) rates[name] = v;
  }
  return rates;
}
const RATE_MESSAGE = -40.5; // per message, spread over its blocks
// Non-ASCII characters (by code point) of a text: each costs RATE_NON_ASCII tokens more than an ASCII one.
const nonAscii = (s) => { let n = 0; for (const ch of String(s ?? '')) if (ch.codePointAt(0) > 127) n++; return n; };
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
// A request batch counts when at least this share of its questions got a score.
const PARTIAL_OK = 0.5;
// The score from which a result that does not fit whole may be kept as a short copy (allocate).
const SHORT_COPY_MIN_SCORE = 0.5;
// A result held back on purpose (a prose call naming a secret path, TaskOutput) is never sent and has no rating: UNANSWERED_SCORE ranks it
// below every result that was merely not rated and gives it no short copy.
const UNANSWERED_SCORE = 0.4;
// A result Jev was asked about but did not rate (its batch failed, was never started, or the answer lacks it) has no rating at all:
// UNRATED_SCORE is the lowest score that still allows a short copy, so it is cut for lack of room only after the results rated lower
// (a result rated "may be useful" is 2/3).
const UNRATED_SCORE = SHORT_COPY_MIN_SCORE;
// A batch the API refuses (HTTP 400, 413, 422) is about that conversation, not about the endpoint being down, so it opens no breaker.
// When the compaction ends in the built-in summary because of it, the process remembers the refusal for BATCH_REFUSED_MS, per session id
// and agent (the main loop is 'main'), and the compactions in between run the summary (blockedReason). It is about one conversation, so
// another session in the same process (a resume or a swap) is not held back by it.
const BATCH_REFUSED_MS = 10 * 60 * 1000;
const BATCH_REFUSED_STATUSES = [400, 413, 422];
const PROBE_MAX_CHARS = 5_000_000;
// A file or URL named in the last user messages counts as needed when its name has at least this
// many characters (shorter names match too much text).
const MENTION_MIN = 5;
// Pasted text (OMC_JEV_COMPACT_PASTES, see the header). A tag shorter than the minimum would save little of its trace (default 2000,
// OMC_JEV_COMPACT_PASTE_MIN_CHARS); the cap keeps masking (quadratic patterns) and the request bounded (default 30000,
// OMC_JEV_COMPACT_PASTE_MAX_CHARS; 30000 is about half of a scoring request). A message with fewer than PASTE_OWN_MIN_CHARS
// characters of other words is the paste itself. Jev's "no part is the user's own" must reach the probability in
// OMC_JEV_COMPACT_PASTE_YES (default 0.8). A trace keeps the first and last characters word for word (what comes at the end of a
// paste is often what the user typed last).
const PASTE_MIN_CHARS = 2000;
const PASTE_MAX_CHARS = 30000;
const PASTE_OWN_MIN_CHARS = 20;
const PASTE_YES = 0.8;
const PASTE_MAX_ASKS = 4;
const PASTE_TRACE_HEAD = 200;
const PASTE_TRACE_TAIL = 300;
// Long replies (OMC_JEV_COMPACT_LONG_REPLIES, see the header). A run of assistant text moves only when it has REPLY_MIN_CHARS
// characters and its trace saves at least REPLY_MIN_SAVING of them; the trace keeps REPLY_TRACE_HEAD first characters (the opening
// sentence) and REPLY_TRACE_TAIL last ones (the conclusion) word for word. The replies to the REPLY_KEEP_OWNERS newest user messages
// and the REPLY_KEEP_TURNS newest turns stay whole, and so does the reply that answers a user message directly (see directReplyRows).
const REPLY_MIN_CHARS = 400;
const REPLY_MIN_SAVING = 150;
const REPLY_TRACE_HEAD = 120;
const REPLY_TRACE_TAIL = 120;
const REPLY_KEEP_OWNERS = 3;
const REPLY_KEEP_TURNS = 6;
const PASTE_TRACE_PREFIX = '[pasted text moved at compaction: ';
const REPLY_TRACE_PREFIX = '[reply moved at compaction: ';
const AGENT_TRACE_PREFIX = '[agent message moved at compaction, not from the user: ';
const PASTE_QUESTIONS = {
  pasted: {
    type: 'noul',
    instructions:
      'Is state.fragment.text entirely text that the user pasted from elsewhere (an answer of another AI, a document, a log, the output of a command), with no part of it written by the user themselves: no instruction to the assistant, decision, answer, opinion, comment, question, note, draft or message of their own?',
    criteria: {
      true: 'Everything in it is pasted material; nothing in it is the user\'s own writing.',
      false: 'The user wrote at least a part of it (even one sentence or a comment between quotations), or it cannot be told.',
    },
  },
};
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
// The score question of one result. With OMC_JEV_COMPACT_QUESTION_NAME=1 the question text names the result's key in state.results (the keys
// are not sent to the model otherwise), in the shape of the Typesafe documentation: instructions as {question, compare, focus}, criteria as
// {what}. Off by default: the plain question above.
export function scoreQuestion(name, named) {
  if (!named) return { type: 'score', instructions: QUESTION_INSTRUCTIONS, criteria: QUESTION_CRITERIA };
  return {
    type: 'score',
    instructions: {
      question: `How much will the tool result \`results.${name}\` still be needed for further work on the user's task (\`task\`)?`,
      compare: [`\`results.${name}\``, '`task`'],
      focus: 'Judge whether further work will use it, not whether it was needed before.',
    },
    criteria: QUESTION_CRITERIA.map((what) => ({ what })),
  };
}

// Blocks the host or a hook adds to a user message; they stay in the conversation but are not the
// user's words, so they are cut from the task sent to Jev.
const HOST_TAGS = ['system-reminder', 'task-notification', 'teammate-message', 'command-name', 'command-message', 'command-args', 'local-command-stdout', 'local-command-stderr', 'local-command-caveat', 'bash-input', 'bash-stdout', 'bash-stderr'];
const HOST_OPEN = new RegExp(`<(${HOST_TAGS.join('|')})\\b`, 'g');
const HOST_BLOCK_OPEN = new RegExp(`^<(?:${HOST_TAGS.join('|')})\\b`);
// The text without its host blocks: the result of removing every `<tag ...>` up to the first `</tag>` after it, one pass. An opener the regular expression
// /<(tag)\b[^>]*>[\s\S]*?<\/\1>/g would try on every later opener again (a text of many unclosed openers took seconds, and a synchronous scan cannot be stopped
// by the deadline) is settled once: when no '>' follows, or no closing tag of its name follows, no later opener has one either.
export function cutHostBlocks(text) {
  let out = '';
  let kept = 0; // the text before this index is in `out` or cut
  let from = 0;
  let gt = -2; // the first '>' after the last opener's name; -1: none
  const noCloser = new Set();
  for (;;) {
    HOST_OPEN.lastIndex = from;
    const open = HOST_OPEN.exec(text);
    if (!open) break;
    const nameEnd = open.index + open[0].length;
    if (gt !== -1 && gt < nameEnd) gt = text.indexOf('>', nameEnd);
    if (gt === -1) break;
    const close = `</${open[1]}>`;
    const end = noCloser.has(open[1]) ? -1 : text.indexOf(close, gt + 1);
    if (end === -1) { noCloser.add(open[1]); from = open.index + 1; continue; }
    out += text.slice(kept, open.index);
    kept = end + close.length;
    from = kept;
  }
  return kept === 0 ? text : out + text.slice(kept);
}
// Messages that start with one of these are not the user's words either: skill and interruption
// notices, the session summary, and the notices the Claude desktop app adds as entries of their own
// (side-session and CI-monitor events, scheduled tasks, messages from another session: the same
// desktop-app notices scripts/pre-tool-enforcer.mjs skips).
const NOT_USER_PREFIXES = [
  'Base directory for this skill:', 'Caveat:', '[Request interrupted', 'This session is being continued from a previous conversation',
  '<side-sessions-event>', '<ci-monitor-event>', '<scheduled-task', '<cross-session-message', 'Another Claude session sent a message:',
];
// The traces the module's own stages leave in a user row (an agent's message moved to a file, a removed item) are not the user's words either, but
// only while one of those stages is on (OMC_JEV_COMPACT_AGENT_TRIM, _NOTIFICATIONS, _LONG_REPLIES, _PASTES): without them a row that opens with
// one of these is the user's text, as before. The stages themselves always count them; readConfig adds them to the list userTask reads.
const STAGE_NOT_USER_PREFIXES = ['[agent message moved at compaction', '[compacted] '];
const STAGE_NOT_USER = [...NOT_USER_PREFIXES, ...STAGE_NOT_USER_PREFIXES];
// Rows a hook or the host puts in as a user message are not the user's words for the paste and reply stages, which protect the user's newest messages and
// the replies to them: a row the host flags isMeta, and a row that opens with one of these prefixes (the host's rows for a stop hook, a goal, a CI monitor
// event, another session, an image, a re-invoked skill and a usage limit) or with one of OMC_JEV_COMPACT_HOOK_ROW_PREFIXES (empty by default).
const HOOK_ROW_PREFIXES = [
  'Stop hook feedback:', 'Goal check-in:', 'A session-scoped Stop hook is now active', '<ci-monitor-event>', '<cross-session-message',
  '[Image: source:', '[Image: original ', '(Re-invocation of ', '[Usage limit reached',
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
// working:" is no frame. otherFrame below reads a line as /^(?:.+ sent an? (?:new )?(?:message|report)|(?:A message|Messages) arrived .+|
// Activity (?:was observed )?in the bound conversation) while you were working(?:,.*)?:$/ does, without its backtracking.
const FRAME_WORKING = ' while you were working';
const FRAME_SENT = ['a', 'an'].flatMap((a) => ['', 'new '].flatMap((n) => ['message', 'report'].map((w) => ` sent ${a} ${n}${w}`)));
const FRAME_ARRIVED = ['A message arrived ', 'Messages arrived '];
const FRAME_ACTIVITY = ['Activity in the bound conversation', 'Activity was observed in the bound conversation'];
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
const PRELUDE_HEAD = /^\s*<system-reminder[^>]*>/;
const PRELUDE_SPACE = /\s*/y;
// The length of the complete reminder a text opens with (the match of /^\s*<system-reminder[^>]*>[\s\S]*?<\/system-reminder[^>]*>\s*/), 0 when it opens with none. Only the
// first closing tag can end it (when no '>' follows that one, none follows a later one either), so a text of many closing tags without a '>' is read in linear time.
export function preludeLength(text) {
  const head = PRELUDE_HEAD.exec(text);
  if (!head) return 0;
  const close = text.indexOf('</system-reminder', head[0].length);
  const gt = close < 0 ? -1 : text.indexOf('>', close + '</system-reminder'.length);
  if (gt < 0) return 0;
  PRELUDE_SPACE.lastIndex = gt + 1;
  PRELUDE_SPACE.exec(text);
  return PRELUDE_SPACE.lastIndex;
}
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
// it is kept at UNANSWERED_SCORE (never sent, no short copy), because the agent may have read the path.
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
  let explicitShadow = false; // the last entry naming this point is `point:shadow`
  for (const entry of value.split(',')) {
    const token = entry.trim();
    if (!token) continue;
    const colon = token.lastIndexOf(':');
    const name = colon === -1 ? token : token.slice(0, colon);
    if (name !== POINT) continue;
    explicitShadow = colon !== -1 && token.slice(colon + 1) === 'shadow';
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
  if (explicitShadow) active = false;
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
    cachedConfig: undefined, cachedAt: -Infinity, growthArmed: false, growthBase: undefined, skipBase: undefined, ownCompactInFlight: false,
    batchRefusedUntil: new Map(), pendingAfter: undefined, moduleRev: undefined, agentChecked: undefined,
  };
}
let session = freshState();

// The keys of readConfig's environment table that it read before the options of the token, agent, notification, paste and reply stages: the activation,
// the breaker, the endpoint, the state directory, the request limits, the own threshold, the private paths and the home directory.
const BASE_ENV_KEYS = new Set([
  'OMC_JEV', 'TYPESAFE_API_KEY', 'OMC_JEV_ENDPOINT', 'OMC_JEV_LOG_DIR', 'OMC_JEV_MAX_REQUESTS', 'OMC_JEV_EXCERPT_CHARS_COMPACTION', 'OMC_JEV_COMPACT_AT_PERCENT',
  'OMC_JEV_COMPACT_TARGET', 'OMC_JEV_COMPACT_TOAST', 'OMC_JEV_COMPACT_PRIVATE_PATHS', 'OMC_JEV_BREAKER', 'OMC_JEV_MAX_RPM', 'OMC_JEV_BREAKER_DIR', 'OS', 'USERPROFILE', 'HOME',
]);

// Configuration from the process environment, with the settings' env as a fallback for a host that did
// not put it into its environment. $.env.get takes literal names only. Without a state directory
// nothing is written.
export async function readConfig($) {
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
    OMC_JEV_COMPACT_TOKEN_ACCOUNTING: await $.env.get('OMC_JEV_COMPACT_TOKEN_ACCOUNTING'),
    OMC_JEV_COMPACT_MAX_WINDOW_TOKENS: await $.env.get('OMC_JEV_COMPACT_MAX_WINDOW_TOKENS'),
    OMC_JEV_COMPACT_TARGET_PERCENT: await $.env.get('OMC_JEV_COMPACT_TARGET_PERCENT'),
    OMC_JEV_COMPACT_RATES: await $.env.get('OMC_JEV_COMPACT_RATES'),
    OMC_JEV_COMPACT_QUESTION_NAME: await $.env.get('OMC_JEV_COMPACT_QUESTION_NAME'),
    OMC_JEV_COMPACT_HOST_HANDOFF: await $.env.get('OMC_JEV_COMPACT_HOST_HANDOFF'),
    OMC_JEV_COMPACT_OWN_THRESHOLD: await $.env.get('OMC_JEV_COMPACT_OWN_THRESHOLD'),
    OMC_JEV_COMPACT_AGENT_TRIM: await $.env.get('OMC_JEV_COMPACT_AGENT_TRIM'),
    OMC_JEV_COMPACT_AGENT_STATES: await $.env.get('OMC_JEV_COMPACT_AGENT_STATES'),
    OMC_JEV_COMPACT_NOTIFICATIONS: await $.env.get('OMC_JEV_COMPACT_NOTIFICATIONS'),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW'),
    CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR'),
    OMC_JEV_COMPACT_PRIVATE_PATHS: await $.env.get('OMC_JEV_COMPACT_PRIVATE_PATHS'),
    OMC_JEV_COMPACT_PASTES: await $.env.get('OMC_JEV_COMPACT_PASTES'),
    OMC_JEV_COMPACT_PASTE_MIN_CHARS: await $.env.get('OMC_JEV_COMPACT_PASTE_MIN_CHARS'),
    OMC_JEV_COMPACT_PASTE_MAX_CHARS: await $.env.get('OMC_JEV_COMPACT_PASTE_MAX_CHARS'),
    OMC_JEV_COMPACT_PASTE_YES: await $.env.get('OMC_JEV_COMPACT_PASTE_YES'),
    OMC_JEV_COMPACT_OWNER_MARKERS: await $.env.get('OMC_JEV_COMPACT_OWNER_MARKERS'),
    OMC_JEV_COMPACT_LONG_REPLIES: await $.env.get('OMC_JEV_COMPACT_LONG_REPLIES'),
    OMC_JEV_COMPACT_HOOK_ROW_PREFIXES: await $.env.get('OMC_JEV_COMPACT_HOOK_ROW_PREFIXES'),
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
  // The options of the stages (every key above but the ones in BASE_ENV_KEYS) are read from the settings too, also when the activation and breaker
  // values all stand in the process environment. Then only they are filled, so a key read before them behaves as it did.
  const breakerGap = env.OMC_JEV_BREAKER === undefined || env.OMC_JEV_MAX_RPM === undefined;
  const optionGaps = Object.keys(env).filter((name) => env[name] === undefined && !BASE_ENV_KEYS.has(name));
  if (mode !== 'off' && (breakerGap || optionGaps.length)) {
    try {
      const result = await withDeadline($, $.settings.read({ key: 'env' }), 1000);
      const fromSettings = result && typeof result === 'object' ? (result.value || result) : result;
      if (fromSettings && typeof fromSettings === 'object') {
        for (const name of breakerGap ? Object.keys(env) : optionGaps) if (env[name] === undefined && typeof fromSettings[name] === 'string') env[name] = fromSettings[name];
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
  const agentTrim = ['1', 'active'].includes(String(env.OMC_JEV_COMPACT_AGENT_TRIM ?? '').trim());
  const notifications = ['1', 'active'].includes(String(env.OMC_JEV_COMPACT_NOTIFICATIONS ?? '').trim());
  const pastes = pasteMode(env.OMC_JEV_COMPACT_PASTES);
  const replies = pasteMode(env.OMC_JEV_COMPACT_LONG_REPLIES);
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
    tokenAccounting: String(env.OMC_JEV_COMPACT_TOKEN_ACCOUNTING ?? '').trim() === '1',
    maxWindowTokens: windowInt(env.OMC_JEV_COMPACT_MAX_WINDOW_TOKENS),
    // Token rates and the prediction shortfall (the defaults of DEFAULT_RATES unless OMC_JEV_COMPACT_RATES overrides some).
    rates: ratesFrom(env.OMC_JEV_COMPACT_RATES),
    // Token cascade (off unless set to a two-digit share from 20 to 80).
    targetPercent: /^\d{2}$/.test(String(env.OMC_JEV_COMPACT_TARGET_PERCENT ?? '').trim()) ? fraction(env.OMC_JEV_COMPACT_TARGET_PERCENT, undefined, 20, 80) : undefined,
    // Switches: 1 and active turn them on; 0, off, any other value and unset leave them off.
    questionNamed: ['1', 'active'].includes(String(env.OMC_JEV_COMPACT_QUESTION_NAME ?? '').trim()),
    // Host handoff (off unless 1 or active): the return of the tokens before and after to the host, and a manual or automatic cut below HOST_MIN_CUT
    // goes to the host's summary.
    handoff: ['1', 'active'].includes(String(env.OMC_JEV_COMPACT_HOST_HANDOFF ?? '').trim()),
    // Own threshold skip (off unless 1 or active): the module's own request (the compaction ownThreshold asks the host for) that would remove less than
    // HOST_MIN_CUT of the tokens is answered with a skip, and the own threshold waits for growth before asking again.
    ownSkip: ['1', 'active'].includes(String(env.OMC_JEV_COMPACT_OWN_THRESHOLD ?? '').trim()),
    // Agent trim (off unless 1 or active): the host's frame and the idle notifications that carry only a state are cut out of the rows of agents' messages
    // before the tail. OMC_JEV_COMPACT_AGENT_STATES lists, comma separated, the phrases an agent's idle result may open or end with to be a state.
    agentTrim,
    agentStates: agentStatePattern(env.OMC_JEV_COMPACT_AGENT_STATES),
    // OMC_JEV_COMPACT_NOTIFICATIONS=1: a background task notification row before the tail is a candidate of the compaction (scored by Jev, kept, cut or
    // removed with a trace) instead of staying word for word.
    notifications,
    // The user's-words check reads the stages' trace prefixes only while one of the four stages is on (STAGE_NOT_USER_PREFIXES).
    notUserPrefixes: agentTrim || notifications || pastes !== 'off' || replies !== 'off' ? STAGE_NOT_USER : NOT_USER_PREFIXES,
    autoCompactWindow: env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    configDir: env.CLAUDE_CONFIG_DIR ? slash(env.CLAUDE_CONFIG_DIR) : undefined,
    home: homeForState ? slash(homeForState) : undefined,
    toast: String(env.OMC_JEV_COMPACT_TOAST ?? '').trim() === '1',
    privatePaths,
    pastes,
    pasteDir: stateDir ? `${stateDir}/compaction-pastes` : undefined,
    pasteMinChars: positiveInt(env.OMC_JEV_COMPACT_PASTE_MIN_CHARS, PASTE_MIN_CHARS),
    pasteMaxChars: positiveInt(env.OMC_JEV_COMPACT_PASTE_MAX_CHARS, PASTE_MAX_CHARS),
    pasteYes: fraction(env.OMC_JEV_COMPACT_PASTE_YES, PASTE_YES, 0.01, 1),
    ownerMarkers: ownerMarkerPatterns(env.OMC_JEV_COMPACT_OWNER_MARKERS),
    // Row prefixes of the paste and reply stages: the built-in ones, then the comma separated list of OMC_JEV_COMPACT_HOOK_ROW_PREFIXES.
    hookRowPrefixes: [...HOOK_ROW_PREFIXES, ...String(env.OMC_JEV_COMPACT_HOOK_ROW_PREFIXES ?? '').split(',').map((x) => x.trim()).filter(Boolean)],
    replies,
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

// The key of a refused-batch hold: session id and agent ('main' for the main loop).
const refusedKey = (sessionId, agentId) => `${sessionId ?? ''}|${agentId ?? 'main'}`;
// The session id, read within HOST_MS; undefined when it cannot be read.
async function sessionIdOf($) {
  const read = await withDeadline($, Promise.resolve().then(() => $.session.id()), HOST_MS);
  return typeof read.value === 'string' ? read.value : undefined;
}

// No request goes out: paused after a failure, breaker open, OMC_JEV_MAX_REQUESTS used up, the
// shared breaker open, or RPM capacity exhausted.
async function blockedReason($, cfg, now, agentId) {
  if (session.failedInRow >= FAILURES_TO_OPEN) return 'circuit_open';
  if (now < session.pausedUntil) return 'paused';
  if (cfg.maxRequests && session.requests >= cfg.maxRequests) return 'cap';
  // Expired holds go first, so the map does not grow with every refused conversation and an expired hold costs no session id read.
  for (const [key, until] of session.batchRefusedUntil) if (until <= now) session.batchRefusedUntil.delete(key);
  if (session.batchRefusedUntil.size && now < (session.batchRefusedUntil.get(refusedKey(await sessionIdOf($), agentId)) ?? 0)) return 'batch_refused';
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
  const known = new Set(); // the files of every background call whose result is still in the conversation, secret or not
  // The same by the id of the task, which a notification names in <task-id> (a notification need not name a file): the ids of the calls on a secret path (`secret`), of the
  // prose calls naming one (`held`) and of all (`known`).
  const ids = { secret: new Set(), held: new Set(), known: new Set() };
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const u of m.toolUses || []) {
      if (u.input?.run_in_background !== true || !results.has(u.tool_use_id)) continue;
      const list = touchesSecretPath(u.tool, u.input, privatePaths) ? out.secret : PROSE_TOOLS.has(u.tool) && anySecretPath(u.input, privatePaths) ? out.held : undefined;
      const head = results.get(u.tool_use_id).slice(0, OUTPUT_SCAN_CHARS);
      const named = [...head.matchAll(TASK_ID_IN_RESULT)].map((m) => m[1]);
      for (const id of named) { ids.known.add(id); (list === out.secret ? ids.secret : list === out.held ? ids.held : ids.known).add(id); }
      for (const w of head.split(/[\s"'`|;&<>()[\]{},=]+/)) {
        const file = outputFileOf(w);
        if (!file) continue;
        const name = file.slice(file.lastIndexOf('/') + 1);
        for (const f of name.length >= 6 ? [file, name] : [file]) { known.add(f); list?.add(f); }
      }
    }
  }
  return { secret: fileIndex(out.secret), held: fileIndex(out.held), known, ids };
}
// The id of a background task in the result of the call that started it ("with ID: bkxqmzpw", "agentId: a1b2c3").
const TASK_ID_IN_RESULT = /\b(?:agentId|task_id|taskId|ID|id)\s*[:=]\s*["']?([\w-]{4,64})/g;
// A word of a result as an output file (runs of slashes joined, lower case), or undefined when it is none.
function outputFileOf(word) {
  const file = word.replace(/[.:]+$/, '').replace(/[\\/]+/g, '/').toLowerCase();
  return file.includes('://') || file.endsWith('/') || (file.match(/\//g) || []).length < 2 ? undefined : file;
}
// Whether a notification names an output file that no background call still in the conversation produced (its call was cut or traced by an earlier
// compaction, which took the file's name with it): whether that call was on a secret path is then unknown, so the notification is held like a secret one.
function sourceUnknown(text, outputs) {
  for (const m of text.matchAll(/<output-file>([^<]{1,1000})<\/output-file>/g)) if (unknownFile(m[1].trim(), outputs.known)) return true;
  return false;
}
// What a notification says about its source, block by block (a row may hold several): 'secret' or 'held' when a call on a secret path started the task of a block
// (by its <task-id>), 'unknown' when a block's task is tied to no call still in the conversation and its output file is not either (an earlier compaction removed
// the call, and with it what said whether it was on a secret path), otherwise 'known'. The worst block decides: secret, then held, then unknown. A marker of the host
// that no block follows (only its own line between them) is a notification without a task, so 'unknown' too: a row of envelopes may hold one next to a block.
const NOTE_MARKER = DELIVERY_NOTES[0];
const NOTE_BLOCK_OPEN = /<task-notification[\s>]/g;
function sourceByTask(text, outputs) {
  let worst = 'known';
  let at = 0;
  let blocks = 0;
  while (at < text.length) {
    NOTE_BLOCK_OPEN.lastIndex = at;
    const open = NOTE_BLOCK_OPEN.exec(text);
    const outside = text.slice(at, open ? open.index : text.length);
    // Once per stretch between blocks: a second marker there leaves the first without a block (its own line is no host line), so only one marker is looked at.
    const m = worst === 'unknown' ? -1 : outside.indexOf(NOTE_MARKER);
    if (m >= 0 && (!open || outside.indexOf(NOTE_MARKER, m + NOTE_MARKER.length) >= 0 || !withoutTags(outside.slice(m + NOTE_MARKER.length)).split('\n').every((l) => !l.trim() || NOTE_HOST_LINE.test(l.trim())))) worst = 'unknown';
    if (!open) break;
    const close = text.indexOf('</task-notification>', open.index);
    const end = close < 0 ? text.length : close + '</task-notification>'.length;
    const block = text.slice(open.index, end);
    blocks++;
    at = end;
    const id = /<task-id>\s*([\w-]{1,64})\s*<\/task-id>/.exec(block)?.[1];
    if (id && outputs.ids.secret.has(id)) return 'secret';
    if (id && outputs.ids.held.has(id)) worst = 'held';
    else if (worst === 'known' && !(id && outputs.ids.known.has(id)) && !namesKnownFile(block, outputs.known)) worst = 'unknown';
  }
  return blocks ? worst : 'unknown'; // a row that holds no block names no task at all
}
// Whether a notification block names an output file that a call still in the conversation produced: its source is then known, whatever its task id says.
const namesKnownFile = (text, known) => [...text.matchAll(/<output-file>([^<]{1,1000})<\/output-file>/g)].some((m) => { const f = outputFileOf(m[1].trim()); return Boolean(f) && (known.has(f) || known.has(f.slice(f.lastIndexOf('/') + 1))); });
const unknownFile = (word, known) => {
  const file = outputFileOf(word);
  return Boolean(file) && !known.has(file) && !known.has(file.slice(file.lastIndexOf('/') + 1));
};
// The same for a call that reads such a file (a `cat` or `tail` of `.../tasks/<id>.output`): the file of a background call that an earlier compaction cut.
function readsUnknownOutput(input, known) {
  // Only the part from `/tasks/` on (the file's own name is what the index holds too), so that the read is linear whatever the input holds.
  for (const m of inputJson(input).matchAll(/\/tasks\/[\w.-]+\.output\b/g)) if (unknownFile(m[0], known)) return true;
  return false;
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
    const prelude = preludeLength(t);
    if (!prelude) return undefined;
    t = t.slice(prelude);
  }
  return undefined;
}
// Whether the first line of a text is such a frame. Each place where the line says " while you were working" is tried once, and what stands before it and after
// it is told by its ends alone, so a line of many such phrases is read in linear time.
export function otherFrame(t) {
  const line = t.split('\n', 1)[0];
  const last = line.length - 1;
  if (line[last] !== ':' || /[\r\u2028\u2029]/.test(line)) return false; // `.` matches none of these, and the line ends with ':'
  for (let p = line.indexOf(FRAME_WORKING); p >= 0; p = line.indexOf(FRAME_WORKING, p + 1)) {
    const q = p + FRAME_WORKING.length;
    if (q !== last && line[q] !== ',') continue; // ':' or ',' and then anything up to the final ':'
    if (FRAME_SENT.some((s) => p > s.length && line.startsWith(s, p - s.length))) return true;
    if (FRAME_ARRIVED.some((s) => p > s.length && line.startsWith(s))) return true;
    if (FRAME_ACTIVITY.some((s) => p === s.length && line.startsWith(s))) return true;
  }
  return false;
}
const startsFrame = (t) => t.startsWith(QUEUED_PREFIX) || otherFrame(t) || DELIVERY_OPENERS.some((p) => t.startsWith(p));
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

// `body` without the closing tags of reminders at its end and the blank space around them: the result of
// body.replace(/(?:\s*<\/system-reminder[^>]*>)+\s*$/, '') in one pass from the end (a tag cannot hold a '>', so each closing tag starts at the first
// `</system-reminder` after the '>' before it).
export function withoutTrailingClosers(body) {
  const word = '</system-reminder';
  let end = body.length;
  let cut = -1;
  for (;;) {
    let k = end;
    while (k > 0 && /\s/.test(body[k - 1])) k--;
    if (k === 0 || body[k - 1] !== '>') break;
    const open = body.indexOf(word, (k >= 2 ? body.lastIndexOf('>', k - 2) : -1) + 1);
    if (open < 0 || open + word.length > k - 1) break;
    end = open;
    cut = open;
  }
  if (cut < 0) return body;
  while (cut > 0 && /\s/.test(body[cut - 1])) cut--;
  return body.slice(0, cut);
}

// The user's words in one delivered block: from the user's header to the last framing note of the
// block (the user may write the note's words too); none for a block of another sender. Nothing inside
// a block is read as a frame of its own, so a header another sender quotes is not the user's.
function blockWords(block) {
  if (frameOf(block) !== 'user') return [];
  const body = bodyOf(block, startsFrame).slice(QUEUED_PREFIX.length);
  const tail = body.lastIndexOf(QUEUED_TAIL);
  const words = (tail < 0 ? withoutTrailingClosers(body) : body.slice(0, tail)).trim();
  return words ? [words] : [];
}

// The regions of a text that are quotes to the user's block around them: `opaque`, in text order and not
// overlapping, holds every paired envelope and the quotes below; `quotes` holds just those, which can hold whole
// envelopes (a delivery in one is part of the quote). A quote is a paired plain <system-reminder> that holds no
// delivery (a reminder that wraps one is read by its frame) and a paired <task-notification> (its result is
// text of a task). A quote is what either of two readings of the tags marks (see opaqueOf): each opener to the
// first closing tag after it, and the tags paired by nesting, so a quote that holds another quote or a tag without
// its partner keeps its whole body. Tags inside an envelope belong to it. The tags are indexed in one pass and
// nest at most QUOTE_DEPTH_MAX deep, so a text full of unpaired or nested tags is read in linear time.
// The reminder tag comes first: a notification opener inside a reminder that is a quote by nesting is text in reading 1.
const QUOTE_TAGS = [
  // Bounded openers: a text full of unclosed tags stays linear.
  { open: /<system-reminder(?![^>]{0,200}\bid=)[^>]{0,200}>/g, close: '</system-reminder>', quote: (t) => !deliveryOf(t) },
  { open: /<task-notification(?:\s[^>]{0,200})?>/g, close: '</task-notification>', quote: () => true },
];
const QUOTE_DEPTH_MAX = 8;
const NATIVE_NOTIFICATION = /^\s*(?:<system-reminder[^>]{0,200}>\s*){0,4}(?:\[SYSTEM NOTIFICATION - NOT USER INPUT\]\s*)?(<task-notification(?:\s[^>]{0,200})?>)/;
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
  // A row that is one native notification (it opens with the tag, maybe after its marker line, complete reminders
  // before it or reminders around it, and ends with the closing tag) is one quote whatever its result holds, an
  // unbalanced tag included; not when its tags make two blocks side by side (a legacy row can hold a message of
  // the user between them), and not in a row with envelopes, which build wrote around carried blocks.
  let nativeQuote;
  let native;
  let skipped = 0;
  for (let t = text, k = 0; !envelopes.length && k <= PRELUDES_MAX; k++) {
    native = NATIVE_NOTIFICATION.exec(t);
    const prelude = native ? 0 : preludeLength(t);
    if (!prelude) break;
    skipped += prelude;
    t = t.slice(prelude);
  }
  if (native) {
    let tail = text.trimEnd();
    // Only the closing tags of the reminders that open before the notification are peeled.
    // Pair wrapper closers by nesting, not by lastIndexOf which could find a sibling reminder's closer.
    const wrappers = native[0].split('<system-reminder').length - 1;
    for (let k = 0; k < wrappers; k++) {
      // Find the wrapper's closer: a </system-reminder> whose nesting level matches (depth = k from the end).
      // Count depth from the end: +1 for each closing tag, -1 for each opening tag (going backward).
      let depth = 0;
      let at = -1;
      for (let i = tail.length - 1; i >= 0; i--) {
        if (i + '</system-reminder>'.length <= tail.length && tail.slice(i, i + '</system-reminder>'.length) === '</system-reminder>') {
          if (depth === 0) {
            at = i; // Found the closer at the expected nesting level
            break;
          }
          depth++; // Going backward, each closing tag increases depth
          i -= 17; // Skip past the closing tag length
        } else if (i + '<system-reminder'.length <= tail.length && tail.slice(i, i + '<system-reminder'.length) === '<system-reminder') {
          depth--; // Going backward, each opening tag decreases depth
          i -= 16; // Skip past the opening tag length
        }
      }
      if (at < 0) break; // No more closers found
      const gt = at < 0 ? -1 : tail.indexOf('>', at);
      if (gt < 0 || tail.slice(gt + 1).trim()) break; // Stop if no closing > or content after it
      tail = tail.slice(0, at).trimEnd();
    }
    if (tail.endsWith(QUOTE_TAGS[1].close)) nativeQuote = { from: skipped + native.index + native[0].length - native[1].length, to: tail.length };
  }
  const reminders = []; // the plain reminders that are quotes by nesting (the first tag's reading 2)
  for (const tag of QUOTE_TAGS) {
    const closers = positionsOf(text, tag.close);
    if (!closers.length) continue;
    const inClose = insideOf(envelopes);
    const free = closers.filter((c) => !inClose(c));
    const inOpen = insideOf(envelopes);
    const openers = [...text.matchAll(tag.open)].filter((o) => !inOpen(o.index));
    const add = (from, to) => { if (!tag.quote(text.slice(from, to))) return false; found.push({ from, to }); return true; };
    // A notification tag that a plain reminder quotes is text in reading 1: it does not open a quote that ends at
    // a notification after the reminder (the tags of reading 2 and the block count are not changed by it).
    const inReminder = insideOf(unionOf(tag === QUOTE_TAGS[1] ? reminders : []));
    // Whether a non-blank character precedes a position on its line; asked in increasing order, so it is linear.
    let scanned = 0;
    let dirty = false;
    const midLine = (at) => {
      const part = text.slice(scanned, at);
      scanned = at;
      const nl = part.lastIndexOf('\n');
      dirty = nl < 0 ? dirty || /\S/.test(part) : /\S/.test(part.slice(nl + 1));
      return dirty;
    };
    // Reading 1: each opener to the first closing tag after it (a quote that holds a tag without its
    // partner ends at its own closing tag). A notification opener in the middle of a line is text here: the host
    // opens a notification at the start of a line, so such an opener is a mention in the words of someone else.
    let end = 0;
    for (const o of openers) {
      const mid = tag === QUOTE_TAGS[1] && midLine(o.index);
      if (o.index < end || mid || inReminder(o.index)) continue;
      const c = lowerBound(free, o.index + o[0].length);
      if (c >= free.length) break;
      end = free[c] + tag.close.length;
      add(o.index, end);
    }
    // Reading 2: tags paired by nesting, as a stack (a quote can quote another one, and then ends at the
    // matching closing tag); an opener below a full stack is text, and so is its closing tag.
    const stack = [];
    let over = 0;
    let depth = 0; // the true depth of the tags, and how many blocks of the first level they close
    let blocks = 0;
    for (let i = 0, j = 0; j < free.length;) {
      if (i < openers.length && openers[i].index < free[j]) {
        depth++;
        if (stack.length < QUOTE_DEPTH_MAX) stack.push(openers[i].index);
        else over++;
        i++;
        continue;
      }
      if (depth > 0 && --depth === 0) blocks++;
      if (over > 0) { over--; j++; continue; }
      const from = stack.pop();
      const to = free[j++] + tag.close.length;
      if (from !== undefined && add(from, to) && tag === QUOTE_TAGS[0]) reminders.push({ from, to });
    }
    if (tag === QUOTE_TAGS[1] && nativeQuote && blocks < 2) found.push(nativeQuote);
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
function userWords(m, prefixes = NOT_USER_PREFIXES) {
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
  const text = cutHostBlocks(own).trim();
  const carried = delivered.flatMap((e) => blockWords(e.text));
  if (!text || HOST_BLOCK_OPEN.test(text) || prefixes.some((p) => text.startsWith(p))) return carried;
  // A prompt the user typed: an envelope in it is a quote they pasted, so the whole prompt is theirs. Except
  // the jev envelopes build appends at the end of a row it rebuilt from a result row (it has a toolResults list,
  // whatever it holds; a result row keeps its own text before them): those stay messages of their senders.
  let cut = m.text.length;
  if (Array.isArray(m.toolResults)) for (let k = delivered.length - 1; k >= 0 && /^<system-reminder id="jev-\d+">/.test(delivered[k].text) && !m.text.slice(delivered[k].to, cut).trim(); k--) cut = delivered[k].from;
  const typed = cutHostBlocks(m.text.slice(0, cut)).trim();
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
function userTask(messages, instructions, queued = new Map(), privatePaths = [], notUserPrefixes = NOT_USER_PREFIXES) {
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
    const words = [...userWords(messages[i], notUserPrefixes), ...(queued.get(i) || []).flatMap(blockWords)];
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
  if (c.note) return `[compacted] ${NOTE_LABEL} (${clip(c.summary, TRACE_INPUT_CHARS)}) - ${c.resultChars} chars removed`;
  const what = !c.textOnly ? 'non-text result (image or file) removed' : `${c.res.isError ? 'error' : 'result'} of ${c.resultChars} chars removed`;
  return `[compacted] ${c.use.tool}(${clip(c.summary, TRACE_INPUT_CHARS)}) - ${what}`;
}

// A notification's cut keeps its summary and the first SHORT_CHARS of its <result> body (the part before it is the same fixed text in every
// notification); without a <result>, the first SHORT_CHARS of the text. The kept text stays inside the notification's own tag, as in the host's row: the tag
// makes it one quote to every reading of the row (a delivery the result quotes is no delivery), and the row is the notification it was at the next compaction.
function shortText(c) {
  if (c.note) {
    const body = /<result>([\s\S]*?)(?:<\/result>|$)/.exec(c.res.text);
    const kept = body ? `${c.summary}\n${body[1].slice(0, SHORT_CHARS)}` : c.res.text.slice(0, SHORT_CHARS);
    return `[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n${kept}\n[notification shortened at compaction: kept ${SHORT_CHARS} of ${c.resultChars} chars]\n</task-notification>`;
  }
  return `${c.res.text.slice(0, SHORT_CHARS)}\n[result shortened at compaction: kept ${SHORT_CHARS} of ${c.resultChars} chars]`;
}

// The task list stays: every TaskCreate and TaskUpdate call, the newest TodoWrite call and the newest
// call of a plan tool (`update_plan`, as in the Claude desktop app) that carries the whole list
// (`todos`, `items`), and every later call of that tool (a plan tool also takes incremental calls).
const TASK_STEP = /^(?:TaskCreate|TaskUpdate)$/;
const TASK_LIST = /^TodoWrite$|(?:^|__)update_plan$/;

// --- background task notifications as candidates (OMC_JEV_COMPACT_NOTIFICATIONS) ---------------------------------------------------------------
// A notification row is a user row without results that carries a notification marker and either opens with it or is made only of <system-reminder> and
// <task-notification> blocks (a row that mixes them with other text is left alone, so no word of the user is ever removed), none of them a message of
// another sender or the user (frameOf). A row of envelopes (carriedText, the host's) is a notification when each envelope's body is one.
const NOTE_TOOL = 'notification';
const NOTE_LABEL = 'background task notification';
// The text without its closed <system-reminder> and <task-notification> blocks (`rest`) and the <system-reminder> blocks cut out (`plain`). Linear: an
// opener without a closer ends the search for its kind (no later opener has a closer either).
function withoutReminderBlocks(text) {
  const kinds = [{ open: '<system-reminder>', close: '</system-reminder>', next: -2, plain: true }, { open: '<task-notification>', close: '</task-notification>', next: -2, plain: false }];
  const plain = [];
  let rest = '';
  let first = -1; // where the first closed block starts
  let at = 0;
  for (;;) {
    let kind;
    for (const x of kinds) {
      if (x.next === -1) continue;
      if (x.next < at) x.next = text.indexOf(x.open, at);
      if (x.next >= 0 && (!kind || x.next < kind.next)) kind = x;
    }
    if (!kind) break;
    const end = text.indexOf(kind.close, kind.next + kind.open.length);
    if (end < 0) { kind.next = -1; continue; }
    rest += text.slice(at, kind.next);
    if (first < 0) first = kind.next;
    if (kind.plain) plain.push(text.slice(kind.next, end + kind.close.length));
    at = end + kind.close.length;
  }
  return { rest: rest + text.slice(at), plain, first };
}
// A <system-reminder> block that holds a message of another sender or the user: its frame (frameOf also takes a block opening with the notification's own
// <task-notification> for a frame of another kind, which a notification is not).
// The block is foreign also when it holds more than its opening: around a notification block only the marker and the host's own line may stand (anything else
// in the same reminder is a message or words of someone else), and a reminder with no notification holds no line that opens a frame.
const foreignBlock = (block) => {
  const body = block.replace(DELIVERY_WRAP, '');
  if (frameOf(block) !== undefined && !DELIVERY_NOTES.some((k) => body.startsWith(k))) return true;
  const { rest } = withoutReminderBlocks(body.slice(0, Math.max(0, body.lastIndexOf('</system-reminder>'))));
  const lines = rest.split('\n').map((l) => l.trim()).filter(Boolean);
  return body.includes('</task-notification>')
    ? lines.some((l) => l !== DELIVERY_NOTES[0] && !NOTE_HOST_LINE.test(l))
    : lines.some((l) => startsFrame(l) && !startsNote(l));
};
// The line the host writes between the marker and the first block; anything else there is not the host's framing, whoever it is from.
const NOTE_HOST_LINE = /^This is an automated background-task event(?:, NOT a message from the user)?\.$/;
function isNoteBody(t) {
  const { rest, plain, first } = withoutReminderBlocks(t);
  if (plain.some(foreignBlock)) return false;
  if (!t.startsWith(DELIVERY_NOTES[0])) return rest.trim() === '';
  // Opening with the marker is no leave for what stands outside the blocks: the marker line and the host's line before the first block (NOTE_HOST_LINE,
  // nothing else) are the notification's own; with a block, nothing but blank space may follow it. Without a block the text after the marker is the body.
  if (first < 0) return true;
  return rest.slice(first).trim() === '' && t.slice(DELIVERY_NOTES[0].length, first).split('\n').every((line) => !line.trim() || NOTE_HOST_LINE.test(line.trim()));
}
// A row of envelopes and nothing else, each holding a notification: a delivery of another kind (the coordinator, another session, a plugin), also inside a
// <system-reminder> in the envelope, leaves the row alone.
function onlyNoteEnvelopes(t, envelopes) {
  let at = 0;
  for (const e of envelopes) {
    if (t.slice(at, e.from).trim() || !isNoteBody(e.text.slice(e.text.indexOf('">') + 2, e.text.lastIndexOf(ENVELOPE_CLOSE)).trim())) return false;
    at = e.to;
  }
  return !t.slice(at).trim();
}
export function isNotification(m) {
  if (m.role !== 'user' || (m.toolResults && m.toolResults.length) || typeof m.text !== 'string' || !m.text) return false;
  // The marker first: a row without one is no notification, and its words are not read at all.
  if (!DELIVERY_NOTES.some((k) => m.text.includes(k)) || userWords(m, STAGE_NOT_USER).length) return false;
  const t = m.text.trim();
  const envelopes = envelopesOf(t);
  return envelopes.length ? onlyNoteEnvelopes(t, envelopes) : isNoteBody(t);
}
// What the notification says in a line: its <summary>, else the first line of its body after the marker.
// `l` without its <...> tags (each replaced by a space): the result of l.replace(/<[^>]*>/g, ' ') in one pass; a '<' with no '>' after it ends the search.
export function withoutTags(l) {
  let out = '';
  let at = 0;
  for (let open = l.indexOf('<'); open >= 0;) {
    const close = l.indexOf('>', open + 1);
    if (close < 0) break;
    out += `${l.slice(at, open)} `;
    at = close + 1;
    open = l.indexOf('<', at);
  }
  return out + l.slice(at);
}
export function noteSummary(text) {
  // The first <summary> that a </summary> follows: when none does after the first one, none does after a later one either.
  const open = text.indexOf('<summary>');
  const close = open < 0 ? -1 : text.indexOf('</summary>', open + '<summary>'.length);
  const tag = close < 0 ? '' : oneLine(text.slice(open + '<summary>'.length, close));
  if (tag) return clip(tag, TRACE_INPUT_CHARS);
  let at = -1;
  for (const k of DELIVERY_NOTES) { const i = text.indexOf(k); if (i >= 0 && (at < 0 || i + k.length < at)) at = i + k.length; }
  const rest = at >= 0 ? text.slice(at) : text;
  // The first line with anything in it, once its tags are out.
  let line = '';
  for (let from = 0; !line;) {
    const nl = rest.indexOf('\n', from);
    line = oneLine(withoutTags(rest.slice(from, nl < 0 ? rest.length : nl)));
    if (nl < 0) break;
    from = nl + 1;
  }
  return clip(line, TRACE_INPUT_CHARS);
}

// Candidates: tool results outside the first message and the last KEEP_LAST messages whose call is
// in an earlier assistant message.
function findCandidates(messages, privatePaths, notifications = false) {
  const outputs = backgroundOutputFiles(messages, privatePaths);
  const uses = new Map();
  messages.forEach((m, i) => { if (m.role === 'assistant') for (const u of m.toolUses || []) uses.set(u.tool_use_id, { i, u }); });
  const tailStart = Math.max(1, messages.length - KEEP_LAST);
  const out = [];
  for (let i = 1; i < tailStart; i++) {
    const m = messages[i];
    if (notifications && isNotification(m)) {
      // A notification that names the output file of a call on a secret path takes on the secrecy of that call (a trace, never sent to Jev).
      const bySource = sourceByTask(m.text, outputs);
      const c = {
        id: `${NOTE_TOOL}-${i}`, note: true, resIdx: i, useIdx: -1, use: { tool: NOTE_TOOL, input: {} }, res: { text: m.text, isError: false },
        summary: noteSummary(m.text), inputChars: 0, resultChars: m.text.length,
        secret: readsFile(m.text, outputs.secret) || bySource === 'secret',
        proseSecret: readsFile(m.text, outputs.held) || bySource === 'held' || bySource === 'unknown' || sourceUnknown(m.text, outputs),
        taskOutput: false, textOnly: true,
        score: 0, asked: false, answered: false,
      };
      c.trace = traceLine(c);
      c.fullCost = c.resultChars;
      c.traceCost = c.trace.length; // a row of its own: no newline joins it to an assistant text
      c.shortCost = c.resultChars > SHORT_CHARS ? shortText(c).length : c.fullCost;
      c.task = false;
      out.push(c);
      continue;
    }
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
        proseSecret: (PROSE_TOOLS.has(found.u.tool) && anySecretPath(found.u.input, privatePaths)) || readsFile(found.u.input, outputs.held) || readsUnknownOutput(found.u.input, outputs.known),
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
    if (!c.note && TASK_LIST.test(c.use.tool || '') && carriesList(c) && (!newestList.has(c.use.tool) || newestList.get(c.use.tool).resIdx < c.resIdx)) newestList.set(c.use.tool, c);
  }
  for (const c of out) {
    const list = newestList.get(c.use.tool);
    if (!c.note && list && c.resIdx >= list.resIdx && TASK_LIST.test(c.use.tool || '')) c.task = true;
  }
  return out;
}

// Token cascade (OMC_JEV_COMPACT_TARGET_PERCENT, 20-80: the share of the window the kept text may take, see the rule's target in decide). Every result
// starts whole, then the least needed steps down, with a prediction after each step, and it stops at the target: pass `forced` (a secret or a
// non-text result to a trace), pass `short_or_trace` (a result Jev scored under SHORT_COPY_MIN_SCORE to a trace, the others to a short copy when that
// saves tokens), pass `trace_all` (every remaining result to a trace), pass `drop` (every result still at a trace, least needed first, removed with its call). A pinned
// result (a task-list call, or a trace that saves no tokens) stays whole. The keep decisions go to `keep` as allocate sets them. Returns the
// pass reached, the target and the predicted tokens after.
// A forced result (a secret, or a non-text result) goes to a trace first, whatever its score; a pinned one is never cut by the cascade and is
// not counted in the floor.
const isForced = (c) => c.secret || !c.textOnly;
const isPinned = (c, rates = DEFAULT_RATES) => !isForced(c) && (c.task || itemTokens(c, rates).full - itemTokens(c, rates).trace <= 0);
export function cascade(candidates, tokensBefore, target, rates = DEFAULT_RATES) {
  const costs = new Map(candidates.map((c) => [c, itemTokens(c, rates)]));
  const saved = (c, keep) => {
    const t = costs.get(c);
    return keep === 'short' ? t.full - t.short : keep === 'trace' ? t.full - t.trace : keep === 'drop' ? t.full - t.drop : 0;
  };
  let removed = 0;
  const setKeep = (c, keep) => { removed += saved(c, keep) - saved(c, c.keep ?? 'full'); c.keep = keep; };
  const reached = () => tokensBefore - removed <= target;
  for (const c of candidates) c.keep = 'full';
  let pass = 'forced';
  for (const c of candidates) if (isForced(c)) setKeep(c, 'trace');
  const free = candidates.filter((c) => !isForced(c) && !isPinned(c, rates)).sort((a, b) => a.score - b.score || a.resIdx - b.resIdx);
  if (!reached()) {
    pass = 'short_or_trace';
    for (const c of free) {
      if (reached()) break;
      if (c.score < SHORT_COPY_MIN_SCORE) setKeep(c, 'trace');
      else if (costs.get(c).short < costs.get(c).full) setKeep(c, 'short');
    }
  }
  if (!reached()) {
    pass = 'trace_all';
    for (const c of free) {
      if (reached()) break;
      if (c.keep !== 'trace') setKeep(c, 'trace');
    }
  }
  if (!reached()) {
    pass = 'drop';
    for (const c of candidates.filter((x) => x.keep === 'trace').sort((a, b) => a.score - b.score || a.resIdx - b.resIdx)) {
      if (reached()) break;
      setKeep(c, 'drop');
    }
  }
  return { pass, target, predicted: Math.max(0, Math.round(tokensBefore - removed)) };
}

// The floor of the cascade: the predicted tokens when every removable result (every candidate but the pinned ones) is gone with its call.
export function floorPrediction(candidates, tokensBefore, rates = DEFAULT_RATES) {
  return tokensBefore - candidates.reduce((s, c) => s + (isPinned(c, rates) ? 0 : itemTokens(c, rates).full - itemTokens(c, rates).drop), 0);
}

// A manual compaction at or below the usual target: only the scores decide. Every forced result goes to a trace, and so does every free result
// Jev scored under SHORT_COPY_MIN_SCORE; the rest stays whole. Returns the prediction after the removal (no pass beyond it).
export function manualPlan(candidates, tokensBefore, rates = DEFAULT_RATES) {
  let removed = 0;
  for (const c of candidates) {
    c.keep = 'full';
    if (isForced(c) || (!isPinned(c, rates) && c.score < SHORT_COPY_MIN_SCORE)) {
      c.keep = 'trace';
      const t = itemTokens(c, rates);
      removed += t.full - t.trace;
    }
  }
  return { pass: 'manual', predicted: Math.max(0, Math.round(tokensBefore - removed)) };
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
    else if (c.score >= SHORT_COPY_MIN_SCORE && c.shortCost < c.fullCost && upShort <= avail) { c.keep = 'short'; avail -= Math.max(0, upShort); }
    else c.keep = 'trace';
  }
}

// --- token accounting (OMC_JEV_COMPACT_TOKEN_ACCOUNTING=1; record fields only, the cut follows allocate) -------------------

const finitePositive = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);
const windowInt = (raw) => (/^[1-9]\d{0,8}$/.test(String(raw ?? '').trim()) ? Number(String(raw).trim()) : undefined);
const strOf = (v) => (typeof v === 'string' ? v : '');
// One host call capped at HOST_MS, and at the time left before `deadline` when one is given (none left: no call is made): its value, or undefined on a
// timeout, an error or a missing value.
async function hostValue($, call, deadline) {
  const ms = deadline === undefined ? HOST_MS : Math.min(HOST_MS, deadline - Date.now());
  if (ms <= 0) return undefined;
  const settled = await withDeadline($, Promise.resolve().then(() => call()), ms);
  return 'value' in settled ? settled.value : undefined;
}

// The window from settings.json under CLAUDE_CONFIG_DIR (or the home's .claude); a missing or unreadable file gives none.
async function settingsWindow($, cfg) {
  const dir = cfg.configDir || (cfg.home ? `${cfg.home}/.claude` : undefined);
  if (!dir) return undefined;
  try {
    const settings = JSON.parse(await $.fs.read(`${dir}/settings.json`));
    return windowInt(settings?.autoCompactWindow);
  } catch { return undefined; }
}

// The compaction window and threshold, one resolver for the compaction and the own threshold. The host's breakdown first: rawMaxTokens is the
// compaction window (also after /autocompact), autoCompactThreshold the count at which it compacts. Else CLAUDE_CODE_AUTO_COMPACT_WINDOW or the
// autoCompactWindow of settings.json (both capped at the model's window), else the model's window; the threshold is the window less HOST_BUFFER.
// `detail` is the result of $.session.usage({ breakdown: 'summary' }), `usage` the one without breakdown; either may be missing. `deadline` (a time in ms) caps the
// read of settings.json at the time left.
export async function resolveWindow($, cfg, detail, usage, deadline) {
  const b = detail?.context?.breakdown;
  const raw = finitePositive(b?.rawMaxTokens);
  if (raw) {
    const threshold = finitePositive(b.autoCompactThreshold) ?? raw - HOST_BUFFER;
    return { window: raw, threshold: Math.max(1, threshold), source: `host:${typeof b.autocompactSource === 'string' ? b.autocompactSource : 'unknown'}` };
  }
  const model = finitePositive(usage?.context?.window) ?? finitePositive(detail?.context?.window);
  let window = windowInt(cfg.autoCompactWindow);
  let source = window ? 'env' : undefined;
  if (!window) { window = await hostValue($, () => settingsWindow($, cfg), deadline); if (window) source = 'settings'; }
  if (window && model) window = Math.min(window, model);
  if (!window && model) { window = model; source = 'model'; }
  if (!window) return undefined;
  return { window, threshold: Math.max(1, window - HOST_BUFFER), source };
}

// The prefix in tokens (system prompt, tools, memory files and the like): the breakdown's `used` rows but the messages row, which only its name
// tells apart; without a messages row no prefix (it would count the messages twice).
export function prefixTokens(detail) {
  const rows = detail?.context?.breakdown?.categories;
  if (!Array.isArray(rows) || !rows.some((c) => c && /^messages$/i.test(String(c.name || '').trim()))) return 0;
  return rows.reduce((s, c) => s + (c && c.kind === 'used' && !/^messages$/i.test(String(c.name || '').trim()) ? finitePositive(c.tokens) || 0 : 0), 0);
}

// The kept target after a compaction is at most the window limit divided by 1 + PREDICTION_SHORTFALL (its default, or OMC_JEV_COMPACT_RATES); no limit (unset variable) means no ceiling.
export function tokenCeiling(maxWindowTokens, rates = DEFAULT_RATES) {
  return maxWindowTokens ? Math.floor(maxWindowTokens / (1 + rates.PREDICTION_SHORTFALL)) : undefined;
}

// A one-line trace of the module, wherever it stands in a text: at its start or after a line break. A removed item (traceLine), a reply moved to a file and
// an agent's message moved to a file each fill their line; the trace of a pasted text stands inside a line (PASTE_TRACE_PREFIX, see withoutPasteMarks).
const TRACE_LINE = new RegExp(`(?:^|\\n)(?:\\[compacted\\] |${escapeRegExp(REPLY_TRACE_PREFIX)}|${escapeRegExp(AGENT_TRACE_PREFIX)})[^\\n]*`, 'g');
// The API list in tokens by class: a call costs RATE_IN a character of its name and input, a result RATE_OUT, a reminder or a text beside a result
// RATE_NOTE, the user's words RATE_OWN (a text that userWords reads as the user's: not a summary, a notice or a host block), the assistant's text
// RATE_ATXT, a trace of any of the module's stages RATE_TRACE, each non-ASCII character RATE_NON_ASCII more, RATE_BLOCK a block and RATE_MESSAGE a message spread over its blocks,
// an image RATE_IMAGE. Thinking, signatures and server blocks are not counted here.
export function listTokens(api, rates = DEFAULT_RATES) {
  const { RATE_IN, RATE_OUT, RATE_NOTE, RATE_OWN, RATE_ATXT, RATE_TRACE, RATE_NON_ASCII, RATE_BLOCK, RATE_IMAGE } = rates;
  let tok = 0;
  for (const a of api) {
    if (!a || typeof a !== 'object') continue;
    const blocks = typeof a.content === 'string' ? [{ type: 'text', text: a.content }] : Array.isArray(a.content) ? a.content.filter((b) => b && typeof b === 'object') : [];
    const hasResult = blocks.some((b) => b.type === 'tool_result');
    const before = tok;
    for (const b of blocks) {
      const over = RATE_BLOCK + RATE_MESSAGE / blocks.length;
      if (b.type === 'text') {
        const t = strOf(b.text);
        let inTraces = 0;
        const lines = t.replace(TRACE_LINE, (x) => { inTraces += x.length; return ''; });
        const rest = withoutPasteMarks(lines);
        inTraces += lines.length - rest.length;
        const rate = a.role === 'assistant' ? RATE_ATXT : hasResult || !userWords({ role: 'user', text: t }).length ? RATE_NOTE : RATE_OWN;
        tok += RATE_TRACE * inTraces + rate * rest.length + RATE_NON_ASCII * nonAscii(rest) + over;
      } else if (b.type === 'tool_use') {
        const json = inputJson(b.input);
        tok += RATE_IN * (strOf(b.name).length + json.length) + RATE_NON_ASCII * nonAscii(json) + over;
      } else if (b.type === 'tool_result') {
        const parts = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : Array.isArray(b.content) ? b.content : [];
        let text = '';
        let images = 0;
        for (const x of parts) { if (x?.type === 'text') text += strOf(x.text); else if (x?.type === 'image') images += RATE_IMAGE; }
        tok += RATE_OUT * text.length + RATE_NON_ASCII * nonAscii(text) + images + over;
      } else if (b.type === 'image') tok += RATE_IMAGE;
      else tok += over;
    }
    // RATE_MESSAGE is negative, so a message of few blocks with a low RATE_BLOCK override would cost less than nothing: a message costs zero at least.
    if (tok < before) tok = before;
  }
  return tok;
}

// The messages as API blocks (a text, a call with its name and input, a result with its text and a block for each image it holds): the estimate's input when
// the API form is missing. Every estimate from rows counts the images (the gates of cutInTokens, the tokens before and the tokens after), as itemTokens does
// for the results a cut removes.
function rowsAsApi(messages) {
  return messages.map((m) => ({
    role: m.role,
    content: [
      ...(m.text ? [{ type: 'text', text: m.text }] : []),
      ...(m.toolUses || []).map((u) => ({ type: 'tool_use', name: u.tool, input: u.input })),
      ...(m.toolResults || []).map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: imagesOf(r) ? [{ type: 'text', text: r.text || '' }, ...Array.from({ length: imagesOf(r) }, () => ({ type: 'image' }))] : r.text || '' })),
    ],
  }));
}

// The image blocks of a result as the host holds it (a list of blocks, or an object with a `content` list): each costs RATE_IMAGE, as in listTokens.
function imagesOf(r) {
  const blocks = Array.isArray(r?.result) ? r.result : Array.isArray(r?.result?.content) ? r.result.content : [];
  return blocks.filter((b) => b && b.type === 'image').length;
}

// The cost in tokens of one candidate as it stands (full), with its result shortened (short) and as its trace (trace). The images of a result are part
// of its full cost; a short copy is text only (a result with an image is never cut to a short copy: it goes to a trace first).
function itemTokens(c, rates = DEFAULT_RATES) {
  const { RATE_IN, RATE_OUT, RATE_NOTE, RATE_TRACE, RATE_NON_ASCII, RATE_IMAGE } = rates;
  if (c.note) {
    // A notification row has no call and its text is of the reminder class; its trace is a row of its own.
    const cost = (text) => RATE_NOTE * text.length + RATE_NON_ASCII * nonAscii(text);
    const full = cost(c.res.text || '');
    // The envelopes build adds come with the replacement: a row that stays whole gets its deliveries back from the host (envelopeChars sets `envelope` on the notes it rebuilds).
    const drop = RATE_NOTE * (c.envelope || 0);
    return { full, short: c.resultChars > SHORT_CHARS ? cost(shortText(c)) + drop : full, trace: RATE_TRACE * c.trace.length + drop, drop };
  }
  const json = inputJson(c.use.input);
  const call = RATE_IN * ((c.use.tool || '').length + json.length) + RATE_NON_ASCII * nonAscii(json);
  const cost = (text) => RATE_OUT * text.length + RATE_NON_ASCII * nonAscii(text);
  const full = call + cost(c.res.text || '') + RATE_IMAGE * imagesOf(c.res);
  const short = c.resultChars > SHORT_CHARS ? call + cost(shortText(c)) : full;
  return { full, short, trace: RATE_TRACE * c.trace.length, drop: 0 };
}

// What a compaction could cut, in tokens, for the two gates that decide on characters (the `too_few_results` gate of decide and the preflight of the own
// threshold). The characters of a call's input and of a result's text leave out what costs tokens without being text, an image, so with the token cascade
// (OMC_JEV_COMPACT_TARGET_PERCENT) a session that fails the gate on characters is measured here, and it passes when this reaches the same bound: `removable` is
// what every result that is no pinned one gives back when it goes to its trace (as in the floor), less the tokens of `envelopes` (the characters build adds, of the
// reminder class), and `listed` the tokens of the list it is a share of (the API form, else the rows with their images). `textTokens`: what the text stages take off
// that the cascade plans before Jev is asked (the agent trim and the reports moved to files), which the compaction counts as a cut of its own. Nothing that saves a
// token, in a candidate or in a text stage: nothing is counted.
export function cutInTokens(candidates, messages, api, envelopes = 0, rates = DEFAULT_RATES, textTokens = 0) {
  let removable = Math.max(0, textTokens);
  for (const c of candidates) {
    if (isPinned(c, rates)) continue;
    const t = itemTokens(c, rates);
    removable += Math.max(0, t.full - t.trace);
  }
  if (removable <= 0) return { removable: 0, listed: 0 };
  return { removable: removable - rates.RATE_NOTE * envelopes, listed: listTokens(api ?? rowsAsApi(messages), rates) };
}
// The bound of the gates in tokens: MIN_REDUCTION of the list, and `minGain` tokens (the own threshold's OWN_MIN_GAIN of the window; none for decide).
export function worthInTokens(cut, minGain = 0) {
  return cut.listed > 0 && cut.removable / cut.listed >= MIN_REDUCTION && cut.removable >= minGain;
}

// The tokens before the compaction, the token cascade's basis: the host's usage in the main loop, else the prefix plus the estimate of the API form. `detail`
// and `usage` are the reads the caller made (either may be missing).
function tokensBeforeOf(e, cfg, messages, api, detail, usage) {
  const real = usage?.context?.tokens;
  const main = e.agentId === undefined && finitePositive(real) !== undefined;
  return { tokens: Math.round(main ? real : prefixTokens(detail) + listTokens(api ?? rowsAsApi(messages), cfg.rates)), source: main ? 'usage' : 'estimate' };
}

// The record fields of one compaction with token accounting: the window and threshold, the tokens before (the host's usage in the main loop, else
// the prefix plus the estimate of the API form) and after (the tokens before less what the keep decisions of allocate remove), the target and its
// ceiling. Read-only: the cut itself stays with allocate.
// The host reads (`known` when the caller made them already, with `win`, the window the cascade planned with, which then stands in the record) and the settings read stay within `deadline`, the compaction's own: once it has passed the
// estimate of the API form and no window stand in the record. `installedStageTokens`: what the text stages that installed took off.
async function tokenAccounting($, e, cfg, messages, api, candidates, installedStageTokens, deadline, known = {}) {
  const detail = 'detail' in known ? known.detail : await hostValue($, () => $.session.usage({ breakdown: 'summary' }), deadline);
  const usage = 'usage' in known ? known.usage : await hostValue($, () => $.session.usage(), deadline);
  const win = known.win ?? await resolveWindow($, cfg, detail, usage, deadline);
  const real = usage?.context?.tokens;
  const main = e.agentId === undefined && finitePositive(real) !== undefined;
  const tokensBefore = Math.round(main ? real : prefixTokens(detail) + listTokens(api ?? rowsAsApi(messages), cfg.rates));
  let removed = installedStageTokens;
  for (const c of candidates) {
    const t = itemTokens(c, cfg.rates);
    removed += t.full - (c.keep === 'drop' ? t.drop : c.keep === 'short' ? t.short : c.keep === 'trace' ? t.trace : t.full);
  }
  const target = Math.floor(cfg.target * tokensBefore);
  const ceiling = tokenCeiling(cfg.maxWindowTokens, cfg.rates);
  return {
    tokens_source: main ? 'usage' : 'estimate',
    tokens_before: tokensBefore,
    tokens_after: Math.max(0, Math.round(tokensBefore - removed)),
    target_tokens: target,
    target_tokens_capped: ceiling === undefined ? target : Math.min(target, ceiling),
    window: win?.window ?? null,
    threshold: win?.threshold ?? null,
    window_source: win?.source ?? null,
  };
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
  const notes = new Map();
  for (const c of candidates) { if (c.note) notes.set(c.resIdx, c); else byId.set(c.id, c); }
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
    if (m.trimDrop === true) continue; // agent trim: a row left without a block
    // A notification row traced, cut or removed is rebuilt from its replacement text with the blocks delivered after it (a row that stays gets them back
    // from the host and falls through to the end).
    const note = notes.get(i);
    if (note && ['trace', 'short', 'drop'].includes(note.keep)) {
      const { own, text } = carriedText({ text: note.keep === 'trace' ? note.trace : note.keep === 'short' ? shortText(note) : '' }, queued.get(i));
      stats.queuedCarried += own.length;
      if (text) out.push({ role: 'user', text, toolUses: [], toolResults: [] });
      continue;
    }
    if (m.role === 'assistant' && i < keepFrom) {
      stats.rebuiltAssistant++;
      const traces = [];
      const kept = [];
      for (const u of m.toolUses || []) {
        const c = byId.get(u.tool_use_id);
        if (c && c.keep === 'trace') traces.push(c.trace);
        else if (!(c && c.keep === 'drop')) kept.push({ tool_use_id: u.tool_use_id, tool: u.tool, input: u.input });
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
        if (c && (c.keep === 'trace' || c.keep === 'drop')) continue;
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

// A lone UTF-16 surrogate (a pair cut in two by a head/tail cut, clip or slice) is not valid text: JSON.stringify writes it as a lone \udXXX
// escape, which a strict server may refuse with a 400 for the whole batch. Every string of a body that goes to Jev is made well-formed first
// (U+FFFD for each lone surrogate): String.prototype.toWellFormed where the host runtime has it, else the same by a regular expression.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const wellFormed = (text) => (typeof text.toWellFormed === 'function' ? text.toWellFormed() : text.replace(LONE_SURROGATE, '\uFFFD'));
export const wellFormedBody = (value) => JSON.stringify(value, (_key, v) => (typeof v === 'string' ? wellFormed(v) : v));

async function askJev($, cfg, state, questions) {
  const response = await $.http.fetch(cfg.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: wellFormedBody({ model: JEV_MODEL, state, questions }),
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

// Every record names the module this process loaded: module_rev is the sha256 of the module file (the digest sha256sum prints), read
// once per process through $.fs from the module's own URL, else from CLAUDE_PLUGIN_ROOT/hooks; null when neither can be read. A running
// process keeps the code it loaded, so after an update of the plugin the records say which version produced them.
const MODULE_URL = (() => { try { return import.meta.url; } catch { return undefined; } })();
function moduleRevOf($) {
  if (!session.moduleRev) {
    // Read once, within HOST_MS: a read that never settles (a stalled plugin file system) must not hold every later record, and with it
    // the compaction and the model request, so on a timeout the revision is null for the rest of the process.
    session.moduleRev = withDeadline($, (async () => {
      const paths = [];
      try {
        const u = new URL(MODULE_URL);
        if (u.protocol === 'file:') paths.push(decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1'));
      } catch { /* no URL */ }
      try {
        const root = await $.env.get('CLAUDE_PLUGIN_ROOT');
        if (root) paths.push(`${String(root).replace(/\\/g, '/').replace(/\/+$/, '')}/hooks/jev-compaction.mjs`);
      } catch { /* no root */ }
      for (const path of paths) {
        try {
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(await $.fs.read(path)));
          return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
        } catch { /* the next path */ }
      }
      return null;
    })(), HOST_MS).then((r) => (typeof r.value === 'string' ? r.value : null));
  }
  return session.moduleRev;
}

async function writeRecord($, cfg, record) {
  if (!cfg.spoolDir) return;
  try {
    let rev = null;
    try { rev = await moduleRevOf($); } catch { rev = null; }
    await $.fs.write(`${cfg.spoolDir}/${safeName(record.session_id ?? 'unknown')}--${Date.now()}-${randomId()}.json`, JSON.stringify({ ...record, module_rev: rev }));
  } catch { /* the log never breaks a compaction */ }
}

// What the first model request after a compaction of this module reports (turn.step): the input the API counted for it (input, cache
// read and cache creation tokens) against the characters the module left in the conversation. The tokens include what the characters do not
// (system prompt, tool definitions), so the two are raw measurements, not a ratio. One record per compaction, written by the first request of
// the main loop that carries usage; a newer compaction of the main loop replaces one still waiting.
async function measureAfter($, usage) {
  const p = session.pendingAfter;
  const parts = [usage?.input_tokens, usage?.cache_read_input_tokens, usage?.cache_creation_input_tokens];
  if (!p || typeof parts[0] !== 'number') return;
  const real = parts.reduce((sum, n) => sum + (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0), 0);
  if (real <= 0) return;
  session.pendingAfter = undefined;
  // A conversation swapped in the same process (not re-registered) is not the one that was compacted: the id must be known now and equal to
  // the one the compaction was armed with (installed only with a known id), else the measurement is dropped.
  let now;
  try { now = await $.session.id(); } catch { now = undefined; }
  if (typeof now !== 'string' || now !== p.sessionId) return;
  await writeRecord($, p.cfg, {
    ts: isoNow(), point: POINT, event: 'after', session_id: p.sessionId, agent_id: null, compact_ts: p.ts,
    chars_after: p.charsAfter, tokens_after_real: real, measured: 'first_request',
    // Only with the token cascade: the prediction of the tokens after, and how far it fell from the first real request (error_pct > 0: predicted higher).
    ...(p.predicted !== undefined ? { tokens_after_pred: p.predicted, error_pct: Math.round(((p.predicted - real) / real) * 1000) / 10 } : {}),
  });
}

// turn.step: every model request passes through here; the first one of the main loop after a compaction of this module that brings usage
// writes the `after` record. The measurement never breaks a request.
async function* firstRequest($, e, next) {
  const result = yield* next(e);
  try {
    // Bounded: a session id or a write that never settles must not hold the model request (the pending entry is already taken).
    if (e.agentId === undefined && session.pendingAfter) await withDeadline($, measureAfter($, result?.usage), HOST_MS);
  } catch { /* the measurement never breaks a request */ }
  return result;
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
  const noteRows = new Map(candidates.filter((c) => c.note).map((c) => [c.resIdx, c]));
  let envelopes = 0;
  for (const [i, blocks] of queued) {
    const m = messages[i];
    if (!((m.toolResults || []).length || noteRows.has(i)) || !((m.toolResults || []).every(textOnlyResult) || changing.has(i))) continue;
    const c = carriedText(m, blocks);
    const added = c.text.length - (m.text || '').length - rawChars(c.own);
    envelopes += added;
    // A notification is rebuilt only when it goes to a trace, a short copy or is dropped: its envelope costs tokens by that decision (itemTokens), not up front.
    if (noteRows.has(i)) noteRows.get(i).envelope = added;
  }
  return envelopes;
}
// What of `envelopes` belongs to the notifications (their envelopes are charged by the keep decision).
const noteEnvelopeChars = (candidates) => candidates.reduce((s, c) => s + (c.note ? c.envelope || 0 : 0), 0);

// --- pasted text (OMC_JEV_COMPACT_PASTES) ----------------------------------------------------------
// The rule is in the header: a whole tag moves only when Jev, who read all of it, says that no part of it is the user's own writing.

/** OMC_JEV_COMPACT_PASTES as `off` (unset and any other value), `shadow` or `active`; case does not matter. */
export function pasteMode(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === 'shadow' || value === 'active' ? value : 'off';
}

/**
 * The closed <pasted_content> tags of a text, in order: {start, end} of the whole tag and {from, to} of what is inside it.
 * An unclosed tag is no tag, and a tag ends at the first closing tag, so tags never nest and never join.
 */
export function pasteTags(text) {
  const open = /<pasted_content\b[^>]{0,200}>/g;
  const close = /<\/pasted_content\b[^>]{0,200}>/g;
  const tags = [];
  for (let at = 0; ;) {
    open.lastIndex = at;
    const o = open.exec(text);
    if (!o) break;
    close.lastIndex = o.index + o[0].length;
    const c = close.exec(text);
    if (!c) break;
    at = c.index + c[0].length;
    tags.push({ start: o.index, end: at, from: o.index + o[0].length, to: c.index });
  }
  return tags;
}

/**
 * OMC_JEV_COMPACT_OWNER_MARKERS: regular expression sources separated by commas (a comma inside `{}` or `[]` does not separate), each compiled with the flags `imu`. A source that is not a valid expression is ignored. Unset or empty: no patterns.
 */
export function ownerMarkerPatterns(raw) {
  const sources = [];
  let current = '';
  let braces = 0;
  let brackets = 0;
  const text = String(raw ?? '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) { current += c + text[++i]; continue; }
    if (c === '[') brackets++;
    else if (c === ']' && brackets) brackets--;
    else if (c === '{' && !brackets) braces++;
    else if (c === '}' && !brackets && braces) braces--;
    if (c === ',' && !braces && !brackets) { sources.push(current); current = ''; } else current += c;
  }
  sources.push(current);
  const patterns = [];
  for (const source of sources.map((x) => x.trim()).filter(Boolean)) {
    try { patterns.push(new RegExp(source, 'imu')); } catch { /* an invalid pattern is ignored */ }
  }
  return patterns;
}

/** Whether a text carries the user's own style as the configured patterns describe it; with no patterns it never does. */
export function ownerMarked(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

// A `<` in an excerpt is written as the JSON unicode escape of `<`, so a tag inside the excerpt is no tag when the next compaction looks for tags.
const quoted = (text) => JSON.stringify(text).replace(/</g, '\\u003c');
/** What replaces a tag of `chars` characters: the file and the first and last characters of what is inside the tag, word for word. */
export function pasteTrace(chars, inner, path) {
  return `[pasted text moved at compaction: ${chars} chars, full text in ${path}; start: ${quoted(inner.slice(0, PASTE_TRACE_HEAD))}; end: ${quoted(inner.slice(-PASTE_TRACE_TAIL))}]`;
}

const sha256Hex = async (text) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, '0')).join('');

// maskSecrets has patterns that are quadratic in the length of one long run of word characters that holds many KEY or TOKEN (30 000 characters of it take
// about 0.6 s, 90 000 about 6 s), and a synchronous scan cannot be stopped by the compaction's deadline. The stages that move a text whole never cut it before
// the check, so they check at most SCAN_MAX_CHARS of one text (`max`; a pasted tag: its own limit, which a user may raise) and SCAN_BUDGET_CHARS of all the
// text one stage checks in one compaction (`budget`: {left, deadline}). A text beyond either is `unchecked` and stays word for word, as one that holds a secret
// ('secret') does; '' means clear. A scan cannot be stopped once it has begun, so none begins at or after the deadline of the compaction ('timed_out': the text
// stays too); what one compaction can run past the deadline is one scan of one text. A stage that plans the same rows twice in one compaction (the floor and the run
// of the agent stage) scans each row once: the second plan takes the result of the first.
const SCAN_MAX_CHARS = 30000;
const SCAN_BUDGET_CHARS = 4 * SCAN_MAX_CHARS;
function secretCheck(text, privatePaths, budget, max = SCAN_MAX_CHARS) {
  if (namesSecretPath(text, privatePaths)) return 'secret';
  if (text.length > max || text.length > budget.left) return 'unchecked';
  if (budget.deadline !== undefined && Date.now() >= budget.deadline) return 'timed_out';
  budget.left -= text.length;
  return maskSecrets(text) !== text ? 'secret' : '';
}

// Rows of user messages that the host would rebuild without their image or file: an API user message holding a block besides text
// and tool results is matched to its row by text (as much of it as is text, without [Image #N] and carriage returns). `unmatched`:
// such a message with text that matches no row, so nothing can be told about any row.
const rowText = (s) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/\[Image #\d+\]/g, '').trim();
function nonTextUserRows(messages, api) {
  const withBlock = [];
  for (const a of api) {
    if (a?.role !== 'user' || !Array.isArray(a.content)) continue;
    const blocks = a.content.filter((b) => b && typeof b === 'object');
    if (blocks.some((b) => b.type !== 'text' && b.type !== 'tool_result')) {
      withBlock.push(blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => rowText(b.text)).filter(Boolean));
    }
  }
  const rows = new Set();
  const matched = new Set();
  messages.forEach((m, i) => {
    const text = rowText(m.text);
    if (m.role !== 'user' || !text) return;
    withBlock.forEach((texts, k) => { if (texts.some((x) => text.includes(x) || x.includes(text))) { rows.add(i); matched.add(k); } });
  });
  return { rows, unmatched: withBlock.some((texts, k) => texts.length > 0 && !matched.has(k)) };
}

// The rows that hold the user's words for the paste and reply stages: a user row with words of the user's own that is no hook or host row (isMeta, or
// opening with one of `prefixes`).
function ownerRows(messages, prefixes) {
  const rows = [];
  messages.forEach((m, i) => {
    if (m.isMeta === true || typeof m.text !== 'string' || prefixes.some((p) => m.text.trimStart().startsWith(p))) return;
    if (userWords(m, STAGE_NOT_USER).length) rows.push(i);
  });
  return rows;
}

// The tags to ask about, the largest PASTE_MAX_ASKS that pass every check: [{row, tag, text, inner}]. What stays, and why, is counted in
// `stats`; a reason says that nothing can move. A row that holds tool results or that a delivered block is anchored to is never rebuilt here: the
// replacement is a plain user row, so it would lose the results, or the delivery that only the row's handle brings back.
function planPastes(messages, api, keepFrom, cfg, sessionId, stats, queued = new Map(), deadline = undefined) {
  if (!cfg.pasteDir) { stats.reason = 'no_state_dir'; return []; }
  if (!sessionId) { stats.reason = 'no_session'; return []; }
  if (!api) { stats.reason = 'no_api_form'; return []; }
  const images = nonTextUserRows(messages, api);
  if (images.unmatched) { stats.reason = 'image_unmatched'; return []; }
  const users = ownerRows(messages, cfg.hookRowPrefixes);
  const before = Math.min(keepFrom, Math.max(1, messages.length - KEEP_LAST));
  const limit = cfg.pasteMaxChars;
  const found = [];
  // The first and the newest user message stay as they are.
  for (const row of users.slice(1, -1)) {
    if (row >= before || images.rows.has(row)) continue;
    const text = messages[row].text;
    const tags = pasteTags(text);
    stats.tags += tags.length;
    if (!tags.length) continue;
    if ((messages[row].toolResults || []).length) { stats.result_rows += tags.length; continue; }
    if (queued.has(row)) { stats.queued_anchor += tags.length; continue; }
    let rest = '';
    let at = 0;
    for (const t of tags) { rest += text.slice(at, t.start); at = t.end; }
    if (cutHostBlocks(rest + text.slice(at)).replace(/\s+/g, '').length < PASTE_OWN_MIN_CHARS) { stats.kept_whole += tags.length; continue; }
    for (const tag of tags) {
      const size = tag.end - tag.start;
      if (size < cfg.pasteMinChars) { stats.small++; continue; }
      if (size > limit) { stats.too_long++; continue; }
      const whole = text.slice(tag.start, tag.end);
      if (namesSecretPath(whole, cfg.privatePaths)) { stats.secret++; continue; }
      if (ownerMarked(whole, cfg.ownerMarkers)) { stats.owner_marked++; continue; }
      found.push({ row, tag, text: whole, inner: text.slice(tag.from, tag.to) });
    }
  }
  // Masking has quadratic patterns, so it runs on the largest tags only, until there are enough, and within the budget of the check.
  const jobs = [];
  const budget = { left: Math.max(SCAN_BUDGET_CHARS, PASTE_MAX_ASKS * limit), deadline };
  for (const job of found.sort((a, b) => b.text.length - a.text.length)) {
    if (jobs.length >= PASTE_MAX_ASKS) { stats.unasked++; continue; }
    const held = secretCheck(job.text, cfg.privatePaths, budget, limit);
    if (held) stats[held]++;
    else jobs.push(job);
  }
  return jobs;
}

// The probability that no part of the tag is the user's own writing, from Jev's answer; undefined when there is none.
// The tag goes whole (never cut, so every character that moves was read), as one request within the module's limits.
async function askPaste($, cfg, text, deadline) {
  const admission = await admitRequest($, cfg, deadline);
  if (admission.skip) return { held: true };
  const t0 = Date.now();
  if (t0 >= deadline) { session.requests--; return { held: true }; }
  const timeoutMs = Math.min(REQUEST_MS, deadline - t0);
  const r = await withDeadline($, askJev($, cfg, { fragment: { text, chars: text.length } }, PASTE_QUESTIONS), timeoutMs);
  const recording = recordSharedFailure($, cfg, { ...r, short: timeoutMs < 1000 });
  if (Date.now() < deadline) await withDeadline($, recording, deadline - Date.now());
  if (!r.value) { noteFailures([classifyFailure(r)], Date.now()); return {}; }
  const noul = r.value.pasted?.noul;
  return { p: typeof noul === 'boolean' ? Number(noul) : typeof noul === 'number' && noul >= 0 && noul <= 1 ? noul : undefined };
}

// Asks about the tags and marks the cleared ones (`yes`). Never rejects: a tag that cannot be asked about stays.
async function askPastes($, cfg, jobs, sessionId, stats, deadline) {
  await Promise.all(jobs.map(async (job) => {
    try {
      const name = (await sha256Hex(job.text)).slice(0, 32);
      job.path = `${cfg.pasteDir}/${safeName(sessionId)}/${name}.txt`;
      job.trace = pasteTrace(job.text.length, job.inner, job.path);
      if (job.trace.length >= job.text.length) { stats.too_short++; return; }
      const r = await askPaste($, cfg, job.text, deadline);
      if (r.held) { stats.held++; return; }
      stats.asked++;
      stats.answers.push({ name, chars: job.text.length, p: r.p ?? null });
      if (r.p === undefined) { stats.unanswered++; return; }
      if (r.p >= cfg.pasteYes) { stats.yes++; job.yes = true; } else stats.no++;
    } catch {
      stats.unanswered++;
    }
  }));
}

// Plans the tags and starts the requests about them; `record.pastes` holds the counts from here on. `active` needs the point itself active.
function startPastes($, cfg, record, messages, api, keepFrom, deadline, queued) {
  const mode = cfg.pastes === 'active' && cfg.mode === 'active' ? 'active' : 'shadow';
  const stats = { mode, tags: 0, small: 0, kept_whole: 0, too_long: 0, secret: 0, owner_marked: 0, result_rows: 0, queued_anchor: 0, unchecked: 0, too_short: 0, unasked: 0, asked: 0, held: 0, yes: 0, no: 0, unanswered: 0, written: 0, reused: 0, write_failed: 0, timed_out: 0, moved: 0, moved_chars: 0, trace_chars: 0, answers: [], ...(mode === 'active' ? { installed: false } : {}) };
  record.pastes = stats;
  let jobs = [];
  try { jobs = planPastes(messages, api, keepFrom, cfg, record.session_id, stats, queued, deadline); } catch { stats.error = 1; }
  return { stats, jobs, asks: askPastes($, cfg, jobs, record.session_id, stats, deadline) };
}

// A host file call capped at HOST_MS and at the time left; after one that hit its cap none starts.
async function fsCall($, gate, work) {
  const ms = Math.min(HOST_MS, gate.deadline - Date.now());
  if (gate.stalled || ms <= 0) return { timeout: true };
  const r = await withDeadline($, Promise.resolve().then(work), ms);
  if (r.timeout) gate.stalled = true;
  return r;
}

// Writes the text to the file and reads it back: 'written', 'reused' (the file held it already), or why not: 'timeout', 'write', 'read'.
async function savePaste($, gate, path, text) {
  const old = await fsCall($, gate, () => $.fs.read(path));
  if (old.timeout) return 'timeout';
  if (old.value === text) return 'reused';
  const put = await fsCall($, gate, () => $.fs.write(path, text));
  if (!('value' in put)) return put.timeout ? 'timeout' : 'write';
  const back = await fsCall($, gate, () => $.fs.read(path));
  if (back.timeout) return 'timeout';
  return back.value === text ? 'written' : 'read';
}

// Once the module's own result is certain (with a token target: before the plan, which takes the moved text off the prediction): writes the files
// of the tags Jev cleared (active) and returns the rebuilt user rows, each by the row it replaces. A tag stays when its file could not be written and read back whole in time.
async function movePastes($, mode, jobs, messages, stats, deadline) {
  const gate = { deadline, stalled: false };
  const moved = new Map();
  for (const job of jobs.filter((j) => j.yes)) {
    if (mode === 'active') {
      const saved = await savePaste($, gate, job.path, job.text);
      if (saved === 'written' || saved === 'reused') stats[saved]++;
      else { stats[saved === 'timeout' ? 'timed_out' : 'write_failed']++; continue; }
    }
    stats.moved++;
    stats.moved_chars += job.text.length;
    stats.trace_chars += job.trace.length;
    moved.set(job.row, [...(moved.get(job.row) ?? []), job]);
  }
  const swaps = new Map();
  if (mode !== 'active') return swaps;
  for (const [row, list] of moved) {
    const m = messages[row];
    let text = '';
    let at = 0;
    for (const j of list.sort((a, b) => a.tag.start - b.tag.start)) { text += m.text.slice(at, j.tag.start) + j.trace; at = j.tag.end; }
    swaps.set(m, { role: m.role, text: text + m.text.slice(at), toolUses: m.toolUses || [] });
  }
  return swaps;
}

// --- long replies (OMC_JEV_COMPACT_LONG_REPLIES) ---------------------------------------------------
// Long runs of assistant text well before the newest user messages move to a file and leave a trace, without a request to Jev. Nothing
// is added to or removed from the rows, so the pairing of calls and results stays as it was.

/** What replaces a run of assistant text of `chars` characters: the file and its first and last characters, word for word. */
export function replyTrace(chars, text, path) {
  return `${REPLY_TRACE_PREFIX}${chars} chars, full text in ${path}; start: ${quoted(text.slice(0, REPLY_TRACE_HEAD))}; end: ${quoted(text.slice(-REPLY_TRACE_TAIL))}]`;
}

// A line that starts a trace of this module or of the compaction (a removed call, pasted text, a moved reply).
const isTraceLine = (line) => line.startsWith('[compacted] ') || line.startsWith(PASTE_TRACE_PREFIX) || line.startsWith(REPLY_TRACE_PREFIX);

// Whether a text holds nothing but such traces and blank lines: the row a tool-only assistant message becomes once its calls are removed.
const onlyTraceLines = (text) => text.split('\n').every((line) => !line.trim() || isTraceLine(line));

/**
 * Runs of text between trace lines (a line that starts a trace of this module or of the compaction), from a non-empty line to a
 * non-empty line, of at least `minChars` characters: [{start, end}].
 */
export function replyRuns(text, minChars = REPLY_MIN_CHARS) {
  const runs = [];
  let start = -1;
  let end = -1;
  const close = () => { if (start >= 0 && end - start >= minChars) runs.push({ start, end }); start = -1; };
  for (let i = 0; i < text.length;) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(i, lineEnd);
    if (isTraceLine(line)) close();
    else if (line.trim()) { if (start < 0) start = i; end = lineEnd; }
    i = lineEnd + 1;
  }
  close();
  return runs;
}

const PASTE_MARK = '[pasted text moved at compaction: ';
const PASTE_TRACE_HEADER = /\d+ chars, full text in /y;
const PASTE_TRACE_START = '; start: "';
const PASTE_TRACE_END = '; end: "';
// The index after the JSON string whose opening quote is at `at` (a backslash takes the next character with it), or -1 when the line ends first.
function jsonStringEnd(text, at, stop) {
  for (let i = at + 1; i < stop; i++) {
    const c = text.charCodeAt(i);
    if (c === 92) i++;
    else if (c === 34) return i + 1;
  }
  return -1;
}
/**
 * The text without its traces of moved pasted text, in one pass. A trace is read by its own shape, so it ends at its own closing bracket and
 * what stands after it on the line stays: the mark, `<digits> chars, full text in `, a path without `; start: "`, then `; start: ` and `; end: ` each
 * followed by a JSON string (brackets inside the strings are text), and `]`. It is
 * text.replace(/\[pasted text moved at compaction: \d+ chars, full text in (?:(?!; start: ")[^\n])*; start: "(?:[^"\\\n]|\\[^\n])*"; end: "(?:[^"\\\n]|\\[^\n])*"\]/g, '').
 * A mark that does not open a whole trace is the user's text. Each failed read skips the marks that would fail the same way, so the cost stays linear.
 */
export function withoutPasteMarks(text) {
  let out = '';
  let at = 0;
  let from = 0;
  let lineEnd = -1;
  let start = -1; // the nearest '; start: "' at or after the last mark head; Infinity once there is none
  for (;;) {
    const open = text.indexOf(PASTE_MARK, from);
    if (open < 0) break;
    if (lineEnd < open) { const nl = text.indexOf('\n', open); lineEnd = nl < 0 ? text.length : nl; }
    const head = open + PASTE_MARK.length;
    PASTE_TRACE_HEADER.lastIndex = head;
    if (!PASTE_TRACE_HEADER.test(text)) { from = open + 1; continue; }
    const pathFrom = PASTE_TRACE_HEADER.lastIndex;
    if (start < head) { start = text.indexOf(PASTE_TRACE_START, head); if (start < 0) start = Infinity; }
    if (start === Infinity || start >= lineEnd) { from = lineEnd + 1; continue; } // no start on the rest of the line: nor for a later mark of it
    if (start < pathFrom) { from = open + 1; continue; }
    const first = jsonStringEnd(text, start + PASTE_TRACE_START.length - 1, lineEnd);
    const second = first < 0 || !text.startsWith(PASTE_TRACE_END, first) ? -1 : jsonStringEnd(text, first + PASTE_TRACE_END.length - 1, lineEnd);
    if (second < 0 || text[second] !== ']' || second >= lineEnd) { from = start; continue; } // a mark before this start fails the same way
    out += text.slice(at, open);
    at = from = second + 1;
  }
  return out + text.slice(at);
}

/**
 * The assistant replies that answer a user message directly, which the stage never takes text from: after each user message that still
 * holds words of its own (not only the traces of pasted text), the first row with text and the last one before the next user message.
 * `delivered`: rows that a message the user typed during a tool turn is anchored to (it stands after the row, in the API form only); each
 * is a user message of its own that holds words by definition, so the replies after it are direct replies too.
 * A row that holds only traces (a tool-only message after an earlier compaction) is no reply and is passed over.
 * The interval runs to the next user message, so a notification in the middle does not end it. Over-protection costs tokens, never text.
 * Only the structure decides; whether the reply confirms or corrects what the user said is not for the code to read.
 */
export function directReplyRows(messages, users, delivered = []) {
  const rows = new Set();
  const sent = new Set(delivered);
  const bounds = [...new Set([...users, ...sent])].sort((a, b) => a - b);
  bounds.forEach((row, n) => {
    if (!sent.has(row) && !withoutPasteMarks(String(messages[row].text ?? '')).trim()) return;
    const stop = n + 1 < bounds.length ? bounds[n + 1] : messages.length;
    let first = -1;
    let last = -1;
    for (let j = row + 1; j < stop; j++) {
      const m = messages[j];
      if (m.role === 'assistant' && typeof m.text === 'string' && m.text.trim() && !onlyTraceLines(m.text)) { if (first < 0) first = j; last = j; }
    }
    if (first >= 0) { rows.add(first); rows.add(last); }
  });
  return rows;
}

// Assistant rows that the host could not rebuild from text: matched, by a tool use id or by text, to an API assistant message holding a
// block besides text, tool_use, thinking and redacted_thinking (server blocks above all).
function nonTextAssistantRows(messages, api) {
  const ids = new Set();
  const texts = [];
  for (const a of api) {
    if (a?.role !== 'assistant' || !Array.isArray(a.content)) continue;
    const blocks = a.content.filter((b) => b && typeof b === 'object');
    if (!blocks.some((b) => !['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(b.type))) continue;
    for (const b of blocks) if (b.type === 'tool_use' && typeof b.id === 'string') ids.add(b.id);
    texts.push(...blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => rowText(b.text)).filter(Boolean));
  }
  const rows = new Set();
  messages.forEach((m, i) => {
    if (m.role !== 'assistant') return;
    const text = rowText(m.text);
    if ((m.toolUses || []).some((u) => ids.has(u.tool_use_id)) || (text && texts.some((x) => text.includes(x) || x.includes(text)))) rows.add(i);
  });
  return rows;
}

// Plans the runs that may move: [{row, start, end, text, path, trace}]. What stays, and why, is counted in `stats`; a reason says that nothing can move.
async function planReplies(cfg, messages, api, keepFrom, sessionId, stats, queued = new Map(), deadline = undefined) {
  if (!cfg.pasteDir) { stats.reason = 'no_state_dir'; return []; }
  if (!sessionId) { stats.reason = 'no_session'; return []; }
  if (!api) { stats.reason = 'no_api_form'; return []; }
  const users = ownerRows(messages, cfg.hookRowPrefixes);
  // A message the user typed during a tool turn is a user message too, though no row shows it: it stands after the row it is anchored to (queuedOf).
  const delivered = [...queued].filter(([, blocks]) => blocks.some((b) => deliveryOf(b) === 'user')).map(([row]) => row);
  const userRows = [...new Set([...users, ...delivered])].sort((a, b) => a - b);
  const turns = [];
  messages.forEach((m, i) => { if (m.role === 'user' && !(m.toolResults || []).length && typeof m.text === 'string' && m.text.trim()) turns.push(i); });
  const limit = Math.min(
    Math.min(keepFrom, Math.max(1, messages.length - KEEP_LAST)),
    userRows.length >= REPLY_KEEP_OWNERS ? userRows[userRows.length - REPLY_KEEP_OWNERS] : 0,
    turns.length >= REPLY_KEEP_TURNS ? turns[turns.length - REPLY_KEEP_TURNS] : 0,
  );
  stats.limit_row = limit;
  const skip = nonTextAssistantRows(messages, api);
  const direct = directReplyRows(messages, users, delivered);
  const jobs = [];
  const budget = { left: SCAN_BUDGET_CHARS, deadline };
  for (let row = 0; row < limit; row++) {
    const m = messages[row];
    if (m.role !== 'assistant' || !m.text) continue;
    stats.assistant_rows++;
    if (skip.has(row)) { stats.skipped_blocks++; continue; }
    if (direct.has(row)) { stats.direct_replies++; continue; }
    stats.considered++;
    for (const run of replyRuns(m.text)) {
      stats.runs++;
      const text = m.text.slice(run.start, run.end);
      const held = secretCheck(text, cfg.privatePaths, budget);
      if (held) { stats[held]++; continue; }
      const path = `${cfg.pasteDir}/${safeName(sessionId)}/${(await sha256Hex(text)).slice(0, 32)}.txt`;
      const trace = replyTrace(text.length, text, path);
      if (trace.length > text.length - REPLY_MIN_SAVING) { stats.too_short++; continue; }
      jobs.push({ row, ...run, text, path, trace });
    }
  }
  return jobs;
}

// Once the module's own result is certain (with a token target: before the plan, which takes the moved text off the prediction): plans the runs,
// writes their files (active) and returns the new text of each changed row by its row index. A run stays when its file could not be written and read back whole in time. Never rejects.
async function moveReplies($, cfg, record, messages, api, keepFrom, deadline, queued) {
  const mode = cfg.replies === 'active' && cfg.mode === 'active' ? 'active' : 'shadow';
  const stats = { mode, assistant_rows: 0, considered: 0, skipped_blocks: 0, direct_replies: 0, limit_row: 0, runs: 0, secret: 0, unchecked: 0, too_short: 0, written: 0, reused: 0, write_failed: 0, timed_out: 0, moved: 0, moved_chars: 0, trace_chars: 0, ...(mode === 'active' ? { installed: false } : {}) };
  record.replies = stats;
  const edited = new Map();
  try {
    const gate = { deadline, stalled: false };
    const byRow = new Map();
    for (const job of await planReplies(cfg, messages, api, keepFrom, record.session_id, stats, queued, deadline)) {
      if (mode === 'active') {
        const saved = await savePaste($, gate, job.path, job.text);
        if (saved === 'written' || saved === 'reused') stats[saved]++;
        else { stats[saved === 'timeout' ? 'timed_out' : 'write_failed']++; continue; }
      }
      stats.moved++;
      stats.moved_chars += job.text.length;
      stats.trace_chars += job.trace.length;
      byRow.set(job.row, [...(byRow.get(job.row) ?? []), job]);
    }
    if (mode === 'active') {
      for (const [row, list] of byRow) {
        let text = '';
        let at = 0;
        for (const j of list) { text += messages[row].text.slice(at, j.start) + j.trace; at = j.end; }
        edited.set(row, text + messages[row].text.slice(at));
      }
    }
  } catch { stats.error = 1; }
  return edited;
}

// The tokens that the agent stage's text moved to files comes off: the file's text at RATE_MOVED less its trace at RATE_TRACE.
const movedTokensOf = (st, rates) => rates.RATE_MOVED * st.moved_chars - rates.RATE_TRACE * st.trace_chars;

// The agent stage of one compaction before its text is moved: the trim of the rows before the tail (`stats` for the record, `trimmed` the rows as it leaves
// them, `trimTokens` what it takes off), the options of the stage (`opts`, none without the API form, in a subagent or with the trim off) and `plan()`,
// what the stage would move (a plan, no write), asked once. `keepFrom` is the first row that keeps its handle. The compaction and the preflight of the
// own threshold read the stage through this one function, so that both count the same text.
function agentStageOf($, cfg, agentId, messages, api, queued, keepFrom, sessionId, deadline, checked = new Map()) {
  let trim;
  let stats;
  const skip = cfg.agentTrim && agentId === undefined && api ? nonTextUserRows(messages, api) : undefined;
  const from = Math.min(keepFrom, Math.max(1, messages.length - KEEP_LAST));
  if (skip && !skip.unmatched) {
    try {
      trim = trimAgentRows(messages, { keepFrom: from, skipRows: skip.rows, queuedRows: queued, statePattern: cfg.agentStates, deadline });
      stats = trim.stats;
    } catch (error) { trim = undefined; stats = { error: clip(oneLine(String(error?.message ?? error)), 200) }; }
  }
  const trimmed = trim && trim.rows.size ? messages.map((m, i) => trim.rows.get(i) ?? m) : messages;
  const trimTokens = trim ? cfg.rates.RATE_ATT * trim.stats.chars : 0;
  // Agent messages to files: decided on the rows as the trim leaves them, filed as they came (source); the window of rows and the files are the same in the plan and in the run.
  const opts = skip ? { sessionId, source: messages, skipRows: Object.assign(new Set(skip.rows), { unmatched: skip.unmatched }), keepFrom: from, queuedRows: queued, statePattern: cfg.agentStates, checked } : undefined;
  let planned;
  return { stats, trimmed, trimTokens, opts, plan: () => (planned ??= moveAgentMessages($, cfg, trimmed, { ...opts, write: false, deadline })) };
}

// The checks for a secret that the preflight of the own threshold made (each scan of a long report is synchronous and quadratic), for the compaction it asks for
// right after: the rows are the same, and a row whose text changed is checked again (moveAgentMessages compares the text). Taken once, for the session that made
// them, and only by the compaction the preflight is waiting for (ownCompactInFlight) under the private paths it checked with: any other compaction, or one
// under other settings, checks again. A check that timed out is not a result and is made again.
function takeAgentChecks(sessionId, cfg) {
  const kept = session.agentChecked;
  session.agentChecked = undefined;
  if (!kept || !sessionId || kept.id !== sessionId || !session.ownCompactInFlight || kept.paths !== JSON.stringify(cfg.privatePaths)) return new Map();
  for (const [row, c] of kept.checked) if (c.held === 'timed_out') kept.checked.delete(row);
  return kept.checked;
}

// What the agent stage takes off, in tokens, before Jev is asked: the trim, and with the stage active the files it plans to write.
async function agentStageTokens(cfg, stage) {
  return stage.trimTokens + (stage.opts && cfg.mode === 'active' ? movedTokensOf((await stage.plan()).stats, cfg.rates) : 0);
}

// Decides one compaction: {messages} to install or {fallback: reason}. Fills `record`; never calls next.
// --- agent trim (OMC_JEV_COMPACT_AGENT_TRIM) ---------------------------------------------------------------------------------------------
// In a coordinator's session the reports of team agents arrive as whole user rows: "Another Claude session sent a message:", one or more closed
// <teammate-message>, <agent-message> or <cross-session-message> blocks, and the host's fixed note after them. Before the tail the trim cuts out the host's
// frame (the opening line before a <teammate-message and the note after any of the three blocks) and every idle_notification block that only carries a state
// or duplicates a report: an empty result; a result of at most TRIM_STATE_MAX characters opening or ending with a configured state phrase; such a result of
// any length when the agent's earlier message in this conversation has the notification's summary; a result of at least TRIM_DUP_MIN characters found whole
// in the agent's earlier messages. A row left with nothing but blank space is removed whole (build skips it: trimDrop), except the row right before the
// tail, which keeps its notification without the frame (an assistant row with a handle may follow it). An idle notification that is the only carrier of a
// report stays as the agent's message. Rows with the owner's words, a delivered block anchored to them or a block the host cannot rebuild from text stay as
// they are.
const TRIM_HEAD = 'Another Claude session sent a message:';
const TRIM_NOTE = /^\n*This came from another Claude session[^\n]*?permission laundering\./; // the note after a block, read from the start of the text after it
const TRIM_STATE_MAX = 200; // a longer result is a state only when the agent's earlier message carries its summary
const TRIM_DUP_MIN = 40; // a shorter result is never a duplicate by its text
// The search of a result in everything an agent said is linear in that text and makes no progress it could be stopped at, so the characters one trim searches
// are bounded: past the budget a result is no duplicate by its text (it stays, as every other result the search does not find does).
const TRIM_SEARCH_BUDGET_CHARS = 10_000_000;
const trimNorm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
// The pattern of a state result: a configured phrase at the start or at the end (a phrase may be followed by `: ...` at the end). No phrases, no state
// (only an empty result and a repeated report are removed then).
export function agentStatePattern(raw) {
  const phrases = String(raw ?? '').split(',').map((x) => x.trim()).filter(Boolean).map(escapeRegExp);
  if (!phrases.length) return /(?!)/u;
  const any = phrases.join('|');
  return new RegExp(`^(?:${any})(?![\\p{L}\\p{N}_])|(?:^|\\s)(?:${any})(?::[^\\n]*)?\\.?\\s*$`, 'iu');
}
function trimIdle(body) {
  const t = body.trim();
  if (!t.startsWith('{') || !t.slice(0, 200).includes('"idle_notification"')) return undefined;
  try { const d = JSON.parse(t); return d && d.type === 'idle_notification' ? d : undefined; } catch { return undefined; }
}
const trimRow = (m, text) => ({ role: m.role, text, toolUses: m.toolUses || [], ...(m.toolResults ? { toolResults: m.toolResults } : {}) });
// The blocks of an agent row: a <teammate-message>, <agent-message> or <cross-session-message> up to its closing tag. The tags are paired by nesting (a closing
// tag closes the latest open block of its name), so a block that quotes a whole block of its own kind keeps it inside, and every change below touches only the
// blocks that stand outside every other block and the text around them. Returns {blocks, loose}: those blocks (name, at, end, attrs: the text between the name and
// the '>' of the opening tag, bodyFrom, bodyTo) and whether a tag outside them has no partner (an opener without its closing tag, a closing tag without its
// opener, blocks that cross): such a row is not read as a whole and no change is made to it. A value in an opening tag may hold '>'. The tags are read in one
// pass (the '>' of an opening tag is the first one after it that has the same parity of quotes before it), so a row of many unclosed tags, unclosed quotes or
// stray closing tags is read in linear time.
const BLOCK_NAMES = 'teammate-message|agent-message|cross-session-message';
const BLOCK_TOKEN = new RegExp(`</(${BLOCK_NAMES})>|<(${BLOCK_NAMES})\\b|"|>`, 'g');
export function agentBlocks(text) {
  const opens = [];
  const closes = [];
  const gts = [[], []]; // the positions of '>' by the parity of the quotes before them
  let parity = 0;
  for (const t of text.matchAll(BLOCK_TOKEN)) {
    if (t[0] === '"') parity ^= 1;
    else if (t[0] === '>') gts[parity].push(t.index);
    else if (t[1]) { closes.push({ name: t[1], at: t.index, end: t.index + t[0].length }); gts[parity].push(t.index + t[0].length - 1); }
    else opens.push({ name: t[2], at: t.index, nameEnd: t.index + t[0].length, parity });
  }
  const next = [0, 0];
  const stacks = new Map();
  const pairs = [];
  const stray = [];
  let tagEnd = 0; // where the opening tag read last ends: a token inside it is part of it
  for (let i = 0, j = 0; i < opens.length || j < closes.length;) {
    if (j >= closes.length || (i < opens.length && opens[i].at < closes[j].at)) {
      const o = opens[i++];
      if (o.at < tagEnd) continue;
      const list = gts[o.parity];
      while (next[o.parity] < list.length && list[next[o.parity]] < o.nameEnd) next[o.parity]++;
      if (next[o.parity] >= list.length) continue; // no '>' ends the tag: it is text
      o.tagEnd = list[next[o.parity]] + 1;
      tagEnd = o.tagEnd;
      if (!stacks.has(o.name)) stacks.set(o.name, []);
      stacks.get(o.name).push(o);
    } else {
      const c = closes[j++];
      if (c.at < tagEnd) continue;
      const open = stacks.get(c.name)?.pop();
      if (open) pairs.push({ name: c.name, at: open.at, end: c.end, tagEnd: open.tagEnd, bodyTo: c.at });
      else stray.push(c.at);
    }
  }
  for (const list of stacks.values()) for (const o of list) stray.push(o.at);
  pairs.sort((x, y) => x.at - y.at);
  const blocks = [];
  let loose = false;
  let to = 0;
  for (const p of pairs) {
    if (p.at < to) { if (p.end > to) loose = true; continue; } // inside a block (and across its end: loose)
    blocks.push({ name: p.name, at: p.at, end: p.end, attrs: text.slice(p.at + 1 + p.name.length, p.tagEnd - 1), bodyFrom: p.tagEnd, bodyTo: p.bodyTo });
    to = p.end;
  }
  stray.sort((x, y) => x - y);
  for (let k = 0, i = 0; !loose && k < stray.length; k++) {
    while (i < blocks.length && blocks[i].end <= stray[k]) i++;
    if (i === blocks.length || stray[k] < blocks[i].at) loose = true;
  }
  return { blocks, loose };
}
// The row with the host's frame cut where it stands outside the blocks: the header before a <teammate-message> block and the note after a block. The text of a
// block (a report that quotes a whole message with its header and note too) is never read. `drop` names the blocks to remove; the blank space between two blocks
// that stay becomes one blank line, and the row is trimmed. Returns {text, removed, header, note}.
function reframe(row, blocks, drop) {
  const out = { removed: 0, header: false, note: false };
  let text = '';
  let between = ''; // the text outside the blocks since the last block that stayed
  let stayed = false;
  let at = 0;
  for (let k = 0; k <= blocks.length; k++) {
    let gap = row.slice(at, k < blocks.length ? blocks[k].at : row.length);
    const note = TRIM_NOTE.exec(gap);
    if (note && k > 0) { gap = gap.slice(note[0].length); out.note = true; }
    const head = gap.indexOf(TRIM_HEAD);
    if (head >= 0 && k < blocks.length && blocks[k].name === 'teammate-message' && !gap.slice(0, head).trim() && !gap.slice(head + TRIM_HEAD.length).trim()) {
      gap = gap.slice(0, head) + gap.slice(head + TRIM_HEAD.length).replace(/^\n/, '');
      out.header = true;
    }
    between += gap;
    if (k === blocks.length) break;
    if (drop(blocks[k])) out.removed++;
    else {
      if (stayed && !between.trim() && between.includes('\n')) between = '\n\n';
      text += between + row.slice(blocks[k].at, blocks[k].end);
      between = '';
      stayed = true;
    }
    at = blocks[k].end;
  }
  out.text = (text + between).trim();
  return out;
}
// opts: keepFrom (the first row of the tail), skipRows (a Set of rows the host cannot rebuild from text), queuedRows (a Map of rows with delivered blocks
// anchored to them), statePattern, deadline (no row is started after it: the rest stays as it is, `timed_out` in the stats). Returns {rows: Map row -> rebuilt row, saved: Map row -> characters, stats}.
export function trimAgentRows(messages, opts = {}) {
  const tail = Number.isInteger(opts.keepFrom) ? opts.keepFrom : Math.max(1, messages.length - KEEP_LAST);
  const skip = opts.skipRows instanceof Set ? opts.skipRows : new Set();
  const queued = opts.queuedRows instanceof Map ? opts.queuedRows : new Map();
  const state = opts.statePattern instanceof RegExp ? opts.statePattern : agentStatePattern('');
  const stats = { rows: 0, pre: 0, note: 0, idle_removed: 0, idle_kept: 0, rows_dropped: 0, chars: 0, anchored: 0, unbalanced: 0 };
  const rows = new Map();
  const saved = new Map();
  let searchLeft = TRIM_SEARCH_BUDGET_CHARS;
  const said = new Map(); // what every agent said outside idle notifications in the rows before the current one: summaries and bodies
  const learn = (m) => {
    if (m.role !== 'user' || (m.toolResults || []).length || typeof m.text !== 'string' || m.text.length > AGENT_ROW_MAX_CHARS || !m.text.includes('<teammate-message')) return;
    const { blocks, loose } = agentBlocks(m.text);
    if (loose) return;
    for (const b of blocks) {
      if (b.name !== 'teammate-message') continue;
      const body = m.text.slice(b.bodyFrom, b.bodyTo);
      if (trimIdle(body)) continue;
      const who = (/teammate_id="([^"]*)"/.exec(b.attrs) || [])[1] || '';
      const sum = (/summary="([^"]*)"/.exec(b.attrs) || [])[1] || '';
      const e = said.get(who) || { sums: new Set(), body: '' };
      if (sum) e.sums.add(trimNorm(sum));
      e.body += ` ${trimNorm(body)}`;
      said.set(who, e);
    }
  };
  for (let i = 1; i < tail; i++) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) { stats.timed_out = 1; break; }
    const m = messages[i];
    const row = m.role === 'user' && !(m.toolResults || []).length && typeof m.text === 'string' && m.text.length <= AGENT_ROW_MAX_CHARS ? m.text : undefined;
    const lead = row === undefined ? '' : row.trimStart();
    const agent = (lead.startsWith(TRIM_HEAD) || lead.startsWith('<teammate-message')) && /<\/(?:teammate-message|agent-message|cross-session-message)>/.test(row);
    if (!agent || skip.has(i) || queued.has(i) || userWords(m, STAGE_NOT_USER).length || row.includes(QUEUED_PREFIX)) {
      if (agent && (skip.has(i) || queued.has(i))) stats.anchored++; // anchored: kept with its frame
      learn(m);
      continue;
    }
    const { blocks, loose } = agentBlocks(row);
    if (loose || !blocks.length) { stats.unbalanced++; learn(m); continue; } // a tag without its partner: the row is left as it is
    stats.rows++;
    // The idle notifications: only a block that stands outside every other block, so a report that quotes one keeps it.
    const idle = (b) => {
      if (b.name !== 'teammate-message') return false;
      const body = row.slice(b.bodyFrom, b.bodyTo);
      const d = trimIdle(body);
      if (!d) return false;
      const who = typeof d.from === 'string' ? d.from : (/teammate_id="([^"]*)"/.exec(b.attrs) || [])[1] || '';
      const r = trimNorm(d.result);
      const e = said.get(who);
      const isState = state.test(r);
      const inBody = () => {
        if (!(r.length >= TRIM_DUP_MIN && e) || e.body.length > searchLeft) return false;
        searchLeft -= e.body.length;
        return e.body.includes(r);
      };
      const dup = !r || (isState && r.length <= TRIM_STATE_MAX) || (isState && d.summary && e && e.sums.has(trimNorm(d.summary))) || inBody();
      if (!dup) stats.idle_kept++;
      return Boolean(dup);
    };
    const cut = reframe(row, blocks, idle);
    let text = cut.text;
    let framed = cut;
    if (!text && i !== tail - 1) { stats.idle_removed += cut.removed; stats.rows_dropped++; stats.chars += row.length; saved.set(i, row.length); rows.set(i, { ...trimRow(m, ''), trimDrop: true }); learn(m); continue; }
    // The row right before the tail: its notification stays, without the frame.
    if (!text) { framed = reframe(row, blocks, () => false); text = framed.text; } else stats.idle_removed += cut.removed;
    // A row that would open with <agent-message> or <cross-session-message> keeps the host's header, which tells it from the owner's words.
    if (lead.startsWith(TRIM_HEAD) && !text.startsWith('<teammate-message') && !text.startsWith(TRIM_HEAD)) text = `${TRIM_HEAD}\n${text}`;
    if (framed.note) stats.note++;
    if (framed.header && !text.startsWith(TRIM_HEAD)) stats.pre++;
    if (text !== row) { stats.chars += row.length - text.length; saved.set(i, row.length - text.length); rows.set(i, trimRow(m, text)); }
    learn(m);
  }
  return { rows, saved, stats };
}

// --- agent messages to files (OMC_JEV_COMPACT_AGENT_TRIM, with the trim above) --------------------------------------------------------------
// In a coordinator's session the reports of team agents are whole user rows. Besides the frame the trim cuts, an older row of this kind moves whole to a file
// and a one-line trace takes its place: the sender, the time when the message carries one (an idle notification's timestamp), a summary (the `summary`
// attribute, else an idle notification's result, an agent's state with its summary, the last message it sent, else the start of the body) and, once, the path
// and the size. The trace says the message is not the user's, so the module's own readings never take it for the user's words. Lossless, without a request
// to Jev, main loop only. Whole stay: the first row, the tail, the last AGENT_KEEP_LAST rows of this kind (a row of state-only idle notifications takes no
// place among them: the trim removes it), a row of the session's lead (AGENT_LEAD, and every sender of the first row when another session started this
// one with it), a row with the user's words (a delivered block, QUEUED_PREFIX anywhere in it, or a row opening with a block without the host's header) or
// that a delivered block is anchored to, a row with a JSON body other than an idle notification (a request waiting for an answer), a row the host cannot
// rebuild from text (an unmatched API message with a non-text block stops the stage), a row shorter than AGENT_MIN_CHARS or than its trace, and a row with
// a secret (a secret path, or anything maskSecrets would change; also in its trace). The stage decides on the rows as the trim leaves them; the file holds the
// row as it came.
const AGENT_MIN_CHARS = 800;
// A row longer than this is no agent row for the trim and the move: it stays as it is. (Reading a row is linear; this bounds what one row can cost, and the
// text a file may hold.)
const AGENT_ROW_MAX_CHARS = 60000;
const AGENT_KEEP_LAST = 6;
const AGENT_SUMMARY_CHARS = 150;
const AGENT_SENT_CHARS = 60;
const AGENT_SENDERS_MAX = 4;
const AGENT_OPENERS = ['Another Claude session sent a message', '<teammate-message', '<agent-message', '<cross-session-message'];
const AGENT_BARE = /^\s*<(?:agent-message|cross-session-message)\b/; // a row that opens with one of these blocks has no header of the host: it is read as the user's words
const AGENT_LEAD = 'team-lead'; // the teammate_id of a team's lead in its members' sessions
const utf8Bytes = (text) => new TextEncoder().encode(text).length;
// A row is read as one of blocks only when every tag in it has its partner: with a stray tag the pairing of the rest is a guess (a quoted opener would take the
// closing tag of the real block, and the sender would be the quoted one), so such a row is no agent row for the trim and the move.
// Whether what stands outside the blocks of a row is the host's framing only: its opening line before a block and its note after one (the two the trim cuts), and
// blank space. Words of anyone else there (an instruction typed after the report) make the row a mixed one: it is no agent message to move whole.
function framingOnly(text) {
  const { blocks } = agentBlocks(text);
  let at = 0;
  for (let k = 0; k <= blocks.length; k++) {
    let gap = text.slice(at, k < blocks.length ? blocks[k].at : text.length);
    if (k > 0) gap = gap.replace(TRIM_NOTE, '');
    const head = gap.indexOf(TRIM_HEAD);
    if (head >= 0) gap = gap.slice(0, head) + gap.slice(head + TRIM_HEAD.length);
    if (gap.trim()) return false;
    if (k < blocks.length) at = blocks[k].end;
  }
  return true;
}
const wholeBlocks = (text) => { const { blocks, loose } = agentBlocks(text); return blocks.length > 0 && !loose; };
const isAgentRow = (m) => m.role === 'user' && !(m.toolResults || []).length && typeof m.text === 'string' && m.text.length <= AGENT_ROW_MAX_CHARS && AGENT_OPENERS.some((p) => m.text.trimStart().startsWith(p)) && wholeBlocks(m.text);
const agentWord = (v, max) => Array.from(oneLine(typeof v === 'string' ? v : '').replace(/[<>[\]"]/g, '')).slice(0, max).join(''); // by code point: never half a surrogate pair
// Who, when and what of each block, in order.
export function agentSenders(text, statePattern = agentStatePattern('')) {
  const out = [];
  for (const b of agentBlocks(text).blocks) {
    const at = {};
    // A name starts where no name character precedes it, so a long run of them is tried once, not from every character.
    for (const a of b.attrs.matchAll(/(?<![\w-])([\w-]+)="([^"]*)"/g)) at[a[1]] = a[2];
    let who = at.teammate_id || at['from-name'] || at.from || at.name || '';
    let when = at.timestamp || '';
    let what = at.summary || '';
    let idle = false;
    let state = false;
    let sent = '';
    let json = '';
    const body = text.slice(b.bodyFrom, b.bodyTo).trim();
    if (body.startsWith('{')) {
      try {
        const j = JSON.parse(body);
        if (j && typeof j === 'object' && !Array.isArray(j)) {
          json = typeof j.type === 'string' ? j.type : '?';
          idle = j.type === 'idle_notification';
          who ||= typeof j.from === 'string' ? j.from : '';
          when ||= typeof j.timestamp === 'string' ? j.timestamp : '';
          // An idle notification: its result is the agent's state, its summary the last message it sent.
          const result = typeof j.result === 'string' ? j.result : '';
          const summary = typeof j.summary === 'string' ? j.summary : '';
          const r = trimNorm(result);
          state = idle && (!r || (statePattern.test(r) && r.length <= TRIM_STATE_MAX)); // what the trim removes before the tail
          if (!what) { what = result || summary || (typeof j.type === 'string' ? j.type : ''); if (result && summary) sent = summary; }
        }
      } catch { /* not JSON: the body is the message */ }
    }
    out.push({ who, when, idle, state, sent, json, what: what || body });
  }
  return out;
}
// The trace is a function of the path and the row's text only, so its length is known before the write.
export function agentTrace(path, text, statePattern) {
  const all = agentSenders(text, statePattern);
  const when = (w) => (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(w) ? `, ${w.slice(0, 10)} ${w.slice(11, 19)} UTC` : w ? `, ${agentWord(w, 40)}` : '');
  const parts = all.slice(0, AGENT_SENDERS_MAX).map((s) => `from ${agentWord(s.who, 64) || 'an unknown sender'}${s.idle ? ` (idle${s.sent ? `, last: "${agentWord(s.sent, AGENT_SENT_CHARS)}"` : ''})` : ''}${when(s.when)}: "${agentWord(s.what, AGENT_SUMMARY_CHARS)}"`);
  if (all.length > AGENT_SENDERS_MAX) parts.push(`and ${all.length - AGENT_SENDERS_MAX} more`);
  return `${AGENT_TRACE_PREFIX}${path} (${text.length} chars, ${utf8Bytes(text)} bytes); ${parts.join('; ')}]`;
}
const agentSecret = (text, privatePaths) => namesSecretPath(text, privatePaths) || maskSecrets(text) !== text;

// Plans the rows that move and, with opts.write, writes their files. opts: sessionId, skipRows (a Set of rows the host cannot rebuild from text, with
// `unmatched`), keepFrom, queuedRows, statePattern, write (default true), deadline (of the writes, and of the checks for a secret: none begins after it, the row stays
// and counts as timed out), source (the rows before the trim: a file holds the row as it came, whatever the trim cut from it; the tokens that leave the conversation are
// those of the row as the trim left it), checked (a Map the caller keeps across calls on the same rows: a row that was checked once is not checked again, so the floor's
// plan and the run of one compaction scan each row once). Returns {rows: Map row -> rebuilt row, stats}; the tokens it saves are RATE_MOVED * moved_chars - RATE_TRACE * trace_chars
// of the stats. Never rejects.
export async function moveAgentMessages($, cfg, messages, opts = {}) {
  const write = opts.write !== false;
  const stats = { mode: write ? 'active' : 'plan', agent_rows: 0, limit_row: 0, kept_last: 0, considered: 0, skipped_blocks: 0, owner_words: 0, lead: 0, queued_anchor: 0, pending_json: 0, secret: 0, unchecked: 0, too_short: 0, too_short_chars: 0, written: 0, reused: 0, write_failed: 0, timed_out: 0, moved: 0, moved_chars: 0, trace_chars: 0, ...(write ? { installed: false } : {}) };
  const rows = new Map();
  try {
    if (!cfg.pasteDir) { stats.reason = 'no_state_dir'; return { rows, stats }; }
    if (!opts.sessionId) { stats.reason = 'no_session'; return { rows, stats }; }
    const skip = opts.skipRows instanceof Set ? opts.skipRows : undefined;
    if (!skip) { stats.reason = 'no_api_form'; return { rows, stats }; }
    if (skip.unmatched) { stats.reason = 'image_unmatched'; return { rows, stats }; }
    const state = opts.statePattern instanceof RegExp ? opts.statePattern : agentStatePattern('');
    const agentRows = [];
    messages.forEach((m, i) => { if (isAgentRow(m)) agentRows.push(i); });
    stats.agent_rows = agentRows.length;
    const senders = new Map(agentRows.map((i) => [i, agentSenders(messages[i].text, state)]));
    const tail = Number.isInteger(opts.keepFrom) ? opts.keepFrom : Math.max(1, messages.length - KEEP_LAST);
    // A row of state-only idle notifications (the trim removes it before the tail) takes no place among the last AGENT_KEEP_LAST.
    const counted = agentRows.filter((i) => !senders.get(i).every((x) => x.state));
    const limit = Math.min(tail, counted.length > AGENT_KEEP_LAST ? counted[counted.length - AGENT_KEEP_LAST] : 0);
    stats.limit_row = limit;
    stats.kept_last = counted.filter((i) => i >= limit && i < tail).length;
    const queued = opts.queuedRows instanceof Map ? opts.queuedRows : new Map();
    // The messages of whoever leads this session are its task, as the user's are: those of a team's lead and of every sender of the first row when
    // another session started this one with it.
    const leads = new Set([AGENT_LEAD, ...(agentRows[0] === 0 ? senders.get(0).map((x) => x.who).filter(Boolean) : [])]);
    const jobs = [];
    const budget = { left: SCAN_BUDGET_CHARS, deadline: opts.deadline };
    const checked = opts.checked instanceof Map ? opts.checked : undefined;
    for (const i of agentRows) {
      if (i === 0 || i >= tail) continue;
      const m = messages[i];
      if (skip.has(i)) { stats.skipped_blocks++; continue; }
      if (userWords(m, STAGE_NOT_USER).length || m.text.includes(QUEUED_PREFIX) || AGENT_BARE.test(m.text) || !framingOnly(m.text)) { stats.owner_words++; continue; }
      if (queued.has(i)) { stats.queued_anchor++; continue; }
      if (senders.get(i).some((x) => x.json && !x.idle)) { stats.pending_json++; continue; }
      if (i >= limit) continue;
      if (senders.get(i).some((x) => leads.has(x.who))) { stats.lead++; continue; }
      stats.considered++;
      const text = m.text;
      const file = typeof opts.source?.[i]?.text === 'string' ? opts.source[i].text : text; // the row as it came: what the file holds and the trace describes
      if (text.length < AGENT_MIN_CHARS) { stats.too_short++; stats.too_short_chars += text.length; continue; }
      const known = checked?.get(i);
      const held = known?.file === file ? known.held : secretCheck(file, cfg.privatePaths, budget);
      checked?.set(i, { file, held });
      if (held) { stats[held]++; continue; }
      const path = `${cfg.pasteDir}/${safeName(opts.sessionId)}/${(await sha256Hex(file)).slice(0, 32)}.txt`;
      const trace = agentTrace(path, file, state);
      if (trace.length >= text.length) { stats.too_short++; stats.too_short_chars += text.length; continue; }
      if (agentSecret(trace.replace(path, ''), cfg.privatePaths)) { stats.secret++; continue; } // the path is ours; the trace is short, so no budget
      jobs.push({ i, text, file, path, trace });
    }
    const gate = { deadline: opts.deadline ?? Date.now() + TOTAL_MS, stalled: false };
    for (const job of jobs) {
      if (write) {
        const saved = await savePaste($, gate, job.path, job.file);
        if (saved === 'written' || saved === 'reused') stats[saved]++;
        else { stats[saved === 'timeout' ? 'timed_out' : 'write_failed']++; continue; }
      }
      stats.moved++;
      stats.moved_chars += job.text.length;
      stats.trace_chars += job.trace.length;
      if (write) rows.set(job.i, trimRow(messages[job.i], job.trace));
    }
  } catch { stats.error = 1; }
  return { rows, stats };
}

async function decide($, e, cfg, record, started) {
  const messages = Array.isArray(e.messages) ? e.messages : [];
  let before = messages.reduce((s, m) => s + messageChars(m), 0);
  record.chars_before = before;
  const deadline = started + TOTAL_MS;
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
  const candidates = findCandidates(messages, cfg.privatePaths, cfg.notifications).filter((c) => (c.note ? c.resIdx : c.useIdx) < keepFrom);
  record.candidates = candidates.length;
  if (cfg.notifications) record.notifications = candidates.filter((c) => c.note).length;
  const envelopes = envelopeChars(messages, queued, candidates);
  const removable = removableChars(candidates);
  // The envelopes build adds stay in every rebuilt row, so they come off what the results can give back.
  const net = removable - envelopes;
  // The envelopes are text the installed rows hold and the host's count does not: the predictions start from the count plus them.
  const envelopeTokens = cfg.rates.RATE_NOTE * (envelopes - noteEnvelopeChars(candidates));
  // Agent trim: the host's frame of agents' messages and idle notifications out of the rows before the tail; lossless for the work, so before the floor and
  // the cascade, and its tokens come off the prediction (the cascade's target is the rule's target, a share of the window).
  const stage = agentStageOf($, cfg, e.agentId, messages, api, queued, keepFrom, record.session_id, deadline, takeAgentChecks(record.session_id, cfg));
  if (stage.stats) record.agent_trim = stage.stats;
  const { trimmed, trimTokens, opts: agentOpts, plan: planAgents } = stage;
  const movedTokens = (st) => movedTokensOf(st, cfg.rates);
  record.max_reduction = before ? Math.round((net / before) * 1000) / 1000 : 0;
  if (!before || net / before < MIN_REDUCTION) {
    // The characters leave out what costs tokens without being text (an image). With the token cascade a session that fails them goes on when its tokens
    // reach the same bound (the floor below is the check that follows the tokens); without it the gate is the characters alone.
    // The text the agent stage takes off (the trim, and with the stage active the reports it moves to files) is part of the cut: a session of reports that no
    // result of its own would carry is for the plan below, which counts the stage, and not for the summary.
    const stageTokens = cfg.targetPercent === undefined ? 0 : await agentStageTokens(cfg, stage);
    const cut = cfg.targetPercent === undefined ? undefined : cutInTokens(candidates, messages, api, envelopes - noteEnvelopeChars(candidates), cfg.rates, stageTokens);
    if (cut) record.max_reduction_tokens = cut.listed ? Math.round((cut.removable / cut.listed) * 1000) / 1000 : 0;
    if (!cut || !worthInTokens(cut)) return { fallback: 'too_few_results' };
  }
  // Token cascade. The window first (none: the summary runs). The tokens before of an automatic compaction are raised to the threshold, as the
  // host fires there (a subagent's window follows its estimate). A compaction at or below the usual target is manual: only the scores decide
  // and the floor is not checked. Otherwise the floor (every removable result gone) is predicted before Jev is asked, since the scores do not
  // change it: above the threshold less FLOOR_MARGIN of the window the summary runs at once.
  let tokens;
  let manual = false;
  let ruleTarget;
  let agentsFloor = 0;
  let known;
  if (cfg.targetPercent !== undefined) {
    // The host reads are made once, within the compaction's deadline, and the token accounting below uses them again.
    const detail = await hostValue($, () => $.session.usage({ breakdown: 'summary' }), deadline);
    const usage = await hostValue($, () => $.session.usage(), deadline);
    known = { detail, usage };
    let win = await resolveWindow($, cfg, detail, usage, deadline);
    if (!win) return { fallback: 'no_window' };
    tokens = tokensBeforeOf(e, cfg, messages, api, detail, usage);
    if (e.trigger === 'auto') {
      if (e.agentId === undefined) tokens.tokens = Math.max(tokens.tokens, win.threshold);
      else if (tokens.tokens < win.threshold) {
        win = { window: Math.min(win.window, Math.round(tokens.tokens) + HOST_BUFFER), threshold: Math.max(1, Math.round(tokens.tokens)), source: `${win.source}+agent` };
      }
    }
    tokens.tokens = Math.round(tokens.tokens);
    Object.assign(record, { window: win.window, threshold: win.threshold, window_source: win.source });
    known.win = win; // the window that governs the cut: the token accounting records it as it is
    // The rule's target: the usual target before the owner's limit (`raw`), then the limit from the configured window ceiling (absent by default).
    const raw = Math.floor(TARGET_UNCALIBRATED * usualTarget(win, cfg.targetPercent));
    const ceiling = tokenCeiling(cfg.maxWindowTokens, cfg.rates);
    ruleTarget = ceiling === undefined ? raw : Math.min(raw, ceiling);
    manual = tokens.tokens <= raw;
    if (!manual) {
      // With the stage active the floor counts what it plans to save (a plan, no write), so a session full of agents' reports is not handed to the
      // host's summary that the stage would spare it; if the writes then fall short, the plan is held to the same bound after the cascade. The floor
      // leaves out the text of the reply stage and of the paste stage: what the paste stage moves depends on Jev's answers, which come after the floor, and
      // the reply stage is left out with it so that both are counted once, in the plan. A session that only those two stages would spare goes to the
      // host's summary here, which is the safe side.
      if (agentOpts && cfg.mode === 'active') {
        const planned = await planAgents();
        agentsFloor = Math.max(0, movedTokens(planned.stats));
        record.floor_agents_tokens = Math.round(agentsFloor);
      }
      const floor = floorPrediction(candidates, tokens.tokens - trimTokens - agentsFloor + envelopeTokens, cfg.rates);
      record.floor_pred = Math.max(0, Math.round(floor));
      if (floor > win.threshold - FLOOR_MARGIN * win.window) return { fallback: 'floor_above_threshold' };
    }
  }
  const blocked = await blockedReason($, cfg, Date.now(), e.agentId);
  if (blocked) {
    if (blocked === 'paused') Object.assign(record, { paused_until: new Date(session.pausedUntil).toISOString(), pause_reason: session.pauseReason });
    else if (blocked === 'rpm') Object.assign(record, { held: 'rpm' });
    else if (blocked === 'breaker_open') Object.assign(record, { held: 'breaker' });
    else if (blocked === 'cap') Object.assign(record, { held: 'cap' });
    else if (blocked === 'batch_refused') Object.assign(record, { held: 'batch_refused' });
    return { fallback: blocked };
  }

  // Newest results first; only text results of calls outside secret paths are asked about.
  const askable = [...candidates].sort((a, b) => b.resIdx - a.resIdx).filter((c) => !c.secret && !c.proseSecret && !c.taskOutput && c.textOnly);
  record.secret_skipped = candidates.filter((c) => c.secret).length;
  // A prose call that names a secret path: its result is never sent; it keeps UNANSWERED_SCORE.
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

  const user = userTask(messages, typeof e.instructions === 'string' && e.instructions.trim() ? e.instructions : undefined, queued, cfg.privatePaths, cfg.notUserPrefixes);
  // Agent messages to files run next to the scoring requests (no request of their own); their result comes before the plan.
  const agentsRun = agentOpts ? moveAgentMessages($, cfg, trimmed, { ...agentOpts, write: cfg.mode === 'active', deadline }) : undefined;
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
        tool: c.note ? NOTE_LABEL : c.use.tool,
        input: c.note ? '' : clip(oneLine(maskSecrets(sentInputJson(c.use.input, cfg.privatePaths).slice(0, STATE_INPUT_CHARS * 4 + MASK_SLACK_CHARS))), STATE_INPUT_CHARS),
        result: maskedHeadTail(c.res.text || '', STATE_HEAD_CHARS, STATE_TAIL_CHARS, cfg.privatePaths),
        chars: c.resultChars,
        ...(c.res.isError ? { error: true } : {}),
      };
      questions[c.question] = scoreQuestion(c.question, cfg.questionNamed);
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
    // would have scored count as unrated, as after a failed request: the budget decides about them.
    const unscored = asked.slice(runs.length * BATCH);
    for (const c of unscored) { c.asked = true; c.score = UNRATED_SCORE; }
    record.unscored = unscored.length;
    record.requests = runs.length;
    if (held.mode === 'circuit-open') Object.assign(record, { held: 'breaker', breaker_until: new Date(held.breaker.until).toISOString(), breaker_reason: held.breaker.reason });
    else if (held.mode === 'process-cap') record.held = 'cap';
    else if (held.mode === 'deadline') record.held = 'deadline';
    else Object.assign(record, { held: 'rpm', rpm: { count: held.count, threshold: held.threshold, limit: held.limit } });
    if (!runs.length) return { fallback: held.mode === 'circuit-open' ? 'breaker_open' : held.mode === 'process-cap' ? 'cap' : held.mode === 'deadline' ? 'timeout' : 'rpm' };
  }
  record.requests = runs.length;
  // Pasted text: the requests go out next to the scoring ones; the files wait for the result (below), or for the plan with a token target.
  const pasted = cfg.pastes === 'off' || e.agentId !== undefined ? undefined : startPastes($, cfg, record, messages, api, keepFrom, deadline, queued);
  const [results] = await Promise.all([Promise.all(runs), pasted?.asks]);
  record.jev_ms = results.map((r) => r.ms);
  let answered = 0;
  const failures = [];
  for (const r of results) {
    for (const c of r.batch) {
      c.asked = true;
      const s = r.value ? scoreOf(r.value[c.question]) : undefined;
      if (s === undefined) c.score = UNRATED_SCORE;
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
      // Only a compaction that ends in the summary because of a refused batch is remembered; one that went on with the other batches is not.
      if (results.some((r) => !r.value && BATCH_REFUSED_STATUSES.includes(r.error?.status))) {
        session.batchRefusedUntil.set(refusedKey(record.session_id, e.agentId), Date.now() + BATCH_REFUSED_MS);
        record.batch_refused = true;
      }
      session.failedInRow++;
      // A deadline hold still records the failures of the requests that did go out.
      if (held?.mode === 'deadline') return { fallback: 'timeout' };
      return { fallback: failures.every((f) => f.kind === 'timeout') ? 'timeout' : 'jev_error' };
    }
  }
  session.failedInRow = 0;
  if (held?.mode === 'deadline') return { fallback: 'timeout' };

  // The agent messages that moved (active, files written and read back): their rows and their tokens come off the prediction.
  let agentMoved = new Map();
  let agentTokens = 0;
  if (agentsRun) {
    const run = await agentsRun;
    record.agent_messages = run.stats;
    if (cfg.mode === 'active' && run.rows.size) { agentMoved = run.rows; agentTokens = movedTokens(run.stats); }
  }
  record.mentioned = markMentioned(candidates, user);
  let replyEdits;
  let pasteSwaps;
  let stageTokens = 0;
  if (cfg.targetPercent === undefined) allocate(candidates, before, cfg.target, envelopes);
  else {
    // Token cascade (OMC_JEV_COMPACT_TARGET_PERCENT): the target and the prediction are in tokens; they start from the host's count,
    // and the envelopes that build adds to the rows it rebuilds come on top of it (envelopeTokens); the delivered text is in the count already.
    // A manual compaction: the scores decide; a prediction still above the target (the cascade's own target) goes on to the cascade, as the rule does.
    // The target is the rule's target for every trigger. A manual compaction is decided by the scores against it; a prediction still above it goes on
    // to the cascade, which then stops at the same target.
    const target = ruleTarget;
    // The reply and paste stages write their files now, as the agent stage did, so the text they move comes off the prediction before the plan: the plan
    // then stops earlier and the host handoff below sees the cut they make. Only a stage that moved text (active, files written) counts. A fallback after
    // this point leaves the files, which hold the text word for word.
    if (cfg.replies !== 'off' && e.agentId === undefined) {
      replyEdits = await moveReplies($, cfg, record, messages, api, keepFrom, deadline, queued);
      if (replyEdits.size) stageTokens += movedTokens(record.replies);
    }
    if (pasted) {
      pasteSwaps = await movePastes($, pasted.stats.mode, pasted.jobs, messages, pasted.stats, deadline).catch(() => { pasted.stats.error = 1; return new Map(); });
      if (pasteSwaps.size) stageTokens += movedTokens(pasted.stats);
    }
    const base = tokens.tokens - trimTokens - agentTokens - stageTokens + envelopeTokens;
    let plan;
    if (manual) {
      plan = manualPlan(candidates, base, cfg.rates);
      if (plan.predicted > target) plan = cascade(candidates, base, target, cfg.rates);
    } else plan = cascade(candidates, base, target, cfg.rates);
    Object.assign(record, { cut: plan.pass === 'manual' ? 'manual_scores' : 'cascade', cascade_pass: plan.pass, cascade_target_tokens: target, cascade_predicted_tokens: plan.predicted, tokens_after_pred: plan.predicted, cascade_tokens_source: tokens.source, cascade_dropped: candidates.filter((c) => c.keep === 'drop').length });
    // Host handoff: a manual or automatic compaction that removes less than HOST_MIN_CUT of the tokens is left to the host's summary (the record
    // keeps the numbers). The module's own requests and other mods' plugin compactions are not handled here.
    // The files were planned to spare the host's summary (the floor counted them): when the writes fell short and the plan still ends above the bound the
    // floor is held to, the summary runs.
    if (agentsFloor > 0 && plan.predicted > record.threshold - FLOOR_MARGIN * record.window) { record.floor_after_agents = plan.predicted; return { fallback: 'text_above_threshold' }; }
    if (cfg.handoff && plan.predicted > (1 - HOST_MIN_CUT) * tokens.tokens && (e.trigger === 'manual' || e.trigger === 'auto')) return { fallback: 'cut_below_host_min' };
    // The module's own request (`$.session.compact()` of ownThreshold, trigger `plugin`) that would stay under HOST_MIN_CUT is rejected, not handed over:
    // the host's summary is what it replaces, and nothing forces a compaction yet. compact() answers it with a skip. A `plugin` compaction asked by
    // another mod is not ours to veto.
    if (cfg.ownSkip && plan.predicted > (1 - HOST_MIN_CUT) * tokens.tokens && e.trigger === 'plugin' && session.ownCompactInFlight) return { fallback: 'cut_below_host_min_skipped', skip: true, tokensBefore: tokens.tokens };
  }
  const stats = {};
  let rows = agentMoved.size ? trimmed.map((m, i) => agentMoved.get(i) ?? m) : trimmed;
  // What the text stages moved is marked installed (`installed` of their stats) only once the result is certain, at the end: a fallback after the files were
  // written (the cascade's checks above, a build that fails) returns the host's summary, which holds none of it.
  let pastesInstalled = false;
  let repliesInstalled = false;
  if (pasted) {
    const swaps = pasteSwaps ?? (await movePastes($, pasted.stats.mode, pasted.jobs, messages, pasted.stats, deadline).catch(() => { pasted.stats.error = 1; return new Map(); }));
    if (swaps.size) { rows = rows.map((m, i) => (swaps.has(messages[i]) ? swaps.get(messages[i]) : m)); pastesInstalled = true; }
  }
  let built = build(rows, candidates, keepFrom, group, stats, queued);
  if (!pairingOk(messages, built)) return { fallback: 'build_error' };
  if (cfg.replies !== 'off' && e.agentId === undefined) {
    const edited = replyEdits ?? (await moveReplies($, cfg, record, messages, api, keepFrom, deadline, queued));
    if (edited.size) {
      built = build(rows.map((m, i) => (edited.has(i) ? { ...m, text: edited.get(i) } : m)), candidates, keepFrom, group, stats, queued);
      repliesInstalled = true;
    }
  }
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
  // What the installed text stages took off, with or without the cascade: a stage that moved nothing (shadow, writes that failed, or a fallback) counts for nothing.
  const installedTokens = trimTokens + agentTokens - envelopeTokens + (repliesInstalled ? movedTokens(record.replies) : 0) + (pastesInstalled ? movedTokens(pasted.stats) : 0);
  if (cfg.tokenAccounting) Object.assign(record, await tokenAccounting($, e, cfg, messages, api, candidates, installedTokens, deadline, known));
  if (agentMoved.size) record.agent_messages.installed = true;
  if (pastesInstalled) pasted.stats.installed = true;
  if (repliesInstalled) record.replies.installed = true;
  return { messages: built, before, after, predicted: record.tokens_after_pred, tokensBefore: tokens?.tokens, tokensAfter: record.tokens_after_pred };
}

async function compact($, e, next) {
  // The point is off or its configuration unreadable: the built-in summary runs. One that replaces the messages of the main loop also ends the
  // wait for the measurement of an earlier compaction of this module, or the next request would be measured against that one.
  const passThrough = async () => {
    const out = await next(e);
    if (e.agentId === undefined && e.trigger !== 'precompute' && !out?.skip) session.pendingAfter = undefined;
    return out;
  };
  let cfg;
  try { cfg = await readConfig($); } catch { return passThrough(); }
  if (cfg.mode === 'off') return passThrough();
  // An active point replaces the summary, so a summary computed ahead of time would be wasted; while
  // the breaker is open the summary will run, so the host may compute it ahead.
  if (e.trigger === 'precompute') return cfg.mode === 'active' && !(await blockedReason($, cfg, Date.now(), e.agentId)) ? { skip: 'jev-compaction replaces the summary' } : next(e);
  const started = Date.now();
  // Any compaction of the main loop that actually replaced the messages, this module's or the built-in
  // summary, arms the own threshold's growth gate again (ownThreshold). A skip leaves the context as it
  // was, so the gate stays as it was too. The same holds for the measurement still waiting for the request after an earlier compaction
  // of this module: it ends only when the messages were really replaced.
  const armGrowthGate = (out) => {
    if (e.agentId === undefined && !out?.skip) { session.growthArmed = true; session.growthBase = undefined; session.skipBase = undefined; session.pendingAfter = undefined; }
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
    if (decision.skip && cfg.mode === 'active') {
      // The cut of the module's own request would stay under HOST_MIN_CUT: nothing is replaced and the host's summary does not run. The growth gate is
      // armed here on purpose and skipBase records the tokens of this request, so the next one waits for OWN_MIN_GAIN of the window of growth from them
      // instead of paying for Jev's scores again after MIN_TURNS_BETWEEN turns.
      if (e.agentId === undefined) { session.growthArmed = true; session.growthBase = undefined; session.skipBase = decision.tokensBefore; }
      return { skip: `${OWN_SKIP_PREFIX} cut under ${Math.round(HOST_MIN_CUT * 100)} % of the tokens, nothing replaced` };
    }
    if (decision.fallback || cfg.mode !== 'active') return armGrowthGate(await next(e));
    if (cfg.toast) { try { $.ui.toast(`Jev compaction: ${decision.before} -> ${decision.after} chars`); } catch { /* optional */ } }
    // Host handoff (OMC_JEV_COMPACT_HOST_HANDOFF=1, opt-in with caution): the host also gets the tokens before and after this compaction. The
    // host's contract for these keys is not documented in this repository, so the switch is off by default. Off, it gets the messages only.
    const installed = armGrowthGate(cfg.handoff && decision.tokensAfter !== undefined ? { messages: decision.messages, tokensBefore: decision.tokensBefore, tokensAfter: decision.tokensAfter } : { messages: decision.messages });
    // The measurement of this compaction replaces any still waiting for an earlier one (armGrowthGate cleared it).
    if (e.agentId === undefined && record.session_id) session.pendingAfter = { cfg, ts: record.ts, sessionId: record.session_id, charsAfter: decision.after, predicted: decision.predicted };
    return installed;
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
    if (cfg.mode !== 'active' || cfg.atPercent === undefined || (await blockedReason($, cfg, Date.now(), undefined))) return result;
    const usage = await $.session.usage();
    const tokens = usage?.context?.tokens;
    if (!Number.isFinite(tokens) || tokens <= 0) return result;
    // context.percent counts from the model's window; the threshold counts from the window the host
    // compacts at (rawMaxTokens).
    if (session.compactWindow === undefined || session.turnCount - session.windowTurn >= WINDOW_REFRESH_TURNS) {
      session.windowTurn = session.turnCount;
      try {
        const detail = await $.session.usage({ breakdown: 'summary' });
        if (cfg.tokenAccounting) {
          session.compactWindow = (await resolveWindow($, cfg, detail, usage))?.window ?? usage.context.window;
        } else {
          const raw = detail?.context?.breakdown?.rawMaxTokens;
          session.compactWindow = Number.isFinite(raw) && raw > 0 ? raw : usage.context.window;
        }
      } catch { session.compactWindow = usage.context.window; }
    }
    const window = session.compactWindow;
    if (!Number.isFinite(window) || window <= 0 || tokens * 100 < cfg.atPercent * window) return result;
    // After a compaction the context has to grow by OWN_MIN_GAIN of the window first, counted from the
    // lowest usage since it and at most from the threshold: a compaction that ends above the threshold
    // would else be asked for again as soon as the turn gap allows (right away after /compact or the
    // host's own compaction), and one that ends just below it after a few thousand tokens.
    if (session.growthBase !== undefined && tokens - Math.min(session.growthBase, (cfg.atPercent * window) / 100) < OWN_MIN_GAIN * window) return result;
    // After a skipped request (cut under HOST_MIN_CUT) the next one waits for OWN_MIN_GAIN of the window of growth from the tokens of that request.
    if (cfg.ownSkip && session.skipBase !== undefined && tokens - session.skipBase < OWN_MIN_GAIN * window) return result;
    session.growthArmed = false;
    // The tokens include the fixed prefix (system prompt, tools, instructions): ask only when the
    // removable tool results are worth it, so the threshold never forces the built-in summary.
    session.lastAttempt = session.turnCount;
    const messages = await $.session.messages();
    let before = messages.reduce((s, m) => s + messageChars(m), 0);
    const candidates = findCandidates(messages, cfg.privatePaths, cfg.notifications);
    // Only with the token cascade, which is where decide answers a request with that skip: without it nothing can follow, and the character gate is the only veto.
    // Not even the floor (every removable result gone) cuts HOST_MIN_CUT of the tokens: the request would only end in a skip after Jev's scores. The floor counts
    // results only, so with a stage on that takes text off as well (agent trim, long replies, pasted text) it is no proof: decide holds the request to the same
    // bound with the text of those stages in its plan, and answers it with a skip.
    const textStages = cfg.agentTrim || cfg.replies === 'active' || cfg.pastes === 'active';
    if (cfg.ownSkip && cfg.targetPercent !== undefined && !textStages && tokens - floorPrediction(candidates, tokens, cfg.rates) < Math.max(OWN_MIN_GAIN * window, HOST_MIN_CUT * tokens)) return result;
    let removable = removableChars(candidates);
    let envelopes = 0;
    let api;
    // What the agent stage takes off counts as a cut too, as in decide (the cascade only: the stage's plan is part of the cascade's prediction).
    let stageTokens = 0;
    const stageCounts = cfg.targetPercent !== undefined && cfg.agentTrim;
    // With the token cascade a session that fails the characters is measured in tokens (cutInTokens): an image has no characters and costs thousands of tokens.
    const tooSmall = () => (!before || removable / before < MIN_REDUCTION || removable / CHARS_PER_TOKEN < OWN_MIN_GAIN * window)
      && (cfg.targetPercent === undefined || !worthInTokens(cutInTokens(candidates, messages, api, envelopes - noteEnvelopeChars(candidates), cfg.rates, stageTokens), OWN_MIN_GAIN * window));
    // The delivered messages can only make this worse (they add to `before`, their envelopes come off
    // `removable`), so a transcript that fails here needs no API read, which may hold the turn for HOST_MS. With the agent stage on it is read all the same: the
    // stage is planned from the API form and may carry the cut that the results do not.
    if (tooSmall() && !stageCounts) return result;
    // Messages delivered during a tool turn are in the API form only; decide counts them, so the
    // preflight does too (else it could ask for a compaction that decide hands back to the summary).
    const apiRead = await withDeadline($, Promise.resolve().then(() => $.session.messages({ as: 'api' })), HOST_MS);
    // A read that timed out or failed leaves the delivered text unknown: decide could hand a large one
    // back to the summary, so the preflight does not ask.
    if (!('value' in apiRead)) return result;
    api = apiFormOf(apiRead.value);
    const delivered = queuedOf(messages, api);
    if (delivered) {
      for (const blocks of delivered.rows.values()) before += rawChars(blocks);
      envelopes = envelopeChars(messages, delivered.rows, candidates);
      removable -= envelopes;
    }
    // Only a session that the results alone do not carry needs the stage's scans: the compaction it asks for makes them otherwise.
    if (stageCounts && api && tooSmall()) {
      // The rows that keep their handles, as decide finds them; without the API form that holds their calls there is no stage.
      const keepFrom = openLoopStart(messages, groupsOf(messages, api));
      if (keptCallsIn(messages, keepFrom, api)) {
        try {
          let sessionId;
          try { sessionId = await $.session.id(); } catch { sessionId = undefined; }
          const stage = agentStageOf($, cfg, undefined, messages, api, delivered ? delivered.rows : new Map(), keepFrom, sessionId, Date.now() + TOTAL_MS);
          // The checks go to the compaction that follows (takeAgentChecks); one that does not follow leaves them to the next preflight, which replaces them.
          if (stage.opts && sessionId) session.agentChecked = { id: sessionId, paths: JSON.stringify(cfg.privatePaths), checked: stage.opts.checked };
          stageTokens = await agentStageTokens(cfg, stage);
        } catch { stageTokens = 0; }
      }
    }
    if (tooSmall()) return result;
    let reason;
    let detailText = '';
    try {
      session.ownCompactInFlight = true;
      const done = await $.session.compact();
      if (done && typeof done.skip === 'string') { reason = cfg.ownSkip && done.skip.startsWith(OWN_SKIP_PREFIX) ? 'cut_below_host_min' : 'host_skipped'; detailText = done.skip; }
    } catch (error) {
      detailText = String(error?.message ?? error);
      reason = /headless|sdk|-p\b/i.test(detailText) ? 'host_cannot_compact' : /turn|in flight|running/i.test(detailText) ? 'host_turn_running' : 'host_error';
      if (reason === 'host_cannot_compact') session.hostCannot = true;
    } finally {
      session.ownCompactInFlight = false;
      session.agentChecked = undefined; // the checks belong to the request just made, run or not
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
  // A host without the event only loses the measurement.
  try { on('turn.step', firstRequest); } catch { /* no turn.step */ }
}
