"""The hook entry of the five-hour limit guard: the one definition of the command that is registered in settings.json and of how that
entry is recognised there (by ENTRY_MARKER, a fixed text that ends its command, by the exact path of the hook, or as the very command that
`add` writes or wrote for the same pause file with the hook in another directory: no other command is analysed). Loaded by five-hour-guard.py
(drift check) and five-hour-guard-settings.py (add, check, remove, probe) from the directory the scripts are in; it is not run by itself
and the hook script does not need it."""
import math, os, re, shlex

MARK = 'five-hour-guard-hook.py'
ENTRY_MARKER = '# five-hour-guard-entry'   # a comment to the shell, last in the command of the entry that `add` writes: the entry is the handler whose command ends with this text after a blank (has_marker)
PROVIDER_ENV_KEYS = ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
                     'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_MODEL', 'ANTHROPIC_MODEL', 'OMC_MODEL_MEDIUM', 'CLAUDE_CODE_BEDROCK_SONNET_MODEL',
                     'ANTHROPIC_DEFAULT_SONNET_MODEL', 'OMC_MODEL_HIGH', 'CLAUDE_CODE_BEDROCK_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
                     'OMC_MODEL_LOW', 'CLAUDE_CODE_BEDROCK_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL')
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
    return cmd + (f' --log {q(hook_log)}' if hook_log else '') + f' {ENTRY_MARKER}'


def run_by(command):
    """(interpreter, hook) of a command of the shape that `add` writes: the word after `exec` and the word after the `-I` behind it; (None,
    None) for a command of another shape or one that cannot be split into words."""
    try:
        words = shlex.split(command, comments=True)
    except ValueError:
        return None, None
    for i in range(len(words) - 3):
        if words[i] == 'exec' and words[i + 2] == '-I':
            return words[i + 1], words[i + 3]
    return None, None


def file_problems(command):
    """The hook and the interpreter that a command of the shape `add` writes runs and that are not there: the shell test of such a command
    ends with status 0 for a missing file (fail-open), so the entry holds no call, without a word. A list of sentences; a relative path or
    one with a variable is not looked at, since only the session that runs it knows what it names."""
    python, hook = run_by(command)
    found = []
    for what, path, mode, verb in (('hook', hook, os.R_OK, 'read'), ('interpreter', python, os.X_OK, 'run')):
        if path and os.path.isabs(path) and '$' not in path and not (os.path.isfile(path) and os.access(path, mode)):
            found.append(f'its {what} {path} is missing or cannot be {verb}, so the entry lets every call through during a pause')
    return found


def is_moved_entry(command, pause_file):
    """Whether the command is the one that `add` writes for this pause file (also in its earlier forms, without the marker and without the
    tests `-r` and `-x`) with a hook of the name of the guard's hook in any directory: an entry of an installation somewhere else. The whole
    command is compared with what entry_command makes of its own interpreter, hook and log, so no other command is taken for it."""
    if MARK not in command:
        return False
    python, hook = run_by(command)
    if hook is None or os.path.basename(hook) != MARK:
        return False
    words = shlex.split(command, comments=True)
    log = words[words.index('--log') + 1] if '--log' in words[:-1] else None
    full = entry_command(pause_file, hook, python, log)[:-len(ENTRY_MARKER) - 1]
    tests = f' && [ -r {shlex.quote(hook)} ] && [ -x {shlex.quote(python)} ]'
    return command.rstrip() in (full, full.replace(tests, ''))


def unescaped(text, i):
    """Whether the character at text[i] is free of an escape: an even number of backslashes (none too) stands right in front of it. A backslash in front of
    a blank, a new line or an operator of the shell makes it a part of the word instead of the boundary of one."""
    return (i - len(text[:i].rstrip('\\'))) % 2 == 0


def has_marker(command):
    """Whether the command ends with ENTRY_MARKER after a blank, as the command that `add` writes does (a comment to the shell, last in the command;
    trailing blanks and new lines do not count). The text elsewhere in a command (`echo '# five-hour-guard-entry'`, in quotes, or in the middle) is data or
    another comment, not the entry. The blank must be free: an odd number of backslashes in front of it (`foo\\ # five-hour-guard-entry`, or a new line after
    a backslash, which continues the line) makes it part of the word, so the `#` is no comment."""
    text = command.rstrip()
    if not text.endswith(ENTRY_MARKER):
        return False
    before = text[:-len(ENTRY_MARKER)]
    return before[-1:].isspace() and unescaped(before, len(before) - 1)


