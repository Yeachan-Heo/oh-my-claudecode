import { existsSync, readFileSync, unlinkSync } from 'fs';
import { atomicWriteJsonSync } from '../../lib/atomic-write.js';
import { ensureSessionStateDir, resolveSessionStatePath } from '../../lib/worktree-paths.js';
import { readCanonicalTeamStateCandidate } from '../team-canonical-state.js';
import type {
  TeamPipelineState,
  TeamPipelinePhase,
  TeamTransitionResult,
  TeamPhaseHistoryEntry,
  TeamPipelineProfile,
  TeamPipelineRiskLevel,
  TeamPipelineCompatibilityStatus,
  TeamPipelineProvisioningMode,
  TeamPipelineCriticVerdict,
  TeamPipelineSubphase,
  TeamPipelineStrategyMetrics,
} from './types.js';
import { TEAM_PIPELINE_SCHEMA_VERSION } from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

const DEFAULT_MAX_REWINDS = 2;

const TEAM_PIPELINE_SUBPHASES: readonly TeamPipelineSubphase[] = [
  'intake',
  'capability-map',
  'weighted-ranking',
  'compatibility-check',
  'research',
  'critic-gate',
  'provision-plan',
  'provision-verify',
] as const;

const TEAM_PIPELINE_RISK_LEVELS: readonly TeamPipelineRiskLevel[] = ['low', 'medium', 'high', 'critical'] as const;
const TEAM_PIPELINE_COMPAT_STATUSES: readonly TeamPipelineCompatibilityStatus[] = [
  'compatible',
  'risky',
  'blocked',
  'unknown',
] as const;
const TEAM_PIPELINE_PROVISIONING_MODES: readonly TeamPipelineProvisioningMode[] = ['standard', 'strict-gate'] as const;
const TEAM_PIPELINE_PROFILES: readonly TeamPipelineProfile[] = ['default', 'product-pipeline', 'backend-pipeline'] as const;
const TEAM_PIPELINE_CRITIC_VERDICTS: readonly TeamPipelineCriticVerdict[] = ['approve', 'revise', 'rewind'] as const;

function asStringArrayIncludes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function clamp01(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return fallback;
  }
  return value;
}

function normalizeStrategyMetrics(
  value: unknown,
): TeamPipelineStrategyMetrics {
  const metrics = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
  return {
    requirements_completeness: clamp01(metrics.requirements_completeness, 1),
    unknown_critical_inputs: nonNegativeInteger(metrics.unknown_critical_inputs, 0),
    top2_score_gap: typeof metrics.top2_score_gap === 'number' && Number.isFinite(metrics.top2_score_gap)
      ? Number(metrics.top2_score_gap)
      : 100,
    has_fresh_external_validation: metrics.has_fresh_external_validation === true,
  };
}

function defaultArtifacts(state?: Partial<TeamPipelineState>): TeamPipelineState['artifacts'] {
  return {
    plan_path: state?.artifacts?.plan_path ?? null,
    prd_path: state?.artifacts?.prd_path ?? null,
    verify_report_path: state?.artifacts?.verify_report_path ?? null,
    scorecard_path: state?.artifacts?.scorecard_path ?? null,
    compatibility_report_path: state?.artifacts?.compatibility_report_path ?? null,
    risk_register_path: state?.artifacts?.risk_register_path ?? null,
    handoff_path: state?.artifacts?.handoff_path ?? null,
    critic_verdict_path: state?.artifacts?.critic_verdict_path ?? null,
  };
}

function defaultSubphaseForPhase(phase: TeamPipelinePhase): TeamPipelineSubphase {
  switch (phase) {
    case 'team-plan':
      return 'intake';
    case 'team-prd':
      return 'capability-map';
    case 'team-exec':
      return 'weighted-ranking';
    case 'team-verify':
      return 'critic-gate';
    case 'team-fix':
      return 'capability-map';
    default:
      return 'provision-verify';
  }
}

function normalizeProfile(value: unknown): TeamPipelineProfile {
  if (asStringArrayIncludes(TEAM_PIPELINE_PROFILES, value)) {
    return value;
  }
  return 'default';
}

function normalizeRiskLevel(value: unknown): TeamPipelineRiskLevel {
  if (asStringArrayIncludes(TEAM_PIPELINE_RISK_LEVELS, value)) {
    return value;
  }
  return 'medium';
}

