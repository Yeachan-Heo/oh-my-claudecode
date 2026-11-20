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
- The inputs are only read. The files written are the `--out` file and, with `--export-labeling`, the export file (new files with mode `0600`). The result and the `--out` file carry no ask or state content; the opt-in export file holds human message text by design, and also the transcript path (`file`) and the `session_id` of each unit.
- This tool does not resolve the state root (it uses `.omc/state/jev` under the current directory); `denial_log_summary.mjs` and `compaction_review.mjs` do.

```
python3 -I tools/diagnostics/compaction_ask_probe.py [--projects <dir>] [--days 7] [--ask-loss-threshold 0.05] [--json]
```

| Option | Meaning |
|---|---|
| `--projects <dir>`, `--transcript <file>`, `--compact <file>` | inputs, as for the window drops tool (including the default journal: `OMC_JEV_LOG_DIR`, else `.omc/state/jev` under the current directory; with `OMC_STATE_DIR` set, pass `--compact` or set `OMC_JEV_LOG_DIR`). A `--transcript` path that cannot be read (missing, a directory, no permission) exits 2 with a message that names it, and so does a `--projects` directory that is missing or cannot be read when the transcripts are searched; a transcript found by the search that cannot be read is skipped with a warning on stderr |
| `--to <ISO>`, `--days N` | the period end (default: now, UTC) and its length in days (default 7) |
| `--ask-loss-threshold X` | the threshold the upper Wilson bound is compared with (default 0.05) |
| `--details` | add the list of units (without ask contents) |
| `--json`, `--out <file>` | the result as one JSON object, and the file to write it to |
| `--export-labeling <file>` | write the blind labelling export (see below); a new file with mode `0600`, an existing file is refused (exit 1) |
| `--labels <file>` | read blind labels and add the `command_measure` block (see below); a missing file exits 2 |
| `--export-window N`, `--export-limit N` | human messages kept per unit in the export (default 40) and characters kept per text block (default 500) |

## Binding and stale instructions (opt-in)

Without `--export-labeling` and `--labels` the output is exactly the one described above. The two options
measure a failure that the ask levels do not show: a standing instruction that disappears from the state,
and an outdated instruction that survives while its correction disappears.

1. `--export-labeling <file.jsonl>` writes one JSON line per main-thread unit with the last `--export-window`
   human messages before the boundary, split into text blocks with the ids `<message uuid>#<block index>`
   (a message without a uuid gets `line-<row number>`). Each block is cut to `--export-limit` characters and
   flagged `truncated`. Nothing after the boundary is written, so a reader labelling the file cannot see the
   state. Standard output carries only the counts of units and blocks.
2. A reader labels blocks in a JSONL file of rows
   `{"unit_id", "block_id", "label": "binding" | "stale", "superseded_by", "reason"}`. `reason` is a non-empty
   string. A `stale` block must name a later block in `superseded_by` (its correction); a `binding` block may
   name a later block that restates it.
3. `--labels <file.jsonl>` adds `command_measure` to the result, per group `jev/main` and `fallback/main`:
   `binding_lost` is the share of `binding` blocks that are lost after the compaction (level `lost`, as for
   `ask_lost`) and whose restatement, if named, is lost too; `stale_kept_fix_lost` is the share of `stale`
   blocks that are kept while the block named in `superseded_by` is lost. A removed `stale` block is not a
   failure and is counted in `stale_removed`. The denominators are the labelled blocks of units that have a
   state; unlabelled blocks are counted separately and rejected label rows are counted by reason
   (`bad_json`, `not_an_object`, `bad_ids`, `bad_label`, `missing_reason`, `bad_superseded_by`, `unknown_unit`,
   `unknown_block`, `stale_without_fix`, `unknown_successor`, `successor_not_later`, `duplicate`). The verdict
   follows `--ask-loss-threshold`; with fewer than 30 blocks in a group it is `insufficient data`.

# Compaction harm monitor

`compaction_harm_monitor.py` computes three cheap signals of harm after a compaction from transcripts and
the compaction journal, and, when given the per-unit output of the ask probe, measures how well each signal
agrees with `ask_lost`. It takes no action: nothing is written to sessions, the plugin or the state, and
standard output carries only numbers and group names. It is a standalone offline diagnostic run by hand.

## Requirements and usage

