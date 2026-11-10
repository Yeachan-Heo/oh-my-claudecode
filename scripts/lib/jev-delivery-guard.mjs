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
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { setPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseJevEnv } from '../jev-resolve.mjs';
import { resolveOmcStateRoot, resolveSessionStatePathsForHook } from './state-root.mjs';
import { getClaudeConfigDir } from './config-dir.mjs';

export const DEFAULT_MIN_TIMEOUT_S = 60;
export const DELIVERY_ALERT_PERCENT = 95;
const DAY_MS = 24 * 3600 * 1000;
const STALE_RESULT_MS = 2 * DAY_MS; // a daily result older than this is not shown
const SESSION_RECORD_MAX_AGE_MS = 14 * DAY_MS;
const LOCK_STALE_MS = 30 * 60 * 1000;
const SETTLE_MS = 120 * 1000; // a decision younger than this may not have an agent yet
const SESSION_ID = /^[A-Za-z0-9._-]{1,200}$/;
const SELF = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = join(dirname(SELF), '..', '..');

/** The guard runs only when asked for and only while Jev decides the model of Task/Agent calls. */
export function isGuardEnabled(env = process.env, permissionMode) {
  return ['1', 'true'].includes(String(env.OMC_JEV_GUARD ?? '').trim().toLowerCase())
    && parseJevEnv('model-routing', env, permissionMode) === 'active';
}

/** OMC_JEV_GUARD_MIN_TIMEOUT_S: a positive number of seconds, else the default. */
export function minTimeoutSeconds(env = process.env) {
  const value = Number(String(env.OMC_JEV_GUARD_MIN_TIMEOUT_S ?? '').trim());
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MIN_TIMEOUT_S;
}

const guardDir = (configDir) => join(configDir, '.omc', 'jev-guard');
const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
// Resolve relative log paths to absolute to prevent collisions between projects with same relative path
const resolveLogDir = (logDir, cwd = process.cwd()) => {
  if (!logDir) return '';
  const str = String(logDir);
  return str.startsWith('/') || (str.length > 1 && str[1] === ':') ? str : join(cwd, str);
};
// The daily check belongs to one Jev log directory (one project's log), so its files carry a key of it.
const dailyFile = (dir, logDir, kind) => {
  const [name, extension] = kind.split('.');
  return join(dir, `${name}-${digest(resolveLogDir(logDir))}.${extension}`);
};
/** Path of a daily-check state file (kind: daily.json, daily.lock or delivery.json) for a Jev log directory. */
export const dailyStatePath = (configDir, logDir, kind) => dailyFile(guardDir(configDir), logDir, kind);

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

