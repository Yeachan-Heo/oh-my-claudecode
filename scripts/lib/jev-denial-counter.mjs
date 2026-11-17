/**
 * Denial counter for the PreToolUse guards of pre-tool-enforcer.mjs (opt-in: OMC_JEV_DENIAL_COUNTER=1).
 *
 * Every guard denial is registered under the key (guard, normalized reason). Repeats of one key inside
 * a time window escalate in two degrees: a reminder when the windowed count reaches k, and a block with a
 * change-of-plan instruction when it reaches k + 2. A per-guard count for the session never resets; when it
 * reaches the session ceiling the text says so. Parallel calls of one model response count as one attempt:
 * the package key is the id of the last assistant message of the transcript; without it, same-key denials
 * less than 2 s apart form one package.
 *
 * Only the /goal guard (ultragoal-goal) can be released, and only in a main Claude session, after the session
 * ceiling, and only with OMC_JEV_DENIAL_RELEASE=1. Every other denial is only counted and escalated.
 *
 * State: the file denials-<agent_id or main>.json of the session's state directory, written atomically under a lock. The hook
 * resolves its path with the canonical session path helper (resolveSessionStatePathsForHook of lib/state-root.mjs, the file name
 * from denialStateFileName) and passes it in as statePath; this module builds no session path itself. Without a statePath (a
 * session id the helper does not accept) nothing is counted: the denial stays and the journal gets a `state` row.
 * The counts of the state are keyed by 16-hex hashes of the keys; the once-per-key action markers carry the
 * normalized key itself (so after the first escalation the file holds up to 2000 characters of denial text).
 * Log: denials.jsonl in OMC_JEV_LOG_DIR, or <stateDir>/jev when that is unset. One decision row per fired
 * action (escalation, release, ceiling, unreadable state) and one outcome row that references it. Rows are at
 * most 2000 characters; the file rotates at 1.5 MB.
 *
 * Tunables (a value that is not a positive integer keeps the default):
 *   OMC_JEV_DENIAL_K (3), OMC_JEV_DENIAL_WINDOW_S (120), OMC_JEV_DENIAL_SESSION_MAX (20),
 *   OMC_JEV_DENIAL_LOCK_MS (1800), OMC_JEV_DENIAL_LOCK_ATTEMPTS (50).
 *
 * Contract used by pre-tool-enforcer.mjs and the documentation in docs/HOOKS.md; do not rename:
 *   registerDenial({ stateDir, statePath, sessionId, agentId, guard, reason, call, env, now })
 *     -> { key, n, sessionCount, degree, release, action, state, text }
 *   denialMarker(key, n)  -> "[denial <16-hex hash> #<n>]", #0 when n is unknown
 */
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { rotateJevLog } from '../jev-resolve.mjs';
import { atomicWriteFileSync, withStateFileLockAtPathSync } from './atomic-write.mjs';

const DEFAULT_K = 3;
const DEFAULT_WINDOW_S = 120;
const DEFAULT_SESSION_MAX = 20;
const PACKAGE_GAP_MS = 2000;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const DEGREE_REMINDER = 1;
const DEGREE_BLOCK = 2;
const MAX_ROW_CHARS = 2000;
const MAX_JOURNAL_BYTES = 1.5 * 1024 * 1024;
const MAX_STATE_ENTRIES = 64;
const RELEASABLE_GUARD = 'ultragoal-goal';

/** A switch is on only for the exact value 1 (after trimming), as the other opt-in switches of this hook. */
export function isDenialSwitchOn(name, env = process.env) {
  return String(env?.[name] ?? '').trim() === '1';
}

function positiveInt(env, name, fallback) {
  const raw = String(env?.[name] ?? '').trim();
  return /^[1-9][0-9]{0,5}$/.test(raw) ? Number(raw) : fallback;
}

