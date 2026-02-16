/**
 * Notification Configuration Reader
 *
 * Reads notification config from .omc-config.json and provides
 * backward compatibility with the old stopHookCallbacks format.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getClaudeConfigDir } from "../utils/paths.js";
import type {
  NotificationConfig,
  NotificationEvent,
  NotificationPlatform,
  EventNotificationConfig,
  DiscordNotificationConfig,
  DiscordBotNotificationConfig,
  TelegramNotificationConfig,
} from "./types.js";

const CONFIG_FILE = join(getClaudeConfigDir(), ".omc-config.json");

/**
 * Read raw config from .omc-config.json
 */
function readRawConfig(): Record<string, unknown> | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Migrate old stopHookCallbacks config to new notification format.
 * This provides backward compatibility for existing users.
 */
function migrateStopHookCallbacks(
  raw: Record<string, unknown>,
): NotificationConfig | null {
  const callbacks = raw.stopHookCallbacks as
    | Record<string, unknown>
    | undefined;
  if (!callbacks) return null;

  const config: NotificationConfig = {
    enabled: true,
    events: {
      "session-end": { enabled: true },
    },
  };

  // Migrate Telegram config
  const telegram = callbacks.telegram as Record<string, unknown> | undefined;
  if (telegram?.enabled) {
    const telegramConfig: TelegramNotificationConfig = {
      enabled: true,
      botToken: (telegram.botToken as string) || "",
      chatId: (telegram.chatId as string) || "",
    };
    config.telegram = telegramConfig;
  }

  // Migrate Discord config
  const discord = callbacks.discord as Record<string, unknown> | undefined;
  if (discord?.enabled) {
    const discordConfig: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: (discord.webhookUrl as string) || "",
    };
    config.discord = discordConfig;
  }

  return config;
}

/**
 * Normalize an optional string: trim whitespace, return undefined if empty.
 */
function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/**
 * Validate Discord mention format: <@USER_ID> or <@&ROLE_ID>.
 * Returns the mention string if valid, undefined otherwise.
 */
export function validateMention(raw: string | undefined): string | undefined {
  const mention = normalizeOptional(raw);
  if (!mention) return undefined;
  // Match <@123456789012345678> (user) or <@&123456789012345678> (role)
  if (/^<@!?\d{17,20}>$/.test(mention) || /^<@&\d{17,20}>$/.test(mention)) {
    return mention;
  }
  return undefined;
}

/**
 * Parse a validated mention into allowed_mentions structure for Discord API.
 */
export function parseMentionAllowedMentions(
  mention: string | undefined,
): { users?: string[]; roles?: string[] } {
  if (!mention) return {};
  const userMatch = mention.match(/^<@!?(\d{17,20})>$/);
  if (userMatch) return { users: [userMatch[1]] };
  const roleMatch = mention.match(/^<@&(\d{17,20})>$/);
  if (roleMatch) return { roles: [roleMatch[1]] };
  return {};
}

/**
 * Build notification config from environment variables.
 * This enables zero-config notification setup - just set env vars in .zshrc.
 */
export function buildConfigFromEnv(): NotificationConfig | null {
  const config: NotificationConfig = { enabled: false };
  let hasAnyPlatform = false;

  const discordMention = validateMention(process.env.OMC_DISCORD_MENTION);

  // Discord Bot (token + channel)
  const discordBotToken = process.env.OMC_DISCORD_NOTIFIER_BOT_TOKEN;
  const discordChannel = process.env.OMC_DISCORD_NOTIFIER_CHANNEL;
  if (discordBotToken && discordChannel) {
    config["discord-bot"] = {
      enabled: true,
      botToken: discordBotToken,
      channelId: discordChannel,
      mention: discordMention,
    };
    hasAnyPlatform = true;
  }

  // Discord Webhook
  const discordWebhook = process.env.OMC_DISCORD_WEBHOOK_URL;
  if (discordWebhook) {
    config.discord = {
      enabled: true,
      webhookUrl: discordWebhook,
      mention: discordMention,
    };
    hasAnyPlatform = true;
  }

  // Telegram (support both OMC_TELEGRAM_BOT_TOKEN and OMC_TELEGRAM_NOTIFIER_BOT_TOKEN)
  const telegramToken =
    process.env.OMC_TELEGRAM_BOT_TOKEN ||
    process.env.OMC_TELEGRAM_NOTIFIER_BOT_TOKEN;
  const telegramChatId =
    process.env.OMC_TELEGRAM_CHAT_ID ||
    process.env.OMC_TELEGRAM_NOTIFIER_CHAT_ID ||
    process.env.OMC_TELEGRAM_NOTIFIER_UID;
  if (telegramToken && telegramChatId) {
    config.telegram = {
      enabled: true,
      botToken: telegramToken,
      chatId: telegramChatId,
    };
    hasAnyPlatform = true;
  }

  // Slack
  const slackWebhook = process.env.OMC_SLACK_WEBHOOK_URL;
  if (slackWebhook) {
    config.slack = {
      enabled: true,
      webhookUrl: slackWebhook,
    };
    hasAnyPlatform = true;
  }

  if (!hasAnyPlatform) return null;

  config.enabled = true;
  return config;
}

