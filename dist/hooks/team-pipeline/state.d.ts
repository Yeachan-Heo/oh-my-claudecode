import type { TeamPipelineState, TeamPipelinePhase, TeamTransitionResult } from './types.js';
export declare function initTeamPipelineState(directory: string, sessionId: string, options?: Partial<Pick<TeamPipelineState, 'project_path' | 'max_iterations'>>): TeamPipelineState;
export declare function readTeamPipelineState(directory: string, sessionId?: string): TeamPipelineState | null;
export declare function writeTeamPipelineState(directory: string, state: TeamPipelineState, sessionId?: string): boolean;
export declare function clearTeamPipelineState(directory: string, sessionId?: string): boolean;
export declare function markTeamPhase(state: TeamPipelineState, nextPhase: TeamPipelinePhase, reason?: string): TeamTransitionResult;
//# sourceMappingURL=state.d.ts.map