# Session comparison tool

`compare_sessions.py` compares two Claude Code session transcripts (JSONL files) by counts, differences
and evidence gaps. It reports numbers only and never issues a verdict: the reader decides what the
numbers mean. It is a standalone diagnostic run by hand. It does not change OMC behaviour and is not
shipped in the npm package (`tools/` is not in the `files` list of `package.json`).

## Requirements

- `python3` (standard library only). Run it in isolated mode with `python3 -I`.
- The transcripts are only read. The only file the script writes is the `--output` file, if given.

## Usage

```
python3 -I tools/diagnostics/compare_sessions.py --a <session_a.jsonl> --b <session_b.jsonl>
python3 -I tools/diagnostics/compare_sessions.py --a A.jsonl --b B.jsonl --no-subagents --output result.json
python3 -I tools/diagnostics/compare_sessions.py --timeline <session.jsonl>
```

| Option | Meaning |
|---|---|
| `--a <file>` | transcript of session A (baseline) |
| `--b <file>` | transcript of session B (candidate) |
| `--timeline <file>` | timeline of one session instead of a comparison (cannot be combined with `--a`, `--b`, `--output`) |
| `--no-subagents` | read only the main transcript, not the subagent transcripts |
| `--time-threshold-pct N` | threshold for the percentage increase of the mean tool time (default 20). It only sets the `above_threshold` flag |
| `--output <file>` | write the JSON to a new file with mode 0600. An existing file is never overwritten (exit 1). Without this option the JSON goes to stdout |
| `-h`, `--help` | show the help |

Exit codes: `0` success (whatever the differences), `1` usage or read error (missing file, file without
any valid line, existing `--output` file).

The tool has no cost option: it reports counts, tool times and evidence gaps only, never a price or a cost.

## Input format

A session consists of:

- the main transcript `<projects dir>/<session_id>.jsonl`, and
- by default the subagent transcripts `<projects dir>/<session_id>/subagents/agent-*.jsonl`.

`session_id` is the file name without `.jsonl`. Only these lines are read: `type` `assistant`, `type`
`user`, and `type` `system` with `subtype` `compact_boundary`. Every other line type is skipped. A line
that is not a JSON object is skipped and counted in `bad_lines`. An empty or fully malformed subagent file
does not stop the measurement (its `valid_lines` is 0). A malformed main file is an error.

Fields used: `message.content` blocks (`text`, `tool_use`, `tool_result` with `is_error`,
`server_tool_use`, `advisor_tool_result`), `message.model`, `message.stop_reason`, `message.id`,
`timestamp`, `origin.kind`, `isApiErrorMessage`, `isCompactSummary`, `isVisibleInTranscriptOnly`.
These names come from the Claude Code transcript format, which can change between host versions; a change
in that format changes the results.

## Rules used for the counts

- A failure is only an explicit `is_error: true` on a `tool_result`. The word "error" in the content is not a failure.
- A call is counted once per block `id`. A result is counted once per `tool_use_id`. Results without a call are `orphan_results`.
- A call without a result is `incomplete`, unless a `compact_boundary` follows it later in the same file; then it is `incomplete_across_compaction`.
- Call duration is the timestamp of its `tool_result` minus the timestamp of its `tool_use`. A negative difference is not measured.
- Server tool blocks are counted once per `id`; without an `id` they are counted by position. The same rule applies to `advisor_tool_result` with `tool_use_id`.
- A turn opens with a user line that has non-empty text and no `tool_result`, when no turn is open. Other such lines during an open turn count as `messages_mid_turn`, with the origin in `messages_mid_turn_by_source`. A user line without an origin counts as `none`.
- A turn closes with an assistant line whose `stop_reason` is `end_turn` or `stop_sequence` (`turns_ended`), with an interrupt line (`turns_interrupted`; an interrupt text starts with `[Request interrupted by user`), or with an assistant line marked `isApiErrorMessage` (`turns_ended_by_api_error`). Lines with `isCompactSummary` or `isVisibleInTranscriptOnly` are ignored for turns.
- A turn still open at the end of a file is `unclosed_turns`, and `unclosed_turn_list` gives the file and the timestamp of the line that opened it.
- Assistant lines with `model` `<synthetic>` are skipped for tool calls, models, turns and the timeline, except that an API error line closes an open turn. Their timestamps still count toward `duration_ms`.
- Each tool's mean time is compared only when every call of that tool is measured on both sides. The percent change is `null` when the mean of side A is 0 ms, because a zero mean does not allow a percentage.

## Comparison output

Top level: `schema`, `mode` (`compare`), `time_threshold_pct`, `time_threshold_note`, `a`, `b`, `comparison`.

Each side (`a`, `b`): `session`, `files` (`file`, `role` `main` or `subagent`, `lines`, `valid_lines`),
`bad_lines`, `metrics`, `models`, `tools`, `gaps`.

`metrics`: `duration_ms`, `tool_calls`, `failures`, `incomplete`, `turns_started`, `turns_ended`,
`turns_interrupted`, `turns_ended_by_api_error`, `messages_mid_turn`, `messages_mid_turn_by_source`,
`turns_started_by_source`, `compactions`, `server_tool_use`, `advisor_tool_result`.

