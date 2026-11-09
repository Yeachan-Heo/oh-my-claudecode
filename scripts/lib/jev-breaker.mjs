/* global process */
/**
 * Shared circuit breaker and per-minute request limit for Jev (opt-in).
 *
 * Hook scripts are one-shot processes, so the in-process circuit breaker and
 * request cap of the TS resolver start from zero on every hook call. This
 * module keeps both in files that every process of the machine shares, under
 * ~/.omc/state/jev/breaker/<scope>/ (OMC_JEV_BREAKER_DIR replaces the parent
 * directory, for tests). <scope> is a hash of the endpoint and the API key, so
 * another endpoint or a new key starts with a closed breaker; the key itself
 * is never written.
 *
 *   breaker.json            {until, reason, since} in epoch ms: the open breaker
 *   rpm-<YYYYMMDDHHmm>      one line "<token> <threshold>" per reservation in
 *                           that UTC minute (see foldMinute)
 *   noresp-<YYYYMMDDHHmm>   one line (epoch ms) per request that got no HTTP
 *                           response in that UTC minute
 *   notices/<id>-<n>        claim files: one outage notice per session and outage
 *
 * Files are only appended to or replaced whole, never rewritten in place, so
 * no lock is needed. OMC_JEV_BREAKER=1 turns the breaker on, OMC_JEV_MAX_RPM=<n>
 * the limit. When neither is set, breakerSettings() returns undefined and
 * callers use nothing else here. Every function is fail-open: a file system
 * error never blocks a request and never throws.
 *
 * Failures are classified by HTTP status and by whether a response arrived at
 * all, never by the response body, so any System One compatible endpoint
 * behaves the same. Imported by scripts/jev-resolve.mjs, scripts/lib/jev-shadow.mjs
 * and src/hooks/jev/resolver.ts (types in jev-breaker.d.mts).
 */

import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.mjs";

/** Seconds a breaker stays open when the response gives no usable Retry-After. */
export const BREAKER_SECONDS = {
  /** 429 and 5xx: the endpoint is overloaded or failing; a minute is usually enough. */
  transient: 60,
  /** 401, 402, 403: the key or the account needs a person to act. */
  account: 600,
  /** Three requests without any HTTP response within NO_RESPONSE_WINDOW_MS. */
  noResponse: 60,
};
/** A Retry-After above this is capped, so a wrong header cannot stop Jev for hours. */
export const BREAKER_MAX_SECONDS = 1800;
const NO_RESPONSE_TO_OPEN = 3;
const NO_RESPONSE_WINDOW_MS = 60_000;
/** A breaker that opens again within this time after it expired is the same outage (one notice). */
const SAME_OUTAGE_GAP_MS = 15 * 60_000;
/** An open breaker is rewritten only when the new end is this much later, so a burst of failures does not rewrite it on every response. */
const EXTEND_MIN_MS = 5000;
/** An `until` beyond the cap plus this, or a `since` in the future, means a corrupt file or a clock set back: ignored. */
const CLOCK_SLACK_MS = 60_000;
/** Per-minute files older than this are removed when a new minute file starts. */
const MINUTE_FILES_KEPT_MS = 10 * 60_000;

/**
 * Priority of each judgment point under OMC_JEV_MAX_RPM. Gate and routing
 * decisions are high, prompt classification medium, advisory detectors low.
 * A point missing here is medium. Mirror of the point registry
 * (src/hooks/jev/points.ts); the test suite checks that every registered
 * point has an entry.
 */
export const POINT_PRIORITY = {
  "model-routing": "high",
  "loop-continuation": "high",
  "ralph-verdict": "high",
  intent: "medium",
  "skill-trigger": "medium",
  "task-size": "medium",
  "slop-warning": "low",
  "learner-extraction": "low",
  "simplifier-trigger": "low",
  "context-pruning": "low",
};
/**
 * Share of the minute's limit a priority may use: low points stop at 60 % and
 * medium at 85 %, so the last 40 % of the minute stays for medium and high
 * points and the last 15 % for high ones only.
 */
export const PRIORITY_SHARE = { high: 1, medium: 0.85, low: 0.6 };

export function pointPriority(point) {
  return Object.hasOwn(POINT_PRIORITY, point) ? POINT_PRIORITY[point] : "medium";
}

