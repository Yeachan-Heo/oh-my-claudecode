/**
 * Hot Path Tracker
 * Tracks frequently accessed files and directories
 */
import { HotPath } from './types.js';
/**
 * Track file or directory access
 */
export declare function trackAccess(hotPaths: HotPath[], filePath: string, projectRoot: string, type: 'file' | 'directory'): HotPath[];
/**
 * Get top hot paths for display
 */
export declare function getTopHotPaths(hotPaths: HotPath[], limit?: number): HotPath[];
/**
 * Decay old hot paths (reduce access count over time)
 */
export declare function decayHotPaths(hotPaths: HotPath[]): HotPath[];
//# sourceMappingURL=hot-path-tracker.d.ts.map