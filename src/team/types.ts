// src/team/types.ts

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
  pollIntervalMs: number;       // default: 3000
  taskTimeoutMs: number;        // default: 600000 (10 min)
  maxConsecutiveErrors: number;  // default: 3 — self-quarantine threshold
  outboxMaxLines: number;       // default: 500 — rotation trigger
  maxRetries?: number;          // default: 5 — max task retry attempts
  permissionEnforcement?: 'off' | 'audit' | 'enforce'; // default: 'off'
  permissions?: BridgeWorkerPermissions;
}

/** Permission scoping embedded in BridgeConfig (mirrors WorkerPermissions shape) */
export interface BridgeWorkerPermissions {
  allowedPaths: string[];   // glob patterns relative to workingDirectory
  deniedPaths: string[];    // glob patterns that override allowed
  allowedCommands: string[]; // command prefixes (e.g., 'npm test', 'tsc')
  maxFileSize: number;      // max bytes per file write
}

/** Mirrors the JSON structure of ~/.claude/tasks/{team}/{id}.json */
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
  type: 'task_complete' | 'task_failed' | 'idle' | 'shutdown_ack' | 'drain_ack' | 'heartbeat' | 'error';
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
  agentId: string;          // "{workerName}@{teamName}"
  name: string;             // workerName
  agentType: string;        // "mcp-codex" | "mcp-gemini"
  model: string;
  joinedAt: number;         // Date.now()
  tmuxPaneId: string;       // tmux session name
  cwd: string;
  backendType: 'tmux';
  subscriptions: string[];
}

/** Heartbeat file content */
export interface HeartbeatData {
  workerName: string;
  teamName: string;
  provider: 'codex' | 'gemini';
  pid: number;
  lastPollAt: string;       // ISO timestamp of last poll cycle
  currentTaskId?: string;   // task being executed, if any
  consecutiveErrors: number;
  status: 'polling' | 'executing' | 'shutdown' | 'quarantined';
}

/** Offset cursor for JSONL consumption */
export interface InboxCursor {
  bytesRead: number;        // file offset in bytes
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
export type WorkerBackend = 'claude-native' | 'mcp-codex' | 'mcp-gemini';

/** Worker capability tag */
export type WorkerCapability =
  | 'code-edit'
  | 'code-review'
  | 'security-review'
  | 'architecture'
  | 'testing'
  | 'documentation'
  | 'ui-design'
  | 'refactoring'
  | 'research'
  | 'general';
