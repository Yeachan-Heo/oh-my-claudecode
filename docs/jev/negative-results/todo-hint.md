# Jev decides when to remind an agent about its task list (`todo-hint`)

**Negative result. Tried, measured, rejected. Not for merge.**

The code is here so the experiment can be re-run and checked, not to be adopted. It is off by default and not registered in `hooks/hooks.json`.

- Hook: `scripts/jev-todo-hint.mjs` (PostToolBatch), library: `scripts/lib/jev-todo-hint.mjs`
- Test: `src/__tests__/jev-todo-hint.test.mjs` (9 tests, stub Jev endpoint, no key needed)
- Offline replay, measure and live probe: `scripts/jev-negative-results/todo-hint/` (see its `README.md`)

## What it was meant to do

Claude Code reminds the model to create or update its task list on a fixed schedule (a `task_reminder` attachment after some turns without a `TaskCreate`/`TaskUpdate`). That reminder is blind: it is added to every agent, including short subagents on a single task that do not need a list, and it repeats the whole list each time.

Hypothesis: Jev (the Typesafe AI decision service OMC already consults at judgment points) can decide, per agent and per moment, whether a reminder is worth sending and which one, so that (1) the host reminder can be switched off (`CLAUDE_CODE_TODO_REMINDER_MODE=off`) and (2) agents keep their lists up to date when it matters. Success would be: after a reminder the agent creates or updates its list.

## How it worked

- **Trigger.** After every batch of tool calls (PostToolBatch), for the main thread and for every subagent.
- **What the code does.** It only counts facts and keeps them per thread (`<jev log dir>/todo-hint/<session>/<main|agent_id>.json`): the list as the hook saw it (from `TaskCreate`, `TaskUpdate`, `TodoWrite`, or a `lista_zadan` tool when the host has one), the tool calls since the list last changed, the reminders already sent. No counter, threshold or cap triggers a reminder; they are signals in Jev's input.
- **What is sent to Jev.** One `choice` question, point name `todo-hint`, with `state.przypomnienie` (the signals, below) and `state.ostatnie_wywolania` (names of the tool calls of the batch).
- **What is done with the answer.** The answer picks one of `zadne` (none), `zaloz_liste`, `wpisz_krok`, `lista_nieaktualna`, `notka`. For a kind other than `zadne` the fixed text of the kind (below) is delivered once as `additionalContext`, and one row is appended to `todo-hint.jsonl`.
- **Switches.**
  - `OMC_TODO_HINT`: `off` (default, hook exits immediately) | `shadow` (decisions are logged, nothing is delivered) | `active` (the chosen reminder is delivered).
  - `OMC_JEV` must name the point: `todo-hint` (Jev is asked in shadow, the answer is only logged by the resolver) or `todo-hint:active` (the answer is used). `OMC_JEV=all:active` does not enable it, as for `compaction`.
  - The twin (heuristic) never reminds, so without an active Jev answer nothing is ever delivered.

Signals in `state.przypomnienie`: `ma_liste`, `zadan_w_toku`, `zadan_otwartych`, `wywolan_od_zmiany_listy`, `ostatnia_zmiana_listy`, `typ_agenta`, `sesja_glowna`, `narzedzie_listy`, `przypomnien_dotad`, `ostatnie_przypomnienie`, and the **reminder history** `historia_przypomnien` (last 20 reminders of this thread: kind, mode, tool calls and seconds since it, whether the thread called a list tool after it and when), `starszych_pominietych`, `dziennik_obciety`. Unknown is `null`, never a false "no".

### Differences from the measured setup

The measured version lived in a local patch, where the reminder question was one of several questions of a larger "panel" query after each batch (agent text, recent commands, owner messages, other supervision questions) and the list was kept by a task-store subsystem with its own MCP tool. This port is only the reminder part:

- The request carries only the reminder signals and the names of the batch's tool calls. The agent's text and the owner's messages are not sent, although the question wording (kept verbatim) still says "looking at its latest work (agent text, list, recent calls)".
- The list state is rebuilt from the hook's own batch input instead of the task store; there is no check whether an agent type has a list tool at all (the measured version skipped types without one).
- The unset default is `off` here, `shadow` there. A one-sentence remark by Jev (`uwaga`) that the patch could attach is dropped; none of the 163 reminder rows in the logs of the trial cells (98 distinct rows; the rest are copies of the same rows in the logs of runs that continued from a copy of an earlier run) carries one.
- The fixed texts for subagents do not name a tool.
- The numbers below were measured on the patch, not on this port. The port was exercised only by its unit/integration test and the offline replay.

