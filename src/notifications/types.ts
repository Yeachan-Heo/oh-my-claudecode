/**
 * Notification System Types
 *
 * Defines types for the multi-platform lifecycle notification system.
 * Supports Discord, Telegram, Slack, and generic webhooks across
 * session lifecycle events (start, stop, end, ask-user-question).
 */

/** Verbosity levels for notification filtering (ordered most to least verbose) */
export type VerbosityLevel = "verbose" | "agent" | "session" | "minimal";

/** Events that can trigger notifications */
export type NotificationEvent =
  | "session-start"
  | "session-stop"
  | "session-end"
  | "session-idle"
  | "ask-user-question"
  | "agent-call";

/** Supported notification platforms */
export type NotificationPlatform =
  | "discord"
  | "discord-bot"
  | "telegram"
  | "slack"
  | "webhook";

/** Discord webhook configuration */
export interface DiscordNotificationConfig {
  enabled: boolean;
  /** Discord webhook URL */
  webhookUrl: string;
  /** Optional username override for the webhook bot */
  username?: string;
  /** Optional mention to prepend to messages (e.g. "<@123456>" for user, "<@&789>" for role) */
  mention?: string;
}

/** Discord Bot API configuration (bot token + channel ID) */
export interface DiscordBotNotificationConfig {
  enabled: boolean;
  /** Discord bot token (or env var: OMC_DISCORD_NOTIFIER_BOT_TOKEN) */
  botToken?: string;
  /** Channel ID to send messages to (or env var: OMC_DISCORD_NOTIFIER_CHANNEL) */
  channelId?: string;
  /** Optional mention to prepend to messages (e.g. "<@123456>" for user, "<@&789>" for role) */
  mention?: string;
}

/** Telegram platform configuration */
export interface TelegramNotificationConfig {
  enabled: boolean;
  /** Telegram bot token */
  botToken: string;
  /** Chat ID to send messages to */
  chatId: string;
  /** Parse mode: Markdown or HTML (default: Markdown) */
  parseMode?: "Markdown" | "HTML";
}

/** Slack platform configuration */
export interface SlackNotificationConfig {
  enabled: boolean;
  /** Slack incoming webhook URL */
  webhookUrl: string;
  /** Optional channel override */
  channel?: string;
  /** Optional username override */
  username?: string;
  /** Optional mention to prepend to messages (e.g. "<@U12345678>" for user, "<!subteam^S12345>" for group, "<!channel>" / "<!here>" / "<!everyone>") */
  mention?: string;
}

/** Generic webhook configuration */
export interface WebhookNotificationConfig {
  enabled: boolean;
  /** Webhook URL (POST with JSON body) */
  url: string;
  /** Optional custom headers */
  headers?: Record<string, string>;
  /** Optional HTTP method override (default: POST) */
  method?: "POST" | "PUT";
}

/** Platform config union */
export type PlatformConfig =
  | DiscordNotificationConfig
  | DiscordBotNotificationConfig
  | TelegramNotificationConfig
  | SlackNotificationConfig
  | WebhookNotificationConfig;

/** Per-event notification configuration */
export interface EventNotificationConfig {
  /** Whether this event triggers notifications */
  enabled: boolean;
  /** Platform overrides for this event (inherits from top-level if not set) */
  discord?: DiscordNotificationConfig;
  "discord-bot"?: DiscordBotNotificationConfig;
  telegram?: TelegramNotificationConfig;
  slack?: SlackNotificationConfig;
  webhook?: WebhookNotificationConfig;
}

/** Top-level notification configuration (stored in .omc-config.json) */
export interface NotificationConfig {
  /** Global enable/disable for all notifications */
  enabled: boolean;

  /** Verbosity level controlling which events fire and tmux tail inclusion */
  verbosity?: VerbosityLevel;

  /** Default platform configs (used when event-specific config is not set) */
  discord?: DiscordNotificationConfig;
  "discord-bot"?: DiscordBotNotificationConfig;
  telegram?: TelegramNotificationConfig;
  slack?: SlackNotificationConfig;
  webhook?: WebhookNotificationConfig;

  /** Per-event configuration */
  events?: {
    "session-start"?: EventNotificationConfig;
    "session-stop"?: EventNotificationConfig;
    "session-end"?: EventNotificationConfig;
    "session-idle"?: EventNotificationConfig;
    "ask-user-question"?: EventNotificationConfig;
    "agent-call"?: EventNotificationConfig;
  };
}

/** Payload sent with each notification */
export interface NotificationPayload {
  /** The event that triggered this notification */
  event: NotificationEvent;
  /** Session identifier */
  sessionId: string;
  /** Pre-formatted message text */
  message: string;
  /** ISO timestamp */
  timestamp: string;
  /** Current tmux session name (if in tmux) */
  tmuxSession?: string;
  /** Project directory path */
  projectPath?: string;
  /** Basename of the project directory */
  projectName?: string;
  /** Active OMC modes during this session */
  modesUsed?: string[];
  /** Context summary of what was done */
  contextSummary?: string;
  /** Session duration in milliseconds */
  durationMs?: number;
  /** Number of agents spawned */
  agentsSpawned?: number;
  /** Number of agents completed */
  agentsCompleted?: number;
  /** Stop/end reason */
  reason?: string;
  /** Active mode name (for stop events) */
  activeMode?: string;
  /** Current iteration (for stop events) */
  iteration?: number;
  /** Max iterations (for stop events) */
  maxIterations?: number;
  /** Question text (for ask-user-question events) */
  question?: string;
  /** Incomplete task count */
  incompleteTasks?: number;
  /** tmux pane ID for reply injection target */
  tmuxPaneId?: string;
  /** Agent name for agent-call events (e.g., "executor", "architect") */
  agentName?: string;
  /** Agent type for agent-call events (e.g., "oh-my-claudecode:executor") */
  agentType?: string;
  /** Captured tmux pane content (last N lines) */
  tmuxTail?: string;
}

/** Named notification profiles (keyed by profile name) */
export type NotificationProfilesConfig = Record<string, NotificationConfig>;

/** Result of a notification send attempt */
export interface NotificationResult {
  platform: NotificationPlatform;
  success: boolean;
  error?: string;
  messageId?: string; // NEW: platform message ID for reply correlation
}

/** Result of dispatching notifications for an event */
export interface DispatchResult {
  event: NotificationEvent;
  results: NotificationResult[];
  /** Whether at least one notification was sent successfully */
  anySuccess: boolean;
}

/** Reply injection configuration */
export interface ReplyConfig {
  enabled: boolean;
  /** Polling interval in milliseconds (default: 3000) */
  pollIntervalMs: number;
  /** Maximum message length (default: 500) */
  maxMessageLength: number;
  /** Rate limit: max messages per minute (default: 10) */
  rateLimitPerMinute: number;
  /** Include visual prefix like [reply:discord] (default: true) */
  includePrefix: boolean;
  /** Authorized Discord user IDs (REQUIRED for Discord, empty = Discord disabled) */
  authorizedDiscordUserIds: string[];
}
