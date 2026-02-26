import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  DiscordNotificationConfig,
  DiscordBotNotificationConfig,
  TelegramNotificationConfig,
  SlackNotificationConfig,
  WebhookNotificationConfig,
  NotificationPayload,
  NotificationConfig,
} from "../types.js";

// Mock https.request for Telegram tests
vi.mock("https", () => {
  const EventEmitter = require("events");
  return {
    request: vi.fn((_opts: unknown, callback: (res: unknown) => void) => {
      const req = new EventEmitter();
      req.write = vi.fn();
      req.end = vi.fn(() => {
        // Simulate successful response by default
        const res = new EventEmitter();
        res.statusCode = 200;
        res.resume = vi.fn();
        callback(res);
        // Emit response data with message_id
        setImmediate(() => {
          const responseBody = JSON.stringify({
            ok: true,
            result: { message_id: 12345 },
          });
          res.emit("data", Buffer.from(responseBody));
          res.emit("end");
        });
      });
      req.destroy = vi.fn();
      return req;
    }),
  };
});

import {
  sendDiscord,
  sendDiscordBot,
  sendTelegram,
  sendSlack,
  sendWebhook,
  dispatchNotifications,
} from "../dispatcher.js";

describe("timeout constants invariant", () => {
  it("DISPATCH_TIMEOUT_MS >= SEND_TIMEOUT_MS in source", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "dispatcher.ts"),
      "utf-8",
    );
    const sendMatch = source.match(/SEND_TIMEOUT_MS\s*=\s*([\d_]+)/);
    const dispatchMatch = source.match(/DISPATCH_TIMEOUT_MS\s*=\s*([\d_]+)/);
    expect(sendMatch).not.toBeNull();
    expect(dispatchMatch).not.toBeNull();
    const sendTimeout = Number(sendMatch![1].replace(/_/g, ""));
    const dispatchTimeout = Number(dispatchMatch![1].replace(/_/g, ""));
    expect(dispatchTimeout).toBeGreaterThanOrEqual(sendTimeout);
  });
});

const basePayload: NotificationPayload = {
  event: "session-end",
  sessionId: "test-session-123",
  message: "Test notification message",
  timestamp: new Date().toISOString(),
};

