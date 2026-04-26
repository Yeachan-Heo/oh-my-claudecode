/**
 * Validate branch name to prevent flag injection in git commands.
 * Exported so other modules (e.g. merge-orchestrator) can guard branch names
 * before passing them to `git fetch/reset/rebase/rev-parse`.
 */
export declare function validateBranchName(branch: string): void;
export interface MergeResult {
    workerName: string;
    branch: string;
    success: boolean;
    conflicts: string[];
    mergeCommit?: string;
}
/**
 * Check for merge conflicts between a worker branch and the base branch.
 * Does NOT actually merge — uses `git merge-tree --write-tree` (Git 2.38+)
 * for non-destructive three-way merge simulation.
 * Falls back to file-overlap heuristic on older Git versions.
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