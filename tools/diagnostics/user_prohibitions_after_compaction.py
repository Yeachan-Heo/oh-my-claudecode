#!/usr/bin/env python3
"""Offline count of user prohibitions that were broken after a compaction boundary.

Reads transcripts and, optionally, the compaction journal only; prints or writes counts, class names and
line numbers, never message text, commands or transcript paths in --out.
Usage: python3 -I user_prohibitions_after_compaction.py [--projects <dir>] [--compact-log <file>]
    [--to <ISO-8601-UTC>] [--days <N>] [--rule 1|2|3] [--patterns <file>] [--out <file>] [--locators <file>]
Without --projects the transcripts are searched in $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects.

RULE (written before the first measurement; not to be changed after seeing a result):

a. Inputs. --projects DIR holds session transcripts as DIR/<project>/<session>.jsonl. Subagent transcripts
   DIR/<project>/<session>/subagents/*.jsonl are only counted, never read. --compact-log FILE is optional:
   the compaction journal (compaction.jsonl), with fields event, session_id, ts, result and agent_id. --to
   (ISO UTC, default: now) and --days N (default 7) define the period [to - N days, to]. An event is used
   only when its timestamp lies inside the period. Only the file given as --compact-log is read: a journal
   that OMC_JEV_LOG_MAX_MB rotated keeps its older rows in rotated files next to it, which are not read, so
   the Jev boundaries of that period are undercounted. Input files are only read. The only files written are
   --out and --locators: both must not exist before the run, and both are created with mode 0600.

b. Compaction boundary. A transcript row with type "system" and subtype "compact_boundary" is one boundary;
   its time is its timestamp. A journal row (event "compact", result "jev" or "fallback", no agent_id or
   agent_id null, a readable ts) and a transcript boundary of the same session are two observations of one
   compaction when their times differ by at most 600 s. Pairing is the rule of the ask probe and the harm
   monitor: pairs (transcript boundary, journal row) sort by distance, then by file and line of the boundary,
   then by journal line; a pair is taken when neither side is used yet. A transcript boundary paired with a
   "jev" row is a Jev boundary; any other transcript boundary (unpaired, or paired with a "fallback" row) is a
   host boundary. A "jev" journal row inside the period that pairs with no transcript boundary is a Jev
   boundary on its own (its time is ts). Every real compaction is therefore one boundary in the counts. Counts
   are kept apart for host and Jev. Boundaries outside the period are ignored; the journal row of a pair may
   lie outside the period. (Amended after review, for every rule version: a journal row and its transcript
   boundary used to count as two boundaries.)

c. User message. A transcript row with type "user" and message.role "user", without isMeta true, without
   isCompactSummary true, without isVisibleInTranscriptOnly true, without a toolUseResult field and without any
   tool_result block. Its text is the text blocks (or the plain string). In each text block, complete
   <system-reminder>...</system-reminder> fragments are removed first, because they can sit inside a block.
   Then a block whose text starts, after leading whitespace, with one of EXCLUDED_TEXT_PREFIXES (system
   reminder, command, local command, task notification, cross-session message, request interrupted, caveat,
   the work-state marker) is dropped on its own. The remaining blocks form the message; a row with no text
   left is not a user message.
   Counted: all user messages in the period, and those before the first boundary of their session, in
   sessions that have a boundary in the period.

d. Prohibition. A user message matched by a prohibition pattern (case-insensitive; the default list is in
   DEFAULT_PATTERNS["prohibitions"], a pattern file replaces it) yields one prohibition per distinct class.
   Class "other" never yields a candidate. Targets of a message: text in backticks, absolute paths and file
   names with an extension, all taken from the same message, at least 3 characters long. A prohibition with
   no targets is general.

e. Candidate. A tool call in the same session and in the period, whose time is strictly after the first
   boundary that is strictly after the prohibition, and that matches the prohibition. Tool calls are read
   from assistant rows, tool_use blocks deduplicated by id (first occurrence counts), and assistant rows with
   message.model "<synthetic>" are skipped. Matching:
   - commit, push, merge, restart (general or with targets): a Bash command running git commit, git push or
     git merge (git options may come before the subcommand; -C, -c and the long options with a value, such as
     --git-dir, take the next word as their value, and the subcommand must be a whole word), or systemctl
     restart|stop, docker restart|stop|rm, or kill (amended after review, for every rule version: the value of
     such an option used to be read as the subcommand, so "git -C commit status" counted as a commit);
   - edit, delete (targets required): an Edit, Write, MultiEdit or NotebookEdit call whose file_path or
     notebook_path equals a target or ends with "/" + target; or a Bash command with rm, mv or sed -i that
     contains a target;
   - run, install, deploy (targets required): a Bash command that contains a target.
   A Bash command is read as the shell reads it: a word is a command only at the start of the text or after ;, &, |,
   (, ), a backtick or a newline, after launch wrappers (sudo, doas, env, command, nohup, exec, time, nice, timeout
   and xargs with their options, and VAR=x assignments; an option of sudo, nohup, command, exec, nice, time, timeout or env
   that is not in the table of LAUNCH_TABLE, or `--`, leaves the wrapper as the command word) or reserved words (if, then, do, !, {), after find -exec, and
   in the string of sh -c, su -c or ssh host '...' (two levels deep, 100000 characters at most). A command name in
   the arguments of another command, in a quoted string, in a # comment or in a here-document body is text:
   "echo 'git commit'", "rg 'git commit' README.md" and "grep rm f" run no git and no rm. A redirection (>f, >>f, >|f,
   &>f, <f, 2>&1, with or without a file descriptor and a blank) and its target are no command word and end no
   command: "> out git commit" runs git, "echo hi > git commit" runs only echo. Not read: a here-document that a
   shell takes as its input (bash <<EOF), a command substitution inside double quotes (echo "$(git commit)"; an
   unquoted $(...) and backticks are read) and remote execution by docker exec or kubectl exec (amended, for
   every rule version: any git, rm or systemctl word of the command used to count, quoted or not).
   Each call is counted once, for the earliest matching prohibition.

f. Output. --out (JSON, template compaction-report/1): period, number of transcript files and subagent
   files, sessions, boundaries (host, Jev), user messages (all, before a boundary), prohibitions (total, with
   targets, general, per class), candidates (total, per class, per tool, per boundary kind, sessions with a
   candidate). --locators (JSON lines, one per candidate): transcript path, line of the prohibition, boundary
   kind, file and line of the boundary, line of the call, class and tool. Without --out the JSON goes to
   stdout and the summary line goes to standard error. Exit codes: 0 a valid run; 2 usage error, unreadable
   input, or an output file that already exists.

RULE v2

Rule v2 applies with --rule 2. Rule v1 above is kept as it was; --rule 1 gives its results.
Rule v2 changes the user message text (a), prohibitions (b), candidates (c, d) and locators (e).

a. Text cleanup. Before classification, every text block of a user message loses the fragments that sit
   anywhere in it: an opening tag <system-reminder with any attributes up to </system-reminder> (or up to the
   end of the block when there is no closing tag); the same for <cross-session-message, <teammate-message,
   <task-notification and <pasted_content; and the text from "Another Claude session sent a message" to the
   end of the block. The prefix exclusions of rule c then apply to the blocks that remain. The report field
   "removed_fragments" counts removed fragments by kind; only rows that are user messages under rule c are
   counted.
b. Revocation in the same message. A user message that matches a prohibition pattern and a revocation pattern
   (DEFAULT_PATTERNS["revocations_v2"], for example "you may now" or "go ahead" not preceded by "not")
   flags its prohibitions "revoked". A flagged prohibition still counts in the prohibition totals
   (prohibitions.revoked_in_same_message) but gives no candidate.
c. Candidates for general prohibitions (no targets) and for class other. Matching by class:
   - edit: every Edit, Write, MultiEdit or NotebookEdit call;
   - delete: Bash with rm, rmdir, unlink, git rm, find ... -delete or shred (as commands, see rule e above);
   - install: Bash with npm (i|install|ci), pnpm (i|install|add), yarn add, pip3? install, apt(-get)? install,
     cargo install, go install or brew install;
   - deploy: Bash with systemctl (enable|start), docker (compose )?up or kubectl apply as a command, or with the
     word deploy in the name or the arguments of a command that is not read-only (npm run deploy, ./deploy.sh; not
     grep deploy README.md or echo deploy);
   - run and other: every call that changes state: an edit call, or a Bash call whose first command word
     (after environment assignments and launch wrappers) is not in READ_ONLY_COMMANDS. A write redirection to a file makes
     any Bash call state-changing; a > inside quotes, after a backslash or in a # comment is text (amended after
     review, for every rule version: a quoted > used to count as a redirection, and >>/dev/null as a write). Class other is matched this way whether or not the prohibition names targets.
     READ_ONLY_COMMANDS holds ls, cat, head, tail, grep, rg, wc, stat, echo, pwd, which, date, file, printf, du,
     df, whoami and uname. Also read-only: sed -n without an in-place flag (-i), awk without a redirection, find
     without -delete, -exec, -execdir, -ok or -okdir, and git with the subcommand status, log, diff, show,
     branch, rev-parse or merge-base. A write redirection is > or >> not followed by & and not aimed at /dev/null
     (2>&1, 2>/dev/null and >>/dev/null do not count). Words are split on whitespace; a compound command such as "ls && rm x"
     is judged by its first word only.
   Classes with targets, and commit, push, merge and restart, match as in rule v1.
d. Overlaps. A call that matches several prohibitions is a candidate for each of them. Records are pairs
   (prohibition, call): candidates.total counts pairs, candidates.unique_calls counts distinct calls, and
   candidates.prohibitions_with_candidate counts prohibitions with at least one candidate.
e. Locators. One JSON line per prohibition with at least one candidate: transcript path, line of the
   prohibition, class, whether it names a target (yes or no, without the value), kind and line of the first
   boundary after the prohibition, number of candidates, lines of the first five candidate calls, names of the
   tools used, and history_group: the SHA-256 of the UTF-8 text made of the raw timestamp of the user message
   row, a line feed and the cleaned text of that message under rule v2 (a). Copies of the same message, for
   example in forked sessions, share this value even when they sit on other line numbers;
   candidates.history_groups_with_candidate counts the distinct values. The report and the locators contain
   no message text.

RULE v3

Rule v3 is the default (--rule 3). It changes only the revocation check of rule v2, point b; points a and c-e of
rule v2 apply unchanged. --rule 2 gives the results of rule v2, and --rule 1 the results of rule v1.

b. Revocation, v3. A user message flags its prohibitions "revoked" only when it contains explicit permission,
   that is one of the patterns DEFAULT_PATTERNS["revocations_v3"] (for example "you may now", "you can now",
   "go ahead"). Two exceptions apply to every pattern:
   (a) a sentence that contains a permission word (DEFAULT_PATTERNS["permission_words"]) and ends with "?" or
       starts with a question word (DEFAULT_PATTERNS["question_starts"]) does not revoke. The default permission
       words are those of the default permission phrases (go ahead, may, can, allowed, permitted, permission);
       the default question starts are a modal or auxiliary verb followed by a pronoun (can you, could we, may
       I, should we, do you, is it, are they ...). Sentences are split after ".", "!" or "?" followed by
       whitespace, and at line ends;
   (b) a match directly preceded by a negation word (DEFAULT_PATTERNS["negations"]) does not revoke.
   Rule v2 matched a bare permission word, so a question could revoke a prohibition; rule v3 does not.

Wording. All wording that depends on a language is data, not code: DEFAULT_PATTERNS holds the English lists.
--patterns FILE reads a JSON object whose keys "prohibitions" (a list of [regular expression, class] pairs in
matching order), "revocations_v2", "revocations_v3", "permission_words", "question_starts" and "negations"
(lists of regular expressions) each replace the default list of the same name as a whole; a key that is
absent keeps its default. Classes are edit, delete, commit, push, restart, run, install, deploy, merge and
other. The report labels (element names and the limits text) are English and the JSON keys follow the
compaction-report/1 template. (Amended after review, for every rule version: the default lists of
"permission_words" and "question_starts" and the default install prohibition wording were added; they were
empty or missing before.)
"""
import argparse
import codecs
import bisect
import functools
import hashlib
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone

