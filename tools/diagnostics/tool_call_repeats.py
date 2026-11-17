#!/usr/bin/env python3
"""Repeated-call measurement on Claude Code transcripts (offline diagnostic).

Counts four phenomena on session and subagent transcripts:

  (a) repeated success: within one context (session or subagent), a run of at least
      --min-identical CONSECUTIVE calls (in the subsequence of that tool's calls in
      the context) with the same call signature and the same result signature, with
      is_error false;
  (b) duplicate task: pairs of Agent (and Task, if present) calls in one context with
      the same subagent_type and the literally same prompt, where the second call lands
      before the tool_result of the first appears in the transcript (result not
      received); separately, pairs with the same prompt after a received result;
  (c) near-identical series: a run of at least --min-similar consecutive calls of one
      tool (subsequence of that tool's calls), each within the Dice coefficient on
      character bigrams of the stable JSON input at least --dice and NOT identical
      (an identical call belongs to (a) and does not extend a similar series);
  (d) cycles: a cycle of period p (p from --periods) = at least --min-cycle-repeats
      full repetitions of a length-p pattern in the last --window call signatures of
      the context (A,B,A,B,A,B for p=2), with at least 2 distinct signatures. Each
      cycle is counted once: shortest period, no overlap (after a match the scan
      resumes after the cycle end).
The polling exception: Bash calls whose command starts with an entry of POLLING_BASH
(sleep as a whole word, gh run watch, tail -f, git status as prefixes; extendable with
--poll-prefix) and calls of state tools from STATE_TOOLS (ReadNotifications, TaskList,
TaskGet, CronList, ListAgents, Monitor) and MCP tools whose name ends with an entry of
MCP_SUFFIXES; the list is extendable with --poll-tool (matched as the full name or a
suffix). Counted SEPARATELY as "polling", not in (a). The polling category reports runs
of identical successful polls (two variants, below) and the number of calls matched to
the lists (per tool). Polling calls stay in the denominators of their tools and sit
outside the repeat-work sums.

Variants of "consecutive" for (a), (c) and polling:
  subsequence: in the subsequence of that tool's calls in the context (a call of another
               tool in between does not break the run; an upper-bound measure);
  strict:      on the full call stream of the context (every other-tool call breaks it,
               like the counter of a future PostToolUse hook; an identical-poll run on
               the same stream lands in the polling category).
The report, TSV and JSON give both variants.

Call signature: sha256 of name + NUL + stable JSON input (keys sorted recursively, no
spaces, ensure_ascii=False). Result signature: sha256 of the normalized content text
(a string as is, a list of blocks joined over the text field) plus is_error; a call
without a tool_result in the transcript has a result not received (signature None) and
does not qualify for (a).

The (b) rate counts duplicate CALLS (each call once, not pairs); the number of pairs is
reported separately. The footer gives two sums, each for both variants: "strict sum:
(a)+(b no result)+(c)+(d)" (the pairs after a received result sit outside it and are
reported separately) and "with (b) after result". Part (b) skips Agent/Task calls
without a string prompt (counted separately).

The defaults of the thresholds (min-identical 3, dice 0.85, min-similar 5, periods 2-6,
min-cycle-repeats 3, window 64, min-support 30) are starting values to tune with data.
At every rate: k/n, two-sided 95 percent Wilson interval (z = 1.96) and a one-sided 95
percent lower bound (z = 1.645); n < min-support gives "no threshold (too little
data)". The Wilson helper is the same function as in decision_outcome_join.py.

Output: report to stdout (numbers, identifiers and timestamps only; NO input, prompt
or result content), optional --tsv (one row per finding, columns: kind, variant,
context, tool, from_ts, to_ts, calls, period, signature; signature is a 12-char digest;
kind values: a, b, b_after_result, c, d, polling; variant: strict or subsequence for
a, c and polling, empty for b and d) and --json (file with the full result, also
content-free). Context labels: session:<id> for a session transcript and
agent:<session>/<agent_id> for a subagent transcript (agent_id from the file name
agent-<id>.jsonl); subagent contexts are counted separately from the main session.
Bad JSON lines are skipped and counted (bad_lines). Calls without a readable timestamp
are counted normally without a range filter and skipped under a range filter
(calls_without_ts counter). A failed --tsv/--json write gives exit code 2, not a traceback.

Input: --transcripts <dir> (required): a directory of Claude Code transcripts laid out
<dir>/<project>/<session>.jsonl (session) and <dir>/<project>/<session>/subagents/agent-<id>.jsonl
(subagent, also one level deeper). A call = a tool_use block (id, name, input) in an
assistant message; a result = the tool_result block with the same tool_use_id (content
as a string or a list of {type: "text", text} blocks, is_error). All input paths come
ONLY from arguments (no --transcripts: usage and exit 2; no default paths into real
data). The --from/--to range (ISO, both ends inclusive) applies to the call timestamp.

Exit codes: 0 normal run (also with no data), 2 argument or input error.
"""
import argparse
import glob
import hashlib
import json
import math
import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone

Z_LOWER_95 = 1.645      # one-sided 95 percent lower bound
Z_TWO_SIDED_95 = 1.96   # two-sided 95 percent interval for the rate reports

# Polling exception (plain prefixes matched against common wait and poll commands),
# extendable with --poll-prefix <prefix>; sleep is matched as a whole word.
POLLING_BASH = (
    ('sleep', 'whole_word'),
    ('gh run watch', 'prefix'),
    ('tail -f', 'prefix'),
    ('git status', 'prefix'),
)
POLLING_BASH_TOOLS = ('Bash',)

