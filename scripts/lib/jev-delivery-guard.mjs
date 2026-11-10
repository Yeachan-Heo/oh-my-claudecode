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
 *      Also records, per session id, a hash of hooks.json and of the OMC_* / ANTHROPIC_* keys of the
 *      settings.json `env` section. A /compact keeps the record (same process); a session without a
 *      record gets its baseline at its first prompt.
 *  (b) promptCheck(): hooks.json or those env keys differ from the session's record -> one message per
 *      change, "restart the session". Only hashes are stored (sha256, 16 hex digits); values never are.
 *  (c) promptCheck() also starts, at most once per 24 hours, a detached process (this file with
 *      --daily) that reads the session transcripts of the last 24 hours for interrupted PreToolUse
 *      hooks (lines with "timedOut":true: only the hook name, time and tool use id are read; nothing
 *      is stored) and, when shadow.jsonl lines carry a tool_use_id field, the share of
 *      active model-routing decisions whose model reached the agent (agent meta.json). The next prompt
 *      shows a message when any PreToolUse:Agent hook was interrupted or the share is below 95 %.
 *      Decisions the hook deliberately left alone (a `use` marker, forceInherit) count as not
 *      delivered. Lines without tool_use_id are skipped: with a log that has none, only interruptions are reported.
 *
 * State: <config dir>/.omc/jev-guard/ (sessions/<id>.json, daily.json, daily.lock, delivery.json).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { setPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseJevEnv } from '../jev-resolve.mjs';
import { getClaudeConfigDir } from './config-dir.mjs';

export const DEFAULT_MIN_TIMEOUT_S = 60;
export const DELIVERY_ALERT_PERCENT = 95;
const DAY_MS = 24 * 3600 * 1000;
const SESSION_RECORD_MAX_AGE_MS = 14 * DAY_MS;
const LOCK_STALE_MS = 30 * 60 * 1000;
const SETTLE_MS = 120 * 1000; // a decision younger than this may not have an agent yet
const SESSION_ID = /^[A-Za-z0-9._-]{1,200}$/;
const SELF = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = join(dirname(SELF), '..', '..');

/** The guard runs only when asked for and only while Jev decides the model of Task/Agent calls. */
export function isGuardEnabled(env = process.env) {
  return ['1', 'true'].includes(String(env.OMC_JEV_GUARD ?? '').trim().toLowerCase())
    && parseJevEnv('model-routing', env) === 'active';
}

/** OMC_JEV_GUARD_MIN_TIMEOUT_S: a positive number of seconds, else the default. */
export function minTimeoutSeconds(env = process.env) {
  const value = Number(String(env.OMC_JEV_GUARD_MIN_TIMEOUT_S ?? '').trim());
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MIN_TIMEOUT_S;
}

const guardDir = (configDir) => join(configDir, '.omc', 'jev-guard');
const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

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

/** Hash of the plugin's hooks/hooks.json, or null when it cannot be read. */
export function hooksJsonHash(pluginRoot = PLUGIN_ROOT) {
  try {
    return digest(readFileSync(join(pluginRoot, 'hooks', 'hooks.json')));
  } catch {
    return null;
  }
}

