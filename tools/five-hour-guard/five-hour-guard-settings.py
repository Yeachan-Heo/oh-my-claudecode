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
# The hook entry is identified by the file name five-hour-guard-hook.py in its command, so `add` twice is a no-op and `add`
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
import argparse, json, os, shlex, subprocess, sys, time

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

CONFIG_DIR = os.path.expanduser((os.environ.get('CLAUDE_CONFIG_DIR') or '').strip() or '~/.claude')
SETTINGS = A.settings or CFG.get('settings_file') or os.path.join(CONFIG_DIR, 'settings.json')
PAUSE_FILE = A.pause_file or CFG.get('pause_file')
HOOK_LOG = A.hook_log if A.hook_log is not None else CFG.get('hook_log_file')


class Changed(Exception):
    """settings.json is not what this run read."""


def command():
    # the shell pre-check keeps the cost outside a pause at ~2 ms per tool call (python alone ~35 ms); a missing hook or
    # interpreter file is fail-open too (exec of a missing file would exit 127 or 2; 2 is what a PreToolUse hook reports
    # as a blocking error). Needs a POSIX sh: sh -c on Linux and macOS, Git Bash on Windows.
    q = shlex.quote
    cmd = f'[ -f {q(PAUSE_FILE)} ] && [ -f {q(A.hook)} ] && [ -x {q(A.python)} ] || exit 0; exec {q(A.python)} -I {q(A.hook)} --pause-file {q(PAUSE_FILE)}'
    return cmd + (f' --log {q(HOOK_LOG)}' if HOOK_LOG else '')


def hook_is_ours(h):
    return MARK in (h.get('command') or '')


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
    if not isinstance(pre, list) or not all(isinstance(g, dict) and isinstance(g.get('hooks', []), list) for g in pre):
        fail(f'{SETTINGS}: "hooks" / "PreToolUse" do not have the shape of a Claude Code settings file (an object holding a list of groups)')
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
        distinct = [('pause file', PAUSE_FILE), ('hook log', HOOK_LOG), ('settings file', SETTINGS), ('hook', A.hook), ('interpreter', A.python)]
        for i, (la, pa) in enumerate(distinct):
            for lb, pb in distinct[i + 1:]:
                if pa and pb and (os.path.realpath(pa) == os.path.realpath(pb) or (os.path.exists(pa) and os.path.exists(pb) and os.path.samefile(pa, pb))):
                    fail(f'the {la} ({pa}) and the {lb} ({pb}) are the same file: the hook or the guard would overwrite one as the other')
        try:
            probe = subprocess.run([A.python, '-I', '-c', 'import json, math, os, sys, time, urllib.parse; compile(open(sys.argv[1]).read(), sys.argv[1], "exec")', A.hook],
                                   capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as e:
            fail(f'the interpreter {A.python!r} cannot run the hook: {e!r}')
        if probe.returncode != 0:
            fail(f'the interpreter {A.python!r} cannot run the hook (it must be Python 3 with the standard library): {probe.stderr.strip()[-300:]}')
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
