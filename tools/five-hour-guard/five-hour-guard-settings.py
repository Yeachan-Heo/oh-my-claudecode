#!/usr/bin/env python3
# Registers / removes / checks the PreToolUse hook of the five-hour limit guard in a Claude Code settings.json.
#   five-hour-guard-settings.py add    [--config F] [--settings F] [--pause-file P] [--hook-log L] [--hook H] [--python BIN] [--timeout S]
#   five-hour-guard-settings.py remove [--config F] [--settings F]
#   five-hour-guard-settings.py check  [--config F] [--settings F]
# `add` and `remove` write a timestamped backup next to the file, then replace the file atomically; the formatting of the
# rest of the file is preserved byte for byte when the file is a json round trip with indent=2 (what Claude Code writes).
# A settings.json that is a symbolic link is written through: the file it points to is replaced and the link stays a link.
# The temporary file and the backup are created readable by the owner only and get the mode of the original before any
# content is written (settings.json can hold tokens in "env"). Another program may write the file while this tool works:
# after the backup is made and right before the replace the tool compares the file with what it read, reads again once when
# it differs, and gives up (exit 2, nothing written) when it differs again. The instant between that comparison and the
# rename remains: a rename has no compare-and-swap, so a write inside it is lost. Run `check` after `add` to see the result.
# The hook entry is identified by the file name five-hour-guard-hook.py as the script of its command (the command word, or the argument
# of a Python, or of a command that carries --pause-file); a command that only names that file as data (an operand of -f, -x,
# --pause-file or --log, an argument of an audit tool) is not ours and is never changed. So `add` twice is a no-op and `add`
# with another hook path replaces the entry in place, in one write (there is no moment without a hook entry). Only our hook
# is touched: when a group of settings.json holds our hook next to another one, the other hook stays (in a group of its
# own, matcher kept). `add` refuses (exit 2) a hook, interpreter or pause path that is not absolute and a hook or
# interpreter file that does not exist, and a hook file whose name does not contain five-hour-guard-hook.py (the entry could
# not be found again by `check` and `remove`).
# A missing settings.json: `add` creates it (an empty object plus the entry, mode 0600; the directory must exist),
# `remove` has nothing to do (exit 0), `check` reports "not installed" (exit 1).
# Configuration: the same JSON file as the guard (--config or OMC_FIVE_HOUR_GUARD_CONFIG); keys used here: settings_file,
# pause_file, hook_log_file. Without a settings path the file is $CLAUDE_CONFIG_DIR/settings.json (surrounding blanks
# removed, a leading ~ expanded, as the guard and OMC do), else ~/.claude/settings.json.
# --hook defaults to the hook script next to this script, --python to the interpreter that runs this script.
import argparse, json, os, subprocess, sys, time

MARK = 'five-hour-guard-hook.py'   # also in five_hour_guard_entry.py, which is loaded below

ap = argparse.ArgumentParser()
ap.add_argument('action', choices=['add', 'remove', 'check'])
ap.add_argument('--config', default=os.environ.get('OMC_FIVE_HOUR_GUARD_CONFIG'))
ap.add_argument('--settings', default=None)
ap.add_argument('--pause-file', default=None)
ap.add_argument('--hook-log', default=None, help='hook log file (config: hook_log_file); absent: the hook does not log')
ap.add_argument('--hook', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), MARK))
ap.add_argument('--python', default=sys.executable, help='interpreter written into the hook command (default: the one running this script)')
ap.add_argument('--timeout', type=int, default=21600, help='seconds, at least 21600; Claude Code cancels a hook that runs longer (on PreToolUse the tool call then goes on), so it must cover the longest pause (5 h window plus margin)')
A = ap.parse_args()


def fail(msg):
    print(f'five-hour-guard-settings: {msg}', file=sys.stderr)
    sys.exit(2)


