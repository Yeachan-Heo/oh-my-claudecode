import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readMissionBoardState,
  recordMissionAgentStart,
  recordMissionAgentStop,
  refreshMissionBoardState,
} from '../../hud/mission-board.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-mission-board-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, '.omc', 'state'), { recursive: true });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('mission board state tracking', () => {
  it('records session-scoped agent starts and completions', () => {
    const cwd = makeTempDir();

    recordMissionAgentStart(cwd, {
      sessionId: 'sess-1234',
      agentId: 'agent-1',
      agentType: 'oh-my-claudecode:executor',
      parentMode: 'ultrawork',
      taskDescription: 'Implement mission board renderer',
      at: '2026-03-09T07:00:00.000Z',
    });
    recordMissionAgentStop(cwd, {
      sessionId: 'sess-1234',
      agentId: 'agent-1',
      success: true,
      outputSummary: 'Rendered mission and timeline lines',
      at: '2026-03-09T07:05:00.000Z',
    });

    const state = readMissionBoardState(cwd);
    expect(state).not.toBeNull();
    expect(state?.missions).toHaveLength(1);

    const mission = state!.missions[0]!;
    expect(mission.source).toBe('session');
    expect(mission.name).toBe('ultrawork');
    expect(mission.status).toBe('done');
    expect(mission.taskCounts.completed).toBe(1);
    expect(mission.agents[0]?.status).toBe('done');
    expect(mission.agents[0]?.completedSummary).toContain('Rendered mission');
    expect(mission.timeline.map((entry) => entry.kind)).toEqual(['update', 'completion']);
  });

  it('syncs team missions from existing team state files and preserves session missions', () => {
    const cwd = makeTempDir();

    recordMissionAgentStart(cwd, {
      sessionId: 'sess-merge',
      agentId: 'agent-9',
      agentType: 'oh-my-claudecode:architect',
      parentMode: 'ralph',
      taskDescription: 'Review mission board architecture',
      at: '2026-03-09T07:00:00.000Z',
    });

    const teamRoot = join(cwd, '.omc', 'state', 'team', 'demo');
    mkdirSync(join(teamRoot, 'tasks'), { recursive: true });
    mkdirSync(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
    mkdirSync(join(teamRoot, 'workers', 'worker-2'), { recursive: true });
    mkdirSync(join(teamRoot, 'mailbox'), { recursive: true });

    writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
      name: 'demo',
      task: 'Implement mission board',
      created_at: '2026-03-09T06:55:00.000Z',
      worker_count: 2,
      workers: [
        { name: 'worker-1', role: 'executor', assigned_tasks: ['1'] },
        { name: 'worker-2', role: 'test-engineer', assigned_tasks: ['2'] },
      ],
    }, null, 2));

    writeFileSync(join(teamRoot, 'tasks', '1.json'), JSON.stringify({
      id: '1',
      subject: 'Implement renderer',
      status: 'in_progress',
      owner: 'worker-1',
    }, null, 2));
    writeFileSync(join(teamRoot, 'tasks', '2.json'), JSON.stringify({
      id: '2',
      subject: 'Add tests',
      status: 'completed',
      owner: 'worker-2',
      completed_at: '2026-03-09T07:03:00.000Z',
      result: 'Added mission board tests',
    }, null, 2));

    writeFileSync(join(teamRoot, 'workers', 'worker-1', 'status.json'), JSON.stringify({
      state: 'working',
      current_task_id: '1',
      updated_at: '2026-03-09T07:04:00.000Z',
      reason: 'implementing renderer',
    }, null, 2));
    writeFileSync(join(teamRoot, 'workers', 'worker-1', 'heartbeat.json'), JSON.stringify({
      last_turn_at: '2026-03-09T07:04:30.000Z',
      alive: true,
    }, null, 2));
    writeFileSync(join(teamRoot, 'workers', 'worker-2', 'status.json'), JSON.stringify({
      state: 'done',
      updated_at: '2026-03-09T07:03:30.000Z',
    }, null, 2));

    writeFileSync(join(teamRoot, 'events.jsonl'), [
      JSON.stringify({ type: 'task_completed', worker: 'worker-2', task_id: '2', created_at: '2026-03-09T07:03:00.000Z' }),
      JSON.stringify({ type: 'team_leader_nudge', worker: 'worker-1', reason: 'continue working', created_at: '2026-03-09T07:04:00.000Z' }),
    ].join('\n'));

    writeFileSync(join(teamRoot, 'mailbox', 'worker-1.json'), JSON.stringify({
      messages: [
        {
          message_id: 'm1',
          from_worker: 'leader-fixed',
          to_worker: 'worker-1',
          body: 'Take task 1',
          created_at: '2026-03-09T07:01:00.000Z',
        },
      ],
    }, null, 2));

    const state = refreshMissionBoardState(cwd, {
      enabled: true,
      maxMissions: 5,
      maxAgentsPerMission: 5,
      maxTimelineEvents: 5,
      persistCompletedForMinutes: 30,
    });

    expect(state.missions).toHaveLength(2);

    const teamMission = state.missions.find((mission) => mission.source === 'team');
    expect(teamMission?.name).toBe('demo');
    expect(teamMission?.status).toBe('running');
    expect(teamMission?.taskCounts.inProgress).toBe(1);
    expect(teamMission?.agents[0]?.currentStep).toContain('implementing renderer');
    expect(teamMission?.agents[1]?.completedSummary).toContain('Added mission board tests');
    expect(teamMission?.timeline.some((entry) => entry.kind === 'handoff')).toBe(true);
    expect(teamMission?.timeline.some((entry) => entry.kind === 'completion')).toBe(true);

    const persisted = JSON.parse(readFileSync(join(cwd, '.omc', 'state', 'mission-state.json'), 'utf-8')) as {
      missions: Array<{ source: string }>;
    };
    expect(persisted.missions.some((mission) => mission.source === 'session')).toBe(true);
    expect(persisted.missions.some((mission) => mission.source === 'team')).toBe(true);
  });

  it('marks team missions blocked when failures or blocked workers are present', () => {
    const cwd = makeTempDir();
    const teamRoot = join(cwd, '.omc', 'state', 'team', 'blocked-demo');
    mkdirSync(join(teamRoot, 'tasks'), { recursive: true });
    mkdirSync(join(teamRoot, 'workers', 'worker-1'), { recursive: true });

    writeFileSync(join(teamRoot, 'config.json'), JSON.stringify({
      name: 'blocked-demo',
      task: 'Wait for approval',
      created_at: '2026-03-09T08:00:00.000Z',
      worker_count: 1,
      workers: [{ name: 'worker-1', role: 'executor', assigned_tasks: ['1'] }],
    }, null, 2));

    writeFileSync(join(teamRoot, 'tasks', '1.json'), JSON.stringify({
      id: '1',
      subject: 'Wait for approval',
      status: 'failed',
      owner: 'worker-1',
      error: 'approval required',
    }, null, 2));

    writeFileSync(join(teamRoot, 'workers', 'worker-1', 'status.json'), JSON.stringify({
      state: 'blocked',
      current_task_id: '1',
      reason: 'waiting for approval',
      updated_at: '2026-03-09T08:05:00.000Z',
    }, null, 2));

    const state = refreshMissionBoardState(cwd);
    const mission = state.missions.find((entry) => entry.source === 'team');

    expect(mission?.status).toBe('blocked');
    expect(mission?.agents[0]?.status).toBe('blocked');
    expect(mission?.agents[0]?.latestUpdate).toContain('waiting for approval');
  });
});
