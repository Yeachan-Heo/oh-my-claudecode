# Five-hour limit guard

An opt-in guard for people who run many Claude Code sessions at once on one Claude subscription. **It works only with a
Claude subscription (OAuth login), and only while something keeps OMC's usage cache fresh: the OMC status line with rate
limits shown (`elements.rateLimits` is not `false`) or a running `omc wait`.** Without that the guard sees no usage and
holds nothing; it says so in its log (`WARNING`, see "Input: the usage cache"). When the five-hour usage window reaches a
threshold (97 % by default), every tool call of every session that loads the hook waits until the window resets, plus a margin (see "Which sessions load
the hook"). Nothing is
denied and no signal is sent to any process: the sessions stay alive, keep their id and their connections, and a session that calls a tool stops spending at that call, after at
most one more model response (a prompt that Claude answers without calling a tool is not held: the hook runs before tool calls, `PreToolUse`, and no
event of that kind fires for such an answer). When the window resets, the waiting tool calls continue exactly where
they stopped.

It is not part of the plugin. Nothing in `hooks/hooks.json` or in the hook set of the plugin changes, no service is
installed, and `tools/` is not shipped in the npm package (`tools/` is not in the `files` list of `package.json`).
You start the guard yourself and add one hook entry to your own `settings.json` with the settings tool.

## How it works

Three scripts and one small module they share, Python 3 standard library only:

| Script | Role |
|---|---|
| `five-hour-guard.py` | the guard: a process that reads the usage cache and writes or removes the pause file |
| `five-hour-guard-hook.py` | the `PreToolUse` hook: waits while the pause file says "paused" |
| `five-hour-guard-settings.py` | `add`, `remove` and `check` the hook entry in `settings.json` |
| `five_hour_guard_entry.py` | the one definition of the hook entry command and of how the entry is recognised in `settings.json` (by a marker); loaded by the guard and the settings tool from their own directory (the hook does not need it) |

1. Every `--interval` seconds (30) the guard reads the usage cache. With a five-hour percentage at or above the
   threshold, from data younger than `--max-age` (180 s), and a reset time in the future, it writes the pause file
   atomically: `v`, `paused`, `since`, `resume_at` (reset time plus `--margin`, 150 s), `valid_until` (now plus
   `--heartbeat`, 300 s), `exclude`, `percent`, `pid`. While paused it rewrites the file on every tick, which renews
   `valid_until`.
2. The hook is registered once in `settings.json` (matcher `*`). On every tool call it checks the pause file. When the
   file says "paused" and is valid, the hook waits (it polls every 2 s; a hand-written `--poll` is kept between 0.1 and 5 s, so a call is released within a few seconds of the end of the pause) without printing anything and without denying the
   call, so the model has no reason to retry and makes no extra request. When the file is gone or no longer valid, the
   hook exits 0 and the tool call proceeds.
3. At `resume_at` the guard removes the pause file. Before that it resumes early when a fresh cache shows less than
   `threshold - 10` percent (the window was reset sooner than the cache said), and it extends the pause while the cache
   still shows the threshold with a later reset time. A held call lasts at most the `timeout` of the hook entry (21600 s unless
   raised): when such extensions take a pause beyond that minimum the guard logs a WARNING once (`pause-beyond-timeout`) and goes on, because Claude
   Code releases a call that has waited longer than the timeout whatever the guard does, and ending the pause early would let the calls that
   arrive later through; raise the timeout with `five-hour-guard-settings.py add --timeout` if pauses that long are expected.

The guard never publishes a pause over a file that is not a pause of this guard (one that appeared after the start, for example on a shared or mistyped path): the tick reports it and nothing is stored or published; a first publication is made with a hard link (where links are not supported, with an exclusive reservation of the destination that the pause file is then exchanged with, only while it is still the file at the path; a publication that fails removes that reservation the way the end of a pause removes the pause file, moved aside in one step and compared, so a file that took its place is put back or kept under its new name and the log says so), so a file that appears in that instant is kept too (whether the file exists is looked at once, and that look decides between the exclusive write, which is also the one of a renewal that finds the file gone since it was validated (a file that comes in then is kept and the tick reports it), and the replacing write; a renewal puts the new file in place by exchanging it with the file at the path (Linux `renameat2` with `RENAME_EXCHANGE`) and looks at the file it got: the path is never empty, which the hook would read as no pause, and a file that came in after the look is exchanged back and kept, and the tick reports it; where the system, the C library or the file system cannot exchange two paths, the file is looked at once more and replaced by a plain replace while it is still the one that was validated (Windows refuses a replace while another process holds the file open, as the hook does while it reads it: the replace is then tried again for about a fifth of a second, each time after a new look), and the tick reports an `ERROR` and replaces nothing when it is not; a second file that comes in between the exchange and the exchange back stays under the temporary name of the write and the error names it; so does the file that came in when the exchange back itself fails, and the new file then stays at the path, where it is a pause that is in force: the error says both). The pause is stored in the state file before its pause file is published, so a pause file never exists without a stored pause behind it (a failing state write delays the pause to the next tick that can write). The state file is put in place the same way: a write replaces the file that is at the path when the write starts, by an exchange, or is a first publication where there is none, so a file that comes in at its path after the check of the settings is kept and the write fails with an `ERROR` (where two paths cannot be exchanged, a plain replace after one more look, as for the pause file). Paths are compared with the case rules of the platform (Windows, macOS), also for files that do not exist yet. The wiring check compares the registered entry with the entry the guard generates (the same command `add` writes, built by `five_hour_guard_entry.py` from the pause file and `hook_log_file` of the guard, the hook next to it and the interpreter that runs it, so an entry written with `--hook`, `--python` of other paths is reported too): an entry other than the generated one produces a warning with the correct entry to paste (a hand-written entry is never an error). It also warns about a handler that runs in the background (`async`) or has a `timeout` missing, not a finite number (an integer too large for a float counts: JavaScript reads it as Infinity) or below 21600 s, and, for a command of the shape that `add` writes, when the hook it runs is missing or cannot be read, or the interpreter is missing or cannot be run (absolute paths without a `$`, since only the session knows what another path names; the shell test of the command ends with status 0 then, so the entry holds nothing, for example after the directory of the scripts was moved or removed). A check of the entry that fails on something it did not expect is reported as a warning and never stops the guard from starting or from entering a pause. At every wiring check (also after the start, when settings were rewritten) it warns about an entry whose `--log` is one of the runtime files or programs of the guard (including the hook, interpreter and scripts the entry names), and the entry it offers to paste does not copy such a log, and no pause is published or renewed while such a log is a runtime file or a program (the hook would append its lines to it; the error names the entry, and the refusal stays until the guard is restarted, like the protection of a program that a rewrite removed); it also warns when the hook, interpreter or launcher a registered entry names is the pause file, state file, log or lock file of the guard (a pause that would replace the program is refused, and so is every later write of the state file and of the pause file: the entry into a pause, each renewal and the end of a pause check the registered entries again). Every word of the commands of every other hook (of any event) and of the status line in `settings.json` counts too, without the guard knowing what the command does with it (see False alarms): a word with a directory part is that path (a relative one, `./prog` or `sub/prog`, is also that path in each existing directory that another word of the whole command names), a word without one is the file of that name in the working directory of the guard in each directory of the `PATH` of its simple command (a `PATH=dir` assignment in front of it, filled in with the values of its parameters before it is split, else the `PATH` of the guard; a relative entry, also of the `PATH` of the guard and of the `env` of `settings.json`, is also looked up from each directory that the command names, `cd /dir; PATH=bin prog`), and in each existing directory that any other word of the whole command names (`cd DIR; prog`, `env -C DIR prog`, `--directory DIR`: the shell may run the word from there, and no command is recognised; the same for the words of a quoted command inside it, `env -C DIR sh -c 'prog x'`); a `$NAME` or `${NAME}` in a word is also filled in with each value that a `NAME=value` word of the whole command gives it (the word of a `${NAME:=word}` or `${NAME=word}` anywhere in the command is such a value too, since it assigns NAME for the words that follow), in any order and none expanded by another, a value that fills in a parameter is also split at its blanks and each word of it is a candidate too, as the shell splits an unquoted expansion (the guard does not tell whether the expansion was quoted), and a variable that neither the command nor the guard has stays as written; the text values of the top-level `env` object of the same `settings.json` count as values too, and its `PATH` is also a list of directories where a word without a directory part is looked up (the hook processes get that environment and the guard does not; the `env` of other settings files, project and local ones, is not read); `${NAME:-word}`, `${NAME-word}`, `${NAME:=word}` and `${NAME=word}` are filled in with the values of `NAME` (those of the command, the one of the guard) and with the word, `${NAME:+word}` and `${NAME+word}` with the word and with nothing (the guard does not decide which one the shell takes; a word that holds a parameter is filled in innermost first, pass after pass until a pass changes nothing, and parameters that refer to each other in a cycle (`A=$B B=$A`) are a command that is not read to its end; `${NAME%pattern}`, `%%`, `#` and `##` are filled in with the value and with every cut of it that the pattern can make, from the end or from the start, the shortest and the longest not told apart, after the pattern itself is filled in like any word (`${NAME%$SUFFIX}`) and its backslash escapes are read as a shell reads them (`${NAME%\.py}`); `${NAME?word}` and `${NAME:?word}` with the values only; `${#NAME}` with the length of each value; the forms that only Bash has, `${NAME/x/y}`, `${NAME:off:len}`, `${NAME^^}`, `${NAME,,}` and `${!NAME}`, are not filled in); the words of a quoted argument (that of `-c` or `-S`), the part of a word after `=` and the value glued to a short option (`-oFILE`) are words too. A word with `*`, `?` or `[` is also every file that the shell expands it to (at most 4096; more is a command that is not read to its end). A word with a brace expression that has a comma or a `..` range (`{a,b}`, `{1..3}`, nested ones too) is also every word that Bash makes of it, as the shell may do that before any other expansion (more than 4096 is a command that is not read to its end; `{}` and `{a}` stay as written, so `find -exec cmd {} \;` is no reason to refuse). A Bash quote `$'...'` is also read as the text that Bash makes of it (hex, octal and Unicode escapes, `\n` and the other one-character escapes; an unknown escape keeps its backslash), `$"..."` is the same word without its dollar sign, and the words as written stay candidates too, as in a shell that has no such quote. The text is read as the settings tool reads it (a backslash and newline that is not an escaped backslash are removed first, as the shell does, also inside single quotes, where the shell keeps them (the quotes are not told apart); an unquoted `#` that starts a word comments out the rest of its line (except the comment that is the marker of the entry of this guard: what stands after it stays read); a `#` inside a word, in quotes or after a backslash is text, so is every `#` in a command with `$'...'`, a backtick or `<<` (a here document), and in the text of a quoted word that is read as a command (`sh -c '...'`), where a file named after it is a false alarm; a newline ends a command as `;` does), never run (a command that is longer than 64 KiB or has more than 4096 words or more than 4096 named files, or that nests quoted commands three levels deep, is not read to its end: see False alarms). The commands next to the hook in an entry of this guard count too, except the files that the entry names itself (hook, interpreter, launcher, pause file, hook log and the files of its tests). A hook of another tool is as much a file the guard must not write to as ours, so a file that any such word names is refused as `state_file`, `pause_file` or `log_file` at the start and at every write. The command of an entry is read with its quoting, so a quoted hook, interpreter or log path that ends in `;` stays that path. A relative hook, or an interpreter given with a directory part, counts as the file it names from the working directory of the guard in these checks (a session resolves it from its own directory, which the guard cannot know); an interpreter given by its bare name counts as the file the `PATH` of the guard resolves it to, as in the wiring check, and a launcher as the file that the `PATH` of its entry (a `PATH=dir` assignment before it, also after `env`; assignments in front of the command are expanded in the order of the shell, so `PATH=dir PATH=$PATH:/usr/bin cmd` keeps `dir`) resolves it to, else of the guard. Nothing is appended to a `log_file` that a registered hook, interpreter or launcher occupies (the notice goes to stdout only; `settings.json` is read at most once per tick for this, and once more when a scan has found a program that no earlier scan found, not for every line). The programs found in `settings.json` stay in force until the guard is restarted: a file that cannot be read (a rewrite in progress, a broken edit) does not open a write, and neither does a rewrite that removes an entry, since a running session keeps the entry it loaded (so a program that was once named there cannot be the state, pause or log file of the guard until it is restarted); the wiring check warns that the file cannot be read. A guard that has not read the file to its end even once since its start (it is damaged at that moment) writes nothing, naming the file in the error, until one read succeeds (the next tick after the file is repaired); a settings file that does not exist is a read that succeeded, with no hook in it. `add` refuses a value of the wrong type for the keys `state_file`, `log_file` and `usage_cache` as the guard does, and treats the bundled hook and the entry module as protected files even when another hook is registered. Neither the guard nor the hook reads a document larger than 1 MiB (the pause file, the state file, the usage cache, the configuration and `settings.json`): a mistaken path or a file replaced by a huge one is read like a document that cannot be decoded, not to its end. The guard and the hook append to their logs without following a symbolic link at the last component and only to a regular file (a link
in a shared directory cannot redirect the write; where Python has no `O_NOFOLLOW`, on Windows, each of them refuses a path that is a link or a reparse point before it opens the log). The guard removes the pause file on SIGTERM and SIGINT and on every orderly exit (also when an earlier removal of the file failed and is still
pending, or when the removal that the stop itself makes fails: the stop tries it once more; and also when the unpaused state cannot be written at that moment: the file goes anyway, the stored pause stays and a restart keeps it only while it lasts), so a stop or a restart (also
`systemctl --user restart`, which a change of `exclude` needs) releases the waiting sessions. The restarted guard brings
the pause back from its first fresh reading of the cache, within one check; when the cache is stale at that moment the
sessions run until a fresh reading shows the threshold. After a crash (SIGKILL, an uncaught exception) the state file
keeps the pause: the restarted guard resumes it (and checks the hook entry first, as at any start; while a pause lasts the entry is checked again, at most once per
`--warn-every` seconds, so a hook removed meanwhile is reported), and when it does not come back the pause file lapses within
`--heartbeat` seconds.

At start the guard checks that the directories of `pause_file` and `state_file` exist and can be written to (status 2
otherwise). A write that fails later (the directory is removed, the disk is full) is logged as `ERROR` and tried again at
the next check; the guard keeps running. A reset time more than 5 h 15 min ahead is not believed (a window is five
hours): `WARNING (reset-too-far)` and no pause.

One guard per state file and one per pause file: a second guard with the same `state_file` or the same `pause_file` stops with
status 2 (it takes an exclusive lock on `<state_file>.lock` and on `<pause_file>.lock`, empty files next to those files; on Windows, where Python has no `fcntl`, the same files are locked with `msvcrt.locking`; only a platform with neither has no lock). A running guard looks at every tick, and before it publishes a pause, whether each lock file still is the file it holds the lock on. When cleanup or another process removed or replaced one, the guard locks the file that is at the path now and goes on; when another guard holds it already, this guard logs that, publishes and removes no pause, and stops with status 1 (the pause file is left to its heartbeat; the service manager starts the guard again); when the path cannot be opened (its directory is gone) the tick fails like a write that fails and the next tick tries again. At start the guard removes a pause file nobody owns, but refuses to start (status 2) when the existing file is not a pause file of this
guard (a mistyped `pause_file` must never delete another file; a symbolic link there, dangling or pointing at a valid pause document, counts as such a file and is left alone; the file is looked at again right before it is removed, so one that appeared or changed since the start check is kept, and the start stops with status 2; the path is then moved aside in one step and what was moved is compared with what was looked at, so a file that took its place in between is put back by a hard link (where links are not supported, or when another file is at the path by then, it is kept under its new name and the log says so, because a rename back would replace a file that comes in that very instant) and never removed (the name it is moved to is new every time, so a file that was kept under one earlier is never replaced); the guard and the hook open the pause file without following a link and check the opened descriptor, so a regular file swapped for a link between the look and the read is not read through the link), and relies on the lock on `<pause_file>.lock` to tell a running guard from a leftover (a pid in the file proves nothing: it can belong to an unrelated process after a crash; only on a platform with no lock at all the pid and a current heartbeat decide, at the start, again before every publication of a pause and again before the pause file is removed: a guard that finds the pause of another running process publishes nothing, removes nothing and stores no state of "not paused" under it). Two guards must not share one `pause_file`: with different state files they would overwrite each
other's pause (the lock on the pause file stops the second one).

### The hook never wedges a session (fail-open)

| Situation | Result |
|---|---|
| no pause file | the shell guard of the hook command exits 0 without starting Python (2 to 4 ms per tool call, measured on a loaded machine) |
| `python3` or the hook file named in the entry is missing, or the hook file is not readable (Python would exit 2 on a script it cannot open) | the same shell guard exits 0; `check` ends with status 1 and names the file, and a guard with `settings_file` set names it in a `WARNING` at start and while it pauses |
| pause file is a symbolic link (whatever it points to: it could be the live pause of another guard), unreadable, not JSON, not an object, lacks a numeric `since` or an integer `pid` (the guard would not own it), or `paused` is not the JSON value `true` (`"false"`, `1` and `"true"` are not) | the tool call passes |
| the pause file is larger than 1 MiB (the guard writes about 200 bytes plus `exclude`, which it keeps under 64 KiB; the hook reads at most 1 MiB plus one byte, so a mistaken path that holds a huge file does not stall the call) | the tool call passes |
| `valid_until` or `resume_at` missing, not a JSON number (a string or a boolean is not one), NaN or infinite; `exclude` or `only` present and not a list of strings | the tool call passes |
| `valid_until` in the past (the guard is dead: it renews the file every tick) | the tool call passes |
| `valid_until` more than 3600 s ahead, or `resume_at` more than 21600 s ahead (the guard writes `valid_until` at most 1800 s ahead and believes no reset time further than 5 h 15 min, plus a margin of at most 1800 s) | the tool call passes |
| `resume_at` more than 900 s in the past | the tool call passes |
| the hook runs longer than its `timeout` in `settings.json` (21600 s, longer than a window plus margin) | Claude Code cancels the hook and, on `PreToolUse`, the tool call goes on, according to its [hooks documentation](https://code.claude.com/docs/en/hooks) ("Timeouts", read on 2026-11-21) |
| the session id starts with a prefix of `exclude` | the tool call passes |
| the pause file has no `v` equal to the integer 2 (the version the guard publishes) | the tool call passes |
| the pause names `only` prefixes and the session id starts with none of them | the tool call passes |
| `ANTHROPIC_BASE_URL` is set to a host outside `anthropic.com`, or `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_USE_FOUNDRY` is `1` or `true` (any case), or the model of the session is a Bedrock or Vertex model id (the rule of `src/config/models.ts`: the first of `CLAUDE_MODEL`, `ANTHROPIC_MODEL` that is not blank decides; only when neither is set, the tier variables `OMC_MODEL_MEDIUM`, `OMC_MODEL_HIGH`, `OMC_MODEL_LOW` and their `CLAUDE_CODE_BEDROCK_*_MODEL` and `ANTHROPIC_DEFAULT_*_MODEL` counterparts; an id such as `us.anthropic.claude-sonnet-4-6-v1:0`, `anthropic.claude-...`, an inference-profile ARN of a Claude model, or `vertex_ai/...`), or `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is not blank | the tool call passes: that session does not use the Anthropic subscription window. The hook sees only the environment of the session: a session that has `ANTHROPIC_API_KEY` set but runs on the subscription (the key was declined at the prompt) is not held either, so leave the variable unset in subscription sessions you want to protect |
| any exception inside the hook | exit 0 |

A dead guard therefore releases the sessions within `--heartbeat` seconds (300 by default, more with a long `--interval`, 1800 at most), and a pause file
written with absurd times holds nobody for longer than 6 hours.

## Input: the usage cache

The guard reads the file that OMC's usage monitor writes (`src/hud/usage-api.ts`):

```
<CLAUDE_CONFIG_DIR, else ~/.claude>/plugins/oh-my-claudecode/.usage-cache-anthropic.json
```

This is the default of `usage_cache`. Fields used:

| Field | Meaning |
|---|---|
| `timestamp` | milliseconds since the epoch of the last write of the entry |
| `source` | the provider of the entry; an entry whose `source` is not `anthropic` (another provider's cache) is not acted on (`cache-source`); OMC always writes it |
| `data.fiveHourPercent` | utilization of the five-hour window, 0 to 100 |
| `data.fiveHourResetsAt` | end of the window, an ISO 8601 string |
| `error`, `rateLimited`, `lastSuccessAt` | a refresh that failed or was rate limited rewrites the entry with a fresh `timestamp` but keeps the old `data`; the age of the data is then counted from `lastSuccessAt` (milliseconds), and from `timestamp` otherwise |

While the usage API answers with a rate limit, OMC waits longer before each next try, up to 5 minutes, and the data keeps its age
since the last successful fetch: it grows older than `--max-age` (180 s), and the guard does not act on it (`cache-stale`) until a
fetch succeeds. A larger `--max-age` keeps the guard acting on older data through such a stretch, at the price of acting on a
percentage that old. The API can also answer without the five-hour window for a while; the cache then has no
`fiveHourPercent` and the guard holds nothing until it returns (`cache-no-percent`).

Who keeps the file fresh: only two parts of OMC write it. The OMC status line (HUD) refreshes it while it renders, at
most once per `usageApiPollIntervalMs` (90 s by default), and only when it is set up as the Claude Code `statusLine` and
does not hide rate limits (`elements.rateLimits` is not `false`; the `opencode` preset hides them). The `omc wait`
daemon polls it every minute. The guard does nothing when the cache is older than `--max-age`, so keep `--max-age`
above the poll interval; a longer poll interval needs a larger `--max-age`. Where this does not work, the guard does
nothing and the hook lets everything through:

- the status line is not set up or does not show rate limits, and no `omc wait` daemon runs;
- an account without a five-hour window (an API key): the cache has no `fiveHourPercent`;
- a session routed to another provider writes another cache file (`.usage-cache-<provider>.json`), which this guard does
  not read.

The guard does not stay silent about it: at start, and then at most once per `--warn-every` seconds (600) for each kind of
problem, it logs a `WARNING` when the cache does not exist (`cache-missing`), cannot be read (`cache-unreadable`), is
older than `--max-age` (`cache-stale`), has no `fiveHourPercent` (`cache-no-percent`), or shows a percentage that is not a percentage (`cache-invalid-percent`: not a JSON number, not finite, below 0 or above 100), a timestamp more than two minutes ahead (`cache-future`), a high percentage with no reset time
(`reset-missing`) or a reset time that is not believed (`reset-too-far`). OMC rewrites the cache in place, so a read that finds an empty or half-written document is repeated up to 5 times, 0.1 s apart, before the cache counts as unreadable. Read the log once after you start the guard.

## Requirements and platforms

- `python3`, standard library only; the scripts run as `python3 -I`. Their syntax parses with the Python 3.7 and 3.8
  grammars; they were run and tested with Python 3.14 only.
- The hook entry is a shell command line (`[ -f ... ] && ... || exit 0; exec python3 ...`). Claude Code runs it with
  `sh -c` on Linux and macOS and with Git Bash on Windows, and with PowerShell when Git Bash is not installed (its hooks
  documentation, read on 2026-11-21). The entry needs a POSIX `sh`; how it behaves under PowerShell was not checked.
- Tested on Linux. The guard and the hook send no signals to other processes. The renewal of the pause file and the replacing
  of the state file use an exchange of two paths in one step (Linux `renameat2` with `RENAME_EXCHANGE`, so that the path is
  never empty and a file that came in late is never destroyed): where the system, the C library or the file system has none
  (macOS, Windows, some network file systems) they use a plain replace after one more look at the file, which is atomic for
  one file, and a program that comes in at that path in the microseconds between the look and the replace is replaced. Only
  the plain replace was tested, on Linux, by making the exchange unavailable, together with the repetition of a replace that is refused
  with an access error, by making the replace refuse; Windows and macOS themselves are not tested.
- The unit file is for Linux with systemd. It is an example, not a requirement: any way to keep a process running
  works.

## Install

1. Get the scripts from a clone of the repository (`git clone https://github.com/Yeachan-Heo/oh-my-claudecode`,
   directory `tools/five-hour-guard/`): `tools/` is not in the npm package (it is not in the `files` list of
   `package.json`). Copy the three scripts, `five_hour_guard_entry.py` and, if you want the unit, `five-hour-guard.service` to a stable directory,
   for example `~/.claude/five-hour-guard/`. Do not point the hook entry into the plugin cache: that path changes with
   each plugin update, and a hook entry that names a missing file lets every call through.
2. Write the configuration file, for example `~/.claude/five-hour-guard/config.json`. All paths should be absolute.

   ```json
   {
     "pause_file": "/home/me/.claude/five-hour-guard/pause.json",
     "state_file": "/home/me/.claude/five-hour-guard/state.json",
     "log_file": "/home/me/.claude/five-hour-guard/guard.log",
     "hook_log_file": "/home/me/.claude/five-hour-guard/hook.log",
     "settings_file": "/home/me/.claude/settings.json",
     "exclude": []
   }
   ```

   | Key | Default | Meaning |
   |---|---|---|
   | `usage_cache` | the OMC cache file above | usage cache the guard reads |
   | `pause_file` | required | file the hook reads |
   | `state_file` | required (not with `--test-pause`) | guard state |
   | `log_file` | none (stdout only) | guard log |
   | `hook_log_file` | none (the hook does not log) | hook log, an absolute path (the guard refuses a relative one at the start, as `add` does); used by the settings tool |
   | `settings_file` | none | `settings.json` the guard checks for the hook entry, with a loud warning in its log when it is missing |
   | `exclude` | `[]` | session id prefixes whose tool calls are never held |
   | `pause_command` | none | a program (absolute path) and its arguments, run for as long as a pause lasts (see "Other work during a pause") |

   The configuration file comes from `--config <file>` or the `OMC_FIVE_HOUR_GUARD_CONFIG` variable. A command line option
   of the same meaning wins over the file. No path is built into the scripts except the default of `usage_cache`.
3. Register the hook (it is safe to do this before the guard runs: without a pause file the hook does nothing):

   ```
   python3 -I ~/.claude/five-hour-guard/five-hour-guard-settings.py add --config ~/.claude/five-hour-guard/config.json
   python3 -I ~/.claude/five-hour-guard/five-hour-guard-settings.py check --config ~/.claude/five-hour-guard/config.json
   ```

   `add` and `remove` write a timestamped backup next to `settings.json` and then replace the file atomically. The
   temporary file and the backup are created readable by the owner only and get the mode of the original before any
   content is written. The rest of the file is kept as it is; a hook of another tool, also in the same group, stays (in
   a group of its own with its matcher). `add` twice changes nothing. `add` with another hook path replaces the entry in
   place (an entry that carries the marker, or one that `add` wrote for the same pause file, see below). `add` refuses paths that are not absolute, a hook or interpreter file that does not exist, an interpreter that is not
   executable or cannot run the hook (it is tried once: Python 3 with the standard library), a hook that does not hold a pause (`add` runs the entry it is about to write, through the shell, against a pause of its own (and, when no hook log is set, once more without `--log`, the shape that is installed then) in a private directory: the command is the one that is installed, with nothing added, apart from the paths of the pause and the log; the hook must keep holding for a moment, and exit 0 when the pause is removed), two of the pause file, hook log,
   `settings.json`, hook, interpreter, configuration file and the two scripts that are one file (exit 2). No command is analysed. The entry that `add` writes ends with the comment `# five-hour-guard-entry` (a comment to the shell, ignored by it), the marker; the tool takes a handler for the entry of the guard when its command ends with the marker after a blank (trailing blanks and new lines do not count; the same text in quotes or in the middle of a command, as data, is no marker, and so is one after a blank that a backslash escapes, `foo\ # five-hour-guard-entry`, where the shell reads the `#` as part of a word), or its command is word for word the one that `add` writes, or wrote in an earlier version, for the same pause file with a `five-hour-guard-hook.py` in another directory (an installation somewhere else, also without the marker), or holds the exact path of the hook (`--hook`, by default the hook next to the tool) as a whole word of the command (a blank or an operator of the shell on each side, or the same quote on both sides of it, so `hook.py+audit`, `x=hook.py` and `'hook.py'+audit` are other files, and so is `foo\ hook.py`, where a backslash makes the blank in front of the path part of the word; a quote that opens in front of the path and stays open holds the text of a command only after `-c`, `sh -c 'hook.py --pause-file p'`, so `printf '%s\n' "hook.py is data"` is data of another tool), which is how the entries that earlier versions of `add` wrote are found (`add` replaces them in place with the new form, so the hook runs once). A handler that has none of these is never replaced or removed, whatever its command does: another tool's `node --check hook.py.js`, `python3 --version hook`, `printf hook --pause-file p`, or an entry written by hand with another path and no marker. `check` says so when a command names the hook file but has no marker, and prints the entry to paste. So an entry that `add` wrote for this pause file is replaced in place also after the scripts moved to another directory, and the guard started from there takes it for its own entry instead of the hook of another tool that names its pause file. An entry written by hand, or one of another shape, whose hook path differs from the `--hook` of the `add` that follows is not found, and `add` appends a second entry: remove the old one first, or add the marker to it. `check` ends with status 1 also when an entry of the guard runs a hook or an interpreter that is missing (the command ends with status 0 then, so every call passes), and prints which one. A handler of another tool that holds the exact path of the hook, or the marker, as a word is taken for ours. The usage cache counts as a configured file also when `usage_cache` is left out (OMC's default file and its
   `.lock`). The
   entry has a `timeout` of 21600 s (`--timeout`, a finite number of at least 21600: a shorter one is refused, since Claude Code would cancel the hook during a long pause and the tool call would go on, and so is an integer too large for a float), longer than any window. A `settings.json` that is a symbolic link is
   written through: the file it points to is replaced, the link stays a link (the backup sits next to the link). When
   another program writes `settings.json` while the tool works (also while the backup is made), the tool reads it again
   once and then gives up (exit 2, nothing written); a change of the content, of the modification time or of the file mode counts, so a mode that another program tightened is kept. A write inside the instant between its last comparison and the
   rename cannot be told apart by any tool, since a rename has no compare-and-swap; run `check` after `add` to see the
   result. Without a `settings.json`, `add` creates it (the
   directory has to exist; mode 0600), `remove` has nothing to do and `check` reports "not installed" (exit 1). The
   default path is `$CLAUDE_CONFIG_DIR/settings.json` (blanks removed, a leading `~`, `~/` or `~\` expanded, as the guard and OMC do),
   else `~/.claude/settings.json`. Claude Code keeps the hook snapshot a session started with, so restart each session
   that is already running after `add` (a running session also keeps the entry after `remove` until it is restarted;
   without a pause file that costs nothing); only sessions started afterwards load the new entry.
4. Check the installation without waiting for a real limit (see "Try it").
5. Run the guard.

### Run the guard

As an ordinary background process:

```
nohup python3 -I ~/.claude/five-hour-guard/five-hour-guard.py --config ~/.claude/five-hour-guard/config.json >/dev/null 2>&1 &
```

As a systemd user service on Linux: fill the three `@...@` values of `five-hour-guard.service` (they stand inside double quotes in the
`ExecStart` line, so a path with a space works; write a `%` of a path as `%%`), install it as
`~/.config/systemd/user/five-hour-guard.service`, then

```
systemctl --user daemon-reload
systemctl --user enable --now five-hour-guard.service
```

A user unit starts at login; `loginctl enable-linger <user>` starts it at boot. The unit restarts the guard on failure
but not on a configuration error (exit status 2). A user unit does not see `CLAUDE_CONFIG_DIR` of your login shell: with
a Claude Code configuration directory other than `~/.claude`, set `usage_cache` in the configuration file or uncomment
the `Environment=CLAUDE_CONFIG_DIR=` line of the unit.

### Try it

`--test-pause` writes a pause file for a few seconds without reading the usage cache or touching the state file, then
removes it (a stop before the end removes it at once; a removal that fails is tried five times and then reported as an error with exit status 1, the sessions being released when the file lapses). With `--test-only` only the sessions whose id starts with one of the given prefixes wait, so a try does not
stop your other sessions:

```
python3 -I ~/.claude/five-hour-guard/five-hour-guard.py --config ~/.claude/five-hour-guard/config.json --test-pause 20 --test-only <session id prefix>
```

While it runs, a tool call of that session (started after `add`) waits (the hook log shows `hold-start` and `hold-end` when `hook_log_file` is
set). The test refuses to start when the pause file already exists, and it removes the file at its end only when the file
is still its own. `--dry-run` runs one check and logs what the guard would do without writing anything:

```
python3 -I ~/.claude/five-hour-guard/five-hour-guard.py --config ~/.claude/five-hour-guard/config.json --dry-run
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `--config <file>` | `$OMC_FIVE_HOUR_GUARD_CONFIG` | configuration file |
| `--cache`, `--pause-file`, `--state`, `--log`, `--settings`, `--exclude` | from the file | the keys above (`--exclude` takes comma separated prefixes; `--settings ""` turns the hook entry check off) |
| `--threshold <percent>` | 97 | pause at or above this five-hour percentage; above 0 and at most 100 |
| `--resume-below <percent>` | threshold minus 10, but at least half the threshold | resume early when a fresh cache shows less; from 0 up to the threshold (a higher value would enter and leave the pause on alternate ticks). The default never falls to 0 or below, which no percentage can undercut (a threshold of 10 or less would otherwise never end a pause early); an explicit 0 turns the early resume off |
| `--max-age <seconds>` | 180 | data older than this is not acted on; at least 1 |
| `--margin <seconds>` | 150 | resume this long after the reset time; 0 to 1800 |
| `--interval <seconds>` | 30 | seconds between checks; at least 0.1 |
| `--heartbeat <seconds>` | 300, or twice `--interval` plus 1 s when that is more | validity of the pause file after each check, which is how long a dead guard keeps sessions waiting; from twice `--interval` plus 1 s (one missed check must not release the sessions, and a failed check takes time before the retry) up to 1800, so `--interval` is at most 899.5 (a longer interval is refused, as no heartbeat can cover it); the next check is scheduled from the start of the previous one |
| `--warn-every <seconds>` | 600 | at most one `WARNING` about the usage data, a hook command that is not read to its end or `pause_command` per this many seconds and kind; 0 for every check, up to 86400 |
| `--test-pause <seconds>` | off | hold sessions for a while, then release; up to 1800 |
| `--test-only <prefixes>` | all | with `--test-pause`: only sessions with these id prefixes |
| `--once` | off | one check, then exit without cleaning up a pause that check started (tests) |
| `--dry-run` | off | log what would happen and write nothing |

A configuration error (a missing required key, a wrong type, a number that is not finite or outside its range, a
directory of the pause or state file that is missing, a `pause_file` that is not absolute, a `pause_file` or `state_file` that is not a regular file (a directory), two configured files (`pause_file`, `state_file` and its `.lock`, `usage_cache`,
`log_file`, `settings_file`, the configuration file itself, the scripts of the guard, hook and settings tool, the hook, interpreter or other launching program and `--log` file named by the registered entry, the programs that the commands of other hooks run, and the lock files `<state_file>.lock`, `<pause_file>.lock` and `<usage_cache>.lock`) that are one file by path, symbolic link or hard link; the only pairs that may be one file are the bundled hook and the registered hook, an interpreter named by two entries, a program of another hook that is one of the programs above (the same interpreter), and a hook run directly, which is its own launcher by the same path: a hook that is a link to the interpreter, the entry module or another script of the guard is refused, and the wiring check reports the same collisions after the start)
exits with status 2. A state
file that does not have the shape the guard writes (times that are not positive or are more than 6 hours ahead included) is ignored: the guard starts without a pause. A file at `pause_file` is removed as a leftover only when it has the full shape the guard publishes (`v` 2, `paused` true, `pid`, `since`, `resume_at`, `valid_until`).

## Which sessions load the hook

Only a session that read the `settings.json` holding the entry when it started waits in the hook. The headless sessions
that OMC starts, factory chain links and `omc ralph afk`, pass `--setting-sources project,local` by default and so do
not load user-level hooks (`docs/REFERENCE.md`, "Headless factory and AFK settings"); with the default installation into
`~/.claude/settings.json` they go on issuing tool calls during a pause. To hold them either set
`OMC_AFK_INCLUDE_USER_SETTINGS=1` in the environment that launches OMC (the same document explains the trust this
asks for: user-level hooks then run in unattended sessions), or register the entry in the settings of the project with
`five-hour-guard-settings.py add --settings <project>/.claude/settings.local.json`.

## Session exceptions

`exclude` lists session id prefixes whose tool calls are never held. Use it for a session that has to stay able to
answer during a pause, for example the one in which you stop the guard. Without it a held session cannot run the command
that would release it. Prefixes are matched against the `session_id` that Claude Code puts in the hook event. A change
of `exclude` in the file takes effect when the guard is restarted (a call that is already held is released as soon as it reads the new pause document that excludes it). Sessions routed to another provider are never held
(see the table above).

## Other work during a pause

The hook holds the tool calls of the sessions that load it. Work that spends the same window outside those sessions (a pool of
background workers, a scheduled job) goes on unless you stop it yourself. `pause_command` is the way to do that, off unless
you set it:

```json
"pause_command": ["/opt/tools/hold-workers", "--pool", "nightly"]
```

The list is the program (an absolute path of an executable file) and its arguments; no shell reads it. The guard starts it when a
pause begins, once the pause file is published (also after a restart that finds a stored pause), with a pipe as its standard input, and expects it to keep running
and to hold whatever it holds. The pipe is closed when the pause is over, when the guard stops, and by the system when the guard
dies in any way, so a program that ends at the end of its input never outlives the guard's pause. A program that is still running
5 seconds after that is terminated, and killed 5 seconds later; only the process the guard started is signalled, so a program that
starts others ends them itself. The guard ends the program also when the state file cannot be written at the end of a pause: the pause
file is then not renewed and the sessions are released when it lapses. A program that ends while the pause lasts is started again at the next check
(`WARNING (pause-command-ended)`), and one that cannot be started is `WARNING (pause-command)`: neither stops the pause. The first
start in a pause is logged as `pause_command started`; a later start in the same pause is `WARNING (pause-command-started)`, limited by
`--warn-every` like the other warnings. Its output goes to the output of the guard. No word of the list may be a file the guard writes (the pause file may be named, to be read).
`--dry-run` and `--test-pause` do not run it. A configuration with a `pause_command` that is not such a list stops the guard at start
(exit status 2).

## Order of events when a pause ends

The guard writes the state file (unpaused) first and removes the pause file after. If the state cannot be written, nothing changes: the pause stays in force and the next check tries again. If the pause file cannot be removed after the state was written, the removal is retried at every check and, after a restart, as a leftover (a start that cannot remove it stops with status 1 and is started again by the service manager).

## Stop and emergency release

- Stop the guard: send SIGTERM (`kill <pid>`, or `systemctl --user stop five-hour-guard.service`). It removes the pause
  file and exits, and the waiting tool calls continue. Until you start it again the guard does not protect the limit; a
  restart brings the pause back from the first fresh reading of the cache.
- Run the stop command from a terminal outside the held sessions: in a held session the command itself waits.
- Removing the pause file by hand lets the sessions go for one check at most: a running guard writes it again on the
  next tick. It helps when the guard is dead, and then the sessions are released after `--heartbeat` seconds anyway.
- Remove the hook entry:

  ```
  python3 -I ~/.claude/five-hour-guard/five-hour-guard-settings.py remove --config ~/.claude/five-hour-guard/config.json
  ```

## Limits

- The percentage comes from the cache, which is as fresh as the status line or the `omc wait` daemon makes it: a pause
  can start up to a poll interval and a check interval late, and the window can reach the limit before the guard acts.
- A session stops spending at its next tool call, after at most one more model response: the hook is asked before a tool call, not before a
  request, so a prompt that Claude answers without calling a tool is not held (no `PreToolUse` event fires for it). The guard does not hold
  the prompt of the user either: a hook on `UserPromptSubmit` would keep every prompt unsent for as long as it waits.
- The pause ends at the reset time plus `--margin`, or earlier when the cache shows a lower percentage. A cache that is
  stale at that moment ends the pause at `resume_at` (fail-open).
- Not checked: whether the OMC status line keeps refreshing the usage cache while every session waits in the hook. The
  early resume and the extension of a pause need a fresh cache; a running `omc wait` keeps it fresh in any case.
- Only the Anthropic five-hour window is watched. The weekly limit is not.
- The unit file is Linux only. The scripts were tested on Linux only.

## False alarms

The guard refuses to write its state, pause or log file when any word of the command of another hook (any event, or the status
line) in `settings.json` names that file, because it cannot know what a command does with a word: a program that the command runs
could be replaced by the next write. The rule is deliberately wide. It does not tell what any word of the command means, so no interpreter, wrapper or option is
missed, and the price is false alarms: a command that only names the file as a plain argument (`tail -n 5 /opt/guard/guard.log`), as the value
after `=` (`--output=/opt/guard/guard.log`, `FOO=/opt/guard/guard.log cmd`), inside a quoted word (`sh -c 'echo /opt/guard/guard.log'`), or as the text after
`printf` or `env --help`, is refused like a program would be. A word without a directory part is also looked for in each directory that another word of the same command names, so a file of the guard named like a bare word of a command that names that directory (`cd /opt/hooks; ls`, `tail -n 5 /opt/hooks`) is matched too; where such a word stands in a simple command that runs something, the rule on bare words below applies to it. Where the command does not move its working directory (no `-C`, `--directory` or `--chdir` option in front of the word that the simple command runs, as in `env -C DIR prog`, where the wrappers that the scan knows are `exec`, `command`, `env`, `time` and `nohup` (after the word it is an argument of the program, `python3 ./audit --chdir /tmp`, and so is a `cd` that is only an argument, `echo cd`; with another wrapper, `nice -n 5 env -C DIR ./audit`, the scan keeps the directory of the session as a candidate and a false alarm is possible), and no simple command that runs `cd` or `pushd` before it in the same chain of commands, joined by `;`, `&&` or a new line: a `cd` in a subshell, before a pipe, in the background or before `||` moves nothing after it, as `(cd /tmp); python3 ./audit` shows, a `cd` that stands after `then`, `else`, `elif`, `do` or `case` moves nothing either, since it may not run (`if false; then cd /tmp; fi; python3 ./audit` runs the file of the directory of the session; a false alarm where the branch runs), a directory that is only an argument, `python3 ./audit /opt/hooks`, is no move, and neither is a `cd`, `pushd` or `-C` whose target the scan cannot know, `cd "$DIR/other"; ./audit` with `DIR` only in the session, nor one whose target is a relative path, `cd child; ./audit` or `env -C child ./audit` (it is run from a directory that is not known, so only an absolute target moves), which also takes back an earlier move, `cd /opt/hooks; cd child; ./audit`: the path is then also checked against the directory of the session, and a false alarm is possible), a relative path (`./audit`, `sub/audit`) and a word without a directory part that stands in a simple command that runs something (the word after assignments, keywords and `exec`, `command`, `env`, `time` or `nohup` with their options is the program; any other bare word may be an operand that another wrapper runs, `timeout 5 audit`, `nice -n 5 audit`, `sudo audit`, so every bare word counts, and `echo audit` or `python3 audit` with the name of a file of the guard is a false alarm too) and no `PATH=` word in front of the program in its own simple command (`PATH=dir true; audit` gives `true` that PATH, not `audit`, and in `audit PATH=/safe` the word after the program is an argument, no PATH), no PATH that stands alone (`PATH=dir; audit`) and no `env` of `settings.json` gives a PATH (when one does, only a program found in no directory the guard looks in, its own `PATH`, that PATH and the directories the command names, is refused, and so is one when a component of that PATH holds a variable that nothing gives a value to, `PATH=$DIR:$PATH audit` with `DIR` only in the session, or `PATH=/x:$PATH audit` where no `env` of `settings.json` and no assignment before it gives a PATH: that `$PATH` is the one the session has, not the one of the guard) count as a command that is not read to its end when they end the path of, or are the name of, the state, pause or log file or one of their locks: a session runs the first from its own working directory and looks the second up on its own `PATH`, and the guard knows neither, so a file that the guard finds on its own `PATH` does not tell which one runs the way out is an absolute path or a `cd` in the command, a `PATH` in the `env` of `settings.json`, or own names for the files of the guard (below). Such a command does not stop the guard: see "A command that is not read to its end". Where a word names such a file in a command that is read to its end, the guard does not start (a path named at the start, exit 2)
or stops writing to that file and logs the collision with the name of the file and "program of another hook".
The hook entry of the guard itself is read the same way: a word of its command that the entry the guard generates does not have (a hook, interpreter or log of another path) is a file it names, which may not be a file of the guard; the way out is the entry that `add` writes without `--hook`, `--python` or `--hook-log` of other paths. The log of the entry is protected too, for an entry that carries the marker: the guard reads the words after `-I` or `--hook` (the hook), `exec` or `--python` (the interpreter) and `--log` in it, and refuses to start, or to publish a pause, when the log is the hook or interpreter of that entry, any other word of the entry that names a file (a script given by position, an argument), or a file of the guard; a hand-written entry without the marker is not read this way (its words are protected like any other command), and `check` warns that no entry has the marker. A command that the guard cannot read to its end (more than 65536 characters, 4096 words, 4096 named files (a pattern counts the files it matches), quoted commands nested three levels deep, or one of the constructs below) does not stop the guard: see "A command that is not read to its end".
Only the files that the guard writes are protected this way: the state, pause and log files and the lock files of the state and pause files. The settings file, the configuration file and the usage cache (with its lock), which many hooks name and the guard only reads, do not stop the guard when the command of another hook names them.

The way out is to give the guard paths of its own that no other hook command names: set `state_file`, `pause_file` and `log_file` in
the configuration file to files with names used by nothing else (for example `guard-own.state`, `guard-own.pause` and
`guard-own.log` in a directory of the guard), and register the hook entry with `add` for that pause file. The alarm ends at the next
tick.

A command with a command substitution (a dollar sign and a parenthesis, or a backtick), an arithmetic expansion (`$((...))`, or the old `$[...]` of Bash) or a special parameter without braces (`$?`, `$$`, `$!`, `$#`, `$*`, `$@`, `$-`: the status of the last command, the PID of the shell, the PID of the last job, the number of arguments, the arguments, the options of the shell) outside single quotes and not after a backslash, with a control sequence (a backslash and `c`) in a Bash quote `$'...'`, or with an apostrophe or a double quote in the pattern of a cutting form (`${NAME%pattern}`, `%%`, `#`, `##`, as in `"${A%'.py'}"`, where the shell removes the quotes of the pattern) or with a parameter in that pattern that nothing gives a value to (`"${A%$B}"` where the command and the `env` of `settings.json` give no `B`: the session may have it, and what is cut is not known), or with an extended glob pattern outside quotes (`@(a|b)`, `?(a)`, `*(a)`, `+(a)` or `!(a)`, which Bash expands where `extglob` is on: `bash -O extglob`, `shopt -s extglob` on an earlier line, `BASHOPTS` in the environment; it is refused where the option is off as well, where Bash gives a syntax error, and a false alarm is such text as an unquoted argument or in a quoted command, `sh -c 'echo +(x)'`; a quoted pattern is text), or with the name of a shell option that changes what a glob pattern matches (`nocaseglob`, `dotglob` or `globstar`, which `bash -O nocaseglob`, `shopt -s dotglob` or `BASHOPTS` turn on; the name anywhere in the text is enough, so is a value of `BASHOPTS` in the `env` of `settings.json` that names one of them, for every command, and a false alarm is such text as an argument), or with a builtin that assigns to a variable it is given by name (`printf -v NAME`, `read`, `let`, `mapfile`, `readarray`, `getopts`, and `declare`, `typeset` or `local` with `-n`: what the variable holds afterwards is known only to the shell that runs it; a false alarm is such a command that does not touch a variable the scan needs), or with an append assignment (`NAME+=value` at the start of a word outside quotes, which adds to the value that NAME has: `A=/x/audit; A+=.py; python3 "$A"` runs `/x/audit.py`; a false alarm is such text as an argument, `echo a+=b`), or with a parameter expansion that the scan does not model (a replacement `${NAME/x/y}` or `${NAME//x/y}`, a change of case `${NAME^}` or `${NAME,}`, a transformation `${NAME@Q}`, an indirection `${!NAME}`, a slice `${NAME:1:2}`, an array `${NAME[0]}`; the plain `${NAME}`, `${#NAME}` and the operators `-`, `=`, `+`, `?`, `%` and `#` are modeled, and braces without a dollar are no expansion) is a command that is not read to its end too. These ten, and the conditional one that follows, are the only exceptions to the rule that a variable that nobody knows is no reason to refuse and stays as written: a variable to which the `env` of `settings.json` and the command give no value at that place (an assignment in front of a command, `A=x cmd` or `env A=x cmd`, is that command's alone, so `FHG_S=.old true; python3 audit$FHG_S` runs `audit`, and `unset A` takes a name away; an assignment that stands alone, or one after `export`, `declare`, `typeset`, `readonly` or `local`, holds from the next word on, but only where the shell has made it, that is when its simple command stands first or after `;` or a new line and no pipe or `&` follows it, so `"$A"; A=/x` runs the `A` of the session and `A=/x; "$A"` does not, and so do `false && A=/x; "$A"`, `(A=/x); "$A"`, `A=/x | cat; "$A"` and `A=/x & "$A"` (an assignment after `&&` is read as not made, which is a false alarm when the command in front of it succeeds), and `unset A` takes the name away from the next command on; `${A:=x}` holds from the word after it, on the same condition; the operators around the command are read, and so are the words `then`, `else`, `elif`, `do` and `case`, but no reachability and no other word of control flow: from the first of them on no assignment settles a name, because the branch or the loop body may not run and the command does not tell where it ends, so `if false; then A=/x; fi; "$A"` and `case x in y) A=/x;; esac; "$A"` run the `A` of the session, and an assignment after the `fi` or `done` that closes the branch counts as not made too (a false alarm when it is made; an assignment before the branch still counts), while functions and groups in braces are not read; a quoted command gets the assignments of its own simple command; what the guard has in its own environment does not count: it stays one more candidate, because the session may have none or another value, as a session of another profile has another `HOME` for `$HOME` and a leading `~`) makes the command one that is not read to its end when it is the whole word, or when what follows it in the word ends the path of the state, pause or log file or of one of their locks (`"$AUDIT"`, `$DIR/audit`, and `"${AUDIT:-/tmp/x}"` too: a default, assigning or error operator, `-`, `:-`, `=`, `:=`, `?` or `:?`, does not settle the name, since the shell uses the value that the session has), and the word is read as before when something else follows it (`"$CLAUDE_PROJECT_DIR"/tools/x.sh`, `"${CLAUDE_PLUGIN_ROOT:-x}"/scripts/y.mjs`); the way out is an absolute path, a `cd` in the command, a value in the `env` of `settings.json` or own names for the files of the guard. The result of a program, of an arithmetic expression, of a control sequence, of a pattern whose quotes the shell removes, of an extended glob pattern, of a shell option that changes what a pattern matches or of an expansion that the scan does not model cannot be known to the scan, and it can name a file (`python3 "/dir/a$((1+1))"` runs `/dir/a2`), so a file of the guard that such a result names would be replaced without a warning, while an ordinary variable that the guard does not know is left as it is, because hooks often use variables that the guard cannot know. These ten do not depend on the paths of the guard, so own files do not end them: removing the construct from the command of the hook (compute the path in a script, or write it out) brings the full protection back. The same holds for the text of a quoted word that is read as a command (`sh -c '...'`), also where it is single-quoted in the command around it and has a blank.

### A command that is not read to its end

The guard still pauses and renews its pause. What such a command names is not known, so while one is in `settings.json` the guard
writes a file of its own (the state file, the pause file, the log) only where it takes that to destroy nothing of somebody else: where nothing
is at the path, where an empty file is (not at the pause file path: an empty file there is no pause document and is left), or where the file holds what the guard writes there (a pause document, a stored state,
or in the log a first line that starts with the time the way the guard logs it; the log is looked at before every line then). Anything else, a symbolic link too, is left as it is: a state or pause file that holds something
else stops the guard at start (exit status 2, "... is not read to its end"), and after the start every write to it is refused with
an `ERROR` that names the command; a log file with other text is not appended to (the notice goes to stdout). The guard says which
command it could not read in `WARNING (hook-unread)`, at start and then at most once per `--warn-every` seconds; a command read once
counts until the guard is restarted. The programs that the other commands name stay protected as above, and so do the hook,
interpreter and log of the entry that `add` writes.

The price of this compromise: the guard judges a file by what it holds, not by who wrote it, so it can change a file that such a
command names. Cases of that, not necessarily all of them:

- a file that does not exist yet at the path of the state file, pause file or log is created there;
- an empty file at the state file path is replaced, and an empty file at the log path is appended to;
- at the state file path every JSON object with a boolean `paused` (and, where it has `since` or `resume_at`, a number or `null`
  there) counts as a stored state: the guard writes its own state over it, and other keys of the object can be lost;
- at the pause file path every JSON object with `v` 2, `paused` true, an integer `pid` and numbers `since`, `resume_at` and
  `valid_until` counts as a pause document: it can be replaced or removed with whatever else it holds;
- a log whose first line starts with a date and time written as the guard writes them (`YYYY-MM-DD HH:MM:SS `) is appended to,
  whatever follows.

Give the guard files of its own, in a directory that no hook uses, to avoid these.

## Relation to `omc wait`

`omc wait` (`src/features/rate-limit-wait/`) works after the limit is reached: it reads the same usage values, treats
100 % as limited, looks for tmux and herdr panes that show the limit screen, and resumes them when the window resets.
The guard works before the limit: at 97 % it makes the sessions wait, so they do not reach the limit screen. The two do
not write each other's files and do not need each other. With both on, `omc wait` has nothing to do as long as the guard
keeps the window below 100 %, and it still resumes panes that did hit the limit. The `omc wait` daemon also keeps the
usage cache fresh, which helps where no status line renders.

## Tests

```
npx vitest run tests/tools/five-hour-guard.test.ts tests/tools/five-hour-guard-settings.test.ts
```

The tests run the scripts with `python3 -I` on a fake usage cache, a fake pause file and a copy of `settings.json` in
a temporary directory; `HOME` and `CLAUDE_CONFIG_DIR` point there too, so nothing outside it is read or written. In CI
the tests fail when `python3` is missing.
