/* global process, console */
/**
 * Jev delivery guard (opt-in: OMC_JEV_GUARD=1, and only while the `model-routing` point is active).
 *
 * In active mode the model and effort Jev picks for a Task/Agent call travel in the output of the
 * `pre-tool-enforcer` PreToolUse hook. When Claude Code cuts that hook off at its hooks.json timeout,
 * the output is dropped: the Jev log shows a correct answer, and only the hand-over is lost. Claude
 * Code also reads hooks.json and the `env` section of settings.json once, at session start, so a
 * session that started before a change keeps the old limits. Three checks, all fail-open (a failure
 * returns null and never breaks a hook), none uses the network or asks Jev:
 *
 *  (a) startSession(): the smallest numeric timeout of the pre-tool-enforcer PreToolUse entries in the
 *      plugin's hooks.json is below OMC_JEV_GUARD_MIN_TIMEOUT_S (default 60) -> one message.
 *      Also records, per session id, a hash of hooks.json and of the OMC_*, ANTHROPIC_* and TYPESAFE_*
 *      keys and the Claude Code model-routing keys (CLAUDE_CODE_BEDROCK_*, CLAUDE_CODE_USE_*,
 *      CLAUDE_CODE_SUBAGENT_MODEL, CLAUDE_MODEL) of the `env` section of the user-level settings.json.
 *      A /compact keeps the record (same process); a session without a record gets its baseline at its
 *      first prompt. Every prompt and every /compact marks the record as in use (its modification time),
 *      so the sweep of records older than 14 days never takes the baseline of a live session.
 *  (b) promptCheck(): hooks.json or those env keys differ from the session's record -> one message per
 *      change, "restart the session". Only hashes are stored (sha256, 16 hex digits); values never are.
 *  (c) promptCheck() also starts, at most once per 24 hours, a detached process (this file with
 *      --daily) that reads the session transcripts of the last 24 hours for interrupted PreToolUse
 *      hooks (lines with "timedOut":true: only the hook name, command, time and tool use id are read;
 *      nothing is stored) and, when shadow.jsonl lines carry a tool_use_id field, the share of
 *      active model-routing decisions whose model reached the agent (agent meta.json). The next prompt
 *      shows a message when any PreToolUse:Agent hook was interrupted or the share is below 95 %.
 *      Decisions the hook deliberately left alone (a `use` marker, forceInherit) count as not
 *      delivered. Lines without tool_use_id are skipped: with a log that has none, only interruptions are reported.
 *      A model counts as delivered when it is the chosen tier's alias, a full model id that contains the
 *      tier as a whole word (claude-opus-4-8 for opus), or the id the tier resolves to in the configuration
 *      (the first set one of CLAUDE_CODE_BEDROCK_<TIER>_MODEL, ANTHROPIC_DEFAULT_<TIER>_MODEL).
 *
 * State: <config dir>/.omc/jev-guard/ (sessions/<id>.json and, per Jev log directory,
 * daily-<key>.json, daily-<key>.lock, delivery-<key>.json).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, setPriority } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseJevEnv } from '../jev-resolve.mjs';
import { resolveOmcStateRoot } from './state-root.mjs';
import { getClaudeConfigDir } from './config-dir.mjs';

export const DEFAULT_MIN_TIMEOUT_S = 60;
export const DELIVERY_ALERT_PERCENT = 95;
// Breaker alarm (OMC_JEV_GUARD_TIMEOUTS_ALARM=1): more openings of the breaker caused by missing responses per 24 hours than
// this alarm, and so does more minutes than this of holding back (the union of the openings' time).
export const TIMEOUTS_ALERT_OPENINGS = 20;
export const TIMEOUTS_ALERT_MINUTES = 60;
// Blind alarm (OMC_JEV_GUARD_BLIND_ALARM=1): fewer decisions in the window than this are too few to say the guard cannot see the agents.
const BLIND_MIN_DECISIONS = 10;
const DAY_MS = 24 * 3600 * 1000;
const STALE_RESULT_MS = 2 * DAY_MS; // a daily result older than this is not shown
const SESSION_RECORD_MAX_AGE_MS = 14 * DAY_MS;
const LOCK_STALE_MS = 30 * 60 * 1000;
const SETTLE_MS = 120 * 1000; // a decision younger than this may not have an agent yet
const OPENINGS_KEEP_MS = 7 * DAY_MS;
const MAX_OPENING_MS = 30 * 60_000; // the longest breaker (1800 s): an opening that began earlier cannot reach into the window
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SESSION_ID = /^[A-Za-z0-9._-]{1,200}$/;
const SELF = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = join(dirname(SELF), '..', '..');

/** The guard runs only when asked for and only while Jev decides the model of Task/Agent calls. */
export function isGuardEnabled(env = process.env, permissionMode) {
  return ['1', 'true'].includes(String(env.OMC_JEV_GUARD ?? '').trim().toLowerCase())
    && parseJevEnv('model-routing', env, permissionMode) === 'active';
}

