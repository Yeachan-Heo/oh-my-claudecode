#!/usr/bin/env node
/* global process */
/**
 * PostToolUse warning about repeated successful tool calls and call cycles.
 *
 * Opt-in (OMC_JEV_LOOP_WARNING=1; off by default). When enabled, a PostToolUse
 * call whose (tool name, tool input) signature and normalized response repeat
 * in a row warns the agent that it may be in a loop; a cycle of 2-6 call
 * signatures repeating in short succession warns too. The hook is advisory
 * only: it never blocks (no decision: block, no exit code 2) and never stops
 * a session.
 *
 * Input: the JSON object on stdin (PostToolUse): session_id, transcript_path
 * (never opened), cwd, hook_event_name (must be PostToolUse), tool_name,
 * tool_input, tool_response, tool_use_id; agent_id and agent_type in calls
 * made inside a subagent. The only data source is stdin; the only directory
 * the hook uses is its own state directory (no session data, transcripts or
 * disk listings).
 *
 * Definitions:
 *   context            the pair (session_id, agent_id; agent_id empty for the
 *                      main session). State per context in its own JSON file
 *                      named by the sha256 of the context in the state dir;
 *                      main-session and subagent contexts are counted apart.
 *   call signature     sha256 (first 12 hex chars) of tool_name + NUL + the
 *                      stable JSON of tool_input (keys sorted recursively,
 *                      no spaces).
 *   response signature sha256 of the normalized response text plus the error
 *                      flag (after a NUL): a string as it is; the text blocks
 *                      of a list joined with newlines; an object as stable
 *                      JSON; the flag is 1 when tool_response has a truthy
 *                      is_error or a non-empty error field, else 0.
 *   repeated success   the counter of the context's consecutive calls with
 *                      the same (call signature, response signature) pair,
 *                      without an error; any other call (another pair or an
 *                      error) resets it. Warned when the counter reaches the
 *                      repeat threshold and then at every further multiple.
 *   cycle              the last window call signatures of the context; a
 *                      cycle of period p in 2..6 is at least `cycleRepeats`
 *                      full repeats of the pattern (the last p signatures)
 *                      ending at this call, when the pattern has at least 2
 *                      distinct signatures. Warned for the shortest period,
 *                      once per cycle: again only after the cycle breaks (the
 *                      detected period is kept in state and cleared when no
 *                      cycle is found).
 *   state              holds only signature digests (12 chars) and tool names
 *                      (needed for the cycle warning text), counters and the
 *                      period; never tool_input or tool_response content.
 *
 * Exemptions (the call counts for no detection, the repeat counter resets):
 *   the Agent and Task tools; polling: a Bash command whose command field,
 *   trimmed of leading whitespace, starts with the whole word sleep or with
 *   gh run watch, tail -f or git status; the status tools
 *   ReadNotifications, TaskList, TaskGet, CronList, ListAgents, Monitor and
 *   MCP tools whose name ends with one of the configured suffixes. All lists
 *   are constants at the top of the file.
 *
 * Environment (defaults are starting values, meant to be measured against
 * real data; a non-positive value disables that detection):
 *   OMC_JEV_LOOP_WARNING            "1" enables the hook; anything else keeps
 *                                   it off (default).
 *   OMC_JEV_LOOP_WARNING_STATE_DIR  state directory (default
 *                                   ~/.omc/state/tool-loop); the JSONL
 *                                   journal sits next to it
 *                                   (tool-loop-warnings.jsonl in the parent).
 *   OMC_JEV_LOOP_WARNING_THRESHOLD  repeat threshold (3).
 *   OMC_JEV_LOOP_WARNING_WINDOW     window of signatures for cycles (64).
 *   OMC_JEV_LOOP_WARNING_CYCLE_REPEATS  full pattern repeats of a cycle (3).
 *   OMC_JEV_LOOP_WARNING_STATE_DAYS state file age removed by the sweep (2).
 *   OMC_JEV_LOOP_WARNING_MCP_SUFFIXES  comma-separated MCP tool name suffixes
 *                                   treated as status polling; these three
 *                                   defaults are the host's own state tools:
 *                                   __state_list_active,
 *                                   __state_get_status, __state_read.
 *
 * Journal: one JSON line per warning in tool-loop-warnings.jsonl with ts,
 * session_id, agent_id, kind (repeat, cycle or error), tool, count, period,
 * signature; an error row adds category. Never call or response content.
 *
 * Fail-open: every error (bad JSON, missing fields, state read or write
 * error, journal error) ends the hook with exit code 0 WITHOUT output (never
 * blocks work), with an error row in the journal when possible (no input
 * content, category only).
 *
 * Warning: stdout only, as JSON
 *   {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "<text>"}}
 * with exit code 0.
 */