- `python3` (standard library only). Run it in isolated mode with `python3 -I`.
- Inputs: Claude Code transcripts (`<projects>/<dir>/<id>.jsonl` and `<id>/subagents/agent-*.jsonl`, rows with
  `type`, `message.id`, `message.content`, with `system` rows of `subtype` `compact_boundary` and `api-request`
  rows) and the compaction journal `compaction.jsonl` (rows with `event` `compact`, `session_id`, `agent_id`,
  `ts` and `result` `jev`, `fallback` or `shadow`; it is written by the Jev compaction module when the
  compaction point is enabled, see `docs/HOOKS.md`). Defaults: `$CLAUDE_CONFIG_DIR/projects`, else
  `~/.claude/projects`, and `$OMC_JEV_LOG_DIR/compaction.jsonl`, else `.omc/state/jev/compaction.jsonl` under
  the current directory (run the tool from the project root). With `OMC_STATE_DIR` set, the Jev log directory
  has a project identifier in its path: pass the file with `--compact` or set `OMC_JEV_LOG_DIR`.
- Only `compaction.jsonl` is read. `OMC_JEV_LOG_MAX_MB` rotates the journal into `compaction-<YYYYMMDD-HHmmss>-<pid>.jsonl`
  files next to it; the rotated files are not read, so a period that spans a rotation loses the older journal
  rows and those units are counted as `host`. Check the rotation setting before you read a long period.
- `--probe <file>` is the result of `compaction_ask_probe.py --details --out <file>`, run with the same
  `--to` and `--days` and the same transcript files.

```
python3 -I tools/diagnostics/compaction_harm_monitor.py [--projects <dir>] [--transcript <file>]... [--compact <file>] [--to <ISO>] [--days 7] [--probe <file>] [--json]
```

`--transcript <file>` (repeatable) replaces the search under `--projects`. A `--transcript` path that cannot be read
(missing, a directory, no permission) stops the run with exit 2 and a message that names it, before any report is
printed, so a mistyped path never gives an empty report; the same holds for a `--projects` directory that is missing
or cannot be read when the transcripts are searched (no `--transcript`); a transcript found by the search that
cannot be read is skipped with a warning on stderr.

## Units and signals

A unit, its group (`jev`, `fallback` or `host`, times `main` or `subagent`) and the pairing with a journal row
are the ones of the ask probe. The state after a compaction is the user and assistant rows after the boundary
up to the first `api-request` row. A call is all assistant rows that share one `message.id`; only calls first
seen after the state count.

| Signal | Definition | Flagged when |
|---|---|---|
| `empty_series` | the longest run of empty calls (no non-blank text, no `tool_use`) among the first 10 calls after the state; text or a tool call ends a run | defined from 3 calls; flagged at a run of 3 |
| `tool_errors` | the share of `tool_result` blocks with `is_error` among the first 10 `tool_use` blocks after the state | defined from 3 results; flagged at a share of 0.5 |
| `fallback_run` | the number of consecutive `fallback` rows of the journal in one thread, ending at the unit's own row (a `jev` row resets the run) | defined only for group `fallback`; flagged at 5 |

The thresholds are options (`--window`, `--tool-window`, `--series-min`, `--min-tool-results`,
`--error-share-min`, `--fallback-run-min`) and the rule is fixed in the script docstring before a measurement.

## Output

Per group and signal: the number of units, how many have the signal defined and how many are flagged. With
`--probe`, also `n`, `tp`, `fp`, `fn`, `tn`, the agreement with `ask_lost` with 95 % Wilson bounds, the lost
share among flagged units (`selective`) and the flagged-and-lost units over all joined units (`per_query`),
plus the counters `monitor_only`, `probe_only` and `group_mismatch` (a value other than 0 means another period
or another set of files). With `n` below 30 the verdict is `no threshold` and the rates are hidden. With `n`
of at least 30 the verdict is `correlated` only when the lower Wilson bound of the lost share among flagged
units is above the upper Wilson bound of the lost share among unflagged units; otherwise `no correlation` and
the signal is dropped (agreement alone depends on the base rate). The report also counts the lines it could not
read, as `input.journal` and `input.transcripts` (`rows`: lines that are JSON objects, `bad_lines`: the other
non-empty lines), and the text report prints them on its `input:` line. A journal that has lines but none that is
a JSON object (a wrong file or a wrong format) still exits 0, but every unit then counts as `host` and a warning
goes to stderr. Exit codes: 0, 2 (a usage error or a missing or unusable input file).

# User prohibitions after compaction