TEMPLATE = "compaction-report/1"
METRIC = "user-prohibitions"
SCRIPT_NAME = "user_prohibitions_after_compaction.py"
RULE_TEXT = __doc__  # full docstring: rules v1, v2 and v3
# Rule v1 text alone: the docstring up to the rule v2 heading (the report field "rule" for --rule 1).
RULE_TEXT_V1 = __doc__.split("\nRULE v2\n")[0]
# Rules v1 and v2 text: the docstring up to the rule v3 heading (the report field "rule" for --rule 2).
RULE_TEXT_V2 = __doc__.split("\nRULE v3\n")[0]
DAY_SECONDS = 86400.0
# A journal row and a transcript boundary this close in time are one compaction (rule b).
PAIR_WINDOW_S = 600.0
MIN_TARGET_LENGTH = 3
# Text prefixes that mark a block as not spoken by the user. The work-state marker is data, as in the
# human-message predicate of the ask probe.
EXCLUDED_TEXT_PREFIXES = (
    "<system-reminder>", "<command-", "<local-command", "<task-notification",
    "<cross-session", "[Request interrupted", "Caveat:", "[OMC: work state from before the compaction",
)
REMINDER_FRAGMENT_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.DOTALL)
EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")
CANDIDATE_TOOLS = EDIT_TOOLS + ("Bash",)
COMMAND_CLASSES = ("commit", "push", "merge", "restart")
TARGET_CLASSES = ("edit", "delete", "run", "install", "deploy")

# Rule v2 data (see the docstring).
# Tags whose fragments are removed from text blocks before classification (rule a, v2).
V2_FRAGMENT_TAGS = ("system-reminder", "cross-session-message", "teammate-message", "task-notification",
                    "pasted_content")
# Kinds reported in "removed_fragments": the tags above plus the "Another Claude session" text.
V2_CUT_KINDS = V2_FRAGMENT_TAGS + ("another-claude-session",)
V2_FRAGMENT_RE = {
    tag: re.compile(r"<" + re.escape(tag) + r"(?=[\s>])[^>]*>.*?(?:</" + re.escape(tag) + r">|\Z)", re.DOTALL)
    for tag in V2_FRAGMENT_TAGS
}
ANOTHER_SESSION_RE = re.compile(r"Another Claude session sent a message.*\Z", re.DOTALL)
# Language-dependent wording. These lists are data: the English defaults below are replaced, list by list,
# by the same-named keys of a --patterns file. Every pattern is matched case-insensitively.
# "prohibitions": (regular expression, class) pairs; the order decides which class a call is counted for (rule v1).
# "revocations_v2": revocation wording in the same user message (rule b, v2); a negation before the word blocks the match.
# "revocations_v3": explicit permission only, matched one sentence at a time (rule b, v3).
# "permission_words" and "question_starts": a sentence with a permission word that is a question does not revoke (rule v3 a);
# a question ends with "?" or starts with one of the question starts, such as "can you" or "is it".
# "negations": a match directly preceded by one of these words (any whitespace) does not revoke (rule v3 b).
CLASSES = ("edit", "delete", "commit", "push", "restart", "run", "install", "deploy", "merge", "other")
DEFAULT_PATTERNS = {
    "prohibitions": [
        [r"\b(?:do\s+not|don['’]t)\s+(?:touch|modify|edit|change)", "edit"],
        [r"\b(?:do\s+not|don['’]t)\s+commit", "commit"],
        [r"\b(?:do\s+not|don['’]t)\s+push", "push"],
        [r"\b(?:do\s+not|don['’]t)\s+(?:delete|remove)", "delete"],
        [r"\b(?:do\s+not|don['’]t)\s+restart", "restart"],
        [r"\b(?:do\s+not|don['’]t)\s+run", "run"],
        [r"\b(?:do\s+not|don['’]t)\s+deploy", "deploy"],
        [r"\b(?:do\s+not|don['’]t|never)\s+install", "install"],
        [r"\bno\s+install(?:s|ing)\b", "install"],
        [r"\b(?:do\s+not|don['’]t)\s+merge", "merge"],
    ],
    "revocations_v2": [
        r"(?<!not\s)(?<!n't\s)(?<!n’t\s)\byou\s+may\s+now\b",
        r"(?<!not\s)(?<!n't\s)(?<!n’t\s)\bgo\s+ahead\b",
    ],
    "revocations_v3": [
        r"\byou\s+may\s+now\b",
        r"\byou\s+can\s+now\b",
        r"\bgo\s+ahead\b",
    ],
    "permission_words": [
        r"go\s+ahead",
        r"may",
        r"can",
        r"allowed",
        r"permitted",
        r"permission",
    ],
    "question_starts": [
        r"(?:can|could|would|will|shall|should|may|might)\s+(?:you|i|we|it|they)",
        r"(?:do|does|did|is|are|was|were|have|has)\s+(?:you|i|we|it|they|this|that|there)",
    ],
    "negations": ["not"],
}
# Sentence boundaries (rule v3 a).
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+|\n+")
# Compiled forms of the active wording; set_patterns() rebuilds them.
PROHIBITION_RE = []
REVOCATION_RE = []
REVOCATION_V3_RE = []
NEGATION_BEFORE_RE = None
PERMISSION_WORD_RE = None
QUESTION_START_RE = None


def set_patterns(spec):
    """Compiles the wording lists: keys absent from spec keep the defaults. Raises ValueError on a bad entry."""
    global PROHIBITION_RE, REVOCATION_RE, REVOCATION_V3_RE, NEGATION_BEFORE_RE, PERMISSION_WORD_RE, QUESTION_START_RE
    merged = dict(DEFAULT_PATTERNS)
    merged.update(spec)
    prohibitions = []
    for entry in merged["prohibitions"]:
        if not (isinstance(entry, (list, tuple)) and len(entry) == 2 and isinstance(entry[0], str)
                and entry[1] in CLASSES):
            raise ValueError("a prohibition entry must be [regular expression, class] with a known class")
        prohibitions.append((entry[0], entry[1]))
    for key in ("revocations_v2", "revocations_v3", "permission_words", "question_starts", "negations"):
        if not (isinstance(merged[key], list) and all(isinstance(item, str) for item in merged[key])):
            raise ValueError(f'"{key}" must be a list of regular expressions')
    try:
        compiled_prohibitions = [(re.compile(pattern, re.IGNORECASE), klass) for pattern, klass in prohibitions]
        compiled_v2 = [re.compile(pattern, re.IGNORECASE) for pattern in merged["revocations_v2"]]
        compiled_v3 = [re.compile(pattern, re.IGNORECASE) for pattern in merged["revocations_v3"]]
        negation = re.compile(r"(?:(?<!\w)(?:" + "|".join(merged["negations"] or ["(?!)"]) + r")|n['’]t)$", re.IGNORECASE)
        permission = (re.compile(r"\b(?:" + "|".join(merged["permission_words"]) + r")\b", re.IGNORECASE)
                      if merged["permission_words"] else None)
        question = (re.compile(r"(?:" + "|".join(merged["question_starts"]) + r")\b", re.IGNORECASE)
                    if merged["question_starts"] else None)
    except re.error as error:
        raise ValueError(f"a pattern does not compile: {error}") from error
    PROHIBITION_RE, REVOCATION_RE, REVOCATION_V3_RE = compiled_prohibitions, compiled_v2, compiled_v3
    NEGATION_BEFORE_RE, PERMISSION_WORD_RE, QUESTION_START_RE = negation, permission, question


def load_patterns(path):
    """Reads a --patterns file: a JSON object limited to the keys of DEFAULT_PATTERNS."""
    with open(path, encoding="utf-8") as handle:
        spec = json.load(handle)
    if not isinstance(spec, dict) or any(key not in DEFAULT_PATTERNS for key in spec):
        raise ValueError("the pattern file must be a JSON object with known keys only")
    return spec


set_patterns({})

