#!/usr/bin/env python3
"""Causes of context-window drops in Claude Code transcripts: an offline diagnostic script.

Usage:
  python3 -I compaction_window_drops.py [--projects <projects dir>] [--transcript FILE ...]
      [--compact <compaction.jsonl>] [--to ISO] [--days N] [--min-drop-tokens N] [--min-drop-percent N]
      [--tolerance-s S] [--json] [--out FILE]
Standard library only; isolated mode (-I); input is read-only.
Without --compact the journal is compaction.jsonl in $OMC_JEV_LOG_DIR, else in .omc/state/jev under the
current directory (run the tool from the project root). With OMC_STATE_DIR set, the Jev log directory has a
project identifier in its path: pass the file with --compact or set OMC_JEV_LOG_DIR.

Input: session transcript JSONL files (main files `<projects>/<dir>/<id>.jsonl` and subagents
`<projects>/<dir>/<id>/subagents/agent-*.jsonl`; `agent-*.meta.json` files are skipped) plus the
compaction journal compaction.jsonl (compact and after events). Read line by line; api-request-shape,
api-request-blob and every other row type are skipped. One API call is recorded as several rows with the
same message.id: the first occurrence in the file is counted, later ones are skipped; rows with
message.model "<synthetic>" and rows without usage are also skipped. A line that is not a JSON object is a
bad line (counted in data_quality).
RULE (written before the measurement; identical text as the RULE constant in the code):
""" + """
The call window = input_tokens + cache_read_input_tokens + cache_creation_input_tokens (missing field = 0); with an advisor call the main usage fields are the sum of two message iterations (the thread model call before the advisor and after it), so they look roughly doubled and would give a false drop on the next call, therefore when usage.iterations contains at least one element of type message, the window is computed from the last such element (the advisor-call trap), otherwise from the main usage fields; a call with window 0 is skipped.
A drop = two consecutive counted calls of the same file with window_prev - window >= min-drop-tokens AND >= min-drop-percent of the previous window; a drop belongs to the period when the current call's timestamp is in [to - days, to].
Cause classes in order (first match wins): module_compaction (a compact row with result jev), host_after_fallback (a compact row with result fallback), host (a compact_boundary in the transcript without a compact row in the journal), new_process (the current request with base absent/null and keep 0, without a marker and journal), side_task (the querySource of the current and previous requests differ, both available), no_cut_shape_change (continuous prefix and a shapeHash change), no_cut_prefix (continuous prefix: the current base equals the previous id, both non-empty strings, and keeps match arithmetically), cut_without_marker (broken prefix; assigned by exclusion), no_cause (the rest).
Drops from the main fields (a parallel measurement of the advisor trap) are counted per message.id pair without copy duplicates.
The control arm n is the number of drops in files without any compact row in the journal, not the number of files.
"""

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone

# Identical text as the RULE section of the docstring (the report's "rule" field).
RULE = (
    "The call window = input_tokens + cache_read_input_tokens + cache_creation_input_tokens (missing field = 0); "
    "with an advisor call the main usage fields are the sum of two message iterations, so they look roughly doubled "
    "and would give a false drop on the next call, therefore when usage.iterations contains at least one element of "
    "type message, the window is computed from the last such element (the advisor-call trap), otherwise from the main "
    "usage fields; a call with window 0 is skipped. "
    "A drop = two consecutive counted calls of the same file with window_prev "
    "- window >= min-drop-tokens AND >= min-drop-percent of the previous "
    "window; a drop belongs to the period when the current call's timestamp "
    "is in [to - days, to]. "
    "Cause classes in order (first match wins): module_compaction (a compact "
    "row with result jev), host_after_fallback (a compact row with result "
    "fallback), host (a compact_boundary in the transcript without a compact "
    "row in the journal), new_process (the current request with base "
    "absent/null and keep 0, without a marker and journal), side_task (the "
    "querySource of the current and previous requests differ, both "
    "available), no_cut_shape_change (continuous prefix and a shapeHash "
    "change), no_cut_prefix (continuous prefix: the current base equals the "
    "previous id, both non-empty strings, and keeps match arithmetically), "
    "cut_without_marker (broken prefix; assigned by exclusion), no_cause "
    "(the rest). "
    "The same message.id pair in several files (copied history) is one unit "
    "counted once; compact-row matching: the candidate is a row with result "
    "jev or fallback from the drop's thread (session_id from the file's rows "
    "and agent_id by the file name) and ts within +/-tolerance-s of the call "
    "pair, distance 0 when ts is between the calls, otherwise the distance "
    "to the closer end; assignment over pairs ascending by (distance, file "
    "path, drop line, compact row number), a journal row is consumed at "
    "assignment; without assignment the journal reading is none and the "
    "unit's file is the first by path. "
    "Drops from the main fields (a parallel measurement of the advisor "
    "trap) are counted per message.id pair without copy duplicates. "
    "The control arm n is the number of drops in files without any compact "
    "row in the journal, not the number of files."
)
Z_WILSON = 1.959963984540054
MIN_SUPPORT = 30
CAUSE_CLASSES = [
    "module_compaction",
    "host_after_fallback",
    "host",
    "new_process",
    "side_task",
    "no_cut_shape_change",
    "no_cut_prefix",
    "cut_without_marker",
    "no_cause",
]
def iso_to_epoch(text):
    """ISO 8601 timestamp (with Z or offset) to seconds (float); None when unreadable."""
    if not isinstance(text, str) or not text:
        return None
    t = text.strip()
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(t)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except ValueError:
        return None


