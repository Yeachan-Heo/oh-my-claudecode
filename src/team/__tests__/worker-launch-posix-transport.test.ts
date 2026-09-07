/**
 * Regression suite for issue #3655 — POSIX supervised worker launch transport.
 *
 * v4.15.8/v4.15.9 introduced the attempt-owned descriptor transport on the
 * runtime-cli reader side (`runWorkerLaunchFromEnvironment` rejects any
 * inline-only launch spec with `worker_launch_descriptor_required`), but the
 * POSIX supervised writer (`buildWorkerStartCommand` via
 * `spawnWorkerInPane`) still delivered the bootstrap spec inline through
 * `OMC_WORKER_LAUNCH_SPEC`. Every supervised POSIX worker launch therefore
 * failed before provider startup. This suite pins the writer/reader contract:
 * the POSIX writer must materialize an attempt-owned descriptor and hand the
 * runtime CLI its path, exactly like the native Windows path already does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildWorkerStartCommand } from '../tmux-session.js';
import { getProcessStartIdentity, isProcessAlive, isProcessIdentityLive } from '../../platform/process-utils.js';
import {
  awaitWorkerLaunchAcknowledgement,
  awaitWorkerLaunchProviderStarted,
  cleanupWorkerLaunchTransport,
  materializeWorkerLaunchTransport,
  prepareWorkerLaunchAttempt,
  readAndConsumeWorkerLaunchDescriptor,
  terminateWorkerLaunchProvider,
  type WorkerLaunchAttempt,
} from '../worker-launch-ack.js';
import { runWorkerLaunchFromEnvironment } from '../runtime-cli.js';

let cwd = '';
let restoreFixtureEnv: (() => void) | undefined;
let originalPlatform: PropertyDescriptor | undefined;
let exitSpy: ReturnType<typeof vi.spyOn> | undefined;
let killSpy: ReturnType<typeof vi.spyOn> | undefined;
type StartedRecord = { pid: number; process_start_identity: string; process_group_id?: number };
type ControlledRecord = { attempt: string; transport: string | null; provider_pid: number; child_pid: number };

/** Undo the writer's single-quote shell escaping for one env assignment. */
function extractEnvAssignment(command: string, key: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)${key}=('(?:[^']|'"'"')*')`);
  const match = command.match(pattern);
  if (!match) return undefined;
  return match[1]!.slice(1, -1).replace(/'"'"'/g, "'");
}

/** Simulate the pane shell: apply the writer's env assignments to process.env. */
function applyEnvAssignments(command: string, keys: readonly string[]): void {
  for (const key of keys) {
    const value = extractEnvAssignment(command, key);
    if (value !== undefined) process.env[key] = value;
  }
}

async function makeAttempt(): Promise<WorkerLaunchAttempt> {
  cwd = await mkdtemp(join(tmpdir(), 'worker-launch-posix-transport-'));
  restoreFixtureEnv = isolateFixtureEnv(cwd);
  return prepareWorkerLaunchAttempt({
    cwd,
    teamName: 'posix-team',
    workerName: 'worker-1',
    paneId: '%2',
    provider: 'codex',
    runtimeCliPath: '/runtime-cli.cjs',
  });
}

function isolateFixtureEnv(root: string): () => void {
  const home = process.env.HOME;
  const userProfile = process.env.USERPROFILE;
  const stateDir = process.env.OMC_STATE_DIR;
  const teamWorker = process.env.OMC_TEAM_WORKER;
  const attemptId = process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  delete process.env.OMC_STATE_DIR;
  return () => {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    if (userProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = userProfile;
    if (stateDir === undefined) delete process.env.OMC_STATE_DIR;
    else process.env.OMC_STATE_DIR = stateDir;
    if (teamWorker === undefined) delete process.env.OMC_TEAM_WORKER;
    else process.env.OMC_TEAM_WORKER = teamWorker;
    if (attemptId === undefined) delete process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID;
    else process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID = attemptId;
  };
}

afterEach(async () => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  originalPlatform = undefined;
  exitSpy?.mockRestore();
  exitSpy = undefined;
  killSpy?.mockRestore();
  killSpy = undefined;
  for (const key of ['OMC_WORKER_LAUNCH_SPEC', 'OMC_WORKER_LAUNCH_SPEC_B64', 'OMC_WORKER_LAUNCH_SPEC_FILE']) {
    delete process.env[key];
  }
  vi.unstubAllEnvs();
  const restore = restoreFixtureEnv;
  restoreFixtureEnv = undefined;
  try {
    restore?.();
  } finally {
    if (cwd) await rm(cwd, { recursive: true, force: true });
    cwd = '';
  }
});