`user_prohibitions_after_compaction.py` counts how many times a tool call that changes state matches an
explicit prohibition the user gave earlier in the same session, after a compaction boundary. A candidate is
a call that matches a prohibition, not proof of a breach: the reader decides. It is a standalone offline
diagnostic run by hand; the report holds no message text, command or transcript path; the `--locators` file
holds the transcript path of each candidate.

## Requirements and usage

- `python3` (standard library only). Run it in isolated mode with `python3 -I`.
- Inputs are only read: transcripts under `--projects` (default `$CLAUDE_CONFIG_DIR/projects`, else
  `~/.claude/projects`; subagent transcripts are counted, not read) and, optionally, the compaction journal
  `--compact-log` (rows with `event` `compact`, result `jev` or `fallback` and no `agent_id`; the journal is
  described under the harm monitor above). Only the file given as `--compact-log` is read: when
  `OMC_JEV_LOG_MAX_MB` has rotated the journal, the older rows are in the rotated files next to it, which are
  not read, so the Jev boundaries of that period are undercounted. The files written are `--out` and
  `--locators`, both new files with mode `0600`; they must be two different paths, and when the second write
  fails the first file is removed again.

```
python3 -I tools/diagnostics/user_prohibitions_after_compaction.py [--projects <dir>] [--compact-log <file>] [--to <ISO>] [--days 7] [--rule 1|2|3] [--patterns <file>] [--out <file>] [--locators <file>]
```

Without `--out` the JSON report goes to standard output and the summary line to standard error. Exit codes: 0,
2 (a usage error, an unreadable input, a bad `--patterns` file or an output file that already exists).

## What is counted

The full rules (a to f for rule 1, then rules 2 and 3) are in the script docstring, written before a
measurement. In short:

- A compaction is one boundary. A journal row and a transcript `compact_boundary` of the same session that are
  at most 600 s apart are the same compaction (the pairing rule of the ask probe and the harm monitor: closest
  pair first, each side used once). A transcript boundary paired with a `jev` row is a Jev boundary; every
  other transcript boundary, including one paired with a `fallback` row, is a host boundary. A `jev` row of the
  period that pairs with no transcript boundary is a Jev boundary on its own.
- A user message is a `user` row without `isMeta`, `isCompactSummary`, `isVisibleInTranscriptOnly`,
  `toolUseResult` or a `tool_result` block; reminder fragments are cut from its blocks.
- The default prohibition wording covers every class except `other`: `don't` or `do not` followed by touch, modify, edit, change, commit, push, delete, remove, restart, run, deploy, merge or install, plus `never install`, `no installing` and `no installs`. `other` has no default phrase and exists for wording in a `--patterns` file.
- A prohibition is a user message that matches a prohibition pattern; it has targets (backtick text, absolute
  paths, file names with an extension) or is general. A candidate is a `Bash`, `Edit`, `Write`, `MultiEdit` or
  `NotebookEdit` call after the first boundary that follows the prohibition and matches its class (`edit`,
  `delete`, `commit`, `push`, `restart`, `run`, `install`, `deploy`, `merge`; `other` never gives a candidate
  under rule 1). Each call counts once, for the earliest matching prohibition, under rule 1. `commit`, `push`
  and `merge` match a `git` command whose subcommand is a whole word after any git options; `-C`, `-c` and the
  long options that take a value (`--git-dir`, `--work-tree`, `--namespace`, `--config-env`, `--attr-source`) skip
  it, so `git -c commit.gpgSign=false status` and `git -C commit status` have no `commit`. A Bash command is read as
  the shell reads it, for every class: a word is a command only at the start of the text or after `;`, `&`, `|`, `(`,
  `)`, a backtick or a newline, after launch wrappers with their options (`sudo`, `doas`, `env`, `command`, `nohup`,
  `exec`, `time`, `nice`, `timeout`, `xargs`, `VAR=x` assignments) or reserved words (`if`, `then`, `do`, `!`, `{`), after
  `find -exec`, and in the string of `sh -c`, `su -c` or `ssh host '...'` (two levels deep). A command name in the
  arguments of another command, in quotes, in a `#` comment or in a here-document body is text, so `echo "git commit"`,
  `rg 'git commit' README.md`, `grep rm f` and `echo "npm install x"` give no candidate, while `bash -c "git commit"`,
  `timeout 30 git push` and `ssh host 'systemctl restart web'` do. A here-document that a shell takes as its input
  (`bash <<EOF`), a command substitution inside double quotes (`echo "$(git commit)"`; an unquoted `$(...)` and
  backticks are read, and so is the usual `git commit -m "$(cat <<'EOF' ... EOF)"`, whose `git` stands outside the
  quotes) and `docker exec` or `kubectl exec` are not read. The general `deploy` class also counts the word
  `deploy` in the name or arguments of a command that is not read-only (`npm run deploy`, `./deploy.sh`, not
  `grep deploy README.md`).
