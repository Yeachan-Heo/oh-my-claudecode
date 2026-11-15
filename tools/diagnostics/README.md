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
python3 -I tools/diagnostics/executor_outcome_metrics.py --transcript A.jsonl --provider-map glm-=zai --from 2026-11-01
```

| Option | Meaning |
|---|---|
| `--transcript <file>` | transcript of one session (repeatable). A file named `<session>/subagents/agent-<id>.jsonl` is a separate task with the session as `parent` |
| `--from YYYY-MM-DD`, `--to YYYY-MM-DD` | keep tasks whose first timestamp (UTC) is in the range; tasks without a timestamp are counted as `no_date` |
| `--provider-map PREFIX=NAME` | map a model name prefix to a provider name (repeatable, first match wins). Without a mapping the provider is `unmapped`; a task without any model name has `unknown` |
| `--test-pattern <regex>` | regular expression matched (`re.match`) to a Bash command segment after removing prefixes; replaces the built-in list of test runners |
| `--advisor-pattern <regex>` | regular expression for a Bash command segment that is an advisor consultation. The advisor tool block (`server_tool_use` named `advisor`) is always recognised |
| `--json` | JSON output instead of text |

Exit codes: `0` success (whatever the numbers), `2` usage error (missing file, bad date, bad
`--provider-map` entry, bad regular expression).

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
in parentheses, else a 3-digit number after a colon), then from the mapping of the `error` field
(`rate_limit` 429, `overloaded` and `overloaded_error` 529, `request_too_large` 413). Anything else is
`other`. A failed tool result is checked the same way; a result without `is_error` is never exhaustion.

## Final answer flags

The last main-thread assistant text is checked. Without such text the answer is `unmeasured`.

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
  thresholds are named constants at the top of the script and can be changed in the code.
- The tool does not know which transcript belongs to which task of a larger run; it measures the files given.
- Test-run detection is by command name only; use `--test-pattern` for other runners.