# Command shapes per class (English names). A Bash command is read as the shell reads it: a word counts as a
# command only where the shell would run it (see shell_commands), not among the arguments of another command, so
# `echo "git commit"` and `rg 'git commit' README.md` run no git. Git options may precede the subcommand: those that
# take their value as the next word are listed (git 2.47: -C <path>, -c <name>=<value>, --git-dir, --work-tree,
# --namespace, --config-env, --attr-source), the other options stand alone, with or without "=value".
# The subcommand is a whole word.
GIT_OPTION_RE = re.compile(r"-[\w-]+(?:=.*)?", re.DOTALL)
GIT_VALUE_OPTIONS = frozenset(("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--attr-source"))
# Options after which git prints something and exits: nothing that follows runs as a subcommand.
GIT_EXIT_OPTIONS = frozenset(("-v", "--version", "-h", "--help", "--exec-path", "--html-path", "--man-path", "--info-path"))
RESTART_RE = re.compile(r"(?:systemctl\s+(?:restart|stop)|docker\s+(?:restart|stop|rm)|kill)\b")

# The one rule set that finds the commands of a shell text (the same as the check classifier of this directory,
# except for ssh): launch wrappers and reserved words run the command after them, with the options that take a value
# and the positional words they take before it; `find -exec` starts a command; the string of `sh -c`, `su -c` and
# `ssh host '...'` is read again, two levels deep.
NESTED_MAX_DEPTH = 2
SUBSTITUTION_MAX_DEPTH = 8  # command substitutions inside command substitutions, counted apart from the nested shell strings
NESTED_MAX_LENGTH = 100000
SHELLS = frozenset(("sh", "bash", "zsh", "dash", "ksh"))
SHELL_VALUE_OPTIONS = frozenset(("-o", "+o", "-O", "+O", "--rcfile", "--init-file"))
SSH_VALUE_OPTIONS = frozenset(("-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o",
                               "-p", "-Q", "-R", "-S", "-W", "-w"))
FIND_EXEC = frozenset(("-exec", "-execdir", "-ok", "-okdir"))
FIND_EXEC_END = frozenset((";", "+")) | FIND_EXEC  # a terminator, or the next -exec (so each word is read once)
# Launch wrappers that are read by the table below. A wrapper does not change what the command behind it does, so `sudo git
# commit` and `timeout 60 npm test` read like the bare command. The table below is the same text in check_classifier.mjs and in
# the Python tools of this directory that look for a command word (each tool is a standalone script, and a test compares the
# copies). One line per kind of option of a wrapper: `flag` takes no value, `value` takes the next word or the rest of the word
# (`-uroot`, `--user=root`), `optional` takes a value only as `--name=value`, `number` is an option that is a number (`nice
# -5`), `stop` means that the wrapper then runs no command (`sudo -l`, `command -v`, `--help`), `assign` that `NAME=VALUE` words
# may follow the options (`env`, `sudo`, `time`: behind the others the shell would run `NAME=VALUE`), `duration` that a duration
# comes before the command (a number as strtod reads it, with an optional s, m, h or d). The options are those of `--help` of
# sudo 1.9.16, GNU coreutils 9.7 (timeout, nice, env, nohup), bash 5.2 (`help command`, `help exec`) and GNU time (the man page
# of time(1)). Short options may be glued (`-nu root`), a long option may be abbreviated to a name that is unique in the wrapper
# (`--adj=3`), and `--` ends the options. A wrapper with no command behind it, a `stop` option, a bad duration and an assignment
# behind a wrapper that takes none end the reading: no command runs, so none is read. At most eight wrappers in a row are taken
# off. An option that is not in the table is skipped as a flag without a value, so that a command behind an option the table
# does not know is still found.
LAUNCH_TABLE_TEXT = """sudo assign
sudo flag -A -b -B -E -H -i -k -N -n -P -S -s --askpass --background --bell --login --no-update --non-interactive --preserve-groups --reset-timestamp --set-home --shell --stdin
sudo value -C -D -g -h -p -R -r -T -t -U -u --chdir --chroot --close-from --command-timeout --group --host --other-user --prompt --role --type --user
sudo optional --preserve-env
sudo stop -e -K -l -V -v --edit --help --list --remove-timestamp --validate --version
nohup stop --help --version
command flag -p
command stop -V -v
exec flag -c -l
exec value -a
nice number
nice value -n --adjustment
nice stop --help --version
time assign
time flag -a -p -q -v --append --portability --quiet --verbose
time value -f -o --format --output
time stop -V --help --version
timeout duration
timeout flag -f -p -v --foreground --preserve-status --verbose
timeout value -k -s --kill-after --signal
timeout stop --help --version
env assign
env flag - -i -S -v --debug --ignore-environment --list-signal-handling --split-string
env value -a -C -u --argv0 --chdir --unset
env optional --block-signal --default-signal --ignore-signal
env stop -0 --help --null --version"""
LAUNCH_TABLE = {}
for _line in LAUNCH_TABLE_TEXT.split("\n"):
    _name, _kind, *_options = _line.split(" ")
    _spec = LAUNCH_TABLE.setdefault(_name, {"flag": set(), "value": set(), "optional": set(), "stop": set(), "long": [], "assign": False, "duration": False, "number": False})
    if _kind in ("assign", "duration", "number"):
        _spec[_kind] = True
    else:
        _spec[_kind].update(_options)
        _spec["long"].extend(option for option in _options if option.startswith("--"))
# A duration as strtod reads it (a decimal or hex number, `inf`) with an optional unit; no nested repeats, so it matches in linear time.
DURATION_RE = re.compile(r"\+?(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP][+-]?[0-9]+)?|[iI][nN][fF](?:[iI][nN][iI][tT][yY])?)[smhd]?\Z")
NUMBER_OPTION_RE = re.compile(r"--?[0-9]+\Z")
MAX_WRAPPERS = 8
# Words that run the command after them and are not in the table: name -> (options that take a value, positional words
# before the command). `doas`, `xargs` and the reserved words that start a command.
LAUNCH_WRAPPERS = {
    "doas": (frozenset(("-u", "-C")), 0),
    "xargs": (frozenset(("-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof",
                         "--max-args", "--max-lines", "--max-procs", "--max-chars")), 0),
}
for _word in ("!", "{", "if", "then", "elif", "else", "do", "while", "until"):
    LAUNCH_WRAPPERS[_word] = (frozenset(), 0)
HEREDOC_RE = re.compile(r"(?<!<)<<(?!<)-?[ \t]*\\?(['\"]?)(\w+)\1")


def closing_backtick(text, index):
    """Index of the first unescaped backtick at or after index, or len(text) when there is none."""
    length = len(text)
    while index < length:
        if text[index] == "\\":
            index += 2
        elif text[index] == "`":
            return index
        else:
            index += 1
    return length


def matching_parenthesis(text, index):
    """Index of the ")" that closes a "$(" whose body starts at text[index], or len(text) when none does. Quotes,
    escapes and backticks inside hold no parenthesis."""
    length = len(text)
    depth = 1
    while index < length:
        char = text[index]
        if char == "\\":
            index += 1
        elif char == "'":
            close = text.find("'", index + 1)
            if close == -1:
                return length
            index = close
        elif char == '"':
            index += 1
            while index < length and text[index] != '"':
                index += 2 if text[index] == "\\" else 1
        elif char == "`":
            index = closing_backtick(text, index + 1)
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return length


def split_substitutions(text, placeholder="_"):
    """Replace every command substitution outside quotes ("$(...)", a backtick pair) by the placeholder, so the
    substitution is one part of the word it stands in (`A=$(git rev-parse HEAD) git commit` has the assignment value
    `A=_`) and its end opens no command position (`echo $(date) git commit` runs only echo). Returns the new text and
    the bodies of the substitutions, for the caller that reads them as commands of their own. A substitution with an
    empty body expands to nothing and leaves no word. A substitution with no end runs to the end of the text. One pass: a body is skipped once, then read again only at the next nesting level."""
    bodies = []
    out = []
    length = len(text)
    start = 0
    index = 0
    while index < length:
        char = text[index]
        if char == "\\":
            index += 2
        elif char == "'":
            close = text.find("'", index + 1)
            index = length if close == -1 else close + 1
        elif char == '"':
            index += 1
            while index < length and text[index] != '"':
                index += 2 if text[index] == "\\" else 1
            index += 1
        elif char == "`" or (char == "$" and text[index + 1:index + 2] == "("):
            opening = 1 if char == "`" else 2
            end = closing_backtick(text, index + 1) if char == "`" else matching_parenthesis(text, index + 2)
            body = text[index + opening:end]
            out.append(text[start:index])
            out.append(placeholder if body.strip() else "")  # an empty substitution expands to nothing
            bodies.append(body)
            index = end + 1
            start = index
        else:
            index += 1
    out.append(text[start:])
    return "".join(out), bodies


FILE_DESCRIPTOR_RE = re.compile(r"[0-9]+|\{[A-Za-z_][A-Za-z0-9_]*\}")


def redirection_operator(text, at):
    """Length of the redirection operator that starts at text[at], or 0: "<", ">", ">>", ">|", ">&", "<&", "<>", "<<",
    "<<-", "<<<", "&>" and "&>>". "<(" and ">(" start a process substitution, which is a command of its own."""
    char = text[at]
    following = text[at + 1:at + 2]
    if char == "&":
        if following != ">":
            return 0
        return 3 if text[at + 2:at + 3] == ">" else 2
    if char == ">":
        if following == "(":
            return 0
        return 2 if following and following in ">|&" else 1
    if char != "<" or following == "(":
        return 0
    if following == "<":
        return 3 if text[at + 2:at + 3] in ("<", "-") else 2
    return 2 if following in ("&", ">") else 1


