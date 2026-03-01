/**
 * MCP Team Bridge - Shared TypeScript interfaces
 *
 * All types used across the team bridge module for MCP worker orchestration.
 */
/** Bridge daemon configuration — passed via --config file to bridge-entry.ts */
export interface BridgeConfig {
    teamName: string;
    workerName: string;
    provider: 'codex' | 'gemini';
    model?: string;
    workingDirectory: string;
    pollIntervalMs: number;
    taskTimeoutMs: number;
    maxConsecutiveErrors: number;
    outboxMaxLines: number;
    maxRetries?: number;
    permissionEnforcement?: 'off' | 'audit' | 'enforce';
    permissions?: BridgeWorkerPermissions;
}
/** Permission scoping embedded in BridgeConfig (mirrors WorkerPermissions shape) */
export interface BridgeWorkerPermissions {
    allowedPaths: string[];
    deniedPaths: string[];
    allowedCommands: string[];
    maxFileSize: number;
}
/** Mirrors the JSON structure of {cwd}/.omc/state/team/{team}/tasks/{id}.json */
export interface TaskFile {
    id: string;
    subject: string;
    description: string;
    activeForm?: string;
    status: 'pending' | 'in_progress' | 'completed';
    owner: string;
    blocks: string[];
    blockedBy: string[];
    metadata?: Record<string, unknown>;
    claimedBy?: string;
    claimedAt?: number;
    claimPid?: number;
}
/** Partial update for a task file (only fields being changed) */
export type TaskFileUpdate = Partial<Pick<TaskFile, 'status' | 'owner' | 'metadata' | 'claimedBy' | 'claimedAt' | 'claimPid'>>;
/** JSONL message from lead -> worker (inbox) */
export interface InboxMessage {
    type: 'message' | 'context';
    content: string;
    timestamp: string;
}
/** JSONL message from worker -> lead (outbox) */
export interface OutboxMessage {
    type: 'ready' | 'task_complete' | 'task_failed' | 'idle' | 'shutdown_ack' | 'drain_ack' | 'heartbeat' | 'error' | 'all_tasks_complete';
    taskId?: string;
    summary?: string;
    message?: string;
    error?: string;
    requestId?: string;
    timestamp: string;
}
/** Shutdown signal file content */
export interface ShutdownSignal {
    requestId: string;
    reason: string;
    timestamp: string;
}
/** Drain signal: finish current task, then shut down gracefully */
export interface DrainSignal {
    requestId: string;
    reason: string;
    timestamp: string;
}
/** MCP worker member entry for config.json or shadow registry */
export interface McpWorkerMember {
    agentId: string;
    name: string;
    agentType: string;
    model: string;
    joinedAt: number;
    tmuxPaneId: string;
    cwd: string;
    backendType: 'tmux';
    subscriptions: string[];
}
/** Heartbeat file content */
export interface HeartbeatData {
    workerName: string;
    teamName: string;
    provider: 'codex' | 'gemini' | 'claude';
    pid: number;
    lastPollAt: string;
    currentTaskId?: string;
    consecutiveErrors: number;
    status: 'ready' | 'polling' | 'executing' | 'shutdown' | 'quarantined';
}
/** Offset cursor for JSONL consumption */
export interface InboxCursor {
    bytesRead: number;
}
/** Result of config.json schema probe */
export interface ConfigProbeResult {
    probeResult: 'pass' | 'fail' | 'partial';
    probedAt: string;
    version: string;
}
/** Sidecar mapping task IDs to execution modes */
export interface TaskModeMap {
    teamName: string;
    taskModes: Record<string, 'mcp_codex' | 'mcp_gemini' | 'claude_worker'>;
}
/** Failure sidecar for a task */
export interface TaskFailureSidecar {
    taskId: string;
    lastError: string;
    retryCount: number;
    lastFailedAt: string;
}
/** Worker backend type */
export type WorkerBackend = 'claude-native' | 'mcp-codex' | 'mcp-gemini' | 'tmux-claude' | 'tmux-codex' | 'tmux-gemini';
/** Signal file written by CLI workers when their task completes */
export interface DoneSignal {
    taskId: string;
    status: 'completed' | 'failed';
    summary: string;
    completedAt: string;
}
/** Worker capability tag */
export type WorkerCapability = 'code-edit' | 'code-review' | 'security-review' | 'architecture' | 'testing' | 'documentation' | 'ui-design' | 'refactoring' | 'research' | 'general';
//# sourceMappingURL=types.d.ts.map