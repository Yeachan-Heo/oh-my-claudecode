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
 *   breaker.json.lock       {token, ts}: held while breaker.json is read, compared
 *                           and replaced (see takeLock)
 *
 * Files are only appended to or replaced whole, never rewritten in place.
 * breaker.json is replaced under breaker.json.lock, so of two openers in
 * script processes the one that writes second has read the first one's end
 * (the compaction module takes the lock without an exclusive create; see the
 * lock section). OMC_JEV_BREAKER=1 turns the breaker on, OMC_JEV_MAX_RPM=<n>
 * the limit. When neither is set, breakerSettings() returns undefined and
 * callers use nothing else here. Every function is fail-open: a file system
 * error never blocks a request and never throws.
 *
 * Failures are classified by HTTP status and by whether a response arrived at
 * all, never by the response body, so any System One compatible endpoint
 * behaves the same. The one use of a body is the retry time of a 429 that has
 * no usable Retry-After header (retryAfterFromBody).
 *
 * Imported by scripts/jev-resolve.mjs, scripts/lib/jev-shadow.mjs
 * and src/hooks/jev/resolver.ts (types in jev-breaker.d.mts). hooks/jev-compaction.mjs, a hooks
 * module that cannot import Node, mirrors the file formats and rules through the host's $.fs and
 * writes the same files.
 */

import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
/** Concurrent processes read their clock a few milliseconds apart; a recorded no-response time further ahead of this clock than this is a corrupt line or a clock set back. */
const NO_RESPONSE_SKEW_MS = 5000;
/** A breaker that opens again within this time after it expired is the same outage (one notice). */
const SAME_OUTAGE_GAP_MS = 15 * 60_000;
/**
 * Openers that start one outage at the same moment may record `since` a few milliseconds apart, so the
 * notice claim is keyed by a five-minute bucket of it, not by the minute (a new outage starts at least
 * 15 minutes after the previous one ended).
 */
const NOTICE_BUCKET_MS = 5 * 60_000;
/** An open breaker is rewritten only when the new end is this much later, so a burst of failures does not rewrite it on every response. */
const EXTEND_MIN_MS = 5000;
/**
 * Pause after writing the breaker before it is read back. A concurrent opener
 * that read the file before our write replaces it within a few milliseconds
 * (a rename retries for up to 30 ms on Windows), so after the pause the file
 * shows whether a shorter end overwrote ours and we write the longer end again.
 */
const SETTLE_MS = 50; // settings.settleMs replaces it in tests only
/** An `until` beyond the cap plus this, or a `since` in the future, means a corrupt file or a clock set back: ignored. */
const CLOCK_SLACK_MS = 60_000;
/** Per-minute files older than this are removed when a new minute file starts. */
const MINUTE_FILES_KEPT_MS = 10 * 60_000;
/**
 * breaker.json.lock: a lock (by its `ts`, else by its mtime) older than this, or
 * that far ahead of the clock, is of a process that died or hangs; and a
 * breaker.json that does not parse and was written less than this long ago is
 * a write in progress, not a corrupt file.
 */
const LOCK_STALE_MS = 1000;
/** Longest wait for the lock; after it nothing is written. */
const LOCK_WAIT_MS = 1500;
const LOCK_POLL_MS = 5;
/** A lock that cannot be created (EPERM with no lock there) or removed this many times in a row is unusable: give up at once. */
const LOCK_REFUSALS_TO_GIVE_UP = 3;
/** OMC_JEV_HOOK_DEADLINE is the moment the hook kills the resolver less this (jev-shadow.mjs). */
const HOOK_KILL_AFTER_DEADLINE_MS = 100;
/** Under a hook deadline the wait for the lock ends this long before the kill, so the lock is not held when the process is killed. */
const LOCK_KILL_MARGIN_MS = 40;

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
  // Resolved by hooks/jev-compaction.mjs, which mirrors this file's rules (a hooks module cannot import Node).
  compaction: "medium",
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
 * Returns {breaker: boolean, maxRpm: number | undefined, dir, hookDeadline?}:
 * hookDeadline is OMC_JEV_HOOK_DEADLINE (epoch ms) of a resolver started by a hook.
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
  const hookDeadline = Number(env?.OMC_JEV_HOOK_DEADLINE);
  return { breaker, maxRpm, dir: join(base, scope), ...(Number.isFinite(hookDeadline) && hookDeadline > 0 ? { hookDeadline } : {}) };
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
 * Replace <dir>/<name> so readers see the old or the new content, never a
 * partial one: a temp file .<name>.tmp.<id> is written and synced, then
 * renamed over it. `stillOurs()` is checked right before every rename, so a
 * writer that lost the lock while it wrote the temp file writes nothing.
 * On Windows a rename over a file another process is reading can fail with
 * EPERM, so the rename is retried for about 30 ms. Returns true (written),
 * false (the write failed) or "lost" (stillOurs() said no).
 */
