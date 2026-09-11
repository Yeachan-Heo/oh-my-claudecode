import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, access, readdir } from 'fs/promises';
import * as fsPromises from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';

import { getOmcRoot } from '../../lib/worktree-paths.js';
import { TeamPaths, absPath } from '../state-paths.js';

const mocks = vi.hoisted(() => ({
  isWorkerAlive: vi.fn(async () => false),
  isWorkerPaneAlive: vi.fn(async () => false),
  getWorkerLiveness: vi.fn(async () => 'dead'),
  execFile: vi.fn(),
  tmuxExecAsync: vi.fn(),
  afterEventAppend: undefined as (() => Promise<void>) | undefined,
}));

const renameFault = vi.hoisted(() => ({
  destination: undefined as string | undefined,
  calls: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      renameFault.calls.push(String(args[1]));
      if (String(args[1]) === renameFault.destination) {
        throw new Error('injected_rename_failure');
      }
      return actual.rename(...args);
    },
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: mocks.execFile,
  };
});

vi.mock('../events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../events.js')>();
  return {
    ...actual,
    appendTeamEvent: async (...args: Parameters<typeof actual.appendTeamEvent>) => {
      const event = await actual.appendTeamEvent(...args);
      if (args[1].type === 'task_completed' && mocks.afterEventAppend) {
        const hook = mocks.afterEventAppend;
        mocks.afterEventAppend = undefined;
        await hook();
      }
      return event;
    },
  };
});

vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cli/tmux-utils.js')>();
  return {
    ...actual,
    tmuxExecAsync: mocks.tmuxExecAsync,
  };
});

vi.mock('../tmux-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tmux-session.js')>();
  return {
    ...actual,
    isWorkerAlive: mocks.isWorkerAlive,
    isWorkerPaneAlive: mocks.isWorkerPaneAlive,
    getWorkerLiveness: mocks.getWorkerLiveness,
  };
});

