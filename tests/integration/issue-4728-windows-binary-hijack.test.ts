/**
 * Test: issue #4728 - Windows where command security fix
 *
 * Verifies that the fix for the Windows `where` command security vulnerability is in place.
 * On Windows, `where` searches the current directory before PATH, allowing binary hijacking.
 * The fix adds $PATH: prefix to restrict search to PATH only.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

describe('issue #4728: Windows where command security fix', () => {
  const sourceFile = readFileSync(
    join(__dirname, '..', '..', 'src', 'team', 'model-contract.ts'),
    'utf-8'
  );

  it('should contain $PATH: prefix fix for Windows where search', () => {
    expect(sourceFile.includes('$PATH:${binary}')).toBe(true);
  });

  it('should use searchTarget variable with Windows platform check', () => {
    expect(sourceFile.includes("const searchTarget = process.platform === 'win32'")).toBe(true);
  });

  it('should reference issue #4728 in security comment', () => {
    expect(sourceFile.includes('#4728')).toBe(true);
  });

  it('should pass searchTarget to spawnSync in both functions', () => {
    // Verify searchTarget is used with spawnSync
    expect(sourceFile.includes('spawnSync(resolver, [searchTarget]')).toBe(true);
    expect(sourceFile.includes('spawnSync(finder, [searchTarget]')).toBe(true);
  });
});
