'use strict';
// Provider profile: loads the JSONC profile file, applies OMC_PROVIDER_* overrides,
// validates the result and derives state paths. Nothing here reads a key file or
// touches the network. Errors are ProfileError with a code and exit status 2; messages
// name fields but never print key values or key file paths.

const { existsSync, readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');

class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProfileError';
    this.code = code; // 'config' | 'missing_profile' | 'bad_field'
    this.exit = 2;
  }
}

const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]']);
const WORKER_TOOLS = Object.freeze(['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob']);
const GUARD_BLOCKED = Object.freeze(['claude', 'claude-code', 'provider-launch', 'provider-worker', 'provider-team', 'provider-task']);

// Neutral defaults (see docs/PROVIDER-WORKERS.md, "Profile schema"). Values that belong to one
// installation come from the user's profile, never from these defaults.
const PROFILE_DEFAULTS = Object.freeze({
  shimNames: Object.freeze([]),
  claudeBinary: null,
  stateDir: null,
  models: Object.freeze({ default: 'sonnet' }),
  modelIdPrefixes: Object.freeze([]),
  contextWindow: 200000,
  requestTimeoutMs: 3000000,
  shellTimeoutMs: 660000,
  subagentModel: null,
  roles: Object.freeze(['executor']),
  worker: Object.freeze({
    model: 'sonnet',
    effort: 'high',
    tools: Object.freeze([...WORKER_TOOLS]),
    maxToolCalls: 0,
    mcp: 'none',
    disableJev: true,
    ruleFile: null,
  }),
  launch: Object.freeze({ disableJevInPrintMode: false, jevWithoutCompaction: false }),
  envPassthrough: Object.freeze({ names: Object.freeze([]), prefixes: Object.freeze([]) }),
  limits: Object.freeze({ maxSessions: 4, slotWaitMs: 120000 }),
  quota: Object.freeze({
    adapter: 'none',
    url: null,
    authScheme: 'bearer',
    thresholds: Object.freeze({ pause: 96, stop: 99, weeklyAsWindow: true }),
    exhaustedPercent: 100,
    cacheSeconds: 60,
    pool: Object.freeze({
      dir: null,
      markers: Object.freeze({ pause: 'PAUSE', stop: 'STOP', state: 'QUOTA-STATE' }),
    }),
    stopPattern: null,
  }),
  errorCodes: Object.freeze({ quota: Object.freeze([]), throttle: Object.freeze([]) }),
  proxy: Object.freeze({
    port: null,
    maxConcurrency: 4,
    idleTimeoutSeconds: 0,
    clientToken: 'auto',
    hostCheck: true,
    nonRetryableBodyPatterns: Object.freeze([]),
    retryMaxAttempts: 0,
    retryBaseDelayMs: 1000,
    retryMaxDelayMs: 30000,
    retryAfterCapMs: 120000,
    retryJitterMs: 0,
    maxBufferedBodyBytes: 64 * 1024 * 1024,
    heldBodyCapBytes: 64 * 1024,
    connectTimeoutMs: 30000,
    responseHeaderTimeoutMs: 300000,
    stopGraceMs: 2000,
    logMaxBytes: 8 * 1024 * 1024,
  }),
  guard: Object.freeze({
    blockedCommands: Object.freeze([...GUARD_BLOCKED]),
    allowedCommands: Object.freeze(['provider-advisor']),
    extraProtectedPatterns: Object.freeze([]),
    extraProtectedPaths: Object.freeze([]),
  }),
  advisor: Object.freeze({
    claudeBinary: null,
    commandName: 'provider-advisor',
    defaultModel: 'opus',
    models: Object.freeze(['opus', 'sonnet', 'fable']),
    timeoutSeconds: 600,
    roleFile: null,
    limits: Object.freeze({ perTask: 4, perGroup: 4, topSlots: 2, queueWaitMs: 15000 }),
  }),
  rescue: Object.freeze({ mode: 'off', threshold: 2, advisorLimit: 2 }),
});

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function fail(path, expected) {
  throw new ProfileError('bad_field', `provider profile field ${path}: expected ${expected}`);
}

