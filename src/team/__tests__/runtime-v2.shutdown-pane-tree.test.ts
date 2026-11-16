import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { getOmcRoot } from '../../lib/worktree-paths.js';
import { reserveTeamInstance } from '../team-instance.js';
import { currentStrictProcessStartIdentity } from '../team-owner-epoch.js';

// The team shutdown loop takes the descendant processes of a worker pane down before the pane
// cleanup (opt-in through OMC_TEAM_KILL_PANE_TREE, checked inside killWorkerPaneProcessTree).
// Here the function is a mock: the cases cover the call site in the loop, not the tree walk.

const tmuxUtilsMocks = vi.hoisted(() => ({
  tmuxExecAsync: vi.fn(),
  tmuxCmdAsync: vi.fn(),
}));
const tmuxSessionMocks = vi.hoisted(() => ({
  observeTmuxServerIdentity: vi.fn(async () => 'matching' as const),
  getOwnedWorkerLiveness: vi.fn(async (): Promise<'alive' | 'dead' | 'unknown'> => 'dead'),
  observeTeamSessionTargetPresence: vi.fn(async () => ({ kind: 'owned' as const })),
  workerPaneBelongsToOwnedProviderTarget: vi.fn(async () => true),
  killOwnedWorkerPane: vi.fn(async () => undefined),
  killWorkerPaneProcessTree: vi.fn<(identity: unknown, paneId: string) => Promise<void>>(async () => undefined),
  killTeamSession: vi.fn(async () => true),
}));

const TEAM_INSTANCE_ID = '55555555-5555-4555-8555-555555555555';
const LAUNCH_ATTEMPT_ID = '66666666-6666-4666-8666-666666666666';

vi.mock('../../cli/tmux-utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../cli/tmux-utils.js')>();
  return {
    ...actual,
    tmuxExecAsync: tmuxUtilsMocks.tmuxExecAsync,
    tmuxCmdAsync: tmuxUtilsMocks.tmuxCmdAsync,
  };
});

vi.mock('../tmux-session.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../tmux-session.js')>();
  return {
    ...actual,
    observeTmuxServerIdentity: tmuxSessionMocks.observeTmuxServerIdentity,
    getOwnedWorkerLiveness: tmuxSessionMocks.getOwnedWorkerLiveness,
    observeTeamSessionTargetPresence: tmuxSessionMocks.observeTeamSessionTargetPresence,
    workerPaneBelongsToOwnedProviderTarget: tmuxSessionMocks.workerPaneBelongsToOwnedProviderTarget,
    killOwnedWorkerPane: tmuxSessionMocks.killOwnedWorkerPane,
    killWorkerPaneProcessTree: tmuxSessionMocks.killWorkerPaneProcessTree,
    killTeamSession: tmuxSessionMocks.killTeamSession,
  };
});

async function writeJson(cwd: string, relativePath: string, value: unknown): Promise<void> {
  const fullPath = isAbsolute(relativePath) ? relativePath : join(cwd, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(value, null, 2), 'utf-8');
}

/** The identity of this very process: the adoption of a pane proves the "server" against the process table. */
function ownProcessTmuxIdentity() {
  return {
    socket_path: '/tmp/omc-shutdown-pane-tree-test.sock',
    server_pid: process.pid,
    process_started_at: currentStrictProcessStartIdentity(process.pid) ?? 'unavailable',
  };
}

