/**
 * Per-test file setup for vitest to prevent pollution of checkout .omc/
 * 
 * This setup is run for each test file (via setupFiles in vitest.config.ts).
 * It does NOT force OMC_STATE_DIR globally (that breaks fixture-based tests).
 * Instead, it provides helper functions for tests that need isolated state.
 *
 * Tests that need isolated OMC state can call createIsolatedOmcStateDir() in their setup.
 * Fixture-based tests like session-start-precompact-restore use their own .omc/ paths
 * and do NOT use OMC_STATE_DIR (finding P1).
 */

import { mkdtempSync, realpathSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Store original OMC_STATE_DIR before any per-test setup modifies it
const savedOMC_STATE_DIR = process.env.OMC_STATE_DIR;

// Capture original home before setup modified it (finding P5)
// This is used by the guard test to validate the real home wasn't polluted
const originalHome = process.env.__VITEST_ORIG_HOME || homedir();
process.env.__VITEST_ORIG_HOME = originalHome;

// Use the shared state root if available for tests that opt-in to isolation (finding P4)
const stateRoot = process.env.__VITEST_STATE_ROOT || tmpdir();

/**
 * Helper for tests that need isolated OMC state.
 * Call this in your test's beforeAll() to create an isolated state dir.
 * Example:
 *   beforeAll(() => {
 *     const stateDir = createIsolatedOmcStateDir();
 *     process.env.OMC_STATE_DIR = stateDir;
 *   });
 */
export function createIsolatedOmcStateDir(): string {
  const testOmcStateDir = realpathSync.native(mkdtempSync(join(stateRoot, 'vitest-omc-state-')));
  return testOmcStateDir;
}

/**
 * Helper to clear worktree-paths cache when OMC_STATE_DIR changes.
 * Call this after changing OMC_STATE_DIR in your test.
 */
export function clearOmcPathsCache(): void {
  try {
    const mod = require('./src/lib/worktree-paths.js');
    if (typeof mod.clearWorktreeCache === 'function') {
      mod.clearWorktreeCache();
    }
  } catch {
    // Module might not be loaded yet, that's fine
  }
}

/**
 * Restore original OMC_STATE_DIR (for tests that temporarily override it).
 */
export function restoreOriginalOmcStateDir(): void {
  if (savedOMC_STATE_DIR === undefined) {
    delete process.env.OMC_STATE_DIR;
  } else {
    process.env.OMC_STATE_DIR = savedOMC_STATE_DIR;
  }
  clearOmcPathsCache();
}