`tools`: per tool name, `calls`, `failures`, `incomplete`, `measured` (calls with a duration), `total_ms`, `mean_ms`.

`gaps`: `incomplete_tool_calls`, `incomplete_across_compaction`, `orphan_results`, `unclosed_turns`,
`unclosed_turn_list`, `no_tool_calls`, `unmeasured_tool_calls`, `ends_without_turn`, `api_errors_without_turn`.

`comparison`: `metrics` (for each main metric: `a`, `b`, `delta` = b - a, `percent` = delta / a * 100,
`percent` only when a > 0, otherwise `null`), `models` (`a`, `b`, `added`, `removed`), and `tools` (one
entry per tool name: `tool`, `presence` `both`, `only_a` or `only_b`, `a`, `b`, `time_comparable`, and
`comparison` with `calls`, `failures`, `incomplete` and `mean_time_ms`).

`mean_time_ms` has `a`, `b`, `delta`, `percent` and `above_threshold` (`percent > time_threshold_pct`, or
`null` when the percent is `null`).

## Timeline output

Top level: `schema`, `mode` (`timeline`), `session`, `files`, `bad_lines`, `duration_ms`, `gaps`, `events`.

Each event has `kind`, `time` (the line timestamp as written in the transcript, or `null`) and kind-specific
fields. Kinds: `compaction`, `tool_call` (`tool`, `id`), `result` (`id`, `status` `ok` or `failure`,
`duration_ms`, and `no_call` when there is no matching call), `turn_start` and `message_mid_turn` (`source`),
`turn_end`, `turn_end_api_error`, `turn_interrupted`, and `tool_call_no_result` (`tool`, `id`,
`before_compaction`). Events are sorted by time; events without a timestamp come first, and
`tool_call_no_result` events come last. The timeline does not contain message or result text.

# Executor outcome metrics

`executor_outcome_metrics.py` measures the transcript of one executor (worker) session: failed tool
calls, loops (retry, parameter drift, oscillation), API exhaustion, assistant steps, thinking and
output-token counts, the flags of the final answer, and test runs without an advisor consultation.
It prints numbers only and never issues a verdict. It is a standalone diagnostic run by hand. It does
not change OMC behaviour and is not shipped in the npm package.

## Requirements and usage

- `python3` (standard library only). Run it in isolated mode with `python3 -I`.
- The transcripts are only read. Nothing is written; the output goes to stdout.

```
python3 -I tools/diagnostics/executor_outcome_metrics.py --transcript <session.jsonl>
python3 -I tools/diagnostics/executor_outcome_metrics.py --transcript A.jsonl --transcript A/subagents/agent-x.jsonl --json
python3 -I tools/diagnostics/executor_outcome_metrics.py --transcript A.jsonl --provider-map model-x=provider-x --from 2026-11-01
```

| Option | Meaning |
|---|---|
| `--transcript <file>` | transcript of one session (repeatable). A file named `<session>/subagents/agent-<id>.jsonl` is a separate task with the session as `parent` |
| `--from YYYY-MM-DD`, `--to YYYY-MM-DD` | keep tasks whose first timestamp (UTC) is in the range; tasks without a timestamp are counted as `no_date` |
| `--provider-map PREFIX=NAME` | map a model name prefix to a provider name (repeatable, first match wins). Without a mapping the provider is `unmapped`; a task without any model name has `unknown` |
| `--test-pattern <regex>` | regular expression matched (`re.match`) to a Bash command segment after removing prefixes; replaces the built-in list of test runners |
| `--advisor-pattern <regex>` | regular expression for a Bash command segment that is an advisor consultation. The advisor tool block (`server_tool_use` named `advisor`) is always recognised |
| `--retry-threshold N` | consecutive identical calls that form a retry pattern (default 3) |
| `--drift-threshold N` | consecutive calls to one tool that form a parameter-drift pattern (default 3) |
| `--drift-min-signatures N` | distinct signatures a drift run needs (default 2) |
| `--oscillation-min-repeats N` | full back-to-back repeats of a cycle that form an oscillation (default 3) |
| `--max-cycle-length N` | longest cycle of tool names checked for oscillation (default 5, at least 2) |
| `--exhaustion-status CODE` | extra HTTP status that counts as exhaustion, added to the built-in set (repeatable) |
| `--exhaustion-phrase TEXT` | extra phrase that counts as exhaustion when it is found in the lowercased text, added to the built-in list (repeatable) |
| `--error-field-status NAME=CODE` | HTTP status for an `error` field value, used when the error text has no status (repeatable; there is no built-in mapping) |
| `--json` | JSON output instead of text |

Exit codes: `0` success (whatever the numbers), `2` usage error (missing file, bad date, bad
`--provider-map` entry, bad regular expression, a threshold below its minimum, a bad `--error-field-status` entry).

## Input format

