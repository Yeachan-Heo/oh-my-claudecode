#!/usr/bin/env python3
r"""Offline monitor of cheap post-compaction harm signals, no action taken.

Reads Claude Code transcripts and the compaction log, computes three cheap harm signals per
compaction and, when given the per-unit output of the request-loss probe
(compaction_ask_probe.py --details --out <file>), measures how well each signal agrees
with ask_lost. Read-only: nothing is written to sessions, plugin or state. Standard output carries
numbers and group names only, never transcript text, keys or paths.
Usage: python3 -I compaction_harm_monitor.py [--projects <dir>] [--transcript <file>]...
    [--compact <file>] [--to <ISO-8601-UTC>] [--days <N>] [--probe <file>] [--json]
Without --compact the journal is compaction.jsonl in $OMC_JEV_LOG_DIR, else in .omc/state/jev under the
current directory (run the tool from the project root). With OMC_STATE_DIR set, the Jev log directory has a
project identifier in its path: pass the file with --compact or set OMC_JEV_LOG_DIR. Only that one file is read:
a journal that OMC_JEV_LOG_MAX_MB rotated leaves the older rows in the rotated files, and the units of that
period count as host. The transcripts are searched in $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects.
The report counts the lines it could not read (input.journal and input.transcripts: rows, bad_lines), and a
journal in which no line is a JSON object gives a warning on standard error.

RULE (written before any measurement; do not change after seeing a result):
- Unit = compaction boundary (row system/compact_boundary with a timestamp inside [to - days, to]),
  identical to the probe: a boundary uuid present in several files counts once; the unit key is the uuid,
  or "<file>:<timestamp>" without a uuid. Group = (kind, thread): kind jev (paired compact-log row with
  result jev), fallback (result fallback) or host (no paired row); thread main or subagent. The pairing
  is the probe's: candidate pairs (boundary occurrence, log row) share session and thread, differ by at
  most 600 s in time and carry result jev or fallback; pairs sort by (distance, key, file, log line) and a
  pair is taken when neither side is used yet. Groups are never merged (different context windows).
- State after compaction = user/assistant rows after the boundary up to the first row of type
  "api-request"; a unit without that row has no state and is outside every denominator.
- Call = all assistant rows sharing one message.id (Claude Code writes one row per content block, so a
  row-level rule would flag every thinking-only row). Only calls whose id was not seen before the
  boundary or inside the state count; rows without message.id are ignored. A call is EMPTY when it has
  no text block with non-whitespace text and no tool_use block. A call with text or a tool call is not
  empty and resets a series.
- Signal empty_series: longest run of consecutive EMPTY calls among the first --window (10) calls after
  the state. Defined when at least --series-min (3) calls were observed; flagged when run >= 3.
- Signal tool_errors: among the first --tool-window (10) tool_use blocks after the state, the share whose
  tool_result has is_error true (results are looked up until the next boundary). Defined when at least
  --min-tool-results (3) of them have a result; flagged when the share >= --error-share-min (0.5).
- Signal fallback_run: number of consecutive fallback rows in the compaction log, in file order within one
  (session_id, agent_id) thread, ending at the unit's own row (rows with result jev reset the run, other
  results are neutral). Defined only for units of kind fallback; flagged when run >= --fallback-run-min (5).
  It is not defined for jev (always 0) and host (no row).
- Correlation with ask_lost (only with --probe): joined units are those with the signal defined and a
  probe level in {full, trace, paraphrased, lost}; ask_lost = level lost. Reported per (signal, group):
  n, tp, fp, fn, tn, agreement = (tp + tn) / n with Wilson 95 % bounds (z = 1.959963984540054), and the two
  error bases: selective = lost share among flagged units, per_query = flagged-and-lost over all joined units.
  Agreement alone is dominated by the base rate, so the verdict is: n < 30 gives "no threshold" (rates and
  bounds hidden); otherwise "correlated" only when both arms are non-empty and the Wilson lower bound of the
  lost share among flagged units is above the Wilson upper bound of the lost share among unflagged units;
  anything else is "no correlation" and the signal is dropped. min_support = 30.
- Period: with --probe and neither --to nor --days, the probe's period is adopted; an explicit period that
  differs from the probe's is refused (exit 2). Unit keys that built from file paths only match when both
  scripts get the same transcript paths.

Exit codes: 0 ok; 2 usage error, missing or unusable input file (a --transcript path that cannot be read stops the
run; a transcript found by the search that cannot be read is skipped with a warning on standard error).

"""

