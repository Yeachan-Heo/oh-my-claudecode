import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'fs';
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

  function runCjs(target: string, env: Record<string, string> = {}, args: string[] = []): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(NODE, [RUN_CJS_PATH, target, ...args], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        ...env,
      },
      timeout: 30000,
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

  it('uses prompt-scoped inner timeout cushions for UserPromptSubmit hooks', () => {
    const pluginRoot = join(tmpDir, 'prompt-plugin-root');
    const scriptsDir = join(pluginRoot, 'scripts');
    const hooksDir = join(pluginRoot, 'hooks');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(hooksDir, { recursive: true });

    const tenSecondTarget = join(scriptsDir, 'prompt-ten.cjs');
    const fifteenSecondTarget = join(scriptsDir, 'prompt-fifteen.cjs');
    writeFileSync(
      tenSecondTarget,
      'setTimeout(() => { process.stdout.write("prompt-ten-done\\n"); process.exit(0); }, 9000);',
    );
    writeFileSync(
      fifteenSecondTarget,
      'setTimeout(() => { process.stdout.write("prompt-fifteen-done\\n"); process.exit(0); }, 13000);',
    );
    writeFileSync(
      join(hooksDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/prompt-ten.cjs',
                  timeout: 10,
                },
                {
                  type: 'command',
                  command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/prompt-fifteen.cjs',
                  timeout: 15,
                },
              ],
            },
          ],
        },
      }, null, 2),
    );

    const tenStartedAt = Date.now();
    const tenResult = runCjs(tenSecondTarget, {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    });
    const tenElapsedMs = Date.now() - tenStartedAt;

    expect(tenResult.status).toBe(0);
    expect(tenResult.stdout).not.toContain('prompt-ten-done');
    expect(tenResult.stderr).toBe('');
    expect(tenElapsedMs).toBeGreaterThanOrEqual(7500);
    expect(tenElapsedMs).toBeLessThan(10000);

    const fifteenStartedAt = Date.now();
    const fifteenResult = runCjs(fifteenSecondTarget, {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    });
    const fifteenElapsedMs = Date.now() - fifteenStartedAt;

    expect(fifteenResult.status).toBe(0);
    expect(fifteenResult.stdout).not.toContain('prompt-fifteen-done');
    expect(fifteenResult.stderr).toBe('');
    expect(fifteenElapsedMs).toBeGreaterThanOrEqual(11500);
    expect(fifteenElapsedMs).toBeLessThan(15000);
  });

  it('keeps the existing 500ms inner timeout cushion for non-prompt hooks', () => {
    const pluginRoot = join(tmpDir, 'non-prompt-plugin-root');
    const scriptsDir = join(pluginRoot, 'scripts');
    const hooksDir = join(pluginRoot, 'hooks');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(hooksDir, { recursive: true });

    const slowTarget = join(scriptsDir, 'non-prompt-slow.cjs');
    writeFileSync(
      slowTarget,
      'setTimeout(() => { process.stdout.write("non-prompt-done\\n"); process.exit(0); }, 3000);',
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
                  command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/non-prompt-slow.cjs',
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
    expect(result.stdout).not.toContain('non-prompt-done');
    expect(result.stderr).toContain('[run.cjs] Hook non-prompt-slow.cjs timed out after 1500ms; exiting fail-open.');
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('keeps prompt hook timeout diagnostics quiet by default and visible in hook debug mode', () => {
    const pluginRoot = join(tmpDir, 'prompt-debug-plugin-root');
    const scriptsDir = join(pluginRoot, 'scripts');
    const hooksDir = join(pluginRoot, 'hooks');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(hooksDir, { recursive: true });

    const slowTarget = join(scriptsDir, 'prompt-debug-slow.cjs');
    writeFileSync(
      slowTarget,
      'setTimeout(() => { process.stdout.write("prompt-debug-done\\n"); process.exit(0); }, 3000);',
    );
    writeFileSync(
      join(hooksDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/prompt-debug-slow.cjs',
                  timeout: 1,
                },
              ],
            },
          ],
        },
      }, null, 2),
    );

    const quietResult = runCjs(slowTarget, {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    });
    const debugResult = runCjs(slowTarget, {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      OMC_DEBUG_HOOKS: '1',
    });

    expect(quietResult.status).toBe(0);
    expect(quietResult.stdout).not.toContain('prompt-debug-done');
    expect(quietResult.stderr).toBe('');
    expect(debugResult.status).toBe(0);
    expect(debugResult.stdout).not.toContain('prompt-debug-done');
    expect(debugResult.stderr).toContain('[run.cjs] Hook prompt-debug-slow.cjs timed out after 1ms; exiting fail-open.');
  });
});

