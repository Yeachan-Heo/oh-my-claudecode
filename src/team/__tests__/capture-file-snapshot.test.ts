import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { captureFileSnapshot } from '../mcp-team-bridge.js';

/**
 * Regression tests for issue #871:
 * captureFileSnapshot() used require('child_process') inside an ESM module,
 * which throws "require is not defined" when permissionEnforcement is enabled.
 *
 * Fix: use the top-level ESM import instead.
 */
describe('captureFileSnapshot (ESM regression - issue #871)', () => {
  it('does not throw "require is not defined" when called in ESM context', () => {
    // This would throw "require is not defined" before the fix.
    // Any directory works — non-git dirs simply return an empty set.
    const dir = tmpdir();
    expect(() => captureFileSnapshot(dir)).not.toThrow();
  });

  it('returns a Set', () => {
    const result = captureFileSnapshot(tmpdir());
    expect(result).toBeInstanceOf(Set);
  });

  it('returns an empty set for a non-git directory', () => {
    const nonGit = join(tmpdir(), `__non_git_${Date.now()}__`);
    mkdirSync(nonGit, { recursive: true });
    try {
      const result = captureFileSnapshot(nonGit);
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('returns file paths as strings when run inside a git repo', () => {
    // Run against the project root which is a real git repo
    const projectRoot = join(import.meta.dirname, '../../../../');
    const result = captureFileSnapshot(projectRoot);
    expect(result).toBeInstanceOf(Set);
    // Every entry must be a non-empty string
    for (const entry of result) {
      expect(typeof entry).toBe('string');
      expect(entry.length).toBeGreaterThan(0);
    }
  });
});
