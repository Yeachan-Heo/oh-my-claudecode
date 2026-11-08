export const TEAM_NAME_SAFE_PATTERN = /^[a-z0-9][a-z0-9-]{0,29}$/;
export const WORKER_NAME_SAFE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const TASK_ID_SAFE_PATTERN = /^\d{1,20}$/;
export const TEAM_TASK_STATUSES = ['pending', 'blocked', 'in_progress', 'completed', 'failed'];
export const TEAM_TERMINAL_TASK_STATUSES = new Set(['completed', 'failed']);
export const TEAM_TASK_STATUS_TRANSITIONS = {
    pending: [],
    blocked: [],
    in_progress: ['completed', 'failed'],
    completed: [],
    failed: [],
};
export function isTerminalTeamTaskStatus(status) {
    return TEAM_TERMINAL_TASK_STATUSES.has(status);
}
export function canTransitionTeamTaskStatus(from, to) {
    return TEAM_TASK_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}
export const TEAM_EVENT_TYPES = [
    'task_completed',
    'task_failed',
    'worker_idle',
    'worker_stopped',
    'message_received',
    'shutdown_ack',
    'shutdown_gate',
    'shutdown_gate_forced',
    'approval_decision',
    'team_leader_nudge',
];
export const TEAM_TASK_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'];
//# sourceMappingURL=contracts.js.map