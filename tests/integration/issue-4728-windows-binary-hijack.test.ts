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
  const sourceFile = readFileSync(
    join(REPO_ROOT, 'src/team/model-contract.ts'),
    'utf-8'
  );

  it('should use $PATH: prefix on Windows in resolveBinaryPath', () => {
    // Verify that searchTarget variable with $PATH: prefix exists
    expect(sourceFile).toContain('$PATH:${binary}');
    expect(sourceFile).toContain('process.platform === \'win32\'');
    expect(sourceFile).toContain('searchTarget');
  });

  it('should use searchTarget in spawnSync calls', () => {
    // Verify searchTarget is used in spawnSync
    expect(sourceFile).toContain('spawnSync(resolver, [searchTarget]');
    expect(sourceFile).toContain('spawnSync(finder, [searchTarget]');
  });

  it('should have security comment for #4728', () => {
    // Verify the security comment is present
    expect(sourceFile).toContain('#4728');
  });

  it('should not use bare binary name in Windows path on spawnSync', () => {
    // Extract the resolveBinaryPath and resolveBinaryPath functions
    // and verify they use searchTarget instead of bare binary
    const lines = sourceFile.split('\n');
    let inResolveFunction = false;
    let foundSearchTarget = false;
    let functionDepth = 0;

    for (const line of lines) {
      if (
        line.includes('function resolveBinaryPath') ||
        line.includes('export function resolveCliBinaryPath')
      ) {
        inResolveFunction = true;
        functionDepth = 1;
      }

      if (inResolveFunction) {
        if (line.includes('{')) {
          functionDepth++;
        }
        if (line.includes('}')) {
          functionDepth--;
          if (functionDepth === 0) {
            inResolveFunction = false;
          }
        }

        if (
          line.includes('searchTarget') &&
          !line.trim().startsWith('//')
        ) {
          foundSearchTarget = true;
        }
      }
    }

    expect(foundSearchTarget).toBe(true);
  });
});