describe("sendDiscord", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns not configured when disabled", async () => {
    const config: DiscordNotificationConfig = {
      enabled: false,
      webhookUrl: "https://discord.com/api/webhooks/test",
    };
    const result = await sendDiscord(config, basePayload);
    expect(result).toEqual({
      platform: "discord",
      success: false,
      error: "Not configured",
    });
  });

  it("returns not configured when webhookUrl is empty", async () => {
    const config: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: "",
    };
    const result = await sendDiscord(config, basePayload);
    expect(result).toEqual({
      platform: "discord",
      success: false,
      error: "Not configured",
    });
  });

  it("rejects non-discord webhook URL", async () => {
    const config: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: "https://evil.com/webhook",
    };
    const result = await sendDiscord(config, basePayload);
    expect(result).toEqual({
      platform: "discord",
      success: false,
      error: "Invalid webhook URL",
    });
  });

  it("rejects HTTP (non-HTTPS) webhook URL", async () => {
    const config: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: "http://discord.com/api/webhooks/test",
    };
    const result = await sendDiscord(config, basePayload);
    expect(result).toEqual({
      platform: "discord",
      success: false,
      error: "Invalid webhook URL",
    });
  });

  it("sends successfully with valid config", async () => {
    const config: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
    };
    const result = await sendDiscord(config, basePayload);
    expect(result).toEqual({ platform: "discord", success: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("includes allowed_mentions with empty parse array in payload", async () => {
    const config: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
    };
    await sendDiscord(config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.allowed_mentions).toBeDefined();
    expect(body.allowed_mentions.parse).toEqual([]);
  });

  it("includes user in allowed_mentions when mention is a user", async () => {
    const config: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
      mention: "<@12345678901234567>",
    };
    await sendDiscord(config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.allowed_mentions.users).toEqual(["12345678901234567"]);
    expect(body.content).toContain("<@12345678901234567>");
  });

  it("includes role in allowed_mentions when mention is a role", async () => {
    const config: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
      mention: "<@&12345678901234567>",
    };
    await sendDiscord(config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.allowed_mentions.roles).toEqual(["12345678901234567"]);
  });

  it("truncates message to 2000 chars when no mention", async () => {
    const longMessage = "A".repeat(2500);
    const config: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
    };
    await sendDiscord(config, { ...basePayload, message: longMessage });
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.content.length).toBeLessThanOrEqual(2000);
    expect(body.content.endsWith("\u2026")).toBe(true);
  });

  it("truncates message body to fit mention + content within 2000 chars", async () => {
    const mention = "<@12345678901234567>";
    const longMessage = "B".repeat(2500);
    const config: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
      mention,
    };
    await sendDiscord(config, { ...basePayload, message: longMessage });
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.content.length).toBeLessThanOrEqual(2000);
    expect(body.content.startsWith(mention)).toBe(true);
  });

  it("includes username when configured", async () => {
    const config: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
      username: "OMC Bot",
    };
    await sendDiscord(config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.username).toBe("OMC Bot");
  });

  it("returns error on HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403 }),
    );
    const config: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
    };
    const result = await sendDiscord(config, basePayload);
    expect(result).toEqual({
      platform: "discord",
      success: false,
      error: "HTTP 403",
    });
  });

  it("returns error on fetch exception", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network failure")),
    );
    const config: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
    };
    const result = await sendDiscord(config, basePayload);
    expect(result).toEqual({
      platform: "discord",
      success: false,
      error: "Network failure",
    });
  });
});

describe("sendDiscordBot", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "1234567890" }),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns not enabled when disabled", async () => {
    const config: DiscordBotNotificationConfig = {
      enabled: false,
      botToken: "token",
      channelId: "123",
    };
    const result = await sendDiscordBot(config, basePayload);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Not enabled");
  });

  it("returns error when botToken is missing", async () => {
    const config: DiscordBotNotificationConfig = {
      enabled: true,
      channelId: "123",
    };
    const result = await sendDiscordBot(config, basePayload);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Missing botToken or channelId");
  });

  it("returns error when channelId is missing", async () => {
    const config: DiscordBotNotificationConfig = {
      enabled: true,
      botToken: "token",
    };
    const result = await sendDiscordBot(config, basePayload);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Missing botToken or channelId");
  });

  it("sends successfully with valid config", async () => {
    const config: DiscordBotNotificationConfig = {
      enabled: true,
      botToken: "test-bot-token",
      channelId: "999888777",
    };
    const result = await sendDiscordBot(config, basePayload);
    expect(result).toEqual({
      platform: "discord-bot",
      success: true,
      messageId: "1234567890",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe(
      "https://discord.com/api/v10/channels/999888777/messages",
    );
    expect((call[1]!.headers as Record<string, string>).Authorization).toBe(
      "Bot test-bot-token",
    );
  });

  it("includes allowed_mentions in bot API payload", async () => {
    const config: DiscordBotNotificationConfig = {
      enabled: true,
      botToken: "test-bot-token",
      channelId: "999888777",
      mention: "<@12345678901234567>",
    };
    await sendDiscordBot(config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.allowed_mentions).toBeDefined();
    expect(body.allowed_mentions.parse).toEqual([]);
    expect(body.allowed_mentions.users).toEqual(["12345678901234567"]);
  });

  it("returns success with messageId when response JSON is valid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "9876543210" }),
      }),
    );

    const config: DiscordBotNotificationConfig = {
      enabled: true,
      botToken: "test-bot-token",
      channelId: "999888777",
    };
    const result = await sendDiscordBot(config, basePayload);
    expect(result.success).toBe(true);
    expect(result.messageId).toBe("9876543210");
  });

  it("returns success without messageId when response JSON parse fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Invalid JSON");
        },
      }),
    );

    const config: DiscordBotNotificationConfig = {
      enabled: true,
      botToken: "test-bot-token",
      channelId: "999888777",
    };
    const result = await sendDiscordBot(config, basePayload);
    expect(result.success).toBe(true);
    expect(result.messageId).toBeUndefined();
  });
});

