/**
 * Tests for Herdr reply routing in src/notifications/reply-listener.ts.
 *
 * The Herdr engine and the session registry are module-mocked; the shared
 * sanitization (buildReplyInjectionSteps) runs for real.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const herdrMocks = vi.hoisted(() => ({
  captureHerdrWorkerPane: vi.fn(),
  herdrSendPrompt: vi.fn(),
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

import { injectReplyIntoHerdrPane } from "../reply-listener.js";

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

  it("removes the mapping when the pane is empty or unreadable", async () => {
    herdrMocks.captureHerdrWorkerPane.mockResolvedValue("   ");
    await expect(
      injectReplyIntoHerdrPane("w9:p2", "hi", "discord", config),
    ).resolves.toBe(false);
    expect(registryMocks.removeMessagesByPane).toHaveBeenCalledWith("w9:p2");

    vi.clearAllMocks();
    herdrMocks.captureHerdrWorkerPane.mockRejectedValue(new Error("pane_gone"));
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
