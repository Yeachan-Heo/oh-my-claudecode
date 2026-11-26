#!/usr/bin/env node
// Local loopback proxy for an Anthropic-compatible provider, and the command that controls it.
//
//   provider-proxy.mjs start  [options]   start the shared background server (idempotent)
//   provider-proxy.mjs stop   [options]   stop it (idempotent)
//   provider-proxy.mjs status [--json] [options]
//
// One server runs per state directory. It listens on 127.0.0.1 only, limits the number of
// requests in flight to the provider (one global FIFO gate), replaces the client credentials
// with the provider key that only the server holds, retries throttling (429) and 5xx answers
// before the client sees them, and streams every other answer without buffering.
//
// Options (command line wins over OMC_PROVIDER_PROXY_<NAME> environment variables, which win
// over the profile selected with --profile, which wins over the defaults below):
//   --profile NAME            take baseUrl, apiKey and proxy.* from this provider profile
//   --upstream URL            provider base URL (https, or http on a loopback host)
//   --api-key-command PATH    executable that prints the key (no shell, 10 s limit)
//   --api-key-file PATH       file that holds the key
//   --api-key-env NAME        variable of the server environment that holds the key
//   --state-dir DIR           state directory (env OMC_PROVIDER_PROXY_DIR; with a profile:
//                             <profile state dir>/proxy)
//   --port N                  loopback port, 0 asks the OS (default 33177)
//   --max-concurrency N       requests in flight to the provider (default 4)
//   --idle-timeout SECONDS    stop after this idle time, 0 = never (default 0)
//   --retry-max-attempts N    retries after the first attempt, 0 = unlimited (default 0)
//   --retry-base-delay-ms N, --retry-max-delay-ms N, --retry-after-cap-ms N, --retry-jitter-ms N
//   --max-body-bytes N, --held-body-cap-bytes N, --connect-timeout-ms N,
//   --response-header-timeout-ms N, --stop-grace-ms N, --log-max-bytes N
//   --client-token auto|none|TOKEN   see "Client token" below (default auto)
//   --non-retryable-pattern REGEX    repeatable; a 429/5xx body that matches is not retried
//   --no-host-check           accept any Host header
//
// Client token: with "auto" the control command creates <state dir>/client-token (mode 0600)
// the first time and the server requires it as "Authorization: Bearer <token>" or "x-api-key".
// An explicit token is written to the same file. With "none" no token is required and clients
// use a fixed placeholder. The server reads the token and the key itself; neither appears in
// a command line.
//
// Exit codes: 0 ok; 1 failure (not ready, port in use, not running for status); 2 bad
// configuration or usage; 3 no usable key, or a start already in progress.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const { mask } = require('./lib/redact.cjs');
const { ProfileError, loadProfile, stateDirOf, expandHome, LOOPBACK_HOSTS } = require('./lib/profile.cjs');
const proxyState = require('./lib/proxy-state.cjs');

const SELF = fileURLToPath(import.meta.url);

// Fixed unprivileged port: long-lived clients cache the proxy URL, so it must survive restarts.
const DEFAULT_PORT = 33177;
const MIB = 1024 * 1024;

// name: [flag, environment suffix, minimum, maximum]; defaults in DEFAULTS.
const INT_OPTIONS = {
  port: ['--port', 'PORT', 0, 65535],
  maxConcurrency: ['--max-concurrency', 'MAX_CONCURRENCY', 1, 100000],
  idleTimeoutSeconds: ['--idle-timeout', 'IDLE_TIMEOUT', 0, 2 ** 31],
  retryMaxAttempts: ['--retry-max-attempts', 'RETRY_MAX_ATTEMPTS', 0, 2 ** 31],
  retryBaseDelayMs: ['--retry-base-delay-ms', 'RETRY_BASE_DELAY_MS', 1, 2 ** 31],
  retryMaxDelayMs: ['--retry-max-delay-ms', 'RETRY_MAX_DELAY_MS', 1, 2 ** 31],
  retryAfterCapMs: ['--retry-after-cap-ms', 'RETRY_AFTER_CAP_MS', 0, 2 ** 31],
  retryJitterMs: ['--retry-jitter-ms', 'RETRY_JITTER_MS', 0, 2 ** 31],
  maxBufferedBodyBytes: ['--max-body-bytes', 'MAX_BODY_BYTES', 1, 2 ** 40],
  heldBodyCapBytes: ['--held-body-cap-bytes', 'HELD_BODY_CAP_BYTES', 1, 2 ** 31],
  connectTimeoutMs: ['--connect-timeout-ms', 'CONNECT_TIMEOUT_MS', 1, 2 ** 31],
  responseHeaderTimeoutMs: ['--response-header-timeout-ms', 'RESPONSE_HEADER_TIMEOUT_MS', 1, 2 ** 31],
  stopGraceMs: ['--stop-grace-ms', 'STOP_GRACE_MS', 0, 2 ** 31],
  logMaxBytes: ['--log-max-bytes', 'LOG_MAX_BYTES', 1, 2 ** 40],
};

const DEFAULTS = Object.freeze({
  port: DEFAULT_PORT,
  maxConcurrency: 4,
  idleTimeoutSeconds: 0,
  retryMaxAttempts: 0,
  retryBaseDelayMs: 1000,
  retryMaxDelayMs: 30000,
  retryAfterCapMs: 120000,
  retryJitterMs: 0,
  maxBufferedBodyBytes: 64 * MIB,
  heldBodyCapBytes: 64 * 1024,
  connectTimeoutMs: 30000,
  responseHeaderTimeoutMs: 300000,
  stopGraceMs: 2000,
  logMaxBytes: 8 * MIB,
});

