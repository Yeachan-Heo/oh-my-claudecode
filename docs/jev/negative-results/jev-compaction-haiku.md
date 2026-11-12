# Jev compaction, step B: Haiku summarises old episodes, Jev decides what replaces them

**Negative result. Tried, measured, rejected. Not for merge.**

Jev is the hosted decision service (Typesafe AI) that OMC's judgment points call from hooks; each call is a set of questions about a state and the answer is a choice or a probability. Scope of the result, stated first so it is not misread: this is about one add-on only, the optional "step B" in which Claude Haiku writes summaries of old parts of the conversation and Jev chooses whether to accept each summary (`OMC_JEV_COMPACT_HYBRID`). It is **not** a result about the `compaction` judgment point itself. That point (Jev scores tool results and decides what the compaction keeps, merged in #4940 and refined in the follow-ups listed at the end) is merged, in use, and kept. Step B was an extension on top of it, and only the extension was dropped.

## What it was meant to do

Problem: after a compaction of a long Claude Code session the context was still larger than the 120k-token target, because the old part of the conversation (assistant replies, agent reports, tool calls) stayed in its original wording or as traces. Hypothesis: if old stretches of the conversation are replaced by short summaries, with the full text kept in a file the model can read, the context after compaction drops well below the target, and Jev, not code, keeps the decision about which stretch may be replaced.

Design rules that came with the hypothesis:

