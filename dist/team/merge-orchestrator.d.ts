export interface OrchestratorConfig {
    teamName: string;
    repoRoot: string;
    leaderBranch: string;
    cwd: string;
    /** Polling interval for both the commit watcher and rebase resolver. Defaults to 1000ms. */
    pollIntervalMs?: number;
    /** Bound on `drainAndStop`. Defaults to 10000ms. */
    drainTimeoutMs?: number;
}
export interface OrchestratorHandle {
    /** Seed lastSha from the current branch HEAD (no fan-out on first observation). */
    registerWorker(workerName: string): Promise<void>;
    /** Stop tracking a worker. Idempotent. */
    unregisterWorker(workerName: string): Promise<void>;
    /**
     * Run a final merge sweep for every worker whose lastSha is newer than what
     * has been merged, then stop polling. Bounded by drainTimeoutMs.
     */
    drainAndStop(): Promise<{
        unmerged: Array<{
            workerName: string;
            reason: string;
        }>;
    }>;
    /** Run one poll cycle immediately (testing / debugging). */
    pollOnce(): Promise<void>;
    /** Inspect in-memory state (testing / debugging). */
    getState(): {
        workers: string[];
        lastShas: Record<string, string>;
        mergerWorktreePath: string;
    };
}
export type OrchestratorEventType = 'commit_observed' | 'merge_attempted' | 'merge_succeeded' | 'merge_conflict' | 'rebase_triggered' | 'rebase_skipped_in_progress' | 'rebase_succeeded' | 'rebase_conflict' | 'rebase_resolved' | 'restart_recovery';
export declare function startMergeOrchestrator(config: OrchestratorConfig): Promise<OrchestratorHandle>;
export declare function recoverFromRestart(config: OrchestratorConfig): Promise<{
    orphanedRebases: string[];
    persistedShasLoaded: number;
}>;
//# sourceMappingURL=merge-orchestrator.d.ts.map