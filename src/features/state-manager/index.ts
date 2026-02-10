/**
 * State Manager
 *
 * Unified state management that standardizes state file locations:
 * - Local state: .omc/state/{name}.json
 * - Global state: ~/.omc/state/{name}.json
 *
 * Features:
 * - Type-safe read/write operations
 * - Auto-create directories
 * - Legacy location support (for migration)
 * - State cleanup utilities
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { atomicWriteJsonSync } from "../../lib/atomic-write.js";
import { OmcPaths } from "../../lib/worktree-paths.js";
import {
  StateLocation,
  StateConfig,
  StateReadResult,
  StateWriteResult,
  StateClearResult,
  StateMigrationResult,
  StateFileInfo,
  ListStatesOptions,
  CleanupOptions,
  CleanupResult,
  StateData,
  DEFAULT_STATE_CONFIG,
} from "./types.js";

// Standard state directories
const LOCAL_STATE_DIR = OmcPaths.STATE;
/**
 * @deprecated for mode state. Global state directory is only used for analytics and daemon state.
 * Mode state should use LOCAL_STATE_DIR exclusively.
 */
const GLOBAL_STATE_DIR = path.join(os.homedir(), ".omc", "state");

/** Maximum age for state files before they are considered stale (4 hours) */
const MAX_STATE_AGE_MS = 4 * 60 * 60 * 1000;

// Read cache: avoids re-reading unchanged state files within TTL
const STATE_CACHE_TTL_MS = 5_000; // 5 seconds
interface CacheEntry {
  data: unknown;
  mtime: number;
  cachedAt: number;
}
const stateCache = new Map<string, CacheEntry>();

/**
 * Clear the state read cache.
 * Exported for testing and for write/clear operations to invalidate stale entries.
 */
export function clearStateCache(): void {
  stateCache.clear();
}

// Legacy state locations (for backward compatibility)
const LEGACY_LOCATIONS: Record<string, string[]> = {
  boulder: [".omc/boulder.json"],
  autopilot: [".omc/autopilot-state.json"],
  "autopilot-state": [".omc/autopilot-state.json"],
  ralph: [".omc/ralph-state.json"],
  "ralph-state": [".omc/ralph-state.json"],
  "ralph-verification": [".omc/ralph-verification.json"],
  ultrawork: [".omc/ultrawork-state.json"],
  "ultrawork-state": [".omc/ultrawork-state.json"],
  ultraqa: [".omc/ultraqa-state.json"],
  "ultraqa-state": [".omc/ultraqa-state.json"],
  "hud-state": [".omc/hud-state.json"],
  prd: [".omc/prd.json"],
};

/**
 * Get the standard path for a state file
 */
export function getStatePath(name: string, location: StateLocation): string {
  const baseDir =
    location === StateLocation.LOCAL ? LOCAL_STATE_DIR : GLOBAL_STATE_DIR;
  return path.join(baseDir, `${name}.json`);
}

/**
 * Get legacy paths for a state file (for migration)
 */
export function getLegacyPaths(name: string): string[] {
  return LEGACY_LOCATIONS[name] || [];
}

/**
 * Ensure state directory exists
 */
