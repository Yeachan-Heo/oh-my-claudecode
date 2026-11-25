#!/usr/bin/env python3
"""Five-hour limit guard: a pause file plus a PreToolUse hook, no signals to any session.

Mechanism: at the threshold the guard writes a pause file; the PreToolUse hook (five-hour-guard-hook.py, registered once
in settings.json by five-hour-guard-settings.py) makes every tool call of every session wait while that file says
"paused". Sessions stay alive and keep their id and their connections; a session that calls a tool stops spending at that call,
after at most one more model response (an answer without a tool call is not held: no PreToolUse event fires for it). At the reset time plus a margin the guard deletes the pause file and every waiting session continues
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
import argparse, datetime, glob, itertools, json, math, os, re, shlex, signal, stat, sys, time

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
DEFAULT_HEARTBEAT_S = 300


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
ap.add_argument('--resume-below', type=finite_float, default=None, help='early resume when the fresh cache shows less than this percent (default: 10 under the threshold, but at least half of it)')
ap.add_argument('--max-age', type=finite_float, default=180, help='data older than this many seconds is not acted on (keep it above the status line usage poll interval, 90 s by default)')
ap.add_argument('--margin', type=finite_float, default=150, help=f'resume this many seconds after the reset time (0 to {MAX_MARGIN_S})')
ap.add_argument('--interval', type=finite_float, default=30, help=f'seconds between ticks (at least {MIN_INTERVAL_S:g})')
ap.add_argument('--heartbeat', type=finite_float, default=None, help=f'pause file validity after each tick; the hook lets sessions go when it lapses (guard dead); from twice --interval plus {HEARTBEAT_SLACK_S} s to {MAX_HEARTBEAT_S} (default {DEFAULT_HEARTBEAT_S}, or twice --interval plus {HEARTBEAT_SLACK_S} s when that is more)')
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
if A.heartbeat is None:   # a default that is refused for an interval the user may choose is no default: it follows the interval (an interval too long for any heartbeat is refused below)
    A.heartbeat = min(max(DEFAULT_HEARTBEAT_S, 2 * A.interval + HEARTBEAT_SLACK_S), MAX_HEARTBEAT_S)
check_range('--heartbeat', A.heartbeat, 2 * A.interval + HEARTBEAT_SLACK_S, MAX_HEARTBEAT_S)   # a pause must outlive one missed tick, with room for the time that tick took
check_range('--warn-every', A.warn_every, 0, 86400)
check_range('--test-pause', A.test_pause, 0, MAX_TEST_PAUSE_S)
if not 0 < A.threshold <= 100:
    fail(f'--threshold must be greater than 0 and at most 100 percent, not {A.threshold:g}')
if A.resume_below is not None and not 0 <= A.resume_below <= A.threshold:
    # above the threshold one tick would enter the pause and the next would leave it, again and again
    fail(f'--resume-below must be between 0 and the threshold ({A.threshold:g}) percent, not {A.resume_below:g}')


MAX_JSON_BYTES = 1048576   # as in the hook: the documents the guard reads are a few KiB; a larger file is none of them and is not read in full


def load_json(f):
    """json.load of an open file, but a file larger than MAX_JSON_BYTES (a mistaken path, a file replaced by a huge one) is not read to its
    end: it is a ValueError, as a document that cannot be decoded is."""
    raw = f.read(MAX_JSON_BYTES + 1)
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError(f'more than {MAX_JSON_BYTES} bytes')
    return json.loads(raw)


def load_config(path):
    if not path:
        return {}
    try:
        with open(path) as f:
            cfg = load_json(f)
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
ENTRY_LOG = 'registered hook log'   # the value of --log in a hook entry that carries the marker: the hook appends a line to it for every call it holds
ENTRY_FILE = 'file named by the hook entry'   # a word of the command of the hook entry in settings.json that the entry the guard generates does not have (another hook, interpreter or log path)
UNSCANNED = 'command that cannot be read to its end'   # the entry for a command of another hook that a limit of command_programs cut short: the guard writes nothing while it is there
OTHER_PROGRAM = 'program of another hook'   # a file that a command of any other hook (or the status line) in settings.json runs
PROGRAM_LABELS = HOOK_PROGRAMS | {OTHER_PROGRAM, 'guard script', 'settings tool script', 'entry module'}
READ_ONLY_LABELS = {'configuration file', 'usage_cache', 'usage_cache lock', 'settings_file'}   # files the guard only reads (many hooks name them): a command of another hook that names one is no collision
PROTECTED_LABELS = {'registered hook', 'registered interpreter', OTHER_PROGRAM, ENTRY_FILE, ENTRY_LOG}   # the programs that no write of the guard may replace


def may_be_one_file(la, pa, lb, pb):
    """The pairs that are one file by design: the hook as the bundled and as the registered one (and a hook that two entries name),
    an interpreter that two entries name, a hook that is run directly and so is its own launcher (the same path in both places: a
    hook that is a link to the interpreter is not), the hook log of the configuration that is the log of the entry,
    and a program of another hook entry that is one of those programs."""
    if OTHER_PROGRAM in (la, lb):   # the interpreter or script of another hook can be one of ours; what it may not be is a file the guard writes (state, pause, log and their locks: not the files it only reads)
        return (lb if la == OTHER_PROGRAM else la) in PROGRAM_LABELS | READ_ONLY_LABELS
    if {la, lb} == {'hook_log_file', ENTRY_LOG}:
        return True
    if ENTRY_FILE in (la, lb):   # a word of the entry beyond the generated ones (the hook, interpreter, pause file) may be the same file as another one of them; it may not be a file of the guard, nor the log of the entry
        return (lb if la == ENTRY_FILE else la) in (ENTRY_FILE, 'registered hook', 'registered interpreter')
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
BUNDLED_HOOK = os.path.join(HERE, HOOK_NAME)


def command_hooks(groups):
    """The command handlers of PreToolUse groups that are the hook entry of this guard (ENTRY.is_entry): [(group, handler)]."""
    found = []
    for g in groups if isinstance(groups, list) else []:
        if not isinstance(g, dict) or not isinstance(g.get('hooks', []), list):
            continue   # not a group of Claude Code: skipped here, so that the entries after it are still seen
        found += [(g, h) for h in g.get('hooks', []) if ENTRY.is_entry(h, BUNDLED_HOOK)]
    return found


MAX_COMMAND_CHARS = 65536   # a longer command is not read (the command of a hook is a few hundred characters)
MAX_PATH_CHARS = 4096
MAX_COMMAND_WORDS = 4096
MAX_COMMAND_PROGRAMS = 4096
PUNCTUATION = '();<>|&\n'


class ScanIncomplete(Exception):
    """A command that command_programs cannot read to its end (a limit was reached): what it names may be a file of the guard, so the
    guard writes nothing while it stands in settings.json (see UNSCANNED)."""


def word_files(word, directories, named=()):
    """The files a word of a command can be: a word with a directory part is that path as written (with ~ and variables of this process
    expanded); a word without one is the file of that name in each of `directories` (the working directory first, then the PATH) where there is one.
    A word with `*`, `?` or `[` is also every file that the shell would expand it to (glob, at most MAX_COMMAND_PROGRAMS + 1 results: more is
    ScanIncomplete in the caller), as the word with a directory part or in each of `directories`. A word with a relative directory part (`./prog`,
    `sub/prog`) is also that path in each of `named`, the directories that the command names (the shell may run it from there)."""
    word = os.path.expanduser(os.path.expandvars(word))
    if not word or len(word) > MAX_PATH_CHARS or '\0' in word:
        return []
    pattern = any(c in word for c in '*?[')
    cap = MAX_COMMAND_PROGRAMS + 1
    if os.sep in word or (os.altsep and os.altsep in word):
        found = [word]
        for path in [word] + ([] if os.path.isabs(word) else [os.path.join(d, word) for d in named]):
            if path != word and os.path.lexists(path):
                found.append(path)
            if pattern:
                found += list(itertools.islice(glob.iglob(path), cap))
        return found
    found = []
    for directory in directories:
        try:
            path = os.path.join(directory, word)
            if os.path.lexists(path):
                found.append(path)
            if pattern:
                found += list(itertools.islice(glob.iglob(path), cap))
        except (OSError, ValueError):
            pass
    return found


def command_tokens(command):
    """The words and the operators of a command as the shell splits them (shlex), None for a command with a NUL character or one that cannot be
    parsed. Raises ScanIncomplete past MAX_COMMAND_CHARS or MAX_COMMAND_WORDS: a prefix would pass for the whole command."""
    if not isinstance(command, str) or '\0' in command:
        return None
    if len(command) > MAX_COMMAND_CHARS:
        raise ScanIncomplete('command too long to scan')
    command = re.sub(r'(?<!\\)((?:\\\\)*)\\\n', r'\1', command)   # a backslash and the newline after it (not an escaped backslash) are removed before the words are split, as the shell does
    try:
        lex = shlex.shlex(command, posix=True, punctuation_chars=PUNCTUATION)
        lex.whitespace, lex.whitespace_split, lex.commenters = ' \t\r', True, ''
        tokens = []
        for token in lex:
            tokens.append(token)
            if len(tokens) > MAX_COMMAND_WORDS:
                raise ScanIncomplete('command has too many words to scan')
    except ScanIncomplete:
        raise
    except Exception:
        return None
    return tokens


PARAMETER = re.compile(r'\$(?:(\w+)|\{(\w+)(?:(:?[-=+])([^{}]*))?\})')   # $NAME, ${NAME}, ${NAME:-word} (also -, =, :=, + and :+)


def own_value(name, value):
    """The value assigned to NAME with the references to NAME itself (`PATH=dir:$PATH`) replaced by the value that the guard has, else by the
    default word, else by nothing: they name the value before the assignment, so they are no cycle."""
    return PARAMETER.sub(lambda m: (os.environ.get(name) or m.group(4) or '') if (m.group(1) or m.group(2)) == name else m.group(0), value)


def parameter_variants(piece, assigned):
    """The piece filled in every way its parameters can be: `$NAME` and `${NAME}` with each value that the command assigns to NAME and the
    one that the guard has (a name that has none stays as written); `${NAME:-word}`, `-`, `:=` and `=` with those values and with the word;
    `${NAME:+word}` and `+` with the word and with nothing. Which way the shell takes is not decided. A word that holds a parameter is filled
    in innermost first, pass after pass until a pass changes nothing (a name with no value and no word stays as written, so that is where it
    ends). A chain of parameters ends within the `$` of the word plus the names that the command assigns; a pass beyond that is a cycle
    (`A=$B B=$A`) or an expansion that does not end. More than MAX_COMMAND_PROGRAMS variants, a text longer than MAX_COMMAND_CHARS or no
    end of the passes is ScanIncomplete."""
    variants = [piece]
    for _ in range(piece.count('$') + len(assigned) + 2):
        grown = []
        for text in variants:
            matches = list(PARAMETER.finditer(text))
            options = []
            for m in matches:
                name, operator, word = m.group(1) or m.group(2), m.group(3), m.group(4)
                values = assigned.get(name, []) + ([os.environ[name]] if name in os.environ else [])
                options.append([word, ''] if operator in ('+', ':+') else (values + [word] if operator else values) or [m.group(0)])
            for choice in itertools.islice(itertools.product(*options), MAX_COMMAND_PROGRAMS + 1):
                parts, last = [], 0
                for m, value in zip(matches, choice):
                    parts += [text[last:m.start()], value]
                    last = m.end()
                grown.append(''.join(parts) + text[last:])
        grown = list(dict.fromkeys(grown))
        if len(grown) > MAX_COMMAND_PROGRAMS or any(len(text) > MAX_COMMAND_CHARS for text in grown):
            raise ScanIncomplete('command has too many ways to fill in its variables to scan')
        if grown == variants:
            return variants
        variants = grown
    raise ScanIncomplete('variables of the command refer to each other in a cycle or nest too deeply to scan')


BRACES = re.compile(r'(?<!\$)\{([^{}]*)\}')   # an innermost brace expression that no $ opens
BRACE_NUMBERS = re.compile(r'(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?')
BRACE_LETTERS = re.compile(r'([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?')


def brace_alternatives(body):
    """What Bash makes of the inside of a brace expression: the items of `a,b` (an empty item is an item) or the numbers or letters of a range
    `1..3`, `01..10`, `a..e`, `1..10..2`; None for anything else (`{}`, `{a}`: Bash leaves those as they are). A range of more than
    MAX_COMMAND_PROGRAMS items is ScanIncomplete."""
    if ',' in body:
        return body.split(',')
    for pattern, letters in ((BRACE_NUMBERS, False), (BRACE_LETTERS, True)):
        m = pattern.fullmatch(body)
        if m:
            first, last = (ord(m.group(1)), ord(m.group(2))) if letters else (int(m.group(1)), int(m.group(2)))
            step = abs(int(m.group(3) or 1)) or 1
            if abs(last - first) // step + 1 > MAX_COMMAND_PROGRAMS:
                raise ScanIncomplete('command has a brace range that is too long to scan')
            numbers = range(first, last + 1 if last >= first else last - 1, step if last >= first else -step)
            if letters:
                return [chr(n) for n in numbers]
            digits = [m.group(1).lstrip('-'), m.group(2).lstrip('-')]
            width = max(len(d) for d in digits) if any(len(d) > 1 and d[0] == '0' for d in digits) else 0
            return [('-' if n < 0 else '') + str(abs(n)).zfill(width) for n in numbers]
    return None


def brace_variants(piece):
    """The piece with its brace expressions expanded as Bash does (`{a,b}`, `{1..3}`, nested ones innermost first, pass after pass until a
    pass changes nothing), which happens before every other expansion; the guard does not tell whether a shell does it (zsh, sh, dash, and Bash
    in quotes do not), so the piece itself stays a candidate. More than MAX_COMMAND_PROGRAMS variants or a text longer than MAX_COMMAND_CHARS is
    ScanIncomplete."""
    variants = [piece]
    for _ in range(piece.count('{') + 1):
        grown = []
        for text in variants:
            matches = [(m, brace_alternatives(m.group(1))) for m in BRACES.finditer(text)]
            options = [alternatives if alternatives is not None else [m.group(0)] for m, alternatives in matches]
            for choice in itertools.islice(itertools.product(*options), MAX_COMMAND_PROGRAMS + 1):
                parts, last = [], 0
                for (m, _alternatives), value in zip(matches, choice):
                    parts += [text[last:m.start()], value]
                    last = m.end()
                grown.append(''.join(parts) + text[last:])
        grown = list(dict.fromkeys(grown))
        if len(grown) > MAX_COMMAND_PROGRAMS or any(len(text) > MAX_COMMAND_CHARS for text in grown):
            raise ScanIncomplete('command has too many brace expansions to scan')
        if grown == variants:
            break
        variants = grown
    return variants


def word_pieces(word, assigned):
    """The word, and the parts of it that can be a file name too, each also filled in with the values of its parameters (parameter_variants), a
    filled-in value also split at its blanks, and each of them also with its brace expressions expanded (brace_variants).
    `assigned`: {name: [values]} that the command assigns (NAME=value words, in any order, none expanded by another)."""
    pieces = [word]
    if '=' in word:
        pieces.append(word.partition('=')[2])   # --log=FILE, NAME=FILE
    if word[:1] == '-' and word[1:2] not in ('-', '') and len(word) > 2:
        pieces.append(word[2:])   # -SFILE, -oFILE: the value of a short option glued to it
    if '$' in word:
        for piece in pieces[:]:
            for variant in parameter_variants(piece, assigned):
                pieces.append(variant)
                if variant != piece:
                    pieces += variant.split()   # a value with blanks that the shell splits into words (an unquoted $NAME): each word of it is a piece too, whether or not the expansion was quoted
    for piece in pieces[:]:
        if '{' in piece:
            pieces += brace_variants(piece)   # braces before parameters in Bash, after them here: both orders give the same pieces
    return list(dict.fromkeys(pieces))


def command_programs(command, exclude=None, depth=0, inherited=(), values=None):
    """The files that a shell command of a hook that is not ours may run or read, the same for every command and without knowing what any
    word means (nothing is run, nothing is expanded by a shell): every word of the command, each word that is a quoted command (it holds a
    blank: the words of an argument of -c or -S, two levels deep), the part of a word after its first `=` and the part after a short option that is glued to its value (`-SFILE`). A word with a directory part
    stands for that path, a word without one for the file of that name in the working directory of the guard and in each directory of the
    PATH of the guard, and in each directory of a `PATH=dir` word of its simple command (no assignment is expanded or ordered; the same words `NAME=value` of the whole command are also the values of `$NAME` and `${NAME}` in any word, and `${NAME:-word}` is both: see parameter_variants). A word without a directory part, and a relative one with a directory part (`./prog`), is also looked for in each existing directory that any word of the whole command names (`cd DIR; prog`, `env -C DIR prog`: the shell may run it from there; no command is recognised), also in a quoted command inside it (`env -C DIR sh -c 'prog x'`). The rule is deliberately wide:
    a word that is no program at all (an argument, an option value) is a file the guard then does not write, and no program is missed by
    not being recognised. A command with a NUL character or one that the shell cannot parse runs nothing and gives none. A command that a limit cuts
    short (more than MAX_COMMAND_CHARS characters, MAX_COMMAND_WORDS words or MAX_COMMAND_PROGRAMS files, or quoted commands nested deeper than
    two levels) raises ScanIncomplete: a prefix would pass for the whole command. A word longer than MAX_PATH_CHARS names no file and is skipped. `exclude`: a list of words that are not
    candidates, each once (the words of the entry that this guard generates, see registered_runtime_files)."""
    exclude = [] if exclude is None else exclude
    tokens = command_tokens(command)
    if tokens is None:
        return []   # a command with a NUL character (no process can be started with one in its arguments) or one the shell cannot parse runs nothing
    simple, words = [], []
    for token in tokens:
        if token and token[0] in PUNCTUATION:   # (an empty string is a word: '')
            if '<' not in token and '>' not in token:   # the file of a redirection is a word like any other
                simple.append(words)
                words = []
        else:
            words.append(token)
    simple.append(words)
    found = []
    assigned = {n: [own_value(n, x) for x in v] for n, v in (values or {}).items()}   # the NAME=value words of the whole command (and of the command it is quoted in)
    given_path = [os.path.expanduser(os.path.expandvars(d)) for v in assigned.get('PATH', []) for d in v.split(os.pathsep)]   # the PATH that settings.json gives the hook processes: the guard does not have it, the shell of the hook looks a bare word up there
    for words in simple:
        for word in words:
            name, equals, value = word.partition('=')
            if equals and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name) and own_value(name, value) not in assigned.setdefault(name, []):
                assigned[name].append(own_value(name, value))
    for words in simple:
        for word in words:
            for m in PARAMETER.finditer(word):
                if m.group(3) in (':=', '='):   # ${NAME:=word} and ${NAME=word} assign NAME for the words that follow: the word is a value of NAME in the whole command, as an assignment is
                    if own_value(m.group(2), m.group(4)) not in assigned.setdefault(m.group(2), []):
                        assigned[m.group(2)].append(own_value(m.group(2), m.group(4)))
    named = list(inherited)   # the directories that a word of the command names (cd DIR, env -C DIR, --directory DIR) and of the command it is quoted in: the shell may run a later word from there
    for words in simple:
        for word in words:
            for piece in word_pieces(word, assigned):
                directory = os.path.expanduser(os.path.expandvars(piece))
                if directory and len(directory) <= MAX_PATH_CHARS and '\0' not in directory and os.path.isdir(directory) and directory not in named:
                    named.append(directory)
    for words in simple:
        directories = [''] + os.environ.get('PATH', os.defpath).split(os.pathsep) + [d for w in words if w.startswith('PATH=') for d in w[5:].split(os.pathsep)] + given_path + named   # a PATH=dir word adds its directories for every word of the simple command
        for word in words:
            if word in exclude:
                exclude.remove(word)   # one occurrence of a word of the generated entry is that word of the entry, not a file it names besides
                continue
            if any(c.isspace() for c in word):
                if depth >= 2:
                    raise ScanIncomplete('quoted commands nested too deeply to scan')
                found += [t for t in command_programs(word, exclude, depth + 1, named, assigned) if t not in found]
            for piece in word_pieces(word, assigned):
                for path in word_files(piece, directories, named):
                    if path not in found:
                        found.append(path)
                if len(found) > MAX_COMMAND_PROGRAMS:
                    raise ScanIncomplete('command names too many files to scan')
    return found


def other_commands(data, ours):
    """The commands of every command handler in settings.json (all hook events, and the status line) except the handlers `ours` (ids of
    the handlers of the hook entry of this guard)."""
    found = []
    events = data.get('hooks')
    for groups in events.values() if isinstance(events, dict) else []:
        for g in groups if isinstance(groups, list) else []:
            for h in g.get('hooks') if isinstance(g, dict) and isinstance(g.get('hooks'), list) else []:
                if isinstance(h, dict) and h.get('type') == 'command' and isinstance(h.get('command'), str) and id(h) not in ours:
                    found.append(h['command'])
    status = data.get('statusLine')
    if isinstance(status, str):   # the form before v4.5, which the installer still reads: the string is the command
        found.append(status)
    elif isinstance(status, dict) and status.get('type') == 'command' and isinstance(status.get('command'), str):
        found.append(status['command'])
    return found


LAST_SCAN = [[]]   # what every readable settings.json gave since the start: neither a file that cannot be read (a rewrite in progress, a broken edit) nor a rewrite that removes an entry lifts the protection

SCANNED = [False]   # whether settings.json was read to its end (or was not there) at least once since the start: until then nothing is known of the hooks that a session may have loaded, so nothing is written


LOG_LOOK_S = 1.0
LOG_LOOK = [None, False]   # [time.monotonic() of the last look, whether the log file was a program of a registered entry then]


def hook_log_setting():
    """hook_log_file of the configuration (the log of the hook entry), or None."""
    v = CFG.get('hook_log_file')
    return v if isinstance(v, str) and v and '\0' not in v else None


def entry_roles(command):
    """(hooks, interpreters, logs) of a hook entry that carries the marker, the format that `add` generates: the word after `-I` or `--hook`
    is the hook, the word after `exec` or `--python` the interpreter, the word after `--log` the log, in the words that shlex splits the
    command into. Read for no other command (a handler without the marker is never read this way)."""
    words = [t for t in command_tokens(command) or [] if t and t[0] not in PUNCTUATION]
    after = lambda *names: [words[i + 1] for i, w in enumerate(words[:-1]) if w in names]
    return after('-I', '--hook'), after('exec', '--python'), after('--log')


def registered_runtime_files():
    """The files that the hook entry in settings.json names besides the ones the guard generates itself (an entry written with `--hook`,
    `--python` or `--hook-log` of other paths: ENTRY_FILE, which may not be a file of the guard), the hook script and the interpreter
    the guard generates for it, and the programs that the commands of every other hook and of the status line run (command_programs: a hook
    of another tool is as much a file the guard must not replace as ours). The entry is not analysed: every word of its command that
    the generated entry does not have is a file it may name. Best effort: the programs found by every scan since the start stay in
    the list (the unreadable file gives only those): a rewrite in progress or a broken edit does not open them to a write, and a
    session that loaded an entry keeps running its program after a rewrite removed it, until it is restarted; hook_check says that the
    file cannot be read."""
    found = []   # the files of the entries first: a collision is reported with the label of the entry
    try:
        with open(SETTINGS or default_settings()) as f:
            data = load_json(f)
        entries = command_hooks(data.get('hooks', {}).get('PreToolUse', []))
        env = data.get('env')   # the top-level env of settings.json reaches the hook processes, not this one: its values are values of the parameters of the commands
        env = {k: [v] for k, v in env.items() if isinstance(k, str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', k) and isinstance(v, str)} if isinstance(env, dict) else {}
        SCANNED[0] = True   # the document was read and has the shape of a settings file: what the scan below finds is what it holds
        generated = [t for t in command_tokens(ENTRY.entry_command(PAUSE_FILE, BUNDLED_HOOK, sys.executable, hook_log_setting())) if t[:1] not in PUNCTUATION or not t]
        if entries:
            found += [('registered hook', BUNDLED_HOOK), ('registered interpreter', sys.executable)]
        for _group, handler in entries:
            try:   # one handler that cannot be read must not hide the ones after it
                marked = ENTRY.ENTRY_MARKER in handler['command']   # the roles of three words are read in the entry that `add` writes, not in a command found by its exact path
                hooks, interpreters, logs = entry_roles(handler['command']) if marked else ([], [], [])
                found += [(ENTRY_FILE, t) for t in command_programs(handler['command'], list(generated) + [t for t in logs if os.path.isabs(t)], values=env)]   # the log is a file of its own below, so no other word of the entry may be it
                if marked:
                    found += [('registered hook', t) for t in hooks] + [('registered interpreter', t) for t in interpreters] + [(ENTRY_LOG, t) for t in logs if os.path.isabs(t)]
            except ScanIncomplete as e:
                found.append((UNSCANNED, f'{e}: {handler["command"][:60]}'))
            except Exception:
                pass
        ours = {id(h) for _g, h in entries}
        for command in other_commands(data, ours):
            try:
                found += [(OTHER_PROGRAM, t) for t in command_programs(command, values=env)]
            except ScanIncomplete as e:
                found.append((UNSCANNED, f'{e}: {command[:60]}'))
            except Exception:
                continue   # one command that cannot be read must not hide the others
    except Exception as e:
        SCANNED[0] = SCANNED[0] or isinstance(e, FileNotFoundError)   # no settings.json is a file without hooks; one that cannot be read is not known
        return list(LAST_SCAN[0])
    if any(x not in LAST_SCAN[0] for x in found):
        LOG_LOOK[0] = None   # a program that no earlier scan found: the look at the log, made before and kept for a second, did not know it
    LAST_SCAN[0] = found + [x for x in LAST_SCAN[0] if x not in found]   # the programs of this scan first: a collision is reported with their label
    return list(LAST_SCAN[0])


def configured_files():
    """Every file the guard reads, writes or runs by its own configuration: the one list for the start check and for the wiring check."""
    return [('configuration file', A.config), *own_files(), ('pause_file', PAUSE_FILE), ('state_file', STATE), ('state_file lock', STATE + '.lock' if STATE else ''),
            ('usage_cache', CACHE), ('usage_cache lock', CACHE + '.lock'), ('log_file', LOG), ('settings_file', SETTINGS or default_settings()),
            ('pause_file lock', PAUSE_FILE + '.lock')]


def program_collisions():
    """[(label of the program, path, file of the guard)]: a hook, interpreter or launcher that the registered entries name and that is
    a file the guard writes (a settings rewrite after the start can put it there), or a program of another hook entry that is one. A write
    would replace the program."""
    outputs = [('pause_file', PAUSE_FILE), ('state_file', STATE), ('log_file', LOG), ('lock of the pause file', PAUSE_FILE + '.lock'),
               ('lock of the state file', STATE + '.lock' if STATE else '')]
    return [(label, path, out_label) for label, path in registered_runtime_files() if label in PROTECTED_LABELS
            for out_label, out in outputs if out and same_file(path, out)]


def own_files():
    """The scripts of the guard itself: what no log, state or pause file may be."""
    return [('guard script', os.path.abspath(__file__)), ('hook script', os.path.join(HERE, HOOK_NAME)),
            ('settings tool script', os.path.join(HERE, 'five-hour-guard-settings.py')), ('entry module', os.path.join(HERE, 'five_hour_guard_entry.py'))]

for _label, _text in registered_runtime_files():
    if _label == UNSCANNED:
        fail(f'{_text}... in {SETTINGS or default_settings()} is not read to its end, so the guard cannot tell whether it names a file of the guard: shorten the command or remove the hook')
check_distinct([*configured_files(), *registered_runtime_files(),
                ('hook_log_file', CFG.get('hook_log_file') if isinstance(CFG.get('hook_log_file'), str) and '\0' not in CFG['hook_log_file'] else '')])
check_writable_dir(PAUSE_FILE, 'pause_file')
if STATE:
    check_writable_dir(STATE, 'state_file')
for _label, _path in (('pause_file', PAUSE_FILE), ('state_file', STATE)):
    # both are replaced atomically: a directory (or another kind of file) there would fail only when a pause is due
    if _path and os.path.exists(_path) and not os.path.isfile(_path):
        fail(f'"{_label}" ({_path}) is not a regular file')


MAX_EXCLUDE_BYTES = 65536   # the pause document holds the list: it stays far under the 1 MiB that the hook reads


def parse_exclude():
    raw = A.exclude if A.exclude is not None else CFG.get('exclude', [])
    if isinstance(raw, str):
        raw = raw.split(',')
    if not isinstance(raw, list) or not all(isinstance(x, str) for x in raw):
        fail('"exclude" must be a list of session id prefixes (or one comma separated string)')
    if len(json.dumps(raw)) > MAX_EXCLUDE_BYTES:
        fail(f'"exclude" is longer than {MAX_EXCLUDE_BYTES} bytes: the hook reads no pause file larger than 1 MiB')
    return [x for x in raw if x]


EXCLUDE = parse_exclude()
ONLY = [x for x in A.test_only.split(',') if x]


def default_resume_below(threshold):
    """The early-resume cutoff when --resume-below is not given: 10 percent under the threshold, but at least half of it. A cutoff of 0 or less
    (a threshold of 10 or less) can never be undercut by a percentage (0 to 100), so a pause could not end early; half of any allowed threshold
    is above 0 and below the threshold (`or`: a threshold so small that half of it rounds to 0 resumes below the threshold itself)."""
    return max(threshold - 10, threshold / 2) or threshold


RESUME_BELOW = A.resume_below if A.resume_below is not None else default_resume_below(A.threshold)
STOP = False


def ts(t=None):
    try:
        return datetime.datetime.fromtimestamp(t if t is not None else time.time()).strftime('%Y-%m-%d %H:%M:%S')
    except (OverflowError, OSError, ValueError):
        return f'(time {t!r} out of range)'


def append_line(path, text):
    """Append to a log without following a link at the final component and without opening anything but a regular file: a link
    that somebody else put in a shared directory must not make this process write into the file it points to. Where os has no O_NOFOLLOW
    (Windows) a link or reparse point at the path is refused before the open."""
    if not hasattr(os, 'O_NOFOLLOW'):
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            st = None
        if st is not None and (stat.S_ISLNK(st.st_mode) or getattr(st, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0)):
            raise OSError(f'{path} is a link: nothing is appended to it')
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0), 0o644)
    try:
        if stat.S_ISREG(os.fstat(fd).st_mode):
            os.write(fd, text.encode('utf-8', 'replace'))
    finally:
        os.close(fd)


def log_is_program():
    """Whether log_file is a hook, interpreter or launcher that a registered entry names, or a program that a command of another hook runs
    (settings.json can be rewritten after the start): nothing is appended to a program. settings.json is read once per tick (safe_tick
    forgets the look) and at most once a second outside a tick, not for every line; a scan that finds a program no earlier scan found
    forgets the look too (registered_runtime_files). The notice goes to stdout only, never through log()."""
    now = time.monotonic()
    if LOG_LOOK[0] is None or now - LOG_LOOK[0] >= LOG_LOOK_S:
        try:
            refuse_program_overwrite(LOG)
            blocked = False
        except OSError:
            blocked = True
        except Exception:
            blocked = False   # a look that fails never costs the log
        LOG_LOOK[:] = [now, blocked]
        if blocked:
            print(f'{ts()} the log file {LOG} is a program that a command in {SETTINGS or default_settings()} runs: nothing is appended to it (change "log_file", or run five-hour-guard-settings.py add again for a hook entry of this guard; a command there that is not read to its end blocks the log too)', flush=True)
    return LOG_LOOK[1]


def log(msg):
    line = f'{ts()} {msg}'
    print(line, flush=True)
    if LOG and not A.dry_run:
        try:
            if not log_is_program():
                append_line(LOG, line + '\n')
        except Exception:
            pass


def fix_hint(label):
    return 'check the configured paths' if label == OTHER_PROGRAM else 'run five-hour-guard-settings.py add again'


def refuse_program_overwrite(*paths):
    """A hook, interpreter or launcher that a registered entry names, or a program that another hook entry runs, is never replaced by a
    write of the guard: settings.json can be rewritten at any moment, so this is looked at at every write (the entry into a pause, each
    renewal and the end of a pause). One look at settings.json serves all the paths of one write."""
    scanned = registered_runtime_files()
    for label, text in scanned:
        if label == UNSCANNED:   # what the command names is not known, so a file of the guard may be among it
            raise OSError(f'{text}... in {SETTINGS or default_settings()} is not read to its end, so the guard cannot tell whether it names {paths[0] if paths else "a file of the guard"}: nothing is written (shorten the command or remove the hook)')
    if not SCANNED[0]:   # a session that loaded settings.json before it was damaged still runs its hooks, and none of them is known
        raise OSError(f'{SETTINGS or default_settings()} cannot be read and no earlier read of it succeeded, so the guard cannot tell whether a hook of it runs {paths[0] if paths else "a file of the guard"}: nothing is written until it can be read')
    programs = [(label, program) for label, program in scanned if label in PROTECTED_LABELS]
    for path in paths:
        for label, program in programs:
            if same_file(program, path):
                raise OSError(f'the {label} {program} is {path}, a file this guard writes: it is not replaced ({fix_hint(label)})')


def file_identity(st):
    return (st.st_dev, st.st_ino, st.st_mtime_ns, st.st_size)


def write_json(path, obj, no_clobber=False, replaces=None):
    """Write atomically. no_clobber: a file that appears at the path meanwhile is kept and the write fails (a hard link is created
    instead of a rename; where links are not supported the destination is reserved exclusively first). replaces: the lstat result of the
    file that this write renews; a file that is not that one any more when the rename is about to happen (somebody replaced the path since
    the validation) is kept and the write fails; a file that is gone is written again."""
    if A.dry_run:
        return
    tmp = f'{path}.{os.getpid()}.{os.urandom(8).hex()}.tmp'   # a name that no other process can have made: nothing is removed to make room for it
    refuse_program_overwrite(path)
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
                    reservation = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o644)
                except FileExistsError:
                    raise OSError(f'the file {path} appeared meanwhile and is not replaced')
                try:
                    reserved = file_identity(os.fstat(reservation))
                finally:
                    os.close(reservation)
                try:   # whoever may write to the directory can remove the reservation and put another file at the path: the rename must not replace that
                    if file_identity(os.lstat(path)) != reserved:
                        raise OSError(f'the file {path} appeared meanwhile and is not replaced')
                except FileNotFoundError:
                    pass   # nothing is there any more: the rename makes the file and replaces nothing
                try:
                    os.replace(tmp, path)
                except BaseException:
                    os.unlink(path)   # the reservation is ours
                    raise
            else:
                os.unlink(tmp)
        else:
            if replaces is not None:
                try:
                    now = os.lstat(path)
                except FileNotFoundError:
                    now = None
                if now is not None and file_identity(now) != file_identity(replaces):
                    raise OSError(f'the file {path} changed since it was validated and is not replaced')
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
            st = load_json(f)
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


CACHE_READ_TRIES = 5     # OMC refreshes the cache by truncating it in place and writing it again: a read in between sees an empty or half-written document
CACHE_RETRY_S = 0.1


def load_cache():
    """The cache document. A document that cannot be decoded is read again a few times (the writer is done within a moment); the last
    failure is raised. A file that is missing or cannot be opened is not repeated."""
    for attempt in range(CACHE_READ_TRIES):
        try:
            with open(CACHE) as f:
                return load_json(f)
        except ValueError:
            if attempt == CACHE_READ_TRIES - 1:
                raise
            time.sleep(CACHE_RETRY_S)


def read_cache():
    """(percent, reset_epoch, age_s, problem); percent is None when there is none. problem is None or (kind, text). Never raises.

    A refresh that was rate limited or failed rewrites the entry with a fresh `timestamp` but keeps the data of the last
    successful fetch (`lastSuccessAt`): the age of the data is then the age of that fetch, not of the rewrite."""
    try:
        d = load_cache()
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
            data = load_json(f)
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
    registered = registered_runtime_files()
    for la, pa, lb, pb in collisions(runtime + registered):
        if not ({la, lb} & (PROTECTED_LABELS | {ENTRY_LOG})):
            continue   # two configured files were refused at the start
        program, other = ((la, pa), (lb, pb)) if la in PROTECTED_LABELS | {ENTRY_LOG} and lb not in PROTECTED_LABELS | {ENTRY_LOG} else ((lb, pb), (la, pa))
        if program[0] == OTHER_PROGRAM:
            log(f'WARNING ({where}): the {program[0]} {program[1]} (run by a command in {SETTINGS}) is the {other[0]} of this guard ({other[1]}): every write of the guard to that file is refused, so the guard stores no pause (check the configured paths)')
        elif program[0] in (ENTRY_FILE, ENTRY_LOG):
            log(f'WARNING ({where}): the hook entry in {SETTINGS} names {program[1]}, which is the {other[0]} of this guard ({other[1]}): the hook would append to it or a write of the guard would replace it, so a pause would hold no session. Run five-hour-guard-settings.py add again')
        else:
            log(f'WARNING ({where}): the {program[0]} {program[1]} is the {other[0]} of this guard ({other[1]}): a write of the guard would replace the program, so a pause would hold no session. Run five-hour-guard-settings.py add again')
    expected = ENTRY.entry_command(PAUSE_FILE, BUNDLED_HOOK, sys.executable, hook_log_setting())
    for command in ours:
        if command != expected:   # one rule instead of a check per field: whatever differs from the generated entry may let calls through
            log(f'WARNING ({where}): the hook entry in {SETTINGS} is not the entry this guard generates for its pause file {PAUSE_FILE}; a difference can let every call through during a pause. Replace its command with this one (or run five-hour-guard-settings.py add): {expected}')


def live_owner():
    """Where no lock names the owner of the pause file (LOCKING is false), the pid of another running process whose document there has a
    current heartbeat; None otherwise (also whenever a lock is held: the lock is then the proof, a live pid proves nothing)."""
    if LOCKING:
        return None
    try:
        with open(PAUSE_FILE) as f:
            doc = load_json(f)
        owner, valid_until = doc.get('pid'), doc.get('valid_until') or 0
        return owner if owner != os.getpid() and valid_until > time.time() and pid_alive(owner) else None
    except Exception:
        return None


def hook_log_collisions():
    """[(file named by the hook entry, label, path)]: a file that the registered entry names (its hook log, hook or interpreter: a settings
    rewrite after the start can make it that) and that is a file of the guard or a program. For every call it holds the hook appends a
    line to its log, which would end a pause (the pause file stops being one), destroy the state or the usage cache, or corrupt the
    program. The start refuses these pairs (check_distinct); this is the same look after the start."""
    found = []
    for la, pa, lb, pb in collisions(configured_files() + registered_runtime_files()):
        if la in (ENTRY_FILE, ENTRY_LOG):
            found.append((pa, lb, pb))
        elif lb in (ENTRY_FILE, ENTRY_LOG):
            found.append((pb, la, pa))
    return found


def check_pause_path():
    """Never publish over a file that is not a pause of this guard: something else may have created it after the start check (a shared or
    mistyped path). Returns the lstat result of the file that exists, None when there is none: the caller acts on this one look (a second
    look could find a file that appeared in between and take it for the pause it may replace) and gives the result to write_json, which
    renews exactly that file. Nothing is published either while the hook log of a registered entry is a file of the guard or a program
    (hook_log_collisions): it is every publication, the entry into a pause and each renewal."""
    if not keep_locks():
        raise OSError('a lock file of this guard was removed or replaced and another guard holds the new one: no pause is published or renewed')
    for log_path, label, _path in hook_log_collisions()[:1]:
        if LAST_WIRING_CHECK[0] is None or time.monotonic() - LAST_WIRING_CHECK[0] >= A.warn_every:
            hook_check('pause refused')   # the wiring check names every file the hook log is, as it does when a pause begins
        raise OSError(f'the hook entry in {SETTINGS or default_settings()} names {log_path}, which is the {label} of this guard: the hook would append its log lines to it or a write would replace it, so no pause is published or renewed (run five-hour-guard-settings.py add again)')
    try:
        seen = os.lstat(PAUSE_FILE)
    except (OSError, ValueError):
        return None
    if not is_guard_pause(PAUSE_FILE):
        raise OSError(f'the file {PAUSE_FILE} is not a pause file of this guard: it is left untouched and no pause is published (check "pause_file")')
    owner = live_owner()
    if owner is not None:   # with no lock the shape of the document says nothing about whose it is: a second guard would renew it with its own pid
        raise OSError(f'the pause file {PAUSE_FILE} belongs to the running process {owner}: another guard uses it, so no pause is published (two guards must not share one pause_file)')
    return seen


def publish(state, pct=None, only=None):
    """(Re)write the pause file the hook reads. Atomic; called every tick while paused."""
    now = time.time()
    doc = {'v': 2, 'paused': True, 'since': state['since'], 'resume_at': state['resume_at'],
           'valid_until': now + A.heartbeat, 'exclude': EXCLUDE, 'percent': pct, 'pid': os.getpid()}
    if only:
        doc['only'] = only
    seen = check_pause_path()
    write_json(PAUSE_FILE, doc, no_clobber=seen is None, replaces=seen)


def unpublish(strict=False):
    """Remove the pause file. False when it could not be removed (logged), so that a caller can keep its state and try again.
    The file is looked at again right before it is removed: one that is not a regular pause document of this guard any more
    (somebody created or replaced it since the last check) is never removed; strict makes that a configuration error (exit 2).
    The path is then moved aside in one step and what was moved is compared with what was looked at: a file that took the place in the
    instant between is put back (nothing is overwritten), so the removal can only hit the file that was looked at."""
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
    owner = live_owner() if ours else None   # no lock: the shape does not say whose pause it is, a live process with a current heartbeat that is not this one published it
    if owner is not None:
        log(f'the pause file {PAUSE_FILE} belongs to the running process {owner}: left alone')
        return True
    if ours:
        gone = f'{PAUSE_FILE}.{os.getpid()}.{os.urandom(6).hex()}.gone'   # a name no earlier file has: the rename must not replace a file that was kept under one
        try:
            os.rename(PAUSE_FILE, gone)
            ours = file_identity(os.lstat(gone)) == file_identity(before)
            if ours:
                os.unlink(gone)
            else:
                try:
                    os.link(gone, PAUSE_FILE)
                except OSError as e:   # FileExistsError: another file is there again; any other error: no hard links on this file system
                    back = False
                    if not isinstance(e, FileExistsError) and not os.path.lexists(PAUSE_FILE):
                        try:
                            os.rename(gone, PAUSE_FILE)   # the name is free: the file goes back by a rename (a file that comes in this very instant would be replaced, which no call here prevents)
                            back = True
                        except OSError:
                            pass
                    if not back:   # the one that was moved aside is kept under its new name, and the log says so
                        log(f'the file that was at {PAUSE_FILE} is not a pause file of this guard and is kept as {gone}')
                else:
                    os.unlink(gone)
        except FileNotFoundError:
            pass
        except Exception as e:
            log(f'cannot remove pause file: {e!r}')
            return False
    if not ours:
        if strict:
            fail(f'the file {PAUSE_FILE} is not a pause file of this guard (it changed since the start check): it is left untouched; check "pause_file", or remove the file yourself')
        log(f'the file {PAUSE_FILE} is not a pause file of this guard any more: left alone')
    return True


def enter_pause(state, pct, reset_ts):
    if not A.dry_run:
        check_pause_path()   # before anything is stored: a pause that cannot be published must not be remembered
        for label, path, out_label in program_collisions():
            raise OSError(f'the {label} {path} is the {out_label} of this guard: a pause would replace the program, so none is stored ({fix_hint(label)})')
        refuse_program_overwrite(*[x for x in (STATE, PAUSE_FILE) if x])   # also a command that is not read to its end: no pause is remembered that cannot be written
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
    global STOP
    LOG_LOOK[0] = None   # settings.json may have been rewritten since the last tick: the log is looked at again
    try:
        if not keep_locks():   # another guard holds the lock of that name now: this one leaves the pause file to its heartbeat and stops, the service manager starts it again
            log('ERROR: a lock file of this guard was removed or replaced and another guard holds the new one: stopping, the pause file is left alone')
            STOP = True
            return False
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
            d = load_json(f)
        return (isinstance(d, dict) and d.get('v') == 2 and type(d.get('v')) is int and d.get('paused') is True and type(d.get('pid')) is int
                and all(type(d.get(k)) in (int, float) and math.isfinite(d[k]) for k in ('since', 'resume_at', 'valid_until')))
    except Exception:
        return False


def drop_leftover_pause():
    """A pause file with no state behind it is a leftover of a dead guard: remove it (main has checked that it is a pause file
    of this guard and that no live process owns it). False when it could not be removed."""
    return unpublish(strict=True)


LOCK_FDS = []   # [descriptor, path] of every lock file held
LOCK_LOST = [False]


def take_lock(path):
    """The descriptor of the lock file at `path` with an exclusive lock held on it; None when another process holds the lock; OSError
    when the file cannot be opened."""
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)   # never through a link put there
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)   # one byte at the start of the empty file; released when the process ends
    except OSError:
        os.close(fd)
        return None
    return fd


def lock_one(path, what):
    """Hold an exclusive flock on a sibling file for the whole life of the process."""
    try:
        fd = take_lock(path)
    except OSError as e:
        fail(f'cannot open the lock file {path}: {e!r}')
    if fd is None:
        fail(f'another guard holds {path}: one guard per {what}')
    LOCK_FDS.append([fd, path])   # held until the process ends


def keep_locks():
    """True when every lock file still is the file this guard holds the lock on. Cleanup or another process can remove or replace one
    while the guard runs; the lock then excludes nobody, so the file now at the path is locked again. False (and LOCK_LOST) when another
    guard holds it: this one must stop and publish or remove no pause. OSError when the path cannot be opened now (its directory is
    gone): the caller fails like a write that fails, and the next tick tries again."""
    for entry in LOCK_FDS:
        fd, path = entry
        try:
            held, named = os.fstat(fd), os.lstat(path)
            if (held.st_dev, held.st_ino) == (named.st_dev, named.st_ino):
                continue
        except FileNotFoundError:
            pass
        fresh = take_lock(path)
        if fresh is None:
            LOCK_LOST[0] = True
            return False
        os.close(fd)
        entry[0] = fresh
    return True


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
                ours = load_json(f).get('pid') == os.getpid()
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
    owner = live_owner()
    if owner is not None:
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
        if not (A.once or A.dry_run or LOCK_LOST[0]) and (state.get('paused') or state.get('unlink_pending')):
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
    return 1 if LOCK_LOST[0] else 0


if __name__ == '__main__':
    sys.exit(main())
