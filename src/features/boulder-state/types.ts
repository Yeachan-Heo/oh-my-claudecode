/**
 * Boulder State Types
 *
 * Manages the active work plan state for OMC orchestrator.
 * Named after OMC's boulder - the eternal task that must be rolled.
 *
 * Ported from oh-my-opencode's boulder-state.
 */

/**
 * State tracking for an active work plan
 */
export interface BoulderState {
  /** Absolute path to the active plan file */
  active_plan: string;
  /** ISO timestamp when work started */
  started_at: string;
  /** Session IDs that have worked on this plan */
  session_ids: string[];
  /** Plan name derived from filename */
  plan_name: string;
  /** Whether this boulder is currently active */
  active: boolean;
  /** ISO timestamp of last state update (for stale detection) */
  updatedAt: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Progress tracking for a plan's checkboxes
 */
export interface PlanProgress {
  /** Total number of checkboxes */
  total: number;
  /** Number of completed checkboxes */
  completed: number;
  /** Whether all tasks are done */
  isComplete: boolean;
}

/**
 * Summary of available plans
 */
export interface PlanSummary {
  /** Plan file path */
  path: string;
  /** Plan name */
  name: string;
  /** Progress stats */
  progress: PlanProgress;
  /** Last modified time */
  lastModified: Date;
}
