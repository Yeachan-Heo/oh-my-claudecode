# Jev compaction: experiments that did not pay off

**Negative result. Tried, measured, rejected. Not for merge.** Where an item was not measured, the text says "not measured".

Jev is the hosted decision service (Typesafe AI) that OMC's judgment points call from hooks; a call is a state plus a set of questions, and the answer is a choice or a score. This document collects the experiments around the `compaction` point (Jev scores tool results and decides what a compaction keeps; merged in #4940 and refined in the follow-ups listed at the end) that were tried in a local build and then dropped, or never got far enough to be judged. It is written so that nobody starts from zero on them. The `compaction` point itself is merged, in use and kept; nothing here is a result about it.

The experiments come in two groups:

- **Measured and rejected** (section 1): four items with numbers.
- **Not tested, described so nobody starts from zero** (section 2): eight items and one pointer (2.4). For each, what exists and what would have to be measured to bring it back.

Topics that already have their own pull request are not repeated (all closed as negative results): the compaction moment (#5008), the archive of cut results and pasted material (#5013), Haiku summaries (#5040), displacing superseded tool calls (#5041), the Jev panel (#5034) and the task list reminders (#5036).

## How to read the numbers

- The work was done on **copies of real Claude Code sessions** from a work project, never on the live session: copy **K1** is a main-loop session of 428,517 tokens of conversation with a task list of 143 tasks; copy **K3** is an agent session of 454,000 tokens; section 2.1 and 2.7 use an earlier copy of a main-loop session, **K0**, of 388,124 tokens. The text of all of them stays private. "Tokens of Jev" are the tokens the provider's `usage` reports for the requests (input unless said otherwise).
- Most of the work happened on one day (11 November 2026) in a local build of the compaction module of about 6,500 lines, which has features the upstream module (`hooks/jev-compaction.mjs`, about 1,900 lines) does not have. Where a function is named below it is a function of that local module; none of them is in upstream. In particular the upstream module cuts to a **share of the characters** (`OMC_JEV_COMPACT_TARGET`, default 0.5, `hooks/jev-compaction.mjs:96-97, 457`; minimum cut 0.3 counted on characters), while a target in **tokens taken from the provider's `usage`** is a feature of the local build only. The upstream module never sent a task list to Jev, so the "state repeated in every request" defect of section 1.3 existed only in the local build.
- **One or two runs per cell is the rule, not the exception.** Where a result rests on a single run, the text says so. A run of the functional trial (an agent given the same task after each compaction) varied by up to 200 s between repetitions, so differences of that size are not evidence.
- Live counts come from the compaction module's own log (`compact.jsonl`), read as a snapshot at 02:30 UTC on 12 November 2026 (03:30 CET; the last record is from 02:24 UTC; 160 lines, 75 `compact` records: 29 of the current module revision, 29 without a revision label, 12 and 5 of two older revisions; the 29 of the current revision of which 27 were done by Jev and 2 handed to the host because the text alone was above the host's threshold). The log keeps growing, so a later count gives larger denominators. Pairs "before/after" use the first request after a compaction (`measured: first_request`), which can include growth from the new turn.
- Numbers marked **(recomputed)** can be reproduced with the scripts of this branch, from its sample files, or from the module's log named above. Every other number in sections 1.3, 1.4, 2.1 to 2.3 and 2.6 to 2.9, and the hand review and the laptop replay details in section 1.1, is **(quoted)** from the run records and hand-overs of experiments on private session copies and cannot be recomputed from this branch. "Quoted" numbers were checked against their source document, not rerun.

---

## 1. Measured and rejected

### 1.1 `output-trim`: trimming noisy tool results

**What it was.** After a Bash, PowerShell, Monitor or MCP tool call returns a large result, a hook rewrites the result before the model sees it: terminal escape codes are removed, progress bars written with carriage returns are folded to their final state, runs of identical lines become one line with a counter, long runs of "success" lines (`PASS ...`, `Compiling ...`) keep only the first and the last, and very long single lines keep head and tail. The original goes to a file and a footer names it. Example: a test run that prints 300 `PASS test N` lines and one `FAIL test 150 error: ...` becomes the first `PASS` line, a marker, the last `PASS` line and the `FAIL` line, plus a footer `[odszumiono: ... pełny wynik: <path>]` (the markers are in Polish, as in the sessions the tool was written for).

**Hypothesis.** A quarter of the traffic in a long session is tool output nobody reads; removing the noise deterministically, without asking Jev, saves tokens at no risk. Decision threshold fixed before measuring: the trimmer must remove at least **10 %** of the characters of the covered tools' results. A Jev-driven variant (Jev decides per result) was to be considered only if the deterministic one showed a large pool it could not touch.

