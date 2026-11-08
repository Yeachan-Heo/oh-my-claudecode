// src/team/index.ts

/**
 * Team Module - Barrel Export (the `oh-my-claude-sisyphus/team` package entry)
 */

export {
  validateTmux,
  sanitizeName,
  sessionName,
  isSessionAlive,
  listActiveSessions,
} from './tmux-session.js';

export {
  createWorkerWorktree,
  removeWorkerWorktree,
  listTeamWorktrees,
  cleanupTeamWorktrees,
} from './git-worktree.js';

export type { WorktreeInfo } from './git-worktree.js';

export {
  checkMergeConflicts,
  mergeWorkerBranch,
  mergeAllWorkerBranches,
} from './merge-coordinator.js';

export type { MergeResult } from './merge-coordinator.js';

export { TeamPaths, absPath, teamStateRoot } from './state-paths.js';

export {
  checkSentinelReadiness,
  waitForSentinelReadiness,
} from './sentinel-gate.js';

export type {
  SentinelReadinessOptions,
  SentinelGateResult,
  SentinelWaitOptions,
  SentinelWaitResult,
} from './sentinel-gate.js';

// New tmux-based multi-CLI team modules
// model-contract: getWorkerEnv is exported via worker-bootstrap (single source of truth)
export type { CliAgentType, CliAgentContract, WorkerLaunchConfig } from './model-contract.js';
export {
  getContract,
  isCliAvailable as isCliAvailableForAgent,
  validateCliAvailable as validateCliAvailableForAgent,
  buildLaunchArgs,
  buildWorkerCommand,
  parseCliOutput,
  // Deprecated backward-compat exports kept for downstream consumers.
  shouldLoadShellRc,
  validateCliBinaryPath,
  resolveCliBinaryPath,
  clearResolvedPathCache,
} from './model-contract.js';
export type { CliBinaryValidation } from './model-contract.js';

// cli-detection: only export symbols not already covered by model-contract
export type { CliInfo } from './cli-detection.js';
export { detectCli, detectAllClis } from './cli-detection.js';

// worker-bootstrap
export type { WorkerBootstrapParams } from './worker-bootstrap.js';
export {
  generateWorkerOverlay,
  composeInitialInbox,
  appendToInbox,
  getWorkerEnv,
  ensureWorkerStateDir,
  writeWorkerOverlay,
} from './worker-bootstrap.js';

export type {
  WorkerLaunchAttempt,
  WorkerLaunchBootstrapSpec,
  WorkerLaunchAcceptance,
  WorkerLaunchBootstrapResult,
  WorkerLaunchContext,
  ProviderSpawnInvocation,
} from './worker-launch-ack.js';
export {
  prepareWorkerLaunchAttempt,
  loadWorkerLaunchAttempt,
  loadCurrentWorkerLaunchAttempt,
  buildWorkerLaunchBootstrapSpec,
  revokeWorkerLaunchAttempt,
  awaitWorkerLaunchAcknowledgement,
  isWorkerLaunchAttemptAccepted,
  runWorkerLaunchBootstrap,
  isWorkerLaunchProviderStarted,
  isWorkerLaunchAttemptCurrent,
  withWorkerLaunchAttemptFence,
  buildProviderSpawnInvocation,
  buildProviderSpawnEnvironment,
} from './worker-launch-ack.js';

// Deprecated backward-compat exports for older layout APIs.
export { LayoutStabilizer } from './layout-stabilizer.js';
export type { LayoutStabilizerOptions } from './layout-stabilizer.js';

// phase-controller
export type { TeamPhase, PhaseableTask } from './phase-controller.js';
export { inferPhase, getPhaseTransitionLog, isTerminalPhase } from './phase-controller.js';