// Validators: each takes (value, path) and returns the normalized value or throws.
const rule = {
  str: (v, p) => {
    if (typeof v !== 'string' || !v.trim()) fail(p, 'a non-empty string');
    return v;
  },
  nullableStr: (v, p) => (v === null ? null : rule.str(v, p)),
  url: (v, p) => {
    if (typeof v !== 'string') fail(p, 'a URL string');
    let parsed;
    try { parsed = new URL(v); } catch { fail(p, 'a URL string'); }
    // https, or plain http only for a loopback host: the key is sent to this address, so it must not travel in clear text to a remote host.
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.includes(parsed.hostname))) fail(p, 'an https URL, or an http URL for a loopback host (127.0.0.1, localhost or [::1])');
    return v;
  },
  int: (min, max = Number.MAX_SAFE_INTEGER) => (v, p) => {
    if (!Number.isInteger(v) || v < min || v > max) fail(p, `an integer from ${min} to ${max}`);
    return v;
  },
  num: (min, max) => (v, p) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(p, `a number from ${min} to ${max}`);
    return v;
  },
  bool: (v, p) => {
    if (typeof v !== 'boolean') fail(p, 'true or false');
    return v;
  },
  strs: (v, p) => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) fail(p, 'an array of non-empty strings');
    return [...v];
  },
  ints: (v, p) => {
    if (!Array.isArray(v) || v.some((x) => !Number.isInteger(x) || x < 0)) fail(p, 'an array of whole numbers');
    return [...v];
  },
  oneOf: (...allowed) => (v, p) => {
    if (!allowed.includes(v)) fail(p, allowed.join(' | '));
    return v;
  },
  regexes: (v, p) => {
    rule.strs(v, p);
    for (const pattern of v) {
      try { new RegExp(pattern); } catch { fail(p, 'an array of valid regular expressions'); }
    }
    return [...v];
  },
  apiKey: (v, p) => {
    if (!isPlain(v)) fail(p, 'an object with exactly one of file, env, command');
    const keys = Object.keys(v);
    if (keys.length !== 1 || !['file', 'env', 'command'].includes(keys[0])) {
      fail(p, 'an object with exactly one of file, env, command');
    }
    return { [keys[0]]: rule.str(v[keys[0]], `${p}.${keys[0]}`) };
  },
};

const TIER = {
  id: rule.str,
  name: rule.str,
  description: rule.str,
};

