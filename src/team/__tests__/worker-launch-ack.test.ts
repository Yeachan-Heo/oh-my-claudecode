import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  awaitWorkerLaunchAcknowledgement,
  awaitWorkerLaunchProviderStarted,
  buildWorkerLaunchBootstrapSpec,
  isWorkerLaunchAttemptAccepted,
  isWorkerLaunchProviderStarted,
  loadWorkerLaunchAttempt,
  loadCurrentWorkerLaunchAttempt,
  prepareWorkerLaunchAttempt,
  runWorkerLaunchBootstrap,
  retireWorkerLaunchAttempt,
  terminateWorkerLaunchProvider,
  revokeWorkerLaunchAttempt,
  buildProviderSpawnInvocation,
  materializeProviderSpawnInvocation,
} from '../worker-launch-ack.js';
import { isProcessAlive } from '../../platform/process-utils.js';

let cwd = '';

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
  cwd = '';
});

async function attempt() {
  cwd = await mkdtemp(join(tmpdir(), 'worker-launch-ack-'));
  return prepareWorkerLaunchAttempt({
    cwd,
    teamName: 'launch-team',
    workerName: 'worker-1',
    paneId: '%2',
    provider: 'codex',
    runtimeCliPath: '/runtime-cli.cjs',
  });
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

  it('rejects a provider that exits after publishing start evidence but before handoff', async () => {
    const launchAttempt = await attempt();
    const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
      launchAttempt,
      [process.execPath, '-e', 'setTimeout(() => process.exit(0), 100)'],
      cwd,
    ));
    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
    })).resolves.toEqual({ ok: true });
    await vi.waitFor(async () => {
      await expect(isWorkerLaunchProviderStarted(launchAttempt)).resolves.toBe(true);
    }, { timeout: 2_000, interval: 5 });
    await new Promise(resolve => setTimeout(resolve, 150));
    await expect(awaitWorkerLaunchProviderStarted(launchAttempt, {
      timeoutMs: 50,
      pollIntervalMs: 5,
    })).resolves.toBe(false);
    await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
  });

  it('kills provider descendants when the root exits before start publication', async () => {
    const launchAttempt = await attempt();
    const childPidPath = join(cwd, 'early-exit-child-pid');
    const providerScript = [
      "const fs=require('node:fs')",
      "const cp=require('node:child_process')",
      "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref()",
      `fs.writeFileSync(${JSON.stringify(childPidPath)},String(child.pid))`,
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
    await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
    const childPid = Number(await readFile(childPidPath, 'utf8'));
    await vi.waitFor(() => expect(isProcessAlive(childPid)).toBe(false), { timeout: 2_000, interval: 20 });
    await expect(readFile(launchAttempt.startedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(isProcessAlive(process.pid)).toBe(true);
    await expect(readFile(`${launchAttempt.startedPath}.terminal`, 'utf8')).resolves.toContain('worker_launch_provider_terminal');
  });

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

  it('retires and terminates the exact started provider process tree', async () => {
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
    await expect(retireWorkerLaunchAttempt(launchAttempt, 'pane_cleanup')).resolves.toBe(true);
    await expect(terminateWorkerLaunchProvider(launchAttempt)).resolves.toBe(true);
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
    const bootstrap = runWorkerLaunchBootstrap(buildWorkerLaunchBootstrapSpec(
      launchAttempt,
      [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran')`],
      cwd,
    ));

    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
    })).resolves.toEqual({ ok: true });
    await expect(revokeWorkerLaunchAttempt(launchAttempt, 'late_timeout')).resolves.toBe(false);
    await expect(bootstrap).resolves.toEqual({ outcome: 'ran', exitCode: 0, signal: null });
    await expect(readFile(providerMarker, 'utf8')).resolves.toBe('ran');
    const decision = JSON.parse(await readFile(launchAttempt.decisionPath, 'utf8'));
    expect(decision).toMatchObject({ decision: 'accepted', reason: 'ack_valid' });
  });

  it('prevents an older acknowledged attempt from releasing a provider after supersession', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-worker-launch-recovery-generation-'));
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
    cwd = await mkdtemp(join(tmpdir(), 'omc-worker-launch-current-'));
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
      batchScript: '@echo off\r\n"C:\\Program Files\\Codex\\codex.cmd" "--label=100%% ready" "--home=%%USERPROFILE%%" "--encoded=%%25" "say ""hello"" & continue" "--literal=bang! caret^"\r\n',
    });
    const materialized = await materializeProviderSpawnInvocation(windowsInvocation);
    const wrapperPath = materialized.args[4]!.slice(1, -1);
    await expect(readFile(wrapperPath, 'utf8')).resolves.toBe(windowsInvocation.batchScript);
    await materialized.cleanup();
    await expect(readFile(wrapperPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(buildProviderSpawnInvocation(providerArgv, 'linux')).toEqual({
      command: providerArgv[0],
      args: providerArgv.slice(1),
    });
  });

  it.runIf(process.platform === 'win32')('round-trips native cmd arguments through a real batch shim', async () => {
    const providerPath = join(cwd, 'provider.cmd');
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

  it('rejects CRLF-bearing native Windows batch arguments before materializing a wrapper', () => {
    expect(() => buildProviderSpawnInvocation(
      ['C:\\Tools\\provider.cmd', '--prompt=line one\r\nwhoami'],
      'win32',
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    )).toThrow('worker_launch_provider_argv_invalid');
  });

});
