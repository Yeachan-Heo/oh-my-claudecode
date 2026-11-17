#!/usr/bin/env python3
r"""Compaction cost and cache behaviour from Claude Code transcripts: an offline diagnostic script.

Usage: python3 -I compaction_cache_cost.py --deployed-at <ISO-8601> [--compact <compaction.jsonl>]
[--projects <dir>] [--transcript FILE ...] [--to <ISO-8601>] [--days 7] [--prices <prices.json>]
[--out <file.json>] [--json] [--details]. Offline, standard library only. Reads the session transcripts of
Claude Code (JSONL) and the compaction journal of the Jev compaction module (compaction.jsonl) and computes:
the prefix rewrite rewritten = (cc + cr)[n-1] - cr[n] (a break when > 1024) with break classes (after a
compaction, after a gap longer than the TTL of the cache write, ttl_unknown, other), the rewrite cost in USD,
the cache recovery in the first turn after a compaction, the turns to the next compaction, the breakeven
turns, whether a compaction paid back, the median of the turns between compactions, the hit-rate ceiling
(n-1)/(n+1) and the hit rate of the segments, Cache Savings (the cost without cache minus the actual cost)
and cache losses before and from a deployment date given by --deployed-at.
Prices come only from the file given with --prices (see below); without it every USD figure is unavailable.
It never judges transcript content; it only counts the usage fields and timestamps.
Without --compact the journal is compaction.jsonl in $OMC_JEV_LOG_DIR, else in .omc/state/jev under the
current directory (run the tool from the project root). With OMC_STATE_DIR set, the Jev log directory has a
project identifier in its path: pass the file with --compact or set OMC_JEV_LOG_DIR.

--prices file: {"models": {"<model id or id prefix>": {"input_per_mtok": <USD>, "output_per_mtok": <USD>}},
"subscription_prefixes": ["<model id prefix>", ...]}. Prices are USD per million tokens. A model is matched by
the exact id, otherwise by the longest listed prefix of its id. Models whose id starts with a subscription
prefix are left out of the USD sums (a flat-fee subscription has no per-token price). The cache write
price is 1.25 x the input price for a 5-minute write and 2.0 x for a 1-hour write; the cache read price is
0.10 x the input price. These multipliers are constants of the script.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from statistics import median, quantiles

# The RULE constant is part of the docstring (appended below); the report's "rule" field uses it as is.
RULE = """- Period: calls and compaction boundaries with a `timestamp` in [to - days, to]; `--to` defaults to now UTC, `--days` to 7.
- A model call: an `assistant` row with `message.usage`; global dedup by (`message.id`, `requestId`) in file order
  (modification time, path), the `usage` fields as the maximum over the response rows. Model `<synthetic>` is skipped.
  Compaction boundaries (`system`/`compact_boundary`) are deduplicated globally by `uuid` (copied history: a repeated
  boundary goes to the gap boundaries_duplicated_from_copies).
- Iterations: with an advisor call `usage.iterations` holds the `message` entries before and after the advisor and an
  `advisor_message` (the advisor model). The main `usage` fields are the sum of the `message` iterations, without the
  advisor. COST: the thread model from the main fields plus each `advisor_message` iteration at the price of its model.
  The WINDOW and the cache series (prefix rewrite, recovery, loss): from the LAST `message` iteration when there is
  one, otherwise from the main fields.
- Prefix rewrite: for consecutive calls in a file rewritten[n] = (cc + cr)[n-1] - cr[n] (from the last message
  iteration); a break when rewritten[n] > 1024. The break class, in order: after_compaction (a compaction boundary
  lies between the calls); after_ttl_gap (a gap longer than the TTL of the last cache write in this file before the
  call: 3600 s when that write had ephemeral_1h_input_tokens > 0; 300 s when only ephemeral_5m_input_tokens > 0);
  ttl_unknown (the last write has no TTL breakdown or there was no write in the file); other. The break cost in USD =
  rewritten[n] * (the cache write price of call n minus the cache read price), computed by the cost function
  (the write at the TTL price of this call: 5 min = 1.25 x input when its write_5m > 0, otherwise the 1-hour price);
  a model without a price: the break cost is "unavailable".
- For each compaction (a boundary in the period): the first call after the boundary is the unit file's call that lies
  between this boundary and the next boundary of this file (by line number); when there is none, the case is "no call
  after the boundary": model "no call after the boundary", first_turn_recovery "unavailable", rewrite_cost_usd 0,
  breakeven_turns and paid_back "unavailable". rewrite_cost_usd = the break cost of the first call after the
  boundary (no break: 0); first_turn_recovery = cr / (in + cc + cr) of the first call after the boundary;
  turns_to_next = the calls in the period after the boundary, before the next boundary of this file. segment_end has
  three values: next_boundary (the next boundary in the file has a timestamp <= to), period_end (the next boundary
  is after `to`, or there is none but the file has a call with a timestamp > to), file_end (no next boundary and no
  call after `to`). saving_per_turn_usd = (the window of the last call before the boundary - the window of the first
  call after it) * the cache read price of the first call after the boundary, 0 when negative; breakeven_turns =
  rewrite_cost_usd / saving_per_turn_usd (with a saving of 0: "unavailable"). paid_back: true when turns_to_next >=
  breakeven_turns; false when not and segment_end is next_boundary or file_end; "unavailable" when not and
  segment_end is period_end (the outcome is unknown), and when breakeven_turns is "unavailable".
- Turns between compactions: the median and quartiles of turns_to_next of the boundaries with segment_end
  next_boundary (a segment with zero calls between two boundaries enters with the value 0: that is a real double
  compaction); the hit rate of a segment between consecutive boundaries = the sum of cr / the sum of (in + cc + cr)
  next to the ceiling (n - 1) / (n + 1), n = the number of calls in the segment (the segment_hit_rates list only
  with --details).
- Cache Savings = the cost without cache (all cache_read and cache_creation at the input price) minus the actual
  cost, in USD, in total and per thread group (main, subagent).
- Cache loss: in a file, after an earlier call with cr > 0, the first call with cr = 0 and (in + cc) >= 2048 is a
  "cache loss" event; a series of 3 consecutive such calls (a call below 2048 breaks the series) or a sum of 100 000
  uncached tokens since the event (all uncached input of the calls since then) is a "persistent loss". After a
  compaction boundary the detector resets: the call right after a boundary is not a loss (it is the rewrite after
  a compaction). The number of losses per session (a session = the file's session id, with
  its subagents) separately for sessions with at least one call in the period; classified before/from the deployment
  by the first call of the session (--deployed-at); two periods are not a control arm, there is no causal
  conclusion.