- Code only counts signals; every decision about content is Jev's. Code decides only what the host forces (call/result pairs, rows with images, secret masking) and what to do when Jev does not answer (nothing is lost: the stretch stays verbatim or becomes a trace with a file path).
- Haiku writes the summaries (`$.model.complete` of the hooks host, so on the session's own account, no API key), in the background after turns, not inside the hook budget.
- The full text of every episode is written, secret-masked, to a file; the summary or trace in the conversation points to it.

## How it worked

Unit: an **episode** is everything between two consecutive owner messages (episode 0 is whatever precedes the first one, e.g. the host's earlier summary). The owner message that opens an episode stays in the conversation as its own row; the rest of the episode is what may be replaced. Closed episodes get a key (sha256 of their text without tool results). Long episodes are cut into parts aligned to row boundaries; all decisions are per part.

Trigger and flow (default "one pass", the last state of the branch):

1. `turn.complete` (main loop only, after `await next(e)`) starts a detached background step `krokBTurnComplete`. It never blocks the next turn and never throws.
2. For each closed episode without a decision, Haiku (`model: 'haiku'`, one call per part) writes a short summary. The input is the masked text of the part, the prompt asks for: what was ordered or agreed, what was done with what result (numbers), what remains open or promised, task numbers, agent names, files; no opinions; do not repeat the owner's words; copy numbers, paths, ids and quoted names exactly.
3. Code computes a fact-check signal for each summary: how many numbers, paths and identifiers of the summary occur in the original, and which do not (`sygnaly`). It rejects nothing by itself.
4. Jev receives **one question per part** with the original (`tekst`), the summary (`streszczenie`), the signals, the state of the task list, age, whether the part is in the fresh tail, and the token budget. It chooses one of four forms: trace with file path, the summary, "a longer summary" (then Haiku writes one and a second question, without that option, follows), or verbatim. A second, atomic question asks whether the summary contradicts the original or states a fact not in it.
5. Code composes the decision from the answers: any form other than "summary" stays as Jev chose; "summary" is used only when the contradiction answer is clearly "no" (below 0.3); if Jev is unsure (0.3-0.7) or contradicts, the better of verbatim/trace by Jev's own probabilities wins. Nothing is guessed.
6. At compaction (`session.compact`), `krokB` reads the stored decisions and summaries from files and returns the rewritten conversation: summary rows (marked `[streszczenie odcinka`), trace rows (`[ślad odcinka`) with the path of the full text, a header row that states that the rows are not the owner's words, the owner's rows, and the fresh tail untouched. Any failure (exception, bad pairing, missing file, different key) falls back to the compaction without step B and records `hybrid.fallback`; the step never returns a partial result.

Files (under the Jev state directory): `odcinki/<session>/S<n>-<key12>.md` (full masked text), `streszczenia/<session>/<key>.json` (summaries, per-part decisions), `werdykty/<session>/odcinek/<key>.json` (verdict per episode), `krok-b-stan/<session>.json` (forecast).

Switch: `OMC_JEV_COMPACT_HYBRID` = `off` | `shadow` | `active`. In the original local patch an unset variable meant `active`. The integration patch in this branch changes that one line so that an unset variable means **off** (only `active` and `shadow` switch the step on); with that change the local test suite still passes 59 of 59. `shadow` computes and records but does not install the result. Related environment variables of the host module (`OMC_JEV`, `OMC_JEV_WINDOW_CHARS`, ...) are those of the `compaction` point.

Where the code is. The code is **not** in the OMC tree of this branch. The step was written against a local compaction module of about 6,500 lines (8,450 with the block) that carries several features the upstream module (`hooks/jev-compaction.mjs`, about 1,900 lines) does not have: verdict files and a background verdict pass, archive of cut results, long-reply and agent-message handling, a task-list store, a moment chosen by Jev, shared window and packing logic. The step's block calls 38 names from that module, 25 of which the upstream module does not define (`isOwnerWords`, `cleanForJev`, `chooseByRank`, `nonTextRows`, `windowCharsOf`, ...). Porting it to upstream would mean rewriting those, the code is attached as a self-contained block plus a patch against that local base, under `scripts/jev-negative-results/jev-compaction-haiku/`:

- `jev-krok-b.mjs`: the block, unchanged (1,885 lines).
- `integration-points.patch`: the 7 call points (8 marked fragments) it needs in the local module (config read with the default-off switch, `decide()` call point, header, preparation before the request, per-turn hook, registration), 99 lines. Applies to the local module without step B (sha256 prefix `cbe147511d30442b`), not to upstream.
- `replay.mjs`, `make-sample.mjs`, `sample/`: an offline replay that loads the block behind stand-ins for the missing names (see the README there). This is how to rerun the logic without the local module, without a host and without an API key.

## The exact questions sent to Jev

The questions are in Polish (the working language of the sessions they were written for). Verbatim Polish, then an English translation. Field paths such as `` `odcinki.o1.tekst` `` are filled per question (`o1`, `o2`, ... are the ids of parts in one request); question ids themselves are not sent to the model, so each question names its fragment of the state by path.

### Default (one pass): decision about one part

Type `choice`. The question with a summary (`{frag}` = `odcinki.<id>`):

```json
{
  "question": "Czym zastąpić w rozmowie fragment rozmowy z `{frag}.tekst`, żeby dalsza praca nad otwartymi zadaniami niczego nie straciła, a rozmowa zmieściła się w budżecie?",
  "compare": ["`{frag}.tekst`", "`{frag}.streszczenie`", "`{frag}.stan_zadan`", "`zadanie`", "`budzet`"],
  "focus": "Oceń skutek dla dalszej pracy nad otwartymi zadaniami i budżet rozmowy, nie styl streszczenia."
}
```

Translation: "What should replace, in the conversation, the stretch of conversation in `{frag}.tekst`, so that further work on the open tasks loses nothing and the conversation fits the budget? Compare: the original, the summary, the task state, the task, the budget. Focus: judge the effect on further work on the open tasks and on the conversation budget, not the style of the summary."

Options (`criteria`; `slad`, `streszczenie`, `obszerniejsze`, `doslownie`):

```json
{
  "slad": {
    "what": "Do dalszej pracy nad zadaniami wystarczy wiedzieć, że ta część była, i mieć ścieżkę do pliku z oryginałem; plik da się odczytać, gdy zajdzie potrzeba",
    "not_for": "Części z ustaleniami, liczbami, nazwami plików albo decyzjami, których zadania potrzebują",
    "examples": ["Wielokrotne czytanie tego samego pliku bez wniosków", "Wynik polecenia, który nic nie zmienił"]
  },
  "streszczenie": {
    "what": "Streszczenie niesie to, czego potrzebują otwarte zadania (ustalenia, liczby, nazwy, stan), a oryginał jest w pliku i da się go odczytać",
    "not_for": "Streszczenie, które pomija decyzję, wynik albo zobowiązanie potrzebne zadaniom",
    "examples": ["Seria poleceń z jednym wynikiem i krótkim wnioskiem", "Raport agenta, którego sedno mieści się w kilku zdaniach"]
  },
  "obszerniejsze": {
    "what": "Streszczenie jest za krótkie albo zbyt ogólne, ale obszerniejsze streszczenie wystarczy; zostanie napisane i pokazane do ponownej decyzji",
    "not_for": "Części, które wymagają dokładnego brzmienia oryginału",
    "examples": ["Wiele ustaleń i liczb, z których streszczenie zachowało tylko część"]
  },
  "doslownie": {
    "what": "Dalsza praca opiera się na dokładnym brzmieniu oryginału (polecenie, treść pliku, dokładny wynik), którego nie da się bezpiecznie streścić",
    "not_for": "Części, które zastąpi streszczenie bez straty dla zadań",
    "examples": ["Dokładna treść kodu albo konfiguracji, nad którą trwa praca", "Polecenie właściciela, które nie powtarza się gdzie indziej"]
  }
}
```

Translation of the options: `slad` (trace): "For further work on the tasks it is enough to know that this part existed and to have the path of the file with the original; the file can be read when needed." Not for: parts with findings, numbers, file names or decisions the tasks need. `streszczenie` (summary): "The summary carries what the open tasks need (findings, numbers, names, state), and the original is in the file and can be read." Not for: a summary that omits a decision, result or commitment the tasks need. `obszerniejsze` (longer summary): "The summary is too short or too general, but a longer summary will do; it will be written and shown for a new decision." Not for: parts that need the exact wording of the original. `doslownie` (verbatim): "Further work rests on the exact wording of the original (an order, file content, an exact result) that cannot be safely summarised." Not for: parts a summary can replace without loss. (Examples translate as: re-reading the same file without conclusions; the result of a command that changed nothing; a series of commands with one result and a short conclusion; an agent report whose gist fits in a few sentences; many findings and numbers of which the summary kept only some; the exact content of code or configuration being worked on; an order from the owner that is not repeated elsewhere.)

Second round (only for parts where Jev chose `obszerniejsze`): the same question, same options without `obszerniejsze`, with the longer summary in `streszczenie`.

Parts without a summary (an episode that is already a summary or trace from an earlier compaction, or one that Haiku failed on twice): same shape, with `"question": "Czym zastąpić w rozmowie fragment rozmowy z `{frag}.tekst`, żeby dalsza praca nad otwartymi zadaniami niczego nie straciła, a rozmowa zmieściła się w budżecie?"`, `compare` of `.tekst` and `.stan_zadan` only, `"focus": "Skutek dla dalszej pracy nad zadaniami (state `zadanie`) i budżet (state `budzet`); streszczenia tego fragmentu nie ma."`, and options `slad` and `doslownie` only.

### Default (one pass): contradiction question

Type `noul` (probability that the answer is "true"), one per part with a summary:

```json
{
  "question": "Czy streszczenie mówi coś sprzecznego z oryginałem albo podaje fakt, którego w nim nie ma?",
  "compare": ["`{frag}.streszczenie`", "`{frag}.tekst`", "`{frag}.sygnaly`"],
  "focus": "Pole sygnaly wymienia liczby, ścieżki i identyfikatory ze streszczenia, których nie ma w oryginale (nie_znalezione)."
}
```

Options: `true`: "Streszczenie zawiera fakt, liczbę, ścieżkę albo nazwę spoza oryginału albo przedstawia decyzję lub wynik inaczej niż oryginał" (not for: "Sumy i zliczenia wyliczone z oryginału oraz pominięcia (streszczenie nie musi powtarzać wszystkiego)"; examples: "Streszczenie podaje numer PR, którego oryginał nie zawiera", "Streszczenie mówi, że test przeszedł, a oryginał, że padł"). `false`: "Wszystko, co mówi streszczenie, wynika z oryginału" (not for: "Streszczenie z faktem, którego oryginał nie zawiera"; example: "Streszczenie podaje liczby i nazwy plików obecne w oryginale").

Translation: "Does the summary say anything that contradicts the original or state a fact that is not in it? Compare the summary, the original, the signals. Focus: the `sygnaly` field lists numbers, paths and identifiers of the summary that are not in the original (`nie_znalezione`)." `true`: the summary contains a fact, number, path or name from outside the original, or presents a decision or result differently from the original; not for sums and counts computed from the original, and for omissions (a summary need not repeat everything). `false`: everything the summary says follows from the original.

State sent with each part (`odcinki.<id>`): `numer`, `czesc`, `wiadomosc_otwierajaca` (the owner message that opened the episode), `w_ogonie`, `biezaca_tura`, `wiek`, `stan_zadan` (task id, subject, status, Jev's earlier assessment), `tokenow_doslownie_szac`, `tokenow_streszczenia_szac`, `streszczenie`, `sygnaly`, `tekst` (all after secret masking). Top level: `zadanie` (the last owner messages), `budzet`.

### Earlier variant: two questions (verdict, then acceptance)

Measured first (T6, see results). Kept in the block behind `deps.jedenPrzebieg === false`. Verdict question per episode, `choice` over four forms (`slad`, `krotkie`, `obszerne`, `doslownie`, described by `KROK_B_LEVELS` in the block):

> Co zrobić z odcinkiem rozmowy {ODCINEK} przy kompakcji, żeby dalsza praca nad zadaniem właściciela (state.zadanie) nie straciła tego, czego potrzebuje? Odcinek to wszystko między dwiema wiadomościami właściciela; jego pełny tekst jest w {ODCINEK}.tekst. Wiadomość właściciela otwierająca odcinek zostaje w rozmowie osobno. Pole {ODCINEK}.stan_zadan mówi, które zadania z listy odcinek dotyczy i czy są otwarte; pola {ODCINEK}.w_ogonie i {ODCINEK}.wiek mówią, jak jest świeży. Pole budzet pokazuje, ile tokenów ma cała rozmowa (tokeny_calosci), jaki jest limit po kompakcji (limit), ile host dokłada od siebie po kompakcji (dokleja_host_szac_tok, stala_czesc_hosta_tok) i ile trzeba zdjąć (trzeba_zdjac_tok); pole {ODCINEK}.tokenow_na_poziomach mówi, ile ten odcinek zajmuje na każdym poziomie. Wybierz formę: slad, krotkie, obszerne albo doslownie.

Translation: "What to do with conversation episode {EPISODE} at compaction so that further work on the owner's task (state.zadanie) does not lose what it needs? An episode is everything between two owner messages; its full text is in {EPISODE}.tekst. The owner message that opens the episode stays in the conversation separately. The field stan_zadan says which tasks of the list the episode concerns and whether they are open; w_ogonie and wiek say how fresh it is. The field budzet shows how many tokens the whole conversation has, the limit after compaction, how much the host adds after compaction and how much has to be removed; tokenow_na_poziomach says how much this episode takes at each level. Choose the form: trace, short, long or verbatim."

Acceptance question after Haiku wrote the summary, as shipped in the version measured last (`q3`, fidelity only), `choice` over `przyjac`, `zmyslony_fakt`, `odwrocona_decyzja`:

> Czy streszczenie (state.streszczenie) jest wierne odcinkowi (state.odcinek.tekst; odcinek otworzyło polecenie z state.odcinek.wiadomosc_otwierajaca)? Forma i zakres streszczenia były już wyborem, więc nie oceniaj, czy jest pełne ani czy wystarcza zamiast odcinka (pełny tekst zostaje w pliku). Odrzucenie oznacza, że w rozmowie ta część odcinka (albo cały odcinek, gdy nie dzielił się na części) zejdzie do śladu ze ścieżką do pliku, bez streszczenia. Oceniaj tylko wierność: wybierz `przyjac`, gdy to, co streszczenie mówi, wynika z odcinka (także liczby i sumy wyliczone z jego tekstu), albo jeden powód odrzucenia: zmyslony_fakt (fakt, liczba, ścieżka lub nazwa, których nie da się ustalić z odcinka) albo odwrocona_decyzja (decyzja lub ustalenie przedstawione odwrotnie albo błędnie).

Translation: "Is the summary faithful to the episode (the episode was opened by the command in wiadomosc_otwierajaca)? The form and scope of the summary were already a choice, so do not judge whether it is complete or whether it suffices in place of the episode (the full text stays in the file). Rejection means this part of the episode (or the whole episode, if it was not split) goes down to a trace with a file path, with no summary. Judge fidelity only: choose `przyjac` (accept) when what the summary says follows from the episode (including numbers and sums computed from its text), or one reason for rejection: `zmyslony_fakt` (a fact, number, path or name that cannot be established from the episode) or `odwrocona_decyzja` (a decision or finding presented the opposite way or wrongly)."

Two earlier wordings of this question were measured and replaced (`KROK_B_ACCEPT_QUESTION_P1`: "does the summary suffice in place of the episode"; `KROK_B_ACCEPT_QUESTION`, `q2`: loss of anything not easily recoverable from the file). They are in the block; the numbers are in the results below.

## How it was tested, and how to reproduce

Three kinds of measurement, all on copies of real Claude Code sessions (a long-running session on a work project and an agent session on a software task). Dates 11-12 November 2026.

1. **Compaction on session copies with the real Jev** (T6 and T9 runs): the compaction module was run on a copy, the conversation resumed with `claude -p --resume`, and the tokens of the first request read from `usage`. Success: context after compaction at or below 120k tokens, resume without errors, no placeholder results.
2. **Functional trial ("track F")**: an agent session (copy of 454,130 tokens before compaction) compacted by different methods, then given the same continuation task with no human input. Task 1: finish the last open step (three review threads on a pull request), task 2 after a second compaction (a rebase task). Measured: own working time to the first passing commit (excluding the queue of the shared heavy-test lock, `ciezkie`), turns, tool calls, tokens, cost, questions to a human. Variants: standard Claude Code compaction (S), the original plugin's compaction (W), the local module with step B (J, with Haiku) and the local module with step B off (J5off/Joff, no Haiku). Isolated sandbox, remote repositories replaced by local bare repos, no GitHub contact.
3. **Offline logic check**: the local test suite of the block (59 tests, in-memory host, fake Jev and Haiku, real masks) passed 59 of 59 with all `OMC_JEV*` variables and the API key unset, run on 12 November 2026. Those tests need the local module and are not part of this branch. The branch carries `replay.mjs` instead.

Reproduce the logic offline (no key, no network, no host):

```
node scripts/jev-negative-results/jev-compaction-haiku/replay.mjs --print-questions
```

It replays a synthetic 59-row conversation with 8 closed episodes: Haiku answers and Jev answers come from `sample/recorded.json`, and the output is deterministic (episode 3 and 7 stay verbatim, 5 becomes a trace, 1, 2, 4, 6, 8 become summaries; episode 0 shows the no-answer path). `--jev live` would ask the real endpoint (`TYPESAFE_API_KEY`, billed in Jev tokens); it was not run for this branch. Haiku summaries need the hooks host (`$.model.complete`) and cannot be run outside it.

## Results

Every number below has a denominator and a source in the measurement logs; where a result rests on one or two runs, it says so. The k1zl, T6 and compaction-time measurements below are separate from the 32-run trial.

### Context after compaction and Jev cost (session copy of a long-running main session, "k1zl", single runs)

| Variant | Tokens after compaction (`usage`) | Jev input tokens for one compaction |
|---|---|---|
| Step B on (Haiku) | 90,897 | about 1.69 million (91 requests; a calibrated estimate of the preparation, 0.93 million, plus the measured usage of the hook, 0.76 million) |
| Step B off (no Haiku) | 126,965 (target 120,000 not met) | 5.61 million (214 requests; usage of one compaction finished in two passes, the first interrupted) |

Ratio of Jev tokens: 5.61 / 1.69 = about 3.3. One run per variant. About 82% of the 5.61 million were the same state sent again in every block query: a task list (143 tasks, about 30-32 KB) and a conversation axis (about 12 KB), 44 KB in total. That is a defect of the surrounding query packing, unrelated to Haiku. How much of the 1.69 million is the same repeated state was not separated. A separate track that sent the task list in a form Jev chose once per compaction instead of in full in every query (without Haiku) measured 3.07 million Jev tokens and 127.7k tokens of context on the same copy; it was not deployed.

### Step B on session copies (T6, real Jev, two copies of main-session transcripts)

| Copy (episodes) | Question | Summaries accepted / rejected | Tokens after compaction | Hook time |
|---|---|---|---|---|
| k1 (65) | first wording (does it suffice instead of the episode) | 28 / 37 | 92,852 | 0.6-1.4 s |
| k1 | `q2` | 52 / 13 | 109,977 | 0.62 s |
| k1 | `q3` (fidelity only, the last wording) | 54 / 11 | 105,281 | 0.70 s |
| k2 (81) | first wording | 31 / 50 | 103,355 | 0.86 s |
| k2 | `q2` | 51 / 30 | 114,310 | 0.66 s |
| k2 | `q3` | 60 / 13 (+8 unanswered: HTTP 402 billing error of the endpoint) | 118,528 | not recorded separately |

Hook time over 11 runs: 0.57-1.4 s against the 8 s budget. The acceptance question was reworded twice after the first measurement showed Jev rejecting 57% (37 of 65) and 62% (50 of 81) of the summaries; the three wordings are in the block. The higher acceptance with later wordings is a result of changing the question, not evidence that the summaries improved.

### Time of the summarising step against the standard compaction

Measured per run (sources below). The hook itself (time the session is blocked) was 0.6 s; the summarising ran in the background.

| Compaction | Haiku summarising (wall clock, background) | Haiku calls / cost | Standard Claude Code compaction (blocking) |
|---|---|---|---|
| First, agent session copy of 454,130 tokens | 481.5 s (475.5 s summed over calls; the trial summary table rounds this to "about 491 s") | 26 calls, 0.119 USD | 112.7 s, 4.19 USD (measured in a separate track with another, larger model than the later standard compactions) |
| Second, two runs | 140.9 s and 120.9 s (167.3 s and 172.7 s summed) | 12 and 10 calls, 0.040 USD (first) | 59.0-88.1 s in six runs, 0.19-0.26 USD |

So the summarising was not faster than the standard compaction: roughly 4 times as long on the first compaction and 1.4-2.4 times on the second, with no blocking of the session. Jev's own part was small (221 ms median per request, 69 requests in the first preparation). One measurement of the first compaction and two of the second per variant.

### Functional trial (track F): all 32 runs with a result

One agent session (copy of 454,130 tokens before compaction), the same continuation task for every run, no human input after the start. 32 runs with a result: 18 in task 1 and 14 in task 2. Task 1: finish the last open step of a pull request (three review threads). Task 2, after a second compaction: a rebase task. Where a "run" repeats the same stage-1 run under a second name (J5-LP-1 is J-LP-1, S5-LP-1 is S-LP-1, used again for the second stage), it is counted once.

**Own work time** (the one measure used everywhere): seconds from the start of the agent to the first commit that passes the check (task 1, relaxed check and round rule) or to the first push that passes the check (task 2), minus all time spent in calls of the shared heavy-test lock (queue and tests together). It still carries load from up to ten sessions running at once. "From start" is the same moment without that subtraction. Spread between repeats of one cell was up to about 200 s, so differences under about 200 s are not decisive. Cells differ in compaction (S: standard `/compact`; J: our module with step B and Haiku; "off": our module with step B off, no Haiku; W: the original plugin) and in support (0: list and panel questions off, other Jev points on; L: list reminders; LP: list reminders and panel; P: panel only; "panel without the order": the panel ran without the order it is judged against, a rig defect of that stage, and no conclusion about the panel is drawn from those runs; "no OMC": the plugin was not loaded at all in that run).

**Task 1, 18 runs**

| Run | Compaction | Support | Own work (s) | From start (s) | Passed | Strict third thread |
|---|---|---|---|---|---|---|
| S-0-1 | S | 0 | 236.2 | 367.4 | yes | no |
| S-0-2 | S | 0 | 247.5 | 358.7 | yes | no |
| S-LP-1 | S | LP, panel without the order | 255.0 | 554.4 | yes | no |
| S-Ls-1 | S | list on, panel questions shadow, without the order | 264.6 | 370.7 | yes | no |
| S-P-1 | S | P, panel without the order | 818.6 | 958.7 | yes | no |
| S-gole-1 | S | no OMC at all | 254.8 | 488.6 | yes | no |
| J-0-1 | J with Haiku | 0 | 247.7 | 355.5 | yes | no |
| J-0-2 | J with Haiku | 0 | 293.7 | 425.6 | yes | no |
| J-LP-1 | J with Haiku | LP, panel without the order | 320.4 | 616.5 | yes | no |
| J-LP-2 | J with Haiku | LP, panel without the order | 435.9 | 794.5 | yes | no |
| J4-LP-1 | J with Haiku | LP, panel with the order | 262.0 | 368.6 | yes | no |
| Joff-0-1 | off | no OMC, 0 | 267.1 | 702.6 | yes | no |
| J5off-0-1 | off | no OMC, 0 | 422.6 (approximate) | about 425 | yes, final check only (no commit; time is the last edit of the module) | yes |
| J5off-LP-1 | off | no OMC (LP planned, nothing loaded) | 275.7 (approximate) | about 403 | yes, final check only (no commit; time is the last edit) | yes |
| J5off-LP-2 | off | no OMC (LP planned, nothing loaded) | 268.4 | 483.7 | yes | no |
| J5off-LP-3 | off | LP, plugin loaded | 342.1 | 564.7 | yes | yes |
| W-0-1 | W | 0 | 494.8 | 525.5 | yes | yes |
| W-0-2 | W | 0 | 420.3 | 734.6 | yes | yes |

By compaction, all runs of the compaction, whatever the support: S 236-819 s (6 runs; 236-265 s in five); J with Haiku 248-436 s (5); off 267-423 s (5; four without the OMC plugin, so they are not the cell they were planned as); W 420-495 s (2).

**Task 2, 14 runs** (second compaction by the method in the column)

| Run | Second compaction | Support | Own work (s) | From start (s) | Passed |
|---|---|---|---|---|---|
| S-0-1-e2 | standard | 0 | 143.4 | 762.4 | yes |
| S5-LP-1-e2 | standard | LP, panel with the order | 121.6 | 893.9 | yes |
| S-Ls-1-e2 | standard | list on, panel questions shadow, without the order | 176.2 | 699.7 | yes |
| S-gole-1-e2 | standard | no OMC at all | 139.8 | 832.2 | yes |
| S-P-1-e2 | standard | P, panel without the order | 517.8 | 761.9 | yes |
| S-LP-1-e2 | standard | LP, panel without the order | 804.9 | 1167.1 | yes |
| J-0-1-e2 | J with Haiku | 0 | 189.1 | 820.7 | yes |
| J5-LP-1-e2 | J with Haiku (answers from the stage-1 memory, 1 request) | LP, panel with the order | 496.6 | 896.5 | yes |
| J-LP-1-e2 | J with Haiku | LP, panel without the order | not passed (limit of 2 x 1200 s, no push) | - | **no** |
| J5off-LP-1-e2 | off (module result accepted by Jev) | stage 1 without OMC | 302.3 | 644.6 | yes |
| J5off-0-1-e2 | off (module result accepted by Jev) | stage 1 without OMC | not passed (not finished at the time of writing, no push) | - | **no** |
| J5off-LP-2-e2 | standard (see below) | stage 1 without OMC | 106.7 | 300.6 | yes |
| Joff-0-1-e2 | standard (see below) | stage 1 without OMC | 157.3 | 485.2 | yes |
| W-0-1-e2 | W | 0 | 780.8 | 953.2 | yes |

Two of the runs with the module fell back to the standard compaction: the test rig called the second compaction with the trigger `auto` and a threshold of 487,000 tokens, so Jev saw a wrong scale (487,000 "before" instead of about 150-210k) and the module's result was rejected. This is a rig artefact, not a property of step B off. The 302 s run is the only usable "off" run in task 2, and its stage 1 had no OMC.

12 of 14 runs passed task 2; the two that did not are J-LP-1-e2 (J with Haiku) and J5off-0-1-e2 (off).

Context left after the first compaction (agent session copy): standard 56,601 tokens, step B on 71,033, original plugin 90,345, step B off 101,617-103,607. After the second: standard 35,769-50,985, step B on 42,935-73,688.

**Quality.** No run asked a human (0 of 32). In task 1 all 18 runs reached a passing state; in task 2, 12 of 14 passed. The strict check of task 1 (the three target tests plus the other 147 tests of the module's test file, 150 in all) was passed by W in 2 of 2, by "off" in 3 of 5, and by S and J with Haiku in 0 of 11 (task 1 only). For S and J with Haiku against W the difference is one P2 review thread that the round rule of the session allowed to defer; S and J deferred it by that rule, W did it against the rule. The "off" runs missed other things (Joff-0-1 and J5off-LP-2 reached 2 of 3 and 1 of 3 target threads in the strict check, and Joff-0-1 passed the relaxed one). The trial is small (1-2 runs per cell, no significance test), so it shows no quality difference between the variants and cannot exclude one.

What was not measured: Jev tokens in the agent runs (the log did not record usage; estimated 1-15k tokens per run), the share of repeated tool calls that were unnecessary (counted mechanically only), the quality of single summaries beyond Jev's accept/reject, and a series of 5-6 consecutive compactions of the main session (decided against).

## Why it was rejected

- The only gain is Jev tokens (about 3.3 times fewer on one compaction of one session copy) and a smaller context after compaction (91k against 127k on the same copy). It brought no gain in own work time to the goal: task 1, all runs of the compaction, step B on 248-436 s (5 runs), off 267-423 s (5 runs, four without the OMC plugin), standard 236-819 s (6 runs, 236-265 s in five); task 2 in the table above, where the cells differ in support and the one usable "off" run took 302 s against 189 s and 497 s with Haiku and 122-176 s for four standard runs (cells 0, no OMC, LP with the order, list with a shadow panel). No quality gain was seen.
- The gain in Jev tokens is mostly a gain against a variant that sent the same 44 KB of task list and conversation axis in every block query. Shortening that state, without Haiku, brought the same copy from 5.61 to 3.07 million Jev tokens (one run); that is not the full 1.69 million, but it removes most of the gap at no cost in extra moving parts, and Jev tokens are the only thing step B gained.
- Cost of keeping it: an extra background step per turn with its own failure modes (Haiku unavailable, per-part decisions that go stale when the task list changes), about 1,885 lines of block plus seven call points (eight marked fragments) in the compaction module, extra files per episode, and more Jev requests.
- The measured acceptance depended on how the acceptance question was worded (57-62% rejected at first, 17-18% with the last wording), which is a sign that the question, not the summaries, drove the outcome.

What is used instead: the `compaction` point as merged in upstream (Jev scores tool results; the upstream module never sent a task list, so the repeated-state defect above existed only in the local module), and the standard host compaction as the fallback.

## Related PRs and issues in this repository

- #4940 (merged): the opt-in `compaction` point, which this step extended.
- #4978, #4980, #5001, #5029 (merged): call/result pairs, growth gate, thinking rows and tail handles of the compaction module, whose rules the step had to respect.
- #4992, #5012 (merged): secret and private paths kept away from the compaction request; the step's masking reuses that rule.
- #4939, #4994 (merged): shared breaker and request limit, used by the step's Jev requests.
- #5008 (open, draft): elastic compaction target and a compaction moment chosen by Jev; independent of step B.
- #5013 (open, draft): optional archive of cut results, a neighbour of the per-episode files of step B.
- #4989 (open): messages delivered during a tool turn, relevant to the owner-message rows step B keeps.
