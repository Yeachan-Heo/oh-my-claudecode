/**
 * Ralph Hook
 *
 * Self-referential work loop that continues until cancelled via /oh-my-claudecode:cancel.
 * Named after the character who keeps working until the job is done.
 *
 * Enhanced with PRD (Product Requirements Document) support for structured task tracking.
 * When a prd.json exists, completion is based on all stories having passes: true.
 *
 * Ported from oh-my-opencode's ralph hook.
 */
import { existsSync, readFileSync, } from "fs";
import { join } from "path";
import { writeModeState, readModeState, clearModeStateFile } from '../../lib/mode-state-io.js';
import { readPrd, getPrdStatus, formatNextStoryPrompt, formatPrdStatus, } from "./prd.js";
import { getProgressContext, appendProgress, initProgress, addPattern, } from "./progress.js";
import { readUltraworkState as readUltraworkStateFromModule, writeUltraworkState as writeUltraworkStateFromModule, } from "../ultrawork/index.js";
import { resolveSessionStatePath, getOmcRoot } from "../../lib/worktree-paths.js";
import { readTeamPipelineState } from "../team-pipeline/state.js";
// Forward declaration to avoid circular import - check ultraqa state file directly
export function isUltraQAActive(directory, sessionId) {
    // When sessionId is provided, ONLY check session-scoped path — no legacy fallback
    if (sessionId) {
        const sessionFile = resolveSessionStatePath('ultraqa', sessionId, directory);
        if (!existsSync(sessionFile)) {
            return false;
        }
        try {
            const content = readFileSync(sessionFile, "utf-8");
            const state = JSON.parse(content);
            return state && state.active === true;
        }
        catch {
            return false; // NO legacy fallback
        }
    }
    // No sessionId: legacy path (backward compat)
    const omcDir = getOmcRoot(directory);
    const stateFile = join(omcDir, "state", "ultraqa-state.json");
    if (!existsSync(stateFile)) {
        return false;
    }
    try {
        const content = readFileSync(stateFile, "utf-8");
        const state = JSON.parse(content);
        return state && state.active === true;
    }
    catch {
        return false;
    }
}
const DEFAULT_MAX_ITERATIONS = 10;
/**
 * Read Ralph Loop state from disk
 */
export function readRalphState(directory, sessionId) {
    const state = readModeState('ralph', directory, sessionId);
    // Validate session identity
    if (state && sessionId && state.session_id && state.session_id !== sessionId) {
        return null;
    }
    return state;
}
/**
 * Write Ralph Loop state to disk
 */
export function writeRalphState(directory, state, sessionId) {
    return writeModeState('ralph', state, directory, sessionId);
}
/**
 * Clear Ralph Loop state (includes ghost-legacy cleanup)
 */
export function clearRalphState(directory, sessionId) {
    return clearModeStateFile('ralph', directory, sessionId);
}
/**
 * Clear ultrawork state (only if linked to ralph)
 */
export function clearLinkedUltraworkState(directory, sessionId) {
    const state = readUltraworkStateFromModule(directory, sessionId);
    // Only clear if it was linked to ralph (auto-activated)
    if (!state || !state.linked_to_ralph) {
        return true;
    }
    return clearModeStateFile('ultrawork', directory, sessionId);
}
/**
 * Increment Ralph Loop iteration
 */
export function incrementRalphIteration(directory, sessionId) {
    const state = readRalphState(directory, sessionId);
    if (!state || !state.active) {
        return null;
    }
    state.iteration += 1;
    if (writeRalphState(directory, state, sessionId)) {
        return state;
    }
    return null;
}
// ============================================================================
// PRD Flag Helpers
// ============================================================================
/**
 * Detect if prompt contains --no-prd flag (case-insensitive)
 */
export function detectNoPrdFlag(prompt) {
    return /--no-prd/i.test(prompt);
}
/**
 * Strip --no-prd flag from prompt text and trim whitespace
 */
export function stripNoPrdFlag(prompt) {
    return prompt.replace(/--no-prd/gi, '').replace(/\s+/g, ' ').trim();
}
/**
 * Create a Ralph Loop hook instance
 */
