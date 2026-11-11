/**
 * Background Notification Hook
 *
 * Handles notifications for background tasks completing.
 * Integrates with the BackgroundManager to show task completion status.
 *
 * Adapted from oh-my-opencode's background-notification hook for Claude Code's
 * shell hooks system.
 */
import type { BackgroundManager, BackgroundTask } from '../../features/background-agent/index.js';
import type { BackgroundNotificationHookConfig, BackgroundNotificationHookInput, BackgroundNotificationHookOutput, NotificationCheckResult } from './types.js';
export type { BackgroundNotificationHookConfig, BackgroundNotificationHookInput, BackgroundNotificationHookOutput, NotificationCheckResult, } from './types.js';
/** Hook name identifier */
export declare const HOOK_NAME = "background-notification";
/**
 * Check for pending background notifications
 */
export declare function checkBackgroundNotifications(sessionId: string, manager: BackgroundManager, config?: BackgroundNotificationHookConfig): NotificationCheckResult;
/**
 * Process background notification event
 */
export declare function processBackgroundNotification(input: BackgroundNotificationHookInput, config?: BackgroundNotificationHookConfig): BackgroundNotificationHookOutput;
/**
 * Handle event from BackgroundManager
 * This is called by the BackgroundManager when tasks complete
 */
export declare function handleBackgroundEvent(event: {
    type: string;
    properties?: Record<string, unknown>;
}, manager: BackgroundManager): void;
/**
 * Create background notification hook handlers
 */
export declare function createBackgroundNotificationHook(manager: BackgroundManager, config?: BackgroundNotificationHookConfig): {
    /**
     * Hook name identifier
     */
    name: string;
    /**
     * Process an event (for shell hook compatibility)
     */
    event: (input: BackgroundNotificationHookInput) => Promise<BackgroundNotificationHookOutput>;
    /**
     * Check for pending notifications without clearing them
     */
    check: (sessionId: string) => NotificationCheckResult;
    /**
     * Manually clear notifications for a session
     */
    clear: (sessionId: string) => void;
    /**
     * Get all pending notifications without clearing
     */
    getPending: (sessionId: string) => BackgroundTask[];
};
/**
 * Simple utility function for shell hook integration
 */
export declare function processBackgroundNotificationHook(input: BackgroundNotificationHookInput, config?: BackgroundNotificationHookConfig): Promise<BackgroundNotificationHookOutput>;
//# sourceMappingURL=index.d.ts.map