import argparse
import json
import math
import os
import re
import sys
from datetime import datetime, timedelta, timezone

DEFAULT_DAYS = 7

SCHEMA = "compaction-harm-monitor/1"
MIN_SUPPORT = 30
Z_95 = 1.959963984540054
PAIR_WINDOW_S = 600.0
PROBE_LEVELS = ("full", "trace", "paraphrased", "lost")
PROBE_LOST = "lost"
SIGNALS = ("empty_series", "tool_errors", "fallback_run")
VERDICT_NO_THRESHOLD = "no threshold"
VERDICT_CORRELATED = "correlated"
VERDICT_NONE = "no correlation"
PERIOD_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


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


def ts_epoch(text):
    """Seconds since the epoch from ISO 8601 (trailing Z or offset); None when missing or invalid."""
    if not isinstance(text, str) or not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def fmt_epoch(epoch):
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime(PERIOD_FORMAT)


def wilson(k, n, z=Z_95):
    """(lower, upper) Wilson bounds; (None, None) when n <= 0."""
    if not n or n <= 0:
        return None, None
    p = k / n
    z2 = z * z
    denom = 1 + z2 / n
    centre = (p + z2 / (2 * n)) / denom
    radius = z * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom
    return max(0.0, centre - radius), min(1.0, centre + radius)


def blocks(row):
    """Content blocks of message.content; a plain string becomes one text block; none: empty list."""
    msg = row.get("message")
    if not isinstance(msg, dict):
        return []
    content = msg.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}] if content else []
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


def thread_agent(raw):
    """Thread id of a compaction-log row: None for the main thread, otherwise the id without "agent-"."""
    if raw in (None, "", "null"):
        return None
    return str(raw).removeprefix("agent-")


def load_compact(path):
    """Compaction-log rows (event compact) with _line = number of the non-empty line; (rows, input), where
    input = {"rows": lines that are JSON objects, "bad_lines": the other non-empty lines}."""
    rows = []
    bad = 0
    good = 0
    line_no = 0
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            line_no += 1
            try:
                row = json.loads(line)
            except ValueError:
                bad += 1
                continue
            if not isinstance(row, dict):
                bad += 1
                continue
            good += 1
            if row.get("event") == "compact":
                row["_line"] = line_no
                rows.append(row)
    return rows, {"rows": good, "bad_lines": bad}


def mark_fallback_runs(rows):
    """Sets _fallback_run on every row: consecutive fallbacks ending at the row within one thread."""
    runs = {}
    for row in rows:
        thread = (row.get("session_id"), thread_agent(row.get("agent_id")))
        result = row.get("result")
        if result == "fallback":
            runs[thread] = runs.get(thread, 0) + 1
        elif result == "jev":
            runs[thread] = 0
        row["_fallback_run"] = runs.get(thread, 0) if result == "fallback" else 0


