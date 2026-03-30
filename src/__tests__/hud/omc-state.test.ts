import { afterEach, describe, expect, it } from 'vitest';
import {
  readRalphStateForHud,
  readUltraworkStateForHud,
  readAutopilotStateForHud,
  isAnyModeActive,
  getActiveSkills,
} from '../../hud/omc-state.js';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

function writeJson(path: string, data: unknown, mtimeMs = Date.now()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
  const time = new Date(mtimeMs);
  utimesSync(path, time, time);
}

describe('hud omc state session scoping', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
    delete process.env.OMC_STATE_DIR;
  });

  function createWorktree(): string {
    const dir = mkdtempSync(join(tmpdir(), 'omc-hud-state-'));
    tempDirs.push(dir);
    return dir;
  }

  it('keeps backward-compatible newest-session fallback when sessionId is omitted', () => {
    const worktree = createWorktree();
    const omcRoot = join(worktree, '.omc');
    const older = Date.now() - 60_000;
    const newer = Date.now();

    writeJson(join(omcRoot, 'state', 'sessions', 'session-a', 'ralph-state.json'), {
      active: true,
      iteration: 1,
      max_iterations: 5,
      current_story_id: 'story-a',
    }, older);
    writeJson(join(omcRoot, 'state', 'sessions', 'session-b', 'ralph-state.json'), {
      active: true,
      iteration: 4,
      max_iterations: 7,
      current_story_id: 'story-b',
    }, newer);

    expect(readRalphStateForHud(worktree)).toMatchObject({
      active: true,
      iteration: 4,
      maxIterations: 7,
      currentStoryId: 'story-b',
    });
  });

  it('reads only the requested session state when sessionId is provided', () => {
    const worktree = createWorktree();
    const omcRoot = join(worktree, '.omc');
    const older = Date.now() - 60_000;
    const newer = Date.now();

    writeJson(join(omcRoot, 'state', 'sessions', 'session-a', 'ralph-state.json'), {
      active: true,
      iteration: 2,
      max_iterations: 5,
      current_story_id: 'story-a',
    }, older);
    writeJson(join(omcRoot, 'state', 'sessions', 'session-b', 'ralph-state.json'), {
      active: true,
      iteration: 9,
      max_iterations: 9,
      current_story_id: 'story-b',
    }, newer);

    expect(readRalphStateForHud(worktree, 'session-a')).toMatchObject({
      active: true,
      iteration: 2,
      maxIterations: 5,
      currentStoryId: 'story-a',
    });
  });

  it('does not leak to other sessions or fallback files when a session-scoped file is missing', () => {
    const worktree = createWorktree();
    const omcRoot = join(worktree, '.omc');

    writeJson(join(omcRoot, 'state', 'sessions', 'session-b', 'autopilot-state.json'), {
      active: true,
      phase: 'execution',
      iteration: 3,
      max_iterations: 10,
      execution: { tasks_completed: 2, tasks_total: 4, files_created: ['a.ts'] },
    });
    writeJson(join(omcRoot, 'state', 'autopilot-state.json'), {
      active: true,
      phase: 'qa',
      iteration: 8,
      max_iterations: 10,
      execution: { tasks_completed: 4, tasks_total: 4, files_created: ['b.ts', 'c.ts'] },
    });

    expect(readAutopilotStateForHud(worktree, 'session-a')).toBeNull();
  });


  it('reads current_phase when phase is missing for autopilot HUD state', () => {
    const worktree = createWorktree();
    const omcRoot = join(worktree, '.omc');

    writeJson(join(omcRoot, 'state', 'autopilot-state.json'), {
      active: true,
      current_phase: 'execution',
      iteration: 3,
      max_iterations: 10,
      execution: { tasks_completed: 2, tasks_total: 4, files_created: ['a.ts'] },
    });

    expect(readAutopilotStateForHud(worktree)).toMatchObject({
      active: true,
      phase: 'execution',
      iteration: 3,
      maxIterations: 10,
      tasksCompleted: 2,
      tasksTotal: 4,
      filesCreated: 1,
    });
  });

  it('applies session scoping to combined mode helpers', () => {
    const worktree = createWorktree();
    const omcRoot = join(worktree, '.omc');

    writeJson(join(omcRoot, 'state', 'sessions', 'session-a', 'ralph-state.json'), {
      active: false,
      iteration: 1,
      max_iterations: 5,
      current_story_id: 'story-a',
    });
    writeJson(join(omcRoot, 'state', 'sessions', 'session-b', 'ralph-state.json'), {
      active: true,
      iteration: 3,
      max_iterations: 8,
      current_story_id: 'story-b',
    });
    writeJson(join(omcRoot, 'state', 'sessions', 'session-b', 'ultrawork-state.json'), {
      active: true,
      reinforcement_count: 7,
    });

    expect(isAnyModeActive(worktree)).toBe(true);
    expect(isAnyModeActive(worktree, 'session-a')).toBe(false);
    expect(isAnyModeActive(worktree, 'session-b')).toBe(true);
    expect(getActiveSkills(worktree, 'session-a')).toEqual([]);
    expect(getActiveSkills(worktree, 'session-b')).toEqual(['ralph', 'ultrawork']);
    expect(readUltraworkStateForHud(worktree, 'session-b')).toMatchObject({
      active: true,
      reinforcementCount: 7,
    });
  });
});
