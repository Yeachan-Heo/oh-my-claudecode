import { type CleanupOptions, type CleanupResult, type ListStatesOptions, type StateFileInfo } from "./types.js";
/**
 * List all state files
 *
 * Returns information about all state files in the specified location(s).
 */
export declare function listStates(options?: ListStatesOptions): StateFileInfo[];
/**
 * Cleanup orphaned state files
 *
 * Removes state files that haven't been modified in a long time.
 * Useful for cleaning up abandoned states.
 */
export declare function cleanupOrphanedStates(options?: CleanupOptions): CleanupResult;
//# sourceMappingURL=list-cleanup.d.ts.map