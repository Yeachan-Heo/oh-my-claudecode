/**
 * Repair of a torn last journal line for `omc graph gc`: the line is copied aside and the journal truncated, only
 * while this process owns the run. The rules and the safety notes are in run-gc.ts.
 */
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, readFileSync, writeSync, } from "node:fs";
import { atomicWriteFileSync } from "../../lib/atomic-write.js";
import { directoryOperationsIfSupported } from "./contained-fd.js";
import { takeOwnership, withRunDirectory } from "./run-gc-owner.js";
import { JOURNAL_FILE_NAME, KEPT_JOURNAL_PREFIX, NONBLOCK, splitTornTail, TORN_COPY_PREFIX, } from "./run-gc-read.js";
function writeAll(fd, buffer) {
    let offset = 0;
    while (offset < buffer.length) {
        offset += writeSync(fd, buffer, offset, buffer.length - offset);
    }
}
function stampFor(nowMs) {
    return new Date(nowMs).toISOString().replace(/[:.]/g, "-");
}
// Opens the journal through the open run directory, without following a link. It must be a regular file with no other
// name: a hard link shares its inode with another name, possibly outside the runs root. The repair never changes that
// inode (it publishes a new one), but a journal that has other names is not a private file of the run and is left alone.
function openJournal(operations, flags) {
    const fd = operations.open(JOURNAL_FILE_NAME, flags);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile())
            throw new Error("journal is not a regular file");
        if (stat.nlink !== 1)
            throw new Error("journal has more than one hard link; left unchanged");
        return fd;
    }
    catch (error) {
        closeSync(fd);
        throw error;
    }
}
// Moves the torn last line of one journal to a copy beside it. Complete lines are not touched.
// The copy is written and synced before the journal is shortened, so the tail is never lost. The shortened journal is
// published by the atomic writer (a new private file renamed over the journal, relative to the open run directory, with
// the written file checked to be the one that took the name): the inode that was
// checked is never modified, so a name added to it after the check cannot carry the change to another file.
// The journal is changed only while this process owns the run (the same fence as the removal), so a writer cannot
// append between the last look and the truncation. Every file is opened relative to the open run directory, whose
// identity is the scanned one, so a name that was swapped for a link or for another directory can neither be read nor
// written; the name is checked again before the copy and before the shortened journal is put in place. Returns { repaired, copy }. Throws when
// the run is owned by another process, or the journal is not a private regular file.
export function repairTornTail(runDir, nowMs, expected, interlock = {}) {
    let identity = expected;
    if (identity === undefined) {
        const stat = lstatSync(runDir);
        if (!stat.isDirectory())
            throw new Error("run is no longer a plain directory");
        identity = { dev: stat.dev, ino: stat.ino };
    }
    // Looked at before the lock is taken, so a run with nothing to repair, or with a journal that must not be
    // touched, is left exactly as it was.
    const operationsFor = interlock.operationsFor ?? directoryOperationsIfSupported;
    const torn = withRunDirectory(runDir, identity, operationsFor, ({ operations }) => {
        const probe = openJournal(operations, fsConstants.O_RDONLY | NONBLOCK);
        try {
            return splitTornTail(readFileSync(probe)).tail.length > 0;
        }
        finally {
            closeSync(probe);
        }
    });
    if (!torn)
        return { repaired: false, copy: null };
    const owned = takeOwnership(runDir, "run is held by a live owner; journal left unchanged", identity);
    let outcome;
    try {
        interlock.afterOwnership?.();
        const ownedIdentity = identity;
        outcome = withRunDirectory(runDir, ownedIdentity, operationsFor, (run) => {
            interlock.afterHandle?.();
            return repairOwnedJournal(run, nowMs, interlock);
        }, false);
    }
    catch (error) {
        try {
            owned.fence.releaseSync(owned.epoch);
        }
        catch {
            // The error below is the one to report; a name that was swapped no longer leads to the lock.
        }
        throw error;
    }
    interlock.beforeRelease?.();
    try {
        owned.fence.releaseSync(owned.epoch);
    }
    catch (error) {
        throw new Error(`journal repaired${outcome.copy === null ? "" : ` (copy ${outcome.copy})`}; the lock could not be released: ${error.message}`);
    }
    return outcome;
}
// After a failed publication the name must lead to the journal that was checked, which this process owns. When it does
// not (a foreign file took the name, or nothing is left under it), the second name is put in its place; when that is
// not possible either, the second name stays and the error says so.
function restoreJournal(operations, keptName, before, error) {
    let intact = false;
    try {
        const named = operations.lstat(JOURNAL_FILE_NAME);
        intact = named.dev === before.dev && named.ino === before.ino;
    }
    catch {
        // Nothing is under the name.
    }
    if (intact) {
        try {
            operations.unlink(keptName);
        }
        catch {
            // The second name does no harm.
        }
        return error;
    }
    try {
        operations.rename(keptName, JOURNAL_FILE_NAME);
        operations.sync();
    }
    catch {
        return new Error(`${error.message}; the journal could not be put back and is kept as ${keptName}`);
    }
    return new Error(`${error.message}; the previous journal was put back`);
}
function repairOwnedJournal(run, nowMs, interlock) {
    const { operations } = run;
    const fd = openJournal(operations, fsConstants.O_RDWR);
    try {
        const before = fstatSync(fd);
        const { complete, tail } = splitTornTail(readFileSync(fd));
        if (tail.length === 0)
            return { repaired: false, copy: null };
        const copyName = `${TORN_COPY_PREFIX}${stampFor(nowMs)}`;
        run.assertNamed();
        interlock.beforeCopy?.();
        const copyFd = operations.open(copyName, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        try {
            writeAll(copyFd, tail);
            fsyncSync(copyFd);
        }
        finally {
            closeSync(copyFd);
        }
        // The entry of the copy is durable before the journal is shortened.
        operations.sync();
        interlock.afterCopy?.();
        if (fstatSync(fd).size !== before.size) {
            throw new Error("journal changed during repair; left unchanged, torn copy kept");
        }
        const named = operations.lstat(JOURNAL_FILE_NAME);
        if (named.dev !== before.dev || named.ino !== before.ino)
            throw new Error("journal was replaced during repair; left unchanged, torn copy kept");
        // A second name of the journal that is checked: whatever happens to the name during the publication, the committed
        // history stays reachable, because the writer does not put the previous journal back when the file that took the name
        // is not the one it wrote (a foreign replacement is left alone) and then removes its own backup.
        const keptName = `${KEPT_JOURNAL_PREFIX}${copyName.slice(TORN_COPY_PREFIX.length)}`;
        operations.link(JOURNAL_FILE_NAME, keptName);
        try {
            // Published by the atomic writer: the descriptor stays open through the rename, and the file that was written is
            // checked to be the one that takes the name.
            atomicWriteFileSync(JOURNAL_FILE_NAME, complete, {
                beforeRename: () => {
                    run.assertNamed();
                    interlock.beforeTruncate?.();
                },
            }, operations);
        }
        catch (error) {
            throw restoreJournal(operations, keptName, before, error);
        }
        try {
            operations.unlink(keptName);
        }
        catch {
            // The second name does no harm; the run is repaired.
        }
        operations.sync();
        return { repaired: true, copy: copyName };
    }
    finally {
        closeSync(fd);
    }
}
//# sourceMappingURL=run-gc-repair.js.map