def epoch_to_iso(epoch):
    """Seconds (float) to an ISO 8601 UTC string with Z."""
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def is_number(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def is_int(x):
    if isinstance(x, bool):
        return False
    if isinstance(x, int):
        return True
    return isinstance(x, float) and float(x).is_integer()
def window_sum(d):
    """Sum of the three window fields; a missing or non-numeric field counts as 0."""
    total = 0
    for field in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
        v = d.get(field)
        if is_number(v):
            total += v
    return int(total)


def window_from_usage(usage):
    """Window with the advisor trap: the last message iteration, else the main fields."""
    it = usage.get("iterations")
    if isinstance(it, list):
        last = None
        for el in it:
            if isinstance(el, dict) and el.get("type") == "message":
                last = el
        if last is not None:
            return window_sum(last)
    return window_sum(usage)


def prefix_continuity(current, previous):
    """Prefix continuity: continuous / broken / unavailable."""
    if not isinstance(current, dict) or not isinstance(previous, dict):
        return "unavailable"
    keep_c = current.get("keep")
    keep_p = previous.get("keep")
    if not is_int(keep_c) or not is_int(keep_p):
        return "unavailable"
    base_c = current.get("base")
    id_p = previous.get("id")
    tail_p = previous.get("tail")
    tail_len = len(tail_p) if isinstance(tail_p, list) else 0
    if isinstance(base_c, str) and base_c and isinstance(id_p, str) and id_p and base_c == id_p:
        if int(keep_c) == int(keep_p) + tail_len:
            return "continuous"
    return "broken"
def shape_change(current, previous):
    """Request shape change: yes / no / unavailable (shapeHash comparison)."""
    if not isinstance(current, dict) or not isinstance(previous, dict):
        return "unavailable"
    hc = current.get("shapeHash")
    hp = previous.get("shapeHash")
    if hc is None or hp is None:
        return "unavailable"
    return "yes" if hc != hp else "no"


def built_from_scratch(current):
    """Request built from scratch: base absent or null AND keep equal to 0."""
    if not isinstance(current, dict):
        return False
    if "base" not in current and current.get("base") is not None:
        return False
    if "base" in current and current.get("base") is not None:
        return False
    keep = current.get("keep")
    return is_int(keep) and int(keep) == 0


def wilson_lower(count, total):
    """Wilson 95% lower bound; total <= 0 gives None, count 0 gives 0.0."""
    if total <= 0:
        return None
    if count <= 0:
        return 0.0
    p = count / total
    z2 = Z_WILSON * Z_WILSON
    denom = 1 + z2 / total
    root = math.sqrt(p * (1 - p) / total + z2 / (4 * total * total))
    lower = (p + z2 / (2 * total) - Z_WILSON * root) / denom
    return max(0.0, lower)
def median(values):
    """Median of a list of numbers; an empty list gives None."""
    if not values:
        return None
    ordered = sorted(values)
    n = len(ordered)
    mid = n // 2
    if n % 2 == 1:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def load_journal(path):
    """The compaction journal: compact and after rows, quality counts and gaps.

    Returns a dict with keys:
      rows, bad_lines, compact (list: ts_f, idx, row), compact_ts (set of compact-row ts
      strings), after (compact_ts -> tokens_after_real), compact_without_after,
      after_without_compact.
    """
    result = {
        "rows": 0,
        "bad_lines": 0,
        "compact": [],
        "compact_ts": set(),
        "after": {},
        "all_after_ts": set(),
        "compact_without_after": 0,
        "after_without_compact": 0,
    }
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            result["rows"] += 1
            try:
                row = json.loads(line)
            except ValueError:
                result["bad_lines"] += 1
                continue
            if not isinstance(row, dict):
                result["bad_lines"] += 1
                continue
            event = row.get("event")
            if event == "compact":
                result["compact"].append({
                    "ts_f": iso_to_epoch(row.get("ts")),
                    "idx": len(result["compact"]),
                    "row": row,
                })
                result["compact_ts"].add(str(row.get("ts")))
            elif event == "after":
                key = str(row.get("compact_ts"))
                result["all_after_ts"].add(key)
                tokens = row.get("tokens_after_real")
                if is_number(tokens):
                    result["after"][key] = int(tokens)
    for w in result["compact"]:
        if str(w["row"].get("ts")) not in result["all_after_ts"]:
            result["compact_without_after"] += 1
    for key in result["after"]:
        if key not in result["compact_ts"]:
            result["after_without_compact"] += 1
    return result
def default_compact_path():
    """Default journal path: OMC_JEV_LOG_DIR, else .omc/state/jev under the current directory, file compaction.jsonl."""
    base = os.environ.get("OMC_JEV_LOG_DIR")
    if not base:
        base = os.path.join(os.getcwd(), ".omc", "state", "jev")
    return os.path.join(base, "compaction.jsonl")


def default_projects_dir():
    """Default projects dir: CLAUDE_CONFIG_DIR/projects or ~/.claude/projects."""
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    if not base:
        base = os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(base, "projects")


def find_transcripts(projects):
    """List of (path, agent_id) transcript files under --projects, sorted by path.

    Main: <projects>/<dir>/<id>.jsonl; subagents: <projects>/<dir>/<id>/subagents/agent-*.jsonl.
    """
    found = []
    for parent, _dirs, files in os.walk(projects):
        for name in files:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(parent, name)
            rel = os.path.relpath(path, projects)
            parts = rel.split(os.sep)
            if len(parts) == 2 and parts[1].endswith(".jsonl"):
                found.append((path, None))
            elif len(parts) == 4 and parts[2] == "subagents" and parts[3].startswith("agent-") and parts[3].endswith(".jsonl"):
                agent_id = parts[3][len("agent-"):-len(".jsonl")]
                found.append((path, agent_id))
    found.sort(key=lambda p: p[0])
    return found
def index_pass(path, file_index, index):
    """Pass 1: message.id -> number of distinct files (one entry per file per id).

    The same call criteria as in the second pass: an assistant row with message.id, model
    other than <synthetic>, with usage; the first occurrence in the file.
    """
    seen = set()
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if not isinstance(row, dict):
                continue
            if row.get("type") != "assistant":
                continue
            msg = row.get("message")
            if not isinstance(msg, dict):
                continue
            mid = msg.get("id")
            if not isinstance(mid, str) or not mid:
                continue
            if msg.get("model") == "<synthetic>":
                continue
            if not isinstance(msg.get("usage"), dict):
                continue
            if mid in seen:
                continue
            seen.add(mid)
            entry = index.get(mid)
            if entry is None:
                index[mid] = [file_index, 1]
            elif entry[0] != file_index:
                entry[0] = file_index
                entry[1] += 1
def evaluate_pair(prev, call, boundaries, agent_id, context):
    """A pair of consecutive counted calls: the window drop (readings) and main-field drops.

    Returns a drop dict (without the cause) or None; the main-field drop counter lives in
    the context.
    """
    if call["ts_f"] is None or prev["ts_f"] is None:
        return None
    drop_tokens = prev["window"] - call["window"]
    drop_percent = 100.0 * drop_tokens / prev["window"]
    in_period = context["from"] <= call["ts_f"] <= context["to"]
    main_tokens = prev["window_main"] - call["window_main"]
    if prev["window_main"] > 0 and main_tokens >= context["min_tokens"]:
        if 100.0 * main_tokens / prev["window_main"] >= context["min_percent"] and in_period:
            context["main_pairs"].add((prev["id"], call["id"]))
    if drop_tokens < context["min_tokens"] or drop_percent < context["min_percent"] or not in_period:
        return None
    marker = "yes" if boundaries else "no"
    trigger_seen = "unavailable"
    pretokens = None
    if boundaries:
        meta = boundaries[-1].get("compactMetadata")
        if isinstance(meta, dict):
            tr = meta.get("trigger")
            trigger_seen = str(tr) if tr is not None else "unavailable"
            pretokens = meta.get("preTokens")
            if not is_number(pretokens):
                pretokens = None
    readings = {
        "boundary": marker,
        "boundary_trigger": trigger_seen,
        "preTokens": pretokens if pretokens is not None else "unavailable",
        "pretokens_match": "unavailable",
        "journal": "none",
        "after": "no",
        "tokens_after_real": "unavailable",
        "after_diff_percent": "unavailable",
        "prefix": prefix_continuity(call["request"], prev["request"]),
        "shape_change": shape_change(call["request"], prev["request"]),
        "query_source_current": "unavailable",
        "query_source_previous": "unavailable",
        "session_change": "yes" if call["session"] != prev["session"] else "no",
        "built_from_scratch": "yes" if built_from_scratch(call["request"]) else "no",
        "prev_without_api_request": "yes" if prev["request"] is None else "no",
        "copied_history": "no",
        "gap_s": round(call["ts_f"] - prev["ts_f"], 3),
    }
    if isinstance(call["request"], dict):
        qs = call["request"].get("querySource")
        if qs is not None:
            readings["query_source_current"] = str(qs)
    if isinstance(prev["request"], dict):
        qs = prev["request"].get("querySource")
        if qs is not None:
            readings["query_source_previous"] = str(qs)
    if marker == "yes" and pretokens is not None:
        pretokens_diff = abs(pretokens - prev["window"])
        readings["pretokens_match"] = "yes" if pretokens_diff <= 0.10 * prev["window"] else "no"
    readings["after_60min_gap"] = "yes" if (call["ts_f"] - prev["ts_f"]) >= 3600.0 else "no"
    drop = {
        "file": context["current_file"],
        "session_id": call["session"],
        "agent_id": agent_id,
        "ts_prev": str(prev["ts_text"]) if prev["ts_text"] is not None else epoch_to_iso(prev["ts_f"]),
        "ts": str(call["ts_text"]) if call["ts_text"] is not None else epoch_to_iso(call["ts_f"]),
        "ts_prev_f": prev["ts_f"],
        "ts_f": call["ts_f"],
        "line": call["line"],
        "window_prev": prev["window"],
        "window": call["window"],
        "drop_tokens": drop_tokens,
        "drop_percent": round(drop_percent, 2),
        "model": call["model"],
        "prev_id": prev["id"],
        "id": call["id"],
        "readings": readings,
        "compact_ts": "unavailable",
    }
    return drop
def scan_file(path, agent_id, context):
    """Pass 2: streaming transcript read, drops on pairs of counted calls.

    Returns file stats: rows, bad_lines, calls (counted and zero-window), zero_window,
    without_api_request, sessions (set of the file's sessionIds).
    """
    stats = {
        "rows": 0,
        "bad_lines": 0,
        "calls": 0,
        "zero_window": 0,
        "without_api_request": 0,
    }
    stats["sessions"] = set()
    pending_request = None
    boundaries = []
    prev = None
    seen_ids = set()
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            stats["rows"] += 1
            try:
                row = json.loads(line)
            except ValueError:
                stats["bad_lines"] += 1
                continue
            if not isinstance(row, dict):
                stats["bad_lines"] += 1
                continue
            row_type = row.get("type")
            if row_type == "api-request":
                pending_request = row
                continue
            if row_type == "system" and row.get("subtype") == "compact_boundary":
                boundaries.append(row)
                continue
            if row_type != "assistant":
                continue
            msg = row.get("message")
            if not isinstance(msg, dict):
                continue
            mid = msg.get("id")
            if not isinstance(mid, str) or not mid:
                continue
            if msg.get("model") == "<synthetic>":
                continue
            usage = msg.get("usage")
            if not isinstance(usage, dict):
                continue
            if mid in seen_ids:
                continue
            seen_ids.add(mid)
            stats["calls"] += 1
            if pending_request is None:
                stats["without_api_request"] += 1
            window = window_from_usage(usage)
            if window <= 0:
                stats["zero_window"] += 1
                pending_request = None
                continue
            ts_f = iso_to_epoch(row.get("timestamp"))
            call = {
                "id": mid,
                "model": msg.get("model"),
                "ts_f": ts_f,
                "ts_text": row.get("timestamp"),
                "session": row.get("sessionId"),
                "line": stats["rows"],
                "window": window,
            }
            call["window_main"] = window_sum(usage)
            call["request"] = pending_request
            pending_request = None
            context["current_file"] = path
            if prev is not None:
                drop = evaluate_pair(prev, call, boundaries, agent_id, context)
                if drop is not None:
                    context["drops"].append(drop)
            prev = call
            boundaries = []
            stats["sessions"].add(str(row.get("sessionId")))
    return stats
def build_units(drops, index, journal_dict, after_map, all_after_ts, tol):
    """Units per (prev_id, id) pair: copy dedup and compact-row assignment (rule 2.1).

    A unit = a drop with a unique pair; occurrences in several files are copies (counted in
    the drops_duplicated_from_copies gap). The compact-row candidates are all occurrences with
    compact rows of the same thread (session_id from the file's rows, agent_id from the file
    name), result jev or fallback (another result is not a candidate), the row's ts within
    [prev_ts - tol, call_ts + tol]; the distance is 0 when the row's ts lies between the calls,
    otherwise the distance to the closer end. Assignment over pairs ascending by (distance,
    file path, drop line, compact row number); a row is consumed at assignment. The unit takes
    the readings of the assigned occurrence (without assignment: the first by path) and the
    journal from that row.
    Returns (list of units by (path, line), number of duplicates dropped).
    """
    groups = {}
    for s in drops:
        groups.setdefault((s["prev_id"], s["id"]), []).append(s)
    dups = sum(len(lst) - 1 for lst in groups.values())
    pairs = []
    for key, occs in groups.items():
        for s in occs:
            thread = (str(s["session_id"]), s["agent_id"])
            prev_f = s["ts_prev_f"]
            call_f = s["ts_f"]
            window_low = prev_f - tol
            window_high = call_f + tol
            for w in journal_dict.get(thread, []):
                ts_c = w["ts_f"]
                if ts_c is None or w["row"].get("result") not in ("jev", "fallback"):
                    continue
                if not (window_low <= ts_c <= window_high):
                    continue
                if prev_f <= ts_c <= call_f:
                    d = 0.0
                elif ts_c < prev_f:
                    d = prev_f - ts_c
                else:
                    d = ts_c - call_f
                pairs.append((d, str(s["file"]), s["line"], w["idx"], key, s, w))
    pairs.sort(key=lambda p: (p[0], p[1], p[2], p[3]))
    assigned = {}
    used_rows = set()
    for _d, _path_s, _line, row_idx, key, s, w in pairs:
        if key in assigned or row_idx in used_rows:
            continue
        assigned[key] = (s, w)
        used_rows.add(row_idx)
    units = []
    for key, occs in groups.items():
        if key in assigned:
            rep, w = assigned[key]
            o = rep["readings"]
            o["journal"] = str(w["row"].get("result"))
            o["compact_trigger"] = w["row"].get("trigger")
            ts_key = str(w["row"].get("ts"))
            rep["compact_ts"] = ts_key
            if ts_key in all_after_ts:
                o["after"] = "yes"
                tokens = after_map.get(ts_key)
                if tokens is not None:
                    o["tokens_after_real"] = tokens
                    o["after_diff_percent"] = round(abs(tokens - rep["window"]) * 100.0 / rep["window"], 2)
            o["compact_idx"] = w["idx"]
        else:
            rep = min(occs, key=lambda s: (str(s["file"]), s["line"]))
        o = rep["readings"]
        in_many = index.get(rep["prev_id"], [None, 0])[1] > 1
        if o.get("prev_without_api_request") == "yes" or in_many or o.get("session_change") == "yes":
            o["copied_history"] = "yes"
        units.append(rep)
    units.sort(key=lambda s: (str(s["file"]), s["line"]))
    return units, dups
def assign_cause(s):
    """Cause class: the first of the 9 classes that matches, in order."""
    o = s["readings"]
    if o.get("journal") == "jev":
        return "module_compaction"
    if o.get("journal") == "fallback":
        return "host_after_fallback"
    if o.get("boundary") == "yes":
        return "host"
    if o.get("built_from_scratch") == "yes":
        return "new_process"
    qs_c = o.get("query_source_current")
    qs_p = o.get("query_source_previous")
    if qs_c != "unavailable" and qs_p != "unavailable" and qs_c != qs_p:
        return "side_task"
    if o.get("prefix") == "continuous" and o.get("shape_change") == "yes":
        return "no_cut_shape_change"
    if o.get("prefix") == "continuous":
        return "no_cut_prefix"
    if o.get("prefix") == "broken":
        return "cut_without_marker"
    return "no_cause"
def confirmation_for(s):
    """The confirmation field by cause: two readings, one reading, no second reading, n/a."""
    k = s.get("cause")
    o = s["readings"]
    if k == "module_compaction" or k == "host_after_fallback":
        both = o.get("boundary") == "yes" and o.get("after") == "yes"
        return "confirmed by two readings" if both else "one reading"
    if k == "new_process":
        both = o.get("built_from_scratch") == "yes" and o.get("copied_history") == "yes"
        return "confirmed by two readings" if both else "one reading"
    if k == "side_task" or k == "cut_without_marker":
        return "no second reading"
    return "not applicable"
def counts(values):
    """Dict of string counts from a list."""
    result = {}
    for v in values:
        key = str(v)
        result[key] = result.get(key, 0) + 1
    return result


def result_row(name, count, denominator):
    """A results-list row per the template: min_support 30, Wilson 95%, 4 decimal places."""
    if not is_number(denominator):
        return {
            "name": name,
            "numerator": count,
            "denominator": "unavailable",
            "share": "unavailable",
            "wilson_lower_95": "unavailable",
        }
    if denominator < MIN_SUPPORT:
        return {
            "name": name,
            "numerator": count,
            "denominator": denominator,
            "share": "insufficient data",
            "wilson_lower_95": "insufficient data",
        }
    return {
        "name": name,
        "numerator": count,
        "denominator": denominator,
        "share": round(count / denominator, 4),
        "wilson_lower_95": round(wilson_lower(count, denominator), 4),
    }
def build_report(context, clean, dups, file_stats, journal_data, args, period):
    """The whole report object: the template fields plus the tool's own fields."""
    n = len(clean)
    models = counts([s["model"] for s in clean])
    triggers = {}
    for s in clean:
        o = s["readings"]
        if s["cause"] in ("module_compaction", "host_after_fallback"):
            tr = o.get("compact_trigger")
            triggers[str(tr) if tr is not None else "unavailable"] = triggers.get(str(tr) if tr is not None else "unavailable", 0) + 1
        elif s["cause"] == "host":
            tr = o.get("boundary_trigger")
            triggers[str(tr) if tr is not None else "unavailable"] = triggers.get(str(tr) if tr is not None else "unavailable", 0) + 1
        else:
            triggers["none"] = triggers.get("none", 0) + 1
    class_counts = {k: 0 for k in CAUSE_CLASSES}
    for s in clean:
        class_counts[s["cause"]] += 1
    confirmed = {k: 0 for k in ("module_compaction", "host_after_fallback", "new_process")}
    class3_total = 0
    class3_match = 0
    for s in clean:
        k = s["cause"]
        o = s["readings"]
        if o.get("confirmation") == "confirmed by two readings" and k in confirmed:
            confirmed[k] += 1
        if k == "host":
            match = o.get("pretokens_match")
            if match != "unavailable":
                class3_total += 1
                if match == "yes":
                    class3_match += 1
    after_diffs = []
    for s in clean:
        if s["cause"] in ("module_compaction", "host_after_fallback") and s["readings"].get("after") == "yes":
            after_diffs.append(s["readings"].get("after_diff_percent"))
    median_after = median(after_diffs)
    has_compact = {}
    for stats in file_stats:
        keys = [(sid, stats["agent_id"]) for sid in stats["sessions"]]
        hit = any(k in context["journal"] for k in keys)
        has_compact[stats["file"]] = hit
    control_n = sum(1 for s in clean if not has_compact.get(s["file"], False))
    arms = {"with_journal": {}, "without_journal": {}}
    for s in clean:
        target = "with_journal" if has_compact.get(s["file"], False) else "without_journal"
        arms[target][s["cause"]] = arms[target].get(s["cause"], 0) + 1
    used_idx = set()
    for s in clean:
        if s["cause"] in ("module_compaction", "host_after_fallback"):
            idx = s["readings"].get("compact_idx")
            if idx is not None:
                used_idx.add(idx)
    read_keys = set()
    for stats in file_stats:
        for sid in stats["sessions"]:
            read_keys.add((sid, stats["agent_id"]))
    control_total = 0
    control_hit = 0
    compact_without_drop = []
    for w in journal_data["compact"]:
        row = w["row"]
        ts_f = w["ts_f"]
        if ts_f is None or not (context["from"] <= ts_f <= context["to"]):
            continue
        key = (str(row.get("session_id")), row.get("agent_id"))
        if key not in read_keys:
            continue
        control_total += 1
        if w["idx"] in used_idx:
            control_hit += 1
            continue
        aid = row.get("agent_id")
        compact_without_drop.append({
            "ts": row.get("ts"),
            "session_id": row.get("session_id"),
            "agent_id": "unavailable" if aid is None else str(aid),
            "result": row.get("result"),
            "trigger": row.get("trigger"),
        })
    assigned_1_7 = sum(class_counts[k] for k in CAUSE_CLASSES[:7])
    assigned_1_8 = sum(class_counts[k] for k in CAUSE_CLASSES[:8])
    results = [
        result_row("drops with assigned cause (classes 1-7)", assigned_1_7, n),
        result_row("drops with assigned cause including exclusion (classes 1-8)", assigned_1_8, n),
    ]
    for k in CAUSE_CLASSES:
        results.append(result_row("cause " + k, class_counts[k], n))
    results.append(result_row("module_compaction confirmed by two readings", confirmed["module_compaction"], class_counts["module_compaction"]))
    results.append(result_row("host_after_fallback confirmed by two readings", confirmed["host_after_fallback"], class_counts["host_after_fallback"]))
    results.append(result_row("new_process confirmed by two readings", confirmed["new_process"], class_counts["new_process"]))
    results.append(result_row("host: preTokens matching the window (+/-10%)", class3_match, class3_total))
    results.append(result_row("compact rows in period with a matched drop", control_hit, control_total))
    caveats = [
        "the cut_without_marker cause is assigned only by exclusion (a broken prefix without another cause), without a second independent reading",
        "the side_task cause is based only on querySource, without a second independent reading",
        "the window breakdown into components is only possible through a shapeHash change (system prompt and tool list together), without reconstructing content from api-request-blob rows",
        "the window is computed from the last message iteration (the advisor-call trap); the scale of the trap is in the drops_from_main_fields field",
        "transcripts from this machine only",
        "the journal-matching unit is the drop (a message.id pair), and the matching window is +/-tolerance-s around the drop's call pair, not 600 s from the boundary",
        "drops_from_main_fields is counted per message.id pair without copy duplicates (like n and the causes), so it is comparable with n",
    ]
    out_drops = []
    for s in clean:
        o = dict(s["readings"])
        o.pop("compact_idx", None)
        o["confirmation"] = s["readings"].get("confirmation")
        out_drops.append({
            "file": s["file"],
            "session_id": s["session_id"],
            "agent_id": "unavailable" if s["agent_id"] is None else s["agent_id"],
            "ts_prev": s["ts_prev"],
            "ts": s["ts"],
            "window_prev": s["window_prev"],
            "window": s["window"],
            "drop_tokens": s["drop_tokens"],
            "drop_percent": s["drop_percent"],
            "cause": s["cause"],
            "readings": o,
            "compact_ts": s["compact_ts"],
            "model": s["model"],
        })
    total_rows_tr = sum(st["rows"] for st in file_stats)
    total_bad_tr = sum(st["bad_lines"] for st in file_stats)
    total_zero_window = sum(st["zero_window"] for st in file_stats)
    total_no_api = sum(st["without_api_request"] for st in file_stats)
    given = args.get("transcripts")
    if given:
        pattern = ", ".join(given)
    else:
        pattern = str(args.get("projects")) + "/*/*.jsonl (main) and " + str(args.get("projects")) + "/*/subagents/agent-*.jsonl (subagents)"
    quality = [
        {
            "source": str(args.get("compact")),
            "rows": journal_data["rows"],
            "bad_lines": journal_data["bad_lines"],
            "gaps": {
                "compact_without_after": journal_data["compact_without_after"],
                "after_without_compact": journal_data["after_without_compact"],
            },
        },
        {
            "source": pattern,
            "rows": total_rows_tr,
            "bad_lines": total_bad_tr,
            "gaps": {
                "calls_without_api_request": total_no_api,
                "zero_window": total_zero_window,
                "drops_duplicated_from_copies": dups,
            },
        },
    ]
    return {
        "template": "compaction-report/1",
        "metric": "window-drops",
        "script": "compaction_window_drops.py",
        "generated_at": epoch_to_iso(datetime.now(timezone.utc).timestamp()),
        "rule": args.get("run_rule", RULE),
        "period": period,
        "data_range": (
            {"from": min(clean, key=lambda s: s["ts_f"])["ts"], "to": max(clean, key=lambda s: s["ts_f"])["ts"]}
            if clean
            else "unavailable"
        ),
        "n": {"unit": "window drop", "value": n},
        "model": models if n > 0 else "unavailable",
        "trigger": triggers if n > 0 else "unavailable",
        "control_arm": {
            "description": "drops in session files without any compact row in the compaction journal "
            "(the module compaction did not fire in the session)",
            "n": control_n,
        },
        "arms": arms,
        "data_quality": quality,
        "results": results,
        "min_support": MIN_SUPPORT,
        "caveats": caveats,
        "drops": out_drops,
        "drops_from_main_fields": len(context["main_pairs"]),
        "median_after_diff_percent": median_after if median_after is not None else "unavailable",
        "files_read": [
            {"file": st["file"], "rows": st["rows"], "bad_lines": st["bad_lines"]}
            for st in file_stats
        ],
        "compact_without_drop": compact_without_drop,
    }


def text_summary(report):
    """A short text summary without --json."""
    n = report["n"]["value"]
    lines = [
        "window drops causes (compaction_window_drops.py)",
        "period: " + report["period"]["from"] + " to " + report["period"]["to"],
        "n (drops): " + str(n),
    ]
    if n > 0:
        lines.append("models: " + json.dumps(report["model"], ensure_ascii=False, sort_keys=True))
        lines.append("triggers: " + json.dumps(report["trigger"], ensure_ascii=False, sort_keys=True))
    lines.append("control arm (files without a compact row): " + str(report["control_arm"]["n"]))
    for w in report["results"]:
        lines.append(
            w["name"] + ": " + str(w["numerator"]) + "/" + str(w["denominator"])
            + " share " + str(w["share"]) + ", Wilson " + str(w["wilson_lower_95"])
        )
    lines.append("drops_from_main_fields: " + str(report["drops_from_main_fields"]))
    return "\n".join(lines)
def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Causes of context-window drops between consecutive model calls (the rule is in the script docstring).",
    )
    parser.add_argument("--projects", default=default_projects_dir(), help="the projects directory with transcripts")
    parser.add_argument("--transcript", action="append", default=None, help="a transcript file (repeatable; instead of scanning)")
    parser.add_argument("--compact", default=default_compact_path(), help="the compaction journal (default: compaction.jsonl in $OMC_JEV_LOG_DIR, else in .omc/state/jev under the current directory; with OMC_STATE_DIR set, pass the file or set OMC_JEV_LOG_DIR)")
    parser.add_argument("--to", default=None, help="period end (ISO 8601; defaults to now UTC)")
    parser.add_argument("--days", type=int, default=7, help="period length in days (default 7)")
    parser.add_argument("--min-drop-tokens", type=int, default=10000, help="drop threshold in tokens (default 10000)")
    parser.add_argument("--min-drop-percent", type=float, default=10.0, help="drop threshold in percent of the previous window (default 10)")
    parser.add_argument("--tolerance-s", type=float, default=5.0, help="journal match tolerance in seconds (default 5)")
    parser.add_argument("--json", action="store_true", help="JSON output (the compaction-report/1 template)")
    parser.add_argument("--out", default=None, help="write JSON to a new file (0600; an existing file is an error)")
    return parser.parse_args(argv)


