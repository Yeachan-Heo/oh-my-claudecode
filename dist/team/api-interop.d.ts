export declare const LEGACY_TEAM_MCP_TOOLS: readonly ["team_send_message", "team_broadcast", "team_mailbox_list", "team_mailbox_mark_delivered", "team_mailbox_mark_notified", "team_create_task", "team_read_task", "team_list_tasks", "team_update_task", "team_claim_task", "team_transition_task_status", "team_release_task_claim", "team_read_config", "team_read_manifest", "team_read_worker_status", "team_read_worker_heartbeat", "team_update_worker_heartbeat", "team_write_worker_inbox", "team_write_worker_identity", "team_append_event", "team_get_summary", "team_cleanup", "team_write_shutdown_request", "team_read_shutdown_ack", "team_read_monitor_snapshot", "team_write_monitor_snapshot", "team_read_task_approval", "team_write_task_approval"];
export declare const TEAM_API_OPERATIONS: readonly ["send-message", "broadcast", "mailbox-list", "mailbox-mark-delivered", "mailbox-mark-notified", "create-task", "read-task", "list-tasks", "update-task", "claim-task", "transition-task-status", "release-task-claim", "read-config", "read-manifest", "read-worker-status", "read-worker-heartbeat", "update-worker-heartbeat", "write-worker-inbox", "write-worker-identity", "append-event", "get-summary", "cleanup", "write-shutdown-request", "read-shutdown-ack", "read-monitor-snapshot", "write-monitor-snapshot", "read-task-approval", "write-task-approval"];
export type TeamApiOperation = typeof TEAM_API_OPERATIONS[number];
export type TeamApiEnvelope = {
    ok: true;
    operation: TeamApiOperation;
    data: Record<string, unknown>;
} | {
    ok: false;
    operation: TeamApiOperation | 'unknown';
    error: {
        code: string;
        message: string;
    };
};
export declare function resolveTeamApiCliCommand(env?: NodeJS.ProcessEnv): 'omc team api' | 'omx team api';
export declare function resolveTeamApiOperation(name: string): TeamApiOperation | null;
export declare function buildLegacyTeamDeprecationHint(legacyName: string, originalArgs?: Record<string, unknown>, env?: NodeJS.ProcessEnv): string;
export declare function executeTeamApiOperation(operation: TeamApiOperation, args: Record<string, unknown>, fallbackCwd: string): Promise<TeamApiEnvelope>;
//# sourceMappingURL=api-interop.d.ts.map