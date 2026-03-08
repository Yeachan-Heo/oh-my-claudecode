export const TEAM_NAME_SAFE_PATTERN = /^[a-z0-9][a-z0-9-]{0,29}$/;
export const WORKER_NAME_SAFE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const TASK_ID_SAFE_PATTERN = /^\d{1,20}$/;

export const TEAM_TASK_STATUSES = ['pending', 'blocked', 'in_progress', 'completed', 'failed'] as const;
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];

export const TEAM_TERMINAL_TASK_STATUSES: ReadonlySet<TeamTaskStatus> = new Set<TeamTaskStatus>(['completed', 'failed']);
export const TEAM_TASK_STATUS_TRANSITIONS: Readonly<Record<TeamTaskStatus, readonly TeamTaskStatus[]>> = {
  pending: [],
  blocked: [],
  in_progress: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export function isTerminalTeamTaskStatus(status: TeamTaskStatus): boolean {
  return TEAM_TERMINAL_TASK_STATUSES.has(status);
}

export function canTransitionTeamTaskStatus(from: TeamTaskStatus, to: TeamTaskStatus): boolean {
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
] as const;
export type TeamEventType = (typeof TEAM_EVENT_TYPES)[number];

export const TEAM_TASK_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type TeamTaskApprovalStatus = (typeof TEAM_TASK_APPROVAL_STATUSES)[number];