const STRING_FLAGS = {
  '--profile': 'profile',
  '--upstream': 'upstream',
  '--api-key-command': 'apiKeyCommand',
  '--api-key-file': 'apiKeyFile',
  '--api-key-env': 'apiKeyEnv',
  '--state-dir': 'stateDir',
  '--client-token': 'clientToken',
  '--client-token-file': 'clientTokenFile',
};
const BOOLEAN_FLAGS = { '--no-host-check': 'noHostCheck', '--json': 'json' };
const ENV_PREFIX = 'OMC_PROVIDER_PROXY_';

const KEY_COMMAND_TIMEOUT_MS = 10000;
const START_WAIT_MS = 15000;
const START_POLL_MS = 200;
const LOCK_WAIT_MS = 5000;
const STOP_WAIT_MS = 3000;
const STOP_POLL_MS = 100;
const HEALTH_TIMEOUT_MS = 1000;
const DECODE_LIMIT_BYTES = MIB;
const LOG_BODY_BYTES = 512;
const EXIT = Object.freeze({ OK: 0, FAILURE: 1, CONFIG: 2, MISSING: 3 });

class OptionError extends Error {}

// --- pure helpers (exported for tests) ----------------------------------------------------------

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
]);
// Removed from every upstream request: hop-by-hop headers, headers the proxy recomputes or
// replaces, credentials of the client and forwarding headers. "expect" is answered by the
// proxy itself before the body is read, so it is not forwarded.
const REQUEST_DROPPED = new Set([
  ...HOP_BY_HOP, 'host', 'content-length', 'cookie', 'authorization', 'x-api-key', 'x-forwarded-for',
  'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'via', 'expect',
]);

function connectionTokens(value) {
  return String(value ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
}

// Headers for the upstream request: client headers minus the dropped ones, the upstream Host,
// the real key as Authorization (and as x-api-key only when the client used that header).
export function buildUpstreamHeaders(clientHeaders, upstreamHost, key, bodyLength, method) {
  const named = new Set(connectionTokens(clientHeaders.connection));
  const out = {};
  for (const [name, value] of Object.entries(clientHeaders)) {
    const lower = name.toLowerCase();
    if (REQUEST_DROPPED.has(lower) || named.has(lower)) continue;
    out[lower] = value;
  }
  out.host = upstreamHost;
  out.authorization = `Bearer ${key}`;
  if (Object.keys(clientHeaders).some((name) => name.toLowerCase() === 'x-api-key')) out['x-api-key'] = key;
  if (bodyLength > 0 || ['POST', 'PUT', 'PATCH'].includes(method)) out['content-length'] = String(bodyLength);
  return out;
}

// Flat [name, value, ...] list of provider response headers without hop-by-hop headers.
export function filterResponseHeaders(rawHeaders) {
  let named = new Set();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === 'connection') named = new Set([...named, ...connectionTokens(rawHeaders[i + 1])]);
  }
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const lower = rawHeaders[i].toLowerCase();
    if (HOP_BY_HOP.has(lower) || named.has(lower)) continue;
    out.push(rawHeaders[i], rawHeaders[i + 1]);
  }
  return out;
}

// Delay of the n-th retry (n = retries already done) without Retry-After. Never zero or
// negative for a base of at least 1, and never an overflow: the exponent is bounded.
export function backoffDelayMs(n, baseMs, maxMs) {
  const exponent = Math.min(Math.max(0, Math.trunc(Number(n) || 0)), 62);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

// Delay requested by a Retry-After header (integer seconds or an HTTP date), clamped to
// [0, capMs]; null when the header is missing or unreadable. A date in the past counts as 0.
export function retryAfterDelayMs(value, capMs, nowMs = Date.now()) {
  if (value === undefined || value === null) return null;
  const text = String(Array.isArray(value) ? value[0] : value).trim();
  if (text === '') return null;
  let ms;
  if (/^\d+$/.test(text)) {
    ms = Number(text) * 1000;
  } else {
    if (!/[A-Za-z]/.test(text)) return null; // an HTTP date has day and month names
    const at = Date.parse(text);
    if (Number.isNaN(at)) return null;
    ms = at - nowMs;
  }
  return Math.min(Math.max(ms, 0), capMs);
}

// Text of a held provider body for pattern matching, or null when it cannot be decoded.
// Truncated compressed bodies are decoded as far as possible.
export function decodeBody(buffer, contentEncoding) {
  const encodings = connectionTokens(contentEncoding).filter((e) => e !== 'identity').reverse();
  let data = buffer;
  for (const encoding of encodings) {
    try {
      if (encoding === 'gzip' || encoding === 'x-gzip') {
        data = zlib.gunzipSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: DECODE_LIMIT_BYTES });
      } else if (encoding === 'deflate') {
        try {
          data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: DECODE_LIMIT_BYTES });
        } catch {
          data = zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: DECODE_LIMIT_BYTES });
        }
      } else if (encoding === 'br') {
        data = zlib.brotliDecompressSync(data, {
          finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
          maxOutputLength: DECODE_LIMIT_BYTES,
        });
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }
  return data.toString('utf8');
}

// True when a retryable-status body matches a non-retryable pattern (permanent failure).
// An undecodable body is unrecognized, which means retryable.
export function isPermanentFailure(buffer, contentEncoding, patterns) {
  if (patterns.length === 0) return false;
  const text = decodeBody(buffer, contentEncoding);
  return text !== null && patterns.some((pattern) => pattern.test(text));
}

const JSON_SECRET_FIELD = /("[^"\\]*(?:api[_-]?key|authorization|token|bearer)[^"\\]*"\s*:\s*)("(?:[^"\\]|\\.)*"|[^\s,}\]]+)/gi;

// Text safe to log: exact known secrets, credential-looking JSON fields and generic secret patterns.
export function redactText(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[REDACTED]');
  }
  return mask(out.replace(JSON_SECRET_FIELD, '$1"[REDACTED]"'));
}

