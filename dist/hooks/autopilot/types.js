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
 * Default configuration for autopilot
 */
export const DEFAULT_CONFIG = {
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
//# sourceMappingURL=types.js.map