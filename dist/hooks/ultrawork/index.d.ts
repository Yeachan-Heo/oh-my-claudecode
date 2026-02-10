/**
 * Ultrawork State Management
 *
 * Manages persistent ultrawork mode state across sessions.
 * When ultrawork is activated and todos remain incomplete,
 * this module ensures the mode persists until all work is done.
 */
export interface UltraworkState {
    /** Whether ultrawork mode is currently active */
    active: boolean;
    /** When ultrawork was activated */
    started_at: string;
    /** The original prompt that triggered ultrawork */
    original_prompt: string;
    /** Session ID the mode is bound to */
    session_id?: string;
    /** Project path for isolation */
    project_path?: string;
    /** Number of times the mode has been reinforced (for metrics) */
    reinforcement_count: number;
    /** Last time the mode was checked/reinforced */
    last_checked_at: string;
    /** Whether this ultrawork session is linked to a ralph-loop session */
    linked_to_ralph?: boolean;
}
/**
 * Read Ultrawork state from disk (local only)
 *
 * When sessionId is provided, ONLY reads session-scoped file — no legacy fallback.
 * This prevents cross-session state leakage.
 */
export declare function readUltraworkState(directory?: string, sessionId?: string): UltraworkState | null;
/**
 * Write Ultrawork state to disk (local only)
 */
export declare function writeUltraworkState(state: UltraworkState, directory?: string, sessionId?: string): boolean;
/**
 * Activate ultrawork mode
 */
export declare function activateUltrawork(prompt: string, sessionId?: string, directory?: string, linkedToRalph?: boolean): boolean;
/**
 * Deactivate ultrawork mode
 *
 * When sessionId is provided:
 * 1. Deletes the session-scoped state file
 * 2. Cleans up ghost legacy files that belong to this session (or have no session_id)
 *    to prevent stale legacy files from leaking into other sessions.
 */
export declare function deactivateUltrawork(directory?: string, sessionId?: string): boolean;
/**
 * Increment reinforcement count (called when mode is reinforced on stop)
 */
export declare function incrementReinforcement(directory?: string, sessionId?: string): UltraworkState | null;
/**
 * Check if ultrawork should be reinforced (active with pending todos)
 */
export declare function shouldReinforceUltrawork(sessionId?: string, directory?: string): boolean;
/**
 * Get ultrawork persistence message for injection
 */
export declare function getUltraworkPersistenceMessage(state: UltraworkState): string;
/**
 * Create an Ultrawork State hook instance
 */
export declare function createUltraworkStateHook(directory: string): {
    activate: (prompt: string, sessionId?: string) => boolean;
    deactivate: (sessionId?: string) => boolean;
    getState: (sessionId?: string) => UltraworkState | null;
    shouldReinforce: (sessionId?: string) => boolean;
    incrementReinforcement: (sessionId?: string) => UltraworkState | null;
};
//# sourceMappingURL=index.d.ts.map