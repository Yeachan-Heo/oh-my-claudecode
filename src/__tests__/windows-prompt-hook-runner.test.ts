import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function runDelayedPromptRunner(root: string, target: string) {
  const launcher = `
    const { spawnSync } = require('node:child_process');
    const [node, runner, root, target, delayMs, outerTimeoutMs] = process.argv.slice(1);
    const startedAt = Date.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(delayMs));
    const runnerStartedAt = Date.now();
    const result = spawnSync(node, [runner, target], {
      encoding: 'utf8',
      input: '{}',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
      timeout: Number(outerTimeoutMs) - (runnerStartedAt - startedAt),
    });
    process.stdout.write(JSON.stringify({
      evidence: 'argv-based delayed-launch model; not a native Windows reproduction',
      startedAt,
      runnerStartedAt,
      finishedAt: Date.now(),
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    }));
  `;
  const result = spawnSync(NODE, ['-e', launcher, NODE, RUN_CJS_PATH, root, target, '11000', '30000'], {
    encoding: 'utf-8',
    timeout: 35000,
  });
  return JSON.parse(result.stdout || '{}');
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

  it('models an argv-delayed launch crossing 10s and failing open before the 30s host fuse', () => {
    const cacheBase = mkdtempSync(join(tmpdir(), 'omc delayed prompt launch-'));
    tempDirs.push(cacheBase);
    const root = join(cacheBase, '4.7.0');
    const target = join(root, 'scripts', 'keyword-detector.mjs');
    makePlugin(root, "setInterval(() => {}, 1000); setTimeout(() => process.stdout.write('late'), 20);", 30);

    const model = runDelayedPromptRunner(root, target);

    expect(model.evidence).toContain('model; not a native Windows reproduction');
    expect(model.runnerStartedAt - model.startedAt).toBeGreaterThan(10000);
    expect(model.finishedAt - model.startedAt).toBeLessThan(30000);
    expect(model.status).toBe(0);
    expect(model.finishedAt - model.runnerStartedAt).toBeGreaterThanOrEqual(7500);
    expect(model.finishedAt - model.runnerStartedAt).toBeLessThan(10000);
    expect(model.stdout).toBe('');
    expect(model.stderr).toBe('');
  });

  it('reaps a timed-out generic hook process tree', async () => {
    const cacheBase = mkdtempSync(join(tmpdir(), 'omc generic tree reap-'));
    tempDirs.push(cacheBase);
    const root = join(cacheBase, '4.6.0');
    const target = join(root, 'scripts', 'post-tool-verifier.mjs');
    const pidfile = join(cacheBase, 'generic-grandchild.pid');
    let grandchildPid: number | undefined;
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'run.cjs'), '// plugin-root marker');
    writeFileSync(target, `
      import { spawn } from 'node:child_process';
      const childSource = "require('node:fs').writeFileSync(process.env.OMC_TEST_PIDFILE, String(process.pid)); setInterval(() => {}, 1e9);";
      spawn(process.execPath, ['-e', childSource], { stdio: 'ignore', env: process.env });
      setInterval(() => {}, 1e9);
    `);
    writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: '', hooks: [{
          type: 'command',
          command: 'node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/post-tool-verifier.mjs',
          timeout: 1,
        }] }],
      },
    }));

    try {
      const startedAt = Date.now();
      const result = run(target, root, { OMC_TEST_PIDFILE: pidfile });
      const elapsed = Date.now() - startedAt;
      expect(result.status).toBe(0);
      expect(elapsed).toBeGreaterThanOrEqual(400);
      expect(elapsed).toBeLessThan(30000);
      grandchildPid = Number(readFileSync(pidfile, 'utf8'));
      expect(grandchildPid).toBeGreaterThan(0);

      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try {
          process.kill(grandchildPid!, 0);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(() => process.kill(grandchildPid!, 0)).toThrow();
    } finally {
      if (grandchildPid) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch { /* already dead */ }
      }
    }
  });
});
