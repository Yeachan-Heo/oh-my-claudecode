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
import { loadContextText } from './lib/context-text-loader.mjs';

// Opt-in text cleaning (OMC_CONTEXT_TEXT_SANITIZE=1 or true): the state-file fields are cleaned before they are injected.
// The module is loaded only when the switch is on; with the switch off the fields are injected unchanged.
async function main() {
  const raw = await readStdin(3000);
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }

  const directory =
    typeof payload?.cwd === 'string' && payload.cwd
      ? payload.cwd
      : process.cwd();
  const sessionId =
    typeof payload?.session_id === 'string' ? payload.session_id : undefined;

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

  const crashed = stale.filter((entry) => !entry.awaitingConfirmation);
  const waiting = stale.filter((entry) => entry.awaitingConfirmation);

  // State-file fields are data. With the switch on the mode, the session id and the path are identifiers: each is written
  // exactly (escaped, not cleaned; a written form over 200 characters, the path over 500, is replaced by a notice), and the
  // other fields are cleaned to one line.
  const sanitize = await loadContextText();
  const field = (value, max) => (sanitize ? sanitize.cleanHostText(value, max) : value);
  const identifier = (value, max) => (sanitize ? sanitize.escapeIdentifier(value, max) : value);
  const lines = [];
  if (crashed.length > 0) {
    lines.push(
      `[STALE RUN] ${crashed.length} unattended-run state file(s) look stale — likely a run whose process died mid-flight:`,
      ...crashed.map(
        (entry) =>
          `- ${identifier(entry.mode, 200)}${entry.sessionId ? ` (session ${identifier(entry.sessionId, 200)})` : ''}: active for ~${field(entry.ageHours, 200)}h — ${identifier(entry.path, 500)}`,
      ),
      'Nothing was changed automatically. To reclaim: run /oh-my-claudecode:cancel to clean up the state, or re-enter the mode to resume from its artifacts. Re-kicking is a human decision.',
    );
  }
  if (waiting.length > 0) {
    lines.push(
      `[AWAITING CONFIRMATION] ${waiting.length} unattended-run state file(s) are waiting for your confirmation and show no recent activity:`,
      ...waiting.map((entry) => {
        const since = entry.awaitingConfirmationSetAt
          ? ` since ${field(entry.awaitingConfirmationSetAt, 200)}`
          : '';
        return `- ${identifier(entry.mode, 200)}${entry.sessionId ? ` (session ${identifier(entry.sessionId, 200)})` : ''}: waiting for your confirmation${since}, no activity for ~${field(entry.ageHours, 200)}h — ${identifier(entry.path, 500)}`;
      }),
      'Nothing was changed automatically. A parked prompt is not proof the run is still alive; answer it in its session, or run /oh-my-claudecode:cancel if it is gone. Re-kicking is a human decision.',
    );
  }

  // The number of runs is not bounded, so with the switch on the whole message is also bounded where it is emitted.
  const output = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n'),
    },
  };
  console.log(JSON.stringify(sanitize ? sanitize.cleanHookOutput(output) : output));
}

await main();
