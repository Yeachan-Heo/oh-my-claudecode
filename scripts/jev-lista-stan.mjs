#!/usr/bin/env node
// omc-lokalne A3: PostToolUse hook of the list tools (stage 2a of the Jev task-list plan). Category: 1. data storage.
// Matcher (latki/hooks-dodatki.json): lista_zadan of both OMC servers, TaskCreate, TaskUpdate, TodoWrite, update_plan, wrap_up.
// Saves the list of the calling agent (agent_id of the hook input, main thread: "main") to <logdir>/listy/<session_id>/<key>.json.
// PostToolUse comes only after a call that ran, so a rejected call (update_plan in a subagent, Z31) changes nothing. Never prints context.

import { readStdin } from './lib/stdin.mjs';
import { parseHookInput, recordListCall, skipped } from './lib/jev-lista.mjs';

const QUIET = JSON.stringify({ continue: true, suppressOutput: true });

async function main() {
  if (skipped('post-tool-use')) {
    console.log(QUIET);
    return;
  }
  const data = parseHookInput(await readStdin());
  if (data) recordListCall(data);
  console.log(QUIET);
}

main().catch(() => console.log(QUIET));
