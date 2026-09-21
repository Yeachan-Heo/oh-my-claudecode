import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { canonicalizeTeamConfigWorkers } from '../worker-canonicalization.js';
import { awaitWorkerLaunchAcknowledgement, prepareWorkerLaunchAttempt } from '../worker-launch-ack.js';
import { createTeamInstanceBinding, disposeTeamInstance, reserveTeamInstance } from '../team-instance.js';
import { teamStateRoot } from '../state-paths.js';

const TEAM_INSTANCE_ID = '33333333-3333-4333-8333-333333333333';
const REPLACEMENT_INSTANCE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FINAL_DISPOSAL_AUTHORIZATION = {
  protocol: 'caller-owned-final-state-v1' as const,
  providers: 'disposed' as const,
  panes: 'disposed' as const,
  worktrees: 'disposed' as const,
};

function fixtureProcessStartIdentity(): string {
  if (process.platform === 'darwin') return 'darwin:1:0';
  if (process.platform === 'linux') return 'linux:1';
  if (process.platform === 'win32') return 'win32:1';
  return `${process.platform}:fixture`;
}

const mocks = vi.hoisted(() => {
  const tmuxServerIdentity = {
    socket_path: '/tmp/omc-test-tmux.sock',
    server_pid: 4242,
    process_started_at: process.platform === 'darwin'
      ? 'darwin:1700000000:123456'
      : 'linux:01234567-89ab-cdef-0123-456789abcdef:424242',
  };
  const getWorkerLiveness = vi.fn(async (_paneId?: string): Promise<'alive' | 'dead' | 'unknown'> => 'alive');
  return {
    tmuxServerIdentity,
    getWorkerLiveness,
    getOwnedWorkerLiveness: vi.fn(async (ownership: { provider: string; tmuxServerIdentity?: typeof tmuxServerIdentity }) => {
      if (ownership.provider === 'tmux' && !ownership.tmuxServerIdentity) return 'unknown' as const;
      return getWorkerLiveness();
    }),
    captureOwnedTeamPane: vi.fn(async () => '> \n'),
    execFile: vi.fn(),
    tmuxExecAsync: vi.fn(),
  };
});

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
    getWorkerLiveness: mocks.getWorkerLiveness,
    getOwnedWorkerLiveness: mocks.getOwnedWorkerLiveness,
    captureOwnedTeamPane: mocks.captureOwnedTeamPane,
  };
});