/**
 * Hash of the OMC_* and ANTHROPIC_* keys of the `env` section of settings.json (sorted key=value
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
    .filter(([key]) => /^(OMC_|ANTHROPIC_)/.test(key))
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
  return SESSION_ID.test(id) ? join(guardDir(configDir), 'sessions', `${id}.json`) : null;
}

function newRecord(now, pluginRoot, configDir) {
  return { start: now, hooks: hooksJsonHash(pluginRoot), env: settingsEnvHash(configDir), warnedHooks: null, warnedEnv: null, shown: 0 };
}

// At most once per 24 hours (a marker file): the directory grows with every headless run.
function pruneSessions(dir, now) {
  try {
    const marker = join(dir, '.swept');
    try { if (now - statSync(marker).mtimeMs < DAY_MS) return; } catch { /* never swept */ }
    writeFileSync(marker, String(now));
    for (const name of readdirSync(dir)) {
      if (name === '.swept') continue;
      const path = join(dir, name);
      try { if (now - statSync(path).mtimeMs > SESSION_RECORD_MAX_AGE_MS) unlinkSync(path); } catch { /* removed meanwhile */ }
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
    if (!isGuardEnabled(env)) return null;
    const file = sessionFile(configDir, data);
    if (file) {
      // /compact continues the same process with the same session id: it keeps what it loaded at its start.
      if (data?.source !== 'compact') writeJson(file, newRecord(now, pluginRoot, configDir));
      pruneSessions(dirname(file), now);
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
  const interrupted = Number(result.interruptedAgentHooks) || 0;
  const percent = typeof result.deliveredPercent === 'number' ? result.deliveredPercent : null;
  if (!(interrupted > 0 || (percent !== null && percent < DELIVERY_ALERT_PERCENT))) return null;
  const share = percent === null
    ? 'no active model-routing decision could be matched to an agent'
    : `${result.delivered} of ${result.withAgent} Jev model decisions reached the agent (${percent} %)`;
  return `Jev delivery guard: in the last ${result.windowHours} h ${share}; PreToolUse:Agent hooks interrupted: ${interrupted} (other PreToolUse hooks: ${Number(result.interruptedOtherHooks) || 0}). An interrupted hook loses Jev's model and effort for that call: check the pre-tool-enforcer timeout in hooks/hooks.json and restart sessions started before it was raised.`;
}

// Takes the slot of the daily check: a lock file created exclusively; a lock older than 30 minutes is a dead check.
function claimDailyCheck(dir, now) {
  const lock = join(dir, 'daily.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try { closeSync(openSync(lock, 'wx')); return lock; } catch { /* exists or no directory */ }
    try {
      if (now - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock); else return null;
    } catch { mkdirSync(dir, { recursive: true }); }
  }
  return null;
}

function startDailyCheck(dir, configDir, logDir, env, now) {
  const lock = claimDailyCheck(dir, now);
  if (!lock) return;
  const release = () => { try { unlinkSync(lock); } catch { /* gone */ } };
  if (!writeJson(join(dir, 'daily.json'), { lastStart: now })) return release();
  try {
    const args = [SELF, '--daily', '--config', configDir];
    if (logDir) args.push('--log', logDir);
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.on('error', release);
    child.unref();
  } catch {
    release();
  }
}

/**
 * UserPromptSubmit: checks (b) and (c). Returns null or { text, confirm }: the hook calls confirm() once
 * it has printed the text, only then the message counts as shown. Light: a few small files; the heavy
 * part runs in a detached process. `options.logDir` is the Jev log directory (shadow.jsonl) of the
 * prompt's project; the other options are test seams.
 */
export function promptCheck(data, options = {}) {
  const { env = process.env, now = Date.now(), pluginRoot = PLUGIN_ROOT, configDir = getClaudeConfigDir(), logDir } = options;
  try {
    if (!isGuardEnabled(env)) return null;
    const dir = guardDir(configDir);
    const file = sessionFile(configDir, data);
    let record = file ? readJson(file) : null;
    if (file && (!record || typeof record !== 'object')) {
      // A session that began before the guard was enabled: the baseline is this prompt.
      record = newRecord(now, pluginRoot, configDir);
      writeJson(file, record);
    }
    const messages = [];
    const confirmations = [];
    if (record) {
      const hooks = hooksJsonHash(pluginRoot);
      const settingsEnv = settingsEnvHash(configDir);
      const reasons = [];
      if (hooks && record.hooks && hooks !== record.hooks && record.warnedHooks !== hooks) {
        reasons.push("the plugin's hooks/hooks.json (hook entries and timeouts) changed");
        confirmations.push(() => { record.warnedHooks = hooks; });
      }
      if (settingsEnv && record.env && settingsEnv !== record.env && record.warnedEnv !== settingsEnv) {
        reasons.push('the OMC_* or ANTHROPIC_* variables in the env section of settings.json changed');
        confirmations.push(() => { record.warnedEnv = settingsEnv; });
      }
      if (reasons.length > 0) messages.push(changedSinceStartMessage(reasons));
      const result = readJson(join(dir, 'delivery.json'));
      if (typeof result?.ts === 'number' && result.ts > (Number(record.shown) || 0)) {
        const message = deliveryMessage(result);
        if (message) {
          messages.push(message);
          confirmations.push(() => { record.shown = result.ts; });
        }
      }
    }
    const state = readJson(join(dir, 'daily.json'));
    if (now - (Number(state?.lastStart) || 0) >= DAY_MS) startDailyCheck(dir, configDir, logDir, env, now);
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
async function readDecisions(logDir, since, until) {
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
      if (at > since && at <= until - SETTLE_MS) decisions.set(row.tool_use_id, choice.toLowerCase());
    }
  }
  return decisions;
}

// Models of the agents that ran in the window: tool use id -> model, from the agents' meta.json files.
function readAgentModels(projectsDir, since) {
  const models = new Map();
  for (const path of listFiles(projectsDir, (name) => /^agent-.+\.meta\.json$/.test(name), since)) {
    const meta = readJson(path);
    if (typeof meta?.toolUseId === 'string') models.set(meta.toolUseId, String(meta.model ?? '').toLowerCase());
  }
  return models;
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
      const key = `${hookName}|${row.attachment.toolUseID ?? `${row.timestamp}|${path}`}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (hookName === 'PreToolUse:Agent') counts.agent++; else counts.other++;
    }
  }
  return counts;
}

/**
 * The daily figures for the window ending at `now`: interrupted PreToolUse hooks, and the share of
 * Jev's active model-routing decisions (shadow.jsonl lines with a tool_use_id) whose model is the one
 * in the agent's meta.json. Decisions with no agent found are left out of the share.
 */
export async function computeDelivery({ logDir, configDir = getClaudeConfigDir(), now = Date.now(), windowMs = DAY_MS } = {}) {
  const since = now - windowMs;
  const projectsDir = join(configDir, 'projects');
  const decisions = await readDecisions(logDir, since, now);
  const models = readAgentModels(projectsDir, since - 3600 * 1000);
  const result = { ts: now, windowHours: Math.round(windowMs / 360000) / 10, decisions: decisions.size, withAgent: 0, delivered: 0, deliveredPercent: null };
  for (const [id, wanted] of decisions) {
    if (!models.has(id)) continue;
    result.withAgent++;
    if (models.get(id) === wanted) result.delivered++;
  }
  if (result.withAgent > 0) result.deliveredPercent = Math.round((1000 * result.delivered) / result.withAgent) / 10;
  const interrupted = await countInterruptions(projectsDir, since, now);
  result.interruptedAgentHooks = interrupted.agent;
  result.interruptedOtherHooks = interrupted.other;
  return result;
}

async function runDailyCheck(argv) {
  const value = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  try { setPriority(process.pid, 19); } catch { /* the priority stays normal */ }
  const configDir = value('--config') || getClaudeConfigDir();
  const dir = guardDir(configDir);
  let result;
  try {
    result = await computeDelivery({
      logDir: value('--log'),
      configDir,
      now: value('--now') ? Date.parse(value('--now')) : Date.now(),
      windowMs: value('--window-hours') ? Number(value('--window-hours')) * 3600000 : DAY_MS,
    });
  } catch (error) {
    result = { ts: Date.now(), error: String(error?.message ?? error).slice(0, 200) };
  }
  writeJson(join(dir, 'delivery.json'), result);
  try { unlinkSync(join(dir, 'daily.lock')); } catch { /* no lock */ }
  if (argv.includes('--print')) console.log(JSON.stringify(result));
}

if (process.argv[2] === '--daily' && /jev-delivery-guard\.mjs$/.test(process.argv[1] ?? '')) {
  runDailyCheck(process.argv.slice(2)).then(() => process.exit(0), () => process.exit(0));
}
