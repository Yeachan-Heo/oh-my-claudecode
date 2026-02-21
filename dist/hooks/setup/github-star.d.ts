/**
 * GitHub Star Module
 *
 * Handles auto-starring of the oh-my-claudecode repository during setup.
 */
import { execSync } from 'child_process';
export interface StarResult {
    starred: boolean;
    message: string;
    action?: 'already_starred' | 'newly_starred' | 'skipped' | 'failed';
}
export type ExecFunction = typeof execSync;
export interface GitHubStarOptions {
    repo?: string;
    silent?: boolean;
    execFn?: ExecFunction;
}
/**
 * Check if gh CLI is available
 */
export declare function isGhCliAvailable(execFn?: ExecFunction): boolean;
/**
 * Check if repository is already starred
 */
export declare function isRepoStarred(repo: string, execFn?: ExecFunction): boolean;
/**
 * Star the repository
 */
export declare function starRepository(repo: string, execFn?: ExecFunction): boolean;
/**
 * Auto-star oh-my-claudecode repository if not already starred
 *
 * @param options - Configuration options
 * @returns Star result with status and message
 */
export declare function autoStarRepository(options?: GitHubStarOptions): StarResult;
//# sourceMappingURL=github-star.d.ts.map