- Compaction groups: a unit = a boundary (system/compact_boundary) with a timestamp in the period, once per uuid. For
  each uuid all occurrences in the transcripts are collected: file, sessionId (the first non-empty sessionId of the
  file), thread (the file name agent-<id>.jsonl without "agent-", null for a main file), timestamp. Candidates: pairs
  (occurrence, compact row with result jev or fallback) with the same session_id and agent_id as the occurrence's
  thread and |ts - timestamp| <= 600 s. Assignment: all pairs sorted ascending by (distance in seconds, uuid, file
  path, compact row number); go through them in order and take a pair when neither the uuid nor the compact row is
  assigned yet; the unit's group = the row's result, the unit's file = the file of that occurrence; the group's
  thread from the unit file. A unit without an assignment: group host, the unit file = the first file of its
  occurrences by ascending path (string comparison). The other occurrences of the uuid go to the gap
  boundaries_duplicated_from_copies.
- Boundary measures from the unit file: the first call after the boundary, the rewrite cost, recovery,
  turns_to_next, file_end, paid_back, breakeven_turns and the segment hit rates are computed from the calls of the
  unit file, in file order, with dedup only within the file (by (message.id, requestId), usage as the maximum, no
  <synthetic>). The next boundary for turns_to_next is any next boundary of this file, also a unit uuid of another
  file. The USD sums (calls_cost_usd, cache_savings_usd) and the prefix breaks are computed after global dedup in
  file order (modification time, path). The segment end is described in the bullet "For each compaction". The unit
  list is in the field units (with --details), with the field segment_end.
- USD amounts in JSON: text with 4 decimal places (Decimal).
- Share results: min_support 30; with a denominator < 30 the share and the 95 % Wilson lower bound
  (z = 1.959963984540054) are "insufficient data"; with a numerator of 0 the lower bound is 0.
- Exit codes: 0 a correct run; 1 --out cannot be written (the file already exists); 2 usage: no journal file,
  an unreadable or invalid --prices file, a bad argument."""

__doc__ = (__doc__ or "") + """