Only lines with `type` `assistant` or `user` are read. Other types, including `api-request-blob`, are
skipped. A line that is not a JSON object is counted in `bad_lines`. Fields used: `message.content`
blocks (`text`, `thinking`, `tool_use`, `tool_result` with `is_error`, `server_tool_use`), `message.id`,
`message.model`, `message.usage.output_tokens`, `requestId`, `timestamp`, `sessionId`, `isSidechain`,
`isApiErrorMessage`, `error`, `thinkingDurationMs`. Rows with model `<synthetic>` are skipped for steps,
calls, tokens and final text, except that an API error row is still read as an API error. These names come
from the Claude Code transcript format, which can change between host versions.

## Metrics (per task)

Every metric is a number, or the string `unmeasured` with the reason in the task's `reasons` object.
A missing value is never reported as zero.

| Metric | Meaning |
|---|---|
| `tool_failures` | calls whose result has `is_error` true. An empty result is not a failure |
| `failure_runs`, `longest_failure_run` | runs of two or more failed results in a row, and the longest such run |
| `retry_patterns` | runs of at least 3 consecutive calls with an identical signature (tool name and arguments; key order does not matter). `loop_patterns.retry` lists `[first, last]` call indexes |
| `parameter_drift_patterns` | runs of at least 3 consecutive calls to one tool with at least 2 distinct signatures. A run that overlaps a retry run is suppressed. `loop_patterns.parameter_drift` lists `[first, last]` |
| `oscillation_patterns` | cycles of 2 to 5 tool names, with at least 2 distinct names, repeated at least 3 full times back to back. Overlaps are removed (sort by start, longer first). `loop_patterns.oscillation` lists `first`, `last`, `cycle`, `cycle_count` |
| `exhaustion_api`, `exhaustion_api_by_status` | API error rows that count as exhaustion, and the key of each (the status, or `phrase` when only the text matched) |
| `api_errors_other`, `api_errors_by_error_field` | the other API error rows, and the count of each `error` field value |
| `exhaustion_tool_results` | failed tool results that count as exhaustion |
| `assistant_steps` | distinct `message.id` of non-synthetic assistant rows |
| `thinking_blocks`, `thinking_chars`, `thinking_duration_ms` | thinking blocks, their text length, and the sum of `thinkingDurationMs` |
| `output_tokens` | sum of `usage.output_tokens` over `(message.id, requestId)`, taking the maximum per key |
| `test_episodes_without_advisor` | episodes of two or more failed test runs in a row, ended by a passed run, an advisor consultation, or the end of the transcript |
| `test_runs_failed`, `test_runs_passed`, `test_runs_no_result` | test runs by result. A run without a result is counted separately and neither breaks nor extends a series |
| `advisor_consultations` | advisor tool blocks plus Bash segments matching `--advisor-pattern` |

Exhaustion rule: an item counts when its HTTP status is one of 408, 413, 429, 503, 504, 529, or its
lowercased text contains one of these phrases: `context length`, `context window`, `token limit`,
`rate limit`, `too many requests`, `timeout`. The status is read from the text first (a 3-digit number
in parentheses, else a 3-digit number after a colon), then from the mapping of the `error` field given
with `--error-field-status` (empty by default). Anything else is `other`. A failed tool result is checked the same way; a result without `is_error` is never exhaustion.

## Final answer flags

