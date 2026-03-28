import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn } from 'child_process';
import {
  trackChildProcess,
  untrackChildProcess,
  killAllTrackedProcesses,
  getTrackedProcessCount,
} from '../platform/child-process-tracker.js';

describe('child-process-tracker', () => {
  beforeEach(() => {
    // Kill any leftover tracked processes from prior tests
    killAllTrackedProcesses();
  });

  it('tracks a spawned child process and auto-removes on exit', async () => {
    const child = spawn('node', ['-e', 'setTimeout(() => {}, 100)'], {
      stdio: 'ignore',
    });

    trackChildProcess(child, 'test-short-lived');
    expect(getTrackedProcessCount()).toBeGreaterThanOrEqual(1);

    // Wait for the child to exit naturally
    await new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
    });

    // After natural exit, it should be untracked
    expect(getTrackedProcessCount()).toBe(0);
  });

  it('killAllTrackedProcesses terminates a long-running child', async () => {
    const child = spawn('node', ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });

    trackChildProcess(child, 'test-long-lived');
    expect(getTrackedProcessCount()).toBeGreaterThanOrEqual(1);

    killAllTrackedProcesses();
    expect(getTrackedProcessCount()).toBe(0);

    // Wait for actual process exit
    await new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
      // Safety timeout
      setTimeout(resolve, 3000);
    });
  });

  it('untrackChildProcess removes a process from tracking', () => {
    const child = spawn('node', ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });

    trackChildProcess(child, 'test-untrack');
    const pid = child.pid!;
    expect(getTrackedProcessCount()).toBeGreaterThanOrEqual(1);

    untrackChildProcess(pid);
    expect(getTrackedProcessCount()).toBe(0);

    // Clean up the process manually
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already dead
    }
  });

  it('handles process that failed to spawn (no pid)', () => {
    // Create a mock ChildProcess-like object with no pid
    const fakeProc = {
      pid: undefined,
      on: vi.fn(),
    } as any;

    const result = trackChildProcess(fakeProc, 'no-pid');
    expect(result).toBe(fakeProc);
    expect(getTrackedProcessCount()).toBe(0);
  });
});
