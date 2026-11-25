/**
 * Ownership of a run directory for `omc graph gc`: the single-writer fence the runtime uses, and the one way gc and
 * repair touch the files of a run under ownership (through the open run directory, whose identity is the scanned
 * one). The rules and the safety notes are in run-gc.ts.
 */

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { DirectoryOperations } from "./contained-fd.js";
import { FileOwnershipFence } from "./fence.js";
import {
  NO_OPERATIONS,
  NOFOLLOW,
  relativeTo,
  type FileIdentity,
  type OperationsFor,
  type TreeReader,
} from "./run-gc-read.js";

export function assertIdentity(actual: FileIdentity, expected: FileIdentity | undefined, what: string): void {
  if (expected !== undefined && (actual.dev !== expected.dev || actual.ino !== expected.ino)) {
    throw new Error(`${what} is not the directory that was scanned`);
  }
}

// Takes ownership of one run through the runtime's single-writer fence. A live owner, a resume under way and another
// pass all leave the run busy, and then nothing is changed: the run is refused with `refusal`. With `expected` the
// directory must be the one the scan saw: a run replaced by another directory with the same name is refused before
// any lock is created in it.
export function takeOwnership(
  runDir: string,
  refusal: string,
  expected?: FileIdentity,
): { fence: FileOwnershipFence; epoch: number } {
  // Opened without following a link, so a run directory swapped for a link fails here; the fence checks the identity again.
  let fd: number;
  try {
    fd = openSync(runDir, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") throw new Error("run is no longer a plain directory");
    throw error;
  }
  let identity;
  try {
    identity = fstatSync(fd);
  } finally {
    closeSync(fd);
  }
  if (expected !== undefined && (identity.dev !== expected.dev || identity.ino !== expected.ino)) {
    throw new Error("run directory was replaced after the scan; left unchanged");
  }
  const fence = new FileOwnershipFence(dirname(runDir), basename(runDir), undefined, {
    path: runDir,
    device: identity.dev,
    inode: identity.ino,
  });
  const acquired = fence.acquireSync();
  if (acquired.outcome !== "acquired") throw new Error(refusal);
  return { fence, epoch: acquired.epoch };
}

// What a step that works on a run directory under ownership gets: the open directory, as operations and as a reader of
// its files, and a way to check its name.
export interface AnchoredRun {
  /** Operations relative to the open directory (every open adds O_NOFOLLOW). */
  readonly operations: DirectoryOperations;
  /** The files of the directory, read through `operations`. */
  readonly reader: TreeReader;
  /** Throws unless the name of the run still is the directory that is open (device and inode). */
  assertNamed(): void;
}

// The one way gc and repair touch the files of a run after the scan or under ownership. The directory is opened
// without following a link and must be `expected` (device and inode), so a name that was swapped refuses the step
// before anything is read or written; `action` reads and writes through the open directory (`operations`, `reader`),
// never by name; and with `checkAfter` the name must still be the same directory when the step is over, or the result
// is refused. A step that has changed something on disk checks the name (`assertNamed`) before each change instead,
// and takes `checkAfter` false, because a refusal then could not undo the change. A platform without directory-relative
// operations is refused here, before anything is read: a decision that deletes is not made on reads by name that are
// only checked before and after, because a name swapped and swapped back in between would pass both checks.
export function withRunDirectory<T>(
  runDir: string,
  expected: FileIdentity,
  operationsFor: OperationsFor,
  action: (run: AnchoredRun) => T,
  checkAfter = true,
): T {
  let fd: number;
  try {
    fd = openSync(runDir, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") throw new Error("run is no longer a plain directory");
    throw error;
  }
  try {
    assertIdentity(fstatSync(fd), expected, "the run directory");
    const operations = operationsFor(fd);
    if (operations === null) throw new Error(NO_OPERATIONS);
    const assertNamed = (): void => {
      const named = lstatSync(runDir);
      if (named.dev !== expected.dev || named.ino !== expected.ino) {
        throw new Error("the run directory was replaced while it was in use; left unchanged");
      }
    };
    const result = action({ operations, reader: relativeTo(operations, operationsFor), assertNamed });
    if (checkAfter) assertNamed();
    return result;
  } finally {
    closeSync(fd);
  }
}
