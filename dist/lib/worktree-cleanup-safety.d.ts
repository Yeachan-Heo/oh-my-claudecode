export interface WorktreeRemovalSafetyOptions {
    candidatePath: string;
    expectedRoots: string[];
    mainRepoRoots?: string[];
    requireExisting?: boolean;
}
export interface WorktreeRemovalSafetyResult {
    resolvedPath: string;
    matchedRoot: string;
}
/**
 * Validate that a destructive cleanup target is a concrete worktree-like child
 * under one of the OMC-owned worktree roots. This is intentionally small and
 * path-focused: callers still own git/dirty-state checks, while this helper
 * fails closed for path confusion, symlinks, main repositories, and root/home
 * accidents before any recursive removal can run.
 */
export declare function validateWorktreeRemovalTarget(options: WorktreeRemovalSafetyOptions): WorktreeRemovalSafetyResult;
//# sourceMappingURL=worktree-cleanup-safety.d.ts.map