function normalizeCompatibilityStatus(value: unknown): TeamPipelineCompatibilityStatus {
  if (asStringArrayIncludes(TEAM_PIPELINE_COMPAT_STATUSES, value)) {
    return value;
  }
  return 'unknown';
}

function normalizeProvisioningMode(value: unknown): TeamPipelineProvisioningMode {
  if (asStringArrayIncludes(TEAM_PIPELINE_PROVISIONING_MODES, value)) {
    return value;
  }
  return 'strict-gate';
}

function normalizeCriticVerdict(value: unknown): TeamPipelineCriticVerdict | null {
  if (asStringArrayIncludes(TEAM_PIPELINE_CRITIC_VERDICTS, value)) {
    return value;
  }
  return null;
}

export function hydrateTeamPipelineState(
  state: Partial<TeamPipelineState>,
  defaults?: Partial<Pick<TeamPipelineState, 'project_path' | 'session_id' | 'phase'>>,
): TeamPipelineState {
  const phase: TeamPipelinePhase = (typeof state.phase === 'string'
    ? state.phase
    : defaults?.phase || 'team-plan') as TeamPipelinePhase;
  const profile = normalizeProfile(state.pipeline_profile);
  const currentSubphase = asStringArrayIncludes(TEAM_PIPELINE_SUBPHASES, state.current_subphase)
    ? state.current_subphase
    : defaultSubphaseForPhase(phase);
  const maxRewinds = Math.max(1, nonNegativeInteger(state.max_rewinds, DEFAULT_MAX_REWINDS));
  const rewindCount = Math.min(nonNegativeInteger(state.rewind_count, 0), maxRewinds);
  const normalized: TeamPipelineState = {
    schema_version: TEAM_PIPELINE_SCHEMA_VERSION,
    mode: 'team',
    active: state.active === true,
    session_id: typeof state.session_id === 'string'
      ? state.session_id
      : (defaults?.session_id ?? ''),
    project_path: typeof state.project_path === 'string'
      ? state.project_path
      : (defaults?.project_path ?? ''),
    phase,
    phase_history: Array.isArray(state.phase_history) && state.phase_history.length > 0
      ? state.phase_history as TeamPhaseHistoryEntry[]
      : [{ phase, entered_at: nowIso() }],
    pipeline_profile: profile,
    current_subphase: currentSubphase,
    strategy_iteration: Math.max(1, nonNegativeInteger(state.strategy_iteration, 1)),
    rewind_count: rewindCount,
    max_rewinds: maxRewinds,
    risk_level: normalizeRiskLevel(state.risk_level),
    confidence: clamp01(state.confidence, 0),
    research_required: state.research_required === true,
    compatibility_status: normalizeCompatibilityStatus(state.compatibility_status),
    provisioning_mode: normalizeProvisioningMode(state.provisioning_mode),
    last_critic_verdict: normalizeCriticVerdict(state.last_critic_verdict),
    strategy_metrics: normalizeStrategyMetrics(state.strategy_metrics),
    iteration: Math.max(1, nonNegativeInteger(state.iteration, 1)),
    max_iterations: Math.max(1, nonNegativeInteger(state.max_iterations, 25)),
    artifacts: defaultArtifacts(state),
    execution: {
      workers_total: nonNegativeInteger(state.execution?.workers_total, 0),
      workers_active: nonNegativeInteger(state.execution?.workers_active, 0),
      tasks_total: nonNegativeInteger(state.execution?.tasks_total, 0),
      tasks_completed: nonNegativeInteger(state.execution?.tasks_completed, 0),
      tasks_failed: nonNegativeInteger(state.execution?.tasks_failed, 0),
    },
    fix_loop: {
      attempt: nonNegativeInteger(state.fix_loop?.attempt, 0),
      max_attempts: Math.max(1, nonNegativeInteger(state.fix_loop?.max_attempts, 3)),
      last_failure_reason: typeof state.fix_loop?.last_failure_reason === 'string'
        ? state.fix_loop.last_failure_reason
        : null,
    },
    cancel: {
      requested: state.cancel?.requested === true,
      requested_at: typeof state.cancel?.requested_at === 'string'
        ? state.cancel.requested_at
        : null,
      preserve_for_resume: state.cancel?.preserve_for_resume === true,
    },
    started_at: typeof state.started_at === 'string' ? state.started_at : nowIso(),
    updated_at: typeof state.updated_at === 'string' ? state.updated_at : nowIso(),
    completed_at: typeof state.completed_at === 'string' ? state.completed_at : null,
  };
  return normalized;
}

