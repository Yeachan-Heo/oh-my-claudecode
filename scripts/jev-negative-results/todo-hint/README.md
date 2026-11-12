# todo-hint: reproduce the experiment (negative result, not for merge)

Background, questions, results and the reason for rejection: `docs/jev/negative-results/todo-hint.md`.

| File | What it does | API call / key |
|---|---|---|
| `replay.mjs` | Replays synthetic tool-call batches through the hook's own fold, prints the exact request body (signals, reminder history, question) Jev would get in two scenarios and in both question wordings, then the five answers of the live probe from `fixtures/recorded-answers.json` and what each would have delivered. `--json` for machine output. | none |
| `measure.mjs` | The reaction measure: for each delivered reminder, did the same recipient call a list tool before its next reminder? Also gaps under 60 s. Input: a `todo-hint.jsonl` and a batches file (`--rows`, `--batches`); default is the synthetic fixture. | none |
| `probe.mjs` | Sends the four requests of `replay.mjs` (2 scenarios x 2 wordings) to Jev and prints the probability of each answer. `--dry-run` only prints sizes. One try per cell. | needs `TYPESAFE_API_KEY` without `--dry-run`; about 0.5-1k input tokens per request |
| `fixtures/` | Synthetic data only: `batches.json`, `todo-hint.jsonl` (reminder rows), `scenarios.json`, `recorded-answers.json` (the numbers of the five real probe answers, no text). | - |

```
node scripts/jev-negative-results/todo-hint/replay.mjs
node scripts/jev-negative-results/todo-hint/measure.mjs
node scripts/jev-negative-results/todo-hint/probe.mjs --dry-run
npx vitest run src/__tests__/jev-todo-hint.test.mjs      # hook subprocess against a stub Jev endpoint
```

Run the tests with `OMC_JEV*`, `OMC_TODO_HINT` and `TYPESAFE_API_KEY` unset (the test sets what it needs).

## Turning the hook on (it is not in `hooks/hooks.json`)

Add to a Claude Code settings file, and set the variables in its `env`:

```json
{
  "env": { "OMC_TODO_HINT": "active", "OMC_JEV": "todo-hint:active", "TYPESAFE_API_KEY": "..." },
  "hooks": { "PostToolBatch": [ { "hooks": [ { "type": "command", "command": "node /path/to/repo/scripts/jev-todo-hint.mjs", "timeout": 10 } ] } ] }
}
```

`OMC_TODO_HINT=shadow` with `OMC_JEV=todo-hint:active` asks Jev and logs the decisions without delivering them; `OMC_JEV=todo-hint` (shadow) only records Jev's answers in `shadow.jsonl`. To compare with the host reminder, set `CLAUDE_CODE_TODO_REMINDER_MODE=off` in the same environment.

## Cost

Each batch of tool calls in `active`/`shadow` makes one Jev request of about 1.2-2 KB of state (the signals grow with the reminder history, at most 20 entries) plus a Node process start for the hook. Answers took 0.55-0.7 s in the probe, and `active` waits for the answer inside PostToolBatch. With the patch's much larger panel request (22-24 KB, about 9-10k input tokens) five requests cost about 0.008 USD at a working price of 0.157 USD per million input tokens.

## What the offline mode does not show

It does not show how Jev answers. Only `probe.mjs` or the recorded answers do, and the recorded answers were given to the larger panel request, not to the reduced state this port sends.
