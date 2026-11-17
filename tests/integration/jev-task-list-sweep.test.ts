import { mkdtemp, mkdir, writeFile, rmSync } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { statSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweep, LISTS_MAX_AGE_MS } from '../../scripts/lib/jev-task-list.mjs';

// Test coverage for the destructive session-retention sweep in jev-task-list.mjs
// The sweep recursively deletes task-list directories older than LISTS_MAX_AGE_MS (7 days)
// but only after waiting SWEEP_EVERY_MS (1 hour) since the last sweep.

const SWEEP_EVERY_MS = 3600 * 1000; // 1 hour

let testRoot = '';
let created: string[] = [];

async function writeJson(dir: string, name: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), JSON.stringify(value), 'utf-8');
}

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'jev-sweep-test-'));
  created.push(testRoot);
});

afterEach(() => {
  while (created.length) {
    try {
      rmSync(created.pop(), { recursive: true, force: true });
    } catch { /* cleanup */ }
  }
});

describe('sweep in jev-task-list', () => {
  it('is exported and callable with environment and timestamp', async () => {
    // Basic test to verify the sweep function is exported and works
    const env = { OMC_TASK_LIST_LOG_DIR: testRoot };
    const now = Date.now();
    
    // Should not throw
    expect(() => sweep(env, now)).not.toThrow();
  });

  it('preserves task directories younger than LISTS_MAX_AGE_MS', async () => {
    const recentDir = join(testRoot, 'recent-keep');
    await mkdir(recentDir, { recursive: true });

    const now = Date.now();
    const recentTime = now - 1000; // 1 second ago
    utimesSync(recentDir, recentTime / 1000, recentTime / 1000);

    // Create stale sweep marker to allow sweep to run
    const sweepMarker = join(testRoot, '.sweep');
    const sweepMarkerOldTime = now - SWEEP_EVERY_MS - 1000;
    await writeJson(testRoot, '.sweep', { ts: new Date(sweepMarkerOldTime).toISOString() });
    utimesSync(sweepMarker, sweepMarkerOldTime / 1000, sweepMarkerOldTime / 1000);

    const env = { OMC_TASK_LIST_LOG_DIR: testRoot };
    sweep(env, now);

    // Recent directory must still exist
    expect(existsSync(recentDir)).toBe(true);
  });

  it('throttles sweeps to run at most every SWEEP_EVERY_MS (1 hour)', async () => {
    const expiredDir = join(testRoot, 'expired');
    await mkdir(expiredDir, { recursive: true });

    const now = Date.now();
    const expiredTime = now - LISTS_MAX_AGE_MS - 86400000;
    utimesSync(expiredDir, expiredTime / 1000, expiredTime / 1000);

    // Create a RECENT sweep marker (within the throttle window)
    const sweepMarker = join(testRoot, '.sweep');
    const recentSweepTime = now - 100; // 100ms ago (much less than 1 hour)
    await writeJson(testRoot, '.sweep', { ts: new Date(recentSweepTime).toISOString() });
    utimesSync(sweepMarker, recentSweepTime / 1000, recentSweepTime / 1000);

    const env = { OMC_TASK_LIST_LOG_DIR: testRoot };
    sweep(env, now);

    // Expired directory should NOT be removed because sweep is throttled
    expect(existsSync(expiredDir)).toBe(true);
  });
});
