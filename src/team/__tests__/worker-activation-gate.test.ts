import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWorkerActivationGate } from '../worker-activation-gate.js';
import { awaitWorkerLaunchAcknowledgement, prepareWorkerLaunchAttempt } from '../worker-launch-ack.js';
import { isProcessAlive } from '../../platform/process-utils.js';

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'recovery-gate-')); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

async function acceptedAttempt(workerName: string, paneId: string, recoveryId: string, generation: number, paneAttemptId: string) {
  const attempt = await prepareWorkerLaunchAttempt({
    cwd,
    teamName: 'recovery-gate-team',
    workerName,
    paneId,
    provider: 'codex',
    runtimeCliPath: '/runtime-cli.cjs',
    context: { kind: 'recovery', recovery_id: recoveryId, replacement_generation: generation, pane_attempt_id: paneAttemptId },
  });
  const expected = JSON.parse(readFileSync(attempt.expectedPath, 'utf8'));
  writeFileSync(attempt.ackPath, JSON.stringify({ ...expected, kind: 'worker_launch_ack', written_at: new Date().toISOString() }));
  await expect(awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 1_000, pollIntervalMs: 5 })).resolves.toEqual({ ok: true });
  return attempt;
}

describe('worker recovery activation gate', () => {
  it('spawns the provider only after matching activate and run records and publishes launched evidence', async () => {
    const readyPath = join(cwd, 'ready.json');
    const activatePath = join(cwd, 'activate.json');
    const runPath = join(cwd, 'run.json');
    const launchAttempt = await acceptedAttempt('worker-1', '%2', 'recovery-a', 2, 'attempt-a');
    const record = { recovery_id: 'recovery-a', worker_name: 'worker-1', replacement_generation: 2,
      pane_attempt_id: 'attempt-a', launch_attempt_id: launchAttempt.attempt_id, launch_nonce: launchAttempt.nonce,
      written_at: new Date().toISOString() };
    writeFileSync(activatePath, JSON.stringify(record));
    writeFileSync(runPath, JSON.stringify(record));
    await expect(runWorkerActivationGate({
      recoveryId: 'recovery-a',
      workerName: 'worker-1',
      replacementGeneration: 2,
      paneAttemptId: 'attempt-a',
      readyPath,
      activatePath,
      runPath,
      providerArgv: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 350)'],
      launchAttempt,
      cwd,
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    })).resolves.toMatchObject({ outcome: 'ran', exitCode: 0 });

    expect(existsSync(readyPath)).toBe(true);
    expect(existsSync(`${readyPath}.adoption-ready`)).toBe(true);
    expect(existsSync(`${runPath}.launched`)).toBe(true);
    expect(JSON.parse(readFileSync(`${runPath}.launched`, 'utf8'))).toMatchObject({
      launch_attempt_id: launchAttempt.attempt_id,
      launch_nonce: launchAttempt.nonce,
      pane_attempt_id: 'attempt-a',
    });
  });

  it.each([0, 7])('does not publish launched evidence for a provider that exits immediately with code %s', async exitCode => {
    const readyPath = join(cwd, 'early-exit-ready.json');
    const activatePath = join(cwd, 'early-exit-activate.json');
    const runPath = join(cwd, 'early-exit-run.json');
    const launchAttempt = await acceptedAttempt('worker-1', '%9', 'recovery-early-exit', 9, 'attempt-early-exit');
    const record = { recovery_id: 'recovery-early-exit', worker_name: 'worker-1', replacement_generation: 9,
      pane_attempt_id: 'attempt-early-exit', launch_attempt_id: launchAttempt.attempt_id, launch_nonce: launchAttempt.nonce,
      written_at: new Date().toISOString() };
    writeFileSync(activatePath, JSON.stringify(record));
    writeFileSync(runPath, JSON.stringify(record));

    await expect(runWorkerActivationGate({
      recoveryId: 'recovery-early-exit', workerName: 'worker-1', replacementGeneration: 9, paneAttemptId: 'attempt-early-exit',
      readyPath, activatePath, runPath, providerArgv: [process.execPath, '-e', `process.exit(${exitCode})`],
      launchAttempt, cwd, timeoutMs: 1_000, pollIntervalMs: 5,
    })).resolves.toEqual({ outcome: 'ran', exitCode, signal: null });
    expect(existsSync(`${runPath}.launched`)).toBe(false);
    expect(JSON.parse(readFileSync(`${runPath}.terminal`, 'utf8'))).toMatchObject({ outcome: 'exit', exit_code: exitCode });
  });
  it('does not publish launched evidence when the provider executable cannot spawn', async () => {
    const readyPath = join(cwd, 'failed-ready.json');
    const activatePath = join(cwd, 'failed-activate.json');
    const runPath = join(cwd, 'failed-run.json');
    const launchAttempt = await acceptedAttempt('worker-1', '%3', 'recovery-b', 3, 'attempt-b');
    const record = { recovery_id: 'recovery-b', worker_name: 'worker-1', replacement_generation: 3,
      pane_attempt_id: 'attempt-b', launch_attempt_id: launchAttempt.attempt_id, launch_nonce: launchAttempt.nonce,
      written_at: new Date().toISOString() };
    writeFileSync(activatePath, JSON.stringify(record));
    writeFileSync(runPath, JSON.stringify(record));
    await expect(runWorkerActivationGate({
      recoveryId: 'recovery-b', workerName: 'worker-1', replacementGeneration: 3, paneAttemptId: 'attempt-b',
      readyPath, activatePath, runPath, providerArgv: [join(cwd, 'missing-provider')], cwd,
      launchAttempt,
      timeoutMs: 1_000, pollIntervalMs: 5,
    })).resolves.toEqual({ outcome: 'provider_spawn_failed' });
    expect(existsSync(`${runPath}.launched`)).toBe(false);
    expect(JSON.parse(readFileSync(`${runPath}.terminal`, 'utf8'))).toMatchObject({ outcome: 'error' });
  });
  it('kills the provider when durable launched evidence cannot be published', async () => {
    const readyPath = join(cwd, 'marker-failure-ready.json');
    const activatePath = join(cwd, 'marker-failure-activate.json');
    const runPath = join(cwd, 'marker-failure-run.json');
    const launchAttempt = await acceptedAttempt('worker-1', '%10', 'recovery-marker-failure', 10, 'attempt-marker-failure');
    const record = { recovery_id: 'recovery-marker-failure', worker_name: 'worker-1', replacement_generation: 10,
      pane_attempt_id: 'attempt-marker-failure', launch_attempt_id: launchAttempt.attempt_id, launch_nonce: launchAttempt.nonce,
      written_at: new Date().toISOString() };
    writeFileSync(activatePath, JSON.stringify(record));
    writeFileSync(runPath, JSON.stringify(record));
    mkdirSync(`${runPath}.launched`);

    const startedAt = Date.now();
    await expect(runWorkerActivationGate({
      recoveryId: 'recovery-marker-failure', workerName: 'worker-1', replacementGeneration: 10,
      paneAttemptId: 'attempt-marker-failure', readyPath, activatePath, runPath,
      providerArgv: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 5000)'],
      launchAttempt, cwd, timeoutMs: 1_000, pollIntervalMs: 5,
    })).resolves.toEqual({ outcome: 'provider_spawn_failed' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const terminal = JSON.parse(readFileSync(`${runPath}.terminal`, 'utf8'));
    expect(terminal).toMatchObject({ outcome: 'exit' });
    expect(isProcessAlive(terminal.provider_pid)).toBe(false);
  });

  it.each([
    ['launch_attempt_id', 'wrong-attempt'],
    ['launch_nonce', 'wrong-nonce'],
  ] as const)('rejects recovery markers when only %s differs', async (field, replacement) => {
    const readyPath = join(cwd, `${field}-ready.json`);
    const activatePath = join(cwd, `${field}-activate.json`);
    const runPath = join(cwd, `${field}-run.json`);
    const providerMarker = join(cwd, `${field}-provider-ran`);
    const launchAttempt = await acceptedAttempt('worker-1', '%7', 'recovery-exact', 8, 'attempt-exact');
    const record = {
      recovery_id: 'recovery-exact', worker_name: 'worker-1', replacement_generation: 8,
      pane_attempt_id: 'attempt-exact', launch_attempt_id: launchAttempt.attempt_id,
      launch_nonce: launchAttempt.nonce, written_at: new Date().toISOString(),
      [field]: replacement,
    };
    writeFileSync(activatePath, JSON.stringify(record));
    writeFileSync(runPath, JSON.stringify(record));

    await expect(runWorkerActivationGate({
      recoveryId: 'recovery-exact', workerName: 'worker-1', replacementGeneration: 8, paneAttemptId: 'attempt-exact',
      readyPath, activatePath, runPath,
      providerArgv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran')`],
      launchAttempt,
      cwd,
      timeoutMs: 50,
      pollIntervalMs: 5,
    })).resolves.toEqual({ outcome: 'activation_timeout' });
    expect(existsSync(providerMarker)).toBe(false);
    expect(existsSync(`${runPath}.launched`)).toBe(false);
  });

  it('rejects a stale recovery gate before the provider can run', async () => {
    const readyPath = join(cwd, 'stale-ready.json');
    const activatePath = join(cwd, 'stale-activate.json');
    const runPath = join(cwd, 'stale-run.json');
    const providerMarker = join(cwd, 'stale-provider-ran');
    const record = { recovery_id: 'recovery-stale', worker_name: 'worker-1', replacement_generation: 4,
      pane_attempt_id: 'attempt-stale', launch_attempt_id: 'stale-launch', launch_nonce: 'stale-nonce', written_at: new Date().toISOString() };
    writeFileSync(activatePath, JSON.stringify(record));
    writeFileSync(runPath, JSON.stringify(record));
    const launchAttempt = await acceptedAttempt('worker-1', '%4', 'recovery-current', 5, 'attempt-current');

    await expect(runWorkerActivationGate({
      recoveryId: 'recovery-stale', workerName: 'worker-1', replacementGeneration: 4, paneAttemptId: 'attempt-stale',
      readyPath, activatePath, runPath,
      providerArgv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran')`],
      launchAttempt,
      cwd,
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    })).resolves.toEqual({ outcome: 'superseded' });
    expect(existsSync(providerMarker)).toBe(false);
    expect(existsSync(`${runPath}.launched`)).toBe(false);
  });

  it('blocks a gate superseded after activation but before provider spawn', async () => {
    const readyPath = join(cwd, 'superseded-ready.json');
    const activatePath = join(cwd, 'superseded-activate.json');
    const runPath = join(cwd, 'superseded-run.json');
    const providerMarker = join(cwd, 'superseded-provider-ran');
    const launchAttempt = await acceptedAttempt('worker-1', '%5', 'recovery-old', 6, 'attempt-old');
    const record = { recovery_id: 'recovery-old', worker_name: 'worker-1', replacement_generation: 6,
      pane_attempt_id: 'attempt-old', launch_attempt_id: launchAttempt.attempt_id, launch_nonce: launchAttempt.nonce,
      written_at: new Date().toISOString() };
    writeFileSync(activatePath, JSON.stringify(record));

    const gate = runWorkerActivationGate({
      recoveryId: 'recovery-old', workerName: 'worker-1', replacementGeneration: 6, paneAttemptId: 'attempt-old',
      readyPath, activatePath, runPath,
      providerArgv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(providerMarker)}, 'ran')`],
      launchAttempt,
      cwd,
      timeoutMs: 2_000,
      pollIntervalMs: 5,
    });
    for (let index = 0; index < 200 && !existsSync(`${readyPath}.adoption-ready`); index++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(existsSync(`${readyPath}.adoption-ready`)).toBe(true);
    await prepareWorkerLaunchAttempt({
      cwd,
      teamName: launchAttempt.team_name,
      workerName: launchAttempt.worker_name,
      paneId: '%6',
      provider: launchAttempt.provider,
      runtimeCliPath: launchAttempt.runtimeCliPath,
      context: { kind: 'recovery', recovery_id: 'recovery-new', replacement_generation: 7, pane_attempt_id: 'attempt-new' },
    });
    writeFileSync(runPath, JSON.stringify(record));

    await expect(gate).resolves.toEqual({ outcome: 'superseded' });
    expect(existsSync(providerMarker)).toBe(false);
    expect(existsSync(`${runPath}.launched`)).toBe(false);
  });

});
