#!/usr/bin/env python3
"""Five-hour limit guard: a pause file plus a PreToolUse hook, no signals to any session.

Mechanism: at the threshold the guard writes a pause file; the PreToolUse hook (five-hour-guard-hook.py, registered once
in settings.json by five-hour-guard-settings.py) makes every tool call of every session wait while that file says
"paused". Sessions stay alive and keep their id and their connections; a session stops spending after at most one more
model response. At the reset time plus a margin the guard deletes the pause file and every waiting session continues
exactly where it stopped.

Safety: the pause file carries `valid_until` (rewritten every tick); when the guard dies the hook lets sessions go within
--heartbeat seconds. The guard removes the pause file on SIGTERM/SIGINT and on every orderly exit path (a restart therefore
releases the sessions; the pause comes back from the first fresh reading of the usage cache). After a crash the state file
keeps the pause across the restart.

Input: the usage cache that OMC writes for its status line (see README.md, "Input"). The guard only reads it. It works only
for a Claude subscription (OAuth) account, and only while something refreshes that file: the OMC status line showing rate
limits, or a running `omc wait`. When the file is missing, stale or has no percentage, the guard says so in its log
(WARNING, at most once per --warn-every seconds for each kind of problem) and holds nothing.

Configuration: one JSON file (--config, or the OMC_FIVE_HOUR_GUARD_CONFIG variable) with these keys; a command line option
of the same meaning wins over the file. No path is built into the code except the default of `usage_cache`.
  usage_cache    optional  JSON file with `timestamp` (ms) and `data.fiveHourPercent` / `data.fiveHourResetsAt`;
                           default: <CLAUDE_CONFIG_DIR or ~/.claude>/plugins/oh-my-claudecode/.usage-cache-anthropic.json
  pause_file     required  file the hook reads
  state_file     required  guard state (a pause survives a crash of the guard); not needed with --test-pause
  log_file       optional  log appended next to stdout
  settings_file  optional  settings.json checked for the hook entry (loud warning when it is missing)
  exclude        optional  list of session id prefixes whose tool calls are never held
  hook_log_file  optional  log of the hook; used by five-hour-guard-settings.py only
"""
import argparse, datetime, json, math, os, re, shlex, shutil, signal, stat, sys, time

try:
    import fcntl
except ImportError:   # Windows: msvcrt.locking is the lock between two guards
    fcntl = None
try:
    import msvcrt
except ImportError:
    msvcrt = None
LOCKING = fcntl is not None or msvcrt is not None   # without any lock the pid and the heartbeat in the pause file are all there is

HOOK_NAME = 'five-hour-guard-hook.py'
MAX_RESET_AHEAD_S = 5 * 3600 + 900   # a window is 5 h long: a reset time further ahead is not believed (15 min of slack)
MAX_MARGIN_S = 1800
MAX_HEARTBEAT_S = 1800               # the hook ignores a valid_until more than 3600 s ahead
MAX_TEST_PAUSE_S = 1800
HEARTBEAT_SLACK_S = 1                 # --heartbeat must exceed two intervals by this much: a failed tick takes time and the retry is a whole interval later
STATE_MAX_AHEAD_S = 21600            # a stored pause (or its start) further ahead than the hook honours is not ours
FUTURE_SKEW_S = 120                  # a cache timestamp further ahead than this is not believed
MIN_INTERVAL_S = 0.1


def finite_float(text):
    v = float(text)
    if not math.isfinite(v):
        raise argparse.ArgumentTypeError(f'{text!r} is not a finite number')
    return v


ap = argparse.ArgumentParser(description='Five-hour limit guard: pause file plus PreToolUse hook, no signals to sessions')
ap.add_argument('--config', default=os.environ.get('OMC_FIVE_HOUR_GUARD_CONFIG'), help='JSON configuration file (see the module docstring)')
ap.add_argument('--cache', default=None, help='usage cache file (config: usage_cache)')
ap.add_argument('--pause-file', default=None, help='pause file (config: pause_file)')
ap.add_argument('--state', default=None, help='state file (config: state_file)')
ap.add_argument('--log', default=None, help='log file (config: log_file)')
ap.add_argument('--settings', default=None, help='settings.json checked for the hook entry; "" disables the check (config: settings_file)')
ap.add_argument('--exclude', default=None, help='comma separated session id prefixes whose tool calls are never held (config: exclude)')
ap.add_argument('--threshold', type=finite_float, default=97)
ap.add_argument('--resume-below', type=finite_float, default=None, help='early resume when the fresh cache shows less than this percent (default threshold-10)')
ap.add_argument('--max-age', type=finite_float, default=180, help='data older than this many seconds is not acted on (keep it above the status line usage poll interval, 90 s by default)')
ap.add_argument('--margin', type=finite_float, default=150, help=f'resume this many seconds after the reset time (0 to {MAX_MARGIN_S})')
ap.add_argument('--interval', type=finite_float, default=30, help=f'seconds between ticks (at least {MIN_INTERVAL_S:g})')
ap.add_argument('--heartbeat', type=finite_float, default=300, help=f'pause file validity after each tick; the hook lets sessions go when it lapses (guard dead); from twice --interval plus {HEARTBEAT_SLACK_S} s to {MAX_HEARTBEAT_S}')
ap.add_argument('--warn-every', type=finite_float, default=600, help='at most one WARNING about the usage data (missing, stale, no percentage, implausible reset time) per this many seconds and kind')
ap.add_argument('--test-pause', type=finite_float, default=0, metavar='SECONDS', help=f'install check: hold sessions for this many seconds (up to {MAX_TEST_PAUSE_S}), then release; touches no state')
ap.add_argument('--test-only', default='', metavar='PREFIXES', help='with --test-pause: comma separated session id prefixes; only those sessions are held')
ap.add_argument('--once', action='store_true', help='run a single tick and exit without cleaning a pause started by it (tests)')
ap.add_argument('--dry-run', action='store_true', help='log what would happen and write nothing')
A = ap.parse_args()


