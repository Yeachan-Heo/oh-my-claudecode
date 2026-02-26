import { existsSync, readFileSync, unlinkSync } from 'fs';
import { atomicWriteJsonSync } from '../../lib/atomic-write.js';
import { ensureSessionStateDir, resolveSessionStatePath } from '../../lib/worktree-paths.js';
import type {
  TeamPipelineState,
  TeamPipelinePhase,
  TeamTransitionResult,
  TeamPhaseHistoryEntry,
} from './types.js';
import { TEAM_PIPELINE_SCHEMA_VERSION } from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function getTeamStatePath(directory: string, sessionId?: string): string {
  if (!sessionId) {
    return `${directory}/.omc/state/team-state.json`;
  }
  return resolveSessionStatePath('team', sessionId, directory);
}

export function initTeamPipelineState(
  directory: string,
  sessionId: string,
  options?: Partial<Pick<TeamPipelineState, 'project_path' | 'max_iterations'>>
): TeamPipelineState {
  const ts = nowIso();
  return {
    schema_version: TEAM_PIPELINE_SCHEMA_VERSION,
    mode: 'team',
    active: true,
    session_id: sessionId,
    project_path: options?.project_path ?? directory,
    phase: 'team-plan',
    phase_history: [{ phase: 'team-plan', entered_at: ts }],
    iteration: 1,
    max_iterations: options?.max_iterations ?? 25,
    artifacts: {
      plan_path: null,
      prd_path: null,
      verify_report_path: null,
    },
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
  };
}

export function readTeamPipelineState(directory: string, sessionId?: string): TeamPipelineState | null {
  if (!sessionId) {
    return null;
  }

  const statePath = getTeamStatePath(directory, sessionId);
  if (!existsSync(statePath)) {
    return null;
  }

  try {
    const content = readFileSync(statePath, 'utf-8');
    const state = JSON.parse(content) as TeamPipelineState;
    if (!state || typeof state !== 'object') return null;
    if (state.session_id && state.session_id !== sessionId) return null;
    return state;
  } catch {
    return null;
  }
}

export function writeTeamPipelineState(directory: string, state: TeamPipelineState, sessionId?: string): boolean {
  if (!sessionId) {
    return false;
  }

  try {
    ensureSessionStateDir(sessionId, directory);
    const statePath = getTeamStatePath(directory, sessionId);
    const next: TeamPipelineState = {
      ...state,
      session_id: sessionId,
      mode: 'team',
      schema_version: TEAM_PIPELINE_SCHEMA_VERSION,
      updated_at: nowIso(),
    };
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

  const updated = { ...state };
  updated.phase = nextPhase;

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