const isLoopbackHostname = (hostname) => LOOPBACK_HOSTS.includes(hostname) || hostname === '::1';

// Parsed upstream URL. https is required, except http on a loopback host. A URL from the
// environment must be loopback so a stray exported variable cannot redirect the real key.
export function parseUpstream(value, { fromEnv = false } = {}) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new OptionError('upstream is not a valid URL');
  }
  if (url.username || url.password) throw new OptionError('upstream must not contain credentials');
  if (url.search || url.hash) throw new OptionError('upstream must not contain a query or a fragment');
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new OptionError('upstream must use https (http is allowed only for a loopback host)');
  }
  if (fromEnv && !loopback) throw new OptionError('an upstream given through the environment must be a loopback address');
  const basePath = url.pathname.replace(/\/+$/, '');
  return { url, basePath, target: `${url.origin}${basePath}` };
}

// --- option resolution ----------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { command: argv[0], flags: {}, patterns: [] };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (BOOLEAN_FLAGS[arg]) {
      out.flags[BOOLEAN_FLAGS[arg]] = true;
    } else if (arg === '--non-retryable-pattern' || STRING_FLAGS[arg] || Object.values(INT_OPTIONS).some((o) => o[0] === arg)) {
      if (typeof argv[i + 1] !== 'string') throw new OptionError(`${arg} needs a value`);
      const value = argv[++i];
      if (arg === '--non-retryable-pattern') out.patterns.push(value);
      else if (STRING_FLAGS[arg]) out.flags[STRING_FLAGS[arg]] = value;
      else out.flags[Object.keys(INT_OPTIONS).find((k) => INT_OPTIONS[k][0] === arg)] = value;
    } else {
      throw new OptionError(`unknown argument: ${arg}`);
    }
  }
  return out;
}

const nonEmpty = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function parseInteger(name, raw, min, max) {
  const text = String(raw).trim();
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) {
    throw new OptionError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return Number(text);
}

function loadProfileOption(parsed, env) {
  const name = nonEmpty(parsed.flags.profile) ?? nonEmpty(env[`${ENV_PREFIX}PROFILE`]);
  if (!name) return null;
  try {
    return loadProfile(env, { name }).profile;
  } catch (error) {
    if (error instanceof ProfileError) throw new OptionError(error.message);
    throw error;
  }
}

function resolveStateDir(parsed, env, profile) {
  const explicit = nonEmpty(parsed.flags.stateDir) ?? nonEmpty(env.OMC_PROVIDER_PROXY_DIR);
  if (explicit) return resolve(expandHome(explicit));
  if (profile) return join(stateDirOf(profile, env), 'proxy');
  throw new OptionError('no state directory: use --profile, --state-dir or OMC_PROVIDER_PROXY_DIR');
}

// Complete server options. Layers: command line, environment, profile, defaults.
function resolveOptions(parsed, env) {
  const profile = loadProfileOption(parsed, env);
  const opts = { profile };
  opts.stateDir = resolveStateDir(parsed, env, profile);

  const profileProxy = profile ? profile.proxy : {};
  const profileValues = {
    port: profileProxy.port ?? undefined,
    maxConcurrency: profileProxy.maxConcurrency,
    idleTimeoutSeconds: profileProxy.idleTimeoutSeconds,
    retryMaxAttempts: profileProxy.retryMaxAttempts,
    retryBaseDelayMs: profileProxy.retryBaseDelayMs,
    retryMaxDelayMs: profileProxy.retryMaxDelayMs,
    retryAfterCapMs: profileProxy.retryAfterCapMs,
    retryJitterMs: profileProxy.retryJitterMs,
    maxBufferedBodyBytes: profileProxy.maxBufferedBodyBytes,
    heldBodyCapBytes: profileProxy.heldBodyCapBytes,
    connectTimeoutMs: profileProxy.connectTimeoutMs,
    responseHeaderTimeoutMs: profileProxy.responseHeaderTimeoutMs,
    stopGraceMs: profileProxy.stopGraceMs,
    logMaxBytes: profileProxy.logMaxBytes,
  };
  for (const [name, [flag, suffix, min, max]] of Object.entries(INT_OPTIONS)) {
    const raw = parsed.flags[name] ?? nonEmpty(env[ENV_PREFIX + suffix]);
    if (raw !== undefined && raw !== null) opts[name] = parseInteger(flag, raw, min, max);
    else opts[name] = profileValues[name] ?? DEFAULTS[name];
  }
  if (opts.retryMaxDelayMs < opts.retryBaseDelayMs) opts.retryMaxDelayMs = opts.retryBaseDelayMs;

  // Upstream: command line, then the environment (loopback only), then the profile.
  const testUpstream = nonEmpty(env[`${ENV_PREFIX}TEST_UPSTREAM`]);
  const envUpstream = nonEmpty(env[`${ENV_PREFIX}UPSTREAM`]);
  let upstream;
  if (nonEmpty(parsed.flags.upstream)) upstream = parseUpstream(parsed.flags.upstream);
  else if (testUpstream) upstream = parseUpstream(testUpstream, { fromEnv: true });
  else if (envUpstream) upstream = parseUpstream(envUpstream, { fromEnv: true });
  else if (profile) upstream = parseUpstream(profile.baseUrl);
  else throw new OptionError('no upstream: use --upstream, OMC_PROVIDER_PROXY_UPSTREAM or --profile');
  opts.upstream = upstream;

  // Key sources, resolved independently. The server tries command, file, environment variable.
  const fromProfile = profile ? profile.apiKey : {};
  opts.keySources = {
    command: nonEmpty(parsed.flags.apiKeyCommand) ?? nonEmpty(env[`${ENV_PREFIX}API_KEY_COMMAND`]) ?? fromProfile.command ?? null,
    file: nonEmpty(parsed.flags.apiKeyFile) ?? nonEmpty(env[`${ENV_PREFIX}API_KEY_FILE`]) ?? fromProfile.file ?? null,
    env: nonEmpty(parsed.flags.apiKeyEnv) ?? nonEmpty(env[`${ENV_PREFIX}API_KEY_ENV`]) ?? fromProfile.env ?? null,
  };

  let patterns = parsed.patterns;
  if (patterns.length === 0 && nonEmpty(env[`${ENV_PREFIX}NON_RETRYABLE_PATTERNS`])) {
    try {
      patterns = JSON.parse(env[`${ENV_PREFIX}NON_RETRYABLE_PATTERNS`]);
    } catch {
      throw new OptionError(`${ENV_PREFIX}NON_RETRYABLE_PATTERNS must be a JSON array of strings`);
    }
    if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== 'string')) {
      throw new OptionError(`${ENV_PREFIX}NON_RETRYABLE_PATTERNS must be a JSON array of strings`);
    }
  }
  if (patterns.length === 0 && profile) patterns = profileProxy.nonRetryableBodyPatterns ?? [];
  opts.patternSources = patterns;
  try {
    opts.patterns = patterns.map((p) => new RegExp(p, 'i'));
  } catch {
    throw new OptionError('a non-retryable pattern is not a valid regular expression');
  }

  opts.hostCheck = parsed.flags.noHostCheck ? false : (profile ? profileProxy.hostCheck !== false : true);
  opts.clientToken = nonEmpty(parsed.flags.clientToken) ?? nonEmpty(env[`${ENV_PREFIX}CLIENT_TOKEN`]) ?? (profile ? profileProxy.clientToken : null) ?? 'auto';
  if (!['auto', 'none'].includes(opts.clientToken) && !/^[A-Za-z0-9._~+/=-]{8,}$/.test(opts.clientToken)) {
    throw new OptionError('the client token must be auto, none or at least 8 characters of A-Z a-z 0-9 . _ ~ + / = -');
  }
  opts.clientTokenFile = nonEmpty(parsed.flags.clientTokenFile);
  return opts;
}

