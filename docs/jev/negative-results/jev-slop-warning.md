# Jev on the `slop-warning` point: acting on the answer, and asking once per batch

**Negative result. Tried, measured, rejected. Not for merge.**

This document and the scripts in `scripts/jev-negative-results/jev-slop-warning/` describe what happened when we let the `slop-warning` answer of Jev decide whether `[SLOP WARNING]` is shown, on one long-running Claude Code setup for about 25 hours. The code that acts on the answer is already in this repository (see [Where the code is](#where-the-code-is)); this branch adds no hook code. It adds the write-up, a counting script that reproduces the measurement from a Jev log, and a reference patch of one variant that is not in the repository.

## What it was meant to do

`pre-tool-enforcer.mjs` shows a `[SLOP WARNING]` message when a tool input contains fallback or workaround wording (regular expressions, English words only). Jev's `slop-warning` point asks the same question with a model. The hypothesis: Jev reads wording and context better than the patterns, so letting its answer decide would add warnings the patterns miss (shell commands that try one interpreter and then another, a compatibility shim described without the word "fallback") and drop warnings on harmless text. The expected cost was one request to Jev per tool call.

## How it worked

Hook: `PreToolUse`, `scripts/pre-tool-enforcer.mjs`, function `generateSlopWarning`. Trigger: every tool call of the main session and of its subagents, whatever the tool.

What is sent to Jev: the question below as a `noul` question, and the state `{toolName, toolInput}`. Every string in the state is cut to `OMC_JEV_EXCERPT_CHARS` (default 200 characters), so Jev sees the start of each field of the tool input, not the whole input.

What is done with the answer: the answer is a probability of "yes". With `OMC_JEV_SLOP_WARNING_APPLY=1` the hook shows the warning when the probability is at or above `OMC_JEV_SLOP_WARNING_THRESHOLD` (default 0.8) and does not show it below, in both directions: the answer replaces the pattern heuristic, so it can add a warning and remove one. Without the variable the hook still waits for the answer (in `active` mode the resolver runs synchronously) and discards it. If the call times out or fails, the heuristic decides.

Switches (`docs/HOOKS.md`): `OMC_JEV=slop-warning:active` (or `all:active`), `OMC_JEV_SLOP_WARNING_APPLY`, `OMC_JEV_SLOP_WARNING_THRESHOLD`, `OMC_JEV_APPLIED_LOG=1` (writes a line to `applied.jsonl` for each decision the answer changed), `OMC_JEV_LOG_CONTEXT=1`. Off: `OMC_JEV=...,slop-warning:off`.

In our run the threshold was 0.7, not the upstream default 0.8, and the hook was our local patch with the same behavior (both directions, applied log). The counts below are therefore for threshold 0.7; the script prints 0.5, 0.7 and 0.8 side by side.

## The exact question sent to Jev

From `SLOP_WARNING_QUESTIONS` in `scripts/pre-tool-enforcer.mjs`, one question named `slop_advisory`, type `noul`:

- instructions: `Does this tool input contain fallback/workaround language worth an advisory warning?`
- criteria, `true`: `Contains fallback/workaround phrasing outside doc or self-referential context`
- criteria, `false`: `No advisory-worthy language`

The warning text, unchanged from the heuristic version:

> [SLOP WARNING] Detected fallback/workaround language in this tool input. Do not make potential slop: avoid ad-hoc fallback layers, workaround shims, or environment-specific patches unless explicitly justified. For architecture concerns, consult the architect for a concrete design first. If this seems environment-specific, ask the user to confirm constraints before proceeding.

## How it was tested

Setup: one machine, one long-running Claude Code session on a work project with many subagents, all Jev points `active`, `slop-warning` with the answer deciding (threshold 0.7, both directions), `OMC_JEV_LOG_CONTEXT=1` and the applied log on. A local per-minute request limit skipped some requests (the `breaker` rows below). Window: the apply logging starts at 2026-11-10 23:14 UTC (first `applied.jsonl` line) and the point was switched off at about 2026-11-12 00:22 UTC.

What counts as success: the answer changes the decision often enough, and in the right direction often enough, to justify one request per tool call. We measured the first part on all traffic. For the second part we have only the labelled sample published in #4928, and we did not label the 55 changed decisions.

Reproduce the counts (no API, no key):

```bash
node scripts/jev-negative-results/jev-slop-warning/measure-decision-change.mjs --dir .omc/state/jev --day 2026-11-11 --threshold 0.7
```

`scripts/jev-negative-results/jev-slop-warning/README.md` explains the options, the synthetic log for a run without any real log, and how to collect your own log (`OMC_JEV=slop-warning:active`, `OMC_JEV_SLOP_WARNING_APPLY=1`, `OMC_JEV_APPLIED_LOG=1`, `OMC_JEV_LOG_CONTEXT=1`). Collecting a log needs your own `TYPESAFE_API_KEY` and costs one request per tool call; this branch does not call the API.

## Results

All counts below come from `shadow.jsonl` and `applied.jsonl` of that one setup, produced by the script above. They are one run on one setup.

**Day 2026-11-11 (UTC).** 22,039 `slop-warning` rows: 21,750 answered by Jev, 288 skipped by the local request limit, 1 degraded (the heuristic decided). Of the 21,750 answers:

| Probability of "yes" | Answers |
|---|---|
| below 0.2 | 19,719 |
| 0.2 to 0.5 | 1,781 |
| 0.5 to 0.7 | 199 |
| 0.7 to 0.8 | 30 |
| 0.8 or more | 21 |

The pattern heuristic fired on 3 of the 21,750. At threshold 0.7 Jev's answer differed from the heuristic in 52 cases: 50 warnings added, 2 removed. That is 0.24 % of the answered calls (0.236 % of all 22,039 rows). The applied log has the same 52 lines (50 and 2). Recomputed from the answers at other thresholds on the same day: 0.5 gives 251 changes (1.15 %), 0.8 gives 24 (0.11 %).

**Whole apply window** (2026-11-10 23:14 UTC to 2026-11-12 00:22 UTC): 23,207 answered calls, 55 changed decisions (53 added, 2 removed), 0.24 %. By tool of the call: SendMessage 17, Bash 16, a task-list tool 11, TaskUpdate 3, AskUserQuestion 2, Agent 2, Write 2, a state-write tool 1, TaskCreate 1. A figure of "55 changes on 22,039 queries" that we first quoted mixes this window with the UTC day; the rate is 0.24 to 0.25 % either way.

**Latency.** The hook waits for the answer. For the 21,750 answered calls of 2026-11-11: median 288 ms, 95th percentile 375 ms, maximum 2,005 ms. The per-call durations add up to 1.80 hours that day. Hooks of parallel subagents overlap, so this is not time lost by the session. An earlier report from the same setup (#4928, 24 October to 9 November) gave a median of 1,512 ms; we did not find why the two differ (different load, the local request limit and a changed timeout are candidates).

**Requests and tokens.** The provider's hourly usage export for the API key shows, for 2026-11-10 15:00 UTC to 2026-11-11 16:59 UTC (22 hours): 36,854 requests, 106.8 million input tokens, 3.0 million output tokens, for all Jev points together. In the same 22 hours, `slop-warning` is 17,656 of the 21,114 answered rows in `shadow.jsonl` (83.6 % of the rows of our Jev log). The key sent 36,854 requests in the same hours, so if each row is one request, `slop-warning` is at most about half of the key's requests (17,656 of 36,854, 47.9 %); the rest come from other points and logs. The export has no per-point split, and other points and logs also make requests, so we cannot give the tokens or cost of `slop-warning` alone. The average over all points is about 2,900 input and 81 output tokens per request.

**Quality of the answers (published earlier in #4928, not repeated work).** From a sample of about 150 rows of 30,019, labelled by two runs of one model and a third run that resolved disagreements (so not human labels), per 10,000 tool calls: the pattern heuristic gave 0.3 correct and 1.7 false warnings; Jev at 0.7 gave 15.9 correct and 21.4 false warnings (precision 42.6 %, interval 22.6 to 64.7), at 0.8 gave 3.2 and 2.5 (precision 55.9 %, interval 11.8 to 100). Most traffic in that sample was not English, which the heuristic's English word list cannot read.

**What we did not measure.** Whether the 55 changed decisions were right (not labelled). Whether any warning, added or removed, changed what an agent did. The functional trial we ran on 2026-11-11/12 on other features did not include this point. The token cost of this point alone.

### Variant: ask once per batch of tool calls instead of once per call

Because this one question was 83.6 % of the answered rows of our Jev log (and at most about half of the key's 36,854 requests in the same 22 hours, see above), a second variant moved it. The question was added as a seventh question (`slop`) to the query that a separate "panel" feature sends after each batch of tool calls (the panel has its own negative-result write-up, #5034); Jev chose in a second question whether the warning was shown, and the hook in `PreToolUse` stopped asking by itself. The warning then arrives after the calls, not before. This code is not in this repository and depends on the panel code, so it is attached as a reference patch (`scripts/jev-negative-results/jev-slop-warning/reference/t4-slop-in-panel-query.patch`; the question and the warning text in it are Polish, because that setup works in Polish; the `slop` question asks whether any of the last calls contains fallback or workaround wording that deserves a warning, and says no for documentation, instructions and plain technical descriptions). It was measured on logged sessions and labelled states, not deployed to the running setup.

- Requests to Jev per 1,000 tool calls, 2026-11-11 until 18:14 local time: 1,460 before (1,208 of them `slop-warning`, 128 panel), 252 after. The "after" figure is computed from the logs by removing the per-call requests, not measured live. Denominator 13,368 tool calls in 11,729 batches from the batch log; the `slop-warning` rows outnumber the batch log's calls (about 1.2 per call), so the denominator is understated. With a panel query after every batch the estimate is about 1,000 per 1,000 calls, still below 1,460.
- The 41 warnings the per-call version had logged by then, replayed through the batch variant: Jev answered "yes" to `slop` in 18 of 41 (44 %) and the warning was shown in 7 of 41 (17 %).
- Added latency of the batch query: median 199 to 202 ms, 95th percentile 486 to 502 ms (194 labelled states, same set). The old per-call query, from the same report (2026-11-11 until 18:14 local time): median 288 ms, 95th percentile 367 ms, one per call. The 95th percentile of 375 ms in the results above is for the whole UTC day of the same log; the two windows differ.
- There are no ground-truth labels for `slop` in the 194-label set, so we cannot say whether the 7 of 41 were the right warnings. One run of the replay, one run of the latency comparison.

## Why it was rejected

The answer changes the decision in about one tool call in 400 (0.24 %), its rows are 83.6 % of the answered rows of our Jev log (at most about half of the API key's requests in the same hours), and each one adds a synchronous wait (median 288 ms) to every tool call. Whether the changed decisions were right is unknown beyond the #4928 sample, where precision at the thresholds we used was below 60 % with wide intervals. The batch variant removes most of the requests but depends on a panel that the functional trial did not support, and it moves the warning after the calls it concerns. We decided on 2026-11-12 to switch the point off (`slop-warning:off`) and not to continue with either variant.

What is used instead: the pattern heuristic in `pre-tool-enforcer.mjs`, with no request to Jev. It fired on 3 of 21,750 calls on 2026-11-11.

Our recommendation: leave `OMC_JEV_SLOP_WARNING_APPLY` unset, and do not enable `slop-warning` in `active` mode without it, because the hook then waits for an answer it discards. This result is for one setup, mostly Polish-language traffic, threshold 0.7, and a model-labelled sample; it may not carry over to others.

## Where the code is

- `scripts/pre-tool-enforcer.mjs`: `SLOP_WARNING_QUESTIONS`, `generateSlopWarning`, `isSlopWarningApplyEnabled`, `resolveSlopWarningThreshold`.
- `scripts/lib/jev-shadow.mjs`: `jevNoulOf`, `recordJevShadow`, `recordJevApplied`.
- `src/features/jev-slop-warning.ts`: the TypeScript recorder (records only).
- `tests/integration/jev-advisory-points.test.ts`: tests of the opt-in behavior against a local stub of the Jev endpoint.
- `docs/HOOKS.md`: the variable table and "Advisory points: opt-in actions".
- Merged in #4935. This branch does not change any of it.

## Related

- #4935 (merged): opt-in actions on the slop-warning, learner-extraction, simplifier-trigger and loop-continuation answers.
- #4928 (issue, closed): the measurement and proposal behind #4935.
- #4805 (issue, closed): active points that wait for an answer and discard it.
