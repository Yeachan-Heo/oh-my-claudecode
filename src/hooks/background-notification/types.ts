/**
 * Background Notification Hook Types
 *
 * Type definitions for background task notification handling.
 * Adapted from oh-my-opencode's background-notification hook.
 */

import type { BackgroundTask } from '../../features/background-agent/index.js';

/**
 * Configuration for background notification hook
 */
export interface BackgroundNotificationHookConfig {
  /**
   * Custom formatter for notification messages
   * If not provided, uses default formatting
   */
  formatNotification?: (tasks: BackgroundTask[]) => string;

  /**
   * Whether to automatically clear notifications after they're shown
   * Default: true
   */
  autoClear?: boolean;

  /**
   * Whether to show notifications only for the current session
   * Default: true (only show notifications for tasks launched by current session)
   */
  currentSessionOnly?: boolean;
}

/**
 * Input for background notification hook
 */
export interface BackgroundNotificationHookInput {
  /** Current session ID */
  sessionId?: string;
  /** Working directory */
  directory?: string;
  /** Event type (for shell hook compatibility) */
  event?: {
    type: string;
    properties?: Record<string, unknown>;
  };
}

/**
 * Output from background notification hook
 */
export interface BackgroundNotificationHookOutput {
  /** Whether to continue with the operation */
  continue: boolean;
  /** Notification message to inject into context */
  message?: string;
  /** Number of tasks with notifications */
  notificationCount?: number;
}

/**
 * Result of checking for background notifications
 */
export interface NotificationCheckResult {
  /** Whether there are pending notifications */
  hasNotifications: boolean;
  /** Completed tasks to notify about */
  tasks: BackgroundTask[];
  /** Formatted notification message */
  message?: string;
}
