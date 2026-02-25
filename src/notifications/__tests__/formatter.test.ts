import { describe, it, expect } from "vitest";
import {
  formatSessionIdle,
  formatSessionEnd,
  formatAgentCall,
  formatNotification,
  parseTmuxTail,
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

describe("parseTmuxTail", () => {
  it("returns empty string for empty input", () => {
    expect(parseTmuxTail("")).toBe("");
  });

  it("strips ANSI escape codes", () => {
    const result = parseTmuxTail("\x1b[32mhello\x1b[0m world");
    expect(result).toBe("hello world");
  });

  it("strips multi-parameter ANSI sequences", () => {
    const result = parseTmuxTail("\x1b[1;34mBold blue\x1b[0m");
    expect(result).toBe("Bold blue");
  });

  it("removes lines starting with ●", () => {
    const result = parseTmuxTail("● Running tests\nnormal line");
    expect(result).toBe("normal line");
    expect(result).not.toContain("●");
  });

  it("removes lines starting with ⎿", () => {
    const result = parseTmuxTail("⎿ subtask detail\nnormal line");
    expect(result).toBe("normal line");
  });

  it("removes lines starting with ✻", () => {
    const result = parseTmuxTail("✻ spinning indicator\nnormal line");
    expect(result).toBe("normal line");
  });

  it("removes lines starting with ·", () => {
    const result = parseTmuxTail("· bullet item\nnormal line");
    expect(result).toBe("normal line");
  });

  it("removes lines starting with ◼", () => {
    const result = parseTmuxTail("◼ block item\nnormal line");
    expect(result).toBe("normal line");
  });

  it("removes 'ctrl+o to expand' lines (case-insensitive)", () => {
    const result = parseTmuxTail("some output\nctrl+o to expand\nmore output");
    expect(result).not.toContain("ctrl+o to expand");
    expect(result).toBe("some output\nmore output");
  });

  it("removes 'Ctrl+O to Expand' mixed-case variant", () => {
    const result = parseTmuxTail("line1\nCtrl+O to Expand\nline2");
    expect(result).not.toContain("Expand");
    expect(result).toBe("line1\nline2");
  });

  it("skips blank lines", () => {
    const result = parseTmuxTail("\n\nfoo\n\nbar\n\n");
    expect(result).toBe("foo\nbar");
  });

  it("caps output at 10 meaningful lines, returning the LAST 10", () => {
    const input = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = parseTmuxTail(input);
    const lines = result.split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("line 11");
    expect(lines[9]).toBe("line 20");
  });

  it("returns fewer than 10 lines when input has fewer meaningful lines", () => {
    const result = parseTmuxTail("line 1\nline 2\nline 3");
    expect(result.split("\n")).toHaveLength(3);
  });

  it("trims trailing whitespace from each line", () => {
    const result = parseTmuxTail("hello   \nworld  ");
    expect(result).toBe("hello\nworld");
  });

  it("handles mixed content: chrome + ANSI + normal lines", () => {
    const input = [
      "\x1b[32m● Starting task\x1b[0m",
      "\x1b[1mBuilding project\x1b[0m",
      "● Another chrome line",
      "ctrl+o to expand",
      "Tests passed: 42",
    ].join("\n");
    const result = parseTmuxTail(input);
    expect(result).toBe("Building project\nTests passed: 42");
  });

  it("does not remove lines that merely contain chrome characters mid-line", () => {
    const result = parseTmuxTail("status: ● ok");
    expect(result).toBe("status: ● ok");
  });
});

describe("parseTmuxTail noise filters", () => {
  it("drops box-drawing-only lines", () => {
    expect(parseTmuxTail("────────────────────────")).toBe("");
  });

  it("drops box-drawing lines with surrounding whitespace", () => {
    expect(parseTmuxTail("  ━━━━━━━━━━  ")).toBe("");
  });

  it("preserves text lines mixed with box-drawing separators", () => {
    const result = parseTmuxTail("Table ─── Header\n────────────");
    expect(result).toBe("Table ─── Header");
  });

  it("drops OMC HUD versioned status lines", () => {
    expect(
      parseTmuxTail("[OMC#4.4.5] | thinking | session:510m | ctx:61% | 🔧57"),
    ).toBe("");
  });

  it("drops unversioned OMC HUD lines", () => {
    expect(parseTmuxTail("[OMC] | session:5m")).toBe("");
  });

  it("drops bypass-permissions indicator lines starting with ⏵", () => {
    expect(
      parseTmuxTail(
        "⏵⏵ bypass permissions on · python3 -m intentio mission missions/py… (running)",
      ),
    ).toBe("");
  });

  it("drops bare ❯ prompt with no command", () => {
    expect(parseTmuxTail("❯")).toBe("");
  });

  it("preserves prompt line that has a command after it", () => {
    const result = parseTmuxTail("❯ npm test\nAll tests passed");
    expect(result).toBe("❯ npm test\nAll tests passed");
  });

  it("drops lines with low alphanumeric density (mostly special chars)", () => {
    // 20 special chars + 1 letter = ~5% alnum ratio, well below 15% threshold
    const noisyLine = "@@@@@@@@@@@@@@@@@@@@a";
    expect(parseTmuxTail(noisyLine)).toBe("");
  });

  it("preserves URLs which have sufficient alphanumeric density", () => {
    expect(parseTmuxTail("https://example.com/api/v2")).toBe(
      "https://example.com/api/v2",
    );
  });

  it("exempts short lines (< 8 chars) from alphanumeric density check", () => {
    // "..." is 3 chars, 0% alnum — but too short to trigger the density filter
    expect(parseTmuxTail("...")).toBe("...");
  });

  it("returns empty string when all lines are noise types", () => {
    const input = [
      "────────────────────────",
      "[OMC#4.4.5] | thinking | session:510m",
      "⏵⏵ bypass permissions on",
      "❯",
      "@@@@@@@@@@@@@@@@@@@@",
    ].join("\n");
    expect(parseTmuxTail(input)).toBe("");
  });

  it("keeps only signal lines when noise and signal are mixed", () => {
    const input = [
      "────────────────────────",
      "Build complete",
      "[OMC#4.4.5] | thinking | session:510m",
      "Tests passed: 42",
      "⏵⏵ bypass permissions on",
      "❯",
      "@@@@@@@@@@@@@@@@@@@@",
    ].join("\n");
    expect(parseTmuxTail(input)).toBe("Build complete\nTests passed: 42");
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