describe("sendTelegram", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns not configured when disabled", async () => {
    const config: TelegramNotificationConfig = {
      enabled: false,
      botToken: "123:abc",
      chatId: "999",
    };
    const result = await sendTelegram(config, basePayload);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Not configured");
  });

  it("returns not configured when botToken is empty", async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: "",
      chatId: "999",
    };
    const result = await sendTelegram(config, basePayload);
    expect(result.success).toBe(false);
  });

  it("rejects invalid bot token format", async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: "invalid-token",
      chatId: "999",
    };
    const result = await sendTelegram(config, basePayload);
    expect(result).toEqual({
      platform: "telegram",
      success: false,
      error: "Invalid bot token format",
    });
  });

  it("sends successfully with valid config", async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: "123456:ABCdef",
      chatId: "999",
    };
    const result = await sendTelegram(config, basePayload);
    expect(result).toEqual({
      platform: "telegram",
      success: true,
      messageId: "12345",
    });
  });

  it("uses httpsRequest with family:4 for IPv4", async () => {
    const { request } = await import("https");
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: "123456:ABCdef",
      chatId: "999",
    };
    await sendTelegram(config, basePayload);

    expect(request).toHaveBeenCalled();
    const callArgs = vi.mocked(request).mock.calls[0][0];
    expect(callArgs).toHaveProperty("family", 4);
  });

  it("handles response parse failure gracefully", async () => {
    const { request } = await import("https");
    const EventEmitter = require("events");

    // Mock request to return invalid JSON
    vi.mocked(request).mockImplementationOnce((...args: any[]) => {
      const callback = args[args.length - 1] as (res: unknown) => void;
      const req = new EventEmitter();
      (req as any).write = vi.fn();
      (req as any).end = vi.fn(() => {
        const res = new EventEmitter();
        (res as any).statusCode = 200;
        callback(res);
        setImmediate(() => {
          res.emit("data", Buffer.from("invalid json"));
          res.emit("end");
        });
      });
      (req as any).destroy = vi.fn();
      return req as any;
    });

    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: "123456:ABCdef",
      chatId: "999",
    };
    const result = await sendTelegram(config, basePayload);

    // Should still succeed, just without messageId
    expect(result.success).toBe(true);
    expect(result.messageId).toBeUndefined();
  });

  it("collects response chunks using data/end events", async () => {
    const { request } = await import("https");
    const EventEmitter = require("events");

    // Verify that chunk collection pattern is used (not res.resume())
    let dataHandlerRegistered = false;
    let endHandlerRegistered = false;

    vi.mocked(request).mockImplementationOnce((...args: any[]) => {
      const callback = args[args.length - 1] as (res: unknown) => void;
      const req = new EventEmitter();
      (req as any).write = vi.fn();
      (req as any).end = vi.fn(() => {
        const res = new EventEmitter();
        (res as any).statusCode = 200;

        // Override on() to detect handler registration
        const originalOn = res.on.bind(res);
        (res as any).on = (
          event: string,
          handler: (...args: unknown[]) => unknown,
        ) => {
          if (event === "data") dataHandlerRegistered = true;
          if (event === "end") endHandlerRegistered = true;
          return originalOn(event, handler);
        };

        callback(res);
        setImmediate(() => {
          const responseBody = JSON.stringify({
            ok: true,
            result: { message_id: 99999 },
          });
          res.emit("data", Buffer.from(responseBody));
          res.emit("end");
        });
      });
      req.destroy = vi.fn();
      return req;
    });

    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: "123456:ABCdef",
      chatId: "999",
    };
    await sendTelegram(config, basePayload);

    expect(dataHandlerRegistered).toBe(true);
    expect(endHandlerRegistered).toBe(true);
  });
});

