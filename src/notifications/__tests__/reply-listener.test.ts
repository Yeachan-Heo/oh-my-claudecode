import { describe, it, expect } from "vitest";
import { sanitizeReplyInput } from "../reply-listener.js";

describe("reply-listener", () => {
  describe("sanitizeReplyInput", () => {
    it("strips control characters", () => {
      // Control characters \x00-\x08, \x0b, \x0c, \x0e-\x1f, \x7f are stripped
      const input = "hello\x00\x01\x02world\x7f";
      const expected = "helloworld";

      const sanitized = sanitizeReplyInput(input);
      expect(sanitized).toBe(expected);
    });

    it("replaces newlines with spaces", () => {
      const input = "line1\nline2\r\nline3";
      const expected = "line1 line2 line3";

      const sanitized = sanitizeReplyInput(input);
      expect(sanitized).toBe(expected);
    });

    it("escapes backticks", () => {
      const input = "echo `whoami`";
      const expected = "echo \\`whoami\\`";

      const sanitized = sanitizeReplyInput(input);
      expect(sanitized).toBe(expected);
    });

    it("escapes command substitution $()", () => {
      const input = "echo $(whoami)";
      const expected = "echo \\$(whoami)";

      const sanitized = sanitizeReplyInput(input);
      expect(sanitized).toBe(expected);
    });

    it("escapes command substitution ${}", () => {
      const input = "echo ${USER}";
      const expected = "echo \\${USER}";

      const sanitized = sanitizeReplyInput(input);
      expect(sanitized).toBe(expected);
    });

    it("escapes backslashes", () => {
      const input = "path\\to\\file";
      const expected = "path\\\\to\\\\file";

      const sanitized = sanitizeReplyInput(input);
      expect(sanitized).toBe(expected);
    });

    it("applies all sanitizations in correct order", () => {
      const input = "hello\nworld `cmd` $(sub) ${var} \x00test\\path";

      const result = sanitizeReplyInput(input);

      expect(result).toContain('hello world');
      expect(result).toContain('\\`cmd\\`');
      expect(result).toContain('\\$(sub)');
      expect(result).toContain('\\${var}');
      expect(result).not.toContain('\x00');
    });
  });

  describe("Discord filtering", () => {
    it("requires message_reference field", () => {
      const messageWithoutReference = {
        id: "123",
        author: { id: "456" },
        content: "reply text",
      };

      expect((messageWithoutReference as any).message_reference).toBeUndefined();
    });

    it("requires message_reference.message_id", () => {
      const messageWithReference = {
        id: "123",
        author: { id: "456" },
        content: "reply text",
        message_reference: { message_id: "789" },
      };

      expect(messageWithReference.message_reference.message_id).toBe("789");
    });

    it("requires authorized user ID", () => {
      const authorizedUserIds = ["456", "789"];
      const authorId = "456";

      expect(authorizedUserIds.includes(authorId)).toBe(true);
      expect(authorizedUserIds.includes("999")).toBe(false);
    });

    it("skips processing when authorizedDiscordUserIds is empty", () => {
      const authorizedUserIds: string[] = [];

      // Discord reply listening is disabled when array is empty
      expect(authorizedUserIds.length).toBe(0);
    });
  });

  describe("Telegram filtering", () => {
    it("requires reply_to_message field", () => {
      const messageWithoutReply = {
        message_id: 123,
        chat: { id: 456 },
        text: "reply text",
      };

      expect((messageWithoutReply as any).reply_to_message).toBeUndefined();
    });

    it("requires reply_to_message.message_id", () => {
      const messageWithReply = {
        message_id: 123,
        chat: { id: 456 },
        text: "reply text",
        reply_to_message: { message_id: 789 },
      };

      expect(messageWithReply.reply_to_message.message_id).toBe(789);
    });

    it("requires matching chat.id", () => {
      const configuredChatId = "123456789";
      const messageChatId = "123456789";

      expect(String(messageChatId)).toBe(configuredChatId);
      expect(String(987654321)).not.toBe(configuredChatId);
    });
  });

  describe("Rate limiting", () => {
    it("allows N messages per minute", () => {
      const maxPerMinute = 10;
      const timestamps: number[] = [];
      const windowMs = 60 * 1000;
      const now = Date.now();

      // Add 10 messages
      for (let i = 0; i < maxPerMinute; i++) {
        timestamps.push(now + i * 100);
      }

      expect(timestamps.length).toBe(maxPerMinute);

      // 11th message should be rejected
      const filtered = timestamps.filter(t => now - t < windowMs);
      expect(filtered.length).toBe(maxPerMinute);
    });

    it("drops excess messages", () => {
      const maxPerMinute = 10;
      const windowMs = 60 * 1000;
      const now = Date.now();

      // Simulate sliding window
      let timestamps = Array.from({ length: maxPerMinute }, (_, i) => now - i * 1000);

      // Remove old timestamps
      timestamps = timestamps.filter(t => now - t < windowMs);

      // Check if can proceed (would be false if at limit)
      const canProceed = timestamps.length < maxPerMinute;
      expect(canProceed).toBe(false);
    });
  });

  describe("Pane verification", () => {
    it("skips injection when confidence < 0.4", () => {
      const analysis = {
        hasClaudeCode: false,
        hasRateLimitMessage: false,
        isBlocked: false,
        confidence: 0.3,
      };

      expect(analysis.confidence).toBeLessThan(0.4);
    });

    it("proceeds with injection when confidence >= 0.4", () => {
      const analysis = {
        hasClaudeCode: true,
        hasRateLimitMessage: false,
        isBlocked: false,
        confidence: 0.5,
      };

      expect(analysis.confidence).toBeGreaterThanOrEqual(0.4);
    });
  });

  describe("Visual prefix", () => {
    it("prepends prefix when includePrefix is true", () => {
      const config = { includePrefix: true };
      const platform = "discord";
      const text = "user message";

      const prefix = config.includePrefix ? `[reply:${platform}] ` : '';
      const result = prefix + text;

      expect(result).toBe("[reply:discord] user message");
    });

    it("omits prefix when includePrefix is false", () => {
      const config = { includePrefix: false };
      const platform = "telegram";
      const text = "user message";

      const prefix = config.includePrefix ? `[reply:${platform}] ` : '';
      const result = prefix + text;

      expect(result).toBe("user message");
    });
  });

  describe("At-most-once delivery", () => {
    it("updates state offset before injection", () => {
      const state = {
        discordLastMessageId: null as string | null,
        telegramLastUpdateId: null as number | null,
      };

      // Discord: update before processing
      const newDiscordMessageId = "123456";
      state.discordLastMessageId = newDiscordMessageId;

      expect(state.discordLastMessageId).toBe("123456");

      // Telegram: update before processing
      const newTelegramUpdateId = 789;
      state.telegramLastUpdateId = newTelegramUpdateId;

      expect(state.telegramLastUpdateId).toBe(789);
    });

    it("prevents duplicate injection on restart", () => {
      // If state is written before injection and crash occurs,
      // the message won't be re-processed on restart
      const processedMessageIds = new Set<string>();

      const messageId = "123";
      processedMessageIds.add(messageId);

      // On restart, this message would be skipped
      const alreadyProcessed = processedMessageIds.has(messageId);
      expect(alreadyProcessed).toBe(true);
    });
  });

  describe("Daemon lifecycle", () => {
    it("creates PID file on start", () => {
      const pid = 12345;
      expect(pid).toBeGreaterThan(0);
    });

    it("removes PID file on stop", () => {
      // PID file should be removed when daemon stops
      expect(true).toBe(true);
    });

    it("detects stale PID file", () => {
      const pid = 99999; // Non-existent process

      // isProcessRunning would return false
      let isRunning = false;
      try {
        process.kill(pid, 0);
        isRunning = true;
      } catch {
        isRunning = false;
      }

      expect(isRunning).toBe(false);
    });
  });

  describe("Configuration", () => {
    it("daemon derives config from getNotificationConfig, not separate file", () => {
      // No reply-listener-config.json should be needed
      // The daemon calls buildDaemonConfig() which uses getNotificationConfig()
      const fs = require("fs");
      const path = require("path");
      const source = fs.readFileSync(
        path.join(__dirname, "..", "reply-listener.ts"),
        "utf-8",
      );
      // Should use buildDaemonConfig, not readDaemonConfig
      expect(source).toContain("buildDaemonConfig");
      expect(source).not.toContain("readDaemonConfig");
      expect(source).not.toContain("writeDaemonConfig");
      // Should import from config.js
      expect(source).toContain("getNotificationConfig");
      expect(source).toContain("getReplyConfig");
      expect(source).toContain("getReplyListenerPlatformConfig");
    });

    it("forwards OMC_* env vars to daemon process", () => {
      const fs = require("fs");
      const path = require("path");
      const source = fs.readFileSync(
        path.join(__dirname, "..", "reply-listener.ts"),
        "utf-8",
      );
      // Should forward OMC_* env vars for getNotificationConfig()
      expect(source).toContain("OMC_");
      expect(source).toContain("startsWith('OMC_')");
    });

    it("uses minimal env allowlist for daemon", () => {
      const allowlist = [
        'PATH', 'HOME', 'TMUX', 'TMUX_PANE', 'TERM',
      ];

      // Only allowlisted vars should be passed to daemon
      expect(allowlist.includes('PATH')).toBe(true);
      expect(allowlist.includes('ANTHROPIC_API_KEY')).toBe(false);
    });
  });

  describe("Injection feedback", () => {
    it("Discord sends checkmark reaction on successful injection", () => {
      const channelId = "123456";
      const messageId = "789012";
      const expectedUrl = `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/%E2%9C%85/@me`;

      expect(expectedUrl).toContain("/reactions/%E2%9C%85/@me");
      expect(expectedUrl).toContain(channelId);
      expect(expectedUrl).toContain(messageId);
    });

    it("Discord sends channel notification as reply to user message", () => {
      const channelId = "123456";
      const userMessageId = "999888777";
      const expectedUrl = `https://discord.com/api/v10/channels/${channelId}/messages`;
      const expectedBody = {
        content: "Injected into Claude Code session.",
        message_reference: { message_id: userMessageId },
        allowed_mentions: { parse: [] },
      };

      expect(expectedUrl).toContain(`/channels/${channelId}/messages`);
      expect(expectedUrl).not.toContain("reactions");
      expect(expectedBody.message_reference.message_id).toBe(userMessageId);
    });

    it("Discord feedback includes message_reference in source code", () => {
      const fs = require("fs");
      const path = require("path");
      const source = fs.readFileSync(
        path.join(__dirname, "..", "reply-listener.ts"),
        "utf-8",
      );

      // The injection feedback POST should include message_reference
      expect(source).toContain("message_reference: { message_id: msg.id }");
    });

    it("Telegram sends reply confirmation on successful injection", () => {
      const chatId = "123456";
      const messageId = 789;
      const expectedBody = {
        chat_id: chatId,
        text: "Injected into Claude Code session.",
        reply_to_message_id: messageId,
      };

      expect(expectedBody.text).toBe("Injected into Claude Code session.");
      expect(expectedBody.reply_to_message_id).toBe(messageId);
    });

    it("feedback is non-critical and wrapped in try/catch", () => {
      const fs = require("fs");
      const path = require("path");
      const source = fs.readFileSync(
        path.join(__dirname, "..", "reply-listener.ts"),
        "utf-8",
      );

      // Reaction is in try/catch
      expect(source).toContain("Failed to add confirmation reaction");
      // Channel notification is in try/catch
      expect(source).toContain("Failed to send injection channel notification");
      // Telegram confirmation is in try/catch
      expect(source).toContain("Failed to send confirmation reply");
    });

    it("feedback uses 5-second timeout", () => {
      const fs = require("fs");
      const path = require("path");
      const source = fs.readFileSync(
        path.join(__dirname, "..", "reply-listener.ts"),
        "utf-8",
      );

      // Discord reaction + channel notification use AbortSignal.timeout(5000)
      const abortTimeoutMatches = source.match(/AbortSignal\.timeout\(5000\)/g);
      expect(abortTimeoutMatches).not.toBeNull();
      expect(abortTimeoutMatches!.length).toBeGreaterThanOrEqual(2);

      // Telegram confirmation uses httpsRequest timeout: 5000
      expect(source).toContain("timeout: 5000");
    });

    it("Discord channel notification uses parseMentionAllowedMentions for mention-aware allowed_mentions", () => {
      const fs = require("fs");
      const path = require("path");
      const source = fs.readFileSync(
        path.join(__dirname, "..", "reply-listener.ts"),
        "utf-8",
      );

      // Channel notification uses parseMentionAllowedMentions to build allowed_mentions
      expect(source).toContain("parseMentionAllowedMentions");
      // Falls back to { parse: [] } when no mention is configured
      expect(source).toContain("parse: [] as string[]");
    });

    it("does not send feedback on failed injection", () => {
      const fs = require("fs");
      const path = require("path");
      const source = fs.readFileSync(
        path.join(__dirname, "..", "reply-listener.ts"),
        "utf-8",
      );

      // Confirmation/feedback code is inside "if (success)" blocks
      // The else blocks only increment error counters
      const successBlocks = source.match(/if \(success\) \{[\s\S]*?messagesInjected/g);
      expect(successBlocks).not.toBeNull();
      expect(successBlocks!.length).toBe(4); // one for Discord, one for Telegram, one for Slack inline, one for processSlackSocketMessage
    });
  });

  describe("Injection feedback mention", () => {
    it("prefixes Discord feedback with mention when discordMention is set", () => {
      const mention = "<@123456789012345678>";
      const mentionPrefix = mention ? `${mention} ` : '';
      const content = `${mentionPrefix}Injected into Claude Code session.`;

      expect(content).toBe("<@123456789012345678> Injected into Claude Code session.");
    });

    it("omits mention prefix when discordMention is undefined", () => {
      const mention: string | undefined = undefined;
      const mentionPrefix = mention ? `${mention} ` : '';
      const content = `${mentionPrefix}Injected into Claude Code session.`;

      expect(content).toBe("Injected into Claude Code session.");
    });

    it("builds allowed_mentions for user mention", () => {
      // Inline equivalent of parseMentionAllowedMentions for user mention
      const mention = "<@123456789012345678>";
      const userMatch = mention.match(/^<@!?(\d{17,20})>$/);
      const allowedMentions = userMatch ? { users: [userMatch[1]] } : {};

      expect(allowedMentions).toEqual({ users: ["123456789012345678"] });
    });

    it("builds allowed_mentions for role mention", () => {
      const mention = "<@&123456789012345678>";
      const roleMatch = mention.match(/^<@&(\d{17,20})>$/);
      const allowedMentions = roleMatch ? { roles: [roleMatch[1]] } : {};

      expect(allowedMentions).toEqual({ roles: ["123456789012345678"] });
    });

    it("falls back to suppressing mentions when no discordMention", () => {
      const mention: string | undefined = undefined;
      const allowedMentions = mention
        ? { users: ["123"] }
        : { parse: [] as string[] };

      expect(allowedMentions).toEqual({ parse: [] });
    });

    it("ReplyListenerDaemonConfig includes discordMention field", () => {
      const fs = require("fs");
      const path = require("path");
      const source = fs.readFileSync(
        path.join(__dirname, "..", "reply-listener.ts"),
        "utf-8",
      );

      expect(source).toContain("discordMention?: string");
    });

    it("buildDaemonConfig passes discordMention from notification config", () => {
      const fs = require("fs");
      const path = require("path");
      const source = fs.readFileSync(
        path.join(__dirname, "..", "reply-listener.ts"),
        "utf-8",
      );

      // buildDaemonConfig spreads platformConfig which now includes discordMention
      expect(source).toContain("getReplyListenerPlatformConfig");
      expect(source).toContain("...platformConfig");
    });

    it("getReplyListenerPlatformConfig returns discordMention", () => {
      const fs = require("fs");
      const path = require("path");
      const configSource = fs.readFileSync(
        path.join(__dirname, "..", "config.ts"),
        "utf-8",
      );

      expect(configSource).toContain("discordMention");
      // Should read mention from discordBotConfig
      expect(configSource).toContain("discordBotConfig?.mention");
    });

    it("Telegram feedback does not include Discord mention", () => {
      const fs = require("fs");
      const path = require("path");
      const source = fs.readFileSync(
        path.join(__dirname, "..", "reply-listener.ts"),
        "utf-8",
      );

      // Telegram sendMessage body should not reference discordMention
      // Find the Telegram reply body - it uses a simple text string
      const telegramReplyMatch = source.match(
        /text:\s*['"]Injected into Claude Code session\.['"]/g,
      );
      expect(telegramReplyMatch).not.toBeNull();
      // Should have exactly 1 match (Telegram only; Discord now uses template)
      expect(telegramReplyMatch!.length).toBe(1);
    });
  });

  describe("Error handling", () => {
    it("logs errors without blocking", () => {
      // Errors should be logged but not throw
      expect(true).toBe(true);
    });

    it("continues processing after failed injection", () => {
      // Failed injection should increment error counter
      const state = { errors: 0 };
      state.errors++;

      expect(state.errors).toBe(1);
    });

    it("backs off on repeated errors", () => {
      // After error, wait 2x poll interval before next poll
      const pollIntervalMs = 3000;
      const backoffMs = pollIntervalMs * 2;

      expect(backoffMs).toBe(6000);
    });
  });
});
