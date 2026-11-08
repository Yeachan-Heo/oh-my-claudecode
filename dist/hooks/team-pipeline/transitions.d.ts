import type { TeamPipelinePhase, TeamPipelineState, TeamTransitionResult } from './types.js';
/** Validates that a value is a non-negative finite integer */
export declare function isNonNegativeFiniteInteger(n: unknown): n is number;
export declare function transitionTeamPhase(state: TeamPipelineState, next: TeamPipelinePhase, reason?: string): TeamTransitionResult;
export declare function requestTeamCancel(state: TeamPipelineState, preserveForResume?: boolean): TeamPipelineState;
//# sourceMappingURL=transitions.d.ts.map