describe.skipIf(currentStrictProcessStartIdentity(process.pid) === null)('shutdownTeamV2 worker pane process tree', () => {
  let cwd = '';
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalStateDir: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalStateDir = process.env.OMC_STATE_DIR;
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-pane-tree-'));
    process.env.HOME = cwd;
    process.env.USERPROFILE = cwd;
    delete process.env.OMC_STATE_DIR;
    tmuxUtilsMocks.tmuxExecAsync.mockReset();
    tmuxUtilsMocks.tmuxCmdAsync.mockReset();
    for (const mock of Object.values(tmuxSessionMocks)) mock.mockClear();
    tmuxSessionMocks.observeTmuxServerIdentity.mockResolvedValue('matching');
    tmuxSessionMocks.getOwnedWorkerLiveness.mockResolvedValue('dead');
    tmuxSessionMocks.observeTeamSessionTargetPresence.mockResolvedValue({ kind: 'owned' });
    tmuxSessionMocks.workerPaneBelongsToOwnedProviderTarget.mockResolvedValue(true);
    tmuxSessionMocks.killOwnedWorkerPane.mockResolvedValue(undefined);
    tmuxSessionMocks.killWorkerPaneProcessTree.mockResolvedValue(undefined);
    tmuxSessionMocks.killTeamSession.mockResolvedValue(true);

    // The pane membership proof lists the panes of the team window; the identity probe answers with this process.
    tmuxUtilsMocks.tmuxExecAsync.mockImplementation(async (args: string[]) => ({
      stdout: args.includes('list-panes') ? '%1\n%2\n%3\n' : '',
      stderr: '',
    }));
    tmuxUtilsMocks.tmuxCmdAsync.mockImplementation(async (args: string[]) => ({
      stdout: args.includes('#{pid}') ? `${process.pid}\n` : '',
      stderr: '',
    }));
  });

  afterEach(async () => {
    delete process.env.OMC_TEAM_KILL_PANE_TREE;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalStateDir === undefined) delete process.env.OMC_STATE_DIR;
    else process.env.OMC_STATE_DIR = originalStateDir;
    if (cwd) {
      await rm(cwd, { recursive: true, force: true });
      cwd = '';
    }
  });

  async function writeTeam(teamName: string): Promise<void> {
    await reserveTeamInstance({ teamName, cwd, instanceId: TEAM_INSTANCE_ID });
    const teamRoot = join(getOmcRoot(cwd), 'state', 'team', teamName);
    await writeJson(cwd, `${teamRoot}/config.json`, {
      name: teamName,
      instance_id: TEAM_INSTANCE_ID,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{
        name: 'worker-1', index: 1, role: 'claude', assigned_tasks: [], pane_id: '%2',
        worker_cli: 'claude', launch_attempt_id: LAUNCH_ATTEMPT_ID,
        launch_descriptor: { schema_version: 1, provider: 'claude', model: null, binary: process.execPath, args: [] },
      }],
      created_at: new Date().toISOString(),
      tmux_session: 'leader-session:0',
      tmux_server_identity: ownProcessTmuxIdentity(),
      tmux_window_owned: false,
      next_task_id: 1,
      leader_pane_id: '%1',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    });
  }

  it('a dead pane (no ownership) skips the tree kill without throwing', async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    await writeTeam('pane-tree-dead-team');

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2('pane-tree-dead-team', cwd, { timeoutMs: 0 })).resolves.toMatchObject({
      outcome: 'preserved',
    });

    // The loop reached the pane step (liveness of the configured pane was read) and found no ownership to act on.
    expect(tmuxSessionMocks.getOwnedWorkerLiveness).toHaveBeenCalled();
    expect(tmuxSessionMocks.killWorkerPaneProcessTree).not.toHaveBeenCalled();
    expect(tmuxSessionMocks.killOwnedWorkerPane).not.toHaveBeenCalled();
  });

  it('a pane with proven ownership gets its tree taken down with the recorded server identity and the pane id', async () => {
    process.env.OMC_TEAM_KILL_PANE_TREE = '1';
    tmuxSessionMocks.getOwnedWorkerLiveness.mockResolvedValue('alive');
    await writeTeam('pane-tree-alive-team');

    const { shutdownTeamV2 } = await import('../runtime-v2.js');
    await expect(shutdownTeamV2('pane-tree-alive-team', cwd, { timeoutMs: 0 })).resolves.toMatchObject({
      outcome: 'preserved',
    });

    expect(tmuxSessionMocks.killWorkerPaneProcessTree).toHaveBeenCalledTimes(1);
    expect(tmuxSessionMocks.killWorkerPaneProcessTree).toHaveBeenCalledWith(ownProcessTmuxIdentity(), '%2');
  });
});