describe('runtime-v2 role routing — processCliWorkerVerdicts (AC-7)', () => {
  let cwd: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousOmcStateDir: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousOmcStateDir = process.env.OMC_STATE_DIR;
    vi.resetModules();
    renameFault.destination = undefined;
    renameFault.calls = [];
    mocks.afterEventAppend = undefined;
    mocks.isWorkerAlive.mockReset();
    mocks.isWorkerPaneAlive.mockReset();
    mocks.getWorkerLiveness.mockReset();
    mocks.execFile.mockReset();
    mocks.tmuxExecAsync.mockReset();
    mocks.isWorkerAlive.mockResolvedValue(false);
    mocks.isWorkerPaneAlive.mockResolvedValue(false);
    mocks.getWorkerLiveness.mockResolvedValue('dead');
    mocks.execFile.mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(null, '', '');
      },
    );
    mocks.tmuxExecAsync.mockResolvedValue({ stdout: '', stderr: '' });
  });

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousOmcStateDir === undefined) delete process.env.OMC_STATE_DIR;
    else process.env.OMC_STATE_DIR = previousOmcStateDir;
  });

  async function mkdtempFixture(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.OMC_STATE_DIR;
    return root;
  }

  async function bootstrap(opts: {
    verdict: 'approve' | 'revise' | 'reject';
    paneAlive?: boolean;
    workerCli?: 'codex' | 'gemini' | 'claude' | 'cursor';
    verdictRole?: string;
    omitVerdictFile?: boolean;
    invalidVerdictJson?: boolean;
    staleProcessingVerdict?: 'approve' | 'revise' | 'reject';
    expiredLease?: boolean;
    delegationRequired?: boolean;
  }): Promise<{ teamRoot: string; outputFile: string; taskPath: string }> {
    const teamName = 'role-routing-team';
    const teamRoot = join(getOmcRoot(cwd), 'state', 'team', teamName);
    await mkdir(join(teamRoot, 'tasks'), { recursive: true });
    await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
    const outputFile = join(teamRoot, 'workers', 'worker-1', 'verdict.json');
    const workerCli = opts.workerCli ?? 'codex';
    const launchAttemptId = 'attempt-worker-1';

    if (opts.paneAlive) {
      mocks.isWorkerAlive.mockResolvedValue(true);
      mocks.getWorkerLiveness.mockResolvedValue('alive');
    }

    await writeFile(
      join(teamRoot, 'config.json'),
      JSON.stringify(
        {
          name: teamName,
          task: 'demo',
          agent_type: 'codex',
          worker_launch_mode: 'interactive',
          worker_count: 1,
          max_workers: 20,
          workers: [
            {
              name: 'worker-1',
              index: 1,
              role: 'critic',
              worker_cli: workerCli,
              assigned_tasks: ['1'],
              pane_id: '%2',
              working_dir: cwd,
              output_file: outputFile,
              ...(workerCli === 'cursor' ? { launch_attempt_id: launchAttemptId } : {}),
            },
          ],
          created_at: new Date().toISOString(),
          tmux_session: 'rr-session:0',
          leader_pane_id: '%1',
          hud_pane_id: null,
          resize_hook_name: null,
          resize_hook_target: null,
          next_task_id: 2,
          team_state_root: teamRoot,
          workspace_mode: 'single',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const taskPath = join(teamRoot, 'tasks', 'task-1.json');
    await writeFile(
      taskPath,
      JSON.stringify(
        {
          id: '1',
          subject: 'Review PR',
          description: 'CLI worker review',
          status: 'in_progress',
          owner: 'worker-1',
          role: 'critic',
          version: 1,
          claim: {
            owner: 'worker-1',
            token: 'tk-1',
            leased_until: new Date(Date.now() + (opts.expiredLease ? -60000 : 60000)).toISOString(),
            ...(workerCli === 'cursor' ? { launch_attempt_id: launchAttemptId } : {}),
          },
          ...(opts.delegationRequired ? {
            delegation: { mode: 'required', skip_allowed_reason_required: true },
          } : {}),
          created_at: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf-8',
    );

    if (!opts.omitVerdictFile) {
      const body = opts.invalidVerdictJson
        ? '{not valid json'
        : JSON.stringify({
            role: opts.verdictRole ?? 'code-reviewer',
            task_id: '1',
            ...(workerCli === 'cursor' ? {
              claim_token: 'tk-1',
              task_version: 1,
              launch_attempt_id: launchAttemptId,
            } : {}),
            verdict: opts.verdict,
            summary: `${opts.verdict} summary`,
            findings: opts.verdict === 'approve'
              ? []
              : [{ severity: 'major', message: 'fix X' }],
          });
      await writeFile(outputFile, body, 'utf-8');
      if (opts.staleProcessingVerdict) {
        await writeFile(join(outputFile + '.processing'), JSON.stringify({
          role: opts.verdictRole ?? 'code-reviewer',
          task_id: '1',
          claim_token: 'tk-1',
          task_version: 1,
          launch_attempt_id: launchAttemptId,
          verdict: opts.staleProcessingVerdict,
          summary: `stale ${opts.staleProcessingVerdict} summary`,
          findings: [],
        }), 'utf-8');
      }
    }

    return { teamRoot, outputFile, taskPath };
  }

  async function waitForContendedTaskLockAttempt(teamRoot: string): Promise<void> {
    const taskRoot = join(teamRoot, 'tasks');
    for (let attempt = 0; attempt < 100; attempt++) {
      const lockTemps = (await readdir(taskRoot)).filter(name =>
        name.startsWith('.lock-1.') && name.endsWith('.tmp'));
      if (lockTemps.length >= 2) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('timed out waiting for verdict task lock attempt');
  }

  it('keeps a configured role provider authoritative instead of changing to its fallback', async () => {
    const { resolveTaskAssignment } = await import('../runtime-v2.js');
    const assignment = resolveTaskAssignment(
      { subject: 'Review PR', description: 'Inspect the implementation', role: 'executor' },
      {
        executor: {
          primary: { provider: 'gemini', model: 'gemini-2.5-pro', agent: 'executor' },
          fallback: { provider: 'claude', model: 'sonnet', agent: 'executor' },
        },
      } as any,
      { executor: { provider: 'gemini' } } as any,
      'claude',
    );

    expect(assignment).toMatchObject({
      agentType: 'gemini',
      model: 'gemini-2.5-pro',
      role: 'executor',
    });
  });

  it('approve verdict transitions task to completed and renames verdict file', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-approve-');
    const { outputFile, taskPath } = await bootstrap({ verdict: 'approve' });

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const results = await processCliWorkerVerdicts('role-routing-team', cwd);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('completed');
    expect(results[0].verdict).toBe('approve');

    const taskRaw = await readFile(taskPath, 'utf-8');
    const task = JSON.parse(taskRaw);
    expect(task.status).toBe('completed');
    expect(task.version).toBe(2);
    expect(task.metadata?.verdict).toBe('approve');
    expect(task.metadata?.verdict_source).toBe('cli_worker_output_contract');
    expect(task.metadata?.verdict_role).toBe('code-reviewer');
    expect(task.completed_at).toBeDefined();
    expect(task.claim).toBeUndefined();

    // Verdict file renamed to .processed
    await expect(access(outputFile + '.processed')).resolves.toBeUndefined();

    const snapshot = JSON.parse(await readFile(
      absPath(cwd, TeamPaths.monitorSnapshot('role-routing-team')),
      'utf-8',
    ));
    expect(snapshot.completedEventTaskIds['1']).toBe(true);
  });

  it('revise verdict transitions task to failed with verdict metadata', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-revise-');
    const { taskPath } = await bootstrap({ verdict: 'revise' });

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const results = await processCliWorkerVerdicts('role-routing-team', cwd);

    expect(results[0].status).toBe('failed');
    expect(results[0].verdict).toBe('revise');

    const task = JSON.parse(await readFile(taskPath, 'utf-8'));
    expect(task.status).toBe('failed');
    expect(task.metadata?.verdict).toBe('revise');
    expect(task.error).toContain('cli_worker_verdict:revise');
    expect(Array.isArray(task.metadata?.verdict_findings)).toBe(true);
    expect(task.metadata?.verdict_findings).toHaveLength(1);
  });

  it('keeps a non-Cursor verdict retryable when the canonical task lock is contended', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-lock-contention-');
    const { teamRoot, outputFile, taskPath } = await bootstrap({ verdict: 'approve' });
    const originalTask = await readFile(taskPath, 'utf-8');
    const { withProcessIdentityFileLock } = await import('../process-identity-lock.js');
    const lockPath = join(teamRoot, 'tasks', '.lock-1');
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
    const released = new Promise<void>(resolve => { releaseResolve = resolve; });
    const holder = withProcessIdentityFileLock(lockPath, async () => {
      enteredResolve();
      await released;
    });
    await entered;

    try {
      const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
      const processing = processCliWorkerVerdicts('role-routing-team', cwd);
      await waitForContendedTaskLockAttempt(teamRoot);
      const results = await processing;

      expect(results[0]).toMatchObject({
        status: 'skipped',
        reason: 'task_claim_lock_contention',
      });
      expect(await readFile(taskPath, 'utf-8')).toBe(originalTask);
      await expect(access(outputFile + '.processed')).rejects.toThrow();
      await expect(access(outputFile)).resolves.toBeUndefined();
    } finally {
      releaseResolve();
      await holder;
    }
  });

  it('does not clobber a same-owner task version changed while waiting for the canonical lock', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-version-race-');
    const { teamRoot, outputFile, taskPath } = await bootstrap({ verdict: 'approve' });
    const originalOutput = await readFile(outputFile, 'utf-8');
    const { withProcessIdentityFileLock } = await import('../process-identity-lock.js');
    const lockPath = join(teamRoot, 'tasks', '.lock-1');
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
    const released = new Promise<void>(resolve => { releaseResolve = resolve; });
    const holder = withProcessIdentityFileLock(lockPath, async () => {
      enteredResolve();
      await released;
    });
    await entered;

    try {
      const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
      const processing = processCliWorkerVerdicts('role-routing-team', cwd);
      await waitForContendedTaskLockAttempt(teamRoot);
      const changedTask = JSON.parse(await readFile(taskPath, 'utf-8'));
      changedTask.version = 2;
      changedTask.claim.token = 'tk-requeued';
      await writeFile(taskPath, JSON.stringify(changedTask, null, 2), 'utf-8');
      releaseResolve();
      await holder;

      const results = await processing;
      expect(results[0]).toMatchObject({
        status: 'skipped',
        reason: 'stale_task_version_conflict_quarantined',
      });
      const replacementBytes = await readFile(taskPath, 'utf-8');
      expect(JSON.parse(replacementBytes)).toMatchObject({
        status: 'in_progress',
        owner: 'worker-1',
        version: 2,
        claim: { token: 'tk-requeued' },
      });
      await expect(access(outputFile + '.processed')).rejects.toThrow();
      await expect(access(outputFile)).rejects.toThrow();

      // A second monitor cycle (including a consumer restart) cannot rebind
      // the old verdict to the replacement claim.
      vi.resetModules();
      const { processCliWorkerVerdicts: restartedProcess } = await import('../runtime-v2.js');
      const second = await restartedProcess('role-routing-team', cwd);
      expect(second[0]).toMatchObject({ status: 'file_missing' });
      expect(await readFile(taskPath, 'utf-8')).toBe(replacementBytes);

      const replacementOutput = `${outputFile}.replacement`;
      await writeFile(replacementOutput, originalOutput, 'utf-8');
      await fsPromises.rename(replacementOutput, outputFile);
      const third = await restartedProcess('role-routing-team', cwd);
      expect(third[0]).toMatchObject({ status: 'completed', verdict: 'approve' });
      expect(JSON.parse(await readFile(taskPath, 'utf-8'))).toMatchObject({
        status: 'completed',
        version: 3,
      });
    } finally {
      releaseResolve();
      await holder;
    }
  });

  it('does not clobber a canonical requeue that wins before verdict publication', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-requeue-race-');
    const { teamRoot, outputFile, taskPath } = await bootstrap({ verdict: 'approve' });
    const { withProcessIdentityFileLock } = await import('../process-identity-lock.js');
    const lockPath = join(teamRoot, 'tasks', '.lock-1');
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
    const released = new Promise<void>(resolve => { releaseResolve = resolve; });
    const holder = withProcessIdentityFileLock(lockPath, async () => {
      enteredResolve();
      await released;
    });
    await entered;

    try {
      const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
      const processing = processCliWorkerVerdicts('role-routing-team', cwd);
      await waitForContendedTaskLockAttempt(teamRoot);
      const changedTask = JSON.parse(await readFile(taskPath, 'utf-8'));
      delete changedTask.owner;
      delete changedTask.claim;
      changedTask.status = 'pending';
      changedTask.version = 2;
      await writeFile(taskPath, JSON.stringify(changedTask, null, 2), 'utf-8');
      releaseResolve();
      await holder;

      const results = await processing;
      expect(results[0]).toMatchObject({
        status: 'skipped',
        reason: 'stale_task_version_conflict_quarantined',
      });
      const replacementBytes = await readFile(taskPath, 'utf-8');
      expect(JSON.parse(replacementBytes)).toMatchObject({
        status: 'pending',
        version: 2,
      });
      await expect(access(outputFile + '.processed')).rejects.toThrow();
      await expect(access(outputFile)).rejects.toThrow();

      vi.resetModules();
      const { processCliWorkerVerdicts: restartedProcess } = await import('../runtime-v2.js');
      const second = await restartedProcess('role-routing-team', cwd);
      expect(second[0]).toMatchObject({ status: 'file_missing' });
      expect(await readFile(taskPath, 'utf-8')).toBe(replacementBytes);
    } finally {
      releaseResolve();
      await holder;
    }
  });

  it('fails closed when stale-artifact quarantine rename fails, then accepts a new artifact identity', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-quarantine-failure-');
    const { teamRoot, outputFile, taskPath } = await bootstrap({ verdict: 'approve' });
    const originalOutput = await readFile(outputFile, 'utf-8');
    const outputStat = await fsPromises.lstat(outputFile);
    const artifactSha256 = createHash('sha256').update(originalOutput, 'utf8').digest('hex');
    const artifactFingerprint = [
      artifactSha256,
      String(outputStat.dev),
      String(outputStat.ino),
      String(outputStat.size),
      String(outputStat.mtimeMs),
    ].join('-');
    const { withProcessIdentityFileLock } = await import('../process-identity-lock.js');
    const lockPath = join(teamRoot, 'tasks', '.lock-1');
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
    const released = new Promise<void>(resolve => { releaseResolve = resolve; });
    const holder = withProcessIdentityFileLock(lockPath, async () => {
      enteredResolve();
      await released;
    });
    await entered;
    renameFault.destination = `${outputFile}.stale.${artifactFingerprint}`;

    try {
      const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
      const processing = processCliWorkerVerdicts('role-routing-team', cwd);
      await waitForContendedTaskLockAttempt(teamRoot);
      const changedTask = JSON.parse(await readFile(taskPath, 'utf-8'));
      changedTask.version = 2;
      changedTask.claim.token = 'tk-requeued';
      await writeFile(taskPath, JSON.stringify(changedTask, null, 2), 'utf-8');
      releaseResolve();
      await holder;

      const first = await processing;
      expect(first[0]).toMatchObject({
        status: 'skipped',
        reason: 'stale_task_version_conflict_quarantined',
      });
      expect(await readFile(taskPath, 'utf-8')).toEqual(JSON.stringify(changedTask, null, 2));
      await expect(access(outputFile)).resolves.toBeUndefined();
      await expect(access(`${outputFile}.stale.${artifactFingerprint}.marker`)).resolves.toBeUndefined();

      vi.resetModules();
      const { processCliWorkerVerdicts: restartedProcess } = await import('../runtime-v2.js');
      const second = await restartedProcess('role-routing-team', cwd);
      expect(second[0]).toMatchObject({
        status: 'skipped',
        reason: 'stale_verdict_quarantined',
      });
      expect(await readFile(taskPath, 'utf-8')).toEqual(JSON.stringify(changedTask, null, 2));

      // Metadata-only changes (ctime/mode) do not make the retained verdict
      // a new publication identity.
      await fsPromises.chmod(outputFile, 0o600);
      vi.resetModules();
      const attributeRetry = await import('../runtime-v2.js');
      const thirdAfterAttributeChange = await attributeRetry.processCliWorkerVerdicts('role-routing-team', cwd);
      expect(thirdAfterAttributeChange[0]).toMatchObject({
        status: 'skipped',
        reason: 'stale_verdict_quarantined',
      });

      renameFault.destination = undefined;
      const replacementPath = `${outputFile}.replacement`;
      await writeFile(replacementPath, originalOutput, 'utf-8');
      await fsPromises.rename(replacementPath, outputFile);
      const third = await attributeRetry.processCliWorkerVerdicts('role-routing-team', cwd);
      expect(third[0]).toMatchObject({ status: 'completed', verdict: 'approve' });
      expect(JSON.parse(await readFile(taskPath, 'utf-8'))).toMatchObject({
        status: 'completed',
        version: 3,
        metadata: { verdict_summary: 'approve summary' },
      });
    } finally {
      renameFault.destination = undefined;
      releaseResolve();
      await holder;
    }
  });

  it('leaves canonical bytes and the verdict artifact retryable when atomic publication fails', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-publish-failure-');
    const { outputFile, taskPath } = await bootstrap({ verdict: 'approve' });
    const originalTask = await readFile(taskPath, 'utf-8');
    renameFault.destination = taskPath;

    try {
      const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
      const results = await processCliWorkerVerdicts('role-routing-team', cwd);

      expect(renameFault.calls).toContain(taskPath);
      expect(results[0]).toMatchObject({
        status: 'skipped',
        reason: 'task_publish_failed',
      });
      expect(await readFile(taskPath, 'utf-8')).toBe(originalTask);
      await expect(access(outputFile + '.processed')).rejects.toThrow();
      await expect(access(outputFile)).resolves.toBeUndefined();
      await expect(access(outputFile + '.binding')).resolves.toBeUndefined();

      renameFault.destination = undefined;
      vi.resetModules();
      const { processCliWorkerVerdicts: retryProcess } = await import('../runtime-v2.js');
      const retry = await retryProcess('role-routing-team', cwd);
      expect(retry[0]).toMatchObject({ status: 'completed', verdict: 'approve' });
      expect(JSON.parse(await readFile(taskPath, 'utf-8'))).toMatchObject({
        status: 'completed',
        version: 2,
      });
    } finally {
      renameFault.destination = undefined;
    }
  });

  it('refuses a malformed selected task without consuming its verdict', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-malformed-task-');
    const { outputFile, taskPath } = await bootstrap({ verdict: 'approve' });
    const malformed = '{malformed canonical task';
    await writeFile(taskPath, malformed, 'utf-8');

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const results = await processCliWorkerVerdicts('role-routing-team', cwd);

    expect(results[0]).toMatchObject({
      status: 'no_in_progress_task',
      taskId: '1',
    });
    expect(await readFile(taskPath, 'utf-8')).toBe(malformed);
    await expect(access(outputFile + '.processed')).rejects.toThrow();
    await expect(access(outputFile)).resolves.toBeUndefined();
  });

  it('fails closed on a malformed existing verdict binding instead of rebinding', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-malformed-binding-');
    const { outputFile, taskPath } = await bootstrap({ verdict: 'approve' });
    const originalTask = await readFile(taskPath, 'utf-8');
    await writeFile(outputFile + '.binding', '{not valid binding', 'utf-8');

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const first = await processCliWorkerVerdicts('role-routing-team', cwd);

    expect(first[0]).toMatchObject({
      status: 'skipped',
      reason: 'stale_verdict_quarantined',
    });
    expect(await readFile(taskPath, 'utf-8')).toBe(originalTask);
    await expect(access(outputFile)).rejects.toThrow();
    await expect(access(outputFile + '.processed')).rejects.toThrow();
  });

  it('keeps the original binding across restart and same-worker release/reclaim', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-reclaim-restart-');
    const { outputFile, taskPath } = await bootstrap({ verdict: 'approve' });
    renameFault.destination = taskPath;

    try {
      const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
      const first = await processCliWorkerVerdicts('role-routing-team', cwd);
      expect(first[0]).toMatchObject({ status: 'skipped', reason: 'task_publish_failed' });
      await expect(access(outputFile + '.binding')).resolves.toBeUndefined();
    } finally {
      renameFault.destination = undefined;
    }

    const teamOps = await import('../team-ops.js');
    const released = await teamOps.teamReleaseTaskClaim(
      'role-routing-team',
      '1',
      'tk-1',
      'worker-1',
      cwd,
    );
    expect(released).toMatchObject({ ok: true, task: { status: 'pending', version: 2 } });
    const reclaimed = await teamOps.teamClaimTask('role-routing-team', '1', 'worker-1', 2, cwd);
    expect(reclaimed).toMatchObject({ ok: true, task: { status: 'in_progress', version: 3 } });
    const replacementBytes = await readFile(taskPath, 'utf-8');

    vi.resetModules();
    const { processCliWorkerVerdicts: restartedProcess } = await import('../runtime-v2.js');
    const second = await restartedProcess('role-routing-team', cwd);
    expect(second[0]).toMatchObject({
      status: 'skipped',
      reason: 'stale_task_version_conflict_quarantined',
    });
    expect(await readFile(taskPath, 'utf-8')).toBe(replacementBytes);
    await expect(access(outputFile)).rejects.toThrow();

    vi.resetModules();
    const { processCliWorkerVerdicts: secondRestart } = await import('../runtime-v2.js');
    expect(await secondRestart('role-routing-team', cwd)).toEqual([
      expect.objectContaining({ status: 'file_missing' }),
    ]);
    expect(await readFile(taskPath, 'utf-8')).toBe(replacementBytes);
  });

  it('retains the binding after processed rename failure across task reopen and restart', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-processed-failure-');
    const { outputFile, taskPath } = await bootstrap({ verdict: 'approve' });
    renameFault.destination = `${outputFile}.processed`;
    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const first = await processCliWorkerVerdicts('role-routing-team', cwd);
    expect(first[0]).toMatchObject({ status: 'completed' });
    expect(renameFault.calls).toContain(`${outputFile}.processed`);
    await expect(access(outputFile)).resolves.toBeUndefined();
    const bindingBytes = await readFile(`${outputFile}.binding`, 'utf8');
    expect(JSON.parse(bindingBytes)).toMatchObject({ task_id: '1', task_version: 1 });
    renameFault.destination = undefined;

    const teamOps = await import('../team-ops.js');
    await teamOps.teamUpdateTask('role-routing-team', '1', {
      status: 'pending', owner: undefined, claim: undefined,
    }, cwd);
    const reclaimed = await teamOps.teamClaimTask('role-routing-team', '1', 'worker-1', 3, cwd);
    expect(reclaimed).toMatchObject({ ok: true, task: { status: 'in_progress', version: 4 } });
    const replacementBytes = await readFile(taskPath, 'utf8');

    vi.resetModules();
    const restarted = await import('../runtime-v2.js');
    const second = await restarted.processCliWorkerVerdicts('role-routing-team', cwd);
    expect(second[0]).toMatchObject({
      status: 'skipped', reason: 'stale_task_version_conflict_quarantined',
    });
    expect(await readFile(taskPath, 'utf8')).toBe(replacementBytes);
    await expect(access(outputFile)).rejects.toThrow();
  });

  it('preserves a fresh artifact and binding arriving before post-publication cleanup', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-fresh-cleanup-');
    const { outputFile, taskPath } = await bootstrap({ verdict: 'approve' });
    const teamOps = await import('../team-ops.js');
    const { withProcessIdentityFileLock } = await import('../process-identity-lock.js');
    let freshOutput = '';
    let freshBinding = '';
    let replacementBytes = '';
    mocks.afterEventAppend = async () => {
      await teamOps.teamUpdateTask('role-routing-team', '1', {
        status: 'pending', owner: undefined, claim: undefined,
      }, cwd);
      const reclaimed = await teamOps.teamClaimTask('role-routing-team', '1', 'worker-1', 3, cwd);
      expect(reclaimed).toMatchObject({ ok: true, task: { status: 'in_progress', version: 4 } });
      replacementBytes = await readFile(taskPath, 'utf8');
      await withProcessIdentityFileLock(`${outputFile}.lock`, async () => {
        const originalBinding = JSON.parse(await readFile(`${outputFile}.binding`, 'utf8'));
        freshOutput = JSON.stringify({
          ...JSON.parse(await readFile(outputFile, 'utf8')),
          summary: 'fresh replacement verdict',
        });
        await writeFile(`${outputFile}.replacement`, freshOutput, 'utf8');
        await fsPromises.rename(`${outputFile}.replacement`, outputFile);
        const stats = await fsPromises.lstat(outputFile);
        freshBinding = JSON.stringify({
          ...originalBinding,
          task_version: 4,
          artifact_fingerprint: [
            createHash('sha256').update(freshOutput, 'utf8').digest('hex'),
            stats.dev, stats.ino, stats.size, stats.mtimeMs,
          ].join('-'),
        });
        await teamOps.writeAtomic(`${outputFile}.binding`, freshBinding);
      }, 100);
    };

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    expect((await processCliWorkerVerdicts('role-routing-team', cwd))[0])
      .toMatchObject({ status: 'completed' });
    expect(mocks.afterEventAppend).toBeUndefined();
    expect(await readFile(outputFile, 'utf8')).toBe(freshOutput);
    expect(await readFile(`${outputFile}.binding`, 'utf8')).toBe(freshBinding);
    expect(await readFile(taskPath, 'utf8')).toBe(replacementBytes);
    await expect(access(`${outputFile}.processed`)).rejects.toThrow();

    vi.resetModules();
    const restarted = await import('../runtime-v2.js');
    expect((await restarted.processCliWorkerVerdicts('role-routing-team', cwd))[0])
      .toMatchObject({ status: 'completed' });
    expect(JSON.parse(await readFile(taskPath, 'utf8'))).toMatchObject({
      status: 'completed', version: 5,
      metadata: { verdict_summary: 'fresh replacement verdict' },
    });
  });

  it('reject verdict transitions task to failed', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-reject-');
    const { taskPath } = await bootstrap({ verdict: 'reject' });

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const results = await processCliWorkerVerdicts('role-routing-team', cwd);

    expect(results[0].status).toBe('failed');
    expect(results[0].verdict).toBe('reject');

    const task = JSON.parse(await readFile(taskPath, 'utf-8'));
    expect(task.status).toBe('failed');
    expect(task.error).toContain('reject');
  });

  it('skips workers whose pane is still alive', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-alive-');
    const { taskPath } = await bootstrap({ verdict: 'approve', paneAlive: true });

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const results = await processCliWorkerVerdicts('role-routing-team', cwd);

    expect(results).toHaveLength(0);
    const task = JSON.parse(await readFile(taskPath, 'utf-8'));
    expect(task.status).toBe('in_progress');
  });

  it('consumes a live Cursor reviewer verdict, persists metadata, and is idempotent', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-routing-cursor-alive-'));
    const { outputFile, taskPath } = await bootstrap({
      verdict: 'approve',
      paneAlive: true,
      workerCli: 'cursor',
      verdictRole: 'critic',
    });

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const eventPath = absPath(cwd, TeamPaths.events('role-routing-team'));
    let eventsBefore = 0;
    try { eventsBefore = (await readFile(eventPath, 'utf8')).trim().split('\n').filter(Boolean).length; } catch { /* first event */ }
    const first = await processCliWorkerVerdicts('role-routing-team', cwd);

    expect(first).toEqual([expect.objectContaining({
      workerName: 'worker-1',
      taskId: '1',
      status: 'completed',
      verdict: 'approve',
    })]);
    const task = JSON.parse(await readFile(taskPath, 'utf-8'));
    expect(task.status).toBe('completed');
    expect(task.version).toBe(2);
    expect(task.metadata).toMatchObject({
      verdict: 'approve',
      verdict_source: 'cli_worker_output_contract',
      verdict_role: 'critic',
    });
    await expect(access(outputFile + '.processed')).resolves.toBeUndefined();

    const events = (await readFile(eventPath, 'utf8'))
      .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(events.slice(eventsBefore).filter(event => event.type === 'task_completed' && event.task_id === '1')).toHaveLength(1);
    const snapshot = JSON.parse(await readFile(absPath(cwd, TeamPaths.monitorSnapshot('role-routing-team')), 'utf8'));
    expect(snapshot.completedEventTaskIds['1']).toBe(true);

    const second = await processCliWorkerVerdicts('role-routing-team', cwd);
    expect(second).toEqual([]);
    expect(JSON.parse(await readFile(taskPath, 'utf-8'))).toMatchObject({
      status: 'completed',
      metadata: task.metadata,
    });
  });

  it('does not consume a live Cursor verdict with an untrusted role payload', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-routing-cursor-role-mismatch-'));
    const { outputFile, taskPath } = await bootstrap({
      verdict: 'approve',
      paneAlive: true,
      workerCli: 'cursor',
    });

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const results = await processCliWorkerVerdicts('role-routing-team', cwd);

    expect(results[0]).toMatchObject({ status: 'skipped', reason: 'cursor_verdict_role_mismatch' });
    expect(JSON.parse(await readFile(taskPath, 'utf-8')).status).toBe('in_progress');
    await expect(access(outputFile + '.processed')).resolves.toBeUndefined();
  });

  it('does not let stale processing output mask the replacement verdict', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-routing-cursor-stale-processing-'));
    const { taskPath } = await bootstrap({
      verdict: 'revise', paneAlive: true, workerCli: 'cursor', verdictRole: 'critic',
      staleProcessingVerdict: 'approve',
    });

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const results = await processCliWorkerVerdicts('role-routing-team', cwd);

    expect(results[0]).toMatchObject({ status: 'failed', verdict: 'revise' });
    expect(JSON.parse(await readFile(taskPath, 'utf-8')).metadata?.verdict).toBe('revise');
  });

  it('routes Cursor completion through lease and delegation invariants', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-routing-cursor-invariants-'));
    const { taskPath } = await bootstrap({
      verdict: 'approve', paneAlive: true, workerCli: 'cursor', verdictRole: 'critic',
      expiredLease: true, delegationRequired: true,
    });

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const results = await processCliWorkerVerdicts('role-routing-team', cwd);

    expect(results[0]).toMatchObject({ status: 'already_terminal' });
    expect(JSON.parse(await readFile(taskPath, 'utf-8')).status).toBe('in_progress');
  });

  it('waits for explicit alive liveness before consuming a Cursor verdict', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-routing-cursor-unknown-'));
    await bootstrap({ verdict: 'approve', paneAlive: true, workerCli: 'cursor', verdictRole: 'critic' });
    mocks.getWorkerLiveness.mockResolvedValue('unknown');

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    expect(await processCliWorkerVerdicts('role-routing-team', cwd)).toEqual([]);
  });

  it('reports file_missing when verdict file does not exist', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-missing-');
    await bootstrap({ verdict: 'approve', omitVerdictFile: true });

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const results = await processCliWorkerVerdicts('role-routing-team', cwd);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('file_missing');
  });

  it('reports parse_failed and emits warning event for malformed verdict JSON', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-parse-');
    await bootstrap({ verdict: 'approve', invalidVerdictJson: true });

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const results = await processCliWorkerVerdicts('role-routing-team', cwd);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('parse_failed');
    expect(results[0].reason).toBeDefined();
  });

  it('returns empty when no workers have output_file (claude-only teams)', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-claude-');
    const teamName = 'claude-only';
    const teamRoot = join(getOmcRoot(cwd), 'state', 'team', teamName);
    await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
    await mkdir(join(teamRoot, 'tasks'), { recursive: true });
    await writeFile(
      join(teamRoot, 'config.json'),
      JSON.stringify(
        {
          name: teamName,
          task: 'demo',
          agent_type: 'claude',
          worker_launch_mode: 'interactive',
          worker_count: 1,
          max_workers: 20,
          workers: [{
            name: 'worker-1',
            index: 1,
            role: 'executor',
            worker_cli: 'claude',
            assigned_tasks: [],
            pane_id: '%2',
            working_dir: cwd,
          }],
          created_at: new Date().toISOString(),
          tmux_session: 'co-session:0',
          leader_pane_id: '%1',
          hud_pane_id: null,
          resize_hook_name: null,
          resize_hook_target: null,
          next_task_id: 1,
          team_state_root: teamRoot,
          workspace_mode: 'single',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const results = await processCliWorkerVerdicts(teamName, cwd);
    expect(results).toEqual([]);
  });

  it('returns empty when team config is missing', async () => {
    cwd = await mkdtempFixture('omc-runtime-routing-noconfig-');
    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const results = await processCliWorkerVerdicts('nonexistent-team', cwd);
    expect(results).toEqual([]);
  });
});
