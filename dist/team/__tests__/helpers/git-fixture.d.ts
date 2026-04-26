import type { OrchestratorHandle } from '../../merge-orchestrator.js';
export interface WorkerFixture {
    name: string;
    worktreePath: string;
    branch: string;
}
export interface GitFixture {
    /** Root of the (non-bare) git repository. */
    repoRoot: string;
    /** Leader branch name — never main/master. */
    leaderBranch: string;
    /** Team name used for orchestrator config. */
    teamName: string;
    /** Array of worker descriptors. */
    workers: WorkerFixture[];
    /**
     * Commit a file in a worker worktree.
     * Returns the resulting commit SHA.
     */
    commitFile(workerName: string, relPath: string, content: string): Promise<string>;
    /**
     * Read the HEAD SHA of any branch in the repo.
     */
    getBranchSha(branch: string): string;
    /**
     * Create a gitdir-aware rebase-merge marker for a real git worktree.
     * Returns the marker path.
     */
    createRebaseState(workerName: string): string;
    /**
     * Simulate a runtime restart: stops the orchestrator handle (if any was attached
     * via attachHandle) without cleanup. Optionally creates an orphan rebase-merge
     * dir inside the specified worker worktree's real gitdir.
     */
    simulateRuntimeRestart(orphanWorkerName?: string): Promise<void>;
    /** Attach an orchestrator handle so simulateRuntimeRestart can stop it. */
    attachHandle(handle: OrchestratorHandle): void;
    /**
     * Remove all temporary directories.
     * Call this in afterEach.
     */
    cleanup(): Promise<void>;
}
export interface CreateGitFixtureOpts {
    workerCount: number;
    leaderBranchName?: string;
    teamName?: string;
}
export declare function createGitFixture(opts: CreateGitFixtureOpts): Promise<GitFixture>;
export interface WaitForEventOpts {
    /** Path to orchestrator-events.jsonl */
    eventLogPath: string;
    /** Event type to look for */
    eventType: string;
    /** Minimum count of matching events required */
    count?: number;
    /** Total timeout in ms */
    timeoutMs?: number;
    /** Optional worker name filter */
    worker?: string;
}
export declare function waitForEventInLog(opts: WaitForEventOpts): Promise<void>;
/** Read all events from the orchestrator event log. */
export declare function readEventLog(eventLogPath: string): Array<{
    type: string;
    worker?: string;
    [k: string]: unknown;
}>;
/** Build the event log path for a team. */
export declare function orchestratorEventLogPath(repoRoot: string, teamName: string): string;
//# sourceMappingURL=git-fixture.d.ts.map