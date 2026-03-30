interface TeamApiEnvelope {
    ok: boolean;
    operation: string;
    data?: Record<string, unknown>;
    error?: {
        code: string;
        message: string;
    };
}
export interface TeamTaskInput {
    subject: string;
    description: string;
}
export interface TeamStartInput {
    teamName: string;
    agentTypes: string[];
    tasks: TeamTaskInput[];
    cwd: string;
    newWindow?: boolean;
    workerCount?: number;
    pollIntervalMs?: number;
    sentinelGateTimeoutMs?: number;
    sentinelGatePollIntervalMs?: number;
}
export interface TeamStartResult {
    jobId: string;
    status: 'running';
    pid?: number;
}
export interface TeamJobStatus {
    jobId: string;
    status: 'running' | 'completed' | 'failed';
    elapsedSeconds: string;
    result?: unknown;
    stderr?: string;
}
export interface TeamWaitOptions {
    timeoutMs?: number;
}
export interface TeamWaitResult extends TeamJobStatus {
    timedOut?: boolean;
    error?: string;
}
export interface TeamCleanupResult {
    jobId: string;
    message: string;
}
export declare function generateJobId(now?: number): string;
export declare function startTeamJob(input: TeamStartInput): Promise<TeamStartResult>;
export declare function getTeamJobStatus(jobId: string): Promise<TeamJobStatus>;
export declare function waitForTeamJob(jobId: string, options?: TeamWaitOptions): Promise<TeamWaitResult>;
export declare function cleanupTeamJob(jobId: string, graceMs?: number): Promise<TeamCleanupResult>;
export declare function teamStatusByTeamName(teamName: string, cwd?: string): Promise<Record<string, unknown>>;
export declare function teamResumeByName(teamName: string, cwd?: string): Promise<Record<string, unknown>>;
export declare function teamShutdownByName(teamName: string, options?: {
    cwd?: string;
    force?: boolean;
}): Promise<Record<string, unknown>>;
export declare function executeTeamApiOperation(operation: string, input: Record<string, unknown>, cwd?: string): Promise<TeamApiEnvelope>;
export declare function teamStartCommand(input: TeamStartInput, options?: {
    json?: boolean;
}): Promise<TeamStartResult>;
export declare function teamStatusCommand(jobId: string, options?: {
    json?: boolean;
}): Promise<TeamJobStatus>;
export declare function teamWaitCommand(jobId: string, waitOptions?: TeamWaitOptions, options?: {
    json?: boolean;
}): Promise<TeamWaitResult>;
export declare function teamCleanupCommand(jobId: string, cleanupOptions?: {
    graceMs?: number;
}, options?: {
    json?: boolean;
}): Promise<TeamCleanupResult>;
export declare const TEAM_USAGE: string;
export declare function teamCommand(argv: string[]): Promise<void>;
export declare function main(argv: string[]): Promise<void>;
export {};
//# sourceMappingURL=team.d.ts.map