def scan_transcript(path, window, tool_window):
    """One streaming pass over a transcript; returns (session_id, list of boundary records, input) with
    input = {"rows": lines that are JSON objects, "bad_lines": the other non-empty lines}.

    Boundary record: uuid, ts_text, ts, has_state, calls (message.id -> {text, tool}, at most `window`),
    tool_ids (first `tool_window` tool_use ids after the state), results (tool_use_id -> is_error)."""
    session_id = None
    boundaries = []
    current = None
    seen = set()
    new_ids = set()
    good = 0
    bad = 0
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                bad += 1
                continue
            if not isinstance(row, dict):
                bad += 1
                continue
            good += 1
            kind = row.get("type")
            if session_id is None and isinstance(row.get("sessionId"), str) and row["sessionId"]:
                session_id = row["sessionId"]
            if kind == "system" and row.get("subtype") == "compact_boundary":
                if current is not None:
                    boundaries.append(current)
                current = {
                    "uuid": row.get("uuid"),
                    "ts_text": row.get("timestamp"),
                    "ts": ts_epoch(row.get("timestamp")),
                    "has_state": False,
                    "calls": {},
                    "tool_ids": [],
                    "tool_set": set(),
                    "results": {},
                }
                new_ids = set()
                continue
            if kind == "api-request":
                if current is not None:
                    current["has_state"] = True
                continue
            if kind not in ("user", "assistant"):
                continue
            msg = row.get("message")
            msg_id = msg.get("id") if isinstance(msg, dict) else None
            if current is None or not current["has_state"]:
                if isinstance(msg_id, str) and msg_id:
                    seen.add(msg_id)
                continue
            if kind == "user":
                for block in blocks(row):
                    tid = block.get("tool_use_id")
                    if block.get("type") == "tool_result" and tid in current["tool_set"]:
                        current["results"][tid] = block.get("is_error") is True
                continue
            if not (isinstance(msg_id, str) and msg_id):
                continue
            if msg_id not in new_ids:
                if msg_id in seen:
                    continue
                new_ids.add(msg_id)
                seen.add(msg_id)
            has_text = False
            has_tool = False
            for block in blocks(row):
                if block.get("type") == "text" and str(block.get("text", "")).strip():
                    has_text = True
                elif block.get("type") == "tool_use":
                    has_tool = True
                    tid = block.get("id")
                    if isinstance(tid, str) and tid and tid not in current["tool_set"] \
                            and len(current["tool_ids"]) < tool_window:
                        current["tool_ids"].append(tid)
                        current["tool_set"].add(tid)
            call = current["calls"].get(msg_id)
            if call is None and len(current["calls"]) < window:
                call = current["calls"][msg_id] = {"text": False, "tool": False}
            if call is not None:
                call["text"] = call["text"] or has_text
                call["tool"] = call["tool"] or has_tool
    if current is not None:
        boundaries.append(current)
    return session_id, boundaries, {"rows": good, "bad_lines": bad}


def find_transcripts(projects):
    """(path, thread, agent_id): <projects>/<dir>/<id>.jsonl and <projects>/<dir>/<id>/subagents/agent-*.jsonl."""
    files = []
    if not os.path.isdir(projects):
        return files
    for directory in sorted(os.listdir(projects)):
        full = os.path.join(projects, directory)
        if not os.path.isdir(full) or directory.startswith("."):
            continue
        for name in sorted(os.listdir(full)):
            if name.endswith(".jsonl") and os.path.isfile(os.path.join(full, name)):
                files.append((os.path.join(full, name), "main", None))
        for name in sorted(os.listdir(full)):
            sub = os.path.join(full, name, "subagents")
            if os.path.isdir(sub):
                for item in sorted(os.listdir(sub)):
                    if item.startswith("agent-") and item.endswith(".jsonl"):
                        files.append((os.path.join(sub, item), "subagent", item[6:-6]))
    return files


def assign_units(occurrences, compact_rows):
    """One unit per boundary key; kind and the paired log row follow the probe's pairing rule."""
    by_key = {}
    for occ in occurrences:
        by_key.setdefault(occ["key"], []).append(occ)
    pairs = []
    for key, occs in by_key.items():
        for occ in occs:
            if occ["session"] is None:
                continue
            for row in compact_rows:
                if row.get("result") not in ("jev", "fallback"):
                    continue
                if row.get("session_id") != occ["session"]:
                    continue
                if thread_agent(row.get("agent_id")) != occ["agent_id"]:
                    continue
                row_ts = ts_epoch(row.get("ts"))
                if row_ts is None:
                    continue
                distance = abs(row_ts - occ["ts"])
                if distance <= PAIR_WINDOW_S:
                    pairs.append((distance, key, occ["path"], row["_line"], occ, row))
    pairs.sort(key=lambda pair: (pair[0], pair[1], pair[2], pair[3]))
    used_rows = set()
    units = {}
    for _distance, key, _path, _line, occ, row in pairs:
        if key in units or id(row) in used_rows:
            continue
        used_rows.add(id(row))
        occ["kind"] = str(row.get("result"))
        occ["row"] = row
        units[key] = occ
    for key, occs in by_key.items():
        if key in units:
            continue
        occ = min(occs, key=lambda item: item["path"])
        occ["kind"] = "host"
        occ["row"] = None
        units[key] = occ
    return sorted(units.values(), key=lambda unit: (unit["ts"], unit["path"], unit["key"]))


