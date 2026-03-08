/**
 * Project Memory Storage
 * Handles loading and saving project memory to the resolved project-memory.json path.
 */
import fs from 'fs/promises';
import path from 'path';
import { CACHE_EXPIRY_MS } from './constants.js';
import { atomicWriteJson } from '../../lib/atomic-write.js';
import { getWorktreeProjectMemoryPath } from '../../lib/worktree-paths.js';
import { lockPathFor, withFileLock } from '../../lib/file-lock.js';
/**
 * Get the path to the project memory file
 */
export function getMemoryPath(projectRoot) {
    return getWorktreeProjectMemoryPath(projectRoot);
}
/**
 * Load project memory from disk
 * Returns null if file doesn't exist or is invalid
 */
export async function loadProjectMemory(projectRoot) {
    const memoryPath = getMemoryPath(projectRoot);
    try {
        const content = await fs.readFile(memoryPath, 'utf-8');
        const memory = JSON.parse(content);
        // Basic validation
        if (!memory.version || !memory.projectRoot || !memory.lastScanned) {
            return null;
        }
        return memory;
    }
    catch (_error) {
        // File doesn't exist or invalid JSON
        return null;
    }
}
/**
 * Save project memory to disk
 * Creates .omc directory if it doesn't exist
 */
export async function saveProjectMemory(projectRoot, memory) {
    const memoryPath = getMemoryPath(projectRoot);
    const omcDir = path.dirname(memoryPath);
    try {
        // Ensure .omc directory exists
        await fs.mkdir(omcDir, { recursive: true });
        // Write memory file atomically to prevent corruption on crash
        await atomicWriteJson(memoryPath, memory);
    }
    catch (error) {
        // Silently fail - we don't want to break the session
        console.error('Failed to save project memory:', error);
    }
}
/** Default lock options for project memory operations */
const MEMORY_LOCK_OPTS = { timeoutMs: 5000 };
/**
 * Execute an async function while holding an exclusive lock on the project memory file.
 * Prevents concurrent read-modify-write races across processes.
 *
 * @param projectRoot Project root directory
 * @param fn Function to execute under lock
 * @returns The function's return value
 */
export async function withProjectMemoryLock(projectRoot, fn) {
    const memoryPath = getMemoryPath(projectRoot);
    return withFileLock(lockPathFor(memoryPath), fn, MEMORY_LOCK_OPTS);
}
/**
 * Check if the memory cache is stale and should be rescanned
 */
export function shouldRescan(memory) {
    const now = Date.now();
    const age = now - memory.lastScanned;
    return age > CACHE_EXPIRY_MS;
}
/**
 * Delete the project memory file (force rescan)
 */
export async function deleteProjectMemory(projectRoot) {
    const memoryPath = getMemoryPath(projectRoot);
    try {
        await fs.unlink(memoryPath);
    }
    catch (_error) {
        // Ignore if file doesn't exist
    }
}
//# sourceMappingURL=storage.js.map