def fail(msg):
    print(f'five-hour-guard: {msg}', file=sys.stderr)
    sys.exit(2)


def check_range(name, value, low, high=None):
    if value < low or (high is not None and value > high):
        want = f'at least {low:g}' if high is None else f'between {low:g} and {high:g}'
        fail(f'{name} must be {want} seconds, not {value:g}')


check_range('--margin', A.margin, 0, MAX_MARGIN_S)
check_range('--max-age', A.max_age, 1)   # a negative or zero age makes every entry stale: the guard would fail open for ever
check_range('--interval', A.interval, MIN_INTERVAL_S)
check_range('--heartbeat', A.heartbeat, 2 * A.interval + HEARTBEAT_SLACK_S, MAX_HEARTBEAT_S)   # a pause must outlive one missed tick, with room for the time that tick took
check_range('--warn-every', A.warn_every, 0, 86400)
check_range('--test-pause', A.test_pause, 0, MAX_TEST_PAUSE_S)
if not 0 < A.threshold <= 100:
    fail(f'--threshold must be greater than 0 and at most 100 percent, not {A.threshold:g}')
if A.resume_below is not None and not 0 <= A.resume_below <= A.threshold:
    # above the threshold one tick would enter the pause and the next would leave it, again and again
    fail(f'--resume-below must be between 0 and the threshold ({A.threshold:g}) percent, not {A.resume_below:g}')


def load_config(path):
    if not path:
        return {}
    try:
        with open(path) as f:
            cfg = json.load(f)
    except Exception as e:
        fail(f'cannot read configuration {path}: {e!r}')
    if not isinstance(cfg, dict):
        fail(f'configuration {path} is not a JSON object')
    return cfg


CFG = load_config(A.config)


def setting(cli, key, required=False):
    """Command line value (an empty string counts: it disables an optional feature), else the configuration value."""
    v = cli if cli is not None else CFG.get(key)
    if v is not None and not isinstance(v, str):
        fail(f'"{key}" must be a string (a file path), not {v!r}')
    if v and '\0' in v:
        fail(f'"{key}" holds a NUL character: not a file path')
    if required and not v:
        fail(f'"{key}" is not set: give it in the configuration file (--config or OMC_FIVE_HOUR_GUARD_CONFIG) or on the command line')
    return v or ''


def claude_config_dir():
    """Claude Code configuration directory as OMC resolves it (src/utils/config-dir.ts): CLAUDE_CONFIG_DIR with surrounding
    blanks removed; ~, ~/x and ~\\x are expanded (both separators), anything else is kept; default ~/.claude."""
    home = os.path.expanduser('~')
    configured = os.environ.get('CLAUDE_CONFIG_DIR', '').strip()
    if not configured:
        return os.path.normpath(os.path.join(home, '.claude'))
    if configured == '~':
        return os.path.normpath(home)
    if configured.startswith('~/') or configured.startswith('~\\'):
        return os.path.normpath(os.path.join(home, configured[2:]))
    return os.path.normpath(configured)


def default_settings():
    """The settings.json the settings tool registers the hook in when no path is given (the same rule as the tool)."""
    return os.path.join(claude_config_dir(), 'settings.json')


def default_usage_cache():
    """The file OMC's status line and `omc wait` write (src/hud/usage-api.ts); the guard only reads it."""
    return os.path.join(claude_config_dir(), 'plugins', 'oh-my-claudecode', '.usage-cache-anthropic.json')


PAUSE_FILE = setting(A.pause_file, 'pause_file', required=True)
CACHE = setting(A.cache, 'usage_cache') or default_usage_cache()
STATE = setting(A.state, 'state_file', required=not A.test_pause)
LOG = setting(A.log, 'log_file')
SETTINGS = setting(A.settings, 'settings_file')


def check_writable_dir(path, label):
    """A pause or state file in a directory that is missing or read-only would fail only when a pause is due: say it at start."""
    d = os.path.dirname(os.path.abspath(path))
    if not (os.path.isdir(d) and os.access(d, os.W_OK | os.X_OK)):
        fail(f'the directory {d} of {label} does not exist or is not writable')


if not os.path.isabs(PAUSE_FILE):
    fail(f'"pause_file" must be an absolute path, not {PAUSE_FILE!r}: the hook entry accepts only an absolute path and would read another file')
if isinstance(CFG.get('hook_log_file'), str) and CFG['hook_log_file'] and not os.path.isabs(CFG['hook_log_file']):
    fail(f'"hook_log_file" must be an absolute path, not {CFG["hook_log_file"]!r}: the hook would append to a file of the working directory of each session (the entry the guard offers to paste would carry the path)')


def path_key(path):
    """A path once links are resolved, in the case rules of the platform (Windows; macOS volumes are mostly case-insensitive): two
    paths of files that do not exist yet can differ only by case and still be one file."""
    key = os.path.normcase(os.path.realpath(path))
    return key.lower() if sys.platform == 'darwin' else key


def same_file(a, b):
    """The same path once links are resolved, or the same existing file (a hard link)."""
    if path_key(a) == path_key(b):
        return True
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


HOOK_PROGRAMS = {'hook script', 'registered hook', 'registered interpreter'}


