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
 * - it carries none of the user's own style as OMC_JEV_COMPACT_OWNER_MARKERS describes it (comma separated texts looked for as they
 *   stand, in any case; empty by default, so no tag is held back by it);
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
 * same text, and a file found written already is written again so that it is as new as its trace; scripts/lib/jev-compaction-state.mjs removes old
 * session directories (OMC_JEV_PASTES_DAYS). The record gets
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
 * Verdicts of Jev on blocks of text (OMC_JEV_COMPACT_BLOCKS=off|shadow|active; off when unset or anything else; the one switch also steers the second round, active only, and the series of traces, counted only in shadow, below). In a conversation with the API form, a state
 * directory and a session id, Jev rates each block (a paragraph, a closed fenced code block or a closed pasted tag of the user's own words or of an assistant
 * row; a whole message block of an agent row) of the rows before the tail on four levels: 3 and 2 leave the block word for word, 1 and 0 move it to a file of
 * the pastes directory and leave a trace, `[block moved at compaction: <n> chars in b/<file>...]` (level 1 adds the first BLOCK_HEAD_CHARS
 * characters, a direct reply its first and last ones); the directory the letter stands for is named once, in the header `[compaction trace files: b/ = <dir>]` that opens the result. A block with no verdict stays word for word, whatever its length, age or author: those are signals in
 * the question, not rules. The verdicts are files in the pastes directory, so a block is asked about once; the pass at the end of a turn (in the background)
 * and the one before the module's own request to compact fill them earlier. `shadow` asks, counts and writes the verdict files but changes nothing; `active`
 * acts only while the point itself is active. OMC_JEV_COMPACT_VERDICTS=off asks no question, OMC_JEV_COMPACT_BLOCK_QUESTIONS=shared states the wording of the
 * question once per request, OMC_JEV_COMPACT_WINDOW_CHARS sets the window of Jev in bytes (8000 or more), OMC_JEV_COMPACT_FULL_INPUT=active bounds the user's
 * words in a request by that window alone, and OMC_JEV_COMPACT_JEV_STAGES=active lets the verdicts decide what the stages of pasted text, long replies and agent messages to files decide by
 * fixed lengths while the verdicts run (the agent trim stays). The record gets `blocks` (counts and levels) and, with the switch set while the blocks switch is not off, `jev_stages`; the
 * background and preflight passes write a `verdicts_fill` record. See the section "verdicts of Jev on blocks of text" below for the rules.
 *
 * Second round (with the verdicts applied and the token cascade): when the prediction is still above the target after the second pass of the cascade, the results Jev rated and the
 * blocks Jev kept (level 2-3) stand in one queue in the order of Jev's ratings and come down from the lowest until the target is reached (a result to a trace and then removed, a block to
 * level 1); a tie at the edge of the choice is put to Jev once, and the passes of the cascade after the second one run as the reserve. OMC_JEV_COMPACT_OWNER_LAST=active puts the owner's
 * blocks last in that queue. The checks of the blocks for a secret have their own budget, BLOCK_SCAN_BUDGET_CHARS. The record gets `f2`; see "second round" below.
 *
 * Series of traces (the same switch, OMC_JEV_COMPACT_BLOCKS). Two or more traces of the module on neighbouring lines of one row (a removed call, a moved reply, a moved agent
 * message, a moved block; only white space between them, a pasted-text trace ends a series) are a series. In the second round every series of the rows before the open tool loop
 * (the rows the blocks left, less the rows another stage changes) that passes the checks below is rated by Jev with the question of the round, its
 * text masked, and stands in the queue with the results and the blocks; a series that comes down merges into one line, `[compacted] traces merged: <n> calls, <n> replies, <n> others; list in <path>`, and the traces
 * go to a file in the pastes directory (with the header of the block files when a block trace is among them), masked, written and read back like the other files. The checks: a series
 * that names a private path (OMC_JEV_COMPACT_PRIVATE_PATHS) stays whole, and the check for a secret of the other stages reads the names of its tools (a name a mask changes is
 * counted as `masked_tool` in what Jev is told); then the mask of a series (scripts/lib/jev-series-mask.mjs; the file keeps the paths of the module's own files whose files can be
 * read), and a series that keeps a line the mask cannot clear stays whole; then the same
 * check reads both masked texts, and a hit, a text beyond what it reads or no time left keeps the series whole too (not sent, not written, not counted). What leaves has the shared
 * mask of the other stages under the mask of a series. The series count in the floor like the blocks. In a direct reply the trace of a reply, of a block or of an agent's message is never merged. The record gets `series` (the merge) and
 * `f2.series_question`; `shadow` counts the candidates (`f2.candidates.series`).
 *
 * Archive of calls and results (OMC_JEV_COMPACT_ARCHIVE=off|shadow|active; off when unset or anything else; needs a state directory). With `active`, while the point itself is active and the compaction has
 * a session id, every call and result (or notification) that the cut traces, shortens or removes goes whole to <state dir>/compaction-archive/<session>/<tool_use_id>.txt (nothing in the conversation names the file
 * of a result removed with its call): a head with the call
 * and its input as masked JSON, then the result unchanged. The trace or the shortened result names the file (`; full call and result: <path>`) only after the file was written and read back
 * equal, and each path counts in the lengths the floor and the cascade predict. Nothing is archived that may hold a secret (a secret or private path or a secret word in the input or in the
 * result, a secret tool, a command that prints secrets, a result that masking would change), nor a result without text, an empty one, one over the host's write limit, or a text an earlier
 * compaction cut (its trace keeps pointing at the first file, which is reused). The files are written ARCHIVE_PARALLEL at a time, none starts after ARCHIVE_BUDGET_MS from the start of the batch or
 * after the compaction's own deadline, and after one host call that hit its cap none starts at all. Neighbouring traces of one identical call (same tool, same whole input) inside one API message,
 * with nothing between them in the built conversation, merge into one line with a counter, `[compacted] Tool(input) x<n> - results of <chars> chars removed; full calls and results: <dir> (<files>)`;
 * different calls of one target never merge. `shadow` (and `active` in a compaction that is not active) only counts what `active` would archive and merge: no file, no path, the conversation is
 * built as with the switch off. The record gets `archive_mode`, the counts (`archive_written`, `archive_reused`, `archive_rewritten`, `archive_bytes`, `archive_skipped` by reason, `archive_errors`,
 * `archive_timed_out`, `archive_ms`, `archive_marker`; `archive_planned` in shadow) and `merged_traces`, `merged_items`. A marker file in the session directory is touched by every compaction
 * that archives; scripts/lib/jev-compaction-state.mjs removes session directories whose newest file is older than OMC_JEV_ARCHIVE_DAYS days.
 *
 * Owner tail (OMC_JEV_COMPACT_OWNER_TAIL=active, off by default; without it the three options below do nothing). The newest message of the user and the text of
 * every assistant row after it stay word for word in any compaction: no stage moves a block, a pasted tag, a long reply, an agent message or a series out of them,
 * and Jev is not asked about their blocks; calls and results after the message are compacted as usual. When the fixed prefix with the protected text is over the
 * threshold less FLOOR_MARGIN of the window (token cascade; also when the floor or the final prediction with it is over that bound), the next boundary is tried
 * (OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION=fallback, the default: the newest message of another session after the user's; `on` counts such messages like the
 * user's, `off` ignores them), and past the last one nothing is protected (OMC_JEV_COMPACT_OWNER_TAIL_OVERFLOW unset), or with `keep` the last boundary stays while
 * it is under the threshold and the gates that hand the compaction to the summary are off. Subagents have no owner tail unless
 * OMC_JEV_COMPACT_OWNER_TAIL_AGENTS=active. A protected text that came out changed leaves the conversation as it was: a skip that opens with OWNER_TAIL_SKIP, no
 * summary. The record gets `owner_tail` (from_idx, rows, tokens, violations, goal_yielded, overflow, boundary, protected_rows), `owner_tail_applied`,
 * `owner_tail_tier` and `owner_tail_violations`; see "owner tail" below.
 *
 * The tail by the open tool loop (OMC_JEV_COMPACT_TAIL_BY_LOOP=active, off by default; without it "the last KEEP_LAST rows" below stand as written). The tail that
 * the cut and the stages leave alone is then the open tool loop alone, whose rows keep their handles, and nothing at a turn boundary: the results, notifications,
 * agent messages, pasted tags and blocks of the last KEEP_LAST rows are treated like older ones, with the same checks for secrets and private paths (a long reply
 * stays before the last user messages and turns as before; the series of traces stop at the open loop with the switch or without it). A conversation of three
 * messages or more is compacted. The first and the newest user message stay as they are in the paste stage.
 *
 * Usage of Jev's requests (OMC_JEV_COMPACT_JEV_USAGE=1 or active, off by default; without it no record gains a field and no record is added). The record of a
 * compaction gets `jev_usage`, one entry per request sent to Jev: `model` (as the answer names it, masked and cut to JEV_MODEL_MAX_CHARS characters),
 * `input_tokens`, `output_tokens` and `cost_usd` (always null; a missing value is null, never 0). The scoring requests come first, parallel to `jev_ms` and without
 * `purpose`; the others carry `purpose` (pastes, blocks, second_round). When the owner tail makes the compaction decide again, the entries of the decisions that
 * were given up follow with `abandoned: true`. `cost_basis` is `reported` when an answer carries a cost, else `unknown`. The pass before the
 * module's own request puts both fields into its `verdicts_fill` record, and a pass in the background that asked something writes such a record of its own.
 *
 * Host attachments (OMC_JEV_COMPACT_HOST_ATTACHMENTS=1 or true, off by default; without it the user rows of text keep their handles and no record gains a field).
 * The host keeps what is no row (instructions, lists of skills, agents and tools, hook contexts, the text of used skills) in the group of the row before it, and a
 * row that keeps its handle comes back with its group. With the switch on each user row of text before the open tool loop is built from its text, with the messages
 * delivered after it in their envelopes, and the host announces again what it finds missing. A row keeps its handle in a turn with an image, a document or a /goal
 * record, without text or with [Image #N], or in a turn the API form does not place; without the API form nothing is taken off. When the row of an advisor reminder
 * cannot be rebuilt, or the API form does not show the start of a long conversation, the compaction goes to the summary (advisor_image, advisor_command,
 * advisor_no_row, advisor_in_tail, advisor_form_cut). The predictions take off the attachments that go less what the host announces again. The record gets
 * `rebuilt_user`, `advisor_blocks`, `attachments_dropped`, `attachments_dropped_tokens`, `attachments_kinds`, `attachments_kinds_tokens`, `attachments_skills`
 * (names of used skills), `attachments_back`, `attachments_back_tokens`, `attachments_back_from_results_tokens` and `attachments_resent_tokens`; see
 * "host attachments" below.
 *
 * Secrets in the paste, reply, agent and block stages: a tag, run or agent message that names a secret or private path, or that masking changes, stays
 * in the conversation unmoved, and no file is written for it. This is deliberate: a copy with the secrets masked is not archived in its place, so
 * a session with secrets in such text keeps that text whole in the conversation until masked archiving is added. The check is bounded (maskSecrets
 * is quadratic on one long word): a text beyond SCAN_MAX_CHARS, or beyond the SCAN_BUDGET_CHARS one stage checks in one compaction, counts as unchecked
 * and stays whole the same way; the preflight of the own threshold hands the rows it checked to the compaction it asks for, which does not check them again. A row that holds tool results or a delivered message's anchor is never rebuilt by the paste stage.
 *
 * Shared breaker and request limit (OMC_JEV_BREAKER=1, OMC_JEV_MAX_RPM=<n>): the same files and rules as
 * the script side (scripts/lib/jev-breaker.mjs, see its header), under the same state directory and
 * scope. A hooks module cannot import Node, so the file work goes through $.fs; the rules are mirrors.
 * Before each request the module reads breaker.json (open: no request, except a breaker of scope "low",
 * which the script side writes with OMC_JEV_BREAKER_TIMEOUT_LOW=1 for low-priority points only and which
 * leaves this medium-priority point alone) and, with a limit, reserves a
 * slot in the UTC minute's rpm file at medium priority (a refused request takes no slot). A request
 * that fails opens the breaker by status alone (429 and 5xx; 401, 402, 403; Retry-After, for a 429
 * without one the retry time in its body), and the third request without a response within a minute
 * opens it too. $.fs can neither append nor delete: a line is added by writing the file whole and
 * reading it back, which can lose a line another process added in between (so the limit can be
 * exceeded when several sessions reserve in the same instant; this module's own file work is done one
 * step after the other), and the per-minute files of old minutes stay (the script side removes them
 * when it writes a new minute). Without these two variables nothing of this is read or written. The
 * module's own pause, its three-failures stop and OMC_JEV_MAX_REQUESTS stay as they were. Not mirrored
 * from the low scope of the script side: the module counts every request without a response as one
 * (it writes no noresp-imp lines and no since_all), and the openings log is written by the script side only.
 *
 * Token accounting (OMC_JEV_COMPACT_TOKEN_ACCOUNTING=1, off by default; without it nothing below runs and
 * no record gains a field). The compaction window and threshold come from one resolver (resolveWindow): the
 * host's breakdown first (rawMaxTokens, autoCompactThreshold), else CLAUDE_CODE_AUTO_COMPACT_WINDOW, the
 * autoCompactWindow of settings.json under CLAUDE_CONFIG_DIR (or ~/.claude), capped at the model's window,
 * else the model's window; the threshold is that window less HOST_BUFFER. With the switch on, the own
 * threshold reads the same window. The tokens before are the host's usage in the main loop, else an
 * estimate of the API form by class (listTokens, RATE_* constants) with the thinking it holds (RATE_SIG tokens a character of
 * thinking text or signature; listTokens counts a block of thinking and not what is in it); the tokens after are predicted from the
 * removed text, from the blocks and messages that go with it (shapeOf) by the same rates, and less the thinking of the assistant rows that build
 * rebuilds without it (every assistant row before the tail; signatureRows places the thinking of the API form on the rows, the thinking of the tail stays). OMC_JEV_COMPACT_MAX_WINDOW_TOKENS (positive integer, unset: no cap) caps the
 * kept target at that window divided by 1 + PREDICTION_SHORTFALL (tokenCeiling). The rates and PREDICTION_SHORTFALL come from one measurement of
 * one model on one host; OMC_JEV_COMPACT_RATES (a JSON object of rate name to number) overrides them one by one (ratesFrom). These figures go to the
 * compaction record only (target_tokens, target_tokens_capped, tokens_before, tokens_after, window, threshold,
 * window_source, tokens_source; api_messages, sig_chars_total and sig_chars_mapped, the thinking characters that the API form holds, all and on a row;
 * rebuilt_thinking, the assistant rows rebuilt, which the thinking goes with); the cut itself still follows the character budget of allocate.
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
import { RESIDUAL_SECRET, archiveMaskedLong, cleanForJevLong, maskResidualLines } from '../scripts/lib/jev-series-mask.mjs';

const POINT = 'compaction';
// The last messages stay whole: the work in flight.
const KEEP_LAST = 6;
// The first row of the tail the stages leave alone, at most keepFrom (the first row that keeps its handle). With OMC_JEV_COMPACT_TAIL_BY_LOOP=active the tail is
// the open tool loop alone, and nothing at a turn boundary; else it is also the last KEEP_LAST rows.
const tailEnd = (cfg, keepFrom, length) => (cfg.tailByLoop ? keepFrom : Math.min(keepFrom, Math.max(1, length - KEEP_LAST)));
// Cap on the host call for the API form of the conversation: a call that never settles must not hold
// the compaction.
const HOST_MS = 2000;
// Up to BATCH * MAX_REQUESTS = 240 results are scored per compaction. A 40-question request took
// 1.4-2.9 s against the production endpoint; the deadlines leave room for a slow answer and keep the
// whole decision under TOTAL_MS, after which the built-in summary runs instead.
const BATCH = 40;
const MAX_REQUESTS = 6;
const REQUEST_MS = 6000;
// The window of Jev for the questions about blocks: the size in BYTES of the request body (UTF-8). The API refused a body of about 66 KB and took 56 KB, so 40000 stays
// under it with room; a request refused as too large is asked again in half of it. OMC_JEV_COMPACT_WINDOW_CHARS (8000 or more) overrides it.
const JEV_WINDOW_BYTES = 40000;
const windowBytesOf = (cfg) => cfg?.windowChars ?? JEV_WINDOW_BYTES;
// OMC_JEV_COMPACT_FULL_INPUT=active: the user's words in the header of a question about a block get a quarter of the window, bounded by it alone.
const ownerLimitsOf = (cfg) => (cfg?.fullInput ? { chars: Math.floor(windowBytesOf(cfg) / 4), messages: Infinity } : undefined);
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
// A character of thinking (its text and its signature) in the API form. The host's count holds the thinking of the assistant messages, and build rebuilds every assistant row
// before keepFrom without it, so the prediction takes it off the tokens before (signatureRows); a list estimate adds it, as listTokens does not count it.
const RATE_SIG = 0.2575;
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
const BLOCK_TRACE_PREFIX = '[block moved at compaction: ';
// The header of the files the traces of blocks name (once per compaction, the first row of the result): the traces carry the letter and the file name only.
const TRACE_HEADER_PREFIX = '[compaction trace files: ';
const BLOCK_LETTER = 'b';
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
// While the blocks act (readConfig: `blockTraces`) a row that opens with a moved block or the header of the trace files is no user's text either.
const STAGE_NOT_USER_BLOCKS = [...STAGE_NOT_USER, '[block moved at compaction', '[compaction trace files: '];
const notUserOf = (blockTraces) => (blockTraces ? STAGE_NOT_USER_BLOCKS : STAGE_NOT_USER);
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
    blockVerdicts: new Map(), blockHeld: new Map(), blockBackground: { busy: false, at: -Infinity, run: undefined, stop: false },
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
    OMC_JEV_COMPACT_BLOCKS: await $.env.get('OMC_JEV_COMPACT_BLOCKS'),
    OMC_JEV_COMPACT_VERDICTS: await $.env.get('OMC_JEV_COMPACT_VERDICTS'),
    OMC_JEV_COMPACT_BLOCK_QUESTIONS: await $.env.get('OMC_JEV_COMPACT_BLOCK_QUESTIONS'),
    OMC_JEV_COMPACT_WINDOW_CHARS: await $.env.get('OMC_JEV_COMPACT_WINDOW_CHARS'),
    OMC_JEV_COMPACT_FULL_INPUT: await $.env.get('OMC_JEV_COMPACT_FULL_INPUT'),
    OMC_JEV_COMPACT_OWNER_LAST: await $.env.get('OMC_JEV_COMPACT_OWNER_LAST'),
    OMC_JEV_COMPACT_ARCHIVE: await $.env.get('OMC_JEV_COMPACT_ARCHIVE'),
    OMC_JEV_COMPACT_JEV_USAGE: await $.env.get('OMC_JEV_COMPACT_JEV_USAGE'),
    OMC_JEV_COMPACT_TAIL_BY_LOOP: await $.env.get('OMC_JEV_COMPACT_TAIL_BY_LOOP'),
    OMC_JEV_COMPACT_HOST_ATTACHMENTS: await $.env.get('OMC_JEV_COMPACT_HOST_ATTACHMENTS'),
    OMC_JEV_COMPACT_OWNER_TAIL: await $.env.get('OMC_JEV_COMPACT_OWNER_TAIL'),
    OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION: await $.env.get('OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION'),
    OMC_JEV_COMPACT_OWNER_TAIL_AGENTS: await $.env.get('OMC_JEV_COMPACT_OWNER_TAIL_AGENTS'),
    OMC_JEV_COMPACT_OWNER_TAIL_OVERFLOW: await $.env.get('OMC_JEV_COMPACT_OWNER_TAIL_OVERFLOW'),
    OMC_JEV_COMPACT_JEV_STAGES: await $.env.get('OMC_JEV_COMPACT_JEV_STAGES'),
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
  const blocks = pasteMode(env.OMC_JEV_COMPACT_BLOCKS);
  // The lines of moved blocks and the header of the trace files are read as traces of the module (the long replies, the direct replies, the estimate of tokens, the user's words) only while
  // the blocks act (`active`, with the point active); `shadow` only counts and every other value leaves them as plain text, as in the module without the blocks.
  const blockTraces = blocks === 'active' && mode === 'active';
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
    rates: { ...ratesFrom(env.OMC_JEV_COMPACT_RATES), blockTraces },
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
    notUserPrefixes: blockTraces ? STAGE_NOT_USER_BLOCKS : agentTrim || notifications || pastes !== 'off' || replies !== 'off' ? STAGE_NOT_USER : NOT_USER_PREFIXES,
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
    ownerMarkers: ownerMarkerTexts(env.OMC_JEV_COMPACT_OWNER_MARKERS),
    // Row prefixes of the paste and reply stages: the built-in ones, then the comma separated list of OMC_JEV_COMPACT_HOOK_ROW_PREFIXES.
    hookRowPrefixes: [...HOOK_ROW_PREFIXES, ...String(env.OMC_JEV_COMPACT_HOOK_ROW_PREFIXES ?? '').split(',').map((x) => x.trim()).filter(Boolean)],
    replies,
    // Verdicts of Jev on blocks of text (off unless OMC_JEV_COMPACT_BLOCKS says shadow or active): `verdicts` off asks no question (the verdict files that exist still apply), `blockQuestions`
    // shared puts the wording of the question once in the state of a request, `windowChars` is the window of Jev in bytes (8000 or more), `fullInput` bounds the user's words in the
    // header of a request by the window alone, `jevStages` lets the verdicts decide what the paste and reply stages and the agent messages to files decide by fixed lengths.
    blocks,
    blockTraces,
    verdicts: String(env.OMC_JEV_COMPACT_VERDICTS ?? '').trim().toLowerCase() === 'off' ? 'off' : 'active',
    blockQuestions: String(env.OMC_JEV_COMPACT_BLOCK_QUESTIONS ?? '').trim().toLowerCase() === 'shared' ? 'shared' : 'full',
    windowChars: /^[1-9]\d{3,6}$/.test(String(env.OMC_JEV_COMPACT_WINDOW_CHARS ?? '').trim()) && Number(env.OMC_JEV_COMPACT_WINDOW_CHARS) >= 8000 ? Number(env.OMC_JEV_COMPACT_WINDOW_CHARS) : undefined,
    fullInput: String(env.OMC_JEV_COMPACT_FULL_INPUT ?? '').trim() === 'active',
    jevStages: String(env.OMC_JEV_COMPACT_JEV_STAGES ?? '').trim() === 'active',
    // In the second round the owner's blocks that Jev kept (level 2-3) go after every other candidate; they come down only when nothing else is left (default off).
    ownerLast: String(env.OMC_JEV_COMPACT_OWNER_LAST ?? '').trim() === 'active',
    // Archive of calls and results (off unless OMC_JEV_COMPACT_ARCHIVE says shadow or active): the files of the cut results go to <state dir>/compaction-archive.
    archive: archiveModeOf(env.OMC_JEV_COMPACT_ARCHIVE),
    archiveDir: stateDir ? `${stateDir}/compaction-archive` : undefined,
    // Usage and model of every request of Jev in the records (off unless 1 or active).
    jevUsage: ['1', 'active'].includes(String(env.OMC_JEV_COMPACT_JEV_USAGE ?? '').trim()),
    // The tail kept whole is the open tool loop alone, not also the last KEEP_LAST rows (off unless active).
    tailByLoop: String(env.OMC_JEV_COMPACT_TAIL_BY_LOOP ?? '').trim() === 'active',
    // Host attachments (off unless 1 or true): the user rows of text lose their handle, so the host's old attachments in their groups do not come back.
    hostAttachments: ['1', 'true'].includes(String(env.OMC_JEV_COMPACT_HOST_ATTACHMENTS ?? '').trim().toLowerCase()),
    // Owner tail (off unless active): the newest message of the user and the text of the answers after it stay word for word. The three options act only with it.
    ownerTail: String(env.OMC_JEV_COMPACT_OWNER_TAIL ?? '').trim() === 'active',
    ownerTailCrossSession: crossSessionMode(env.OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION),
    ownerTailAgents: String(env.OMC_JEV_COMPACT_OWNER_TAIL_AGENTS ?? '').trim() === 'active',
    ownerTailOverflow: String(env.OMC_JEV_COMPACT_OWNER_TAIL_OVERFLOW ?? '').trim() === 'keep' ? 'keep' : 'revert',
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

// The open breaker {until, reason, since[, scope]} (epoch ms), or undefined when it is closed, expired,
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
  return { until: state.until, reason: String(state.reason ?? ''), since: Math.min(since, now), ...(state.scope === 'low' ? { scope: state.scope } : {}) };
}

// Mirror of breakerCovers(breaker, 'compaction'): a breaker of scope "low" (OMC_JEV_BREAKER_TIMEOUT_LOW, written by the script side
// for requests without a response of low-priority points only) holds back the low-priority points only, and `compaction` is a
// medium-priority point; every other open breaker holds back every point.
const holdsBack = (breaker) => Boolean(breaker) && breaker.scope !== 'low';

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
        // This opening holds back every point: a breaker of scope "low" is rewritten for every point even when it ends later (mirror of openBreaker).
        const widens = Boolean(current) && current.scope === 'low';
        if (current && !widens && current.until >= until - EXTEND_MIN_MS) return current;
        const state = { until: widens ? Math.max(current.until, until) : until, reason, since: current ? Math.min(current.since, since) : since };
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
  if (holdsBack(open)) return { skip: { mode: 'circuit-open', breaker: open } };
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
  if (cfg.shared && holdsBack(await sharedStep($, () => readSharedBreaker($, cfg.shared, now), undefined))) return 'breaker_open';
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

const namesSecretPath = (value, privatePaths) => SECRET_PATH.test(value) || namesPrivatePath(value, privatePaths);

// A character of a path written as an escape: a JSON `\uXXXX` (behind any run of backslashes, as each further JSON string doubles it) or the `%XX` bytes of one
// UTF-8 character in a URL. Only well-formed UTF-8 is matched, so no decoding throws (a thrown error costs far more than the scan); other bytes stay as written.
// Each escape is of a bounded length, the text is decoded once (a double encoding stays as it is) and every run is read from its start only, so the scan stays linear.
// A text longer than PATH_DECODE_MAX characters is not decoded: when it holds an escape it counts as naming a private path.
const PATH_ESCAPE = /(?<!\\)\\+u([0-9a-fA-F]{4})|%(?:[0-7][0-9a-fA-F]|(?:[cC][2-9a-fA-F]|[dD][0-9a-fA-F])%[89abAB][0-9a-fA-F]|(?:[eE]0%[abAB]|[eE][dD]%[89]|[eE][1-9a-cA-CefEF]%[89abAB])[0-9a-fA-F]%[89abAB][0-9a-fA-F]|(?:[fF]0%[9abAB]|[fF]4%8|[fF][1-3]%[89abAB])[0-9a-fA-F](?:%[89abAB][0-9a-fA-F]){2})/g;
const PATH_DECODE_MAX = 4194304;
const pathEscape = (all, code) => (code !== undefined ? String.fromCharCode(parseInt(code, 16)) : decodeURIComponent(all));

function namesPrivatePath(value, privatePaths) {
  if (!privatePaths.length) return false;
  // Every run of slashes and backslashes as one slash: a Windows path, its JSON form (C:\\Users\\x), an escaped
  // slash (\/home\/u) and a doubled slash all compare equal to the private path (linear, unlike slash()).
  const text = String(value);
  const names = (s) => { const v = s.replace(/[\\/]+/g, '/').toLowerCase(); return privatePaths.some((p) => v.includes(p)); };
  if (names(text)) return true;
  // The text as written first, then with its escapes read: a path may hold what looks like an escape (`C:\data\ubeef`).
  if (!text.includes('%') && !text.includes('\\u')) return false;
  if (text.length > PATH_DECODE_MAX) return true;
  const decoded = text.replace(PATH_ESCAPE, pathEscape);
  return decoded !== text && names(decoded);
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
// <file>", "output_file: <file>"), for calls on secret or private paths (`secret`) and for prose calls naming one or reading the
// output of a call that an earlier compaction removed (`held`): a later Read, `tail` or `cat` of such a file reads that call's output. A file is a word of the first
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
  // A call that reads the output file of an earlier one takes its secrecy (findCandidates holds its result the same way), and so do its own task and output file: the
  // chain of tasks is as secret as its first link. The indexes of the files so far (each file indexed once as it comes), read in the order of the calls.
  const secretFiles = fileIndex(out.secret);
  const heldFiles = fileIndex(out.held);
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const u of m.toolUses || []) {
      if (u.input?.run_in_background !== true || !results.has(u.tool_use_id)) continue;
      const list = touchesSecretPath(u.tool, u.input, privatePaths) || readsFile(u.input, secretFiles) ? out.secret
        : (PROSE_TOOLS.has(u.tool) && anySecretPath(u.input, privatePaths)) || readsFile(u.input, heldFiles) || readsUnknownOutput(u.input, known) ? out.held : undefined;
      const head = results.get(u.tool_use_id).slice(0, OUTPUT_SCAN_CHARS);
      const named = [...head.matchAll(TASK_ID_IN_RESULT)].map((m) => m[1]);
      for (const id of named) { ids.known.add(id); (list === out.secret ? ids.secret : list === out.held ? ids.held : ids.known).add(id); }
      for (const w of head.split(/[\s"'`|;&<>()[\]{},=]+/)) {
        const file = outputFileOf(w);
        if (!file) continue;
        const name = file.slice(file.lastIndexOf('/') + 1);
        for (const f of name.length >= 6 ? [file, name] : [file]) {
          known.add(f);
          if (list && !list.has(f)) { list.add(f); indexFile(list === out.secret ? secretFiles : heldFiles, f); }
        }
      }
    }
  }
  return { secret: secretFiles, held: heldFiles, known, ids };
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
// Only the heads of its blocks name its source (noteHeads): a file that the words of a task quote says nothing about where the notification comes from.
function sourceUnknown(text, outputs) {
  for (const head of noteHeads(text)) for (const m of head.matchAll(/<output-file>([^<]{1,1000})<\/output-file>/g)) if (unknownFile(m[1].trim(), outputs.known)) return true;
  return false;
}
// What a notification says about its source, block by block (a row may hold several): 'secret' or 'held' when a call on a secret path started the task of a block
// (by its <task-id>), 'unknown' when a block's task is tied to no call still in the conversation and its output file is not either (an earlier compaction removed
// the call, and with it what said whether it was on a secret path), otherwise 'known'. The worst block decides: secret, then held, then unknown. A marker of the host
// that no block follows (only its own line between them) is a notification without a task, so 'unknown' too: a row of envelopes may hold one next to a block.
const NOTE_MARKER = DELIVERY_NOTES[0];
const NOTE_BLOCK_OPEN = /<task-notification[\s>]/g;
// What a notification block holds before its <summary> and its <result>: its own metadata (the task id, the output file, the status). The summary and the result are the
// words of the task and may quote the source of another notification, so the source is read from here and nowhere else in the block.
const noteHead = (block) => { const at = block.search(/<(?:summary|result)>/); return at < 0 ? block : block.slice(0, at); };
// The task ids and output files that a text names in their tags, as [tag, value] in order, at most `limit` of them: the value is what stands between the opening tag and
// the closing one that follows without another tag between (blank space around it dropped, 1 to 200 characters). Read tag by tag, each stretch up to the next `<` once,
// so that a long run of blank space or a tag that is never closed costs one pass over it (one pattern with a `\s*` on each side of a bounded value backtracks in time
// quadratic in the run).
function sourceFields(text, limit) {
  const found = [];
  const open = /<(task-id|output-file)>/g;
  for (let m = open.exec(text); m && found.length < limit; m = open.exec(text)) {
    const from = m.index + m[0].length;
    const lt = text.indexOf('<', from);
    const to = lt < 0 ? text.length : lt;
    if (!text.startsWith(`</${m[1]}>`, to)) continue;
    const value = text.slice(from, to).trim();
    if (value && value.length <= 200) found.push([m[1], value]);
  }
  return found;
}
// The heads of the notification blocks of a text, in order (a block that is not closed runs to the end of the text).
function noteHeads(text) {
  const heads = [];
  for (let at = 0; at < text.length;) {
    NOTE_BLOCK_OPEN.lastIndex = at;
    const open = NOTE_BLOCK_OPEN.exec(text);
    if (!open) break;
    const close = text.indexOf('</task-notification>', open.index);
    at = close < 0 ? text.length : close + '</task-notification>'.length;
    heads.push(noteHead(text.slice(open.index, at)));
  }
  return heads;
}
function sourceByTask(text, outputs, wideFrame = false) {
  let worst = 'known';
  let at = 0;
  let blocks = 0;
  while (at < text.length) {
    NOTE_BLOCK_OPEN.lastIndex = at;
    const open = NOTE_BLOCK_OPEN.exec(text);
    const outside = text.slice(at, open ? open.index : text.length);
    // Once per stretch between blocks: a second marker there leaves the first without a block (its own line is no host line), so only one marker is looked at.
    const m = worst === 'unknown' ? -1 : outside.indexOf(NOTE_MARKER);
    if (m >= 0 && (!open || outside.indexOf(NOTE_MARKER, m + NOTE_MARKER.length) >= 0 || !withoutTags(outside.slice(m + NOTE_MARKER.length)).split('\n').every((l) => !l.trim() || hostLineOf(wideFrame).test(l.trim())))) worst = 'unknown';
    if (!open) break;
    const close = text.indexOf('</task-notification>', open.index);
    const end = close < 0 ? text.length : close + '</task-notification>'.length;
    const block = noteHead(text.slice(open.index, end));
    blocks++;
    at = end;
    // A block names one task, a shortened one (its ids are kept) may name several.
    const taskIds = [...block.matchAll(/<task-id>\s*([\w-]{1,64})\s*<\/task-id>/g)].map((m) => m[1]);
    if (taskIds.some((id) => outputs.ids.secret.has(id))) return 'secret';
    if (taskIds.some((id) => outputs.ids.held.has(id))) worst = 'held';
    else if (worst === 'known' && !(taskIds.length && taskIds.every((id) => outputs.ids.known.has(id))) && !namesKnownFile(block, outputs.known)) worst = 'unknown';
  }
  return blocks ? worst : 'unknown'; // a row that holds no block names no task at all
}
// Whether a notification block names an output file that a call still in the conversation produced: its source is then known, whatever its task id says.
const namesKnownFile = (text, known) => [...text.matchAll(/<output-file>([^<]{1,1000})<\/output-file>/g)].some((m) => { const f = outputFileOf(m[1].trim()); return Boolean(f) && (known.has(f) || known.has(f.slice(f.lastIndexOf('/') + 1))); });
const unknownFile = (word, known) => {
  const file = outputFileOf(word);
  return Boolean(file) && !known.has(file) && !known.has(file.slice(file.lastIndexOf('/') + 1));
};
// The same for a call that reads such a file (a `cat` or `tail` of `.../tasks/<id>.output`): the file of a background call that an earlier compaction cut. The file is named
// as the host writes it (`.../tasks/<name>.output`) or as an agent in the task directory reads it, by its name alone (`cd <dir> && cat <id>.output`) or by a path relative to
// it (`tasks/<id>.output`, `./<id>.output`): a name that is an id (4 to 64 word characters and hyphens, as TASK_ID_IN_RESULT reads one) and the extension .output is the file
// of a task whatever stands before it. The files of the host are not known here, so a file of another kind with such a name is held too. A glob of such names
// (`tasks/*.output`, `??.output`, `[a-z]*.output`, `{a,b}.output`) may name the file of a task whose start was cut, so it is held whatever the index holds, and so is a glob of the
// directory itself, a wildcard among the at most 64 name characters after a directory called tasks (`tasks/*`, `tasks/?x`, `tasks/[a-z]*`, `tasks/{a,b}`), with no extension named.
const GLOB_OUTPUT = /\.output\b(?<=[*?[{][\w.*?[\]{},-]{0,64}\.output)|(?<![\w.-])tasks\/[\w.-]{0,64}[*?[{]/i;
function readsUnknownOutput(input, known) {
  // Every run of slashes and backslashes as one slash first (a Windows path, its JSON form with doubled backslashes, mixed separators), as the index of the files
  // is kept. Then only the file's own name is what the index holds, so that the read is linear whatever the input holds (a name starts where no name character stands before it;
  // the glob is looked for from each `.output`, back over at most 64 name characters for a wildcard, and from each `tasks/`, forward over at most 64, so no start reads more than a bounded run).
  const text = inputJson(input).replace(/[\\/]+/g, '/');
  if (GLOB_OUTPUT.test(text)) return true;
  for (const m of text.matchAll(/\/tasks\/[\w.-]+\.output\b|(?<![\w.-])[\w-]{4,64}\.output\b/gi)) if (!known.has(m[0].slice(m[0].lastIndexOf('/') + 1).toLowerCase())) return true;
  return false;
}
// Does a string of the input name one of the files as a whole name (not a part of a longer name or path)? The files
// are kept by the run of name characters they end with; where such a file ends, that run is the whole run of name
// characters of the input, so each string is read once however many files there are. A file that does not end with a
// name character is searched for whole.
const FILE_NAME_CHAR = /[a-z0-9_.-]/;
function indexFile(index, f) {
  let k = f.length;
  while (k > 0 && FILE_NAME_CHAR.test(f[k - 1])) k--;
  if (k === f.length) index.other.push(f);
  else {
    const run = f.slice(k);
    if (index.byRun.has(run)) index.byRun.get(run).push(f);
    else index.byRun.set(run, [f]);
  }
  index.size++;
}
function fileIndex(files) {
  const index = { byRun: new Map(), other: [], size: 0 };
  for (const f of files) indexFile(index, f);
  return index;
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
function userTask(messages, instructions, queued = new Map(), privatePaths = [], notUserPrefixes = NOT_USER_PREFIXES, limits = { chars: USER_CHARS, messages: USER_MESSAGES }) {
  let left = limits.chars;
  const clean = (text) => maskSecrets(omitSecretLines(text, privatePaths));
  const mention = [];
  const raw = instructions ? headPart(String(instructions), left + MASK_SLACK_CHARS) : '';
  const instr = instructions ? clip(clean(raw), left) : undefined;
  if (instr) {
    mention.push(raw);
    left -= instr.length;
  }
  const picked = [];
  for (let i = messages.length - 1; i >= 0 && picked.length < limits.messages && left > 0; i--) {
    const words = [...userWords(messages[i], notUserPrefixes), ...(queued.get(i) || []).flatMap(blockWords)];
    for (let k = words.length - 1; k >= 0 && picked.length < limits.messages && left > 0; k--) {
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
  if (c.note) return `[compacted] ${NOTE_LABEL} (${clip(c.summary, TRACE_INPUT_CHARS)}) - ${c.resultChars} chars removed${archiveSuffix(c.archivePath)}`;
  const what = !c.textOnly ? 'non-text result (image or file) removed' : `${c.res.isError ? 'error' : 'result'} of ${c.resultChars} chars removed`;
  return `[compacted] ${c.use.tool}(${clip(c.summary, TRACE_INPUT_CHARS)}) - ${what}${archiveSuffix(c.archivePath)}`;
}

// A notification's cut keeps its summary and the first SHORT_CHARS of its <result> body (the part before it is the same fixed text in every
// notification); without a <result>, the first SHORT_CHARS of the text. The kept text stays inside the notification's own tag, as in the host's row: the tag
// makes it one quote to every reading of the row (a delivery the result quotes is no delivery), and the row is the notification it was at the next compaction.
function shortText(c) {
  if (c.note) {
    const body = /<result>([\s\S]*?)(?:<\/result>|$)/.exec(c.res.text);
    // The summary stays a <summary> field, after the source: the next compaction reads it from there (noteSummary), not the first line it finds, which is the source.
    const summary = c.summary ? `<summary>${c.summary}</summary>\n` : '';
    // The kept text stays in a <result> field, as in the notification it was cut from: a later cut of the copy finds it there and keeps it (the rest of the copy is its framing).
    const kept = `${summary}<result>${body ? body[1].slice(0, SHORT_CHARS) : c.res.text.slice(0, SHORT_CHARS)}</result>`;
    // The source stays in the copy (the task ids and output files of the notification, the first few): the next compaction ties it to its call by them.
    const source = sourceFields(noteHeads(c.res.text).join('\n'), 8).map(([tag, value]) => `<${tag}>${value}</${tag}>\n`).join('');
    return `[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n${source}${kept}\n[notification shortened at compaction: kept ${SHORT_CHARS} of ${c.resultChars} chars${archiveSuffix(c.archivePath)}]\n</task-notification>`;
  }
  return `${c.res.text.slice(0, SHORT_CHARS)}\n[result shortened at compaction: kept ${SHORT_CHARS} of ${c.resultChars} chars${archiveSuffix(c.archivePath)}]`;
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
  // A notification block opens as NOTE_BLOCK_OPEN says (its name, then an attribute or the end of the tag); the search for its closing tag starts after the name.
  const noteOpen = (from) => { NOTE_BLOCK_OPEN.lastIndex = from; return NOTE_BLOCK_OPEN.exec(text)?.index ?? -1; };
  const kinds = [
    { find: (from) => text.indexOf('<system-reminder>', from), len: '<system-reminder>'.length, close: '</system-reminder>', next: -2, plain: true },
    { find: noteOpen, len: '<task-notification'.length, close: '</task-notification>', next: -2, plain: false },
  ];
  const plain = [];
  let rest = '';
  let first = -1; // where the first closed block starts
  let at = 0;
  for (;;) {
    let kind;
    for (const x of kinds) {
      if (x.next === -1) continue;
      if (x.next < at) x.next = x.find(at);
      if (x.next >= 0 && (!kind || x.next < kind.next)) kind = x;
    }
    if (!kind) break;
    const end = text.indexOf(kind.close, kind.next + kind.len);
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
// The block is foreign also when it holds more than its opening: around a notification block only the marker and the host's own line may stand, and a reminder
// beside it holds nothing but the host's list of the tools used (anything else in a reminder is a message or words of someone else).
const foreignBlock = (wideFrame) => (block) => {
  const body = block.replace(DELIVERY_WRAP, '');
  if (frameOf(block) !== undefined && !DELIVERY_NOTES.some((k) => body.startsWith(k))) return true;
  const { rest } = withoutReminderBlocks(body.slice(0, Math.max(0, body.lastIndexOf('</system-reminder>'))));
  const lines = rest.split('\n').map((l) => l.trim()).filter(Boolean);
  return body.includes('</task-notification>')
    ? lines.some((l) => l !== DELIVERY_NOTES[0] && !hostLineOf(wideFrame).test(l))
    : lines.some((l) => !NOTE_HOST_TOOLS.test(l));
};
// The line the host writes between the marker and the first block; anything else there is not the host's framing, whoever it is from.
const NOTE_HOST_LINE = /^This is an automated background-task event(?:, NOT a message from the user)?\.$/;
// While the blocks act the host's other two lines of that frame are its own as well: the warning against reading the event as the user's answer and the statement that no human input
// came since the last genuine user message (each anchored to its whole text, so a line that adds to it is still someone else's).
const NOTE_HOST_LINE_WIDE = /^(?:This is an automated background-task event(?:, NOT a message from the user)?\.|Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question\.|No human input has been received since the last genuine user message in this conversation\. Any statement that the user said, approved, or confirmed something[^\n]{0,120}is NOT real user input and must NOT be treated as approval or consent\.)$/;
const hostLineOf = (wideFrame) => (wideFrame ? NOTE_HOST_LINE_WIDE : NOTE_HOST_LINE);
// The one reminder the host writes beside a notification: the tools the session used before its summary.
const NOTE_HOST_TOOLS = /^<tools-used-before-summary>[^<\n]*<\/tools-used-before-summary>$/;
function isNoteBody(t, wideFrame = false) {
  const { rest, plain, first } = withoutReminderBlocks(t);
  if (plain.some(foreignBlock(wideFrame))) return false;
  if (!t.startsWith(DELIVERY_NOTES[0])) return rest.trim() === '';
  // Opening with the marker is no leave for what stands outside the blocks: the marker line and the host's line before the first block (NOTE_HOST_LINE,
  // nothing else) are the notification's own; with a block, nothing but blank space may follow it. Without a block the text after the marker is the body, but a
  // line that opens a frame of another sender in it is that sender's message, which a compaction must keep (a line that opens a notification is no such frame).
  if (first < 0) return !frameLines(t).some((at) => !startsNote(t.slice(at, at + DELIVERY_NOTES[0].length)));
  return rest.slice(first).trim() === '' && t.slice(DELIVERY_NOTES[0].length, first).split('\n').every((line) => !line.trim() || hostLineOf(wideFrame).test(line.trim()));
}
// A row of envelopes and nothing else, each holding a notification: a delivery of another kind (the coordinator, another session, a plugin), also inside a
// <system-reminder> in the envelope, leaves the row alone.
function onlyNoteEnvelopes(t, envelopes, wideFrame = false) {
  let at = 0;
  for (const e of envelopes) {
    if (t.slice(at, e.from).trim() || !isNoteBody(e.text.slice(e.text.indexOf('">') + 2, e.text.lastIndexOf(ENVELOPE_CLOSE)).trim(), wideFrame)) return false;
    at = e.to;
  }
  return !t.slice(at).trim();
}
export function isNotification(m, blockTraces = false) {
  if (m.role !== 'user' || (m.toolResults && m.toolResults.length) || typeof m.text !== 'string' || !m.text) return false;
  // The marker first: a row without one is no notification, and its words are not read at all.
  if (!DELIVERY_NOTES.some((k) => m.text.includes(k)) || userWords(m, notUserOf(blockTraces)).length) return false;
  const t = m.text.trim();
  const envelopes = envelopesOf(t);
  return envelopes.length ? onlyNoteEnvelopes(t, envelopes, blockTraces) : isNoteBody(t, blockTraces);
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

// Candidates: tool results outside the first message and before `tailFrom` (unset: before the last KEEP_LAST messages) whose call is
// in an earlier assistant message. The options stand in one object, so that a parameter added after it cannot take their place.
function findCandidates(messages, privatePaths, notifications = false, { blockTraces = false, tailFrom } = {}) {
  const outputs = backgroundOutputFiles(messages, privatePaths);
  const uses = new Map();
  messages.forEach((m, i) => { if (m.role === 'assistant') for (const u of m.toolUses || []) uses.set(u.tool_use_id, { i, u }); });
  const tailStart = tailFrom ?? Math.max(1, messages.length - KEEP_LAST);
  const out = [];
  for (let i = 1; i < tailStart; i++) {
    const m = messages[i];
    if (notifications && isNotification(m, blockTraces)) {
      // A notification that names the output file of a call on a secret path takes on the secrecy of that call (a trace, never sent to Jev).
      const bySource = sourceByTask(m.text, outputs, blockTraces);
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
// pass reached, the target and the predicted tokens after. `opts.stopAfterA` ends after the second pass (the second round goes on from there, in Jev's order), and
// `opts.resume` goes on from the keep decisions the candidates hold (what the second round set) and runs only the passes that follow it.
// A forced result (a secret, or a non-text result) goes to a trace first, whatever its score; a pinned one is never cut by the cascade and is
// not counted in the floor.
const isForced = (c) => c.secret || !c.textOnly;
// A trace that is longer than its call and result is no saving by the text alone, but it takes the blocks of the call and of the result off the list (shapeOf: `marginal`):
// such a result stays whole only when the blocks do not pay for the text either.
const isPinned = (c, rates = DEFAULT_RATES, shape = undefined) => {
  if (isForced(c)) return false;
  if (c.task) return true;
  const t = itemTokens(c, rates);
  return t.full - t.trace + (shape?.marginal(c) ?? 0) <= 0;
};
export function cascade(candidates, tokensBefore, target, rates = DEFAULT_RATES, shape = undefined, opts = {}) {
  const costs = new Map(candidates.map((c) => [c, itemTokens(c, rates)]));
  // The blocks and messages the decisions take off the list come on top of the candidates' costs (shapeOf).
  const overhead = shape?.tracker();
  const saved = (c, keep) => {
    const t = costs.get(c);
    return keep === 'short' ? t.full - t.short : keep === 'trace' ? t.full - t.trace : keep === 'drop' ? t.full - t.drop : 0;
  };
  let removed = 0;
  const setKeep = (c, keep) => { removed += saved(c, keep) - saved(c, c.keep ?? 'full'); overhead?.set(c, keep); c.keep = keep; };
  const left = () => tokensBefore - removed - (overhead?.removed() ?? 0);
  const reached = () => left() <= target;
  const resume = opts.resume === true;
  if (resume) for (const c of candidates) { const was = c.keep ?? 'full'; c.keep = 'full'; if (was !== 'full') setKeep(c, was); }
  else for (const c of candidates) c.keep = 'full';
  let pass = resume ? 'reserve' : 'forced';
  if (!resume) for (const c of candidates) if (isForced(c)) setKeep(c, 'trace');
  const free = candidates.filter((c) => !isForced(c) && !isPinned(c, rates, shape)).sort((a, b) => a.score - b.score || a.resIdx - b.resIdx);
  if (!resume && !reached()) {
    pass = 'short_or_trace';
    for (const c of free) {
      if (reached()) break;
      if (c.score < SHORT_COPY_MIN_SCORE) setKeep(c, 'trace');
      else if (c.resultChars > SHORT_CHARS) {
        // The short copy stays when the decision takes tokens off the list as a whole, its text and the blocks it frees together: a notification rebuilt as a short copy
        // brings the envelopes of its deliveries, which cost more than its text may save, and frees their blocks.
        const before = left();
        setKeep(c, 'short');
        if (left() >= before) setKeep(c, 'full');
      }
    }
  }
  if (opts.stopAfterA) return { pass, target, predicted: Math.max(0, Math.round(left())) };
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
  return { pass, target, predicted: Math.max(0, Math.round(left())) };
}

// The floor of the cascade: the predicted tokens when every removable result (every candidate but the pinned ones) is gone with its call.
export function floorPrediction(candidates, tokensBefore, rates = DEFAULT_RATES, shape = undefined) {
  const free = candidates.filter((c) => !isPinned(c, rates, shape));
  return tokensBefore - free.reduce((s, c) => s + itemTokens(c, rates).full - itemTokens(c, rates).drop, 0) - (shape ? shape.shed(free, 'drop') : 0);
}

// A manual compaction at or below the usual target: only the scores decide. Every forced result goes to a trace, and so does every free result
// Jev scored under SHORT_COPY_MIN_SCORE; the rest stays whole. Returns the prediction after the removal (no pass beyond it).
export function manualPlan(candidates, tokensBefore, rates = DEFAULT_RATES, shape = undefined) {
  let removed = 0;
  const overhead = shape?.tracker();
  for (const c of candidates) {
    c.keep = 'full';
    if (isForced(c) || (!isPinned(c, rates, shape) && c.score < SHORT_COPY_MIN_SCORE)) {
      c.keep = 'trace';
      overhead?.set(c, 'trace');
      const t = itemTokens(c, rates);
      removed += t.full - t.trace;
    }
  }
  return { pass: 'manual', predicted: Math.max(0, Math.round(tokensBefore - removed - (overhead?.removed() ?? 0))) };
}

const removableChars = (candidates) => candidates.reduce((s, c) => s + Math.max(0, c.fullCost - c.traceCost - (c.envelope || 0)), 0);

// Rank and fill the budget: highest score first while the upgrade from a trace fits; a result that
// does not fit whole and scores at least "may be useful" is cut to SHORT_CHARS when that fits; the rest
// is traced. A result not asked about (secret path, no text, beyond the questions) is traced; a call
// not longer than its trace and the task list stay whole. `added`: characters the built list adds
// whatever is decided (the envelopes of carried messages).
function allocate(candidates, before, target, added = 0) {
  // A notification that is replaced brings the envelopes of its deliveries with it (`envelope`): they are part of what its trace costs.
  const traced = (c) => c.traceCost + (c.envelope || 0);
  const fixed = before + added - candidates.reduce((s, c) => s + c.fullCost - traced(c), 0);
  // A notification kept whole (its trace with the envelopes costs more than its text: nothing in the ranking changes that) writes none of the envelopes that `fixed` counted
  // with its trace: they are given back before the ranking, so that no result is cut for them whatever the place of the notification in it.
  const keptWhole = candidates.filter((c) => c.note && !c.secret && c.textOnly && c.fullCost - traced(c) < 0);
  let avail = Math.floor(before * target) - fixed - keptWhole.reduce((s, c) => s + c.fullCost - traced(c), 0);
  const ranked = [...candidates].sort((a, b) => b.score - a.score || b.resIdx - a.resIdx);
  for (const c of ranked) {
    const upFull = c.fullCost - traced(c);
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
// The rule's target of the token cascade: the usual target before the owner's limit, then the limit from the configured window ceiling (absent by default).
function ruleTargetOf(win, cfg) {
  const raw = Math.floor(TARGET_UNCALIBRATED * usualTarget(win, cfg.targetPercent));
  const ceiling = tokenCeiling(cfg.maxWindowTokens, cfg.rates);
  return ceiling === undefined ? raw : Math.min(raw, ceiling);
}

// A one-line trace of the module, wherever it stands in a text: at its start or after a line break. A removed item (traceLine), a reply moved to a file and
// an agent's message moved to a file each fill their line; the trace of a pasted text stands inside a line (PASTE_TRACE_PREFIX, see withoutPasteMarks).
const TRACE_LINE = new RegExp(`(?:^|\\n)(?:\\[compacted\\] |${escapeRegExp(REPLY_TRACE_PREFIX)}|${escapeRegExp(AGENT_TRACE_PREFIX)})[^\\n]*`, 'g');
// With `rates.blockTraces` (the blocks act) the lines of moved blocks and the header of the trace files are traces too.
const TRACE_LINE_BLOCKS = new RegExp(`(?:^|\\n)(?:\\[compacted\\] |${escapeRegExp(REPLY_TRACE_PREFIX)}|${escapeRegExp(AGENT_TRACE_PREFIX)}|${escapeRegExp(BLOCK_TRACE_PREFIX)}|${escapeRegExp(TRACE_HEADER_PREFIX)})[^\\n]*`, 'g');
// The API list in tokens by class: a call costs RATE_IN a character of its name and input, a result RATE_OUT, a reminder or a text beside a result
// RATE_NOTE, the user's words RATE_OWN (a text that userWords reads as the user's: not a summary, a notice or a host block), the assistant's text
// RATE_ATXT, a trace of any of the module's stages RATE_TRACE, each non-ASCII character RATE_NON_ASCII more, RATE_BLOCK a block and RATE_MESSAGE a message spread over its blocks,
// an image RATE_IMAGE. A block of thinking costs its overhead only: the characters of thinking text and signatures (RATE_SIG, which tokensBeforeOf adds to an estimate and the predictions
// take off for the rows build rebuilds, signatureRows) and server blocks are not counted here.
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
        const lines = t.replace(rates.blockTraces ? TRACE_LINE_BLOCKS : TRACE_LINE, (x) => { inTraces += x.length; return ''; });
        const rest = withoutPasteMarks(lines);
        inTraces += lines.length - rest.length;
        // Whose the text is, is read from what stands outside the trace lines: a trace of the module at the start of a row does not make the text after it the user's own.
        const rate = a.role === 'assistant' ? RATE_ATXT : hasResult || !userWords({ role: 'user', text: lines }).length ? RATE_NOTE : RATE_OWN;
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
      } else if (b.type === 'image') tok += RATE_IMAGE + over;
      else tok += over;
    }
    // RATE_MESSAGE is negative, so a message of few blocks with a low RATE_BLOCK override would cost less than nothing: a message costs zero at least.
    if (tok < before) tok = before;
  }
  return tok;
}

// What the text blocks of a user message cost less once no result stands in the message than they do beside one: listTokens counts a text beside a result at
// RATE_NOTE and the words of the user alone at RATE_OWN (a text that is not theirs stays at RATE_NOTE).
function besideResultGap(texts, rates) {
  let gap = 0;
  for (const t of texts) {
    const lines = t.replace(rates.blockTraces ? TRACE_LINE_BLOCKS : TRACE_LINE, '');
    if (userWords({ role: 'user', text: lines }).length) gap += (rates.RATE_NOTE - rates.RATE_OWN) * withoutPasteMarks(lines).length;
  }
  return gap;
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
    const kept = RATE_NOTE * (c.envelope || 0);
    return { full, short: c.resultChars > SHORT_CHARS ? cost(shortText(c)) + kept : full, trace: RATE_TRACE * c.trace.length + kept, drop: RATE_NOTE * (c.envelopeDrop || 0) };
  }
  const json = inputJson(c.use.input);
  const call = RATE_IN * ((c.use.tool || '').length + json.length) + RATE_NON_ASCII * nonAscii(json);
  const cost = (text) => RATE_OUT * text.length + RATE_NON_ASCII * nonAscii(text);
  const full = call + cost(c.res.text || '') + RATE_IMAGE * imagesOf(c.res);
  const short = c.resultChars > SHORT_CHARS ? call + cost(shortText(c)) : full;
  return { full, short, trace: RATE_TRACE * c.trace.length, drop: 0, call };
}

// The shape of the list. listTokens charges a block RATE_BLOCK and a message RATE_MESSAGE once (nothing for a message that holds no block), and the costs of a
// candidate (itemTokens) leave both out; build changes them: a call or a result taken from a row takes its block, the traces of an assistant message come into
// the one text block that holds its text, a message left with no block is gone, a row of thinking is dropped, a row removed by the agent trim is gone, and the
// deliveries after a row become one block of its text. Parallel calls make this the larger part of what a cut gives back (a message of 25 calls costs 25 blocks,
// its traces one). So the floor, the cascade, the manual plan, the gates of cutInTokens and the accounting take it from here, in one place, and predict the list
// as listTokens counts the list build writes. The messages are the host's: an assistant message is the rows of one group (groupsOf), a user message a run of user
// rows; the rows from `keepFrom` on keep their handles and stay as they are. `rows` are the rows build is given (a row of the trim that goes whole has `trimDrop`; a row whose
// pasted tag the paste stage moved holds its trace, and the words of the user in a message are read from these rows, not from `messages`), `queued` the deliveries after each row. A user message that no result stands in any more has its text at the rate of the words of the user (besideResultGap). The
// user rows on both sides of an assistant message that is gone (no text, no trace, every call dropped) are one message of the host: the tracker joins their runs, so they
// cost one message, and their words keep the rate of a text beside a result while a result stays in either. A notification row that is replaced is one text block with the
// blocks delivered after it, which costs the rate of the words of the user when a message of the user is among them (noteOwn). The words of a run that held no result, joined to a
// message that keeps one (an assistant message of thinking alone leaves such a join), stand beside it: they cost more than they did (`loss`). A message costs zero at least (listTokens), its text and its overhead together, so what its structure adds to the text `tok` is
// no less than -tok; at the default rates it is never negative and the text is not needed (Infinity). The text holds the blocks delivered after its rows, as the host holds them (`tok`)
// and, once a row of text results is rewritten, as build writes them (`tokBuilt`). The floor is held to the text the message has after the cut, the words of the user at the rate their class takes
// then (`tok` less the rebate, whether a discount for words that no result stands beside any more or the loss of words that one now does), not at the rate they had before it.
const messageTokens = (blocks, tok, rates) => (blocks > 0 ? Math.max(-tok, blocks * rates.RATE_BLOCK + RATE_MESSAGE) : 0);
export function shapeOf(messages, candidates, { rows = messages, group, keepFrom, queued = new Map(), rates = DEFAULT_RATES }) {
  const queuedAt = (i) => (queued.get(i) || []).length;
  const callsAt = (m) => (m.toolUses || []).length;
  const resultsAt = (m) => (m.toolResults || []).length;
  // The blocks of a row as the host holds it: its text, its calls and results, the deliveries after it, and the block of thinking that an assistant row with neither text nor call stands for.
  const blocksAt = (i) => {
    const m = messages[i];
    return (m.text ? 1 : 0) + callsAt(m) + resultsAt(m) + queuedAt(i) + (m.role === 'assistant' && !m.text && !callsAt(m) ? 1 : 0);
  };
  // Only with a block rate under -RATE_MESSAGE can a message cost less than its text, and only then is its text needed: that of its rows as listTokens counts it (the
  // block rate that cancels the constant of the message leaves the text alone). The deliveries after a row are text of its message, each a block as the host holds them (a row that
  // the trim removes takes none); `built` is the text of a row of text results that build rewrites: its own text and the deliveries in their envelopes as one block (carriedText).
  const floored = rates.RATE_BLOCK + RATE_MESSAGE < 0;
  const textOf = (role, idx, built = false) => {
    if (!floored) return Infinity;
    const content = idx.flatMap((i) => {
      const own = rowsAsApi([messages[i]])[0].content;
      const blocks = rows[i].trimDrop === true ? [] : queued.get(i) || [];
      if (built && blocks.length && textRow.has(i)) return [{ type: 'text', text: carriedText(messages[i], blocks).text }, ...own.filter((b) => b.type !== 'text')];
      return [...own, ...blocks.map((text) => ({ type: 'text', text }))];
    });
    return content.length ? listTokens([{ role, content }], { ...rates, RATE_BLOCK: -RATE_MESSAGE / content.length }) : 0;
  };
  const noteAt = new Set(candidates.filter((c) => c.note).map((c) => c.resIdx));
  const textRow = new Set(messages.flatMap((m, i) => (resultsAt(m) && m.toolResults.every(textOnlyResult) ? [i] : [])));
  const assistants = new Map();
  const runs = [];
  const runOf = new Map();
  let run;
  let after;
  messages.forEach((m, i) => {
    if (m.role === 'assistant') {
      run = undefined;
      after = group[i];
      if (!assistants.has(group[i])) assistants.set(group[i], { before: 0, text: false, calls: 0, first: i, idx: [], edges: [] });
      const u = assistants.get(group[i]);
      u.idx.push(i);
      u.before += blocksAt(i);
      u.text ||= Boolean(m.text);
      u.calls += callsAt(m);
      return;
    }
    if (!run) {
      runs.push((run = { before: 0, rows: [], k: runs.length }));
      // The assistant message right before this run (`edges`): once it is gone, this run and the one before it are one user message.
      if (runs.length > 1) assistants.get(after).edges.push(run.k);
    }
    run.before += blocksAt(i);
    run.rows.push(i);
    runOf.set(i, run);
  });
  for (const u of assistants.values()) u.tok = textOf('assistant', u.idx);
  for (const r of runs) {
    r.tok = textOf('user', r.rows);
    r.tokBuilt = r.rows.some((i) => queued.has(i)) ? textOf('user', r.rows, true) : r.tok;
    // The results that stand in the message after the agent trim (`results`), whether one stood in it before (`beside`), and the tokens the words of its text cost less once none
    // does (`gap`) or more once one stands in it (`loss`, for a run that held none): the text as build writes it, a row of results as one block of its text with its deliveries,
    // any other row as its text and each delivery after it.
    r.results = r.rows.reduce((n, i) => n + (rows[i].trimDrop === true ? 0 : resultsAt(messages[i])), 0);
    r.beside = r.rows.some((i) => resultsAt(messages[i]) > 0);
    const words = besideResultGap(r.rows.flatMap((i) => (rows[i].trimDrop === true ? [] : resultsAt(messages[i]) ? [carriedText(rows[i], queued.get(i)).text] : [rows[i].text || '', ...(queued.get(i) || [])]).filter(Boolean)), rates);
    r.gap = r.beside ? words : 0;
    r.loss = r.beside ? 0 : words;
  }
  // What the text of a notification row costs less at the rate of the words of the user than at that of a reminder, for each keep decision (listTokens counts a text block at the
  // former when a message of the user is in it, in a message that holds no result). A notification that is replaced is one block with the blocks delivered after it, the
  // deliveries of a coordinator and the envelopes build adds included, as build writes it (`carriedText`); a row that stays holds them as separate blocks.
  const noted = new Map();
  const noteOwn = (c, keep) => {
    let memo = noted.get(c);
    if (!memo) noted.set(c, (memo = {}));
    return (memo[keep] ??= besideResultGap(keep === 'full' ? queued.get(c.resIdx) || [] : [carriedText({ text: keep === 'trace' ? c.trace : keep === 'short' ? shortText(c) : '' }, queued.get(c.resIdx)).text], rates));
  };
  const orig = [...assistants.values(), ...runs].reduce((s, u) => s + messageTokens(u.before, u.tok, rates), 0);
  // The blocks a user row holds once build has written it. A row of results is rebuilt when a candidate in it changes or all its results are text (a row that is
  // neither keeps its handle), with its text and deliveries as one block, also from `keepFrom` on; a notification row by its keep decision: a trace or a short copy is
  // one block, a drop only the deliveries.
  const rowNow = (i, st) => {
    const m = messages[i];
    if (i < keepFrom) {
      if (rows[i].trimDrop === true) return 0;
      if (noteAt.has(i)) return st.keep === 'full' ? blocksAt(i) : st.keep === 'drop' ? Math.min(1, queuedAt(i)) : 1;
    }
    // No row from keepFrom on is cut (the candidates are before it), so a row of text results there is rebuilt as it stands.
    const cut = i < keepFrom;
    if (!resultsAt(m) || ((!cut || st.changed === 0) && !textRow.has(i))) return blocksAt(i);
    return (m.text || queuedAt(i) ? 1 : 0) + (cut ? st.left : resultsAt(m));
  };
  // A tracker follows the keep decisions as they are made (set) and says what they take off the list's overhead in tokens (`removed`): all of it, with what build
  // does whatever is decided.
  const tracker = () => {
    const asst = new Map([...assistants].map(([g, u]) => [g, { ...u, traces: 0 }]));
    const state = new Map();
    for (const r of runs) for (const i of r.rows) if (noteAt.has(i) || resultsAt(messages[i])) state.set(i, { left: resultsAt(messages[i]), changed: 0, keep: 'full', now: 0 });
    const nowOf = (s) => (s.first >= keepFrom ? s.before : (s.text || s.traces > 0 ? 1 : 0) + s.calls);
    // A run has its own blocks, text tokens and results left (`own`), and the user message that holds it has their sums (`sum`, kept at its first run, found by `find`) with the
    // tokens that its text costs less for having no result (`gap`) once none is left in the message, or costs more for having one (`loss`, the words of a run that held none).
    // The runs on both sides of an assistant message that is gone are one message. The cost of a message is floored with its text after the change of class (`t` less the rebate), and each
    // decision that changes the rebate takes the cost off the total before and puts it back after.
    const own = runs.map((r) => ({ n: 0, t: r.tokBuilt, res: r.results, gap: r.gap, loss: r.loss }));
    const sum = runs.map(() => ({ n: 0, t: 0, res: 0, gap: 0, loss: 0 }));
    const up = runs.map((r) => r.k);
    const find = (k) => { while (up[k] !== k) k = up[k] = up[up[k]]; return k; };
    const cost = (k) => messageTokens(sum[k].n, sum[k].t - rebate(k), rates);
    const rebate = (k) => (sum[k].res === 0 ? sum[k].gap : -sum[k].loss);
    let alone = 0;
    let total = 0;
    for (const s of asst.values()) total += messageTokens(nowOf(s), s.tok, rates);
    // The run `k` and the run before it, one message.
    const join = (k) => {
      const [a, b] = [find(k - 1), find(k)];
      if (a === b) return;
      total -= cost(a) + cost(b);
      alone -= rebate(a) + rebate(b);
      for (const f of ['n', 't', 'res', 'gap', 'loss']) sum[a][f] += sum[b][f];
      up[b] = a;
      total += cost(a);
      alone += rebate(a);
    };
    // Every run its own message, then the runs around each assistant message that is gone joined.
    const settle = () => {
      own.forEach((o, k) => {
        if (up[k] === k) { total -= cost(k); alone -= rebate(k); }
        up[k] = k;
        sum[k] = { ...o };
        total += cost(k);
        alone += rebate(k);
      });
      for (const s of asst.values()) if (nowOf(s) === 0) for (const k of s.edges) join(k);
    };
    for (const r of runs) {
      for (const i of r.rows) {
        const st = state.get(i);
        const now = rowNow(i, st);
        if (st) st.now = now;
        own[r.k].n += now;
      }
    }
    settle();
    // `dText`: the change of the text of the row's message (the zero floor of a message).
    const reread = (i, dText) => {
      const st = state.get(i);
      const k = runOf.get(i).k;
      const root = find(k);
      const now = rowNow(i, st);
      total -= cost(root);
      own[k].n += now - st.now;
      own[k].t += dText;
      sum[root].n += now - st.now;
      sum[root].t += dText;
      st.now = now;
      total += cost(root);
    };
    const gone = (keep) => (keep === 'trace' || keep === 'drop' ? 1 : 0);
    // What the decision `keep` on `c` leaves of its text in the message of its call (the call, or its trace) and in the message of its result (the rest of its cost).
    const leaves = (c, keep) => {
      if (!floored) return [0, 0];
      const t = itemTokens(c, rates);
      const inCall = c.note ? 0 : keep === 'trace' ? t.trace : keep === 'drop' ? 0 : t.call;
      return [inCall, t[keep] - inCall];
    };
    const decided = new Map();
    return {
      set(c, keep) {
        const was = decided.get(c) ?? 'full';
        if (was === keep) return;
        decided.set(c, keep);
        const [callNow, resultNow] = leaves(c, keep);
        const [callWas, resultWas] = leaves(c, was);
        if (c.note) {
          const st = state.get(c.resIdx);
          if (st) {
            st.keep = keep;
            const dGap = rows[c.resIdx].trimDrop === true ? 0 : noteOwn(c, keep) - noteOwn(c, was);
            const k = runOf.get(c.resIdx).k;
            const root = find(k);
            total -= cost(root);
            alone -= rebate(root);
            own[k].gap += dGap;
            sum[root].gap += dGap;
            alone += rebate(root);
            total += cost(root);
            reread(c.resIdx, resultNow - resultWas);
          }
          return;
        }
        const s = asst.get(group[c.useIdx]);
        if (s) {
          const goneWas = nowOf(s) === 0;
          total -= messageTokens(nowOf(s), s.tok, rates);
          s.calls -= gone(keep) - gone(was);
          s.traces += Number(keep === 'trace') - Number(was === 'trace');
          s.tok += callNow - callWas;
          total += messageTokens(nowOf(s), s.tok, rates);
          // An assistant message that is gone joins the user messages on both sides of it; one that is back splits them.
          if (nowOf(s) === 0 && !goneWas) for (const k of s.edges) join(k);
          else if (goneWas && nowOf(s) !== 0) settle();
        }
        const st = state.get(c.resIdx);
        if (st) {
          st.left -= gone(keep) - gone(was);
          st.changed += Number(keep !== 'full') - Number(was !== 'full');
          const k = runOf.get(c.resIdx).k;
          const root = find(k);
          total -= cost(root);
          alone -= rebate(root);
          own[k].res -= gone(keep) - gone(was);
          sum[root].res -= gone(keep) - gone(was);
          alone += rebate(root);
          total += cost(root);
          reread(c.resIdx, resultNow - resultWas);
        }
      },
      removed: () => orig - total + alone,
    };
  };
  let best; // a tracker with every candidate that can be cut (no task call) at its trace: what each one takes off the list at best, beside the others
  const cut = new Set(candidates.filter((x) => !x.task));
  return {
    tracker,
    // The overhead that tracing `c` takes off the list at best, with every other candidate that can be cut traced too (its call and its result take their blocks, and the
    // blocks of the others are gone already; none for a candidate that is not in the list or is a task call); the tracker is put back as it was.
    marginal(c) {
      if (!cut.has(c)) return 0;
      if (!best) { best = tracker(); for (const x of cut) best.set(x, 'trace'); }
      const all = best.removed();
      best.set(c, 'full');
      const gain = all - best.removed();
      best.set(c, 'trace');
      return gain;
    },
    // The overhead taken off the list when each of `list` is decided as `keep` (a keep, or a function of the candidate), the rest as it stands.
    shed(list, keep) {
      const t = tracker();
      for (const c of list) t.set(c, typeof keep === 'function' ? keep(c) : keep);
      return t.removed();
    },
  };
}

// What a compaction could cut, in tokens, for the two gates that decide on characters (the `too_few_results` gate of decide and the preflight of the own
// threshold). The characters of a call's input and of a result's text leave out what costs tokens without being text, an image, so with the token cascade
// (OMC_JEV_COMPACT_TARGET_PERCENT) a session that fails the gate on characters is measured here, and it passes when this reaches the same bound: `removable` is
// what every result that is no pinned one gives back when it goes to its trace (as in the floor) with the blocks and messages that go with it (`shape`, shapeOf),
// less the tokens of `envelopes` (the characters build adds, of the reminder class), and `listed` the tokens of the list it is a share of (the API form, else the rows with their images). `textTokens`: what the text stages take off
// that the cascade plans before Jev is asked (the agent trim and the reports moved to files), which the compaction counts as a cut of its own. Nothing that saves a
// token, in a candidate or in a text stage: nothing is counted.
export function cutInTokens(candidates, messages, api, envelopes = 0, rates = DEFAULT_RATES, textTokens = 0, shape = undefined) {
  let removable = Math.max(0, textTokens);
  const free = [];
  for (const c of candidates) {
    if (isPinned(c, rates, shape)) continue;
    free.push(c);
    const t = itemTokens(c, rates);
    removable += t.full - t.trace; // under 0 for a result that its blocks free (isPinned)
  }
  // The blocks and messages those results take with them (the shape of the list) are part of what they give back, with what build changes whatever is decided (the
  // deliveries after a row of text results become one block of it): the cut is the whole of the difference between the list and the list that is installed.
  if (shape) removable += shape.shed(free, 'trace');
  if (removable <= 0) return { removable: 0, listed: 0 };
  return { removable: removable - rates.RATE_NOTE * envelopes, listed: listTokens(api ?? rowsAsApi(messages), rates) };
}
// The bound of the gates in tokens: MIN_REDUCTION of the list, and `minGain` tokens (the own threshold's OWN_MIN_GAIN of the window; none for decide).
export function worthInTokens(cut, minGain = 0) {
  return cut.listed > 0 && cut.removable / cut.listed >= MIN_REDUCTION && cut.removable >= minGain;
}

// The tokens before the compaction, the token cascade's basis: the host's usage in the main loop, else the prefix plus the estimate of the API form. `detail`
// and `usage` are the reads the caller made (either may be missing). `thinking` (decide): the tokens of the thinking in the API form, which the estimate adds
// (the host's count holds it) and the predictions take off for the rows build rebuilds.
function tokensBeforeOf(e, cfg, messages, api, detail, usage, thinking) {
  const real = usage?.context?.tokens;
  const main = e.agentId === undefined && finitePositive(real) !== undefined;
  return { tokens: Math.round(main ? real : prefixTokens(detail) + listTokens(api ?? rowsAsApi(messages), cfg.rates) + thinking.all), source: main ? 'usage' : 'estimate' };
}

// The record fields of one compaction with token accounting: the window and threshold, the tokens before (the host's usage in the main loop, else
// the prefix plus the estimate of the API form) and after (the tokens before less what the keep decisions of allocate remove), the target and its
// ceiling. Read-only: the cut itself stays with allocate.
// The host reads (`known` when the caller made them already, with `win`, the window the cascade planned with, which then stands in the record) and the settings read stay within `deadline`, the compaction's own: once it has passed the
// estimate of the API form and no window stand in the record. `installedStageTokens`: what the text stages that installed took off. `shape` (shapeOf): the blocks
// and messages that the keep decisions take off the list, as in the cascade. `thinking`: as in tokensBeforeOf; the thinking of the rebuilt rows comes off the tokens after.
async function tokenAccounting($, e, cfg, messages, api, candidates, installedStageTokens, deadline, known = {}, shape = undefined, thinking) {
  const detail = 'detail' in known ? known.detail : await hostValue($, () => $.session.usage({ breakdown: 'summary' }), deadline);
  const usage = 'usage' in known ? known.usage : await hostValue($, () => $.session.usage(), deadline);
  const win = known.win ?? await resolveWindow($, cfg, detail, usage, deadline);
  const real = usage?.context?.tokens;
  const main = e.agentId === undefined && finitePositive(real) !== undefined;
  const tokensBefore = Math.round(main ? real : prefixTokens(detail) + listTokens(api ?? rowsAsApi(messages), cfg.rates) + thinking.all);
  let removed = installedStageTokens + thinking.removed;
  for (const c of candidates) {
    const t = itemTokens(c, cfg.rates);
    removed += t.full - (c.keep === 'drop' ? t.drop : c.keep === 'short' ? t.short : c.keep === 'trace' ? t.trace : t.full);
  }
  if (shape) removed += shape.shed(candidates, (c) => c.keep ?? 'full');
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

// Thinking sizes from the API form: per assistant API message the signature and thinking text (thinking) or data (redacted_thinking), credited once to one row of `messages`: the
// first row holding one of its tool uses, else an assistant row without tool uses whose text equals the joined text blocks (joined with a newline or with nothing). Unmapped
// thinking counts in `total` only.
function signatureRows(messages, api) {
  const rowSig = new Map();
  if (!Array.isArray(api)) return { rowSig, total: 0, mapped: 0, ok: false };
  const rowOfUse = new Map();
  const byText = new Map();
  messages.forEach((m, i) => {
    if (i === 0 || m.role !== 'assistant') return;
    const used = m.toolUses || [];
    for (const u of used) if (!rowOfUse.has(u.tool_use_id)) rowOfUse.set(u.tool_use_id, i);
    if (!used.length && m.text) { if (!byText.has(m.text)) byText.set(m.text, []); byText.get(m.text).push(i); }
  });
  let total = 0;
  let mapped = 0;
  for (const a of api) {
    if (!a || a.role !== 'assistant' || !Array.isArray(a.content)) continue;
    let sig = 0;
    const ids = [];
    const texts = [];
    for (const b of a.content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'thinking') sig += strOf(b.signature).length + strOf(b.thinking).length;
      else if (b.type === 'redacted_thinking') sig += strOf(b.data).length;
      else if (b.type === 'tool_use' && typeof b.id === 'string') ids.push(b.id);
      else if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    }
    if (!sig) continue;
    total += sig;
    let row;
    for (const id of ids) { const r = rowOfUse.get(id); if (r !== undefined && (row === undefined || r < row)) row = r; }
    if (row === undefined && texts.length) {
      for (const t of [texts.join('\n'), texts.join('')]) {
        const free = (byText.get(t) || []).find((r) => !rowSig.has(r));
        if (free !== undefined) { row = free; break; }
      }
    }
    if (row === undefined) continue;
    rowSig.set(row, (rowSig.get(row) || 0) + sig);
    mapped += sig;
  }
  return { rowSig, total, mapped, ok: true };
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
function build(messages, candidates, keepFrom, group, stats, queued = new Map(), drop = new Set()) {
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
  stats.rebuiltUser = 0;
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
        if (c && c.keep === 'trace') { if (!c.mergedInto) traces.push(c.trace); }
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
    // A user row of text in `drop` (host attachments) is built from its text with the messages delivered after it, so the host does not bring back its group.
    if (m.role === 'user' && drop.has(i)) {
      const { own, text } = carriedText(m, queued.get(i));
      stats.queuedCarried += own.length;
      stats.rebuiltUser++;
      if (text.trim()) out.push({ role: 'user', text, toolUses: [], toolResults: [] });
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
  return cfg.jevUsage ? withJevMeta(body.answers, { usage: sanitizeJevUsage(body.usage), raw: body.usage, model: usageModel(body.model) }) : body.answers;
}

// Usage of Jev's requests (OMC_JEV_COMPACT_JEV_USAGE). The usage and the model of an answer ride along with the answers as a non-enumerable property: spread,
// Object.keys and JSON.stringify do not see it, so no reader of the answers changes and no question name collides with it.
const JEV_META_KEY = '__jevMeta';
function withJevMeta(answers, meta) {
  Object.defineProperty(answers, JEV_META_KEY, { value: meta, enumerable: false, configurable: true });
  return answers;
}
const jevMetaOf = (answers) => answers?.[JEV_META_KEY];
// The model name is text of the server and goes into the record: masked, on one line, and cut. The mask reads a bounded start of it.
const JEV_MODEL_MAX_CHARS = 100;
const JEV_MODEL_SCAN_CHARS = 600;
const usageModel = (model) => (typeof model === 'string' ? clip(oneLine(maskSecrets(model.slice(0, JEV_MODEL_SCAN_CHARS))), JEV_MODEL_MAX_CHARS) : null);
// Only finite token counts of zero or more; anything else is no data.
function sanitizeJevUsage(usage) {
  const isCount = (n) => Number.isFinite(n) && n >= 0;
  return isCount(usage?.input_tokens) && isCount(usage?.output_tokens) ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } : undefined;
}
// 'reported' only when the answer itself carries a cost; otherwise 'unknown' (no cost is derived from a price list).
const costBasisOf = (usage) => (['total_cost_usd', 'cost_usd', 'cost'].some((k) => Number.isFinite(usage?.[k])) ? 'reported' : 'unknown');
// One entry per request: the model and the tokens of its answer. No data is null, never 0; the cost is null.
function jevUsageOf(answers) {
  const meta = jevMetaOf(answers);
  return { model: meta?.model ?? null, input_tokens: meta?.usage?.input_tokens ?? null, output_tokens: meta?.usage?.output_tokens ?? null, cost_usd: null };
}
// The requests other than the scoring of results (the question about a pasted tag, the questions about blocks, the tie of the second round) add their entry, with its
// `purpose`, to the record being written (cfg.usageRecord). A request that failed counts too.
function noteJevUsage(cfg, purpose, r) {
  const record = cfg.usageRecord;
  if (!record) return;
  (record.jev_usage ??= []).push({ ...jevUsageOf(r.value), purpose });
  if (costBasisOf(jevMetaOf(r.value)?.raw) === 'reported') record.cost_basis = 'reported';
  else record.cost_basis ??= 'unknown';
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
// A notification row is rebuilt only when its keep decision replaces it, so its envelopes are not in the sum: they are set on the candidate, measured on the
// replacement row build writes (`envelope`: a trace or a short copy, text outside the envelopes; `envelopeDrop`: no text), and charged by that decision
// (itemTokens, allocate). A user row of text in `rebuild` (host attachments) is rebuilt too, so its envelopes are in the sum.
function envelopeChars(messages, queued, candidates, rebuild) {
  const changing = new Set(candidates.map((c) => c.resIdx));
  const noteRows = new Map(candidates.filter((c) => c.note).map((c) => [c.resIdx, c]));
  let envelopes = 0;
  for (const [i, blocks] of queued) {
    const m = messages[i];
    if (rebuild?.has(i) && m.role === 'user' && !(m.toolResults || []).length) {
      const c = carriedText(m, blocks);
      envelopes += c.text.length - (m.text || '').length - rawChars(c.own);
      continue;
    }
    if (!((m.toolResults || []).length || noteRows.has(i)) || !((m.toolResults || []).every(textOnlyResult) || changing.has(i))) continue;
    const note = noteRows.get(i);
    if (note) {
      const own = rawChars(blocks);
      note.envelope = carriedText({ text: note.trace }, blocks).text.length - note.trace.length - own;
      note.envelopeDrop = carriedText({ text: '' }, blocks).text.length - own;
      continue;
    }
    const c = carriedText(m, blocks);
    envelopes += c.text.length - (m.text || '').length - rawChars(c.own);
  }
  return envelopes;
}

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
 * OMC_JEV_COMPACT_OWNER_MARKERS: pieces of the user's own style as plain text, separated by commas (a comma cannot be part of a marker), each trimmed and lower-cased; empty ones are left out.
 * A marker is looked for as it stands and in any case: no sign in it has a meaning of its own (`^`, `$`, `*`, `(` are signs like any other), and no expression is built from the value,
 * so no marker can hold the hook up on a long pasted tag.
 */
export function ownerMarkerTexts(raw) {
  return String(raw ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
}

/** Whether a text carries the user's own style as the configured markers describe it; with no markers it never does. */
export function ownerMarked(text, markers) {
  if (!markers.length) return false;
  const lower = text.toLowerCase();
  return markers.some((marker) => lower.includes(marker));
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
function ownerRows(messages, prefixes, blockTraces = false) {
  const rows = [];
  messages.forEach((m, i) => {
    if (m.isMeta === true || typeof m.text !== 'string' || prefixes.some((p) => m.text.trimStart().startsWith(p))) return;
    if (userWords(m, notUserOf(blockTraces)).length) rows.push(i);
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
  const users = ownerRows(messages, cfg.hookRowPrefixes, cfg.blockTraces);
  const before = tailEnd(cfg, keepFrom, messages.length);
  const limit = cfg.pasteMaxChars;
  const found = [];
  // The first and the newest user message stay as they are.
  for (const row of users.slice(1, -1)) {
    if (row >= before || images.rows.has(row) || cfg.ownerProtected?.has(row)) continue;
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
  noteJevUsage(cfg, 'pastes', r);
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

// Writes the text to the file and reads it back: 'written', 'reused' (the file held it already), or why not: 'timeout', 'write', 'read'. A file that held the text
// is written again all the same: the retention sweep of another session (sweepPastes) goes by the age of the newest file of the directory, and the trace this compaction
// installs would otherwise point at a file that is as old as its first writing, which the next sweep may remove.
async function savePaste($, gate, path, text) {
  const old = await fsCall($, gate, () => $.fs.read(path));
  if (old.timeout) return 'timeout';
  const put = await fsCall($, gate, () => $.fs.write(path, text));
  if (!('value' in put)) return put.timeout ? 'timeout' : 'write';
  const back = await fsCall($, gate, () => $.fs.read(path));
  if (back.timeout) return 'timeout';
  if (back.value !== text) return 'read';
  return old.value === text ? 'reused' : 'written';
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

// A line that starts a trace of this module or of the compaction (a removed call, pasted text, a moved reply; with `blockTraces` also a moved block and the header of the trace files,
// which the stages that act without the blocks switch (the long replies, the direct replies) do not read as traces while that switch is off).
const isTraceLine = (line, blockTraces = false) => line.startsWith('[compacted] ') || line.startsWith(PASTE_TRACE_PREFIX) || line.startsWith(REPLY_TRACE_PREFIX) || (blockTraces && (line.startsWith(BLOCK_TRACE_PREFIX) || line.startsWith(TRACE_HEADER_PREFIX)));

// Whether a text holds nothing but such traces and blank lines: the row a tool-only assistant message becomes once its calls are removed.
const onlyTraceLines = (text, blockTraces) => text.split('\n').every((line) => !line.trim() || isTraceLine(line, blockTraces));

/**
 * Runs of text between trace lines (a line that starts a trace of this module or of the compaction), from a non-empty line to a
 * non-empty line, of at least `minChars` characters: [{start, end}].
 */
export function replyRuns(text, minChars = REPLY_MIN_CHARS, blockTraces = false) {
  const runs = [];
  let start = -1;
  let end = -1;
  const close = () => { if (start >= 0 && end - start >= minChars) runs.push({ start, end }); start = -1; };
  for (let i = 0; i < text.length;) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(i, lineEnd);
    if (isTraceLine(line, blockTraces)) close();
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
export function directReplyRows(messages, users, delivered = [], blockTraces = false) {
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
      if (m.role === 'assistant' && typeof m.text === 'string' && m.text.trim() && !onlyTraceLines(m.text, blockTraces)) { if (first < 0) first = j; last = j; }
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
  const users = ownerRows(messages, cfg.hookRowPrefixes, cfg.blockTraces);
  // A message the user typed during a tool turn is a user message too, though no row shows it: it stands after the row it is anchored to (queuedOf).
  const delivered = [...queued].filter(([, blocks]) => blocks.some((b) => deliveryOf(b) === 'user')).map(([row]) => row);
  const userRows = [...new Set([...users, ...delivered])].sort((a, b) => a - b);
  const turns = [];
  messages.forEach((m, i) => { if (m.role === 'user' && !(m.toolResults || []).length && typeof m.text === 'string' && m.text.trim()) turns.push(i); });
  const limit = Math.min(
    tailEnd(cfg, keepFrom, messages.length),
    userRows.length >= REPLY_KEEP_OWNERS ? userRows[userRows.length - REPLY_KEEP_OWNERS] : 0,
    turns.length >= REPLY_KEEP_TURNS ? turns[turns.length - REPLY_KEEP_TURNS] : 0,
  );
  stats.limit_row = limit;
  const skip = nonTextAssistantRows(messages, api);
  const direct = directReplyRows(messages, users, delivered, cfg.blockTraces);
  const jobs = [];
  const budget = { left: SCAN_BUDGET_CHARS, deadline };
  for (let row = 0; row < limit; row++) {
    const m = messages[row];
    if (m.role !== 'assistant' || !m.text || cfg.ownerProtected?.has(row)) continue;
    stats.assistant_rows++;
    if (skip.has(row)) { stats.skipped_blocks++; continue; }
    if (direct.has(row)) { stats.direct_replies++; continue; }
    stats.considered++;
    for (const run of replyRuns(m.text, REPLY_MIN_CHARS, cfg.blockTraces)) {
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
  const from = tailEnd(cfg, keepFrom, messages.length);
  if (skip && !skip.unmatched) {
    try {
      trim = trimAgentRows(messages, { keepFrom: from, skipRows: skip.rows, queuedRows: queued, statePattern: cfg.agentStates, deadline, blockTraces: cfg.blockTraces });
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
    if (!agent || skip.has(i) || queued.has(i) || userWords(m, notUserOf(opts.blockTraces)).length || row.includes(QUEUED_PREFIX)) {
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
      if (userWords(m, notUserOf(cfg.blockTraces)).length || m.text.includes(QUEUED_PREFIX) || AGENT_BARE.test(m.text) || !framingOnly(m.text)) { stats.owner_words++; continue; }
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

// --- verdicts of Jev on blocks of text (OMC_JEV_COMPACT_BLOCKS=off|shadow|active, off when unset) ------------------------------------------------
// With the switch on, in a session with the API form, a state directory and a session id at hand, Jev rates the BLOCKS of the rows before the tail on four levels and
// the code only carries the levels out. A block is a paragraph, a closed fenced code block or a closed <pasted_content> tag of a row with the user's own words (in a
// subagent: the messages of the session that gave the task) or of an assistant row, and a whole <teammate-message>, <agent-message> or <cross-session-message> block of
// an agent row. Level 3 and 2 leave a block word for word. Level 1 and 0 move it to a file (the <state dir>/compaction-pastes/<session>/<sha256 of the text, 32 hex>.txt
// of the other stages) and leave a trace, [block moved at compaction: <chars> chars, full text in <path>...]: level 0 the length and the path, level 1 also the first
// BLOCK_HEAD_CHARS characters, a direct reply (directReplyRows) whatever the level its first and last REPLY_TRACE_HEAD and REPLY_TRACE_TAIL characters. A run of
// neighbouring blocks that go the same way is one trace. A block with no verdict stays word for word, whatever its length, age or author: those are signals in the
// question, never rules. Every block goes to Jev whole (one above the window in consecutive parts of one item; its level is the highest of its parts) after the checks of
// the paste stage: one that names a secret or private path, that masking changes or that is beyond the scan limits stays in the conversation and is never sent. The
// verdicts are files, <state dir>/compaction-pastes/<session>/verdict-block-<key>.json (key: the author and a hash of the text), so a block is asked about once and a
// verdict made under another wording of the question is none. The compaction reads them and asks for what is missing within its deadline; the pass in the background at
// the end of a turn (turn.complete) and the one before the module's own request to compact fill them earlier. `shadow` asks, counts and writes the verdict files but
// changes nothing; `active` acts only while the point itself is active. OMC_JEV_COMPACT_VERDICTS=off: no question (the verdict files that exist still apply);
// OMC_JEV_COMPACT_BLOCK_QUESTIONS=shared: the wording of the question and the levels stand once in the state of a request; OMC_JEV_COMPACT_WINDOW_CHARS: the window of
// Jev in bytes of the request body; OMC_JEV_COMPACT_FULL_INPUT=active: the user's words in the header of a request are bounded by the window alone (a quarter of it);
// OMC_JEV_COMPACT_JEV_STAGES=active: while the verdicts run (active, a key, the API form), the stages that decide by fixed lengths, counts and the user's style
// (pasted text, long replies, agents' messages to files) do not run; the agent trim stays (it is lossless).
const BLOCK_HEAD_CHARS = 60; // level 1: the start of the block that stays in the trace
const BLOCK_PART_MIN = 2000; // the smallest part of a block above the window, in bytes of its JSON
const BLOCK_ITEM_OVERHEAD = 60; // bytes per item beyond its fields and its question (keys, commas)
const BLOCK_PARALLEL = 4; // requests of the verdicts at once
const BLOCK_SCAN_BUDGET_CHARS = 200000; // the characters of the blocks one pass checks for a secret (the budget of the pastes and replies is SCAN_BUDGET_CHARS): the largest conversation measured needed 195924
const BLOCK_ROUNDS = 4; // a request the endpoint refuses as too large (400) is asked again in half the window, this many times at most
const BLOCK_READ_MAX = 600; // verdict files read in one pass
const BLOCK_FILE_PARALLEL = 8; // file calls at once (verdict files, moved text)
const BLOCK_BACKGROUND_GAP_MS = 20000; // the pass in the background reads the whole conversation: at most one in this time
const BLOCK_BACKGROUND_MS = 30000; // and it ends by then (no deadline of the turn: the host may end first, and the compaction makes up the rest)
const BLOCK_BACKGROUND_REQUEST_MS = 3000;
const BLOCK_AUTHOR = { w: 'owner', a: 'assistant', g: 'agent', t: 'task_giver' };
const BLOCK_KIND = { w: 'owner_message', a: 'assistant_reply', g: 'agent_report', t: 'task_giver_message' };
const BLOCK_LEVELS = [
  'Not needed: it concerns a finished task or none; only a trace with the file stays (the length, no start of the text).',
  `Probably not needed: it concerns a finished, abandoned or no task; the start (${BLOCK_HEAD_CHARS} characters), the length and the file stay.`,
  'May be useful: work on an open task may come back to its details; the block stays word for word.',
  'Needed word for word: without its literal text an open task cannot be finished; the block stays word for word.',
];
const BLOCK_QUESTION = "Is the block still needed word for word for further work on the owner's tasks? What the owner asked for and decided in their messages is the direction of the agent's work. There is no task list in the state: open tasks are inferred from the owner's messages (`task` holds only the latest of them, earlier ones are among the blocks). `budget` is a signal of the size of the conversation against its limit, not an order to lower levels.";
const BLOCK_FOCUS = 'Judge the effect on further work if only a trace and a file were left of the block. The rules of judging are in `block_rules`.';
const BLOCK_RULES = `The fields of a block (author, pasted, length, age_turns, current_turn, in_tail, has_file, repeated, first_message, owner_style, row) are signals for your judgement, not rules; the author too: in the session of an agent the messages of the task giver (author task_giver) are the command of that session. Judge whether further work on the owner's tasks will use the literal text of the block, not whether it was needed before. The full text of the block stays in a file and in the transcript, so a mistake is cheap. The levels describe the effect: 3 the task cannot be finished without the literal text of the block, 2 work on the task may come back to its details, 1 the block concerns a finished, abandoned or no task and the start (${BLOCK_HEAD_CHARS} characters), the length and the file stay, 0 it concerns a finished task or none and only a trace with the file stays.`;
// The version of the question: a verdict made under another wording is none (readBlockVerdicts), its block is asked again.
function fnv(text, seed = 0x811c9dc5) {
  let h = seed;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
const contentHash = (text) => fnv(text) + fnv(text, 0x050c5d1f);
const BLOCK_QUESTION_VERSION = contentHash([BLOCK_QUESTION, BLOCK_FOCUS, BLOCK_LEVELS.join('\n'), BLOCK_RULES].join('\0')).slice(0, 8);

const BLOCK_FENCE = /^ {0,3}(```|~~~)/;
// A line that starts a trace of this module or of the compaction (a removed call, pasted text, a moved reply or block, an agent message).
const isStageTraceLine = (line) => isTraceLine(line, true) || line.startsWith(AGENT_TRACE_PREFIX);
// Whether a closing fence of the same kind stands in [from, to).
function closedFence(text, from, to, mark) {
  for (let i = from; i < to;) {
    const nl = text.indexOf('\n', i);
    const end = nl === -1 || nl >= to ? to : nl + 1;
    const m = BLOCK_FENCE.exec(text.slice(i, end));
    if (m && m[1] === mark) return true;
    i = end;
  }
  return false;
}
// The paragraphs and closed fenced code blocks of text[from, to): a paragraph (the lines between blank lines) with a trace line in it is no block, whole, so the text that
// stands next to traces stays beside them; a block ends before its last line break.
function lineBlocks(text, from, to, out) {
  let i = from;
  let start = -1;
  let fence = '';
  let traced = false; // the paragraph in hand holds a trace line
  const noCloser = new Set(); // a fence mark with no closing fence after one opener has none after a later one either
  const flush = (end) => {
    if (start >= 0 && !traced) {
      let e = end;
      if (text[e - 1] === '\n') e -= text[e - 2] === '\r' ? 2 : 1;
      if (e > start && text.slice(start, e).trim()) out.push({ kind: 'text', start, end: e });
    }
    start = -1;
    traced = false;
  };
  while (i < to) {
    const nl = text.indexOf('\n', i);
    const end = nl === -1 || nl >= to ? to : nl + 1;
    const line = text.slice(i, end);
    if (fence) {
      const m = BLOCK_FENCE.exec(line);
      if (m && m[1] === fence) { fence = ''; flush(end); }
      i = end;
      continue;
    }
    const open = BLOCK_FENCE.exec(line);
    if (open && !noCloser.has(open[1])) {
      if (closedFence(text, end, to, open[1])) { flush(i); start = i; fence = open[1]; i = end; continue; }
      noCloser.add(open[1]);
    }
    if (/^[ \t\r]*\n?$/.test(line)) { flush(i); i = end; continue; }
    if (start < 0) start = i;
    if (isStageTraceLine(line)) traced = true;
    i = end;
  }
  flush(to);
}
/** The blocks of a text in order: {kind: 'text' | 'tag', start, end}. A closed <pasted_content> tag is one block; traces and blank lines are none, and the lines of an unclosed fence are read as a paragraph. */
export function splitBlocks(text) {
  const out = [];
  let at = 0;
  for (const t of pasteTags(text)) {
    if (t.start > at) lineBlocks(text, at, t.start, out);
    out.push({ kind: 'tag', start: t.start, end: t.end });
    at = t.end;
  }
  if (at < text.length) lineBlocks(text, at, text.length, out);
  return out;
}

/** What replaces a run of blocks of `chars` characters: the length and the file (`file` is the letter and the name, `b/<name>`: the directory stands once in the header of the
 * compaction, traceHeader); mode 'start' also its first BLOCK_HEAD_CHARS characters, 'floor' the first and the last ones of a reply.
 * A run of an agent's blocks (`agent`) opens as the trace of an agent's message does, so the row is still no message of the user. */
export function blockTrace(chars, text, file, mode = 'bare', agent = false) {
  if (agent) return `${AGENT_TRACE_PREFIX}${file} (${chars} chars)${mode === 'bare' ? '' : `; start: ${quoted(text.slice(0, BLOCK_HEAD_CHARS))}`}]`;
  const start = mode === 'bare' ? '' : `; start: ${quoted(text.slice(0, mode === 'floor' ? REPLY_TRACE_HEAD : BLOCK_HEAD_CHARS))}`;
  const end = mode === 'floor' ? `; end: ${quoted(text.slice(-REPLY_TRACE_TAIL))}` : '';
  return `${BLOCK_TRACE_PREFIX}${chars} chars in ${file}${start}${end}]`;
}
/** The header of the traces, once per compaction in the first row of the result: the directory the letter of a trace stands for. */
const TRACE_HEADER_OPEN = `${TRACE_HEADER_PREFIX}${BLOCK_LETTER}/ = `;
export const traceHeader = (dir) => `${TRACE_HEADER_OPEN}${dir}]`;
// Only the whole generated header is one: a message of the user that opens with the same words and goes on is the user's.
const isHeaderRow = (m) => m.role === 'user' && !(m.toolResults || []).length && typeof m.text === 'string' && m.text.startsWith(TRACE_HEADER_OPEN) && m.text.endsWith(']') && !m.text.includes('\n');
const blockFileOf = (hash) => `${BLOCK_LETTER}/${hash}.txt`;
// The tokens of a block by the class of its author and the characters past ASCII (the rates of the module).
const blockTokens = (rates, author, text) => ({ w: rates.RATE_OWN, a: rates.RATE_ATXT }[author] ?? rates.RATE_NOTE) * text.length + rates.RATE_NON_ASCII * nonAscii(text);
const blockDir = (cfg, sessionId) => `${cfg.pasteDir}/${safeName(sessionId)}`;
const blockVerdictPath = (cfg, sessionId, key) => `${blockDir(cfg, sessionId)}/verdict-block-${key}.json`;
// The tokens one block gives back when it goes to the shortest trace (level 0), the file path counted at its real length.
const blockGain = (cfg, it, mode = 'bare') => Math.max(0, blockTokens(cfg.rates, it.author, it.body) - cfg.rates.RATE_TRACE * blockTrace(it.chars, it.body, blockFileOf('0'.repeat(32)), mode, it.author === 'g').length);

// The turns of a conversation: `age[i]` is the number of user messages after row i (the turns it has lived), `tail` the first row of the tail the paste and reply stages keep (the
// third newest user message and the sixth newest turn, whichever is earlier). `userRows` are the rows with the user's words, sorted.
function turnFacts(rows, userRows) {
  const turns = [];
  rows.forEach((m, i) => { if (m.role === 'user' && !(m.toolResults || []).length && typeof m.text === 'string' && m.text.trim()) turns.push(i); });
  const tail = Math.min(userRows.length >= REPLY_KEEP_OWNERS ? userRows[userRows.length - REPLY_KEEP_OWNERS] : 0, turns.length >= REPLY_KEEP_TURNS ? turns[turns.length - REPLY_KEEP_TURNS] : 0);
  const age = new Array(rows.length).fill(0);
  const isUser = new Set(userRows);
  for (let i = rows.length - 1, n = 0; i >= 0; i--) { age[i] = n; if (isUser.has(i)) n++; }
  return { age, tail };
}
// The blocks of the rows before `ctx.limit` that a verdict can name. `rows` are the rows as the agent trim leaves them. ctx: limit, skipUser and skipAssistant (rows the host
// cannot rebuild from text), userUnmatched (an image or file no row shows: no user row is touched), queued (delivered blocks anchored to rows), users (rows with the user's own
// words), delivered (rows a message typed during a tool turn is anchored to) and agent (the session is a subagent's: the user's rows are the messages of the task giver). Returns {rows: Map row -> {author, direct, blocks: [{start, end, key}]}, items (one per key, with
// `count` places), stats}. A row that holds results, a delivered block's anchor, a host block or a block the host cannot rebuild stays whole, whatever its blocks.
function blockRows(cfg, rows, ctx) {
  const stats = { rows: 0, blocks: 0, host_blocks: 0, skipped_non_text: 0, queued_anchor: 0, image_unmatched: 0, owner_words: 0, pending_json: 0 };
  const found = new Map();
  const byKey = new Map();
  const owners = new Set(ctx.users);
  const userRows = [...new Set([...ctx.users, ...ctx.delivered])].sort((a, b) => a - b);
  const { age, tail } = turnFacts(rows, userRows);
  const direct = directReplyRows(rows, ctx.users, ctx.delivered, true);
  for (let i = 0; i < Math.min(ctx.limit, rows.length); i++) {
    const m = rows[i];
    if (m.trimDrop === true || typeof m.text !== 'string' || !m.text.trim() || (m.toolResults || []).length) continue;
    if (ctx.protect?.has(i)) continue; // no verdict touches a protected row of the owner tail
    let author;
    let list;
    if (m.role === 'assistant') {
      if (ctx.skipAssistant?.has(i)) { stats.skipped_non_text++; continue; }
      author = 'a';
    } else if (m.role === 'user') {
      if (ctx.userUnmatched) { stats.image_unmatched++; continue; }
      if (ctx.skipUser?.has(i)) { stats.skipped_non_text++; continue; }
      if (isAgentRow(m)) {
        if (owners.has(i) || m.text.includes(QUEUED_PREFIX) || AGENT_BARE.test(m.text) || !framingOnly(m.text)) { stats.owner_words++; continue; }
        if (agentSenders(m.text).some((x) => x.json && !x.idle)) { stats.pending_json++; continue; }
        author = 'g';
        list = agentBlocks(m.text).blocks.map((b) => ({ kind: 'agent', start: b.at, end: b.end }));
      } else if (owners.has(i)) {
        if (cutHostBlocks(m.text) !== m.text || m.text.includes(ENVELOPE_CLOSE)) { stats.host_blocks++; continue; }
        author = 'w';
      } else continue;
    } else continue;
    if (ctx.queued.has(i)) { stats.queued_anchor++; continue; }
    list ??= splitBlocks(m.text);
    const lead = author === 'g' && agentSenders(m.text).some((x) => x.who === AGENT_LEAD);
    const giver = lead || (ctx.agent === true && author === 'w'); // a message of the task giver is the command of the session of an agent (a signal for Jev, no rule)
    const floor = author === 'a' && direct.has(i);
    const blocks = [];
    for (const b of list) {
      const body = m.text.slice(b.start, b.end);
      if (!body.trim()) continue;
      const key = `${author}-${contentHash(body)}`;
      blocks.push({ start: b.start, end: b.end, key });
      stats.blocks++;
      const seen = byKey.get(key);
      const signals = { age_turns: age[i], current_turn: age[i] === 0, in_tail: i >= tail };
      if (seen) { Object.assign(seen, signals, { repeated: true, row: i, count: seen.count + 1 }); continue; }
      byKey.set(key, { key, author, body, row: i, chars: body.length, pasted: b.kind === 'tag', first_message: i === 0, giver, owner_style: author === 'w' && ownerMarked(body, cfg.ownerMarkers), repeated: false, count: 1, ...signals });
    }
    if (!blocks.length) continue;
    stats.rows++;
    found.set(i, { author, direct: floor, blocks });
  }
  return { rows: found, items: [...byKey.values()], stats };
}

// The blocks of one compaction (or pass): blockRows on `trimmed`, the rows as the agent trim leaves them, with the skip sets the paste and reply stages use (read from `messages`, the
// rows as they came). Returns {rows, items, stats, messages: trimmed, sessionId, verdicts: Map key -> verdict, potential}.
function planBlocks(cfg, messages, trimmed, api, queued, keepFrom, sessionId, agent = false) {
  const images = nonTextUserRows(messages, api);
  const users = ownerRows(messages, cfg.hookRowPrefixes, true);
  const delivered = [...queued].filter(([, blocks]) => blocks.some((b) => deliveryOf(b) === 'user')).map(([row]) => row);
  const found = blockRows(cfg, trimmed, { limit: tailEnd(cfg, keepFrom, messages.length), skipUser: images.rows, userUnmatched: images.unmatched, skipAssistant: nonTextAssistantRows(messages, api), queued, users, delivered, agent, protect: cfg.ownerProtected });
  const potential = found.items.reduce((sum, it) => (it.chars <= cfg.pasteMaxChars && !namesSecretPath(it.body, cfg.privatePaths) ? sum + blockGain(cfg, it) * it.count : sum), 0);
  return { ...found, messages: trimmed, sessionId, verdicts: new Map(), potential };
}

// The verdicts this process knows (and the keys it found held back by a secret), by session: the files are read once.
const sessionMap = (map, sessionId, make) => { if (!map.has(sessionId)) map.set(sessionId, make()); return map.get(sessionId); };
// The settings a verdict depends on besides the text: the private paths a block may not name (a verdict made under other ones is none, and its block is checked again).
const blockSettings = (cfg) => contentHash(JSON.stringify(cfg.privatePaths ?? []));
const validVerdict = (v, key, settings) => Boolean(v) && typeof v === 'object' && v.key === key && v.question_version === BLOCK_QUESTION_VERSION && v.settings === settings && Number.isInteger(v.level) && v.level >= 0 && v.level < QUESTION_CRITERIA.length;

// One call of `work` for each of `list`, BLOCK_FILE_PARALLEL at a time.
async function inParallel(list, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(BLOCK_FILE_PARALLEL, list.length) }, async () => { while (next < list.length) await work(list[next++]); }));
}

// The verdicts the session has: the process's own first, then the files (at most BLOCK_READ_MAX, within `deadline`). A file that does not read, or was made under
// another question, is none. Returns Map key -> verdict; `unread` (a Set) receives the keys left past BLOCK_READ_MAX, whose files were not looked at (the next pass reads them).
async function readBlockVerdicts($, cfg, sessionId, keys, deadline, unread = new Set()) {
  const cache = sessionMap(session.blockVerdicts, sessionId, () => new Map());
  const settings = blockSettings(cfg);
  const out = new Map();
  const wanted = [];
  for (const key of keys) { const v = cache.get(key); if (v?.settings === settings) out.set(key, v); else wanted.push(key); }
  if (!wanted.length || !cfg.pasteDir) return out;
  const gate = { deadline, stalled: false };
  for (const key of wanted.slice(BLOCK_READ_MAX)) unread.add(key);
  await inParallel(wanted.slice(0, BLOCK_READ_MAX), async (key) => {
    const r = await fsCall($, gate, () => $.fs.read(blockVerdictPath(cfg, sessionId, key)));
    if (typeof r.value !== 'string') return;
    try {
      const v = JSON.parse(r.value);
      if (validVerdict(v, key, settings)) { out.set(key, v); cache.set(key, v); }
    } catch { /* a verdict that does not read is none */ }
  });
  return out;
}
// One file per answered block, BLOCK_FILE_PARALLEL at a time, none begun after `deadline`. Returns the number written.
async function writeBlockVerdicts($, cfg, sessionId, list, deadline) {
  if (!cfg.pasteDir || !list.length) return 0;
  const gate = { deadline, stalled: false };
  let written = 0;
  await inParallel(list, async (v) => {
    const r = await fsCall($, gate, () => $.fs.write(blockVerdictPath(cfg, sessionId, v.key), JSON.stringify(v)));
    if ('value' in r) written++;
  });
  return written;
}

// Pieces of at most `size` characters, cut at a line break when one stands in the last fifth, never inside a surrogate pair.
function chunksOf(text, size) {
  const out = [];
  for (let at = 0; at < text.length;) {
    let end = Math.min(text.length, at + size);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end - 1);
      if (nl > at + size * 0.8) end = nl + 1;
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end--;
    }
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}
const jsonBytes = (text) => (text ? utf8Bytes(JSON.stringify(text)) : 0);
// The question about one block, in the shape the documentation of the endpoint gives: the block and the task by their paths in backticks (`full`, the default). With
// `shared` the wording and the levels stand once in the state of a request (`block_assessment`) and the question of a block names the block and the short names of the levels.
const BLOCK_LEVEL_NAMES = BLOCK_LEVELS.map((what) => what.split(':')[0]);
const sharedWording = (text) => text.replace(/\bthe block\b/, 'the block named in the question');
function blockQuestion(name, mode = 'full') {
  if (mode === 'shared') return { type: 'score', instructions: `Rate the block \`blocks.${name}\` by the question and the levels in \`block_assessment\`.`, criteria: BLOCK_LEVEL_NAMES };
  return {
    type: 'score',
    instructions: { question: BLOCK_QUESTION.replace('the block', `the block \`blocks.${name}\``), compare: [`\`blocks.${name}\``, '`task`'], focus: BLOCK_FOCUS },
    criteria: BLOCK_LEVELS.map((what) => ({ what })),
  };
}
const sharedAssessment = () => ({ block_assessment: { question: sharedWording(BLOCK_QUESTION), levels: BLOCK_LEVELS } });
// The fields of one block (or one part of it) in the request.
function blockFields(it, part) {
  const key = it.giver ? 't' : it.author;
  return {
    row: it.row, kind: BLOCK_KIND[key], author: BLOCK_AUTHOR[key], text: part.text, length: it.chars, pasted: it.pasted, first_message: it.first_message,
    owner_style: it.owner_style, age_turns: it.age_turns, current_turn: it.current_turn, in_tail: it.in_tail, has_file: true, repeated: it.repeated,
    part: part.z > 1 ? { nr: part.nr, of: part.z } : null,
    ...(it.giver ? { from_task_giver: true } : {}),
  };
}
// The header of a request (the user's last words and the /compact instructions) takes at most a third of the window.
function blockHeader(user, windowBytes, extra) {
  const limit = Math.floor(windowBytes / 3);
  const total = user.task.reduce((s, x) => s + utf8Bytes(x), 0);
  const task = total <= limit ? user.task : user.task.map((x) => { const allowed = Math.max(500, Math.floor((limit * utf8Bytes(x)) / total / 1.2)); return x.length > allowed ? headTail(x, Math.floor(allowed * 0.6), Math.floor(allowed * 0.4)) : x; });
  return { task, ...(user.instructions ? { compact_instructions: user.instructions } : {}), ...(extra ?? {}) };
}
// Items into requests that fit the window: a block larger than the window in consecutive parts, whole blocks packed one after another.
// [{state, questions, map: Map question -> {it, nr, z}}]
function packBlockRequests(items, header, windowBytes, mode = 'full') {
  const shared = mode === 'shared';
  const budget = Math.max(BLOCK_PART_MIN * 2, windowBytes - utf8Bytes(JSON.stringify(header)) - jsonBytes(BLOCK_RULES) - (shared ? utf8Bytes(JSON.stringify(sharedAssessment())) : 0) - 40);
  const fixed = (it) => utf8Bytes(JSON.stringify(blockFields(it, { text: '', nr: 1, z: 2 }))) + utf8Bytes(JSON.stringify(blockQuestion('b999', mode))) + BLOCK_ITEM_OVERHEAD;
  const entries = [];
  for (const it of items) {
    const own = fixed(it);
    if (own + jsonBytes(it.body) <= budget) { entries.push({ it, nr: 1, z: 1, text: it.body, size: own + jsonBytes(it.body) }); continue; }
    // The window counts the body of the request: a part is cut by the size of its JSON form (quotes and line breaks grow it), not by its characters.
    const piece = Math.max(BLOCK_PART_MIN, budget - own);
    const size = Math.max(BLOCK_PART_MIN / 2, Math.floor((piece / Math.max(1, jsonBytes(it.body) / Math.max(1, it.body.length))) * 0.95));
    const parts = chunksOf(it.body, size);
    parts.forEach((text, k) => entries.push({ it, nr: k + 1, z: parts.length, text, size: own + jsonBytes(text) }));
  }
  const groups = [];
  let cur;
  for (const en of entries) {
    if (!cur || (cur.size + en.size > budget && cur.entries.length)) { cur = { size: 0, entries: [] }; groups.push(cur); }
    cur.entries.push(en);
    cur.size += en.size;
  }
  return groups.map((g) => {
    const blocks = {};
    const questions = {};
    const map = new Map();
    g.entries.forEach((en, n) => {
      const q = `b${n + 1}`;
      map.set(q, en);
      blocks[q] = blockFields(en.it, en);
      questions[q] = blockQuestion(q, mode);
    });
    return { state: { ...header, blocks, block_rules: BLOCK_RULES, ...(shared ? sharedAssessment() : {}) }, questions, map };
  });
}

// Jev's verdicts for blocks: packs them into requests, asks BLOCK_PARALLEL at a time through the module's own admission (the process cap, the shared breaker and request limit) and
// returns {verdicts: Map key -> verdict, stats}. A block is rated when every part of it was answered; the level is the highest of its parts. A request refused as too large (400) is
// asked again in half the window. opts: header(windowBytes) -> the header of a request, deadline (no request starts after it, and one gets what is left of it), requestMs, sessionId,
// writeDeadline, low (the pass in the background: only a failure with a pause of its own counts), cancel (a function: true stops the pass).
async function askBlockVerdicts($, cfg, items, opts) {
  const stats = { items: items.length, requests: 0, started: 0, held: 0, answered: 0, unanswered: 0, split: 0, reduced: 0, failed: 0, written: 0 };
  const verdicts = new Map();
  const levels = new Map(); // block -> {done, z, max, noul}
  const started = new Set();
  const failures = [];
  let pending = items;
  let windowBytes = windowBytesOf(cfg);
  for (let round = 0; pending.length && round < BLOCK_ROUNDS; round++) {
    if (opts.cancel?.()) break;
    const requests = packBlockRequests(pending, opts.header(windowBytes), windowBytes, cfg.blockQuestions);
    stats.requests += requests.length;
    const split = new Set();
    for (const r of requests) for (const en of r.map.values()) if (en.z > 1) split.add(en.it);
    stats.split = Math.max(stats.split, split.size);
    const results = new Array(requests.length);
    let next = 0;
    const worker = async () => {
      while (next < requests.length) {
        const k = next++;
        if (opts.cancel?.() || Date.now() >= opts.deadline) { results[k] = { skipped: true }; continue; }
        const admission = await admitRequest($, cfg, opts.deadline);
        if (admission.skip) { results[k] = { held: admission.skip }; continue; }
        const t0 = Date.now();
        const timeoutMs = Math.min(opts.requestMs, opts.deadline - t0);
        if (timeoutMs < 500) { session.requests--; results[k] = { skipped: true }; continue; }
        const r = await withDeadline($, askJev($, cfg, requests[k].state, requests[k].questions), timeoutMs);
        noteJevUsage(cfg, 'blocks', r);
        // Shared failure bookkeeping may finish later, but cannot extend the deadline.
        const recording = recordSharedFailure($, cfg, { ...r, short: timeoutMs < 1000 });
        if (Date.now() < opts.deadline) await withDeadline($, recording, opts.deadline - Date.now());
        results[k] = { ...r, ms: Date.now() - t0 };
      }
    };
    await Promise.all(Array.from({ length: Math.min(BLOCK_PARALLEL, requests.length) }, worker));
    const redo = new Set();
    results.forEach((r, k) => {
      if (!r || r.skipped) return;
      if (r.held) { stats.held++; return; }
      for (const en of requests[k].map.values()) started.add(en.it);
      stats.started++;
      if (!r.value) {
        if (r.error?.status === 400) { for (const en of requests[k].map.values()) redo.add(en.it); return; }
        failures.push(classifyFailure(r));
        return;
      }
      for (const [q, en] of requests[k].map) {
        const s = scoreOf(r.value[q]);
        const scaled = s === undefined ? NaN : s * (QUESTION_CRITERIA.length - 1);
        if (!(Math.abs(scaled - Math.round(scaled)) <= 1e-9)) continue; // a block answer is a whole level: no answer, or a fraction of one, is no verdict
        const row = levels.get(en.it) ?? { done: 0, z: en.z, max: -1, noul: 0 };
        row.done++;
        row.max = Math.max(row.max, Math.round(scaled));
        row.noul = Math.max(row.noul, s);
        levels.set(en.it, row);
      }
    });
    for (const it of redo) levels.delete(it);
    pending = [...redo];
    windowBytes = Math.floor(windowBytes / 2);
    if (windowBytes < BLOCK_PART_MIN * 3) break;
    if (pending.length) stats.reduced++;
  }
  const ts = isoNow();
  const files = [];
  for (const it of items) {
    const row = levels.get(it);
    if (row && row.done === row.z) {
      const v = { key: it.key, kind: 'block', level: row.max, noul: Math.round(row.noul * 1000) / 1000, question_version: BLOCK_QUESTION_VERSION, settings: blockSettings(cfg), parts: row.z, chars: it.chars, ts };
      verdicts.set(it.key, v);
      files.push(v);
      stats.answered++;
    } else stats.unanswered++;
  }
  stats.failed = failures.length;
  noteFailures(opts.low ? failures.filter((f) => f.pauseMs) : failures, Date.now());
  if (files.length) {
    const cache = sessionMap(session.blockVerdicts, opts.sessionId, () => new Map());
    for (const v of files) cache.set(v.key, v);
    stats.written = await writeBlockVerdicts($, cfg, opts.sessionId, files, opts.writeDeadline ?? opts.deadline);
  }
  return { verdicts, stats };
}

// The verdicts of the blocks of `plan` (blockRows): the ones the process or the files hold, and Jev's for the rest, within `ctx.deadline`. Sets plan.verdicts. A block is asked only when it
// can be moved at all: not beyond the scan limits, with a trace shorter than its text in tokens, naming no secret path and unchanged by masking. ctx: user (userTask), deadline, requestMs,
// minAge (only blocks that lived this many turns), low, cancel, writeDeadline, extra (fields of the header). Returns the counts; never rejects.
async function ensureBlockVerdicts($, cfg, plan, ctx) {
  const sessionId = plan.sessionId;
  const stats = { items: plan.items.length, aged: 0, eligible: 0, known: 0, secret: 0, unchecked: 0, too_long: 0, too_short: 0 };
  try {
    const held = sessionMap(session.blockHeld, sessionId, () => new Set()); // blocks a secret holds back: the check is a function of the text
    const items = plan.items.filter((it) => it.age_turns >= (ctx.minAge ?? 0));
    stats.aged = items.length;
    const eligible = items.filter((it) => {
      if (held.has(it.key)) { stats.secret++; return false; }
      if (it.chars > cfg.pasteMaxChars) { stats.too_long++; return false; }
      if (blockGain(cfg, it) <= 0) { stats.too_short++; return false; }
      return true;
    });
    stats.eligible = eligible.length;
    const unread = new Set();
    const known = await readBlockVerdicts($, cfg, sessionId, eligible.map((it) => it.key), ctx.deadline, unread);
    for (const [key, v] of known) plan.verdicts.set(key, v);
    stats.known = known.size;
    // The checks for a secret run on the blocks to ask about, the largest first (masking has quadratic patterns), within the budget of the check.
    const budget = { left: BLOCK_SCAN_BUDGET_CHARS, deadline: ctx.deadline };
    const toAsk = [];
    for (const it of eligible.filter((x) => !known.has(x.key) && !unread.has(x.key)).sort((a, b) => b.chars - a.chars)) {
      const why = secretCheck(it.body, cfg.privatePaths, budget, cfg.pasteMaxChars);
      if (why === 'secret') { held.add(it.key); stats.secret++; } else if (why) stats.unchecked++; else toAsk.push(it);
    }
    stats.asked = toAsk.length;
    if (!toAsk.length) return stats;
    const run = await askBlockVerdicts($, cfg, toAsk, {
      header: (win) => blockHeader(ctx.user, win, ctx.extra),
      deadline: ctx.deadline, requestMs: ctx.requestMs ?? REQUEST_MS, sessionId, writeDeadline: ctx.writeDeadline, low: ctx.low === true, cancel: ctx.cancel,
    });
    for (const [key, v] of run.verdicts) plan.verdicts.set(key, v);
    stats.ask = run.stats;
  } catch (error) { stats.error = clip(oneLine(String(error?.message ?? error)), 200); }
  return stats;
}

// The runs of the blocks that Jev took off (level 0 or 1) and the files they go to; writes the files (within `deadline`) and returns {edits: Map row -> rebuilt row, stats}. A run stays
// whole when its file could not be written and read back in time, when a secret stands at the joint of its blocks, or when its trace would not pay in tokens. `shadow` counts what
// would move and writes nothing. Never rejects.
async function moveBlocks($, cfg, plan, deadline, mode = 'active', hold = new Set()) {
  const stats = { rows: plan.rows.size, blocks: 0, no_verdict: 0, levels: [0, 0, 0, 0], runs: 0, secret: 0, too_short: 0, written: 0, reused: 0, write_failed: 0, timed_out: 0, held_rows: 0, moved: 0, moved_chars: 0, moved_tokens: 0, trace_chars: 0 };
  const edits = new Map();
  try {
    const jobs = [];
    for (const [row, info] of plan.rows) {
      if (hold.has(row)) { stats.held_rows++; continue; }
      const text = plan.messages[row].text;
      let run;
      for (const b of info.blocks) {
        stats.blocks++;
        const v = plan.verdicts.get(b.key);
        if (!v) { stats.no_verdict++; run = undefined; continue; }
        stats.levels[v.level]++;
        if (v.level >= 2) { run = undefined; continue; }
        if (run && !text.slice(run.end, b.start).trim()) { run.parts.push(b); run.end = b.end; run.bare = run.bare && v.level === 0; } else { run = { row, author: info.author, floor: info.direct, start: b.start, end: b.end, bare: v.level === 0, parts: [b] }; jobs.push(run); }
      }
    }
    stats.runs = jobs.length;
    const ready = [];
    for (const job of jobs) {
      const text = plan.messages[job.row].text;
      job.text = text.slice(job.start, job.end);
      // Each block was checked when it was asked about; what a run adds is the joints between its blocks (a secret may stand over the break between two of them).
      const joint = job.parts.slice(1).some((b, k) => {
        const around = text.slice(Math.max(job.parts[k].start, job.parts[k].end - 200), Math.min(b.end, b.start + 200));
        return namesSecretPath(around, cfg.privatePaths) || maskSecrets(around) !== around;
      });
      if (joint) { stats.secret++; continue; }
      const hash = (await sha256Hex(job.text)).slice(0, 32);
      job.path = `${blockDir(cfg, plan.sessionId)}/${hash}.txt`;
      job.trace = blockTrace(job.text.length, job.text, blockFileOf(hash), job.floor ? 'floor' : job.bare ? 'bare' : 'start', job.author === 'g');
      job.tokens = blockTokens(cfg.rates, job.author, job.text);
      if (job.tokens <= cfg.rates.RATE_TRACE * job.trace.length) { stats.too_short++; continue; }
      ready.push(job);
    }
    const gate = { deadline, stalled: false };
    if (mode === 'active') {
      await inParallel(ready, async (job) => {
        const saved = await savePaste($, gate, job.path, job.text);
        if (saved === 'written' || saved === 'reused') { stats[saved]++; job.saved = true; } else stats[saved === 'timeout' ? 'timed_out' : 'write_failed']++;
      });
    } else for (const job of ready) job.saved = true;
    const byRow = new Map();
    for (const job of ready) {
      if (!job.saved) continue;
      stats.moved++;
      stats.moved_chars += job.text.length;
      stats.moved_tokens += job.tokens;
      stats.trace_chars += job.trace.length;
      byRow.set(job.row, [...(byRow.get(job.row) ?? []), job]);
    }
    if (mode === 'active') for (const [row, list] of byRow) {
      const m = plan.messages[row];
      let text = '';
      let at = 0;
      // A trace stands on a line of its own (the estimate prices a trace line at the trace rate, and a later pass reads it as a trace and no block).
      for (const j of list.sort((a, b) => a.start - b.start)) {
        const before = m.text.slice(at, j.start);
        text += before + (j.start > 0 && !(before || text).endsWith('\n') ? '\n' : '') + j.trace + (j.end < m.text.length && m.text[j.end] !== '\n' ? '\n' : '');
        at = j.end;
      }
      text += m.text.slice(at);
      edits.set(row, m.role === 'assistant' ? { ...m, text } : { role: m.role, text, toolUses: m.toolUses || [] });
    }
  } catch { stats.error = 1; }
  return { edits, stats };
}
// What the blocks moved to files take off the prediction: their tokens less those of their traces.
const blockSavedTokens = (st, rates) => st.moved_tokens - rates.RATE_TRACE * st.trace_chars;

// The signals every question about a block carries: `budget` (the target of the cascade, when there is one, and the size of the conversation in the tokens of the module's
// counter) and `census` (its blocks by author). Signals for Jev, never rules; `limit` null: the budget names no limit.
function blockSignals(rates, tokens, items, prefix, limit) {
  const census = {};
  for (const it of items) {
    const entry = (census[BLOCK_AUTHOR[it.author]] ??= { blocks: 0, tokens: 0 });
    entry.blocks++;
    entry.tokens += Math.round(blockTokens(rates, it.author, it.body));
  }
  const budget = { ...(limit === null ? {} : { limit_tokens: limit }), host_fixed_tokens: prefix, tokens_before: Math.round(tokens), ...(limit === null ? {} : { to_remove_estimate: Math.max(0, Math.round(tokens - limit)) }) };
  return { budget, census };
}

// The verdicts of everything in a conversation that has none, asked (the pass in the background: what lived at least one turn, `low`; the one before the module's own request to
// compact: all of it). `messages` is the transcript the caller read. Returns the counts or {skipped}; never rejects.
async function fillBlockVerdicts($, cfg, messages, ctx) {
  try {
    if (cfg.mode !== 'active' || cfg.blocks === 'off' || cfg.verdicts === 'off' || !cfg.key || !cfg.pasteDir || !Array.isArray(messages)) return { skipped: 'off' };
    const sessionId = await sessionIdOf($);
    if (!sessionId) return { skipped: 'no_session' };
    const read = await withDeadline($, Promise.resolve().then(() => $.session.messages({ as: 'api' })), HOST_MS);
    const api = apiFormOf(read.value);
    if (!api) return { skipped: 'no_api_form' };
    const keepFrom = openLoopStart(messages, groupsOf(messages, api));
    if (!keptCallsIn(messages, keepFrom, api)) return { skipped: 'tail_calls' };
    const delivered = queuedOf(messages, api);
    const queued = delivered ? delivered.rows : new Map();
    // With the owner tail the reads of the host come first, as in decide, so that Jev is not asked about the blocks of a protected row.
    const early = cfg.ownerTail && cfg.targetPercent !== undefined ? await ownerTailReads($, cfg, ctx.deadline) : undefined;
    cfg = ownerProtectedCfg(cfg, messages, early);
    const stage = agentStageOf($, cfg, undefined, messages, api, queued, keepFrom, sessionId, ctx.deadline);
    const plan = planBlocks(cfg, messages, stage.trimmed, api, queued, keepFrom, sessionId);
    if (!plan.items.length) return { items: 0 };
    const user = userTask(messages, undefined, queued, cfg.privatePaths, cfg.notUserPrefixes, ownerLimitsOf(cfg));
    let prefix = 0;
    let limit = null;
    const detail = early ? early.detail : await hostValue($, () => $.session.usage({ breakdown: 'summary' }), ctx.deadline);
    prefix = prefixTokens(detail);
    if (cfg.targetPercent !== undefined) {
      const usage = early ? early.usage : await hostValue($, () => $.session.usage(), ctx.deadline);
      const win = early ? early.win : await resolveWindow($, cfg, detail, usage, ctx.deadline);
      if (win) limit = ruleTargetOf(win, cfg);
    }
    const extra = blockSignals(cfg.rates, prefix + listTokens(api, cfg.rates), plan.items, prefix, limit);
    const used = {}; // the usage of the requests of this pass (OMC_JEV_COMPACT_JEV_USAGE)
    const stats = await ensureBlockVerdicts($, cfg.jevUsage ? { ...cfg, usageRecord: used } : cfg, plan, { ...ctx, user, extra });
    return { rows: plan.stats.rows, blocks: plan.stats.blocks, ...stats, ...used };
  } catch (error) { return { skipped: 'error', error: clip(oneLine(String(error?.message ?? error)), 200) }; }
}

// The verdicts before the module's own request to compact: whatever the pass in the background is asking is waited for (no second question about the same blocks), then everything
// without a verdict is asked, and one record says what came of it. Never rejects.
async function fillBeforeCompaction($, cfg, messages) {
  try {
    const deadline = Date.now() + TOTAL_MS;
    if (session.blockBackground.run) { session.blockBackground.stop = true; await withDeadline($, session.blockBackground.run, TOTAL_MS); }
    const fill = await fillBlockVerdicts($, cfg, messages, { deadline, requestMs: REQUEST_MS });
    if (!fill.skipped) {
      let sessionId;
      try { sessionId = await $.session.id(); } catch { sessionId = undefined; }
      await writeRecord($, cfg, { ts: isoNow(), point: POINT, event: 'verdicts_fill', session_id: sessionId ?? null, agent_id: null, ...fill });
    }
  } catch { /* the fill never breaks the request */ }
}

// At the end of a turn of the main loop (ownThreshold), in the background and with no deadline of the turn: the verdicts of the blocks that lived at least one turn. One pass at a time, at most one in
// BLOCK_BACKGROUND_GAP_MS; a compaction that starts stops the pass. Never rejects. The pass that did not finish before the host ended is made up by fillBeforeCompaction and the compaction.
async function backgroundBlockVerdicts($, cfg) {
  const state = session.blockBackground;
  if (state.busy || Date.now() - state.at < BLOCK_BACKGROUND_GAP_MS) return;
  state.busy = true;
  state.stop = false;
  state.at = Date.now();
  let done;
  const mine = new Promise((resolve) => { done = resolve; });
  state.run = mine;
  try {
    if (cfg.mode !== 'active' || cfg.blocks === 'off' || cfg.verdicts === 'off' || session.compacting > 0 || session.hostCannot || (await blockedReason($, cfg, Date.now(), undefined))) return;
    const read = await withDeadline($, Promise.resolve().then(() => $.session.messages()), HOST_MS);
    if (!Array.isArray(read.value) || session.compacting > 0) return;
    const fill = await fillBlockVerdicts($, cfg, read.value, { minAge: 1, low: true, deadline: Date.now() + BLOCK_BACKGROUND_MS, requestMs: BLOCK_BACKGROUND_REQUEST_MS, cancel: () => session.compacting > 0 || state.stop });
    // With the usage switch, a pass in the background that asked something leaves a record of what it used; without it the pass writes none.
    if (fill.jev_usage) await writeRecord($, cfg, { ts: isoNow(), point: POINT, event: 'verdicts_fill', session_id: (await sessionIdOf($)) ?? null, agent_id: null, background: true, ...fill });
  } catch { /* the pass in the background never breaks a turn */ } finally {
    state.busy = false;
    done();
    if (state.run === mine) state.run = undefined;
  }
}
// --- end of verdicts of Jev on blocks of text -----------------------------------------------------------------------------------------------

// --- second round: Jev's order, one queue for the results and the blocks (OMC_JEV_COMPACT_BLOCKS=active) -------------------------------------------------------------
//
// After the second pass of the cascade (a secret or non-text result to a trace, a result Jev scored low to a trace) the prediction may still be above the target. The second
// round (`reduceToLimit`) then puts every item that Jev rated and that can still come down into one queue, in the order of Jev's ratings (a low rating is the least needed word for
// word), takes them from the lowest rating and stops at the target; the passes that follow in the cascade (`resume`) stay as the reserve for a missing answer of Jev. The items are the
// results of tools (to a trace, then removed with the call) and the blocks of text that Jev kept (level 2-3, to level 1: a trace with a file). The rating of a result is the answer of the first
// round, that of a block the score of its verdict. An item without a rating is not in the queue. A tie at the edge of the choice is put to Jev once (askTie); the code settles what stays
// tied, in the order of entry. With OMC_JEV_COMPACT_OWNER_LAST=active the owner's blocks that Jev kept stand behind every other item.
const F2_MAX_ROUNDS = 5; // the number of rounds limits the cost, not the choice
const F2_STOP_MS = 1200; // no round starts this close to the deadline
const F2_QUESTION = `The conversation after the compaction is above its target (f2.goal_tokens; what still has to come off: f2.to_remove_tokens), so some items have to come down. The item named in the question stays word for word now: it is the result of a tool, a block of text or a series of traces (field \`kind\`). Rate how much further work on the owner's tasks really needs its text word for word; a low rating means that giving it up is easiest. The code decides how many come down: it stops at the target and takes the items from the lowest rating. Rate every item honestly, without lowering ratings because of the size of the conversation. What coming down does: a block stays as a trace with a file (its first ${BLOCK_HEAD_CHARS} characters, its length, the file; the full text is in the file), the result of a tool as a trace with the name of the tool, a series as one line with the number of traces and a file with their full list. The rules of the levels are in \`block_rules\`.`;

// The entries of the results Jev rated (a result comes down to a trace, then to nothing), in the order of the candidates. `gain` is in the tokens of the candidates' costs.
function resultEntries(candidates, rates, shape) {
  const entries = [];
  for (const c of candidates) {
    if (!c.answered || isForced(c) || isPinned(c, rates, shape) || c.keep === 'drop') continue;
    const t = itemTokens(c, rates);
    const now = t[c.keep ?? 'full'];
    if (c.keep !== 'trace' && now - t.trace > 0) entries.push({ id: `w:${c.id}`, kind: 'result', score: c.score, gain: now - t.trace, tokens: t.full, c, to: 'trace' });
    const dropGain = Math.min(now, t.trace) - t.drop;
    if (dropGain > 0) entries.push({ id: `w:${c.id}:drop`, kind: 'result', score: c.score, gain: dropGain, tokens: t.full, c, to: 'drop', ...(c.keep !== 'trace' ? { requires: `w:${c.id}` } : {}) });
  }
  return entries;
}

// What a direct reply gives back when its blocks come down: neighbouring lowered blocks go to one run with one trace (the floor trace of the whole run), so the gain is that of the row,
// not the sum of its blocks; a run moves only when it pays, so a run that does not gains 0. `lowered(key)` says which blocks of the row are lowered.
function floorRowGain(cfg, plan, row, lowered) {
  const text = plan.messages[row].text;
  let gain = 0;
  let run;
  const close = () => {
    if (!run) return;
    const fragment = text.slice(run.start, run.end);
    gain += Math.max(0, run.tokens - cfg.rates.RATE_TRACE * blockTrace(fragment.length, fragment, blockFileOf('0'.repeat(32)), 'floor').length);
    run = undefined;
  };
  for (const b of plan.rows.get(row).blocks) {
    if (!lowered(b.key)) { close(); continue; }
    const tokens = blockTokens(cfg.rates, 'a', text.slice(b.start, b.end));
    if (run && !text.slice(run.end, b.start).trim()) { run.end = b.end; run.tokens += tokens; } else { close(); run = { start: b.start, end: b.end, tokens }; }
  }
  close();
  return gain;
}

// The entries of the blocks Jev kept (level 2-3) on rows no other stage changed: one per block, the blocks of a direct reply one per row. `patch` is the verdict the block carries
// out with when the entry is taken (level 1). The owner's blocks are `late` with OMC_JEV_COMPACT_OWNER_LAST.
function blockEntries(cfg, plan, hold) {
  const entries = [];
  const direct = new Map();
  const lowered = (key) => { const v = plan.verdicts.get(key); return Boolean(v) && v.level < 2; };
  for (const it of plan.items) {
    const v = plan.verdicts.get(it.key);
    const info = plan.rows.get(it.row);
    if (!v || v.level < 2 || !info || hold.has(it.row)) continue;
    if (info.direct) { direct.set(it.row, [...(direct.get(it.row) ?? []), it]); continue; }
    const gain = blockGain(cfg, it, 'start');
    if (gain > 0) entries.push({ id: `b:${it.key}`, kind: 'block', score: v.noul, gain, tokens: blockTokens(cfg.rates, it.author, it.body), item: it, ...(cfg.ownerLast && it.author === 'w' ? { late: true } : {}), patch: [[it.key, { ...v, level: 1, f2: true }]] });
  }
  for (const [row, group] of direct) {
    const keys = new Set(group.map((it) => it.key));
    const gain = floorRowGain(cfg, plan, row, (key) => lowered(key) || keys.has(key)) - floorRowGain(cfg, plan, row, lowered);
    if (gain <= 0) continue;
    const body = group.map((it) => it.body).join('\n\n');
    entries.push({ id: `b:row-${contentHash(body)}`, kind: 'block', score: Math.max(...group.map((it) => plan.verdicts.get(it.key).noul)), gain, tokens: group.reduce((n, it) => n + blockTokens(cfg.rates, it.author, it.body), 0), item: { ...group[0], body, chars: body.length }, patch: group.map((it) => [it.key, { ...plan.verdicts.get(it.key), level: 1, f2: true }]) });
  }
  return entries;
}

// The order and the stop: entries {id, score, gain} (`score`: Jev's rating, low = least needed; `gain`: the tokens that coming down saves), `need` tokens to come off. Takes from the lowest
// score (equal scores in the order of entry) until the gains cover `need`; nothing else orders them (not age, not length, not author). {chosen, saved, short, tie}: `short` when all of them
// together do not cover `need`; `tie` when the score at the edge of the choice stands behind it too: {group, below, restNeed}, the caller may ask Jev about the group and choose again.
export function chooseByRank(cands, need) {
  const sorted = cands.map((c, i) => ({ ...c, _i: i })).sort((x, y) => x.score - y.score || x._i - y._i);
  let saved = 0;
  let k = 0;
  while (k < sorted.length && saved < need) { saved += sorted[k].gain; k++; }
  if (saved < need) return { chosen: sorted, saved, short: true, tie: undefined };
  if (k === 0) return { chosen: [], saved: 0, short: false, tie: undefined };
  const edge = sorted[k - 1].score;
  const first = sorted.findIndex((x) => x.score === edge);
  let last = first;
  while (last + 1 < sorted.length && sorted[last + 1].score === edge) last++;
  const below = sorted.slice(0, first);
  const tie = last >= k ? { group: sorted.slice(first, last + 1), below, restNeed: need - below.reduce((n, x) => n + x.gain, 0) } : undefined;
  return { chosen: sorted.slice(0, k), saved, short: false, tie };
}

// The second round. `c.entries`, `c.pred` (the prediction before), `c.goal`, `c.deadline`, `c.askTie(group, restNeed)` (optional: one question about a tie group, the answers go to the
// `score` of the entries). Lowers in rounds from the lowest score and stops at the goal; an entry with `requires` is open only once that one is taken (a result's removal after its trace);
// entries `late` wait behind every other open one. {lowered [{...entry, by}], f2}.
export async function reduceToLimit(c) {
  const f2 = {
    goal_tokens: Math.round(c.goal), predicted_before: Math.max(0, Math.round(c.pred)), to_remove_tokens: Math.max(0, Math.round(c.pred - c.goal)), candidates: {}, rounds: [], lowered: { items: 0, tokens: 0, by_kind: {} },
    saved_by_stop: { items: 0, tokens: 0 }, ties: { asked: 0, errors: 0, groups: 0, group_items: 0, by_code: { items: 0, tokens: 0 } },
  };
  for (const x of c.entries) f2.candidates[x.kind] = (f2.candidates[x.kind] || 0) + 1;
  let pred = c.pred;
  const taken = new Set();
  const lowered = [];
  const tieAsked = new Set();
  while (pred > c.goal && f2.rounds.length < F2_MAX_ROUNDS && Date.now() < c.deadline - F2_STOP_MS) {
    const open = c.entries.filter((x) => !taken.has(x.id) && (!x.requires || taken.has(x.requires)));
    if (!open.length) { f2.reason = 'no_items'; break; }
    const rest = open.some((x) => !x.late) ? open.filter((x) => !x.late) : open;
    const need = pred - c.goal;
    const t0 = Date.now();
    let pick = chooseByRank(rest, need);
    let byCode;
    if (pick.tie) {
      const key = pick.tie.group.map((x) => x.id).join(',');
      f2.ties.groups++;
      f2.ties.group_items += pick.tie.group.length;
      if (c.askTie && !tieAsked.has(key)) {
        tieAsked.add(key);
        f2.ties.asked++;
        // chooseByRank returns copies: the answers go to the entries themselves.
        const byId = new Map(rest.map((x) => [x.id, x]));
        // A failing question does not break the compaction: the code settles the tie, and the failure is counted.
        try { await c.askTie(pick.tie.group.map((x) => byId.get(x.id)), Math.max(0, pick.tie.restNeed)); } catch (error) { f2.ties.errors++; f2.ties.error ??= clip(oneLine(String(error?.message ?? error)), 200); }
        pick = chooseByRank(rest, need);
      }
      if (pick.tie) {
        const inGroup = new Set(pick.tie.group.map((x) => x.id));
        const chosen = pick.chosen.filter((x) => inGroup.has(x.id));
        byCode = new Set(chosen.map((x) => x.id));
        f2.ties.by_code.items += chosen.length;
        f2.ties.by_code.tokens += Math.round(chosen.reduce((n, x) => n + x.tokens, 0));
      }
    }
    for (const x of pick.chosen) {
      taken.add(x.id);
      lowered.push({ ...x, by: byCode?.has(x.id) ? 'code' : 'jev' });
      pred -= x.gain;
      f2.lowered.items++;
      f2.lowered.tokens += Math.round(x.gain);
      f2.lowered.by_kind[x.kind] = (f2.lowered.by_kind[x.kind] || 0) + 1;
    }
    f2.rounds.push({ need_tokens: Math.round(need), chosen: pick.chosen.length, gain_tokens: Math.round(pick.saved), short: pick.short, tie: Boolean(pick.tie), predicted_after: Math.round(pred), ms: Date.now() - t0 });
    if (!pick.chosen.length) { f2.reason = 'no_change'; break; }
  }
  for (const x of c.entries) if (!taken.has(x.id) && !x.requires) { f2.saved_by_stop.items++; f2.saved_by_stop.tokens += Math.round(x.gain); }
  f2.predicted_after = Math.max(0, Math.round(pred));
  if (pred <= c.goal) f2.reason ??= lowered.length ? 'goal_reached' : 'below_goal';
  else f2.reason ??= f2.rounds.length >= F2_MAX_ROUNDS ? 'round_limit' : 'deadline';
  const late = c.entries.filter((x) => x.late);
  if (late.length) f2.late_owner_blocks = { candidates: late.length, lowered: lowered.filter((x) => x.late).length };
  return { lowered, f2 };
}

// One question to Jev about a tie group (the items stay as they are, only their scores change): the items in requests that fit the window, BLOCK_PARALLEL at a time through the module's
// own admission, within `ctx.deadline`. An item that no answer reaches keeps its score. ctx: user, goal, restNeed, deadline, rateOnly (the first rating of the series, not a tie).
async function askTie($, cfg, group, ctx) {
  const named = group.map((x, n) => ({ x, name: `t${n + 1}` }));
  const fieldsOf = ({ x }) => (x.kind === 'result'
    ? { kind: 'tool_result', tool: x.c.note ? NOTE_LABEL : x.c.use.tool, input: x.c.note ? '' : clip(oneLine(maskSecrets(sentInputJson(x.c.use.input, cfg.privatePaths).slice(0, STATE_INPUT_CHARS * 4 + MASK_SLACK_CHARS))), STATE_INPUT_CHARS), result: maskedHeadTail(x.c.res.text || '', STATE_HEAD_CHARS, STATE_TAIL_CHARS, cfg.privatePaths), chars: x.c.resultChars, ...(x.c.res.isError ? { error: true } : {}) }
    : x.kind === 'series'
      ? { row: x.item.row, kind: 'trace_series', author: 'module', text: seriesQuestion(x.item.body), length: x.item.chars, age_turns: x.item.age_turns, current_turn: x.item.current_turn, in_tail: x.item.in_tail, has_file: true, repeated: x.item.repeated, agent_session: x.item.agent_session, series: x.item.f2 }
      : { ...blockFields(x.item, { text: x.item.body, nr: 1, z: 1 }) });
  const windowBytes = windowBytesOf(cfg);
  const header = blockHeader(ctx.user, windowBytes, { f2: { goal_tokens: Math.round(ctx.goal), to_remove_tokens: Math.round(ctx.restNeed), ...(ctx.rateOnly ? {} : { tie_group: true }) } });
  const budget = Math.max(BLOCK_PART_MIN * 2, windowBytes - utf8Bytes(JSON.stringify(header)) - jsonBytes(BLOCK_RULES) - 40);
  const requests = [];
  let cur;
  for (const n of named) {
    const fields = fieldsOf(n);
    const textKey = n.x.kind === 'result' ? 'result' : 'text';
    const size = jsonBytes(fields) + BLOCK_ITEM_OVERHEAD;
    if (size > budget) {
      const allowed = Math.max(500, Math.floor((fields[textKey].length - (size - budget)) * 0.9));
      fields[textKey] = headTail(fields[textKey], Math.floor(allowed * 0.6), Math.floor(allowed * 0.4));
    }
    const own = jsonBytes(fields) + BLOCK_ITEM_OVERHEAD;
    if (!cur || (cur.size + own > budget && cur.items.length)) { cur = { size: 0, items: [] }; requests.push(cur); }
    cur.items.push({ n, fields });
    cur.size += own;
  }
  const failures = [];
  let next = 0;
  const worker = async () => {
    while (next < requests.length) {
      const req = requests[next++];
      if (Date.now() >= ctx.deadline) continue;
      const admission = await admitRequest($, cfg, ctx.deadline);
      if (admission.skip) continue;
      const t0 = Date.now();
      const timeoutMs = Math.min(REQUEST_MS, ctx.deadline - t0);
      if (timeoutMs < 500) { session.requests--; continue; }
      const items = {};
      const questions = {};
      for (const { n, fields } of req.items) {
        items[n.name] = fields;
        questions[n.name] = { type: 'score', instructions: `${F2_QUESTION} The item is \`items.${n.name}\`.`, criteria: BLOCK_LEVELS.map((what) => ({ what })) };
      }
      const r = await withDeadline($, askJev($, cfg, { ...header, items, block_rules: BLOCK_RULES }, questions), timeoutMs);
      noteJevUsage(cfg, 'second_round', r);
      const recording = recordSharedFailure($, cfg, { ...r, short: timeoutMs < 1000 });
      if (Date.now() < ctx.deadline) await withDeadline($, recording, ctx.deadline - Date.now());
      if (!r.value) { failures.push(classifyFailure(r)); continue; }
      for (const { n } of req.items) { const s = scoreOf(r.value[n.name]); if (s !== undefined) n.x.score = s; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BLOCK_PARALLEL, requests.length) }, worker));
  noteFailures(failures, Date.now());
}
// --- end of the second round ------------------------------------------------------------------------------------------------------------------------------------------

// --- series of traces (OMC_JEV_COMPACT_BLOCKS) --------------------------------------------------
// Two or more traces of the module on neighbouring lines of one row (SERIES_MIN; only white space between them) are a series, and a series that is asked for merges into one
// line that names a file holding the traces word for word. A series merges only whole, as a unit, and only where the row may be edited: before the open tool loop, outside the rows the
// host cannot rebuild from text, and, in a direct reply, never over the trace of a reply, of a block or of an agent's message. Which series to merge is not decided here: the caller passes the keys.
const SERIES_MIN = 2;
const SERIES_NOTE = '[compacted] traces merged:';
const SERIES_NOTE_RE = /^\[compacted\] traces merged: (\d+) calls, (\d+) replies, (\d+) others; list in /;
const seriesNote = (stats, path) => `${SERIES_NOTE} ${stats.calls} calls, ${stats.replies} replies, ${stats.others} others; list in ${path}`;
const seriesTok = (text, rates) => rates.RATE_TRACE * text.length + rates.RATE_NON_ASCII * nonAscii(text);
const seriesPath = (cfg, sessionId, name) => `${cfg.pasteDir}/${safeName(sessionId)}/${name}.txt`;
// The paths of the module's own files stand in its traces (a reply, an agent's message, a merged series). They are no secret, and a name of 32 hexadecimal digits is what the mask
// takes for one, so the file of a series is masked with them out and holds them as they were. They are no private path either.
// The files of the archive count whatever its switch says, as a conversation can still name them after it went off: a single path, and the list of a line merged from calls of one
// identical call, `<dir>/ (a.txt, b.txt)`. To the checks a path whose names the mask would change (the ids a host makes aside) is no path of the module: it is masked
// like any text; a file that is written keeps the paths whose files are there (seriesFileBody).
// An id a host makes counts only where a name begins, so behind a token prefix the mask reads it with the rest of the name; hexadecimal digits and a UUID also only where it ends.
const HOST_ID = /(?<![A-Za-z0-9_-])(?:(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}|[0-9a-f]{16}(?=\.txt|\/))(?![A-Za-z0-9_-])|toolu_(?:bdrk_|vrtx_)?[A-Za-z0-9]{20,32})/g;
function plainOwnPath(cfg, path) {
  const dir = [cfg.pasteDir, cfg.archiveDir].find((d) => d && path.startsWith(`${d}/`));
  const names = (dir ? path.slice(dir.length + 1) : path).replace(HOST_ID, 'id');
  return maskSecrets(names) === names && cleanForJevLong(names) === names;
}
const ARCHIVE_FILE = '[A-Za-z0-9_-]{1,80}\\.txt';
const ownFilePaths = (cfg) => new RegExp(`${escapeRegExp(cfg.pasteDir)}/[A-Za-z0-9_-]{1,80}/[0-9a-f]{32}\\.txt|\\b${BLOCK_LETTER}/[0-9a-f]{32}\\.txt${cfg.archiveDir ? `|${escapeRegExp(cfg.archiveDir)}/[A-Za-z0-9_-]{1,80}/(?:${ARCHIVE_FILE}| \\(${ARCHIVE_FILE}(?:, ${ARCHIVE_FILE})*\\))` : ''}`, 'g');
// The text of a series in the question to Jev: the shared mask of the other stages first (it reads forms the mask of a series cuts apart, as a value behind an escaped quote),
// then the mask of a series.
const seriesQuestion = (text) => cleanForJevLong(maskSecrets(text));
// The text of the file of a series: the mask of a series, then a line that keeps a possible secret is replaced; undefined when the mask cannot clear the text.
function seriesFileMask(text) {
  let masked = archiveMaskedLong(text);
  if (masked !== undefined) masked = maskResidualLines(masked);
  return masked === undefined || RESIDUAL_SECRET.test(masked) ? undefined : masked;
}
const withOwnPaths = (masked, kept) => masked?.replace(/\u{e000}(\d+)\u{e000}/gu, (mark, n) => kept[n] ?? mark);
// The file of a series keeps a path of the module's own files as it was only when every file it names can be read, so a name the shared mask hides leaves in it only as the
// name of a file that is there. Any other text of that shape is masked like the text around it; so is a path whose read fails or comes too late.
function namedFiles(cfg, sessionId, path) {
  const list = /^(.*\/) \((.*)\)$/.exec(path); // the list of a merged line, `<dir>/ (a.txt, b.txt)`
  if (list) return list[2].split(', ').map((name) => `${list[1]}${name}`);
  return [path.startsWith(`${BLOCK_LETTER}/`) ? `${blockDir(cfg, sessionId)}${path.slice(BLOCK_LETTER.length)}` : path];
}
// The text of the file of a series as it is written; undefined when the mask cannot clear it. `there` maps each file read so far to whether it could be read; the files
// not read yet are read ARCHIVE_PARALLEL at a time.
async function seriesFileBody($, gate, cfg, sessionId, series, there) {
  const own = ownFilePaths(cfg);
  const text = series.replace(/\u{e000}/gu, '\u{fffd}');
  const files = [...new Set(Array.from(text.matchAll(own), ([path]) => namedFiles(cfg, sessionId, path)).flat())].filter((file) => !there.has(file));
  for (let at = 0; at < files.length; at += ARCHIVE_PARALLEL) {
    await Promise.all(files.slice(at, at + ARCHIVE_PARALLEL).map(async (file) => there.set(file, typeof (await fsCall($, gate, () => $.fs.read(file))).value === 'string')));
  }
  const kept = [];
  const marked = `${text.trim()}\n`.replace(own, (path) => (namedFiles(cfg, sessionId, path).every((file) => there.get(file)) ? `\u{e000}${kept.push(path) - 1}\u{e000}` : path));
  return withOwnPaths(seriesFileMask(maskSecrets(marked)), kept);
}
// What may leave of one series, as text to Jev or as a file. A series that names a private path of the user's list stays whole. The names of its tools go to Jev in the
// statistics (statTools), so secretCheck, the check of the other stages, reads each of them (the parts of an MCP name one by one). Then the mask of a series (a series
// that keeps a line it cannot clear stays whole), and secretCheck reads both masked texts, the one of the file and the one of the question (the paths of the module's own files out of both): a hit, a text beyond what the check reads or no time left keeps
// the series whole. What leaves a series that passed has the shared mask under the mask of a series (seriesQuestion for the question). Returns
// {held: 'secret' | 'unchecked' | 'timed_out'} or {held: '', masked, kept}, the text of the file with its own paths as marks and the paths.
function checkSeries(cfg, series, own, budget) {
  if (namesPrivatePath(series.replace(own, 'file.txt'), cfg.privatePaths)) return { held: 'secret' };
  const tools = new Set(Array.from(series.matchAll(/^\[compacted\] ([^\s(]+)/gm), (m) => m[1]));
  for (const part of [...tools].flatMap((name) => (name.startsWith('mcp__') ? name.split('__') : [name]))) {
    const held = secretCheck(part.replace(HOST_ID, 'id'), cfg.privatePaths, budget);
    if (held) return { held };
  }
  // A mark stands for the n-th own path while the file is masked; the character of the marks is taken out of the text first, so the text of the conversation cannot name a path.
  const text = series.replace(/\u{e000}/gu, '\u{fffd}');
  const kept = [];
  const marked = `${text.trim()}\n`.replace(own, (path) => (plainOwnPath(cfg, path) ? `\u{e000}${kept.push(path) - 1}\u{e000}` : path));
  const first = seriesFileMask(marked);
  if (first === undefined) return { held: 'secret' };
  const file = first.replace(/\u{e000}\d+\u{e000}/gu, 'file.txt').trim();
  const question = cleanForJevLong(text.replace(own, (path) => (plainOwnPath(cfg, path) ? 'file.txt' : path))).trim();
  const held = secretCheck(file, cfg.privatePaths, budget) || (question === file ? '' : secretCheck(question, cfg.privatePaths, budget));
  if (held) return { held };
  const masked = seriesFileMask(maskSecrets(marked));
  return masked === undefined ? { held: 'secret' } : { held: '', masked, kept };
}
// One checker serves the floor, the question and the file of a compaction, so a series gets one answer in all three and is checked once, within one budget of the scan.
function seriesChecker(cfg, deadline) {
  const budget = { left: SCAN_BUDGET_CHARS, deadline };
  const done = new Map();
  return (series) => {
    if (!done.has(series)) done.set(series, checkSeries(cfg, series, ownFilePaths(cfg), budget));
    return done.get(series);
  };
}
// A row a series may stand in: text, no tool result.
const seriesRowOk = (m) => typeof m.text === 'string' && m.text.trim() && !(m.toolResults || []).length;

// The traces of the module in a text, one per line, from the first character of the line to its end: a removed call (`[compacted] `), a reply moved to a file, an agent's
// message moved to a file and a block moved to a file. The trace of a pasted text stands inside a line and is no span, so it ends a series like any other text.
function seriesSpans(text, protect = false) {
  const spans = [];
  for (let at = 0; at < text.length;) {
    const nl = text.indexOf('\n', at);
    const end = nl < 0 ? text.length : nl;
    const kind = text.startsWith('[compacted] ', at) ? 'call' : text.startsWith(REPLY_TRACE_PREFIX, at) ? 'reply' : text.startsWith(AGENT_TRACE_PREFIX, at) || text.startsWith(BLOCK_TRACE_PREFIX, at) ? 'other' : undefined;
    if (kind) spans.push({ start: at, end, kind, ...(protect && kind !== 'call' ? { fixed: true } : {}) }); // in a direct reply (protect) the trace of a reply or of a message stays as it is
    at = end + 1;
  }
  return spans;
}

/**
 * The series of a text: runs of at least SERIES_MIN neighbouring traces. [{start, end, text, stats}]; stats: traces, calls, replies, others, tools (calls by tool), errors, file
 * (some trace names a file). A line merged by an earlier compaction joins a new series with its own counts. In a direct reply (`protect`) a trace that stays fixed
 * is no member of a series and ends the one beside it.
 */
export function seriesRuns(text, protect = false, archive = false) {
  const runs = [];
  let cur;
  for (const sp of seriesSpans(text, protect)) {
    if (sp.fixed) { cur = undefined; continue; }
    if (cur && !text.slice(cur.end, sp.start).trim()) { cur.end = sp.end; cur.spans.push(sp); } else { cur = { start: sp.start, end: sp.end, spans: [sp] }; runs.push(cur); }
  }
  return runs.filter((r) => r.spans.length >= SERIES_MIN).map((r) => {
    const stats = { traces: 0, calls: 0, replies: 0, others: 0, tools: {}, errors: 0, file: false };
    for (const sp of r.spans) {
      const line = text.slice(sp.start, sp.end);
      const note = SERIES_NOTE_RE.exec(line);
      if (note) { stats.calls += Number(note[1]); stats.replies += Number(note[2]); stats.others += Number(note[3]); stats.traces += Number(note[1]) + Number(note[2]) + Number(note[3]); stats.file = true; continue; }
      stats.traces++;
      if (sp.kind === 'reply') stats.replies++;
      else if (sp.kind === 'other') stats.others++;
      else {
        // With the archive on, a trace may end in the path of its file, and a line merged from calls of one identical call (`x<n>`) counts as n calls.
        const times = archive ? Number(/^\[compacted\] [^\s(]+\([^\n]*?\) x(\d+) - /.exec(line.slice(0, 400))?.[1]) || 1 : 1;
        stats.calls += times;
        stats.traces += times - 1;
        const tool = /^\[compacted\] ([^\s(]+)/.exec(line)?.[1];
        if (tool) stats.tools[tool] = (stats.tools[tool] || 0) + times;
        if (archive ? / - error of \d+ chars removed(?:; full call and result: .*)?$/.test(line) : / - error of \d+ chars removed$/.test(line)) stats.errors++;
        else if (archive) stats.errors += Number(/ chars removed, including (\d+) errors?\b/.exec(line)?.[1]) || 0;
      }
      if (/full text in | in b\/[0-9a-f]+\.txt|^\[agent message moved/.test(line) || (archive && /; full calls? and results?\b/.test(line))) stats.file = true;
    }
    return { start: r.start, end: r.end, text: text.slice(r.start, r.end), stats };
  });
}

/**
 * Which rows a series may stand in: [0, tail) less `fixed` (the rows the host cannot rebuild from text: server blocks in an assistant row, an image or a file in a user row,
 * a user row a delivered message is anchored to), and `direct`, the direct replies. `tail` is the first row that keeps its handle (`keepFrom`, the open tool loop), not the start of the
 * last KEEP_LAST rows: a series in the newest rows before the open loop is merged too. `reason` says that nothing can be told: no API form, or a message with an image that matches no row.
 */
export function seriesContext(cfg, messages, api, keepFrom, queued = new Map()) {
  if (!api) return { reason: 'no_api_form' };
  const images = nonTextUserRows(messages, api);
  if (images.unmatched) return { reason: 'image_unmatched' };
  const fixed = new Set([...nonTextAssistantRows(messages, api), ...images.rows]);
  for (const [row] of queued) if (messages[row]?.role === 'user') fixed.add(row);
  for (const row of cfg.ownerProtected ?? []) fixed.add(row); // a protected row of the owner tail is no place for a series
  const users = ownerRows(messages, cfg.hookRowPrefixes, true);
  const delivered = [...queued].filter(([, blocks]) => blocks.some((b) => deliveryOf(b) === 'user')).map(([row]) => row);
  const userRows = [...new Set([...users, ...delivered])].sort((a, b) => a - b);
  return { tail: Math.min(keepFrom, messages.length), fixed, direct: directReplyRows(messages, users, delivered, true), facts: turnFacts(messages, userRows) };
}

// The statistics of a series name its tools to Jev. A name that a mask changes, alone or at the start of a trace, and one too long for a tool name are counted under one
// neutral name. An MCP name is read as its server and the rest (read whole, a long name of plain words looks like a token); a server id that the shared mask takes for
// a secret is counted there too.
const STAT_NAME_MAX = 200;
const STAT_NAME_HIDDEN = 'masked_tool';
const MCP_NAME = /^mcp__(.*?)__(.*)$/s;
function statTools(tools) {
  const plain = (text) => [text, `[compacted] ${text}(`].every((s) => maskSecrets(s) === s && cleanForJevLong(s) === s);
  const out = {};
  for (const [name, count] of Object.entries(tools)) {
    const key = name.length <= STAT_NAME_MAX && (MCP_NAME.exec(name)?.slice(1) ?? [name]).every(plain) ? name : STAT_NAME_HIDDEN;
    out[key] = (out[key] || 0) + count;
  }
  return out;
}

/**
 * The series for Jev and for the second round of the cascade: one item per text of a series (the same series in several rows is one item with its rows), with what merging it
 * gains in tokens (the traces at RATE_TRACE less the one line that replaces them, its path planned at the length of a file's). {kind, key, body, row (the last row), rows, chars, run,
 * gain, repeated, age_turns, current_turn, in_tail (of the last row), f2: what Jev is told of the series}. `key` is the text of the series. `agent`: the session is a subagent's.
 */
export function seriesItems(cfg, messages, ctx, sessionId, agent = false) {
  const byKey = new Map();
  if (ctx.reason) return [];
  const planned = seriesPath(cfg, sessionId, '0'.repeat(32));
  for (let i = 0; i < Math.min(ctx.tail, messages.length); i++) {
    const m = messages[i];
    if (!seriesRowOk(m) || ctx.fixed.has(i)) continue;
    for (const run of seriesRuns(m.text, ctx.direct.has(i), archivePathsOn(cfg))) {
      const seen = byKey.get(run.text);
      const signals = { age_turns: ctx.facts.age[i], current_turn: ctx.facts.age[i] === 0, in_tail: i >= ctx.facts.tail };
      if (seen) { Object.assign(seen, signals, { row: i, repeated: true }); seen.rows.push(i); continue; }
      const gain = Math.max(0, seriesTok(run.text, cfg.rates) - seriesTok(seriesNote(run.stats, planned), cfg.rates));
      const { traces, calls, replies, others, tools, errors, file } = run.stats;
      byKey.set(run.text, {
        kind: 'series', key: run.text, body: run.text, row: i, rows: [i], chars: run.text.length, run, gain, repeated: false, ...signals, agent_session: agent,
        f2: { kind: 'trace_series', traces, calls, replies, others, tools: statTools(tools), errors, has_file: file, tokens: Math.round(seriesTok(run.text, cfg.rates)), gain_tokens: Math.round(gain) },
      });
    }
  }
  return [...byKey.values()];
}

/**
 * Merges the series whose keys are in `keys` (the texts of the series): one line `[compacted] traces merged: N calls, M replies, K others; list in <file>` in place of the
 * traces, and the file holds them, masked (archiveMaskedLong, then maskResidualLines; the paths of the module's own files whose files can be read stay as they were).
 * Same files as the stages that move text: the state directory and `savePaste`. A series
 * stays whole when its file cannot be written and read back in time, or when `check` holds it (seriesChecker: `secret`, `unchecked`, `timed_out`). `record.series` holds the
 * counts. Returns the new text of each changed row by its row index (none unless active). Never rejects. `ctx` is seriesContext's.
 */
export async function mergeSeries($, cfg, record, messages, ctx, keys, sessionId, deadline, check = seriesChecker(cfg, deadline)) {
  const mode = cfg.blocks === 'active' && cfg.mode === 'active' ? 'active' : 'shadow';
  const stats = { mode, series: 0, traces: 0, tokens_before: 0, tokens_after: 0, files: 0, written: 0, reused: 0, write_failed: 0, secret: 0, unchecked: 0, timed_out: 0, ...(mode === 'active' ? { installed: false } : {}) };
  record.series = stats;
  const edited = new Map();
  if (ctx.reason) { stats.reason = ctx.reason; return edited; }
  if (!cfg.pasteDir) { stats.reason = 'no_state_dir'; return edited; }
  if (!sessionId) { stats.reason = 'no_session'; return edited; }
  try {
    const gate = { deadline, stalled: false };
    const done = new Map(); // text of a series -> {path} or {}: the same series in several rows gets one file
    const there = new Map(); // own file named in a series -> whether it can be read
    const paths = new Set();
    for (let i = 0; i < Math.min(ctx.tail, messages.length); i++) {
      const m = messages[i];
      if (!seriesRowOk(m) || ctx.fixed.has(i)) continue;
      const runs = seriesRuns(m.text, ctx.direct.has(i), archivePathsOn(cfg)).filter((r) => keys.has(r.text));
      let text = m.text;
      for (const run of [...runs].reverse()) {
        let r = done.get(run.text);
        if (!r) {
          const { held, masked, kept } = check(run.text);
          r = {};
          // A shadow merge writes no file and reads none.
          const body = held ? undefined : mode === 'active' ? await seriesFileBody($, gate, cfg, sessionId, run.text, there) : withOwnPaths(masked, kept);
          if (body === undefined) stats[held || 'secret']++;
          else {
            // The block traces in it name their files by letter: the file carries the header that says which directory the letter stands for.
            const file = run.text.includes(BLOCK_TRACE_PREFIX) || run.text.includes(`${AGENT_TRACE_PREFIX}${BLOCK_LETTER}/`) ? `${traceHeader(blockDir(cfg, sessionId))}\n${body}` : body;
            const path = seriesPath(cfg, sessionId, (await sha256Hex(file)).slice(0, 32));
            const saved = mode === 'active' ? await savePaste($, gate, path, file) : 'planned';
            if (saved === 'written' || saved === 'reused' || saved === 'planned') { if (saved !== 'planned') stats[saved]++; r = { path }; }
            else stats[saved === 'timeout' ? 'timed_out' : 'write_failed']++;
          }
          done.set(run.text, r);
        }
        if (!r.path) continue;
        const note = seriesNote(run.stats, r.path);
        text = text.slice(0, run.start) + note + text.slice(run.end);
        paths.add(r.path);
        stats.series++;
        stats.traces += run.stats.traces;
        stats.tokens_before += seriesTok(run.text, cfg.rates);
        stats.tokens_after += seriesTok(note, cfg.rates);
        if (mode === 'active') edited.set(i, text);
      }
    }
    stats.files = paths.size;
  } catch { stats.error = 1; }
  return edited;
}

// The series of one compaction (or pass): seriesContext on `messages` (the rows as they came), the items on `rows` (the rows as the stages before leave them). `potential` is what merging
// them all gives back (every series once, as the floor counts it); a series that `check` holds is no part of it. Nothing is checked before the floor asks.
function planSeries(cfg, messages, rows, api, queued, keepFrom, sessionId, agent = false, deadline = undefined) {
  const ctx = seriesContext(cfg, messages, api, keepFrom, queued);
  const items = seriesItems(cfg, rows, ctx, sessionId, agent);
  const check = seriesChecker(cfg, deadline);
  return { ctx, items, check, potential: () => items.reduce((sum, it) => (it.gain > 0 && !check(it.body).held ? sum + it.gain : sum), 0) };
}

// The series as entries of the second round: one per series that gains something, with its gain and the tokens it holds; a series that `check` holds (it would stay whole)
// is not asked about and is no entry. The ratings come from Jev (askTie with `rateOnly`, which sends the text masked); an entry without one is left out of the queue.
// {entries, stats: {items, secret, unchecked, timed_out}}.
function seriesEntries(cfg, items, check) {
  const stats = { items: items.length, secret: 0, unchecked: 0, timed_out: 0 };
  const entries = [];
  for (const it of items) {
    if (it.gain <= 0) continue;
    const { held } = check(it.body);
    if (held) { stats[held]++; continue; }
    entries.push({ id: `s:${contentHash(it.key)}`, kind: 'series', gain: it.gain, tokens: seriesTok(it.body, cfg.rates), item: it });
  }
  return { entries, stats };
}

// --- archive of calls and results (OMC_JEV_COMPACT_ARCHIVE) ---------------------------------------------------------------------------------
// See the header of this file. `active`: every call and result the cut traces, shortens or removes goes to <state dir>/compaction-archive/<session>/<id>.txt, the trace names it once
// the file reads back equal, and neighbouring traces of one identical call merge. `shadow`: the counts only. `$.fs` has no rename, remove or append, so a trace or cut names its file only
// after the write resolved and the file read back equals the content; a file of the same byte size is reused only when its text equals the content, any other file is written again.
const ARCHIVE_MAX_BYTES = 4194304; // what $.fs.write takes (Claude Code 2.1.322: 4194304 bytes of UTF-8)
const ARCHIVE_NAME_MAX = 80;
const ARCHIVE_PARALLEL = 8;
// No new write starts after ARCHIVE_BUDGET_MS from the start of the batch, nor after the compaction's own deadline; the rest is skipped as `time` (no file, no path in the trace).
const ARCHIVE_BUDGET_MS = 1500;
const ARCHIVE_LABEL = 'full call and result: ';
const ARCHIVE_HEAD = '[compaction archive]';
const ARCHIVE_HEAD_SLACK = 1000; // bytes over the result and the input JSON that the head and the masking can add
// The file of a session directory that every compaction with the archive touches, so the retention sees a live session by its newest file even when nothing new was archived.
const ARCHIVE_MARKER = '.compaction';
// Texts the module wrote in place of a result (shortText, the placeholder of a non-text result kept in a rebuilt row).
const ARCHIVE_PRODUCTS = ['[result shortened at compaction: ', '[notification shortened at compaction: ', '[non-text result (image or file) removed at compaction]'];
const ARCHIVE_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i; // Windows device names
const ARCHIVE_SCAN_MAX = 2000; // strings of one input walked; a larger input counts as a secret (fail closed)
const archiveOn = (cfg) => Boolean(cfg.archive) && cfg.archive !== 'off';
// Do the series read the path of an archive file, and a counter, in a trace? Only while the archive writes them into traces: `active` with the point active. With `shadow`, `off`, or `active` in a
// compaction that is not active, a trace is read as before the archive, so the conversation is the one built without the variable.
const archivePathsOn = (cfg) => cfg.archive === 'active' && cfg.mode === 'active';
const ARCHIVE_SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);
// A secret named by a word without a separator ("the password is X", "PIN 1234", which maskSecrets does not mask), in English and in Polish. The words of the other languages of LOCAL_NAMES of
// scripts/lib/jev-mask.mjs are not covered, so a result that names a secret only in one of them is archived.
const SECRET_WORD = /(?<![\p{L}\p{N}_])(?:has[\u0142l](?:o|a|em|u|ach|ami|om)?|has[e\u0119][\u0142l]|ha\u015ble|klucz(?:a|e|em|u|y|om|ami|ach)?|pin(?:u|em|y|\u00f3w)?|token(?:a|u|em|ie)?|sekret(?:u|em|y|\u00f3w|ami|ach)?|secrets?|passwords?|passwd|passphrase|passcode|api[ _-]?keys?|apikeys?|private[ _-]?keys?|credentials?)(?![\p{L}\p{N}_])/iu;
// A key whose value is a secret; its value goes to the head of an archive file as *** whole, also a number, an array or an object, and so does the value of a {name|key: <such a name>, value} pair.
const SECRET_KEY = /key(?!word|board|stroke|frame)|token|secret|passw|pass(?:[_-]?(?:phrase|wd|code)|$|[^a-z])|pwd|credential|auth(?!ors?(?:$|[^i]))|cookie|session(?:[_-]?id)?$|^sid$|^otp$|otp[_-]?(?:code|secret)|pin(?:[_-]?code)?$|has[\u0142l]o|klucz|sekret|signature|private/i;
const ARCHIVE_SECRET_TOOL = /^mcp__bitwarden__|vault|password|secret/i;
// Commands that print secrets: printenv, a bare env or set, gh auth token, a password manager.
const ARCHIVE_SECRET_COMMAND = /(?:^|[\s;|&(`$"'])(?:printenv\b|(?:env|set|export[ \t]+-p|declare[ \t]+-[px]+)[ \t]*(?=$|[\n;|&)`>])|gh[ \t]+auth[ \t]+(?:token\b|status\b[^\n;|&]*(?:[ \t]-t\b|--show-token\b))|bw[ \t]+(?:get|list|export)\b|op[ \t]+(?:read|item[ \t]+get)\b|pass[ \t]+show\b|security[ \t]+find-(?:generic|internet)-password\b|secret-tool[ \t]+lookup\b|(?:Get-ChildItem|gci|dir|ls)[ \t]+env:)/i;

/** The switch: `active` or `shadow` (any case, spaces trimmed), anything else off. */
export function archiveModeOf(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'active' || v === 'shadow' ? v : 'off';
}

// The archive's mode for one compaction: active only with the compaction active and a session id, shadow (counts only) otherwise; off without the switch or a state directory.
function archiveModeIn(cfg, record) {
  if (!archiveOn(cfg) || !cfg.archiveDir) return 'off';
  return cfg.archive === 'active' && cfg.mode === 'active' && record.session_id ? 'active' : 'shadow';
}

// Does `test` hold for any string of the value (keys too, nested objects and arrays)? Bounded walk; too large or too deep counts as true.
function archAnyString(value, test) {
  let seen = 0;
  const walk = (v, depth) => {
    if (++seen > ARCHIVE_SCAN_MAX || depth > 8) return true;
    if (typeof v === 'string') return test(v);
    if (Array.isArray(v)) return v.some((x) => walk(x, depth + 1));
    if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => test(k) || walk(x, depth + 1));
    return false;
  };
  return walk(value, 0);
}

const archSecretMemo = new WeakMap();
function archMemo(c, key, fn) {
  let m = archSecretMemo.get(c);
  if (!m) { m = {}; try { archSecretMemo.set(c, m); } catch { /* not an object */ } }
  if (!(key in m)) m[key] = fn();
  return m[key];
}

// 'secret' when the call may hold or reveal a secret (a secret or private path or a secret word in any string of its input, a secret tool, a shell command that prints secrets, a
// call the stages hold as secret), else ''. A value maskSecrets masks may stay: the input goes to the file masked.
export function archiveSecretInput(c, privatePaths = []) {
  if (!c) return '';
  return archMemo(c, 'input', () => {
    if (c.secret || c.proseSecret) return 'secret';
    if (c.note) return '';
    const tool = String(c.use?.tool ?? '');
    if (ARCHIVE_SECRET_TOOL.test(tool)) return 'secret';
    const command = c.use?.input && typeof c.use.input === 'object' ? c.use.input.command : undefined;
    if (ARCHIVE_SHELL_TOOLS.has(tool) && typeof command === 'string' && ARCHIVE_SECRET_COMMAND.test(command)) return 'secret';
    return archAnyString(c.use?.input, (s) => namesSecretPath(s, privatePaths) || SECRET_WORD.test(s)) ? 'secret' : '';
  });
}

// true when the result (or notification) may hold a secret: a secret or private path, a secret word, or any text maskSecrets would change. The result goes to the file unchanged,
// so such a result is not archived at all (`secret_in_result`) and its trace names no file.
export function archiveSecretResult(c, privatePaths = []) {
  if (!c) return false;
  return archMemo(c, 'result', () => {
    const text = typeof c.res?.text === 'string' ? c.res.text : '';
    return namesSecretPath(text, privatePaths) || SECRET_WORD.test(text) || maskSecrets(text) !== text;
  });
}

// One path segment from a tool_use id: only [A-Za-z0-9_-], at most ARCHIVE_NAME_MAX characters; an id that had to change (or a Windows device name) gets a hash of the original,
// so two ids never share a file. Empty: ''.
export function archiveSegment(id) {
  const raw = String(id ?? '');
  if (!raw) return '';
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  if (clean === raw && clean.length <= ARCHIVE_NAME_MAX && !ARCHIVE_RESERVED.test(clean)) return clean;
  return `${clean.slice(0, ARCHIVE_NAME_MAX - 17)}-${contentHash(raw)}`;
}

// The archive name of a candidate: its tool_use_id; a notification (c.note, id `notification-<row>`, a row index that changes between compactions) is named by a hash of its text.
function archiveIdOf(c) {
  if (!c) return '';
  if (c.note) return `notification-${contentHash(c.res?.text ?? '')}`;
  return String(c.id ?? '');
}

// The directory of a session: its id as a path segment (archiveSegment), so session ids that differ only in characters outside the set, or that are device names, never share one.
// scripts/lib/jev-compaction-state.mjs names the directory the same way.
function archiveDirOf(cfg, sessionId) {
  const segment = archiveSegment(sessionId);
  return cfg.archiveDir && segment ? `${cfg.archiveDir}/${segment}` : undefined;
}

// The path of a candidate's archive (pure: no file is touched), undefined without a state directory, a session id or an id.
export function archivePathOf(cfg, sessionId, c) {
  const dir = archiveDirOf(cfg, sessionId);
  const name = archiveSegment(archiveIdOf(c));
  return dir && name ? `${dir}/${name}.txt` : undefined;
}

const archIsProduct = (text) => text.startsWith('[compacted] ') || ARCHIVE_PRODUCTS.some((p) => text.includes(p));
const archNamesPath = (text, path) => String(text ?? '').includes(`; ${ARCHIVE_LABEL}${path}`);
const archiveSuffix = (path) => (path ? `; ${ARCHIVE_LABEL}${path}` : '');

// Why a candidate is not archived, or '' when it is: secret (the call), no_text, empty, after_compaction (the text is a compaction's own), over_limit, secret_in_result.
export function archiveSkip(c, privatePaths = []) {
  const secret = archiveSecretInput(c, privatePaths);
  if (secret) return secret;
  if (c.textOnly === false) return 'no_text';
  const text = typeof c.res?.text === 'string' ? c.res.text : '';
  if (!text) return 'empty';
  if (archIsProduct(text)) return 'after_compaction';
  if (utf8Bytes(text) + (c.note ? 0 : utf8Bytes(archInputJson(c))) + ARCHIVE_HEAD_SLACK > ARCHIVE_MAX_BYTES) return 'over_limit';
  if (archiveSecretResult(c, privatePaths)) return 'secret_in_result';
  return '';
}

function archInputJson(c) {
  try { return JSON.stringify(c.use?.input ?? {}, null, 2) ?? ''; } catch { return ''; }
}

// The input for the archive head, masked before it is serialised: the value of a secret-like key and of a name/value pair with a secret-like name becomes ***, every other string goes
// through maskSecrets; the JSON is masked once more as a whole.
function archMaskedInput(c) {
  const pairName = (v) => (typeof v?.name === 'string' ? v.name : typeof v?.key === 'string' ? v.key : '');
  try {
    const json = JSON.stringify(c.use?.input ?? {}, (key, v) => {
      if (key && SECRET_KEY.test(key) && v !== null && v !== undefined) return '***';
      if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v && SECRET_KEY.test(pairName(v))) return { ...v, value: '***' };
      return typeof v === 'string' ? maskSecrets(v) : v;
    }, 2) ?? '';
    return maskSecrets(json);
  } catch { return ''; }
}

// The head of an archive file: what the call was (tool, tool_use_id) and its input as masked JSON, then a line that opens the result; a notification has no call. The result follows
// the head unchanged.
export function archiveHeaderOf(c) {
  const text = typeof c.res?.text === 'string' ? c.res.text : '';
  if (c.note) return `${ARCHIVE_HEAD} background task notification\n--- content (${text.length} chars, unchanged) ---\n`;
  const what = `${oneLine(c.use?.tool ?? '')}, tool_use_id ${oneLine(c.id ?? '')}`;
  return `${ARCHIVE_HEAD} call ${what}\n--- input (masked) ---\n${archMaskedInput(c)}\n--- ${c.res?.isError ? 'error' : 'result'} (${text.length} chars, unchanged) ---\n`;
}

export const archiveContentOf = (c) => archiveHeaderOf(c) + (typeof c.res?.text === 'string' ? c.res.text : '');

// The path a trace or cut may name before the write (in decide, before the floor and the cascade count the trace): the archive path of a candidate that will be archived, and the path
// a cut of an earlier compaction already names (its archive exists; archiveResults reuses it, so a cut traced now keeps pointing at the full text); else undefined. After archiveResults a
// planned path without `path` in byId is dropped from the trace.
function archivePlannedPath(cfg, sessionId, c) {
  const path = archivePathOf(cfg, sessionId, c);
  if (!path) return undefined;
  const skip = archiveSkip(c, cfg.privatePaths);
  if (!skip) return path;
  return skip === 'after_compaction' && archNamesPath(c.res?.text, path) ? path : undefined;
}

// The costs of a candidate again, after its archive path was set or dropped (findCandidates sets them from the same texts).
function archiveCosts(c) {
  c.trace = traceLine(c);
  c.traceCost = c.note ? c.trace.length : c.trace.length + 1;
  c.shortCost = c.resultChars > SHORT_CHARS ? (c.note ? 0 : c.inputChars) + shortText(c).length : c.fullCost;
}

// One candidate: {id, path?, reused?, rewritten?, skipped?, error?, bytes}. `existing` maps the file names already in the session directory to their sizes; `lim` = {writeBy, hardEnd, gate}:
// no write starts at or after writeBy, no read after hardEnd (undefined: none), and none at all once a host call hit its HOST_MS cap (gate.stalled; that call's item gets the error `host_time`).
async function archiveOne($, dir, c, existing, verify, privatePaths, lim) {
  const name = archiveSegment(archiveIdOf(c));
  const out = { id: c.id, bytes: 0 };
  if (!name) { out.skipped = 'no_id'; return out; }
  const path = `${dir}/${name}.txt`;
  const text = typeof c.res?.text === 'string' ? c.res.text : '';
  const skip = archiveSkip(c, privatePaths);
  if (skip === 'after_compaction' && archNamesPath(text, path) && existing.has(`${name}.txt`)) { out.path = path; out.reused = true; return out; }
  if (skip) { out.skipped = skip; return out; }
  const content = archiveContentOf(c);
  const bytes = utf8Bytes(content);
  out.bytes = bytes;
  if (bytes > ARCHIVE_MAX_BYTES) { out.skipped = 'over_limit'; return out; }
  const late = (end) => lim.gate.stalled || (end !== undefined && Date.now() >= end);
  const failed = (r) => { if (r.timeout) { lim.gate.stalled = true; out.error = 'host_time'; } else out.error = clip(oneLine(String(r.error?.message ?? r.error)), 200); return out; };
  // A file of the same size is used only when its text is the content (a write that failed its read-back, or an older head of the same length, leaves such a file); any other file is written again.
  if (existing.get(`${name}.txt`) === bytes) {
    if (late(lim.hardEnd)) { out.skipped = 'time'; return out; }
    const r = await fsCall($, lim.gate, () => $.fs.read(path));
    if (r.timeout) return failed(r);
    if (!r.error && r.value === content) { out.path = path; out.reused = true; return out; }
    out.rewritten = true;
  }
  if (late(lim.writeBy)) { out.skipped = 'time'; return out; }
  const w = await fsCall($, lim.gate, () => $.fs.write(path, content));
  if (w.timeout || w.error) return failed(w);
  if (verify) {
    const r = await fsCall($, lim.gate, () => $.fs.read(path));
    if (r.timeout || r.error) return failed(r);
    if (r.value !== content) { out.error = 'read_mismatch'; return out; }
  }
  out.path = path;
  return out;
}

/**
 * The archive of a compaction: every candidate whose keep is not 'full' (all given when keep is not set). Never throws. Returns {ms, written, reused, rewritten, bytes, skipped: {reason: n},
 * errors, timedOut, stalled, marker, byId: Map(c.id -> {id, path?, reused?, rewritten?, skipped?, error?, bytes})}; only an entry with `path` may be named in a trace. Time: no write starts
 * later than min(budgetMs, leftMs) after the start (budgetMs default ARCHIVE_BUDGET_MS, leftMs the time the compaction has left; Infinity = no limit) and no read later than leftMs; every
 * list, read and write is capped at HOST_MS, and after one that hit the cap no call starts. Such items get skipped `time` or the error `host_time`, both counted in `timedOut`. With `marker`
 * the directory's ARCHIVE_MARKER is written first (the retention's sign of a live session), when the directory exists or something is to be archived.
 */
export async function archiveResults($, cfg, sessionId, candidates, { verify = true, parallel = ARCHIVE_PARALLEL, budgetMs = ARCHIVE_BUDGET_MS, leftMs = Infinity, marker = false } = {}) {
  const started = Date.now();
  const left = typeof leftMs === 'number' && !Number.isNaN(leftMs) ? Math.max(0, leftMs) : Infinity;
  const budget = typeof budgetMs === 'number' && !Number.isNaN(budgetMs) ? Math.max(0, budgetMs) : Infinity;
  const writeSpan = Math.min(budget, left);
  const lim = { writeBy: Number.isFinite(writeSpan) ? started + writeSpan : undefined, hardEnd: Number.isFinite(left) ? started + left : undefined, gate: { deadline: Number.isFinite(left) ? started + left : Infinity, stalled: false } };
  const summary = { ms: 0, written: 0, reused: 0, rewritten: 0, bytes: 0, skipped: {}, errors: 0, timedOut: 0, stalled: false, marker: false, byId: new Map() };
  const items = (candidates || []).filter((c) => c && (c.keep === undefined || c.keep !== 'full'));
  const dir = archiveDirOf(cfg, sessionId);
  const results = [];
  if (!dir) {
    for (const c of items) results.push({ id: c.id, bytes: 0, skipped: 'no_session' });
  } else if (items.length || marker) {
    const existing = new Map();
    // Past the compaction's end (leftMs 0) not even the list starts: every item gets `time` below.
    const listed = lim.hardEnd !== undefined && Date.now() >= lim.hardEnd ? {} : await fsCall($, lim.gate, () => $.fs.list(dir));
    if (Array.isArray(listed.value)) for (const e of listed.value) if (e && e.kind === 'file') existing.set(e.name, e.size);
    if (marker && (Array.isArray(listed.value) || items.length) && !lim.gate.stalled && (lim.writeBy === undefined || Date.now() < lim.writeBy)) {
      const w = await fsCall($, lim.gate, () => $.fs.write(`${dir}/${ARCHIVE_MARKER}`, `${isoNow()}\n`));
      summary.marker = !w.timeout && !w.error;
    }
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const k = next++;
        try { results[k] = await archiveOne($, dir, items[k], existing, verify, cfg.privatePaths, lim); } catch (error) { results[k] = { id: items[k].id, bytes: 0, error: String(error?.message ?? error) }; }
      }
    };
    if (items.length) await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, items.length)) }, worker));
  }
  for (const r of results) {
    summary.byId.set(r.id, r);
    if (r.skipped) summary.skipped[r.skipped] = (summary.skipped[r.skipped] || 0) + 1;
    else if (r.error) summary.errors++;
    else if (r.reused) summary.reused++;
    else { summary.written++; summary.bytes += r.bytes; if (r.rewritten) summary.rewritten++; }
    if (r.skipped === 'time' || r.error === 'host_time') summary.timedOut++;
  }
  summary.stalled = lim.gate.stalled;
  summary.ms = Date.now() - started;
  return summary;
}

// Shadow: what archiveResults would try, with no file touched: {planned, skipped: {reason: n}, byId: Map(c.id -> {id, skipped?})} for every candidate whose keep is not 'full'.
export function archivePlan(candidates, privatePaths = []) {
  const plan = { planned: 0, skipped: {}, byId: new Map() };
  for (const c of candidates || []) {
    if (!c || c.keep === 'full') continue;
    const skip = archiveSkip(c, privatePaths);
    plan.byId.set(c.id, skip ? { id: c.id, skipped: skip } : { id: c.id });
    if (skip) plan.skipped[skip] = (plan.skipped[skip] || 0) + 1;
    else plan.planned++;
  }
  return plan;
}

// --- merging neighbouring traces of one identical call ----------------------------------------------------------------------------------------

// The entry of a traced candidate (`msg` the API message of its row, groupsOf). `key` is a hash of the tool and the whole input: only entries with the same key and message merge. Other
// entries ({kind: 'text', text}, {kind: 'call'}, {kind: 'result'}, anything without kind 'trace') stand between traces; a text entry with only white space does not part them.
function traceEntryOf(c, msg) {
  return {
    kind: 'trace',
    id: c.id,
    tool: c.use?.tool ?? '',
    target: c.summary ?? '',
    key: contentHash(`${c.use?.tool ?? ''}\n${archInputJson(c)}`),
    msg: msg ?? null,
    line: c.trace,
    resultChars: c.resultChars,
    isError: Boolean(c.res?.isError),
    note: Boolean(c.note),
    textOnly: c.textOnly !== false,
    path: c.archivePath,
  };
}

const mergeable = (e) => e && e.kind === 'trace' && !e.note && e.textOnly !== false;
const mergeBreaks = (e) => !(e && e.kind === 'text' && !String(e.text ?? '').trim());

function mergedLine(run) {
  const head = run[0];
  const results = run.reduce((s, e) => s + (Number(e.resultChars) || 0), 0);
  const errors = run.filter((e) => e.isError).length;
  let line = `[compacted] ${head.tool}(${clip(String(head.target ?? ''), TRACE_INPUT_CHARS)}) x${run.length} - results of ${results} chars removed`;
  if (errors) line += `, including ${errors} ${errors === 1 ? 'error' : 'errors'}`;
  const paths = run.map((e) => e.path).filter(Boolean);
  if (paths.length) {
    const dir = paths[0].slice(0, paths[0].lastIndexOf('/') + 1);
    const sameDir = paths.every((p) => p.slice(0, p.lastIndexOf('/') + 1) === dir);
    const files = sameDir ? paths.map((p) => p.slice(dir.length)) : paths;
    line += `; full calls and results${paths.length < run.length ? ` ${paths.length} of ${run.length}` : ''}: ${sameDir ? `${dir} (${files.join(', ')})` : files.join(', ')}`;
  }
  return line;
}

/**
 * Entries in conversation order in, the same list out with every run of at least two neighbouring mergeable traces (same tool, same key: the whole input; same API message; no breaking
 * entry between them) replaced by one entry {kind: 'trace', merged: true, id (the first), ids, count, tool, target, line, resultChars, errors, paths}. Other entries come back as the same
 * objects; blank text entries inside a run are dropped with it.
 */
export function mergeTraceEntries(entries) {
  const out = [];
  const list = Array.isArray(entries) ? entries : [];
  let i = 0;
  while (i < list.length) {
    const e = list[i];
    if (!mergeable(e)) { out.push(e); i++; continue; }
    const run = [e];
    let j = i + 1;
    let end = i + 1;
    while (j < list.length) {
      const x = list[j];
      if (mergeable(x) && x.tool === e.tool && x.key === e.key && x.msg === e.msg) { run.push(x); j++; end = j; continue; }
      if (!mergeBreaks(x)) { j++; continue; }
      break;
    }
    if (run.length < 2) { out.push(e); i++; continue; }
    out.push({
      kind: 'trace',
      merged: true,
      id: e.id,
      ids: run.map((x) => x.id),
      count: run.length,
      tool: e.tool,
      target: e.target,
      line: mergedLine(run),
      resultChars: run.reduce((s, x) => s + (Number(x.resultChars) || 0), 0),
      errors: run.filter((x) => x.isError).length,
      paths: run.map((x) => x.path).filter(Boolean),
    });
    i = end;
  }
  return out;
}

// The entries for mergeTraceEntries from the rows before keepFrom, in the order build writes them: per assistant row its text, the traces of its calls, then a break per kept call; per
// result row a break per kept result, then its text; a traced notification as a trace that never merges (it parts its neighbours), a kept or cut one as text; a removed call or
// notification leaves nothing (unless a delivered message is carried in its place); every other row is text. A trace carries the API message of its row (`group` of groupsOf), so traces of two
// messages never merge.
export function archTraceEntries(rows, candidates, keepFrom, group, queued = new Map()) {
  const byId = new Map();
  const notes = new Map();
  for (const c of candidates) { if (c.note) notes.set(c.resIdx, c); else byId.set(c.id, c); }
  const out = [];
  for (let i = 0; i < Math.min(keepFrom, rows.length); i++) {
    const m = rows[i];
    if (m.trimDrop === true) continue;
    const note = notes.get(i);
    if (note) {
      if (note.keep === 'trace') out.push(traceEntryOf(note));
      else if (note.keep !== 'drop' || queued.get(i)) out.push({ kind: 'text', text: note.res.text });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.text) out.push({ kind: 'text', text: m.text });
      const calls = [];
      for (const u of m.toolUses || []) {
        const c = byId.get(u.tool_use_id);
        if (c && c.keep === 'trace') out.push(traceEntryOf(c, Array.isArray(group) ? group[i] : undefined));
        else if (!(c && c.keep === 'drop')) calls.push({ kind: 'call' });
      }
      out.push(...calls);
      continue;
    }
    if (m.role === 'user' && (m.toolResults || []).length) {
      for (const r of m.toolResults) { const c = byId.get(r.tool_use_id); if (!c || c.keep === 'full' || c.keep === 'short') out.push({ kind: 'result' }); }
      if (m.text || queued.get(i)) out.push({ kind: 'text', text: m.text || '-' });
      continue;
    }
    out.push({ kind: 'text', text: typeof m.text === 'string' && m.text ? m.text : '-' });
  }
  return out;
}

// The archive step of decide, after the plan and before build: the files (active) or the counts (shadow), then the merge of neighbouring identical traces. A candidate whose file was not
// written has its path taken out of the trace; the prediction of the plan is not changed (the archive takes no tokens off: the files come after the plan).
async function archiveStep($, cfg, record, mode, candidates, rows, keepFrom, group, queued, started) {
  record.archive_mode = mode;
  let arch;
  if (mode === 'active') {
    arch = await archiveResults($, cfg, record.session_id, candidates, { leftMs: started + TOTAL_MS - Date.now(), marker: true });
    for (const c of candidates) if (c.archivePath && c.keep !== 'full' && !arch.byId.get(c.id)?.path) { c.archivePath = undefined; archiveCosts(c); }
    Object.assign(record, { archive_ms: arch.ms, archive_written: arch.written, archive_reused: arch.reused, archive_rewritten: arch.rewritten, archive_bytes: arch.bytes, archive_skipped: arch.skipped, archive_errors: arch.errors, archive_timed_out: arch.timedOut, archive_marker: arch.marker });
  } else {
    arch = archivePlan(candidates, cfg.privatePaths);
    Object.assign(record, { archive_planned: arch.planned, archive_skipped: arch.skipped });
  }
  const merged = mergeTraceEntries(archTraceEntries(rows, candidates, keepFrom, group, queued));
  if (mode === 'active') {
    const byId = new Map(candidates.filter((c) => !c.note).map((c) => [c.id, c]));
    for (const e of merged) {
      if (!e.merged) continue;
      byId.get(e.id).trace = e.line;
      for (const id of e.ids.slice(1)) byId.get(id).mergedInto = e.id;
    }
  }
  Object.assign(record, { merged_traces: merged.filter((e) => e.merged).length, merged_items: merged.reduce((n, e) => n + (e.merged ? e.ids.length : 0), 0) });
}

// --- host attachments (OMC_JEV_COMPACT_HOST_ATTACHMENTS=1 or true) -------------------------------------------------------------------------------
// The host keeps every entry that is no row (an attachment, a local command's record, an isMeta message, a system entry) in the group of the row before it, and a row
// that keeps its handle comes back with its whole group. So with the switch on a user row of text before keepFrom is built from its text (build, `drop`), with the
// messages delivered after it in their envelopes, and its group (instructions, lists of skills and agents, deltas of tools, memory files, the old text of used
// skills, hook contexts) does not come back; the host announces again what it finds missing in the list after the boundary. A row keeps its handle for a technical
// reason only: it stands from keepFrom on (the open loop), its turn holds an image, a document or a /goal record (which renders to nothing and which the host does
// not rebuild), it has no text or holds [Image #N], or the API form does not place its turn.
// The advisor: the host takes the advisor's model from the last advisor_tool attachment of the list before its first request after a compaction, so the row that
// carries the advisor's reminder (the last user row of its turn) is rebuilt too and the host announces the advisor again from the setting; a carrier that cannot be
// rebuilt without a loss hands the compaction to the host's summary (advisor_image, advisor_command, advisor_no_row, advisor_in_tail, advisor_form_cut).
// The kinds of attachments are told by the first line the host renders each with, so their table follows the version of the host.
const API_FORM_MAX = 4096; // the number of messages the host's API form keeps (a cut form shows less than the conversation)
const GOAL_COMMAND = /^\s*<command-name>\s*\/goal\b/i;
const REMINDER_OPEN = '<system-reminder>\n';
const REMINDER_CLOSE = '\n</system-reminder>';
// The reminders of a text, each from an opener to the first closing line after it, and the text without them. One pass: after an opener without a closing line no
// later opener has one either, so the scan stops there (a lazy regular expression reads to the end from every one of them, which is quadratic).
export function splitReminders(text) {
  const reminders = [];
  const rest = [];
  let at = 0;
  for (let from = text.indexOf(REMINDER_OPEN); from >= 0; from = text.indexOf(REMINDER_OPEN, at)) {
    const close = text.indexOf(REMINDER_CLOSE, from + REMINDER_OPEN.length);
    if (close < 0) break;
    rest.push(text.slice(at, from));
    at = close + REMINDER_CLOSE.length;
    reminders.push(text.slice(from, at));
  }
  rest.push(text.slice(at));
  return { reminders, rest: rest.join('') };
}
// The advisor's reminder in its three forms: the instructions (under this heading), the sentence of an announcement and the sentence of the removal.
const ADVISOR_HEADING = '# Advisor Tool\n';
const ADVISOR_SENTENCES = [
  'The advisor tool is available; the advisor instructions announced earlier apply.',
  'The advisor tool is no longer available; disregard the earlier advisor instructions.',
];
// How many reminders of the advisor a text holds: each opens the text (after blank space) or follows an empty line, and an empty line or blank space to the end
// follows its closing line. One pass: the openers are read in order, and the closing line that ends the instructions is searched only forward.
export function advisorNotes(text) {
  if (typeof text !== 'string' || !text.includes(REMINDER_OPEN)) return 0;
  const blankFrom = text.trimEnd().length;
  const ends = (close) => text.startsWith(REMINDER_CLOSE, close) && (close + REMINDER_CLOSE.length >= blankFrom || text.startsWith('\n\n', close + REMINDER_CLOSE.length));
  let closing = -1; // the closing line found last that ends the instructions
  let none = false; // no such line stands further on
  // Where the reminder whose body starts at `body` ends; -1 when there is none.
  const endOf = (body) => {
    if (!text.startsWith(ADVISOR_HEADING, body)) {
      const sentence = ADVISOR_SENTENCES.find((s) => text.startsWith(s, body));
      return sentence && ends(body + sentence.length) ? body + sentence.length + REMINDER_CLOSE.length : -1;
    }
    const first = body + ADVISOR_HEADING.length;
    if (!none && closing < first) {
      closing = text.indexOf(REMINDER_CLOSE, first);
      while (closing >= 0 && !ends(closing)) closing = text.indexOf(REMINDER_CLOSE, closing + 1);
      none = closing < 0;
    }
    return none ? -1 : closing + REMINDER_CLOSE.length;
  };
  let count = 0;
  let at = 0; // where the next reminder may start
  const take = (opener) => {
    const end = endOf(opener + REMINDER_OPEN.length);
    if (end < 0) return false;
    count++;
    at = end;
    return true;
  };
  const head = text.length - text.trimStart().length;
  if (text.startsWith(REMINDER_OPEN, head)) take(head);
  const opener = `\n\n${REMINDER_OPEN}`;
  for (let p = text.indexOf(opener, at); p >= 0; p = text.indexOf(opener, at)) if (!take(p + 2)) at = p + 1;
  return count;
}
// One rendered attachment of the host (a reminder) and its kind, by the first line the host renders it with. The third value says what the host does when the list
// after the boundary lacks the attachment: true, it announces it again; 'list', it is a list the host keeps as a set of entries (a delta that comes back leaves the
// rest of the list to be announced again); 'always', one is added after every compaction whatever was taken off (SessionStart hooks); false, it is never announced
// again (used skills and a restored file come back only in the pack of the host's own compaction; hook contexts, task states and file notes come from events).
const HOST_ATTACHMENTS = [
  ['instructions', /^Codebase and user instructions are shown below/, true],
  ['instructions_reread', /^Instruction files were re-read /, false],
  ['session_context', /^(?:As you answer the user's questions, you can use the following context|The session context was re-read )/, true],
  ['skill_listing', /^(?:The following skills are available for use with|New skills discovered in )/, 'list'],
  ['agent_listing', /^(?:Available agent types for the Agent tool|New agent types are now available for the Agent tool|The following agent types are no longer available)/, 'list'],
  ['deferred_tools', /^(?:The following tools just became available|The following deferred tools are now available)/, 'list'],
  ['deferred_tools', /^(?:Definitions of the following tools were loaded earlier|The following (?:deferred )?tools are no longer available)/, 'list'],
  ['mcp_instructions', /^(?:# MCP Server Instructions\b|The following MCP servers have disconnected)/, 'list'],
  ['environment', /^# Environment\n/, true],
  ['environment_update', /^# Environment update\b/, false],
  ['model', /^You are powered by the model named /, true],
  ['language', /^# Language\n/, true],
  ['date', /^Today's date is /, true],
  ['date_change', /^The date has changed\./, false],
  ['advisor_tool', /^(?:# Advisor Tool\n|The advisor tool is (?:available|no longer available))/, true],
  ['auto_mode', /^While (?:bypass permissions|auto) mode is active/, true],
  ['remote_session_change', /^From here on, do not add attribution lines/, true],
  ['invoked_skills', /^The following skills were invoked EARLIER/, false],
  ['file', /^(?:Called the Read tool with the following input|Result of calling the Read tool)/, false],
  ['compact_file_reference', /^Note: [^\n]+ was read before the last conversation was summarized/, false],
  ['hook_session_start', /^SessionStart(?::[^\n]*)? hook (?:additional context|success): /, 'always'],
  ['hook_context', /^[A-Za-z][\w.]*(?::[^\n]*)? hook (?:additional context|success|blocking error from command|stopped continuation)\b/, false],
  ['task_status', /^(?:Background (?:agent|shell|monitor) |Task )/, false],
  ['edited_file', /^Note: [^\n]+ changed on disk since you last read it/, false],
  ['nested_memory', /^Contents of [^\n]+:\n/, false],
  ['image_paths', /^The \d+ attached images?, in display order, are also saved at /, false],
  ['host_reminder', /^(?:The user hasn't heard from you in a while|The task tools haven't been used recently|The user included the keyword "ultrathink")/, false],
  ['host_reminder', /^(?:The user's message contains \/|## Exited Auto Mode|<total_tokens>|<tools-used-before-summary>)/, false],
];
const RESENT = new Set(HOST_ATTACHMENTS.filter(([, , again]) => again === true).map(([kind]) => kind));
const LIST_KINDS = new Set(HOST_ATTACHMENTS.filter(([, , again]) => again === 'list').map(([kind]) => kind));
const ALWAYS_RESENT = new Set(HOST_ATTACHMENTS.filter(([, , again]) => again === 'always').map(([kind]) => kind));
const SKILL_TEXT = /^Base directory for this skill: ([^\n]+)/m;
const skillNames = (t) => [...t.matchAll(/^### Skill: ([^\n]+)/gm)].map((x) => x[1].trim());
// The host shows a user text that opens with <system-reminder ...> in the API form with that first "<" as "&lt;": a block is compared with the rows after this is undone.
const unescapedOpener = (text) => (typeof text === 'string' ? text.replace(/^(\s*)&lt;(system-reminder\b)/, '$1<$2') : text);
// A text made only of envelopes of this module (carriedText: <system-reminder id="jev-N">).
function isOwnEnvelopes(text) {
  const found = envelopesOf(text);
  let at = 0;
  for (const e of found) {
    if (text.slice(at, e.from).trim() || !e.text.startsWith('<system-reminder id="jev-')) return false;
    at = e.to;
  }
  return found.length > 0 && !text.slice(at).trim();
}
// The kind of one reminder; a message delivered while a turn ran (deliveryOf) is no attachment (queuedOf carries it).
function attachmentKind(text) {
  const body = text.replace(/^\s*<system-reminder>\n/, '');
  for (const [kind, re] of HOST_ATTACHMENTS) if (re.test(body)) return kind;
  return deliveryOf(text) || deliveryOf(body) ? 'delivery' : 'other';
}
// The attachments in a text the rows do not show: each reminder, and with `rest` the text around them as one piece of kind `meta` (an isMeta message: the text of a
// skill, the continuation of a hook). `known`: the reminders a row's own text holds (the text of a result), taken off once each.
function attachmentPieces(text, known = [], rest = true) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const left = [...known];
  const out = [];
  const { reminders, rest: outside } = splitReminders(text);
  for (const m of reminders) {
    const at = left.indexOf(m);
    if (at >= 0) { left.splice(at, 1); continue; }
    const kind = attachmentKind(m);
    if (kind === 'delivery') continue;
    out.push(kind === 'invoked_skills' ? { kind, chars: m.length, names: skillNames(m) } : { kind, chars: m.length });
  }
  const around = rest ? outside : '';
  if (around.trim()) {
    const sk = SKILL_TEXT.exec(around);
    out.push(sk ? { kind: 'skill_text', chars: around.length, names: [sk[1].trim().replace(/\/+$/, '').split('/').pop()] } : { kind: 'meta', chars: around.length });
  }
  return out;
}
// The texts of a block an attachment's reminder may stand in: a text block, the content of a tool_result (a string, or its text blocks).
function blockTexts(b) {
  if (b.type === 'text') return [b.text];
  if (b.type !== 'tool_result') return [];
  if (typeof b.content === 'string') return [b.content];
  return Array.isArray(b.content) ? b.content.filter((x) => x && x.type === 'text').map((x) => x.text) : [];
}
const contentBlocks = (a) => (typeof a.content === 'string' ? [{ type: 'text', text: a.content }] : a.content.filter((b) => b && typeof b === 'object'));
// A user row of text the host can rebuild from its text alone (a row of the open loop, a row with an image, a /goal record cannot be).
const textRebuildable = (m, i, keepFrom, imageRows) => m.role === 'user' && !(m.toolResults || []).length && i < keepFrom
  && Boolean(rowText(m.text)) && !/\[Image #\d+\]/.test(m.text) && !GOAL_COMMAND.test(m.text) && !imageRows.has(i);
const resultRebuilt = (m) => m.role === 'user' && (m.toolResults || []).length > 0 && m.toolResults.every(textOnlyResult);
// The API form read turn by turn (the messages between two assistant messages) against the rows. Returns {rows (the rows that carry an advisor reminder), text (the
// user rows of text that are rebuilt without their handle: the rows of a turn that holds no image and no /goal record, advisor or not), blocks (advisor reminders
// found), blocked (a reason the compaction goes to the summary), dropped, back, coveredBack, resent (the characters of what goes, what comes back and what the host
// announces again)}; null without the API form.
function carrierRows(messages, api, keepFrom) {
  if (!Array.isArray(api) || !api.length) return null;
  const imageRows = nonTextUserRows(messages, api).rows;
  const rowOfResult = new Map();
  const rowOfUse = new Map();
  const textRows = new Map(); // rowText -> {rows: user rows with that text, ascending, at: the next one to take}
  const asstRows = new Map();
  const add = (list, t, i) => { const e = list.get(t); if (e) e.rows.push(i); else list.set(t, { rows: [i], at: 0 }); };
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      for (const r of m.toolResults || []) if (!rowOfResult.has(r.tool_use_id)) rowOfResult.set(r.tool_use_id, i);
      const t = rowText(m.text);
      if (t) add(textRows, t, i);
    } else if (m.role === 'assistant') {
      for (const u of m.toolUses || []) if (!rowOfUse.has(u.tool_use_id)) rowOfUse.set(u.tool_use_id, i);
      const t = rowText(m.text);
      if (t) add(asstRows, t, i);
    }
  });
  let cursor = 0;
  // The first row of `list` at or after the cursor and `lo`, before `hi`; rows are taken in order, so two rows with the same text are two turns.
  const next = (list, text, lo = 0, hi = Infinity) => {
    const e = list.get(text);
    if (!e) return undefined;
    const from = Math.max(cursor, lo);
    while (e.at < e.rows.length && e.rows[e.at] < from) e.at++;
    return e.at < e.rows.length && e.rows[e.at] < hi ? e.rows[e.at++] : undefined;
  };
  const out = {
    rows: new Set(), text: new Set(), blocks: 0, blocked: undefined,
    dropped: { n: 0, chars: 0, uncovered: 0, kinds: {}, charsByKind: {}, max: new Map(), skills: new Set() },
    back: { n: 0, chars: 0, kinds: new Set(), byKind: new Map() }, coveredBack: 0,
  };
  const block = (reason) => { if (!out.blocked) out.blocked = reason; };
  let seenAssistant = false;
  let headShown = false;
  let before; // the last row of the assistant message before the turn (undefined: none, or not placed)
  let stretch = [];
  const flush = (nextFirst) => {
    const st = stretch;
    stretch = [];
    const first = !seenAssistant;
    const msgs = st.map((a) => [a, contentBlocks(a)]);
    const blocks = [];
    const textAt = new Map(); // block -> the row its text shows
    const anchors = [];
    const lo0 = first ? 0 : before === undefined ? 0 : before + 1;
    const hi0 = nextFirst === undefined ? Infinity : nextFirst;
    for (const [, bs] of msgs) {
      for (const b of bs) {
        blocks.push(b);
        if (b.type === 'tool_result' && rowOfResult.has(b.tool_use_id)) anchors.push(rowOfResult.get(b.tool_use_id));
        else if (b.type === 'text' && typeof b.text === 'string') {
          const r = next(textRows, rowText(b.text), lo0, hi0) ?? next(textRows, rowText(unescapedOpener(b.text)), lo0, hi0);
          if (r !== undefined) { anchors.push(r); textAt.set(b, r); }
        }
      }
    }
    if (anchors.length) cursor = Math.max(cursor, Math.max(...anchors) + 1);
    if (first && anchors.includes(0)) headShown = true;
    const image = blocks.some((b) => b.type !== 'text' && b.type !== 'tool_result');
    const goal = blocks.some((b) => b.type === 'text' && typeof b.text === 'string' && GOAL_COMMAND.test(b.text));
    // The user rows of the turn stand between the rows of the assistant messages around it.
    let lo = first ? 0 : before === undefined ? undefined : before + 1;
    let hi = nextFirst;
    if (anchors.length) {
      const top = Math.max(...anchors);
      if (lo === undefined) { lo = top; while (lo > 0 && messages[lo - 1].role === 'user') lo--; }
      if (hi === undefined) { hi = top + 1; while (hi < messages.length && messages[hi].role === 'user') hi++; }
    }
    const known = lo !== undefined && hi !== undefined;
    let carrier;
    if (known) for (let k = Math.min(hi, messages.length) - 1; k >= lo; k--) if (messages[k].role === 'user') { carrier = k; break; }
    // The rows of text of the turn lose their handle unless a technical reason keeps it (an image or a /goal record in the turn).
    if (known && !goal && !image) for (let k = lo; k < Math.min(hi, messages.length); k++) if (textRebuildable(messages[k], k, keepFrom, imageRows)) out.text.add(k);
    const rebuilt = (k) => k !== undefined && (out.text.has(k) || resultRebuilt(messages[k]));
    // Every attachment of the turn stands in the carrier's group (no user row: the assistant row before the turn, rebuilt before keepFrom), also one the host folded
    // into the content of a result: it goes when the carrier is rebuilt and comes back with it otherwise.
    const goes = carrier !== undefined ? rebuilt(carrier) : known && !first && before !== undefined && before < keepFrom;
    const piece = (p, covered) => {
      if (goes) {
        out.dropped.n++;
        out.dropped.chars += p.chars;
        if (!covered) out.dropped.uncovered += p.chars;
        out.dropped.kinds[p.kind] = (out.dropped.kinds[p.kind] || 0) + 1;
        out.dropped.charsByKind[p.kind] = (out.dropped.charsByKind[p.kind] || 0) + p.chars;
        out.dropped.max.set(p.kind, Math.max(out.dropped.max.get(p.kind) || 0, p.chars));
        for (const name of p.names || []) out.dropped.skills.add(name);
      } else {
        out.back.n++;
        out.back.chars += p.chars;
        out.back.kinds.add(p.kind);
        out.back.byKind.set(p.kind, (out.back.byKind.get(p.kind) || 0) + p.chars);
        if (covered) out.coveredBack += p.chars;
      }
    };
    for (const [a, bs] of msgs) {
      let msgRow;
      for (const b of bs) if (b.type === 'tool_result' && rowOfResult.has(b.tool_use_id)) msgRow = Math.max(msgRow ?? -1, rowOfResult.get(b.tool_use_id));
      // A user message with results: its hidden text goes with its row in the count of `messages` (a rebuilt result row), so it is `covered`.
      const covered = a.role === 'user' && msgRow !== undefined && resultRebuilt(messages[msgRow]);
      for (const b of bs) {
        if (textAt.has(b)) continue;
        if (b.type === 'tool_result') {
          const r = rowOfResult.get(b.tool_use_id);
          if (r === undefined) continue;
          const own = messages[r].toolResults.find((x) => x.tool_use_id === b.tool_use_id)?.text || '';
          const shown = splitReminders(own).reminders;
          for (const t of blockTexts(b)) for (const p of attachmentPieces(t, shown, false)) piece(p, covered);
          continue;
        }
        if (b.type !== 'text' || typeof b.text !== 'string') continue;
        const t = unescapedOpener(b.text);
        if (isOwnEnvelopes(t)) continue;
        if (deliveryOf(t)) continue; // a delivered message is carried by queuedOf
        if (textRows.has(rowText(t)) || textRows.has(rowText(b.text))) continue; // a row's text the host shows in another turn
        for (const p of attachmentPieces(t)) piece(p, covered);
      }
    }
    // The advisor's reminder in the turn.
    let found = 0;
    for (const b of blocks) for (const t of blockTexts(b)) found += advisorNotes(t);
    if (!found) return;
    out.blocks += found;
    if (image) block('advisor_image');
    if (goal) block('advisor_command');
    if (!known) { block('advisor_no_row'); return; }
    if (carrier === undefined) {
      // No user row: the attachment stands behind the assistant message before the turn, which is rebuilt before keepFrom.
      if (first) block('advisor_no_row');
      else if (before >= keepFrom) block('advisor_in_tail');
      return;
    }
    const m = messages[carrier];
    if ((m.toolResults || []).length) { if (!m.toolResults.every(textOnlyResult)) block('advisor_image'); return; } // a result row of text is rebuilt anyway, the tail's too
    if (carrier >= keepFrom) { block('advisor_in_tail'); return; }
    const text = typeof m.text === 'string' ? m.text : '';
    if (!rowText(text) || /\[Image #\d+\]/.test(text)) { block('advisor_image'); return; }
    if (GOAL_COMMAND.test(text)) { block('advisor_command'); return; }
    out.rows.add(carrier);
  };
  for (const a of api) {
    if (!a || typeof a !== 'object' || !(Array.isArray(a.content) || typeof a.content === 'string')) continue;
    if (a.role !== 'assistant') { stretch.push(a); continue; }
    let lo;
    let hi;
    for (const b of contentBlocks(a)) if (b.type === 'tool_use' && rowOfUse.has(b.id)) { const r = rowOfUse.get(b.id); lo = Math.min(lo ?? r, r); hi = Math.max(hi ?? r, r); }
    if (lo === undefined) {
      for (const b of contentBlocks(a)) {
        if (b.type !== 'text' || typeof b.text !== 'string') continue;
        const r = next(asstRows, rowText(b.text));
        if (r !== undefined) { lo = hi = r; break; }
      }
    }
    if (!seenAssistant && lo === 0) headShown = true;
    flush(lo);
    before = hi;
    seenAssistant = true;
    if (hi !== undefined) cursor = Math.max(cursor, hi + 1);
  }
  flush(messages.length);
  // An API form the host cut (it keeps the last API_FORM_MAX messages) shows less than the conversation: told by a head the form does not show.
  if (!headShown && (api.length >= API_FORM_MAX / 2 || messages.length > API_FORM_MAX)) block('advisor_form_cut');
  // The host announces again a kind of RESENT none of whose attachments come back: about as long as the longest one taken off; of a list the entries the pieces that
  // come back do not hold; of ALWAYS_RESENT the longest taken off whatever comes back.
  out.resent = 0;
  for (const [k, n] of out.dropped.max) {
    if (ALWAYS_RESENT.has(k)) out.resent += n;
    else if (LIST_KINDS.has(k)) out.resent += Math.max(0, n - (out.back.byKind.get(k) || 0));
    else if (RESENT.has(k) && !out.back.kinds.has(k)) out.resent += n;
  }
  return out;
}
// The record fields of the attachments the rebuilt rows take off (tokens at RATE_ATT per character) and of those that come back with rows that keep their handle.
function hostAttachmentRecord(a, rates) {
  if (!a) return { attachments_dropped: null };
  const tok = (chars) => Math.round(rates.RATE_ATT * chars);
  return {
    advisor_blocks: a.blocks,
    attachments_dropped: a.dropped.n, attachments_dropped_tokens: tok(a.dropped.chars), attachments_kinds: a.dropped.kinds,
    attachments_kinds_tokens: Object.fromEntries(Object.entries(a.dropped.charsByKind).map(([k, c]) => [k, tok(c)])),
    attachments_skills: [...a.dropped.skills].slice(0, 50),
    attachments_back: a.back.n, attachments_back_tokens: tok(a.back.chars), attachments_back_from_results_tokens: tok(a.coveredBack),
    attachments_resent_tokens: tok(a.resent),
  };
}
// --- end of the host attachments ----------------------------------------------------------------------------------------------------------------

// --- owner tail (OMC_JEV_COMPACT_OWNER_TAIL=active) ----------------------------------------------------------------------------------------------
// The newest message of the user and the text of the answers after it (the text of the assistant rows, not their calls) stay word for word in any compaction, also at
// a turn boundary and for a plugin's request. What else comes after it (calls and results of tools, reports of agents, messages of other sessions, notifications) is
// compacted like the rest, and the open tool loop keeps its handles as ever. The protected rows (cfg.ownerProtected) are left out of the stages of pasted text,
// long replies, blocks and series; the agent stage leaves a row of the user and one that opens with a block of another session by its own rules. After the build
// ownerTailViolations checks that every protected text is still there: one that came out changed leaves the conversation as it was (a skip, so the host's summary
// does not run either).
// The user's message is a user row without results that holds words of the user's own (userWords) and that no hook or the host put in (isMeta, hookRowPrefixes). A
// message of another session is a row that opens with CROSS_SESSION_PREFIX: OMC_JEV_COMPACT_OWNER_TAIL_CROSS_SESSION `on` counts it like a message of the user (the
// boundary is the newest of both kinds), `off` ignores it, `fallback` (the default) takes the user's row as the first boundary and the newest message of another
// session after it as the next one, tried when the protected text is too large.
const CROSS_SESSION_PREFIX = '<cross-session-message';
export const OWNER_TAIL_SKIP = 'jev-compaction-owner-tail:'; // opens the text of this skip; ownThreshold tells it from OWN_SKIP_PREFIX
const crossSessionMode = (raw) => {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'on' || v === 'off' ? v : 'fallback';
};
const isCrossSessionRow = (m) => m.role === 'user' && !(m.toolResults || []).length && typeof m.text === 'string' && m.text.trimStart().startsWith(CROSS_SESSION_PREFIX);
// While the blocks act, a row that is only a moved block or the header of the trace files holds no words of the user (as in ownerRows).
const isOwnerWords = (m, cfg) => m.role === 'user' && !(m.toolResults || []).length && typeof m.text === 'string' && m.isMeta !== true
  && !cfg.hookRowPrefixes.some((p) => m.text.trimStart().startsWith(p)) && userWords(m, notUserOf(cfg.blockTraces)).length > 0;
export const isOwnerTailRow = (m, cfg) => isOwnerWords(m, cfg) || (cfg.ownerTailCrossSession === 'on' && isCrossSessionRow(m));

/** The boundaries a compaction tries, the one with the most protected text first: the newest row of the user (with `on`, of the user or another session), then with `fallback` the newest message of another session after it. */
export function ownerTailTiers(messages, cfg) {
  const tiers = [];
  const owner = messages.findLastIndex((m) => isOwnerTailRow(m, cfg));
  if (owner >= 0) tiers.push(owner);
  if (cfg.ownerTailCrossSession === 'fallback') {
    const cross = messages.findLastIndex(isCrossSessionRow);
    if (cross > owner) tiers.push(cross);
  }
  return tiers;
}

/** What is protected from the boundary row `from`: that row and every assistant row with text after it. */
export function ownerTailProtected(messages, from) {
  const rows = [from];
  for (let i = from + 1; i < messages.length; i++) if (messages[i].role === 'assistant' && typeof messages[i].text === 'string' && messages[i].text.trim()) rows.push(i);
  return { rows, user: messages[from].text, texts: rows.slice(1).map((i) => messages[i].text) };
}

/**
 * The check of the built list before anything goes to the host: the protected message opens the text of a user row, and every protected text of the assistant stands in
 * the text of the assistant rows, in order (build joins the rows of one message with a newline and may put the traces of its calls after its text). One name per
 * protected element that is gone: `owner_text`, `assistant_text`.
 */
export function ownerTailViolations(built, prot) {
  const bad = [];
  if (!built.some((m) => m.role === 'user' && !(m.toolResults || []).length && typeof m.text === 'string' && m.text.startsWith(prot.user))) bad.push('owner_text');
  const joined = built.filter((m) => m.role === 'assistant' && typeof m.text === 'string' && m.text).map((m) => m.text).join('\n');
  let at = 0;
  for (const text of prot.texts) {
    const found = joined.indexOf(text, at);
    if (found < 0) bad.push('assistant_text');
    else at = found + text.length;
  }
  return bad;
}

// The reads of the host and the window, made before the stages are planned: the bound of the protected text needs them, and they are used again instead of new ones.
async function ownerTailReads($, cfg, deadline) {
  const detail = await hostValue($, () => $.session.usage({ breakdown: 'summary' }), deadline);
  const usage = await hostValue($, () => $.session.usage(), deadline);
  return { detail, usage, win: await resolveWindow($, cfg, detail, usage, deadline) };
}

// The boundary of one compaction: the first of the tiers (from cfg.ownerTailDemote on) whose protected text with the fixed prefix stays under `bound`, the threshold of
// the host less FLOOR_MARGIN of the window (without a window the first tier is taken). None fitting is an overflow: no protection, or with `keep` the last tier while it
// stays under the threshold (`kept`: the gates that hand a floor over the bound to the host's summary are then off, as the summary would take the text too). In the main
// loop a boundary at the first row protects nothing (the whole conversation would be protected); in a subagent, with the option, the prompt of its parent counts.
// Returns {tail (for the record), kept} and, with protection, {prot, rows (the protected rows), fixed (the prefix with the protected text), tier}.
function ownerTailPlan(cfg, messages, main, win, prefix) {
  const tiers = main || cfg.ownerTailAgents ? ownerTailTiers(messages, cfg) : [];
  const usable = tiers.filter((from) => from > 0 || !main);
  const tokensOf = (prot) => Math.round(listTokens(rowsAsApi(prot.rows.map((i) => ({ role: messages[i].role, text: messages[i].text }))), cfg.rates));
  const prots = usable.map((from) => ownerTailProtected(messages, from));
  const sizes = prots.map(tokensOf);
  const bound = win ? win.threshold - FLOOR_MARGIN * win.window : Infinity;
  let pick;
  for (let i = cfg.ownerTailDemote ?? 0; i < usable.length && pick === undefined; i++) if (prefix + sizes[i] <= bound) pick = i;
  const overflow = usable.length > 0 && pick === undefined;
  let kept = false;
  if (overflow && cfg.ownerTailOverflow === 'keep' && win && prefix + sizes[usable.length - 1] <= win.threshold) { pick = usable.length - 1; kept = true; }
  const shown = pick !== undefined ? usable[pick] : tiers[0];
  const shownProt = pick !== undefined ? prots[pick] : shown === undefined ? undefined : ownerTailProtected(messages, shown);
  const tail = {
    from_idx: shown ?? null, rows: shown === undefined ? 0 : messages.length - shown, tokens: shownProt === undefined ? 0 : pick !== undefined ? sizes[pick] : tokensOf(shownProt),
    violations: 0, goal_yielded: false, overflow, boundary: pick === undefined ? 'old' : isOwnerWords(messages[shown], cfg) ? 'owner' : 'cross_session',
    protected_rows: shownProt === undefined ? 0 : shownProt.rows.length,
  };
  if (pick === undefined) return { tail, kept };
  return { tail, kept, prot: prots[pick], rows: new Set(prots[pick].rows), fixed: prefix + sizes[pick], tier: pick };
}

// The protected rows of the main loop for a plan made outside decide (the pass that fills the verdicts, the estimate of the own threshold), taken as decide takes
// them, so that no block of a protected row is asked about and no stage counts one. `early` is what ownerTailReads returned (none without the token cascade).
function ownerProtectedCfg(cfg, messages, early) {
  if (!cfg.ownerTail || !Array.isArray(messages)) return cfg;
  const plan = ownerTailPlan(cfg, messages, true, early?.win, early ? prefixTokens(early.detail) : 0);
  return plan.rows ? { ...cfg, ownerProtected: plan.rows } : cfg;
}
// --- end of the owner tail ----------------------------------------------------------------------------------------------------------------------

async function decide($, e, cfg, record, started) {
  if (cfg.jevUsage) cfg = { ...cfg, usageRecord: record }; // every request of this decision adds to its record
  const messages = Array.isArray(e.messages) ? e.messages : [];
  let before = messages.reduce((s, m) => s + messageChars(m), 0);
  record.chars_before = before;
  const deadline = started + TOTAL_MS;
  if (messages.length <= (cfg.tailByLoop ? 2 : KEEP_LAST + 1)) return { fallback: 'too_few_messages' };
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
  // The thinking of the assistant messages in the API form, in tokens: all of it (what a list estimate adds) and that of the rows before keepFrom, which build rebuilds
  // without it (what the predictions take off). The record says what the API form holds and how much of it sits on a row, with the token cascade or the token accounting.
  const tokenMode = cfg.targetPercent !== undefined || cfg.tokenAccounting;
  const sigs = signatureRows(messages, api);
  if (tokenMode) Object.assign(record, { api_messages: sigs.ok, sig_chars_total: sigs.total, sig_chars_mapped: sigs.mapped });
  let rebuiltSig = 0;
  for (const [row, chars] of sigs.rowSig) if (row >= 1 && row < keepFrom) rebuiltSig += chars;
  const thinking = { all: RATE_SIG * sigs.total, removed: RATE_SIG * rebuiltSig };
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
  // Host attachments: the user rows of text that are rebuilt without their handle, the carriers of the advisor among them; a carrier that cannot be rebuilt without a
  // loss hands the compaction to the summary.
  const hostAtt = cfg.hostAttachments ? carrierRows(messages, api, keepFrom) : null;
  if (cfg.hostAttachments) {
    Object.assign(record, hostAttachmentRecord(hostAtt, cfg.rates));
    if (hostAtt?.blocked) return { fallback: hostAtt.blocked };
  }
  const dropRows = hostAtt ? new Set([...hostAtt.text, ...hostAtt.rows]) : undefined;
  // The attachments of the rebuilt rows go (those of result rows are not counted: the host's count holds them either way); the host announces again what then lacks.
  const attachTokens = hostAtt ? cfg.rates.RATE_ATT * (hostAtt.dropped.uncovered - hostAtt.resent - hostAtt.coveredBack) : 0;
  // Results of the calls that keep their handles stay whole (a built row may not stand among them).
  // With the tail by the open loop every row is looked at; the filter below leaves the loop out.
  const candidates = findCandidates(messages, cfg.privatePaths, cfg.notifications, { blockTraces: cfg.blockTraces, tailFrom: cfg.tailByLoop ? messages.length : undefined }).filter((c) => (c.note ? c.resIdx : c.useIdx) < keepFrom);
  record.candidates = candidates.length;
  // Archive: the planned path goes into every trace and cut before the floor and the cascade count their lengths (active only).
  const archMode = archiveModeIn(cfg, record);
  if (archMode === 'active') for (const c of candidates) { const path = archivePlannedPath(cfg, record.session_id, c); if (path) { c.archivePath = path; archiveCosts(c); } }
  if (cfg.notifications) record.notifications = candidates.filter((c) => c.note).length;
  const envelopes = envelopeChars(messages, queued, candidates, dropRows);
  const removable = removableChars(candidates);
  // The envelopes build adds stay in every rebuilt row, so they come off what the results can give back.
  const net = removable - envelopes;
  // The envelopes are text the installed rows hold and the host's count does not: the predictions start from the count plus them.
  const envelopeTokens = cfg.rates.RATE_NOTE * envelopes;
  // Owner tail: the protected rows are known before the stages are planned, so with the token cascade the host reads and the window come first.
  let ownerPlan;
  let early;
  if (cfg.ownerTail) {
    if (cfg.targetPercent !== undefined) early = await ownerTailReads($, cfg, deadline);
    let win = early?.win;
    if (win && e.trigger === 'auto' && e.agentId !== undefined) { // a subagent's window follows its estimate, as in the cascade below
      const estimate = tokensBeforeOf(e, cfg, messages, api, early.detail, early.usage, thinking).tokens;
      if (estimate < win.threshold) win = { window: Math.min(win.window, Math.round(estimate) + HOST_BUFFER), threshold: Math.max(1, Math.round(estimate)) };
    }
    ownerPlan = ownerTailPlan(cfg, messages, e.agentId === undefined, win, early ? prefixTokens(early.detail) : 0);
    Object.assign(record, { owner_tail: ownerPlan.tail, owner_tail_applied: Boolean(ownerPlan.prot) });
    if (ownerPlan.prot) {
      record.owner_tail_tier = ownerPlan.tier;
      cfg = { ...cfg, ownerProtected: ownerPlan.rows };
    }
  }
  // Agent trim: the host's frame of agents' messages and idle notifications out of the rows before the tail; lossless for the work, so before the floor and
  // the cascade, and its tokens come off the prediction (the cascade's target is the rule's target, a share of the window).
  // Verdicts of Jev on blocks of text (OMC_JEV_COMPACT_BLOCKS): off without the API form, a state directory or a session; `shadow` also while the point itself is not active. They ask
  // only while the point is active and OMC_JEV_COMPACT_VERDICTS is not off. With OMC_JEV_COMPACT_JEV_STAGES=active the verdicts that run (active) decide what the paste and reply stages
  // and the agent messages to files decide by fixed lengths: those do not run (the agent trim stays).
  const blocksMode = cfg.blocks !== 'off' && api && cfg.pasteDir && record.session_id ? (cfg.blocks === 'active' && cfg.mode !== 'active' ? 'shadow' : cfg.blocks) : 'off';
  const blockOn = blocksMode !== 'off' && cfg.verdicts !== 'off' && cfg.mode === 'active';
  const jevStagesOn = cfg.jevStages && blocksMode === 'active' && blockOn;
  if (cfg.jevStages && cfg.blocks !== 'off') record.jev_stages = { applied: jevStagesOn };
  if (jevStagesOn) cfg = { ...cfg, pastes: 'off', replies: 'off' };
  const stageRead = agentStageOf($, cfg, e.agentId, messages, api, queued, keepFrom, record.session_id, deadline, takeAgentChecks(record.session_id, cfg));
  const stage = jevStagesOn ? { ...stageRead, opts: undefined } : stageRead;
  if (stage.stats) record.agent_trim = stage.stats;
  const { trimmed, trimTokens, opts: agentOpts, plan: planAgents } = stage;
  // The blocks of the rows before the tail: a plan, nothing is asked or written yet.
  let blockPlan;
  if (blocksMode !== 'off') {
    try { blockPlan = planBlocks(cfg, messages, trimmed, api, queued, keepFrom, record.session_id, e.agentId !== undefined); } catch { record.blocks = { error: 1 }; }
  }
  // What the blocks may give back (every one at level 0): counted by the floor and the gate below only while the verdicts are applied.
  const blocksPotential = blockPlan && blocksMode === 'active' && blockOn ? blockPlan.potential : 0;
  // The series of traces count in the floor like the blocks: what merging them gives back (the same switch, the same gate).
  let seriesPlan;
  let seriesPotential = 0;
  if (blocksMode !== 'off') {
    try {
      seriesPlan = planSeries(cfg, messages, trimmed, api, queued, keepFrom, record.session_id, e.agentId !== undefined, deadline);
      if (blocksMode === 'active' && blockOn) seriesPotential = seriesPlan.potential();
    } catch { seriesPlan = undefined; }
  }
  // The blocks and messages that the keep decisions take off the list, which the predictions in tokens count with the costs of the candidates (shapeOf).
  const shapeFrom = (rows) => (tokenMode ? shapeOf(messages, candidates, { rows, group, keepFrom, queued, rates: cfg.rates }) : undefined);
  let shape = shapeFrom(trimmed);
  const movedTokens = (st) => movedTokensOf(st, cfg.rates);
  record.max_reduction = before ? Math.round((net / before) * 1000) / 1000 : 0;
  if (!before || net / before < MIN_REDUCTION) {
    // The characters leave out what costs tokens without being text (an image). With the token cascade a session that fails them goes on when its tokens
    // reach the same bound (the floor below is the check that follows the tokens); without it the gate is the characters alone.
    // The text the agent stage takes off (the trim, and with the stage active the reports it moves to files) is part of the cut: a session of reports that no
    // result of its own would carry is for the plan below, which counts the stage, and not for the summary.
    const stageTokens = cfg.targetPercent === undefined ? 0 : (await agentStageTokens(cfg, stage)) + blocksPotential + seriesPotential;
    const cut = cfg.targetPercent === undefined ? undefined : cutInTokens(candidates, messages, api, envelopes, cfg.rates, stageTokens, shape);
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
  let blocksFloor = 0;
  let known;
  if (cfg.targetPercent !== undefined) {
    // The host reads are made once, within the compaction's deadline, and the token accounting below uses them again.
    const detail = early ? early.detail : await hostValue($, () => $.session.usage({ breakdown: 'summary' }), deadline);
    const usage = early ? early.usage : await hostValue($, () => $.session.usage(), deadline);
    known = { detail, usage };
    let win = early ? early.win : await resolveWindow($, cfg, detail, usage, deadline);
    if (!win) return { fallback: 'no_window' };
    tokens = tokensBeforeOf(e, cfg, messages, api, detail, usage, thinking);
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
    let raw = Math.floor(TARGET_UNCALIBRATED * usualTarget(win, cfg.targetPercent));
    ruleTarget = ruleTargetOf(win, cfg);
    // Owner tail: nothing can come below the prefix with the protected text, so a goal under it goes up to it.
    if (ownerPlan?.fixed > ruleTarget) { ruleTarget = ownerPlan.fixed; raw = Math.max(raw, ownerPlan.fixed); ownerPlan.tail.goal_yielded = true; }
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
      // every block at level 0 (no verdict yet) and every series merged, held to the same bound after the cascade
      if (blocksPotential || seriesPotential) {
        blocksFloor = blocksPotential + seriesPotential;
        if (blocksPotential) record.floor_blocks_tokens = Math.round(blocksPotential);
        if (seriesPotential) record.floor_series_tokens = Math.round(seriesPotential);
      }
      const floor = floorPrediction(candidates, tokens.tokens - trimTokens - agentsFloor - blocksFloor - attachTokens + envelopeTokens - thinking.removed, cfg.rates, shape);
      record.floor_pred = Math.max(0, Math.round(floor));
      if (!ownerPlan?.kept && floor > win.threshold - FLOOR_MARGIN * win.window) return { fallback: 'floor_above_threshold' };
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
  // The questions about the blocks go out next to the scoring requests (the verdict files are read when none is asked: shadow, the verdicts off, a point that is not active).
  let blocksAsk;
  let blockUser = user;
  if (blockPlan) {
    blockUser = cfg.fullInput ? userTask(messages, typeof e.instructions === 'string' && e.instructions.trim() ? e.instructions : undefined, queued, cfg.privatePaths, cfg.notUserPrefixes, ownerLimitsOf(cfg)) : user;
    const prefix = known?.detail ? prefixTokens(known.detail) : 0;
    const extra = blockSignals(cfg.rates, tokens ? tokens.tokens : prefix + listTokens(api, cfg.rates), blockPlan.items, prefix, ruleTarget ?? null);
    blocksAsk = blockOn
      ? ensureBlockVerdicts($, cfg, blockPlan, { user: blockUser, deadline, requestMs: REQUEST_MS, extra })
      : readBlockVerdicts($, cfg, record.session_id, blockPlan.items.map((it) => it.key), deadline).then((known0) => { for (const [key, v] of known0) blockPlan.verdicts.set(key, v); return { known: known0.size }; }, () => ({ error: 1 }));
  }
  const [results, , blockAsked] = await Promise.all([Promise.all(runs), pasted?.asks, blocksAsk]);
  record.jev_ms = results.map((r) => r.ms);
  if (cfg.jevUsage) {
    // The scoring entries first, parallel to jev_ms, then those of the other requests in the order in which they ended.
    record.jev_usage = [...results.map((r) => jevUsageOf(r.value)), ...(record.jev_usage ?? [])];
    record.cost_basis = results.some((r) => costBasisOf(jevMetaOf(r.value)?.raw) === 'reported') ? 'reported' : (record.cost_basis ?? 'unknown');
  }
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
  let rows = agentMoved.size ? trimmed.map((m, i) => agentMoved.get(i) ?? m) : trimmed;
  let blockEdits = new Map();
  let blockSaved = 0;
  let seriesEdits = new Map(); // the text of the rows in which series were merged
  let seriesSaved = 0;
  const currentRows = () => rows.map((m, i) => (seriesEdits.has(i) ? { ...m, text: seriesEdits.get(i) } : blockEdits.get(i) ?? m));
  // The header of the files the traces of blocks name stands in the first row of the result whenever the result holds such a trace (the header of an earlier compaction is replaced by it).
  const holdsBlockTrace = (m) => typeof m.text === 'string' && (m.text.includes(BLOCK_TRACE_PREFIX) || m.text.includes(`${AGENT_TRACE_PREFIX}${BLOCK_LETTER}/`));
  const headerOf = () => (blocksMode === 'active' && blockPlan && currentRows().some(holdsBlockTrace) ? traceHeader(blockDir(cfg, record.session_id)) : undefined);
  const headerTokens = () => {
    const header = headerOf();
    return header === undefined ? 0 : cfg.rates.RATE_TRACE * (header.length - messages.filter(isHeaderRow).reduce((n, m) => n + m.text.length, 0));
  };
  // A row another stage changes is not carried out a second time by the blocks: the rows the agent messages moved, and, with a token target, the ones the reply and paste stages move.
  const moveBlockRows = async (hold) => {
    if (!blockPlan) return;
    const moved = await moveBlocks($, cfg, blockPlan, deadline, blocksMode, hold);
    record.blocks = { mode: blocksMode, ...blockPlan.stats, verdicts: blockAsked, ...moved.stats, installed: false };
    if (moved.edits.size) { blockEdits = moved.edits; blockSaved = blockSavedTokens(moved.stats, cfg.rates); }
  };
  if (cfg.targetPercent === undefined) {
    allocate(candidates, before, cfg.target, envelopes);
    await moveBlockRows(new Set([...agentMoved.keys(), ...(pasted ? pasted.jobs.filter((j) => j.yes).map((j) => j.row) : [])]));
  } else {
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
      if (pasteSwaps.size) {
        stageTokens += movedTokens(pasted.stats);
        // The words of the user in a message are counted from the rows the stage leaves (a tag moved is a trace, no words), as the tokens it moved are off the base.
        rows = rows.map((m, i) => (pasteSwaps.has(messages[i]) ? pasteSwaps.get(messages[i]) : m));
        shape = shapeFrom(rows);
      }
    }
    const blockHold = new Set([...agentMoved.keys(), ...(replyEdits ? replyEdits.keys() : []), ...messages.flatMap((m, i) => (pasteSwaps?.has(m) ? [i] : []))]);
    await moveBlockRows(blockHold);
    stageTokens += blockSaved;
    let base = tokens.tokens - trimTokens - agentTokens - stageTokens - attachTokens + envelopeTokens - thinking.removed + headerTokens();
    let plan;
    if (blocksMode === 'active' && blockOn) {
      // The second round (OMC_JEV_COMPACT_BLOCKS=active): the first pass (or the scores alone, for a manual compaction) comes first, and a prediction still above the target goes to the
      // round that lowers the results and the blocks in Jev's order; the cascade then goes on as the reserve (the passes after the second one, from the state the round left).
      const first = manual ? manualPlan(candidates, base, cfg.rates, shape) : cascade(candidates, base, target, cfg.rates, shape, { stopAfterA: true });
      plan = first;
      if (first.predicted > target) {
        // The series of traces on the rows the blocks left (their traces may stand beside the old ones now): Jev rates them with the question of the round, then they stand in the queue
        // with the results and the blocks. The rows another stage changes stay out (blockHold), as for the blocks.
        const seriesCtx = seriesPlan?.ctx && !seriesPlan.ctx.reason ? seriesContext(cfg, messages, api, keepFrom, queued) : undefined;
        let seriesRated = { entries: [], stats: { items: 0, secret: 0, unchecked: 0, timed_out: 0 } };
        if (seriesCtx && !seriesCtx.reason) {
          for (const r of blockHold) seriesCtx.fixed.add(r);
          seriesRated = seriesEntries(cfg, seriesItems(cfg, currentRows(), seriesCtx, record.session_id, e.agentId !== undefined), seriesPlan.check);
          if (seriesRated.entries.length) await askTie($, cfg, seriesRated.entries, { user: blockUser, goal: target, restNeed: first.predicted - target, deadline, rateOnly: true });
        }
        const seriesAnswered = seriesRated.entries.filter((x) => typeof x.score === 'number');
        const out = await reduceToLimit({
          entries: [...resultEntries(candidates, cfg.rates, shape), ...(blockPlan ? blockEntries(cfg, blockPlan, blockHold) : []), ...seriesAnswered], pred: first.predicted, goal: target, deadline,
          askTie: (group, restNeed) => askTie($, cfg, group, { user: blockUser, goal: target, restNeed, deadline }),
        });
        let executed = 0;
        const seriesKeys = new Set();
        for (const x of out.lowered) {
          if (x.kind === 'result') x.c.keep = x.to;
          else if (x.kind === 'series') seriesKeys.add(x.item.key);
          else for (const [key, v] of x.patch) blockPlan.verdicts.set(key, v);
        }
        // The blocks that came down are carried out again with their new levels (the files that exist are reused): what they take off the prediction comes off the base.
        if (out.lowered.some((x) => x.kind === 'block')) {
          const savedBefore = blockSaved;
          const headerBefore = headerTokens();
          await moveBlockRows(blockHold);
          executed = blockSaved - savedBefore;
          base += headerTokens() - headerBefore - executed;
        }
        // The series that came down are merged on the rows as they stand now (after the blocks were carried out again): one line and a file, the tokens come off the base.
        if (seriesKeys.size) {
          const headerBefore = headerTokens();
          seriesEdits = await mergeSeries($, cfg, record, currentRows(), seriesCtx, seriesKeys, record.session_id, deadline, seriesPlan.check);
          if (seriesEdits.size) {
            seriesSaved = record.series.tokens_before - record.series.tokens_after;
            base += headerTokens() - headerBefore - seriesSaved;
          }
        }
        const afterRound = cascade(candidates, base, Infinity, cfg.rates, shape, { resume: true }).predicted;
        plan = cascade(candidates, base, target, cfg.rates, shape, { resume: true });
        const reserve = Math.max(0, afterRound - plan.predicted);
        plan.pass = reserve > 0 ? plan.pass : out.lowered.length ? 'F2' : first.pass;
        if (reserve > 0 && out.f2.reason === 'goal_reached') out.f2.reason = 'reserve';
        record.f2 = { mode: 'active', ...out.f2, pass_a: first.pass, predicted_after_a: first.predicted, predicted_after_f2: afterRound, reserve: { tokens: reserve, pass: reserve > 0 ? plan.pass : null }, executed_blocks_tokens: Math.round(executed), series_question: { ...seriesRated.stats, answered: seriesAnswered.length } };
      } else record.f2 = { mode: 'active', goal_tokens: Math.round(target), predicted_before: first.predicted, to_remove_tokens: 0, reason: 'below_goal', pass_a: first.pass };
    } else if (manual) {
      plan = manualPlan(candidates, base, cfg.rates, shape);
      if (plan.predicted > target) plan = cascade(candidates, base, target, cfg.rates, shape);
    } else plan = cascade(candidates, base, target, cfg.rates, shape);
    if (blocksMode === 'shadow') record.f2 = { mode: 'shadow', candidates: { result: candidates.filter((c) => c.answered && !isForced(c) && !isPinned(c, cfg.rates, shape)).length, block: blockPlan ? [...blockPlan.verdicts.values()].filter((v) => v.level >= 2).length : 0, series: seriesPlan ? seriesPlan.items.length : 0 } };
    Object.assign(record, { cut: plan.pass === 'manual' ? 'manual_scores' : 'cascade', cascade_pass: plan.pass, cascade_target_tokens: target, cascade_predicted_tokens: plan.predicted, tokens_after_pred: plan.predicted, cascade_tokens_source: tokens.source, cascade_dropped: candidates.filter((c) => c.keep === 'drop').length });
    // Host handoff: a manual or automatic compaction that removes less than HOST_MIN_CUT of the tokens is left to the host's summary (the record
    // keeps the numbers). The module's own requests and other mods' plugin compactions are not handled here.
    // The files were planned to spare the host's summary (the floor counted them): when the writes fell short and the plan still ends above the bound the
    // floor is held to, the summary runs.
    if ((agentsFloor > 0 || blocksFloor > 0) && !ownerPlan?.kept && plan.predicted > record.threshold - FLOOR_MARGIN * record.window) { record.floor_after_agents = plan.predicted; return { fallback: 'text_above_threshold' }; }
    // With protected text the small cut is made: the host's summary would take that text.
    if (cfg.handoff && !ownerPlan?.prot && plan.predicted > (1 - HOST_MIN_CUT) * tokens.tokens && (e.trigger === 'manual' || e.trigger === 'auto')) return { fallback: 'cut_below_host_min' };
    // The module's own request (`$.session.compact()` of ownThreshold, trigger `plugin`) that would stay under HOST_MIN_CUT is rejected, not handed over:
    // the host's summary is what it replaces, and nothing forces a compaction yet. compact() answers it with a skip. A `plugin` compaction asked by
    // another mod is not ours to veto.
    if (cfg.ownSkip && plan.predicted > (1 - HOST_MIN_CUT) * tokens.tokens && e.trigger === 'plugin' && session.ownCompactInFlight) return { fallback: 'cut_below_host_min_skipped', skip: true, tokensBefore: tokens.tokens };
  }
  const stats = {};
  if (blockEdits.size) rows = rows.map((m, i) => blockEdits.get(i) ?? m);
  if (seriesEdits.size) rows = rows.map((m, i) => (seriesEdits.has(i) ? { ...m, text: seriesEdits.get(i) } : m));
  // What the text stages moved is marked installed (`installed` of their stats) only once the result is certain, at the end: a fallback after the files were
  // written (the cascade's checks above, a build that fails) returns the host's summary, which holds none of it.
  let pastesInstalled = false;
  let repliesInstalled = false;
  if (pasted) {
    const swaps = pasteSwaps ?? (await movePastes($, pasted.stats.mode, pasted.jobs, messages, pasted.stats, deadline).catch(() => { pasted.stats.error = 1; return new Map(); }));
    if (swaps.size) {
      rows = rows.map((m, i) => (swaps.has(messages[i]) ? swaps.get(messages[i]) : m));
      pastesInstalled = true;
      if (!pasteSwaps) shape = shapeFrom(rows); // no cascade ran: the accounting reads the rows the stage left
    }
  }
  const header = headerOf();
  if (header !== undefined) rows = rows.map((m) => (isHeaderRow(m) ? { ...m, trimDrop: true } : m));
  if (archMode !== 'off') await archiveStep($, cfg, record, archMode, candidates, rows, keepFrom, group, queued, started);
  let built = build(rows, candidates, keepFrom, group, stats, queued, dropRows);
  if (!pairingOk(messages, built)) return { fallback: 'build_error' };
  if (cfg.replies !== 'off' && e.agentId === undefined) {
    const edited = replyEdits ?? (await moveReplies($, cfg, record, messages, api, keepFrom, deadline, queued));
    if (edited.size) {
      built = build(rows.map((m, i) => (edited.has(i) ? { ...m, text: edited.get(i) } : m)), candidates, keepFrom, group, stats, queued, dropRows);
      repliesInstalled = true;
    }
  }
  if (header !== undefined) built.unshift({ role: 'user', text: header, toolUses: [], toolResults: [] });
  // Owner tail: a protected text that is gone, whatever stage made it, leaves the conversation as it was; the record names the element, not its text.
  if (ownerPlan?.prot) {
    const bad = ownerTailViolations(built, ownerPlan.prot);
    ownerPlan.tail.violations = bad.length;
    if (bad.length) {
      record.owner_tail_violations = bad.slice(0, 10);
      return { fallback: 'owner_tail_changed', skip: true, skipText: `${OWNER_TAIL_SKIP} a protected text came out changed, nothing replaced`, tokensBefore: tokens?.tokens };
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
    ...(tokenMode ? { rebuilt_thinking: stats.rebuiltAssistant } : {}), // the rows rebuilt without their thinking: the count of rebuilt_assistant
    dropped_assistant: stats.droppedAssistant,
    joined_rows: stats.joinedRows,
    queued_carried: stats.queuedCarried,
    ...(cfg.hostAttachments ? { rebuilt_user: stats.rebuiltUser } : {}),
    score_hist: hist,
    unanswered: asked.length - answered,
  });
  // What the installed text stages took off, with or without the cascade: a stage that moved nothing (shadow, writes that failed, or a fallback) counts for nothing.
  const installedTokens = trimTokens + agentTokens + attachTokens - envelopeTokens + (repliesInstalled ? movedTokens(record.replies) : 0)
    + (pastesInstalled ? movedTokens(pasted.stats) : 0) + blockSaved + seriesSaved;
  if (cfg.tokenAccounting) Object.assign(record, await tokenAccounting($, e, cfg, messages, api, candidates, installedTokens, deadline, known, shape, thinking));
  if (agentMoved.size) record.agent_messages.installed = true;
  if (pastesInstalled) pasted.stats.installed = true;
  if (repliesInstalled) record.replies.installed = true;
  if (blockEdits.size) record.blocks.installed = true;
  if (seriesEdits.size) record.series.installed = true;
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
    const initial = { ...record }; // the record a repeated decision starts from
    const abandoned = []; // the usage of the requests of the decisions that were repeated
    let reported = false;
    try {
      decision = await decide($, e, cfg, record, started);
      // Owner tail: the floor or the plan with the protected text (nothing of it can be lowered) is over the bound of the host. The compaction is decided again with the
      // next boundary, down to the overflow (no protection, or with `keep` the text kept and the gates off), instead of going to the host's summary, which takes the text too.
      for (let again = 0; again < 3 && (decision.fallback === 'floor_above_threshold' || decision.fallback === 'text_above_threshold') && record.owner_tail_applied === true && !record.owner_tail.overflow; again++) {
        const demote = record.owner_tail_tier + 1;
        if (record.jev_usage) {
          abandoned.push(...record.jev_usage.map((entry) => ({ ...entry, abandoned: true })));
          reported ||= record.cost_basis === 'reported';
        }
        for (const key of Object.keys(record)) delete record[key];
        Object.assign(record, initial);
        decision = await decide($, e, { ...cfg, ownerTailDemote: demote }, record, started);
      }
    } catch (error) {
      decision = { fallback: 'exception' };
      record.error = clip(oneLine(maskSecrets(String(error?.message ?? error))), 200);
    }
    // Every request sent keeps its entry: those of the repeated decisions follow, marked `abandoned`.
    if (abandoned.length) {
      record.jev_usage = [...(record.jev_usage ?? []), ...abandoned];
      record.cost_basis = reported ? 'reported' : (record.cost_basis ?? 'unknown');
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
      return { skip: decision.skipText ?? `${OWN_SKIP_PREFIX} cut under ${Math.round(HOST_MIN_CUT * 100)} % of the tokens, nothing replaced` };
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
    // The verdicts of the blocks of text that lived a turn, in the background and never awaited (the pass never rejects); the configuration is the one an earlier turn read.
    if (session.cachedConfig && session.cachedConfig.blocks !== 'off') void backgroundBlockVerdicts($, session.cachedConfig);
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
    const candidates = findCandidates(messages, cfg.privatePaths, cfg.notifications, { blockTraces: cfg.blockTraces, tailFrom: cfg.tailByLoop ? openLoopStart(messages, groupsOf(messages, undefined)) : undefined });
    // The blocks and messages that the cuts take off the list count with the costs of the candidates, as in decide (shapeOf), from the API form once it is read.
    const shapeIn = (apiForm, rows) => {
      const group = groupsOf(messages, apiForm);
      return shapeOf(messages, candidates, { group, keepFrom: openLoopStart(messages, group), queued: rows, rates: cfg.rates });
    };
    let shape; // with the token cascade, built once the API form is read: the deliveries are part of the shape, and no token measure is taken before it
    let removable = removableChars(candidates);
    let envelopes = 0;
    let api;
    // What the agent stage takes off counts as a cut too, as in decide (the cascade only: the stage's plan is part of the cascade's prediction).
    let stageTokens = 0;
    const blocksCount = cfg.blocks === 'active' && cfg.verdicts !== 'off' && Boolean(cfg.pasteDir); // the verdicts on blocks of text take text off too (the point is active here); without the state directory (blocksMode) nothing can be written
    const stageCounts = cfg.targetPercent !== undefined && (cfg.agentTrim || blocksCount);
    // With the token cascade a session that fails the characters is measured in tokens (cutInTokens): an image has no characters and costs thousands of tokens.
    const tooSmall = () => (!before || removable / before < MIN_REDUCTION || removable / CHARS_PER_TOKEN < OWN_MIN_GAIN * window)
      && (cfg.targetPercent === undefined || !worthInTokens(cutInTokens(candidates, messages, api, envelopes, cfg.rates, stageTokens, shape), OWN_MIN_GAIN * window));
    // The delivered messages can only make this worse in characters (they add to `before`, their envelopes come off `removable`), so a transcript that fails
    // here needs no API read, which may hold the turn for HOST_MS. With the token cascade it is read all the same: in tokens the deliveries can make the cut
    // larger (a row's deliveries become one block, which takes their blocks off the list), and the agent stage is planned from the API form and may carry the
    // cut that the results do not.
    if (cfg.targetPercent === undefined && tooSmall()) return result;
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
      removable = removableChars(candidates) - envelopes;
    }
    if (cfg.targetPercent !== undefined) shape = shapeIn(api, delivered ? delivered.rows : new Map());
    // Only with the token cascade, which is where decide answers a request with that skip: without it nothing can follow, and the character gate is the only veto.
    // Not even the floor (every removable result gone) cuts HOST_MIN_CUT of the tokens: the request would only end in a skip after Jev's scores. The floor counts
    // results only, so with a stage on that takes text off as well (agent trim, long replies, pasted text) it is no proof: decide holds the request to the same
    // bound with the text of those stages in its plan, and answers it with a skip. Held after the API read, with the deliveries in the shape.
    const textStages = cfg.agentTrim || cfg.replies === 'active' || cfg.pastes === 'active' || blocksCount;
    if (cfg.ownSkip && cfg.targetPercent !== undefined && !textStages && tokens - floorPrediction(candidates, tokens, cfg.rates, shape) < Math.max(OWN_MIN_GAIN * window, HOST_MIN_CUT * tokens)) return result;
    // Only a session that the results alone do not carry needs the stage's scans: the compaction it asks for makes them otherwise.
    if (stageCounts && api && tooSmall()) {
      // The rows that keep their handles, as decide finds them; without the API form that holds their calls there is no stage.
      const keepFrom = openLoopStart(messages, groupsOf(messages, api));
      if (keptCallsIn(messages, keepFrom, api)) {
        try {
          let sessionId;
          try { sessionId = await $.session.id(); } catch { sessionId = undefined; }
          // Owner tail: the protected rows give nothing back.
          const planCfg = ownerProtectedCfg(cfg, messages, cfg.ownerTail && cfg.targetPercent !== undefined ? await ownerTailReads($, cfg, Date.now() + TOTAL_MS) : undefined);
          const stage = agentStageOf($, planCfg, undefined, messages, api, delivered ? delivered.rows : new Map(), keepFrom, sessionId, Date.now() + TOTAL_MS);
          // The checks go to the compaction that follows (takeAgentChecks); one that does not follow leaves them to the next preflight, which replaces them.
          if (stage.opts && sessionId) session.agentChecked = { id: sessionId, paths: JSON.stringify(cfg.privatePaths), checked: stage.opts.checked };
          stageTokens = await agentStageTokens(cfg, cfg.jevStages && blocksCount ? { ...stage, opts: undefined } : stage);
          // What the blocks may give back (every one at level 0), as the floor of decide counts it.
          if (blocksCount && sessionId) {
            stageTokens += planBlocks(planCfg, messages, stage.trimmed, api, delivered ? delivered.rows : new Map(), keepFrom, sessionId).potential;
            stageTokens += planSeries(planCfg, messages, stage.trimmed, api, delivered ? delivered.rows : new Map(), keepFrom, sessionId, false, Date.now() + TOTAL_MS).potential();
          }
        } catch { stageTokens = 0; }
      }
    }
    if (tooSmall()) return result;
    let reason;
    let detailText = '';
    // The verdicts of the blocks, so the compaction that follows finds them (a record `verdicts_fill` says what came of it).
    if (cfg.blocks !== 'off') await fillBeforeCompaction($, cfg, messages);
    try {
      session.ownCompactInFlight = true;
      const done = await $.session.compact();
      if (done && typeof done.skip === 'string') { reason = cfg.ownSkip && done.skip.startsWith(OWN_SKIP_PREFIX) ? 'cut_below_host_min' : done.skip.startsWith(OWNER_TAIL_SKIP) ? 'owner_tail_changed' : 'host_skipped'; detailText = done.skip; }
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
