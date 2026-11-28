/**
 * Global test setup for vitest to prevent pollution of real home and checkout .omc/
 * 
 * This setup creates isolated temporary directories for:
 * - HOME / USERPROFILE (user home directory)
 * - Temp state dir for per-test OMC_STATE_DIR isolation
 *
 * Tests run with these env vars pointing to temp dirs instead of real locations,
 * preventing state files from being written to ~/.omc/ or ~/.claude/
 *
 * For checkout .omc/ isolation, see setupFiles which runs per-test-file.
 */

import { mkdtempSync, rmSync, realpathSync, execSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** Temp directories created for this test run */
const tempDirs: string[] = [];

/** Store original HOME before overriding it */
let originalHome: string | undefined;

/** Store the temp root for per-test state dirs */
let tempStateRoot: string | undefined;

/**
 * Setup function called once before any tests run.
 * Creates temp directories and updates environment variables.
 */
export async function setup() {
  // Capture original HOME before overriding it
  originalHome = process.env.HOME || process.env.USERPROFILE;
  // Store original home in an env var so per-test setup can access it
  process.env.__VITEST_ORIG_HOME = originalHome;
  
  // Create temp HOME directory to prevent pollution of ~/.omc
  // (getOmcRoot() falls back to homedir()/.omc when in a non-git directory)
  const tempHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'vitest-home-')));
  tempDirs.push(tempHome);
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  // Create a shared temp root for per-test state directories
  tempStateRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'vitest-omc-state-root-')));
  tempDirs.push(tempStateRoot);
  // Store path for per-test setup to use
  process.env.__VITEST_STATE_ROOT = tempStateRoot;

  // Preserve CI test-selection variables
  const ciVars = {
    OMC_PRECOMPACT_DIST_INTERLEAVINGS: process.env.OMC_PRECOMPACT_DIST_INTERLEAVINGS,
  };

  // Clear any other inherited OMC_* environment variables to ensure clean state
  const omcKeys = Object.keys(process.env).filter(k => k.startsWith('OMC_'));
  for (const key of omcKeys) {
    if (!(key in ciVars)) {
      delete process.env[key];
    }
  }

  // Restore preserved CI variables
  for (const [key, value] of Object.entries(ciVars)) {
    if (value !== undefined) {
      process.env[key] = value as string;
    }
  }

  console.log(`[vitest-setup] Isolated test environment:`);
  console.log(`  HOME: ${process.env.HOME} (original: ${originalHome})`);
  console.log(`  State root: ${tempStateRoot}`);
  if (process.env.OMC_PRECOMPACT_DIST_INTERLEAVINGS) {
    console.log(`  Preserved CI var: OMC_PRECOMPACT_DIST_INTERLEAVINGS`);
  }

  return async () => {
    // Teardown function called after all tests complete
    // Verify no pollution of real home or checkout before cleanup
    const checkoutRoot = process.cwd();
    
    // Check git status for tracked file changes
    try {
      const gitStatus = execSync('git status --porcelain -- dist bridge .omc', {
        cwd: checkoutRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (gitStatus.trim()) {
        throw new Error(`Tests modified tracked files:\n${gitStatus}`);
      }
    } catch (err) {
      if (err instanceof Error && !err.message.includes('modified tracked files')) {
        // git command itself failed, which is acceptable (e.g., not a git repo)
      } else {
        throw err;
      }
    }
    
    // Verify HOME is isolated (separated from original home)
    if (originalHome) {
      if (process.env.HOME === originalHome) {
        throw new Error(`HOME was not properly isolated; it still points to original home`);
      }
    }
    
    // Clean up all temp dirs
    if (tempStateRoot) {
      try {
        rmSync(tempStateRoot, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[vitest-setup] Failed to clean up state root ${tempStateRoot}: ${err}`);
      }
    }
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[vitest-setup] Failed to clean up ${dir}: ${err}`);
      }
    }
  };
}
