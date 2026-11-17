/**
 * Validate branch name to prevent flag injection in git commands.
 * Exported so other modules (e.g. merge-orchestrator) can guard branch names
 * before passing them to `git fetch/reset/rebase/rev-parse`.
 */
export declare function validateBranchName(branch: string): void;
/**
 * Harness overlay files that OMC writes into every worker worktree
 * (AGENTS.md and the .claude/ settings overlay). They are infrastructure,
 * not task output, and differ per worker — so the auto-merge / auto-rebase
 * fan-out collides on them (`UU AGENTS.md`) even when the actual task files
 * are disjoint. See issue #3224.
 */
export declare const HARNESS_MERGE_PATHS: readonly ["AGENTS.md", ".claude/**"];
/**
 * Configure a trivial `merge=ours` driver for harness overlay files so the
 * team auto-merge / auto-rebase never conflicts on infrastructure (#3224).
 *
 * Registers the built-in-style `ours` driver (`true` keeps the current
 * version and exits 0) and writes `<path> merge=ours` lines into the repo's
 * shared `info/attributes`. Both apply across every linked worktree because
 * worktrees share the common git dir, so a single call from a team merge
 * entry point covers the merger worktree and all worker worktrees.
 *
 * Idempotent: re-registers the driver (a no-op set) and only appends
 * attribute lines that are not already present.
 */
export declare function configureHarnessMergeAttributes(repoRoot: string): void;
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