import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = vi.hoisted(() => vi.fn());
vi.mock('../../../platform/process-utils.js', () => ({
  getProcessStartIdentity: vi.fn(async () => 'deadline-test-identity'),
  isProcessIdentityLive: vi.fn(async () => 'dead'),
}));
vi.mock('../action-runner.js', () => ({ runSessionEndAction: runner }));
vi.mock('../action-watchdog.js', () => ({ armSessionEndActionWatchdog: () => () => undefined }));

import { prepareCoreManifest, readSessionEndJob, sealCoreManifest, sealWikiManifest } from '../cleanup-manifest.js';
import * as manifest from '../cleanup-manifest.js';
import { processSessionEndWorker } from '../worker.js';

let directory: string;
beforeEach(() => {
  vi.useFakeTimers();
  directory = mkdtempSync(join(tmpdir(), 'omc-worker-deadline-'));
  vi.stubEnv('HOME', directory);
  vi.stubEnv('USERPROFILE', directory);
  runner.mockReset().mockResolvedValue({ completed: true, code: 'completed' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('SessionEnd worker run deadline', () => {
  it.each(['completed', 'failed', 'unrecorded'])('reschedules unstarted required actions after a deadline (first action: %s)', async (outcome) => {
    const completed = outcome === 'completed';
    if (outcome === 'unrecorded') vi.spyOn(manifest, 'finishSessionEndAction').mockReturnValueOnce(null);
    const sessionId = 'deadline-reschedule';
    expect(prepareCoreManifest(directory, sessionId, {})).not.toBeNull();
    expect(sealCoreManifest(directory, sessionId)).not.toBeNull();
    expect(sealWikiManifest(directory, sessionId)).not.toBeNull();
    runner.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 10_000);
      return { completed, code: completed ? 'completed' : 'deadline-exceeded' };
    });

    await processSessionEndWorker({ directory, sessionId });

    const job = readSessionEndJob(directory, sessionId)!;
    expect(job.owner).toBeNull();
    expect(job.recoverableFailure?.reason).toBe('run-deadline-reached');
    expect(job.actions['foreground-cleanup'].status).toBe(completed ? 'completed' : 'retryable');
    expect(job.actions['team-cleanup']).toMatchObject({ status: 'retryable', attempts: 0 });
    expect(job.actions['python-cleanup']).toMatchObject({ status: 'retryable', attempts: 0 });
    expect(job.actions.callback.status).toBe('pending');
    expect(vi.getTimerCount()).toBe(1);

    await vi.runAllTimersAsync();

    expect(readSessionEndJob(directory, sessionId)).toMatchObject({ owner: null, phase: 'complete' });
    expect(runner.mock.calls.length).toBeGreaterThan(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
