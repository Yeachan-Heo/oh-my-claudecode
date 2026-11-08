/**
 * Context Collector
 *
 * Manages registration and retrieval of context entries
 * from multiple sources for a session.
 *
 * Ported from oh-my-opencode's context-injector.
 */

import type {
  ContextEntry,
  ContextPriority,
  PendingContext,
  RegisterContextOptions,
} from './types.js';

/** Priority ordering - lower number = higher priority */
const PRIORITY_ORDER: Record<ContextPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/** Separator between merged context entries */
const CONTEXT_SEPARATOR = '\n\n---\n\n';

/**
 * Collects and manages context entries for sessions.
 */
export class ContextCollector {
  private sessions: Map<string, Map<string, ContextEntry>> = new Map();

  /**
   * Register a context entry for a session.
   * If an entry with the same source:id already exists, it will be replaced.
   */
  register(sessionId: string, options: RegisterContextOptions): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Map());
    }

    const sessionMap = this.sessions.get(sessionId)!;
    const key = `${options.source}:${options.id}`;

    const entry: ContextEntry = {
      id: options.id,
      source: options.source,
      content: options.content,
      priority: options.priority ?? 'normal',
      timestamp: Date.now(),
      metadata: options.metadata,
    };

    sessionMap.set(key, entry);
  }

  /**
   * Get pending context for a session without consuming it.
   */
  getPending(sessionId: string): PendingContext {
    const sessionMap = this.sessions.get(sessionId);

    if (!sessionMap || sessionMap.size === 0) {
      return {
        merged: '',
        entries: [],
        hasContent: false,
      };
    }

    const entries = this.sortEntries([...sessionMap.values()]);
    const merged = entries.map((e) => e.content).join(CONTEXT_SEPARATOR);

    return {
      merged,
      entries,
      hasContent: entries.length > 0,
    };
  }

  /**
   * Get and consume pending context for a session.
   * After consumption, the session's context is cleared.
   */
  consume(sessionId: string): PendingContext {
    const pending = this.getPending(sessionId);
    this.clear(sessionId);
    return pending;
  }

  /**
   * Clear all context for a session.
   */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Check if a session has pending context.
   */
  hasPending(sessionId: string): boolean {
    const sessionMap = this.sessions.get(sessionId);
    return sessionMap !== undefined && sessionMap.size > 0;
  }

  /**
   * Get count of entries for a session.
   */
  getEntryCount(sessionId: string): number {
    const sessionMap = this.sessions.get(sessionId);
    return sessionMap?.size ?? 0;
  }

  /**
   * Remove a specific entry from a session.
   */
  removeEntry(sessionId: string, source: string, id: string): boolean {
    const sessionMap = this.sessions.get(sessionId);
    if (!sessionMap) return false;

    const key = `${source}:${id}`;
    return sessionMap.delete(key);
  }

  /**
   * Get all active session IDs.
   */
  getActiveSessions(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Sort entries by priority (higher first) then by timestamp (earlier first).
   */
  private sortEntries(entries: ContextEntry[]): ContextEntry[] {
    return entries.sort((a, b) => {
      const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return a.timestamp - b.timestamp;
    });
  }
}

/** Global singleton context collector instance */
export const contextCollector = new ContextCollector();