def may_be_one_file(la, pa, lb, pb):
    """The pairs that are one file by design: the hook as the bundled and as the registered one (and a hook that two entries name),
    an interpreter that two entries name, a hook that is run directly and so is its own launcher (the same path in both places: a
    hook that is a link to the interpreter is not), and the hook log of the configuration that is the log of the entry."""
    if {la, lb} == {'hook_log_file', 'registered hook log'}:
        return True
    if la in ('hook script', 'registered hook') and lb in ('hook script', 'registered hook'):
        return True
    if la == lb == 'registered interpreter':
        return True
    if la in HOOK_PROGRAMS and lb in HOOK_PROGRAMS:   # a hook and an interpreter
        return os.path.normcase(os.path.abspath(pa)) == os.path.normcase(os.path.abspath(pb))   # the same path as written, not the same file: a link to the interpreter is not the hook
    return False


def collisions(files):
    """[(label a, path a, label b, path b)]: pairs of files that are one file and may not be."""
    named = [(label, path) for label, path in files if path]
    return [(la, pa, lb, pb) for i, (la, pa) in enumerate(named) for lb, pb in named[i + 1:]
            if not may_be_one_file(la, pa, lb, pb) and same_file(pa, pb)]


def check_distinct(files):
    """Two configured files that are one file would be read as each other's content: a pause file that is settings.json
    would be removed as a leftover pause at start. Refuse before anything is touched."""
    for la, pa, lb, pb in collisions(files)[:1]:
        fail(f'"{la}" ({pa}) and "{lb}" ({pb}) are the same file: the guard would remove or overwrite one as the other')


HERE = os.path.dirname(os.path.abspath(__file__))


def load_entry_module():
    """five_hour_guard_entry.py next to this script: the one definition of the hook entry (see there)."""
    import importlib.util
    path = os.path.join(HERE, 'five_hour_guard_entry.py')
    spec = importlib.util.spec_from_file_location('five_hour_guard_entry', path)
    module = importlib.util.module_from_spec(spec)
    keep, sys.dont_write_bytecode = sys.dont_write_bytecode, True   # no __pycache__ in the install directory
    try:
        spec.loader.exec_module(module)
    except Exception as e:
        fail(f'cannot load {path}: {e!r} (it belongs next to the scripts)')
    finally:
        sys.dont_write_bytecode = keep
    return module


ENTRY = load_entry_module()
entry_parts = ENTRY.entry_parts


def command_hooks(groups):
    """The command handlers of PreToolUse groups that run our hook: [(group, handler command)]. A command that names the hook file
    only as an operand (an option value, an argument of another program) is not ours; one that cannot be parsed is kept, so that
    hook_check can say so."""
    found = []   # (group, handler)
    for g in groups if isinstance(groups, list) else []:
        if not isinstance(g, dict) or not isinstance(g.get('hooks', []), list):
            continue   # not a group of Claude Code: skipped here, so that the entries after it are still seen
        for h in g.get('hooks', []):
            if not isinstance(h, dict):
                continue
            command = h.get('command')
            if h.get('type') != 'command' or not isinstance(command, str) or HOOK_NAME not in command:
                continue
            try:
                if not entry_parts(command)[0]:
                    continue
            except ValueError:
                pass
            found.append((g, h))
    return found


def registered_runtime_files():
    """The hook script and the interpreter that the hook entry in settings.json names (they can be anywhere: `add --hook` takes
    any path). A relative hook, or an interpreter given with a directory part, is taken as the file it names from the working
    directory of the guard: a session resolves it from its own directory, which cannot be known here, so this is the conservative
    reading for the collision checks (an interpreter given by its bare name is looked up on PATH and names no file). Best effort: an
    unreadable settings file gives none (hook_check says so later)."""
    found = []
    try:
        with open(SETTINGS or default_settings()) as f:
            groups = json.load(f).get('hooks', {}).get('PreToolUse', [])
        for _group, handler in command_hooks(groups):
            try:   # one handler that cannot be parsed must not hide the ones after it
                hooks, interpreters, logs, _pauses, _tests, launchers = entry_parts(handler['command'])
            except Exception:
                continue
            found += [('registered hook', t) for t in hooks]
            found += [('registered interpreter', t) for t in interpreters + launchers if os.path.dirname(t)]
            found += [('registered hook log', t) for t in logs if os.path.isabs(t)]
    except Exception:
        pass
    return found


def configured_files():
    """Every file the guard reads, writes or runs by its own configuration: the one list for the start check and for the wiring check."""
    return [('configuration file', A.config), *own_files(), ('pause_file', PAUSE_FILE), ('state_file', STATE), ('state_file lock', STATE + '.lock' if STATE else ''),
            ('usage_cache', CACHE), ('usage_cache lock', CACHE + '.lock'), ('log_file', LOG), ('settings_file', SETTINGS or default_settings()),
            ('pause_file lock', PAUSE_FILE + '.lock')]


def program_collisions():
    """[(label of the program, path, file of the guard)]: a hook, interpreter or launcher that the registered entries name and that is
    a file the guard writes (a settings rewrite after the start can put it there). A write would replace the program."""
    outputs = [('pause_file', PAUSE_FILE), ('state_file', STATE), ('log_file', LOG), ('lock of the pause file', PAUSE_FILE + '.lock'),
               ('lock of the state file', STATE + '.lock' if STATE else '')]
    return [(label, path, out_label) for label, path in registered_runtime_files() if label in ('registered hook', 'registered interpreter')
            for out_label, out in outputs if out and same_file(path, out)]


def own_files():
    """The scripts of the guard itself: what no log, state or pause file may be."""
    return [('guard script', os.path.abspath(__file__)), ('hook script', os.path.join(HERE, HOOK_NAME)),
            ('settings tool script', os.path.join(HERE, 'five-hour-guard-settings.py')), ('entry module', os.path.join(HERE, 'five_hour_guard_entry.py'))]

