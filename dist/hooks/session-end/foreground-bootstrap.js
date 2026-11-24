import { prepareCoreManifest } from './cleanup-manifest.js';
import { planChainEnqueue, recordChainDecision } from './chain-enqueuer.js';
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
    // Plugin installs route SessionEnd here (hooks/hooks.json → scripts/session-end.mjs),
    // so the chain enqueue must happen on this path — the standalone settings.json
    // forwarder (processSessionEnd) is not registered when plugin hooks are enabled.
    const chain = planChainEnqueue(directory, input.session_id, input.reason);
    const payload = chain
        ? { transcriptPath: input.transcript_path, cwd: input.cwd, reason: input.reason, input, initialTeamNames: [], chain }
        : { transcriptPath: input.transcript_path, cwd: input.cwd, reason: input.reason, input, initialTeamNames: [] };
    const prepared = prepareCoreManifest(directory, input.session_id, payload);
    if (!prepared) {
        // The enqueuer already recorded 'enqueued'; without a manifest (another
        // writer holds the lease) nothing will ever execute that chain. Record the
        // stall so the audit trail names it instead of showing a phantom enqueue.
        if (chain) {
            recordChainDecision(directory, {
                decision: 'manifest-unavailable',
                sessionId: input.session_id,
                intentId: chain.intentId,
            });
        }
        return { continue: true };
    }
    const { spawnSessionEndWorker } = await import('./worker.js');
    // A failed worker spawn is equally silent: the chain payload is durable but
    // no executor will pick it up. Name it in the same trail.
    if (!spawnSessionEndWorker({ directory, sessionId: input.session_id }) && chain) {
        recordChainDecision(directory, {
            decision: 'worker-spawn-failed',
            sessionId: input.session_id,
            intentId: chain.intentId,
        });
    }
    return { continue: true };
}
export default publishSessionEndBootstrap;
//# sourceMappingURL=foreground-bootstrap.js.map