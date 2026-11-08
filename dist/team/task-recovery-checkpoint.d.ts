import type { TaskRecoveryCheckpoint, TaskRecoveryCheckpointValidation, TeamTaskV2 } from './types.js';
export declare const MAX_TASK_RECOVERY_CHECKPOINT_BYTES: number;
export interface PublishTaskRecoveryCheckpointInput {
    teamName: string;
    taskId: string;
    workerName: string;
    taskVersion: number;
    claimToken: string;
    sequence: number;
    resumePayload: unknown;
    updatedAt?: string;
}
export interface TaskRecoveryCheckpointTaskAccess {
    readTask: (teamName: string, taskId: string, cwd: string) => Promise<TeamTaskV2 | null>;
    withTaskLock: <T>(teamName: string, taskId: string, cwd: string, fn: () => Promise<T>) => Promise<{
        ok: true;
        value: T;
    } | {
        ok: false;
    }>;
}
export type PublishTaskRecoveryCheckpointResult = {
    ok: true;
    checkpoint: TaskRecoveryCheckpoint;
    path: string;
    replayed: boolean;
} | {
    ok: false;
    error: 'claim_conflict' | 'invalid_checkpoint' | 'publication_conflict';
};
export declare function hashTaskRecoveryCheckpointPayload(payload: unknown): string;
export declare function taskRecoveryClaimTokenHash(claimToken: string): string;
export declare function publishTaskRecoveryCheckpoint(input: PublishTaskRecoveryCheckpointInput, cwd: string, access: TaskRecoveryCheckpointTaskAccess): Promise<PublishTaskRecoveryCheckpointResult>;
export declare function selectTaskRecoveryCheckpoint(teamName: string, task: TeamTaskV2, cwd: string): Promise<TaskRecoveryCheckpointValidation>;
export declare function readTaskRecoveryCheckpoint(path: string): Promise<TaskRecoveryCheckpointValidation>;
//# sourceMappingURL=task-recovery-checkpoint.d.ts.map