/**
 * Global test setup for vitest to prevent pollution of real home and checkout .omc/
 * 
 * This setup creates isolated temporary directories for:
 * - HOME / USERPROFILE (user home directory)
 * - CLAUDE_CONFIG_DIR (Claude config directory)
 *
 * Tests run with these env vars pointing to temp dirs instead of real locations,
 * preventing state files from being written to ~/.omc/ or ~/.claude/
 *
 * For checkout .omc/ isolation, see setupFiles which runs per-test-file.
 */

import { mkdtempSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** Temp directories created for this test run */
const tempDirs: string[] = [];

/**
 * Setup function called once before any tests run.
 * Creates temp directories and updates environment variables.
 */
export async function setup() {
  // Create temp HOME directory to prevent pollution of ~/.omc
  // (getOmcRoot() falls back to homedir()/.omc when in a non-git directory)
  const tempHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'vitest-home-')));
  tempDirs.push(tempHome);
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  // Note: We do NOT override CLAUDE_CONFIG_DIR here because:
  // 1. The issue is about ~/.omc pollution, not ~/.claude pollution
  // 2. Overriding it breaks tests that check for specific path formats
  // 3. Per-test setupFiles uses OMC_STATE_DIR to isolate state storage

  // Clear any inherited OMC_* environment variables to ensure clean state per test run
  const omcKeys = Object.keys(process.env).filter(k => k.startsWith('OMC_'));
  for (const key of omcKeys) {
    delete process.env[key];
  }

  console.log(`[vitest-setup] Isolated test environment:`);
  console.log(`  HOME: ${process.env.HOME}`);

  return async () => {
    // Cleanup function called after all tests complete
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[vitest-setup] Failed to clean up ${dir}: ${err}`);
      }
    }
  };
}
