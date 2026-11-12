# Jev panel: supervision questions to Jev after each batch of tool calls

**Negative result. Tried, measured, rejected. Not for merge.**

This document and the code under `scripts/` that it describes record an experiment that did not pay off, so that nobody has to repeat it. The code is
off by default and is not wired into `hooks/hooks.json`. A reproduction kit (dry run against a local stand-in for the API, offline replay on labelled
cases, scoring script) is in `scripts/jev-negative-results/jev-panel/`.

## Summary

- A hook put up to nine questions about the agent's recent work to Jev after every batch of tool calls and handed the agent at most one short reminder.
- It ran for one working day (2026-11-11) in a long-running Claude Code session and the sub-agents that session started: 2797 answered queries.
- On a model-labelled set only one of its questions ("is the task list out of date") reached the bar we set (precision and sensitivity of at least 50 %),
  at about 77 % and 77 % on the set it was tuned on and 68-82 % and 76-79 % on a fresh set of 63 cases. The other questions produced almost no true
  positives to find (0 to 7 hints each) and every hint they gave on the fresh set was wrong.
- In a functional trial (an agent resumes the same task after a context compaction; 32 runs with a result, one or two runs per cell) the panel did not show a gain in time or quality; its stale-list hint never fired in the runs with the fixed panel.
- It was dropped on 2026-11-12. Nothing replaces it.

## What it was meant to do

Problem: a long agent session drifts. The task list goes stale (work is done but the item still says "in progress"), the agent repeats a failing action,
starts side work nobody asked for, states a value it made up, or reads files one by one when a cheaper agent could do it. The existing OMC checks are
either code heuristics (counters and thresholds) or per-event Jev points that look at a single prompt or tool call.

Hypothesis: if, once per batch of tool calls, a language model (Jev) is shown the agent's recent calls, its latest text, its task list and the order it was
given, and is asked a handful of fixed yes/no and choice questions, it will notice these situations better than counters do, and one short reminder
at the right moment will change what the agent does next. The code only counts signals and builds the state; every judgement is Jev's (no thresholds
that gate a question, no caps).

## How it worked

Hook entries (`scripts/jev-negative-results/jev-panel/hooks.snippet.json`; none is merged into `hooks/hooks.json`):

| Event | Script | What it does |
|---|---|---|
| `PostToolBatch` | `scripts/jev-lista-paczka.mjs` | one process per batch: counters, reminders about the task list, and the panel (`scripts/jev-panel.mjs`, `runPanel`) |
| `PostToolUseFailure` | `scripts/jev-panel-blad.mjs` | panel query after the second tool error in a row |
| `PostToolUse` (list tools) | `scripts/jev-lista-stan.mjs` | keeps the agent's task list (from `TodoWrite`, `TaskCreate`, `TaskUpdate`, plan tools) |
| `SubagentStart` | `scripts/jev-lista-start.mjs` | one-line hint about the list for a sub-agent that has a list tool |
| `Stop`, `SubagentStop` | `scripts/jev-panel-koniec.mjs`, `jev-panel-koniec-agenta.mjs` | end-of-turn query: the compaction-moment question and verdicts on the tasks; logged, never blocks |

**Trigger.** A query after a batch of tool calls when at least `PANEL_EVERY` (6) calls have passed since the last query of that agent, or when the task in
progress changed; after the second consecutive tool error; at the end of a turn. One query per trigger, all questions in it.

**State sent to Jev** (built in `scripts/lib/jev-panel-wejscie.mjs`, secrets masked by `scripts/lib/jev-sekrety.mjs` before serialisation): the order
(`polecenia`: the last owner messages of the main session, or the brief of a sub-agent), the agent's task list and the task in progress with its note
(`lista`, `zadanie_w_toku`, `notka`), the calls since the previous query with inputs and results (`ostatnie_wywolania`), the agent's latest texts
(`tekst_agenta`, `tekst_poprzedni`), counters computed by code (`sygnaly`: calls since the list last changed, reads, writes, repeated failures, ...),
the history of hints already given (`historia_podpowiedzi`), and `moze_delegowac` (whether the agent has the Agent tool). A state larger than the
request window of Jev is split into consecutive queries with the same questions and the answers merged (`askInParts`). Question texts are static;
no user text is inside a question.

**What is done with the answers.** A yes/no question says "yes" when its yes-probability is at least 0.5; a choice question says "yes" when the
chosen option is its target. If several questions said yes, a further choice question (`pokaz`) lets Jev pick the one hint to show (or none); the
chosen hint, one short sentence, is returned as `additionalContext` of the hook (only in `active` mode, at most once per task per kind). A separate
choice question (`przypomnienie`) lets Jev decide whether to remind the agent about the task list, and of what kind. Nothing is ever blocked. Every
query is logged as one row of `panel.jsonl` (signals, questions, probabilities, hint, milliseconds).

**Switches.**

- `OMC_JEV=panel:shadow` or `panel:active`. The point is named-only like `compaction`; `all` and `all:active` do not enable it. Needs `TYPESAFE_API_KEY`.
- `OMC_JEV_PANEL_WERSJA=2` selects the question set described here (unset: the first generation, six code-gated questions).
- `OMC_JEV_PANEL_PYTANIA=name:mode,...` sets each question to `off`, `shadow` (sent and logged, no hint) or `active` (default). In this port `slop`
  defaults to `shadow`.
- `OMC_JEV_PANEL_EVERY` (default 6), `OMC_TODO_HINT=off|shadow|active` (reminders about the list; unset means `shadow`), `OMC_SKIP_HOOKS=jev-panel`
  (panel alone) or `jev-lista` (lists and panel), `OMC_JEV_APPLIED_LOG=1` (rows in `applied.jsonl`).

### Where the code comes from

