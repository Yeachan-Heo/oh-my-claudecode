/* global process, URL */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isJevLogContextEnabled,
  isJevStateOmitIdsEnabled,
  jevLogContextOf,
  parseJevEnv,
  resolveJevLogDir,
  resolveJevLogMaxBytes,
  resolveJevTimeoutMs,
  rotateJevLog,
} from "../jev-resolve.mjs";

const SWEEP_THROTTLE_MS = 60 * 60 * 1000; // 1 hour
const ACTIVE_RESOLVER_TIMEOUT_BUFFER_MS = 500;
// model-routing decides the model and effort of a subagent call, and a lost
// answer costs that choice, so its resolver gets 3 s more to start and finish
// before spawnSync kills it (a cold start under load can take a second or more).
const MODEL_ROUTING_RESOLVER_EXTRA_BUFFER_MS = 3000;

/**
 * Time the hook gives the resolver process beyond the request timeout
 * (OMC_JEV_TIMEOUT_MS) before it kills it.
 */
export function activeResolverBufferMs(point) {
  return (
    ACTIVE_RESOLVER_TIMEOUT_BUFFER_MS +
    (point === "model-routing" ? MODEL_ROUTING_RESOLVER_EXTRA_BUFFER_MS : 0)
  );
}

/**
 * Get the cross-process sweep throttle marker path.
 * Keep the marker below the user's private state directory, not shared tmp.
 */
function getSweepThrottleMarkerPath() {
  const home = homedir();
  const omcDir = join(home, ".omc");
  const stateDir = join(omcDir, "state");
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    for (const directory of [home, omcDir, stateDir]) {
      const stats = lstatSync(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return undefined;
      if (
        typeof process.getuid === "function" &&
        (stats.uid !== process.getuid() || (stats.mode & 0o022) !== 0)
      ) {
        return undefined;
      }
    }
    return join(stateDir, ".jev-sweep-throttle");
  } catch {
    return undefined;
  }
}

function isOwnedMarkerFile(stats) {
  return (
    stats.isFile() &&
    (typeof process.getuid !== "function" || stats.uid === process.getuid())
  );
}

/**
 * Check if sweep should run based on throttle marker mtime.
 */
function shouldRunSweep(markerPath) {
  if (!markerPath) return false;
  try {
    const stats = lstatSync(markerPath);
    return (
      isOwnedMarkerFile(stats) &&
      Date.now() - stats.mtimeMs >= SWEEP_THROTTLE_MS
    );
  } catch (error) {
    // Only a missing marker permits an initial sweep; inaccessible markers fail closed.
    return error?.code === "ENOENT";
  }
}

/**
 * Update sweep throttle marker mtime to now.
 */
function updateSweepMarker(markerPath) {
  if (!markerPath) return false;

  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(markerPath, constants.O_WRONLY | noFollow);
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }

  if (descriptor === undefined) {
    try {
      descriptor = openSync(
        markerPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
    } catch {
      return false;
    }
  }

  try {
    if (!isOwnedMarkerFile(fstatSync(descriptor))) return false;
    const now = new Date();
    futimesSync(descriptor, now, now);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(descriptor);
  }
}

function createSweepLockFile(lockPath) {
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0);
  let descriptor;
  try {
    descriptor = openSync(lockPath, flags, 0o600);
    const stats = fstatSync(descriptor);
    if (!isOwnedMarkerFile(stats)) {
      closeSync(descriptor);
      unlinkSync(lockPath);
      return undefined;
    }
    writeFileSync(descriptor, String(process.pid));
    return { path: lockPath, descriptor, dev: stats.dev, ino: stats.ino };
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Best effort
      }
    }
    return undefined;
  }
}

function releaseSweepLock(lock) {
  try {
    closeSync(lock.descriptor);
  } catch {
    // Best effort
  }
  try {
    const stats = lstatSync(lock.path);
    if (stats.dev === lock.dev && stats.ino === lock.ino) unlinkSync(lock.path);
  } catch {
    // Best effort
  }
}

function acquireSweepLock(markerPath, now = Date.now()) {
  if (!markerPath) return undefined;
  const bucket = Math.floor(now / SWEEP_THROTTLE_MS);
  return createSweepLockFile(`${markerPath}.lock-${bucket}`);
}

