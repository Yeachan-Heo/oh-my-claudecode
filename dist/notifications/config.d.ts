/**
 * Notification Configuration Reader
 *
 * Reads notification config from .omc-config.json and provides
 * backward compatibility with the old stopHookCallbacks format.
 */
import type { NotificationConfig, NotificationEvent, NotificationPlatform, VerbosityLevel } from "./types.js";
/**
 * Validate Discord mention format: <@USER_ID> or <@&ROLE_ID>.
 * Returns the mention string if valid, undefined otherwise.
 */
export declare function validateMention(raw: string | undefined): string | undefined;
/**
 * Validate Slack channel name or ID format.
 * Accepts:
 *   - Channel ID: C or G followed by 8-11 uppercase alphanumeric chars (e.g. "C1234567890")
 *   - Channel name: optional # prefix, lowercase letters/numbers/hyphens/underscores (max 80 chars)
 * Rejects control characters, shell metacharacters, and path traversal sequences.
 * Returns the channel string if valid, undefined otherwise.
 */
export declare function validateSlackChannel(raw: string | undefined): string | undefined;
/**
 * Validate Slack username format.
 * Accepts alphanumeric characters, spaces, hyphens, underscores, periods, apostrophes (max 80 chars).
 * Rejects control characters, shell metacharacters, and path traversal sequences.
 * Returns the username string if valid, undefined otherwise.
 */
export declare function validateSlackUsername(raw: string | undefined): string | undefined;
/**
 * Validate Slack mention format.
 * Accepts: <@UXXXXXXXX> (user), <!channel>, <!here>, <!everyone>, <!subteam^SXXXXXXXXX> (user group).
 * Returns the mention string if valid, undefined otherwise.
 */
export declare function validateSlackMention(raw: string | undefined): string | undefined;
/**
 * Parse a validated mention into allowed_mentions structure for Discord API.
 */
export declare function parseMentionAllowedMentions(mention: string | undefined): {
    users?: string[];
    roles?: string[];
};
/**
 * Build notification config from environment variables.
 * This enables zero-config notification setup - just set env vars in .zshrc.
 */
export declare function buildConfigFromEnv(): NotificationConfig | null;
/**
 * Get the effective verbosity level.
 *
 * Priority: OMC_NOTIFY_VERBOSITY env var > config.verbosity > "session" default.
 * Invalid env var values are ignored (fall back to config or default).
 */
export declare function getVerbosity(config: NotificationConfig): VerbosityLevel;
/**
 * Get the effective tmux tail line count.
 *
 * Priority: OMC_NOTIFY_TMUX_TAIL_LINES env var > config.tmuxTailLines > 15 default.
 * Invalid values are ignored (fall back to config or default).
 */
export declare function getTmuxTailLines(config: NotificationConfig): number;
/**
 * Check if an event is allowed by the given verbosity level.
 *
 * Level matrix:
 * - minimal: session-start, session-stop, session-end, session-idle
 * - session: same as minimal (tmux tail handled separately)
 * - agent:   session events + agent-call
 * - verbose: all events
 */
export declare function isEventAllowedByVerbosity(verbosity: VerbosityLevel, event: NotificationEvent): boolean;
/**
 * Check if tmux tail content should be included at the given verbosity level.
 *
 * Returns true for session, agent, verbose. Returns false for minimal.
 */
export declare function shouldIncludeTmuxTail(verbosity: VerbosityLevel): boolean;
/**
 * Get the notification configuration.
 *
 * When a profile name is provided (or set via OMC_NOTIFY_PROFILE env var),
 * the corresponding named profile from `notificationProfiles` is used.
 * Falls back to the default `notifications` config if the profile is not found.
 *
 * Reads from .omc-config.json, looking for the `notifications` key.
 * When file config exists, env-derived platforms are merged in to fill
 * missing platform blocks (file fields take precedence).
 * Falls back to migrating old `stopHookCallbacks` if present.
 * Returns null if no notification config is found.
 *
 * @param profileName - Optional profile name (overrides OMC_NOTIFY_PROFILE env var)
 */
export declare function getNotificationConfig(profileName?: string): NotificationConfig | null;
/**
 * Check if a specific event has any enabled platform.
 */
export declare function isEventEnabled(config: NotificationConfig, event: NotificationEvent): boolean;
/**
 * Get list of enabled platforms for an event.
 */
export declare function getEnabledPlatforms(config: NotificationConfig, event: NotificationEvent): NotificationPlatform[];
/**
 * Resolve bot credentials used by the reply listener daemon.
 * Supports both top-level and event-level platform configs.
 */
export declare function getReplyListenerPlatformConfig(config: NotificationConfig | null): {
    telegramBotToken?: string;
    telegramChatId?: string;
    discordBotToken?: string;
    discordChannelId?: string;
    discordMention?: string;
    slackAppToken?: string;
    slackBotToken?: string;
    slackChannelId?: string;
};
/**
 * Get reply injection configuration.
 *
 * Returns null when:
 * - Reply listening is disabled
 * - No reply-capable bot platform (discord-bot or telegram) is configured
 * - Notifications are globally disabled
 *
 * Reads from .omc-config.json notifications.reply section.
 * Environment variables override config file values:
 * - OMC_REPLY_ENABLED: enable reply listening (default: false)
 * - OMC_REPLY_POLL_INTERVAL_MS: polling interval in ms (default: 3000)
 * - OMC_REPLY_RATE_LIMIT: max messages per minute (default: 10)
 * - OMC_REPLY_DISCORD_USER_IDS: comma-separated authorized Discord user IDs
 * - OMC_REPLY_INCLUDE_PREFIX: include visual prefix (default: true)
 *
 * SECURITY: Logs warning when Discord bot is enabled but authorizedDiscordUserIds is empty.
 */
export declare function getReplyConfig(): import("./types.js").ReplyConfig | null;
import type { CustomIntegration, CustomIntegrationsConfig } from "./types.js";
/**
 * Detect if legacy OpenClaw configuration exists.
 */
export declare function detectLegacyOpenClawConfig(): boolean;
/**
 * Read and migrate legacy OpenClaw config to new custom integration format.
 */
export declare function migrateLegacyOpenClawConfig(): CustomIntegration | null;
/**
 * Read custom integrations configuration from .omc-config.json.
 */
export declare function getCustomIntegrationsConfig(): CustomIntegrationsConfig | null;
/**
 * Get all custom integrations enabled for a specific event.
 */
export declare function getCustomIntegrationsForEvent(event: string): CustomIntegration[];
/**
 * Check if custom integrations are enabled (globally or for a specific event).
 */
export declare function hasCustomIntegrationsEnabled(event?: string): boolean;
//# sourceMappingURL=config.d.ts.map