#!/usr/bin/env node
// Optional PostToolBatch hook for the task-list tools. NOT registered in hooks/hooks.json: the PostToolBatch event is not used by any
// hook in this repository, so its support by the host is unverified. Register it only after checking that the host sends it.
// Opt-in: does nothing unless OMC_TASK_LIST=1.
// One process per batch of tool calls. Writes one row to <task-list log dir>/batches.jsonl per batch (session_id, agent, agent_type,
// number and names of the tool calls, ms = time of the whole hook process), main thread and subagents. It never prints context and blocks nothing.

import { readStdin } from './lib/stdin.mjs';
import { agentKey, logRow, parseHookInput, skipped } from './lib/jev-task-list.mjs';

const QUIET = JSON.stringify({ continue: true, suppressOutput: true });
const NAMES_LOGGED = 20;

async function main() {
  const raw = await readStdin();
  const data = parseHookInput(raw);
  if (process.env.OMC_TASK_LIST !== '1' || !data || typeof data.session_id !== 'string') return QUIET;
  const calls = Array.isArray(data.tool_calls) ? data.tool_calls : [];
  const key = agentKey(data);
  if (!skipped('post-tool-batch')) {
    logRow('batches.jsonl', {
      session_id: data.session_id, agent: key, agent_id: typeof data.agent_id === 'string' ? data.agent_id.slice(0, 120) : null,
      agent_type: data.agent_type ?? null, prompt_id: data.prompt_id ?? null, n: calls.length,
      tools: calls.slice(0, NAMES_LOGGED).map((c) => String(c?.tool_name ?? '?')), ms: Math.round(process.uptime() * 1000),
    });
  }
  return QUIET;
}

main().then((out) => console.log(out), () => console.log(QUIET));
