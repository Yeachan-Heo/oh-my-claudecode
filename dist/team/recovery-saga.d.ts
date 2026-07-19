import type { RecoverDeadWorkerV2Error, RecoverDeadWorkerV2Result, TaskRecoveryAdoptionProof, TeamTask } from './types.js';
export interface RecoverySagaInput {
    requestId: string;
    recoveryId: string;
    teamName: string;
    workerName: string;
    replacementGeneration: number;
    /** Owner-only secret. Never place this value in a task reservation. */
    adoptionToken: string;
    /** Persisted original pane identity; confirmed live/dead before a success is returned. */
    originalPaneId?: string;
}
export interface RecoverySagaDependencies {
    cwd: string;
    getLiveness: (teamName: string, workerName: string) => Promise<'dead' | 'alive' | 'unknown'>;
    listOwnedInProgressTasks: (teamName: string, workerName: string) => Promise<TeamTask[]>;
    /** Must validate every checkpoint before any transition is made. */
    validateCheckpoint: (teamName: string, task: TeamTask) => Promise<{
        ok: true;
        sequence: number;
    } | {
        ok: false;
        error: RecoverDeadWorkerV2Error;
    }>;
    requeue: (input: RecoverySagaInput, taskId: string, adoptionTokenHash: string) => Promise<{
        ok: true;
        sequence: number;
    } | {
        ok: false;
        error: RecoverDeadWorkerV2Error;
    }>;
    spawnGatedPane: (input: RecoverySagaInput) => Promise<{
        ok: true;
        paneId: string;
        paneAttemptId: string;
        committed: boolean;
        stateRevision?: number;
        manifestSync?: 'synced' | 'repair_required';
    } | {
        ok: false;
        error: RecoverDeadWorkerV2Error;
    }>;
    /** Writes activate only after the attempt-specific ready marker is observed. */
    activatePane: (input: RecoverySagaInput, paneAttemptId: string) => Promise<{
        ok: true;
    } | {
        ok: false;
        error: RecoverDeadWorkerV2Error;
    }>;
    /** Runtime-owner operation: adopts all reservations in order, before run. */
    adoptAll: (input: RecoverySagaInput, proof: TaskRecoveryAdoptionProof, taskIds: string[]) => Promise<{
        ok: true;
        continuations: Array<{
            taskId: string;
            taskVersion: number;
            sequence: number;
            payload: unknown;
            claimToken: string;
        }>;
    } | {
        ok: false;
        error: RecoverDeadWorkerV2Error;
    }>;
    writeRun: (input: RecoverySagaInput, paneAttemptId: string, continuations: Array<{
        taskId: string;
        taskVersion: number;
        sequence: number;
        payload: unknown;
        claimToken: string;
    }>) => Promise<void>;
    persistActive: (input: RecoverySagaInput, paneId: string) => Promise<{
        stateRevision: number;
        manifestSync: 'synced' | 'repair_required';
    }>;
    repairServices: (input: RecoverySagaInput) => Promise<'synced' | 'repair_required'>;
    killAttemptPane: (paneAttemptId: string) => Promise<void>;
}
/** Recovery-only transaction. It intentionally has no general worker scaling behavior. */
export declare function runRecoverySaga(input: RecoverySagaInput, deps: RecoverySagaDependencies): Promise<RecoverDeadWorkerV2Result>;
//# sourceMappingURL=recovery-saga.d.ts.map