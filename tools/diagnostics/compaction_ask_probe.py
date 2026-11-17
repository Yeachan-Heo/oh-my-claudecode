#!/usr/bin/env python3
r"""Probe of the first and last human ask after a compaction.

Offline script: reads Claude Code session transcripts and the compaction journal, and counts the loss
rates of the first and last human ask (head_lost, ask_lost), empty calls after a compaction and natural
canaries. It never prints ask or state contents, only numbers, levels and identifiers.
Usage: python3 -I compaction_ask_probe.py [--projects <dir>] [--transcript <file>]...
    [--compact <file>] [--to <ISO-8601-UTC>] [--days <N>] [--details] [--json] [--out <file>]
Without --compact the journal is compaction.jsonl in $OMC_JEV_LOG_DIR, else in .omc/state/jev under the
current directory (run the tool from the project root). With OMC_STATE_DIR set, the Jev log directory has a
project identifier in its path: pass the file with --compact or set OMC_JEV_LOG_DIR.

RULE (written before the measurement; do not change after seeing the results):
- A unit = a compaction boundary (a system/compact_boundary row with a timestamp in the period
  [to - days, to]). A boundary with the same uuid in several files counts once, in the first file by
  sorted paths.
- A group = (compaction kind, thread kind): kind jev (a matched journal compact row with result jev),
  fallback (result fallback), host (no matched compact row); thread main or subagent. Matching (the
  pair rule with consumption): candidates are (boundary occurrence, compact row) pairs of the same
  session (the file's sessionId vs the row's session_id) and thread (a main file agent_id null, a
  subagent agent_id equal to the file name without "agent-" and ".jsonl"), |ts - timestamp| <= 600 s
  and result jev or fallback (another result is not a candidate). Pairs sort ascending by (distance,
  boundary key, file path, compact row number); a pair is taken when neither the boundary key nor the
  compact row is assigned yet (the row and the unit are consumed). The unit's group = the result of
  the assigned row; the unit's file = the occurrence's file. Without assignment: kind host, the
  unit's file = the first occurrence by ascending path. The boundary key = uuid or, as a fallback,
  "file:timestamp" (boundaries without a uuid). Groups are not merged (subagents have other windows).
- The state after a compaction = the user and assistant rows after the boundary until the first row of
  type "api-request" after it (excluded); when there is no api-request, the state is unavailable: the
  boundaries_without_api_request gap when the file ends, or the boundaries_next_before_request gap when
  the state ends at the next boundary.
  A row's text: message.content as text or a list of blocks: text is text, tool_result is its content
  (text or joined text blocks), tool_use is json.dumps(input, ensure_ascii=False); other blocks are
  skipped; attachment and system rows are skipped. The state text and the ask text join whitespace into
  single spaces.
- A human ask = a user row without isMeta true, without isCompactSummary true, without a toolUseResult
  field, whose content is a text or a list without a tool_result block; after joining the text blocks,
  removing <system-reminder>...</system-reminder> fragments and trimming, the text is non-empty and does
  not start with: <command-, <local-command, <task-notification, <cross-session,
  [Request interrupted, Caveat:, or the module's state marker.
- head = the file's first human ask, ask = the last ask before the boundary. A boundary without an ask
  before it is outside the head/ask denominator (the without_ask gap).
- The ask's survival level in the state text: full = the first 300 chars of the ask are a substring of
  the state text; trace = not full, but the first 40 chars are a substring; paraphrased = neither, but
  at least 80% of the distinct words (\w{4,}, lowercased) from the first 300 chars of the ask occur in
  the word set of the state text; lost = the rest. head_lost = the lost level of the first ask,
  ask_lost = the same for the last ask.
- Empty calls after a compaction: the first 5 new calls after the state (first occurrences of
  message.id that were not in the file before the boundary; the window runs from the state to the next
  boundary or the end of the file).
  An empty call = none of its rows has a text block with non-empty text or a tool_use block.
- Natural canaries: candidates are strings from tool_result texts in the last 300 rows before the
  boundary, matching the patterns: absolute path /[\w.@-]+(?:/[\w.@-]+)+, error code
  \b[A-Z]{1,6}-?\d{3,6}\b, hex identifier \b[0-9a-f]{12,}\b. Strings that occur before the boundary in
  assistant text (text blocks and inputs) or in human asks are rejected. A canary is a string that
  after the state (until the next boundary or the end of the file) appears in assistant text; at most
  20 per boundary (first in occurrence order). A kept canary = the string is a substring of the state
  text.
- The verdict for head_lost and ask_lost in each group: with n < 30 "insufficient data"; otherwise an
  upper Wilson 95% bound (z = 1.959963984540054) <= threshold gives "meets the ask-loss threshold",
  above gives "does not meet the ask-loss threshold". min_support = 30. The threshold is the
  --ask-loss-threshold argument (default 0.05).
- Journal compact-row gaps: compact_without_after (all compact rows without an after row whose
  compact_ts equals their ts, string comparison), after_without_compact (an after row with a compact_ts
  absent from the ts of compact rows), compact_without_boundary (a compact row with result jev or
  fallback in the period whose thread was read and which was not consumed in the pair assignment).
- Ask and state contents are never printed (neither to stdout nor to a file): only numbers, levels and
  identifiers.

Exit codes: 0 a valid run; 1 --out write refused (the file exists); 2 a usage error or a missing
--compact file.
"""

