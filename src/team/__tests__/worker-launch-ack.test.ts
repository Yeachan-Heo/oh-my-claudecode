import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  awaitWorkerLaunchAcknowledgement,
  buildWorkerLaunchBootstrapSpec,
  isWorkerLaunchAttemptAccepted,
  loadWorkerLaunchAttempt,
  prepareWorkerLaunchAttempt,
  runWorkerLaunchBootstrap,
} from '../worker-launch-ack.js';

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
    const spec = buildWorkerLaunchBootstrapSpec(
      launchAttempt,
      [process.execPath, '-e', ' '],
      cwd,
    );

    const bootstrap = runWorkerLaunchBootstrap(spec);
    await expect(awaitWorkerLaunchAcknowledgement(launchAttempt, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
    })).resolves.toEqual({ ok: true });
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
      [process.execPath, '-e', 'process.exit(0)'],
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
  });

  it('reloads an accepted attempt only for the exact pane and provider identity', async () => {
    const launchAttempt = await attempt();
    const spec = buildWorkerLaunchBootstrapSpec(
      launchAttempt,
      [process.execPath, '-e', 'process.exit(0)'],
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
  });
});