function replaceFileIf(dir, name, text, stillOurs) {
  const temp = join(dir, "." + name + ".tmp." + process.pid.toString(36) + "-" + Math.random().toString(36).slice(2, 10));
  const removeTemp = () => {
    try {
      rmSync(temp, { force: true });
    } catch {
      // removeStaleTemp sweeps it.
    }
  };
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    removeTemp();
    return false;
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!stillOurs()) {
      removeTemp();
      return "lost";
    }
    try {
      renameSync(temp, join(dir, name));
      return true;
    } catch {
      sleepSync(3);
    }
  }
  removeTemp();
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

/**
 * breaker.json as read, in up to 4 attempts 3 ms apart:
 * - {state}: the file as written, whatever its times (undefined when missing or not an object);
 * - {unreadable: true}: a read error other than ENOENT in any attempt (EPERM or EBUSY while a rename
 *   lands on Windows, EACCES), or a text that does not parse in a file written less than LOCK_STALE_MS
 *   ago (a write in progress). Readers treat it as closed (fail-open), but an opener must not write
 *   over it: it may hold a longer breaker;
 * - {state: undefined, corrupt: true}: no attempt parsed and the file is older: it holds no breaker
 *   and is replaced.
 */
function readBreakerState(settings) {
  const path = join(settings.dir, "breaker.json");
  let failed = false;
  let fresh = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) sleepSync(3);
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { state: undefined };
      failed = true;
      continue;
    }
    try {
      const state = JSON.parse(text);
      return { state: state && typeof state === "object" ? state : undefined };
    } catch {
      try {
        fresh = Math.abs(Date.now() - statSync(path).mtimeMs) <= LOCK_STALE_MS;
      } catch (error) {
        if (error?.code === "ENOENT") return { state: undefined };
        fresh = true;
      }
    }
  }
  return failed || fresh ? { unreadable: true } : { state: undefined, corrupt: true };
}

/**
 * The open breaker {until, reason, since} (epoch ms), or undefined when it is
 * closed, expired, unreadable, corrupt, or OMC_JEV_BREAKER is not set.
 */
export function readBreaker(settings, now = Date.now()) {
  if (!settings?.breaker) return undefined;
  try {
    return breakerOf(readBreakerState(settings).state, now);
  } catch {
    return undefined;
  }
}

/** The open breaker that a breaker.json state holds at `now`, by the rules of readBreaker. */
function breakerOf(state, now) {
  if (!state || !Number.isFinite(state.until) || state.until <= now) return undefined;
  if (state.until > now + BREAKER_MAX_SECONDS * 1000 + CLOCK_SLACK_MS) return undefined;
  const since = Number.isFinite(state.since) ? state.since : now;
  if (since < 0 || since > now + CLOCK_SLACK_MS) return undefined;
  return { until: state.until, reason: String(state.reason ?? ""), since: Math.min(since, now) };
}

/**
 * Temp files of a write that a killed process left behind (.breaker.json.tmp.<id>), and lock
 * tombstones of a removal it did not finish (breaker.json.lock.<tag>.removed), are removed after five
 * minutes.
 */
