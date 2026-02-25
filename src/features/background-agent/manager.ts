/**
 * Background Agent Manager
 *
 * Manages background tasks for the OMC system.
 * This is a simplified version that tracks tasks launched via Claude Code's
 * native Task tool with run_in_background: true.
 *
 * Adapted from oh-my-opencode's background-agent feature.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getClaudeConfigDir } from '../../utils/paths.js';
import { ConcurrencyManager } from './concurrency.js';
import type {
  BackgroundTask,
  BackgroundTaskStatus,
  BackgroundTaskConfig,
  LaunchInput,
  ResumeInput,
  TaskProgress,
  ResumeContext,
} from './types.js';

/** Default task timeout: 30 minutes */
const DEFAULT_TASK_TTL_MS = 30 * 60 * 1000;

/** Storage directory for task state */
const BACKGROUND_TASKS_DIR = join(getClaudeConfigDir(), '.omc', 'background-tasks');

/**
 * Manages background tasks for the OMC system.
 */
export class BackgroundManager {
  private tasks: Map<string, BackgroundTask> = new Map();
  private notifications: Map<string, BackgroundTask[]> = new Map();
  private concurrencyManager: ConcurrencyManager;
  private config: BackgroundTaskConfig;
  private pruneInterval?: ReturnType<typeof setInterval>;

  constructor(config?: BackgroundTaskConfig) {
    this.config = config ?? {};
    this.concurrencyManager = new ConcurrencyManager(config);
    this.ensureStorageDir();
    this.loadPersistedTasks();
    this.startPruning();
  }

  /**
   * Ensure storage directory exists
   */
  private ensureStorageDir(): void {
    if (!existsSync(BACKGROUND_TASKS_DIR)) {
      mkdirSync(BACKGROUND_TASKS_DIR, { recursive: true });
    }
  }

