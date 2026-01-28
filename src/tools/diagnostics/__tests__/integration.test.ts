/**
 * Integration tests for directory diagnostics
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

// Mock fs before importing the module under test
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    realpathSync: vi.fn(actual.realpathSync),
  };
});

import * as fs from 'fs';
import { runDirectoryDiagnostics } from '../index.js';
import { getAllSupportedExtensions, invalidateExtensionCache } from '../lsp-aggregator.js';

describe('runDirectoryDiagnostics path validation', () => {
  beforeEach(() => {
    // Reset all mocks to their default implementation before each test
    vi.mocked(fs.realpathSync).mockRestore();
  });

  it('returns skipped strategy when realpathSync fails', async () => {
    // Create a valid temp directory
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-test-'));

    try {
      // Mock realpathSync to throw for this specific path
      vi.mocked(fs.realpathSync).mockImplementation((p: fs.PathLike) => {
        if (p === tmpDir || p.toString() === tmpDir) {
          throw new Error('Mock realpathSync failure');
        }
        // Call the real implementation for other paths
        return vi.importActual<typeof import('fs')>('fs').then(actual => actual.realpathSync(p));
      });

      const result = await runDirectoryDiagnostics(tmpDir);
      expect(result.strategy).toBe('skipped');
      expect(result.success).toBe(true);
      expect(result.errorCount).toBe(0);
      expect(result.summary).toContain('cannot resolve directory path');
    } finally {
      fs.rmdirSync(tmpDir);
    }
  });

  it('returns skipped strategy for non-existent directory', async () => {
    const result = await runDirectoryDiagnostics('/nonexistent/path/that/does/not/exist');
    expect(result.strategy).toBe('skipped');
    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.summary).toContain('does not exist');
  });
});

describe('invalidateExtensionCache', () => {
  it('clears the cached extensions so next call recomputes', () => {
    // First call populates the cache
    const extensions1 = getAllSupportedExtensions();
    expect(extensions1.length).toBeGreaterThan(0);
    // Invalidate
    invalidateExtensionCache();
    // Second call should still return the same result (recomputed from same data)
    const extensions2 = getAllSupportedExtensions();
    expect(extensions2).toEqual(extensions1);
  });
});
