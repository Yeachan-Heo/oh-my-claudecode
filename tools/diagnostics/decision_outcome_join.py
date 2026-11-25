#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Join Jev model and effort decisions with what happened afterwards (offline diagnostic).

Standalone diagnostic run by hand. It reads the Jev journals (applied.jsonl and shadow.jsonl with their rotated
files) and the Claude Code transcripts, and prints one row per subagent task: what Jev decided (model, effort,
decision source), what Claude Code actually started (meta.json), what the transcript shows (models, tokens,
cache, reasoning, turns, tool calls, end status), the cost in USD under a price table given by the caller, and
the gross saving (the same tokens priced at model_from minus priced at model_to). It does not change OMC behaviour
and is not shipped in the npm package (tools/ is not in the "files" list of package.json).

The script never prints the text of commands or messages from the transcripts: only numbers, identifiers and
timestamps.

Inputs (arguments only; there are no default paths):
  --journal      directory with applied.jsonl and shadow.jsonl, plus rotated files named
                 applied-YYYYMMDD-HHMMSS.jsonl or applied-YYYYMMDD-HHMMSS-<pid>.jsonl (the optional process-id
                 suffix is accepted, as written by a rotation that appends the pid); rotated files are read before the current file
  --transcripts directory with Claude Code transcripts: <project>/<session>/subagents/agent-*.meta.json and the
                 agent-*.jsonl next to them (also <project>/<session>/subagents/<child>/agent-*.jsonl)
  --from/--to    time filter on ts (ISO 8601, both ends inclusive); without them the whole file
  --prices       optional; JSON file with the price table: {"family": [input, cache write 5 min, cache write 1 h,
                 cache read, output], ...} in USD per 1 million tokens. Families are haiku, sonnet, opus,
                 fable-5-1 and fable-5-2; "haiku>100k" applies to Haiku requests above 100k tokens of input
                 (and only those: a request is priced with the one row of its own tier, so a table may hold
                 "haiku>100k" without "haiku"; a turn without a row for its tier is unpriced).
                 Without the option (or with an empty table, {}) the price table is empty: every cost is
                 unavailable (null), never zero, and one note is printed on stderr. No price table is built in
  --pointer-verbs WORD  extra verb (repeatable) that marks a pointer prompt, besides read and brief
  --source-map   SUBSTRING=LABEL (repeatable, first match wins): the task source label when the subagent
                 type contains SUBSTRING; without a match the source is "undetermined"
  --tsv          TSV file: one row per agent task
  --json         JSON file with the whole result
  --wilson-vectors  prints the Wilson test vectors (also checked by wilson_threshold.mjs) as JSON and exits (code 0)

