import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const actions = vi.hoisted(() => ({
  cleanupSessionOwnedTeams: vi.fn(async () => ({ attempted: [], cleaned: [], failed: [] })),
  cleanupSessionPython: vi.fn(async () => undefined),
  cleanupSessionReplies: vi.fn(async () => undefined),
  runSessionEndCallbacks: vi.fn(async () => undefined),
  runSessionEndNotifications: vi.fn(async () => undefined),
  runSessionEndOpenClaw: vi.fn(async () => undefined),
  runForegroundSessionEndCleanup: vi.fn(async () => undefined),
}));
const processIdentity = vi.hoisted(() => ({
  getProcessStartIdentity: vi.fn(async () => 'test-process-start'),
  isProcessIdentityLive: vi.fn(async () => 'dead' as const),
}));

vi.mock('../index.js', () => actions);
vi.mock('../../../platform/process-utils.js', () => processIdentity);
vi.mock('../action-runner.js', () => ({
  runSessionEndAction: vi.fn(async (_context: unknown, execute: () => Promise<void>) => {
    await execute();
    return { code: 'completed', completed: true };
  }),
}));

import { prepareCoreManifest, readSessionEndJob, sealCoreManifest, sealWikiManifest } from '../cleanup-manifest.js';
import { processSessionEndWorker, reconcileSessionEndJobs } from '../worker.js';

const directories: string[] = [];

function project(): string {
  const directory = mkdtempSync(join(tmpdir(), 'omc-session-end-worker-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  vi.clearAllMocks();
  processIdentity.getProcessStartIdentity.mockResolvedValue('test-process-start');
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('SessionEnd durable worker', () => {
  it('concurrent workers execute each action at most once and leave a recoverable manifest', async () => {
    const directory = project();
    const sessionId = 'two-workers';
    expect(prepareCoreManifest(directory, sessionId, { initialTeamNames: [] })).not.toBeNull();
    expect(sealCoreManifest(directory, sessionId)).not.toBeNull();
    expect(sealWikiManifest(directory, sessionId)).not.toBeNull();

    await Promise.all([
      processSessionEndWorker({ directory, sessionId }),
      processSessionEndWorker({ directory, sessionId }),
    ]);

    const manifest = readSessionEndJob(directory, sessionId)!;
    expect(manifest.owner).toBeNull();
    expect(manifest.phase).toBe('complete');
    expect(manifest.actions['wiki-capture']).toMatchObject({ status: 'completed', attempts: 0 });
    for (const [name, action] of Object.entries(manifest.actions)) {
      if (name === 'wiki-capture') continue;
      expect(action).toMatchObject({ status: 'completed', attempts: 1, runner: { phase: 'terminal' } });
    }
    expect(actions.cleanupSessionOwnedTeams).toHaveBeenCalledTimes(1);
    expect(actions.cleanupSessionPython).toHaveBeenCalledTimes(1);
    expect(actions.cleanupSessionReplies).toHaveBeenCalledTimes(1);
    expect(actions.runSessionEndCallbacks).toHaveBeenCalledTimes(1);
    expect(actions.runSessionEndNotifications).toHaveBeenCalledTimes(1);
    expect(actions.runSessionEndOpenClaw).toHaveBeenCalledTimes(1);
  });

  it('does not take ownership when a process identity cannot be established', async () => {
    const directory = project();
    const sessionId = 'identity-unavailable';
    expect(prepareCoreManifest(directory, sessionId, {})).not.toBeNull();
    expect(sealCoreManifest(directory, sessionId)).not.toBeNull();
    processIdentity.getProcessStartIdentity.mockResolvedValueOnce(null as never);

    await processSessionEndWorker({ directory, sessionId });

    expect(readSessionEndJob(directory, sessionId)).toMatchObject({ owner: null, phase: 'ready' });
  });

  it('starts bounded durable-ticket recovery without relying on a caller-supplied directory slice', () => {
    const directory = project();
    for (let index = 0; index < 6; index++) {
      const sessionId = `recovery-${index}`;
      expect(prepareCoreManifest(directory, sessionId, {})).not.toBeNull();
      expect(sealCoreManifest(directory, sessionId)).not.toBeNull();
    }

    // The no-ID entry point must discover from the durable ticket index and return immediately.
    expect(() => reconcileSessionEndJobs(directory)).not.toThrow();
  });
});