## The exact questions sent to Jev

One question, name `przypomnienie`, type `choice`. Verbatim (Polish), final wording (`QUESTION_WITH_HISTORY` in `scripts/lib/jev-todo-hint.mjs`):

> Czy przypomnieć agentowi o liście zadań (pole state.przypomnienie: ma_liste, zadan_w_toku, wywolan_od_zmiany_listy, typ_agenta, przypomnien_dotad, ostatnie_przypomnienie, historia_przypomnien: wcześniejsze przypomnienia dla tego agenta, każde z rodzajem, trybem (active: agent je dostał, shadow: tylko zapisane), liczbą wywołań narzędzi i sekund od niego oraz informacją, czy agent wywołał narzędzie listy między tym przypomnieniem a następnym albo do teraz; starszych_pominietych: liczba starszych przypomnień poza listą; dziennik_obciety: true, gdy dziennik był za duży i jego początek nie został odczytany; null oznacza, że nie wiadomo) i które, patrząc na jego ostatnią pracę (tekst agenta, lista, ostatnie wywołania)? Liczniki są tylko sygnałem; krótki agent na jedno zadanie może nie potrzebować listy.

English translation:

> Should the agent be reminded about the task list (field state.przypomnienie: has a list, tasks in progress, calls since the list changed, agent type, reminders so far, last reminder, reminder history: earlier reminders for this agent, each with its kind, its mode (active: the agent received it, shadow: only logged), the number of tool calls and seconds since it, and whether the agent called the list tool between this reminder and the next or until now; older reminders skipped: the number of older reminders beyond the list; log truncated: true when the log was too large and its beginning was not read; null means unknown), and which one, looking at its latest work (agent text, list, recent calls)? The counters are only a signal; a short agent on a single task may not need a list.

The wording before the history fields were added (`QUESTION_BEFORE_HISTORY`):

> Czy przypomnieć agentowi o liście zadań (pole state.przypomnienie: ma_liste, zadan_w_toku, wywolan_od_zmiany_listy, typ_agenta, przypomnien_dotad, ostatnie_przypomnienie) i które, patrząc na jego ostatnią pracę (tekst agenta, lista, ostatnie wywołania)? Liczniki są tylko sygnałem; krótki agent na jedno zadanie może nie potrzebować listy.

> Should the agent be reminded about the task list (field state.przypomnienie: has a list, tasks in progress, calls since the list changed, agent type, reminders so far, last reminder) and which one, looking at its latest work (agent text, list, recent calls)? The counters are only a signal; a short agent on a single task may not need a list.

A first, shorter wording of the history sentence was also probed (row 2 of the table below); it was not kept in this port.

Answer options (`criteria`, verbatim Polish, then English) and the fixed text delivered for each kind:

| Option | Criterion text | Text delivered to the agent |
|---|---|---|
| `zadne` | Nie przypominaj (Do not remind) | none |
| `zaloz_liste` | Agent pracuje bez listy zadań: przypomnij o założeniu listy przed dalszą pracą (The agent works without a task list: remind it to create one before going on) | main: "Załóż listę zadań (TaskCreate): zadanie = jeden sprawdzalny wynik; w toku przed pracą, completed po niej." (Create a task list: a task is one checkable result; in progress before the work, completed after it.) Subagent: "Zapisz listę zadań przed pracą; zadanie = jeden sprawdzalny wynik; in_progress przed pracą, completed po niej; zadanie w toku z notatką: co robisz i po co." |
| `wpisz_krok` | Lista jest, ale nie nadąża za pracą: przypomnij o wpisaniu bieżącego kroku jako w toku (There is a list but it lags behind the work: remind to enter the current step as in progress) | "Wpisz bieżący krok na listę zadań i oznacz go jako w toku." (Enter the current step on the task list and mark it in progress.) |
| `lista_nieaktualna` | Lista jest nieaktualna: przypomnij o zaktualizowaniu statusów i zamknięciu zrobionych zadań (The list is out of date: remind to update statuses and close finished tasks) | "Lista zadań jest nieaktualna: zaktualizuj statusy, zamknij zrobione zadania i dopisz brakujące." (The task list is out of date: update statuses, close finished tasks and add missing ones.) |
| `notka` | Zadanie w toku nie ma notki, co agent robi i po co: przypomnij o notce (The task in progress has no note on what the agent is doing and why: remind about a note) | "Dopisz do zadania w toku notkę: co robisz i po co." (Add a note to the task in progress: what you are doing and why.) |

