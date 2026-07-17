import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();
const RUN_CJS = join(REPO_ROOT, 'scripts', 'run.cjs');
const SESSION_END_SCRIPTS = [
  ['session-end', join(REPO_ROOT, 'scripts', 'session-end.mjs')],
  ['wiki-session-end', join(REPO_ROOT, 'scripts', 'wiki-session-end.mjs')],
] as const;
const COMMAND_CEILING_MS = 500;
const SEQUENTIAL_CEILING_MS = 1_000;
const HAS_GENERATED_DIST = existsSync(join(REPO_ROOT, 'dist', 'hooks', 'session-end', 'worker.js'));
const TEST_PRODUCER_GRACE_MS = '25';
const DETACHED_WORKER_CEILING_MS = 3_000;

interface ExitResult {
  elapsedMs: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

function runUntilClose(
  script: string,
  cwd: string,
  input: string | undefined,
  ceilingMs = COMMAND_CEILING_MS,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<ExitResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [RUN_CJS, script], {
      cwd,
      env: { ...process.env, ...extraEnv, CLAUDE_CONFIG_DIR: join(cwd, '.claude') },
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, ceilingMs);

    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ elapsedMs: Date.now() - startedAt, code, signal, timedOut });
    });

    if (input !== undefined) child.stdin.end(input);
  });
}

function expectPromptExit(result: ExitResult, ceilingMs = COMMAND_CEILING_MS): void {
  expect(result.timedOut).toBe(false);
  expect(result.signal).toBeNull();
  expect(result.code).toBe(0);
  expect(result.elapsedMs).toBeLessThanOrEqual(ceilingMs);
}

function validSessionEndInput(cwd: string, sessionId: string): string {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: join(cwd, 'transcript.jsonl'),
    cwd,
    permission_mode: 'default',
    hook_event_name: 'SessionEnd',
    reason: 'clear',
  });
}

function configureDeferredAdapters(cwd: string): void {
  const configDir = join(cwd, '.claude');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, '.omc-config.json'), JSON.stringify({
    notifications: { enabled: true },
    stopHookCallbacks: { file: { enabled: true, path: join(cwd, 'callback.md'), format: 'markdown' } },
  }));
}

