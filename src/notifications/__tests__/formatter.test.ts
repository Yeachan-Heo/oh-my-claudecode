import { describe, it, expect } from "vitest";
import {
  formatSessionIdle,
  formatSessionEnd,
  formatAgentCall,
  formatNotification,
} from "../formatter.js";
import type { NotificationPayload } from "../types.js";

describe("formatSessionIdle", () => {
  const basePayload: NotificationPayload = {
    event: "session-idle",
    sessionId: "test-session-123",
    message: "",
    timestamp: new Date("2025-01-15T12:00:00Z").toISOString(),
    projectPath: "/home/user/my-project",
    projectName: "my-project",
  };

  it("should include idle header and waiting message", () => {
    const result = formatSessionIdle(basePayload);
    expect(result).toContain("# Session Idle");
    expect(result).toContain("Claude has finished and is waiting for input.");
  });

  it("should include project info in footer", () => {
    const result = formatSessionIdle(basePayload);
    expect(result).toContain("`my-project`");
  });

  it("should include reason when provided", () => {
    const result = formatSessionIdle({
      ...basePayload,
      reason: "task_complete",
    });
    expect(result).toContain("**Reason:** task_complete");
  });

  it("should include modes when provided", () => {
    const result = formatSessionIdle({
      ...basePayload,
      modesUsed: ["ultrawork", "ralph"],
    });
    expect(result).toContain("**Modes:** ultrawork, ralph");
  });

  it("should include tmux session in footer when available", () => {
    const result = formatSessionIdle({
      ...basePayload,
      tmuxSession: "dev-session",
    });
    expect(result).toContain("`dev-session`");
  });
});

describe("formatNotification routing", () => {
  const basePayload: NotificationPayload = {
    event: "session-idle",
    sessionId: "test-session",
    message: "",
    timestamp: new Date().toISOString(),
    projectPath: "/tmp/test",
  };

  it("should route session-idle to formatSessionIdle", () => {
    const result = formatNotification(basePayload);
    expect(result).toContain("# Session Idle");
  });

  it("should route session-start correctly", () => {
    const result = formatNotification({ ...basePayload, event: "session-start" });
    expect(result).toContain("# Session Started");
  });

  it("should route session-end correctly", () => {
    const result = formatNotification({ ...basePayload, event: "session-end" });
    expect(result).toContain("# Session Ended");
  });

  it("should route session-stop correctly", () => {
    const result = formatNotification({ ...basePayload, event: "session-stop" });
    expect(result).toContain("# Session Continuing");
  });

  it("should route ask-user-question correctly", () => {
    const result = formatNotification({ ...basePayload, event: "ask-user-question" });
    expect(result).toContain("# Input Needed");
  });

  it("should route agent-call correctly", () => {
    const result = formatNotification({
      ...basePayload,
      event: "agent-call",
      agentName: "executor",
      agentType: "oh-my-claudecode:executor",
    });
    expect(result).toContain("# Agent Spawned");
  });
});

describe("formatAgentCall", () => {
  const basePayload: NotificationPayload = {
    event: "agent-call",
    sessionId: "test-session-123",
    message: "",
    timestamp: new Date().toISOString(),
    projectPath: "/home/user/my-project",
    projectName: "my-project",
  };

  it("should include agent spawned header", () => {
    const result = formatAgentCall(basePayload);
    expect(result).toContain("# Agent Spawned");
  });

  it("should include agent name when provided", () => {
    const result = formatAgentCall({
      ...basePayload,
      agentName: "executor",
    });
    expect(result).toContain("**Agent:** `executor`");
  });

  it("should include agent type when provided", () => {
    const result = formatAgentCall({
      ...basePayload,
      agentType: "oh-my-claudecode:executor",
    });
    expect(result).toContain("**Type:** `oh-my-claudecode:executor`");
  });

  it("should include footer with project info", () => {
    const result = formatAgentCall(basePayload);
    expect(result).toContain("`my-project`");
  });
});

describe("tmuxTail in formatters", () => {
  it("should include tmux tail in formatSessionIdle when present", () => {
    const payload: NotificationPayload = {
      event: "session-idle",
      sessionId: "test-session",
      message: "",
      timestamp: new Date().toISOString(),
      projectPath: "/tmp/test",
      tmuxTail: "$ npm test\nAll tests passed",
    };
    const result = formatSessionIdle(payload);
    expect(result).toContain("**Recent output:**");
    expect(result).toContain("$ npm test");
    expect(result).toContain("All tests passed");
  });

  it("should not include tmux tail section when not present", () => {
    const payload: NotificationPayload = {
      event: "session-idle",
      sessionId: "test-session",
      message: "",
      timestamp: new Date().toISOString(),
      projectPath: "/tmp/test",
    };
    const result = formatSessionIdle(payload);
    expect(result).not.toContain("**Recent output:**");
  });

  it("should include tmux tail in formatSessionEnd when present", () => {
    const payload: NotificationPayload = {
      event: "session-end",
      sessionId: "test-session",
      message: "",
      timestamp: new Date().toISOString(),
      projectPath: "/tmp/test",
      tmuxTail: "Build complete\nDone in 5.2s",
    };
    const result = formatSessionEnd(payload);
    expect(result).toContain("**Recent output:**");
    expect(result).toContain("Build complete");
    expect(result).toContain("Done in 5.2s");
  });
});
