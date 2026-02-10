import { describe, it, expect } from 'vitest';
import { initTeamPipelineState, markTeamPhase } from '../state.js';
import { transitionTeamPhase, isNonNegativeFiniteInteger } from '../transitions.js';

describe('team pipeline transitions', () => {
  it('allows canonical plan -> prd -> exec transitions', () => {
    const state = initTeamPipelineState('/tmp/project', 'sid-1');
    const toPrd = transitionTeamPhase(state, 'team-prd');
    expect(toPrd.ok).toBe(true);

    const withPlan = {
      ...toPrd.state,
      artifacts: { ...toPrd.state.artifacts, plan_path: '.omc/plans/team.md' },
    };
    const toExec = transitionTeamPhase(withPlan, 'team-exec');
    expect(toExec.ok).toBe(true);
    expect(toExec.state.phase).toBe('team-exec');
  });

  it('rejects illegal transition', () => {
    const state = initTeamPipelineState('/tmp/project', 'sid-2');
    const result = transitionTeamPhase(state, 'team-verify');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Illegal transition');
  });

  it('bounds fix loop and transitions to failed on overflow', () => {
    const state = initTeamPipelineState('/tmp/project', 'sid-3');
    const verifyState = {
      ...state,
      phase: 'team-verify' as const,
      artifacts: { ...state.artifacts, plan_path: '.omc/plans/team.md' },
    };

    const toFix1 = transitionTeamPhase(verifyState, 'team-fix');
    expect(toFix1.ok).toBe(true);

    const exhausted = {
      ...toFix1.state,
      phase: 'team-fix' as const,
      fix_loop: { ...toFix1.state.fix_loop, attempt: toFix1.state.fix_loop.max_attempts },
    };

    const overflow = markTeamPhase(exhausted, 'team-fix', 'retry');
    expect(overflow.ok).toBe(false);
    expect(overflow.state.phase).toBe('failed');
    expect(overflow.reason).toContain('Fix loop exceeded');
  });
});

// ============================================================================
// isNonNegativeFiniteInteger helper
// ============================================================================

describe('isNonNegativeFiniteInteger', () => {
  it('accepts valid non-negative integers', () => {
    expect(isNonNegativeFiniteInteger(0)).toBe(true);
    expect(isNonNegativeFiniteInteger(1)).toBe(true);
    expect(isNonNegativeFiniteInteger(42)).toBe(true);
    expect(isNonNegativeFiniteInteger(1000000)).toBe(true);
  });

  it('rejects NaN', () => {
    expect(isNonNegativeFiniteInteger(NaN)).toBe(false);
  });

  it('rejects Infinity and -Infinity', () => {
    expect(isNonNegativeFiniteInteger(Infinity)).toBe(false);
    expect(isNonNegativeFiniteInteger(-Infinity)).toBe(false);
  });

  it('rejects negative numbers', () => {
    expect(isNonNegativeFiniteInteger(-1)).toBe(false);
    expect(isNonNegativeFiniteInteger(-100)).toBe(false);
  });

  it('rejects decimals', () => {
    expect(isNonNegativeFiniteInteger(1.5)).toBe(false);
    expect(isNonNegativeFiniteInteger(0.1)).toBe(false);
    expect(isNonNegativeFiniteInteger(3.14)).toBe(false);
  });

  it('rejects non-number types', () => {
    expect(isNonNegativeFiniteInteger('5')).toBe(false);
    expect(isNonNegativeFiniteInteger(null)).toBe(false);
    expect(isNonNegativeFiniteInteger(undefined)).toBe(false);
    expect(isNonNegativeFiniteInteger(true)).toBe(false);
    expect(isNonNegativeFiniteInteger({})).toBe(false);
  });
});

// ============================================================================
// Numeric guards on team-verify transition
// ============================================================================

describe('team-verify numeric guards', () => {
  function makeExecState(tasksTotal: unknown, tasksCompleted: unknown) {
    const base = initTeamPipelineState('/tmp/project', 'sid-num');
    return {
      ...base,
      phase: 'team-exec' as const,
      artifacts: { ...base.artifacts, plan_path: '.omc/plans/team.md' },
      execution: {
        ...base.execution,
        tasks_total: tasksTotal as number,
        tasks_completed: tasksCompleted as number,
      },
    };
  }

  it('accepts valid integer completion state', () => {
    const state = makeExecState(5, 5);
    const result = transitionTeamPhase(state, 'team-verify');
    expect(result.ok).toBe(true);
    expect(result.state.phase).toBe('team-verify');
  });

  it('rejects NaN tasks_total', () => {
    const state = makeExecState(NaN, 5);
    const result = transitionTeamPhase(state, 'team-verify');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('tasks_total');
    expect(result.reason).toContain('non-negative finite integer');
  });

  it('rejects Infinity tasks_total', () => {
    const state = makeExecState(Infinity, 5);
    const result = transitionTeamPhase(state, 'team-verify');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('tasks_total');
  });

  it('rejects negative tasks_total', () => {
    const state = makeExecState(-1, 0);
    const result = transitionTeamPhase(state, 'team-verify');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('tasks_total');
  });

  it('rejects decimal tasks_total', () => {
    const state = makeExecState(3.5, 3);
    const result = transitionTeamPhase(state, 'team-verify');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('tasks_total');
  });

  it('rejects NaN tasks_completed', () => {
    const state = makeExecState(5, NaN);
    const result = transitionTeamPhase(state, 'team-verify');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('tasks_completed');
  });

  it('rejects -Infinity tasks_completed', () => {
    const state = makeExecState(5, -Infinity);
    const result = transitionTeamPhase(state, 'team-verify');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('tasks_completed');
  });

  it('rejects decimal tasks_completed', () => {
    const state = makeExecState(5, 4.9);
    const result = transitionTeamPhase(state, 'team-verify');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('tasks_completed');
  });

  it('rejects zero tasks_total', () => {
    const state = makeExecState(0, 0);
    const result = transitionTeamPhase(state, 'team-verify');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('tasks_total must be > 0');
  });

  it('rejects incomplete tasks (completed < total)', () => {
    const state = makeExecState(10, 7);
    const result = transitionTeamPhase(state, 'team-verify');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('tasks_completed (7) < tasks_total (10)');
  });
});
