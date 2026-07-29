import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWorkerActivationGate } from '../worker-activation-gate.js';
import { awaitWorkerLaunchAcknowledgement, prepareWorkerLaunchAttempt } from '../worker-launch-ack.js';

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
    const record = { recovery_id: 'recovery-a', worker_name: 'worker-1', replacement_generation: 2,
      pane_attempt_id: 'attempt-a', written_at: new Date().toISOString() };
    writeFileSync(activatePath, JSON.stringify(record));
    writeFileSync(runPath, JSON.stringify(record));

    const launchAttempt = await acceptedAttempt('worker-1', '%2', 'recovery-a', 2, 'attempt-a');
    await expect(runWorkerActivationGate({
      recoveryId: 'recovery-a',
      workerName: 'worker-1',
      replacementGeneration: 2,
      paneAttemptId: 'attempt-a',
      readyPath,
      activatePath,
      runPath,
      providerArgv: [process.execPath, '-e', 'process.exit(0)'],
      launchAttempt,
      cwd,
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    })).resolves.toMatchObject({ outcome: 'ran', exitCode: 0 });

    expect(existsSync(readyPath)).toBe(true);
    expect(existsSync(`${readyPath}.adoption-ready`)).toBe(true);
    expect(existsSync(`${runPath}.launched`)).toBe(true);
  });

  it('does not publish launched evidence when the provider executable cannot spawn', async () => {
    const readyPath = join(cwd, 'failed-ready.json');
    const activatePath = join(cwd, 'failed-activate.json');
    const runPath = join(cwd, 'failed-run.json');
    const record = { recovery_id: 'recovery-b', worker_name: 'worker-1', replacement_generation: 3,
      pane_attempt_id: 'attempt-b', written_at: new Date().toISOString() };
    writeFileSync(activatePath, JSON.stringify(record));
    writeFileSync(runPath, JSON.stringify(record));

    const launchAttempt = await acceptedAttempt('worker-1', '%3', 'recovery-b', 3, 'attempt-b');
    await expect(runWorkerActivationGate({
      recoveryId: 'recovery-b', workerName: 'worker-1', replacementGeneration: 3, paneAttemptId: 'attempt-b',
      readyPath, activatePath, runPath, providerArgv: [join(cwd, 'missing-provider')], cwd,
      launchAttempt,
      timeoutMs: 1_000, pollIntervalMs: 5,
    })).resolves.toEqual({ outcome: 'provider_spawn_failed' });
    expect(existsSync(`${runPath}.launched`)).toBe(false);
  });
  it('rejects a stale recovery gate before the provider can run', async () => {
    const readyPath = join(cwd, 'stale-ready.json');
    const activatePath = join(cwd, 'stale-activate.json');
    const runPath = join(cwd, 'stale-run.json');
    const providerMarker = join(cwd, 'stale-provider-ran');
    const record = { recovery_id: 'recovery-stale', worker_name: 'worker-1', replacement_generation: 4,
      pane_attempt_id: 'attempt-stale', written_at: new Date().toISOString() };
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

});
