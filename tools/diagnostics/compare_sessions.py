#!/usr/bin/env python3
"""Compare two Claude Code session transcripts (JSONL) by counts, differences and evidence gaps.

The script reports numbers only and never issues a verdict. README.md in this directory
documents the input format, the metrics and every output field.

Usage:
  python3 -I compare_sessions.py --a <session_a.jsonl> --b <session_b.jsonl> [options]
  python3 -I compare_sessions.py --timeline <session.jsonl> [--no-subagents]
"""

import json
import os
import sys
from datetime import datetime

SCHEMA_VERSION = 1
DEFAULT_THRESHOLD = 20.0
INTERRUPT_PREFIX = "[Request interrupted by user"
TURN_END_REASONS = ("end_turn", "stop_sequence")
THRESHOLD_NOTE = "descriptive threshold (default 20 %), not a verdict"
HELP = """Compare two Claude Code sessions from their transcripts: counts, differences, evidence gaps. No verdict.

Usage:
  compare_sessions.py --a <session_a.jsonl> --b <session_b.jsonl> [--no-subagents]
      [--time-threshold-pct 20] [--output <file.json>]
  compare_sessions.py --timeline <session.jsonl> [--no-subagents]

Options:
  --a <file>                 transcript of session A (baseline)
  --b <file>                 transcript of session B (candidate)
  --timeline <file>          timeline of one session instead of a comparison (no input or result text)
  --no-subagents             main transcript only, without <id>/subagents/agent-*.jsonl
  --time-threshold-pct N     threshold for the percentage increase of the mean tool time (default 20).
                             """ + THRESHOLD_NOTE + """
  --output <file>            write the JSON to a NEW file with mode 0600; an existing file is never
                             overwritten (exit 1)
  -h, --help                 this help

Exit codes: 0 success, 1 usage or read error. The script issues no verdict; the reader does.
"""


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    return 1


def epoch_seconds(text):
    """Seconds since the epoch from an ISO 8601 string (`Z` suffix); None when missing or invalid."""
    if not isinstance(text, str) or not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def content_blocks(line):
    """List of blocks from message.content; a plain string becomes one text block; otherwise an empty list."""
    msg = line.get("message")
    if not isinstance(msg, dict):
        return []
    content = msg.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}] if content else []
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


def is_interrupt(row, blocks):
    """User line with an interrupt marker: a text block starting with the interrupt prefix."""
    for b in blocks:
        if b.get("type") == "text" and str(b.get("text", "")).startswith(INTERRUPT_PREFIX):
            return True
    return False


def has_nonempty_text(blocks):
    """Whether the line has a non-empty text block."""
    for b in blocks:
        if b.get("type") == "text" and str(b.get("text", "")):
            return True
    return False


def has_tool_result(blocks):
    return any(b.get("type") == "tool_result" for b in blocks)


def origin_kind(line):
    """Origin of a user message from origin.kind; a missing field or a malformed one gives "none"."""
    origin = line.get("origin")
    if isinstance(origin, dict):
        kind = origin.get("kind")
        if isinstance(kind, str) and kind:
            return kind
    return "none"


def timestamp_text(line):
    """Line timestamp as a string (ISO 8601, UTC with Z), or None when it is missing or not a string."""
    ts = line.get("timestamp")
    return ts if isinstance(ts, str) and ts else None


class ToolStats:
    def __init__(self):
        self.calls = 0
        self.failures = 0
        self.incomplete = 0
        self.measured = 0
        self.total_ms = 0

    def data(self):
        mean = self.total_ms / self.measured if self.measured else None
        return {
            "calls": self.calls,
            "failures": self.failures,
            "incomplete": self.incomplete,
            "measured": self.measured,
            "total_ms": self.total_ms,
            "mean_ms": mean,
        }


