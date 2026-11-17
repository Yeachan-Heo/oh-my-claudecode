/**
 * Regression tests for run-gc.ts findings
 * Tests for P1 finding: Hold run ownership throughout GC deletion
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

describe('run-gc.ts P1 findings', () => {
  it('P1 (line 563): uses atomic quarantine to hold run ownership during deletion', () => {
    // Finding: With deletion enabled, another process can acquire FileOwnershipFence
    // after leaseOf() observes the old owner but before removeTree() executes.
    // GC never acquires ownership itself, so it can delete a newly resumed run's
    // lock, journal, and projection while its owner is alive.
    //
    // Fix: Use atomic quarantine - rename the directory to a quarantine location
    // before deletion, so any new process acquiring ownership gets a fresh directory.

    const sourceFile = readFileSync(
      join(__dirname, '../../src/graph/runtime/run-gc.ts'),
      'utf8'
    );

    // Verify renameSync import exists
    const importSection = sourceFile.substring(0, sourceFile.indexOf('export const GC_SWITCH_ENV'));
    expect(importSection).toContain('renameSync');
    expect(importSection).toContain("from \"node:fs\"");

    // Verify the QUARANTINE_PREFIX constant is defined
    expect(sourceFile).toContain('const QUARANTINE_PREFIX = ".deleted-"');

    // Verify the removeRun function uses the quarantine pattern
    const removeRunStart = sourceFile.indexOf('export function removeRun');
    expect(removeRunStart).toBeGreaterThan(-1);
    
    // Extract removeRun function (approximately 500 lines to ensure we get all logic)
    const removeRunSection = sourceFile.substring(
      removeRunStart,
      sourceFile.indexOf('function writeAll', removeRunStart)
    );

    // Check for key quarantine implementation patterns
    expect(removeRunSection).toContain('quarantineDir');
    expect(removeRunSection).toContain('.deleted-');
    expect(removeRunSection).toContain('renameSync(runDir, quarantineDir)');
    expect(removeRunSection).toContain('removeTree(quarantineDir)');
    
    // Verify the atomic quarantine order: rename happens before removeTree in main path
    // The function should have: check early return for quarantine -> lease check -> rename -> remove
    const quarantinePrefixCheck = removeRunSection.indexOf('id.startsWith(QUARANTINE_PREFIX)');
    const earlyReturn = removeRunSection.indexOf('removeTree(runDir);\n    return;', quarantinePrefixCheck);
    const mainRename = removeRunSection.indexOf('renameSync(runDir, quarantineDir)', earlyReturn);
    const mainRemove = removeRunSection.indexOf('removeTree(quarantineDir)', mainRename);
    
    expect(quarantinePrefixCheck).toBeGreaterThan(-1);
    expect(earlyReturn).toBeGreaterThan(quarantinePrefixCheck);
    expect(mainRename).toBeGreaterThan(earlyReturn);
    expect(mainRemove).toBeGreaterThan(mainRename);
  });
});
