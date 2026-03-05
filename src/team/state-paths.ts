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
export function normalizeTaskFileStem(taskId: string): string {
  const trimmed = String(taskId).trim().replace(/\.json$/i, '');
  if (/^task-\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `task-${trimmed}`;
  return trimmed;
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

  mailbox: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/mailbox/${workerName}.json`,

  mailboxLockDir: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/mailbox/.lock-${workerName}`,

  dispatchRequests: (teamName: string) =>
    `.omc/state/team/${teamName}/dispatch/requests.json`,

  dispatchLockDir: (teamName: string) =>
    `.omc/state/team/${teamName}/dispatch/.lock`,

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

  workerIdentity: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/identity.json`,

  workerAgentsMd: (teamName: string) =>
    `.omc/state/team/${teamName}/worker-agents.md`,

  shutdownRequest: (teamName: string, workerName: string) =>
    `.omc/state/team/${teamName}/workers/${workerName}/shutdown-request.json`,
} as const;

/**
 * Get absolute path for a team state file.
 */
export function absPath(cwd: string, relativePath: string): string {
  return join(cwd, relativePath);
}

/**
 * Get absolute root path for a team's state directory.
 */
export function teamStateRoot(cwd: string, teamName: string): string {
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
export function getTaskStoragePath(cwd: string, teamName: string, taskId?: string): string {
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
export function getLegacyTaskStoragePath(claudeConfigDir: string, teamName: string, taskId?: string): string {
  if (taskId !== undefined) {
    return join(claudeConfigDir, 'tasks', teamName, `${taskId}.json`);
  }
  return join(claudeConfigDir, 'tasks', teamName);
}
