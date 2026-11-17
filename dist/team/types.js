// src/team/types.ts
function isAbsoluteTmuxSocketPath(value) {
    // Tmux sockets are absolute on POSIX; retain the Windows drive/UNC forms so
    // persisted records can still be structurally validated across platforms.
    return value.startsWith('/')
        || /^[A-Za-z]:[\\/]/.test(value)
        || value.startsWith('\\\\');
}
/** Structural validation for persisted or caller-supplied tmux identities. */
export function isValidTmuxServerIdentity(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const candidate = value;
    return typeof candidate.socket_path === 'string'
        && candidate.socket_path.length > 0
        && candidate.socket_path === candidate.socket_path.trim()
        && !/[\u0000-\u001f\u007f]/.test(candidate.socket_path)
        && isAbsoluteTmuxSocketPath(candidate.socket_path)
        && typeof candidate.server_pid === 'number'
        && Number.isSafeInteger(candidate.server_pid)
        && candidate.server_pid > 0
        && typeof candidate.process_started_at === 'string'
        && candidate.process_started_at.length > 0
        && candidate.process_started_at.length <= 1024
        && !/[\u0000-\u001f\u007f]/.test(candidate.process_started_at);
}
export const TEAM_INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidTeamInstanceId(value) {
    return typeof value === 'string' && TEAM_INSTANCE_ID_PATTERN.test(value);
}
/** Claude/OMC session id stored as team ownership, never a tmux target. */
export const LEADER_SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
export function isValidLeaderSessionId(value) {
    return typeof value === 'string' && LEADER_SESSION_ID_PATTERN.test(value);
}
export const DEFAULT_MAX_WORKERS = 20;
export const ABSOLUTE_MAX_WORKERS = 20;
//# sourceMappingURL=types.js.map