/**
 * Project Memory Storage
 * Handles loading and saving project memory to the resolved project-memory.json path.
 */
import { ProjectMemory } from './types.js';
/**
 * Get the path to the project memory file
 */
export declare function getMemoryPath(projectRoot: string): string;
/**
 * Load project memory from disk
 * Returns null if file doesn't exist or is invalid
 */
export declare function loadProjectMemory(projectRoot: string): Promise<ProjectMemory | null>;
/**
 * Save project memory to disk
 * Creates .omc directory if it doesn't exist
 */
export declare function saveProjectMemory(projectRoot: string, memory: ProjectMemory): Promise<void>;
/**
 * Execute an async function while holding an exclusive lock on the project memory file.
 * Prevents concurrent read-modify-write races across processes.
 *
 * @param projectRoot Project root directory
 * @param fn Function to execute under lock
 * @returns The function's return value
 */
export declare function withProjectMemoryLock<T>(projectRoot: string, fn: () => T | Promise<T>): Promise<T>;
/**
 * Check if the memory cache is stale and should be rescanned
 */
export declare function shouldRescan(memory: ProjectMemory): boolean;
/**
 * Delete the project memory file (force rescan)
 */
export declare function deleteProjectMemory(projectRoot: string): Promise<void>;
//# sourceMappingURL=storage.d.ts.map