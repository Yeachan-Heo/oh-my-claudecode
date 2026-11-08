/**
 * Background Notification Hook
 *
 * Handles notifications for background tasks completing.
 * Integrates with the BackgroundManager to show task completion status.
 *
 * Adapted from oh-my-opencode's background-notification hook for Claude Code's
 * shell hooks system.
 */

import { getBackgroundManager } from '../../features/background-agent/index.js';
import type { BackgroundManager, BackgroundTask } from '../../features/background-agent/index.js';
import type {
  BackgroundNotificationHookConfig,
  BackgroundNotificationHookInput,
  BackgroundNotificationHookOutput,
  NotificationCheckResult,
} from './types.js';

// Re-export types
export type {
  BackgroundNotificationHookConfig,
  BackgroundNotificationHookInput,
  BackgroundNotificationHookOutput,
  NotificationCheckResult,
} from './types.js';

/** Hook name identifier */
export const HOOK_NAME = 'background-notification';

/**
 * Format a single task notification
 */
function formatTaskNotification(task: BackgroundTask): string {
  const status = task.status.toUpperCase();
  const duration = formatDuration(task.startedAt, task.completedAt);
  const emoji = task.status === 'completed' ? '✓' : task.status === 'error' ? '✗' : '○';

  const lines = [
    `${emoji} [${status}] ${task.description}`,
    `  Agent: ${task.agent}`,
    `  Duration: ${duration}`,
  ];

  if (task.progress?.toolCalls) {
    lines.push(`  Tool calls: ${task.progress.toolCalls}`);
  }

  if (task.result) {
    const resultPreview = task.result.substring(0, 200);
    const truncated = task.result.length > 200 ? '...' : '';
    lines.push(`  Result: ${resultPreview}${truncated}`);
  }

  if (task.error) {
    lines.push(`  Error: ${task.error}`);
  }

  return lines.join('\n');
}

/**
 * Format duration between two dates
 */
function formatDuration(start: Date, end?: Date): string {
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
 * Default formatter for notification messages
 */
function defaultFormatNotification(tasks: BackgroundTask[]): string {
  if (tasks.length === 0) {
    return '';
  }

  const header = tasks.length === 1
    ? '\n[BACKGROUND TASK COMPLETED]\n'
    : `\n[${tasks.length} BACKGROUND TASKS COMPLETED]\n`;

  const taskDescriptions = tasks
    .map(task => formatTaskNotification(task))
    .join('\n\n');

  return `${header}\n${taskDescriptions}\n`;
}

/**
 * Check for pending background notifications
 */
export function checkBackgroundNotifications(
  sessionId: string,
  manager: BackgroundManager,
  config?: BackgroundNotificationHookConfig
): NotificationCheckResult {
  // Get pending notifications for this session
  const tasks = manager.getPendingNotifications(sessionId);

  if (tasks.length === 0) {
    return {
      hasNotifications: false,
      tasks: [],
    };
  }

  // Format notification message
  const formatter = config?.formatNotification ?? defaultFormatNotification;
  const message = formatter(tasks);

  return {
    hasNotifications: true,
    tasks,
    message,
  };
}

/**
 * Process background notification event
 */
export function processBackgroundNotification(
  input: BackgroundNotificationHookInput,
  config?: BackgroundNotificationHookConfig
): BackgroundNotificationHookOutput {
  const sessionId = input.sessionId;

  if (!sessionId) {
    return { continue: true };
  }

  // Get background manager
  const manager = getBackgroundManager();

  // Check for notifications
  const result = checkBackgroundNotifications(sessionId, manager, config);

  if (!result.hasNotifications) {
    return { continue: true };
  }

  // Clear notifications if auto-clear is enabled (default: true)
  const autoClear = config?.autoClear ?? true;
  if (autoClear) {
    manager.clearNotifications(sessionId);
  }

  return {
    continue: true,
    message: result.message,
    notificationCount: result.tasks.length,
  };
}

/**
 * Handle event from BackgroundManager
 * This is called by the BackgroundManager when tasks complete
 */
export function handleBackgroundEvent(
  event: { type: string; properties?: Record<string, unknown> },
  manager: BackgroundManager
): void {
  // Handle task completion events
  if (event.type === 'task.completed' || event.type === 'task.failed') {
    const taskId = event.properties?.taskId as string;
    if (taskId) {
      const task = manager.getTask(taskId);
      if (task) {
        manager.markForNotification(task);
      }
    }
  }
}

/**
 * Create background notification hook handlers
 */
export function createBackgroundNotificationHook(
  manager: BackgroundManager,
  config?: BackgroundNotificationHookConfig
) {
  return {
    /**
     * Hook name identifier
     */
    name: HOOK_NAME,

    /**
     * Process an event (for shell hook compatibility)
     */
    event: async (input: BackgroundNotificationHookInput): Promise<BackgroundNotificationHookOutput> => {
      // Handle event if provided
      if (input.event) {
        handleBackgroundEvent(input.event, manager);
      }

      // Process notifications
      return processBackgroundNotification(input, config);
    },

    /**
     * Check for pending notifications without clearing them
     */
    check: (sessionId: string): NotificationCheckResult => {
      return checkBackgroundNotifications(sessionId, manager, config);
    },

    /**
     * Manually clear notifications for a session
     */
    clear: (sessionId: string): void => {
      manager.clearNotifications(sessionId);
    },

    /**
     * Get all pending notifications without clearing
     */
    getPending: (sessionId: string): BackgroundTask[] => {
      return manager.getPendingNotifications(sessionId);
    },
  };
}

/**
 * Simple utility function for shell hook integration
 */
export async function processBackgroundNotificationHook(
  input: BackgroundNotificationHookInput,
  config?: BackgroundNotificationHookConfig
): Promise<BackgroundNotificationHookOutput> {
  const manager = getBackgroundManager();
  const hook = createBackgroundNotificationHook(manager, config);
  return hook.event(input);
}
