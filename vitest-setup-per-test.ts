/**
 * Per-test file setup for vitest to prevent pollution of checkout .omc/
 * 
 * This setup is run for each test file (via setupFiles in vitest.config.ts).
 * It creates a temp directory for each test file and sets OMC_STATE_DIR to point
 * to a temp location, ensuring that state is not written to the checkout's .omc/.
 *
 * Tests can opt-out by setting VITEST_SKIP_OMC_ISOLATION=1 in their describe block
 * or as a test-level config (needed for fixture-based tests that verify specific paths).
 */

import { mkdtempSync, realpathSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Store original OMC_STATE_DIR in case a test wants to restore it
const savedOMC_STATE_DIR = process.env.OMC_STATE_DIR;

// Capture original home before setup modified it (finding P5)
// This is used by the guard test to validate the real home wasn't polluted
const originalHome = process.env.__VITEST_ORIG_HOME || homedir();
process.env.__VITEST_ORIG_HOME = originalHome;

// Use the shared state root if available, otherwise fall back to creating individual dirs (finding P4)
const stateRoot = process.env.__VITEST_STATE_ROOT || tmpdir();
const testOmcStateDir = realpathSync.native(mkdtempSync(join(stateRoot, 'vitest-omc-state-')));
process.env.OMC_STATE_DIR = testOmcStateDir;
process.env.__VITEST_CUR_STATE_DIR = testOmcStateDir;

// Import and clear the worktree-paths cache to ensure it uses the new OMC_STATE_DIR
// This must happen after setting the env var
try {
  const mod = require('./src/lib/worktree-paths.js');
  if (typeof mod.clearWorktreeCache === 'function') {
    mod.clearWorktreeCache();
  }
} catch {
  // Module might not be loaded yet, that's fine - it will use the env var when it is
}

// Export reset function for tests that need to opt-out of isolation
export function restoreLocalOmcState() {
  if (savedOMC_STATE_DIR === undefined) {
    delete process.env.OMC_STATE_DIR;
  } else {
    process.env.OMC_STATE_DIR = savedOMC_STATE_DIR;
  }
  try {
    const mod = require('./src/lib/worktree-paths.js');
    if (typeof mod.clearWorktreeCache === 'function') {
      mod.clearWorktreeCache();
    }
  } catch {
    // ignore
  }
}
