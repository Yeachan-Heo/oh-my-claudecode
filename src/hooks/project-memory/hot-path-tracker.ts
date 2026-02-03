/**
 * Hot Path Tracker
 * Tracks frequently accessed files and directories
 */

import path from 'path';
import { HotPath } from './types.js';

const MAX_HOT_PATHS = 50;

/**
 * Track file or directory access
 */
export function trackAccess(
  hotPaths: HotPath[],
  filePath: string,
  projectRoot: string,
  type: 'file' | 'directory'
): HotPath[] {
  // Make path relative to project root
  const relativePath = path.isAbsolute(filePath)
    ? path.relative(projectRoot, filePath)
    : filePath;

  // Skip if path is outside project or in ignored directories
  if (relativePath.startsWith('..') || shouldIgnorePath(relativePath)) {
    return hotPaths;
  }

  // Find existing entry
  const existing = hotPaths.find(hp => hp.path === relativePath);

  if (existing) {
    existing.accessCount++;
    existing.lastAccessed = Date.now();
  } else {
    hotPaths.push({
      path: relativePath,
      accessCount: 1,
      lastAccessed: Date.now(),
      type,
    });
  }

  // Sort by access count and keep top entries
  hotPaths.sort((a, b) => b.accessCount - a.accessCount);

  if (hotPaths.length > MAX_HOT_PATHS) {
    hotPaths.splice(MAX_HOT_PATHS);
  }

  return hotPaths;
}

/**
 * Check if path should be ignored
 */
function shouldIgnorePath(relativePath: string): boolean {
  const ignorePatterns = [
    'node_modules',
    '.git',
    '.omc',
    'dist',
    'build',
    '.cache',
    '.next',
    '.nuxt',
    'coverage',
    '.DS_Store',
  ];

  return ignorePatterns.some(pattern => relativePath.includes(pattern));
}

/**
 * Get top hot paths for display
 */
export function getTopHotPaths(hotPaths: HotPath[], limit: number = 10): HotPath[] {
  return hotPaths.slice(0, limit);
}

/**
 * Decay old hot paths (reduce access count over time)
 */
export function decayHotPaths(hotPaths: HotPath[]): HotPath[] {
  const now = Date.now();
  const dayInMs = 24 * 60 * 60 * 1000;

  return hotPaths
    .map(hp => {
      const age = now - hp.lastAccessed;
      if (age > dayInMs * 7) {
        // Older than 7 days, reduce count
        return { ...hp, accessCount: Math.max(1, Math.floor(hp.accessCount / 2)) };
      }
      return hp;
    })
    .filter(hp => hp.accessCount > 0);
}