The panel does not exist in upstream. It was developed over 2026-11-10 and 2026-11-11 as a set of patches on the OMC 5.8.1 hook scripts. This
branch carries the final version (the "candidate 5" line: panel with the question set of version 2, the fix that gives the panel the order in sessions
started by another session, and the reminder history) ported onto `origin/dev`: new files only, plus a two-line change of `scripts/jev-resolve.mjs`
(`panel` becomes a named-only point with a 4000-character excerpt limit). Two small adapter modules (`scripts/lib/jev-panel-host.mjs`,
`jev-panel-shadow.mjs`) connect it to this tree. Not ported: the panel-specific circuit breaker and request-share limit, the wiring of the per-call
slop warning in `pre-tool-enforcer.mjs` to the panel (the question `slop` is therefore shadow by default), the `lista_zadan` MCP tool, and the owner-task
file written by the tool gate (the panel reads the order from the transcript instead). The port was exercised only against a local stand-in for the
API (`dry-run.mjs`, 9 checks); the measurements below were taken on the original patched plugin.

## The exact questions sent to Jev

Question names are the keys of the request; the text is static Polish, as sent. Polish is verbatim from `panelQuestionsV2`, `pokazQuestion`,
`przypomnienieDoZapytania` and `MOMENT_QUESTION` (regenerate with `node scripts/jev-negative-results/jev-panel/print-questions.mjs`); the English is
my translation. Field names in the questions (`ostatnie_wywolania`, `zadanie_w_toku`, ...) are keys of the state described above.

### One query after a batch: seven questions, a selector and a reminder question

#### `deleguj` (yes/no, type `noul`)

Polish, verbatim:

> Czy ostatnie wywołania (ostatnie_wywolania; sygnaly.odczyty to liczba odczytów w ostatnich sześciu) to seria prostych czynności jednego rodzaju (odczyt kolejnych plików, przeszukiwanie, wypisywanie, liczenie), a z tekstu, listy albo wywołań wynika, że takich kroków zostało jeszcze co najmniej trzy, i nie wymagają one decyzji, więc nadają się do zlecenia agentowi Explore albo mechanik? Odpowiedz nie, gdy agent czyta kod do zmiany, którą zaraz robi sam, gdy kroki są różnego rodzaju, gdy seria się kończy, gdy agent już deleguje albo gdy pole moze_delegowac jest false.
>
> true: Seria prostych czynności jednego rodzaju bez decyzji i zostały jeszcze co najmniej trzy takie kroki
> false: Kroki wymagają decyzji, są różnego rodzaju, seria się kończy, agent już deleguje albo nie może delegować

English:

> Are the latest calls (ostatnie_wywolania; sygnaly.odczyty is the number of reads among the last six) a series of simple actions of one kind (reading successive files, searching, listing, counting), and does the text, the list or the calls show that at least three more such steps remain and need no decisions, so that they suit an Explore or mechanik agent? Answer no when the agent reads code for a change it is about to make itself, when the steps are of different kinds, when the series is ending, when the agent is already delegating, or when the field moze_delegowac is false.
>
> true: A series of simple actions of one kind without decisions, and at least three such steps remain
> false: The steps need decisions, are of different kinds, the series is ending, the agent is already delegating or cannot delegate

#### `utknal` (yes/no, type `noul`)

Polish, verbatim:

> Czy w ostatnich wywołaniach (ostatnie_wywolania) ta sama czynność nie udała się co najmniej dwa razy (pole blad albo wynik z błędem, na przykład test, który pada), a ostatnia próba powtarza poprzednią bez istotnej zmiany? Pomaga sygnaly.powtorzone_niepowodzenie.
>
> true: Ta sama czynność zawodzi powtórnie bez zmiany podejścia
> false: Błędy dotyczą różnych czynności albo agent po błędzie zmienił podejście albo błędów nie ma

English:

> Did the same action fail at least twice in the latest calls (ostatnie_wywolania; field blad or a result with an error, for example a failing test), and does the latest attempt repeat the previous one without a significant change? sygnaly.powtorzone_niepowodzenie helps.
>
> true: The same action fails again with no change of approach
> false: The errors concern different actions, or the agent changed approach after the error, or there are no errors

#### `zrobione` (yes/no, type `noul`)

Polish, verbatim:

> Czy zadanie z pola zadanie_w_toku albo inne niezakończone zadanie z pola lista jest już wykonane według ostatnich wyników (ostatnie_wywolania, tekst_agenta, tekst_poprzedni), a na liście nie jest oznaczone jako zakończone? Gdy nie ma listy ani niezakończonych zadań, odpowiedz nie. Pomaga sygnaly.wywolan_bez_zmiany_listy.
>
> true: Zadanie jest już wykonane, a na liście nie jest zakończone
> false: Praca nad zadaniami trwa, zadania są już oznaczone albo nie ma listy

English:

> Is the task in the field zadanie_w_toku, or another unfinished task in the field lista, already done according to the latest results (ostatnie_wywolania, tekst_agenta, tekst_poprzedni), while the list does not mark it as finished? When there is no list and no unfinished task, answer no. sygnaly.wywolan_bez_zmiany_listy helps.
>
> true: The task is already done but not finished on the list
> false: Work on the tasks continues, the tasks are already marked, or there is no list

#### `notka` (yes/no, type `noul`)

Polish, verbatim:

