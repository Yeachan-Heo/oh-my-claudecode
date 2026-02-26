import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { interpolateInstruction, wakeGateway, shellEscapeArg, isCommandGateway, wakeCommandGateway } from "../dispatcher.js";
import type { OpenClawGatewayConfig, OpenClawPayload, OpenClawCommandGatewayConfig } from "../types.js";

// Mock child_process so wakeCommandGateway's dynamic import resolves to our mock
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

const baseGatewayConfig: OpenClawGatewayConfig = {
  url: "https://example.com/wake",
  method: "POST",
};

const basePayload: OpenClawPayload = {
  event: "session-start",
  instruction: "Session started",
  timestamp: "2026-02-25T00:00:00.000Z",
  context: {},
};

describe("interpolateInstruction", () => {
  it("replaces known variables", () => {
    const result = interpolateInstruction(
      "Hello {{projectName}} at {{timestamp}}",
      { projectName: "myproject", timestamp: "2026-02-25T00:00:00.000Z" },
    );
    expect(result).toBe("Hello myproject at 2026-02-25T00:00:00.000Z");
  });

  it("leaves unknown {{vars}} as-is", () => {
    const result = interpolateInstruction(
      "Hello {{unknown}} world",
      { projectName: "myproject" },
    );
    expect(result).toBe("Hello {{unknown}} world");
  });

  it("replaces multiple occurrences of the same variable", () => {
    const result = interpolateInstruction(
      "{{event}} happened: {{event}}",
      { event: "session-start" },
    );
    expect(result).toBe("session-start happened: session-start");
  });

  it("handles undefined variable value by leaving placeholder", () => {
    const result = interpolateInstruction(
      "Tool: {{toolName}}",
      { toolName: undefined },
    );
    expect(result).toBe("Tool: {{toolName}}");
  });

  it("handles template with no variables unchanged", () => {
    const result = interpolateInstruction("No variables here", {});
    expect(result).toBe("No variables here");
  });

  it("handles empty template", () => {
    const result = interpolateInstruction("", { projectName: "test" });
    expect(result).toBe("");
  });

  it("replaces all supported context variables", () => {
    const result = interpolateInstruction(
      "{{sessionId}} {{projectPath}} {{projectName}} {{toolName}} {{prompt}} {{contextSummary}} {{reason}} {{question}} {{event}} {{timestamp}}",
      {
        sessionId: "sid-1",
        projectPath: "/home/user/project",
        projectName: "project",
        toolName: "Bash",
        prompt: "hello",
        contextSummary: "summary",
        reason: "stop",
        question: "what?",
        event: "session-start",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(result).toBe(
      "sid-1 /home/user/project project Bash hello summary stop what? session-start 2026-01-01T00:00:00.000Z",
    );
  });
});

describe("wakeGateway", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects non-HTTPS URLs for remote hosts", async () => {
    const config: OpenClawGatewayConfig = {
      url: "http://example.com/wake",
    };
    const result = await wakeGateway("test", config, basePayload);
    expect(result).toEqual({
      gateway: "test",
      success: false,
      error: "Invalid URL (HTTPS required)",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows HTTP for localhost", async () => {
    const config: OpenClawGatewayConfig = {
      url: "http://localhost:18789/hooks/openclaw",
    };
    const result = await wakeGateway("local", config, basePayload);
    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("allows HTTP for 127.0.0.1", async () => {
    const config: OpenClawGatewayConfig = {
      url: "http://127.0.0.1:18789/hooks/openclaw",
    };
    const result = await wakeGateway("local", config, basePayload);
    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects invalid/malformed URLs", async () => {
    const config: OpenClawGatewayConfig = {
      url: "not-a-url",
    };
    const result = await wakeGateway("test", config, basePayload);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid URL");
  });

  it("sends correct JSON body with Content-Type header", async () => {
    const result = await wakeGateway("my-gateway", baseGatewayConfig, basePayload);
    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe("https://example.com/wake");
    expect((call[1]!.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    const body = JSON.parse(call[1]!.body as string);
    expect(body.event).toBe("session-start");
    expect(body.instruction).toBe("Session started");
  });

  it("merges custom headers from gateway config", async () => {
    const config: OpenClawGatewayConfig = {
      url: "https://example.com/wake",
      headers: { Authorization: "Bearer mytoken", "X-Custom": "value" },
    };
    await wakeGateway("test", config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    const headers = call[1]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer mytoken");
    expect(headers["X-Custom"]).toBe("value");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("uses POST method by default", async () => {
    await wakeGateway("test", baseGatewayConfig, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[1]!.method).toBe("POST");
  });

  it("uses PUT method when configured", async () => {
    const config: OpenClawGatewayConfig = {
      url: "https://example.com/wake",
      method: "PUT",
    };
    await wakeGateway("test", config, basePayload);
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[1]!.method).toBe("PUT");
  });

  it("returns success with status code on 2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 201 }),
    );
    const result = await wakeGateway("my-gateway", baseGatewayConfig, basePayload);
    expect(result).toEqual({
      gateway: "my-gateway",
      success: true,
      statusCode: 201,
    });
  });

  it("returns failure with status code on 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );
    const result = await wakeGateway("my-gateway", baseGatewayConfig, basePayload);
    expect(result).toEqual({
      gateway: "my-gateway",
      success: false,
      error: "HTTP 404",
      statusCode: 404,
    });
  });

  it("returns failure with status code on 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    const result = await wakeGateway("my-gateway", baseGatewayConfig, basePayload);
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(result.error).toBe("HTTP 500");
  });

  it("handles network errors gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network failure")),
    );
    const result = await wakeGateway("my-gateway", baseGatewayConfig, basePayload);
    expect(result).toEqual({
      gateway: "my-gateway",
      success: false,
      error: "Network failure",
    });
  });

  it("handles timeout errors gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("The operation was aborted", "AbortError")),
    );
    const result = await wakeGateway("my-gateway", baseGatewayConfig, basePayload);
    expect(result.success).toBe(false);
    expect(result.gateway).toBe("my-gateway");
  });

  it("handles non-Error thrown values gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("string error"));
    const result = await wakeGateway("my-gateway", baseGatewayConfig, basePayload);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Unknown error");
  });

  it("uses AbortSignal.timeout for request timeout", async () => {
    const abortSignalSpy = vi.spyOn(AbortSignal, "timeout");
    await wakeGateway("test", baseGatewayConfig, basePayload);
    expect(abortSignalSpy).toHaveBeenCalledWith(10_000); // DEFAULT_TIMEOUT_MS
    abortSignalSpy.mockRestore();
  });

  it("uses custom timeout from gateway config", async () => {
    const abortSignalSpy = vi.spyOn(AbortSignal, "timeout");
    const config: OpenClawGatewayConfig = {
      url: "https://example.com/wake",
      timeout: 5000,
    };
    await wakeGateway("test", config, basePayload);
    expect(abortSignalSpy).toHaveBeenCalledWith(5000);
    abortSignalSpy.mockRestore();
  });
});

