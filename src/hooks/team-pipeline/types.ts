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

export type TeamPipelineProfile = 'default' | 'product-pipeline' | 'backend-pipeline';

export type TeamPipelineSubphase =
  | 'intake'
  | 'capability-map'
  | 'weighted-ranking'
  | 'compatibility-check'
  | 'research'
  | 'critic-gate'
  | 'provision-plan'
  | 'provision-verify';

export type TeamPipelineRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type TeamPipelineCompatibilityStatus = 'compatible' | 'risky' | 'blocked' | 'unknown';

export type TeamPipelineProvisioningMode = 'standard' | 'strict-gate';

export type TeamPipelineCriticVerdict = 'approve' | 'revise' | 'rewind';

export interface TeamPhaseHistoryEntry {
  phase: TeamPipelinePhase;
  entered_at: string;
  reason?: string;
}

export interface TeamPipelineArtifacts {
  plan_path: string | null;
  prd_path: string | null;
  verify_report_path: string | null;
  scorecard_path: string | null;
  compatibility_report_path: string | null;
  risk_register_path: string | null;
  handoff_path: string | null;
  critic_verdict_path: string | null;
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

export interface TeamPipelineStrategyMetrics {
  requirements_completeness: number;
  unknown_critical_inputs: number;
  top2_score_gap: number;
  has_fresh_external_validation: boolean;
}

export interface TeamPipelineState {
  schema_version: number;
  mode: 'team';
  active: boolean;
  session_id: string;
  project_path: string;

  phase: TeamPipelinePhase;
  phase_history: TeamPhaseHistoryEntry[];
  pipeline_profile: TeamPipelineProfile;
  current_subphase: TeamPipelineSubphase;
  strategy_iteration: number;
  rewind_count: number;
  max_rewinds: number;
  risk_level: TeamPipelineRiskLevel;
  confidence: number;
  research_required: boolean;
  compatibility_status: TeamPipelineCompatibilityStatus;
  provisioning_mode: TeamPipelineProvisioningMode;
  last_critic_verdict: TeamPipelineCriticVerdict | null;
  strategy_metrics: TeamPipelineStrategyMetrics;

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
