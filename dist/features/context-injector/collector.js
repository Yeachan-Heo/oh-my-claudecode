/**
 * Context Collector
 *
 * Manages registration and retrieval of context entries
 * from multiple sources for a session.
 *
 * Ported from oh-my-opencode's context-injector.
 */
/** Priority ordering - lower number = higher priority */
const PRIORITY_ORDER = {
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
    sessions = new Map();
    /**
     * Register a context entry for a session.
     * If an entry with the same source:id already exists, it will be replaced.
     */
    register(sessionId, options) {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, new Map());
        }
        const sessionMap = this.sessions.get(sessionId);
        const key = `${options.source}:${options.id}`;
        const entry = {
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
    getPending(sessionId) {
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
    consume(sessionId) {
        const pending = this.getPending(sessionId);
        this.clear(sessionId);
        return pending;
    }
    /**
     * Clear all context for a session.
     */
    clear(sessionId) {
        this.sessions.delete(sessionId);
    }
    /**
     * Check if a session has pending context.
     */
    hasPending(sessionId) {
        const sessionMap = this.sessions.get(sessionId);
        return sessionMap !== undefined && sessionMap.size > 0;
    }
    /**
     * Get count of entries for a session.
     */
    getEntryCount(sessionId) {
        const sessionMap = this.sessions.get(sessionId);
        return sessionMap?.size ?? 0;
    }
    /**
     * Remove a specific entry from a session.
     */
    removeEntry(sessionId, source, id) {
        const sessionMap = this.sessions.get(sessionId);
        if (!sessionMap)
            return false;
        const key = `${source}:${id}`;
        return sessionMap.delete(key);
    }
    /**
     * Get all active session IDs.
     */
    getActiveSessions() {
        return [...this.sessions.keys()];
    }
    /**
     * Sort entries by priority (higher first) then by timestamp (earlier first).
     */
    sortEntries(entries) {
        return entries.sort((a, b) => {
            const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
            if (priorityDiff !== 0)
                return priorityDiff;
            return a.timestamp - b.timestamp;
        });
    }
}
/** Global singleton context collector instance */
export const contextCollector = new ContextCollector();
//# sourceMappingURL=collector.js.map