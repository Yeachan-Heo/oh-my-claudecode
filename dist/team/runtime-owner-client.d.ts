import { readLatestOwnerEpoch } from './team-owner-epoch.js';
import type { RecoverDeadWorkerV2Result } from './types.js';
export interface RecoveryOwnerBootstrap {
    expectedEpoch: number;
    predecessorEpoch: number;
    predecessorNonce: string | null;
    predecessorPid: number | null;
    predecessorProcessStartedAt: string | null;
    pid: number;
    processStartedAt: string;
    nonce: string;
    recoveryId: string;
}
export interface RecoverDeadWorkerOwnerInput {
    teamName: string;
    cwd: string;
    workerName: string;
    requestId: string;
    timeoutMs?: number;
    bootstrap?: RecoveryOwnerBootstrap;
}
export interface RecoveryOwnerClient {
    recoverDeadWorker(input: RecoverDeadWorkerOwnerInput): Promise<RecoverDeadWorkerV2Result>;
}
export type RecoveryOwnerDispatch = (input: RecoverDeadWorkerOwnerInput) => Promise<RecoverDeadWorkerV2Result>;
export declare function withRecoveryAdmissionLock<T>(cwd: string, payloadHash: string, fn: () => Promise<T> | T): Promise<T>;
export interface RecoveryIntentRecord {
    schema_version: 1;
    kind: 'recover-worker';
    request_id: string;
    recovery_id: string;
    team_name: string;
    worker_name: string;
    operation: 'recover-worker';
    workspace_hash: string;
    payload_hash: string;
    created_at: string;
}
declare function publishRecoveryOwnerBootstrapCandidate(input: RecoverDeadWorkerOwnerInput, recoveryId: string, expectedEpoch: number, nonce: string, pid: number, processStartedAt: string, predecessor: ReturnType<typeof readLatestOwnerEpoch>): Promise<void>;
declare function hasLiveOrUnknownBootstrapCandidate(input: RecoverDeadWorkerOwnerInput, recoveryId: string, expectedEpoch: number, predecessor: ReturnType<typeof readLatestOwnerEpoch>): boolean;
/** Narrow white-box hooks for deterministic crash/retry protocol tests. */
export declare const recoveryOwnerBootstrapTestHooks: {
    publishCandidate: typeof publishRecoveryOwnerBootstrapCandidate;
    hasLiveOrUnknownCandidate: typeof hasLiveOrUnknownBootstrapCandidate;
};
export declare function parseRecoveryIntent(raw: string): RecoveryIntentRecord;
export declare function isExpectedRecoveryOwnerSuccessor(owner: ReturnType<typeof readLatestOwnerEpoch>, expectedEpoch: number, childPid: number, childProcessStartedAt: string | null, fenceOk: boolean, expectedNonce?: string): boolean;
/** Durable admission/replay client. The injected owner alone performs recovery effects. */
export declare function createRecoveryOwnerClient(dispatch: RecoveryOwnerDispatch, timing?: {
    minTimeoutMs?: number;
    maxTimeoutMs?: number;
    pollIntervalMs?: number;
    persistentOwnerBootstrap?: boolean;
    bootstrapOwner?: (input: RecoverDeadWorkerOwnerInput, priorEpoch: number | null) => Promise<boolean>;
}): RecoveryOwnerClient;
/** Install the long-lived owner dispatcher without coupling the public client to runtime-cli startup. */
export declare function setRuntimeOwnerDispatch(dispatch: RecoveryOwnerDispatch | undefined): void;
/**
 * Stable named client used by runtime-v2. Admission is durable and dispatch is
 * non-recursive: the runtime owner invokes the private executor, never the
 * public recoverDeadWorkerV2 facade.
 */
export declare function requestRuntimeOwnerRecovery(input: RecoverDeadWorkerOwnerInput): Promise<RecoverDeadWorkerV2Result>;
export {};
//# sourceMappingURL=runtime-owner-client.d.ts.map