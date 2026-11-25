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
import { judgeRun, leaseOf, measureTree, NOFOLLOW, quarantineIdentityOf, quarantineNameFor, QUARANTINE_PREFIX, STAGING_PREFIX, } from "./run-gc-read.js";
// Removes the directory at `path` and everything below it, never following a symbolic link: a link is unlinked
// itself. With `expected` the directory must be the one with that identity, or nothing is removed. `afterLstat` and
// `beforeFinalRmdir` are test-only interlocks: the first runs between the check of an entry and its use, the second
// right before the top directory is removed. An entry that is already gone (another pass removed it) is not an error.
//
// The parent directory is opened first, without following a link, and the directory is opened and finally removed
// relative to it, so a parent component swapped for a link while the tree is walked cannot redirect any step. Every
// directory is opened without following a link (O_NOFOLLOW), checked to be the one that was just seen, and its entries
// are removed relative to the open directory (`unlink`, and `rmdir` of an emptied subdirectory). The same code serves
// every platform that has directory-relative operations; where there are none nothing is removed. A platform whose
// operations have no `rmdir` (macOS) removes only a tree without subdirectories and refuses any other before anything is
// removed, because the rmdir of an emptied subdirectory by its path would follow an ancestor that was swapped for a link;
// its final rmdir of the top directory is by name, after the parent is checked to be the directory that is held open (a
// swap in the instants between that check and the rmdir is the one step left open there). A directory swapped in at the
// final step is removed only if it is empty, and a link is never followed by rmdir.
export function removeTree(path, interlock = {}, expected) {
    const operationsFor = interlock.operationsFor ?? directoryOperationsIfSupported;
    const parentPath = dirname(path);
    const name = basename(path);
    const parentFd = openSync(parentPath, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NOFOLLOW);
    try {
        const parent = operationsFor(parentFd);
        if (parent === null)
            throw new Error("this platform has no directory-relative file operations; nothing was removed");
        const fd = parent.open(name, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
        try {
            assertIdentity(fstatSync(fd), expected, "the directory to remove");
            removeEntriesOf(fd, path, interlock, operationsFor);
        }
        finally {
            closeSync(fd);
        }
        interlock.beforeFinalRmdir?.();
        if (parent.rmdir !== undefined) {
            ignoreMissing(() => parent.rmdir?.(name));
            return;
        }
        assertIdentity(lstatSync(parentPath), fileIdentity(fstatSync(parentFd)), "the parent of the directory to remove");
        ignoreMissing(() => rmdirSync(path));
    }
    finally {
        closeSync(parentFd);
    }
}
function fileIdentity(stat) {
    return { dev: stat.dev, ino: stat.ino };
}
function ignoreMissing(action) {
    try {
        action();
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
}
function removeEntriesOf(directoryFd, path, interlock, operationsFor) {
    const operations = operationsFor(directoryFd);
    if (operations === null)
        throw new Error("this platform has no directory-relative file operations; nothing was removed");
    const names = operations.readDir();
    // Without a directory-relative rmdir an emptied subdirectory could only be removed by its path, which follows any
    // ancestor that was swapped for a link, so a tree that has a subdirectory is refused before anything in it is removed.
    if (operations.rmdir === undefined) {
        for (const name of names) {
            let stat;
            try {
                stat = operations.lstat(name);
            }
            catch (error) {
                if (error.code === "ENOENT")
                    continue;
                throw error;
            }
            if (stat.isDirectory())
                throw new Error("this platform has no directory-relative rmdir; nothing was removed");
        }
    }
    for (const name of names) {
        let stat;
        try {
            stat = operations.lstat(name);
        }
        catch (error) {
            if (error.code === "ENOENT")
                continue;
            throw error;
        }
        if (!stat.isDirectory()) {
            ignoreMissing(() => operations.unlink(name));
            continue;
        }
        const entry = join(path, name);
        interlock.afterLstat?.(entry);
        let childFd;
        try {
            childFd = operations.open(name, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
        }
        catch (error) {
            if (error.code === "ENOENT")
                continue;
            throw error;
        }
        try {
            const opened = fstatSync(childFd);
            if (opened.dev !== stat.dev || opened.ino !== stat.ino)
                throw new Error("a directory changed while it was removed");
            removeEntriesOf(childFd, entry, interlock, operationsFor);
        }
        finally {
            closeSync(childFd);
        }
        ignoreMissing(() => operations.rmdir?.(name));
    }
}
function putBackUnlessScanned(moves, id, moved, scanned) {
    let identity = null;
    try {
        identity = moves.identityOf(moved);
    }
    catch {
        // Nothing is at the new name; the check below refuses.
    }
    if (identity !== null && identity.dev === scanned.dev && identity.ino === scanned.ino)
        return;
    try {
        moves.rename(moved, id);
    }
    catch {
        throw new Error(`the run directory was replaced while it was moved; the moved directory could not be put back and stays as ${moved}`);
    }
    throw new Error("the run directory was replaced while it was moved; the moved directory was put back");
}
// Moves one run out of the runs namespace while this process owns it, and returns the new path. After the rename
// the run directory name is gone: a later resume of the same run id starts a fresh directory, and nothing can
// reach the moved one by its run id. With `scanned` the run must be the scanned directory and must still be a
// deletable run under ownership; otherwise the lock is released and the run stays as it was.
export function quarantineRun(realRoot, id, nowMs = Date.now(), suffix = randomBytes(4).toString("hex"), scanned) {
    const runDir = join(realRoot, id);
    if (!lstatSync(runDir).isDirectory())
        throw new Error("run is no longer a plain directory");
    if (realpathSync(runDir) !== runDir)
        throw new Error("run directory resolves outside the runs root");
    const operationsFor = scanned?.operationsFor ?? directoryOperationsIfSupported;
    const { fence, epoch } = takeOwnership(runDir, "run is held by a live owner; not removed", scanned?.identity);
    const stagingName = `${STAGING_PREFIX}${id}-${nowMs}-${suffix}`;
    // The identity that the quarantine name will carry: the scanned directory, or the one that is there now.
    const named = lstatSync(runDir);
    const quarantineName = quarantineNameFor(id, nowMs, suffix, scanned?.identity ?? { dev: named.dev, ino: named.ino });
    const quarantine = join(realRoot, quarantineName);
    // The runs root is opened without following a link and must be the directory that the name leads to now; the moves go
    // through that handle. Where the platform has no directory-relative operations the moves are by path (a scanned run
    // never gets here: it was refused above).
    let rootFd = null;
    try {
        rootFd = openSync(realRoot, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NOFOLLOW);
        assertIdentity(fstatSync(rootFd), fileIdentity(lstatSync(realRoot)), "the runs root");
    }
    catch (error) {
        if (rootFd !== null)
            closeSync(rootFd);
        fence.releaseSync(epoch);
        throw error;
    }
    const rootOperations = (scanned?.operationsFor ?? directoryOperationsIfSupported)(rootFd);
    const moves = rootOperations === null
        ? { rename: (from, to) => renameSync(join(realRoot, from), join(realRoot, to)), identityOf: (name) => fileIdentity(lstatSync(join(realRoot, name))) }
        : { rename: (from, to) => rootOperations.rename(from, to), identityOf: (name) => fileIdentity(rootOperations.lstat(name)) };
    try {
        if (scanned !== undefined) {
            scanned.afterOwnership?.();
            // Another process took the lock after the scan, even if it changed nothing: it used the run since.
            if (epoch > scanned.epochFloor + 1)
                throw new Error("run was resumed after the scan; not removed");
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
            if (verdict.decision !== "delete")
                throw new Error(`run changed after the scan (${verdict.reason}); not removed`);
            assertIdentity(lstatSync(runDir), scanned.identity, "the run directory");
            scanned.beforeMove?.();
        }
        moves.rename(id, stagingName);
        scanned?.afterMove?.();
        if (scanned !== undefined)
            putBackUnlessScanned(moves, id, stagingName, scanned.identity);
        try {
            scanned?.beforePromote?.();
            moves.rename(stagingName, quarantineName);
        }
        catch (error) {
            // The name is not usable: the run goes back where it was.
            try {
                moves.rename(stagingName, id);
            }
            catch {
                // It stays under its staging name, which no pass deletes.
            }
            throw error;
        }
    }
    catch (error) {
        // The run stays where it was, so the lock this process took must not stay with it.
        try {
            fence.releaseSync(epoch);
        }
        catch {
            // The error below is the one to report.
        }
        throw error;
    }
    finally {
        closeSync(rootFd);
    }
    // The lock moved with the directory; only the descriptor is left to close.
    fence.closeHeldDescriptor();
    return quarantine;
}
// Removes one candidate: a run is quarantined under exclusive ownership and then deleted; a directory that an
// earlier removal left quarantined is deleted unless the lock inside it names a live process. `scanned` binds the
// removal to the directory and the verdict of the scan.
export function removeRun(realRoot, id, scanned) {
    const runDir = join(realRoot, id);
    if (id.startsWith(QUARANTINE_PREFIX)) {
        if (!lstatSync(runDir).isDirectory())
            throw new Error("run is no longer a plain directory");
        if (realpathSync(runDir) !== runDir)
            throw new Error("run directory resolves outside the runs root");
        if (leaseOf(runDir).held)
            throw new Error("quarantined run is held by a live process; not removed");
        // The name carries the identity of the directory that was checked before it was moved; anything else under this name
        // was never checked and is not deleted.
        const evidence = quarantineIdentityOf(id);
        if (evidence === null)
            throw new Error("quarantined run has no identity evidence in its name; not removed");
        assertIdentity(lstatSync(runDir), evidence, "the quarantined run directory");
        removeTree(runDir, { operationsFor: scanned?.operationsFor }, scanned?.identity ?? evidence);
        return;
    }
    removeTree(quarantineRun(realRoot, id, undefined, undefined, scanned), { operationsFor: scanned?.operationsFor }, scanned?.identity);
}
//# sourceMappingURL=run-gc-remove.js.map