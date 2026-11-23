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
import argparse, datetime, json, math, os, shlex, signal, sys, time

try:
    import fcntl
except ImportError:   # Windows: no lock between two guards
    fcntl = None

HOOK_NAME = 'five-hour-guard-hook.py'
MAX_RESET_AHEAD_S = 5 * 3600 + 900   # a window is 5 h long: a reset time further ahead is not believed (15 min of slack)
MAX_MARGIN_S = 1800
MAX_HEARTBEAT_S = 1800               # the hook ignores a valid_until more than 3600 s ahead
MAX_TEST_PAUSE_S = 1800
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
ap.add_argument('--heartbeat', type=finite_float, default=300, help=f'pause file validity after each tick; the hook lets sessions go when it lapses (guard dead); from twice --interval to {MAX_HEARTBEAT_S}')
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
check_range('--interval', A.interval, MIN_INTERVAL_S)
check_range('--heartbeat', A.heartbeat, 2 * A.interval, MAX_HEARTBEAT_S)   # a pause must outlive one missed tick
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
    if required and not v:
        fail(f'"{key}" is not set: give it in the configuration file (--config or OMC_FIVE_HOUR_GUARD_CONFIG) or on the command line')
    return v or ''


def default_usage_cache():
    """The file OMC's status line and `omc wait` write (src/hud/usage-api.ts); the guard only reads it."""
    base = os.environ.get('CLAUDE_CONFIG_DIR', '').strip() or '~/.claude'
    return os.path.join(os.path.expanduser(base), 'plugins', 'oh-my-claudecode', '.usage-cache-anthropic.json')


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
check_writable_dir(PAUSE_FILE, 'pause_file')
if STATE:
    check_writable_dir(STATE, 'state_file')


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
    return datetime.datetime.fromtimestamp(t if t is not None else time.time()).strftime('%Y-%m-%d %H:%M:%S')


def log(msg):
    line = f'{ts()} {msg}'
    print(line, flush=True)
    if LOG and not A.dry_run:
        try:
            with open(LOG, 'a') as f:
                f.write(line + '\n')
        except Exception:
            pass


def write_json(path, obj):
    if A.dry_run:
        return
    tmp = f'{path}.{os.getpid()}.tmp'
    with open(tmp, 'w') as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def load_state():
    """The stored state, or a fresh one when the file is missing or does not have the shape this guard writes."""
    try:
        with open(STATE) as f:
            st = json.load(f)
        if st.get('paused') is not True:
            return {'paused': False}
        if all(type(st.get(k)) in (int, float) and math.isfinite(st[k]) for k in ('since', 'resume_at')):
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
        age = time.time() - float(seen_ms or 0) / 1000
        x = d.get('data') or {}
        reset = x.get('fiveHourResetsAt')
        reset_ts = datetime.datetime.fromisoformat(reset.replace('Z', '+00:00')).timestamp() if reset else None
        pct = x.get('fiveHourPercent')
        pct = float(pct) if pct is not None else None
    except FileNotFoundError:
        return None, None, 1e9, ('cache-missing', f'the usage cache {CACHE} does not exist: {NEEDS}')
    except Exception as e:
        return None, None, 1e9, ('cache-unreadable', f'cannot read the usage cache {CACHE}: {e!r}')
    problem = None
    if pct is None:
        problem = ('cache-no-percent', f'the usage cache {CACHE} has no fiveHourPercent (no five-hour window on this account?): {NEEDS}')
    elif not math.isfinite(pct) or pct < 0:
        pct = None
        problem = ('cache-invalid-percent', f'the usage cache {CACHE} has a fiveHourPercent that is not a percentage (not finite or negative): it is not acted on')
    elif not age <= A.max_age:   # not "age > max": a timestamp that is not a number gives an age that is neither
        problem = ('cache-stale', f'the usage data is {age:.0f} s old, older than --max-age ({A.max_age:g} s), so it is not acted on: {NEEDS}')
    return pct, reset_ts, age, problem


def hook_check(where):
    """A pause with no registered hook holds nothing: say so loudly (a later settings rewrite could drop the entry)."""
    if not SETTINGS:
        return
    try:
        with open(SETTINGS) as f:
            data = json.load(f)
        groups = data.get('hooks', {}).get('PreToolUse', [])
        ours = [h.get('command') or '' for g in groups for h in g.get('hooks', []) if HOOK_NAME in (h.get('command') or '')]
    except Exception as e:
        log(f'WARNING ({where}): cannot read the hook entries of {SETTINGS}: {e!r}')
        return
    if not ours:
        log(f'WARNING ({where}): hook {HOOK_NAME} is NOT registered in {SETTINGS}: a pause would hold no session. Run five-hour-guard-settings.py add')
    for command in ours:
        try:
            paths = [t for t in shlex.split(command) if t.endswith(HOOK_NAME)]
        except ValueError:
            paths = []
        for path in paths:
            if not os.path.isfile(path):
                log(f'WARNING ({where}): the hook entry in {SETTINGS} names {path}, which does not exist: the shell guard of the entry lets every call through, so a pause would hold no session')
        try:
            tokens = shlex.split(command)
        except ValueError:
            continue
        if '--pause-file' in tokens[:-1]:
            read = tokens[tokens.index('--pause-file') + 1]
            if os.path.abspath(read) != os.path.abspath(PAUSE_FILE):
                log(f'WARNING ({where}): the hook entry in {SETTINGS} reads the pause file {read}, but the guard writes {PAUSE_FILE}: a pause would hold no session. Run five-hour-guard-settings.py add again')
        if '-x' in tokens[:-1]:
            interpreter = tokens[tokens.index('-x') + 1]
            if not os.access(interpreter, os.X_OK):
                log(f'WARNING ({where}): the hook entry in {SETTINGS} names the interpreter {interpreter}, which does not exist or cannot be run: the shell guard of the entry lets every call through, so a pause would hold no session')