/**
 * Requests per minute a point may still start when `limit` is the machine's
 * limit. Every priority keeps at least one request, so for a limit of 3 or
 * less the tiers overlap (1: 1/1/1, 2: 1/2/2, 3: 2/3/3; from 4 they differ).
 */
export function thresholdFor(limit, point) {
  const share = PRIORITY_SHARE[pointPriority(point)];
  return share === 1 ? limit : Math.max(1, Math.round(limit * share));
}

/** OMC_JEV_MAX_RPM as a positive integer, else undefined (no limit). */
export function parseMaxRpm(raw) {
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw.trim())) return undefined;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * The breaker and limit settings for one endpoint and key, or undefined when
 * neither OMC_JEV_BREAKER=1 nor OMC_JEV_MAX_RPM is set.
 * Returns {breaker: boolean, maxRpm: number | undefined, dir}.
 */
export function breakerSettings(env, endpoint, apiKey) {
  const breaker = String(env?.OMC_JEV_BREAKER ?? "").trim() === "1";
  const maxRpm = parseMaxRpm(env?.OMC_JEV_MAX_RPM);
  if (!breaker && maxRpm === undefined) return undefined;
  let base = env?.OMC_JEV_BREAKER_DIR;
  if (!base) {
    try {
      base = join(homedir(), ".omc", "state", "jev", "breaker");
    } catch {
      return undefined;
    }
  }
  const scope = createHash("sha256").update(String(endpoint ?? "") + "\n" + String(apiKey ?? "")).digest("hex").slice(0, 16);
  return { breaker, maxRpm, dir: join(base, scope) };
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // No synchronous wait available: the next attempt follows at once.
  }
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Replace a file so readers see the old or the new content, never a partial
 * one. On Windows a rename over a file another process is reading can fail
 * with EPERM, so the write is retried for about 30 ms.
 */
function replaceFile(path, text) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      atomicWriteFileSync(path, text);
      return true;
    } catch {
      sleepSync(3);
    }
  }
  return false;
}

/** UTC minute key YYYYMMDDHHmm. */
export function minuteKey(now = Date.now()) {
  return new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 12);
}

/** Append one line to the per-minute file `<prefix>-<minute>`; a new minute removes that prefix's files older than ten minutes. */
function appendToMinute(settings, prefix, line, now) {
  ensureDir(settings.dir);
  const path = join(settings.dir, prefix + "-" + minuteKey(now));
  if (!existsSync(path)) {
    try {
      const oldest = prefix + "-" + minuteKey(now - MINUTE_FILES_KEPT_MS);
      const pattern = new RegExp("^" + prefix + "-\\d{12}$");
      for (const name of readdirSync(settings.dir)) {
        if (pattern.test(name) && name < oldest) rmSync(join(settings.dir, name), { force: true });
      }
    } catch {
      // Best effort.
    }
  }
  appendFileSync(path, line + "\n", { encoding: "utf8", mode: 0o600 });
  return path;
}

// --- breaker ---------------------------------------------------------------

/** breaker.json as written, whatever its times; undefined when missing or unreadable. */
function readBreakerFile(settings) {
  const path = join(settings.dir, "breaker.json");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const state = JSON.parse(readFileSync(path, "utf8"));
      return state && typeof state === "object" ? state : undefined;
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      // EPERM or EBUSY while a rename lands: try again shortly.
      if (attempt < 3) sleepSync(3);
    }
  }
  return undefined;
}

/**
 * The open breaker {until, reason, since} (epoch ms), or undefined when it is
 * closed, expired, unreadable, corrupt, or OMC_JEV_BREAKER is not set.
 */
export function readBreaker(settings, now = Date.now()) {
  if (!settings?.breaker) return undefined;
  try {
    const state = readBreakerFile(settings);
    if (!state || !Number.isFinite(state.until) || state.until <= now) return undefined;
    if (state.until > now + BREAKER_MAX_SECONDS * 1000 + CLOCK_SLACK_MS) return undefined;
    const since = Number.isFinite(state.since) ? state.since : now;
    if (since < 0 || since > now + CLOCK_SLACK_MS) return undefined;
    return { until: state.until, reason: String(state.reason ?? ""), since: Math.min(since, now) };
  } catch {
    return undefined;
  }
}

/**
 * Open the breaker for `seconds`, or keep it open at least that long. An open
 * breaker is never shortened: when a concurrent opener replaced the file with
 * an earlier end, the later end is written back. `since` stays the start of
 * the outage while the breaker is extended or opens again within 15 minutes of
 * expiring. Returns the state in the file afterwards (so concurrent openers
 * agree on `since`), or undefined when it cannot be written.
 */
