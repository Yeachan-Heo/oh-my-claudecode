/**
 * State Management MCP Tools
 *
 * Provides tools for reading, writing, and managing mode state files.
 * All paths are validated to stay within the worktree boundary.
 */
import { z } from 'zod';
import { createHash } from 'crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync, constants as fsConstants } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import {
  resolveStatePath,
  ensureOmcDir,
  resolveStateWorkingDirectory,
  isSensitiveStateLocation,
  probeGitTopLevel,
  resolveSessionStatePath,
  resolveSessionStatePaths,
  ensureSessionStateDir,
  listSessionIds,
  validateSessionId,
  getOmcRoot,
  findGitMetadataDir,
  OmcPaths,
} from '../lib/worktree-paths.js';
import { resolveSessionId } from '../lib/session-id.js';
import { validatePayload } from '../lib/payload-limits.js';
import {
  canClearStateForSession,
  findCompletedSessionStateFiles,
  findCompletedSessionStateCandidates,
  findSessionOwnedStateCandidates,
  type StateFileDiscovery,
  getStateSessionOwner,
  writeStateFileLocked,
  writeStateFileLockedIf,
  writeStateFileLockedCreateIf,
  withStateFileMutationLock,
  clearStateFileLockedIf,
  emergencyMutateStateFileIf,
  recoverEmergencyStateFile,
  getStateMutationLockDiagnostic,
  getStateMutationLockFailureMessage,
} from '../lib/mode-state-io.js';
import {
  isModeActive,
  getActiveModes,
  getAllModeStatuses,
  clearModeState,
  getStateFilePath,
  MODE_CONFIGS,
  getActiveSessionsForMode,
  type ExecutionMode
} from '../hooks/mode-registry/index.js';
import { atomicWriteJsonSync } from '../lib/atomic-write.js';
import { ToolDefinition } from './types.js';
import { namedWorkflowRuntimeSupported, validateNamedWorkflowStateStructure } from '../hooks/autopilot/named-workflow-resume-validator.js';
import { cancelMergeReadiness, createInitialMergeReadinessState, readMergeReadinessState, setMergeReadinessContent, recordMergeReadinessMCQAnswer } from '../hooks/merge-readiness/runtime.js';
import { withProcessIdentityFileLock, withProcessIdentityFileLockSync } from '../team/process-identity-lock.js';

const MAX_MIGRATION_FILE_BYTES = 1_048_576;

function ensureMigrationDirectoryTree(root: string, target: string): void {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  const suffix = relative(rootResolved, targetResolved);
  if (suffix.startsWith('..') || isAbsolute(suffix)) {
    throw new Error('state_migrate_non_git refuses a destination outside the canonical root');
  }
  if (!existsSync(rootResolved)) mkdirSync(rootResolved, { recursive: true });
  const rootStat = lstatSync(rootResolved);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('state_migrate_non_git refuses symlinked migration roots');
  }
  let cursor = rootResolved;
  for (const segment of suffix.split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (existsSync(cursor)) {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('state_migrate_non_git refuses symlinked migration roots');
      }
      continue;
    }
    mkdirSync(cursor);
    const created = lstatSync(cursor);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error('state_migrate_non_git refuses symlinked migration roots');
    }
  }
}
import { formatMergeReadinessReport, redactMergeReadinessState } from '../hooks/merge-readiness/report.js';
import type { AutopilotState } from '../hooks/autopilot/types.js';

// Canonical execution modes from mode-registry (deep-interview and self-improve
// are first-class modes with dedicated MODE_CONFIGS entries; ralplan remains an
// extra state-only mode handled via the registry-fallback path).
const EXECUTION_MODES: [string, ...string[]] = [
  'autopilot', 'autoresearch', 'team', 'ralph', 'deep-interview', 'self-improve'
];

// ultrawork and ultraqa were retired; their state stays read/clear-eligible for
// bounded cleanup of pre-existing retired state, but is not write-eligible.
const RETIRED_STATE_MODES: [string, ...string[]] = ['ultrawork', 'ultraqa'];

// merge-readiness is read/clear-eligible (state_read/status/clear + /cancel work) but NOT write-eligible.
const STATE_TOOL_MODES: [string, ...string[]] = [
  ...EXECUTION_MODES,
  ...RETIRED_STATE_MODES,
  'ralplan',
  'omc-teams',
  'skill-active',
  'merge-readiness',
  // Runtime guard mode for $ultragoal; not MODE_CONFIGS-backed (#3630).
  'ultragoal',
];
// Modes that may be generically written via state_write. Excludes merge-readiness (runtime-owned).
const STATE_WRITE_MODES: [string, ...string[]] = [
  ...EXECUTION_MODES,
  'ralplan',
  'omc-teams',
  'skill-active'
];
const EXTRA_STATE_ONLY_MODES = ['ralplan', 'omc-teams', 'skill-active', 'ultragoal'] as const;
type StateToolMode = typeof STATE_TOOL_MODES[number];
const CANCEL_SIGNAL_TTL_MS = 30_000;
const OWNER_SESSION_FALLBACK_MODES = new Set<StateToolMode>(['ralph']);
const CONVERGED_STATE_PATH_MODES = new Set<StateToolMode>(['ralph', 'ultrawork']);
const RETIRED_WORKFLOW_MODES = new Set<StateToolMode>(['ultrawork']);

function isRetiredWorkflowMode(mode: string): boolean {
  return RETIRED_WORKFLOW_MODES.has(mode as StateToolMode);
}

