/**
 * Tests for idle-nudge module (issue #1047)
 *
 * Coverage:
 * - NudgeTracker: config defaults, delay timing, max count, leader exclusion
 * - isPaneIdle: idle detection via paneLooksReady + !paneHasActiveTask
 * - Nudge summary and totalNudges counter
 * - Scan throttling (5s minimum between scans)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

// Mock child_process so tmux calls don't require a real tmux install
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, '', '');
      return {} as any;
    }),
  };
});

// Mock sendToWorker from tmux-session to avoid real tmux calls
vi.mock('../tmux-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tmux-session.js')>();
  return {
    ...actual,
    sendToWorker: vi.fn(async () => true),
    paneLooksReady: actual.paneLooksReady,
    paneHasActiveTask: actual.paneHasActiveTask,
  };
});

import { NudgeTracker, DEFAULT_NUDGE_CONFIG, capturePane, isPaneIdle } from '../idle-nudge.js';
import { sendToWorker, paneLooksReady, paneHasActiveTask } from '../tmux-session.js';
import { execFile } from 'child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockCaptureOutput(output: string): void {
  vi.mocked(execFile).mockImplementation(((_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    if (Array.isArray(args) && args[0] === 'capture-pane') {
      cb(null, output, '');
    } else {
      cb(null, '', '');
    }
    return {} as any;
  }) as any);
}

/** Pane content that looks idle (shows prompt, no active task) */
const IDLE_PANE_CONTENT = [
  'some previous output',
  '',
  '> ',
].join('\n');

/** Pane content with an active task running */
const ACTIVE_PANE_CONTENT = [
  'Working on task...',
  '  esc to interrupt',
  '',
].join('\n');

/** Empty pane (just started, not yet ready) */
const EMPTY_PANE_CONTENT = '';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// DEFAULT_NUDGE_CONFIG
// ---------------------------------------------------------------------------