**How it was measured.** A clean-room reference implementation of the five steps (this PR: `scripts/jev-negative-results/jev-compaction-experiments/output-trim/jev-trim.mjs`, 66 unit tests) was replayed over seven days of transcripts of a laptop (2 to 9 November 2026, 872 files of which 781 are subagent transcripts, 2,910 MB (quoted); one pass; read-only). The 0.37 % below was computed by the original replay script; the trimmer code in this branch is the same except for the header comment and the list of private directories, which is a placeholder (`private|confidential`) instead of three real work folders. With the original list 569 Bash results were excluded as private; with this branch's list they would not be, so scenario A of this branch on that laptop corpus would come out somewhat higher (scenario D, 1.29 %, has no such exclusion and is the upper bound). Unit: characters of the `tool_result` text, i.e. what the model sees. Policy: results from 4,000 characters, not errors (the post-tool hook is not called for failed tools), not already stored by the host (the host replaces results over 30,000 characters with a preview), not "content" (a result of `cat`, `head`, `sed`, `grep`, `ls`, `find`, `git diff`, or a diff, or valid JSON), not from private directories; trimming only when at least 300 characters are saved net of the footer. Scenario A is that policy; scenario D is the ceiling without the content and private-directory exclusions. Then 40 of the 93 applications of scenario A, drawn at random, were reviewed by hand by the author of the trimmer, together with a check of invariants on 68 saved samples. A second reviewer checked the code and the numbers and part of the samples; nobody repeated the review of the 40 (quoted).

**Results (laptop, 7 days; recomputed from the replay output, except the rows marked quoted).**

| | Value | Denominator |
|---|---|---|
| Results of covered tools | 26,566 results, 70,730,542 characters | all Bash, PowerShell, Monitor, MCP results |
| Scenario A saved | **262,089 characters = 0.37 %** | 70,730,542 |
| Applications of the trimmer in A | 93 | 26,566 results (0.35 %) |
| Scenario D (ceiling) saved | 909,014 characters = 1.29 % | 70,730,542 |
| Terminal steps only (ANSI codes and `\r`) | 31,829 characters = 0.045 % | 70,730,542 |
| ... of which lossless (two `git worktree add` progress bars) (quoted) | 11,824 characters = 0.017 % | 70,730,542 |

Long-line shortening gave 207,975 of the 276,027 raw characters (75 %) before the policy and footers (quoted), and it is also the step that does the most damage.

Hand review of 40 random applications (quoted, the sample file contained result text and was deleted): **27 removed content the model had asked for or printed itself** (23 shortened long lines such as paragraphs of notes written on one line, JSON records, API data, a `git push` error line; a list of path checks `OK <path> | <rule>` folded as a success series; output of the author's own scripts; two texts with `\r` inside a line folded to the last fragment, in one of them a whole JSON), 7 could not be excluded (cut inside minified code; binary dumps with `\r`), 6 lost nothing (one progress bar, four repeated lines with a counter, one long `PATH` line).

Related measurements of the same replay (quoted): of 158 results the host itself had stored to a file (the model sees a preview), 75 (47 %) were opened later in the same conversation, so a trimmed result with a pointer to a file is often needed in full. Reads of files over 30,000 characters were 383 of 5,928 Read results (6.5 %) and 14.1 of 46.8 million Read characters (30 %); 24 of them (upper bound) were followed by an Edit of the same file. Those are measurements only; nothing was changed.

**Reproduced for this PR on another machine (recomputed).** `count-trim.mjs --transcripts` over 302 transcript files of three project folders of a server (5 to 12 November 2026; folders with private material left out): 21,648 results, 46,524,889 characters; in scope 3,397; 2,501 of them content; scenario A saved 511,482 characters = **1.10 %**; ceiling D 806,025 = 1.73 %; 114 results trimmed, of which 7 lost a short line that contains an error word. The corpus differs from the laptop's (more long scripted analysis output), the conclusion does not: A is about a ninth of the threshold, the ceiling about a sixth.

**Why it was rejected.** The policy removes 0.4 to 1.1 % of the characters of the covered tools (the ceiling without exclusions 1.3 to 1.7 %) against a threshold of ten, and even that is an upper bound, because in 27 of 40 hand-reviewed applications the trimming removed text the model had asked for or printed itself. The two lossless cases are progress bars. Nothing was deployed.

**What about asking Jev.** Not tried. The author's estimate (quoted, from the experiment's report): 5,429 in-scope results in 7 days, about 775 a day, with 8 to 12 Jev requests each at a median of 3.9 s per result measured on an older trimmer, would mean 6,000 to 9,000 requests and about 50 minutes of added waiting a day. That earlier Jev-based trimmer, a third-party plugin, cut 0 of 5,790 results because of its own 10,000-token threshold, so it never tested this pool; the pool itself (Bash results from 4,000 characters that are not content or private) is at least 15.1 million characters, 21 % of the Bash characters, of which the deterministic steps remove at most 1.6 % (quoted).

**What to measure to bring it back.** Hand-label a sample of those non-content Bash results of 4,000 characters and up with "did the model use any of this?" (no change to behaviour); only a large "not used" share justifies a Jev-driven variant. Then the 6 to 9 thousand requests a day would have to be priced.

### 1.2 N14d: merging identical tool traces

**What it was.** When the compaction replaces tool calls with one-line traces (`[ślad po kompakcji] Edit(<input>) ... usunięte`, with a path of the file holding the full call and result), neighbouring traces of the same tool with the same complete input inside one API message are merged into one line with a counter, e.g. `Bash(git status) ×3`. In code: `traceEntryOf` (a key: hash of the tool and the full input JSON, plus the API message), `mergeTraceEntries` (merges runs of two or more neighbours with the same tool, key and message and with no non-blank text between them) and `mergedIntoOf`; the compaction record gets `merged_traces` and `merged_items`. Different calls on one target (two reads of one file at other offsets) never merge. The second half of N14d (shortening notices of background tasks) is not covered here and was not evaluated.