describe("sendSlack", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns not configured when disabled", async () => {
    const config: SlackNotificationConfig = {
      enabled: false,
      webhookUrl: "https://hooks.slack.com/services/test",
    };
    const result = await sendSlack(config, basePayload);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Not configured");
  });

  it("rejects non-slack webhook URL", async () => {
    const config: SlackNotificationConfig = {
      enabled: true,
      webhookUrl: "https://evil.com/webhook",
    };
    const result = await sendSlack(config, basePayload);
    expect(result).toEqual({
      platform: "slack",
      success: false,
      error: "Invalid webhook URL",
    });
  });

  it("sends successfully with valid config", async () => {
    const config: SlackNotificationConfig = {
      enabled: true,
      webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
    };
    const result = await sendSlack(config, basePayload);
    expect(result).toEqual({ platform: "slack", success: true });
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.text).toBe(basePayload.message);
  });

  it("includes channel and username when configured", async () => {
    const config: SlackNotificationConfig = {
      enabled: true,
      webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
      channel: "#alerts",
      username: "OMC",
    };
    await sendSlack(config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.channel).toBe("#alerts");
    expect(body.username).toBe("OMC");
  });

  it("prepends user mention to message text", async () => {
    const config: SlackNotificationConfig = {
      enabled: true,
      webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
      mention: "<@U1234567890>",
    };
    await sendSlack(config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.text).toContain("<@U1234567890>");
    expect(body.text).toMatch(/^<@U1234567890>\n/);
  });

  it("prepends channel mention to message text", async () => {
    const config: SlackNotificationConfig = {
      enabled: true,
      webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
      mention: "<!channel>",
    };
    await sendSlack(config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.text).toMatch(/^<!channel>\n/);
  });

  it("prepends here mention to message text", async () => {
    const config: SlackNotificationConfig = {
      enabled: true,
      webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
      mention: "<!here>",
    };
    await sendSlack(config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.text).toMatch(/^<!here>\n/);
  });

  it("prepends subteam mention to message text", async () => {
    const config: SlackNotificationConfig = {
      enabled: true,
      webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
      mention: "<!subteam^S1234567890>",
    };
    await sendSlack(config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.text).toMatch(/^<!subteam\^S1234567890>\n/);
  });

  it("sends text without mention prefix when mention is undefined", async () => {
    const config: SlackNotificationConfig = {
      enabled: true,
      webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
    };
    await sendSlack(config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.text).toBe(basePayload.message);
  });

  it("returns not configured when webhookUrl is empty", async () => {
    const config: SlackNotificationConfig = {
      enabled: true,
      webhookUrl: "",
    };
    const result = await sendSlack(config, basePayload);
    expect(result).toEqual({
      platform: "slack",
      success: false,
      error: "Not configured",
    });
  });

  it("rejects HTTP (non-HTTPS) webhook URL", async () => {
    const config: SlackNotificationConfig = {
      enabled: true,
      webhookUrl: "http://hooks.slack.com/services/T00/B00/xxx",
    };
    const result = await sendSlack(config, basePayload);
    expect(result).toEqual({
      platform: "slack",
      success: false,
      error: "Invalid webhook URL",
    });
  });

  it("returns error on HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403 }),
    );
    const config: SlackNotificationConfig = {
      enabled: true,
      webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
    };
    const result = await sendSlack(config, basePayload);
    expect(result).toEqual({
      platform: "slack",
      success: false,
      error: "HTTP 403",
    });
  });

  it("returns error on fetch exception", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network failure")),
    );
    const config: SlackNotificationConfig = {
      enabled: true,
      webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
    };
    const result = await sendSlack(config, basePayload);
    expect(result).toEqual({
      platform: "slack",
      success: false,
      error: "Network failure",
    });
  });
});

