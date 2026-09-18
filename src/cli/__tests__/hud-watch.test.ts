import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseHudWatchInterval, runHudWatchLoop } from '../hud-watch.js';
import type { RegisterStandaloneShutdownHandlersOptions } from '../../mcp/standalone-shutdown.js';

describe('parseHudWatchInterval', () => {
  it.each([
    ['1', 1],
    ['250', 250],
    [' 1000 ', 1_000],
  ])('parses %j as %i milliseconds', (raw, expected) => {
    expect(parseHudWatchInterval(raw)).toBe(expected);
  });

  it.each(['', '0', '-1', '1.5', '100ms', 'abc', `${Number.MAX_SAFE_INTEGER}0`])(
    'rejects invalid interval %j',
    (raw) => {
      expect(() => parseHudWatchInterval(raw)).toThrow(
        'must be a positive integer in milliseconds',
      );
    },
  );
});

describe('runHudWatchLoop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops the watch loop when shutdown is requested', async () => {
    let shutdownHandler: ((reason: string) => Promise<void>) | undefined;
    const registerShutdownHandlers = vi.fn((options: RegisterStandaloneShutdownHandlersOptions) => {
      const onShutdown = async (reason: string): Promise<void> => {
        await options.onShutdown(reason);
      };
      shutdownHandler = onShutdown;
      return { shutdown: onShutdown };
    });

    const hudMain = vi.fn(async () => {
      await shutdownHandler?.('SIGTERM');
    });

    await runHudWatchLoop({
      intervalMs: 1_000,
      hudMain,
      registerShutdownHandlers,
    });

    expect(hudMain).toHaveBeenCalledTimes(1);
    expect(hudMain).toHaveBeenNthCalledWith(1, true, false);
  });

  it('uses skipInit=true after the first iteration', async () => {
    vi.useFakeTimers();

    let shutdownHandler: ((reason: string) => Promise<void>) | undefined;
    const registerShutdownHandlers = vi.fn((options: RegisterStandaloneShutdownHandlersOptions) => {
      const onShutdown = async (reason: string): Promise<void> => {
        await options.onShutdown(reason);
      };
      shutdownHandler = onShutdown;
      return { shutdown: onShutdown };
    });

    const hudMain = vi.fn(async () => {
      if (hudMain.mock.calls.length === 2) {
        await shutdownHandler?.('SIGTERM');
      }
    });

    const loopPromise = runHudWatchLoop({
      intervalMs: 1_000,
      hudMain,
      registerShutdownHandlers,
    });

    await vi.waitFor(() => {
      expect(hudMain).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await loopPromise;

    expect(hudMain).toHaveBeenNthCalledWith(1, true, false);
    expect(hudMain).toHaveBeenNthCalledWith(2, true, true);
  });

  it('keeps the polling timer referenced while watch mode is active', async () => {
    const intervalMs = 60_000;
    let shutdownHandler: ((reason: string) => Promise<void>) | undefined;
    const registerShutdownHandlers = vi.fn((options: RegisterStandaloneShutdownHandlersOptions) => {
      const onShutdown = async (reason: string): Promise<void> => {
        await options.onShutdown(reason);
      };
      shutdownHandler = onShutdown;
      return { shutdown: onShutdown };
    });
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const loopPromise = runHudWatchLoop({
      intervalMs,
      hudMain: vi.fn(async () => {}),
      registerShutdownHandlers,
    });

    try {
      await vi.waitFor(() => {
        expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === intervalMs)).toBe(true);
      });

      const pollingTimers = setTimeoutSpy.mock.calls.flatMap(([, delay], index) =>
        delay === intervalMs
          ? [setTimeoutSpy.mock.results[index]?.value as NodeJS.Timeout]
          : []
      );

      expect(pollingTimers).toHaveLength(1);
      expect(pollingTimers[0]?.hasRef()).toBe(true);
    } finally {
      await shutdownHandler?.('SIGTERM');
      await loopPromise;
      setTimeoutSpy.mockRestore();
    }
  });
});
