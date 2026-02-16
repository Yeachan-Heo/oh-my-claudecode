import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type RawConfig = Record<string, unknown> | null;

const VALID_DISCORD_USER_ID = "123456789012345678";
const ORIGINAL_ENV = process.env;

function mockConfigFile(rawConfig: RawConfig): void {
  vi.doMock("fs", () => ({
    existsSync: vi.fn(() => rawConfig !== null),
    readFileSync: vi.fn(() => JSON.stringify(rawConfig ?? {})),
  }));
}

describe("reply config", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.OMC_REPLY_ENABLED;
    delete process.env.OMC_REPLY_POLL_INTERVAL_MS;
    delete process.env.OMC_REPLY_RATE_LIMIT;
    delete process.env.OMC_REPLY_DISCORD_USER_IDS;
    delete process.env.OMC_REPLY_INCLUDE_PREFIX;
    delete process.env.OMC_DISCORD_NOTIFIER_BOT_TOKEN;
    delete process.env.OMC_DISCORD_NOTIFIER_CHANNEL;
    delete process.env.OMC_DISCORD_WEBHOOK_URL;
    delete process.env.OMC_DISCORD_MENTION;
    delete process.env.OMC_TELEGRAM_BOT_TOKEN;
    delete process.env.OMC_TELEGRAM_NOTIFIER_BOT_TOKEN;
    delete process.env.OMC_TELEGRAM_CHAT_ID;
    delete process.env.OMC_TELEGRAM_NOTIFIER_CHAT_ID;
    delete process.env.OMC_TELEGRAM_NOTIFIER_UID;
    delete process.env.OMC_SLACK_WEBHOOK_URL;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("enables reply config when reply-capable platform exists only at event level", async () => {
    mockConfigFile({
      notifications: {
        enabled: true,
        events: {
          "ask-user-question": {
            telegram: {
              enabled: true,
              botToken: "tg-token-event",
              chatId: "tg-chat-event",
            },
          },
        },
        reply: {
          enabled: true,
          rateLimitPerMinute: 12,
        },
      },
    });

    const {
      getReplyConfig,
      getNotificationConfig,
      getReplyListenerPlatformConfig,
    } = await import("../config.js");

    const replyConfig = getReplyConfig();
    expect(replyConfig).not.toBeNull();
    expect(replyConfig?.rateLimitPerMinute).toBe(12);

    const notifConfig = getNotificationConfig();
    const runtime = getReplyListenerPlatformConfig(notifConfig);
    expect(runtime.telegramBotToken).toBe("tg-token-event");
    expect(runtime.telegramChatId).toBe("tg-chat-event");
  });

  it("returns null when reply is enabled but no reply-capable platform is configured", async () => {
    mockConfigFile({
      notifications: {
        enabled: true,
        discord: {
          enabled: true,
          webhookUrl: "https://discord.com/api/webhooks/abc/123",
        },
        reply: {
          enabled: true,
        },
      },
    });

    const { getReplyConfig } = await import("../config.js");
    expect(getReplyConfig()).toBeNull();
  });

  it("warns when discord-bot is enabled but authorizedDiscordUserIds is empty", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockConfigFile({
      notifications: {
        enabled: true,
        "discord-bot": {
          enabled: true,
          botToken: "discord-token",
          channelId: "discord-channel",
        },
        reply: {
          enabled: true,
        },
      },
    });

    const { getReplyConfig } = await import("../config.js");
    const replyConfig = getReplyConfig();

    expect(replyConfig).not.toBeNull();
    expect(replyConfig?.authorizedDiscordUserIds).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("applies environment overrides for reply settings and discord user IDs", async () => {
    process.env.OMC_REPLY_POLL_INTERVAL_MS = "5000";
    process.env.OMC_REPLY_RATE_LIMIT = "20";
    process.env.OMC_REPLY_INCLUDE_PREFIX = "false";
    process.env.OMC_REPLY_DISCORD_USER_IDS = `${VALID_DISCORD_USER_ID},invalid-id`;

    mockConfigFile({
      notifications: {
        enabled: true,
        "discord-bot": {
          enabled: true,
          botToken: "discord-token",
          channelId: "discord-channel",
        },
        reply: {
          enabled: true,
          pollIntervalMs: 1000,
          rateLimitPerMinute: 5,
          includePrefix: true,
          authorizedDiscordUserIds: ["999999999999999999"],
        },
      },
    });

    const { getReplyConfig } = await import("../config.js");
    const replyConfig = getReplyConfig();

    expect(replyConfig).not.toBeNull();
    expect(replyConfig?.pollIntervalMs).toBe(5000);
    expect(replyConfig?.rateLimitPerMinute).toBe(20);
    expect(replyConfig?.includePrefix).toBe(false);
    expect(replyConfig?.authorizedDiscordUserIds).toEqual([
      VALID_DISCORD_USER_ID,
    ]);
  });

  it("resolves discord credentials from event-level config and falls back to top-level tokens", async () => {
    mockConfigFile({
      notifications: {
        enabled: true,
        "discord-bot": {
          enabled: false,
          botToken: "top-level-token",
          channelId: "top-level-channel",
        },
        events: {
          "session-end": {
            "discord-bot": {
              enabled: true,
            },
          },
        },
        reply: {
          enabled: true,
          authorizedDiscordUserIds: [VALID_DISCORD_USER_ID],
        },
      },
    });

    const { getNotificationConfig, getReplyListenerPlatformConfig } = await import(
      "../config.js"
    );
    const notifConfig = getNotificationConfig();
    const runtime = getReplyListenerPlatformConfig(notifConfig);

    expect(runtime.discordBotToken).toBe("top-level-token");
    expect(runtime.discordChannelId).toBe("top-level-channel");
  });
});
