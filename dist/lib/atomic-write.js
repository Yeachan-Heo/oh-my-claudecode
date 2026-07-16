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
 * Write JSON data atomically to a file.
 * Uses temp file + atomic rename pattern to ensure durability.
 *
 * @param filePath Target file path
 * @param data Data to serialize as JSON
 * @throws Error if JSON serialization fails or write operation fails
 */
export async function atomicWriteJson(filePath, data) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const tempPath = path.join(dir, `.${base}.tmp.${crypto.randomUUID()}`);
    let success = false;
    try {
        // Ensure parent directory exists
        ensureDirSync(dir);
        // Serialize data to JSON
        const jsonContent = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
        // Write to temp file with exclusive creation (wx = O_CREAT | O_EXCL | O_WRONLY)
        const fd = await fs.open(tempPath, "wx", 0o600);
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
        }
        finally {
            await fd.close();
        }
        // Atomic rename - replaces target file if it exists
        // On Windows, fs.rename uses MoveFileExW with MOVEFILE_REPLACE_EXISTING
        await fs.rename(tempPath, filePath);
        success = true;
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
export function atomicWriteSync(filePath, content) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const tempPath = path.join(dir, `.${base}.tmp.${crypto.randomUUID()}`);
    let success = false;
    try {
        // Ensure parent directory exists
        ensureDirSync(dir);
        // Write to temp file with exclusive creation
        const fd = fsSync.openSync(tempPath, 'wx', 0o600);
        try {
            writeAllSync(fd, content, "atomic write");
            // Sync file data to disk before rename
            fsSync.fsyncSync(fd);
        }
        finally {
            fsSync.closeSync(fd);
        }
        // Atomic rename - replaces target file if it exists
        fsSync.renameSync(tempPath, filePath);
        success = true;
        // Best-effort directory fsync to ensure rename is durable
        try {
            const dirFd = fsSync.openSync(dir, 'r');
            try {
                fsSync.fsyncSync(dirFd);
            }
            finally {
                fsSync.closeSync(dirFd);
            }
        }
        catch {
            // Some platforms don't support directory fsync - that's okay
        }
    }
    finally {
        // Clean up temp file on error
        if (!success) {
            try {
                fsSync.unlinkSync(tempPath);
            }
            catch {
                // Ignore cleanup errors
            }
        }
    }
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
export function atomicWriteFileSync(filePath, content) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const tempPath = path.join(dir, `.${base}.tmp.${crypto.randomUUID()}`);
    let fd = null;
    let success = false;
    try {
        // Ensure parent directory exists
        ensureDirSync(dir);
        // Open temp file with exclusive creation (O_CREAT | O_EXCL | O_WRONLY)
        fd = fsSync.openSync(tempPath, "wx", 0o600);
        // Write content
        writeAllSync(fd, content, "atomic write");
        // Sync file data to disk before rename
        fsSync.fsyncSync(fd);
        // Close before rename
        fsSync.closeSync(fd);
        fd = null;
        // Atomic rename - replaces target file if it exists
        fsSync.renameSync(tempPath, filePath);
        success = true;
        // Best-effort directory fsync to ensure rename is durable
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
                fsSync.unlinkSync(tempPath);
            }
            catch {
                // Ignore cleanup errors
            }
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
export function atomicWriteJsonSync(filePath, data) {
    const jsonContent = JSON.stringify(data, null, 2);
    atomicWriteFileSync(filePath, jsonContent);
}
const ATOMIC_BATCH_MAX_WRITES = 64;
const ATOMIC_BATCH_MAX_CONTENT_BYTES = 1024 * 1024;
export function atomicWriteBatchSync(writes) {
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
        };
    });
    const renamedDirectories = new Set();
    try {
        for (const write of pending) {
            const fd = fsSync.openSync(write.tempPath, "wx", write.mode ?? 0o600);
            try {
                writeAllSync(fd, write.content, "atomic batch write");
                fsSync.fsyncSync(fd);
            }
            finally {
                fsSync.closeSync(fd);
            }
        }
        for (const write of pending) {
            fsSync.renameSync(write.tempPath, write.path);
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