describe('monitorTeamV2 pane-based stall inference', () => {
  let cwd: string;
  let restoreFixtureEnv: (() => void) | undefined;

  function isolateFixtureRoot(root: string): void {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousOmcStateDir = process.env.OMC_STATE_DIR;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.OMC_STATE_DIR;
    restoreFixtureEnv = () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousOmcStateDir === undefined) delete process.env.OMC_STATE_DIR;
      else process.env.OMC_STATE_DIR = previousOmcStateDir;
    };
  }

  beforeEach(() => {
    vi.resetModules();
    mocks.getWorkerLiveness.mockReset();
    mocks.getOwnedWorkerLiveness.mockReset();
    mocks.captureOwnedTeamPane.mockReset();
    mocks.execFile.mockReset();
    mocks.tmuxExecAsync.mockReset();
    mocks.getWorkerLiveness.mockResolvedValue('alive');
    mocks.getOwnedWorkerLiveness.mockImplementation(async (ownership: {
      provider: string;
      tmuxServerIdentity?: typeof mocks.tmuxServerIdentity;
    }) => {
      if (ownership.provider === 'tmux' && !ownership.tmuxServerIdentity) return 'unknown';
      return mocks.getWorkerLiveness();
    });
    mocks.captureOwnedTeamPane.mockImplementation(async () => {
      const captured = await mocks.tmuxExecAsync(['capture-pane']);
      return typeof captured?.stdout === 'string' ? captured.stdout : '';
    });
    mocks.execFile.mockImplementation((_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (args[0] === 'capture-pane') {
        cb(null, '> \n', '');
        return;
      }
      cb(null, '', '');
    });
    mocks.tmuxExecAsync.mockImplementation(async (args: string[]) => {
      if (args[0] === 'capture-pane') {
        return { stdout: '> \n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
  });

  afterEach(async () => {
    restoreFixtureEnv?.();
    restoreFixtureEnv = undefined;
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  async function writeConfigAndTask(
    taskStatus: 'pending' | 'in_progress' = 'pending',
    instanceId = TEAM_INSTANCE_ID,
    reserve = true,
  ): Promise<void> {
    if (reserve) await reserveTeamInstance({ teamName: 'demo-team', cwd, instanceId });
    const teamRoot = teamStateRoot(cwd, 'demo-team');
    await mkdir(join(teamRoot, 'tasks'), { recursive: true });
    await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
    await writeFile(join(teamRoot, 'config.json'), JSON.stringify({
      name: 'demo-team',
      instance_id: instanceId,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [{
        name: 'worker-1',
        index: 1,
        role: 'claude',
        assigned_tasks: ['1'],
        pane_id: '%2',
        working_dir: cwd,
      }],
      created_at: new Date().toISOString(),
      tmux_session: 'demo-session:0',
      tmux_server_identity: mocks.tmuxServerIdentity,
      leader_pane_id: '%1',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      next_task_id: 2,
      team_state_root: teamRoot,
      workspace_mode: 'single',
    }, null, 2), 'utf-8');
    await writeFile(join(teamRoot, 'tasks', '1.json'), JSON.stringify({
      id: '1',
      subject: 'Demo task',
      description: 'Investigate a worker stall',
      status: taskStatus,
      owner: taskStatus === 'in_progress' ? 'worker-1' : undefined,
      created_at: new Date().toISOString(),
    }, null, 2), 'utf-8');
  }

  it('flags pane-idle workers with assigned work but no work-start evidence', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-monitor-'));
    isolateFixtureRoot(cwd);
    await writeConfigAndTask('pending');

    const { monitorTeamV2 } = await import('../runtime-v2.js');
    const snapshot = await monitorTeamV2('demo-team', cwd);

    expect(snapshot?.nonReportingWorkers).toContain('worker-1');
    expect(snapshot?.recommendations).toContain(
      'Investigate worker-1: assigned work but no work-start evidence; pane is idle at prompt',
    );
  });

  it('surfaces missing blocker task ids in monitor recommendations', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-monitor-missing-blocker-'));
    isolateFixtureRoot(cwd);
    await writeConfigAndTask('pending');
    const teamRoot = teamStateRoot(cwd, 'demo-team');
    await writeFile(join(teamRoot, 'tasks', '1.json'), JSON.stringify({
      id: '1',
      subject: 'Blocked task',
      description: 'Depends on missing task 13',
      status: 'pending',
      owner: 'worker-1',
      blocked_by: ['13'],
      depends_on: ['13'],
      created_at: new Date().toISOString(),
    }, null, 2), 'utf-8');

    const { monitorTeamV2 } = await import('../runtime-v2.js');
    const snapshot = await monitorTeamV2('demo-team', cwd);

    expect(snapshot?.nonReportingWorkers).toContain('worker-1');
    expect(snapshot?.recommendations).toContain(
      'Investigate worker-1: task-1 is blocked by missing task ids [13]; pane is idle at prompt',
    );
    expect(snapshot?.recommendations).toContain(
      'Investigate task-1: depends on missing task ids [13]',
    );
  });

  it('does not flag a worker when pane evidence shows active work despite missing reports', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-monitor-active-'));
    isolateFixtureRoot(cwd);
    await writeConfigAndTask('in_progress');
    mocks.execFile.mockImplementation((_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (args[0] === 'capture-pane') {
        cb(null, 'Working on task...\n  esc to interrupt\n', '');
        return;
      }
      cb(null, '', '');
    });
    mocks.tmuxExecAsync.mockImplementation(async (args: string[]) => {
      if (args[0] === 'capture-pane') {
        return { stdout: 'Working on task...\n  esc to interrupt\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const { monitorTeamV2 } = await import('../runtime-v2.js');
    const snapshot = await monitorTeamV2('demo-team', cwd);

    expect(snapshot?.nonReportingWorkers).toEqual([]);
  });



  it('does not mark unknown pane liveness as dead or recommend reassignment', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-monitor-unknown-liveness-'));
    isolateFixtureRoot(cwd);
    await writeConfigAndTask('in_progress');
    const teamRoot = teamStateRoot(cwd, 'demo-team');
    await writeFile(join(teamRoot, 'monitor-snapshot.json'), JSON.stringify({
      taskStatusById: { 1: 'in_progress' },
      workerAliveByName: { 'worker-1': true },
      workerLivenessByName: { 'worker-1': 'alive' },
      workerStateByName: { 'worker-1': 'working' },
      workerTurnCountByName: { 'worker-1': 1 },
      workerTaskIdByName: { 'worker-1': '1' },
      mailboxNotifiedByMessageId: {},
      completedEventTaskIds: {},
    }, null, 2), 'utf-8');
    mocks.getWorkerLiveness.mockResolvedValueOnce('unknown');

    const { monitorTeamV2 } = await import('../runtime-v2.js');
    const { readTeamEventsByType } = await import('../events.js');
    const snapshot = await monitorTeamV2('demo-team', cwd);

    expect(snapshot?.workers[0]?.alive).toBe(false);
    expect(snapshot?.workers[0]?.liveness).toBe('unknown');
    expect(snapshot?.deadWorkers).toEqual([]);
    expect(snapshot?.recommendations).not.toContain('Reassign task-1 from dead worker-1');
    await expect(readTeamEventsByType('demo-team', 'worker_stopped', cwd)).resolves.toEqual([]);
  });

  it('does not flag a worker when pane evidence shows startup bootstrapping instead of idle readiness', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-monitor-bootstrap-'));
    isolateFixtureRoot(cwd);
    await writeConfigAndTask('pending');
    mocks.execFile.mockImplementation((_cmd: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (args[0] === 'capture-pane') {
        cb(null, 'model: loading\ngpt-5.3-codex high · 80% left\n', '');
        return;
      }
      cb(null, '', '');
    });
    mocks.tmuxExecAsync.mockImplementation(async (args: string[]) => {
      if (args[0] === 'capture-pane') {
        return { stdout: 'model: loading\ngpt-5.3-codex high · 80% left\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const { monitorTeamV2 } = await import('../runtime-v2.js');
    const snapshot = await monitorTeamV2('demo-team', cwd);

    expect(snapshot?.nonReportingWorkers).toEqual([]);
  });

  it('monitors a valid config canonicalized from duplicate legacy worker rows', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-monitor-dedup-'));
    isolateFixtureRoot(cwd);
    await writeConfigAndTask('pending');
    const root = teamStateRoot(cwd, 'demo-team');
    const config = canonicalizeTeamConfigWorkers({
      name: 'demo-team',
      instance_id: TEAM_INSTANCE_ID,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 2,
      max_workers: 20,
      workers: [
        { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: ['1'] },
        { name: 'worker-1', index: 0, role: 'claude', assigned_tasks: [], pane_id: '%2', working_dir: cwd },
      ],
      created_at: new Date().toISOString(),
      tmux_session: 'demo-session:0',
      tmux_server_identity: mocks.tmuxServerIdentity,
      leader_pane_id: '%1',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
      next_task_id: 2,
      team_state_root: root,
      workspace_mode: 'single',
    } as any);
    expect(config.workers).toEqual([expect.objectContaining({
      name: 'worker-1', index: 1, pane_id: '%2', assigned_tasks: ['1'],
    })]);
    await writeFile(join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');

    const { monitorTeamV2 } = await import('../runtime-v2.js');
    const snapshot = await monitorTeamV2('demo-team', cwd);

    expect(snapshot?.workers).toHaveLength(1);
    expect(snapshot?.workers[0]?.name).toBe('worker-1');
    expect(snapshot?.workers[0]?.assignedTasks).toEqual(['1']);
  });

  it('reports provider death independently when its pane transport remains alive', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-monitor-provider-dead-'));
    isolateFixtureRoot(cwd);
    await writeConfigAndTask('in_progress');
    const teamRoot = teamStateRoot(cwd, 'demo-team');
    const attempt = await prepareWorkerLaunchAttempt({
      cwd,
      teamName: 'demo-team',
      workerName: 'worker-1',
      instanceId: TEAM_INSTANCE_ID,
      paneId: '%2',
      provider: 'claude',
      runtimeCliPath: '/runtime-cli.cjs',
      context: { kind: 'initial' },
    });
    const expected = JSON.parse(await readFile(attempt.expectedPath, 'utf8')) as Record<string, unknown>;
    await writeFile(attempt.ackPath, JSON.stringify({
      ...expected,
      kind: 'worker_launch_ack',
      written_at: new Date().toISOString(),
    }));
    await expect(awaitWorkerLaunchAcknowledgement(attempt, { timeoutMs: 1_000, pollIntervalMs: 5 }))
      .resolves.toEqual({ ok: true });
    await writeFile(attempt.startedPath, JSON.stringify({
      ...expected,
      kind: 'worker_launch_provider_started',
      pid: 999_999,
      process_start_identity: fixtureProcessStartIdentity(),
      process_group_id: 999_999,
      written_at: new Date().toISOString(),
    }));
    await writeFile(`${attempt.startedPath}.terminal`, JSON.stringify({
      ...expected,
      kind: 'worker_launch_provider_terminal',
      outcome: 'exit',
      cleanup_verified: true,
      child_reaped: true,
      pid: 999_999,
      process_start_identity: fixtureProcessStartIdentity(),
      process_group_id: 999_999,
      written_at: new Date().toISOString(),
    }));
    const config = JSON.parse(await readFile(join(teamRoot, 'config.json'), 'utf8')) as Record<string, unknown> & {
      workers: Array<Record<string, unknown>>;
    };
    config.workers[0] = {
      ...config.workers[0],
      pane_id: '%2',
      worker_cli: 'claude',
      launch_attempt_id: attempt.attempt_id,
      launch_descriptor: { schema_version: 1, provider: 'claude', model: null, binary: '/bin/echo', args: [] },
    };
    await writeFile(join(teamRoot, 'config.json'), JSON.stringify(config), 'utf8');

    const { monitorTeamV2 } = await import('../runtime-v2.js');
    const snapshot = await monitorTeamV2('demo-team', cwd);

    expect(snapshot?.workers[0]).toMatchObject({
      alive: true,
      liveness: 'alive',
      providerLiveness: 'dead',
    });
    expect(snapshot?.deadWorkers).toContain('worker-1');
  });

  it('aborts a stale expected-instance cycle before mutating the replacement', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-monitor-stale-instance-'));
    isolateFixtureRoot(cwd);
    await writeConfigAndTask('pending');

    let releaseLiveness!: (value: 'alive' | 'dead' | 'unknown') => void;
    let livenessStarted!: () => void;
    const livenessGate = new Promise<'alive' | 'dead' | 'unknown'>(resolveGate => { releaseLiveness = resolveGate; });
    const scanStarted = new Promise<void>(resolveStarted => { livenessStarted = resolveStarted; });
    mocks.getWorkerLiveness.mockImplementationOnce(async () => {
      livenessStarted();
      return livenessGate;
    });

    const { monitorTeamV2 } = await import('../runtime-v2.js');
    const monitorPromise = monitorTeamV2('demo-team', cwd, TEAM_INSTANCE_ID);
    await scanStarted;

    await disposeTeamInstance(
      createTeamInstanceBinding({ teamName: 'demo-team', cwd, instanceId: TEAM_INSTANCE_ID }),
      FINAL_DISPOSAL_AUTHORIZATION,
    );
    await reserveTeamInstance({ teamName: 'demo-team', cwd, instanceId: REPLACEMENT_INSTANCE_ID });
    await writeConfigAndTask('pending', REPLACEMENT_INSTANCE_ID, false);

    releaseLiveness('alive');
    await expect(monitorPromise).rejects.toMatchObject({ code: 'team_instance_mismatch' });

    const replacementRoot = teamStateRoot(cwd, 'demo-team');
    await expect(readFile(join(replacementRoot, 'monitor-snapshot.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(replacementRoot, 'events.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an expected-instance mismatch before verdict processing or monitor writes', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-monitor-mismatched-instance-'));
    isolateFixtureRoot(cwd);
    await writeConfigAndTask('pending', REPLACEMENT_INSTANCE_ID);
    const teamRoot = teamStateRoot(cwd, 'demo-team');
    const config = JSON.parse(await readFile(join(teamRoot, 'config.json'), 'utf8')) as {
      workers: Array<Record<string, unknown>>;
    };
    config.workers[0] = {
      ...config.workers[0],
      output_file: join(teamRoot, 'workers', 'worker-1', 'verdict.json'),
    };
    await writeFile(join(teamRoot, 'config.json'), JSON.stringify(config), 'utf8');

    const { monitorTeamV2 } = await import('../runtime-v2.js');
    await expect(monitorTeamV2('demo-team', cwd, TEAM_INSTANCE_ID))
      .rejects.toThrow('team_instance_mismatch');
    await expect(readFile(join(teamRoot, 'monitor-snapshot.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(teamRoot, 'events.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
