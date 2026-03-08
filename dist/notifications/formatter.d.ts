/**
 * Notification Message Formatters
 *
 * Produces human-readable notification messages for each event type.
 * Supports markdown (Discord/Telegram) and plain text (Slack/webhook) formats.
 */
import type { NotificationPayload } from "./types.js";
/**
 * Format session-start notification message.
 */
export declare function formatSessionStart(payload: NotificationPayload): string;
/**
 * Format session-stop notification message.
 * Sent when persistent mode blocks a stop (mode is still active).
 */
export declare function formatSessionStop(payload: NotificationPayload): string;
/**
 * Format session-end notification message.
 * Full summary with duration, agents, modes, and context.
 */
export declare function formatSessionEnd(payload: NotificationPayload): string;
/**
 * Format session-idle notification message.
 * Sent when Claude stops and no persistent mode is blocking (truly idle).
 */
export declare function formatSessionIdle(payload: NotificationPayload): string;
/**
 * Parse raw tmux output into clean, human-readable lines.
 * - Strips ANSI escape codes
 * - Drops lines starting with OMC chrome characters (●, ⎿, ✻, ·, ◼)
 * - Drops "ctrl+o to expand" hint lines
 * - Returns at most `maxLines` non-empty lines (default 10)
 */
export declare function parseTmuxTail(raw: string, maxLines?: number): string;
/**
 * Format agent-call notification message.
 * Sent when a new agent (Task) is spawned.
 */
export declare function formatAgentCall(payload: NotificationPayload): string;
/**
 * Format ask-user-question notification message.
 * Notifies the user that Claude is waiting for input.
 */
export declare function formatAskUserQuestion(payload: NotificationPayload): string;
/**
 * Format notification message based on event type.
 * Returns a markdown-formatted string suitable for Discord/Telegram.
 */
export declare function formatNotification(payload: NotificationPayload): string;
//# sourceMappingURL=formatter.d.ts.map