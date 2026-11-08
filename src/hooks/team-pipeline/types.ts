/**
 * Team Pipeline Types
 *
 * Canonical staged Team runtime state.
 */

export const TEAM_PIPELINE_SCHEMA_VERSION = 1;

export type TeamPipelinePhase =
  | 'team-plan'
  | 'team-prd'
  | 'team-exec'
  | 'team-verify'
  | 'team-fix'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface TeamPhaseHistoryEntry {
  phase: TeamPipelinePhase;
  entered_at: string;
  reason?: string;
}

export interface TeamPipelineArtifacts {
  plan_path: string | null;
  prd_path: string | null;
  verify_report_path: string | null;
}

export interface TeamPipelineExecution {
  workers_total: number;
  workers_active: number;
  tasks_total: number;
  tasks_completed: number;
  tasks_failed: number;
}

export interface TeamPipelineFixLoop {
  attempt: number;
  max_attempts: number;
  last_failure_reason: string | null;
}

export interface TeamPipelineCancel {
  requested: boolean;
  requested_at: string | null;
  preserve_for_resume: boolean;
}

export interface TeamPipelineState {
  schema_version: number;
  mode: 'team';
  active: boolean;
  session_id: string;
  project_path: string;

  phase: TeamPipelinePhase;
  phase_history: TeamPhaseHistoryEntry[];

  iteration: number;
  max_iterations: number;

  artifacts: TeamPipelineArtifacts;
  execution: TeamPipelineExecution;
  fix_loop: TeamPipelineFixLoop;
  cancel: TeamPipelineCancel;

  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TeamTransitionResult {
  ok: boolean;
  state: TeamPipelineState;
  reason?: string;
}
