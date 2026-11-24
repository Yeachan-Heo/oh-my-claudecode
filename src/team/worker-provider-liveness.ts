import { resolveRuntimeCliPath } from './runtime-owner-client.js';
import type { TeamInstanceId, WorkerInfo, WorkerLaunchDescriptor } from './types.js';
import { loadWorkerLaunchAttempt, observeWorkerLaunchProvider } from './worker-launch-ack.js';

export type WorkerProviderLiveness = 'alive' | 'dead' | 'unknown';

export type ProviderLivenessWorker = Pick<
  WorkerInfo,
  'name' | 'pane_id' | 'worker_cli' | 'launch_attempt_id'
> & {
  launch_descriptor?: WorkerLaunchDescriptor;
};

/**
 * Read provider execution health from the exact launch receipt.  A missing or
 * malformed attempt is deliberately unknown; pane liveness is not a provider
 * termination proof.  Only `dead` may be used to refuse pane input: cmux can
 * never prove death and legacy teams have no launch attempt.
 */
export async function getWorkerProviderLiveness(
  teamName: string,
  cwd: string,
  instanceId: TeamInstanceId | string | undefined,
  worker: ProviderLivenessWorker,
): Promise<WorkerProviderLiveness> {
  if (!instanceId || !worker.pane_id || !worker.launch_attempt_id)
    return 'unknown';
  const provider = worker.launch_descriptor?.provider ?? worker.worker_cli;
  if (!provider) return 'unknown';
  try {
    const attempt = await loadWorkerLaunchAttempt({
      cwd,
      teamName,
      instanceId,
      workerName: worker.name,
      paneId: worker.pane_id,
      provider,
      attemptId: worker.launch_attempt_id,
      runtimeCliPath: resolveRuntimeCliPath(),
    });
    if (!attempt) return 'unknown';
    return await observeWorkerLaunchProvider(attempt);
  } catch {
    return 'unknown';
  }
}