describe("shellEscapeArg", () => {
  it("wraps a simple string in single quotes", () => {
    expect(shellEscapeArg("hello")).toBe("'hello'");
  });

  it("escapes internal single quotes using the apostrophe sequence", () => {
    expect(shellEscapeArg("it's")).toBe("'it'\\''s'");
  });

  it("wraps an empty string in single quotes", () => {
    expect(shellEscapeArg("")).toBe("''");
  });

  it("safely quotes shell metacharacters so they are inert", () => {
    const dangerous = '$(rm -rf /); echo "pwned" | cat';
    const escaped = shellEscapeArg(dangerous);
    // Must start and end with single quote — entire string is wrapped
    expect(escaped.startsWith("'")).toBe(true);
    expect(escaped.endsWith("'")).toBe(true);
    // No unquoted $ or backtick must escape — the content is preserved literally
    expect(escaped).toBe("'$(rm -rf /); echo \"pwned\" | cat'");
  });

  it("wraps a string containing newlines in single quotes", () => {
    const result = shellEscapeArg("line1\nline2");
    expect(result).toBe("'line1\nline2'");
  });

  it("safely quotes backtick command substitution", () => {
    const result = shellEscapeArg("`whoami`");
    expect(result).toBe("'`whoami`'");
  });

  it("escapes multiple consecutive single quotes", () => {
    expect(shellEscapeArg("a'b'c")).toBe("'a'\\''b'\\''c'");
  });
});

