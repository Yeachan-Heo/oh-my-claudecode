/**
 * Integration tests for getNotificationConfig() deep-merge behavior.
 * Tests the critical path: file config + env vars coexisting via mergeEnvIntoFileConfig.
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
import { getNotificationConfig, getTmuxTailLines } from "../config.js";
describe("getNotificationConfig - file + env deep merge", () => {
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
        vi.stubEnv("OMC_SLACK_MENTION", "");
        // Default: no config file
        vi.mocked(existsSync).mockReturnValue(false);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.mocked(existsSync).mockReset();
        vi.mocked(readFileSync).mockReset();
    });
    it("returns null when no file and no env vars", () => {
        expect(getNotificationConfig()).toBeNull();
    });
    it("returns env-only config when no file exists", () => {
        vi.stubEnv("OMC_DISCORD_NOTIFIER_BOT_TOKEN", "env-token");
        vi.stubEnv("OMC_DISCORD_NOTIFIER_CHANNEL", "env-channel");
        const config = getNotificationConfig();
        expect(config).not.toBeNull();
        expect(config["discord-bot"].botToken).toBe("env-token");
        expect(config["discord-bot"].channelId).toBe("env-channel");
    });
    it("returns file-only config when no env vars set", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                slack: {
                    enabled: true,
                    webhookUrl: "https://hooks.slack.com/services/file-config",
                },
            },
        }));
        const config = getNotificationConfig();
        expect(config).not.toBeNull();
        expect(config.slack.webhookUrl).toBe("https://hooks.slack.com/services/file-config");
    });
    it("merges env discord-bot into file config that lacks it", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                slack: {
                    enabled: true,
                    webhookUrl: "https://hooks.slack.com/services/file-slack",
                },
            },
        }));
        vi.stubEnv("OMC_DISCORD_NOTIFIER_BOT_TOKEN", "env-bot-token");
        vi.stubEnv("OMC_DISCORD_NOTIFIER_CHANNEL", "env-channel-id");
        const config = getNotificationConfig();
        expect(config).not.toBeNull();
        // File config platform preserved
        expect(config.slack.webhookUrl).toBe("https://hooks.slack.com/services/file-slack");
        // Env platform merged in
        expect(config["discord-bot"]).toBeDefined();
        expect(config["discord-bot"].botToken).toBe("env-bot-token");
        expect(config["discord-bot"].channelId).toBe("env-channel-id");
    });
    it("merges env telegram into file config that only has discord", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                discord: {
                    enabled: true,
                    webhookUrl: "https://discord.com/api/webhooks/file-webhook",
                },
            },
        }));
        vi.stubEnv("OMC_TELEGRAM_BOT_TOKEN", "123:tg-env");
        vi.stubEnv("OMC_TELEGRAM_CHAT_ID", "tg-chat-env");
        const config = getNotificationConfig();
        expect(config).not.toBeNull();
        // File discord preserved
        expect(config.discord.webhookUrl).toBe("https://discord.com/api/webhooks/file-webhook");
        // Env telegram merged in
        expect(config.telegram).toBeDefined();
        expect(config.telegram.botToken).toBe("123:tg-env");
        expect(config.telegram.chatId).toBe("tg-chat-env");
    });
    it("preserves tmuxTailLines from file config", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                tmuxTailLines: 21,
                slack: {
                    enabled: true,
                    webhookUrl: "https://hooks.slack.com/services/file-config",
                },
            },
        }));
        const config = getNotificationConfig();
        expect(config).not.toBeNull();
        expect(config.tmuxTailLines).toBe(21);
        expect(getTmuxTailLines(config)).toBe(21);
    });
    it("allows OMC_NOTIFY_TMUX_TAIL_LINES to override file config", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                tmuxTailLines: 21,
                slack: {
                    enabled: true,
                    webhookUrl: "https://hooks.slack.com/services/file-config",
                },
            },
        }));
        vi.stubEnv("OMC_NOTIFY_TMUX_TAIL_LINES", "34");
        const config = getNotificationConfig();
        expect(config).not.toBeNull();
        expect(config.tmuxTailLines).toBe(21);
        expect(getTmuxTailLines(config)).toBe(34);
    });
    it("file config fields take precedence over env for same platform", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                "discord-bot": {
                    enabled: true,
                    botToken: "file-token",
                    channelId: "file-channel",
                },
            },
        }));
        vi.stubEnv("OMC_DISCORD_NOTIFIER_BOT_TOKEN", "env-token");
        vi.stubEnv("OMC_DISCORD_NOTIFIER_CHANNEL", "env-channel");
        const config = getNotificationConfig();
        // File values win
        expect(config["discord-bot"].botToken).toBe("file-token");
        expect(config["discord-bot"].channelId).toBe("file-channel");
    });
    it("env mention fills missing mention in file discord-bot config", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                "discord-bot": {
                    enabled: true,
                    botToken: "file-token",
                    channelId: "file-channel",
                },
            },
        }));
        vi.stubEnv("OMC_DISCORD_MENTION", "<@12345678901234567>");
        const config = getNotificationConfig();
        expect(config["discord-bot"].mention).toBe("<@12345678901234567>");
    });
    it("file mention takes precedence over env mention", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                "discord-bot": {
                    enabled: true,
                    botToken: "file-token",
                    channelId: "file-channel",
                    mention: "<@99999999999999999>",
                },
            },
        }));
        vi.stubEnv("OMC_DISCORD_MENTION", "<@11111111111111111>");
        const config = getNotificationConfig();
        // File mention wins (validated)
        expect(config["discord-bot"].mention).toBe("<@99999999999999999>");
    });
    it("returns null when file has notifications without enabled boolean", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                slack: { enabled: true, webhookUrl: "https://hooks.slack.com/x" },
            },
        }));
        const config = getNotificationConfig();
        expect(config).toBeNull();
    });
    it("env mention is applied to file discord-bot when other env platform exists", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                "discord-bot": {
                    enabled: true,
                    botToken: "file-token",
                    channelId: "file-channel",
                },
            },
        }));
        vi.stubEnv("OMC_DISCORD_MENTION", "<@12345678901234567>");
        vi.stubEnv("OMC_SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/test");
        const config = getNotificationConfig();
        expect(config["discord-bot"].mention).toBe("<@12345678901234567>");
    });
    it("validates file discord-bot mention when other env platform exists", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                "discord-bot": {
                    enabled: true,
                    botToken: "file-token",
                    channelId: "file-channel",
                    mention: "  <@12345678901234567>  ",
                },
            },
        }));
        vi.stubEnv("OMC_SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/test");
        const config = getNotificationConfig();
        expect(config["discord-bot"].mention).toBe("<@12345678901234567>");
    });
    it("rejects invalid file discord-bot mention when other env platform exists", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                "discord-bot": {
                    enabled: true,
                    botToken: "file-token",
                    channelId: "file-channel",
                    mention: "@everyone",
                },
            },
        }));
        vi.stubEnv("OMC_SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/test");
        const config = getNotificationConfig();
        expect(config["discord-bot"].mention).toBeUndefined();
    });
    it("falls back to legacy stopHookCallbacks when no notifications key", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            stopHookCallbacks: {
                telegram: {
                    enabled: true,
                    botToken: "legacy-token",
                    chatId: "legacy-chat",
                },
            },
        }));
        const config = getNotificationConfig();
        expect(config).not.toBeNull();
        expect(config.telegram.botToken).toBe("legacy-token");
    });
    it("merges env slack into file config that lacks it", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                discord: {
                    enabled: true,
                    webhookUrl: "https://discord.com/api/webhooks/file-webhook",
                },
            },
        }));
        vi.stubEnv("OMC_SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/env-slack");
        const config = getNotificationConfig();
        expect(config).not.toBeNull();
        // File discord preserved
        expect(config.discord.webhookUrl).toBe("https://discord.com/api/webhooks/file-webhook");
        // Env slack merged in
        expect(config.slack).toBeDefined();
        expect(config.slack.webhookUrl).toBe("https://hooks.slack.com/services/env-slack");
        expect(config.slack.enabled).toBe(true);
    });
    it("file slack webhookUrl takes precedence over env", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                slack: {
                    enabled: true,
                    webhookUrl: "https://hooks.slack.com/services/file-url",
                },
            },
        }));
        vi.stubEnv("OMC_SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/env-url");
        const config = getNotificationConfig();
        expect(config.slack.webhookUrl).toBe("https://hooks.slack.com/services/file-url");
    });
    it("env slack mention fills missing mention in file slack config", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                slack: {
                    enabled: true,
                    webhookUrl: "https://hooks.slack.com/services/file-slack",
                },
            },
        }));
        vi.stubEnv("OMC_SLACK_MENTION", "<@U1234567890>");
        const config = getNotificationConfig();
        expect(config.slack.mention).toBe("<@U1234567890>");
    });
    it("file slack mention takes precedence over env slack mention", () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            notifications: {
                enabled: true,
                slack: {
                    enabled: true,
                    webhookUrl: "https://hooks.slack.com/services/file-slack",
                    mention: "<!channel>",
                },
            },
        }));
        vi.stubEnv("OMC_SLACK_MENTION", "<@U9999999999>");
        const config = getNotificationConfig();
        expect(config.slack.mention).toBe("<!channel>");
    });
});
//# sourceMappingURL=config-merge.test.js.map