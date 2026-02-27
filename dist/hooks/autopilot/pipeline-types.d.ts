/**
 * Pipeline Types
 *
 * Type definitions for the configurable pipeline orchestrator.
 * The pipeline unifies autopilot/ultrawork/ultrapilot into a single
 * configurable sequence: RALPLAN -> EXECUTION -> RALPH -> QA.
 *
 * @see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1130
 */
/**
 * Pipeline stage identifiers in execution order.
 * Each stage is optional and can be skipped via configuration.
 */
export type PipelineStageId = 'ralplan' | 'execution' | 'ralph' | 'qa';
/** Terminal pipeline states */
export type PipelineTerminalState = 'complete' | 'failed' | 'cancelled';
/** All possible pipeline phase values (stages + terminal) */
export type PipelinePhase = PipelineStageId | PipelineTerminalState;
/** Status of an individual stage */
export type StageStatus = 'pending' | 'active' | 'complete' | 'failed' | 'skipped';
/** The canonical stage execution order */
export declare const STAGE_ORDER: readonly PipelineStageId[];
/** Execution backend for the execution stage */
export type ExecutionBackend = 'team' | 'solo';
/** Verification engine configuration */
export interface VerificationConfig {
    /** Engine to use for verification (currently only 'ralph') */
    engine: 'ralph';
    /** Maximum verification iterations before giving up */
    maxIterations: number;
}
/**
 * User-facing pipeline configuration.
 * Stored in `.omc-config.json` under the `autopilot` key.
 *
 * Example:
 * ```json
 * {
 *   "autopilot": {
 *     "planning": "ralplan",
 *     "execution": "team",
 *     "verification": { "engine": "ralph", "maxIterations": 100 },
 *     "qa": true
 *   }
 * }
 * ```
 */
export interface PipelineConfig {
    /** Planning stage: 'ralplan' for consensus planning, 'direct' for simple planning, false to skip */
    planning: 'ralplan' | 'direct' | false;
    /** Execution backend: 'team' for multi-worker, 'solo' for single-session */
    execution: ExecutionBackend;
    /** Verification config, or false to skip */
    verification: VerificationConfig | false;
    /** Whether to run the QA stage (build/lint/test cycling) */
    qa: boolean;
}
/** Default pipeline configuration (matches current autopilot behavior) */
export declare const DEFAULT_PIPELINE_CONFIG: PipelineConfig;
/**
 * Context passed to stage adapters for prompt generation and state management.
 */
export interface PipelineContext {
    /** Original user idea/task description */
    idea: string;
    /** Working directory */
    directory: string;
    /** Session ID for state isolation */
    sessionId?: string;
    /** Path to the generated specification document */
    specPath?: string;
    /** Path to the generated implementation plan */
    planPath?: string;
    /** The full pipeline configuration */
    config: PipelineConfig;
}
/**
 * Interface that each stage adapter must implement.
 * Adapters wrap existing modules (ralplan, team, ralph, ultraqa)
 * into a uniform interface for the pipeline orchestrator.
 */
export interface PipelineStageAdapter {
    /** Stage identifier */
    readonly id: PipelineStageId;
    /** Human-readable stage name for display */
    readonly name: string;
    /** Signal string that Claude emits to indicate stage completion */
    readonly completionSignal: string;
    /** Check if this stage should be skipped based on pipeline config */
    shouldSkip(config: PipelineConfig): boolean;
    /** Generate the prompt to inject for this stage */
    getPrompt(context: PipelineContext): string;
    /** Optional: perform setup actions when entering this stage (e.g. start ralph state) */
    onEnter?(context: PipelineContext): void;
    /** Optional: perform cleanup actions when leaving this stage */
    onExit?(context: PipelineContext): void;
}
/** Tracked state for a single pipeline stage */
export interface PipelineStageState {
    /** Stage identifier */
    id: PipelineStageId;
    /** Current status */
    status: StageStatus;
    /** ISO timestamp when stage started */
    startedAt?: string;
    /** ISO timestamp when stage completed */
    completedAt?: string;
    /** Number of iterations within this stage */
    iterations: number;
    /** Error message if stage failed */
    error?: string;
}
/**
 * Pipeline-specific state that extends the autopilot state.
 * Stored alongside existing autopilot state fields.
 */
export interface PipelineTracking {
    /** Pipeline configuration used for this run */
    pipelineConfig: PipelineConfig;
    /** Ordered list of stages and their current status */
    stages: PipelineStageState[];
    /** Index of the currently active stage in the stages array */
    currentStageIndex: number;
}
/**
 * Maps deprecated mode names to their pipeline configuration equivalents.
 * Used to translate ultrawork/ultrapilot invocations into autopilot + config.
 */
export declare const DEPRECATED_MODE_ALIASES: Record<string, {
    config: Partial<PipelineConfig>;
    message: string;
}>;
//# sourceMappingURL=pipeline-types.d.ts.map