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
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync, rmdirSync, rmSync, } from "fs";
import { canClearStateForSession, clearStateFileLockedIf, writeStateFileLocked } from "../../lib/mode-state-io.js";
import { join, dirname } from "path";
import { listSessionIds, resolveSessionStatePath, getSessionStateDir, getOmcRoot, } from "../../lib/worktree-paths.js";
import { MODE_STATE_FILE_MAP, MODE_NAMES } from "../../lib/mode-names.js";
/**
 * Mode configuration registry
 *
 * Maps each mode to its state file location and detection method.
 * All paths are relative to .omc/state/ directory.
 */
const MODE_CONFIGS = {
    [MODE_NAMES.AUTOPILOT]: {
        name: "Autopilot",
        stateFile: MODE_STATE_FILE_MAP[MODE_NAMES.AUTOPILOT],
        activeProperty: "active",
    },
    [MODE_NAMES.AUTORESEARCH]: {
        name: "Autoresearch",
        stateFile: MODE_STATE_FILE_MAP[MODE_NAMES.AUTORESEARCH],
        activeProperty: "active",
        hasGlobalState: false,
    },
    [MODE_NAMES.TEAM]: {
        name: "Team",
        stateFile: MODE_STATE_FILE_MAP[MODE_NAMES.TEAM],
        activeProperty: "active",
        hasGlobalState: false,
    },
    [MODE_NAMES.RALPH]: {
        name: "Ralph",
        stateFile: MODE_STATE_FILE_MAP[MODE_NAMES.RALPH],
        markerFile: "ralph-verification.json",
        activeProperty: "active",
        hasGlobalState: false,
    },
    [MODE_NAMES.ULTRAWORK]: {
        name: "Ultrawork",
        stateFile: MODE_STATE_FILE_MAP[MODE_NAMES.ULTRAWORK],
        activeProperty: "active",
        hasGlobalState: false,
    },
    [MODE_NAMES.ULTRAQA]: {
        name: "UltraQA",
        stateFile: MODE_STATE_FILE_MAP[MODE_NAMES.ULTRAQA],
        activeProperty: "active",
    },
    [MODE_NAMES.DEEP_INTERVIEW]: {
        name: "Deep Interview",
        stateFile: MODE_STATE_FILE_MAP[MODE_NAMES.DEEP_INTERVIEW],
        activeProperty: "active",
    },
    [MODE_NAMES.MERGE_READINESS]: {
        name: "Merge Readiness",
        stateFile: MODE_STATE_FILE_MAP[MODE_NAMES.MERGE_READINESS],
        activeProperty: "active",
    },
    [MODE_NAMES.SELF_IMPROVE]: {
        name: "Self Improve",
        stateFile: MODE_STATE_FILE_MAP[MODE_NAMES.SELF_IMPROVE],
        activeProperty: "active",
    },
};
// Export for use in other modules
export { MODE_CONFIGS };
/**
 * Modes that are mutually exclusive (cannot run concurrently)
 */
const EXCLUSIVE_MODES = [MODE_NAMES.AUTOPILOT, MODE_NAMES.AUTORESEARCH];
/**
 * Get the state directory path
 */
export function getStateDir(cwd) {
    return join(getOmcRoot(cwd), "state");
}
/**
 * Ensure the state directory exists
 */
