import type { HeartbeatData, TaskFile, OutboxMessage } from './types.js';
import { generateUsageReport } from './usage-tracker.js';
export interface WorkerStatus {
    workerName: string;
    provider: 'claude' | 'codex' | 'gemini';
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
    usage: ReturnType<typeof generateUsageReport>;
    performance: {
        taskScanMs: number;
        workerScanMs: number;
        usageReadMs: number;
        totalMs: number;
    };
    lastUpdated: string;
}
export declare function getTeamStatus(teamName: string, workingDirectory: string, heartbeatMaxAgeMs?: number, options?: {
    includeUsage?: boolean;
}): TeamStatus;
//# sourceMappingURL=team-status.d.ts.map