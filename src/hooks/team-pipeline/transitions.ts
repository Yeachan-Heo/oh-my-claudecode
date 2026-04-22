import type {
  TeamPipelinePhase,
  TeamPipelineState,
  TeamTransitionResult,
  TeamPipelineSubphase,
  TeamPipelineCriticVerdict,
  TeamPipelineRiskLevel,
} from './types.js';
import { hydrateTeamPipelineState, markTeamPhase } from './state.js';


const ALLOWED: Record<TeamPipelinePhase, TeamPipelinePhase[]> = {
  'team-plan': ['team-prd'],
  'team-prd': ['team-exec'],
  'team-exec': ['team-verify'],
  'team-verify': ['team-fix', 'complete', 'failed'],
  'team-fix': ['team-exec', 'team-verify', 'complete', 'failed'],
  complete: [],
  failed: [],
  cancelled: ['team-plan', 'team-exec'],
};

function isAllowedTransition(from: TeamPipelinePhase, to: TeamPipelinePhase): boolean {
  return ALLOWED[from].includes(to);
}

export const TEAM_STRATEGY_SUBPHASE_ORDER: readonly TeamPipelineSubphase[] = [
  'intake',
  'capability-map',
  'weighted-ranking',
  'compatibility-check',
  'research',
  'critic-gate',
  'provision-plan',
  'provision-verify',
] as const;

function nowIso(): string {
  return new Date().toISOString();
}

function subphaseIndex(subphase: TeamPipelineSubphase): number {
  return TEAM_STRATEGY_SUBPHASE_ORDER.indexOf(subphase);
}

function inferRiskLevel(state: TeamPipelineState): TeamPipelineRiskLevel {
  if (state.compatibility_status === 'blocked') {
    return 'critical';
  }
  if (state.compatibility_status === 'unknown' || state.strategy_metrics.unknown_critical_inputs >= 2) {
    return 'high';
  }
  if (state.compatibility_status === 'risky' || state.strategy_metrics.unknown_critical_inputs > 0) {
    return 'medium';
  }
  return 'low';
}

function inferConfidence(state: TeamPipelineState): number {
  const completeness = state.strategy_metrics.requirements_completeness;
  const penalty = Math.min(0.6, state.strategy_metrics.unknown_critical_inputs * 0.15);
  const freshnessBoost = state.strategy_metrics.has_fresh_external_validation ? 0.1 : 0;
  const compatPenalty = state.compatibility_status === 'blocked'
    ? 0.5
    : state.compatibility_status === 'unknown'
      ? 0.25
      : state.compatibility_status === 'risky'
        ? 0.1
        : 0;
  return Math.max(0, Math.min(1, completeness - penalty - compatPenalty + freshnessBoost));
}

function shouldRequireResearch(state: TeamPipelineState): boolean {
  return (
    state.strategy_metrics.top2_score_gap < 8 ||
    state.compatibility_status === 'unknown' ||
    !state.strategy_metrics.has_fresh_external_validation
  );
}

function nextSubphase(state: TeamPipelineState): TeamPipelineSubphase {
  const index = subphaseIndex(state.current_subphase);
  if (index < 0 || index === TEAM_STRATEGY_SUBPHASE_ORDER.length - 1) {
    return state.current_subphase;
  }
  if (state.current_subphase === 'compatibility-check' && !state.research_required) {
    return 'critic-gate';
  }
  return TEAM_STRATEGY_SUBPHASE_ORDER[index + 1];
}

function invalidateRewindArtifacts(state: TeamPipelineState): TeamPipelineState {
  return {
    ...state,
    artifacts: {
      ...state.artifacts,
      scorecard_path: null,
      compatibility_report_path: null,
      risk_register_path: null,
      verify_report_path: null,
      handoff_path: null,
      critic_verdict_path: null,
    },
  };
}

function withDerivedMetrics(state: TeamPipelineState): TeamPipelineState {
  const next = hydrateTeamPipelineState(state, {
    session_id: state.session_id,
    project_path: state.project_path,
    phase: state.phase,
  });
  return {
    ...next,
    research_required: shouldRequireResearch(next),
    risk_level: inferRiskLevel(next),
    confidence: inferConfidence(next),
    updated_at: nowIso(),
  };
}

export interface TeamRoutingDecision {
  next_agent: 'deep-interview' | 'technology-strategist' | 'document-specialist' | 'critic' | 'stack-provision' | 'human-decision-gate';
  target_subphase: TeamPipelineSubphase;
  action: 'advance' | 'stay' | 'rewind' | 'halt';
  reason: string;
}