export function ensureStateDir(cwd) {
    const stateDir = getStateDir(cwd);
    mkdirSync(stateDir, { recursive: true });
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
 * Workflow-slot tombstone TTL. Matches `WORKFLOW_TOMBSTONE_TTL_MS` in
 * `src/hooks/skill-state/index.ts` — kept local here to preserve the
 * "mode-registry uses ONLY file-based detection" invariant (no imports from
 * hook modules that themselves depend on the registry).
 */
const WORKFLOW_SLOT_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Consult the session-local workflow ledger for a tombstoned slot.
 *
 * Returns `true` when the workflow ledger records the mode as tombstoned
 * (soft-completed) AND the tombstone has not yet TTL-expired. Used to veto
 * stale mode files from crashed sessions that never tore their own state down.
 *
 * Returns `false` for any shape we can't parse, any missing file, any live
 * slot, and any slot whose tombstone already expired — so the legacy
 * mode-file fallback remains authoritative whenever the ledger is silent.
 */
function isWorkflowSlotTombstonedForMode(cwd, mode, sessionId, now = Date.now()) {
    try {
        const ledgerPath = sessionId
            ? resolveSessionStatePath("skill-active", sessionId, cwd)
            : join(getStateDir(cwd), "skill-active-state.json");
        if (!existsSync(ledgerPath))
            return false;
        const raw = JSON.parse(readFileSync(ledgerPath, "utf-8"));
        const slots = raw.active_skills;
        if (!slots || typeof slots !== "object")
            return false;
        const slot = slots[mode];
        if (!slot || typeof slot !== "object")
            return false;
        const completedAt = slot.completed_at;
        if (typeof completedAt !== "string" || completedAt.length === 0)
            return false;
        const tombstonedAt = new Date(completedAt).getTime();
        if (!Number.isFinite(tombstonedAt))
            return false;
        return now - tombstonedAt < WORKFLOW_SLOT_TOMBSTONE_TTL_MS;
    }
    catch {
        return false;
    }
}
/**
 * Check if a JSON-based mode is active by reading its state file.
 *
 * Workflow-slot override: when the session workflow ledger records this mode
 * as tombstoned (soft-completed), the stale per-mode state file is ignored so
 * a fresh invocation can proceed without clearing artifacts manually. Live
 * slots and absent slots both defer to the per-mode state file (legacy
 * fallback preserved during the transition window).
 */
function isJsonModeActive(cwd, mode, sessionId) {
    if (isWorkflowSlotTombstonedForMode(cwd, mode, sessionId)) {
        return false;
    }
    const config = MODE_CONFIGS[mode];
    // When sessionId is provided, ONLY check session-scoped path — no legacy fallback.
    // This prevents cross-session state leakage where one session's legacy file
    // could cause another session to see mode as active.
    if (sessionId) {
        const sessionStateFile = resolveSessionStatePath(mode, sessionId, cwd);
        try {
            const content = readFileSync(sessionStateFile, "utf-8");
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
        catch (error) {
            if (error.code === "ENOENT") {
                return false;
            }
            return false;
        }
    }
    // No sessionId: check legacy shared path (backward compat)
    const stateFile = getStateFilePath(cwd, mode);
    try {
        const content = readFileSync(stateFile, "utf-8");
        const state = JSON.parse(content);
        if (config.activeProperty) {
            return state[config.activeProperty] === true;
        }
        // Default: file existence means active
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return false;
        }
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
            if (exclusiveMode !== mode &&
                isModeActiveInAnySession(exclusiveMode, cwd)) {
                const config = MODE_CONFIGS[exclusiveMode];
                return {
                    allowed: false,
                    blockedBy: exclusiveMode,
                    message: `Cannot start ${MODE_CONFIGS[mode].name} while ${config.name} is active. Cancel ${config.name} first with /oh-my-claudecode:cancel.`,
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
    return Object.keys(MODE_CONFIGS).map((mode) => ({
        mode,
        active: isModeActive(mode, cwd, sessionId),
        stateFilePath: getStateFilePath(cwd, mode, sessionId),
    }));
}
function clearObservedJsonFile(filePath, predicate = () => true) {
    if (!existsSync(filePath))
        return true;
    let observed;
    try {
        observed = JSON.parse(readFileSync(filePath, "utf-8"));
    }
    catch {
        return false;
    }
    if (!predicate(observed))
        return true;
    const snapshot = JSON.stringify(observed);
    return clearStateFileLockedIf(filePath, (current) => predicate(current) && JSON.stringify(current) === snapshot) !== 'failed';
}
function readJsonSnapshot(filePath) {
    try {
        const state = JSON.parse(readFileSync(filePath, "utf-8"));
        return { state, snapshot: JSON.stringify(state) };
    }
    catch {
        return null;
    }
}
function clearDiscoveredJsonFile(filePath, observed, predicate = () => true) {
    if (!observed) {
        const result = clearStateFileLockedIf(filePath, predicate);
        return result !== 'failed' && !(result === 'skipped' && existsSync(filePath));
    }
    if (!predicate(observed.state))
        return true;
    const result = clearStateFileLockedIf(filePath, (current) => predicate(current) && JSON.stringify(current) === observed.snapshot);
    return result !== 'failed' && !(result === 'skipped' && existsSync(filePath));
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
export function clearModeState(mode, cwd, sessionId, expectedState) {
    const config = MODE_CONFIGS[mode];
    let success = true;
    const markerFile = getMarkerFilePath(cwd, mode);
    const isSessionScopedClear = Boolean(sessionId);
    const markerSnapshot = markerFile ? readJsonSnapshot(markerFile) : null;
    const sessionMarkerFile = isSessionScopedClear && sessionId && config.markerFile
        ? resolveSessionStatePath(config.markerFile.replace(/\.json$/i, ""), sessionId, cwd)
        : null;
    const sessionMarkerSnapshot = sessionMarkerFile ? readJsonSnapshot(sessionMarkerFile) : null;
    // Delete session-scoped state file if sessionId provided
    if (isSessionScopedClear && sessionId) {
        const sessionStateFile = resolveSessionStatePath(mode, sessionId, cwd);
        try {
            const result = clearStateFileLockedIf(sessionStateFile, (current) => canClearStateForSession(current, sessionId) && (!expectedState || JSON.stringify(current) === JSON.stringify(expectedState)));
            if (result === 'failed' || (result === 'skipped' && existsSync(sessionStateFile)))
                throw new Error("state mutation lock unavailable");
        }
        catch (err) {
            if (err.code !== "ENOENT") {
                success = false;
            }
        }
        // Clear session-scoped marker artifacts (e.g., ralph-verification-state.json).
        // Keep legacy/shared marker files untouched for isolation.
        if (sessionMarkerFile) {
            try {
                if (!clearDiscoveredJsonFile(sessionMarkerFile, sessionMarkerSnapshot, (current) => canClearStateForSession(current, sessionId)))
                    throw new Error("state mutation lock unavailable");
            }
            catch (err) {
                if (err.code !== "ENOENT") {
                    success = false;
                }
            }
        }
        // Also try cleaning legacy marker for this mode (best-effort).
        // Keep isolation by deleting only unowned markers or markers owned by this session.
        if (markerFile) {
            try {
                const markerRaw = JSON.parse(readFileSync(markerFile, "utf-8"));
                const markerSessionId = markerRaw.session_id ?? markerRaw.sessionId;
                if (!markerSessionId || markerSessionId === sessionId) {
                    try {
                        if (!clearDiscoveredJsonFile(markerFile, markerSnapshot, (current) => canClearStateForSession(current, sessionId)))
                            throw new Error("state mutation lock unavailable");
                    }
                    catch (err) {
                        if (err.code !== "ENOENT") {
                            success = false;
                        }
                    }
                }
            }
            catch {
                // Malformed or unreadable session-scoped markers fail closed.
                try {
                    if (!clearDiscoveredJsonFile(markerFile, markerSnapshot, (current) => canClearStateForSession(current, sessionId)))
                        throw new Error("state mutation lock unavailable");
                }
                catch (err) {
                    if (err.code !== "ENOENT") {
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
            const result = clearStateFileLockedIf(stateFile, (current) => !expectedState || JSON.stringify(current) === JSON.stringify(expectedState));
            if (result === 'failed' || (result === 'skipped' && existsSync(stateFile)))
                throw new Error("state mutation lock unavailable");
        }
        catch (err) {
            if (err.code !== "ENOENT") {
                success = false;
            }
        }
    }
    // Session-scoped marker paths were handled once above from their original snapshots.
    if (markerFile && !isSessionScopedClear) {
        try {
            if (!clearDiscoveredJsonFile(markerFile, markerSnapshot))
                throw new Error("state mutation lock unavailable");
        }
        catch (err) {
            if (err.code !== "ENOENT")
                success = false;
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
    const skillStatePath = join(getStateDir(cwd), "skill-active-state.json");
    try {
        if (!clearObservedJsonFile(skillStatePath))
            throw new Error("state mutation lock unavailable");
    }
    catch (err) {
        if (err.code !== "ENOENT") {
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
    return sessionIds.filter((sid) => isJsonModeActive(cwd, mode, sid));
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
        mkdirSync(dir, { recursive: true });
        if (!writeStateFileLocked(markerPath, {
            mode,
            startedAt: new Date().toISOString(),
            ...metadata,
        }))
            return false;
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
        if (!clearObservedJsonFile(markerPath))
            return false;
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return true;
        }
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
    if (!markerPath) {
        return null;
    }
    try {
        const content = readFileSync(markerPath, "utf-8");
        return JSON.parse(content);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }
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
        if (!clearObservedJsonFile(markerPath))
            return false;
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return true;
        }
        console.error(`Failed to force remove marker file for ${mode}:`, error);
        return false;
    }
}
//# sourceMappingURL=index.js.map