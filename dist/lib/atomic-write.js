/**
 * Atomic, durable file writes for oh-my-claudecode.
 * Self-contained module with no external dependencies.
 */
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as crypto from "crypto";
/**
 * Create directory recursively (inline implementation).
 * Ensures parent directories exist before creating the target directory.
 *
 * @param dir Directory path to create
 */
export function ensureDirSync(dir) {
    if (fsSync.existsSync(dir)) {
        return;
    }
    try {
        fsSync.mkdirSync(dir, { recursive: true });
    }
    catch (err) {
        // If directory was created by another process between exists check and mkdir,
        // that's fine - verify it exists now
        if (err.code === "EEXIST") {
            return;
        }
        throw err;
    }
}
function writeAllSync(fd, content, label) {
    const bytes = Buffer.from(content, "utf-8");
    let offset = 0;
    while (offset < bytes.length) {
        const written = fsSync.writeSync(fd, bytes, offset, bytes.length - offset);
        if (!Number.isInteger(written) || written <= 0) {
            throw new Error(`${label} made no progress`);
        }
        offset += written;
    }
    if (fsSync.fstatSync(fd).size !== bytes.length) {
        throw new Error(`${label} size verification failed`);
    }
}
/**
 * Verify the unpublished generation before it can be renamed into place.
 * The descriptor check prevents writes through a special file or a hardlink;
 * comparing the pathname identity with the open descriptor also rejects an
 * attacker that replaced the temporary pathname after creation.
 */
function verifyPrivateTempFile(fd, tempPath, label, operations) {
    const fdStats = fsSync.fstatSync(fd);
    let pathStats;
    try {
        pathStats = (operations?.lstat ?? fsSync.lstatSync)(tempPath);
    }
    catch {
        throw new Error(`${label} temporary file was replaced before rename`);
    }
    const isWindows = process.platform === "win32";
    const isPrivateRegularSingleLink = (stats) => stats.isFile() &&
        (isWindows ? stats.nlink <= 1 : stats.nlink === 1) &&
        (isWindows || (stats.mode & 0o777) === 0o600);
    if (!isPrivateRegularSingleLink(fdStats) ||
        !isPrivateRegularSingleLink(pathStats)) {
        throw new Error(`${label} temporary file must be a private regular single-link file`);
    }
    if (fdStats.dev !== pathStats.dev || fdStats.ino !== pathStats.ino) {
        throw new Error(`${label} temporary file was replaced before rename`);
    }
}
/** Verify that publication installed the exact inode we opened and wrote. */
function verifyPublishedFile(fd, filePath, label, operations) {
    const fdStats = fsSync.fstatSync(fd);
    let pathStats;
    try {
        pathStats = (operations?.lstat ?? fsSync.lstatSync)(filePath);
    }
    catch {
        throw new Error(`${label} target was replaced at publication`);
    }
    if (!pathStats.isFile() ||
        fdStats.dev !== pathStats.dev ||
        fdStats.ino !== pathStats.ino) {
        throw new Error(`${label} target was replaced at publication`);
    }
}
/** Keep a hard-link to the prior target so failed publication can roll back. */
function preservePriorTarget(filePath, operations) {
    const backupPath = `${filePath}.rollback.${crypto.randomUUID()}`;
    try {
        const stats = (operations?.lstat ?? fsSync.lstatSync)(filePath);
        const isWindows = process.platform === "win32";
        if (!stats.isFile() ||
            (isWindows ? stats.nlink > 1 : stats.nlink !== 1)) {
            return null;
        }
        (operations?.link ?? fsSync.linkSync)(filePath, backupPath);
        return backupPath;
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            try {
                (operations?.unlink ?? fsSync.unlinkSync)(backupPath);
            }
            catch {
                // Best effort cleanup of an uncreated backup.
            }
        }
        return null;
    }
}
function currentFileIdentity(filePath, operations) {
    try {
        const stats = (operations?.lstat ?? fsSync.lstatSync)(filePath);
        return { dev: stats.dev, ino: stats.ino };
    }
    catch {
        return null;
    }
}
function descriptorIdentity(fd) {
    try {
        const stats = fsSync.fstatSync(fd);
        return { dev: stats.dev, ino: stats.ino };
    }
    catch {
        return null;
    }
}
function rollbackPriorTarget(filePath, backupPath, expectedIdentity, operations) {
    // Without a positively identified published inode, the target may be a
    // concurrent foreign replacement. Leave it untouched and fail closed.
    if (expectedIdentity === null)
        return;
    const current = currentFileIdentity(filePath, operations);
    if (current === null)
        return;
    if (expectedIdentity !== null &&
        (current.dev !== expectedIdentity.dev || current.ino !== expectedIdentity.ino)) {
        return;
    }
    try {
        if (backupPath === null) {
            (operations?.unlink ?? fsSync.unlinkSync)(filePath);
        }
        else {
            (operations?.rename ?? fsSync.renameSync)(backupPath, filePath);
        }
    }
    catch {
        // The caller still fails closed; retain whichever durable target remains.
    }
}
function removeBackup(backupPath, operations) {
    if (backupPath === null)
        return;
    try {
        (operations?.unlink ?? fsSync.unlinkSync)(backupPath);
    }
    catch {
        // Best effort cleanup after a successful publication.
    }
}
/**
 * Write JSON data atomically to a file.
 * Uses temp file + atomic rename pattern to ensure durability.
 *
 * @param filePath Target file path
 * @param data Data to serialize as JSON
 * @throws Error if JSON serialization fails or write operation fails
 */
