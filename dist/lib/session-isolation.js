/**
 * Session Isolation - Shared utility for consistent session-scoped state guards.
 *
 * The codebase has historically used three different patterns for checking
 * whether a state object belongs to the current session:
 *
 *   1. Lenient:  `state.session_id && state.session_id !== sessionId` (skip only if mismatch)
 *   2. Strict:   `state.session_id !== sessionId` (skip if missing OR mismatch)
 *   3. Guarded:  `!state.session_id || !sessionId || state.session_id !== sessionId`
 *
 * This module provides a single canonical function so all callers behave the same.
 */
/**
 * Check whether a state object belongs to the given session.
 *
 * Semantics (strict by default):
 * - If `sessionId` is not provided, returns `true` (no session to check against — allow).
 * - If the state has no `stateSessionId`, returns `false` (legacy/ownerless state — reject
 *   when a session is active, to prevent cross-session leakage).
 * - Otherwise, returns `stateSessionId === sessionId`.
 *
 * Use `lenient: true` for backward-compatible code paths where legacy ownerless
 * state should still be accepted.
 *
 * @param stateSessionId - The session_id stored in the state object (may be undefined).
 * @param sessionId - The current request's session ID (may be undefined).
 * @param options.lenient - When true, ownerless state (no stateSessionId) is accepted.
 */
export function isStateForSession(stateSessionId, sessionId, options) {
    // No session context — cannot filter, allow everything.
    if (!sessionId)
        return true;
    // State has no owner.
    if (!stateSessionId) {
        return options?.lenient === true;
    }
    return stateSessionId === sessionId;
}
//# sourceMappingURL=session-isolation.js.map