describe('POSIX supervised worker-launch transport (issue #3655)', () => {
  it.runIf(process.platform !== 'win32')('supervised POSIX writer materializes a descriptor the runtime CLI reader accepts and executes', async () => {
    vi.stubEnv('SHELL', '/bin/bash');

    const attempt = await makeAttempt();
    const providerMarker = join(cwd, 'provider-ran.json');
    const providerScript = [
      "const fs=require('node:fs')",
      "const cp=require('node:child_process')",
      "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
      `fs.writeFileSync(${JSON.stringify(providerMarker)},JSON.stringify({attempt:process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID,transport:process.env.OMC_WORKER_LAUNCH_SPEC_FILE??null,provider_pid:process.pid,child_pid:child.pid}))`,
      'setInterval(()=>{},1000)',
    ].join(';');
    const config = {
      teamName: 'posix-team',
      workerName: 'worker-1',
      envVars: {
        OMC_TEAM_WORKER: 'posix-team/worker-1',
        OMC_WORKER_LAUNCH_ATTEMPT_ID: attempt.attempt_id,
      },
      launchBinary: process.execPath,
      launchArgs: ['-e', providerScript],
      cwd,
      provider: 'codex' as const,
      launchAttempt: attempt,
    };

    let materialized: Awaited<ReturnType<typeof materializeWorkerLaunchTransport>> | undefined;
    let bootstrap: Promise<unknown> | undefined;
    let startedRecord: StartedRecord | undefined;
    let controlledIdentities: { provider: string; child: string } | undefined;
    try {
      // The writer seam (spawnWorkerInPane) materializes the attempt transport
      // before building the start command — identical to the native Windows path.
      materialized = await materializeWorkerLaunchTransport({
        attempt,
        providerArgv: [process.execPath, '-e', providerScript],
        cwd,
        providerEnv: config.envVars,
      });
      const startCmd = buildWorkerStartCommand(config);

      // Writer contract: the delivered POSIX command references the attempt-owned
      // descriptor; it must NOT inline the bootstrap spec (secrets stay off the
      // process list and out of tmux scrollback; command size stays small).
      const descriptorPath = extractEnvAssignment(startCmd, 'OMC_WORKER_LAUNCH_SPEC_FILE');
      expect(descriptorPath).toBe(materialized.bootstrapDescriptorPath);
      expect(startCmd).not.toContain('OMC_WORKER_LAUNCH_SPEC=');
      expect(startCmd).not.toContain(providerScript);
      expect(Buffer.byteLength(startCmd, 'utf8')).toBeLessThan(2_048);

      // Reader contract: run the runtime CLI exactly as the pane would, with the
      // env assignments the writer emitted.
      applyEnvAssignments(startCmd, ['OMC_WORKER_LAUNCH_SPEC_FILE', 'OMC_TEAM_WORKER', 'OMC_WORKER_LAUNCH_ATTEMPT_ID']);
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const nativeKill = process.kill.bind(process);
      let forwardedSignal: string | undefined;
      killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        // The runtime CLI forwards a provider signal to its own PID after the
        // owned group has been terminated. Keep that adapter call inside this
        // test process, while preserving every native probe and other-PID
        // signal (including process.kill(-group, 0)).
        if (pid === process.pid && typeof signal === 'string' && signal.startsWith('SIG')) {
          forwardedSignal = signal;
          return true;
        }
        return nativeKill(pid, signal);
      });

      bootstrap = runWorkerLaunchFromEnvironment();
      await expect(awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 5_000, pollIntervalMs: 5 }))
        .resolves.toEqual({ ok: true });
      await expect(awaitWorkerLaunchProviderStarted(attempt, { timeoutMs: 2_000, pollIntervalMs: 5 }))
        .resolves.toBe(true);
      const started = JSON.parse(await readFile(attempt.startedPath, 'utf8')) as StartedRecord;
      startedRecord = started;

      // The validated bootstrap ran: the provider stub executed and saw the
      // attempt identity while the internal descriptor env var stayed filtered.
      const controlledRecord = JSON.parse(await readFile(providerMarker, 'utf8')) as ControlledRecord;
      expect(controlledRecord.provider_pid).toBeGreaterThan(0);
      expect(controlledRecord.child_pid).toBeGreaterThan(0);
      expect(controlledRecord.provider_pid).not.toBe(started.pid);
      expect(controlledRecord.attempt).toBe(attempt.attempt_id);
      expect(controlledRecord.transport).toBeNull();
      const [providerIdentity, childIdentity] = await Promise.all([
        getProcessStartIdentity(controlledRecord.provider_pid),
        getProcessStartIdentity(controlledRecord.child_pid),
      ]);
      expect(providerIdentity).toBeTruthy();
      expect(childIdentity).toBeTruthy();
      controlledIdentities = { provider: providerIdentity!, child: childIdentity! };

      await expect(terminateWorkerLaunchProvider(attempt, 2_000)).resolves.toBe(true);
      await expect(bootstrap).resolves.toBeUndefined();
      expect(forwardedSignal).toBe('SIGKILL');
      await expect.poll(() => isProcessAlive(controlledRecord.provider_pid), { timeout: 2_000, interval: 20 }).toBe(false);
      await expect.poll(() => isProcessAlive(controlledRecord.child_pid), { timeout: 2_000, interval: 20 }).toBe(false);
      await expect.poll(
        () => isProcessIdentityLive(controlledRecord.provider_pid, controlledIdentities!.provider),
        { timeout: 2_000, interval: 20 },
      ).toMatch(/dead|mismatch/);
      await expect.poll(
        () => isProcessIdentityLive(controlledRecord.child_pid, controlledIdentities!.child),
        { timeout: 2_000, interval: 20 },
      ).toMatch(/dead|mismatch/);
      expect(() => process.kill(-started.process_group_id!, 0))
        .toThrow(expect.objectContaining({ code: 'ESRCH' }));

      // Consume semantics: the runtime CLI consumed the descriptor after
      // validation; the transport owner/wrapper remain until explicit retire.
      await expect(readFile(materialized.bootstrapDescriptorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(cleanupWorkerLaunchTransport(attempt, 'test_cleanup')).resolves.toBe(true);
      await expect(readFile(materialized.wrapperPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      try {
        if (attempt && !startedRecord) {
          const launchAttempt = attempt;
          const started = await awaitWorkerLaunchProviderStarted(launchAttempt, { timeoutMs: 2_000, pollIntervalMs: 5 })
            .then(async present => present ? JSON.parse(await readFile(launchAttempt.startedPath, 'utf8')) as StartedRecord : undefined)
            .catch(() => undefined);
          if (started) startedRecord = started;
        }
        if (attempt) await terminateWorkerLaunchProvider(attempt, 2_000).catch(() => false);
        if (bootstrap) await bootstrap.catch(() => undefined);
        if (startedRecord) {
          await vi.waitFor(() => {
            expect(isProcessAlive(startedRecord!.pid)).toBe(false);
            if (startedRecord!.process_group_id !== undefined) {
              expect(() => process.kill(-startedRecord!.process_group_id!, 0))
                .toThrow(expect.objectContaining({ code: 'ESRCH' }));
            }
          }, { timeout: 2_000, interval: 20 });
        }
        if (attempt) await cleanupWorkerLaunchTransport(attempt, 'test_cleanup_finally').catch(() => false);
      } finally {
        killSpy?.mockRestore();
        killSpy = undefined;
      }
    }
  });

  it('accepts the materialized descriptor and consumes it exactly once', async () => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const attempt = await makeAttempt();
    const materialized = await materializeWorkerLaunchTransport({
      attempt,
      providerArgv: [process.execPath, '-e', 'process.exit(0)'],
      cwd,
    });

    const consumed = await readAndConsumeWorkerLaunchDescriptor(materialized.bootstrapDescriptorPath) as Record<string, unknown>;
    expect(consumed).toMatchObject({ attempt_id: attempt.attempt_id, provider: 'codex' });
    // Second consume fails closed: the descriptor is gone.
    await expect(readAndConsumeWorkerLaunchDescriptor(materialized.bootstrapDescriptorPath))
      .rejects.toThrow('worker_launch_descriptor_missing');
    await expect(cleanupWorkerLaunchTransport(attempt, 'test_cleanup_after_consume')).resolves.toBe(true);
  });

  it('keeps descriptor/source conflict and invalid JSON fail-closed at the runtime CLI', async () => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux' });

    process.env.OMC_WORKER_LAUNCH_SPEC = '{"provider_argv":["codex"],';
    await expect(runWorkerLaunchFromEnvironment()).rejects.toThrow('worker_launch_invalid_spec_json');
    delete process.env.OMC_WORKER_LAUNCH_SPEC;

    process.env.OMC_WORKER_LAUNCH_SPEC = '{}';
    process.env.OMC_WORKER_LAUNCH_SPEC_FILE = join(cwd ?? '', 'conflicting-worker-launch.json');
    await expect(runWorkerLaunchFromEnvironment()).rejects.toThrow('worker_launch_spec_source_conflict');
    delete process.env.OMC_WORKER_LAUNCH_SPEC;
    delete process.env.OMC_WORKER_LAUNCH_SPEC_FILE;

    // An inline-only spec (the pre-fix POSIX writer behavior) stays rejected.
    process.env.OMC_WORKER_LAUNCH_SPEC = '{"provider_argv":["codex"]}';
    await expect(runWorkerLaunchFromEnvironment()).rejects.toThrow('worker_launch_descriptor_required');
  });

  it('delivers a bounded command for a provider environment with a large value', async () => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.stubEnv('SHELL', '/bin/bash');

    const attempt = await makeAttempt();
    const longValue = `long-${'x'.repeat(12_000)}`;
    // A large provider argv/env is written into the attempt descriptor, exactly
    // as the supervised writer does; the delivered command must only reference
    // the descriptor path and stay small (issue #3655).
    const materialized = await materializeWorkerLaunchTransport({
      attempt,
      providerArgv: [process.execPath, '--token', longValue],
      providerEnv: { OMC_TEAM_WORKER: 'posix-team/worker-1', PROVIDER_LONG: longValue },
      cwd,
    });
    expect(Buffer.byteLength(await readFile(materialized.bootstrapDescriptorPath, 'utf8'), 'utf8')).toBeGreaterThan(12_000);

    const startCmd = buildWorkerStartCommand({
      teamName: 'posix-team',
      workerName: 'worker-1',
      envVars: { OMC_TEAM_WORKER: 'posix-team/worker-1' },
      launchBinary: process.execPath,
      launchArgs: ['--version'],
      cwd,
      provider: 'codex',
      launchAttempt: attempt,
    });

    const descriptorPath = extractEnvAssignment(startCmd, 'OMC_WORKER_LAUNCH_SPEC_FILE');
    expect(descriptorPath).toBe(attempt.bootstrapDescriptorPath);
    expect(startCmd).not.toContain(longValue);
    expect(Buffer.byteLength(startCmd, 'utf8')).toBeLessThan(2_048);
  });
});