export async function atomicWriteJson(filePath, data, hooks) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const tempPath = path.join(dir, `.${base}.tmp.${crypto.randomUUID()}`);
    let success = false;
    let backupPath = null;
    let fd = null;
    try {
        // Ensure parent directory exists
        ensureDirSync(dir);
        // Serialize data to JSON
        const jsonContent = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
        // Write to temp file with exclusive creation (wx = O_CREAT | O_EXCL | O_WRONLY)
        fd = await fs.open(tempPath, "wx", 0o600);
        try {
            let offset = 0;
            while (offset < jsonContent.length) {
                const { bytesWritten } = await fd.write(jsonContent, offset, jsonContent.length - offset, offset);
                if (bytesWritten === 0) {
                    throw new Error("Failed to write complete JSON payload");
                }
                offset += bytesWritten;
            }
            // Sync file data to disk before rename
            await fd.sync();
            verifyPrivateTempFile(fd.fd, tempPath, "atomic JSON write");
            backupPath = preservePriorTarget(filePath);
            hooks?.beforeRename?.();
            // Keep the opened descriptor live through rename so publication can be
            // checked against the inode that was actually written.
            await fs.rename(tempPath, filePath);
            let publishedIdentity = null;
            try {
                verifyPublishedFile(fd.fd, filePath, "atomic JSON write");
                publishedIdentity = descriptorIdentity(fd.fd);
                hooks?.afterRename?.();
                verifyPublishedFile(fd.fd, filePath, "atomic JSON write");
            }
            catch (error) {
                rollbackPriorTarget(filePath, backupPath, publishedIdentity);
                throw error;
            }
        }
        finally {
            await fd.close();
            fd = null;
        }
        success = true;
        removeBackup(backupPath);
        // Best-effort directory fsync to ensure rename is durable
        try {
            const dirFd = await fs.open(dir, "r");
            try {
                await dirFd.sync();
            }
            finally {
                await dirFd.close();
            }
        }
        catch {
            // Some platforms don't support directory fsync - that's okay
        }
    }
    finally {
        // Clean up temp file on error
        if (!success) {
            await fs.unlink(tempPath).catch(() => { });
            removeBackup(backupPath);
        }
    }
}
/**
 * Write text content atomically to a file (synchronous version).
 * Uses temp file + atomic rename pattern to ensure durability.
 *
 * @param filePath Target file path
 * @param content Text content to write
 * @throws Error if write operation fails
 */