function removeStaleTemp(dir, now) {
  try {
    for (const name of readdirSync(dir)) {
      const leftover = name.startsWith(".breaker.json.tmp.") || /^breaker\.json\.lock\..+\.removed$/.test(name);
      if (leftover && now - statSync(join(dir, name)).mtimeMs > 5 * 60_000) {
        rmSync(join(dir, name), { force: true });
      }
    }
  } catch {
    // Best effort.
  }
}

// --- lock of breaker.json -------------------------------------------------
// breaker.json.lock {token, ts} is created with O_EXCL ("wx"), so of the processes that open the
// breaker at once one holds it while it reads, compares and writes, and removes it afterwards. A lock
// older than LOCK_STALE_MS (by its `ts`, else by its mtime while its text is not written yet or
// cannot be read) is of a process that died or hangs. The compaction module has no exclusive create
// and no remove in $.fs: it writes its token when the lock is free, reads it back after
// 20 ms, checks it again right before its write and marks the lock {released: true}
// afterwards (the next opener here removes that file). A free lock is removed only while it is still
// the very file that was judged (removeLockIf), and our own only while it holds our token, so a lock
// created in the meantime is never removed on an old judgement. Every writer checks its token right
// before it writes (here: before the rename of its temp file) and starts over without it.

/**
 * The lock as it is now: {missing}, {unknown} when it cannot even be stat'ed, else {free, text,
 * mtimeMs, size}. Free: released by the compaction module, or stale. A lock that cannot be read is
 * judged by its mtime (stat needs no right to read the file).
 */
function judgeLock(lockPath, now) {
  let stat;
  try {
    stat = statSync(lockPath);
  } catch (error) {
    return error?.code === "ENOENT" ? { missing: true } : { unknown: true };
  }
  let text;
  try {
    text = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true };
  }
  let lock;
  try {
    lock = text === undefined ? undefined : JSON.parse(text);
  } catch {
    lock = undefined;
  }
  const at = lock && Number.isFinite(lock.ts) ? lock.ts : stat.mtimeMs;
  return { free: Boolean(lock && lock.released === true) || Math.abs(now - at) > LOCK_STALE_MS, text, mtimeMs: stat.mtimeMs, size: stat.size };
}

/**
 * Remove the lock only while it is the file `isSame(tombstone)` expects: it is renamed to
 * breaker.json.lock.<tag>.removed first (a rename moves exactly one file), the tombstone is compared,
 * and when it is another lock (one created after the judgement) it is linked back unless a newer lock
 * already took its place. Returns "removed", "restored", "gone" (no lock) or "refused" (the rename
 * failed).
 */
function removeLockIf(lockPath, tag, isSame) {
  const tomb = lockPath + "." + tag + ".removed";
  try {
    renameSync(lockPath, tomb);
  } catch (error) {
    return error?.code === "ENOENT" ? "gone" : "refused";
  }
  let same = false;
  try {
    same = isSame(tomb);
  } catch {
    same = false;
  }
  if (!same) {
    try {
      linkSync(tomb, lockPath);
    } catch {
      // A newer lock took the place (EEXIST): the displaced holder finds a foreign token before it writes.
    }
  }
  try {
    rmSync(tomb, { force: true });
  } catch {
    // removeStaleTemp sweeps it.
  }
  return same ? "removed" : "restored";
}

/** Does the lock hold this token? Checked right before a write. */
function holdsLock(lockPath, token) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")).token === token;
  } catch {
    return false;
  }
}

/**
 * Take the lock: its token, or undefined when it stays taken until `deadline`, cannot be created
 * (EACCES, EROFS and the like) or cannot be removed when free (LOCK_REFUSALS_TO_GIVE_UP refusals in a
 * row: at once rather than at the deadline).
 */