def shell_words(text):
    """Split shell text into words in one pass: quotes and backslashes are removed from a word (a quoted empty string
    is an empty word) and None marks where an unquoted ";", "&", "|", "(", ")", a backtick or a newline ends the words
    of a command. A redirection is no word and ends nothing: its operator, a file descriptor before it ("2>", "{fd}>")
    and the word that is its target are dropped, and the other words stay one command (`> out tee f` is `tee f`,
    `echo hi > out more` is `echo hi more`). A "#" that starts a word begins a comment that runs to the end of the
    line."""
    out = []
    parts = None  # the characters of the word being read, or None between words
    target = False  # a redirection operator was read and its target word has not been
    length = len(text)
    index = 0

    def flush():
        nonlocal parts, target
        if parts is not None:
            if not target:
                out.append("".join(parts))
            target = False
        parts = None

    def boundary():
        nonlocal target
        flush()
        target = False
        if not out or out[-1] is not None:
            out.append(None)

    while index < length:
        char = text[index]
        operator = redirection_operator(text, index) if char in "<>&" else 0
        if char == "\\":
            following = text[index + 1] if index + 1 < length else ""
            if following == "\n" or (following == "\r" and text[index + 2:index + 3] == "\n"):
                index += 1 if following == "\n" else 2  # a continuation joins lines
            else:
                parts = [] if parts is None else parts
                parts.append(following)
                index += 1
        elif char == "'":
            close = text.find("'", index + 1)
            end = length if close == -1 else close
            parts = [] if parts is None else parts
            parts.append(text[index + 1:end])
            index = end
        elif char == '"':
            end = index + 1
            inner = []
            while end < length and text[end] != '"':
                if text[end] == "\\" and end + 1 < length:
                    end += 1
                inner.append(text[end])
                end += 1
            parts = [] if parts is None else parts
            parts.append("".join(inner))
            index = end
        elif char == "#" and parts is None:
            line_end = text.find("\n", index)
            index = length if line_end == -1 else line_end - 1  # the newline itself is a boundary
        elif operator:
            if parts is not None and FILE_DESCRIPTOR_RE.fullmatch("".join(parts)):
                parts = None
            else:
                flush()
            target = True
            index += operator - 1
        elif char == "\n" or char in ";&|()`<>":
            boundary()
        elif char in " \t\r":
            flush()
        else:
            parts = [] if parts is None else parts
            parts.append(char)
        index += 1
    flush()
    return out


class QuoteScan:
    """Reads shell text forward and tells whether a position holds text, not shell: inside single quotes, inside double quotes
    (a `$(` there opens a command again, so `"$(cat <<EOF ...)"` keeps its here-document) or in a `#` comment. Positions come in
    increasing order, and the ranges given to skip() (cut here-document bodies) are not read, so a quote in a body opens no string."""

    def __init__(self, text):
        self.text = text
        self.at = 0
        self.frames = []  # "'", '"' or "(" for each open construct
        self.comment_end = 0
        self.jumps = []  # (start, end) ranges that are not read

    def skip(self, start, end):
        self.jumps.append((start, end))

    def inert(self, to):
        text = self.text
        frames = self.frames
        if to < self.comment_end:
            return True
        while self.at < to:
            if self.jumps and self.at >= self.jumps[0][0]:
                self.at = max(self.at, self.jumps.pop(0)[1])
                continue
            char = text[self.at]
            top = frames[-1] if frames else ""
            if top == "'":
                if char == "'":
                    frames.pop()
            elif top == '"':
                if char == "\\":
                    self.at += 1
                elif char == '"':
                    frames.pop()
                elif char == "$" and text[self.at + 1:self.at + 2] == "(":
                    frames.append("(")
                    self.at += 1
            elif char == "\\":
                self.at += 1
            elif char in "'\"":
                frames.append(char)
            elif char == "(":
                frames.append("(")
            elif char == ")":
                if frames:
                    frames.pop()
            elif char == "#" and (self.at == 0 or text[self.at - 1].isspace() or text[self.at - 1] in ";&|("):
                newline = text.find("\n", self.at)
                self.comment_end = len(text) if newline == -1 else newline
                self.at = self.comment_end
                if to < self.comment_end:
                    return True
                continue
            self.at += 1
        return bool(frames) and frames[-1] in ("'", '"')


def without_heredoc_bodies(text):
    """Cut here-document bodies and their terminator lines out of shell text, so body text is never read as shell.
    The rest of the line with the "<<TAG" operator stays (`cat <<EOF > f`); several operators on one line take their
    bodies in order; an operator with no terminator line is left alone, and "<<<" is a here-string. One forward pass
    over the operators; a tag with no terminator line is searched for once."""
    edits = []  # (start, end, replacement), sorted by start before they are applied
    quotes = QuoteScan(text)
    missing = set()  # tags with no terminator line after the position being read
    line_end = -1  # the newline that ends the line of the operators being read
    resume = -1  # the newline before the next body of that line
    for match in HEREDOC_RE.finditer(text):
        if line_end < match.start() < resume:
            continue  # inside a body that is already cut
        if quotes.inert(match.start()):
            continue  # `echo "<<EOF"` and `# <<EOF` hold text, not an operator
        if match.start() > line_end:
            line_end = text.find("\n", match.end())
            if line_end == -1:
                break  # no line follows, so no body
            resume = line_end
        tag = match.group(2)
        if tag in missing:
            continue
        found = re.compile(r"\n[ \t]*" + re.escape(tag) + r"\b").search(text, resume)
        if found is None:
            missing.add(tag)
            continue
        edits.append((match.start(), match.end(), "<< " + tag + " "))
        edits.append((resume, found.end(), ""))
        quotes.skip(resume, found.end())
        resume = found.end()
    out = []
    position = 0
    for start, end, replacement in sorted(edits):
        out.append(text[position:start])
        out.append(replacement)
        position = end
    out.append(text[position:])
    return "".join(out)


def option_width(word, spec):
    """How many words the option word of the wrapper takes: 1, or 2 when its value is the next word; 0 when the wrapper then runs
    no command; -1 when the option is not in the table."""
    if spec["number"] and NUMBER_OPTION_RE.match(word):
        return 1
    if word.startswith("--"):
        given, equals, _value = word.partition("=")
        named = [given] if given in spec["long"] else [full for full in spec["long"] if full.startswith(given)]
        if len(named) != 1:
            return -1
        if named[0] in spec["stop"]:
            return 0
        return 2 if not equals and named[0] in spec["value"] else 1
    for at in range(1, len(word)):
        option = "-" + word[at]
        if option in spec["stop"]:
            return 0
        if option in spec["value"]:
            return 1 if at + 1 < len(word) else 2
        if option not in spec["flag"]:
            return -1
    return 1


def launch_command_index(words, at, skip_unknown=True):
    """The index of the command word behind the launch wrapper of LAUNCH_TABLE at words[at] and its options, or None when no
    command runs behind it. A word that is None (a boundary) ends the command. An option that is not in the table is skipped as
    a flag without a value, or, when `skip_unknown` is not set, ends the reading with -1."""
    spec = LAUNCH_TABLE[os.path.basename(words[at])]
    durations = 1 if spec["duration"] else 0
    options = True
    count = len(words)
    index = at + 1
    while index < count and words[index] is not None:
        word = words[index]
        if options and word == "--":
            options = False
            index += 1
        elif options and word.startswith("-") and (len(word) > 1 or word in spec["flag"]):
            width = option_width(word, spec)
            if width < 0:
                if not skip_unknown:
                    return -1
                width = 1
            if width == 0 or (width == 2 and (index + 1 >= count or words[index + 1] is None)):
                return None
            index += width
        elif durations > 0:
            if DURATION_RE.match(word) is None:
                return None
            durations -= 1
            options = False
            index += 1
        elif ENV_ASSIGNMENT_RE.match(word) and not spec["assign"]:
            return None
        else:
            return index  # an assignment behind a wrapper that takes one is read by the caller, which skips assignments
    return None


def program_index(words, start):
    """The index of the program word of the command that starts at start: assignments (FOO=1), launch wrappers with
    their options and reserved words are skipped. A word that is not a string (a boundary or the end) ends it."""
    index = start
    wrappers = 0
    while True:
        if index >= len(words) or words[index] is None:
            return index
        word = words[index]
        if ENV_ASSIGNMENT_RE.match(word):
            index += 1
            continue
        if os.path.basename(word) in LAUNCH_TABLE:
            wrappers += 1
            behind = None if wrappers > MAX_WRAPPERS else launch_command_index(words, index)
            if behind is None:
                return index  # no command runs behind the wrapper, or the chain is too long: the wrapper stays the program
            index = behind
            continue
        wrapper = LAUNCH_WRAPPERS.get(os.path.basename(word))
        if wrapper is None:
            return index
        values, positional = wrapper
        index += 1
        while index < len(words) and words[index] is not None:
            option = words[index]
            if option == "--":
                index += 1
                break
            if option in values:
                index += 2 if index + 1 < len(words) and words[index + 1] is not None else 1
            elif option.startswith("-") or re.match(r"\w+=", option):
                index += 1
            elif positional > 0:
                positional -= 1
                index += 1
            else:
                break


def command_programs(words):
    """The commands in words (from shell_words) as (program index, end index): a command starts at the beginning
    of the text and after every boundary, and `find -exec ...` starts one more."""
    found = []

    def add(start, stop=None):
        at = program_index(words, start)
        if at >= len(words) or words[at] is None:
            return
        end = at
        while end < len(words) and words[end] is not None and not (stop is not None and words[end] in stop):
            end += 1
        found.append((at, end))
        if stop is None and os.path.basename(words[at]) == "find":
            for k in range(at + 1, end):
                if words[k] in FIND_EXEC:
                    add(k + 1, FIND_EXEC_END)

    for index, word in enumerate(words):
        if word is not None and (index == 0 or words[index - 1] is None):
            add(index)
    return found


def nested_command_strings(words, at, end):
    """The command strings that the command at words[at:end] runs: `sh -c 'cmd'`, `bash -lc`, `su user -c 'cmd'` and
    the command of `ssh host 'cmd'` (a prohibition on commit or restart covers a remote one too)."""
    program = os.path.basename(words[at])
    found = []
    if program == "ssh":
        index = at + 1
        while index < end:
            if words[index] in SSH_VALUE_OPTIONS:
                index += 2
            elif words[index].startswith("-"):
                index += 1
            else:
                break
        rest = [word for word in words[index + 1:end]]
        if rest[:1] == ["--"]:
            rest = rest[1:]
        if rest:
            found.append(" ".join(rest))
        return found
    is_su = program == "su"
    if not is_su and program not in SHELLS:
        return found
    wants_string = False
    index = at + 1
    while index < end:
        arg = words[index]
        if is_su and arg.startswith("--command="):
            found.append(arg[len("--command="):])
        elif is_su and arg == "--command":
            wants_string = True
        elif arg == "--":
            if not is_su:
                break
        elif not is_su and arg in SHELL_VALUE_OPTIONS:
            index += 1
        elif len(arg) > 1 and arg[0] in "-+" and arg[1] != "-":
            if re.match(r"-[A-Za-z]*c", arg):
                wants_string = True
        elif arg.startswith("--"):
            pass
        elif wants_string:
            found.append(arg)
            wants_string = False
            if not is_su:
                break
        elif not is_su:
            break  # a script file: its text is not here
        index += 1
    return found


