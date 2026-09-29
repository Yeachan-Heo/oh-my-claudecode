import { prepareCoreManifest } from './cleanup-manifest.js';
import { planChainEnqueue } from './chain-enqueuer.js';
import { resolveToWorktreeRoot, validateSessionId } from '../../lib/worktree-paths.js';

export interface SessionEndBootstrapInput { session_id: string; transcript_path: string; cwd: string; permission_mode: string; hook_event_name: 'SessionEnd'; reason: 'clear' | 'logout' | 'prompt_input_exit' | 'other'; }
export interface SessionEndBootstrapResult { continue: true; }

/**
 * Publish the durable core cleanup intent (without sealing it) and hand off
 * to the existing worker. Core stays `prepared`, not `sealed`: sealing is
 * the worker's job via `recoverPreparedCoreProducer`, performed only after
 * `foreground-cleanup` durably completes. Sealing here would leave
 * `producers.core.state !== 'prepared'` permanently, which blocks the
 * worker's producer-grace bypass for `foreground-cleanup` and stalls the job.
 */
export async function publishSessionEndBootstrap(input: SessionEndBootstrapInput): Promise<SessionEndBootstrapResult> {
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
  if (prepared) {
    const { spawnSessionEndWorker } = await import('./worker.js');
    spawnSessionEndWorker({ directory, sessionId: input.session_id });
  }
  return { continue: true };
}

export default publishSessionEndBootstrap;