function takeLock(lockPath, deadline) {
  const token = process.pid.toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  let refused = 0;
  // A removal or a vanished lock is followed by an immediate try, but not twice in a row.
  let quickBefore = false;
  for (;;) {
    let code;
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, JSON.stringify({ token, ts: Date.now() }), "utf8");
        closeSync(fd);
      } catch (error) {
        try {
          closeSync(fd);
        } catch {
          // Already closed.
        }
        // No empty lock is left behind when its text cannot be written.
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // It goes stale.
        }
        throw error;
      }
      return token;
    } catch (error) {
      code = error?.code;
    }
    // EPERM and EBUSY: Windows, a lock being removed.
    if (!["EEXIST", "EPERM", "EBUSY"].includes(code)) return undefined;
    if (Date.now() >= deadline) return undefined;
    const lock = judgeLock(lockPath, Date.now());
    let outcome = "taken";
    // EPERM or EBUSY with no lock there: a lock being deleted (it passes), or a directory that refuses new files.
    if (lock.missing) outcome = code === "EEXIST" ? "gone" : "refused";
    else if (lock.free) {
      outcome = removeLockIf(lockPath, token, (tomb) => {
        const now = statSync(tomb);
        return now.mtimeMs === lock.mtimeMs && now.size === lock.size && (lock.text === undefined || readFileSync(tomb, "utf8") === lock.text);
      });
    }
    if (outcome === "refused") {
      refused += 1;
      if (refused >= LOCK_REFUSALS_TO_GIVE_UP) return undefined;
    } else {
      refused = 0;
    }
    const quick = outcome === "removed" || outcome === "gone";
    if (!quick || quickBefore) sleepSync(LOCK_POLL_MS);
    quickBefore = quick;
  }
}

function releaseLock(lockPath, token) {
  removeLockIf(lockPath, token + "-own", (tomb) => JSON.parse(readFileSync(tomb, "utf8")).token === token);
}

/**
 * Open the breaker for `seconds`, or keep it open at least that long. An open breaker is never
 * shortened: the read, the comparison and the write happen under breaker.json.lock, so a concurrent
 * opener held up between its read and its write holds the others back instead of overwriting them. A
 * breaker.json that is there but cannot be read is not a closed breaker: nothing is written over it.
 * When the lock stays taken for LOCK_WAIT_MS nothing is written. After a write the opener still
 * pauses SETTLE_MS and reads the file again under the lock, writing the later end again when a writer
 * that does not take the lock (a compaction module loaded before it did) replaced it (at most 3
 * writes). In a resolver started by a hook (settings.hookDeadline) the wait for the lock and the pause
 * end LOCK_KILL_MARGIN_MS before the kill. `since` stays the start of the outage while the breaker is
 * extended or opens again within 15 minutes of expiring. Returns the state in the file afterwards (so
 * concurrent openers agree on `since`), or undefined when it cannot be written.
 */