check_distinct([*configured_files(), *registered_runtime_files(),
                ('hook_log_file', CFG.get('hook_log_file') if isinstance(CFG.get('hook_log_file'), str) and '\0' not in CFG['hook_log_file'] else '')])
check_writable_dir(PAUSE_FILE, 'pause_file')
if STATE:
    check_writable_dir(STATE, 'state_file')
for _label, _path in (('pause_file', PAUSE_FILE), ('state_file', STATE)):
    # both are replaced atomically: a directory (or another kind of file) there would fail only when a pause is due
    if _path and os.path.exists(_path) and not os.path.isfile(_path):
        fail(f'"{_label}" ({_path}) is not a regular file')


def parse_exclude():
    raw = A.exclude if A.exclude is not None else CFG.get('exclude', [])
    if isinstance(raw, str):
        raw = raw.split(',')
    if not isinstance(raw, list) or not all(isinstance(x, str) for x in raw):
        fail('"exclude" must be a list of session id prefixes (or one comma separated string)')
    return [x for x in raw if x]


EXCLUDE = parse_exclude()
ONLY = [x for x in A.test_only.split(',') if x]
RESUME_BELOW = A.resume_below if A.resume_below is not None else A.threshold - 10
STOP = False


def ts(t=None):
    try:
        return datetime.datetime.fromtimestamp(t if t is not None else time.time()).strftime('%Y-%m-%d %H:%M:%S')
    except (OverflowError, OSError, ValueError):
        return f'(time {t!r} out of range)'


def append_line(path, text):
    """Append to a log without following a link at the final component and without opening anything but a regular file: a link
    that somebody else put in a shared directory must not make this process write into the file it points to."""
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0), 0o644)
    try:
        if stat.S_ISREG(os.fstat(fd).st_mode):
            os.write(fd, text.encode('utf-8', 'replace'))
    finally:
        os.close(fd)


def log(msg):
    line = f'{ts()} {msg}'
    print(line, flush=True)
    if LOG and not A.dry_run:
        try:
            append_line(LOG, line + '\n')
        except Exception:
            pass


def refuse_program_overwrite(path):
    """A hook, interpreter or launcher that a registered entry names is never replaced by a write of the guard: settings.json can be
    rewritten at any moment, so this is looked at at every write (the entry into a pause, each renewal, the end of a pause)."""
    for label, program in registered_runtime_files():
        if label in ('registered hook', 'registered interpreter') and same_file(program, path):
            raise OSError(f'the {label} {program} is {path}, a file this guard writes: it is not replaced (run five-hour-guard-settings.py add again)')


def write_json(path, obj, no_clobber=False):
    """Write atomically. no_clobber: a file that appears at the path meanwhile is kept and the write fails (a hard link is created
    instead of a rename; where links are not supported the destination is reserved exclusively first)."""
    if A.dry_run:
        return
    refuse_program_overwrite(path)
    tmp = f'{path}.{os.getpid()}.tmp'
    try:
        os.unlink(tmp)   # a leftover of a crashed run, or a link somebody put there: the link itself goes, never what it points to
    except FileNotFoundError:
        pass
    # exclusive and without following links: another account that can write to the directory cannot redirect the write
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o644)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(obj, f)
        if no_clobber:
            try:
                os.link(tmp, path)
            except FileExistsError:
                raise OSError(f'the file {path} appeared meanwhile and is not replaced')
            except OSError:
                # no hard links on this file system: the destination is reserved exclusively (a file that is there is kept and the write
                # fails) and the rename goes over the reservation
                try:
                    os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o644))
                except FileExistsError:
                    raise OSError(f'the file {path} appeared meanwhile and is not replaced')
                try:
                    os.replace(tmp, path)
                except BaseException:
                    os.unlink(path)   # the reservation is ours
                    raise
            else:
                os.unlink(tmp)
        else:
            os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_state():
    """The stored state, or a fresh one when the file is missing or does not have the shape this guard writes."""
    try:
        with open(STATE) as f:
            st = json.load(f)
        if st.get('paused') is not True:
            return {'paused': False}
        now = time.time()
        # times the guard could have written: positive, and not further ahead than a pause ever lasts
        if all(type(st.get(k)) in (int, float) and math.isfinite(st[k]) and 0 < st[k] <= now + STATE_MAX_AHEAD_S for k in ('since', 'resume_at')):
            # enter_pause() stamps `since` with the clock of that moment and resume_at lies after it
            if st['since'] <= now + FUTURE_SKEW_S and st['since'] <= st['resume_at']:
                return st
    except Exception:
        pass
    return {'paused': False}


NEEDS = ('the guard needs the OMC status line showing rate limits, or a running `omc wait`, to keep that file fresh '
         'and a Claude subscription (OAuth) account; see README.md, "Input"')
WARNED = {}   # kind of problem -> time.monotonic() of its last WARNING


def warn_data(kind, text):
    """Loud, but at most once per --warn-every seconds for each kind of problem, so a permanent one does not flood the log."""
    now = time.monotonic()
    last = WARNED.get(kind)
    if last is not None and now - last < A.warn_every:
        return
    WARNED[kind] = now
    log(f'WARNING ({kind}): {text}')


