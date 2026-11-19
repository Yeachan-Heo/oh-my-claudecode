#!/usr/bin/env python3
"""Executor outcome metrics from Claude Code session transcripts (JSONL).

Offline diagnostic for the transcripts of executor (worker) sessions. It only reads the
transcripts and reports numbers: tool failures, retry, parameter-drift and oscillation
loops, API exhaustion, assistant steps, thinking and output-token counts, the flags of the
final answer, and test runs without an advisor consultation. It issues no verdict; the
reader decides what the numbers mean. README.md in this directory documents the input
format, every metric and every output field.

Measurement rule: a metric that cannot be measured is reported as "unmeasured", with the
reason in the "reasons" object of the task. It is never reported as zero.

Usage:
  python3 -I executor_outcome_metrics.py --transcript <file.jsonl> [--transcript <file.jsonl> ...]
      [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--provider-map PREFIX=NAME ...]
      [--test-pattern REGEX] [--advisor-pattern REGEX] [--json]
      [--retry-threshold N] [--drift-threshold N] [--drift-min-signatures N]
      [--oscillation-min-repeats N] [--max-cycle-length N]
      [--exhaustion-status CODE ...] [--exhaustion-phrase TEXT ...] [--error-field-status NAME=CODE ...]

"""

import argparse
import json
import os
import re
import shlex
import sys
from collections import deque
from datetime import datetime, timezone
from statistics import median

UNMEASURED = "unmeasured"
RETRY_THRESHOLD = 3  # consecutive calls with an identical signature
DRIFT_THRESHOLD = 3  # consecutive calls to one tool
DRIFT_MIN_SIGNATURES = 2  # distinct signatures inside a drift run
OSCILLATION_MIN_REPEATS = 3  # full back-to-back repetitions of a cycle
MIN_CYCLE_LENGTH = 2
MAX_CYCLE_LENGTH = 5
REPEATED_LINE_MIN_RUN = 5  # the same line this many times in a row
REPEATED_LINE_MIN_LENGTH = 8  # the line must be longer than this (trimmed)
EXHAUSTION_STATUSES = (408, 413, 429, 503, 504, 529)
EXHAUSTION_PHRASES = (
    "context length",
    "context window",
    "token limit",
    "rate limit",
    "too many requests",
    "timeout",
)
PARENTHESIZED_STATUS = re.compile(r"\((\d{3})\)")
COLON_STATUS = re.compile(r":\s*(\d{3})\b")
ERROR_FIELD_STATUS = {}  # error field value -> HTTP status; empty by default, extended with --error-field-status
MODEL_SUFFIX = re.compile(r"\[[^\]]*\]$")  # context-window suffix such as "[1m]"
# a final answer whose trimmed end is a dangling operator or opener, or a declaration or return keyword
DANGLING_END = re.compile(r"(?:,|&&|\|\||=>|[+\-*/%=]|[(\[{]|:|\b(?:const|let|var|function|return))$")
ENV_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
SECONDS_ARG = re.compile(r"^\d+(?:\.\d+)?[a-zA-Z]?$")
NICE_ARG = re.compile(r"^-?\d+$")
SEGMENT_OPERATORS = ("&&", "||", ";", "|", "&")
AGENT_FILE = re.compile(r"^agent-(.+)\.jsonl$")
SUBAGENT_DIR = "subagents"
METRIC_KEYS = [
    "tool_failures", "failure_runs", "longest_failure_run",
    "retry_patterns", "parameter_drift_patterns", "oscillation_patterns",
    "exhaustion_api", "exhaustion_api_by_status", "api_errors_other", "api_errors_by_error_field",
    "exhaustion_tool_results",
    "assistant_steps", "thinking_blocks", "thinking_chars", "thinking_duration_ms", "output_tokens",
    "test_episodes_without_advisor", "test_runs_failed", "test_runs_passed", "test_runs_no_result",
    "advisor_consultations",
]
DICT_METRIC_KEYS = ["exhaustion_api_by_status", "api_errors_by_error_field"]  # not summed per provider
FINAL_FLAGS = ("empty", "cut_off", "odd_fences", "repeated_line", "ended_with_api_error")


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    return 2


def parse_time(text):
    """Timezone-aware UTC datetime from an ISO 8601 string; None when missing or unreadable."""
    if not isinstance(text, str) or not text:
        return None
    try:
        value = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def day_of(value):
    """YYYY-MM-DD (UTC) of a datetime, or None."""
    return value.strftime("%Y-%m-%d") if value else None


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def read_jsonl(path):
    """(rows, bad_lines): dictionaries of a JSONL file; lines that are not JSON objects are bad.
    Raises OSError when the file cannot be read."""
    rows = []
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
            if isinstance(row, dict):
                rows.append(row)
            else:
                bad += 1
    return rows, bad


