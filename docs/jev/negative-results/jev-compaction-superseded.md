# Superseded calls in the Jev compaction: replacing an older tool result by a note

Negative result. Tried, measured, rejected. Not for merge.

This branch carries the code (`hooks/jev-compaction.mjs`, switched off unless
`OMC_JEV_COMPACT_TASKS` is `shadow` or `active`), its tests, and a measuring script with a
synthetic mode (`scripts/jev-negative-results/jev-compaction-superseded/`). The rule works as
designed. It finds almost nothing to replace in real transcripts, so it is not worth carrying.

## What it was meant to do

When the same file is read again, or the same read-only command is run again, the older result
is no longer the current one. The hypothesis: replace such an older result by a one-line note
("superseded by a later call"), for free and without asking Jev, and so shrink the conversation
before the compaction has to remove anything Jev rated as needed.

The same switch also holds a second rule (collapsing the calls of a task the agent marked as
completed). This document is about the first rule, the superseded calls. The second one is
mentioned only where the numbers touch it.

## How it worked

- **Hook and trigger.** `hooks/jev-compaction.mjs`, event `session.compact` (the host's automatic
  compaction, `/compact`, a plugin's request; main loop and subagents). The code sits in the
  section "superseded calls and calls of finished tasks"; the decision is `tasksPlan()`, the
  rule is `supersededCalls()`, the note is `supersededLine()`.
- **Switch.** `OMC_JEV_COMPACT_TASKS=off|shadow|active`, `off` when unset. `shadow` only adds
  counters to the compaction record (`tasks_superseded`, `tasks_superseded_chars`,
  `tasks_superseded_by_write`, `tasks_collapsed`, `tasks_collapsed_chars`, ...); `active` also
  applies the decisions.
- **Nothing is sent to Jev.** The rule is deterministic. Under `active` the superseded items are
  taken out of the questions Jev is asked about the other results (`tasks_not_asked`).
- **The rule.** An older call is superseded by a newer one only when:
  - both are `Read` of the same file, the same pages, exactly the same lines (a `Read` of other
    lines, or of more lines, supersedes nothing), the newer one has a text result at least as long
    that is not the host's "File unchanged since last read" reply; or
  - the older is a `Read` and the newer a `Write` of the whole file; or
  - both are the same `Bash`/`PowerShell` command that only reads (an allow-list of reading verbs,
    no redirection, no substitution, never a background command), the newer result is not an error
    unless the older one was, and not shorter than the older one; or
  - both are the same `Grep`/`Glob` input;
  - in the main loop only with no change of directory in between; `Grep`/`Glob` only with an
    absolute path.
  Never superseded: a `Write` or an `Edit`, a result that is not text, a result of a file the
  user names, anything in the last six messages or in the open tool loop, an item whose note would
  not be shorter than the item.
- **The note** (shape): `[compacted] Read(<path> lines 5-24) - result of <n> chars superseded by a
  later call (a write of the whole file | the same read | the same command)`.

## The questions sent to Jev

None. This part of the compaction does not ask Jev anything. It is code only, which is part of
why it looked attractive.

## How it was tested, and how to reproduce

1. Unit tests in `src/__tests__/jev-compaction-module.test.mjs` (describe block "superseded calls
   and finished tasks"): the rule, off/shadow/active equivalence, pairing of calls and results
   after the change. They pass with `OMC_JEV*` and `TYPESAFE_API_KEY` unset.
2. Measurement on real transcripts, without any API call:
   `scripts/jev-negative-results/jev-compaction-superseded/measure-superseded.mjs` runs the
   module's own `supersededCalls()` on Claude Code transcripts. For every simulated compaction
   point (each time the conversation grows by 1.4 million characters, plus the end) it takes the
   window of rows before the point, applies the rule, and counts: results superseded, characters
   saved (input + result - note), the saving as a share of the window, whether the older result
   equals the newer one, how many characters of the older result are lines the newer one does not
   contain (information that is gone), and whether distinctive words of that lost part reappear in
   the assistant's own words in the next 40 rows (a crude proxy for "still needed").
3. Synthetic mode: `make-synthetic.mjs <dir>` writes eleven invented transcripts, one rule case
   each (same lines, other lines, after an edit, rewritten by a whole-file `Write`, the host's
   "unchanged" reply, repeated read-only command, shorter second result, a command that writes, a
   change of directory in between, repeated `Grep`); `measure-superseded.mjs <dir>/*.jsonl`
   prints what the rule does to each. Expected output is in `expected-output.txt`.

The function is also visible live: with `OMC_JEV_COMPACT_TASKS=shadow` every compaction record
carries the counters.

## Results

### Real transcripts (the module of this branch)

Sample: 309 transcripts of one machine over about a week (9 main sessions, 298 files in
`subagents/` folders and 2 empty `agent-replay-*` files; a development workflow around Claude Code
plus a few non-code sessions): 69,167 rows, 110.6 million characters, 26,054 tool calls, of which
1,126 were `Read`. Measured on 327
simulated compaction points (47 with a window of at least 700,000 characters, about 175,000
tokens).

| Quantity | Value |
|---|---|
| Superseded results found (distinct events) | 12 in 26,054 calls |
| of which `Read` then whole-file `Write` | 10 |
| of which `Read` then the same `Read` | 2 (8 characters saved in all) |
| Repeated read-only `Bash`, `Grep`, `Glob` pairs that qualified | 0 |
| `Read` of the same file with exactly the same lines, again | 2 of 1,126 reads |
| Characters saved | 59,504 (about 14,900 tokens, chars/4) |
| Saving as a share of the conversation windows | 0.050 % (59,504 of the 118.3 M characters of all 327 windows, each event once); counting per window (14 applications, 76,705 characters; the last window of a transcript overlaps the one before it, so 2 events are counted twice): 0.065 % over all windows and 0.085 % over the 47 windows of at least 700,000 chars |
| Windows with any saving | 10 of 327 (7 of 47 big ones) |
| Largest share in one big window | 1.09 % |
| Median share | 0 |

(The largest share over all windows, 18.6 %, is a short 88,000-character window with one
rewritten file; it never reaches a compaction.)

What dominates the calls is `Bash` with commands that are different each time. The reason for the
near zero is visible in the call mix: repeated identical read-only commands did not occur, and a
file is almost never re-read with exactly the same lines, because the agent reads other lines or
edits in between. Variant check: a version of the rule that also lets a newer `Read` covering a
wider range supersede an older one (tried on a local copy of the module, not in this branch) added
one more event of about 300 characters on the same sample.

A second, smaller sample (14 transcripts, 35.8 million characters, three of them copies of one
agent test task) gave 0.106 % and 5 distinct events; it is not independent of the first and is
not used above.

### What the data say about the information replaced

In all 12 events the older result differs from the newer one (none is a plain duplicate). For 10
of them the older result is a file as it was before a whole-file rewrite; for the 2 `Read` pairs
it is a stale reading of a file that changed (4 characters saved each). About 59,500 characters
of results were replaced by notes. In 1 of the 12, words that only the old text held came back
within the next 40 rows (the proxy looks at the assistant's text and at tool inputs). Loss in the
sense of a result that was still needed was not shown: it was not followed up by replay, and the
effect of the active rule on a task was not measured. The synthetic scenario `04-read-then-write-whole-file` shows the mechanism: a rejected option written
in the file that was read is not in the rewritten file, and the note replaces the read that
contained it.

On the other side, the rule's guards worked in every synthetic scenario: other lines, a read
followed by an edit only, the host's "unchanged" reply, a command that writes, a directory change
in between, and a shorter second result all keep the older result.

### Live (our own setup)

- `OMC_JEV_COMPACT_TASKS` is `shadow` on the machine that produced the transcripts. In 35
  compaction records with the counters (2026-11-11 11:56 to 2026-11-12 02:08 UTC), the rule found 4
  candidate pairs, 2 of them past the "note must be shorter" filter: 2,691 characters of
  18,224,745 characters before compaction, 0.015 %.
- In the functional trial of the compaction (35 configurations of the trial runs and 12 acceptance
  configurations) the switch was `shadow` in every one. No variant ran with it `active`, so the
  effect of the active rule on a task result was never measured. That is the honest limit of
  this write-up: the loss side rests on the transcript analysis and the synthetic cases, not on
  an agent working with the notes.
- Earlier local checks of the module (a 4-transcript set, and 148 subagent copies) found no
  superseded result in the 4 and 48 among 148 subagent copies; the sizes were not recorded, and
  that set was chosen for the test, not drawn at random. It is the only measurement in which the
  rule fires often, and it is not part of the conclusion (see the limits below).
- For the second rule (completed tasks) the live shadow counters show 31 calls in 6 of the 35
  records, 108,154 characters, 0.59 % of the characters before compaction. That rule drops
  results by task state, not by a newer call, and its loss was not examined here; it is a
  separate question and not covered by this negative result.

### Limits of this measurement

- One machine, about a week, mostly `Bash`-driven work. A style with many `Read` and `Grep` calls
  could give more.
- The windows count characters of text, tool inputs and tool results, without the host's system
  prompt, so shares are slightly overstated.
- Only 47 of the 327 windows are the size of a real compaction (at least 700,000 characters);
  the rest are small windows of short subagents, and the median of 0 comes mostly from them.
- The 48 superseded results among 148 subagent copies come from a set chosen for the test, not
  drawn at random; they are not part of the conclusion, and a sample like that would have to be
  drawn properly to overturn it.
- The module is run with every protection that depends on the state of a real compaction
  simulated only in part (see the README of the script).

## Why it was rejected

- The saving is about 0.05 to 0.09 % of the conversation on a real, mixed sample (see the table
  for the two denominators), and 0 in the median window. In our judgement a rule should save
  several percent of the context to justify 460 lines of module code, a switch and a family of
  tests.
- Where it does fire, it is a whole-file rewrite, and there the older result is not a duplicate:
  it shows the file before the change. In our judgement dropping it is a small loss for a small gain.
- The case that makes the idea sound (the same read, again and again) is rare to begin with:
  2 of 1,126 reads repeated exactly the same lines. The module also has to exclude the host's
  short "File unchanged since last read" reply to a repeated `Read` (it points back to the first
  result, so it cannot stand for it); that reply did not occur in this sample.
- Of the 11 synthetic cases, 5 fire; the other 6 are guards. Each guard is correct, and each one
  also removes a case from the already small set.
- It was kept out of the target path: the Jev compaction reaches its size by scoring results and
  tracing the least needed ones. Superseded calls were never needed as a source of size.

What is used instead: nothing. The compaction asks Jev about every result, and a result that a
newer call repeats is simply scored and traced like any other.

## Related

- #4992 (merged): secret and private paths kept out of the compaction request; the same module.
- #4989: messages delivered during a tool turn through the compaction (open).
- #5013: optional archive of the results the compaction cuts or removes.
- #5008: elastic compaction target and a compaction moment chosen by Jev (closed, negative).
- This branch: `neg/jev-compaction-superseded`; the unsent feature branch it came from was
  `feat/jev-compaction-superseded` (never opened as a PR).
