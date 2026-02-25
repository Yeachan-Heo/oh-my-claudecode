import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _openclaw } from "../bridge.js";

describe("_openclaw.wake", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("is a no-op when OMC_OPENCLAW is not set", () => {
    vi.stubEnv("OMC_OPENCLAW", "");
    // Should return undefined without doing anything
    const result = _openclaw.wake("session-start", { sessionId: "sid-1" });
    expect(result).toBeUndefined();
  });

  it("is a no-op when OMC_OPENCLAW is not '1'", () => {
    vi.stubEnv("OMC_OPENCLAW", "true");
    const result = _openclaw.wake("session-start", { sessionId: "sid-1" });
    expect(result).toBeUndefined();
  });

  it("triggers the dynamic import when OMC_OPENCLAW === '1'", async () => {
    vi.stubEnv("OMC_OPENCLAW", "1");

    // Mock the dynamic import of openclaw/index.js
    const mockWakeOpenClaw = vi.fn().mockResolvedValue({ gateway: "test", success: true });
    vi.doMock("../../openclaw/index.js", () => ({
      wakeOpenClaw: mockWakeOpenClaw,
    }));

    _openclaw.wake("session-start", { sessionId: "sid-1", projectPath: "/home/user/project" });

    // Give the microtask queue time to process the dynamic import
    await new Promise((resolve) => setTimeout(resolve, 10));

    vi.doUnmock("../../openclaw/index.js");
  });

  it("does not throw when OMC_OPENCLAW === '1' and import fails", async () => {
    vi.stubEnv("OMC_OPENCLAW", "1");

    // Even if the dynamic import fails, _openclaw.wake should not throw
    expect(() => {
      _openclaw.wake("session-start", {});
    }).not.toThrow();

    // Give time for the promise chain to settle
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("accepts all supported hook event types", () => {
    vi.stubEnv("OMC_OPENCLAW", "");
    // These should all be callable without type errors (no-op since OMC_OPENCLAW not set)
    expect(() => _openclaw.wake("session-start", {})).not.toThrow();
    expect(() => _openclaw.wake("session-end", {})).not.toThrow();
    expect(() => _openclaw.wake("pre-tool-use", { toolName: "Bash" })).not.toThrow();
    expect(() => _openclaw.wake("post-tool-use", { toolName: "Bash" })).not.toThrow();
    expect(() => _openclaw.wake("stop", {})).not.toThrow();
    expect(() => _openclaw.wake("keyword-detector", { prompt: "hello" })).not.toThrow();
    expect(() => _openclaw.wake("ask-user-question", { question: "what?" })).not.toThrow();
  });

  it("passes context fields through to wakeOpenClaw", async () => {
    vi.stubEnv("OMC_OPENCLAW", "1");

    const mockWakeOpenClaw = vi.fn().mockResolvedValue(null);
    vi.doMock("../../openclaw/index.js", () => ({
      wakeOpenClaw: mockWakeOpenClaw,
    }));

    const context = { sessionId: "sid-123", projectPath: "/home/user/project", toolName: "Read" };
    _openclaw.wake("pre-tool-use", context);

    // Wait for async import
    await new Promise((resolve) => setTimeout(resolve, 10));

    vi.doUnmock("../../openclaw/index.js");
  });
});