import argparse
import json
import math
import os
import re
import sys
from collections import deque
from datetime import datetime, timedelta, timezone

TEMPLATE = "compaction-report/1"
METRIC = "ask-probe"
SCRIPT_NAME = "compaction_ask_probe.py"
MIN_SUPPORT = 30
Z_95 = 1.959963984540054
MATCH_WINDOW_S = 600.0
FULL_PREFIX_LEN = 300
TRACE_PREFIX_LEN = 40
WORD_MATCH_RATIO = 0.80
MAX_CALLS = 5
MAX_CANARIES = 20
CANARY_WINDOW_LINES = 300
LEVELS = ("full", "trace", "paraphrased", "lost")
NON_ASK_PREFIXES = (
    "<command-",
    "<local-command",
    "<task-notification",
    "<cross-session",
    "[Request interrupted",
    "Caveat:",
    "[OMC: work state from before the compaction",
)
REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
WORD_RE = re.compile(r"\w{4,}")
CANARY_PATH = re.compile(r"/[\w.@-]+(?:/[\w.@-]+)+")
CANARY_CODE = re.compile(r"\b[A-Z]{1,6}-?\d{3,6}\b")
CANARY_HEX = re.compile(r"\b[0-9a-f]{12,}\b")
RULE = (
    "The state after a compaction = the user and assistant rows after the boundary (system/compact_boundary) until the first "
    "row of type api-request after it, excluded; when there is no api-request, the state is unavailable "
    "(the boundary is outside the level denominators; the gaps boundaries_without_api_request when the file ends, or "
    "boundaries_next_before_request when the state ends at the next boundary). A human ask = a user row without isMeta, without "
    "isCompactSummary, without a toolUseResult field, whose content is a text or a list without a tool_result block, which after "
    "joining the text blocks, removing <system-reminder>...</system-reminder> fragments and trimming is "
    "non-empty and does not start with <command-, <local-command, <task-notification, <cross-session, "
    "[Request interrupted, Caveat: or the module's state marker. head = the file's first ask, ask = the last ask before the "
    "boundary. The ask survival levels in the state text (both texts with whitespace joined into spaces): "
    "full = the first 300 chars of the ask are a substring of the state; trace = not full, but the first 40 chars are a substring; "
    "paraphrased = the rest, when at least 80% of the distinct words (\\w{4,}, lowercase) from the first 300 chars of the ask "
    "are in the word set of the state; lost = the rest. head_lost and ask_lost = the share of the lost level. "
    "Empty calls: the first 5 new calls after the state (message.id absent before the boundary, the window until "
    "the next boundary or the end of the file); an empty call = without a text block with non-empty text and without a "
    "tool_use block. Natural canaries: strings from tool_result in the last 300 rows before the boundary matching "
    "three patterns (path /[\\w.@-]+(?:/[\\w.@-]+)+, error code [A-Z]{1,6}-?\\d{3,6}, hex [0-9a-f]{12,}), "
    "rejected when they occur before the boundary in assistant text or asks; a canary is a string that "
    "after the state appears in assistant text (until the next boundary), at most 20 per boundary; kept = "
    "a substring of the state. Groups = (compaction kind jev/fallback/host, thread main/subagent), not merged; "
    "the kind comes from the pair assignment: candidates are (boundary occurrence, compact row) pairs of the same session "
    "and thread, within 600 s, with result jev or fallback; pairs sort ascending by (distance, "
    "boundary key, file path, compact row number) and a pair is taken when neither the key nor the row "
    "is consumed yet; without assignment the kind is host and the unit's file is the first by ascending path; "
    "the boundary key = uuid or, as a fallback, file:timestamp. The verdict "
    "for head_lost and ask_lost with n >= 30: an upper Wilson 95% bound (z = 1.959963984540054) <= the threshold gives "
    '"meets the ask-loss threshold", above "does not meet the ask-loss threshold"; with n < 30 "insufficient data" (min_support = 30).'
)
CAVEATS = [
    "The state source is the transcript rows after the compaction boundary until the first api-request, "
    "also for the host fallback; the host summary is not replayed.",
    "The paraphrased level approximates paraphrase by word agreement, not proof of preserving the ask's meaning.",
    "A text probe does not say whether the model used the state text.",
    "Canaries come only from three string patterns (paths, error codes, hex identifiers); "
    "facts outside those shapes are not measured.",
    "Empty calls are counted in the window from the state to the next boundary or the end of the file; "
    "the denominator of the share of compactions with an empty call includes only units for which at least "
    "one new call was collected after the state.",
    "Boundaries without a timestamp or with a timestamp outside the period are not units; matching to a compact "
    "row goes in pairs with consumption (result jev or fallback, distance up to 600 s, sort by distance, key, "
    "path and row number; the row and the key are consumed once).",
    "The state after a compaction ends at the next boundary when it arrives before the first request; such a "
    "unit has no state (the boundaries_next_before_request gap).",
]


