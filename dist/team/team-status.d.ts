import type { HeartbeatData, TaskFile, OutboxMessage } from './types.js';
export interface WorkerStatus {
    workerName: string;
    provider: 'codex' | 'gemini';
    heartbeat: HeartbeatData | null;
    isAlive: boolean;
    currentTask: TaskFile | null;
    recentMessages: OutboxMessage[];
    taskStats: {
        completed: number;
        failed: number;
        pending: number;
        inProgress: number;
    };
}
export interface TeamStatus {
    teamName: string;
    workers: WorkerStatus[];
    taskSummary: {
        total: number;
        completed: number;
        failed: number;
        pending: number;
        inProgress: number;
    };
    lastUpdated: string;
}
export declare function getTeamStatus(teamName: string, workingDirectory: string, heartbeatMaxAgeMs?: number): TeamStatus;
//# sourceMappingURL=team-status.d.ts.map