> Czy lista zadań agenta jest nieaktualna? Tak, gdy zadanie w toku (zadanie_w_toku) albo jego notka (notka) nie opisują już tego, co agent robi w ostatnich krokach (ostatnie_wywolania, tekst_agenta), albo praca nad zadaniem jest faktycznie skończona, a zadanie nadal stoi w toku, albo agent pracuje nad zadaniem bez notki. Sygnały wywolan_bez_zmiany_listy i ta_sama_lista_zapytan pokazują tylko, jak dawno lista się nie zmieniała: sama długa cisza listy nie oznacza, że jest nieaktualna, jeśli praca nadal toczy się w opisanym zadaniu. Gdy agent nie ma zadania w toku, odpowiedz nie.
>
> true: Lista albo notka jest nieaktualna
> false: Lista i notka opisują to, co agent teraz robi, albo nie ma zadania w toku

English:

> Is the agent's task list out of date? Yes when the task in progress (zadanie_w_toku) or its note (notka) no longer describes what the agent does in the latest steps (ostatnie_wywolania, tekst_agenta), or the work on the task is in fact finished while the task still stands in progress, or the agent works on a task without a note. The signals wywolan_bez_zmiany_listy and ta_sama_lista_zapytan only show how long ago the list last changed: a long silence of the list alone does not mean it is out of date if the work still goes on in the described task. When the agent has no task in progress, answer no.
>
> true: The list or the note is out of date
> false: The list and the note describe what the agent is doing now, or there is no task in progress

#### `slop` (yes/no, type `noul`)

Polish, verbatim:

> Czy któreś z ostatnich wywołań (ostatnie_wywolania: polecenie, treść zapisywanego albo edytowanego pliku, wiadomość) zawiera język obejścia (fallback, workaround, doraźna warstwa zgodności, shim, łatka pod jedno środowisko), który zasługuje na ostrzeżenie dla agenta? Odpowiedz nie, gdy to dokumentacja, instrukcja, tekst o samym ostrzeżeniu albo zwykły opis techniczny bez obejścia.
>
> true: Wywołanie zawiera język obejścia wart ostrzeżenia poza dokumentacją i tekstem o samym ostrzeżeniu
> false: Brak języka obejścia wartego ostrzeżenia

English:

> Does any of the latest calls (ostatnie_wywolania: command, content of a written or edited file, message) contain workaround language (fallback, workaround, an ad hoc compatibility layer, shim, a patch for one environment) that deserves a warning to the agent? Answer no when it is documentation, instructions, text about the warning itself, or an ordinary technical description without a workaround.
>
> true: The call contains workaround language worth a warning, outside documentation and text about the warning itself
> false: No workaround language worth a warning

#### `poboczne` (choice, type `choice`)

Polish, verbatim:

> Czemu służą ostatnie wywołania agenta (ostatnie_wywolania, tekst_agenta)?
>
> - `polecenie`: Wykonują jedno z poleceń z pola polecenia (właściciela albo zlecenie dla subagenta) albo odpowiadają na jego pytanie
> - `lista`: Wykonują zadanie z listy (pola lista, zadanie_w_toku), także aktualizację listy i planu
> - `agenci`: Obsługują pracę agentów: raporty, powiadomienia, wiadomości, zlecenia, recenzje, scalanie ich wyników
> - `poboczne`: To nowa praca znaleziona przy okazji (naprawa, porządki, ulepszenie), której nie ma w poleceniach ani na liście i o którą nikt nie prosił

English:

