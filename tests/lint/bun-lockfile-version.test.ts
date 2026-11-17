/**
 * Lint: Verify that bun.lock lockfileVersion is compatible with Bun 1.3.14.
 *
 * Issue #5091: Bun 1.3.14 (used by Claude Code 2.1.326) rejects lockfileVersion 2.
 * This test asserts that the committed bun.lock uses lockfileVersion 1 or lower
 * so it can be read by both Bun 1.3.x and Bun 1.4.x without UnknownLockfileVersion error.
 *
 * The test fails with a clear mutation proof: if lockfileVersion is increased back to 2,
 * this test will catch it and prevent regression.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '../..');
const BUN_LOCK = join(REPO_ROOT, 'bun.lock');

describe('bun.lock lockfileVersion compatibility', () => {
  it('should have lockfileVersion <= 1 for Bun 1.3.x compatibility', () => {
    const bunLockContent = readFileSync(BUN_LOCK, 'utf-8');
    // Extract lockfileVersion from the JSON (which may have trailing commas)
    const versionMatch = bunLockContent.match(/"lockfileVersion"\s*:\s*(\d+)/);
    expect(versionMatch).toBeTruthy();
    const lockfileVersion = parseInt(versionMatch![1], 10);

    expect(lockfileVersion).toBeDefined();
    expect(typeof lockfileVersion).toBe('number');
    expect(lockfileVersion).toBeLessThanOrEqual(1);
  });
});
