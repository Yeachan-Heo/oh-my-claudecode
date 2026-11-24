"""The hook entry of the five-hour limit guard: the one definition of the command that is registered in settings.json and of how a
registered command is read. Loaded by five-hour-guard.py (drift check) and five-hour-guard-settings.py (add, check, remove, probe)
from the directory the scripts are in; it is not run by itself and the hook script does not need it."""
import os, re, shlex, sys

MARK = 'five-hour-guard-hook.py'
OPERAND_OPTIONS = ('-f', '-x', '--pause-file', '--log')
PYTHON_NAME = r'(python|pypy|py$)'
MIN_TIMEOUT_S = 21600   # the longest pause the guard writes is about 20700 s (a reset time at most 5 h 15 min ahead plus a margin of at most 30 min)


def handler_problems(handler):
    """What is wrong with a registered handler outside its command: it must run in the foreground (an asynchronous hook is fire and
    forget, the tool call goes on) and carry a timeout that covers a pause (Claude Code cancels a hook that runs longer and the tool
    call goes on). A list of sentences, empty when the handler is fine."""
    found = []
    if handler.get('async') not in (None, False):
        found.append('it is asynchronous (async), so the tool call goes on while the hook waits in the background')
    timeout = handler.get('timeout')
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout < MIN_TIMEOUT_S:
        found.append(f'its timeout ({timeout!r}) is missing or below {MIN_TIMEOUT_S} s, so Claude Code would cancel the hook during a long pause and the tool call would go on')
    return found


def entry_command(pause_file, hook, python, hook_log=None):
    """The command of the hook entry. The shell pre-check keeps the cost outside a pause at ~2 ms per tool call (python alone ~35 ms);
    a missing hook or interpreter file is fail-open too (exec of a missing file would exit 127 or 2; 2 is what a PreToolUse hook
    reports as a blocking error). Needs a POSIX sh: sh -c on Linux and macOS, Git Bash on Windows."""
    q = shlex.quote
    cmd = f'[ -f {q(pause_file)} ] && [ -f {q(hook)} ] && [ -x {q(python)} ] || exit 0; exec {q(python)} -I {q(hook)} --pause-file {q(pause_file)}'
    return cmd + (f' --log {q(hook_log)}' if hook_log else '')


def entry_parts(command):
    """(hook scripts, interpreter files, log files, pause files, preflight files, launchers) that a hook entry command names, by the
    option or position they stand at: operands of -f, -x, --pause-file and --log are not scripts, whatever their file names say, and
    neither is an argument of a program that is not an interpreter (a foreign audit tool that is given the hook file as data). The
    hook script is the command word of a simple command, or the first argument after it when the command word is a Python or the
    command carries --pause-file. Raises ValueError for a command the shell cannot parse (or one with a NUL character)."""
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
    hooks, launchers, found = [], [], {o: [] for o in OPERAND_OPTIONS}
    for words in simple:
        operands = {i + 1: t for i, t in enumerate(words[:-1]) if t in OPERAND_OPTIONS}
        for i, option in operands.items():
            found[option].append(words[i])
        first = 0
        while first < len(words) and (words[first] in ('exec', 'env', 'command') or re.match(r'[A-Za-z_]\w*=', words[first])):
            first += 1
        if first >= len(words) or first in operands:
            continue
        if MARK in os.path.basename(words[first]):
            hooks.append(words[first])
            launchers.append(words[first])   # run directly: the script itself is the program
        elif re.match(PYTHON_NAME, os.path.basename(words[first]).lower()) or '--pause-file' in words:
            args = [i for i in range(first + 1, len(words)) if i not in operands and not words[i].startswith('-')]
            if args and MARK in os.path.basename(words[args[0]]):
                hooks.append(words[args[0]])
                launchers.append(words[first])   # the program that is asked to run the hook
    return hooks, found['-x'], found['--log'], found['--pause-file'], found['-f'], launchers


def is_python_file(path):
    """An absolute path of a regular executable file with the name of a Python: what the entry can use as its interpreter."""
    return os.path.isabs(path) and re.match(PYTHON_NAME, os.path.basename(path).lower()) is not None and os.path.isfile(path) and os.access(path, os.X_OK)


def expected_command(command, pause_file, hook_log=None):
    """The entry the guard would register for a registered command, ready to paste: the pause file of the guard, the hook and the
    interpreter of the command when they are usable (an absolute path of a regular file; the interpreter also executable and named
    like a Python), else the hook next to this module and the interpreter that runs the guard, and, unless the configuration names
    one, the hook log of the command. None when the command names no hook. Raises ValueError as entry_parts does."""
    hooks, interpreters, logs, _pauses, _tests, launchers = entry_parts(command)
    if not hooks:
        return None
    hook = next((x for x in hooks if os.path.isabs(x) and os.path.isfile(x)), os.path.join(os.path.dirname(os.path.abspath(__file__)), MARK))
    python = next((x for x in [y for y in launchers if y not in hooks] + interpreters if is_python_file(x)), sys.executable)
    return entry_command(pause_file, hook, python, hook_log or (logs[0] if logs else None))
