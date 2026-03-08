/**
 * Team worker hook: heartbeat, idle detection, and leader notification.
 *
 * Mirrors OMX scripts/notify-hook/team-worker.js behavior exactly.
 *
 * Short-circuit: if OMC_TEAM_WORKER is not set, returns immediately (<1ms).
 *
 * State files:
 *   workers/{name}/heartbeat.json
 *   workers/{name}/status.json
 *   workers/{name}/prev-notify-state.json
 *   workers/{name}/worker-idle-notify.json
 *   all-workers-idle.json
 */
export declare function parseTeamWorkerEnv(rawValue: unknown): {
    teamName: string;
    workerName: string;
} | null;
export declare function resolveWorkerIdleNotifyEnabled(): boolean;
export declare function resolveWorkerIdleCooldownMs(): number;
export declare function resolveAllWorkersIdleCooldownMs(): number;
export interface TmuxRunner {
    sendKeys(target: string, text: string, literal?: boolean): Promise<void>;
}
export declare function updateWorkerHeartbeat(stateDir: string, teamName: string, workerName: string): Promise<void>;
export declare function maybeNotifyLeaderWorkerIdle(params: {
    cwd: string;
    stateDir: string;
    parsedTeamWorker: {
        teamName: string;
        workerName: string;
    };
    tmux?: TmuxRunner;
}): Promise<void>;
export declare function maybeNotifyLeaderAllWorkersIdle(params: {
    cwd: string;
    stateDir: string;
    parsedTeamWorker: {
        teamName: string;
        workerName: string;
    };
    tmux?: TmuxRunner;
}): Promise<void>;
export declare function handleWorkerTurn(teamName: string, workerName: string, cwd: string, tmux?: TmuxRunner): Promise<void>;
//# sourceMappingURL=team-worker-hook.d.ts.map