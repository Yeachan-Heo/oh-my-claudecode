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
import { type PRDStatus, type UserStory } from "./prd.js";
export declare function isUltraQAActive(directory: string, sessionId?: string): boolean;
export interface RalphLoopState {
    /** Whether the loop is currently active */
    active: boolean;
    /** Current iteration number */
    iteration: number;
    /** Maximum iterations before stopping */
    max_iterations: number;
    /** When the loop started */
    started_at: string;
    /** The original prompt/task */
    prompt: string;
    /** Session ID the loop is bound to */
    session_id?: string;
    /** Project path for isolation */
    project_path?: string;
    /** Whether PRD mode is active */
    prd_mode?: boolean;
    /** Current story being worked on */
    current_story_id?: string;
    /** Whether ultrawork is linked/auto-activated with ralph */
    linked_ultrawork?: boolean;
}
export interface RalphLoopOptions {
    /** Maximum iterations (default: 10) */
    maxIterations?: number;
    /** Disable auto-activation of ultrawork (default: false - ultrawork is enabled) */
    disableUltrawork?: boolean;
}
export interface RalphLoopHook {
    startLoop: (sessionId: string, prompt: string, options?: RalphLoopOptions) => boolean;
    cancelLoop: (sessionId: string) => boolean;
    getState: () => RalphLoopState | null;
}
/**
 * Read Ralph Loop state from disk
 */
export declare function readRalphState(directory: string, sessionId?: string): RalphLoopState | null;
/**
 * Write Ralph Loop state to disk
 */
export declare function writeRalphState(directory: string, state: RalphLoopState, sessionId?: string): boolean;
/**
 * Clear Ralph Loop state
 */
export declare function clearRalphState(directory: string, sessionId?: string): boolean;
/**
 * Clear ultrawork state (only if linked to ralph)
 */
export declare function clearLinkedUltraworkState(directory: string, sessionId?: string): boolean;
/**
 * Increment Ralph Loop iteration
 */
export declare function incrementRalphIteration(directory: string, sessionId?: string): RalphLoopState | null;
/**
 * Create a Ralph Loop hook instance
 */
export declare function createRalphLoopHook(directory: string): RalphLoopHook;
/**
 * Check if PRD mode is available (prd.json exists)
 */
export declare function hasPrd(directory: string): boolean;
/**
 * Get PRD completion status for ralph
 */
export declare function getPrdCompletionStatus(directory: string): {
    hasPrd: boolean;
    allComplete: boolean;
    status: PRDStatus | null;
    nextStory: UserStory | null;
};
/**
 * Get context injection for ralph continuation
 * Includes PRD current story and progress memory
 */
export declare function getRalphContext(directory: string): string;
/**
 * Update ralph state with current story
 */
export declare function setCurrentStory(directory: string, storyId: string): boolean;
/**
 * Enable PRD mode in ralph state
 */
export declare function enablePrdMode(directory: string): boolean;
/**
 * Record progress after completing a story
 */
export declare function recordStoryProgress(directory: string, storyId: string, implementation: string[], filesChanged: string[], learnings: string[]): boolean;
/**
 * Add a codebase pattern discovered during work
 */
export declare function recordPattern(directory: string, pattern: string): boolean;
/**
 * Check if ralph should complete based on PRD status
 */
export declare function shouldCompleteByPrd(directory: string): boolean;
export type { PRD, PRDStatus, UserStory } from "./prd.js";
//# sourceMappingURL=loop.d.ts.map