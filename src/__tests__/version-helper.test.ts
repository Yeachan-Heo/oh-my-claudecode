import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from 'fs';
import { getRuntimePackageVersion } from '../lib/version.js';

describe('getRuntimePackageVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns version from package.json', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ name: 'test-pkg', version: '1.2.3' }));
    expect(getRuntimePackageVersion()).toBe('1.2.3');
  });

  it('returns unknown when no package.json found', () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    expect(getRuntimePackageVersion()).toBe('unknown');
  });

  it('skips package.json without name field', () => {
    let callCount = 0;
    vi.mocked(readFileSync).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return JSON.stringify({ version: '0.0.0' }); // no name
      if (callCount === 2) return JSON.stringify({ name: 'real-pkg', version: '2.0.0' });
      throw new Error('ENOENT');
    });
    expect(getRuntimePackageVersion()).toBe('2.0.0');
  });

  it('handles invalid JSON gracefully', () => {
    vi.mocked(readFileSync).mockReturnValue('not-json{{{');
    // Should not throw, returns unknown
    expect(getRuntimePackageVersion()).toBe('unknown');
  });
});
