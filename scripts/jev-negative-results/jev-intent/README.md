# jev-intent: reproduce the `intent` measurement without the API

Negative result, not for merge. Write-up: `docs/jev/negative-results/jev-intent.md`.

The script counts, from a Jev shadow log, how often the `intent` judgment point
asked, how long the logged requests took, how often the answer could change what
the hook does, and (optionally) how an answer threshold fares against your own
labels. It never calls the Jev API and needs no key.

## Run it on synthetic data (no API, no key)

```bash
cd scripts/jev-negative-results/jev-intent
node make-synthetic.mjs /tmp/jev-intent-syn
node measure-intent.mjs /tmp/jev-intent-syn/shadow.jsonl --labels /tmp/jev-intent-syn/labels.jsonl | diff - expected-output.txt && echo same
```

`make-synthetic.mjs` writes a fabricated log (fixed seed, prompts such as
`synthetic prompt 17`, no real text). Its row counts per stratum copy the
population published in Yeachan-Heo/oh-my-claudecode#4928 (576 `intent` rows: 19
at 0.5 or more, 85 from 0.2 to 0.5, 216 below 0.2 with a prompt, 256 with an empty
sanitized prompt), so the output can be read against the issue. Durations and
`noul` values inside those bands are random: the synthetic run shows that the
script counts correctly, not what Jev answers. `expected-output.txt` is the
output of the second command.

## Run it on a real log

```bash
node measure-intent.mjs "$OMC_JEV_LOG_DIR/shadow.jsonl" [--since 2026-11-03T00:00:00Z] [--until ...] [--json]
```

`shadow.jsonl` is written by OMC when `OMC_JEV` opts the point in. To get
`intent` rows in mode `active` set, with your own `TYPESAFE_API_KEY`:

```bash
export TYPESAFE_API_KEY=...        # yours; not read or needed by the script
export OMC_JEV=intent:active
```

and work normally. Cost: one Noul request to Jev per submitted prompt (the
point is `medium` priority for `OMC_JEV_MAX_RPM`, see `docs/HOOKS.md`). Without
the key the point is off and the log has no `intent` rows.

What it prints, all as counts (no prompt text):

- intent rows by mode, and the share of all rows in the file;
- active rows with a numeric `noul`, and those whose sanitized prompt is empty;
- resolver time as logged (`durationMs`): sum, median, p95, max. This is the time
  of the request, not of the whole hook. The hook waits for the resolver for
  `OMC_JEV_TIMEOUT_MS` plus 500 ms at most, and a resolver killed at that limit
  leaves no row (see `docs/HOOKS.md`, "Shadow Log Location");
- for prompts that carry a `prompt_id`: the resolver time summed over the
  `skill-trigger`, `intent` and `task-size` rows of that prompt, which the
  keyword-detector hook asks one after the other;
- `noul` bands (below 0.2, 0.2 to 0.5, 0.5 and above);
- how many answers can change the hook output: none without
  `OMC_JEV_INTENT_APPLY`; with it, those at 0.5 or more, split by whether the
  slash heuristic had already selected the skill;
- the busiest UTC minute for `intent` requests.

## Optional: your own labels

`--labels labels.jsonl`, one object per line, `{"ts": "<ts of the shadow row>", "label": "yes"|"no"}`,
where `yes` means the prompt really is an Intent-intake request (the definition
is in the write-up). The script joins on `ts` and prints, for the thresholds 0.5,
0.7 and 0.8, how many flagged rows you labelled yes and no. The labelling in
#4928 was done by separate runs of a model on a sample; that sample holds real
prompts and is not published. To repeat it, sample rows yourself, strip them to
what Jev saw (`state.prompt`), label them blind to Jev's answer and keep the
texts private.

## Files

- `measure-intent.mjs`: the counter.
- `make-synthetic.mjs`: the fabricated log and labels.
- `expected-output.txt`: output for the synthetic log.
