import { afterEach, describe, expect, it } from 'vitest';
import {
  readPrdStateForHud,
  readRalphStateForHud,
  readAutopilotStateForHud,
  isAnyModeActive,
  getActiveSkills,
} from '../../hud/omc-state.js';
import { getStoryGoverningCriteriaRevision } from '../../hooks/ralph/prd.js';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function writeJson(path: string, data: unknown, mtimeMs = Date.now()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
  const time = new Date(mtimeMs);
  utimesSync(path, time, time);
}

describe('hud omc state session scoping', () => {
  const tempDirs: string[] = [];
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    delete process.env.OMC_STATE_DIR;
  });

  function createWorktree(): string {
    const dir = mkdtempSync(join(homedir(), 'omc-hud-state-'));
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
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
    }, Date.now() + 1000);

    expect(isAnyModeActive(worktree)).toBe(true);
    expect(isAnyModeActive(worktree, 'session-a')).toBe(false);
    expect(isAnyModeActive(worktree, 'session-b')).toBe(true);
    expect(getActiveSkills(worktree, 'session-a')).toEqual([]);
    expect(getActiveSkills(worktree, 'session-b')).toEqual(['ralph']);
  });

  it('ignores an active legacy Ultrawork file for HUD mode state', () => {
    const worktree = createWorktree();
    writeJson(join(worktree, '.omc', 'state', 'ultrawork-state.json'), {
      active: true,
      reinforcement_count: 7,
    });

    expect(isAnyModeActive(worktree)).toBe(false);
    expect(getActiveSkills(worktree)).toEqual([]);
  });

  describe('readPrdStateForHud completion definition', () => {
    function writePrd(worktree: string, stories: unknown[]): void {
      writeJson(join(worktree, '.omc', 'prd.json'), {
        project: 'hud-prd',
        branchName: 'main',
        description: 'hud prd fixture',
        userStories: stories,
      });
    }

    function ralphStory(id: string, priority: number, options: { passes: boolean; architectVerified?: boolean }) {
      const acceptanceCriteria = [`${id} accepts its result`];
      const revision = getStoryGoverningCriteriaRevision({ acceptanceCriteria, criterionAmendments: undefined });
      return {
        id,
        title: id,
        description: 'story',
        acceptanceCriteria,
        priority,
        passes: options.passes,
        ...(options.passes ? { completionCriteriaRevision: revision } : {}),
        ...(options.passes && options.architectVerified === true
          ? { architectVerified: true, architectVerificationCriteriaRevision: revision }
          : {}),
      };
    }

    it('counts only revision-bound, architect-approved stories as complete', () => {
      const worktree = createWorktree();
      writePrd(worktree, [
        ralphStory('US-1', 1, { passes: true, architectVerified: true }),
        ralphStory('US-2', 2, { passes: true }),
      ]);

      expect(readPrdStateForHud(worktree)).toEqual({
        currentStoryId: 'US-2',
        completed: 1,
        total: 2,
      });
    });

    it('does not report a run as finished while every story awaits approval', () => {
      // Regression: counting bare `passes` showed 2/2 done while the loop was
      // still blocked on reviewer sign-off.
      const worktree = createWorktree();
      writePrd(worktree, [
        ralphStory('US-1', 1, { passes: true }),
        ralphStory('US-2', 2, { passes: true }),
      ]);

      expect(readPrdStateForHud(worktree)).toMatchObject({ completed: 0, total: 2, currentStoryId: 'US-1' });
    });

    it('still renders a PRD the Ralph schema rejects, but never counts an unverified story', () => {
      const worktree = createWorktree();
      writePrd(worktree, [
        { id: 'task-1', passes: true, priority: 1, architectVerified: false },
        { id: 'task-2', passes: false, priority: 2 },
      ]);

      expect(readPrdStateForHud(worktree)).toEqual({
        currentStoryId: 'task-1',
        completed: 0,
        total: 2,
      });
    });
  });
});
