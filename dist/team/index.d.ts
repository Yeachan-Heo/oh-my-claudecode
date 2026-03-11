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
export { checkSentinelReadiness, waitForSentinelReadiness, } from './sentinel-gate.js';
export type { SentinelReadinessOptions, SentinelGateResult, SentinelWaitOptions, SentinelWaitResult, } from './sentinel-gate.js';
export type { CliAgentType, CliAgentContract, WorkerLaunchConfig } from './model-contract.js';
export { getContract, isCliAvailable as isCliAvailableForAgent, validateCliAvailable as validateCliAvailableForAgent, buildLaunchArgs, buildWorkerCommand, parseCliOutput, shouldLoadShellRc, validateCliBinaryPath, resolveCliBinaryPath, clearResolvedPathCache, } from './model-contract.js';
export type { CliBinaryValidation } from './model-contract.js';
export type { CliInfo } from './cli-detection.js';
export { detectCli, detectAllClis } from './cli-detection.js';
export type { WorkerBootstrapParams } from './worker-bootstrap.js';
export { generateWorkerOverlay, composeInitialInbox, appendToInbox, getWorkerEnv, ensureWorkerStateDir, writeWorkerOverlay, } from './worker-bootstrap.js';
export { sendTmuxTrigger, queueInboxInstruction, queueDirectMessage, queueBroadcastMessage, readMailbox, } from './tmux-comm.js';
export { LayoutStabilizer } from './layout-stabilizer.js';
export type { LayoutStabilizerOptions } from './layout-stabilizer.js';
export type { TeamPhase, PhaseableTask } from './phase-controller.js';
export { inferPhase, getPhaseTransitionLog, isTerminalPhase } from './phase-controller.js';
export type { TeamConfig, TeamRuntime, WorkerStatus as RuntimeWorkerStatus, TeamSnapshot, WatchdogCompletionEvent, } from './runtime.js';
export { startTeam, monitorTeam, assignTask, shutdownTeam, resumeTeam, watchdogCliWorkers } from './runtime.js';
export { injectToLeaderPane } from './tmux-session.js';
export { TEAM_API_OPERATIONS, LEGACY_TEAM_MCP_TOOLS, resolveTeamApiOperation, executeTeamApiOperation, buildLegacyTeamDeprecationHint, } from './api-interop.js';
export type { TeamApiOperation, TeamApiEnvelope } from './api-interop.js';
export { isScalingEnabled, scaleUp, scaleDown, } from './scaling.js';
export type { ScaleUpResult, ScaleDownResult, ScaleError, ScaleDownOptions } from './scaling.js';
export { checkLeaderStaleness, maybeNudgeLeader } from '../hooks/team-leader-nudge-hook.js';
export type { TmuxRunner } from '../hooks/team-leader-nudge-hook.js';
export { TEAM_NAME_SAFE_PATTERN, WORKER_NAME_SAFE_PATTERN, TASK_ID_SAFE_PATTERN, TEAM_TASK_STATUSES, TEAM_TERMINAL_TASK_STATUSES, TEAM_TASK_STATUS_TRANSITIONS, TEAM_EVENT_TYPES, TEAM_TASK_APPROVAL_STATUSES, isTerminalTeamTaskStatus, canTransitionTeamTaskStatus, } from './contracts.js';
export type { TeamTaskStatus, TeamEventType, TeamTaskApprovalStatus, } from './contracts.js';
export type { TeamTask, TeamTaskV2, TeamTaskClaim, TeamLeader, TeamTransportPolicy, TeamGovernance, TeamPolicy, PermissionsSnapshot, TeamManifestV2, WorkerInfo, TeamConfig as TeamConfigV2, TeamDispatchRequestKind, TeamDispatchRequestStatus, TeamDispatchTransportPreference, TeamDispatchRequest, TeamDispatchRequestInput, TeamEvent, TeamMailboxMessage, TeamMailbox, TaskApprovalRecord, TaskReadiness, ClaimTaskResult, TransitionTaskResult, ReleaseTaskClaimResult, TeamSummary, TeamSummaryPerformance, ShutdownAck, TeamMonitorSnapshotState, TeamPhaseState, WorkerStatus as TeamWorkerStatus, WorkerHeartbeat as TeamWorkerHeartbeat, } from './types.js';
export { DEFAULT_TEAM_TRANSPORT_POLICY, DEFAULT_TEAM_GOVERNANCE, normalizeTeamTransportPolicy, normalizeTeamGovernance, normalizeTeamManifest, getConfigGovernance, } from './governance.js';
//# sourceMappingURL=index.d.ts.map