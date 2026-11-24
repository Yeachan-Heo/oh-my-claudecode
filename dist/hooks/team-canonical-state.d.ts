import type { TeamPipelinePhase } from './team-pipeline/types.js';
export interface CanonicalTeamStateCandidate {
    teamName: string;
    sessionId: string;
    stage: TeamPipelinePhase;
    active: boolean;
    startedAt: string;
    updatedAt: string;
    task: string;
    leaderCwd?: string;
    teamStateRoot?: string;
}
/**
 * Read the canonical live team candidate for the current session.
 *
 * This is a read-only fallback used when coarse `team-state.json` drifted,
 * disappeared, or was marked inactive even though the canonical team config
 * and phase files still describe a live run.
 */
export declare function readCanonicalTeamStateCandidate(directory: string, sessionId?: string): CanonicalTeamStateCandidate | null;
export declare function canonicalTeamStateIsTerminal(candidate: CanonicalTeamStateCandidate | null): boolean;
//# sourceMappingURL=team-canonical-state.d.ts.map