/**
 * OMX Team State Layer (forked from oh-my-codex)
 *
 * Provides read/write access to .omx/state/team/{name}/ directories,
 * enabling omc to communicate with omx teams using the native omx format.
 *
 * Data layout: .omx/state/team/{name}/
 *   config.json              — TeamConfig
 *   manifest.v2.json         — TeamManifestV2
 *   mailbox/{worker}.json    — TeamMailbox
 *   tasks/task-{id}.json     — TeamTask
 *   events/events.ndjson     — TeamEvent (append-only)
 */
export interface OmxTeamConfig {
    name: string;
    task: string;
    agent_type: string;
    worker_count: number;
    max_workers: number;
    workers: OmxWorkerInfo[];
    created_at: string;
    tmux_session: string;
    next_task_id: number;
}
export interface OmxWorkerInfo {
    name: string;
    index: number;
    role: string;
    assigned_tasks: string[];
    pid?: number;
    pane_id?: string;
}
export interface OmxTeamTask {
    id: string;
    subject: string;
    description: string;
    status: 'pending' | 'blocked' | 'in_progress' | 'completed' | 'failed';
    requires_code_change?: boolean;
    owner?: string;
    result?: string;
    error?: string;
    blocked_by?: string[];
    depends_on?: string[];
    version?: number;
    created_at: string;
    completed_at?: string;
}
export interface OmxTeamMailboxMessage {
    message_id: string;
    from_worker: string;
    to_worker: string;
    body: string;
    created_at: string;
    notified_at?: string;
    delivered_at?: string;
}
export interface OmxTeamMailbox {
    worker: string;
    messages: OmxTeamMailboxMessage[];
}
export interface OmxTeamEvent {
    event_id: string;
    team: string;
    type: 'task_completed' | 'worker_idle' | 'worker_stopped' | 'message_received' | 'shutdown_ack' | 'approval_decision' | 'team_leader_nudge';
    worker: string;
    task_id?: string;
    message_id?: string | null;
    reason?: string;
    next_action?: 'shutdown' | 'reuse-current-team' | 'launch-new-team' | 'keep-checking-status';
    message?: string;
    created_at: string;
}
export interface OmxTeamManifestV2 {
    schema_version: 2;
    name: string;
    task: string;
    tmux_session: string;
    worker_count: number;
    workers: OmxWorkerInfo[];
    next_task_id: number;
    created_at: string;
    [key: string]: unknown;
}
/**
 * List active omx teams by scanning .omx/state/team/ subdirectories
 */
export declare function listOmxTeams(cwd: string): Promise<string[]>;
/**
 * Read team config (tries manifest.v2.json first, falls back to config.json)
 */
export declare function readOmxTeamConfig(teamName: string, cwd: string): Promise<OmxTeamConfig | null>;
/**
 * Read a worker's mailbox
 */
export declare function readOmxMailbox(teamName: string, workerName: string, cwd: string): Promise<OmxTeamMailbox>;
/**
 * List all messages in a worker's mailbox
 */
export declare function listOmxMailboxMessages(teamName: string, workerName: string, cwd: string): Promise<OmxTeamMailboxMessage[]>;
/**
 * Send a direct message to an omx worker's mailbox
 *
 * @deprecated Interop active write path must go through broker -> OMX team_* MCP APIs.
 * Kept for legacy compatibility and observe-mode tooling only.
 */
export declare function sendOmxDirectMessage(teamName: string, fromWorker: string, toWorker: string, body: string, cwd: string): Promise<OmxTeamMailboxMessage>;
/**
 * Broadcast a message to all workers in an omx team
 *
 * @deprecated Interop active write path must go through broker -> OMX team_* MCP APIs.
 */
export declare function broadcastOmxMessage(teamName: string, fromWorker: string, body: string, cwd: string): Promise<OmxTeamMailboxMessage[]>;
/**
 * Mark a message as delivered in an omx worker's mailbox
 *
 * @deprecated Interop active write path must go through broker -> OMX team_* MCP APIs.
 */
export declare function markOmxMessageDelivered(teamName: string, workerName: string, messageId: string, cwd: string): Promise<boolean>;
/**
 * Read a single omx team task
 */
export declare function readOmxTask(teamName: string, taskId: string, cwd: string): Promise<OmxTeamTask | null>;
/**
 * List all tasks in an omx team
 */
export declare function listOmxTasks(teamName: string, cwd: string): Promise<OmxTeamTask[]>;
/**
 * Append an event to the omx team event log
 *
 * @deprecated Interop active write path must go through broker -> OMX team_* MCP APIs.
 */
export declare function appendOmxTeamEvent(teamName: string, event: Omit<OmxTeamEvent, 'event_id' | 'created_at' | 'team'>, cwd: string): Promise<OmxTeamEvent>;
//# sourceMappingURL=omx-team-state.d.ts.map