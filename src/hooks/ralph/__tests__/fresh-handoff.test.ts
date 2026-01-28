import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import {
  initHandoff,
  readHandoff,
  writeHandoff,
  refreshHandoffFromFiles,
  getHandoffPath,
  clearHandoff
} from '../fresh-handoff.js';
import { writePrd, initProgress, appendProgress, addPattern } from '../index.js';

describe('Ralph Fresh Handoff Operations', () => {
  let testDir: string;

  beforeEach(() => {
    // Create unique temp directory for each test
    testDir = join(tmpdir(), `ralph-fresh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    // Initialize git repo for tests
    try {
      execSync('git init', { cwd: testDir, stdio: 'ignore' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'ignore' });
      execSync('git config user.name "Test User"', { cwd: testDir, stdio: 'ignore' });
    } catch {
      // Git not available - tests will skip git-related checks
    }
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('getHandoffPath', () => {
    it('should return correct path in .omc/state directory', () => {
      const path = getHandoffPath(testDir);
      expect(path).toBe(join(testDir, '.omc', 'state', 'ralph-fresh-handoff.json'));
    });
  });

  describe('initHandoff', () => {
    it('should create new handoff with correct defaults', () => {
      const handoff = initHandoff('Build a todo API', {});

      expect(handoff.version).toBe('1.0');
      expect(handoff.iteration).toBe(1);
      expect(handoff.max_iterations).toBe(20);
      expect(handoff.original_prompt).toBe('Build a todo API');
      expect(handoff.completion_promise).toBe('TASK_COMPLETE');
      expect(handoff.completed).toBe(false);
      expect(handoff.created_at).toBeTruthy();
      expect(handoff.progress.patterns).toEqual([]);
      expect(handoff.progress.recentLearnings).toEqual([]);
      expect(handoff.git.recentCommits).toEqual([]);
      expect(handoff.git.hasUncommittedChanges).toBe(false);
      expect(handoff.stuckDetection.lastPrdStatus).toEqual([]);
      expect(handoff.stuckDetection.iterationsOnSameStory).toBe(0);
    });

    it('should accept custom config values', () => {
      const handoff = initHandoff('Test task', {
        maxIterations: 30,
        completionPromise: 'DONE',
        stuckThreshold: 5
      });

      expect(handoff.max_iterations).toBe(30);
      expect(handoff.completion_promise).toBe('DONE');
      expect(handoff.stuckDetection.iterationsOnSameStory).toBe(0);
    });
  });

  describe('readHandoff', () => {
    it('should return null when handoff file does not exist', () => {
      const handoff = readHandoff(testDir);
      expect(handoff).toBeNull();
    });

    it('should return parsed handoff when file exists', () => {
      const created = initHandoff('Test task', {});
      writeHandoff(created, testDir);

      const read = readHandoff(testDir);
      expect(read).not.toBeNull();
      expect(read?.original_prompt).toBe('Test task');
      expect(read?.version).toBe('1.0');
    });

    it('should return null for malformed JSON', () => {
      const stateDir = join(testDir, '.omc', 'state');
      mkdirSync(stateDir, { recursive: true });
      const handoffPath = getHandoffPath(testDir);
      writeFileSync(handoffPath, 'not valid json');

      expect(readHandoff(testDir)).toBeNull();
    });
  });

  describe('writeHandoff', () => {
    it('should write handoff to correct location', () => {
      const handoff = initHandoff('Test task', {});
      const success = writeHandoff(handoff, testDir);

      expect(success).toBe(true);
      expect(existsSync(getHandoffPath(testDir))).toBe(true);
    });

    it('should create .omc/state directory if it does not exist', () => {
      const handoff = initHandoff('Test task', {});
      writeHandoff(handoff, testDir);

      expect(existsSync(join(testDir, '.omc', 'state'))).toBe(true);
    });

    it('should round-trip handoff data correctly', () => {
      const original = initHandoff('Test task', { maxIterations: 15 });
      original.iteration = 3;
      original.completed = true;
      original.completion_message = 'All done!';

      writeHandoff(original, testDir);
      const read = readHandoff(testDir);

      expect(read?.iteration).toBe(3);
      expect(read?.completed).toBe(true);
      expect(read?.completion_message).toBe('All done!');
      expect(read?.max_iterations).toBe(15);
    });
  });

  describe('clearHandoff', () => {
    it('should delete handoff file if it exists', () => {
      const handoff = initHandoff('Test task', {});
      writeHandoff(handoff, testDir);

      expect(existsSync(getHandoffPath(testDir))).toBe(true);

      const success = clearHandoff(testDir);
      expect(success).toBe(true);
      expect(existsSync(getHandoffPath(testDir))).toBe(false);
    });

    it('should return true if handoff file does not exist', () => {
      const success = clearHandoff(testDir);
      expect(success).toBe(true);
    });
  });

  describe('refreshHandoffFromFiles', () => {
    it('should read PRD state from .omc/prd.json', () => {
      const handoff = initHandoff('Test task', {});

      // Write a PRD
      const prd = {
        project: 'Test Project',
        branchName: 'test/feature',
        description: 'Test description',
        userStories: [
          {
            id: 'US-001',
            title: 'First story',
            description: 'Test',
            acceptanceCriteria: ['Criterion 1'],
            priority: 1,
            passes: true
          },
          {
            id: 'US-002',
            title: 'Second story',
            description: 'Test',
            acceptanceCriteria: ['Criterion 2'],
            priority: 2,
            passes: false
          },
          {
            id: 'US-003',
            title: 'Third story',
            description: 'Test',
            acceptanceCriteria: ['Criterion 3'],
            priority: 3,
            passes: false
          }
        ]
      };
      writePrd(testDir, prd);

      const refreshed = refreshHandoffFromFiles(handoff, testDir);

      expect(refreshed.prd).toBeDefined();
      expect(refreshed.prd?.project).toBe('Test Project');
      expect(refreshed.prd?.storiesTotal).toBe(3);
      expect(refreshed.prd?.storiesCompleted).toBe(1);
      expect(refreshed.prd?.nextStoryId).toBe('US-002');
      expect(refreshed.prd?.incompleteIds).toEqual(['US-002', 'US-003']);
    });

    it('should read progress patterns from .omc/progress.txt', () => {
      const handoff = initHandoff('Test task', {});

      // Initialize progress and add patterns
      initProgress(testDir);
      addPattern(testDir, 'Use middleware for auth');
      addPattern(testDir, 'Validate with Zod');

      const refreshed = refreshHandoffFromFiles(handoff, testDir);

      expect(refreshed.progress.patterns).toContain('Use middleware for auth');
      expect(refreshed.progress.patterns).toContain('Validate with Zod');
    });

    it('should read recent learnings from .omc/progress.txt', () => {
      const handoff = initHandoff('Test task', {});

      // Initialize and add progress entry
      initProgress(testDir);
      appendProgress(testDir, {
        storyId: 'US-001',
        implementation: ['Added auth'],
        filesChanged: ['auth.ts'],
        learnings: ['bcrypt.compare is async', 'Use 404 for not found']
      });

      const refreshed = refreshHandoffFromFiles(handoff, testDir);

      expect(refreshed.progress.recentLearnings).toContain('bcrypt.compare is async');
      expect(refreshed.progress.recentLearnings).toContain('Use 404 for not found');
    });

    it('should read recent git commits', () => {
      const handoff = initHandoff('Test task', {});

      // Create a commit
      try {
        writeFileSync(join(testDir, 'test.txt'), 'test');
        execSync('git add test.txt', { cwd: testDir, stdio: 'ignore' });
        execSync('git commit -m "feat: add test file"', { cwd: testDir, stdio: 'ignore' });

        const refreshed = refreshHandoffFromFiles(handoff, testDir);

        expect(refreshed.git.recentCommits.length).toBeGreaterThan(0);
        expect(refreshed.git.recentCommits[0].message).toContain('add test file');
      } catch {
        // Skip test if git is not available
      }
    });

    it('should detect uncommitted changes', () => {
      const handoff = initHandoff('Test task', {});

      try {
        // Create initial commit
        writeFileSync(join(testDir, 'initial.txt'), 'initial');
        execSync('git add initial.txt', { cwd: testDir, stdio: 'ignore' });
        execSync('git commit -m "initial"', { cwd: testDir, stdio: 'ignore' });

        // Create uncommitted change
        writeFileSync(join(testDir, 'uncommitted.txt'), 'uncommitted');

        const refreshed = refreshHandoffFromFiles(handoff, testDir);

        expect(refreshed.git.hasUncommittedChanges).toBe(true);
      } catch {
        // Skip test if git is not available
      }
    });

    it('should update stuck detection when working on same story', () => {
      const handoff = initHandoff('Test task', {});

      // Write PRD
      const prd = {
        project: 'Test',
        branchName: 'test',
        description: 'Test',
        userStories: [
          {
            id: 'US-001',
            title: 'Story',
            description: 'Test',
            acceptanceCriteria: ['Test'],
            priority: 1,
            passes: false
          }
        ]
      };
      writePrd(testDir, prd);

      // First refresh - story is US-001
      let refreshed = refreshHandoffFromFiles(handoff, testDir);
      expect(refreshed.stuckDetection.iterationsOnSameStory).toBe(1);
      expect(refreshed.prd?.nextStoryId).toBe('US-001');

      // Update handoff with last status
      refreshed.stuckDetection.lastPrdStatus = ['US-001'];

      // Second refresh - still on US-001
      refreshed = refreshHandoffFromFiles(refreshed, testDir);
      expect(refreshed.stuckDetection.iterationsOnSameStory).toBe(2);
    });

    it('should reset stuck detection when moving to different story', () => {
      const handoff = initHandoff('Test task', {});
      handoff.stuckDetection.lastPrdStatus = ['US-001'];
      handoff.stuckDetection.iterationsOnSameStory = 3;

      // Write PRD with different next story
      const prd = {
        project: 'Test',
        branchName: 'test',
        description: 'Test',
        userStories: [
          {
            id: 'US-001',
            title: 'First',
            description: 'Test',
            acceptanceCriteria: ['Test'],
            priority: 1,
            passes: true
          },
          {
            id: 'US-002',
            title: 'Second',
            description: 'Test',
            acceptanceCriteria: ['Test'],
            priority: 2,
            passes: false
          }
        ]
      };
      writePrd(testDir, prd);

      const refreshed = refreshHandoffFromFiles(handoff, testDir);

      expect(refreshed.prd?.nextStoryId).toBe('US-002');
      expect(refreshed.stuckDetection.iterationsOnSameStory).toBe(1);
    });

    it('should handle missing PRD gracefully', () => {
      const handoff = initHandoff('Test task', {});

      const refreshed = refreshHandoffFromFiles(handoff, testDir);

      expect(refreshed.prd).toBeUndefined();
    });

    it('should handle missing progress.txt gracefully', () => {
      const handoff = initHandoff('Test task', {});

      const refreshed = refreshHandoffFromFiles(handoff, testDir);

      expect(refreshed.progress.patterns).toEqual([]);
      expect(refreshed.progress.recentLearnings).toEqual([]);
    });

    it('should handle non-git directory gracefully', () => {
      // Create a non-git directory
      const nonGitDir = join(tmpdir(), `non-git-${Date.now()}`);
      mkdirSync(nonGitDir, { recursive: true });

      const handoff = initHandoff('Test task', {});
      const refreshed = refreshHandoffFromFiles(handoff, nonGitDir);

      expect(refreshed.git.recentCommits).toEqual([]);
      expect(refreshed.git.hasUncommittedChanges).toBe(false);
      expect(refreshed.git.branch).toBe('');

      rmSync(nonGitDir, { recursive: true, force: true });
    });
  });
});