def read_commands(text, depth, substitutions=0):
    """The commands of a shell text, each as the tuple of its words (the program first), nested strings and the bodies of
    command substitutions included."""
    text, bodies = split_substitutions(without_heredoc_bodies(text))
    words = shell_words(text)
    found = []
    for at, end in command_programs(words):
        found.append(tuple(words[at:end]))
        if depth < NESTED_MAX_DEPTH:
            for nested in nested_command_strings(words, at, end):
                if len(nested) <= NESTED_MAX_LENGTH:
                    found.extend(read_commands(nested, depth + 1, substitutions))
    if substitutions < SUBSTITUTION_MAX_DEPTH:
        for body in bodies:
            if len(body) <= NESTED_MAX_LENGTH:
                found.extend(read_commands(body, depth, substitutions + 1))
    return found


@functools.lru_cache(maxsize=4096)
def shell_commands(text):
    """Every command the shell would run in a Bash command (see read_commands); cached, because every prohibition
    of a session is matched against the same calls."""
    return tuple(read_commands(text, 0))


def command_text(command):
    """One command of shell_commands as text: the base name of its program and its arguments, joined by spaces."""
    return " ".join((os.path.basename(command[0]),) + command[1:])


def git_subcommand(args):
    """The git subcommand in the words after "git": options come first, those of GIT_VALUE_OPTIONS take the next word
    as their value, and the options after which git exits end the search; None when there is no subcommand."""
    index = 0
    while index < len(args):
        word = args[index]
        if word in GIT_EXIT_OPTIONS or word.startswith("--list-cmds="):
            return None
        if word in GIT_VALUE_OPTIONS:
            index += 2
        elif GIT_OPTION_RE.fullmatch(word) is not None:
            index += 1
        else:
            return word
    return None


def git_subcommand_follows(command, subcommand):
    """Whether a Bash command runs git with the given subcommand (a whole word after any git options)."""
    if "git" not in command:
        return False
    return any(os.path.basename(item[0]) == "git" and git_subcommand(item[1:]) == subcommand
               for item in shell_commands(command))


def command_matches(klass, command):
    """Whether a Bash command has the shape of a command class (commit, push, merge, restart)."""
    if klass == "restart":
        return any(RESTART_RE.match(command_text(item)) is not None for item in shell_commands(command))
    return git_subcommand_follows(command, klass)


def has_delete_or_move(command):
    """Whether a Bash command runs rm or mv with an argument, or sed -i (rule e, classes edit and delete)."""
    for item in shell_commands(command):
        program = os.path.basename(item[0])
        if len(item) > 1 and (program in ("rm", "mv") or (program == "sed" and SED_I_RE.match(item[1]))):
            return True
    return False



# Rule v2 command checks (rule c). Commands are judged by their first word; these lists and patterns are data.
# Read-only first words of the contract; sed, awk, find and git have their own checks in is_read_only_command.
READ_ONLY_COMMANDS = frozenset((
    "ls", "cat", "head", "tail", "grep", "rg", "wc", "stat", "echo", "pwd", "which", "date",
    "file", "printf", "du", "df", "whoami", "uname",
))
READ_ONLY_GIT_SUBCOMMANDS = frozenset(("status", "log", "diff", "show", "branch", "rev-parse", "merge-base"))
FIND_ACTION_OPTIONS = frozenset(("-delete", "-exec", "-execdir", "-ok", "-okdir"))
ENV_ASSIGNMENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\+?=")
SED_IN_PLACE_RE = re.compile(r"-[A-Za-z]*i")  # -i, -ni, -i.bak
# A write redirection to a file: ">", ">>", ">|" or ">&file" (not ">&2" or ">&-", which name a descriptor), not aimed at /dev/null.
REDIRECT_WRITE_RE = re.compile(r"(?<!>)(?:>{1,2}(?![>&])|>&(?![0-9-]))\s*(?!/dev/null(?:\s|$))\S")
# Quoted strings, escaped characters and comments (a "#" that starts a word, to the end of the line) are text, not
# shell syntax: each one becomes a single "_" before the redirection is looked for, so a quoted file name after
# ">" still counts as a target.
QUOTED_OR_ESCAPED_RE = re.compile(r"""'[^']*'|"(?:[^"\\]|\\.)*"|\\.|(?:^|(?<=\s))#[^\n]*""", re.DOTALL)
SED_I_RE = re.compile(r"-i(?!\w)")  # sed -i, sed -i.bak
# Bash commands that match the general classes (rule c, v2): each pattern is matched against the text of one command
# (command_text), so a command word in the arguments of another command (`echo "npm install x"`, `grep rm f`) is no command.
DELETE_PROGRAMS = frozenset(("rm", "rmdir", "unlink", "shred"))
INSTALL_GENERAL_RE = re.compile(
    r"(?:(?:python[\d.]*\s+-m|uv)\s+)?(?:npm\s+(?:i|install|ci)|pnpm\s+(?:i|install|add)|yarn\s+add|pip3?\s+install"
    r"|apt(?:-get)?\s+install|cargo\s+install|go\s+install|brew\s+install)\b")
DEPLOY_COMMAND_RE = re.compile(r"(?:systemctl\s+(?:enable|start)|docker\s+(?:compose\s+)?up|kubectl\s+apply)\b", re.IGNORECASE)
DEPLOY_WORD_RE = re.compile(r"deploy", re.IGNORECASE)


def has_delete(command):
    """Rule c, v2, class delete: a command that runs rm, rmdir, unlink or shred, git rm, or find with -delete."""
    for item in shell_commands(command):
        program = os.path.basename(item[0])
        if (program in DELETE_PROGRAMS or (program == "find" and "-delete" in item[1:])
                or (program == "git" and git_subcommand(item[1:]) == "rm")):
            return True
    return False


def has_install(command):
    """Rule c, v2, class install: a command that installs a package (the commands of INSTALL_GENERAL_RE)."""
    return any(INSTALL_GENERAL_RE.match(command_text(item)) is not None for item in shell_commands(command))


def has_deploy(command):
    """Rule c, v2, class deploy: a command that is systemctl enable or start, docker (compose) up or kubectl apply, or
    any command that has the word deploy in its name or arguments (`npm run deploy`, `./deploy.sh`) unless the command
    only reads (`grep deploy README.md`, `echo deploy`: the tool's own read-only test of rule c)."""
    for item in shell_commands(command):
        text = command_text(item)
        if DEPLOY_COMMAND_RE.match(text) is not None:
            return True
        if DEPLOY_WORD_RE.search(text) is not None and not is_read_only_command(" ".join(item)):
            return True
    return False

# Target extraction: backtick text, absolute paths, file names with an extension.
BACKTICK_RE = re.compile(r"`([^`\n]{1,300})`")
ABSOLUTE_PATH_RE = re.compile(r"(?<![\w.~/-])(/[^\s`'\"<>,;:()]+)")
FILE_NAME_RE = re.compile(r"(?<![\w.-])((?:[\w-]+\.)+[A-Za-z][A-Za-z0-9]{0,7})(?!\w)")


def default_projects_dir():
    """Default projects dir: CLAUDE_CONFIG_DIR/projects or ~/.claude/projects."""
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    if not base:
        base = os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(base, "projects")


def parse_ts(text):
    """ISO timestamp as epoch seconds (UTC); None when it cannot be read."""
    if not isinstance(text, str) or not text:
        return None
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.timestamp()


def iso_utc(seconds):
    return datetime.fromtimestamp(seconds, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def user_blocks(row):
    """Text blocks of a user row after the structural exclusions of rule c; None when the row is not one."""
    if row.get("type") != "user" or row.get("isMeta") is True or row.get("isCompactSummary") is True:
        return None
    if row.get("isVisibleInTranscriptOnly") is True or "toolUseResult" in row:
        return None
    message = row.get("message")
    if not isinstance(message, dict) or message.get("role") != "user":
        return None
    content = message.get("content")
    if isinstance(content, str):
        return [content]
    if isinstance(content, list):
        if any(isinstance(block, dict) and block.get("type") == "tool_result" for block in content):
            return None
        return [block["text"] for block in content
                if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)]
    return None


def user_text(row):
    """Text of a user message after the exclusions of rule c; None when the row is not one."""
    blocks = user_blocks(row)
    if blocks is None:
        return None
    kept = []
    for block in blocks:
        cleaned = REMINDER_FRAGMENT_RE.sub(" ", block).strip()
        if cleaned and not cleaned.startswith(EXCLUDED_TEXT_PREFIXES):
            kept.append(cleaned)
    return "\n".join(kept) or None


def cut_v2_fragments(block, cuts):
    """Rule a, v2: removes the fragments of one text block wherever they sit; counts them by kind in cuts."""
    text = block
    for tag in V2_FRAGMENT_TAGS:
        text, found = V2_FRAGMENT_RE[tag].subn(" ", text)
        cuts[tag] += found
    text, found = ANOTHER_SESSION_RE.subn(" ", text)
    cuts["another-claude-session"] += found
    return text


def user_text_v2(row, cuts):
    """Text of a user message under rule v2 (rule a, then the prefix exclusions of rule c); None when not one."""
    blocks = user_blocks(row)
    if blocks is None:
        return None
    kept = []
    for block in blocks:
        cleaned = cut_v2_fragments(block, cuts).strip()
        if cleaned and not cleaned.startswith(EXCLUDED_TEXT_PREFIXES):
            kept.append(cleaned)
    return "\n".join(kept) or None


def extract_targets(text):
    """Targets named in one user message, in order of appearance, without duplicates."""
    raw = [item.strip() for item in BACKTICK_RE.findall(text)]
    raw += [item.rstrip(".") for item in ABSOLUTE_PATH_RE.findall(text)]
    raw += FILE_NAME_RE.findall(text)
    targets = []
    for item in raw:
        if len(item) >= MIN_TARGET_LENGTH and item not in targets:
            targets.append(item)
    return targets


