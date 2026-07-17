import type { TeamTaskStatus } from '../contracts.js';
import type { TeamTask, TeamTaskV2, TaskReadiness, ClaimTaskResult, TransitionTaskResult, ReleaseTaskClaimResult, TeamMonitorSnapshotState, TaskRecoveryAdoptionProof, TaskRecoveryAdoptionResult, TaskRecoveryCheckpoint, TaskRecoveryRequeueResult, TaskRecoveryRequeueSidecar } from '../types.js';
interface TaskReadDeps {
    readTask: (teamName: string, taskId: string, cwd: string) => Promise<TeamTask | null>;
}
export declare function computeTaskReadiness(teamName: string, taskId: string, cwd: string, deps: TaskReadDeps): Promise<TaskReadiness>;
interface ClaimTaskDeps extends TaskReadDeps {
    teamName: string;
    cwd: string;
    readTeamConfig: (teamName: string, cwd: string) => Promise<{
        workers: Array<{
            name: string;
        }>;
    } | null>;
    withTaskClaimLock: <T>(teamName: string, taskId: string, cwd: string, fn: () => Promise<T>) => Promise<{
        ok: true;
        value: T;
    } | {
        ok: false;
    }>;
    normalizeTask: (task: TeamTask) => TeamTaskV2;
    isTerminalTaskStatus: (status: TeamTaskStatus) => boolean;
    taskFilePath: (teamName: string, taskId: string, cwd: string) => string;
    writeAtomic: (path: string, data: string) => Promise<void>;
}
export declare function claimTask(taskId: string, workerName: string, expectedVersion: number | null, deps: ClaimTaskDeps): Promise<ClaimTaskResult>;
interface TransitionDeps extends ClaimTaskDeps {
    canTransitionTaskStatus: (from: TeamTaskStatus, to: TeamTaskStatus) => boolean;
    appendTeamEvent: (teamName: string, event: {
        type: 'task_completed' | 'task_failed';
        worker: string;
        task_id?: string;
        message_id?: string | null;
        reason?: string;
    }, cwd: string) => Promise<unknown>;
    readMonitorSnapshot: (teamName: string, cwd: string) => Promise<TeamMonitorSnapshotState | null>;
    writeMonitorSnapshot: (teamName: string, snapshot: TeamMonitorSnapshotState, cwd: string) => Promise<void>;
}
export declare function transitionTaskStatus(taskId: string, from: TeamTaskStatus, to: TeamTaskStatus, claimToken: string, terminalData: {
    result?: string;
    error?: string;
} | undefined, deps: TransitionDeps): Promise<TransitionTaskResult>;
type ReleaseDeps = ClaimTaskDeps;
export declare function releaseTaskClaim(taskId: string, claimToken: string, _workerName: string, deps: ReleaseDeps): Promise<ReleaseTaskClaimResult>;
export declare function listTasks(teamName: string, cwd: string, deps: {
    teamDir: (teamName: string, cwd: string) => string;
    isTeamTask: (value: unknown) => value is TeamTask;
    normalizeTask: (task: TeamTask) => TeamTaskV2;
}): Promise<TeamTask[]>;
export interface RecoveryTaskTransitionDeps extends ClaimTaskDeps {
    readRecoverySidecar: (teamName: string, recoveryId: string, taskId: string, cwd: string) => Promise<TaskRecoveryRequeueSidecar | null | 'malformed'>;
    writeRecoverySidecar: (teamName: string, recoveryId: string, taskId: string, sidecar: TaskRecoveryRequeueSidecar, cwd: string) => Promise<void>;
    selectRecoveryCheckpoint: (teamName: string, task: TeamTaskV2, cwd: string) => Promise<{
        ok: true;
        checkpoint: TaskRecoveryCheckpoint;
        path: string;
    } | {
        ok: false;
        error: 'missing' | 'malformed' | 'stale' | 'ambiguous';
    }>;
    readRecoveryCheckpoint: (path: string) => Promise<{
        ok: true;
        checkpoint: TaskRecoveryCheckpoint;
        path: string;
    } | {
        ok: false;
        error: 'missing' | 'malformed' | 'stale' | 'ambiguous';
    }>;
    verifyAdoptionToken: (token: string, hash: string) => boolean;
}
export interface RequeueRecoveredTaskInput {
    recoveryId: string;
    requestId: string;
    taskId: string;
    replacementWorker: string;
    replacementGeneration: number;
    adoptionTokenHash: string;
}
export declare function requeueRecoveredTask(input: RequeueRecoveredTaskInput, deps: RecoveryTaskTransitionDeps): Promise<TaskRecoveryRequeueResult>;
export declare function adoptRecoveryReservations(taskIds: string[], workerName: string, proof: TaskRecoveryAdoptionProof, deps: RecoveryTaskTransitionDeps): Promise<TaskRecoveryAdoptionResult[]>;
export {};
//# sourceMappingURL=tasks.d.ts.map