/**
 * Epoch ownership single-writer fence over `<runsRoot>/<run_id>/owner.lock`.
 *
 * Protocol (normative; implements frozen OwnershipFence):
 * - Creation is always O_CREAT|O_EXCL; every removal/move is an atomic
 *   rename to a unique tombstone. There is no read-then-unlink anywhere
 *   against the live lock path (#3555 defect class).
 * - Stale = PID dead OR unparseable content, AND older than the grace
 *   period. A live healthy holder yields busy — fail-closed (AC-7).
 * - Takeover: rename(lock -> tombstone) — exactly one racer wins (the rest
 *   observe ENOENT/EEXIST/EPERM and retry); the winner reads the old epoch
 *   from the tombstone it now exclusively owns and re-creates the lock at
 *   old_epoch + 1 (AC-4).
 * - Epoch continuity: `<run_dir>/owner.epoch` sidecar records the highest
 *   epoch ever issued (plain integer text, atomically persisted while we
 *   exclusively hold the lock). New creations never reissue an epoch the
 *   sidecar has seen, so resume after release keeps advancing past journal
 *   history instead of restarting at 1.
 */
import type { RunDirHandle } from "./run-dir.js";
import type { FenceAcquireResult, OwnershipFence } from "./types.js";
export interface FileOwnershipFenceOptions {
    /** Age (ms) after which a dead/unparseable lock may be taken over. Default: 30000 */
    readonly staleGraceMs?: number;
    /** Test-only interlock used to deterministically exercise takeover races. */
    readonly beforeTakeoverRename?: () => void;
    /** Test-only interlock used to deterministically exercise release races. */
    readonly beforeReleaseRename?: () => void;
    /** Test-only interlock used to exercise failed-create cleanup races. */
    readonly beforeEpochPersist?: () => void;
}
export declare class FileOwnershipFence implements OwnershipFence {
    private readonly runsRoot;
    private readonly runId?;
    private readonly staleGraceMs;
    private readonly beforeTakeoverRename?;
    private readonly beforeReleaseRename?;
    private readonly beforeEpochPersist?;
    private handle?;
    /** fd of the held lock file while we own the run; null otherwise. */
    private fd;
    private heldEpoch;
    /**
     * The frozen `OwnershipFence` interface is run-scoped but carries no run
     * id, so an instance must be bound to one run. `runId` is optional only to
     * keep the brief's `new FileOwnershipFence(runsRoot)` signature
     * constructible; unbound instances fail closed on use.
     */
    constructor(runsRoot: string, runId?: string, options?: FileOwnershipFenceOptions, runDirHandle?: RunDirHandle);
    private runDir;
    acquire(): Promise<FenceAcquireResult>;
    private acquireAt;
    assertEpoch(epoch: number): void;
    private assertEpochAt;
    release(epoch: number): Promise<boolean>;
    private releaseAt;
    /**
     * Single O_EXCL creation attempt. Returns the open fd on success, null on
     * EEXIST; any other error propagates. On success the epoch sidecar is
     * atomically updated BEFORE ownership is handed out — a sidecar write
     * failure cleans up our just-created lock and propagates rather than
     * silently issuing an epoch that a later resume could reissue.
     */
    private tryCreate;
    /** Best-effort parse of the lock payload; null when absent/unparseable. */
    private readPayload;
    private readLockIdentity;
    private sameLockIdentity;
    private sameFileIdentity;
    private identityFromFd;
    /** Restore a foreign tombstone without replacing a path or deleting it. */
    private restoreForeignTombstone;
    /** A failed foreign restoration leaves a tombstone that must block takeover. */
    private hasOrphanedTombstone;
    /** Remove only a lock inode positively identified as ours after create. */
    private cleanupCreatedLock;
    /**
     * Verify the file currently at lockPath is still the exact file we hold an
     * fd for: same inode and size (fstatSync on our held fd vs lstatSync on the
     * path) AND payload epoch matching heldEpoch. Any stat failure or mismatch
     * fails closed — the caller must not mutate the path.
     */
    private holdsLiveLockFile;
    private clearHeld;
}
//# sourceMappingURL=fence.d.ts.map