def blocks_of(row, block_type):
    """Blocks of one type from message.content; a plain string content gives []."""
    message = row.get("message")
    if not isinstance(message, dict):
        return []
    content = message.get("content")
    if not isinstance(content, list):
        return []
    return [b for b in content if isinstance(b, dict) and b.get("type") == block_type]


def text_of_blocks(row, block_type):
    """Joined text of the blocks of one type (the thinking field for thinking blocks)."""
    key = "thinking" if block_type == "thinking" else "text"
    return "\n".join(str(b.get(key, "")) for b in blocks_of(row, block_type) if b.get(key) is not None)


def result_text(block):
    """Text of a tool_result block: a string, or the joined text parts of a list."""
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [str(b.get("text")) for b in content if isinstance(b, dict) and isinstance(b.get("text"), str)]
        return "\n".join(parts)
    return ""


def status_from_text(text):
    """HTTP status from error text: a 3-digit number in parentheses, else one after a colon; None if neither."""
    match = PARENTHESIZED_STATUS.search(text) or COLON_STATUS.search(text)
    return int(match.group(1)) if match else None


def exhaustion_key(text, status, statuses=EXHAUSTION_STATUSES, phrases=EXHAUSTION_PHRASES):
    """Key of an exhaustion item ("429", "phrase", ...), or None when it is not exhaustion."""
    if status in statuses:
        return str(status)
    lowered = text.lower()
    if any(phrase in lowered for phrase in phrases):
        return "phrase"
    return None