  /**
   * Generate a unique task ID
   */
  private generateTaskId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `bg_${timestamp}${random}`;
  }

  /**
   * Get storage path for a task
   */
  private getTaskPath(taskId: string): string {
    return join(BACKGROUND_TASKS_DIR, `${taskId}.json`);
  }

  /**
   * Persist a task to disk
   */
  private persistTask(task: BackgroundTask): void {
    const path = this.getTaskPath(task.id);
    writeFileSync(path, JSON.stringify(task, null, 2));
  }

  /**
   * Remove persisted task from disk
   */
  private unpersistTask(taskId: string): void {
    const path = this.getTaskPath(taskId);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }

  /**
   * Load persisted tasks from disk
   */
  private loadPersistedTasks(): void {
    if (!existsSync(BACKGROUND_TASKS_DIR)) return;

    try {
      const files = readdirSync(BACKGROUND_TASKS_DIR) as string[];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const path = join(BACKGROUND_TASKS_DIR, file);
          const content = readFileSync(path, 'utf-8');
          const task = JSON.parse(content) as BackgroundTask;

          // Restore dates
          task.startedAt = new Date(task.startedAt);
          if (task.queuedAt) {
            task.queuedAt = new Date(task.queuedAt);
          }
          if (task.completedAt) {
            task.completedAt = new Date(task.completedAt);
          }
          if (task.progress?.lastUpdate) {
            task.progress.lastUpdate = new Date(task.progress.lastUpdate);
          }
          if (task.progress?.lastMessageAt) {
            task.progress.lastMessageAt = new Date(task.progress.lastMessageAt);
          }

          this.tasks.set(task.id, task);
        } catch {
          // Skip invalid task files
        }
      }
    } catch {
      // Ignore errors reading directory
    }
  }

  /**
   * Start periodic pruning of stale tasks
   */
  private startPruning(): void {
    if (this.pruneInterval) return;

    this.pruneInterval = setInterval(() => {
      this.pruneStaleTasksAndNotifications();
    }, 60000); // Every minute

    // Don't keep the process alive just for pruning
    if (this.pruneInterval.unref) {
      this.pruneInterval.unref();
    }
  }

  /**
   * Stop periodic pruning
   */
  private stopPruning(): void {
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = undefined;
    }
  }

  /**
   * Remove stale tasks that have exceeded their TTL
   */
  private pruneStaleTasksAndNotifications(): void {
    const now = Date.now();
    const ttl = this.config.taskTimeoutMs ?? DEFAULT_TASK_TTL_MS;

    for (const [taskId, task] of this.tasks.entries()) {
      const age = now - task.startedAt.getTime();
      if (age > ttl && (task.status === 'running' || task.status === 'queued')) {
        task.status = 'error';
        task.error = `Task timed out after ${Math.round(ttl / 60000)} minutes`;
        task.completedAt = new Date();

        if (task.concurrencyKey) {
          this.concurrencyManager.release(task.concurrencyKey);
        }

        this.clearNotificationsForTask(taskId);
        this.unpersistTask(taskId);
        this.tasks.delete(taskId);
      }
    }

    // Prune old notifications
    for (const [sessionId, notifications] of this.notifications.entries()) {
      const validNotifications = notifications.filter((task) => {
        const age = now - task.startedAt.getTime();
        return age <= ttl;
      });

      if (validNotifications.length === 0) {
        this.notifications.delete(sessionId);
      } else if (validNotifications.length !== notifications.length) {
        this.notifications.set(sessionId, validNotifications);
      }
    }

    // Detect stale sessions (no recent activity)
    this.detectAndHandleStaleSessions();
  }

  /**
   * Detect sessions with no recent activity and handle them
   * Marks stale tasks as errored even without a callback configured (Bug #9 fix)
   */
  private detectAndHandleStaleSessions(): void {
    const now = Date.now();
    const threshold = this.config.staleThresholdMs ?? 5 * 60 * 1000; // 5 min default

    for (const task of this.tasks.values()) {
      // Only check running tasks (not queued, completed, etc.)
      if (task.status !== 'running') continue;

      // Check last activity (progress.lastUpdate or startedAt as fallback)
      const lastActivity = task.progress?.lastUpdate ?? task.startedAt;
      const timeSinceActivity = now - lastActivity.getTime();

      if (timeSinceActivity > threshold) {
        // Invoke callback if configured (allows caller to auto-interrupt)
        if (this.config.onStaleSession) {
          this.config.onStaleSession(task);
        } else {
          // Default behavior: mark as error after 2x threshold with no activity
          if (timeSinceActivity > threshold * 2) {
            task.status = 'error';
            task.error = `Task stale: no activity for ${Math.round(timeSinceActivity / 60000)} minutes`;
            task.completedAt = new Date();

            if (task.concurrencyKey) {
              this.concurrencyManager.release(task.concurrencyKey);
            }

            this.clearNotificationsForTask(task.id);
            this.unpersistTask(task.id);
            this.tasks.delete(task.id);
          }
        }
      }
    }
  }

  /**
   * Register a new background task
   */
  async launch(input: LaunchInput): Promise<BackgroundTask> {
    const concurrencyKey = input.agent;

    // Count running and queued tasks for capacity check
    const runningTasks = Array.from(this.tasks.values()).filter(
      (t) => t.status === 'running'
    );
    const queuedTasks = Array.from(this.tasks.values()).filter(
      (t) => t.status === 'queued'
    );
    const runningCount = runningTasks.length;
    const queuedCount = queuedTasks.length;

    // Check maxTotalTasks (running + queued = tasks in flight)
    const maxTotal = this.config.maxTotalTasks ?? 10;
    const tasksInFlight = runningCount + queuedCount;

    if (tasksInFlight >= maxTotal) {
      throw new Error(
        `Maximum tasks in flight (${maxTotal}) reached. ` +
        `Currently: ${runningCount} running, ${queuedCount} queued. ` +
        `Wait for some tasks to complete.`
      );
    }

    // Check explicit maxQueueSize if configured
    const maxQueueSize = this.config.maxQueueSize;
    if (maxQueueSize !== undefined && queuedCount >= maxQueueSize) {
      throw new Error(
        `Maximum queue size (${maxQueueSize}) reached. ` +
        `Currently: ${runningCount} running, ${queuedCount} queued. ` +
        `Wait for some tasks to start or complete.`
      );
    }

    const taskId = this.generateTaskId();
    const sessionId = `ses_${this.generateTaskId()}`;

    // Create task in QUEUED state FIRST (non-blocking - visible immediately)
    const task: BackgroundTask = {
      id: taskId,
      sessionId,
      parentSessionId: input.parentSessionId,
      description: input.description,
      prompt: input.prompt,
      agent: input.agent,
      status: 'queued',
      queuedAt: new Date(),
      startedAt: new Date(), // Placeholder for backward compat, updated when running
      progress: {
        toolCalls: 0,
        lastUpdate: new Date(),
      },
      concurrencyKey,
      parentModel: input.model, // Preserve parent model
    };

    // Store immediately so task is visible while waiting for slot
    this.tasks.set(taskId, task);
    this.persistTask(task);

    // Wait for concurrency slot (may resolve immediately or block)
    await this.concurrencyManager.acquire(concurrencyKey);

    // Transition to RUNNING once slot acquired
    task.status = 'running';
    task.startedAt = new Date();
    this.persistTask(task);

    return task;
  }

  /**
   * Resume an existing background task
   */
  async resume(input: ResumeInput): Promise<BackgroundTask> {
    const existingTask = this.findBySession(input.sessionId);
    if (!existingTask) {
      throw new Error(`Task not found for session: ${input.sessionId}`);
    }

    existingTask.status = 'running';
    existingTask.completedAt = undefined;
    existingTask.error = undefined;
    existingTask.parentSessionId = input.parentSessionId;

    if (!existingTask.progress) {
      existingTask.progress = { toolCalls: 0, lastUpdate: new Date() };
    }
    existingTask.progress.lastUpdate = new Date();

    this.persistTask(existingTask);

    return existingTask;
  }

  /**
   * Get resume context for a session
   * Used by the resume_session tool to prepare continuation prompts
   */
  getResumeContext(sessionId: string): ResumeContext | null {
    const task = this.findBySession(sessionId);
    if (!task) {
      return null;
    }

    return {
      sessionId: task.sessionId,
      previousPrompt: task.prompt,
      toolCallCount: task.progress?.toolCalls ?? 0,
      lastToolUsed: task.progress?.lastTool,
      lastOutputSummary: task.progress?.lastMessage?.slice(0, 500),
      startedAt: task.startedAt,
      lastActivityAt: task.progress?.lastUpdate ?? task.startedAt,
    };
  }

  /**
   * Get a task by ID
   */
  getTask(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  /**
   * Find a task by session ID
   */
  findBySession(sessionId: string): BackgroundTask | undefined {
    for (const task of this.tasks.values()) {
      if (task.sessionId === sessionId) {
        return task;
      }
    }
    return undefined;
  }

  /**
   * Get all tasks for a parent session
   */
  getTasksByParentSession(sessionId: string): BackgroundTask[] {
    const result: BackgroundTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.parentSessionId === sessionId) {
        result.push(task);
      }
    }
    return result;
  }

  /**
   * Get all tasks (including nested)
   */
  getAllTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get all running tasks
   */
  getRunningTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values()).filter((t) => t.status === 'running');
  }

  /**
   * Update task status
   */
  updateTaskStatus(
    taskId: string,
    status: BackgroundTaskStatus,
    result?: string,
    error?: string
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = status;
    if (result) task.result = result;
    if (error) task.error = error;

    if (status === 'completed' || status === 'error' || status === 'cancelled') {
      task.completedAt = new Date();

      if (task.concurrencyKey) {
        this.concurrencyManager.release(task.concurrencyKey);
      }

      this.markForNotification(task);
    }

    this.persistTask(task);
  }

  /**
   * Update task progress
   */
  updateTaskProgress(taskId: string, progress: Partial<TaskProgress>): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (!task.progress) {
      task.progress = { toolCalls: 0, lastUpdate: new Date() };
    }

    Object.assign(task.progress, progress, { lastUpdate: new Date() });
    this.persistTask(task);
  }

  /**
   * Mark a task for notification to parent session
   */
  markForNotification(task: BackgroundTask): void {
    const queue = this.notifications.get(task.parentSessionId) ?? [];
    queue.push(task);
    this.notifications.set(task.parentSessionId, queue);
  }

  /**
   * Get pending notifications for a session
   */
  getPendingNotifications(sessionId: string): BackgroundTask[] {
    return this.notifications.get(sessionId) ?? [];
  }

  /**
   * Clear notifications for a session
   */
  clearNotifications(sessionId: string): void {
    this.notifications.delete(sessionId);
  }

  /**
   * Clear notifications for a specific task
   */
  private clearNotificationsForTask(taskId: string): void {
    for (const [sessionId, tasks] of this.notifications.entries()) {
      const filtered = tasks.filter((t) => t.id !== taskId);
      if (filtered.length === 0) {
        this.notifications.delete(sessionId);
      } else {
        this.notifications.set(sessionId, filtered);
      }
    }
  }

  /**
   * Remove a task completely
   */
  removeTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task?.concurrencyKey) {
      this.concurrencyManager.release(task.concurrencyKey);
    }

    this.clearNotificationsForTask(taskId);
    this.unpersistTask(taskId);
    this.tasks.delete(taskId);
  }

  /**
   * Format duration for display
   */
  formatDuration(start: Date, end?: Date): string {
    const duration = (end ?? new Date()).getTime() - start.getTime();
    const seconds = Math.floor(duration / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }

  /**
   * Generate a status summary for all tasks
   */
  getStatusSummary(): string {
    const running = this.getRunningTasks();
    const queued = Array.from(this.tasks.values()).filter((t) => t.status === 'queued');
    const all = this.getAllTasks();

    if (all.length === 0) {
      return 'No background tasks.';
    }

    const lines: string[] = [
      `Background Tasks: ${running.length} running, ${queued.length} queued, ${all.length} total`,
      '',
    ];

    for (const task of all) {
      const duration = this.formatDuration(task.startedAt, task.completedAt);
      const status = task.status.toUpperCase();
      const progress = task.progress
        ? ` (${task.progress.toolCalls} tools)`
        : '';

      lines.push(`  [${status}] ${task.description} - ${duration}${progress}`);

      if (task.error) {
        lines.push(`    Error: ${task.error}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Cleanup manager (stop pruning, clear state)
   */
  cleanup(): void {
    this.stopPruning();
    this.tasks.clear();
    this.notifications.clear();
  }
}

/** Singleton instance */
let instance: BackgroundManager | undefined;

/**
 * Get the singleton background manager instance
 */
export function getBackgroundManager(config?: BackgroundTaskConfig): BackgroundManager {
  if (!instance) {
    instance = new BackgroundManager(config);
  }
  return instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetBackgroundManager(): void {
  if (instance) {
    instance.cleanup();
    instance = undefined;
  }
}
