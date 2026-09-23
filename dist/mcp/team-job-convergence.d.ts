export interface OmcTeamJob {
    status: 'running' | 'completed' | 'failed' | 'timeout';
    result?: string;
    stderr?: string;
    startedAt: number;
    pid?: number;
    instanceId: string;
    paneIds?: string[];
    leaderPaneId?: string;
    teamName?: string;
    cwd?: string;
    cleanedUpAt?: string;
    cleanupBlockedAt?: string;
    cleanupBlockedReason?: string;
}
export interface TeamPaneArtifact {
    instanceId: string;
    paneIds: string[];
    leaderPaneId: string;
    sessionName?: string;
    ownsWindow?: boolean;
    workers: Array<{
        workerName: string;
        paneId: string;
        launchAttemptId: string;
    }>;
}
export declare function convergeJobWithResultArtifact(job: OmcTeamJob, jobId: string, omcJobsDir: string): {
    job: OmcTeamJob;
    changed: boolean;
};
export declare function resultArtifactIdentityError(job: Pick<OmcTeamJob, 'instanceId'>, jobId: string, omcJobsDir: string): string | null;
/** Return a terminal artifact only when its immutable identity matches the job. */
export declare function readMatchingTerminalArtifact(job: Pick<OmcTeamJob, 'instanceId'>, jobId: string, omcJobsDir: string): {
    status: 'completed' | 'failed';
    raw: string;
} | null;
export declare function isJobTerminal(job: OmcTeamJob): boolean;
export declare function isValidOmcTeamJob(value: unknown): value is OmcTeamJob;
export declare function isValidTeamPaneArtifact(value: unknown, instanceId: string): value is TeamPaneArtifact;
//# sourceMappingURL=team-job-convergence.d.ts.map