// --- key sources -------------------------------------------------------------------------------

function cleanKey(text) {
  const key = String(text ?? '').trim();
  if (!key) return { error: 'is empty' };
  if (/[\s\u0000-\u001f\u007f]/.test(key)) return { error: 'contains whitespace or control characters' };
  return { key };
}

// First source that yields a non-empty key wins. Failure messages name the source, never the key or its path.
function obtainKey(sources, env) {
  const failures = [];
  if (sources.command) {
    const run = spawnSync(expandHome(sources.command), [], {
      stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: KEY_COMMAND_TIMEOUT_MS, env,
    });
    if (run.error || run.status !== 0) {
      failures.push(`key command ${run.error && run.error.code === 'ETIMEDOUT' ? 'timed out' : 'failed'}`);
    } else {
      const result = cleanKey(run.stdout);
      if (result.key) return { key: result.key };
      failures.push(`key command output ${result.error}`);
    }
  }
  if (sources.file) {
    let content = null;
    try {
      content = readFileSync(expandHome(sources.file), 'utf8');
    } catch {
      failures.push('key file cannot be read');
    }
    if (content !== null) {
      const result = cleanKey(content);
      if (result.key) return { key: result.key };
      failures.push(`key file ${result.error}`);
    }
  }
  if (sources.env) {
    const result = cleanKey(env[sources.env]);
    if (result.key) return { key: result.key };
    failures.push(`key variable ${result.error === 'is empty' ? 'is not set or empty' : result.error}`);
  }
  if (failures.length === 0) failures.push('no key source is configured');
  return { error: `no usable API key: ${failures.join('; ')}` };
}

// --- files ---------------------------------------------------------------------------------------

function writeAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, file);
}

function readInteger(file) {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return /^\d+$/.test(text) ? Number(text) : NaN;
  } catch {
    return NaN;
  }
}

function readCounters(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'counters.json'), 'utf8'));
  } catch {
    return null;
  }
}

function removeStateFiles(dir) {
  for (const name of ['proxy.pid', 'proxy.port', 'proxy.target']) {
    try {
      unlinkSync(join(dir, name));
    } catch { /* already gone */ }
  }
}

function createLogger(dir, maxBytes, secrets) {
  const file = join(dir, 'proxy.log');
  let size = 0;
  try {
    size = statSync(file).size;
    chmodSync(file, 0o600);
  } catch { /* new file */ }
  return {
    line(text) {
      const data = `${new Date().toISOString()} ${redactText(text, secrets)}\n`;
      const bytes = Buffer.byteLength(data);
      try {
        if (size > 0 && size + bytes > maxBytes) {
          renameSync(file, `${file}.1`);
          size = 0;
        }
        appendFileSync(file, data, { mode: 0o600 });
        size += bytes;
      } catch { /* a log failure never stops the proxy */ }
    },
  };
}

// --- server ---------------------------------------------------------------------------------------

// Global FIFO gate. acquire() resolves with a release function (safe to call twice) or rejects
// when the signal aborts while the request is still queued.
function createGate(limit) {
  let active = 0;
  const queue = [];
  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      pump();
    };
  };
  function pump() {
    while (active < limit && queue.length > 0) {
      const waiter = queue.shift();
      active++;
      waiter.resolve(makeRelease());
    }
  }
  return {
    get active() { return active; },
    get queued() { return queue.length; },
    acquire(signal) {
      if (signal.aborted) return Promise.reject(new Error('aborted'));
      if (active < limit && queue.length === 0) {
        active++;
        return Promise.resolve(makeRelease());
      }
      return new Promise((resolveWaiter, reject) => {
        const waiter = { resolve: resolveWaiter };
        queue.push(waiter);
        signal.addEventListener('abort', () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) {
            queue.splice(index, 1);
            reject(new Error('aborted'));
          }
        }, { once: true });
      });
    },
  };
}

