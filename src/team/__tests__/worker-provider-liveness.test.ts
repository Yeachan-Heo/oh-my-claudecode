import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  awaitWorkerLaunchAcknowledgement,
  prepareWorkerLaunchAttempt,
  type WorkerLaunchAttempt,
} from '../worker-launch-ack.js';
import { getWorkerProviderLiveness } from '../worker-provider-liveness.js';

const TEAM = 'liveness-team';
const INSTANCE_ID = '44444444-4444-4444-8444-444444444444';

let cwd = '';
let restoreEnv: (() => void) | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'omc-provider-liveness-'));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, OMC_STATE_DIR: process.env.OMC_STATE_DIR };
  process.env.HOME = cwd;
  process.env.USERPROFILE = cwd;
  delete process.env.OMC_STATE_DIR;
  restoreEnv = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
});

afterEach(async () => {
  restoreEnv?.();
  await rm(cwd, { recursive: true, force: true });
});

async function acceptedAttempt(): Promise<WorkerLaunchAttempt> {
  const attempt = await prepareWorkerLaunchAttempt({
    cwd,
    teamName: TEAM,
    workerName: 'worker-1',
    instanceId: INSTANCE_ID,
    paneId: '%2',
    provider: 'claude',
    runtimeCliPath: '/runtime-cli.cjs',
    context: { kind: 'initial' },
  });
  const expected = JSON.parse(await readFile(attempt.expectedPath, 'utf8')) as Record<string, unknown>;
  await writeFile(attempt.ackPath, JSON.stringify({ ...expected, kind: 'worker_launch_ack', written_at: new Date().toISOString() }));
  await expect(awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 1_000, pollIntervalMs: 5 }))
    .resolves.toEqual({ ok: true });
  return attempt;
}

async function recordProviderExit(attempt: WorkerLaunchAttempt): Promise<void> {
  const expected = JSON.parse(await readFile(attempt.expectedPath, 'utf8')) as Record<string, unknown>;
  const processIdentity = {
    pid: 999_999,
    process_start_identity: process.platform === 'darwin' ? 'darwin:1:0' : `${process.platform}:1`,
    process_group_id: 999_999,
  };
  await writeFile(attempt.startedPath, JSON.stringify({
    ...expected, kind: 'worker_launch_provider_started', ...processIdentity, written_at: new Date().toISOString(),
  }));
  await writeFile(`${attempt.startedPath}.terminal`, JSON.stringify({
    ...expected,
    kind: 'worker_launch_provider_terminal',
    outcome: 'exit',
    cleanup_verified: true,
    child_reaped: true,
    ...processIdentity,
    written_at: new Date().toISOString(),
  }));
}

function worker(attemptId: string | undefined) {
  return { name: 'worker-1', pane_id: '%2', worker_cli: 'claude' as const, launch_attempt_id: attemptId };
}

describe('getWorkerProviderLiveness', () => {
  it('reports dead once the launch attempt records a reaped provider exit', async () => {
    const attempt = await acceptedAttempt();
    await recordProviderExit(attempt);

    await expect(getWorkerProviderLiveness(TEAM, cwd, INSTANCE_ID, worker(attempt.attempt_id)))
      .resolves.toBe('dead');
  });

  it('reports unknown before the provider has started', async () => {
    const attempt = await acceptedAttempt();

    await expect(getWorkerProviderLiveness(TEAM, cwd, INSTANCE_ID, worker(attempt.attempt_id)))
      .resolves.toBe('unknown');
  });

  it.each([
    ['a legacy worker without a launch attempt', INSTANCE_ID, undefined],
    ['a team without an instance id', undefined, 'attempt-1'],
    ['an attempt id with no receipt on disk', INSTANCE_ID, 'attempt-missing'],
  ])('reports unknown for %s', async (_name, instanceId, attemptId) => {
    await expect(getWorkerProviderLiveness(TEAM, cwd, instanceId, worker(attemptId)))
      .resolves.toBe('unknown');
  });
});
