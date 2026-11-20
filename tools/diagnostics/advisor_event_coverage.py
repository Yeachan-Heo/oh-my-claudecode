#!/usr/bin/env python3
"""Offline coverage of advisor consultations by events, for the rule "call the advisor on events, not on a feeling
of uncertainty". The script reads session transcripts (JSONL) and writes counts only. Message text, commands and
file paths never reach the report or an error message. Tests use synthetic transcripts only.

It is a standalone diagnostic run by hand: it does not change OMC behaviour and is not shipped in the npm package
(tools/ is not in the "files" list of package.json).

a. Inputs. --projects DIR (required, no default) holds transcripts as DIR/<any depth>/<session>.jsonl. A file with
   a "subagents" directory on its path is a subagent transcript: it is counted and never read. --since and
   --until (ISO 8601; without an offset the time is UTC; the window is [since, until)) limit the events and
   consultations that are counted. --label (required) is written to the field "label" of the report.
   Input files are only read. The files written are --out and --sessions-out: each must not exist before the run
   and is created with mode 0600. Without --out the JSON goes to stdout. Transcript paths reach only the
   --sessions-out file (rule h), never the report.
b. Session class. The model of a session is its most frequent message.model in assistant rows (rows with model
   "<synthetic>" and empty models are ignored; a tie goes to the alphabetically first model). A model starting
   with "glm-" is class glm; a model containing "haiku" is class haiku; any other model, and a session without
   any model, is class claude. Results are kept apart for the three classes and for the total ("total").
   A session is counted when at least one of its rows lies in the window (all sessions when there is no window).
c. Consultation. A block tool_use or server_tool_use named "advisor" is a consultation, kind "advisor". A tool_use
   "Bash" whose command, after leading NAME=value environment assignments, has as its first word one of the
   --consult-command values (repeatable; none by default) is a consultation, kind "bash-<command>"; the match is
   on the whole first word, not on a prefix. A command with no word after the assignments is not a consultation.
   A block counts once (first occurrence of its id). Separately, the declaration lines: lines of assistant text
   that start with the --declaration-prefix (default "ADVISOR:", after leading whitespace) are counted beside the
   consultations; they are not consultations.
d. Events and positions. The position of a tool call is its number among the counted calls (tool_use and
   server_tool_use, deduplicated by id, rows "<synthetic>" skipped) in file order; the whole file is numbered,
   the window only filters what is counted. Events:
   - plan: a tool_use ExitPlanMode; a Write or Edit whose file_path contains "/plans/" or whose file name starts
     with "plan" or "brief" (case-insensitive); the first TodoWrite of the session.
   - failures: the second and each further consecutive tool_result with is_error true, in file order (a result
     without an error breaks the series). One event per series, at the position of the call that gave the
     second error of that series.
   - end: the last assistant text block of the session, and each assistant text block with a line starting
     with the --report-prefix (default "STATUS:", after leading whitespace). Its position is the number of the
     last counted call before the text (0 when there is none).
e. Coverage. The distance is a difference of positions, counted in calls. Looking back (plan, end): a
   consultation c is in range when previous < c <= position of the event, previous being the position of the
   previous event of the same class (0 at the start of the session); the distance is position - c for the
   nearest such c. Events of one class at the same position (two text blocks with no call between them) keep
   their file order and their number: the earlier one is the previous event of the later one, so a consultation
   is in range for the first of them only (amended after review: such events used to merge into one, so one
   consultation covered all of them). Looking forward (failures): a consultation c is in range when
   position < c < position of the next failures event (or the end of the session); the distance is c - position
   for the nearest such c. Every consultation of the session counts for coverage, whatever its time. An event
   is covered for window K when its distance is at most K; for K = None (no limit) when any consultation is in
   range. WINDOWS = [1, 2, 3, 5, 10, 20, None]. Distribution over covered events: min, median, p75, p90, max;
   percentiles by nearest rank (element number ceil(p * n / 100) of the sorted list). Per window: the count of
   covered events, the number of events n, the share and the one-sided lower Wilson bound for z = 1.645. With n
   below MIN_SUPPORT (30) the share and the bound read "too little data" and the counts stay. The windows are
   fixed and are not chosen from the results.
f. Output. --out (JSON, template "advisor-event-coverage/1") or stdout: the period, the number of main and
   subagent files, sessions by class, consultations by kind and class, declaration lines by class, events by event
   class and session class (n, period, distribution, coverage per window), and data_quality (valid rows, bad
   lines, rows without time, sessions without time). Exit codes: 0 a valid run; 2 a usage error, an invalid time,
   an unreadable input, or an output file that already exists.
g. Copies of one history (forked and resumed sessions) are counted once for the whole run. Keys: the id of a
   tool_use or server_tool_use block (a call is a consultation, a plan or failure event by its call id); for a
   text block the row uuid together with the SHA-256 of the text, or, when the row has no uuid, the SHA-256 of
   the row timestamp, a line feed and the text. Files are processed in the sorted order of their paths. The
   first file that holds a key owns it: its consultation or event counts, and later copies are skipped. The
   skipped items are counted in the field "duplicates" by kind (calls, texts, consultations by kind, events by
   class). Positions and distances are still numbered over the whole file, copies included, so a distance is
   measured in the file that holds the item. Items without any id (a call without id) are never skipped. A skipped call
   that is also a consultation is counted in both "calls" and "consultations".
h. --sessions-out FILE writes the list of main sessions that have, in the window and after rule g, at least one
   consultation of kind "advisor" or at least one declaration line. It is a second output file with the same
   rules as --out: it must not exist before the run, is created with mode 0600, must differ from --out (compared
   by real path), and the run exits 2 when it exists. The report itself is unchanged by the option. The file is a
   JSON list of objects (ASCII only: non-ASCII characters of a path are written as \\u escapes), sorted by session
   id and then by path, one per listed session, with the fields "session" (the file name without ".jsonl"),
   "model_class" (rule b), "transcript" (the absolute path of the main transcript, the only place where a
   transcript path is written), "fired" (consultations of kind "advisor" in the window, counted as in
   "consultations.advisor": owned items only, so the sum over the list equals the report total) and
   "advisor_rows" (declaration lines counted as in the report). Subagent files are never listed. No message
   text, command or file path from the rows is written.
   Writing: the parent directory of each output file must exist and be writable (checked before the input is
   read). The list is written before the report. A write error (any OSError or encoding error) exits 2 and
   removes the files created by that run, so no partial state stays and the run can be repeated.
"""
import argparse
import bisect
import hashlib
import json
import math
import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone

