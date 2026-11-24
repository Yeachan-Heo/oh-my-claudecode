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
import argparse, json, os, re, shlex, subprocess, sys, time

MARK = 'five-hour-guard-hook.py'

ap = argparse.ArgumentParser()
ap.add_argument('action', choices=['add', 'remove', 'check'])
ap.add_argument('--config', default=os.environ.get('OMC_FIVE_HOUR_GUARD_CONFIG'))
ap.add_argument('--settings', default=None)
ap.add_argument('--pause-file', default=None)
ap.add_argument('--hook-log', default=None, help='hook log file (config: hook_log_file); absent: the hook does not log')
ap.add_argument('--hook', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), MARK))
ap.add_argument('--python', default=sys.executable, help='interpreter written into the hook command (default: the one running this script)')
ap.add_argument('--timeout', type=int, default=21600, help='seconds; Claude Code cancels a hook that runs longer (on PreToolUse the tool call then goes on), so keep it above the longest pause (5 h window plus margin)')
A = ap.parse_args()
if A.timeout < 1:
    print(f'five-hour-guard-settings: --timeout must be at least 1 second, not {A.timeout}: Claude Code would cancel the hook at once', file=sys.stderr)
    sys.exit(2)


def fail(msg):
    print(f'five-hour-guard-settings: {msg}', file=sys.stderr)
    sys.exit(2)


CFG = {}
if A.config:
    try:
        with open(A.config) as f:
            CFG = json.load(f)
        if not isinstance(CFG, dict):
            raise ValueError('not a JSON object')
    except Exception as e:
        fail(f'cannot read configuration {A.config}: {e!r}')

for _key in ('settings_file', 'pause_file', 'hook_log_file'):
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


def command():
    # the shell pre-check keeps the cost outside a pause at ~2 ms per tool call (python alone ~35 ms); a missing hook or
    # interpreter file is fail-open too (exec of a missing file would exit 127 or 2; 2 is what a PreToolUse hook reports
    # as a blocking error). Needs a POSIX sh: sh -c on Linux and macOS, Git Bash on Windows.
    q = shlex.quote
    cmd = f'[ -f {q(PAUSE_FILE)} ] && [ -f {q(A.hook)} ] && [ -x {q(A.python)} ] || exit 0; exec {q(A.python)} -I {q(A.hook)} --pause-file {q(PAUSE_FILE)}'
    return cmd + (f' --log {q(HOOK_LOG)}' if HOOK_LOG else '')


OPERAND_OPTIONS = ('-f', '-x', '--pause-file', '--log')


def probe_hook():
    """Run the selected hook against a pause that this tool writes in a private directory: a valid pause must make it hold (it logs
    hold-start and keeps running) and the removal of the file must release it (exit 0). A file that is empty, truncated or another
    program with the name of the hook would exit at once and protect nothing."""
    import tempfile
    env = {k: v for k, v in os.environ.items() if k not in ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
                                                           'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY')}
    with tempfile.TemporaryDirectory(prefix='five-hour-guard-probe-') as d:
        pause, log = os.path.join(d, 'pause.json'), os.path.join(d, 'hook.log')
        now = time.time()
        with open(pause, 'w') as f:
            json.dump({'v': 2, 'paused': True, 'since': now, 'resume_at': now + 600, 'valid_until': now + 300, 'exclude': [], 'pid': os.getpid()}, f)
        try:
            p = subprocess.Popen([A.python, '-I', A.hook, '--pause-file', pause, '--log', log, '--poll', '0.1'], stdin=subprocess.PIPE,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        except OSError as e:
            fail(f'the hook {A.hook!r} cannot be started: {e!r}')
        try:
            try:
                p.stdin.write(b'{"session_id": "probe0001", "tool_name": "Bash"}')
                p.stdin.close()
            except OSError:
                pass
            end = time.monotonic() + 60
            while time.monotonic() < end and p.poll() is None and not (os.path.exists(log) and 'hold-start' in open(log).read()):
                time.sleep(0.05)
            if p.poll() is not None or not os.path.exists(log):
                fail(f'the hook {A.hook!r} does not hold a valid pause (it ended with status {p.poll()} at once): it is not the hook of the guard, so the entry would protect nothing')
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


def hook_scripts(command):
    """The hook scripts a command runs: the command word of a simple command, or the first argument after it when the command
    word is a Python or the command carries --pause-file. A file name that stands as an operand (of -f, -x, --pause-file,
    --log, or of another program) is data, not our hook (the same rule as the guard). Raises ValueError for a command the shell
    cannot parse or one with a NUL character."""
    tokens = shlex.split(command)
    if any('\0' in t for t in tokens):
        raise ValueError('NUL character in the command')
    simple, current = [], []
    for t in tokens:
        if t in (';', '&&', '||', '|'):
            simple.append(current)
            current = []
        elif len(t) > 1 and t.endswith(';'):
            simple.append(current + [t[:-1]])
            current = []
        else:
            current.append(t)
    simple.append(current)
    hooks = []
    for words in simple:
        operands = {i + 1 for i, t in enumerate(words[:-1]) if t in OPERAND_OPTIONS}
        first = 0
        while first < len(words) and (words[first] in ('exec', 'env', 'command') or re.match(r'[A-Za-z_]\w*=', words[first])):
            first += 1
        if first >= len(words) or first in operands:
            continue
        if MARK in os.path.basename(words[first]):
            hooks.append(words[first])
        elif re.match(r'(python|pypy|py$)', os.path.basename(words[first]).lower()) or '--pause-file' in words:
            args = [i for i in range(first + 1, len(words)) if i not in operands and not words[i].startswith('-')]
            if args and MARK in os.path.basename(words[args[0]]):
                hooks.append(words[args[0]])
    return hooks


def hook_is_ours(h):
    # a handler of another type (prompt, http) does not run a command: it is not our hook, whatever its command field says; a
    # command that only names the hook file as data (an audit tool's argument) is not our hook either. A command that cannot be
    # parsed and holds the name is ours (the guard warns about it and `add` is the repair it recommends).
    command = h.get('command')
    if h.get('type') != 'command' or not isinstance(command, str) or MARK not in command:
        return False
    try:
        return bool(hook_scripts(command))
    except ValueError:
        return True


def is_ours(group):
    return any(hook_is_ours(h) for h in group.get('hooks', []))


def without_ours(group):
    """The group minus our hooks, or None when nothing else is left in it."""
    rest = [h for h in group.get('hooks', []) if not hook_is_ours(h)]
    return {**group, 'hooks': rest} if rest else None


def read_settings():
    """(raw bytes, snapshot, mode) of settings.json, or (None, None, None) when it does not exist."""
    try:
        with open(SETTINGS, 'rb') as f:
            raw = f.read()
            st = os.fstat(f.fileno())
    except FileNotFoundError:
        return None, None, None
    except Exception as e:
        fail(f'cannot read {SETTINGS}: {e!r}')
    return raw, (raw, st.st_mtime_ns), st.st_mode & 0o7777


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
                    ('settings tool script', os.path.abspath(__file__)), ('guard script', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'five-hour-guard.py'))]
        # the files the guard writes or reads under the same configuration: registering must not make one of them settings.json
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
