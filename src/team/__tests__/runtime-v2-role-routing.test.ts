import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'fs/promises';
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
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: mocks.execFile,
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
    expect(task.metadata?.verdict).toBe('approve');
    expect(task.metadata?.verdict_source).toBe('cli_worker_output_contract');
    expect(task.metadata?.verdict_role).toBe('code-reviewer');
    expect(task.completed_at).toBeDefined();
    expect(task.claim).toBeUndefined();

    // Verdict file renamed to .processed
    await expect(access(outputFile + '.processed')).resolves.toBeUndefined();
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
