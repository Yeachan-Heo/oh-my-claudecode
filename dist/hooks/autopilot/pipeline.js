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
import { DEFAULT_PIPELINE_CONFIG, STAGE_ORDER, DEPRECATED_MODE_ALIASES } from './pipeline-types.js';
import { ALL_ADAPTERS, getAdapterById } from './adapters/index.js';
import { readAutopilotState, writeAutopilotState, initAutopilot, } from './state.js';
// ============================================================================
// CONFIGURATION
// ============================================================================
/**
 * Resolve a PipelineConfig from user-provided partial config, merging with defaults.
 *
 * Also handles deprecated mode aliases: if the user invoked 'ultrawork' or 'ultrapilot',
 * the corresponding config overrides are applied.
 */
export function resolvePipelineConfig(userConfig, deprecatedMode) {
    let config = { ...DEFAULT_PIPELINE_CONFIG };
    // Apply deprecated mode alias overrides
    if (deprecatedMode && deprecatedMode in DEPRECATED_MODE_ALIASES) {
        const alias = DEPRECATED_MODE_ALIASES[deprecatedMode];
        config = { ...config, ...alias.config };
    }
    // Apply user overrides
    if (userConfig) {
        if (userConfig.planning !== undefined)
            config.planning = userConfig.planning;
        if (userConfig.execution !== undefined)
            config.execution = userConfig.execution;
        if (userConfig.verification !== undefined)
            config.verification = userConfig.verification;
        if (userConfig.qa !== undefined)
            config.qa = userConfig.qa;
    }
    return config;
}
/**
 * Check if the invocation is from a deprecated mode and return the deprecation warning.
 */
export function getDeprecationWarning(mode) {
    if (mode in DEPRECATED_MODE_ALIASES) {
        return DEPRECATED_MODE_ALIASES[mode].message;
    }
    return null;
}
// ============================================================================
// PIPELINE STATE MANAGEMENT
// ============================================================================
/**
 * Build the initial pipeline tracking state from a resolved config.
 * Creates stage entries for all stages, marking skipped stages as 'skipped'.
 */
export function buildPipelineTracking(config) {
    const adapters = getActiveAdapters(config);
    const stages = STAGE_ORDER.map(stageId => {
        const adapter = getAdapterById(stageId);
        const isActive = adapter && !adapter.shouldSkip(config);
        return {
            id: stageId,
            status: isActive ? 'pending' : 'skipped',
            iterations: 0,
        };
    });
    // Find the first non-skipped stage
    const firstActiveIndex = stages.findIndex(s => s.status !== 'skipped');
    return {
        pipelineConfig: config,
        stages,
        currentStageIndex: firstActiveIndex >= 0 ? firstActiveIndex : 0,
    };
}
/**
 * Get the ordered list of active (non-skipped) adapters for a given config.
 */
export function getActiveAdapters(config) {
    return ALL_ADAPTERS.filter(adapter => !adapter.shouldSkip(config));
}
/**
 * Read pipeline tracking from an autopilot state.
 * Returns null if the state doesn't have pipeline tracking.
 */
export function readPipelineTracking(state) {
    const extended = state;
    return extended.pipeline ?? null;
}
/**
 * Write pipeline tracking into an autopilot state and persist to disk.
 */
export function writePipelineTracking(directory, tracking, sessionId) {
    const state = readAutopilotState(directory, sessionId);
    if (!state)
        return false;
    state.pipeline = tracking;
    return writeAutopilotState(directory, state, sessionId);
}
// ============================================================================
// PIPELINE INITIALIZATION
// ============================================================================
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
export function initPipeline(directory, idea, sessionId, autopilotConfig, pipelineConfig, deprecatedMode) {
    // Resolve pipeline config
    const resolvedConfig = resolvePipelineConfig(pipelineConfig, deprecatedMode);
    // Initialize the base autopilot state
    const state = initAutopilot(directory, idea, sessionId, autopilotConfig);
    if (!state)
        return null;
    // Build and attach pipeline tracking
    const tracking = buildPipelineTracking(resolvedConfig);
    // Mark the first active stage as active
    if (tracking.currentStageIndex >= 0 && tracking.currentStageIndex < tracking.stages.length) {
        tracking.stages[tracking.currentStageIndex].status = 'active';
        tracking.stages[tracking.currentStageIndex].startedAt = new Date().toISOString();
    }
    // Persist pipeline tracking alongside autopilot state
    state.pipeline = tracking;
    writeAutopilotState(directory, state, sessionId);
    return state;
}
// ============================================================================
// STAGE TRANSITIONS
// ============================================================================
/**
 * Get the current pipeline stage adapter.
 * Returns null if the pipeline is in a terminal state or all stages are done.
 */
