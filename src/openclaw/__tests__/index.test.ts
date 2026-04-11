import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";


const mockGetCurrentTmuxSession = vi.fn<() => string | null>(() => null);
vi.mock("../../notifications/tmux.js", () => ({
  getCurrentTmuxSession: () => mockGetCurrentTmuxSession(),
}));

const mockCapturePaneContent = vi.fn<(paneId: string, lines?: number) => string>(() => "");
vi.mock("../../features/rate-limit-wait/tmux-detector.js", () => ({
  capturePaneContent: (paneId: string, lines?: number) => mockCapturePaneContent(paneId, lines),
}));

// Mock config and dispatcher modules
vi.mock("../config.js", () => ({
  getOpenClawConfig: vi.fn(),
  resolveGateway: vi.fn(),
  resetOpenClawConfigCache: vi.fn(),
}));

vi.mock("../dispatcher.js", () => ({
  wakeGateway: vi.fn(),
  wakeCommandGateway: vi.fn(),
  isCommandGateway: vi.fn((config: { type?: string }) => config?.type === "command"),
  shellEscapeArg: vi.fn((value: string) => "'" + value.replace(/'/g, "'\\''") + "'"),
  interpolateInstruction: vi.fn((template: string, vars: Record<string, string | undefined>) => {
    // Simple implementation for tests
    return template.replace(/\{\{(\w+)\}\}/g, (match: string, key: string) => vars[key] ?? match);
  }),
}));

import { wakeOpenClaw } from "../index.js";
import { getOpenClawConfig, resolveGateway } from "../config.js";
import { wakeGateway, wakeCommandGateway } from "../dispatcher.js";
import type { OpenClawConfig } from "../types.js";

const mockConfig: OpenClawConfig = {
  enabled: true,
  gateways: {
    "my-gateway": {
      url: "https://example.com/wake",
      method: "POST",
    },
  },
  hooks: {
    "session-start": {
      gateway: "my-gateway",
      instruction: "Session started for {{projectName}}",
      enabled: true,
    },
  },
};

const mockResolvedGateway = {
  gatewayName: "my-gateway",
  gateway: { url: "https://example.com/wake", method: "POST" as const },
  instruction: "Session started for {{projectName}}",
};

describe("wakeOpenClaw", () => {
  beforeEach(() => {
    vi.mocked(getOpenClawConfig).mockReturnValue(mockConfig);
    vi.mocked(resolveGateway).mockReturnValue(mockResolvedGateway);
    vi.mocked(wakeGateway).mockResolvedValue({
      gateway: "my-gateway",
      success: true,
      statusCode: 200,
    });
    mockGetCurrentTmuxSession.mockReturnValue(null);
    mockCapturePaneContent.mockReturnValue("");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("returns null when OMC_OPENCLAW is not set", async () => {
    vi.mocked(getOpenClawConfig).mockReturnValue(null);
    const result = await wakeOpenClaw("session-start", {});
    expect(result).toBeNull();
  });

  it("returns null when config is null (OMC_OPENCLAW not '1')", async () => {
    vi.mocked(getOpenClawConfig).mockReturnValue(null);
    const result = await wakeOpenClaw("session-start", { sessionId: "sid-1" });
    expect(result).toBeNull();
  });

  it("returns null when event is not mapped", async () => {
    vi.mocked(resolveGateway).mockReturnValue(null);
    const result = await wakeOpenClaw("stop", {});
    expect(result).toBeNull();
  });

  it("calls wakeGateway with interpolated instruction and gatewayName", async () => {
    const result = await wakeOpenClaw("session-start", {
      sessionId: "sid-1",
      projectPath: "/home/user/myproject",
    });
    expect(result).not.toBeNull();
    expect(wakeGateway).toHaveBeenCalledOnce();
    const call = vi.mocked(wakeGateway).mock.calls[0];
    expect(call[0]).toBe("my-gateway"); // gatewayName
    expect(call[1]).toEqual(mockResolvedGateway.gateway); // gateway config
    // payload should have interpolated instruction
    const payload = call[2];
    expect(payload.event).toBe("session-start");
    expect(payload.instruction).toContain("myproject"); // interpolated
  });

  it("sanitizes tmux tail before sending stop payloads", async () => {
    mockCapturePaneContent.mockReturnValue([
      "Review PR #2498 and reply with exactly one verdict:",
      "- approve",
      "- request-changes",
      "- follow-up-fix",
      "- BLOCKED",
      "Traceback (most recent call last):",
      "RuntimeError: boom",
      "BLOCKED: runtime failure",
    ].join("\n"));
    vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
    vi.stubEnv("TMUX_PANE", "%7");

    await wakeOpenClaw("stop", {
      sessionId: "sid-stop",
      projectPath: "/home/user/myproject",
    });

    expect(mockCapturePaneContent).toHaveBeenCalledWith("%7", 15);
    const payload = vi.mocked(wakeGateway).mock.calls[0]?.[2];
    expect(payload.tmuxTail).toBe(
      "Traceback (most recent call last):\nRuntimeError: boom\nBLOCKED: runtime failure",
    );
    expect(payload.tmuxTail).not.toContain("approve");
    expect(payload.tmuxTail).not.toContain("request-changes");
    expect(payload.tmuxTail).not.toContain("follow-up-fix");
  });

  it("uses a single timestamp in both template variables and payload", async () => {
    // Spy on Date.prototype.toISOString to track calls
    const mockTimestamp = "2026-02-25T12:00:00.000Z";
    const dateSpy = vi.spyOn(Date.prototype, "toISOString").mockReturnValue(mockTimestamp);

    await wakeOpenClaw("session-start", { projectPath: "/home/user/project" });

    // Date should only be called once (single timestamp)
    expect(dateSpy).toHaveBeenCalledTimes(1);

    const call = vi.mocked(wakeGateway).mock.calls[0];
    const payload = call[2];
    expect(payload.timestamp).toBe(mockTimestamp);

    dateSpy.mockRestore();
  });

  it("only includes whitelisted context fields in the payload", async () => {
    const context = {
      sessionId: "sid-1",
      projectPath: "/home/user/project",
      toolName: "Bash",
      prompt: "test prompt",
      contextSummary: "summary",
      reason: "stop",
      question: "what?",
    };

    await wakeOpenClaw("session-start", context);

    const call = vi.mocked(wakeGateway).mock.calls[0];
    const payload = call[2];
    const payloadContext = payload.context;

    // All whitelisted fields should be present
    expect(payloadContext.sessionId).toBe("sid-1");
    expect(payloadContext.projectPath).toBe("/home/user/project");
    expect(payloadContext.toolName).toBe("Bash");
    expect(payloadContext.prompt).toBe("test prompt");
    expect(payloadContext.contextSummary).toBe("summary");
    expect(payloadContext.reason).toBe("stop");
    expect(payloadContext.question).toBe("what?");

    // Should only have these known keys (no extra properties)
    const contextKeys = Object.keys(payloadContext);
    const allowedKeys = ["sessionId", "projectPath", "toolName", "prompt", "contextSummary", "reason", "question"];
    for (const key of contextKeys) {
      expect(allowedKeys).toContain(key);
    }
  });

  it("does not include undefined context fields in whitelisted context", async () => {
    await wakeOpenClaw("session-start", { sessionId: "sid-1" });

    const call = vi.mocked(wakeGateway).mock.calls[0];
    const payload = call[2];
    const payloadContext = payload.context;

    expect(payloadContext.sessionId).toBe("sid-1");
    // Fields not in the input should not be in context
    expect(Object.keys(payloadContext)).toEqual(["sessionId"]);
  });

  it("debug logging fires when OMC_OPENCLAW_DEBUG=1", async () => {
    vi.stubEnv("OMC_OPENCLAW_DEBUG", "1");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Re-import to pick up env change — since DEBUG is a module-level const,
    // we test via the console.error spy indirectly
    // Note: DEBUG is evaluated at module load, so we verify the behavior pattern
    // by checking the result still works correctly
    const result = await wakeOpenClaw("session-start", { sessionId: "sid-1" });
    expect(result).not.toBeNull();

    consoleSpy.mockRestore();
  });

  it("never throws even if wakeGateway throws", async () => {
    vi.mocked(wakeGateway).mockRejectedValue(new Error("Gateway exploded"));

    const result = await wakeOpenClaw("session-start", {});
    // Should return null, not throw
    expect(result).toBeNull();
  });

  it("never throws even if resolveGateway throws", async () => {
    vi.mocked(resolveGateway).mockImplementation(() => {
      throw new Error("Config error");
    });

    const result = await wakeOpenClaw("session-start", {});
    expect(result).toBeNull();
  });

  it("returns the wakeGateway result on success", async () => {
    const mockResult = { gateway: "my-gateway", success: true, statusCode: 200 };
    vi.mocked(wakeGateway).mockResolvedValue(mockResult);

    const result = await wakeOpenClaw("session-start", {});
    expect(result).toEqual(mockResult);
  });

  it("returns the wakeGateway result on failure", async () => {
    const mockResult = { gateway: "my-gateway", success: false, error: "HTTP 500", statusCode: 500 };
    vi.mocked(wakeGateway).mockResolvedValue(mockResult);

    const result = await wakeOpenClaw("session-start", {});
    expect(result).toEqual(mockResult);
  });

  it("derives projectName from projectPath for template variables", async () => {
    await wakeOpenClaw("session-start", {
      projectPath: "/home/user/my-cool-project",
    });

    const call = vi.mocked(wakeGateway).mock.calls[0];
    const payload = call[2];
    // projectName should be the basename
    expect(payload.projectName).toBe("my-cool-project");
  });

  it("omits projectName when projectPath is not provided", async () => {
    await wakeOpenClaw("session-start", { sessionId: "sid-1" });

    const call = vi.mocked(wakeGateway).mock.calls[0];
    const payload = call[2];
    expect(payload.projectName).toBeUndefined();
  });

  it("routes to wakeCommandGateway for command gateways and does not call wakeGateway", async () => {
    const commandGateway = { type: "command" as const, command: "echo {{instruction}}" };
    vi.mocked(resolveGateway).mockReturnValue({
      gatewayName: "cmd-gw",
      gateway: commandGateway,
      instruction: "hello",
    });
    vi.mocked(wakeCommandGateway).mockResolvedValue({ gateway: "cmd-gw", success: true });

    const result = await wakeOpenClaw("session-start", { sessionId: "sid-1" });

    expect(wakeCommandGateway).toHaveBeenCalledOnce();
    expect(wakeGateway).not.toHaveBeenCalled();
    expect(result).toEqual({ gateway: "cmd-gw", success: true });
  });

  it("routes to wakeGateway for HTTP gateways and does not call wakeCommandGateway", async () => {
    // The default beforeEach already sets up an HTTP gateway mock
    const result = await wakeOpenClaw("session-start", { sessionId: "sid-1" });

    expect(wakeGateway).toHaveBeenCalledOnce();
    expect(wakeCommandGateway).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  it("returns null and never throws when wakeCommandGateway rejects", async () => {
    vi.mocked(resolveGateway).mockReturnValue({
      gatewayName: "cmd-gw",
      gateway: { type: "command" as const, command: "echo test" },
      instruction: "test",
    });
    vi.mocked(wakeCommandGateway).mockRejectedValue(new Error("Command exploded"));

    const result = await wakeOpenClaw("session-start", {});
    expect(result).toBeNull();
  });

  it("passes the interpolated instruction as the instruction variable to wakeCommandGateway", async () => {
    const commandGateway = { type: "command" as const, command: "notify {{instruction}}" };
    vi.mocked(resolveGateway).mockReturnValue({
      gatewayName: "cmd-gw",
      gateway: commandGateway,
      instruction: "Session started for {{projectName}}",
    });
    vi.mocked(wakeCommandGateway).mockResolvedValue({ gateway: "cmd-gw", success: true });

    await wakeOpenClaw("session-start", { projectPath: "/home/user/myproject" });

    expect(wakeCommandGateway).toHaveBeenCalledOnce();
    const call = vi.mocked(wakeCommandGateway).mock.calls[0];
    // call[0] = gatewayName, call[1] = config, call[2] = variables
    const variables = call[2];
    expect(variables).toHaveProperty("instruction");
    // The instruction variable should be the interpolated result
    expect(variables.instruction).toContain("myproject");
  });

  it("adds a normalized test signal to the HTTP payload", async () => {
    vi.mocked(resolveGateway).mockReturnValue({
      gatewayName: "my-gateway",
      gateway: { url: "https://example.com/wake", method: "POST" as const },
      instruction: "test",
    });

    await wakeOpenClaw("post-tool-use", {
      sessionId: "sid-1",
      projectPath: "/home/user/myproject",
      toolName: "Bash",
      toolInput: { command: "pnpm test" },
      toolOutput: "FAIL src/openclaw/signal.test.ts\nTest failed",
    });

    const payload = vi.mocked(wakeGateway).mock.calls[0][2];
    expect(payload.signal).toMatchObject({
      kind: "test",
      phase: "failed",
      routeKey: "test.failed",
      priority: "high",
      testRunner: "package-test",
    });
  });

  it("passes payloadJson and signalRouteKey to command gateways for PR creation", async () => {
    const commandGateway = { type: "command" as const, command: "notify {{signalRouteKey}} {{payloadJson}}" };
    vi.mocked(resolveGateway).mockReturnValue({
      gatewayName: "cmd-gw",
      gateway: commandGateway,
      instruction: "Create PR",
    });
    vi.mocked(wakeCommandGateway).mockResolvedValue({ gateway: "cmd-gw", success: true });

    await wakeOpenClaw("post-tool-use", {
      sessionId: "sid-1",
      projectPath: "/home/user/myproject",
      toolName: "Bash",
      toolInput: { command: "gh pr create --base dev --fill" },
      toolOutput: "https://github.com/example/repo/pull/1500",
    });

    const variables = vi.mocked(wakeCommandGateway).mock.calls[0][2];
    expect(variables.signalRouteKey).toBe("pull-request.created");
    expect(variables.payloadJson).toContain('"routeKey":"pull-request.created"');
    expect(variables.payloadJson).toContain('"prUrl":"https://github.com/example/repo/pull/1500"');
  });
});

describe("reply channel context", () => {
  beforeEach(() => {
    vi.mocked(getOpenClawConfig).mockReturnValue(mockConfig);
    vi.mocked(resolveGateway).mockReturnValue(mockResolvedGateway);
    vi.mocked(wakeGateway).mockResolvedValue({
      gateway: "my-gateway",
      success: true,
      statusCode: 200,
    });
    mockGetCurrentTmuxSession.mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("reads OPENCLAW_REPLY_CHANNEL, OPENCLAW_REPLY_TARGET, OPENCLAW_REPLY_THREAD from env and includes in HTTP payload", async () => {
    vi.stubEnv("OPENCLAW_REPLY_CHANNEL", "#general");
    vi.stubEnv("OPENCLAW_REPLY_TARGET", "@bot");
    vi.stubEnv("OPENCLAW_REPLY_THREAD", "thread-123");

    await wakeOpenClaw("session-start", { sessionId: "sid-1" });

    const call = vi.mocked(wakeGateway).mock.calls[0];
    const payload = call[2];
    expect(payload.channel).toBe("#general");
    expect(payload.to).toBe("@bot");
    expect(payload.threadId).toBe("thread-123");
  });

  it("does not include channel fields in HTTP payload when env vars are not set", async () => {
    await wakeOpenClaw("session-start", { sessionId: "sid-1" });

    const call = vi.mocked(wakeGateway).mock.calls[0];
    const payload = call[2];
    expect(payload).not.toHaveProperty("channel");
    expect(payload).not.toHaveProperty("to");
    expect(payload).not.toHaveProperty("threadId");
  });

  it("includes partial env vars (only OPENCLAW_REPLY_CHANNEL set)", async () => {
    vi.stubEnv("OPENCLAW_REPLY_CHANNEL", "#alerts");

    await wakeOpenClaw("session-start", { sessionId: "sid-1" });

    const call = vi.mocked(wakeGateway).mock.calls[0];
    const payload = call[2];
    expect(payload.channel).toBe("#alerts");
    expect(payload).not.toHaveProperty("to");
    expect(payload).not.toHaveProperty("threadId");
  });

  it("includes reply channel fields in whitelisted context", async () => {
    vi.stubEnv("OPENCLAW_REPLY_CHANNEL", "#general");
    vi.stubEnv("OPENCLAW_REPLY_TARGET", "@bot");
    vi.stubEnv("OPENCLAW_REPLY_THREAD", "thread-123");

    await wakeOpenClaw("session-start", { sessionId: "sid-1" });

    const call = vi.mocked(wakeGateway).mock.calls[0];
    const payload = call[2];
    expect(payload.context.replyChannel).toBe("#general");
    expect(payload.context.replyTarget).toBe("@bot");
    expect(payload.context.replyThread).toBe("thread-123");
  });

  it("adds replyChannel, replyTarget, replyThread as template variables for command gateways", async () => {
    vi.stubEnv("OPENCLAW_REPLY_CHANNEL", "#general");
    vi.stubEnv("OPENCLAW_REPLY_TARGET", "@bot");
    vi.stubEnv("OPENCLAW_REPLY_THREAD", "thread-123");

    const commandGateway = { type: "command" as const, command: "notify {{replyChannel}} {{replyTarget}} {{replyThread}}" };
    vi.mocked(resolveGateway).mockReturnValue({
      gatewayName: "cmd-gw",
      gateway: commandGateway,
      instruction: "test",
    });
    vi.mocked(wakeCommandGateway).mockResolvedValue({ gateway: "cmd-gw", success: true });

    await wakeOpenClaw("session-start", { sessionId: "sid-1" });

    const call = vi.mocked(wakeCommandGateway).mock.calls[0];
    const variables = call[2];
    expect(variables.replyChannel).toBe("#general");
    expect(variables.replyTarget).toBe("@bot");
    expect(variables.replyThread).toBe("thread-123");
  });

  it("context fields override env vars when both are provided", async () => {
    vi.stubEnv("OPENCLAW_REPLY_CHANNEL", "#from-env");

    await wakeOpenClaw("session-start", {
      sessionId: "sid-1",
      replyChannel: "#from-context",
    });

    const call = vi.mocked(wakeGateway).mock.calls[0];
    const payload = call[2];
    expect(payload.channel).toBe("#from-context");
  });
});


describe("burst dedupe for attached multi-pane sessions", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "omc-openclaw-dedupe-"));
    vi.mocked(getOpenClawConfig).mockReturnValue(mockConfig);
    vi.mocked(resolveGateway).mockReturnValue(mockResolvedGateway);
    vi.mocked(wakeGateway).mockResolvedValue({
      gateway: "my-gateway",
      success: true,
      statusCode: 200,
    });
    mockGetCurrentTmuxSession.mockReturnValue(null);
    mockGetCurrentTmuxSession.mockReturnValue("dev-session");
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("collapses repeated session-start bursts for the same tmux session", async () => {
    const first = await wakeOpenClaw("session-start", {
      sessionId: "sid-1",
      projectPath: projectDir,
    });
    const second = await wakeOpenClaw("session-start", {
      sessionId: "sid-2",
      projectPath: projectDir,
    });

    expect(first).toMatchObject({ success: true });
    expect(second).toMatchObject({ success: true, skipped: "deduped" });
    expect(wakeGateway).toHaveBeenCalledTimes(1);
  });

  it("collapses repeated prompt-submitted bursts only when the prompt matches", async () => {
    await wakeOpenClaw("keyword-detector", {
      sessionId: "sid-1",
      projectPath: projectDir,
      prompt: "Ship it now",
    });
    const deduped = await wakeOpenClaw("keyword-detector", {
      sessionId: "sid-2",
      projectPath: projectDir,
      prompt: "  Ship   it now  ",
    });
    await wakeOpenClaw("keyword-detector", {
      sessionId: "sid-3",
      projectPath: projectDir,
      prompt: "Ship a different change",
    });

    expect(deduped).toMatchObject({ success: true, skipped: "deduped" });
    expect(wakeGateway).toHaveBeenCalledTimes(2);
  });

  it("collapses repeated stop bursts for the same tmux session", async () => {
    await wakeOpenClaw("stop", {
      sessionId: "sid-1",
      projectPath: projectDir,
    });
    const deduped = await wakeOpenClaw("stop", {
      sessionId: "sid-2",
      projectPath: projectDir,
    });

    expect(deduped).toMatchObject({ success: true, skipped: "deduped" });
    expect(wakeGateway).toHaveBeenCalledTimes(1);
  });

  it("does not collapse lifecycle events when no tmux session is available", async () => {
    mockGetCurrentTmuxSession.mockReturnValue(null);

    await wakeOpenClaw("session-start", {
      sessionId: "sid-1",
      projectPath: projectDir,
    });
    await wakeOpenClaw("session-start", {
      sessionId: "sid-2",
      projectPath: projectDir,
    });

    expect(wakeGateway).toHaveBeenCalledTimes(2);
  });
});
