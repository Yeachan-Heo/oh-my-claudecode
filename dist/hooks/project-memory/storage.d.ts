/**
 * Project Memory Storage
 * Handles loading and saving project memory to .omc/project-memory.json
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
 * Check if the memory cache is stale and should be rescanned
 */
export declare function shouldRescan(memory: ProjectMemory): boolean;
/**
 * Delete the project memory file (force rescan)
 */
export declare function deleteProjectMemory(projectRoot: string): Promise<void>;
//# sourceMappingURL=storage.d.ts.map