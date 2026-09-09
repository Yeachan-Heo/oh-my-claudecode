import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import * as processUtils from '../../platform/process-utils.js';
import {
  awaitWorkerLaunchAcknowledgement,
  awaitWorkerLaunchProviderStarted,
  buildWorkerLaunchBootstrapSpec,
  buildWindowsSupervisorSource,
  cleanupWorkerLaunchTransport,
  isWorkerLaunchAttemptAccepted,
  isWorkerLaunchProviderStarted,
  loadWorkerLaunchAttempt,
  loadCurrentWorkerLaunchAttempt,
  prepareWorkerLaunchAttempt,
  materializeWorkerLaunchTransport,
  runWorkerLaunchBootstrap,
  readAndConsumeWorkerLaunchDescriptor,
  retireWorkerLaunchAttempt,
  retireAndCleanupCurrentWorkerLaunchAttempt,
  terminateWorkerLaunchProvider,
  revokeWorkerLaunchAttempt,
  withWorkerLaunchAttemptFence,
  buildProviderEnvironment,
  buildProviderSpawnInvocation,
  materializeProviderSpawnInvocation,
  quoteWindowsCreateProcessArgument,
} from '../worker-launch-ack.js';
import {
  captureOwnedProcessGroup,
  getProcessStartIdentity,
  isProcessAlive,
  terminateOwnedProcessGroup,
  terminateOwnedProcessTree,
} from '../../platform/process-utils.js';
import { getOmcRoot } from '../../lib/worktree-paths.js';

let cwd = '';
const disposableProviders = new Set<ReturnType<typeof spawn>>();
let fixtureEnvCaptured = false;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalStateDir: string | undefined;

function isolateFixtureRoot(root: string): void {
  if (!fixtureEnvCaptured) {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalStateDir = process.env.OMC_STATE_DIR;
    fixtureEnvCaptured = true;
  }
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  delete process.env.OMC_STATE_DIR;
}

async function createFixture(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  isolateFixtureRoot(root);
  return root;
}

function restoreFixtureEnv(): void {
  if (!fixtureEnvCaptured) return;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalStateDir === undefined) delete process.env.OMC_STATE_DIR;
  else process.env.OMC_STATE_DIR = originalStateDir;
  fixtureEnvCaptured = false;
  originalHome = undefined;
  originalUserProfile = undefined;
  originalStateDir = undefined;
}
async function removeFixtureDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  await rm(dir, { recursive: true, force: true });
}


afterEach(async () => {
  for (const child of [...disposableProviders]) await stopDisposableProvider(child).catch(() => undefined);
  restoreFixtureEnv();
  if (cwd) await removeFixtureDir(cwd);
  cwd = '';
});

async function attempt() {
  cwd = await createFixture('worker-launch-ack-');
  return prepareWorkerLaunchAttempt({
    cwd,
    teamName: 'launch-team',
    workerName: 'worker-1',
    paneId: '%2',
    provider: 'codex',
    runtimeCliPath: '/runtime-cli.cjs',
  });
}

async function spawnDisposableProvider(): Promise<{
  child: ReturnType<typeof spawn>;
  pid: number;
  processStartIdentity: string;
  processGroupId: number;
}> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  const pid = child.pid;
  if (!pid) throw new Error('disposable_provider_pid_missing');
  const processStartIdentity = await getProcessStartIdentity(pid);
  const ownedGroup = captureOwnedProcessGroup(pid);
  if (!processStartIdentity || (process.platform !== 'win32' && !ownedGroup)) {
    child.kill('SIGKILL');
    throw new Error('disposable_provider_identity_missing');
  }
  child.unref();
  disposableProviders.add(child);
  return {
    child,
    pid,
    processStartIdentity,
    processGroupId: ownedGroup?.processGroupId ?? 1,
  };
}

async function stopDisposableProvider(child: ReturnType<typeof spawn>): Promise<void> {
  try {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 500);
      timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } finally {
    disposableProviders.delete(child);
  }
}