- Rule 2 cuts more fragment kinds (counted in `removed_fragments`), flags a prohibition revoked in its own
  message, matches general prohibitions by the kind of call (a `Bash` command is read-only or state-changing by
  its first word, and a `>` or `>>` redirection to a file outside quotes and comments makes it state-changing:
  `echo '>'`, `grep ">" README.md` and `ls # > x` are still read-only), and counts pairs (prohibition, call); `--locators` then has one row
  per prohibition with a candidate and a `history_group` hash that copies of the same message share. Rule 3 (the
  default) changes only the revocation check: explicit permission only, no revocation in a question, none after a
  negation.

## Wording as data

Everything that depends on a language is a list of regular expressions, not code. The English defaults are in
`DEFAULT_PATTERNS` in the script; `--patterns <file>` reads a JSON object whose keys replace the default list
of the same name as a whole (a key that is absent keeps its default):

| Key | Content |
|---|---|
| `prohibitions` | `[regular expression, class]` pairs in matching order |
| `revocations_v2` | revocation wording of rule 2 (a negation before the phrase is part of each pattern) |
| `revocations_v3` | explicit permission phrases of rule 3 |
| `permission_words`, `question_starts` | a sentence with a permission word that ends with `?` or starts with a question word does not revoke. Defaults: the words of the default permission phrases (`go ahead`, `may`, `can`, `allowed`, `permitted`, `permission`) and a modal or auxiliary verb followed by a pronoun (`can you`, `could we`, `may I`, `should we`, `do you`, `is it`, ...), so `Don't deploy. Can you go ahead with analysis?` keeps the prohibition and `You may now deploy.` lifts it. An empty list switches the exception off |
| `negations` | words that, directly before a revocation phrase, cancel it (default `not`) |

Patterns are matched case-insensitively. A pattern that does not compile, an unknown key or an unknown class
exits 2.

## Output

The report (template `compaction-report/1`, metric `user-prohibitions`) holds only numbers: the period, the
files and sessions, the boundaries (`host`, `jev`), the user messages (in the period, before a boundary, with a
prohibition), the prohibitions (total, with a target, general, by class, revoked in the same message), the
candidates (total, by class, by tool, by boundary kind, sessions with a candidate, unique calls, prohibitions
with a candidate, history groups), the data quality counters and the method limits.

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

# Hook latency p95

`hook_latency_p95.mjs` prints the number of samples, p50, p95 and maximum of the run times of OMC hooks that do not call a
model, read from the hook logs of the last N days, as tab-separated text. Percentiles use the nearest-rank method. It is a
standalone diagnostic run by hand. It reads files only, does not change OMC behaviour and is not shipped in the npm package.
The header of the script lists every option and rule.

```
node tools/diagnostics/hook_latency_p95.mjs [--days 7] [--hooks-json hooks/hooks.json --hooks-json ~/.claude/settings.json]
node tools/diagnostics/hook_latency_p95.mjs --dir <Jev log dir> --shell-checks-dir <shell-checks dir> --process-max-ms 150
```

| Option | Meaning |
|---|---|
| `--dir <dir>` | Jev log directory (`OMC_JEV_LOG_DIR`, default `state/jev` under the state root plus `~/.omc/state/jev` for `hook-timing*.jsonl`, see below); a directory that was given must exist and is the only one read |
| `--shell-checks-dir <dir>` | shell-checks directory (`OMC_SHELL_CHECKS_LOG_DIR`, default `state/shell-checks` under the state root); a directory that was given must exist |
| `--days <N>` | window in days (`HOOK_LATENCY_DAYS`, default 7); a log file whose last change is older than the window is not read |
| `--hook-max-ms <ms>` | limit for the hook logic time (`HOOK_LATENCY_HOOK_MAX_MS`, default 40) |
| `--process-max-ms <ms>` | limit for the whole-process time of `hook-timing.jsonl` rows (`OMC_HOOK_PROCESS_MAX_MS`, no default; an empty value is no limit) |
| `--total-max-ms <ms>` | limit for the `TOTAL` row (`HOOK_LATENCY_TOTAL_MAX_MS`, default 60) |
| `--hooks-json <file>` | a `hooks.json` or `settings.json` (repeatable): the hooks in its `hooks` section are named `Event:script` and listed with `n` 0 when no log has a time for them. Both forms of a hook are read: one `command` text, or `command` plus the array `args` as in `hooks/hooks.json` |
| `--now <ISO time>` | end of the window (`HOOK_LATENCY_NOW`, default the system clock); for tests |
| `--help`, `-h` | print the options and exit with code 0 |

