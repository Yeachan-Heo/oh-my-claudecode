import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  statSync,
  readFileSync,
  writeFileSync,
  utimesSync,
  openSync,
  closeSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import {
  registerMessage,
  lookupByMessageId,
  removeSession,
  removeMessagesByPane,
  pruneStale,
  loadAllMappings,
  type SessionMapping,
} from "../session-registry.js";

const SESSION_REGISTRY_MODULE_PATH = join(process.cwd(), "src", "notifications", "session-registry.ts");

let testDir: string;
let REGISTRY_PATH: string;
let LOCK_PATH: string;

function registerMessageInChildProcess(mapping: SessionMapping): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = `
import { registerMessage } from ${JSON.stringify(SESSION_REGISTRY_MODULE_PATH)};
const mapping = JSON.parse(process.env.TEST_MAPPING_JSON ?? "{}");
registerMessage(mapping);
`;

    const child = spawn(process.execPath, ["--import", "tsx", "-e", script], {
      env: {
        ...process.env,
        TEST_MAPPING_JSON: JSON.stringify(mapping),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `child exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

describe("session-registry", () => {
  beforeEach(() => {
    // Create a fresh temp directory for each test so registry I/O is fully
    // isolated from the real ~/.omc/state and from other parallel test runs.
    testDir = mkdtempSync(join(tmpdir(), "omc-session-registry-test-"));
    process.env["OMC_TEST_REGISTRY_DIR"] = testDir;
    REGISTRY_PATH = join(testDir, "reply-session-registry.jsonl");
    LOCK_PATH = join(testDir, "reply-session-registry.lock");
  });

  afterEach(() => {
    delete process.env["OMC_TEST_REGISTRY_DIR"];
    rmSync(testDir, { recursive: true, force: true });
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

    it("releases lock file after append", () => {
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
      expect(existsSync(LOCK_PATH)).toBe(false);
    });

    it("recovers from stale lock file", () => {
      // Create stale lock file (>10s old)
      writeFileSync(LOCK_PATH, "stale-lock");
      const staleTime = new Date(Date.now() - 30_000);
      utimesSync(LOCK_PATH, staleTime, staleTime);

      const mapping: SessionMapping = {
        platform: "telegram",
        messageId: "456",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "session-start",
        createdAt: new Date().toISOString(),
      };

      registerMessage(mapping);

      const loaded = loadAllMappings();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].messageId).toBe("456");
      expect(existsSync(LOCK_PATH)).toBe(false);
    });

    it("does not drop writes under contention (eventually appends)", async () => {
      // Hold lock to force registerMessage to block waiting.
      const lockFd = openSync(LOCK_PATH, "wx", 0o600);
      const mapping: SessionMapping = {
        platform: "discord-bot",
        messageId: "contended",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "session-start",
        createdAt: new Date().toISOString(),
      };

      const registerPromise = registerMessageInChildProcess(mapping);

      // Give child process time to start and attempt lock acquisition.
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(existsSync(REGISTRY_PATH)).toBe(false);

      // Release lock, then registerMessage should proceed.
      closeSync(lockFd);
      unlinkSync(LOCK_PATH);

      await registerPromise;

      const loaded = loadAllMappings();
      expect(loaded.some(m => m.messageId === "contended")).toBe(true);
    });

    it("retries across lock-timeout windows and eventually appends", async () => {
      // Hold lock for > LOCK_TIMEOUT_MS (2s) to force timeout + retry behavior.
      const lockFd = openSync(LOCK_PATH, "wx", 0o600);
      const mapping: SessionMapping = {
        platform: "telegram",
        messageId: "timeout-retry",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "ask-user-question",
        createdAt: new Date().toISOString(),
      };

      const registerPromise = registerMessageInChildProcess(mapping);

      await new Promise(resolve => setTimeout(resolve, 2300));
      expect(existsSync(REGISTRY_PATH)).toBe(false);
      expect(existsSync(LOCK_PATH)).toBe(true);

      closeSync(lockFd);
      unlinkSync(LOCK_PATH);

      await registerPromise;

      const loaded = loadAllMappings();
      expect(loaded.some(m => m.messageId === "timeout-retry")).toBe(true);
    });

    it("does not reap stale lock when owner pid is still alive", async () => {
      // Stale mtime alone should not trigger lock removal if owner pid is alive.
      writeFileSync(
        LOCK_PATH,
        JSON.stringify({
          pid: process.pid,
          acquiredAt: Date.now() - 60_000,
          token: "live-owner-token",
        }),
      );
      const staleTime = new Date(Date.now() - 30_000);
      utimesSync(LOCK_PATH, staleTime, staleTime);

      const mapping: SessionMapping = {
        platform: "discord-bot",
        messageId: "alive-owner",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "session-start",
        createdAt: new Date().toISOString(),
      };

      const registerPromise = registerMessageInChildProcess(mapping);

      await new Promise(resolve => setTimeout(resolve, 150));
      expect(existsSync(LOCK_PATH)).toBe(true);
      expect(existsSync(REGISTRY_PATH)).toBe(false);

      // Simulate owner releasing lock; waiting writer should proceed.
      unlinkSync(LOCK_PATH);
      await registerPromise;

      const loaded = loadAllMappings();
      expect(loaded.some(m => m.messageId === "alive-owner")).toBe(true);
    });

    it("reaps stale lock when owner pid is not alive", () => {
      writeFileSync(
        LOCK_PATH,
        JSON.stringify({
          pid: 0,
          acquiredAt: Date.now() - 60_000,
          token: "dead-owner-token",
        }),
      );
      const staleTime = new Date(Date.now() - 30_000);
      utimesSync(LOCK_PATH, staleTime, staleTime);

      const mapping: SessionMapping = {
        platform: "telegram",
        messageId: "dead-owner",
        sessionId: "session-1",
        tmuxPaneId: "%0",
        tmuxSessionName: "main",
        event: "session-start",
        createdAt: new Date().toISOString(),
      };

      registerMessage(mapping);

      const loaded = loadAllMappings();
      expect(loaded.some(m => m.messageId === "dead-owner")).toBe(true);
      expect(existsSync(LOCK_PATH)).toBe(false);
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

    it("returns the most recent entry when duplicate message IDs exist", () => {
      const older: SessionMapping = {
        platform: "discord-bot",
        messageId: "dup-id",
        sessionId: "session-old",
        tmuxPaneId: "%0",
        tmuxSessionName: "old-session",
        event: "session-start",
        createdAt: new Date(Date.now() - 5000).toISOString(),
      };

      const newer: SessionMapping = {
        platform: "discord-bot",
        messageId: "dup-id",
        sessionId: "session-new",
        tmuxPaneId: "%1",
        tmuxSessionName: "new-session",
        event: "session-start",
        createdAt: new Date().toISOString(),
      };

      registerMessage(older);
      registerMessage(newer);

      const result = lookupByMessageId("discord-bot", "dup-id");
      expect(result).not.toBeNull();
      expect(result?.sessionId).toBe("session-new");
      expect(result?.tmuxPaneId).toBe("%1");
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
