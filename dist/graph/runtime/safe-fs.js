import { randomBytes } from "crypto";
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, openSync, readFileSync, writeSync, } from "fs";
import { isAbsolute, join, normalize, win32 } from "path";
import { directoryOperations, containedFdPath, containedFsPlatformSupported } from "./contained-fd.js";
import { openOrCreateDirectoryAt, openExistingDirectoryAt } from "./run-dir.js";
const NO_FOLLOW = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
const UNSAFE_CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
/** Fail closed before acquiring any run-scoped locks on unsupported platforms. */
export function assertContainedFsSupported(platform = process.platform) {
    if (!containedFsPlatformSupported(platform)) {
        throw new Error(`contained directory-FD traversal is unavailable on ${platform}; refusing pathname fallback`);
    }
}
/**
 * Validate the untrusted final component before it reaches any path API.
 * Contained artifacts are deliberately a single portable basename: allowing
 * either platform separator would make the contract depend on the host that
 * happens to process the descriptor, and Windows also treats `:` as an ADS
 * separator. Require canonical NFC so the same artifact name has one portable
 * byte-level spelling across Linux, macOS, and Windows; reject normalization-
 * changing values rather than attempting to canonicalize untrusted input.
 */
export function assertSafeContainedFileName(fileName, platform = process.platform) {
    if (typeof fileName !== "string" ||
        fileName.length === 0 ||
        fileName === "." ||
        fileName === ".." ||
        fileName.includes("/") ||
        fileName.includes("\\") ||
        fileName.includes("\0") ||
        UNSAFE_CONTROL.test(fileName) ||
        fileName.normalize("NFC") !== fileName ||
        isAbsolute(fileName) ||
        win32.isAbsolute(fileName) ||
        normalize(fileName) !== fileName ||
        win32.normalize(fileName) !== fileName ||
        (platform === "win32" && fileName.includes(":")) ||
        (platform === "win32" && WINDOWS_DEVICE_NAME.test(fileName)) ||
        (fileName.endsWith(".") || fileName.endsWith(" "))) {
        throw new RangeError(`invalid contained artifact fileName: ${JSON.stringify(fileName)}`);
    }
}
/** Open a runtime artifact without following a symlink at the final path. */
export function openNoFollow(filePath, flags, mode = 0o600) {
    if (process.platform === "win32") {
        throw new Error("atomic no-follow file opens are unavailable on win32; refusing pathname fallback");
    }
    return openSync(filePath, flags | NO_FOLLOW, mode);
}
/** Reject special files and hardlinks that escape the run-directory inode. */
export function assertPrivateRegularFile(fileDescriptor, filePath) {
    const stats = fstatSync(fileDescriptor);
    if (!stats.isFile() || stats.nlink !== 1) {
        throw new Error(`contained artifact is not a private regular file: ${filePath}`);
    }
}
/** Read a runtime artifact without following a symlink at the final path. */
export function readFileNoFollow(filePath) {
    const fd = openNoFollow(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
    try {
        assertPrivateRegularFile(fd, filePath);
        return readFileSync(fd, "utf8");
    }
    finally {
        closeSync(fd);
    }
}
/**
 * Resolve a path for an already-open run directory without changing the
 * process-wide platform state. Linux exposes directory FDs as traversable
 * procfs directories. Platforms without that primitive fail closed instead of
 * falling back to a raceable pathname.
 */
export function containedPathForPlatform(directoryFd, runDirPath, fileName, platform = process.platform) {
    assertSafeContainedFileName(fileName, platform);
    assertContainedFsSupported(platform);
    return join(containedFdPath(directoryFd, platform), fileName);
}
/**
 * Run a synchronous operation against a directory FD on Linux. If the
 * directory is renamed or its parent path is replaced while the operation is
 * in flight, the FD still refers to the originally validated directory.
 * Platforms without a traversable directory FD fail closed.
 */
export function withContainedPath(runDir, fileName, operation) {
    return withContainedPathForPlatform(runDir, fileName, operation, process.platform);
}
/** Legacy Linux-only path callback; use withContainedOperations for portable I/O. */
export function withContainedDirectory(runDir, operation, platform = process.platform) {
    assertContainedFsSupported(platform);
    const directoryFd = openNoFollow(runDir.path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    try {
        const stats = fstatSync(directoryFd);
        if (stats.dev !== runDir.device || stats.ino !== runDir.inode) {
            throw new Error("run directory identity changed");
        }
        return operation(containedFdPath(directoryFd, platform));
    }
    finally {
        closeSync(directoryFd);
    }
}
export function withContainedPathForPlatform(runDir, fileName, operation, platform) {
    assertSafeContainedFileName(fileName, platform);
    assertContainedFsSupported(platform);
    const directoryFd = openNoFollow(runDir.path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    try {
        const stats = fstatSync(directoryFd);
        if (stats.dev !== runDir.device || stats.ino !== runDir.inode) {
            throw new Error("run directory identity changed");
        }
        return operation(containedPathForPlatform(directoryFd, runDir.path, fileName, platform));
    }
    finally {
        closeSync(directoryFd);
    }
}
/** Read a named artifact through a validated run-directory handle. */
export function readContainedFileNoFollow(runDir, fileName) {
    return withContainedOperations(runDir, (operations) => readOperationFileNoFollow(operations, fileName));
}
/**
 * Bind synchronous operations to one identity-checked directory descriptor.
 * The callback must not return a Promise. Retained operations fail closed after
 * callback return, before the OS can reuse the closed descriptor number.
 */
export function withContainedOperations(runDir, operation) {
    assertContainedFsSupported();
    const fd = openNoFollow(runDir.path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    let active = true;
    const checkActive = () => {
        if (!active)
            throw new Error("contained operations used outside synchronous callback");
    };
    try {
        const stats = fstatSync(fd);
        if (stats.dev !== runDir.device || stats.ino !== runDir.inode)
            throw new Error("run directory identity changed");
        const operations = directoryOperations(fd);
        const check = (name) => { checkActive(); assertSafeContainedFileName(name); return name; };
        return operation({ ...operations,
            open: (name, flags, mode) => operations.open(check(name), flags, mode),
            mkdir: (name, mode) => operations.mkdir(check(name), mode),
            lstat: (name) => operations.lstat(check(name)),
            rename: (source, destination) => operations.rename(check(source), check(destination)),
            unlink: (name) => operations.unlink(check(name)),
            link: (source, destination) => operations.link(check(source), check(destination)),
            readDir: () => { checkActive(); return operations.readDir(); },
            realpath: () => { checkActive(); return operations.realpath(); },
            sync: () => { checkActive(); operations.sync(); },
        });
    }
    finally {
        active = false;
        closeSync(fd);
    }
}
export function readOperationFileNoFollow(operations, name) {
    const fd = operations.open(name, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
    try {
        assertPrivateRegularFile(fd, name);
        return readFileSync(fd, "utf8");
    }
    finally {
        closeSync(fd);
    }
}
/**
 * Publish one contained artifact atomically through directory-relative
 * operations only: the temp file is created, written, and fsynced through the
 * descriptor, then renamed into place at the same descriptor. No pathname is
 * ever re-resolved between validation and use, so a component swapped for a
 * symlink mid-flight cannot redirect the artifact out of the directory.
 */
export function writeOperationFileAtomically(operations, name, contents) {
    assertSafeContainedFileName(name);
    const temporary = `${name}.tmp.${randomBytes(6).toString("hex")}`;
    const fd = operations.open(temporary, fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NONBLOCK ?? 0), 0o600);
    try {
        assertPrivateRegularFile(fd, temporary);
        writeSync(fd, contents);
        fsyncSync(fd);
    }
    catch (error) {
        closeSync(fd);
        try {
            operations.unlink(temporary);
        }
        catch { /* best-effort temp cleanup */ }
        throw error;
    }
    closeSync(fd);
    try {
        operations.rename(temporary, name);
    }
    catch (error) {
        try {
            operations.unlink(temporary);
        }
        catch { /* best-effort temp cleanup */ }
        throw error;
    }
    operations.sync();
}
/**
 * Bind synchronous operations to a directory nested below a validated run
 * directory. Every component is opened O_NOFOLLOW from its parent descriptor
 * (and created at that descriptor when requested), so swapping any nested
 * component for a symlink between validation and use fails closed rather than
 * relocating artifacts outside the contained run directory.
 *
 * Returns null when `create` is false and a component does not exist.
 */
export function withContainedSubdirectoryOperations(runDir, components, operation, options = {}) {
    assertContainedFsSupported();
    if (components.length === 0) {
        throw new RangeError("contained subdirectory requires at least one component");
    }
    for (const component of components)
        assertSafeContainedFileName(component);
    const runDirFd = openNoFollow(runDir.path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    let directoryFd = null;
    let active = true;
    const checkActive = () => {
        if (!active)
            throw new Error("contained operations used outside synchronous callback");
    };
    try {
        const stats = fstatSync(runDirFd);
        if (stats.dev !== runDir.device || stats.ino !== runDir.inode) {
            throw new Error("run directory identity changed");
        }
        let parentFd = runDirFd;
        for (const component of components) {
            let nextFd;
            if (options.create === true) {
                nextFd = openOrCreateDirectoryAt(parentFd, component, "approvals directory");
            }
            else {
                const opened = openExistingDirectoryAt(parentFd, component, "approvals directory");
                if (opened === null)
                    return null;
                nextFd = opened;
            }
            if (parentFd !== runDirFd)
                closeSync(parentFd);
            parentFd = nextFd;
            directoryFd = nextFd;
        }
        return operation(guardedOperations(directoryFd, checkActive));
    }
    finally {
        active = false;
        if (directoryFd !== null)
            closeSync(directoryFd);
        closeSync(runDirFd);
    }
}
/**
 * Wrap raw descriptor operations with the same name validation and
 * post-callback fail-closed guard withContainedOperations applies.
 */
function guardedOperations(fd, checkActive) {
    const operations = directoryOperations(fd);
    const check = (name) => {
        checkActive();
        assertSafeContainedFileName(name);
        return name;
    };
    return {
        ...operations,
        open: (name, flags, mode) => operations.open(check(name), flags, mode),
        mkdir: (name, mode) => operations.mkdir(check(name), mode),
        lstat: (name) => operations.lstat(check(name)),
        rename: (source, destination) => operations.rename(check(source), check(destination)),
        unlink: (name) => operations.unlink(check(name)),
        link: (source, destination) => operations.link(check(source), check(destination)),
        readDir: () => { checkActive(); return operations.readDir(); },
        realpath: () => { checkActive(); return operations.realpath(); },
        sync: () => { checkActive(); operations.sync(); },
    };
}
//# sourceMappingURL=safe-fs.js.map