function sleep(ms, signal) {
  return new Promise((done) => {
    if (signal.aborted) return done(false);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      done(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      done(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

const errorBody = (message) => ({ type: 'error', error: { type: 'proxy_error', message } });

function sameToken(given, expected) {
  const a = createHash('sha256').update(String(given)).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

function presentedTokens(headers) {
  const tokens = [];
  const auth = headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    tokens.push(match ? match[1].trim() : auth.trim());
  }
  if (typeof headers['x-api-key'] === 'string') tokens.push(headers['x-api-key'].trim());
  return tokens;
}

// One attempt: sends the buffered request and resolves when response headers arrive.
// Resolves { res } with the unread response, { failure: 'transport' | 'timeout' } or { aborted: true }.
function attemptOnce(ctx, headers, body, signal) {
  const { upstream, opts } = ctx;
  return new Promise((done) => {
    if (signal.aborted) return done({ aborted: true });
    let settled = false;
    let connectTimer = null;
    let headerTimer = null;
    let req = null;
    const clear = () => {
      clearTimeout(connectTimer);
      clearTimeout(headerTimer);
    };
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clear();
      done(value);
    };
    const onAbort = () => {
      settle({ aborted: true });
      if (req) req.destroy();
    };
    const fail = (kind) => {
      settle({ failure: kind });
      if (req) req.destroy();
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const tls = upstream.url.protocol === 'https:';
    const transport = tls ? https : http;
    try {
      req = transport.request({
        protocol: upstream.url.protocol,
        hostname: upstream.url.hostname.replace(/^\[|\]$/g, ''),
        port: upstream.url.port || (tls ? 443 : 80),
        path: ctx.path,
        method: ctx.method,
        headers,
        agent: false,
      }, (res) => {
        clear();
        settle({ res });
        res.once('close', () => signal.removeEventListener('abort', onAbort));
      });
    } catch {
      return fail('transport');
    }
    req.on('socket', (socket) => {
      if (!socket.connecting) return;
      connectTimer = setTimeout(() => fail('timeout'), opts.connectTimeoutMs);
      socket.once(tls ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
    });
    req.on('finish', () => {
      headerTimer = setTimeout(() => fail('timeout'), opts.responseHeaderTimeoutMs);
    });
    req.on('error', () => {
      if (!settled) fail('transport');
    });
    req.end(body);
  });
}

// Reads at most capBytes of a held provider response and pauses it, so the caller can decide
// to drop it (retry) or to forward it (held bytes first, the rest streamed).
function readHeld(res, capBytes, timeoutMs) {
  return new Promise((done) => {
    const chunks = [];
    let size = 0;
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      res.removeListener('data', onData);
      res.removeListener('end', onEnd);
      res.removeListener('error', onBroken);
      res.removeListener('close', onBroken);
      done(value);
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= capBytes) {
        res.pause();
        finish({ chunks, complete: false });
      }
    };
    const onEnd = () => finish({ chunks, complete: true });
    const onBroken = () => finish({ broken: true });
    const timer = setTimeout(() => {
      res.destroy();
      finish({ broken: true, timeout: true });
    }, timeoutMs);
    res.on('data', onData);
    res.once('end', onEnd);
    res.once('error', onBroken);
    res.once('close', onBroken);
  });
}

// Sends status, headers and body to the client. Held chunks go first, the rest of the
// provider response is streamed with backpressure. A provider failure after the headers
// destroys the client connection instead of truncating the answer.
function forward(res, upstreamRes, heldChunks, complete) {
  return new Promise((done) => {
    res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, filterResponseHeaders(upstreamRes.rawHeaders));
    res.flushHeaders();
    for (const chunk of heldChunks) res.write(chunk);
    if (complete) {
      res.end(() => done());
      return;
    }
    pipeline(upstreamRes, res, () => done());
  });
}

function startServer(opts, key, clientToken, onReady) {
  const { stateDir } = opts;
  const secrets = [key, clientToken];
  const logger = createLogger(stateDir, opts.logMaxBytes, secrets);
  const gate = createGate(opts.maxConcurrency);
  const counters = { total_requests: 0, retry_attempts: 0, retry_successes: 0, rate_limit_429: 0 };
  const startedAt = new Date();
  let port = 0;
  let inflight = 0;
  let stopping = false;
  let idleTimer = null;
  let idleWaiter = null;

  const snapshot = () => ({
    ts: new Date().toISOString(),
    started_at: startedAt.toISOString(),
    limit: opts.maxConcurrency,
    total_requests: counters.total_requests,
    active: gate.active,
    retry_attempts: counters.retry_attempts,
    retry_successes: counters.retry_successes,
    rate_limit_429: counters.rate_limit_429,
  });
  const writeCounters = () => {
    try {
      writeAtomic(join(stateDir, 'counters.json'), `${JSON.stringify(snapshot())}\n`);
    } catch (error) {
      logger.line(`counters write failed: ${error.code ?? 'error'}`);
    }
  };
  const healthDocument = () => ({
    status: 'ok',
    port,
    upstream: opts.upstream.target,
    limit: opts.maxConcurrency,
    active: gate.active,
    queued: gate.queued,
    total_requests: counters.total_requests,
    uptime_sec: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    retry_attempts: counters.retry_attempts,
    retry_successes: counters.retry_successes,
    rate_limit_429: counters.rate_limit_429,
  });

  function clearIdle() {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  function armIdle() {
    if (!opts.idleTimeoutSeconds || stopping) return;
    clearIdle();
    idleTimer = setTimeout(() => {
      if (inflight === 0 && gate.queued === 0) void shutdown('idle');
      else armIdle();
    }, opts.idleTimeoutSeconds * 1000);
  }

  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  async function handle(req, res) {
    const started = Date.now();
    const requestPath = (req.url ?? '/').split('?')[0].replace(/[\u0000-\u001f]/g, '?');

    if (stopping) {
      sendJson(res, 503, errorBody('proxy is stopping'), { connection: 'close' });
      return;
    }
    if (opts.hostCheck && !allowedHosts().has(String(req.headers.host ?? '').toLowerCase())) {
      sendJson(res, 403, errorBody('host not allowed'));
      return;
    }
    if (req.method === 'GET' && requestPath === '/health') {
      sendJson(res, 200, healthDocument());
      return;
    }
    if (clientToken && !presentedTokens(req.headers).some((token) => sameToken(token, clientToken))) {
      sendJson(res, 401, errorBody('client token required'));
      return;
    }

    inflight++;
    clearIdle();
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    req.on('error', () => abort.abort());
    let release = null;
    let status = '-';
    let attempts = 0;
    let waitedMs = 0;
    try {
      try {
        release = await gate.acquire(abort.signal);
      } catch {
        return;
      }
      waitedMs = Date.now() - started;
      counters.total_requests++;

      const body = await readBody(req, opts.maxBufferedBodyBytes, abort.signal);
      if (body.aborted) return;
      if (body.tooLarge) {
        status = 413;
        sendJson(res, 413, errorBody('request body too large for replay'), { connection: 'close' });
        return;
      }

      const target = (() => {
        let raw = req.url ?? '/';
        if (!raw.startsWith('/')) {
          try {
            const parsed = new URL(raw);
            raw = parsed.pathname + parsed.search;
          } catch {
            raw = '/';
          }
        }
        return raw.replace(/^\/+/, '/');
      })();
      // Per-request context: the path and method must travel with this request alone, because a
      // retry resumes after a sleep while other requests run through the same handler.
      const ctx = { upstream: opts.upstream, opts, path: opts.upstream.basePath + target, method: req.method };
      const headers = buildUpstreamHeaders(req.headers, opts.upstream.url.host, key, body.body.length, req.method);

      let retries = 0;
      let wasRetried = false;
      for (;;) {
        attempts++;
        const result = await attemptOnce(ctx, headers, body.body, abort.signal);
        if (result.aborted) return;

        let held = null;
        let heldStatus = 0;
        let timedOut = false;
        if (result.res) {
          const upstreamRes = result.res;
          const code = upstreamRes.statusCode;
          if (code !== 429 && !(code >= 500 && code <= 599)) {
            status = code;
            if (wasRetried) counters.retry_successes++;
            await forward(res, upstreamRes, [], false);
            return;
          }
          heldStatus = code;
          const read = await readHeld(upstreamRes, opts.heldBodyCapBytes, opts.responseHeaderTimeoutMs);
          if (abort.signal.aborted) {
            upstreamRes.destroy();
            return;
          }
          if (read.broken) {
            upstreamRes.destroy();
            heldStatus = read.timeout ? 504 : 502;
            timedOut = Boolean(read.timeout);
          } else {
            held = { upstreamRes, ...read };
          }
        } else {
          heldStatus = result.failure === 'timeout' ? 504 : 502;
          timedOut = result.failure === 'timeout';
        }

        if (heldStatus === 429) counters.rate_limit_429++;
        const heldBuffer = held ? Buffer.concat(held.chunks) : Buffer.alloc(0);
        if (held) {
          const decoded = decodeBody(heldBuffer, held.upstreamRes.headers['content-encoding']);
          const preview = decoded === null ? '[undecodable body]' : Buffer.from(decoded, 'utf8').subarray(0, LOG_BODY_BYTES).toString('utf8');
          logger.line(`held status=${heldStatus} attempt=${attempts} body=${JSON.stringify(preview)}`);
        } else {
          logger.line(`held status=${heldStatus} attempt=${attempts} transport failure`);
        }

        const permanent = held && isPermanentFailure(heldBuffer, held.upstreamRes.headers['content-encoding'], opts.patterns);
        const exhausted = opts.retryMaxAttempts !== 0 && retries >= opts.retryMaxAttempts;
        if (permanent || exhausted) {
          status = heldStatus;
          if (held) await forward(res, held.upstreamRes, held.chunks, held.complete);
          else sendJson(res, heldStatus, errorBody(timedOut ? 'upstream timed out' : 'upstream unavailable'));
          return;
        }

        if (held) held.upstreamRes.destroy();
        counters.retry_attempts++;
        let delay = held ? retryAfterDelayMs(held.upstreamRes.headers['retry-after'], opts.retryAfterCapMs) : null;
        if (delay === null) {
          delay = backoffDelayMs(retries, opts.retryBaseDelayMs, opts.retryMaxDelayMs);
          if (opts.retryJitterMs > 0) delay += Math.floor(Math.random() * opts.retryJitterMs);
        }
        retries++;
        wasRetried = true;
        if (delay > 0 && !(await sleep(delay, abort.signal))) return;
        if (abort.signal.aborted) return;
      }
    } catch (error) {
      logger.line(`request error: ${error && error.code ? error.code : 'internal'}`);
      if (!res.headersSent) sendJson(res, 502, errorBody('internal proxy error'));
      else res.destroy();
    } finally {
      if (release) release();
      inflight--;
      logger.line(`${req.method} ${requestPath} wait=${waitedMs}ms total=${Date.now() - started}ms status=${status} attempts=${attempts}`);
      if (release) writeCounters();
      if (inflight === 0) {
        if (idleWaiter) idleWaiter();
        armIdle();
      }
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger.line(`handler failure: ${error && error.code ? error.code : 'internal'}`);
      if (!res.headersSent) sendJson(res, 502, errorBody('internal proxy error'));
      else res.destroy();
    });
  });
  // The proxy imposes no total time on a request or a response: queued clients and long
  // streams are limited by the clients themselves.
  server.requestTimeout = 0;

  async function shutdown(reason) {
    if (stopping) return;
    stopping = true;
    clearIdle();
    server.close();
    server.closeIdleConnections();
    if (inflight > 0) {
      await Promise.race([
        new Promise((done) => { idleWaiter = done; }),
        sleep(opts.stopGraceMs, new AbortController().signal),
      ]);
    }
    server.closeAllConnections();
    if (readInteger(join(stateDir, 'proxy.pid')) === process.pid) removeStateFiles(stateDir);
    writeCounters();
    logger.line(`shutdown (${reason}) pid=${process.pid}`);
    process.exit(0);
  }

  server.on('error', (error) => {
    process.stderr.write(`provider-proxy: cannot listen on 127.0.0.1:${opts.port}: ${error.code ?? 'error'}\n`);
    process.exit(EXIT.FAILURE);
  });
  server.listen(opts.port, '127.0.0.1', () => {
    port = server.address().port;
    try {
      writeAtomic(join(stateDir, 'proxy.port'), `${port}\n`);
      writeAtomic(join(stateDir, 'proxy.target'), `${opts.upstream.target}\n`);
      writeAtomic(join(stateDir, 'proxy.pid'), `${process.pid}\n`);
    } catch (error) {
      process.stderr.write(`provider-proxy: cannot write state files: ${error.code ?? 'error'}\n`);
      process.exit(EXIT.FAILURE);
    }
    writeCounters();
    logger.line(`started pid=${process.pid} address=127.0.0.1:${port} upstream=${opts.upstream.target} limit=${opts.maxConcurrency}`);
    armIdle();
    onReady(port);
  });

  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void shutdown(signal));
  // An unexpected error in one request must never terminate the server.
  process.on('uncaughtException', (error) => logger.line(`uncaught error: ${error && error.code ? error.code : 'internal'}`));
  process.on('unhandledRejection', (error) => logger.line(`unhandled rejection: ${error && error.code ? error.code : 'internal'}`));
  return server;
}

// Reads the whole request body into memory up to maxBytes; keeps draining (and discarding)
// an oversized body so the 413 answer can still be delivered.
function readBody(req, maxBytes, signal) {
  return new Promise((done) => {
    const chunks = [];
    let size = 0;
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      done(value);
    };
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        finish({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ body: Buffer.concat(chunks) }));
    req.on('error', () => finish({ aborted: true }));
    req.on('aborted', () => finish({ aborted: true }));
    signal.addEventListener('abort', () => finish({ aborted: true }), { once: true });
  });
}

