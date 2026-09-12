import { prepareCoreManifest } from './cleanup-manifest.js';
import { resolveToWorktreeRoot, validateSessionId } from '../../lib/worktree-paths.js';
/**
 * Publish the durable core cleanup intent (without sealing it) and hand off
 * to the existing worker. Core stays `prepared`, not `sealed`: sealing is
 * the worker's job via `recoverPreparedCoreProducer`, performed only after
 * `foreground-cleanup` durably completes. Sealing here would leave
 * `producers.core.state !== 'prepared'` permanently, which blocks the
 * worker's producer-grace bypass for `foreground-cleanup` and stalls the job.
 */
export async function publishSessionEndBootstrap(input) {
    validateSessionId(input.session_id);
    const directory = resolveToWorktreeRoot(input.cwd);
    const payload = { transcriptPath: input.transcript_path, cwd: input.cwd, reason: input.reason, input, initialTeamNames: [] };
    const prepared = prepareCoreManifest(directory, input.session_id, payload);
    if (prepared) {
        const { spawnSessionEndWorker } = await import('./worker.js');
        spawnSessionEndWorker({ directory, sessionId: input.session_id });
    }
    return { continue: true };
}
export default publishSessionEndBootstrap;
//# sourceMappingURL=foreground-bootstrap.js.map