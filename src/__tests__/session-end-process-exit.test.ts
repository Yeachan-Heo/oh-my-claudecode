import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();
const RUN_CJS = join(REPO_ROOT, 'scripts', 'run.cjs');
const SESSION_END_SCRIPTS = [
  ['session-end', join(REPO_ROOT, 'scripts', 'session-end.mjs')],
  ['wiki-session-end', join(REPO_ROOT, 'scripts', 'wiki-session-end.mjs')],
] as const;
const IS_CI = process.env.CI === 'true' || process.env.CI === '1';
// A loaded host starts and runs every process more slowly, so a hook is not held
// to a wall-clock ceiling. It is compared with a control run measured next to it:
// the same script through run.cjs, given a frame it rejects as soon as it has read
// it. This much is what the real run may cost on top of that control.
const OVERHEAD_MARGIN_MS = IS_CI ? 600 : 300;
// From the budget report of run.cjs to the close of the process. No Node start-up
// lies in between, so this one is a plain ceiling.
const EXIT_AFTER_REPORT_MS = 300;
// A change of load slows one run and not the next, so every limit is checked per
// sample, a real run against the control measured right before it, and one sample
// within the limit is enough. On a steady host a slower hook is over it in all.
const MAX_SAMPLES = 6;
const SAMPLING_DEADLINE_MS = 30_000;
// Above the sampling deadline plus a last slow sample, so a failure keeps its diagnostics.
const SAMPLED_TEST_TIMEOUT_MS = 100_000;
const CONTROL_INPUT = 'not a SessionEnd frame';
// What a hook prints when stdin gave it no frame it can use.
const FALLBACK_OUTPUT = JSON.stringify({ continue: true, suppressOutput: true });
// The manifest lock gives up after about 4.8s: a contender must be gone before that.
const MANIFEST_LOCK_WAIT_MS = 4_800;
// A run.cjs foreground budget that no healthy hook reaches, with a closed stdin
// or with one that stays open and empty, and the later point at which the test
// ends a process that never exits. A hook that blocks on something that never
// answers fails on these whatever the load is.
const UNREACHED_BUDGET_MS = 20_000;
const HANG_CEILING_MS = 25_000;
// Captured before any test points HOME at one of its projects.
const PROJECT_PARENT = homedir();
const HAS_GENERATED_DIST = existsSync(join(REPO_ROOT, 'dist', 'hooks', 'session-end', 'worker.js'));
const TEST_PRODUCER_GRACE_MS = '25';
// The worker's required actions have a 9s budget; allow that bounded contract
// plus process-startup/runner contention under the full suite. The tests that
// use it check that the work completes, not how fast.
const DETACHED_WORKER_CEILING_MS = 25_000;

interface ExitResult {
  elapsedMs: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** The output run.cjs forwarded; a run it ended at its budget forwards none. */
  stdout: string;
  stderr: string;
  /** When the budget report of run.cjs arrived, if there was one. */
  reportMs: number | undefined;
}

function runUntilClose(
  script: string,
  cwd: string,
  input: string | undefined,
  ceilingMs: number,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<ExitResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [RUN_CJS, script], {
      cwd,
      env: {
        ...process.env,
        HOME: cwd,
        USERPROFILE: cwd,
        ...extraEnv,
        CLAUDE_PLUGIN_ROOT: REPO_ROOT,
        CLAUDE_CONFIG_DIR: join(cwd, '.claude'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let reportMs: number | undefined;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (reportMs === undefined && stderr.includes('exiting fail-open')) reportMs = Date.now() - startedAt;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, ceilingMs);

    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ elapsedMs: Date.now() - startedAt, code, signal, timedOut, stdout, stderr, reportMs });
    });

    if (input !== undefined) child.stdin.end(input);
  });
}

function expectCleanExit(result: ExitResult): void {
  expect({ timedOut: result.timedOut, signal: result.signal, code: result.code }, result.stderr)
    .toEqual({ timedOut: false, signal: null, code: 0 });
}

