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
export function ensureDirSync(dir: string): void {
  if (fsSync.existsSync(dir)) {
    return;
  }

  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch (err) {
    // If directory was created by another process between exists check and mkdir,
    // that's fine - verify it exists now
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return;
    }
    throw err;
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
export async function atomicWriteJson(
  filePath: string,
  data: unknown,
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.tmp.${crypto.randomUUID()}`);

  let success = false;

  try {
    // Ensure parent directory exists
    ensureDirSync(dir);

    // Serialize data to JSON
    const jsonContent = JSON.stringify(data, null, 2);

    // Write to temp file with exclusive creation (wx = O_CREAT | O_EXCL | O_WRONLY)
    const fd = await fs.open(tempPath, "wx", 0o600);
    try {
      await fd.write(jsonContent, 0, "utf-8");
      // Sync file data to disk before rename
      await fd.sync();
    } finally {
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
      } finally {
        await dirFd.close();
      }
    } catch {
      // Some platforms don't support directory fsync - that's okay
    }
  } finally {
    // Clean up temp file on error
    if (!success) {
      await fs.unlink(tempPath).catch(() => {});
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
export function atomicWriteSync(filePath: string, content: string): void {
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
      fsSync.writeSync(fd, content, 0, 'utf-8');
      // Sync file data to disk before rename
      fsSync.fsyncSync(fd);
    } finally {
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
      } finally {
        fsSync.closeSync(dirFd);
      }
    } catch {
      // Some platforms don't support directory fsync - that's okay
    }
  } finally {
    // Clean up temp file on error
    if (!success) {
      try {
        fsSync.unlinkSync(tempPath);
      } catch {
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
export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.tmp.${crypto.randomUUID()}`);

  let fd: number | null = null;
  let success = false;

  try {
    // Ensure parent directory exists
    ensureDirSync(dir);

    // Open temp file with exclusive creation (O_CREAT | O_EXCL | O_WRONLY)
    fd = fsSync.openSync(tempPath, "wx", 0o600);

    // Write content
    fsSync.writeSync(fd, content, 0, "utf-8");

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
      } finally {
        fsSync.closeSync(dirFd);
      }
    } catch {
      // Some platforms don't support directory fsync - that's okay
    }
  } finally {
    // Close fd if still open
    if (fd !== null) {
      try {
        fsSync.closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
    // Clean up temp file on error
    if (!success) {
      try {
        fsSync.unlinkSync(tempPath);
      } catch {
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
export function atomicWriteJsonSync(filePath: string, data: unknown): void {
  const jsonContent = JSON.stringify(data, null, 2);
  atomicWriteFileSync(filePath, jsonContent);
}

export async function safeReadJson<T>(filePath: string): Promise<T | null> {
  try {
    // Check if file exists
    await fs.access(filePath);

    // Read file content
    const content = await fs.readFile(filePath, "utf-8");

    // Parse JSON
    return JSON.parse(content) as T;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;

    // File doesn't exist - return null
    if (error.code === "ENOENT") {
      return null;
    }

    // Parse error or read error - return null
    // In production, you might want to log these errors
    return null;
  }
}