def ts_epoch(text):
    """Seconds since the epoch from ISO 8601 (trailing Z or a zone); None when missing or bad."""
    if not isinstance(text, str) or not text:
        return None
    try:
        d = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.timestamp()


def normalize_ws(text):
    """Join whitespace into single spaces and trim the ends."""
    return re.sub(r"\s+", " ", text).strip()
def blocks(row):
    """The list of blocks from message.content; a string becomes one text block; missing: empty list."""
    msg = row.get("message")
    if not isinstance(msg, dict):
        return []
    content = msg.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}] if content else []
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


def tool_result_text(block):
    """The text of a tool_result block: a string or joined text blocks."""
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [str(b.get("text", "")) for b in content if isinstance(b, dict) and b.get("type") == "text"]
        return " ".join(c for c in parts if c)
    return ""


def row_texts(row):
    """(state text, {canaries: [texts], texts: [texts], inputs: [texts]}) for a user/assistant row.

    tool_result texts go to canaries; text blocks to texts; tool_use inputs to inputs."""
    to_state = []
    canaries = []
    texts = []
    inputs = []
    for b in blocks(row):
        kind = b.get("type")
        if kind == "text":
            t = str(b.get("text", ""))
            if t:
                to_state.append(t)
                texts.append(t)
        elif kind == "tool_result":
            t = tool_result_text(b)
            if t:
                to_state.append(t)
                canaries.append(t)
        elif kind == "tool_use":
            try:
                t = json.dumps(b.get("input", {}), ensure_ascii=False)
            except (TypeError, ValueError):
                t = str(b.get("input", ""))
            if t:
                to_state.append(t)
                inputs.append(t)
    return " ".join(to_state), {"canaries": canaries, "texts": texts, "inputs": inputs}
def is_ask(row):
    """A human ask: returns the normalized ask text or None."""
    if row.get("type") != "user":
        return None
    if row.get("isMeta") is True or row.get("isCompactSummary") is True:
        return None
    if "toolUseResult" in row:
        return None
    b = blocks(row)
    if any(x.get("type") == "tool_result" for x in b):
        return None
    text = " ".join(str(x.get("text", "")) for x in b if x.get("type") == "text")
    text = normalize_ws(REMINDER_RE.sub(" ", text))
    if not text or text.startswith(NON_ASK_PREFIXES):
        return None
    return text


def word_set(text):
    return set(WORD_RE.findall(text.lower()))


def ask_level(prefix300, state):
    """The ask's survival level in the state text: full, trace, paraphrased, lost."""
    if prefix300 and prefix300 in state:
        return "full"
    prefix40 = prefix300[:TRACE_PREFIX_LEN]
    if prefix40 and prefix40 in state:
        return "trace"
    words = word_set(prefix300)
    if words:
        state_words = word_set(state)
        hits = sum(1 for w in words if w in state_words)
        if hits / len(words) >= WORD_MATCH_RATIO:
            return "paraphrased"
    return "lost"
def close_boundary(bnd, window_new, via_next=False):
    """Close the boundary record after its window passes: state, canaries, calls."""
    if via_next and not bnd["has_api"]:
        bnd["end"] = "next_boundary"
    bnd["has_state"] = bool(bnd["has_api"])
    if bnd["has_state"]:
        bnd["state_text"] = normalize_ws(" ".join(bnd["state_texts"]))
        canaries = [k for k in bnd["candidates"] if k in bnd["window_matches"]][:MAX_CANARIES]
        bnd["canaries"] = canaries
        bnd["kept"] = sum(1 for k in canaries if bnd["state_text"] and k in bnd["state_text"])
        bnd["calls"] = [
            {"id": i, "model": d["model"], "empty": not (d["has_text"] or d["has_tool"])}
            for i, d in list(window_new.items())[:MAX_CALLS]
        ]
    else:
        bnd["state_text"] = None
        bnd["canaries"] = []
        bnd["kept"] = 0
        bnd["calls"] = []
    bnd.pop("state_texts", None)
    bnd.pop("window_matches", None)
    bnd.pop("window_new", None)
