/**
 * Tests for session-scoped idle notification cooldown.
 * Verifies each session has independent cooldown state.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import {
  shouldSendIdleNotification,
  recordIdleNotificationSent,
  getIdleNotificationCooldownSeconds,
} from "./index.js";

describe("idle notification cooldown (issue #842)", () => {
  let tempDir: string;
  let stateDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "idle-cooldown-test-"));
    stateDir = join(tempDir, ".omc", "state");
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("shouldSendIdleNotification", () => {
    const zeroBacklogState = { signature: "repo-zero", backlogZero: true };
    const changedBacklogState = { signature: "repo-new", backlogZero: true };

    it("returns true when no cooldown file exists", () => {
      expect(shouldSendIdleNotification(stateDir)).toBe(true);
    });

    it("returns false when cooldown file was written recently", () => {
      const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
      writeFileSync(
        cooldownPath,
        JSON.stringify({ lastSentAt: new Date().toISOString() })
      );
      expect(shouldSendIdleNotification(stateDir)).toBe(false);
    });

    it("returns true when cooldown file timestamp is past the cooldown window", () => {
      const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
      // Write a timestamp 2 minutes in the past (default cooldown is 60s)
      const past = new Date(Date.now() - 120_000).toISOString();
      writeFileSync(cooldownPath, JSON.stringify({ lastSentAt: past }));
      expect(shouldSendIdleNotification(stateDir)).toBe(true);
    });

    it("returns true when cooldown file contains invalid JSON", () => {
      const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
      writeFileSync(cooldownPath, "{ not valid json");
      expect(shouldSendIdleNotification(stateDir)).toBe(true);
    });

    it("returns true when cooldown file is missing lastSentAt field", () => {
      const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
      writeFileSync(cooldownPath, JSON.stringify({ other: "field" }));
      expect(shouldSendIdleNotification(stateDir)).toBe(true);
    });

    it("uses session-scoped cooldown path when sessionId is provided", () => {
      const sessionId = "session-abc";
      const cooldownPath = join(
        stateDir,
        "sessions",
        sessionId,
        "idle-notif-cooldown.json"
      );
      mkdirSync(dirname(cooldownPath), { recursive: true });
      writeFileSync(
        cooldownPath,
        JSON.stringify({ lastSentAt: new Date().toISOString() })
      );

      expect(shouldSendIdleNotification(stateDir, sessionId)).toBe(false);
      expect(shouldSendIdleNotification(stateDir, "different-session")).toBe(true);
    });


    it("suppresses repeated zero-backlog notifications across follow-up sessions when the global repo snapshot is unchanged", () => {
      const globalCooldownPath = join(stateDir, "idle-notif-cooldown.json");
      const past = new Date(Date.now() - 120_000).toISOString();
      writeFileSync(
        globalCooldownPath,
        JSON.stringify({
          lastSentAt: past,
          repoSignature: zeroBacklogState.signature,
          backlogZero: true,
        })
      );

      expect(shouldSendIdleNotification(stateDir, "fresh-session", zeroBacklogState)).toBe(false);
    });

    it("re-enables zero-backlog notifications across follow-up sessions when the repo snapshot changes", () => {
      const globalCooldownPath = join(stateDir, "idle-notif-cooldown.json");
      writeFileSync(
        globalCooldownPath,
        JSON.stringify({
          lastSentAt: new Date().toISOString(),
          repoSignature: zeroBacklogState.signature,
          backlogZero: true,
        })
      );

      expect(shouldSendIdleNotification(stateDir, "fresh-session", changedBacklogState)).toBe(true);
    });

    it("suppresses repeated zero-backlog notifications when repo state has not changed", () => {
      const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
      const past = new Date(Date.now() - 120_000).toISOString();
      writeFileSync(
        cooldownPath,
        JSON.stringify({
          lastSentAt: past,
          repoSignature: zeroBacklogState.signature,
          backlogZero: true,
        })
      );

      expect(shouldSendIdleNotification(stateDir, undefined, zeroBacklogState)).toBe(false);
    });

    it("bypasses cooldown immediately when repo state changes", () => {
      const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
      writeFileSync(
        cooldownPath,
        JSON.stringify({
          lastSentAt: new Date().toISOString(),
          repoSignature: zeroBacklogState.signature,
          backlogZero: true,
        })
      );

      expect(shouldSendIdleNotification(stateDir, undefined, changedBacklogState)).toBe(true);
    });
  });

  describe("recordIdleNotificationSent", () => {
    const zeroBacklogState = { signature: "repo-zero", backlogZero: true };

    it("creates cooldown file with lastSentAt timestamp", () => {
      const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
      expect(existsSync(cooldownPath)).toBe(false);

      recordIdleNotificationSent(stateDir);

      expect(existsSync(cooldownPath)).toBe(true);
      const data = JSON.parse(readFileSync(cooldownPath, "utf-8")) as Record<string, unknown>;
      expect(typeof data.lastSentAt).toBe("string");
      const ts = new Date(data.lastSentAt as string).getTime();
      expect(Number.isFinite(ts)).toBe(true);
      expect(ts).toBeGreaterThan(Date.now() - 5000);
    });

    it("overwrites an existing cooldown file", () => {
      const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
      const old = new Date(Date.now() - 120_000).toISOString();
      writeFileSync(cooldownPath, JSON.stringify({ lastSentAt: old }));

      recordIdleNotificationSent(stateDir);

      const data = JSON.parse(readFileSync(cooldownPath, "utf-8")) as Record<string, unknown>;
      expect(new Date(data.lastSentAt as string).getTime()).toBeGreaterThan(
        new Date(old).getTime()
      );
    });

    it("creates intermediate directories if they do not exist", () => {
      const deepStateDir = join(tempDir, "new", "deep", ".omc", "state");
      expect(existsSync(deepStateDir)).toBe(false);

      recordIdleNotificationSent(deepStateDir);

      expect(existsSync(join(deepStateDir, "idle-notif-cooldown.json"))).toBe(true);
    });

    it("writes to session-scoped path when sessionId is provided", () => {
      const sessionId = "session-xyz";
      const cooldownPath = join(
        stateDir,
        "sessions",
        sessionId,
        "idle-notif-cooldown.json"
      );
      expect(existsSync(cooldownPath)).toBe(false);

      recordIdleNotificationSent(stateDir, sessionId);

      expect(existsSync(cooldownPath)).toBe(true);
      expect(existsSync(join(stateDir, "idle-notif-cooldown.json"))).toBe(false);
    });


    it("mirrors zero-backlog metadata to the global cooldown path for follow-up sessions", () => {
      const sessionId = "session-xyz";
      const sessionCooldownPath = join(
        stateDir,
        "sessions",
        sessionId,
        "idle-notif-cooldown.json"
      );
      const globalCooldownPath = join(stateDir, "idle-notif-cooldown.json");

      recordIdleNotificationSent(stateDir, sessionId, zeroBacklogState);

      expect(existsSync(sessionCooldownPath)).toBe(true);
      expect(existsSync(globalCooldownPath)).toBe(true);

      const sessionData = JSON.parse(readFileSync(sessionCooldownPath, "utf-8")) as Record<string, unknown>;
      const globalData = JSON.parse(readFileSync(globalCooldownPath, "utf-8")) as Record<string, unknown>;
      expect(sessionData.repoSignature).toBe(zeroBacklogState.signature);
      expect(globalData.repoSignature).toBe(zeroBacklogState.signature);
      expect(sessionData.backlogZero).toBe(true);
      expect(globalData.backlogZero).toBe(true);
    });

    it("stores repo signature metadata when repo state is provided", () => {
      const cooldownPath = join(stateDir, "idle-notif-cooldown.json");

      recordIdleNotificationSent(stateDir, undefined, zeroBacklogState);

      const data = JSON.parse(readFileSync(cooldownPath, "utf-8")) as Record<string, unknown>;
      expect(data.repoSignature).toBe(zeroBacklogState.signature);
      expect(data.backlogZero).toBe(true);
    });
  });

  describe("cooldown integration: send → suppress → send after expiry", () => {
    it("suppresses second notification within cooldown window", () => {
      // First call: no cooldown file → should send
      expect(shouldSendIdleNotification(stateDir)).toBe(true);
      recordIdleNotificationSent(stateDir);

      // Second call immediately after: within cooldown window → should NOT send
      expect(shouldSendIdleNotification(stateDir)).toBe(false);
    });

    it("allows notification again after cooldown expires", () => {
      // Simulate a cooldown file written 2 minutes ago (past default 60s window)
      const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
      const past = new Date(Date.now() - 120_000).toISOString();
      writeFileSync(cooldownPath, JSON.stringify({ lastSentAt: past }));

      expect(shouldSendIdleNotification(stateDir)).toBe(true);
    });
  });

  describe("getIdleNotificationCooldownSeconds", () => {
    it("returns a non-negative number", () => {
      const val = getIdleNotificationCooldownSeconds();
      expect(typeof val).toBe("number");
      expect(val).toBeGreaterThanOrEqual(0);
    });
  });
});
