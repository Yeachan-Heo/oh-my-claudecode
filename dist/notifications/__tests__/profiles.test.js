/**
 * Tests for named notification profiles.
 *
 * Covers profile resolution in getNotificationConfig(), env var fallback,
 * default fallback when profile is missing, and env merge within profiles.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "fs";
// Mock fs so we can control what readRawConfig() sees
vi.mock("fs", async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        existsSync: vi.fn(actual.existsSync),
        readFileSync: vi.fn(actual.readFileSync),
    };
});
// Mock getClaudeConfigDir to return a predictable path
vi.mock("../../utils/config-dir.js", () => ({
    getClaudeConfigDir: () => "/mock-claude-config",
}));
import { getNotificationConfig } from "../config.js";
describe("getNotificationConfig - named profiles", () => {
    beforeEach(() => {
        // Clear all env vars
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
        vi.stubEnv("OMC_NOTIFY_PROFILE", "");
        // Default: no config file
        vi.mocked(existsSync).mockReturnValue(false);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.mocked(existsSync).mockReset();
        vi.mocked(readFileSync).mockReset();
    });
    it("returns named profile when profileName argument is provided", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                slack: { enabled: true, webhookUrl: "https://hooks.slack.com/default" },
            },
            notificationProfiles: {
                work: {
                    enabled: true,
                    telegram: { enabled: true, botToken: "work-token", chatId: "work-chat" },
                },
            },
        }));
        const config = getNotificationConfig("work");
        expect(config).not.toBeNull();
        expect(config.telegram.botToken).toBe("work-token");
        expect(config.telegram.chatId).toBe("work-chat");
        // Should NOT include the default config's slack
        expect(config.slack).toBeUndefined();
    });
    it("returns named profile when OMC_NOTIFY_PROFILE env var is set", () => {
        vi.stubEnv("OMC_NOTIFY_PROFILE", "ops");
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                slack: { enabled: true, webhookUrl: "https://hooks.slack.com/default" },
            },
            notificationProfiles: {
                ops: {
                    enabled: true,
                    discord: { enabled: true, webhookUrl: "https://discord.com/api/webhooks/ops" },
                },
            },
        }));
        const config = getNotificationConfig();
        expect(config).not.toBeNull();
        expect(config.discord.webhookUrl).toBe("https://discord.com/api/webhooks/ops");
        expect(config.slack).toBeUndefined();
    });
    it("profileName argument takes precedence over OMC_NOTIFY_PROFILE env var", () => {
        vi.stubEnv("OMC_NOTIFY_PROFILE", "env-profile");
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notificationProfiles: {
                "env-profile": {
                    enabled: true,
                    slack: { enabled: true, webhookUrl: "https://hooks.slack.com/env" },
                },
                "arg-profile": {
                    enabled: true,
                    telegram: { enabled: true, botToken: "arg-token", chatId: "arg-chat" },
                },
            },
        }));
        const config = getNotificationConfig("arg-profile");
        expect(config).not.toBeNull();
        expect(config.telegram.botToken).toBe("arg-token");
        expect(config.slack).toBeUndefined();
    });
    it("falls back to default notifications when requested profile is not found", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                slack: { enabled: true, webhookUrl: "https://hooks.slack.com/default" },
            },
            notificationProfiles: {
                work: {
                    enabled: true,
                    telegram: { enabled: true, botToken: "tk", chatId: "ch" },
                },
            },
        }));
        const config = getNotificationConfig("nonexistent");
        expect(config).not.toBeNull();
        // Falls back to default
        expect(config.slack.webhookUrl).toBe("https://hooks.slack.com/default");
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"nonexistent" not found'));
        warnSpy.mockRestore();
    });
    it("falls back to default when profile env var set but no profiles exist", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
        vi.stubEnv("OMC_NOTIFY_PROFILE", "missing");
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                telegram: { enabled: true, botToken: "default-tk", chatId: "default-ch" },
            },
        }));
        const config = getNotificationConfig();
        expect(config).not.toBeNull();
        expect(config.telegram.botToken).toBe("default-tk");
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });
    it("returns null when profile exists but has no enabled boolean", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notificationProfiles: {
                bad: {
                    telegram: { enabled: true, botToken: "tk", chatId: "ch" },
                },
            },
        }));
        const config = getNotificationConfig("bad");
        expect(config).toBeNull();
    });
    it("merges env platforms into profile config", () => {
        vi.stubEnv("OMC_TELEGRAM_BOT_TOKEN", "env-tg-token");
        vi.stubEnv("OMC_TELEGRAM_CHAT_ID", "env-tg-chat");
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notificationProfiles: {
                work: {
                    enabled: true,
                    discord: { enabled: true, webhookUrl: "https://discord.com/api/webhooks/work" },
                },
            },
        }));
        const config = getNotificationConfig("work");
        expect(config).not.toBeNull();
        // Profile's discord preserved
        expect(config.discord.webhookUrl).toBe("https://discord.com/api/webhooks/work");
        // Env telegram merged in
        expect(config.telegram).toBeDefined();
        expect(config.telegram.botToken).toBe("env-tg-token");
        expect(config.telegram.chatId).toBe("env-tg-chat");
    });
    it("applies env mention to profile discord config", () => {
        vi.stubEnv("OMC_DISCORD_MENTION", "<@12345678901234567>");
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notificationProfiles: {
                work: {
                    enabled: true,
                    "discord-bot": { enabled: true, botToken: "tk", channelId: "ch" },
                },
            },
        }));
        const config = getNotificationConfig("work");
        expect(config).not.toBeNull();
        expect(config["discord-bot"].mention).toBe("<@12345678901234567>");
    });
    it("works with multiple profiles — each isolated", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notificationProfiles: {
                work: {
                    enabled: true,
                    telegram: { enabled: true, botToken: "work-tk", chatId: "work-ch" },
                },
                personal: {
                    enabled: true,
                    slack: { enabled: true, webhookUrl: "https://hooks.slack.com/personal" },
                },
            },
        }));
        const workConfig = getNotificationConfig("work");
        expect(workConfig.telegram.botToken).toBe("work-tk");
        expect(workConfig.slack).toBeUndefined();
        const personalConfig = getNotificationConfig("personal");
        expect(personalConfig.slack.webhookUrl).toBe("https://hooks.slack.com/personal");
        expect(personalConfig.telegram).toBeUndefined();
    });
    it("profile with events config is respected", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notificationProfiles: {
                selective: {
                    enabled: true,
                    telegram: { enabled: true, botToken: "tk", chatId: "ch" },
                    events: {
                        "session-start": { enabled: false },
                        "session-end": { enabled: true },
                    },
                },
            },
        }));
        const config = getNotificationConfig("selective");
        expect(config).not.toBeNull();
        expect(config.events["session-start"].enabled).toBe(false);
        expect(config.events["session-end"].enabled).toBe(true);
    });
    it("without profile, existing default behavior is preserved", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                slack: { enabled: true, webhookUrl: "https://hooks.slack.com/default" },
            },
            notificationProfiles: {
                work: {
                    enabled: true,
                    telegram: { enabled: true, botToken: "tk", chatId: "ch" },
                },
            },
        }));
        // No profile specified — should get default
        const config = getNotificationConfig();
        expect(config).not.toBeNull();
        expect(config.slack.webhookUrl).toBe("https://hooks.slack.com/default");
        expect(config.telegram).toBeUndefined();
    });
});
//# sourceMappingURL=profiles.test.js.map