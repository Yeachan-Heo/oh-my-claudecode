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
import { existsSync, readFileSync, unlinkSync, mkdirSync, readdirSync, statSync, rmdirSync, rmSync } from 'fs';
import { atomicWriteJsonSync } from '../../lib/atomic-write.js';
import { join, dirname } from 'path';
import { listSessionIds, resolveSessionStatePath, getSessionStateDir, getOmcRoot } from '../../lib/worktree-paths.js';
import { MODE_STATE_FILE_MAP, MODE_NAMES } from '../../lib/mode-names.js';
/**
 * Mode configuration registry
 *
 * Maps each mode to its state file location and detection method.
 * All paths are relative to .omc/state/ directory.
 */
const MODE_CONFIGS = {
    [MODE_NAMES.AUTOPILOT]: {
        name: 'Autopilot',
        stateFile: MODE_STATE_FILE_MAP[MODE_NAMES.AUTOPILOT],
        activeProperty: 'active'
    },
    [MODE_NAMES.TEAM]: {
        name: 'Team',
        stateFile: MODE_STATE_FILE_MAP[MODE_NAMES.TEAM],
        activeProperty: 'active',
        hasGlobalState: false
    },
    [MODE_NAMES.RALPH]: {
        name: 'Ralph',
        stateFile: MODE_STATE_FILE_MAP[MODE_NAMES.RALPH],
        markerFile: 'ralph-verification.json',
        activeProperty: 'active',
        hasGlobalState: false
    },
    [MODE_NAMES.ULTRAWORK]: {
        name: 'Ultrawork',
        stateFile: MODE_STATE_FILE_MAP[MODE_NAMES.ULTRAWORK],
        activeProperty: 'active',
        hasGlobalState: false
    },
    [MODE_NAMES.ULTRAQA]: {
        name: 'UltraQA',
        stateFile: MODE_STATE_FILE_MAP[MODE_NAMES.ULTRAQA],
        activeProperty: 'active'
    }
};
// Export for use in other modules
export { MODE_CONFIGS };
/**
 * Modes that are mutually exclusive (cannot run concurrently)
 */
const EXCLUSIVE_MODES = [MODE_NAMES.AUTOPILOT];
/**
 * Get the state directory path
 */
export function getStateDir(cwd) {
    return join(getOmcRoot(cwd), 'state');
}
/**
 * Ensure the state directory exists
 */
export function ensureStateDir(cwd) {
    const stateDir = getStateDir(cwd);
    if (!existsSync(stateDir)) {
        mkdirSync(stateDir, { recursive: true });
    }
}
/**
 * Get the full path to a mode's state file
 */
export function getStateFilePath(cwd, mode, sessionId) {
    const config = MODE_CONFIGS[mode];
    if (sessionId) {
        return resolveSessionStatePath(mode, sessionId, cwd);
    }
    return join(getStateDir(cwd), config.stateFile);
}
/**
 * Get the full path to a mode's marker file
 */
export function getMarkerFilePath(cwd, mode) {
    const config = MODE_CONFIGS[mode];
    if (!config.markerFile)
        return null;
    return join(getStateDir(cwd), config.markerFile);
}
/**
 * Get the global state file path (in ~/.claude/) for modes that support it
 * @deprecated Global state is no longer supported. All modes use local-only state in .omc/state/
 * @returns Always returns null
 */
export function getGlobalStateFilePath(_mode) {
    // Global state is deprecated - all modes now use local-only state
    return null;
}
/**
 * Check if a JSON-based mode is active by reading its state file
 */
function isJsonModeActive(cwd, mode, sessionId) {
    const config = MODE_CONFIGS[mode];
    // When sessionId is provided, ONLY check session-scoped path — no legacy fallback.
    // This prevents cross-session state leakage where one session's legacy file
    // could cause another session to see mode as active.
    if (sessionId) {
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
        }
        catch {
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
    }
    catch {
        return false;
    }
}
/**
 * Check if a specific mode is currently active
 *
 * @param mode - The mode to check
 * @param cwd - Working directory
 * @param sessionId - Optional session ID to check session-scoped state
 * @returns true if the mode is active
 */