function getTeamStatePath(directory: string, sessionId?: string): string {
  if (!sessionId) {
    return `${directory}/.omc/state/team-state.json`;
  }
  return resolveSessionStatePath('team', sessionId, directory);
}

function isTerminalTeamPipelineState(state: TeamPipelineState): boolean {
  return state.phase === 'complete' || state.phase === 'failed' || state.phase === 'cancelled';
}

function synthesizeCanonicalTeamPipelineState(
  directory: string,
  candidate: NonNullable<ReturnType<typeof readCanonicalTeamStateCandidate>>,
): TeamPipelineState {
  const now = candidate.updatedAt || candidate.startedAt || new Date().toISOString();
  return hydrateTeamPipelineState({
    schema_version: TEAM_PIPELINE_SCHEMA_VERSION,
    mode: 'team',
    active: candidate.active,
    session_id: candidate.sessionId,
    project_path: candidate.leaderCwd ?? directory,
    phase: candidate.stage,
    phase_history: [{
      phase: candidate.stage,
      entered_at: candidate.startedAt || now,
    }],
    iteration: 1,
    max_iterations: 25,
    pipeline_profile: 'default',
    current_subphase: defaultSubphaseForPhase(candidate.stage),
    strategy_iteration: 1,
    rewind_count: 0,
    max_rewinds: DEFAULT_MAX_REWINDS,
    risk_level: 'medium',
    confidence: 0,
    research_required: false,
    compatibility_status: 'unknown',
    provisioning_mode: 'strict-gate',
    last_critic_verdict: null,
    strategy_metrics: normalizeStrategyMetrics(null),
    artifacts: defaultArtifacts(),
    execution: {
      workers_total: 0,
      workers_active: 0,
      tasks_total: 0,
      tasks_completed: 0,
      tasks_failed: 0,
    },
    fix_loop: {
      attempt: 0,
      max_attempts: 3,
      last_failure_reason: null,
    },
    cancel: {
      requested: false,
      requested_at: null,
      preserve_for_resume: false,
    },
    started_at: candidate.startedAt || now,
    updated_at: candidate.updatedAt || now,
    completed_at: candidate.active ? null : (candidate.updatedAt || now),
  });
}

export function initTeamPipelineState(
  directory: string,
  sessionId: string,
  options?: Partial<Pick<TeamPipelineState, 'project_path' | 'max_iterations' | 'pipeline_profile' | 'provisioning_mode'>>
): TeamPipelineState {
  const ts = nowIso();
  const phase: TeamPipelinePhase = 'team-plan';
  return hydrateTeamPipelineState({
    schema_version: TEAM_PIPELINE_SCHEMA_VERSION,
    mode: 'team',
    active: true,
    session_id: sessionId,
    project_path: options?.project_path ?? directory,
    phase,
    phase_history: [{ phase, entered_at: ts }],
    pipeline_profile: options?.pipeline_profile ?? 'default',
    current_subphase: defaultSubphaseForPhase(phase),
    strategy_iteration: 1,
    rewind_count: 0,
    max_rewinds: DEFAULT_MAX_REWINDS,
    risk_level: 'medium',
    confidence: 0,
    research_required: false,
    compatibility_status: 'unknown',
    provisioning_mode: options?.provisioning_mode ?? 'strict-gate',
    last_critic_verdict: null,
    strategy_metrics: normalizeStrategyMetrics(null),
    iteration: 1,
    max_iterations: options?.max_iterations ?? 25,
    artifacts: defaultArtifacts(),
    execution: {
      workers_total: 0,
      workers_active: 0,
      tasks_total: 0,
      tasks_completed: 0,
      tasks_failed: 0,
    },
    fix_loop: {
      attempt: 0,
      max_attempts: 3,
      last_failure_reason: null,
    },
    cancel: {
      requested: false,
      requested_at: null,
      preserve_for_resume: false,
    },
    started_at: ts,
    updated_at: ts,
    completed_at: null,
  });
}