function getStateFileName(mode: StateToolMode): string {
  const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;
  return `${normalizedName}.json`;
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function omitUndefinedFields(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

type TeamStateMutationResult = 'written' | 'corrupt' | 'foreign' | 'failed';
type TeamStateMutationOutcome = {
  result: TeamStateMutationResult;
  state?: Record<string, unknown>;
  error?: unknown;
};

function teamStateLockPath(statePath: string): string {
  return `${statePath}.team-state.lock`;
}

/**
 * Team state is updated incrementally by the resume/monitor boundary. Keep
 * that update inside the portable Team lock and the canonical mode-state
 * mutation lock so a clear cannot remove the file between the read and
 * publication, even on platforms without flock.
 */
async function writeTeamState(
  statePath: string,
  sessionId: string | undefined,
  patch: Record<string, unknown>,
): Promise<TeamStateMutationOutcome> {
  return withProcessIdentityFileLock(teamStateLockPath(statePath), () => {
    if (!recoverEmergencyStateFile(statePath)) {
      const existing = existsSync(statePath) ? readJsonRecordStrict(statePath) : undefined;
      if (existing === null) return { result: 'corrupt' };
      if (sessionId && existing && getStateSessionOwner(existing) !== undefined && getStateSessionOwner(existing) !== sessionId) {
        return { result: 'foreign' };
      }
      return { result: 'failed' };
    }

    const transaction = withStateFileMutationLock(statePath, () => {
      if (!existsSync(statePath)) {
        try {
          atomicWriteJsonSync(statePath, patch);
          return { result: 'written' as const, state: patch };
        } catch (error) {
          return { result: 'failed' as const, error };
        }
      }

      const current = readJsonRecordStrict(statePath);
      if (current === null) return { result: 'corrupt' as const };
      if (sessionId) {
        const ownerSessionId = getStateSessionOwner(current);
        if (ownerSessionId && ownerSessionId !== sessionId) return { result: 'foreign' as const };
      }

      const merged = {
        ...current,
        ...patch,
        _meta: {
          ...(isJsonRecord(current._meta) ? current._meta : {}),
          ...(isJsonRecord(patch._meta) ? patch._meta : {}),
        },
      };
      try {
        atomicWriteJsonSync(statePath, merged);
        return { result: 'written' as const, state: merged };
      } catch (error) {
        return { result: 'failed' as const, error };
      }
    });

    return transaction.acquired
      ? transaction.value ?? { result: 'failed' }
      : { result: 'failed' };
  });
}

/** Distinguishes a missing file from malformed or non-object JSON. */
function readJsonRecordStrict(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const NAMED_WORKFLOW_MARKERS = ['workflow', 'workflowRunId', 'pipelineTracking'] as const;

function hasOwnProperty(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Any own named-workflow marker, including a falsy value, makes the record runtime-owned. */
function hasNamedWorkflowMarker(record: Record<string, unknown> | null | undefined): boolean {
  if (!record) return false;
  return NAMED_WORKFLOW_MARKERS.some((marker) => hasOwnProperty(record, marker));
}

function hasValidatedNamedWorkflowTuple(record: Record<string, unknown>): boolean {
  if (!NAMED_WORKFLOW_MARKERS.every((marker) => hasOwnProperty(record, marker))) return false;
  const sessionId = getStateSessionOwner(record);
  return typeof sessionId === 'string' && validateNamedWorkflowStateStructure(record as unknown as AutopilotState, sessionId) !== null;
}

/** The portable emergency path may only pause or clear an exact discovered run. */
function isExactEmergencyNamedMutation(
  record: Record<string, unknown>,
  requestedRunId: string | undefined,
): boolean {
  return hasValidatedNamedWorkflowTuple(record) &&
    typeof requestedRunId === 'string' &&
    record.workflowRunId === requestedRunId;
}

/** A named pause request is an exact capability, not a state replay payload. */
function isExactNamedPauseRequest(record: Record<string, unknown>): boolean {
  const allowed = new Set(['active', 'workflowRunId', 'target_state_sha256']);
  return record.active === false &&
    typeof record.workflowRunId === 'string' &&
    Object.keys(record).every((key) => allowed.has(key)) &&
    (!hasOwnProperty(record, 'target_state_sha256') ||
      (typeof record.target_state_sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.target_state_sha256)));
}

function matchesNamedPauseTarget(
  current: Record<string, unknown>,
  sessionId: string | undefined,
  workflowRunId: string,
  stateDigest: string | undefined,
): boolean {
  return current.active === true &&
    current.workflowRunId === workflowRunId &&
    hasValidatedNamedWorkflowTuple(current) &&
    getStateSessionOwner(current) === sessionId &&
    (stateDigest === undefined || createHash('sha256').update(JSON.stringify(current)).digest('hex') === stateDigest);
}
function listSessionIdsUnderOmcRoot(omcRoot: string): string[] {
  const sessionsDir = join(omcRoot, 'state', 'sessions');
  if (!existsSync(sessionsDir)) {
    return [];
  }

  try {
    return readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(name));
  } catch {
    return [];
  }
}

function getConvergedOmcRoots(root: string): string[] {
  const canonicalRoot = getOmcRoot(root);
  if (process.env.OMC_STATE_DIR) return [canonicalRoot];
  if (probeGitTopLevel(root).status !== 'ok') return [canonicalRoot];

  const roots = new Set<string>([canonicalRoot]);
  roots.add(join(root, OmcPaths.ROOT));
  roots.add(join(homedir(), OmcPaths.ROOT));
  return [...roots];
}

function getConvergedStateCandidates(
  mode: StateToolMode,
  root: string,
  sessionId?: string,
): string[] {
  if (!CONVERGED_STATE_PATH_MODES.has(mode)) {
    return [];
  }

  const filename = getStateFileName(mode);
  const paths = new Set<string>();

  for (const omcRoot of getConvergedOmcRoots(root)) {
    const stateDir = join(omcRoot, 'state');
    if (sessionId) {
      paths.add(join(stateDir, 'sessions', sessionId, filename));
      for (const sid of listSessionIdsUnderOmcRoot(omcRoot)) {
        const candidatePath = join(stateDir, 'sessions', sid, filename);
        const raw = readJsonRecord(candidatePath);
        if (raw && getStateSessionOwner(raw) === sessionId) {
          paths.add(candidatePath);
        }
      }
    } else {
      for (const sid of listSessionIdsUnderOmcRoot(omcRoot)) {
        paths.add(join(stateDir, 'sessions', sid, filename));
      }
    }

    paths.add(join(stateDir, filename));
    paths.add(join(omcRoot, filename));
  }

  return [...paths];
}

function isConvergedCandidateActiveForSession(statePath: string, sessionId?: string): boolean {
  const raw = readJsonRecord(statePath);
  if (!raw || raw.active !== true) {
    return false;
  }
  if (!sessionId) {
    return true;
  }
  return canClearStateForSession(raw, sessionId);
}
function emergencyRecoveryOptionsForProject(mode: StateToolMode, path: string, root: string): { authorizeState: (state: Record<string, unknown>) => boolean } | undefined {
  if (mode !== 'autopilot' || !isSharedHomeAutopilotCandidate(path, root)) return undefined;
  return { authorizeState: (state) => isStateCandidateForProject(mode, path, state, root) };
}

function clearDiscoveredStateCandidate(
  candidate: StateFileDiscovery,
  predicate: (state: Record<string, unknown>) => boolean,
  recoveryOptions?: { authorizeState: (state: Record<string, unknown>) => boolean },
  teamState = false,
): 'cleared' | 'skipped' | 'failed' {
  const sessionPathMatch = candidate.path.replaceAll('\\', '/').match(/\/state\/sessions\/([^/]+)\/[^/]+$/);
  const pathSessionId = sessionPathMatch?.[1];
  const ownerSessionId = candidate.completedSessionId ?? candidate.ownerSessionId;
  const ownerRecovery = ownerSessionId && ownerSessionId !== pathSessionId
    ? { authorizeState: (state: Record<string, unknown>) => getStateSessionOwner(state) === ownerSessionId }
    : undefined;
  const effectiveRecovery = ownerRecovery && recoveryOptions
    ? { authorizeState: (state: Record<string, unknown>) => ownerRecovery.authorizeState(state) && recoveryOptions.authorizeState(state) }
    : ownerRecovery ?? recoveryOptions;
  const clear = (): 'cleared' | 'skipped' | 'failed' => clearStateFileLockedIf(
    candidate.path,
    (current) => predicate(current) && JSON.stringify(current) === candidate.snapshot,
    effectiveRecovery,
  );
  if (!teamState) return clear();
  try {
    return withProcessIdentityFileLockSync(teamStateLockPath(candidate.path), clear);
  } catch {
    return 'failed';
  }
}

function isStateCandidateForMode(mode: StateToolMode, candidate: StateFileDiscovery): boolean {
  // mode-state-io intentionally keeps its historical permissive JSON cast.
  // Team state has a stricter publication contract: arrays and null are
  // corrupt bytes, never deletion candidates.
  return mode !== 'team' || isJsonRecord(candidate.state);
}

function clearAutopilotMarkerCandidate(candidate: StateFileDiscovery, root: string): boolean {
  // A marker-bearing record may be malformed, but a clear is an exact deletion
  // capability over the discovered bytes after ownership/project filtering.
  // It must never become a pause, resume, or replacement write.
  const predicate = (current: Record<string, unknown>) =>
    isStateCandidateForProject('autopilot', candidate.path, current, root) &&
    JSON.stringify(current) === candidate.snapshot;
  const sessionPathMatch = candidate.path.replaceAll('\\', '/').match(/\/state\/sessions\/([^/]+)\/[^/]+$/);
  const pathSessionId = sessionPathMatch?.[1];
  const ownerSessionId = candidate.completedSessionId ?? candidate.ownerSessionId;
  const projectRecovery = emergencyRecoveryOptionsForProject('autopilot', candidate.path, root);
  const recoveryOptions = ownerSessionId && ownerSessionId !== pathSessionId
    ? { authorizeState: (state: Record<string, unknown>) => isStateCandidateForProject('autopilot', candidate.path, state, root) && getStateSessionOwner(state) === ownerSessionId }
    : projectRecovery;

  if (!namedWorkflowRuntimeSupported()) {
    return emergencyMutateStateFileIf(
      candidate.path,
      predicate,
      null,
      recoveryOptions,
    );
  }

  return clearStateFileLockedIf(
    candidate.path,
    predicate,
    recoveryOptions,
  ) === 'cleared';
}

function discoverStatePaths(paths: string[], mode?: StateToolMode): StateFileDiscovery[] {
  const discovered: StateFileDiscovery[] = [];
  for (const path of paths) {
    const state = readJsonRecord(path);
    if (!state || (mode === 'team' && !isJsonRecord(state))) continue;
    discovered.push({
      path,
      state,
      snapshot: JSON.stringify(state),
      ownerSessionId: getStateSessionOwner(state),
      workflowRunId: typeof state.workflowRunId === 'string' ? state.workflowRunId : undefined,
    });
  }
  return discovered;
}

type CandidateClearPredicate = (
  candidate: StateFileDiscovery,
  current: Record<string, unknown>,
) => boolean;

type CandidateRecovery = (
  candidate: StateFileDiscovery,
) => { authorizeState: (state: Record<string, unknown>) => boolean } | undefined;

type TeamCleanupBookkeeping = {
  teamNames: Set<string>;
  blockedNames: Set<string>;
  clearedSessions: Set<string>;
  requesterSessionId?: string;
};

function teamSessionIdForCandidate(
  candidate: StateFileDiscovery,
  fallbackSessionId?: string,
): string | undefined {
  const pathSessionId = candidate.path.replaceAll('\\', '/').match(/\/state\/sessions\/([^/]+)\/[^/]+$/)?.[1];
  if (candidate.completedSessionId || candidate.completionEvidencePath) {
    return candidate.completedSessionId ?? candidate.ownerSessionId ?? pathSessionId ?? fallbackSessionId;
  }
  return fallbackSessionId ?? pathSessionId ?? candidate.ownerSessionId;
}

function teamNameAuthorizationSessionId(
  candidate: StateFileDiscovery,
  requesterSessionId?: string,
): string | undefined {
  return candidate.completedSessionId
    ?? (candidate.completionEvidencePath ? candidate.ownerSessionId : requesterSessionId);
}

function clearStateCandidates(
  mode: StateToolMode,
  discovered: StateFileDiscovery[],
  predicate: CandidateClearPredicate,
  recovery: CandidateRecovery | undefined,
  teamCleanup?: TeamCleanupBookkeeping,
): { cleared: number; hadFailure: boolean } {
  let cleared = 0;
  let hadFailure = false;
  for (const candidate of discovered) {
    if (!isStateCandidateForMode(mode, candidate)) continue;
    const result = clearDiscoveredStateCandidate(
      candidate,
      (current) => predicate(candidate, current),
      recovery?.(candidate),
      mode === 'team',
    );
    if (result === 'cleared') {
      if (mode === 'team' && teamCleanup) {
        const ownerSessionId = teamSessionIdForCandidate(candidate, teamCleanup.requesterSessionId);
        for (const teamName of readTeamNamesFromState(
          candidate.state,
          teamNameAuthorizationSessionId(candidate, teamCleanup.requesterSessionId),
        )) {
          teamCleanup.teamNames.add(teamName);
        }
        if (ownerSessionId) teamCleanup.clearedSessions.add(ownerSessionId);
      }
      cleared++;
    } else {
      if (result === 'failed') hadFailure = true;
      recordTeamClearFailure(mode, candidate, result, teamCleanup);
    }
  }
  return { cleared, hadFailure };
}

function clearConvergedStateCandidates(
  mode: StateToolMode,
  root: string,
  sessionId?: string,
  discovered = discoverStatePaths(getConvergedStateCandidates(mode, root, sessionId), mode),
  teamCleanup?: TeamCleanupBookkeeping,
): { cleared: number; hadFailure: boolean } {
  return clearStateCandidates(
    mode,
    discovered,
    (candidate, current) => isStateCandidateForProject(mode, candidate.path, current, root) &&
      (!sessionId || canClearStateForSession(current, sessionId)),
    undefined,
    teamCleanup,
  );
}

function hasActiveConvergedState(mode: StateToolMode, root: string, sessionId?: string): boolean {
  return getConvergedStateCandidates(mode, root, sessionId)
    .some((statePath) => isConvergedCandidateActiveForSession(statePath, sessionId));
}
function readTeamNamesFromState(state: Record<string, unknown>, sessionId?: string): string[] {
  if (sessionId && !canClearStateForSession(state, sessionId)) return [];
  const teamName = typeof state.team_name === 'string'
    ? state.team_name.trim()
    : typeof state.teamName === 'string'
      ? state.teamName.trim()
      : '';
  return teamName ? [teamName] : [];
}

function recordTeamClearFailure(
  mode: StateToolMode,
  candidate: StateFileDiscovery,
  result: 'cleared' | 'skipped' | 'failed',
  teamCleanup?: TeamCleanupBookkeeping,
): void {
  if (mode !== 'team' || !teamCleanup || result === 'cleared' || !existsSync(candidate.path)) return;
  // A surviving foreign state must protect its runtime even though this
  // caller has no authority to delete that state.
  for (const teamName of readTeamNamesFromState(candidate.state)) teamCleanup.blockedNames.add(teamName);
}

function blockForeignTeamPrimary(
  root: string,
  requesterSessionId: string | undefined,
  teamCleanup: TeamCleanupBookkeeping,
): void {
  // Candidate discovery intentionally omits a foreign canonical primary;
  // observe it separately so legacy cleanup cannot tear down its runtime.
  if (!requesterSessionId) return;
  const statePath = getSessionStatePath('team', root, requesterSessionId);
  const state = readJsonRecordStrict(statePath);
  if (!state) return;
  const ownerSessionId = getStateSessionOwner(state);
  if (ownerSessionId && ownerSessionId !== requesterSessionId) {
    for (const teamName of readTeamNamesFromState(state)) teamCleanup.blockedNames.add(teamName);
  }
}

function pruneMissionBoardTeams(root: string, teamNames?: string[]): number {
  const missionStatePath = join(getOmcRoot(root), 'state', 'mission-state.json');
  if (!existsSync(missionStatePath)) return 0;

  try {
    const parsed = JSON.parse(readFileSync(missionStatePath, 'utf-8')) as {
      updatedAt?: string;
      missions?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(parsed.missions)) return 0;

    const shouldRemoveAll = teamNames == null;
    const teamNameSet = new Set(teamNames ?? []);
    const remainingMissions = parsed.missions.filter((mission) => {
      if (mission.source !== 'team') return true;
      if (shouldRemoveAll) return false;
      const missionTeamName = typeof mission.teamName === 'string'
        ? mission.teamName.trim()
        : typeof mission.name === 'string'
          ? mission.name.trim()
          : '';
      return !missionTeamName || !teamNameSet.has(missionTeamName);
    });

    const removed = parsed.missions.length - remainingMissions.length;
    if (removed > 0) {
      writeFileSync(missionStatePath, JSON.stringify({
        ...parsed,
        updatedAt: new Date().toISOString(),
        missions: remainingMissions,
      }, null, 2));
    }

    return removed;
  } catch {
    return 0;
  }
}

function cleanupTeamRuntimeState(root: string, teamNames?: string[]): number {
  const teamStateRoot = join(getOmcRoot(root), 'state', 'team');
  if (!existsSync(teamStateRoot)) return 0;

  const shouldRemoveAll = teamNames == null;
  let removed = 0;

  if (shouldRemoveAll) {
    try {
      rmSync(teamStateRoot, { recursive: true, force: true });
      return 1;
    } catch {
      return 0;
    }
  }

  for (const teamName of teamNames ?? []) {
    if (!teamName || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(teamName)) continue;
    try {
      const teamPath = resolve(teamStateRoot, teamName);
      const withinRoot = relative(resolve(teamStateRoot), teamPath);
      if (withinRoot.startsWith(`..${sep}`) || withinRoot === '..' || isAbsolute(withinRoot)) continue;
      rmSync(teamPath, { recursive: true, force: true });
      removed += 1;
    } catch {
      // best effort
    }
  }

  return removed;
}

function formatStateClearCleanupNote(
  legacyCleared: number,
  completedCleared: number,
  sessionCleared: number,
  localCleared: number,
  convergedCleared: number,
  runtimeCleared: number,
  ownerSessionId?: string,
): string {
  const parts = [
    legacyCleared > 0 ? 'ghost legacy file also removed' : '',
    completedCleared > 0 ? `removed ${completedCleared} completed-session orphan file${completedCleared === 1 ? '' : 's'}` : '',
    sessionCleared > 0 ? `removed ${sessionCleared} recovered session file${sessionCleared === 1 ? '' : 's'}` : '',
    localCleared > 0 ? `removed ${localCleared} workingDirectory-local state file${localCleared === 1 ? '' : 's'}` : '',
    convergedCleared > 0 ? `removed ${convergedCleared} converged state file${convergedCleared === 1 ? '' : 's'}` : '',
    runtimeCleared > 0 ? `removed ${runtimeCleared} runtime artifact${runtimeCleared === 1 ? '' : 's'}` : '',
    ownerSessionId ? `cleared owning session: ${ownerSessionId}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function cleanupTeamRuntimeNote(
  mode: StateToolMode,
  root: string,
  teamCleanup: TeamCleanupBookkeeping,
): string {
  if (mode !== 'team') return '';
  const teamNames = [...teamCleanup.teamNames].filter((teamName) => !teamCleanup.blockedNames.has(teamName));
  const removedRoots = cleanupTeamRuntimeState(root, teamNames);
  const prunedMissions = pruneMissionBoardTeams(root, teamNames);
  const details = [
    removedRoots > 0 ? `removed ${removedRoots} team runtime root(s)` : '',
    prunedMissions > 0 ? `pruned ${prunedMissions} HUD mission entry(ies)` : '',
  ].filter(Boolean);
  return details.length > 0 ? ` (${details.join(', ')})` : '';
}

/**
 * Get the state file path for any mode (including swarm and ralplan).
 *
 * - For registry modes (8 modes): uses getStateFilePath from mode-registry
 * - For ralplan (not in registry): uses resolveStatePath from worktree-paths
 *
 * This handles swarm's SQLite (.db) file transparently.
 */
function getSessionStatePath(mode: StateToolMode, root: string, sessionId: string): string {
  return mode === 'team'
    ? resolveSessionStatePaths('team', sessionId, root).sessionScoped
    : MODE_CONFIGS[mode as ExecutionMode]
      ? getStateFilePath(root, mode as ExecutionMode, sessionId)
      : resolveSessionStatePath(mode, sessionId, root);
}

function clearModePrimaryWithTeamLock(
  mode: StateToolMode,
  statePath: string,
  clear: () => boolean,
  captured = true,
): boolean {
  if (mode !== 'team') return clear();
  try {
    return withProcessIdentityFileLockSync(teamStateLockPath(statePath), () =>
      captured ? clear() : !existsSync(statePath));
  } catch {
    // A busy Team primary is reported as a partial clear; other captured
    // session candidates may still be cleaned safely.
    return false;
  }
}

function getStatePath(mode: StateToolMode, root: string): string {
  if (mode === 'team') return resolveSessionStatePaths('team', undefined, root).legacy;
  if (MODE_CONFIGS[mode as ExecutionMode]) {
    return getStateFilePath(root, mode as ExecutionMode);
  }
  // Fallback for modes not in registry (e.g., ralplan)
  return resolveStatePath(mode, root);
}

function getLegacyStateFileCandidates(mode: StateToolMode, root: string): string[] {
  const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;
  const candidates = [
    getStatePath(mode, root),
    join(getOmcRoot(root), `${normalizedName}.json`),
  ];
  if (mode === 'autopilot' && probeGitTopLevel(root).status === 'ok') candidates.push(join(homedir(), '.omc', 'state', 'autopilot-state.json'));

  return [...new Set(candidates)];
}

function isSharedHomeAutopilotCandidate(path: string, root: string): boolean {
  const sharedHomeStateRoot = resolve(homedir(), '.omc', 'state');
  const candidatePath = resolve(path);
  const canonicalStateRoot = resolve(getOmcRoot(root), 'state');
  const isDescendant = (ancestor: string, descendant: string): boolean => {
    const fromAncestor = relative(ancestor, descendant);
    return fromAncestor === '' || (!fromAncestor.startsWith(`..${sep}`) && fromAncestor !== '..' && !isAbsolute(fromAncestor));
  };
  return !isDescendant(canonicalStateRoot, candidatePath) && isDescendant(sharedHomeStateRoot, candidatePath);
}

function isStateCandidateForProject(mode: StateToolMode, path: string, state: Record<string, unknown>, root: string): boolean {
  if (mode !== 'autopilot' || !isSharedHomeAutopilotCandidate(path, root)) return true;
  return typeof state.project_path === 'string' && resolve(state.project_path) === resolve(root);
}

function isAutopilotRecoveryCandidateForProject(path: string, root: string): boolean {
  if (!isSharedHomeAutopilotCandidate(path, root)) return true;

  const primary = readJsonRecord(path);
  if (primary) return isStateCandidateForProject('autopilot', path, primary, root);

  const artifactPrefix = `${basename(path)}.emergency-quarantine.`;
  let artifacts: string[];
  try {
    artifacts = readdirSync(dirname(path)).filter((name) =>
      name.startsWith(artifactPrefix) && (name.endsWith('.payload') || /^[0-9a-f-]{36}$/i.test(name.slice(artifactPrefix.length))),
    );
  } catch {
    return false;
  }
  if (artifacts.length === 0) return false;

  return artifacts.every((name) => {
    const state = readJsonRecord(join(dirname(path), name));
    return state !== null && isStateCandidateForProject('autopilot', path, state, root);
  });
}

function getWorkingDirectoryLocalOmcRoot(root: string): string {
  return join(root, OmcPaths.ROOT);
}

function shouldCheckWorkingDirectoryLocalState(root: string): boolean {
  // Non-git state uses a canonical user/central root. Do not probe or mutate
  // `{workingDirectory}/.omc` implicitly; legacy recovery requires an explicit
  // migration path so unrelated directories cannot be swept together.
  if (probeGitTopLevel(root).status !== 'ok') return false;
  return getWorkingDirectoryLocalOmcRoot(root) !== getOmcRoot(root);
}

function getWorkingDirectoryLocalSessionStatePath(mode: StateToolMode, root: string, sessionId: string): string {
  const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;
  return join(getWorkingDirectoryLocalOmcRoot(root), 'state', 'sessions', sessionId, `${normalizedName}.json`);
}

function getWorkingDirectoryLocalLegacyStateFileCandidates(mode: StateToolMode, root: string): string[] {
  const normalizedName = mode.endsWith('-state') ? mode : `${mode}-state`;
  return [
    join(getWorkingDirectoryLocalOmcRoot(root), 'state', `${normalizedName}.json`),
    join(getWorkingDirectoryLocalOmcRoot(root), `${normalizedName}.json`),
  ];
}

function getWorkingDirectoryLocalStateClearCandidates(
  mode: StateToolMode,
  root: string,
  sessionId?: string,
): string[] {
  if (!shouldCheckWorkingDirectoryLocalState(root)) {
    return [];
  }

  const paths = new Set<string>();
  if (sessionId) {
    paths.add(getWorkingDirectoryLocalSessionStatePath(mode, root, sessionId));
  }

  for (const legacyPath of getWorkingDirectoryLocalLegacyStateFileCandidates(mode, root)) {
    paths.add(legacyPath);
  }

  return [...paths];
}

function clearWorkingDirectoryLocalStateCandidates(
  mode: StateToolMode,
  root: string,
  sessionId?: string,
  discovered = discoverStatePaths(getWorkingDirectoryLocalStateClearCandidates(mode, root, sessionId), mode),
  teamCleanup?: TeamCleanupBookkeeping,
): { cleared: number; hadFailure: boolean } {
  const localLegacyPaths = new Set(getWorkingDirectoryLocalLegacyStateFileCandidates(mode, root));
  return clearStateCandidates(
    mode,
    discovered,
    (candidate, current) => !sessionId || !localLegacyPaths.has(candidate.path) || canClearStateForSession(current, sessionId),
    undefined,
    teamCleanup,
  );
}

function clearLegacyStateCandidates(
  mode: StateToolMode,
  root: string,
  sessionId?: string,
  discovered = discoverStatePaths(getLegacyStateFileCandidates(mode, root), mode),
  teamCleanup?: TeamCleanupBookkeeping,
): { cleared: number; hadFailure: boolean } {
  return clearStateCandidates(
    mode,
    discovered,
    (candidate, current) => isStateCandidateForProject(mode, candidate.path, current, root) &&
      (!sessionId || canClearStateForSession(current, sessionId)),
    (candidate) => emergencyRecoveryOptionsForProject(mode, candidate.path, root),
    teamCleanup,
  );
}

function clearSessionOwnedStateCandidates(
  mode: StateToolMode,
  root: string,
  sessionId: string,
  discovered = findSessionOwnedStateCandidates(mode, sessionId, root),
  teamCleanup?: TeamCleanupBookkeeping,
): { cleared: number; hadFailure: boolean } {
  return clearStateCandidates(
    mode,
    discovered,
    (candidate, current) => isStateCandidateForProject(mode, candidate.path, current, root) &&
      canClearStateForSession(current, sessionId),
    (candidate) => emergencyRecoveryOptionsForProject(mode, candidate.path, root),
    teamCleanup,
  );
}

function clearCompletedSessionStateCandidates(
  mode: StateToolMode,
  root: string,
  requesterSessionId?: string,
  discovered = findCompletedSessionStateCandidates(mode, root, requesterSessionId),
  teamCleanup?: TeamCleanupBookkeeping,
): { cleared: number; hadFailure: boolean } {
  return clearStateCandidates(
    mode,
    discovered,
    (candidate, current) => current.active === true &&
      candidate.ownerSessionId === candidate.completedSessionId &&
      getStateSessionOwner(current) === candidate.completedSessionId &&
      Boolean(candidate.completionEvidencePath && existsSync(candidate.completionEvidencePath)),
    (candidate) => emergencyRecoveryOptionsForProject(mode, candidate.path, root),
    teamCleanup,
  );
}
function getStateClearCheckedPaths(
  mode: StateToolMode,
  root: string,
  sessionId?: string,
): string[] {
  const paths = new Set<string>();

  if (sessionId) {
    paths.add(getSessionStatePath(mode, root, sessionId));
  } else {
    paths.add(getStatePath(mode, root));
  }

  for (const legacyPath of getLegacyStateFileCandidates(mode, root)) {
    paths.add(legacyPath);
  }

  for (const localPath of getWorkingDirectoryLocalStateClearCandidates(mode, root, sessionId)) {
    paths.add(localPath);
  }

  const sessionIds = sessionId ? [sessionId, ...listSessionIds(root)] : listSessionIds(root);
  for (const sid of new Set(sessionIds)) {
    paths.add(getSessionStatePath(mode, root, sid));
  }

  return [...paths];
}

function formatStateClearNoopMessage(
  mode: StateToolMode,
  root: string,
  sessionId?: string,
): string {
  const scope = sessionId ? ` in session: ${sessionId}` : '';
  const checkedPaths = getStateClearCheckedPaths(mode, root, sessionId);
  const checked = checkedPaths.length > 0
    ? `\n- Checked paths:\n${checkedPaths.map((statePath) => `  - ${statePath}`).join('\n')}`
    : '';

  return `No state found to clear for mode: ${mode}${scope}${checked}`;
}

type RuntimeArtifactSnapshot = { bytes: Buffer; identity: string };

function getModeRuntimeArtifactPaths(mode: StateToolMode, root: string, sessionIds?: Iterable<string>, includeLegacy = true): string[] {
  const stateRoot = join(getOmcRoot(root), 'state');
  const names = [`${mode}-stop-breaker.json`, `${mode}-last-steer-at`, `${mode}-continue-steer.lock`];
  const dirs = new Set([
    ...(includeLegacy ? [stateRoot] : []),
    ...[...(sessionIds ?? listSessionIds(root))].map((sid) => join(stateRoot, 'sessions', sid)),
  ]);
  return [...dirs].flatMap((dir) => names.map((name) => join(dir, name)));
}

function captureTeamRuntimeArtifacts(root: string): Map<string, RuntimeArtifactSnapshot> {
  const captured = new Map<string, RuntimeArtifactSnapshot>();
  for (const path of getModeRuntimeArtifactPaths('team', root)) try {
    const stat = lstatSync(path);
    if (stat.isFile()) captured.set(path, { bytes: readFileSync(path), identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` });
  } catch {
    // Missing or unreadable artifacts are not cleanup targets.
  }
  return captured;
}
function clearRuntimeArtifactPaths(paths: string[], captured?: Map<string, RuntimeArtifactSnapshot>): { cleared: number; hadFailure: boolean } {
  let cleared = 0, hadFailure = false;
  for (const artifactPath of paths) {
    const expected = captured?.get(artifactPath);
    if (!existsSync(artifactPath) || (captured && !expected)) continue;
    if (expected) {
      try {
        const stat = lstatSync(artifactPath);
        if (!stat.isFile() ||
          `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` !== expected.identity ||
          !readFileSync(artifactPath).equals(expected.bytes)) continue;
      } catch {
        continue;
      }
    }
    try { unlinkSync(artifactPath); cleared++; } catch { hadFailure = true; }
  }
  return { cleared, hadFailure };
}

