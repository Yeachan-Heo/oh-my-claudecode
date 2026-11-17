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
export function normalizeTaskFileStem(taskId) {
    const trimmed = String(taskId).trim().replace(/\.json$/i, '');
    if (/^task-\d+$/.test(trimmed))
        return trimmed;
    if (/^\d+$/.test(trimmed))
        return `task-${trimmed}`;
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
export function canonicalTeamCwd(cwd) {
    const resolved = resolve(cwd);
    try {
        return realpathSync.native(resolved);
    }
    catch {
        try {
            return realpathSync(resolved);
        }
        catch {
            return resolved;
        }
    }
}
function canonicalStoragePath(path) {
    let cursor = resolve(path);
    const missingSuffix = [];
    const visitedLinks = new Set();
    while (true) {
        try {
            const stat = lstatSync(cursor);
            if (stat.isSymbolicLink()) {
                if (visitedLinks.has(cursor))
                    throw new Error('team_storage_anchor_symlink_cycle');
                visitedLinks.add(cursor);
                cursor = resolve(dirname(cursor), readlinkSync(cursor));
                continue;
            }
            const canonical = (() => {
                try {
                    return realpathSync.native(cursor);
                }
                catch {
                    return realpathSync(cursor);
                }
            })();
            return missingSuffix.length === 0 ? canonical : join(canonical, ...missingSuffix.reverse());
        }
        catch (error) {
            if (error instanceof Error && error.message === 'team_storage_anchor_symlink_cycle')
                throw error;
            const parent = dirname(cursor);
            if (parent === cursor)
                return resolve(path);
            missingSuffix.push(basename(cursor));
            cursor = parent;
        }
    }
}
export const TeamPaths = {
    root: (teamName) => `.omc/state/team/${teamName}`,
    config: (teamName) => `.omc/state/team/${teamName}/config.json`,
    shutdown: (teamName) => `.omc/state/team/${teamName}/shutdown.json`,
    tasks: (teamName) => `.omc/state/team/${teamName}/tasks`,
    taskFile: (teamName, taskId) => `.omc/state/team/${teamName}/tasks/${normalizeTaskFileStem(taskId)}.json`,
    workers: (teamName) => `.omc/state/team/${teamName}/workers`,
    workerDir: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}`,
    heartbeat: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/heartbeat.json`,
    inbox: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/inbox.md`,
    outbox: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/outbox.jsonl`,
    ready: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/.ready`,
    overlay: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/AGENTS.md`,
    shutdownAck: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/shutdown-ack.json`,
    workerLaunchAttemptRoot: (teamName, workerName, attemptId) => `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}`,
    workerLaunchCurrent: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/current.json`,
    workerLaunchExpected: (teamName, workerName, attemptId) => `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/expected.json`,
    workerLaunchAck: (teamName, workerName, attemptId) => `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/ack.json`,
    workerLaunchStarted: (teamName, workerName, attemptId) => `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/provider-started.json`,
    workerLaunchTransportOwner: (teamName, workerName, attemptId) => `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/transport-owner.json`,
    workerLaunchBootstrapDescriptor: (teamName, workerName, attemptId) => `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/bootstrap.json`,
    workerLaunchWrapper: (teamName, workerName, attemptId) => `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/launch.cmd`,
    workerLaunchTransportCleanupComplete: (teamName, workerName, attemptId) => `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/transport-cleanup-complete.json`,
    workerLaunchDecision: (teamName, workerName, attemptId) => `.omc/state/team/${teamName}/workers/${workerName}/launch-attempts/${attemptId}/decision.json`,
    mailbox: (teamName, workerName) => `.omc/state/team/${teamName}/mailbox/${workerName}.json`,
    mailboxLockDir: (teamName, workerName) => `.omc/state/team/${teamName}/mailbox/.lock-${workerName}`,
    dispatchRequests: (teamName) => `.omc/state/team/${teamName}/dispatch/requests.json`,
    dispatchLockDir: (teamName) => `.omc/state/team/${teamName}/dispatch/.lock`,
    mailboxNotificationLock: (teamName, requestId) => `.omc/state/team/${teamName}/dispatch/.mailbox-notification-${createHash('sha256').update(requestId).digest('hex')}.lock`,
    workerStatus: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/status.json`,
    workerIdleNotify: (teamName) => `.omc/state/team/${teamName}/worker-idle-notify.json`,
    workerPrevNotifyState: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/prev-notify-state.json`,
    events: (teamName) => `.omc/state/team/${teamName}/events.jsonl`,
    approval: (teamName, taskId) => `.omc/state/team/${teamName}/approvals/${taskId}.json`,
    manifest: (teamName) => `.omc/state/team/${teamName}/manifest.json`,
    monitorSnapshot: (teamName) => `.omc/state/team/${teamName}/monitor-snapshot.json`,
    summarySnapshot: (teamName) => `.omc/state/team/${teamName}/summary-snapshot.json`,
    phaseState: (teamName) => `.omc/state/team/${teamName}/phase-state.json`,
    scalingLock: (teamName) => `.omc/state/team/${teamName}/.scaling-lock`,
    configMutationLock: (teamName) => `.omc/state/team/${teamName}/.config-mutation.lock`,
    workerIdentity: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/identity.json`,
    workerAgentsMd: (teamName) => `.omc/state/team/${teamName}/worker-agents.md`,
    shutdownRequest: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/shutdown-request.json`,
    checkpoints: (teamName, taskId, claimTokenHash) => `.omc/state/team/${teamName}/checkpoints/${normalizeTaskFileStem(taskId)}/${claimTokenHash}`,
    checkpoint: (teamName, taskId, claimTokenHash, sequence) => `.omc/state/team/${teamName}/checkpoints/${normalizeTaskFileStem(taskId)}/${claimTokenHash}/${sequence}.json`,
    checkpointLatest: (teamName, taskId, claimTokenHash) => `.omc/state/team/${teamName}/checkpoints/${normalizeTaskFileStem(taskId)}/${claimTokenHash}/latest.json`,
    taskRecoverySidecar: (teamName, recoveryId, taskId) => {
        if (recoveryId.length === 0 || recoveryId.length > 128 || recoveryId === '.' || recoveryId === '..'
            || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(recoveryId)) {
            throw new Error('invalid_recovery_request_id');
        }
        const taskStem = normalizeTaskFileStem(taskId);
        if (!/^task-\d+$/.test(taskStem))
            throw new Error('invalid_task_id');
        return `.omc/state/team/${teamName}/recovery/task-sidecars/${recoveryId}/${taskStem}.json`;
    },
    taskRecoveryReservation: (teamName, taskId) => `.omc/state/team/${teamName}/recovery/reservations/${normalizeTaskFileStem(taskId)}.json`,
    ownerEpochs: (teamName) => `.omc/state/team/${teamName}/recovery/owner-epochs`,
    ownerEpoch: (teamName, epoch) => `.omc/state/team/${teamName}/recovery/owner-epochs/${epoch}.json`,
    recoveryOwnerBootstrapCandidate: (teamName, expectedEpoch, nonce) => {
        if (nonce.length === 0 || nonce.length > 128 || nonce === '.' || nonce === '..'
            || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(nonce))
            throw new Error('invalid_recovery_owner_bootstrap_nonce');
        return `.omc/state/team/${teamName}/recovery/owner-bootstrap/${expectedEpoch}/${nonce}.json`;
    },
    recoveryIntents: (teamName) => `.omc/state/team/${teamName}/recovery/intents`,
    recoveryIntent: (teamName, recoveryId) => `.omc/state/team/${teamName}/recovery/intents/${recoveryId}.json`,
    recoveryAttempts: (teamName) => `.omc/state/team/${teamName}/recovery/attempts`,
    recoveryAttempt: (teamName, recoveryId) => `.omc/state/team/${teamName}/recovery/attempts/${recoveryId}.json`,
    recoveryActivation: (teamName, recoveryId, paneAttemptId) => `.omc/state/team/${teamName}/recovery/activation/${recoveryId}/${paneAttemptId}`,
    recoveryReady: (teamName, recoveryId, paneAttemptId) => `.omc/state/team/${teamName}/recovery/activation/${recoveryId}/${paneAttemptId}/ready.json`,
    recoveryActivate: (teamName, recoveryId, paneAttemptId) => `.omc/state/team/${teamName}/recovery/activation/${recoveryId}/${paneAttemptId}/activate.json`,
    recoveryRun: (teamName, recoveryId, paneAttemptId) => `.omc/state/team/${teamName}/recovery/activation/${recoveryId}/${paneAttemptId}/run.json`,
    recoveryRequestsRoot: () => '.omc/state/team-recovery/by-request',
    recoveryAdmissionLock: (payloadHash) => `.omc/state/team-recovery/admission-locks/${payloadHash}.lock`,
    recoveryLifecycleLock: (workspaceHash, teamName) => `.omc/state/team-recovery/lifecycle-locks/${workspaceHash}/${teamName}.lock`,
    /**
     * External team-instance authority.  These paths deliberately live outside
     * `.omc/state/team/{teamName}` so cleanup can retain authorization after the
     * state tree is detached or partially removed.
     */
    teamInstanceAuthorityRoot: (workspaceHash, teamName) => `.omc/state/team-recovery/team-instances/${workspaceHash}/${teamName}`,
    teamInstanceReservation: (workspaceHash, teamName) => `.omc/state/team-recovery/team-instances/${workspaceHash}/${teamName}/reservation.json`,
    teamInstanceCleanupRoot: (workspaceHash, teamName, instanceId) => `.omc/state/team-recovery/team-instances/${workspaceHash}/${teamName}/${instanceId}`,
    teamInstanceCleanupReceipt: (workspaceHash, teamName, instanceId) => `.omc/state/team-recovery/team-instances/${workspaceHash}/${teamName}/${instanceId}/cleanup.json`,
    teamInstanceDetachedRoot: (workspaceHash, teamName, instanceId) => `.omc/state/team-recovery/team-instances/${workspaceHash}/${teamName}/${instanceId}/detached`,
    recoveryRequestPending: (requestId) => `.omc/state/team-recovery/by-request/${requestId}.pending.json`,
    recoveryRequestResult: (requestId) => `.omc/state/team-recovery/by-request/${requestId}.result.json`,
    recoveryResultByTeam: (workspaceHash, teamName, recoveryId) => `.omc/state/team-recovery/by-team/${workspaceHash}/${teamName}/${recoveryId}.json`,
    recoveryFinalIndexLock: (workspaceHash, teamName, recoveryId) => `.omc/state/team-recovery/index-locks/${workspaceHash}/${teamName}/${recoveryId}.lock`,
    scalingRollbackFailure: (teamName, recordedAt) => `.omc/state/team/${teamName}/scaling-rollback/${recordedAt}.json`,
    recoveryPaneRollbackFailure: (teamName, recoveryId, paneAttemptId, recordedAt) => `.omc/state/team/${teamName}/recovery/rollback-failures/${recoveryId}/${paneAttemptId}-${recordedAt}.json`,
    recoveryAuditIndex: () => '.omc/state/team-recovery/audit.jsonl',
};
/**
 * Get absolute path for a team state file.
 */