export const denialK = (env = process.env) => positiveInt(env, 'OMC_JEV_DENIAL_K', DEFAULT_K);
export const denialWindowMs = (env = process.env) => positiveInt(env, 'OMC_JEV_DENIAL_WINDOW_S', DEFAULT_WINDOW_S) * 1000;
export const denialSessionMax = (env = process.env) => positiveInt(env, 'OMC_JEV_DENIAL_SESSION_MAX', DEFAULT_SESSION_MAX);

/** The Jev log directory for the denial journal, the same resolution as overrides.jsonl in pre-tool-enforcer.mjs. */
export function denialLogDir(stateDir, env = process.env) {
  return env?.OMC_JEV_LOG_DIR || join(stateDir, 'jev');
}

const isFiniteNumber = (x) => typeof x === 'number' && Number.isFinite(x);

/** The 16-hex hash of a normalized key; the journal and the counts of the state carry this instead of the key text (the once-per-key action markers of the state carry the normalized key itself). */
export function keyHash(key) {
  return createHash('sha256').update(String(key ?? '')).digest('hex').slice(0, 16);
}

/** The fixed denial marker `[denial <hash> #<n>]` that the transcript carries (the hash equals the journal key field). */
export function denialMarker(key, n) {
  return `[denial ${keyHash(key)} #${isFiniteNumber(n) ? n : 0}]`;
}

/** The normalized key of a denial: timestamps, UUIDs, temp paths and long hex values collapse to placeholders. */
export function denialKey(guard, reason) {
  return guard + '|' + String(reason ?? '').slice(0, 2000)
    .replace(/(\/(?:var|tmp|temp)\/[^\s"'`]{0,120})/gi, '<tmp>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?/g, '<time>')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>')
    .replace(/\b1\d{12}\b/g, '<time>')
    .replace(/(?<![0-9a-zA-Z_])[0-9a-f]{12,}(?![0-9a-zA-Z])/gi, '<hash>');
}

/** The id of the last assistant message near the end of the transcript (bounded read of the last 256 KiB). */
export function lastAssistantMessageId(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  try {
    const st = statSync(transcriptPath);
    if (!st.isFile() || st.size === 0) return null;
    const length = Math.min(st.size, TRANSCRIPT_TAIL_BYTES);
    const fd = openSync(transcriptPath, 'r');
    let text = '';
    try {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, st.size - length);
      text = buffer.toString('utf8');
    } finally {
      closeSync(fd);
    }
    const lines = text.split('\n');
    // A partial first line of the tail is skipped unless the whole file was read.
    const first = st.size > TRANSCRIPT_TAIL_BYTES ? 1 : 0;
    for (let i = lines.length - 1; i >= first; i--) {
      const line = lines[i].replace(/\r$/, '');
      if (!line.includes('"type":"assistant"') || line.length > 4_000_000) continue;
      let parsed = null;
      try { parsed = JSON.parse(line); } catch { continue; }
      const id = parsed?.message?.id;
      if (typeof id === 'string' && id) return id;
    }
    return null;
  } catch {
    return null;
  }
}

/** The id of one journal row: the same event logged twice gets the same id. */
function rowId(row) {
  const subject = row.session_id ? `${row.session_id}${row.agent_id ? `/${row.agent_id}` : ''}` : 'no-session';
  const sequence = row.ref
    ? `ref=${row.ref}${row.effectiveness ? `#${row.effectiveness}` : ''}`
    : (row.tool_use_id || `${row.guard || '?'}#${row.sessionCount ?? '?'}#${row.action ?? ''}`);
  return createHash('sha256').update(`${row.kind || '?'}\x1f${subject}\x1f${sequence}`).digest('hex').slice(0, 16);
}

/**
 * Append one row to denials.jsonl. Never throws; returns the row id, or null when the row was not written.
 * Adds ts, ts_ms, point and id; shortens string fields when the row would exceed 2000 characters; rotates the file at 1.5 MB.
 */
export function writeDenialRow(row, logDir) {
  try {
    mkdirSync(logDir, { recursive: true });
    const path = join(logDir, 'denials.jsonl');
    rotateJevLog(path, MAX_JOURNAL_BYTES);
    let full = { ts: new Date().toISOString(), ts_ms: Date.now(), point: 'denial', ...row };
    if (!full.id) full.id = rowId(full);
    let line = JSON.stringify(full);
    if (line.length > MAX_ROW_CHARS) {
      const cut = { ...full, truncated: true };
      for (const limit of [800, 400, 200, 100, 50, 20, 8]) {
        for (const field of Object.keys(cut)) {
          if (typeof cut[field] === 'string' && cut[field].length > limit) cut[field] = cut[field].slice(0, limit);
        }
        line = JSON.stringify(cut);
        if (line.length <= MAX_ROW_CHARS) break;
      }
      full = cut;
    }
    appendFileSync(path, line + '\n', 'utf8');
    return full.id;
  } catch {
    return null;
  }
}

/** The file name of the counter state of a main session (agentId empty) or of one subagent, for the canonical path helper: [A-Za-z0-9_-] only. */
export function denialStateFileName(agentId) {
  const agent = typeof agentId === 'string' && agentId ? agentId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) : '';
  return agent ? `denials-${agent}.json` : 'denials-main.json';
}

/** Read the state: 'ok' (usable), 'missing' (a fresh session), 'broken' (unreadable JSON) or 'nan' (wrong shape). */
function readState(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return { kind: 'missing', state: null }; }
  let state = null;
  try { state = JSON.parse(raw); } catch { return { kind: 'broken', state: null }; }
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1
    || !state.keys || typeof state.keys !== 'object' || Array.isArray(state.keys)
    || !state.sessionCounts || typeof state.sessionCounts !== 'object' || Array.isArray(state.sessionCounts)) {
    return { kind: 'nan', state: null };
  }
  return { kind: 'ok', state };
}

