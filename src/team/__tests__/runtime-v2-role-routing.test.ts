import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const mocks = vi.hoisted(() => ({
  isWorkerAlive: vi.fn(async () => false),
  isWorkerPaneAlive: vi.fn(async () => false),
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
  };
});

describe('runtime-v2 role routing — processCliWorkerVerdicts (AC-7)', () => {
  let cwd: string;

  beforeEach(() => {
    vi.resetModules();
    mocks.isWorkerAlive.mockReset();
    mocks.isWorkerPaneAlive.mockReset();
    mocks.execFile.mockReset();
    mocks.tmuxExecAsync.mockReset();
    mocks.isWorkerAlive.mockResolvedValue(false);
    mocks.isWorkerPaneAlive.mockResolvedValue(false);
    mocks.execFile.mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(null, '', '');
      },
    );
    mocks.tmuxExecAsync.mockResolvedValue({ stdout: '', stderr: '' });
  });

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  async function bootstrap(opts: {
    verdict: 'approve' | 'revise' | 'reject';
    paneAlive?: boolean;
    workerCli?: 'codex' | 'gemini' | 'claude';
    omitVerdictFile?: boolean;
    invalidVerdictJson?: boolean;
  }): Promise<{ teamRoot: string; outputFile: string; taskPath: string }> {
    const teamName = 'role-routing-team';
    const teamRoot = join(cwd, '.omc', 'state', 'team', teamName);
    await mkdir(join(teamRoot, 'tasks'), { recursive: true });
    await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
    const outputFile = join(teamRoot, 'workers', 'worker-1', 'verdict.json');

    if (opts.paneAlive) mocks.isWorkerAlive.mockResolvedValue(true);

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
              worker_cli: opts.workerCli ?? 'codex',
              assigned_tasks: ['1'],
              pane_id: '%2',
              working_dir: cwd,
              output_file: outputFile,
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
          claim: { owner: 'worker-1', token: 'tk-1', leased_until: new Date(Date.now() + 60000).toISOString() },
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
            role: 'code-reviewer',
            task_id: '1',
            verdict: opts.verdict,
            summary: `${opts.verdict} summary`,
            findings: opts.verdict === 'approve'
              ? []
              : [{ severity: 'major', message: 'fix X' }],
          });
      await writeFile(outputFile, body, 'utf-8');
    }

    return { teamRoot, outputFile, taskPath };
  }

  it('approve verdict transitions task to completed and renames verdict file', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-routing-approve-'));
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
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-routing-revise-'));
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
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-routing-reject-'));
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
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-routing-alive-'));
    const { taskPath } = await bootstrap({ verdict: 'approve', paneAlive: true });

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const results = await processCliWorkerVerdicts('role-routing-team', cwd);

    expect(results).toHaveLength(0);
    const task = JSON.parse(await readFile(taskPath, 'utf-8'));
    expect(task.status).toBe('in_progress');
  });

  it('reports file_missing when verdict file does not exist', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-routing-missing-'));
    await bootstrap({ verdict: 'approve', omitVerdictFile: true });

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const results = await processCliWorkerVerdicts('role-routing-team', cwd);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('file_missing');
  });

  it('reports parse_failed and emits warning event for malformed verdict JSON', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-routing-parse-'));
    await bootstrap({ verdict: 'approve', invalidVerdictJson: true });

    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const results = await processCliWorkerVerdicts('role-routing-team', cwd);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('parse_failed');
    expect(results[0].reason).toBeDefined();
  });

  it('returns empty when no workers have output_file (claude-only teams)', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-routing-claude-'));
    const teamName = 'claude-only';
    const teamRoot = join(cwd, '.omc', 'state', 'team', teamName);
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
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-routing-noconfig-'));
    const { processCliWorkerVerdicts } = await import('../runtime-v2.js');
    const results = await processCliWorkerVerdicts('nonexistent-team', cwd);
    expect(results).toEqual([]);
  });
});
