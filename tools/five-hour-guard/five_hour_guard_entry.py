"""The hook entry of the five-hour limit guard: the one definition of the command that is registered in settings.json and of how a
registered command is read. Loaded by five-hour-guard.py (drift check) and five-hour-guard-settings.py (add, check, remove, probe)
from the directory the scripts are in; it is not run by itself and the hook script does not need it."""
import math, os, re, shlex, sys

MARK = 'five-hour-guard-hook.py'
OPERAND_OPTIONS = ('-f', '-x', '--pause-file', '--log')
PYTHON_NAME = r'(python|pythonw|pypy|py)[\d.]*(\.exe)?'   # the whole basename (python, python3, python3.12, pythonw.exe, pypy3, py): python-audit is no Python
# The variables with which the hook decides that a session does not draw on the subscription window (foreign_provider() of
# five-hour-guard-hook.py, which imports nothing and so keeps its own copy of this list): the probe of `add` runs without them.
PROVIDER_ENV_KEYS = ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
                     'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_MODEL', 'ANTHROPIC_MODEL', 'OMC_MODEL_MEDIUM', 'CLAUDE_CODE_BEDROCK_SONNET_MODEL',
                     'ANTHROPIC_DEFAULT_SONNET_MODEL', 'OMC_MODEL_HIGH', 'CLAUDE_CODE_BEDROCK_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
                     'OMC_MODEL_LOW', 'CLAUDE_CODE_BEDROCK_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL')
# Commands that run the command that follows them, with the options that take the next word as their value. A command word that
# is one of these is not the program: skip_wrappers() steps over it, its options and the NAME=VALUE assignments.
WRAPPERS = {'exec': ('-a',), 'env': ('-u', '--unset', '-C', '--chdir', '-S', '--split-string'), 'command': (), 'nohup': (),
            'time': ('-f', '--format', '-o', '--output')}
INFO_WRAPPERS = ('env', 'nohup', 'time')   # the wrappers of WRAPPERS that print their help or version and exit with --help or --version, and then run nothing
INFO_OPTIONS = ('--help', '--version')
PYTHON_VALUE_OPTIONS = ('-W', '-X', '-Q', '--check-hash-based-pycs')   # the options of a Python that take the next word as their value (python3 --help)
SEPARATORS = ';&|\n'   # the characters of the operators that end a simple command (the parentheses and the redirections are not read here)
MIN_TIMEOUT_S = 21600   # the longest pause the guard writes is about 20700 s (a reset time at most 5 h 15 min ahead plus a margin of at most 30 min)


def timeout_ok(timeout):
    """True for a hook timeout that covers a pause: a number (not a boolean) of at least MIN_TIMEOUT_S that is finite as a standard JSON
    reader sees it. An integer too large for a float is no finite number there (JavaScript reads it as Infinity, and math.isfinite raises
    OverflowError for it here), like the NaN and Infinity that Python alone reads. The one test of the value, for the settings tool
    (--timeout) and for the entries the guard finds in settings.json."""
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
        return False
    try:
        return math.isfinite(timeout) and timeout >= MIN_TIMEOUT_S
    except OverflowError:
        return False


def handler_problems(handler):
    """What is wrong with a registered handler outside its command: it must run in the foreground (an asynchronous hook is fire and
    forget, the tool call goes on) and carry a timeout that covers a pause (Claude Code cancels a hook that runs longer and the tool
    call goes on). A list of sentences, empty when the handler is fine."""
    found = []
    if handler.get('async') not in (None, False):
        found.append('it is asynchronous (async), so the tool call goes on while the hook waits in the background')
    timeout = handler.get('timeout')
    if not timeout_ok(timeout):
        shown = repr(timeout)
        found.append(f'its timeout ({shown if len(shown) <= 40 else shown[:40] + "..."}) is missing, not a finite number or below {MIN_TIMEOUT_S} s, so Claude Code would cancel the hook during a long pause and the tool call would go on')
    return found


