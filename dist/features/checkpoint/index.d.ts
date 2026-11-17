/**
 * Workspace checkpoints: snapshot-and-rollback for autonomous runs.
 *
 * A checkpoint is a git "shadow commit": the full working tree (tracked,
 * modified, and untracked-but-not-ignored files) is captured via a
 * temporary index and stored under `refs/omc/checkpoints/<sha>` without
 * touching HEAD, the real index, or the worktree. Rolling back restores
 * the worktree + index from that tree.
 *
 * Design constraints:
 * - Git-only by design: OMC already requires git for its core workflows,
 *   and shadow commits are the only snapshot mechanism that is cheap
 *   (no file copying), complete (includes untracked files), and safe
 *   (nothing outside refs/omc/ changes at snapshot time).
 * - Rollback removes files created after the snapshot (git clean -fd,
 *   which keeps ignored paths like node_modules) and requires --force
 *   when the working tree is dirty, because it discards uncommitted work.
 */
export declare class CheckpointError extends Error {
    readonly exitCode: number;
    constructor(message: string, exitCode?: number);
}
/**
 * Snapshot the whole working tree (including untracked non-ignored files)
 * as a shadow commit and store it under refs/omc/checkpoints/.
 *
 * Returns the 12-char checkpoint id (abbreviated commit sha).
 */
export declare function createCheckpoint(cwd: string, label: string): string;
export interface CheckpointEntry {
    readonly id: string;
    readonly label: string;
    readonly createdAt: string;
}
/** List checkpoints (oldest first) for the enclosing repository. */
export declare function listCheckpoints(cwd: string): CheckpointEntry[];
/**
 * True when the working tree differs from HEAD (tracked modifications or
 * untracked non-ignored files). Used to gate rollback behind --force.
 */
export declare function isWorktreeDirty(cwd: string): boolean;
/**
 * Restore the worktree and index from a checkpoint.
 *
 * Files created after the snapshot are removed (git clean -fd keeps
 * ignored paths such as node_modules). Refuses when the worktree is dirty
 * unless force is set, because rollback discards uncommitted work.
 */
export declare function rollbackToCheckpoint(cwd: string, checkpointId: string, force?: boolean): void;
//# sourceMappingURL=index.d.ts.map