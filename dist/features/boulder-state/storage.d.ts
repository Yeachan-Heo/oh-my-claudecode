/**
 * Boulder State Storage
 *
 * Handles reading/writing boulder.json for active plan tracking.
 *
 * Ported from oh-my-opencode's boulder-state.
 */
import type { BoulderState, PlanProgress, PlanSummary } from './types.js';
/**
 * Get the full path to the boulder state file
 */
export declare function getBoulderFilePath(directory: string): string;
/**
 * Read boulder state from disk
 */
export declare function readBoulderState(directory: string): BoulderState | null;
/**
 * Write boulder state to disk
 */
export declare function writeBoulderState(directory: string, state: BoulderState): boolean;
/**
 * Append a session ID to the boulder state
 */
export declare function appendSessionId(directory: string, sessionId: string): BoulderState | null;
/**
 * Clear boulder state (delete the file)
 */
export declare function clearBoulderState(directory: string): boolean;
/**
 * Find Planner plan files for this project.
 * Planner stores plans at: {project}/.omc/plans/{name}.md
 */
export declare function findPlannerPlans(directory: string): string[];
/**
 * Parse a plan file and count checkbox progress.
 */
export declare function getPlanProgress(planPath: string): PlanProgress;
/**
 * Extract plan name from file path.
 */
export declare function getPlanName(planPath: string): string;
/**
 * Create a new boulder state for a plan.
 */
export declare function createBoulderState(planPath: string, sessionId: string): BoulderState;
/**
 * Get summaries of all available plans
 */
export declare function getPlanSummaries(directory: string): PlanSummary[];
/**
 * Check if a boulder is currently active
 */
export declare function hasBoulder(directory: string): boolean;
/**
 * Get the active plan path from boulder state
 */
export declare function getActivePlanPath(directory: string): string | null;
//# sourceMappingURL=storage.d.ts.map