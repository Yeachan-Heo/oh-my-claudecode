export type TeamWorktreeMode = 'disabled' | 'detached' | 'named';
export interface WorktreeInfo {
    path: string;
    branch: string;
    workerName: string;
    teamName: string;
    createdAt: string;
    repoRoot?: string;
    detached?: boolean;
    created?: boolean;
    reused?: boolean;
}
export interface EnsureWorkerWorktreeOptions {
    mode?: TeamWorktreeMode;
    baseRef?: string;
    requireCleanLeader?: boolean;
}
export interface EnsureWorkerWorktreeResult extends WorktreeInfo {
    mode: TeamWorktreeMode;
    repoRoot: string;
    detached: boolean;
    created: boolean;
    reused: boolean;
}
export interface CleanupTeamWorktreesResult {
    removed: string[];
    preserved: Array<{
        workerName: string;
        path: string;
        reason: string;
    }>;
}
export interface TeamWorktreeCleanupSafety {
    hasEvidence: boolean;
    entries: WorktreeInfo[];
    blockers: Array<{
        workerName: string;
        path: string;
        reason: string;
    }>;
}
export interface WorktreeRootAgentsRestoreResult {
    restored: boolean;
    reason?: string;
}
/** Get canonical native team worktree path for a worker. */
export declare function getWorktreePath(repoRoot: string, teamName: string, workerName: string): string;
/** Get branch name for a worker. */
export declare function getBranchName(teamName: string, workerName: string): string;
/**
 * Install the generated worker overlay into the root of a native worker worktree.
 * Existing root AGENTS.md content is backed up under leader-owned state so cleanup
 * can safely restore it. Reinstalling preserves the first original backup instead
 * of treating an older managed overlay as user content.
 */
export declare function installWorktreeRootAgents(teamName: string, workerName: string, repoRoot: string, worktreePath: string, overlayContent: string): void;
/**
 * Restore or remove a managed worktree-root AGENTS.md when it is still unchanged.
 * If a worker edited AGENTS.md, leave it and report agents_dirty so cleanup can
 * preserve the worktree instead of overwriting user changes.
 */
export declare function restoreWorktreeRootAgents(teamName: string, workerName: string, repoRoot: string, worktreePath?: string): WorktreeRootAgentsRestoreResult;
export declare function normalizeTeamWorktreeMode(value: unknown): TeamWorktreeMode;
/**
 * Ensure a worker worktree exists according to the selected opt-in mode.
 * Disabled mode is a no-op. Existing clean compatible worktrees are reused;
 * dirty or mismatched existing worktrees throw without deleting files.
 */
export declare function ensureWorkerWorktree(teamName: string, workerName: string, repoRoot: string, options?: EnsureWorkerWorktreeOptions): EnsureWorkerWorktreeResult | null;
/** Legacy creation helper: create or reuse a named-branch worker worktree. */
export declare function createWorkerWorktree(teamName: string, workerName: string, repoRoot: string, baseBranch?: string): WorktreeInfo;
/**
 * Dry-run validation for worker worktree removal. This does not restore/remove
 * managed root AGENTS.md and does not delete backup state.
 */
export declare function checkWorkerWorktreeRemovalSafety(teamName: string, workerName: string, repoRoot: string, worktreePath?: string): void;
/**
 * Prepare a worker worktree for later removal without deleting the worktree.
 *
 * This is transactional with respect to managed root AGENTS.md overlays: it first
 * validates the overlay is restorable and that no non-overlay files are dirty.
 * Only after that dry-run succeeds does it restore/remove AGENTS.md and delete
 * the backup. If any other dirty file exists, the worker pane/config can remain
 * intact with the managed overlay and backup still available for a later retry.
 */
export declare function prepareWorkerWorktreeForRemoval(teamName: string, workerName: string, repoRoot: string, worktreePath?: string): void;
/** Remove a worker's worktree and branch, preserving dirty worktrees. */
export declare function removeWorkerWorktree(teamName: string, workerName: string, repoRoot: string): void;
/** List all worktrees for a team. */
export declare function listTeamWorktrees(teamName: string, repoRoot: string): WorktreeInfo[];
export declare function inspectTeamWorktreeCleanupSafety(teamName: string, repoRoot: string): TeamWorktreeCleanupSafety;
/** Remove all clean worktrees for a team, preserving dirty worktrees. */
export declare function cleanupTeamWorktrees(teamName: string, repoRoot: string): CleanupTeamWorktreesResult;
//# sourceMappingURL=git-worktree.d.ts.map