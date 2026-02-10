/**
 * Autopilot Prompt Generation
 *
 * Generates phase-specific prompts that include Task tool invocations
 * for Claude to execute. This is the core of the agent invocation mechanism.
 */
/**
 * Generate the expansion phase prompt (Phase 0)
 * Analyst extracts requirements, Architect creates technical spec
 */
export declare function getExpansionPrompt(idea: string): string;
/**
 * Generate the direct planning prompt (Phase 1)
 * Uses Architect instead of Planner to create plan directly from spec
 */
export declare function getDirectPlanningPrompt(specPath: string): string;
/**
 * Generate the execution phase prompt (Phase 2)
 */
export declare function getExecutionPrompt(planPath: string): string;
/**
 * Generate the QA phase prompt (Phase 3)
 */
export declare function getQAPrompt(): string;
/**
 * Generate the validation phase prompt (Phase 4)
 */
export declare function getValidationPrompt(specPath: string): string;
/**
 * Get the prompt for the current phase
 */
export declare function getPhasePrompt(phase: string, context: {
    idea?: string;
    specPath?: string;
    planPath?: string;
}): string;
//# sourceMappingURL=prompts.d.ts.map