describe("sendWebhook", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns not configured when disabled", async () => {
    const config: WebhookNotificationConfig = {
      enabled: false,
      url: "https://example.com/hook",
    };
    const result = await sendWebhook(config, basePayload);
    expect(result.success).toBe(false);
  });

  it("rejects HTTP URL (requires HTTPS)", async () => {
    const config: WebhookNotificationConfig = {
      enabled: true,
      url: "http://example.com/hook",
    };
    const result = await sendWebhook(config, basePayload);
    expect(result).toEqual({
      platform: "webhook",
      success: false,
      error: "Invalid URL (HTTPS required)",
    });
  });

  it("sends successfully with valid HTTPS URL", async () => {
    const config: WebhookNotificationConfig = {
      enabled: true,
      url: "https://example.com/hook",
    };
    const result = await sendWebhook(config, basePayload);
    expect(result).toEqual({ platform: "webhook", success: true });
  });

  it("includes custom headers", async () => {
    const config: WebhookNotificationConfig = {
      enabled: true,
      url: "https://example.com/hook",
      headers: { "X-Custom": "value" },
    };
    await sendWebhook(config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    expect((call[1]!.headers as Record<string, string>)["X-Custom"]).toBe(
      "value",
    );
  });

  it("uses configured method", async () => {
    const config: WebhookNotificationConfig = {
      enabled: true,
      url: "https://example.com/hook",
      method: "PUT",
    };
    await sendWebhook(config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[1]!.method).toBe("PUT");
  });
});

describe("dispatchNotifications", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty results when no platforms enabled", async () => {
    const config: NotificationConfig = { enabled: true };
    const result = await dispatchNotifications(
      config,
      "session-end",
      basePayload,
    );
    expect(result).toEqual({
      event: "session-end",
      results: [],
      anySuccess: false,
    });
  });

  it("dispatches to single enabled platform", async () => {
    const config: NotificationConfig = {
      enabled: true,
      slack: {
        enabled: true,
        webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
      },
    };
    const result = await dispatchNotifications(
      config,
      "session-end",
      basePayload,
    );
    expect(result.anySuccess).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].platform).toBe("slack");
  });

  it("dispatches to multiple enabled platforms in parallel", async () => {
    const config: NotificationConfig = {
      enabled: true,
      slack: {
        enabled: true,
        webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
      },
      discord: {
        enabled: true,
        webhookUrl: "https://discord.com/api/webhooks/123/abc",
      },
    };
    const result = await dispatchNotifications(
      config,
      "session-end",
      basePayload,
    );
    expect(result.anySuccess).toBe(true);
    expect(result.results.length).toBeGreaterThanOrEqual(2);
  });

  it("reports anySuccess=true when at least one platform succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("slack")) {
          return Promise.resolve({ ok: false, status: 500 });
        }
        return Promise.resolve({ ok: true, status: 200 });
      }),
    );
    const config: NotificationConfig = {
      enabled: true,
      slack: {
        enabled: true,
        webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
      },
      discord: {
        enabled: true,
        webhookUrl: "https://discord.com/api/webhooks/123/abc",
      },
    };
    const result = await dispatchNotifications(
      config,
      "session-end",
      basePayload,
    );
    expect(result.anySuccess).toBe(true);
  });

  it("uses event-level platform config override", async () => {
    const config: NotificationConfig = {
      enabled: true,
      slack: {
        enabled: false,
        webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
      },
      events: {
        "session-end": {
          enabled: true,
          slack: {
            enabled: true,
            webhookUrl: "https://hooks.slack.com/services/T00/B00/override",
          },
        },
      },
    };
    const result = await dispatchNotifications(
      config,
      "session-end",
      basePayload,
    );
    expect(result.anySuccess).toBe(true);
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe(
      "https://hooks.slack.com/services/T00/B00/override",
    );
  });

  it("uses discord-bot platform config", async () => {
    const config: NotificationConfig = {
      enabled: true,
      "discord-bot": {
        enabled: true,
        botToken: "test-token",
        channelId: "123456",
      },
    };
    const result = await dispatchNotifications(
      config,
      "session-end",
      basePayload,
    );
    expect(result.anySuccess).toBe(true);
    expect(result.results[0].platform).toBe("discord-bot");
  });

  it("completes within timeout when sends resolve quickly", async () => {
    const config: NotificationConfig = {
      enabled: true,
      slack: {
        enabled: true,
        webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
      },
    };
    const start = Date.now();
    const result = await dispatchNotifications(
      config,
      "session-end",
      basePayload,
    );
    const elapsed = Date.now() - start;
    expect(result.anySuccess).toBe(true);
    // Should complete well under the 15s dispatch timeout
    expect(elapsed).toBeLessThan(5000);
  });

  it("clears dispatch timer when sends complete (no leak)", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const config: NotificationConfig = {
      enabled: true,
      slack: {
        enabled: true,
        webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
      },
    };
    await dispatchNotifications(config, "session-end", basePayload);
    // The finally block should call clearTimeout
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});