# Polling via state tools: full tool names and MCP tool suffixes; extendable with
# --poll-tool <full name or suffix>.
STATE_TOOLS = ('ReadNotifications', 'TaskList', 'TaskGet', 'CronList', 'ListAgents', 'Monitor')
MCP_SUFFIXES = ('__state_list_active', '__state_get_status', '__state_read')


SCRIPT_NAME = 'tool_call_repeats.py'
USAGE = (
    f'usage: {SCRIPT_NAME} --transcripts <transcripts dir> [--from <ISO>] [--to <ISO>] '
    '[--min-identical 3] [--dice 0.85] [--min-similar 5] [--periods 2-6] '
    '[--min-cycle-repeats 3] [--window 64] [--min-support 30] '
    '[--poll-prefix <prefix>] [--poll-tool <name or suffix>] [--tsv <file>] [--json <file>]'
)


TSV_COLUMNS = ['kind', 'variant', 'context', 'tool', 'from_ts', 'to_ts', 'calls', 'period', 'signature']


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


def stable_json(obj):
    """Stable JSON: keys sorted recursively, no spaces, ensure_ascii=False."""
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def call_signature(tool, inp):
    """sha256 of name + NUL + stable JSON input."""
    return digest(f'{tool}\u0000{stable_json(inp)}')


