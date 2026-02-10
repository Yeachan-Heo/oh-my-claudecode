/**
 * Background Agent Manager
 *
 * Manages background tasks for the Sisyphus system.
 * This is a simplified version that tracks tasks launched via Claude Code's
 * native Task tool with run_in_background: true.
 *
 * Adapted from oh-my-opencode's background-agent feature.
 */
import type { BackgroundTask, BackgroundTaskStatus, BackgroundTaskConfig, LaunchInput, ResumeInput, TaskProgress, ResumeContext } from './types.js';
/**
 * Manages background tasks for the Sisyphus system.
 */
export declare class BackgroundManager {
    private tasks;
    private notifications;
    private concurrencyManager;
    private config;
    private pruneInterval?;
    constructor(config?: BackgroundTaskConfig);
    /**
     * Ensure storage directory exists
     */
    private ensureStorageDir;
    /**
     * Generate a unique task ID
     */
    private generateTaskId;
    /**
     * Get storage path for a task
     */
    private getTaskPath;
    /**
     * Persist a task to disk
     */
    private persistTask;
    /**
     * Remove persisted task from disk
     */
    private unpersistTask;
    /**
     * Load persisted tasks from disk
     */
    private loadPersistedTasks;
    /**
     * Start periodic pruning of stale tasks
     */
    private startPruning;
    /**
     * Stop periodic pruning
     */
    private stopPruning;
    /**
     * Remove stale tasks that have exceeded their TTL
     */
    private pruneStaleTasksAndNotifications;
    /**
     * Detect sessions with no recent activity and handle them
     * Marks stale tasks as errored even without a callback configured (Bug #9 fix)
     */
    private detectAndHandleStaleSessions;
    /**
     * Register a new background task
     */
    launch(input: LaunchInput): Promise<BackgroundTask>;
    /**
     * Resume an existing background task
     */
    resume(input: ResumeInput): Promise<BackgroundTask>;
    /**
     * Get resume context for a session
     * Used by the resume_session tool to prepare continuation prompts
     */
    getResumeContext(sessionId: string): ResumeContext | null;
    /**
     * Get a task by ID
     */
    getTask(id: string): BackgroundTask | undefined;
    /**
     * Find a task by session ID
     */
    findBySession(sessionId: string): BackgroundTask | undefined;
    /**
     * Get all tasks for a parent session
     */
    getTasksByParentSession(sessionId: string): BackgroundTask[];
    /**
     * Get all tasks (including nested)
     */
    getAllTasks(): BackgroundTask[];
    /**
     * Get all running tasks
     */
    getRunningTasks(): BackgroundTask[];
    /**
     * Update task status
     */
    updateTaskStatus(taskId: string, status: BackgroundTaskStatus, result?: string, error?: string): void;
    /**
     * Update task progress
     */
    updateTaskProgress(taskId: string, progress: Partial<TaskProgress>): void;
    /**
     * Mark a task for notification to parent session
     */
    markForNotification(task: BackgroundTask): void;
    /**
     * Get pending notifications for a session
     */
    getPendingNotifications(sessionId: string): BackgroundTask[];
    /**
     * Clear notifications for a session
     */
    clearNotifications(sessionId: string): void;
    /**
     * Clear notifications for a specific task
     */
    private clearNotificationsForTask;
    /**
     * Remove a task completely
     */
    removeTask(taskId: string): void;
    /**
     * Format duration for display
     */
    formatDuration(start: Date, end?: Date): string;
    /**
     * Generate a status summary for all tasks
     */
    getStatusSummary(): string;
    /**
     * Cleanup manager (stop pruning, clear state)
     */
    cleanup(): void;
}
/**
 * Get the singleton background manager instance
 */
export declare function getBackgroundManager(config?: BackgroundTaskConfig): BackgroundManager;
/**
 * Reset the singleton (for testing)
 */
export declare function resetBackgroundManager(): void;
//# sourceMappingURL=manager.d.ts.map