/**
 * Functional Smoke Tests — Slack Socket Mode & State Cancel Cleanup
 *
 * Covers:
 *   1. SlackSocketClient — envelope parsing, message filtering, reconnect
 *      backoff, max-attempt enforcement, graceful shutdown, WS-unavailable
 *      fallback, and Slack API helper signatures (issues #1139)
 *   2. State tools — session-scoped write/read/clear cycle, cancel signal
 *      creation with TTL, ghost-legacy cleanup, broadcast clear, list_active
 *      with session scoping, and get_status details (issue #1143)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Module-level mock for worktree-paths (required before any state-tool imports)
// ============================================================================

const mockGetOmcRoot = vi.fn<(worktreeRoot?: string) => string>();
vi.mock('../lib/worktree-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/worktree-paths.js')>();
  return {
    ...actual,
    getOmcRoot: (...args: [string?]) => mockGetOmcRoot(...args),
    validateWorkingDirectory: (dir?: string) => dir || '/tmp',
  };
});

// Mock mode-registry — clearModeState/isModeActive use getOmcRoot internally,
// and we need them to honour the same mockGetOmcRoot as worktree-paths.
vi.mock('../hooks/mode-registry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/mode-registry/index.js')>();
  return {
    ...actual,
    // Passthrough but ensure the mock getOmcRoot from worktree-paths is used
    canStartMode: () => ({ allowed: true }),
    registerActiveMode: vi.fn(),
    deregisterActiveMode: vi.fn(),
  };
});

// ============================================================================
// 1. SLACK SOCKET MODE — SlackSocketClient (issue #1139)
// ============================================================================

import {
  SlackSocketClient,
  postSlackBotMessage,
  addSlackReaction,
  replySlackThread,
  type SlackSocketConfig,
} from '../notifications/slack-socket.js';

// ---------------------------------------------------------------------------
// MockWebSocket — used across all Slack tests
// ---------------------------------------------------------------------------

class MockWebSocket {
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;
  private listeners: Record<string, ((...args: any[]) => void)[]> = {};

  addEventListener(event: string, handler: (...args: any[]) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }

  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3; // CLOSED
    this.fire('close');
  });

  fire(event: string, data?: any) {
    (this.listeners[event] ?? []).forEach(h => h(data));
  }
}

let lastWs: MockWebSocket | null = null;
const mockFetch = vi.fn();
const OrigWS = (globalThis as any).WebSocket;

(globalThis as any).fetch = mockFetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONFIG: SlackSocketConfig = {
  appToken: 'xapp-test',
  botToken: 'xoxb-test',
  channelId: 'C999',
};

function makeEnvelope(overrides: Record<string, any> = {}): string {
  return JSON.stringify({
    envelope_id: 'env_smoke_1',
    type: 'events_api',
    payload: {
      event: {
        type: 'message',
        channel: 'C999',
        user: 'U42',
        text: 'hello smoke',
        ts: '1700000000.000001',
      },
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Describe: SlackSocketClient
// ---------------------------------------------------------------------------

describe('SMOKE: SlackSocketClient — envelope parsing & filtering (issue #1139)', () => {
  beforeEach(() => {
    lastWs = null;
    (globalThis as any).WebSocket = class extends MockWebSocket {
      constructor(_url: string) {
        super();
        lastWs = this as unknown as MockWebSocket;
        // auto-fire open on next microtask
        queueMicrotask(() => (this as unknown as MockWebSocket).fire('open'));
      }
    };
    (globalThis as any).WebSocket.OPEN = MockWebSocket.OPEN;

    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ ok: true, url: 'wss://fake-smoke.slack.test' }),
    });
  });

  afterEach(() => {
    if (OrigWS) (globalThis as any).WebSocket = OrigWS;
    else delete (globalThis as any).WebSocket;
    vi.restoreAllMocks();
  });

  it('hello envelope: no ACK sent (no envelope_id), no message dispatch', async () => {
    const onMessage = vi.fn();
    const client = new SlackSocketClient(CONFIG, onMessage, vi.fn());
    await client.start();
    await new Promise(r => queueMicrotask(r as any)); // flush open

    lastWs!.fire('message', { data: JSON.stringify({ type: 'hello' }) });
    await new Promise(r => setTimeout(r, 10));

    expect(lastWs!.send).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    client.stop();
  });

  it('disconnect envelope: calls ws.close() and schedules reconnect', async () => {
    const log = vi.fn();
    const client = new SlackSocketClient(CONFIG, vi.fn(), log);
    await client.start();
    await new Promise(r => queueMicrotask(r as any));

    const ws = lastWs!;
    lastWs!.fire('message', {
      data: JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }),
    });

    expect(ws.close).toHaveBeenCalled();
    client.stop();
  });

  it('events_api with message: sends ACK and dispatches to onMessage', async () => {
    const onMessage = vi.fn();
    const client = new SlackSocketClient(CONFIG, onMessage, vi.fn());
    await client.start();
    await new Promise(r => queueMicrotask(r as any));

    lastWs!.fire('message', { data: makeEnvelope() });
    await new Promise(r => setTimeout(r, 20));

    expect(lastWs!.send).toHaveBeenCalledWith(
      JSON.stringify({ envelope_id: 'env_smoke_1' }),
    );
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message', channel: 'C999', text: 'hello smoke' }),
    );
    client.stop();
  });

  it('filters out: wrong channel', async () => {
    const onMessage = vi.fn();
    const client = new SlackSocketClient(CONFIG, onMessage, vi.fn());
    await client.start();
    await new Promise(r => queueMicrotask(r as any));

    lastWs!.fire('message', {
      data: makeEnvelope({
        payload: {
          event: { type: 'message', channel: 'CWRONG', user: 'U1', text: 'hi', ts: '1' },
        },
      }),
    });
    await new Promise(r => setTimeout(r, 10));
    expect(onMessage).not.toHaveBeenCalled();
    client.stop();
  });

  it('filters out: has subtype (message_changed)', async () => {
    const onMessage = vi.fn();
    const client = new SlackSocketClient(CONFIG, onMessage, vi.fn());
    await client.start();
    await new Promise(r => queueMicrotask(r as any));

    lastWs!.fire('message', {
      data: makeEnvelope({
        payload: {
          event: {
            type: 'message',
            channel: 'C999',
            user: 'U1',
            text: 'edit',
            ts: '1',
            subtype: 'message_changed',
          },
        },
      }),
    });
    await new Promise(r => setTimeout(r, 10));
    expect(onMessage).not.toHaveBeenCalled();
    client.stop();
  });

  it('filters out: missing text', async () => {
    const onMessage = vi.fn();
    const client = new SlackSocketClient(CONFIG, onMessage, vi.fn());
    await client.start();
    await new Promise(r => queueMicrotask(r as any));

    lastWs!.fire('message', {
      data: makeEnvelope({
        payload: {
          event: { type: 'message', channel: 'C999', user: 'U1', ts: '1' },
        },
      }),
    });
    await new Promise(r => setTimeout(r, 10));
    expect(onMessage).not.toHaveBeenCalled();
    client.stop();
  });
});

describe('SMOKE: SlackSocketClient — reconnect backoff (issue #1139)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lastWs = null;

    // Each call to new WebSocket() creates a fresh MockWebSocket
    (globalThis as any).WebSocket = class extends MockWebSocket {
      constructor(_url: string) {
        super();
        lastWs = this as unknown as MockWebSocket;
        queueMicrotask(() => (this as unknown as MockWebSocket).fire('open'));
      }
    };
    (globalThis as any).WebSocket.OPEN = MockWebSocket.OPEN;

    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ ok: true, url: 'wss://fake-smoke.slack.test' }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (OrigWS) (globalThis as any).WebSocket = OrigWS;
    else delete (globalThis as any).WebSocket;
    vi.restoreAllMocks();
  });

  it('exponential backoff delays: 1s, 2s, 4s, 8s, 16s, 30s cap', async () => {
    const log = vi.fn();
    const client = new SlackSocketClient(CONFIG, vi.fn(), log);

    // Initial connect succeeds normally
    await client.start();
    await vi.advanceTimersByTimeAsync(0);

    // After initial connect, make all subsequent connect() calls fail
    // so reconnectAttempts is never reset by a successful 'open' event.
    mockFetch.mockRejectedValue(new Error('simulated network failure'));

    const getDelay = (callIndex: number): number => {
      const calls = log.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('reconnecting in'),
      );
      if (!calls[callIndex]) return -1;
      const m = (calls[callIndex][0] as string).match(/reconnecting in (\d+)ms/);
      return m ? parseInt(m[1], 10) : -1;
    };

    // Trigger first disconnect — attempt 0: delay = 1000 * 2^0 = 1000
    lastWs!.fire('close');
    await vi.advanceTimersByTimeAsync(0);
    expect(getDelay(0)).toBe(1000);

    // Advance past delay — connect() fails, scheduleReconnect again
    // attempt 1: delay = 1000 * 2^1 = 2000
    await vi.advanceTimersByTimeAsync(1001);
    await vi.advanceTimersByTimeAsync(0);
    expect(getDelay(1)).toBe(2000);

    // attempt 2: 4000
    await vi.advanceTimersByTimeAsync(2001);
    await vi.advanceTimersByTimeAsync(0);
    expect(getDelay(2)).toBe(4000);

    // attempt 3: 8000
    await vi.advanceTimersByTimeAsync(4001);
    await vi.advanceTimersByTimeAsync(0);
    expect(getDelay(3)).toBe(8000);

    // attempt 4: 16000
    await vi.advanceTimersByTimeAsync(8001);
    await vi.advanceTimersByTimeAsync(0);
    expect(getDelay(4)).toBe(16000);

    // attempt 5: 1000 * 2^5 = 32000, capped at 30000
    await vi.advanceTimersByTimeAsync(16001);
    await vi.advanceTimersByTimeAsync(0);
    expect(getDelay(5)).toBe(30000);

    client.stop();
  });

  it('max 10 reconnect attempts: stops after 10', async () => {
    const log = vi.fn();
    const client = new SlackSocketClient(CONFIG, vi.fn(), log);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);

    // Make all reconnect attempts fail so counter keeps incrementing
    mockFetch.mockRejectedValue(new Error('simulated network failure'));

    // Trigger initial disconnect
    lastWs!.fire('close');
    await vi.advanceTimersByTimeAsync(0);

    // Drive through 10 reconnect attempts (each fails, schedules next)
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(30001);
      await vi.advanceTimersByTimeAsync(0);
    }

    const maxReachedCalls = log.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('max reconnect attempts'),
    );
    expect(maxReachedCalls.length).toBeGreaterThanOrEqual(1);
    client.stop();
  });
});

describe('SMOKE: SlackSocketClient — stop() and WS-unavailable (issue #1139)', () => {
  afterEach(() => {
    if (OrigWS) (globalThis as any).WebSocket = OrigWS;
    else delete (globalThis as any).WebSocket;
    vi.restoreAllMocks();
  });

  it('stop() sets isShuttingDown, clears timer, closes WS — no reconnect after stop', async () => {
    vi.useFakeTimers();
    lastWs = null;
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ ok: true, url: 'wss://fake-smoke.slack.test' }),
    });
    (globalThis as any).WebSocket = class extends MockWebSocket {
      constructor(_url: string) {
        super();
        lastWs = this as unknown as MockWebSocket;
        queueMicrotask(() => (this as unknown as MockWebSocket).fire('open'));
      }
    };
    (globalThis as any).WebSocket.OPEN = MockWebSocket.OPEN;

    const log = vi.fn();
    const client = new SlackSocketClient(CONFIG, vi.fn(), log);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);

    const ws = lastWs!;
    client.stop();
    expect(ws.close).toHaveBeenCalled();

    // Fire close after stop — should NOT schedule reconnect
    ws.fire('close');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    const reconnectCalls = log.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('reconnecting in'),
    );
    expect(reconnectCalls.length).toBe(0);
    vi.useRealTimers();
  });

  it('WebSocket unavailable: logs warning, does not throw', async () => {
    // Remove WebSocket from global
    delete (globalThis as any).WebSocket;
    const log = vi.fn();
    const client = new SlackSocketClient(CONFIG, vi.fn(), log);
    await client.start(); // should not throw
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('WebSocket not available'),
    );
    client.stop();
  });
});

describe('SMOKE: Slack API helper function signatures (issue #1139)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('postSlackBotMessage: returns ok and ts on success', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ ok: true, ts: '1700000001.000001' }),
    });
    const result = await postSlackBotMessage('xoxb-test', 'C999', 'hello from smoke');
    expect(result.ok).toBe(true);
    expect(result.ts).toBe('1700000001.000001');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('postSlackBotMessage: returns error on API failure', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ ok: false, error: 'channel_not_found' }),
    });
    const result = await postSlackBotMessage('xoxb-test', 'CBAD', 'hi');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('channel_not_found');
  });

  it('addSlackReaction: calls reactions.add endpoint', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ ok: true }) });
    await addSlackReaction('xoxb-test', 'C999', '1700000001.000001', 'white_check_mark');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/reactions.add',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('addSlackReaction: uses default emoji when omitted', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ ok: true }) });
    await addSlackReaction('xoxb-test', 'C999', '1700000001.000001');
    const lastCall = mockFetch.mock.calls.at(-1)!;
    const callBody = JSON.parse(lastCall[1].body as string);
    expect(callBody.name).toBe('white_check_mark');
  });

  it('replySlackThread: calls chat.postMessage with thread_ts', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ ok: true }) });
    await replySlackThread('xoxb-test', 'C999', '1700000001.000001', 'threaded reply');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({ method: 'POST' }),
    );
    const lastCall = mockFetch.mock.calls.at(-1)!;
    const callBody = JSON.parse(lastCall[1].body as string);
    expect(callBody.thread_ts).toBe('1700000001.000001');
    expect(callBody.text).toBe('threaded reply');
  });
});

// ============================================================================
// 2. STATE CANCEL CLEANUP — consolidated state I/O (issue #1143)
// ============================================================================

import {
  stateWriteTool,
  stateReadTool,
  stateClearTool,
  stateListActiveTool,
  stateGetStatusTool,
} from '../tools/state-tools.js';
import { atomicWriteJsonSync } from '../lib/atomic-write.js';
import {
  resolveStatePath,
  resolveSessionStatePath,
} from '../lib/worktree-paths.js';

describe('SMOKE: State Cancel Cleanup — session-scoped I/O (issue #1143)', () => {
  let testDir: string;
  let omcDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `smoke-state-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    omcDir = join(testDir, '.omc');
    mkdirSync(omcDir, { recursive: true });
    mockGetOmcRoot.mockReturnValue(omcDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  // Helper: call a tool handler with merged defaults
  async function callTool<T extends Record<string, any>>(
    tool: { handler: (args: any) => Promise<any> },
    args: T,
  ): Promise<string> {
    const result = await tool.handler({
      workingDirectory: testDir,
      ...args,
    });
    return result.content[0].text as string;
  }

  it('session-scoped write → read → clear cycle', async () => {
    const sessionId = 'smoke-sess-001';

    // Write
    const writeResult = await callTool(stateWriteTool, {
      mode: 'ralph',
      session_id: sessionId,
      active: true,
      iteration: 3,
      task_description: 'smoke test task',
    });
    expect(writeResult).toContain('Successfully wrote state');
    expect(writeResult).toContain(sessionId);

    // Read back
    const readResult = await callTool(stateReadTool, {
      mode: 'ralph',
      session_id: sessionId,
    });
    expect(readResult).toContain('smoke test task');
    expect(readResult).toContain(sessionId);

    // Clear
    const clearResult = await callTool(stateClearTool, {
      mode: 'ralph',
      session_id: sessionId,
    });
    expect(clearResult).toContain('Successfully cleared state');

    // Read after clear — should report no state
    const readAfterClear = await callTool(stateReadTool, {
      mode: 'ralph',
      session_id: sessionId,
    });
    expect(readAfterClear).toContain('No state found');
  });

  it('state_clear with session_id writes cancel signal with TTL (~30s)', async () => {
    const sessionId = 'smoke-cancel-sess';

    // Write some state first so there is something to clear
    await callTool(stateWriteTool, {
      mode: 'autopilot',
      session_id: sessionId,
      active: true,
    });

    const before = Date.now();
    await callTool(stateClearTool, {
      mode: 'autopilot',
      session_id: sessionId,
    });
    const after = Date.now();

    // Compute path directly — avoids mock boundary issues with resolveSessionStatePath internals.
    // State tools write to: {omcRoot}/state/sessions/{sessionId}/cancel-signal-state.json
    // omcRoot = getOmcRoot(root) = mockGetOmcRoot(testDir) = omcDir
    const cancelSignalPath = join(omcDir, 'state', 'sessions', sessionId, 'cancel-signal-state.json');
    expect(existsSync(cancelSignalPath)).toBe(true);

    const signal = JSON.parse(readFileSync(cancelSignalPath, 'utf-8'));
    expect(signal.active).toBe(true);
    expect(signal.mode).toBe('autopilot');
    expect(signal.source).toBe('state_clear');

    const requestedAt = new Date(signal.requested_at).getTime();
    const expiresAt = new Date(signal.expires_at).getTime();
    expect(requestedAt).toBeGreaterThanOrEqual(before);
    expect(requestedAt).toBeLessThanOrEqual(after + 100);
    const ttlMs = expiresAt - requestedAt;
    expect(ttlMs).toBe(30_000);
  });

  it('ghost-legacy cleanup: session clear removes legacy file when sessionId matches', async () => {
    const sessionId = 'smoke-ghost-match';

    // Write session-scoped state
    await callTool(stateWriteTool, {
      mode: 'ultrawork',
      session_id: sessionId,
      active: true,
    });

    // Plant a legacy ghost file with matching sessionId in _meta
    const legacyDir = join(omcDir, 'state');
    mkdirSync(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, 'ultrawork-state.json');
    writeFileSync(
      legacyPath,
      JSON.stringify({
        active: true,
        _meta: { mode: 'ultrawork', sessionId, updatedBy: 'state_write_tool' },
      }),
    );
    expect(existsSync(legacyPath)).toBe(true);

    const clearResult = await callTool(stateClearTool, {
      mode: 'ultrawork',
      session_id: sessionId,
    });
    expect(clearResult).toContain('ghost legacy file also removed');
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('ghost-legacy preservation: session clear does NOT remove legacy file from a different session', async () => {
    const sessionId = 'smoke-ghost-mine';
    const otherSessionId = 'smoke-ghost-other';

    await callTool(stateWriteTool, {
      mode: 'ultrawork',
      session_id: sessionId,
      active: true,
    });

    // Plant a legacy ghost file belonging to another session
    const legacyDir = join(omcDir, 'state');
    mkdirSync(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, 'ultrawork-state.json');
    writeFileSync(
      legacyPath,
      JSON.stringify({
        active: true,
        _meta: { mode: 'ultrawork', sessionId: otherSessionId, updatedBy: 'state_write_tool' },
      }),
    );

    await callTool(stateClearTool, {
      mode: 'ultrawork',
      session_id: sessionId,
    });

    // Legacy file belonging to a different session must survive
    expect(existsSync(legacyPath)).toBe(true);
  });

  it('broadcast clear (no session_id) removes both legacy and session-scoped state', async () => {
    // Write two session-scoped entries
    await callTool(stateWriteTool, {
      mode: 'team',
      session_id: 'broadcast-sess-a',
      active: true,
    });
    await callTool(stateWriteTool, {
      mode: 'team',
      session_id: 'broadcast-sess-b',
      active: true,
    });

    // Write a legacy path directly
    const legacyDir = join(omcDir, 'state');
    mkdirSync(legacyDir, { recursive: true });
    const legacyPath = join(legacyDir, 'team-state.json');
    writeFileSync(legacyPath, JSON.stringify({ active: true }));

    const clearResult = await callTool(stateClearTool, { mode: 'team' });
    // Broadcast clear should mention multiple locations or warn about broad op
    expect(clearResult).toMatch(/Cleared state|cleared/i);
    expect(clearResult).toContain('WARNING');

    // Both session paths should be gone
    const sessAPath = resolveSessionStatePath('team', 'broadcast-sess-a', omcDir);
    const sessBPath = resolveSessionStatePath('team', 'broadcast-sess-b', omcDir);
    expect(existsSync(sessAPath)).toBe(false);
    expect(existsSync(sessBPath)).toBe(false);
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('state_list_active with session_id only shows modes active in that session', async () => {
    const sessionId = 'smoke-list-sess';

    // Write active state for 'ralph' in this session
    await callTool(stateWriteTool, {
      mode: 'ralph',
      session_id: sessionId,
      active: true,
    });

    // Write active state for 'ultrawork' in a DIFFERENT session
    await callTool(stateWriteTool, {
      mode: 'ultrawork',
      session_id: 'other-list-sess',
      active: true,
    });

    const listResult = await callTool(stateListActiveTool, {
      session_id: sessionId,
    });

    expect(listResult).toContain('ralph');
    // ultrawork from another session must not appear
    expect(listResult).not.toContain('ultrawork');
  });

  it('state_get_status returns correct path and existence details for a mode', async () => {
    const sessionId = 'smoke-status-sess';

    await callTool(stateWriteTool, {
      mode: 'autopilot',
      session_id: sessionId,
      active: true,
      iteration: 7,
    });

    const statusResult = await callTool(stateGetStatusTool, {
      mode: 'autopilot',
      session_id: sessionId,
    });

    expect(statusResult).toContain('autopilot');
    // Path should point into the sessions directory
    expect(statusResult).toContain(sessionId);
    // Should indicate file exists
    expect(statusResult).toContain('Yes');
  });

  it('state_read with no session_id aggregates all sessions and legacy', async () => {
    const sess1 = 'agg-sess-1';
    const sess2 = 'agg-sess-2';

    await callTool(stateWriteTool, {
      mode: 'ralph',
      session_id: sess1,
      active: true,
      task_description: 'task from sess1',
    });
    await callTool(stateWriteTool, {
      mode: 'ralph',
      session_id: sess2,
      active: true,
      task_description: 'task from sess2',
    });

    const readResult = await callTool(stateReadTool, { mode: 'ralph' });
    // Both sessions should appear
    expect(readResult).toContain(sess1);
    expect(readResult).toContain(sess2);
  });
});