## How it was tested

All tests were of the patch, with the real Jev, on one repository task given to a Claude Code agent in an isolated sandbox (a `claude -p` session: one starting message, no human messages afterwards, 80 turns or 1200 s per segment). All numbers are small counts from single runs; there are no repeats for most cells.

1. **Functional trial, 2026-11-11 evening to 2026-11-12 early morning.** Cells with the list/reminder switch on (`OMC_TODO_HINT=active`) or off, with the panel on, in shadow or off, the standard compaction or the module's own, on two consecutive tasks (task 1, then after a second compaction task 2: a rebase of the same pull request). Success = after a reminder the receiving agent calls a list tool before the next reminder to it. Measured by a script over the agent transcripts and the logs (`scripts/jev-negative-results/todo-hint/measure.mjs` redoes the same count on a batches file).
2. **First-query analysis.** The first reminder question of two cells that started from the same list and text state and differed in the log of recent tool calls.
3. **Live probe of the history field, 2026-11-11 21:16 and 21:24 UTC.** Five real Jev requests, built by replaying the patch's hooks on the transcripts cut at the moment of two earlier queries (state a: a subagent that had no list and never created one, asked a third time; state b: the main thread right after a list change). Only the reminder question changed between the old and new wording. One try per cell, no repeats (a series of repeats was not allowed).

Reproduce without any API call:

```
node scripts/jev-negative-results/todo-hint/replay.mjs     # request bodies for two synthetic scenarios + the five recorded answers
node scripts/jev-negative-results/todo-hint/measure.mjs    # reaction count on a synthetic batches file
npx vitest run src/__tests__/jev-todo-hint.test.mjs         # hook + stub endpoint
```

With your own key (about 0.5-1k input tokens for each of four requests; the original five panel-sized requests were about 48.6k tokens in all, about 0.008 USD at a working price of 0.157 USD per million input tokens): `TYPESAFE_API_KEY=... node scripts/jev-negative-results/todo-hint/probe.mjs`.

## Results

**1. Agents did not react to the reminders (task 2, after the second compaction; this count is for task 2 only).**

