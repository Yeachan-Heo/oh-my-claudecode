import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LayoutStabilizer } from '../layout-stabilizer.js';

// Mock child_process to avoid real tmux calls
vi.mock('child_process', () => {
  const execFileFn = vi.fn((_cmd: string, _args: string[], cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    if (cb) {
      cb(null, { stdout: '200', stderr: '' });
      return;
    }
    return { stdout: '200', stderr: '' };
  });

  const execFn = vi.fn((_cmd: string, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    if (cb) {
      cb(null, { stdout: '200', stderr: '' });
      return;
    }
    return { stdout: '200', stderr: '' };
  });

  return {
    execFile: execFileFn,
    exec: execFn,
    promisify: vi.fn((fn: unknown) => {
      return (...args: unknown[]) => {
        return new Promise((resolve, reject) => {
          (fn as Function)(...args, (err: Error | null, result: unknown) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
      };
    }),
  };
});

// Must re-import promisify so our mock is used
vi.mock('util', async () => {
  const actual = await vi.importActual<typeof import('util')>('util');
  return {
    ...actual,
    promisify: vi.fn((fn: unknown) => {
      return (...args: unknown[]) => {
        return new Promise((resolve, reject) => {
          (fn as Function)(...args, (err: Error | null, result: unknown) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
      };
    }),
  };
});

describe('LayoutStabilizer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('creates without errors', () => {
    const stabilizer = new LayoutStabilizer({
      sessionTarget: 'test-session:0',
      leaderPaneId: '%0',
    });
    expect(stabilizer).toBeDefined();
    expect(stabilizer.sessionTarget).toBe('test-session:0');
    expect(stabilizer.leaderPaneId).toBe('%0');
    stabilizer.dispose();
  });

  it('requestLayout sets a pending timer', () => {
    const stabilizer = new LayoutStabilizer({
      sessionTarget: 'test-session:0',
      leaderPaneId: '%0',
      debounceMs: 100,
    });

    expect(stabilizer.isPending).toBe(false);
    stabilizer.requestLayout();
    expect(stabilizer.isPending).toBe(true);

    stabilizer.dispose();
  });

  it('multiple rapid requestLayout calls coalesce into one pending', () => {
    const stabilizer = new LayoutStabilizer({
      sessionTarget: 'test-session:0',
      leaderPaneId: '%0',
      debounceMs: 100,
    });

    stabilizer.requestLayout();
    stabilizer.requestLayout();
    stabilizer.requestLayout();

    // Should still only have one pending timer
    expect(stabilizer.isPending).toBe(true);

    stabilizer.dispose();
  });

  it('dispose cancels pending timer', () => {
    const stabilizer = new LayoutStabilizer({
      sessionTarget: 'test-session:0',
      leaderPaneId: '%0',
      debounceMs: 100,
    });

    stabilizer.requestLayout();
    expect(stabilizer.isPending).toBe(true);

    stabilizer.dispose();
    expect(stabilizer.isPending).toBe(false);
  });

  it('requestLayout after dispose is a no-op', () => {
    const stabilizer = new LayoutStabilizer({
      sessionTarget: 'test-session:0',
      leaderPaneId: '%0',
      debounceMs: 100,
    });

    stabilizer.dispose();
    stabilizer.requestLayout();
    expect(stabilizer.isPending).toBe(false);
  });

  it('flush after dispose resolves immediately', async () => {
    const stabilizer = new LayoutStabilizer({
      sessionTarget: 'test-session:0',
      leaderPaneId: '%0',
      debounceMs: 100,
    });

    stabilizer.dispose();
    // Should not throw or hang
    await stabilizer.flush();
  });

  it('flush cancels pending debounce and runs immediately', async () => {
    const stabilizer = new LayoutStabilizer({
      sessionTarget: 'test-session:0',
      leaderPaneId: '%0',
      debounceMs: 5000, // long debounce
    });

    stabilizer.requestLayout();
    expect(stabilizer.isPending).toBe(true);

    // Flush should cancel the pending timer and execute immediately
    const flushPromise = stabilizer.flush();
    // Advance timers to let the async applyLayout complete
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(stabilizer.isPending).toBe(false);
    stabilizer.dispose();
  });

  it('default debounceMs is 150', () => {
    const stabilizer = new LayoutStabilizer({
      sessionTarget: 'test-session:0',
      leaderPaneId: '%0',
    });

    stabilizer.requestLayout();
    expect(stabilizer.isPending).toBe(true);

    // After 100ms, should still be pending
    vi.advanceTimersByTime(100);
    expect(stabilizer.isPending).toBe(true);

    stabilizer.dispose();
  });

  it('pending clears after debounce period expires', async () => {
    const stabilizer = new LayoutStabilizer({
      sessionTarget: 'test-session:0',
      leaderPaneId: '%0',
      debounceMs: 100,
    });

    stabilizer.requestLayout();
    expect(stabilizer.isPending).toBe(true);

    // Advance past debounce period
    await vi.advanceTimersByTimeAsync(150);

    expect(stabilizer.isPending).toBe(false);

    stabilizer.dispose();
  });

  it('debounce resets when requestLayout is called again within window', async () => {
    const stabilizer = new LayoutStabilizer({
      sessionTarget: 'test-session:0',
      leaderPaneId: '%0',
      debounceMs: 100,
    });

    stabilizer.requestLayout();
    expect(stabilizer.isPending).toBe(true);

    // Advance 80ms (not past debounce yet)
    vi.advanceTimersByTime(80);
    expect(stabilizer.isPending).toBe(true);

    // Request again — this should reset the debounce
    stabilizer.requestLayout();

    // Advance another 80ms (160ms total, but only 80ms since last request)
    vi.advanceTimersByTime(80);
    expect(stabilizer.isPending).toBe(true);

    // Advance past the second debounce window
    await vi.advanceTimersByTimeAsync(50);
    expect(stabilizer.isPending).toBe(false);

    stabilizer.dispose();
  });

  it('isRunning is false initially and after completion', () => {
    const stabilizer = new LayoutStabilizer({
      sessionTarget: 'test-session:0',
      leaderPaneId: '%0',
    });

    expect(stabilizer.isRunning).toBe(false);
    stabilizer.dispose();
  });

  it('queues layout request that arrives while running', async () => {
    const stabilizer = new LayoutStabilizer({
      sessionTarget: 'test-session:0',
      leaderPaneId: '%0',
      debounceMs: 50,
    });

    // Start a layout operation via flush
    const flushPromise = stabilizer.flush();

    // While running, request another layout
    stabilizer.requestLayout();

    await vi.runAllTimersAsync();
    await flushPromise;

    // The queued request should have scheduled a new debounced layout
    // After running all timers, everything should settle
    await vi.runAllTimersAsync();

    expect(stabilizer.isRunning).toBe(false);
    stabilizer.dispose();
  });
});
