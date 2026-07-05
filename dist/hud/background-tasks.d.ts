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
export declare function addBackgroundTask(id: string, description: string, agentType?: string, directory?: string, sessionId?: string): boolean;
/**
 * Mark a background task as completed.
 * Called when a Task tool completes.
 */
export declare function completeBackgroundTask(id: string, directory?: string, failed?: boolean, sessionId?: string): boolean;
/**
 * Remap a running background task from its launch-time hook id to the
 * async task id reported after launch.
 */
export declare function remapBackgroundTaskId(currentId: string, nextId: string, directory?: string, sessionId?: string): boolean;
export declare function completeMostRecentMatchingBackgroundTask(description: string, directory?: string, failed?: boolean, agentType?: string, sessionId?: string): boolean;
export declare function remapMostRecentMatchingBackgroundTaskId(description: string, nextId: string, directory?: string, agentType?: string, sessionId?: string): boolean;
/**
 * Get count of running background tasks.
 */
export declare function getRunningTaskCount(directory?: string, sessionId?: string): number;
/**
 * Clear all background tasks.
 * Useful for cleanup or reset.
 */
export declare function clearBackgroundTasks(directory?: string, sessionId?: string): boolean;
//# sourceMappingURL=background-tasks.d.ts.map