export function isModeActive(mode, cwd, sessionId) {
    return isJsonModeActive(cwd, mode, sessionId);
}
/**
 * Check if a mode has active state (file exists)
 * @param sessionId - When provided, checks session-scoped path only (no legacy fallback)
 */
export function hasModeState(cwd, mode, sessionId) {
    const stateFile = getStateFilePath(cwd, mode, sessionId);
    return existsSync(stateFile);
}
/**
 * Get all modes that currently have state files
 */
export function getActiveModes(cwd, sessionId) {
    const modes = [];
    for (const mode of Object.keys(MODE_CONFIGS)) {
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
export function isAnyModeActive(cwd) {
    return getActiveModes(cwd).length > 0;
}
/**
 * Get the currently active exclusive mode (if any)
 *
 * @param cwd - Working directory
 * @returns The active mode or null
 */
export function getActiveExclusiveMode(cwd) {
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
export function canStartMode(mode, cwd) {
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
export function getAllModeStatuses(cwd, sessionId) {
    return Object.keys(MODE_CONFIGS).map(mode => ({
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
export function clearModeState(mode, cwd, sessionId) {
    const config = MODE_CONFIGS[mode];
    let success = true;
    const markerFile = getMarkerFilePath(cwd, mode);
    const isSessionScopedClear = Boolean(sessionId);
    // Delete session-scoped state file if sessionId provided
    if (isSessionScopedClear && sessionId) {
        const sessionStateFile = resolveSessionStatePath(mode, sessionId, cwd);
        try {
            unlinkSync(sessionStateFile);
        }
        catch (err) {
            if (err.code !== 'ENOENT') {
                success = false;
            }
        }
        // Clear session-scoped marker artifacts (e.g., ralph-verification-state.json).
        // Keep legacy/shared marker files untouched for isolation.
        if (config.markerFile) {
            const markerStateName = config.markerFile.replace(/\.json$/i, '');
            const sessionMarkerFile = resolveSessionStatePath(markerStateName, sessionId, cwd);
            try {
                unlinkSync(sessionMarkerFile);
            }
            catch (err) {
                if (err.code !== 'ENOENT') {
                    success = false;
                }
            }
        }
        // Also try cleaning legacy marker for this mode (best-effort).
        // Keep isolation by deleting only unowned markers or markers owned by this session.
        if (markerFile) {
            try {
                const markerRaw = JSON.parse(readFileSync(markerFile, 'utf-8'));
                const markerSessionId = markerRaw.session_id ?? markerRaw.sessionId;
                if (!markerSessionId || markerSessionId === sessionId) {
                    try {
                        unlinkSync(markerFile);
                    }
                    catch (err) {
                        if (err.code !== 'ENOENT') {
                            success = false;
                        }
                    }
                }
            }
            catch {
                // If marker is not JSON (or unreadable), best-effort delete for cleanup.
                try {
                    unlinkSync(markerFile);
                }
                catch (err) {
                    if (err.code !== 'ENOENT') {
                        success = false;
                    }
                }
            }
        }
    }
    // Delete local state file (legacy path) for non-session clears
    const stateFile = getStateFilePath(cwd, mode);
    if (!isSessionScopedClear) {
        try {
            unlinkSync(stateFile);
        }
        catch (err) {
            if (err.code !== 'ENOENT') {
                success = false;
            }
        }
    }
    // Delete marker file if applicable, but respect ownership when session-scoped.
    if (markerFile) {
        if (isSessionScopedClear) {
            // Only delete if the marker is unowned or owned by this session.
            try {
                const markerRaw = JSON.parse(readFileSync(markerFile, 'utf-8'));
                const markerSessionId = markerRaw.session_id ?? markerRaw.sessionId;
                if (!markerSessionId || markerSessionId === sessionId) {
                    try {
                        unlinkSync(markerFile);
                    }
                    catch (err) {
                        if (err.code !== 'ENOENT') {
                            success = false;
                        }
                    }
                }
            }
            catch {
                // Marker is not valid JSON or unreadable — best-effort delete for cleanup.
                try {
                    unlinkSync(markerFile);
                }
                catch (err) {
                    if (err.code !== 'ENOENT') {
                        success = false;
                    }
                }
            }
        }
        else {
            try {
                unlinkSync(markerFile);
            }
            catch (err) {
                if (err.code !== 'ENOENT') {
                    success = false;
                }
            }
        }
    }
    // Note: Global state files are no longer used (local-only state migration)
    return success;
}
/**
 * Clear all mode states (force clear)
 */
export function clearAllModeStates(cwd) {
    let success = true;
    for (const mode of Object.keys(MODE_CONFIGS)) {
        if (!clearModeState(mode, cwd)) {
            success = false;
        }
    }
    // Clear skill-active-state.json (issue #1033)
    const skillStatePath = join(getStateDir(cwd), 'skill-active-state.json');
    try {
        unlinkSync(skillStatePath);
    }
    catch (err) {
        if (err.code !== 'ENOENT') {
            success = false;
        }
    }
    // Also clean up session directories
    try {
        const sessionIds = listSessionIds(cwd);
        for (const sid of sessionIds) {
            const sessionDir = getSessionStateDir(sid, cwd);
            rmSync(sessionDir, { recursive: true, force: true });
        }
    }
    catch {
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
export function isModeActiveInAnySession(mode, cwd) {
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
export function getActiveSessionsForMode(mode, cwd) {
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
export function clearStaleSessionDirs(cwd, maxAgeMs = 24 * 60 * 60 * 1000) {
    const sessionsDir = join(getOmcRoot(cwd), 'state', 'sessions');
    if (!existsSync(sessionsDir)) {
        return [];
    }
    const removed = [];
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
        }
        catch {
            // Skip on error
        }
    }
    return removed;
}
// ============================================================================
// MARKER FILE MANAGEMENT
// ============================================================================
/**
 * Create a marker file to indicate a mode is active
 *
 * @param mode - The mode being started
 * @param cwd - Working directory
 * @param metadata - Optional metadata to store in marker
 */
export function createModeMarker(mode, cwd, metadata) {
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
        atomicWriteJsonSync(markerPath, {
            mode,
            startedAt: new Date().toISOString(),
            ...metadata
        });
        return true;
    }
    catch (error) {
        console.error(`Failed to create marker file for ${mode}:`, error);
        return false;
    }
}
/**
 * Remove a marker file to indicate a mode has stopped
 *
 * @param mode - The mode being stopped
 * @param cwd - Working directory
 */
export function removeModeMarker(mode, cwd) {
    const markerPath = getMarkerFilePath(cwd, mode);
    if (!markerPath) {
        return true; // No marker to remove
    }
    try {
        if (existsSync(markerPath)) {
            unlinkSync(markerPath);
        }
        return true;
    }
    catch (error) {
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
export function readModeMarker(mode, cwd) {
    const markerPath = getMarkerFilePath(cwd, mode);
    if (!markerPath || !existsSync(markerPath)) {
        return null;
    }
    try {
        const content = readFileSync(markerPath, 'utf-8');
        return JSON.parse(content);
    }
    catch {
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
export function forceRemoveMarker(mode, cwd) {
    const markerPath = getMarkerFilePath(cwd, mode);
    if (!markerPath) {
        return true; // No marker to remove
    }
    try {
        if (existsSync(markerPath)) {
            unlinkSync(markerPath);
        }
        return true;
    }
    catch (error) {
        console.error(`Failed to force remove marker file for ${mode}:`, error);
        return false;
    }
}
//# sourceMappingURL=index.js.map