import { sealWikiManifest } from './cleanup-manifest.js';
import { buildWikiSessionEndCaptureIntent } from '../wiki/session-hooks.js';
import { resolveToWorktreeRoot } from '../../lib/worktree-paths.js';

export interface WikiSessionEndBootstrapInput { session_id: string; cwd: string; }
export interface WikiSessionEndBootstrapResult { continue: true; }

/**
 * Wiki SessionEnd producer: no foreground lock or wiki write, it only seals a
 * durable capture/no-op intent and hands off to the existing worker.
 *
 * Lives outside `index.ts` for the same reason as `foreground-bootstrap.ts`:
 * `scripts/wiki-session-end.mjs` runs inside run.cjs's fixed 300ms SessionEnd
 * foreground budget, and importing the full SessionEnd module graph there
 * timed the hook out before the intent was sealed.
 */
export async function publishWikiSessionEndBootstrap(input: WikiSessionEndBootstrapInput): Promise<WikiSessionEndBootstrapResult> {
  const directory = resolveToWorktreeRoot(input.cwd);
  const intent = buildWikiSessionEndCaptureIntent({ cwd: directory, session_id: input.session_id });
  sealWikiManifest(directory, input.session_id, intent ? { ...intent } : undefined);
  // Load the worker only after the intent is durable, as foreground-bootstrap does.
  const { spawnSessionEndWorker } = await import('./worker.js');
  spawnSessionEndWorker({ directory, sessionId: input.session_id });
  return { continue: true };
}

export default publishWikiSessionEndBootstrap;
