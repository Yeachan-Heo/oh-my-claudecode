/**
 * OMC HUD - Background Task Cleanup
 *
 * Handles cleanup of stale and orphaned background tasks on HUD startup.
 */
import type { BackgroundTask } from './types.js';
/**
 * Clean up stale background tasks from HUD state.
 * Removes tasks that are old and not recently completed.
 *
 * @param thresholdMs Age threshold in milliseconds (default: 30 minutes)
 * @returns Number of tasks removed
 */
export declare function cleanupStaleBackgroundTasks(thresholdMs?: number): Promise<number>;
/**
 * Detect orphaned background tasks that are still marked as running
 * but are likely from a previous session crash.
 *
 * @returns Array of orphaned tasks
 */
export declare function detectOrphanedTasks(): Promise<BackgroundTask[]>;
/**
 * Mark orphaned tasks as stale/completed to clean up the display.
 *
 * @returns Number of tasks marked
 */
export declare function markOrphanedTasksAsStale(): Promise<number>;
//# sourceMappingURL=background-cleanup.d.ts.map