/**
 * Regression test for #5113: Ensure contained-fs.c compiles without unused variable warnings.
 * 
 * This test verifies that:
 * - The native module compiles with strict -Werror flags on all platforms
 * - No unused variable warnings are produced on platforms where variables are conditionally used
 * - The compilation succeeds with the exact flags used by build-contained-fs.mjs
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { findNodeHeaders } from '../../scripts/lib/find-node-headers.mjs';
import { homedir } from 'node:os';

describe('contained-fs compilation (#5113)', () => {
  // Use process.cwd() as root since tests are run from project root
  const root = process.cwd();
  const nativeSourcePath = resolve(root, 'native/contained-fs.c');
  const tempOutput = resolve('/tmp', `contained-fs-test-${Date.now()}.node`);

  // Helper to check if compilation prerequisites are available
  function getCompilationContext() {
    const sourceExists = existsSync(nativeSourcePath);
    if (!sourceExists) return { available: false, reason: 'native/contained-fs.c not found' };

    const headers = findNodeHeaders({
      argv: [],
      env: process.env,
      execPath: process.execPath,
      version: process.versions.node,
      homedir: homedir(),
      exists: existsSync,
    });

    if (!headers) return { available: false, reason: 'Node development headers not found' };

    const compiler = process.platform === 'darwin' ? 'clang' : 'cc';
    return { available: true, headers, compiler };
  }

  const ctx = getCompilationContext();

  it.skipIf(!ctx.available)('compiles with -Werror without unused variable warnings', () => {
    if (!ctx.available) return; // Should not reach here due to skipIf

    const { headers, compiler } = ctx;
    const args = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-I', headers];
    if (process.platform === 'darwin') {
      args.push(
        '-arch', process.arch === 'x64' ? 'x86_64' : process.arch,
        '-mmacosx-version-min=11.0',
        '-bundle',
        '-undefined', 'dynamic_lookup'
      );
    } else {
      args.push('-shared');
    }
    args.push(nativeSourcePath, '-o', tempOutput);

    // Attempt compilation
    const result = spawnSync(compiler, args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Check if compiler is available
    if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
      // Compiler not available - skip gracefully
      return;
    }

    // Assert successful compilation
    expect(result.status, `compilation failed with exit code ${result.status}: ${result.stderr}`).toBe(0);
    
    // Assert no unused variable warnings in stderr
    expect(result.stderr, 'compilation produced unused variable warnings').not.toMatch(/unused variable/i);
    expect(result.stderr, 'compilation produced errors').not.toMatch(/error:/i);
  });
});
