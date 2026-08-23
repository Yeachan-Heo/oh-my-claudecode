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
import { execFileSync } from "child_process";
import { basename } from "path";
import { writeModeState, readModeState, clearModeStateFile, } from "../../lib/mode-state-io.js";
import { ensurePrdForStartup, findPrdPath, readPrd, getPrdStatus, formatNextStoryPrompt, formatPrdStatus, } from "./prd.js";
import { detectStalePrd, formatStalePrdWarning, reconcileStalePrdForStartup, } from "./stale-prd.js";
import { findProgressPath, getProgressContext, appendProgress, initProgress, addPattern, } from "./progress.js";
import { readUltraworkState as readUltraworkStateFromModule, writeUltraworkState as writeUltraworkStateFromModule, } from "../ultrawork/index.js";
import { readTeamPipelineState } from "../team-pipeline/state.js";
export const RALPH_CRITIC_MODES = ['architect', 'critic', 'codex'];
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_RALPH_CRITIC_MODE = 'architect';
/**
 * Read Ralph Loop state from disk
 */
export function readRalphState(directory, sessionId) {
    const state = readModeState("ralph", directory, sessionId);
    // Validate session identity
    if (state &&
        sessionId &&
        state.session_id &&
        state.session_id !== sessionId) {
        return null;
    }
    return state;
}
/**
 * Write Ralph Loop state to disk
 */
export function writeRalphState(directory, state, sessionId) {
    return writeModeState("ralph", state, directory, sessionId);
}
/**
 * Clear Ralph Loop state (includes ghost-legacy cleanup)
 */
export function clearRalphState(directory, sessionId) {
    return clearModeStateFile("ralph", directory, sessionId);
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
    return clearModeStateFile("ultrawork", directory, sessionId);
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
    return prompt
        .replace(/--no-prd/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}
/**
 * Normalize a Ralph critic mode flag value.
 */
export function normalizeRalphCriticMode(value) {
    if (!value) {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    return RALPH_CRITIC_MODES.includes(normalized)
        ? normalized
        : null;
}
/**
 * Detect --critic=<mode> flag (case-insensitive).
 */
export function detectCriticModeFlag(prompt) {
    const match = prompt.match(/--critic(?:=|\s+)([^\s]+)/i);
    return normalizeRalphCriticMode(match?.[1]);
}
/**
 * Strip --critic=<mode> flag from prompt text and trim whitespace.
 */
export function stripCriticModeFlag(prompt) {
    return prompt
        .replace(/--critic(?:=|\s+)([^\s]+)/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}
/**
 * Create a Ralph Loop hook instance
 */
export function createRalphLoopHook(directory) {
    const startLoop = (sessionId, prompt, options) => {
        const enableUltrawork = !options?.disableUltrawork;
        const now = new Date().toISOString();
        const normalizedPrompt = stripCriticModeFlag(stripNoPrdFlag(prompt));
        let branchName = "ralph/task";
        try {
            branchName = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
                cwd: directory,
                encoding: "utf-8",
                timeout: 5000,
                windowsHide: true,
            }).trim();
        }
        catch {
            // Fallback outside git repos.
        }
        const startupPrd = ensurePrdForStartup(directory, basename(directory), branchName, normalizedPrompt, undefined, sessionId);
        if (!startupPrd.ok) {
            console.error(`[RALPH PRD REQUIRED] ${startupPrd.error}`);
            return false;
        }
        // Stale-state reconciliation (#3669): if the active PRD was left unfinished
        // by an abnormal/non-Step 8 exit, reconcile it from configured observable
        // evidence (bounded: content checks only, never PR/merge status) and
        // surface any remaining divergence at the moment it is cheapest to fix.
        const staleReconcile = reconcileStalePrdForStartup(directory, sessionId);
        if (staleReconcile.warning) {
            console.error(staleReconcile.warning);
        }
        if (!findProgressPath(directory)) {
            initProgress(directory);
        }
        const state = {
            active: true,
            iteration: 1,
            max_iterations: options?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
            started_at: now,
            prompt: normalizedPrompt,
            session_id: sessionId,
            project_path: directory,
            linked_ultrawork: enableUltrawork,
            critic_mode: options?.criticMode ?? detectCriticModeFlag(prompt) ?? DEFAULT_RALPH_CRITIC_MODE,
            prd_mode: true,
        };
        const prdCompletion = getPrdCompletionStatus(directory, sessionId);
        if (prdCompletion.nextStory) {
            state.current_story_id = prdCompletion.nextStory.id;
        }
        const ralphSuccess = writeRalphState(directory, state, sessionId);
        // Auto-activate ultrawork (linked to ralph) by default
        // Include session_id and project_path for proper isolation
        if (ralphSuccess && enableUltrawork) {
            const ultraworkState = {
                active: true,
                reinforcement_count: 0,
                original_prompt: normalizedPrompt,
                started_at: now,
                last_checked_at: now,
                linked_to_ralph: true,
                session_id: sessionId,
                project_path: directory,
            };
            writeUltraworkStateFromModule(ultraworkState, directory, sessionId);
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
export function hasPrd(directory, sessionId) {
    const prd = readPrd(directory, sessionId);
    return prd !== null;
}
/**
 * Get PRD completion status for ralph
 */
export function getPrdCompletionStatus(directory, sessionId) {
    const prd = readPrd(directory, sessionId);
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
export function getRalphContext(directory, sessionId) {
    const parts = [];
    // Add stale-unfinished-PRD warning (#3669): the live loop excludes the
    // active-ralph-state signal (it is the normal case here) and only reports
    // divergence backed by age / stale-pointer signals.
    const staleDetection = detectStalePrd(directory, sessionId, { includeAbnormalExit: false });
    if (staleDetection?.stale) {
        parts.push(`<stale-prd-warning>\n${formatStalePrdWarning(staleDetection)}\n</stale-prd-warning>\n`);
    }
    // Add progress context (patterns, learnings)
    const progressContext = getProgressContext(directory);
    if (progressContext) {
        parts.push(progressContext);
    }
    // Add current story from PRD
    const prdStatus = getPrdCompletionStatus(directory, sessionId);
    if (prdStatus.hasPrd && prdStatus.nextStory) {
        parts.push(formatNextStoryPrompt(prdStatus.nextStory, findPrdPath(directory, sessionId) ?? undefined));
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
export function setCurrentStory(directory, storyId, sessionId) {
    const state = readRalphState(directory, sessionId);
    if (!state) {
        return false;
    }
    state.current_story_id = storyId;
    return writeRalphState(directory, state, sessionId);
}
/**
 * Enable PRD mode in ralph state
 */
export function enablePrdMode(directory, sessionId) {
    const state = readRalphState(directory, sessionId);
    if (!state) {
        return false;
    }
    state.prd_mode = true;
    // Initialize progress.txt if it doesn't exist
    initProgress(directory);
    return writeRalphState(directory, state, sessionId);
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
            const terminalPhases = ["complete", "failed"];
            if (terminalPhases.includes(teamState.phase)) {
                return "complete";
            }
        }
        return null;
    }
    const continuePhases = [
        "team-verify",
        "team-fix",
        "team-exec",
        "team-plan",
        "team-prd",
    ];
    if (continuePhases.includes(teamState.phase)) {
        return "continue";
    }
    return null;
}
/**
 * Check if ralph should complete based on PRD status
 */
export function shouldCompleteByPrd(directory, sessionId) {
    const status = getPrdCompletionStatus(directory, sessionId);
    return status.hasPrd && status.allComplete;
}
//# sourceMappingURL=loop.js.map