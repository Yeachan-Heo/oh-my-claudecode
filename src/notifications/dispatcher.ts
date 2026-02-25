/**
 * Notification Dispatcher
 *
 * Sends notifications to configured platforms (Discord, Telegram, Slack, webhook).
 * All sends are non-blocking with timeouts. Failures are swallowed to avoid
 * blocking hooks.
 */

import { request as httpsRequest } from "https";
import type {
  DiscordNotificationConfig,
  DiscordBotNotificationConfig,
  TelegramNotificationConfig,
  SlackNotificationConfig,
  WebhookNotificationConfig,
  NotificationPayload,
  NotificationResult,
  NotificationPlatform,
  DispatchResult,
  NotificationConfig,
  NotificationEvent,
} from "./types.js";

import { parseMentionAllowedMentions } from "./config.js";

/** Per-request timeout for individual platform sends */
const SEND_TIMEOUT_MS = 10_000;

/** Overall dispatch timeout for all platforms combined. Must be >= SEND_TIMEOUT_MS */
const DISPATCH_TIMEOUT_MS = 15_000;

/** Discord maximum content length */
const DISCORD_MAX_CONTENT_LENGTH = 2000;

/**
 * Compose Discord message content with mention prefix.
 * Enforces the 2000-char Discord content limit by truncating the message body.
 * Returns { content, allowed_mentions } ready for the Discord API.
 */
function composeDiscordContent(
  message: string,
  mention: string | undefined,
): {
  content: string;
  allowed_mentions: { parse: string[]; users?: string[]; roles?: string[] };
} {
  const mentionParsed = parseMentionAllowedMentions(mention);
  const allowed_mentions = {
    parse: [] as string[], // disable implicit @everyone/@here
    users: mentionParsed.users,
    roles: mentionParsed.roles,
  };

  let content: string;
  if (mention) {
    const prefix = `${mention}\n`;
    const maxBody = DISCORD_MAX_CONTENT_LENGTH - prefix.length;
    const body =
      message.length > maxBody
        ? message.slice(0, maxBody - 1) + "\u2026"
        : message;
    content = `${prefix}${body}`;
  } else {
    content =
      message.length > DISCORD_MAX_CONTENT_LENGTH
        ? message.slice(0, DISCORD_MAX_CONTENT_LENGTH - 1) + "\u2026"
        : message;
  }

  return { content, allowed_mentions };
}

/**
 * Validate Discord webhook URL.
 * Must be HTTPS from discord.com or discordapp.com.
 */