function clearModeRuntimeArtifacts(
  mode: StateToolMode,
  root: string,
  sessionId?: string,
): { cleared: number; hadFailure: boolean } {
  return clearRuntimeArtifactPaths(getModeRuntimeArtifactPaths(mode, root, sessionId ? [sessionId] : undefined));
}

function clearTeamRuntimeArtifacts(
  root: string,
  sessionIds: Iterable<string>,
  captured: Map<string, RuntimeArtifactSnapshot>,
  includeLegacy = false,
): { cleared: number; hadFailure: boolean } {
  return clearRuntimeArtifactPaths(
    getModeRuntimeArtifactPaths('team', root, sessionIds, includeLegacy),
    captured,
  );
}
function writeSessionCancelSignal(
  root: string,
  sessionId: string,
  mode: StateToolMode,
  candidate?: StateFileDiscovery,
): void {
  ensureSessionStateDir(sessionId, root);
  const now = Date.now();
  const cancelSignalPath = resolveSessionStatePath('cancel-signal', sessionId, root);
  const payload = {
    active: true,
    requested_at: new Date(now).toISOString(),
    expires_at: new Date(now + CANCEL_SIGNAL_TTL_MS).toISOString(),
    mode,
    source: 'state_clear',
    ...(candidate?.workflowRunId ? { target_workflow_run_id: candidate.workflowRunId } : {}),
    ...(candidate ? { target_state_sha256: createHash('sha256').update(candidate.snapshot).digest('hex') } : {}),
  };
  if (!writeStateFileLocked(cancelSignalPath, payload)) {
    throw new Error(`${getStateMutationLockFailureMessage()} for cancel signal: ${cancelSignalPath}`);
  }
}

function isSessionModeActive(
  mode: StateToolMode,
  root: string,
  sessionId: string,
): boolean {
  if (MODE_CONFIGS[mode as ExecutionMode]) {
    return isModeActive(mode as ExecutionMode, root, sessionId);
  }

  const statePath = resolveSessionStatePath(mode, sessionId, root);
  if (!existsSync(statePath)) {
    return false;
  }

  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    return state.active === true;
  } catch {
    return false;
  }
}

function findSingleOwningSessionForMode(
  mode: StateToolMode,
  root: string,
  requesterSessionId: string,
): string | undefined {
  const owningSessions = listSessionIds(root).filter((sid) => (
    sid !== requesterSessionId && isSessionModeActive(mode, root, sid)
  ));

  return owningSessions.length === 1 ? owningSessions[0] : undefined;
}

interface WorkflowPublicState {
  name: string;
  workflowRunId?: string;
  version: number;
  shortHash: string;
  stages: string[];
  currentStage: string | null;
  status: string | null;
  progress: string;
}

function canonicalWorkflowJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalWorkflowJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalWorkflowJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isValidPublicWorkflowDescriptor(descriptor: Record<string, unknown>): boolean {
  const stages = descriptor.stages;
  if (descriptor.descriptorVersion !== 1 || descriptor.profileVersion !== 1 || typeof descriptor.workflowName !== 'string' || !Array.isArray(stages) || !stages.every(stage => typeof stage === 'string') || typeof descriptor.profileHash !== 'string') return false;
  const allowed = new Set(['ralplan,execution', 'ralplan,execution,ralph', 'ralplan,execution,qa', 'ralplan,execution,ralph,qa']);
  if (!allowed.has(stages.join(','))) return false;
  const canonical = canonicalWorkflowJson({ descriptorVersion: 1, workflowName: descriptor.workflowName, profileVersion: 1, stages });
  return createHash('sha256').update(canonical).digest('hex') === descriptor.profileHash;
}
export function redactAutopilotPublicState(state: unknown): unknown {
  if (!state || typeof state !== 'object') {
    return state;
  }
  const record = state as Record<string, unknown>;
  if (!hasNamedWorkflowMarker(record)) {
    return state;
  }
  const workflow = record.workflow;
  if (!hasValidatedNamedWorkflowTuple(record) || !workflow || typeof workflow !== 'object') {
    return { name: 'invalid', version: 1, shortHash: 'invalid', stages: [], currentStage: null, status: 'workflow_descriptor_integrity_failed', progress: '0/0' } satisfies WorkflowPublicState;
  }
  const descriptor = workflow as Record<string, unknown>;
  if (!isValidPublicWorkflowDescriptor(descriptor)) {
    return { name: 'invalid', version: 1, shortHash: 'invalid', stages: [], currentStage: null, status: 'workflow_descriptor_integrity_failed', progress: '0/0' } satisfies WorkflowPublicState;
  }
  const stages = Array.isArray(descriptor.stages) && descriptor.stages.every((stage) => typeof stage === 'string')
    ? descriptor.stages as string[]
    : [];
  const pipelineTracking = record.pipelineTracking && typeof record.pipelineTracking === 'object'
    ? record.pipelineTracking as Record<string, unknown>
    : undefined;
  const currentStageIndex = typeof pipelineTracking?.currentStageIndex === 'number'
    ? pipelineTracking.currentStageIndex
    : -1;
  const pipelineStages = Array.isArray(pipelineTracking?.stages) ? pipelineTracking.stages : [];
  const terminal = record.active === false && record.phase === 'complete' && currentStageIndex === stages.length;
  const currentPipelineStage = terminal ? undefined : pipelineStages[currentStageIndex];
  const currentStage = currentPipelineStage && typeof currentPipelineStage === 'object'
    && typeof (currentPipelineStage as Record<string, unknown>).id === 'string'
    ? (currentPipelineStage as Record<string, unknown>).id as string
    : null;
  const currentStageStatus = currentPipelineStage && typeof currentPipelineStage === 'object'
    && typeof (currentPipelineStage as Record<string, unknown>).status === 'string'
    ? (currentPipelineStage as Record<string, unknown>).status as string
    : null;
  const safeState: WorkflowPublicState = {
    name: typeof descriptor.workflowName === 'string' ? descriptor.workflowName.slice(0, 32) : 'invalid',
    workflowRunId: record.workflowRunId as string,
    version: typeof descriptor.profileVersion === 'number' ? descriptor.profileVersion : 1,
    shortHash: typeof descriptor.profileHash === 'string' ? descriptor.profileHash.slice(0, 12) : 'invalid',
    stages,
    currentStage,
    status: terminal ? 'complete' : currentStageStatus,
    progress: currentStageIndex >= 0 ? `${Math.min(currentStageIndex + 1, stages.length)}/${stages.length}` : `0/${stages.length}`,
  };
  return safeState;
}

