/**
 * Session-id resolution for multi-repo workspaces (Wave A).
 *
 * Two callers consume this:
 *  - CLI commands (autopilot, ralph, ultragoal, etc.) running in a
 *    shell where the only signal is the `OMC_SESSION_ID` env var.
 *  - Hooks (session-start, post-tool-use-failure, etc.) running with a
 *    `data.session_id` payload from Claude Code.
 *
 * Precedence is INTENTIONALLY asymmetric:
 *  - In CLI contexts the env var is authoritative — the user controls it
 *    explicitly per-shell, and a stale payload from a previous run must not
 *    override the active terminal's intent.
 *  - In hook contexts the payload is authoritative — Claude Code is the
 *    source of truth for the current session, and the env var may belong to
 *    a different shell.
 *
 * Skill docs (Wave C) must document this asymmetry verbatim.
 */
export type SessionIdContext = 'cli' | 'hook';
export interface ResolveSessionIdInput {
    context: SessionIdContext;
    hookPayload?: {
        session_id?: string;
    } | null;
}
/**
 * Resolve the active session id given the caller's context. Returns undefined
 * when neither source supplies a value (back-compat legacy mode — caller
 * should fall back to global state path).
 */
export declare function resolveSessionId(input: ResolveSessionIdInput): string | undefined;
//# sourceMappingURL=session-id.d.ts.map