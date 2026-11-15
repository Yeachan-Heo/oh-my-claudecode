#!/usr/bin/env node
// PostToolUse hook of the task-list tools. Opt-in: does nothing unless OMC_TASK_LIST=1.
// Matcher (hooks/hooks.json): the task_list tool of the OMC server, TaskCreate, TaskUpdate, TodoWrite, update_plan, wrap_up.
// Saves the list of the calling agent (agent_id of the hook input, main thread: "main") to
// <OMC_TASK_LIST_LOG_DIR or ~/.omc/state/task-list>/lists/<session_id>/<key>.json.
// PostToolUse comes only after a call that ran, so a rejected call changes nothing. Never prints context and never blocks.

import { readStdin } from './lib/stdin.mjs';
import { parseHookInput, recordListCall, skipped } from './lib/jev-task-list.mjs';

const QUIET = JSON.stringify({ continue: true, suppressOutput: true });

async function main() {
  if (process.env.OMC_TASK_LIST !== '1' || skipped('post-tool-use')) {
    console.log(QUIET);
    return;
  }
  const data = parseHookInput(await readStdin());
  if (data) recordListCall(data);
  console.log(QUIET);
}

main().catch(() => console.log(QUIET));