RULE (fixed before the measurement; do not change after seeing the result):
""" + RULE

REWRITE_THRESHOLD = 1024
GAP_5M_S = 300.0
GAP_1H_S = 3600.0
MATCH_WINDOW_S = 600.0
LOSS_MIN_INPUT = 2048
LOSS_SERIES = 3
LOSS_TOKEN_SUM = 100_000
MIN_SUPPORT = 30
Z_WILSON = 1.959963984540054
CACHE_WRITE_5M_MULT = Decimal("1.25")
CACHE_WRITE_1H_MULT = Decimal("2.0")
CACHE_READ_MULT = Decimal("0.10")
PER_MTOK = Decimal(1_000_000)
GROUPS = (
    "jev-main",
    "jev-subagent",
    "fallback-main",
    "fallback-subagent",
    "host-main",
    "host-subagent",
)
BREAK_CLASSES = ("after_compaction", "after_ttl_gap", "ttl_unknown", "other")


def usd(x: Decimal) -> str:
    """A USD amount as text with 4 decimal places."""
    return str(x.quantize(Decimal("0.0001")))


def round4(x) -> float:
    return round(float(x), 4)


def parse_time(text) -> "datetime | None":
    """An ISO 8601 timestamp (Z or offset) as an aware UTC datetime; None when it cannot be parsed."""
    if not isinstance(text, str) or not text:
        return None
    try:
        c = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if c.tzinfo is None:
        c = c.replace(tzinfo=timezone.utc)
    return c.astimezone(timezone.utc)


def default_compact_path() -> Path:
    """Default journal path: OMC_JEV_LOG_DIR, else .omc/state/jev under the current directory, file compaction.jsonl."""
    base = os.environ.get("OMC_JEV_LOG_DIR")
    if not base:
        base = os.path.join(os.getcwd(), ".omc", "state", "jev")
    return Path(base) / "compaction.jsonl"


def default_projects_dir() -> Path:
    """Default projects dir: CLAUDE_CONFIG_DIR/projects or ~/.claude/projects."""
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    if not base:
        base = os.path.join(os.path.expanduser("~"), ".claude")
    return Path(base) / "projects"


def agent_id_of(path: Path) -> str:
    """The agent id of a subagent transcript .../subagents/agent-<id>.jsonl; "" for a main file."""
    if path.parent.name == "subagents" and path.name.startswith("agent-") and path.name.endswith(".jsonl"):
        return path.name[len("agent-"):-len(".jsonl")]
    return ""


def session_id_of(path: Path) -> str:
    """The session id of a transcript: the file stem of a main file, the session directory of a subagent file."""
    if agent_id_of(path):
        return path.parent.parent.name
    return path.stem


def tokens_from(usage: dict) -> "tuple[int, int, int, int]":
    """(input, cache creation, cache read, output) tokens of a usage dict (or of an iteration)."""
    return (
        int(usage.get("input_tokens") or 0),
        int(usage.get("cache_creation_input_tokens") or 0),
        int(usage.get("cache_read_input_tokens") or 0),
        int(usage.get("output_tokens") or 0),
    )


def write_5m_from(usage: dict) -> "tuple[int, bool]":
    """(tokens written with the 5-minute TTL, whether a cache write came without a TTL breakdown)."""
    breakdown = usage.get("cache_creation")
    if isinstance(breakdown, dict):
        return int(breakdown.get("ephemeral_5m_input_tokens") or 0), False
    return 0, int(usage.get("cache_creation_input_tokens") or 0) > 0


class PriceTable:
    """Explicit prices from the --prices file; no default prices.

    Rates are a tuple (input, cache write 1 hour, cache read, output) in USD per million tokens."""

    def __init__(self, models: "dict[str, tuple[Decimal, Decimal]]", subscription_prefixes: "tuple[str, ...]"):
        self.models = models
        self.subscription_prefixes = subscription_prefixes

    def is_subscription(self, model: str) -> bool:
        return any(model.startswith(p) for p in self.subscription_prefixes)

    def rates(self, model: str):
        """(input, cache write 1 h, cache read, output) per million tokens, or None when the model has no price."""
        found = self.models.get(model)
        if found is None:
            best = ""
            for key in self.models:
                if model.startswith(key) and len(key) > len(best):
                    best = key
            if not best:
                return None
            found = self.models[best]
        price_in, price_out = found
        return (price_in, price_in * CACHE_WRITE_1H_MULT, price_in * CACHE_READ_MULT, price_out)

    def cost(self, tokens, rates, write_5m: int = 0) -> Decimal:
        """Cost in USD of (input, cache write, cache read, output) tokens; write_5m of the written tokens
        are priced as a 5-minute write (1.25 x input), the rest at the rate in rates[1]."""
        price_in, price_write, price_read, price_out = rates
        t_in, t_write, t_read, t_out = tokens
        write_5m = min(write_5m, t_write)
        total = (
            t_in * price_in
            + (t_write - write_5m) * price_write
            + write_5m * price_in * CACHE_WRITE_5M_MULT
            + t_read * price_read
            + t_out * price_out
        )
        return total / PER_MTOK


def load_prices(path: "Path | None") -> PriceTable:
    """Load the --prices file; without it the table is empty (every model has no price)."""
    if path is None:
        return PriceTable({}, ())
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("models"), dict):
        raise ValueError("the prices file needs a \"models\" object")
    models = {}
    for name, entry in data["models"].items():
        if not isinstance(entry, dict):
            raise ValueError(f"prices for {name}: an object is expected")
        try:
            models[str(name)] = (Decimal(str(entry["input_per_mtok"])), Decimal(str(entry["output_per_mtok"])))
        except (KeyError, ArithmeticError) as error:
            raise ValueError(f"prices for {name}: input_per_mtok and output_per_mtok are required numbers ({error})") from None
    prefixes = data.get("subscription_prefixes") or []
    if not isinstance(prefixes, list) or not all(isinstance(p, str) for p in prefixes):
        raise ValueError("subscription_prefixes must be a list of strings")
    return PriceTable(models, tuple(prefixes))


class Call:
    """One model call after dedup."""

    __slots__ = (
        "model", "tokens", "iteration", "breakdown", "write_5m", "no_ttl", "advisor",
        "time", "session", "agent", "file", "line", "rows", "key",
    )

    def __init__(self, model, tokens, iteration, breakdown, write_5m, no_ttl, advisor, time, session, agent, file, line, key):
        self.model = model
        self.tokens = tokens
        self.iteration = iteration
        self.breakdown = breakdown
        self.write_5m = write_5m
        self.no_ttl = no_ttl
        self.advisor = advisor
        self.time = time
        self.session = session
        self.agent = agent
        self.file = file
        self.line = line
        self.rows = 1
        self.key = key

    def window(self) -> "tuple[int, int, int, int]":
        """The four window tokens: the last message iteration when there is one, otherwise the main fields."""
        return self.iteration if self.iteration is not None else self.tokens

    def window_sum(self) -> int:
        return sum(self.window()[:3])

    def call_cost(self, prices: PriceTable):
        """(cost Decimal or None, gap or None): the gap is 'no_price' or 'subscription'."""
        if prices.is_subscription(self.model):
            return None, "subscription"
        rates = prices.rates(self.model)
        if rates is None:
            return None, "no_price"
        cost = prices.cost(self.tokens, rates, self.write_5m)
        for model_a, tokens_a, write_5m_a in self.advisor:
            if prices.is_subscription(model_a):
                continue
            rates_a = prices.rates(model_a)
            if rates_a is None:
                continue
            cost += prices.cost(tokens_a, rates_a, write_5m_a)
        return cost, None

    def cost_without_cache(self, prices: PriceTable):
        """The cost of all tokens at the input price; None: no price or a subscription model."""
        if prices.is_subscription(self.model):
            return None
        rates = prices.rates(self.model)
        if rates is None:
            return None
        t = self.tokens
        rates0 = (rates[0], rates[0], rates[0], rates[3])
        result = prices.cost((t[0], t[1] + t[2], 0, t[3]), rates0, 0)
        for model_a, tokens_a, _write_5m in self.advisor:
            if prices.is_subscription(model_a):
                continue
            rates_a = prices.rates(model_a)
            if rates_a is None:
                continue
            rates0_a = (rates_a[0], rates_a[0], rates_a[0], rates_a[3])
            result += prices.cost((tokens_a[0], tokens_a[1] + tokens_a[2], 0, tokens_a[3]), rates0_a, 0)
        return result


def breakdown_from(usage: dict) -> "tuple[int, int, bool] | None":
    """(5-minute write, 1-hour write, whether a TTL breakdown exists) from a usage dict (or an iteration).

    None: there was no write, or no breakdown with a zero write. A third field False with a non-zero
    write means no breakdown (the gap no_ttl_breakdown)."""
    r = usage.get("cache_creation")
    if isinstance(r, dict):
        return (int(r.get("ephemeral_5m_input_tokens") or 0), int(r.get("ephemeral_1h_input_tokens") or 0), True)
    if int(usage.get("cache_creation_input_tokens") or 0) > 0:
        return (0, 0, False)
    return None


def merge_response(current, tokens, iteration, breakdown, write_5m, no_ttl, advisor):
    """Merging the rows of one response: the usage fields as the maximum."""
    current.rows += 1
    current.tokens = tuple(max(a, b) for a, b in zip(current.tokens, tokens, strict=True))
    if iteration is not None:
        current.iteration = tuple(max(a, b) for a, b in zip(current.iteration, iteration, strict=True)) if current.iteration else iteration
    if breakdown is not None:
        if current.breakdown is None:
            current.breakdown = breakdown
        else:
            w5m = max(current.breakdown[0], breakdown[0])
            w1h = max(current.breakdown[1], breakdown[1])
            current.breakdown = (w5m, w1h, current.breakdown[2] or breakdown[2])
    current.write_5m = max(current.write_5m, write_5m)
    current.no_ttl = current.no_ttl and no_ttl
    if sum(sum(t) for _, t, _ in advisor) > sum(sum(t) for _, t, _ in current.advisor):
        current.advisor = advisor


def load_calls(files):
    """API responses from the transcripts: global dedup by (message.id, requestId) and dedup within each file.

    The global dedup (file order: modification time, path) feeds the USD sums and the prefix breaks; the dedup
    within a file feeds the boundary measures of the units. Returns (global list, gaps, rows, bad lines,
    {file: the file's calls after dedup within the file})."""
    best = {}
    file_calls = {}
    gaps = {"no_price": 0, "subscription": 0, "no_ttl_breakdown": 0, "zero_window": 0}
    rows = 0
    bad = 0
    for path in files:
        session = session_id_of(path)
        agent = agent_id_of(path)
        local = {}
        with path.open(encoding="utf-8", errors="replace") as f:
            for nr, line in enumerate(f, 1):
                if not line.strip():
                    continue
                rows += 1
                if '"usage"' not in line:
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    bad += 1
                    continue
                if not isinstance(o, dict):
                    bad += 1
                    continue
                msg = o.get("message")
                if not isinstance(msg, dict) or msg.get("role") != "assistant":
                    continue
                usage = msg.get("usage")
                model = msg.get("model") or ""
                if not isinstance(usage, dict) or not model:
                    continue
                if model == "<synthetic>":
                    continue
                key = (str(msg.get("id") or o.get("uuid")), str(o.get("requestId") or ""))
                tokens = tokens_from(usage)
                iteration = None
                window_source = usage
                for it in usage.get("iterations") or []:
                    if isinstance(it, dict) and it.get("type") == "message":
                        iteration = tokens_from(it)
                        window_source = it
                breakdown = breakdown_from(window_source)
                advisor = [
                    (str(it.get("model") or "?"), tokens_from(it), write_5m_from(it)[0])
                    for it in usage.get("iterations") or []
                    if isinstance(it, dict) and it.get("type") == "advisor_message"
                ]
                write_5m, no_ttl = write_5m_from(usage)
                current = local.get(key)
                if current is None:
                    local[key] = Call(
                        model, tokens, iteration, breakdown, write_5m, no_ttl, advisor,
                        parse_time(o.get("timestamp")), session, agent, path, nr, key,
                    )
                    continue
                merge_response(current, tokens, iteration, breakdown, write_5m, no_ttl, advisor)
        for w in local.values():
            current_g = best.get(w.key)
            if current_g is None:
                best[w.key] = w
            else:
                merge_response(current_g, w.tokens, w.iteration, w.breakdown, w.write_5m, w.no_ttl, w.advisor)
        file_calls[path] = list(local.values())
    for w in best.values():
        if w.breakdown is None:
            w.breakdown = (0, 0, False)
    result = list(best.values())
    return result, gaps, rows, bad, file_calls


def wilson_lower(count: int, total: int):
    """The 95 % Wilson lower bound (z = 1.959963984540054); a denominator < 30: "insufficient data".

    With a numerator of 0 the lower bound is 0.0."""
    if total < MIN_SUPPORT:
        return "insufficient data"
    if count == 0:
        return 0.0
    p = count / total
    z = Z_WILSON
    lower = (p + z * z / (2 * total) - z * ((p * (1 - p) / total + z * z / (4 * total * total)) ** 0.5)) / (1 + z * z / total)
    return round4(lower)


def quartiles(data: list):
    """Quartiles [q1, median, q3] (statistics.quantiles inclusive); empty: "unavailable"; one element: the value three times."""
    if not data:
        return "unavailable"
    if len(data) == 1:
        v = data[0]
        return [v, v, v]
    return list(quantiles(data, n=4, method="inclusive"))


def distribution(values: list):
    """The distribution of values as a dict; an empty list: "unavailable" (no values is never 0)."""
    if not values:
        return "unavailable"
    result = {}
    for w in values:
        k = str(w)
        result[k] = result.get(k, 0) + 1
    return result


def load_jsonl(path: Path) -> "tuple[list, int, int]":
    """(row dicts with the line number added as _line, the number of non-empty rows, bad lines)."""
    rows = []
    count = 0
    bad = 0
    with path.open(encoding="utf-8", errors="replace") as f:
        for nr, line in enumerate(f, 1):
            if not line.strip():
                continue
            count += 1
            try:
                o = json.loads(line)
            except ValueError:
                bad += 1
                continue
            if not isinstance(o, dict):
                bad += 1
                continue
            o["_line"] = nr
            rows.append(o)
    return rows, count, bad


def boundaries_from_files(files):
    """The compact_boundary occurrences in the transcripts, without dedup; one pass over the lines of a file.

    Counts all non-empty lines and bad lines (non-object JSON) of each file. The file's sessionId = the first
    non-empty sessionId of the WHOLE file, fixed before the boundaries are built (filled in after the pass).
    Each occurrence: file, line, ts, ts_lit, uuid, trigger, session. Returns (occurrences, rows, bad lines)."""
    boundaries = []
    rows = 0
    bad = 0
    for path in files:
        sid = ""
        file_boundaries = []
        with path.open(encoding="utf-8", errors="replace") as f:
            for nr, line in enumerate(f, 1):
                if not line.strip():
                    continue
                rows += 1
                try:
                    o = json.loads(line)
                except ValueError:
                    bad += 1
                    continue
                if not isinstance(o, dict):
                    bad += 1
                    continue
                if not sid:
                    s = o.get("sessionId")
                    if isinstance(s, str) and s:
                        sid = s
                if o.get("type") != "system" or o.get("subtype") != "compact_boundary":
                    continue
                uuid = str(o.get("uuid") or f"{path}:{o.get('timestamp')}")
                meta = o.get("compactMetadata")
                trigger = "none"
                if isinstance(meta, dict) and meta.get("trigger") is not None:
                    trigger = str(meta.get("trigger"))
                file_boundaries.append({
                    "file": path,
                    "line": nr,
                    "ts": parse_time(o.get("timestamp")),
                    "ts_lit": str(o.get("timestamp") or ""),
                    "uuid": uuid,
                    "trigger": trigger,
                })
        for g in file_boundaries:
            g["session"] = sid
        boundaries.extend(file_boundaries)
    return boundaries, rows, bad


def load_compact(path: Path):
    """The compact and after rows of the compaction journal plus consistency gaps.

    Returns (compact, after, rows, bad lines, gaps {compact_without_after, after_without_compact})."""
    rows, count, bad = load_jsonl(path)
    compact = [w for w in rows if w.get("event") == "compact"]
    after = [w for w in rows if w.get("event") == "after"]
    ts_compact = {str(w.get("ts")) for w in compact}
    after_of = {str(w.get("compact_ts")) for w in after}
    gaps = {
        "compact_without_after": sum(1 for w in compact if str(w.get("ts")) not in after_of),
        "after_without_compact": sum(1 for w in after if str(w.get("compact_ts")) not in ts_compact),
    }
    return compact, after, count, bad, gaps


def break_cost(prices: PriceTable, call, rewritten: int):
    """The prefix break cost in USD, or None when the model has no price or is a subscription model."""
    if prices.is_subscription(call.model):
        return None
    rates = prices.rates(call.model)
    if rates is None:
        return None
    z5m = call.write_5m
    write = prices.cost((0, rewritten, 0, 0), rates, rewritten if z5m > 0 else 0)
    read = prices.cost((0, 0, rewritten, 0), rates)
    return write - read


def match_units(period_boundaries, compact_rows):
    """Assignment of boundaries (by uuid) to compact rows in pairs; a unit = a uuid with a timestamp in the period.

    Pairs (occurrence, compact row) with the same session_id and agent_id as the occurrence's thread,
    |ts - timestamp| <= 600 s, result jev or fallback; sorted by (distance, uuid, file path, compact row
    number); a pair is taken when neither the uuid nor the row is assigned yet.
    Without an assignment: host, the unit file = the first file of the occurrences by ascending path.
    Returns (the units list by (ts, file, uuid), the gap boundaries_duplicated_from_copies)."""
    by_uuid = {}
    for g in period_boundaries:
        by_uuid.setdefault(g["uuid"], []).append(g)
    pairs = []
    for uuid, occs in by_uuid.items():
        for occ in occs:
            agent_occ = agent_id_of(occ["file"]) or None
            for c in compact_rows:
                if c.get("result") not in ("jev", "fallback"):
                    continue
                if str(c.get("session_id") or "") != occ["session"]:
                    continue
                c_raw = c.get("agent_id")
                c_agent = None if c_raw in (None, "", "null") else str(c_raw).removeprefix("agent-")
                if c_agent != agent_occ:
                    continue
                ts_c = parse_time(c.get("ts"))
                if occ["ts"] is None or ts_c is None:
                    continue
                d = abs((ts_c - occ["ts"]).total_seconds())
                if d <= MATCH_WINDOW_S:
                    pairs.append((d, uuid, str(occ["file"]), int(c.get("_line", 0)), occ, c))
    pairs.sort(key=lambda p: (p[0], p[1], p[2], p[3]))
    used_rows = set()
    units = {}
    for _d, uuid, _file_s, _nr, occ, c in pairs:
        if uuid in units or id(c) in used_rows:
            continue
        used_rows.add(id(c))
        file_u = occ["file"]
        agent_u = agent_id_of(file_u) or None
        units[uuid] = {
            "uuid": uuid,
            "file": file_u,
            "occ": occ,
            "result": str(c.get("result")),
            "group": f"{c.get('result')}-{'subagent' if agent_u else 'main'}",
            "files_with_boundary": len(by_uuid[uuid]),
            "trigger": occ["trigger"],
        }
    for uuid, occs in by_uuid.items():
        if uuid in units:
            continue
        occ = min(occs, key=lambda o: str(o["file"]))
        agent_u = agent_id_of(occ["file"]) or None
        units[uuid] = {
            "uuid": uuid, "file": occ["file"], "occ": occ, "result": "host",
            "group": f"host-{'subagent' if agent_u else 'main'}",
            "files_with_boundary": len(occs), "trigger": occ["trigger"],
        }
    ordered = sorted(units.values(), key=lambda j: (j["occ"]["ts"], str(j["file"]), j["uuid"]))
    dup_gap = sum(len(o) - 1 for o in by_uuid.values())
    return ordered, dup_gap


def file_boundary_measures(calls, boundary_lines, boundary_ts, prices, start, end, path):
    """The boundary measures of one file from the calls of that file (dedup only within the file).

    The first call after a boundary: only between the boundary and the next boundary of this file (by line
    number); without such a call first_after = None (the case "no call after the boundary"). turns_to_next = the
    calls in the period after the boundary, before the next boundary. segment_end has three values:
    next_boundary (the next boundary has ts <= end), period_end (the next boundary is after the end, or there
    is none but the file has a call with ts > end), file_end (no next boundary and no call after the end).
    Returns ({line: {first_after, last_before, turns, segment_end}}, segments, {line: (rewritten, cost)})."""
    def in_period(c):
        return c.time is not None and start <= c.time <= end

    break_map = {}
    previous = None
    for w in calls:
        if previous is not None:
            rewritten = (previous.window()[1] + previous.window()[2]) - w.window()[2]
            if rewritten > REWRITE_THRESHOLD:
                break_map[w.line] = (rewritten, break_cost(prices, w, rewritten))
        previous = w

    has_call_after_end = any(c.time is not None and c.time > end for c in calls)
    boundary_measures = {}
    for i, line_b in enumerate(boundary_lines):
        next_line = boundary_lines[i + 1] if i + 1 < len(boundary_lines) else None
        first_after = None
        last_before = None
        turns = 0
        for c in calls:
            if c.line < line_b:
                last_before = c
            elif c.line > line_b and (next_line is None or c.line < next_line):
                if first_after is None:
                    first_after = c
                if in_period(c):
                    turns += 1
        if next_line is not None:
            segment_end = "next_boundary" if boundary_ts[i + 1] is not None and boundary_ts[i + 1] <= end else "period_end"
        else:
            segment_end = "file_end" if not has_call_after_end else "period_end"
        boundary_measures[line_b] = {"first_after": first_after, "last_before": last_before, "turns": turns, "segment_end": segment_end}

    segments = []
    for i in range(len(boundary_lines) - 1):
        line_1 = boundary_lines[i]
        line_2 = boundary_lines[i + 1]
        sum_cr = 0
        sum_window = 0
        n_seg = 0
        for c in calls:
            if line_1 < c.line < line_2 and in_period(c):
                window_c = c.window()
                sum_cr += window_c[2]
                sum_window += window_c[0] + window_c[1] + window_c[2]
                n_seg += 1
        segments.append({
            "file": str(path),
            "n": n_seg,
            "hit": round4(sum_cr / sum_window) if sum_window else "unavailable",
            "ceiling": round4((n_seg - 1) / (n_seg + 1)) if n_seg > 0 else "unavailable",
        })
    return boundary_measures, segments, break_map


def analyze_file(calls, file_boundaries, prices, start, end):
    """Prefix breaks from the calls after global dedup (feeds the rewrites and the break results).

    Returns a list of records {class, rewritten, cost, in_period, file, line}."""
    boundary_lines = [g["line"] for g in file_boundaries]

    def boundary_between(a, b) -> bool:
        return any(a.line < line_b < b.line for line_b in boundary_lines)

    def in_period(c) -> bool:
        return c.time is not None and start <= c.time <= end

    breaks = []

    previous = None
    last_write = None
    for w in calls:
        if previous is not None:
            rewritten = (previous.window()[1] + previous.window()[2]) - w.window()[2]
            if rewritten > REWRITE_THRESHOLD:
                if boundary_between(previous, w):
                    klass = "after_compaction"
                else:
                    ttl = None
                    if last_write is not None and last_write[2]:
                        if last_write[1] > 0:
                            ttl = GAP_1H_S
                        elif last_write[0] > 0:
                            ttl = GAP_5M_S
                    gap = None
                    if w.time is not None and previous.time is not None:
                        gap = (w.time - previous.time).total_seconds()
                    if ttl is None:
                        klass = "ttl_unknown"
                    elif gap is None:
                        klass = "other"
                    elif gap > ttl:
                        klass = "after_ttl_gap"
                    else:
                        klass = "other"
                breaks.append({
                    "class": klass,
                    "rewritten": rewritten,
                    "cost": break_cost(prices, w, rewritten),
                    "in_period": in_period(w),
                    "file": w.file,
                    "line": w.line,
                })
        if w.window()[1] > 0:
            last_write = w.breakdown
        previous = w
    return breaks


def file_cache_losses(calls: list, file_boundaries: list, start, end) -> list:
    """Cache loss events in a file; boundaries reset the detector; computed on the calls in the period."""
    events = [(c.line, "c", c) for c in calls] + [(g["line"], "b", g) for g in file_boundaries]
    events.sort(key=lambda t: t[0])
    losses = []
    had_cache = False
    in_event = False
    series = 0
    total = 0
    for _line, kind, obj in events:
        if kind == "b":
            had_cache = False
            in_event = False
            series = 0
            total = 0
            continue
        c = obj
        if c.time is None or not (start <= c.time <= end):
            continue
        window_l = c.window()
        cr = window_l[2]
        uncached = window_l[0] + window_l[1]
        if cr > 0:
            had_cache = True
            in_event = False
            series = 0
            total = 0
            continue
        if in_event:
            # A series is consecutive calls that each meet the minimum; a smaller call breaks it. The token sum
            # runs over all uncached input since the event, whatever the size of each call.
            series = series + 1 if uncached >= LOSS_MIN_INPUT else 0
            total += uncached
            if series >= LOSS_SERIES or total >= LOSS_TOKEN_SUM:
                losses[-1]["persistent"] = True
        elif had_cache and uncached >= LOSS_MIN_INPUT:
            in_event = True
            series = 1
            total = uncached
            losses.append({"session": c.session, "persistent": total >= LOSS_TOKEN_SUM})
    return losses


def median_or_unavailable(data: list):
    """The median rounded to 4 places, or "unavailable" for an empty list."""
    if not data:
        return "unavailable"
    return round4(median(data))


def write_result(path: Path, data: dict):
    """Write JSON to a new file (exclusive mode, 0600); returns (True, None) or (False, an error message)."""
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return False, f"the --out file exists: {path}"
    except OSError as error:
        return False, f"cannot write --out: {error}"
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return True, None


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--compact", type=Path, default=default_compact_path(), metavar="FILE", help="the compaction journal (default: compaction.jsonl in $OMC_JEV_LOG_DIR, else in .omc/state/jev under the current directory; with OMC_STATE_DIR set, pass the file or set OMC_JEV_LOG_DIR)")
    ap.add_argument("--projects", type=Path, default=default_projects_dir(), help="the projects directory to scan (without --transcript)")
    ap.add_argument("--transcript", action="append", type=Path, metavar="FILE", help="a transcript to analyse (repeatable; instead of scanning)")
    ap.add_argument("--to", metavar="ISO", default=None, help="period end (ISO 8601; defaults to now UTC)")
    ap.add_argument("--days", type=int, default=7, help="period length in days")
    ap.add_argument("--deployed-at", metavar="ISO", required=True, help="the deployment time of the compaction module (ISO 8601); splits the cache loss sessions")
    ap.add_argument("--prices", type=Path, default=None, help="a JSON price table (USD per million tokens); without it USD figures are unavailable")
    ap.add_argument("--out", type=Path, default=None, help="write to a new file (0600; an existing file: exit 1)")
    ap.add_argument("--json", action="store_true", help="the result as one JSON object (the compaction-report/1 template)")
    ap.add_argument("--details", action="store_true", help="adds segment_hit_rates and units to the report")
    a = ap.parse_args(argv)

    end = parse_time(a.to) if a.to else datetime.now(timezone.utc)
    if end is None:
        print("error: bad --to (ISO 8601)", file=sys.stderr)
        return 2
    start = end - timedelta(days=a.days)
    deployed = parse_time(a.deployed_at)
    if deployed is None:
        print("error: bad --deployed-at", file=sys.stderr)
        return 2
    if not a.compact.is_file():
        print(f"error: no --compact file: {a.compact}", file=sys.stderr)
        return 2
    for t in a.transcript or []:
        if not t.is_file():
            print(f"error: no transcript file: {t}", file=sys.stderr)
            return 2
    try:
        prices = load_prices(a.prices)
    except (OSError, ValueError) as error:
        print(f"error: cannot load --prices: {error}", file=sys.stderr)
        return 2

    if a.transcript:
        files = list(a.transcript)
    else:
        project_dirs = [k for k in a.projects.glob("*") if k.is_dir()]
        files = [p for k in project_dirs for p in k.rglob("*.jsonl")]
        files.sort(key=lambda p: (p.stat().st_mtime, str(p)))

    calls_all, gaps_t, rows_t, bad_t, file_calls = load_calls(files)
    boundaries, rows_full, bad_full = boundaries_from_files(files)
    compact_rows, _after, rows_c, bad_c, gaps_c = load_compact(a.compact)

    in_range = [z for z in calls_all if z.time is not None and start <= z.time <= end]
    period_boundaries = [g for g in boundaries if g["ts"] is not None and start <= g["ts"] <= end]

    units, dup_gap = match_units(period_boundaries, compact_rows)

    files_seq = {}
    boundaries_seq = {}
    for z in calls_all:
        files_seq.setdefault(z.file, []).append(z)
    for g in boundaries:
        boundaries_seq.setdefault(g["file"], []).append(g)

    # prefix breaks: global dedup (rewrites, break results)
    breaks_all = []
    for path, calls in files_seq.items():
        breaks_all.extend(analyze_file(calls, boundaries_seq.get(path, []), prices, start, end))

    # boundary measures per unit file (dedup only within the file)
    file_measures = {}
    segments_all = []
    for j in units:
        file_j = j["file"]
        if file_j in file_measures:
            continue
        calls_f = file_calls.get(file_j, [])
        boundaries_f = sorted(boundaries_seq.get(file_j, []), key=lambda g: g["line"])
        lines_f = [g["line"] for g in boundaries_f]
        ts_f = [g["ts"] for g in boundaries_f]
        bm_f, seg_f, breaks_f = file_boundary_measures(calls_f, lines_f, ts_f, prices, start, end, file_j)
        file_measures[file_j] = (bm_f, breaks_f)
        segments_all.extend(seg_f)

    # unit measures: rewrite cost, recovery, saving per turn, breakeven turns, paid back
    for j in units:
        bm_f, breaks_f = file_measures.get(j["file"], ({}, {}))
        m = bm_f.get(j["occ"]["line"], {"first_after": None, "last_before": None, "turns": 0, "segment_end": "file_end"})
        fa = m["first_after"]
        lb = m["last_before"]
        rewrite_cost = "unavailable"
        recovery = "unavailable"
        breakeven = "unavailable"
        paid_back = "unavailable"
        segment_end = m["segment_end"]
        if fa is None:
            rewrite_cost = Decimal(0)
        else:
            record = breaks_f.get(fa.line)
            if record is None:
                rewrite_cost = Decimal(0)
            elif record[1] is None:
                rewrite_cost = "unavailable"
            else:
                rewrite_cost = record[1]
            window_fa = fa.window()
            denominator = window_fa[0] + window_fa[1] + window_fa[2]
            if denominator > 0:
                recovery = round4(window_fa[2] / denominator)
            rates_fa = prices.rates(fa.model)
            saving = "unavailable"
            if lb is not None and not prices.is_subscription(fa.model) and rates_fa is not None:
                delta = lb.window_sum() - fa.window_sum()
                saving = prices.cost((0, 0, delta, 0), rates_fa) if delta > 0 else Decimal(0)
                if isinstance(rewrite_cost, Decimal):
                    breakeven = float(rewrite_cost / saving) if saving > 0 else "unavailable"
            if isinstance(breakeven, float):
                if m["turns"] >= breakeven:
                    paid_back = True
                elif segment_end in ("next_boundary", "file_end"):
                    paid_back = False
                else:
                    paid_back = "unavailable"
        j["model"] = fa.model if fa is not None else "no call after the boundary"
        j["turns"] = 0 if fa is None else m["turns"]
        j["segment_end"] = segment_end
        j["recovery"] = recovery
        j["rewrite_cost"] = rewrite_cost
        j["breakeven"] = breakeven
        j["paid_back"] = paid_back

    group_data = {}
    for grp in GROUPS:
        group_data[grp] = {
            "boundaries": 0, "costs": [], "turns_next": [], "recoveries": [], "breakevens": [],
            "paid_back": 0, "decided": 0,
        }
    model_list = []
    triggers = []
    for j in units:
        grp = group_data[j["group"]]
        grp["boundaries"] += 1
        if isinstance(j["rewrite_cost"], Decimal):
            grp["costs"].append(j["rewrite_cost"])
        if j["segment_end"] == "next_boundary":
            grp["turns_next"].append(j["turns"])
        if isinstance(j["recovery"], float):
            grp["recoveries"].append(j["recovery"])
        if isinstance(j["breakeven"], float):
            grp["breakevens"].append(j["breakeven"])
        if j["paid_back"] is True:
            grp["paid_back"] += 1
        if j["paid_back"] in (True, False):
            grp["decided"] += 1
        model_list.append(j["model"])
        triggers.append(j["trigger"])

    breaks_period = [z for z in breaks_all if z["in_period"]]
    rewrites = {klass: {"count": 0, "costs": []} for klass in BREAK_CLASSES}
    for z in breaks_period:
        rewrites[z["class"]]["count"] += 1
        if z["cost"] is not None:
            rewrites[z["class"]]["costs"].append(z["cost"])
    savings_total = Decimal(0)
    savings_main = Decimal(0)
    savings_subagent = Decimal(0)
    calls_cost = Decimal(0)
    for z in in_range:
        k, gap = z.call_cost(prices)
        if gap == "no_price":
            gaps_t["no_price"] += 1
        elif gap == "subscription":
            gaps_t["subscription"] += 1
        if z.no_ttl:
            gaps_t["no_ttl_breakdown"] += 1
        if z.window_sum() == 0:
            gaps_t["zero_window"] += 1
        if k is not None:
            calls_cost += k
        kb = z.cost_without_cache(prices)
        if k is not None and kb is not None:
            s = kb - k
            savings_total += s
            if z.agent:
                savings_subagent += s
            else:
                savings_main += s

    all_losses = []
    for path, calls in files_seq.items():
        all_losses.extend(file_cache_losses(calls, boundaries_seq.get(path, []), start, end))
    first_time = {}
    for z in calls_all:
        if z.time is not None and (z.session not in first_time or z.time < first_time[z.session]):
            first_time[z.session] = z.time
    sessions_in_period = {z.session for z in in_range}
    set_before = {s for s in sessions_in_period if first_time.get(s) is not None and first_time[s] < deployed}
    set_from = {s for s in sessions_in_period if first_time.get(s) is not None and first_time[s] >= deployed}
    losses_before = [u for u in all_losses if u["session"] in set_before]
    losses_from = [u for u in all_losses if u["session"] in set_from]

    def loss_stats(events, n_sessions):
        sessions_u = {u["session"] for u in events}
        return {
            "sessions": n_sessions,
            "sessions_with_loss": len(sessions_u),
            "losses": len(events),
            "persistent_losses": sum(1 for u in events if u["persistent"]),
        }

    cache_loss = {
        "before_deployment": loss_stats(losses_before, len(set_before)),
        "from_deployment": loss_stats(losses_from, len(set_from)),
    }

    def share_entry(numerator, denominator):
        if denominator < MIN_SUPPORT:
            return "insufficient data", "insufficient data"
        return round4(numerator / denominator), wilson_lower(numerator, denominator)

    results = []
    for grp in GROUPS:
        d = group_data[grp]
        k_, n_ = d["paid_back"], d["decided"]
        share_, wilson_ = share_entry(k_, n_)
        results.append({
            "name": f"{grp}: compactions paid back before the next one",
            "numerator": k_, "denominator": n_, "share": share_, "wilson_lower_95": wilson_,
        })
    breaks_denominator = len(breaks_period)
    class_names = {
        "after_compaction": "prefix breaks after a compaction",
        "after_ttl_gap": "prefix breaks after a TTL gap",
        "ttl_unknown": "prefix breaks with ttl_unknown",
        "other": "prefix breaks other",
    }
    for klass in BREAK_CLASSES:
        k_ = rewrites[klass]["count"]
        share_, wilson_ = share_entry(k_, breaks_denominator)
        results.append({
            "name": class_names[klass], "numerator": k_, "denominator": breaks_denominator,
            "share": share_, "wilson_lower_95": wilson_,
        })
    for label, session_set, events_u in (
        ("sessions with a cache loss before the deployment", set_before, losses_before),
        ("sessions with a cache loss from the deployment", set_from, losses_from),
    ):
        k_ = len({u["session"] for u in events_u})
        share_, wilson_ = share_entry(k_, len(session_set))
        results.append({
            "name": label, "numerator": k_, "denominator": len(session_set),
            "share": share_, "wilson_lower_95": wilson_,
        })

    jev_m = group_data["jev-main"]
    fb_m = group_data["fallback-main"]
    if jev_m["decided"] >= MIN_SUPPORT and fb_m["decided"] >= MIN_SUPPORT:
        pj = jev_m["paid_back"] / jev_m["decided"]
        pf = fb_m["paid_back"] / fb_m["decided"]
        comparison = {
            "description": "compactions paid back in the main thread: jev against the host fallback",
            "paid_back_jev": jev_m["paid_back"], "denominator_jev": jev_m["decided"], "share_jev": round4(pj),
            "paid_back_fallback": fb_m["paid_back"], "denominator_fallback": fb_m["decided"], "share_fallback": round4(pf),
            "share_difference": round4(pj - pf),
        }
    else:
        comparison = "insufficient data (n jev-main {}, n fallback-main {})".format(jev_m["decided"], fb_m["decided"])

    n_host_main = group_data["host-main"]["boundaries"]
    if n_host_main > 0:
        control_arm = {
            "description": "host compactions without the Jev module (a boundary without a compact row), main thread",
            "n": n_host_main,
        }
    else:
        control_arm = {"none": "there were no host compactions in the main thread in the period"}

    compaction_cost = {}
    turns_between = {}
    recovery_fields = {}
    breakeven_fields = {}
    for grp in GROUPS:
        d = group_data[grp]
        costs_g = d["costs"]
        sum_g = sum(costs_g, Decimal(0))
        kq = quartiles(costs_g)
        compaction_cost[grp] = {
            "n": d["boundaries"],
            "n_with_costs": len(costs_g),
            "sum_usd": usd(sum_g) if costs_g else ("0.0000" if d["boundaries"] == 0 else "unavailable"),
            "median_usd": usd(median(costs_g)) if costs_g else "unavailable",
            "quartiles_usd": [usd(x) for x in kq] if isinstance(kq, list) else "unavailable",
        }
        kq_turns = quartiles(d["turns_next"])
        turns_between[grp] = {
            "n": len(d["turns_next"]),
            "median": median_or_unavailable(d["turns_next"]),
            "quartiles": [round4(x) for x in kq_turns] if isinstance(kq_turns, list) else "unavailable",
        }
        recovery_fields[grp] = median_or_unavailable(d["recoveries"])
        breakeven_fields[grp] = median_or_unavailable(d["breakevens"])

    rewrites_field = {}
    for klass in BREAK_CLASSES:
        count = rewrites[klass]["count"]
        costs_k = rewrites[klass]["costs"]
        if costs_k:
            sum_k = usd(sum(costs_k, Decimal(0)))
        elif count == 0:
            sum_k = "0.0000"
        else:
            sum_k = "unavailable"
        rewrites_field[klass] = {"count": count, "sum_usd": sum_k}

    if a.transcript:
        transcript_source = f"transcripts: --transcript ({len(files)} files)"
    else:
        transcript_source = f"transcripts: <{a.projects}>/**/*.jsonl"
    quality = [
        {"source": str(a.compact), "rows": rows_c, "bad_lines": bad_c, "gaps": gaps_c},
        {
            "source": transcript_source,
            "rows": rows_full, "bad_lines": bad_full,
            "gaps": {
                "no_price": gaps_t["no_price"],
                "subscription": gaps_t["subscription"],
                "no_ttl_breakdown": gaps_t["no_ttl_breakdown"],
                "boundaries_duplicated_from_copies": dup_gap,
                "zero_window": gaps_t["zero_window"],
            },
        },
    ]

    caveats = [
        "The cost of requests to the Jev backend and of the host summary is not in the transcript, so the compaction cost is only the cache rewrite visible in the transcript.",
        "Two periods before and after the deployment are not a control arm; cache losses are given with n sessions on each side, without a causal conclusion.",
        "Window drops from other causes lower the saving per turn.",
        "Models without a price in the --prices table and models with a subscription prefix are outside the USD sums.",
        "A compact row with a result other than jev/fallback is not an assignment candidate; a unit without an assignment gets the group host, and its unit file is the first file of its occurrences by ascending path.",
        "A break whose call pair has no timestamps while a TTL breakdown exists goes to the class other.",
        "turns_to_next and paid_back are computed on the calls in the period; the first call after a boundary and the breaks use neighbours from outside the period when those are the actual neighbours in the file.",
        "The jev against fallback comparison is given only when both main-thread groups have at least 30 compactions with a decided paid_back.",
        "Cache loss is computed on the calls in the period; boundaries reset the detector also outside the period; the denominator sessions before/from the deployment are only sessions with at least one call in the period.",
        "The boundary measures (the first call after a boundary, rewrite cost, recovery, turns_to_next, paid_back, segment hit rates) come from the calls of the unit file with dedup only within the file; the USD sums and the prefix breaks come after global dedup in file order (modification time, path).",
        "A segment with zero calls between two boundaries stays in turns_between_compactions with the value 0, because it is a real double compaction; the call measures of the first of these boundaries are the case no call after the boundary (breakeven_turns and paid_back are then unavailable).",
        "The period field is the requested analysis window [to - days, to]; the actual data range (the earliest and the latest timestamp of the unit boundaries) is in the field data_range.",
    ]
    unit_costs = sum((d["costs"] for d in group_data.values()), [])
    if usd(sum(unit_costs, Decimal(0))) != rewrites_field["after_compaction"]["sum_usd"]:
        caveats.append(
            "The sum of compaction_cost differs from rewrites.after_compaction, because the boundary measures come from the unit file (dedup within the file) and the breaks after global dedup; this follows from the split described in the rule."
        )

    rule_values = (
        "Run parameter values: break threshold 1024 tokens; TTL 5 min = 300 s, 1 h = 3600 s "
        "read from usage.cache_creation of each call; loss threshold 2048 input tokens; loss series 3; "
        f"loss sum 100000 tokens; compact matching window 600 s; min_support {MIN_SUPPORT}; "
        f"period: {start.isoformat().replace('+00:00', 'Z')} to "
        f"{end.isoformat().replace('+00:00', 'Z')}; deployment: {deployed.isoformat().replace('+00:00', 'Z')}."
    )
    unit_times = [j["occ"]["ts"] for j in units if j["occ"]["ts"] is not None]
    if unit_times:
        data_range = {
            "from": min(unit_times).isoformat().replace("+00:00", "Z"),
            "to": max(unit_times).isoformat().replace("+00:00", "Z"),
        }
    else:
        data_range = "unavailable"

    report = {
        "template": "compaction-report/1",
        "metric": "cache-cost",
        "script": "compaction_cache_cost.py",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "rule": RULE + " " + rule_values,
        "period": {
            "from": start.isoformat().replace("+00:00", "Z"),
            "to": end.isoformat().replace("+00:00", "Z"),
        },
        "data_range": data_range,
        "n": {"unit": "compaction (a boundary in the transcript)", "value": len(units)},
        "model": distribution(model_list),
        "trigger": distribution(triggers),
        "control_arm": control_arm,
        "data_quality": quality,
        "results": results,
        "min_support": MIN_SUPPORT,
        "caveats": caveats,
        "jev_vs_fallback_comparison": comparison,
        "compaction_cost": compaction_cost,
        "turns_between_compactions": turns_between,
        "first_turn_recovery": recovery_fields,
        "breakeven_turns": breakeven_fields,
        "cache_savings_usd": {
            "total": usd(savings_total),
            "main": usd(savings_main),
            "subagent": usd(savings_subagent),
        },
        "rewrites": rewrites_field,
        "cache_loss": cache_loss,
        "calls_cost_usd": usd(calls_cost),
    }
    if a.details:
        report["segment_hit_rates"] = segments_all
        report["units"] = [
            {
                "uuid": j["uuid"],
                "file": str(j["file"]),
                "files_with_boundary": j["files_with_boundary"],
                "timestamp": j["occ"]["ts_lit"],
                "group": j["group"],
                "trigger": j["trigger"],
                "model": j["model"],
                "turns_to_next": j["turns"],
                "segment_end": j["segment_end"],
                "first_turn_recovery": j["recovery"],
                "rewrite_cost_usd": usd(j["rewrite_cost"]) if isinstance(j["rewrite_cost"], Decimal) else "unavailable",
                "paid_back": j["paid_back"],
                "breakeven_turns": j["breakeven"],
            }
            for j in units
        ]

    if a.out:
        written, write_error = write_result(a.out, report)
        if written:
            print(f"saved: {a.out}")
            return 0
        print(f"error: {write_error}", file=sys.stderr)
        return 1
    if a.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"period: {start.isoformat().replace('+00:00', 'Z')} to {end.isoformat().replace('+00:00', 'Z')}")
        print(f"compactions (boundaries in the period): {len(period_boundaries)}")
        print(f"prefix breaks: {len(breaks_period)} " + json.dumps({k: v["count"] for k, v in rewrites_field.items()}, ensure_ascii=False))
        print(f"cost of calls in the period: {usd(calls_cost)} USD")
        print(f"cache losses: before {cache_loss['before_deployment']['losses']}, from {cache_loss['from_deployment']['losses']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