function sessionCountOf(state, guard) {
  return isFiniteNumber(state.sessionCounts[guard]) ? state.sessionCounts[guard] : 0;
}

function degreeFor(n, k) {
  if (n >= k + 2) return DEGREE_BLOCK;
  if (n >= k) return DEGREE_REMINDER;
  return 0;
}

/** The escalation text appended to the denial. `info` carries guard, counts, limits and the stage (or the broken-state note). */
function stageText(degree, info) {
  const { guard, n, sessionCount, k, windowS, maxSession, unreadable, ceiling } = info;
  if (ceiling) {
    return `[DENIAL COUNTER: SESSION CEILING] Guard ${guard} has denied ${sessionCount} times in this session (ceiling ${maxSession}, never reset). Denials are not released; end this step another way or end your turn with a line \`BLOCKED: <reason, at least 20 characters>\`.`;
  }
  if (degree === DEGREE_REMINDER) {
    return `[DENIAL COUNTER] The same denial of guard ${guard} has come ${n} times in a ${windowS} s window (threshold ${k}). Do not repeat the same call: change approach, use another tool or path.`;
  }
  if (degree === DEGREE_BLOCK) {
    const count = isFiniteNumber(n) ? `${n} times in a ${windowS} s window (threshold ${k})` : 'repeatedly';
    const text = `[DENIAL COUNTER: BLOCK] The same denial of guard ${guard} has come ${count}. Change the plan of action (another route, another tool) or stop the step and end your turn with a line \`BLOCKED: <reason, at least 20 characters>\`; further repeats of the same call change nothing.`;
    return unreadable ? `${text} Counter state unreadable (${unreadable}); the threshold is treated as crossed.` : text;
  }
  return '';
}

function capEntries(map, timeOf) {
  if (!map || typeof map !== 'object') return map;
  const entries = Object.entries(map);
  if (entries.length <= MAX_STATE_ENTRIES) return map;
  return Object.fromEntries(entries.sort((a, b) => (timeOf(b[1]) || 0) - (timeOf(a[1]) || 0)).slice(0, MAX_STATE_ENTRIES));
}

