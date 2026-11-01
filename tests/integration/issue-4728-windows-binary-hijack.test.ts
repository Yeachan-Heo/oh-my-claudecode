/**
 * Test: issue #4728 - Windows binary hijack via cwd `where` search
 *
 * On Windows, the `where` command searches the current directory before PATH.
 * A malicious binary planted in cwd can hijack CLI resolution. The fix adds
 * the $PATH: prefix to the binary name when calling `where` on Windows.
 *
 * This test verifies the fix is in place by checking the source code.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');

describe('issue #4728: Windows binary hijack via cwd `where` search', () => {
  it('should use $PATH: prefix in resolveBinaryPath on Windows', () => {
    const sourceFile = readFileSync(
      join(REPO_ROOT, 'src/team/model-contract.ts'),
      'utf-8'
    );

    // Verify searchTarget is used to prefix with $PATH: on Windows
    expect(sourceFile).toMatch(/searchTarget.*win32.*PATH/);
    
    // Verify the exact pattern for the Windows check
    expect(sourceFile).toMatch(
      /const searchTarget = process\.platform === 'win32' \? `\$PATH/
    );
  });

  it('should use $PATH: prefix in resolveCliBinaryPath on Windows', () => {
    const sourceFile = readFileSync(
      join(REPO_ROOT, 'src/team/model-contract.ts'),
      'utf-8'
    );

    // Verify both functions have the searchTarget pattern
    const functionCount = (sourceFile.match(/const searchTarget = process\.platform === 'win32'/g) || []).length;
    expect(functionCount).toBeGreaterThanOrEqual(2);
  });

  it('should have security comments referencing #4728', () => {
    const sourceFile = readFileSync(
      join(REPO_ROOT, 'src/team/model-contract.ts'),
      'utf-8'
    );

    // Verify the security fix comment is present
    expect(sourceFile).toMatch(
      /#4728|security.*4728/i
    );
  });

  it('should pass $PATH: prefixed search to spawnSync in both functions', () => {
    const sourceFile = readFileSync(
      join(REPO_ROOT, 'src/team/model-contract.ts'),
      'utf-8'
    );

    // Verify searchTarget is passed to spawnSync calls
    // Find all spawnSync calls with searchTarget
    const spawnSyncWithSearchTarget = (sourceFile.match(/spawnSync\s*\([^,]+,\s*\[\s*searchTarget\s*\]/g) || []).length;
    expect(spawnSyncWithSearchTarget).toBeGreaterThanOrEqual(2);
  });
});
