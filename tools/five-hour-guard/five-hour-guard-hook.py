#!/usr/bin/env python3
# PreToolUse hook for the five-hour limit guard (five-hour-guard.py). While the guard's pause file says "paused", every tool
# call of every session that loads this hook WAITS here (no signal is sent to the session; it stays alive and keeps its id
# and its connections). When the guard removes the pause file the hook returns at once and the tool call proceeds. The hook
# never denies a call and never prints anything, so the model gets no reason to retry and makes no extra API request while
# it waits.
#
# Fail-open on purpose: unreadable or invalid pause file, no heartbeat from the guard (`valid_until` in the pause file is
# rewritten by the guard every tick and has passed), a deadline passed by DEADLINE_GRACE_S, or a deadline further ahead than
# the guard ever writes it (`valid_until` more than MAX_VALID_AHEAD_S, `resume_at` more than MAX_RESUME_AHEAD_S from now) all
# mean "not paused". A dead guard, or a pause file written with absurd times, can therefore never wedge sessions.
#
#   five-hour-guard-hook.py --pause-file <file> [--log <file>] [--poll <seconds>]
# Both paths come from the hook command that five-hour-guard-settings.py writes into settings.json; the hook reads no
# configuration file (it runs on every tool call). Without --pause-file there is nothing to wait for: exit 0.
import json, math, os, sys, time
from urllib.parse import urlparse

DEADLINE_GRACE_S = 900       # never hold longer than this past the stored resume time
MAX_VALID_AHEAD_S = 3600     # the guard renews valid_until every tick and sets it at most 1800 s ahead
MAX_RESUME_AHEAD_S = 21600   # a window is 5 hours; the guard believes no reset time further than 5 h 15 min, plus a margin of at most 30 min


def arg(name, default=None):
    a = sys.argv
    return a[a.index(name) + 1] if name in a and a.index(name) + 1 < len(a) else default


PAUSE_FILE = arg('--pause-file')
LOG = arg('--log')
try:
    POLL_S = float(arg('--poll', '2'))
except ValueError:
    POLL_S = 2.0
if not math.isfinite(POLL_S):
    POLL_S = 2.0
POLL_S = max(POLL_S, 0.1)   # --poll 0 would spin a processor for the whole pause


def pause_state():
    """Return the pause dict when a pause is in force, else None (fail-open)."""
    try:
        with open(PAUSE_FILE) as f:
            p = json.load(f)
    except Exception:
        return None
    now = time.time()
    try:
        if type(p.get('v')) is not int or p['v'] != 2:
            return None   # not the document the guard publishes (version 2)
        if p.get('paused') is not True:
            return None   # "false", 1 or "true" are not a pause: only the JSON value true is
        valid_until, resume_at = p['valid_until'], p['resume_at']
        if not all(type(x) in (int, float) and math.isfinite(x) for x in (valid_until, resume_at)):
            return None   # a string, a boolean, NaN or infinity: NaN and infinity would compare false and hold for ever
        for key in ('exclude', 'only'):
            if not isinstance(p.get(key, []), list) or not all(isinstance(x, str) for x in p.get(key, [])):
                return None   # a string would be read as a list of one-letter prefixes
        if now > valid_until:
            return None
        if now > resume_at + DEADLINE_GRACE_S:
            return None
        if valid_until > now + MAX_VALID_AHEAD_S:
            return None
        if resume_at > now + MAX_RESUME_AHEAD_S:
            return None
    except Exception:
        return None
    return p


def log(msg):
    if not LOG:
        return
    try:
        with open(LOG, 'a') as f:
            f.write(time.strftime('%Y-%m-%d %H:%M:%S ') + msg + '\n')
    except Exception:
        pass


def foreign_provider():
    """Sessions that do not draw on the Anthropic subscription window are never held: they authenticate with an API key or
    an auth token, route through Bedrock, Vertex or Foundry (flag set to 1), or use a base URL whose host is not
    anthropic.com (the host is compared, not the text: `proxy-anthropic.com` is foreign, `API.ANTHROPIC.COM` is not)."""
    env = os.environ
    if any(env.get(k, '').strip() for k in ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN')):
        return True
    if any(env.get(k) == '1' for k in ('CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY')):
        return True
    base = env.get('ANTHROPIC_BASE_URL', '').strip()
    if not base:
        return False
    try:
        host = (urlparse(base if '://' in base else '//' + base).hostname or '').rstrip('.').lower()
    except ValueError:
        return True   # not a URL we can read: not Anthropic's, and the hook is fail-open
    return not (host == 'anthropic.com' or host.endswith('.anthropic.com'))


def main():
    if not PAUSE_FILE:
        return 0
    p = pause_state()
    if p is None:
        return 0
    try:
        raw = sys.stdin.read()
        ev = json.loads(raw) if raw.strip() else {}
    except Exception:
        ev = {}
    if not isinstance(ev, dict):
        ev = {}   # a list or a text on stdin is no event: the call is held like any other
    sid = str(ev.get('session_id') or '')
    if any(sid.startswith(x) for x in p.get('exclude', []) if x):
        return 0
    only = [x for x in p.get('only', []) if x]
    if only and not any(sid.startswith(x) for x in only):
        return 0   # a test pause aimed at chosen sessions holds nobody else
    if foreign_provider():
        return 0
    t0 = time.time()
    who = f"{sid[:8]} {ev.get('tool_name', '?')}" + (f" agent={ev.get('agent_id')}" if ev.get('agent_id') else '')
    log(f'hold-start {who}')
    while pause_state() is not None:
        time.sleep(POLL_S)
    log(f'hold-end {who} waited={int(time.time() - t0)}s')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
