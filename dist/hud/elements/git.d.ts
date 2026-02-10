/**
 * OMC HUD - Git Elements
 *
 * Renders git repository name and branch information.
 */
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
 * Render git repository name element.
 *
 * @param cwd - Working directory
 * @returns Formatted repo name or null
 */
export declare function renderGitRepo(cwd?: string): string | null;
/**
 * Render git branch element.
 *
 * @param cwd - Working directory
 * @returns Formatted branch name or null
 */
export declare function renderGitBranch(cwd?: string): string | null;
//# sourceMappingURL=git.d.ts.map