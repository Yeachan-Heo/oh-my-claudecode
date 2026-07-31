export interface RecoveryActivationGate {
    recoveryId: string;
    workerName: string;
    replacementGeneration: number;
    paneAttemptId: string;
    readyPath: string;
    activatePath: string;
    runPath: string;
    providerArgv: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    pollIntervalMs?: number;
    timeoutMs?: number;
}
export type RecoveryActivationGateResult = {
    outcome: 'ran';
    exitCode: number | null;
    signal: NodeJS.Signals | null;
} | {
    outcome: 'activation_timeout' | 'run_timeout' | 'invalid_provider_argv' | 'provider_spawn_failed';
};
interface GateRecord {
    recovery_id: string;
    worker_name: string;
    replacement_generation: number;
    pane_attempt_id: string;
    written_at: string;
}
export declare function waitForRecoveryGateRecord(path: string, expected: Omit<GateRecord, 'written_at'>, timeoutMs: number, pollIntervalMs?: number): Promise<boolean>;
/**
 * Provider-independent activation barrier. The provider process is not created
 * until the runtime owner has first published activate and then run for this
 * exact pane attempt. Credentials are deliberately not written by this runner.
 */
export declare function runWorkerActivationGate(gate: RecoveryActivationGate): Promise<RecoveryActivationGateResult>;
export {};
//# sourceMappingURL=worker-activation-gate.d.ts.map