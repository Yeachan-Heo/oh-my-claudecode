import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, statSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  registerMessage,
  lookupByMessageId,
  removeSession,
  removeMessagesByPane,
  pruneStale,
  loadAllMappings,
  type SessionMapping,
} from "../session-registry.js";

const REGISTRY_PATH = join(homedir(), ".omc", "state", "reply-session-registry.jsonl");

describe("session-registry", () => {
  beforeEach(() => {
    // Clean up registry before each test
    if (existsSync(REGISTRY_PATH)) {
      unlinkSync(REGISTRY_PATH);
    }
  });

  afterEach(() => {
    // Clean up registry after each test
    if (existsSync(REGISTRY_PATH)) {
      unlinkSync(REGISTRY_PATH);
    }
  });

  describe("registerMessage", () => {
    it("appends to JSONL file", () => {
      const mapping1: SessionMapping = {
        platform: "discord-bot",
        messageId: "123",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "session-start",
        createdAt: new Date().toISOString(),
      };

      const mapping2: SessionMapping = {
        platform: "telegram",
        messageId: "456",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "ask-user-question",
        createdAt: new Date().toISOString(),
      };

      registerMessage(mapping1);
      registerMessage(mapping2);

      expect(existsSync(REGISTRY_PATH)).toBe(true);

      const content = readFileSync(REGISTRY_PATH, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);

      const parsed1 = JSON.parse(lines[0]);
      const parsed2 = JSON.parse(lines[1]);

      expect(parsed1.messageId).toBe("123");
      expect(parsed2.messageId).toBe("456");
    });

    it("creates file with secure permissions (0600)", () => {
      const mapping: SessionMapping = {
        platform: "discord-bot",
        messageId: "123",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "session-start",
        createdAt: new Date().toISOString(),
      };

      registerMessage(mapping);

      const stats = statSync(REGISTRY_PATH);
      const mode = stats.mode & 0o777;

      // On Windows, permissions may differ
      if (process.platform !== "win32") {
        expect(mode).toBe(0o600);
      }
    });
  });

  describe("lookupByMessageId", () => {
    it("finds correct mapping", () => {
      const mapping: SessionMapping = {
        platform: "discord-bot",
        messageId: "123",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "session-start",
        createdAt: new Date().toISOString(),
      };

      registerMessage(mapping);

      const result = lookupByMessageId("discord-bot", "123");
      expect(result).not.toBeNull();
      expect(result?.messageId).toBe("123");
      expect(result?.tmuxPaneId).toBe("%0");
    });

    it("returns null for unknown message", () => {
      const result = lookupByMessageId("discord-bot", "999");
      expect(result).toBeNull();
    });

    it("returns null for wrong platform", () => {
      const mapping: SessionMapping = {
        platform: "discord-bot",
        messageId: "123",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "session-start",
        createdAt: new Date().toISOString(),
      };

      registerMessage(mapping);

      const result = lookupByMessageId("telegram", "123");
      expect(result).toBeNull();
    });
  });

  describe("removeSession", () => {
    it("removes all entries for a session", () => {
      const mapping1: SessionMapping = {
        platform: "discord-bot",
        messageId: "123",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "session-start",
        createdAt: new Date().toISOString(),
      };

      const mapping2: SessionMapping = {
        platform: "telegram",
        messageId: "456",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "ask-user-question",
        createdAt: new Date().toISOString(),
      };

      const mapping3: SessionMapping = {
        platform: "discord-bot",
        messageId: "789",
        sessionId: "session-2",
        tmuxPaneId: "%1",
        tmuxSessionName: "other",
        event: "session-start",
        createdAt: new Date().toISOString(),
      };

      registerMessage(mapping1);
      registerMessage(mapping2);
      registerMessage(mapping3);

      removeSession("session-1");

      const remaining = loadAllMappings();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].sessionId).toBe("session-2");
    });

    it("does nothing when session not found", () => {
      const mapping: SessionMapping = {
        platform: "discord-bot",
        messageId: "123",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "session-start",
        createdAt: new Date().toISOString(),
      };

      registerMessage(mapping);

      removeSession("session-999");

      const remaining = loadAllMappings();
      expect(remaining).toHaveLength(1);
    });
  });

  describe("removeMessagesByPane", () => {
    it("removes entries for a pane", () => {
      const mapping1: SessionMapping = {
        platform: "discord-bot",
        messageId: "123",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "session-start",
        createdAt: new Date().toISOString(),
      };

      const mapping2: SessionMapping = {
        platform: "telegram",
        messageId: "456",
        sessionId: "session-2",
        tmuxPaneId: "%1",
        tmuxSessionName: "other",
        event: "session-start",
        createdAt: new Date().toISOString(),
      };

      registerMessage(mapping1);
      registerMessage(mapping2);

      removeMessagesByPane("%0");

      const remaining = loadAllMappings();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].tmuxPaneId).toBe("%1");
    });
  });

  describe("pruneStale", () => {
    it("removes entries older than 24h", () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25 hours ago
      const recent = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1 hour ago

      const staleMapping: SessionMapping = {
        platform: "discord-bot",
        messageId: "123",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "session-start",
        createdAt: yesterday.toISOString(),
      };

      const recentMapping: SessionMapping = {
        platform: "telegram",
        messageId: "456",
        sessionId: "session-2",
        tmuxPaneId: "%1",
        tmuxSessionName: "other",
        event: "session-start",
        createdAt: recent.toISOString(),
      };

      registerMessage(staleMapping);
      registerMessage(recentMapping);

      pruneStale();

      const remaining = loadAllMappings();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].messageId).toBe("456");
    });

    it("keeps entries created within 24h", () => {
      const recent = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1 hour ago

      const mapping: SessionMapping = {
        platform: "discord-bot",
        messageId: "123",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "session-start",
        createdAt: recent.toISOString(),
      };

      registerMessage(mapping);
      pruneStale();

      const remaining = loadAllMappings();
      expect(remaining).toHaveLength(1);
    });

    it("removes entries with invalid timestamps", () => {
      const mapping: SessionMapping = {
        platform: "discord-bot",
        messageId: "123",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "session-start",
        createdAt: "invalid-timestamp",
      };

      registerMessage(mapping);
      pruneStale();

      const remaining = loadAllMappings();
      expect(remaining).toHaveLength(0);
    });
  });

  describe("loadAllMappings", () => {
    it("returns empty array when file does not exist", () => {
      const mappings = loadAllMappings();
      expect(mappings).toEqual([]);
    });

    it("returns all mappings", () => {
      const mapping1: SessionMapping = {
        platform: "discord-bot",
        messageId: "123",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "session-start",
        createdAt: new Date().toISOString(),
      };

      const mapping2: SessionMapping = {
        platform: "telegram",
        messageId: "456",
        sessionId: "session-2",
        tmuxPaneId: "%1",
        tmuxSessionName: "other",
        event: "ask-user-question",
        createdAt: new Date().toISOString(),
      };

      registerMessage(mapping1);
      registerMessage(mapping2);

      const mappings = loadAllMappings();
      expect(mappings).toHaveLength(2);
      expect(mappings[0].messageId).toBe("123");
      expect(mappings[1].messageId).toBe("456");
    });

    it("skips invalid JSON lines", () => {
      const mapping: SessionMapping = {
        platform: "discord-bot",
        messageId: "123",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "session-start",
        createdAt: new Date().toISOString(),
      };

      registerMessage(mapping);

      // Manually append an invalid line
      const fs = require("fs");
      fs.appendFileSync(REGISTRY_PATH, "invalid json line\n");

      const mappings = loadAllMappings();
      expect(mappings).toHaveLength(1);
      expect(mappings[0].messageId).toBe("123");
    });
  });
});
