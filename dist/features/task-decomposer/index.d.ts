/**
 * Task Decomposition Engine
 *
 * Analyzes tasks and splits them into parallelizable components
 * with non-overlapping file ownership.
 */
import type { TaskAnalysis, Component, Subtask, SharedFile, DecompositionResult, ProjectContext } from './types.js';
export type { TaskAnalysis, Component, Subtask, SharedFile, DecompositionResult, ProjectContext, TaskType, ComponentRole, FileOwnership, DecompositionStrategy } from './types.js';
/**
 * Main entry point: decompose a task into parallelizable subtasks
 */
export declare function decomposeTask(task: string, projectContext?: ProjectContext): Promise<DecompositionResult>;
/**
 * Analyze task to understand structure and requirements
 */
export declare function analyzeTask(task: string, context: ProjectContext): TaskAnalysis;
/**
 * Identify parallelizable components from analysis
 */
export declare function identifyComponents(analysis: TaskAnalysis, context: ProjectContext): Component[];
/**
 * Generate subtasks from components
 */
export declare function generateSubtasks(components: Component[], analysis: TaskAnalysis, context: ProjectContext): Subtask[];
/**
 * Assign non-overlapping file ownership to subtasks
 */
export declare function assignFileOwnership(subtasks: Subtask[], sharedFiles: SharedFile[], context: ProjectContext): void;
/**
 * Identify files that require orchestration (shared across components)
 */
export declare function identifySharedFiles(components: Component[], context: ProjectContext): SharedFile[];
//# sourceMappingURL=index.d.ts.map