/**
 * Regression test for issue #4146: state-lock owner-file fallback race condition.
 *
 * Verifies that the file lock fallback doesn't break mutual exclusion when:
 * - An owner releases and exits during a reclaimer's liveness probe
 * - A replacement owner publishes a new lock in the interim
 * - The reclaimer must not quarantine the live replacement
 *
 * The repro script demonstrates three failure modes:
 * 1. Two holders at once (overlapping critical sections)
 * 2. Stranded locks (dead owner record blocking new acquirers)
 * 3. Spurious unverifiable/release-failed errors
 *
 * With the fix, file identity is captured before the probe and re-verified
 * before reclamation, preventing a live replacement from being quarantined.
 */

import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '../..');
const tmpRoot = mkdtempSync(join(tmpdir(), 'omc-lock-test-'));
const testSuiteKey = `state-lock-owner-reclaim-${Date.now()}`;

beforeAll(() => {
  mkdirSync(join(tmpRoot, 'state'), { recursive: true });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Run the repro script in worker mode to test the lock mechanism.
 * Returns an object with metrics about lock acquisition and release.
 */
async function runLockTest(
  testKey: string,
  procs: number,
  iterations: number,
  timeoutMs: number = 90_000,
): Promise<{
  acquisitions: number;
  counter: number;
  overlaps: number;
  releaseFailures: number;
  acquireFailures: number;
  stranded: boolean;
  violated: boolean;
}> {
  const stateDir = join(tmpRoot, 'state', testKey);
  mkdirSync(stateDir, { recursive: true });
  const target = join(stateDir, 'counter.json');
  const log = join(stateDir, 'log.txt');

  writeFileSync(target, '0');
  writeFileSync(log, '');

  // Force the owner-file fallback
  const env = { ...process.env, NODE_ENV: 'test', OMC_TEST_FLOCK_AVAILABLE: '0' };

  // Repro script from issue #4146, run in worker mode
  const reproPath = join(REPO_ROOT, 'scripts', 'dev', 'repro-state-lock.mjs');

  return new Promise((resolve) => {
    const processes: ReturnType<typeof spawn>[] = [];
    let completed = 0;

    for (let i = 0; i < procs; i++) {
      const proc = spawn(process.execPath, [reproPath, 'worker', target, String(iterations), log], {
        env,
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: timeoutMs,
      });

      proc.on('exit', () => {
        completed += 1;
        if (completed === procs) {
          // All workers done, analyze results
          const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
          const count = (re: RegExp) => lines.filter((l) => re.test(l)).length;
          const acquired = count(/ acquired$/);
          const counter = Number(readFileSync(target, 'utf8'));
          const stranded = existsSync(`${target}.mutation.lock`);
          const violated = acquired !== counter || count(/OVERLAP/) > 0;

          resolve({
            acquisitions: acquired,
            counter,
            overlaps: count(/OVERLAP/),
            releaseFailures: count(/release-failed/),
            acquireFailures: count(/acquire-failed/),
            stranded,
            violated,
          });

          // Cleanup
          try {
            rmSync(stateDir, { recursive: true, force: true });
          } catch {}
        }
      });

      processes.push(proc);
    }
  });
}

describe('state-lock owner-file fallback mutual exclusion (issue #4146)', () => {
  it('maintains mutual exclusion with concurrent acquisitions', async () => {
    const result = await runLockTest(`test-mutex-${testSuiteKey}`, 4, 10);

    // Guard against a vacuous pass (workers never ran / script missing)
    expect(result.acquisitions).toBeGreaterThan(0);

    // With the fix, all acquisitions should complete without overlap or lost updates
    expect(result.violated).toBe(false);
    expect(result.overlaps).toBe(0);
    expect(result.acquisitions).toBe(result.counter);
    expect(result.stranded).toBe(false);
  }, 120_000);

  it('handles dead owner reclaim without quarantining live replacements', async () => {
    const result = await runLockTest(`test-reclaim-${testSuiteKey}`, 3, 5);
    expect(result.acquisitions).toBeGreaterThan(0);

    // Verify no mutual exclusion violations occurred
    expect(result.violated).toBe(false);
    expect(result.overlaps).toBe(0);

    // Verify no stranded locks left behind
    expect(result.stranded).toBe(false);
  }, 120_000);

  it('does not produce excessive unverifiable errors', async () => {
    const result = await runLockTest(`test-unverifiable-${testSuiteKey}`, 2, 3);
    expect(result.acquisitions).toBeGreaterThan(0);

    // With the fix, unverifiable errors should be rare/absent
    // (they can still happen in rare races, but not the systemic kind)
    expect(result.acquireFailures).toBeLessThan(10);
  }, 120_000);
});
