# Superseded calls in the Jev compaction: measuring script

Negative result. Tried, measured, rejected. Not for merge. Write-up:
`docs/jev/negative-results/jev-compaction-superseded.md`.

The rule under test is in `hooks/jev-compaction.mjs` (`OMC_JEV_COMPACT_TASKS`, off unless set).
Nothing here calls the Jev API: the rule is deterministic, so no `TYPESAFE_API_KEY` is needed and
the cost is zero.

## Files

- `measure-superseded.mjs`: loads the module (from a temporary copy beside it with one extra
  export line; the module is not changed), runs `supersededCalls()` on Claude Code transcripts
  (`.jsonl`), and prints per file and in total: results superseded, characters saved (input +
  result - note), the saving as a share of the window, whether the older result equals the newer
  one, characters of the older result that the newer one lacks, a "still needed" proxy (words of
  that lost part reappearing in the assistant's text or tool inputs in the next 40 rows).
- `make-synthetic.mjs`: writes eleven invented transcripts, one rule case each.
- `expected-output.txt`: the output of the synthetic run.

## Run

Synthetic transcripts (no private data):

    node scripts/jev-negative-results/jev-compaction-superseded/make-synthetic.mjs /tmp/superseded-synthetic
    node scripts/jev-negative-results/jev-compaction-superseded/measure-superseded.mjs /tmp/superseded-synthetic/*.jsonl

The output should match `expected-output.txt`.

Your own transcripts (read only; they stay on your machine):

    node scripts/jev-negative-results/jev-compaction-superseded/measure-superseded.mjs ~/.claude/projects/<project>/*.jsonl

Options: `--module <path>` (default: `hooks/jev-compaction.mjs` of this tree), `--window-chars N`
(size of a simulated compaction window, default 1,400,000 characters), `--json <file>`, `--quiet`
(totals only). A transcript under a `subagents/` folder, or named `agent-*.jsonl`, is treated as a
subagent. The rule is run with `supersededCalls(calls, () => true, win)`: the protections that depend on the state of a real compaction (files the user names, the open tool loop, items that go anyway) are simulated only in part, which can raise the number of events; it cannot hide them. Windows are formed by characters of text, tool input and tool results; the host's
system prompt is not counted, so shares are slightly overstated.

## Live counters

With `OMC_JEV_COMPACT_TASKS=shadow` each compaction record carries `tasks_superseded`,
`tasks_superseded_chars` and `tasks_superseded_by_write` (what `active` would do, nothing is
changed); `active` applies it. Both need only the existing compaction setup, no extra key.