import { appendFileSync, mkdirSync, openSync, closeSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// --- constants: exemptions and ranges ---------------------------------------

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const POLLING_WORD = /^sleep\b/;
const POLLING_PREFIXES = ['gh run watch', 'tail -f', 'git status'];
const STATUS_TOOLS = new Set(['ReadNotifications', 'TaskList', 'TaskGet', 'CronList', 'ListAgents', 'Monitor']);
const DEFAULT_MCP_SUFFIXES = ['__state_list_active', '__state_get_status', '__state_read'];
const PERIODS = [2, 3, 4, 5, 6];
const SWEEP_EVERY_CALLS = 100;

// --- configuration -----------------------------------------------------------

const flag = (value) => String(value ?? '').trim() === '1';

/** Integer from the environment (a negative or zero value disables what it drives, as in the detection checks), else the default. */
function intFromEnv(value, fallback) {
  const text = String(value ?? '').trim();
  return /^-?\d+$/.test(text) ? Number(text) : fallback;
}

export const loopWarningEnabled = (env = process.env) => flag(env.OMC_JEV_LOOP_WARNING);

export function loopWarningConfig(env = process.env) {
  const home = (() => {
    try { return homedir(); } catch { return '.'; }
  })();
  const stateDir = String(env.OMC_JEV_LOOP_WARNING_STATE_DIR ?? '').trim()
    || join(home, '.omc', 'state', 'tool-loop');
  return {
    enabled: flag(env.OMC_JEV_LOOP_WARNING),
    stateDir,
    journalPath: join(dirname(stateDir), 'tool-loop-warnings.jsonl'),
    threshold: intFromEnv(env.OMC_JEV_LOOP_WARNING_THRESHOLD, 3),
    window: intFromEnv(env.OMC_JEV_LOOP_WARNING_WINDOW, 64),
    cycleRepeats: intFromEnv(env.OMC_JEV_LOOP_WARNING_CYCLE_REPEATS, 3),
    stateDays: intFromEnv(env.OMC_JEV_LOOP_WARNING_STATE_DAYS, 2),
    mcpSuffixes: String(env.OMC_JEV_LOOP_WARNING_MCP_SUFFIXES ?? '').trim()
      ? String(env.OMC_JEV_LOOP_WARNING_MCP_SUFFIXES).split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_MCP_SUFFIXES,
  };
}

// --- signatures (digests only, never content) -------------------------------

/** JSON with keys sorted recursively and no spaces (the stable JSON of the Python hook). */
export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** sha256 of a text, hex. */
const digest = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');

const digest12 = (text) => digest(text).slice(0, 12);

/** The (response text, error flag) pair of a tool_response: a string as it is; the text blocks of a list joined with newlines; an object as stable JSON. */
export function normalizeResponse(resp) {
  let text;
  if (typeof resp === 'string') text = resp;
  else if (Array.isArray(resp)) {
    text = resp.filter((block) => block && typeof block === 'object' && block.type === 'text')
      .map((block) => (typeof block.text === 'string' ? block.text : '')).join('\n');
  } else if (resp === null || resp === undefined) text = '';
  else text = stableJson(resp);
  const flagValue = resp && typeof resp === 'object' && !Array.isArray(resp) && (resp.is_error || resp.error) ? 1 : 0;
  return { text, error: flagValue };
}

/** sha256-12 of tool_name + NUL + stable JSON of tool_input. */
export const callSignature = (tool, input) => digest12(String(tool) + '\x00' + stableJson(input ?? {}));

/** sha256-12 of the normalized response text plus the error flag (after a NUL). */
export const responseSignature = (resp) => {
  const { text, error } = normalizeResponse(resp);
  return digest12(text + '\x00' + String(error));
};

// --- exemptions (not counted, the repeat counter resets) ---------------------

export function isExempt(tool, input, mcpSuffixes) {
  if (AGENT_TOOLS.has(tool) || STATUS_TOOLS.has(tool)) return true;
  if (mcpSuffixes.some((suffix) => String(tool).endsWith(suffix))) return true;
  if (tool === 'Bash' && input && typeof input === 'object') {
    const command = input.command;
    if (typeof command === 'string') {
      const trimmed = command.replace(/^\s+/, '');
      if (POLLING_WORD.test(trimmed)) return true;
      if (POLLING_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true;
    }
  }
  return false;
}

// --- per-context state (JSON file, atomic write) -----------------------------

export function newState() {
  return { loopPair: '', loopTool: '', loopCount: 0, sequence: [], cyclePeriod: null, calls: 0 };
}

export function statePath(config, session, agent) {
  return join(config.stateDir, digest(session + '\x00' + agent) + '.json');
}

export function readState(path) {
  let state;
  try {
    state = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return newState();
  }
  if (!state || typeof state !== 'object') return newState();
  const clean = newState();
  clean.loopPair = typeof state.loopPair === 'string' ? state.loopPair : '';
  clean.loopTool = typeof state.loopTool === 'string' ? state.loopTool : '';
  const count = state.loopCount;
  clean.loopCount = Number.isInteger(count) && count > 0 ? count : 0;
  if (Array.isArray(state.sequence)) {
    clean.sequence = state.sequence
      .filter((item) => item && typeof item === 'object' && typeof item.s === 'string' && typeof item.t === 'string')
      .map((item) => ({ s: item.s, t: item.t }));
  }
  const period = state.cyclePeriod;
  clean.cyclePeriod = Number.isInteger(period) && PERIODS.includes(period) ? period : null;
  const calls = state.calls;
  clean.calls = Number.isInteger(calls) && calls > 0 ? calls : 0;
  return clean;
}

export function writeState(config, path, state) {
  mkdirSync(config.stateDir, { recursive: true });
  const temp = path + '.' + process.pid + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify(state), 'utf8');
    renameSync(temp, path);
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      // already moved or removed
    }
  }
}

