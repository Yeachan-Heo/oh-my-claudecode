// src/team/fs-utils.ts

/**
 * Shared filesystem utilities with permission hardening.
 *
 * All file writes default to 0o600 (owner-only read/write).
 * All directory creates default to 0o700 (owner-only access).
 * Atomic writes use PID+timestamp temp files to prevent collisions.
 */

import { writeFileSync, existsSync, mkdirSync, renameSync, openSync, writeSync, closeSync, realpathSync, constants } from 'fs';
import { dirname, resolve, relative, basename } from 'path';

/** Atomic write: write JSON to temp file with permissions, then rename (prevents corruption on crash) */
export function atomicWriteJson(filePath: string, data: unknown, mode: number = 0o600): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode });
  renameSync(tmpPath, filePath);
}

/** Write file with explicit permission mode */
export function writeFileWithMode(filePath: string, data: string, mode: number = 0o600): void {
  writeFileSync(filePath, data, { encoding: 'utf-8', mode });
}

/** Append to file with explicit permission mode. Creates with mode if file doesn't exist.
 *  Uses O_WRONLY|O_APPEND|O_CREAT to atomically create-or-append in a single syscall,
 *  avoiding TOCTOU race between existence check and write. */
export function appendFileWithMode(filePath: string, data: string, mode: number = 0o600): void {
  const fd = openSync(filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, mode);
  try {
    writeSync(fd, data, null, 'utf-8');
  } finally {
    closeSync(fd);
  }
}

/** Create directory with explicit permission mode */
export function ensureDirWithMode(dirPath: string, mode: number = 0o700): void {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true, mode });
}

/** Resolve a path through symlinks where possible, falling back to resolve for non-existent paths.
 *  For paths that don't exist yet, resolves the parent via realpath and appends the filename. */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Path doesn't exist yet — resolve the parent directory and append the filename
    const parent = dirname(p);
    const name = basename(p);
    try {
      return resolve(realpathSync(parent), name);
    } catch {
      // Parent also doesn't exist, fall back to plain resolve
      return resolve(p);
    }
  }
}

/** Validate that a resolved path is under the expected base directory. Throws if not.
 *  Uses realpathSync to resolve symlinks, preventing symlink-based escapes. */
export function validateResolvedPath(resolvedPath: string, expectedBase: string): void {
  const absResolved = safeRealpath(resolvedPath);
  const absBase = safeRealpath(expectedBase);
  const rel = relative(absBase, absResolved);
  if (rel.startsWith('..') || resolve(absBase, rel) !== absResolved) {
    throw new Error(`Path traversal detected: "${resolvedPath}" escapes base "${expectedBase}"`);
  }
}
