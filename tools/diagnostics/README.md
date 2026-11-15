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
