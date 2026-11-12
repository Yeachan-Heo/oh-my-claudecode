# Jev panel: reproduction kit (negative result, not for merge)

Companion of `docs/jev/negative-results/jev-panel.md`. The panel is a set of hooks that, after each batch of tool calls, put yes/no and choice
questions about the agent's recent work to Jev (the Typesafe AI decision service) and hand the agent at most one short reminder. It was tried,
measured and rejected. Everything here is off by default.

## What is where

| Path | What it is |
|---|---|
| `scripts/jev-panel.mjs`, `jev-panel-blad.mjs`, `jev-panel-koniec.mjs`, `jev-panel-koniec-agenta.mjs` | the panel: query after a batch, after a second tool error in a row, at the end of a turn (Stop, SubagentStop) |
| `scripts/jev-lista-paczka.mjs`, `jev-lista-stan.mjs`, `jev-lista-start.mjs` | the task-list hooks the panel sits on (the batch hook calls the panel; the others keep the agent's list) |
| `scripts/lib/jev-panel-wejscie.mjs` | the state sent to Jev, the questions, the hints |
| `scripts/lib/jev-lista.mjs`, `jev-zadania.mjs`, `jev-koniec-tury.mjs`, `jev-task.mjs`, `jev-sekrety.mjs` | list store, reminder store, end-of-turn file, owner task, secret masking |
| `scripts/lib/jev-panel-host.mjs`, `jev-panel-shadow.mjs` | the only glue to this tree: log directory and the names of the Jev helpers of `scripts/lib/jev-shadow.mjs` |
| `scripts/jev-resolve.mjs` (2 lines changed) | point `panel` is named-only (like `compaction`) and gets a 4000-character excerpt limit |
| `hooks.snippet.json` | the hook entries to merge by hand into a local `hooks.json`; not merged into `hooks/hooks.json` |
| this directory | `dry-run.mjs`, `mock-jev.mjs`, `replay-labelled.mjs`, `metrics.py`, `print-questions.mjs`, `example/` |

## Switches

- `OMC_JEV=panel:shadow` or `panel:active`. The point is named-only: `all`, `all:active` do not turn it on. Needs `TYPESAFE_API_KEY`.
- `OMC_JEV_PANEL_WERSJA=2` selects the current question set (the only one kept in this port; the unset default is the first generation).
- `OMC_JEV_PANEL_PYTANIA=name:mode,...` sets each question to `off`, `shadow` (sent and logged, no hint) or `active` (default). Names: `deleguj`,
  `poboczne`, `zrodlo`, `utknal`, `zrobione`, `notka`, `slop`. In this port `slop` defaults to `shadow`, because the per-call slop warning of
  `pre-tool-enforcer.mjs` is not wired to the panel here.
- `OMC_TODO_HINT=off|shadow|active` (reminders about the task list); `OMC_SKIP_HOOKS=jev-panel` turns the panel off alone, `jev-lista` the lists and the panel.
- `OMC_JEV_APPLIED_LOG=1` writes `applied.jsonl` rows; the panel's own log is `panel.jsonl` in `OMC_JEV_LOG_DIR`.

## 1. Dry run (no network, no key, no cost)

```
env -u TYPESAFE_API_KEY node scripts/jev-negative-results/jev-panel/dry-run.mjs
```

Starts `mock-jev.mjs` (an HTTP stand-in for the API that answers from a table, in reverse question order) and drives the real hook scripts with
synthetic hook input in a temporary HOME. Nine checks: off by default; one query carrying nine questions and one hint; silence when Jev says no to
everything; answers read by name, not by position; the order reaching the state when the session has no `origin: human` row; shadow mode gives no hint;
the per-question switch; the end-of-turn hook; the offline replay below on a synthetic labelled case. Exit code 0 when all pass.

## 2. Offline replay on labelled cases (needs your own transcripts, labels and a key)

The panel was scored by replaying its decision at the moment of each labelled query, from the session transcript, against the live Jev:

```
node scripts/jev-negative-results/jev-panel/replay-labelled.mjs labels.jsonl out.jsonl [--panel ~/.omc/state/jev/panel.jsonl] [--limit N] [--no-end]
python3 -I scripts/jev-negative-results/jev-panel/metrics.py labels.jsonl out.jsonl
```

- `--dry-run` builds the states and sends nothing (no key needed). Without it the script needs `TYPESAFE_API_KEY` and costs about two Jev
  requests per case (the batch moment and the end-of-turn moment, the latter shared between cases of the same turn), more when a state exceeds the
  request window and is split. Answers are cached in `out.jsonl.cache/` by content of the query, so a rerun is free. I did not run it here.
- Input: `labels.jsonl` rows `{ id, ts, session_id, transkrypt, agent_id, agent_type, prawda: { <question>: "tak"|"nie" } }` (and
  `wejscie.stan.powod`, `zadanie_w_toku`), `transkrypt` being the path of a Claude Code session transcript. The labels used in the original
  measurement were made by language-model agents from real sessions and cannot be published; build your own from your own transcripts. `example/make-example.mjs <dir>`
  writes a one-case synthetic set in the right shape; its numbers mean nothing.
- `metrics.py` prints precision ("trafnosc"), sensitivity ("czulosc") and false hints per 100 queries, per question and for the combined
  "list is out of date" hint (the `zrobione` or `notka` choice). Definitions are in its header.

## 3. Live trial

Merge `hooks.snippet.json` into a local hooks file, set `TYPESAFE_API_KEY`, `OMC_JEV=panel:shadow` and `OMC_JEV_PANEL_WERSJA=2`, work as usual, and read
`panel.jsonl` (one row per query: signals, questions, answers, `wynik`, hint chosen, `ms`). Switch to `panel:active` only after judging the shadow rows.
The state sent to Jev contains the recent tool calls and the agent's texts after secret masking (`jev-sekrety.mjs`); read it before you send it.

## Differences from the patched plugin the panel was developed in

- No panel-specific circuit breaker and no `OMC_JEV_MAX_RPM` share (`jev-limit.mjs` of the patched plugin); this tree's shared breaker applies.
- No wiring of the per-call slop warning (`pre-tool-enforcer.mjs`) to the panel; `slop` is shadow by default.
- No `lista_zadan` MCP tool (`bridge/mcp-server.cjs`); the lists are filled from `TodoWrite`, `TaskCreate`, `TaskUpdate` and the desktop plan tools.
- The tool-gate based owner-task file (`jev-task.mjs` `recordOwnerTask`) is not written; the panel falls back to the transcript.
- The window-fitting functions of the patched resolver are absent; the panel then splits a big state itself (`askInParts`) and cuts nothing silently.
- Comments in the code are in English, the questions, hints and some log field names are in Polish, as they were sent and logged.
