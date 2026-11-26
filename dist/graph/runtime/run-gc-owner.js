/**
 * Ownership of a run directory for `omc graph gc`: the single-writer fence the runtime uses, and the one way gc and
 * repair touch the files of a run under ownership (through the open run directory, whose identity is the scanned
 * one). The rules and the safety notes are in run-gc.ts.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync } from "node:fs";
import { basename, dirname } from "node:path";
import { FileOwnershipFence } from "./fence.js";
import { NO_OPERATIONS, NOFOLLOW, relativeTo, } from "./run-gc-read.js";
export function assertIdentity(actual, expected, what) {
    if (expected !== undefined && (actual.dev !== expected.dev || actual.ino !== expected.ino)) {
        throw new Error(`${what} is not the directory that was scanned`);
    }
}
// Takes ownership of one run through the runtime's single-writer fence. A live owner, a resume under way and another
// pass all leave the run busy, and then nothing is changed: the run is refused with `refusal`. With `expected` the
// directory must be the one the scan saw: a run replaced by another directory with the same name is refused before
// any lock is created in it.
export function takeOwnership(runDir, refusal, expected) {
    // Opened without following a link, so a run directory swapped for a link fails here; the fence checks the identity again.
    let fd;
    try {
        fd = openSync(runDir, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NOFOLLOW);
    }
    catch (error) {
        const code = error.code;
        if (code === "ELOOP" || code === "ENOTDIR")
            throw new Error("run is no longer a plain directory");
        throw error;
    }
    let identity;
    try {
        identity = fstatSync(fd);
    }
    finally {
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
    if (acquired.outcome !== "acquired")
        throw new Error(refusal);
    return { fence, epoch: acquired.epoch };
}
// The one way gc and repair touch the files of a run after the scan or under ownership. The directory is opened
// without following a link and must be `expected` (device and inode), so a name that was swapped refuses the step
// before anything is read or written; `action` reads and writes through the open directory (`operations`, `reader`),
// never by name; and with `checkAfter` the name must still be the same directory when the step is over, or the result
// is refused. A step that has changed something on disk checks the name (`assertNamed`) before each change instead,
// and takes `checkAfter` false, because a refusal then could not undo the change. A platform without directory-relative
// operations is refused here, before anything is read: a decision that deletes is not made on reads by name that are
// only checked before and after, because a name swapped and swapped back in between would pass both checks.
export function withRunDirectory(runDir, expected, operationsFor, action, checkAfter = true) {
    let fd;
    try {
        fd = openSync(runDir, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NOFOLLOW);
    }
    catch (error) {
        const code = error.code;
        if (code === "ELOOP" || code === "ENOTDIR")
            throw new Error("run is no longer a plain directory");
        throw error;
    }
    try {
        assertIdentity(fstatSync(fd), expected, "the run directory");
        const operations = operationsFor(fd);
        if (operations === null)
            throw new Error(NO_OPERATIONS);
        const assertNamed = () => {
            const named = lstatSync(runDir);
            if (named.dev !== expected.dev || named.ino !== expected.ino) {
                throw new Error("the run directory was replaced while it was in use; left unchanged");
            }
        };
        const result = action({ operations, reader: relativeTo(operations, operationsFor), assertNamed });
        if (checkAfter)
            assertNamed();
        return result;
    }
    finally {
        closeSync(fd);
    }
}
//# sourceMappingURL=run-gc-owner.js.map