function openBreaker(settings, seconds, reason, now) {
  try {
    ensureDir(settings.dir);
    const until = now + Math.max(1, Math.min(seconds, BREAKER_MAX_SECONDS)) * 1000;
    let since = now;
    const previous = readBreakerFile(settings);
    if (
      previous &&
      Number.isFinite(previous.until) &&
      Number.isFinite(previous.since) &&
      previous.since >= 0 &&
      previous.since <= now &&
      now - previous.until < SAME_OUTAGE_GAP_MS
    ) {
      since = previous.since;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = readBreaker(settings, now);
      if (current && current.until >= until - EXTEND_MIN_MS) return current;
      const state = { until, reason, since: current ? Math.min(current.since, since) : since };
      if (!replaceFile(join(settings.dir, "breaker.json"), JSON.stringify(state))) return undefined;
    }
    return readBreaker(settings, now);
  } catch {
    return undefined;
  }
}

/**
 * Retry-After in whole seconds, at least 1: delta-seconds (a decimal value is
 * rounded up) or an HTTP date (IMF-fixdate, RFC 850 or asctime form).
 * Undefined when absent or in any other form.
 */
export function retryAfterSeconds(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(1, Math.ceil(Number(text)));
  const httpDate =
    /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text) ||
    /^[A-Za-z]{6,9}, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT$/.test(text) ||
    /^[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/.test(text);
  if (!httpDate) return undefined;
  const date = Date.parse(/GMT$/.test(text) ? text : text + " GMT");
  if (!Number.isFinite(date)) return undefined;
  return Math.max(1, Math.ceil((date - now) / 1000));
}

/**
 * Class of a failed request: {reason, opens, seconds?}, or undefined when the
 * failure says nothing about the endpoint (another 4xx, an invalid 2xx body).
 * failure: {status?, retryAfter?, noResponse?}. 429, 401, 402, 403 and 5xx
 * open the breaker at once; a request without any HTTP response counts towards
 * NO_RESPONSE_TO_OPEN.
 */
export function classifyFailure(failure, now = Date.now()) {
  const status = Number.isInteger(failure?.status) ? failure.status : undefined;
  if (status === undefined) return failure?.noResponse ? { reason: "no-response", opens: false } : undefined;
  let seconds;
  if (status === 429 || (status >= 500 && status <= 599)) seconds = BREAKER_SECONDS.transient;
  else if (status === 401 || status === 402 || status === 403) seconds = BREAKER_SECONDS.account;
  else return undefined;
  const retry = retryAfterSeconds(failure.retryAfter, now);
  return { reason: "http-" + status, opens: true, seconds: Math.min(retry ?? seconds, BREAKER_MAX_SECONDS) };
}

