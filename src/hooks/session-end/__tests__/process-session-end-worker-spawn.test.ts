/**
 * B9 spawn-next self-heal, hook-side half: once the manifest exists it already
 * carries the enqueued chain, so processSessionEnd must always launch the
 * worker — even when inline foreground cleanup or core sealing fails. Without
 * the spawn the enqueued chain has no executor at all (producer absent, no
 * self-heal) and stalls until an unrelated SessionStart reconcile.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workerModule = vi.hoisted(() => ({
  spawnSessionEndWorker: vi.fn((_payload: { directory: string; sessionId: string }) => true),
}));

vi.mock('../worker.js', () => workerModule);

vi.mock('../../../lib/worktree-paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/worktree-paths.js')>(
    '../../../lib/worktree-paths.js',
  );
  return {
    ...actual,
    resolveToWorktreeRoot: vi.fn((dir?: string) => dir ?? process.cwd()),
    // Temp dirs are not git repos, but on some Windows hosts the git probe
    // itself fails (probe_failed) instead of classifying not_a_repository,
    // which fails closed inside mode-state-io. Force the non-git branch.
    probeGitTopLevel: vi.fn(() => ({ status: 'not_a_repository' as const })),
  };
});

import { mutateSessionEndJob, prepareCoreManifest, readSessionEndJob } from '../cleanup-manifest.js';
import { processSessionEnd } from '../index.js';

describe('processSessionEnd always launches the worker for an enqueued chain', () => {
  let directory: string;
  let transcriptPath: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'omc-session-end-selfheal-'));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = directory;
    process.env.USERPROFILE = directory;
    transcriptPath = join(directory, 'transcript.jsonl');
    writeFileSync(transcriptPath, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }), 'utf-8');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    vi.clearAllMocks();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  });

  it('spawns the worker on the happy path (cleanup completes, core sealed)', async () => {
    await expect(processSessionEnd({
      session_id: 'selfheal-happy',
      transcript_path: transcriptPath,
      cwd: directory,
      permission_mode: 'default',
      hook_event_name: 'SessionEnd',
      reason: 'prompt_input_exit',
    })).resolves.toEqual({ continue: true });

    expect(workerModule.spawnSessionEndWorker).toHaveBeenCalledTimes(1);
    // cwd is normalized through resolveToWorktreeRoot, which may return the
    // realpath (8.3 short names differ on Windows temp dirs).
    const call = vi.mocked(workerModule.spawnSessionEndWorker).mock.calls[0][0];
    expect(call.sessionId).toBe('selfheal-happy');
    expect(call.directory).toContain('omc-session-end-selfheal-');
  });

  it('still spawns the worker when core sealing conflicts instead of starving the enqueued chain', async () => {
    // Pre-state that makes completeForegroundCleanupAndSealCore throw
    // (foreground-cleanup already exhausted): previously the hook aborted with
    // no worker launch at all.
    expect(prepareCoreManifest(directory, 'selfheal-seal-conflict', {})).not.toBeNull();
    const initial = readSessionEndJob(directory, 'selfheal-seal-conflict')!;
    expect(mutateSessionEndJob(directory, 'selfheal-seal-conflict', initial.revision, (job) => {
      const foreground = job.actions['foreground-cleanup'];
      foreground.status = 'expired';
      foreground.lastOutcomeCode = 'required-attempt-limit';
    })).not.toBeNull();

    await expect(processSessionEnd({
      session_id: 'selfheal-seal-conflict',
      transcript_path: transcriptPath,
      cwd: directory,
      permission_mode: 'default',
      hook_event_name: 'SessionEnd',
      reason: 'prompt_input_exit',
    })).resolves.toEqual({ continue: true });

    expect(workerModule.spawnSessionEndWorker).toHaveBeenCalledTimes(1);
    const call = vi.mocked(workerModule.spawnSessionEndWorker).mock.calls[0][0];
    expect(call.sessionId).toBe('selfheal-seal-conflict');
    expect(call.directory).toContain('omc-session-end-selfheal-');
  });
});