/**
 * Deep-merge env-derived platforms into file config.
 * Env fills missing platform blocks only; file config fields take precedence.
 * Mention values from env are applied to file-based Discord configs that lack one.
 */
function mergeEnvIntoFileConfig(
  fileConfig: NotificationConfig,
  envConfig: NotificationConfig,
): NotificationConfig {
  const merged = { ...fileConfig };

  // Merge discord-bot: if file doesn't have it but env does, add it
  if (!merged["discord-bot"] && envConfig["discord-bot"]) {
    merged["discord-bot"] = envConfig["discord-bot"];
  } else if (merged["discord-bot"] && envConfig["discord-bot"]) {
    // Fill missing fields from env (e.g., mention from env when file lacks it)
    merged["discord-bot"] = {
      ...merged["discord-bot"],
      botToken: merged["discord-bot"].botToken || envConfig["discord-bot"].botToken,
      channelId: merged["discord-bot"].channelId || envConfig["discord-bot"].channelId,
      mention:
        merged["discord-bot"].mention !== undefined
          ? validateMention(merged["discord-bot"].mention)
          : envConfig["discord-bot"].mention,
    };
  }

  // Merge discord webhook: if file doesn't have it but env does, add it
  if (!merged.discord && envConfig.discord) {
    merged.discord = envConfig.discord;
  } else if (merged.discord && envConfig.discord) {
    merged.discord = {
      ...merged.discord,
      webhookUrl: merged.discord.webhookUrl || envConfig.discord.webhookUrl,
      mention:
        merged.discord.mention !== undefined
          ? validateMention(merged.discord.mention)
          : envConfig.discord.mention,
    };
  } else if (merged.discord) {
    // Validate mention in existing file config
    merged.discord = {
      ...merged.discord,
      mention: validateMention(merged.discord.mention),
    };
  }

  // Merge telegram
  if (!merged.telegram && envConfig.telegram) {
    merged.telegram = envConfig.telegram;
  }

  // Merge slack
  if (!merged.slack && envConfig.slack) {
    merged.slack = envConfig.slack;
  }

  return merged;
}

/**
 * Get the notification configuration.
 *
 * Reads from .omc-config.json, looking for the `notifications` key.
 * When file config exists, env-derived platforms are merged in to fill
 * missing platform blocks (file fields take precedence).
 * Falls back to migrating old `stopHookCallbacks` if present.
 * Returns null if no notification config is found.
 */