**Hypothesis.** Agents often fire the same call several times in parallel (re-reading the same file, polling the same status), so a compaction leaves many identical trace lines; merging them saves rows and tokens.

**How it was measured.** Two counts, both reproducible with `count-merge-hits.mjs` of this PR:

1. Hits recorded by the module in its own log. Snapshot of the log (see above): 45 compaction records carry `merged_traces`; **0 of 45** (recomputed) have a value above zero, `merged_items` is 0 in all 45. By module revision: 27 of the current one, 12 of the previous one, 5 of an older one, 1 unlabelled. (When first analysed, an hour earlier, the live count was 25 compactions, all 0 (quoted).) On the offline copies of the two sessions the count was 0 too (quoted).
2. The opportunity, independent of the compaction: runs of two or more neighbouring identical calls (same tool, same canonical input JSON, same API message, no non-blank text between) in the transcripts of one server (all transcripts it keeps, about a week, three project folders, 302 files): **0 runs among 25,746 tool calls** in 34,146 API messages (2,142 of those messages had two or more calls) (recomputed; a rerun a few minutes later counted 25,837 calls with the same result, the transcripts grow). A looser check in a second implementation (any identical pair inside a message, rows deduplicated by tool-use id) also gave 0. Before deduplication by tool-use id, 21 messages looked like having duplicates; they disappeared once rows were deduplicated by id.

**Why it was rejected.** Identical neighbouring calls in one message did not occur in this workload (one server, about a week of transcripts, three project folders), so the feature merges nothing. It stays in the local build, active, doing nothing; the cost is code and a rule (never merge across messages or on a shortened `target`) that a reviewer had to get right. The merge rule was refined once after review because it first matched on a shortened target, which could merge different calls.

**What to measure to bring it back.** The same two counters on a workload that is different in kind (for example scripted agents polling), or a trace format change that makes near-identical calls (same tool, same target, different offset) mergeable, with the count of such neighbours first.

### 1.3 The full task list and conversation axis in every block query

**What it was.** To tell Jev what the work is heading for, the local compaction module put the whole task list (143 tasks, 30 to 32 thousand characters) and the conversation axis (about 12 thousand characters) into the `state` of every request that asks Jev to score blocks of the conversation or tool results. Each request carries many blocks at once, so each carries the same state again. The change came in as a "direction for the questions" step (the task list decides what is needed to finish the open tasks); an earlier version had passed only the last owner messages and a task list cut to 80 characters per task.

**Hypothesis.** With the whole list in view Jev can tell blocks that serve an open task from those that do not, and scoring becomes more accurate.

**How it was measured.** Copy K1, the compaction of a main-loop session, with the request body capped at 56,000 bytes (the API refuses bodies of about 58 KB, see 2.2). Counted per compaction:

