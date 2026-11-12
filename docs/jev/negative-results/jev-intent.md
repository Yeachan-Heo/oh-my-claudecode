# The `intent` judgment point: asking Jev about every prompt

Negative result. Tried, measured, rejected. Not for merge.

This document and `scripts/jev-negative-results/jev-intent/` add no feature code. The
point already exists in `dev`; the branch holds the write-up and a counting
script. The point is left switched off in the setup that measured it.

## What it was meant to do

The `intent` point asks Jev, for every submitted prompt, whether the prompt starts
an Intent-intake request, that is, whether the `intent` skill (the internal
requirements intake for non-engineer contributors, `skills/intent/SKILL.md`)
should be offered. The hypothesis behind the point (`docs/issues/issue-3669-jev-judgment-points.md`,
judgment point 1): a decision model recognizes phrasings that a keyword or slash
pattern never anticipated. The heuristic twin only matches the slash command
`/intent` at the start of the prompt.

The problem we found was a request whose answer did nothing. Under `:active` the
hook waits synchronously for Jev, and until #4977 (below) nothing in `dev` used
the answer. In our setup, once our own use of the answer was switched off, the
point still cost a wait and a request per prompt and changed nothing.

## How it worked

- **Hook and trigger.** `scripts/keyword-detector.mjs`, event `UserPromptSubmit`.
  The block starts at `isJevShadowOptedIn('intent', ...)` (about line 2221 at
  `68fdb1181`). The questions are `INTENT_QUESTIONS` (about line 1900); the
  heuristic is `INTENT_SLASH_PATTERN` (about line 1924).
- **What is sent.** `state = { prompt: <sanitized prompt>, mode_name: 'intent' }`
  plus the question below. The prompt is the one left after
  `sanitizeForKeywordDetection` (tags, code blocks, quotes and pasted payloads
  removed); the excerpt limit for the point is 1000 characters
  (`scripts/jev-resolve.mjs`, `docs/HOOKS.md`, `OMC_JEV_EXCERPT_CHARS_INTENT`).
  When nothing is left after sanitizing, the request is still sent with an empty
  prompt; at `68fdb1181` we found no guard for that before the request.
- **Waiting.** In `:active` mode `recordJevShadow` (`scripts/lib/jev-shadow.mjs`,
  the `spawnSync` branch) starts the resolver and waits up to `OMC_JEV_TIMEOUT_MS`
  plus 500 ms. `skill-trigger`, `intent` and `task-size` are asked one after the
  other by the same hook; `docs/HOOKS.md` notes that `run.cjs` caps
  `keyword-detector.mjs` at 8 s, so three active points at the defaults can be
  stopped. The point has `medium` priority for `OMC_JEV_MAX_RPM`.
- **What was done with the answer.**
  - `dev` before #4977: nothing ("logging-only"); the answer went to `shadow.jsonl`.
  - `dev` since #4977 (merged 2026-11-10, commit `1dcd71c4f`, closing #4928):
    with `OMC_JEV_INTENT_APPLY=1`, an answer of 0.5 or more adds the `intent`
    skill to the resolved keywords unless `keywordDetector.disabled` lists it.
  - Our local patch (not in `dev`): at 0.5 or more it added the hint
    `[JEV: INTENT] This prompt looks like an intake request; if so, use /intent.`
    to the context of the model. This is the action that was measured.
- **Switches.** `OMC_JEV=intent` (shadow) or `intent:active`, or `all:active`,
  which includes it. `OMC_JEV=...,intent:off` turns it off under `all`
  (the parser fix is #4959, merged 2026-11-10; before it `intent:off` under
  `all:active` left the point active). Without `TYPESAFE_API_KEY` the point is off.

## The question sent to Jev, verbatim

Type `noul` (yes/no, answered as a probability of yes from 0 to 1). This is the
text in `INTENT_QUESTIONS`, unchanged in the setup that measured it.

Instructions:

> Does this user prompt start an Intent-intake request (a non-engineer contributor stating a problem/goal/constraints to start the requirements intake flow)?

Criteria, `true`:

> The prompt states a problem, goal, or constraints from a contributor and starts the Intent intake — a goal-level intent.md with problem/goal/users-and-systems/constraints/open-questions, not a solution design.

Criteria, `false`:

> Everything else: solution or engineering work, informational questions, or an existing workflow. Not an Intent-intake request.

The labelling guide used for the measurement quoted these three texts and added:
"When the answer is yes, the agent is told the prompt looks like an
Intent-intake request and that the `/intent` skill exists. Label `true` only for a
prompt that states a problem or goal (with constraints) and asks to start
capturing requirements, not for a request to do the work, a question, a
correction, or a message continuing work already under way. An empty item means
nothing was left after tags, paths and code were removed."

## How it was tested

Setup, as in #4928 ("How we measured"): one machine, all points `:active`, plugin
5.8.1 plus a local patch that applied the answers, `OMC_JEV_TIMEOUT_MS=5000`, an
excerpt limit of 1000 characters for `intent`. Rows logged before the working
directory was recorded (3 November) and rows from private working directories
were left out before sampling, up to 2026-11-09 16:12 UTC.

Sample: 143 prompts from 576 eligible rows, stratified by the answer and by
whether the sanitized prompt was empty (strata in the table below). Two labellers,
each a separate run of the same model (Claude Sonnet as a subagent, not humans),
read the same bounded state Jev saw and answered the point's own question and
criteria, without seeing Jev's answers. The success criterion we applied: prompts labelled yes
receive an answer at or above the threshold, and prompts labelled no do not.

To reproduce the counting without the API, see
`scripts/jev-negative-results/jev-intent/README.md`: a synthetic log with the same
stratum sizes, a script that counts requests, waiting time and the rows an answer
could change, and an optional join with labels you make yourself. Running the
point live needs your own `TYPESAFE_API_KEY` and costs one request per prompt;
the labelled sample itself holds real prompts and is not published.