def entry_command(pause_file, hook, python, hook_log=None):
    """The command of the hook entry. The shell pre-check keeps the cost outside a pause at ~2 ms per tool call (python alone ~35 ms);
    a missing or unreadable hook file or a missing interpreter file is fail-open too (exec of a missing file would exit 127 or 2, and
    Python exits 2 for a script it cannot open; 2 is what a PreToolUse hook reports as a blocking error). Needs a POSIX sh: sh -c on
    Linux and macOS, Git Bash on Windows."""
    q = shlex.quote
    cmd = f'[ -f {q(pause_file)} ] && [ -f {q(hook)} ] && [ -r {q(hook)} ] && [ -x {q(python)} ] || exit 0; exec {q(python)} -I {q(hook)} --pause-file {q(pause_file)}'
    return cmd + (f' --log {q(hook_log)}' if hook_log else '')


def skip_wrappers(words):
    """The index of the command word in the words of a simple command: after the wrappers (exec, env, command, nohup, time, also written with a path), their options
    (`env -i`, `env -u NAME`, `exec -a NAME`, a lone `--` ends the options) and the NAME=VALUE assignments. A word that starts with `-` is
    an option only after a wrapper, so a command word is never taken for one. `command -v` and `command -V`, and `--help` and `--version` of
    env, nohup and time, run nothing: the index is then the number of words (no command word)."""
    i, wrapper = 0, None
    while i < len(words):
        word = words[i]
        if re.match(r'[A-Za-z_]\w*=', word):
            pass
        elif os.path.basename(word) in WRAPPERS:   # by the name of the command: /usr/bin/env is env (the path stays a program of the command, see executable_file)
            wrapper = os.path.basename(word)
        elif wrapper and word == '--':
            wrapper = None
        elif wrapper and len(word) > 1 and word[0] == '-':
            if wrapper == 'command' and set(word[1:]) <= set('pVv') and set(word[1:]) & set('vV'):
                return len(words)   # command -v and -V (alone or with -p) only describe what follows: no command is run
            if word in INFO_OPTIONS and wrapper in INFO_WRAPPERS:
                return len(words)   # env --help, nohup --version and the like print and exit: no command is run
            i += 2 if word in WRAPPERS[wrapper] else 1   # the value of -u, -C, -S and the like is the next word
            continue
        else:
            break
        i += 1
    return i


def command_path(words):
    """The PATH that the NAME=VALUE assignments before the command word of a simple command (also after env) give it, variables such as
    $PATH expanded as for the other words, the last one wins; None without one: the command word is then looked up on the PATH of the
    process that asks."""
    path = None
    for word in words[:skip_wrappers(words)]:
        if word.startswith('PATH='):
            path = os.path.expandvars(word[5:])
    return path


def strip_comments(command):
    """The command without its shell comments, the one place that says what a comment is (the readers of a command in the guard and in
    this module call it before they split the text): an unquoted `#` that starts a word (at the start, after a blank or one of ; & | ( ) < >)
    comments out the rest of the line, the newline that ends it stays; a `#` inside a word (`a#b`, `${#x}`), in quotes or after a
    backslash is text. The shell is the POSIX sh that the hook entry needs (Git Bash on Windows); a cmd.exe command has no such comment."""
    out, i, n, quote, word_start = [], 0, len(command), None, True
    while i < n:
        c = command[i]
        if quote is None and c == '#' and word_start:
            while i < n and command[i] != '\n':
                i += 1
            continue
        if c == '\\' and quote != "'" and i + 1 < n:   # the escaped character is text, and so is what follows it in the word
            out.append(command[i:i + 2])
            i += 2
            word_start = False
            continue
        if quote is None and c in '\'"':
            quote = c
        elif c == quote:
            quote = None
        out.append(c)
        i += 1
        word_start = quote is None and c in ' \t\r\n;&|()<>'
    return ''.join(out)