Exit codes: `0` success, also when there are no samples; `2` bad argument, a log directory that was given and is missing or is not a directory, an unreadable log file or an unreadable `--hooks-json` file.
The window, the directories and files read, and the row counts go to stderr.

## Default directories

Without `--dir` and `--shell-checks-dir` (or their variables) the tool uses the directories of the hooks: `state/jev` and
`state/shell-checks` under the state root of the current directory, which follows `OMC_STATE_DIR` like the hooks do, so run it from the
project root. When the state root cannot be resolved the home directory is used (`~/.omc/state/jev`). A default directory that does
not exist is skipped, so the tool then shows no samples for it.

`scripts/run.cjs` does not resolve the project state root: without `OMC_JEV_LOG_DIR` it writes `hook-timing.jsonl` to `~/.omc/state/jev`,
which is not the project's default directory. So when neither `--dir` nor a non-empty `OMC_JEV_LOG_DIR` is given, the tool also reads
`hook-timing*.jsonl` (only those files) from `~/.omc/state/jev`; a file reached through both directories is read once. To read one
directory only, pass `--dir` or set `OMC_JEV_LOG_DIR`, and set the same variable for the hooks when you switch on `OMC_HOOK_TIMING`.
The directories and files read are listed on stderr.

## Input format

Only these logs are read, and only the time field and the field that selects the row. Rotated files
(`<name>-YYYYMMDD-HHMMSS.jsonl`, with `-<pid>` appended for the Jev logs) are read as well. A line that is not JSON, or has no
text `ts`, is counted as unparsable; a row whose time is missing, not a number, negative or not finite is counted as without a usable time.

| Log | Directory | Rows used | Time field | Kind |
|---|---|---|---|---|
| `hook-timing.jsonl` | Jev log directory (and `~/.omc/state/jev` when no directory was given) | every row `{ts, hook, ms}` written by `scripts/run.cjs` when `OMC_HOOK_TIMING=1` (see [Hooks](../../docs/HOOKS.md)); grouped by `hook` | `ms` | `whole` |
| `checks.jsonl` | shell-checks directory | rows with `point` `shell-check`, one per Bash or PowerShell command the `pre-tool-enforcer` checked | `durationMs` | `partial` |
| `compaction.jsonl` | Jev log directory | rows with `event` `compact` | `duration_ms` | `model` |

`hook-timing.jsonl` exists only after `OMC_HOOK_TIMING=1` has been set; without it the other two logs give only the two rows below.
`shadow.jsonl` is not read: its `durationMs` is the wait for a model answer.

## Kinds and flags

- `whole`: the time of the whole `run.cjs` process, node start included. Rows are judged against `--process-max-ms` only: `NO_PROCESS_LIMIT` without a limit, `TOO_FEW_SAMPLES` with a limit and fewer than 30 samples, `OVER` above the limit, otherwise empty. A script that also has a `partial` row (the enforcer) is named `<name> (process)`.
- `partial`: only the shell checks inside the enforcer, so the figure is a lower bound for that hook. The flag is `OVER` above `--hook-max-ms` and otherwise `LOWER_BOUND_ONLY`: a lower bound can never show that the hook meets the limit.
- `model`: the compaction module including its model calls. It is shown with the flag `n/a`, not compared with a limit and not part of the total.
- `none`: a hook listed by `--hooks-json` for which no log has a time. It is never estimated.

The `TOTAL` row is the plain sum of the p95 of the measured `partial` hooks (with these logs, the shell checks of the enforcer alone;
`whole` rows are on another scale and are left out). It is not the p95 of a tool call and not a bound: percentiles are not additive, the hooks run at different rates,
and hooks without a time are missing from it. Its source column states the coverage (measured hooks of all listed hooks; the listing needs `--hooks-json`). The flag is `OVER` above `--total-max-ms`, otherwise `PARTIAL_COVERAGE`.
When `hook-timing.jsonl` has rows, a `TOTAL_PROCESS` row follows with the sum of their p95, flag `NO_VERDICT` (information only, same caveats, no limit).

