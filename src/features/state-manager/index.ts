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
import * as crypto from "crypto";
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
const LOCAL_STATE_DIR = ".omc/state";
/**
 * @deprecated for mode state. Global state directory is only used for analytics and daemon state.
 * Mode state should use LOCAL_STATE_DIR exclusively.
 */
const GLOBAL_STATE_DIR = path.join(os.homedir(), ".omc", "state");

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
 * Write content to file atomically using temp file + rename pattern.
 * This prevents file corruption if the process crashes during write.
 */
function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${crypto.randomUUID()}`,
  );

  try {
    fs.writeFileSync(tempPath, content, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
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
    try {
      const content = fs.readFileSync(standardPath, "utf-8");
      const data = JSON.parse(content) as T;
      return {
        exists: true,
        data,
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

  try {
    // Ensure directory exists
    if (createDirs) {
      ensureStateDir(location);
    }

    const content = JSON.stringify(data, null, 2);
    atomicWriteFileSync(statePath, content);

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
