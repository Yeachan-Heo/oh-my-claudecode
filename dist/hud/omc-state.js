/**
 * OMC HUD - State Readers
 *
 * Read ralph, ultrawork, and PRD state from existing OMC files.
 * These are read-only functions that don't modify the state files.
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import { getOmcRoot } from '../lib/worktree-paths.js';
/**
 * Maximum age for state files to be considered "active".
 * Files older than this are treated as stale/abandoned.
 */
const MAX_STATE_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
/**
 * Check if a state file is stale based on file modification time.
 */
function isStateFileStale(filePath) {
    try {
        const stat = statSync(filePath);
        const age = Date.now() - stat.mtimeMs;
        return age > MAX_STATE_AGE_MS;
    }
    catch {
        return true; // Treat errors as stale
    }
}
/**
 * Resolve state file path with fallback chain:
 * 1. Session-scoped paths (.omc/state/sessions/{id}/{filename}) - newest first
 * 2. Standard path (.omc/state/{filename})
 * 3. Legacy path (.omc/{filename})
 *
 * Returns the most recently modified matching path, or null if none found.
 * This ensures the HUD displays state from any active session (Issue #456).
 */
function resolveStatePath(directory, filename) {
    let bestPath = null;
    let bestMtime = 0;
    // Check session-scoped paths first (most likely location after Issue #456 fix)
    const omcRoot = getOmcRoot(directory);
    const sessionsDir = join(omcRoot, 'state', 'sessions');
    if (existsSync(sessionsDir)) {
        try {
            const entries = readdirSync(sessionsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const sessionFile = join(sessionsDir, entry.name, filename);
                if (existsSync(sessionFile)) {
                    try {
                        const mtime = statSync(sessionFile).mtimeMs;
                        if (mtime > bestMtime) {
                            bestMtime = mtime;
                            bestPath = sessionFile;
                        }
                    }
                    catch {
                        // Skip on stat error
                    }
                }
            }
        }
        catch {
            // Ignore readdir errors
        }
    }
    // Check standard path
    const newPath = join(omcRoot, 'state', filename);
    if (existsSync(newPath)) {
        try {
            const mtime = statSync(newPath).mtimeMs;
            if (mtime > bestMtime) {
                bestMtime = mtime;
                bestPath = newPath;
            }
        }
        catch {
            if (!bestPath)
                bestPath = newPath;
        }
    }
    // Check legacy path
    const legacyPath = join(omcRoot, filename);
    if (existsSync(legacyPath)) {
        try {
            const mtime = statSync(legacyPath).mtimeMs;
            if (mtime > bestMtime) {
                bestPath = legacyPath;
            }
        }
        catch {
            if (!bestPath)
                bestPath = legacyPath;
        }
    }
    return bestPath;
}
/**
 * Read Ralph Loop state for HUD display.
 * Returns null if no state file exists or on error.
 */
export function readRalphStateForHud(directory) {
    const stateFile = resolveStatePath(directory, 'ralph-state.json');
    if (!stateFile) {
        return null;
    }
    // Check for stale state file (abandoned session)
    if (isStateFileStale(stateFile)) {
        return null;
    }
    try {
        const content = readFileSync(stateFile, 'utf-8');
        const state = JSON.parse(content);
        if (!state.active) {
            return null;
        }
        return {
            active: state.active,
            iteration: state.iteration,
            maxIterations: state.max_iterations,
            prdMode: state.prd_mode,
            currentStoryId: state.current_story_id,
        };
    }
    catch {
        return null;
    }
}
/**
 * Read Ultrawork state for HUD display.
 * Checks only local .omc/state location.
 */
export function readUltraworkStateForHud(directory) {
    // Check local state only (with new path fallback)
    const localFile = resolveStatePath(directory, 'ultrawork-state.json');
    if (!localFile || isStateFileStale(localFile)) {
        return null;
    }
    try {
        const content = readFileSync(localFile, 'utf-8');
        const state = JSON.parse(content);
        if (!state.active) {
            return null;
        }
        return {
            active: state.active,
            reinforcementCount: state.reinforcement_count,
        };
    }
    catch {
        return null;
    }
}
/**
 * Read PRD state for HUD display.
 * Checks both root prd.json and .omc/prd.json.
 */
export function readPrdStateForHud(directory) {
    // Check root first
    let prdPath = join(directory, 'prd.json');
    if (!existsSync(prdPath)) {
        // Check .omc
        prdPath = join(getOmcRoot(directory), 'prd.json');
        if (!existsSync(prdPath)) {
            return null;
        }
    }
    try {
        const content = readFileSync(prdPath, 'utf-8');
        const prd = JSON.parse(content);
        if (!prd.userStories || !Array.isArray(prd.userStories)) {
            return null;
        }
        const stories = prd.userStories;
        const completed = stories.filter((s) => s.passes).length;
        const total = stories.length;
        // Find current story (first incomplete, sorted by priority)
        const incomplete = stories
            .filter((s) => !s.passes)
            .sort((a, b) => a.priority - b.priority);
        return {
            currentStoryId: incomplete[0]?.id || null,
            completed,
            total,
        };
    }
    catch {
        return null;
    }
}
/**
 * Read Autopilot state for HUD display.
 * Returns shape matching AutopilotStateForHud from elements/autopilot.ts.
 */
export function readAutopilotStateForHud(directory) {
    const stateFile = resolveStatePath(directory, 'autopilot-state.json');
    if (!stateFile) {
        return null;
    }
    // Check for stale state file (abandoned session)
    if (isStateFileStale(stateFile)) {
        return null;
    }
    try {
        const content = readFileSync(stateFile, 'utf-8');
        const state = JSON.parse(content);
        if (!state.active) {
            return null;
        }
        return {
            active: state.active,
            phase: state.phase,
            iteration: state.iteration,
            maxIterations: state.max_iterations,
            tasksCompleted: state.execution?.tasks_completed,
            tasksTotal: state.execution?.tasks_total,
            filesCreated: state.execution?.files_created?.length
        };
    }
    catch {
        return null;
    }
}
// ============================================================================
// Combined State Check
// ============================================================================
/**
 * Check if any OMC mode is currently active
 */
export function isAnyModeActive(directory) {
    const ralph = readRalphStateForHud(directory);
    const ultrawork = readUltraworkStateForHud(directory);
    const autopilot = readAutopilotStateForHud(directory);
    return (ralph?.active ?? false) || (ultrawork?.active ?? false) || (autopilot?.active ?? false);
}
/**
 * Get active skill names for display
 */
export function getActiveSkills(directory) {
    const skills = [];
    const autopilot = readAutopilotStateForHud(directory);
    if (autopilot?.active) {
        skills.push('autopilot');
    }
    const ralph = readRalphStateForHud(directory);
    if (ralph?.active) {
        skills.push('ralph');
    }
    const ultrawork = readUltraworkStateForHud(directory);
    if (ultrawork?.active) {
        skills.push('ultrawork');
    }
    return skills;
}
//# sourceMappingURL=omc-state.js.map