import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { absPath, TeamPaths } from '../../team/state-paths.js';
import type { TeamConfig } from '../../team/types.js';
import type { MailboxNotificationTarget } from '../../team/mailbox-notification-guard.js';

const ownership = vi.hoisted(() => ({ verify: vi.fn() }));
const herdr = vi.hoisted(() => ({ workspaceExists: vi.fn() }));

vi.mock('../../team/tmux-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../team/tmux-session.js')>();
  return { ...actual, verifyTeamTargetOwnership: ownership.verify };
});

vi.mock('../../team/herdr-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../team/herdr-session.js')>();
  return { ...actual, herdrWorkspaceExists: herdr.workspaceExists };
});

const { teamResumeByName } = await import('../team.js');

const INSTANCE_ID = '11111111-2222-3333-4444-555555555555';
const TMUX_IDENTITY = { socket_path: '/tmp/omc-team-resume.sock', server_pid: 12345, process_started_at: 'server-start-a' };

function v2Config(overrides: Partial<TeamConfig> = {}): TeamConfig {
  return {
    name: 'demo',
    task: 'demo',
    agent_type: 'claude',
    worker_launch_mode: 'interactive',
    worker_count: 1,
    max_workers: 20,
    workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: 'surface:2' }],
    created_at: '2026-11-03T00:00:00.000Z',
    tmux_session: 'cmux:workspace:1',
    next_task_id: 1,
    leader_pane_id: 'surface:1',
    hud_pane_id: null,
    resize_hook_name: null,
    resize_hook_target: null,
    instance_id: INSTANCE_ID,
    ...overrides,
  };
}

const tmuxConfig = (overrides: Partial<TeamConfig> = {}) => v2Config({
  tmux_session: 'omc-team-demo:0',
  leader_pane_id: '%1',
  workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: '%2' }],
  tmux_server_identity: TMUX_IDENTITY,
  ...overrides,
});

describe('omc team resume on a runtime v2 team', () => {
  let cwd: string;
  let savedFlag: string | undefined;

  function writeConfig(config: TeamConfig): void {
    const configPath = absPath(cwd, TeamPaths.config('demo'));
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config));
  }

  beforeEach(() => {
    savedFlag = process.env.OMC_RUNTIME_V2;
    delete process.env.OMC_RUNTIME_V2;
    ownership.verify.mockReset().mockResolvedValue({ kind: 'unavailable' });
    herdr.workspaceExists.mockReset().mockResolvedValue('missing');
    cwd = mkdtempSync(join(tmpdir(), 'omc-team-resume-'));
    writeConfig(v2Config());
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.OMC_RUNTIME_V2;
    else process.env.OMC_RUNTIME_V2 = savedFlag;
    rmSync(cwd, { recursive: true, force: true });
  });

  it('resumes from the config that runtime v2 persists while the leader is still owned', async () => {
    ownership.verify.mockResolvedValue({ kind: 'owned' });

    expect(await teamResumeByName('demo', cwd)).toMatchObject({
      teamName: 'demo',
      resumed: true,
      instanceId: INSTANCE_ID,
      sessionName: 'cmux:workspace:1',
      leaderPaneId: 'surface:1',
      workerPaneIds: ['surface:2'],
    });
  });

  it('does not resume a cmux team whose workspace is gone', async () => {
    expect(await teamResumeByName('demo', cwd)).toMatchObject({ teamName: 'demo', resumed: false });
  });

  it.each(['starting', 'shutting_down', 'stopped'] as const)(
    'does not resume a %s team even while its leader pane is still owned',
    async (lifecycle_state) => {
      ownership.verify.mockResolvedValue({ kind: 'owned' });
      writeConfig(v2Config({ lifecycle_state }));

      expect(await teamResumeByName('demo', cwd)).toMatchObject({ teamName: 'demo', resumed: false });
    },
  );

  describe('tmux team', () => {
    beforeEach(() => {
      ownership.verify.mockImplementation(async (target: MailboxNotificationTarget) => (
        target.provider === 'tmux' && isDeepStrictEqual(target.tmuxServerIdentity, TMUX_IDENTITY)
          ? { kind: 'owned' }
          : { kind: 'unavailable' }
      ));
    });

    it('resumes while the leader pane belongs to the persisted tmux server', async () => {
      writeConfig(tmuxConfig());

      expect(await teamResumeByName('demo', cwd)).toMatchObject({
        resumed: true,
        sessionName: 'omc-team-demo:0',
        leaderPaneId: '%1',
        workerPaneIds: ['%2'],
      });
    });

    it('does not resume when the config has no tmux server identity', async () => {
      writeConfig(tmuxConfig({ tmux_server_identity: undefined }));

      expect(await teamResumeByName('demo', cwd)).toMatchObject({ resumed: false });
    });
  });

  describe('herdr team', () => {
    const HERDR_SESSION = 'herdr:workspace:abc123';
    const herdrConfig = (overrides: Partial<TeamConfig> = {}) => v2Config({
      tmux_session: HERDR_SESSION,
      leader_pane_id: 'w1:p1',
      workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [], pane_id: 'w1:p2' }],
      ...overrides,
    });

    beforeEach(() => {
      herdr.workspaceExists.mockReset().mockResolvedValue('missing');
    });

    it('resumes when the Herdr workspace exists', async () => {
      herdr.workspaceExists.mockResolvedValue('exists');
      writeConfig(herdrConfig());

      expect(await teamResumeByName('demo', cwd)).toMatchObject({
        resumed: true,
        sessionName: HERDR_SESSION,
        leaderPaneId: 'w1:p1',
        workerPaneIds: ['w1:p2'],
      });
    });

    it('does not resume when the Herdr workspace is missing', async () => {
      herdr.workspaceExists.mockResolvedValue('missing');
      writeConfig(herdrConfig());

      expect(await teamResumeByName('demo', cwd)).toMatchObject({ teamName: 'demo', resumed: false });
    });

    it('does not resume when the Herdr workspace query fails', async () => {
      herdr.workspaceExists.mockRejectedValue(new Error('provider query failed'));
      writeConfig(herdrConfig());

      expect(await teamResumeByName('demo', cwd)).toMatchObject({ teamName: 'demo', resumed: false });
    });

    it('resumes with an external leader (no leader_pane_id check required)', async () => {
      herdr.workspaceExists.mockResolvedValue('exists');
      writeConfig(herdrConfig({ leader_pane_id: undefined }));

      expect(await teamResumeByName('demo', cwd)).toMatchObject({
        resumed: true,
        sessionName: HERDR_SESSION,
      });
    });
  });

  it('reports a missing team as not resumable', async () => {
    expect(await teamResumeByName('absent', cwd)).toMatchObject({ teamName: 'absent', resumed: false });
  });
});
