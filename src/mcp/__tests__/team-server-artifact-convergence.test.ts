import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createWorkerWorktree } from '../../team/git-worktree.js';

const tmuxMocks = vi.hoisted(() => ({
  killWorkerPanes: vi.fn(async () => undefined),
  killTeamSession: vi.fn(async () => undefined),
  isWorkerAlive: vi.fn(async () => false),
  getWorkerLiveness: vi.fn(async () => 'dead'),
}));

vi.mock('../../team/tmux-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../team/tmux-session.js')>();
  return {
    ...actual,
    killWorkerPanes: tmuxMocks.killWorkerPanes,
    killTeamSession: tmuxMocks.killTeamSession,
    isWorkerAlive: tmuxMocks.isWorkerAlive,
    getWorkerLiveness: tmuxMocks.getWorkerLiveness,
  };
});

const originalEnv = { ...process.env };

function parseResponseText(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

async function importTeamServerWithJobsDir(jobsDir: string) {
  process.env.OMC_TEAM_SERVER_DISABLE_AUTOSTART = '1';
  process.env.NODE_ENV = 'test';
  process.env.OMC_JOBS_DIR = jobsDir;
  vi.resetModules();
  return import('../team-server.js');
}

describe('team-server artifact convergence + scoped cleanup', () => {
  let testRoot: string;
  let jobsDir: string;

  beforeEach(() => {
    testRoot = join(tmpdir(), `omc-team-server-test-${process.pid}-${Date.now()}`);
    jobsDir = join(testRoot, 'jobs');
    mkdirSync(jobsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    process.env = { ...originalEnv };
    vi.clearAllMocks();
    tmuxMocks.killWorkerPanes.mockResolvedValue(undefined);
    tmuxMocks.killTeamSession.mockResolvedValue(undefined);
    tmuxMocks.isWorkerAlive.mockResolvedValue(false);
    tmuxMocks.getWorkerLiveness.mockResolvedValue('dead');
  });

  it('handleStatus converges to terminal artifact before pid liveness', async () => {
    const { handleStatus } = await importTeamServerWithJobsDir(jobsDir);

    const jobId = 'omc-art1';
    writeFileSync(
      join(jobsDir, `${jobId}.json`),
      JSON.stringify({
        status: 'running',
        startedAt: Date.now() - 1000,
        pid: 999999, // intentionally dead if checked
      }),
      'utf-8',
    );

    writeFileSync(
      join(jobsDir, `${jobId}-result.json`),
      JSON.stringify({ status: 'completed', teamName: 'artifact-team', taskResults: [] }),
      'utf-8',
    );

    const response = await handleStatus({ job_id: jobId });
    const payload = parseResponseText(response.content[0].text);

    expect(payload.status).toBe('completed');
    expect(payload.result).toMatchObject({ status: 'completed', teamName: 'artifact-team' });

    const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8')) as Record<string, unknown>;
    expect(persisted.status).toBe('completed');
  });

  it('handleWait deterministically fails on parse-failed artifact and persists failure', async () => {
    const { handleWait } = await importTeamServerWithJobsDir(jobsDir);

    const jobId = 'omc-art2';
    writeFileSync(
      join(jobsDir, `${jobId}.json`),
      JSON.stringify({
        status: 'running',
        startedAt: Date.now() - 500,
        pid: process.pid,
      }),
      'utf-8',
    );

    writeFileSync(join(jobsDir, `${jobId}-result.json`), '{not-json', 'utf-8');

    const response = await handleWait({ job_id: jobId, timeout_ms: 2000 });
    const payload = parseResponseText(response.content[0].text);

    expect(payload.status).toBe('failed');
    expect(payload.result).toMatchObject({
      error: { code: 'RESULT_ARTIFACT_PARSE_FAILED' },
    });

    const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8')) as Record<string, unknown>;
    expect(persisted.status).toBe('failed');
  });

  it('handleCleanup removes only scoped .omc/state/team/<teamName> directory', async () => {
    const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);

    const jobId = 'omc-art3';
    const cwd = join(testRoot, 'workspace');
    const teamOneDir = join(cwd, '.omc', 'state', 'team', 'team-one');
    const teamTwoDir = join(cwd, '.omc', 'state', 'team', 'team-two');

    mkdirSync(teamOneDir, { recursive: true });
    mkdirSync(teamTwoDir, { recursive: true });
    writeFileSync(join(teamOneDir, 'a.json'), '{}', 'utf-8');
    writeFileSync(join(teamTwoDir, 'b.json'), '{}', 'utf-8');

    writeFileSync(
      join(jobsDir, `${jobId}.json`),
      JSON.stringify({ status: 'running', startedAt: Date.now(), cwd, teamName: 'team-one' }),
      'utf-8',
    );
    writeFileSync(
      join(jobsDir, `${jobId}-panes.json`),
      JSON.stringify({ paneIds: ['%2'], leaderPaneId: '%1' }),
      'utf-8',
    );

    const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });
    expect(response.content[0].text).toContain('team state dir removed');

    expect(existsSync(teamOneDir)).toBe(false);
    expect(existsSync(teamTwoDir)).toBe(true);
  });

  it('handleCleanup preserves state and does not mark cleaned when pane liveness remains true', async () => {
    const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);

    const jobId = 'omc-art5';
    const cwd = join(testRoot, 'workspace-live-pane');
    const teamDir = join(cwd, '.omc', 'state', 'team', 'team-one');
    mkdirSync(teamDir, { recursive: true });

    writeFileSync(
      join(jobsDir, `${jobId}.json`),
      JSON.stringify({ status: 'running', startedAt: Date.now(), cwd, teamName: 'team-one' }),
      'utf-8',
    );
    writeFileSync(
      join(jobsDir, `${jobId}-panes.json`),
      JSON.stringify({ paneIds: ['%2'], leaderPaneId: '%1' }),
      'utf-8',
    );
    tmuxMocks.getWorkerLiveness.mockResolvedValueOnce('alive');

    const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });

    expect(response.content[0].text).toContain('worker_panes_still_alive:%2');
    expect(existsSync(teamDir)).toBe(true);
    const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8')) as Record<string, unknown>;
    expect(persisted.cleanedUpAt).toBeUndefined();
    expect(persisted.cleanupBlockedReason).toBe('worker_panes_still_alive:%2');
  });



  it('handleCleanup preserves state when pane liveness probe is unknown', async () => {
    const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);

    const jobId = 'omc-art9';
    const cwd = join(testRoot, 'workspace-unknown-probe');
    const teamDir = join(cwd, '.omc', 'state', 'team', 'team-one');
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(
      join(jobsDir, `${jobId}.json`),
      JSON.stringify({ status: 'running', startedAt: Date.now(), cwd, teamName: 'team-one' }),
      'utf-8',
    );
    writeFileSync(
      join(jobsDir, `${jobId}-panes.json`),
      JSON.stringify({ paneIds: ['%9'], leaderPaneId: '%1' }),
      'utf-8',
    );
    tmuxMocks.getWorkerLiveness.mockResolvedValueOnce('unknown');

    const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });

    expect(response.content[0].text).toContain('worker_liveness_unknown:%9');
    expect(existsSync(teamDir)).toBe(true);
    const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8')) as Record<string, unknown>;
    expect(persisted.cleanedUpAt).toBeUndefined();
    expect(persisted.cleanupBlockedReason).toBe('worker_liveness_unknown:%9');
  });

  it('handleCleanup preserves team state when dirty worktree cleanup is preserved', async () => {
    const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);

    const jobId = 'omc-art6';
    const cwd = join(testRoot, 'workspace-dirty-worktree');
    mkdirSync(cwd, { recursive: true });
    execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'pipe' });
    writeFileSync(join(cwd, 'README.md'), 'hello\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'pipe' });

    const teamDir = join(cwd, '.omc', 'state', 'team', 'team-one');
    mkdirSync(teamDir, { recursive: true });
    const worktree = createWorkerWorktree('team-one', 'worker1', cwd);
    writeFileSync(join(worktree.path, 'dirty.txt'), 'uncommitted\n', 'utf-8');

    writeFileSync(
      join(jobsDir, `${jobId}.json`),
      JSON.stringify({ status: 'running', startedAt: Date.now(), cwd, teamName: 'team-one' }),
      'utf-8',
    );
    writeFileSync(
      join(jobsDir, `${jobId}-panes.json`),
      JSON.stringify({ paneIds: ['%2'], leaderPaneId: '%1' }),
      'utf-8',
    );

    const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });

    expect(response.content[0].text).toContain('preserved');
    expect(existsSync(worktree.path)).toBe(true);
    expect(existsSync(teamDir)).toBe(true);
    const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8')) as Record<string, unknown>;
    expect(persisted.cleanedUpAt).toBeUndefined();
    expect(persisted.cleanupBlockedReason).toBe('worktrees_preserved:1');
  });



  it('handleCleanup preserves state when pane evidence is missing and config still has workers', async () => {
    const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);

    const jobId = 'omc-art7';
    const cwd = join(testRoot, 'workspace-unknown-liveness');
    const teamDir = join(cwd, '.omc', 'state', 'team', 'team-one');
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, 'config.json'), JSON.stringify({
      name: 'team-one',
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
      created_at: new Date().toISOString(),
      tmux_session: 'team-one-session:0',
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      next_task_id: 1,
    }), 'utf-8');
    writeFileSync(
      join(jobsDir, `${jobId}.json`),
      JSON.stringify({ status: 'running', startedAt: Date.now(), cwd, teamName: 'team-one' }),
      'utf-8',
    );

    const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });

    expect(response.content[0].text).toContain('worker_liveness_unknown:no_worker_pane_ids');
    expect(tmuxMocks.killWorkerPanes).not.toHaveBeenCalled();
    expect(existsSync(teamDir)).toBe(true);
    const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8')) as Record<string, unknown>;
    expect(persisted.cleanedUpAt).toBeUndefined();
    expect(persisted.cleanupBlockedReason).toBe('worker_liveness_unknown:no_worker_pane_ids');
  });



  it('handleCleanup preserves team state when only a worktree-root AGENTS backup remains', async () => {
    const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);

    const jobId = 'omc-art8';
    const cwd = join(testRoot, 'workspace-backup-only');
    const teamDir = join(cwd, '.omc', 'state', 'team', 'team-one');
    const backupPath = join(teamDir, 'workers', 'worker-1', 'worktree-root-agents.json');
    mkdirSync(join(teamDir, 'workers', 'worker-1'), { recursive: true });
    writeFileSync(backupPath, JSON.stringify({
      worktreePath: join(cwd, '.omc', 'team', 'team-one', 'worktrees', 'worker-1'),
      hadOriginal: true,
      originalContent: 'original',
      installedContent: 'managed',
      installedAt: new Date().toISOString(),
    }), 'utf-8');
    writeFileSync(
      join(jobsDir, `${jobId}.json`),
      JSON.stringify({ status: 'running', startedAt: Date.now(), cwd, teamName: 'team-one' }),
      'utf-8',
    );
    writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify({ paneIds: [], leaderPaneId: '%1' }), 'utf-8');

    const response = await handleCleanup({ job_id: jobId, grace_ms: 0 });

    expect(response.content[0].text).toContain('preserved');
    expect(existsSync(teamDir)).toBe(true);
    expect(existsSync(backupPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8')) as Record<string, unknown>;
    expect(persisted.cleanedUpAt).toBeUndefined();
    expect(persisted.cleanupBlockedReason).toBeTruthy();
  });

  it('handleCleanup also removes dormant scoped team worktrees when present', async () => {
    const { handleCleanup } = await importTeamServerWithJobsDir(jobsDir);

    const jobId = 'omc-art4';
    const cwd = join(testRoot, 'workspace-worktree');
    mkdirSync(cwd, { recursive: true });
    execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'pipe' });
    writeFileSync(join(cwd, 'README.md'), 'hello\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'pipe' });

    const teamOneDir = join(cwd, '.omc', 'state', 'team', 'team-one');
    mkdirSync(teamOneDir, { recursive: true });
    const worktree = createWorkerWorktree('team-one', 'worker1', cwd);
    expect(existsSync(worktree.path)).toBe(true);

    writeFileSync(
      join(jobsDir, `${jobId}.json`),
      JSON.stringify({ status: 'running', startedAt: Date.now(), cwd, teamName: 'team-one' }),
      'utf-8',
    );
    writeFileSync(
      join(jobsDir, `${jobId}-panes.json`),
      JSON.stringify({ paneIds: ['%2'], leaderPaneId: '%1' }),
      'utf-8',
    );

    await handleCleanup({ job_id: jobId, grace_ms: 0 });

    expect(existsSync(worktree.path)).toBe(false);
    expect(existsSync(teamOneDir)).toBe(false);
  });
});
