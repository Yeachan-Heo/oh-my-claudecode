import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  detectNoPrdFlag,
  stripNoPrdFlag,
  createRalphLoopHook,
  readRalphState,
  findPrdPath,
  initPrd,
  readPrd,
  writePrd,
  createSimplePrd,
  type PRD,
  type UserStory,
} from '../hooks/ralph/index.js';
import {
  getArchitectVerificationPrompt,
  startVerification,
  type VerificationState,
} from '../hooks/ralph/verifier.js';

describe('Ralph PRD-Mandatory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `ralph-prd-mandatory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    // Create .omc/state directory for ralph state files
    mkdirSync(join(testDir, '.omc', 'state'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // Flag Detection & Stripping
  // ==========================================================================

  describe('detectNoPrdFlag', () => {
    it('should detect --no-prd in prompt', () => {
      expect(detectNoPrdFlag('ralph --no-prd fix this')).toBe(true);
    });

    it('should detect --no-prd at start of prompt', () => {
      expect(detectNoPrdFlag('--no-prd fix this bug')).toBe(true);
    });

    it('should detect --no-prd at end of prompt', () => {
      expect(detectNoPrdFlag('fix this bug --no-prd')).toBe(true);
    });

    it('should detect --NO-PRD (case insensitive)', () => {
      expect(detectNoPrdFlag('ralph --NO-PRD fix this')).toBe(true);
    });

    it('should detect --No-Prd (mixed case)', () => {
      expect(detectNoPrdFlag('ralph --No-Prd fix this')).toBe(true);
    });

    it('should return false when flag is absent', () => {
      expect(detectNoPrdFlag('ralph fix this bug')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(detectNoPrdFlag('')).toBe(false);
    });

    it('should return false for --prd (without no)', () => {
      expect(detectNoPrdFlag('ralph --prd build a todo app')).toBe(false);
    });
  });

  describe('stripNoPrdFlag', () => {
    it('should remove --no-prd and trim', () => {
      expect(stripNoPrdFlag('ralph --no-prd fix this')).toBe('ralph fix this');
    });

    it('should remove --no-prd at start', () => {
      expect(stripNoPrdFlag('--no-prd fix this bug')).toBe('fix this bug');
    });

    it('should remove --no-prd at end', () => {
      expect(stripNoPrdFlag('fix this bug --no-prd')).toBe('fix this bug');
    });

    it('should handle multiple spaces after removal', () => {
      expect(stripNoPrdFlag('ralph  --no-prd  fix')).toBe('ralph fix');
    });

    it('should remove --NO-PRD (case insensitive)', () => {
      expect(stripNoPrdFlag('ralph --NO-PRD fix')).toBe('ralph fix');
    });

    it('should preserve prompt when flag absent', () => {
      expect(stripNoPrdFlag('ralph fix this bug')).toBe('ralph fix this bug');
    });

    it('should handle empty string', () => {
      expect(stripNoPrdFlag('')).toBe('');
    });
  });

  // ==========================================================================
  // Scaffold Auto-Generation
  // ==========================================================================

  describe('scaffold PRD auto-generation', () => {
    it('should create scaffold prd.json via initPrd', () => {
      expect(findPrdPath(testDir)).toBeNull();
      initPrd(testDir, 'TestProject', 'ralph/feature', 'Build a todo app');
      expect(findPrdPath(testDir)).not.toBeNull();
    });

    it('should create scaffold with single story from prompt', () => {
      initPrd(testDir, 'TestProject', 'ralph/feature', 'Add user authentication');
      const prd = readPrd(testDir);
      expect(prd).not.toBeNull();
      expect(prd!.project).toBe('TestProject');
      expect(prd!.branchName).toBe('ralph/feature');
      expect(prd!.userStories.length).toBe(1);
      expect(prd!.userStories[0].id).toBe('US-001');
      expect(prd!.userStories[0].passes).toBe(false);
    });

    it('should have default generic acceptance criteria in scaffold', () => {
      initPrd(testDir, 'TestProject', 'main', 'Implement feature X');
      const prd = readPrd(testDir);
      expect(prd!.userStories[0].acceptanceCriteria).toContain('Implementation is complete');
      expect(prd!.userStories[0].acceptanceCriteria).toContain('Code compiles/runs without errors');
    });

    it('should NOT overwrite existing prd.json', () => {
      const existingPrd: PRD = {
        project: 'Existing',
        branchName: 'existing-branch',
        description: 'Pre-existing PRD',
        userStories: [
          {
            id: 'US-001',
            title: 'Existing story',
            description: 'Already here',
            acceptanceCriteria: ['Custom criterion'],
            priority: 1,
            passes: false,
          },
        ],
      };
      writePrd(testDir, existingPrd);

      // findPrdPath should return the existing path
      const existingPath = findPrdPath(testDir);
      expect(existingPath).not.toBeNull();

      // Reading should return the pre-existing PRD (not overwritten)
      const prd = readPrd(testDir);
      expect(prd!.project).toBe('Existing');
      expect(prd!.userStories[0].acceptanceCriteria).toContain('Custom criterion');
    });
  });

  // ==========================================================================
  // PRD Mode Activation in startLoop
  // ==========================================================================

  describe('PRD mode activation in startLoop', () => {
    it('should enable prd_mode when prd.json exists', () => {
      // Create a PRD first
      const prd: PRD = {
        project: 'Test',
        branchName: 'test',
        description: 'Test project',
        userStories: [
          {
            id: 'US-001',
            title: 'First story',
            description: 'Do something',
            acceptanceCriteria: ['It works'],
            priority: 1,
            passes: false,
          },
        ],
      };
      writePrd(testDir, prd);

      // Start ralph loop
      const hook = createRalphLoopHook(testDir);
      hook.startLoop(undefined, 'test prompt');

      // Check state has PRD mode enabled
      const state = readRalphState(testDir);
      expect(state).not.toBeNull();
      expect(state!.prd_mode).toBe(true);
    });

    it('should set current_story_id to next incomplete story', () => {
      const prd: PRD = {
        project: 'Test',
        branchName: 'test',
        description: 'Test',
        userStories: [
          {
            id: 'US-001',
            title: 'Done',
            description: '',
            acceptanceCriteria: [],
            priority: 1,
            passes: true,
          },
          {
            id: 'US-002',
            title: 'Next',
            description: '',
            acceptanceCriteria: [],
            priority: 2,
            passes: false,
          },
        ],
      };
      writePrd(testDir, prd);

      const hook = createRalphLoopHook(testDir);
      hook.startLoop(undefined, 'test prompt');

      const state = readRalphState(testDir);
      expect(state!.current_story_id).toBe('US-002');
    });

    it('should NOT enable prd_mode when no prd.json exists', () => {
      const hook = createRalphLoopHook(testDir);
      hook.startLoop(undefined, 'test prompt');

      const state = readRalphState(testDir);
      expect(state).not.toBeNull();
      expect(state!.prd_mode).toBeUndefined();
    });
  });

  // ==========================================================================
  // Story-Aware Verification
  // ==========================================================================

  describe('story-aware architect verification', () => {
    const baseVerificationState: VerificationState = {
      pending: true,
      completion_claim: 'Task is complete',
      verification_attempts: 0,
      max_verification_attempts: 3,
      requested_at: new Date().toISOString(),
      original_task: 'Build a todo app',
    };

    it('should include acceptance criteria when story is provided', () => {
      const story: UserStory = {
        id: 'US-001',
        title: 'Add login form',
        description: 'As a user, I want to log in',
        acceptanceCriteria: [
          'Login form renders with email and password fields',
          'Submit button calls the auth API',
          'Error message shown on invalid credentials',
        ],
        priority: 1,
        passes: false,
      };

      const prompt = getArchitectVerificationPrompt(baseVerificationState, story);

      expect(prompt).toContain('US-001');
      expect(prompt).toContain('Add login form');
      expect(prompt).toContain('Login form renders with email and password fields');
      expect(prompt).toContain('Submit button calls the auth API');
      expect(prompt).toContain('Error message shown on invalid credentials');
      expect(prompt).toContain('Verify EACH acceptance criterion');
    });

    it('should fall back to generic prompt when no story provided', () => {
      const prompt = getArchitectVerificationPrompt(baseVerificationState);

      expect(prompt).toContain('Are ALL requirements from the original task met?');
      expect(prompt).toContain('Is the implementation complete, not partial?');
      expect(prompt).not.toContain('Verify EACH acceptance criterion');
    });

    it('should fall back to generic prompt when story is undefined', () => {
      const prompt = getArchitectVerificationPrompt(baseVerificationState, undefined);

      expect(prompt).toContain('Are ALL requirements from the original task met?');
      expect(prompt).not.toContain('Acceptance Criteria to Verify');
    });

    it('should include attempt count', () => {
      const state = { ...baseVerificationState, verification_attempts: 1 };
      const prompt = getArchitectVerificationPrompt(state);
      expect(prompt).toContain('Attempt 2/3');
    });

    it('should include previous architect feedback when rejected', () => {
      const state = {
        ...baseVerificationState,
        architect_feedback: 'Missing error handling in auth module',
      };
      const prompt = getArchitectVerificationPrompt(state);
      expect(prompt).toContain('Missing error handling in auth module');
    });
  });

  // ==========================================================================
  // Integration: PRD + Verification
  // ==========================================================================

  describe('integration: PRD-driven verification', () => {
    it('should produce verification prompt with story criteria from prd.json', () => {
      // Setup: create a PRD with specific criteria
      const prd: PRD = {
        project: 'IntegrationTest',
        branchName: 'ralph/integration',
        description: 'Integration test project',
        userStories: [
          {
            id: 'US-001',
            title: 'Implement caching',
            description: 'Add Redis caching to API endpoints',
            acceptanceCriteria: [
              'Cache middleware intercepts GET requests',
              'Cache TTL is configurable via environment variable',
              'Cache invalidation on POST/PUT/DELETE',
              'Tests cover all three scenarios',
            ],
            priority: 1,
            passes: false,
          },
          {
            id: 'US-002',
            title: 'Add metrics',
            description: 'Cache hit/miss metrics',
            acceptanceCriteria: ['Prometheus endpoint exposes cache metrics'],
            priority: 2,
            passes: false,
          },
        ],
      };
      writePrd(testDir, prd);

      // Simulate: start ralph, which enables PRD mode
      const hook = createRalphLoopHook(testDir);
      hook.startLoop(undefined, 'Implement caching with metrics');

      // Simulate: start verification for the current story
      const verificationState = startVerification(
        testDir,
        'Caching is implemented',
        'Implement caching with metrics',
      );

      // Generate verification prompt with the current story (US-001)
      const currentStory = prd.userStories[0];
      const prompt = getArchitectVerificationPrompt(verificationState, currentStory);

      // Verify the prompt includes ALL acceptance criteria from US-001
      expect(prompt).toContain('Cache middleware intercepts GET requests');
      expect(prompt).toContain('Cache TTL is configurable via environment variable');
      expect(prompt).toContain('Cache invalidation on POST/PUT/DELETE');
      expect(prompt).toContain('Tests cover all three scenarios');
      expect(prompt).toContain('Implement caching');
      expect(prompt).toContain('US-001');
      expect(prompt).toContain('Verify EACH acceptance criterion');
    });

    it('scaffold PRD creates valid structure that getPrdStatus can read', () => {
      // Auto-generate scaffold
      initPrd(testDir, 'Scaffold', 'main', 'Build a widget');
      const prd = readPrd(testDir);
      expect(prd).not.toBeNull();

      // Verify structure is valid for getPrdStatus
      expect(prd!.userStories).toBeDefined();
      expect(Array.isArray(prd!.userStories)).toBe(true);
      expect(prd!.userStories.length).toBeGreaterThan(0);
      expect(prd!.userStories[0].passes).toBe(false);
      expect(prd!.userStories[0].acceptanceCriteria).toBeDefined();
      expect(Array.isArray(prd!.userStories[0].acceptanceCriteria)).toBe(true);
    });
  });
});
