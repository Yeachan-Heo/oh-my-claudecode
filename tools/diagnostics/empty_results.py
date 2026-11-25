#!/usr/bin/env python3
"""Empty agent-task result measurement on transcripts and team task files (offline diagnostic).

Counts how many finished agent tasks returned no result at all. This script blocks nothing
and changes nothing; it only counts, on inputs given entirely as arguments.

Two parts and their criteria:

  Part "transcripts" (agent calls in Claude Code transcripts). An agent call = a tool_use
  block with the name Agent or Task in an assistant message; its result = the tool_result
  with the same tool_use_id. Calls are read from the main sessions
  <dir>/<project>/<session>.jsonl and from subagent transcripts
  <dir>/<project>/<session>/subagents/agent-*.jsonl (also subagents/<child>/): a subagent
  can issue its own Agent calls, and a call from a subagent transcript pairs with its own
  subagents the same way (metadata by toolUseId, two subagents levels). The subagent
  transcript is agent-<id>.jsonl next to agent-<id>.meta.json (the toolUseId field links
  it to the call). An agent is EMPTY when its transcript has no assistant message with a
  non-empty text block (after strip), or when the tool_result of the call has empty text.
  A session with only the initial prompt is not a success. Checking order: the last
  assistant message first, then the older ones (scan from the last row toward older).
  Subtotals: missing_transcript (a call without a subagent file and without a
  tool_result: outside the denominator, counted separately), prompt_only (a transcript
  without an assistant message with text and without tool calls: only the initial
  prompt), empty_tool_result, tool_use_only (the assistant called tools but gave no text).
  Denominator: Agent calls in the range with a transcript or a tool_result. A call
  without a transcript but with a non-empty tool_result stays in the denominator and is
  non-empty (measured only by the tool_result); without a transcript and with an empty
  tool_result it is empty (empty_tool_result). The --from/--to filter applies to the
  timestamp of the call row (timestamp field, fallback ts); the tool_result is collected
  without the filter (it belongs to the already-filtered call); rows without a readable
  timestamp are skipped and counted separately (bad_ts).

  Stop measure: a call with missing answer text (tool_use_only, prompt_only,
  empty_tool_result) that was STOPPED FROM OUTSIDE does not count as an empty result; it
  enters the separate stopped_without_report measure (same denominator, Wilson interval and threshold status as
  for the empty results). Stop traces are looked up in the transcript of the parent (the
  file with the call) and in the subagent transcript:
  - the tool_result of the call is the background-agent launch message: the text starts
    with "Async agent launched successfully" and contains agentId: <id>;
  - the parent calls TaskStop with that id (input fields task_id or shell_id, both checked);
  - a user message of the parent contains <task-notification> with that <task-id> and
    <status>killed</status> (often with "was stopped" text);
  - the subagent transcript ends with a user message whose text starts with
    "[Request interrupted by user" (user interruption).
  Source precedence: parent_taskstop > interrupt > killed_other; the stop_evidence column
  lists all found traces, repeats collapsed with a counter (parent_taskstop x2), in the
  order of first appearance. A stopped call does NOT enter the empty count. Limit of the
  measure: a call without a subagent transcript is never recognized as stopped (even when
  the parent has a TaskStop), because there is no agentId from the launch message and no
  transcript to check for interruption; such a call counts by the empty classification.

  Intent of the stops (intentional vs other) is not measured automatically, for manual
  reading: the intent column in the TSV is empty by default; the option --intent <TSV>
  loads a filled file (columns id, intent; values intentional/other) and then the report
  gives k/n of both classes.

  Part "team" (team task files). Files <teams dir>/<team>/tasks/task-<n>.json or the
  older <n>.json; task object: id, subject, status (pending, blocked, in_progress,
  completed, failed), result?, error?, owner?, created_at, completed_at?. A task is EMPTY:
  status completed with result missing, not a string, or empty after strip. Denominator:
  all finished tasks (completed and failed) in the range, by completed_at, or by
  created_at without it; a task without any readable timestamp is skipped and counted
  separately (bad_ts). Separately: the number of failed tasks with an error field
  (non-empty after strip) and without. Bad JSON: skipped and counted (bad_json). Both
  file name variants (task-N.json and N.json) are read, and a repeated number counts once
  (the canonical task-N.json wins, like in the team state loader).

Principle "unmeasured is not zero": a part without its input is reported as "unmeasured",
never 0; a call without a transcript and without a tool_result (missing_transcript) and a
task without a readable timestamp stay outside the denominator and are counted
separately. n = 0: the rate has no value (null), not 0.

At every rate: k/n, two-sided 95 percent Wilson interval (z = 1.96) and one-sided 95
percent lower bound (z = 1.645); n < --min-support gives "no threshold (too little
data)", not a comparison number. min-support defaults to 30.

The empty-result sum at the end: transcripts = X, team = Y; X and Y are the empty counts
of the parts, and an unmeasured part prints "unmeasured". Numbers only: nothing is
blocked and no enforcement is built from this measurement.

Outputs: text report to stdout; --tsv: one row per detected empty result (columns: part,
kind, context, id, ts, stop_source, stop_evidence, intent; for non-stopped calls the
three stop columns are empty; a stopped call has a row with a non-empty stop_source, and
kind stays the empty classification it would have without the stop measure); --json: the
full result. NO prompt, result or subject content in any output: only numbers,
identifiers and timestamps.

Exit codes: 0 normal run (also with no data or everything unmeasured), 2 argument or
input error (no input at all, a missing path, a bad range, negative min-support, an
--intent file that does not exist or lacks the id/intent columns, a TSV/JSON write error).
"""
import argparse
import glob
import json
import math
import os
import re
import sys
from datetime import datetime, timezone


