#!/usr/bin/env node
import { readSessionEndFrame } from './lib/stdin.mjs';
import { isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const fallback = { continue: true, suppressOutput: true };

export async function runWikiSessionEndHook() {
  const frame = await readSessionEndFrame();

  if (frame.status !== 'ok') {
    console.log(JSON.stringify(fallback));
    return;
  }

  try {
    // Lean bootstrap, not the full SessionEnd index graph: this hook runs inside
    // run.cjs's 300ms SessionEnd foreground budget (same split as session-end.mjs).
    // Import only the lean, already-shipped modules (not the SessionEnd index
    // graph); mirrors src/hooks/session-end/wiki-foreground-bootstrap.ts.
    const [{ resolveToWorktreeRoot }, { buildWikiSessionEndCaptureIntent }, { sealWikiManifest }] = await Promise.all([
      import('../dist/lib/worktree-paths.js'),
      import('../dist/hooks/wiki/session-hooks.js'),
      import('../dist/hooks/session-end/cleanup-manifest.js'),
    ]);
    const input = frame.value;
    const directory = resolveToWorktreeRoot(input.cwd);
    const intent = buildWikiSessionEndCaptureIntent({ cwd: directory, session_id: input.session_id });
    sealWikiManifest(directory, input.session_id, intent ? { ...intent } : undefined);
    // Load the worker only after the intent is durable, as foreground-bootstrap does.
    const { spawnSessionEndWorker } = await import('../dist/hooks/session-end/worker.js');
    spawnSessionEndWorker({ directory, sessionId: input.session_id });
    console.log(JSON.stringify({ continue: true }));
  } catch (error) {
    console.error('[wiki-session-end] Error:', error.message);
    console.log(JSON.stringify(fallback));
  }
}

if (!isMainThread || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) void runWikiSessionEndHook();
