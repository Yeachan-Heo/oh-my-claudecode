import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const RUN_CJS_PATH = join(__dirname, '..', '..', 'scripts', 'run.cjs');
const NODE = process.execPath;

/**
 * Regression tests for run.cjs graceful fallback when CLAUDE_PLUGIN_ROOT
 * points to a stale/deleted/broken plugin cache directory.
 *
 * See: https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1007
 */
describe('run.cjs — graceful fallback for stale plugin paths', () => {
  let tmpDir: string;
  let fakeCacheBase: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omc-run-cjs-test-'));
    fakeCacheBase = join(tmpDir, 'plugins', 'cache', 'omc', 'oh-my-claudecode');
    mkdirSync(fakeCacheBase, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createFakeVersion(version: string, scripts: Record<string, string> = {}) {
    const versionDir = join(fakeCacheBase, version);
    const scriptsDir = join(versionDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    for (const [name, content] of Object.entries(scripts)) {
      writeFileSync(join(scriptsDir, name), content);
    }
    return versionDir;
  }

  function runCjs(target: string, env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(NODE, [RUN_CJS_PATH, target], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          ...env,
        },
        timeout: 10000,
        input: '{}',
      });
      return { status: 0, stdout: stdout || '', stderr: '' };
    } catch (err: any) {
      return {
        status: err.status ?? 1,
        stdout: err.stdout || '',
        stderr: err.stderr || '',
      };
    }
  }

  it('exits 0 when no target argument is provided', () => {
    try {
      execFileSync(NODE, [RUN_CJS_PATH], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      // If it exits 0, this succeeds
    } catch (err: any) {
      // Should not throw — exit 0 expected
      expect(err.status).toBe(0);
    }
  });

  it('exits 0 when target script does not exist (stale CLAUDE_PLUGIN_ROOT)', () => {
    const staleVersion = join(fakeCacheBase, '4.2.14');
    const staleTarget = join(staleVersion, 'scripts', 'persistent-mode.cjs');

    // Do NOT create the version directory — simulates deleted cache
    const result = runCjs(staleTarget, {
      CLAUDE_PLUGIN_ROOT: staleVersion,
    });

    // Must exit 0, not propagate MODULE_NOT_FOUND
    expect(result.status).toBe(0);
  });

  it('falls back to latest version when target version is missing', () => {
    // Create a valid latest version with the target script
    const latestDir = createFakeVersion('4.4.5', {
      'test-hook.cjs': '#!/usr/bin/env node\nconsole.log("hook-ok"); process.exit(0);',
    });

    // Target points to a non-existent old version
    const staleVersion = join(fakeCacheBase, '4.2.14');
    const staleTarget = join(staleVersion, 'scripts', 'test-hook.cjs');

    const result = runCjs(staleTarget, {
      CLAUDE_PLUGIN_ROOT: staleVersion,
    });

    // Should find the script in 4.4.5 and run it successfully
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('hook-ok');
  });

  it('falls back to latest version when multiple versions exist', () => {
    // Create two valid versions
    createFakeVersion('4.4.3', {
      'test-hook.cjs': '#!/usr/bin/env node\nconsole.log("from-4.4.3"); process.exit(0);',
    });
    createFakeVersion('4.4.5', {
      'test-hook.cjs': '#!/usr/bin/env node\nconsole.log("from-4.4.5"); process.exit(0);',
    });

    // Target points to a deleted old version
    const staleVersion = join(fakeCacheBase, '4.2.14');
    const staleTarget = join(staleVersion, 'scripts', 'test-hook.cjs');

    const result = runCjs(staleTarget, {
      CLAUDE_PLUGIN_ROOT: staleVersion,
    });

    // Should pick the highest version (4.4.5)
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('from-4.4.5');
  });

  it('resolves target through symlinked version directory', () => {
    // Create a real latest version
    const latestDir = createFakeVersion('4.4.5', {
      'test-hook.cjs': '#!/usr/bin/env node\nconsole.log("via-symlink"); process.exit(0);',
    });

    // Create a symlink from old version to latest
    const symlinkVersion = join(fakeCacheBase, '4.4.3');
    symlinkSync('4.4.5', symlinkVersion);

    // Target uses the symlinked version
    const target = join(symlinkVersion, 'scripts', 'test-hook.cjs');

    const result = runCjs(target, {
      CLAUDE_PLUGIN_ROOT: symlinkVersion,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('via-symlink');
  });

  it('runs target normally when path is valid (fast path)', () => {
    const versionDir = createFakeVersion('4.4.5', {
      'test-hook.cjs': '#!/usr/bin/env node\nconsole.log("direct-ok"); process.exit(0);',
    });

    const target = join(versionDir, 'scripts', 'test-hook.cjs');

    const result = runCjs(target, {
      CLAUDE_PLUGIN_ROOT: versionDir,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('direct-ok');
  });

  it('exits 0 when no CLAUDE_PLUGIN_ROOT is set and target is missing', () => {
    const result = runCjs('/nonexistent/path/to/hook.mjs', {
      CLAUDE_PLUGIN_ROOT: '',
    });

    expect(result.status).toBe(0);
  });

  it('exits 0 when cache base has no valid version directories', () => {
    const staleVersion = join(fakeCacheBase, '4.2.14');
    const staleTarget = join(staleVersion, 'scripts', 'test-hook.cjs');

    // Cache base exists but has no version directories
    const result = runCjs(staleTarget, {
      CLAUDE_PLUGIN_ROOT: staleVersion,
    });

    expect(result.status).toBe(0);
  });

  it('exits 0 when fallback versions exist but lack the specific script', () => {
    // Create a version that does NOT have the target script
    createFakeVersion('4.4.5', {
      'other-hook.cjs': '#!/usr/bin/env node\nprocess.exit(0);',
    });

    const staleVersion = join(fakeCacheBase, '4.2.14');
    const staleTarget = join(staleVersion, 'scripts', 'test-hook.cjs');

    const result = runCjs(staleTarget, {
      CLAUDE_PLUGIN_ROOT: staleVersion,
    });

    // No version has test-hook.cjs, so exit 0 gracefully
    expect(result.status).toBe(0);
  });
});