MAX_JSON_BYTES = 4 * 1024 * 1024   # settings.json and the configuration file are far smaller
CFG = {}
if A.config:
    try:
        with open(A.config, 'rb') as f:
            raw_config = f.read(MAX_JSON_BYTES + 1)   # a path replaced by a huge file is not read in full
        if len(raw_config) > MAX_JSON_BYTES:
            raise ValueError(f'the file is larger than {MAX_JSON_BYTES} bytes')
        CFG = json.loads(raw_config)
        if not isinstance(CFG, dict):
            raise ValueError('not a JSON object')
    except Exception as e:
        fail(f'cannot read configuration {A.config}: {e!r}')

for _key in ('settings_file', 'pause_file', 'hook_log_file', 'state_file', 'log_file', 'usage_cache'):   # every key of the guard that the checks here use
    if CFG.get(_key) is not None and not isinstance(CFG[_key], str):
        fail(f'"{_key}" must be a string (a file path), not {CFG[_key]!r}')
    if CFG.get(_key) and '\0' in CFG[_key]:
        fail(f'"{_key}" holds a NUL character: not a file path')

def claude_config_dir():
    """Claude Code configuration directory as OMC resolves it (src/utils/config-dir.ts): CLAUDE_CONFIG_DIR with surrounding
    blanks removed; ~, ~/x and ~\\x are expanded (both separators), anything else is kept; default ~/.claude."""
    home = os.path.expanduser('~')
    configured = (os.environ.get('CLAUDE_CONFIG_DIR') or '').strip()
    if not configured:
        return os.path.normpath(os.path.join(home, '.claude'))
    if configured == '~':
        return os.path.normpath(home)
    if configured.startswith('~/') or configured.startswith('~\\'):
        return os.path.normpath(os.path.join(home, configured[2:]))
    return os.path.normpath(configured)


CONFIG_DIR = claude_config_dir()
SETTINGS = A.settings or CFG.get('settings_file') or os.path.join(CONFIG_DIR, 'settings.json')
PAUSE_FILE = A.pause_file or CFG.get('pause_file')
HOOK_LOG = A.hook_log if A.hook_log is not None else CFG.get('hook_log_file')


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


# every action may replace settings.json, `add` may name a pause file and a hook log: none of them may be the configuration file
if A.config and SETTINGS and same_file(A.config, SETTINGS):
    fail(f'the configuration file ({A.config}) and the settings file ({SETTINGS}) are the same file: the tool would overwrite the configuration')


class Changed(Exception):
    """settings.json is not what this run read."""


def load_entry_module():
    """five_hour_guard_entry.py next to this script: the one definition of the hook entry, shared with the guard."""
    import importlib.util
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'five_hour_guard_entry.py')
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
if not ENTRY.timeout_ok(A.timeout):   # the test the guard applies to the entries it finds: below the minimum, or an integer too large to be a finite number
    shown = str(A.timeout)
    fail(f'--timeout must be at least {ENTRY.MIN_TIMEOUT_S} seconds and a finite number, not {shown if len(shown) <= 40 else shown[:40] + "..."}: Claude Code cancels a hook that runs longer and the tool call goes on, so a pause can last longer than the hook would wait')


def command():
    return ENTRY.entry_command(PAUSE_FILE, A.hook, A.python, HOOK_LOG)


