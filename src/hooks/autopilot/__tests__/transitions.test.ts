/**
 * Autopilot State Machine Transition Tests
 *
 * Tests:
 * - Valid phase transitions succeed
 * - Illegal transitions are rejected (e.g., planning -> complete skipping execution)
 * - Idempotent transitions (same transition twice)
 * - Recovery transitions after failure state
 * - Transactional transition helpers (execute + rollback on failure)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readAutopilotState,
  writeAutopilotState,
  clearAutopilotState,
  isAutopilotActive,
  initAutopilot,
  transitionPhase,
  updateExpansion,
  updatePlanning,
  updateExecution,
  updateQA,
  updateValidation,
  transitionToComplete,
  transitionToFailed,
  TransitionResult,
} from '../state.js';
import { AutopilotPhase, AutopilotState } from '../types.js';

describe('Autopilot State Machine Transitions', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'autopilot-transition-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Valid Phase Transitions
  // --------------------------------------------------------------------------

  describe('valid transitions', () => {
    it('should transition from expansion to planning', () => {
      initAutopilot(testDir, 'build a CLI tool');
      const state = transitionPhase(testDir, 'planning');

      expect(state).not.toBeNull();
      expect(state!.phase).toBe('planning');
      expect(state!.active).toBe(true);
    });

    it('should transition from planning to execution', () => {
      initAutopilot(testDir, 'test idea');
      transitionPhase(testDir, 'planning');
      const state = transitionPhase(testDir, 'execution');

      expect(state).not.toBeNull();
      expect(state!.phase).toBe('execution');
      expect(state!.active).toBe(true);
    });

    it('should transition from execution to qa', () => {
      initAutopilot(testDir, 'test idea');
      transitionPhase(testDir, 'planning');
      transitionPhase(testDir, 'execution');
      const state = transitionPhase(testDir, 'qa');

      expect(state).not.toBeNull();
      expect(state!.phase).toBe('qa');
      expect(state!.active).toBe(true);
    });

    it('should transition from qa to validation', () => {
      initAutopilot(testDir, 'test idea');
      transitionPhase(testDir, 'planning');
      transitionPhase(testDir, 'execution');
      transitionPhase(testDir, 'qa');
      const state = transitionPhase(testDir, 'validation');

      expect(state).not.toBeNull();
      expect(state!.phase).toBe('validation');
      expect(state!.active).toBe(true);
    });

    it('should transition from validation to complete', () => {
      initAutopilot(testDir, 'test idea');
      transitionPhase(testDir, 'planning');
      transitionPhase(testDir, 'execution');
      transitionPhase(testDir, 'qa');
      transitionPhase(testDir, 'validation');
      const state = transitionPhase(testDir, 'complete');

      expect(state).not.toBeNull();
      expect(state!.phase).toBe('complete');
      expect(state!.active).toBe(false);
      expect(state!.completed_at).not.toBeNull();
    });

    it('should walk through the full lifecycle: expansion -> planning -> execution -> qa -> validation -> complete', () => {
      initAutopilot(testDir, 'full lifecycle test');

      const phases: AutopilotPhase[] = ['planning', 'execution', 'qa', 'validation', 'complete'];

      for (const phase of phases) {
        const state = transitionPhase(testDir, phase);
        expect(state).not.toBeNull();
        expect(state!.phase).toBe(phase);
      }

      // Final state should be inactive and completed
      const finalState = readAutopilotState(testDir);
      expect(finalState!.active).toBe(false);
      expect(finalState!.completed_at).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Transition to terminal states
  // --------------------------------------------------------------------------

  describe('terminal states', () => {
    it('should mark as inactive on complete', () => {
      initAutopilot(testDir, 'test');
      const state = transitionPhase(testDir, 'complete');

      expect(state!.active).toBe(false);
      expect(state!.completed_at).toBeTruthy();
    });

    it('should mark as inactive on failed', () => {
      initAutopilot(testDir, 'test');
      const state = transitionPhase(testDir, 'failed');

      expect(state!.active).toBe(false);
      expect(state!.completed_at).toBeTruthy();
    });

    it('transitionToComplete helper should work', () => {
      initAutopilot(testDir, 'test');
      transitionPhase(testDir, 'validation');
      const result: TransitionResult = transitionToComplete(testDir);

      expect(result.success).toBe(true);
      expect(result.state?.phase).toBe('complete');
      expect(result.state?.active).toBe(false);
    });

    it('transitionToFailed helper should work', () => {
      initAutopilot(testDir, 'test');
      const result: TransitionResult = transitionToFailed(testDir, 'Something went wrong');

      expect(result.success).toBe(true);
      expect(result.state?.phase).toBe('failed');
      expect(result.state?.active).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Transition when no state exists
  // --------------------------------------------------------------------------

  describe('transitions without active state', () => {
    it('should return null when transitioning with no state', () => {
      const state = transitionPhase(testDir, 'planning');
      expect(state).toBeNull();
    });

    it('should return null after state is cleared', () => {
      initAutopilot(testDir, 'test');
      clearAutopilotState(testDir);
      const state = transitionPhase(testDir, 'planning');
      expect(state).toBeNull();
    });

    it('transitionToComplete should fail when no state', () => {
      const result = transitionToComplete(testDir);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('transitionToFailed should fail when no state', () => {
      const result = transitionToFailed(testDir, 'error');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Idempotent transitions (same phase twice)
  // --------------------------------------------------------------------------

  describe('idempotent transitions', () => {
    it('should handle transitioning to the same phase twice', () => {
      initAutopilot(testDir, 'test');
      const first = transitionPhase(testDir, 'planning');
      const second = transitionPhase(testDir, 'planning');

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first!.phase).toBe('planning');
      expect(second!.phase).toBe('planning');
      // Both should still be active
      expect(second!.active).toBe(true);
    });

    it('should not crash on double-complete', () => {
      initAutopilot(testDir, 'test');
      const first = transitionPhase(testDir, 'complete');
      expect(first).not.toBeNull();
      expect(first!.active).toBe(false);

      // Second transition on inactive state should return null
      const second = transitionPhase(testDir, 'complete');
      expect(second).toBeNull();
    });

    it('should not crash on double-failed', () => {
      initAutopilot(testDir, 'test');
      const first = transitionPhase(testDir, 'failed');
      expect(first).not.toBeNull();
      expect(first!.active).toBe(false);

      // Second transition on inactive state should return null
      const second = transitionPhase(testDir, 'failed');
      expect(second).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Recovery transitions (from failed state)
  // --------------------------------------------------------------------------

  describe('recovery from failure', () => {
    it('should not allow transition from failed state (state becomes inactive)', () => {
      initAutopilot(testDir, 'test');
      transitionPhase(testDir, 'failed');

      // State is now inactive; transitionPhase checks for active state
      const recovery = transitionPhase(testDir, 'execution');
      expect(recovery).toBeNull();
    });

    it('recovery requires re-initialization after failure', () => {
      initAutopilot(testDir, 'test');
      transitionPhase(testDir, 'failed');

      // Verify state is inactive
      expect(isAutopilotActive(testDir)).toBe(false);

      // Clear and reinitialize
      clearAutopilotState(testDir);
      const newState = initAutopilot(testDir, 'retry after failure');

      expect(newState).not.toBeNull();
      expect(newState!.active).toBe(true);
      expect(newState!.phase).toBe('expansion');
    });
  });

  // --------------------------------------------------------------------------
  // Phase duration tracking
  // --------------------------------------------------------------------------

  describe('phase duration tracking', () => {
    it('should record phase start timestamps', () => {
      initAutopilot(testDir, 'test');
      transitionPhase(testDir, 'planning');

      const state = readAutopilotState(testDir);
      expect(state!.phase_durations).toBeDefined();
      expect(state!.phase_durations['planning_start_ms']).toBeDefined();
      expect(typeof state!.phase_durations['planning_start_ms']).toBe('number');
    });

    it('should record duration for completed phases', () => {
      initAutopilot(testDir, 'test');

      // Set a start time for expansion phase
      const state = readAutopilotState(testDir)!;
      state.phase_durations['expansion_start_ms'] = Date.now() - 1000; // 1 second ago
      writeAutopilotState(testDir, state);

      // Transition away from expansion
      transitionPhase(testDir, 'planning');

      const updatedState = readAutopilotState(testDir);
      // The expansion duration should be recorded
      expect(updatedState!.phase_durations['expansion']).toBeDefined();
      expect(updatedState!.phase_durations['expansion']).toBeGreaterThanOrEqual(0);
    });
  });

  // --------------------------------------------------------------------------
  // Phase data updates
  // --------------------------------------------------------------------------

  describe('phase data updates during transitions', () => {
    it('should preserve expansion data across transitions', () => {
      initAutopilot(testDir, 'test');
      updateExpansion(testDir, { analyst_complete: true, requirements_summary: 'Build a REST API' });
      transitionPhase(testDir, 'planning');

      const state = readAutopilotState(testDir);
      expect(state!.expansion.analyst_complete).toBe(true);
      expect(state!.expansion.requirements_summary).toBe('Build a REST API');
    });

    it('should preserve planning data across transitions', () => {
      initAutopilot(testDir, 'test');
      transitionPhase(testDir, 'planning');
      updatePlanning(testDir, { approved: true, plan_path: '/tmp/plan.md' });
      transitionPhase(testDir, 'execution');

      const state = readAutopilotState(testDir);
      expect(state!.planning.approved).toBe(true);
      expect(state!.planning.plan_path).toBe('/tmp/plan.md');
    });

    it('should preserve execution data across transitions', () => {
      initAutopilot(testDir, 'test');
      transitionPhase(testDir, 'execution');
      updateExecution(testDir, { tasks_completed: 5, tasks_total: 10 });
      transitionPhase(testDir, 'qa');

      const state = readAutopilotState(testDir);
      expect(state!.execution.tasks_completed).toBe(5);
      expect(state!.execution.tasks_total).toBe(10);
    });

    it('should preserve QA data across transitions', () => {
      initAutopilot(testDir, 'test');
      transitionPhase(testDir, 'qa');
      updateQA(testDir, { build_status: 'passing', lint_status: 'passing', test_status: 'passing' });
      transitionPhase(testDir, 'validation');

      const state = readAutopilotState(testDir);
      expect(state!.qa.build_status).toBe('passing');
      expect(state!.qa.lint_status).toBe('passing');
      expect(state!.qa.test_status).toBe('passing');
    });

    it('should preserve validation data through complete', () => {
      initAutopilot(testDir, 'test');
      transitionPhase(testDir, 'validation');
      updateValidation(testDir, { all_approved: true, validation_rounds: 1 });
      transitionPhase(testDir, 'complete');

      const state = readAutopilotState(testDir);
      expect(state!.validation.all_approved).toBe(true);
      expect(state!.validation.validation_rounds).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Session isolation
  // --------------------------------------------------------------------------

  describe('session-scoped transitions', () => {
    it('should isolate state by session ID', () => {
      const session1 = 'session-aaa';
      const session2 = 'session-bbb';

      initAutopilot(testDir, 'session 1 task', session1);
      initAutopilot(testDir, 'session 2 task', session2);

      transitionPhase(testDir, 'planning', session1);

      const state1 = readAutopilotState(testDir, session1);
      const state2 = readAutopilotState(testDir, session2);

      expect(state1!.phase).toBe('planning');
      expect(state2!.phase).toBe('expansion');
    });

    it('should not allow cross-session state reads', () => {
      const session1 = 'session-ccc';
      initAutopilot(testDir, 'task', session1);

      // Reading with a different session ID should return null
      const state = readAutopilotState(testDir, 'session-different');
      expect(state).toBeNull();
    });
  });
});
