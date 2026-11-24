/**
 * Project Memory Hook
 * Main orchestrator for auto-detecting and injecting project context
 */
export declare function registerProjectMemoryContext(sessionId: string, workingDirectory: string): Promise<boolean>;
export declare function clearProjectMemorySession(sessionId: string): void;
export declare function rescanProjectEnvironment(projectRoot: string): Promise<void>;
export { loadProjectMemory, saveProjectMemory, withProjectMemoryLock, } from "./storage.js";
export { detectProjectEnvironment } from "./detector.js";
export { formatContextSummary, formatFullContext } from "./formatter.js";
export { learnFromToolOutput, addCustomNote } from "./learner.js";
export { processPreCompact } from "./pre-compact.js";
export { mapDirectoryStructure, updateDirectoryAccess, } from "./directory-mapper.js";
export { trackAccess, getTopHotPaths, decayHotPaths, } from "./hot-path-tracker.js";
export { detectDirectivesFromMessage, addDirective, formatDirectivesForContext, } from "./directive-detector.js";
export * from "./types.js";
//# sourceMappingURL=index.d.ts.map