## Results

All figures: one machine, rows up to 2026-11-09 16:12 UTC, labels from model runs.
Source for this block: #4928 and its labelling results.

| Stratum | Rows in the 576 | Sampled | Labelled yes |
|---|---|---|---|
| noul 0.5 or more | 19 | 19 (all) | 0 |
| noul 0.2 to 0.5 | 85 | 55 | 0 |
| noul below 0.2, prompt not empty | 216 | 66 | 0 |
| sanitized prompt empty | 256 | 3 (the 3 distinct texts) | 0 |
| Total | 576 | 143 | 0 |

- The two labellers agreed on all 143 (100 %), both answering no every time, so
  Cohen's kappa is not computable.
- Upper 95 % bound of the yes rate in the two sampled strata: 6.5 % (0.2 to 0.5)
  and 5.5 % (below 0.2).
- Accuracy against the labels, post-stratified: heuristic twin 100 %; Jev at 0.5
  or more 96.7 % (-3.3 percentage points against the twin); at 0.7 or more 99.0 %
  (-1.0); at 0.8 or more 99.7 % (-0.35). The differences are exact for this
  population, because only fully labelled strata decide them. They say that
  acting on the answer would only have added wrong hints.
- All 19 rows at 0.5 or more were labelled no: a hint at that threshold was wrong
  19 times out of 19. The local applied log held 26 such hints on 9 November 2026; the 19
  rows are those that passed the exclusions described above.
- 256 of the 576 rows (44 %) had an empty sanitized prompt (background task
  notifications and similar), and Jev was still asked.
- 1,003 `intent` rows were active in the whole log to the cut-off, 687 of them
  with a working directory recorded, 576 eligible.

A second machine, small and unlabelled (its `shadow.jsonl` was read with
`measure-intent.mjs` on 2026-11-12; counts only):

- 31 active `intent` rows, 2026-10-30 to 2026-11-10 01:36 UTC, 0.1 % of the 29,441
  rows of the file with a timestamp up to 2026-11-12 01:00 UTC (the file keeps
  growing; `--until 2026-11-12T01:00:00Z` reproduces the count). All 31 answers below 0.2; 1 with an empty prompt.
- Logged request time of those 31: sum 77.8 s, median 2,598 ms, p95 3,206 ms,
  max 3,210 ms.
- 24 prompts have `intent` and a prompt id: resolver time summed over the
  `skill-trigger`, `intent` and `task-size` requests of the same prompt had median
  7,174 ms, p95 9,181 ms, max 9,467 ms; 6 of the 24 were above the 8,000 ms cap
  that `run.cjs` puts on `keyword-detector.mjs`. These are sums of logged request
  durations, not measured wall-clock time of the hook, and we did not check
  whether the hook output of those 6 was lost. `OMC_JEV_TIMEOUT_MS` is 5000 on
  that machine now; the earlier value was not checked.
- Peak: 2 `intent` requests in one UTC minute.

What was not measured:

- The waiting time of the machine that produced the 576-row population. The
  per-stratum counts we keep carry no durations. For comparison, #4928 gives a
  median of 1,512 ms for `slop-warning` on that machine. We have no per-prompt
  `intent` figure for it, so the claim "it waited" rests on the code path and on
  the second machine's 31 rows.
- Whether the per-minute limit was ever the binding constraint because of
  `intent`. By design each prompt takes one slot of a `medium` point; no refusal
  caused by it was counted.
- The cost in money of the requests.
- English-language traffic and a setting with the intended users of the `intent`
  skill (support and ops staff pasting chat logs). 81 % of the sampled prompts
  contained Polish characters, and the traffic came from long-running coding
  sessions of one user on work projects. On the intended traffic the point might do better; we cannot say.
- Human labels. Two runs of one model agree more easily than two people.

## Why it was rejected

On the traffic we measured, the question has no positives: 0 of 143 labelled
prompts, and a hint at the 0.5 threshold was wrong 19 times out of 19. The
answer cannot change anything unless the action is switched on, so in `:active`
without the action each prompt paid a synchronous request and a slot of the
minute limit for nothing, and with the action the effect would have been
wrong suggestions. We switched our hint off on 2026-11-09 and the point off
(`intent:off` in `OMC_JEV`) on 2026-11-10 on both machines.

The decision was ours to take for our own traffic. The write-up does not claim
the point is useless for the people the `intent` skill targets.

## What is used instead

The heuristic: `INTENT_SLASH_PATTERN`, that is, typing `/intent`. For a setup that
keeps Jev on for other points, `intent:off` in `OMC_JEV`. The related change
proposed in #4928 and not part of this branch: skip the `intent` request when the
sanitized prompt is empty (44 % of the rows above).

## Related

- #4928, "Jev: four advisory points still discard their `:active` answer
  (follow-up to #4805); labelled measurements and a proposal for one opt-in PR"
  (closed): the measurement of `intent`, with the statement that the data argue
  against acting on the answer, so no `intent` option was proposed. #4977
  (merged 2026-11-10) added `OMC_JEV_INTENT_APPLY` regardless; this document is
  the evidence we hold against enabling it on a traffic like ours.
- #4977, "feat(jev): opt-in action on the intent advisory point (#4928)" (merged).
- #4935, the opt-in actions for `slop-warning`, `learner-extraction`,
  `simplifier-trigger` and `loop-continuation` (merged).
- #4805 and #4808: the earlier report that `:active` was inert for six points, and
  its fix for `task-size` and `loop-continuation`.
- #4959: `point:off` under `all` and `all:active` (merged).
- #4121: wiring of the remaining points into the plugin hook scripts (merged).
