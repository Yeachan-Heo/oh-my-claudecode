// src/team/index.ts
/**
 * Team Module - Barrel Export (the `oh-my-claude-sisyphus/team` package entry)
 */
export { validateTmux, sanitizeName, sessionName, isSessionAlive, listActiveSessions, } from './tmux-session.js';
export { createWorkerWorktree, removeWorkerWorktree, listTeamWorktrees, cleanupTeamWorktrees, } from './git-worktree.js';
export { checkMergeConflicts, mergeWorkerBranch, mergeAllWorkerBranches, } from './merge-coordinator.js';
export { TeamPaths, absPath, teamStateRoot } from './state-paths.js';
export { checkSentinelReadiness, waitForSentinelReadiness, } from './sentinel-gate.js';
export { getContract, isCliAvailable as isCliAvailableForAgent, validateCliAvailable as validateCliAvailableForAgent, buildLaunchArgs, buildWorkerCommand, parseCliOutput, 
// Deprecated backward-compat exports kept for downstream consumers.
shouldLoadShellRc, validateCliBinaryPath, resolveCliBinaryPath, clearResolvedPathCache, } from './model-contract.js';
export { detectCli, detectAllClis } from './cli-detection.js';
export { generateWorkerOverlay, composeInitialInbox, appendToInbox, getWorkerEnv, ensureWorkerStateDir, writeWorkerOverlay, } from './worker-bootstrap.js';
export { prepareWorkerLaunchAttempt, loadWorkerLaunchAttempt, loadCurrentWorkerLaunchAttempt, buildWorkerLaunchBootstrapSpec, revokeWorkerLaunchAttempt, awaitWorkerLaunchAcknowledgement, isWorkerLaunchAttemptAccepted, runWorkerLaunchBootstrap, isWorkerLaunchProviderStarted, isWorkerLaunchAttemptCurrent, withWorkerLaunchAttemptFence, buildProviderSpawnInvocation, buildProviderSpawnEnvironment, } from './worker-launch-ack.js';
// Deprecated backward-compat exports for older layout APIs.
export { LayoutStabilizer } from './layout-stabilizer.js';
export { inferPhase, getPhaseTransitionLog, isTerminalPhase } from './phase-controller.js';
export { startTeam, monitorTeam, shutdownTeam, resumeTeam } from './runtime.js';
export { setRuntimeOwnerRecoveryClient, recoverDeadWorkerV2, readRecoverDeadWorkerV2Outcome, readRecoverDeadWorkerV2Result, } from './runtime-v2.js';
export { teamPublishTaskRecoveryCheckpoint } from './team-ops.js';
export { injectToLeaderPane } from './tmux-session.js';
// api-interop (CLI API for workers)
export { TEAM_API_OPERATIONS, LEGACY_TEAM_MCP_TOOLS, resolveTeamApiOperation, executeTeamApiOperation, buildLegacyTeamDeprecationHint, } from './api-interop.js';
// scaling (dynamic worker scaling)
export { isScalingEnabled, scaleUp, scaleDown, } from './scaling.js';
// team-leader-nudge-hook
export { checkLeaderStaleness, maybeNudgeLeader } from '../hooks/team-leader-nudge-hook.js';
// contracts
export { TEAM_NAME_SAFE_PATTERN, WORKER_NAME_SAFE_PATTERN, TASK_ID_SAFE_PATTERN, TEAM_TASK_STATUSES, TEAM_TERMINAL_TASK_STATUSES, TEAM_TASK_STATUS_TRANSITIONS, TEAM_EVENT_TYPES, TEAM_TASK_APPROVAL_STATUSES, isTerminalTeamTaskStatus, canTransitionTeamTaskStatus, } from './contracts.js';
export { DEFAULT_TEAM_TRANSPORT_POLICY, DEFAULT_TEAM_GOVERNANCE, normalizeTeamTransportPolicy, normalizeTeamGovernance, normalizeTeamManifest, getConfigGovernance, } from './governance.js';
//# sourceMappingURL=index.js.map