export function getNotificationConfig(): NotificationConfig | null {
  const raw = readRawConfig();

  // Priority 1: Explicit notifications config in .omc-config.json
  if (raw) {
    const notifications = raw.notifications as NotificationConfig | undefined;
    if (notifications) {
      if (typeof notifications.enabled !== "boolean") {
        return null;
      }
      // Deep-merge: env platforms fill missing blocks in file config
      const envConfig = buildConfigFromEnv();
      if (envConfig) {
        return mergeEnvIntoFileConfig(notifications, envConfig);
      }
      // Even without full env platform config, apply env mention to file discord configs
      const envMention = validateMention(process.env.OMC_DISCORD_MENTION);
      if (envMention) {
        const patched = { ...notifications };
        if (patched["discord-bot"] && patched["discord-bot"].mention === undefined) {
          patched["discord-bot"] = { ...patched["discord-bot"], mention: envMention };
        }
        if (patched.discord && patched.discord.mention === undefined) {
          patched.discord = { ...patched.discord, mention: envMention };
        }
        return patched;
      }
      return notifications;
    }
  }

  // Priority 2: Environment variables (zero-config)
  const envConfig = buildConfigFromEnv();
  if (envConfig) return envConfig;

  // Priority 3: Legacy stopHookCallbacks migration
  if (raw) {
    return migrateStopHookCallbacks(raw);
  }

  return null;
}

/**
 * Check if a specific event has any enabled platform.
 */
export function isEventEnabled(
  config: NotificationConfig,
  event: NotificationEvent,
): boolean {
  if (!config.enabled) return false;

  const eventConfig = config.events?.[event];

  // If event is explicitly disabled
  if (eventConfig && eventConfig.enabled === false) return false;

  // If event has no specific config, check if any top-level platform is enabled
  if (!eventConfig) {
    return !!(
      config.discord?.enabled ||
      config["discord-bot"]?.enabled ||
      config.telegram?.enabled ||
      config.slack?.enabled ||
      config.webhook?.enabled
    );
  }

  // Check event-specific platform overrides
  if (
    eventConfig.discord?.enabled ||
    eventConfig["discord-bot"]?.enabled ||
    eventConfig.telegram?.enabled ||
    eventConfig.slack?.enabled ||
    eventConfig.webhook?.enabled
  ) {
    return true;
  }

  // Fall back to top-level platforms
  return !!(
    config.discord?.enabled ||
    config["discord-bot"]?.enabled ||
    config.telegram?.enabled ||
    config.slack?.enabled ||
    config.webhook?.enabled
  );
}

/**
 * Get list of enabled platforms for an event.
 */
export function getEnabledPlatforms(
  config: NotificationConfig,
  event: NotificationEvent,
): NotificationPlatform[] {
  if (!config.enabled) return [];

  const platforms: NotificationPlatform[] = [];
  const eventConfig = config.events?.[event];

  // If event is explicitly disabled
  if (eventConfig && eventConfig.enabled === false) return [];

  const checkPlatform = (platform: NotificationPlatform) => {
    const eventPlatform =
      eventConfig?.[platform as keyof EventNotificationConfig];
    if (
      eventPlatform &&
      typeof eventPlatform === "object" &&
      "enabled" in eventPlatform
    ) {
      if ((eventPlatform as { enabled: boolean }).enabled) {
        platforms.push(platform);
      }
      return; // Event-level config overrides top-level
    }

    // Top-level default
    const topLevel = config[platform as keyof NotificationConfig];
    if (
      topLevel &&
      typeof topLevel === "object" &&
      "enabled" in topLevel &&
      (topLevel as { enabled: boolean }).enabled
    ) {
      platforms.push(platform);
    }
  };

  checkPlatform("discord");
  checkPlatform("discord-bot");
  checkPlatform("telegram");
  checkPlatform("slack");
  checkPlatform("webhook");

  return platforms;
}

/**
 * Events checked when resolving reply-capable platform config.
 * Order matters for deterministic fallback when only event-level config exists.
 */
const REPLY_PLATFORM_EVENTS: NotificationEvent[] = [
  "session-start",
  "ask-user-question",
  "session-stop",
  "session-idle",
  "session-end",
];

/**
 * Resolve the effective enabled platform config for reply-listener bootstrap.
 *
 * Priority:
 * 1) Top-level platform config when enabled
 * 2) First enabled event-level platform config (deterministic event order)
 */
function getEnabledReplyPlatformConfig<T extends { enabled: boolean }>(
  config: NotificationConfig,
  platform: "discord-bot" | "telegram",
): T | undefined {
  const topLevel = config[platform] as T | undefined;
  if (topLevel?.enabled) {
    return topLevel;
  }

  for (const event of REPLY_PLATFORM_EVENTS) {
    const eventConfig = config.events?.[event];
    const eventPlatform =
      eventConfig?.[platform as keyof EventNotificationConfig];

    if (
      eventPlatform &&
      typeof eventPlatform === "object" &&
      "enabled" in eventPlatform &&
      (eventPlatform as { enabled: boolean }).enabled
    ) {
      return eventPlatform as T;
    }
  }

  return undefined;
}

