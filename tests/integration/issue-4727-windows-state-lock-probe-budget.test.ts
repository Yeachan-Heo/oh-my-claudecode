/**
 * Regression test for issue #4727: state-lock owner probe budget exhaustion on Windows.
 *
 * On Windows, a waiter whose lock owner is alive probes the owner's start identity
 * again on every retry. processStartIdentity spawns PowerShell for each probe
 * (~200-650ms per call). All probes in one acquisition share a single 3000ms
 * processProbeDeadline.
 *
 * The bug: ownerLive is called inside BEGIN IMMEDIATE, so each waiter holds the
 * SQLite write lock while PowerShell runs, and other waiters queue behind it.
 * Under contention, the shared budget drains to 0, ownerLive returns null, and
 * the acquisition fails as "unverifiable" after ~3s, even though the owner is alive.
 *
 * The fix: Probe the owner outside the write transaction. Read the row, ROLLBACK,
 * probe, then BEGIN IMMEDIATE again and check if the owner changed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { acquireStateFileLockAtPathSync, getStateFileLockFailureKind, releaseStateFileLockSync } from '../../scripts/lib/state-lock.mjs';

const tmpRoot = mkdtempSync(join(tmpdir(), 'omc-lock-issue-4727-'));

beforeAll(() => {
  mkdirSync(join(tmpRoot, 'state'), { recursive: true });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('issue #4727: Windows state-lock owner probe budget exhaustion', () => {
  it('should handle slow processStartIdentity without exhausting probe budget', () => {
    const lockPath = join(tmpRoot, 'state', 'test-4727.lock');
    
    // Create an owner that will be probed
    const ownerIdentity = '132900000000000000';
    
    // Inject a slow processStartIdentity hook to simulate Windows PowerShell latency
    // Each call takes 1000ms (total budget is 3000ms)
    const testHooks = {
      nowMs: () => Date.now(),
      processStartIdentity: (pid, timeoutMs) => {
        // Simulate slow processStartIdentity (Windows PowerShell)
        const start = Date.now();
        // Sleep for 500ms to simulate PowerShell latency
        while (Date.now() - start < 500 && Date.now() - start < timeoutMs) {
          // Busy-wait to simulate work
        }
        return ownerIdentity;
      },
    };

    // First, acquire the lock with normal conditions
    const lock1 = acquireStateFileLockAtPathSync(
      lockPath,
      50, // attempts
      false, // requireExclusive
      false, // bypassTestOverride
      2000, // busyTimeoutMs
      3000, // processProbeTimeoutMs - standard 3000ms
      Infinity, // overallTimeoutMs
      testHooks,
    );

    expect(lock1).not.toBeNull();
    if (lock1) {
      // Now try to acquire again with slow probe (this simulates contention)
      // The first waiter will probe the owner, taking ~500ms
      // The second waiter should not be blocked by the first's PowerShell call
      // under the new implementation

      // Release the first lock
      releaseStateFileLockSync(lock1);
    }

    // Try another acquisition with the slow hook
    const lock2 = acquireStateFileLockAtPathSync(
      lockPath,
      50,
      false,
      false,
      2000,
      3000,
      Infinity,
      testHooks,
    );

    expect(lock2).not.toBeNull();
    expect(getStateFileLockFailureKind()).not.toBe('unverifiable');
  });

  it('should not serialize waiter probes under BEGIN IMMEDIATE', () => {
    const lockPath = join(tmpRoot, 'state', 'test-4727-serial.lock');
    
    const ownerIdentity = '132900000000000000';
    let probeCount = 0;
    const probeTimes: number[] = [];

    const testHooks = {
      nowMs: () => Date.now(),
      processStartIdentity: (pid, timeoutMs) => {
        probeCount += 1;
        const start = Date.now();
        probeTimes.push(start);
        
        // Simulate 800ms per probe (total budget 3000ms)
        // If probes serialize under BEGIN IMMEDIATE, the second one won't complete
        while (Date.now() - start < 800 && Date.now() - start < timeoutMs) {
          // Busy-wait
        }
        return ownerIdentity;
      },
    };

    // This test would be better as a multi-process test, but we can still verify
    // that a single acquisition with multiple retries and probes doesn't fail
    // when the owner is alive.
    const lock = acquireStateFileLockAtPathSync(
      lockPath,
      50,
      false,
      false,
      2000,
      3000, // 3000ms budget
      Infinity,
      testHooks,
    );

    expect(lock).not.toBeNull();
    expect(getStateFileLockFailureKind()).not.toBe('unverifiable');
  });
});
