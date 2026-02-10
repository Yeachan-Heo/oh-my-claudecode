export interface WorktreeInfo {
    path: string;
    branch: string;
    workerName: string;
    teamName: string;
    createdAt: string;
}
/**
 * Create a git worktree for a team worker.
 * Path: {repoRoot}/.omc/worktrees/{team}/{worker}
 * Branch: omc-team/{teamName}/{workerName}
 */
export declare function createWorkerWorktree(teamName: string, workerName: string, repoRoot: string, baseBranch?: string): WorktreeInfo;
/**
 * Remove a worker's worktree and branch.
 */
export declare function removeWorkerWorktree(teamName: string, workerName: string, repoRoot: string): void;
/**
 * List all worktrees for a team.
 */
export declare function listTeamWorktrees(teamName: string, repoRoot: string): WorktreeInfo[];
/**
 * Remove all worktrees for a team (cleanup on shutdown).
 */
export declare function cleanupTeamWorktrees(teamName: string, repoRoot: string): void;
//# sourceMappingURL=git-worktree.d.ts.map