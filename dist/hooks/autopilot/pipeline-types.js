/**
 * Pipeline Types
 *
 * Type definitions for the configurable pipeline orchestrator.
 * The pipeline unifies autopilot/ultrawork/ultrapilot into a single
 * configurable sequence: RALPLAN -> EXECUTION -> RALPH -> QA.
 *
 * @see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1130
 */
/** The canonical stage execution order */
export const STAGE_ORDER = [
    'ralplan',
    'execution',
    'ralph',
    'qa',
];
/** Default pipeline configuration (matches current autopilot behavior) */
export const DEFAULT_PIPELINE_CONFIG = {
    planning: 'ralplan',
    execution: 'solo',
    verification: {
        engine: 'ralph',
        maxIterations: 100,
    },
    qa: true,
};
// ============================================================================
// DEPRECATION ALIASES
// ============================================================================
/**
 * Maps deprecated mode names to their pipeline configuration equivalents.
 * Used to translate ultrawork/ultrapilot invocations into autopilot + config.
 */
export const DEPRECATED_MODE_ALIASES = {
    ultrawork: {
        config: { execution: 'team' },
        message: 'ultrawork is deprecated. Use /autopilot with execution: "team" instead.',
    },
    ultrapilot: {
        config: { execution: 'team' },
        message: 'ultrapilot is deprecated. Use /autopilot with execution: "team" instead.',
    },
};
//# sourceMappingURL=pipeline-types.js.map