export function getCurrentStageAdapter(tracking) {
    const { stages, currentStageIndex } = tracking;
    if (currentStageIndex < 0 || currentStageIndex >= stages.length) {
        return null;
    }
    const currentStage = stages[currentStageIndex];
    if (currentStage.status === 'skipped' || currentStage.status === 'complete') {
        // Find next active stage
        return getNextStageAdapter(tracking);
    }
    return getAdapterById(currentStage.id) ?? null;
}
/**
 * Get the next non-skipped stage adapter after the current one.
 * Returns null if no more stages remain.
 */
export function getNextStageAdapter(tracking) {
    const { stages, currentStageIndex } = tracking;
    for (let i = currentStageIndex + 1; i < stages.length; i++) {
        if (stages[i].status !== 'skipped') {
            return getAdapterById(stages[i].id) ?? null;
        }
    }
    return null;
}
/**
 * Advance the pipeline to the next stage.
 *
 * Marks the current stage as complete, finds the next non-skipped stage,
 * and marks it as active. Returns the new current stage adapter, or null
 * if the pipeline is complete.
 */
export function advanceStage(directory, sessionId) {
    const state = readAutopilotState(directory, sessionId);
    if (!state)
        return { adapter: null, phase: 'failed' };
    const tracking = readPipelineTracking(state);
    if (!tracking)
        return { adapter: null, phase: 'failed' };
    const { stages, currentStageIndex } = tracking;
    // Mark current stage as complete
    if (currentStageIndex >= 0 && currentStageIndex < stages.length) {
        const currentStage = stages[currentStageIndex];
        currentStage.status = 'complete';
        currentStage.completedAt = new Date().toISOString();
        // Call onExit if the adapter supports it
        const currentAdapter = getAdapterById(currentStage.id);
        if (currentAdapter?.onExit) {
            const context = buildContext(state, tracking);
            currentAdapter.onExit(context);
        }
    }
    // Find next non-skipped stage
    let nextIndex = -1;
    for (let i = currentStageIndex + 1; i < stages.length; i++) {
        if (stages[i].status !== 'skipped') {
            nextIndex = i;
            break;
        }
    }
    if (nextIndex < 0) {
        // All stages complete — pipeline is done
        tracking.currentStageIndex = stages.length;
        writePipelineTracking(directory, tracking, sessionId);
        return { adapter: null, phase: 'complete' };
    }
    // Activate next stage
    tracking.currentStageIndex = nextIndex;
    stages[nextIndex].status = 'active';
    stages[nextIndex].startedAt = new Date().toISOString();
    writePipelineTracking(directory, tracking, sessionId);
    // Call onEnter if the adapter supports it
    const nextAdapter = getAdapterById(stages[nextIndex].id);
    if (nextAdapter.onEnter) {
        const context = buildContext(state, tracking);
        nextAdapter.onEnter(context);
    }
    return { adapter: nextAdapter, phase: stages[nextIndex].id };
}
/**
 * Mark the current stage as failed and the pipeline as failed.
 */
export function failCurrentStage(directory, error, sessionId) {
    const state = readAutopilotState(directory, sessionId);
    if (!state)
        return false;
    const tracking = readPipelineTracking(state);
    if (!tracking)
        return false;
    const { stages, currentStageIndex } = tracking;
    if (currentStageIndex >= 0 && currentStageIndex < stages.length) {
        stages[currentStageIndex].status = 'failed';
        stages[currentStageIndex].error = error;
    }
    return writePipelineTracking(directory, tracking, sessionId);
}
/**
 * Increment the iteration counter for the current stage.
 */
export function incrementStageIteration(directory, sessionId) {
    const state = readAutopilotState(directory, sessionId);
    if (!state)
        return false;
    const tracking = readPipelineTracking(state);
    if (!tracking)
        return false;
    const { stages, currentStageIndex } = tracking;
    if (currentStageIndex >= 0 && currentStageIndex < stages.length) {
        stages[currentStageIndex].iterations++;
    }
    return writePipelineTracking(directory, tracking, sessionId);
}
// ============================================================================
// SIGNAL DETECTION FOR PIPELINE
// ============================================================================
/**
 * Get the completion signal expected for the current pipeline stage.
 */