function removeExpiredSweepLocks(markerPath, now = Date.now()) {
  if (!markerPath) return;
  const currentBucket = Math.floor(now / SWEEP_THROTTLE_MS);
  const lockPrefix = `${basename(markerPath)}.lock-`;
  try {
    for (const entry of readdirSync(dirname(markerPath))) {
      if (!entry.startsWith(lockPrefix)) continue;
      const bucket = Number(entry.slice(lockPrefix.length));
      if (!Number.isSafeInteger(bucket) || bucket >= currentBucket - 1)
        continue;

      const lockPath = join(dirname(markerPath), entry);
      try {
        const stats = lstatSync(lockPath);
        if (isOwnedMarkerFile(stats)) unlinkSync(lockPath);
      } catch {
        // Best effort: ignore missing or inaccessible old lock files.
      }
    }
  } catch {
    // Best effort: old lock cleanup must not block sweep or judgment recording.
  }
}

function hasActivePreviousSweepLock(markerPath, now = Date.now()) {
  if (!markerPath) return true;
  const currentBucket = Math.floor(now / SWEEP_THROTTLE_MS);
  const previousPath = `${markerPath}.lock-${currentBucket - 1}`;
  try {
    const stats = lstatSync(previousPath);
    if (!isOwnedMarkerFile(stats)) return true;
    const pid = Number(readFileSync(previousPath, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return now - stats.mtimeMs < SWEEP_THROTTLE_MS;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

/**
 * Get the Jev mode for a point: 'off' | 'shadow' | 'active'.
 * Reuses the script resolver's config gates and union activation semantics.
 * permissionMode is the hook input's permission_mode; see parseJevEnv.
 */
export function jevModeFor(point, env = process.env, permissionMode) {
  return parseJevEnv(point, env, permissionMode);
}

/**
 * Check if Jev is opted in for a point (shadow or active, not off).
 * Backward-compatible boolean API for existing callers.
 */
export function isJevShadowOptedIn(point, env = process.env, permissionMode) {
  return jevModeFor(point, env, permissionMode) !== "off";
}

/**
 * Sweep and remove stale /tmp/omc-jev-* directories older than the given threshold.
 * Used for cleaning up leaked temp dirs from previous sessions.
 * Returns the count of successfully removed directories.
 */
export function sweepStaleTempDirs(maxAgeMs = 24 * 60 * 60 * 1000) {
  // On platforms without a comparable user id, do not delete from a possibly
  // shared temp root because directory ownership cannot be verified.
  if (typeof process.getuid !== "function") return 0;
  const tmpDir = tmpdir();
  const now = Date.now();
  let cleaned = 0;

  try {
    const entries = readdirSync(tmpDir);
    for (const entry of entries) {
      if (!entry.startsWith("omc-jev-")) continue;

      const fullPath = join(tmpDir, entry);
      try {
        const stats = lstatSync(fullPath);
        const ownedByCurrentUser = stats.uid === process.getuid();
        if (!stats.isDirectory() || !ownedByCurrentUser) continue;

        const contents = readdirSync(fullPath);
        if (contents.length !== 1 || contents[0] !== "request.json") continue;

        const requestStats = lstatSync(join(fullPath, "request.json"));
        const requestOwnedByCurrentUser = requestStats.uid === process.getuid();
        if (
          requestStats.isFile() &&
          requestOwnedByCurrentUser &&
          now - stats.mtimeMs > maxAgeMs
        ) {
          rmSync(fullPath, { recursive: true, force: true });
          cleaned++;
        }
      } catch {
        // Skip entries that can't be stat'd or removed
      }
    }
  } catch {
    // If we can't read the tmp directory, skip the sweep
  }

  return cleaned;
}

/**
 * Read the active Noul answer of a recordJevShadow() result as a probability
 * of "yes" (0-1). The API returns a number; a boolean is accepted too and maps
 * to 1 or 0. Returns undefined for a shadow, off or degraded call, a missing
 * answer, an answer whose type is not "noul", or a value that is not a finite
 * number in 0-1, so the caller falls back to its heuristic. When the result
 * carries an `answers` map the answer is read by `questionName` only: a name
 * the map lacks returns undefined, never another question's answer. Without a
 * map the single `answer` is read.
 */
export function jevNoulOf(result, questionName) {
  if (result?.mode !== "active") return undefined;
  // With an answers map the answer is read by question name only: a name the
  // map lacks must not fall back to result.answer, which can be the answer to
  // a different question. Without a map the single answer is used.
  const answer =
    result.answers && typeof result.answers === "object"
      ? Object.hasOwn(result.answers, questionName)
        ? result.answers[questionName]
        : undefined
      : result.answer;
  if (answer?.type !== "noul") return undefined;
  const noul = answer.noul;
  if (typeof noul === "boolean") return noul ? 1 : 0;
  return typeof noul === "number" && Number.isFinite(noul) && noul >= 0 && noul <= 1 ? noul : undefined;
}

/**
 * Fire-and-record one script-side judgment.
 * - Shadow mode: fire-and-forget, returns undefined immediately
 * - Active mode: waits (sync) for Jev answer, returns { mode, answer, answers, ... }
 *   (`answers` maps every question name to its answer; read multi-question
 *   points by name, never by position)
 * - Off mode: returns undefined
 * Falls back to undefined (caller uses heuristic) on timeout/error/parse-failure.
 * permissionMode is the hook input's permission_mode; it travels in the
 * request so the resolver logs the same mode the caller acted on.
 */
export function recordJevShadow({ point, state, questions, heuristic, permissionMode, toolUseId }) {
  const mode = jevModeFor(point, process.env, permissionMode);
  if (mode === "off") return undefined;

  // Throttled best-effort sweep of stale temp directories (once per hour)
  // This cleans up leftovers from killed resolvers that couldn't clean themselves
  const markerPath = getSweepThrottleMarkerPath();
  try {
    if (shouldRunSweep(markerPath)) {
      removeExpiredSweepLocks(markerPath);
      if (!hasActivePreviousSweepLock(markerPath)) {
        const lock = acquireSweepLock(markerPath);
        if (lock) {
          try {
            if (shouldRunSweep(markerPath) && updateSweepMarker(markerPath)) {
              sweepStaleTempDirs(24 * 60 * 60 * 1000); // Clean dirs older than 24h
            }
          } finally {
            releaseSweepLock(lock);
          }
        }
      }
    }
  } catch {
    // Best effort: marker or sweep failures never affect judgment recording
  }

  let tempDir;
  let requestFile;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "omc-jev-"));
    requestFile = join(tempDir, "request.json");
    const logContext = requestLogContext(point);
    const startedAt = Date.now();

    writeFileSync(
      requestFile,
      JSON.stringify({ point, state, questions, heuristic, permissionMode, ...(logContext ? { context: logContext } : {}), ...(toolUseId ? { tool_use_id: toolUseId } : {}) }),
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );

    if (mode === "shadow") {
      // Fire-and-forget for shadow mode
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../jev-resolve.mjs", import.meta.url)),
          "--request-file",
          requestFile,
        ],
        {
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
          env: process.env,
          windowsHide: true,
        },
      );
      child.on("error", () => {
        // Clean up temp dir on spawn error
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // Best effort
        }
      });
      child.unref();
      return undefined;
    }

    // Active mode: spawn synchronously and read result
    if (mode === "active") {
      try {
        const result = spawnSync(
          process.execPath,
          [
            fileURLToPath(new URL("../jev-resolve.mjs", import.meta.url)),
            "--request-file",
            requestFile,
          ],
          {
            stdio: ["ignore", "pipe", "ignore"],
            env: process.env,
            encoding: "utf8",
            timeout: resolveJevTimeoutMs(
              process.env,
              activeResolverBufferMs(point),
            ),
          },
        );

        if (result.status === 0 && result.stdout) {
          try {
            return JSON.parse(result.stdout);
          } catch {
            // Parse error: fall back to heuristic
            return undefined;
          }
        }
        if (result.status !== 0) recordResolverFailure(point, result, Date.now() - startedAt, logContext);
      } finally {
        // Always clean up temp dir after active mode
        if (tempDir) {
          try {
            rmSync(tempDir, { recursive: true, force: true });
          } catch {
            // Best effort
          }
        }
      }
    }
  } catch {
    // Jev logging is advisory; temp-file or spawn failures never affect hooks.
    // Clean up temp dir on any exception
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best effort
      }
    }
  }
  return undefined;
}