| Variant | Requests to Jev | Jev tokens | How obtained |
|---|---|---|---|
| Module before the list was added | 24 | 0.36 million | dry measurement (no API) (quoted) |
| With the list and axis in every block request | 117 | 2.15 million | dry estimate of the hook's block queries (quoted) |
| Same, without the Haiku step | 214 | **5,610,059** | provider `usage`, sum of two real passes that together produced the 214 answers (the first stopped by a spend guard after 168 requests) (quoted) |
| Same, with the Haiku step (#5040) | about 91 | about 1.69 million | one real pass plus preparation (quoted) |
| Packing change (body cap 56,000 B counted with the state) | 29 in the hook (was 117) | 0.63 million for the block queries (was 2.15) | dry estimate (quoted) |

**The repeated share.** The estimate made at the time was "about 82 % of the traffic is the same state repeated" (quoted): 213 requests times 44 KB (task list 32,076 plus axis 12,349 characters) against 11.4 MB. Recomputed for this PR from the request log of the same run (214 requests, 11,450,049 body bytes, all HTTP 200, per-request field sizes recorded): the task list field was sent as 28,819 bytes and the axis as 9,948 bytes in every request that carries them (213 of 214), which makes **8,257,371 bytes = 72.1 %** of the traffic; adding the three smaller fields that are identical in every request that carries them (scoring rubric, current task, task index; some requests do not carry all three) gives 8,710,861 bytes = **76.1 %** (both recomputed). The 82 % was computed from the prepared fields (32,076 and 12,349 characters), not from the bytes sent. The sent task list field (28,819 bytes) is shorter than the prepared one and the reason for the difference (for instance a cut to fit the body limit) was not established; the later track of 2.6 reports a third figure for the same field (30,638 bytes, another pass), also not reconciled. The practical statement is the same: roughly three quarters of what was sent to Jev in that run was the same state again, leaving about 10 to 12 KB (about 5,000 tokens) of content to score per request. Reproduce with `count-repeated-state.mjs --request-log sample/request-log-sizes.jsonl --fixed tasks,axis` (field sizes only, no content).

**Quality.** Not measured separately. A comparison of the verdicts with the full list against a shortened list is in 2.6: the verdicts moved in about a quarter of the blocks, and nothing shows which side was right.

**Why it was rejected.** The cost multiplied (0.36 to 2.15 and, without Haiku, to 5.61 million Jev tokens for one compaction of one session copy; about 38 compactions per day on the session the copy came from, an estimate in the project notes (quoted)) for a benefit nobody measured, and the cause was a plain design fault: a fixed block of state repeated in every request. The cost was noticed late: the change had been judged by the time of the hook (5.7 s against a limit of 8 s, quoted) and not by tokens. The reason to withdraw is the repeated state with no measured benefit, not the price alone. The fixes that were built (packing up to the body cap, one request per episode for the Haiku step, a task-level choice, section 2.6) all reduce the repetition; none has been judged on quality.

**What to measure to bring it back.** The comparison that was not made: the same blocks and the same packing with the full list and with a one-line-per-task list, answered by Jev, and a check of which side agrees better with what the model later needed (about 3 million tokens of Jev). Until then a short, fixed state per request is the default to assume.

### 1.4 The 120,000-token target without the Haiku step, on a main-loop session

**What it was.** The rule agreed for the local build (upstream cuts to a share of characters instead): after a compaction the conversation should be at most 120,000 tokens (counted from the provider's `usage` of the first request after the compaction), so that the next compaction is far away. The pieces tried to reach it: scoring of tool results, scoring of blocks, a second round in which Jev lowers items in his own order and the code stops at the limit, and (optionally) Haiku summaries of old episodes (#5040).

**What was measured (quoted).** Copy K1, with real Jev, one completed pass per variant:

| Variant | Tokens after the compaction | Target 120,000 |
|---|---|---|
| Haiku step on | 90,897 | met |
| Haiku step off | **126,965** (module forecast 138,146) | **not met** |
| Haiku step off, with the task-level choice of 2.6 | 127,749 | not met |

Without the step the cascade ran out of items to lower (reason "no items", 18,146 forecast tokens short), so the remaining 6,965 tokens above the target had no item left to come from. On the agent copy K3 the same variant ended at about 102,000 to 104,000 tokens (against 71,000 with the step), which is below the target; the comparison on K3 is a single copy and one or two passes (quoted).

**n = 1.** The main-session figure is one completed pass on one copy; the 5 to 6 consecutive compactions that would show whether the floor keeps rising were not run. There is no evidence about how the number behaves on other sessions.

**In the local build in daily use** (recomputed from the snapshot of the module's log, current revision): 19 Jev compactions with a first-request measurement, median 174,604 tokens after (10 of 19 at 175,000 or less) and a median cut of 28.0 %. The target in that build is not 120,000: `target_tokens` is 170,000 in all 29 records of the current revision (older revisions logged 221,000, 260,000 and other values). The 120,000 target was tested on copies and not adopted. The merged upstream point has no token target at all (it cuts to a share of characters, see above).

**Why it was rejected as a target.** Without the Haiku step the main-loop copy does not reach it, and the step that would reach it is the subject of #5040 (see there for its cost in time and complexity). The target stayed a signal in the questions to Jev rather than a gate.

---

## 2. Not tested, described so nobody starts from zero

None of the following was brought to a judgement. For each: what it is, what exists, what little was measured and what would have to be measured.

### 2.1 Step A: dropping old host attachments at compaction (N28d)

**What it is.** A compaction hook returns rows of the conversation; for rows it returns unchanged the host keeps a "handle" and re-attaches everything that stood behind the row: lists of skills, agents and deferred tools, MCP instructions, instruction files, environment and date, hook contexts, task reminders. In the copy K0 these attachments weigh about 80,000 tokens (21 % of 388,124) after a Jev compaction, most of them stale duplicates, because the host appends the current version of each list again when it is missing from the history. Step A would return those rows **without handles** (rebuilt from text), so the host does not carry the old attachments, and let the host re-attach fresh lists.

**What was measured (quoted from the experiment's report)** (one copy of a main-loop session, here called K0, 388,124 tokens uncompacted; a variant transcript written the way the host writes it, resumed with `claude -p --resume` on a small model, one turn, the `usage` of the first answer; Claude Code 2.1.322; the module itself was not changed):

| Variant | Tokens |
|---|---|
| Copy without compaction | 388,124 |
| Jev compaction as it is (live module at the time) | 244,707 |
| Attachments dropped, newest of each type kept | 217,026 |
| **All carried attachments dropped** | **210,342** (host re-attaches fresh lists, about 27,500 tokens) |
| Jev compaction with shorter traces only (2.7) | 197,610 |
| Attachments dropped **and** shorter traces | **163,245** |
| Newest attachment of each type **and** shorter traces | 169,929 |

So the often-quoted `244,707 to 163,245` is two changes together: dropping the attachments is worth 34,365 tokens, the shorter traces 47,097. All variants resumed cleanly (no unresolved tool results, no API errors). In the host's "safe mode" (nothing re-attached) the difference is 61,891, the 27,500 difference to normal mode being the lists the host appends itself.

**Known risks found, not solved.** A row followed by local-command records loses them: with all attachments dropped four blocks disappeared including the `/goal` command, and after resume the goal stopped being enforced (the Stop hook did not continue). Rows with an image or a document in the owner's message would lose them. The host's own `postTokens` of a compaction is an estimate (148,006 recorded against 331,664 actual in one case).

**Not checked.** Whether the host re-attaches the lists in the next turn of the same live process after a compaction (it follows from the code that does it, but it was only tested on resume); subagent sessions; a Windows host.

**What to measure to bring it back.** A compaction in a live test session in a terminal multiplexer, then the `api-request` record of the next request: lists present once, instructions complete, `/goal` still active.

### 2.2 Packing whole results into Jev's window of 40,000 bytes

**What it is.** Early versions of the tool-result question sent Jev only a cut of every result (the call up to 300 characters, the result up to 1,000 plus 500 characters). The "full input" rule (J1a/F3) sends the whole call and the whole result; whatever does not fit the request is **split over further requests with the same question**, never cut. Requests pack as many items as fit a window of 40,000 bytes of body (`OMC_JEV_WINDOW_CHARS`; a later packing step counted the cap of 56,000 bytes over the whole body, state included).

**What was measured (quoted).** The API refuses request bodies of about 58 KB: a probe on 11 November 2026 gave HTTP 400 for 66.7 KB and 109.9 KB and accepted 56.4 KB; about 30,000 tokens per request was the second limit found (the provider's documentation names 32,000 tokens per question and 64,000 per request). 40,000 bytes sits under both with room to spare. The cost estimate for full input was **about +2,100 tokens per candidate** (from about 920 to 3,060), about +313,000 tokens of Jev per compaction at 149 candidates (an estimate, not a measurement). A dry measurement of the pipeline on K1 when the questions were changed to name their fragment (a different change, bundled in the same candidate) was +11 % Jev tokens (638,638 to 710,841). The +11 % belongs to that question format change, not to packing alone.

**Not measured.** Whether Jev's scores on whole results are better than on cut results: there was no comparison with human labels or with what the model needed later, and tool results are only 8 to 10 % of the context of the sessions this was tuned on, so the possible gain is small there.

**What to measure to bring it back.** Score the same 150 results twice, cut and whole, and compare both with whether the conversation later re-read the file or re-ran the command.

### 2.3 Block verdicts after every batch of tool calls

**What it is.** Instead of asking Jev about blocks of the conversation inside the compaction hook (time-limited), verdicts on a 0 to 3 scale (from "not needed, a trace with a file is enough" to "needed verbatim") are produced **in the background after each tool batch or turn end** and written to one small file per block (`werdykty/<session>/<kind>/<key>.json`: level, Jev's raw score, turn number, whether the input was complete, who decided). The compaction then only reads the stored verdicts. Blocks without a verdict at compaction time (`ensureVerdicts`, `backgroundVerdicts`, `fillBeforeCompaction`) are queued; if Jev does not answer, a fallback marks the item (`kto: "k3"`).

**What was measured (quoted from the plan's probe report).** Only a probe of the question format, on 19 blocks from three conversation states, 9 requests, 152,505 input tokens (about 2.4 cents, recomputed from 152,505 tokens at 0.157 USD per million): the spread of scores inside one request grew from 0.07 to 0.16 (question without the block's name) to 0.80 to 1.41 (name in the question text, the provider's documentation says question ids are not sent to the model) and 1.23 to 1.35 (documentation pattern layout); the same text twice, once tied to an open task and once not, differed by +0.18 to +0.34 in the last layout. The mean scores were 0.9 to 1.4 on the 0 to 3 scale with confidence 0.26 to 0.40, that is: **differentiation exists but is weak**. Three narrow yes/no questions per block did not separate better: 10 to 13 of 24 answers were in the "uncertain" band 0.3 to 0.7.

**Cost** is the sum of the request counts of section 1.3 plus a continuous stream of background requests during the session.

**Not measured.** The agreement of the verdicts with anything: no human labels, no check against what the model later needed. The module reads only the score, not the confidence or probabilities.

**Questions sent** (older variant, Polish verbatim, then English):

> Czy blok z state.bloki pod tą samą nazwą co to pytanie jest potrzebny DOSŁOWNIE do dokończenia otwartych zadań z listy (state.zadania, pole otwarte: true; to kierunek pracy), a gdy listy nie ma, do dalszej pracy nad zadaniem z ostatnich wiadomości właściciela (state.zadanie)? Oceń skutek dla dalszej pracy, gdyby z bloku zostały tylko ślad i plik. Zasady oceny: state.opis_oceny_blokow.

"Is the block in `state.bloki` under the same name as this question needed VERBATIM to finish the open tasks on the list (`state.zadania`, field `otwarte: true`; that is the direction of work), and when there is no list, for further work on the task from the owner's last messages (`state.zadanie`)? Judge the effect on further work if only a trace and a file were left of the block. Rules of judgement: `state.opis_oceny_blokow`." The phrase "under the same name as this question" is the defect that the probe above fixed: the model is not told the question's name, so every block got almost the same score.

Levels (type `score`, four levels): "Zbędny: dotyczy zadania zamkniętego albo żadnego; ślad z plikiem wystarczy." / "Raczej zbędny: dotyczy zadania zamkniętego, porzuconego albo żadnego; wystarczy początek, koniec i plik." / "Może się przydać: praca nad otwartym zadaniem może wrócić do jego szczegółów." / "Potrzebny dosłownie: bez jego dosłownego tekstu nie da się dokończyć otwartego zadania." (Not needed: about a closed task or none; a trace with a file is enough. / Rather not needed: closed, abandoned or no task; start, end and file suffice. / May be useful: work on an open task may return to its details. / Needed verbatim: the open task cannot be finished without its exact text.)

**What to measure to bring it back.** The agreement of the verdicts with a hand labelling of 200 blocks, and the functional trial after a compaction built on verdicts alone.

### 2.4 The moment question at every turn end (J2)

This is the same question family as #5008 (a moment question to Jev at `turn.complete`); see there for the question, the design and the 20 shadow answers, all "no". The plan variant J2 would have put it on every turn end together with the other turn-end questions; only its cost was recorded: 454 ms at the 95th percentile, 770 ms at most, and 150 of 150 compaction requests answered (quoted from the plan's snapshot of 11 November, about 15:43). Whether its answers are good was not measured.

### 2.5 The depth of the compaction chosen by Jev (J3)

**What it is.** Instead of a fixed cascade (passes A to D, each cutting more) with a numeric target, one request asks Jev how deep this compaction should go, with the options the code can compute (tokens after, percent cut for each depth), and a second question whether the result of the chosen depth is acceptable (otherwise the host compacts).

**What was measured.** The question ran as one request per compaction in the passes on K1 (section 1.4), and the compaction record has the pass reached. In the local build's log (27 Jev compactions of the current revision, recomputed) the passes reached were A 10, D 8, B 7 and "forced" 2. The comparison between Jev's depth choice and the fixed cascade, and whether the model did worse after deeper cuts, **was not made**. For context: the older fixed target (85 % of the smaller of half the window and three quarters of the threshold) was reached in only 1 of 15 measured compactions (quoted), which was the reason to look at a choice at all.

**Questions sent** (Polish verbatim, English after):

> Jak głęboko ma zejść ta kompakcja rozmowy? Pole kompakcja podaje, ile tokenów rozmowa ma przed (tokeny_przed), ile trzeba zdjąć do limitu (ile_zdjac_tok, limit_po_kompakcji) i co da każda głębokość (opcje: po_tok, ciecie_proc). Wybierz głębokość, po której rozmowa zachowa to, co jest potrzebne do dalszej pracy.

"How deep should this compaction of the conversation go? The `kompakcja` field gives how many tokens the conversation has before, how much must come off to the limit and what each depth gives (options: tokens after, percent cut). Choose the depth after which the conversation keeps what further work needs." Options (`choice`): `tylko_zbedne`: "only what you judged unneeded (results scored below half the scale); the rest stays", `do_celu`: "to the module's target: from the least needed until the result is not above the target", `glebiej`: "everything that can come off, except what the code must keep".

> Czy wynik wybranej głębokości (opcje w polu kompakcja) jest do przyjęcia? Tak: kompakcję robi ta wtyczka. Nie: kompakcję robi host (streszczenie Claude Code). Pole tekst_ponad_prog mówi, że po zdjęciu wszystkiego, co usuwalne, rozmowa i tak jest ponad progiem hosta i kompakcja odpali się znowu za kilka tur.

"Is the result of the chosen depth acceptable? Yes: this plugin does the compaction. No: the host does it (the Claude Code summary). The field `tekst_ponad_prog` says that after everything removable is removed the conversation is still above the host's threshold and the compaction will fire again in a few turns." (`noul`.)

**What to measure to bring it back.** The functional trial of section 1.4 with depth as the only variable, five or six compactions in a row, and the number of re-reads after each.

### 2.6 Task levels by Jev (Z1) and compaction by tasks in shadow

**What Z1 is.** To cut the repetition of section 1.3, Jev is asked **once per compaction** for the level of each task on the list: `pelna` (the whole entry), `tytul` (one line `number [state] text`) or `niepotrzebne` (left out and counted); the code then composes the `zadania` field of the block requests from his answers and decides nothing itself. Choice question with described levels, no thresholds; each question names its task in its own text. Switch `OMC_JEV_COMPACT_ZADANIA_WYBOR` = `off` (default, request bodies byte for byte as before) | `shadow` | `active`.

**What was measured (quoted from the track's hand-over)** (one pass on K1, variant without the Haiku step, real Jev, code at an intermediate commit, not the final one):

| | Without choice | With choice |
|---|---|---|
| Requests to Jev | 214 | 122 (9 of them for the choice) |
| Jev tokens | 5,610,059 | 3,068,328 (the choice itself 246,888 = 8 %) |
| Size of the task field in a request | 30,638 bytes | 20,197 bytes on average (-34 %) |
| Tokens after the compaction | 126,965 | 127,749 (target 120,000 not met) |
| Levels given to 143 tasks | | 12 full, 125 title, 6 left out, 0 without answer |

Observed in one run: -43 % requests and -45 % tokens against a baseline that is itself the sum of two passes (section 1.3); this is not a controlled comparison. The title level hardly shortens anything: the task store has no separate title, so the one-line form carries the whole text and only the object keys are saved (about 31 %).

**The side effect that was measured.** Verdicts of the first round of block scoring, same blocks: of 938 blocks scored in both passes, 716 (76.3 %) got the same level and **222 (23.7 %)** a different one; blocks kept verbatim fell from 197 to 106 (-46 %); 99 moved from verbatim to trace and 8 the other way. A noise control (5 of the first-pass request bodies sent again to Jev, 35 questions): 34 of 35 the same level (97.1 %), one differing. So the movement is far outside the repeat noise. **The cause was not separated**: with the smaller state about 1.7 times more blocks fit in one request (90 first-round requests against 156), so either the shorter list or the different packing could be doing it. Which side is better was not asked either: the end shape of the compaction was nearly unchanged (385 blocks to traces against 363).

**Not measured.** The `active` variant with the Haiku step (about 1.6 million Jev tokens estimated against 1.69 million, a small gain because that step does not carry the task field); the final code; a pass on another session; a control with the full list and the new packing (about 3 million tokens of Jev).

**Question sent** (type `choice`, Polish verbatim, then English; the task number and text are filled per question):

> Jakiego opisu zadania {zadanie} „{treść}” z `zadania` potrzebujesz, żeby w tej kompakcji ocenić, co z rozmowy (bloki, wyniki narzędzi, załączniki) musi zostać dosłownie?

"What description of the task {task} "{text}" from `zadania` do you need to judge, in this compaction, what of the conversation (blocks, tool results, attachments) has to stay verbatim?" Inspect: `zadania`. Focus: "You choose what the list should hold about this task when blocks, tool results and attachments are judged; you do not judge the task itself. The current task is `zadanie` (the owner's words), the course of the conversation is `os_rozmowy`." Options: `pelna` "the full entry of the task (number, state, all text and the state and judgement fields) is needed", `tytul` "one line 'number [state] text' is enough", `niepotrzebne` "the task is not needed for this judgement; it is enough to know that the full list exists".

**Compaction by tasks in shadow (the `tasks` switch of the module).** The module can mark calls and blocks that belong to closed tasks (`tasks_closed`), collapse repeated calls of the task tools (`tasks_collapsed`) and notice calls displaced by later ones (`tasks_superseded`; the displacement itself has its own PR). It ran in `shadow` (counted, applied to nothing) in 29 of 29 current-revision records: over those 29 compactions 217 closed-task items, 62 collapsed and 2 superseded were counted, 5,455 task-tool calls seen (recomputed). Whether applying the marks would have cut tokens without hurting the work was **not measured**; an earlier piece of measurement (stage 5 of the first plan) shows 0 characters in 6 shadow records (quoted).

**What to measure to bring it back.** The control run of section 1.3 and the final-code `active` pass, then the trial after a compaction in which the verdict shift is judged by what the model needs next, not by agreement.

### 2.7 Shortening traces (S3)

**What it is.** The traces left behind by the compaction are long: the full path of the file with the cut text (about 135 characters), the end of a cut reply (120 characters), the tool input (200 characters); they run at 1.84 characters per token. S3 proposes: one header per compaction naming the directories (`o/`, `a/`), 60 characters of the start of a reply and no end, tool input 80 characters, `[ślad] Bash(<80 chars>…) usunięte 666/2`.

**What was measured (quoted)** (one copy, K0 of 2.1): traces in the result 126,367 characters; the proposal 39,879 (-86,488 characters). A variant transcript with the shorter traces resumed 244,707 to 197,610 tokens (**-47,097**, measured, not an estimate). A reply trace was 40 % of the original text (the goal was 12 % or less).

**Not measured.** Whether the model repeats calls or fails to find the file more often when the trace is shorter (the agents in the functional trial opened files from traces three to six times per run with no failure, but those were the long traces); whether a header that exists only once per compaction survives a second compaction (the parser must read both formats because old sessions hold the old one).

**What to measure to bring it back.** The functional trial with the old and the short traces as the only difference; count of calls repeated after the compaction.

### 2.8 Agent reports to files (0f)

**What it is.** In sessions that coordinate agent teams the reports of the agents arrive as user messages and fill the context: in one coordinator session 149,556 of 357,640 characters (41.8 %, 76 messages, 39 of them 1,500 characters or longer) were agent messages (quoted). 0f moves the long reports (and, with `AGENT_TRIM`, trims their frames) to files and leaves a trace with the path; the last six reports stay verbatim.

**What was measured.** On a copy made while teams were on (quoted): 42 of 57 reports moved (105,777 characters to files, traces 14,098 characters = 13 %); 21 stayed verbatim, 46,761 characters (15 too short, 6 the last ones). **In the local build's log, where agent teams are switched off since 11 November 12:04 (quoted), `considered` is 0 in all 20 current-revision records that carry the block (recomputed)** (the other 9 records of that revision have no agent block). So the feature has had nothing to do for a day, and its effect on the work was not measured. Whether the model went to read a moved report was not counted for reports specifically (the neighbouring archive of #5013 had no reads at all).

**What to measure to bring it back.** A day of work with teams on; the share of moved reports that are opened again, and the repeat work after the compaction.

### 2.9 Handing the compaction to the host when it cuts less than 30 % (N28e)

**What it is.** If Jev's compaction removes less than 30 % (`HOST_MIN_CUT` 0.3) the module declines and the host's own summary compaction runs instead (switch `OMC_JEV_COMPACT_HOST_HANDOFF`, off by default).

**What was measured.** In the local build's log, **10 of 19** (recomputed) Jev compactions that have a first-request measurement cut less than 30 % (2.0, 6.2, 14.8, 20.9, 21.2, 21.8, 23.5, 24.8, 27.6, 28.0 %; the rest 31.4 to 56.4 %; median 28.0 %). With the rule on, those 10 would have gone to the host. A repetition on the offline copy of the main session cut 34.4 % (quoted).

**The first suspicion was a test artefact, and it was.** In the functional trial on the agent copy K3 (quoted), Jev refused the result of the module in 2 of 4 second compactions and the host compacted instead. That looked like the rule firing, but the stand-in host of the trial called the module with the trigger `auto` and the host's default threshold of 487,000 tokens, and for `auto` the module raises the "tokens before" to the host's threshold; the real states were 140,000 to 153,000, so Jev saw numbers inflated 3.2 times (an "ask to remove 367,000" instead of about 30,000) and refused. In a check of that log by the experiment (quoted) 35 of 38 main-loop records agree with the provider's `usage` within 0.3 % (the other three: two raised to the threshold by `auto`, one estimate), so live the scale is right.

**Not measured.** Whether a host summary is better than a small Jev cut in those ten cases (nobody compared the later work); whether Jev's refusing is a better judge than the 30 % rule; the rule applied on a longer run.

**What to measure to bring it back.** The functional trial with a corrected stand-in (trigger `plugin`, the real window and threshold), and the later work after both outcomes.

---

## Summary

| Item | Verdict | Basis |
|---|---|---|
| 1.1 `output-trim` | rejected | 0.37 % (laptop, 7 days, 70.7 M characters) and 1.10 % (server) against 10 %; 27 of 40 reviewed applications lost needed text |
| 1.2 N14d trace merging | rejected | 0 merges in 45 compaction records; 0 runs in 25,746 tool calls |
| 1.3 State repeated in every block query | rejected | 0.36 to 2.15 to 5.61 M Jev tokens; 72 to 76 % of the traffic was the same state; no measured benefit |
| 1.4 120,000 target without Haiku | not met | 126,965 on one copy (n = 1) |
| 2.1 Step A, attachments | not tested live | 244,707 to 210,342 on a copy (attachments), 163,245 with shorter traces |
| 2.2 Whole results, 40,000 B window | quality not measured | API limit about 58 KB; about +2,100 tokens per candidate (estimate) |
| 2.3 Block verdicts after each batch | weak in the probe | spread 1.23 to 1.35, confidence 0.26 to 0.40 |
| 2.4 Moment each turn end | see #5008 | cost only, p95 454 ms (quoted) |
| 2.5 Depth by Jev | not compared | passes in live: A 10, D 8, B 7, forced 2 |
| 2.6 Z1 and shadow task compaction | one run | -45 % tokens, 23.7 % verdicts moved, cause unseparated |
| 2.7 Shorter traces | partly measured | -47,097 tokens on one copy |
| 2.8 Agent reports to files | idle | considered = 0 in 20 of 20 records |
| 2.9 Hand-back below 30 % | not decided | 10 of 19 below 30 %; the trial's refusals were a scale artefact |

## How to reproduce

`scripts/jev-negative-results/jev-compaction-experiments/` holds three counters that run without an API key, each with a deterministic synthetic mode, and the reference trimmer:

- `count-trim.mjs` (section 1.1): `node count-trim.mjs --synthetic`, or `--transcripts <dir>`.
- `count-merge-hits.mjs` (section 1.2): `--synthetic`, `--transcripts <dir>`, or `--compact-log <file>`.
- `count-repeated-state.mjs` (section 1.3): `--synthetic`, `--bodies <dir>`, or `--request-log <file>`; `sample/request-log-sizes.jsonl` is the per-request field sizes of the run of section 1.3 (sizes only).

The README there lists what each mode needs and what it costs (nothing).

## Why none of this goes further, and what is used instead

1.1 and 1.4 failed a threshold or target fixed beforehand; 1.2 found nothing to merge; 1.3 multiplied the cost with no measured benefit. Section 2 is parked for lack of a measurement that would justify the work. What is used instead is the merged `compaction` point: Jev scores tool results and the module cuts to a share of the characters (`OMC_JEV_COMPACT_TARGET`, default 0.5), with the host's own compaction as the fallback. The token target from `usage` described above is a feature of the local build only.

## Related PRs and issues in this repository

- #4940 (merged): the opt-in `compaction` point.
- #4962, #4978, #4979, #4992, #5001, #5012 (merged): follow-ups of the compaction point (desktop-app notices, call/result pairs and resume, transcript repair, secrets and private paths, thinking rows).
- #4980, #5029 (merged): growth gate armed only when messages were replaced; tail handles only beside text, calls and signed thinking.
- #4989 (open): messages delivered during a tool turn through the compaction.
- #5008 (closed as a negative result): elastic compaction target and a moment chosen by Jev at `turn.complete`; related to 2.4.
- #5013 (closed as a negative result): archive of cut results and pasted material; related to 2.1 and 2.8.
- #5041 (closed as a negative result): superseded calls in the compaction replaced by a note.
- #5040 (closed as a negative result): Haiku summaries, step B; related to 1.3 and 1.4.
- #5034 and #5036 (closed as negative results): the panel and the task list reminders.