// --- sweep (every 100th call, inside the state dir only) ---------------------

export function sweep(config, ownPath) {
  const cutoff = Date.now() - config.stateDays * 86_400_000;
  let names;
  try {
    names = readdirSync(config.stateDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue;
    const path = join(config.stateDir, name);
    if (path === ownPath) continue;
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      // removed meanwhile
    }
  }
}

// --- cycle detection (shortest period ending at the current call) ------------

/**
 * Returns [period, repeats] or null. `sequence` is a list of signature digests.
 * A cycle of period p is at least `cycleRepeats` full repeats of the pattern
 * (the last p signatures) ending at this call, when the pattern has at least
 * 2 distinct signatures; repeats counts further matches beyond the minimum.
 */
export function detectCycle(sequence, cycleRepeats) {
  const n = sequence.length;
  for (const p of PERIODS) {
    if (n < p * cycleRepeats) continue;
    const pattern = sequence.slice(n - p);
    if (new Set(pattern).size < 2) continue;
    let matches = true;
    for (let k = 1; k < cycleRepeats; k += 1) {
      if (JSON.stringify(sequence.slice(n - p * (k + 1), n - p * k)) !== JSON.stringify(pattern)) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    let repeats = cycleRepeats;
    while (n - (repeats + 1) * p >= 0
      && JSON.stringify(sequence.slice(n - (repeats + 1) * p, n - repeats * p)) === JSON.stringify(pattern)) {
      repeats += 1;
    }
    return [p, repeats];
  }
  return null;
}

// --- journal (one JSON line per warning; no content) -------------------------

export function appendJournal(config, row) {
  mkdirSync(dirname(config.journalPath), { recursive: true });
  appendFileSync(config.journalPath, JSON.stringify(row) + '\n', 'utf8');
}

export function journalRow(data, kind, tool, count, period, signature, category) {
  const source = data && typeof data === 'object' ? data : {};
  const row = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    session_id: typeof source.session_id === 'string' ? source.session_id : '',
    agent_id: typeof source.agent_id === 'string' ? source.agent_id : '',
    kind,
    tool,
    count,
    period,
    signature,
  };
  if (category !== undefined) row.category = category;
  return row;
}

export function recordError(config, category, data) {
  try {
    appendJournal(config, journalRow(data ?? {}, 'error', '', null, null, '', category));
  } catch {
    // the journal is advisory
  }
}