describe("sendDiscordBot mention in content", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "1234567890" }),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prepends mention to message content", async () => {
    const config: DiscordBotNotificationConfig = {
      enabled: true,
      botToken: "test-bot-token",
      channelId: "999888777",
      mention: "<@12345678901234567>",
    };
    await sendDiscordBot(config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.content).toContain("<@12345678901234567>");
    expect(body.content).toMatch(/^<@12345678901234567>\n/);
  });

  it("prepends role mention to message content", async () => {
    const config: DiscordBotNotificationConfig = {
      enabled: true,
      botToken: "test-bot-token",
      channelId: "999888777",
      mention: "<@&98765432109876543>",
    };
    await sendDiscordBot(config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.content).toContain("<@&98765432109876543>");
    expect(body.allowed_mentions.roles).toEqual(["98765432109876543"]);
  });

  it("sends content without mention prefix when mention is undefined", async () => {
    const config: DiscordBotNotificationConfig = {
      enabled: true,
      botToken: "test-bot-token",
      channelId: "999888777",
    };
    await sendDiscordBot(config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.content).toBe(basePayload.message);
  });

  it("truncates long message to fit mention within 2000 chars", async () => {
    const mention = "<@12345678901234567>";
    const longMessage = "X".repeat(2500);
    const config: DiscordBotNotificationConfig = {
      enabled: true,
      botToken: "test-bot-token",
      channelId: "999888777",
      mention,
    };
    await sendDiscordBot(config, { ...basePayload, message: longMessage });
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.content.length).toBeLessThanOrEqual(2000);
    expect(body.content).toMatch(/^<@12345678901234567>\n/);
  });
});

describe("getEffectivePlatformConfig event-level merge", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: "1234567890" }),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inherits mention from top-level when event-level override omits it", async () => {
    const config: NotificationConfig = {
      enabled: true,
      "discord-bot": {
        enabled: true,
        botToken: "test-token",
        channelId: "123456",
        mention: "<@12345678901234567>",
      },
      events: {
        "session-idle": {
          enabled: true,
          "discord-bot": {
            enabled: true,
            botToken: "test-token",
            channelId: "123456",
          },
        },
      },
    };
    const result = await dispatchNotifications(
      config,
      "session-idle",
      basePayload,
    );
    expect(result.anySuccess).toBe(true);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.content).toContain("<@12345678901234567>");
  });

  it("allows event-level to override mention", async () => {
    const config: NotificationConfig = {
      enabled: true,
      "discord-bot": {
        enabled: true,
        botToken: "test-token",
        channelId: "123456",
        mention: "<@11111111111111111>",
      },
      events: {
        "session-end": {
          enabled: true,
          "discord-bot": {
            enabled: true,
            botToken: "test-token",
            channelId: "123456",
            mention: "<@22222222222222222>",
          },
        },
      },
    };
    const result = await dispatchNotifications(
      config,
      "session-end",
      basePayload,
    );
    expect(result.anySuccess).toBe(true);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.content).toContain("<@22222222222222222>");
    expect(body.content).not.toContain("<@11111111111111111>");
  });

  it("inherits botToken and channelId from top-level for event override", async () => {
    const config: NotificationConfig = {
      enabled: true,
      "discord-bot": {
        enabled: false,
        botToken: "inherited-token",
        channelId: "inherited-channel",
        mention: "<@12345678901234567>",
      },
      events: {
        "session-end": {
          enabled: true,
          "discord-bot": {
            enabled: true,
          },
        },
      },
    };
    const result = await dispatchNotifications(
      config,
      "session-end",
      basePayload,
    );
    expect(result.anySuccess).toBe(true);
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe(
      "https://discord.com/api/v10/channels/inherited-channel/messages",
    );
    const body = JSON.parse(call[1]!.body as string);
    expect(body.content).toContain("<@12345678901234567>");
  });
});