def walk_file(path):
    """One streaming pass over a JSONL file; (file state, list of boundary records).

    A boundary record: index, uuid, ts_text, ts, trigger, has_state, state_text, head300, ask300,
    canaries (list of strings), kept (number), calls (list of {id, model, empty})."""
    session_id = None
    rows = 0
    bad_lines = 0
    boundaries = []
    current = None
    seen_before = set()
    seen_in_state = set()
    window_new = {}
    window_matches = set()
    canary_deque = deque(maxlen=CANARY_WINDOW_LINES)
    assistant_before = set()
    asks_before = set()
    first300 = None
    last300 = None

    def close_current(via_next=False):
        nonlocal current
        if current is not None:
            close_boundary(current, window_new, via_next)
            boundaries.append(current)
            return 1
        return 0
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                rows += 1
                try:
                    row = json.loads(line)
                except ValueError:
                    bad_lines += 1
                    canary_deque.append([])
                    continue
                if not isinstance(row, dict):
                    bad_lines += 1
                    canary_deque.append([])
                    continue
                row_type = row.get("type")
                if session_id is None and isinstance(row.get("sessionId"), str) and row.get("sessionId"):
                    session_id = row["sessionId"]
                if row_type == "system" and row.get("subtype") == "compact_boundary":
                    close_current(via_next=True)
                    # The calls of the window that just closed (and of its state phase) are prior calls now:
                    # take their ids before window_new is replaced with the new boundary's empty dictionary.
                    seen_before.update(seen_in_state)
                    seen_before.update(window_new.keys())
                    meta = row.get("compactMetadata")
                    ts = ts_epoch(row.get("timestamp"))
                    current = {
                        "index": rows,
                        "uuid": row.get("uuid"),
                        "ts_text": row.get("timestamp"),
                        "ts": ts,
                        "trigger": meta.get("trigger") if isinstance(meta, dict) else None,
                        "has_api": False,
                        "state_texts": [],
                        "candidates": [],
                        "window_matches": set(),
                        "window_new": {},
                        "head300": first300,
                        "ask300": last300,
                        "end": "end_of_file",
                    }
                    window_new = current["window_new"]
                    window_matches = current["window_matches"]
                    seen_in_state = set()
                    seen = set()
                    for lst in canary_deque:
                        for m in lst:
                            if m not in seen:
                                seen.add(m)
                                if m not in assistant_before and m not in asks_before:
                                    current["candidates"].append(m)
                    canary_deque.append([])
                    continue
                if row_type in ("user", "assistant"):
                    text, split = row_texts(row)
                    t = is_ask(row)
                    if t is not None:
                        if first300 is None:
                            first300 = t[:FULL_PREFIX_LEN]
                        last300 = t[:FULL_PREFIX_LEN]
                        asks_before.update(CANARY_PATH.findall(t))
                        asks_before.update(CANARY_CODE.findall(t))
                        asks_before.update(CANARY_HEX.findall(t))
                        canary_deque.append([])
                    elif row_type == "user" and split["canaries"]:
                        matches = []
                        for tr in split["canaries"]:
                            matches.extend(CANARY_PATH.findall(tr))
                            matches.extend(CANARY_CODE.findall(tr))
                            matches.extend(CANARY_HEX.findall(tr))
                        canary_deque.append(matches)
                    else:
                        canary_deque.append([])
                    if current is not None and not current["has_api"]:
                        current["state_texts"].append(text)
                    msg = row.get("message")
                    mid = msg.get("id") if isinstance(msg, dict) else None
                    if isinstance(mid, str) and mid:
                        if current is None:
                            seen_before.add(mid)
                        elif not current["has_api"]:
                            seen_in_state.add(mid)
                        else:
                            if mid in window_new:
                                rec = window_new[mid]
                                if not rec["has_text"] and split["texts"]:
                                    rec["has_text"] = True
                                if not rec["has_tool"] and split["inputs"]:
                                    rec["has_tool"] = True
                            elif mid not in seen_before and mid not in seen_in_state:
                                if len(window_new) < MAX_CALLS:
                                    window_new[mid] = {
                                        "model": msg.get("model") if isinstance(msg, dict) else None,
                                        "has_text": bool(split["texts"]),
                                        "has_tool": bool(split["inputs"]),
                                    }
                    if row_type == "assistant":
                        for t2 in split["texts"] + split["inputs"]:
                            for pattern in (CANARY_PATH, CANARY_CODE, CANARY_HEX):
                                for m in pattern.findall(t2):
                                    assistant_before.add(m)
                                    if current is not None and current["has_api"]:
                                        window_matches.add(m)
                    continue
                if row_type == "api-request":
                    canary_deque.append([])
                    if current is not None and not current["has_api"]:
                        current["has_api"] = True
                        current["end"] = "api_request"
                    continue
                canary_deque.append([])
    finally:
        close_current()
    return {
        "sessionId": session_id,
        "rows": rows,
        "bad_lines": bad_lines,
        "first300": first300,
        "last300": last300,
        "boundaries": boundaries,
    }, None