describe('worker launch acknowledgement', () => {
  it('accepts only the exact child-written acknowledgement before running the provider', async () => {
    const launchAttempt = await attempt();
    const stopPath = join(cwd, 'provider-stop');
    const spec = buildWorkerLaunchBootstrapSpec(
      launchAttempt,
      [process.execPath, '-e', `const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopPath)}))process.exit(0)},10)`],
      cwd,
    );

    const bootstrap = runWorkerLaunchBootstrap(spec);
    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
    })).resolves.toEqual({ ok: true });
    await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
      timeoutMs: 10_000,
      pollIntervalMs: 5,
    })).resolves.toBe(true);
    await writeFile(stopPath, 'stop', 'utf8');
    await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
    await expect(isWorkerLaunchAttemptAccepted(launchAttempt)).resolves.toBe(true);

    const decision = JSON.parse(await readFile(launchAttempt.decisionPath, 'utf8'));
    expect(decision).toMatchObject({
      kind: 'worker_launch_decision',
      decision: 'accepted',
      attempt_id: launchAttempt.attempt_id,
      nonce: launchAttempt.nonce,
      pane_id: '%2',
    });
  });

  it.each([
    ['zero pid', 0, 'identity'],
    ['negative pid', -1, 'identity'],
    ['empty identity', process.pid, ''],
    ['stale identity', process.pid, 'stale:identity'],
  ])('rejects %s provider-start handoff evidence', async (_case, pid, processStartIdentity) => {
    const launchAttempt = await attempt();
    await writeFile(launchAttempt.ackPath, JSON.stringify({
      schema_version: launchAttempt.schema_version,
      attempt_id: launchAttempt.attempt_id,
      nonce: launchAttempt.nonce,
      team_name: launchAttempt.team_name,
      worker_name: launchAttempt.worker_name,
      pane_id: launchAttempt.pane_id,
      provider: launchAttempt.provider,
      created_at: launchAttempt.created_at,
      kind: 'worker_launch_ack',
      written_at: new Date().toISOString(),
    }), 'utf8');
    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
      timeoutMs: 500,
      pollIntervalMs: 5,
    })).resolves.toEqual({ ok: true });
    await writeFile(launchAttempt.startedPath, JSON.stringify({
      schema_version: launchAttempt.schema_version,
      attempt_id: launchAttempt.attempt_id,
      nonce: launchAttempt.nonce,
      team_name: launchAttempt.team_name,
      worker_name: launchAttempt.worker_name,
      pane_id: launchAttempt.pane_id,
      provider: launchAttempt.provider,
      created_at: launchAttempt.created_at,
      kind: 'worker_launch_provider_started',
      pid,
      process_start_identity: processStartIdentity,
      written_at: new Date().toISOString(),
    }), 'utf8');
    await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
      timeoutMs: 50,
      pollIntervalMs: 5,
    })).resolves.toBe(false);
  });

  it('rejects supervised provider-start evidence after its completion marker exists', async () => {
    const launchAttempt = await attempt();
    const identity = await getProcessStartIdentity(process.pid);
    const completionPath = join(cwd, 'provider-exit.txt');
    const base = {
      schema_version: launchAttempt.schema_version, attempt_id: launchAttempt.attempt_id, nonce: launchAttempt.nonce,
      team_name: launchAttempt.team_name, worker_name: launchAttempt.worker_name, pane_id: launchAttempt.pane_id,
      provider: launchAttempt.provider, created_at: launchAttempt.created_at,
    };
    await writeFile(launchAttempt.ackPath, JSON.stringify({ ...base, kind: 'worker_launch_ack', written_at: new Date().toISOString() }), 'utf8');
    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 500, pollIntervalMs: 5 })).resolves.toEqual({ ok: true });
    await writeFile(completionPath, '0\r\n', 'utf8');
    await writeFile(launchAttempt.startedPath, JSON.stringify({ ...base, kind: 'worker_launch_provider_started',
      pid: process.pid, process_start_identity: identity, supervisor_completion_path: completionPath,
      written_at: new Date().toISOString() }), 'utf8');
    await expect(awaitWorkerLaunchProviderStarted(launchAttempt, { timeoutMs: 50, pollIntervalMs: 5 })).resolves.toBe(false);
  });

  it('rejects a provider that exits after publishing start evidence but before handoff', async () => {
    const launchAttempt = await attempt();
    const stopPath = join(cwd, 'exit-after-start');
    const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
      launchAttempt,
      [process.execPath, '-e', `const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopPath)}))process.exit(0)},10)`],
      cwd,
    ));
    try {
      await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
        timeoutMs: 2_000,
        pollIntervalMs: 5,
      })).resolves.toEqual({ ok: true });
      await vi.waitFor(async () => {
        await expect(isWorkerLaunchProviderStarted(launchAttempt)).resolves.toBe(true);
      }, { timeout: 2_000, interval: 5 });
      await writeFile(stopPath, 'exit', 'utf8');
      await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
      await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
        timeoutMs: 50,
        pollIntervalMs: 5,
      })).resolves.toBe(false);
    } finally {
      await writeFile(stopPath, 'exit', 'utf8');
      await terminateWorkerLaunchProvider(launchAttempt, 2_000);
      await bootstrap;
    }
  });

  it('kills provider descendants when the provider exits after start publication', async () => {
    const launchAttempt = await attempt();
    const childPidPath = join(cwd, 'early-exit-child-pid');
    const providerReadyPath = join(cwd, 'early-exit-provider-ready');
    const providerStopPath = join(cwd, 'early-exit-provider-stop');
    const providerScript = [
      "const fs=require('node:fs')",
      "const cp=require('node:child_process')",
      "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref()",
      `child.once('spawn',()=>fs.writeFileSync(${JSON.stringify(childPidPath)},JSON.stringify({parent:process.pid,child:child.pid})))`,
      `child.once('spawn',()=>fs.writeFileSync(${JSON.stringify(providerReadyPath)},'ready'))`,
      `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(providerStopPath)})){clearInterval(timer);process.exit(0)}},5)`,
    ].join(';');
    let bootstrap: ReturnType<typeof runWorkerLaunchBootstrap> | undefined;
    try {
      bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
        launchAttempt,
        [process.execPath, '-e', providerScript],
        cwd,
        { releaseAfterSpawn: true },
      ));
      await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
        timeoutMs: 2_000,
        pollIntervalMs: 5,
      })).resolves.toEqual({ ok: true });
      await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
        timeoutMs: 2_000,
        pollIntervalMs: 5,
      })).resolves.toBe(true);
      await vi.waitFor(async () => {
        await expect(readFile(providerReadyPath, 'utf8')).resolves.toBe('ready');
      }, { timeout: 2_000, interval: 5 });
      const pids = JSON.parse(await readFile(childPidPath, 'utf8')) as { parent: number; child: number };
      expect(pids.parent).toBeGreaterThan(0);
      expect(pids.child).toBeGreaterThan(0);
      await writeFile(providerStopPath, 'stop', 'utf8');

      await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
      await vi.waitFor(() => {
        expect(isProcessAlive(pids.parent)).toBe(false);
        expect(isProcessAlive(pids.child)).toBe(false);
      }, { timeout: 2_000, interval: 20 });
      const terminal = JSON.parse(await readFile(`${launchAttempt.startedPath}.terminal`, 'utf8')) as {
        kind: string;
        outcome: string;
        cleanup_verified: boolean;
        process_group_id: number;
      };
      expect(terminal).toMatchObject({
        kind: 'worker_launch_provider_terminal',
        outcome: 'exit',
        cleanup_verified: true,
      });
      expect(Number.isSafeInteger(terminal.process_group_id)).toBe(true);
      expect(() => process.kill(-terminal.process_group_id, 0))
        .toThrow(expect.objectContaining({ code: 'ESRCH' }));
      expect(isProcessAlive(process.pid)).toBe(true);
    } finally {
      await writeFile(providerStopPath, 'stop', 'utf8').catch(() => undefined);
      await terminateWorkerLaunchProvider(launchAttempt, 2_000).catch(() => false);
      await bootstrap?.catch(() => undefined);
    }
  });

  it.runIf(process.platform !== 'win32')(
    'proves native group absence without durable termination records',
    async () => {
      const launchAttempt = await attempt();
      const providerReadyPath = join(cwd, 'native-direct-termination-ready');
      const providerScript = [
        `require('node:fs').writeFileSync(${JSON.stringify(providerReadyPath)},'ready')`,
        'setInterval(()=>{},1000)',
      ].join(';');
      let bootstrap: ReturnType<typeof runWorkerLaunchBootstrap> | undefined;
      let ownedGroup: ReturnType<typeof captureOwnedProcessGroup> = null;
      try {
        bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
          launchAttempt,
          [process.execPath, '-e', providerScript],
          cwd,
          { releaseAfterSpawn: true },
        ));
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
          timeoutMs: 2_000,
          pollIntervalMs: 5,
        })).resolves.toEqual({ ok: true });
        await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
          timeoutMs: 2_000,
          pollIntervalMs: 5,
        })).resolves.toBe(true);
        await vi.waitFor(async () => {
          await expect(readFile(providerReadyPath, 'utf8')).resolves.toBe('ready');
        }, { timeout: 2_000, interval: 5 });

        const fenced = await withWorkerLaunchAttemptFence(launchAttempt, async () => {
          const started = JSON.parse(await readFile(launchAttempt.startedPath, 'utf8')) as {
            pid: number;
            process_start_identity: string;
            process_group_id: number;
          };
          expect(isProcessAlive(started.pid)).toBe(true);
          ownedGroup = captureOwnedProcessGroup(started.pid);
          expect(ownedGroup).toMatchObject({
            pid: started.pid,
            processStartIdentity: started.process_start_identity,
            processGroupId: started.process_group_id,
          });
          if (!ownedGroup) throw new Error('worker_launch_owned_group_capture_failed');
          return await terminateOwnedProcessGroup({
            pid: ownedGroup.pid,
            expectedStartIdentity: ownedGroup.processStartIdentity,
            processGroupId: ownedGroup.processGroupId,
            deadlineAt: new Date(Date.now() + 2_000).toISOString(),
            force: true,
          });
        });
        expect(fenced).toMatchObject({ ok: true, value: 'terminated' });
        await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: null, signal: 'SIGKILL' });
        await expect(readFile(`${launchAttempt.startedPath}.termination-request`, 'utf8'))
          .rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(`${launchAttempt.startedPath}.termination-complete`, 'utf8'))
          .rejects.toMatchObject({ code: 'ENOENT' });

        const terminal = JSON.parse(await readFile(`${launchAttempt.startedPath}.terminal`, 'utf8')) as {
          kind: string;
          outcome: string;
          cleanup_verified: boolean;
          process_group_id: number;
          signal: string | null;
        };
        expect(terminal).toMatchObject({
          kind: 'worker_launch_provider_terminal',
          outcome: 'exit',
          cleanup_verified: true,
          process_group_id: ownedGroup!.processGroupId,
          signal: 'SIGKILL',
        });
        expect(() => process.kill(-ownedGroup!.processGroupId, 0))
          .toThrow(expect.objectContaining({ code: 'ESRCH' }));
      } finally {
        // The fence callback assigns this handle; retain its declared type
        // rather than TypeScript's pre-callback null narrowing.
        const cleanupGroup = ownedGroup as ReturnType<typeof captureOwnedProcessGroup>;
        if (cleanupGroup) {
          await terminateOwnedProcessGroup({
            pid: cleanupGroup.pid,
            expectedStartIdentity: cleanupGroup.processStartIdentity,
            processGroupId: cleanupGroup.processGroupId,
            deadlineAt: new Date(Date.now() + 2_000).toISOString(),
            force: true,
          }).catch(() => 'unknown');
        } else {
          await terminateWorkerLaunchProvider(launchAttempt, 2_000).catch(() => false);
        }
        await bootstrap?.catch(() => undefined);
        if (ownedGroup) {
          await vi.waitFor(() => {
            expect(() => process.kill(-ownedGroup!.processGroupId, 0))
              .toThrow(expect.objectContaining({ code: 'ESRCH' }));
          }, { timeout: 2_000, interval: 20 });
        }
      }
    },
  );

  it('revokes a timed-out attempt and treats a later acknowledgement as losing evidence', async () => {
    const launchAttempt = await attempt();
    const providerMarker = join(cwd, 'provider-ran');
    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
      timeoutMs: 20,
      pollIntervalMs: 5,
    })).resolves.toEqual({ ok: false, reason: 'ack_timeout' });

    const spec = buildWorkerLaunchBootstrapSpec(
      launchAttempt,
      [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran')`],
      cwd,
    );
    await expect(runWorkerLaunchBootstrap(spec)).resolves.toEqual({ outcome: 'revoked' });
    await expect(readFile(providerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(isWorkerLaunchAttemptAccepted(launchAttempt)).resolves.toBe(false);

    const decision = JSON.parse(await readFile(launchAttempt.decisionPath, 'utf8'));
    expect(decision).toMatchObject({ decision: 'revoked', reason: 'ack_timeout' });
  });

  it('rejects a mismatched nonce and seals the attempt against later acceptance', async () => {
    const launchAttempt = await attempt();
    const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
    await writeFile(launchAttempt.ackPath, JSON.stringify({
      ...expected,
      kind: 'worker_launch_ack',
      nonce: '00000000-0000-4000-8000-000000000000',
      written_at: new Date().toISOString(),
    }), 'utf8');

    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
      timeoutMs: 100,
      pollIntervalMs: 5,
    })).resolves.toEqual({ ok: false, reason: 'ack_mismatch' });
    await expect(isWorkerLaunchAttemptAccepted(launchAttempt)).resolves.toBe(false);
  });

  it('rejects malformed acknowledgement bytes and records a terminal revocation', async () => {
    const launchAttempt = await attempt();
    await writeFile(launchAttempt.ackPath, '{not-json', 'utf8');

    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
      timeoutMs: 100,
      pollIntervalMs: 5,
    })).resolves.toEqual({ ok: false, reason: 'ack_malformed' });
    await expect(isWorkerLaunchAttemptAccepted(launchAttempt)).resolves.toBe(false);
    const decision = JSON.parse(await readFile(launchAttempt.decisionPath, 'utf8'));
    expect(decision).toMatchObject({ decision: 'revoked', reason: 'ack_malformed' });
  });

  it('does not clean a superseded or expected-only current launch attempt', async () => {
    const accepted = await attempt();
    await writeFile(accepted.ackPath, JSON.stringify({
      schema_version: accepted.schema_version, attempt_id: accepted.attempt_id, nonce: accepted.nonce,
      team_name: accepted.team_name, worker_name: accepted.worker_name, pane_id: accepted.pane_id,
      provider: accepted.provider, created_at: accepted.created_at, kind: 'worker_launch_ack', written_at: new Date().toISOString(),
    }), 'utf8');
    await expect(awaitWorkerLaunchAcknowledgement(accepted, { timeoutMs: 500, pollIntervalMs: 5 })).resolves.toEqual({ ok: true });
    await expect(retireWorkerLaunchAttempt(accepted, 'superseded')).resolves.toBe(true);
    const successor = await prepareWorkerLaunchAttempt({
      cwd, teamName: accepted.team_name, workerName: accepted.worker_name, paneId: '%3',
      provider: accepted.provider, runtimeCliPath: accepted.runtimeCliPath,
    });
    const cleanup = vi.fn(async () => true);
    await expect(retireAndCleanupCurrentWorkerLaunchAttempt(accepted, 'stale_cleanup', cleanup)).resolves.toBe(false);
    await expect(retireAndCleanupCurrentWorkerLaunchAttempt(successor, 'expected_only_cleanup', cleanup)).resolves.toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('reuses exact durable cleanup-complete evidence without touching a successor or pane again', async () => {
    const launchAttempt = await attempt();
    const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
    await writeFile(launchAttempt.ackPath, JSON.stringify({ ...expected, kind: 'worker_launch_ack', written_at: new Date().toISOString() }), 'utf8');
    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 500, pollIntervalMs: 5 })).resolves.toEqual({ ok: true });
    await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({ ...expected,
      kind: 'worker_launch_provider_terminal', outcome: 'exit', cleanup_verified: true,
      pid: 999_999, process_start_identity: '1',
      ...(process.platform !== 'win32' ? { process_group_id: 999_999 } : {}),
      written_at: new Date().toISOString() }), 'utf8');
    const firstCleanup = vi.fn(async () => true);
    await expect(retireAndCleanupCurrentWorkerLaunchAttempt(launchAttempt, 'partial_shutdown', firstCleanup)).resolves.toBe(true);
    expect(firstCleanup).toHaveBeenCalledOnce();
    const retryCleanup = vi.fn(async () => true);
    await expect(retireAndCleanupCurrentWorkerLaunchAttempt(launchAttempt, 'partial_shutdown_retry', retryCleanup)).resolves.toBe(true);
    expect(retryCleanup).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== 'win32')('does not synthesize completion from an already-dead retry after a prior request', async () => {
    const launchAttempt = await attempt();
    const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
    await writeFile(launchAttempt.startedPath, JSON.stringify({ ...expected,
      kind: 'worker_launch_provider_started', pid: 999_999_999, process_start_identity: '1',
      process_group_id: 999_999_999, written_at: new Date().toISOString() }), 'utf8');
    await writeFile(`${launchAttempt.startedPath}.termination-request`, JSON.stringify({ ...expected,
      kind: 'worker_launch_termination_request', pid: 999_999_999,
      process_start_identity: '1', containment_nonce: launchAttempt.nonce,
      written_at: new Date().toISOString() }), 'utf8');

    await expect(terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
    await expect(readFile(`${launchAttempt.startedPath}.termination-complete`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not treat a reused provider PID as cleaned without terminal descendant proof', async () => {
    const launchAttempt = await attempt();
    const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
    const currentIdentity = await getProcessStartIdentity(process.pid);
    expect(currentIdentity).toMatch(/^\d+$/);
    const staleIdentity = String(BigInt(currentIdentity!) + 1n);
    await writeFile(launchAttempt.ackPath, JSON.stringify({ ...expected, kind: 'worker_launch_ack', written_at: new Date().toISOString() }), 'utf8');
    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 500, pollIntervalMs: 5 })).resolves.toEqual({ ok: true });
    await writeFile(launchAttempt.startedPath, JSON.stringify({ ...expected, kind: 'worker_launch_provider_started',
      pid: process.pid, process_start_identity: staleIdentity, written_at: new Date().toISOString() }), 'utf8');
    await expect(terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
    expect(isProcessAlive(process.pid)).toBe(true);
    await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({ ...expected,
      kind: 'worker_launch_provider_terminal', outcome: 'exit', cleanup_verified: true,
      pid: process.pid, process_start_identity: staleIdentity, written_at: new Date().toISOString() }), 'utf8');
    await expect(terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(currentIdentity).toBeTruthy();
    await writeFile(launchAttempt.startedPath, JSON.stringify({ ...expected, kind: 'worker_launch_provider_started',
      pid: process.pid, process_start_identity: currentIdentity, written_at: new Date().toISOString() }), 'utf8');
    await expect(terminateWorkerLaunchProvider(launchAttempt, 0)).resolves.toBe(false);
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('rejects terminal cleanup proof bound to the wrong process group', async () => {
    const launchAttempt = await attempt();
    const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
    const currentIdentity = await getProcessStartIdentity(process.pid);
    await writeFile(launchAttempt.startedPath, JSON.stringify({ ...expected,
      kind: 'worker_launch_provider_started', pid: process.pid,
      process_start_identity: currentIdentity, process_group_id: 999_998,
      written_at: new Date().toISOString() }), 'utf8');
    await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({ ...expected,
      kind: 'worker_launch_provider_terminal', outcome: 'exit', cleanup_verified: true,
      pid: process.pid, process_start_identity: currentIdentity, process_group_id: 999_999,
      written_at: new Date().toISOString() }), 'utf8');

    await expect(terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('rejects malformed terminal and provider-start records as cleanup authority', async () => {
    const launchAttempt = await attempt();
    const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
    await writeFile(launchAttempt.ackPath, JSON.stringify({ ...expected,
      kind: 'worker_launch_ack', written_at: new Date().toISOString() }), 'utf8');
    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 500, pollIntervalMs: 5 }))
      .resolves.toEqual({ ok: true });
    await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({ ...expected,
      kind: 'not_a_provider_terminal', outcome: 'exit', cleanup_verified: true,
      pid: 999_999, process_start_identity: '1', written_at: new Date().toISOString() }), 'utf8');
    await expect(terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);

    await writeFile(launchAttempt.startedPath, JSON.stringify({ ...expected,
      kind: 'worker_launch_provider_started', pid: 0, process_start_identity: '', written_at: new Date().toISOString() }), 'utf8');
    await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({ ...expected,
      kind: 'worker_launch_provider_terminal', outcome: 'exit', cleanup_verified: true,
      pid: 999_999, process_start_identity: '1', written_at: new Date().toISOString() }), 'utf8');
    await expect(terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
  });

  it.runIf(process.platform !== 'win32')('signals only a live provider when no terminal evidence exists', async () => {
    vi.resetModules();
    const dynamicProcessUtils = await import('../../platform/process-utils.js');
    const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
      .mockResolvedValue('identity-mismatch');
    const workerLaunch = await import('../worker-launch-ack.js');
    let disposable: Awaited<ReturnType<typeof spawnDisposableProvider>> | undefined;
    try {
      const launchAttempt = await attempt();
      const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
      disposable = await spawnDisposableProvider();
      await writeFile(launchAttempt.startedPath, JSON.stringify({
        ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
        process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
        written_at: new Date().toISOString(),
      }), 'utf8');

      await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
      expect(terminateSpy).toHaveBeenCalledOnce();
    } finally {
      if (disposable) await stopDisposableProvider(disposable.child);
      terminateSpy.mockRestore();
      vi.resetModules();
    }
  });

  it.runIf(process.platform !== 'win32')('accepts verified terminal cleanup without signaling its provider PID', async () => {
    vi.resetModules();
    const dynamicProcessUtils = await import('../../platform/process-utils.js');
    const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
      .mockResolvedValue('terminated');
    const workerLaunch = await import('../worker-launch-ack.js');
    let disposable: Awaited<ReturnType<typeof spawnDisposableProvider>> | undefined;
    try {
      const launchAttempt = await attempt();
      const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
      disposable = await spawnDisposableProvider();
      const started = {
        ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
        process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
        written_at: new Date().toISOString(),
      };
      await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
      await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({
        ...started, kind: 'worker_launch_provider_terminal', outcome: 'exit', cleanup_verified: true,
        child_reaped: true,
      }), 'utf8');

      await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(true);
      expect(terminateSpy).not.toHaveBeenCalled();
    } finally {
      if (disposable) await stopDisposableProvider(disposable.child);
      terminateSpy.mockRestore();
      vi.resetModules();
    }
  });

  it.runIf(process.platform !== 'win32').each([
    ['malformed terminal', 'malformed'] as const,
    ['null terminal', 'null'] as const,
    ['unreadable terminal', 'unreadable'] as const,
    ['wrong-identity terminal', 'wrong-identity'] as const,
    ['unbound live terminal', 'unbound-live'] as const,
  ])('fails closed without signaling for a %s', async (_name, terminalKind) => {
    vi.resetModules();
    const dynamicProcessUtils = await import('../../platform/process-utils.js');
    const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
      .mockResolvedValue('terminated');
    const workerLaunch = await import('../worker-launch-ack.js');
    let disposable: Awaited<ReturnType<typeof spawnDisposableProvider>> | undefined;
    try {
      const launchAttempt = await attempt();
      const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
      disposable = await spawnDisposableProvider();
      const started = {
        ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
        process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
        written_at: new Date().toISOString(),
      };
      await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
      const terminalPath = `${launchAttempt.startedPath}.terminal`;
      if (terminalKind === 'malformed') {
        await writeFile(terminalPath, '{not-json', 'utf8');
      } else if (terminalKind === 'null') {
        await writeFile(terminalPath, 'null', 'utf8');
      } else if (terminalKind === 'unreadable') {
        await mkdir(terminalPath);
      } else if (terminalKind === 'wrong-identity') {
        await writeFile(terminalPath, JSON.stringify({
          ...started, attempt_id: '00000000-0000-4000-8000-000000000000',
          kind: 'worker_launch_provider_terminal', outcome: 'exit', cleanup_verified: true,
        }), 'utf8');
      } else {
        await writeFile(terminalPath, JSON.stringify({
          ...started, kind: 'worker_launch_provider_terminal',
          outcome: 'cleanup_unverified', cleanup_verified: false, child_reaped: false,
        }), 'utf8');
        const terminal = JSON.parse(await readFile(terminalPath, 'utf8')) as Record<string, unknown>;
        delete terminal.process_group_id;
        await writeFile(terminalPath, JSON.stringify(terminal), 'utf8');
      }

      await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
      expect(terminateSpy).not.toHaveBeenCalled();
    } finally {
      if (disposable) await stopDisposableProvider(disposable.child);
      terminateSpy.mockRestore();
      vi.resetModules();
    }
  });

  it.runIf(process.platform !== 'win32')('retries a matching live-unreaped cleanup terminal with its bound group', async () => {
    vi.resetModules();
    const dynamicProcessUtils = await import('../../platform/process-utils.js');
    const nativeTerminate = dynamicProcessUtils.terminateOwnedProcessGroup;
    const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
      .mockImplementation(options => nativeTerminate(options));
    const workerLaunch = await import('../worker-launch-ack.js');
    let disposable: Awaited<ReturnType<typeof spawnDisposableProvider>> | undefined;
    try {
      const launchAttempt = await attempt();
      const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
      disposable = await spawnDisposableProvider();
      const started = {
        ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
        process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
        written_at: new Date().toISOString(),
      };
      await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
      await writeFile(`${launchAttempt.startedPath}.terminal`, JSON.stringify({
        ...started, kind: 'worker_launch_provider_terminal',
        outcome: 'cleanup_unverified', cleanup_verified: false, child_reaped: false,
      }), 'utf8');

      await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 2_000)).resolves.toBe(true);
      expect(terminateSpy).toHaveBeenCalledOnce();
      await expect(readFile(`${launchAttempt.startedPath}.termination-complete`, 'utf8')).resolves.toContain(
        'worker_launch_termination_complete',
      );
    } finally {
      if (disposable) await stopDisposableProvider(disposable.child);
      terminateSpy.mockRestore();
      vi.resetModules();
    }
  });

  it.runIf(process.platform !== 'win32').each([
    ['already-dead', 'verified/reaped', true],
    ['already-dead', 'absent', false],
    ['already-dead', 'unverified', false],
    ['already-dead', 'wrong-bound', false],
    ['identity-mismatch', 'verified/reaped', true],
    ['identity-mismatch', 'absent', false],
    ['identity-mismatch', 'unverified', false],
    ['identity-mismatch', 'wrong-bound', false],
  ] as const)(
    're-reads cleanup proof after %s and accepts only a %s terminal',
    async (terminationResult, proofKind, expectedResult) => {
      vi.resetModules();
      const dynamicProcessUtils = await import('../../platform/process-utils.js');
      let disposable: Awaited<ReturnType<typeof spawnDisposableProvider>> | undefined;
      let terminateSpy: { mockRestore: () => void } | undefined;
      try {
        const launchAttempt = await attempt();
        const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
        disposable = await spawnDisposableProvider();
        const started = {
          ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
          process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
          written_at: new Date().toISOString(),
        };
        await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
        const terminalPath = `${launchAttempt.startedPath}.terminal`;
        await writeFile(terminalPath, JSON.stringify({
          ...started, kind: 'worker_launch_provider_terminal',
          outcome: 'cleanup_unverified', cleanup_verified: false, child_reaped: false,
        }), 'utf8');

        terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
          .mockImplementation(async () => {
            if (proofKind === 'absent') {
              await rm(terminalPath, { force: true });
            } else {
              await writeFile(terminalPath, JSON.stringify({
                ...started,
                kind: 'worker_launch_provider_terminal',
                outcome: proofKind === 'verified/reaped' ? 'exit' : 'cleanup_unverified',
                cleanup_verified: proofKind === 'verified/reaped',
                child_reaped: true,
                ...(proofKind === 'wrong-bound'
                  ? { process_group_id: disposable!.processGroupId + 1 }
                  : {}),
              }), 'utf8');
            }
            return terminationResult;
          });
        const workerLaunch = await import('../worker-launch-ack.js');

        await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(expectedResult);
        expect(terminateSpy).toHaveBeenCalledOnce();
        await expect(readFile(`${launchAttempt.startedPath}.termination-complete`, 'utf8'))
          .rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        if (disposable) await stopDisposableProvider(disposable.child);
        terminateSpy?.mockRestore();
        vi.resetModules();
      }
    },
  );

  it.runIf(process.platform !== 'win32')('rechecks terminal evidence before signaling after the request read', async () => {
    const launchAttempt = await attempt();
    const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
    const disposable = await spawnDisposableProvider();
    const started = {
      ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
      process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
      written_at: new Date().toISOString(),
    };
    await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
    const terminalPath = `${launchAttempt.startedPath}.terminal`;
    const terminationRequestPath = `${launchAttempt.startedPath}.termination-request`;
    let terminalInjected = false;

    vi.resetModules();
    const actualFsPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.doMock('node:fs/promises', () => ({
      ...actualFsPromises,
      readFile: async (path: string, encoding?: BufferEncoding) => {
        try {
          return await actualFsPromises.readFile(path, encoding ?? 'utf8');
        } catch (error) {
          if (!terminalInjected && path === terminalPath
            && existsSync(terminationRequestPath)
            && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            terminalInjected = true;
            await actualFsPromises.writeFile(terminalPath, JSON.stringify({
              ...started, kind: 'worker_launch_provider_terminal',
              outcome: 'cleanup_unverified', cleanup_verified: false, child_reaped: true,
            }), 'utf8');
            return await actualFsPromises.readFile(path, encoding ?? 'utf8');
          }
          throw error;
        }
      },
    }));
    const dynamicProcessUtils = await import('../../platform/process-utils.js');
    const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
      .mockResolvedValue('terminated');
    const workerLaunch = await import('../worker-launch-ack.js');
    try {
      await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
      expect(terminalInjected).toBe(true);
      expect(terminateSpy).not.toHaveBeenCalled();
      expect(isProcessAlive(disposable.pid)).toBe(true);
      await expect(readFile(`${launchAttempt.startedPath}.termination-complete`, 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await stopDisposableProvider(disposable.child);
      terminateSpy.mockRestore();
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it.runIf(process.platform !== 'win32')('returns a verified terminal that arrives at the first recovery gate', async () => {
    const launchAttempt = await attempt();
    const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
    const disposable = await spawnDisposableProvider();
    const started = {
      ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
      process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
      written_at: new Date().toISOString(),
    };
    await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
    const terminalPath = `${launchAttempt.startedPath}.terminal`;
    const terminationRequestPath = `${launchAttempt.startedPath}.termination-request`;
    let terminalReadCount = 0;
    const terminalReadPhases: string[] = [];

    vi.resetModules();
    const actualFsPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.doMock('node:fs/promises', () => ({
      ...actualFsPromises,
      readFile: async (path: string, encoding?: BufferEncoding) => {
        try {
          return await actualFsPromises.readFile(path, encoding ?? 'utf8');
        } catch (error) {
          if (path === terminalPath
            && !existsSync(terminationRequestPath)
            && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            terminalReadCount++;
            if (terminalReadCount === 1) {
              terminalReadPhases.push('initial-proof-absent');
            } else if (terminalReadCount === 2) {
              terminalReadPhases.push('first-gate-inject');
              await actualFsPromises.writeFile(terminalPath, JSON.stringify({
                ...started, kind: 'worker_launch_provider_terminal',
                outcome: 'exit', cleanup_verified: true, child_reaped: true,
              }), 'utf8');
              return await actualFsPromises.readFile(path, encoding ?? 'utf8');
            }
          }
          throw error;
        }
      },
    }));
    const dynamicProcessUtils = await import('../../platform/process-utils.js');
    const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
      .mockResolvedValue('terminated');
    const workerLaunch = await import('../worker-launch-ack.js');
    try {
      await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(true);
      expect(terminalReadPhases).toEqual(['initial-proof-absent', 'first-gate-inject']);
      expect(terminateSpy).not.toHaveBeenCalled();
      await expect(readFile(terminationRequestPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await stopDisposableProvider(disposable.child);
      terminateSpy.mockRestore();
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it.runIf(process.platform !== 'win32')('returns an unverified reaped terminal at the first recovery gate without signaling', async () => {
    const launchAttempt = await attempt();
    const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
    const disposable = await spawnDisposableProvider();
    const started = {
      ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
      process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
      written_at: new Date().toISOString(),
    };
    await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
    const terminalPath = `${launchAttempt.startedPath}.terminal`;
    const terminationRequestPath = `${launchAttempt.startedPath}.termination-request`;
    let terminalReadCount = 0;
    const terminalReadPhases: string[] = [];

    vi.resetModules();
    const actualFsPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.doMock('node:fs/promises', () => ({
      ...actualFsPromises,
      readFile: async (path: string, encoding?: BufferEncoding) => {
        try {
          return await actualFsPromises.readFile(path, encoding ?? 'utf8');
        } catch (error) {
          if (path === terminalPath
            && !existsSync(terminationRequestPath)
            && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            terminalReadCount++;
            if (terminalReadCount === 1) {
              terminalReadPhases.push('initial-proof-absent');
            } else if (terminalReadCount === 2) {
              terminalReadPhases.push('first-gate-inject');
              await actualFsPromises.writeFile(terminalPath, JSON.stringify({
                ...started, kind: 'worker_launch_provider_terminal',
                outcome: 'cleanup_unverified', cleanup_verified: false, child_reaped: true,
              }), 'utf8');
              return await actualFsPromises.readFile(path, encoding ?? 'utf8');
            }
          }
          throw error;
        }
      },
    }));
    const dynamicProcessUtils = await import('../../platform/process-utils.js');
    const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
      .mockResolvedValue('terminated');
    const workerLaunch = await import('../worker-launch-ack.js');
    try {
      await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(false);
      expect(terminalReadPhases).toEqual(['initial-proof-absent', 'first-gate-inject']);
      expect(terminateSpy).not.toHaveBeenCalled();
      await expect(readFile(terminationRequestPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await stopDisposableProvider(disposable.child);
      terminateSpy.mockRestore();
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it.runIf(process.platform !== 'win32')('returns a verified terminal that arrives at the signal gate', async () => {
    const launchAttempt = await attempt();
    const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
    const disposable = await spawnDisposableProvider();
    const started = {
      ...expected, kind: 'worker_launch_provider_started', pid: disposable.pid,
      process_start_identity: disposable.processStartIdentity, process_group_id: disposable.processGroupId,
      written_at: new Date().toISOString(),
    };
    await writeFile(launchAttempt.startedPath, JSON.stringify(started), 'utf8');
    const terminalPath = `${launchAttempt.startedPath}.terminal`;
    const terminationRequestPath = `${launchAttempt.startedPath}.termination-request`;
    let terminalInjected = false;

    vi.resetModules();
    const actualFsPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.doMock('node:fs/promises', () => ({
      ...actualFsPromises,
      readFile: async (path: string, encoding?: BufferEncoding) => {
        try {
          return await actualFsPromises.readFile(path, encoding ?? 'utf8');
        } catch (error) {
          if (!terminalInjected && path === terminalPath
            && existsSync(terminationRequestPath)
            && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            terminalInjected = true;
            await actualFsPromises.writeFile(terminalPath, JSON.stringify({
              ...started, kind: 'worker_launch_provider_terminal',
              outcome: 'exit', cleanup_verified: true, child_reaped: true,
            }), 'utf8');
            return await actualFsPromises.readFile(path, encoding ?? 'utf8');
          }
          throw error;
        }
      },
    }));
    const dynamicProcessUtils = await import('../../platform/process-utils.js');
    const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
      .mockResolvedValue('terminated');
    const workerLaunch = await import('../worker-launch-ack.js');
    try {
      await expect(workerLaunch.terminateWorkerLaunchProvider(launchAttempt, 100)).resolves.toBe(true);
      expect(terminalInjected).toBe(true);
      expect(terminateSpy).not.toHaveBeenCalled();
    } finally {
      await stopDisposableProvider(disposable.child);
      terminateSpy.mockRestore();
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('rejects replay when the acknowledgement path is already owned', async () => {
    const launchAttempt = await attempt();
    const spec = buildWorkerLaunchBootstrapSpec(
      launchAttempt,
      [process.execPath, '-e', 'setTimeout(() => process.exit(0), 300)'],
      cwd,
    );
    const first = runWorkerLaunchBootstrap(spec);
    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
    })).resolves.toEqual({ ok: true });
    await expect(first).resolves.toMatchObject({ outcome: 'ran', exitCode: 0 });
    await expect(runWorkerLaunchBootstrap(spec)).resolves.toEqual({ outcome: 'ack_conflict' });
  });

  it('reports provider spawn failure after acknowledgement without hanging the bootstrap', async () => {
    const launchAttempt = await attempt();
    const spec = buildWorkerLaunchBootstrapSpec(
      launchAttempt,
      [join(cwd, 'definitely-missing-provider')],
      cwd,
    );
    const bootstrap = runWorkerLaunchBootstrap(spec);
    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
    })).resolves.toEqual({ ok: true });
    await expect(bootstrap).resolves.toEqual({ outcome: 'provider_spawn_failed' });
    await expect(loadCurrentWorkerLaunchAttempt({
      cwd,
      teamName: launchAttempt.team_name,
      workerName: launchAttempt.worker_name,
      provider: launchAttempt.provider,
    })).resolves.toBeNull();
  });

  it('terminates a started provider process tree when durable start publication fails', async () => {
    const launchAttempt = await attempt();
    await mkdir(launchAttempt.startedPath);
    const pidMarker = join(cwd, 'provider-tree-pids.json');
    const providerScript = [
      "const fs=require('node:fs')",
      "const cp=require('node:child_process')",
      "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
      `fs.writeFileSync(${JSON.stringify(pidMarker)},JSON.stringify({parent:process.pid,child:child.pid}))`,
      'setInterval(()=>{},1000)',
    ].join(';');
    const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
      launchAttempt,
      [process.execPath, '-e', providerScript],
      cwd,
    ));
    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
    })).resolves.toEqual({ ok: true });
    await expect(bootstrap).resolves.toEqual({ outcome: 'provider_spawn_failed' });
    const pids = JSON.parse(await readFile(pidMarker, 'utf8')) as { parent: number; child: number };
    await vi.waitFor(() => {
      expect(isProcessAlive(pids.parent)).toBe(false);
      expect(isProcessAlive(pids.child)).toBe(false);
    }, { timeout: 2_000, interval: 20 });
  });

  it.runIf(process.platform !== 'win32').each(['identity', 'group'] as const)(
    'gates provider execution when %s ownership capture is unavailable',
    async missingCapture => {
      const launchAttempt = await attempt();
      const providerMarker = join(cwd, `provider-ran-${missingCapture}`);
      const spec = buildWorkerLaunchBootstrapSpec(
        launchAttempt,
        [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran');process.exit(0)`],
        cwd,
      );
      const captureSpy = missingCapture === 'identity'
        ? vi.spyOn(processUtils, 'getProcessStartIdentitySync').mockReturnValue(null)
        : vi.spyOn(processUtils, 'captureOwnedProcessGroup').mockReturnValue(null);
      try {
        const bootstrap = runWorkerLaunchBootstrap(spec);
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
          timeoutMs: 2_000,
          pollIntervalMs: 5,
        })).resolves.toEqual({ ok: true });
        await expect(bootstrap).resolves.toEqual({ outcome: 'provider_spawn_failed' });
        await expect(readFile(providerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

        const terminal = JSON.parse(await readFile(`${launchAttempt.startedPath}.terminal`, 'utf8')) as {
          kind: string;
          outcome: string;
          cleanup_verified: boolean;
          pid: number;
          exit_code: number | null;
          signal: string | null;
        };
        expect(terminal).toMatchObject({
          kind: 'worker_launch_provider_terminal',
          outcome: 'exit',
          cleanup_verified: true,
          exit_code: null,
          signal: null,
        });
        expect(Number.isSafeInteger(terminal.pid)).toBe(true);
        expect(() => process.kill(-terminal.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      } finally {
        captureSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== 'win32').each(['event-first', 'callback-first'] as const)('fails closed on asynchronous EPIPE after peer exit (%s)', async (errorOrder) => {
    vi.resetModules();
    const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    type GateSocket = {
      end: (chunk?: unknown, callback?: (error?: Error) => void) => unknown;
      emit: (event: string, error: unknown) => boolean;
    };
    const spawnMock = vi.fn((
      command: string,
      args: string[],
      options: Parameters<typeof spawn>[2],
    ) => {
      const child = actualChildProcess.spawn(command, args, options);
      child.once('spawn', () => {
        const gate = child.stdio[3] as unknown as GateSocket | null;
        if (!gate) return;
        gate.end = ((_: unknown, callback?: (error?: Error) => void) => {
          setImmediate(() => {
            child.kill('SIGKILL');
            const error = Object.assign(new Error('provider gate peer exited'), { code: 'EPIPE' });
            if (errorOrder === 'callback-first') callback?.(error);
            gate.emit('error', error);
            if (errorOrder === 'event-first') callback?.(error);
          });
          return gate;
        }) as GateSocket['end'];
      });
      return child;
    });
    vi.doMock('node:child_process', () => ({ ...actualChildProcess, spawn: spawnMock }));
    let bootstrap: ReturnType<typeof runWorkerLaunchBootstrap> | undefined;
    try {
      const workerLaunch = await import('../worker-launch-ack.js');
      const launchAttempt = await attempt();
      const providerMarker = join(cwd, 'async-release-provider-ran');
      bootstrap = workerLaunch.runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
        launchAttempt,
        [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran');setInterval(()=>{},1000)`],
        cwd,
      ));
      await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
        timeoutMs: 2_000,
        pollIntervalMs: 5,
      })).resolves.toEqual({ ok: true });
      const result = await bootstrap;
      expect(result.outcome).toBe('provider_spawn_failed');
      expect(result.outcome).not.toBe('ran');
      await expect(readFile(providerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(workerLaunch.isWorkerLaunchProviderStarted(launchAttempt)).resolves.toBe(false);

      const terminal = JSON.parse(await readFile(`${launchAttempt.startedPath}.terminal`, 'utf8')) as {
        kind: string;
        outcome: string;
        cleanup_verified: boolean;
        process_group_id: number;
      };
      expect(terminal).toMatchObject({
        kind: 'worker_launch_provider_terminal',
        outcome: 'exit',
        cleanup_verified: true,
      });
      expect(Number.isSafeInteger(terminal.process_group_id)).toBe(true);
      expect(() => process.kill(-terminal.process_group_id, 0))
        .toThrow(expect.objectContaining({ code: 'ESRCH' }));
    } finally {
      await bootstrap?.catch(() => undefined);
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it.runIf(process.platform !== 'win32')('ignores a late EPIPE emitted after release before start publication', async () => {
    vi.resetModules();
    const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    type GateSocket = {
      end: (chunk?: unknown, callback?: (error?: Error | null) => void) => unknown;
      emit: (event: string, error: unknown) => boolean;
    };
    const lateError = Object.assign(new Error('provider gate peer closed'), { code: 'EPIPE' });
    const spawnMock = vi.fn((
      command: string,
      args: string[],
      options: Parameters<typeof spawn>[2],
    ) => {
      const child = actualChildProcess.spawn(command, args, options);
      child.once('spawn', () => {
        const gate = child.stdio[3] as unknown as GateSocket | null;
        if (!gate) return;
        const nativeEnd = gate.end.bind(gate);
        gate.end = ((chunk?: unknown, callback?: (error?: Error | null) => void) => {
          if (chunk !== 'release\n') return nativeEnd(chunk, callback);
          return nativeEnd(chunk, (error?: Error | null) => {
            callback?.(error);
            // The release callback has succeeded, but this peer-close event
            // arrives before the bootstrap publishes provider-started.
            gate.emit('error', lateError);
          });
        }) as GateSocket['end'];
      });
      return child;
    });
    vi.doMock('node:child_process', () => ({ ...actualChildProcess, spawn: spawnMock }));
    let bootstrap: ReturnType<typeof runWorkerLaunchBootstrap> | undefined;
    const launchAttempt = await attempt();
    const providerMarker = join(cwd, 'late-release-before-start-provider-ran');
    const providerStop = join(cwd, 'late-release-before-start-provider-stop');
    try {
      const workerLaunch = await import('../worker-launch-ack.js');
      bootstrap = workerLaunch.runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
        launchAttempt,
        [process.execPath, '-e', [
          "const fs=require('node:fs')",
          `fs.writeFileSync(${JSON.stringify(providerMarker)},'ran')`,
          `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(providerStop)})){clearInterval(timer);process.exit(0)}},5)`,
        ].join(';')],
        cwd,
      ));
      await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
        timeoutMs: 2_000,
        pollIntervalMs: 5,
      })).resolves.toEqual({ ok: true });
      await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
        timeoutMs: 2_000,
        pollIntervalMs: 5,
      })).resolves.toBe(true);
      await expect(readFile(providerMarker, 'utf8')).resolves.toBe('ran');
      await writeFile(providerStop, 'stop', 'utf8');
      await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
    } finally {
      await writeFile(providerStop, 'stop', 'utf8').catch(() => undefined);
      await terminateWorkerLaunchProvider(launchAttempt, 2_000).catch(() => false);
      await bootstrap?.catch(() => undefined);
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it.runIf(process.platform !== 'win32').each(['EPIPE', 'ECONNRESET', 'ERR_PROVIDER_GATE_LATE'] as const)(
    'ignores a post-release %s after provider-start publication',
    async errorCode => {
      vi.resetModules();
      const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      type GateSocket = {
        end: (chunk?: unknown, callback?: (error?: Error | null) => void) => unknown;
        emit: (event: string, error: unknown) => boolean;
      };
      const lateError = Object.assign(new Error(`provider gate ${errorCode}`), { code: errorCode });
      let emitLateGateError: (() => void) | undefined;
      const spawnMock = vi.fn((
        command: string,
        args: string[],
        options: Parameters<typeof spawn>[2],
      ) => {
        const child = actualChildProcess.spawn(command, args, options);
        child.once('spawn', () => {
          const gate = child.stdio[3] as unknown as GateSocket | null;
          if (!gate) return;
          const nativeEnd = gate.end.bind(gate);
          gate.end = ((chunk?: unknown, callback?: (error?: Error | null) => void) => {
            if (chunk !== 'release\n') return nativeEnd(chunk, callback);
            return nativeEnd(chunk, (error?: Error | null) => {
              callback?.(error);
              emitLateGateError = () => { gate.emit('error', lateError); };
            });
          }) as GateSocket['end'];
        });
        return child;
      });
      vi.doMock('node:child_process', () => ({ ...actualChildProcess, spawn: spawnMock }));
      let bootstrap: ReturnType<typeof runWorkerLaunchBootstrap> | undefined;
      const launchAttempt = await attempt();
      const providerStop = join(cwd, `late-release-${errorCode}-provider-stop`);
      try {
        const workerLaunch = await import('../worker-launch-ack.js');
        bootstrap = workerLaunch.runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
          launchAttempt,
          [process.execPath, '-e', [
            "const fs=require('node:fs')",
            `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(providerStop)})){clearInterval(timer);process.exit(0)}},5)`,
          ].join(';')],
          cwd,
          { releaseAfterSpawn: true },
        ));
        await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
          timeoutMs: 2_000,
          pollIntervalMs: 5,
        })).resolves.toEqual({ ok: true });
        await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
          timeoutMs: 2_000,
          pollIntervalMs: 5,
        })).resolves.toBe(true);
        expect(emitLateGateError).toBeDefined();
        emitLateGateError!();
        await new Promise<void>(resolve => setImmediate(resolve));
        const started = JSON.parse(await readFile(launchAttempt.startedPath, 'utf8')) as { pid: number };
        expect(isProcessAlive(started.pid)).toBe(true);
        await writeFile(providerStop, 'stop', 'utf8');
        await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
      } finally {
        await writeFile(providerStop, 'stop', 'utf8').catch(() => undefined);
        await terminateWorkerLaunchProvider(launchAttempt, 2_000).catch(() => false);
        await bootstrap?.catch(() => undefined);
        vi.doUnmock('node:child_process');
        vi.resetModules();
      }
    },
  );

  it.runIf(process.platform !== 'win32')('does not signal a still-present group after supervisor exit', async () => {
    vi.resetModules();
    const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const dynamicProcessUtils = await import('../../platform/process-utils.js');
    type GateSocket = {
      end: (chunk?: unknown, callback?: (error?: Error | null) => void) => unknown;
      emit: (event: string, error: unknown) => boolean;
    };
    const lateError = Object.assign(new Error('provider gate peer closed'), { code: 'EPIPE' });
    let killSupervisor: (() => void) | undefined;
    let supervisorExited = false;
    let exitMetadataObserved = false;
    let postReapTerminateCalls = 0;
    const nativeTerminate = dynamicProcessUtils.terminateOwnedProcessGroup;
    const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup').mockImplementation(async options => {
      if (supervisorExited) {
        postReapTerminateCalls++;
        return 'already-dead';
      }
      return nativeTerminate(options);
    });
    const spawnMock = vi.fn((
      command: string,
      args: string[],
      options: Parameters<typeof spawn>[2],
    ) => {
      const child = actualChildProcess.spawn(command, args, options);
      let gate: GateSocket | null = null;
      // Attach before returning so this observer runs before the bootstrap's
      // exit listener. Node has populated signalCode by this point.
      child.once('exit', () => {
        supervisorExited = true;
        exitMetadataObserved = child.exitCode === null && child.signalCode === 'SIGKILL';
        gate?.emit('error', lateError);
      });
      child.once('spawn', () => {
        gate = child.stdio[3] as unknown as GateSocket | null;
        if (!gate) return;
        const nativeEnd = gate.end.bind(gate);
        gate.end = ((chunk?: unknown, callback?: (error?: Error | null) => void) => {
          if (chunk !== 'release\n') return nativeEnd(chunk, callback);
          // Let the provider execute, but withhold the release callback. This
          // is a real failed release with a live descendant when the supervisor
          // is killed below.
          const result = nativeEnd(chunk);
          killSupervisor = () => { child.kill('SIGKILL'); };
          return result;
        }) as GateSocket['end'];
      });
      return child;
    });
    vi.doMock('node:child_process', () => ({ ...actualChildProcess, spawn: spawnMock }));
    let bootstrap: ReturnType<typeof runWorkerLaunchBootstrap> | undefined;
    const launchAttempt = await attempt();
    let providerPid: number | undefined;
    let providerGroupId: number | undefined;
    try {
      const workerLaunch = await import('../worker-launch-ack.js');
      bootstrap = workerLaunch.runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
        launchAttempt,
        [process.execPath, '-e', [
          "const fs=require('node:fs')",
          `fs.writeFileSync(${JSON.stringify(join(cwd, 'failed-release-provider.json'))},JSON.stringify({pid:process.pid}))`,
          'setInterval(()=>{},1000)',
        ].join(';')],
        cwd,
        { releaseAfterSpawn: true },
      ));
      await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
        timeoutMs: 2_000,
        pollIntervalMs: 5,
      })).resolves.toEqual({ ok: true });
      const providerMarker = join(cwd, 'failed-release-provider.json');
      await vi.waitFor(async () => {
        const record = JSON.parse(await readFile(providerMarker, 'utf8')) as { pid: number };
        expect(record.pid).toBeGreaterThan(0);
        providerPid = record.pid;
      }, { timeout: 2_000, interval: 5 });
      const ownedGroup = dynamicProcessUtils.captureOwnedProcessGroup(providerPid!);
      expect(ownedGroup).not.toBeNull();
      providerGroupId = ownedGroup!.processGroupId;
      expect(killSupervisor).toBeDefined();
      killSupervisor!();
      await expect(bootstrap).resolves.toEqual({ outcome: 'provider_cleanup_unverified' });
      expect(exitMetadataObserved).toBe(true);
      expect(postReapTerminateCalls).toBe(0);
      expect(() => process.kill(-providerGroupId!, 0)).not.toThrow();
      await vi.waitFor(async () => {
        const terminal = JSON.parse(await readFile(`${launchAttempt.startedPath}.terminal`, 'utf8'));
        expect(terminal).toMatchObject({
          outcome: 'cleanup_unverified',
          cleanup_verified: false,
          child_reaped: true,
          signal: 'SIGKILL',
        });
      }, { timeout: 2_000, interval: 5 });
      expect(postReapTerminateCalls).toBe(0);
    } finally {
      killSupervisor?.();
      if (!providerGroupId && providerPid) {
        providerGroupId = dynamicProcessUtils.captureOwnedProcessGroup(providerPid)?.processGroupId;
      }
      if (providerGroupId) {
        try { process.kill(-providerGroupId, 'SIGKILL'); } catch { /* group already absent */ }
      }
      await bootstrap?.catch(() => undefined);
      terminateSpy.mockRestore();
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it.runIf(process.platform !== 'win32')('upgrades a live timer terminal to reaped evidence after the supervisor exits', async () => {
    vi.resetModules();
    const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const dynamicProcessUtils = await import('../../platform/process-utils.js');
    const terminateSpy = vi.spyOn(dynamicProcessUtils, 'terminateOwnedProcessGroup')
      .mockResolvedValue('unknown');
    let supervisor: ReturnType<typeof spawn> | undefined;
    const spawnMock = vi.fn((
      command: string,
      args: string[],
      options: Parameters<typeof spawn>[2],
    ) => {
      const child = actualChildProcess.spawn(command, args, options);
      supervisor = child;
      return child;
    });
    vi.doMock('node:child_process', () => ({ ...actualChildProcess, spawn: spawnMock }));
    let bootstrap: ReturnType<typeof runWorkerLaunchBootstrap> | undefined;
    const launchAttempt = await attempt();
    const descendantPidPath = join(cwd, 'timer-transition-descendant.pid');
    let providerGroupId: number | undefined;
    try {
      const workerLaunch = await import('../worker-launch-ack.js');
      bootstrap = workerLaunch.runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
        launchAttempt,
        [process.execPath, '-e', [
          "const fs=require('node:fs'),cp=require('node:child_process')",
          "const descendant=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
          'descendant.unref()',
          `fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(descendant.pid))`,
          'process.exit(0)',
        ].join(';')],
        cwd,
        { releaseAfterSpawn: true },
      ));
      await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
        timeoutMs: 2_000,
        pollIntervalMs: 5,
      })).resolves.toEqual({ ok: true });
      await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
        timeoutMs: 2_000,
        pollIntervalMs: 5,
      })).resolves.toBe(true);
      const started = JSON.parse(await readFile(launchAttempt.startedPath, 'utf8')) as {
        process_group_id: number;
      };
      providerGroupId = started.process_group_id;
      await vi.waitFor(async () => {
        const terminal = JSON.parse(await readFile(`${launchAttempt.startedPath}.terminal`, 'utf8'));
        expect(terminal).toMatchObject({
          outcome: 'cleanup_unverified',
          cleanup_verified: false,
          child_reaped: false,
          process_group_id: providerGroupId,
        });
      }, { timeout: 5_000, interval: 20 });
      expect(supervisor).toBeDefined();
      supervisor!.kill('SIGKILL');
      await expect(bootstrap).resolves.toEqual({ outcome: 'provider_cleanup_unverified' });
      expect(() => process.kill(-providerGroupId!, 0)).not.toThrow();
      await vi.waitFor(async () => {
        const terminal = JSON.parse(await readFile(`${launchAttempt.startedPath}.terminal`, 'utf8'));
        expect(terminal).toMatchObject({
          outcome: 'cleanup_unverified',
          cleanup_verified: false,
          child_reaped: true,
          process_group_id: providerGroupId,
        });
      }, { timeout: 5_000, interval: 20 });
    } finally {
      try {
        if (providerGroupId) process.kill(-providerGroupId, 'SIGKILL');
      } catch { /* group already absent */ }
      supervisor?.kill('SIGKILL');
      await bootstrap?.catch(() => undefined);
      terminateSpy.mockRestore();
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('terminates the exact started provider process group before failed-startup pane cleanup', async () => {
    const launchAttempt = await attempt();
    const pidMarker = join(cwd, 'started-provider-tree-pids.json');
    const providerScript = [
      "const fs=require('node:fs')",
      "const cp=require('node:child_process')",
      "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
      `fs.writeFileSync(${JSON.stringify(pidMarker)},JSON.stringify({parent:process.pid,child:child.pid}))`,
      'setInterval(()=>{},1000)',
    ].join(';');
    const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
      launchAttempt,
      [process.execPath, '-e', providerScript],
      cwd,
    ));
    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
    })).resolves.toEqual({ ok: true });
    await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
    })).resolves.toBe(true);
    const started = JSON.parse(await readFile(launchAttempt.startedPath, 'utf8')) as { process_group_id: number };
    const cleanup = vi.fn(async () => {
      const pids = JSON.parse(await readFile(pidMarker, 'utf8')) as { parent: number; child: number };
      expect(isProcessAlive(pids.parent)).toBe(false);
      expect(isProcessAlive(pids.child)).toBe(false);
      expect(isProcessAlive(process.pid)).toBe(true);
      expect(() => process.kill(-started.process_group_id, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      return true;
    });
    await expect(retireAndCleanupCurrentWorkerLaunchAttempt(
      launchAttempt,
      'startup_dispatch_failed',
      cleanup,
    )).resolves.toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(bootstrap).resolves.toMatchObject({ outcome: 'ran' });
    const pids = JSON.parse(await readFile(pidMarker, 'utf8')) as { parent: number; child: number };
    await vi.waitFor(() => {
      expect(isProcessAlive(pids.parent)).toBe(false);
      expect(isProcessAlive(pids.child)).toBe(false);
      expect(isProcessAlive(process.pid)).toBe(true);
    }, { timeout: 2_000, interval: 20 });
  });

  it('reloads an accepted attempt only for the exact pane and provider identity', async () => {
    const launchAttempt = await attempt();
    const spec = buildWorkerLaunchBootstrapSpec(
      launchAttempt,
      [process.execPath, '-e', 'setTimeout(() => process.exit(0), 300)'],
      cwd,
    );
    const bootstrap = runWorkerLaunchBootstrap(spec);
    await awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 2_000, pollIntervalMs: 5 });
    await bootstrap;

    await expect(loadWorkerLaunchAttempt({
      cwd,
      teamName: 'launch-team',
      workerName: 'worker-1',
      paneId: '%2',
      provider: 'codex',
      attemptId: launchAttempt.attempt_id,
      runtimeCliPath: '/runtime-cli.cjs',
    })).resolves.toMatchObject({ attempt_id: launchAttempt.attempt_id, nonce: launchAttempt.nonce });
    await expect(loadWorkerLaunchAttempt({
      cwd,
      teamName: 'launch-team',
      workerName: 'worker-1',
      paneId: '%1',
      provider: 'codex',
      attemptId: launchAttempt.attempt_id,
      runtimeCliPath: '/runtime-cli.cjs',
    })).resolves.toBeNull();
    await expect(loadCurrentWorkerLaunchAttempt({
      cwd,
      teamName: 'launch-team',
      workerName: 'worker-1',
      provider: 'claude',
    })).resolves.toBeNull();
  });
  it('keeps revocation terminal when a valid acknowledgement is already present', async () => {
    const launchAttempt = await attempt();
    const providerMarker = join(cwd, 'revocation-race-provider-ran');
    const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
      launchAttempt,
      [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran')`],
      cwd,
    ));
    await vi.waitFor(async () => {
      const acknowledgement = JSON.parse(await readFile(launchAttempt.ackPath, 'utf8'));
      expect(acknowledgement.kind).toBe('worker_launch_ack');
    }, { timeout: 2_000, interval: 5 });

    await expect(revokeWorkerLaunchAttempt(launchAttempt, 'timeout')).resolves.toBe(true);
    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
    })).resolves.toEqual({ ok: false, reason: 'decision_conflict' });
    await expect(bootstrap).resolves.toEqual({ outcome: 'revoked' });
    await expect(readFile(providerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(isWorkerLaunchAttemptAccepted(launchAttempt)).resolves.toBe(false);
  });

  it('prevents provider spawn after durable launch retirement wins ordering', async () => {
    const launchAttempt = await attempt();
    const providerMarker = join(cwd, 'retired-provider-ran');
    const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
      launchAttempt,
      [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran')`],
      cwd,
    ));
    await vi.waitFor(async () => {
      const acknowledgement = JSON.parse(await readFile(launchAttempt.ackPath, 'utf8'));
      expect(acknowledgement.kind).toBe('worker_launch_ack');
    }, { timeout: 2_000, interval: 5 });

    await expect(retireWorkerLaunchAttempt(launchAttempt, 'pane_cleanup')).resolves.toBe(true);
    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
    })).resolves.toEqual({ ok: false, reason: 'attempt_superseded' });
    await expect(bootstrap).resolves.toEqual({ outcome: 'revoked' });
    await new Promise(resolve => setTimeout(resolve, 100));
    await expect(readFile(providerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${launchAttempt.decisionPath}.retired`, 'utf8')).resolves.toContain('worker_launch_retired');
  });

  it('keeps an accepted decision terminal when revocation arrives later', async () => {
    const launchAttempt = await attempt();
    const providerMarker = join(cwd, 'accepted-provider-ran');
    const providerReadyPath = join(cwd, 'accepted-provider-ready');
    const providerStopPath = join(cwd, 'accepted-provider-stop');
    const providerScript = [
      "const fs=require('node:fs')",
      `fs.writeFileSync(${JSON.stringify(providerReadyPath)},JSON.stringify({pid:process.pid}))`,
      `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(providerStopPath)})){clearInterval(timer);fs.writeFileSync(${JSON.stringify(providerMarker)},'ran');process.exit(0)}},5)`,
    ].join(';');
    let bootstrap: ReturnType<typeof runWorkerLaunchBootstrap> | undefined;
    try {
      bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
        launchAttempt,
        [process.execPath, '-e', providerScript],
        cwd,
        { releaseAfterSpawn: true },
      ));
      await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
        timeoutMs: 2_000,
        pollIntervalMs: 5,
      })).resolves.toEqual({ ok: true });
      await expect(revokeWorkerLaunchAttempt(launchAttempt, 'late_timeout')).resolves.toBe(false);
      const decision = JSON.parse(await readFile(launchAttempt.decisionPath, 'utf8'));
      expect(decision).toMatchObject({ decision: 'accepted', reason: 'ack_valid' });
      await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
        timeoutMs: 2_000,
        pollIntervalMs: 5,
      })).resolves.toBe(true);
      await vi.waitFor(async () => {
        const ready = JSON.parse(await readFile(providerReadyPath, 'utf8')) as { pid: number };
        expect(ready.pid).toBeGreaterThan(0);
      }, { timeout: 2_000, interval: 5 });
      await writeFile(providerStopPath, 'stop', 'utf8');
      await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
      await expect(readFile(providerMarker, 'utf8')).resolves.toBe('ran');
    } finally {
      await writeFile(providerStopPath, 'stop', 'utf8').catch(() => undefined);
      await terminateWorkerLaunchProvider(launchAttempt, 2_000).catch(() => false);
      await bootstrap?.catch(() => undefined);
    }
  });

  it('prevents an older acknowledged attempt from releasing a provider after supersession', async () => {
    cwd = await createFixture('omc-worker-launch-recovery-generation-');
    const olderAttempt = await prepareWorkerLaunchAttempt({
      cwd,
      teamName: 'launch-team',
      workerName: 'worker-1',
      paneId: '%2',
      provider: 'codex',
      runtimeCliPath: '/runtime-cli.cjs',
      context: { kind: 'recovery', recovery_id: 'recovery-old', replacement_generation: 1, pane_attempt_id: 'pane-old' },
    });
    const providerMarker = join(cwd, 'superseded-provider-ran');
    const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
      olderAttempt,
      [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran')`],
      cwd,
    ));
    let acknowledged: Record<string, unknown> | undefined;
    for (let index = 0; index < 200 && !acknowledged; index++) {
      try {
        acknowledged = JSON.parse(await readFile(olderAttempt.ackPath, 'utf8'));
      } catch {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    expect(acknowledged).toMatchObject({
      attempt_id: olderAttempt.attempt_id,
      nonce: olderAttempt.nonce,
      pane_id: olderAttempt.pane_id,
      kind: 'worker_launch_ack',
    });
    const newerAttempt = await prepareWorkerLaunchAttempt({
      cwd,
      teamName: olderAttempt.team_name,
      workerName: olderAttempt.worker_name,
      paneId: '%3',
      provider: olderAttempt.provider,
      runtimeCliPath: olderAttempt.runtimeCliPath,
      context: { kind: 'recovery', recovery_id: 'recovery-new', replacement_generation: 2, pane_attempt_id: 'pane-new' },
    });

    await expect(awaitWorkerLaunchAcknowledgement(olderAttempt, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
    })).resolves.toEqual({ ok: false, reason: 'attempt_superseded' });
    await expect(bootstrap).resolves.toEqual({ outcome: 'revoked' });
    await expect(readFile(providerMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(isWorkerLaunchAttemptAccepted(olderAttempt)).resolves.toBe(false);
    await expect(isWorkerLaunchAttemptAccepted(newerAttempt)).resolves.toBe(false);
    const current = JSON.parse(await readFile(newerAttempt.currentPath, 'utf8'));
    expect(current).toMatchObject({
      attempt_id: newerAttempt.attempt_id,
      pane_id: '%3',
      context: { kind: 'recovery', recovery_id: 'recovery-new', replacement_generation: 2, pane_attempt_id: 'pane-new' },
    });
  });

  it('reloads the accepted current recovery launch with its durable context', async () => {
    cwd = await createFixture('omc-worker-launch-current-');
    const launchAttempt = await prepareWorkerLaunchAttempt({
      cwd,
      teamName: 'launch-team',
      workerName: 'worker-1',
      paneId: '%22',
      provider: 'codex',
      runtimeCliPath: '/runtime-cli.cjs',
      context: {
        kind: 'recovery',
        recovery_id: 'recovery-current',
        replacement_generation: 2,
        pane_attempt_id: 'pane-attempt-current',
      },
    });
    const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd);
    const bootstrap = runWorkerLaunchBootstrap(spec);
    await awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 2_000, pollIntervalMs: 5 });
    await expect(awaitWorkerLaunchProviderStarted(launchAttempt, { timeoutMs: 10_000, pollIntervalMs: 5 })).resolves.toBe(true);
    const started = JSON.parse(await readFile(launchAttempt.startedPath, 'utf8'));
    expect(started).toMatchObject({
      kind: 'worker_launch_provider_started',
      attempt_id: launchAttempt.attempt_id,
      pane_id: '%22',
      provider: 'codex',
      process_start_identity: expect.any(String),
    });

    await expect(loadCurrentWorkerLaunchAttempt({
      cwd,
      teamName: 'launch-team',
      workerName: 'worker-1',
      provider: 'codex',
    })).resolves.toMatchObject({
      attempt_id: launchAttempt.attempt_id,
      pane_id: '%22',
      context: {
        kind: 'recovery',
        recovery_id: 'recovery-current',
        replacement_generation: 2,
        pane_attempt_id: 'pane-attempt-current',
      },
    });
    await expect(retireWorkerLaunchAttempt(launchAttempt, 'test_cleanup')).resolves.toBe(true);
    await expect(terminateWorkerLaunchProvider(launchAttempt)).resolves.toBe(true);
    await expect(bootstrap).resolves.toMatchObject({ outcome: 'ran' });
  });

  it('materializes an attempt-owned Windows transport without exposing provider secrets in pane text', async () => {
    const launchAttempt = await attempt();
    const secret = 'synthetic-token-value';
    const longValue = `long-${'x'.repeat(12_000)}`;
    const providerArgv = [
      'C:\\Program Files\\Codex\\codex.exe',
      '--token', secret,
      '--metacharacters', '100% ! ^ & | ( ) "quoted" with spaces',
      '--unicode', 'Grüße-λ-漢字',
      '--long', longValue,
    ];
    const providerEnv = {
      OMC_TEAM_WORKER: 'launch-team/worker-1',
      OMC_WORKER_LAUNCH_ATTEMPT_ID: launchAttempt.attempt_id,
      PROVIDER_TOKEN: secret,
      PROVIDER_URL: 'https://provider.example.test/path?x=1&y=2',
      PATH: 'C:\\Program Files\\Node;C:\\Tools',
      SYNTHETIC_METACHARS: '100% ! ^ & | ( ) "quoted" with spaces',
      SYNTHETIC_UNICODE: 'Grüße-λ-漢字',
      SYNTHETIC_CRLF: 'line-one\r\nline-two',
      SYNTHETIC_LONG: longValue,
    };
    const materialized = await materializeWorkerLaunchTransport({
      attempt: launchAttempt,
      providerArgv,
      providerEnv,
      cwd,
    });

    const canonicalWrapperPath = join(
      getOmcRoot(cwd), 'state', 'team', 'launch-team', 'workers', 'worker-1',
      'launch-attempts', launchAttempt.attempt_id, 'launch.cmd',
    );
    expect(materialized.wrapperPath).toBe(canonicalWrapperPath);
    expect(materialized.wrapperRelativePath).toBe(relative(cwd, canonicalWrapperPath).replace(/\//g, '\\'));
    expect(Buffer.byteLength(materialized.wrapperRelativePath, 'utf8')).toBeLessThan(256);
    const wrapper = await readFile(materialized.wrapperPath, 'utf8');
    expect(wrapper).toContain('setlocal DisableDelayedExpansion');
    expect(wrapper).toContain('OMC_WORKER_LAUNCH_SPEC_FILE=%~dp0bootstrap.json');
    expect(wrapper).toContain('--worker-launch');
    for (const value of [secret, providerEnv.PROVIDER_URL, providerEnv.SYNTHETIC_METACHARS,
      providerEnv.SYNTHETIC_UNICODE, providerEnv.SYNTHETIC_CRLF, longValue]) {
      expect(wrapper).not.toContain(value);
    }
    expect(wrapper).not.toContain('PROVIDER_TOKEN');
    const descriptorRaw = await readFile(materialized.bootstrapDescriptorPath, 'utf8');
    expect(Buffer.byteLength(descriptorRaw, 'utf8')).toBeGreaterThan(12_000);
    const descriptor = JSON.parse(descriptorRaw);
    expect(descriptor).toMatchObject({
      attempt_id: launchAttempt.attempt_id,
      nonce: launchAttempt.nonce,
    });
    expect(descriptor.provider_argv).toEqual(providerArgv);
    const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const ambientHome = process.env[homeKey];
    expect(descriptor.provider_env).toEqual({
      ...providerEnv,
      ...(ambientHome ? { [homeKey]: ambientHome } : {}),
    });
    await expect(materializeWorkerLaunchTransport({
      attempt: launchAttempt,
      providerArgv: ['codex'],
      cwd,
    })).rejects.toThrow('worker_launch_transport_owner_conflict');

    const consumed = await readAndConsumeWorkerLaunchDescriptor(materialized.bootstrapDescriptorPath) as Record<string, unknown>;
    expect(consumed).toMatchObject({ attempt_id: launchAttempt.attempt_id, provider_env: { PROVIDER_TOKEN: secret } });
    await expect(readFile(materialized.bootstrapDescriptorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(cleanupWorkerLaunchTransport(launchAttempt, 'test_cleanup')).resolves.toBe(true);
    await expect(readFile(materialized.wrapperPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(cleanupWorkerLaunchTransport(launchAttempt, 'test_cleanup_retry')).resolves.toBe(true);
    await expect(readFile(launchAttempt.transportCleanupCompletePath, 'utf8').then(JSON.parse))
      .resolves.toMatchObject({ attempt_id: launchAttempt.attempt_id, kind: 'worker_launch_transport_cleanup_complete' });
  });

  it('uses a safe relative wrapper command when worker cwd is nested below the leader state root', async () => {
    const launchAttempt = await attempt();
    const workerCwd = join(getOmcRoot(cwd), 'team', 'launch-team', 'worktrees', 'worker-1');
    await mkdir(workerCwd, { recursive: true });
    const materialized = await materializeWorkerLaunchTransport({
      attempt: launchAttempt,
      providerArgv: ['codex'],
      providerEnv: { OMC_TEAM_WORKER: 'launch-team/worker-1' },
      cwd: workerCwd,
    });

    expect(materialized.wrapperRelativePath).toBe(relative(workerCwd, launchAttempt.wrapperPath).replace(/\//g, '\\'));
    expect(materialized.wrapperRelativePath).toMatch(/^(?:\.\.\\)+state\\team\\launch-team\\workers\\worker-1\\launch-attempts\\[0-9a-f-]+\\launch\.cmd$/);
    expect(materialized.wrapperRelativePath).not.toMatch(/[\s"%!^&|()]/);
    await expect(cleanupWorkerLaunchTransport(launchAttempt, 'nested_worktree_cleanup')).resolves.toBe(true);
  });

  it('removes only partial current-attempt transport files when exclusive materialization fails', async () => {
    const launchAttempt = await attempt();
    await writeFile(launchAttempt.wrapperPath, 'foreign-wrapper', 'utf8');

    await expect(materializeWorkerLaunchTransport({
      attempt: launchAttempt,
      providerArgv: ['codex'],
      providerEnv: { OMC_TEAM_WORKER: 'launch-team/worker-1' },
      cwd,
    })).rejects.toThrow('worker_launch_transport_path_conflict');
    await expect(readFile(launchAttempt.transportOwnerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(launchAttempt.bootstrapDescriptorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(launchAttempt.wrapperPath, 'utf8')).resolves.toBe('foreign-wrapper');
  });

  it('refuses transport cleanup when the durable owner belongs to another attempt identity', async () => {
    const launchAttempt = await attempt();
    await materializeWorkerLaunchTransport({ attempt: launchAttempt, providerArgv: ['codex'], cwd });
    const expected = JSON.parse(await readFile(launchAttempt.expectedPath, 'utf8'));
    await writeFile(launchAttempt.transportOwnerPath, JSON.stringify({
      ...expected,
      nonce: '00000000-0000-4000-8000-000000000000',
      kind: 'worker_launch_transport_owner',
    }), 'utf8');

    await expect(readAndConsumeWorkerLaunchDescriptor(launchAttempt.bootstrapDescriptorPath))
      .rejects.toThrow('worker_launch_descriptor_owner_invalid');
    await expect(readFile(launchAttempt.bootstrapDescriptorPath, 'utf8')).resolves.toContain(launchAttempt.attempt_id);
    await expect(cleanupWorkerLaunchTransport(launchAttempt, 'foreign_owner')).resolves.toBe(false);
    await expect(readFile(launchAttempt.wrapperPath, 'utf8')).resolves.toContain('--worker-launch');
    await expect(readFile(launchAttempt.bootstrapDescriptorPath, 'utf8')).resolves.toContain(launchAttempt.attempt_id);
  });

  it('propagates only the canonical home variable for each platform', () => {
    const posix = buildProviderEnvironment(undefined, {
      PATH: '/usr/bin:/bin',
      HOME: '/home/provider',
      USERPROFILE: 'C:\\Users\\wrong-platform',
      GH_TOKEN: 'ambient-secret',
    }, 'linux');
    expect(posix).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/provider' });

    const windows = buildProviderEnvironment(undefined, {
      PATH: 'C:\\Windows\\System32',
      HOME: '/home/wrong-platform',
      USERPROFILE: 'C:\\Users\\provider',
      SystemRoot: 'C:\\Windows',
      GH_TOKEN: 'ambient-secret',
    }, 'win32');
    expect(windows).toEqual({
      PATH: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\provider',
    });
  });

  it('omits missing or empty ambient homes while preserving explicit overrides', () => {
    expect(buildProviderEnvironment(undefined, { PATH: '/usr/bin:/bin' }, 'linux'))
      .toEqual({ PATH: '/usr/bin:/bin' });
    expect(buildProviderEnvironment(undefined, {
      PATH: '/usr/bin:/bin', HOME: '', USERPROFILE: 'C:\\Users\\wrong-platform',
    }, 'linux')).toEqual({ PATH: '/usr/bin:/bin' });
    expect(buildProviderEnvironment(undefined, {
      PATH: 'C:\\Windows\\System32', USERPROFILE: '', HOME: '/home/wrong-platform',
    }, 'win32')).toEqual({ PATH: 'C:\\Windows\\System32' });

    expect(buildProviderEnvironment({ HOME: '/home/explicit' }, {
      PATH: '/usr/bin:/bin', HOME: '/home/ambient',
    }, 'linux')).toMatchObject({ PATH: '/usr/bin:/bin', HOME: '/home/explicit' });
    expect(buildProviderEnvironment({ USERPROFILE: 'D:\\Users\\explicit' }, {
      PATH: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\ambient',
    }, 'win32')).toMatchObject({ PATH: 'C:\\Windows\\System32', USERPROFILE: 'D:\\Users\\explicit' });
    expect(buildProviderEnvironment({ userprofile: 'D:\\Users\\mixed-case' }, {
      PATH: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\ambient',
    }, 'win32')).toEqual({ PATH: 'C:\\Windows\\System32', userprofile: 'D:\\Users\\mixed-case' });
    expect(buildProviderEnvironment({ HOME: '' }, {
      PATH: '/usr/bin:/bin', HOME: '/home/ambient',
    }, 'linux')).toMatchObject({ PATH: '/usr/bin:/bin', HOME: '' });
  });

  it.runIf(process.platform !== 'win32' && Boolean(process.env.HOME) && existsSync('/bin/bash'))(
    'passes HOME to a real set -u bash provider wrapper',
    async () => {
      const launchAttempt = await attempt();
      const marker = join(cwd, 'provider-home.txt');
      const spec = buildWorkerLaunchBootstrapSpec(
        launchAttempt,
        ['/bin/bash', '--noprofile', '--norc', '-u', '-c', 'set -u; printf "%s" "$HOME" > "$1"; sleep 0.2', 'bash-provider', marker],
        cwd,
        { releaseAfterSpawn: true },
      );
      const bootstrap = runWorkerLaunchBootstrap(spec);
      await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 2_000, pollIntervalMs: 5 }))
        .resolves.toEqual({ ok: true });
      await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
      await expect(readFile(marker, 'utf8')).resolves.toBe(process.env.HOME);
    },
  );

  it('validates provider environment keys and propagates only explicit provider values', async () => {
    const launchAttempt = await attempt();
    expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, {
      providerEnv: { 'BAD-KEY': 'value' },
    })).toThrow('worker_launch_provider_env_key_invalid');
    expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, {
      providerEnv: { VALID_KEY: undefined },
    })).toThrow('worker_launch_provider_env_value_invalid');

    const marker = join(cwd, 'provider-env.json');
    const providerScript = `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({value:process.env.OMC_TEST_PROVIDER_VALUE,attempt:process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID,internal:process.env.OMC_WORKER_LAUNCH_SPEC_FILE}));setTimeout(()=>process.exit(0),200)`;
    const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
      launchAttempt,
      [process.execPath, '-e', providerScript],
      cwd,
      {
        providerEnv: {
          OMC_TEST_PROVIDER_VALUE: 'provider-value',
          OMC_WORKER_LAUNCH_ATTEMPT_ID: launchAttempt.attempt_id,
          OMC_WORKER_LAUNCH_SPEC_FILE: 'must-be-filtered',
        },
        releaseAfterSpawn: true,
      },
    ));
    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, { timeoutMs: 2_000, pollIntervalMs: 5 }))
      .resolves.toEqual({ ok: true });
    await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
    await expect(readFile(marker, 'utf8').then(JSON.parse)).resolves.toEqual({
      value: 'provider-value',
      attempt: launchAttempt.attempt_id,
    });
  });

  it('rejects provider environment tampering through the authority digest', async () => {
    const launchAttempt = await attempt();
    const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, {
      providerEnv: { HOME: '/home/authority-original' },
    });
    const tampered = {
      ...spec,
      provider_env: { ...spec.provider_env, HOME: '/home/authority-tampered' },
    };
    expect(tampered.authority_digest).toBe(spec.authority_digest);
    await expect(runWorkerLaunchBootstrap(tampered)).resolves.toEqual({ outcome: 'invalid_spec' });
  });

  it('routes native Windows batch shims through a percent-safe temporary wrapper without changing POSIX argv', async () => {
    const providerArgv = [
      'C:\\Program Files\\Codex\\codex.cmd',
      '--label=100% ready',
      '--home=%USERPROFILE%',
      '--encoded=%25',
      'say "hello" & continue',
      '--literal=bang! caret^',
    ];

    const windowsInvocation = buildProviderSpawnInvocation(providerArgv, 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
    expect(windowsInvocation).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c'],
      batchScript: '@echo off\r\nstart "" /b /wait "C:\\Program Files\\Codex\\codex.cmd" "--label=100%% ready" "--home=%%USERPROFILE%%" "--encoded=%%25" "say ""hello"" & continue" "--literal=bang! caret^"\r\n',
    });
    const materialized = await materializeProviderSpawnInvocation(windowsInvocation);
    const wrapperPath = materialized.args[4]!.slice(1, -1);
    await expect(readFile(wrapperPath, 'utf8')).resolves.toBe(windowsInvocation.batchScript);
    await materialized.cleanup();
    await expect(readFile(wrapperPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const supervised = await materializeProviderSpawnInvocation(windowsInvocation, { superviseWindowsTree: true });
    expect(supervised.completionPath).toBeTruthy();
    await expect(readFile(supervised.args[4]!.slice(1, -1), 'utf8')).resolves.toContain(':omc_hold');
    await expect(readFile(supervised.args[4]!.slice(1, -1), 'utf8')).resolves.toContain('provider-exit.txt');
    await supervised.cleanup();
    expect(buildProviderSpawnInvocation(providerArgv, 'linux')).toEqual({
      command: providerArgv[0],
      args: providerArgv.slice(1),
    });
    expect(buildProviderSpawnInvocation(['C:\\Tools\\codex.exe', '--version'], 'win32', { ComSpec: 'cmd.exe' }))
      .toMatchObject({ command: 'cmd.exe', args: ['/d', '/v:off', '/s', '/c'], batchScript: expect.stringContaining('codex.exe') });
  });

  it('cleans up a temporary provider wrapper when wrapper write fails', async () => {
    vi.resetModules();
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const rmMock = vi.fn(actualFs.rm);
    const writeFileMock = vi.fn(async (path: Parameters<typeof actualFs.writeFile>[0], ...args: Parameters<typeof actualFs.writeFile> extends [unknown, ...infer Rest] ? Rest : never) => {
      if (String(path).endsWith('launch.cmd')) throw new Error('synthetic write failure');
      return actualFs.writeFile(path, ...args);
    });
    vi.doMock('node:fs/promises', () => ({ ...actualFs, rm: rmMock, writeFile: writeFileMock }));
    try {
      const workerLaunch = await import('../worker-launch-ack.js');
      await expect(workerLaunch.materializeProviderSpawnInvocation({
        command: 'cmd.exe', args: ['/d', '/v:off', '/s', '/c'], batchScript: '@echo off\r\n',
      })).rejects.toThrow('synthetic write failure');
      expect(rmMock).toHaveBeenCalledWith(expect.stringContaining('omc-provider-'), { recursive: true, force: true });
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('materializes POSIX supervision without changing direct provider argv', async () => {
    cwd = await createFixture('worker-launch-posix-supervisor-');
    const invocation = await materializeProviderSpawnInvocation(
      buildProviderSpawnInvocation(['/usr/bin/codex', '--prompt', 'literal & value'], 'linux'),
      { superviseProcessTree: true },
    );
    expect(invocation.command).toBe('/bin/sh');
    expect(invocation.args.slice(1)).toEqual(['/usr/bin/codex', '--prompt', 'literal & value']);
    expect(invocation.completionPath).toBeTruthy();
    await expect(readFile(invocation.args[0]!, 'utf8')).resolves.toContain('"$@"');
    await invocation.cleanup();

    const gated = await materializeProviderSpawnInvocation(
      buildProviderSpawnInvocation(['/usr/bin/codex', '--prompt', 'literal & value'], 'linux'),
      { superviseProcessTree: true, gateProviderExecution: true },
    );
    expect(gated.providerGateFd).toBe(3);
    await expect(readFile(gated.args[0]!, 'utf8')).resolves.toContain('<&3');
    await gated.cleanup();
  });

  it.runIf(process.platform !== 'win32')('proves gated providers retain stdio and see fd3 closed', async () => {
    cwd = await createFixture('worker-launch-posix-fd-contract-');
    const providerScript = [
      'IFS= read -r message',
      'printf "stdin:%s\\n" "$message"',
      'printf "stdout:preserved\\n"',
      'printf "stderr:preserved\\n" >&2',
      'if ( : >&3 ) 2>/dev/null; then printf "fd3:open\\n" >&2; else printf "fd3:closed\\n" >&2; fi',
      'exit 0',
    ].join(';');
    const invocation = await materializeProviderSpawnInvocation(
      buildProviderSpawnInvocation(['/bin/sh', '-c', providerScript], 'linux'),
      { superviseProcessTree: true, gateProviderExecution: true },
    );
    let child: ReturnType<typeof spawn> | undefined;
    let ownedGroup: ReturnType<typeof captureOwnedProcessGroup> = null;
    let childExit: Promise<void> | undefined;
    let stdout = '';
    let stderr = '';
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        detached: true,
      });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', chunk => { stdout += String(chunk); });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', chunk => { stderr += String(chunk); });
      childExit = new Promise<void>((resolve, reject) => {
        child!.once('exit', () => resolve());
        child!.once('error', reject);
      });
      await new Promise<void>((resolve, reject) => {
        child!.once('spawn', () => resolve());
        child!.once('error', reject);
      });
      ownedGroup = captureOwnedProcessGroup(child.pid!);
      expect(ownedGroup).not.toBeNull();
      expect(invocation.providerGateFd).toBe(3);
      const gate = child.stdio[invocation.providerGateFd!] as unknown as {
        end: (chunk?: unknown, callback?: () => void) => unknown;
        on: (event: string, listener: (error: unknown) => void) => unknown;
      };
      const gateErrors: unknown[] = [];
      gate.on('error', error => { gateErrors.push(error); });
      child.stdin?.write('descriptor-message\n');
      await new Promise<void>((resolve, reject) => {
        gate.end('release\n', () => resolve());
        if (gateErrors.length > 0) reject(gateErrors[0]);
      });
      expect(gateErrors).toHaveLength(0);
      await vi.waitFor(() => {
        expect(stdout).toContain('stdin:descriptor-message\n');
        expect(stdout).toContain('stdout:preserved\n');
        expect(stderr).toContain('stderr:preserved\n');
        expect(stderr).toContain('fd3:closed\n');
        expect(stderr).not.toContain('fd3:open\n');
      }, { timeout: 2_000, interval: 5 });
      await vi.waitFor(async () => {
        await expect(readFile(invocation.completionPath!, 'utf8')).resolves.toMatch(/^0\s*$/);
      }, { timeout: 2_000, interval: 5 });
    } finally {
      if (ownedGroup) {
        await terminateOwnedProcessGroup({
          pid: ownedGroup.pid,
          expectedStartIdentity: ownedGroup.processStartIdentity,
          processGroupId: ownedGroup.processGroupId,
          deadlineAt: new Date(Date.now() + 2_000).toISOString(),
          force: true,
        }).catch(() => 'unknown');
      }
      await childExit?.catch(() => undefined);
      if (ownedGroup) {
        await vi.waitFor(() => {
          expect(() => process.kill(-ownedGroup!.processGroupId, 0))
            .toThrow(expect.objectContaining({ code: 'ESRCH' }));
        }, { timeout: 2_000, interval: 20 });
      }
      await invocation.cleanup();
    }
  });

  it.runIf(process.platform === 'win32')('distinguishes provider starts created within the same wall-clock second', async () => {
    const first = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)']);
    const second = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)']);
    await Promise.all([
      new Promise<void>((resolve, reject) => { first.once('spawn', resolve); first.once('error', reject); }),
      new Promise<void>((resolve, reject) => { second.once('spawn', resolve); second.once('error', reject); }),
    ]);
    try {
      const [firstIdentity, secondIdentity] = await Promise.all([
        getProcessStartIdentity(first.pid!), getProcessStartIdentity(second.pid!),
      ]);
      expect(firstIdentity).toMatch(/^(dmtf|ticks):/);
      expect(secondIdentity).toMatch(/^(dmtf|ticks):/);
      expect(firstIdentity).not.toBe(secondIdentity);
    } finally {
      first.kill('SIGKILL');
      second.kill('SIGKILL');
    }
  });

  it.runIf(process.platform === 'win32').each(['cmd', 'bat'])('round-trips native .%s arguments through a real batch shim', async (extension) => {
    cwd = await createFixture(`worker-launch-native-${extension}-`);
    const providerPath = join(cwd, `provider.${extension}`);
    const outputPath = join(cwd, 'argv.json');
    await writeFile(providerPath, `@echo off\r\n"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)))" %*\r\n`, 'utf8');
    const payload = ['100% ready', '%USERPROFILE%', 'bang!', 'caret^', 'say "hello" & continue', 'two words'];
    const invocation = await materializeProviderSpawnInvocation(buildProviderSpawnInvocation(
      [providerPath, outputPath, ...payload],
      'win32',
      { ComSpec: process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe' },
    ));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, { stdio: 'pipe' });
      child.once('error', reject);
      child.once('exit', code => resolve(code));
    });
    expect(exitCode).toBe(0);
    await expect(readFile(outputPath, 'utf8').then(JSON.parse)).resolves.toEqual(payload);
    const wrapperPath = invocation.args[4]!.slice(1, -1);
    await invocation.cleanup();
    await expect(readFile(wrapperPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.runIf(process.platform === 'win32')('keeps a supervisor root alive until an early-exit provider tree is terminated', async () => {
    cwd = await createFixture('worker-launch-native-supervisor-');
    const providerPath = join(cwd, 'early-provider.cmd');
    const childPidPath = join(cwd, 'early-provider-child.pid');
    await writeFile(providerPath, `@echo off\r\n"${process.execPath}" -e "const fs=require('fs'),cp=require('child_process');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));c.unref()" "${childPidPath}"\r\n`, 'utf8');
    const invocation = await materializeProviderSpawnInvocation(buildProviderSpawnInvocation(
      [providerPath], 'win32', { ComSpec: process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe' },
    ), { superviseWindowsTree: true });
    const supervisor = spawn(invocation.command, invocation.args, { stdio: 'ignore', windowsHide: true });
    await expect.poll(async () => invocation.completionPath ? await readFile(invocation.completionPath, 'utf8').catch(() => '') : '').toMatch(/0/);
    const childPid = Number(await readFile(childPidPath, 'utf8'));
    expect(isProcessAlive(childPid)).toBe(true);
    const identity = await getProcessStartIdentity(supervisor.pid!);
    expect(identity).toBeTruthy();
    await expect(terminateOwnedProcessTree({ pid: supervisor.pid!, expectedStartIdentity: identity!,
      deadlineAt: new Date(Date.now() + 5_000).toISOString(), force: true })).resolves.toBe('terminated');
    await expect.poll(() => isProcessAlive(childPid), { timeout: 2_000, interval: 20 }).toBe(false);
    await invocation.cleanup();
  });

  it('rejects CRLF-bearing native Windows batch arguments before materializing a wrapper', () => {
    expect(() => buildProviderSpawnInvocation(
      ['C:\\Tools\\provider.cmd', '--prompt=line one\r\nwhoami'],
      'win32',
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    )).toThrow('worker_launch_provider_argv_invalid');
  });

  it('excludes ambient secret environment values and rejects Windows aliases', async () => {
    const launchAttempt = await attempt();
    const spec = buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, { providerEnv: { EXPLICIT: 'yes' } });
    for (const key of ['GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'HTTPS_PROXY']) {
      expect(spec.provider_env).not.toHaveProperty(key);
    }
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, { providerEnv: { OMC_WORKER_LAUNCH_SPEC_FILE: 'x' } })).toThrow('worker_launch_provider_env_reserved');
      expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, { providerEnv: { PATH: 'one', Path: 'two' } })).toThrow('worker_launch_provider_env_key_alias_conflict');
      expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, { providerEnv: { SystemRoot: 'D:\\attacker' } })).toThrow('worker_launch_provider_env_reserved');
      expect(() => buildWorkerLaunchBootstrapSpec(launchAttempt, ['codex'], cwd, { providerEnv: { SYSTEMROOT: 'D:\\attacker' } })).toThrow('worker_launch_provider_env_reserved');
    } finally { Object.defineProperty(process, 'platform', { value: originalPlatform }); }
  });

  it('binds the Windows supervisor source, environment, Job Object, and argv protocol', () => {
    const source = buildWindowsSupervisorSource();
    const create = source.indexOf('CreateProcessW(');
    const assign = source.indexOf('AssignProcessToJobObject(');
    const resume = source.indexOf('ResumeThread(');

    expect(create).toBeGreaterThan(-1);
    expect(source).toContain('0x00000400');
    expect(source).toContain('AllocHGlobal($envBytes.Length)');
    expect(source).toContain('BasicLimitInformation.LimitFlags = 0x2000');
    expect(source).toContain('SetInformationJobObject');
    expect(assign).toBeGreaterThan(create);
    expect(resume).toBeGreaterThan(assign);
    expect(source).toContain('TerminateJobObject');
    expect(source).toContain('if (-not [O]::TerminateJobObject');
    expect(source).toContain('WaitForSingleObject($job, 5000)');
    expect(source).toContain('worker_launch_job_cleanup_timeout');
    expect(source).toContain('process_start_identity=("ticks:" +');
    expect(source).toContain('containment_nonce=$payload.containment_nonce');
    expect(source).toContain('finally {');
  });

  it('quotes exact Windows CreateProcess arguments', () => {
    expect(quoteWindowsCreateProcessArgument('')).toBe('""');
    expect(quoteWindowsCreateProcessArgument('plain')).toBe('"plain"');
    expect(quoteWindowsCreateProcessArgument('two words')).toBe('"two words"');
    expect(quoteWindowsCreateProcessArgument('C:\\path with space\\')).toBe('"C:\\path with space\\\\"');
    expect(quoteWindowsCreateProcessArgument('say "hello"')).toBe('"say \\"hello\\""');
    expect(() => quoteWindowsCreateProcessArgument('bad\r\narg')).toThrow('worker_launch_provider_argv_invalid');
  });

  it('rejects substituted authority fields and descriptor symlinks', async () => {
    const launchAttempt = await attempt();
    const materialized = await materializeWorkerLaunchTransport({ attempt: launchAttempt, providerArgv: ['codex'], cwd });
    const descriptor = JSON.parse(await readFile(materialized.bootstrapDescriptorPath, 'utf8')) as Record<string, unknown>;
    descriptor.provider_argv = ['tampered'];
    await writeFile(materialized.bootstrapDescriptorPath, JSON.stringify(descriptor), 'utf8');
    await expect(readAndConsumeWorkerLaunchDescriptor(materialized.bootstrapDescriptorPath)).rejects.toThrow('worker_launch_descriptor_invalid');
    await rm(materialized.bootstrapDescriptorPath, { force: true });
    await symlink(materialized.wrapperPath, materialized.bootstrapDescriptorPath);
    await expect(readAndConsumeWorkerLaunchDescriptor(materialized.bootstrapDescriptorPath)).rejects.toThrow();
  });
});