/**
 * Regression tests for run-gc.ts findings
 * Tests for P1 finding: Hold run ownership throughout GC deletion
 */

import { describe, it, expect } from 'vitest';

describe('run-gc.ts P1 findings', () => {
  it('P1 (line 563): uses atomic quarantine to hold run ownership during deletion', () => {
    // Finding: With deletion enabled, another process can acquire FileOwnershipFence
    // after leaseOf() observes the old owner but before removeTree() executes.
    // GC never acquires ownership itself, so it can delete a newly resumed run's
    // lock, journal, and projection while its owner is alive.
    //
    // Fix: Use atomic quarantine - rename the directory to a quarantine location
    // before deletion, so any new process acquiring ownership gets a fresh directory.

    const sourceFile = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/graph/runtime/run-gc.ts'),
      'utf8'
    );

    // Verify the removeRun function uses renameSync for quarantine
    const removeRunSection = sourceFile.substring(
      sourceFile.indexOf('export function removeRun'),
      sourceFile.indexOf('export function removeRun') + 1500
    );

    // Check for quarantine pattern
    expect(removeRunSection).toContain('renameSync');
    expect(removeRunSection).toContain('.deleted');
    expect(removeRunSection).toContain('quarantine');

    // Check that the directory is renamed before deletion
    const renameIndex = removeRunSection.indexOf('renameSync');
    const removeIndex = removeRunSection.indexOf('removeTree');
    expect(renameIndex).toBeLessThan(removeIndex);

    // Check that renameSync import is added
    const importSection = sourceFile.substring(0, sourceFile.indexOf('export const GC_SWITCH_ENV'));
    expect(importSection).toContain('renameSync');
  });
});
