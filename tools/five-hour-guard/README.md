# Five-hour limit guard

An opt-in guard for people who run many Claude Code sessions at once on one Claude subscription. **It works only with a
Claude subscription (OAuth login), and only while something keeps OMC's usage cache fresh: the OMC status line with rate
limits shown (`elements.rateLimits` is not `false`) or a running `omc wait`.** Without that the guard sees no usage and
holds nothing; it says so in its log (`WARNING`, see "Input: the usage cache"). When the five-hour usage window reaches a
threshold (97 % by default), every tool call of every session that loads the hook waits until the window resets, plus a margin (see "Which sessions load
the hook"). Nothing is
denied and no signal is sent to any process: the sessions stay alive, keep their id and their connections, and stop
spending after at most one more model response. When the window resets, the waiting tool calls continue exactly where
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
| `five_hour_guard_entry.py` | the one definition of the hook entry command and of how a registered command is read; loaded by the guard and the settings tool from their own directory (the hook does not need it) |

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

The guard never publishes a pause over a file that is not a pause of this guard (one that appeared after the start, for example on a shared or mistyped path): the tick reports it and nothing is stored or published; a first publication is made with a hard link (where links are not supported, with an exclusive reservation of the destination), so a file that appears in that instant is kept too (whether the file exists is looked at once, and that look decides between the exclusive and the replacing write; a renewal replaces only the file that was looked at, and a path that holds another file by the time of the rename is kept and the tick reports it). The pause is stored in the state file before its pause file is published, so a pause file never exists without a stored pause behind it (a failing state write delays the pause to the next tick that can write). Paths are compared with the case rules of the platform (Windows, macOS), also for files that do not exist yet. The wiring check compares the registered entry with the entry the guard generates (the same command `add` writes, built by `five_hour_guard_entry.py` from the pause file of the guard and the hook, interpreter and hook log of the entry): an entry other than the generated one produces a warning with the correct entry to paste (a hand-written entry is never an error). It also warns about a handler that runs in the background (`async`) or has a `timeout` missing, not a finite number (an integer too large for a float counts: JavaScript reads it as Infinity) or below 21600 s, and when the hook or the interpreter the entry uses is not an absolute path to a regular file, or the `--log` of the entry is not an absolute path (a relative path would be resolved in each session's working directory, where a log can be any file, the hook itself included; such a log is not copied into the entry the guard offers to paste), and when the interpreter is not named like a Python. A check of the entry that fails on something it did not expect is reported as a warning and never stops the guard from starting or from entering a pause. At every wiring check (also after the start, when settings were rewritten) it warns about an entry whose `--log` is one of the runtime files or programs of the guard (including the hook, interpreter and scripts the entry names), and the entry it offers to paste does not copy such a log; it also warns when the hook, interpreter or launcher a registered entry names is the pause file, state file, log or lock file of the guard (a pause that would replace the program is refused, and so is every later write of the state file and of the pause file: the entry into a pause, each renewal and the end of a pause check the registered entries again). The programs that the commands of every other hook (of any event) and of the status line in `settings.json` run count too (the command word of each simple command, after `exec`, `env` and its options, `command`, `nohup`, `time` and `NAME=VALUE` assignments, the script of an interpreter such as `python3`, `node` or `bash`, also through `bash -c` and `env -S` (`-S STRING`, `-SSTRING`, `--split-string STRING`, `--split-string=STRING`), any argument named like a script, and any word at all that names a file with an execute bit, wherever it stands (the syntax around a command is not parsed: behind `if ...; then`, `do`, `!`, `sudo`, `nice`, `timeout`, `xargs` or an option with a glued value the file is found all the same); read from the text of the command, never run, and only for a command of at most 64 KiB; the commands next to the hook in an entry of this guard count too, also one that has the name of the hook among its arguments; the hook and interpreter of the entry are read as before): a hook of another tool is as much a file the guard must not write to as ours, so it is refused as `state_file`, `pause_file` or `log_file` at the start and at every write, and a word that merely names a file without an execute bit as data (`tail -n 5 guard.log`) is not a program. The command of an entry is read with its quoting, so a quoted hook, interpreter or log path that ends in `;` stays that path. A relative hook, or an interpreter given with a directory part, counts as the file it names from the working directory of the guard in these checks (a session resolves it from its own directory, which the guard cannot know); an interpreter or launcher given by its bare name counts as the file the `PATH` of the guard resolves it to, as in the wiring check. The temporary file of a write is held to the same rule, and nothing is appended to a `log_file` that a registered hook, interpreter or launcher occupies (the notice goes to stdout only; `settings.json` is read at most once per tick for this, not for every line). A `settings.json` that cannot be read (a rewrite in progress, a broken edit) after a read that worked leaves the programs found by that last read in force, so the unreadable file does not open a write; the wiring check warns that it cannot read it. `add` refuses a value of the wrong type for the keys `state_file`, `log_file` and `usage_cache` as the guard does, and treats the bundled hook and the entry module as protected files even when another hook is registered. The guard and the hook append to their logs without following a symbolic link at the last component and only to a regular file (a link
in a shared directory cannot redirect the write; where Python has no `O_NOFOLLOW`, on Windows, the guard refuses a path that is a link or a reparse point before it opens the log). The guard removes the pause file on SIGTERM and SIGINT and on every orderly exit (also when an earlier removal of the file failed and is still
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
status 2 (it takes an exclusive lock on `<state_file>.lock` and on `<pause_file>.lock`, empty files next to those files; on Windows, where Python has no `fcntl`, the same files are locked with `msvcrt.locking`; only a platform with neither has no lock). At start the guard removes a pause file nobody owns, but refuses to start (status 2) when the existing file is not a pause file of this
guard (a mistyped `pause_file` must never delete another file; a symbolic link there, dangling or pointing at a valid pause document, counts as such a file and is left alone; the file is looked at again right before it is removed, so one that appeared or changed since the start check is kept, and the start stops with status 2; the path is then moved aside in one step and what was moved is compared with what was looked at, so a file that took its place in between is put back and never removed (the name it is moved to is new every time, so a file that was kept under one earlier is never replaced); the guard and the hook open the pause file without following a link and check the opened descriptor, so a regular file swapped for a link between the look and the read is not read through the link), and relies on the lock on `<pause_file>.lock` to tell a running guard from a leftover (a pid in the file proves nothing: it can belong to an unrelated process after a crash; only on a platform without `fcntl` the pid and a current heartbeat decide). Two guards must not share one `pause_file`: with different state files they would overwrite each
other's pause (the lock on the pause file stops the second one).

### The hook never wedges a session (fail-open)

| Situation | Result |
|---|---|
| no pause file | the shell guard of the hook command exits 0 without starting Python (2 to 4 ms per tool call, measured on a loaded machine) |
| `python3` or the hook file named in the entry is missing | the same shell guard exits 0 |
| pause file is a symbolic link (whatever it points to: it could be the live pause of another guard), unreadable, not JSON, not an object, lacks a numeric `since` or an integer `pid` (the guard would not own it), or `paused` is not the JSON value `true` (`"false"`, `1` and `"true"` are not) | the tool call passes |
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
- Tested on Linux. The guard and the hook use no platform-specific call (no signals to other processes); macOS should
  behave the same. On Windows the atomic replace of the pause file can fail while the hook has the file open; the
  guard would log an `ERROR` and write the file again at its next check, and if that kept failing the hook would let the
  sessions go after `--heartbeat`. Windows is not tested.
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
   place. `add` refuses paths that are not absolute, a hook or interpreter file that does not exist, an interpreter that is not
   executable or cannot run the hook (it is tried once: Python 3 with the standard library), a hook that does not hold a pause (`add` runs the entry it is about to write, through the shell, against a pause of its own (and, when no hook log is set, once more without `--log`, the shape that is installed then) in a private directory: the command is the one that is installed, with nothing added, apart from the paths of the pause and the log; the hook must keep holding for a moment, and exit 0 when the pause is removed), two of the pause file, hook log,
   `settings.json`, hook, interpreter, configuration file and the two scripts that are one file, and a hook file whose
   name does not contain `five-hour-guard-hook.py` (the entry is found again by that name; exit 2). The tool counts a command as
   the hook only when that file is its script (the command word, or the argument of a Python, or of a command that has
   `--pause-file`; a Python is a file whose whole name is `python`, `pythonw`, `pypy` or `py`, with a version and `.exe` allowed, so `python-audit` is not one); a command of another tool that merely names the file as data is not ours and is never replaced or
   removed. The usage cache counts as a configured file also when `usage_cache` is left out (OMC's default file and its
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

As a systemd user service on Linux: fill the three `@...@` values of `five-hour-guard.service`, install it as
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
| `--warn-every <seconds>` | 600 | at most one `WARNING` about the usage data per this many seconds and kind; 0 for every check, up to 86400 |
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
- A session stops spending after at most one more model response: the hook is asked before a tool call, not before a
  request.
- The pause ends at the reset time plus `--margin`, or earlier when the cache shows a lower percentage. A cache that is
  stale at that moment ends the pause at `resume_at` (fail-open).
- Not checked: whether the OMC status line keeps refreshing the usage cache while every session waits in the hook. The
  early resume and the extension of a pause need a fresh cache; a running `omc wait` keeps it fresh in any case.
- Only the Anthropic five-hour window is watched. The weekly limit is not.
- The unit file is Linux only. The scripts were tested on Linux only.

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