/** Validates that a value is a non-negative finite integer */
export function isNonNegativeFiniteInteger(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0;
}

function hasRequiredArtifactsForPhase(state: TeamPipelineState, next: TeamPipelinePhase): string | null {
  if (next === 'team-exec') {
    if (!state.artifacts.plan_path && !state.artifacts.prd_path) {
      return 'team-exec requires plan_path or prd_path artifact';
    }
    return null;
  }
  if (next === 'team-verify') {
    if (!isNonNegativeFiniteInteger(state.execution.tasks_total)) {
      return `tasks_total must be a non-negative finite integer, got: ${state.execution.tasks_total}`;
    }
    if (!isNonNegativeFiniteInteger(state.execution.tasks_completed)) {
      return `tasks_completed must be a non-negative finite integer, got: ${state.execution.tasks_completed}`;
    }
    if (state.execution.tasks_total <= 0) {
      return 'tasks_total must be > 0 for team-verify transition';
    }
    if (state.execution.tasks_completed < state.execution.tasks_total) {
      return `tasks_completed (${state.execution.tasks_completed}) < tasks_total (${state.execution.tasks_total})`;
    }
    return null;
  }
  return null;
}

export function transitionTeamPhase(
  state: TeamPipelineState,
  next: TeamPipelinePhase,
  reason?: string,
): TeamTransitionResult {
  const hydrated = hydrateTeamPipelineState(state as unknown as Partial<TeamPipelineState> & Record<string, unknown>, {
    session_id: state.session_id,
    project_path: state.project_path,
    phase: state.phase,
  });

  if (!isAllowedTransition(hydrated.phase, next)) {
    return {
      ok: false,
      state: hydrated,
      reason: `Illegal transition: ${hydrated.phase} -> ${next}`,
    };
  }

  // When resuming from cancelled, require preserve_for_resume flag
  if (hydrated.phase === 'cancelled') {
    if (!hydrated.cancel.preserve_for_resume) {
      return {
        ok: false,
        state: hydrated,
        reason: `Cannot resume from cancelled: preserve_for_resume is not set`,
      };
    }
    // Re-activate the state on resume
    const resumed: TeamPipelineState = {
      ...hydrated,
      active: true,
      completed_at: null,
    };
    const resumedTransition = markTeamPhase(resumed, next, reason ?? 'resumed-from-cancelled');
    return {
      ...resumedTransition,
      state: withDerivedMetrics(resumedTransition.state),
    };
  }

  const guardFailure = hasRequiredArtifactsForPhase({
    ...hydrated,
    artifacts: state.artifacts ?? hydrated.artifacts,
    execution: state.execution ?? hydrated.execution,
  }, next);
  if (guardFailure !== null) {
    return {
      ok: false,
      state: hydrated,
      reason: guardFailure,
    };
  }

  // Ralph iteration is incremented in the persistent-mode stop-event handler,
  // not here, to avoid double-counting when team-fix triggers a ralph continuation.

  const transitioned = markTeamPhase(hydrated, next, reason);
  return {
    ...transitioned,
    state: withDerivedMetrics(transitioned.state),
  };
}

export function requestTeamCancel(state: TeamPipelineState, preserveForResume = true): TeamPipelineState {
  const hydrated = hydrateTeamPipelineState(state as unknown as Partial<TeamPipelineState> & Record<string, unknown>, {
    session_id: state.session_id,
    project_path: state.project_path,
    phase: state.phase,
  });
  return withDerivedMetrics({
    ...hydrated,
    cancel: {
      ...hydrated.cancel,
      requested: true,
      requested_at: new Date().toISOString(),
      preserve_for_resume: preserveForResume,
    },
    phase: 'cancelled',
    active: false,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    phase_history: [
      ...hydrated.phase_history,
      {
        phase: 'cancelled',
        entered_at: new Date().toISOString(),
        reason: 'cancel-requested',
      },
    ],
  });
}

export function transitionTeamSubphase(
  state: TeamPipelineState,
  next: TeamPipelineSubphase,
  reason?: string,
): TeamTransitionResult {
  const hydrated = withDerivedMetrics(state);
  const currentIndex = subphaseIndex(hydrated.current_subphase);
  const nextIndex = subphaseIndex(next);
  if (currentIndex === -1 || nextIndex === -1) {
    return {
      ok: false,
      state: hydrated,
      reason: `Unknown subphase transition: ${hydrated.current_subphase} -> ${next}`,
    };
  }
  if (nextIndex < currentIndex - 1) {
    return {
      ok: false,
      state: hydrated,
      reason: `Illegal subphase rewind without critic decision: ${hydrated.current_subphase} -> ${next}`,
    };
  }

  const nextState = withDerivedMetrics({
    ...hydrated,
    current_subphase: next,
    strategy_iteration: next === hydrated.current_subphase
      ? hydrated.strategy_iteration
      : hydrated.strategy_iteration + 1,
    phase_history: hydrated.phase_history,
    updated_at: nowIso(),
  });
  if (reason) {
    nextState.artifacts = {
      ...nextState.artifacts,
      handoff_path: nextState.artifacts.handoff_path,
    };
  }
  return { ok: true, state: nextState };
}

