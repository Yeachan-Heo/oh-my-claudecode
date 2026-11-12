# Elastic compaction target and a compaction moment chosen by Jev

**Negative result. Tried, measured, rejected. Not for merge.**

This document accompanies PR #5008. The code of the feature is in that PR (`hooks/jev-compaction.mjs`, `src/hooks/jev/points.ts`, `src/hooks/jev/config.ts`, `src/__tests__/jev-compaction-module.test.mjs`). This branch adds only this document and a no-API reproduction kit in `scripts/jev-negative-results/jev-compaction-flex-moment/`. Nothing in the feature code was changed for this write-up.

The compaction module itself (the `compaction` point, #4940 and its fixes) is not part of this negative result. It is merged and in use. What was rejected are two additions on top of it, both opt-in and off by default.

## What it was meant to do

Two hypotheses about the `compaction` hooks module.

1. **Elastic target (`OMC_JEV_COMPACT_FLEX=active`).** A fixed target (`OMC_JEV_COMPACT_TARGET`, default keep 0.5) removes the same share of the conversation however little it grew since the previous compaction. When compactions come at chosen moments, that removes again what the last one just kept, and the agent has to read it again. The hypothesis: let the share kept follow the growth since the previous compaction of the same loop, so a small growth keeps more (up to 0.7 with the default target).
2. **Moment chosen instead of a fixed percent (`OMC_JEV_COMPACT_AT_PERCENT=jev`).** A fixed percent compacts wherever the context happens to cross it, often in the middle of a thread whose details the next turns need again, and often inside a tool loop, where the module has to hand over to the host's built-in summary (`thinking_in_tail`, `server_block_in_tail`). The hypothesis: ask the host to compact at the end of a turn that closed a stage of work, and let Jev judge when no task list shows a closing.

## How it worked

Elastic target:

- `elasticTarget(before, rule, prev)` (exported from `hooks/jev-compaction.mjs`) returns the effective target. The compaction frees the growth since the previous compaction of the loop, at least `MIN_REDUCTION` (30 % of the characters) and at most what the rule target frees. The first compaction of a loop in a process, an unknown start, a conversation that shrank, and a growth that reaches what the rule frees all keep the rule target.
- The start of the growth is the characters this module left (kept per loop in process memory; main loop and at most 63 subagents) or the conversation the built-in summary returned.
- Records get `target`, `rule_target`, `target_source` (`rule` or `growth`), `target_why`, `growth_start_chars`, `growth_start_source`, `growth_chars`, `room_chars`.
- Only the exact value `active` turns it on.

Moment chosen by Jev:

- Trigger: the `turn.complete` event of the main loop (never a subagent). The value `jev` replaces the numeric percent; on `dev` it parsed as "no percent".
- Gates before anything is asked: the context is past a level at which a compaction to the target could free `OWN_MIN_GAIN` (10 %) of the window; after a compaction the context grew by that much from its lowest usage since; the removable results are worth that much; the turn was not interrupted, refused or failed; no compaction is running.
- A task closed in this turn (a `TaskUpdate` to `completed`, or a `TodoWrite` / `update_plan` list with more done items than the list before it) asks the host to compact at once, without Jev.
- Otherwise the module asks Jev the `compaction-moment` question, at most once per 5 turns, and asks the host only on an answer of at least 0.7. The answer is rechecked afterwards (a main-loop compaction meanwhile, a newer turn, or a context now below the level turns the yes into "not now").
- The whole decision has a budget of 8 s from the end of the turn (`MOMENT_BUDGET_MS`); past it no request goes out.
- What is sent to Jev (`state`): `task` (the user's last words, lines naming a secret or private path omitted), `answer` (the first 200 and last 100 characters of the turn's answer, masked; left out entirely when a secret or private path is named by the answer, by the user's words, by a result of this turn, or by any call of the conversation), `list` (done and total items of the newest task list) and `context` (tokens and window). Never a tool result.
- Records: an `own_threshold` record per request (`result: requested`, with `moment: task | jev` and `level`) and per refusal (`result: not_now` with `reason` `jev_no`, `jev_error`, `timeout`, `no_answer`, `state_changed`, `cap`, `rpm`, `breaker_open`, plus `jev_noul` and `answer_skipped` when they apply); the compaction that a request started carries `own_request`.
- Switches: `OMC_JEV_COMPACT_FLEX=active`, `OMC_JEV_COMPACT_AT_PERCENT=jev`, on top of `OMC_JEV=compaction:active` (`compaction` is named-only, `all` never enables it) and `TYPESAFE_API_KEY`. The question counts toward `OMC_JEV_MAX_REQUESTS` and `OMC_JEV_MAX_RPM` like a compaction's.

## The question sent to Jev, verbatim

Point `compaction`, question `compaction-moment`, type `noul` (registry copy in `src/hooks/jev/points.ts`, mirror `MOMENT_INSTRUCTIONS` / `MOMENT_CRITERIA` in `hooks/jev-compaction.mjs`, locked together by a test). The text is English; there is no translation.

Instructions:

> Is the end of this turn a good moment to compact the agent's conversation? A good moment: work on the user's task (state.task) reached the end of a stage, and the answer that ended the turn (state.answer) closes a thread, reports a result or waits for the user's decision. A bad moment: the agent is in the middle of a thread and will soon come back to the details it just read or changed.

Criteria:

- `true`: Good moment: a stage of the work is closed; the details of the last steps will not be needed right away.
- `false`: Bad moment: work on the current thread goes on and will soon come back to fresh details.

The existing `result-need` question of the same point (a score per tool result) is not part of this feature.

## How it was tested, and how to reproduce

Four kinds of evidence, of very different strength.

1. **Unit tests in the PR** (`src/__tests__/jev-compaction-module.test.mjs`): the new tests cover the elastic arithmetic, closed-task detection, the Jev question and its secret-path rules, the time budget, races with other compactions, and the off state. Run with Jev switched off:

   ```
   env -u TYPESAFE_API_KEY -u OMC_JEV npx vitest run src/__tests__/jev-compaction-module.test.mjs
   ```

   They use a fake host and a fake Jev. No API call, no cost.
2. **Offline replays of real sessions with a stand-in for Jev** (two long main sessions and one subagent session of a long-running Claude Code work project, window 400 000 tokens, host threshold 367 000). The replay feeds the real transcripts through the module with a deterministic scorer in place of Jev (a 0-3 score from a digest of each result, the same in every variant; about half the results score below 0.5 by construction). Tokens after a Jev compaction are modelled as the tokens before minus 0.773 of what the forecast removes (the ratio measured on nine earlier compactions). The transcripts are private and are not shipped; this evidence cannot be reproduced from this branch.
3. **Live use, one working day** (11 November 2026): `OMC_JEV_COMPACT_AT_PERCENT=jev` active on a main session through a local variant of this logic, `OMC_JEV_COMPACT_FLEX=shadow`. Counts from the module's own log are below.
4. **A functional trial of whole compaction variants** ("trial F": an agent session resumed after a compaction, then a real task; time to completion and a check of the result). It was not designed to test this feature; the local variant of the moment logic was loaded in its runs and asked once (see Results).

### Reproduction kit (no API)

`scripts/jev-negative-results/jev-compaction-flex-moment/`, see its `README.md`:

- `replay-elastic-target.mjs` runs the exported `elasticTarget` on a series of conversation sizes and prints fixed against elastic. It shows the rule, with the simplification that a compaction leaves exactly the target; it does not measure anything.
- `summarize-compact-log.mjs` counts moment requests, refusals and answers and the elastic-target fields in a `compact.jsonl`. `--sample` uses a small synthetic file shipped with the kit.

Both need no key and make no network call. Running the moment question for real needs `TYPESAFE_API_KEY`, `OMC_JEV=compaction:active`, a session in an interactive terminal (in `-p`, SDK and desktop sessions the host refuses `$.session.compact()`), and costs one Noul request per asked turn, at most one per 5 turns.

## Results

### Offline replays (stand-in for Jev; one deterministic pass per variant, no repeats)

Source numbers are per variant of the replay; "read again" is the number of removed results the agent later opened again, from the real transcript. Because the scores come from a stand-in, these figures compare variants with each other and say nothing about the accuracy of the real Jev.

| Session | Variant | Compactions (module / built-in summary) | Own end-of-turn requests | Removed results read again |
|---|---|---|---|---|
| A (14 real compaction boundaries) | own 60 % threshold, fixed target | 17 (12 / 5) | 12 | 169 of 382 (44 %) |
| A | own 60 % threshold, elastic target | 19 (13 / 6) | 12 | 131 of 306 (43 %) |
| B (9 boundaries) | own 60 % threshold, fixed target | 9 (6 / 3) | 5 | 82 of 159 (52 %) |
| B | own 60 % threshold, elastic target | 8 (5 / 3) | 5 | 56 of 107 (52 %) |

- With the elastic target the module removed fewer results at a similar number of compactions (306 against 382 and 107 against 159), and fewer of the removed results were read again (131 against 169, 56 against 82). The share read again was the same (43 % against 44 %, 52 % against 52 %).
- The price is a larger conversation after each compaction. Mean tokens after a module compaction, own 60 % threshold: session A 233 144 elastic against 216 382 fixed (+16 762); session B 191 049 against 194 871 (-3 822). At the host threshold (no own requests) the elastic target changed almost nothing, because nearly every compaction there ended in the built-in summary: session A 231 431 against 218 996 after the module's compactions (+12 435), session B 217 385 against 210 919 (+6 466), with the same number of compactions (8 and 5).
- Compaction at the end of a turn was done by the module every time: 81 of 81 own requests over all variants of the two main sessions. Compactions at the host threshold ended in the built-in summary in 12 of 15 cases in the host-threshold variant (session A 6 of 8, session B 4 of 5, subagent 2 of 2); the reason was thinking in the tail in 9 of those 12 (`thinking_in_tail`), text over the threshold in 2 (`tekst_ponad_prog`), a server block in the tail in 1.
- Each figure rests on one pass over one or two real sessions. No variance was measured.

### Live use, 11 November 2026 (UTC; local variant, `OMC_JEV_COMPACT_FLEX=shadow`)

Counts from the module's own `compact.jsonl`, records stamped 11 November 2026 UTC only (132 records, 59 of them compactions). The log of the local variant has some Polish field values; they are mapped here as `jev_nie` = `jev_no` (Jev answered "not now"), `zadanie` = `task` (a closed task), `odpowiedz_pominieta: sciezka_sekretu` = `answer_skipped: secret_path`, `host_odrzucil_ture` = `host_refused`. `summarize-compact-log.mjs` maps the same names.

- 40 `own_threshold` records: 14 requests, all through a closed task (`moment: task`) and none through an answer of Jev; 20 questions to Jev, all answered and logged as "not now" (`jev_no`), the highest answer 0.62, none reaching 0.7, so 0 yes answers; 6 refusals by the host (2 of closed-task requests, 4 from an earlier numeric 60 % threshold).
- In 16 of the 20 questions the answer of the turn was left out of what was sent, because a secret or private path appeared somewhere in the conversation (`answer_skipped: secret_path`). In four fifths of the questions Jev judged the moment from the user's words, the task list and the token counts alone. An earlier live count in an earlier version of the local code was 5 questions, 0 yes, with the end of the answer missing in 3 of the 5.
- The 14 compactions started by a closed-task request all ended as a module compaction (14 of 14; three more on 12 November, after the day counted here, did the same).
- 59 compaction records that day: 25 `plugin` (the module's own request), 24 `auto`, 10 `manual`; 49 ended as a module compaction, 10 as the built-in summary.
- The elastic target never ran active on the live session. Three of the 59 compaction records carry elastic-target fields (two growth-based, one first compaction); how those three came to be written was not established. There is nothing to count about its effect.

So the part that did the work live was the closed-task rule, which does not use Jev; the Jev question produced no request in 20 asked turns.

### A later local redesign (not in this PR)

The separate question was later replaced, in a local branch, by a `moment` field in an end-of-turn query that already existed in another local feature. Technical check of that redesign on a copy of a session and on host 2.1.322: 0 separate questions about the moment, 0 empty answer fields in 40 last answers of the copy (12 of them had lines masked, the field stayed), the module found the end-of-turn file in the same turn 23 of 23 times (20 `-p` sessions and 3 interactive). It worked technically. It was not measured for effect and is not in this PR.

### Trial F (functional trial, night of 11-12 November 2026, 32 runs)

An agent session resumed after a compaction, then a real task in two stages: task 1 (the first task after the first compaction) and task 2 (a second compaction, then a merge with a conflict). Variants of the compaction: the host's built-in summary (S), the original compaction plugin (W), and a local compaction module (J) with a summary step by a small model (J with Haiku) or without it (J5off, Joff). Variants of support features: task-list reminders and a question panel. One or two runs per cell.

- **Run count.** The result file counts 32 runs with a result: 18 in task 1 and 14 in task 2. Working notes written earlier cite 28 runs; the final count is 32.
- **Time measure.** "Own work time" is the time from the start of a run minus all time spent in `ciezkie` calls (the lock wait and the tests together), as defined in the result file. The time from the start is given beside it, because the queue for `ciezkie` and competition for the processor are in it.
- **"Our compaction"** in this trial is that local module with the summary step, or without it, not the merged #4940 module.
- **This feature was not tested by a design for it.** In every cell `OMC_JEV_COMPACT_FLEX` was `shadow`. `OMC_JEV_COMPACT_AT_PERCENT=jev` was set in every cell, so the local variant of the moment logic was loaded and asked in the runs: the runs' own logs hold 22 `own_threshold` records in 16 run logs. One is a request by a Jev yes (`moment: jev`, run J5off-LP-3, at 39 063 tokens; no compaction record follows it in that run's log); 10 are "waiting for the backlog of scores" (`zaleglosc_ocen`); 11 are "not asked, no end-of-turn file" (`brak_pliku`). The effect of that one yes was not assessed, and the trial was not designed to compare it with a baseline. The compaction that produced each starting conversation was made beforehand, and the second compaction of task 2 was called by the test rig with trigger `auto`.

Task 1, per run (own work time, then time from the start, in seconds; "passed" is the relaxed check with the round rule of the result file):

| Run | Compaction | Support | Own work (s) | From start (s) | Passed |
|---|---|---|---|---|---|
| S-0-1 | S | none | 236.2 | 367.4 | yes |
| S-0-2 | S | none | 247.5 | 358.7 | yes |
| S-gole-1 | S | none, no OMC at all | 254.8 | 488.6 | yes |
| S-LP-1 | S | list and panel (old panel, without the brief) | 255.0 | 554.4 | yes |
| S-Ls-1 | S | list, panel in shadow | 264.6 | 370.7 | yes |
| S-P-1 | S | panel (old, without the brief) | 818.6 | 958.7 | yes |
| J-0-1 | J with Haiku | none | 247.7 | 355.5 | yes |
| J-0-2 | J with Haiku | none | 293.7 | 425.6 | yes |
| J-LP-1 | J with Haiku | list and panel (old panel, without the brief) | 320.4 | 616.5 | yes |
| J-LP-2 | J with Haiku | list and panel (old panel, without the brief) | 435.9 | 794.5 | yes |
| J4-LP-1 | J with Haiku | list and panel (with the brief) | 262.0 | 368.6 | yes |
| Joff-0-1 | J without Haiku | none, no OMC loaded in this stage | 267.1 | 702.6 | yes |
| J5off-LP-2 | J without Haiku | list and panel, no OMC loaded in this stage | 268.4 | 483.7 | yes |
| J5off-LP-3 | J without Haiku | list and panel, OMC loaded | 342.1 | 564.7 | yes |
| J5off-0-1 | J without Haiku | none, no OMC loaded in this stage | about 422.6 | about 425.0 | passed the check, no qualifying commit |
| J5off-LP-1 | J without Haiku | list and panel, no OMC loaded in this stage | no figure | 520 (wall clock) | passed the check, no qualifying commit |
| W-0-1 | W | none | 494.8 | 525.5 | yes |
| W-0-2 | W | none | 420.3 | 734.6 | yes |

Task 2, per run (second compaction, then the merge):

| Run | 2nd compaction | Support | Own work (s) | From start (s) | Passed |
|---|---|---|---|---|---|
| S-0-1 | S | none | 143.4 | 762.4 | yes |
| S-gole-1 | S | none, no OMC at all | 139.8 | 832.2 | yes |
| S5-LP-1 | S | list and panel (with the brief) | 121.6 | 893.9 | yes |
| S-Ls-1 | S | list, panel in shadow | 176.2 | 699.7 | yes |
| S-P-1 | S | panel (old, without the brief) | 517.8 | 761.9 | yes |
| S-LP-1 | S | list and panel (old panel, without the brief) | 804.9 | 1167.1 | yes |
| J-0-1 | J with Haiku | none | 189.1 | 820.7 | yes |
| J5-LP-1 | J with Haiku | list and panel (with the brief) | 496.6 | 896.5 | yes |
| J-LP-1 | J with Haiku | list and panel (old panel, without the brief) | not passed | not passed | no (limit of 2 x 1200 s, no push) |
| J5off-LP-1 | J without Haiku | list and panel | 302.3 | 644.6 | yes |
| J5off-0-1 | J without Haiku | none | not passed | not passed | no |
| J5off-LP-2 | S (the rig rejected the module's result) | list and panel | 106.7 | 300.6 | yes |
| Joff-0-1 | S (the rig rejected the module's result) | none | 157.3 | 485.2 | yes |
| W-0-1 | W | none | 780.8 | 953.2 | yes |

- Task 1 ranges over all runs of a cell: built-in compaction 236.2-264.6 s own work in five runs and 818.6 s in one (S-P-1, the old panel); our module with Haiku 247.7-435.9 s in five runs; without Haiku 267.1-342.1 s in three runs and about 422.6 s in a fourth; the original plugin 420.3 and 494.8 s. Task 2: built-in compaction 121.6-176.2 s in four runs and 517.8 and 804.9 s in two (both with the old panel); our module with Haiku 189.1 and 496.6 s, one run not passed; without Haiku 302.3 s, one run not passed; the original plugin 780.8 s. The spread between repeated runs is up to 200 s and the support features differ between rows, so no ranking follows from these rows.
- The trial did not show a gain of our compaction over the built-in one in time to the goal or in quality.
- **The third thread of task 1.** The strict check (150 of 150 tests) needs a third thread that the task allowed to be postponed. The original plugin passed it in 2 of 2 runs, our module without Haiku in 3 of 5, and none of the 11 runs with the built-in compaction or with Haiku did. The missing thread counts the same against the built-in and the Haiku cells, and it is not evidence of lower quality of either.

Not measured at all: any run with the elastic target active, or a comparison of the moment chosen by Jev against a baseline, in a functional trial or on a live session. There is no measured effect in a real run, no measured gain and no measured harm in one. The simulation does show a cost: a larger conversation after a compaction in 3 of 4 comparisons (above); the two comparisons at the host threshold rest on 2 and 1 module compactions, the two at the own threshold on 12 and 13, and 6 and 5.

## Why it was rejected

The decision was the author's, on 12 November 2026, after the own compaction itself had been explicitly kept (the closing of the wider plan at 01:19 had covered the panel, the list reminders and the slop-warning, and the compaction was restored at 02:20-02:23): this feature, a separate addition on top of the kept compaction, was to be described as a negative result and closed. The records support the decision from several sides:

- No measured gain in an experiment that exercised the feature (none did). The only comparison is a simulation with a stand-in for Jev, and it shows a trade: fewer removed results and fewer reread results, paid for with a larger conversation after each compaction, with the same share read again.
- The Jev half of the moment did nothing live: 0 yes answers in 20 asked turns, and in 16 of them the answer was withheld by the secret-path rule that is needed to keep secrets out of the question. Every request came from the closed-task rule. In the trial runs the local variant produced one Jev yes, whose effect was not assessed.
- The main reason given for choosing the moment, the fallback of mid-loop compactions to the built-in summary because of thinking in the tail, was addressed on its own in #5001 (the compaction keeps the thinking rows of an open tool loop; only redacted thinking runs the summary).
- The code adds about 400 lines to the module and 800 lines of tests, with a long list of races (the decision spans several awaits and compactions of other loops), for a benefit nobody has measured.

What upstream offers instead, and what we recommend: the merged compaction module with a numeric `OMC_JEV_COMPACT_AT_PERCENT` (or none), the fixed `OMC_JEV_COMPACT_TARGET`, and the host's own threshold. The author's own sessions keep running a local variant of the moment logic (`OMC_JEV_COMPACT_AT_PERCENT=jev`); this negative result is about not carrying it in OMC, not about switching the compaction off.

## Related

- #4940 (merged): the `compaction` point that keeps the conversation verbatim; this feature builds on it.
- #4978, #4980, #4992, #5001 (merged): later fixes of the compaction module; #5001 is the thinking-in-the-tail fix mentioned above.
- #5013 (open): optional archive of the results the module cuts; the other half of the elastic idea (cutting results scored low) was left out of #5008 because it is safe only with such an archive.
- #4935 (merged): actions on the slop-warning and other advisory answers; #4928 (closed): measurements for the advisory points.
- #4989 (open): messages delivered during a tool turn survive the compaction.

#5008 and #5013 are drafts.