function validateDiscordUrl(webhookUrl: string): boolean {
  try {
    const url = new URL(webhookUrl);
    const allowedHosts = ["discord.com", "discordapp.com"];
    if (
      !allowedHosts.some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    ) {
      return false;
    }
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate Telegram bot token format (digits:alphanumeric).
 */
function validateTelegramToken(token: string): boolean {
  return /^[0-9]+:[A-Za-z0-9_-]+$/.test(token);
}

/**
 * Validate Slack webhook URL.
 * Must be HTTPS from hooks.slack.com.
 */
function validateSlackUrl(webhookUrl: string): boolean {
  try {
    const url = new URL(webhookUrl);
    return (
      url.protocol === "https:" &&
      (url.hostname === "hooks.slack.com" ||
        url.hostname.endsWith(".hooks.slack.com"))
    );
  } catch {
    return false;
  }
}

/**
 * Validate generic webhook URL. Must be HTTPS.
 */
function validateWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Send notification via Discord webhook.
 */
export async function sendDiscord(
  config: DiscordNotificationConfig,
  payload: NotificationPayload,
): Promise<NotificationResult> {
  if (!config.enabled || !config.webhookUrl) {
    return { platform: "discord", success: false, error: "Not configured" };
  }

  if (!validateDiscordUrl(config.webhookUrl)) {
    return {
      platform: "discord",
      success: false,
      error: "Invalid webhook URL",
    };
  }

  try {
    const { content, allowed_mentions } = composeDiscordContent(
      payload.message,
      config.mention,
    );
    const body: Record<string, unknown> = { content, allowed_mentions };
    if (config.username) {
      body.username = config.username;
    }

    const response = await fetch(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        platform: "discord",
        success: false,
        error: `HTTP ${response.status}`,
      };
    }

    return { platform: "discord", success: true };
  } catch (error) {
    return {
      platform: "discord",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Send notification via Discord Bot API (token + channel ID).
 * Bot token and channel ID should be resolved in config layer.
 */
export async function sendDiscordBot(
  config: DiscordBotNotificationConfig,
  payload: NotificationPayload,
): Promise<NotificationResult> {
  if (!config.enabled) {
    return { platform: "discord-bot", success: false, error: "Not enabled" };
  }

  const botToken = config.botToken;
  const channelId = config.channelId;

  if (!botToken || !channelId) {
    return {
      platform: "discord-bot",
      success: false,
      error: "Missing botToken or channelId",
    };
  }

  try {
    const { content, allowed_mentions } = composeDiscordContent(
      payload.message,
      config.mention,
    );
    const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${botToken}`,
      },
      body: JSON.stringify({ content, allowed_mentions }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        platform: "discord-bot",
        success: false,
        error: `HTTP ${response.status}`,
      };
    }

    // NEW: Parse response to extract message ID
    let messageId: string | undefined;
    try {
      const data = (await response.json()) as { id?: string };
      messageId = data?.id;
    } catch {
      // Non-fatal: message was sent, we just can't track it
    }

    return { platform: "discord-bot", success: true, messageId };
  } catch (error) {
    return {
      platform: "discord-bot",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Send notification via Telegram bot API.
 * Uses native https module with IPv4 to avoid fetch/undici IPv6 connectivity issues.
 */
export async function sendTelegram(
  config: TelegramNotificationConfig,
  payload: NotificationPayload,
): Promise<NotificationResult> {
  if (!config.enabled || !config.botToken || !config.chatId) {
    return { platform: "telegram", success: false, error: "Not configured" };
  }

  if (!validateTelegramToken(config.botToken)) {
    return {
      platform: "telegram",
      success: false,
      error: "Invalid bot token format",
    };
  }

  try {
    const body = JSON.stringify({
      chat_id: config.chatId,
      text: payload.message,
      parse_mode: config.parseMode || "Markdown",
    });

    const result = await new Promise<NotificationResult>((resolve) => {
      const req = httpsRequest(
        {
          hostname: "api.telegram.org",
          path: `/bot${config.botToken}/sendMessage`,
          method: "POST",
          family: 4, // Force IPv4 - fetch/undici has IPv6 issues on some systems
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: SEND_TIMEOUT_MS,
        },
        (res) => {
          // Collect response chunks to parse message_id
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              // Parse response to extract message_id
              let messageId: string | undefined;
              try {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
                if (body?.result?.message_id !== undefined) {
                  messageId = String(body.result.message_id);
                }
              } catch {
                // Non-fatal: message was sent, we just can't track it
              }
              resolve({ platform: "telegram", success: true, messageId });
            } else {
              resolve({
                platform: "telegram",
                success: false,
                error: `HTTP ${res.statusCode}`,
              });
            }
          });
        },
      );

      req.on("error", (e) => {
        resolve({ platform: "telegram", success: false, error: e.message });
      });
      req.on("timeout", () => {
        req.destroy();
        resolve({
          platform: "telegram",
          success: false,
          error: "Request timeout",
        });
      });

      req.write(body);
      req.end();
    });

    return result;
  } catch (error) {
    return {
      platform: "telegram",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Compose Slack message text with mention prefix.
 * Slack mentions use formats like <@U12345678>, <!channel>, <!here>, <!everyone>,
 * or <!subteam^S12345> for user groups.
 */
function composeSlackText(
  message: string,
  mention: string | undefined,
): string {
  if (mention) {
    return `${mention}\n${message}`;
  }
  return message;
}

/**
 * Send notification via Slack incoming webhook.
 */
export async function sendSlack(
  config: SlackNotificationConfig,
  payload: NotificationPayload,
): Promise<NotificationResult> {
  if (!config.enabled || !config.webhookUrl) {
    return { platform: "slack", success: false, error: "Not configured" };
  }

  if (!validateSlackUrl(config.webhookUrl)) {
    return { platform: "slack", success: false, error: "Invalid webhook URL" };
  }

  try {
    const text = composeSlackText(payload.message, config.mention);
    const body: Record<string, unknown> = { text };
    if (config.channel) {
      body.channel = config.channel;
    }
    if (config.username) {
      body.username = config.username;
    }

    const response = await fetch(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        platform: "slack",
        success: false,
        error: `HTTP ${response.status}`,
      };
    }

    return { platform: "slack", success: true };
  } catch (error) {
    return {
      platform: "slack",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Send notification via generic webhook (POST JSON).
 */
export async function sendWebhook(
  config: WebhookNotificationConfig,
  payload: NotificationPayload,
): Promise<NotificationResult> {
  if (!config.enabled || !config.url) {
    return { platform: "webhook", success: false, error: "Not configured" };
  }

  if (!validateWebhookUrl(config.url)) {
    return {
      platform: "webhook",
      success: false,
      error: "Invalid URL (HTTPS required)",
    };
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...config.headers,
    };

    const response = await fetch(config.url, {
      method: config.method || "POST",
      headers,
      body: JSON.stringify({
        event: payload.event,
        session_id: payload.sessionId,
        message: payload.message,
        timestamp: payload.timestamp,
        tmux_session: payload.tmuxSession,
        project_name: payload.projectName,
        project_path: payload.projectPath,
        modes_used: payload.modesUsed,
        duration_ms: payload.durationMs,
        reason: payload.reason,
        active_mode: payload.activeMode,
        question: payload.question,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        platform: "webhook",
        success: false,
        error: `HTTP ${response.status}`,
      };
    }

    return { platform: "webhook", success: true };
  } catch (error) {
    return {
      platform: "webhook",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Get the effective platform config for an event.
 * Event-level config overrides top-level defaults.
 */
function getEffectivePlatformConfig<T>(
  platform: NotificationPlatform,
  config: NotificationConfig,
  event: NotificationEvent,
): T | undefined {
  const topLevel = config[platform as keyof NotificationConfig] as T | undefined;
  const eventConfig = config.events?.[event];
  const eventPlatform = eventConfig?.[platform as keyof typeof eventConfig];

  // Event-level override merged with top-level defaults.
  // This ensures fields like `mention` are inherited from top-level
  // when the event-level config omits them.
  if (
    eventPlatform &&
    typeof eventPlatform === "object" &&
    "enabled" in eventPlatform
  ) {
    if (topLevel && typeof topLevel === "object") {
      return { ...topLevel, ...eventPlatform } as T;
    }
    return eventPlatform as T;
  }

  // Top-level default
  return topLevel;
}

/**
 * Dispatch notifications to all enabled platforms for an event.
 *
 * Runs all sends in parallel with an overall timeout.
 * Individual failures don't block other platforms.
 */
export async function dispatchNotifications(
  config: NotificationConfig,
  event: NotificationEvent,
  payload: NotificationPayload,
  platformMessages?: Map<NotificationPlatform, string>,
): Promise<DispatchResult> {
  const promises: Promise<NotificationResult>[] = [];

  /** Get payload for a platform, using per-platform message if available. */
  const payloadFor = (platform: NotificationPlatform): NotificationPayload =>
    platformMessages?.has(platform)
      ? { ...payload, message: platformMessages.get(platform)! }
      : payload;

  // Discord
  const discordConfig = getEffectivePlatformConfig<DiscordNotificationConfig>(
    "discord",
    config,
    event,
  );
  if (discordConfig?.enabled) {
    promises.push(sendDiscord(discordConfig, payloadFor("discord")));
  }

  // Telegram
  const telegramConfig = getEffectivePlatformConfig<TelegramNotificationConfig>(
    "telegram",
    config,
    event,
  );
  if (telegramConfig?.enabled) {
    promises.push(sendTelegram(telegramConfig, payloadFor("telegram")));
  }

  // Slack
  const slackConfig = getEffectivePlatformConfig<SlackNotificationConfig>(
    "slack",
    config,
    event,
  );
  if (slackConfig?.enabled) {
    promises.push(sendSlack(slackConfig, payloadFor("slack")));
  }

  // Webhook
  const webhookConfig = getEffectivePlatformConfig<WebhookNotificationConfig>(
    "webhook",
    config,
    event,
  );
  if (webhookConfig?.enabled) {
    promises.push(sendWebhook(webhookConfig, payloadFor("webhook")));
  }

  // Discord Bot
  const discordBotConfig =
    getEffectivePlatformConfig<DiscordBotNotificationConfig>(
      "discord-bot",
      config,
      event,
    );
  if (discordBotConfig?.enabled) {
    promises.push(sendDiscordBot(discordBotConfig, payloadFor("discord-bot")));
  }

  if (promises.length === 0) {
    return { event, results: [], anySuccess: false };
  }

  // Race all sends against a timeout. Timer is cleared when allSettled wins.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      Promise.allSettled(promises).then((settled) =>
        settled.map((s) =>
          s.status === "fulfilled"
            ? s.value
            : {
                platform: "unknown" as NotificationPlatform,
                success: false,
                error: String(s.reason),
              },
        ),
      ),
      new Promise<NotificationResult[]>((resolve) => {
        timer = setTimeout(
          () =>
            resolve([
              {
                platform: "unknown" as NotificationPlatform,
                success: false,
                error: "Dispatch timeout",
              },
            ]),
          DISPATCH_TIMEOUT_MS,
        );
      }),
    ]);

    return {
      event,
      results,
      anySuccess: results.some((r) => r.success),
    };
  } catch (error) {
    return {
      event,
      results: [
        {
          platform: "unknown" as NotificationPlatform,
          success: false,
          error: String(error),
        },
      ],
      anySuccess: false,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
