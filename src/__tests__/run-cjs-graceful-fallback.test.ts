import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync, spawnSync } from 'child_process';

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
    const result = spawnSync(NODE, [RUN_CJS_PATH, target], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        ...env,
      },
      timeout: 10000,
      input: '{}',
    });

    return {
      status: result.status ?? (result.error || result.signal ? 1 : 0),
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  it('keeps UserPromptSubmit manifest timeouts aligned for prompt hooks', () => {
    const hooksJson = JSON.parse(readFileSync(join(__dirname, '..', '..', 'hooks', 'hooks.json'), 'utf-8'));
    const promptHooks = hooksJson.hooks.UserPromptSubmit.flatMap((entry: any) => entry.hooks);

    const keywordDetector = promptHooks.find((hook: any) => hook.command.includes('keyword-detector.mjs'));
    const skillInjector = promptHooks.find((hook: any) => hook.command.includes('skill-injector.mjs'));

    expect(keywordDetector?.timeout).toBe(10);
    expect(skillInjector?.timeout).toBe(15);

    const hooksDoc = readFileSync(join(__dirname, '..', '..', 'docs', 'HOOKS.md'), 'utf-8');
    const referenceDoc = readFileSync(join(__dirname, '..', '..', 'docs', 'REFERENCE.md'), 'utf-8');

    expect(hooksDoc).toContain('| `keyword-detector.mjs` | Detects magic keywords and invokes the corresponding skill | 10s |');
    expect(hooksDoc).toContain('| `skill-injector.mjs` | Injects skill prompts | 15s |');
    expect(referenceDoc).toContain('| **UserPromptSubmit**   | `keyword-detector.mjs`, `skill-injector.mjs`');
    expect(referenceDoc).toContain('| 10s, 15s');
  });

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
    const markerPath = join(tmpDir, 'hook-ok.txt');
    // Create a valid latest version with the target script
    const _latestDir = createFakeVersion('4.4.5', {
      'test-hook.cjs': `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(markerPath)}, "hook-ok"); process.exit(0);`,
    });

    // Target points to a non-existent old version
    const staleVersion = join(fakeCacheBase, '4.2.14');
    const staleTarget = join(staleVersion, 'scripts', 'test-hook.cjs');

    const result = runCjs(staleTarget, {
      CLAUDE_PLUGIN_ROOT: staleVersion,
    });

    // Should find the script in 4.4.5 and run it successfully
    expect(result.status).toBe(0);
    expect(readFileSync(markerPath, 'utf-8')).toBe('hook-ok');
  });

  it('falls back to latest version when multiple versions exist', () => {
    const markerPath = join(tmpDir, 'version-picked.txt');
    // Create two valid versions
    createFakeVersion('4.4.3', {
      'test-hook.cjs': `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(markerPath)}, "from-4.4.3"); process.exit(0);`,
    });
    createFakeVersion('4.4.5', {
      'test-hook.cjs': `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(markerPath)}, "from-4.4.5"); process.exit(0);`,
    });

    // Target points to a deleted old version
    const staleVersion = join(fakeCacheBase, '4.2.14');
    const staleTarget = join(staleVersion, 'scripts', 'test-hook.cjs');

    const result = runCjs(staleTarget, {
      CLAUDE_PLUGIN_ROOT: staleVersion,
    });

    // Should pick the highest version (4.4.5)
    expect(result.status).toBe(0);
    expect(readFileSync(markerPath, 'utf-8')).toBe('from-4.4.5');
  });

  it('resolves target through symlinked version directory', () => {
    const markerPath = join(tmpDir, 'symlink-hit.txt');
    // Create a real latest version
    const _latestDir = createFakeVersion('4.4.5', {
      'test-hook.cjs': `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(markerPath)}, "via-symlink"); process.exit(0);`,
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
    expect(readFileSync(markerPath, 'utf-8')).toBe('via-symlink');
  });

  it('runs target normally when path is valid (fast path)', () => {
    const markerPath = join(tmpDir, 'direct-hit.txt');
    const versionDir = createFakeVersion('4.4.5', {
      'test-hook.cjs': `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(markerPath)}, "direct-ok"); process.exit(0);`,
    });

    const target = join(versionDir, 'scripts', 'test-hook.cjs');

    const result = runCjs(target, {
      CLAUDE_PLUGIN_ROOT: versionDir,
    });

    expect(result.status).toBe(0);
    expect(readFileSync(markerPath, 'utf-8')).toBe('direct-ok');
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

  it('uses an inner timeout below the hooks.json outer budget so wrapped hooks fail open with output', () => {
    const pluginRoot = join(tmpDir, 'plugin-root');
    const scriptsDir = join(pluginRoot, 'scripts');
    const hooksDir = join(pluginRoot, 'hooks');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(hooksDir, { recursive: true });

    const slowTarget = join(scriptsDir, 'slow-stop-hook.cjs');
    writeFileSync(
      slowTarget,
      'setTimeout(() => { process.stdout.write("slow-stop-done\\n"); process.exit(0); }, 3000);',
    );
    writeFileSync(
      join(hooksDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/slow-stop-hook.cjs',
                  timeout: 2,
                },
              ],
            },
          ],
        },
      }, null, 2),
    );

    const startedAt = Date.now();
    const result = runCjs(slowTarget, {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('slow-stop-done');
    expect(result.stderr).toContain('[run.cjs] Hook slow-stop-hook.cjs timed out after 1500ms; exiting fail-open.');
    expect(result.stderr).not.toContain('timed out after 2000ms');
    expect(elapsedMs).toBeLessThan(2000);
  });
});
