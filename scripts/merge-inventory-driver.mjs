#!/usr/bin/env node
/**
 * Git merge driver for inventory-graph.json
 *
 * On merge conflicts in inventory-graph.json, regenerates the file instead of
 * attempting to resolve conflicts manually. This ensures that the baseline
 * always reflects the current state of the repository after a merge.
 *
 * Usage: git config merge.inventorygraph.driver 'node scripts/merge-inventory-driver.mjs %O %A %B %P'
 *
 * Arguments:
 *   %O = original version (common ancestor)
 *   %A = current version (ours)
 *   %B = other version (theirs)
 *   %P = output file path
 */

import { execSync, spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const generatorScript = join(repoRoot, 'scripts', 'generate-inventory-graph.mjs');
const outputFile = join(repoRoot, 'inventory', 'inventory-graph.json');

/**
 * Regenerate inventory-graph.json using the generator script.
 * Returns 0 on success, non-zero on failure.
 */
function regenerateInventory() {
  try {
    const result = spawnSync('node', [generatorScript, '--write'], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    
    if (result.status === 0) {
      console.log('[merge-inventory-driver] Successfully regenerated inventory-graph.json');
      return 0;
    } else {
      console.error('[merge-inventory-driver] Failed to regenerate inventory-graph.json');
      if (result.stderr) console.error(result.stderr);
      return 1;
    }
  } catch (error) {
    console.error('[merge-inventory-driver] Error regenerating inventory:', error.message);
    return 1;
  }
}

/**
 * Main entry point for merge driver.
 * Git passes conflicting versions as arguments; we regenerate instead.
 */
function main() {
  // Arguments from git are: %O %A %B %P
  // We don't actually use them; we just regenerate from current working tree
  const result = regenerateInventory();
  process.exit(result);
}

main();
