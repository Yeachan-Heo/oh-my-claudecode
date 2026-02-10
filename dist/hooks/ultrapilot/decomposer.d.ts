/**
 * AI-Powered Task Decomposition for Ultrapilot
 *
 * This module provides intelligent task decomposition using an Architect agent
 * to analyze tasks and break them into parallel-safe subtasks with proper
 * file ownership and dependency tracking.
 */
/**
 * Agent type for task execution, determines model complexity
 */
export type AgentType = 'executor-low' | 'executor' | 'executor-high';
/**
 * Model tier for agent execution
 */
export type ModelTier = 'haiku' | 'sonnet' | 'opus';
/**
 * A decomposed subtask with file ownership and dependencies
 */
export interface DecomposedTask {
    /** Unique identifier for this subtask */
    id: string;
    /** Clear description of what to implement */
    description: string;
    /** Files this task will touch (can include globs) */
    files: string[];
    /** Task IDs this subtask depends on (must complete first) */
    blockedBy: string[];
    /** Agent type based on task complexity */
    agentType: AgentType;
    /** Model tier for execution */
    model: ModelTier;
}
/**
 * Result of task decomposition
 */
export interface DecompositionResult {
    /** Array of parallelizable subtasks */
    subtasks: DecomposedTask[];
    /** Files that need sequential handling (config, lock files) */
    sharedFiles: string[];
    /** Groups of task IDs that can run in parallel (dependency-ordered) */
    parallelGroups: string[][];
}
/**
 * Options for decomposition prompt generation
 */
export interface DecompositionOptions {
    /** Maximum number of subtasks to generate */
    maxSubtasks?: number;
    /** Preferred model tier for workers */
    preferredModel?: ModelTier;
    /** Additional context about project structure */
    projectContext?: string;
}
/**
 * Default shared file patterns that should be handled by the orchestrator
 */
export declare const DEFAULT_SHARED_FILE_PATTERNS: string[];
/**
 * Generate a prompt for the Architect agent to decompose a task
 *
 * This prompt instructs the Architect to analyze the task and codebase context,
 * then produce a structured JSON decomposition with file ownership and dependencies.
 *
 * @param task - The task description to decompose
 * @param codebaseContext - Context about the codebase structure, files, and patterns
 * @param options - Optional configuration for decomposition
 * @returns Formatted prompt string for the Architect agent
 *
 * @example
 * ```typescript
 * const prompt = generateDecompositionPrompt(
 *   "Build a full-stack todo app with React and Express",
 *   "Project has src/client and src/server directories..."
 * );
 * // Use with Architect agent via Task tool
 * ```
 */
export declare function generateDecompositionPrompt(task: string, codebaseContext: string, options?: DecompositionOptions): string;
/**
 * Parse the Architect's response into a structured DecompositionResult
 *
 * Handles various response formats including:
 * - Raw JSON
 * - JSON wrapped in markdown code fences
 * - JSON with surrounding explanation text
 *
 * @param response - Raw response string from the Architect agent
 * @returns Parsed and validated DecompositionResult
 * @throws Error if response cannot be parsed or is invalid
 *
 * @example
 * ```typescript
 * const result = parseDecompositionResult(architectResponse);
 * console.log(result.subtasks.length); // Number of parallel tasks
 * console.log(result.parallelGroups); // Execution order
 * ```
 */
export declare function parseDecompositionResult(response: string): DecompositionResult;
/**
 * Generate parallel groups from subtask dependencies
 *
 * Creates an ordered array of task ID groups where each group can run
 * in parallel, and later groups depend on earlier ones completing.
 *
 * @param subtasks - Array of decomposed subtasks with blockedBy fields
 * @returns Array of parallel groups (each group is array of task IDs)
 */
export declare function generateParallelGroups(subtasks: DecomposedTask[]): string[][];
/**
 * Validate that file ownership doesn't overlap between subtasks
 *
 * @param subtasks - Array of decomposed subtasks
 * @returns Object with isValid flag and any conflicts found
 */
export declare function validateFileOwnership(subtasks: DecomposedTask[]): {
    isValid: boolean;
    conflicts: Array<{
        file: string;
        owners: string[];
    }>;
};
/**
 * Merge shared files from subtasks into the sharedFiles list
 *
 * Identifies files that match shared file patterns and removes them
 * from subtask ownership, adding them to sharedFiles instead.
 *
 * @param result - DecompositionResult to process
 * @param patterns - Array of glob patterns for shared files
 * @returns Updated DecompositionResult with shared files extracted
 */
export declare function extractSharedFiles(result: DecompositionResult, patterns?: string[]): DecompositionResult;
/**
 * Convert DecompositionResult to simple string array for legacy compatibility
 *
 * @param result - Full decomposition result
 * @returns Array of task description strings
 */
export declare function toSimpleSubtasks(result: DecompositionResult): string[];
//# sourceMappingURL=decomposer.d.ts.map