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

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, statSync, rmdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import type { ExecutionMode, ModeConfig, ModeStatus, CanStartResult } from './types.js';
import { listSessionIds, resolveSessionStatePath, getSessionStateDir, validateSessionId } from '../../lib/worktree-paths.js';

export type { ExecutionMode, ModeConfig, ModeStatus, CanStartResult } from './types.js';

/**
 * Stale marker threshold (1 hour)
 * Markers older than this are auto-removed to prevent crashed sessions from blocking indefinitely.
 * NOTE: We cannot check database activity here due to circular dependency constraints.
 * Legitimate long-running swarms (>1 hour) may have markers removed - acceptable trade-off.
 */
export const STALE_MARKER_THRESHOLD = 60 * 60 * 1000; // 1 hour in milliseconds

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
  team: {
    name: 'Team',
    stateFile: 'team-state.json',
    activeProperty: 'active',
    hasGlobalState: false
  },
  ralph: {
    name: 'Ralph',
    stateFile: 'ralph-state.json',
    markerFile: 'ralph-verification.json',
    activeProperty: 'active',
    hasGlobalState: false
  },
  ultrawork: {
    name: 'Ultrawork',
    stateFile: 'ultrawork-state.json',
    activeProperty: 'active',
    hasGlobalState: false
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
    hasGlobalState: false
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
export function getStateFilePath(cwd: string, mode: ExecutionMode, sessionId?: string): string {
  const config = MODE_CONFIGS[mode];
  if (sessionId && !config.isSqlite) {
    return resolveSessionStatePath(mode, sessionId, cwd);
  }
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
 * @deprecated Global state is no longer supported. All modes use local-only state in .omc/state/
 * @returns Always returns null
 */
export function getGlobalStateFilePath(mode: ExecutionMode): string | null {
  // Global state is deprecated - all modes now use local-only state
  return null;
}

/**
 * Check if a JSON-based mode is active by reading its state file
 */
function isJsonModeActive(cwd: string, mode: ExecutionMode, sessionId?: string): boolean {
  const config = MODE_CONFIGS[mode];

  // When sessionId is provided, ONLY check session-scoped path — no legacy fallback.
  // This prevents cross-session state leakage where one session's legacy file
  // could cause another session to see mode as active.
  if (sessionId && !config.isSqlite) {
    const sessionStateFile = resolveSessionStatePath(mode, sessionId, cwd);
    if (!existsSync(sessionStateFile)) {
      return false;
    }

    try {
      const content = readFileSync(sessionStateFile, 'utf-8');
      const state = JSON.parse(content);

      // Validate session identity: state must belong to this session
      if (state.session_id && state.session_id !== sessionId) {
        return false;
      }

      if (config.activeProperty) {
        return state[config.activeProperty] === true;
      }

      return true;
    } catch {
      return false;
    }
  }

  // No sessionId: check legacy shared path (backward compat)
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
    try {
      const content = readFileSync(markerPath, 'utf-8');
      const marker = JSON.parse(content);

      // Check if marker is stale (older than 1 hour)
      // NOTE: We cannot check database activity here due to circular dependency constraints.
      // This means legitimate long-running swarms (>1 hour) may have their markers removed.
      // This is a deliberate trade-off to prevent crashed swarms from blocking indefinitely.
      if (marker.startedAt) {
        const startTime = new Date(marker.startedAt).getTime();
        const age = Date.now() - startTime;

        if (age > STALE_MARKER_THRESHOLD) {
          console.warn(`Stale ${mode} marker detected (${Math.round(age / 60000)} min old). Auto-removing.`);
          unlinkSync(markerPath);
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
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
 * @param sessionId - Optional session ID to check session-scoped state
 * @returns true if the mode is active
 */
export function isModeActive(mode: ExecutionMode, cwd: string, sessionId?: string): boolean {
  const config = MODE_CONFIGS[mode];

  if (config.isSqlite) {
    return isSqliteModeActive(cwd, mode);
  }

  return isJsonModeActive(cwd, mode, sessionId);
}

/**
 * Check if a mode has active state (file exists)
 * @param sessionId - When provided, checks session-scoped path only (no legacy fallback)
 */
export function hasModeState(cwd: string, mode: ExecutionMode, sessionId?: string): boolean {
  const stateFile = getStateFilePath(cwd, mode, sessionId);
  return existsSync(stateFile);
}

/**
 * Get all modes that currently have state files
 */
export function getActiveModes(cwd: string, sessionId?: string): ExecutionMode[] {
  const modes: ExecutionMode[] = [];

  for (const mode of Object.keys(MODE_CONFIGS) as ExecutionMode[]) {
    if (isModeActive(mode, cwd, sessionId)) {
      modes.push(mode);
    }
  }

  return modes;
}

/**
 * Check if any OMC mode is currently active
 *
 * @param cwd - Working directory
 * @returns true if any mode is active
 */
export function isAnyModeActive(cwd: string): boolean {
  return getActiveModes(cwd).length > 0;
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
  // Check for mutually exclusive modes across all sessions
  if (EXCLUSIVE_MODES.includes(mode)) {
    for (const exclusiveMode of EXCLUSIVE_MODES) {
      if (exclusiveMode !== mode && isModeActiveInAnySession(exclusiveMode, cwd)) {
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
 * @param sessionId - Optional session ID to check session-scoped state
 * @returns Array of mode statuses
 */
export function getAllModeStatuses(cwd: string, sessionId?: string): ModeStatus[] {
  return (Object.keys(MODE_CONFIGS) as ExecutionMode[]).map(mode => ({
    mode,
    active: isModeActive(mode, cwd, sessionId),
    stateFilePath: getStateFilePath(cwd, mode, sessionId)
  }));
}

/**
 * Clear all state files for a mode
 *
 * Deletes:
 * - Local state file (.omc/state/{mode}-state.json)
 * - Session-scoped state file if sessionId provided
 * - Local marker file if applicable
 * - Global state file if applicable (~/.claude/{mode}-state.json)
 *
 * @returns true if all files were deleted successfully (or didn't exist)
 */
export function clearModeState(mode: ExecutionMode, cwd: string, sessionId?: string): boolean {
  const config = MODE_CONFIGS[mode];
  let success = true;

  // Delete session-scoped state file if sessionId provided
  if (sessionId && !config.isSqlite) {
    const sessionStateFile = resolveSessionStatePath(mode, sessionId, cwd);
    if (existsSync(sessionStateFile)) {
      try {
        unlinkSync(sessionStateFile);
      } catch {
        success = false;
      }
    }

    // Session-scoped clear should not touch legacy/marker files
    return success;
  }

  // Delete local state file (legacy path)
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

  // Note: Global state files are no longer used (local-only state migration)

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

  // Also clean up session directories
  try {
    const sessionIds = listSessionIds(cwd);
    for (const sid of sessionIds) {
      const sessionDir = getSessionStateDir(sid, cwd);
      if (existsSync(sessionDir)) {
        rmSync(sessionDir, { recursive: true, force: true });
      }
    }
  } catch {
    success = false;
  }

  return success;
}

/**
 * Check if a mode is active in any session
 *
 * @param mode - The mode to check
 * @param cwd - Working directory
 * @returns true if the mode is active in any session or legacy path
 */
export function isModeActiveInAnySession(mode: ExecutionMode, cwd: string): boolean {
  const config = MODE_CONFIGS[mode];

  if (config.isSqlite) {
    return isSqliteModeActive(cwd, mode);
  }

  // Check legacy path first
  if (isJsonModeActive(cwd, mode)) {
    return true;
  }

  // Scan all session dirs
  const sessionIds = listSessionIds(cwd);
  for (const sid of sessionIds) {
    if (isJsonModeActive(cwd, mode, sid)) {
      return true;
    }
  }

  return false;
}

/**
 * Get all session IDs that have a specific mode active
 *
 * @param mode - The mode to check
 * @param cwd - Working directory
 * @returns Array of session IDs with this mode active
 */
export function getActiveSessionsForMode(mode: ExecutionMode, cwd: string): string[] {
  const config = MODE_CONFIGS[mode];

  if (config.isSqlite) {
    return [];
  }

  const sessionIds = listSessionIds(cwd);
  return sessionIds.filter(sid => isJsonModeActive(cwd, mode, sid));
}

/**
 * Clear stale session directories
 *
 * Removes session directories that are either empty or have no recent activity.
 *
 * @param cwd - Working directory
 * @param maxAgeMs - Maximum age in milliseconds (default: 24 hours)
 * @returns Array of removed session IDs
 */
export function clearStaleSessionDirs(cwd: string, maxAgeMs: number = 24 * 60 * 60 * 1000): string[] {
  const sessionsDir = join(cwd, '.omc', 'state', 'sessions');
  if (!existsSync(sessionsDir)) {
    return [];
  }

  const removed: string[] = [];
  const sessionIds = listSessionIds(cwd);

  for (const sid of sessionIds) {
    const sessionDir = getSessionStateDir(sid, cwd);
    try {
      const files = readdirSync(sessionDir);

      // Remove empty directories
      if (files.length === 0) {
        rmdirSync(sessionDir);
        removed.push(sid);
        continue;
      }

      // Check modification time of any state file
      let newest = 0;
      for (const f of files) {
        const stat = statSync(join(sessionDir, f));
        if (stat.mtimeMs > newest) {
          newest = stat.mtimeMs;
        }
      }

      // Remove if stale
      if (Date.now() - newest > maxAgeMs) {
        rmSync(sessionDir, { recursive: true, force: true });
        removed.push(sid);
      }
    } catch {
      // Skip on error
    }
  }

  return removed;
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

/**
 * Force remove a marker file regardless of staleness
 * Used for manual cleanup by users
 *
 * @param mode - The mode to clean up
 * @param cwd - Working directory
 */
export function forceRemoveMarker(mode: ExecutionMode, cwd: string): boolean {
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
    console.error(`Failed to force remove marker file for ${mode}:`, error);
    return false;
  }
}
