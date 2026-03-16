import { describe, expect, it } from 'vitest';
import { renderMissionBoard } from '../../hud/elements/mission-board.js';
import { render } from '../../hud/render.js';
import { DEFAULT_HUD_CONFIG, type HudConfig, type HudRenderContext } from '../../hud/types.js';
import type { MissionBoardState } from '../../hud/mission-board.js';

function createMissionState(): MissionBoardState {
  return {
    updatedAt: '2026-03-09T07:12:00.000Z',
    missions: [
      {
        id: 'team:demo',
        source: 'team',
        teamName: 'demo',
        name: 'demo',
        objective: 'Implement mission board',
        createdAt: '2026-03-09T07:00:00.000Z',
        updatedAt: '2026-03-09T07:12:00.000Z',
        status: 'running',
        workerCount: 2,
        taskCounts: { total: 2, pending: 0, blocked: 0, inProgress: 1, completed: 1, failed: 0 },
        agents: [
          {
            name: 'worker-1',
            role: 'executor',
            ownership: '#1',
            status: 'running',
            currentStep: '#1 Implement renderer',
            latestUpdate: 'editing mission-board.ts',
            completedSummary: null,
            updatedAt: '2026-03-09T07:11:00.000Z',
          },
          {
            name: 'worker-2',
            role: 'test-engineer',
            ownership: '#2',
            status: 'done',
            currentStep: null,
            latestUpdate: 'Added mission board tests',
            completedSummary: 'Added mission board tests',
            updatedAt: '2026-03-09T07:10:00.000Z',
          },
        ],
        timeline: [
          {
            id: 'handoff-1',
            at: '2026-03-09T07:05:00.000Z',
            kind: 'handoff',
            agent: 'worker-1',
            detail: 'picked up task 1 (Implement renderer)',
            sourceKey: 'handoff:1',
          },
          {
            id: 'completion-2',
            at: '2026-03-09T07:10:00.000Z',
            kind: 'completion',
            agent: 'worker-2',
            detail: 'completed task 2',
            sourceKey: 'completion:2',
          },
        ],
      },
    ],
  };
}

describe('mission board renderer', () => {
  it('renders mission, agent, and timeline lines', () => {
    const lines = renderMissionBoard(createMissionState(), {
      enabled: true,
      maxMissions: 2,
      maxAgentsPerMission: 3,
      maxTimelineEvents: 3,
      persistCompletedForMinutes: 20,
    });

    expect(lines[0]).toContain('MISSION demo [running]');
    expect(lines[1]).toContain('[run] worker-1 (executor)');
    expect(lines[2]).toContain('[done] worker-2 (test-engineer)');
    expect(lines[3]).toContain('timeline: 07:05 handoff worker-1');
  });

  it('inserts the mission board above existing HUD detail lines when enabled', async () => {
    const context: HudRenderContext = {
      contextPercent: 20,
      modelName: 'claude-sonnet',
      ralph: null,
      ultrawork: null,
      prd: null,
      autopilot: null,
      activeAgents: [],
      todos: [{ content: 'keep shipping', status: 'in_progress' }],
      backgroundTasks: [],
      cwd: '/tmp/project',
      missionBoard: createMissionState(),
      lastSkill: null,
      rateLimitsResult: null,
      customBuckets: null,
      pendingPermission: null,
      thinkingState: null,
      sessionHealth: null,
      omcVersion: '4.7.8',
      updateAvailable: null,
      toolCallCount: 0,
      agentCallCount: 0,
      skillCallCount: 0,
      promptTime: null,
      apiKeySource: null,
      profileName: null,
    sessionSummary: null,
    };

    const config: HudConfig = {
      ...DEFAULT_HUD_CONFIG,
      missionBoard: {
        enabled: true,
        maxMissions: 2,
        maxAgentsPerMission: 3,
        maxTimelineEvents: 3,
        persistCompletedForMinutes: 20,
      },
      elements: {
        ...DEFAULT_HUD_CONFIG.elements,
        omcLabel: true,
        missionBoard: true,
        rateLimits: false,
        ralph: false,
        autopilot: false,
        prdStory: false,
        activeSkills: false,
        contextBar: false,
        agents: false,
        backgroundTasks: false,
        sessionHealth: false,
        promptTime: false,
        todos: true,
        maxOutputLines: 12,
      },
    };

    const output = await render(context, config);
    const lines = output.split('\n');

    expect(lines[0]).toContain('[OMC#4.7.8]');
    expect(lines[1]).toContain('MISSION demo [running]');
    expect(lines[2]).toContain('[run] worker-1');
    expect(lines[4]).toContain('timeline: 07:05 handoff worker-1');
    expect(lines[5]).toContain('todos:');
    expect(lines[5]).toContain('keep shipping');
  });
});
