export declare const TEAM_NAME_SAFE_PATTERN: RegExp;
export declare const WORKER_NAME_SAFE_PATTERN: RegExp;
export declare const TASK_ID_SAFE_PATTERN: RegExp;
export declare const TEAM_TASK_STATUSES: readonly ["pending", "blocked", "in_progress", "completed", "failed"];
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];
export declare const TEAM_TERMINAL_TASK_STATUSES: ReadonlySet<TeamTaskStatus>;
export declare const TEAM_TASK_STATUS_TRANSITIONS: Readonly<Record<TeamTaskStatus, readonly TeamTaskStatus[]>>;
export declare function isTerminalTeamTaskStatus(status: TeamTaskStatus): boolean;
export declare function canTransitionTeamTaskStatus(from: TeamTaskStatus, to: TeamTaskStatus): boolean;
export declare const TEAM_EVENT_TYPES: readonly ["task_completed", "task_failed", "worker_idle", "worker_stopped", "message_received", "shutdown_ack", "shutdown_gate", "shutdown_gate_forced", "approval_decision", "team_leader_nudge"];
export type TeamEventType = (typeof TEAM_EVENT_TYPES)[number];
export declare const TEAM_TASK_APPROVAL_STATUSES: readonly ["pending", "approved", "rejected"];
export type TeamTaskApprovalStatus = (typeof TEAM_TASK_APPROVAL_STATUSES)[number];
//# sourceMappingURL=contracts.d.ts.map