Joining a Claude agent: an applied.jsonl row with point model-routing and a tool_use_id names the
agent-*.meta.json by toolUseId (an index over both subagents/ patterns, subagents/ and subagents/*/); the transcript
is the agent-*.jsonl next to the meta. A shadow.jsonl row with the same tool_use_id gives the Jev answers
(probabilities and confidence of the model-tier and effort questions). A duplicate tool_use_id is counted
separately and skipped; a row without tool_use_id or without meta enters the coverage denominator but not the
result rows.

Columns and statuses of an agent row: identifiers (tool_use_id, session_id, agent_id, subagent_type, ts); decision
(model_from/to, effort_from/to, decision sources per value (marker, jev, explicit, heuristic), marker,
override_rejected); the Claude Code assignment (meta_model, meta_effort); the actual (dominant_model by turns,
models_observed); model_match: match | mismatch | undetermined (no transcript or no message.model) |
no model decision; tokens and cache (input, output, cache_write_5m, cache_write_1h, cache_read; sums over all
turns of usage); reasoning with reasoning_source: usage (the sum of output_tokens_details.thinking_tokens) or
block_length (characters of thinking blocks; the usage field can be zero in some transcripts); turns (unique
message.id, else the row uuid); tool_calls (tool_use blocks, each call id once); end status (last stop_reason, is_error, api_error_status, when
present; an is_error or api_error_status field of a row is used as is, and a last assistant row marked isApiErrorMessage
sets is_error and takes the status from its text when the text holds one);
cost_status: reported | partial | unavailable; cost_usd (null when unavailable; with partial, the cost of the priced
turns only) and turns_unpriced; gross_saving (the cost of the same tokens at the model_from price minus at the model_to
price; null when model_from is empty, outside the price table, or the cost is unmeasured); the Jev margins (p1-p2 of the
probabilities of the model-tier and effort answers from the shadow row, and the confidence of each answer).

Zero is not a measurement: a model whose family is not in the price table has a null cost, never 0.0; an agent with
0 turns has cost_status unavailable and a null cost, not usd 0. Cost completeness: reported (all turns priced),
partial (some turns unpriced: cost of the priced turns only, the count in turns_unpriced), unavailable (0 turns, no
transcript, or all turns outside the price table). The total of the session is empty when any component is
unavailable; the total of the reported agents alone is given separately.

Join coverage (with the denominator, every ratio also gives a two-sided 95 % Wilson interval, z = 1.96, and a
one-sided lower bound, z = 1.645): (a) applied model-routing rows of the period joined to a transcript with turns > 0
over all such rows.

Price-consistency check: the same cost computed two ways (a loop over turns, and the price function on summed tokens)
over single-model agents must differ by less than 0.005 USD; the report gives both sums. The check guards only
against a regression (both functions use the same price table), it is not an independent check of the prices.

Exit codes: 0 valid run (also when there is no data); 2 argument or input error (missing --journal or --transcripts,
missing directory or file, bad period, bad price table, bad --source-map entry). A missing --prices is not an error.
"""
import argparse
import glob
import json
import math
import os
import re
import statistics
import sys
from collections import Counter
from datetime import datetime, timezone

PRICE_FIELDS = 5

MODEL_STATUS_MATCH = 'match'
MODEL_STATUS_MISMATCH = 'mismatch'
MODEL_STATUS_UNDETERMINED = 'undetermined'
MODEL_STATUS_NO_DECISION = 'no model decision'

SOURCE_UNDETERMINED = 'undetermined'

USAGE = (
    'usage: decision_outcome_join.py --journal <Jev journal dir> --transcripts <transcript dir>\n'
    '          [--prices <json file>] [--from <ISO>] [--to <ISO>] [--source-map SUBSTRING=LABEL]\n'
    '          [--pointer-verbs WORD] [--tsv <file>] [--json <file>]'
)


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


def model_family(model_id):
    """Family of a model identifier; an unknown model gives None (its cost is unmeasured, never zero)."""
    m = (model_id or '').lower()
    if 'haiku' in m:
        return 'haiku'
    if 'sonnet' in m:
        return 'sonnet'
    if 'opus' in m:
        return 'opus'
    if 'fable-5-2' in m:
        return 'fable-5-2'
    if 'fable' in m:
        return 'fable-5-1'
    return None


def dict_of(value):
    """The value when it is a JSON object, else an empty dict (a malformed row never ends the run)."""
    return value if isinstance(value, dict) else {}


def strip_suffix(model_id):
    """Model identifier without a bracketed suffix (for example "model[1m]" gives "model")."""
    return re.sub(r'\[[^\]]*\]$', '', str(model_id or ''))


def price_row(family, inp, cache_read, z5, z1h, prices):
    """Price row for a family (the Haiku row above 100k input tokens), or None when the family is not in the table."""
    key = 'haiku>100k' if family == 'haiku' and inp + cache_read + z5 + z1h > 100_000 else family
    return prices.get(key)


def cost_loop(requests, families, prices):
    """USD cost by a loop over turns: each turn priced with the row of its own family; unpriced turns are skipped."""
    usd = 0.0
    for (inp, z5, z1h, cache_read, out), family in zip(requests, families):
        c = price_row(family, inp, cache_read, z5, z1h, prices)
        if c is None:
            continue
        usd += (inp * c[0] + z5 * c[1] + z1h * c[2] + cache_read * c[3] + out * c[4]) / 1e6
    return usd


def cost_as(requests, family, prices):
    """USD cost of the same requests at another model's price (Haiku with the 100k threshold); None when the family is None
    or a request has no price row of its applicable tier."""
    if family is None:
        return None
    usd = 0.0
    for inp, z5, z1h, cache_read, out in requests:
        c = price_row(family, inp, cache_read, z5, z1h, prices)
        if c is None:
            return None
        usd += (inp * c[0] + z5 * c[1] + z1h * c[2] + cache_read * c[3] + out * c[4]) / 1e6
    return usd


def wilson(k, n, z):
    """Wilson interval for the ratio k/n; n = 0 gives None (no value, not 0)."""
    if n == 0:
        return None
    p = k / n
    denominator = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denominator
    half_width = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    return max(0.0, centre - half_width), min(1.0, centre + half_width)


def ratio_text(k, n):
    """k/n, percent and the Wilson intervals; given with every ratio of the report (the denominator is always shown)."""
    if n == 0:
        return f'0/{n} = no value (n = 0, not 0)'
    lower, upper = wilson(k, n, 1.96)
    lower_one_sided = wilson(k, n, 1.645)[0]
    return (f'{k}/{n} = {100.0 * k / n:.1f} % (Wilson 95 % two-sided: '
            f'[{lower:.4f}; {upper:.4f}], lower one-sided 95 %: {lower_one_sided:.4f})')


def margin(d):
    """Margin p1 - p2 from the probabilities (the two highest values)."""
    if not isinstance(d, dict):
        return None
    p = sorted((x for x in (d.get('probabilities') or {}).values()
                if isinstance(x, (int, float)) and not isinstance(x, bool)), reverse=True)
    return p[0] - p[1] if len(p) >= 2 else None


POINTER_VERBS = ('read', 'brief')


def is_pointer_task(text, extra_verbs=()):
    """Classifies a pointer prompt (a short prompt that names a file and a verb such as read or brief); the text itself is never printed."""
    pattern = re.compile(r'(/[\w.\-/]+\.(md|txt|json|toml))')
    if not isinstance(text, str):
        return False
    verbs = '|'.join(re.escape(v) for v in POINTER_VERBS + tuple(extra_verbs))
    return bool(pattern.search(text)) and len(text) < 600 and re.search(rf'(?i)({verbs})', text) is not None


def in_period(ts, period):
    start, end = period
    if start and ts < start:
        return False
    if end and ts > end:
        return False
    return True


def read_journal(directory, prefix, period):
    """Rows of <prefix>.jsonl plus the rotated <prefix>-YYYYMMDD-HHMMSS.jsonl (optionally with -<pid>) files, in chronological
    order: rotated files by their stamp, the current file last; a period filter on ts. Rows without a readable ts are skipped."""
    rotated_pattern = re.compile(rf'^{re.escape(prefix)}-\d{{8}}-\d{{6}}(?:-\d+)?\.jsonl$')
    try:
        rotated = sorted(f for f in os.listdir(directory) if rotated_pattern.match(f))
    except OSError:
        return [], 0
    paths = [os.path.join(directory, f) for f in rotated] + [os.path.join(directory, prefix + '.jsonl')]
    rows = []
    bad_ts = 0
    for path in paths:
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding='utf8', errors='replace') as f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    if not isinstance(r, dict):
                        continue
                    ts = parse_ts(r.get('ts'))
                    if ts is None:
                        bad_ts += 1
                        continue  # unreadable ts: counted separately as bad_ts
                    if not in_period(ts, period):
                        continue
                    rows.append(r)
        except OSError:
            continue
    return rows, bad_ts


def merge_usage(old, new):
    """Merging of repeated usage records of one message: the maximum of each number, recursively for dicts."""
    result = dict(old)
    for key, value in (new or {}).items():
        if isinstance(value, dict):
            result[key] = merge_usage(old.get(key) if isinstance(old.get(key), dict) else {}, value)
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            result[key] = max(value, old.get(key) if isinstance(old.get(key), (int, float)) else 0)
        elif key not in result:
            result[key] = value
    return result


# HTTP status in the text of a host API error row: "(429)" or ": 429".
API_STATUS_PATTERNS = (re.compile(r'\((\d{3})\)'), re.compile(r':\s*(\d{3})\b'))


def text_of_content(content):
    """Text of a message content: a string as is, or the text blocks joined by a space."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ''
    return ' '.join(b['text'] for b in content if isinstance(b, dict) and isinstance(b.get('text'), str))


def scan_transcript(path, prices):
    """Scan of an agent transcript: tokens and cache (sums over all turns with usage), turns (unique message.id),
    tool calls (tool_use blocks), characters of thinking blocks, reasoning (usage or block lengths), the last
    stop_reason, is_error and api_error_status, and the list of priced requests (family in the price table).
    Returns None when the file is missing."""
    if not os.path.isfile(path):
        return None
    last = {}                # message.id -> (model, usage after merging)
    turn_ids = set()
    tool_calls = 0
    thinking_chars = 0
    stop_reason = None
    is_error = None
    api_error_status = None
    seen_tool_use_ids = set()
    ended_with_api_error = False   # the last assistant row is a host API error row (isApiErrorMessage)
    api_error_text = ''
    try:
        with open(path, encoding='utf8', errors='replace') as f:
            for line in f:
                try:
                    x = json.loads(line)
                except Exception:
                    continue
                if not isinstance(x, dict):
                    continue
                if x.get('is_error') is True:
                    is_error = True
                if 'api_error_status' in x:
                    api_error_status = x['api_error_status']
                if x.get('type') != 'assistant':
                    continue
                msg = x.get('message')
                if not isinstance(msg, dict):
                    msg = {}
                ended_with_api_error = x.get('isApiErrorMessage') is True
                api_error_text = text_of_content(msg.get('content')) if ended_with_api_error else ''
                if msg.get('model') == '<synthetic>':
                    continue  # a row written by the host itself (an API error notice), not a model call
                mid = msg.get('id')
                if mid:
                    turn_ids.add(mid)
                stop = msg.get('stop_reason')
                if stop is not None:
                    stop_reason = stop
                content = msg.get('content')
                if isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get('type') == 'tool_use':
                            block_id = b.get('id')
                            if isinstance(block_id, str) and block_id:
                                if block_id in seen_tool_use_ids:
                                    continue  # a replayed copy of the same call
                                seen_tool_use_ids.add(block_id)
                            tool_calls += 1
                        elif isinstance(b, dict) and b.get('type') == 'thinking':
                            t = b.get('thinking')
                            if isinstance(t, str):
                                thinking_chars += len(t)
                u = msg.get('usage')
                if not isinstance(u, dict):
                    continue
                key = mid or x.get('uuid')
                if key is None:
                    continue
                turn_ids.add(key)  # a row without message.id is one turn, identified by its uuid
                if key in last:
                    previous_model, previous = last[key]
                    last[key] = (previous_model if model_family(previous_model) else msg.get('model'), merge_usage(previous, u))
                else:
                    last[key] = (msg.get('model'), merge_usage({}, u))
    except OSError:
        return None
    if ended_with_api_error:
        is_error = True
        if api_error_status is None:
            for pattern in API_STATUS_PATTERNS:
                found = pattern.search(api_error_text)
                if found:
                    api_error_status = int(found.group(1))
                    break
    requests = []            # (input, cache write 5 min, cache write 1 h, cache read, output) for priced turns only
    families = []            # family of each priced turn
    turns_unpriced = 0
    turn_families = Counter()  # family -> number of turns (all turns with a model)
    raw_turns = Counter()      # raw message.model -> number of turns
    thinking_usage = 0
    sum_input = sum_output = sum_z5 = sum_z1h = sum_read = 0
    # A turn (message id) without any usage has no token measurement: it is unpriced, not free.
    turns_unpriced += len(turn_ids - set(last))
    for model_id, u in last.values():
        family = model_family(model_id)
        inp = u.get('input_tokens') or 0
        cache_read = u.get('cache_read_input_tokens') or 0
        cc = dict_of(u.get('cache_creation'))
        z1h = cc.get('ephemeral_1h_input_tokens') or 0
        z5 = cc.get('ephemeral_5m_input_tokens')
        if z5 is None:
            z5 = (u.get('cache_creation_input_tokens') or 0) - z1h
        out = u.get('output_tokens') or 0
        if model_id:
            raw_turns[model_id] += 1
            turn_families[family or 'other'] += 1
        thinking_usage += (dict_of(u.get('output_tokens_details')).get('thinking_tokens') or 0)
        sum_input += inp
        sum_output += out
        sum_z5 += z5
        sum_z1h += z1h
        sum_read += cache_read
        if price_row(family, inp, cache_read, z5, z1h, prices) is None:
            turns_unpriced += 1
            continue
        requests.append((inp, z5, z1h, cache_read, out))
        families.append(family)
    if thinking_usage > 0:
        reasoning, reasoning_source = thinking_usage, 'usage'
    elif thinking_chars > 0:
        reasoning, reasoning_source = thinking_chars, 'block_length'
    else:
        reasoning, reasoning_source = None, None
    return {
        'exists': True,
        'turns': len(turn_ids),
        'tool_calls': tool_calls,
        'requests': requests,
        'families': families,
        'turns_unpriced': turns_unpriced,
        'models_by_family': dict(turn_families),
        'raw_turns': dict(raw_turns),
        'thinking_usage': thinking_usage,
        'thinking_chars': thinking_chars,
        'reasoning': reasoning,
        'reasoning_source': reasoning_source,
        'input': sum_input, 'output': sum_output, 'cache_write_5m': sum_z5, 'cache_write_1h': sum_z1h, 'cache_read': sum_read,
        'stop_reason': stop_reason,
        'is_error': is_error,
        'api_error_status': api_error_status,
    }


def cost_status(tr, prices):
    """Cost completeness and amount for a transcript scan (an unmeasured cost is never zero):
    reported (all turns priced), partial (cost of the priced turns only), unavailable (0 turns, or all turns unpriced: cost None)."""
    if tr is None or tr['turns'] == 0:
        return 'unavailable', None, 0
    priced = tr['turns'] - tr['turns_unpriced']
    if priced == 0:
        return 'unavailable', None, tr['turns_unpriced']
    status = 'partial' if tr['turns_unpriced'] > 0 else 'reported'
    usd = cost_loop(tr['requests'], tr['families'], prices)
    return status, usd, tr['turns_unpriced']


def task_source(subagent_type=None, source_map=()):
    """Task source label when the data settle it: the first SUBSTRING of source_map contained in the subagent type; otherwise undetermined (do not guess)."""
    name = subagent_type or ''
    for substring, label in source_map:
        if substring in name:
            return label
    return SOURCE_UNDETERMINED


COLUMNS = [
    'tool_use_id', 'session_id', 'agent_id', 'subagent_type', 'ts',
    'model_from', 'model_to', 'effort_from', 'effort_to',
    'decision_source_model', 'decision_source_effort', 'marker', 'override_rejected',
    'meta_model', 'meta_effort', 'models_observed', 'dominant_model', 'model_match',
    'input', 'output', 'cache_write_5m', 'cache_write_1h', 'cache_read',
    'reasoning', 'reasoning_source',
    'turns', 'tool_calls', 'turns_unpriced', 'cost_status', 'cost_usd', 'gross_saving',
    'margin_model', 'margin_effort', 'confidence_model', 'confidence_effort',
    'end_stop_reason', 'end_is_error', 'end_api_error_status',
    'started_with_model', 'started_with_effort', 'task_source',
]


def format_tsv(value):
    """Value for the TSV: None as empty (an unmeasured value is not zero), real numbers with 6 decimal places."""
    if value is None:
        return ''
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if isinstance(value, float):
        return f'{value:.6f}'
    return str(value)


def claude_row(r, m, meta_path, tr, shadow_row, prices, source_map):
    """One result row per Claude agent: Jev decision, Claude Code assignment (meta), the transcript, the cost and
    gross saving, the Jev margins."""
    applied = r.get('applied') or {}
    model_decision = applied.get('model') if isinstance(applied.get('model'), dict) else {}
    effort_decision = applied.get('effort') if isinstance(applied.get('effort'), dict) else {}
    applied_subagent_type = applied.get('subagent_type') or r.get('subagent_type') or ''
    model_to = model_decision.get('to')
    model_from = model_decision.get('from')
    dominant = None
    match = MODEL_STATUS_UNDETERMINED
    if tr is not None and tr['models_by_family']:
        dominant = max(tr['models_by_family'].items(), key=lambda pair: pair[1])[0]
        if not model_to:
            match = MODEL_STATUS_NO_DECISION
        else:
            target = model_family(model_to) or str(model_to).lower()
            match = MODEL_STATUS_MATCH if dominant == target else MODEL_STATUS_MISMATCH
    status, usd, unpriced = cost_status(tr, prices)
    saving = None
    if tr is not None and tr['requests']:
        a = cost_as(tr['requests'], model_family(model_from), prices)
        b = cost_as(tr['requests'], model_family(model_to), prices)
        if a is not None and b is not None:
            saving = a - b
    answers = (shadow_row or {}).get('answers') if isinstance((shadow_row or {}).get('answers'), dict) else {}
    margin_model = margin(answers.get('model-tier'))
    margin_effort = margin(answers.get('effort'))
    conf_model = answers.get('model-tier', {}).get('confidence') if isinstance(answers.get('model-tier'), dict) else None
    conf_effort = answers.get('effort', {}).get('confidence') if isinstance(answers.get('effort'), dict) else None
    identifier = os.path.basename(meta_path)[:-len('.meta.json')]
    return {
        'tool_use_id': r.get('tool_use_id') or '',
        'session_id': r.get('session_id') or '',
        'agent_id': m.get('agentId') or m.get('agent_id') or identifier,
        'subagent_type': applied_subagent_type,
        'ts': r.get('ts') or '',
        'model_from': model_from,
        'model_to': model_to,
        'effort_from': effort_decision.get('from'),
        'effort_to': effort_decision.get('to'),
        'decision_source_model': model_decision.get('source'),
        'decision_source_effort': effort_decision.get('source'),
        'marker': r.get('marker'),
        'override_rejected': r.get('override_rejected'),
        'meta_model': m.get('model'),
        'meta_effort': m.get('effort'),
        'models_observed': '|'.join(tr['raw_turns']) if tr is not None else '',
        'dominant_model': dominant,
        'model_match': match,
        'input': tr['input'] if tr else 0,
        'output': tr['output'] if tr else 0,
        'cache_write_5m': tr['cache_write_5m'] if tr else 0,
        'cache_write_1h': tr['cache_write_1h'] if tr else 0,
        'cache_read': tr['cache_read'] if tr else 0,
        'reasoning': tr['reasoning'] if tr else None,
        'reasoning_source': tr['reasoning_source'] if tr else None,
        'turns': tr['turns'] if tr else 0,
        'tool_calls': tr['tool_calls'] if tr else 0,
        'turns_unpriced': unpriced,
        'cost_status': status,
        'cost_usd': round(usd, 6) if usd is not None else None,
        'gross_saving': round(saving, 6) if saving is not None else None,
        'margin_model': round(margin_model, 4) if margin_model is not None else None,
        'margin_effort': round(margin_effort, 4) if margin_effort is not None else None,
        'confidence_model': conf_model,
        'confidence_effort': conf_effort,
        'end_stop_reason': tr['stop_reason'] if tr else None,
        'end_is_error': tr['is_error'] if tr else None,
        'end_api_error_status': tr['api_error_status'] if tr else None,
        'started_with_model': m.get('model'),
        'started_with_effort': m.get('effort'),
        'task_source': task_source(subagent_type=applied_subagent_type, source_map=source_map),
    }


def round_row(row):
    """Rounding of real numbers in a row (cost, saving, margins, confidence)."""
    for k in ('cost_usd', 'gross_saving', 'margin_model', 'margin_effort', 'confidence_model', 'confidence_effort'):
        if isinstance(row.get(k), float):
            row[k] = round(row[k], 6)
    return row


def write_tsv(path, rows):
    """TSV: header from COLUMNS and one row per agent; None as an empty field."""
    with open(path, 'w', encoding='utf8') as f:
        f.write('\t'.join(COLUMNS) + '\n')
        for w in rows:
            f.write('\t'.join(format_tsv(w.get(k)) for k in COLUMNS) + '\n')


def margin_groups(shadow_active, pointer_verbs=()):
    """Jev margins (p1-p2 from probabilities) and confidence of the model-tier and effort questions on shadow rows
    with mode active, grouped as pointer or full prompt by is_pointer_task on state.task (the text is never printed)."""
    result = {}
    for q in ('model-tier', 'effort'):
        groups = {'all': {'n': 0, 'margins': [], 'conf': []},
                  'pointer': {'n': 0, 'margins': [], 'conf': []},
                  'full': {'n': 0, 'margins': [], 'conf': []}}
        for r in shadow_active:
            task = (dict_of(r.get('state')).get('task') or '')
            g = 'pointer' if is_pointer_task(task, pointer_verbs) else 'full'
            a = (r.get('answers') or {}).get(q) if isinstance(r.get('answers'), dict) else None
            m = margin(a)
            conf = a.get('confidence') if isinstance(a, dict) else None
            for name in ('all', g):
                grp = groups[name]
                grp['n'] += 1
                if m is not None:
                    grp['margins'].append(m)
                if isinstance(conf, (int, float)) and not isinstance(conf, bool):
                    grp['conf'].append(conf)
        result[q] = {}
        for name, grp in groups.items():
            ms = grp['margins']
            below_01 = sum(1 for m in ms if m < 0.1 - 1e-12)
            n_m = len(ms)
            d, g = wilson(below_01, n_m, 1.96) if n_m else (None, None)
            result[q][name] = {
                'decisions': grp['n'],
                'with_margin': n_m,
                'below_01': {'k': below_01, 'n': n_m, 'share': (below_01 / n_m) if n_m else None,
                             'wilson_1_96': [d, g] if n_m else None,
                             'wilson_lower_1_645': wilson(below_01, n_m, 1.645)[0] if n_m else None},
                'mean_confidence': round(sum(grp['conf']) / len(grp['conf']), 4) if grp['conf'] else None,
            }
    return result


def load_prices(path):
    """Price table from a JSON file: {family: [5 numbers]}; a bad file is a usage error."""
    try:
        with open(path, encoding='utf8') as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        usage_error(f'--prices: unreadable price table {path}: {e}')
    if not isinstance(raw, dict):
        usage_error('--prices: the price table must be a JSON object')
    prices = {}
    for family, rates in raw.items():
        if (not isinstance(rates, list) or len(rates) != PRICE_FIELDS
                or any(not isinstance(x, (int, float)) or isinstance(x, bool) for x in rates)):
            usage_error(f'--prices: family {family} needs {PRICE_FIELDS} numbers')
        prices[str(family)] = tuple(float(x) for x in rates)
    return prices


def parse_source_map(entries):
    """SUBSTRING=LABEL entries as a list of pairs; a bad entry is a usage error."""
    pairs = []
    for entry in entries or []:
        if '=' not in entry or entry.split('=', 1)[0] == '':
            usage_error(f'--source-map: expected SUBSTRING=LABEL, got {entry}')
        substring, label = entry.split('=', 1)
        pairs.append((substring, label))
    return pairs


def main():
    ap = argparse.ArgumentParser(add_help=True, description='Join Jev decisions with the outcome of the agent (offline)')
    ap.add_argument('--journal')
    ap.add_argument('--transcripts')
    ap.add_argument('--from', dest='date_from')
    ap.add_argument('--to', dest='date_to')
    ap.add_argument('--prices')
    ap.add_argument('--source-map', action='append')
    ap.add_argument('--pointer-verbs', action='append')
    ap.add_argument('--tsv')
    ap.add_argument('--json')
    ap.add_argument('--wilson-vectors', action='store_true')
    a = ap.parse_args()

    if a.wilson_vectors:
        vectors = {}
        for k, n in [(22, 22), (20, 22), (18, 22), (10, 10), (245, 245), (15, 30), (941, 1019), (0, 30)]:
            vectors[f'{k}/{n}'] = {
                'z_1_645_lower': wilson(k, n, 1.645)[0],
                'z_1_96': list(wilson(k, n, 1.96)),
            }
        print(json.dumps(vectors, ensure_ascii=False))
        return 0

    if not a.journal or not a.transcripts:
        usage_error('missing --journal or --transcripts')
    if not os.path.isdir(a.journal):
        usage_error(f'--journal is not a directory: {a.journal}')
    if not os.path.isdir(a.transcripts):
        usage_error(f'--transcripts is not a directory: {a.transcripts}')
    o = parse_ts(a.date_from) if a.date_from else None
    d = parse_ts(a.date_to) if a.date_to else None
    if a.date_from and o is None:
        usage_error(f'--from is not an ISO date: {a.date_from}')
    if a.date_to and d is None:
        usage_error(f'--to is not an ISO date: {a.date_to}')
    period = (o, d)
    if a.prices:
        prices = load_prices(a.prices)
    else:
        prices = {}
        print('note: no --prices given: the price table is empty, every cost and saving is unavailable (null)', file=sys.stderr)
    source_map = parse_source_map(a.source_map)

    applied, applied_bad_ts = read_journal(a.journal, 'applied', period)
    shadow, shadow_bad_ts = read_journal(a.journal, 'shadow', period)
    applied_mr = [r for r in applied if r.get('point') == 'model-routing']
    shadow_mr = [r for r in shadow if r.get('point') == 'model-routing']
    shadow_active = [r for r in shadow_mr if r.get('mode') == 'active']

    ts_min = min((r.get('ts') for r in applied_mr if r.get('ts')), default=None)
    ts_max = max((r.get('ts') for r in applied_mr if r.get('ts')), default=None)

    shadow_by_tid = {}
    for r in shadow_mr:
        tid = r.get('tool_use_id')
        if tid and tid not in shadow_by_tid:
            shadow_by_tid[tid] = r

    meta_by_tid = {}
    for pattern in (os.path.join(a.transcripts, '*', '*', 'subagents', 'agent-*.meta.json'),
                    os.path.join(a.transcripts, '*', '*', 'subagents', '*', 'agent-*.meta.json')):
        for p in sorted(glob.glob(pattern)):  # sorted: the first copy of a duplicated tool_use_id is the same on every run
            try:
                with open(p, encoding='utf8') as f:
                    m = json.load(f)
            except Exception:
                continue
            tid = m.get('toolUseId')
            if tid and tid not in meta_by_tid:
                meta_by_tid[tid] = (p, m)

    agents = []
    distribution = Counter()
    seen = set()
    single_p1 = 0.0
    single_p2 = 0.0
    single_n = 0
    for r in applied_mr:
        tid = r.get('tool_use_id')
        if not tid:
            distribution['no_tool_use_id'] += 1
            continue
        found = meta_by_tid.get(tid)
        if not found:
            distribution['no_meta'] += 1
            continue
        if tid in seen:
            distribution['duplicates'] += 1
            continue
        seen.add(tid)
        p, m = found
        transcript_path = p[:-len('.meta.json')] + '.jsonl'
        tr = scan_transcript(transcript_path, prices)
        if tr is None:
            distribution['no_transcript'] += 1
            continue
        row = round_row(claude_row(r, m, p, tr, shadow_by_tid.get(tid), prices, source_map))
        agents.append(row)
        if tr['turns'] > 0:
            distribution['joined'] += 1
        else:
            distribution['zero_turns'] += 1
        if tr['requests'] and len(set(tr['families'])) == 1:
            _st, amount, _unpriced = cost_status(tr, prices)
            single_p1 += amount
            single_p2 += cost_as(tr['requests'], tr['families'][0], prices)
            single_n += 1
    distribution['bad_ts'] += applied_bad_ts
    match_counts = Counter(w['model_match'] for w in agents)
    k_a = distribution['joined']
    n_a = sum(distribution.values())

    margins = margin_groups(shadow_active, a.pointer_verbs or ())

    print('# Join of Jev decisions with the outcome (offline)')
    print()
    if ts_min:
        print(f'Period of applied (model-routing): {ts_min} .. {ts_max}')
    else:
        print('Period of applied (model-routing): no rows')
    if a.date_from or a.date_to:
        print(f'Period filter --from/--to: {a.date_from or "(none)"} .. {a.date_to or "(none)"}')
    print()
    print('## Sources')
    print(f'- applied.jsonl + rotated: {len(applied)} rows, model-routing rows: {len(applied_mr)}; with unreadable ts (counted in the denominator as bad_ts): {applied_bad_ts}; shadow with unreadable ts: {shadow_bad_ts}')
    print(f'- shadow.jsonl + rotated: {len(shadow)} rows, model-routing rows: {len(shadow_mr)}, mode=active: {len(shadow_active)}')
    print(f'- meta.json index (toolUseId): {len(meta_by_tid)} files')
    print()
    print('## Price table (--prices)')
    if prices:
        for key in sorted(prices):
            s = prices[key]
            print(f'- {key}: input {s[0]}, cache write 5 min {s[1]}, cache write 1 h {s[2]}, cache read {s[3]}, output {s[4]}')
        print('- prices in USD per 1 million tokens; the cache write rate is taken as given in the table; a cost measure, not a quality measure')
    else:
        print('- empty table: every cost is unavailable (null), no saving is computed')
    print()
    print('## Join coverage (a): applied model-routing')
    print(f'- joined to a transcript with turns > 0 / all rows: {ratio_text(k_a, n_a)}')
    print('- distribution: ' + ', '.join(f'{key}: {value}' for key, value in sorted(distribution.items())))
    print('- model match of agents: ' + ', '.join(f'{key}: {value}' for key, value in sorted(match_counts.items())))
    print()
    print('## Jev margins (shadow mode=active)')
    for q in ('model-tier', 'effort'):
        for g in ('all', 'pointer', 'full'):
            item = margins[q][g]
            lt = item['below_01']
            if lt['n']:
                text = ratio_text(lt['k'], lt['n'])
            else:
                text = 'no margin in the group (n = 0)'
            print(f"- {q} / {g}: N with margin / N decisions: {item['with_margin']}/{item['decisions']}; share below 0.1: {text}; mean confidence: {item['mean_confidence']}")
    print()
    print('## Price consistency (two functions, single-model agents)')
    difference = abs(single_p1 - single_p2)
    consistent = single_n > 0 and difference < 0.005
    print(f'- loop over turns: {single_p1:.6f} USD; price function: {single_p2:.6f} USD; difference {difference:.6f} < 0.005 USD: {"yes" if consistent else "NO"}; n = {single_n}')
    print()
    print('## Cost sums (an unmeasured cost is never zero)')
    sum_all = sum(w['cost_usd'] for w in agents if w['cost_usd'] is not None)
    sum_reported = sum(w['cost_usd'] for w in agents if w['cost_status'] == 'reported')
    n_unavailable = sum(1 for w in agents if w['cost_status'] == 'unavailable')
    total = sum_all if n_unavailable == 0 else None
    print(f'- sum (reported and partial): {sum_all:.6f} USD (n = {sum(1 for w in agents if w["cost_usd"] is not None)} of {len(agents)} agents)')
    print(f'- sum of reported only: {sum_reported:.6f} USD (n = {sum(1 for w in agents if w["cost_status"] == "reported")})')
    if total is None:
        print(f'- total: EMPTY ({n_unavailable} unavailable agents are not counted as zero)')
    else:
        print(f'- total: {total:.6f} USD')
    saving_sum = sum(w['gross_saving'] for w in agents if w['gross_saving'] is not None)
    saving_n = sum(1 for w in agents if w['gross_saving'] is not None)
    print(f'- gross saving (without the cost of Jev itself): sum {saving_sum:.6f} USD (n = {saving_n} of {len(agents)})')

    result = {
        'period': {'from': a.date_from, 'to': a.date_to, 'ts_min': ts_min, 'ts_max': ts_max},
        'applied': {'rows_in_period': len(applied), 'model-routing': len(applied_mr)},
        'shadow': {'rows_in_period': len(shadow), 'model-routing': len(shadow_mr), 'active': len(shadow_active), 'bad_ts': shadow_bad_ts},
        'join': {
            'k': k_a, 'n': n_a, 'model_match': dict(match_counts),
            'share': (k_a / n_a) if n_a else None,
            'wilson_1_96': list(wilson(k_a, n_a, 1.96)) if n_a else None,
            'wilson_lower_1_645': wilson(k_a, n_a, 1.645)[0] if n_a else None,
            'distribution': dict(distribution),
        },
        'price_consistency': {
            'n': single_n,
            'single_model_usd_p1': round(single_p1, 6),
            'single_model_usd_p2': round(single_p2, 6),
            'difference': round(abs(single_p1 - single_p2), 6),
            'consistent': single_n > 0 and abs(single_p1 - single_p2) < 0.005,
        },
        'cost_sums': {
            'reported_partial_usd': round(sum_all, 6),
            'reported_only_usd': round(sum_reported, 6),
            'total_usd': round(total, 6) if total is not None else None,
            'n_unavailable': n_unavailable,
        },
        'agents': agents,
        'margins': margins,
        'prices': {key: list(rates) for key, rates in prices.items()},
    }
    if a.tsv:
        write_tsv(a.tsv, agents)
        print()
        print(f'TSV: {a.tsv} ({len(agents)} agents)')
    if a.json:
        with open(a.json, 'w', encoding='utf8') as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
        print()
        print(f'JSON: {a.json}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