// Sub-switches of the delivery check, each opt-in on top of OMC_JEV_GUARD=1 and each changing the daily result only when set:
//   OMC_JEV_GUARD_EFFORT=1          compare the effort as well as the model; calls of a named agent (a team member, which
//                                   the effort may not reach) are counted apart and leave the share
//   OMC_JEV_GUARD_USE_MARKER=1      leave out the decisions of calls with a `use` marker (applied.jsonl, source "marker")
//   OMC_JEV_GUARD_TIMEOUTS_ALARM=1  count the breaker's openings caused by missing responses and alarm when there are many
//   OMC_JEV_GUARD_BLIND_ALARM=1     count the decisions with no agent meta.json found (`noMeta`) and alarm when of 10 or more decisions
//                                   more than half have none: the guard cannot see the agents, so its share says nothing
// OMC_JEV_GUARD_PROJECT_DIRS lists more Claude Code project directories to read (see projectDirs); without it only the configuration
// directory's `projects` is read.
const switchOn = (env, name) => String(env?.[name] ?? '').trim() === '1';
export const isEffortCheckEnabled = (env = process.env) => switchOn(env, 'OMC_JEV_GUARD_EFFORT');
export const isUseMarkerCheckEnabled = (env = process.env) => switchOn(env, 'OMC_JEV_GUARD_USE_MARKER');
export const isTimeoutsAlarmEnabled = (env = process.env) => switchOn(env, 'OMC_JEV_GUARD_TIMEOUTS_ALARM');
export const isBlindAlarmEnabled = (env = process.env) => switchOn(env, 'OMC_JEV_GUARD_BLIND_ALARM');

/** OMC_JEV_GUARD_MIN_TIMEOUT_S: a positive number of seconds, else the default. */
export function minTimeoutSeconds(env = process.env) {
  const value = Number(String(env.OMC_JEV_GUARD_MIN_TIMEOUT_S ?? '').trim());
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MIN_TIMEOUT_S;
}

// Non-session state for Jev delivery (daily checks, not bound to a session ID).
const jevDeliveryDir = (configDir) => join(configDir, '.omc', 'jev-delivery');
// Session-scoped state follows the canonical resolver's structure: .omc/state/sessions/<sessionId>/
const sessionStateDir = (configDir, sessionId) => join(configDir, '.omc', 'state', 'sessions', String(sessionId));
const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
// A relative log path means a different directory in each working directory: resolve it with the platform's own path
// rules (drive letters, UNC shares) before it becomes a state key, so two projects never share one.
const resolveLogDir = (logDir, cwd = process.cwd()) => (logDir ? resolve(cwd, String(logDir)) : '');
// The daily check belongs to one Jev log directory (one project's log), so its files carry a key of it.
const dailyFile = (dir, logDir, kind, cwd) => {
  const [name, extension] = kind.split('.');
  return join(dir, `${name}-${digest(resolveLogDir(logDir, cwd))}.${extension}`);
};
/** Path of a daily-check state file (kind: daily.json, daily.lock or delivery.json) for a Jev log directory. */
export const dailyStatePath = (configDir, logDir, kind, cwd) => dailyFile(jevDeliveryDir(configDir), logDir, kind, cwd);

function readJson(path) {
  try {
    const text = readFileSync(path, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(value) + '\n', 'utf8');
    renameSync(tmp, path);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* no temporary file */ }
    return false;
  }
}

/** Hash of the plugin's hooks/hooks.json, 'missing' when absent/unreadable, or null on transient error. */
export function hooksJsonHash(pluginRoot = PLUGIN_ROOT) {
  try {
    const path = join(pluginRoot, 'hooks', 'hooks.json');
    if (existsSync(path)) {
      return digest(readFileSync(path));
    }
    return 'missing'; // Stable hash for absent manifest: the session baseline records "manifest deleted"
  } catch {
    return null; // Transient read error: do not update baseline
  }
}

// Keys of the `env` section that decide the hooks' routing or the model a tier alias resolves to: the OMC, Anthropic
// and Jev key variables, and the Claude Code provider and tier-model variables (Bedrock, Vertex, subagent model).
const WATCHED_ENV_KEY = /^(OMC_|ANTHROPIC_|TYPESAFE_|CLAUDE_CODE_BEDROCK_|CLAUDE_CODE_USE_|CLAUDE_CODE_SUBAGENT_MODEL$|CLAUDE_MODEL$)/;

/**
 * Hash of the watched keys (WATCHED_ENV_KEY) of the `env` section of settings.json (sorted key=value
 * pairs), null when the file exists but cannot be parsed. The values may be API keys: only the hash
 * leaves this function. A missing file or section hashes like an empty one.
 */
export function settingsEnvHash(configDir = getClaudeConfigDir()) {
  const path = join(configDir, 'settings.json');
  let settings = {};
  if (existsSync(path)) {
    settings = readJson(path);
    if (settings === null || typeof settings !== 'object') return null;
  }
  const section = settings.env && typeof settings.env === 'object' ? settings.env : {};
  const pairs = Object.entries(section)
    .filter(([key]) => WATCHED_ENV_KEY.test(key))
    .map(([key, value]) => `${key}=${String(value)}`)
    .sort();
  return digest(JSON.stringify(pairs));
}

