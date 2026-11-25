"""The hook entry of the five-hour limit guard: the one definition of the command that is registered in settings.json and of how that
entry is recognised there (by ENTRY_MARKER, a fixed text at the end of its command, or by the exact path of the hook: no command is analysed). Loaded by five-hour-guard.py
(drift check) and five-hour-guard-settings.py (add, check, remove, probe) from the directory the scripts are in; it is not run by itself
and the hook script does not need it."""
import math, re, shlex

MARK = 'five-hour-guard-hook.py'
ENTRY_MARKER = '# five-hour-guard-entry'   # a comment to the shell, last in the command of the entry that `add` writes: the entry is the handler whose command holds this text
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


def is_entry(handler, hook):
    """Whether a hook handler is the entry of this guard: a command handler whose command holds ENTRY_MARKER (what `add` writes now) or
    the exact path `hook` of the hook script, as a whole word of the command (it starts and ends at a blank, an operator of the shell or an
    end of the command: a character that is valid in a file name, such as `+`, `,`, `@`, `%`, `=`, `:` or `~`, is no boundary, so `hook.py+audit` is
    another file; a quote that opens at the start of the word closes at its end, `'hook'` and `"hook"`, so `'hook'+audit` and `audit'hook'` are other
    words; a quote that opens in front of the path and stays open, as in `sh -c 'hook --pause-file p'`, is the text of a quoted command): the entries
    that earlier versions of `add` wrote have no marker, and their command holds the path of the hook."""
    command = handler.get('command') if isinstance(handler, dict) else None
    if not isinstance(command, str) or handler.get('type') != 'command':
        return False
    path, edge = re.escape(hook), r'[^\s;&|()<>]'
    return ENTRY_MARKER in command or re.search(rf'(?<!{edge})(?:([\'"]?){path}\1|[\'"]{path}(?=[\s;&|()<>]))(?!{edge})', command) is not None