export function atomicWriteSync(filePath, content, hooks) {
    atomicWriteFileSync(filePath, content, hooks);
}
/**
 * Read and parse JSON file with error handling.
 * Returns null if file doesn't exist or on parse errors.
 *
 * @param filePath Path to JSON file
 * @returns Parsed JSON data or null on error
 */
/**
 * Write string data atomically to a file (synchronous version).
 * Uses temp file + atomic rename pattern with fsync for durability.
 *
 * @param filePath Target file path
 * @param content String content to write
 * @throws Error if write operation fails
 */
export function atomicWriteFileSync(filePath, content, hooks, operations) {
    if (operations && (!filePath || path.basename(filePath) !== filePath || filePath === "." || filePath === ".."))
        throw new RangeError("contained atomic write requires a basename");
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const tempPath = path.join(dir, `.${base}.tmp.${crypto.randomUUID()}`);
    let fd = null;
    let success = false;
    let backupPath = null;
    try {
        // Ensure parent directory exists
        if (!operations)
            ensureDirSync(dir);
        // Open temp file with exclusive creation (O_CREAT | O_EXCL | O_WRONLY)
        fd = operations
            ? operations.open(tempPath, fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_WRONLY, 0o600)
            : fsSync.openSync(tempPath, "wx", 0o600);
        // Write content
        writeAllSync(fd, content, "atomic write");
        // Sync file data to disk before rename
        fsSync.fsyncSync(fd);
        verifyPrivateTempFile(fd, tempPath, "atomic write", operations);
        backupPath = preservePriorTarget(filePath, operations);
        hooks?.beforeRename?.();
        // Keep the opened descriptor live through rename so publication can be
        // checked against the inode that was actually written.
        (operations?.rename ?? fsSync.renameSync)(tempPath, filePath);
        let publishedIdentity = null;
        try {
            verifyPublishedFile(fd, filePath, "atomic write", operations);
            publishedIdentity = descriptorIdentity(fd);
            hooks?.afterRename?.();
            verifyPublishedFile(fd, filePath, "atomic write", operations);
        }
        catch (error) {
            rollbackPriorTarget(filePath, backupPath, publishedIdentity, operations);
            throw error;
        }
        fsSync.closeSync(fd);
        fd = null;
        success = true;
        removeBackup(backupPath, operations);
        // Best-effort directory fsync to ensure rename is durable
        try {
            if (operations) {
                operations.sync();
            }
            else {
                const dirFd = fsSync.openSync(dir, "r");
                try {
                    fsSync.fsyncSync(dirFd);
                }
                finally {
                    fsSync.closeSync(dirFd);
                }
            }
        }
        catch {
            // Some platforms don't support directory fsync - that's okay
        }
    }
    finally {
        // Close fd if still open
        if (fd !== null) {
            try {
                fsSync.closeSync(fd);
            }
            catch {
                // Ignore close errors
            }
        }
        // Clean up temp file on error
        if (!success) {
            try {
                (operations?.unlink ?? fsSync.unlinkSync)(tempPath);
            }
            catch {
                // Ignore cleanup errors
            }
            removeBackup(backupPath, operations);
        }
    }
}
/**
 * Write JSON data atomically to a file (synchronous version).
 * Uses temp file + atomic rename pattern with fsync for durability.
 *
 * @param filePath Target file path
 * @param data Data to serialize as JSON
 * @throws Error if JSON serialization fails or write operation fails
 */
