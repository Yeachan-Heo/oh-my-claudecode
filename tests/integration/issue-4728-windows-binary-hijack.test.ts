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

    // Verify the fix is present in resolveBinaryPath function
    // Look for the pattern that uses $PATH: prefix on Windows
    const resolveBinaryPathMatch = sourceFile.match(
      /function resolveBinaryPath.*?\{[^}]*\$PATH:\${binary}[^}]*\}/s
    );
    expect(resolveBinaryPathMatch).toBeTruthy(
      'resolveBinaryPath should use $PATH: prefix on Windows'
    );

    // Verify the searchTarget variable is used
    expect(sourceFile).toMatch(
      /const searchTarget = process\.platform === 'win32' \? `\$PATH:\${binary}` : binary/
    );
  });

  it('should use $PATH: prefix in resolveCliBinaryPath on Windows', () => {
    const sourceFile = readFileSync(
      join(REPO_ROOT, 'src/team/model-contract.ts'),
      'utf-8'
    );

    // Verify the fix is present in resolveCliBinaryPath function
    // Look for the pattern that uses $PATH: prefix on Windows
    const resolveCliMatch = sourceFile.match(
      /export function resolveCliBinaryPath.*?\{[^}]*\$PATH:\${binary}[^}]*\}/s
    );
    expect(resolveCliMatch).toBeTruthy(
      'resolveCliBinaryPath should use $PATH: prefix on Windows'
    );
  });

  it('should have security comments referencing #4728', () => {
    const sourceFile = readFileSync(
      join(REPO_ROOT, 'src/team/model-contract.ts'),
      'utf-8'
    );

    // Verify the security fix comment is present
    expect(sourceFile).toMatch(
      /security:\s*#4728|#4728.*security/i
    );
  });

  it('should pass $PATH: prefixed search to spawnSync', () => {
    const sourceFile = readFileSync(
      join(REPO_ROOT, 'src/team/model-contract.ts'),
      'utf-8'
    );

    // Find resolveBinaryPath function and verify it uses searchTarget in spawnSync
    const resolveBinaryPathSection = sourceFile.match(
      /function resolveBinaryPath.*?\{(.*?)\n\}/s
    )?.[1] ?? '';

    expect(resolveBinaryPathSection).toMatch(/searchTarget/);
    expect(resolveBinaryPathSection).toMatch(
      /spawnSync\s*\(\s*resolver\s*,\s*\[\s*searchTarget\s*\]/
    );
  });
});