def analyze(main_file, no_subagents, with_timeline=False):
    """State of one session from the main file and (unless no_subagents) its subagent files; (state, error).

    `with_timeline` adds the event timeline (timeline mode only); otherwise the state carries no events."""
    if not os.path.isfile(main_file):
        return None, f"no such file {main_file}"
    session_id = os.path.splitext(os.path.basename(main_file))[0]
    files = [(main_file, "main")]
    if not no_subagents:
        agents_dir = os.path.join(os.path.dirname(os.path.abspath(main_file)), session_id, "subagents")
        if os.path.isdir(agents_dir):
            for name in sorted(os.listdir(agents_dir)):
                if name.startswith("agent-") and name.endswith(".jsonl"):
                    files.append((os.path.join(agents_dir, name), "subagent"))

    calls = {}  # block id -> {tool, ts, ts_text, file, line, result: None | {status, duration_ms, ts}}
    seen_results = set()
    orphan_results = 0
    bad_lines = 0
    compact_positions = {}  # file index -> list of compact_boundary positions in that file
    tools = {}
    models = set()
    line_times = []
    turns = {"started": 0, "ended": 0, "interrupted": 0, "ended_api_error": 0, "mid_turn": 0}
    started_by_source = {}
    mid_turn_by_source = {}
    server_tool_use = 0
    advisor_tool_result = 0
    seen_server = set()
    seen_advisor = set()
    ends_without_turn = 0
    api_errors_without_turn = 0
    unclosed = []  # (file, timestamp of the line that opened the turn)
    events = []  # timeline: (ts_epoch, ts_text, file_index, kind, data)
    file_info = []

    for file_index, (path, role) in enumerate(files):
        try:
            with open(path, encoding="utf-8", errors="replace") as handle:
                lines = handle.readlines()
        except OSError as read_error:
            return None, f"read error {path}: {read_error}"
        valid = 0
        compacts = []
        turn_open = False
        turn_open_ts = None
        for position, raw in enumerate(lines, start=1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                o = json.loads(raw)
            except ValueError:
                bad_lines += 1
                continue
            if not isinstance(o, dict):
                bad_lines += 1
                continue
            valid += 1
            typ = o.get("type")
            if typ == "system":
                if o.get("subtype") == "compact_boundary":
                    compacts.append(position)
                    ts = epoch_seconds(o.get("timestamp"))
                    line_times.append(ts)
                    events.append((ts, timestamp_text(o), file_index, "compaction", {}))
                continue  # other system lines and every other type are skipped (api-request-blob too)
            if typ not in ("assistant", "user"):
                continue  # blob, attachment, summary and every other type is skipped
            ts = epoch_seconds(o.get("timestamp"))
            line_times.append(ts)
            ts_text = timestamp_text(o)
            msg = o.get("message")
            blocks = content_blocks(o)
            if typ == "assistant":
                model = msg.get("model") if isinstance(msg, dict) else None
                stop = msg.get("stop_reason") if isinstance(msg, dict) else None
                if model == "<synthetic>":
                    # synthetic lines are skipped entirely (calls, models, turns, timeline),
                    # except an API error line, which closes an open turn as ended by API error
                    if o.get("isApiErrorMessage") is True:
                        if turn_open:
                            turn_open = False
                            turn_open_ts = None
                            turns["ended_api_error"] += 1
                            events.append((ts, ts_text, file_index, "turn_end_api_error", {}))
                        else:
                            api_errors_without_turn += 1
                    continue
                if isinstance(model, str) and model:
                    models.add(model)
                for number, block in enumerate(blocks):
                    block_type = block.get("type")
                    if block_type == "server_tool_use":
                        identifier = block.get("id")
                        key = identifier if isinstance(identifier, str) and identifier else ("no-id", file_index, position, number)
                        if key not in seen_server:
                            seen_server.add(key)
                            server_tool_use += 1
                    elif block_type == "advisor_tool_result":
                        tuid = block.get("tool_use_id")
                        key = tuid if isinstance(tuid, str) and tuid else ("no-id", file_index, position, number)
                        if key not in seen_advisor:
                            seen_advisor.add(key)
                            advisor_tool_result += 1
                    elif block_type == "tool_use":
                        identifier = block.get("id")
                        if not isinstance(identifier, str) or not identifier:
                            continue
                        if identifier in calls:
                            continue  # unique by block id (split response, resumed copies)
                        tool = block.get("name")
                        if not isinstance(tool, str) or not tool:
                            tool = "(unknown)"
                        record = tools.setdefault(tool, ToolStats())
                        record.calls += 1
                        calls[identifier] = {
                            "tool": tool, "ts": ts, "ts_text": ts_text, "file": file_index,
                            "line": position, "result": None,
                        }
                        events.append((ts, ts_text, file_index, "tool_call", {"tool": tool, "id": identifier}))
                if stop in TURN_END_REASONS:
                    if turn_open:
                        turn_open = False
                        turn_open_ts = None
                        turns["ended"] += 1
                        events.append((ts, ts_text, file_index, "turn_end", {}))
                    else:
                        ends_without_turn += 1
            else:  # user
                for number, block in enumerate(blocks):
                    if block.get("type") == "advisor_tool_result":
                        tuid = block.get("tool_use_id")
                        key = tuid if isinstance(tuid, str) and tuid else ("no-id", file_index, position, number)
                        if key not in seen_advisor:
                            seen_advisor.add(key)
                            advisor_tool_result += 1
                    elif block.get("type") == "tool_result":
                        identifier = block.get("tool_use_id")
                        if not isinstance(identifier, str) or not identifier:
                            continue
                        if identifier in seen_results:
                            continue  # duplicate result (resumed copies) is skipped
                        seen_results.add(identifier)
                        failed = block.get("is_error") is True  # explicit flag only; the word "error" in content is not a failure
                        call = calls.get(identifier)
                        if call is None or call["result"] is not None:
                            orphan_results += 1  # result without a call in the transcript
                            events.append((ts, ts_text, file_index, "result", {"id": identifier, "status": "failure" if failed else "ok", "duration_ms": None, "no_call": True}))
                            continue
                        duration_ms = None
                        if ts is not None and call["ts"] is not None:
                            diff = int(round((ts - call["ts"]) * 1000))
                            if diff >= 0:
                                duration_ms = diff
                        call["result"] = {"status": "failure" if failed else "ok", "duration_ms": duration_ms, "ts": ts}
                        record = tools[call["tool"]]
                        if failed:
                            record.failures += 1
                        if duration_ms is not None:
                            record.measured += 1
                            record.total_ms += duration_ms
                        events.append((ts, ts_text, file_index, "result", {"id": identifier, "status": "failure" if failed else "ok", "duration_ms": duration_ms}))
                # turns: state kept per file
                if o.get("isCompactSummary") is True or o.get("isVisibleInTranscriptOnly") is True:
                    pass  # skipped for turns (compaction summary, transcript-only notes)
                elif is_interrupt(o, blocks):
                    # an interrupt closes the open turn whether or not this line also has a tool_result;
                    # the tool_result of this line is still counted above
                    if turn_open:
                        turn_open = False
                        turn_open_ts = None
                        turns["interrupted"] += 1
                        events.append((ts, ts_text, file_index, "turn_interrupted", {}))
                elif not has_tool_result(blocks):
                    source = origin_kind(o)
                    if has_nonempty_text(blocks):
                        if turn_open:
                            turns["mid_turn"] += 1
                            mid_turn_by_source[source] = mid_turn_by_source.get(source, 0) + 1
                            events.append((ts, ts_text, file_index, "message_mid_turn", {"source": source}))
                        else:
                            turn_open = True
                            turn_open_ts = ts_text
                            turns["started"] += 1
                            started_by_source[source] = started_by_source.get(source, 0) + 1
                            events.append((ts, ts_text, file_index, "turn_start", {"source": source}))
                    # a line without non-empty text is skipped for turns
                # a line with a tool_result and no interrupt neither opens nor closes a turn
        if valid == 0 and role == "main":
            return None, f"file {path} has no valid line"
        if valid == 0:  # an empty or fully malformed subagent file does not stop the measurement
            file_info.append({"file": path, "role": role, "lines": len(lines), "valid_lines": 0})
            compact_positions[file_index] = []
            continue
        compact_positions[file_index] = compacts
        file_info.append({"file": path, "role": role, "lines": len(lines), "valid_lines": valid})
        if turn_open:
            unclosed.append((path, turn_open_ts))

    # classify unfinished calls: before a compaction in the same file, or plain incomplete
    incomplete_plain = 0
    incomplete_across = 0
    no_result = []
    for identifier, call in calls.items():
        if call["result"] is not None:
            continue
        compacts = compact_positions.get(call["file"], [])
        after_compact = any(pos > call["line"] for pos in compacts)
        if after_compact:
            incomplete_across += 1
        else:
            incomplete_plain += 1
        tools[call["tool"]].incomplete += 0 if after_compact else 1
        no_result.append((identifier, call, after_compact))

    tool_calls_total = sum(n.calls for n in tools.values())
    failures_total = sum(n.failures for n in tools.values())
    measured_total = sum(n.measured for n in tools.values())
    times = [t for t in line_times if t is not None]
    state = {
        "session": session_id,
        "files": file_info,
        "bad_lines": bad_lines,
        "metrics": {
            "duration_ms": int(round((max(times) - min(times)) * 1000)) if times else None,
            "tool_calls": tool_calls_total,
            "failures": failures_total,
            "incomplete": incomplete_plain,
            "turns_started": turns["started"],
            "turns_ended": turns["ended"],
            "turns_interrupted": turns["interrupted"],
            "turns_ended_by_api_error": turns["ended_api_error"],
            "messages_mid_turn": turns["mid_turn"],
            "messages_mid_turn_by_source": dict(sorted(mid_turn_by_source.items())),
            "turns_started_by_source": dict(sorted(started_by_source.items())),
            "compactions": sum(len(p) for p in compact_positions.values()),
            "server_tool_use": server_tool_use,
            "advisor_tool_result": advisor_tool_result,
        },
        "models": sorted(models),
        "tools": {name: stats.data() for name, stats in sorted(tools.items())},
        "gaps": {
            "incomplete_tool_calls": incomplete_plain,
            "incomplete_across_compaction": incomplete_across,
            "orphan_results": orphan_results,
            "unclosed_turns": len(unclosed),
            "unclosed_turn_list": [{"file": p, "timestamp": t} for p, t in unclosed],
            "no_tool_calls": 1 if tool_calls_total == 0 else 0,
            "unmeasured_tool_calls": tool_calls_total - measured_total,
            "ends_without_turn": ends_without_turn,
            "api_errors_without_turn": api_errors_without_turn,
        },
    }
    timeline = []
    for ts, ts_text, order, kind, data in events:
        entry = {"kind": kind, "time": ts_text}
        entry.update(data)
        timeline.append((ts if ts is not None else float("-inf"), order, entry))
    timeline.sort(key=lambda x: (x[0], x[1]))
    for identifier, call, after_compact in no_result:
        timeline.append((float("inf"), 0, {
            "kind": "tool_call_no_result", "time": call.get("ts_text"), "tool": call["tool"], "id": identifier,
            "before_compaction": after_compact,
        }))
    if with_timeline:
        state["timeline"] = [entry for _, _, entry in timeline]
    return state, None


def compare_numbers(a, b):
    delta = None if a is None or b is None else b - a
    percent = None if a is None or a <= 0 or delta is None else delta / a * 100.0
    return {"a": a, "b": b, "delta": delta, "percent": percent}


def compare_states(a, b, threshold):
    keys = ("duration_ms", "tool_calls", "failures", "incomplete", "turns_started",
            "turns_ended", "turns_interrupted", "turns_ended_by_api_error",
            "messages_mid_turn", "compactions", "server_tool_use", "advisor_tool_result")
    metrics = {k: compare_numbers(a["metrics"][k], b["metrics"][k]) for k in keys}
    models_a, models_b = set(a["models"]), set(b["models"])
    models_cmp = {"a": a["models"], "b": b["models"], "added": sorted(models_b - models_a), "removed": sorted(models_a - models_b)}

    tools = []
    for name in sorted(set(a["tools"]) | set(b["tools"])):
        sa = a["tools"].get(name)
        sb = b["tools"].get(name)
        cmp_counts = {
            "calls": compare_numbers(sa["calls"] if sa else 0, sb["calls"] if sb else 0),
            "failures": compare_numbers(sa["failures"] if sa else 0, sb["failures"] if sb else 0),
            "incomplete": compare_numbers(sa["incomplete"] if sa else 0, sb["incomplete"] if sb else 0),
        }
        comparable = (
            sa is not None and sb is not None
            and sa["calls"] > 0 and sb["calls"] > 0
            and sa["measured"] == sa["calls"] and sb["measured"] == sb["calls"]
        )
        mean_a = sa["mean_ms"] if sa else None
        mean_b = sb["mean_ms"] if sb else None
        if comparable and mean_a is not None and mean_b is not None:
            if mean_a == 0:
                percent = None  # division by zero impossible; unmeasured is not zero
                above = None
            else:
                percent = (mean_b - mean_a) / mean_a * 100.0
                above = percent > threshold
        else:
            percent = None
            above = None
        cmp_counts["mean_time_ms"] = {"a": mean_a, "b": mean_b, "delta": None if mean_a is None or mean_b is None else mean_b - mean_a, "percent": percent, "above_threshold": above}
        tools.append({
            "tool": name,
            "presence": "both" if sa and sb else ("only_a" if sa else "only_b"),
            "a": sa,
            "b": sb,
            "time_comparable": comparable,
            "comparison": cmp_counts,
        })
    return {"metrics": metrics, "models": models_cmp, "tools": tools}


def main(argv):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8")
    options = {"a": None, "b": None, "timeline": None, "no_subagents": False,
               "threshold": DEFAULT_THRESHOLD, "output": None}
    with_value = {"--a": "a", "--b": "b", "--timeline": "timeline", "--time-threshold-pct": "threshold",
                  "--output": "output"}
    i = 0
    while i < len(argv):
        token = argv[i]
        if token in ("-h", "--help"):
            print(HELP, end="")
            return 0
        if token == "--no-subagents":
            options["no_subagents"] = True
            i += 1
            continue
        key = with_value.get(token)
        if key is None:
            return fail(f"unknown option {token!r}; --help shows usage")
        if i + 1 >= len(argv):
            return fail(f"missing value after {token}")
        value = argv[i + 1]
        if not value.strip():
            return fail(f"empty value after {token}")
        if key == "threshold":
            try:
                value = float(value)
            except ValueError:
                return fail("--time-threshold-pct takes a number (percent)")
            if value < 0:
                return fail("--time-threshold-pct must not be negative")
        options[key] = value
        i += 2

    if options["timeline"]:
        if options["a"] or options["b"]:
            return fail("--timeline excludes --a and --b")
        if options["output"]:
            return fail("--output applies only to the --a/--b comparison")
    else:
        if not options["a"] or not options["b"]:
            return fail("comparison requires --a and --b (or --timeline)")

    if options["timeline"]:
        state, message = analyze(options["timeline"], options["no_subagents"], with_timeline=True)
        if state is None:
            return fail(message)
        result = {"schema": SCHEMA_VERSION, "mode": "timeline", "session": state["session"],
                  "files": state["files"], "bad_lines": state["bad_lines"],
                  "duration_ms": state["metrics"]["duration_ms"],
                  "gaps": state["gaps"], "events": state["timeline"]}
    else:
        state_a, message = analyze(options["a"], options["no_subagents"])
        if state_a is None:
            return fail(f"A: {message}")
        state_b, message = analyze(options["b"], options["no_subagents"])
        if state_b is None:
            return fail(f"B: {message}")
        result = {
            "schema": SCHEMA_VERSION,
            "mode": "compare",
            "time_threshold_pct": options["threshold"],
            "time_threshold_note": THRESHOLD_NOTE,
            "a": state_a,
            "b": state_b,
            "comparison": compare_states(state_a, state_b, options["threshold"]),
        }
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if options["output"]:
        try:
            descriptor = os.open(options["output"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(text + "\n")
        except FileExistsError:
            return fail(f"--output: file {options['output']} exists, write refused (never overwrites)")
        except OSError as write_error:
            return fail(f"--output: {write_error}")
        print(f"output written: {options['output']}", file=sys.stderr)
        return 0
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