export function atomicWriteJsonSync(filePath, data, hooks, operations) {
    const jsonContent = JSON.stringify(data, null, 2);
    atomicWriteFileSync(filePath, jsonContent, hooks, operations);
}
const ATOMIC_BATCH_MAX_WRITES = 64;
const ATOMIC_BATCH_MAX_CONTENT_BYTES = 1024 * 1024;
export function atomicWriteBatchSync(writes, hooks) {
    if (writes.length > ATOMIC_BATCH_MAX_WRITES) {
        throw new Error(`Atomic batch exceeds ${ATOMIC_BATCH_MAX_WRITES} writes`);
    }
    const targets = new Set();
    let totalBytes = 0;
    const pending = writes.map((write) => {
        if (!write.path || typeof write.content !== "string") {
            throw new TypeError("Atomic batch writes require a path and string content");
        }
        if (write.mode !== undefined && (!Number.isInteger(write.mode) || write.mode < 0 || write.mode > 0o777)) {
            throw new RangeError("Atomic batch write mode must be a valid file mode");
        }
        if (targets.has(write.path)) {
            throw new Error(`Atomic batch contains duplicate target: ${write.path}`);
        }
        targets.add(write.path);
        totalBytes += Buffer.byteLength(write.content, "utf-8");
        if (totalBytes > ATOMIC_BATCH_MAX_CONTENT_BYTES) {
            throw new Error(`Atomic batch exceeds ${ATOMIC_BATCH_MAX_CONTENT_BYTES} bytes`);
        }
        const dir = path.dirname(write.path);
        ensureDirSync(dir);
        return {
            ...write,
            dir,
            tempPath: path.join(dir, `.${path.basename(write.path)}.tmp.${crypto.randomUUID()}`),
            fd: null,
            backupPath: null,
        };
    });
    const renamedDirectories = new Set();
    try {
        for (const write of pending) {
            // Keep the unpublished generation private regardless of the requested
            // target mode; the latter is applied only after the atomic replacement.
            const fd = fsSync.openSync(write.tempPath, "wx", 0o600);
            write.fd = fd;
            try {
                writeAllSync(fd, write.content, "atomic batch write");
                fsSync.fsyncSync(fd);
                verifyPrivateTempFile(fd, write.tempPath, "atomic batch write");
            }
            catch (error) {
                fsSync.closeSync(fd);
                write.fd = null;
                throw error;
            }
        }
        for (const write of pending) {
            if (write.fd === null) {
                throw new Error("atomic batch write descriptor was closed before rename");
            }
            write.backupPath = preservePriorTarget(write.path);
            hooks?.beforeRename?.();
            fsSync.renameSync(write.tempPath, write.path);
            let publishedIdentity = null;
            try {
                verifyPublishedFile(write.fd, write.path, "atomic batch write");
                publishedIdentity = descriptorIdentity(write.fd);
                if (write.mode !== undefined && write.mode !== 0o600) {
                    fsSync.chmodSync(write.path, write.mode);
                }
                hooks?.afterRename?.();
                verifyPublishedFile(write.fd, write.path, "atomic batch write");
            }
            catch (error) {
                rollbackPriorTarget(write.path, write.backupPath, publishedIdentity);
                throw error;
            }
            fsSync.closeSync(write.fd);
            write.fd = null;
            removeBackup(write.backupPath);
            write.backupPath = null;
            renamedDirectories.add(write.dir);
        }
        for (const dir of renamedDirectories) {
            try {
                const dirFd = fsSync.openSync(dir, "r");
                try {
                    fsSync.fsyncSync(dirFd);
                }
                finally {
                    fsSync.closeSync(dirFd);
                }
            }
            catch {
                // Some platforms do not support directory fsync.
            }
        }
    }
    finally {
        for (const write of pending) {
            if (write.fd !== null) {
                try {
                    fsSync.closeSync(write.fd);
                }
                catch {
                    // Best effort descriptor cleanup.
                }
                write.fd = null;
            }
            removeBackup(write.backupPath);
            write.backupPath = null;
            try {
                fsSync.unlinkSync(write.tempPath);
            }
            catch {
                // The temp file was renamed or could not be created.
            }
        }
    }
}
export async function safeReadJson(filePath) {
    try {
        // Check if file exists
        await fs.access(filePath);
        // Read file content
        const content = await fs.readFile(filePath, "utf-8");
        // Parse JSON
        return JSON.parse(content);
    }
    catch (err) {
        const error = err;
        // File doesn't exist - return null
        if (error.code === "ENOENT") {
            return null;
        }
        // Parse error or read error - return null
        // In production, you might want to log these errors
        return null;
    }
}
//# sourceMappingURL=atomic-write.js.map