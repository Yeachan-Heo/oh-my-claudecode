export interface WorkerPermissions {
    workerName: string;
    allowedPaths: string[];
    deniedPaths: string[];
    allowedCommands: string[];
    maxFileSize: number;
}
/**
 * Check if a worker is allowed to modify a given path.
 * Denied paths override allowed paths.
 */
export declare function isPathAllowed(permissions: WorkerPermissions, filePath: string, workingDirectory: string): boolean;
/**
 * Check if a worker is allowed to run a given command.
 * Empty allowedCommands means all commands are allowed.
 */
export declare function isCommandAllowed(permissions: WorkerPermissions, command: string): boolean;
/**
 * Generate permission instructions for inclusion in worker prompt.
 */
export declare function formatPermissionInstructions(permissions: WorkerPermissions): string;
/**
 * Default permissions (allow all within working directory).
 */
export declare function getDefaultPermissions(workerName: string): WorkerPermissions;
/**
 * Merge caller-provided permissions with secure deny-defaults.
 * The deny-defaults are always prepended to deniedPaths so they cannot be overridden.
 */
export declare function getEffectivePermissions(base?: Partial<WorkerPermissions> & {
    workerName: string;
}): WorkerPermissions;
/** A single permission violation */
export interface PermissionViolation {
    path: string;
    reason: string;
}
/**
 * Check a list of changed file paths against permissions.
 * Returns an array of violations (empty = all paths allowed).
 *
 * @param changedPaths - relative or absolute paths of files that were modified
 * @param permissions - effective permissions to check against
 * @param cwd - working directory for resolving relative paths
 */
export declare function findPermissionViolations(changedPaths: string[], permissions: WorkerPermissions, cwd: string): PermissionViolation[];
//# sourceMappingURL=permissions.d.ts.map