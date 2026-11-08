/**
 * Ralphthon Types
 *
 * Autonomous hackathon lifecycle mode.
 * Deep-interview generates PRD, ralph loop executes tasks,
 * auto-hardening phase generates edge case/test/quality tasks,
 * terminates after N consecutive hardening waves with no new issues.
 */

// ============================================================================
// PRD Schema
// ============================================================================

/** Priority levels for stories and tasks */
export type TaskPriority = "critical" | "high" | "medium" | "low";

/** Status of an individual task */
export type TaskStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "skipped"
  | "failed";

/** Phase of the ralphthon lifecycle */
export type RalphthonPhase =
  | "interview"
  | "execution"
  | "hardening"
  | "complete"
  | "failed";

/**
 * A single actionable task within a story
 */
export interface RalphthonTask {
  /** Unique identifier (e.g., "T-001") */
  id: string;
  /** Short title */
  title: string;
  /** Detailed description of work to do */
  description: string;
  /** Current status */
  status: TaskStatus;
  /** Number of retry attempts used */
  retries: number;
  /** Optional notes from implementation */
  notes?: string;
}

/**
 * A user story containing multiple tasks
 */
export interface RalphthonStory {
  /** Unique identifier (e.g., "US-001") */
  id: string;
  /** Short title */
  title: string;
  /** Full user story description */
  description: string;
  /** Acceptance criteria */
  acceptanceCriteria: string[];
  /** Priority */
  priority: TaskPriority;
  /** Tasks that implement this story */
  tasks: RalphthonTask[];
}

/**
 * A hardening task generated during auto-hardening phase
 */
export interface HardeningTask {
  /** Unique identifier (e.g., "H-001") */
  id: string;
  /** Short title */
  title: string;
  /** What to harden (edge case, test, quality improvement) */
  description: string;
  /** Category of hardening */
  category: "edge_case" | "test" | "quality" | "security" | "performance";
  /** Current status */
  status: TaskStatus;
  /** Which hardening wave generated this task */
  wave: number;
  /** Number of retry attempts used */
  retries: number;
  /** Optional notes */
  notes?: string;
}

/**
 * Persisted planning/brownfield intake context.
 */
export interface RalphthonPlanningContext {
  /** Whether this work targets an existing codebase / brownfield surface */
  brownfield: boolean;
  /** Whether assumptions are explicitly captured in planning */
  assumptionsMode: "explicit" | "implicit";
  /** Short persisted summary of the brownfield/codebase-map intake */
  codebaseMapSummary: string;
  /** Constraints captured during planning intake */
  knownConstraints: string[];
}

/**
 * Configuration for the ralphthon run
 */
export interface RalphthonConfig {
  /** Maximum hardening waves before forced termination */
  maxWaves: number;
  /** Consecutive waves with no new issues before auto-termination */
  cleanWavesForTermination: number;
  /** Poll interval in milliseconds */
  pollIntervalMs: number;
  /** Idle detection threshold in milliseconds */
  idleThresholdMs: number;
  /** Maximum retries per task before skipping */
  maxRetries: number;
  /** Whether to skip the deep-interview phase */
  skipInterview: boolean;
}

/**
 * The full Ralphthon PRD document
 */
export interface RalphthonPRD {
  /** Project name */
  project: string;
  /** Git branch name */
  branchName: string;
  /** Overall description */
  description: string;
  /** User stories with tasks */
  stories: RalphthonStory[];
  /** Hardening tasks (populated during hardening phase) */
  hardening: HardeningTask[];
  /** Run configuration */
  config: RalphthonConfig;
  /** Brownfield planning context */
  planningContext?: RalphthonPlanningContext;
}

// ============================================================================
// Orchestrator State
// ============================================================================

/**
 * Tracks the state of a running ralphthon session
 */
export interface RalphthonState {
  /** Whether the session is active */
  active: boolean;
  /** Current lifecycle phase */
  phase: RalphthonPhase;
  /** Session ID for state isolation */
  sessionId?: string;
  /** Project working directory */
  projectPath: string;
  /** Path to the PRD file */
  prdPath: string;
  /** Tmux session name */
  tmuxSession: string;
  /** Tmux pane ID for the leader (Claude Code instance) */
  leaderPaneId: string;
  /** When the session started */
  startedAt: string;
  /** Current hardening wave number */
  currentWave: number;
  /** Number of consecutive clean hardening waves */
  consecutiveCleanWaves: number;
  /** ID of the task currently being worked on */
  currentTaskId?: string;
  /** Total tasks completed */
  tasksCompleted: number;
  /** Total tasks skipped (failed after max retries) */
  tasksSkipped: number;
  /** Last time idle was detected */
  lastIdleDetectedAt?: string;
  /** Last time a poll check was performed */
  lastPollAt?: string;
  /** Error message if phase is 'failed' */
  error?: string;
}

// ============================================================================
// Orchestrator Events
// ============================================================================

/** Events emitted by the orchestrator */
export type OrchestratorEvent =
  | { type: "task_injected"; taskId: string; taskTitle: string }
  | { type: "task_completed"; taskId: string }
  | { type: "task_failed"; taskId: string; retries: number }
  | { type: "task_skipped"; taskId: string; reason: string }
  | { type: "phase_transition"; from: RalphthonPhase; to: RalphthonPhase }
  | { type: "hardening_wave_start"; wave: number }
  | { type: "hardening_wave_end"; wave: number; newIssues: number }
  | { type: "idle_detected"; durationMs: number }
  | { type: "session_complete"; tasksCompleted: number; tasksSkipped: number }
  | { type: "error"; message: string };

/** Callback for orchestrator events */
export type OrchestratorEventHandler = (event: OrchestratorEvent) => void;

// ============================================================================
// CLI Options
// ============================================================================

/**
 * Parsed CLI options for omc ralphthon
 */
export interface RalphthonCliOptions {
  /** Resume an existing session */
  resume: boolean;
  /** Skip the deep-interview phase */
  skipInterview: boolean;
  /** Maximum hardening waves */
  maxWaves: number;
  /** Poll interval in seconds */
  pollInterval: number;
  /** Task description (positional argument) */
  task?: string;
}

// ============================================================================
// Defaults
// ============================================================================

export const RALPHTHON_DEFAULTS: RalphthonConfig = {
  maxWaves: 10,
  cleanWavesForTermination: 3,
  pollIntervalMs: 120_000, // 2 minutes
  idleThresholdMs: 30_000, // 30 seconds
  maxRetries: 3,
  skipInterview: false,
};

export const PRD_FILENAME = "ralphthon-prd.json";