// OMC_JEV_LOG_CONTEXT=1: the ids of the hook call being judged, for the Jev
// logs only (they are never sent to Jev), and the log directory for the lines
// a hook writes itself. Set once per hook process by setJevHookContext.
let hookLogContext;
let hookLogDir;
// request_id of the last request per point in this process, for applied.jsonl.
const lastRequestIds = new Map();

/**
 * OMC_JEV_APPLIED_LOG=1 (or `true`): a hook that acts on an active Jev answer
 * writes what the answer changed to applied.jsonl (see recordJevApplied).
 */
export function isJevAppliedLogEnabled(env = process.env) {
  return ["1", "true"].includes(String(env.OMC_JEV_APPLIED_LOG ?? "").trim().toLowerCase());
}

/**
 * Ids a hook puts into a Jev state (session_id, cwd), or nothing with
 * OMC_JEV_STATE_OMIT_IDS=1: then they reach the log only, with
 * OMC_JEV_LOG_CONTEXT=1, and are never sent to Jev. Spread it into the state.
 */
export function jevStateIds(ids) {
  return isJevStateOmitIdsEnabled(process.env) ? {} : ids;
}

/** True when this configuration can send a Jev request at all (a key and OMC_JEV entries). */
function mayRequestJev(env) {
  const raw = (env.OMC_JEV || "").trim();
  return Boolean(env.TYPESAFE_API_KEY) && raw !== "" && raw !== "off";
}

