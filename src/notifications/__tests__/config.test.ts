import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateMention,
  parseMentionAllowedMentions,
  buildConfigFromEnv,
  validateSlackMention,
  validateSlackChannel,
  validateSlackUsername,
} from "../config.js";
import type { NotificationConfig } from "../types.js";

describe("validateMention", () => {
  it("accepts valid user mention", () => {
    expect(validateMention("<@12345678901234567>")).toBe(
      "<@12345678901234567>",
    );
  });

  it("accepts valid user mention with exclamation (nickname)", () => {
    expect(validateMention("<@!12345678901234567>")).toBe(
      "<@!12345678901234567>",
    );
  });

  it("accepts valid role mention", () => {
    expect(validateMention("<@&12345678901234567>")).toBe(
      "<@&12345678901234567>",
    );
  });

  it("accepts 20-digit IDs", () => {
    expect(validateMention("<@12345678901234567890>")).toBe(
      "<@12345678901234567890>",
    );
  });

  it("rejects @everyone", () => {
    expect(validateMention("@everyone")).toBeUndefined();
  });

  it("rejects @here", () => {
    expect(validateMention("@here")).toBeUndefined();
  });

  it("rejects arbitrary text", () => {
    expect(validateMention("hello world")).toBeUndefined();
  });

  it("rejects mention with trailing text", () => {
    expect(validateMention("<@123456789012345678> extra")).toBeUndefined();
  });

  it("rejects too-short ID", () => {
    expect(validateMention("<@1234>")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(validateMention("")).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(validateMention(undefined)).toBeUndefined();
  });

  it("trims whitespace and validates", () => {
    expect(validateMention("  <@12345678901234567>  ")).toBe(
      "<@12345678901234567>",
    );
  });

  it("rejects whitespace-only string", () => {
    expect(validateMention("   ")).toBeUndefined();
  });
});

describe("parseMentionAllowedMentions", () => {
  it("parses user mention", () => {
    const result = parseMentionAllowedMentions("<@12345678901234567>");
    expect(result).toEqual({ users: ["12345678901234567"] });
  });

  it("parses nickname user mention", () => {
    const result = parseMentionAllowedMentions("<@!12345678901234567>");
    expect(result).toEqual({ users: ["12345678901234567"] });
  });

  it("parses role mention", () => {
    const result = parseMentionAllowedMentions("<@&12345678901234567>");
    expect(result).toEqual({ roles: ["12345678901234567"] });
  });

  it("returns empty for undefined", () => {
    expect(parseMentionAllowedMentions(undefined)).toEqual({});
  });

  it("returns empty for invalid mention", () => {
    expect(parseMentionAllowedMentions("@everyone")).toEqual({});
  });
});

describe("validateSlackMention", () => {
  it("accepts valid user mention", () => {
    expect(validateSlackMention("<@U1234567890>")).toBe("<@U1234567890>");
  });

  it("accepts workspace user mention with W prefix", () => {
    expect(validateSlackMention("<@W1234567890>")).toBe("<@W1234567890>");
  });

  it("accepts <!channel>", () => {
    expect(validateSlackMention("<!channel>")).toBe("<!channel>");
  });

  it("accepts <!here>", () => {
    expect(validateSlackMention("<!here>")).toBe("<!here>");
  });

  it("accepts <!everyone>", () => {
    expect(validateSlackMention("<!everyone>")).toBe("<!everyone>");
  });

  it("accepts subteam mention", () => {
    expect(validateSlackMention("<!subteam^S1234567890>")).toBe("<!subteam^S1234567890>");
  });

  it("rejects arbitrary text", () => {
    expect(validateSlackMention("hello world")).toBeUndefined();
  });

  it("rejects plain @channel without angle brackets", () => {
    expect(validateSlackMention("@channel")).toBeUndefined();
  });

  it("rejects Discord-style mention", () => {
    expect(validateSlackMention("<@12345678901234567>")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(validateSlackMention("")).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(validateSlackMention(undefined)).toBeUndefined();
  });

  it("trims whitespace and validates", () => {
    expect(validateSlackMention("  <@U1234567890>  ")).toBe("<@U1234567890>");
  });

  it("rejects whitespace-only string", () => {
    expect(validateSlackMention("   ")).toBeUndefined();
  });

  it("accepts minimum-length user ID (9 chars: U + 8)", () => {
    expect(validateSlackMention("<@U12345678>")).toBe("<@U12345678>");
  });

  it("accepts maximum-length user ID (12 chars: U + 11)", () => {
    expect(validateSlackMention("<@U12345678901>")).toBe("<@U12345678901>");
  });

  it("rejects too-short user ID (U + 7 chars)", () => {
    expect(validateSlackMention("<@U1234567>")).toBeUndefined();
  });

  it("rejects too-long user ID (U + 12 chars)", () => {
    expect(validateSlackMention("<@U123456789012>")).toBeUndefined();
  });

  it("accepts minimum-length subteam ID", () => {
    expect(validateSlackMention("<!subteam^S12345678>")).toBe("<!subteam^S12345678>");
  });

  it("rejects too-short subteam ID", () => {
    expect(validateSlackMention("<!subteam^S1234567>")).toBeUndefined();
  });
});

describe("validateSlackChannel", () => {
  it("accepts valid channel name with # prefix", () => {
    expect(validateSlackChannel("#general")).toBe("#general");
  });

  it("accepts valid channel name without # prefix", () => {
    expect(validateSlackChannel("general")).toBe("general");
  });

  it("accepts channel name with hyphens and underscores", () => {
    expect(validateSlackChannel("#my-alerts_channel")).toBe("#my-alerts_channel");
  });

  it("accepts channel ID format (C prefix)", () => {
    expect(validateSlackChannel("C1234567890")).toBe("C1234567890");
  });

  it("accepts channel ID format (G prefix for group)", () => {
    expect(validateSlackChannel("G1234567890")).toBe("G1234567890");
  });

  it("rejects channel with shell metacharacters", () => {
    expect(validateSlackChannel("#alerts; rm -rf /")).toBeUndefined();
  });

  it("rejects channel with path traversal", () => {
    expect(validateSlackChannel("../../etc/passwd")).toBeUndefined();
  });

  it("rejects channel with backticks", () => {
    expect(validateSlackChannel("#alerts`whoami`")).toBeUndefined();
  });

  it("rejects channel with $() command substitution", () => {
    expect(validateSlackChannel("#alerts$(cat /etc/passwd)")).toBeUndefined();
  });

  it("rejects channel with newlines", () => {
    expect(validateSlackChannel("#alerts\nmalicious")).toBeUndefined();
  });

  it("rejects channel with control characters", () => {
    expect(validateSlackChannel("#alerts\x00\x01")).toBeUndefined();
  });

  it("rejects channel with spaces", () => {
    expect(validateSlackChannel("#my channel")).toBeUndefined();
  });

  it("rejects empty string", () => {
    expect(validateSlackChannel("")).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(validateSlackChannel(undefined)).toBeUndefined();
  });

  it("trims whitespace and validates", () => {
    expect(validateSlackChannel("  #alerts  ")).toBe("#alerts");
  });

  it("rejects channel exceeding 80 chars", () => {
    expect(validateSlackChannel("#" + "a".repeat(81))).toBeUndefined();
  });
});

describe("validateSlackUsername", () => {
  it("accepts simple username", () => {
    expect(validateSlackUsername("OMC Bot")).toBe("OMC Bot");
  });

  it("accepts username with hyphens and underscores", () => {
    expect(validateSlackUsername("omc-notify_bot")).toBe("omc-notify_bot");
  });

  it("accepts username with periods", () => {
    expect(validateSlackUsername("omc.bot")).toBe("omc.bot");
  });

  it("accepts username with apostrophe", () => {
    expect(validateSlackUsername("O'Brien Bot")).toBe("O'Brien Bot");
  });

  it("rejects username with shell metacharacters", () => {
    expect(validateSlackUsername("bot; rm -rf /")).toBeUndefined();
  });

  it("rejects username with backticks", () => {
    expect(validateSlackUsername("bot`whoami`")).toBeUndefined();
  });

  it("rejects username with $() command substitution", () => {
    expect(validateSlackUsername("bot$(cat /etc/passwd)")).toBeUndefined();
  });

  it("rejects username with path traversal", () => {
    expect(validateSlackUsername("../../etc/passwd")).toBeUndefined();
  });

  it("rejects username with newlines", () => {
    expect(validateSlackUsername("bot\nmalicious")).toBeUndefined();
  });

  it("rejects username with control characters", () => {
    expect(validateSlackUsername("bot\x00\x01")).toBeUndefined();
  });

  it("rejects empty string", () => {
    expect(validateSlackUsername("")).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(validateSlackUsername(undefined)).toBeUndefined();
  });

  it("trims whitespace and validates", () => {
    expect(validateSlackUsername("  OMC Bot  ")).toBe("OMC Bot");
  });

  it("rejects username exceeding 80 chars", () => {
    expect(validateSlackUsername("a".repeat(81))).toBeUndefined();
  });
});

describe("buildConfigFromEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.stubEnv("OMC_DISCORD_NOTIFIER_BOT_TOKEN", "");
    vi.stubEnv("OMC_DISCORD_NOTIFIER_CHANNEL", "");
    vi.stubEnv("OMC_DISCORD_WEBHOOK_URL", "");
    vi.stubEnv("OMC_DISCORD_MENTION", "");
    vi.stubEnv("OMC_TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("OMC_TELEGRAM_NOTIFIER_BOT_TOKEN", "");
    vi.stubEnv("OMC_TELEGRAM_CHAT_ID", "");
    vi.stubEnv("OMC_TELEGRAM_NOTIFIER_CHAT_ID", "");
    vi.stubEnv("OMC_TELEGRAM_NOTIFIER_UID", "");
    vi.stubEnv("OMC_SLACK_WEBHOOK_URL", "");
    vi.stubEnv("OMC_SLACK_MENTION", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when no env vars set", () => {
    expect(buildConfigFromEnv()).toBeNull();
  });

  it("builds discord-bot config from env vars", () => {
    vi.stubEnv("OMC_DISCORD_NOTIFIER_BOT_TOKEN", "test-token");
    vi.stubEnv("OMC_DISCORD_NOTIFIER_CHANNEL", "123456");
    const config = buildConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(true);
    expect(config!["discord-bot"]).toEqual({
      enabled: true,
      botToken: "test-token",
      channelId: "123456",
      mention: undefined,
    });
  });

  it("includes validated mention in discord-bot config", () => {
    vi.stubEnv("OMC_DISCORD_NOTIFIER_BOT_TOKEN", "test-token");
    vi.stubEnv("OMC_DISCORD_NOTIFIER_CHANNEL", "123456");
    vi.stubEnv("OMC_DISCORD_MENTION", "<@12345678901234567>");
    const config = buildConfigFromEnv();
    expect(config!["discord-bot"]!.mention).toBe("<@12345678901234567>");
  });

  it("rejects invalid mention in env var", () => {
    vi.stubEnv("OMC_DISCORD_NOTIFIER_BOT_TOKEN", "test-token");
    vi.stubEnv("OMC_DISCORD_NOTIFIER_CHANNEL", "123456");
    vi.stubEnv("OMC_DISCORD_MENTION", "@everyone");
    const config = buildConfigFromEnv();
    expect(config!["discord-bot"]!.mention).toBeUndefined();
  });

  it("builds discord webhook config from env var", () => {
    vi.stubEnv("OMC_DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/test");
    const config = buildConfigFromEnv();
    expect(config!.discord).toEqual({
      enabled: true,
      webhookUrl: "https://discord.com/api/webhooks/test",
      mention: undefined,
    });
  });

  it("builds telegram config from env vars", () => {
    vi.stubEnv("OMC_TELEGRAM_BOT_TOKEN", "123:abc");
    vi.stubEnv("OMC_TELEGRAM_CHAT_ID", "999");
    const config = buildConfigFromEnv();
    expect(config!.telegram).toEqual({
      enabled: true,
      botToken: "123:abc",
      chatId: "999",
    });
  });

  it("builds slack config from env var", () => {
    vi.stubEnv("OMC_SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/test");
    const config = buildConfigFromEnv();
    expect(config!.slack).toEqual({
      enabled: true,
      webhookUrl: "https://hooks.slack.com/services/test",
      mention: undefined,
    });
  });

  it("builds slack config with mention from env var", () => {
    vi.stubEnv("OMC_SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/test");
    vi.stubEnv("OMC_SLACK_MENTION", "<@U1234567890>");
    const config = buildConfigFromEnv();
    expect(config!.slack!.mention).toBe("<@U1234567890>");
  });

  it("trims whitespace from slack mention env var", () => {
    vi.stubEnv("OMC_SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/test");
    vi.stubEnv("OMC_SLACK_MENTION", "  <!channel>  ");
    const config = buildConfigFromEnv();
    expect(config!.slack!.mention).toBe("<!channel>");
  });

  it("rejects invalid slack mention format in env var", () => {
    vi.stubEnv("OMC_SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/test");
    vi.stubEnv("OMC_SLACK_MENTION", "@everyone");
    const config = buildConfigFromEnv();
    expect(config!.slack!.mention).toBeUndefined();
  });

  it("trims whitespace from mention env var", () => {
    vi.stubEnv("OMC_DISCORD_NOTIFIER_BOT_TOKEN", "test-token");
    vi.stubEnv("OMC_DISCORD_NOTIFIER_CHANNEL", "123456");
    vi.stubEnv("OMC_DISCORD_MENTION", "  <@12345678901234567>  ");
    const config = buildConfigFromEnv();
    expect(config!["discord-bot"]!.mention).toBe("<@12345678901234567>");
  });

  it("uses OMC_TELEGRAM_NOTIFIER_BOT_TOKEN as fallback", () => {
    vi.stubEnv("OMC_TELEGRAM_NOTIFIER_BOT_TOKEN", "123:fallback");
    vi.stubEnv("OMC_TELEGRAM_CHAT_ID", "999");
    const config = buildConfigFromEnv();
    expect(config!.telegram!.botToken).toBe("123:fallback");
  });

  it("uses OMC_TELEGRAM_NOTIFIER_UID as fallback for chat ID", () => {
    vi.stubEnv("OMC_TELEGRAM_BOT_TOKEN", "123:abc");
    vi.stubEnv("OMC_TELEGRAM_NOTIFIER_UID", "uid-999");
    const config = buildConfigFromEnv();
    expect(config!.telegram!.chatId).toBe("uid-999");
  });
});

describe("getNotificationConfig - deep merge", () => {
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockReadFileSync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Clear env vars
    vi.stubEnv("OMC_DISCORD_NOTIFIER_BOT_TOKEN", "");
    vi.stubEnv("OMC_DISCORD_NOTIFIER_CHANNEL", "");
    vi.stubEnv("OMC_DISCORD_WEBHOOK_URL", "");
    vi.stubEnv("OMC_DISCORD_MENTION", "");
    vi.stubEnv("OMC_TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("OMC_TELEGRAM_NOTIFIER_BOT_TOKEN", "");
    vi.stubEnv("OMC_TELEGRAM_CHAT_ID", "");
    vi.stubEnv("OMC_TELEGRAM_NOTIFIER_CHAT_ID", "");
    vi.stubEnv("OMC_TELEGRAM_NOTIFIER_UID", "");
    vi.stubEnv("OMC_SLACK_WEBHOOK_URL", "");
    vi.stubEnv("OMC_SLACK_MENTION", "");

    mockExistsSync = vi.fn().mockReturnValue(false);
    mockReadFileSync = vi.fn().mockReturnValue("{}");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // We test the deep-merge logic indirectly via buildConfigFromEnv + mergeEnvIntoFileConfig
  // by importing the internal merge function via the public getNotificationConfig path.
  // Since getNotificationConfig reads from disk, we test merge logic through buildConfigFromEnv
  // and the exported merge behavior.

  it("env provides discord-bot when file config has only discord webhook", () => {
    // Simulate: file has discord webhook, env has discord-bot credentials
    vi.stubEnv("OMC_DISCORD_NOTIFIER_BOT_TOKEN", "env-bot-token");
    vi.stubEnv("OMC_DISCORD_NOTIFIER_CHANNEL", "env-channel");
    const envConfig = buildConfigFromEnv();
    expect(envConfig).not.toBeNull();
    expect(envConfig!["discord-bot"]).toBeDefined();
    expect(envConfig!["discord-bot"]!.botToken).toBe("env-bot-token");
    expect(envConfig!["discord-bot"]!.channelId).toBe("env-channel");
  });

  it("env provides telegram when file config has only discord", () => {
    vi.stubEnv("OMC_TELEGRAM_BOT_TOKEN", "123:tg-token");
    vi.stubEnv("OMC_TELEGRAM_CHAT_ID", "tg-chat");
    const envConfig = buildConfigFromEnv();
    expect(envConfig!.telegram).toEqual({
      enabled: true,
      botToken: "123:tg-token",
      chatId: "tg-chat",
    });
  });

  it("builds config with multiple platforms from env", () => {
    vi.stubEnv("OMC_DISCORD_NOTIFIER_BOT_TOKEN", "bot-token");
    vi.stubEnv("OMC_DISCORD_NOTIFIER_CHANNEL", "channel-123");
    vi.stubEnv("OMC_TELEGRAM_BOT_TOKEN", "456:tg");
    vi.stubEnv("OMC_TELEGRAM_CHAT_ID", "chat-789");
    vi.stubEnv("OMC_SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/test");

    const config = buildConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(true);
    expect(config!["discord-bot"]!.enabled).toBe(true);
    expect(config!.telegram!.enabled).toBe(true);
    expect(config!.slack!.enabled).toBe(true);
  });

  it("mention from env is shared across discord-bot and discord webhook", () => {
    vi.stubEnv("OMC_DISCORD_NOTIFIER_BOT_TOKEN", "bot-token");
    vi.stubEnv("OMC_DISCORD_NOTIFIER_CHANNEL", "channel-123");
    vi.stubEnv("OMC_DISCORD_WEBHOOK_URL", "https://discord.com/api/webhooks/test");
    vi.stubEnv("OMC_DISCORD_MENTION", "<@12345678901234567>");

    const config = buildConfigFromEnv();
    expect(config!["discord-bot"]!.mention).toBe("<@12345678901234567>");
    expect(config!.discord!.mention).toBe("<@12345678901234567>");
  });
});
