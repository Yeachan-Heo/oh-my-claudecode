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
export declare function normalizeTaskFileStem(taskId: string): string;
export declare const TeamPaths: {
    readonly root: (teamName: string) => string;
    readonly config: (teamName: string) => string;
    readonly shutdown: (teamName: string) => string;
    readonly tasks: (teamName: string) => string;
    readonly taskFile: (teamName: string, taskId: string) => string;
    readonly workers: (teamName: string) => string;
    readonly workerDir: (teamName: string, workerName: string) => string;
    readonly heartbeat: (teamName: string, workerName: string) => string;
    readonly inbox: (teamName: string, workerName: string) => string;
    readonly outbox: (teamName: string, workerName: string) => string;
    readonly ready: (teamName: string, workerName: string) => string;
    readonly overlay: (teamName: string, workerName: string) => string;
    readonly shutdownAck: (teamName: string, workerName: string) => string;
    readonly mailbox: (teamName: string, workerName: string) => string;
    readonly mailboxLockDir: (teamName: string, workerName: string) => string;
    readonly dispatchRequests: (teamName: string) => string;
    readonly dispatchLockDir: (teamName: string) => string;
    readonly workerStatus: (teamName: string, workerName: string) => string;
    readonly workerIdleNotify: (teamName: string) => string;
    readonly workerPrevNotifyState: (teamName: string, workerName: string) => string;
    readonly events: (teamName: string) => string;
    readonly approval: (teamName: string, taskId: string) => string;
    readonly manifest: (teamName: string) => string;
    readonly monitorSnapshot: (teamName: string) => string;
    readonly summarySnapshot: (teamName: string) => string;
    readonly phaseState: (teamName: string) => string;
    readonly scalingLock: (teamName: string) => string;
    readonly workerIdentity: (teamName: string, workerName: string) => string;
    readonly workerAgentsMd: (teamName: string) => string;
    readonly shutdownRequest: (teamName: string, workerName: string) => string;
};
/**
 * Get absolute path for a team state file.
 */
export declare function absPath(cwd: string, relativePath: string): string;
/**
 * Get absolute root path for a team's state directory.
 */
export declare function teamStateRoot(cwd: string, teamName: string): string;
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
export declare function getTaskStoragePath(cwd: string, teamName: string, taskId?: string): string;
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
export declare function getLegacyTaskStoragePath(claudeConfigDir: string, teamName: string, taskId?: string): string;
//# sourceMappingURL=state-paths.d.ts.map