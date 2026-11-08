/**
 * Tests for Ralphthon Orchestrator
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readRalphthonState,
  writeRalphthonState,
  clearRalphthonState,
  initOrchestrator,
  getNextAction,
  transitionPhase,
  startHardeningWave,
  endHardeningWave,
  recordTaskCompletion,
  recordTaskSkip,
} from '../orchestrator.js';
import {
  writeRalphthonPrd,
  createRalphthonPrd,
} from '../prd.js';
import type {
  RalphthonState,
  RalphthonStory,
  OrchestratorEvent,
} from '../types.js';

describe('Ralphthon Orchestrator', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ralphthon-orch-test-'));
    mkdirSync(join(testDir, '.omc', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ============================================================================
  // State Management
  // ============================================================================

  describe('state management', () => {
    it('should return null when no state exists', () => {
      expect(readRalphthonState(testDir)).toBeNull();
    });

    it('should write and read state', () => {
      const state = createTestState();
      expect(writeRalphthonState(testDir, state)).toBe(true);

      const result = readRalphthonState(testDir);
      expect(result).not.toBeNull();
      expect(result!.active).toBe(true);
      expect(result!.phase).toBe('execution');
    });

    it('should reject state from different session', () => {
      const state = createTestState();
      state.sessionId = 'session-1';
      writeRalphthonState(testDir, state, 'session-1');

      const result = readRalphthonState(testDir, 'session-2');
      expect(result).toBeNull();
    });

    it('should clear state', () => {
      const state = createTestState();
      writeRalphthonState(testDir, state);

      expect(clearRalphthonState(testDir)).toBe(true);
      expect(readRalphthonState(testDir)).toBeNull();
    });
  });

  // ============================================================================
  // Orchestrator Init
  // ============================================================================

  describe('initOrchestrator', () => {
    it('should create initial state', () => {
      const state = initOrchestrator(
        testDir,
        'omc-test-session',
        '%0',
        'prd.json',
        'test-session',
      );

      expect(state.active).toBe(true);
      expect(state.phase).toBe('execution');
      expect(state.tmuxSession).toBe('omc-test-session');
      expect(state.leaderPaneId).toBe('%0');
      expect(state.currentWave).toBe(0);
      expect(state.consecutiveCleanWaves).toBe(0);
    });

    it('should persist state to disk', () => {
      initOrchestrator(testDir, 'omc-test', '%0', 'prd.json', 'test-session');

      const state = readRalphthonState(testDir, 'test-session');
      expect(state).not.toBeNull();
      expect(state!.active).toBe(true);
    });
  });

  // ============================================================================
  // Next Action Logic
  // ============================================================================

  describe('getNextAction', () => {
    it('should return complete when no state', () => {
      const result = getNextAction(testDir);
      expect(result.action).toBe('complete');
    });

    it('should inject task during execution phase', () => {
      const sessionId = 'test-session';
      setupExecutionPhase(testDir, sessionId);

      const result = getNextAction(testDir, sessionId);
      expect(result.action).toBe('inject_task');
      expect(result.prompt).toContain('T-001');
    });

    it('should transition to hardening when all stories done', () => {
      const sessionId = 'test-session';
      setupExecutionPhase(testDir, sessionId);

      // Mark all tasks as done
      const prd = createTestPrdWithTasks();
      prd.stories[0].tasks[0].status = 'done';
      prd.stories[0].tasks[1].status = 'done';
      prd.stories[1].tasks[0].status = 'done';
      writeRalphthonPrd(testDir, prd);

      const result = getNextAction(testDir, sessionId);
      expect(result.action).toBe('generate_hardening');
    });

    it('should inject hardening task during hardening phase', () => {
      const sessionId = 'test-session';
      setupHardeningPhase(testDir, sessionId);

      const result = getNextAction(testDir, sessionId);
      expect(result.action).toBe('inject_hardening');
      expect(result.prompt).toContain('HARDENING');
    });

    it('should complete when consecutive clean waves reached', () => {
      const sessionId = 'test-session';
      const state = createTestState();
      state.sessionId = sessionId;
      state.phase = 'hardening';
      state.consecutiveCleanWaves = 3;
      writeRalphthonState(testDir, state, sessionId);

      // Create PRD with config
      const prd = createTestPrdWithTasks();
      prd.config.cleanWavesForTermination = 3;
      writeRalphthonPrd(testDir, prd);

      const result = getNextAction(testDir, sessionId);
      expect(result.action).toBe('complete');
    });

    it('should complete when max waves reached', () => {
      const sessionId = 'test-session';
      const state = createTestState();
      state.sessionId = sessionId;
      state.phase = 'hardening';
      state.currentWave = 10;
      writeRalphthonState(testDir, state, sessionId);

      const prd = createTestPrdWithTasks();
      prd.config.maxWaves = 10;
      writeRalphthonPrd(testDir, prd);

      const result = getNextAction(testDir, sessionId);
      expect(result.action).toBe('complete');
    });

    it('should wait during interview phase', () => {
      const sessionId = 'test-session';
      const state = createTestState();
      state.sessionId = sessionId;
      state.phase = 'interview';
      writeRalphthonState(testDir, state, sessionId);

      const result = getNextAction(testDir, sessionId);
      expect(result.action).toBe('wait');
    });

    it('should generate new hardening wave when current wave done', () => {
      const sessionId = 'test-session';
      const state = createTestState();
      state.sessionId = sessionId;
      state.phase = 'hardening';
      state.currentWave = 1;
      state.consecutiveCleanWaves = 0;
      writeRalphthonState(testDir, state, sessionId);

      // PRD with all hardening done
      const prd = createTestPrdWithTasks();
      prd.stories[0].tasks[0].status = 'done';
      prd.stories[0].tasks[1].status = 'done';
      prd.stories[1].tasks[0].status = 'done';
      prd.hardening = [
        { id: 'H-01-001', title: 'Done', description: 'done', category: 'test', status: 'done', wave: 1, retries: 0 },
      ];
      writeRalphthonPrd(testDir, prd);

      const result = getNextAction(testDir, sessionId);
      expect(result.action).toBe('generate_hardening');
    });
  });

  // ============================================================================
  // Phase Transitions
  // ============================================================================

  describe('transitionPhase', () => {
    it('should transition phase and emit event', () => {
      const sessionId = 'test-session';
      const state = createTestState();
      state.sessionId = sessionId;
      writeRalphthonState(testDir, state, sessionId);

      const events: OrchestratorEvent[] = [];
      const handler = (e: OrchestratorEvent) => events.push(e);

      transitionPhase(testDir, 'hardening', sessionId, handler);

      const updated = readRalphthonState(testDir, sessionId);
      expect(updated!.phase).toBe('hardening');
      expect(updated!.active).toBe(true);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('phase_transition');
    });

    it('should deactivate on complete', () => {
      const sessionId = 'test-session';
      const state = createTestState();
      state.sessionId = sessionId;
      writeRalphthonState(testDir, state, sessionId);

      transitionPhase(testDir, 'complete', sessionId);

      const updated = readRalphthonState(testDir, sessionId);
      expect(updated!.active).toBe(false);
      expect(updated!.phase).toBe('complete');
    });
  });

  // ============================================================================
  // Hardening Waves
  // ============================================================================

  describe('startHardeningWave', () => {
    it('should increment wave count', () => {
      const sessionId = 'test-session';
      const state = createTestState();
      state.sessionId = sessionId;
      state.phase = 'hardening';
      writeRalphthonState(testDir, state, sessionId);

      const prd = createTestPrdWithTasks();
      writeRalphthonPrd(testDir, prd);

      const events: OrchestratorEvent[] = [];
      const result = startHardeningWave(testDir, sessionId, e => events.push(e));

      expect(result).not.toBeNull();
      expect(result!.wave).toBe(1);

      const updated = readRalphthonState(testDir, sessionId);
      expect(updated!.currentWave).toBe(1);
      expect(events[0].type).toBe('hardening_wave_start');
    });

    it('should transition to hardening phase if not already', () => {
      const sessionId = 'test-session';
      const state = createTestState();
      state.sessionId = sessionId;
      state.phase = 'execution';
      writeRalphthonState(testDir, state, sessionId);

      const prd = createTestPrdWithTasks();
      writeRalphthonPrd(testDir, prd);

      startHardeningWave(testDir, sessionId);

      const updated = readRalphthonState(testDir, sessionId);
      expect(updated!.phase).toBe('hardening');
    });
  });

  describe('endHardeningWave', () => {
    it('should increment consecutive clean waves on zero issues', () => {
      const sessionId = 'test-session';
      const state = createTestState();
      state.sessionId = sessionId;
      state.phase = 'hardening';
      state.currentWave = 1;
      state.consecutiveCleanWaves = 1;
      writeRalphthonState(testDir, state, sessionId);

      const prd = createTestPrdWithTasks();
      writeRalphthonPrd(testDir, prd);

      const result = endHardeningWave(testDir, 0, sessionId);

      const updated = readRalphthonState(testDir, sessionId);
      expect(updated!.consecutiveCleanWaves).toBe(2);
      expect(result.shouldTerminate).toBe(false);
    });

    it('should reset consecutive clean waves on new issues', () => {
      const sessionId = 'test-session';
      const state = createTestState();
      state.sessionId = sessionId;
      state.phase = 'hardening';
      state.currentWave = 1;
      state.consecutiveCleanWaves = 2;
      writeRalphthonState(testDir, state, sessionId);

      const prd = createTestPrdWithTasks();
      writeRalphthonPrd(testDir, prd);

      endHardeningWave(testDir, 3, sessionId);

      const updated = readRalphthonState(testDir, sessionId);
      expect(updated!.consecutiveCleanWaves).toBe(0);
    });

    it('should signal termination after clean waves threshold', () => {
      const sessionId = 'test-session';
      const state = createTestState();
      state.sessionId = sessionId;
      state.phase = 'hardening';
      state.currentWave = 3;
      state.consecutiveCleanWaves = 2;
      writeRalphthonState(testDir, state, sessionId);

      const prd = createTestPrdWithTasks();
      prd.config.cleanWavesForTermination = 3;
      writeRalphthonPrd(testDir, prd);

      const result = endHardeningWave(testDir, 0, sessionId);
      expect(result.shouldTerminate).toBe(true);
    });
  });

  // ============================================================================
  // Task Recording
  // ============================================================================

  describe('recordTaskCompletion', () => {
    it('should increment completed count', () => {
      const sessionId = 'test-session';
      const state = createTestState();
      state.sessionId = sessionId;
      state.currentTaskId = 'T-001';
      writeRalphthonState(testDir, state, sessionId);

      const events: OrchestratorEvent[] = [];
      recordTaskCompletion(testDir, 'T-001', sessionId, e => events.push(e));

      const updated = readRalphthonState(testDir, sessionId);
      expect(updated!.tasksCompleted).toBe(1);
      expect(updated!.currentTaskId).toBeUndefined();
      expect(events[0].type).toBe('task_completed');
    });
  });

  describe('recordTaskSkip', () => {
    it('should increment skipped count', () => {
      const sessionId = 'test-session';
      const state = createTestState();
      state.sessionId = sessionId;
      state.currentTaskId = 'T-001';
      writeRalphthonState(testDir, state, sessionId);

      const events: OrchestratorEvent[] = [];
      recordTaskSkip(testDir, 'T-001', 'max retries', sessionId, e => events.push(e));

      const updated = readRalphthonState(testDir, sessionId);
      expect(updated!.tasksSkipped).toBe(1);
      expect(events[0].type).toBe('task_skipped');
    });
  });

  // ============================================================================
  // Completion Signal Detection
  // ============================================================================

  describe('detectCompletionSignal', () => {
    // These tests verify regex patterns without needing real tmux
    it('should match completion patterns', () => {
      const patterns = [
        'all stories complete',
        'All tasks are done',
        'ralphthon complete',
        'hardening complete',
        'no new issues found',
        'No issues found',
      ];

      // Test against the regex patterns directly
      const completionPatterns = [
        /all\s+(?:stories|tasks)\s+(?:are\s+)?(?:complete|done)/i,
        /ralphthon\s+complete/i,
        /hardening\s+complete/i,
        /no\s+(?:new\s+)?issues?\s+found/i,
      ];

      for (const text of patterns) {
        const matches = completionPatterns.some(p => p.test(text));
        expect(matches).toBe(true);
      }
    });
  });
});

// ============================================================================
// Test Helpers
// ============================================================================

function createTestState(): RalphthonState {
  return {
    active: true,
    phase: 'execution',
    projectPath: '/tmp/test',
    prdPath: 'ralphthon-prd.json',
    tmuxSession: 'omc-test',
    leaderPaneId: '%0',
    startedAt: new Date().toISOString(),
    currentWave: 0,
    consecutiveCleanWaves: 0,
    tasksCompleted: 0,
    tasksSkipped: 0,
  };
}

function createTestPrdWithTasks() {
  const stories: RalphthonStory[] = [
    {
      id: 'US-001',
      title: 'First story',
      description: 'Feature A',
      acceptanceCriteria: ['works'],
      priority: 'high',
      tasks: [
        { id: 'T-001', title: 'Build A', description: 'Build A', status: 'pending', retries: 0 },
        { id: 'T-002', title: 'Test A', description: 'Test A', status: 'pending', retries: 0 },
      ],
    },
    {
      id: 'US-002',
      title: 'Second story',
      description: 'Feature B',
      acceptanceCriteria: ['works'],
      priority: 'medium',
      tasks: [
        { id: 'T-003', title: 'Build B', description: 'Build B', status: 'pending', retries: 0 },
      ],
    },
  ];

  return createRalphthonPrd('test-project', 'feat/test', 'Test', stories);
}

function setupExecutionPhase(testDir: string, sessionId: string) {
  const state = createTestState();
  state.sessionId = sessionId;
  state.phase = 'execution';
  writeRalphthonState(testDir, state, sessionId);

  const prd = createTestPrdWithTasks();
  writeRalphthonPrd(testDir, prd);
}

function setupHardeningPhase(testDir: string, sessionId: string) {
  const state = createTestState();
  state.sessionId = sessionId;
  state.phase = 'hardening';
  state.currentWave = 1;
  writeRalphthonState(testDir, state, sessionId);

  const prd = createTestPrdWithTasks();
  prd.stories[0].tasks[0].status = 'done';
  prd.stories[0].tasks[1].status = 'done';
  prd.stories[1].tasks[0].status = 'done';
  prd.hardening = [
    { id: 'H-01-001', title: 'Edge test', description: 'Test edge case', category: 'edge_case', status: 'pending', wave: 1, retries: 0 },
  ];
  writeRalphthonPrd(testDir, prd);
}