def probe_hook(with_log=True):
    """Run the entry that `add` is about to write, through the shell as Claude Code runs it, against a pause that this tool writes in a
    private directory: a valid pause must make it hold (the hook logs hold-start and keeps running for a moment) and the removal of
    the file must release it (exit 0). An empty or truncated hook, another program with the name of the hook, or a command that
    does not run the hook would exit at once and protect nothing. with_log False: the command without --log (what is installed when no hook
    log is set), where the hold cannot be seen in a log and the process must simply keep running. Nothing is added to the command (the
    hook polls every 2 s, so the release can take that long), and only the paths of the pause and the log are the probe's own."""
    import tempfile
    env = {k: v for k, v in os.environ.items() if k not in ENTRY.PROVIDER_ENV_KEYS}   # a session of another provider is never held: the probe must not look like one
    with tempfile.TemporaryDirectory(prefix='five-hour-guard-probe-') as d:
        pause, log = os.path.join(d, 'pause.json'), os.path.join(d, 'hook.log')
        now = time.time()
        with open(pause, 'w') as f:
            json.dump({'v': 2, 'paused': True, 'since': now, 'resume_at': now + 600, 'valid_until': now + 300, 'exclude': [], 'pid': os.getpid()}, f)
        probe_command = ENTRY.entry_command(pause, A.hook, A.python, log if with_log else None)   # the installed argument shape, nothing added: a hook may depend on the arguments it is given
        try:
            p = subprocess.Popen(['sh', '-c', probe_command], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        except OSError as e:
            fail(f'the hook entry cannot be run through the shell: {e!r}')
        try:
            try:
                p.stdin.write(b'{"session_id": "probe0001", "tool_name": "Bash"}')
                p.stdin.close()
            except OSError:
                pass
            end = time.monotonic() + 60
            while with_log and time.monotonic() < end and p.poll() is None and not (os.path.exists(log) and 'hold-start' in open(log).read()):
                time.sleep(0.05)
            if not with_log:
                time.sleep(0.5)
                if p.poll() is not None:
                    fail(f'the hook {A.hook!r} does not hold a valid pause when it is run without --log, as the entry that add installs runs it while no hook log is set (the entry ended with status {p.poll()} at once): the entry would protect nothing')
            elif p.poll() is not None or not os.path.exists(log):
                fail(f'the hook {A.hook!r} does not hold a valid pause (the entry ended with status {p.poll()} at once): it is not the hook of the guard, so the entry would protect nothing')
            time.sleep(1.5)   # a hook that lets go by itself while the pause is in force protects nothing: it must still be holding
            if p.poll() is not None:
                fail(f'the hook {A.hook!r} ended with status {p.returncode} while the pause was still in force: it does not hold, so the entry would protect nothing')
            os.unlink(pause)
            try:
                p.wait(timeout=30)
            except subprocess.TimeoutExpired:
                fail(f'the hook {A.hook!r} does not release when the pause file is removed')
            if p.returncode != 0:
                fail(f'the hook {A.hook!r} ended with status {p.returncode} after the pause was removed (it must exit 0)')
        finally:
            if p.poll() is None:
                p.kill()
                p.wait()


def hook_is_ours(h):
    # a handler of another type (prompt, http) does not run a command: it is not our hook, whatever its command field says; a
    # command that only names the hook file as data (an audit tool's argument) is not our hook either. A command that cannot be
    # parsed and holds the name is ours (the guard warns about it and `add` is the repair it recommends).
    command = h.get('command')
    if h.get('type') != 'command' or not isinstance(command, str) or MARK not in command:
        return False
    try:
        return bool(ENTRY.entry_parts(command)[0])
    except ValueError:
        return True


def is_ours(group):
    return any(hook_is_ours(h) for h in group.get('hooks', []))


def without_ours(group):
    """The group minus our hooks, or None when nothing else is left in it."""
    rest = [h for h in group.get('hooks', []) if not hook_is_ours(h)]
    return {**group, 'hooks': rest} if rest else None


def read_settings():
    """(raw bytes, snapshot, mode) of settings.json, or (None, None, None) when it does not exist. The snapshot is what the final comparison
    looks at: the bytes, the modification time and the mode (a chmod changes neither of the first two, and the write would undo it)."""
    try:
        with open(SETTINGS, 'rb') as f:
            raw = f.read(MAX_JSON_BYTES + 1)
            st = os.fstat(f.fileno())
        if len(raw) > MAX_JSON_BYTES:
            fail(f'{SETTINGS} is larger than {MAX_JSON_BYTES} bytes: it is not read')
    except FileNotFoundError:
        return None, None, None
    except Exception as e:
        fail(f'cannot read {SETTINGS}: {e!r}')
    return raw, (raw, st.st_mtime_ns, st.st_mode & 0o7777), st.st_mode & 0o7777


def write_private(path, data, mode, mtime_ns=None):
    """Create `path` (it must not exist) readable by the owner only, give it `mode`, then write `data`: the content is
    never visible under a wider mode than the original had."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_BINARY', 0), 0o600)
    with os.fdopen(fd, 'wb') as f:
        if hasattr(os, 'fchmod'):
            os.fchmod(f.fileno(), mode)
        f.write(data)
    if mtime_ns is not None:
        os.utime(path, ns=(mtime_ns, mtime_ns))


def store(raw, snapshot, mode, out):
    """Replace settings.json (or the file a link points to) by `out`, after a backup; Changed when the file is not what was read."""
    target = os.path.realpath(SETTINGS)
    tmp = f'{target}.{os.getpid()}.tmp'
    write_private(tmp, out, mode if raw is not None else 0o600)
    backup = None
    made = []   # files this run created and must remove when it does not replace settings.json
    try:
        if raw is not None:
            backup = f"{SETTINGS}.before-five-hour-guard-{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}"
            write_private(backup, raw, mode, snapshot[1])
            made.append(backup)
        # the comparison comes last, right before the replace: a write that lands while the backup is made is seen too
        if read_settings()[1] != snapshot:
            raise Changed()
        os.replace(tmp, target)
    except BaseException:
        for path in [tmp] + made:
            try:
                os.unlink(path)
            except OSError:
                pass
        raise
    return backup


def run_once():
    raw, snapshot, mode = read_settings()
    if raw is None:
        if A.action == 'check':
            print(f'{SETTINGS}: does not exist, the guard hook is not installed')
            sys.exit(1)
        if A.action == 'remove':
            print('no settings file, nothing to do')
            sys.exit(0)
        data = {}
        if not os.path.isdir(os.path.dirname(os.path.realpath(SETTINGS))):
            fail(f'the directory of {SETTINGS} does not exist')
    else:
        try:
            data = json.loads(raw.decode('utf-8'))
        except Exception as e:
            fail(f'cannot read {SETTINGS}: {e!r}')
    if not isinstance(data, dict):
        fail(f'{SETTINGS} does not hold a JSON object')
    hooks = data.get('hooks', {})
    pre = hooks.get('PreToolUse', []) if isinstance(hooks, dict) else None
    if not isinstance(pre, list) or not all(isinstance(g, dict) and isinstance(g.get('hooks', []), list)
                                        and all(isinstance(h, dict) and ('command' not in h or isinstance(h['command'], str)) for h in g.get('hooks', [])) for g in pre):
        fail(f'{SETTINGS}: "hooks" / "PreToolUse" do not have the shape of a Claude Code settings file (an object holding a list of groups, each with a list of hook objects whose command is text)')
    ours = [g for g in pre if is_ours(g)]

    if A.action == 'check':
        print(f'{SETTINGS}: {len(ours)} entry/entries of the guard hook')
        for g in ours:
            for h in g['hooks']:
                print(f"  matcher={g.get('matcher')} timeout={h.get('timeout')} command={h.get('command')}")
        sys.exit(0 if ours else 1)

    if A.action == 'add':
        if not PAUSE_FILE:
            fail('"pause_file" is not set: give it in the configuration file or with --pause-file')
        for label, path in (('pause file', PAUSE_FILE), ('hook', A.hook), ('interpreter', A.python), ('hook log', HOOK_LOG)):
            if path and not os.path.isabs(path):
                fail(f'the {label} path {path!r} is not absolute: the hook runs in whatever directory a session has')
        for label, path in (('hook', A.hook), ('interpreter', A.python)):
            if not os.path.isfile(path):
                fail(f'the {label} {path!r} does not exist: the entry would be written but the shell guard of the command would let every call through')
        if not os.access(A.python, os.X_OK):
            fail(f'the interpreter {A.python!r} is not executable: the shell guard of the command (`[ -x ... ]`) would let every call through')
        distinct = [('pause file', PAUSE_FILE), ('hook log', HOOK_LOG), ('settings file', SETTINGS), ('hook', A.hook), ('interpreter', A.python), ('configuration file', A.config),
                    ('settings tool script', os.path.abspath(__file__)), ('guard script', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'five-hour-guard.py')),
                    ('entry module', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'five_hour_guard_entry.py'))]
        # the files the guard writes or reads under the same configuration: registering must not make one of them settings.json
        bundled = os.path.join(os.path.dirname(os.path.abspath(__file__)), MARK)   # the guard refuses any output that is this file, whichever hook is registered
        if not same_file(bundled, A.hook):
            distinct.append(('bundled hook script', bundled))
        for key, label in (('state_file', 'state file'), ('log_file', 'guard log')):
            if isinstance(CFG.get(key), str) and CFG[key]:
                distinct.append((label, CFG[key]))
        # the usage cache is a configured file even when the configuration leaves it out: the guard then reads OMC's default one
        cache = CFG['usage_cache'] if isinstance(CFG.get('usage_cache'), str) and CFG['usage_cache'] else os.path.join(CONFIG_DIR, 'plugins', 'oh-my-claudecode', '.usage-cache-anthropic.json')
        distinct += [('usage cache', cache), ('usage cache lock file', cache + '.lock')]
        if isinstance(CFG.get('state_file'), str) and CFG['state_file']:
            distinct.append(('state lock file', CFG['state_file'] + '.lock'))
        if PAUSE_FILE:
            distinct.append(('pause lock file', PAUSE_FILE + '.lock'))
        for i, (la, pa) in enumerate(distinct):
            for lb, pb in distinct[i + 1:]:
                if pa and pb and same_file(pa, pb):
                    fail(f'the {la} ({pa}) and the {lb} ({pb}) are the same file: the hook or the guard would overwrite one as the other')
        try:
            # the answer is computed from a random number that only a Python that runs the code can know: a wrapper that ignores its
            # arguments and exits 0 is not an interpreter
            nonce = int.from_bytes(os.urandom(4), 'big')
            probe = subprocess.run([A.python, '-I', '-c', 'import json, math, os, sys, time, urllib.parse; compile(open(sys.argv[1]).read(), sys.argv[1], "exec"); print(int(sys.argv[2]) * 3 + 1)', A.hook, str(nonce)],
                                   capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as e:
            fail(f'the interpreter {A.python!r} cannot run the hook: {e!r}')
        if probe.returncode != 0 or probe.stdout.strip() != str(nonce * 3 + 1):
            fail(f'the interpreter {A.python!r} cannot run the hook (it must be Python 3 with the standard library): {probe.stderr.strip()[-300:] or "it did not run the check"}')
        probe_hook()
        if not HOOK_LOG:
            probe_hook(with_log=False)   # the entry that is installed has no --log: probe that shape too
        if MARK not in os.path.basename(A.hook):
            fail(f'the file name of the hook {A.hook!r} does not contain {MARK}: the entry is recognised by that name, so `check` and `remove` would not find it (copy the hook to another directory, keep its name)')
        entry = {'matcher': '*', 'hooks': [{'type': 'command', 'command': command(), 'timeout': A.timeout}]}
        if ours:
            if ours == [entry]:
                print('already registered, nothing to do')
                sys.exit(0)
            new_pre, placed = [], False
            for g in pre:
                if not is_ours(g):
                    new_pre.append(g)
                    continue
                if not placed:
                    new_pre.append(entry)   # our entry takes the place of the first group that held our hook, further copies are dropped
                    placed = True
                rest = without_ours(g)
                if rest:
                    new_pre.append(rest)    # a foreign hook that shared the group stays
            pre = new_pre
        else:
            pre = pre + [entry]
        data.setdefault('hooks', {})['PreToolUse'] = pre
    else:  # remove
        if not ours:
            print('no entry of the guard hook, nothing to do')
            sys.exit(0)
        data['hooks']['PreToolUse'] = [r for r in (without_ours(g) if is_ours(g) else g for g in pre) if r]
        if not data['hooks']['PreToolUse']:
            del data['hooks']['PreToolUse']

    out = (json.dumps(data, indent=2, ensure_ascii=False) + '\n').encode('utf-8')
    json.loads(out.decode('utf-8'))  # sanity
    backup = store(raw, snapshot, mode, out)
    print(f'{A.action}: done' + (f'; backup {backup}' if backup else '; the file did not exist, it was created'))


for attempt in (1, 2):
    try:
        run_once()
        break
    except Changed:
        if attempt == 2:
            fail(f'{SETTINGS} changed again while it was being updated: nothing was written, run the command again')
        print(f'five-hour-guard-settings: {SETTINGS} changed while it was being updated, reading it again', file=sys.stderr)
