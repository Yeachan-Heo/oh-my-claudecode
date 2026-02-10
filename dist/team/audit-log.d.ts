export type AuditEventType = 'bridge_start' | 'bridge_shutdown' | 'task_claimed' | 'task_started' | 'task_completed' | 'task_failed' | 'task_permanently_failed' | 'worker_quarantined' | 'worker_idle' | 'inbox_rotated' | 'outbox_rotated' | 'cli_spawned' | 'cli_timeout' | 'cli_error' | 'shutdown_received' | 'shutdown_ack' | 'permission_violation' | 'permission_audit';
export interface AuditEvent {
    timestamp: string;
    eventType: AuditEventType;
    teamName: string;
    workerName: string;
    taskId?: string;
    details?: Record<string, unknown>;
}
/**
 * Append an audit event to the team's audit log.
 * Append-only JSONL format with 0o600 permissions.
 */
export declare function logAuditEvent(workingDirectory: string, event: AuditEvent): void;
/**
 * Read audit events with optional filtering.
 */
export declare function readAuditLog(workingDirectory: string, teamName: string, filter?: {
    eventType?: AuditEventType;
    workerName?: string;
    since?: string;
    limit?: number;
}): AuditEvent[];
/**
 * Rotate audit log if it exceeds maxSizeBytes.
 * Keeps the most recent half of entries.
 */
export declare function rotateAuditLog(workingDirectory: string, teamName: string, maxSizeBytes?: number): void;
//# sourceMappingURL=audit-log.d.ts.map