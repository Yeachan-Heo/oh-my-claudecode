#!/usr/bin/env node

/**
 * SessionStart Hook: stale-run reporter (the unattended-run watchdog).
 *
 * Scans the resolved .omc state root for persistent unattended-mode state
 * files (ralph, autopilot, team, ultragoal) left `active: true` with a
 * stale mtime — the signature of a run whose process died mid-flight —
 * and surfaces them as advisory SessionStart context.
 *
 * Doctrine: this hook OBSERVES and REPORTS only. It never mutates state,
 * never resumes a run, and never infers approval. Threshold and coverage
 * are documented in docs/HOOKS.md.
 */

import { readStdin } from './lib/stdin.mjs';
import { resolveOmcStateRoot } from './lib/state-root.mjs';
import { findStaleRuns } from './lib/run-reaper.mjs';

async function main() {
  const raw = await readStdin(3000);
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }

  const directory = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : undefined;

  let stateRoot;
  try {
    stateRoot = await resolveOmcStateRoot(directory);
  } catch {
    stateRoot = null;
  }
  if (!stateRoot) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const stale = await findStaleRuns({ stateRoot, excludeSessionId: sessionId });
  if (stale.length === 0) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const lines = [
    `[STALE RUN] ${stale.length} unattended-run state file(s) look stale — likely a run whose process died mid-flight:`,
    ...stale.map((entry) => `- ${entry.mode}${entry.sessionId ? ` (session ${entry.sessionId})` : ''}: active for ~${entry.ageHours}h — ${entry.path}`),
    'Nothing was changed automatically. To reclaim: run /oh-my-claudecode:cancel to clean up the state, or re-enter the mode to resume from its artifacts. Re-kicking is a human decision.',
  ];

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n'),
    },
  }));
}

await main();
