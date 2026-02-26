/**
 * Project Memory Hook
 * Main orchestrator for auto-detecting and injecting project context
 */

import { contextCollector } from '../../features/context-injector/collector.js';
import { findProjectRoot } from '../rules-injector/finder.js';
import { loadProjectMemory, saveProjectMemory, shouldRescan } from './storage.js';
import { detectProjectEnvironment } from './detector.js';
import { formatContextSummary } from './formatter.js';

/**
 * Session caches to prevent duplicate injection
 * Map<sessionId, Set<projectRoot>>
 * Bounded to MAX_SESSION_CACHE_SIZE entries to prevent memory leaks in long-running MCP processes.
 */
const sessionCaches = new Map<string, Set<string>>();
const MAX_SESSION_CACHE_SIZE = 100;

/**
 * Register project memory context for a session
 * Called from SessionStart hook
 *
 * @param sessionId - Current session ID
 * @param workingDirectory - Current working directory
 * @returns true if context was registered, false otherwise
 */
export async function registerProjectMemoryContext(
  sessionId: string,
  workingDirectory: string
): Promise<boolean> {
  // Find project root
  const projectRoot = findProjectRoot(workingDirectory);
  if (!projectRoot) {
    return false;
  }

  // Check session cache (avoid duplicate injection)
  if (!sessionCaches.has(sessionId)) {
    // Evict oldest entry if cache is at capacity
    if (sessionCaches.size >= MAX_SESSION_CACHE_SIZE) {
      const oldestKey = sessionCaches.keys().next().value;
      if (oldestKey !== undefined) {
        sessionCaches.delete(oldestKey);
      }
    }
    sessionCaches.set(sessionId, new Set());
  }
  const cache = sessionCaches.get(sessionId)!;
  if (cache.has(projectRoot)) {
    return false;
  }

  try {
    // Load or detect memory
    let memory = await loadProjectMemory(projectRoot);

    // Rescan if memory doesn't exist or is stale
    if (!memory || shouldRescan(memory)) {
      memory = await detectProjectEnvironment(projectRoot);
      await saveProjectMemory(projectRoot, memory);
    }

    // Only inject if we have useful information
    const hasUsefulInfo =
      memory.techStack.languages.length > 0 ||
      memory.techStack.frameworks.length > 0 ||
      memory.build.buildCommand !== null;

    if (!hasUsefulInfo) {
      return false;
    }

    // Register context with high priority
    contextCollector.register(sessionId, {
      id: 'project-environment',
      source: 'project-memory',
      content: formatContextSummary(memory),
      priority: 'high',
      metadata: {
        projectRoot,
        languages: memory.techStack.languages.map(l => l.name),
        lastScanned: memory.lastScanned,
      },
    });

    // Mark as injected for this session
    cache.add(projectRoot);
    return true;
  } catch (error) {
    // Silently fail - we don't want to break the session
    console.error('Error registering project memory context:', error);
    return false;
  }
}

/**
 * Clear project memory session cache
 * Called when session ends
 *
 * @param sessionId - Session ID to clear
 */
export function clearProjectMemorySession(sessionId: string): void {
  sessionCaches.delete(sessionId);
}

/**
 * Force rescan of project environment
 * Useful for manual refresh
 *
 * @param projectRoot - Project root directory
 */
export async function rescanProjectEnvironment(projectRoot: string): Promise<void> {
  const memory = await detectProjectEnvironment(projectRoot);
  await saveProjectMemory(projectRoot, memory);
}

// Re-export utilities for use in other modules
export { loadProjectMemory, saveProjectMemory } from './storage.js';
export { detectProjectEnvironment } from './detector.js';
export { formatContextSummary, formatFullContext } from './formatter.js';
export { learnFromToolOutput, addCustomNote } from './learner.js';
export { processPreCompact } from './pre-compact.js';
export { mapDirectoryStructure, updateDirectoryAccess } from './directory-mapper.js';
export { trackAccess, getTopHotPaths, decayHotPaths } from './hot-path-tracker.js';
export { detectDirectivesFromMessage, addDirective, formatDirectivesForContext } from './directive-detector.js';
export * from './types.js';