function publicStateForMode(mode: StateToolMode, state: unknown): unknown {
  if (mode === 'autopilot') {
    return redactAutopilotPublicState(state);
  }
  return mode === 'merge-readiness'
    ? redactMergeReadinessState(state as Parameters<typeof redactMergeReadinessState>[0])
    : state;
}

// ============================================================================
// state_read - Read state for a mode
// ============================================================================

export const stateReadTool: ToolDefinition<{
  mode: z.ZodEnum<typeof STATE_TOOL_MODES>;
  workingDirectory: z.ZodOptional<z.ZodString>;
  session_id: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_read',
  description: 'Read the current state for a specific mode (ralph, ultrawork, autopilot, etc.). Returns the JSON state data or indicates if no state exists.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  schema: {
    mode: z.enum(STATE_TOOL_MODES).describe('The mode to read state for'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
  },
  handler: async (args) => {
    const { mode, workingDirectory, session_id } = args;

    try {
      const root = resolveStateWorkingDirectory(workingDirectory);
      const sessionId = session_id as string | undefined;

      // If session_id provided, read from session-scoped path
      if (sessionId) {
        validateSessionId(sessionId);
        const statePath = getSessionStatePath(mode, root, sessionId);

        if (!existsSync(statePath)) {
          const completedSessionPaths = findCompletedSessionStateFiles(mode, root, sessionId);
          if (completedSessionPaths.length > 0) {
            const orphanList = completedSessionPaths
              .map((orphanPath) => {
                const sessionMarker = `${join('state', 'sessions')}/`;
                const markerIndex = orphanPath.indexOf(sessionMarker);
                if (markerIndex === -1) return `- ${orphanPath}`;
                const rest = orphanPath.slice(markerIndex + sessionMarker.length);
                const orphanSessionId = rest.split(/[\\/]/)[0] || 'unknown';
                return `- session: ${orphanSessionId}\n  path: ${orphanPath}`;
              })
              .join('\n');
            return {
              content: [{
                type: 'text' as const,
                text: `No state found for mode: ${mode} in session: ${sessionId}\nExpected path: ${statePath}\n\nDiscovered ${completedSessionPaths.length} completed-session orphan state file${completedSessionPaths.length === 1 ? '' : 's'} for this mode:\n${orphanList}\n\nRun state_clear(mode="${mode}", session_id="${sessionId}") to clear the current session plus these completed-session orphan files.`
              }]
            };
          }

          return {
            content: [{
              type: 'text' as const,
              text: `No state found for mode: ${mode} in session: ${sessionId}\nExpected path: ${statePath}`
            }]
          };
        }

        const content = readFileSync(statePath, 'utf-8');
        let state: unknown;
        try {
          state = JSON.parse(content);
        } catch (error) {
          if (mode === 'team') throw new Error('team state is corrupt; existing bytes preserved');
          throw error;
        }
        if (mode === 'team' && !isJsonRecord(state)) {
          throw new Error('team state is corrupt; expected a JSON object; existing bytes preserved');
        }
        const ownerSessionId = getStateSessionOwner(isJsonRecord(state) ? state : null);
        if (ownerSessionId && ownerSessionId !== sessionId) {
          return {
            content: [{
              type: 'text' as const,
              text: `No state found for mode: ${mode} in session: ${sessionId}\nExpected path: ${statePath}`
            }]
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: `## State for ${mode} (session: ${sessionId})\n\nPath: ${statePath}\n\n\`\`\`json\n${JSON.stringify(publicStateForMode(mode, state), null, 2)}\n\`\`\``
          }]
        };
      }

      // No session_id: scan all sessions and legacy path
      const statePath = getStatePath(mode, root);
      const legacyExists = existsSync(statePath);
      const sessionIds = listSessionIds(root);
      const activeSessions: string[] = [];

      for (const sid of sessionIds) {
        const sessionStatePath = getSessionStatePath(mode, root, sid);

        if (existsSync(sessionStatePath)) {
          activeSessions.push(sid);
        }
      }

      if (!legacyExists && activeSessions.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No state found for mode: ${mode}\nExpected legacy path: ${statePath}\nNo active sessions found.\n\nNote: Reading from legacy/aggregate path (no session_id). This may include state from other sessions.`
          }]
        };
      }

      let output = `## State for ${mode}\n\nNote: Reading from legacy/aggregate path (no session_id). This may include state from other sessions.\n\n`;
      let teamReadError = false;

      // Show legacy state if exists
      if (legacyExists) {
        try {
          const content = readFileSync(statePath, 'utf-8');
          const state = JSON.parse(content);
          if (mode === 'team' && !isJsonRecord(state)) {
            throw new Error('team state is corrupt; expected a JSON object');
          }
          output += `### Legacy Path (shared)\nPath: ${statePath}\n\n\`\`\`json\n${JSON.stringify(publicStateForMode(mode, state), null, 2)}\n\`\`\`\n\n`;
        } catch (error) {
          if (mode === 'team') teamReadError = true;
          output += `### Legacy Path (shared)\nPath: ${statePath}\n*Error reading state file${mode === 'team' ? `: ${error instanceof Error ? error.message : String(error)}` : ''}*\n\n`;
        }
      }

      // Show active sessions
      if (activeSessions.length > 0) {
        output += `### Active Sessions (${activeSessions.length})\n\n`;
        for (const sid of activeSessions) {
          const sessionStatePath = getSessionStatePath(mode, root, sid);

          try {
            const content = readFileSync(sessionStatePath, 'utf-8');
            const state = JSON.parse(content);
            if (mode === 'team' && !isJsonRecord(state)) {
              throw new Error('team state is corrupt; expected a JSON object');
            }
            output += `**Session: ${sid}**\nPath: ${sessionStatePath}\n\n\`\`\`json\n${JSON.stringify(publicStateForMode(mode, state), null, 2)}\n\`\`\`\n\n`;
          } catch (error) {
            if (mode === 'team') teamReadError = true;
            output += `**Session: ${sid}**\nPath: ${sessionStatePath}\n*Error reading state file${mode === 'team' ? `: ${error instanceof Error ? error.message : String(error)}` : ''}*\n\n`;
          }
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: output
        }],
        ...(teamReadError ? { isError: true } : {}),
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error reading state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};

// ============================================================================
// state_write - Write state for a mode
// ============================================================================

export const stateWriteTool: ToolDefinition<{
  mode: z.ZodEnum<typeof STATE_WRITE_MODES>;
  active: z.ZodOptional<z.ZodBoolean>;
  iteration: z.ZodOptional<z.ZodNumber>;
  max_iterations: z.ZodOptional<z.ZodNumber>;
  current_phase: z.ZodOptional<z.ZodString>;
  task_description: z.ZodOptional<z.ZodString>;
  plan_path: z.ZodOptional<z.ZodString>;
  started_at: z.ZodOptional<z.ZodString>;
  completed_at: z.ZodOptional<z.ZodString>;
  error: z.ZodOptional<z.ZodString>;
  state: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  workingDirectory: z.ZodOptional<z.ZodString>;
  session_id: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_write',
  description: 'Write/update state for a specific mode. Creates the state file and directories if they do not exist. Common fields (active, iteration, phase, etc.) can be set directly as parameters. Additional custom fields can be passed via the optional `state` parameter. Note: swarm uses SQLite and cannot be written via this tool.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  schema: {
    mode: z.enum(STATE_WRITE_MODES).describe('The mode to write state for'),
    active: z.boolean().optional().describe('Whether the mode is currently active'),
    iteration: z.number().optional().describe('Current iteration number'),
    max_iterations: z.number().optional().describe('Maximum iterations allowed'),
    current_phase: z.string().max(200).optional().describe('Current execution phase'),
    task_description: z.string().max(2000).optional().describe('Description of the task being executed'),
    plan_path: z.string().max(500).optional().describe('Path to the plan file'),
    started_at: z.string().max(100).optional().describe('ISO timestamp when the mode started'),
    completed_at: z.string().max(100).optional().describe('ISO timestamp when the mode completed'),
    error: z.string().max(2000).optional().describe('Error message if the mode failed'),
    state: z.record(z.string(), z.unknown()).optional().describe('Additional custom state fields (merged with explicit parameters)'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
  },
  handler: async (args) => {
    const {
      mode,
      active,
      iteration,
      max_iterations,
      current_phase,
      task_description,
      plan_path,
      started_at,
      completed_at,
      error,
      state,
      workingDirectory,
      session_id
    } = args;

    try {
      const root = resolveStateWorkingDirectory(workingDirectory);
      const sessionId = session_id as string | undefined;

      // Validate custom state payload size if provided
      if (state) {
        const validation = validatePayload(state);
        if (!validation.valid) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error: state payload rejected — ${validation.error}`
            }],
            isError: true
          };
        }
      }

      // Determine state path based on session_id
      let statePath: string;
      if (sessionId) {
        validateSessionId(sessionId);
        ensureSessionStateDir(sessionId, root);
        statePath = getSessionStatePath(mode, root, sessionId);
      } else {
        ensureOmcDir('state', root);
        statePath = getStatePath(mode, root);
      }

      if (mode !== 'team' && sessionId && existsSync(statePath)) {
        const existingState = readJsonRecord(statePath);
        const ownerSessionId = existingState ? getStateSessionOwner(existingState) : undefined;
        if (ownerSessionId && ownerSessionId !== sessionId) {
          throw new Error(`state is owned by session '${ownerSessionId}' and cannot be modified by session '${sessionId}'`);
        }
      }

      // Build state from explicit params + custom state
      const builtState: Record<string, unknown> = {};

      // Add explicit params (only if provided)
      if (active !== undefined) builtState.active = active;
      if (iteration !== undefined) builtState.iteration = iteration;
      if (max_iterations !== undefined) builtState.max_iterations = max_iterations;
      if (current_phase !== undefined) builtState.current_phase = current_phase;
      if (task_description !== undefined) builtState.task_description = task_description;
      if (plan_path !== undefined) builtState.plan_path = plan_path;
      if (started_at !== undefined) builtState.started_at = started_at;
      if (completed_at !== undefined) builtState.completed_at = completed_at;
      if (error !== undefined) builtState.error = error;

      // Merge custom state fields (explicit params take precedence)
      if (state) {
        for (const [key, value] of Object.entries(state)) {
          if (!(key in builtState)) {
            builtState[key] = value;
          }
        }
      }

      if (isRetiredWorkflowMode(mode) && builtState.active === true) {
        throw new Error('ultrawork is retired and cannot be activated via state_write; use state_clear to remove legacy state');
      }

      const requestedRunId = typeof builtState.workflowRunId === 'string' ? builtState.workflowRunId : undefined;
      const requestedStateDigest = typeof builtState.target_state_sha256 === 'string' ? builtState.target_state_sha256 : undefined;
      const isExactNamedPause = isExactNamedPauseRequest(builtState);
      if (mode === 'autopilot' && (hasNamedWorkflowMarker(builtState) || hasOwnProperty(builtState, 'target_state_sha256')) && !isExactNamedPause) {
        throw new Error('named autopilot workflow markers are runtime-owned; only active:false with an exact workflowRunId and optional state digest may pause a run');
      }

      // Add metadata
      const stateWithMeta = {
        ...builtState,
        _meta: {
          mode,
          sessionId: sessionId || null,
          updatedAt: new Date().toISOString(),
          updatedBy: 'state_write_tool'
        }
      };
      let writtenState: Record<string, unknown> = stateWithMeta;
      let namedPauseCommitted = false;
      if (mode === 'team') {
        const teamMutation = await writeTeamState(statePath, sessionId, omitUndefinedFields(stateWithMeta));
        if (teamMutation.result !== 'written') {
          const message = teamMutation.result === 'corrupt'
            ? 'team state is corrupt; existing bytes preserved'
            : teamMutation.result === 'foreign'
              ? `state is owned by another session and cannot be modified by session '${sessionId ?? 'legacy'}'`
              : teamMutation.error
                ? `state publication failed: ${teamMutation.error instanceof Error ? teamMutation.error.message : String(teamMutation.error)}`
              : 'state mutation lock unavailable';
          throw new Error(message);
        }
        writtenState = teamMutation.state ?? stateWithMeta;
      } else if (mode === 'autopilot' && builtState.active === false) {
        let currentState: Record<string, unknown> | null = null;
        try { currentState = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>; } catch { /* missing or malformed state is handled below */ }
        if (hasNamedWorkflowMarker(currentState ?? {})) {
          if (!isExactNamedPause || !requestedRunId) {
            throw new Error('named autopilot workflow state requires active:false with its exact workflowRunId');
          }
          if (namedWorkflowRuntimeSupported()) {
            const result = writeStateFileLockedIf(
              statePath,
              (current) => matchesNamedPauseTarget(current, sessionId, requestedRunId, requestedStateDigest),
              (current) => ({ ...current, active: false }),
            );
            if (result !== 'written') {
              throw new Error(result === 'failed'
                ? getStateMutationLockFailureMessage()
                : 'named autopilot run changed, is stale, or failed integrity validation');
            }
            namedPauseCommitted = true;
          } else {
            const snapshot = JSON.stringify(currentState);
            const written = emergencyMutateStateFileIf(
              statePath,
              (current) => JSON.stringify(current) === snapshot &&
                isExactEmergencyNamedMutation(current, requestedRunId) &&
                (requestedStateDigest === undefined || createHash('sha256').update(JSON.stringify(current)).digest('hex') === requestedStateDigest),
              (current) => ({ ...current, active: false }),
            );
            if (!written) throw new Error('autopilot run changed before deactivation');
            namedPauseCommitted = true;
          }
        } else {
          const result = writeStateFileLockedCreateIf(
            statePath,
            (current) => (!sessionId || !current || canClearStateForSession(current, sessionId)) && !hasNamedWorkflowMarker(current),
            (current) => {
              writtenState = { ...(current ?? {}), ...stateWithMeta };
              return writtenState;
            },
          );
          if (result !== 'written') throw new Error(result === 'failed' ? getStateMutationLockFailureMessage() : 'autopilot run changed before deactivation');
        }
      } else if (mode === 'autopilot') {
        let namedWorkflowExists = false;
        const result = writeStateFileLockedCreateIf(
          statePath,
          (current) => {
            if (sessionId && current && !canClearStateForSession(current, sessionId)) return false;
            if (!hasNamedWorkflowMarker(current)) return true;
            namedWorkflowExists = true;
            return false;
          },
          (current) => {
            writtenState = { ...(current ?? {}), ...stateWithMeta };
            return writtenState;
          },
        );
        if (result !== 'written') {
          if (namedWorkflowExists) throw new Error('named autopilot workflow state is runtime-owned; only exact-run deactivation is allowed');
          throw new Error(result === 'failed' ? getStateMutationLockFailureMessage() : 'autopilot state changed before write');
        }
      } else {
        const result = writeStateFileLockedCreateIf(
          statePath,
          (current) => !sessionId || !current || canClearStateForSession(current, sessionId),
          () => stateWithMeta,
        );
        if (result !== 'written') {
          throw new Error(result === 'failed'
            ? getStateMutationLockFailureMessage()
            : `state is owned by another session and cannot be modified by session '${sessionId ?? 'legacy'}'`);
        }
      }

      const sessionInfo = sessionId ? ` (session: ${sessionId})` : ' (legacy path)';
      const warningMessage = sessionId ? '' : '\n\nWARNING: No session_id provided. State written to legacy shared path which may leak across parallel sessions. Pass session_id for session-scoped isolation.';
      const nativeBindingWarning = getStateMutationLockDiagnostic();
      const nativeBindingWarningMessage = nativeBindingWarning ? `\n\nWARNING: ${nativeBindingWarning}` : '';
      return {
        content: [{
          type: 'text' as const,
          text: namedPauseCommitted
            ? `Paused named autopilot workflow${sessionInfo}. Resume state is preserved.${nativeBindingWarningMessage}`
            : `Successfully wrote state for ${mode}${sessionInfo}\nPath: ${statePath}\n\n\`\`\`json\n${JSON.stringify(writtenState, null, 2)}\n\`\`\`${warningMessage}${nativeBindingWarningMessage}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error writing state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};

// ============================================================================
// state_clear - Clear state for a mode
// ============================================================================

function getAllRootSessionStatePaths(mode: StateToolMode, root: string): string[] {
  const paths = new Set<string>();
  const roots = new Set(getConvergedOmcRoots(root));
  if (shouldCheckWorkingDirectoryLocalState(root)) roots.add(getWorkingDirectoryLocalOmcRoot(root));
  roots.add(getOmcRoot(root));
  for (const omcRoot of roots) {
    for (const sid of listSessionIdsUnderOmcRoot(omcRoot)) {
      paths.add(join(omcRoot, 'state', 'sessions', sid, getStateFileName(mode)));
    }
  }
  return [...paths];
}

function discoverAllRootSessionStateCandidates(mode: StateToolMode, root: string): StateFileDiscovery[] {
  return discoverStatePaths(getAllRootSessionStatePaths(mode, root), mode);
}

function findUnresolvedTeamStatePaths(paths: string[]): string[] {
  return [...new Set(paths)].filter((path) => {
    if (!existsSync(path)) return false;
    if (readJsonRecordStrict(path) !== null) return false;
    return existsSync(path);
  });
}

function recoverAutopilotEmergencyTransactions(root: string, sessionId?: string): void {
  const broadPaths = new Set<string>([
    ...getLegacyStateFileCandidates('autopilot', root),
    ...getWorkingDirectoryLocalStateClearCandidates('autopilot', root),
    ...getConvergedStateCandidates('autopilot', root),
  ]);
  if (shouldCheckWorkingDirectoryLocalState(root)) {
    const localOmcRoot = getWorkingDirectoryLocalOmcRoot(root);
    for (const sid of listSessionIdsUnderOmcRoot(localOmcRoot)) {
      broadPaths.add(join(localOmcRoot, 'state', 'sessions', sid, getStateFileName('autopilot')));
    }
  }
  for (const omcRoot of getConvergedOmcRoots(root)) {
    for (const sid of listSessionIdsUnderOmcRoot(omcRoot)) {
      broadPaths.add(join(omcRoot, 'state', 'sessions', sid, getStateFileName('autopilot')));
    }
  }
  const directSessionPaths = new Set<string>();
  if (sessionId) {
    directSessionPaths.add(resolveSessionStatePath('autopilot', sessionId, root));
    if (shouldCheckWorkingDirectoryLocalState(root)) directSessionPaths.add(getWorkingDirectoryLocalSessionStatePath('autopilot', root, sessionId));
    for (const omcRoot of getConvergedOmcRoots(root)) {
      directSessionPaths.add(join(omcRoot, 'state', 'sessions', sessionId, getStateFileName('autopilot')));
    }
    for (const path of directSessionPaths) broadPaths.add(path);
  }
  for (const path of broadPaths) {
    let recoveryOptions = emergencyRecoveryOptionsForProject('autopilot', path, root);
    if (!isAutopilotRecoveryCandidateForProject(path, root)) continue;
    if (!directSessionPaths.has(path)) {
      const visibleOwner = getStateSessionOwner(readJsonRecord(path) ?? {});
      const journal = readJsonRecord(`${path}.emergency-journal.json`);
      const journalOwner = typeof journal?.sessionOwner === 'string' ? journal.sessionOwner : undefined;
      const pathSessionId = path.replaceAll('\\', '/').match(/\/state\/sessions\/([^/]+)\/[^/]+$/)?.[1];
      const ownerSessionId = sessionId ?? visibleOwner ?? journalOwner;
      if (sessionId && visibleOwner !== sessionId && journalOwner !== sessionId) continue;
      if (ownerSessionId && ownerSessionId !== pathSessionId) {
        recoveryOptions = {
          authorizeState: (state) => isStateCandidateForProject('autopilot', path, state, root)
            && getStateSessionOwner(state) === ownerSessionId,
        };
      }
    }
    if (!recoverEmergencyStateFile(path, recoveryOptions)) throw new Error(`workflow_emergency_recovery_failed: ${path}`);
    if (recoveryOptions && !isAutopilotRecoveryCandidateForProject(path, root)) continue;
    const artifactPrefix = `${basename(path)}.emergency-`;
    let artifacts: string[];
    try { artifacts = readdirSync(dirname(path)).filter((name) => name.startsWith(artifactPrefix) && !name.endsWith('.recovery.guard')); }
    catch { artifacts = []; }
    if (artifacts.length > 0) throw new Error(`workflow_emergency_recovery_failed: ${path}`);
  }
}

export const stateClearTool: ToolDefinition<{
  mode: z.ZodEnum<typeof STATE_TOOL_MODES>;
  workingDirectory: z.ZodOptional<z.ZodString>;
  session_id: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_clear',
  description: 'Clear/delete state for a specific mode. Removes the state file and any associated marker files. For merge-readiness, cancels an active gate while preserving the terminal audit record (no deletion).',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  schema: {
    mode: z.enum(STATE_TOOL_MODES).describe('The mode to clear state for'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
  },
  handler: async (args) => {
    const { mode, workingDirectory, session_id } = args;

    try {
      const root = resolveStateWorkingDirectory(workingDirectory);
      const sessionId = session_id as string | undefined;
      if (mode === 'ultrawork') {
        try {
          if (lstatSync(join(resolve(root), OmcPaths.ROOT)).isSymbolicLink()) {
            return { content: [{ type: 'text' as const, text: `No state found to clear for mode: ${mode}` }] };
          }
        } catch {
          // Missing roots follow the normal no-state path.
        }
      }

      // Merge-readiness is an audit gate, so clearing it must leave a durable
      // terminal result and report rather than deleting the evidence trail.
      if (mode === 'merge-readiness') {
        const cancelledSessions: string[] = [];
        const blockedSessions: string[] = [];
        const cancelActiveSession = (targetSessionId?: string): 'cancelled' | 'blocked' | 'inactive' => {
          const current = readMergeReadinessState(root, targetSessionId);
          if (!current?.active) return 'inactive';
          // cancelMergeReadiness fail-closes to an active blocked state when the
          // write cannot land; distinguish that from a real cancelled result so
          // the operator learns the cancel did not persist.
          return cancelMergeReadiness(root, targetSessionId)?.result === 'cancelled' ? 'cancelled' : 'blocked';
        };
        const recordResult = (sid: string, status: 'cancelled' | 'blocked' | 'inactive'): void => {
          if (status === 'cancelled') cancelledSessions.push(sid);
          else if (status === 'blocked') blockedSessions.push(sid);
        };
        if (sessionId) {
          validateSessionId(sessionId);
          recordResult(sessionId, cancelActiveSession(sessionId));
        } else {
          // Omitting session_id must not cross session boundaries: only cancel
          // the caller's own session (resolved from env) and legacy state,
          // never other sessions' active gates.
          const callerSid = (process.env.CLAUDE_SESSION_ID && process.env.CLAUDE_SESSION_ID.trim()) || resolveSessionId({ context: "cli" });
          if (callerSid) recordResult(callerSid, cancelActiveSession(callerSid));
          recordResult('legacy', cancelActiveSession());
        }
        const blocked = blockedSessions.length > 0;
        const text = blocked
          ? `Merge-readiness cancellation FAILED for: ${blockedSessions.join(', ')}. The state could not be persisted (read-only state dir / full disk); the gate(s) remain active on disk. Resolve and re-run.`
          : cancelledSessions.length > 0
            ? `Cancelled merge-readiness gate(s) with durable state audit records: ${cancelledSessions.join(', ')}`
            : 'No active merge-readiness gate found; existing state audit records were preserved.';
        return {
          content: [{ type: 'text' as const, text }],
          ...(blocked ? { isError: true } : {}),
        };
      }
      if (mode === 'autopilot') recoverAutopilotEmergencyTransactions(root, sessionId);
      const teamCleanup: TeamCleanupBookkeeping = {
        teamNames: new Set(),
        blockedNames: new Set(),
        clearedSessions: new Set(),
        requesterSessionId: sessionId,
      };
      const teamRuntimeSnapshots = mode === 'team'
        ? captureTeamRuntimeArtifacts(root)
        : undefined;
      let teamLegacyCleared = false;

      // If session_id provided, clear only session-specific state
      if (sessionId) {
        validateSessionId(sessionId);
        if (mode === 'team') blockForeignTeamPrimary(root, sessionId, teamCleanup);
        const requestedSessionCandidates = findSessionOwnedStateCandidates(mode, sessionId, root)
          .filter((candidate) => isStateCandidateForMode(mode, candidate) &&
            isStateCandidateForProject(mode, candidate.path, candidate.state, root) &&
            canClearStateForSession(candidate.state, sessionId));
        const requestedSessionOwnedPaths = requestedSessionCandidates.map((candidate) => candidate.path);
        const completedCandidates = findCompletedSessionStateCandidates(mode, root, sessionId)
          .filter((candidate) => isStateCandidateForMode(mode, candidate) &&
            isStateCandidateForProject(mode, candidate.path, candidate.state, root));
        const legacyCandidates = discoverStatePaths(getLegacyStateFileCandidates(mode, root), mode)
          .filter((candidate) => isStateCandidateForProject(mode, candidate.path, candidate.state, root));
        const localCandidates = discoverStatePaths(getWorkingDirectoryLocalStateClearCandidates(mode, root, sessionId), mode)
          .filter((candidate) => isStateCandidateForProject(mode, candidate.path, candidate.state, root));
        const convergedCandidates = discoverStatePaths(getConvergedStateCandidates(mode, root, sessionId), mode)
          .filter((candidate) => isStateCandidateForProject(mode, candidate.path, candidate.state, root));
        const operationCandidates = [...new Map([
          ...requestedSessionCandidates,
          ...completedCandidates,
          ...legacyCandidates.filter((candidate) => canClearStateForSession(candidate.state, sessionId)),
          ...localCandidates.filter((candidate) => canClearStateForSession(candidate.state, sessionId)),
          ...convergedCandidates.filter((candidate) => canClearStateForSession(candidate.state, sessionId)),
        ].map((candidate) => [candidate.path, candidate])).values()];
        const directStatePath = getSessionStatePath(mode, root, sessionId);
        const directCandidate = requestedSessionCandidates.find((candidate) => candidate.path === directStatePath) ?? requestedSessionCandidates[0];
        const namedPrimaries = mode === 'autopilot' ? operationCandidates.filter((candidate) => hasNamedWorkflowMarker(candidate.state)) : [];
        const namedPrimaryPaths = new Set(namedPrimaries.map((candidate) => candidate.path));
        let directCleared = 0;
        for (const candidate of namedPrimaries) {
          const success = clearAutopilotMarkerCandidate(candidate, root);
          if (!success || existsSync(candidate.path)) throw new Error(`primary state mutation failed; dependent state preserved: ${candidate.path}`);
          directCleared += 1;
        }
        const completedSessionCleanup = clearCompletedSessionStateCandidates(
          mode,
          root,
          sessionId,
          completedCandidates.filter((candidate) => !namedPrimaryPaths.has(candidate.path)),
          teamCleanup,
        );
        const runtimeCleanup = mode === 'team'
          ? { cleared: 0, hadFailure: false }
          : clearModeRuntimeArtifacts(mode, root, sessionId);
        const sessionSignalCandidates = operationCandidates.filter((candidate) => !hasNamedWorkflowMarker(candidate.state));
        const signaledCandidateDirs = new Set<string>();
        for (const candidate of sessionSignalCandidates) {
          const signalDir = dirname(candidate.path);
          if (signaledCandidateDirs.has(signalDir)) continue;
          signaledCandidateDirs.add(signalDir);
          const now = Date.now();
          const signalPath = join(signalDir, 'cancel-signal-state.json');
          const payload = {
            active: true,
            requested_at: new Date(now).toISOString(),
            expires_at: new Date(now + CANCEL_SIGNAL_TTL_MS).toISOString(),
            mode,
            source: 'state_clear' as const,
            ...(candidate.workflowRunId ? { target_workflow_run_id: candidate.workflowRunId } : {}),
            target_state_sha256: createHash('sha256').update(candidate.snapshot).digest('hex'),
          };
          try { writeStateFileLocked(signalPath, payload); } catch { /* best-effort */ }
        }
        if (sessionSignalCandidates.length === 0 && namedPrimaries.length === 0) writeSessionCancelSignal(root, sessionId, mode, directCandidate);

        const sessionCleanup = clearSessionOwnedStateCandidates(
          mode,
          root,
          sessionId,
          requestedSessionCandidates,
          teamCleanup,
        );
        const legacyCleanup = clearLegacyStateCandidates(
          mode,
          root,
          sessionId,
          legacyCandidates,
          teamCleanup,
        );
        const shouldUseLocalFallback = requestedSessionOwnedPaths.length === 0 &&
          completedSessionCleanup.cleared === 0 &&
          sessionCleanup.cleared === 0 &&
          legacyCleanup.cleared === 0;
        const workingDirectoryLocalCleanup = shouldUseLocalFallback
          ? clearWorkingDirectoryLocalStateCandidates(mode, root, sessionId, localCandidates, teamCleanup)
          : { cleared: 0, hadFailure: false };
        const convergedCleanup = clearConvergedStateCandidates(mode, root, sessionId, convergedCandidates, teamCleanup);
        let primarySuccess = true;
        let ownerSessionId: string | undefined;
        let ownerSessionCleanup = { cleared: 0, hadFailure: false };
        let ownerLegacyCleanup = { cleared: 0, hadFailure: false };

        if (MODE_CONFIGS[mode as ExecutionMode]) {
          const expectedDirectState = directCandidate?.state;
          const clearPrimary = (): boolean => clearModeState(mode as ExecutionMode, root, sessionId, expectedDirectState);
          const directCaptured = directCandidate?.path === directStatePath;
          primarySuccess = clearModePrimaryWithTeamLock(mode, directStatePath, clearPrimary, directCaptured);
          if (directCaptured && primarySuccess && !existsSync(directStatePath)) {
            directCleared = 1;
            if (mode === 'team' && directCandidate) {
              for (const teamName of readTeamNamesFromState(directCandidate.state, sessionId)) teamCleanup.teamNames.add(teamName);
              teamCleanup.clearedSessions.add(sessionId);
            }
          } else if (mode === 'team' && directCaptured && directCandidate) {
            recordTeamClearFailure(mode, directCandidate, primarySuccess ? 'skipped' : 'failed', teamCleanup);
          }

          if (
            OWNER_SESSION_FALLBACK_MODES.has(mode) &&
            requestedSessionOwnedPaths.length === 0 &&
            completedCandidates.length === 0 &&
            legacyCandidates.length === 0 &&
            completedSessionCleanup.cleared === 0 &&
            sessionCleanup.cleared === 0 &&
            legacyCleanup.cleared === 0 &&
            convergedCleanup.cleared === 0 &&
            workingDirectoryLocalCleanup.cleared === 0
          ) {
            ownerSessionId = findSingleOwningSessionForMode(mode, root, sessionId);
            if (ownerSessionId !== sessionId) ownerSessionId = undefined;
            if (ownerSessionId) {
              const ownerCandidates = findSessionOwnedStateCandidates(mode, ownerSessionId, root)
                .filter((candidate) => isStateCandidateForMode(mode, candidate));
              const ownerStatePath = getSessionStatePath(mode, root, ownerSessionId);
              const ownerDirectCandidate = ownerCandidates.find((candidate) => candidate.path === ownerStatePath) ?? ownerCandidates[0];
              const ownerNamedPrimary = mode === 'autopilot' && ownerDirectCandidate && hasNamedWorkflowMarker(ownerDirectCandidate.state) ? ownerDirectCandidate : undefined;
              if (ownerNamedPrimary) {
                const success = clearAutopilotMarkerCandidate(ownerNamedPrimary, root);
                if (!success || existsSync(ownerNamedPrimary.path)) throw new Error('primary state mutation failed; dependent state preserved');
              } else {
                writeSessionCancelSignal(root, ownerSessionId, mode, ownerDirectCandidate);
                clearModeState(mode as ExecutionMode, root, ownerSessionId, ownerDirectCandidate?.state);
              }
              const ownerRuntimeCleanup = clearModeRuntimeArtifacts(mode, root, ownerSessionId);
              runtimeCleanup.cleared += ownerRuntimeCleanup.cleared;
              runtimeCleanup.hadFailure ||= ownerRuntimeCleanup.hadFailure;
              ownerSessionCleanup = clearSessionOwnedStateCandidates(mode, root, ownerSessionId, ownerCandidates.filter((candidate) => candidate.path !== ownerNamedPrimary?.path));
              ownerLegacyCleanup = clearLegacyStateCandidates(mode, root, ownerSessionId);
            }
          }

        }

        if (mode === 'team' && teamRuntimeSnapshots) {
          const safeTeamSessions = new Set([...teamCleanup.clearedSessions].filter((sid) =>
            !operationCandidates.some((candidate) =>
              teamSessionIdForCandidate(candidate, sessionId) === sid && existsSync(candidate.path),
            )));
          const eligibleTeamSessions = new Set([...safeTeamSessions].filter((sid) =>
            !existsSync(getSessionStatePath('team', root, sid))));
          const teamRuntimeCleanup = clearTeamRuntimeArtifacts(root, eligibleTeamSessions, teamRuntimeSnapshots);
          runtimeCleanup.cleared += teamRuntimeCleanup.cleared;
          runtimeCleanup.hadFailure ||= teamRuntimeCleanup.hadFailure;
        }

        // Re-check after candidate clears so a canonical replacement cannot
        // authorize cleanup of a foreign Team runtime.
        if (mode === 'team') blockForeignTeamPrimary(root, sessionId, teamCleanup);
        const ghostNote = formatStateClearCleanupNote(
          legacyCleanup.cleared,
          completedSessionCleanup.cleared,
          sessionCleanup.cleared,
          workingDirectoryLocalCleanup.cleared,
          convergedCleanup.cleared,
          runtimeCleanup.cleared,
          ownerSessionId,
        );
        const runtimeCleanupNote = cleanupTeamRuntimeNote(mode, root, teamCleanup);
        const clearedStateOrArtifacts = directCleared + completedSessionCleanup.cleared +
          sessionCleanup.cleared +
          legacyCleanup.cleared +
          convergedCleanup.cleared +
          workingDirectoryLocalCleanup.cleared +
          ownerSessionCleanup.cleared +
          ownerLegacyCleanup.cleared +
          runtimeCleanup.cleared;
        // Every mode needs this backstop: a captured candidate can be skipped
        // without any cleanup reporting a failure (its owning cleanup never
        // runs, or its snapshot predicate no longer matches) and still be left
        // on disk. Reporting success there hides a half-cancelled mode. The one
        // survivor that is not this caller's failure is a path another session
        // now owns: those bytes are a replacement run, not leftover state.
        const capturedCleanupIncomplete = operationCandidates.some((candidate) => {
          if (!existsSync(candidate.path)) return false;
          if (mode === 'team') return true;
          const current = readJsonRecordStrict(candidate.path);
          if (!current) return true;
          const survivorOwner = getStateSessionOwner(current);
          return !(survivorOwner !== undefined && survivorOwner !== sessionId);
        });
        const hadFailure = !primarySuccess || capturedCleanupIncomplete ||
          legacyCleanup.hadFailure || sessionCleanup.hadFailure ||
          workingDirectoryLocalCleanup.hadFailure || convergedCleanup.hadFailure ||
          completedSessionCleanup.hadFailure || ownerSessionCleanup.hadFailure ||
          ownerLegacyCleanup.hadFailure || runtimeCleanup.hadFailure;
        if (!ownerSessionId && clearedStateOrArtifacts === 0 && !hadFailure) {
          return {
            content: [{
              type: 'text' as const,
              text: formatStateClearNoopMessage(mode, root, sessionId)
            }]
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: `${hadFailure ? 'Warning: Some files could not be removed' : 'Successfully cleared state'} for mode: ${mode} in session: ${sessionId}${ghostNote}${runtimeCleanupNote}`
          }],
          ...(hadFailure ? { isError: true } : {}),
        };
      }

      // No session_id: clear from all locations (legacy + all sessions)
      // Write cancel signals FIRST (before deleting files) so the stop hook's
      // isSessionCancelInProgress check sees the signal during the deletion window.
      // Mirrors the session_id path at line ~403. (patch: fix missing cancel signal)
      const broadUnresolvedTeamStatePaths = mode === 'team'
        ? findUnresolvedTeamStatePaths([
          ...getLegacyStateFileCandidates(mode, root),
          ...getWorkingDirectoryLocalStateClearCandidates(mode, root),
          ...getConvergedStateCandidates(mode, root),
          ...getAllRootSessionStatePaths(mode, root),
        ])
        : [];
      const broadLegacyCandidates = discoverStatePaths(getLegacyStateFileCandidates(mode, root), mode)
        .filter((candidate) => isStateCandidateForProject(mode, candidate.path, candidate.state, root));
      const broadSessionCandidates = [...new Map([
        ...listSessionIds(root).flatMap((sid) => findSessionOwnedStateCandidates(mode, sid, root)),
        ...discoverAllRootSessionStateCandidates(mode, root),
      ].map((candidate) => [candidate.path, candidate])).values()]
        .filter((candidate) => isStateCandidateForMode(mode, candidate) &&
          isStateCandidateForProject(mode, candidate.path, candidate.state, root));
      const broadConvergedCandidates = discoverStatePaths(getConvergedStateCandidates(mode, root), mode)
        .filter((candidate) => isStateCandidateForProject(mode, candidate.path, candidate.state, root));
      const broadOperationCandidates = [...new Map([
        ...broadLegacyCandidates,
        ...broadSessionCandidates,
        ...broadConvergedCandidates,
      ].map((candidate) => [candidate.path, candidate])).values()];
      const broadNamedPrimaries = mode === 'autopilot' ? broadOperationCandidates.filter((candidate) => hasNamedWorkflowMarker(candidate.state)) : [];
      for (const candidate of broadNamedPrimaries) {
        const success = clearAutopilotMarkerCandidate(candidate, root);
        if (!success || existsSync(candidate.path)) throw new Error(`primary state mutation failed; dependent state preserved: ${candidate.path}`);
      }
      const broadLegacySignalCandidates = broadLegacyCandidates.filter((candidate) => !hasNamedWorkflowMarker(candidate.state));
      const broadSessionSignalCandidates = broadSessionCandidates.filter((candidate) => !hasNamedWorkflowMarker(candidate.state));
      if (broadLegacySignalCandidates.length > 0 || broadSessionSignalCandidates.length > 0) {
        const now = Date.now();
        const cancelSignalPayload = {
          active: true,
          requested_at: new Date(now).toISOString(),
          expires_at: new Date(now + CANCEL_SIGNAL_TTL_MS).toISOString(),
          mode,
          source: 'state_clear' as const,
        };
        const signaledLegacyDirs = new Set<string>();
        for (const legacyCandidate of broadLegacySignalCandidates) {
          const signalDir = dirname(legacyCandidate.path);
          if (signaledLegacyDirs.has(signalDir)) continue;
          signaledLegacyDirs.add(signalDir);
          const legacySignalPath = join(signalDir, 'cancel-signal-state.json');
          const legacyPayload = {
            ...cancelSignalPayload,
            ...(legacyCandidate.workflowRunId ? { target_workflow_run_id: legacyCandidate.workflowRunId } : {}),
            target_state_sha256: createHash('sha256').update(legacyCandidate.snapshot).digest('hex'),
          };
          try { writeStateFileLocked(legacySignalPath, legacyPayload); } catch { /* best-effort */ }
        }
        const signaledOwners = new Set<string>();
        for (const candidate of broadSessionSignalCandidates) {
          const owner = candidate.ownerSessionId;
          if (!owner || signaledOwners.has(owner)) continue;
          signaledOwners.add(owner);
          try { writeSessionCancelSignal(root, owner, mode, candidate); } catch { /* best-effort */ }
        }
      }
      const runtimeCleanup = mode === 'team'
        ? { cleared: 0, hadFailure: false }
        : clearModeRuntimeArtifacts(mode, root);
      let clearedCount = 0;
      const errors: string[] = broadUnresolvedTeamStatePaths.map((path) => `unresolved Team state: ${path}`);
      // Clear legacy path
      if (MODE_CONFIGS[mode as ExecutionMode]) {
        const primaryLegacyStatePath = getStatePath(mode, root);
        const primaryCandidate = broadLegacyCandidates.find((candidate) => candidate.path === primaryLegacyStatePath);
        if (primaryCandidate) {
          const clearPrimary = (): boolean => clearModeState(mode as ExecutionMode, root, undefined, primaryCandidate.state);
          const success = clearModePrimaryWithTeamLock(mode, primaryLegacyStatePath, clearPrimary);
          if (success && !existsSync(primaryCandidate.path)) {
            clearedCount++;
            if (mode === 'team') {
              teamLegacyCleared = true;
              const ownerSessionId = teamSessionIdForCandidate(primaryCandidate);
              if (ownerSessionId) teamCleanup.clearedSessions.add(ownerSessionId);
              for (const teamName of readTeamNamesFromState(primaryCandidate.state)) teamCleanup.teamNames.add(teamName);
            }
          } else if (existsSync(primaryCandidate.path)) {
            if (mode === 'team') {
              recordTeamClearFailure(mode, primaryCandidate, success ? 'skipped' : 'failed', teamCleanup);
            }
            errors.push('legacy path skipped');
          } else if (!success) {
            errors.push('legacy path');
          }
        }
      }

      const extraLegacyCleanup = clearLegacyStateCandidates(
        mode,
        root,
        undefined,
        broadLegacyCandidates,
        teamCleanup,
      );
      clearedCount += extraLegacyCleanup.cleared;
      if (extraLegacyCleanup.hadFailure) {
        errors.push('legacy path');
      }
      const convergedCleanup = clearConvergedStateCandidates(
        mode,
        root,
        undefined,
        broadConvergedCandidates,
        teamCleanup,
      );
      clearedCount += convergedCleanup.cleared;
      if (convergedCleanup.hadFailure) {
        errors.push('converged paths');
      }
      clearedCount += runtimeCleanup.cleared;
      if (runtimeCleanup.hadFailure) {
        errors.push('runtime artifacts');
      }
      const processedBroadPaths = new Set([
        ...broadLegacyCandidates.map((candidate) => candidate.path),
        ...broadConvergedCandidates.map((candidate) => candidate.path),
      ]);

      // Clear each captured session candidate by its exact discovered path.
      for (const candidate of broadSessionCandidates) {
        if (processedBroadPaths.has(candidate.path)) continue;
        processedBroadPaths.add(candidate.path);
        const result = clearDiscoveredStateCandidate(
          candidate,
          (current) => isStateCandidateForProject(mode, candidate.path, current, root),
          emergencyRecoveryOptionsForProject(mode, candidate.path, root),
          mode === 'team',
        );
        if (result === 'cleared') {
          clearedCount++;
          if (mode === 'team') {
            const ownerSessionId = teamSessionIdForCandidate(candidate);
            if (ownerSessionId) teamCleanup.clearedSessions.add(ownerSessionId);
            for (const teamName of readTeamNamesFromState(candidate.state)) teamCleanup.teamNames.add(teamName);
          }
        } else if (result === 'failed' || existsSync(candidate.path)) {
          recordTeamClearFailure(mode, candidate, result, teamCleanup);
          errors.push(`session candidate: ${candidate.path}`);
        }
      }
      const broadCapturedCandidates = [...new Map([
        ...broadLegacyCandidates,
        ...broadConvergedCandidates,
        ...broadSessionCandidates,
      ].map((candidate) => [candidate.path, candidate])).values()];
      const capturedCleanupIncomplete = broadCapturedCandidates.some((candidate) => existsSync(candidate.path));
      if (mode === 'team' && teamRuntimeSnapshots) {
        const safeTeamSessions = new Set([...teamCleanup.clearedSessions].filter((sid) =>
          !broadCapturedCandidates.some((candidate) =>
            teamSessionIdForCandidate(candidate) === sid && existsSync(candidate.path),
          )));
        const eligibleTeamSessions = new Set([...safeTeamSessions].filter((sid) =>
          !existsSync(getSessionStatePath('team', root, sid))));
        const teamRuntimeCleanup = clearTeamRuntimeArtifacts(root, eligibleTeamSessions, teamRuntimeSnapshots);
        runtimeCleanup.cleared += teamRuntimeCleanup.cleared;
        runtimeCleanup.hadFailure ||= teamRuntimeCleanup.hadFailure;
        if ((teamLegacyCleared || broadCapturedCandidates.length > 0) &&
          teamCleanup.blockedNames.size === 0 && errors.length === 0 && !capturedCleanupIncomplete) {
          const sharedRuntimeCleanup = clearTeamRuntimeArtifacts(root, [], teamRuntimeSnapshots, true);
          runtimeCleanup.cleared += sharedRuntimeCleanup.cleared;
          runtimeCleanup.hadFailure ||= sharedRuntimeCleanup.hadFailure;
        }
      }
      if (runtimeCleanup.hadFailure && !errors.includes('runtime artifacts')) {
        errors.push('runtime artifacts');
      }
      for (const candidate of broadCapturedCandidates) {
        if (existsSync(candidate.path) && !errors.some((error) => error.includes(candidate.path))) {
          errors.push(`captured candidate survived: ${candidate.path}`);
        }
      }
      clearedCount = broadCapturedCandidates.filter((candidate) => !existsSync(candidate.path)).length + runtimeCleanup.cleared;

      let removedTeamRoots = 0;
      let prunedMissionEntries = 0;
      if (mode === 'team') {
        const teamNames = [...teamCleanup.teamNames].filter((teamName) => !teamCleanup.blockedNames.has(teamName));
        const removeSelector = teamNames;
        removedTeamRoots = cleanupTeamRuntimeState(root, removeSelector);
        prunedMissionEntries = pruneMissionBoardTeams(root, removeSelector);
      }

      if (clearedCount === 0 && errors.length === 0 && removedTeamRoots === 0 && prunedMissionEntries === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: formatStateClearNoopMessage(mode, root)
          }]
        };
      }

      let message = `Cleared state for mode: ${mode}\n- Locations cleared: ${clearedCount}`;
      if (errors.length > 0) {
        message += `\n- Errors: ${errors.join(', ')}`;
      }
      if (mode === 'team') {
        if (removedTeamRoots > 0) {
          message += `\n- Team runtime roots removed: ${removedTeamRoots}`;
        }
        if (prunedMissionEntries > 0) {
          message += `\n- HUD mission entries pruned: ${prunedMissionEntries}`;
        }
      }
      message += '\nWARNING: No session_id provided. Cleared legacy plus all session-scoped state; this is a broad operation that may affect other sessions.';

      return {
        content: [{
          type: 'text' as const,
          text: message
        }],
        ...(errors.length > 0 ? { isError: true } : {})
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error clearing state for ${mode}: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};

// ============================================================================
// state_list_active - List all active modes
// ============================================================================

export const stateListActiveTool: ToolDefinition<{
  workingDirectory: z.ZodOptional<z.ZodString>;
  session_id: z.ZodOptional<z.ZodString>;
  all: z.ZodOptional<z.ZodBoolean>;
}> = {
  name: 'state_list_active',
  description: 'List all currently active modes. By default, scopes to the current session (OMC_SESSION_ID). Pass all:true to list active modes across all sessions.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  schema: {
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    session_id: z.string().optional().describe('Explicit session ID to scope the listing. Overrides OMC_SESSION_ID when provided.'),
    all: z.boolean().optional().describe('When true, list active modes across all sessions (legacy + every session-scoped dir). Overrides the default current-session scope.'),
  },
  handler: async (args) => {
    const { workingDirectory, session_id, all } = args;

    try {
      const root = resolveStateWorkingDirectory(workingDirectory);

      // Resolve the effective session ID:
      //   1. Explicit session_id arg wins (back-compat for callers that pass it directly).
      //   2. all:true opts out of session scoping entirely → show everything.
      //   3. Otherwise default to the current session via resolveSessionId({context:'cli'}).
      const explicitSessionId = session_id as string | undefined;
      const showAll = all === true;
      const sessionId: string | undefined = explicitSessionId
        ?? (showAll ? undefined : resolveSessionId({ context: 'cli' }));

      // If session_id resolved (explicit or current session), show modes for that session
      if (sessionId) {
        validateSessionId(sessionId);

        // Get active modes from registry for this session
        const activeModes: string[] = [...getActiveModes(root, sessionId)]
          .filter((activeMode) => !isRetiredWorkflowMode(activeMode));

        for (const mode of EXTRA_STATE_ONLY_MODES) {
          try {
            const statePath = resolveSessionStatePath(mode, sessionId, root);
            if (existsSync(statePath)) {
              const content = readFileSync(statePath, 'utf-8');
              const state = JSON.parse(content);
              if (state.active && canClearStateForSession(state, sessionId)) {
                activeModes.push(mode);
              }
            }
          } catch {
            // Ignore parse errors
          }
        }

        for (const mode of CONVERGED_STATE_PATH_MODES) {
          if (isRetiredWorkflowMode(mode)) continue;
          if (!activeModes.includes(mode) && hasActiveConvergedState(mode, root, sessionId)) {
            activeModes.push(mode);
          }
        }

        if (activeModes.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `## Active Modes (session: ${sessionId})\n\nNo modes are currently active in this session.`
            }]
          };
        }

        const modeList = activeModes.map(mode => `- **${mode}**`).join('\n');

        return {
          content: [{
            type: 'text' as const,
            text: `## Active Modes (session: ${sessionId}, ${activeModes.length})\n\n${modeList}`
          }]
        };
      }

      // No session_id: show all active modes across all sessions
      const modeSessionMap = new Map<string, string[]>();

      // Check legacy paths
      const legacyActiveModes: string[] = [...getActiveModes(root)]
        .filter((activeMode) => !isRetiredWorkflowMode(activeMode));
      for (const mode of EXTRA_STATE_ONLY_MODES) {
        const statePath = getStatePath(mode, root);
        if (existsSync(statePath)) {
          try {
            const content = readFileSync(statePath, 'utf-8');
            const state = JSON.parse(content);
            if (state.active) {
              legacyActiveModes.push(mode);
            }
          } catch {
            // Ignore parse errors
          }
        }
      }

      for (const mode of CONVERGED_STATE_PATH_MODES) {
        if (isRetiredWorkflowMode(mode)) continue;
        if (!legacyActiveModes.includes(mode) && hasActiveConvergedState(mode, root)) {
          legacyActiveModes.push(mode);
        }
      }

      for (const mode of legacyActiveModes) {
        if (!modeSessionMap.has(mode)) {
          modeSessionMap.set(mode, []);
        }
        modeSessionMap.get(mode)!.push('legacy');
      }

      // Check all sessions
      const sessionIds = listSessionIds(root);
      for (const sid of sessionIds) {
        const sessionActiveModes: string[] = [...getActiveModes(root, sid)]
          .filter((activeMode) => !isRetiredWorkflowMode(activeMode));

        for (const mode of EXTRA_STATE_ONLY_MODES) {
          try {
            const statePath = resolveSessionStatePath(mode, sid, root);
            if (existsSync(statePath)) {
              const content = readFileSync(statePath, 'utf-8');
              const state = JSON.parse(content);
              if (state.active && canClearStateForSession(state, sid)) {
                sessionActiveModes.push(mode);
              }
            }
          } catch {
            // Ignore parse errors
          }
        }

        for (const mode of sessionActiveModes) {
          if (!modeSessionMap.has(mode)) {
            modeSessionMap.set(mode, []);
          }
          modeSessionMap.get(mode)!.push(sid);
        }
      }

      if (modeSessionMap.size === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: '## Active Modes\n\nNo modes are currently active.'
          }]
        };
      }

      const lines: string[] = [`## Active Modes (${modeSessionMap.size})\n`];
      for (const [mode, sessions] of Array.from(modeSessionMap.entries())) {
        lines.push(`- **${mode}** (${sessions.join(', ')})`);
      }

      return {
        content: [{
          type: 'text' as const,
          text: lines.join('\n')
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error listing active modes: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};

// ============================================================================
// state_get_status - Get detailed status for a mode
// ============================================================================

export const stateGetStatusTool: ToolDefinition<{
  mode: z.ZodOptional<z.ZodEnum<typeof STATE_TOOL_MODES>>;
  workingDirectory: z.ZodOptional<z.ZodString>;
  session_id: z.ZodOptional<z.ZodString>;
}> = {
  name: 'state_get_status',
  description: 'Get detailed status for a specific mode or all modes. Shows active status, file paths, and state contents.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  schema: {
    mode: z.enum(STATE_TOOL_MODES).optional().describe('Specific mode to check (omit for all modes)'),
    workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    session_id: z.string().optional().describe('Session ID for session-scoped state isolation. When provided, the tool operates only within that session. When omitted, the tool aggregates legacy state plus all session-scoped state (may include other sessions).'),
  },
  handler: async (args) => {
    const { mode, workingDirectory, session_id } = args;

    try {
      const root = resolveStateWorkingDirectory(workingDirectory);
      const sessionId = session_id as string | undefined;

      if (mode) {
        // Single mode status
        const lines: string[] = [`## Status: ${mode}\n`];

        if (sessionId) {
          // Session-specific status
          validateSessionId(sessionId);
          const statePath = getSessionStatePath(mode, root, sessionId);

          const active = !isRetiredWorkflowMode(mode) && (MODE_CONFIGS[mode as ExecutionMode]
            ? isModeActive(mode as ExecutionMode, root, sessionId)
            : existsSync(statePath) && (() => {
                try {
                  const content = readFileSync(statePath, 'utf-8');
                  const state = JSON.parse(content);
                  return state.active === true && canClearStateForSession(state, sessionId);
                } catch { return false; }
              })());

          let statePreview = 'No state file';
          if (existsSync(statePath)) {
            try {
              const content = readFileSync(statePath, 'utf-8');
              const state = JSON.parse(content);
              const owner = getStateSessionOwner(state);
              if (!owner || owner === sessionId) {
                statePreview = JSON.stringify(publicStateForMode(mode, state), null, 2).slice(0, 500);
              }
              if (statePreview.length >= 500) statePreview += '\n...(truncated)';
            } catch {
              statePreview = 'Error reading state file';
            }
          }

          lines.push(`### Session: ${sessionId}`);
          const visible = !existsSync(statePath) || statePreview !== 'No state file' && !statePreview.includes('Error reading state file');
          lines.push(`- **Active:** ${visible && active ? 'Yes' : 'No'}`);
          lines.push(`- **State Path:** ${statePath}`);
          lines.push(`- **Exists:** ${visible && existsSync(statePath) ? 'Yes' : 'No'}`);
          lines.push(`\n### State Preview\n\`\`\`json\n${statePreview}\n\`\`\``);

          return {
            content: [{
              type: 'text' as const,
              text: lines.join('\n')
            }]
          };
        }

        // No session_id: show all sessions + legacy
        const legacyPath = getStatePath(mode, root);
        const legacyActive = !isRetiredWorkflowMode(mode) && (MODE_CONFIGS[mode as ExecutionMode]
          ? isModeActive(mode as ExecutionMode, root)
          : existsSync(legacyPath) && (() => {
              try {
                const content = readFileSync(legacyPath, 'utf-8');
                const state = JSON.parse(content);
                return state.active === true;
              } catch { return false; }
            })());

        lines.push(`### Legacy Path`);
        lines.push(`- **Active:** ${legacyActive ? 'Yes' : 'No'}`);
        lines.push(`- **State Path:** ${legacyPath}`);
        lines.push(`- **Exists:** ${existsSync(legacyPath) ? 'Yes' : 'No'}\n`);

        // Show active sessions for this mode
        const activeSessions = isRetiredWorkflowMode(mode) ? [] : MODE_CONFIGS[mode as ExecutionMode]
          ? getActiveSessionsForMode(mode as ExecutionMode, root)
          : listSessionIds(root).filter(sid => {
              try {
                const sessionPath = resolveSessionStatePath(mode, sid, root);
                if (existsSync(sessionPath)) {
                  const content = readFileSync(sessionPath, 'utf-8');
                  const state = JSON.parse(content);
                  return state.active === true && canClearStateForSession(state, sid);
                }
                return false;
              } catch {
                return false;
              }
            });

        if (activeSessions.length > 0) {
          lines.push(`### Active Sessions (${activeSessions.length})`);
          for (const sid of activeSessions) {
            lines.push(`- ${sid}`);
          }
        } else {
          lines.push(`### Active Sessions\nNo active sessions for this mode.`);
        }

        return {
          content: [{
            type: 'text' as const,
            text: lines.join('\n')
          }]
        };
      }

      // All modes status
      const statuses = getAllModeStatuses(root, sessionId).map((status) =>
        isRetiredWorkflowMode(status.mode) ? { ...status, active: false } : status,
      );
      const lines = sessionId
        ? [`## All Mode Statuses (session: ${sessionId})\n`]
        : ['## All Mode Statuses\n'];

      for (const status of statuses) {
        const icon = status.active ? '[ACTIVE]' : '[INACTIVE]';
        lines.push(`${icon} **${status.mode}**: ${status.active ? 'Active' : 'Inactive'}`);
        lines.push(`   Path: \`${status.stateFilePath}\``);

        // Show active sessions if no specific session_id
        if (!sessionId && !isRetiredWorkflowMode(status.mode) && MODE_CONFIGS[status.mode]) {
          const activeSessions = getActiveSessionsForMode(status.mode, root);
          if (activeSessions.length > 0) {
            lines.push(`   Active sessions: ${activeSessions.join(', ')}`);
          }
        }
      }

      // Also check extra state-only modes (not in MODE_CONFIGS)
      for (const mode of EXTRA_STATE_ONLY_MODES) {
        const statePath = sessionId
          ? resolveSessionStatePath(mode, sessionId, root)
          : getStatePath(mode, root);
        let active = false;
        if (existsSync(statePath)) {
          try {
            const content = readFileSync(statePath, 'utf-8');
            const state = JSON.parse(content);
            active = state.active === true && (!sessionId || canClearStateForSession(state, sessionId));
          } catch {
            // Ignore parse errors
          }
        }
        const icon = active ? '[ACTIVE]' : '[INACTIVE]';
        lines.push(`${icon} **${mode}**: ${active ? 'Active' : 'Inactive'}`);
        lines.push(`   Path: \`${statePath}\``);
      }

      return {
        content: [{
          type: 'text' as const,
          text: lines.join('\n')
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error getting status: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
};

const stateMigrateNonGitTool: ToolDefinition<any> = {
  name: 'state_migrate_non_git',
  description: 'Explicitly copy session-owned JSON state from a legacy non-git .omc root into the canonical non-git state root without overwriting or deleting source files.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  schema: {
    workingDirectory: z.string().optional().describe('Legacy non-git working directory containing .omc/state/sessions/<session_id>'),
    session_id: z.string().describe('Exact session owner to migrate'),
  },
  handler: async (args: { workingDirectory?: string; session_id?: string }) => {
    try {
      if (!args.session_id) throw new Error('session_id is required');
      validateSessionId(args.session_id);
      const sourceRoot = realpathSync(resolve(args.workingDirectory || process.cwd()));
      const trustedWorkingDirectory = realpathSync(resolve(process.cwd()));
      const sourceFromTrustedCwd = relative(trustedWorkingDirectory, sourceRoot);
      if (sourceFromTrustedCwd === '..' || sourceFromTrustedCwd.startsWith(`..${sep}`) || isAbsolute(sourceFromTrustedCwd)) {
        throw new Error('state_migrate_non_git refuses a source outside the trusted session working directory');
      }
      const gitProbe = probeGitTopLevel(sourceRoot);
      if (gitProbe.status === 'ok') throw new Error('state_migrate_non_git only accepts a non-git source directory');
      if (gitProbe.status !== 'not_a_repository') throw new Error('state_migrate_non_git refused a failed Git probe');
      if (findGitMetadataDir(sourceRoot)) throw new Error('state_migrate_non_git refuses a directory with Git metadata');
      const authorizedHome = realpathSync(homedir());
      const sourceFromHome = relative(authorizedHome, sourceRoot);
      if (sourceFromHome === '..' || sourceFromHome.startsWith(`..${sep}`) || isAbsolute(sourceFromHome)) {
        throw new Error('state_migrate_non_git refuses a source outside the authorized home boundary');
      }
      if (isSensitiveStateLocation(sourceRoot)) throw new Error('state_migrate_non_git refuses sensitive source directories');

      // Keep the validated non-Git source as the identity input. Replacing it
      // with HOME would let a Git checkout at HOME change the centralized
      // namespace on the second root-resolution pass.
      const canonicalOmc = getOmcRoot(sourceRoot);
      const sourceDir = join(sourceRoot, OmcPaths.ROOT, 'state', 'sessions', args.session_id);
      const destinationDir = join(canonicalOmc, 'state', 'sessions', args.session_id);
      const report = { source: sourceDir, destination: destinationDir, copied: [] as string[], skipped: [] as string[], rejected: [] as string[] };

      const sourceOmc = join(sourceRoot, OmcPaths.ROOT);
      if (!existsSync(sourceOmc)) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
      }
      const sourceState = join(sourceOmc, 'state');
      const sourceSessions = join(sourceState, 'sessions');
      for (const path of [sourceOmc, sourceState, sourceSessions]) {
        if (!existsSync(path)) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
        }
        if (lstatSync(path).isSymbolicLink()) throw new Error('state_migrate_non_git refuses symlinked legacy state paths');
      }
      if (!existsSync(sourceDir)) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
      }
      const destinationState = join(canonicalOmc, 'state');
      const destinationSessions = join(destinationState, 'sessions');
      const migrationRoots = [canonicalOmc, destinationState, destinationSessions, destinationDir];
      if (lstatSync(sourceDir).isSymbolicLink() || migrationRoots.some((path) => existsSync(path) && lstatSync(path).isSymbolicLink())) {
        throw new Error('state_migrate_non_git refuses symlinked migration roots');
      }
      ensureMigrationDirectoryTree(canonicalOmc, destinationDir);
      for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const sourcePath = join(sourceDir, entry.name);
        const sourceFd = openSync(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        let sourceBytes: Buffer;
        try {
          const sourceStat = fstatSync(sourceFd);
          if (!sourceStat.isFile()) throw new Error('state_migrate_non_git refuses a non-file source entry');
          if (sourceStat.size > MAX_MIGRATION_FILE_BYTES) {
            report.rejected.push(entry.name);
            continue;
          }
          sourceBytes = Buffer.alloc(sourceStat.size);
          const bytesRead = sourceStat.size === 0 ? 0 : readSync(sourceFd, sourceBytes, 0, sourceStat.size, 0);
          if (bytesRead !== sourceStat.size) {
            report.rejected.push(entry.name);
            continue;
          }
        } finally {
          closeSync(sourceFd);
        }
        let state: Record<string, unknown> | null = null;
        try { state = JSON.parse(sourceBytes.toString('utf8')) as Record<string, unknown>; } catch { /* rejected below */ }
        if (!state || getStateSessionOwner(state) !== args.session_id) {
          report.rejected.push(entry.name);
          continue;
        }
        const destinationPath = join(destinationDir, entry.name);
        ensureMigrationDirectoryTree(canonicalOmc, destinationDir);
        if (existsSync(destinationPath)) {
          report.skipped.push(entry.name);
          continue;
        }
        try {
          writeFileSync(destinationPath, sourceBytes, { flag: 'wx', mode: 0o600 });
          report.copied.push(entry.name);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') report.skipped.push(entry.name);
          else throw error;
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error migrating non-git state: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  },
};

/**
 * All state tools for registration
 */
export const stateTools = [
  stateReadTool,
  stateWriteTool,
  stateClearTool,
  stateListActiveTool,
  stateGetStatusTool,
  stateMigrateNonGitTool,
  {
    name: 'merge_readiness_start',
    description: 'Initialize a merge-readiness gate session for the current change. Call this first, before merge_readiness_set_content. The depth profile is parsed from the summary (--quick or --deep; standard is the default when neither flag is present). Re-running it while an active attempt is still pending is rejected - cancel via merge_readiness_cancel or let the attempt pass/pause first, so the in-progress audit trail is never silently overwritten.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    schema: {
      summary: z.string().max(2000),
      baseRef: z.string().max(200).regex(/^[A-Za-z0-9._\/@{}~^:-]+$/, "baseRef must be a valid git ref").refine((s) => !s.startsWith("-"), "baseRef must not start with '-'").optional().describe("Base ref to diff committed changes against (e.g. origin/dev, HEAD, HEAD~1, HEAD^). Defaults to the branch upstream / origin/HEAD."),
      workingDirectory: z.string().optional(), session_id: z.string().optional(),
    },
    handler: async (args: { summary: string; workingDirectory?: string; session_id?: string; baseRef?: string }) => {
      try {
      const directory = resolveStateWorkingDirectory(args.workingDirectory);
      const sessionId = (args.session_id && args.session_id.trim()) || (process.env.CLAUDE_SESSION_ID && process.env.CLAUDE_SESSION_ID.trim()) || resolveSessionId({ context: "cli" });
      const state = createInitialMergeReadinessState(directory, args.summary, sessionId, args.baseRef);
      const blocked = state.result === 'blocked';
      return { content: [{ type: 'text' as const, text: blocked ? `Merge-readiness blocked: ${state.validation_errors?.join(' ') ?? 'missing evidence'}` : `Merge-readiness started (profile: ${state.profile}, threshold: ${state.threshold}, max rounds: ${state.max_rounds}). Awaiting content via merge_readiness_set_content.` }], ...(blocked ? { isError: true } : {}) };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Merge-readiness error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  } as ToolDefinition<any>,
  {
    name: 'merge_readiness_set_content',
    description: 'Validate and submit the five-section merge-readiness report and objective MCQs. Requires an active gate (call merge_readiness_start first).',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    schema: {
      why: z.string().max(10000), whatChanged: z.string().max(10000), tradeoffs: z.string().max(10000), risksConsidered: z.string().max(10000), teamUnderstanding: z.string().max(10000),
      questions: z.array(z.object({ id: z.string().max(100), dimension: z.enum(['why', 'change', 'tradeoff', 'risk', 'team']), stem: z.string().max(2000), options: z.array(z.object({ id: z.string().max(100), text: z.string().max(1000) })).max(8), correctOptionId: z.string().max(100), rationale: z.string().max(2000).optional() })).max(8),
      workingDirectory: z.string().optional(), session_id: z.string().optional(),
    },
    handler: async (args: { why: string; whatChanged: string; tradeoffs: string; risksConsidered: string; teamUnderstanding: string; questions: Array<any>; workingDirectory?: string; session_id?: string }) => {
      try {
      const directory = resolveStateWorkingDirectory(args.workingDirectory);
      const sessionId = (args.session_id && args.session_id.trim()) || (process.env.CLAUDE_SESSION_ID && process.env.CLAUDE_SESSION_ID.trim()) || resolveSessionId({ context: "cli" });
      const state = setMergeReadinessContent(directory, args, sessionId);
      if (!state || !state.active) {
        return { content: [{ type: 'text' as const, text: 'Merge-readiness content rejected: no active gate (the gate is missing or already terminal - pass/cancelled/overridden). Call merge_readiness_start first.' }], isError: true };
      }
      const errors = state.validation_errors ?? [];
      return { content: [{ type: 'text' as const, text: errors.length > 0 ? `Merge-readiness content rejected: ${errors.join(' ')}` : `Merge-readiness content accepted. Next question: ${state.pending_question?.id ?? 'none'}` }], ...(errors.length > 0 ? { isError: true } : {}) };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Merge-readiness error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  } as ToolDefinition<any>,
  {
    name: 'merge_readiness_record_answer',
    description: 'Record the human-selected option for the current merge-readiness MCQ. Advances the gate; returns the next question or the final result plus readiness score.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    schema: {
      questionId: z.string().max(100),
      optionId: z.string().max(100),
      workingDirectory: z.string().optional(), session_id: z.string().optional(),
    },
    handler: async (args: { questionId: string; optionId: string; workingDirectory?: string; session_id?: string }) => {
      try {
      const directory = resolveStateWorkingDirectory(args.workingDirectory);
      const sessionId = (args.session_id && args.session_id.trim()) || (process.env.CLAUDE_SESSION_ID && process.env.CLAUDE_SESSION_ID.trim()) || resolveSessionId({ context: "cli" });
      const state = recordMergeReadinessMCQAnswer(directory, args.questionId, args.optionId, sessionId);
      if (!state) {
        return { content: [{ type: 'text' as const, text: 'Merge-readiness answer rejected: no active gate, or the questionId/optionId does not match the current MCQ.' }], isError: true };
      }
      const result = state.result;
      const score = state.readiness_score;
      const persistFailed = result === 'blocked' && (state.validation_errors ?? []).some((e) => e.includes('persisted'));
      const text = persistFailed
        ? `Merge-readiness answer NOT recorded: state could not be persisted (read-only state dir / full disk / invalid path). The gate is still armed on disk. ${(state.validation_errors ?? []).join(' ')}`
        : result === 'pass' || result === 'paused' || result === 'blocked' || result === 'overridden'
          ? `Merge-readiness ${result}. Readiness score: ${score}. ${result === 'pass' ? 'The change may proceed to human merge approval.' : result === 'paused' ? 'Explanation gap remains; reread the report and rerun /merge-readiness.' : result === 'blocked' ? 'Missing evidence; produce it before rerunning.' : 'Gate overridden; terminal session state preserves the record.'}`
          : `Answer recorded. Next question: ${state.pending_question?.id ?? 'none'}. Answered: ${state.answers.length}/${state.questions.length}.`;
      return { content: [{ type: 'text' as const, text }], ...(persistFailed ? { isError: true } : {}) };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Merge-readiness error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  } as ToolDefinition<any>,
  {
    name: 'merge_readiness_report',
    description: 'Render the authoritative merge-readiness session state as a Markdown report without writing a file.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    schema: { workingDirectory: z.string().optional(), session_id: z.string().optional() },
    handler: async (args: { workingDirectory?: string; session_id?: string }) => {
      try {
      const directory = resolveStateWorkingDirectory(args.workingDirectory);
      const sessionId = (args.session_id && args.session_id.trim()) || (process.env.CLAUDE_SESSION_ID && process.env.CLAUDE_SESSION_ID.trim()) || resolveSessionId({ context: 'cli' });
      const state = readMergeReadinessState(directory, sessionId);
      if (!state) {
        return { content: [{ type: 'text' as const, text: 'Merge-readiness report unavailable: no session state found.' }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: formatMergeReadinessReport(state) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Merge-readiness error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  } as ToolDefinition<any>,
  {
    name: 'merge_readiness_cancel',
    description: 'Cancel an active merge-readiness gate while preserving its terminal state audit record.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    schema: { workingDirectory: z.string().optional(), session_id: z.string().optional() },
    handler: async (args: { workingDirectory?: string; session_id?: string }) => {
      try {
      const directory = resolveStateWorkingDirectory(args.workingDirectory);
      const sessionId = (args.session_id && args.session_id.trim()) || (process.env.CLAUDE_SESSION_ID && process.env.CLAUDE_SESSION_ID.trim()) || resolveSessionId({ context: 'cli' });
      const state = cancelMergeReadiness(directory, sessionId);
      const persistFailed = state?.result === 'blocked' && (state.validation_errors ?? []).some((e) => e.includes('persisted'));
      if (persistFailed) {
        return { content: [{ type: 'text' as const, text: `Merge-readiness cancellation FAILED: state could not be persisted (read-only state dir / full disk). The gate is still armed on disk. ${(state?.validation_errors ?? []).join(' ')}` }], isError: true };
      }
      if (!state || state.result !== 'cancelled') {
        return { content: [{ type: 'text' as const, text: 'Merge-readiness cancellation rejected: no active gate.' }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: 'Merge-readiness cancelled. Terminal session state preserved as the audit record.' }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Merge-readiness error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  } as ToolDefinition<any>,
];