describe("dispatcher mention separation", () => {
  it("dispatcher does not read process.env for mention resolution", async () => {
    // Read the dispatcher source to verify no process.env usage for mentions
    const fs = await import("fs");
    const path = await import("path");
    const dispatcherSource = fs.readFileSync(
      path.join(import.meta.dirname, "..", "dispatcher.ts"),
      "utf-8",
    );
    // Dispatcher should not reference process.env at all - mention resolution is in config layer
    expect(dispatcherSource).not.toContain("process.env");
  });

  it("sendDiscordBot uses config.mention directly without env lookup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
    // Set env var that should NOT be read by dispatcher
    vi.stubEnv("OMC_DISCORD_MENTION", "<@99999999999999999>");

    const config: DiscordBotNotificationConfig = {
      enabled: true,
      botToken: "test-token",
      channelId: "123",
      mention: "<@11111111111111111>",
    };
    await sendDiscordBot(config, basePayload);

    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    // Should use config.mention, not env var
    expect(body.content).toContain("<@11111111111111111>");
    expect(body.content).not.toContain("<@99999999999999999>");
    expect(body.allowed_mentions.users).toEqual(["11111111111111111"]);

    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sendDiscord uses config.mention directly without env lookup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
    vi.stubEnv("OMC_DISCORD_MENTION", "<@99999999999999999>");

    const config: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
      mention: "<@&22222222222222222>",
    };
    await sendDiscord(config, basePayload);

    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.content).toContain("<@&22222222222222222>");
    expect(body.content).not.toContain("<@99999999999999999>");
    expect(body.allowed_mentions.roles).toEqual(["22222222222222222"]);

    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
});

describe("sendWebhook reply channel context", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes channel, to, thread_id in webhook payload when reply fields are set", async () => {
    const config: WebhookNotificationConfig = {
      enabled: true,
      url: "https://example.com/hook",
    };
    const payload = {
      ...basePayload,
      replyChannel: "#general",
      replyTarget: "@bot",
      replyThread: "thread-123",
    };
    await sendWebhook(config, payload);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.channel).toBe("#general");
    expect(body.to).toBe("@bot");
    expect(body.thread_id).toBe("thread-123");
  });

  it("does not include channel fields in webhook payload when reply fields are not set", async () => {
    const config: WebhookNotificationConfig = {
      enabled: true,
      url: "https://example.com/hook",
    };
    await sendWebhook(config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body).not.toHaveProperty("channel");
    expect(body).not.toHaveProperty("to");
    expect(body).not.toHaveProperty("thread_id");
  });

  it("includes only partial reply channel fields in webhook payload", async () => {
    const config: WebhookNotificationConfig = {
      enabled: true,
      url: "https://example.com/hook",
    };
    const payload = {
      ...basePayload,
      replyChannel: "#alerts",
    };
    await sendWebhook(config, payload);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.channel).toBe("#alerts");
    expect(body).not.toHaveProperty("to");
    expect(body).not.toHaveProperty("thread_id");
  });
});