def read_cache():
    """(percent, reset_epoch, age_s, problem); percent is None when there is none. problem is None or (kind, text). Never raises.

    A refresh that was rate limited or failed rewrites the entry with a fresh `timestamp` but keeps the data of the last
    successful fetch (`lastSuccessAt`): the age of the data is then the age of that fetch, not of the rewrite."""
    try:
        with open(CACHE) as f:
            d = json.load(f)
        copy_of_old_data = bool(d.get('error') or d.get('rateLimited'))
        seen_ms = d.get('lastSuccessAt') if copy_of_old_data else d.get('timestamp')
        age = time.time() - (seen_ms / 1000 if type(seen_ms) in (int, float) and math.isfinite(seen_ms) else 0)   # text, a boolean or infinity is not a time: the entry is stale
        x = d.get('data') or {}
        reset = x.get('fiveHourResetsAt')
        reset_ts = datetime.datetime.fromisoformat(reset.replace('Z', '+00:00')).timestamp() if reset else None
        pct = x.get('fiveHourPercent')
        if pct is not None:
            pct = float(pct) if type(pct) in (int, float) else float('nan')   # "99" and true are not percentages: invalid, not coerced
    except FileNotFoundError:
        return None, None, 1e9, ('cache-missing', f'the usage cache {CACHE} does not exist: {NEEDS}')
    except Exception as e:
        return None, None, 1e9, ('cache-unreadable', f'cannot read the usage cache {CACHE}: {e!r}')
    problem = None
    source = d.get('source')
    if source is not None and source != 'anthropic':   # OMC writes the provider next to the data: another provider's cache is not this account's window
        return None, None, age, ('cache-source', f'the usage cache {CACHE} has the source {source!r}, not "anthropic" (a cache of another provider?): it is not acted on, check "usage_cache"')
    if pct is None:
        problem = ('cache-no-percent', f'the usage cache {CACHE} has no fiveHourPercent (no five-hour window on this account?): {NEEDS}')
    elif not math.isfinite(pct) or not 0 <= pct <= 100:   # OMC clamps the field to 0-100 when it writes it
        pct = None
        problem = ('cache-invalid-percent', f'the usage cache {CACHE} has a fiveHourPercent that is not a percentage (not a number, not finite, below 0 or above 100): it is not acted on')
    elif age < -FUTURE_SKEW_S:
        pct = None
        problem = ('cache-future', f'the usage data is stamped {-age:.0f} s in the future (the clock of the writer is not this one, or the file is not OMC\'s): it is not acted on')
    elif not age <= A.max_age:   # not "age > max": a timestamp that is not a number gives an age that is neither
        problem = ('cache-stale', f'the usage data is {age:.0f} s old, older than --max-age ({A.max_age:g} s), so it is not acted on: {NEEDS}')
    return pct, reset_ts, age, problem


def hook_log_setting():
    """hook_log_file of the configuration (the log of the hook entry), or None."""
    v = CFG.get('hook_log_file')
    return v if isinstance(v, str) and v and '\0' not in v else None


LAST_WIRING_CHECK = [None]   # time.monotonic() of the last hook_check


def hook_check(where):
    """A pause with no registered hook holds nothing: say so loudly (a later settings rewrite could drop the entry). Advice only: a
    check that fails on an entry it did not expect is reported and never keeps the guard from starting or from entering a pause."""
    try:
        check_wiring(where)
    except Exception as e:
        log(f'WARNING ({where}): the check of the hook entry failed ({e!r}): the guard goes on, the entry in {SETTINGS or default_settings()} was not checked')


