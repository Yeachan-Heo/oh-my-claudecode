/**
 * Background Task Management
 *
 * Provides utilities for managing background task execution,
 * similar to oh-my-opencode's Background Task Manager.
 *
 * In Claude Code, background execution is controlled via:
 * - Bash tool's `run_in_background` parameter
 * - Task tool's `run_in_background` parameter
 * - TaskOutput tool for retrieving results
 *
 * This module provides:
 * - Decision heuristics for when to use background execution
 * - Task lifecycle management
 * - Concurrency limit enforcement
 * - System prompt guidance for agents
 */
import type { BackgroundTask, SessionState, PluginConfig } from '../shared/types.js';
/**
 * Default maximum concurrent background tasks
 */
export declare const DEFAULT_MAX_BACKGROUND_TASKS = 5;
/**
 * Patterns that indicate long-running operations
 * These should typically run in background
 */
export declare const LONG_RUNNING_PATTERNS: RegExp[];
/**
 * Patterns that should always run blocking (foreground)
 * These are quick operations or need immediate feedback
 */
export declare const BLOCKING_PATTERNS: RegExp[];
/**
 * Result of background execution decision
 */
export interface TaskExecutionDecision {
    /** Whether to run in background */
    runInBackground: boolean;
    /** Human-readable reason for the decision */
    reason: string;
    /** Estimated duration category */
    estimatedDuration: 'quick' | 'medium' | 'long' | 'unknown';
    /** Confidence level of the decision */
    confidence: 'high' | 'medium' | 'low';
}
/**
 * Determine if a command should run in background
 *
 * This is the core heuristic function that decides whether a command
 * should be executed with `run_in_background: true`.
 *
 * @param command - The command to analyze
 * @param currentBackgroundCount - Number of currently running background tasks
 * @param maxBackgroundTasks - Maximum allowed concurrent background tasks
 * @returns Decision object with recommendation and reasoning
 */
export declare function shouldRunInBackground(command: string, currentBackgroundCount?: number, maxBackgroundTasks?: number): TaskExecutionDecision;
/**
 * BackgroundTaskManager interface
 *
 * Manages background task lifecycle, enforces concurrency limits,
 * and provides utilities for tracking task status.
 */
export interface BackgroundTaskManager {
    /** Register a new background task */
    registerTask(agentName: string, prompt: string): BackgroundTask;
    /** Get all background tasks */
    getTasks(): BackgroundTask[];
    /** Get tasks by status */
    getTasksByStatus(status: BackgroundTask['status']): BackgroundTask[];
    /** Get count of running tasks */
    getRunningCount(): number;
    /** Check if we can start a new background task */
    canStartNewTask(): boolean;
    /** Update task status */
    updateTaskStatus(taskId: string, status: BackgroundTask['status'], result?: string, error?: string): void;
    /** Mark task as completed */
    completeTask(taskId: string, result: string): void;
    /** Mark task as failed */
    failTask(taskId: string, error: string): void;
    /** Remove completed tasks older than specified age (ms) */
    pruneCompletedTasks(maxAge?: number): number;
    /** Get the maximum allowed background tasks */
    getMaxTasks(): number;
    /** Check if a command should run in background */
    shouldRunInBackground(command: string): TaskExecutionDecision;
}
/**
 * Create a BackgroundTaskManager instance
 */
export declare function createBackgroundTaskManager(state: SessionState, config: PluginConfig): BackgroundTaskManager;
/**
 * System prompt guidance for background task execution
 *
 * This text should be appended to the system prompt to guide agents
 * on when and how to use background execution.
 */
export declare function getBackgroundTaskGuidance(maxBackgroundTasks?: number): string;
//# sourceMappingURL=background-tasks.d.ts.map