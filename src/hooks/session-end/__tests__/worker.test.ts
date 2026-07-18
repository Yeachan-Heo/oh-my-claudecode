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
const actionRunner = vi.hoisted(() => ({
  runSessionEndAction: vi.fn(async (_context: unknown, execute: () => Promise<void>) => {
    await execute();
    return { code: 'completed', completed: true };
  }),
}));

vi.mock('../index.js', () => actions);
vi.mock('../../../platform/process-utils.js', () => processIdentity);
vi.mock('../action-runner.js', () => actionRunner);

import { isManifestTerminal, mutateSessionEndJob, prepareCoreManifest, readSessionEndJob, sealCoreManifest, sealWikiManifest, takeSessionEndDiscoveryPage } from '../cleanup-manifest.js';
import { processSessionEndWorker, reconcileSessionEndJobs, workerEnvironment } from '../worker.js';

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
  vi.useRealTimers();
  vi.unstubAllEnvs();
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
  it('reschedules a core-only manifest through producer grace after slow required actions and runs deferred callbacks once', async () => {
    vi.useFakeTimers();
    actionRunner.runSessionEndAction
      .mockImplementationOnce(async (_context: unknown, execute: () => Promise<void>) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 9_000));
        await execute();
        return { code: 'completed', completed: true };
      })
      .mockImplementationOnce(async (_context: unknown, execute: () => Promise<void>) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        await execute();
        return { code: 'completed', completed: true };
      });
    const directory = project();
    const sessionId = 'core-only-producer-recovery';
    expect(prepareCoreManifest(directory, sessionId, {})).not.toBeNull();
    const initial = readSessionEndJob(directory, sessionId)!;
    expect(mutateSessionEndJob(directory, sessionId, initial.revision, (job) => {
      job.producerGraceExpiresAt = new Date(Date.now() + 1_000).toISOString();
    })).not.toBeNull();

    await processSessionEndWorker({ directory, sessionId });
    expect(readSessionEndJob(directory, sessionId)).toMatchObject({
      producers: { core: { state: 'prepared' }, wiki: { state: 'absent' } },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();

    const manifest = readSessionEndJob(directory, sessionId)!;
    expect(manifest).toMatchObject({ phase: 'complete', owner: null });
    expect(manifest.producers).toMatchObject({
      core: { state: 'sealed', sealedBy: 'recovery' },
      wiki: { state: 'no-op', sealedBy: 'recovery' },
    });
    expect(Date.parse(manifest.bestEffortDeadlineAt)).toBeGreaterThan(Date.parse(manifest.producerGraceExpiresAt));
    expect(actions.runSessionEndCallbacks).toHaveBeenCalledTimes(1);
    expect(actions.runSessionEndNotifications).toHaveBeenCalledTimes(1);
  });

  it('reschedules prepared core through grace when wiki already sealed', async () => {
    vi.useFakeTimers();
    actionRunner.runSessionEndAction.mockResolvedValue({ code: 'completed', completed: true });
    const directory = project();
    const sessionId = 'prepared-core-sealed-wiki';
    expect(prepareCoreManifest(directory, sessionId, {})).not.toBeNull();
    expect(sealWikiManifest(directory, sessionId, { captured: true })).not.toBeNull();
    const initial = readSessionEndJob(directory, sessionId)!;
    expect(mutateSessionEndJob(directory, sessionId, initial.revision, (job) => {
      job.producerGraceExpiresAt = new Date(Date.now() + 1_000).toISOString();
    })).not.toBeNull();

    await processSessionEndWorker({ directory, sessionId });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(readSessionEndJob(directory, sessionId)).toMatchObject({
      producers: { core: { state: 'prepared' }, wiki: { state: 'sealed' } },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();

    expect(readSessionEndJob(directory, sessionId)).toMatchObject({
      phase: 'complete',
      producers: { core: { state: 'sealed', sealedBy: 'recovery' }, wiki: { state: 'sealed' } },
    });
  });

  it('fails closed after grace when a wiki-first manifest never receives core, without a 250ms recovery loop', async () => {
    vi.useFakeTimers();
    const directory = project();
    const sessionId = 'wiki-first-core-missing';
    expect(sealWikiManifest(directory, sessionId, { capture: 'sealed-wiki-payload' })).not.toBeNull();
    const initial = readSessionEndJob(directory, sessionId)!;
    expect(mutateSessionEndJob(directory, sessionId, initial.revision, (job) => {
      job.producerGraceExpiresAt = new Date(Date.now() + 1_000).toISOString();
    })).not.toBeNull();

    await processSessionEndWorker({ directory, sessionId });
    await vi.advanceTimersByTimeAsync(999);
    expect(readSessionEndJob(directory, sessionId)).toMatchObject({
      phase: 'recoverable-failure',
      producers: { core: { state: 'absent' }, wiki: { state: 'sealed' } },
    });

    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();

    const manifest = readSessionEndJob(directory, sessionId)!;
    expect(manifest).toMatchObject({
      phase: 'complete',
      owner: null,
      producers: { core: { state: 'no-op', sealedBy: 'recovery' }, wiki: { state: 'sealed' } },
      actions: {
        'foreground-cleanup': { status: 'expired', lastOutcomeCode: 'required-core-producer-absent' },
        'team-cleanup': { status: 'expired', lastOutcomeCode: 'required-core-producer-absent' },
        callback: { status: 'expired', lastOutcomeCode: 'best-effort-core-producer-absent' },
        notification: { status: 'expired', lastOutcomeCode: 'best-effort-core-producer-absent' },
      },
    });
    expect(manifest.actions['wiki-capture']).toMatchObject({ status: 'completed', attempts: 1 });
    expect(isManifestTerminal(manifest)).toBe(true);
    expect(takeSessionEndDiscoveryPage(directory, 1)).toEqual([]);
  });

  it('persists only bounded original OpenClaw routing and clears it from worker ambient environments', () => {
    const directory = project();
    vi.stubEnv('OMC_OPENCLAW_CONFIG', '/tmp/original-session.json');
    vi.stubEnv('OPENCLAW_REPLY_CHANNEL', '#original-session');
    vi.stubEnv('OPENCLAW_REPLY_TARGET', '@original-session');
    vi.stubEnv('OPENCLAW_REPLY_THREAD', 'original-thread');
    vi.stubEnv('OPENCLAW_REPLY_TOKEN', 'original-secret');
    vi.stubEnv('TMUX', '/tmp/tmux-original');
    vi.stubEnv('TMUX_PANE', '%42');
    vi.stubEnv('UNRELATED_SESSION_END_SECRET', 'not-forwarded');
    expect(prepareCoreManifest(directory, 'routing-snapshot', {})).not.toBeNull();

    const routing = readSessionEndJob(directory, 'routing-snapshot')!.actions.openclaw.payload.openClawRouting;
    expect(routing).toEqual({
      openClawConfig: '/tmp/original-session.json',
      replyChannel: '#original-session',
      replyTarget: '@original-session',
      replyThread: 'original-thread',
      tmux: '/tmp/tmux-original',
      tmuxPane: '%42',
    });
    expect(JSON.stringify(routing)).not.toContain('original-secret');
    expect(workerEnvironment()).not.toHaveProperty('OMC_OPENCLAW_CONFIG');
    expect(workerEnvironment()).not.toHaveProperty('OPENCLAW_REPLY_THREAD');
    expect(workerEnvironment()).not.toHaveProperty('TMUX');
    expect(workerEnvironment()).not.toHaveProperty('TMUX_PANE');
    expect(workerEnvironment()).not.toHaveProperty('UNRELATED_SESSION_END_SECRET');
  });

  it('terminalizes a core-only manifest after three failed foreground cleanups without timer churn', async () => {
    vi.useFakeTimers();
    actionRunner.runSessionEndAction.mockResolvedValue({ code: 'foreground-cleanup-failed', completed: false });
    const directory = project();
    const sessionId = 'core-only-foreground-exhausted';
    expect(prepareCoreManifest(directory, sessionId, {})).not.toBeNull();
    const initial = readSessionEndJob(directory, sessionId)!;
    expect(mutateSessionEndJob(directory, sessionId, initial.revision, (job) => {
      job.producerGraceExpiresAt = new Date(Date.now() + 1_000).toISOString();
    })).not.toBeNull();

    await processSessionEndWorker({ directory, sessionId });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1_000);

    const manifest = readSessionEndJob(directory, sessionId)!;
    expect(actionRunner.runSessionEndAction).toHaveBeenCalledTimes(3);
    expect(manifest).toMatchObject({
      phase: 'complete',
      owner: null,
      producers: { core: { state: 'no-op', sealedBy: 'recovery' }, wiki: { state: 'no-op', sealedBy: 'recovery' } },
      actions: {
        'foreground-cleanup': { status: 'expired', attempts: 3, lastOutcomeCode: 'required-foreground-cleanup-exhausted' },
        'team-cleanup': { status: 'expired', lastOutcomeCode: 'required-core-producer-unavailable' },
        callback: { status: 'expired', lastOutcomeCode: 'best-effort-core-producer-unavailable' },
      },
    });
    expect(manifest.actions['team-cleanup'].payload.terminalization).toMatchObject({
      reason: 'foreground-cleanup-exhausted',
      attempts: 3,
      outcomeCode: 'foreground-cleanup-failed',
    });
    expect(Object.values(manifest.actions).every(action => action.status === 'expired')).toBe(true);
    expect(isManifestTerminal(manifest)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(actionRunner.runSessionEndAction).toHaveBeenCalledTimes(3);
  });

});
