# Reproduction kit: elastic compaction target and moment chosen by Jev (negative result)

Write-up: `docs/jev/negative-results/jev-compaction-flex-moment.md`. Feature code: PR #5008 (`hooks/jev-compaction.mjs`). Not for merge.

Everything here runs without `TYPESAFE_API_KEY`, without network, at no cost. Needs Node 20 or later, run from any directory.

## Elastic target arithmetic

```
node replay-elastic-target.mjs
node replay-elastic-target.mjs --rule 0.5 --start 300000 --growth 20000,40000,80000,150000 --json
```

Imports the exported `elasticTarget` from `hooks/jev-compaction.mjs` and prints, for a series of conversation sizes, what a fixed target and the elastic target keep. A compaction is modelled as leaving exactly `target x before` characters (the real module leaves what the results it scored allow), so this shows the rule and measures nothing. Run on the default series the elastic target frees 599 675 characters in total against 609 687 for the fixed one, and keeps 0.7 after a small growth.

## Counting moment decisions in a log

```
node summarize-compact-log.mjs --sample
node summarize-compact-log.mjs <path to a compact.jsonl> [--json]
```

Reads a `compact.jsonl` (written by the module under `OMC_JEV_LOG_DIR`) and prints counts only: `own_threshold` records by result, reason and moment (`task` = a closed task asked the host, `jev` = a yes of Jev), how many Jev answers there were and how many reached 0.7, how many questions went out without the answer text (`answer_skipped`), compaction records by result and by `own_request`, and how many carry elastic-target fields (`target_source`). `sample-compact.jsonl` is a synthetic file (20 records) for the `--sample` run; it is not real data.

## The unit tests in the PR

```
env -u TYPESAFE_API_KEY -u OMC_JEV npx vitest run src/__tests__/jev-compaction-module.test.mjs
```

A fake host and a fake Jev; no API.

## What needs your own key

Asking Jev the `compaction-moment` question for real: `TYPESAFE_API_KEY`, `OMC_JEV=compaction:active`, `OMC_JEV_COMPACT_AT_PERCENT=jev` (optionally `OMC_JEV_COMPACT_FLEX=active`), an interactive terminal session (the host refuses `$.session.compact()` in `-p`, SDK and desktop sessions). Cost: one Noul request per asked turn, at most one per 5 turns, a few hundred tokens each; a closed task in the turn asks the host without Jev.

## What cannot be reproduced here

The offline replays in the write-up used the transcripts of real long sessions and a stand-in scorer for Jev; the transcripts are private and are not shipped.