/**
 * Resolve bot credentials used by the reply listener daemon.
 * Supports both top-level and event-level platform configs.
 */
export function getReplyListenerPlatformConfig(
  config: NotificationConfig | null,
): {
  telegramBotToken?: string;
  telegramChatId?: string;
  discordBotToken?: string;
  discordChannelId?: string;
} {
  if (!config) return {};

  const telegramConfig =
    getEnabledReplyPlatformConfig<TelegramNotificationConfig>(
      config,
      "telegram",
    );
  const discordBotConfig =
    getEnabledReplyPlatformConfig<DiscordBotNotificationConfig>(
      config,
      "discord-bot",
    );

  return {
    telegramBotToken: telegramConfig?.botToken || config.telegram?.botToken,
    telegramChatId: telegramConfig?.chatId || config.telegram?.chatId,
    discordBotToken:
      discordBotConfig?.botToken || config["discord-bot"]?.botToken,
    discordChannelId:
      discordBotConfig?.channelId || config["discord-bot"]?.channelId,
  };
}

/**
 * Parse Discord user IDs from environment variable or config array.
 * Returns empty array if neither is valid.
 */
function parseDiscordUserIds(
  envValue: string | undefined,
  configValue: unknown,
): string[] {
  // Try env var first (comma-separated list)
  if (envValue) {
    const ids = envValue
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^\d{17,20}$/.test(id));
    if (ids.length > 0) return ids;
  }

  // Try config array
  if (Array.isArray(configValue)) {
    const ids = configValue
      .filter((id) => typeof id === "string" && /^\d{17,20}$/.test(id));
    if (ids.length > 0) return ids;
  }

  return [];
}

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
export function getReplyConfig(): import("./types.js").ReplyConfig | null {
  const notifConfig = getNotificationConfig();
  if (!notifConfig?.enabled) return null;

  // Check if any reply-capable platform (discord-bot or telegram) is enabled.
  // Supports event-level platform config (not just top-level defaults).
  const hasDiscordBot = !!getEnabledReplyPlatformConfig<DiscordBotNotificationConfig>(
    notifConfig,
    "discord-bot",
  );
  const hasTelegram = !!getEnabledReplyPlatformConfig<TelegramNotificationConfig>(
    notifConfig,
    "telegram",
  );
  if (!hasDiscordBot && !hasTelegram) return null;

  // Read reply-specific config
  const raw = readRawConfig();
  const replyRaw = (raw?.notifications as any)?.reply;

  const enabled = process.env.OMC_REPLY_ENABLED === "true" || replyRaw?.enabled === true;
  if (!enabled) return null;

  const authorizedDiscordUserIds = parseDiscordUserIds(
    process.env.OMC_REPLY_DISCORD_USER_IDS,
    replyRaw?.authorizedDiscordUserIds,
  );

  // SECURITY: If Discord bot is enabled but no authorized user IDs, log warning
  if (hasDiscordBot && authorizedDiscordUserIds.length === 0) {
    console.warn(
      "[notifications] Discord reply listening disabled: authorizedDiscordUserIds is empty. " +
      "Set OMC_REPLY_DISCORD_USER_IDS or add to .omc-config.json notifications.reply.authorizedDiscordUserIds"
    );
  }

  return {
    enabled: true,
    pollIntervalMs: parseInt(process.env.OMC_REPLY_POLL_INTERVAL_MS || "") || replyRaw?.pollIntervalMs || 3000,
    maxMessageLength: replyRaw?.maxMessageLength || 500,
    rateLimitPerMinute: parseInt(process.env.OMC_REPLY_RATE_LIMIT || "") || replyRaw?.rateLimitPerMinute || 10,
    includePrefix: process.env.OMC_REPLY_INCLUDE_PREFIX !== "false" && (replyRaw?.includePrefix !== false),
    authorizedDiscordUserIds,
  };
}