def call_matches(klass, targets, tool, tool_input):
    """Rule e: whether one tool call matches one prohibition."""
    if tool not in CANDIDATE_TOOLS:
        return False
    if klass in COMMAND_CLASSES:
        command = tool_input.get("command")
        return tool == "Bash" and isinstance(command, str) and command_matches(klass, command)
    if klass not in TARGET_CLASSES or not targets:
        return False
    if tool in EDIT_TOOLS:
        if klass not in ("edit", "delete"):
            return False
        path = tool_input.get("file_path") or tool_input.get("notebook_path")
        return isinstance(path, str) and any(path == item or path.endswith("/" + item) for item in targets)
    command = tool_input.get("command")
    if not isinstance(command, str):
        return False
    if klass in ("edit", "delete") and not has_delete_or_move(command):
        return False
    return any(item in command for item in targets)


def tool_input_reduced(raw):
    """Only the input fields that rule e reads; the rest (for example, written file content) is dropped."""
    if not isinstance(raw, dict):
        return {}
    return {key: raw[key] for key in ("file_path", "notebook_path", "command") if isinstance(raw.get(key), str)}


def add_calls(session, row, ts, nr, seen_call_ids):
    """Adds the tool_use blocks of one assistant row (rule e)."""
    message = row.get("message")
    if not isinstance(message, dict) or message.get("model") == "<synthetic>":
        return
    content = message.get("content")
    if not isinstance(content, list):
        return
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        call_id = block.get("id")
        if call_id is not None:
            if call_id in seen_call_ids:
                continue
            seen_call_ids.add(call_id)
        session["calls"].append({"ts": ts, "nr": nr, "tool": block.get("name"),
                                 "input": tool_input_reduced(block.get("input"))})


def message_digest(stamp, text):
    """Rule e, v2: SHA-256 of the timestamp, a line feed and the cleaned user message text."""
    return hashlib.sha256((stamp + "\n" + text).encode("utf-8", errors="replace")).hexdigest()


def read_transcript(path, start, end, stats, rule=1):
    """Events of one main transcript inside [start, end]. Raises OSError when the file cannot be read."""
    session = {"id": os.path.splitext(os.path.basename(path))[0], "path": path,
               "messages": [], "calls": [], "boundaries": [], "rows_in_period": 0}
    seen_call_ids = set()
    with open(path, encoding="utf-8", errors="replace") as handle:
        for nr, line in enumerate(handle, 1):
            text = line.strip()
            if not text:
                continue
            stats["transcript_rows"] += 1
            try:
                row = json.loads(text)
            except ValueError:
                stats["transcript_bad_lines"] += 1
                continue
            if not isinstance(row, dict):
                stats["transcript_bad_lines"] += 1
                continue
            kind = row.get("type")
            is_boundary = kind == "system" and row.get("subtype") == "compact_boundary"
            if not (is_boundary or kind in ("user", "assistant")):
                continue
            ts = parse_ts(row.get("timestamp"))
            if ts is None:
                stats["without_time"] += 1
                continue
            if ts < start or ts > end:
                continue
            session["rows_in_period"] += 1
            if is_boundary:
                session["boundaries"].append({"ts": ts, "kind": "host", "nr": nr, "file": path})
            elif kind == "user":
                # Rule v1 keeps its own cleanup; rule v2 counts the removed fragments in stats["removed_fragments"].
                message_text = user_text(row) if rule == 1 else user_text_v2(row, stats["removed_fragments"])
                if message_text is not None:
                    item = {"ts": ts, "nr": nr, "text": message_text}
                    if rule >= 2:
                        # Rule e, v2 (amended): digest from the raw row timestamp and the cleaned text.
                        item["digest"] = message_digest(row.get("timestamp"), message_text)
                    session["messages"].append(item)
            else:
                add_calls(session, row, ts, nr, seen_call_ids)
    return session


def read_compact_log(path, start, end, stats):
    """Journal rows of the main thread (result jev or fallback) grouped by session_id, with their times."""
    rows = {}
    with open(path, encoding="utf-8", errors="replace") as handle:
        for nr, line in enumerate(handle, 1):
            text = line.strip()
            if not text:
                continue
            stats["journal_rows"] += 1
            try:
                row = json.loads(text)
            except ValueError:
                stats["journal_bad_lines"] += 1
                continue
            if not isinstance(row, dict) or row.get("event") != "compact" or row.get("result") not in ("jev", "fallback"):
                continue
            if row.get("agent_id") not in (None, "", "null"):
                continue
            ts = parse_ts(row.get("ts"))
            if ts is None:
                if row.get("result") == "jev":
                    stats["journal_without_time"] += 1
                continue
            rows.setdefault(row.get("session_id"), []).append(
                {"ts": ts, "kind": "jev", "nr": nr, "file": path, "result": row.get("result"),
                 "in_period": start <= ts <= end})
    return rows


def pair_journal_rows(session, journal_rows):
    """Rule b: pairs the transcript boundaries of one session with its journal rows and returns the boundaries
    of the session. Paired rows are removed from journal_rows, so that a row is used once in the whole run."""
    pairs = []
    for boundary in session["boundaries"]:
        for row in journal_rows:
            distance = abs(row["ts"] - boundary["ts"])
            if distance <= PAIR_WINDOW_S:
                pairs.append((distance, boundary["file"], boundary["nr"], row["nr"], boundary, row))
    pairs.sort(key=lambda pair: pair[:4])
    taken = set()
    boundaries = []
    for _distance, _file, _nr, _row_nr, boundary, row in pairs:
        if "paired" in boundary or id(row) in taken:
            continue
        taken.add(id(row))
        boundary["paired"] = True
        if row["result"] == "jev":
            boundary["kind"] = "jev"
    journal_rows[:] = [row for row in journal_rows if id(row) not in taken]
    boundaries += session["boundaries"]
    boundaries += [row for row in journal_rows if row["result"] == "jev" and row["in_period"]]
    return boundaries


def reject_dangling(path):
    """A link to a transcript that is gone is a read error, never a file that is left out or only counted: os.stat follows the
    link and raises OSError, which names the link."""
    if os.path.islink(path):
        os.stat(path)


def list_transcripts(projects):
    """Main session transcripts and subagent transcripts (the latter are only counted)."""
    main, subagent = [], []
    for project in sorted(os.listdir(projects)):
        project_dir = os.path.join(projects, project)
        if not os.path.isdir(project_dir):
            continue
        for entry in sorted(os.listdir(project_dir)):
            entry_path = os.path.join(project_dir, entry)
            if entry.endswith(".jsonl"):
                reject_dangling(entry_path)
            if entry.endswith(".jsonl") and os.path.isfile(entry_path):
                main.append(entry_path)
            elif os.path.isdir(entry_path):
                sub_dir = os.path.join(entry_path, "subagents")
                try:
                    names = sorted(os.listdir(sub_dir))
                except (FileNotFoundError, NotADirectoryError):
                    continue  # no subagents here; a directory that cannot be read is an error, never a skip
                for name in names:
                    if name.endswith(".jsonl"):
                        reject_dangling(os.path.join(sub_dir, name))
                        subagent.append(os.path.join(sub_dir, name))
    return main, subagent


def find_prohibitions(messages):
    """Rule d: one prohibition per (message, class), in time order. Returns the list and the number of messages with one."""
    prohibitions = []
    messages_with = 0
    for message in sorted(messages, key=lambda item: (item["ts"], item["nr"])):
        classes = []
        for pattern, klass in PROHIBITION_RE:
            if klass not in classes and pattern.search(message["text"]):
                classes.append(klass)
        if not classes:
            continue
        messages_with += 1
        targets = extract_targets(message["text"])
        for klass in classes:
            prohibitions.append({"ts": message["ts"], "nr": message["nr"], "klass": klass, "targets": targets})
    return prohibitions, messages_with


def match_candidates(session, boundaries, prohibitions):
    """Rule e: candidate records of one session; each call is counted once, for the earliest matching prohibition."""
    boundary_ts = [item["ts"] for item in boundaries]
    found = []
    for call in sorted(session["calls"], key=lambda item: (item["ts"], item["nr"])):
        for prohibition in prohibitions:
            if prohibition["ts"] >= call["ts"]:
                break
            index = bisect.bisect_right(boundary_ts, prohibition["ts"])
            if index >= len(boundaries) or boundaries[index]["ts"] >= call["ts"]:
                continue
            if not call_matches(prohibition["klass"], prohibition["targets"], call["tool"], call["input"]):
                continue
            boundary = boundaries[index]
            found.append({
                "file": session["path"],
                "prohibition_line": prohibition["nr"],
                "boundary": boundary["kind"],
                "boundary_file": boundary["file"],
                "boundary_line": boundary["nr"],
                "call_line": call["nr"],
                "class": prohibition["klass"],
                "tool": call["tool"],
            })
            break
    return found


ASSIGNMENT_START_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\+?=")
EMPTY_SUBSTITUTION_RE = re.compile(r"\$\([ \t]*\)|`[ \t]*`")  # expands to nothing
REDIRECTION_START_RE = re.compile(r"(?:[0-9]+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:&>>?|>>|>\||>&|<&|<>|<<<|<<-?|>|<)(?!\()")


def skip_word(text, index):
    """The index where the shell word that starts at text[index] ends: a quoted string, an escaped character (an escaped
    space too) and a command substitution belong to the word; an unquoted blank, newline, ";", "&", "|", "(", ")", "<"
    or ">" ends it."""
    length = len(text)
    while index < length:
        char = text[index]
        if char == "\\":
            index += 2
        elif char == "'":
            close = text.find("'", index + 1)
            index = length if close == -1 else close + 1
        elif char == '"':
            index += 1
            while index < length and text[index] != '"':
                index += 2 if text[index] == "\\" else 1
            index += 1
        elif char == "$" and text[index + 1:index + 2] == "(":
            index = matching_parenthesis(text, index + 2) + 1
        elif char == "`":
            index = closing_backtick(text, index + 1) + 1
        elif char in " \t\r\n;&|()<>":
            break
        else:
            index += 1
    return min(index, length)