def parse_transcript(rows, own_thread=False):
    """Elements of one transcript from its rows (only type assistant and user is read).

    API request blobs and every other type are skipped: they copy request content and repeat
    call ids. Returns None when the file has no assistant or user row, or only rows that carry
    no measurement (no step, call, result or API error). The "main thread" is the rows with
    isSidechain false; in a subagent file (own_thread true) every row belongs to the worker's
    own thread, which the host marks isSidechain true.
    """
    calls = []  # {id, name, signature, time, row, block}
    results = {}  # tool_use_id -> {is_error, text, time}
    steps = set()
    thinking_blocks = 0
    thinking_chars = 0
    thinking_ms = 0
    has_thinking_ms = False
    tokens = {}
    has_tokens = False
    api_errors = []  # (text, error field or None)
    server_blocks = []  # {time, name, row, block}
    first = None
    last = None
    last_main_text = None
    last_main_api_error = False
    seen_ids = set()
    for index, row in enumerate(rows):
        row_type = row.get("type")
        if row_type not in ("assistant", "user"):
            continue
        when = parse_time(row.get("timestamp"))
        if when is not None:
            if first is None:
                first = when
            last = when
        if row_type == "assistant":
            message = row.get("message")
            if not isinstance(message, dict):
                message = {}
            synthetic = message.get("model") == "<synthetic>"
            if own_thread or row.get("isSidechain") is False:
                last_main_api_error = row.get("isApiErrorMessage") is True
            if row.get("isApiErrorMessage") is True:
                error = row.get("error")
                api_errors.append((text_of_blocks(row, "text"), error if isinstance(error, str) else None))
            if synthetic:
                continue
            if isinstance(message.get("id"), str) and message["id"]:
                steps.add(message["id"])
            duration = row.get("thinkingDurationMs")
            if is_number(duration):
                thinking_ms += duration
                has_thinking_ms = True
            usage = message.get("usage")
            if isinstance(usage, dict) and is_number(usage.get("output_tokens")):
                key = (message.get("id"), row.get("requestId"))
                previous = tokens.get(key)
                tokens[key] = usage["output_tokens"] if previous is None else max(previous, usage["output_tokens"])
                has_tokens = True
            for block in blocks_of(row, "thinking"):
                thinking_blocks += 1
                value = block.get("thinking")
                if isinstance(value, str):
                    thinking_chars += len(value)
            content = message.get("content")
            if isinstance(content, list):
                for position, block in enumerate(content):
                    if not isinstance(block, dict):
                        continue
                    block_type = block.get("type")
                    if block_type == "tool_use":
                        call_id = block.get("id")
                        if not isinstance(call_id, str) or call_id in seen_ids:
                            continue
                        seen_ids.add(call_id)
                        arguments = block.get("input")
                        if isinstance(arguments, dict):
                            arguments_text = json.dumps(arguments, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
                        else:
                            arguments_text = str(arguments)
                        name = str(block.get("name", ""))
                        calls.append({"id": call_id, "name": name, "signature": f"{name}({arguments_text})",
                                      "time": when, "input": arguments, "row": index, "block": position})
                    elif block_type == "server_tool_use":
                        server_blocks.append({"time": when, "name": block.get("name"), "row": index, "block": position})
            if (own_thread or row.get("isSidechain") is False) and blocks_of(row, "text"):
                last_main_text = text_of_blocks(row, "text")
        else:
            user_message = row.get("message")
            content = user_message.get("content") if isinstance(user_message, dict) else None
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_result" and isinstance(block.get("tool_use_id"), str):
                        results.setdefault(block["tool_use_id"], {
                            "is_error": block.get("is_error") is True,
                            "text": result_text(block),
                            "time": when,
                        })
    if not steps and not calls and not results and not api_errors:
        return None
    return {
        "calls": calls,
        "results": results,
        "steps": steps,
        "thinking_blocks": thinking_blocks,
        "thinking_chars": thinking_chars,
        "thinking_ms": thinking_ms if has_thinking_ms else None,
        "output_tokens": sum(tokens.values()) if has_tokens else None,
        "api_errors": api_errors,
        "server_blocks": server_blocks,
        "first": first,
        "last": last,
        "last_main_text": last_main_text,
        "last_main_api_error": last_main_api_error,
    }


def failure_metrics(calls, results):
    """Failed results (explicit is_error only), runs of at least two failures, longest run."""
    failed = [results.get(call["id"], {}).get("is_error") is True for call in calls]
    runs = 0
    current = 0
    longest = 0
    for flag in failed:
        if flag:
            current += 1
            longest = max(longest, current)
        else:
            if current >= 2:
                runs += 1
            current = 0
    if current >= 2:
        runs += 1
    return {"tool_failures": sum(failed), "failure_runs": runs, "longest_failure_run": longest}


def overlaps(first, second):
    return first["first"] <= second["last"] and second["first"] <= first["last"]


def find_retry_runs(calls, threshold=RETRY_THRESHOLD):
    """Maximal runs of consecutive calls with an identical signature, at least `threshold` long."""
    runs = []
    start = 0
    for index in range(1, len(calls) + 1):
        if index == len(calls) or calls[index]["signature"] != calls[start]["signature"]:
            if index - start >= threshold:
                runs.append({"first": start, "last": index - 1})
            start = index
    return runs


def find_drift_runs(calls, threshold=DRIFT_THRESHOLD, min_signatures=DRIFT_MIN_SIGNATURES):
    """Maximal runs of consecutive calls to one tool, at least `threshold` long, with at least
    `min_signatures` distinct signatures."""
    runs = []
    start = 0
    for index in range(1, len(calls) + 1):
        if index == len(calls) or calls[index]["name"] != calls[start]["name"]:
            run = calls[start:index]
            if len(run) >= threshold and len({call["signature"] for call in run}) >= min_signatures:
                runs.append({"first": start, "last": index - 1})
            start = index
    return runs


def remove_overlaps(patterns):
    """Sort by start, longer runs first; keep a pattern only when it starts after the end of the last kept one."""
    kept = []
    for pattern in sorted(patterns, key=lambda p: (p["first"], -(p["last"] - p["first"]))):
        if not kept or pattern["first"] > kept[-1]["last"]:
            kept.append(pattern)
    return kept


def find_oscillations(calls, min_repeats=OSCILLATION_MIN_REPEATS,
                      min_length=MIN_CYCLE_LENGTH, max_length=MAX_CYCLE_LENGTH):
    """Cycles of 2 to 5 tool names with at least two distinct names, repeated back to back at least
    `min_repeats` times in full; overlapping cycles are removed."""
    names = [call["name"] for call in calls]
    found = []
    for start in range(len(names)):
        for length in range(min_length, max_length + 1):
            cycle = names[start:start + length]
            if len(cycle) < length or len(set(cycle)) < 2:
                continue
            repeats = 1
            while names[start + repeats * length:start + (repeats + 1) * length] == cycle:
                repeats += 1
            if repeats >= min_repeats:
                found.append({"first": start, "last": start + repeats * length - 1,
                              "cycle": cycle, "cycle_count": repeats})
    return remove_overlaps(found)


def loop_patterns(calls, retry_threshold=RETRY_THRESHOLD, drift_threshold=DRIFT_THRESHOLD,
                  drift_min_signatures=DRIFT_MIN_SIGNATURES, oscillation_min_repeats=OSCILLATION_MIN_REPEATS,
                  max_cycle_length=MAX_CYCLE_LENGTH):
    """Retry, parameter drift (not overlapping a retry run) and oscillation patterns of the call list."""
    retry = find_retry_runs(calls, retry_threshold)
    drift = [run for run in find_drift_runs(calls, drift_threshold, drift_min_signatures)
             if not any(overlaps(run, other) for other in retry)]
    oscillation = find_oscillations(calls, oscillation_min_repeats, MIN_CYCLE_LENGTH, max_cycle_length)
    return {
        "retry": [[run["first"], run["last"]] for run in retry],
        "parameter_drift": [[run["first"], run["last"]] for run in drift],
        "oscillation": oscillation,
    }


def exhaustion_metrics(tr, statuses=EXHAUSTION_STATUSES, phrases=EXHAUSTION_PHRASES, error_statuses=ERROR_FIELD_STATUS):
    """Exhaustion of API errors and failed tool results (status or phrase), with the rest of the API errors."""
    api_exhaustion = 0
    by_status = {}
    api_other = 0
    by_error_field = {}
    for text, error in tr["api_errors"]:
        if error:
            by_error_field[error] = by_error_field.get(error, 0) + 1
        status = status_from_text(text)
        if status is None and error:
            status = error_statuses.get(error)
        key = exhaustion_key(text, status, statuses, phrases)
        if key is None:
            api_other += 1
        else:
            api_exhaustion += 1
            by_status[key] = by_status.get(key, 0) + 1
    tool_exhaustion = 0
    for result in tr["results"].values():
        if result["is_error"] and exhaustion_key(result["text"], status_from_text(result["text"]),
                                                  statuses, phrases) is not None:
            tool_exhaustion += 1
    return {
        "exhaustion_api": api_exhaustion,
        "exhaustion_api_by_status": by_status,
        "api_errors_other": api_other,
        "api_errors_by_error_field": by_error_field,
        "exhaustion_tool_results": tool_exhaustion,
    }


def has_repeated_line(text):
    """True when one trimmed line longer than the minimum length occurs in a row REPEATED_LINE_MIN_RUN times
    (blank lines ignored)."""
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    run = 0
    previous = None
    for line in lines:
        if line == previous:
            run += 1
        else:
            run = 1
            previous = line
        if len(line) > REPEATED_LINE_MIN_LENGTH and run >= REPEATED_LINE_MIN_RUN:
            return True
    return False


def final_result(tr):
    """Flags of the last main-thread assistant text; unmeasured when there is no such text."""
    text = tr["last_main_text"]
    if text is None:
        return {"status": UNMEASURED, "flags": [], "reason": "no main-thread text block"}
    stripped = text.strip()
    flags = []
    if not stripped:
        flags.append("empty")
    if DANGLING_END.search(stripped):
        flags.append("cut_off")
    if stripped.count("```") % 2 == 1:
        flags.append("odd_fences")
    if has_repeated_line(stripped):
        flags.append("repeated_line")
    if tr["last_main_api_error"]:
        flags.append("ended_with_api_error")
    return {"status": "measured", "flags": flags}


def command_of(call):
    """Text of input.command of a call (empty when missing)."""
    arguments = call.get("input")
    if isinstance(arguments, dict):
        return str(arguments.get("command", ""))
    return ""


def strip_comments(line):
    """Line cut at the first unquoted word that starts with #."""
    in_quote = None
    at_word_start = True
    for position, char in enumerate(line):
        if in_quote:
            if char == in_quote:
                in_quote = None
            continue
        if char in ('"', "'"):
            in_quote = char
            continue
        if char.isspace():
            at_word_start = True
            continue
        if char == "#" and at_word_start:
            return line[:position].rstrip()
        at_word_start = False
    return line


HEREDOC = re.compile(r"<<-?\s*(?!<)(['\"]?)([A-Za-z0-9_][A-Za-z0-9_-]*)\1")


def drop_heredocs(command):
    """Command without heredoc bodies: after a << or <<- operator with a delimiter word, the body lines up to
    and including the delimiter line are skipped (leading tabs removed for <<-); a body without a closing
    delimiter is skipped to the end of the command."""
    kept = []
    expected = deque()
    for line in command.split("\n"):
        if expected:
            delimiter, strip_tabs = expected[0]
            comparable = line.lstrip("\t") if strip_tabs else line
            if comparable == delimiter:
                expected.popleft()
            continue
        while True:
            match = HEREDOC.search(line)
            if not match:
                break
            expected.append((match.group(2), match.group(1) == "-"))
            line = line[:match.start()] + line[match.end():]
        kept.append(line)
    return "\n".join(kept)


def command_segments(command):
    """Segments of a Bash command as word lists, split at && || ; | & and new lines.
    Comments and heredoc bodies are removed first. shlex is used; on a shlex error a plain split is used."""
    text = "\n".join(strip_comments(line) for line in command.replace("\r", "\n").split("\n"))
    text = drop_heredocs(text)
    text = text.replace("\n", ";")
    try:
        lexer = shlex.shlex(text, posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = list(lexer)
    except ValueError:
        tokens = [piece for piece in re.split(r"&&|\|\||[;&|]|\s+", text) if piece]
    segments = []
    current = []
    for token in tokens:
        if token in SEGMENT_OPERATORS:
            if current:
                segments.append(current)
                current = []
        else:
            current.append(token)
    if current:
        segments.append(current)
    return segments


def program_of_segment(words):
    """(program, arguments) after removing prefixes: environment assignments, env with options, timeout with
    options and seconds, nice with a value, time, command, exec."""
    i = 0
    count = len(words)
    while i < count:
        word = words[i]
        if ENV_ASSIGNMENT.match(word):
            i += 1
        elif word == "env":
            i += 1
            while i < count:
                token = words[i]
                if token in ("-u", "--unset"):
                    i += 2
                elif token.startswith("-") or ENV_ASSIGNMENT.match(token):
                    i += 1
                else:
                    break
        elif word in ("time", "command", "exec"):
            i += 1
        elif word == "timeout":
            i += 1
            while i < count and (words[i].startswith("-") or SECONDS_ARG.match(words[i])):
                i += 1
        elif word == "nice":
            i += 1
            if i < count and words[i] == "-n":
                i += 2
            elif i < count and NICE_ARG.match(words[i]):
                i += 1
        else:
            break
    if i < count:
        return words[i], words[i + 1:]
    return None, []


def split_command(command):
    """List of (program, arguments, segment text after prefixes) for every segment."""
    parts = []
    for words in command_segments(command):
        program, arguments = program_of_segment(words)
        if program is None:
            parts.append((None, [], ""))
        else:
            parts.append((program, arguments, " ".join([program] + arguments)))
    return parts


def is_test_run(program, arguments):
    """Built-in test runner list: program plus subcommand (basename of the program)."""
    if program is None:
        return False
    base = os.path.basename(program)
    if base == "node":
        if arguments and arguments[0] == "--test":
            return True
        if arguments and not arguments[0].startswith("-"):
            return any(part in ("test", "tests") for part in re.split(r"[/\\]", arguments[0]))
        return False
    if base == "npx":
        return bool(arguments) and os.path.basename(arguments[0]) in ("vitest", "jest")
    if base in ("npm", "pnpm"):
        if not arguments:
            return False
        if arguments[0] == "test" or arguments[:2] == ["run", "test"]:
            return True
        return base == "npm" and arguments[0] == "t"
    if base == "yarn":
        return bool(arguments) and arguments[0] == "test"
    if base == "pytest":
        return True
    if base in ("python", "python3"):
        return any(arguments[i] == "-m" and arguments[i + 1] == "pytest" for i in range(len(arguments) - 1))
    if base in ("go", "cargo"):
        return bool(arguments) and arguments[0] == "test"
    if base in ("vitest", "jest"):
        return True
    return False


def classify_call(name, command, result, test_pattern, advisor_pattern):
    """Event kind of one call: "k" advisor consultation, "F" failed test run, "S" passed test run,
    "B" test run without a result, None for anything else. A consultation takes precedence."""
    if name != "Bash":
        return None
    parts = split_command(command)
    if not parts or all(part[0] is None for part in parts):
        return None
    if advisor_pattern is not None:
        for _, _, text in parts:
            if advisor_pattern.match(text):
                return "k"
    for program, arguments, text in parts:
        if test_pattern is not None:
            is_test = test_pattern.match(text) is not None
        else:
            is_test = is_test_run(program, arguments)
        if is_test:
            if result is None:
                return "B"
            return "F" if result.get("is_error") is True else "S"
    return None


def test_episodes(tr, test_pattern, advisor_pattern):
    """Test runs and consultations in transcript order. An episode is two or more failed test runs in a row,
    closed by a passed run or a consultation. Runs without a result neither count nor break a series."""
    events = []
    consultations = 0
    for call in tr["calls"]:
        kind = classify_call(call["name"], command_of(call), tr["results"].get(call["id"]),
                             test_pattern, advisor_pattern)
        if kind is None:
            continue
        events.append((call["row"], call["block"], kind))
        if kind == "k":
            consultations += 1
    for block in tr["server_blocks"]:
        if block.get("name") == "advisor":
            events.append((block["row"], block["block"], "k"))
            consultations += 1
    events.sort(key=lambda event: (event[0], event[1]))
    episodes = 0
    run = 0
    for _, _, kind in events:
        if kind == "F":
            run += 1
        elif kind in ("S", "k"):
            if run >= 2:
                episodes += 1
            run = 0
    if run >= 2:
        episodes += 1
    return {
        "test_episodes_without_advisor": episodes,
        "test_runs_failed": sum(1 for event in events if event[2] == "F"),
        "test_runs_passed": sum(1 for event in events if event[2] == "S"),
        "test_runs_no_result": sum(1 for event in events if event[2] == "B"),
        "advisor_consultations": consultations,
    }


def thinking_metrics(tr):
    """Thinking metrics: unmeasured with a reason when the field is absent or the text is empty."""
    metrics = {"thinking_blocks": tr["thinking_blocks"]}
    reasons = {}
    if tr["thinking_blocks"] == 0:
        metrics["thinking_chars"] = UNMEASURED
        reasons["thinking_chars"] = "no thinking blocks"
    elif tr["thinking_chars"] == 0:
        metrics["thinking_chars"] = UNMEASURED
        reasons["thinking_chars"] = "thinking text hidden or empty"
    else:
        metrics["thinking_chars"] = tr["thinking_chars"]
    if tr["thinking_ms"] is None:
        metrics["thinking_duration_ms"] = UNMEASURED
        reasons["thinking_duration_ms"] = "no thinkingDurationMs field"
    else:
        metrics["thinking_duration_ms"] = tr["thinking_ms"]
    if tr["output_tokens"] is None:
        metrics["output_tokens"] = UNMEASURED
        reasons["output_tokens"] = "no usage.output_tokens field"
    else:
        metrics["output_tokens"] = tr["output_tokens"]
    return metrics, reasons


def default_options():
    """Detector options: exhaustion statuses, phrases and error-field mapping, and the loop thresholds."""
    return {
        "statuses": EXHAUSTION_STATUSES,
        "phrases": EXHAUSTION_PHRASES,
        "error_statuses": ERROR_FIELD_STATUS,
        "retry_threshold": RETRY_THRESHOLD,
        "drift_threshold": DRIFT_THRESHOLD,
        "drift_min_signatures": DRIFT_MIN_SIGNATURES,
        "oscillation_min_repeats": OSCILLATION_MIN_REPEATS,
        "max_cycle_length": MAX_CYCLE_LENGTH,
    }


def task_metrics(tr, test_pattern, advisor_pattern, options=None):
    """All metrics of a parsed transcript, its loop patterns and the reasons of unmeasured values."""
    options = options or default_options()
    metrics = {}
    metrics.update(failure_metrics(tr["calls"], tr["results"]))
    patterns = loop_patterns(tr["calls"], options["retry_threshold"], options["drift_threshold"],
                             options["drift_min_signatures"], options["oscillation_min_repeats"],
                             options["max_cycle_length"])
    metrics["retry_patterns"] = len(patterns["retry"])
    metrics["parameter_drift_patterns"] = len(patterns["parameter_drift"])
    metrics["oscillation_patterns"] = len(patterns["oscillation"])
    metrics.update(exhaustion_metrics(tr, options["statuses"], options["phrases"], options["error_statuses"]))
    metrics["assistant_steps"] = len(tr["steps"])
    thinking, reasons = thinking_metrics(tr)
    metrics.update(thinking)
    metrics.update(test_episodes(tr, test_pattern, advisor_pattern))
    return metrics, patterns, reasons


def unmeasured_metrics(reason):
    metrics = {key: UNMEASURED for key in METRIC_KEYS}
    reasons = {key: reason for key in METRIC_KEYS}
    return metrics, reasons


def parse_provider_map(entries):
    """[(prefix, name)] from PREFIX=NAME entries; None when an entry has no '=' or an empty side."""
    mapping = []
    for entry in entries:
        prefix, separator, name = entry.partition("=")
        if not separator or not prefix or not name:
            return None
        mapping.append((prefix, name))
    return mapping


def first_model(rows, mapping):
    """(model, provider) from the first assistant row with a real model name; ("<synthetic>" is skipped)."""
    for row in rows:
        if row.get("type") != "assistant":
            continue
        model = (row.get("message") or {}).get("model") if isinstance(row.get("message"), dict) else None
        if isinstance(model, str) and model and model != "<synthetic>":
            model = MODEL_SUFFIX.sub("", model)
            for prefix, name in mapping:
                if model.startswith(prefix):
                    return model, name
            return model, "unmapped"
    return None, "unknown"


def first_session_id(rows):
    for row in rows:
        session_id = row.get("sessionId")
        if isinstance(session_id, str) and session_id:
            return session_id
    return None


def analyse_transcript(path, mapping, test_pattern, advisor_pattern, options=None):
    """One task (transcript or subagent file) with its status, metrics, flags and reasons."""
    try:
        rows, bad = read_jsonl(path)
    except OSError:
        rows, bad = None, 0
    agent = AGENT_FILE.match(os.path.basename(path))
    is_subagent_file = bool(agent) and os.path.basename(os.path.dirname(os.path.abspath(path))) == SUBAGENT_DIR
    parsed = parse_transcript(rows, own_thread=is_subagent_file) if rows is not None else None
    status = "unreadable" if rows is None else ("present" if parsed is not None else "empty")
    model, provider = first_model(rows, mapping) if rows is not None else (None, "unknown")
    stem = os.path.splitext(os.path.basename(path))[0]
    session_id = first_session_id(rows) if rows is not None else None
    parent = None
    if is_subagent_file:
        parent = session_id
        session_id = f"agent-{agent.group(1)}"
    elif session_id is None:
        session_id = stem
    if parsed is None:
        reason = "transcript unreadable" if status == "unreadable" else "transcript has no assistant or user row"
        metrics, reasons = unmeasured_metrics(reason)
        patterns = None
        final = {"status": UNMEASURED, "flags": [], "reason": reason}
        first = last = None
    else:
        metrics, patterns, reasons = task_metrics(parsed, test_pattern, advisor_pattern, options)
        final = final_result(parsed)
        first, last = parsed["first"], parsed["last"]
    return {
        "session_id": session_id,
        "provider": provider,
        "model": model,
        "parent": parent,
        "file": path,
        "transcript": status,
        "bad_lines": bad,
        "period": {"first": day_of(first), "last": day_of(last)},
        "metrics": metrics,
        "final_result": final,
        "loop_patterns": patterns,
        "reasons": reasons,
    }


def collect_tasks(args, mapping, test_pattern, advisor_pattern, options=None):
    """(tasks, skipped, no_date): transcripts in the order given, duplicates skipped, date filter applied."""
    tasks = []
    skipped = []
    no_date = 0
    seen = set()
    for path in args.transcript:
        real = os.path.realpath(path)
        if real in seen:
            skipped.append({"kind": "duplicate-file", "file": path, "reason": "same file given more than once"})
            continue
        seen.add(real)
        task = analyse_transcript(path, mapping, test_pattern, advisor_pattern, options)
        day = task["period"]["first"]
        if args.date_from or args.date_to:
            if day is None:
                no_date += 1
                continue
            if args.date_from and day < args.date_from:
                continue
            if args.date_to and day > args.date_to:
                continue
        tasks.append(task)
    return tasks, skipped, no_date


def summarise(tasks):
    """Per provider: task counts, sum and median of each numeric metric, unmeasured counts, final-answer flags."""
    groups = {}
    for task in tasks:
        groups.setdefault(task["provider"], []).append(task)
    summary = {}
    for provider in sorted(groups):
        group = groups[provider]
        metrics = {}
        for key in METRIC_KEYS:
            if key in DICT_METRIC_KEYS:
                continue
            numbers = [t["metrics"][key] for t in group if is_number(t["metrics"][key])]
            metrics[key] = {
                "sum": sum(numbers) if numbers else None,
                "median": median(numbers) if numbers else None,
                "unmeasured": sum(1 for t in group if t["metrics"][key] == UNMEASURED),
            }
        final = {flag: sum(1 for t in group if flag in t["final_result"]["flags"]) for flag in FINAL_FLAGS}
        final["unmeasured"] = sum(1 for t in group if t["final_result"]["status"] == UNMEASURED)
        summary[provider] = {
            "n": len(group),
            "with_transcript": sum(1 for t in group if t["transcript"] == "present"),
            "metrics": metrics,
            "final_result": final,
        }
    return summary


def coverage(tasks, no_date):
    total = len(tasks)
    present = sum(1 for t in tasks if t["transcript"] == "present")
    percent = f"{100.0 * present / total:.1f}" if total else "0.0"
    return {"with_transcript": present, "total": total, "percent": percent, "no_date": no_date}


def task_line(task):
    """One text line with the metrics of a task."""
    return " ".join(f"{key}={task['metrics'][key]}" for key in METRIC_KEYS)


def text_output(tasks, summary, cover, skipped):
    lines = []
    for task in tasks:
        period = task["period"]
        span = f"{period['first']}..{period['last']}" if period["first"] else "no dates"
        lines.append(f"task {task['session_id']} provider={task['provider']} model={task['model']} period={span}")
        lines.append(f"  file: {task['file']} | transcript: {task['transcript']}")
        lines.append(f"  metrics: {task_line(task)}")
        final = task["final_result"]
        if final["status"] == "measured":
            lines.append(f"  final_result: {', '.join(final['flags']) or 'no flags'}")
        else:
            lines.append(f"  final_result: unmeasured ({final.get('reason', '')})")
        if task["reasons"]:
            reasons = "; ".join(f"{key}: {value}" for key, value in sorted(task["reasons"].items()))
            lines.append(f"  unmeasured ({len(task['reasons'])}): {reasons}")
    for provider, group in sorted(summary.items()):
        lines.append(f"summary provider={provider}: tasks {group['n']} (with transcript {group['with_transcript']})")
        for key in METRIC_KEYS:
            if key in group["metrics"]:
                values = group["metrics"][key]
                lines.append(f"  {key}: sum={values['sum']} median={values['median']} unmeasured={values['unmeasured']}")
    lines.append(f"coverage: {cover['with_transcript']}/{cover['total']} tasks with transcript ({cover['percent']}%); no date: {cover['no_date']}")
    if skipped:
        lines.append(f"skipped ({len(skipped)}):")
        for item in skipped:
            lines.append("  skipped: " + "; ".join(f"{key}={value}" for key, value in item.items()))
    return "\n".join(lines)


def build_parser():
    parser = argparse.ArgumentParser(
        description="Executor outcome metrics from Claude Code transcripts (JSONL). Numbers only; no verdict.",
        epilog="Exit codes: 0 success (whatever the numbers), 2 usage error (missing file, bad option or value).",
    )
    parser.add_argument("--transcript", action="append", default=[], metavar="FILE",
                        help="transcript of one session (repeatable); subagent files named "
                             "<session>/subagents/agent-<id>.jsonl are separate tasks")
    parser.add_argument("--from", dest="date_from", metavar="YYYY-MM-DD",
                        help="keep tasks whose first timestamp (UTC) is on or after this day")
    parser.add_argument("--to", dest="date_to", metavar="YYYY-MM-DD",
                        help="keep tasks whose first timestamp (UTC) is on or before this day")
    parser.add_argument("--provider-map", action="append", default=[], metavar="PREFIX=NAME",
                        help="map a model name prefix to a provider name (repeatable, first match wins)")
    parser.add_argument("--test-pattern", metavar="REGEX",
                        help="regular expression for a test run command segment (replaces the built-in list)")
    parser.add_argument("--advisor-pattern", metavar="REGEX",
                        help="regular expression for a Bash command segment that is an advisor consultation")
    parser.add_argument("--retry-threshold", type=int, default=RETRY_THRESHOLD, metavar="N",
                        help=f"consecutive identical calls that form a retry pattern (default {RETRY_THRESHOLD})")
    parser.add_argument("--drift-threshold", type=int, default=DRIFT_THRESHOLD, metavar="N",
                        help=f"consecutive calls to one tool that form a drift pattern (default {DRIFT_THRESHOLD})")
    parser.add_argument("--drift-min-signatures", type=int, default=DRIFT_MIN_SIGNATURES, metavar="N",
                        help=f"distinct signatures a drift run needs (default {DRIFT_MIN_SIGNATURES})")
    parser.add_argument("--oscillation-min-repeats", type=int, default=OSCILLATION_MIN_REPEATS, metavar="N",
                        help=f"full back-to-back repeats of a cycle that form an oscillation (default {OSCILLATION_MIN_REPEATS})")
    parser.add_argument("--max-cycle-length", type=int, default=MAX_CYCLE_LENGTH, metavar="N",
                        help=f"longest cycle of tool names checked for oscillation (default {MAX_CYCLE_LENGTH})")
    parser.add_argument("--exhaustion-status", action="append", default=[], type=int, metavar="CODE",
                        help="extra HTTP status that counts as exhaustion (repeatable)")
    parser.add_argument("--exhaustion-phrase", action="append", default=[], metavar="TEXT",
                        help="extra lowercase phrase that counts as exhaustion when found in the error text (repeatable)")
    parser.add_argument("--error-field-status", action="append", default=[], metavar="NAME=CODE",
                        help="HTTP status for an error field value, used when the text has none (repeatable)")
    parser.add_argument("--json", action="store_true", help="JSON output instead of text")
    return parser


def main(argv):
    args = build_parser().parse_args(argv)
    if not args.transcript:
        return fail("no transcript given (use --transcript FILE)")
    for path in args.transcript:
        if not os.path.isfile(path):
            return fail(f"transcript file does not exist: {path}")
    for label, value in (("--from", args.date_from), ("--to", args.date_to)):
        if value and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return fail(f"{label} expects YYYY-MM-DD, got: {value}")
    if args.date_from and args.date_to and args.date_from > args.date_to:
        return fail("--from is after --to")
    mapping = parse_provider_map(args.provider_map)
    if mapping is None:
        return fail("--provider-map expects PREFIX=NAME with both sides filled")
    try:
        test_pattern = re.compile(args.test_pattern) if args.test_pattern else None
        advisor_pattern = re.compile(args.advisor_pattern) if args.advisor_pattern else None
    except re.error as error:
        return fail(f"bad regular expression: {error}")
    for label, value in (("--retry-threshold", args.retry_threshold), ("--drift-threshold", args.drift_threshold),
                         ("--drift-min-signatures", args.drift_min_signatures),
                         ("--oscillation-min-repeats", args.oscillation_min_repeats)):
        if value < 1:
            return fail(f"{label} expects a positive integer, got: {value}")
    if args.max_cycle_length < MIN_CYCLE_LENGTH:
        return fail(f"--max-cycle-length expects at least {MIN_CYCLE_LENGTH}, got: {args.max_cycle_length}")
    error_statuses = dict(ERROR_FIELD_STATUS)
    for entry in args.error_field_status:
        name, separator, code = entry.partition("=")
        if not separator or not name or not code.isdigit():
            return fail("--error-field-status expects NAME=CODE with a numeric code")
        error_statuses[name] = int(code)
    options = default_options()
    options.update({
        "statuses": EXHAUSTION_STATUSES + tuple(args.exhaustion_status),
        "phrases": EXHAUSTION_PHRASES + tuple(phrase.lower() for phrase in args.exhaustion_phrase),
        "error_statuses": error_statuses,
        "retry_threshold": args.retry_threshold,
        "drift_threshold": args.drift_threshold,
        "drift_min_signatures": args.drift_min_signatures,
        "oscillation_min_repeats": args.oscillation_min_repeats,
        "max_cycle_length": args.max_cycle_length,
    })
    tasks, skipped, no_date = collect_tasks(args, mapping, test_pattern, advisor_pattern, options)
    summary = summarise(tasks)
    cover = coverage(tasks, no_date)
    if args.json:
        output = {"tasks": tasks, "summary_by_provider": summary, "coverage": cover, "skipped": skipped}
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        print(text_output(tasks, summary, cover, skipped))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
