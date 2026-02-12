/**
 * Regression test for issue #584: session-idle notification never fires
 *
 * The Stop hook calls persistent-mode.mjs directly (bypassing bridge.js),
 * so the idle notification logic in bridge.ts's processPersistentMode() is
 * never reached. This test verifies that processPersistentMode in bridge.ts
 * correctly fires session-idle notification when no mode is blocking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processHook, resetSkipHooksCache, type HookInput } from '../bridge.js';

// Mock the notifications module so we can verify it gets called
vi.mock('../../notifications/index.js', () => ({
  notify: vi.fn().mockResolvedValue(null),
  getNotificationConfig: vi.fn().mockReturnValue(null),
  isEventEnabled: vi.fn().mockReturnValue(false),
  formatNotification: vi.fn(),
  dispatchNotifications: vi.fn(),
  formatSessionStart: vi.fn(),
  formatSessionStop: vi.fn(),
  formatSessionEnd: vi.fn(),
  formatSessionIdle: vi.fn(),
  formatAskUserQuestion: vi.fn(),
  getCurrentTmuxSession: vi.fn(),
  getTeamTmuxSessions: vi.fn(),
  formatTmuxInfo: vi.fn(),
  getEnabledPlatforms: vi.fn(),
  sendDiscord: vi.fn(),
  sendDiscordBot: vi.fn(),
  sendTelegram: vi.fn(),
  sendSlack: vi.fn(),
  sendWebhook: vi.fn(),
}));

describe('Issue #584 - session-idle notification fires from persistent-mode hook', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DISABLE_OMC;
    delete process.env.OMC_SKIP_HOOKS;
    resetSkipHooksCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetSkipHooksCache();
  });

  it('should fire session-idle notification when no mode is blocking', async () => {
    const { notify } = await import('../../notifications/index.js');

    const input: HookInput = {
      sessionId: 'test-idle-session',
      directory: '/tmp/test-idle-584',
    };

    const result = await processHook('persistent-mode', input);

    expect(result.continue).toBe(true);

    // Wait for async notification dispatch (fire-and-forget)
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(notify).toHaveBeenCalledWith('session-idle', {
      sessionId: 'test-idle-session',
      projectPath: expect.any(String),
    });
  });

  it('should NOT fire session-idle when user aborted (user_requested=true)', async () => {
    const { notify } = await import('../../notifications/index.js');

    const input: HookInput = {
      sessionId: 'test-abort-session',
      directory: '/tmp/test-abort-584',
    };

    // Simulate user abort via snake_case field (as Claude Code sends it)
    const inputWithAbort = {
      ...input,
      user_requested: true,
    } as HookInput;

    const result = await processHook('persistent-mode', inputWithAbort);

    expect(result.continue).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 50));

    // notify should NOT have been called with session-idle
    const idleCalls = (notify as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === 'session-idle'
    );
    expect(idleCalls).toHaveLength(0);
  });

  it('should NOT fire session-idle when context limit reached', async () => {
    const { notify } = await import('../../notifications/index.js');

    const input: HookInput = {
      sessionId: 'test-ctx-session',
      directory: '/tmp/test-ctx-584',
    };

    const inputWithCtx = {
      ...input,
      stop_reason: 'context_limit',
    } as HookInput;

    const result = await processHook('persistent-mode', inputWithCtx);

    expect(result.continue).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const idleCalls = (notify as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === 'session-idle'
    );
    expect(idleCalls).toHaveLength(0);
  });

  it('should NOT fire session-idle when sessionId is missing', async () => {
    const { notify } = await import('../../notifications/index.js');

    const input: HookInput = {
      directory: '/tmp/test-nosession-584',
    };

    const result = await processHook('persistent-mode', input);

    expect(result.continue).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const idleCalls = (notify as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === 'session-idle'
    );
    expect(idleCalls).toHaveLength(0);
  });
});