def result_text(content):
    """Normalized result text: a string as is; a list of blocks joined over the text field."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [b.get('text') for b in content
                 if isinstance(b, dict) and isinstance(b.get('text'), str)]
        return '\n'.join(parts)
    return ''


def result_digest(content):
    return digest(result_text(content))


def bigrams(text):
    """Character bigrams as a multiset."""
    return Counter(text[i:i + 2] for i in range(len(text) - 1))


def dice(a_text, b_text):
    """2*|A and B| / (|A|+|B|) on character bigrams as a multiset; both empty: 1.0."""
    a = bigrams(a_text)
    b = bigrams(b_text)
    total = sum(a.values()) + sum(b.values())
    if total == 0:
        return 1.0
    inter = sum((a & b).values())
    return 2.0 * inter / total


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
    """k/n, percent, two-sided Wilson 1.96 and one-sided lower 1.645; threshold
    status: n < min-support gives "no threshold (too little data)". n = 0: no value, not 0."""
    if n == 0:
        return '0/0 = no value (n = 0, not 0); no threshold (too little data)'
    lower, upper = wilson(k, n, Z_TWO_SIDED_95)
    lower1645 = wilson(k, n, Z_LOWER_95)[0]
    status = ('no threshold (too little data)' if n < min_support
              else f'threshold: enough data, lower 1.645 = {lower1645:.4f}')
    return (f'{k}/{n} = {100.0 * k / n:.1f}% (Wilson 95% two-sided: '
            f'[{lower:.4f}; {upper:.4f}], one-sided 95% lower: {lower1645:.4f}); {status}')


def is_polling(tool, inp, commands, extra_tools):
    """Polling exception: 'bash' (a command from POLLING_BASH, sleep as a whole word),
    'tool' (a state tool from STATE_TOOLS or a name in extra_tools, or a name ending
    with an MCP_SUFFIXES entry or an extra_tools entry: full name or suffix), None otherwise."""
    if tool in POLLING_BASH_TOOLS:
        command = inp.get('command') if isinstance(inp, dict) else None
        if isinstance(command, str):
            trimmed = command.strip()
            for pattern, mode in commands:
                if mode == 'whole_word':
                    if trimmed == pattern or trimmed.startswith(pattern + ' '):
                        return 'bash'
                elif trimmed.startswith(pattern):
                    return 'bash'
    if tool in STATE_TOOLS or tool in extra_tools:
        return 'tool'
    if any(tool.endswith(s) for s in MCP_SUFFIXES):
        return 'tool'
    if any(tool.endswith(x) for x in extra_tools):
        return 'tool'
    return None


def load_contexts(dir_path, rng, poll_commands, extra_tools):
    """Sessions and subagents from the transcripts directory as separate contexts. Returns
    (contexts, stats). Context: {'context': label, 'file': path, 'calls': [c]}.
    A call: dict with fields id, tool, input, ts, position (line number in the file),
    sig (call signature), result_sig (result digest or None without a received result),
    error (is_error), result_pos (tool_result line number or None), polling (bool),
    polling_kind, subagent_type, prompt. Call order: file line order."""
    patterns = [
        os.path.join(dir_path, '*', '*', 'subagents', '**', 'agent-*.jsonl'),
        os.path.join(dir_path, '*', '*.jsonl'),
    ]
    contexts = []
    stats = {'bad_lines': 0, 'files': 0, 'sessions': 0, 'subagents': 0, 'calls_without_ts': 0}
    seen_files = set()
    for pattern_no, pattern in enumerate(patterns):
        for path in sorted(glob.glob(pattern, recursive=True)):
            if path in seen_files:
                continue
            seen_files.add(path)
            if pattern_no == 0:
                ident = os.path.basename(path)[len('agent-'):-len('.jsonl')]
                session = os.path.basename(os.path.dirname(os.path.dirname(path)))
                label = f'agent:{session}/{ident}'
                stats['subagents'] += 1
            else:
                ident = os.path.basename(path)[:-len('.jsonl')]
                label = f'session:{ident}'
                stats['sessions'] += 1
            stats['files'] += 1
            calls = []
            results = {}   # tool_use_id -> (row position, content, is_error)
            seen_tool_use_ids = set()  # Track already-added tool_use IDs to deduplicate within context
            try:
                with open(path, encoding='utf8', errors='replace') as f:
                    for position, line in enumerate(f):
                        if not line.strip():
                            continue
                        try:
                            row = json.loads(line)
                        except Exception:
                            stats['bad_lines'] += 1
                            continue
                        if not isinstance(row, dict):
                            stats['bad_lines'] += 1
                            continue
                        row_type = row.get('type')
                        message = row.get('message')
                        content = message.get('content') if isinstance(message, dict) else None
                        if row_type == 'assistant':
                            if not isinstance(content, list):
                                continue
                            ts = parse_ts(row.get('timestamp'))
                            if ts is None:
                                stats['calls_without_ts'] += 1
                            for block in content:
                                if not (isinstance(block, dict) and block.get('type') == 'tool_use'):
                                    continue
                                tool_use_id = block.get('id')
                                if tool_use_id in seen_tool_use_ids:
                                    continue
                                if tool_use_id:
                                    seen_tool_use_ids.add(tool_use_id)
                                tool = block.get('name')
                                inp = block.get('input')
                                if not isinstance(inp, dict):
                                    inp = {}
                                polling_kind = is_polling(str(tool), inp, poll_commands, extra_tools)
                                calls.append({
                                    'id': block.get('id'),
                                    'tool': tool,
                                    'input': inp,
                                    'ts': ts,
                                    'ts_raw': row.get('timestamp') if isinstance(row.get('timestamp'), str) else '',
                                    'position': position,
                                    'sig': call_signature(str(tool), inp),
                                    'result_sig': None,
                                    'error': None,
                                    'result_pos': None,
                                    'polling': polling_kind is not None,
                                    'polling_kind': polling_kind,
                                    'subagent_type': inp.get('subagent_type') if isinstance(inp.get('subagent_type'), str) else '',
                                    'prompt': inp.get('prompt') if isinstance(inp.get('prompt'), str) else None,
                                })
                        elif row_type == 'user':
                            if not isinstance(content, list):
                                continue
                            for block in content:
                                if isinstance(block, dict) and block.get('type') == 'tool_result':
                                    tid = block.get('tool_use_id')
                                    if tid and tid not in results:
                                        results[tid] = (position, block.get('content'), block.get('is_error') is True)
            except OSError:
                continue
            for w in calls:
                result = results.get(w['id'])
                if result is not None:
                    pos, content, is_err = result
                    w['result_sig'] = result_digest(content)
                    w['error'] = is_err
                    w['result_pos'] = pos
            contexts.append({'context': label, 'file': path, 'calls': calls})
    return contexts, stats


def calls_in_range(contexts, rng):
    """Calls after the range filter (by the call timestamp); without --from/--to also
    without a readable timestamp."""
    result = {}
    for c in contexts:
        kept = [w for w in c['calls']
                if (w['ts'] is not None and in_range(w['ts'], rng)) or (rng[0] is None and rng[1] is None)]
        result[c['context']] = kept
    return result


def identical_runs(stream, min_identical):
    """(a): maximal runs of at least min_identical consecutive calls (in the subsequence
    of that tool's calls) with the same (call signature, result signature) pair, with
    is_error false. A call without a received result (result_sig None) does not qualify."""
    result = []
    i = 0
    n = len(stream)
    while i < n:
        w = stream[i]
        if w['error'] is not True and w['result_sig'] is not None:
            j = i + 1
            while (j < n and stream[j]['sig'] == w['sig'] and stream[j]['result_sig'] == w['result_sig']
                   and stream[j]['error'] is not True):
                j += 1
            if j - i >= min_identical:
                result.append({'start': i, 'end': j, 'sig': w['sig']})
                i = j
                continue
        i += 1
    return result


def similar_series(stream, min_similar, dice_threshold, input_texts):
    """(c): maximal series of at least min_similar consecutive calls (in the subsequence
    of that tool's calls), each within the Dice coefficient of the previous one on the
    stable JSON input of at least dice_threshold and not identical (an identical call
    signature breaks the series: identical calls belong to (a))."""
    result = []
    i = 0
    n = len(stream)
    while i < n:
        j = i + 1
        while j < n:
            if stream[j]['sig'] == stream[j - 1]['sig']:
                break
            if dice(input_texts[stream[j - 1]['sig']], input_texts[stream[j]['sig']]) < dice_threshold:
                break
            j += 1
        if j - i >= min_similar:
            result.append({'start': i, 'end': j, 'sig': stream[i]['sig']})
            i = j
        else:
            i += 1
    return result


def similar_series_strict(stream, min_similar, dice_threshold, input_texts):
    """(c) strict variant: a series on the full call stream of the context: all calls of
    the series of one tool, directly consecutive (every other-tool call breaks it), each
    within the Dice coefficient of the previous one of at least dice_threshold and not identical."""
    result = []
    i = 0
    n = len(stream)
    while i < n:
        j = i + 1
        while j < n:
            if stream[j]['tool'] != stream[i]['tool']:
                break
            if stream[j]['sig'] == stream[j - 1]['sig']:
                break
            if dice(input_texts[stream[j - 1]['sig']], input_texts[stream[j]['sig']]) < dice_threshold:
                break
            j += 1
        if j - i >= min_similar:
            result.append({'start': i, 'end': j, 'sig': stream[i]['sig']})
            i = j
        else:
            i += 1
    return result


def cycles(stream, periods, min_repeats, window):
    """(d): cycles of period p from periods (ascending, shortest wins) within a window of
    window signatures. A cycle = at least min_repeats full repetitions of a length-p pattern
    with at least 2 distinct signatures. No overlap: after a match the scan resumes after
    the cycle end."""
    result = []
    i = 0
    n = len(stream)
    while i < n:
        limit = min(n, i + window)
        found = None
        for p in periods:
            min_len = p * min_repeats
            if i + min_len > limit:
                continue
            pattern = stream[i:i + p]
            if len({w['sig'] for w in pattern}) < 2:
                continue
            j = i
            while j < limit and stream[j]['sig'] == pattern[(j - i) % p]['sig']:
                j += 1
            if j - i >= min_len:
                found = {'start': i, 'end': j, 'period': p}
                break
        if found is not None:
            result.append(found)
            i = found['end']
        else:
            i += 1
    return result



def duplicate_pairs(stream):
    """(b): pairs of calls (i, j), i < j in file order, with the same subagent_type and the
    literally same prompt. Class: after_result when the tool_result of the first call sits
    in the transcript before call j; no_result otherwise (no result or result after j).
    Returns a list of pairs {'i', 'j', 'class'}."""
    groups = {}
    for position, w in enumerate(stream):
        key = (w['subagent_type'], w['prompt'])
        groups.setdefault(key, []).append(position)
    pairs = []
    for positions in groups.values():
        for a_idx in range(len(positions)):
            for b_idx in range(a_idx + 1, len(positions)):
                i = positions[a_idx]
                j = positions[b_idx]
                result_pos = stream[i]['result_pos']
                if result_pos is not None and result_pos < stream[j]['position']:
                    cls = 'after_result'
                else:
                    cls = 'no_result'
                pairs.append({'i': i, 'j': j, 'class': cls})
    pairs.sort(key=lambda p: (p['i'], p['j']))
    return pairs


def collect(calls_by_context, options):
    """Four counts on all contexts; (a), (c) and polling in the two "consecutive" variants:
    subsequence (in the subsequence of that tool's calls) and strict (on the full call
    stream of the context, like a hook counter). Returns the partial results and the
    findings list for the TSV."""
    input_texts = {}
    for k in calls_by_context.values():
        for w in k:
            if w['sig'] not in input_texts:
                input_texts[w['sig']] = stable_json(w['input'])


    findings = []
    denominator = Counter()
    matched_calls = Counter()
    a_by_tool = {'subsequence': {}, 'strict': {}}
    a_total = {'subsequence': [0, 0], 'strict': [0, 0]}
    a_state = {'subsequence': [0, 0], 'strict': [0, 0]}
    polling_by_tool = {'subsequence': {}, 'strict': {}}
    polling_total = {'subsequence': [0, 0], 'strict': [0, 0]}
    c_by_tool = {'subsequence': {}, 'strict': {}}
    c_total = {'subsequence': [0, 0], 'strict': [0, 0]}
    contexts_with_run = {'subsequence': set(), 'strict': set()}
    contexts_with_calls = 0
    pairs_no_result = 0
    pairs_after_result = 0
    duplicate_calls = set()
    pairs_by_tool = Counter()
    b_denominator = Counter()
    agent_without_prompt = 0
    cycles_total = 0
    cycle_calls = 0
    cycles_by_period = Counter()
    cycles_by_tools = Counter()

    for label in sorted(calls_by_context):
        calls = calls_by_context[label]
        if calls:
            contexts_with_calls += 1
        # denominators: all tool calls in the range (polling calls included)
        for w in calls:
            denominator[w['tool']] += 1
            if w['polling']:
                matched_calls[w['tool']] += 1

        # (b): duplicate Agent/Task pairs in the context (calls without a string prompt are
        # skipped and counted separately)
        agents = [w for w in calls if w['tool'] in ('Agent', 'Task')]
        for w in agents:
            if w['prompt'] is not None:
                b_denominator[w['tool']] += 1
            else:
                agent_without_prompt += 1
        agents_with_prompt = [w for w in agents if w['prompt'] is not None]
        for pair in duplicate_pairs(agents_with_prompt):
            if pair['class'] == 'no_result':
                pairs_no_result += 1
                kind = 'b'
            else:
                pairs_after_result += 1
                kind = 'b_after_result'
            duplicate_calls.add((label, agents_with_prompt[pair['j']]['position'],
                                 agents_with_prompt[pair['j']]['id'],
                                 agents_with_prompt[pair['j']]['tool']))
            pairs_by_tool[agents_with_prompt[pair['i']]['tool']] += 1
            findings.append({
                'kind': kind,
                'variant': '',
                'context': label,
                'tool': agents_with_prompt[pair['i']]['tool'],
                'from_ts': agents_with_prompt[pair['i']]['ts_raw'],
                'to_ts': agents_with_prompt[pair['j']]['ts_raw'],
                'calls': 2,
                'period': '',
                'signature': agents_with_prompt[pair['j']]['sig'][:12],
            })

        # (a) and polling, subsequence variant: per tool (an other-tool call in between
        # does not break the run)
        for tool in sorted({w['tool'] for w in calls}):
            stream = [w for w in calls if w['tool'] == tool]
            normal = [w for w in stream if not w['polling']]
            polling = [w for w in stream if w['polling']]
            for s in identical_runs(normal, options['min_identical']):
                a_total['subsequence'][0] += 1
                a_total['subsequence'][1] += s['end'] - s['start']
                a_by_tool['subsequence'].setdefault(tool, Counter())['sequences'] += 1
                a_by_tool['subsequence'][tool]['calls'] += s['end'] - s['start']
                contexts_with_run['subsequence'].add(label)
                findings.append({
                    'kind': 'a',
                    'variant': 'subsequence',
                    'context': label,
                    'tool': tool,
                    'from_ts': normal[s['start']]['ts_raw'],
                    'to_ts': normal[s['end'] - 1]['ts_raw'],
                    'calls': s['end'] - s['start'],
                    'period': '',
                    'signature': s['sig'][:12],
                })
            for s in identical_runs(polling, options['min_identical']):
                polling_total['subsequence'][0] += 1
                polling_total['subsequence'][1] += s['end'] - s['start']
                polling_by_tool['subsequence'].setdefault(tool, Counter())['sequences'] += 1
                polling_by_tool['subsequence'][tool]['calls'] += s['end'] - s['start']
                if polling[s['start']]['polling_kind'] == 'tool':
                    a_state['subsequence'][0] += 1
                    a_state['subsequence'][1] += s['end'] - s['start']
                findings.append({
                    'kind': 'polling',
                    'variant': 'subsequence',
                    'context': label,
                    'tool': tool,
                    'from_ts': polling[s['start']]['ts_raw'],
                    'to_ts': polling[s['end'] - 1]['ts_raw'],
                    'calls': s['end'] - s['start'],
                    'period': '',
                    'signature': polling[s['start']]['sig'][:12],
                })

        # (a), (c) and polling, strict variant: on the full call stream of the context
        # (every other-tool call breaks it, like a hook counter)
        for s in identical_runs(calls, options['min_identical']):
            run_len = s['end'] - s['start']
            if calls[s['start']]['polling']:
                polling_total['strict'][0] += 1
                polling_total['strict'][1] += run_len
                polling_by_tool['strict'].setdefault(calls[s['start']]['tool'], Counter())['sequences'] += 1
                polling_by_tool['strict'][calls[s['start']]['tool']]['calls'] += run_len
                if calls[s['start']]['polling_kind'] == 'tool':
                    a_state['strict'][0] += 1
                    a_state['strict'][1] += run_len
                findings.append({
                    'kind': 'polling',
                    'variant': 'strict',
                    'context': label,
                    'tool': calls[s['start']]['tool'],
                    'from_ts': calls[s['start']]['ts_raw'],
                    'to_ts': calls[s['end'] - 1]['ts_raw'],
                    'calls': run_len,
                    'period': '',
                    'signature': calls[s['start']]['sig'][:12],
                })
            else:
                a_total['strict'][0] += 1
                a_total['strict'][1] += run_len
                a_by_tool['strict'].setdefault(calls[s['start']]['tool'], Counter())['sequences'] += 1
                a_by_tool['strict'][calls[s['start']]['tool']]['calls'] += run_len
                contexts_with_run['strict'].add(label)
                findings.append({
                    'kind': 'a',
                    'variant': 'strict',
                    'context': label,
                    'tool': calls[s['start']]['tool'],
                    'from_ts': calls[s['start']]['ts_raw'],
                    'to_ts': calls[s['end'] - 1]['ts_raw'],
                    'calls': run_len,
                    'period': '',
                    'signature': calls[s['start']]['sig'][:12],
                })
        for s in similar_series_strict(calls, options['min_similar'], options['dice'], input_texts):
            # Check if all calls in this series are polling; if so, exclude from totals
            series_calls = calls[s['start']:s['end']]
            if all(w['polling'] for w in series_calls):
                continue
            c_total['strict'][0] += 1
            c_total['strict'][1] += s['end'] - s['start']
            series_tool = calls[s['start']]['tool']
            c_by_tool['strict'].setdefault(series_tool, Counter())['series'] += 1
            c_by_tool['strict'][series_tool]['calls'] += s['end'] - s['start']
            findings.append({
                'kind': 'c',
                'variant': 'strict',
                'context': label,
                'tool': series_tool,
                'from_ts': calls[s['start']]['ts_raw'],
                'to_ts': calls[s['end'] - 1]['ts_raw'],
                'calls': s['end'] - s['start'],
                'period': '',
                'signature': calls[s['start']]['sig'][:12],
            })

        # (c): similar series per tool, subsequence variant (polling calls included)
        for tool in sorted({w['tool'] for w in calls}):
            stream = [w for w in calls if w['tool'] == tool]
            for s in similar_series(stream, options['min_similar'], options['dice'], input_texts):
                # Check if all calls in this series are polling; if so, exclude from totals
                series_calls = stream[s['start']:s['end']]
                if all(w['polling'] for w in series_calls):
                    continue
                c_total['subsequence'][0] += 1
                c_total['subsequence'][1] += s['end'] - s['start']
                c_by_tool['subsequence'].setdefault(tool, Counter())['series'] += 1
                c_by_tool['subsequence'][tool]['calls'] += s['end'] - s['start']
                findings.append({
                    'kind': 'c',
                    'variant': 'subsequence',
                    'context': label,
                    'tool': tool,
                    'from_ts': stream[s['start']]['ts_raw'],
                    'to_ts': stream[s['end'] - 1]['ts_raw'],
                    'calls': s['end'] - s['start'],
                    'period': '',
                    'signature': stream[s['start']]['sig'][:12],
                })

        # (d): cycles on the stream of all calls of the context (polling included)
        stream_d = calls
        for cy in cycles(stream_d, options['periods'], options['min_cycle_repeats'], options['window']):
            # Check if all calls in this cycle are polling; if so, exclude from totals
            cycle_calls_list = stream_d[cy['start']:cy['end']]
            if all(w['polling'] for w in cycle_calls_list):
                continue
            cycles_total += 1
            run_len = cy['end'] - cy['start']
            cycle_calls += run_len
            cycles_by_period[cy['period']] += 1
            pattern_tools = []
            for w in stream_d[cy['start']:cy['end']]:
                if w['tool'] not in pattern_tools:
                    pattern_tools.append(w['tool'])
            tools_key = ','.join(pattern_tools)
            cycles_by_tools[tools_key] += 1
            findings.append({
                'kind': 'd',
                'variant': '',
                'context': label,
                'tool': tools_key,
                'from_ts': stream_d[cy['start']]['ts_raw'],
                'to_ts': stream_d[cy['end'] - 1]['ts_raw'],
                'calls': run_len,
                'period': str(cy['period']),
                'signature': stream_d[cy['start']]['sig'][:12],
            })

    # repeat-work sum: two sums, each for both variants; the strict sum counts
    # (a) + (b before the result) + (c) + (d); pairs after a received result sit outside it
    sum_out = {}
    for variant in ('subsequence', 'strict'):
        strict = a_total[variant][0] + pairs_no_result + c_total[variant][0] + cycles_total
        sum_out[variant] = {
            'strict_sum': strict,
            'with_b_after_result': strict + pairs_after_result,
        }

    return {
        'a': {
            'subsequence': {'sequences': a_total['subsequence'][0], 'calls': a_total['subsequence'][1],
                            'by_tool': a_by_tool['subsequence'],
                            'state_tools': {'sequences': a_state['subsequence'][0], 'calls': a_state['subsequence'][1]}},
            'strict': {'sequences': a_total['strict'][0], 'calls': a_total['strict'][1],
                       'by_tool': a_by_tool['strict'],
                       'state_tools': {'sequences': a_state['strict'][0], 'calls': a_state['strict'][1]}},
            'without_state_tools': {
                'subsequence': {'sequences': a_total['subsequence'][0] + a_state['subsequence'][0],
                                'calls': a_total['subsequence'][1] + a_state['subsequence'][1]},
                'strict': {'sequences': a_total['strict'][0] + a_state['strict'][0],
                           'calls': a_total['strict'][1] + a_state['strict'][1]}},
            'contexts_with_run': {k: len(v) for k, v in contexts_with_run.items()},
            'contexts_total': contexts_with_calls},
        'b': {'pairs_no_result': pairs_no_result, 'pairs_after_result': pairs_after_result,
              'pairs': pairs_no_result + pairs_after_result,
              'duplicate_calls': len(duplicate_calls),
              'pairs_by_tool': dict(pairs_by_tool),
              'duplicates_by_tool': dict(Counter(tool_name for _, _, _, tool_name in duplicate_calls)),
              'denominator': dict(b_denominator),
              'agent_without_prompt': agent_without_prompt},
        'c': {'subsequence': {'series': c_total['subsequence'][0], 'calls': c_total['subsequence'][1],
                              'by_tool': c_by_tool['subsequence']},
              'strict': {'series': c_total['strict'][0], 'calls': c_total['strict'][1],
                         'by_tool': c_by_tool['strict']}},
        'd': {'cycles': cycles_total, 'calls': cycle_calls,
              'by_period': {str(k): v for k, v in cycles_by_period.items()},
              'by_tools': dict(cycles_by_tools)},
        'polling': {
            'subsequence': {'sequences': polling_total['subsequence'][0], 'calls': polling_total['subsequence'][1],
                            'by_tool': polling_by_tool['subsequence']},
            'strict': {'sequences': polling_total['strict'][0], 'calls': polling_total['strict'][1],
                       'by_tool': polling_by_tool['strict']},
            'matched_calls': dict(matched_calls),
            'matched_calls_total': sum(matched_calls.values())},
        'denominators': {'by_tool': dict(denominator)},
        'repeat_work_sum': sum_out,
        'findings': findings,
    }


def rate_table(data, min_support):
    """Rates (k/n, two-sided Wilson 1.96, one-sided lower 1.645, threshold status) for
    (a) and (c) in both variants, for (b) from the duplicate-call count, and for polling,
    per tool; n < min_support gives the no-threshold status."""
    denominators = data['denominators']['by_tool']

    def entry(k, n):
        if n == 0:
            return {'k': k, 'n': n, 'wilson_1_96': None, 'wilson_lower_1_645': None,
                    'threshold_status': 'no threshold (too little data)'}
        lower, upper = wilson(k, n, Z_TWO_SIDED_95)
        return {'k': k, 'n': n, 'wilson_1_96': [lower, upper],
                'wilson_lower_1_645': wilson(k, n, Z_LOWER_95)[0],
                'threshold_status': ('no threshold (too little data)' if n < min_support else 'ok')}

    result = {}
    for variant in ('subsequence', 'strict'):
        for name, counters in data['a'][variant]['by_tool'].items():
            result[f'a_{variant}:{name}'] = entry(counters.get('calls', 0), denominators.get(name, 0))
        for name, counters in data['c'][variant]['by_tool'].items():
            result[f'c_{variant}:{name}'] = entry(counters.get('calls', 0), denominators.get(name, 0))
    for name, n in data['b']['denominator'].items():
        result[f'b:{name}'] = entry(data['b']['duplicates_by_tool'].get(name, 0), n)
    for variant in ('subsequence', 'strict'):
        for name, counters in data['polling'][variant]['by_tool'].items():
            result[f'polling_{variant}:{name}'] = entry(counters.get('calls', 0), denominators.get(name, 0))
    return result


def parse_periods(text):
    m = re.fullmatch(r'(\d+)-(\d+)', text) or re.fullmatch(r'(\d+)', text)
    if not m:
        usage_error(f'--periods must be in the a-b or a format: {text}')
    x = int(m.group(1))
    y = int(m.group(2)) if m.lastindex == 2 else x
    if x < 2 or y < x or y > 64:
        usage_error(f'--periods: required 2 <= a <= b <= 64, got {text}')
    return list(range(x, y + 1))


def write_tsv(path, findings):
    with open(path, 'w', encoding='utf8') as f:
        f.write('\t'.join(TSV_COLUMNS) + '\n')
        for x in findings:
            f.write('\t'.join(str(x.get(col, '')) for col in TSV_COLUMNS) + '\n')


def tool_line(name, counters, denominators, min_support, counter_label):
    entry = counters.get(name, {})
    k = entry.get('calls', 0)
    n = denominators.get(name, 0)
    count = entry.get(counter_label, 0)
    return (f"- {name}: {counter_label} {count}, calls in findings {k}, "
            f"denominator (all calls of the tool in the range, polling included): {n} -> {describe_rate(k, n, min_support)}")


def periods_text(periods):
    return f'{periods[0]}-{periods[-1]}'


def main():
    ap = argparse.ArgumentParser(add_help=True, description='Repeated-call measurement (offline)')
    ap.add_argument('--transcripts')
    ap.add_argument('--from', dest='date_from')
    ap.add_argument('--to', dest='date_to')
    ap.add_argument('--min-identical', type=int, default=3)
    ap.add_argument('--dice', default='0.85')
    ap.add_argument('--min-similar', type=int, default=5)
    ap.add_argument('--periods', default='2-6')
    ap.add_argument('--min-cycle-repeats', type=int, default=3)
    ap.add_argument('--window', type=int, default=64)
    ap.add_argument('--min-support', type=int, default=30)
    ap.add_argument('--poll-prefix', action='append', default=[])
    ap.add_argument('--poll-tool', action='append', default=[])
    ap.add_argument('--tsv')
    ap.add_argument('--json')
    args = ap.parse_args()

    if not args.transcripts:
        usage_error('missing --transcripts')
    if not os.path.isdir(args.transcripts):
        usage_error(f'--transcripts is not a directory: {args.transcripts}')
    o = parse_ts(args.date_from) if args.date_from else None
    d = parse_ts(args.date_to) if args.date_to else None
    if args.date_from and o is None:
        usage_error(f'--from is not an ISO date: {args.date_from}')
    if args.date_to and d is None:
        usage_error(f'--to is not an ISO date: {args.date_to}')
    if args.min_identical < 2:
        usage_error('--min-identical must be at least 2')
    if args.min_similar < 2:
        usage_error('--min-similar must be at least 2')
    try:
        dice_threshold = float(str(args.dice).replace(',', '.'))
    except (ValueError, AttributeError):
        usage_error(f'--dice is not a number: {args.dice}')
    if not (0 <= dice_threshold <= 1):
        usage_error(f'--dice outside the range 0-1: {dice_threshold}')
    periods = parse_periods(args.periods)
    if args.min_cycle_repeats < 2:
        usage_error('--min-cycle-repeats must be at least 2')
    if args.window < 1:
        usage_error('--window must be at least 1')
    if args.min_support < 0:
        usage_error('--min-support must not be negative')
    poll_commands = POLLING_BASH + tuple((x, 'prefix') for x in args.poll_prefix)
    extra_tools = tuple(args.poll_tool)

    options = {
        'min_identical': args.min_identical,
        'dice': dice_threshold,
        'min_similar': args.min_similar,
        'periods': periods,
        'min_cycle_repeats': args.min_cycle_repeats,
        'window': args.window,
        'min_support': args.min_support,
    }

    contexts, stats = load_contexts(args.transcripts, (o, d), poll_commands, extra_tools)
    ranged = calls_in_range(contexts, (o, d))
    total_calls = sum(len(v) for v in ranged.values())
    stats['calls'] = total_calls
    ts_min = None
    ts_max = None
    for v in ranged.values():
        for w in v:
            if w['ts'] is not None:
                if ts_min is None or w['ts'] < ts_min:
                    ts_min = w['ts']
                if ts_max is None or w['ts'] > ts_max:
                    ts_max = w['ts']

    data = collect(ranged, options)
    stats['contexts'] = len(ranged)

    print_report(data, stats, options, (args.date_from, args.date_to), poll_commands, extra_tools, ts_min, ts_max, args.min_support)

    if args.tsv:
        try:
            write_tsv(args.tsv, data['findings'])
        except OSError as err:
            usage_error(f'cannot write --tsv {args.tsv}: {err}')
    if args.json:
        result = dict(data)
        result['period'] = {'from': args.date_from, 'to': args.date_to,
                            'ts_min': ts_min.isoformat() if ts_min else None,
                            'ts_max': ts_max.isoformat() if ts_max else None}
        result['thresholds'] = {
            'min_identical': args.min_identical, 'dice': dice_threshold,
            'min_similar': args.min_similar,
            'periods': f'{periods[0]}-{periods[-1]}',
            'min_cycle_repeats': args.min_cycle_repeats, 'window': args.window,
            'min_support': args.min_support,
        }
        result['stats'] = {k: stats[k] for k in ('bad_lines', 'files', 'sessions', 'subagents', 'calls_without_ts', 'calls', 'contexts')}
        result['rate_table'] = rate_table(data, args.min_support)
        result['polling_lists'] = {
            'bash_prefixes': [w for w, _ in poll_commands],
            'state_tools': list(STATE_TOOLS),
            'mcp_suffixes': list(MCP_SUFFIXES),
            'extra_tools': list(extra_tools),
        }
        result['note'] = ('decisions belong to the people reading the measurement, not the script; '
                          'the threshold defaults are starting values to tune with data; '
                          'the strict sum is strict_sum, pairs after the received result sit outside it')
        try:
            with open(args.json, 'w', encoding='utf8') as f:
                json.dump(result, f, ensure_ascii=False, indent=1)
        except OSError as err:
            usage_error(f'cannot write --json {args.json}: {err}')
    return 0



def print_report(data, stats, options, rng_labels, poll_commands, extra_tools, ts_min, ts_max, min_support):
    print('# repeated successful calls, duplicate agent tasks, near-identical series and cycles (offline measurement)')
    print()
    print(f"Data range: {ts_min.isoformat() if ts_min else 'none'} .. {ts_max.isoformat() if ts_max else 'none'}"
          f"; --from/--to filter: {rng_labels[0] or '(none)'} .. {rng_labels[1] or '(none)'}")
    print(f"Transcripts: contexts {stats['contexts']} (sessions {stats['sessions']}, subagents {stats['subagents']}), "
          f"calls in range {stats['calls']}, without a readable timestamp: {stats['calls_without_ts']}, "
          f"bad lines (skipped, counted): {stats['bad_lines']}")
    print()
    print('Thresholds (starting values to tune with data): '
          f"min-identical {options['min_identical']}, dice {options['dice']}, min-similar {options['min_similar']}, "
          f"periods {periods_text(options['periods'])}, min-cycle-repeats {options['min_cycle_repeats']}, "
          f"window {options['window']}, min-support {min_support}")
    print('Polling exception (outside (a), outside the repeat-work sums): Bash commands: '
          + ', '.join(w for w, _ in poll_commands)
          + '; state tools: ' + ', '.join(STATE_TOOLS)
          + '; MCP suffixes: ' + ', '.join(MCP_SUFFIXES)
          + (('; tools from the option: ' + ', '.join(extra_tools)) if extra_tools else ''))
    print()
    aa = data['a']
    print(f"## (a) repeated success: runs of at least {options['min_identical']} consecutive identical calls with an identical success result")
    report_denominators = data['denominators']['by_tool']
    for variant in ('subsequence', 'strict'):
        desc = ('in the subsequence of the calls of one tool; an other-tool call in between does not break the run'
                if variant == 'subsequence'
                else 'on the full call stream of the context; every other-tool call breaks it, like a hook counter')
        print(f"Variant {variant} ({desc}):")
        print(f"- contexts with at least one run / contexts with calls: {aa['contexts_with_run'][variant]}/{aa['contexts_total']}")
        for name in sorted(set(aa[variant]['by_tool']) | {k for k, v in report_denominators.items() if v > 0}):
            print(tool_line(name, aa[variant]['by_tool'], report_denominators, min_support, 'sequences'))
        print(f"- total: runs {aa[variant]['sequences']}, calls in runs {aa[variant]['calls']}")
    print(f"- polling by state tools would land here if the list were limited to Bash commands: "
          f"subsequence {aa['without_state_tools']['subsequence']['sequences']} runs, strict {aa['without_state_tools']['strict']['sequences']} runs")
    print()
    print('## (b) duplicate task: Agent/Task pairs with the same subagent_type and the literally same prompt')
    bb = data['b']
    print(f"- pairs with the result not received: {bb['pairs_no_result']}; pairs after a received result (outside the strict sum): {bb['pairs_after_result']}; pairs total: {bb['pairs']}")
    if bb['agent_without_prompt']:
        print(f"- Agent/Task calls without a string prompt (outside (b), counted separately): {bb['agent_without_prompt']}")
    for tool in sorted(bb['denominator']):
        k = bb['duplicates_by_tool'].get(tool, 0)
        n = bb['denominator'][tool]
        print(f"- {tool}: duplicate CALLS (each call once) {k} / tool calls with a prompt {n} -> {describe_rate(k, n, min_support)}; pairs for {tool}: {bb['pairs_by_tool'].get(tool, 0)}")
    print()
    print(f"## (c) near-identical series: at least {options['min_similar']} consecutive calls of one tool, each within Dice >= {options['dice']} of the previous one and not identical")
    cc = data['c']
    for variant in ('subsequence', 'strict'):
        desc = ('in the subsequence of the calls of one tool' if variant == 'subsequence'
                else 'on the full call stream of the context (every other-tool call breaks it)')
        print(f"Variant {variant} ({desc}):")
        for name in sorted(cc[variant]['by_tool']):
            print(tool_line(name, cc[variant]['by_tool'], report_denominators, min_support, 'series'))
        print(f"- total: series {cc[variant]['series']}, calls in series {cc[variant]['calls']}")
    print()
    print(f"## (d) cycles: periods {periods_text(options['periods'])}, at least {options['min_cycle_repeats']} repetitions of a pattern with at least 2 distinct signatures, window {options['window']}")
    dd = data['d']
    print(f"- cycles: {dd['cycles']}, calls in cycles {dd['calls']}")
    for p, count in sorted(dd['by_period'].items()):
        print(f"- per period {p}: {count}")
    for tools, count in sorted(dd['by_tools'].items()):
        print(f"- participating tools {tools}: {count}")
    print()
    oo = data['polling']
    print(f"## polling (exception, not in (a)): matched calls total {oo['matched_calls_total']}, per tool: "
          + (', '.join(f'{n}: {k}' for n, k in sorted(oo['matched_calls'].items())) or 'none'))
    for variant in ('subsequence', 'strict'):
        print(f"Variant {variant}:")
        for name in sorted(oo[variant]['by_tool']):
            print(tool_line(name, oo[variant]['by_tool'], report_denominators, min_support, 'sequences'))
        if not oo[variant]['by_tool']:
            print('- no polling runs')
        print(f"- total: polling runs {oo[variant]['sequences']}, calls in runs {oo[variant]['calls']}")
    print()
    sums = data['repeat_work_sum']
    for variant, variant_label in (('subsequence', 'Variant subsequence'), ('strict', 'Variant strict')):
        print(f"repeat-work sum, {variant_label}: strict: (a)+(b before result)+(c)+(d) = "
              f"{data['a'][variant]['sequences']}+{data['b']['pairs_no_result']}+{data['c'][variant]['series']}+{data['d']['cycles']} "
              f"= {sums[variant]['strict_sum']} (strict sum); "
              f"with (b) after result = {data['a'][variant]['sequences']}+{data['b']['pairs']}+{data['c'][variant]['series']}+{data['d']['cycles']} "
              f"= {sums[variant]['with_b_after_result']}")
    print('Note: this script reports numbers only; decisions belong to the reader. The threshold defaults are starting values to tune with data.')


if __name__ == '__main__':
    sys.exit(main())
