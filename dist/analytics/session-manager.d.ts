import { SessionMetadata, SessionAnalytics, SessionHistory, SessionSummary, SessionTag } from './session-types.js';
/**
 * Session activity tracker for tasks and errors
 */
interface SessionActivity {
    tasksCompleted: number;
    errorCount: number;
}
/**
 * Record a completed task for a session
 */
export declare function recordTaskCompleted(sessionId: string): void;
/**
 * Record an error for a session
 */
export declare function recordError(sessionId: string): void;
/**
 * Get session activity metrics
 */
export declare function getSessionActivity(sessionId: string): SessionActivity;
/**
 * Clear session activity (called when session ends)
 */
export declare function clearSessionActivity(sessionId: string): void;
export declare class SessionManager {
    private currentSession;
    private history;
    startSession(goals: string[], tags?: SessionTag[], notes?: string): Promise<SessionMetadata>;
    endSession(outcomes: string[], status?: 'completed' | 'abandoned'): Promise<SessionMetadata>;
    getCurrentSession(): Promise<SessionMetadata | null>;
    resumeSession(sessionId: string): Promise<SessionMetadata>;
    getSessionAnalytics(sessionId: string): Promise<SessionAnalytics>;
    getSessionSummary(sessionId: string): Promise<SessionSummary>;
    getHistory(): Promise<SessionHistory>;
    searchSessions(query: {
        tags?: SessionTag[];
        startDate?: string;
        endDate?: string;
        status?: SessionMetadata['status'];
        projectPath?: string;
    }): Promise<SessionMetadata[]>;
    private saveCurrentSession;
    private loadHistory;
    /**
     * Migrate session history from local (.omc/state/) to global (~/.omc/state/).
     * Runs once on first loadHistory() call. Handles three cases:
     * - Local exists, global doesn't: copy local to global
     * - Both exist: merge, dedup by session ID
     * - Only global or neither: no-op
     */
    private migrateLocalToGlobal;
    private addToHistory;
    private generateSessionId;
}
export declare function getSessionManager(): SessionManager;
export declare function resetSessionManager(): SessionManager;
export {};
//# sourceMappingURL=session-manager.d.ts.map