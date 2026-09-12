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

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  writeSync,
} from "fs";
import type { ContainedStats, DirectoryOperations } from "./contained-fd.js";
import { randomBytes } from "crypto";
import { atomicWriteFileSync } from "../../lib/atomic-write.js";
import { isProcessAlive } from "../../platform/index.js";
import { resolveRunDirHandle } from "./run-dir.js";
import type { RunDirHandle } from "./run-dir.js";
import {
  readOperationFileNoFollow,
  withContainedOperations,
} from "./safe-fs.js";
import { FenceError } from "./types.js";
import type { FenceAcquireResult, FenceLockPayload, OwnershipFence } from "./types.js";

const DEFAULT_STALE_GRACE_MS = 30_000;
const LOCK_FILE_NAME = "owner.lock";
const EPOCH_FILE_NAME = "owner.epoch";

interface LockIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly payload: FenceLockPayload | null;
}

function isSafeEpoch(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function canIssueSuccessor(value: unknown): value is number {
  return isSafeEpoch(value) && value < Number.MAX_SAFE_INTEGER;
}

/**
 * Highest epoch ever issued for this run, parsed from the sidecar; null when
 * the sidecar is missing or unreadable (fresh run / lost continuity).
 */
function readSidecarCeiling(operations: DirectoryOperations, filePath: string): number | null {
  let text: string;
  try {
    text = readOperationFileNoFollow(operations, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error("owner.epoch is not a canonical plain integer");
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || String(value) !== text) {
    throw new Error("owner.epoch is outside the safe integer range");
  }
  return value;
}

function lstatNoFollow(operations: DirectoryOperations, filePath: string): ContainedStats {
  const stats = operations.lstat(filePath);
  if (stats.isSymbolicLink()) {
    const error = new Error(`symbolic link refused: ${filePath}`) as NodeJS.ErrnoException;
    error.code = "ELOOP";
    throw error;
  }
  return stats;
}

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

export class FileOwnershipFence implements OwnershipFence {
  private readonly runsRoot: string;
  private readonly runId?: string;
  private readonly staleGraceMs: number;
  private readonly beforeTakeoverRename?: () => void;
  private readonly beforeReleaseRename?: () => void;
  private readonly beforeEpochPersist?: () => void;
  private handle?: RunDirHandle;
  /** fd of the held lock file while we own the run; null otherwise. */
  private fd: number | null = null;
  private heldEpoch: number | null = null;

  /**
   * The frozen `OwnershipFence` interface is run-scoped but carries no run
   * id, so an instance must be bound to one run. `runId` is optional only to
   * keep the brief's `new FileOwnershipFence(runsRoot)` signature
   * constructible; unbound instances fail closed on use.
   */
  constructor(
    runsRoot: string,
    runId?: string,
    options?: FileOwnershipFenceOptions,
    runDirHandle?: RunDirHandle,
  ) {
    this.runsRoot = runsRoot;
    this.runId = runId;
    this.staleGraceMs = options?.staleGraceMs ?? DEFAULT_STALE_GRACE_MS;
    this.beforeTakeoverRename = options?.beforeTakeoverRename;
    this.beforeReleaseRename = options?.beforeReleaseRename;
    this.beforeEpochPersist = options?.beforeEpochPersist;
    this.handle = runDirHandle;
  }

  private runDir(): RunDirHandle {
    if (this.runId === undefined) {
      throw new Error(
        "FileOwnershipFence is not bound to a run; pass runId to the constructor",
      );
    }
    this.handle ??= resolveRunDirHandle(this.runsRoot, this.runId);
    return this.handle;
  }

  async acquire(): Promise<FenceAcquireResult> {
    return withContainedOperations(this.runDir(), (operations) =>
      this.acquireAt(operations),
    );
  }

  private acquireAt(operations: DirectoryOperations): FenceAcquireResult {
    const lockPath = LOCK_FILE_NAME;
    const epochFilePath = EPOCH_FILE_NAME;
    let candidateEpoch = 1;
    // Each iteration makes progress toward either acquisition or a
    // live-holder busy. The sidecar ceiling is re-read every iteration
    // concurrent racer may have persisted a higher epoch between
    // our attempts.
    for (;;) {
      if (this.hasOrphanedTombstone(operations)) {
        // A contender must never create a new lock while a moved foreign
        // inode has no live name. The owner performing the restoration may
        // still be in flight, so report the same fail-closed busy outcome as
        // any other concurrent takeover rather than racing it.
        return { outcome: "busy" };
      }
      const ceiling = readSidecarCeiling(operations, epochFilePath);
      if (ceiling === Number.MAX_SAFE_INTEGER) {
        throw new Error("owner.epoch has no representable successor");
      }
      // Never reissue an epoch the sidecar has seen; a missing/corrupt
      // sidecar imposes no floor (fresh runs still start at epoch 1).
      const candidate = Math.max(candidateEpoch, (ceiling ?? 0) + 1);
      if (!isSafeEpoch(candidate)) {
        throw new Error("owner epoch has no safe representable value");
      }
      const fd = this.tryCreate(operations, lockPath, epochFilePath, candidate);
      if (fd !== null) {
        this.fd = fd;
        this.heldEpoch = candidate;
        return { outcome: "acquired", epoch: candidate };
      }

      // EEXIST — inspect the existing lock best-effort.
      const existing = this.readPayload(operations, lockPath);
      if (existing !== null && isProcessAlive(existing.pid)) {
        // Live healthy holder: fail closed, never assume multi-writer (AC-7).
        return { outcome: "busy" };
      }

      // Dead pid or unparseable content: takeover only past the grace period.
      let ageMs: number;
      try {
        ageMs = Date.now() - lstatNoFollow(operations, lockPath).mtimeMs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") throw error;
        continue; // Lock vanished under us; retry exclusive creation.
      }
      if (ageMs <= this.staleGraceMs) {
        return { outcome: "busy" };
      }

      const staleIdentity = this.readLockIdentity(operations, lockPath);
      if (staleIdentity === null) {
        // The path disappeared or became unreadable after the staleness
        // check.  Do not rename an object we cannot positively identify.
        continue;
      }
      this.beforeTakeoverRename?.();

      // Takeover step: atomic rename to a unique tombstone. Exactly one
      // racer wins; losers observe ENOENT/EEXIST/EPERM here and retry (AC-6).
      const tombstone = `${lockPath}.tomb.${randomBytes(6).toString("hex")}`;
      try {
        operations.rename(lockPath, tombstone);
      } catch {
        continue; // Another racer won the move; restart from step 1.
      }

      // Rename is atomic but has no compare-and-swap form. A racer can
      // replace the stale path between our inspection and rename. Verify the
      // object we moved before treating the tombstone as ours; if it is a
      // replacement owner's lock, restore its live path or discard only our
      // extra tombstone link and never adopt/delete its ownership.
      const movedIdentity = this.readLockIdentity(operations, tombstone);
      if (!this.sameLockIdentity(staleIdentity, movedIdentity)) {
        // The object we moved was not the stale lock we inspected.  It is a
        // foreign owner's lock; never unlink it and never overwrite a path
        // that may have been recreated by another writer.  A no-replace hard
        // link restores the live name when it is still absent.  Leaving the
        // unique tombstone behind is intentional when restoration races: it
        // is safer than deleting a foreign lock to tidy up our own name.
        this.restoreForeignTombstone(operations, lockPath, tombstone);
        continue;
      }

      // We exclusively own the tombstone now: read the old epoch from it.
      // ponytail: best-effort — an unparseable tombstone falls back to
      // old_epoch 1; continuity then rests on the owner.epoch sidecar, and
      // only if BOTH are lost can an epoch value repeat. Ownership safety
      // comes from O_EXCL create + atomic rename, not from the epoch value.
      let oldEpoch = 1; // preserve corrupt-lock recovery for non-JSON content
      try {
        const parsed: unknown = JSON.parse(readOperationFileNoFollow(operations, tombstone));
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          Object.prototype.hasOwnProperty.call(parsed, "epoch")
        ) {
          const epoch = (parsed as Record<string, unknown>).epoch;
          if (!canIssueSuccessor(epoch)) {
            throw new Error("stale lock epoch is not a safe integer");
          }
          oldEpoch = epoch;
        }
      } catch (error) {
        if ((error as Error).message === "stale lock epoch is not a safe integer") {
          try {
            operations.unlink(tombstone);
          } catch {
            // Best effort cleanup of our own tombstone.
          }
          throw error;
        }
        // Unparseable JSON tombstone: keep fallback old_epoch = 1.
      }
      try {
        operations.unlink(tombstone); // safe: unique name we exclusively own
      } catch {
        // Best-effort cleanup of our own tombstone.
      }
      candidateEpoch = oldEpoch + 1;
    }
  }

  assertEpoch(epoch: number): void {
    withContainedOperations(this.runDir(), (operations) =>
      this.assertEpochAt(epoch, operations),
    );
  }

  private assertEpochAt(epoch: number, operations: DirectoryOperations): void {
    if (
      this.fd === null ||
      this.heldEpoch === null ||
      epoch !== this.heldEpoch ||
      !this.holdsLiveLockFile(operations, LOCK_FILE_NAME)
    ) {
      throw new FenceError(
        "fenced_out",
        `epoch ${epoch} is not owned by this process (held: ${String(this.heldEpoch)})`,
      );
    }
  }

  async release(epoch: number): Promise<boolean> {
    return withContainedOperations(this.runDir(), (operations) =>
      this.releaseAt(epoch, operations),
    );
  }

  private releaseAt(epoch: number, operations: DirectoryOperations): boolean {
    if (this.fd === null || this.heldEpoch === null || epoch !== this.heldEpoch) {
      return false;
    }
    const lockPath = LOCK_FILE_NAME;
    // Identity check before any mutation: the file at the lock path must
    // still be OUR held file. A stale holder must never rename away a
    // replacement owner's lock planted at the same path.
    const heldIdentity = this.readLockIdentity(operations, lockPath);
    if (heldIdentity === null || !this.holdsLiveLockFile(operations, lockPath)) {
      // We no longer own the run; leave whatever is there untouched.
      this.clearHeld();
      return false;
    }
    this.beforeReleaseRename?.();
    const tombstone = `${lockPath}.tomb.${randomBytes(6).toString("hex")}`;
    try {
      operations.rename(lockPath, tombstone);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Another process already moved the lock; we no longer own the run.
        this.clearHeld();
        return false;
      }
      throw error;
    }
    const movedIdentity = this.readLockIdentity(operations, tombstone);
    if (!this.sameLockIdentity(heldIdentity, movedIdentity)) {
      // The live path changed after our identity check.  We moved a foreign
      // lock, so restore it without replacement and do not delete its only
      // directory entry.  The held fd is closed below; ownership is lost.
      try {
        this.restoreForeignTombstone(operations, lockPath, tombstone);
      } finally {
        this.clearHeld();
      }
      return false;
    }
    this.clearHeld();
    try {
      operations.unlink(tombstone); // safe: unique name we exclusively own
    } catch {
      // Best-effort cleanup of our own tombstone.
    }
    return true;
  }

  /**
   * Single O_EXCL creation attempt. Returns the open fd on success, null on
   * EEXIST; any other error propagates. On success the epoch sidecar is
   * atomically updated BEFORE ownership is handed out — a sidecar write
   * failure cleans up our just-created lock and propagates rather than
   * silently issuing an epoch that a later resume could reissue.
   */
  private tryCreate(
    operations: DirectoryOperations,
    lockPath: string,
    epochFilePath: string,
    epoch: number,
  ): number | null {
    let fd: number;
    try {
      fd = operations.open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return null;
      }
      throw error;
    }
    try {
      const payload: FenceLockPayload = {
        pid: process.pid,
        epoch,
        timestamp: Date.now(),
      };
      writeSync(fd, JSON.stringify(payload), null, "utf8");
      this.beforeEpochPersist?.();
      // Persist epoch continuity while we still hold exclusive ownership of
      // the just-created lock (temp+rename inside; failure cleans up below).
      atomicWriteFileSync(epochFilePath, String(epoch), undefined, operations);
    } catch (error) {
      const createdIdentity = this.identityFromFd(fd);
      closeSync(fd);
      // The path may have been replaced while writing the payload or
      // persisting owner.epoch.  Move-then-identify cleanup removes only the
      // inode we created; a replacement is restored/no-replace preserved.
      this.cleanupCreatedLock(operations, lockPath, createdIdentity);
      throw error;
    }
    return fd;
  }

  /** Best-effort parse of the lock payload; null when absent/unparseable. */
  private readPayload(operations: DirectoryOperations, lockPath: string): FenceLockPayload | null {
    try {
      const parsed: unknown = JSON.parse(readOperationFileNoFollow(operations, lockPath));
      if (parsed === null || typeof parsed !== "object") {
        return null;
      }
      const record = parsed as Record<string, unknown>;
      if (
        typeof record.pid !== "number" ||
        !Number.isInteger(record.pid) ||
        !isSafeEpoch(record.epoch) ||
        typeof record.timestamp !== "number"
      ) {
        return null;
      }
      return {
        pid: record.pid,
        epoch: record.epoch,
        timestamp: record.timestamp,
      };
    } catch {
      return null;
    }
  }

  private readLockIdentity(operations: DirectoryOperations, lockPath: string): LockIdentity | null {
    try {
      const stats = lstatNoFollow(operations, lockPath);
      return {
        dev: stats.dev,
        ino: stats.ino,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        payload: this.readPayload(operations, lockPath),
      };
    } catch {
      return null;
    }
  }

  private sameLockIdentity(
    left: LockIdentity | null,
    right: LockIdentity | null,
  ): boolean {
    if (left === null || right === null) return false;
    const leftPayload = left.payload;
    const rightPayload = right.payload;
    return (
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      leftPayload?.pid === rightPayload?.pid &&
      leftPayload?.epoch === rightPayload?.epoch &&
      leftPayload?.timestamp === rightPayload?.timestamp
    );
  }

  private sameFileIdentity(
    left: LockIdentity | null,
    right: LockIdentity | null,
  ): boolean {
    return (
      left !== null &&
      right !== null &&
      left.dev === right.dev &&
      left.ino === right.ino
    );
  }

  private identityFromFd(fd: number): LockIdentity | null {
    try {
      const stats = fstatSync(fd);
      return {
        dev: stats.dev,
        ino: stats.ino,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        payload: null,
      };
    } catch {
      return null;
    }
  }

  /** Restore a foreign tombstone without replacing a path or deleting it. */
  private restoreForeignTombstone(operations: DirectoryOperations, lockPath: string, tombstone: string): void {
    try {
      // linkSync never replaces an existing destination.  If it races with a
      // new owner, keep both entries rather than unlinking the foreign inode.
      operations.link(tombstone, lockPath);
      operations.unlink(tombstone);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        // A concurrent owner already restored/planted the live path. Only
        // remove our tombstone when it is the same inode; never hide a
        // distinct foreign lock behind an orphaned alias.
        const liveIdentity = this.readLockIdentity(operations, lockPath);
        const tombstoneIdentity = this.readLockIdentity(operations, tombstone);
        if (this.sameLockIdentity(liveIdentity, tombstoneIdentity)) {
          operations.unlink(tombstone);
          return;
        }
        throw new Error("foreign lock restoration raced with another inode");
      }
      // Never continue acquisition with an orphaned foreign lock. The
      // tombstone remains durable for an operator/recovery process to repair.
      throw new Error(
        `foreign lock tombstone could not be restored: ${String(
          (error as Error).message ?? error,
        )}`,
      );
    }
  }

  /** A failed foreign restoration leaves a tombstone that must block takeover. */
  private hasOrphanedTombstone(operations: DirectoryOperations): boolean {
    try {
      return operations.readDir().some((entry) =>
        entry.startsWith(`${LOCK_FILE_NAME}.tomb.`),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  /** Remove only a lock inode positively identified as ours after create. */
  private cleanupCreatedLock(
    operations: DirectoryOperations,
    lockPath: string,
    createdIdentity: LockIdentity | null,
  ): void {
    if (createdIdentity === null) return;
    const tombstone = `${lockPath}.tomb.${randomBytes(6).toString("hex")}`;
    try {
      operations.rename(lockPath, tombstone);
    } catch {
      // The path vanished or another writer owns it; do not mutate anything.
      return;
    }
    const movedIdentity = this.readLockIdentity(operations, tombstone);
    if (this.sameFileIdentity(createdIdentity, movedIdentity)) {
      try {
        operations.unlink(tombstone);
      } catch {
        // Best effort cleanup of our own tombstone.
      }
      return;
    }
    this.restoreForeignTombstone(operations, lockPath, tombstone);
  }

  /**
   * Verify the file currently at lockPath is still the exact file we hold an
   * fd for: same inode and size (fstatSync on our held fd vs lstatSync on the
   * path) AND payload epoch matching heldEpoch. Any stat failure or mismatch
   * fails closed — the caller must not mutate the path.
   */
  private holdsLiveLockFile(operations: DirectoryOperations, lockPath: string): boolean {
    if (this.fd === null || this.heldEpoch === null) {
      return false;
    }
    try {
      const ours = fstatSync(this.fd);
      const theirs = lstatNoFollow(operations, lockPath);
      if (ours.ino !== theirs.ino || ours.size !== theirs.size) {
        return false;
      }
    } catch {
      // Lock path vanished or is unreadable: we do not own what is there.
      return false;
    }
    const payload = this.readPayload(operations, lockPath);
    return payload !== null && payload.epoch === this.heldEpoch;
  }

  private clearHeld(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // Already closed.
      }
      this.fd = null;
    }
    this.heldEpoch = null;
  }
}