def command_hook(words):
    """(hook, launcher) when the simple command `words` runs the hook of this guard, else None: the command word (after the wrappers) is
    the hook itself, or it is a Python or the command carries --pause-file and the first argument that is no option or operand is the
    hook. A command that only has the name of the hook among its arguments (an audit tool given it as data) does not run it."""
    operands = {i + 1 for i, t in enumerate(words[:-1]) if t in OPERAND_OPTIONS}
    first = skip_wrappers(words)
    if first >= len(words) or first in operands:
        return None
    if MARK in os.path.basename(words[first]):
        return words[first], words[first]   # run directly: the script itself is the program
    python = re.fullmatch(PYTHON_NAME, os.path.basename(words[first]).lower()) is not None
    if python or '--pause-file' in words:
        values = {i + 1 for i in range(first + 1, len(words)) if python and words[i] in PYTHON_VALUE_OPTIONS}   # -W ignore: `ignore` is no script
        args = [i for i in range(first + 1, len(words)) if i not in operands and i not in values and not words[i].startswith('-')]
        if args and MARK in os.path.basename(words[args[0]]):
            return words[args[0]], words[first]   # the program that is asked to run the hook
    return None


def entry_parts(command):
    """read_entry() without the PATH of each launcher."""
    return read_entry(command)[:6]


def read_entry(command):
    """(hook scripts, interpreter files, log files, pause files, preflight files, launchers, the PATH of each launcher) that a hook entry
    command names, by the option or position they stand at: operands of -f, -x, --pause-file and --log are not scripts, whatever their
    file names say, and neither is an argument of a program that is not an interpreter (a foreign audit tool that is given the hook file
    as data). The hook script is the command word of a simple command, or the first argument after it when the command word is a Python
    or the command carries --pause-file. The PATH of a launcher is the one that command_path() reads from its simple command (None
    without a PATH assignment). Raises ValueError for a command the shell cannot parse (or one with a NUL character)."""
    lex = shlex.shlex(strip_comments(command), posix=True, punctuation_chars=SEPARATORS)   # the separators are told from quoted text: a quoted path may end in `;`
    lex.whitespace, lex.whitespace_split, lex.commenters = ' \t\r', True, ''   # a newline ends a command, as ; does
    tokens = list(lex)
    if any('\0' in t for t in tokens):
        raise ValueError('NUL character in the command')
    simple, current = [], []
    for t in tokens:
        if t and not t.strip(SEPARATORS):   # one token of operators: ; & && || | and newlines, also written together (`&&` and a newline)
            simple.append(current)
            current = []
        else:
            current.append(t)
    simple.append(current)
    hooks, launchers, paths, found = [], [], [], {o: [] for o in OPERAND_OPTIONS}
    for words in simple:
        operands = {i + 1: t for i, t in enumerate(words[:-1]) if t in OPERAND_OPTIONS}
        for i, option in operands.items():
            found[option].append(words[i])
        hook = command_hook(words)
        if hook:
            hooks.append(hook[0])
            launchers.append(hook[1])
            paths.append(command_path(words))
    return hooks, found['-x'], found['--log'], found['--pause-file'], found['-f'], launchers, paths


def is_python_file(path):
    """An absolute path of a regular executable file with the name of a Python: what the entry can use as its interpreter."""
    return os.path.isabs(path) and re.fullmatch(PYTHON_NAME, os.path.basename(path).lower()) is not None and os.path.isfile(path) and os.access(path, os.X_OK)


def expected_command(command, pause_file, hook_log=None, copy_log=True):
    """The entry the guard would register for a registered command, ready to paste: the pause file of the guard, the hook and the
    interpreter of the command when they are usable (an absolute path of a regular file; the interpreter also executable and named
    like a Python), else the hook next to this module and the interpreter that runs the guard, and, unless the configuration names
    one and copy_log, the hook log of the command when it is an absolute path (a relative one is resolved in the working directory of
    each session, where it can be any file, the hook itself included, so it is never copied). None when the command names no hook.
    Raises ValueError as entry_parts does."""
    hooks, interpreters, logs, _pauses, _tests, launchers = entry_parts(command)
    if not hooks:
        return None
    hook = next((x for x in hooks if os.path.isabs(x) and os.path.isfile(x)), os.path.join(os.path.dirname(os.path.abspath(__file__)), MARK))
    python = next((x for x in [y for y in launchers if y not in hooks] + interpreters if is_python_file(x)), sys.executable)
    return entry_command(pause_file, hook, python, hook_log or (logs[0] if logs and copy_log and os.path.isabs(logs[0]) else None))
