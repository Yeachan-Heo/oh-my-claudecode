/**
 * OMC HUD - Git Elements
 *
 * Renders git repository name and branch information.
 */
export interface WorktreeDetection {
    isWorktree: boolean;
    worktreeName: string | null;
}
/**
 * Clear all git caches. Call in tests beforeEach to ensure a clean slate.
 */
export declare function resetGitCache(): void;
/**
 * Get git repository name from remote URL.
 * Extracts the repo name from URLs like:
 * - https://github.com/user/repo.git
 * - git@github.com:user/repo.git
 *
 * @param cwd - Working directory to run git command in
 * @returns Repository name or null if not available
 */
export declare function getGitRepoName(cwd?: string): string | null;
/**
 * Get current git branch name.
 *
 * @param cwd - Working directory to run git command in
 * @returns Branch name or null if not available
 */
export declare function getGitBranch(cwd?: string): string | null;
/**
 * Detect if the current directory is inside a git linked worktree.
 * Compares --git-dir with --git-common-dir; they differ in linked worktrees.
 * When in a worktree, extracts the worktree name from the git-dir path.
 *
 * @param cwd - Working directory
 * @returns Worktree detection result (cached for CACHE_TTL_MS)
 */
export declare function getWorktreeInfo(cwd?: string): WorktreeDetection;
/**
 * Render git repository name element.
 *
 * @param cwd - Working directory
 * @returns Formatted repo name or null
 */
export declare function renderGitRepo(cwd?: string): string | null;
/**
 * Render git branch element.
 * When inside a linked worktree, appends the worktree name as suffix:
 *   branch:feature-x (wt:my-wt)
 *
 * @param cwd - Working directory
 * @returns Formatted branch name or null
 */
export declare function renderGitBranch(cwd?: string): string | null;
//# sourceMappingURL=git.d.ts.map