def agent_from_path(path):
    """agent_id from a subagent path .../subagents/agent-<id>.jsonl; a main file gives None."""
    text = path.replace(os.sep, "/")
    parts = text.split("/")
    if len(parts) >= 3 and parts[-2] == "subagents":
        name = parts[-1]
        if name.startswith("agent-") and name.endswith(".jsonl"):
            return name[len("agent-"):-len(".jsonl")]
    return None


def main(argv):
    args = parse_args(argv)
    if args.to:
        to_f = iso_to_epoch(args.to)
        if to_f is None:
            print("error: --to is not a readable timestamp", file=sys.stderr)
            return 2
    else:
        to_f = datetime.now(timezone.utc).timestamp()
    from_f = to_f - args.days * 86400.0
    if not os.path.isfile(args.compact):
        print("error: missing --compact file: " + args.compact, file=sys.stderr)
        return 2
    files = []
    if args.transcript:
        for path in args.transcript:
            if not os.path.isfile(path):
                print("error: missing --transcript file: " + path, file=sys.stderr)
                return 2
            files.append((path, agent_from_path(path)))
    else:
        if not os.path.isdir(args.projects):
            print("error: missing --projects dir: " + args.projects, file=sys.stderr)
            return 2
        for path, agent_id in find_transcripts(args.projects):
            try:
                if os.path.getmtime(path) >= from_f:
                    files.append((path, agent_id))
            except OSError:
                continue
    files.sort(key=lambda p: p[0])
    journal_data = load_journal(args.compact)
    journal_dict = {}
    per_row = journal_data["compact"]
    for w in per_row:
        row = w["row"]
        key = (str(row.get("session_id")), row.get("agent_id"))
        journal_dict.setdefault(key, []).append(w)
    index = {}
    for idx, (path, _aid) in enumerate(files):
        index_pass(path, idx, index)
    context = {
        "from": from_f,
        "to": to_f,
        "min_tokens": args.min_drop_tokens,
        "min_percent": args.min_drop_percent,
        "tol": args.tolerance_s,
        "journal": journal_dict,
        "after": journal_data["after"],
        "drops": [],
        "main_pairs": set(),
        "current_file": None,
    }
    file_stats = []
    for path, agent_id in files:
        stats = scan_file(path, agent_id, context)
        stats["file"] = path
        stats["agent_id"] = agent_id
        file_stats.append(stats)
    clean, dups = build_units(
        context["drops"],
        index,
        journal_dict,
        journal_data["after"],
        journal_data["all_after_ts"],
        args.tolerance_s,
    )
    for s in clean:
        s["cause"] = assign_cause(s)
        s["readings"]["confirmation"] = confirmation_for(s)
    period = {"from": epoch_to_iso(from_f), "to": epoch_to_iso(to_f)}
    sources = {
        "projects": args.projects,
        "compact": args.compact,
        "transcripts": [path for path, _a in files] if args.transcript else None,
        "run_rule": RULE + " Run parameters: min-drop-tokens " + str(args.min_drop_tokens)
        + ", min-drop-percent " + str(args.min_drop_percent) + ", tolerance-s " + str(args.tolerance_s)
        + ", days " + str(args.days) + ".",
    }
    report = build_report(context, clean, dups, file_stats, journal_data, sources, period)
    if args.out:
        try:
            fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as out_file:
                out_file.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        except FileExistsError:
            print("error: --out: file " + args.out + " write refused (never overwrites)", file=sys.stderr)
            return 1
        except OSError as write_error:
            print("error: --out: " + str(write_error), file=sys.stderr)
            return 1
        print("result saved: " + args.out, file=sys.stderr)
        if args.json:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            print(text_summary(report))
        return 0
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(text_summary(report))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