async function waitForTerminalCallback(cwd: string, sessionId: string): Promise<void> {
  const callbackPath = join(cwd, 'callback.md');
  const manifestPath = join(cwd, '.omc', 'state', 'session-end-jobs', `${sessionId}.json`);
  const deadline = Date.now() + DETACHED_WORKER_CEILING_MS;
  while (Date.now() < deadline) {
    if (existsSync(callbackPath) && existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { phase: string; owner: unknown; actions: Record<string, { status: string }> };
      if (manifest.phase === 'complete' && manifest.owner === null && manifest.actions.callback.status === 'completed') {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        return;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('detached SessionEnd worker did not complete its callback');
}

describe('SessionEnd run.cjs process exit regressions (#3477)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 40, retryDelay: 25 });
    }
  });

  function createProject(): string {
    const cwd = mkdtempSync(join(tmpdir(), 'omc-session-end-process-exit-'));
    tempDirs.push(cwd);
    writeFileSync(join(cwd, 'transcript.jsonl'), '');
    return cwd;
  }

  it.each(SESSION_END_SCRIPTS)('%s exits with no bytes and an open stdin pipe', async (_name, script) => {
    const result = await runUntilClose(script, createProject(), undefined);
    expectPromptExit(result);
  });

  it.skipIf(!HAS_GENERATED_DIST).each(SESSION_END_SCRIPTS)('%s exits after promptly closed valid SessionEnd JSON with configured adapters', async (_name, script) => {
    const cwd = createProject();
    configureDeferredAdapters(cwd);
    const sessionId = `configured-${_name}`;

    const result = await runUntilClose(script, cwd, validSessionEndInput(cwd, sessionId));
    expectPromptExit(result);

    if (_name === 'session-end') {
      const manifestPath = join(cwd, '.omc', 'state', 'session-end-jobs', `${sessionId}.json`);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { actions: Record<string, { phase: string }> };
      expect(manifest.actions.callback.phase).toBe('deferred-best-effort');
      expect(manifest.actions.notification.phase).toBe('deferred-best-effort');
    }
  });

  it.skipIf(!HAS_GENERATED_DIST)('keeps the detached worker alive through producer grace and exits terminally without SessionStart', async () => {
    const cwd = createProject();
    const sessionId = 'detached-worker-producer-grace';
    configureDeferredAdapters(cwd);

    expectPromptExit(await runUntilClose(
      join(REPO_ROOT, 'scripts', 'session-end.mjs'),
      cwd,
      validSessionEndInput(cwd, sessionId),
      COMMAND_CEILING_MS,
      { NODE_ENV: 'test', OMC_SESSION_END_TEST_PRODUCER_GRACE_MS: TEST_PRODUCER_GRACE_MS },
    ));

    await waitForTerminalCallback(cwd, sessionId);
  });

  it.skipIf(!HAS_GENERATED_DIST)('uses the generated dist closure: the shipped worker imports and can execute', async () => {
    const distWorker = join(REPO_ROOT, 'dist', 'hooks', 'session-end', 'worker.js');
    const distManifest = join(REPO_ROOT, 'dist', 'hooks', 'session-end', 'cleanup-manifest.js');
    expect(readFileSync(distWorker, 'utf8')).toContain("getProcessStartIdentity");

    const { prepareCoreManifest, sealCoreManifest, sealWikiManifest, mutateSessionEndJob, readSessionEndJob } =
      await import(pathToFileURL(distManifest).href) as typeof import('../hooks/session-end/cleanup-manifest.js');
    const { processSessionEndWorker } = await import(pathToFileURL(distWorker).href) as typeof import('../hooks/session-end/worker.js');
    const cwd = createProject();
    const sessionId = 'dist-worker-executes';
    expect(prepareCoreManifest(cwd, sessionId, {})).not.toBeNull();
    expect(sealCoreManifest(cwd, sessionId)).not.toBeNull();
    expect(sealWikiManifest(cwd, sessionId)).not.toBeNull();
    let manifest = readSessionEndJob(cwd, sessionId)!;
    for (const name of Object.keys(manifest.actions)) {
      manifest = mutateSessionEndJob(cwd, sessionId, manifest.revision, (job) => {
        const action = job.actions[name as keyof typeof job.actions];
        action.status = 'completed';
        action.runner = { attempt: 1, runnerNonce: `${name}-terminal`, phase: 'terminal', deadlineAt: new Date().toISOString() };
      })!;
    }

    await processSessionEndWorker({ directory: cwd, sessionId });
    expect(readSessionEndJob(cwd, sessionId)).toMatchObject({ phase: 'complete', owner: null });
  });

  it.skipIf(!HAS_GENERATED_DIST)('keeps configured callbacks, proxies, and custom CA out of the foreground process', async () => {
    const cwd = createProject();
    configureDeferredAdapters(cwd);
    const caPath = join(cwd, 'test-ca.pem');
    writeFileSync(caPath, 'not a certificate');

    const result = await runUntilClose(
      join(REPO_ROOT, 'scripts', 'session-end.mjs'),
      cwd,
      validSessionEndInput(cwd, 'configured-network-routing'),
      COMMAND_CEILING_MS,
      {
        HTTPS_PROXY: 'http://127.0.0.1:9',
        HTTP_PROXY: 'http://127.0.0.1:9',
        NODE_EXTRA_CA_CERTS: caPath,
      },
    );
    expectPromptExit(result);
    const manifest = JSON.parse(readFileSync(join(cwd, '.omc', 'state', 'session-end-jobs', 'configured-network-routing.json'), 'utf8')) as { actions: Record<string, { phase: string }> };
    expect(manifest.actions.callback.phase).toBe('deferred-best-effort');
    expect(manifest.actions.notification.phase).toBe('deferred-best-effort');
  });

  it.skipIf(!HAS_GENERATED_DIST)('wiki-session-end exits without waiting for a live wiki lock', async () => {
    const cwd = createProject();
    configureDeferredAdapters(cwd);
    const wikiDir = join(cwd, '.omc', 'wiki');
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(cwd, '.omc', '.omc-config.json'), JSON.stringify({ wiki: { autoCapture: true } }));
    writeFileSync(join(wikiDir, '.wiki-lock.lock'), JSON.stringify({ pid: process.pid, timestamp: Date.now() }));

    const result = await runUntilClose(
      join(REPO_ROOT, 'scripts', 'wiki-session-end.mjs'),
      cwd,
      validSessionEndInput(cwd, 'wiki-live-lock'),
    );
    expectPromptExit(result);
  });

  it.skipIf(!HAS_GENERATED_DIST)('runs the SessionEnd pair sequentially within the combined foreground budget', async () => {
    const cwd = createProject();
    configureDeferredAdapters(cwd);
    const startedAt = Date.now();

    for (const [name, script] of SESSION_END_SCRIPTS) {
      expectPromptExit(await runUntilClose(script, cwd, validSessionEndInput(cwd, `sequential-${name}`)));
    }

    expect(Date.now() - startedAt).toBeLessThanOrEqual(SEQUENTIAL_CEILING_MS);
  });
});