export function getCurrentCompletionSignal(tracking) {
    const { stages, currentStageIndex } = tracking;
    if (currentStageIndex < 0 || currentStageIndex >= stages.length)
        return null;
    const adapter = getAdapterById(stages[currentStageIndex].id);
    return adapter?.completionSignal ?? null;
}
/**
 * Map from all pipeline completion signals to their stage IDs.
 */
export function getSignalToStageMap() {
    const map = new Map();
    for (const adapter of ALL_ADAPTERS) {
        map.set(adapter.completionSignal, adapter.id);
    }
    return map;
}
// ============================================================================
// PROMPT GENERATION
// ============================================================================
/**
 * Generate the continuation prompt for the current pipeline stage.
 * This is the primary output consumed by the enforcement hook.
 */
export function generatePipelinePrompt(directory, sessionId) {
    const state = readAutopilotState(directory, sessionId);
    if (!state)
        return null;
    const tracking = readPipelineTracking(state);
    if (!tracking)
        return null;
    const adapter = getCurrentStageAdapter(tracking);
    if (!adapter)
        return null;
    const context = buildContext(state, tracking);
    return adapter.getPrompt(context);
}
/**
 * Generate a stage transition prompt when advancing between stages.
 */
export function generateTransitionPrompt(fromStage, toStage) {
    if (toStage === 'complete') {
        return `## PIPELINE COMPLETE

All pipeline stages have completed successfully!

Signal: AUTOPILOT_COMPLETE
`;
    }
    const toAdapter = getAdapterById(toStage);
    const toName = toAdapter?.name ?? toStage;
    return `## PIPELINE STAGE TRANSITION: ${fromStage.toUpperCase()} -> ${toStage.toUpperCase()}

The ${fromStage} stage is complete. Transitioning to: **${toName}**

`;
}
// ============================================================================
// PIPELINE STATUS & INSPECTION
// ============================================================================
/**
 * Get a summary of the pipeline's current status for display.
 */
export function getPipelineStatus(tracking) {
    const completed = [];
    const pending = [];
    const skipped = [];
    let current = null;
    for (const stage of tracking.stages) {
        switch (stage.status) {
            case 'complete':
                completed.push(stage.id);
                break;
            case 'active':
                current = stage.id;
                break;
            case 'pending':
                pending.push(stage.id);
                break;
            case 'skipped':
                skipped.push(stage.id);
                break;
        }
    }
    const activeStages = tracking.stages.filter(s => s.status !== 'skipped');
    const completedCount = completed.length;
    const totalActive = activeStages.length;
    const isComplete = current === null && pending.length === 0;
    const progress = `${completedCount}/${totalActive} stages`;
    return { currentStage: current, completedStages: completed, pendingStages: pending, skippedStages: skipped, isComplete, progress };
}
/**
 * Format pipeline status for HUD display.
 */
export function formatPipelineHUD(tracking) {
    const status = getPipelineStatus(tracking);
    const parts = [];
    for (const stage of tracking.stages) {
        const adapter = getAdapterById(stage.id);
        const name = adapter?.name ?? stage.id;
        switch (stage.status) {
            case 'complete':
                parts.push(`[OK] ${name}`);
                break;
            case 'active':
                parts.push(`[>>] ${name} (iter ${stage.iterations})`);
                break;
            case 'pending':
                parts.push(`[..] ${name}`);
                break;
            case 'skipped':
                parts.push(`[--] ${name}`);
                break;
            case 'failed':
                parts.push(`[!!] ${name}`);
                break;
        }
    }
    return `Pipeline ${status.progress}: ${parts.join(' | ')}`;
}
// ============================================================================
// HELPERS
// ============================================================================
/**
 * Build a PipelineContext from autopilot state and pipeline tracking.
 */
function buildContext(state, tracking) {
    return {
        idea: state.originalIdea,
        directory: state.project_path || process.cwd(),
        sessionId: state.session_id,
        specPath: state.expansion.spec_path || '.omc/autopilot/spec.md',
        planPath: state.planning.plan_path || '.omc/plans/autopilot-impl.md',
        config: tracking.pipelineConfig,
    };
}
/**
 * Check if a state has pipeline tracking (i.e. was initialized via the new pipeline).
 */
export function hasPipelineTracking(state) {
    return readPipelineTracking(state) !== null;
}
//# sourceMappingURL=pipeline.js.map