export function createRalphLoopHook(directory) {
    const startLoop = (sessionId, prompt, options) => {
        // Mutual exclusion check: cannot start Ralph Loop if UltraQA is active
        if (isUltraQAActive(directory, sessionId)) {
            console.error("Cannot start Ralph Loop while UltraQA is active. Cancel UltraQA first with /oh-my-claudecode:cancel.");
            return false;
        }
        const enableUltrawork = !options?.disableUltrawork;
        const now = new Date().toISOString();
        const state = {
            active: true,
            iteration: 1,
            max_iterations: options?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
            started_at: now,
            prompt,
            session_id: sessionId,
            project_path: directory,
            linked_ultrawork: enableUltrawork,
        };
        const ralphSuccess = writeRalphState(directory, state, sessionId);
        // Auto-activate ultrawork (linked to ralph) by default
        // Include session_id and project_path for proper isolation
        if (ralphSuccess && enableUltrawork) {
            const ultraworkState = {
                active: true,
                reinforcement_count: 0,
                original_prompt: prompt,
                started_at: now,
                last_checked_at: now,
                linked_to_ralph: true,
                session_id: sessionId,
                project_path: directory,
            };
            writeUltraworkStateFromModule(ultraworkState, directory, sessionId);
        }
        // Auto-enable PRD mode if prd.json exists
        if (ralphSuccess && hasPrd(directory)) {
            state.prd_mode = true;
            const prdCompletion = getPrdCompletionStatus(directory);
            if (prdCompletion.nextStory) {
                state.current_story_id = prdCompletion.nextStory.id;
            }
            // Initialize progress.txt if it doesn't exist
            initProgress(directory);
            // Write updated state with PRD fields
            writeRalphState(directory, state, sessionId);
        }
        return ralphSuccess;
    };
    const cancelLoop = (sessionId) => {
        const state = readRalphState(directory, sessionId);
        if (!state || state.session_id !== sessionId) {
            return false;
        }
        // Also clear linked ultrawork state if it was auto-activated
        if (state.linked_ultrawork) {
            clearLinkedUltraworkState(directory, sessionId);
        }
        return clearRalphState(directory, sessionId);
    };
    const getState = (sessionId) => {
        return readRalphState(directory, sessionId);
    };
    return {
        startLoop,
        cancelLoop,
        getState,
    };
}
// ============================================================================
// PRD Integration
// ============================================================================
/**
 * Check if PRD mode is available (prd.json exists)
 */
export function hasPrd(directory) {
    const prd = readPrd(directory);
    return prd !== null;
}
/**
 * Get PRD completion status for ralph
 */
export function getPrdCompletionStatus(directory) {
    const prd = readPrd(directory);
    if (!prd) {
        return {
            hasPrd: false,
            allComplete: false,
            status: null,
            nextStory: null,
        };
    }
    const status = getPrdStatus(prd);
    return {
        hasPrd: true,
        allComplete: status.allComplete,
        status,
        nextStory: status.nextStory,
    };
}
/**
 * Get context injection for ralph continuation
 * Includes PRD current story and progress memory
 */
export function getRalphContext(directory) {
    const parts = [];
    // Add progress context (patterns, learnings)
    const progressContext = getProgressContext(directory);
    if (progressContext) {
        parts.push(progressContext);
    }
    // Add current story from PRD
    const prdStatus = getPrdCompletionStatus(directory);
    if (prdStatus.hasPrd && prdStatus.nextStory) {
        parts.push(formatNextStoryPrompt(prdStatus.nextStory));
    }
    // Add PRD status summary
    if (prdStatus.status) {
        parts.push(`<prd-status>\n${formatPrdStatus(prdStatus.status)}\n</prd-status>\n`);
    }
    return parts.join("\n");
}
/**
 * Update ralph state with current story
 */
export function setCurrentStory(directory, storyId) {
    const state = readRalphState(directory);
    if (!state) {
        return false;
    }
    state.current_story_id = storyId;
    return writeRalphState(directory, state);
}
/**
 * Enable PRD mode in ralph state
 */
export function enablePrdMode(directory) {
    const state = readRalphState(directory);
    if (!state) {
        return false;
    }
    state.prd_mode = true;
    // Initialize progress.txt if it doesn't exist
    initProgress(directory);
    return writeRalphState(directory, state);
}
/**
 * Record progress after completing a story
 */
export function recordStoryProgress(directory, storyId, implementation, filesChanged, learnings) {
    return appendProgress(directory, {
        storyId,
        implementation,
        filesChanged,
        learnings,
    });
}
/**
 * Add a codebase pattern discovered during work
 */
export function recordPattern(directory, pattern) {
    return addPattern(directory, pattern);
}
/**
 * Check if an active team pipeline should influence ralph loop continuation.
 * Returns:
 *  - 'continue' if team is in a phase where ralph should keep looping (team-verify, team-fix, team-exec)
 *  - 'complete' if team reached a terminal state (complete, failed)
 *  - null if no team state is active (ralph operates independently)
 */
export function getTeamPhaseDirective(directory, sessionId) {
    const teamState = readTeamPipelineState(directory, sessionId);
    if (!teamState || !teamState.active) {
        // Check terminal states even when active=false
        if (teamState) {
            const terminalPhases = ['complete', 'failed'];
            if (terminalPhases.includes(teamState.phase)) {
                return 'complete';
            }
        }
        return null;
    }
    const continuePhases = ['team-verify', 'team-fix', 'team-exec', 'team-plan', 'team-prd'];
    if (continuePhases.includes(teamState.phase)) {
        return 'continue';
    }
    return null;
}
/**
 * Check if ralph should complete based on PRD status
 */
export function shouldCompleteByPrd(directory) {
    const status = getPrdCompletionStatus(directory);
    return status.hasPrd && status.allComplete;
}
//# sourceMappingURL=loop.js.map