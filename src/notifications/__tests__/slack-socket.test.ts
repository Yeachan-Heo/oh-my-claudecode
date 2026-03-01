import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlackSocketClient } from "../slack-socket.js";

describe("SlackSocketClient", () => {
  const config = {
    appToken: "xapp-test-token",
    botToken: "xoxb-test-token",
    channelId: "C123456",
  };
  const mockHandler = vi.fn();
  const mockLog = vi.fn();

  let mockWsInstance: {
    readyState: number;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
  let originalWebSocket: typeof globalThis.WebSocket;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();

    // Mock WebSocket instance
    mockWsInstance = {
      readyState: 1, // OPEN
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
      send: vi.fn(),
    };

    originalWebSocket = globalThis.WebSocket;
    // Must use regular function (not arrow) so `new WebSocket()` returns mockWsInstance
    (globalThis as unknown as Record<string, unknown>).WebSocket = Object.assign(
      vi.fn(function () { return mockWsInstance; }),
      { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 },
    );

    // Mock fetch
    originalFetch = globalThis.fetch;
    (globalThis as unknown as Record<string, unknown>).fetch = vi.fn();

    mockHandler.mockReset();
    mockLog.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as unknown as Record<string, unknown>).WebSocket = originalWebSocket;
    (globalThis as unknown as Record<string, unknown>).fetch = originalFetch;
  });

  function mockFetchSuccess(url = "wss://test.slack.com/link") {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      json: () => Promise.resolve({ ok: true, url }),
    } as Response);
  }

  function mockFetchFailure(error = "invalid_auth") {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error }),
    } as Response);
  }

  describe("start()", () => {
    it("connects and creates WebSocket on success", async () => {
      mockFetchSuccess();
      const client = new SlackSocketClient(config, mockHandler, mockLog);
      await client.start();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://slack.com/api/apps.connections.open",
        expect.objectContaining({ method: "POST" }),
      );
      expect(globalThis.WebSocket).toHaveBeenCalledWith("wss://test.slack.com/link");
    });

    it("registers all four event listeners on WebSocket", async () => {
      mockFetchSuccess();
      const client = new SlackSocketClient(config, mockHandler, mockLog);
      await client.start();

      expect(mockWsInstance.addEventListener).toHaveBeenCalledTimes(4);
      const events = mockWsInstance.addEventListener.mock.calls.map(
        (call: unknown[]) => call[0],
      );
      expect(events.sort()).toEqual(["close", "error", "message", "open"]);
    });
  });

  describe("stop()", () => {
    it("removes all four WebSocket event listeners", async () => {
      mockFetchSuccess();
      const client = new SlackSocketClient(config, mockHandler, mockLog);
      await client.start();

      client.stop();

      expect(mockWsInstance.removeEventListener).toHaveBeenCalledTimes(4);
      const events = mockWsInstance.removeEventListener.mock.calls.map(
        (call: unknown[]) => call[0],
      );
      expect(events.sort()).toEqual(["close", "error", "message", "open"]);
    });

    it("removed handlers match the added handlers", async () => {
      mockFetchSuccess();
      const client = new SlackSocketClient(config, mockHandler, mockLog);
      await client.start();

      const added = mockWsInstance.addEventListener.mock.calls.map(
        (call: unknown[]) => ({ event: call[0], handler: call[1] }),
      );

      client.stop();

      const removed = mockWsInstance.removeEventListener.mock.calls.map(
        (call: unknown[]) => ({ event: call[0], handler: call[1] }),
      );

      for (const r of removed) {
        const match = added.find(
          (a: { event: unknown; handler: unknown }) => a.event === r.event,
        );
        expect(match).toBeDefined();
        expect(r.handler).toBe(match!.handler);
      }
    });

    it("closes the WebSocket", async () => {
      mockFetchSuccess();
      const client = new SlackSocketClient(config, mockHandler, mockLog);
      await client.start();

      client.stop();

      expect(mockWsInstance.close).toHaveBeenCalled();
    });

    it("clears pending reconnect timer", async () => {
      mockFetchFailure();
      const client = new SlackSocketClient(config, mockHandler, mockLog);

      // start() will fail, triggering scheduleReconnect
      await client.start();
      const fetchCallCount = vi.mocked(globalThis.fetch).mock.calls.length;

      client.stop();

      // Advance past any reconnect delay — fetch should NOT be called again
      await vi.advanceTimersByTimeAsync(120_000);
      expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(fetchCallCount);
    });

    it("is safe to call before start()", () => {
      const client = new SlackSocketClient(config, mockHandler, mockLog);
      expect(() => client.stop()).not.toThrow();
    });

    it("is idempotent (multiple calls are safe)", async () => {
      mockFetchSuccess();
      const client = new SlackSocketClient(config, mockHandler, mockLog);
      await client.start();

      expect(() => {
        client.stop();
        client.stop();
        client.stop();
      }).not.toThrow();
    });
  });

  describe("connect() shutdown guards", () => {
    it("uses AbortSignal.timeout on fetch for timeout protection", async () => {
      mockFetchSuccess();
      const client = new SlackSocketClient(config, mockHandler, mockLog);
      await client.start();

      // Verify the fetch was called with an AbortSignal (timeout-based)
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const fetchOpts = fetchCall[1] as RequestInit;
      expect(fetchOpts.signal).toBeInstanceOf(AbortSignal);
      client.stop();
    });

    it("isShuttingDown prevents reconnect after stop", async () => {
      mockFetchFailure();
      const client = new SlackSocketClient(config, mockHandler, mockLog);

      // start() will fail (API returns error), triggering scheduleReconnect
      await client.start();
      const fetchCallCount = vi.mocked(globalThis.fetch).mock.calls.length;

      // stop() sets isShuttingDown and clears reconnect timer
      client.stop();

      // Advance past any reconnect delay — fetch should NOT be called again
      await vi.advanceTimersByTimeAsync(120_000);
      expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(fetchCallCount);
    });
  });

  describe("handleEnvelope()", () => {
    async function getMessageHandler() {
      mockFetchSuccess();
      const client = new SlackSocketClient(config, mockHandler, mockLog);
      await client.start();
      const messageCall = mockWsInstance.addEventListener.mock.calls.find(
        (call: unknown[]) => call[0] === "message",
      );
      const handler = messageCall![1] as (event: { data?: unknown }) => void;

      // Authenticate via hello envelope so messages can be dispatched
      handler({
        data: JSON.stringify({ envelope_id: "env_hello", type: "hello" }),
      });
      await vi.advanceTimersByTimeAsync(0);

      return { client, handler };
    }

    it("acknowledges envelopes with envelope_id", async () => {
      const { handler } = await getMessageHandler();

      handler({
        data: JSON.stringify({
          envelope_id: "test-envelope-123",
          type: "events_api",
          payload: {
            event: {
              type: "message",
              channel: "C123456",
              user: "U123",
              text: "hello",
              ts: "1234567890.123456",
            },
          },
        }),
      });

      expect(mockWsInstance.send).toHaveBeenCalledWith(
        JSON.stringify({ envelope_id: "test-envelope-123" }),
      );
    });

    it("dispatches message events matching channel to handler", async () => {
      const { handler } = await getMessageHandler();

      handler({
        data: JSON.stringify({
          envelope_id: "env-1",
          type: "events_api",
          payload: {
            event: {
              type: "message",
              channel: "C123456",
              user: "U123",
              text: "test message",
              ts: "1234567890.123",
            },
          },
        }),
      });

      // Wait for the fire-and-forget promise
      await vi.advanceTimersByTimeAsync(0);

      expect(mockHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "message",
          channel: "C123456",
          text: "test message",
        }),
      );
    });

    it("filters messages from other channels", async () => {
      const { handler } = await getMessageHandler();

      handler({
        data: JSON.stringify({
          envelope_id: "env-2",
          type: "events_api",
          payload: {
            event: {
              type: "message",
              channel: "C999999",
              user: "U123",
              text: "wrong channel",
              ts: "1234567890.999",
            },
          },
        }),
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it("filters messages with subtypes (edits, joins, etc.)", async () => {
      const { handler } = await getMessageHandler();

      handler({
        data: JSON.stringify({
          envelope_id: "env-3",
          type: "events_api",
          payload: {
            event: {
              type: "message",
              subtype: "message_changed",
              channel: "C123456",
              user: "U123",
              text: "edited",
              ts: "1234567890.444",
            },
          },
        }),
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it("handles disconnect envelope by closing WebSocket", async () => {
      const { handler } = await getMessageHandler();

      handler({
        data: JSON.stringify({
          envelope_id: "env_disc",
          type: "disconnect",
          reason: "link_disabled",
        }),
      });

      expect(mockWsInstance.close).toHaveBeenCalled();
    });

    it("logs handler errors without crashing", async () => {
      mockHandler.mockRejectedValue(new Error("handler boom"));
      const { handler } = await getMessageHandler();

      handler({
        data: JSON.stringify({
          envelope_id: "env-err",
          type: "events_api",
          payload: {
            event: {
              type: "message",
              channel: "C123456",
              user: "U123",
              text: "causes error",
              ts: "1234567890.err",
            },
          },
        }),
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining("handler error"),
      );
    });
  });

  describe("source code invariants", () => {
    it("has shutdown guard and cleanup mechanisms", () => {
      const fs = require("fs");
      const path = require("path");
      const source = fs.readFileSync(
        path.join(__dirname, "..", "slack-socket.ts"),
        "utf-8",
      ) as string;

      // Shutdown flag checked in connect and scheduleReconnect
      expect(source).toContain("isShuttingDown");
      // Cleanup method removes listeners before closing
      expect(source).toContain("cleanupWs");
      // API timeout protection on fetch
      expect(source).toContain("AbortSignal.timeout");
      // Connection state tracking
      expect(source).toContain("connectionState");
    });
  });
});
