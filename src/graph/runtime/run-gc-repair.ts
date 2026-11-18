/**
 * Repair of a torn last journal line for `omc graph gc`: the line is copied aside and the journal truncated, only
 * while this process owns the run. The rules and the safety notes are in run-gc.ts.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { directoryOperationsIfSupported, type DirectoryOperations } from "./contained-fd.js";
import { takeOwnership, withRunDirectory, type AnchoredRun } from "./run-gc-owner.js";
import {
  JOURNAL_FILE_NAME,
  NONBLOCK,
  splitTornTail,
  TORN_COPY_PREFIX,
  type FileIdentity,
  type OperationsFor,
} from "./run-gc-read.js";

function writeAll(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function stampFor(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[:.]/g, "-");
}

// Opens the journal through the open run directory, without following a link. It must be a regular file with no other
// name: a hard link shares its inode with another name, possibly outside the runs root, and truncating it would
// change that file too.
function openJournal(operations: DirectoryOperations, flags: number): number {
  const fd = operations.open(JOURNAL_FILE_NAME, flags);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("journal is not a regular file");
    if (stat.nlink !== 1) throw new Error("journal has more than one hard link; left unchanged");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

// Test-only interlocks of repairTornTail, each at a point where the name of the run could be swapped.
export interface RepairInterlock {
  /** The lock is held and no file has been opened yet. */
  readonly afterOwnership?: () => void;
  /** The run directory is open and its identity is checked; the journal is not opened yet. */
  readonly afterHandle?: () => void;
  /** The name was checked for the last time before the torn copy is created. */
  readonly beforeCopy?: () => void;
  /** The torn copy is written and synced; the journal is not truncated yet. */
  readonly afterCopy?: () => void;
  /** The name was checked for the last time before the journal is truncated. */
  readonly beforeTruncate?: () => void;
  /** The repair is done; the lock is not released yet. */
  readonly beforeRelease?: () => void;
  /** Test-only: replaces the directory-relative operations of the platform (see OperationsFor). */
  readonly operationsFor?: OperationsFor;
}

// Moves the torn last line of one journal to a copy beside it. Complete lines are not touched.
// The copy is written and synced before the journal is truncated, so the tail is never lost.
// The journal is changed only while this process owns the run (the same fence as the removal), so a writer cannot
// append between the last look and the truncation. Every file is opened relative to the open run directory, whose
// identity is the scanned one, so a name that was swapped for a link or for another directory can neither be read nor
// written; the name is checked again before the copy and before the truncation. Returns { repaired, copy }. Throws when
// the run is owned by another process, or the journal is not a private regular file.
export function repairTornTail(
  runDir: string,
  nowMs: number,
  expected?: FileIdentity,
  interlock: RepairInterlock = {},
): { repaired: boolean; copy: string | null } {
  let identity = expected;
  if (identity === undefined) {
    const stat = lstatSync(runDir);
    if (!stat.isDirectory()) throw new Error("run is no longer a plain directory");
    identity = { dev: stat.dev, ino: stat.ino };
  }
  // Looked at before the lock is taken, so a run with nothing to repair, or with a journal that must not be
  // touched, is left exactly as it was.
  const operationsFor = interlock.operationsFor ?? directoryOperationsIfSupported;
  const torn = withRunDirectory(runDir, identity, operationsFor, ({ operations }) => {
    const probe = openJournal(operations, fsConstants.O_RDONLY | NONBLOCK);
    try {
      return splitTornTail(readFileSync(probe)).tail.length > 0;
    } finally {
      closeSync(probe);
    }
  });
  if (!torn) return { repaired: false, copy: null };
  const owned = takeOwnership(runDir, "run is held by a live owner; journal left unchanged", identity);
  let outcome: { repaired: boolean; copy: string | null };
  try {
    interlock.afterOwnership?.();
    const ownedIdentity = identity;
    outcome = withRunDirectory(
      runDir,
      ownedIdentity,
      operationsFor,
      (run) => {
        interlock.afterHandle?.();
        return repairOwnedJournal(run, nowMs, interlock);
      },
      false,
    );
  } catch (error) {
    try {
      owned.fence.releaseSync(owned.epoch);
    } catch {
      // The error below is the one to report; a name that was swapped no longer leads to the lock.
    }
    throw error;
  }
  interlock.beforeRelease?.();
  try {
    owned.fence.releaseSync(owned.epoch);
  } catch (error) {
    throw new Error(`journal repaired${outcome.copy === null ? "" : ` (copy ${outcome.copy})`}; the lock could not be released: ${(error as Error).message}`);
  }
  return outcome;
}

function repairOwnedJournal(
  run: AnchoredRun,
  nowMs: number,
  interlock: RepairInterlock,
): { repaired: boolean; copy: string | null } {
  const { operations } = run;
  const fd = openJournal(operations, fsConstants.O_RDWR);
  try {
    const before = fstatSync(fd);
    const { complete, tail } = splitTornTail(readFileSync(fd));
    if (tail.length === 0) return { repaired: false, copy: null };
    const copyName = `${TORN_COPY_PREFIX}${stampFor(nowMs)}`;
    run.assertNamed();
    interlock.beforeCopy?.();
    const copyFd = operations.open(copyName, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try {
      writeAll(copyFd, tail);
      fsyncSync(copyFd);
    } finally {
      closeSync(copyFd);
    }
    // The entry of the copy is durable before the journal is shortened.
    operations.sync();
    interlock.afterCopy?.();
    if (fstatSync(fd).size !== before.size) {
      throw new Error("journal changed during repair; left unchanged, torn copy kept");
    }
    run.assertNamed();
    interlock.beforeTruncate?.();
    ftruncateSync(fd, complete.length);
    fsyncSync(fd);
    return { repaired: true, copy: copyName };
  } finally {
    closeSync(fd);
  }
}