describe("isCommandGateway", () => {
  it("returns true for a config with type: command", () => {
    const config: OpenClawCommandGatewayConfig = { type: "command", command: "echo test" };
    expect(isCommandGateway(config)).toBe(true);
  });

  it("returns false for an HTTP config with no type field", () => {
    const config: OpenClawGatewayConfig = { url: "https://example.com" };
    expect(isCommandGateway(config)).toBe(false);
  });

  it("returns false for a config with type: http", () => {
    const config: OpenClawGatewayConfig = { type: "http", url: "https://example.com" };
    expect(isCommandGateway(config)).toBe(false);
  });
});

describe("wakeCommandGateway", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  let execFileMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Grab the mock installed by vi.mock("child_process") and wire it up
    const cp = await import("child_process");
    execFileMock = vi.mocked(cp.execFile);
    // Default: simulate successful execution — promisify calls execFile with a callback
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "", stderr: "" });
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns success result with the gateway name on successful execution", async () => {
    const config: OpenClawCommandGatewayConfig = { type: "command", command: "echo hello" };
    const result = await wakeCommandGateway("test", config, {});
    expect(result).toEqual({ gateway: "test", success: true });
  });

  it("returns failure result with error message when execFile calls back with an error", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
        cb(new Error("Command failed: exit code 1"));
      },
    );
    const config: OpenClawCommandGatewayConfig = { type: "command", command: "false" };
    const result = await wakeCommandGateway("test", config, {});
    expect(result.gateway).toBe("test");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Command failed");
  });

  it("interpolates {{instruction}} variable with shell escaping", async () => {
    let capturedArgs: string[] = [];
    execFileMock.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        capturedArgs = args;
        cb(null, { stdout: "", stderr: "" });
      },
    );
    const config: OpenClawCommandGatewayConfig = {
      type: "command",
      command: "notify {{instruction}}",
    };
    const result = await wakeCommandGateway("test", config, { instruction: "hello world" });
    expect(result.success).toBe(true);
    // The interpolated command is passed as the -c argument to sh
    expect(capturedArgs[1]).toContain("'hello world'");
  });

  it("leaves unresolved {{variables}} as-is in the command", async () => {
    let capturedArgs: string[] = [];
    execFileMock.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        capturedArgs = args;
        cb(null, { stdout: "", stderr: "" });
      },
    );
    const config: OpenClawCommandGatewayConfig = {
      type: "command",
      command: "echo {{missing}}",
    };
    await wakeCommandGateway("test", config, {});
    expect(capturedArgs[1]).toContain("{{missing}}");
  });

  it("passes sh -c as the executable and arguments", async () => {
    let capturedCmd = "";
    let capturedArgs: string[] = [];
    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        capturedCmd = cmd;
        capturedArgs = args;
        cb(null, { stdout: "", stderr: "" });
      },
    );
    const config: OpenClawCommandGatewayConfig = { type: "command", command: "echo hello" };
    await wakeCommandGateway("gw", config, {});
    expect(capturedCmd).toBe("sh");
    expect(capturedArgs[0]).toBe("-c");
  });

  it("uses the default timeout of 10000ms when config.timeout is not specified", async () => {
    let capturedOpts: Record<string, unknown> = {};
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], opts: Record<string, unknown>, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        capturedOpts = opts;
        cb(null, { stdout: "", stderr: "" });
      },
    );
    const config: OpenClawCommandGatewayConfig = { type: "command", command: "echo hello" };
    await wakeCommandGateway("gw", config, {});
    expect(capturedOpts.timeout).toBe(10_000);
  });

  it("uses custom timeout from config when specified", async () => {
    let capturedOpts: Record<string, unknown> = {};
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], opts: Record<string, unknown>, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        capturedOpts = opts;
        cb(null, { stdout: "", stderr: "" });
      },
    );
    const config: OpenClawCommandGatewayConfig = { type: "command", command: "echo hello", timeout: 3000 };
    await wakeCommandGateway("gw", config, {});
    expect(capturedOpts.timeout).toBe(3000);
  });

  it("returns failure with Unknown error message when a non-Error value is thrown", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: string) => void) => {
        cb("some string error");
      },
    );
    const config: OpenClawCommandGatewayConfig = { type: "command", command: "echo hello" };
    const result = await wakeCommandGateway("gw", config, {});
    expect(result.success).toBe(false);
    expect(result.error).toBe("Unknown error");
  });
});
