export type TeamLeaderNextAction = 'shutdown' | 'reuse-current-team' | 'launch-new-team' | 'keep-checking-status';
export interface TeamLeaderGuidanceInput {
    tasks: {
        pending: number;
        blocked: number;
        inProgress: number;
        completed: number;
        failed: number;
    };
    workers: {
        total: number;
        alive: number;
        idle: number;
        nonReporting: number;
    };
}
export interface TeamLeaderGuidance {
    nextAction: TeamLeaderNextAction;
    reason: string;
    message: string;
}
export declare function deriveTeamLeaderGuidance(input: TeamLeaderGuidanceInput): TeamLeaderGuidance;
//# sourceMappingURL=leader-nudge-guidance.d.ts.map