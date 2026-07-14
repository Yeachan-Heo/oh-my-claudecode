import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const NODE = process.execPath;
const RUN_CJS_PATH = join(process.cwd(), 'scripts', 'run.cjs');
const tempDirs: string[] = [];
const workerProbe = "import { isMainThread } from 'node:worker_threads'; process.stdin.on('end', () => process.stdout.write(isMainThread ? 'child' : 'worker')); process.stdin.resume();";

function makePlugin(root: string, source: string, timeout = 10) {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'run.cjs'), '// plugin-root marker');
  writeFileSync(join(root, 'scripts', 'keyword-detector.mjs'), source);
  writeFileSync(join(root, 'scripts', 'skill-injector.mjs'), 'process.exit(0);');
  writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ matcher: '', hooks: [{
        type: 'command',
        command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/keyword-detector.mjs',
        timeout,
      }] }],
    },
  }));
}

function run(target: string, root: string, env: NodeJS.ProcessEnv = {}, args: string[] = []) {
  const result = spawnSync(NODE, [RUN_CJS_PATH, target, ...args], {
    encoding: 'utf-8',
    input: '{}',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, ...env },
    timeout: 30000,
  });
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Windows-safe prompt hook runner paths', () => {
  it('keeps trusted Worker selection and generic fallbacks correct from a root with spaces', () => {
    const cacheBase = mkdtempSync(join(tmpdir(), 'omc prompt root with spaces-'));
    tempDirs.push(cacheBase);
    const root = join(cacheBase, '4.4.0');
    const target = join(root, 'scripts', 'keyword-detector.mjs');
    makePlugin(root, workerProbe);

    expect(run(target, root)).toMatchObject({ status: 0, stdout: 'worker' });

    const outside = join(cacheBase, 'outside scripts', 'keyword-detector.mjs');
    mkdirSync(join(cacheBase, 'outside scripts'), { recursive: true });
    writeFileSync(outside, workerProbe);
    expect(run(outside, root)).toMatchObject({ status: 0, stdout: 'child' });
    expect(run(target, root, {}, ['not-worker-eligible'])).toMatchObject({ status: 0, stdout: 'child' });
  });

  it('uses the explicitly selected stale sibling root and terminalizes a timed-out prompt Worker', () => {
    const cacheBase = mkdtempSync(join(tmpdir(), 'omc stale root with spaces-'));
    tempDirs.push(cacheBase);
    const staleRoot = join(cacheBase, '4.2.0');
    const selectedRoot = join(cacheBase, '4.3.0');
    makePlugin(selectedRoot, workerProbe);

    expect(run(join(staleRoot, 'scripts', 'keyword-detector.mjs'), staleRoot))
      .toMatchObject({ status: 0, stdout: 'worker' });

    const timeoutRoot = join(cacheBase, '4.5.0');
    const timeoutTarget = join(timeoutRoot, 'scripts', 'keyword-detector.mjs');
    makePlugin(timeoutRoot, "setInterval(() => {}, 1000); setTimeout(() => process.stdout.write('late'), 20);", 1);
    const result = run(timeoutTarget, timeoutRoot, { OMC_DEBUG_HOOKS: '1' });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Hook keyword-detector.mjs timed out after 1ms; exiting fail-open.');
  });
});