function openBreaker(settings, seconds, reason, now) {
  try {
    ensureDir(settings.dir);
    const until = now + Math.max(1, Math.min(seconds, BREAKER_MAX_SECONDS)) * 1000;
    const path = join(settings.dir, "breaker.json");
    const lockPath = path + ".lock";
    const killAt = Number.isFinite(settings.hookDeadline) ? settings.hookDeadline + HOOK_KILL_AFTER_DEADLINE_MS - LOCK_KILL_MARGIN_MS : Infinity;
    const deadline = Math.min(Date.now() + LOCK_WAIT_MS, killAt);
    const settleMs = settings.settleMs ?? SETTLE_MS;
    let since = now;
    let read = false;
    let written;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (written) {
        // No pause and second round when the process is about to be killed (not when only the wait for the lock ran long).
        if (Date.now() + settleMs >= killAt) break;
        // After a write, let a writer without the lock land before the file is read back.
        sleepSync(settleMs);
      }
      const token = takeLock(lockPath, deadline);
      if (!token) break;
      try {
        const onDisk = readBreakerState(settings);
        if (onDisk.unreadable) break;
        if (!read) {
          read = true;
          const previous = onDisk.state;
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
        }
        const current = breakerOf(onDisk.state, now);
        if (current && current.until >= until - EXTEND_MIN_MS) return current;
        const state = { until, reason, since: current ? Math.min(current.since, since) : since };
        const replaced = replaceFileIf(settings.dir, "breaker.json", JSON.stringify(state), () => holdsLock(lockPath, token));
        // The lock was taken over meanwhile (stale, or a compaction module's token): read again.
        if (replaced === "lost") continue;
        if (!replaced) return undefined;
        written = state;
        removeStaleTemp(settings.dir, now);
      } finally {
        releaseLock(lockPath, token);
      }
    }
    return readBreaker(settings, now) ?? written;
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

/** Longest part of a 429 response body that is read for a retry time. */
export const RETRY_BODY_MAX_CHARS = 2000;

/**
 * Retry time in whole seconds (at least 1) that a 429 response body states in
 * words, for an endpoint that sends no usable Retry-After header: "retry after
 * 30 seconds", "Retry after ~178s", "retry_after: 12 s". Only the phrase
 * "retry after" followed by a number of seconds counts; any other text, and a
 * time in other units, gives undefined. Used only as a fallback behind the
 * header, with the same ceiling (BREAKER_MAX_SECONDS).
 */
export function retryAfterFromBody(text) {
  if (typeof text !== "string") return undefined;
  const match = /\bretry[\s_-]*after\b\s*[:=]?\s*~?\s*(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\b/i.exec(text.slice(0, RETRY_BODY_MAX_CHARS));
  return match ? Math.max(1, Math.ceil(Number(match[1]))) : undefined;
}

/**
 * Class of a failed request: {reason, opens, seconds?}, or undefined when the
 * failure says nothing about the endpoint (another 4xx, an invalid 2xx body).
 * failure: {status?, retryAfter?, body?, noResponse?}. 429, 401, 402, 403 and
 * 5xx open the breaker at once; a request without any HTTP response counts
 * towards NO_RESPONSE_TO_OPEN. `body` is the text of a 429 response and is
 * read only for a retry time when the Retry-After header gives none.
 */
export function classifyFailure(failure, now = Date.now()) {
  const status = Number.isInteger(failure?.status) ? failure.status : undefined;
  if (status === undefined) return failure?.noResponse ? { reason: "no-response", opens: false } : undefined;
  let seconds;
  if (status === 429 || (status >= 500 && status <= 599)) seconds = BREAKER_SECONDS.transient;
  else if (status === 401 || status === 402 || status === 403) seconds = BREAKER_SECONDS.account;
  else return undefined;
  const retry = retryAfterSeconds(failure.retryAfter, now) ?? (status === 429 ? retryAfterFromBody(failure.body) : undefined);
  return { reason: "http-" + status, opens: true, seconds: Math.min(retry ?? seconds, BREAKER_MAX_SECONDS) };
}

/**
 * Requests without a response within the window, this one included, and the
 * newest time recorded: {count, newest}. The window ends at the newest time,
 * not at this call's own clock: concurrent processes sample their clock before
 * they append, so a process may append a time that is older than lines already
 * in the file (or in the next minute's file). Counting back from the newest
 * time gives every process the same count once all lines are written, whatever
 * the order of the appends. A time more than NO_RESPONSE_SKEW_MS ahead of this
 * clock is a corrupt line or a clock set back and is ignored.
 */
function noteNoResponse(settings, now) {
  try {
    appendToMinute(settings, "noresp", String(now), now);
    const times = [];
    for (const key of [minuteKey(now - 60_000), minuteKey(now), minuteKey(now + 60_000)]) {
      let text = "";
      try {
        text = readFileSync(join(settings.dir, "noresp-" + key), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        const time = Number(line);
        if (line && Number.isFinite(time) && time <= now + NO_RESPONSE_SKEW_MS) times.push(time);
      }
    }
    const newest = times.reduce((latest, time) => Math.max(latest, time), now);
    return { count: times.filter((time) => time > newest - NO_RESPONSE_WINDOW_MS).length, newest };
  } catch {
    return { count: 0, newest: now };
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
  if (failure.reason === "no-response") {
    // The breaker closes a minute after the newest of the failures, not of this process's own clock.
    const { count, newest } = noteNoResponse(settings, now);
    if (count >= NO_RESPONSE_TO_OPEN) return openBreaker(settings, BREAKER_SECONDS.noResponse, "no-response", newest);
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
      closeSync(openSync(join(dir, id + "-" + Math.floor(breaker.since / NOTICE_BUCKET_MS)), "wx", 0o600));
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
