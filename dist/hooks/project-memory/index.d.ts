/**
 * Project Memory Hook
 * Main orchestrator for auto-detecting and injecting project context
 */
/**
 * Register project memory context for a session
 * Called from SessionStart hook
 *
 * @param sessionId - Current session ID
 * @param workingDirectory - Current working directory
 * @returns true if context was registered, false otherwise
 */
export declare function registerProjectMemoryContext(sessionId: string, workingDirectory: string): Promise<boolean>;
/**
 * Clear project memory session cache
 * Called when session ends
 *
 * @param sessionId - Session ID to clear
 */
export declare function clearProjectMemorySession(sessionId: string): void;
/**
 * Force rescan of project environment
 * Useful for manual refresh
 *
 * @param projectRoot - Project root directory
 */
export declare function rescanProjectEnvironment(projectRoot: string): Promise<void>;
export { loadProjectMemory, saveProjectMemory } from './storage.js';
export { detectProjectEnvironment } from './detector.js';
export { formatContextSummary, formatFullContext } from './formatter.js';
export { learnFromToolOutput, addCustomNote } from './learner.js';
export { processPreCompact } from './pre-compact.js';
export { mapDirectoryStructure, updateDirectoryAccess } from './directory-mapper.js';
export { trackAccess, getTopHotPaths, decayHotPaths } from './hot-path-tracker.js';
export { detectDirectivesFromMessage, addDirective, formatDirectivesForContext } from './directive-detector.js';
export * from './types.js';
//# sourceMappingURL=index.d.ts.map