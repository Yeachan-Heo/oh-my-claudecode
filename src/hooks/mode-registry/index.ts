/**
 * Mode Registry - Centralized Mode State Detection
 *
 * CRITICAL: This module uses ONLY file-based detection.
 * It NEVER imports from mode modules to avoid circular dependencies.
 *
 * Mode modules import FROM this registry (unidirectional).
 *
 * All modes store state in `.omc/state/` subdirectory for consistency.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { ExecutionMode, ModeConfig, ModeStatus, CanStartResult } from './types.js';

export type { ExecutionMode, ModeConfig, ModeStatus, CanStartResult } from './types.js';

/**
 * Mode configuration registry
 *
 * Maps each mode to its state file location and detection method.
 * All paths are relative to .omc/state/ directory.
 */
const MODE_CONFIGS: Record<ExecutionMode, ModeConfig> = {
  autopilot: {
    name: 'Autopilot',
    stateFile: 'autopilot-state.json',
    activeProperty: 'active'
  },
  ultrapilot: {
    name: 'Ultrapilot',
    stateFile: 'ultrapilot-state.json',
    markerFile: 'ultrapilot-ownership.json',
    activeProperty: 'active'
  },
  swarm: {
    name: 'Swarm',
    stateFile: 'swarm.db',
    markerFile: 'swarm-active.marker',
    isSqlite: true
  },
  pipeline: {
    name: 'Pipeline',
    stateFile: 'pipeline-state.json',
    activeProperty: 'active'
  },
  ralph: {
    name: 'Ralph',
    stateFile: 'ralph-state.json',
    markerFile: 'ralph-verification.json',
    activeProperty: 'active',
    hasGlobalState: true
  },
  ultrawork: {
    name: 'Ultrawork',
    stateFile: 'ultrawork-state.json',
    activeProperty: 'active',
    hasGlobalState: true
  },
  ultraqa: {
    name: 'UltraQA',
    stateFile: 'ultraqa-state.json',
    activeProperty: 'active'
  },
  ecomode: {
    name: 'Ecomode',
    stateFile: 'ecomode-state.json',
    activeProperty: 'active',
    hasGlobalState: true
  }
};

// Export for use in other modules
export { MODE_CONFIGS };

/**
 * Modes that are mutually exclusive (cannot run concurrently)
 */
const EXCLUSIVE_MODES: ExecutionMode[] = ['autopilot', 'ultrapilot', 'swarm', 'pipeline'];

/**
 * Get the state directory path
 */
export function getStateDir(cwd: string): string {
  return join(cwd, '.omc', 'state');
}

/**
 * Ensure the state directory exists
 */
export function ensureStateDir(cwd: string): void {
  const stateDir = getStateDir(cwd);
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}

/**
 * Get the full path to a mode's state file
 */
export function getStateFilePath(cwd: string, mode: ExecutionMode): string {
  const config = MODE_CONFIGS[mode];
  return join(getStateDir(cwd), config.stateFile);
}

/**
 * Get the full path to a mode's marker file
 */
export function getMarkerFilePath(cwd: string, mode: ExecutionMode): string | null {
  const config = MODE_CONFIGS[mode];
  if (!config.markerFile) return null;
  return join(getStateDir(cwd), config.markerFile);
}

/**
 * Get the global state file path (in ~/.claude/) for modes that support it
 */
