# jev-compaction-experiments: counters for a negative result (not for merge)

Companion of `docs/jev/negative-results/jev-compaction-experiments.md`. Read that first. Nothing here enables anything: the scripts are read-only, make no network calls, need no `TYPESAFE_API_KEY`, and cost nothing. Node 20 or newer.

## Files

| File | What it is |
|---|---|
| `count-trim.mjs` | Counter for section 1.1: the share of tool-result characters a result trimmer would remove (scenario A with the policy, scenario D the ceiling), plus a check that a short line with an error word survives. |
| `output-trim/jev-trim.mjs` | The reference trimmer (five steps: ANSI codes, carriage-return rewrites, repeated lines, success series, long lines). Pure functions, never wired into a hook. Markers and footers are Polish. |
| `output-trim/test-jev-trim.mjs` | Its 66 unit tests. |
| `count-merge-hits.mjs` | Counter for section 1.2: runs of identical neighbouring tool calls in one API message (transcripts), or merges recorded in a compaction log. |
| `count-repeated-state.mjs` | Counter for section 1.3: the share of request bytes that is the same state sent again. |
| `sample/request-log-sizes.jsonl` | Per-request body size and state-field sizes of the run of section 1.3 (214 requests; sizes only, field names translated, no content). |
| `sample/compact-log-merge-counts.jsonl` | The `merged_traces` / `merged_items` fields of the 45 compaction records of section 1.2 (module revision prefix only, no ids, no timestamps). |

## Run (no API calls)

```
node output-trim/test-jev-trim.mjs                       # 66 OK, 0 NIE (NIE = failed)

node count-trim.mjs --synthetic                          # deterministic synthetic transcripts
node count-trim.mjs --transcripts <dir> [--since ISO]    # your own Claude Code transcripts, numbers only

node count-merge-hits.mjs --synthetic                    # builds 100 messages with 3 known runs; prints a self-check line
node count-merge-hits.mjs --transcripts <dir>
node count-merge-hits.mjs --compact-log sample/compact-log-merge-counts.jsonl

node count-repeated-state.mjs --synthetic                # 213 requests: two big fixed fields plus changing content
node count-repeated-state.mjs --request-log sample/request-log-sizes.jsonl --fixed tasks,axis
node count-repeated-state.mjs --request-log sample/request-log-sizes.jsonl --fixed tasks,axis,block_rubric,current_task,task_index
node count-repeated-state.mjs --bodies <dir>             # one { "state": {...}, "questions": [...] } JSON per file
```

Add `--json` for machine-readable output.

## Expected output with the bundled data (deterministic)

- `count-merge-hits.mjs --synthetic`: 100 API messages, 106 tool calls, 3 runs (7 calls), self-check OK.
- `count-merge-hits.mjs --compact-log sample/compact-log-merge-counts.jsonl`: 45 records, 0 with a hit.
- `count-repeated-state.mjs --request-log sample/request-log-sizes.jsonl --fixed tasks,axis`: 214 requests, 11,450,049 body bytes, repeated state 8,257,371 bytes = 72.1 %; with the five fixed fields 8,710,861 = 76.1 %.
- `count-repeated-state.mjs --synthetic`: 213 requests, 11,733,028 bytes, 80.5 % (the sizes are chosen after the measured case, so this checks the arithmetic of the counter, not the measurement).
- `count-trim.mjs --synthetic`: 3,470 results, 7,172,632 characters; scenario A 1.48 %, ceiling D 2.17 %; invariant: 18 trimmed, 0 lost an error-word line. The synthetic corpus only exercises each step; it is not shaped to reproduce the 0.37 % measured on real transcripts.

## What each counter says about the real data

The real transcripts and logs are private and not included; the numbers measured on them are in the document. To repeat the measurement on your own sessions point `--transcripts` at the Claude Code projects directory of your machine (the scripts read `*.jsonl` recursively, skip `tool-results`, and print counts only). The 10 % threshold in `count-trim.mjs` is the one fixed before the original measurement; change nothing else if you want comparable numbers.

## Not included

- The local compaction module (about 6,500 lines) that the experiments ran in: the functions the document names (`mergeTraceEntries`, `chooseTasks`, `composeTaskList`, the verdict writers, the depth question) are described in words there; they depend on parts of that module that upstream does not have.
- Anything that calls Jev. The questions that were sent are quoted verbatim in the document. A live repetition of the Jev measurements costs Jev tokens (the sections give the sizes) and needs `TYPESAFE_API_KEY` in the environment.
