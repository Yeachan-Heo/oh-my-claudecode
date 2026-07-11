import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWorkerActivationGate } from '../worker-activation-gate.js';

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'recovery-gate-')); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

describe('worker recovery activation gate', () => {
  it('spawns the provider only after matching activate and run records and publishes launched evidence', async () => {
    const readyPath = join(cwd, 'ready.json');
    const activatePath = join(cwd, 'activate.json');
    const runPath = join(cwd, 'run.json');
    const record = { recovery_id: 'recovery-a', worker_name: 'worker-1', replacement_generation: 2,
      pane_attempt_id: 'attempt-a', written_at: new Date().toISOString() };
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
      providerArgv: [process.execPath, '-e', 'process.exit(0)'],
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

    await expect(runWorkerActivationGate({
      recoveryId: 'recovery-b', workerName: 'worker-1', replacementGeneration: 3, paneAttemptId: 'attempt-b',
      readyPath, activatePath, runPath, providerArgv: [join(cwd, 'missing-provider')], cwd,
      timeoutMs: 1_000, pollIntervalMs: 5,
    })).resolves.toEqual({ outcome: 'provider_spawn_failed' });
    expect(existsSync(`${runPath}.launched`)).toBe(false);
  });
});