def walk_file_safe(path):
    """A wrapper with an open-error handler; (state or None, message)."""
    try:
        return walk_file(path)
    except OSError as e:
        return None, f"read error: {e}"
def read_journal(path, from_e, to_e):
    """The compaction journal: (data, error message). Gaps per the docstring rule."""
    if not os.path.isfile(path):
        return None, f"missing file {path}"
    compacts = []
    afters = []
    rows = 0
    bad_lines = 0
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                rows += 1
                try:
                    row = json.loads(line)
                except ValueError:
                    bad_lines += 1
                    continue
                if not isinstance(row, dict):
                    bad_lines += 1
                    continue
                ev = row.get("event")
                if ev == "compact":
                    row["_line"] = rows
                    compacts.append(row)
                elif ev == "after":
                    afters.append(row)
    except OSError as e:
        return None, f"read error {path}: {e}"
    all_ts = {c.get("ts") for c in compacts}
    after_without_compact = sum(1 for a in afters if a.get("compact_ts") not in all_ts)
    compact_without_after = sum(
        1 for c in compacts if c.get("ts") not in {a.get("compact_ts") for a in afters}
    )
    data = {
        "rows": rows,
        "bad_lines": bad_lines,
        "compacts_all": compacts,
        "compacts_in_period": [c for c in compacts if (lambda t: t is not None and from_e <= t <= to_e)(ts_epoch(c.get("ts")))],
        "compact_without_after": compact_without_after,
        "after_without_compact": after_without_compact,
    }
    return data, None


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
def assign_units(occurrences, compacts):
    """Assignment of boundaries (by uuid or file:timestamp key) to compact rows in pairs.

    Pairs (occurrence, compact row) of the same session_id and agent_id as the occurrence's thread,
    |ts - timestamp| <= 600 s, result jev or fallback; sort ascending by (distance, key, file path,
    compact row number); a pair is taken when neither key nor row is assigned yet (the row and the
    unit are consumed). Without assignment: host, the unit's file = the first by path.
    Returns (list of units, boundaries_duplicated_from_copies gap, set of consumed compact rows).
    """
    by_key = {}
    for g in occurrences:
        by_key.setdefault(g["key"], []).append(g)
    pairs = []
    for key, occs in by_key.items():
        for occ in occs:
            if occ["session"] is None:
                continue
            for c in compacts:
                if c.get("result") not in ("jev", "fallback"):
                    continue
                if c.get("session_id") != occ["session"]:
                    continue
                c_raw = c.get("agent_id")
                c_agent = None if c_raw in (None, "", "null") else str(c_raw).removeprefix("agent-")
                if c_agent != occ["agent_id"]:
                    continue
                ts_c = ts_epoch(c.get("ts"))
                if occ["ts"] is None or ts_c is None:
                    continue
                d = abs(ts_c - occ["ts"])
                if d <= MATCH_WINDOW_S:
                    pairs.append((d, key, str(occ["file"]), int(c.get("_line", 0)), occ, c))
    pairs.sort(key=lambda pair: (pair[0], pair[1], pair[2], pair[3]))
    used = set()
    units = {}
    for _d, key, _path_s, _nr, occ, c in pairs:
        if key in units or id(c) in used:
            continue
        used.add(id(c))
        units[key] = occ
        occ["result"] = str(c.get("result"))
        occ["compact_row"] = c
        occ["unit_file"] = occ["file"]
    for key, occs in by_key.items():
        if key in units:
            continue
        occ = min(occs, key=lambda o: str(o["file"]))
        units[key] = occ
        occ["result"] = "host"
        occ["compact_row"] = None
        occ["unit_file"] = occ["file"]
    dup_gap = sum(len(occs) - 1 for occs in by_key.values())
    unit_list = sorted(units.values(), key=lambda g: (g["ts"], str(g["file"]), g["key"]))
    return unit_list, dup_gap, used
