/**
 * Tests for Slack Socket Mode client (issues #1138, #1139)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackSocketClient, type SlackSocketConfig } from '../notifications/slack-socket.js';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket {
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;
  private listeners: Record<string, ((...args: any[]) => void)[]> = {};

  addEventListener(event: string, handler: (...args: any[]) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }

  removeEventListener(event: string, handler: (...args: any[]) => void) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter(h => h !== handler);
  }

  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3; // CLOSED
    this.fire('close');
  });

  // test helpers
  fire(event: string, data?: any) {
    (this.listeners[event] ?? []).forEach(h => h(data));
  }

  listenerCount(event: string): number {
    return (this.listeners[event] ?? []).length;
  }
}

let lastWs: MockWebSocket | null = null;

// ---------------------------------------------------------------------------
// Mock fetch + WebSocket global
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
(globalThis as any).fetch = mockFetch;

const OrigWS = (globalThis as any).WebSocket;

beforeEach(() => {
  lastWs = null;
  (globalThis as any).WebSocket = class extends MockWebSocket {
    constructor(_url: string) {
      super();
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- capturing instance for test assertions
      lastWs = this;
      // auto-fire open on next tick
      queueMicrotask(() => this.fire('open'));
    }
  };
  (globalThis as any).WebSocket.OPEN = MockWebSocket.OPEN;

  mockFetch.mockResolvedValue({
    json: () => Promise.resolve({ ok: true, url: 'wss://fake.slack.test' }),
  });
});

afterEach(() => {
  if (OrigWS) (globalThis as any).WebSocket = OrigWS;
  else delete (globalThis as any).WebSocket;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONFIG: SlackSocketConfig = {
  appToken: 'xapp-test',
  botToken: 'xoxb-test',
  channelId: 'C123',
};

function envelope(overrides: Record<string, any> = {}) {
  return JSON.stringify({
    envelope_id: 'env_1',
    type: 'events_api',
    payload: {
      event: {
        type: 'message',
        channel: 'C123',
        user: 'U1',
        text: 'hello',
        ts: '1234.5678',
      },
    },
    ...overrides,
  });
}

function helloEnvelope() {
  return JSON.stringify({ envelope_id: 'env_hello', type: 'hello' });
}

/** Send a hello envelope to authenticate the connection */
async function authenticate(ws: MockWebSocket) {
  ws.fire('message', { data: helloEnvelope() });
  await new Promise(r => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SlackSocketClient', () => {
  it('connects via apps.connections.open and creates WebSocket', async () => {
    const onMessage = vi.fn();
    const client = new SlackSocketClient(CONFIG, onMessage, vi.fn());
    await client.start();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/apps.connections.open',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(lastWs).not.toBeNull();
    client.stop();
  });

  it('acknowledges envelopes with envelope_id', async () => {
    const onMessage = vi.fn();
    const client = new SlackSocketClient(CONFIG, onMessage, vi.fn());
    await client.start();
    await authenticate(lastWs!);

    // simulate envelope
    lastWs!.fire('message', { data: envelope() });
    expect(lastWs!.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: 'env_1' }));
    client.stop();
  });

  it('dispatches matching message events to handler', async () => {
    const onMessage = vi.fn();
    const client = new SlackSocketClient(CONFIG, onMessage, vi.fn());
    await client.start();
    await authenticate(lastWs!);

    lastWs!.fire('message', { data: envelope() });

    // onMessage is fire-and-forget, wait a tick
    await new Promise(r => setTimeout(r, 10));
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message', channel: 'C123', text: 'hello' }),
    );
    client.stop();
  });

  it('filters out messages from other channels', async () => {
    const onMessage = vi.fn();
    const client = new SlackSocketClient(CONFIG, onMessage, vi.fn());
    await client.start();
    await authenticate(lastWs!);

    lastWs!.fire('message', {
      data: envelope({
        payload: { event: { type: 'message', channel: 'COTHER', user: 'U1', text: 'hi', ts: '1' } },
      }),
    });

    await new Promise(r => setTimeout(r, 10));
    expect(onMessage).not.toHaveBeenCalled();
    client.stop();
  });

  it('filters out messages with subtypes', async () => {
    const onMessage = vi.fn();
    const client = new SlackSocketClient(CONFIG, onMessage, vi.fn());
    await client.start();
    await authenticate(lastWs!);

    lastWs!.fire('message', {
      data: envelope({
        payload: { event: { type: 'message', channel: 'C123', user: 'U1', text: 'hi', ts: '1', subtype: 'channel_join' } },
      }),
    });

    await new Promise(r => setTimeout(r, 10));
    expect(onMessage).not.toHaveBeenCalled();
    client.stop();
  });

  it('handles disconnect envelope by closing WS', async () => {
    const onMessage = vi.fn();
    const client = new SlackSocketClient(CONFIG, onMessage, vi.fn());
    await client.start();

    lastWs!.fire('message', {
      data: JSON.stringify({ envelope_id: 'env_disc', type: 'disconnect', reason: 'link_disabled' }),
    });

    expect(lastWs!.close).toHaveBeenCalled();
    client.stop();
  });

  it('stop() clears state and closes WS', async () => {
    const onMessage = vi.fn();
    const client = new SlackSocketClient(CONFIG, onMessage, vi.fn());
    await client.start();

    const ws = lastWs!;
    client.stop();
    expect(ws.close).toHaveBeenCalled();
  });

  it('handles malformed envelope JSON gracefully', async () => {
    const log = vi.fn();
    const client = new SlackSocketClient(CONFIG, vi.fn(), log);
    await client.start();

    lastWs!.fire('message', { data: 'not-json{{{' });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Invalid JSON'));
    client.stop();
  });

  it('handles connection failure gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const log = vi.fn();
    const client = new SlackSocketClient(CONFIG, vi.fn(), log);
    await client.start();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('connection error'));
    // The source now also schedules a reconnect on failure, which logs too
    client.stop();
  });

  // -------------------------------------------------------------------------
  // Cleanup tests (issue #1172)
  // -------------------------------------------------------------------------

  it('stop() removes all event listeners from the WebSocket', async () => {
    const client = new SlackSocketClient(CONFIG, vi.fn(), vi.fn());
    await client.start();

    const ws = lastWs! as unknown as MockWebSocket;
    expect(ws.listenerCount('open')).toBeGreaterThan(0);
    expect(ws.listenerCount('message')).toBeGreaterThan(0);
    expect(ws.listenerCount('error')).toBeGreaterThan(0);

    // Prevent close handler from firing during stop (so we can inspect listener state)
    ws.close = vi.fn();
    client.stop();

    expect(ws.listenerCount('open')).toBe(0);
    expect(ws.listenerCount('message')).toBe(0);
    expect(ws.listenerCount('close')).toBe(0);
    expect(ws.listenerCount('error')).toBe(0);
  });

  it('close event removes listeners before scheduling reconnect', async () => {
    const log = vi.fn();
    const client = new SlackSocketClient(CONFIG, vi.fn(), log);
    await client.start();

    const ws = lastWs! as unknown as MockWebSocket;
    expect(ws.listenerCount('message')).toBeGreaterThan(0);

    // Simulate server-initiated close (don't use ws.close mock which auto-fires)
    // Instead, directly fire the close event
    ws.close = vi.fn(); // prevent recursion
    ws.fire('close');

    // Listeners should have been removed by cleanupWs() inside the close handler
    expect(ws.listenerCount('open')).toBe(0);
    expect(ws.listenerCount('message')).toBe(0);
    expect(ws.listenerCount('error')).toBe(0);

    // Should have scheduled a reconnect
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reconnecting in'));
    client.stop();
  });

  it('scheduleReconnect clears existing timer before setting a new one', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const client = new SlackSocketClient(CONFIG, vi.fn(), vi.fn());
    await client.start();

    const ws = lastWs! as unknown as MockWebSocket;

    // Trigger a close event to schedule a reconnect timer
    ws.close = vi.fn();
    ws.fire('close');

    // A reconnect timer is now pending. stop() should clear it.
    clearTimeoutSpy.mockClear();
    client.stop();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('stop() is idempotent - safe to call multiple times', async () => {
    const client = new SlackSocketClient(CONFIG, vi.fn(), vi.fn());
    await client.start();

    client.stop();
    // Second call should not throw
    expect(() => client.stop()).not.toThrow();
  });
});
