#!/usr/bin/env node
// omc-lokalne A3: SubagentStart hook (stage 2 of the Jev task-list plan). Category: 5. output formatting (a fixed hint, no judgement).
// A subagent whose type has the list tool (its definition file: no `tools` field, or `tools` with lista_zadan; built-in general-purpose,
// claude, Plan) is recorded in the counter file (type, list tool, ToolSearch, Agent tool). Since T5 (11.11.2026) the hook adds no text: the reminder
// to keep a list is decided by Jev (jev-zadania.mjs, question `przypomnienie`). The agent's prompt is not touched. OMC_TODO_HINT: off | shadow | active.
// The type check is cached in <logdir>/listy/<session_id>/<agent_id>.licznik.json for the step reminder (jev-lista-paczka.mjs).

import { readStdin } from './lib/stdin.mjs';
import { MAIN, agentKey, logRow, parseHookInput, readCounter, skipped, todoHintMode, typeTools, writeCounter } from './lib/jev-lista.mjs';

const QUIET = JSON.stringify({ continue: true, suppressOutput: true });

async function main() {
  const mode = todoHintMode();
  if (mode === 'off' || skipped('subagent-start')) {
    console.log(QUIET);
    return;
  }
  const data = parseHookInput(await readStdin());
  const key = agentKey(data);
  if (!data || key === MAIN || typeof data.session_id !== 'string') {
    console.log(QUIET);
    return;
  }
  const tools = typeTools(data.agent_type, data.cwd);
  const counter = readCounter(data.session_id, key) ?? {};
  writeCounter(data.session_id, key, { ...counter, typ: data.agent_type ?? null, lista: tools.lista, toolSearch: Boolean(tools.toolSearch), agent: Boolean(tools.agent), zrodlo: tools.zrodlo ?? null, od_listy: counter.od_listy ?? 0, podpowiedzi: counter.podpowiedzi ?? 0 });
  // T5: no text is added here. Whether and what to remind this agent is decided by Jev in the shared query (signals: type, list tool, calls
  // since the list changed); this hook only records the facts for that query.
  logRow('todo-hint.jsonl', {
    etap: 'start', tryb: mode, session_id: data.session_id, agent: key, agent_type: data.agent_type ?? null,
    lista: tools.lista, zrodlo: tools.zrodlo, tekst: null,
  });
  console.log(QUIET);
}

main().catch(() => console.log(QUIET));