def longest_empty_run(calls):
    best = run = 0
    for call in calls:
        if call["text"] or call["tool"]:
            run = 0
        else:
            run += 1
            best = max(best, run)
    return best


def unit_signals(unit, cfg):
    """{signal: None (not defined) or (value, flagged)} for one unit; empty without state."""
    out = {name: None for name in SIGNALS}
    boundary = unit["boundary"]
    if not boundary["has_state"]:
        return out
    calls = list(boundary["calls"].values())
    if len(calls) >= cfg["series_min"]:
        run = longest_empty_run(calls)
        out["empty_series"] = (run, run >= cfg["series_min"])
    recorded = [boundary["results"][t] for t in boundary["tool_ids"] if t in boundary["results"]]
    if len(recorded) >= cfg["min_tool_results"]:
        share = sum(1 for failed in recorded if failed) / len(recorded)
        out["tool_errors"] = (share, share >= cfg["error_share_min"])
    if unit["kind"] == "fallback":
        run = unit["row"]["_fallback_run"]
        out["fallback_run"] = (run, run >= cfg["fallback_run_min"])
    return out


def rounded(value):
    return None if value is None else round(value, 4)


def correlate(pairs):
    """pairs: list of (flagged, lost) booleans. Correlation block with the pre-registered verdict."""
    n = len(pairs)
    tp = sum(1 for flagged, lost in pairs if flagged and lost)
    fp = sum(1 for flagged, lost in pairs if flagged and not lost)
    fn = sum(1 for flagged, lost in pairs if not flagged and lost)
    tn = n - tp - fp - fn
    block = {"n": n, "tp": tp, "fp": fp, "fn": fn, "tn": tn,
             "denominator": "units with the signal defined and a probe level",
             "agreement": None, "selective": None, "per_query": None}
    if n < MIN_SUPPORT:
        block["verdict"] = VERDICT_NO_THRESHOLD
        return block

    def share(k, m):
        low, high = wilson(k, m)
        return {"k": k, "n": m, "rate": rounded(k / m) if m else None,
                "wilson_low": rounded(low), "wilson_high": rounded(high)}

    block["agreement"] = share(tp + tn, n)
    block["selective"] = share(tp, tp + fp)
    block["per_query"] = share(tp, n)
    flagged_low = wilson(tp, tp + fp)[0]
    unflagged_high = wilson(fn, fn + tn)[1]
    both = (tp + fp) > 0 and (fn + tn) > 0
    block["verdict"] = VERDICT_CORRELATED if both and flagged_low > unflagged_high else VERDICT_NONE
    return block


def load_probe(path):
    """Per-unit probe output: ({key: (kind, thread, level)}, period or None). Raises ValueError when unusable."""
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict) or not isinstance(data.get("units"), list):
        raise ValueError("probe file has no per-unit list; rerun the probe with --details")
    units = {}
    for item in data["units"]:
        if not isinstance(item, dict) or not isinstance(item.get("uuid"), str):
            continue
        group = str(item.get("group", "")).split("/")
        kind = group[0]
        thread = group[1] if len(group) == 2 and group[1] in ("main", "subagent") else None
        units[item["uuid"]] = (kind, thread, item.get("ask_level"))
    period = None
    raw = data.get("period")
    if isinstance(raw, dict) and ts_epoch(raw.get("from")) is not None and ts_epoch(raw.get("to")) is not None:
        period = (ts_epoch(raw["from"]), ts_epoch(raw["to"]))
    return units, period


