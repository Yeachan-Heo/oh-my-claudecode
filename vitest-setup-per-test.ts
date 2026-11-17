/**
 * Per-test file setup for vitest to prevent pollution of checkout .omc/
 * 
 * This setup is run for each test file (via setupFiles in vitest.config.ts).
 * It creates a temp directory for each test file and sets OMC_STATE_DIR to point
 * to a temp location, ensuring that state is not written to the checkout's .omc/.
 */

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Create a unique temp directory for this test file's OMC state
const testOmcStateDir = mkdtempSync(join(tmpdir(), 'vitest-omc-state-'));
process.env.OMC_STATE_DIR = testOmcStateDir;

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
