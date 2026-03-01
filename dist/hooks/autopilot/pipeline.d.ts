/**
 * Pipeline Orchestrator
 *
 * The core of the configurable pipeline that unifies autopilot/ultrawork/ultrapilot
 * into a single sequenced workflow: RALPLAN -> EXECUTION -> RALPH -> QA.
 *
 * Each stage is implemented by a PipelineStageAdapter and can be skipped
 * via PipelineConfig. The orchestrator manages state transitions, signal
 * detection, and prompt generation.
 *
 * @see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1130
 */
import type { PipelineConfig, PipelineStageAdapter, PipelineTracking, PipelinePhase, PipelineStageId } from './pipeline-types.js';
import type { AutopilotState, AutopilotConfig } from './types.js';
/**
 * Resolve a PipelineConfig from user-provided partial config, merging with defaults.
 *
 * Also handles deprecated mode aliases: if the user invoked 'ultrawork' or 'ultrapilot',
 * the corresponding config overrides are applied.
 */
export declare function resolvePipelineConfig(userConfig?: Partial<PipelineConfig>, deprecatedMode?: string): PipelineConfig;
/**
 * Check if the invocation is from a deprecated mode and return the deprecation warning.
 */
export declare function getDeprecationWarning(mode: string): string | null;
/**
 * Build the initial pipeline tracking state from a resolved config.
 * Creates stage entries for all stages, marking skipped stages as 'skipped'.
 */
export declare function buildPipelineTracking(config: PipelineConfig): PipelineTracking;
/**
 * Get the ordered list of active (non-skipped) adapters for a given config.
 */
export declare function getActiveAdapters(config: PipelineConfig): PipelineStageAdapter[];
/**
 * Read pipeline tracking from an autopilot state.
 * Returns null if the state doesn't have pipeline tracking.
 */
export declare function readPipelineTracking(state: AutopilotState): PipelineTracking | null;
/**
 * Write pipeline tracking into an autopilot state and persist to disk.
 */
export declare function writePipelineTracking(directory: string, tracking: PipelineTracking, sessionId?: string): boolean;
/**
 * Initialize a new pipeline-based autopilot session.
 *
 * This is the unified entry point that replaces separate initAutopilot calls
 * for autopilot, ultrawork, and ultrapilot.
 *
 * @param directory - Working directory
 * @param idea - The user's original idea/task
 * @param sessionId - Session ID for state isolation
 * @param autopilotConfig - Standard autopilot config overrides
 * @param pipelineConfig - Pipeline-specific configuration
 * @param deprecatedMode - If invoked via deprecated mode name (ultrawork/ultrapilot)
 * @returns The initialized autopilot state, or null if startup was blocked
 */
export declare function initPipeline(directory: string, idea: string, sessionId?: string, autopilotConfig?: Partial<AutopilotConfig>, pipelineConfig?: Partial<PipelineConfig>, deprecatedMode?: string): AutopilotState | null;
/**
 * Get the current pipeline stage adapter.
 * Returns null if the pipeline is in a terminal state or all stages are done.
 */
export declare function getCurrentStageAdapter(tracking: PipelineTracking): PipelineStageAdapter | null;
/**
 * Get the next non-skipped stage adapter after the current one.
 * Returns null if no more stages remain.
 */
export declare function getNextStageAdapter(tracking: PipelineTracking): PipelineStageAdapter | null;
/**
 * Advance the pipeline to the next stage.
 *
 * Marks the current stage as complete, finds the next non-skipped stage,
 * and marks it as active. Returns the new current stage adapter, or null
 * if the pipeline is complete.
 */
export declare function advanceStage(directory: string, sessionId?: string): {
    adapter: PipelineStageAdapter | null;
    phase: PipelinePhase;
};
/**
 * Mark the current stage as failed and the pipeline as failed.
 */
export declare function failCurrentStage(directory: string, error: string, sessionId?: string): boolean;
/**
 * Increment the iteration counter for the current stage.
 */
export declare function incrementStageIteration(directory: string, sessionId?: string): boolean;
/**
 * Get the completion signal expected for the current pipeline stage.
 */
export declare function getCurrentCompletionSignal(tracking: PipelineTracking): string | null;
/**
 * Map from all pipeline completion signals to their stage IDs.
 */
export declare function getSignalToStageMap(): Map<string, PipelineStageId>;
/**
 * Generate the continuation prompt for the current pipeline stage.
 * This is the primary output consumed by the enforcement hook.
 */
export declare function generatePipelinePrompt(directory: string, sessionId?: string): string | null;
/**
 * Generate a stage transition prompt when advancing between stages.
 */
export declare function generateTransitionPrompt(fromStage: PipelineStageId, toStage: PipelineStageId | 'complete'): string;
/**
 * Get a summary of the pipeline's current status for display.
 */
export declare function getPipelineStatus(tracking: PipelineTracking): {
    currentStage: PipelineStageId | null;
    completedStages: PipelineStageId[];
    pendingStages: PipelineStageId[];
    skippedStages: PipelineStageId[];
    isComplete: boolean;
    progress: string;
};
/**
 * Format pipeline status for HUD display.
 */
export declare function formatPipelineHUD(tracking: PipelineTracking): string;
/**
 * Check if a state has pipeline tracking (i.e. was initialized via the new pipeline).
 */
export declare function hasPipelineTracking(state: AutopilotState): boolean;
//# sourceMappingURL=pipeline.d.ts.map