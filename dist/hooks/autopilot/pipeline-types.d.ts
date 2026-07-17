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
export type PipelineStageId = "ralplan" | "execution" | "ralph" | "qa";
/** Terminal pipeline states */
export type PipelineTerminalState = "complete" | "failed" | "cancelled";
/** All possible pipeline phase values (stages + terminal) */
export type PipelinePhase = PipelineStageId | PipelineTerminalState;
/** Status of an individual stage */
export type StageStatus = "pending" | "active" | "complete" | "failed" | "skipped";
/** The canonical stage execution order */
export declare const STAGE_ORDER: readonly PipelineStageId[];
/** Closed version 1 profile sequence admitted by the workflow contract. */
export type WorkflowProfileStages = readonly [
    "ralplan",
    "execution"
] | readonly [
    "ralplan",
    "execution",
    "ralph"
] | readonly [
    "ralplan",
    "execution",
    "qa"
] | readonly [
    "ralplan",
    "execution",
    "ralph",
    "qa"
];
/** Immutable, normalized descriptor persisted for a named workflow run. */
export interface WorkflowDescriptor {
    readonly descriptorVersion: 1;
    readonly workflowName: string;
    readonly profileVersion: 1;
    readonly stages: WorkflowProfileStages;
    readonly profileHash: string;
}
/** Stable identity of transcript bytes accepted by a named workflow run. */
export interface PipelineTranscriptFileIdentity {
    device: number;
    inode: number;
    size: number;
    mtimeNs: string;
    ctimeNs: string;
    contentSha256: string;
}
/** Transcript boundary captured at workflow activation. */
export interface PipelineActivationBoundary {
    transcriptPath: string;
    transcriptRoot: string;
    transcriptBasename: string;
    sessionId: string;
    byteOffset: number;
    fileIdentity: PipelineTranscriptFileIdentity;
}
/** Evidence captured when a selected workflow stage completes. */
export interface PipelineCompletionObservation {
    stageId: PipelineStageId;
    sessionId: string;
    signalId: string;
    lineNumber: number;
    byteOffset: number;
    recordContentSha256: string;
    stableFile: PipelineTranscriptFileIdentity;
    activationBoundary: PipelineActivationBoundary;
    observedAt: string;
}
/** Execution backend for the execution stage */
export type ExecutionBackend = "team" | "solo";
/** CLI-backed worker types supported by the tmux team runtime. */
export type AutopilotTeamAgentType = "claude" | "codex" | "gemini" | "grok" | "cursor" | "antigravity";
/** Team execution options for autopilot execution=team. */
export interface AutopilotTeamConfig {
    /** Preferred CLI worker types for executor-style implementation tasks. */
    agentTypes?: AutopilotTeamAgentType[];
}
/** Verification engine configuration */
export interface VerificationConfig {
    /** Engine to use for verification (currently only 'ralph') */
    engine: "ralph";
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
    planning: "ralplan" | "direct" | false;
    /** Execution backend: 'team' for multi-worker, 'solo' for single-session */
    execution: ExecutionBackend;
    /** Verification config, or false to skip */
    verification: VerificationConfig | false;
    /** Whether to run the QA stage (build/lint/test cycling) */
    qa: boolean;
    /** Team execution options, only used when execution is 'team'. */
    team?: AutopilotTeamConfig;
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
    /** Path to the shared open questions file */
    openQuestionsPath?: string;
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
    /** Pipeline configuration used by legacy pipeline runs. */
    pipelineConfig?: PipelineConfig;
    /** Ordered list of selected stages and their current status. */
    stages: PipelineStageState[];
    /** Index of the currently active stage in the stages array. */
    currentStageIndex: number;
    /** Monotonic mutable progress revision. */
    trackingRevision: number;
    /** Transcript boundary captured when the workflow was activated. */
    activationBoundary: PipelineActivationBoundary | null;
    /** Evidence collected for each completed workflow stage. */
    completionObservations: PipelineCompletionObservation[];
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