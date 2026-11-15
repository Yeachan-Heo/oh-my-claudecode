#!/usr/bin/env node
// PostToolUseFailure handler of the opt-in agent pool (scripts/lib/jev-pool.mjs): releases the
// reservation of a failed Agent/Task call by its tool_use_id, so a start that failed after the
// allow does not hold a slot until the TTL. Fails open: a missing, unreadable or unparsable stdin,
// an unknown event name and every state error leave everything untouched, with the generic hook
// output and exit code 0.
import { readStdin } from './lib/stdin.mjs';
import { handlePoolEvent } from './lib/jev-pool.mjs';

try {
  const data = JSON.parse(await readStdin());
  await handlePoolEvent({
    event: typeof data?.hook_event_name === 'string' ? data.hook_event_name : '',
    sessionId: typeof data?.session_id === 'string' ? data.session_id : '',
    cwd: typeof data?.cwd === 'string' ? data.cwd : '',
    toolUseId: typeof data?.tool_use_id === 'string' ? data.tool_use_id : '',
  });
} catch { /* fail-open */ }
console.log(JSON.stringify({ continue: true, suppressOutput: true }));