| Cell (task 2 run) | Support | Reminders delivered | Followed by a list-tool call of the same agent before its next reminder |
|---|---|---|---|
| J5-LP-1-e2 (Jev's compaction module with the Haiku step) | list and panel | 6 | 0 |
| S-Ls-1-e2 (standard `/compact`) | list, panel in shadow; panel without task text | 3 | 0 |
| S5-LP-1-e2 (standard `/compact`) | list and panel | 2 | 0 |
| **the three cells above** | | **11** | **0** |
| J5off-LP-1-e2 (module without the Haiku step, accepted by Jev) | list and panel | 6 | 0 |
| J5off-LP-2-e2 (standard `/compact` after Jev rejected the module's result) | list and panel | 9 | 0 |
| J-LP-1-e2 (module with the Haiku step; panel without task text; run did not finish, no push) | list and panel | 1 | 0 |
| **all six cells with reminders** | | **27** | **0** |

No agent in these six task-2 runs called a list tool at all (0 list-tool calls in each run). The headline count in the decision record is "0 of 11" (the first three cells); the further 16 come from the same script and give the same result. Two of the six cells had a panel without the task text (a `claude -p` launch artifact), and one of them did not finish.

**2. Task 1 (first stage): reactions were rare, not zero.** In the cell where an agent created a list (it did so 11-102 s after a reminder), 8 of 12 reminders were not followed by any list call and 5 of the 12 came less than 60 s after the previous reminder to the same agent. In another cell (J-LP-2) 9 reminders were delivered and the list was never created (9 of 9 without reaction); in a third (J4-LP-1) 1 of 3 reminders was without reaction; in a fourth (J5off-LP-3) 16 of 16 were without reaction. The last count is larger than the "3-12 reminders per run" of the result summary; the difference is not explained, and the cell is listed here for completeness. The first two cells ran with the panel without the task text. In task 1, J-LP-1 called a list tool 9 times in the run, so "no list calls" is a statement about task 2 only.

**3. Reminders repeated to a subagent that never created a list.** In the first-stage analysis, 4 of the "create a list" reminders went to a single subagent that had no list and never created one (the source does not establish whether it could call a list tool); it received one about every 6 tool calls and reacted to none. The main thread got only the list-out-of-date kind after it had a list; one of three such reminders had no support in the list state (the list had changed 1.7 s earlier), one was borderline, one fitting.

**4. Two near-identical first queries gave different choices.** First reminder question of two cells with the same list and text state (empty list, same agent text), differing only in the log of recent tool calls (the log was 8,831 characters in the first cell and 11,987 in the second): `zadne` 0.47 vs `zaloz_liste` 0.50 (the choice was `zaloz_liste`, confidence 0.37) in one cell; `zadne` 0.57 vs `zaloz_liste` 0.41 in the other. Over the whole run with an empty list, `zaloz_liste` won in 3 of 11 queries in one cell and 2 of 3 in the other. Two inputs differing only in the call log gave different choices (n = 2); the cause was not separated, and a 0.47 / 0.50 pair is a near-tie while 0.57 / 0.41 is not. This is an observation, not a measured noise level.

**5. Adding the reminder history changed one answer and not the other (live probe, 5 requests, one try each).**

| State | Question | zadne | zaloz_liste | wpisz_krok | lista_nieaktualna | notka | Choice |
|---|---|---|---|---|---|---|---|
| a: subagent with no list that never created one, third reminder (history: two reminders 60 s and 29 s earlier, list unchanged) | before history | 0.40 | 0.55 | 0.02 | 0.01 | 0.02 | zaloz_liste |
| a | history, first wording | 0.43 | 0.47 | 0.05 | 0.03 | 0.02 | zaloz_liste |
| a | history, final wording | 0.49 | 0.29 | 0.10 | 0.08 | 0.04 | zadne |
| b: main thread, 2 calls and 4 s after a "list out of date" reminder, list changed 2 s after it | before history | 0.19 | 0.00 | 0.16 | 0.60 | 0.05 | lista_nieaktualna |
| b | history, first wording | 0.17 | 0.00 | 0.14 | 0.66 | 0.03 | lista_nieaktualna |

State a moved in the intended direction (`zaloz_liste` 0.55 → 0.47 → 0.29; earlier runs gave 0.54-0.61 for this subagent, so 0.29 is outside that range), but it is one try per wording. State b did not change: Jev saw that the previous reminder had just been followed by a list change and still chose to remind (this was not an agent ignoring reminders). The final wording was not tried on state b (the budget was five requests). Answer times were 551-697 ms per request.

**6. No consistent difference in own work time.** "Own work time" is the time from the start of the agent's run to its first passing commit (task 1) or its push to the fork (task 2), minus the time of all `ciezkie` calls (the lock queue and the tests together), as in the result summary of the trial. The time from the start (with `ciezkie`) is given next to it, because in task 2 a shared test queue made 25-85 % of the from-start time (ten sessions at once). All runs of the cells below with a result are listed, none left out. The trial had 32 runs with a result (18 in task 1, 14 in task 2); the cells below are the ones that bear on the list. Support: none = OMC without list or panel; list = reminder on, panel in shadow; list+panel = reminder on and panel on; panel = panel only; no OMC = plugin not loaded. "No task text" marks runs whose panel had no task text (a `claude -p` launch artifact).

Task 1 (own work time [s] / from start [s]):

| Compaction | Run | Support | Own work time / from start |
|---|---|---|---|
| standard | S-0-1 | none | 236.2 / 367.4 |
| standard | S-0-2 | none | 247.5 / 358.7 |
| standard | S-Ls-1 | list; no task text | 264.6 / 370.7 |
| standard | S-LP-1 | list+panel; no task text | 255.0 / 554.4 |
| standard | S-P-1 | panel; no task text | 818.6 / 958.7 |
| standard | S-gole-1 | no OMC | 254.8 / 488.6 |
| module (Haiku) | J-0-1 | none | 247.7 / 355.5 |
| module (Haiku) | J-0-2 | none | 293.7 / 425.6 |
| module (Haiku) | J-LP-1 | list+panel; no task text | 320.4 / 616.5 |
| module (Haiku) | J-LP-2 | list+panel; no task text | 435.9 / 794.5 |
| module (Haiku) | J4-LP-1 | list+panel | 262.0 / 368.6 |
| module (no Haiku) | J5off-LP-3 | list+panel | 342.1 / 564.7 |

Task 2 (own work time / from start; "-" = not passed):

| Compaction | Run | Support | Own work time / from start |
|---|---|---|---|
| standard | S-0-1-e2 | none | 143.4 / 762.4 |
| standard | S-LP-1-e2 | list+panel; no task text | 804.9 / 1167.1 |
| standard | S-Ls-1-e2 | list; no task text | 176.2 / 699.7 |
| standard | S-P-1-e2 | panel; no task text | 517.8 / 761.9 |
| standard | S5-LP-1-e2 | list+panel (panel of stage 1: no task text) | 121.6 / 893.9 |
| standard | S-gole-1-e2 | no OMC | 139.8 / 832.2 |
| module (Haiku) | J-0-1-e2 | none | 189.1 / 820.7 |
| module (Haiku) | J-LP-1-e2 | list+panel; no task text | not passed (no push) |
| module (Haiku) | J5-LP-1-e2 | list+panel | 496.6 / 896.5 |
| module (no Haiku) | J5off-0-1-e2 | none | not passed |
| module (no Haiku) | J5off-LP-1-e2 | list+panel | 302.3 / 644.6 |
| standard after module rejected | J5off-LP-2-e2 | list+panel | 106.7 / 300.6 |
| standard after module rejected | Joff-0-1-e2 | none | 157.3 / 485.2 |

In task 1 the own work time of the cells with list support (255-436 s) lies above that of the cells with none (236-294 s), with the single-run spread of repeats as large as the gap (S-0: 236 vs 248; J-0: 248 vs 294; J-LP: 320 vs 436; from-start repeats differ by 8 s (S-0), 178 s (J-LP) and 209 s (W-0, not in the table)). In task 2 there is no pattern: the list cells range from 107 to 805 s, the cells with none from 143 to 189 s. Single runs, no significance tests; the result does not support a gain and does not show harm. The reminder and the panel were switched together in several cells, so the cells are not a clean test of the reminder alone.

**7. Context for the earlier, threshold-based version (not ported).** Before the reminder was given to Jev, a fixed rule sent a "keep a list" hint at agent start and a "write the current step" hint after 8, 30 or 100 calls without a list change (at most three per agent). In the production log of that version (2026-11-10 23:42 UTC to 2026-11-12 00:19 UTC): 528 start rows and 436 step rows (434 delivered, 2 only logged). On 2026-11-11 alone: 525 start rows (412 with a hint text, 113 for agents recorded as having no list tool) and 432 step hints. Its effect was measured once without a control group: 35 of 75 step hints (46.7 %) were followed by a list entry, 16 of 26 (61.5 %) for agents. That version was replaced by the Jev-decided one described here, which never ran in production, only in the trial cells.

### What was not measured

- Any effect on the quality of the final work.
- Repeats: nearly all cells are one run; the spread of repeated asks of the same state is unknown.
- Whether a better question wording, or a state with the agent's own text, would change the decision. The port sends less state than the patch did.
- A trial with the reminder on and nothing else changed (the panel was on in most cells with the list).
- Whether every receiving agent could call a list tool (not established for the subagent in item 3). The sandbox agents also saw that they were in a sandbox, which changed their early behaviour.

## Why it was rejected

The decision on 2026-11-12 was to drop the feature: in the trial the reminders did not change what the agent did (0 of 11 in the headline cells, 0 of 27 in all cells with reminders after the second compaction), giving Jev the history of earlier reminders helped in one probed state (a subagent with no list, `zaloz_liste` 0.55 → 0.29, the choice flipped to `zadne`) and not in the other (main thread right after a list change), each on one try and not tested in a live run, and each batch cost a Jev request plus a Node process start (0.4-0.9 s per hook process on a laptop is an estimate from a code review of the patch, not a measurement; the request itself took about 0.6 s in the probe). With no sign of benefit the queries and the time were not worth it.

What is used instead: nothing of this. The host reminder is switched off (`CLAUDE_CODE_TODO_REMINDER_MODE=off`) and task lists are not nudged by OMC. Compaction handling of task lists, a separate feature, is unaffected.

## Related

- #4935 (merged): opt-in actions on the advisory Jev points; the same script-hook channel and `OMC_JEV` switches this experiment uses.
- #4928 (issue): the advisory points discard their `:active` answer; labelled measurements and a proposal.
- #4940 (merged): the opt-in `compaction` point, named-only like `todo-hint` here.
- #4961 (merged): hook timeouts for hooks that wait for Jev; relevant because `todo-hint:active` waits for the answer inside PostToolBatch.
