/**
 * Reply Listener Daemon
 *
 * Background daemon that polls Discord and Telegram for replies to notification messages,
 * listens for Slack messages via Socket Mode, sanitizes input, verifies the target pane,
 * and injects reply text via sendToPane().
 *
 * Security considerations:
 * - State/PID/log files use restrictive permissions (0600)
 * - Bot tokens stored in state file, NOT in environment variables
 * - Two-layer input sanitization (sanitizeReplyInput + sanitizeForTmux)
 * - Pane verification via empty-content check before every injection
 * - Authorization: only configured user IDs (Discord) / chat ID (Telegram) can inject
 * - Rate limiting to prevent spam/abuse
 *
 * Follows the daemon pattern from src/features/rate-limit-wait/daemon.ts
 */
import type { ReplyConfig } from './types.js';
import { SlackConnectionStateTracker, type SlackValidationResult } from './slack-socket.js';
/** Reply listener daemon state */
export interface ReplyListenerState {
    isRunning: boolean;
    pid: number | null;
    startedAt: string | null;
    lastPollAt: string | null;
    telegramLastUpdateId: number | null;
    discordLastMessageId: string | null;
    messagesInjected: number;
    errors: number;
    lastError?: string;
}
/** Daemon configuration (written to state file) */
export interface ReplyListenerDaemonConfig extends ReplyConfig {
    telegramBotToken?: string;
    telegramChatId?: string;
    discordBotToken?: string;
    discordChannelId?: string;
    /** Discord mention tag to include in injection feedback (e.g. "<@123456>") */
    discordMention?: string;
    /** Slack app-level token for Socket Mode (xapp-...) */
    slackAppToken?: string;
    /** Slack bot token for Web API (xoxb-...) */
    slackBotToken?: string;
    /** Slack channel ID to listen in */
    slackChannelId?: string;
    /** Slack signing secret for verifying incoming WebSocket messages */
    slackSigningSecret?: string;
    /** Authorized Slack user IDs for reply injection (empty = all channel users allowed) */
    authorizedSlackUserIds: string[];
}
/** Response from daemon operations */
export interface DaemonResponse {
    success: boolean;
    message: string;
    state?: ReplyListenerState;
    error?: string;
}
/**
 * Build daemon config from notification config.
 * Derives bot tokens, channel IDs, and reply settings from getNotificationConfig().
 */
export declare function buildDaemonConfig(): Promise<ReplyListenerDaemonConfig | null>;
/**
 * Check if daemon is currently running
 */
export declare function isDaemonRunning(): boolean;
/**
 * Sanitize reply input from Discord/Telegram before tmux injection.
 * Applied BEFORE sendToPane()'s own sanitizeForTmux().
 *
 * Defenses:
 * - Newlines replaced with spaces (prevents multi-command injection)
 * - Backticks escaped (prevents command substitution in some shells)
 * - $() and ${} patterns escaped (prevents command substitution)
 * - Backslashes escaped (prevents escape sequence injection)
 * - Control characters stripped
 */
export declare function sanitizeReplyInput(text: string): string;
declare class RateLimiter {
    private readonly maxPerMinute;
    private timestamps;
    private readonly windowMs;
    constructor(maxPerMinute: number);
    canProceed(): boolean;
    reset(): void;
}
/**
 * Main daemon polling loop
 */
declare function pollLoop(): Promise<void>;
/**
 * Start the reply listener daemon.
 *
 * Forks a daemon process that derives its config from getNotificationConfig().
 * OMC_* env vars are forwarded so the daemon can read both file and env config.
 *
 * Idempotent: if daemon is already running, returns success.
 *
 * @param config - Daemon config (used only for validation, daemon reads config independently)
 */
export declare function startReplyListener(_config: ReplyListenerDaemonConfig): DaemonResponse;
/**
 * Stop the reply listener daemon
 */
export declare function stopReplyListener(): DaemonResponse;
/**
 * Get daemon status
 */
export declare function getReplyListenerStatus(): DaemonResponse;
/**
 * Validate and process an incoming Slack WebSocket message before session injection.
 *
 * This function is the security gate for Slack Socket Mode messages.
 * All Slack messages MUST pass through this function before reaching injectReply().
 *
 * Validation steps:
 * 1. Slack message validation (envelope, signing secret, connection state)
 * 2. Rate limiting
 * 3. Session registry lookup
 * 4. Pane verification and injection
 *
 * @param rawMessage - Raw WebSocket message string
 * @param connectionState - Slack connection state tracker
 * @param paneId - Target tmux pane ID (from session registry lookup by caller)
 * @param config - Daemon configuration
 * @param state - Daemon state (mutated: errors/messagesInjected counters)
 * @param rateLimiter - Rate limiter instance
 * @param signature - Slack request signature header (x-slack-signature)
 * @param timestamp - Slack request timestamp header (x-slack-request-timestamp)
 * @returns Object with injection result and validation details
 */
export declare function processSlackSocketMessage(rawMessage: string, connectionState: SlackConnectionStateTracker, paneId: string | null, config: ReplyListenerDaemonConfig, state: ReplyListenerState, rateLimiter: RateLimiter, signature?: string, timestamp?: string): {
    injected: boolean;
    validation: SlackValidationResult;
};
export { SlackConnectionStateTracker } from './slack-socket.js';
export type { SlackValidationResult } from './slack-socket.js';
export { RateLimiter };
export { pollLoop };
//# sourceMappingURL=reply-listener.d.ts.map