function serve(opts, env) {
  const result = obtainKey(opts.keySources, env);
  if (result.error) {
    process.stderr.write(`provider-proxy: ${redactText(result.error)}\n`);
    return EXIT.MISSING;
  }
  let token = null;
  if (opts.clientTokenFile) {
    try {
      token = readFileSync(opts.clientTokenFile, 'utf8').trim();
    } catch {
      token = '';
    }
    if (!token) {
      process.stderr.write('provider-proxy: the client token file cannot be read or is empty\n');
      return EXIT.CONFIG;
    }
  }
  mkdirSync(opts.stateDir, { recursive: true, mode: 0o700 });
  startServer(opts, result.key, token, () => {});
  return null; // keeps running
}

// --- control commands -----------------------------------------------------------------------------

function pidGone(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    // A zombie still answers signal 0; its state letter is Z.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z';
  } catch {
    return false;
  }
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

function runningServer(dir) {
  const state = proxyState.readProxyState(dir);
  return proxyState.isLive(state) ? state : null;
}

async function stopServer(dir, state) {
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch { /* gone already */ }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline && !pidGone(state.pid)) await pause(STOP_POLL_MS);
  if (!pidGone(state.pid)) {
    try {
      process.kill(state.pid, 'SIGKILL');
    } catch { /* gone already */ }
    const killDeadline = Date.now() + STOP_WAIT_MS;
    while (Date.now() < killDeadline && !pidGone(state.pid)) await pause(STOP_POLL_MS);
  }
  removeStateFiles(dir);
}