function saveState(path, state) {
  try {
    state.keys = capEntries(state.keys, (entry) => entry?.last);
    state.actions = capEntries(state.actions, (value) => value);
    state.released = capEntries(state.released, (value) => value);
  } catch { /* a broken map keeps its shape */ }
  try { atomicWriteFileSync(path, JSON.stringify(state, null, 2)); } catch { /* fail-open: the denial stays */ }
}

/**
 * Register one guard denial and return the escalation of this call.
 * Returns { key, n, sessionCount, degree, release, action, state, text }:
 *   key       normalized key (use denialMarker)            n         windowed count, or null when unknown
 *   degree    0 none, 1 reminder, 2 block                  release   true: the caller lets the call pass
 *   action    the fired action id or null                  state     'ok' | 'missing' | 'broken' | 'nan' | 'lock-unavailable' | 'path-unavailable'
 *   text      escalation text to append (may be empty)
 */
export function registerDenial({ stateDir, statePath, sessionId, agentId, guard, reason, call = {}, env = process.env, now }) {
  const key = denialKey(guard, reason);
  const hash = keyHash(key);
  const ts = isFiniteNumber(now) ? now : Date.now();
  const path = typeof statePath === 'string' ? statePath : '';
  const logDir = denialLogDir(stateDir, env);
  const k = denialK(env);
  const windowMs = denialWindowMs(env);
  const maxSession = denialSessionMax(env);
  const releasable = guard === RELEASABLE_GUARD && !agentId && isDenialSwitchOn('OMC_JEV_DENIAL_RELEASE', env);
  const packageKey = typeof call.packageKey === 'string' && call.packageKey.trim()
    ? call.packageKey.trim()
    : lastAssistantMessageId(call.transcriptPath);
  const lockBudgetMs = positiveInt(env, 'OMC_JEV_DENIAL_LOCK_MS', 1800);
  const lockAttempts = positiveInt(env, 'OMC_JEV_DENIAL_LOCK_ATTEMPTS', 50);
  const windowS = Math.round(windowMs / 1000);
  let result = null;

  const lock = path ? withStateFileLockAtPathSync(`${path}.lock`, () => {
    const read = readState(path);
    const state = read.kind === 'ok'
      ? read.state
      : { version: 1, keys: {}, sessionCounts: {}, released: {}, actions: {} };
    const broken = read.kind === 'broken' || read.kind === 'nan' ? read.kind : null;
    const base = { guard, k, windowS, maxSession };

    if (!broken && releasable && state.released && state.released[guard]) {
      result = { key, n: null, sessionCount: sessionCountOf(state, guard), degree: 0, release: true, action: null, state: 'ok', text: '' };
      return;
    }

    if (broken) {
      // Unreadable state counts as a crossed threshold for this call only; the state restarts at one denial.
      result = { key, n: null, sessionCount: null, degree: DEGREE_BLOCK, release: false, action: `state-${broken}`, state: broken, text: stageText(DEGREE_BLOCK, { ...base, unreadable: broken }) };
      state.keys[hash] = { n: 1, first: ts, last: ts, package: packageKey || null, packageTs: ts };
      state.sessionCounts[guard] = 1;
      state.released = {};
      state.actions = {};
      saveState(path, state);
      return;
    }

    const entry = state.keys[hash];
    if (entry && !isFiniteNumber(entry.n)) {
      result = { key, n: null, sessionCount: null, degree: DEGREE_BLOCK, release: false, action: 'state-nan', state: 'nan', text: stageText(DEGREE_BLOCK, { ...base, unreadable: 'nan' }) };
      state.keys[hash] = { n: 1, first: ts, last: ts, package: packageKey || null, packageTs: ts };
      state.sessionCounts[guard] = 1;
      state.released = {};
      state.actions = {};
      saveState(path, state);
      return;
    }

    // One attempt per model response: a package moves no counter; its members refresh the package stamp.
    const samePackage = packageKey
      ? (entry ? entry.package === packageKey : false)
      : (entry ? ts - (entry.packageTs || entry.last) < PACKAGE_GAP_MS : false);
    if (samePackage) {
      entry.package = packageKey || entry.package;
      entry.packageTs = ts;
      result = { key, n: entry.n, sessionCount: sessionCountOf(state, guard), degree: degreeFor(entry.n, k), release: false, action: null, state: 'ok', text: '' };
      saveState(path, state);
      return;
    }

    const counted = entry || { n: 0, first: ts, last: 0, package: null, packageTs: 0 };
    if (ts - counted.last > windowMs) counted.n = 0; // the only reset of the windowed count
    counted.n += 1;
    counted.last = ts;
    counted.first = counted.first || ts;
    counted.package = packageKey || null;
    counted.packageTs = ts;
    state.keys[hash] = counted;
    state.sessionCounts[guard] = sessionCountOf(state, guard) + 1;

    const sessionCount = state.sessionCounts[guard];
    const degree = degreeFor(counted.n, k);
    result = { key, n: counted.n, sessionCount, degree, release: false, action: null, state: 'ok', text: degree > 0 ? stageText(degree, { ...base, n: counted.n }) : '' };

    if (!state.actions || typeof state.actions !== 'object' || Array.isArray(state.actions)) state.actions = {};
    const fire = (id) => {
      const actionKey = `${key}|${id}`; // the action marker carries the normalized key, not its hash
      if (state.actions[actionKey]) return; // each action fires once per key
      state.actions[actionKey] = ts;
      result.action = id;
    };
    if (degree === DEGREE_REMINDER) fire('escalation-1');
    if (degree === DEGREE_BLOCK) fire('escalation-2');
    if (sessionCount >= maxSession) {
      if (releasable) {
        if (!state.released || typeof state.released !== 'object' || Array.isArray(state.released)) state.released = {};
        state.released[guard] = ts;
        result = { key, n: counted.n, sessionCount, degree: 0, release: true, action: 'release', state: 'ok', text: '' };
      } else {
        result.text = stageText(DEGREE_BLOCK, { ...base, sessionCount, ceiling: true });
        result.degree = DEGREE_BLOCK;
        fire('deny-storm');
      }
    }
    saveState(path, state);
  }, true, lockAttempts, 600, 900, lockBudgetMs) : { acquired: false };

  const written = lock.acquired || lock.callbackRan === true;
  if (!written || !result) {
    // The state path is missing or the lock was unavailable: fail-open, the denial stays, the lost increment is visible in the journal.
    const state = path ? 'lock-unavailable' : 'path-unavailable';
    writeDenialRow({
      kind: 'state', session_id: sessionId || null, agent_id: agentId || null,
      guard, key: hash, n: null, sessionCount: null, k, maxSession,
      degree: 0, result: 'denied', action: `state-${state}`, reason_code: 'guard_denial',
      effectiveness: null, state,
      tool_name: call.toolName || null, tool_use_id: call.toolUseId || null,
    }, logDir);
    return { key, n: null, sessionCount: null, degree: 0, release: false, action: null, state, text: '' };
  }

  if (result.action) {
    const kind = result.release ? 'release' : (result.action.startsWith('state-') ? 'state' : 'denial');
    const outcome = result.release ? 'passed' : 'denied';
    const id = writeDenialRow({
      kind, session_id: sessionId || null, agent_id: agentId || null,
      guard, key: hash, n: result.n, sessionCount: result.sessionCount, k, maxSession,
      degree: result.degree, result: outcome, action: result.action, reason_code: 'guard_denial',
      effectiveness: null, state: result.state,
      tool_name: call.toolName || null, tool_use_id: call.toolUseId || null,
    }, logDir);
    if (id) {
      writeDenialRow({
        kind: 'outcome', ref: id, session_id: sessionId || null, agent_id: agentId || null,
        guard, key: hash, result: outcome, effectiveness: null,
      }, logDir);
    }
  }
  return result;
}