def publish(state, pct=None, only=None):
    """(Re)write the pause file the hook reads. Atomic; called every tick while paused."""
    now = time.time()
    doc = {'v': 2, 'paused': True, 'since': state['since'], 'resume_at': state['resume_at'],
           'valid_until': now + A.heartbeat, 'exclude': EXCLUDE, 'percent': pct, 'pid': os.getpid()}
    if only:
        doc['only'] = only
    write_json(PAUSE_FILE, doc)


def unpublish():
    if A.dry_run:
        return
    try:
        os.unlink(PAUSE_FILE)
    except FileNotFoundError:
        pass
    except Exception as e:
        log(f'cannot remove pause file: {e!r}')


def enter_pause(state, pct, reset_ts):
    state.update(paused=True, since=time.time(), resume_at=reset_ts + A.margin)
    log(f'THRESHOLD: 5h {pct} %, reset {ts(reset_ts)}; pause until {ts(state["resume_at"])}')
    hook_check('pause start')
    if A.dry_run:
        return
    publish(state, pct)
    write_json(STATE, state)


def leave_pause(state, why):
    unpublish()
    log(f'RESUMED ({why}): pause file removed, waiting tool calls continue')
    state.update(paused=False, since=None, resume_at=None)
    write_json(STATE, state)


def tick(state):
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
    # paused
    if fresh and pct < RESUME_BELOW:
        leave_pause(state, f'window reset seen early: 5h {pct} %')
        return
    if now >= state['resume_at']:
        if fresh and pct >= A.threshold and reset_ts and reset_ts <= now + MAX_RESET_AHEAD_S and reset_ts + A.margin > now:
            state['resume_at'] = reset_ts + A.margin
            log(f'reset slipped: 5h still {pct} %, new resume time {ts(state["resume_at"])}')
        else:
            leave_pause(state, 'reset time reached' + ('' if fresh else ' (cache stale, fail-open)'))
            return
    publish(state, pct)
    write_json(STATE, state)


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
    except OSError:
        return False
    return True


def drop_leftover_pause():
    """A pause file with no state behind it is a leftover of a dead guard: remove it. One that names a live process (another
    guard that shares this pause file) stays."""
    try:
        with open(PAUSE_FILE) as f:
            pid = json.load(f).get('pid')
    except Exception:
        pid = None
    if pid != os.getpid() and pid_alive(pid):
        log(f'WARNING (start): the pause file {PAUSE_FILE} belongs to the running process {pid}, left in place; two guards must not share one pause file')
        return
    unpublish()


LOCK_FD = None


def lock_state():
    """One guard per state file. flock on a sibling file: the state file itself is replaced on every write, so every write
    would give it a new inode and a new lock."""
    global LOCK_FD
    if fcntl is None or A.dry_run or A.test_pause:
        return
    path = STATE + '.lock'
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        fail(f'another guard holds {path}: one guard per state file')
    LOCK_FD = fd   # held until the process ends


def on_signal(signum, _frame):
    global STOP
    STOP = True


def test_pause():
    if os.path.exists(PAUSE_FILE):
        fail(f'--test-pause refused: {PAUSE_FILE} exists (a pause is in force or a test is running); the test would overwrite it and remove it at the end')
    now = time.time()
    st = {'since': now, 'resume_at': now + A.test_pause}
    A.heartbeat = A.test_pause + 5
    publish(st, only=ONLY)
    log(f'test pause: pause file written for {A.test_pause:.0f} s (exclude {EXCLUDE}, only {ONLY or "all sessions"})')
    end = now + A.test_pause
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
            unpublish()
            log('test pause over: pause file removed')
        else:
            log('test pause over: the pause file is gone or no longer ours (a real pause may have started), left alone')


def main():
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    if A.test_pause:
        return test_pause()
    lock_state()
    state = load_state()
    if state.get('paused'):
        if state.get('resume_at') and time.time() < state['resume_at']:
            log(f'start during a pause, resume at {ts(state["resume_at"])}')
        else:
            leave_pause(state, 'stored pause already over at start')
    else:
        log(f'guard start (threshold {A.threshold} %, margin {A.margin:.0f} s, exclude {EXCLUDE})')
        hook_check('start')
        drop_leftover_pause()  # a leftover pause file without state must not hold anything
    try:
        while not STOP:
            ok = safe_tick(state)
            if A.once or A.dry_run:
                return 0 if ok else 1
            end = time.monotonic() + A.interval   # monotonic: a step of the wall clock must not stretch or cut the wait
            while not STOP and time.monotonic() < end:
                time.sleep(min(1.0, max(0.0, end - time.monotonic())))
    finally:
        if not (A.once or A.dry_run) and state.get('paused'):
            # orderly exit never leaves sessions waiting; a restart re-enters the pause from the first fresh reading of the cache
            try:
                leave_pause(state, 'guard stopping')
            except Exception as e:
                log(f'ERROR: cannot clean up on exit: {e!r}')


if __name__ == '__main__':
    sys.exit(main())