## Output

One header line and then one line per hook: `hook`, `source` (`<log>:<field>`, or `-`), `kind`, `n`, `p50_ms`, `p95_ms`, `max_ms`, `flag`.
An empty cell is `-`. The `n` of a `TOTAL` row is `-`.

# Check classifier

`check_classifier.mjs` is a pure ESM library (no imports, no state, no I/O) for offline diagnostics. It classifies a shell
command as a check (`test`, `lint`, `typecheck` or `build`), classifies the tool result of a check as `passed`, `failed` or
`undetermined`, and tells whether a tool call changes code. It is not wired into any hook, has no switch and does not change
OMC behaviour. It is not shipped in the npm package.

It does not duplicate `scripts/lib/shell-checks.mjs`: that module denies malformed shell commands at hook time (length,
syntax, here-documents), while this one only classifies commands, results and writes after the fact.

```
import { classifyCommand, classifyCheckResult, isMutation } from './tools/diagnostics/check_classifier.mjs';
```

| Export | Meaning |
|---|---|
| `classifyCommand(command)` | `{ isCheck, kind, runner, narrowed, exitHidden, chained, piped, pipefail, reason }`. A runner counts at the start of a shell piece after launch wrappers (`env`, `timeout`, `npx`, `uv run`, ...); comments and printing commands (`echo`, `cat`, `grep`, `git`) name no check, and a quoted string is one word: it cannot join the words around it into a runner name or split the command (`git commit -m "npm test"` names no check), yet it stays an argument, and a quoted command word is still that command (`"pytest" -q`). `narrowed` is set for flags that weaken a check (`--passWithNoTests`, `--exclude`) and, for tests, for options that run only some of the tests or none and for file arguments, quoted or not. The options are listed per runner (pytest: `-m`, `-k`, `--lf`, `--sw`, `--deselect`, `--ignore`, `--collect-only`; vitest, jest and bun: `-t`, `--changed`, `--onlyChanged`, `--findRelatedTests`, `--shard`, `--testPathPattern`, `--project`; mocha: `--grep`, `--fgrep`, `--invert`, `--dry-run`; go: `-run`, `-skip`, `-short`, `-list`, with one or two dashes and an optional `test.` prefix; cargo: a test name filter, `--lib`, `--bins`, `--doc`, `--test`, `-p`, `--skip`, `--ignored`, `--no-run`; also node:test, unittest, ava, dotnet, rspec, mix, phpunit, deno, ctest, xcodebuild, swift, tox and nox), and a package manager or `make` is read for the long options of all of them; options that only reorder, stop early or tune a run (`--ff`, `-x`, `--bail`, `--maxfail`, `-timeout`) select nothing. A file argument narrows too (`src/a.test.ts`, `"tests/my dir/a.py"`, `tests/a.py::test_x`). `exitHidden` is set when `&`, `\|\|` (after the check, or before it: `build \|\| npm test` exits 0 without running the check), a pipe without `pipefail` into anything but `tail`, or a separator with a successor hides the runner's own exit status. `chained` is set when the status stays visible but another command may have produced it: one joined to the check by `&&` (`false && npm test` never runs the check, `npm test && false` fails after it) or, under `pipefail`, one piped into it; `set`, `export`, `unset`, `true`, `:`, `tail` and an `echo` or `printf` without a redirection cannot fail in practice and do not count (`cd` can). `piped` is set when the check feeds a pipe without `pipefail`, so `$?` after it is the last command's |
| `classifyCheckResult({ command, output, isError, exitCode })` | `{ verdict, reason, rule }`. Zero tests run and narrowed checks stay `undetermined`; a failure in the runner summary wins over a zero exit and over a zero-test report; a visible exit status decides, except that a nonzero status of a `chained` command stays `undetermined` (rule `chained-exit`): only a failure line of the runner names the check; a zero status of a chain means every command passed; when the status is hidden, a printed exit code (`echo $?`, which a `chained` command can only confirm when it is 0, and which behind a pipe without `pipefail` counts only as `${PIPESTATUS[0]}`) or the runner summary in the last 6000 characters of the output decides |
| `isMutation(toolName, toolInput)` | true for `Write`, `Edit` and `MultiEdit` (target in `file_path`) and `NotebookEdit` (target in `notebook_path`, else `file_path`; a `.ipynb` file is code) on a code file, and for `Bash` commands that write a code file by redirection, `tee`, a here-document or in-place `sed` / `perl`. For a here-document the body is cut out and the rest of the line with the `<<TAG` operator stays, so `cat <<EOF > src/a.ts` and `cat <<EOF \| tee src/a.ts` write `src/a.ts`; several operators on one line take their bodies in order, and `<<<` and an operator with no terminator line are not here-documents. A write target is read as the shell reads it, with its quotes removed and an escaped space kept in the name, before the ignore rules apply: `echo x > "README.md"`, `tee 'package-lock.json'` and `printf x >> "/tmp/x.ts"` are not code, and `> "my docs/a.md"` is one target. `tee`, `sed` and `perl` count only as the command word of a command: first in the text, after `;`, `&&`, `\|\|`, `\|`, `&`, `(`, a backtick or a newline, after launch wrappers with their options (`sudo`, `doas`, `env`, `command`, `nohup`, `exec`, `time`, `nice`, `timeout`, `xargs`, `VAR=x` assignments) or a reserved word (`then`, `do`, `if`, `!`, `{`), and after `find -exec`; so `rg tee src/a.ts`, `echo sed -i x src/a.ts` and `grep mv src/a.ts` write nothing, and a `#` comment holds no command and no redirection. `cp`, `mv` and `install` write their destination (the value of `-t` / `--target-directory`, else the last operand; a destination known to be a directory, with `-t`, a trailing `/` or several sources, is joined with the name of each source, so `cp README.md src/` writes `src/README.md`), `truncate` writes its file operands (not the value of `-s` or `-r`) and `dd` writes the value of `of=`, each on the same command word rule and through the same ignore rules; `--help`, `install -d` and a command with no destination write nothing, and `mv` also removes its source, which counts as no write, like `rm`. `ln`, `rsync`, `git checkout` and `git mv` are not scanned. A shell or `su` with `-c` (`sh -c '...'`, `bash -lc`, `sudo sh -c`, `env FOO=1 bash -c`, `su -c`, also by absolute path) runs a command string, which is read again by the same rules, two levels deep and up to 100000 characters; `ssh host '...'` runs on another machine and is not read, so a code edit sent that way is not counted. For an in-place edit (`-i`, `-i.bak`, `-i ''`, `-ni`, `-pi`, `--in-place[=SUFFIX]`) the file operands are the targets: options, `-e` / `-f` scripts and the script operand are skipped, and a command with no file operand (`... \| xargs sed -i ...`) counts as code. Documentation, images, lockfiles, logs, temp directories (`TEMP_DIRS`), `/dev/null` and `$TMPDIR` are not code. A command substitution inside double quotes (`echo "$(tee src/a.ts)"`) is quoted text and is not read; an unquoted `$(...)` and backticks are |
| `RULES_VERSION`, `TEMP_DIRS` | the rules version string and the temp directories whose writes hold no code |

