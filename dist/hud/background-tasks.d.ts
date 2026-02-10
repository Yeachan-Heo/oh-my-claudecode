/**
 * OMC HUD - Background Task Management
 *
 * Functions for tracking background tasks via hooks.
 * Called from bridge.ts pre-tool-use and post-tool-use handlers.
 */
/**
 * Add a background task to HUD state.
 * Called when a Task tool starts with run_in_background=true.
 */
export declare function addBackgroundTask(id: string, description: string, agentType?: string, directory?: string): boolean;
/**
 * Mark a background task as completed.
 * Called when a Task tool completes.
 */
export declare function completeBackgroundTask(id: string, directory?: string, failed?: boolean): boolean;
/**
 * Get count of running background tasks.
 */
export declare function getRunningTaskCount(directory?: string): number;
/**
 * Clear all background tasks.
 * Useful for cleanup or reset.
 */
export declare function clearBackgroundTasks(directory?: string): boolean;
//# sourceMappingURL=background-tasks.d.ts.map