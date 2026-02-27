/**
 * Tests for src/utils/resolve-node.ts
 *
 * Covers resolveNodeBinary() priority logic and pickLatestVersion() helper.
 * Issue #892: Node.js not in PATH for nvm/fnm users causes hook errors.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';

// We test the pure helper directly without mocking the filesystem
import { pickLatestVersion } from '../utils/resolve-node.js';

// -------------------------------------------------------------------------
// pickLatestVersion — pure logic, no I/O
// -------------------------------------------------------------------------

describe('pickLatestVersion', () => {
  it('returns the highest semver from a list', () => {
    expect(pickLatestVersion(['v18.0.0', 'v20.11.0', 'v16.20.0'])).toBe('v20.11.0');
  });

  it('handles versions without leading v', () => {
    expect(pickLatestVersion(['18.0.0', '20.11.0', '16.20.0'])).toBe('20.11.0');
  });

  it('handles a single entry', () => {
    expect(pickLatestVersion(['v22.1.0'])).toBe('v22.1.0');
  });

  it('returns undefined for an empty array', () => {
    expect(pickLatestVersion([])).toBeUndefined();
  });

  it('filters out non-version entries', () => {
    expect(pickLatestVersion(['default', 'v18.0.0', 'system'])).toBe('v18.0.0');
  });

  it('compares patch versions correctly', () => {
    expect(pickLatestVersion(['v20.0.0', 'v20.0.1', 'v20.0.9'])).toBe('v20.0.9');
  });

  it('compares minor versions correctly', () => {
    expect(pickLatestVersion(['v20.1.0', 'v20.9.0', 'v20.10.0'])).toBe('v20.10.0');
  });
});

// -------------------------------------------------------------------------
// resolveNodeBinary — integration-style: the current process.execPath must
// be returned as the highest-priority result.
// -------------------------------------------------------------------------

describe('resolveNodeBinary', () => {
  it('returns process.execPath when it exists (priority 1)', async () => {
    // process.execPath is always set in any Node.js process, so this
    // test verifies the happy path without any mocking.
    const { resolveNodeBinary } = await import('../utils/resolve-node.js');
    const result = resolveNodeBinary();
    // Must be an absolute path (not bare 'node') in a real Node.js process
    expect(result).toBe(process.execPath);
    expect(result.length).toBeGreaterThan(4); // not empty / not just 'node'
  });

  it('returns a string (never throws)', async () => {
    const { resolveNodeBinary } = await import('../utils/resolve-node.js');
    expect(() => resolveNodeBinary()).not.toThrow();
    expect(typeof resolveNodeBinary()).toBe('string');
  });

  it('returned path points to an existing binary', async () => {
    const { resolveNodeBinary } = await import('../utils/resolve-node.js');
    const result = resolveNodeBinary();
    // When resolveNodeBinary returns a non-fallback path it must exist
    if (result !== 'node') {
      expect(existsSync(result)).toBe(true);
    }
  });
});