def check_wiring(where):
    if not SETTINGS:
        return
    LAST_WIRING_CHECK[0] = time.monotonic()
    try:
        with open(SETTINGS) as f:
            data = json.load(f)
        groups = data.get('hooks', {}).get('PreToolUse', [])
        entries = command_hooks(groups)
        ours = [h['command'] for _g, h in entries]
        matchers = [g.get('matcher') for g, _h in entries]
        handlers = [h for _g, h in entries]
    except Exception as e:
        log(f'WARNING ({where}): cannot read the hook entries of {SETTINGS}: {e!r}')
        return
    if not ours:
        log(f'WARNING ({where}): hook {HOOK_NAME} is NOT registered in {SETTINGS}: a pause would hold no session. Run five-hour-guard-settings.py add')
    if ours and not any(m in (None, '', '*') for m in matchers):
        log(f'WARNING ({where}): the hook entry in {SETTINGS} has the matcher {matchers[0]!r}, which does not cover every tool: calls of other tools would go on during a pause. Run five-hour-guard-settings.py add again')
    for handler in handlers:
        for problem in ENTRY.handler_problems(handler):
            log(f'WARNING ({where}): the hook entry in {SETTINGS}: {problem}. Run five-hour-guard-settings.py add again')
    runtime = configured_files()
    for la, pa, lb, pb in collisions(configured_files() + registered_runtime_files()):
        if 'registered hook log' in (la, lb) or not ({la, lb} & {'registered hook', 'registered interpreter'}):
            continue   # the log of an entry is reported below, with its own sentence; two configured files were refused at the start
        program, other = ((la, pa), (lb, pb)) if la.startswith('registered') and not lb.startswith('registered') else ((lb, pb), (la, pa))
        log(f'WARNING ({where}): the {program[0]} {program[1]} is the {other[0]} of this guard ({other[1]}): the entry would not run the hook, or a write of the guard would replace the program, so a pause would hold no session. Run five-hour-guard-settings.py add again')
    programs = []   # the programs of every recognised entry: a log of one entry can be the program of another
    for command in ours:
        try:
            hooks, interpreters, _logs, _pauses, _tests, launchers = entry_parts(command)
        except ValueError:
            continue   # reported below
        programs += [('registered hook', t) for t in hooks] + [('registered interpreter', t) for t in interpreters + launchers]
    for command in ours:
        try:
            hooks, interpreters, logs, _pauses, _tests, launchers = entry_parts(command)
            aliased = [(log_path, label) for log_path in logs for label, path in runtime + programs if path and same_file(log_path, path)]
            for log_path, label in aliased:
                log(f'WARNING ({where}): the hook entry in {SETTINGS} logs to {log_path}, which is the {label} of this guard: the hook would append its log lines to it (a pause file would stop being one, so a pause would hold no session). Run five-hour-guard-settings.py add again')
            expected = ENTRY.expected_command(command, PAUSE_FILE, hook_log_setting(), copy_log=not aliased)
        except ValueError:
            log(f'WARNING ({where}): the hook entry command {command!r} in {SETTINGS} cannot be parsed (unbalanced quote or NUL character): the shell would fail on it, so a pause would hold no session. Run five-hour-guard-settings.py add again')
            continue
        if command != expected:   # one rule instead of a check per field: whatever differs from the generated entry may let calls through
            log(f'WARNING ({where}): the hook entry in {SETTINGS} is not the entry this guard generates for its pause file {PAUSE_FILE}; a difference can let every call through during a pause. Replace its command with this one (or run five-hour-guard-settings.py add): {expected}')
        for path in hooks + [x for x in launchers if x not in hooks]:   # what the entry runs must exist as a regular file, by an absolute path (a hook runs in the working directory of a session)
            if not os.path.isabs(path):
                log(f'WARNING ({where}): the hook entry in {SETTINGS} uses the relative path {path}: it is resolved in the working directory of each session, so a pause would hold no session')
        for path in logs:   # the hook appends to it: from a session in another directory it can be any file there, the hook itself included
            if not os.path.isabs(path):
                log(f'WARNING ({where}): the hook entry in {SETTINGS} logs to the relative path {path}: it is resolved in the working directory of each session, where it can be a file of the project or the hook itself, so the hook would append its log lines to it. Run five-hour-guard-settings.py add again')
        for path in hooks:
            if not os.path.isfile(path):
                log(f'WARNING ({where}): the hook entry in {SETTINGS} names {path}, which does not exist: the shell guard of the entry lets every call through, so a pause would hold no session')
        for launcher in launchers:
            if launcher in hooks:
                continue   # run directly: the drift warning above covers it
            path = launcher if os.path.isabs(launcher) else shutil.which(launcher)
            if not re.match(r'(python|pypy|py$)', os.path.basename(launcher).lower()):
                log(f'WARNING ({where}): the hook entry in {SETTINGS} runs the hook with {launcher}, which is not a Python: it would not run the hook, so a pause would hold no session')
            elif not path or not os.path.isfile(path) or not os.access(path, os.X_OK):   # isfile: a searchable directory passes `[ -x ]` and still cannot be run
                log(f'WARNING ({where}): the hook entry in {SETTINGS} runs the hook with {launcher}, which does not exist or cannot be run: the shell guard of the entry lets every call through, so a pause would hold no session')


def check_pause_path():
    """Never publish over a file that is not a pause of this guard: something else may have created it after the start check (a shared or
    mistyped path). Returns whether the file exists: the caller acts on this one look (a second look could find a file that appeared in
    between and take it for the pause it may replace)."""
    exists = os.path.lexists(PAUSE_FILE)
    if exists and not is_guard_pause(PAUSE_FILE):
        raise OSError(f'the file {PAUSE_FILE} is not a pause file of this guard: it is left untouched and no pause is published (check "pause_file")')
    return exists


def publish(state, pct=None, only=None):
    """(Re)write the pause file the hook reads. Atomic; called every tick while paused."""
    now = time.time()
    doc = {'v': 2, 'paused': True, 'since': state['since'], 'resume_at': state['resume_at'],
           'valid_until': now + A.heartbeat, 'exclude': EXCLUDE, 'percent': pct, 'pid': os.getpid()}
    if only:
        doc['only'] = only
    write_json(PAUSE_FILE, doc, no_clobber=not check_pause_path())


def unpublish(strict=False):
    """Remove the pause file. False when it could not be removed (logged), so that a caller can keep its state and try again.
    The file is looked at again right before it is removed: one that is not a regular pause document of this guard any more
    (somebody created or replaced it since the last check) is never removed; strict makes that a configuration error (exit 2)."""
    if A.dry_run:
        return True
    try:
        before = os.lstat(PAUSE_FILE)
        ours = stat.S_ISREG(before.st_mode) and is_guard_pause(PAUSE_FILE)
        after = os.lstat(PAUSE_FILE)
        ours = ours and (before.st_ino, before.st_mtime_ns, before.st_size) == (after.st_ino, after.st_mtime_ns, after.st_size)
    except FileNotFoundError:
        return True
    except Exception as e:
        log(f'cannot remove pause file: {e!r}')
        return False
    if not ours:
        if strict:
            fail(f'the file {PAUSE_FILE} is not a pause file of this guard (it changed since the start check): it is left untouched; check "pause_file", or remove the file yourself')
        log(f'the file {PAUSE_FILE} is not a pause file of this guard any more: left alone')
        return True
    try:
        os.unlink(PAUSE_FILE)
    except FileNotFoundError:
        pass
    except Exception as e:
        log(f'cannot remove pause file: {e!r}')
        return False
    return True


def enter_pause(state, pct, reset_ts):
    if not A.dry_run:
        check_pause_path()   # before anything is stored: a pause that cannot be published must not be remembered
        for label, path, out_label in program_collisions():
            raise OSError(f'the {label} {path} is the {out_label} of this guard: a pause would replace the program, so none is stored (run five-hour-guard-settings.py add again)')
    state.update(paused=True, since=time.time(), resume_at=reset_ts + A.margin)
    log(f'THRESHOLD: 5h {pct} %, reset {ts(reset_ts)}; pause until {ts(state["resume_at"])}')
    hook_check('pause start')
    if A.dry_run:
        return
    write_json(STATE, state)   # the durable state first: a pause file with no stored pause behind it would be removed as a leftover after a crash
    publish(state, pct)


