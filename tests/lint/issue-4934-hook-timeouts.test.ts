/**
 * Issue #4934: Jev active mode - hook timeouts are too short for two Jev requests in one hook
 *
 * persistent-mode.mjs makes TWO Jev requests:
 *   1. recordLearnerExtractionShadow (async, early)
 *   2. recordLoopContinuationShadow (can be active/sync, later)
 *
 * Each Jev request in active mode can take up to 2 seconds (DEFAULT_TIMEOUT_MS from jev-resolve.mjs)
 * With 10-second hook timeout, this leaves minimal room for processing overhead.
 * When Jev is slow or timeouts occur, the hook can exceed its timeout.
 *
 * Fix: Increase persistent-mode timeout from 10 to 15 seconds to accommodate:
 *   - Two sequential Jev requests at 2 seconds each = 4 seconds
 *   - Processing overhead = ~1 second
 *   - Buffer for slow operations = 10 seconds total
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Issue #4934: Hook timeouts for multiple Jev requests', () => {
  it('persistent-mode hook has sufficient timeout for two Jev requests', () => {
    const hooksJson = JSON.parse(
      readFileSync(join(process.cwd(), 'hooks', 'hooks.json'), 'utf8'),
    ) as {
      hooks: Record<
        string,
        Array<{ matcher: string; hooks: Array<{ args?: string[]; timeout?: number }> }>
      >;
    };

    const stopHooks = hooksJson.hooks.Stop;
    const persistentModeHook = stopHooks
      .flatMap((group) => group.hooks)
      .find((hook) => hook.args?.[1]?.includes('persistent-mode.mjs'));

    expect(persistentModeHook).toBeDefined();
    expect(persistentModeHook?.timeout).toBeDefined();

    // Minimum timeout for two sequential 2-second Jev requests + processing
    // DEFAULT_TIMEOUT_MS = 2000ms per request
    // Two requests = 4000ms
    // Processing overhead = ~1000ms
    // Required minimum = 5000ms, but we add buffer for slow networks
    const MIN_TIMEOUT_SECONDS = 15; // 15 seconds

    expect(persistentModeHook?.timeout).toBeGreaterThanOrEqual(MIN_TIMEOUT_SECONDS);
  });

  it('verifies the hook contains both Jev request functions', () => {
    const hookScript = readFileSync(
      join(process.cwd(), 'scripts', 'persistent-mode.mjs'),
      'utf8',
    );

    // Verify the script has both Jev request functions
    expect(hookScript).toContain('recordLoopContinuationShadow');
    expect(hookScript).toContain('recordLearnerExtractionShadow');

    // Both should be called at least once
    const loopContinuationCount = (
      hookScript.match(/recordLoopContinuationShadow/g) || []
    ).length;
    const learnerExtractionCount = (
      hookScript.match(/recordLearnerExtractionShadow/g) || []
    ).length;

    expect(loopContinuationCount).toBeGreaterThan(0);
    expect(learnerExtractionCount).toBeGreaterThan(0);
  });
});