describe('DEFAULT_NUDGE_CONFIG', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_NUDGE_CONFIG.delayMs).toBe(30_000);
    expect(DEFAULT_NUDGE_CONFIG.maxCount).toBe(3);
    expect(typeof DEFAULT_NUDGE_CONFIG.message).toBe('string');
    expect(DEFAULT_NUDGE_CONFIG.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// paneLooksReady / paneHasActiveTask (pure functions, exported from tmux-session)
// ---------------------------------------------------------------------------

describe('idle detection helpers', () => {
  it('paneLooksReady detects prompt characters', () => {
    expect(paneLooksReady('> ')).toBe(true);
    expect(paneLooksReady('some output\n> ')).toBe(true);
    expect(paneLooksReady('Working on task...')).toBe(false);
  });

  it('paneHasActiveTask detects active task indicators', () => {
    expect(paneHasActiveTask(ACTIVE_PANE_CONTENT)).toBe(true);
    expect(paneHasActiveTask(IDLE_PANE_CONTENT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// capturePane
// ---------------------------------------------------------------------------

describe('capturePane', () => {
  it('returns tmux capture-pane output', async () => {
    vi.useRealTimers();
    mockCaptureOutput('hello world\n');
    const result = await capturePane('%1');
    expect(result).toBe('hello world\n');
  });

  it('returns empty string on error', async () => {
    vi.useRealTimers();
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(new Error('tmux not found'), '', '');
      return {} as any;
    }) as any);
    const result = await capturePane('%1');
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// isPaneIdle
// ---------------------------------------------------------------------------

describe('isPaneIdle', () => {
  it('returns true when pane shows prompt and no active task', async () => {
    vi.useRealTimers();
    mockCaptureOutput(IDLE_PANE_CONTENT);
    expect(await isPaneIdle('%1')).toBe(true);
  });

  it('returns false when pane has active task', async () => {
    vi.useRealTimers();
    mockCaptureOutput(ACTIVE_PANE_CONTENT);
    expect(await isPaneIdle('%1')).toBe(false);
  });

  it('returns false when pane is empty', async () => {
    vi.useRealTimers();
    mockCaptureOutput(EMPTY_PANE_CONTENT);
    expect(await isPaneIdle('%1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NudgeTracker
// ---------------------------------------------------------------------------

describe('NudgeTracker', () => {
  it('uses default config when none provided', () => {
    const tracker = new NudgeTracker();
    expect(tracker.totalNudges).toBe(0);
    expect(tracker.getSummary()).toEqual({});
  });

  it('accepts partial config overrides', () => {
    const tracker = new NudgeTracker({ delayMs: 5000 });
    // Should use 5000 for delay but defaults for maxCount and message
    expect(tracker.totalNudges).toBe(0);
  });

  it('does not nudge before delay has elapsed', async () => {
    mockCaptureOutput(IDLE_PANE_CONTENT);
    const tracker = new NudgeTracker({ delayMs: 10_000 });

    // First call: detects idle, starts timer
    const nudged = await tracker.checkAndNudge(['%2'], '%1', 'test-session');
    expect(nudged).toEqual([]);
    expect(vi.mocked(sendToWorker)).not.toHaveBeenCalled();
  });

  it('nudges after delay has elapsed', async () => {
    mockCaptureOutput(IDLE_PANE_CONTENT);
    const tracker = new NudgeTracker({ delayMs: 10_000 });

    // First call at T=0: detects idle, starts timer
    await tracker.checkAndNudge(['%2'], '%1', 'test-session');

    // Advance past delay + scan interval
    vi.advanceTimersByTime(15_000);

    // Second call: delay has elapsed, should nudge
    const nudged = await tracker.checkAndNudge(['%2'], '%1', 'test-session');
    expect(nudged).toEqual(['%2']);
    expect(vi.mocked(sendToWorker)).toHaveBeenCalledWith('test-session', '%2', DEFAULT_NUDGE_CONFIG.message);
    expect(tracker.totalNudges).toBe(1);
  });

  it('uses custom nudge message', async () => {
    mockCaptureOutput(IDLE_PANE_CONTENT);
    const customMessage = 'Hey, keep going!';
    const tracker = new NudgeTracker({ delayMs: 1000, message: customMessage });

    await tracker.checkAndNudge(['%2'], '%1', 'test-session');
    vi.advanceTimersByTime(6_000);
    await tracker.checkAndNudge(['%2'], '%1', 'test-session');

    expect(vi.mocked(sendToWorker)).toHaveBeenCalledWith('test-session', '%2', customMessage);
  });

  it('never nudges the leader pane', async () => {
    mockCaptureOutput(IDLE_PANE_CONTENT);
    const tracker = new NudgeTracker({ delayMs: 0 });

    // Advance past scan interval
    vi.advanceTimersByTime(6_000);

    const nudged = await tracker.checkAndNudge(['%1', '%2'], '%1', 'test-session');
    // %1 is the leader — should not be nudged
    expect(nudged).toEqual(['%2']);
    expect(vi.mocked(sendToWorker)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendToWorker)).toHaveBeenCalledWith('test-session', '%2', expect.any(String));
  });

  it('respects maxCount limit', async () => {
    mockCaptureOutput(IDLE_PANE_CONTENT);
    const tracker = new NudgeTracker({ delayMs: 0, maxCount: 2 });

    // Nudge 1
    vi.advanceTimersByTime(6_000);
    await tracker.checkAndNudge(['%2'], '%1', 'test-session');
    expect(tracker.totalNudges).toBe(1);

    // Nudge 2
    vi.advanceTimersByTime(6_000);
    await tracker.checkAndNudge(['%2'], '%1', 'test-session');
    expect(tracker.totalNudges).toBe(2);

    // Nudge 3 — should be blocked by maxCount=2
    vi.advanceTimersByTime(6_000);
    const nudged = await tracker.checkAndNudge(['%2'], '%1', 'test-session');
    expect(nudged).toEqual([]);
    expect(tracker.totalNudges).toBe(2);
  });

  it('resets idle timer when pane becomes active', async () => {
    const tracker = new NudgeTracker({ delayMs: 5_000 });

    // T=0: idle
    mockCaptureOutput(IDLE_PANE_CONTENT);
    await tracker.checkAndNudge(['%2'], '%1', 'test-session');

    // T=3s: pane becomes active — resets timer
    vi.advanceTimersByTime(6_000);
    mockCaptureOutput(ACTIVE_PANE_CONTENT);
    await tracker.checkAndNudge(['%2'], '%1', 'test-session');

    // T=6s: idle again — timer restarts from here
    vi.advanceTimersByTime(6_000);
    mockCaptureOutput(IDLE_PANE_CONTENT);
    await tracker.checkAndNudge(['%2'], '%1', 'test-session');

    // T=9s: only 3s since idle restart — should NOT nudge
    vi.advanceTimersByTime(3_000);
    const nudged = await tracker.checkAndNudge(['%2'], '%1', 'test-session');
    expect(nudged).toEqual([]);
    expect(tracker.totalNudges).toBe(0);
  });

  it('throttles scans to minimum interval', async () => {
    mockCaptureOutput(IDLE_PANE_CONTENT);
    const tracker = new NudgeTracker({ delayMs: 0 });

    // First call runs (scan interval starts at 0)
    const first = await tracker.checkAndNudge(['%2'], '%1', 'test-session');
    expect(first).toEqual(['%2']);

    // Immediate second call — throttled (< 5s scan interval)
    const second = await tracker.checkAndNudge(['%2'], '%1', 'test-session');
    expect(second).toEqual([]);
  });

  it('getSummary returns nudge counts per pane', async () => {
    mockCaptureOutput(IDLE_PANE_CONTENT);
    const tracker = new NudgeTracker({ delayMs: 0 });

    vi.advanceTimersByTime(6_000);
    await tracker.checkAndNudge(['%2', '%3'], '%1', 'test-session');

    const summary = tracker.getSummary();
    expect(summary['%2']).toEqual({ nudgeCount: 1, lastNudgeAt: expect.any(Number) });
    expect(summary['%3']).toEqual({ nudgeCount: 1, lastNudgeAt: expect.any(Number) });
  });

  it('handles sendToWorker failure gracefully', async () => {
    mockCaptureOutput(IDLE_PANE_CONTENT);
    vi.mocked(sendToWorker).mockResolvedValueOnce(false);
    const tracker = new NudgeTracker({ delayMs: 0 });

    vi.advanceTimersByTime(6_000);
    const nudged = await tracker.checkAndNudge(['%2'], '%1', 'test-session');
    // sendToWorker returned false — pane should not be counted as nudged
    expect(nudged).toEqual([]);
    expect(tracker.totalNudges).toBe(0);
  });

  it('handles multiple panes independently', async () => {
    const tracker = new NudgeTracker({ delayMs: 0, maxCount: 1 });

    // %2 is idle, %3 is active
    vi.mocked(execFile).mockImplementation(((_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (Array.isArray(args) && args[0] === 'capture-pane') {
        const paneId = args[2];
        if (paneId === '%2') cb(null, IDLE_PANE_CONTENT, '');
        else if (paneId === '%3') cb(null, ACTIVE_PANE_CONTENT, '');
        else cb(null, '', '');
      } else {
        cb(null, '', '');
      }
      return {} as any;
    }) as any);

    vi.advanceTimersByTime(6_000);
    const nudged = await tracker.checkAndNudge(['%2', '%3'], '%1', 'test-session');
    expect(nudged).toEqual(['%2']); // only %2 was idle
    expect(tracker.totalNudges).toBe(1);
  });
});