Runner summaries are read for node:test, pytest, vitest, eslint, ruff (the same rule reads mypy and biome counts) and tsc. A
summary line counts only for the detected runner: a passing `vitest run` that prints `Found 3 errors.` is not a failure, and
`All checks passed!` behind `pytest | tail` is not a pass. A package manager (`npm`, `pnpm`, `yarn`, `bun`) or `make` runs a
script of unknown content, so it reads the runners that fit the kind of the check (`test`: vitest, jest, node:test, pytest;
`lint`: eslint, ruff; `typecheck`: tsc, ruff; `build`: tsc). A runner that is not listed reads no summary, so only its visible
exit status or a printed exit code decides. The zero-test reports (`Tests: 0 total`, `No tests found`, `no tests ran`,
`ℹ tests 0`, `[no tests to run]`, `running 0 tests`) follow the same rule, and they stand only without real results in the output (a line that counts a test as passed, failed or skipped, such as `Tests  2 failed | 1 passed (3)`): `No tests found` printed by a test, or by one child of a script, does not hide the run. A report alone leaves the check `undetermined` whatever the exit status, because the runners exit nonzero themselves when they find no test. An option value that looks like a file (`--config vitest.config.ts`, `-c pytest.ini`) is read as a file operand and narrows a test run, because the classifier does not know which options take a value. Gradle and Maven are not recognized on purpose:
their lifecycle goals can also publish, so an exit code proves less there. A command with several runners (`tsc; vitest run | tail`) is
read for the last one, whose status is the command's, so the summary lines of an earlier runner do not count.