export function absPath(cwd, relativePath) {
    if (isAbsolute(relativePath))
        return relativePath;
    if (relativePath === '.omc' || relativePath.startsWith('.omc/')) {
        return join(getOmcRoot(cwd), relativePath.slice('.omc'.length).replace(/^\//, ''));
    }
    return join(cwd, relativePath);
}
/** Canonical OMC storage root, with symlink aliases collapsed when possible. */
export function canonicalTeamOmcRoot(cwd) {
    return canonicalStoragePath(getOmcRoot(canonicalTeamCwd(cwd)));
}
/**
 * Canonical absolute path for an OMC-relative state path.  Lifecycle and
 * detached-instance authority must use this helper so cwd aliases cannot
 * produce different physical lock/receipt files.
 */
export function canonicalTeamStatePath(cwd, relativePath) {
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
export function teamInstanceLifecycleLockPath(cwd, teamName) {
    return canonicalTeamStatePath(cwd, TeamPaths.recoveryLifecycleLock(teamWorkspaceHash(cwd, teamName), teamName));
}
/**
 * Get absolute root path for a team's state directory.
 */
export function teamStateRoot(cwd, teamName) {
    return absPath(cwd, TeamPaths.root(teamName));
}
/**
 * Canonical state storage root used as the ownership key.
 *
 * Only the accepted OMC storage anchor is canonicalized. The team suffix is
 * deliberately appended lexically so a disposable team-root symlink remains
 * visible to `assertTeamStatePathSafe()` instead of being followed.
 */
export function canonicalTeamStateRoot(cwd, teamName) {
    return join(canonicalTeamOmcRoot(cwd), 'state', 'team', teamName);
}
/** Stable key derived from the canonical `{OMC root}/state/team/{name}` root. */
export function teamWorkspaceHash(cwd, teamName) {
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
export async function assertTeamStatePathSafe(cwd, path) {
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
            if (stat.isSymbolicLink())
                throw new Error('team_instance_path_symlink');
        }
        catch (error) {
            if (error instanceof Error && error.message === 'team_instance_path_symlink')
                throw error;
            if (error.code === 'ENOENT')
                break;
            throw new Error('team_instance_path_unreadable', { cause: error });
        }
    }
}
/** Synchronous preflight variant used before acquiring a lifecycle lock. */
export function assertTeamStatePathSafeSync(cwd, path) {
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
            if (stat.isSymbolicLink())
                throw new Error('team_instance_path_symlink');
        }
        catch (error) {
            if (error instanceof Error && error.message === 'team_instance_path_symlink')
                throw error;
            if (error.code === 'ENOENT')
                break;
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
export function getTaskStoragePath(cwd, teamName, taskId) {
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
export function getLegacyTaskStoragePath(claudeConfigDir, teamName, taskId) {
    if (taskId !== undefined) {
        return join(claudeConfigDir, 'tasks', teamName, `${taskId}.json`);
    }
    return join(claudeConfigDir, 'tasks', teamName);
}
//# sourceMappingURL=state-paths.js.map