// Claude Code hook for team workers: `node team-provider-event-hook.mjs <Event>`.
// Appends {"v":1,"event":...,"at":<ms>,"attempt":...} to
// $OMC_TEAM_STATE_ROOT/workers/<worker>/provider-events.jsonl with one appendFile.
// Always exits 0 and never prints: hook output or a nonzero exit would show as
// `hook error` in the worker pane and change what the pane reads as.
// The event name comes from argv (src/team/provider-events.ts PROVIDER_EVENT_NAMES
// builds the settings), so a new event needs no change here.
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

try {
  const at = Date.now();
  const event = process.argv[2] ?? '';
  const attempt = process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID ?? '';
  const stateRoot = process.env.OMC_TEAM_STATE_ROOT ?? '';
  // OMC_TEAM_WORKER is `<team>/<worker>`.
  const worker = (process.env.OMC_TEAM_WORKER ?? '').split('/').pop() ?? '';
  if (/^[A-Za-z]+$/.test(event) && attempt && stateRoot && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(worker) && !worker.includes('..')) {
    // No mkdir: a missing worker directory means the team is gone, and the hook
    // must not recreate cleaned-up state.
    await appendFile(
      join(stateRoot, 'workers', worker, 'provider-events.jsonl'),
      `${JSON.stringify({ v: 1, event, at, attempt })}\n`,
    );
  }
} catch {
  // Recording is best-effort; see the header.
}
process.exitCode = 0;