> What do the agent's latest calls serve (ostatnie_wywolania, tekst_agenta)?
>
> - `polecenie`: They carry out one of the orders in the field polecenia (the owner's, or the order to a subagent) or answer its question
> - `lista`: They carry out a task from the list (fields lista, zadanie_w_toku), including updating the list and the plan
> - `agenci`: They handle the work of agents: reports, notifications, messages, orders, reviews, merging their results
> - `poboczne`: New work found on the side (a fix, tidying, an improvement) that is in neither the orders nor the list and that nobody asked for

#### `zrodlo` (choice, type `choice`)

Polish, verbatim:

> Agent wykonuje zlecenie z pola polecenia. Wybierz najważniejszą wartość albo decyzję, którą agent podaje jako fakt albo wynik w swoim tekście (tekst_agenta, tekst_poprzedni: raport, wiadomość kończąca turę) albo zapisuje w ostatnich wywołaniach (ostatnie_wywolania: plik, konfiguracja, plan, wiadomość). Skąd ona pochodzi?
>
> - `zlecona`: Wynika z poleceń (pole polecenia), listy zadań albo stałych zasad pracy: agent wykonuje to, co mu zlecono
> - `odczytana`: Pochodzi z wyniku narzędzia, pliku, pomiaru albo raportu innego agenta widocznego w polach ostatnie_wywolania lub tekst_agenta
> - `nic-nie-zapisuje`: Agent nie podaje ani nie zapisuje żadnej konkretnej wartości ani rozstrzygnięcia: czyta, szuka, mierzy, uruchamia testy, opisuje kroki albo pyta
> - `zalozona`: Agent sam ją przyjął: konkretnej liczby, daty, godziny, limitu albo rozstrzygnięcia nie ma w poleceniach ani w wynikach, a agent podaje ją albo zapisuje jako fakt

English:

> The agent is carrying out the order in the field polecenia. Pick the most important value or decision the agent states as fact or result in its text (tekst_agenta, tekst_poprzedni: a report, a closing message) or writes in the latest calls (ostatnie_wywolania: file, configuration, plan, message). Where does it come from?
>
> - `zlecona`: It follows from the orders (field polecenia), the task list or standing work rules: the agent does what it was told
> - `odczytana`: It comes from a tool result, a file, a measurement or another agent's report visible in the fields ostatnie_wywolania or tekst_agenta
> - `nic-nie-zapisuje`: The agent states or writes no specific value or decision: it reads, searches, measures, runs tests, describes steps or asks
> - `zalozona`: The agent assumed it itself: the specific number, date, time, limit or decision is in neither the orders nor the results, and the agent states or writes it as fact

#### `pokaz` (choice among the hints on offer)

Polish, verbatim:

> Pozostałe pytania tego zapytania osądzają osobno, czy dana podpowiedź jest zasadna. Którą jedną podpowiedź pokazać agentowi teraz (stan: polecenia, lista, ostatnie_wywolania, tekst_agenta, sygnaly)? Gdy zasadnych jest kilka, wybierz tę, która agentowi najbardziej pomoże. Wybierz zadna tylko wtedy, gdy historia_podpowiedzi pokazuje podobną podpowiedź bez skutku albo agent już zrobił to, co zaleca podpowiedź.
>
> - `zadna`: Podobna podpowiedź padła już niedawno w tym zadaniu i nic nie zmieniła (pole historia_podpowiedzi), albo agent już zrobił to, co zaleca podpowiedź
> - `deleguj`: Pokaż agentowi podpowiedź: zlecić kolejne proste odczyty jednemu agentowi Explore albo mechanik
> - `poboczne`: Pokaż agentowi podpowiedź: dopisać pracę poboczną na listę albo zlecić ją w tle i wrócić do zadania
> - `zrodlo`: Pokaż agentowi podpowiedź: sprawdzić w źródle wartość, której nie ma w poleceniach ani wynikach, albo oznaczyć ją jako własne założenie
> - `utknal`: Pokaż agentowi podpowiedź: nie powtarzać nieudanej czynności i zmienić podejście
> - `zrobione`: Pokaż agentowi podpowiedź: zakończyć zadanie na liście albo dopisać, czego brakuje
> - `slop`: Pokaż agentowi podpowiedź: nie dokładać doraźnych warstw zgodności ani łatek pod jedno środowisko bez uzasadnienia, a założenia środowiskowe zapisać w raporcie
> - `notka`: Pokaż agentowi podpowiedź: zaktualizować listę: dopisać albo poprawić notkę zadania w toku

English:

> The remaining questions of this query judge separately whether a given hint is justified. Which one hint to show the agent now (state: polecenia, lista, ostatnie_wywolania, tekst_agenta, sygnaly)? When several are justified, pick the one that will help the agent most. Pick zadna only when historia_podpowiedzi shows a similar hint without effect or the agent has already done what the hint recommends.
>
> - `zadna`: A similar hint was already given recently in this task and changed nothing (field historia_podpowiedzi), or the agent has already done what the hint recommends
> - `deleguj`: Show the agent the hint: hand the next simple reads to one Explore or mechanik agent
> - `poboczne`: Show the agent the hint: add the side work to the list or hand it off in the background and return to the task
> - `zrodlo`: Show the agent the hint: check in the source a value that is in neither the orders nor the results, or mark it as the agent's own assumption
> - `utknal`: Show the agent the hint: do not repeat the failed action and change the approach
> - `zrobione`: Show the agent the hint: close the task on the list or write down what is missing
> - `slop`: Show the agent the hint: do not add ad hoc compatibility layers or patches for one environment without justification, and write the environmental assumptions in the report
> - `notka`: Show the agent the hint: update the list: add or correct the note of the task in progress

(The options are `zadna` plus one per question that is `active` in the query; the Polish option texts are `Pokaż agentowi podpowiedź: ` followed by a gist, translated above.)

#### `przypomnienie` (choice, about the task list)

Polish, verbatim:

> Czy przypomnieć agentowi o liście zadań (pole state.przypomnienie: ma_liste, zadan_w_toku, wywolan_od_zmiany_listy, typ_agenta, przypomnien_dotad, ostatnie_przypomnienie, historia_przypomnien: wcześniejsze przypomnienia dla tego agenta, każde z rodzajem, trybem (active: agent je dostał, shadow: tylko zapisane), liczbą wywołań narzędzi i sekund od niego oraz informacją, czy agent wywołał narzędzie listy między tym przypomnieniem a następnym albo do teraz; starszych_pominietych: liczba starszych przypomnień poza listą; dziennik_obciety: true, gdy dziennik był za duży i jego początek nie został odczytany; null oznacza, że nie wiadomo) i które, patrząc na jego ostatnią pracę (tekst agenta, lista, ostatnie wywołania)? Liczniki są tylko sygnałem; krótki agent na jedno zadanie może nie potrzebować listy.
>
> - `zadne`: Nie przypominaj
> - `zaloz_liste`: Agent pracuje bez listy zadań: przypomnij o założeniu listy przed dalszą pracą
> - `wpisz_krok`: Lista jest, ale nie nadąża za pracą: przypomnij o wpisaniu bieżącego kroku jako w toku
> - `lista_nieaktualna`: Lista jest nieaktualna: przypomnij o zaktualizowaniu statusów i zamknięciu zrobionych zadań
> - `notka`: Zadanie w toku nie ma notki, co agent robi i po co: przypomnij o notce

English:

> Should the agent be reminded about the task list (field state.przypomnienie: ma_liste, zadan_w_toku, wywolan_od_zmiany_listy, typ_agenta, przypomnien_dotad, ostatnie_przypomnienie, historia_przypomnien: earlier reminders for this agent, each with its kind, mode (active: the agent received it, shadow: only recorded), number of tool calls and seconds since it, and whether the agent called the list tool between this reminder and the next or until now; starszych_pominietych: the number of older reminders outside the list; dziennik_obciety: true when the journal was too big and its beginning was not read; null means unknown) and which one, given its latest work (agent text, list, latest calls)? The counters are only a signal; a short agent on a single task may not need a list.
>
> - `zadne`: Do not remind
> - `zaloz_liste`: The agent works without a task list: remind it to create a list before further work
> - `wpisz_krok`: There is a list but it does not keep up with the work: remind it to enter the current step as in progress
> - `lista_nieaktualna`: The list is out of date: remind it to update statuses and close finished tasks
> - `notka`: The task in progress has no note about what the agent is doing and why: remind it about the note

### Hints returned to the agent

Each hint is a sentence that stands alone. The task name comes from the agent's own list and goes back only to that agent. In the `zrobione` hint below `TASK` and `12` are sample values for the task name and the number of calls since the list changed.

- `deleguj` (Polish, verbatim): Ostatnie wywołania to seria odczytów i przeszukiwań. Jeśli zostało ich więcej, zleć je jednemu agentowi Explore albo mechanik: podaj mu listę plików i pytanie, na które ma odpowiedzieć.
  English: The latest calls are a series of reads and searches. If more remain, hand them to one Explore or mechanik agent: give it the list of files and the question it should answer.
- `poboczne` (Polish, verbatim): Ostatnie kroki to praca poboczna, której nie ma w poleceniach ani na liście. Dopisz ją na listę jako osobne zadanie albo zleć agentowi w tle i wróć do zadania w toku.
  English: The latest steps are side work that is in neither the orders nor the list. Add it to the list as a separate task or hand it to an agent in the background and return to the task in progress.
- `zrodlo` (Polish, verbatim): Zapisujesz wartość albo decyzję, której nie ma w poleceniach ani w odczytanych wynikach. Sprawdź ją w źródle jednym poleceniem (plik, dziennik, pomiar); jeśli to Twój wybór, napisz to wprost obok tej wartości.
  English: You are writing a value or decision that is in neither the orders nor the results read. Check it in the source with one command (file, log, measurement); if it is your own choice, say so right next to that value.
- `utknal` (Polish, verbatim): Ta sama czynność nie udała się co najmniej dwa razy. Nie powtarzaj jej: przeczytaj treść błędu i zmień podejście (inne narzędzie, inna ścieżka, mniejszy krok), a blokadę hooka albo uprawnień zapisz w raporcie i idź dalej.
  English: The same action failed at least twice. Do not repeat it: read the error and change the approach (another tool, another path, a smaller step), and note a hook or permission block in the report and go on.
- `slop` (Polish, verbatim): Ostrzeżenie: w ostatnich wywołaniach jest język obejścia (fallback, workaround). Nie dokładaj doraźnych warstw zgodności, shimów ani łatek pod jedno środowisko bez wyraźnego uzasadnienia; przy kwestii architektury zleć projekt architektowi, a założenia środowiskowe zapisz w raporcie.
  English: Warning: there is workaround language (fallback, workaround) in the latest calls. Do not add ad hoc compatibility layers, shims or patches for one environment without clear justification; for an architecture question hand the design to the architect, and write environmental assumptions in the report.
- `zrobione` (Polish, verbatim): Lista zadań jest nieaktualna: zadanie w toku „TASK” ma notkę sprzed co najmniej 12 wywołań. Oznacz je jako zakończone albo popraw notkę jednym zdaniem.
  English: The task list is out of date: the task in progress "TASK" has a note from at least 12 calls ago. Mark it finished or fix the note in one sentence.

`notka` uses the same out-of-date-list hint as `zrobione`; when the task has no note at all it says: "The task in progress has no note. Add one sentence: what you are doing and why." (Polish, verbatim: `Zadanie w toku „…” nie ma notki. Dopisz jedno zdanie: co robisz i po co.`)

### End-of-turn moment question (belongs to the compaction work, sent by the Stop hook of the panel)

Polish, verbatim:

> Czy teraz jest dobry moment na kompakcję rozmowy tego agenta? Weź pod uwagę, w jakim stanie jest praca (odpowiedz, zadania_w_toku, ostatnio_zamkniete, agenci_w_toku), ile tokenów rozmowa ma (tokeny, w_pasmie, ponad_400), ile trzeba zdjąć do limitu (ile_zdjac_tok) i co da kompakcja (prognoza_ciecia, przyrost). Gdy ponad_400 jest prawdą, próg 400 tys. jest przekroczony: decyzja nadal należy do Ciebie.
>
> true: Dobry moment: praca doszła do końca etapu, szczegóły z ostatnich kroków nie będą zaraz potrzebne.
> false: Zły moment: praca w toku, zaraz wróci do świeżych szczegółów, które właśnie czytała albo zmieniała.

English:

> Is now a good moment to compact this agent's conversation? Consider the state of the work (odpowiedz, zadania_w_toku, ostatnio_zamkniete, agenci_w_toku), how many tokens the conversation has (tokeny, w_pasmie, ponad_400), how much must come off to reach the limit (ile_zdjac_tok) and what compaction would yield (prognoza_ciecia, przyrost). When ponad_400 is true, the 400k threshold is exceeded: the decision is still yours.
>
> true: A good moment: the work reached the end of a stage, details of the latest steps will not be needed right away.
> false: A bad moment: work in progress, it will soon return to fresh details it has just been reading or changing.

## How it was tested

1. **Live, 2026-11-11.** The panel ran in `active` mode in one long-running Claude Code session (an orchestrating main session) and in every sub-agent it
   started, from 08:14 UTC to the end of the day. Two generations: the first (six questions gated by counters, 08:14-12:09 UTC) and version 2 (the gates replaced by
   signals that Jev reads with the input, from 12:10 UTC). The mode of each question was changed during the day with `OMC_JEV_PANEL_PYTANIA`; each
   row of `panel.jsonl` records the modes in force (`pytania_tryb`), and in most version-2 queries `zrodlo` and often `zrobione` or `notka` were
   `shadow`. The recommended setting after the day's scoring was `zrodlo:shadow,poboczne:shadow,utknal:shadow,deleguj:shadow`.
2. **Labelled replay (the scoring).** Cases were taken from `panel.jsonl`; the state at the moment of each query was rebuilt from the session
   transcript and the panel was replayed against the live Jev. Ground truth came from language-model labellers, not humans: for the tuning set four
   `verifier` agents labelled blind (one on Sonnet, three on Haiku) with one written instruction, six yes/no/unsure questions per case, and a
   second pass of 24 random cases; for the fresh set one Claude session and one blind sub-agent labelled independently (they agreed on 55 of 63).
   *Success criterion set beforehand:* precision of the hints (correct hints / hints) and sensitivity (correct hints / cases whose truth is yes) both
   at least 50 %, and at most 15 false list hints per 100 queries. Cases labelled "unsure" are skipped.
3. **Functional trial.** One real agent session (about 454 thousand tokens, the task being a review round on a pull request) was copied, compacted by
   the variant under test, and resumed with the single message "Continue the task to the end and hand over the result", with no human message after it.
   Success was a test file written and validated before the runs; a second task (a rebase onto a moved branch with conflicts) followed a second
   compaction. Sandbox: remote repositories replaced by local bare repositories, `gh` replaced by a stub that fails. 32 runs with a result (18 + 14);
   details, the time measure and the plan's count of 28 are under Results.

**Reproduce.** `scripts/jev-negative-results/jev-panel/README.md`: the dry run (`dry-run.mjs`, no key, no cost), the offline replay
(`replay-labelled.mjs`, with `--dry-run` to build states only; needs your own transcripts and labels, about two Jev requests per case) and the scoring
(`metrics.py`). The original labels were made from real sessions and are not published.

## Results

Dates are 2026-11-11 to 2026-11-12. Unless stated, a number comes from one long-running session and its sub-agents.

### Live volume and cost of waiting (`panel.jsonl`, rows dated 2026-11-11 UTC)

| What | Value |
|---|---|
| rows logged | 2851 |
| queries answered by Jev in `active` mode | 2797 (the other 54 were skipped because the circuit breaker was open) |
| of those, by hook | `PostToolBatch` 2472, `Stop` 168, `SubagentStop` 150, `PostToolUseFailure` 7 |
| first generation (08:14-12:09 UTC) / version 2 (12:10-23:59 UTC) | 596 / 2201 queries |
| Jev round trip | median 608 ms (`ms`) |
| wall time of the hook (every batch waits for it) | median 843 ms, 95th percentile 1186 ms (`ms_hook`) |
| queries whose row lists at least one hint (`podpowiedzi`) | first generation 87 of 596 (14.6 %: `pytanie` 72, `osobna-sesja` 22, `zrobione` 10); version 2 6 of 2201 (0.3 %: `notka` 4, `zrobione` 2; many of those queries had questions in `shadow`, so this is not the rate of an all-active panel) |

### The panel did not see the order in some sessions

The state field `polecenia` (the order the agent was working on) is what most questions are judged against. Counting `panel.jsonl` rows of
2026-11-11 (batch and failure queries answered in `active` mode): in the main session it was empty in 121 of 290 queries, all of them the 121 queries
from 08:14 to 12:06 UTC (the first-generation code); the version 2 code filled it from its first query at 12:10 UTC (169 of 169 filled). Sub-agents
always had it: 0 of 2189 queries empty. A second gap showed up in the functional trial: a session started by another session or script (`claude -p`,
a team message; no `origin: human` row in the transcript) had `polecenia` empty in every main-session query of two early test runs (17 of 17 and 11 of 11 at the
first look, 20 of 20 and 15 of 15 in the final logs).
The fix (read the first user message of the transcript when there is no human row) is in this port and is covered by `dry-run.mjs`. In the
second task of the functional trial the panel was queried only 5 to 9 times per run; the cells with the fix had the order in every one of those `PostToolBatch` queries
(5 of 5 and 7 of 7; the `Stop` query had none: 5 of 6 and 7 of 8), the cells with the unfixed code in none (0 of 7, 0 of 7, 0 of 8, 0 of 9). The author of the trial marked the unfixed cells
"panel without the order" and drew no conclusion about the panel from them.

### Scoring on labelled cases

Tuning set: 194 cases from the first day (60 first-generation rows sampled from 596 with a fixed seed, 134 version-2 rows), one session and its
sub-agents. `v1` and `v2` are the hints that the two live generations actually produced on those cases; `v3` is an offline replay of the later panel
code on all 194 cases ("batch" = the hook after a batch only; "batch plus end-of-turn" = also with the supervision questions at the end of a turn,
which the final `Stop` hook no longer asks, so that row is informational). "Hits" are hints whose truth label is yes.

| Question | Generation | Cases with truth yes | Hints | Precision | Sensitivity |
|---|---|---|---|---|---|
| `zrodlo` (v1: `pytanie`) | v1 | 4 of 60 | 6 | 0 / 6 | 0 / 4 |
| `zrodlo` | v2 | 1 of 133 | 0 | n/a | 0 / 1 |
| `zrodlo` | v3 | 5 of 193 | 0 | n/a | 0 / 5 |
| `poboczne` (v1: `osobna-sesja`) | v1 / v3 | 1 of 60 / 1 of 194 | 1 / 0 | 0 / 1 | 0 / 1 |
| `notka` | v2 | 61 of 133 | 3 | 3 / 3 | 3 / 61 (5 %) |
| `notka` | v3 | 93 of 193 | 14 | 14 / 14 | 14 / 93 (15 %) |
| `zrobione` | v2 | 33 of 134 | 1 | 1 / 1 | 1 / 33 (3 %) |
| `zrobione` | v3, batch query only | 40 of 194 | 2 | 2 / 2 | 2 / 40 (5 %) |
| `zrobione` | v3, batch plus end-of-turn query | 40 of 194 | 17 | 10 / 17 (59 %) | 10 / 40 (25 %) |
| `utknal` | v1 / v2 / v3 | 0 / 1 / 1 | 0 | n/a | 0 / 1 |
| `deleguj` | v1 / v2 / v3 | 4 / 0 / 4 | 0 | n/a | 0 / 4 |

No question in any generation met the bar (precision and sensitivity both at least 50 %). Closest: `zrobione` in v3 with the end-of-turn query,
59 % and 25 %. Rows with fewer than 10 positive cases (`zrodlo`, `poboczne`, `utknal`, `deleguj`) are too few to judge sensitivity at all.

The final code (version 2 questions, `pokaz` selector, queries split to fit the request window) was then scored on "list is out of date" as one hint
(the `zrobione` or `notka` choice), on the same 194 cases the descriptions of `notka`, `deleguj`, `zrobione` and `pokaz` had been tuned on in four
passes, so the first row is not an independent result; the second row is:

| Set | Hints | Precision | Sensitivity | False list hints per 100 batch queries |
|---|---|---|---|---|
| tuning set, 194 cases (first measurement; a repeat on the final code gave 76 % / 76 %) | 107 | 77 % | 77 % (107 positive cases) | 12.9 (25 of 194) |
| fresh set, 63 cases, 31 agents, no row shared with the tuning set, labelled by a Claude session | 34 | 68 % (23 / 34) | 79 % (23 / 29) | 17.5 (11 / 63) |
| the same fresh set, labelled by a blind sub-agent | 34 | 82 % (28 / 34) | 76 % (28 / 37) | 9.5 (6 / 63) |
| the 55 cases on which the two labellers agreed | 29 | 79 % (23 / 29) | 79 % (23 / 29) | 10.9 (6 / 55) |

The bar was met under two of the three labellings and missed (17.5 against 15) under the strictest. The other four questions, on the fresh set: 0
positive cases under both labellings, five hints, all false. Definitions: precision = correct hints / hints; sensitivity = correct hints /
all cases with truth yes; false hints per 100 = batch queries where the "list" hint was given and the truth was not yes, per 100 queries (see
`metrics.py`). On the fresh set the replay needed 134 Jev requests for 63 cases (17 states were split into 2-5 parts), none unanswered.

Selector `pokaz` (the one hint shown) and its fallback rule: if `pokaz` names a question that is not among the "yes" answers and is not `zadna`, the
final code uses the most probable "yes" instead (`pokaz_sprzeczny` in the row; `scripts/jev-panel.mjs`); a `zadna` from Jev still means no hint. The
fresh-set report does not say whether its headline figures include this rule. Its replay of the code without the rule gave a sensitivity of the
hint actually chosen of only 28 % / 32 % (by the two labellers; 7.9 / 1.6 false per 100), and its replay with the rule 79-83 % sensitivity and
66-69 % / 83-86 % precision (17.5 / 7.9 false per 100). On the same 63 cases: on the same 63 cases, it named a hint outside the questions that had answered yes in that very query in
32 of 46 counted queries (the count and the denominator are the report's own). Reordering the options changed nothing (31 of 48); a rewording
that offered only the "yes" questions moved Jev to "none" despite a yes in 33 cases. The consequence was that a correct "yes" was often not what the
agent was shown; that is what the fallback rule was added for.

### Functional trial (one real task, 32 runs with a result)

Cells differ in the compaction variant (S: standard `/compact`; J: our Jev compaction with a summarising Haiku step) and in the support (0: panel
questions off; P: panel with `zrobione` and `notka` active, the rest shadow; Ls: list reminders on, all panel questions shadow; LP: both). **Own work
time** (used everywhere below): time from the start of the run minus all time spent in `ciezkie` calls (the lock queue and the tests together), as in
the trial's results file; "from start" is the time from the start of the run to the first passing commit (task 1) or push (task 2). Both include load
from ten sessions running at once. The results file lists 32 runs with a result, 18 in task 1 and 14 in task 2; the plan note that closed the work
counted 28 (17 + 11) because it was written before the file was regenerated.

"Old" panel = the code that had no access to the order in these runs (see above); "fixed" = the later code that reads it. The author of the trial
marked the old-panel rows "panel without the order" and drew no conclusion about the panel from them.

**Task 1 (a review round after the first compaction), the standard and the J-with-Haiku cells, every run, none left out.** All of them passed by the
trial's round rule (the relaxed check); none passed the strict check except W and one run without Haiku, which are not in this table.

| Run | Compaction | Support | From start (s) | Own work (s) |
|---|---|---|---|---|
| S-gole-1 | S | none (no OMC at all) | 488.6 | 254.8 |
| S-0-1 | S | questions off | 367.4 | 236.2 |
| S-0-2 | S | questions off | 358.7 | 247.5 |
| S-Ls-1 | S | list, old panel (all questions shadow), partly without the order | 370.7 | 264.6 |
| S-P-1 | S | old panel, without the order | 958.7 | 818.6 |
| S-LP-1 | S | list and old panel, without the order | 554.4 | 255.0 |
| J-0-1 | J with Haiku | questions off | 355.5 | 247.7 |
| J-0-2 | J with Haiku | questions off | 425.6 | 293.7 |
| J-LP-1 | J with Haiku | list and old panel, without the order | 616.5 | 320.4 |
| J-LP-2 | J with Haiku | list and old panel, without the order | 794.5 | 435.9 |
| J4-LP-1 | J with Haiku | list and fixed panel (candidate 4) | 368.6 | 262.0 |

**Task 2 (a rebase after the second compaction), exactly one run per cell:** the panel was queried 5 to 9 times per run in the main session.
"Panel queries, with the order" counts main-session `PostToolBatch` queries only, from my count of each run's `panel.jsonl`; counting the `Stop` query
too it is 5 of 6 and 7 of 8 for the two fixed runs.

| Run | Compaction | Panel | List reminders | Panel queries, with the order | From start (s) | Own work (s) | Passed |
|---|---|---|---|---|---|---|---|
| S-gole-1 | S | none (no OMC at all) | none | 0 | 832.2 | 139.8 | yes |
| S-0-1 | S | questions off | off | 0 | 762.4 | 143.4 | yes |
| S5-LP-1 | S | fixed, `zrobione` and `notka` active | on | 5, 5 | 893.9 | 121.6 | yes |
| S-Ls-1 | S | old, without the order, all questions shadow | on | 7, 0 | 699.7 | 176.2 | yes |
| S-P-1 | S | old, without the order | off | 8, 0 | 761.9 | 517.8 | yes |
| S-LP-1 | S | old, without the order | on | 7, 0 | 1167.1 | 804.9 | yes |
| J-0-1 | J with Haiku | questions off | off | 0 | 820.7 | 189.1 | yes |
| J5-LP-1 | J with Haiku | fixed | on | 7, 7 | 896.5 | 496.6 | yes |
| J-LP-1 | J with Haiku | old, without the order | on | 9, 0 | not passed (limit of 2 x 1200 s, no push) | n/a | no |

Read plainly: with the same compaction (J with Haiku), no panel took 189 s of own work (821 s from start) and the fixed panel with reminders took
497 s (897 s from start); with standard compaction the fixed panel with reminders took 122 s against 143 s without. The own-work figures and the
from-start figures do not rank the cells the same way (J-0-1 and J5-LP-1 are 76 s apart from start and 307 s apart in own work), so the comparison depends on
the measure. One J run with the old panel never finished. The author's own note on the old-panel rows is that no conclusion about the panel should
be drawn from them, and I draw none.

**What the panel actually said in task 2.** In the two runs with the fixed panel, no `zrobione` or `notka` hint was given; the only panel hints
were `slop` (2 in S5-LP-1, 1 in J5-LP-1). So the stale-list question, the one that had the measured accuracy, did not fire in these runs, and the
trial therefore tested the other parts (reminders about the list, the `slop` hint, the cost of waiting) rather than that question.

**Reminders about the task list.** In task 2, 11 reminders were delivered over three runs (S5-LP-1: 2, J5-LP-1: 6, S-Ls-1: 3; counted from each run's
`todo-hint.jsonl`) and the agent changed its list after none of them (the plan note; the results file adds that in S5-LP-1 and J5-LP-1 the agent
never created a list). In task 1 the picture was not zero: in J-LP-1 the agent did not react to 8 of 12 reminders, so 4 were followed (results file).

What this does not show: it is one session, one task, one run per cell in task 2 and one or two in task 1; repeated runs of the same cell differed
by up to about 200 s in task 1 (S-0 367 and 359 s from start, J-0 356 and 426 s, J-LP 617 and 795 s), and the author's own reading is that
differences under about 200 s are not decisive; there are no significance tests; "cell 0" still ran the other Jev points and the end-of-turn query;
four stage-1 runs of one series had no OMC loaded at all; and a stub artefact made the second compaction of two cells fall back to the standard
one. It did not show a gain from the panel. It does not prove the panel cannot help on another task or with a stronger question, and the trial did not test
the stale-list hint, which never fired.

## Why it was rejected

1. **Coverage.** One question of seven (the stale list) met its bar, and only after tuning: in the live generations its sensitivity was 3 % to 15 %
   (25 % at best with the end-of-turn query), and 77 % only on the final code. The other questions had too few real cases in 194 (0 to 5 each) to
   measure sensitivity, gave 0 to 7 hints on the tuning set (one correct of 7 for `deleguj`) and five hints, all wrong, on the fresh set.
2. **No effect shown in the trial.** In task 2 the agent did not act on the 11 list reminders (task 1 was mixed: 4 of 12 followed in one run), and the
   trial showed no gain in time to a passing result or in the result itself. The stale-list hint itself never fired in the fixed-panel runs, so the trial
   did not test it.
3. **Cost of waiting.** One Jev request per batch of tool calls, about 2800 requests in one working day, and a hook wall time of 0.84 s median
   (1.19 s at the 95th percentile) on every batch.
4. **Fragility.** The state depends on the order, the task list and the transcript format; it was blind to the order in 121 of 121 queries of one
   session until it was fixed, and it still was for sessions started by scripts until a second fix.
5. **Decision.** On 2026-11-12, after the trial, the author set the point `panel` and the reminders to `off` and dropped the work, judging that the trial showed no gain in time or quality.

What is used instead: nothing for the panel. The task list tool and the agent's own judgement stay; the per-call advisory points of upstream with their
opt-in actions (#4935) are unchanged; standard compaction, and upstream's opt-in `compaction` point (#4940), are unaffected.

## Not measured

- Quality of the final result of real work with and without the panel over many sessions (only the one trial task).
- Human labels: every label above was made by a language-model agent following a written instruction.
- Token cost of the panel queries (request sizes were bounded by the request window; no cost per query is claimed here).
- A panel with a different set of questions, a different trigger rate, or a model other than Jev.
- The effect of the panel on the quality of agent output when the order was available from the start (most live queries) beyond what the labelled
  replay says about the hints.

## Related PRs and issues

- #4935 (merged 2026-11-10): opt-in actions on the slop-warning, learner-extraction, simplifier-trigger and loop-continuation answers. The panel's
  `slop` question reproduced the slop warning inside the batch query instead of one query per call.
- #4928 (closed): labelled measurements of four advisory points that discard their `:active` answer; same labelling approach as here.
- #4940 (merged 2026-11-10): opt-in `compaction` point; the end-of-turn query of the panel also asked a compaction-moment question, which is
  covered by the compaction work and is not part of this result.
