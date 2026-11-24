import type { TeamInstanceId, WorkerInfo, WorkerLaunchDescriptor } from './types.js';
export type WorkerProviderLiveness = 'alive' | 'dead' | 'unknown';
export type ProviderLivenessWorker = Pick<WorkerInfo, 'name' | 'pane_id' | 'worker_cli' | 'launch_attempt_id'> & {
    launch_descriptor?: WorkerLaunchDescriptor;
};
/**
 * Read provider execution health from the exact launch receipt.  A missing or
 * malformed attempt is deliberately unknown; pane liveness is not a provider
 * termination proof.  Only `dead` may be used to refuse pane input: cmux can
 * never prove death and legacy teams have no launch attempt.
 */
export declare function getWorkerProviderLiveness(teamName: string, cwd: string, instanceId: TeamInstanceId | string | undefined, worker: ProviderLivenessWorker): Promise<WorkerProviderLiveness>;
//# sourceMappingURL=worker-provider-liveness.d.ts.map