/** Smallest numeric timeout (seconds) among the pre-tool-enforcer PreToolUse entries, null if none sets one. */
export function preToolTimeout(pluginRoot = PLUGIN_ROOT) {
  const groups = readJson(join(pluginRoot, 'hooks', 'hooks.json'))?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return null;
  let smallest = null;
  for (const group of groups) {
    for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
      const parts = [hook?.command, ...(Array.isArray(hook?.args) ? hook.args : [])];
      if (!parts.some((part) => typeof part === 'string' && part.includes('pre-tool-enforcer'))) continue;
      if (typeof hook.timeout === 'number') smallest = smallest === null ? hook.timeout : Math.min(smallest, hook.timeout);
    }
  }
  return smallest;
}

export function limitMessage(pluginRoot = PLUGIN_ROOT, minSeconds = DEFAULT_MIN_TIMEOUT_S) {
  const timeout = preToolTimeout(pluginRoot);
  if (timeout === null || timeout >= minSeconds) return null;
  return `Jev delivery guard: the PreToolUse timeout of pre-tool-enforcer in the plugin's hooks/hooks.json is ${timeout} s. Jev's model and effort for a Task/Agent call travel in that hook's output, and Claude Code drops the output of a hook it cuts off at the timeout. Raise the timeout to at least ${minSeconds} s and restart the session, or set OMC_JEV_GUARD_MIN_TIMEOUT_S to the value you accept.`;
}

function sessionFile(configDir, data) {
  const id = String(data?.session_id ?? data?.sessionId ?? '');
  return SESSION_ID.test(id) ? join(sessionStateDir(configDir, id), 'jev-guard-state.json') : null;
}

function newRecord(now, pluginRoot, configDir) {
  return { start: now, hooks: hooksJsonHash(pluginRoot), env: settingsEnvHash(configDir), warnedHooks: null, warnedEnv: null, shownByLogDir: {} };
}

// Marks a session record as in use: the sweep reads its modification time. Only the time changes, never the content
// (no truncating write, no reliance on the access time, which relatime and noatime mounts do not keep).
function touchRecord(file, now) {
  try {
    const at = new Date(now);
    utimesSync(file, at, at);
  } catch { /* no record */ }
}

// At most once per 24 hours (a marker file): the sessions directory grows with every headless run.
function pruneSessions(configDir, now) {
  try {
    const dir = join(configDir, '.omc', 'state', 'sessions');
    const marker = join(dir, '.swept');
    try { if (now - statSync(marker).mtimeMs < DAY_MS) return; } catch { /* never swept */ }
    writeFileSync(marker, String(now));
    for (const sessionId of readdirSync(dir)) {
      if (sessionId === '.swept') continue;
      const sessionDir = join(dir, sessionId);
      try {
        // Check the mtime of the session state file, not the directory
        const stateFile = join(sessionDir, 'jev-guard-state.json');
        const mtime = statSync(stateFile).mtimeMs;
        if (now - mtime > SESSION_RECORD_MAX_AGE_MS) rmSync(sessionDir, { recursive: true, force: true });
      } catch { /* no state file or removed meanwhile */ }
    }
  } catch { /* no directory yet */ }
}

/**
 * SessionStart: record the session's baseline and check (a). Returns the message for the user or null.
 * `options` ({ env, now, pluginRoot, configDir }) are test seams.
 */
export function startSession(data, options = {}) {
  const { env = process.env, now = Date.now(), pluginRoot = PLUGIN_ROOT, configDir = getClaudeConfigDir() } = options;
  try {
    if (!isGuardEnabled(env, data?.permission_mode)) return null;
    const file = sessionFile(configDir, data);
    if (file) {
      // /compact continues the same process with the same session id: it keeps what it loaded at its start.
      if (data?.source !== 'compact') writeJson(file, newRecord(now, pluginRoot, configDir));
      else touchRecord(file, now);
      pruneSessions(configDir, now);
    }
    return limitMessage(pluginRoot, minTimeoutSeconds(env));
  } catch {
    return null;
  }
}

function changedSinceStartMessage(reasons) {
  return `Jev delivery guard: ${reasons.join(' and ')} since this session started. Claude Code reads them once, at session start, so this session still runs with the old values. Restart the session to apply the change.`;
}

export function deliveryMessage(result) {
  if (!result || typeof result !== 'object') return null;
  if (typeof result.error === 'string') return `Jev delivery guard: the daily check failed (${result.error}); it will try again in 24 hours.`;
  return [deliveryPart(result), timeoutsMessage(result)].filter(Boolean).join('\n') || null;
}

// The alarm about the breaker opened by missing responses too often; null below the thresholds, or without the
// fields (the daily result of a guard without OMC_JEV_GUARD_TIMEOUTS_ALARM).
export function timeoutsMessage(result) {
  const openings = Number(result?.breakerOpenings) || 0;
  const minutes = Number(result?.breakerHeldMinutes) || 0;
  if (!(openings > TIMEOUTS_ALERT_OPENINGS || minutes > TIMEOUTS_ALERT_MINUTES)) return null;
  return `Jev delivery guard: in the last ${result.windowHours} h missing responses opened the Jev breaker ${openings} times (${minutes} min of held-back requests in all; the alarm is above ${TIMEOUTS_ALERT_OPENINGS} openings or above ${TIMEOUTS_ALERT_MINUTES} min per day). The Jev endpoint answers slowly; the hooks decide with their heuristics meanwhile.`;
}

