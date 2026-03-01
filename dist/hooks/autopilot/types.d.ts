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
export type AutopilotPhase = 'expansion' | 'planning' | 'execution' | 'qa' | 'validation' | 'complete' | 'failed';
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
    /**
     * Pipeline configuration for the unified orchestrator.
     * When set, autopilot uses the pipeline orchestrator instead of the legacy
     * hard-coded phase sequence. This is the path forward for unifying
     * autopilot/ultrawork/ultrapilot.
     *
     * @see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1130
     */
    pipeline?: {
        /** Planning stage: 'ralplan' for consensus, 'direct' for simple, false to skip */
        planning?: 'ralplan' | 'direct' | false;
        /** Execution backend: 'team' for multi-worker, 'solo' for single-session */
        execution?: 'team' | 'solo';
        /** Verification config, or false to skip */
        verification?: {
            engine: 'ralph';
            maxIterations: number;
        } | false;
        /** Whether to run QA stage */
        qa?: boolean;
    };
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
export type AutopilotSignal = 'EXPANSION_COMPLETE' | 'PLANNING_COMPLETE' | 'EXECUTION_COMPLETE' | 'QA_COMPLETE' | 'VALIDATION_COMPLETE' | 'AUTOPILOT_COMPLETE' | 'TRANSITION_TO_QA' | 'TRANSITION_TO_VALIDATION';
/**
 * Default configuration for autopilot
 */
export declare const DEFAULT_CONFIG: AutopilotConfig;
//# sourceMappingURL=types.d.ts.map