// Schema tree: a function validates a leaf; a nested object describes an object section.
const SCHEMA = {
  baseUrl: rule.url,
  apiKey: rule.apiKey,
  shimNames: rule.strs,
  claudeBinary: rule.nullableStr,
  stateDir: rule.nullableStr,
  models: {
    opus: TIER,
    sonnet: TIER,
    haiku: TIER,
    default: rule.oneOf('opus', 'sonnet', 'haiku'),
  },
  modelIdPrefixes: rule.strs,
  contextWindow: rule.int(1),
  requestTimeoutMs: rule.int(1),
  shellTimeoutMs: rule.int(1),
  subagentModel: (v, p) => (v === null ? null : rule.str(v, p)),
  roles: rule.strs,
  worker: {
    model: rule.str,
    effort: rule.oneOf('low', 'medium', 'high', 'xhigh', 'max'),
    tools: rule.strs,
    maxToolCalls: rule.int(0),
    mcp: rule.oneOf('none', 'inherit'),
    disableJev: rule.bool,
    ruleFile: rule.nullableStr,
  },
  launch: {
    disableJevInPrintMode: rule.bool,
    jevWithoutCompaction: rule.bool,
  },
  envPassthrough: {
    names: rule.strs,
    prefixes: rule.strs,
  },
  limits: {
    maxSessions: rule.int(1),
    slotWaitMs: rule.int(0),
  },
  quota: {
    adapter: rule.oneOf('monitor-limits', 'none'),
    url: rule.nullableStr,
    authScheme: rule.oneOf('bearer', 'raw'),
    thresholds: {
      pause: rule.num(0, 100),
      stop: rule.num(0, 100),
      weeklyAsWindow: rule.bool,
    },
    exhaustedPercent: rule.int(1, 100),
    cacheSeconds: rule.int(0),
    pool: {
      dir: rule.nullableStr,
      markers: {
        pause: rule.str,
        stop: rule.str,
        state: rule.str,
      },
    },
    stopPattern: (v, p) => (v === null ? null : rule.regexes([v], p)[0]),
  },
  errorCodes: {
    quota: rule.ints,
    throttle: rule.ints,
  },
  proxy: {
    port: (v, p) => (v === null ? null : rule.int(1, 65535)(v, p)),
    maxConcurrency: rule.int(1),
    idleTimeoutSeconds: rule.int(0),
    clientToken: (v, p) => {
      if (v === 'auto' || v === 'none') return v;
      return rule.str(v, p);
    },
    hostCheck: rule.bool,
    nonRetryableBodyPatterns: rule.regexes,
    retryMaxAttempts: rule.int(0, 2 ** 31),
    retryBaseDelayMs: rule.int(1, 2 ** 31),
    retryMaxDelayMs: rule.int(1, 2 ** 31),
    retryAfterCapMs: rule.int(0, 2 ** 31),
    retryJitterMs: rule.int(0, 2 ** 31),
    maxBufferedBodyBytes: rule.int(1, 2 ** 40),
    heldBodyCapBytes: rule.int(1, 2 ** 31),
    connectTimeoutMs: rule.int(1, 2 ** 31),
    responseHeaderTimeoutMs: rule.int(1, 2 ** 31),
    stopGraceMs: rule.int(0, 2 ** 31),
    logMaxBytes: rule.int(1, 2 ** 40),
  },
  guard: {
    blockedCommands: rule.strs,
    allowedCommands: rule.strs,
    extraProtectedPatterns: rule.strs,
    extraProtectedPaths: rule.strs,
  },
  advisor: {
    claudeBinary: rule.nullableStr,
    commandName: rule.str,
    defaultModel: rule.str,
    models: rule.strs,
    timeoutSeconds: rule.int(1),
    roleFile: rule.nullableStr,
    limits: {
      perTask: rule.int(0),
      perGroup: rule.int(0),
      topSlots: rule.int(0),
      queueWaitMs: rule.int(0),
    },
  },
  rescue: {
    mode: rule.oneOf('off', 'shadow', 'active'),
    threshold: rule.int(0),
    advisorLimit: rule.int(0),
  },
};

function applyShape(shape, input, base, path, warnings) {
  for (const key of Object.keys(input)) {
    const here = path ? `${path}.${key}` : key;
    const entry = shape[key];
    if (entry === undefined) {
      warnings.push(here);
      continue;
    }
    if (typeof entry === 'function') {
      base[key] = entry(input[key], here);
      continue;
    }
    if (!isPlain(input[key])) fail(here, 'an object');
    base[key] = applyShape(entry, input[key], isPlain(base[key]) ? { ...base[key] } : {}, here, warnings);
  }
  return base;
}

// Mirrors src/utils/jsonc.ts:stripJsoncComments (comment removal; string literals are copied verbatim).
function stripJsoncComments(content) {
  let result = '';
  let i = 0;
  if (content.charCodeAt(0) === 0xfeff) i = 1;
  while (i < content.length) {
    if (content[i] === '/' && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (content[i] === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
      if (i >= content.length) throw new SyntaxError('Unterminated JSONC block comment');
      i += 2;
      result += ' ';
      continue;
    }
    if (content[i] === '"') {
      result += content[i++];
      while (i < content.length && content[i] !== '"') {
        if (content[i] === '\\') {
          result += content[i++];
          if (i < content.length) result += content[i++];
          continue;
        }
        result += content[i++];
      }
      if (i < content.length) result += content[i++];
      continue;
    }
    result += content[i++];
  }
  return result;
}

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function profilesFilePath(env = process.env) {
  const explicit = nonEmpty(env.OMC_PROVIDER_PROFILES_FILE);
  if (explicit) return resolve(expandHome(explicit));
  const configHome = nonEmpty(env.XDG_CONFIG_HOME) ?? join(nonEmpty(env.HOME) ?? homedir(), '.config');
  return join(configHome, 'claude-omc', 'providers.jsonc');
}

function readDocument(file) {
  if (!existsSync(file)) return null;
  let doc;
  try {
    doc = JSON.parse(stripJsoncComments(readFileSync(file, 'utf8')));
  } catch {
    throw new ProfileError('config', 'provider profiles file is not valid JSONC');
  }
  if (!isPlain(doc) || !isPlain(doc.profiles)) {
    throw new ProfileError('config', 'provider profiles file needs an object with a "profiles" object');
  }
  return doc;
}

function setPath(target, dotted, value) {
  const parts = dotted.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlain(node[part])) node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
}