# Advisor event coverage

`advisor_event_coverage.py` measures whether a session called the advisor near the events where the advisor rule asks for it: a
plan, a series of failures and the end of the session. It reads Claude Code transcripts and writes counts only (no message text,
command or file path in the report). It is a standalone offline diagnostic run by hand: it does not change OMC behaviour, has
no switch and is not shipped in the npm package.

## Requirements and usage

- `python3` (standard library only). Run it in isolated mode with `python3 -I`.
- The transcripts are only read. The only files written are `--out` and `--sessions-out`: each must not exist before the run
  and is created with mode 0600.

```
python3 -I tools/diagnostics/advisor_event_coverage.py --projects <dir> --label <text> [--since <ISO>] [--until <ISO>]
python3 -I tools/diagnostics/advisor_event_coverage.py --projects <dir> --label week-47 --consult-command my-advisor --out report.json --sessions-out sessions.json
```

| Option | Meaning |
|---|---|
| `--projects <dir>` | required: transcripts laid out `<dir>/<any depth>/<session>.jsonl`; files with a `subagents` directory on the path are counted and never read. A directory that is missing, is not a directory or cannot be read exits 2 |
| `--label <text>` | required: written to the field `label` of the report |
| `--since`, `--until` | ISO 8601 window `[since, until)`; without an offset the time is UTC. The window limits what is counted, not the numbering of calls |
| `--consult-command <name>` | Bash command that counts as a consultation (kind `bash-<name>`); repeatable, none by default. It matches the first word of the command after leading `NAME=value` assignments, never a prefix |
| `--declaration-prefix <text>` | prefix of the lines an agent writes after a consultation (default `ADVISOR:`, leading whitespace allowed); counted beside the consultations, not as consultations |
| `--report-prefix <text>` | prefix of the first line of a final report (default `STATUS:`); a text block with such a line is an `end` event |
| `--out <file>` | write the JSON report to a new file; without it the report goes to stdout |
| `--sessions-out <file>` | write the list of main sessions that have, in the window, at least one `advisor` call or declaration line: a JSON list (ASCII only), sorted by session id, with the fields `session`, `model_class`, `transcript` (absolute path, the only place where a transcript path is written), `fired` and `advisor_rows`. It must not exist and must differ from `--out`; the report is the same with or without it |

Exit codes: `0` normal run, `2` usage error, invalid time, unreadable input, an output file that already exists, or a write error (a write error removes the files
the run created). The output directories are checked before the input is read.

## Input format

- The main transcript `<session>.jsonl` rows of `type` `assistant` and `user`, as in the session comparison tool above: `message.content` blocks
  `text`, `tool_use`, `server_tool_use` (the advisor tool block is `server_tool_use` or `tool_use` named `advisor`) and `tool_result` with `is_error`,
  `message.model`, `message.id`, `uuid` and `timestamp`.
- Not created by OMC itself and read only when you use the convention: the declaration lines (`--declaration-prefix`), the report lines
  (`--report-prefix`) and Bash consult commands (`--consult-command`). Without them the tool counts the `advisor` tool calls only.

## What is counted

- Session class: the most frequent `message.model` of the assistant rows (`<synthetic>` and empty models ignored; a tie goes to the
  alphabetically first model): `glm` for a name starting with `glm-`, `haiku` for a name containing `haiku`, `claude` for any other
  model and for a session without a model. Every count is given per class and in `total`.
- Events: `plan` (`ExitPlanMode`, a `Write` or `Edit` of a plan or brief file, the first `TodoWrite`), `failures` (the second and each further
  consecutive `tool_result` with `is_error`, one event per series) and `end` (the last assistant text and each text with a report line).
- Distance: calls between the event and the nearest consultation of the same session, looking back for `plan` and `end` (after the previous event of that class)
  and forward for `failures` (before the next one). Events of one class at the same call position (two text blocks with no call between them) keep their
  order: the earlier is the previous event of the later, so one consultation covers only the first of them. Coverage is reported for the windows
  1, 2, 3, 5, 10, 20 and unlimited calls, with the one-sided lower Wilson bound for z = 1.645; below 30 events the share and the bound read
  `too little data` and the counts stay.
- Copies of one history (forked and resumed sessions) count once for the whole run: the first file in sorted path order owns a call id or a text;
  skipped copies are counted in `duplicates`. Positions and distances are still numbered over the whole file.