// --- warnings (stdout JSON only, never a block) -------------------------------

export function repeatWarningText(tool, count) {
  return '[loop warning] The same ' + tool + ' call with the same result has repeated ' + count
    + ' times in a row. Change approach or check whether you are waiting on something that never changes.';
}

export function cycleWarningText(tools, period, repeats) {
  return '[loop warning] Calls repeat in a ' + period + '-step cycle (' + tools + ') ' + repeats
    + ' times. Break the cycle and change approach.';
}

export function warningOutput(text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } });
}

// --- main ---------------------------------------------------------------------

export function processCall(data, config) {
  const warnings = [];
  const rows = [];
  const session = typeof data.session_id === 'string' ? data.session_id : '';
  const tool = typeof data.tool_name === 'string' ? data.tool_name : '';
  if (!session || !tool) {
    recordError(config, 'fields', data);
    return { warnings, rows };
  }
  let agent = data.agent_id || '';
  if (typeof agent !== 'string') agent = '';
  let input = data.tool_input;
  if (input === null || input === undefined) input = {};
  const path = statePath(config, session, agent);
  const state = readState(path);
  state.calls += 1;
  if (isExempt(tool, input, config.mcpSuffixes)) {
    // not counted; the repeat counter resets
    state.loopPair = '';
    state.loopTool = '';
    state.loopCount = 0;
  } else {
    const callSig = callSignature(tool, input);
    const { error } = normalizeResponse(data.tool_response);
    const respSig = responseSignature(data.tool_response);
    const pair = digest12(callSig + '\x00' + respSig);
    if (error) {
      // a call with an error is another call: it resets the counter
      state.loopPair = '';
      state.loopTool = '';
      state.loopCount = 0;
    } else if (pair === state.loopPair) {
      state.loopCount += 1;
    } else {
      state.loopPair = pair;
      state.loopTool = tool;
      state.loopCount = 1;
    }
    if (config.threshold > 0 && state.loopCount >= config.threshold && state.loopCount % config.threshold === 0) {
      warnings.push(repeatWarningText(tool, state.loopCount));
      rows.push(journalRow(data, 'repeat', tool, state.loopCount, null, pair));
    }
    state.sequence.push({ s: callSig, t: tool });
    if (config.window > 0) state.sequence = state.sequence.slice(-config.window);
    const detected = config.cycleRepeats > 0 ? detectCycle(state.sequence.map((item) => item.s), config.cycleRepeats) : null;
    if (detected) {
      const [period, repeats] = detected;
      if (state.cyclePeriod !== period) {
        const cycleTools = [];
        for (const item of state.sequence.slice(-period)) {
          if (!cycleTools.includes(item.t)) cycleTools.push(item.t);
        }
        warnings.push(cycleWarningText(cycleTools.join(', '), period, repeats));
        rows.push(journalRow(data, 'cycle', cycleTools.join(','), repeats, period, state.sequence[state.sequence.length - period].s));
      }
      state.cyclePeriod = period;
    } else {
      state.cyclePeriod = null;
    }
  }
  if (state.calls % SWEEP_EVERY_CALLS === 0) sweep(config, path);
  writeState(config, path, state);
  for (const row of rows) appendJournal(config, row);
  return { warnings, rows };
}

export function main(argv, stdin, env = process.env) {
  let data;
  try {
    data = JSON.parse(stdin);
  } catch {
    const config = loopWarningConfig(env);
    if (config.enabled) recordError(config, 'json');
    return 0;
  }
  const config = loopWarningConfig(env);
  if (!config.enabled) return 0;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    recordError(config, 'json');
    return 0;
  }
  if (data.hook_event_name !== 'PostToolUse') return 0;
  try {
    const { warnings } = processCall(data, config);
    if (warnings.length > 0) console.log(warningOutput(warnings.join('\n\n')));
  } catch {
    // fail-open: exit 0 without output, an error row in the journal when possible
    recordError(config, 'other', data);
  }
  return 0;
}

/* istanbul ignore next */
if (process.argv[1] && /tool-loop-warning\.mjs$/.test(process.argv[1])) {
  let stdin = '';
  try {
    stdin = readFileSync(0, 'utf8');
  } catch {
    // closed stdin: an empty input, the JSON error path
  }
  process.exit(main(process.argv.slice(2), stdin));
}