// runtime
export type {
  TeamConfig,
  TeamRuntime,
  WorkerStatus as RuntimeWorkerStatus,
  TeamSnapshot,
} from './runtime.js';
export { startTeam, monitorTeam, shutdownTeam, resumeTeam } from './runtime.js';
export {
  setRuntimeOwnerRecoveryClient,
  recoverDeadWorkerV2,
  readRecoverDeadWorkerV2Outcome,
  readRecoverDeadWorkerV2Result,
} from './runtime-v2.js';
export type {
  RecoverDeadWorkerV2Options,
  RuntimeOwnerRecoveryClient,
} from './runtime-v2.js';
export type {
  RecoverDeadWorkerV2Error,
  RecoverDeadWorkerV2Result,
  RecoverDeadWorkerV2Success,
  RecoverDeadWorkerV2Failure,
} from './types.js';
export type {
  RecoveryDurableOutcome,
  RecoveryOutcomePending,
  RecoveryOutcomeFinal,
} from './recovery-request-store.js';

export { teamPublishTaskRecoveryCheckpoint } from './team-ops.js';
export type { PublishTaskRecoveryCheckpointInput, PublishTaskRecoveryCheckpointResult } from './task-recovery-checkpoint.js';

export { injectToLeaderPane } from './tmux-session.js';

// api-interop (CLI API for workers)
export {
  TEAM_API_OPERATIONS,
  LEGACY_TEAM_MCP_TOOLS,
  resolveTeamApiOperation,
  executeTeamApiOperation,
  buildLegacyTeamDeprecationHint,
} from './api-interop.js';

export type { TeamApiOperation, TeamApiEnvelope } from './api-interop.js';

// scaling (dynamic worker scaling)
export {
  isScalingEnabled,
  scaleUp,
  scaleDown,
} from './scaling.js';

export type { ScaleUpResult, ScaleDownResult, ScaleError, ScaleDownOptions } from './scaling.js';

// team-leader-nudge-hook
export { checkLeaderStaleness, maybeNudgeLeader } from '../hooks/team-leader-nudge-hook.js';
export type { TmuxRunner } from '../hooks/team-leader-nudge-hook.js';

// contracts
export {
  TEAM_NAME_SAFE_PATTERN,
  WORKER_NAME_SAFE_PATTERN,
  TASK_ID_SAFE_PATTERN,
  TEAM_TASK_STATUSES,
  TEAM_TERMINAL_TASK_STATUSES,
  TEAM_TASK_STATUS_TRANSITIONS,
  TEAM_EVENT_TYPES,
  TEAM_TASK_APPROVAL_STATUSES,
  isTerminalTeamTaskStatus,
  canTransitionTeamTaskStatus,
} from './contracts.js';

export type {
  TeamTaskStatus,
  TeamEventType,
  TeamTaskApprovalStatus,
} from './contracts.js';

// OMX-aligned types
export type {
  TeamTask,
  TeamTaskV2,
  TeamTaskClaim,
  TeamLeader,
  TeamTransportPolicy,
  TeamGovernance,
  TeamPolicy,
  PermissionsSnapshot,
  TeamManifestV2,
  WorkerInfo,
  TeamConfig as TeamConfigV2,
  TeamDispatchRequestKind,
  TeamDispatchRequestStatus,
  TeamDispatchTransportPreference,
  TeamDispatchRequest,
  TeamDispatchRequestInput,
  TeamEvent,
  TeamMailboxMessage,
  TeamMailbox,
  TaskApprovalRecord,
  TaskReadiness,
  ClaimTaskResult,
  TransitionTaskResult,
  ReleaseTaskClaimResult,
  TeamSummary,
  TeamSummaryPerformance,
  ShutdownAck,
  TeamMonitorSnapshotState,
  TeamPhaseState,
  WorkerStatus as TeamWorkerStatus,
  WorkerHeartbeat as TeamWorkerHeartbeat,
} from './types.js';

export {
  DEFAULT_TEAM_TRANSPORT_POLICY,
  DEFAULT_TEAM_GOVERNANCE,
  normalizeTeamTransportPolicy,
  normalizeTeamGovernance,
  normalizeTeamManifest,
  getConfigGovernance,
} from './governance.js';