const intFrom = (min, max) => (v, p) => {
  if (!/^\d+$/.test(v)) fail(p, 'a whole number');
  return rule.int(min, max)(Number(v), p);
};

// OMC_PROVIDER_* overrides: an environment value that is set, non-empty and valid wins over the file.
const ENV_OVERRIDES = [
  ['OMC_PROVIDER_ROLES', 'roles', (v, p) => rule.strs(v.split(',').map((s) => s.trim()).filter(Boolean), p)],
  ['OMC_PROVIDER_WORKER_MODEL', 'worker.model', rule.str],
  ['OMC_PROVIDER_WORKER_EFFORT', 'worker.effort', SCHEMA.worker.effort],
  ['OMC_PROVIDER_MAX_TOOL_CALLS', 'worker.maxToolCalls', intFrom(0)],
  ['OMC_PROVIDER_MAX_SESSIONS', 'limits.maxSessions', intFrom(1)],
  ['OMC_PROVIDER_SLOT_WAIT_MS', 'limits.slotWaitMs', intFrom(0)],
  ['OMC_PROVIDER_STATE_DIR', 'stateDir', rule.str],
  ['OMC_PROVIDER_POOL_DIR', 'quota.pool.dir', rule.str],
  ['OMC_PROVIDER_STOP_PATTERN', 'quota.stopPattern', (v, p) => rule.regexes([v], p)[0]],
];

function requireFields(profile, name) {
  const need = (ok, what) => {
    if (!ok) throw new ProfileError('bad_field', `provider profile "${name}" lacks ${what}`);
  };
  need(typeof profile.baseUrl === 'string', 'required field baseUrl');
  need(isPlain(profile.apiKey), 'required field apiKey (one of file, env, command)');
  need(isPlain(profile.models) && isPlain(profile.models.opus) && typeof profile.models.opus.id === 'string', 'required field models.opus.id');
  need(isPlain(profile.models) && isPlain(profile.models.sonnet) && typeof profile.models.sonnet.id === 'string', 'required field models.sonnet.id');
  for (const tier of ['opus', 'sonnet', 'haiku']) {
    if (profile.models[tier] !== undefined) need(typeof profile.models[tier].id === 'string' && profile.models[tier].id.trim() !== '', `models.${tier}.id`);
  }
}