export function getGlobalStateFilePath(mode: ExecutionMode): string | null {
  const config = MODE_CONFIGS[mode];
  if (!config.hasGlobalState) {
    return null;
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  return join(homeDir, '.claude', config.stateFile);
}

/**
 * Check if a JSON-based mode is active by reading its state file
 */
function isJsonModeActive(cwd: string, mode: ExecutionMode): boolean {
  const config = MODE_CONFIGS[mode];
  const stateFile = getStateFilePath(cwd, mode);

  if (!existsSync(stateFile)) {
    return false;
  }

  try {
    const content = readFileSync(stateFile, 'utf-8');
    const state = JSON.parse(content);

    if (config.activeProperty) {
      return state[config.activeProperty] === true;
    }

    // Default: file existence means active
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a SQLite-based mode is active by checking its marker file
 *
 * We use a marker file instead of querying SQLite directly to avoid:
 * 1. Requiring sqlite3 CLI or better-sqlite3 dependency
 * 2. Opening database connections from the registry
 */
function isSqliteModeActive(cwd: string, mode: ExecutionMode): boolean {
  const markerPath = getMarkerFilePath(cwd, mode);

  // Check marker file first (authoritative)
  if (markerPath && existsSync(markerPath)) {
    return true;
  }

  // Fallback: check if database file exists (may have stale data)
  const dbPath = getStateFilePath(cwd, mode);
  return existsSync(dbPath);
}

/**
 * Check if a specific mode is currently active
 *
 * @param mode - The mode to check
 * @param cwd - Working directory
 * @returns true if the mode is active
 */
export function isModeActive(mode: ExecutionMode, cwd: string): boolean {
  const config = MODE_CONFIGS[mode];

  if (config.isSqlite) {
    return isSqliteModeActive(cwd, mode);
  }

  return isJsonModeActive(cwd, mode);
}

/**
 * Check if a mode has active state (file exists)
 */
export function hasModeState(cwd: string, mode: ExecutionMode): boolean {
  const stateFile = getStateFilePath(cwd, mode);
  return existsSync(stateFile);
}

/**
 * Get all modes that currently have state files
 */
export function getActiveModes(cwd: string): ExecutionMode[] {
  const modes: ExecutionMode[] = [];

  for (const mode of Object.keys(MODE_CONFIGS) as ExecutionMode[]) {
    if (isModeActive(mode, cwd)) {
      modes.push(mode);
    }
  }

  return modes;
}

/**
 * Get the currently active exclusive mode (if any)
 *
 * @param cwd - Working directory
 * @returns The active mode or null
 */
export function getActiveExclusiveMode(cwd: string): ExecutionMode | null {
  for (const mode of EXCLUSIVE_MODES) {
    if (isModeActive(mode, cwd)) {
      return mode;
    }
  }
  return null;
}

/**
 * Check if a new mode can be started
 *
 * @param mode - The mode to start
 * @param cwd - Working directory
 * @returns CanStartResult with allowed status and blocker info
 */
export function canStartMode(mode: ExecutionMode, cwd: string): CanStartResult {
  // Check for mutually exclusive modes
  if (EXCLUSIVE_MODES.includes(mode)) {
    for (const exclusiveMode of EXCLUSIVE_MODES) {
      if (exclusiveMode !== mode && isModeActive(exclusiveMode, cwd)) {
        const config = MODE_CONFIGS[exclusiveMode];
        return {
          allowed: false,
          blockedBy: exclusiveMode,
          message: `Cannot start ${MODE_CONFIGS[mode].name} while ${config.name} is active. Cancel ${config.name} first with /oh-my-claudecode:cancel.`
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Get status of all modes
 *
 * @param cwd - Working directory
 * @returns Array of mode statuses
 */
export function getAllModeStatuses(cwd: string): ModeStatus[] {
  return (Object.keys(MODE_CONFIGS) as ExecutionMode[]).map(mode => ({
    mode,
    active: isModeActive(mode, cwd),
    stateFilePath: getStateFilePath(cwd, mode)
  }));
}

/**
 * Clear all state files for a mode
 *
 * Deletes:
 * - Local state file (.omc/state/{mode}-state.json)
 * - Local marker file if applicable
 * - Global state file if applicable (~/.claude/{mode}-state.json)
 *
 * @returns true if all files were deleted successfully (or didn't exist)
 */
export function clearModeState(mode: ExecutionMode, cwd: string): boolean {
  const config = MODE_CONFIGS[mode];
  let success = true;

  // Delete local state file
  const stateFile = getStateFilePath(cwd, mode);
  if (existsSync(stateFile)) {
    try {
      unlinkSync(stateFile);
    } catch {
      success = false;
    }
  }

  // For SQLite, also delete WAL and SHM files
  if (config.isSqlite) {
    const walFile = stateFile + '-wal';
    const shmFile = stateFile + '-shm';
    if (existsSync(walFile)) {
      try { unlinkSync(walFile); } catch { success = false; }
    }
    if (existsSync(shmFile)) {
      try { unlinkSync(shmFile); } catch { success = false; }
    }
  }

  // Delete marker file if applicable
  const markerFile = getMarkerFilePath(cwd, mode);
  if (markerFile && existsSync(markerFile)) {
    try {
      unlinkSync(markerFile);
    } catch {
      success = false;
    }
  }

  // Delete global state file if applicable
  const globalFile = getGlobalStateFilePath(mode);
  if (globalFile && existsSync(globalFile)) {
    try {
      unlinkSync(globalFile);
    } catch {
      success = false;
    }
  }

  return success;
}

/**
 * Clear all mode states (force clear)
 */
export function clearAllModeStates(cwd: string): boolean {
  let success = true;

  for (const mode of Object.keys(MODE_CONFIGS) as ExecutionMode[]) {
    if (!clearModeState(mode, cwd)) {
      success = false;
    }
  }

  return success;
}

// ============================================================================
// MARKER FILE MANAGEMENT (for SQLite-based modes)
// ============================================================================

/**
 * Create a marker file to indicate a mode is active
 *
 * Called when starting a SQLite-based mode (like swarm).
 *
 * @param mode - The mode being started
 * @param cwd - Working directory
 * @param metadata - Optional metadata to store in marker
 */
export function createModeMarker(
  mode: ExecutionMode,
  cwd: string,
  metadata?: Record<string, unknown>
): boolean {
  const markerPath = getMarkerFilePath(cwd, mode);
  if (!markerPath) {
    console.error(`Mode ${mode} does not use a marker file`);
    return false;
  }

  try {
    // Ensure directory exists
    const dir = dirname(markerPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const content = JSON.stringify({
      mode,
      startedAt: new Date().toISOString(),
      ...metadata
    }, null, 2);

    writeFileSync(markerPath, content);
    return true;
  } catch (error) {
    console.error(`Failed to create marker file for ${mode}:`, error);
    return false;
  }
}

/**
 * Remove a marker file to indicate a mode has stopped
 *
 * Called when stopping a SQLite-based mode (like swarm).
 *
 * @param mode - The mode being stopped
 * @param cwd - Working directory
 */
export function removeModeMarker(mode: ExecutionMode, cwd: string): boolean {
  const markerPath = getMarkerFilePath(cwd, mode);
  if (!markerPath) {
    return true; // No marker to remove
  }

  try {
    if (existsSync(markerPath)) {
      unlinkSync(markerPath);
    }
    return true;
  } catch (error) {
    console.error(`Failed to remove marker file for ${mode}:`, error);
    return false;
  }
}

/**
 * Read metadata from a marker file
 *
 * @param mode - The mode to read
 * @param cwd - Working directory
 */
export function readModeMarker(
  mode: ExecutionMode,
  cwd: string
): Record<string, unknown> | null {
  const markerPath = getMarkerFilePath(cwd, mode);
  if (!markerPath || !existsSync(markerPath)) {
    return null;
  }

  try {
    const content = readFileSync(markerPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}
