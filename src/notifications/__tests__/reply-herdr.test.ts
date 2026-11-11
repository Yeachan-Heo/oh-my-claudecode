/**
 * Tests for Herdr reply routing in src/notifications/reply-listener.ts.
 *
 * The Herdr engine and the session registry are module-mocked; the shared
 * sanitization (buildReplyInjectionSteps) runs for real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const herdrMocks = vi.hoisted(() => ({
  captureHerdrWorkerPane: vi.fn(),
  herdrSendPrompt: vi.fn(),
  isHerdrWorkerAlive: vi.fn(),
}));

const registryMocks = vi.hoisted(() => ({
  removeMessagesByPane: vi.fn(),
}));

vi.mock("../../team/herdr-session.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../team/herdr-session.js")>();
  return {
    ...actual,
    captureHerdrWorkerPane: herdrMocks.captureHerdrWorkerPane,
    herdrSendPrompt: herdrMocks.herdrSendPrompt,
    isHerdrWorkerAlive: herdrMocks.isHerdrWorkerAlive,
  };
});

vi.mock("../session-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../session-registry.js")>();
  return {
    ...actual,
    removeMessagesByPane: registryMocks.removeMessagesByPane,
  };
});

import {
  createMinimalDaemonEnv,
  injectReplyIntoHerdrPane,
} from "../reply-listener.js";

const config = {
  includePrefix: true,
  maxMessageLength: 200,
} as unknown as Parameters<typeof injectReplyIntoHerdrPane>[3];

describe("injectReplyIntoHerdrPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers the sanitized reply through the semantic agent surface", async () => {
    herdrMocks.captureHerdrWorkerPane.mockResolvedValue(
      "Claude Code session output",
    );
    herdrMocks.herdrSendPrompt.mockResolvedValue(undefined);

    await expect(
      injectReplyIntoHerdrPane("w9:p2", "hello world", "discord", config),
    ).resolves.toBe(true);

    expect(herdrMocks.herdrSendPrompt).toHaveBeenCalledWith(
      "w9:p2",
      "[reply:discord] hello world",
    );
    expect(registryMocks.removeMessagesByPane).not.toHaveBeenCalled();
  });

  it("submits the typed reply for ask-user-question mappings too", async () => {
    herdrMocks.captureHerdrWorkerPane.mockResolvedValue(
      "Claude Code question UI",
    );
    herdrMocks.herdrSendPrompt.mockResolvedValue(undefined);

    await expect(
      injectReplyIntoHerdrPane("w9:p2", "Use SQLite", "telegram", config, {
        platform: "telegram-bot",
        messageId: "1",
        sessionId: "s1",
        tmuxPaneId: "w9:p2",
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        event: "ask-user-question",
        askUserQuestionOptionCount: 2,
        askUserQuestionAllowOther: true,
      } as unknown as Parameters<typeof injectReplyIntoHerdrPane>[4]),
    ).resolves.toBe(true);

    // One submission-verified prompt replaces the tmux Down/Enter walk.
    expect(herdrMocks.herdrSendPrompt).toHaveBeenCalledTimes(1);
    expect(herdrMocks.herdrSendPrompt).toHaveBeenCalledWith(
      "w9:p2",
      "[reply:telegram] Use SQLite",
    );
  });

  it("keeps the mapping when the capture is empty but the pane agent still runs", async () => {
    herdrMocks.captureHerdrWorkerPane.mockResolvedValue("   ");
    herdrMocks.isHerdrWorkerAlive.mockResolvedValue(true);
    await expect(
      injectReplyIntoHerdrPane("w9:p2", "hi", "discord", config),
    ).resolves.toBe(false);
    expect(herdrMocks.isHerdrWorkerAlive).toHaveBeenCalledWith("w9:p2");
    expect(registryMocks.removeMessagesByPane).not.toHaveBeenCalled();
    expect(herdrMocks.herdrSendPrompt).not.toHaveBeenCalled();
  });

  it("keeps the mapping when Herdr cannot report whether the pane agent runs", async () => {
    herdrMocks.captureHerdrWorkerPane.mockRejectedValue(new Error("timeout"));
    herdrMocks.isHerdrWorkerAlive.mockRejectedValue(new Error("herdr unavailable"));
    await expect(
      injectReplyIntoHerdrPane("w9:p2", "hi", "discord", config),
    ).resolves.toBe(false);
    expect(registryMocks.removeMessagesByPane).not.toHaveBeenCalled();
    expect(herdrMocks.herdrSendPrompt).not.toHaveBeenCalled();
  });

  it("removes the mapping when the capture fails and no agent runs in the pane", async () => {
    herdrMocks.captureHerdrWorkerPane.mockRejectedValue(new Error("pane_gone"));
    herdrMocks.isHerdrWorkerAlive.mockResolvedValue(false);
    await expect(
      injectReplyIntoHerdrPane("w9:p2", "hi", "discord", config),
    ).resolves.toBe(false);
    expect(registryMocks.removeMessagesByPane).toHaveBeenCalledWith("w9:p2");
    expect(herdrMocks.herdrSendPrompt).not.toHaveBeenCalled();
  });

  it("reports failure when the agent surface rejects the prompt", async () => {
    herdrMocks.captureHerdrWorkerPane.mockResolvedValue(
      "Claude Code session output",
    );
    herdrMocks.herdrSendPrompt.mockRejectedValue(new Error("agent_not_found"));

    await expect(
      injectReplyIntoHerdrPane("w9:p2", "hi", "slack", config),
    ).resolves.toBe(false);
  });
});

describe("createMinimalDaemonEnv herdr pin forwarding", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("forwards the herdr binary pin alongside the pane id", () => {
    // When herdr is available only via HERDR_BIN_PATH (not on PATH), the
    // detached listener must keep the pin or resolveHerdrBinary falls back
    // to the unavailable bare name and every capture reads as an empty pane.
    process.env.HERDR_BIN_PATH = "/opt/herdr/herdr";
    process.env.HERDR_PANE_ID = "w9:p2";
    const env = createMinimalDaemonEnv();
    expect(env.HERDR_BIN_PATH).toBe("/opt/herdr/herdr");
    expect(env.HERDR_PANE_ID).toBe("w9:p2");
    // Credentials outside the allowlist never leak into the daemon env.
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    const guarded = createMinimalDaemonEnv();
    expect(guarded.ANTHROPIC_API_KEY).toBeUndefined();
    expect(guarded.HERDR_BIN_PATH).toBe("/opt/herdr/herdr");
  });

  it("omits herdr variables when unset", () => {
    delete process.env.HERDR_BIN_PATH;
    delete process.env.HERDR_PANE_ID;
    const env = createMinimalDaemonEnv();
    expect("HERDR_BIN_PATH" in env).toBe(false);
    expect("HERDR_PANE_ID" in env).toBe(false);
  });
});