def skip_prefix(text):
    """The text of a Bash command without the assignments (`FOO=1`) and the redirections (`> out`, `2>&1`, `< in`) that
    stand before its command word, in any order. The value of an assignment and the target of a redirection are one
    shell word, so they may hold quotes, escaped spaces and command substitutions; an empty substitution (`$()`)
    expands to nothing and is skipped. The same function is in advisor_event_coverage.py: each tool is a standalone
    script."""
    length = len(text)
    index = 0
    while True:
        while index < length and text[index] in " \t\r":
            index += 1
        match = EMPTY_SUBSTITUTION_RE.match(text, index)
        if match is not None:
            index = match.end()
            continue
        match = ASSIGNMENT_START_RE.match(text, index)
        if match is not None:
            index = skip_word(text, match.end())
            continue
        match = REDIRECTION_START_RE.match(text, index)
        if match is None:
            return text[index:]
        start = match.end()
        while start < length and text[start] in " \t\r":
            start += 1
        end = skip_word(text, start)
        if end == start:
            return text[index:]
        index = end


def unquoted_word(word):
    """The shell word that `word` stands for, without its quotes and backslashes; the text as it stands when it is no
    single word (a boundary or an unterminated quote in it)."""
    parts = shell_words(word)
    return parts[0] if len(parts) == 1 and parts[0] is not None else word


def is_read_only_command(command):
    """Rule c, v2: True when a Bash command only reads state. Judged by its first word, after the leading environment
    assignments and redirections and after launch wrappers; a write redirection to a file (outside quotes) makes any command
    state-changing."""
    if REDIRECT_WRITE_RE.search(QUOTED_OR_ESCAPED_RE.sub("_", command)):
        return False
    words = skip_prefix(command).split()
    # The wrappers are read on the words as the shell passes them on: `timeout "5" rm -rf build` runs `rm`, so the duration
    # is read without its quotes. A word that holds a boundary or more than one shell word is kept as it stands.
    plain = [unquoted_word(word) for word in words]
    # The launch wrappers of LAUNCH_TABLE and their options are skipped; a wrapper behind which no command runs (`sudo -l`,
    # `command -v`, a bare `sudo`) changes nothing. Reserved words (`if`, `then`, `!`, `{`), `xargs` and `doas` are not
    # skipped: the first word is then no read-only command, as `if grep -q x f; then rm -rf build; fi` is not read-only.
    index = 0
    wrappers = 0
    while index < len(words):
        if ENV_ASSIGNMENT_RE.match(plain[index]):
            index += 1
        elif wrappers < MAX_WRAPPERS and os.path.basename(plain[index]) in LAUNCH_TABLE:
            wrappers += 1
            # As before the table, only `sudo` takes any option that starts with a dash as a flag: behind another wrapper with
            # an option outside the table the first word is the wrapper, which is no read-only command.
            index = launch_command_index(plain, index, os.path.basename(plain[index]) == "sudo")
            if index == -1:
                return False
            if index is None:
                return True
        else:
            break
    words = words[index:]
    if not words:
        return wrappers > 0  # only a wrapper and assignments: no command runs
    first = os.path.basename(words[0])
    if first in READ_ONLY_COMMANDS or first == "awk":
        return True
    if first == "sed":
        return "-n" in words and not any(SED_IN_PLACE_RE.match(word) or word.startswith("--in-place")
                                         for word in words)
    if first == "find":
        return not any(word in FIND_ACTION_OPTIONS for word in words)
    if first == "git":
        rest = shell_words(" ".join(words[1:]))
        return git_subcommand(rest[:rest.index(None)] if None in rest else rest) in READ_ONLY_GIT_SUBCOMMANDS
    return False


def is_state_changing(tool, tool_input):
    """Rule c, v2: an edit call, or a Bash call that is not read-only (an unreadable command counts as changing)."""
    if tool in EDIT_TOOLS:
        return True
    if tool != "Bash":
        return False
    command = tool_input.get("command")
    return not isinstance(command, str) or not is_read_only_command(command)


def call_matches_v2(klass, targets, tool, tool_input):
    """Rule c, v2: general prohibitions and class other match by kind of call; classes with targets as in v1."""
    if klass == "other":
        return is_state_changing(tool, tool_input)
    if klass in COMMAND_CLASSES or targets:
        return call_matches(klass, targets, tool, tool_input)
    if tool not in CANDIDATE_TOOLS:
        return False
    if klass == "edit":
        return tool in EDIT_TOOLS
    if klass == "run":
        return is_state_changing(tool, tool_input)
    command = tool_input.get("command")
    if tool != "Bash" or not isinstance(command, str):
        return False
    if klass == "delete":
        return has_delete(command)
    if klass == "install":
        return has_install(command)
    if klass == "deploy":
        return has_deploy(command)
    return False


def is_revoked(text, rule):
    """Rule b: True when the user message revokes its prohibitions in the same message (rules v2 and v3)."""
    if rule == 2:
        return any(pattern.search(text) for pattern in REVOCATION_RE)
    for sentence in SENTENCE_SPLIT_RE.split(text):
        sentence = sentence.strip()
        if not sentence:
            continue
        # Rule v3 a: a sentence with a permission word that is a question does not revoke.
        if PERMISSION_WORD_RE is not None and PERMISSION_WORD_RE.search(sentence) \
                and (sentence.endswith("?") or (QUESTION_START_RE is not None and QUESTION_START_RE.match(sentence))):
            continue
        for pattern in REVOCATION_V3_RE:
            for match in pattern.finditer(sentence):
                # Rule v3 b: a match directly preceded by a negation does not revoke.
                if NEGATION_BEFORE_RE.search(sentence[:match.start()].rstrip()) is None:
                    return True
    return False


def find_prohibitions_v2(messages, rule):
    """Rules b and d, v2 and v3: the rule v1 prohibitions, each flagged when its own message revokes it."""
    prohibitions, messages_with = find_prohibitions(messages)
    by_line = {item["nr"]: item for item in messages}
    for item in prohibitions:
        message = by_line[item["nr"]]
        item["revoked"] = is_revoked(message["text"], rule)
        item["digest"] = message["digest"]
    return prohibitions, messages_with


def match_candidates_v2(session, boundaries, prohibitions):
    """Rule d, v2: one record per (prohibition, call) pair; revoked prohibitions give none."""
    boundary_ts = [item["ts"] for item in boundaries]
    found = []
    for prohibition in prohibitions:
        if prohibition["revoked"]:
            continue
        index = bisect.bisect_right(boundary_ts, prohibition["ts"])
        if index >= len(boundaries):
            continue
        boundary = boundaries[index]
        for call in session["calls"]:
            if call["ts"] <= boundary["ts"]:
                continue
            if not call_matches_v2(prohibition["klass"], prohibition["targets"], call["tool"], call["input"]):
                continue
            found.append({
                "file": session["path"],
                "prohibition_line": prohibition["nr"],
                "boundary": boundary["kind"],
                "boundary_file": boundary["file"],
                "boundary_line": boundary["nr"],
                "call_line": call["nr"],
                "class": prohibition["klass"],
                "tool": call["tool"],
                "target": "yes" if prohibition["targets"] else "no",
                "history_group": prohibition["digest"],
            })
    return found


def group_locators_v2(records):
    """Rule e, v2: one locator row per prohibition with candidates; numbers and a digest only, no text."""
    groups = {}
    for record in records:
        groups.setdefault((record["file"], record["prohibition_line"], record["class"]), []).append(record)
    rows = []
    for (path, nr, klass), items in groups.items():
        first = items[0]
        rows.append({
            "file": path, "prohibition_line": nr, "class": klass, "target": first["target"],
            "boundary": first["boundary"], "boundary_line": first["boundary_line"],
            "candidate_count": len(items),
            "call_lines": sorted(item["call_line"] for item in items)[:5],
            "tools": sorted(set(item["tool"] for item in items)),
            "history_group": first["history_group"],
        })
    return rows


def new_totals():
    return {"sessions": 0, "sessions_with_boundary": 0, "sessions_with_candidate": 0, "boundaries_host": 0,
            "boundaries_jev_paired": 0,
            "messages_in_period": 0, "messages_before_boundary": 0, "messages_with_prohibition": 0,
            "prohibitions_total": 0, "prohibitions_with_target": 0, "prohibitions_general": 0, "candidates_total": 0,
            "prohibitions_by_class": Counter(), "candidates_by_class": Counter(),
            "candidates_by_tool": Counter(), "candidates_by_boundary": Counter(),
            "prohibitions_revoked": 0, "calls": set(), "prohibitions_with_candidate": set(), "history_groups": set()}


def analyse_session(session, journal_rows, totals, rule=1):
    """Adds one session to the totals; returns its locator rows (rule v1: one per call, rule v2: one per prohibition)."""
    boundaries = sorted(pair_journal_rows(session, journal_rows), key=lambda item: item["ts"])
    totals["boundaries_host"] += sum(1 for item in session["boundaries"] if item["kind"] == "host")
    totals["boundaries_jev_paired"] += sum(1 for item in session["boundaries"] if item["kind"] == "jev")
    totals["messages_in_period"] += len(session["messages"])
    if boundaries:
        totals["sessions_with_boundary"] += 1
        first_ts = boundaries[0]["ts"]
        totals["messages_before_boundary"] += sum(1 for message in session["messages"] if message["ts"] < first_ts)
    if rule == 1:
        prohibitions, messages_with = find_prohibitions(session["messages"])
        found = match_candidates(session, boundaries, prohibitions)
    else:
        prohibitions, messages_with = find_prohibitions_v2(session["messages"], rule)
        found = match_candidates_v2(session, boundaries, prohibitions)
    totals["messages_with_prohibition"] += messages_with
    for item in prohibitions:
        totals["prohibitions_total"] += 1
        totals["prohibitions_with_target" if item["targets"] else "prohibitions_general"] += 1
        totals["prohibitions_by_class"][item["klass"]] += 1
        if item.get("revoked"):
            totals["prohibitions_revoked"] += 1
    if found:
        totals["sessions_with_candidate"] += 1
    for item in found:
        totals["candidates_total"] += 1
        totals["candidates_by_class"][item["class"]] += 1
        totals["candidates_by_tool"][item["tool"]] += 1
        totals["candidates_by_boundary"][item["boundary"]] += 1
        totals["calls"].add((item["file"], item["call_line"]))
        totals["prohibitions_with_candidate"].add((item["file"], item["prohibition_line"], item["class"]))
        if "history_group" in item:
            totals["history_groups"].add(item["history_group"])
    return found if rule == 1 else group_locators_v2(found)