function deliveryPart(result) {
  const interrupted = Number(result.interruptedAgentHooks) || 0;
  const percent = typeof result.deliveredPercent === 'number' ? result.deliveredPercent : null;
  // Use full-precision percent if available (production), otherwise fall back to rounded percent (tests/legacy)
  const thresholdPercent = typeof result.deliveredPercentFull === 'number' ? result.deliveredPercentFull : percent;
  // The guard cannot see the agents when, of enough decisions, more than half have no agent meta.json. The field exists only with
  // OMC_JEV_GUARD_BLIND_ALARM=1; without it the share is NaN and the comparison is false.
  const decided = Number(result.decisions) || 0;
  const blind = decided >= BLIND_MIN_DECISIONS && Number(result.noMeta) / decided > 0.5;
  if (!(interrupted > 0 || blind || (thresholdPercent !== null && thresholdPercent < DELIVERY_ALERT_PERCENT))) return null;
  if (blind) return `Jev delivery guard: of ${decided} decisions in the last ${result.windowHours} h the guard cannot see the agents (${result.withAgent ?? 0} evaluated, ${result.noMeta} without meta.json); check the Claude Code project directories (OMC_JEV_GUARD_PROJECT_DIRS) and OMC_JEV_LOG_DIR. PreToolUse:Agent hooks interrupted: ${interrupted} (hooks of other commands: ${Number(result.interruptedOtherHooks) || 0}).`;
  // With the `use` marker left out of the count the share no longer holds it against the hook.
  const markerLeftOut = typeof result.markerDecisions === 'number';
  const alone = markerLeftOut ? 'forceInherit' : 'a `use` marker or forceInherit';
  const share = percent === null
    ? 'no active model-routing decision could be matched to an agent'
    : `${result.delivered} of ${result.withAgent} Jev ${typeof result.namedAgents === 'number' ? 'model and effort' : 'model'} decisions reached the agent (${percent} %; a call the hook leaves alone on purpose, such as ${alone}, counts as not delivered)`;
  const named = Number(result.namedAgents) > 0 ? ` Named calls (the model only; the effort may not reach them): ${result.namedModelMatching} of ${result.namedAgents}.` : '';
  return `Jev delivery guard: in the last ${result.windowHours} h ${share}; PreToolUse:Agent hooks interrupted: ${interrupted} (hooks of other commands: ${Number(result.interruptedOtherHooks) || 0}). An interrupted hook loses Jev's model and effort for that call: check the pre-tool-enforcer timeout in hooks/hooks.json and restart sessions started before it was raised.${named}`;
}

// Takes the slot of the daily check: a lock file created exclusively; a lock older than 30 minutes is a dead check.
// Serializes stale-lock reclamation to prevent two sessions from both reclaiming and starting workers.
function claimDailyCheck(dir, logDir, now) {
  const lock = dailyFile(dir, logDir, 'daily.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try { closeSync(openSync(lock, 'wx')); return lock; } catch { /* exists or no directory */ }
    try {
      const stat = statSync(lock);
      if (now - stat.mtimeMs > LOCK_STALE_MS) {
        // Stale lock: serialize reclamation by creating a replacement lock first, then deleting the old one.
        // This ensures only one session claims the slot after a stale lock is reclaimed.
        const tmpLock = `${lock}.${process.pid}.tmp`;
        try {
          closeSync(openSync(tmpLock, 'wx')); // Claim a temp lock
          unlinkSync(lock); // Delete the stale lock
          try { renameSync(tmpLock, lock); return lock; } catch { unlinkSync(tmpLock); } // Atomic swap or fail
        } catch { /* temp lock failed, another session is reclaiming */ }
      } else {
        return null; // Fresh lock exists
      }
    } catch { mkdirSync(dir, { recursive: true }); }
  }
  return null;
}

