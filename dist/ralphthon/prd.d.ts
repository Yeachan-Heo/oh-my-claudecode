/**
 * Ralphthon PRD Module
 *
 * Extended PRD schema with hardening support for the ralphthon lifecycle.
 * Handles read/write/status operations for ralphthon-prd.json.
 */
import { type RalphthonPRD, type RalphthonStory, type RalphthonTask, type HardeningTask, type RalphthonConfig, type TaskStatus, type RalphthonPlanningContext } from "./types.js";
export declare const DEFAULT_PLANNING_CONTEXT: RalphthonPlanningContext;
export declare function normalizePlanningContext(context?: Partial<RalphthonPlanningContext> | null): RalphthonPlanningContext;
/**
 * Get the path to the ralphthon PRD file in .omc
 */
export declare function getRalphthonPrdPath(directory: string): string;
/**
 * Find ralphthon-prd.json (checks both root and .omc)
 */
export declare function findRalphthonPrdPath(directory: string): string | null;
/**
 * Read ralphthon PRD from disk
 */
export declare function readRalphthonPrd(directory: string): RalphthonPRD | null;
/**
 * Write ralphthon PRD to disk
 */
export declare function writeRalphthonPrd(directory: string, prd: RalphthonPRD): boolean;
export interface RalphthonPrdStatus {
    /** Total story count */
    totalStories: number;
    /** Stories with all tasks done */
    completedStories: number;
    /** Total task count across all stories */
    totalTasks: number;
    /** Tasks with status 'done' */
    completedTasks: number;
    /** Tasks with status 'pending' */
    pendingTasks: number;
    /** Tasks with status 'failed' or 'skipped' */
    failedOrSkippedTasks: number;
    /** Whether all story tasks are done */
    allStoriesDone: boolean;
    /** The next pending task (across all stories, by priority) */
    nextTask: {
        storyId: string;
        task: RalphthonTask;
    } | null;
    /** Total hardening tasks */
    totalHardeningTasks: number;
    /** Completed hardening tasks */
    completedHardeningTasks: number;
    /** Pending hardening tasks */
    pendingHardeningTasks: number;
    /** Whether all hardening tasks are done */
    allHardeningDone: boolean;
    /** Next pending hardening task */
    nextHardeningTask: HardeningTask | null;
}
/**
 * Compute full status of a ralphthon PRD
 */
export declare function getRalphthonPrdStatus(prd: RalphthonPRD): RalphthonPrdStatus;
/**
 * Update a story task's status
 */
export declare function updateTaskStatus(directory: string, storyId: string, taskId: string, status: TaskStatus, notes?: string): boolean;
/**
 * Increment retry count for a task and optionally mark as failed/skipped
 */
export declare function incrementTaskRetry(directory: string, storyId: string, taskId: string, maxRetries: number): {
    retries: number;
    skipped: boolean;
};
/**
 * Update a hardening task's status
 */
export declare function updateHardeningTaskStatus(directory: string, taskId: string, status: TaskStatus, notes?: string): boolean;
/**
 * Increment retry count for a hardening task
 */
export declare function incrementHardeningTaskRetry(directory: string, taskId: string, maxRetries: number): {
    retries: number;
    skipped: boolean;
};
/**
 * Add hardening tasks to the PRD for a new wave
 */
export declare function addHardeningTasks(directory: string, tasks: Omit<HardeningTask, "status" | "retries">[]): boolean;
/**
 * Create a new RalphthonPRD from stories
 */
export declare function createRalphthonPrd(project: string, branchName: string, description: string, stories: RalphthonStory[], config?: Partial<RalphthonConfig>, planningContext?: Partial<RalphthonPlanningContext>): RalphthonPRD;
/**
 * Initialize a ralphthon PRD on disk
 */
export declare function initRalphthonPrd(directory: string, project: string, branchName: string, description: string, stories: RalphthonStory[], config?: Partial<RalphthonConfig>, planningContext?: Partial<RalphthonPlanningContext>): boolean;
/**
 * Format a task prompt for injection into the leader pane
 */
export declare function formatTaskPrompt(storyId: string, task: RalphthonTask): string;
/**
 * Format a hardening task prompt for injection
 */
export declare function formatHardeningTaskPrompt(task: HardeningTask): string;
/**
 * Format the hardening wave generation prompt
 */
export declare function formatHardeningGenerationPrompt(wave: number, prd: RalphthonPRD): string;
/**
 * Format PRD status summary for display
 */
export declare function formatRalphthonStatus(prd: RalphthonPRD): string;
//# sourceMappingURL=prd.d.ts.map