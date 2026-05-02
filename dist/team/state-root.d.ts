/**
 * Resolve the canonical OMC team state root for a leader working directory.
 *
 * This mirrors the OMX team API helper while preserving OMC's state boundary:
 * the canonical leader root is the state directory that contains `team/<name>`.
 * Runtime worker envs may still pass a team-specific root; worker resolution
 * accepts both root shapes for compatibility.
 */
export declare function resolveCanonicalTeamStateRoot(leaderCwd: string, env?: NodeJS.ProcessEnv): string;
export interface TeamWorkerIdentityRef {
    teamName: string;
    workerName: string;
}
export type WorkerTeamStateRootSource = 'env' | 'leader_cwd' | 'cwd' | 'worker_directory' | 'identity_metadata' | 'manifest_metadata' | 'config_metadata';
export interface WorkerTeamStateRootResolution {
    ok: boolean;
    stateRoot: string | null;
    source: WorkerTeamStateRootSource | null;
    reason?: string;
    identityPath?: string;
    worktreePath?: string;
}
/**
 * Resolve the canonical team state root for an OMC team worker PostToolUse/git hook.
 */
export declare function resolveWorkerTeamStateRoot(cwd: string, worker: TeamWorkerIdentityRef, env?: NodeJS.ProcessEnv): Promise<WorkerTeamStateRootResolution>;
/**
 * Resolve the team state root for non-git worker notify hooks without guessing
 * a local worker worktree state directory when no runtime hint exists.
 */
export declare function resolveWorkerNotifyTeamStateRoot(cwd: string, worker: TeamWorkerIdentityRef, env?: NodeJS.ProcessEnv): Promise<WorkerTeamStateRootResolution>;
export declare function resolveWorkerTeamStateRootPath(cwd: string, worker: TeamWorkerIdentityRef, env?: NodeJS.ProcessEnv): Promise<string | null>;
export declare function resolveWorkerNotifyTeamStateRootPath(cwd: string, worker: TeamWorkerIdentityRef, env?: NodeJS.ProcessEnv): Promise<string | null>;
//# sourceMappingURL=state-root.d.ts.map