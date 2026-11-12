# Jev compaction: an archive of the cut results, and pasted text moved to files

**Negative result. Tried, measured, rejected. Not for merge.**

Jev is the hosted decision service (Typesafe AI) that OMC's judgment points call from hooks; each call is a set of questions about a state and the answer is a choice or a probability. Scope of this result, stated first so it is not misread: it is about two optional add-ons of the `compaction` judgment point, not about the point itself.

1. **The result archive** (`OMC_JEV_COMPACT_ARCHIVE`, PR #5013): every tool result the compaction cuts or removes is first written, whole, to a file, and the trace in the conversation names the file.
2. **Pasted text moved to files** (`OMC_JEV_COMPACT_PASTES`, a branch that was never sent): a long `<pasted_content>` block in an old user message is replaced by a short trace with a path, after Jev has said that the block is entirely pasted material.

The compaction itself (Jev scores the tool results and decides what stays verbatim, what becomes a short form and what becomes a trace; merged in #4940 and refined in the follow-ups listed at the end) works, is in use, and stays. Only these two extensions are dropped.

The thesis, in one line: the archive is a safety net that agents practically never reach for, and moving pastes gave a small gain that no functional trial measured. Both cost code, disk and request budget. What was not measured is listed in its own section; it is long.

## What they were meant to do

**Archive.** Problem: a result the compaction removes is gone for good, and the model sees only "result of N chars removed". Hypothesis: if the full call (input masked) and the full result are kept in a file the model can read back on demand, then cutting is safe: nothing is lost, the model can fetch what it turns out to need, and the compaction can be bolder. The price is about 100 to 140 characters of path per trace.

**Pastes.** Problem: a large pasted text (a log, another assistant's answer, a document) fills the context for the rest of the session. Hypothesis: it can be replaced by a trace holding its length, the path of a file with the full text, and its first 200 and last 300 characters word for word, without losing anything the user wrote, because Jev reads the whole block first and says whether any part of it is the user's own writing.

## How they work

Both run inside `hooks/jev-compaction.mjs` (the hooks-host module of the `compaction` point), and write through the host's `$.fs`. Both are off by default. The archive also runs in the compactions of subagents (11 of the 44 compactions in the log below, 10 agents, 1,476 of the 1,989 files); the pastes only in the main loop (`e.agentId !== undefined` skips them).

**Archive** (`OMC_JEV_COMPACT_ARCHIVE` = `off` | `shadow` | `active`; retention `OMC_JEV_ARCHIVE_DAYS`, default 14):

- Writes `<state dir>/compaction-archive/<session>/<tool_use_id>.txt` for each candidate result that the allocation cuts or traces: a head with the call and its input (masked), then the result unchanged. The trace or cut then ends with `; full call and result: <path>`.
- A file is named in a trace only after it was written and read back; an existing file is reused only when its content is equal; duplicate ids are archived once.
- Not archived (the trace carries no path): a result that masking would change, one that names a secret or private path, a result of a call on such a path, held background output, non-text results, results over 50,000 characters, text an earlier compaction already cut, and anything past the 240 files per compaction, 1 s of scanning or 1.5 s of writing. The secret handling reuses what #4992 added.
- `shadow` only counts (`archive_planned`, `archive_skipped` in the compaction record). SessionStart removes session directories older than the retention days and refreshes a `.compaction` marker of the current session first.
- Limits of the host API, documented in `docs/HOOKS.md`: `$.fs.write` has no mode parameter (the files get default permissions), and there is no cap on the total size per session.

**Pastes** (`OMC_JEV_COMPACT_PASTES` = `off` | `shadow` | `active`; retention `OMC_JEV_PASTES_DAYS`, default 14):

- Plans the `<pasted_content>` tags of older user messages. A tag moves only if all of these hold: it is a whole closed tag of 2,000 to 30,000 characters (and not above `OMC_JEV_EXCERPT_CHARS_COMPACTION`); its message holds at least 20 other characters of the user's words; the message is not the first or the newest user message, lies before the kept tail and the open tool loop, and has no image or file block; it names no secret or private path and masking leaves it unchanged.
- Sends the whole tag to Jev, one request per tag, at most 4 tags (the largest), after the scoring requests; the requests count against `OMC_JEV_MAX_REQUESTS`, the breaker and `OMC_JEV_MAX_RPM`. The tag moves when the probability of "yes" is at least 0.8.
- Writes `<state dir>/compaction-pastes/<session>/<first 32 hex of the sha256 of the tag>.txt`, reads it back, and replaces the tag with `[pasted text moved at compaction: <N> chars, full text in <path>; start: "<first 200 chars>"; end: "<last 300 chars>"]`. The words around the tag stay. A compaction that ends in the built-in summary moves nothing.
- `shadow` asks and counts but writes nothing.

Where the code is. `hooks/jev-compaction.mjs` and `scripts/lib/jev-compaction-state.mjs` in this branch hold both: the archive as it was at the head of #5013, and the pastes cherry-picked from the unsent branch on top of it (two feature commits; its two inventory commits were replaced by one regeneration at the end). The conflicts were in the header comments, the constants, the config, the retention code and the test files, and were resolved by keeping both sides; `sweepPastes` is a copy of `sweepArchive` for the other directory. A test turns both on in one compaction. With the switches off (the default) the result and the compaction record are those of the archive branch; a test pins that for the archive, and the pastes tests pin it for pastes.

## The exact questions sent to Jev

**The archive asks Jev nothing of its own.** It archives the results that the existing scoring (the `compaction` point's score question, in the module as `QUESTION_INSTRUCTIONS` and `QUESTION_CRITERIA`, unchanged by this branch) already decided to cut or trace. The only addition to the scoring is the path in the trace, which makes traces longer and so is counted in the target.

**Pastes ask one question per tag**, verbatim (English; the module's constant `PASTE_QUESTIONS`). Type `noul` (a probability that the answer is true); the state sent is `{ fragment: { text, chars } }` with the whole tag after the checks above:

```json
{
  "pasted": {
    "type": "noul",
    "instructions": "Is state.fragment.text entirely text that the user pasted from elsewhere (an answer of another AI, a document, a log, the output of a command), with no part of it written by the user themselves: no instruction to the assistant, decision, answer, opinion, comment, question, note, draft or message of their own?",
    "criteria": {
      "true": "Everything in it is pasted material; nothing in it is the user's own writing.",
      "false": "The user wrote at least a part of it (even one sentence or a comment between quotations), or it cannot be told."
    }
  }
}
```

The author's local patch, on which the live numbers below were taken, is a wider variant of this feature: it also handles pastes that make up a whole message, splits messages into blocks, and asks Jev per block with its own (Polish) question wording. That wording is not part of this branch and cannot be reproduced from it (the branch asks one question per tag, above), so the template's verbatim questions are given for the branch version only; the counters below come from that variant and mean the same things (blocks asked, answered yes or no, moved, characters moved and left as trace).

## How it was tested, and how to reproduce

1. **Unit and integration tests in this branch** (fake host, fake Jev, real masks): `src/__tests__/jev-compaction-module.test.mjs` and `src/__tests__/jev-compaction-state.test.mjs`, 197 passing on 12 November 2026 with every `OMC_JEV*` variable and `TYPESAFE_API_KEY` unset. On the archive head alone the same two files had 148 passing (the figure in #5013), so the pastes tests and the one combined test add 49.
2. **Live use on the author's machine, two sessions of one user, almost all in one long-running main session** (a Claude Code session on a work project; a second session has 1 of the 44 compactions), 9 to 12 November 2026: both features ran `active` in the local patch; the compaction log (`compact.jsonl`) holds their counters.  It is one machine and one user.
3. **Reads of the archive afterwards**: Claude Code transcripts searched for tool calls that name the archive directories, in two corpora: all transcripts of the last 7 days on the machine, and the transcripts of the functional trial of compaction variants ("track F").
4. **Functional trial** of compaction variants (the one described in `docs/jev/negative-results/jev-compaction-haiku.md`: an agent session of 454k tokens compacted by different methods and given the same continuation task, 23 base runs in two stages). It was not designed to test the archive or the pastes. Its transcripts are used here only as a corpus for item 3.

Reproduce the counting with the two scripts in `scripts/jev-negative-results/jev-compaction-archive/` (README there). Both have a mode on synthetic data that needs no key and no real transcript:

```
node scripts/jev-negative-results/jev-compaction-archive/count-archive-opens.mjs --synthetic
node scripts/jev-negative-results/jev-compaction-archive/summarize-compact-log.mjs --synthetic
```

They print counts only. Both passed on 12 November 2026 (16 and 15 checks). Run against your own `~/.claude/projects` and `compact.jsonl` they give the same measures for another user.

To try the features (the tests do it with a fake host): `OMC_JEV=compaction:active OMC_JEV_COMPACT_ARCHIVE=active OMC_JEV_COMPACT_PASTES=active`, with `TYPESAFE_API_KEY` set, bills Jev tokens.

## Results

Every number has its denominator and its source; a result that rests on one session or one run says so. The log was read, and the transcripts were scanned, in the early hours of 12 November 2026; the log and the archive grow while the session goes on, so a later reading gives larger counts.

### The archive: files written

Source: `compact.jsonl`, summed by `summarize-compact-log.mjs`; two sessions of one user (43 of the 44 compactions in one).

| Measure | Value | Denominator |
|---|---|---|
| Compactions with the archive `active` | 44 | all 74 compaction records of the log, 7 sessions; the archive and the pastes ran in two of the 7 sessions (43 of the 44 compactions in one of them); 11 of the 44 are compactions of subagents |
| of which wrote at least one file | 41 | 44 |
| Files written | 1,989 | 44 compactions, 9 to 12 November 2026 |
| Files reused (same content already there) | 17 | |
| Write errors, rewrites | 0, 0 | |
| Writes cut off by the time budget | 2 | |
| Bytes written | 3.91 MB (3,913,257 B) | sum of `archive_bytes` in the log, 1,989 files; the directory grows with the log |
| Skip events, all reasons | 2,301 | per compaction, so the same result can be counted at several compactions |
| of which secret in the result or secret path | 2,205 (95.8%) | 2,301 |
| of which text an earlier compaction already cut | 92 | 2,301 |

Reading: 95.8% is a share of skip events (counted per compaction, so the same result can be counted at several compactions), not of results, and the skip events cannot be set against the number of files. The only figure on distinct results is an earlier reading on the same sessions (plan stage of 11 November 2026, a smaller number of compactions, stated as it was recorded): 433 files and 0 reads, and 27 of 46 removed results without a file because of the secret rule. That is what the claim that the archive cannot be a complete record rests on; counting distinct skipped `tool_use` ids was not done.

### The archive: files opened afterwards

Source: `count-archive-opens.mjs` over Claude Code transcripts; a call is counted once by its `tool_use` id.

| Corpus | Transcripts | Name an archive path (a trace was shown) | Tool calls naming the results directory | Archived files opened by name |
|---|---|---|---|---|
| All transcripts modified in the last 7 days on the machine, with subagent files, without the transcript of the agent that ran this count | 647 (302 of them subagent files) | 131 | 3 (2 `Bash`, 1 `Write`; no `Read`) | 0 of 1,989 |
| Functional trial transcripts ("track F", 23 base runs, 42 run directories) | 2,644 (86 subagent files) | 50 | 8 (all `Bash`) | 1 `cat` of one file; 7 searches over the session's whole archive directory |

Classification of the calls, done by reading each command (the counter cannot tell a search from a reading, or an agent from a person):

- **Last 7 days, 3 calls** (the agent that ran this count is left out: its own commands name the directory, and counting them would be counting the counter; with its transcript the figure was 9 calls). None of the 3 is an agent following a trace to read a cut result: one is an agent searching the transcripts for the path, one a test file written by an agent that quoted the path as test data, one a note-taking command whose text quoted the path. Agent-initiated reads of an archived result in 7 days: 0 of 647 transcripts.
- **Functional trial, 8 calls in 6 of the 23 base runs.** All came from the agents of the trial (after the compaction under test). Seven were content searches (`grep -l` or `grep -rl` for a marker over the whole archive directory of the copied session, appearing in the original-plugin runs as well, whose context still held the path from before the compaction); one was a `cat` of a single archived file, in run J5off-LP-1 (second stage). So 1 file read by name in 23 base runs; 7 searches. Four of the 8 calls appear in more than one transcript because a stage-2 transcript carries the history of its stage 1.
- The 50 trial transcripts with a pointer lie in 37 of the 42 directories of the trial. The hand count made during the trial (213 files "with references to the archive") comes from searching the whole trial tree for a path of any of the three archive directories (`state/jev/(wyniki|wklejki|odpowiedzi)/`, in all `*.jsonl`): 213 files contain such a path (results 189, pastes 62, replies 62; the sets overlap). 50 of them are among the 2,644 transcripts counted in the table; the other 163 are frozen copies and measurement directories of the trial tree that are not transcripts of runs and are not counted in the table. The calls that open an archived file are the same in all 213: the 8 `Bash` calls above, 1 of them by file name.

Replies moved to files by the same local patch (a third kind, not in this branch): 4 tool calls in the same corpus name their directory (3 `Bash`, 1 other tool), among them one main-session command that read reply files in a loop (its target names the directory, not a file); 0 of 172 files on disk opened by name.

### Pastes: files written and tokens

Source: the same log, field `wklejki` of the local variant (the branch's field is `pastes`); two sessions of one user (24 of the 25 compactions in one).

| Measure | Value | Denominator |
|---|---|---|
| Compactions with pastes `active` | 25 | 74 records; two sessions (24 and 1) |
| of which moved at least one block | 6 | 25 |
| Blocks asked about (Jev requests) | 19 | |
| Jev said yes / no | 11 / 8 | 19 |
| Blocks moved to files | 11 | the pastes directory held 11 files |
| Characters moved to files | 21,293 | |
| Characters left as traces | 8,303 | |
| Net characters out of the conversation | 12,990 | |
| Estimated tokens (net characters / 4, the module's own estimate; not a token count) | about 3,250 | |
| Net characters as a share of all characters removed in those 6 compactions | 2.0% | 12,990 of 663,873 |
| Write failures, timeouts | 0, 0 | |
| Early reading recorded when the feature was first assessed | 5 of 5 records with 0 moved | the first 8 of the 25 records here also moved nothing; the first move is at 16:48 UTC on 11 November |

The first compaction that moved something saved 45 characters (798 moved, 753 left as trace). The biggest single compaction moved 5 blocks and saved 7,758 characters. Blocks left alone without a question, counted per compaction (the same block can be counted at several): 41 as too short to move (23,709 characters in total), 16 by the secret rules.

Reads: 0 of 11 files opened by name in 647 transcripts of the last 7 days (1 tool call names the directory, apart from the counting agent's own; it is a note-taking command). The trial's transcripts contain no pointer to the pastes directory.

### What the trial shows

Nothing about either feature, and that is the point. The trial compared compaction variants on time to a goal, turns, tokens and quality of the result; in none of its 32 runs was the archive or the pastes a variable, and which runs had them switched on was not checked for this write-up. The one `cat` of an archived file is an observation, not a measured benefit.

## What was not measured

- **Whether a model that needs a cut result would find and read it.** The archive was never compared with and without it on a task that needs a cut result later. A 0 in reads shows the pointer was not followed in these runs, not that following it would have failed or helped.
- **Quality with the bolder compaction the archive was supposed to allow.** The compaction was not made bolder because of it; there was no experiment with a more aggressive target backed by the archive.
- **The effect of pastes on the next turns.** Whether the model needed the text of a moved block later, and what it did when it saw only head and tail, was not measured. Jev said "no part is the user's own" for 11 of 19; whether it was right was not checked block by block by a person.
- **A real token count.** The 3,250 tokens are characters divided by 4; the counter of the host was not used.
- **Other users and other sessions.** All live counts are two sessions of one user (almost all from one) over three days; the 7-day transcript corpus is that user's machine. A session with more pasted logs would move more.
- **Disk and retention behaviour over weeks.** The retention default (14 days) and the sweep were tested with a fake clock only. A trace older than the retention window may point to a removed file; no live case was seen.
- **Security of the written files.** The host API gives no file mode, so the files get default permissions; there is no total size cap. Secret handling is the existing masking plus the path rules; the files hold results the module judged free of secrets, but a secret in prose without a key-like pattern is not caught (the limit of `maskSecrets`).
- **Calls that read the archive in ways the counter cannot see:** a path assembled in a shell variable, a glob, a tool that is not logged in the transcript. They would raise the opened count; a classification by reading found none in the corpora.

## Why it was rejected

- **The archive is almost never read.** 0 agent-initiated reads of an archived result in 7 days (647 transcripts, 1,989 files) and 1 read by name in the trial (2,644 transcripts, 23 base runs). A feature that is justified by "the model can read it back" is not shown to be used.
- **It cannot be complete.** The secret rules leave a result without a file by design (27 of 46 removed results in the plan-stage reading; 95.8% of the skip events in the log, an event share); the results most likely to hold something that must not be copied are exactly the ones it leaves out. And it adds a store of results on disk, with default permissions, without a total cap, for a benefit that no run showed.
- **It costs.** Code (`git diff --numstat`): the archive added 282 lines (41 removed) to `hooks/jev-compaction.mjs` against `dev`, which had 1,911 lines, 64 to the state library and 522 to the two test files (400 and 122); the pastes add another 260 (2 removed), 47 and 485 (410 and 75) on top, and the module is now 2,410 lines, 100 to 140 characters of path in every trace counted into the target, a write budget inside the compaction's time budget, a retention sweep at SessionStart.
- **Pastes give little.** About 3,250 tokens (an estimate) in a session whose compactions removed 663,873 characters in the compactions where it acted: 2.0% of the removal. It needs one Jev request per block, of which 8 of 19 were answered no.
- **Nothing in the trial supports either.** No run varied them.

What is used instead: the compaction as merged (#4940 and its fixes), where a cut result leaves a one-line trace and a result that is needed again is fetched by running the tool again. Replies moved to files (a third local feature, not in this branch) and the other local extensions are described in their own results where they were dropped.

## Related

- #4940 (merged): the `compaction` judgment point that these two extend.
- #4992 (merged): keeps secret and private paths away from the compaction request; the archive reuses its path rules.
- #5013: the open draft this write-up replaces. A maintainer review requested changes (cap of 240 results, masking budget before the cap, re-planning after write failures, line-prefixed reads of archive files), and a bot raised more than 10 P2 findings. The branch keeps the code as it was (unfixed on those points), because the measured question, whether archived files are read, does not depend on them.
- #5008 and #5040 (closed, negative results): the elastic target and moment, and Haiku summaries ("step B"). #5008 listed the archive as the thing the second half of the elastic idea would have needed.
- `docs/jev/negative-results/jev-compaction-haiku.md`: the functional trial's design and the full list of its runs.
