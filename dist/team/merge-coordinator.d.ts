export interface MergeResult {
    workerName: string;
    branch: string;
    success: boolean;
    conflicts: string[];
    mergeCommit?: string;
}
/**
 * Check for merge conflicts between a worker branch and the base branch.
 * Does NOT actually merge -- uses git merge-tree for non-destructive check.
 * Returns list of conflicting file paths, empty if clean.
 */
export declare function checkMergeConflicts(workerBranch: string, baseBranch: string, repoRoot: string): string[];
/**
 * Merge a worker's branch back to the base branch.
 * Uses --no-ff to preserve merge history.
 * On failure, always aborts to prevent leaving repo dirty.
 */
export declare function mergeWorkerBranch(workerBranch: string, baseBranch: string, repoRoot: string): MergeResult;
/**
 * Merge all completed worker branches for a team.
 * Processes worktrees in order.
 */
export declare function mergeAllWorkerBranches(teamName: string, repoRoot: string, baseBranch?: string): MergeResult[];
//# sourceMappingURL=merge-coordinator.d.ts.map