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

import { mkdtempSync, rmSync, realpathSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

/** Temp directories created for this test run */
const tempDirs: string[] = [];

/** Store original HOME before overriding it */
let originalHome: string | undefined;

/** Store the temp root for per-test state dirs */
let tempStateRoot: string | undefined;

/** Pre-test artifact baselines for detecting changes */
const artifactBaselines: Map<string, Map<string, string>> = new Map();

// Make baselines globally accessible to guard test
declare global {
  var __VITEST_ARTIFACT_BASELINES: Map<string, Map<string, string>>;
}
globalThis.__VITEST_ARTIFACT_BASELINES = artifactBaselines;

/**
 * Hash a file's content for comparison
 */
function hashFile(filePath: string): string {
  try {
    const content = readFileSync(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return 'ERROR';
  }
}

/**
 * Snapshot artifact directory state before tests
 */
function snapshotArtifacts(label: string, dirPath: string): void {
  const hashes = new Map<string, string>();
  try {
    const walkDir = (dir: string, prefix = ''): void => {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walkDir(fullPath, relPath);
          } else {
            hashes.set(relPath, hashFile(fullPath));
          }
        }
      } catch {
        // Ignore errors (dir might not exist)
      }
    };
    walkDir(dirPath);
  } catch {
    // Ignore errors
  }
  if (hashes.size > 0) {
    artifactBaselines.set(label, hashes);
  }
}

/**
 * Setup function called once before any tests run.
 * Creates temp directories and updates environment variables.
 */
export async function setup() {
  // Capture original HOME before overriding it (finding P5)
  originalHome = process.env.HOME || process.env.USERPROFILE;
  // Store original home in an env var so per-test setup and guard test can access it
  process.env.__VITEST_ORIG_HOME = originalHome;
  
  // Create temp HOME directory to prevent pollution of ~/.omc
  // (getOmcRoot() falls back to homedir()/.omc when in a non-git directory)
  const tempHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'vitest-home-')));
  tempDirs.push(tempHome);
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  // Create a shared temp root for per-test state directories (finding P4)
  tempStateRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'vitest-omc-state-root-')));
  tempDirs.push(tempStateRoot);
  // Store path for per-test setup to use
  process.env.__VITEST_STATE_ROOT = tempStateRoot;

  // Preserve CI test-selection variables (finding P6)
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

  // Snapshot artifact baselines before tests run (findings P2, P7)
  const checkoutRoot = process.cwd();
  snapshotArtifacts('checkout-.omc', join(checkoutRoot, '.omc'));
  if (originalHome) {
    snapshotArtifacts('home-.omc', join(originalHome, '.omc'));
  }
  snapshotArtifacts('dist', join(checkoutRoot, 'dist'));
  snapshotArtifacts('bridge', join(checkoutRoot, 'bridge'));

  console.log(`[vitest-setup] Isolated test environment:`);
  console.log(`  HOME: ${process.env.HOME} (original: ${originalHome})`);
  console.log(`  State root: ${tempStateRoot}`);
  if (process.env.OMC_PRECOMPACT_DIST_INTERLEAVINGS) {
    console.log(`  Preserved CI var: OMC_PRECOMPACT_DIST_INTERLEAVINGS`);
  }

  return async () => {
    // Cleanup function called after all tests complete
    // Clean up all temp dirs including per-test state dirs
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
