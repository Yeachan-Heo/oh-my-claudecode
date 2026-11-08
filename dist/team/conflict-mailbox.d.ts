export interface MergeConflictArgs {
    workerName: string;
    workerBranch: string;
    leaderBranch: string;
    conflictingFiles: string[];
    mergeBaseSha: string;
    observedAt: number;
}
export interface RebaseConflictArgs {
    workerName: string;
    workerBranch: string;
    leaderBranch: string;
    conflictingFiles: string[];
    baseSha: string;
    worktreePath: string;
    observedAt: number;
}
/**
 * Format a merge conflict notification destined for the leader inbox.
 * Pure: same input → same output.
 */
export declare function formatMergeConflictForLeader(args: MergeConflictArgs): string;
/**
 * Format a rebase conflict notification destined for a worker inbox.
 * Pure: same input → same output.
 */
export declare function formatRebaseConflictForWorker(args: RebaseConflictArgs): string;
export interface DeliverMergeConflictArgs {
    teamName: string;
    cwd: string;
    message: string;
}
export interface DeliverRebaseConflictArgs {
    teamName: string;
    workerName: string;
    cwd: string;
    message: string;
}
/**
 * Deliver a merge conflict message to the leader inbox.
 * Delegates to leader-inbox.appendToLeaderInbox.
 */
export declare function deliverMergeConflictToLeader(args: DeliverMergeConflictArgs): Promise<void>;
/**
 * Deliver a rebase conflict message to a worker inbox.
 * Delegates to worker-bootstrap.appendToInbox.
 */
export declare function deliverRebaseConflictToWorker(args: DeliverRebaseConflictArgs): Promise<void>;
//# sourceMappingURL=conflict-mailbox.d.ts.map