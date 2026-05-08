/**
 * Ultrawork State Management
 *
 * Manages persistent ultrawork mode state across sessions.
 * When ultrawork is activated and todos remain incomplete,
 * this module ensures the mode persists until all work is done.
 */
import { readFileSync, unlinkSync } from "fs";
import { writeModeState, readModeState } from "../../lib/mode-state-io.js";
import { resolveStatePath, resolveSessionStatePath, } from "../../lib/worktree-paths.js";
const _DEFAULT_STATE = {
    active: false,
    started_at: "",
    original_prompt: "",
    reinforcement_count: 0,
    last_checked_at: "",
};
const ULTRAWORK_OBJECTIVE_MAX_CHARS = 140;
function formatConciseObjective(value) {
    if (typeof value !== "string")
        return "";
    const compact = value.replace(/\s+/g, " ").trim();
    if (!compact)
        return "";
    const chars = [...compact];
    if (chars.length <= ULTRAWORK_OBJECTIVE_MAX_CHARS)
        return compact;
    return `${chars.slice(0, ULTRAWORK_OBJECTIVE_MAX_CHARS).join("").trimEnd()}…`;
}
function getLiveUltraworkObjective(state) {
    return formatConciseObjective(state.current_objective ?? state.task_summary);
}
/**
 * Get the state file path for Ultrawork (used only by deactivateUltrawork for ghost-legacy cleanup)
 */
function getStateFilePath(directory, sessionId) {
    const baseDir = directory || process.cwd();
    if (sessionId) {
        return resolveSessionStatePath("ultrawork", sessionId, baseDir);
    }
    return resolveStatePath("ultrawork", baseDir);
}
/**
 * Read Ultrawork state from disk (local only)
 *
 * When sessionId is provided, ONLY reads session-scoped file — no legacy fallback.
 * This prevents cross-session state leakage.
 */
export function readUltraworkState(directory, sessionId) {
    const state = readModeState("ultrawork", directory, sessionId);
    // Validate session identity: state must belong to this session
    if (state &&
        sessionId &&
        state.session_id &&
        state.session_id !== sessionId) {
        return null;
    }
    return state;
}
/**
 * Write Ultrawork state to disk (local only)
 */
export function writeUltraworkState(state, directory, sessionId) {
    return writeModeState("ultrawork", state, directory, sessionId);
}
/**
 * Activate ultrawork mode
 */
export function activateUltrawork(prompt, sessionId, directory, linkedToRalph) {
    const state = {
        active: true,
        started_at: new Date().toISOString(),
        original_prompt: prompt,
        session_id: sessionId,
        project_path: directory || process.cwd(),
        reinforcement_count: 0,
        last_checked_at: new Date().toISOString(),
        linked_to_ralph: linkedToRalph,
    };
    return writeUltraworkState(state, directory, sessionId);
}
/**
 * Deactivate ultrawork mode
 *
 * When sessionId is provided:
 * 1. Deletes the session-scoped state file
 * 2. Cleans up ghost legacy files that belong to this session (or have no session_id)
 *    to prevent stale legacy files from leaking into other sessions.
 */
export function deactivateUltrawork(directory, sessionId) {
    let success = true;
    // Delete session-scoped state file
    const stateFile = getStateFilePath(directory, sessionId);
    try {
        unlinkSync(stateFile);
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            success = false;
        }
    }
    // Ghost legacy cleanup: if sessionId provided, also remove legacy file
    // if it belongs to this session or has no session_id (orphaned)
    if (sessionId) {
        const legacyFile = getStateFilePath(directory); // no sessionId = legacy path
        try {
            const content = readFileSync(legacyFile, "utf-8");
            const legacyState = JSON.parse(content);
            // Only remove if it belongs to this session or is unowned (no session_id)
            if (!legacyState.session_id || legacyState.session_id === sessionId) {
                try {
                    unlinkSync(legacyFile);
                }
                catch (error) {
                    if (error.code !== "ENOENT") {
                        throw error;
                    }
                }
            }
            // Do NOT delete another session's legacy data
        }
        catch {
            // If we can't read/parse, leave it alone
        }
    }
    return success;
}
/**
 * Increment reinforcement count (called when mode is reinforced on stop)
 */
export function incrementReinforcement(directory, sessionId) {
    const state = readUltraworkState(directory, sessionId);
    if (!state || !state.active) {
        return null;
    }
    state.reinforcement_count += 1;
    state.last_checked_at = new Date().toISOString();
    if (writeUltraworkState(state, directory, sessionId)) {
        return state;
    }
    return null;
}
/**
 * Check if ultrawork should be reinforced (active with pending todos)
 */
export function shouldReinforceUltrawork(sessionId, directory) {
    const state = readUltraworkState(directory, sessionId);
    if (!state || !state.active) {
        return false;
    }
    // Strict session isolation: state must match the requesting session
    // Both must be defined and equal - prevent cross-session contamination
    // when both are undefined (Bug #5 fix)
    if (!state.session_id || !sessionId || state.session_id !== sessionId) {
        return false;
    }
    return true;
}
/**
 * Get ultrawork persistence message for injection
 */
export function getUltraworkPersistenceMessage(state) {
    const currentObjective = getLiveUltraworkObjective(state);
    const objectiveLine = currentObjective
        ? `\nCurrent objective: ${currentObjective}\n`
        : "";
    return `<ultrawork-persistence>

[ULTRAWORK MODE STILL ACTIVE - Reinforcement #${state.reinforcement_count + 1}]

Your ultrawork session is NOT complete. Incomplete todos remain.

REMEMBER THE ULTRAWORK RULES:
- **PARALLEL**: Fire independent calls simultaneously - NEVER wait sequentially
- **BACKGROUND FIRST**: Use Task(run_in_background=true) for exploration (10+ concurrent)
- **TODO**: Track EVERY step. Mark complete IMMEDIATELY after each
- **VERIFY**: Check ALL requirements met before done
- **NO Premature Stopping**: ALL TODOs must be complete

Continue working on the next pending task. DO NOT STOP until all tasks are marked complete.
When all work is complete, run /oh-my-claudecode:cancel to cleanly exit ultrawork mode and clean up state files.${objectiveLine}

</ultrawork-persistence>

---

`;
}
/**
 * Create an Ultrawork State hook instance
 */
export function createUltraworkStateHook(directory) {
    return {
        activate: (prompt, sessionId) => activateUltrawork(prompt, sessionId, directory),
        deactivate: (sessionId) => deactivateUltrawork(directory, sessionId),
        getState: (sessionId) => readUltraworkState(directory, sessionId),
        shouldReinforce: (sessionId) => shouldReinforceUltrawork(sessionId, directory),
        incrementReinforcement: (sessionId) => incrementReinforcement(directory, sessionId),
    };
}
//# sourceMappingURL=index.js.map