def build_report(units, probe, period, cfg, quality):
    per_unit = [(unit, unit_signals(unit, cfg)) for unit in units]
    report = {
        "schema": SCHEMA,
        "period": {"from": fmt_epoch(period[0]), "to": fmt_epoch(period[1])},
        "params": {key: cfg[key] for key in sorted(cfg)},
        "min_support": MIN_SUPPORT,
        "units": len(units),
        "units_without_state": sum(1 for unit in units if not unit["boundary"]["has_state"]),
        "input": quality,
        "signals": {},
        "probe": None,
    }
    mine = {unit["key"]: unit for unit in units}
    if probe is not None:
        stats = {"units": len(probe), "monitor_only": sum(1 for key in mine if key not in probe),
                 "probe_only": sum(1 for key in probe if key not in mine),
                 "group_mismatch": 0, "without_level": 0}
        for key, unit in mine.items():
            if key in probe:
                kind, thread, level = probe[key]
                if (kind, thread) != (unit["kind"], unit["thread"]):
                    stats["group_mismatch"] += 1
                if level not in PROBE_LEVELS:
                    stats["without_level"] += 1
        report["probe"] = stats
    for name in SIGNALS:
        groups = {}
        for unit, signals in per_unit:
            if not unit["boundary"]["has_state"]:
                continue
            group = f"{unit['kind']}/{unit['thread']}"
            entry = groups.setdefault(group, {"units": 0, "defined": 0, "flagged": 0, "pairs": []})
            entry["units"] += 1
            value = signals[name]
            if value is None:
                continue
            entry["defined"] += 1
            entry["flagged"] += 1 if value[1] else 0
            if probe is not None and unit["key"] in probe and probe[unit["key"]][2] in PROBE_LEVELS:
                entry["pairs"].append((value[1], probe[unit["key"]][2] == PROBE_LOST))
        out = {}
        for group in sorted(groups):
            entry = groups[group]
            out[group] = {"units": entry["units"], "defined": entry["defined"], "flagged": entry["flagged"],
                          "correlation": correlate(entry["pairs"]) if probe is not None else None}
        report["signals"][name] = out
    return report


