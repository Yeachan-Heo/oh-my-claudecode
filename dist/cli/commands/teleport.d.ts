/**
 * Teleport Command - Quick worktree creation for development
 *
 * Creates a git worktree for working on issues/PRs/features in isolation.
 * Default worktree location: ~/Workspace/omc-worktrees/
 */
export interface TeleportOptions {
    worktree?: boolean;
    worktreePath?: string;
    base?: string;
    noCd?: boolean;
    json?: boolean;
}
export interface TeleportResult {
    success: boolean;
    worktreePath?: string;
    branch?: string;
    error?: string;
}
/**
 * Main teleport command
 */
export declare function teleportCommand(ref: string, options: TeleportOptions): Promise<TeleportResult>;
/**
 * List existing worktrees in the default location
 */
export declare function teleportListCommand(options: {
    json?: boolean;
}): Promise<void>;
/**
 * Remove a worktree
 * Returns 0 on success, 1 on failure.
 */
export declare function teleportRemoveCommand(pathOrName: string, options: {
    force?: boolean;
    json?: boolean;
}): Promise<number>;
//# sourceMappingURL=teleport.d.ts.map