// Provider usage quota: endpoint read, pause and stop levels, response cache, circuit breaker file
// and the pool marker files that the quota guard writes and this module only reads.
// Every function takes a profile returned by loadProfile (defaults already applied).
const { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { LOOPBACK_HOSTS, PROFILE_DEFAULTS, stateDirOf, statePath } = require('./profile.cjs');
const { mask } = require('./redact.cjs');
const { EXIT, GATE_REASONS, QUOTA_LEVELS } = require('./vocab.cjs');

// Default cache lifetime of a successful quota response (profile quota.cacheSeconds).
const QUOTA_CACHE_MS = PROFILE_DEFAULTS.quota.cacheSeconds * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};
// Atomic write: temporary file in the same directory, then rename.
const writeJsonAtomic = (path, data) => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
};
const ensureStateDir = (profile, env) => {
  mkdirSync(stateDirOf(profile, env), { recursive: true, mode: 0o700 });
};
const nonEmpty = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
const formatTime = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

// Reset time of a window: the provider value, or a fallback (7 days for the week, 5 hours otherwise).
const resetOf = (limit) => (Number.isFinite(limit.nextResetTime) && limit.nextResetTime > 0
  ? limit.nextResetTime
  : Date.now() + (limit.unit === 6 ? 7 * 86400_000 : 5 * 3600_000));

const thresholds = (profile) => profile.quota.thresholds;

// Level of one percentage: STOP from the stop threshold, PAUSE from the pause threshold, null below both.
function levelOf(percent, limits) {
  if (percent >= limits.stop) return QUOTA_LEVELS.STOP;
  if (percent >= limits.pause) return QUOTA_LEVELS.PAUSE;
  return null;
}

// Level of a window pair (5 h, week): the stronger of the two; the week counts only while weeklyAsWindow is set.
function quotaLevel(windowPercent, weekPercent, limits) {
  const a = windowPercent == null ? null : levelOf(windowPercent, limits);
  const b = !limits.weeklyAsWindow || weekPercent == null ? null : levelOf(weekPercent, limits);
  return a === QUOTA_LEVELS.STOP || b === QUOTA_LEVELS.STOP ? QUOTA_LEVELS.STOP : a ?? b;
}

// Endpoint for the quota read, or null when there is no adapter or no URL.
// Order: a loopback OMC_PROVIDER_QUOTA_URL (test only) keeps its origin and the path from quota.url;
// the test key pair (OMC_PROVIDER_API_KEY_FILE) takes the origin of the loopback base URL and the path
// from quota.url; otherwise quota.url is used as configured.
function quotaUrl(profile, env = process.env) {
  const url = profile.quota.url;
  if (profile.quota.adapter === 'none' || !url) return null;
  const path = new URL(url).pathname;
  const override = nonEmpty(env.OMC_PROVIDER_QUOTA_URL);
  if (override) {
    try {
      const parsed = new URL(override);
      if (LOOPBACK_HOSTS.includes(parsed.hostname)) return `${parsed.origin}${path}`;
    } catch { /* not a URL: ignored */ }
  }
  if (nonEmpty(env.OMC_PROVIDER_API_KEY_FILE)) {
    const base = nonEmpty(env.OMC_PROVIDER_BASE_URL);
    if (!base) return null;
    try { return `${new URL(base).origin}${path}`; } catch { return null; }
  }
  return url;
}

// Reads the quota endpoint. Returns { data, fromCache } or { error, status?, auth? }.
// auth is true only for HTTP 401 and 403. HTTP 200 with success false is a read error, not an auth error.
// The cache holds successful responses only.
async function readQuota(profile, env = process.env, key, { fresh = false } = {}) {
  ensureStateDir(profile, env);
  const cachePath = statePath(profile, env, 'quota-cache.json');
  if (!fresh) {
    const cache = readJson(cachePath);
    // Use profile's quota cache lifetime instead of the constant default
    const cacheLifetimeMs = (profile.quota?.cacheSeconds ?? PROFILE_DEFAULTS.quota.cacheSeconds) * 1000;
    if (cache && typeof cache.ts === 'number' && Date.now() - cache.ts < cacheLifetimeMs && cache.response) {
      return { data: cache.response, fromCache: true };
    }
  }
  const url = quotaUrl(profile, env);
  if (!url) return { error: 'no quota endpoint is configured' };
  const authorization = profile.quota.authScheme === 'raw' ? key : `Bearer ${key}`;
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: authorization, 'Accept-Language': 'en-US,en' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    return { error: `no response from the quota endpoint (${e.name})` };
  }
  let data;
  try { data = await response.json(); } catch {
    return { error: `quota endpoint answer (HTTP ${response.status}) is not JSON`, status: response.status };
  }
  if (!response.ok || data.success === false) {
    const msg = mask(String(data?.msg ?? data?.message ?? '')).slice(0, 80);
    return {
      error: `quota endpoint refused (HTTP ${response.status}${msg ? `, ${msg}` : ''})`,
      status: response.status,
      auth: response.status === 401 || response.status === 403,
    };
  }
  writeJsonAtomic(cachePath, { ts: Date.now(), response: data });
  return { data };
}