function expectPromptExit(result: ExitResult, ceilingMs: number): void {
  expectCleanExit(result);
  expect(result.elapsedMs).toBeLessThanOrEqual(ceilingMs);
}

/** The hook finished by itself, not through the run.cjs foreground budget. */
function expectOwnExit(result: ExitResult): void {
  expectCleanExit(result);
  expect(result.stderr).not.toContain('exiting fail-open');
}

function bareNodeStartMs(): Promise<number> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('close', () => resolve(Date.now() - startedAt));
  });
}

/** The control run: everything a run pays before and after the work on its input. */
async function controlRunMs(script: string, cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<number> {
  const result = await runUntilClose(script, cwd, CONTROL_INPUT, HANG_CEILING_MS, {
    ...extraEnv,
    NODE_ENV: 'test',
    OMC_SESSION_END_TEST_FOREGROUND_TIMEOUT_MS: String(UNREACHED_BUDGET_MS),
  });
  expectOwnExit(result);
  return result.elapsedMs;
}

/**
 * Takes samples until each limit has been met by one of them, and fails with all
 * the samples when no further one is allowed.
 */
async function expectWithinLimits<Timings extends Record<string, number>>(
  takeSample: () => Promise<Timings>,
  limits: (sample: Timings) => Record<string, [valueMs: number, limitMs: number]>,
): Promise<void> {
  const startedAt = Date.now();
  const samples: Timings[] = [];
  const best: Record<string, number> = {};
  let exceeded: string[] = [];
  do {
    const sample = await takeSample();
    samples.push(sample);
    const checks = Object.entries(limits(sample));
    for (const [name, [value]] of checks) best[name] = Math.min(best[name] ?? value, value);
    exceeded = checks
      .filter(([name, [, limit]]) => best[name] > limit)
      .map(([name, [, limit]]) => `${name}: ${best[name]}ms at best, limit ${limit}ms`);
    if (exceeded.length === 0) return;
  } while (samples.length < MAX_SAMPLES && Date.now() - startedAt < SAMPLING_DEADLINE_MS);
  expect(exceeded, `samples ${JSON.stringify(samples)}`).toEqual([]);
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

/** A proxy that accepts connections and never answers, so a request through it does not return. */
async function startSilentProxy(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

async function waitForTerminalCallback(cwd: string, sessionId: string): Promise<void> {
  const callbackPath = join(cwd, 'callback.md');
  const manifestPath = join(getOmcRoot(cwd), 'state', 'session-end-jobs', `${sessionId}.json`);
  let deadline = Date.now() + DETACHED_WORKER_CEILING_MS;
  const hardCeiling = Date.now() + DETACHED_WORKER_CEILING_MS * 2;
  let lastRevision = -1;
  let lastPhase = '';

  while (Date.now() < deadline && Date.now() < hardCeiling) {
    if (existsSync(callbackPath) && existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
          phase: string;
          revision: number;
          owner: unknown;
          actions: Record<string, { status: string }>;
        };
        if (manifest.revision !== lastRevision || manifest.phase !== lastPhase) {
          lastRevision = manifest.revision;
          lastPhase = manifest.phase;
          deadline = Math.min(hardCeiling, Date.now() + 10_000);
        }
        if (manifest.phase === 'complete' && manifest.owner === null && manifest.actions.callback?.status === 'completed') {
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
          return;
        }
      } catch {
        // Read or parse collision during concurrent atomic write; retry on next tick
      }
    } else if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { phase: string; revision: number };
        if (manifest.revision !== lastRevision || manifest.phase !== lastPhase) {
          lastRevision = manifest.revision;
          lastPhase = manifest.phase;
          deadline = Math.min(hardCeiling, Date.now() + 10_000);
        }
      } catch {
        // Read or parse collision
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  let manifest: { phase?: string; owner?: unknown; recoverableFailure?: { reason?: string }; actions?: Record<string, { status?: string; error?: string }> } | null = null;
  try {
    if (existsSync(manifestPath)) {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    }
  } catch {
    manifest = null;
  }
  const callback = manifest?.actions?.callback;
  // recoverableFailure.reason is the only record of why a non-terminal release
  // happened, so a CI-only failure must print it (issue #4076).
  throw new Error(`detached SessionEnd worker did not complete its callback: phase=${manifest?.phase ?? 'missing'} owner=${manifest?.owner === null ? 'none' : typeof manifest?.owner} callback=${callback?.status ?? 'missing'} error=${callback?.error ?? 'none'} release=${manifest?.recoverableFailure?.reason ?? 'unrecorded'} file=${existsSync(callbackPath)}`);
}

describe('SessionEnd run.cjs process exit regressions (#3477)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 40, retryDelay: 25 });
    }
    vi.unstubAllEnvs();
  });

  function createProject(): string {
    const cwd = mkdtempSync(join(PROJECT_PARENT, 'omc-session-end-process-exit-'));
    tempDirs.push(cwd);
    vi.stubEnv('HOME', cwd);
    vi.stubEnv('USERPROFILE', cwd);
    vi.stubEnv('OMC_STATE_DIR', '');
    // Create a workspace marker so getOmcRoot uses this directory as the root
    writeFileSync(join(cwd, '.omc-workspace'), '');
    writeFileSync(join(cwd, 'transcript.jsonl'), '');
    mkdirSync(getOmcRoot(cwd), { recursive: true });
    return cwd;
  }

  /**
   * The hook finishes by itself and costs at most the margin more than its control
   * run. Every sample gets fresh projects; the project of the last one is returned.
   */
  async function expectPromptOwnExit(
    script: string,
    sessionId: string,
    configure: (cwd: string) => void,
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<string> {
    let cwd = '';
    await expectWithinLimits(async () => {
      const control = await controlRunMs(script, createProject(), extraEnv);
      cwd = createProject();
      configure(cwd);
      const result = await runUntilClose(script, cwd, validSessionEndInput(cwd, sessionId), HANG_CEILING_MS, extraEnv);
      expectOwnExit(result);
      return { control, hook: result.elapsedMs };
    }, (sample) => ({ 'hook over its control run': [sample.hook - sample.control, OVERHEAD_MARGIN_MS] }));
    return cwd;
  }

  /**
   * The run.cjs foreground budget ends the hook: not before it is due, no later
   * than the control run explains, and the process closes right after the report.
   */
  async function expectPromptBudgetExit(
    script: string,
    prepareInput: (cwd: string) => string | undefined,
    lifetimeCeilingMs: number,
  ): Promise<void> {
    const budgetMs = IS_CI ? 1_900 : 900;
    const env = { NODE_ENV: 'test', OMC_SESSION_END_TEST_FOREGROUND_TIMEOUT_MS: String(budgetMs) };
    await expectWithinLimits(async () => {
      const control = await controlRunMs(script, createProject(), env);
      const cwd = createProject();
      const result = await runUntilClose(script, cwd, prepareInput(cwd), HANG_CEILING_MS, env);
      expectCleanExit(result);
      expect(result.stderr).toContain(`timed out after ${budgetMs}ms; exiting fail-open`);
      const reportMs = result.reportMs!;
      expect(reportMs).toBeGreaterThanOrEqual(budgetMs);
      return { control, lifetime: result.elapsedMs, pastBudget: reportMs - budgetMs, afterReport: result.elapsedMs - reportMs };
    }, (sample) => ({
      'report past the budget, over the control run': [sample.pastBudget - sample.control, OVERHEAD_MARGIN_MS],
      'exit after the report': [sample.afterReport, EXIT_AFTER_REPORT_MS],
      'process lifetime': [sample.lifetime, lifetimeCeilingMs],
    }));
  }

  // What a run pays before it reads its input is part of every control run, so it
  // has a bound of its own.
  it.each(SESSION_END_SCRIPTS)('%s starts and rejects a frame for little more than two bare Node starts', async (_name, script) => {
    await expectWithinLimits(
      async () => ({ bare: await bareNodeStartMs(), control: await controlRunMs(script, createProject()) }),
      (sample) => ({ 'control run over two bare Node starts': [sample.control - 2 * sample.bare, OVERHEAD_MARGIN_MS] }),
    );
  }, SAMPLED_TEST_TIMEOUT_MS);

  // No byte ever arrives and stdin is never ended: the hook gives up on it at its
  // own read deadline and prints the fallback. It then has to leave by itself,
  // well short of the budget that used to end it and discard that output.
  it.each(SESSION_END_SCRIPTS)('%s exits by itself with no bytes and an open stdin pipe', async (_name, script) => {
    const env = { NODE_ENV: 'test', OMC_SESSION_END_TEST_FOREGROUND_TIMEOUT_MS: String(UNREACHED_BUDGET_MS) };
    await expectWithinLimits(async () => {
      const control = await controlRunMs(script, createProject(), env);
      const result = await runUntilClose(script, createProject(), undefined, HANG_CEILING_MS, env);
      expectOwnExit(result);
      expect(result.stdout.trim()).toBe(FALLBACK_OUTPUT);
      return { control, hook: result.elapsedMs };
    }, (sample) => ({
      'hook over its control run': [sample.hook - sample.control, OVERHEAD_MARGIN_MS],
      'hook before the budget by less than its control run': [sample.hook + sample.control - UNREACHED_BUDGET_MS, 0],
    }));
  }, SAMPLED_TEST_TIMEOUT_MS);

  it.skipIf(!HAS_GENERATED_DIST).each(SESSION_END_SCRIPTS)('%s terminates a live manifest-lock contender within the foreground ceiling', async (_name, script) => {
    const sessionId = `live-manifest-lock-${_name}`;
    await expectPromptBudgetExit(script, (cwd) => {
      const jobsDir = join(cwd, '.omc', 'state', 'session-end-jobs');
      mkdirSync(jobsDir, { recursive: true });
      writeFileSync(join(jobsDir, `${sessionId}.json.lock`), JSON.stringify({
        pid: process.pid, processStartIdentity: null, nonce: 'live-owner', createdAt: new Date().toISOString(),
      }));
      return validSessionEndInput(cwd, sessionId);
    }, MANIFEST_LOCK_WAIT_MS);
  }, SAMPLED_TEST_TIMEOUT_MS);

  it.skipIf(!HAS_GENERATED_DIST).each(SESSION_END_SCRIPTS)('%s exits after promptly closed valid SessionEnd JSON with configured adapters', async (_name, script) => {
    const sessionId = `configured-${_name}`;

    // The unreached budget keeps a loaded host from ending the hook before the
    // durable manifest is published.
    const cwd = await expectPromptOwnExit(script, sessionId, configureDeferredAdapters, {
      NODE_ENV: 'test',
      OMC_SESSION_END_TEST_FOREGROUND_TIMEOUT_MS: String(UNREACHED_BUDGET_MS),
    });

    if (_name === 'session-end') {
      const manifestPath = join(getOmcRoot(cwd), 'state', 'session-end-jobs', `${sessionId}.json`);
      const deadline = Date.now() + (IS_CI ? 1_000 : 250);
      while (!existsSync(manifestPath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { actions: Record<string, { phase: string }> };
      expect(manifest.actions.callback.phase).toBe('deferred-best-effort');
      expect(manifest.actions.notification.phase).toBe('deferred-best-effort');
    }
  }, SAMPLED_TEST_TIMEOUT_MS);

  it.skipIf(!HAS_GENERATED_DIST)('keeps the detached worker alive through producer grace and exits terminally without SessionStart', async () => {
    const sessionId = 'detached-worker-producer-grace';

    const cwd = await expectPromptOwnExit(
      join(REPO_ROOT, 'scripts', 'session-end.mjs'),
      sessionId,
      configureDeferredAdapters,
      {
        NODE_ENV: 'test',
        OMC_SESSION_END_TEST_FOREGROUND_TIMEOUT_MS: String(UNREACHED_BUDGET_MS),
        OMC_SESSION_END_TEST_PRODUCER_GRACE_MS: TEST_PRODUCER_GRACE_MS,
      },
    );

    await waitForTerminalCallback(cwd, sessionId);
    // The test limit covers the whole wait, so a failed wait reports the manifest.
  }, SAMPLED_TEST_TIMEOUT_MS + DETACHED_WORKER_CEILING_MS * 2);

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
    const caPath = join(createProject(), 'test-ca.pem');
    writeFileSync(caPath, 'not a certificate');
    const proxy = await startSilentProxy();

    let cwd: string;
    try {
      cwd = await expectPromptOwnExit(
        join(REPO_ROOT, 'scripts', 'session-end.mjs'),
        'configured-network-routing',
        configureDeferredAdapters,
        {
          HTTPS_PROXY: proxy.url,
          HTTP_PROXY: proxy.url,
          NODE_EXTRA_CA_CERTS: caPath,
        },
      );
    } finally {
      await proxy.close();
    }
    const manifestPath = join(getOmcRoot(cwd), 'state', 'session-end-jobs', 'configured-network-routing.json');
    const publicationDeadline = Date.now() + 2_000;
    while (!existsSync(manifestPath) && Date.now() < publicationDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { actions: Record<string, { phase: string }> };
    expect(manifest.actions.callback.phase).toBe('deferred-best-effort');
    expect(manifest.actions.notification.phase).toBe('deferred-best-effort');
  }, SAMPLED_TEST_TIMEOUT_MS);

  it.skipIf(!HAS_GENERATED_DIST)('wiki-session-end exits without waiting for a live wiki lock', async () => {
    await expectPromptOwnExit(join(REPO_ROOT, 'scripts', 'wiki-session-end.mjs'), 'wiki-live-lock', (cwd) => {
      configureDeferredAdapters(cwd);
      const wikiDir = join(getOmcRoot(cwd), 'wiki');
      mkdirSync(wikiDir, { recursive: true });
      writeFileSync(join(getOmcRoot(cwd), '.omc-config.json'), JSON.stringify({ wiki: { autoCapture: true } }));
      writeFileSync(join(wikiDir, '.wiki-lock.lock'), JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
    });
  }, SAMPLED_TEST_TIMEOUT_MS);

  it('wiki-session-end loads the lean wiki bootstrap, not the full SessionEnd index graph', () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'wiki-session-end.mjs'), 'utf-8');
    // The script may only load lean modules that already ship in the committed
    // dist closure (a new dist file would need an owner-signed artifact commit).
    const distImports = [...script.matchAll(/import\('(\.\.\/dist\/[^']+)'\)/g)].map((m) => m[1]).sort();
    expect(distImports).toEqual([
      '../dist/hooks/session-end/cleanup-manifest.js',
      '../dist/hooks/session-end/worker.js',
      '../dist/hooks/wiki/session-hooks.js',
      '../dist/lib/worktree-paths.js',
    ]);
    expect(script).not.toContain('session-end/index.js');
    // Worker loads only after the intent is sealed.
    expect(script.indexOf('sealWikiManifest(directory')).toBeLessThan(script.indexOf("import('../dist/hooks/session-end/worker.js')"));
    const bootstrap = readFileSync(join(REPO_ROOT, 'src', 'hooks', 'session-end', 'wiki-foreground-bootstrap.ts'), 'utf-8');
    expect(bootstrap).not.toMatch(/from '\.\/index\.js'|import\('\.\/index\.js'\)/);
  });

  // End-to-end through run.cjs and the shipped dist: the wiki hook seals its
  // capture intent and the session-log page gets written. The foreground budget
  // is widened via the test-only knob so this stays independent of host speed;
  // the 300ms behaviour itself is pinned by the lean-import guard above and by
  // the seal-before-worker-load ordering tests in wiki-foreground-bootstrap.test.ts.
  // If the hook's own worker spawn is missed, the loop drives the recovery pass.
  it.skipIf(!HAS_GENERATED_DIST)('wiki-session-end seals its capture intent and the session-log page is written', async () => {
    const distWorker = pathToFileURL(join(REPO_ROOT, 'dist', 'hooks', 'session-end', 'worker.js')).href;
    const { processSessionEndWorker } = await import(distWorker) as typeof import('../hooks/session-end/worker.js');

    for (let run = 0; run < 3; run += 1) {
      const cwd = createProject();
      mkdirSync(join(getOmcRoot(cwd), 'wiki'), { recursive: true });
      writeFileSync(join(getOmcRoot(cwd), '.omc-config.json'), JSON.stringify({ wiki: { autoCapture: true } }));
      const sessionId = `wiki-budget-${run}`;

      const result = await runUntilClose(
        join(REPO_ROOT, 'scripts', 'wiki-session-end.mjs'),
        cwd,
        validSessionEndInput(cwd, sessionId),
        DETACHED_WORKER_CEILING_MS,
        {
          NODE_ENV: 'test',
          OMC_SESSION_END_TEST_FOREGROUND_TIMEOUT_MS: String(DETACHED_WORKER_CEILING_MS - 500),
          OMC_SESSION_END_TEST_PRODUCER_GRACE_MS: TEST_PRODUCER_GRACE_MS,
        },
      );
      expectPromptExit(result, DETACHED_WORKER_CEILING_MS);

      const manifestPath = join(getOmcRoot(cwd), 'state', 'session-end-jobs', `${sessionId}.json`);
      type WikiJob = { phase: string; owner: unknown; producerGraceExpiresAt: string; producers: { wiki: { state: string; sealedBy?: string } }; actions: { 'wiki-capture': { status: string; payload: { filename?: string } } } };
      const readJob = (): WikiJob => JSON.parse(readFileSync(manifestPath, 'utf-8')) as WikiJob;
      const sealed = readJob();
      expect(sealed.producers.wiki).toMatchObject({ state: 'sealed', sealedBy: 'wiki-producer' });
      const filename = sealed.actions['wiki-capture'].payload.filename;
      expect(filename).toMatch(/^session-log-.*\.md$/);

      // Same hard ceiling as waitForTerminalCallback.
      const deadline = Date.now() + DETACHED_WORKER_CEILING_MS * 2;
      let job = readJob();
      while (!(job.phase === 'complete' && job.owner === null) && Date.now() < deadline) {
        if (job.owner === null && Date.now() >= Date.parse(job.producerGraceExpiresAt)) {
          await processSessionEndWorker({ directory: cwd, sessionId });
        } else {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        try { job = readJob(); } catch { /* concurrent atomic write; retry */ }
      }
      expect(job.actions['wiki-capture'], `phase=${job.phase} owner=${job.owner === null ? 'none' : 'held'}`).toMatchObject({ status: 'completed' });
      expect(existsSync(join(getOmcRoot(cwd), 'wiki', filename!))).toBe(true);
    }
  }, IS_CI ? 120_000 : 60_000);

  it.skipIf(!HAS_GENERATED_DIST)('runs the SessionEnd pair sequentially within the combined foreground budget', async () => {
    // Each hook of the pair stays within its own margin, so the pair stays within the sum.
    await expectWithinLimits(async () => {
      const timings: Record<string, number> = {};
      const cwd = createProject();
      configureDeferredAdapters(cwd);
      for (const [name, script] of SESSION_END_SCRIPTS) {
        // Next to its hook, so both meet what the hook before them left running.
        timings[`${name} control`] = await controlRunMs(script, createProject());
        const result = await runUntilClose(script, cwd, validSessionEndInput(cwd, `sequential-${name}`), HANG_CEILING_MS);
        expectOwnExit(result);
        timings[`${name} hook`] = result.elapsedMs;
      }
      return timings;
    }, (sample) => Object.fromEntries(SESSION_END_SCRIPTS.map(([name]) => [
      `${name} hook over its control run`, [sample[`${name} hook`] - sample[`${name} control`], OVERHEAD_MARGIN_MS],
    ])));
  }, SAMPLED_TEST_TIMEOUT_MS);
});
