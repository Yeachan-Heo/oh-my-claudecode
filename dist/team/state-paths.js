import { join } from 'path';
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
    mailbox: (teamName, workerName) => `.omc/state/team/${teamName}/mailbox/${workerName}.json`,
    mailboxLockDir: (teamName, workerName) => `.omc/state/team/${teamName}/mailbox/.lock-${workerName}`,
    dispatchRequests: (teamName) => `.omc/state/team/${teamName}/dispatch/requests.json`,
    dispatchLockDir: (teamName) => `.omc/state/team/${teamName}/dispatch/.lock`,
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
    workerIdentity: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/identity.json`,
    workerAgentsMd: (teamName) => `.omc/state/team/${teamName}/worker-agents.md`,
    shutdownRequest: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/shutdown-request.json`,
};
/**
 * Get absolute path for a team state file.
 */
export function absPath(cwd, relativePath) {
    return join(cwd, relativePath);
}
/**
 * Get absolute root path for a team's state directory.
 */
export function teamStateRoot(cwd, teamName) {
    return join(cwd, TeamPaths.root(teamName));
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
    if (taskId !== undefined) {
        return join(cwd, TeamPaths.taskFile(teamName, taskId));
    }
    return join(cwd, TeamPaths.tasks(teamName));
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