function lockOwnerAlive(lock) {
  const owner = readInteger(join(lock, 'pid'));
  if (Number.isInteger(owner) && owner >= 2) {
    try {
      process.kill(owner, 0);
      return true;
    } catch (error) {
      return Boolean(error && error.code === 'EPERM');
    }
  }
  try {
    return Date.now() - statSync(lock).mtimeMs < 2000; // the owner has not written its pid yet
  } catch {
    return false;
  }
}

async function acquireStartLock(dir) {
  const lock = join(dir, 'start.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
      return lock;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (!lockOwnerAlive(lock)) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) return null;
    await pause(50);
  }
}

function ensureClientToken(opts) {
  const file = join(opts.stateDir, 'client-token');
  if (opts.clientToken === 'none') {
    rmSync(file, { force: true });
    return null;
  }
  if (opts.clientToken === 'auto') {
    let existing = '';
    try {
      existing = readFileSync(file, 'utf8').trim();
    } catch { /* none yet */ }
    if (!existing) writeAtomic(file, `${randomBytes(32).toString('hex')}\n`);
    return file;
  }
  let existing = '';
  try {
    existing = readFileSync(file, 'utf8').trim();
  } catch { /* none yet */ }
  if (existing !== opts.clientToken) writeAtomic(file, `${opts.clientToken}\n`);
  return file;
}