def main_analysis(files, journal_data, from_e, to_e):
    """Boundary occurrences in the period, pair-rule assignment, levels; the analysis dict."""
    read_threads = {}
    occurrences = []
    no_ts_gap = 0
    total_rows = 0
    total_bad = 0
    for path, role, agent_id in files:
        state, message = walk_file_safe(path)
        if message is not None:
            print(f"warning: skipping file {path}: {message}", file=sys.stderr)
            continue
        total_rows += state["rows"]
        total_bad += state["bad_lines"]
        sessionId = state["sessionId"]
        if sessionId:
            read_threads[(sessionId, agent_id)] = True
        for bnd in state["boundaries"]:
            bnd["file"] = path
            bnd["role"] = role
            bnd["agent_id"] = agent_id
            bnd["session"] = sessionId
            bnd["key"] = bnd["uuid"] if bnd["uuid"] else f"{path}:{bnd['ts_text']}"
            if bnd["ts"] is None:
                no_ts_gap += 1
                continue
            if not (from_e <= bnd["ts"] <= to_e):
                continue
            occurrences.append(bnd)
    units, dup_gap, used = assign_units(occurrences, journal_data["compacts_all"])
    for bnd in units:
        thread = "subagent" if bnd["role"] == "subagent" else "main"
        bnd["group"] = f"{bnd['result']}/{thread}"
        bnd["head_level"] = ask_level(bnd["head300"], bnd["state_text"]) if (bnd["has_state"] and bnd["head300"]) else (None if not bnd["has_state"] else "no ask")
        bnd["ask_level"] = ask_level(bnd["ask300"], bnd["state_text"]) if (bnd["has_state"] and bnd["ask300"]) else (None if not bnd["has_state"] else "no ask")
    return {
        "units": units,
        "dup_gap": dup_gap,
        "no_ts_gap": no_ts_gap,
        "total_rows": total_rows,
        "total_bad": total_bad,
        "read_threads": read_threads,
        "used_rows": used,
    }
def wilson(count, total, z=Z_95):
    """(lower, upper) Wilson bounds; total <= 0: (None, None); count = 0: lower = 0.0."""
    if not total or total <= 0:
        return None, None
    p = count / total
    z2 = z * z
    denom = 1 + z2 / total
    center = (p + z2 / (2 * total)) / denom
    radius = z * math.sqrt(p * (1 - p) / total + z2 / (4 * total * total)) / denom
    return max(0.0, center - radius), min(1.0, center + radius)


def round4(x, places=4):
    return None if x is None else round(x, places)


def counts(values):
    d = {}
    for x in values:
        d[x] = d.get(x, 0) + 1
    return d


