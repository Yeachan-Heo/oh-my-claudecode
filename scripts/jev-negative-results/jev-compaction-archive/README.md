# jev-compaction-archive: measuring whether anyone reads the archive (negative result, not for merge)

Companion of `docs/jev/negative-results/jev-compaction-archive.md`. Read that first. The question these two scripts answer: of the files the Jev compaction module archived (cut tool results) or moved out of the conversation (pasted text), how many did an agent open afterwards?

Neither script calls any API, needs a key, or prints text from a transcript or a log. They print counts only.

## Files

| File | What it does |
|---|---|
| `count-archive-opens.mjs` | Walks Claude Code transcripts (`*.jsonl`, main sessions and `subagents/` files) and counts tool calls that name an archive directory: `Read` (`file_path`), `Bash` (`command`), and any other tool (`Grep`, `Glob`, ...) counted apart. Also counts transcripts that merely name the path (the module's traces). With `--archive-root <kind>=<dir>` it lists the files that exist there and reports how many were opened by name. |
| `summarize-compact-log.mjs` | Sums the archive and pasted-text counters of the module's own log (`compact.jsonl`): files written, reused, bytes, why a result got no file, pasted blocks asked about, moved, characters moved and left as trace, estimated tokens. |

Both have a mode on synthetic data that checks their own arithmetic and exits non-zero on a mismatch:

```
node count-archive-opens.mjs --synthetic       # 7 synthetic transcripts and a synthetic archive in a temp directory
node summarize-compact-log.mjs --synthetic     # 4 synthetic log records
```

Expected: every line `ok`, last line `synthetic check passed`. Run on 12 November 2026: both passed (16 and 15 checks).

## Run on real data

```
# the archive of the code in this branch writes to <state dir>/compaction-archive/<session>/<tool_use_id>.txt and
# <state dir>/compaction-pastes/<session>/<hash>.txt; <state dir> is OMC_JEV_LOG_DIR or ~/.omc/state/jev
node count-archive-opens.mjs --dir ~/.claude/projects --since-days 7 \
  --archive-root results=<state dir>/compaction-archive --archive-root pastes=<state dir>/compaction-pastes

# any other layout: name the path fragment of each kind yourself
node count-archive-opens.mjs --dir <transcripts> --kind results=/my/archive/ --archive-root results=/my/archive

# transcripts scattered over a tree you do not want to walk: a file with one transcript path per line
node count-archive-opens.mjs --list transcripts.txt --kind results=/compaction-archive/

node summarize-compact-log.mjs <state dir>/compact.jsonl --json
```

Output of `count-archive-opens.mjs`, per kind:

- `files_with_reference`: transcripts that name the path in text or in a tool result (the trace the module left, or someone quoting it). A pointer was shown to the model.
- `files_with_open`, `opens_read`, `opens_bash`, `opens_other_tools`: transcripts with, and calls of, a tool call whose target names the path. A call is counted once by its `tool_use` id: a transcript that is a copy of another one (a resumed or forked session, or a trial run started from a copy) repeats the calls of the original, and `calls_seen_in_more_than_one_transcript` says how many such calls there are.
- `distinct_paths_opened`, `archived_files_on_disk`, `archived_files_opened_by_name`: how many different path strings the calls named, how many files the archive directory holds, how many of them a call named by session directory and file name.

## What the counts do not tell

- An "open" is any tool call that names the directory: a `cat` of one file, a `grep -l` over the whole session directory, an `ls`. Reading by directory or by glob counts as a call but not as a file opened by name. Every call that is not a plain `Read` has to be read by a person to classify it; the document says how the ones found were classified.
- A call made by a person or by a measuring agent that inspects the state directory (counting files, listing it) looks the same as an agent following a trace. The transcript of the session that runs the count also contains the command that runs it.
- A path built in a shell variable (`d=<dir>; cat $d/$f`) names the directory in the command but no file by name.
- Not reading is not the same as not needing: the archive is a safety net, and a net unused in a run is consistent with it working. The count says how often it was reached for, not what would have been lost without it.

## The code attached to this branch

`hooks/jev-compaction.mjs` and `scripts/lib/jev-compaction-state.mjs` here contain, on top of the archive (the head of #5013):

- the pasted-text move of the unsent branch `feat/jev-compaction-pastes` (`OMC_JEV_COMPACT_PASTES=off|shadow|active`, default off; `OMC_JEV_PASTES_DAYS`), cherry-picked, with the conflicts against the archive resolved by keeping both sides;
- `sweepPastes` in the state library, a copy of `sweepArchive` for `compaction-pastes`;
- one test that runs both on in the same compaction.

Both switches are off by default. Tests: `src/__tests__/jev-compaction-module.test.mjs` and `src/__tests__/jev-compaction-state.test.mjs`, 197 passing on 12 November 2026 with `OMC_JEV*` and `TYPESAFE_API_KEY` unset.
