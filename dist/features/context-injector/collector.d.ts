/**
 * Context Collector
 *
 * Manages registration and retrieval of context entries
 * from multiple sources for a session.
 *
 * Ported from oh-my-opencode's context-injector.
 */
import type { PendingContext, RegisterContextOptions } from './types.js';
/**
 * Collects and manages context entries for sessions.
 */
export declare class ContextCollector {
    private sessions;
    /**
     * Register a context entry for a session.
     * If an entry with the same source:id already exists, it will be replaced.
     */
    register(sessionId: string, options: RegisterContextOptions): void;
    /**
     * Get pending context for a session without consuming it.
     */
    getPending(sessionId: string): PendingContext;
    /**
     * Get and consume pending context for a session.
     * After consumption, the session's context is cleared.
     */
    consume(sessionId: string): PendingContext;
    /**
     * Clear all context for a session.
     */
    clear(sessionId: string): void;
    /**
     * Check if a session has pending context.
     */
    hasPending(sessionId: string): boolean;
    /**
     * Get count of entries for a session.
     */
    getEntryCount(sessionId: string): number;
    /**
     * Remove a specific entry from a session.
     */
    removeEntry(sessionId: string, source: string, id: string): boolean;
    /**
     * Get all active session IDs.
     */
    getActiveSessions(): string[];
    /**
     * Sort entries by priority (higher first) then by timestamp (earlier first).
     */
    private sortEntries;
}
/** Global singleton context collector instance */
export declare const contextCollector: ContextCollector;
//# sourceMappingURL=collector.d.ts.map