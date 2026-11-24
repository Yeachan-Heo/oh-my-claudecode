/**
 * Removal of a run for `omc graph gc`: ownership first, a second decision under the lock, an atomic move out of the
 * runs namespace, then a deletion of the moved tree that never follows a link. The rules and the safety notes are in
 * run-gc.ts.
 */

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, realpathSync, renameSync, rmdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { directoryOperationsIfSupported } from "./contained-fd.js";
import { assertIdentity, takeOwnership, withRunDirectory } from "./run-gc-owner.js";
import {
  judgeRun,
  leaseOf,
  measureTree,
  NOFOLLOW,
  KEPT_PREFIX,
  QUARANTINE_PREFIX,
  type FileIdentity,
  type OperationsFor,
} from "./run-gc-read.js";

// What a removal needs from the scan to re-check a run under ownership: the scanned directory, the retention cutoff and
// the highest writer epoch the run had seen. Taking the lock gives the next epoch, so a higher one means that another
// process held the lock after the scan, even one that changed nothing.
export interface ScannedRun {
  readonly identity: FileIdentity;
  readonly cutoffMs: number;
  readonly epochFloor: number;
  /** Test-only interlocks: once the lock is held, and once the directory is open, each before the run is decided again. */
  readonly afterOwnership?: () => void;
  readonly afterHandle?: () => void;
  /** Test-only interlock: the decision reads under the lock are done; the name is not checked yet. */
  readonly afterReads?: () => void;
  /** Test-only interlock: after the name was checked for the last time, right before the directory is moved. */
  readonly beforeMove?: () => void;
  /** Test-only interlock: right after the directory was moved, before the moved directory is checked. */
  readonly afterMove?: () => void;
  /** Test-only: replaces the directory-relative operations of the platform (see OperationsFor). */
  readonly operationsFor?: OperationsFor;
}

// Removes the directory at `path` and everything below it, never following a symbolic link: a link is unlinked
// itself. With `expected` the directory must be the one with that identity, or nothing is removed. `afterLstat` is a
// test-only interlock that runs between the check of an entry and its use. An entry that is already gone (another
// pass removed it) is not an error.
//
// Every directory is opened without following a link (O_NOFOLLOW), checked to be the one that was just seen, and its
// entries are removed relative to the open directory (`unlink`, and `rmdir` of an emptied subdirectory), so a directory
// swapped for a link while the tree is walked cannot redirect the removal. The same code serves every platform that has
// directory-relative operations; where there are none nothing is removed. One step is by name, because the operations
// have no form that is relative to a directory: the final rmdir of the top directory. A platform whose operations have no
// `rmdir` (macOS) removes only a tree without subdirectories and refuses any other before anything is removed, because the
// rmdir of an emptied subdirectory by its path would follow an ancestor that was swapped for a link. A directory swapped in
// at the final step is removed only if it is empty, and a link is never followed by rmdir.
export function removeTree(
  path: string,
  interlock: { afterLstat?: (path: string) => void; operationsFor?: OperationsFor } = {},
  expected?: FileIdentity,
): void {
  const operationsFor = interlock.operationsFor ?? directoryOperationsIfSupported;
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NOFOLLOW);
  try {
    assertIdentity(fstatSync(fd), expected, "the directory to remove");
    removeEntriesOf(fd, path, interlock, operationsFor);
  } finally {
    closeSync(fd);
  }
  ignoreMissing(() => rmdirSync(path));
}