SCRIPT_NAME = 'empty_results.py'
USAGE = (
    f'usage: {SCRIPT_NAME} [--transcripts <dir>] [--teams <teams dir>] '
    '[--from <ISO>] [--to <ISO>] [--min-support 30] [--intent <TSV>] [--tsv <file>] [--json <file>]'
)

TSV_COLUMNS = ['part', 'kind', 'context', 'id', 'ts', 'stop_source', 'stop_evidence', 'intent']

# Prefix of the background-agent launch message in the tool_result of an Agent/Task call;
# the agent id sits behind agentId: (TaskStop traces and task notifications link by it).
# The pattern takes everything up to whitespace and trims a trailing sentence punctuation
# mark (period, colon, semicolon, comma) so the id compares equal to the TaskStop input.
LAUNCH_PREFIX = 'Async agent launched successfully'
AGENT_ID_RE = re.compile(r'agentId:\s*(\S+)')

ID_END_CHARS = '.:;,'

# Prefix of the last message of an interrupted subagent (user interruption).
INTERRUPT_PREFIX = '[Request interrupted by user'

STOP_SOURCES = ('parent_taskstop', 'interrupt', 'killed_other')

STOP_EVIDENCE = {'taskstop': 'parent_taskstop',
                 'interrupt': 'subagent_interrupt',
                 'killed': 'killed_notification'}

INTENT_VALUES = ('intentional', 'other')

NOTIFICATION_RE = re.compile(r'<task-notification>(.*?)</task-notification>', re.S)
TASK_ID_RE = re.compile(r'<task-id>(.*?)</task-id>')
STATUS_RE = re.compile(r'<status>(.*?)</status>')


def usage_error(message):
    print(message, file=sys.stderr)
    print(USAGE, file=sys.stderr)
    sys.exit(2)


def parse_ts(text):
    if not isinstance(text, str) or not text:
        return None
    try:
        d = datetime.fromisoformat(text.replace('Z', '+00:00'))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d


def in_range(ts, rng):
    o, d = rng
    if o and ts < o:
        return False
    if d and ts > d:
        return False
    return True


def wilson(k, n, z):
    """Wilson interval for the ratio k/n; n = 0 gives None (no value, not 0)."""
    if n == 0:
        return None
    p = k / n
    denominator = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denominator
    half_width = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    return max(0.0, centre - half_width), min(1.0, centre + half_width)


def describe_rate(k, n, min_support):
    """k/n, percent, Wilson intervals and the threshold status (denominator always given)."""
    if n == 0:
        return '0/0 = no value (n = 0, not 0); threshold: no threshold (too little data)'
    lower, upper = wilson(k, n, 1.96)
    lower1645 = wilson(k, n, 1.645)[0]
    threshold = ('no threshold (too little data), n < min-support'
                 if n < min_support else 'n at least min-support (measurement reliable for the threshold)')
    return (f'{k}/{n} = {100.0 * k / n:.1f}% (Wilson 95% two-sided: '
            f'[{lower:.4f}; {upper:.4f}], one-sided 95% lower: {lower1645:.4f}); '
            f'threshold: {threshold}')


def rate_data(k, n, min_support):
    """Rate dict for JSON: k, n, rate, Wilson intervals and the threshold; n = 0: null values."""
    threshold = ('no threshold (too little data)'
                 if n < min_support else 'n at least min-support (measurement reliable for the threshold)')
    return {
        'k': k,
        'n': n,
        'rate': (k / n) if n else None,
        'wilson_1_96': list(wilson(k, n, 1.96)) if n else None,
        'wilson_lower_1_645': wilson(k, n, 1.645)[0] if n else None,
        'threshold': threshold,
    }


def san(value):
    """Value for the TSV: tab and line ends replaced with a space (identifiers, not content)."""
    if value is None:
        return ''
    return str(value).replace('\t', ' ').replace('\n', ' ').replace('\r', ' ')


# ------------------------------------------------------------------ part transcripts