export function ensureStateDir(location: StateLocation): void {
  const dir =
    location === StateLocation.LOCAL ? LOCAL_STATE_DIR : GLOBAL_STATE_DIR;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Read state from file
 *
 * Checks standard location first, then legacy locations if enabled.
 * Returns both the data and where it was found.
 */
export function readState<T = StateData>(
  name: string,
  location: StateLocation = StateLocation.LOCAL,
  options?: { checkLegacy?: boolean },
): StateReadResult<T> {
  const checkLegacy = options?.checkLegacy ?? DEFAULT_STATE_CONFIG.checkLegacy;
  const standardPath = getStatePath(name, location);
  const legacyPaths = checkLegacy ? getLegacyPaths(name) : [];

  // Try standard location first
  if (fs.existsSync(standardPath)) {
    // Check cache: if entry exists, mtime matches, and TTL not expired, return cached data
    try {
      const stat = fs.statSync(standardPath);
      const mtime = stat.mtimeMs;
      const cached = stateCache.get(standardPath);
      if (cached && cached.mtime === mtime && (Date.now() - cached.cachedAt) < STATE_CACHE_TTL_MS) {
        return {
          exists: true,
          data: structuredClone(cached.data) as T,
          foundAt: standardPath,
          legacyLocations: [],
        };
      }
    } catch {
      // statSync failed, proceed to read
    }

    try {
      const content = fs.readFileSync(standardPath, "utf-8");
      const data = JSON.parse(content) as T;

      // Update cache with a defensive clone so callers cannot corrupt it
      try {
        const stat = fs.statSync(standardPath);
        stateCache.set(standardPath, { data: structuredClone(data), mtime: stat.mtimeMs, cachedAt: Date.now() });
      } catch {
        // statSync failed, skip caching
      }

      return {
        exists: true,
        data: structuredClone(data) as T,
        foundAt: standardPath,
        legacyLocations: [],
      };
    } catch (error) {
      // Invalid JSON or read error - treat as not found
      console.warn(`Failed to read state from ${standardPath}:`, error);
    }
  }

  // Try legacy locations
  if (checkLegacy) {
    for (const legacyPath of legacyPaths) {
      // Resolve relative paths
      const resolvedPath = path.isAbsolute(legacyPath)
        ? legacyPath
        : path.join(process.cwd(), legacyPath);

      if (fs.existsSync(resolvedPath)) {
        try {
          const content = fs.readFileSync(resolvedPath, "utf-8");
          const data = JSON.parse(content) as T;
          return {
            exists: true,
            data,
            foundAt: resolvedPath,
            legacyLocations: legacyPaths,
          };
        } catch (error) {
          console.warn(
            `Failed to read legacy state from ${resolvedPath}:`,
            error,
          );
        }
      }
    }
  }

  return {
    exists: false,
    legacyLocations: checkLegacy ? legacyPaths : [],
  };
}

/**
 * Write state to file
 *
 * Always writes to the standard location.
 * Creates directories if they don't exist.
 */
export function writeState<T = StateData>(
  name: string,
  data: T,
  location: StateLocation = StateLocation.LOCAL,
  options?: { createDirs?: boolean },
): StateWriteResult {
  const createDirs = options?.createDirs ?? DEFAULT_STATE_CONFIG.createDirs;
  const statePath = getStatePath(name, location);

  // Invalidate cache on write
  stateCache.delete(statePath);

  try {
    // Ensure directory exists
    if (createDirs) {
      ensureStateDir(location);
    }

    atomicWriteJsonSync(statePath, data);

    return {
      success: true,
      path: statePath,
    };
  } catch (error) {
    return {
      success: false,
      path: statePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Clear state from all locations (standard + legacy)
 *
 * Removes the state file from both standard and legacy locations.
 * Returns information about what was removed.
 */
export function clearState(
  name: string,
  location?: StateLocation,
): StateClearResult {
  // Invalidate cache for all possible locations
  const locationsForCache: StateLocation[] = location
    ? [location]
    : [StateLocation.LOCAL, StateLocation.GLOBAL];
  for (const loc of locationsForCache) {
    stateCache.delete(getStatePath(name, loc));
  }

  const result: StateClearResult = {
    removed: [],
    notFound: [],
    errors: [],
  };

  // Determine which locations to check
  const locationsToCheck: StateLocation[] = location
    ? [location]
    : [StateLocation.LOCAL, StateLocation.GLOBAL];

  // Remove from standard locations
  for (const loc of locationsToCheck) {
    const standardPath = getStatePath(name, loc);
    try {
      if (fs.existsSync(standardPath)) {
        fs.unlinkSync(standardPath);
        result.removed.push(standardPath);
      } else {
        result.notFound.push(standardPath);
      }
    } catch (error) {
      result.errors.push({
        path: standardPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Remove from legacy locations
  const legacyPaths = getLegacyPaths(name);
  for (const legacyPath of legacyPaths) {
    const resolvedPath = path.isAbsolute(legacyPath)
      ? legacyPath
      : path.join(process.cwd(), legacyPath);

    try {
      if (fs.existsSync(resolvedPath)) {
        fs.unlinkSync(resolvedPath);
        result.removed.push(resolvedPath);
      } else {
        result.notFound.push(resolvedPath);
      }
    } catch (error) {
      result.errors.push({
        path: resolvedPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/**
 * Migrate state from legacy location to standard location
 *
 * Finds state in legacy locations and moves it to the standard location.
 * Deletes the legacy file after successful migration.
 */
export function migrateState(
  name: string,
  location: StateLocation = StateLocation.LOCAL,
): StateMigrationResult {
  // Check if already in standard location
  const standardPath = getStatePath(name, location);
  if (fs.existsSync(standardPath)) {
    return {
      migrated: false,
    };
  }

  // Look for legacy state
  const readResult = readState(name, location, { checkLegacy: true });
  if (!readResult.exists || !readResult.foundAt || !readResult.data) {
    return {
      migrated: false,
      error: "No legacy state found",
    };
  }

  // Check if it's actually from a legacy location
  const isLegacy = readResult.foundAt !== standardPath;
  if (!isLegacy) {
    return {
      migrated: false,
    };
  }

  // Write to standard location
  const writeResult = writeState(name, readResult.data, location);
  if (!writeResult.success) {
    return {
      migrated: false,
      error: `Failed to write to standard location: ${writeResult.error}`,
    };
  }

  // Delete legacy file
  try {
    fs.unlinkSync(readResult.foundAt);
  } catch (error) {
    // Migration succeeded but cleanup failed - not critical
    console.warn(
      `Failed to delete legacy state at ${readResult.foundAt}:`,
      error,
    );
  }

  return {
    migrated: true,
    from: readResult.foundAt,
    to: writeResult.path,
  };
}

/**
 * List all state files
 *
 * Returns information about all state files in the specified location(s).
 */
export function listStates(options?: ListStatesOptions): StateFileInfo[] {
  const results: StateFileInfo[] = [];
  const includeLegacy = options?.includeLegacy ?? false;
  const pattern = options?.pattern;

  // Helper to check if name matches pattern
  const matchesPattern = (name: string): boolean => {
    if (!pattern) return true;
    // Simple glob: * matches anything
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    return regex.test(name);
  };

  // Helper to add state files from a directory
  const addStatesFromDir = (
    dir: string,
    location: StateLocation,
    isLegacy: boolean = false,
  ) => {
    if (!fs.existsSync(dir)) return;

    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        const name = file.slice(0, -5); // Remove .json
        if (!matchesPattern(name)) continue;

        const filePath = path.join(dir, file);
        const stats = fs.statSync(filePath);

        results.push({
          name,
          path: filePath,
          location,
          size: stats.size,
          modified: stats.mtime,
          isLegacy,
        });
      }
    } catch (error) {
      console.warn(`Failed to list states from ${dir}:`, error);
    }
  };

  // Check standard locations
  if (!options?.location || options.location === StateLocation.LOCAL) {
    addStatesFromDir(LOCAL_STATE_DIR, StateLocation.LOCAL);
  }
  if (!options?.location || options.location === StateLocation.GLOBAL) {
    addStatesFromDir(GLOBAL_STATE_DIR, StateLocation.GLOBAL);
  }

  // Check legacy locations if requested
  if (includeLegacy) {
    // Add logic to scan legacy locations
    // This would require knowing all possible legacy locations
    // For now, we skip this as legacy locations are name-specific
  }

  return results;
}

/**
 * Cleanup orphaned state files
 *
 * Removes state files that haven't been modified in a long time.
 * Useful for cleaning up abandoned states.
 */
export function cleanupOrphanedStates(options?: CleanupOptions): CleanupResult {
  const maxAgeDays = options?.maxAgeDays ?? 30;
  const dryRun = options?.dryRun ?? false;
  const exclude = options?.exclude ?? [];

  const result: CleanupResult = {
    deleted: [],
    wouldDelete: dryRun ? [] : undefined,
    spaceFreed: 0,
    errors: [],
  };

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

  const states = listStates({ includeLegacy: false });

  for (const state of states) {
    // Skip excluded patterns
    if (
      exclude.some((pattern) => {
        const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
        return regex.test(state.name);
      })
    ) {
      continue;
    }

    // Check if old enough
    if (state.modified > cutoffDate) {
      continue;
    }

    // Delete or record for dry run
    if (dryRun) {
      result.wouldDelete?.push(state.path);
      result.spaceFreed += state.size;
    } else {
      try {
        fs.unlinkSync(state.path);
        result.deleted.push(state.path);
        result.spaceFreed += state.size;
      } catch (error) {
        result.errors.push({
          path: state.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return result;
}

/**
 * Determine whether a state's metadata indicates staleness.
 *
 * A state is stale when **both** `updatedAt` and `heartbeatAt` (if present)
 * are older than `maxAgeMs`.  If either timestamp is recent the state is
 * considered alive — this allows long-running workflows that send heartbeats
 * to survive the stale-check.
 */
export function isStateStale(
  meta: { updatedAt?: string; heartbeatAt?: string },
  now: number,
  maxAgeMs: number,
): boolean {
  const updatedAt = meta.updatedAt
    ? new Date(meta.updatedAt).getTime()
    : undefined;
  const heartbeatAt = meta.heartbeatAt
    ? new Date(meta.heartbeatAt).getTime()
    : undefined;

  // If updatedAt is recent, not stale
  if (updatedAt && !isNaN(updatedAt) && now - updatedAt <= maxAgeMs) {
    return false;
  }

  // If heartbeatAt is recent, not stale
  if (heartbeatAt && !isNaN(heartbeatAt) && now - heartbeatAt <= maxAgeMs) {
    return false;
  }

  // At least one timestamp must exist and be parseable to declare staleness
  const hasValidTimestamp =
    (updatedAt !== undefined && !isNaN(updatedAt)) ||
    (heartbeatAt !== undefined && !isNaN(heartbeatAt));

  return hasValidTimestamp;
}

/**
 * Scan all state files in a directory and mark stale ones as inactive.
 *
 * A state is considered stale if both `_meta.updatedAt` and
 * `_meta.heartbeatAt` are older than `maxAgeMs` (defaults to
 * MAX_STATE_AGE_MS = 4 hours).  States with a recent heartbeat are
 * skipped so that long-running workflows are not killed prematurely.
 *
 * This is the **only** place that deactivates stale states — the read
 * path (`readState`) is a pure read with no side-effects.
 *
 * @returns Number of states that were marked inactive.
 */
export function cleanupStaleStates(
  directory?: string,
  maxAgeMs: number = MAX_STATE_AGE_MS,
): number {
  const stateDir = directory
    ? path.join(directory, ".omc", "state")
    : LOCAL_STATE_DIR;

  if (!fs.existsSync(stateDir)) return 0;

  let cleaned = 0;
  const now = Date.now();

  try {
    const files = fs.readdirSync(stateDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const filePath = path.join(stateDir, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const data = JSON.parse(content) as Record<string, unknown>;

        if (data.active !== true) continue;

        const meta = (data._meta as Record<string, unknown> | undefined) ?? {};

        if (isStateStale(meta as { updatedAt?: string; heartbeatAt?: string }, now, maxAgeMs)) {
          console.warn(
            `[state-manager] cleanupStaleStates: marking "${file}" inactive (last updated ${meta.updatedAt ?? "unknown"})`,
          );
          data.active = false;
          // Invalidate cache for this path
          stateCache.delete(filePath);
          try {
            atomicWriteJsonSync(filePath, data);
            cleaned++;
          } catch { /* best-effort */ }
        }
      } catch {
        // Skip files that can't be read/parsed
      }
    }
  } catch {
    // Directory read error
  }

  return cleaned;
}

/**
 * State Manager Class
 *
 * Object-oriented interface for managing a specific state.
 */
export class StateManager<T = StateData> {
  constructor(
    private name: string,
    private location: StateLocation = StateLocation.LOCAL,
  ) {}

  read(options?: { checkLegacy?: boolean }): StateReadResult<T> {
    return readState<T>(this.name, this.location, options);
  }

  write(data: T, options?: { createDirs?: boolean }): StateWriteResult {
    return writeState(this.name, data, this.location, options);
  }

  clear(): StateClearResult {
    return clearState(this.name, this.location);
  }

  migrate(): StateMigrationResult {
    return migrateState(this.name, this.location);
  }

  exists(): boolean {
    return this.read({ checkLegacy: false }).exists;
  }

  get(): T | undefined {
    return this.read().data;
  }

  set(data: T): boolean {
    return this.write(data).success;
  }

  update(updater: (current: T | undefined) => T): boolean {
    const current = this.get();
    const updated = updater(current);
    return this.set(updated);
  }
}

/**
 * Create a state manager for a specific state
 */
export function createStateManager<T = StateData>(
  name: string,
  location: StateLocation = StateLocation.LOCAL,
): StateManager<T> {
  return new StateManager<T>(name, location);
}

// Re-export types for external use
export type {
  StateConfig,
  StateReadResult,
  StateWriteResult,
  StateClearResult,
  StateMigrationResult,
  StateFileInfo,
  ListStatesOptions,
  CleanupOptions,
  CleanupResult,
  StateData,
};

// Re-export enum, constants, and functions from types
export {
  StateLocation,
  DEFAULT_STATE_CONFIG,
  isStateLocation,
} from "./types.js";