function ignoreMissing(action: () => void): void {
  try {
    action();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function removeEntriesOf(
  directoryFd: number,
  path: string,
  interlock: { afterLstat?: (path: string) => void },
  operationsFor: OperationsFor,
): void {
  const operations = operationsFor(directoryFd);
  if (operations === null) throw new Error("this platform has no directory-relative file operations; nothing was removed");
  const names = operations.readDir();
  // Without a directory-relative rmdir an emptied subdirectory could only be removed by its path, which follows any
  // ancestor that was swapped for a link, so a tree that has a subdirectory is refused before anything in it is removed.
  if (operations.rmdir === undefined) {
    for (const name of names) {
      let stat;
      try {
        stat = operations.lstat(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (stat.isDirectory()) throw new Error("this platform has no directory-relative rmdir; nothing was removed");
    }
  }
  for (const name of names) {
    let stat;
    try {
      stat = operations.lstat(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isDirectory()) {
      ignoreMissing(() => operations.unlink(name));
      continue;
    }
    const entry = join(path, name);
    interlock.afterLstat?.(entry);
    let childFd: number;
    try {
      childFd = operations.open(name, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const opened = fstatSync(childFd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("a directory changed while it was removed");
      removeEntriesOf(childFd, entry, interlock, operationsFor);
    } finally {
      closeSync(childFd);
    }
    ignoreMissing(() => operations.rmdir?.(name));
  }
}

// A directory cannot be renamed through its open descriptor, so the move is by name: the name is checked right before
// it, and the moved directory is checked right after. When the name was swapped in between, the directory that was
// moved is not the scanned one: it is put back, and nothing is deleted. When the name is taken again and it cannot be
// put back, it is renamed out of the quarantine namespace, because it was never validated and a later pass deletes what
// is left under a quarantine name.
function putBackUnlessScanned(runDir: string, moved: string, scanned: FileIdentity): void {
  let identity: FileIdentity | null = null;
  try {
    const stat = lstatSync(moved);
    identity = { dev: stat.dev, ino: stat.ino };
  } catch {
    // Nothing is at the new name; the check below refuses.
  }
  if (identity !== null && identity.dev === scanned.dev && identity.ino === scanned.ino) return;
  try {
    renameSync(moved, runDir);
  } catch {
    const kept = join(dirname(moved), `${KEPT_PREFIX}${basename(moved).slice(QUARANTINE_PREFIX.length)}`);
    try {
      renameSync(moved, kept);
    } catch {
      throw new Error("the run directory was replaced while it was moved; the moved directory could not be put back and stays under its quarantine name");
    }
    throw new Error(`the run directory was replaced while it was moved; the moved directory could not be put back and was kept as ${basename(kept)}`);
  }
  throw new Error("the run directory was replaced while it was moved; the moved directory was put back");
}

// Moves one run out of the runs namespace while this process owns it, and returns the new path. After the rename
// the run directory name is gone: a later resume of the same run id starts a fresh directory, and nothing can
// reach the moved one by its run id. With `scanned` the run must be the scanned directory and must still be a
// deletable run under ownership; otherwise the lock is released and the run stays as it was.
export function quarantineRun(
  realRoot: string,
  id: string,
  nowMs: number = Date.now(),
  suffix: string = randomBytes(4).toString("hex"),
  scanned?: ScannedRun,
): string {
  const runDir = join(realRoot, id);
  if (!lstatSync(runDir).isDirectory()) throw new Error("run is no longer a plain directory");
  if (realpathSync(runDir) !== runDir) throw new Error("run directory resolves outside the runs root");
  const operationsFor = scanned?.operationsFor ?? directoryOperationsIfSupported;
  const { fence, epoch } = takeOwnership(runDir, "run is held by a live owner; not removed", scanned?.identity);
  const quarantine = join(realRoot, `${QUARANTINE_PREFIX}${id}-${nowMs}-${suffix}`);
  try {
    if (scanned !== undefined) {
      scanned.afterOwnership?.();
      // Another process took the lock after the scan, even if it changed nothing: it used the run since.
      if (epoch > scanned.epochFloor + 1) throw new Error("run was resumed after the scan; not removed");
      // The verdict of the scan is only a hint: the run may have been resumed and finished since. It is decided
      // again, now that no other process can change it. Both the age and the state are read through the open
      // directory, on every platform that has directory-relative operations, so the name cannot be swapped under the
      // reads, and the name must still be the scanned directory at the moment of the move.
      const verdict = withRunDirectory(runDir, scanned.identity, operationsFor, ({ reader }) => {
        scanned.afterHandle?.();
        const judged = judgeRun(reader, id, measureTree(reader, 0, true).newestMs, scanned.cutoffMs, epoch);
        scanned.afterReads?.();
        return judged;
      });
      if (verdict.decision !== "delete") throw new Error(`run changed after the scan (${verdict.reason}); not removed`);
      assertIdentity(lstatSync(runDir), scanned.identity, "the run directory");
      scanned.beforeMove?.();
    }
    renameSync(runDir, quarantine);
    scanned?.afterMove?.();
    if (scanned !== undefined) putBackUnlessScanned(runDir, quarantine, scanned.identity);
  } catch (error) {
    // The run stays where it was, so the lock this process took must not stay with it.
    try {
      fence.releaseSync(epoch);
    } catch {
      // The error below is the one to report.
    }
    throw error;
  }
  // The lock moved with the directory; only the descriptor is left to close.
  fence.closeHeldDescriptor();
  return quarantine;
}

// Removes one candidate: a run is quarantined under exclusive ownership and then deleted; a directory that an
// earlier removal left quarantined is deleted unless the lock inside it names a live process. `scanned` binds the
// removal to the directory and the verdict of the scan.
export function removeRun(realRoot: string, id: string, scanned?: ScannedRun): void {
  const runDir = join(realRoot, id);
  if (id.startsWith(QUARANTINE_PREFIX)) {
    if (!lstatSync(runDir).isDirectory()) throw new Error("run is no longer a plain directory");
    if (realpathSync(runDir) !== runDir) throw new Error("run directory resolves outside the runs root");
    if (leaseOf(runDir).held) throw new Error("quarantined run is held by a live process; not removed");
    removeTree(runDir, { operationsFor: scanned?.operationsFor }, scanned?.identity);
    return;
  }
  removeTree(quarantineRun(realRoot, id, undefined, undefined, scanned), { operationsFor: scanned?.operationsFor }, scanned?.identity);
}
