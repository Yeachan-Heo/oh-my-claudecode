import { createHash } from 'node:crypto';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { getOmcRoot } from '../lib/worktree-paths.js';

/**
 * Typed path builders for all team state files.
 * All paths are relative to cwd.
 *
 * State layout:
 *   .omc/state/team/{teamName}/
 *     config.json
 *     shutdown.json
 *     tasks/
 *       task-{taskId}.json
 *     workers/
 *       {workerName}/
 *         heartbeat.json
 *         inbox.md
 *         outbox.jsonl
 *         .ready          ← sentinel file (worker writes on startup)
 *         AGENTS.md       ← worker overlay
 *         shutdown-ack.json
 *     mailbox/
 *       {workerName}.json
 */
export function normalizeTaskFileStem(taskId: string): string {
  const trimmed = String(taskId).trim().replace(/\.json$/i, '');
  if (/^task-\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `task-${trimmed}`;
  return trimmed;
}

/**
 * Resolve the cwd component of the identity binding used by team lifecycle
 * operations.
 *
 * Team state may be reached through a symlink (or through a path containing
 * `..`).  The lifecycle lock must nevertheless be shared by every spelling of
 * the same workspace. Non-existent paths retain their lexical, resolved
 * spelling so startup can reserve a new workspace before the first state
 * directory is created.
 */
export function canonicalTeamCwd(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync.native(resolved);
  } catch {
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  }
}

function canonicalStoragePath(path: string): string {
  let cursor = resolve(path);
  const missingSuffix: string[] = [];
  const visitedLinks = new Set<string>();
  while (true) {
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        if (visitedLinks.has(cursor)) throw new Error('team_storage_anchor_symlink_cycle');
        visitedLinks.add(cursor);
        cursor = resolve(dirname(cursor), readlinkSync(cursor));
        continue;
      }
      const canonical = (() => {
        try { return realpathSync.native(cursor); } catch { return realpathSync(cursor); }
      })();
      return missingSuffix.length === 0 ? canonical : join(canonical, ...missingSuffix.reverse());
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'team_storage_anchor_symlink_cycle') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      missingSuffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