The last main-thread assistant text is checked (rows with `isSidechain` false; in a subagent file `agent-*.jsonl` the whole file is the worker's own thread, which the host writes with `isSidechain` true). Without such text the answer is `unmeasured`.

| Flag | Meaning |
|---|---|
| `empty` | blank after trimming |
| `cut_off` | the trimmed text ends with a comma, `&&`, `||`, `=>`, an arithmetic or assignment operator, an opening bracket, a colon, or a trailing `const`, `let`, `var`, `function` or `return` |
| `odd_fences` | an odd number of triple-backtick markers |
| `repeated_line` | one trimmed line longer than 8 characters occurs 5 or more times in a row (blank lines ignored) |
| `ended_with_api_error` | the last main-thread assistant row is an API error |

## Output

Top level: `tasks`, `summary_by_provider`, `coverage` (`with_transcript`, `total`, `percent`, `no_date`),
`skipped` (duplicate files). Each task: `session_id`, `provider`, `model`, `parent`, `file`, `transcript`
(`present`, `empty` or `unreadable`), `bad_lines`, `period` (`first`, `last` dates), `metrics`,
`final_result` (`status`, `flags`), `loop_patterns`, `reasons`. Per provider: `n`, `with_transcript`,
`metrics` (`sum`, `median`, `unmeasured` for each numeric metric), `final_result` (flag counts).

## Limits

- The loop, exhaustion, failure and final-answer rules follow a written behaviour specification. The
  thresholds, the exhaustion statuses and phrases and the error-field mapping have the defaults named above and
  can be changed with the options; the same values are parameters of the functions in the script.
- The tool does not know which transcript belongs to which task of a larger run; it measures the files given.
- Test-run detection is by command name only; use `--test-pattern` for other runners.

# Decision-outcome join

`decision_outcome_join.py` joins the Jev model and effort decisions with what the subagent did afterwards: the model and
effort Jev chose, the model and effort Claude Code actually started (`meta.json`), the transcript (models, tokens, cache,
reasoning, turns, tool calls, end status), the cost in USD and the gross saving under a price table given by the caller.
It prints numbers only. It is a standalone diagnostic run by hand. It does not change OMC behaviour and is not shipped in
the npm package.

## Requirements and usage

- `python3` (standard library only). Run it in isolated mode with `python3 -I`.
- The journals and transcripts are only read. The only files written are the `--tsv` and `--json` outputs, if given.

```
python3 -I tools/diagnostics/decision_outcome_join.py --journal <jev dir> --transcripts <transcript dir> --prices prices.json
python3 -I tools/diagnostics/decision_outcome_join.py --journal J --transcripts T --from 2026-11-01 --to 2026-11-30 --json out.json
```

| Option | Meaning |
|---|---|
| `--journal <dir>` | directory with `applied.jsonl` and `shadow.jsonl` and their rotated files |
| `--transcripts <dir>` | directory with the Claude Code transcripts and `agent-*.meta.json` files |
| `--from`, `--to` | keep rows whose `ts` is in the range (ISO 8601, both ends inclusive) |
| `--prices <file>` | optional JSON price table `{"family": [input, cache write 5 min, cache write 1 h, cache read, output]}` in USD per 1 million tokens. Without it the price table is empty: every cost and saving is unavailable (null), never zero, and one note is printed on stderr (the exit code stays `0`) |
| `--pointer-verbs WORD` | extra verb (repeatable) that marks a pointer prompt (a short prompt that names a file), besides the built-in `read` and `brief`. Words in other languages go here |
| `--source-map SUBSTRING=LABEL` | label the task source when the subagent type contains `SUBSTRING` (repeatable, first match wins). Without a match the source is `undetermined` |
| `--tsv <file>` | one row per agent task |
| `--json <file>` | the whole result as JSON (see the note on output files below) |
| `--wilson-vectors` | print the Wilson test vectors (shared with `wilson_threshold.mjs`) and exit |

Exit codes: `0` valid run (also with no data), `2` argument or input error.

Output files: `--tsv` and `--json` open the given path for writing, so an existing file is overwritten and a symbolic link is followed. Point them at a new path.

## Input format

- `applied.jsonl` rows with `point` `model-routing` and a `tool_use_id` are joined to `agent-*.meta.json` by `toolUseId`.
  The transcript is the `agent-*.jsonl` next to the meta file.
- `shadow.jsonl` rows with the same `tool_use_id` give the Jev answers (probabilities and confidence of `model-tier` and `effort`).
- Rotated files are read as `<name>-YYYYMMDD-HHMMSS.jsonl` or `<name>-YYYYMMDD-HHMMSS-<pid>.jsonl`.
- These field names come from the Jev journal and the Claude Code transcript format; a change in those formats changes the results.

## Rules used for the counts

- Zero is not a measurement: a model family that is not in the price table has a null cost. An agent with 0 turns has
  `cost_status` `unavailable`.
- `cost_status`: `reported` (all turns priced), `partial` (cost of the priced turns only, the count in `turns_unpriced`),
  `unavailable` (no turns, or none priced).
- A request is priced with the one row of its own tier: a Haiku request above 100k tokens with `haiku>100k`, any other request
  with its family row. A table may hold only the rows it needs; a turn with no row for its tier, or without any `usage`, is
  unpriced. A turn is a `message.id` (a row without one is a turn identified by its `uuid`); a tool call id is counted once.
- `end_is_error` and `end_api_error_status` come from `is_error` and `api_error_status` fields of a row; a last assistant row
  marked `isApiErrorMessage` also sets `end_is_error`, and the status is read from its text, in parentheses or after a colon.
- `model_match`: `match`, `mismatch` (the dominant transcript model is not the model Jev chose), `undetermined` (no transcript
  or no `message.model`), `no model decision` (Jev chose no model).
- A duplicate `tool_use_id` is counted once in the result and once under `distribution.duplicates`.
- Every ratio in the report shows the denominator and a two-sided 95 % Wilson interval (z = 1.96) and a one-sided lower bound (z = 1.645).
- The price-consistency check compares two cost functions on single-model agents. It guards only against regressions: both use the same price table.

# Wilson threshold

`wilson_threshold.mjs` applies a threshold rule to a TSV of outcome labels (the output of `jev_outcome_labels.mjs`, or any file
with the same columns): a Wilson lower bound against a target, a minimum support, and a `no threshold` result that is valid, not an error.
It is a standalone diagnostic run by hand. It does not change OMC behaviour and is not shipped in the npm package.

## Requirements and usage

- Node 20 or later, built-in modules only.

```
node tools/diagnostics/wilson_threshold.mjs --input labels.tsv --target 0.95 [--min-support 30] [--kind selective|per-query]
node tools/diagnostics/wilson_threshold.mjs --input labels.tsv --target 0.10 --direction upper --json
```

| Option | Meaning |
|---|---|
| `--input <file>` | TSV with a header; `-` reads stdin |
| `--target <0-1>` | the target hit rate (or the error bound with `--direction upper`) |
| `--min-support <n>` | the minimum number of rows for a threshold (default 30) |
| `--kind selective\|per-query` | the error kind: among accepted rows, or over all inputs (coverage times selective error) |
| `--direction lower\|upper` | `lower`: the lower bound must reach the target; `upper`: the upper bound must stay below it (ratio mode only) |
| `--group-by <fields>` | `point,spec_version,jev_model` by default; allowed `point`, `spec_version`, `jev_model`, `mode`, `session` |
| `--holdout <0-0.5>` | fit/holdout split of the sessions (needs a `session` column) |
| `--json` | JSON output instead of the text report |

Exit codes: `0` valid run (also `no threshold`), `2` argument or input error.

## Input format

- Columns: `result` (required: `1` or `executed` = hit, `0` or `ignored` = miss, empty or `undetermined` = outside the denominator),
  and the optional `confidence` (0-1), `mode`, `point`, `spec_version`, `jev_model`, `session`, `ts`.
- Rows with `mode` `breaker`, `limit` or `degraded` are not a verdict: they are excluded from the denominator and counted per mode.
- A row with an empty `confidence` (in a file that has the column) forms a `no confidence` subgroup, measured as a single ratio.

## Output rules

- Every row falls into exactly one category: the denominator, an excluded mode, `undetermined`, `invalid`, `invalid_confidence`
  or `bad_format`. The report shows the counts per group and in total, so the closing equation can be checked.
- With a `confidence` column the sweep runs over the distinct confidence values; the chosen threshold is the lowest one with
  at least `min_support` rows and a hit-rate lower bound at least the target.
- Without it the ratio is judged directly. `too little data` means fewer rows than `min_support`.
- A warning `small sample` is printed when `n < 100`; the status does not change.

# Jev outcome labels

`jev_outcome_labels.mjs` labels the outcome of each learner hint (`learner-extraction` in `applied.jsonl`) and each denial of an
agent type (`deny` in `agent-type.jsonl`) by joining the journal row with the session transcript: `executed`, `ignored` or
`undetermined`. The label measures behaviour (the agent called the `remember` skill, or the owner typed `/remember`); it is not a verdict on whether the hint was right.
It is a standalone diagnostic run by hand. It does not change OMC behaviour and is not shipped in the npm package.

## Requirements and usage

- Node 20 or later, built-in modules only.

```
node tools/diagnostics/jev_outcome_labels.mjs --journal <journal dir> --transcripts <transcript dir> [--from <ISO>] [--to <ISO>] [--session <id>] [--tsv <file>] [--json]
```

| Option | Meaning |
|---|---|
| `--journal <dir>` | directory with `applied.jsonl` (required) and `agent-type.jsonl` (optional), plus rotated files |
| `--transcripts <dir>` | Claude Code transcript directory (required) |
| `--from`, `--to` | period filter on `ts` |
| `--session <id>` | the decision timeline of one session instead of the summary |
| `--tsv <file>` | the labelled rows as TSV, the input of `wilson_threshold.mjs` (columns `result`, `confidence`, `mode`, `point`, `spec_version`, `jev_model`, `session`, `ts`) |
| `--json` | JSON output |

Exit codes: `0` valid run, `2` argument or input error.

## Label rules

- `executed`: in the window (the rest of the turn of the row, plus the next 3 turns) the agent called the `Skill` tool with a skill
  name containing `remember`, or the user sent `/remember` at the start of a message or inside `<command-name>`.
- `ignored`: the transcript has entries after the row and the window has no such call. A transcript that ends before the third
  turn counts as `window_incomplete`.
- `undetermined`: no transcript, no entries after the row, no `session_id`, or an unreadable `ts`. Outside the denominator of the executed share.
- Agent-type denials take the label from the next `agent-type` row of the same session: `allow` = executed, `deny` or `would-deny` = ignored, otherwise undetermined.
- Rows with `mode` `breaker`, `limit` or `degraded` get no label and are counted separately. `would-deny` rows stay out of the TSV.
- Sample-size markers: 20 labels (`DEEP`) and 30 labels (`min_support`); below 30 the executed share is reported as `too little data`.

# Tool call repeats

`tool_call_repeats.py` measures repeated tool calls on Claude Code transcripts: repeated successful
calls, duplicate Agent/Task calls, near-identical series and cycles. It reports numbers only (no
input, prompt or result content) and never issues a verdict. It is a standalone offline diagnostic
run by hand: it does not change OMC behaviour, has no switch, and is not shipped in the npm package.

## Requirements and usage

- `python3` (standard library only). Run it in isolated mode with `python3 -I`.
- The transcripts are only read. The only files written are the `--tsv` and `--json` files, if given. They are opened for
  writing as given, so an existing file is overwritten and a symbolic link is followed: point them at a new path.

```
python3 -I tools/diagnostics/tool_call_repeats.py --transcripts <dir> [--from <ISO>] [--to <ISO>]
python3 -I tools/diagnostics/tool_call_repeats.py --transcripts <dir> --poll-prefix ls --poll-tool MyStateTool --tsv out.tsv --json out.json
```

| Option | Meaning |
|---|---|
| `--transcripts <dir>` | required: transcripts laid out `<dir>/<project>/<session>.jsonl` and `<dir>/<project>/<session>/subagents/agent-<id>.jsonl` |
| `--from`, `--to` | ISO range on the call timestamp, both ends inclusive |
| `--min-identical N` | (a) minimum run of identical calls with an identical result (default 3) |
| `--dice X` | (c) Dice threshold on character bigrams of the input JSON (default 0.85) |
| `--min-similar N` | (c) minimum series length (default 5) |
| `--periods a-b` | (d) cycle periods (default 2-6) |
| `--min-cycle-repeats N` | (d) minimum repetitions of the pattern (default 3) |
| `--window N` | (d) number of last call signatures scanned per context (default 64) |
| `--min-support N` | below this denominator a rate has no threshold (default 30) |
| `--poll-prefix <prefix>` | extra Bash command prefix treated as polling (repeatable) |
| `--poll-tool <name or suffix>` | extra tool treated as polling, matched as a full name or a suffix (repeatable; empty by default) |
| `--tsv <file>`, `--json <file>` | optional outputs (one TSV row per finding; the full JSON result) |

Exit codes: `0` normal run (also with no data), `2` argument or input error, including a failed write.

## What is counted

- (a) repeated success: a run of consecutive calls with the same call signature and the same successful result signature.
- (b) duplicate task: Agent/Task calls in one context with the same `subagent_type` and the same prompt; the second call
  lands before the first result (result not received), or after it (reported separately).
- (c) near-identical series: consecutive calls of one tool whose input JSON is similar (Dice) but not identical.
- (d) cycles: a pattern of period p repeated in the last calls of a context (for example A,B,A,B,A,B).
- Polling (sleep, `gh run watch`, `tail -f`, `git status`, state tools, MCP tools ending with a state suffix) is counted
  separately and stays out of (a) and out of the repeat-work sums.

Every variant is reported twice: `subsequence` (calls of one tool, other tools in between do not break a run) and `strict`
(the full call stream of the context). Every rate gives k/n, a two-sided 95 % Wilson interval and a one-sided 95 % lower
bound; with n below `--min-support` the status is "no threshold (too little data)". The default thresholds are starting
values to tune on data.

# Empty results

`empty_results.py` counts how many finished agent tasks returned no result at all, on Claude Code transcripts
and on `omc team` task files. It blocks nothing and reports numbers only (no prompt, result or subject content).
It is a standalone offline diagnostic run by hand: it does not change OMC behaviour and has no switch.

## Requirements and usage

- `python3` (standard library only). Run it in isolated mode with `python3 -I`.
- The inputs are only read. The only files written are the `--tsv` and `--json` files, if given. They are opened for
  writing as given, so an existing file is overwritten and a symbolic link is followed: point them at a new path.

```
python3 -I tools/diagnostics/empty_results.py --transcripts <dir> [--teams <dir>] [--from <ISO>] [--to <ISO>]
python3 -I tools/diagnostics/empty_results.py --transcripts <dir> --intent intent.tsv --tsv out.tsv --json out.json
```

| Option | Meaning |
|---|---|
| `--transcripts <dir>` | transcripts laid out as for the repeats tool (main sessions and subagents) |
| `--teams <dir>` | team state directory with `<team>/tasks/task-<n>.json` (or `<n>.json`) files |
| `--from`, `--to` | ISO range: the call timestamp (transcripts) or `completed_at` / `created_at` (team tasks) |
| `--min-support N` | below this denominator a rate has no threshold (default 30) |
| `--intent <TSV>` | optional hand-filled file with the columns `id` and `intent` (`intentional` or `other`) for stopped calls |
| `--tsv <file>`, `--json <file>` | optional outputs (one TSV row per empty or stopped call or task; the full JSON result) |
| `--wilson-vectors` | print the Wilson test vectors as JSON and exit |

At least one of `--transcripts` and `--teams` is required. Exit codes: `0` normal run (also with no data), `2` argument or input error.

## What is counted

- Transcripts: an Agent/Task call is empty when its subagent transcript has no assistant text, or its `tool_result` is empty.
  Subtotals: `prompt_only`, `empty_tool_result`, `tool_use_only`; a call with neither a transcript nor a result is
  `missing_transcript` and stays outside the denominator.
- Stop measure: a call with missing answer text that was stopped from outside (parent `TaskStop`, a `killed` task
  notification, or an interrupted subagent transcript) is not an empty result; it enters `stopped_without_report`.
  The source precedence is `parent_taskstop`, then `interrupt`, then `killed_other`.
- Team: a task is empty when its status is `completed` and `result` is missing or blank. The denominator is all finished
  tasks (`completed` and `failed`) in the range.
- A part without its input is reported as unmeasured, never as 0; n = 0 gives no rate value. Every rate gives k/n, a
  two-sided 95 % Wilson interval and a one-sided 95 % lower bound.

# Compaction window drops

`compaction_window_drops.py` classifies the drops of the context window between consecutive model calls
by cause (for example module compaction, host compaction, a new process, a side task, a change of shape
without a cut). It reads Claude Code session transcripts and the compaction journal (`compaction.jsonl`)
and reports numbers only. It is a standalone offline diagnostic run by hand: it does not change OMC
behaviour, has no switch, is not run by any hook, and is not shipped in the npm package.

## Requirements and usage

- `python3` (standard library only). Run it in isolated mode with `python3 -I`.
- The transcripts and the journal are only read. The only file written is the `--out` file, if given
  (a new file with mode `0600`; an existing file is an error).
- The journal is read from `OMC_JEV_LOG_DIR`, else from `.omc/state/jev` under the current directory (run the tool from
  the project root), unless `--compact` is given. With `OMC_STATE_DIR` set, the Jev log directory has a project identifier
  in its path, so pass the journal with `--compact` (or set `OMC_JEV_LOG_DIR`). The projects directory defaults to
  `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`.
  This tool does not resolve the state root (it uses `.omc/state/jev` under the current directory); `denial_log_summary.mjs` and `compaction_review.mjs` do.

```
python3 -I tools/diagnostics/compaction_window_drops.py [--projects <dir>] [--days 7] [--json]
python3 -I tools/diagnostics/compaction_window_drops.py --transcript session.jsonl --compact compaction.jsonl --out report.json
```

| Option | Meaning |
|---|---|
| `--projects <dir>` | the projects directory with transcripts (main sessions and subagents) |
| `--transcript <file>` | one transcript file (repeatable; used instead of scanning the projects directory) |
| `--compact <file>` | the compaction journal |
| `--to <ISO>`, `--days N` | the period end (default: now, UTC) and its length in days (default 7) |
| `--min-drop-tokens N`, `--min-drop-percent N` | drop thresholds (defaults 10000 tokens and 10 % of the previous window) |
| `--tolerance-s S` | tolerance in seconds when matching a drop to a journal row (default 5) |
| `--json`, `--out <file>` | JSON output (template `compaction-report/1`) and the file to write it to |

The rule (window definition, drop definition and the order of the cause classes) is in the script
docstring and in the `RULE` constant; both are fixed before a measurement.

# Compaction ask probe

`compaction_ask_probe.py` measures whether the first and the last human ask of a session survive a
compaction. It counts the loss rates of both asks (`head_lost`, `ask_lost`) with the survival level of
each ask (`full`, `trace`, `paraphrased` or `lost`), empty calls after a compaction and natural canaries.
With n of at least 30, the verdict compares the upper 95 % Wilson bound of a loss rate with
`--ask-loss-threshold`. It prints no ask or state content: only numbers, levels and identifiers. It needs
a `compact_boundary` row in the transcript. It is a standalone offline diagnostic run by hand: it does not
change OMC behaviour, has no switch, and is not shipped in the npm package.

## Requirements and usage

- `python3` (standard library only). Run it in isolated mode with `python3 -I`.
- The inputs are only read. The only file written is the `--out` file, if given (a new file with mode `0600`).
- This tool does not resolve the state root (it uses `.omc/state/jev` under the current directory); `denial_log_summary.mjs` and `compaction_review.mjs` do.

```
python3 -I tools/diagnostics/compaction_ask_probe.py [--projects <dir>] [--days 7] [--ask-loss-threshold 0.05] [--json]
```

| Option | Meaning |
|---|---|
| `--projects <dir>`, `--transcript <file>`, `--compact <file>` | inputs, as for the window drops tool (including the default journal: `OMC_JEV_LOG_DIR`, else `.omc/state/jev` under the current directory; with `OMC_STATE_DIR` set, pass `--compact` or set `OMC_JEV_LOG_DIR`) |
| `--to <ISO>`, `--days N` | the period end (default: now, UTC) and its length in days (default 7) |
| `--ask-loss-threshold X` | the threshold the upper Wilson bound is compared with (default 0.05) |
| `--details` | add the list of units (without ask contents) |
| `--json`, `--out <file>` | the result as one JSON object, and the file to write it to |

# Compaction cache cost

`compaction_cache_cost.py` measures how compactions affect the prompt cache: prefix rewrite breaks by
class, the rewrite cost, the recovery in the first turn after a compaction, the turns to breakeven,
Cache Savings, and cache losses before and from a deployment date. It counts only usage fields and
timestamps. It is a standalone offline diagnostic run by hand: it does not change OMC behaviour, has
no switch, and is not shipped in the npm package.

## Requirements and usage

- `python3` (standard library only). Run it in isolated mode with `python3 -I`.
- The inputs are only read. The only file written is the `--out` file, if given.
- This tool does not resolve the state root (it uses `.omc/state/jev` under the current directory); `denial_log_summary.mjs` and `compaction_review.mjs` do.
- Prices come only from the file given with `--prices`; without it every USD figure is reported as
  unavailable and the cache measurements still run. The file is JSON, with prices in USD per million
  tokens:

```
{"models": {"<model id or id prefix>": {"input_per_mtok": 3.0, "output_per_mtok": 15.0}},
 "subscription_prefixes": ["<model id prefix>"]}
```

A model is matched by exact id, otherwise by the longest listed prefix. Models whose id starts with a
subscription prefix are left out of the USD sums. The cache write costs 1.25 x the input price for a
5-minute write and 2.0 x for a 1-hour write, and the cache read costs 0.10 x the input price; these
multipliers are constants of the script.

```
python3 -I tools/diagnostics/compaction_cache_cost.py --deployed-at 2026-01-01T00:00:00Z [--prices prices.json] [--json]
```

| Option | Meaning |
|---|---|
| `--deployed-at <ISO>` | required: the time the compaction module was deployed; cache loss sessions are split by the time of their first call |
| `--prices <file>` | the explicit price table described above |
| `--projects <dir>`, `--transcript <file>`, `--compact <file>` | inputs, as for the window drops tool (including the default journal: `OMC_JEV_LOG_DIR`, else `.omc/state/jev` under the current directory; with `OMC_STATE_DIR` set, pass `--compact` or set `OMC_JEV_LOG_DIR`) |
| `--to <ISO>`, `--days N` | the period end (default: now, UTC) and its length in days (default 7) |
| `--details` | add the segment hit rates and the units to the report |
| `--json`, `--out <file>` | the result as JSON, and the file to write it to |

# Denial log summary

`denial_log_summary.mjs` summarizes the journal `denials.jsonl` written by the denial counter, which another change
delivers (this change contains no writer of that journal, so the tool has nothing to read until the counter is in use): counts per event kind and per subject (a
session, with the agent id when a subagent wrote the row), degrees, results, the p50 and p95 of the time from a decision to its
outcome, and the number of unique keys. It is a standalone diagnostic run by hand. It does not change OMC behaviour and is not
shipped in the npm package.

## Requirements and usage

- Node 20 or later, built-in modules only. It reads files only. Run it from a repository checkout: the default directory is resolved through `scripts/lib/state-root.mjs`, which is loaded only when no `--file` or `--dir` is given.

```
node tools/diagnostics/denial_log_summary.mjs [--file <path>]... [--dir <dir>] [--json] [<path>...]
```

| Option | Meaning |
|---|---|
| `--file <path>` | a journal file; repeatable. Plain arguments are taken as files too, and (unlike `--file`) do not turn off the default directory. A file given on the command line that does not exist is reported with a warning on stderr; the summary and the exit code do not change |
| `--dir <dir>` | a directory: reads `denials.jsonl` and its rotated parts (`denials-YYYYMMDD-HHMMSS.jsonl`, `denials-YYYYMMDD-HHMMSS-<pid>.jsonl`) |
| `--json` | JSON output |

With no `--file` and no `--dir` it also reads the directory `$OMC_JEV_LOG_DIR`, else `state/jev` under the state root of the current directory (run the tool from the project root). The state root is resolved with `scripts/lib/state-root.mjs`, the resolver the hooks use, so it follows `OMC_STATE_DIR`; if it cannot be resolved the tool exits with `2` and asks for `--dir` (or `OMC_JEV_LOG_DIR`). This tool and `compaction_review.mjs` resolve the state root; the `compaction_*.py` tools do not. Exit codes: `0` summary printed, `2` no journal file found.

## What is counted

- Rows are read from all files and deduplicated by the stable event id: the same event in two journals counts once (`duplicates`).
  A row that is not valid JSON, for example the truncated tail of a rotated part, is skipped and counted (`unparseable`).
- `outside schema` counts the rows that fail the field check below. They are still summarized.
- Per group (a kind, or a subject): `rows`, `degrees` (`d0`, `d1`, `d2`), `results`, the number of distinct `key` values, and the p50 and p95 of
  the milliseconds between a decision row and the `outcome` row that references it by `ref`. Only a decision seen earlier in the files and an
  outcome that is not older than it are joined.
- `DIFFERENT-FACTS`: the same `key` appears in decision rows with different guard or result values.

## Journal fields

The tool reads the rows as the denial counter writes them (the counter and its handoff rows come from the session guards
change, not from this one). A row that does not match this layout is still summarized and is counted as `outside schema`.

| Field | Meaning |
|---|---|
| `ts`, `ts_ms`, `point` | the time of the row (ISO text and milliseconds) and the constant `denial` |
| `kind` | `denial`, `release`, `state` (decision rows), `outcome` or `handoff` |
| `id`, `ref` | 16-hex event id; `ref` of an `outcome` row is the id of its decision |
| `session_id`, `agent_id` | the subject; `agent_id` is `null` for the main session |
| `guard`, `key` | the guard and the 16-hex hash of the normalized denial key (a `handoff` row has the guard `handoff` and no key) |
| `n`, `sessionCount`, `k`, `maxSession` | windowed count, per-guard session count, threshold, session ceiling (`n` and `sessionCount` are `null` for a row written without a readable state) |
| `degree` | `0` none, `1` reminder, `2` block |
| `result` | `denied` or `passed` |
| `action` | of a decision row, the fired action (`escalation-1`, `escalation-2`, `deny-storm`, `release`, `state-broken`, `state-nan`, `state-lock-unavailable`); of a `handoff` row, the event: `warning`, `handoff-allowed`, `handoff-subagent`, `handoff-refused` or `handed-over-refused` |
| `reason_code`, `state` | `guard_denial`, and the state of the counter: `ok`, `broken`, `nan` or `lock-unavailable` |
| `bytes` | of a `handoff` row: the size in bytes, or `null` when unknown |
| `effectiveness` | always `null` |
| `tool_name`, `tool_use_id`, `truncated` | the call, and a marker for a row that was shortened to fit 2000 characters |
