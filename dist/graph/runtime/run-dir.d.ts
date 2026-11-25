/**
 * Run-directory containment for graph runtime persistence (P1-3).
 *
 * Every persisted artifact lives under `<runsRoot>/<run_id>/`. A run_id is
 * descriptor-supplied and therefore untrusted: resolving it must never let a
 * traversal-shaped id or a symlinked run directory redirect writes outside
 * the runs root. resolveRunDir validates, creates, and containment-checks
 * the directory with directory-FD-relative operations, failing closed on any escape or
 * on platforms without that primitive.
 */
/**
 * Open or create one directory component below an already-open directory.
 * Both the mkdir and the subsequent open are anchored at the parent FD, so a
 * pathname replacement cannot redirect creation through a symlink.
 */
export declare function openOrCreateDirectoryAt(parentFd: number, name: string, label: string): number;
/**
 * Open one existing directory component below an already-open directory
 * without following a symlink at that component. Returns null when the
 * component does not exist; a symlinked component fails closed.
 */
export declare function openExistingDirectoryAt(parentFd: number, name: string, label: string): number | null;
export interface RunDirHandle {
    readonly path: string;
    readonly device: number;
    readonly inode: number;
}
/**
 * Resolve (and create) the contained run directory for one run.
 *
 * Returns the plain `join(runsRoot, runId)` path so existing relative
 * behaviors stay stable; containment is enforced against an open directory
 * FD before returning. Throws RangeError("invalid run_id") on malformed ids
 * and Error on symlinked or escaping directories.
 */
export declare function resolveRunDir(runsRoot: string, runId: string): string;
/** Resolve a run directory and capture the directory identity for safe I/O. */
export declare function resolveRunDirHandle(runsRoot: string, runId: string): RunDirHandle;
//# sourceMappingURL=run-dir.d.ts.map