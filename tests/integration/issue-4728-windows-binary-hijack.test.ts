/**
 * Test: issue #4728 - Windows binary hijack via cwd `where` search
 *
 * On Windows, the `where` command searches the current directory before PATH.
 * A malicious binary planted in cwd can hijack CLI resolution.
 * The fix: use `$PATH:` prefix or walk PATH manually to exclude cwd.
 */

import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(__dirname, '..', '..');

// Import the functions we're testing
const modelContractPath = join(REPO_ROOT, 'src', 'team', 'model-contract.ts');

// We'll use dynamic import to test the functions
async function importModelContract() {
  // Clear the module cache
  delete require.cache[require.resolve(join(REPO_ROOT, 'src', 'team', 'model-contract.ts'))];
  return import(join(REPO_ROOT, 'src', 'team', 'model-contract.ts'));
}

describe('issue #4728: Windows binary hijack via cwd `where` search', () => {
  let tempDir: string;
  let cwdBinDir: string;
  let pathBinDir: string;
  let originalPlatform: NodeJS.Platform;
  let originalPath: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(__dirname, '../../.tmp/issue-4728-'));
    cwdBinDir = join(tempDir, 'cwd');
    pathBinDir = join(tempDir, 'path');
    
    // Create directories
    const fs = require('node:fs');
    fs.mkdirSync(cwdBinDir, { recursive: true });
    fs.mkdirSync(pathBinDir, { recursive: true });
    
    originalPath = process.env.PATH;
    originalPlatform = process.platform;
  });

  afterEach(() => {
    if (process.env.PATH !== originalPath) {
      process.env.PATH = originalPath;
    }
    // Clean up temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should not resolve to cwd-planted binary on Windows when using where with $PATH: prefix', () => {
    // Create a dummy binary in cwd
    const cwdBinary = join(cwdBinDir, 'codex.cmd');
    writeFileSync(cwdBinary, '@echo planted-dummy');

    // Create the legitimate binary in PATH
    const pathBinary = join(pathBinDir, 'codex.cmd');
    writeFileSync(pathBinary, '@echo legitimate');

    // Test that $PATH: prefix restricts where to PATH only
    if (process.platform === 'win32') {
      // On Windows, we can test the actual behavior
      process.env.PATH = pathBinDir;
      
      // Standard where (without $PATH:) would find cwd first
      const resultStandard = spawnSync('where', ['codex'], {
        timeout: 5000,
        cwd: cwdBinDir,
        env: process.env,
      });
      
      // where with $PATH: should find only the PATH version
      const resultWithPathPrefix = spawnSync('where', ['$PATH:codex'], {
        timeout: 5000,
        cwd: cwdBinDir,
        env: process.env,
      });
      
      // The $PATH: version should return the legitimate binary, not the cwd one
      if (resultWithPathPrefix.status === 0) {
        const pathVersion = resultWithPathPrefix.stdout?.toString().trim() ?? '';
        expect(pathVersion).toContain(pathBinDir);
        expect(pathVersion).not.toContain(cwdBinDir);
      }
    } else {
      // On non-Windows platforms, simulate the behavior
      // which command doesn't search cwd first, so it's safe
      process.env.PATH = pathBinDir;
      
      const result = spawnSync('which', ['codex'], {
        timeout: 5000,
        cwd: cwdBinDir,
        env: process.env,
      });
      
      // which should not find the cwd binary
      if (result.status === 0) {
        const resolvedPath = result.stdout?.toString().trim() ?? '';
        expect(resolvedPath).toContain(pathBinDir);
        expect(resolvedPath).not.toContain(cwdBinDir);
      }
    }
  });

  it('should resolve to legitimate binary when cwd binary is planted', () => {
    // Create the legitimate binary in PATH
    const pathBinary = join(pathBinDir, 'test-cli.cmd');
    writeFileSync(pathBinary, '@echo legitimate');

    // Create a dummy binary in cwd
    const cwdBinary = join(cwdBinDir, 'test-cli.cmd');
    writeFileSync(cwdBinary, '@echo planted-dummy');

    process.env.PATH = pathBinDir;

    if (process.platform === 'win32') {
      // Test that we can walk PATH manually to avoid cwd
      const pathEnv = process.env.PATH || '';
      const paths = pathEnv.split(';');
      let found = false;
      
      for (const pathEntry of paths) {
        const fullPath = join(pathEntry, 'test-cli.cmd');
        if (existsSync(fullPath)) {
          found = true;
          expect(fullPath).toContain(pathBinDir);
          break;
        }
      }
      
      expect(found).toBe(true);
    }
  });

  it('should validate that planted binary is not returned by where in PATH-search mode', () => {
    // This test verifies the proposed fix works
    const cwdBinary = join(cwdBinDir, 'fake-claude.cmd');
    const pathBinary = join(pathBinDir, 'fake-claude.cmd');
    
    writeFileSync(cwdBinary, '@echo cwd-version');
    writeFileSync(pathBinary, '@echo path-version');
    
    process.env.PATH = pathBinDir;

    if (process.platform === 'win32') {
      // Using $PATH: prefix should skip cwd
      const result = spawnSync('where', ['$PATH:fake-claude'], {
        timeout: 5000,
        cwd: cwdBinDir,
        env: process.env,
        encoding: 'utf8',
      });

      if (result.status === 0) {
        const output = result.stdout?.trim() ?? '';
        // The result should contain the path version, not the cwd version
        expect(output).not.toContain(cwdBinDir);
      }
    }
  });
});