TEMPLATE = "advisor-event-coverage/1"
RULE_NAME = "advisor-event-coverage"
WINDOWS = [1, 2, 3, 5, 10, 20, None]
MIN_SUPPORT = 30
WILSON_Z = 1.645
SYNTHETIC_MODEL = "<synthetic>"
SUBAGENT_DIR = "subagents"
BASH_TOOL = "Bash"
CONSULT_TOOL = "advisor"
# Default line prefix written after a consultation (--declaration-prefix).
DEFAULT_DECLARATION_PREFIX = "ADVISOR:"
# Default line prefix of the first field of a final report (--report-prefix).
DEFAULT_REPORT_PREFIX = "STATUS:"
PLAN_EXIT_TOOL = "ExitPlanMode"
PLAN_WRITE_TOOLS = ("Write", "Edit")
PLAN_DIR_MARKER = "/plans/"
# File name prefixes of plan and brief files, matched case-insensitively (data).
PLAN_FILE_PREFIXES = ("plan", "brief")
TODO_TOOL = "TodoWrite"
ENV_ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=\S*\s+")
PLAN = "plan"
FAILURES = "failures"
END = "end"
EVENT_CLASSES = (PLAN, FAILURES, END)
CLASS_GLM = "glm"
CLASS_HAIKU = "haiku"
CLASS_CLAUDE = "claude"
CLASS_NAMES = (CLASS_GLM, CLASS_HAIKU, CLASS_CLAUDE)
TOTAL = "total"
GROUPS = CLASS_NAMES + (TOTAL,)
# Text written in the report when the sample is too small (data).
NOT_ENOUGH_DATA = "too little data"


class Window:
    """Half-open time window [since, until); inactive when both bounds are None."""

    def __init__(self, since, until):
        self.since = since
        self.until = until
        self.active = since is not None or until is not None

    def contains(self, moment):
        if not self.active:
            return True
        if moment is None:
            return False
        if self.since is not None and moment < self.since:
            return False
        if self.until is not None and moment >= self.until:
            return False
        return True


