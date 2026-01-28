import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isRalphFreshActive,
  isStandardRalphActive,
  DEFAULT_FRESH_CONFIG,
  type RalphFreshHandoff,
  type RalphFreshConfig,
  type RalphFreshPrd,
  type RalphFreshProgress,
  type RalphFreshGit,
  type RalphFreshStuckDetection,
  type RalphFreshError
} from '../fresh.js';

describe('RalphFresh Types and Helpers', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ralph-fresh-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('DEFAULT_FRESH_CONFIG', () => {
    it('should have correct default values', () => {
      expect(DEFAULT_FRESH_CONFIG.maxIterations).toBe(20);
      expect(DEFAULT_FRESH_CONFIG.maxTurnsPerIteration).toBe(100);
      expect(DEFAULT_FRESH_CONFIG.completionPromise).toBe('TASK_COMPLETE');
      expect(DEFAULT_FRESH_CONFIG.workingDir).toBe(process.cwd());
      expect(DEFAULT_FRESH_CONFIG.verbose).toBe(false);
      expect(DEFAULT_FRESH_CONFIG.retryAttempts).toBe(3);
      expect(DEFAULT_FRESH_CONFIG.retryDelayMs).toBe(5000);
      expect(DEFAULT_FRESH_CONFIG.stuckThreshold).toBe(3);
    });
  });

  describe('RalphFreshHandoff interface', () => {
    it('should be a valid handoff object structure', () => {
      const handoff: RalphFreshHandoff = {
        version: '1.0',
        created_at: new Date().toISOString(),
        iteration: 1,
        max_iterations: 20,
        original_prompt: 'Build a feature',
        completion_promise: 'TASK_COMPLETE',
        completed: false,
        progress: {
          patterns: [],
          recentLearnings: []
        },
        git: {
          recentCommits: [],
          branch: 'main',
          hasUncommittedChanges: false
        },
        stuckDetection: {
          lastPrdStatus: [],
          iterationsOnSameStory: 0
        }
      };

      expect(handoff.version).toBe('1.0');
      expect(handoff.iteration).toBe(1);
      expect(handoff.completed).toBe(false);
    });

    it('should support optional fields', () => {
      const handoff: RalphFreshHandoff = {
        version: '1.0',
        created_at: new Date().toISOString(),
        iteration: 5,
        max_iterations: 20,
        original_prompt: 'Complete task',
        completion_promise: 'DONE',
        completed: true,
        completion_message: 'All work done',
        prd: {
          project: 'my-project',
          branchName: 'feature/new-stuff',
          description: 'New feature',
          storiesTotal: 10,
          storiesCompleted: 10,
          nextStoryId: null,
          incompleteIds: []
        },
        progress: {
          patterns: ['pattern1'],
          recentLearnings: ['learning1'],
          lastCompletedStory: 'S001'
        },
        git: {
          recentCommits: [
            { hash: 'abc123', message: 'fix: something' }
          ],
          branch: 'feature/test',
          hasUncommittedChanges: true
        },
        stuckDetection: {
          lastPrdStatus: ['S001', 'S002'],
          iterationsOnSameStory: 2,
          lastActionAttempted: 'implement feature'
        },
        lastError: {
          iteration: 3,
          message: 'Build failed',
          recoveryAttempt: 'Fixed dependencies'
        }
      };

      expect(handoff.completed).toBe(true);
      expect(handoff.completion_message).toBe('All work done');
      expect(handoff.prd?.storiesCompleted).toBe(10);
      expect(handoff.lastError?.message).toBe('Build failed');
    });
  });

  describe('Sub-interface types', () => {
    it('should support RalphFreshPrd type', () => {
      const prd: RalphFreshPrd = {
        project: 'test-project',
        branchName: 'feature/branch',
        description: 'Test description',
        storiesTotal: 5,
        storiesCompleted: 2,
        nextStoryId: 'S003',
        incompleteIds: ['S003', 'S004', 'S005']
      };

      expect(prd.storiesTotal).toBe(5);
      expect(prd.nextStoryId).toBe('S003');
    });

    it('should support RalphFreshProgress type', () => {
      const progress: RalphFreshProgress = {
        patterns: ['use TypeScript', 'follow ESM'],
        recentLearnings: ['learned pattern A', 'discovered issue B'],
        lastCompletedStory: 'S002'
      };

      expect(progress.patterns.length).toBe(2);
      expect(progress.lastCompletedStory).toBe('S002');
    });

    it('should support RalphFreshGit type', () => {
      const git: RalphFreshGit = {
        recentCommits: [
          { hash: 'abc123', message: 'feat: add feature' },
          { hash: 'def456', message: 'fix: bug fix' }
        ],
        branch: 'main',
        hasUncommittedChanges: false
      };

      expect(git.recentCommits.length).toBe(2);
      expect(git.branch).toBe('main');
    });

    it('should support RalphFreshStuckDetection type', () => {
      const stuck: RalphFreshStuckDetection = {
        lastPrdStatus: ['S001'],
        iterationsOnSameStory: 3,
        lastActionAttempted: 'running tests'
      };

      expect(stuck.iterationsOnSameStory).toBe(3);
      expect(stuck.lastActionAttempted).toBe('running tests');
    });

    it('should support RalphFreshError type', () => {
      const error: RalphFreshError = {
        iteration: 5,
        message: 'Network timeout',
        recoveryAttempt: 'Retried with backoff'
      };

      expect(error.iteration).toBe(5);
      expect(error.recoveryAttempt).toBe('Retried with backoff');
    });
  });

  describe('isRalphFreshActive', () => {
    it('should return false when no state file exists', () => {
      const active = isRalphFreshActive(testDir);
      expect(active).toBe(false);
    });

    it('should return true when state file exists with active=true', () => {
      const omcDir = join(testDir, '.omc');
      const stateDir = join(omcDir, 'state');
      mkdirSync(stateDir, { recursive: true });

      const stateFile = join(stateDir, 'ralph-fresh-state.json');
      const state = {
        active: true,
        iteration: 1
      };
      writeFileSync(stateFile, JSON.stringify(state));

      const active = isRalphFreshActive(testDir);
      expect(active).toBe(true);
    });

    it('should return false when state file exists but active=false', () => {
      const omcDir = join(testDir, '.omc');
      const stateDir = join(omcDir, 'state');
      mkdirSync(stateDir, { recursive: true });

      const stateFile = join(stateDir, 'ralph-fresh-state.json');
      const state = {
        active: false,
        iteration: 1
      };
      writeFileSync(stateFile, JSON.stringify(state));

      const active = isRalphFreshActive(testDir);
      expect(active).toBe(false);
    });

    it('should return false when state file is corrupted', () => {
      const omcDir = join(testDir, '.omc');
      const stateDir = join(omcDir, 'state');
      mkdirSync(stateDir, { recursive: true });

      const stateFile = join(stateDir, 'ralph-fresh-state.json');
      writeFileSync(stateFile, 'invalid json{');

      const active = isRalphFreshActive(testDir);
      expect(active).toBe(false);
    });
  });

  describe('isStandardRalphActive', () => {
    it('should return false when no state file exists', () => {
      const active = isStandardRalphActive(testDir);
      expect(active).toBe(false);
    });

    it('should return true when standard ralph state exists with active=true', () => {
      const omcDir = join(testDir, '.omc');
      const stateDir = join(omcDir, 'state');
      mkdirSync(stateDir, { recursive: true });

      const stateFile = join(stateDir, 'ralph-state.json');
      const state = {
        active: true,
        iteration: 1
      };
      writeFileSync(stateFile, JSON.stringify(state));

      const active = isStandardRalphActive(testDir);
      expect(active).toBe(true);
    });

    it('should return false when standard ralph state exists but active=false', () => {
      const omcDir = join(testDir, '.omc');
      const stateDir = join(omcDir, 'state');
      mkdirSync(stateDir, { recursive: true });

      const stateFile = join(stateDir, 'ralph-state.json');
      const state = {
        active: false,
        iteration: 1
      };
      writeFileSync(stateFile, JSON.stringify(state));

      const active = isStandardRalphActive(testDir);
      expect(active).toBe(false);
    });

    it('should return false when state file is corrupted', () => {
      const omcDir = join(testDir, '.omc');
      const stateDir = join(omcDir, 'state');
      mkdirSync(stateDir, { recursive: true });

      const stateFile = join(stateDir, 'ralph-state.json');
      writeFileSync(stateFile, 'corrupted{');

      const active = isStandardRalphActive(testDir);
      expect(active).toBe(false);
    });
  });

  describe('mutex behavior', () => {
    it('should detect both ralph variants independently', () => {
      const omcDir = join(testDir, '.omc');
      const stateDir = join(omcDir, 'state');
      mkdirSync(stateDir, { recursive: true });

      // Initially both false
      expect(isRalphFreshActive(testDir)).toBe(false);
      expect(isStandardRalphActive(testDir)).toBe(false);

      // Activate fresh-context ralph
      const freshFile = join(stateDir, 'ralph-fresh-state.json');
      writeFileSync(freshFile, JSON.stringify({ active: true }));
      expect(isRalphFreshActive(testDir)).toBe(true);
      expect(isStandardRalphActive(testDir)).toBe(false);

      // Activate standard ralph
      const standardFile = join(stateDir, 'ralph-state.json');
      writeFileSync(standardFile, JSON.stringify({ active: true }));
      expect(isRalphFreshActive(testDir)).toBe(true);
      expect(isStandardRalphActive(testDir)).toBe(true);
    });
  });
});