function loadProfile(env = process.env, { name, file, onWarning } = {}) {
  const warn = onWarning ?? ((text) => process.stderr.write(`${text}\n`));
  const path = file ?? profilesFilePath(env);
  const doc = readDocument(path);
  if (!doc) {
    // `unconfigured`: nothing is set up at all (the one case where a caller may fall back to plain Claude). The two errors below mean that a
    // profiles file exists and no usable profile was selected.
    throw Object.assign(new ProfileError('missing_profile', 'no provider profiles file; create providers.jsonc or set OMC_PROVIDER_PROFILES_FILE'), { unconfigured: true });
  }
  const names = Object.keys(doc.profiles);
  const chosen = nonEmpty(name) ?? nonEmpty(env.OMC_PROVIDER_PROFILE) ?? nonEmpty(doc.defaultProfile) ?? (names.length === 1 ? names[0] : null);
  if (!chosen) throw new ProfileError('missing_profile', 'no provider profile selected; set OMC_PROVIDER_PROFILE or defaultProfile');
  if (!names.includes(chosen)) throw new ProfileError('missing_profile', `provider profile "${chosen}" is not defined`);
  if (!isPlain(doc.profiles[chosen])) throw new ProfileError('bad_field', `provider profile "${chosen}" must be an object`);

  const warnings = [];
  const base = JSON.parse(JSON.stringify(PROFILE_DEFAULTS));
  const profile = applyShape(SCHEMA, doc.profiles[chosen], base, `profiles.${chosen}`, warnings);
  for (const field of warnings) warn(`provider profile: unknown field ${field} ignored`);

  for (const [variable, dotted, check] of ENV_OVERRIDES) {
    const raw = nonEmpty(env[variable]);
    if (raw) setPath(profile, dotted, check(raw, variable));
  }
  const keyFile = nonEmpty(env.OMC_PROVIDER_API_KEY_FILE);
  const testUrl = testBaseUrl(env);
  if (keyFile) profile.apiKey = { file: keyFile };
  if (testUrl) profile.baseUrl = testUrl;

  requireFields(profile, chosen);
  profile.name = chosen;
  profile.file = path;
  profile.stateDir = profile.stateDir ? resolve(expandHome(profile.stateDir)) : null;
  profile.claudeBinary = expandHome(profile.claudeBinary);
  profile.quota.pool.dir = profile.quota.pool.dir ? resolve(expandHome(profile.quota.pool.dir)) : null;
  profile.worker.ruleFile = expandHome(profile.worker.ruleFile);
  if (profile.apiKey.file) profile.apiKey = { file: resolve(expandHome(profile.apiKey.file)) };
  return { name: chosen, file: path, profile, fromFile: true };
}

// Test-only pair: a loopback base URL (OMC_PROVIDER_BASE_URL) is accepted only together with
// OMC_PROVIDER_API_KEY_FILE, so a forgotten test variable cannot send a real key to a foreign address.
function testBaseUrl(env = process.env) {
  const base = nonEmpty(env.OMC_PROVIDER_BASE_URL);
  const keyFile = nonEmpty(env.OMC_PROVIDER_API_KEY_FILE);
  if (!base && !keyFile) return null;
  if (!base || !keyFile) {
    throw new ProfileError('config', 'OMC_PROVIDER_BASE_URL and OMC_PROVIDER_API_KEY_FILE must be set together');
  }
  let host;
  try {
    host = new URL(base).hostname;
  } catch {
    throw new ProfileError('config', 'OMC_PROVIDER_BASE_URL is not a URL');
  }
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new ProfileError('config', 'OMC_PROVIDER_BASE_URL is allowed only for a loopback host');
  }
  return base;
}

function stateDirOf(profile, env = process.env) {
  const fromEnv = nonEmpty(env.OMC_PROVIDER_STATE_DIR);
  if (fromEnv) return resolve(expandHome(fromEnv));
  if (profile.stateDir) return resolve(expandHome(profile.stateDir));
  return join(homedir(), '.omc', 'state', 'provider', profile.name || 'default');
}

function statePath(profile, env, ...parts) {
  return join(stateDirOf(profile, env), ...parts);
}

// Advisor model for a provider session: OMC_PROVIDER_ADVISOR_MODEL (trimmed, lower case),
// the default when empty, null when the value is not in advisor.models.
function advisorModel(profile, env = process.env) {
  const advisor = { ...PROFILE_DEFAULTS.advisor, ...(profile.advisor || {}) };
  const raw = String(env.OMC_PROVIDER_ADVISOR_MODEL ?? '').trim().toLowerCase();
  if (!raw) return advisor.defaultModel;
  return advisor.models.includes(raw) ? raw : null;
}

module.exports = {
  ProfileError,
  PROFILE_DEFAULTS,
  LOOPBACK_HOSTS,
  WORKER_TOOLS,
  GUARD_BLOCKED,
  loadProfile,
  profilesFilePath,
  stateDirOf,
  statePath,
  testBaseUrl,
  advisorModel,
  stripJsoncComments,
  expandHome,
};