def text_report(report):
    lines = [f"compaction-harm-monitor: period {report['period']['from']} to {report['period']['to']}",
             f"units n = {report['units']}, without state {report['units_without_state']}",
             f"input: journal rows {report['input']['journal']['rows']}, bad lines {report['input']['journal']['bad_lines']}; "
             f"transcripts rows {report['input']['transcripts']['rows']}, bad lines {report['input']['transcripts']['bad_lines']}"]
    if report["probe"] is not None:
        p = report["probe"]
        lines.append(f"probe: units {p['units']}, monitor_only {p['monitor_only']}, probe_only {p['probe_only']}, "
                     f"group_mismatch {p['group_mismatch']}, without_level {p['without_level']}")
    for name in SIGNALS:
        for group, entry in report["signals"][name].items():
            lines.append(f"  {name} {group}: units {entry['units']}, defined {entry['defined']}, flagged {entry['flagged']}")
            corr = entry["correlation"]
            if corr is None:
                continue
            line = f"    vs ask_lost: n {corr['n']}, tp {corr['tp']}, fp {corr['fp']}, fn {corr['fn']}, tn {corr['tn']}"
            if corr["agreement"] is not None:
                a = corr["agreement"]
                line += f", agreement {a['rate']} (wilson {a['wilson_low']} to {a['wilson_high']})"
            lines.append(f"{line}, verdict: {corr['verdict']}")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Offline monitor of cheap post-compaction harm signals.", allow_abbrev=False)
    ap.add_argument("--projects", default=default_projects_dir(), help="directory with Claude Code projects")
    ap.add_argument("--transcript", action="append", default=None, help="transcript file (repeatable; replaces the search)")
    ap.add_argument("--compact", default=default_compact_path(),
                    help="compaction journal (default: compaction.jsonl in $OMC_JEV_LOG_DIR, else in .omc/state/jev under the current directory; with OMC_STATE_DIR set, pass the file or set OMC_JEV_LOG_DIR)")
    ap.add_argument("--to", default=None, help="period end, ISO 8601 UTC (default now)")
    ap.add_argument("--days", type=int, default=None, help=f"period length in days (default {DEFAULT_DAYS})")
    ap.add_argument("--probe", default=None,
                    help="per-unit probe result (probe run with --details --out <file>)")
    ap.add_argument("--window", type=int, default=10, help="calls observed after the state")
    ap.add_argument("--tool-window", type=int, default=10, help="tool calls observed after the state")
    ap.add_argument("--series-min", type=int, default=3, help="empty calls in a row that flag a unit")
    ap.add_argument("--min-tool-results", type=int, default=3, help="tool results needed to define the error share")
    ap.add_argument("--error-share-min", type=float, default=0.5, help="error share that flags a unit")
    ap.add_argument("--fallback-run-min", type=int, default=5, help="consecutive fallbacks that flag a unit")
    ap.add_argument("--json", action="store_true", help="print one JSON object")
    args = ap.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if args.days is not None and args.days < 0:
        print("error: --days must not be negative", file=sys.stderr)
        return 2
    if min(args.window, args.tool_window, args.series_min, args.min_tool_results, args.fallback_run_min) < 1:
        print("error: window and minimum options must be at least 1", file=sys.stderr)
        return 2
    probe = None
    probe_period = None
    if args.probe is not None:
        try:
            probe, probe_period = load_probe(args.probe)
        except (OSError, ValueError) as error:
            print(f"error: --probe: {error}", file=sys.stderr)
            return 2
    if args.to is None and args.days is None and probe_period is not None:
        since_epoch, until_epoch = probe_period
    else:
        try:
            until = datetime.now(timezone.utc) if args.to is None else datetime.fromisoformat(args.to.replace("Z", "+00:00"))
        except ValueError:
            print("error: --to is not ISO 8601", file=sys.stderr)
            return 2
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
        until_epoch = until.timestamp()
        since_epoch = (until - timedelta(days=DEFAULT_DAYS if args.days is None else args.days)).timestamp()
        if probe_period is not None and (abs(since_epoch - probe_period[0]) > 1 or abs(until_epoch - probe_period[1]) > 1):
            print("error: the period differs from the probe's period; rerun with the same --to and --days", file=sys.stderr)
            return 2
    if not os.path.isfile(args.compact):
        print("error: compaction log not found", file=sys.stderr)
        return 2
    try:
        compact_rows, journal_input = load_compact(args.compact)
    except OSError as error:
        print(f"error: compaction log: {error}", file=sys.stderr)
        return 2
    if journal_input["rows"] == 0 and journal_input["bad_lines"] > 0:
        print(f"warning: none of the {journal_input['bad_lines']} lines of the compaction log is a JSON object; "
              "every unit is counted as host", file=sys.stderr)
    mark_fallback_runs(compact_rows)
    if args.transcript:
        files = []
        for path in args.transcript:
            name = os.path.basename(path)
            if "subagents" in path.replace(os.sep, "/").split("/") and name.startswith("agent-") and name.endswith(".jsonl"):
                files.append((path, "subagent", name[6:-6]))
            else:
                files.append((path, "main", None))
    else:
        files = find_transcripts(args.projects)
    files.sort(key=lambda item: item[0])
    occurrences = []
    transcript_input = {"rows": 0, "bad_lines": 0}
    for path, thread, agent_id in files:
        try:
            session_id, boundaries, file_input = scan_transcript(path, args.window, args.tool_window)
        except OSError as error:
            if args.transcript:
                print(f"error: --transcript: {error}", file=sys.stderr)
                return 2
            print(f"warning: skipping an unreadable transcript: {error.strerror}", file=sys.stderr)
            continue
        transcript_input["rows"] += file_input["rows"]
        transcript_input["bad_lines"] += file_input["bad_lines"]
        for boundary in boundaries:
            if boundary["ts"] is None or not (since_epoch <= boundary["ts"] <= until_epoch):
                continue
            key = boundary["uuid"] if boundary["uuid"] else f"{path}:{boundary['ts_text']}"
            occurrences.append({"key": key, "path": path, "thread": thread, "agent_id": agent_id,
                                "session": session_id, "ts": boundary["ts"], "boundary": boundary})
    units = assign_units(occurrences, compact_rows)
    cfg = {"window": args.window, "tool_window": args.tool_window, "series_min": args.series_min,
           "min_tool_results": args.min_tool_results, "error_share_min": args.error_share_min,
           "fallback_run_min": args.fallback_run_min}
    report = build_report(units, probe, (since_epoch, until_epoch), cfg,
                          {"journal": journal_input, "transcripts": transcript_input})
    print(json.dumps(report, ensure_ascii=False, indent=2) if args.json else text_report(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