describe('run.cjs trusted UserPromptSubmit Worker selection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omc-trusted-run-cjs-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTrustedPlugin(root: string, scripts: Record<string, string>, event = 'UserPromptSubmit', timeout = 10) {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'run.cjs'), '// plugin-root marker');
    for (const [name, contents] of Object.entries(scripts)) writeFileSync(join(root, 'scripts', name), contents);
    for (const expectedScript of ['keyword-detector.mjs', 'skill-injector.mjs']) {
      const expectedPath = join(root, 'scripts', expectedScript);
      if (!existsSync(expectedPath)) writeFileSync(expectedPath, 'process.exit(0);');
    }
    writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: {
        [event]: [{ matcher: '', hooks: Object.keys(scripts).map(name => ({
          type: 'command',
          command: `node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/${name}`,
          timeout,
        })) }],
      },
    }));
  }

  function run(target: string, env: Record<string, string> = {}, args: string[] = []) {
    const result = spawnSync(NODE, [RUN_CJS_PATH, target, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      input: '{}',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
  }

  const workerProbe = "import { isMainThread } from 'node:worker_threads'; process.stdin.on('end', () => process.stdout.write(isMainThread ? 'child' : 'worker')); process.stdin.resume();";

  it('uses a Worker only for an exact canonical prompt script below the configured trusted root', () => {
    const root = join(tmpDir, 'trusted-root');
    const target = join(root, 'scripts', 'keyword-detector.mjs');
    createTrustedPlugin(root, { 'keyword-detector.mjs': workerProbe });

    const result = run(target, { CLAUDE_PLUGIN_ROOT: root });

    expect(result).toMatchObject({ status: 0, stdout: 'worker' });
  });

  it('rejects same-basename outside-root, extra-argument, and nonprompt candidates to the generic child path', () => {
    const root = join(tmpDir, 'trusted-root');
    const outside = join(tmpDir, 'outside', 'scripts', 'keyword-detector.mjs');
    createTrustedPlugin(root, { 'keyword-detector.mjs': workerProbe });
    mkdirSync(join(tmpDir, 'outside', 'scripts'), { recursive: true });
    writeFileSync(outside, workerProbe);

    expect(run(outside, { CLAUDE_PLUGIN_ROOT: root })).toMatchObject({ status: 0, stdout: 'child' });
    expect(run(join(root, 'scripts', 'keyword-detector.mjs'), { CLAUDE_PLUGIN_ROOT: root }, ['extra']))
      .toMatchObject({ status: 0, stdout: 'child' });

    const nonPromptRoot = join(tmpDir, 'nonprompt-root');
    const nonPromptTarget = join(nonPromptRoot, 'scripts', 'keyword-detector.mjs');
    createTrustedPlugin(nonPromptRoot, { 'keyword-detector.mjs': workerProbe }, 'Stop');
    expect(run(nonPromptTarget, { CLAUDE_PLUGIN_ROOT: nonPromptRoot })).toMatchObject({ status: 0, stdout: 'child' });
  });

  it('rejects a lexical trusted-root path that escapes through a symlink', () => {
    if (process.platform === 'win32') return;
    const root = join(tmpDir, 'trusted-root');
    const outsideDir = join(tmpDir, 'outside');
    createTrustedPlugin(root, { 'keyword-detector.mjs': workerProbe });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'keyword-detector.mjs'), workerProbe);
    rmSync(join(root, 'scripts', 'keyword-detector.mjs'));
    symlinkSync(join(outsideDir, 'keyword-detector.mjs'), join(root, 'scripts', 'keyword-detector.mjs'));

    expect(run(join(root, 'scripts', 'keyword-detector.mjs'), { CLAUDE_PLUGIN_ROOT: root }))
      .toMatchObject({ status: 0, stdout: 'child' });
  });

  it('trusts only the explicitly selected canonical stale-cache sibling root', () => {
    const cacheBase = join(tmpDir, 'cache');
    const staleRoot = join(cacheBase, '4.2.0');
    const selectedRoot = join(cacheBase, '4.3.0');
    createTrustedPlugin(selectedRoot, { 'keyword-detector.mjs': workerProbe });

    const result = run(join(staleRoot, 'scripts', 'keyword-detector.mjs'), { CLAUDE_PLUGIN_ROOT: staleRoot });

    expect(result).toMatchObject({ status: 0, stdout: 'worker' });
  });

  it('preserves nonzero Worker failures and buffers normal output exactly once', () => {
    const root = join(tmpDir, 'trusted-root');
    const target = join(root, 'scripts', 'keyword-detector.mjs');
    createTrustedPlugin(root, {
      'keyword-detector.mjs': "process.stdout.write('once'); process.stderr.write('error'); process.exit(7);",
    });

    const result = run(target, { CLAUDE_PLUGIN_ROOT: root });

    expect(result.status).toBe(7);
    expect(result.stdout).toBe('once');
    expect(result.stderr).toBe('error');
  });

  it('flushes large Worker stdout and stderr byte-for-byte before exit', () => {
    const root = join(tmpDir, 'trusted-root');
    const target = join(root, 'scripts', 'keyword-detector.mjs');
    const stdout = 'o'.repeat(2 * 1024 * 1024);
    const stderr = 'e'.repeat(2 * 1024 * 1024);
    createTrustedPlugin(root, {
      'keyword-detector.mjs': `process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); }); process.stdin.resume();`,
    });

    const result = run(target, { CLAUDE_PLUGIN_ROOT: root });

    expect(result).toMatchObject({ status: 0, stdout, stderr });
  });

  it.each([
    ['syntax failure', 'const = ;', 'SyntaxError'],
    ['import failure', "import './missing-worker-dependency.mjs';", 'missing-worker-dependency'],
    ['uncaught failure', "throw new Error('uncaught worker sentinel');", 'uncaught worker sentinel'],
  ])('preserves Worker %s diagnostics once with a nonzero status', (_label, source, diagnostic) => {
    const root = join(tmpDir, 'trusted-root');
    const target = join(root, 'scripts', 'keyword-detector.mjs');
    createTrustedPlugin(root, { 'keyword-detector.mjs': source });

    const result = run(target, { CLAUDE_PLUGIN_ROOT: root });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(diagnostic);
    expect(result.stderr.split(diagnostic).length - 1).toBe(1);
  });

  it('terminates synchronous and async handle hangs fail-open without late output', () => {
    const root = join(tmpDir, 'trusted-root');
    const target = join(root, 'scripts', 'keyword-detector.mjs');
    const startedMarker = join(tmpDir, 'worker-started');
    createTrustedPlugin(root, {
      'keyword-detector.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(startedMarker)}, process.env.HANG_KIND); if (process.env.HANG_KIND === 'sync') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); setInterval(() => {}, 1000); setTimeout(() => process.stdout.write('late'), 20);`,
    }, 'UserPromptSubmit', 2);

    const quiet = run(target, { CLAUDE_PLUGIN_ROOT: root, HANG_KIND: 'sync' });
    expect(quiet).toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(readFileSync(startedMarker, 'utf-8')).toBe('sync');

    const debug = run(target, { CLAUDE_PLUGIN_ROOT: root, HANG_KIND: 'async', OMC_DEBUG_HOOKS: '1' });
    expect(debug.status).toBe(0);
    expect(debug.stdout).toBe('');
    expect(debug.stderr).toContain('Hook keyword-detector.mjs timed out after 1000ms; exiting fail-open.');
    expect(readFileSync(startedMarker, 'utf-8')).toBe('async');
  });
});