def strip_comments(command):
    """The command without its shell comments: a `#` that starts a word (at the start, after a blank or a newline, or after one of ; & | ( ) ),
    outside quotes and `${...}` and not escaped, up to the end of its line, which stays. A `#` inside a word (`a#b`, `$#`, `${A#x}`) is text. Where
    this scan could differ from a shell (`$'...'`, a backtick, `<<` of a here document) nothing is removed: removing too much would hide a file, so such a
    command stays whole, and so does any text that this scan cannot place (it is not a parser: `$(...)`, nested quotes
    inside `$(...)` are scanned as plain text). The comment that is the marker of the entry of this guard is kept: what follows it
    is a command to the guard's own entry that a shell would not run, and it stays a candidate."""
    if "$'" in command or '`' in command or '<<' in command:
        return command
    out, quote, depth, boundary, i = [], None, 0, True, 0
    while i < len(command):
        c = command[i]
        if quote:
            out.append(c)
            if c == '\\' and quote == '"' and i + 1 < len(command):
                i += 1
                out.append(command[i])
            elif c == quote:
                quote = None
        elif c == '\\' and i + 1 < len(command):
            out.append(command[i:i + 2])
            i += 1
            boundary = False
        elif c in '\'"':
            quote, boundary = c, False
            out.append(c)
        elif c == '#' and boundary and not depth and not command.startswith(ENTRY_MARKER, i):
            end = command.find('\n', i)
            i = len(command) if end < 0 else end
            continue
        else:
            if c == '$' and command[i + 1:i + 2] == '{':
                depth += 1
                out.append('${')
                i += 2
                boundary = False
                continue
            if c == '}' and depth:
                depth -= 1
            boundary = c in ' \t\r\n;&|()'
            out.append(c)
        i += 1
    return ''.join(out)


def is_entry(handler, hook, pause_file=None):
    """Whether a hook handler is the entry of this guard: a command handler whose command ends with ENTRY_MARKER (what `add` writes now, see has_marker), is
    the command of `add` for `pause_file` with the hook in another directory (is_moved_entry) or holds
    the exact path `hook` of the hook script, as a whole word of the command (it starts and ends at a blank, an operator of the shell or an
    end of the command: a character that is valid in a file name, such as `+`, `,`, `@`, `%`, `=`, `:` or `~`, is no boundary, so `hook.py+audit` is
    another file; a quote that opens at the start of the word closes at its end, `'hook'` and `"hook"`, so `'hook'+audit` and `audit'hook'` are other
    words; a quote that opens in front of the path and stays open, as in `sh -c 'hook --pause-file p'`, is the text of a quoted command, but only as the argument of an option that ends in `c` (`-c`, `-lc`): in `printf '%s\\n' "hook is data"` the quote opens an argument with data, which is not run; the blank or operator in front of it is free, see unescaped: `foo\\ hook` is one word, `foo` and the path together, which no shell runs as the hook): the entries
    that earlier versions of `add` wrote have no marker, and their command holds the path of the hook. A path that stands in a comment of the shell (`echo ok # hook`) is
    no word that runs, so it does not count: the comments are removed first as the guard removes them (strip_comments; where it cannot place a comment, a command with `$'...'`, a
    backtick or `<<`, the text stays whole, and the path in it still counts)."""
    command = handler.get('command') if isinstance(handler, dict) else None
    if not isinstance(command, str) or handler.get('type') != 'command':
        return False
    path, edge = re.escape(hook), r'[^\s;&|()<>]'
    text = strip_comments(command)   # a path in a comment of the shell is never run
    quoted_command = lambda m: m.group(1) is not None or re.search(r'(?:^|[\s;&|()])-[A-Za-z]*c\s*$', text[:m.start()])   # an open quote in front of the path: the text of a command only after -c
    return has_marker(command) or bool(pause_file and is_moved_entry(command, pause_file)) or any((m.start() == 0 or unescaped(text, m.start() - 1)) and quoted_command(m) for m in re.finditer(rf'(?<!{edge})(?:([\'"]?){path}\1|[\'"]{path}(?=[\s;&|()<>]))(?!{edge})', text))