// Circuit breaker: written after a refusal caused by quota, valid until its reset time.
function readBreaker(profile, env = process.env) {
  const breaker = readJson(statePath(profile, env, 'breaker.json'));
  return breaker && typeof breaker.until === 'number' && Number.isFinite(breaker.until) ? breaker : null;
}
function writeBreaker(profile, env = process.env, { limit, percent, reset, level }) {
  ensureStateDir(profile, env);
  writeJsonAtomic(statePath(profile, env, 'breaker.json'), {
    until: reset, class: 'quota', limit, percent, reset, level, ts: Date.now(),
  });
}
function clearBreaker(profile, env = process.env) {
  try { unlinkSync(statePath(profile, env, 'breaker.json')); } catch { /* already gone */ }
}

// Pool marker level. The gate only reads the marker files; the quota guard creates and removes them.
// Returns STOP, PAUSE or null. Without quota.pool.dir there is no pool.
function poolLevel(profile) {
  const dir = profile.quota.pool.dir;
  if (!dir) return null;
  const markers = profile.quota.pool.markers;
  if (existsSync(join(dir, markers.stop))) return QUOTA_LEVELS.STOP;
  return existsSync(join(dir, markers.pause)) ? QUOTA_LEVELS.PAUSE : null;
}

// Quota gate before a provider worker starts. Returns { refuse: false } or
// { refuse: true, code: 4, reason, level?, limit?, percent?, reset?, message }.
// Order of checks: adapter, breaker, pool markers, key, endpoint, read, auth, limits, level.
// A failed read lets the start through (fail-open), but an existing pool marker still refuses.
async function gate(profile, env = process.env, key) {
  if (profile.quota.adapter === 'none') return { refuse: false };
  const breaker = readBreaker(profile, env);
  if (breaker && breaker.until > Date.now()) {
    return {
      refuse: true,
      code: EXIT.QUOTA_REFUSED,
      reason: GATE_REASONS.BREAKER,
      message: `quota gate: start refused (breaker set after a quota refusal): ${breaker.limit} ${breaker.percent ?? '?'}%; `
        + `starts are blocked until ${formatTime(breaker.until)}; the cause is quota, not the code`,
    };
  }
  if (breaker) clearBreaker(profile, env);
  const pool = poolLevel(profile);
  if (pool) {
    const marker = pool === QUOTA_LEVELS.STOP ? profile.quota.pool.markers.stop : profile.quota.pool.markers.pause;
    return {
      refuse: true,
      code: EXIT.QUOTA_REFUSED,
      reason: GATE_REASONS.POOL,
      level: pool,
      message: `quota gate: start refused (pool level ${pool}): the provider worker pool is at ${pool} `
        + `(marker file ${marker} in the pool directory); the cause is quota, not the code`,
    };
  }
  if (!key) return { refuse: false }; // no key: the worker itself stops with exit code 3
  if (!quotaUrl(profile, env)) return { refuse: false };
  const read = await readQuota(profile, env, key);
  if (read.auth) {
    return {
      refuse: true,
      code: EXIT.QUOTA_REFUSED,
      reason: GATE_REASONS.AUTH,
      message: `quota gate: start refused: the provider rejects the API key (${read.error}); `
        + 'the cause is authentication, not the code; check the key with provider-quota',
    };
  }
  if (read.error) return { refuse: false };
  const limits = read.data?.data?.limits;
  if (!Array.isArray(limits)) return { refuse: false };
  const windowLimit = limits.find((l) => l?.unit === 3 && typeof l.percentage === 'number');
  const weekLimit = limits.find((l) => l?.unit === 6 && typeof l.percentage === 'number');
  const level = quotaLevel(windowLimit?.percentage, weekLimit?.percentage, thresholds(profile));
  if (!level) return { refuse: false };

  const windowLevel = levelOf(windowLimit?.percentage, thresholds(profile)); // which window crossed its threshold (decides limit and reset)
  const weekLevel = levelOf(weekLimit?.percentage, thresholds(profile));
  const thresholdOf = (l) => (l === QUOTA_LEVELS.STOP ? thresholds(profile).stop : thresholds(profile).pause);
  const reset = windowLevel ? resetOf(windowLimit) : resetOf(weekLimit);
  const limit = windowLevel ? 'window' : 'week';
  const percent = windowLevel ? windowLimit.percentage : weekLimit.percentage;
  writeBreaker(profile, env, { limit, percent, reset, level });
  const description = windowLevel
    ? `5 h window used at ${windowLimit.percentage}% (threshold ${thresholdOf(windowLevel)}%)`
      + (weekLevel ? `, weekly window used at ${weekLimit.percentage}% (threshold ${thresholdOf(weekLevel)}%)` : '')
    : `weekly window used at ${weekLimit.percentage}% (threshold ${thresholdOf(weekLevel)}%)`;
  return {
    refuse: true,
    code: EXIT.QUOTA_REFUSED,
    reason: GATE_REASONS.QUOTA,
    level,
    limit,
    percent,
    reset,
    message: `quota gate: start refused (level ${level}): ${description}, reset: ${formatTime(reset)}; `
      + 'the cause is quota, not the code; starts are paused until the reset',
  };
}

module.exports = {
  QUOTA_CACHE_MS,
  thresholds,
  levelOf,
  quotaLevel,
  quotaUrl,
  readQuota,
  readBreaker,
  writeBreaker,
  clearBreaker,
  poolLevel,
  gate,
  quotaGate: gate,
  resetOf,
  formatTime,
};