def content_text(content):
    """Text of a message content: a string, or text blocks joined by a space; none: empty string."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get('type') == 'text' and isinstance(b.get('text'), str):
                parts.append(b['text'])
        return ' '.join(parts)
    return ''


def tool_result_text(block):
    """Text of a tool_result block: content as a string or a list of text blocks; none: empty string."""
    c = block.get('content')
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        parts = []
        for b in c:
            if isinstance(b, dict) and b.get('type') == 'text' and isinstance(b.get('text'), str):
                parts.append(b['text'])
        return ' '.join(parts)
    return ''


def evidence_account(evidence, file_path):
    """Stop-evidence account for a file (session or subagent transcript)."""
    return evidence.setdefault(file_path, {'taskstops': [], 'notifications': []})


def scan_sessions(dir_path, rng):
    """Scan of the transcripts directory: <dir>/<project>/<session>.jsonl and subagent
    transcripts <dir>/<project>/<session>/subagents/(<child>/)agent-*.jsonl. Returns
    (calls, results, evidence, counters). A call: a tool_use Agent/Task block in an
    assistant message with a readable ts in the range; a result: the tool_result with the
    same tool_use_id (collected without the range filter, see the header). Stop evidence
    is collected per file (the parent transcript): TaskStop calls (input task_id or
    shell_id, with ts) and <task-notification> entries in user messages (task-id, status,
    ts). Rows with an Agent tool_use but without a readable ts: bad_ts counter, outside
    the denominator."""
    calls = []
    results = {}
    evidence = {}
    counters = {'sessions': 0, 'subagent_transcripts': 0, 'bad_ts': 0, 'duplicates': 0}
    seen_tids = set()
    # Main sessions and subagent transcripts as sources of Agent/Task calls: a subagent
    # can issue its own Agent calls; the timestamp field, fallback ts.
    files = [
        (sorted(glob.glob(os.path.join(dir_path, '*', '*.jsonl'))), 'sessions'),
        (sorted(glob.glob(os.path.join(dir_path, '*', '*', 'subagents', 'agent-*.jsonl'))), 'subagents'),
        (sorted(glob.glob(os.path.join(dir_path, '*', '*', 'subagents', '*', 'agent-*.jsonl'))), 'subagents'),
    ]
    for group, role in files:
        for path in group:
            if role == 'sessions':
                counters['sessions'] += 1
            else:
                counters['subagent_transcripts'] += 1
            rel = os.path.relpath(path, dir_path)
            account = evidence_account(evidence, rel)
            try:
                f = open(path, encoding='utf8', errors='replace')
            except OSError:
                continue
            with f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        x = json.loads(line)
                    except Exception:
                        continue
                    if not isinstance(x, dict):
                        continue
                    ts_raw = x.get('timestamp') or x.get('ts')
                    ts = parse_ts(ts_raw)
                    msg = x.get('message')
                    if not isinstance(msg, dict):
                        continue
                    content = msg.get('content')
                    row_type = x.get('type')
                    if row_type == 'assistant':
                        if not isinstance(content, list):
                            continue
                        for block in content:
                            if not (isinstance(block, dict) and block.get('type') == 'tool_use'):
                                continue
                            name = block.get('name')
                            tid = block.get('id')
                            if name in ('Agent', 'Task') and tid:
                                if ts is None:
                                    counters['bad_ts'] += 1
                                    continue
                                if not in_range(ts, rng):
                                    continue
                                if tid in seen_tids:
                                    counters['duplicates'] += 1
                                    continue
                                seen_tids.add(tid)
                                calls.append({'tid': tid, 'ts': ts_raw, 'session': rel})
                            elif name == 'TaskStop' and ts is not None:
                                inp = block.get('input')
                                ident = None
                                if isinstance(inp, dict):
                                    ident = inp.get('task_id') or inp.get('shell_id')
                                if ident:
                                    account['taskstops'].append((str(ident), ts, ts_raw))
                    elif row_type == 'user':
                        if isinstance(content, list):
                            for block in content:
                                if isinstance(block, dict) and block.get('type') == 'tool_result':
                                    tid = block.get('tool_use_id')
                                    if tid and tid not in results:
                                        results[tid] = tool_result_text(block)
                        text_w = content_text(content)
                        if '<task-notification>' in text_w and ts is not None:
                            for m in NOTIFICATION_RE.finditer(text_w):
                                inner = m.group(1)
                                t_id = TASK_ID_RE.search(inner)
                                st = STATUS_RE.search(inner)
                                if t_id and st:
                                    account['notifications'].append(
                                        (t_id.group(1).strip(), st.group(1).strip(), ts))
    for account in evidence.values():
        account['taskstops'].sort(key=lambda p: p[1])
        account['notifications'].sort(key=lambda p: p[2])
    return calls, results, evidence, counters


def meta_index(dir_path):
    """Index toolUseId -> (meta path, data) from agent-*.meta.json (two subagents levels);
    first match after sorting wins, a duplicate toolUseId is skipped."""
    index = {}
    for pattern in (os.path.join(dir_path, '*', '*', 'subagents', 'agent-*.meta.json'),
                    os.path.join(dir_path, '*', '*', 'subagents', '*', 'agent-*.meta.json')):
        for p in sorted(glob.glob(pattern)):
            try:
                with open(p, encoding='utf8') as f:
                    m = json.load(f)
            except Exception:
                continue
            if not isinstance(m, dict):
                continue
            tid = m.get('toolUseId')
            if tid and tid not in index:
                index[tid] = (p, m)
    return index


def scan_subagent(path):
    """Reads the subagent transcript from the last row toward older ones (checking order:
    the last assistant message first). Returns (has_text, has_tool_use, interrupted,
    interrupt_ts). has_text: an assistant message with a non-empty text block after strip;
    has_tool_use: the assistant called tools; interrupted: the transcript ends with a user
    message whose text starts with "[Request interrupted by user"; interrupt_ts is the
    timestamp of that row (None when unreadable)."""
    has_text = False
    has_tool_use = False
    interrupted = False
    interrupt_ts = None
    try:
        with open(path, encoding='utf8', errors='replace') as f:
            rows = f.readlines()
    except OSError:
        return False, False, False, None
    # The interruption is decided by the first readable row from the end (the transcript "ends with" it).
    for line in reversed(rows):
        if not line.strip():
            continue
        try:
            x = json.loads(line)
        except Exception:
            continue
        if not isinstance(x, dict) or x.get('type') not in ('user', 'assistant'):
            continue
        if x.get('type') == 'user':
            t = content_text((x.get('message') or {}).get('content')).lstrip()
            if t.startswith(INTERRUPT_PREFIX):
                interrupted = True
                interrupt_ts = parse_ts(x.get('timestamp') or x.get('ts'))
        break
    for line in reversed(rows):
        try:
            x = json.loads(line)
        except Exception:
            continue
        if not isinstance(x, dict) or x.get('type') != 'assistant':
            continue
        msg = x.get('message') or {}
        content = msg.get('content')
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get('type') == 'text' and isinstance(block.get('text'), str) and block['text'].strip():
                has_text = True
            if block.get('type') == 'tool_use':
                has_tool_use = True
    return has_text, has_tool_use, interrupted, interrupt_ts


def agent_id_from_launch(tr_text):
    """Agent id from the background-agent launch message (the tool_result of the call):
    None when the tool_result is not a launch message (prefix) or has no agentId.
    A trailing sentence punctuation mark is trimmed (ID_END_CHARS)."""
    if tr_text is None:
        return None
    if not tr_text.lstrip().startswith(LAUNCH_PREFIX):
        return None
    m = AGENT_ID_RE.search(tr_text)
    return m.group(1).rstrip(ID_END_CHARS) if m else None


def collapse_evidence(evidence_list):
    """Repeats collapsed with a counter (parent_taskstop x2), order of first appearance;
    single entries without a counter."""
    order = []
    counts = {}
    for s in evidence_list:
        if s not in counts:
            counts[s] = 0
            order.append(s)
        counts[s] += 1
    return '; '.join(f'{s} x{counts[s]}' if counts[s] > 1 else s for s in order)


def detect_stop(agent_id, interrupted, account):
    """Traces and source of the stop for an empty call: (source, evidence) or (None, []).
    Traces: a parent TaskStop by the agentId from the launch message, a killed
    <task-notification> by the agentId, the subagent interruption (last row "[Request
    interrupted by user"). Source precedence: parent_taskstop > interrupt > killed_other."""
    evidence = []
    if agent_id:
        for ident, _ts, _raw in account['taskstops']:
            if ident == agent_id:
                evidence.append(STOP_EVIDENCE['taskstop'])
        for ident, status, _ts in account['notifications']:
            if ident == agent_id and status == 'killed':
                evidence.append(STOP_EVIDENCE['killed'])
    if interrupted:
        evidence.append(STOP_EVIDENCE['interrupt'])
    if not evidence:
        return None, []
    if STOP_EVIDENCE['taskstop'] in evidence:
        source = 'parent_taskstop'
    elif interrupted:
        source = 'interrupt'
    else:
        source = 'killed_other'
    return source, evidence


def evaluate_agent(tid, meta_idx, tr_text, account):
    """Classification of an agent call: returns (location, empty, kind, stop), where
    location is 'denominator' or 'outside' (missing_transcript); stop = None or a dict
    {'source', 'evidence'} (for empty calls only: the stop measure)."""
    tr_path = None
    hit = meta_idx.get(tid)
    if hit is not None:
        candidate = hit[0][:-len('.meta.json')] + '.jsonl'
        if os.path.isfile(candidate):
            tr_path = candidate
    if tr_path is None:
        if tr_text is None:
            return 'outside', True, 'missing_transcript', None
        if tr_text.strip() == '':
            # Without a subagent transcript a stop is not recognizable (no agentId from
            # the launch message and no interruption trace from the transcript); a call
            # without a subagent transcript is never recognized as stopped: a limit of
            # the measure.
            return 'denominator', True, 'empty_tool_result', None
        return 'denominator', False, None, None
    has_text, has_tool_use, interrupted, _interrupt_ts = scan_subagent(tr_path)
    agent_id = agent_id_from_launch(tr_text)
    empty_tr = tr_text is not None and tr_text.strip() == ''
    if not has_text:
        # Checking order from the last assistant message (scan_subagent): none of them
        # gave text; kind by whether the assistant called tools.
        kind = 'tool_use_only' if has_tool_use else 'prompt_only'
        source, evidence = detect_stop(agent_id, interrupted, account)
        stop = None
        if source is not None:
            stop = {'source': source, 'evidence': evidence}
        return 'denominator', True, kind, stop
    if empty_tr:
        # The agent produced text but the tool_result is empty; the interruption of the
        # subagent is possible (the agentId of an empty tool_result is unknown, no
        # TaskStop/notification trace assigned); a stopped call does not count as empty.
        source, evidence = detect_stop(None, interrupted, account)
        stop = None
        if source is not None:
            stop = {'source': source, 'evidence': evidence}
        return 'denominator', True, 'empty_tool_result', stop
    return 'denominator', False, None, None


def read_intent(path):
    """A TSV file with the columns id and intent (values intentional/other), filled by
    hand after reading the stopped calls. Returns (map id -> value, counters) where
    counters = {bad_values, duplicate_ids}; a repeated id takes the first row (the second
    counts as a duplicate, without overwriting). Ids outside the stopped set (unknown_ids)
    are counted in the main run, because the stopped set is not known here yet. A missing
    file or missing id/intent columns: exit 2 (usage)."""
    try:
        with open(path, encoding='utf8', errors='replace') as f:
            rows = f.read().splitlines()
    except OSError as e:
        usage_error(f'--intent unreadable: {e}')
    if not rows:
        usage_error('--intent: empty file')
    header = rows[0].split('\t')
    missing = [c for c in ('id', 'intent') if c not in header]
    if missing:
        usage_error(f'--intent: missing columns: {", ".join(missing)}')
    i_id = header.index('id')
    i_intent = header.index('intent')
    mapping = {}
    counters = {'bad_values': 0, 'duplicate_ids': 0}
    for line in rows[1:]:
        if not line.strip():
            continue
        fields = line.split('\t')
        if len(fields) <= max(i_id, i_intent):
            continue
        value = fields[i_intent].strip()
        if value not in INTENT_VALUES:
            counters['bad_values'] += 1
            continue
        ident = fields[i_id].strip()
        if ident in mapping:
            counters['duplicate_ids'] += 1
            continue
        mapping[ident] = value
    return mapping, counters



def part_transcripts(dir_path, rng, min_support, intent_map=None):
    """Part transcripts: agent calls in Claude Code transcripts. Returns (result dict)."""
    calls, results, evidence, counters = scan_sessions(dir_path, rng)
    meta_idx = meta_index(dir_path)
    subtotals = {'prompt_only': 0, 'empty_tool_result': 0, 'tool_use_only': 0,
                 'non_empty': 0, 'missing_transcript': 0}
    stops_by_source = {s: 0 for s in STOP_SOURCES}
    rows = []
    n = 0
    k = 0
    kz = 0
    for w in calls:
        account = evidence.get(w['session']) or {'taskstops': [], 'notifications': []}
        location, empty, kind, stop = evaluate_agent(w['tid'], meta_idx, results.get(w['tid']), account)
        if location == 'outside':
            subtotals[kind] += 1
            continue
        n += 1
        if empty:
            if stop is not None:
                # Stopped from outside: NOT an empty result, enters stopped_without_report.
                kz += 1
                stops_by_source[stop['source']] += 1
                rows.append({
                    'part': 'transcripts',
                    'kind': kind,
                    'context': w['session'],
                    'id': w['tid'],
                    'ts': w['ts'],
                    'stop_source': stop['source'],
                    'stop_evidence': collapse_evidence(stop['evidence']),
                    'intent': (intent_map or {}).get(w['tid'], ''),
                })
            else:
                k += 1
                subtotals[kind] += 1
                rows.append({'part': 'transcripts', 'kind': kind, 'context': w['session'],
                             'id': w['tid'], 'ts': w['ts'],
                             'stop_source': '', 'stop_evidence': '', 'intent': ''})
        else:
            subtotals['non_empty'] += 1
    counters['calls_in_range'] = len(calls)
    result = {
        'measured': True,
        'denominator_note': 'Agent/Task calls in the range with a transcript or a tool_result',
        **rate_data(k, n, min_support),
        'subtotals': subtotals,
        'stopped_without_report': rate_data(kz, n, min_support),
        'stops_by_source': stops_by_source,
        'intent': {
            'description': 'intentional and other: not measured automatically, read by hand (intent column)',
            'file': None,
            'intentional': 0,
            'other': 0,
            'unclassified': kz,
            'bad_values': 0,
        },
        'counters': counters,
        'tsv_rows': rows,
    }
    return result


# ------------------------------------------------------------------ part team

def team_dirs(teams_path):
    """Team subdirectories in the teams directory; also a single-team directory with
    tasks/ directly. Returns (list of teams with tasks/, count of all team directories,
    also without tasks/)."""
    result = []
    if os.path.isdir(os.path.join(teams_path, 'tasks')):
        return [(os.path.basename(os.path.normpath(teams_path)), teams_path)], 1
    dir_count = 0
    for name in sorted(os.listdir(teams_path)):
        p = os.path.join(teams_path, name)
        if os.path.isdir(p):
            dir_count += 1
            if os.path.isdir(os.path.join(p, 'tasks')):
                result.append((name, p))
    return result, dir_count


def task_number(name):
    """Task number from a file name: task-<n>.json or <n>.json; other names: None."""
    base = os.path.basename(name)
    if base.startswith('task-') and base.endswith('.json'):
        return base[len('task-'):-len('.json')]
    if base.endswith('.json') and base[:-len('.json')].isdigit():
        return base[:-len('.json')]
    return None


def load_team_tasks(teams_path):
    """Task files of all teams. Returns (tasks, counters); a task: (team, file number,
    data or None on bad JSON). Deduplication by (team, number): the canonical task-N.json
    before N.json (priority as in the team state loader). Files with names outside the
    task-N.json / N.json patterns are skipped and counted separately (other_names)."""
    tasks = []
    counters = {'team_dir_count': 0, 'teams_with_tasks': 0, 'files': 0,
                'bad_json': 0, 'duplicate_files': 0, 'other_names': 0, 'bad_ts': 0}
    teams, dir_count = team_dirs(teams_path)
    counters['team_dir_count'] = dir_count
    counters['teams_with_tasks'] = len(teams)
    for team, team_path in teams:
        tasks_dir = os.path.join(team_path, 'tasks')
        all_files = sorted(glob.glob(os.path.join(tasks_dir, '*.json')))
        counters['files'] += len(all_files)
        counters['other_names'] += sum(1 for p in all_files if task_number(p) is None)
        files = sorted(glob.glob(os.path.join(tasks_dir, 'task-*.json'))) \
            + sorted(glob.glob(os.path.join(tasks_dir, '[0-9]*.json')))
        seen = set()
        for p in files:
            nr = task_number(p)
            if nr in seen:
                counters['duplicate_files'] += 1
                continue
            seen.add(nr)
            try:
                with open(p, encoding='utf8') as f:
                    data = json.load(f)
            except Exception:
                counters['bad_json'] += 1
                tasks.append((team, nr, None))
                continue
            if not isinstance(data, dict):
                counters['bad_json'] += 1
                tasks.append((team, nr, None))
                continue
            tasks.append((team, nr, data))
    return tasks, counters


def part_team(teams_path, rng, min_support):
    """Part team: team task files. Returns (result dict)."""
    tasks, counters = load_team_tasks(teams_path)
    subtotals = {'completed_with_result': 0, 'failed_with_error': 0, 'failed_without_error': 0,
                 'other_statuses': 0}
    rows = []
    n = 0
    k = 0
    outside_range = 0
    for team, nr, data in tasks:
        if data is None:
            continue  # bad JSON: skipped and counted
        status = data.get('status')
        if status not in ('completed', 'failed'):
            subtotals['other_statuses'] += 1
            continue
        ts = parse_ts(data.get('completed_at')) or parse_ts(data.get('created_at'))
        if ts is None:
            counters['bad_ts'] += 1
            continue
        if not in_range(ts, rng):
            outside_range += 1
            continue
        n += 1
        if status == 'failed':
            error = data.get('error')
            if isinstance(error, str) and error.strip():
                subtotals['failed_with_error'] += 1
            else:
                subtotals['failed_without_error'] += 1
            continue
        result_field = data.get('result')
        empty = not (isinstance(result_field, str) and result_field.strip())
        if empty:
            k += 1
            rows.append({'part': 'team', 'kind': 'empty_result',
                         'context': team, 'id': data.get('id') or nr,
                         'ts': data.get('completed_at') or data.get('created_at')})
        else:
            subtotals['completed_with_result'] += 1
    result = {
        'measured': True,
        'denominator_note': 'finished tasks (completed and failed) in the range',
        **rate_data(k, n, min_support),
        'subtotals': subtotals,
        'counters': {**counters, 'outside_range': outside_range},
        'tsv_rows': rows,
    }
    return result


# ------------------------------------------------------------------ report and outputs

def write_tsv(path, rows):
    with open(path, 'w', encoding='utf8') as f:
        f.write('\t'.join(TSV_COLUMNS) + '\n')
        for w in rows:
            f.write('\t'.join(san(w.get(col)) for col in TSV_COLUMNS) + '\n')


def main():
    ap = argparse.ArgumentParser(add_help=True, description='Empty agent-task result measurement (offline)')
    ap.add_argument('--transcripts')
    ap.add_argument('--teams')
    ap.add_argument('--from', dest='date_from')
    ap.add_argument('--to', dest='date_to')
    ap.add_argument('--min-support', type=int, default=30)
    ap.add_argument('--intent')
    ap.add_argument('--tsv')
    ap.add_argument('--json')
    ap.add_argument('--wilson-vectors', action='store_true')
    args = ap.parse_args()

    if args.wilson_vectors:
        vectors = {}
        for k, n in [(22, 22), (20, 22), (18, 22), (10, 10), (245, 245), (15, 30), (941, 1019), (0, 30)]:
            vectors[f'{k}/{n}'] = {
                'lower_1_645': wilson(k, n, 1.645)[0],
                'interval_1_96': list(wilson(k, n, 1.96)),
            }
        print(json.dumps(vectors, ensure_ascii=False))
        return

    if not args.transcripts and not args.teams:
        usage_error('missing input: give --transcripts and/or --teams (at least one)')
    if args.transcripts and not os.path.isdir(args.transcripts):
        usage_error(f'--transcripts is not a directory: {args.transcripts}')
    if args.teams and not os.path.isdir(args.teams):
        usage_error(f'--teams is not a directory: {args.teams}')
    intent_map = None
    intent_counters = {'bad_values': 0, 'duplicate_ids': 0}
    if args.intent:
        if not os.path.isfile(args.intent):
            usage_error(f'--intent is not a file: {args.intent}')
        intent_map, intent_counters = read_intent(args.intent)
    if args.min_support < 0:
        usage_error('--min-support must not be negative')
    o = parse_ts(args.date_from) if args.date_from else None
    d = parse_ts(args.date_to) if args.date_to else None
    if args.date_from and o is None:
        usage_error(f'--from is not an ISO date: {args.date_from}')
    if args.date_to and d is None:
        usage_error(f'--to is not an ISO date: {args.date_to}')
    rng = (o, d)

    c0 = part_transcripts(args.transcripts, rng, args.min_support, intent_map) if args.transcripts else None
    ca = part_team(args.teams, rng, args.min_support) if args.teams else None

    def sum_entry(part):
        if part is None:
            return 'unmeasured'
        if part['n'] == 0:
            # A measured part without data in the window: not zero.
            return 'unmeasured (no data in the window: n = 0)'
        return str(part['k'])

    tsv_rows = []
    for part in (c0, ca):
        if part is not None:
            tsv_rows.extend(part['tsv_rows'])

    print('# empty agent-task results measurement (offline)')
    print()
    if args.date_from or args.date_to:
        print(f'Range (--from/--to): {args.date_from or "(none)"} .. {args.date_to or "(none)"}')
    else:
        print('Range: no filter (whole file)')
    print(f'min_support: {args.min_support}')
    print()
    print('Principle: unmeasured is not zero; this tool reports numbers only and blocks nothing.')
    print('Measure limitation: a call without a subagent transcript is never recognized as')
    print('stopped (even with a parent TaskStop) and counts by the empty classification.')
    print()

    if c0 is not None:
        k_intentional = sum(1 for w in c0['tsv_rows'] if w.get('intent') == 'intentional')
        k_other = sum(1 for w in c0['tsv_rows'] if w.get('intent') == 'other')
        kz = c0['stopped_without_report']['k']
        n_classified = k_intentional + k_other
        stopped_ids = {w['id'] for w in c0['tsv_rows'] if w.get('stop_source')}
        unknown_ids = sum(1 for i in (intent_map or {}) if i not in stopped_ids)
        c0['intent'].update({'file': args.intent, 'intentional': k_intentional, 'other': k_other,
                             'unclassified': kz - k_intentional - k_other,
                             'bad_values': intent_counters['bad_values'],
                             'unknown_ids': unknown_ids,
                             'duplicate_ids': intent_counters['duplicate_ids']})
        empty_rows = [w for w in c0['tsv_rows'] if not w.get('stop_source')]
        stopped_rows = [w for w in c0['tsv_rows'] if w.get('stop_source')]
        print('## Part transcripts: agent calls (transcripts)')
        print(f'- source: {args.transcripts}: sessions: {c0["counters"]["sessions"]}, '
              f'subagent transcripts: {c0["counters"]["subagent_transcripts"]}, '
              f'Agent/Task calls in the range: {c0["counters"]["calls_in_range"]}, '
              f'duplicate tool_use_ids: {c0["counters"]["duplicates"]}, '
              f'with an unreadable timestamp (timestamp/ts): {c0["counters"]["bad_ts"]}')
        print(f'- empty / denominator: {describe_rate(c0["k"], c0["n"], args.min_support)}')
        print(f'- subtotals: prompt_only: {c0["subtotals"]["prompt_only"]}, '
              f'empty_tool_result: {c0["subtotals"]["empty_tool_result"]}, '
              f'tool_use_only: {c0["subtotals"]["tool_use_only"]}, '
              f'non_empty: {c0["subtotals"]["non_empty"]}, '
              f'missing_transcript (outside the denominator): {c0["subtotals"]["missing_transcript"]}')
        print(f'- stopped without report: '
              f'{describe_rate(c0["stopped_without_report"]["k"], c0["stopped_without_report"]["n"], args.min_support)}')
        print(f'- stops by source: parent_taskstop: {c0["stops_by_source"]["parent_taskstop"]}, '
              f'interrupt: {c0["stops_by_source"]["interrupt"]}, '
              f'killed_other: {c0["stops_by_source"]["killed_other"]}')
        if stopped_rows:
            ids = ', '.join(f"{w['id']} ({w['stop_source']})" for w in stopped_rows)
            print(f'- stopped identifiers: {ids}')
        print('- intentional and other: not measured automatically, read by hand (intent column)')
        if args.intent:
            print(f'  intent file --intent: intentional: {k_intentional}/{n_classified}, other: {k_other}/{n_classified}, '
                  f'unclassified: {c0["intent"]["unclassified"]} '
                  f'(stopped total: {kz}), '
                  f'values outside the list: {c0["intent"]["bad_values"]}, '
                  f'unknown ids: {c0["intent"]["unknown_ids"]}, '
                  f'duplicate ids: {c0["intent"]["duplicate_ids"]}')
        if empty_rows:
            ids = ', '.join(f"{w['id']} ({w['context']})" for w in empty_rows)
            print(f'- identifiers of empty: {ids}')
        print()
    else:
        print('## Part transcripts')
        print('- NOT MEASURED (--transcripts not given): not zero')
        print()

    if ca is not None:
        print('## Part team: team task files')
        print(f'- source: {args.teams}: team directories: {ca["counters"]["team_dir_count"]}, '
              f'with tasks/: {ca["counters"]["teams_with_tasks"]}, '
              f'task files: {ca["counters"]["files"]}, bad JSON: {ca["counters"]["bad_json"]}, '
              f'duplicate files: {ca["counters"]["duplicate_files"]}, '
              f'without a readable timestamp: {ca["counters"]["bad_ts"]}, outside the range: {ca["counters"]["outside_range"]}')
        print(f'- empty (completed without result) / denominator (finished): '
              f'{describe_rate(ca["k"], ca["n"], args.min_support)}')
        print(f'- subtotals: completed_with_result: {ca["subtotals"]["completed_with_result"]}, '
              f'failed_with_error: {ca["subtotals"]["failed_with_error"]}, '
              f'failed_without_error: {ca["subtotals"]["failed_without_error"]}, '
              f'other_statuses: {ca["subtotals"]["other_statuses"]}')
        if ca['tsv_rows']:
            ids = ', '.join(f"{w['id']} ({w['context']})" for w in ca['tsv_rows'])
            print(f'- identifiers of empty: {ids}')
        print()
    else:
        print('## Part team')
        print('- NOT MEASURED (--teams not given): not zero')
        print()

    if args.tsv:
        try:
            write_tsv(args.tsv, tsv_rows)
        except OSError as e:
            usage_error(f'cannot write --tsv: {e}')
        empty_total = sum(part['k'] for part in (c0, ca) if part is not None)
        stopped_total = c0['stopped_without_report']['k'] if c0 is not None else 0
        print(f'TSV: {args.tsv} ({len(tsv_rows)} rows: {empty_total} empty, {stopped_total} stopped)')
    if args.json:
        result = {
            'period': {'from': args.date_from, 'to': args.date_to},
            'min_support': args.min_support,
            'part_transcripts': c0,
            'part_team': ca,
            'empty_result_sum': {
                'transcripts': sum_entry(c0),
                'team': sum_entry(ca),
            },
            'tsv_rows': tsv_rows,
        }
        try:
            with open(args.json, 'w', encoding='utf8') as f:
                json.dump(result, f, ensure_ascii=False, indent=1)
        except OSError as e:
            usage_error(f'cannot write --json: {e}')
        print(f'JSON: {args.json}')
    print()
    print('Note: this tool reports numbers only; nothing is blocked and no enforcement is')
    print('built from this measurement. Calls stopped from outside are excluded from the')
    print('empty count and measured separately as stopped without report.')
    print(f'empty-result sum: transcripts = {sum_entry(c0)}, team = {sum_entry(ca)} (numbers only)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
