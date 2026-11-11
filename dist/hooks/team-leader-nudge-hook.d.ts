/**
 * Team leader nudge hook: detect stale leader and nudge via tmux.
 *
 * Mirrors OMX idle-nudge.ts behavior adapted for the leader pane.
 * Called on worker hook ticks when the leader pane appears stale
 * (no heartbeat update for a threshold period).
 *
 * This hook checks all workers' status and if all are idle while
 * tasks remain incomplete, nudges the leader pane to take action.
 */
export interface TmuxRunner {
    sendKeys(target: string, text: string, literal?: boolean): Promise<void>;
}
interface LeaderStalenessResult {
    stale: boolean;
    reason: string;
    pendingTaskCount: number;
    blockedTaskCount: number;
    inProgressTaskCount: number;
    completedTaskCount: number;
    failedTaskCount: number;
    idleWorkerCount: number;
    aliveWorkerCount: number;
    nonReportingWorkerCount: number;
    totalWorkerCount: number;
}
export declare function checkLeaderStaleness(params: {
    stateDir: string;
    teamName: string;
    nowMs?: number;
}): Promise<LeaderStalenessResult>;
export declare function maybeNudgeLeader(params: {
    cwd: string;
    stateDir: string;
    teamName: string;
    tmux?: TmuxRunner;
}): Promise<{
    nudged: boolean;
    reason: string;
}>;
export {};
//# sourceMappingURL=team-leader-nudge-hook.d.ts.map