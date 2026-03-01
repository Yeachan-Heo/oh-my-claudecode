/**
 * MCP Team Bridge Module - Barrel Export
 *
 * Provides all public APIs for the team bridge functionality.
 */
export type { BridgeConfig, TaskFile, TaskFileUpdate, InboxMessage, OutboxMessage, ShutdownSignal, DrainSignal, McpWorkerMember, HeartbeatData, InboxCursor, ConfigProbeResult, TaskModeMap, TaskFailureSidecar, WorkerBackend, WorkerCapability, } from './types.js';
export { readTask, updateTask, findNextTask, areBlockersResolved, writeTaskFailure, readTaskFailure, listTaskIds, } from './task-file-ops.js';
export { validateTmux, sanitizeName, sessionName, createSession, killSession, isSessionAlive, listActiveSessions, spawnBridgeInSession, } from './tmux-session.js';
export { appendOutbox, rotateOutboxIfNeeded, rotateInboxIfNeeded, readNewInboxMessages, readAllInboxMessages, clearInbox, writeShutdownSignal, checkShutdownSignal, deleteShutdownSignal, writeDrainSignal, checkDrainSignal, deleteDrainSignal, cleanupWorkerFiles, } from './inbox-outbox.js';
export { registerMcpWorker, unregisterMcpWorker, isMcpWorker, listMcpWorkers, getRegistrationStrategy, readProbeResult, writeProbeResult, } from './team-registration.js';
export { writeHeartbeat, readHeartbeat, listHeartbeats, isWorkerAlive, deleteHeartbeat, cleanupTeamHeartbeats, } from './heartbeat.js';
export { readNewOutboxMessages, readAllTeamOutboxMessages, resetOutboxCursor, } from './outbox-reader.js';
export type { OutboxCursor } from './outbox-reader.js';
export { getTeamStatus } from './team-status.js';
export type { WorkerStatus, TeamStatus } from './team-status.js';
export { runBridge, sanitizePromptContent } from './mcp-team-bridge.js';
export { logAuditEvent, readAuditLog, rotateAuditLog } from './audit-log.js';
export type { AuditEventType, AuditEvent } from './audit-log.js';
export { getWorkerHealthReports, checkWorkerHealth, } from './worker-health.js';
export type { WorkerHealthReport } from './worker-health.js';
export { shouldRestart, recordRestart, readRestartState, clearRestartState, synthesizeBridgeConfig, } from './worker-restart.js';
export type { RestartPolicy, RestartState } from './worker-restart.js';
export { getTeamMembers } from './unified-team.js';
export type { UnifiedTeamMember } from './unified-team.js';
export { routeMessage, broadcastToTeam } from './message-router.js';
export type { RouteResult, BroadcastResult } from './message-router.js';
export { getDefaultCapabilities, scoreWorkerFitness, rankWorkersForTask, } from './capabilities.js';
export { routeTasks } from './task-router.js';
export type { TaskRoutingDecision } from './task-router.js';
export { createWorkerWorktree, removeWorkerWorktree, listTeamWorktrees, cleanupTeamWorktrees, } from './git-worktree.js';
export type { WorktreeInfo } from './git-worktree.js';
export { getActivityLog, formatActivityTimeline } from './activity-log.js';
export type { ActivityEntry } from './activity-log.js';
export { recordTaskUsage, measureCharCounts, generateUsageReport, } from './usage-tracker.js';
export type { TaskUsageRecord, WorkerUsageSummary, TeamUsageReport } from './usage-tracker.js';
export { checkMergeConflicts, mergeWorkerBranch, mergeAllWorkerBranches, } from './merge-coordinator.js';
export type { MergeResult } from './merge-coordinator.js';
export { generateTeamReport, saveTeamReport } from './summary-report.js';
export { isPathAllowed, isCommandAllowed, formatPermissionInstructions, getDefaultPermissions, } from './permissions.js';
export type { WorkerPermissions } from './permissions.js';
export { TeamPaths, absPath, teamStateRoot } from './state-paths.js';
export type { CliAgentType, CliAgentContract, WorkerLaunchConfig } from './model-contract.js';
export { getContract, isCliAvailable as isCliAvailableForAgent, validateCliAvailable as validateCliAvailableForAgent, buildLaunchArgs, buildWorkerCommand, parseCliOutput, } from './model-contract.js';
export type { CliInfo } from './cli-detection.js';
export { detectCli, detectAllClis } from './cli-detection.js';
export type { WorkerBootstrapParams } from './worker-bootstrap.js';
export { generateWorkerOverlay, composeInitialInbox, appendToInbox, getWorkerEnv, ensureWorkerStateDir, writeWorkerOverlay, } from './worker-bootstrap.js';
export { sendTmuxTrigger, queueInboxInstruction, queueDirectMessage, queueBroadcastMessage, readMailbox, } from './tmux-comm.js';
export type { TeamPhase, PhaseableTask } from './phase-controller.js';
export { inferPhase, getPhaseTransitionLog, isTerminalPhase } from './phase-controller.js';
export type { TeamConfig, TeamRuntime, WorkerStatus as RuntimeWorkerStatus, TeamSnapshot, WatchdogCompletionEvent, } from './runtime.js';
export { startTeam, monitorTeam, assignTask, shutdownTeam, resumeTeam, watchdogCliWorkers } from './runtime.js';
export { injectToLeaderPane } from './tmux-session.js';
export type { DoneSignal } from './types.js';
//# sourceMappingURL=index.d.ts.map