def leave_pause(state, why):
    """Leave the pause in this order: the state is written first, the pause file removed after. When the write fails nothing has
    changed (the pause stays in force, in memory, on disk and as a file) and the next tick tries again; when the removal fails
    the state is already unpaused and the removal is retried by the next tick (and by the next start, as a leftover)."""
    write_json(STATE, {**{k: v for k, v in state.items() if k != 'unlink_pending'}, 'paused': False, 'since': None, 'resume_at': None})
    state.update(paused=False, since=None, resume_at=None)
    if not unpublish():
        state['unlink_pending'] = True
        raise OSError(f'the pause file {PAUSE_FILE} could not be removed: the removal is tried again at the next tick')
    state.pop('unlink_pending', None)
    log(f'RESUMED ({why}): pause file removed, waiting tool calls continue')


def tick(state):
    if state.get('unlink_pending'):
        if not unpublish():
            raise OSError(f'the pause file {PAUSE_FILE} could not be removed: the removal is tried again at the next tick')
        state.pop('unlink_pending', None)
        log('RESUMED (pause file removed on retry): waiting tool calls continue')
    pct, reset_ts, age, problem = read_cache()
    if problem:
        warn_data(*problem)
    fresh = pct is not None and age <= A.max_age
    now = time.time()
    if not state.get('paused'):
        if fresh and pct >= A.threshold:
            # reset_ts in the past = the cache still shows the window that just ended (not refreshed yet): never re-pause on it
            if reset_ts and now < reset_ts <= now + MAX_RESET_AHEAD_S:
                enter_pause(state, pct, reset_ts)
                return
            if not reset_ts:
                warn_data('reset-missing', f'5h {pct} %, but the usage cache has no reset time (the API sent none, or an invalid one): no pause. {NEEDS}')
            if reset_ts and reset_ts > now:
                warn_data('reset-too-far', f'5h {pct} %, but the reset time {ts(reset_ts)} is more than {MAX_RESET_AHEAD_S // 60} minutes ahead '
                          f'(a window is 5 hours): the data is not believed, no pause')
        if A.dry_run:
            log(f'[dry run] 5h {pct} %, cache age {age:.0f} s: no action')
        return
    # paused: the hook, its interpreter or the settings entry can be removed while a pause lasts for hours
    if LAST_WIRING_CHECK[0] is None or time.monotonic() - LAST_WIRING_CHECK[0] >= A.warn_every:
        hook_check('pause')
    if fresh and pct < RESUME_BELOW:
        leave_pause(state, f'window reset seen early: 5h {pct} %')
        return
    if now >= state['resume_at']:
        if fresh and pct >= A.threshold and reset_ts and reset_ts <= now + MAX_RESET_AHEAD_S and reset_ts + A.margin > now:
            state['resume_at'] = reset_ts + A.margin
            log(f'reset slipped: 5h still {pct} %, new resume time {ts(state["resume_at"])}')
            if state['resume_at'] - state['since'] > ENTRY.MIN_TIMEOUT_S:
                # a held call is bounded by the timeout of the hook entry, whatever the guard does: no cap here (it would let the calls that arrive later through)
                warn_data('pause-beyond-timeout', f'the pause now lasts {state["resume_at"] - state["since"]:.0f} s, longer than the {ENTRY.MIN_TIMEOUT_S} s minimum timeout of the hook entry: '
                          f'Claude Code releases a call that has been waiting longer than the timeout of the entry, calls that arrive later are still held. Raise the timeout with five-hour-guard-settings.py add --timeout')
        else:
            leave_pause(state, 'reset time reached' + ('' if fresh else ' (cache stale, fail-open)'))
            return
    write_json(STATE, state)   # also here: a first write that failed has not stored the pause yet
    publish(state, pct)


def safe_tick(state):
    """One tick that never ends the process: a write that fails (the directory of the pause file is gone, the disk is full)
    is logged and the next tick tries again, with the state kept in memory."""
    try:
        tick(state)
        return True
    except Exception as e:
        log(f'ERROR: tick failed, trying again at the next tick: {e!r}')
        return False


def pid_alive(pid):
    if os.name != 'posix' or type(pid) is not int or pid <= 0:
        return False   # (os.kill with signal 0 is not a probe on Windows)
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except (OSError, OverflowError, ValueError):   # also a pid no process can have: the pause file is not to be trusted
        return False
    return True


def is_guard_pause(path):
    """True when the file is a regular file (not a link, whatever it points to) with the shape publish() writes. Anything else is somebody else's file.
    The file is opened without following a link and the opened descriptor is checked, so a regular file that is swapped for a link
    after the first look is not read through the link."""
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            return False
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
        with os.fdopen(fd) as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                return False
            d = json.load(f)
        return (isinstance(d, dict) and d.get('v') == 2 and type(d.get('v')) is int and d.get('paused') is True and type(d.get('pid')) is int
                and all(type(d.get(k)) in (int, float) and math.isfinite(d[k]) for k in ('since', 'resume_at', 'valid_until')))
    except Exception:
        return False


def drop_leftover_pause():
    """A pause file with no state behind it is a leftover of a dead guard: remove it (main has checked that it is a pause file
    of this guard and that no live process owns it). False when it could not be removed."""
    return unpublish(strict=True)


LOCK_FDS = []


def lock_one(path, what):
    """Hold an exclusive flock on a sibling file for the whole life of the process."""
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)   # never through a link put there
    except OSError as e:
        fail(f'cannot open the lock file {path}: {e!r}')
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)   # one byte at the start of the empty file; released when the process ends
    except OSError:
        os.close(fd)
        fail(f'another guard holds {path}: one guard per {what}')
    LOCK_FDS.append(fd)   # held until the process ends


