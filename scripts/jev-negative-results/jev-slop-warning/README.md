# jev-slop-warning: reproduce the decision-change count

Negative result, not for merge. Write-up: `docs/jev/negative-results/jev-slop-warning.md`.

The hook code that lets the `slop-warning` answer decide is already in the repository (`scripts/pre-tool-enforcer.mjs`, merged in #4935); nothing here duplicates it.

## Files

| File | What it is |
|---|---|
| `measure-decision-change.mjs` | Counts, from a Jev log directory, how often the active `slop-warning` answer changes the decision. Prints counts only. No network, no key. |
| `make-synthetic-log.mjs` | Writes a synthetic `shadow.jsonl` and `applied.jsonl` (seeded, no real tool input) so the counter can be run without any log. The numbers are not measurements. |
| `measure-decision-change.test.mjs` | `node:test` checks that the counter agrees with the generator. |
| `reference/t4-slop-in-panel-query.patch` | Reference only. A variant that asks the question once per batch of tool calls inside a "panel" query. Depends on the panel code, which is not in this repository, so it does not apply here (see below). |

## Run without the API

```bash
# tests (the Jev variables are irrelevant here; unset them anyway)
env -u TYPESAFE_API_KEY node --test scripts/jev-negative-results/jev-slop-warning/

# synthetic log, then count
node scripts/jev-negative-results/jev-slop-warning/make-synthetic-log.mjs /tmp/jev-synthetic --rows 20000 --seed 1
node scripts/jev-negative-results/jev-slop-warning/measure-decision-change.mjs --dir /tmp/jev-synthetic --day 2026-01-15
```

The generator prints the counts it built in (`expected`); the counter's `applied.jsonl` and `recomputed` lines at threshold 0.8 must equal them.

## Run on your own log

```bash
node scripts/jev-negative-results/jev-slop-warning/measure-decision-change.mjs \
  --dir .omc/state/jev --day 2026-11-11 --threshold 0.7
```

Options: `--dir` (default `.omc/state/jev`), `--day YYYY-MM-DD` (UTC unless `--tz-offset-hours`), `--from` / `--to` (ISO times), `--threshold` (above 0, up to 1; thresholds 0.5, 0.7 and 0.8 are always printed too), `--point` (default `slop-warning`), `--json`.

It reads the `ts`, `point`, `mode`, `heuristic`, `jev` / `answers.slop_advisory.noul` and `durationMs` fields of `shadow.jsonl`, and the `applied` field of `applied.jsonl` (both the upstream shape `applied.action.{from,to}` with `warn` / `none` and the older `applied.warning.{from,to}` with booleans). It never prints prompts, tool input or file contents; the only strings it prints are tool names from the applied log.

## What it measures, and what it does not

It measures: the number of active answers, their distribution, the latency of the calls, and how many decisions the answer changed (twice: from `applied.jsonl`, and recomputed from `shadow.jsonl` as `noul >= threshold` against the logged heuristic decision). Whether those changes were right is not measured; that needs labels, see #4928.

## Collect your own log (needs your own key)

This is the only part that calls the Jev API (one request per tool call, so tens of thousands per day in a busy session; the provider's usage export has no per-point split, so the cost of this point alone is not known). Set, for the Claude Code session whose hooks you want to measure:

```bash
export TYPESAFE_API_KEY=...           # your own key
export OMC_JEV="slop-warning:active"
export OMC_JEV_SLOP_WARNING_APPLY=1
export OMC_JEV_SLOP_WARNING_THRESHOLD=0.7   # we ran 0.7; the default is 0.8
export OMC_JEV_APPLIED_LOG=1
export OMC_JEV_LOG_CONTEXT=1
```

Work as usual for a day, then run the counter on `.omc/state/jev`. To measure without changing any decision, drop `OMC_JEV_SLOP_WARNING_APPLY`: the recomputed counts are still valid, the applied count is then 0.

## The reference patch

`reference/t4-slop-in-panel-query.patch` is the diff of the variant described in the write-up under "Variant: ask once per batch". It is written against our local patch tree (it changes `scripts/jev-panel.mjs`, `scripts/lib/jev-panel-wejscie.mjs` and `scripts/pre-tool-enforcer.mjs` of that tree), not against this repository, which has no panel. It is attached so the question text, the choice question and the logging can be read and reused. Its comments mention local patch labels (`omc-lokalne`, `T4`, `P4`, `P14`); they carry no other meaning.