export function readTeamPipelineState(directory: string, sessionId?: string): TeamPipelineState | null {
  if (!sessionId) {
    return null;
  }

  let coarseState: TeamPipelineState | null = null;
  const statePath = getTeamStatePath(directory, sessionId);
  if (existsSync(statePath)) {
    try {
      const content = readFileSync(statePath, 'utf-8');
      const parsed = JSON.parse(content) as Partial<TeamPipelineState> & Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && (!parsed.session_id || parsed.session_id === sessionId)) {
        const state = hydrateTeamPipelineState(parsed, {
          session_id: sessionId,
          project_path: directory,
          phase: 'team-plan',
        });
        coarseState = state;
        if (state.active === true && !isTerminalTeamPipelineState(state)) {
          return state;
        }
      }
    } catch {
      // fall through to canonical fallback
    }
  }

  const canonical = readCanonicalTeamStateCandidate(directory, sessionId);
  if (canonical) {
    return synthesizeCanonicalTeamPipelineState(directory, canonical);
  }

  return coarseState;
}

export function writeTeamPipelineState(directory: string, state: TeamPipelineState, sessionId?: string): boolean {
  if (!sessionId) {
    return false;
  }

  try {
    ensureSessionStateDir(sessionId, directory);
    const statePath = getTeamStatePath(directory, sessionId);
    const next = hydrateTeamPipelineState({
      ...state,
      session_id: sessionId,
      mode: 'team',
      schema_version: TEAM_PIPELINE_SCHEMA_VERSION,
      updated_at: nowIso(),
    }, {
      session_id: sessionId,
      project_path: directory,
      phase: state.phase,
    });
    atomicWriteJsonSync(statePath, next);
    return true;
  } catch {
    return false;
  }
}

export function clearTeamPipelineState(directory: string, sessionId?: string): boolean {
  if (!sessionId) {
    return false;
  }

  const statePath = getTeamStatePath(directory, sessionId);
  try {
    if (existsSync(statePath)) {
      unlinkSync(statePath);
    }
    return true;
  } catch {
    return false;
  }
}

export function markTeamPhase(
  state: TeamPipelineState,
  nextPhase: TeamPipelinePhase,
  reason?: string,
): TeamTransitionResult {
  // Idempotent: if already in target phase, return success without mutating state.
  // Exception: team-fix -> team-fix is a retry increment and must not short-circuit.
  if (state.phase === nextPhase && nextPhase !== 'team-fix') {
    return { ok: true, state };
  }

  const updated = hydrateTeamPipelineState({ ...state }, {
    session_id: state.session_id,
    project_path: state.project_path,
    phase: state.phase,
  });
  updated.phase = nextPhase;
  if (updated.pipeline_profile === 'product-pipeline' || updated.pipeline_profile === 'backend-pipeline') {
    updated.current_subphase = defaultSubphaseForPhase(nextPhase);
  }

  const historyEntry: TeamPhaseHistoryEntry = {
    phase: nextPhase,
    entered_at: nowIso(),
    ...(reason ? { reason } : {}),
  };

  updated.phase_history = [...updated.phase_history, historyEntry];

  if (nextPhase === 'complete' || nextPhase === 'failed' || nextPhase === 'cancelled') {
    updated.active = false;
    updated.completed_at = nowIso();
  }

  if (nextPhase === 'team-fix') {
    updated.fix_loop = {
      ...updated.fix_loop,
      attempt: updated.fix_loop.attempt + 1,
    };
    updated.rewind_count = Math.min(updated.rewind_count + 1, updated.max_rewinds);
    updated.last_critic_verdict = 'rewind';
  }

  updated.updated_at = nowIso();

  if (updated.fix_loop.attempt > updated.fix_loop.max_attempts) {
    const failed = {
      ...updated,
      phase: 'failed' as const,
      active: false,
      completed_at: nowIso(),
      updated_at: nowIso(),
      fix_loop: {
        ...updated.fix_loop,
        last_failure_reason: updated.fix_loop.last_failure_reason ?? 'fix-loop-max-attempts-exceeded',
      },
      phase_history: [
        ...updated.phase_history,
        {
          phase: 'failed' as const,
          entered_at: nowIso(),
          reason: 'fix-loop-max-attempts-exceeded',
        },
      ],
    };

    return {
      ok: false,
      state: failed,
      reason: 'Fix loop exceeded max_attempts',
    };
  }

  return { ok: true, state: updated };
}
