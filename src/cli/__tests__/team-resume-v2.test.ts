import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { absPath, TeamPaths } from '../../team/state-paths.js';
import type { TeamConfig } from '../../team/types.js';

const ownership = vi.hoisted(() => ({ verify: vi.fn() }));

vi.mock('../../team/tmux-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../team/tmux-session.js')>();
  return { ...actual, verifyTeamTargetOwnership: ownership.verify };
});

const { teamResumeByName } = await import('../team.js');

const INSTANCE_ID = '11111111-2222-3333-4444-555555555555';

function v2Config(teamName: string): TeamConfig {
  return {
    name: teamName,
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
  };
}

describe('omc team resume on a runtime v2 team', () => {
  let cwd: string;
  let savedFlag: string | undefined;

  beforeEach(() => {
    savedFlag = process.env.OMC_RUNTIME_V2;
    delete process.env.OMC_RUNTIME_V2;
    ownership.verify.mockReset().mockResolvedValue({ kind: 'unavailable' });
    cwd =mkdtempSync(join(tmpdir(), 'omc-team-resume-'));
    const configPath = absPath(cwd, TeamPaths.config('demo'));
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(v2Config('demo')));
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

  it('reports a missing team as not resumable', async () => {
    expect(await teamResumeByName('absent', cwd)).toMatchObject({ teamName: 'absent', resumed: false });
  });
});
