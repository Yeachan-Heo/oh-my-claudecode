/**
 * Ultrapilot Coordinator
 *
 * Manages parallel worker spawning and coordination for ultrapilot mode.
 * Decomposes tasks, spawns workers (max 5), tracks progress, and integrates results
 * while managing file ownership to avoid conflicts.
 */
import type { UltrapilotConfig, UltrapilotState, WorkerState, IntegrationResult } from './types.js';
export { generateDecompositionPrompt, parseDecompositionResult, generateParallelGroups, validateFileOwnership, extractSharedFiles, toSimpleSubtasks, DEFAULT_SHARED_FILE_PATTERNS } from './decomposer.js';
export type { DecomposedTask, DecompositionResult, DecompositionOptions, AgentType, ModelTier } from './decomposer.js';
/**
 * Start ultrapilot coordinator
 *
 * Entry point for ultrapilot - decomposes task and spawns parallel workers.
 *
 * @param cwd - Current working directory
 * @param task - Task description to parallelize
 * @param config - Configuration options
 * @returns Initialized ultrapilot state
 */
export declare function startUltrapilot(cwd: string, task: string, config?: Partial<UltrapilotConfig>, sessionId?: string): Promise<UltrapilotState>;
/**
 * Decompose a task into parallelizable subtasks
 *
 * Uses heuristics to identify independent work units that can be executed in parallel.
 * For more intelligent decomposition with file ownership and dependencies, use the
 * AI-powered decomposition functions:
 *
 * @example AI-powered decomposition (recommended for complex tasks):
 * ```typescript
 * import {
 *   generateDecompositionPrompt,
 *   parseDecompositionResult,
 *   toSimpleSubtasks
 * } from './decomposer.js';
 *
 * // Generate prompt for Architect agent
 * const prompt = generateDecompositionPrompt(task, codebaseContext);
 *
 * // Call Architect agent (via Task tool in orchestrator)
 * const response = await Task({
 *   subagent_type: 'oh-my-claudecode:architect',
 *   model: 'opus',
 *   prompt
 * });
 *
 * // Parse structured result with file ownership
 * const result = parseDecompositionResult(response);
 *
 * // Use result.subtasks for full DecomposedTask objects with:
 * // - id, description, files, blockedBy, agentType, model
 * // Or convert to simple strings for legacy compatibility:
 * const subtasks = toSimpleSubtasks(result);
 * ```
 *
 * @param task - Task description
 * @param config - Configuration options
 * @returns Array of subtask descriptions
 */
export declare function decomposeTask(task: string, config: Required<UltrapilotConfig>): Promise<string[]>;
/**
 * Spawn parallel workers for subtasks
 *
 * Creates Task agents for each subtask with non-overlapping file ownership.
 *
 * @param cwd - Current working directory
 * @param subtasks - Array of subtask descriptions
 * @param config - Configuration options
 * @returns Array of spawned worker states
 */
export declare function spawnWorkers(cwd: string, subtasks: string[], config?: Partial<UltrapilotConfig>): Promise<WorkerState[]>;
/**
 * Track progress of running workers
 *
 * Polls TaskOutput to check worker status and updates state accordingly.
 *
 * @param cwd - Current working directory
 * @returns Object with completed, running, and failed worker counts
 */
export declare function trackProgress(cwd: string): Promise<{
    completed: number;
    running: number;
    failed: number;
    total: number;
}>;
/**
 * Integrate results from completed workers
 *
 * Merges outputs, detects conflicts, and produces final integration result.
 *
 * @param cwd - Current working directory
 * @returns Integration result with files, conflicts, and summary
 */
export declare function integrateResults(cwd: string): Promise<IntegrationResult>;
/**
 * Handle shared files that multiple workers might need to access
 *
 * Coordinator maintains exclusive ownership of shared files (package.json, etc.)
 * and provides a mechanism for workers to request changes.
 *
 * @param cwd - Current working directory
 * @param files - List of files to mark as shared
 * @returns Updated ownership state
 */
export declare function handleSharedFiles(cwd: string, files: string[]): Promise<boolean>;
/**
 * Check if a file is owned by a specific worker
 */
export declare function isFileOwnedByWorker(cwd: string, workerId: string, filePath: string): boolean;
/**
 * Check if a file is shared (owned by coordinator)
 */
export declare function isSharedFile(cwd: string, filePath: string): boolean;
/**
 * Assign file ownership to a worker
 */
export declare function assignFileToWorker(cwd: string, workerId: string, filePath: string): boolean;
export type { UltrapilotConfig, UltrapilotState, WorkerState, IntegrationResult, FileOwnership } from './types.js';
export { DEFAULT_CONFIG } from './types.js';
export { readUltrapilotState, writeUltrapilotState, initUltrapilot, addWorker, updateWorkerState, completeWorker, failWorker, completeUltrapilot, getCompletedWorkers, getRunningWorkers, getFailedWorkers, recordConflict } from './state.js';
//# sourceMappingURL=index.d.ts.map