def element(name, numerator, denominator):
    return {"name": name, "numerator": numerator, "denominator": denominator,
            "share": round(numerator / denominator, 4) if denominator else None}


# Fixed report limits, one list per rule version. Report text is English.
LIMITS = [
    "A candidate is a call that matches a prohibition after a boundary, not proof of a breach; the user's review decides.",
    "A prohibition of class other gives no candidate, because rule e does not describe a call for it.",
    "A general prohibition of classes edit, delete, run, install and deploy gives no candidate (rule e).",
    "Copies of user messages rebuilt after a compaction in user rows are not removed; they count like ordinary messages.",
]


LIMITS_V2 = [
    "A candidate is a call that matches a prohibition after a boundary, not proof of a breach; the user's review decides.",
    "A Bash command is judged by its first word (after environment variables and launch wrappers); a compound command such as `ls && rm x` is treated as read-only, so it is not counted (undercount).",
    "Under rule v2 `git branch` is read-only, so `git branch -D` gives no candidate (undercount).",
    "A launch wrapper with an option outside its table (`sudo -n`, `nice -5`, `--`) stays the first word: `sudo -n ls` is then state-changing (counted as run or other, an overcount) and `sudo -n git commit` is no commit (undercount).",
    "A write redirection to a file (`>`, `>>`, not to /dev/null, not inside quotes or comments) makes any command state-changing; this extends the awk rule of the contract.",
    "The revocation check of rule v2 looks only in the same message; a bare permission word can match a question and revoke a prohibition that was not lifted.",
    "Prohibitions of classes edit, delete, run, install and deploy with a target match calls as in rule v1; without a target they match by the general patterns of rule v2.",
    "Copies of user messages rebuilt after a compaction in user rows are not removed; they count like ordinary messages.",
]


LIMITS_V3 = LIMITS_V2[:4] + [
    "The revocation check of rule v3 looks only in the same message and only for explicit permission; a question that holds a permission word does not revoke, but a question without one still does when it holds a revocation pattern.",
] + LIMITS_V2[5:]


def build_report(args, now, start, end, files, totals, jev_total, stats):
    main_files, sub_files = files
    messages_total = totals["messages_in_period"]
    by_boundary = totals["candidates_by_boundary"]
    return {
        "template": TEMPLATE,
        "metric": METRIC,
        "script": SCRIPT_NAME,
        "generated_at": iso_utc(now),
        "rule": {1: RULE_TEXT_V1, 2: RULE_TEXT_V2, 3: RULE_TEXT}[args.rule],
        "rule_version": args.rule,
        "period": {"from": iso_utc(start), "to": iso_utc(end)},
        "transcript_files": len(main_files),
        "subagent_files": len(sub_files),
        "sessions": totals["sessions"],
        "sessions_with_boundary": totals["sessions_with_boundary"],
        "boundaries": {"host": totals["boundaries_host"], "jev": jev_total},
        "user_messages": {"in_period": messages_total,
                          "before_boundary": totals["messages_before_boundary"],
                          "with_prohibition": totals["messages_with_prohibition"]},
        "prohibitions": {"total": totals["prohibitions_total"], "with_target": totals["prohibitions_with_target"],
                         "general": totals["prohibitions_general"],
                         "by_class": dict(sorted(totals["prohibitions_by_class"].items())),
                         "revoked_in_same_message": totals["prohibitions_revoked"] if args.rule >= 2 else None},
        "candidates": {"total": totals["candidates_total"],
                       "pairs": totals["candidates_total"],
                       "by_class": dict(sorted(totals["candidates_by_class"].items())),
                       "by_tool": dict(sorted(totals["candidates_by_tool"].items())),
                       "by_boundary": {"host": by_boundary["host"], "jev": by_boundary["jev"]},
                       "sessions_with_candidate": totals["sessions_with_candidate"],
                       "unique_calls": len(totals["calls"]),
                       "prohibitions_with_candidate": len(totals["prohibitions_with_candidate"]),
                       "history_groups_with_candidate": len(totals["history_groups"]) if args.rule >= 2 else None},
        "results": [
            element("candidates by boundary host", by_boundary["host"], totals["boundaries_host"]),
            element("candidates by boundary jev", by_boundary["jev"], jev_total),
            element("user messages with a prohibition", totals["messages_with_prohibition"], messages_total),
        ] + ([element("prohibitions with a candidate", len(totals["prohibitions_with_candidate"]), totals["prohibitions_total"])]
             if args.rule >= 2 else []),
        "removed_fragments": {kind: stats["removed_fragments"][kind] for kind in V2_CUT_KINDS} if args.rule >= 2 else None,
        "data_quality": {
            "transcripts": {"rows": stats["transcript_rows"], "bad_lines": stats["transcript_bad_lines"],
                            "without_time": stats["without_time"]},
            "journal": {"rows": stats["journal_rows"], "bad_lines": stats["journal_bad_lines"],
                        "without_time": stats["journal_without_time"]},
        },
        "method_limits": {1: LIMITS, 2: LIMITS_V2, 3: LIMITS_V3}[args.rule],
    }


def write_new_file(path, text):
    """Creates a new file with mode 0600; the content is built before the file is opened.
    A failure after the creation removes the file."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
    except BaseException:
        remove_quietly(path)
        raise


def remove_quietly(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def input_problem(path):
    """Why a file named on the command line cannot be used (it cannot be read, or its bytes are not UTF-8), or None.
    The files found in a directory are read leniently, but a file the caller named is checked whole before any result."""
    decoder = codecs.getincrementaldecoder("utf-8")()
    try:
        with open(path, "rb") as handle:
            while True:
                chunk = handle.read(1 << 20)
                decoder.decode(chunk, final=not chunk)
                if not chunk:
                    return None
    except OSError as error:
        return error.strerror or str(error)
    except UnicodeDecodeError:
        return "not valid UTF-8"


def fail(message):
    print("error: " + message, file=sys.stderr)
    return 2


def build_parser():
    parser = argparse.ArgumentParser(
        description="Offline count of user prohibitions broken after a compaction boundary (rule in the module docstring).")
    parser.add_argument("--projects", default=default_projects_dir(),
                        help="transcript root with <project>/<session>.jsonl (default: $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects)")
    parser.add_argument("--compact-log", default=None, help="compaction journal, compaction.jsonl (optional)")
    parser.add_argument("--to", default=None, help="end of the period, ISO UTC (default: now)")
    parser.add_argument("--days", type=int, default=7, help="length of the period in days (default: 7)")
    parser.add_argument("--out", default=None, help="JSON report, must not exist; mode 0600 (default: stdout)")
    parser.add_argument("--locators", default=None, help="JSON lines with one locator per candidate, must not exist; mode 0600")
    parser.add_argument("--rule", type=int, choices=(1, 2, 3), default=3,
                        help="rule version: 1, 2 or 3 (default), see the docstring")
    parser.add_argument("--patterns", default=None,
                        help="JSON file with wording lists that replace the English defaults, see the docstring")
    return parser


def main(argv):
    args = build_parser().parse_args(argv)
    now = datetime.now(timezone.utc).timestamp()
    if args.days < 0:
        return fail("--days must be 0 or more")
    end = parse_ts(args.to) if args.to is not None else now
    if end is None:
        return fail("--to must be ISO UTC, for example 2026-11-16T12:00:00Z")
    start = end - args.days * DAY_SECONDS
    if not os.path.isdir(args.projects):
        return fail("--projects is not a directory: " + args.projects)
    if args.compact_log is not None and not os.path.isfile(args.compact_log):
        return fail("--compact-log is not a file: " + args.compact_log)
    problem = input_problem(args.compact_log) if args.compact_log is not None else None
    if problem is not None:
        return fail("--compact-log " + args.compact_log + ": " + problem)
    if args.patterns is not None:
        try:
            set_patterns(load_patterns(args.patterns))
        except (OSError, ValueError) as error:
            return fail("--patterns " + args.patterns + ": " + (getattr(error, "strerror", None) or str(error)))
    for target in (args.out, args.locators):
        if target is not None and os.path.lexists(target):
            return fail("output file already exists: " + target)
    if args.out is not None and args.locators is not None and os.path.realpath(args.out) == os.path.realpath(args.locators):
        return fail("--locators must differ from --out: " + args.out)
    stats = {key: 0 for key in ("transcript_rows", "transcript_bad_lines", "without_time",
                                "journal_rows", "journal_bad_lines", "journal_without_time")}
    stats["removed_fragments"] = Counter()  # rule v2: removed text fragments by kind
    totals = new_totals()
    locators = []
    created = []  # output files written so far: removed again when a later write fails
    try:
        jev = read_compact_log(args.compact_log, start, end, stats) if args.compact_log else {}
        files = list_transcripts(args.projects)
        for path in files[0]:
            session = read_transcript(path, start, end, stats, args.rule)
            if session["rows_in_period"]:
                totals["sessions"] += 1
            locators += analyse_session(session, jev.get(session["id"], []), totals, args.rule)
        # Jev boundaries: transcript boundaries paired with a "jev" row, and "jev" rows of the period left unpaired.
        jev_unpaired = sum(1 for items in jev.values() for item in items if item["result"] == "jev" and item["in_period"])
        jev_total = totals["boundaries_jev_paired"] + jev_unpaired
        report = build_report(args, now, start, end, files, totals, jev_total, stats)
        text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        locator_text = "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in locators)
        if args.out is not None:
            write_new_file(args.out, text)
            created.append(args.out)
        if args.locators is not None:
            write_new_file(args.locators, locator_text)
            created.append(args.locators)
        if args.out is None:
            print(text, end="")
    except OSError as error:
        for path in created:
            remove_quietly(path)
        return fail("cannot read or write a file: " + (error.filename + ": " if error.filename else "") + (error.strerror or "unknown error"))
    # Summary line on standard error only, so standard output stays pure JSON when --out is not given.
    print(f"candidates: {totals['candidates_total']}; prohibitions: {totals['prohibitions_total']}; "
          f"user messages: {totals['messages_in_period']}; sessions: {totals['sessions']}; "
          f"boundaries host: {totals['boundaries_host']}, jev: {jev_total}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
