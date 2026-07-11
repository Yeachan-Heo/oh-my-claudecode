import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createWorkerWorktree } from '../git-worktree.js';

const tmuxMocks = vi.hoisted(() => ({
  killWorkerPanes: vi.fn(async () => undefined),
  killTeamSession: vi.fn(async () => undefined),
  resolveSplitPaneWorkerPaneIds: vi.fn(async (_session: string | undefined, paneIds: string[]) => paneIds),
  isWorkerAlive: vi.fn(async () => false),
  getWorkerLiveness: vi.fn(async () => 'dead'),
}));

vi.mock('../tmux-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tmux-session.js')>();
  return {
    ...actual,
    killWorkerPanes: tmuxMocks.killWorkerPanes,
    killTeamSession: tmuxMocks.killTeamSession,
    resolveSplitPaneWorkerPaneIds: tmuxMocks.resolveSplitPaneWorkerPaneIds,
    isWorkerAlive: tmuxMocks.isWorkerAlive,
    getWorkerLiveness: tmuxMocks.getWorkerLiveness,
  };




});

describe('shutdownTeamV2 detached worktree cleanup', () => {
  let repoDir: string;

  beforeEach(() => {
    tmuxMocks.killWorkerPanes.mockClear();
    tmuxMocks.killTeamSession.mockClear();
    tmuxMocks.resolveSplitPaneWorkerPaneIds.mockClear();
    tmuxMocks.resolveSplitPaneWorkerPaneIds.mockImplementation(async (_session: string | undefined, paneIds: string[]) => paneIds);
    tmuxMocks.isWorkerAlive.mockReset();
    tmuxMocks.isWorkerAlive.mockResolvedValue(false);
    tmuxMocks.getWorkerLiveness.mockReset();
    tmuxMocks.getWorkerLiveness.mockResolvedValue('dead');
    repoDir = mkdtempSync(join(tmpdir(), 'omc-runtime-v2-shutdown-'));
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(join(repoDir, 'README.md'), '# test\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('removes dormant team-created worktrees during normal shutdown', async () => {
    const teamName = 'shutdown-team';
    const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
    mkdirSync(teamRoot, { recursive: true });
    writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
      name: teamName,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 0,
      max_workers: 20,
      workers: [],
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      next_task_id: 1,
    }, null, 2), 'utf-8');

    const worktree = createWorkerWorktree(teamName, 'worker1', repoDir);
    expect(existsSync(worktree.path)).toBe(true);

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });

    expect(existsSync(worktree.path)).toBe(false);
    expect(existsSync(teamRoot)).toBe(false);
  });
  it('keeps team state when dirty worktrees are preserved during shutdown', async () => {
    const teamName = 'shutdown-dirty-team';
    const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
    mkdirSync(teamRoot, { recursive: true });
    writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
      name: teamName,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 0,
      max_workers: 20,
      workers: [],
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      next_task_id: 1,
    }, null, 2), 'utf-8');

    const worktree = createWorkerWorktree(teamName, 'worker-dirty', repoDir);
    writeFileSync(join(worktree.path, 'dirty.txt'), 'dirty', 'utf-8');

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });

    expect(existsSync(worktree.path)).toBe(true);
    expect(existsSync(teamRoot)).toBe(true);
  });




  it('keeps worktrees and team state when config is missing but clean metadata exists', async () => {
    const teamName = 'shutdown-missing-config-clean-metadata';
    const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
    const worktree = createWorkerWorktree(teamName, 'worker-clean', repoDir);
    expect(existsSync(teamRoot)).toBe(true);
    expect(existsSync(join(teamRoot, 'worktrees.json'))).toBe(true);

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });

    expect(existsSync(worktree.path)).toBe(true);
    expect(existsSync(teamRoot)).toBe(true);
    expect(existsSync(join(teamRoot, 'worktrees.json'))).toBe(true);
  });

  it('keeps team state when config is missing but worktree root AGENTS backup exists', async () => {
    const teamName = 'shutdown-backup-only-team';
    const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
    const backupPath = join(teamRoot, 'workers', 'worker-1', 'worktree-root-agents.json');
    mkdirSync(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
    writeFileSync(backupPath, JSON.stringify({
      worktreePath: join(repoDir, '.omc', 'team', teamName, 'worktrees', 'worker-1'),
      hadOriginal: true,
      originalContent: 'original',
      installedContent: 'managed',
      installedAt: new Date().toISOString(),
    }), 'utf-8');

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });

    expect(existsSync(teamRoot)).toBe(true);
    expect(existsSync(backupPath)).toBe(true);
  });

  it('keeps team state when config is missing but worktree metadata is corrupt', async () => {
    const teamName = 'shutdown-corrupt-metadata-team';
    const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
    mkdirSync(teamRoot, { recursive: true });
    writeFileSync(join(teamRoot, 'worktrees.json'), '{not-json', 'utf-8');

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });

    expect(existsSync(teamRoot)).toBe(true);
    expect(existsSync(join(teamRoot, 'worktrees.json'))).toBe(true);
  });

  it('uses the canonical team state root in worktree shutdown ack instructions', async () => {
    const teamName = 'shutdown-worktree-ack-team';
    const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
    mkdirSync(teamRoot, { recursive: true });

    const worktree = createWorkerWorktree(teamName, 'worker-wt', repoDir);
    writeFileSync(join(worktree.path, 'dirty.txt'), 'dirty', 'utf-8');

    writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
      name: teamName,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{
        name: 'worker-wt',
        index: 1,
        role: 'executor',
        assigned_tasks: [],
        working_dir: worktree.path,
        team_state_root: teamRoot,
        worktree_path: worktree.path,
        worktree_created: true,
      }],
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      next_task_id: 1,
    }, null, 2), 'utf-8');

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });

    const inbox = readFileSync(join(teamRoot, 'workers', 'worker-wt', 'inbox.md'), 'utf-8');
    expect(inbox).toContain('$OMC_TEAM_STATE_ROOT/workers/worker-wt/shutdown-ack.json');
    expect(inbox).not.toContain(`Write your ack to: .omc/state/team/${teamName}`);
  });

  it('keeps worktrees and team state when a worker pane remains alive after shutdown kill', async () => {
    const teamName = 'shutdown-live-pane-team';
    const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
    mkdirSync(teamRoot, { recursive: true });
    const worktree = createWorkerWorktree(teamName, 'worker-live', repoDir);
    writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
      name: teamName,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{
        name: 'worker-live',
        index: 1,
        role: 'executor',
        assigned_tasks: [],
        pane_id: '%42',
        working_dir: worktree.path,
        team_state_root: teamRoot,
        worktree_path: worktree.path,
        worktree_created: true,
      }],
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      next_task_id: 1,
    }, null, 2), 'utf-8');
    tmuxMocks.getWorkerLiveness.mockResolvedValue('alive');

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });

    expect(tmuxMocks.killWorkerPanes).toHaveBeenCalled();
    expect(existsSync(worktree.path)).toBe(true);
    expect(existsSync(teamRoot)).toBe(true);
  });



  it('keeps worktrees and team state when pane liveness probe is unknown after shutdown kill', async () => {
    const teamName = 'shutdown-unknown-pane-team';
    const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
    mkdirSync(teamRoot, { recursive: true });
    const worktree = createWorkerWorktree(teamName, 'worker-unknown', repoDir);
    writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
      name: teamName,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{
        name: 'worker-unknown',
        index: 1,
        role: 'executor',
        assigned_tasks: [],
        pane_id: '%44',
        working_dir: worktree.path,
        team_state_root: teamRoot,
        worktree_path: worktree.path,
        worktree_created: true,
      }],
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      next_task_id: 1,
    }, null, 2), 'utf-8');
    tmuxMocks.getWorkerLiveness.mockResolvedValue('unknown');

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });

    expect(tmuxMocks.killWorkerPanes).toHaveBeenCalled();
    expect(existsSync(worktree.path)).toBe(true);
    expect(existsSync(teamRoot)).toBe(true);
  });

  it('keeps worktrees and team state when tmux cleanup fails before liveness is proven', async () => {
    const teamName = 'shutdown-kill-fails-team';
    const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
    mkdirSync(teamRoot, { recursive: true });
    const worktree = createWorkerWorktree(teamName, 'worker-kill-fails', repoDir);
    writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
      name: teamName,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{
        name: 'worker-kill-fails',
        index: 1,
        role: 'executor',
        assigned_tasks: [],
        pane_id: '%43',
        working_dir: worktree.path,
        team_state_root: teamRoot,
        worktree_path: worktree.path,
        worktree_created: true,
      }],
      created_at: new Date().toISOString(),
      tmux_session: `${teamName}:0`,
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      next_task_id: 1,
    }, null, 2), 'utf-8');
    tmuxMocks.killWorkerPanes.mockRejectedValueOnce(new Error('tmux unavailable'));

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 });

    expect(tmuxMocks.killWorkerPanes).toHaveBeenCalled();
    expect(existsSync(worktree.path)).toBe(true);
    expect(existsSync(teamRoot)).toBe(true);
  });



  it.each([false, true])('blocks %s force shutdown before effects while recovery is active', async force => {
    const teamName = force ? 'shutdown-active-force' : 'shutdown-active-normal';
    const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
    mkdirSync(teamRoot, { recursive: true });
    const configPath = join(teamRoot, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      name: teamName, task: 'demo', agent_type: 'claude', worker_launch_mode: 'interactive',
      worker_count: 1, max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%77' }],
      created_at: new Date().toISOString(), tmux_session: `${teamName}:0`, lifecycle_state: 'active', state_revision: 4,
      active_recovery: { request_id: 'request-active', recovery_id: 'recovery-active', worker_name: 'worker-1',
        owner_epoch: 2, owner_nonce: 'owner', phase: 'active', state_revision: 4,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      next_task_id: 1,
    }));

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, { timeoutMs: 0, force }))
      .rejects.toThrow('shutdown_blocked:active_recovery:recovery-active');
    expect(tmuxMocks.killWorkerPanes).not.toHaveBeenCalled();
    expect(existsSync(configPath)).toBe(true);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).lifecycle_state).toBe('active');
  });

  it('does not commit shutdown lifecycle or kill panes when manifest projection fails', async () => {
    const teamName = 'shutdown-projection-failure';
    const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
    mkdirSync(teamRoot, { recursive: true });
    const configPath = join(teamRoot, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      name: teamName, task: 'demo', agent_type: 'claude', worker_launch_mode: 'interactive',
      worker_count: 1, max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%77' }],
      created_at: new Date().toISOString(), tmux_session: `${teamName}:0`, lifecycle_state: 'active',
      state_revision: 4, next_task_id: 1,
    }));
    mkdirSync(join(teamRoot, 'manifest.json'));

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, { timeoutMs: 0, force: true }))
      .rejects.toThrow('invalid_persisted_state');
    expect(tmuxMocks.killWorkerPanes).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ lifecycle_state: 'active', state_revision: 4 });
  });

  it('blocks shutdown before effects while a scale-down reservation is active', async () => {
    const teamName = 'shutdown-active-scale-down';
    const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
    mkdirSync(teamRoot, { recursive: true });
    const configPath = join(teamRoot, 'config.json');
    const now = new Date().toISOString();
    writeFileSync(configPath, JSON.stringify({
      name: teamName, task: 'demo', agent_type: 'claude', worker_launch_mode: 'interactive',
      worker_count: 2, max_workers: 20,
      workers: [
        { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%77' },
        { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [], pane_id: '%78' },
      ],
      created_at: now, tmux_session: `${teamName}:0`, lifecycle_state: 'active', state_revision: 4,
      active_scale_down: { operation_id: 'scale-down-active', phase: 'draining', pid: process.pid,
        process_started_at: 'test-process-start', workers: [{ name: 'worker-2', pane_id: '%78' }],
        state_revision: 4, created_at: now, updated_at: now },
      next_task_id: 1,
    }));

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, { timeoutMs: 0, force: true }))
      .rejects.toThrow('shutdown_blocked:active_scale_down:scale-down-active');
    expect(tmuxMocks.killWorkerPanes).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(configPath, 'utf8')).lifecycle_state).toBe('active');
  });

  it('restores active lifecycle when a worker rejects normal shutdown before pane cleanup', async () => {
    const teamName = 'shutdown-worker-rejected';
    const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
    const workerRoot = join(teamRoot, 'workers', 'worker-1');
    mkdirSync(workerRoot, { recursive: true });
    const configPath = join(teamRoot, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      name: teamName, task: 'demo', agent_type: 'claude', worker_launch_mode: 'interactive',
      worker_count: 1, max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%77' }],
      created_at: new Date().toISOString(), tmux_session: `${teamName}:0`, lifecycle_state: 'active', state_revision: 4,
      next_task_id: 1,
    }));
    writeFileSync(join(workerRoot, 'shutdown-ack.json'), JSON.stringify({
      status: 'reject', reason: 'still working', updated_at: '2099-01-01T00:00:00.000Z',
    }));

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, { timeoutMs: 25 }))
      .rejects.toThrow('shutdown_rejected:worker-1:still working');

    expect(tmuxMocks.killWorkerPanes).not.toHaveBeenCalled();
    const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(persisted.lifecycle_state).toBe('active');
    expect(persisted.state_revision).toBe(6);
    expect(persisted.active_recovery).toBeUndefined();
  });

  it('does not roll back a shutdown fence owned by another concurrent invocation', async () => {
    const teamName = 'shutdown-concurrent-owner';
    const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
    const workerRoot = join(teamRoot, 'workers', 'worker-1');
    mkdirSync(workerRoot, { recursive: true });
    const configPath = join(teamRoot, 'config.json');
    const now = new Date().toISOString();
    writeFileSync(configPath, JSON.stringify({
      name: teamName, task: 'demo', agent_type: 'claude', worker_launch_mode: 'interactive',
      worker_count: 1, max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%77' }],
      created_at: now, tmux_session: `${teamName}:0`, lifecycle_state: 'shutting_down', state_revision: 5,
      shutdown_attempt: { nonce: 'force-owner', pid: process.pid, process_started_at: 'owner-start', state_revision: 5, created_at: now },
      next_task_id: 1,
    }));
    writeFileSync(join(workerRoot, 'shutdown-ack.json'), JSON.stringify({
      status: 'reject', reason: 'still working', updated_at: '2099-01-01T00:00:00.000Z',
    }));

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, { timeoutMs: 25 }))
      .rejects.toThrow('shutdown_rejected_fence_lost:worker-1:still working');

    expect(tmuxMocks.killWorkerPanes).not.toHaveBeenCalled();
    const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(persisted.lifecycle_state).toBe('shutting_down');
    expect(persisted.state_revision).toBe(5);
    expect(persisted.shutdown_attempt.nonce).toBe('force-owner');
  });

  it('leaves an active team recoverable when the normal shutdown gate blocks', async () => {
    const teamName = 'shutdown-gate-blocked';
    const teamRoot = join(repoDir, '.omc', 'state', 'team', teamName);
    const tasksRoot = join(teamRoot, 'tasks');
    mkdirSync(tasksRoot, { recursive: true });
    const configPath = join(teamRoot, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      name: teamName, task: 'demo', agent_type: 'claude', worker_launch_mode: 'interactive',
      worker_count: 1, max_workers: 20,
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: ['1'], pane_id: '%77' }],
      created_at: new Date().toISOString(), tmux_session: `${teamName}:0`, lifecycle_state: 'active', state_revision: 4,
      next_task_id: 2,
    }));
    writeFileSync(join(tasksRoot, 'task-1.json'), JSON.stringify({
      id: '1', subject: 'pending', description: 'must finish first', status: 'pending',
      owner: 'worker-1', blocked_by: [], depends_on: [], created_at: new Date().toISOString(), version: 1,
    }));

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2(teamName, repoDir, { timeoutMs: 0 }))
      .rejects.toThrow('shutdown_gate_blocked:pending=1,blocked=0,in_progress=0,failed=0');

    expect(tmuxMocks.killWorkerPanes).not.toHaveBeenCalled();
    const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(persisted.lifecycle_state).toBe('active');
    expect(persisted.state_revision).toBe(4);
    expect(persisted.active_recovery).toBeUndefined();
  });
});