export function startDailyCheck(dir, configDir, logDir, env, now, spawnWorker = spawn) {
  const lock = claimDailyCheck(dir, logDir, now);
  if (!lock) return;
  const release = () => { try { unlinkSync(lock); } catch { /* gone */ } };
  // Re-read daily.json after acquiring the lock: another session may have started the check
  // while we were waiting for the lock, so verify that we haven't missed the daily slot.
  const dailyPath = dailyFile(dir, logDir, 'daily.json');
  const state = readJson(dailyPath);
  if (typeof state?.lastStart === 'number' && now - state.lastStart < DAY_MS) return release();
  if (!writeJson(dailyPath, { lastStart: now })) return release();
  // A worker that cannot be started must not use up the slot of the day: put the previous state back.
  const giveUp = () => {
    release();
    if (state && typeof state === 'object') writeJson(dailyPath, state);
    else { try { unlinkSync(dailyPath); } catch { /* gone */ } }
  };
  try {
    const args = [SELF, '--daily', '--write', '--config', configDir];
    if (logDir) args.push('--log', logDir);
    const child = spawnWorker(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.on('error', giveUp);
    child.unref();
  } catch {
    giveUp();
  }
}

/**
 * UserPromptSubmit: checks (b) and (c). Returns null or { text, confirm }: the hook calls confirm() once
 * it has printed the text, only then the message counts as shown. Light: a few small files; the heavy
 * part runs in a detached process. `options.logDir` is the Jev log directory (shadow.jsonl) of the
 * prompt's project; the other options are test seams.
 */
export function promptCheck(data, options = {}) {
  const { env = process.env, now = Date.now(), pluginRoot = PLUGIN_ROOT, configDir = getClaudeConfigDir(), cwd = process.cwd() } = options;
  // One absolute key for the daily files, the acknowledgments and the worker's --log.
  const logDir = resolveLogDir(options.logDir, cwd);
  try {
    if (!isGuardEnabled(env, data?.permission_mode)) return null;
    const dir = jevDeliveryDir(configDir);
    const file = sessionFile(configDir, data);
    let record = file ? readJson(file) : null;
    if (file && (!record || typeof record !== 'object')) {
      // A session that began before the guard was enabled: the baseline is this prompt.
      record = newRecord(now, pluginRoot, configDir);
      writeJson(file, record);
    } else if (file) {
      touchRecord(file, now); // a live session keeps its baseline out of the sweep
    }
    const messages = [];
    const confirmations = [];
    let recordModified = false;
    if (record) {
      const hooks = hooksJsonHash(pluginRoot);
      const settingsEnv = settingsEnvHash(configDir);
      // A part that could not be read at session start takes its baseline at the first prompt where it can.
      if (file && ((hooks && !record.hooks) || (settingsEnv && !record.env))) {
        record.hooks ??= hooks;
        record.env ??= settingsEnv;
        writeJson(file, record);
      }
      const reasons = [];
      // P2: Reset dedupe when configuration returns to baseline
      if (hooks && record.hooks === hooks && record.warnedHooks !== null) {
        record.warnedHooks = null;
        recordModified = true;
      }
      if (settingsEnv && record.env === settingsEnv && record.warnedEnv !== null) {
        record.warnedEnv = null;
        recordModified = true;
      }
      if (hooks && record.hooks && hooks !== record.hooks && record.warnedHooks !== hooks) {
        reasons.push("the plugin's hooks/hooks.json (hook entries and timeouts) changed");
        confirmations.push(() => { record.warnedHooks = hooks; });
      }
      if (settingsEnv && record.env && settingsEnv !== record.env && record.warnedEnv !== settingsEnv) {
        reasons.push('the OMC_*, ANTHROPIC_* or TYPESAFE_* variables, or the Claude Code model-routing variables (CLAUDE_CODE_BEDROCK_*, CLAUDE_CODE_USE_*, CLAUDE_CODE_SUBAGENT_MODEL, CLAUDE_MODEL), in the env section of settings.json changed');
        confirmations.push(() => { record.warnedEnv = settingsEnv; });
      }
      if (reasons.length > 0) messages.push(changedSinceStartMessage(reasons));
      const result = readJson(dailyFile(dir, logDir, 'delivery.json'));
      const key = logDir;
      const prevShown = typeof record.shownByLogDir?.[key] === 'number' ? record.shownByLogDir[key] : 0;
      if (typeof result?.ts === 'number' && result.ts > prevShown && now - result.ts <= STALE_RESULT_MS) {
        const message = deliveryMessage(result);
        if (message) {
          messages.push(message);
          confirmations.push(() => {
            if (!record.shownByLogDir) record.shownByLogDir = {};
            record.shownByLogDir[key] = result.ts;
          });
        }
      }
    }
    const state = readJson(dailyFile(dir, logDir, 'daily.json'));
    if (now - (Number(state?.lastStart) || 0) >= DAY_MS) startDailyCheck(dir, configDir, logDir, env, now);
    // Persist cleared warnedHooks/warnedEnv even if no warning was generated
    if (recordModified && file && messages.length === 0) {
      writeJson(file, record);
    }
    if (messages.length === 0) return null;
    return {
      text: messages.join('\n'),
      confirm: () => {
        for (const confirm of confirmations) confirm();
        if (file) writeJson(file, record);
      },
    };
  } catch {
    return null;
  }
}

// ---- (c) the daily check ----------------------------------------------------------------------------------------------

/** Files under `dir` (depth-limited) whose name matches and whose mtime is not older than `since`. */
function listFiles(dir, matches, since, depth = 0, found = []) {
  if (Array.isArray(dir)) { for (const each of dir) listFiles(each, matches, since, depth, found); return found; } // a list of directories
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 6) listFiles(path, matches, since, depth + 1, found);
    } else if (matches(entry.name)) {
      try { if (statSync(path).mtimeMs >= since) found.push(path); } catch { /* gone */ }
    }
  }
  return found;
}

async function* linesOf(path) {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } catch { /* unreadable file: the lines read so far stand */ }
}