def parse_time(value):
    """Parse an ISO 8601 timestamp into an aware UTC datetime; None when it cannot be parsed."""
    if not isinstance(value, str) or value.strip() == "":
        return None
    text = value.strip()
    if text[-1] in "Zz":
        text = text[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def iso(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def session_class(models):
    """Class of a session from the Counter of its assistant models (most frequent; ties: alphabetically first)."""
    if not models:
        return CLASS_CLAUDE
    model = max(sorted(models), key=lambda name: models[name])
    if model.startswith("glm-"):
        return CLASS_GLM
    if "haiku" in model:
        return CLASS_HAIKU
    return CLASS_CLAUDE


def iter_rows(path, counters):
    """Yield the JSON objects of one JSONL file; bad lines are counted in counters, never shown."""
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            try:
                row = json.loads(text)
            except ValueError:
                counters["bad_lines"] += 1
                continue
            if not isinstance(row, dict):
                counters["bad_lines"] += 1
                continue
            yield row


def iter_transcripts(root):
    """Yield (path, is_subagent) for every .jsonl file below root, in sorted order."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        relative = os.path.relpath(dirpath, root)
        is_subagent = SUBAGENT_DIR in relative.split(os.sep)
        for name in sorted(filenames):
            if name.endswith(".jsonl"):
                yield os.path.join(dirpath, name), is_subagent


def scan_header(path, window, counters):
    """Pass 1 over a main transcript: row counts, timed rows, the session class, and whether a row is in the window."""
    models = Counter()
    rows = 0
    timed = 0
    in_window = False
    for row in iter_rows(path, counters):
        rows += 1
        counters["rows"] += 1
        moment = parse_time(row.get("timestamp"))
        if moment is None:
            counters["rows_without_time"] += 1
        else:
            timed += 1
            if window.contains(moment):
                in_window = True
        if row.get("type") == "assistant":
            message = row.get("message")
            if isinstance(message, dict):
                model = message.get("model")
                if isinstance(model, str) and model and model != SYNTHETIC_MODEL:
                    models[model] += 1
    return {"class": session_class(models), "rows": rows, "timed": timed, "in_window": in_window}


def strip_env_assignments(command):
    text = command.lstrip()
    match = ENV_ASSIGNMENT.match(text)
    while match:
        text = text[match.end():]
        match = ENV_ASSIGNMENT.match(text)
    return text


class Config:
    """Conventions of the transcripts being measured: consult commands and the two line prefixes."""

    def __init__(self, consult_commands, declaration_prefix, report_prefix):
        self.consult_commands = list(consult_commands)
        self.consult_kinds = ["advisor"] + ["bash-" + command for command in self.consult_commands]
        self.declaration_prefix = declaration_prefix
        self.report_prefix = report_prefix


def consult_kind(name, tool_input, config):
    if name == CONSULT_TOOL:
        return "advisor"
    if name == BASH_TOOL:
        command = tool_input.get("command")
        if isinstance(command, str):
            # The first word must equal a consult command, not just start with it.
            words = strip_env_assignments(command).split()
            if words and words[0] in config.consult_commands:
                return "bash-" + words[0]
    return None


def is_plan_file(path):
    if not isinstance(path, str) or path == "":
        return False
    if PLAN_DIR_MARKER in path.casefold():
        return True
    file_name = re.split(r"[\\/]", path)[-1].casefold()
    return file_name.startswith(PLAN_FILE_PREFIXES)


class Claims:
    """Owning file of every call id and text key of the run (copies of one history): the first file that holds a key."""

    def __init__(self):
        self.calls = {}
        self.texts = {}

    def claim(self, table, key, path):
        """True when path owns the key, that is when it is the first file in which the key was seen."""
        return table.setdefault(key, path) == path


class SessionScan:
    """Positions and events of one main session, collected in one pass over its rows. No text is kept."""

    def __init__(self):
        self.calls = {}       # tool call id -> position (first occurrence); copies included, so positions follow the file
        self.call_owned = {}  # tool call id -> True when this file owns the call
        self.position = 0     # number of counted calls so far
        self.consults = []    # (position, kind, in_window, moment, owned)
        self.events = []      # (event class, position, in_window, moment, owned)
        self.texts = []       # (position, has report line, declaration lines, in_window, moment, owned)
        self.failure_run = 0
        self.answered = set()
        self.todo_seen = False
        self.keys = set()
        self.duplicate_calls = 0  # calls in window that an earlier file owns
        self.duplicate_texts = 0  # text blocks in window that an earlier file owns


def register_call(scan, block, in_window, moment, claims, path, config):
    call_id = block.get("id")
    has_id = isinstance(call_id, str) and call_id != ""
    if has_id and call_id in scan.calls:
        return
    scan.position += 1
    position = scan.position
    owned = claims.claim(claims.calls, call_id, path) if has_id else True
    if has_id:
        scan.calls[call_id] = position
        scan.call_owned[call_id] = owned
    if not owned and in_window:
        scan.duplicate_calls += 1
    name = block.get("name")
    raw_input = block.get("input")
    tool_input = raw_input if isinstance(raw_input, dict) else {}
    kind = consult_kind(name, tool_input, config)
    if kind is not None:
        scan.consults.append((position, kind, in_window, moment, owned))
    if name == PLAN_EXIT_TOOL:
        scan.events.append((PLAN, position, in_window, moment, owned))
    elif name in PLAN_WRITE_TOOLS and is_plan_file(tool_input.get("file_path")):
        scan.events.append((PLAN, position, in_window, moment, owned))
    elif name == TODO_TOOL and not scan.todo_seen:
        scan.todo_seen = True
        scan.events.append((PLAN, position, in_window, moment, owned))


def text_key(row, text):
    """Key of a text block: row uuid with the text digest; without a uuid, digest of timestamp and text."""
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    uuid = row.get("uuid")
    if isinstance(uuid, str) and uuid != "":
        return ("uuid", uuid, digest)
    stamp = row.get("timestamp")
    stamp_text = stamp if isinstance(stamp, str) else ""
    return ("stamp", hashlib.sha256((stamp_text + "\n" + text).encode("utf-8")).hexdigest())


def register_text(scan, block, origin, in_window, moment, row, claims, path, config):
    text = block.get("text")
    if not isinstance(text, str) or text == "":
        return
    key = (origin, hashlib.sha256(text.encode("utf-8")).hexdigest())
    if key in scan.keys:
        return
    scan.keys.add(key)
    owned = claims.claim(claims.texts, text_key(row, text), path)
    if not owned and in_window:
        scan.duplicate_texts += 1
    lines = [line.lstrip() for line in text.splitlines()]
    declarations = sum(1 for line in lines if line.startswith(config.declaration_prefix))
    report_line = any(line.startswith(config.report_prefix) for line in lines)
    scan.texts.append((scan.position, report_line, declarations, in_window, moment, owned))


def scan_assistant(scan, row, index, in_window, moment, claims, path, config):
    message = row.get("message")
    if not isinstance(message, dict) or message.get("model") == SYNTHETIC_MODEL:
        return
    content = message.get("content")
    if not isinstance(content, list):
        return
    origin = str(message.get("id") or row.get("uuid") or ("row-%d" % index))
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") in ("tool_use", "server_tool_use"):
            register_call(scan, block, in_window, moment, claims, path, config)
        elif block.get("type") == "text":
            register_text(scan, block, origin, in_window, moment, row, claims, path, config)


def scan_user(scan, row, in_window, moment):
    message = row.get("message")
    if not isinstance(message, dict):
        return
    content = message.get("content")
    if not isinstance(content, list):
        return
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_result":
            continue
        use_id = block.get("tool_use_id")
        if not isinstance(use_id, str) or use_id not in scan.calls or use_id in scan.answered:
            continue
        scan.answered.add(use_id)
        if block.get("is_error") is True:
            scan.failure_run += 1
            if scan.failure_run == 2:
                scan.events.append((FAILURES, scan.calls[use_id], in_window, moment, scan.call_owned[use_id]))
        else:
            scan.failure_run = 0


def scan_session(path, window, totals, claims, config):
    """Pass 2 over a main transcript; returns the finished SessionScan."""
    scan = SessionScan()
    for index, row in enumerate(iter_rows(path, Counter())):
        moment = parse_time(row.get("timestamp"))
        in_window = window.contains(moment)
        if in_window and moment is not None:
            totals.note_moment(moment)
        kind = row.get("type")
        if kind == "assistant":
            scan_assistant(scan, row, index, in_window, moment, claims, path, config)
        elif kind == "user":
            scan_user(scan, row, in_window, moment)
    last = len(scan.texts) - 1
    for number, (position, report_line, _, in_window, moment, owned) in enumerate(scan.texts):
        if report_line or number == last:
            scan.events.append((END, position, in_window, moment, owned))
    return scan


def nearest_distance_back(position, rank, class_positions, consult_positions):
    """class_positions: the positions of all events of the class in order, one entry per event (events at one
    position repeat); rank: the place of this event in that list, so the previous event of the class is the entry
    before it, even when it has the same position."""
    lower = class_positions[rank - 1] if rank > 0 else 0
    found = bisect.bisect_right(consult_positions, position) - 1
    if found >= 0 and consult_positions[found] > lower:
        return position - consult_positions[found]
    return None


def nearest_distance_forward(position, rank, class_positions, consult_positions):
    upper = class_positions[rank + 1] if rank + 1 < len(class_positions) else None
    found = bisect.bisect_right(consult_positions, position)
    if found < len(consult_positions) and (upper is None or consult_positions[found] < upper):
        return consult_positions[found] - position
    return None


def event_distances(scan):
    """(event class, in_window, moment, distance or None, owned) for every event of the session.
    Distances use the whole file, copies included; only owned events are counted by the caller.
    Events of one class that share a position (two text blocks with no call between them) keep their order and
    their number: the second one has the first as its previous event, so a consultation covers only the first."""
    consult_positions = [item[0] for item in scan.consults]
    class_positions = {}
    for cls in EVENT_CLASSES:
        class_positions[cls] = sorted(position for event_cls, position, _, _, _ in scan.events if event_cls == cls)
    seen = Counter()
    result = []
    for cls, position, in_window, moment, owned in scan.events:
        rank = bisect.bisect_left(class_positions[cls], position) + seen[(cls, position)]
        seen[(cls, position)] += 1
        if cls == FAILURES:
            distance = nearest_distance_forward(position, rank, class_positions[cls], consult_positions)
        else:
            distance = nearest_distance_back(position, rank, class_positions[cls], consult_positions)
        result.append((cls, in_window, moment, distance, owned))
    return result


def wilson_lower(successes, n, z=WILSON_Z):
    """One-sided lower Wilson bound, the formula of wilsonLower in wilson_threshold.mjs; n must be positive."""
    p = successes / n
    z2 = z * z
    denominator = 1 + z2 / n
    centre = (p + z2 / (2 * n)) / denominator
    radius = z * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denominator
    return max(0.0, centre - radius)


def nearest_rank(sorted_values, percent):
    """Nearest-rank percentile of a sorted, non-empty list: element number ceil(percent * n / 100)."""
    rank = (percent * len(sorted_values) + 99) // 100
    return sorted_values[max(rank, 1) - 1]


def distribution(sorted_covered):
    if not sorted_covered:
        return None
    return {
        "min": sorted_covered[0],
        "median": nearest_rank(sorted_covered, 50),
        "p75": nearest_rank(sorted_covered, 75),
        "p90": nearest_rank(sorted_covered, 90),
        "max": sorted_covered[-1],
    }


def period(moments):
    known = [moment for moment in moments if moment is not None]
    if not known:
        return None
    return {"from": iso(min(known)), "to": iso(max(known))}


def window_key(window):
    return "K=unlimited" if window is None else "K=%d" % window


def coverage_cell(covered, n):
    if n < MIN_SUPPORT:
        return {"covered": covered, "n": n, "share": NOT_ENOUGH_DATA, "wilson_lower_bound": NOT_ENOUGH_DATA}
    return {"covered": covered, "n": n, "share": covered / n, "wilson_lower_bound": wilson_lower(covered, n)}


def group_report(entries):
    """entries: (distance or None, moment) for every event of one event class and session class."""
    distances = [distance for distance, _ in entries]
    covered = sorted(distance for distance in distances if distance is not None)
    n = len(entries)
    report = {
        "n": n,
        "period": period([moment for _, moment in entries]),
        "distance_distribution": distribution(covered),
        "coverage": {},
    }
    for window in WINDOWS:
        if window is None:
            covered_count = len(covered)
        else:
            covered_count = sum(1 for distance in covered if distance <= window)
        report["coverage"][window_key(window)] = coverage_cell(covered_count, n)
    return report


class Totals:
    """Counts and per-event lists for the whole run; holds numbers and moments only."""

    def __init__(self, config):
        self.files_main = 0
        self.files_subagent = 0
        self.sessions = Counter()
        self.consults = {kind: Counter() for kind in config.consult_kinds}
        self.declarations = Counter()
        self.events = {cls: {group: [] for group in GROUPS} for cls in EVENT_CLASSES}
        # Copies of one history that an earlier file owns, counted by kind (in window only).
        self.duplicates = {"calls": 0, "texts": 0, "consultations": Counter(), "events": Counter()}
        self.first = None
        self.last = None

    def note_moment(self, moment):
        if self.first is None or moment < self.first:
            self.first = moment
        if self.last is None or moment > self.last:
            self.last = moment

    def add_session(self, sess_cls, scan):
        self.sessions[sess_cls] += 1
        self.sessions[TOTAL] += 1
        for _, kind, in_window, _, owned in scan.consults:
            if not in_window:
                continue
            if owned:
                self.consults[kind][sess_cls] += 1
                self.consults[kind][TOTAL] += 1
            else:
                self.duplicates["consultations"][kind] += 1
        for _, _, declarations, in_window, _, owned in scan.texts:
            if in_window and owned and declarations:
                self.declarations[sess_cls] += declarations
                self.declarations[TOTAL] += declarations
        for cls, in_window, moment, distance, owned in event_distances(scan):
            if not in_window:
                continue
            if owned:
                self.events[cls][sess_cls].append((distance, moment))
                self.events[cls][TOTAL].append((distance, moment))
            else:
                self.duplicates["events"][cls] += 1
        self.duplicates["calls"] += scan.duplicate_calls
        self.duplicates["texts"] += scan.duplicate_texts


def session_entry(path, sess_cls, scan):
    """List entry of one main session (--sessions-out), or None when it has no consultation and no declaration line in the
    window. The filter is the one of Totals.add_session: in the window and owned by this file."""
    fired = sum(1 for _, kind, in_window, _, owned in scan.consults if kind == CONSULT_TOOL and in_window and owned)
    declarations = sum(count for _, _, count, in_window, _, owned in scan.texts if in_window and owned)
    if fired == 0 and declarations == 0:
        return None
    absolute = os.path.abspath(path)
    return {
        "session": os.path.basename(absolute)[: -len(".jsonl")],
        "model_class": sess_cls,
        "transcript": absolute,
        "fired": fired,
        "advisor_rows": declarations,
    }


def build_report(args, window):
    """Returns (report, sessions); sessions is the sorted list for --sessions-out."""
    counters = Counter()
    config = Config(list(dict.fromkeys(args.consult_command)), args.declaration_prefix, args.report_prefix)
    totals = Totals(config)
    claims = Claims()
    sessions = []
    # Files in sorted path order, so the first file of a copied history owns its events.
    for path, is_subagent in sorted(iter_transcripts(args.projects)):
        if is_subagent:
            totals.files_subagent += 1
            continue
        totals.files_main += 1
        header = scan_header(path, window, counters)
        if header["rows"] == 0:
            continue
        if header["timed"] == 0:
            counters["sessions_without_time"] += 1
        if window.active and not header["in_window"]:
            continue
        scan = scan_session(path, window, totals, claims, config)
        totals.add_session(header["class"], scan)
        entry = session_entry(path, header["class"], scan)
        if entry is not None:
            sessions.append(entry)
    report = {
        "template": TEMPLATE,
        "label": args.label,
        "rule": RULE_NAME,
        "period": {
            "since": iso(window.since) if window.since is not None else None,
            "until": iso(window.until) if window.until is not None else None,
            "rows_in_window": {
                "from": iso(totals.first) if totals.first is not None else None,
                "to": iso(totals.last) if totals.last is not None else None,
            },
        },
        "files": {"main": totals.files_main, "subagents": totals.files_subagent},
        "sessions": {group: totals.sessions[group] for group in GROUPS},
        "consultations": {
            kind: {group: totals.consults[kind][group] for group in GROUPS} for kind in config.consult_kinds
        },
        "declaration_lines": {group: totals.declarations[group] for group in GROUPS},
        "duplicates": {
            "calls": totals.duplicates["calls"],
            "texts": totals.duplicates["texts"],
            "consultations": {kind: totals.duplicates["consultations"][kind] for kind in config.consult_kinds},
            "events": {cls: totals.duplicates["events"][cls] for cls in EVENT_CLASSES},
        },
        "events": {
            cls: {group: group_report(totals.events[cls][group]) for group in GROUPS} for cls in EVENT_CLASSES
        },
        "data_quality": {
            "rows": counters["rows"],
            "bad_lines": counters["bad_lines"],
            "rows_without_time": counters["rows_without_time"],
            "sessions_without_time": counters["sessions_without_time"],
        },
    }
    sessions.sort(key=lambda entry: (entry["session"], entry["transcript"]))
    return report, sessions


def fail(message):
    sys.stderr.write("advisor_event_coverage: %s\n" % message)
    return 2


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Offline coverage of advisor consultations by rule events (counts only).")
    parser.add_argument("--projects", required=True, help="directory with transcripts (no default)")
    parser.add_argument("--since", help="start of the window, ISO 8601 (UTC without offset)")
    parser.add_argument("--until", help="end of the window (exclusive), ISO 8601 (UTC without offset)")
    parser.add_argument("--label", required=True, help="label written to the report")
    parser.add_argument("--consult-command", action="append", default=[], metavar="COMMAND",
                        help="Bash command (first word, after environment assignments) that counts as a consultation; repeatable")
    parser.add_argument("--declaration-prefix", default=DEFAULT_DECLARATION_PREFIX,
                        help="prefix of the declaration lines written after a consultation (default %(default)s)")
    parser.add_argument("--report-prefix", default=DEFAULT_REPORT_PREFIX,
                        help="prefix of the first line of a final report (default %(default)s)")
    parser.add_argument("--out", help="JSON report file; must not exist before the run (mode 0600)")
    parser.add_argument("--sessions-out", help="JSON list of sessions with advisor calls or declaration lines in the "
                        "window; must not exist before the run (mode 0600)")
    return parser.parse_args(argv)


def write_new_file(path, text):
    """Creates the file (it must not exist) and writes the text. A failure after the creation removes the file."""
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


def main(argv):
    args = parse_args(argv)
    since = parse_time(args.since) if args.since is not None else None
    until = parse_time(args.until) if args.until is not None else None
    if args.since is not None and since is None:
        return fail("--since is not an ISO 8601 time")
    if args.until is not None and until is None:
        return fail("--until is not an ISO 8601 time")
    if since is not None and until is not None and since >= until:
        return fail("--since must be earlier than --until")
    if args.declaration_prefix == "" or args.report_prefix == "":
        return fail("--declaration-prefix and --report-prefix must not be empty")
    if any(command == "" or len(command.split()) != 1 for command in args.consult_command):
        return fail("--consult-command must be a single word")
    if not os.path.isdir(args.projects):
        return fail("--projects is not a directory")
    if not os.access(args.projects, os.R_OK | os.X_OK):
        return fail("--projects cannot be read")
    if args.out is not None and os.path.lexists(args.out):
        return fail("--out already exists")
    if args.sessions_out is not None:
        if os.path.lexists(args.sessions_out):
            return fail("--sessions-out already exists")
        if args.out is not None and os.path.realpath(args.out) == os.path.realpath(args.sessions_out):
            return fail("--sessions-out must differ from --out")
    for option, path in (("--out", args.out), ("--sessions-out", args.sessions_out)):
        if path is not None:
            parent = os.path.dirname(os.path.abspath(path))
            if not os.path.isdir(parent) or not os.access(parent, os.W_OK | os.X_OK):
                return fail("cannot write %s" % option)
    try:
        report, sessions = build_report(args, Window(since, until))
    except OSError:
        return fail("cannot read the input")
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    outputs = []
    if args.sessions_out is not None:
        outputs.append(("--sessions-out", args.sessions_out, json.dumps(sessions, indent=2) + "\n"))
    if args.out is not None:
        outputs.append(("--out", args.out, text))
    created = []
    for option, path, content in outputs:
        try:
            write_new_file(path, content)
        except FileExistsError:
            message = "%s already exists" % option
        except (OSError, UnicodeError):
            message = "cannot write %s" % option
        else:
            created.append(path)
            continue
        for earlier in created:
            remove_quietly(earlier)
        return fail(message)
    if args.out is None:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