/**
 * Tell the Jev channel which hook call it judges: the hook input's
 * tool_use_id, session_id, cwd (the process's working directory when the
 * input has none), agent_id, agent_type and prompt_id. Call it once after the
 * hook input is parsed, before any recordJevShadow call. It does something
 * only with OMC_JEV_LOG_CONTEXT=1 or OMC_JEV_APPLIED_LOG=1 and a configuration
 * that can send Jev requests: it keeps the ids (OMC_JEV_LOG_CONTEXT only) and
 * resolves the Jev log directory, as the resolver does. Never throws.
 */
export async function setJevHookContext(data) {
  hookLogContext = undefined;
  hookLogDir = undefined;
  lastRequestIds.clear();
  const logContext = isJevLogContextEnabled(process.env);
  if ((!logContext && !isJevAppliedLogEnabled(process.env)) || !mayRequestJev(process.env)) return;
  if (logContext) {
    const context = jevLogContextOf(data);
    delete context.request_id;
    if (context.cwd === undefined) {
      try {
        context.cwd = process.cwd();
      } catch {
        // No working directory: the field is left out.
      }
    }
    hookLogContext = context;
  }
  try {
    hookLogDir = await resolveJevLogDir(process.env);
  } catch {
    // Without a log directory the hook writes no lines itself.
  }
}

/** The ids of one request: the hook call's and a new request_id. Undefined without OMC_JEV_LOG_CONTEXT=1. */
function requestLogContext(point) {
  if (!isJevLogContextEnabled(process.env)) return undefined;
  const context = { ...hookLogContext, request_id: randomUUID() };
  lastRequestIds.set(point, context.request_id);
  return context;
}

/**
 * Record that this hook acted on an active Jev answer: one line in
 * applied.jsonl next to shadow.jsonl, {ts, point, ...ids, applied}, where
 * `applied` says what the answer changed, typically as {from, to}. Advisory
 * actions use {action: {from, to, noul}} for warning/reminder decisions and
 * the active answer's probability. Routing fields and advisory metadata are
 * accepted unchanged; this helper does not decide whether behavior changed. Call it
 * only when the answer really changed what the hook does. With
 * OMC_JEV_LOG_CONTEXT=1 the line carries the hook call's ids and the
 * request_id of this process's last request for the point, which is also in
 * that request's shadow.jsonl line. Only with OMC_JEV_APPLIED_LOG=1; never
 * throws.
 */
export function recordJevApplied(point, applied) {
  if (!isJevAppliedLogEnabled(process.env)) return;
  const requestId = lastRequestIds.get(point);
  appendJevLogLine("applied.jsonl", {
    ts: new Date().toISOString(),
    point,
    ...(isJevLogContextEnabled(process.env) ? { ...hookLogContext, ...(requestId ? { request_id: requestId } : {}) } : {}),
    applied,
  });
}

/**
 * Append one line to a Jev log file in the hook's log directory
 * (OMC_JEV_LOG_DIR when setJevHookContext did not resolve one), rotated like
 * the resolver's lines (OMC_JEV_LOG_MAX_MB). Every file a hook script writes
 * next to shadow.jsonl goes through this. Never throws.
 */
export function appendJevLogLine(fileName, entry) {
  const logDir = hookLogDir || process.env.OMC_JEV_LOG_DIR;
  if (!logDir) return;
  try {
    mkdirSync(logDir, { recursive: true });
    const path = join(logDir, fileName);
    rotateJevLog(path, resolveJevLogMaxBytes(process.env));
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Best-effort logging: a logging failure must never affect the hook.
  }
}

/**
 * An active-mode resolver that the hook killed at its time limit
 * (resolver-timeout), that could not be started (resolver-spawn), or that
 * ended with a non-zero status or a signal (resolver-exit) wrote no
 * shadow-log line. With OMC_JEV_LOG_CONTEXT=1 the hook writes one for it: the
 * request's ids, mode "degraded", the reason, the exit status or signal when
 * there is one, and the time waited; no state and no answers.
 */
function recordResolverFailure(point, result, durationMs, logContext) {
  if (!logContext) return;
  const code = result?.error?.code;
  appendJevLogLine("shadow.jsonl", {
    ts: new Date().toISOString(),
    point,
    ...logContext,
    mode: "degraded",
    reason: code === "ETIMEDOUT" ? "resolver-timeout" : result?.error ? "resolver-spawn" : "resolver-exit",
    ...(typeof result?.status === "number" ? { status: result.status } : {}),
    ...(result?.signal ? { signal: result.signal } : {}),
    durationMs,
  });
}