// Active model-routing decisions of the window that carry a tool_use_id field:
// tool_use_id -> the model Jev chose. Rotated files (shadow-<stamp>-<pid>.jsonl) are read too.
// With `withEffort` (OMC_JEV_GUARD_EFFORT) the value is {model, effort}, the effort being the level of the
// answer's effort score (rounded half to even, capped by OMC_JEV_MAX_EFFORT); a decision without a numeric
// score is left out then.
async function readDecisions(logDir, since, until, { withEffort = false, env = process.env } = {}) {
  const decisions = new Map();
  if (!logDir) return decisions;
  for (const path of listFiles(logDir, (name) => /^shadow(-\d{8}-\d{6}(-\d+)?)?\.jsonl$/.test(name), since)) {
    for await (const line of linesOf(path)) {
      if (!line.includes('"model-routing"') || !line.includes('"active"')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const at = Date.parse(row?.ts);
      const choice = row?.answers?.['model-tier']?.choice;
      if (row.point !== 'model-routing' || row.mode !== 'active' || typeof row.tool_use_id !== 'string' || typeof choice !== 'string') continue;
      if (!(at > since && at <= until)) continue;
      if (!withEffort) { decisions.set(row.tool_use_id, choice.toLowerCase()); continue; }
      const score = row?.answers?.effort?.score;
      if (typeof score !== 'number') continue;
      decisions.set(row.tool_use_id, { model: choice.toLowerCase(), effort: levelFromScore(score, env.OMC_JEV_MAX_EFFORT ?? 'max') });
    }
  }
  return decisions;
}

// The effort level of a score (0-4): rounded to the nearest level, a half to the even one, at most `cap`.
export function levelFromScore(score, cap = 'max') {
  const below = Math.floor(score);
  const frac = score - below;
  const index = frac < 0.5 ? below : frac > 0.5 ? below + 1 : (below % 2 === 0 ? below : below + 1);
  const capped = LEVELS.indexOf(String(cap).trim().toLowerCase());
  return LEVELS[Math.min(index, 4, capped === -1 ? 4 : capped)];
}

// Tool use ids of the window's model-routing decisions that carried a `use` marker (applied.jsonl rows whose
// applied model or effort has source "marker"); those calls are not the hook's to deliver.
async function readMarkerIds(logDir, since, until) {
  const ids = new Set();
  if (!logDir) return ids;
  for (const path of listFiles(logDir, (name) => /^applied(-\d{8}-\d{6}(-\d+)?)?\.jsonl$/.test(name), since)) {
    for await (const line of linesOf(path)) {
      if (!line.includes('"model-routing"') || !line.includes('"marker"')) continue;
      try {
        const row = JSON.parse(line);
        const at = Date.parse(row.ts);
        if (row.point === 'model-routing' && row.tool_use_id && at > since && at <= until && (row.applied?.model?.source === 'marker' || row.applied?.effort?.source === 'marker')) ids.add(row.tool_use_id);
      } catch { /* a cut or foreign line */ }
    }
  }
  return ids;
}

// The variables Claude Code reads to resolve a tier alias to a model id; the first one that is set wins, as in
// pre-tool-enforcer.mjs (TIER_TO_DEFAULT_ENV_KEYS). The OMC-internal ones (OMC_SUBAGENT_MODEL, OMC_MODEL_*) are left
// out: Claude Code does not read them, so they do not change which model an alias runs on.
const TIER_ENV_KEYS = {
  haiku: ['CLAUDE_CODE_BEDROCK_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
  sonnet: ['CLAUDE_CODE_BEDROCK_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
  opus: ['CLAUDE_CODE_BEDROCK_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
  fable: ['CLAUDE_CODE_BEDROCK_FABLE_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL'],
};
const modelId = (value) => String(value ?? '').trim().toLowerCase().replace(/\[[^\]]*\]$/, ''); // "[1m]" is a context suffix, not part of the id
const configuredTierModel = (tier, env) => {
  for (const key of Object.hasOwn(TIER_ENV_KEYS, tier) ? TIER_ENV_KEYS[tier] : []) { // a tier name like "constructor" is no tier
    const value = modelId(env[key]);
    if (value) return value;
  }
  return '';
};
// meta.json holds the alias the call was made with ("opus"), a full id with the tier as a whole word
// ("claude-opus-4-8"), or the id the configuration maps the tier to ("kimi-k2.6:cloud" for sonnet). Never a
// prefix or a part of a word: "claude-opus-4-8" is not "haiku" and "opusx" is not "opus".
// Note: when tier mappings change, this uses the current env to resolve the tier, which may differ from
// the env when the decision was made. To fix false alarms from tier mapping changes, record the resolved
// tier id in the Jev shadow log alongside the tier alias, so comparisons use the contemporaneous mapping.
const modelMatches = (actual, wanted, env = process.env) => {
  const have = modelId(actual);
  const tier = modelId(wanted);
  if (!have || !tier) return false;
  return have === tier || have.split(/[^a-z0-9]+/).includes(tier) || have === configuredTierModel(tier, env);
};

// Models of the agents that ran in the window: tool use id -> model, from the agents' meta.json files.
function readAgentModels(projectsDir, since) {
  const models = new Map();
  for (const path of listFiles(projectsDir, (name) => /^agent-.+\.meta\.json$/.test(name), since)) {
    const meta = readJson(path);
    if (typeof meta?.toolUseId === 'string') models.set(meta.toolUseId, String(meta.model ?? '').toLowerCase());
  }
  return models;
}

// Model, effort and name of the agents that ran in the window: tool use id -> {model, effort, name}.
function readAgentMetas(projectsDir, since) {
  const metas = new Map();
  for (const path of listFiles(projectsDir, (name) => /^agent-.+\.meta\.json$/.test(name), since)) {
    const meta = readJson(path);
    if (typeof meta?.toolUseId === 'string') metas.set(meta.toolUseId, { model: String(meta.model ?? '').toLowerCase(), effort: String(meta.effort ?? '').toLowerCase(), name: meta.name });
  }
  return metas;
}

// PreToolUse hooks Claude Code interrupted (hook attachments with "timedOut":true in the session
// transcripts, nested agents included), each hook call counted once.
async function countInterruptions(projectsDir, since, until) {
  const counts = { agent: 0, other: 0 };
  const seen = new Set();
  for (const path of listFiles(projectsDir, (name) => name.endsWith('.jsonl'), since)) {
    for await (const line of linesOf(path)) {
      if (!line.includes('"timedOut":true')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const hookName = row?.attachment?.hookName;
      const at = Date.parse(row?.timestamp);
      if (typeof hookName !== 'string' || !hookName.startsWith('PreToolUse') || !(at > since && at <= until)) continue;
      const command = typeof row.attachment.command === 'string' ? row.attachment.command : '';
      const key = `${hookName}|${command}|${row.attachment.toolUseID ?? `${row.timestamp}|${path}`}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Every plugin's hook on the event has the same hookName. A record shows the hook's command, or only a
      // label ("command hook 2") for a hook defined with args: the label cannot be told apart and counts as ours.
      const foreign = command !== '' && !command.includes('pre-tool-enforcer') && !/^command hook \d+$/.test(command);
      // Both PreToolUse:Agent and PreToolUse:Task route through the same Jev path and produce the same model loss
      if ((hookName === 'PreToolUse:Agent' || hookName === 'PreToolUse:Task') && !foreign) counts.agent++; else counts.other++;
    }
  }
  return counts;
}

// Directory of the breaker's openings log (scripts/lib/jev-breaker.mjs keeps it next to its per-endpoint directories).
const openingsDir = (env = process.env) => {
  let base = env.OMC_JEV_BREAKER_DIR;
  if (!base) {
    try { base = join(homedir(), '.omc', 'state', 'jev', 'breaker'); } catch { base = '.omc/state/jev/breaker'; }
  }
  return join(base, 'openings');
};

// Openings of the breaker in the window (one file <epoch ms>-<id>.json per opening: {ts, reason, scope, seconds,
// until, since}). `timeouts` = openings with reason no-response (any scope) that began in the window, `timeoutsAll` =
// of those the ones that held back every point, `other` = openings for any other reason, `minutes` = the union of
// [ts, until] of the no-response openings clipped to the window (an opening that began up to 30 minutes before the
// window and reaches into it counts for its part in the window). With `prune`, files older than 7 days than `wall`
// are removed (the compaction module writes there too and does not clean up).
export function countOpenings(dir, since, until, { prune = false, wall = Date.now() } = {}) {
  const out = { timeouts: 0, timeoutsAll: 0, other: 0, minutes: 0 };
  const spans = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const at = Number(name.split('-')[0]);
    if (!Number.isFinite(at)) continue;
    if (prune && wall - at > OPENINGS_KEEP_MS) { try { unlinkSync(join(dir, name)); } catch { /* gone */ } continue; }
    if (!(at > since - MAX_OPENING_MS && at <= until)) continue;
    const row = readJson(join(dir, name));
    if (!row || typeof row !== 'object') continue;
    if (row.scope !== undefined && row.scope !== 'low' && row.scope !== 'all') continue; // a breaker of one point held back no other point
    const begins = at > since;
    if (row.reason !== 'no-response') { if (begins) out.other++; continue; }
    if (begins) { out.timeouts++; if (row.scope !== 'low') out.timeoutsAll++; }
    const end = Number.isFinite(row.until) ? Math.min(row.until, until) : at;
    const from = Math.max(at, since);
    if (end > from) spans.push([from, end]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let reach = -Infinity;
  for (const [from, to] of spans) {
    const start = Math.max(from, reach);
    if (to > start) total += to - start;
    reach = Math.max(reach, to);
  }
  out.minutes = Math.round(total / 6000) / 10;
  return out;
}

/**
 * The daily figures for the window ending at `now`: interrupted PreToolUse hooks, and the share of
 * Jev's active model-routing decisions (shadow.jsonl lines with a tool_use_id) whose model is the one
 * in the agent's meta.json. Decisions with no agent found are left out of the share.
 */
/**
 * The Claude Code project directories read for transcripts and agent meta.json: `projects` of the configuration directory,
 * then the directories listed in OMC_JEV_GUARD_PROJECT_DIRS (separated like PATH), without duplicates.
 */
export function projectDirs(configDir, env = process.env) {
  const dirs = [join(configDir, 'projects')];
  for (const extra of String(env.OMC_JEV_GUARD_PROJECT_DIRS ?? '').split(delimiter)) if (extra.trim()) dirs.push(extra.trim());
  const seen = new Set();
  return dirs.filter((dir) => {
    const key = process.platform === 'linux' ? resolve(dir) : resolve(dir).toLowerCase(); // case-insensitive file systems
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function computeDelivery({ logDir, configDir = getClaudeConfigDir(), now = Date.now(), windowMs = DAY_MS, env = process.env, pruneOpenings = false } = {}) {
  const since = now - windowMs;
  const projectsDir = projectDirs(configDir, env);
  const blindAlarm = isBlindAlarmEnabled(env);
  let noMeta = 0; // decisions with no agent meta.json found
  // With forceInherit the hook leaves the model of some calls alone: the share would say nothing then.
  // Decisions are read over the settled window (since - SETTLE_MS, now - SETTLE_MS]: a decision younger
  // than SETTLE_MS may not have an agent yet, and shifting the whole window instead of trimming its tail
  // makes back-to-back daily runs cover every decision exactly once.
  const withEffort = isEffortCheckEnabled(env);
  const decisions = env.OMC_ROUTING_FORCE_INHERIT === 'true'
    ? new Map()
    : await readDecisions(logDir, since - SETTLE_MS, now - SETTLE_MS, { withEffort, env });
  const result = { ts: now, windowHours: Math.round(windowMs / 360000) / 10, decisions: decisions.size, withAgent: 0, delivered: 0, deliveredPercent: null };
  if (withEffort || isUseMarkerCheckEnabled(env)) {
    const markers = isUseMarkerCheckEnabled(env) ? await readMarkerIds(logDir, since - SETTLE_MS, now) : new Set();
    const metas = readAgentMetas(projectsDir, since - SETTLE_MS - 3600 * 1000);
    if (isUseMarkerCheckEnabled(env)) result.markerDecisions = 0;
    if (withEffort) { result.namedAgents = 0; result.namedModelMatching = 0; }
    for (const [id, wanted] of decisions) {
      if (markers.has(id)) { result.markerDecisions++; continue; }
      const meta = metas.get(id);
      if (!meta) { noMeta++; continue; }
      const wantedModel = withEffort ? wanted.model : wanted;
      if (withEffort && typeof meta.name === 'string' && meta.name.trim() !== '') {
        result.namedAgents++;
        if (modelMatches(meta.model, wantedModel, env)) result.namedModelMatching++;
        continue;
      }
      result.withAgent++;
      if (modelMatches(meta.model, wantedModel, env) && (!withEffort || meta.effort === wanted.effort)) result.delivered++;
    }
  } else {
    const models = readAgentModels(projectsDir, since - SETTLE_MS - 3600 * 1000);
    for (const [id, wanted] of decisions) {
      if (!models.has(id)) { noMeta++; continue; }
      result.withAgent++;
      if (modelMatches(models.get(id), wanted, env)) result.delivered++;
    }
  }
  if (blindAlarm) result.noMeta = noMeta;
  if (result.withAgent > 0) {
    const fullPercent = (1000 * result.delivered) / result.withAgent / 10;
    result.deliveredPercentFull = fullPercent;
    result.deliveredPercent = Math.round(fullPercent);
  }
  const interrupted = await countInterruptions(projectsDir, since, now);
  result.interruptedAgentHooks = interrupted.agent;
  result.interruptedOtherHooks = interrupted.other;
  if (isTimeoutsAlarmEnabled(env)) {
    const opened = countOpenings(openingsDir(env), since, now, { prune: pruneOpenings });
    result.breakerOpenings = opened.timeouts;
    result.breakerOpeningsAll = opened.timeoutsAll;
    result.breakerOpeningsOther = opened.other;
    result.breakerHeldMinutes = opened.minutes;
  }
  return result;
}

async function resolveDefaultLogDir(env = process.env, cwd = process.cwd()) {
  if (env.OMC_JEV_LOG_DIR) return env.OMC_JEV_LOG_DIR;
  try {
    const omcRoot = await resolveOmcStateRoot(cwd);
    return join(omcRoot, 'state', 'jev');
  } catch {
    // If resolution fails, return null and readDecisions will return empty results
    return null;
  }
}

async function runDailyCheck(argv) {
  const value = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  try { setPriority(process.pid, 19); } catch { /* the priority stays normal */ }
  const configDir = value('--config') || getClaudeConfigDir();
  const dir = jevDeliveryDir(configDir);
  const hours = Number(value('--window-hours'));
  const now = Date.parse(value('--now') ?? '');
  let result;
  let logDir;
  try {
    logDir = value('--log') || (await resolveDefaultLogDir(process.env, process.cwd()));
    result = await computeDelivery({
      logDir,
      configDir,
      now: Number.isFinite(now) ? now : Date.now(),
      windowMs: hours > 0 ? hours * 3600000 : DAY_MS,
      pruneOpenings: argv.includes('--write') && !Number.isFinite(now),
    });
  } catch (error) {
    result = { ts: Date.now(), error: String(error?.message ?? error).slice(0, 200) };
  }
  // The detached check passes --write; a run by hand only prints (with --print) and leaves the state alone.
  if (argv.includes('--write')) {
    writeJson(dailyFile(dir, logDir, 'delivery.json'), result);
    try { unlinkSync(dailyFile(dir, logDir, 'daily.lock')); } catch { /* no lock */ }
  }
  if (argv.includes('--print')) console.log(JSON.stringify(result));
}

if (process.argv[2] === '--daily' && /jev-delivery-guard\.mjs$/.test(process.argv[1] ?? '')) {
  runDailyCheck(process.argv.slice(2)).then(() => process.exit(0), () => process.exit(0));
}
