import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Mock session-registry before importing notify
const mockRegisterMessage = vi.fn();
vi.mock("../session-registry.js", () => ({
    registerMessage: (mapping) => mockRegisterMessage(mapping),
}));
// Mock tmux to control pane ID
const mockGetCurrentTmuxPaneId = vi.fn();
const mockGetCurrentTmuxSession = vi.fn();
vi.mock("../tmux.js", () => ({
    getCurrentTmuxPaneId: () => mockGetCurrentTmuxPaneId(),
    getCurrentTmuxSession: () => mockGetCurrentTmuxSession(),
    getTeamTmuxSessions: () => [],
    formatTmuxInfo: () => null,
}));
const mockCapturePaneContent = vi.fn();
vi.mock("../../features/rate-limit-wait/tmux-detector.js", () => ({
    capturePaneContent: (paneId, lines) => mockCapturePaneContent(paneId, lines),
}));
const mockGetNewPaneTail = vi.fn();
vi.mock("../../features/rate-limit-wait/pane-fresh-capture.js", () => ({
    getNewPaneTail: (paneId, stateDir, maxLines) => mockGetNewPaneTail(paneId, stateDir, maxLines),
}));
// Mock config - use forwarding fns so we can swap implementations per-test
const mockGetNotificationConfig = vi.fn();
const mockIsEventEnabled = vi.fn();
const mockShouldIncludeTmuxTail = vi.fn();
const mockGetTmuxTailLines = vi.fn();
vi.mock("../config.js", () => ({
    getNotificationConfig: (profileName) => mockGetNotificationConfig(profileName),
    isEventEnabled: (config, event) => mockIsEventEnabled(config, event),
    getEnabledPlatforms: () => ["discord-bot"],
    getVerbosity: () => "session",
    getTmuxTailLines: (config) => mockGetTmuxTailLines(config),
    isEventAllowedByVerbosity: () => true,
    shouldIncludeTmuxTail: (verbosity) => mockShouldIncludeTmuxTail(verbosity),
    parseMentionAllowedMentions: () => ({
        users: undefined,
        roles: undefined,
    }),
}));
// Mock https for Telegram
vi.mock("https", () => {
    const EventEmitter = require("events");
    return {
        request: vi.fn((_opts, callback) => {
            const req = new EventEmitter();
            req.write = vi.fn();
            req.end = vi.fn(() => {
                const res = new EventEmitter();
                res.statusCode = 200;
                callback(res);
                setImmediate(() => {
                    const responseBody = JSON.stringify({
                        ok: true,
                        result: { message_id: 77777 },
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
import { notify } from "../index.js";
/** Default discord-bot config used by most tests */
const DEFAULT_CONFIG = {
    enabled: true,
    "discord-bot": {
        enabled: true,
        botToken: "test-token",
        channelId: "test-channel",
    },
};
describe("notify() -> session-registry integration", () => {
    let fixtureHome;
    let previousHome;
    let previousUserProfile;
    beforeEach(() => {
        fixtureHome = mkdtempSync(join(tmpdir(), "omc-notify-registry-"));
        previousHome = process.env.HOME;
        previousUserProfile = process.env.USERPROFILE;
        process.env.HOME = fixtureHome;
        process.env.USERPROFILE = fixtureHome;
        vi.clearAllMocks();
        // Reset forwarding mocks to defaults
        mockGetCurrentTmuxPaneId.mockReturnValue("%42");
        mockGetCurrentTmuxSession.mockReturnValue("main");
        mockGetNotificationConfig.mockReturnValue(DEFAULT_CONFIG);
        mockIsEventEnabled.mockReturnValue(true);
        mockShouldIncludeTmuxTail.mockReturnValue(false);
        mockGetTmuxTailLines.mockReturnValue(15);
        mockCapturePaneContent.mockReturnValue("");
        mockGetNewPaneTail.mockReturnValue("");
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        if (previousHome === undefined)
            delete process.env.HOME;
        else
            process.env.HOME = previousHome;
        if (previousUserProfile === undefined)
            delete process.env.USERPROFILE;
        else
            process.env.USERPROFILE = previousUserProfile;
        rmSync(fixtureHome, { recursive: true, force: true });
    });
    it("registers discord-bot messageId in session registry after dispatch", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ id: "discord-msg-123" }),
        }));
        const result = await notify("session-start", {
            sessionId: "sess-001",
            projectPath: "/test/project",
        });
        expect(result).not.toBeNull();
        expect(result.anySuccess).toBe(true);
        // Verify registerMessage was called with correct mapping
        expect(mockRegisterMessage).toHaveBeenCalledTimes(1);
        expect(mockRegisterMessage).toHaveBeenCalledWith(expect.objectContaining({
            platform: "discord-bot",
            messageId: "discord-msg-123",
            sessionId: "sess-001",
            tmuxPaneId: "%42",
            tmuxSessionName: "main",
            event: "session-start",
            projectPath: "/test/project",
        }));
    });
    it("registers telegram messageId in session registry after dispatch", async () => {
        mockGetNotificationConfig.mockReturnValue({
            enabled: true,
            telegram: {
                enabled: true,
                botToken: "123456:ABCdef",
                chatId: "999",
            },
        });
        const result = await notify("session-idle", {
            sessionId: "sess-002",
            projectPath: "/test/project",
        });
        expect(result).not.toBeNull();
        expect(result.anySuccess).toBe(true);
        expect(mockRegisterMessage).toHaveBeenCalledTimes(1);
        expect(mockRegisterMessage).toHaveBeenCalledWith(expect.objectContaining({
            platform: "telegram",
            messageId: "77777",
            sessionId: "sess-002",
            tmuxPaneId: "%42",
            event: "session-idle",
        }));
    });
    it("registers both discord-bot and telegram messageIds when both succeed", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ id: "discord-msg-456" }),
        }));
        mockGetNotificationConfig.mockReturnValue({
            enabled: true,
            "discord-bot": {
                enabled: true,
                botToken: "test-token",
                channelId: "test-channel",
            },
            telegram: {
                enabled: true,
                botToken: "123456:ABCdef",
                chatId: "999",
            },
        });
        const result = await notify("ask-user-question", {
            sessionId: "sess-003",
            projectPath: "/test/project",
            question: "Which approach?",
        });
        expect(result).not.toBeNull();
        expect(result.anySuccess).toBe(true);
        // Both platforms should register
        expect(mockRegisterMessage).toHaveBeenCalledTimes(2);
        const calls = mockRegisterMessage.mock.calls.map((c) => c[0]);
        const platforms = calls.map((c) => c.platform);
        expect(platforms).toContain("discord-bot");
        expect(platforms).toContain("telegram");
        const discordCall = calls.find((c) => c.platform === "discord-bot");
        expect(discordCall.messageId).toBe("discord-msg-456");
        const telegramCall = calls.find((c) => c.platform === "telegram");
        expect(telegramCall.messageId).toBe("77777");
    });
    it("captures tmux tail using the configured line count", async () => {
        mockShouldIncludeTmuxTail.mockReturnValue(true);
        mockGetTmuxTailLines.mockReturnValue(23);
        mockGetNewPaneTail.mockReturnValue("line 1\nline 2");
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ id: "discord-msg-tail" }),
        }));
        const result = await notify("session-idle", {
            sessionId: "sess-tail",
            projectPath: "/test/project",
        });
        expect(result).not.toBeNull();
        expect(mockGetNewPaneTail).toHaveBeenCalledWith("%42", join(fixtureHome, ".omc/state"), 23);
        expect(mockCapturePaneContent).not.toHaveBeenCalled();
    });
    it("falls back to direct pane capture when projectPath is unavailable", async () => {
        mockShouldIncludeTmuxTail.mockReturnValue(true);
        mockGetTmuxTailLines.mockReturnValue(12);
        mockCapturePaneContent.mockReturnValue("runtime failure");
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ id: "discord-msg-tail-fallback" }),
        }));
        const result = await notify("session-idle", {
            sessionId: "sess-tail-no-project",
        });
        expect(result).not.toBeNull();
        expect(mockGetNewPaneTail).not.toHaveBeenCalled();
        expect(mockCapturePaneContent).toHaveBeenCalledWith("%42", 12);
    });
    it("keeps vitest runtime failure prose in delivered tmux tails while filtering literal noise", async () => {
        mockShouldIncludeTmuxTail.mockReturnValue(true);
        mockGetTmuxTailLines.mockReturnValue(12);
        mockGetNewPaneTail.mockReturnValue([
            'mcp: {"jsonrpc":"2.0","error":{"code":"operation_failed","message":"claim_conflict"}}',
            '+ const payload = { status: "failed", error: "claim_conflict" };',
            "Error: Cannot find module vitest",
            "failed to load config from /tmp/x/vitest.config.ts",
        ].join("\n"));
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ id: "discord-msg-vitest-tail" }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const result = await notify("session-idle", {
            sessionId: "sess-tail-vitest",
            projectPath: "/test/project",
        });
        expect(result).not.toBeNull();
        const [, requestInit] = fetchMock.mock.calls[0];
        const body = JSON.parse(requestInit.body ?? "{}");
        expect(body.content).toContain("Error: Cannot find module vitest");
        expect(body.content).toContain("failed to load config from /tmp/x/vitest.config.ts");
        expect(body.content).not.toContain('mcp: {"jsonrpc":"2.0"');
        expect(body.content).not.toContain('+ const payload = { status: "failed", error: "claim_conflict" };');
    });
    it("stores raw tmux tail before formatter sanitization", async () => {
        mockShouldIncludeTmuxTail.mockReturnValue(true);
        mockGetTmuxTailLines.mockReturnValue(12);
        mockGetNewPaneTail.mockReturnValue([
            "Error: Cannot find module vitest",
            "failed to load config from /tmp/x/vitest.config.ts",
        ].join("\n"));
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ id: "discord-msg-raw-tail" }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const result = await notify("session-idle", {
            sessionId: "sess-raw-tail",
            projectPath: "/test/project",
        });
        expect(result).not.toBeNull();
        const [, requestInit] = fetchMock.mock.calls[0];
        const body = JSON.parse(requestInit.body ?? "{}");
        expect(body.content).toContain("Error: Cannot find module vitest");
        expect(body.content).toContain("failed to load config from /tmp/x/vitest.config.ts");
    });
    it("filters live pane prompt/search/diagnostic residue while keeping actionable failures", async () => {
        mockShouldIncludeTmuxTail.mockReturnValue(true);
        mockGetTmuxTailLines.mockReturnValue(12);
        mockGetNewPaneTail.mockReturnValue([
            "Fix issue #2583: stop fake error/fail/conflict alerts from prompt residue",
            '❯ rg -n "error|fail|conflict" src tests',
            "TypeScript check passed: 0 errors, 0 warnings",
            "The Bash output indicates a command/setup failure that should be fixed before retrying.",
            "Runtime error: worker crashed after SIGTERM",
            "Restart the pane watcher and rerun the task",
        ].join("\n"));
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ id: "discord-msg-live-pane-filter" }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const result = await notify("session-idle", {
            sessionId: "sess-live-pane-filter",
            projectPath: "/test/project",
        });
        expect(result).not.toBeNull();
        const [, requestInit] = fetchMock.mock.calls[0];
        const body = JSON.parse(requestInit.body ?? "{}");
        expect(body.content).toContain("Runtime error: worker crashed after SIGTERM");
        expect(body.content).toContain("Restart the pane watcher and rerun the task");
        expect(body.content).not.toContain("Fix issue #2583");
        expect(body.content).not.toContain('rg -n "error|fail|conflict"');
        expect(body.content).not.toContain("0 errors, 0 warnings");
        expect(body.content).not.toContain("The Bash output indicates a command/setup failure");
    });
    it("does NOT register when tmuxPaneId is unavailable", async () => {
        mockGetCurrentTmuxPaneId.mockReturnValue(null);
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ id: "discord-msg-789" }),
        }));
        const result = await notify("session-start", {
            sessionId: "sess-004",
            projectPath: "/test/project",
        });
        expect(result).not.toBeNull();
        expect(result.anySuccess).toBe(true);
        // No registration without tmux pane
        expect(mockRegisterMessage).not.toHaveBeenCalled();
    });
    it("does NOT register when dispatch fails", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
        }));
        const result = await notify("session-start", {
            sessionId: "sess-005",
            projectPath: "/test/project",
        });
        expect(result).not.toBeNull();
        expect(result.anySuccess).toBe(false);
        expect(mockRegisterMessage).not.toHaveBeenCalled();
    });
    it("does NOT register for non-reply platforms (discord webhook, slack)", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
        mockGetNotificationConfig.mockReturnValue({
            enabled: true,
            discord: {
                enabled: true,
                webhookUrl: "https://discord.com/api/webhooks/123/abc",
            },
            slack: {
                enabled: true,
                webhookUrl: "https://hooks.slack.com/services/T00/B00/xxx",
            },
        });
        const result = await notify("session-end", {
            sessionId: "sess-006",
            projectPath: "/test/project",
        });
        expect(result).not.toBeNull();
        expect(result.anySuccess).toBe(true);
        // Discord webhook and Slack don't support reply correlation
        expect(mockRegisterMessage).not.toHaveBeenCalled();
    });
    it("does NOT register when notifications are disabled", async () => {
        mockGetNotificationConfig.mockReturnValue(null);
        const result = await notify("session-start", {
            sessionId: "sess-007",
            projectPath: "/test/project",
        });
        expect(result).toBeNull();
        expect(mockRegisterMessage).not.toHaveBeenCalled();
    });
    it("does NOT register when event is not enabled", async () => {
        mockIsEventEnabled.mockReturnValue(false);
        const result = await notify("session-start", {
            sessionId: "sess-008",
            projectPath: "/test/project",
        });
        expect(result).toBeNull();
        expect(mockRegisterMessage).not.toHaveBeenCalled();
    });
    it("uses explicit tmuxPaneId from data when provided", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ id: "discord-msg-explicit" }),
        }));
        const result = await notify("session-start", {
            sessionId: "sess-009",
            projectPath: "/test/project",
            tmuxPaneId: "%99",
        });
        expect(result).not.toBeNull();
        expect(result.anySuccess).toBe(true);
        expect(mockRegisterMessage).toHaveBeenCalledWith(expect.objectContaining({
            tmuxPaneId: "%99",
            messageId: "discord-msg-explicit",
        }));
    });
    it("includes createdAt timestamp in registered mapping", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ id: "discord-msg-ts" }),
        }));
        const before = new Date().toISOString();
        await notify("session-start", {
            sessionId: "sess-010",
            projectPath: "/test/project",
        });
        const after = new Date().toISOString();
        expect(mockRegisterMessage).toHaveBeenCalledTimes(1);
        const mapping = mockRegisterMessage.mock.calls[0][0];
        expect(mapping.createdAt >= before).toBe(true);
        expect(mapping.createdAt <= after).toBe(true);
    });
    it("swallows registerMessage errors without affecting notify result", async () => {
        mockRegisterMessage.mockImplementation(() => {
            throw new Error("Registry write failed");
        });
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ id: "discord-msg-err" }),
        }));
        // Should not throw even though registerMessage fails
        const result = await notify("session-start", {
            sessionId: "sess-011",
            projectPath: "/test/project",
        });
        expect(result).not.toBeNull();
        expect(result.anySuccess).toBe(true);
    });
    it("skips registration when discord-bot returns success but no messageId", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => {
                throw new Error("Invalid JSON");
            },
        }));
        const result = await notify("session-start", {
            sessionId: "sess-012",
            projectPath: "/test/project",
        });
        expect(result).not.toBeNull();
        expect(result.anySuccess).toBe(true);
        // messageId is undefined due to JSON parse failure, so no registration
        expect(mockRegisterMessage).not.toHaveBeenCalled();
    });
});
describe("dispatchNotifications messageId propagation", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });
    it("preserves messageId through Promise.allSettled in dispatch results", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ id: "preserved-id-123" }),
        }));
        const { dispatchNotifications } = await import("../dispatcher.js");
        const result = await dispatchNotifications({
            enabled: true,
            "discord-bot": {
                enabled: true,
                botToken: "test-token",
                channelId: "test-channel",
            },
        }, "session-start", {
            event: "session-start",
            sessionId: "test-session",
            message: "Test message",
            timestamp: new Date().toISOString(),
        });
        expect(result.anySuccess).toBe(true);
        const discordBotResult = result.results.find((r) => r.platform === "discord-bot");
        expect(discordBotResult).toBeDefined();
        expect(discordBotResult.messageId).toBe("preserved-id-123");
    });
    it("preserves telegram messageId through Promise.allSettled", async () => {
        const { dispatchNotifications } = await import("../dispatcher.js");
        const result = await dispatchNotifications({
            enabled: true,
            telegram: {
                enabled: true,
                botToken: "123456:ABCdef",
                chatId: "999",
            },
        }, "session-start", {
            event: "session-start",
            sessionId: "test-session",
            message: "Test message",
            timestamp: new Date().toISOString(),
        });
        expect(result.anySuccess).toBe(true);
        const telegramResult = result.results.find((r) => r.platform === "telegram");
        expect(telegramResult).toBeDefined();
        expect(telegramResult.messageId).toBe("77777");
    });
});
//# sourceMappingURL=notify-registry-integration.test.js.map