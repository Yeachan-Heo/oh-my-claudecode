/**
 * Tests for ensureStdinSymlink (issue #2152)
 *
 * Verifies that the stdin.mjs symlink is correctly created and healed
 * when OMC upgrades to a new version. Uses safe replace strategy:
 * only removes old destination AFTER successfully creating new symlink.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, unlinkSync, symlinkSync, copyFileSync, readlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as fs from 'fs';

// We need to test the actual behavior, so we mock at the module level
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual as object,
  };
});

import { ensureStdinSymlink } from '../index.js';

describe('ensureStdinSymlink', () => {
  let pluginRoot: string;
  let homeDir: string;
  let hooksLibDir: string;
  let stdinSrcPath: string;

  beforeEach(() => {
    // Create a temporary plugin root with the templates structure
    pluginRoot = mkdtempSync(join(tmpdir(), 'omc-stdin-'));
    const templatesDir = join(pluginRoot, 'templates/hooks/lib');
    mkdirSync(templatesDir, { recursive: true });

    // Create a fake stdin.mjs in the source location
    stdinSrcPath = join(templatesDir, 'stdin.mjs');
    writeFileSync(stdinSrcPath, '// fake stdin.mjs content\n');

    // Create a fake home directory
    homeDir = mkdtempSync(join(tmpdir(), 'omc-home-'));
    hooksLibDir = join(homeDir, '.claude/hooks/lib');
  });

  afterEach(() => {
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Helper to mock os.homedir
  const withMockedHomedir = (mockHome: string, fn: () => void) => {
    const originalHomedir = require('os').homedir;
    require('os').homedir = () => mockHome;
    try {
      fn();
    } finally {
      require('os').homedir = originalHomedir;
    }
  };

  it('creates the destination directory if it does not exist', () => {
    withMockedHomedir(homeDir, () => {
      ensureStdinSymlink(pluginRoot);
      expect(existsSync(hooksLibDir)).toBe(true);
    });
  });

  it('creates a symlink from ~/.claude/hooks/lib/stdin.mjs to the plugin source', () => {
    withMockedHomedir(homeDir, () => {
      ensureStdinSymlink(pluginRoot);
      const stdinDst = join(hooksLibDir, 'stdin.mjs');
      expect(existsSync(stdinDst)).toBe(true);
      expect(lstatSync(stdinDst).isSymbolicLink()).toBe(true);
      expect(readlinkSync(stdinDst)).toBe(stdinSrcPath);
    });
  });

  it('heals an existing symlink that points to a different location', () => {
    withMockedHomedir(homeDir, () => {
      // Create the directory and a stale symlink pointing elsewhere
      mkdirSync(hooksLibDir, { recursive: true });
      const staleTarget = mkdtempSync(join(tmpdir(), 'stale-stdin-'));
      const staleFile = join(staleTarget, 'stdin.mjs');
      writeFileSync(staleFile, '// stale content\n');
      const stdinDst = join(hooksLibDir, 'stdin.mjs');
      symlinkSync(staleFile, stdinDst);

      // Run the healing function
      ensureStdinSymlink(pluginRoot);

      // The symlink should now point to the new source
      expect(readlinkSync(stdinDst)).toBe(stdinSrcPath);
    });
  });

  it('always copies when symlink creation fails (refresh outdated regular file)', () => {
    withMockedHomedir(homeDir, () => {
      // Create directory and a regular file (not symlink)
      mkdirSync(hooksLibDir, { recursive: true });
      const stdinDst = join(hooksLibDir, 'stdin.mjs');
      writeFileSync(stdinDst, '// existing stale file content\n');

      // Spy on symlinkSync and make it fail
      vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
        throw new Error('symlink not supported');
      });

      // Run the function - should update the stale file
      ensureStdinSymlink(pluginRoot);

      // File should be updated with fresh content from source
      expect(existsSync(stdinDst)).toBe(true);
      expect(readFileSync(stdinDst, 'utf-8')).toBe('// fake stdin.mjs content\n');
    });
  });

  it('falls back to copy when symlink is not supported', () => {
    withMockedHomedir(homeDir, () => {
      mkdirSync(hooksLibDir, { recursive: true });
      const stdinDst = join(hooksLibDir, 'stdin.mjs');

      // Spy on symlinkSync and make it fail
      vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
        throw new Error('symlink not supported');
      });

      ensureStdinSymlink(pluginRoot);

      // Should fall back to copy
      expect(existsSync(stdinDst)).toBe(true);
      expect(readFileSync(stdinDst, 'utf-8')).toBe('// fake stdin.mjs content\n');
    });
  });

  it('removes stale .tmp file before creating new symlink', () => {
    withMockedHomedir(homeDir, () => {
      mkdirSync(hooksLibDir, { recursive: true });
      const stdinDst = join(hooksLibDir, 'stdin.mjs');
      const tmpDst = stdinDst + '.tmp';

      // Create a stale .tmp file from a previous failed run
      writeFileSync(tmpDst, '// stale tmp content\n');

      // Run the function - should succeed despite stale tmp
      ensureStdinSymlink(pluginRoot);

      // Symlink should be created pointing to correct source
      expect(existsSync(stdinDst)).toBe(true);
      expect(lstatSync(stdinDst).isSymbolicLink()).toBe(true);
      expect(readlinkSync(stdinDst)).toBe(stdinSrcPath);

      // Old tmp should be gone
      expect(existsSync(tmpDst)).toBe(false);
    });
  });

  it('removes dangling symlink and copies when symlink creation fails', () => {
    withMockedHomedir(homeDir, () => {
      mkdirSync(hooksLibDir, { recursive: true });
      const stdinDst = join(hooksLibDir, 'stdin.mjs');

      // Create a dangling symlink (points to non-existent target)
      const danglingTarget = join(tmpdir(), 'non-existent-target');
      symlinkSync(danglingTarget, stdinDst);

      // Verify it's a dangling symlink
      expect(existsSync(stdinDst)).toBe(false); // existsSync returns false for dangling
      expect(lstatSync(stdinDst).isSymbolicLink()).toBe(true);

      // Spy on symlinkSync and make it fail
      vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
        throw new Error('symlink not supported');
      });

      ensureStdinSymlink(pluginRoot);

      // Should have removed dangling symlink and copied the file
      expect(existsSync(stdinDst)).toBe(true);
      expect(readFileSync(stdinDst, 'utf-8')).toBe('// fake stdin.mjs content\n');
    });
  });

  it('is idempotent — calling twice does not throw', () => {
    withMockedHomedir(homeDir, () => {
      ensureStdinSymlink(pluginRoot);
      expect(() => ensureStdinSymlink(pluginRoot)).not.toThrow();
    });
  });

  it('is a no-op when pluginRoot does not exist', () => {
    withMockedHomedir(homeDir, () => {
      expect(() =>
        ensureStdinSymlink(join(tmpdir(), 'nonexistent-plugin-root-xyz'))
      ).not.toThrow();
    });
  });

  it('is a no-op when stdin.mjs source does not exist', () => {
    withMockedHomedir(homeDir, () => {
      // Remove the source file
      unlinkSync(stdinSrcPath);

      // Should not throw and should not create anything
      expect(() => ensureStdinSymlink(pluginRoot)).not.toThrow();
      const stdinDst = join(hooksLibDir, 'stdin.mjs');
      expect(existsSync(stdinDst)).toBe(false);
    });
  });
});
