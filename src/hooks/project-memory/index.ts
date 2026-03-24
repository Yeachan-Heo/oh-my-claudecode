/**
 * Project Memory Hook
 * Main orchestrator for auto-detecting and injecting project context
 */

import path from "path";
import { contextCollector } from "../../features/context-injector/collector.js";
import { findProjectRoot } from "../rules-injector/finder.js";
import {
  loadProjectMemory,
  saveProjectMemory,
  shouldRescan,
} from "./storage.js";
import { detectProjectEnvironment } from "./detector.js";
import { formatContextSummary } from "./formatter.js";

/**
 * Session caches to prevent duplicate injection.
 * Map<sessionId, Set<projectRoot:scopeKey>>
 * Bounded to MAX_SESSIONS entries to prevent memory leaks in long-running MCP processes.
 */
const sessionCaches = new Map<string, Set<string>>();
const MAX_SESSIONS = 100;

export async function registerProjectMemoryContext(
  sessionId: string,
  workingDirectory: string,
): Promise<boolean> {
  const projectRoot = findProjectRoot(workingDirectory);
  if (!projectRoot) {
    return false;
  }

  const scopeKey = getScopeKey(projectRoot, workingDirectory);
  const cacheKey = `${projectRoot}:${scopeKey}`;

  if (!sessionCaches.has(sessionId)) {
    if (sessionCaches.size >= MAX_SESSIONS) {
      const firstKey = sessionCaches.keys().next().value;
      if (firstKey !== undefined) {
        sessionCaches.delete(firstKey);
      }
    }
    sessionCaches.set(sessionId, new Set());
  }

  const cache = sessionCaches.get(sessionId)!;
  if (cache.has(cacheKey)) {
    return false;
  }

  try {
    let memory = await loadProjectMemory(projectRoot);

    if (!memory || shouldRescan(memory)) {
      const existing = memory;
      memory = await detectProjectEnvironment(projectRoot);
      if (existing) {
        memory.customNotes = existing.customNotes;
        memory.userDirectives = existing.userDirectives;
        memory.hotPaths = existing.hotPaths;
      }
      await saveProjectMemory(projectRoot, memory);
    }

    const content = formatContextSummary(memory, {
      workingDirectory: path.relative(projectRoot, workingDirectory),
      scopeKey,
    });

    if (!content.trim()) {
      return false;
    }

    contextCollector.register(sessionId, {
      id: "project-environment",
      source: "project-memory",
      content,
      priority: "high",
      metadata: {
        projectRoot,
        scopeKey,
        languages: memory.techStack.languages.map((l) => l.name),
        lastScanned: memory.lastScanned,
      },
    });

    cache.add(cacheKey);
    return true;
  } catch (error) {
    console.error("Error registering project memory context:", error);
    return false;
  }
}

export function clearProjectMemorySession(sessionId: string): void {
  sessionCaches.delete(sessionId);
}

export async function rescanProjectEnvironment(
  projectRoot: string,
): Promise<void> {
  const existing = await loadProjectMemory(projectRoot);
  const memory = await detectProjectEnvironment(projectRoot);
  if (existing) {
    memory.customNotes = existing.customNotes;
    memory.userDirectives = existing.userDirectives;
    memory.hotPaths = existing.hotPaths;
  }
  await saveProjectMemory(projectRoot, memory);
}

function getScopeKey(projectRoot: string, workingDirectory: string): string {
  const relative = path.relative(projectRoot, workingDirectory);
  if (!relative || relative === "") {
    return ".";
  }

  const normalized = relative.replace(/\\/g, "/");
  if (normalized.startsWith("..")) {
    return ".";
  }

  return normalized;
}

export {
  loadProjectMemory,
  saveProjectMemory,
  withProjectMemoryLock,
} from "./storage.js";
export { detectProjectEnvironment } from "./detector.js";
export { formatContextSummary, formatFullContext } from "./formatter.js";
export { learnFromToolOutput, addCustomNote } from "./learner.js";
export { processPreCompact } from "./pre-compact.js";
export {
  mapDirectoryStructure,
  updateDirectoryAccess,
} from "./directory-mapper.js";
export {
  trackAccess,
  getTopHotPaths,
  decayHotPaths,
} from "./hot-path-tracker.js";
export {
  detectDirectivesFromMessage,
  addDirective,
  formatDirectivesForContext,
} from "./directive-detector.js";
export * from "./types.js";