def build_report(units, quality, generated_at, from_dt, to_dt, threshold):
    """The report per the compaction-report/1 template plus the ask-probe's own fields."""
    groups = {}
    for bnd in units:
        groups.setdefault(bnd["group"], []).append(bnd)
    results = []
    verdicts = {}
    levels = {}
    for name in sorted(groups):
        unit_list = groups[name]
        with_state = [g for g in unit_list if g["has_state"]]
        head_n = [g for g in with_state if g["head_level"] in LEVELS]
        ask_n = [g for g in with_state if g["ask_level"] in LEVELS]
        head_lost = sum(1 for g in head_n if g["head_level"] == "lost")
        ask_lost = sum(1 for g in ask_n if g["ask_level"] == "lost")
        head_trace = sum(1 for g in head_n if g["head_level"] in ("lost", "trace"))
        ask_trace = sum(1 for g in ask_n if g["ask_level"] in ("lost", "trace"))
        calls = [(g, w) for g in with_state for w in g["calls"]]
        empty = sum(1 for _g, w in calls if w["empty"])
        with_empty = sum(1 for g in with_state if g["calls"] and any(w["empty"] for w in g["calls"]))
        with_calls = [g for g in with_state if g["calls"]]
        canary_n = sum(len(g["canaries"]) for g in with_state)
        canary_lost = sum(len(g["canaries"]) - g["kept"] for g in with_state)

        def add_row(label, count, total):
            low, _high = wilson(count, total)
            if total < MIN_SUPPORT:
                share = "insufficient data"
                lower = "insufficient data"
            else:
                share = round(count / total, 4)
                lower = round(low, 4)
            results.append({"name": label, "numerator": count, "denominator": total, "share": share, "wilson_lower_95": lower})

        add_row(f"{name}: head_lost", head_lost, len(head_n))
        add_row(f"{name}: ask_lost", ask_lost, len(ask_n))
        add_row(f"{name}: first ask lost or trace only", head_trace, len(head_n))
        add_row(f"{name}: last ask lost or trace only", ask_trace, len(ask_n))
        add_row(f"{name}: empty calls in the 5 after compaction", empty, len(calls))
        add_row(f"{name}: compactions with an empty call", with_empty, len(with_calls))
        add_row(f"{name}: canaries lost", canary_lost, canary_n)

        def verdict(total_n, count_k):
            if total_n < MIN_SUPPORT:
                return "insufficient data"
            _low, high = wilson(count_k, total_n)
            return "meets the ask-loss threshold" if high <= threshold else "does not meet the ask-loss threshold"

        verdicts[name] = {
            "head_lost": verdict(len(head_n), head_lost),
            "ask_lost": verdict(len(ask_n), ask_lost),
            "head_upper_bound": round4(wilson(head_lost, len(head_n))[1]),
            "ask_upper_bound": round4(wilson(ask_lost, len(ask_n))[1]),
        }
        spread = {"head": {p: 0 for p in LEVELS}, "ask": {p: 0 for p in LEVELS}}
        for g in head_n:
            spread["head"][g["head_level"]] += 1
        for g in ask_n:
            spread["ask"][g["ask_level"]] += 1
        levels[name] = spread
    first_models = [g["calls"][0]["model"] for g in units if g["has_state"] and g["calls"]]
    model = counts(sorted(first_models)) if first_models else "unavailable"
    triggers = [g["trigger"] if g["trigger"] else "none" for g in units]
    trigger = counts(sorted(triggers)) if triggers else "unavailable"
    journal_triggers = [
        (g["compact_row"].get("trigger") or "none") if isinstance(g["compact_row"], dict) else "none"
        for g in units
        if g["compact_row"] is not None
    ]
    journal_trigger = counts(sorted(journal_triggers)) if journal_triggers else "unavailable"
    host_n = len(groups.get("host/main", []))
    control_arm = {"description": "host compactions without the module (a boundary without a compact row), main thread", "n": host_n}
    period = {
        "from": from_dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "to": to_dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if units:
        ts_values = [g["ts"] for g in units]
        data_range = {
            "from": datetime.fromtimestamp(min(ts_values), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "to": datetime.fromtimestamp(max(ts_values), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
    else:
        data_range = "unavailable"
    if not units:
        results.append({"name": "compactions in period", "numerator": 0, "denominator": 0, "share": "insufficient data", "wilson_lower_95": "insufficient data"})
    report = {
        "template": TEMPLATE,
        "metric": METRIC,
        "script": SCRIPT_NAME,
        "generated_at": generated_at,
        "rule": RULE,
        "period": period,
        "data_range": data_range,
        "n": {"unit": "compaction (a boundary in the transcript)", "value": len(units)},
        "model": model,
        "trigger": trigger,
        "journal_trigger": journal_trigger,
        "control_arm": control_arm,
        "data_quality": quality,
        "results": results,
        "min_support": MIN_SUPPORT,
        "caveats": CAVEATS,
        "ask_loss_threshold": threshold,
    }
    return report, groups, verdicts, levels
def unit_details(units):
    return [
        {
            "file": g["file"],
            "uuid": g["key"],
            "timestamp": g["ts_text"],
            "group": g["group"],
            "head_level": g["head_level"] if g["head_level"] in LEVELS else ("unavailable" if not g["has_state"] else "no ask"),
            "ask_level": g["ask_level"] if g["ask_level"] in LEVELS else ("unavailable" if not g["has_state"] else "no ask"),
            "canaries": len(g["canaries"]),
            "kept": g["kept"],
            "empty_calls": sum(1 for w in g["calls"] if w["empty"]),
            "calls_count": len(g["calls"]),
        }
        for g in units
    ]


def text_report(report, verdicts):
    lines = [
        f"compaction_ask_probe: metric {METRIC}, period {report['period'].get('from')} to {report['period'].get('to')}",
        f"units n = {report['n']['value']}",
    ]
    for w in report["results"]:
        lines.append(f"  {w['name']}: {w['numerator']}/{w['denominator']}, share {w['share']}, wilson_lower {w['wilson_lower_95']}")
    for g in sorted(verdicts):
        v = verdicts[g]
        lines.append(f"  verdict {g}: head_lost {v['head_lost']}, ask_lost {v['ask_lost']}, upper bounds {v['head_upper_bound']} / {v['ask_upper_bound']}")
    return "\n".join(lines)
def find_transcripts(projects):
    """Transcripts: main <projects>/<dir>/<id>.jsonl and subagent <projects>/<dir>/<id>/subagents/agent-*.jsonl."""
    files = []
    if not os.path.isdir(projects):
        return files
    for entry in sorted(os.listdir(projects)):
        dir_path = os.path.join(projects, entry)
        if not os.path.isdir(dir_path) or entry.startswith("."):
            continue
        for name in sorted(os.listdir(dir_path)):
            if name.endswith(".jsonl") and os.path.isfile(os.path.join(dir_path, name)):
                files.append((os.path.join(dir_path, name), "main", None))
        for sub_entry in sorted(os.listdir(dir_path)):
            sub = os.path.join(dir_path, sub_entry, "subagents")
            if os.path.isdir(sub):
                for name in sorted(os.listdir(sub)):
                    if name.startswith("agent-") and name.endswith(".jsonl"):
                        files.append((os.path.join(sub, name), "subagent", name[6:-6]))
    return files


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="ask-probe: the first and last human ask after a compaction.", allow_abbrev=False)
    parser.add_argument("--projects", default=default_projects_dir(), help="the projects directory with transcripts")
    parser.add_argument("--transcript", action="append", default=None, help="a transcript file (repeatable; instead of scanning)")
    parser.add_argument("--compact", default=default_compact_path(), help="the compaction journal (default: compaction.jsonl in $OMC_JEV_LOG_DIR, else in .omc/state/jev under the current directory; with OMC_STATE_DIR set, pass the file or set OMC_JEV_LOG_DIR)")
    parser.add_argument("--to", default=None, help="period end, ISO 8601 UTC (defaults to now)")
    parser.add_argument("--days", type=int, default=7, help="period length in days (default 7)")
    parser.add_argument("--ask-loss-threshold", type=float, default=0.05, help="the ask-loss Wilson bound threshold (default 0.05)")
    parser.add_argument("--details", action="store_true", help="add the unit list (without ask contents)")
    parser.add_argument("--json", action="store_true", help="the result as one JSON object")
    parser.add_argument("--out", default=None, help="write to a new file (mode x, 0600; existing: exit 1)")
    args = parser.parse_args(argv)
    if args.days < 0:
        print("error: --days must not be negative", file=sys.stderr)
        return 2
    try:
        to_dt = datetime.now(timezone.utc) if args.to is None else datetime.fromisoformat(args.to.replace("Z", "+00:00"))
    except ValueError:
        print("error: --to is not ISO 8601", file=sys.stderr)
        return 2
    if to_dt.tzinfo is None:
        to_dt = to_dt.replace(tzinfo=timezone.utc)
    from_dt = to_dt - timedelta(days=args.days)
    from_e = from_dt.timestamp()
    to_e = to_dt.timestamp()
    journal_data, message = read_journal(args.compact, from_e, to_e)
    if message is not None:
        print(f"error: {message}", file=sys.stderr)
        return 2
    if args.transcript:
        files = []
        for p in args.transcript:
            parts = p.replace(os.sep, "/").split("/")
            base = os.path.basename(p)
            if "subagents" in parts and base.startswith("agent-") and base.endswith(".jsonl"):
                files.append((p, "subagent", base[6:-6]))
            else:
                files.append((p, "main", None))
    else:
        files = find_transcripts(args.projects)
    files.sort(key=lambda x: x[0])
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    analysis = main_analysis(files, journal_data, from_e, to_e)
    units = analysis["units"]
    compact_without_boundary = 0
    for c in journal_data["compacts_all"]:
        if c.get("result") not in ("jev", "fallback"):
            continue
        t_c = ts_epoch(c.get("ts"))
        if t_c is None or not (from_e <= t_c <= to_e):
            continue
        key = (c.get("session_id"), c.get("agent_id"))
        if key not in analysis["read_threads"]:
            continue
        if id(c) not in analysis["used_rows"]:
            compact_without_boundary += 1
    quality = [
        {
            "source": args.compact,
            "rows": journal_data["rows"],
            "bad_lines": journal_data["bad_lines"],
            "gaps": {
                "compact_without_after": journal_data["compact_without_after"],
                "after_without_compact": journal_data["after_without_compact"],
                "compact_without_boundary": compact_without_boundary,
            },
        },
        {
            "source": "files from the --transcript option" if args.transcript else f"{args.projects}/*/<id>.jsonl and <id>/subagents/agent-*.jsonl",
            "rows": analysis["total_rows"],
            "bad_lines": analysis["total_bad"],
            "gaps": {
                "boundaries_without_api_request": sum(1 for g in units if not g["has_state"] and g["end"] == "end_of_file"),
                "boundaries_next_before_request": sum(1 for g in units if not g["has_state"] and g["end"] == "next_boundary"),
                "without_ask": sum(1 for g in units if g["has_state"] and (g["head_level"] == "no ask" or g["ask_level"] == "no ask")),
                "boundaries_duplicated_from_copies": analysis["dup_gap"],
                "boundaries_without_timestamp": analysis["no_ts_gap"],
            },
        },
    ]
    report, groups, verdicts, levels = build_report(units, quality, generated_at, from_dt, to_dt, args.ask_loss_threshold)
    report["verdicts"] = verdicts
    report["levels"] = levels
    if args.details:
        report["units"] = unit_details(units)
    json_text = json.dumps(report, ensure_ascii=False, indent=2)
    plain_text = text_report(report, verdicts)
    if args.out:
        try:
            fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as out_file:
                out_file.write(json_text + "\n")
        except FileExistsError:
            print(f"error: --out: the file {args.out} exists, write refused", file=sys.stderr)
            return 1
        except OSError as e:
            print(f"error: --out: {e}", file=sys.stderr)
            return 1
        else:
            print(f"result saved: {args.out}", file=sys.stderr)
            return 0
    print(json_text if args.json else plain_text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