export const TeamPaths = {
  root: (teamName: string) =>
    `.omc/state/team/${teamName}`,

  config: (teamName: string) =>
    `.omc/state/team/${teamName}/config.json`,

  shutdown: (teamName: string) =>
    `.omc/state/team/${teamName}/shutdown.json`,

  tasks: (teamName: string) =>
    `.omc/state/team/${teamName}/tasks`,

  taskFile: (teamName: string, taskId: string) =>
    `.omc/state/team/${teamName}/tasks/${normalizeTaskFileStem(taskId)}.json`,

  workers: (teamName: string) =>
    `.omc/state/team/${teamName}/workers`,

  workerDir: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}`,

  heartbeat: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/heartbeat.json`,

  inbox: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/inbox.md`,

  outbox: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/outbox.jsonl`,

  ready: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/.ready`,

  overlay: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/AGENTS.md`,

  shutdownAck: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/shutdown-ack.json`,

  workerLaunchAttemptRoot: (teamName: string, workerName: string, attemptId: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}`,

  workerLaunchCurrent: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/current.json`,

  workerLaunchExpected: (teamName: string, workerName: string, attemptId: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/expected.json`,

  workerLaunchAck: (teamName: string, workerName: string, attemptId: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/ack.json`,

  workerLaunchStarted: (teamName: string, workerName: string, attemptId: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/provider-started.json`,

  workerLaunchTransportOwner: (teamName: string, workerName: string, attemptId: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/transport-owner.json`,

  workerLaunchBootstrapDescriptor: (teamName: string, workerName: string, attemptId: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/bootstrap.json`,

  workerLaunchWrapper: (teamName: string, workerName: string, attemptId: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/launch.cmd`,

  workerLaunchTransportCleanupComplete: (teamName: string, workerName: string, attemptId: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/transport-cleanup-complete.json`,

  workerLaunchDecision: (teamName: string, workerName: string, attemptId: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/decision.json`,

  mailbox: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/mailbox/${workerName}.json`,

  mailboxLockDir: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/mailbox/.lock-${workerName}`,

  dispatchRequests: (teamName: string) =>
    `.omc/state/team/${teamName}/dispatch/requests.json`,

  dispatchLockDir: (teamName: string) =>
    `.omc/state/team/${teamName}/dispatch/.lock`,
  mailboxNotificationLock: (teamName: string, requestId: string) =>
    `.omc/state/team/${teamName}/dispatch/.mailbox-notification-${createHash('sha256').update(requestId).digest('hex')}.lock`,

  workerStatus: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/status.json`,

  workerIdleNotify: (teamName: string) =>
    `.omc/state/team/${teamName}/worker-idle-notify.json`,

  workerPrevNotifyState: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/prev-notify-state.json`,

  events: (teamName: string) =>
    `.omc/state/team/${teamName}/events.jsonl`,

  approval: (teamName: string, taskId: string) =>
    `.omc/state/team/${teamName}/approvals/${taskId}.json`,

  manifest: (teamName: string) =>
    `.omc/state/team/${teamName}/manifest.json`,

  monitorSnapshot: (teamName: string) =>
    `.omc/state/team/${teamName}/monitor-snapshot.json`,

  summarySnapshot: (teamName: string) =>
    `.omc/state/team/${teamName}/summary-snapshot.json`,

  phaseState: (teamName: string) =>
    `.omc/state/team/${teamName}/phase-state.json`,

  scalingLock: (teamName: string) =>
    `.omc/state/team/${teamName}/.scaling-lock`,
  configMutationLock: (teamName: string) =>
    `.omc/state/team/${teamName}/.config-mutation.lock`,

  workerIdentity: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/identity.json`,

  workerAgentsMd: (teamName: string) =>
    `.omc/state/team/${teamName}/worker-agents.md`,

  shutdownRequest: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/shutdown-request.json`,
  checkpoints: (teamName: string, taskId: string, claimTokenHash: string) =>
    `.omc/state/team/${teamName}/checkpoints/${normalizeTaskFileStem(taskId)}/${claimTokenHash}`,
  checkpoint: (teamName: string, taskId: string, claimTokenHash: string, sequence: number) =>
    `.omc/state/team/${teamName}/checkpoints/${normalizeTaskFileStem(taskId)}/${claimTokenHash}/${sequence}.json`,
  checkpointLatest: (teamName: string, taskId: string, claimTokenHash: string) =>
    `.omc/state/team/${teamName}/checkpoints/${normalizeTaskFileStem(taskId)}/${claimTokenHash}/latest.json`,
  taskRecoverySidecar: (teamName: string, recoveryId: string, taskId: string) => {
    if (recoveryId.length === 0 || recoveryId.length > 128 || recoveryId === '.' || recoveryId === '..'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(recoveryId)) {
      throw new Error('invalid_recovery_request_id');
    }
    const taskStem = normalizeTaskFileStem(taskId);
    if (!/^task-\d+$/.test(taskStem)) throw new Error('invalid_task_id');
    return `.omc/state/team/${teamName}/recovery/task-sidecars/${recoveryId}/${taskStem}.json`;
  },
  taskRecoveryReservation: (teamName: string, taskId: string) =>
    `.omc/state/team/${teamName}/recovery/reservations/${normalizeTaskFileStem(taskId)}.json`,
  ownerEpochs: (teamName: string) =>
    `.omc/state/team/${teamName}/recovery/owner-epochs`,
  ownerEpoch: (teamName: string, epoch: number) =>
    `.omc/state/team/${teamName}/recovery/owner-epochs/${epoch}.json`,
  recoveryOwnerBootstrapCandidate: (teamName: string, expectedEpoch: number, nonce: string) => {
    if (nonce.length === 0 || nonce.length > 128 || nonce === '.' || nonce === '..'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(nonce)) throw new Error('invalid_recovery_owner_bootstrap_nonce');
    return `.omc/state/team/${teamName}/recovery/owner-bootstrap/${expectedEpoch}/${nonce}.json`;
  },
  recoveryIntents: (teamName: string) =>
    `.omc/state/team/${teamName}/recovery/intents`,
  recoveryIntent: (teamName: string, recoveryId: string) =>
    `.omc/state/team/${teamName}/recovery/intents/${recoveryId}.json`,
  recoveryAttempts: (teamName: string) =>
    `.omc/state/team/${teamName}/recovery/attempts`,
  recoveryAttempt: (teamName: string, recoveryId: string) =>
    `.omc/state/team/${teamName}/recovery/attempts/${recoveryId}.json`,
  recoveryActivation: (teamName: string, recoveryId: string, paneAttemptId: string) =>
    `.omc/state/team/${teamName}/recovery/activation/${recoveryId}/${paneAttemptId}`,
  recoveryReady: (teamName: string, recoveryId: string, paneAttemptId: string) =>
    `.omc/state/team/${teamName}/recovery/activation/${recoveryId}/${paneAttemptId}/ready.json`,
  recoveryActivate: (teamName: string, recoveryId: string, paneAttemptId: string) =>
    `.omc/state/team/${teamName}/recovery/activation/${recoveryId}/${paneAttemptId}/activate.json`,
  recoveryRun: (teamName: string, recoveryId: string, paneAttemptId: string) =>
    `.omc/state/team/${teamName}/recovery/activation/${recoveryId}/${paneAttemptId}/run.json`,
  recoveryRequestsRoot: () => '.omc/state/team-recovery/by-request',
  recoveryAdmissionLock: (payloadHash: string) =>
    `.omc/state/team-recovery/admission-locks/${payloadHash}.lock`,
  recoveryLifecycleLock: (workspaceHash: string, teamName: string) =>
    `.omc/state/team-recovery/lifecycle-locks/${workspaceHash}/${teamName}.lock`,
  /**
   * External team-instance authority.  These paths deliberately live outside
   * `.omc/state/team/{teamName}` so cleanup can retain authorization after the
   * state tree is detached or partially removed.
   */
  teamInstanceAuthorityRoot: (workspaceHash: string, teamName: string) =>
    `.omc/state/team-recovery/team-instances/${workspaceHash}/${teamName}`,
  teamInstanceReservation: (workspaceHash: string, teamName: string) =>
    `.omc/state/team-recovery/team-instances/${workspaceHash}/${teamName}/reservation.json`,
  teamInstanceCleanupRoot: (workspaceHash: string, teamName: string, instanceId: string) =>
    `.omc/state/team-recovery/team-instances/${workspaceHash}/${teamName}/${instanceId}`,
  teamInstanceCleanupReceipt: (workspaceHash: string, teamName: string, instanceId: string) =>
    `.omc/state/team-recovery/team-instances/${workspaceHash}/${teamName}/${instanceId}/cleanup.json`,
  teamInstanceDetachedRoot: (workspaceHash: string, teamName: string, instanceId: string) =>
    `.omc/state/team-recovery/team-instances/${workspaceHash}/${teamName}/${instanceId}/detached`,
  recoveryRequestPending: (requestId: string) =>
    `.omc/state/team-recovery/by-request/${requestId}.pending.json`,
  recoveryRequestResult: (requestId: string) =>
    `.omc/state/team-recovery/by-request/${requestId}.result.json`,
  recoveryResultByTeam: (workspaceHash: string, teamName: string, recoveryId: string) =>
    `.omc/state/team-recovery/by-team/${workspaceHash}/${teamName}/${recoveryId}.json`,
  recoveryFinalIndexLock: (workspaceHash: string, teamName: string, recoveryId: string) =>
    `.omc/state/team-recovery/index-locks/${workspaceHash}/${teamName}/${recoveryId}.lock`,
  scalingRollbackFailure: (teamName: string, recordedAt: number) =>
    `.omc/state/team/${teamName}/scaling-rollback/${recordedAt}.json`,
  recoveryPaneRollbackFailure: (teamName: string, recoveryId: string, paneAttemptId: string, recordedAt: number) =>
    `.omc/state/team/${teamName}/recovery/rollback-failures/${recoveryId}/${paneAttemptId}-${recordedAt}.json`,
  recoveryAuditIndex: () => '.omc/state/team-recovery/audit.jsonl',
} as const;

/**
 * Get absolute path for a team state file.
 */
export function absPath(cwd: string, relativePath: string): string {
  if (isAbsolute(relativePath)) return relativePath;
  if (relativePath === '.omc' || relativePath.startsWith('.omc/')) {
    return join(getOmcRoot(cwd), relativePath.slice('.omc'.length).replace(/^\//, ''));
  }
  return join(cwd, relativePath);
}

/** Canonical OMC storage root, with symlink aliases collapsed when possible. */
export function canonicalTeamOmcRoot(cwd: string): string {
  return canonicalStoragePath(getOmcRoot(canonicalTeamCwd(cwd)));
}

/**
 * Canonical absolute path for an OMC-relative state path.  Lifecycle and
 * detached-instance authority must use this helper so cwd aliases cannot
 * produce different physical lock/receipt files.
 */
export function canonicalTeamStatePath(cwd: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    const target = resolve(relativePath);
    const rawAnchor = resolve(getOmcRoot(canonicalTeamCwd(cwd)));
    const suffix = relative(rawAnchor, target);
    if (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) {
      return join(canonicalTeamOmcRoot(cwd), suffix);
    }
    return target;
  }
  if (relativePath === '.omc' || relativePath.startsWith('.omc/')) {
    return join(canonicalTeamOmcRoot(cwd), relativePath.slice('.omc'.length).replace(/^\//, ''));
  }
  return join(canonicalTeamCwd(cwd), relativePath);
}

/**
 * Absolute lifecycle lock shared by startup, mutation, shutdown and external
 * cleanup.  Callers must use this one path rather than deriving a hash from
 * the caller's uncanonicalized cwd.
 */
export function teamInstanceLifecycleLockPath(cwd: string, teamName: string): string {
  return canonicalTeamStatePath(cwd, TeamPaths.recoveryLifecycleLock(teamWorkspaceHash(cwd, teamName), teamName));
}

/**
 * Get absolute root path for a team's state directory.
 */
export function teamStateRoot(cwd: string, teamName: string): string {
  return absPath(cwd, TeamPaths.root(teamName));
}

/**
 * Canonical state storage root used as the ownership key.
 *
 * Only the accepted OMC storage anchor is canonicalized. The team suffix is
 * deliberately appended lexically so a disposable team-root symlink remains
 * visible to `assertTeamStatePathSafe()` instead of being followed.
 */
export function canonicalTeamStateRoot(cwd: string, teamName: string): string {
  return join(canonicalTeamOmcRoot(cwd), 'state', 'team', teamName);
}

/** Stable key derived from the canonical `{OMC root}/state/team/{name}` root. */
export function teamWorkspaceHash(cwd: string, teamName: string): string {
  return createHash('sha256').update(canonicalTeamStateRoot(cwd, teamName)).digest('hex');
}

/**
 * Reject symlink components below the accepted OMC storage anchor.
 *
 * `canonicalTeamOmcRoot()` intentionally canonicalizes the storage anchor
 * itself (a configured storage symlink is an accepted alias), but state and
 * external authority suffixes remain lexical.  Checking each suffix component
 * with `lstat` prevents a disposable team root or receipt parent from routing
 * effects into an unrelated directory.
 */
export async function assertTeamStatePathSafe(cwd: string, path: string): Promise<void> {
  const storageRoot = canonicalTeamOmcRoot(cwd);
  const target = canonicalTeamStatePath(cwd, path);
  const suffix = relative(storageRoot, target);
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error('team_instance_path_outside_storage_root');
  }
  let cursor = storageRoot;
  for (const component of suffix.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('team_instance_path_symlink');
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'team_instance_path_symlink') throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw new Error('team_instance_path_unreadable', { cause: error });
    }
  }
}

/** Synchronous preflight variant used before acquiring a lifecycle lock. */
export function assertTeamStatePathSafeSync(cwd: string, path: string): void {
  const storageRoot = canonicalTeamOmcRoot(cwd);
  const target = canonicalTeamStatePath(cwd, path);
  const suffix = relative(storageRoot, target);
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error('team_instance_path_outside_storage_root');
  }
  let cursor = storageRoot;
  for (const component of suffix.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new Error('team_instance_path_symlink');
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'team_instance_path_symlink') throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw new Error('team_instance_path_unreadable', { cause: error });
    }
  }
}

/**
 * Canonical task storage path builder.
 *
 * All task files live at:
 *   {cwd}/.omc/state/team/{teamName}/tasks/task-{taskId}.json
 *
 * When taskId is omitted, returns the tasks directory:
 *   {cwd}/.omc/state/team/{teamName}/tasks/
 *
 * Use this as the single source of truth for task file locations.
 * New writes always use this canonical path.
 */
export function getTaskStoragePath(cwd: string, teamName: string, taskId?: string): string {
  const tasksRoot = join(getOmcRoot(cwd), 'state', 'team', teamName, 'tasks');
  if (taskId !== undefined) {
    return join(tasksRoot, normalizeTaskFileStem(taskId) + '.json');
  }
  return tasksRoot;
}

/**
 * Legacy task storage path builder (deprecated).
 *
 * Old location: ~/.claude/tasks/{teamName}/{taskId}.json
 *
 * Used only by the compatibility shim in task-file-ops.ts to check
 * for data written by older versions during reads. New code must not
 * write to this path.
 *
 * @deprecated Use getTaskStoragePath instead.
 */
export function getLegacyTaskStoragePath(claudeConfigDir: string, teamName: string, taskId?: string): string {
  if (taskId !== undefined) {
    return join(claudeConfigDir, 'tasks', teamName, `${taskId}.json`);
  }
  return join(claudeConfigDir, 'tasks', teamName);
}