export function advanceTeamSubphase(
  state: TeamPipelineState,
  reason?: string,
): TeamTransitionResult {
  const hydrated = withDerivedMetrics(state);
  return transitionTeamSubphase(hydrated, nextSubphase(hydrated), reason);
}

export function updateTeamStrategyMetrics(
  state: TeamPipelineState,
  patch: Partial<TeamPipelineState['strategy_metrics']>,
): TeamPipelineState {
  const hydrated = hydrateTeamPipelineState(state as unknown as Partial<TeamPipelineState> & Record<string, unknown>, {
    session_id: state.session_id,
    project_path: state.project_path,
    phase: state.phase,
  });
  return withDerivedMetrics({
    ...hydrated,
    strategy_metrics: {
      ...hydrated.strategy_metrics,
      ...patch,
    },
  });
}

export function evaluateTeamRoutingDecision(state: TeamPipelineState): TeamRoutingDecision {
  const hydrated = withDerivedMetrics(state);
  const metrics = hydrated.strategy_metrics;
  const missingRequirements = metrics.requirements_completeness < 0.75 || metrics.unknown_critical_inputs >= 2;
  if (missingRequirements) {
    return {
      next_agent: 'deep-interview',
      target_subphase: 'intake',
      action: 'rewind',
      reason: 'Requirements are incomplete or have too many unknown critical inputs.',
    };
  }
  if (hydrated.compatibility_status === 'blocked') {
    return {
      next_agent: 'critic',
      target_subphase: 'critic-gate',
      action: 'halt',
      reason: 'Compatibility matrix contains blocked pairings; provisioning must not continue.',
    };
  }
  if (shouldRequireResearch(hydrated) && hydrated.current_subphase !== 'research') {
    return {
      next_agent: 'document-specialist',
      target_subphase: 'research',
      action: 'advance',
      reason: 'Low score gap / unknown compatibility / stale evidence requires researcher pass.',
    };
  }
  if (hydrated.current_subphase === 'critic-gate') {
    return {
      next_agent: 'critic',
      target_subphase: 'critic-gate',
      action: 'stay',
      reason: 'Critic gate is mandatory before provisioning.',
    };
  }
  if (hydrated.current_subphase === 'provision-plan' || hydrated.current_subphase === 'provision-verify') {
    return {
      next_agent: 'stack-provision',
      target_subphase: hydrated.current_subphase,
      action: 'stay',
      reason: 'Strategy checks are complete; continue strict provisioning flow.',
    };
  }
  return {
    next_agent: 'technology-strategist',
    target_subphase: hydrated.current_subphase,
    action: 'stay',
    reason: 'Technology strategist remains the primary owner until critic gate passes.',
  };
}

export function applyTeamCriticVerdict(
  state: TeamPipelineState,
  verdict: TeamPipelineCriticVerdict,
): TeamTransitionResult {
  const hydrated = withDerivedMetrics(state);
  if (verdict === 'approve') {
    return transitionTeamSubphase({
      ...hydrated,
      last_critic_verdict: 'approve',
      research_required: false,
    }, 'provision-plan', 'critic-approved');
  }

  if (verdict === 'revise') {
    return transitionTeamSubphase({
      ...hydrated,
      last_critic_verdict: 'revise',
    }, 'weighted-ranking', 'critic-revise');
  }

  if (hydrated.rewind_count >= hydrated.max_rewinds) {
    const blockedState = withDerivedMetrics({
      ...hydrated,
      last_critic_verdict: 'rewind',
      research_required: true,
      current_subphase: 'intake',
      risk_level: 'critical',
    });
    return {
      ok: false,
      state: blockedState,
      reason: 'Hard rewind limit exceeded; deep-interview + human decision gate required.',
    };
  }

  const rewound = withDerivedMetrics(invalidateRewindArtifacts({
    ...hydrated,
    last_critic_verdict: 'rewind',
    rewind_count: hydrated.rewind_count + 1,
    current_subphase: 'capability-map',
  }));
  return {
    ok: true,
    state: rewound,
    reason: 'critic-rewind',
  };
}