function serverArguments(opts, tokenFile) {
  const args = ['_serve', '--upstream', opts.upstream.target, '--state-dir', opts.stateDir];
  for (const [name, [flag]] of Object.entries(INT_OPTIONS)) args.push(flag, String(opts[name]));
  if (opts.keySources.command) args.push('--api-key-command', opts.keySources.command);
  if (opts.keySources.file) args.push('--api-key-file', opts.keySources.file);
  if (opts.keySources.env) args.push('--api-key-env', opts.keySources.env);
  for (const pattern of opts.patternSources) args.push('--non-retryable-pattern', pattern);
  if (!opts.hostCheck) args.push('--no-host-check');
  if (tokenFile) args.push('--client-token-file', tokenFile);
  return args;
}

async function waitReady(dir, child, exited) {
  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    if (exited.value) return { exited: exited.value };
    const state = proxyState.readProxyState(dir);
    if (state && state.pid === child.pid) {
      const health = await proxyState.probeHealth(state.port, HEALTH_TIMEOUT_MS);
      if (health) return { state, health };
    }
    await pause(START_POLL_MS);
  }
  return { timeout: true };
}

const normalizeTarget = (text) => String(text ?? '').trim().replace(/\/+$/, '');

async function commandStart(opts, env) {
  const keyResult = obtainKey(opts.keySources, env);
  if (keyResult.error) {
    process.stderr.write(`provider-proxy: ${redactText(keyResult.error)}\n`);
    return EXIT.MISSING;
  }
  const dir = opts.stateDir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const alreadyRunning = async (state) => {
    if (normalizeTarget(state.target) !== opts.upstream.target) {
      await stopServer(dir, state);
      return false;
    }
    const health = await proxyState.probeHealth(state.port, HEALTH_TIMEOUT_MS);
    const limit = health ? health.limit : '?';
    const note = health && limit !== opts.maxConcurrency ? '; changing the limit requires stop and start' : '';
    process.stdout.write(`already running pid=${state.pid} port=${state.port} limit=${limit}${note}\n`);
    return true;
  };

  let state = runningServer(dir);
  if (state && (await alreadyRunning(state))) return EXIT.OK;

  const lock = await acquireStartLock(dir);
  if (!lock) {
    process.stderr.write('provider-proxy: start in progress, try again shortly\n');
    return EXIT.MISSING;
  }
  try {
    // Another starter may have finished while this one waited for the lock.
    state = runningServer(dir);
    if (state && (await alreadyRunning(state))) return EXIT.OK;
    removeStateFiles(dir); // stale files of a killed server

    const tokenFile = ensureClientToken(opts);
    const outFd = openSync(join(dir, 'server.out'), 'a', 0o600);
    const child = spawn(process.execPath, [SELF, ...serverArguments(opts, tokenFile)], {
      detached: true, stdio: ['ignore', outFd, outFd], env,
    });
    closeSync(outFd);
    const exited = { value: null };
    child.once('exit', (code, signal) => { exited.value = { code, signal }; });
    child.once('error', (error) => { exited.value = { code: null, signal: null, error: error.code ?? 'error' }; });
    const ready = await waitReady(dir, child, exited);
    if (ready.state) {
      child.unref();
      process.stdout.write(`started pid=${ready.state.pid} port=${ready.state.port} limit=${ready.health.limit}\n`);
      return EXIT.OK;
    }
    const why = ready.exited ? `the server exited (code ${ready.exited.code ?? ready.exited.signal ?? 'unknown'}) before it was ready` : 'the server was not ready in time';
    if (ready.timeout) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch { /* gone already */ }
    }
    process.stderr.write(`provider-proxy: ${why}; see ${join(dir, 'server.out')} and ${join(dir, 'proxy.log')}\n`);
    return EXIT.FAILURE;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

async function commandStop(dir) {
  const state = runningServer(dir);
  if (!state) {
    removeStateFiles(dir);
    const lock = join(dir, 'start.lock');
    if (existsSync(lock) && !lockOwnerAlive(lock)) rmSync(lock, { recursive: true, force: true });
    process.stdout.write('not running\n');
    return EXIT.OK;
  }
  await stopServer(dir, state);
  process.stdout.write(`stopped pid=${state.pid} counters=${join(dir, 'counters.json')}\n`);
  return EXIT.OK;
}

async function commandStatus(dir, json) {
  const state = runningServer(dir);
  const health = state ? await proxyState.probeHealth(state.port, HEALTH_TIMEOUT_MS) : null;
  const counters = health ?? readCounters(dir);
  if (json) {
    process.stdout.write(`${JSON.stringify({
      running: Boolean(state),
      pid: state ? state.pid : null,
      port: state ? state.port : null,
      upstream: state ? state.target : null,
      counters,
    })}\n`);
  } else if (state) {
    process.stdout.write(`running pid=${state.pid} port=${state.port} limit=${counters ? counters.limit : '?'} active=${health ? health.active : '?'}\n`);
  } else {
    process.stdout.write('not running\n');
  }
  return state ? EXIT.OK : EXIT.FAILURE;
}

async function main(argv, env) {
  let parsed;
  try {
    if (!['start', 'stop', 'status', '_serve'].includes(argv[0])) {
      throw new OptionError('usage: provider-proxy.mjs start|stop|status [--json] [options]');
    }
    parsed = parseArgs(argv);
    if (parsed.command === 'stop' || parsed.command === 'status') {
      const profile = loadProfileOption(parsed, env);
      const dir = resolveStateDir(parsed, env, profile);
      return parsed.command === 'stop' ? await commandStop(dir) : await commandStatus(dir, Boolean(parsed.flags.json));
    }
    const opts = resolveOptions(parsed, env);
    if (parsed.command === 'start') return await commandStart(opts, env);
    return serve(opts, env);
  } catch (error) {
    if (error instanceof OptionError) {
      process.stderr.write(`provider-proxy: ${redactText(error.message)}\n`);
      return EXIT.CONFIG;
    }
    throw error;
  }
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(SELF);
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2), process.env).then((code) => {
    if (code !== null && code !== undefined) process.exitCode = code;
  });
}
