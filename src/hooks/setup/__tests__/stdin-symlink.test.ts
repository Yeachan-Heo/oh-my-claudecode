/**
 * Tests for ensureStdinSymlink (issue #2152)
 *
 * Verifies that the stdin.mjs symlink is correctly created and healed
 * when OMC upgrades to a new version. Uses safe replace strategy:
 * only removes old destination AFTER successfully creating new symlink.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, unlinkSync, symlinkSync, readlinkSync } from 'fs';
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
  let configDir: string;
  let hooksLibDir: string;
  let stdinSrcPath: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    // Create a temporary plugin root with the templates structure
    pluginRoot = mkdtempSync(join(tmpdir(), 'omc-stdin-'));
    const templatesDir = join(pluginRoot, 'templates/hooks/lib');
    mkdirSync(templatesDir, { recursive: true });

    // Create a fake stdin.mjs in the source location
    stdinSrcPath = join(templatesDir, 'stdin.mjs');
    writeFileSync(stdinSrcPath, '// fake stdin.mjs content\n');

    // Create a fake config directory and set CLAUDE_CONFIG_DIR env var
    configDir = mkdtempSync(join(tmpdir(), 'omc-config-'));
    hooksLibDir = join(configDir, 'hooks/lib');
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    if (originalConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    vi.restoreAllMocks();
  });

  it('creates the destination directory if it does not exist', () => {
    ensureStdinSymlink(pluginRoot);
    expect(existsSync(hooksLibDir)).toBe(true);
  });

  it('creates a symlink from hooks/lib/stdin.mjs to the plugin source', () => {
    ensureStdinSymlink(pluginRoot);
    const stdinDst = join(hooksLibDir, 'stdin.mjs');
    expect(existsSync(stdinDst)).toBe(true);
    expect(lstatSync(stdinDst).isSymbolicLink()).toBe(true);
    expect(readlinkSync(stdinDst)).toBe(stdinSrcPath);
  });

  it('heals an existing symlink that points to a different location', () => {
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

    rmSync(staleTarget, { recursive: true, force: true });
  });

  it('always copies when symlink creation fails (refresh outdated regular file)', () => {
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

  it('falls back to copy when symlink is not supported', () => {
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

  it('removes stale .tmp file before creating new symlink', () => {
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

  it('heals dangling symlink that points to non-existent target', () => {
    // Create the directory and a dangling symlink (symlink exists but target doesn't)
    mkdirSync(hooksLibDir, { recursive: true });
    const stdinDst = join(hooksLibDir, 'stdin.mjs');
    const danglingTarget = join(tmpdir(), 'this-does-not-exist');
    symlinkSync(danglingTarget, stdinDst);

    // Verify it's a dangling symlink (existsSync false but lstatSync shows symlink)
    expect(existsSync(stdinDst)).toBe(false);
    expect(lstatSync(stdinDst).isSymbolicLink()).toBe(true);

    // Run the healing function - should detect dangling and recreate
    ensureStdinSymlink(pluginRoot);

    // Should now be a valid symlink pointing to correct source
    expect(existsSync(stdinDst)).toBe(true);
    expect(lstatSync(stdinDst).isSymbolicLink()).toBe(true);
    expect(readlinkSync(stdinDst)).toBe(stdinSrcPath);
  });

  it('removes dangling symlink and copies when symlink creation fails', () => {
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

  it('is idempotent — calling twice does not throw', () => {
    ensureStdinSymlink(pluginRoot);
    expect(() => ensureStdinSymlink(pluginRoot)).not.toThrow();
  });

  it('is a no-op when pluginRoot does not exist', () => {
    expect(() =>
      ensureStdinSymlink(join(tmpdir(), 'nonexistent-plugin-root-xyz'))
    ).not.toThrow();
  });

  it('is a no-op when stdin.mjs source does not exist', () => {
    // Remove the source file
    unlinkSync(stdinSrcPath);

    // Should not throw and should not create anything
    expect(() => ensureStdinSymlink(pluginRoot)).not.toThrow();
    const stdinDst = join(hooksLibDir, 'stdin.mjs');
    expect(existsSync(stdinDst)).toBe(false);
  });

  it('uses CLAUDE_CONFIG_DIR when set', () => {
    // Set a custom config dir
    const customConfigDir = mkdtempSync(join(tmpdir(), 'omc-custom-config-'));
    const customHooksLib = join(customConfigDir, 'hooks/lib');
    process.env.CLAUDE_CONFIG_DIR = customConfigDir;

    try {
      ensureStdinSymlink(pluginRoot);
      const stdinDst = join(customHooksLib, 'stdin.mjs');
      expect(existsSync(stdinDst)).toBe(true);
      expect(readlinkSync(stdinDst)).toBe(stdinSrcPath);
    } finally {
      rmSync(customConfigDir, { recursive: true, force: true });
    }
  });
});