/** Requests without a response within the window, this one included. */
function noteNoResponse(settings, now) {
  try {
    appendToMinute(settings, "noresp", String(now), now);
    let count = 0;
    for (const key of [minuteKey(now), minuteKey(now - 60_000)]) {
      let text = "";
      try {
        text = readFileSync(join(settings.dir, "noresp-" + key), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        const time = Number(line);
        if (line && Number.isFinite(time) && time > now - NO_RESPONSE_WINDOW_MS && time <= now) count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Record a failed request (a classifyFailure result). Returns the breaker as
 * it is after this failure when it is open (opened or extended now, or open
 * already), else undefined. Does nothing without OMC_JEV_BREAKER=1.
 */
export function recordFailure(settings, failure, now = Date.now()) {
  if (!settings?.breaker || !failure) return undefined;
  if (failure.opens) return openBreaker(settings, failure.seconds, failure.reason, now);
  if (failure.reason === "no-response" && noteNoResponse(settings, now) >= NO_RESPONSE_TO_OPEN) {
    return openBreaker(settings, BREAKER_SECONDS.noResponse, "no-response", now);
  }
  return undefined;
}

// --- request limit ---------------------------------------------------------

/**
 * Fold a minute file: a line "<token> <threshold>" is granted when fewer than
 * <threshold> lines were granted before it. The verdict on a line depends only
 * on the lines before it, so every process reaches the same verdict however
 * the appends interleave, and a refused line takes no slot. With `token` the
 * fold stops at that line. Returns {granted, ok} (ok undefined when the token
 * is absent or not given).
 */
function foldMinute(path, token) {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Nothing reserved in this minute yet.
  }
  let granted = 0;
  for (const line of text.split("\n")) {
    const [lineToken, thresholdText] = line.split(" ");
    if (!lineToken || thresholdText === undefined) continue;
    const ok = granted < Number(thresholdText);
    if (ok) granted += 1;
    if (token !== undefined && lineToken === token) return { granted, ok };
  }
  return { granted, ok: undefined };
}

/**
 * Reserve one request in the current UTC minute. A request is refused without
 * writing anything when the minute already reached the point's threshold;
 * otherwise its line is appended and the file folded again. Returns
 * {ok, priority?, count?, threshold?, limit?}; ok is true without a limit and
 * whenever the files cannot be used.
 */
export function reserveRequest(settings, point, now = Date.now()) {
  const limit = settings?.maxRpm;
  if (limit === undefined) return { ok: true };
  const threshold = thresholdFor(limit, point);
  const priority = pointPriority(point);
  try {
    const before = foldMinute(join(settings.dir, "rpm-" + minuteKey(now)));
    if (before.granted >= threshold) return { ok: false, priority, count: before.granted, threshold, limit };
    const token = process.pid.toString(36) + Math.random().toString(36).slice(2, 10);
    const path = appendToMinute(settings, "rpm", token + " " + threshold, now);
    const { granted, ok } = foldMinute(path, token);
    if (ok === undefined) return { ok: true };
    return { ok, priority, count: granted, threshold, limit };
  } catch {
    return { ok: true };
  }
}

/**
 * Admission of one request, called right before the HTTP call: the open
 * breaker first, then the limit. Returns {skip} when the request must not go
 * out: {mode: "circuit-open", breaker} or {mode: "cap", priority, count,
 * threshold, limit}; {} otherwise.
 */
export function admitRequest(settings, point, now = Date.now()) {
  const open = readBreaker(settings, now);
  if (open) return { skip: { mode: "circuit-open", breaker: open } };
  const slot = reserveRequest(settings, point, now);
  if (!slot.ok) {
    return { skip: { mode: "cap", priority: slot.priority, count: slot.count, threshold: slot.threshold, limit: slot.limit } };
  }
  return {};
}

/** Extra shadow-log fields of a request admitRequest held back. */
export function skipLogFields(skip) {
  if (skip.mode === "circuit-open") {
    return { reason: skip.breaker.reason, until: new Date(skip.breaker.until).toISOString() };
  }
  return { reason: "rpm", priority: skip.priority, rpm: { count: skip.count, threshold: skip.threshold, limit: skip.limit } };
}

// --- one notice per session and outage -------------------------------------

/** Local HH:MM of the first full minute at or after `ms`, so the notice never names a time before the breaker closes. */
function clockTime(ms) {
  const date = new Date(Math.ceil(ms / 60_000) * 60_000);
  return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
}

function describeReason(reason) {
  if (reason === "no-response") return "no response from the Jev endpoint";
  const match = /^http-(\d{3})$/.exec(reason);
  return match ? "HTTP " + match[1] : reason;
}

/** Text of the outage notice, in the machine's local time. */
export function outageMessage(breaker) {
  return "[OMC] Jev requests paused until " + clockTime(breaker.until) + " (" + describeReason(breaker.reason) +
    "); hooks decide without Jev until then.";
}

/**
 * Claim the notice for this session and outage: the first process to create
 * the claim file wins. Without a session id the claim is per outage for the
 * whole machine. Returns the notice text, or undefined when another process
 * already showed it or the claim cannot be made.
 */
export function claimOutageNotice(settings, sessionId, breaker, now = Date.now()) {
  if (!settings?.breaker || !breaker) return undefined;
  try {
    const dir = join(settings.dir, "notices");
    ensureDir(dir);
    const id = String(sessionId || "any").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
    try {
      closeSync(openSync(join(dir, id + "-" + Math.floor(breaker.since / 60_000)), "wx", 0o600));
    } catch {
      return undefined;
    }
    try {
      for (const name of readdirSync(dir)) {
        if (now - statSync(join(dir, name)).mtimeMs > 7 * 24 * 3_600_000) rmSync(join(dir, name), { force: true });
      }
    } catch {
      // Best effort: old claims are removed on the way.
    }
    return outageMessage(breaker);
  } catch {
    return undefined;
  }
}
