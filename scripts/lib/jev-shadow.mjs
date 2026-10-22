/* global process, URL */

import { spawn, spawnSync } from "node:child_process";
import {
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
import { parseJevEnv, resolveJevTimeoutMs } from "../jev-resolve.mjs";

const SWEEP_THROTTLE_MS = 60 * 60 * 1000; // 1 hour
const ACTIVE_RESOLVER_TIMEOUT_BUFFER_MS = 500;

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
 * Fire-and-record one script-side judgment.
 * - Shadow mode: fire-and-forget, returns undefined immediately
 * - Active mode: waits (sync) for Jev answer, returns { mode, answer, source, ... }
 * - Off mode: returns undefined
 * Falls back to undefined (caller uses heuristic) on timeout/error/parse-failure.
 * permissionMode is the hook input's permission_mode; it travels in the
 * request so the resolver logs the same mode the caller acted on.
 */
export function recordJevShadow({ point, state, questions, heuristic, permissionMode }) {
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

    writeFileSync(
      requestFile,
      JSON.stringify({ point, state, questions, heuristic, permissionMode }),
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
          stdio: ["ignore", "ignore", "ignore"],
          env: process.env,
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
              ACTIVE_RESOLVER_TIMEOUT_BUFFER_MS,
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
