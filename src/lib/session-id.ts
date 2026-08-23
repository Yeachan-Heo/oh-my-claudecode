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
  hookPayload?: { session_id?: string } | null;
}

function readEnv(): string | undefined {
  const value = process.env.OMC_SESSION_ID;
  return value && value.trim() ? value.trim() : undefined;
}

function readPayload(payload: ResolveSessionIdInput['hookPayload']): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = payload.session_id;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve the active session id given the caller's context. Returns undefined
 * when neither source supplies a value (back-compat legacy mode — caller
 * should fall back to global state path).
 */
export function resolveSessionId(input: ResolveSessionIdInput): string | undefined {
  const env = readEnv();
  const payload = readPayload(input.hookPayload);
  if (input.context === 'cli') {
    return env ?? payload;
  }
  // hook
  return payload ?? env;
}
