/**
 * Autopilot Types
 *
 * Type definitions for the /autopilot command - autonomous execution from idea to working code.
 *
 * The autopilot feature orchestrates a complete development lifecycle:
 * 1. Expansion: Analyst + Architect expand the idea into detailed requirements
 * 2. Planning: Architect creates comprehensive execution plan
 * 3. Execution: Ralph + Ultrawork implement the plan
 * 4. QA: UltraQA ensures build/lint/tests pass
 * 5. Validation: Multiple specialized architects verify the implementation
 */

/**
 * Represents the current phase of autopilot execution
 */
export type AutopilotPhase =
  | 'expansion'    // Requirements gathering and spec creation
  | 'planning'     // Creating detailed execution plan
  | 'execution'    // Implementing the plan
  | 'qa'          // Quality assurance testing
  | 'validation'  // Final verification by architects
  | 'complete'    // Successfully completed
  | 'failed';     // Failed to complete

/**
 * QA test status for build, lint, and test phases
 */
export type QAStatus = 'pending' | 'passing' | 'failing';

/**
 * Type of validation performed by specialized architects
 */
export type ValidationVerdictType = 'functional' | 'security' | 'quality';

/**
 * Verdict from a validation check
 */
export type ValidationVerdict = 'APPROVED' | 'REJECTED' | 'NEEDS_FIX';

/**
 * Result from a single validation check
 */
export interface ValidationResult {
  /** Type of validation performed */
  type: ValidationVerdictType;
  /** Verdict from the validation */
  verdict: ValidationVerdict;
  /** List of issues found (if any) */
  issues?: string[];
}

/**
 * State tracking for the expansion phase
 */
export interface AutopilotExpansion {
  /** Whether analyst has completed requirements gathering */
  analyst_complete: boolean;
  /** Whether architect has completed technical design */
  architect_complete: boolean;
  /** Path to generated specification document */
  spec_path: string | null;
  /** Summary of gathered requirements */
  requirements_summary: string;
  /** Technology stack identified for the project */
  tech_stack: string[];
}

/**
 * State tracking for the planning phase
 */
export interface AutopilotPlanning {
  /** Path to generated execution plan */
  plan_path: string | null;
  /** Number of architect iterations during planning */
  architect_iterations: number;
  /** Whether the plan has been approved */
  approved: boolean;
}

/**
 * State tracking for the execution phase
 */
export interface AutopilotExecution {
  /** Number of ralph persistence iterations */
  ralph_iterations: number;
  /** Whether ultrawork parallel execution is active */
  ultrawork_active: boolean;
  /** Number of tasks completed from the plan */
  tasks_completed: number;
  /** Total number of tasks in the plan */
  tasks_total: number;
  /** List of files created during execution */
  files_created: string[];
  /** List of files modified during execution */
  files_modified: string[];
  /** Timestamp when ralph marked execution as complete */
  ralph_completed_at?: string;
}

/**
 * State tracking for the QA phase
 */
export interface AutopilotQA {
  /** Number of UltraQA test-fix cycles performed */
  ultraqa_cycles: number;
  /** Current build status */
  build_status: QAStatus;
  /** Current lint status */
  lint_status: QAStatus;
  /** Current test status (or skipped if no tests) */
  test_status: QAStatus | 'skipped';
  /** Timestamp when QA phase completed */
  qa_completed_at?: string;
}

/**
 * State tracking for the validation phase
 */
export interface AutopilotValidation {
  /** Number of architect agents spawned for validation */
  architects_spawned: number;
  /** List of validation verdicts received */
  verdicts: ValidationResult[];
  /** Whether all validation checks approved */
  all_approved: boolean;
  /** Number of validation rounds performed */
  validation_rounds: number;
}

/**
 * Complete autopilot state
 */
export interface AutopilotState {
  /** Whether autopilot is currently active */
  active: boolean;
  /** Current phase of execution */
  phase: AutopilotPhase;
  /** Current iteration number */
  iteration: number;
  /** Maximum iterations before giving up */
  max_iterations: number;

  /** Original user input that started autopilot */
  originalIdea: string;

  /** State for each phase */
  expansion: AutopilotExpansion;
  planning: AutopilotPlanning;
  execution: AutopilotExecution;
  qa: AutopilotQA;
  validation: AutopilotValidation;

  /** Metrics and timestamps */
  started_at: string;
  completed_at: string | null;
  phase_durations: Record<string, number>;
  total_agents_spawned: number;
  wisdom_entries: number;

  /** Session binding */
  session_id?: string;
  /** Project path for isolation */
  project_path?: string;
}

/**
 * Configuration options for autopilot behavior
 */
export interface AutopilotConfig {
  /** Maximum total iterations across all phases */
  maxIterations?: number;
  /** Maximum iterations during expansion phase */
  maxExpansionIterations?: number;
  /** Maximum iterations during planning phase */
  maxArchitectIterations?: number;
  /** Maximum QA test-fix cycles */
  maxQaCycles?: number;
  /** Maximum validation rounds before giving up */
  maxValidationRounds?: number;
  /** Number of parallel executors to use */
  parallelExecutors?: number;
  /** Pause for user confirmation after expansion */
  pauseAfterExpansion?: boolean;
  /** Pause for user confirmation after planning */
  pauseAfterPlanning?: boolean;
  /** Skip QA phase entirely */
  skipQa?: boolean;
  /** Skip validation phase entirely */
  skipValidation?: boolean;
  /** Automatically commit changes when complete */
  autoCommit?: boolean;
  /** Types of validation to perform */
  validationArchitects?: ValidationVerdictType[];
}

/**
 * Result returned when autopilot completes or fails
 */
export interface AutopilotResult {
  /** Whether autopilot completed successfully */
  success: boolean;
  /** Final phase reached */
  phase: AutopilotPhase;
  /** Summary of work completed */
  summary: AutopilotSummary;
  /** Error message if failed */
  error?: string;
}

/**
 * Summary of autopilot execution
 */
export interface AutopilotSummary {
  /** Original idea provided by user */
  originalIdea: string;
  /** Files created during execution */
  filesCreated: string[];
  /** Files modified during execution */
  filesModified: string[];
  /** Final status of tests */
  testsStatus: string;
  /** Total duration in milliseconds */
  duration: number;
  /** Total number of agents spawned */
  agentsSpawned: number;
  /** Phases that were completed */
  phasesCompleted: AutopilotPhase[];
}

/**
 * Signal types for phase transitions and completion
 */
export type AutopilotSignal =
  | 'EXPANSION_COMPLETE'      // Expansion phase finished
  | 'PLANNING_COMPLETE'       // Planning phase finished
  | 'EXECUTION_COMPLETE'      // Execution phase finished
  | 'QA_COMPLETE'            // QA phase finished
  | 'VALIDATION_COMPLETE'    // Validation phase finished
  | 'AUTOPILOT_COMPLETE'     // All phases complete
  | 'TRANSITION_TO_QA'       // Ready to start QA
  | 'TRANSITION_TO_VALIDATION'; // Ready to start validation

/**
 * Default configuration for autopilot
 */
export const DEFAULT_CONFIG: AutopilotConfig = {
  maxIterations: 10,
  maxExpansionIterations: 2,
  maxArchitectIterations: 5,
  maxQaCycles: 5,
  maxValidationRounds: 3,
  parallelExecutors: 5,
  pauseAfterExpansion: false,
  pauseAfterPlanning: false,
  skipQa: false,
  skipValidation: false,
  autoCommit: false,
  validationArchitects: ['functional', 'security', 'quality']
};
