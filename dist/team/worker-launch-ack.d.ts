import type { CliAgentType } from './model-contract.js';
declare const WORKER_LAUNCH_SCHEMA_VERSION: 1;
interface WorkerLaunchIdentity {
    schema_version: typeof WORKER_LAUNCH_SCHEMA_VERSION;
    attempt_id: string;
    nonce: string;
    team_name: string;
    worker_name: string;
    pane_id: string;
    provider: CliAgentType;
    created_at: string;
}
export interface WorkerLaunchAttempt extends WorkerLaunchIdentity {
    expectedPath: string;
    ackPath: string;
    decisionPath: string;
    runtimeCliPath: string;
}
export interface WorkerLaunchBootstrapSpec extends WorkerLaunchIdentity {
    expected_path: string;
    ack_path: string;
    decision_path: string;
    provider_argv: string[];
    cwd: string;
    decision_timeout_ms: number;
}
export type WorkerLaunchAcceptance = {
    ok: true;
} | {
    ok: false;
    reason: 'ack_timeout' | 'ack_malformed' | 'ack_mismatch' | 'decision_conflict' | 'expected_record_invalid';
};
export type WorkerLaunchBootstrapResult = {
    outcome: 'ran';
    exitCode: number | null;
    signal: NodeJS.Signals | null;
} | {
    outcome: 'invalid_spec' | 'expected_record_invalid' | 'ack_conflict' | 'decision_timeout' | 'revoked' | 'provider_spawn_failed';
};
export declare function prepareWorkerLaunchAttempt(input: {
    cwd: string;
    teamName: string;
    workerName: string;
    paneId: string;
    provider: CliAgentType;
    runtimeCliPath: string;
}): Promise<WorkerLaunchAttempt>;
export declare function loadWorkerLaunchAttempt(input: {
    cwd: string;
    teamName: string;
    workerName: string;
    paneId: string;
    provider: CliAgentType;
    attemptId: string;
    runtimeCliPath: string;
}): Promise<WorkerLaunchAttempt | null>;
export declare function buildWorkerLaunchBootstrapSpec(attempt: WorkerLaunchAttempt, providerArgv: string[], cwd: string): WorkerLaunchBootstrapSpec;
export declare function revokeWorkerLaunchAttempt(attempt: WorkerLaunchAttempt, reason: string): Promise<boolean>;
export declare function awaitWorkerLaunchAcknowledgement(attempt: WorkerLaunchAttempt, options?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
}): Promise<WorkerLaunchAcceptance>;
export declare function isWorkerLaunchAttemptAccepted(attempt: WorkerLaunchAttempt): Promise<boolean>;
export declare function runWorkerLaunchBootstrap(value: unknown): Promise<WorkerLaunchBootstrapResult>;
export {};
//# sourceMappingURL=worker-launch-ack.d.ts.map