def lock_state():
    """One guard per state file and one per pause file. flock on a sibling file: the state file itself is replaced on every
    write, so every write would give it a new inode and a new lock; two guards with different state files but one pause
    file would otherwise overwrite each other's pause and remove it on stop."""
    if not LOCKING or A.dry_run or A.test_pause:
        return
    lock_one(STATE + '.lock', 'state file')
    lock_one(PAUSE_FILE + '.lock', 'pause file')


def on_signal(signum, _frame):
    global STOP
    STOP = True


def test_pause():
    if os.path.lexists(PAUSE_FILE):
        fail(f'--test-pause refused: {PAUSE_FILE} exists (a pause is in force or a test is running); the test would overwrite it and remove it at the end')
    now = time.time()
    st = {'since': now, 'resume_at': now + A.test_pause}
    A.heartbeat = A.test_pause + 5
    publish(st, only=ONLY)
    log(f'test pause: pause file written for {A.test_pause:.0f} s (exclude {EXCLUDE}, only {ONLY or "all sessions"})')
    end = now + A.test_pause
    status = 0
    try:
        while not STOP and time.time() < end:
            time.sleep(0.5)
    finally:
        try:
            with open(PAUSE_FILE) as f:
                ours = json.load(f).get('pid') == os.getpid()
        except Exception:
            ours = False
        if ours:
            for attempt in range(5):   # an early stop of a long test must not leave the sessions held for the rest of it
                if unpublish():
                    log('test pause over: pause file removed')
                    break
                time.sleep(1)
            else:
                log(f'ERROR: test pause over, but the pause file {PAUSE_FILE} could not be removed: the sessions it holds are released when it lapses (valid_until), at the latest {A.heartbeat:.0f} s after it was written')
                status = 1
        else:
            log('test pause over: the pause file is gone or no longer ours (a real pause may have started), left alone')
    return status


def main():
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    if A.test_pause:
        return test_pause()
    if os.path.lexists(PAUSE_FILE) and not is_guard_pause(PAUSE_FILE):   # lexists: a dangling link is somebody's path too
        # the start would remove it as a leftover: never remove a file that is not a pause of this guard (a mistyped path)
        fail(f'the file {PAUSE_FILE} exists and is not a pause file of this guard: it is left untouched; check "pause_file", or remove the file yourself')
    lock_state()   # one guard per pause file: a pid in the file proves nothing (it may be reused after a crash), the lock does
    if os.path.lexists(PAUSE_FILE) and not is_guard_pause(PAUSE_FILE):   # again, now that no other guard can be changing it
        fail(f'the file {PAUSE_FILE} appeared or changed since the start check and is not a pause file of this guard: it is left untouched')
    if not LOCKING:   # no lock on this platform: the heartbeat and the pid are all there is
        owner, valid_until = None, 0
        try:
            with open(PAUSE_FILE) as f:
                doc = json.load(f)
            owner, valid_until = doc.get('pid'), doc.get('valid_until') or 0
        except Exception:
            pass
        if owner is not None and owner != os.getpid() and valid_until > time.time() and pid_alive(owner):
            fail(f'the pause file {PAUSE_FILE} belongs to the running process {owner}: another guard uses it; two guards must not share one pause_file')
    state = load_state()
    if state.get('paused'):
        if state.get('resume_at') and time.time() < state['resume_at']:
            log(f'start during a pause, resume at {ts(state["resume_at"])}')
            hook_check('start')   # the restored pause is republished on every tick: say so when no hook would observe it
        else:
            try:
                leave_pause(state, 'stored pause already over at start')
            except Exception as e:   # the pause file stays (the state keeps the pause, the next tick tries again) or the state file cannot be written
                log(f'ERROR: cannot leave the stored pause cleanly at start, the next tick tries again: {e!r}')
    else:
        log(f'guard start (threshold {A.threshold} %, margin {A.margin:.0f} s, exclude {EXCLUDE})')
        hook_check('start')
        if not drop_leftover_pause():   # a leftover pause file without state must not hold anything
            log(f'ERROR: cannot remove the leftover pause file {PAUSE_FILE}: stopping, the service manager starts the guard again')
            return 1
    try:
        while not STOP:
            started = time.monotonic()
            ok = safe_tick(state)
            if A.once or A.dry_run:
                return 0 if ok else 1
            end = started + A.interval   # monotonic: a step of the wall clock must not stretch or cut the wait
            while not STOP and time.monotonic() < end:
                time.sleep(min(1.0, max(0.0, end - time.monotonic())))
    finally:
        if not (A.once or A.dry_run) and (state.get('paused') or state.get('unlink_pending')):
            # orderly exit never leaves sessions waiting; a restart re-enters the pause from the first fresh reading of the cache
            try:
                if state.get('paused'):
                    leave_pause(state, 'guard stopping')
                elif unpublish():   # the state is already unpaused and only the removal of the file is pending: one last try
                    state.pop('unlink_pending', None)
                    log('RESUMED (guard stopping): pause file removed')
            except Exception as e:
                log(f'ERROR: cannot clean up on exit: {e!r}')
            if (state.get('paused') or state.get('unlink_pending')) and unpublish():
                # the unpaused state could not be written, or the first removal failed: the sessions are still released (a restart
                # reads a stored pause and keeps it only while it lasts)
                log('RESUMED (guard stopping, state not saved): pause file removed' if state.get('paused') else 'RESUMED (guard stopping, second try): pause file removed')


if __name__ == '__main__':
    sys.exit(main())
