import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { interpolateInstruction, wakeGateway } from "../dispatcher.js";
import type { OpenClawGatewayConfig, OpenClawPayload } from "../types.js";

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
