import { describe, it, expect } from 'vitest';
import { initTeamPipelineState, markTeamPhase } from '../state.js';
import {
  transitionTeamPhase,
  isNonNegativeFiniteInteger,
  evaluateTeamRoutingDecision,
  updateTeamStrategyMetrics,
  applyTeamCriticVerdict,
  transitionTeamSubphase,
} from '../transitions.js';

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

  it('initializes profile/subphase defaults for strategy control plane', () => {
    const state = initTeamPipelineState('/tmp/project', 'sid-init');
    expect(state.pipeline_profile).toBe('default');
    expect(state.current_subphase).toBe('intake');
    expect(state.max_rewinds).toBe(2);
    expect(state.provisioning_mode).toBe('strict-gate');
    expect(state.strategy_metrics.requirements_completeness).toBe(1);
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

describe('strategy routing and critic rewind', () => {
  it('routes to deep-interview when requirements are incomplete', () => {
    const base = initTeamPipelineState('/tmp/project', 'sid-route-1', {
      pipeline_profile: 'product-pipeline',
    });
    const state = updateTeamStrategyMetrics(base, {
      requirements_completeness: 0.7,
      unknown_critical_inputs: 2,
    });
    const decision = evaluateTeamRoutingDecision(state);
    expect(decision.next_agent).toBe('deep-interview');
    expect(decision.target_subphase).toBe('intake');
  });

  it('routes to researcher alias when score gap is narrow', () => {
    const base = initTeamPipelineState('/tmp/project', 'sid-route-2', {
      pipeline_profile: 'backend-pipeline',
    });
    const ranked = transitionTeamSubphase(base, 'compatibility-check');
    expect(ranked.ok).toBe(true);
    const state = updateTeamStrategyMetrics(ranked.state, {
      top2_score_gap: 4,
      has_fresh_external_validation: true,
    });
    const decision = evaluateTeamRoutingDecision(state);
    expect(decision.next_agent).toBe('document-specialist');
    expect(decision.target_subphase).toBe('research');
  });

  it('applies critic rewind and invalidates downstream artifacts', () => {
    const base = initTeamPipelineState('/tmp/project', 'sid-critic-1', {
      pipeline_profile: 'product-pipeline',
    });
    const prepared = {
      ...base,
      current_subphase: 'critic-gate' as const,
      artifacts: {
        ...base.artifacts,
        scorecard_path: '.omc/scorecard.json',
        compatibility_report_path: '.omc/compat.json',
        verify_report_path: '.omc/verify.json',
      },
    };
    const rewound = applyTeamCriticVerdict(prepared, 'rewind');
    expect(rewound.ok).toBe(true);
    expect(rewound.state.rewind_count).toBe(1);
    expect(rewound.state.current_subphase).toBe('capability-map');
    expect(rewound.state.artifacts.scorecard_path).toBeNull();
    expect(rewound.state.artifacts.compatibility_report_path).toBeNull();
    expect(rewound.state.artifacts.verify_report_path).toBeNull();
  });

  it('enforces hard rewind limit and requires human gate', () => {
    const base = initTeamPipelineState('/tmp/project', 'sid-critic-2', {
      pipeline_profile: 'backend-pipeline',
    });
    const exhausted = {
      ...base,
      current_subphase: 'critic-gate' as const,
      rewind_count: 2,
      max_rewinds: 2,
    };
    const blocked = applyTeamCriticVerdict(exhausted, 'rewind');
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain('deep-interview + human decision gate required');
  });

  it('moves to provision-plan on critic approval', () => {
    const base = initTeamPipelineState('/tmp/project', 'sid-critic-3', {
      pipeline_profile: 'product-pipeline',
    });
    const prepared = transitionTeamSubphase(base, 'critic-gate');
    expect(prepared.ok).toBe(true);
    const approved = applyTeamCriticVerdict(prepared.state, 'approve');
    expect(approved.ok).toBe(true);
    expect(approved.state.current_subphase).toBe('provision-plan');
  });
});