async function sessionFile(directory, data) {
  const id = String(data?.session_id ?? data?.sessionId ?? '');
  if (!SESSION_ID.test(id)) return null;
  const paths = await resolveSessionStatePathsForHook(directory, 'jev-delivery-guard', id);
  return { readPath: paths.readPath, writePath: paths.writePath };
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
export async function startSession(data, options = {}) {
  const { env = process.env, now = Date.now(), pluginRoot = PLUGIN_ROOT, configDir = getClaudeConfigDir(), cwd = process.cwd() } = options;
  try {
    if (!isGuardEnabled(env, data?.permission_mode)) return null;
    const file = await sessionFile(cwd, data);
    if (file) {
      // /compact continues the same process with the same session id: it keeps what it loaded at its start.
      if (data?.source !== 'compact') writeJson(file.writePath, newRecord(now, pluginRoot, configDir));
      else touchRecord(file.writePath, now);
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
  // Use full-precision percent if available (production), otherwise fall back to rounded percent (tests/legacy)
  const thresholdPercent = typeof result.deliveredPercentFull === 'number' ? result.deliveredPercentFull : percent;
  if (!(interrupted > 0 || (thresholdPercent !== null && thresholdPercent < DELIVERY_ALERT_PERCENT))) return null;
  const share = percent === null
    ? 'no active model-routing decision could be matched to an agent'
    : `${result.delivered} of ${result.withAgent} Jev model decisions reached the agent (${percent} %; a call the hook leaves alone on purpose, such as a \`use\` marker or forceInherit, counts as not delivered)`;
  return `Jev delivery guard: in the last ${result.windowHours} h ${share}; PreToolUse:Agent hooks interrupted: ${interrupted} (hooks of other commands: ${Number(result.interruptedOtherHooks) || 0}). An interrupted hook loses Jev's model and effort for that call: check the pre-tool-enforcer timeout in hooks/hooks.json and restart sessions started before it was raised.`;
}

// Takes the slot of the daily check: a lock file created exclusively; a lock older than 30 minutes is a dead check.
function claimDailyCheck(dir, logDir, now) {
  const lock = dailyFile(dir, logDir, 'daily.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try { closeSync(openSync(lock, 'wx')); return lock; } catch { /* exists or no directory */ }
    try {
      if (now - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock); else return null;
    } catch { mkdirSync(dir, { recursive: true }); }
  }
  return null;
}

function startDailyCheck(dir, configDir, logDir, env, now) {
  const lock = claimDailyCheck(dir, logDir, now);
  if (!lock) return;
  const release = () => { try { unlinkSync(lock); } catch { /* gone */ } };
  // Re-read daily.json after acquiring the lock: another session may have started the check
  // while we were waiting for the lock, so verify that we haven't missed the daily slot.
  const state = readJson(dailyFile(dir, logDir, 'daily.json'));
  if (typeof state?.lastStart === 'number' && now - state.lastStart < DAY_MS) return release();
  if (!writeJson(dailyFile(dir, logDir, 'daily.json'), { lastStart: now })) return release();
  try {
    const args = [SELF, '--daily', '--write', '--config', configDir];
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
export async function promptCheck(data, options = {}) {
  const { env = process.env, now = Date.now(), pluginRoot = PLUGIN_ROOT, configDir = getClaudeConfigDir(), logDir, cwd = process.cwd() } = options;
  try {
    if (!isGuardEnabled(env, data?.permission_mode)) return null;
    const dir = guardDir(configDir);
    const file = await sessionFile(cwd, data);
    let record = file ? readJson(file.readPath) : null;
    if (file && (!record || typeof record !== 'object')) {
      // A session that began before the guard was enabled: the baseline is this prompt.
      record = newRecord(now, pluginRoot, configDir);
      writeJson(file.writePath, record);
    } else if (file) {
      touchRecord(file.writePath, now); // a live session keeps its baseline out of the sweep
    }
    const messages = [];
    const confirmations = [];
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
      const key = resolveLogDir(logDir, cwd);
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
    if (messages.length === 0) return null;
    return {
      text: messages.join('\n'),
      confirm: () => {
        for (const confirm of confirmations) confirm();
        if (file) writeJson(file.writePath, record);
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
// Decisions within SETTLE_MS of the window upper bound are included: they may complete in later windows.
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
      if (at > since && at <= until) decisions.set(row.tool_use_id, choice.toLowerCase());
    }
  }
  return decisions;
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

/**
 * The daily figures for the window ending at `now`: interrupted PreToolUse hooks, and the share of
 * Jev's active model-routing decisions (shadow.jsonl lines with a tool_use_id) whose model is the one
 * in the agent's meta.json. Decisions with no agent found are left out of the share.
 */
export async function computeDelivery({ logDir, configDir = getClaudeConfigDir(), now = Date.now(), windowMs = DAY_MS, env = process.env } = {}) {
  const since = now - windowMs;
  const projectsDir = join(configDir, 'projects');
  // With forceInherit the hook leaves the model of some calls alone: the share would say nothing then.
  const decisions = env.OMC_ROUTING_FORCE_INHERIT === 'true' ? new Map() : await readDecisions(logDir, since, now);
  const models = readAgentModels(projectsDir, since - 3600 * 1000);
  const result = { ts: now, windowHours: Math.round(windowMs / 360000) / 10, decisions: decisions.size, withAgent: 0, delivered: 0, deliveredPercent: null };
  for (const [id, wanted] of decisions) {
    if (!models.has(id)) continue;
    result.withAgent++;
    if (modelMatches(models.get(id), wanted, env)) result.delivered++;
  }
  if (result.withAgent > 0) {
    const fullPercent = (1000 * result.delivered) / result.withAgent / 10;
    result.deliveredPercentFull = fullPercent;
    result.deliveredPercent = Math.round(fullPercent);
  }
  const interrupted = await countInterruptions(projectsDir, since, now);
  result.interruptedAgentHooks = interrupted.agent;
  result.interruptedOtherHooks = interrupted.other;
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
  const dir = guardDir(configDir);
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
