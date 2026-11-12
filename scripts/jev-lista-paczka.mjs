#!/usr/bin/env node
// omc-lokalne A3: the one PostToolBatch hook (step 0, stage 3 and stage 4 of the Jev task-list plan); one process per batch, because every
// batch waits for this hook and a node start costs 0.4-0.9 s on a slow machine (review M3). Category: 2. arithmetic (counting calls) and 5. output.
// Step 0: one paczki.jsonl row per batch (session_id, agent, agent_type, number and names of the tool calls, ms = time of the whole hook
// process), main thread and subagents. Counters (T5, 11.11.2026): the agent's tool calls since its last list change (no list: since its start)
// are a SIGNAL for the end-of-turn query of Jev, not a trigger: no threshold, no cap. The reminder to keep or update a list is decided and written
// by Jev (jev-zadania.mjs); this hook delivers it once (OMC_TODO_HINT off | shadow | active), registers the agents launched in the batch,
// keeps the list in agreement with the host and notes the owner message. Stage 4: the Jev panel (jev-panel.mjs, runPanel), only when OMC_JEV
// names the point panel. Only hints, nothing is blocked (decision 6).

import { readStdin } from './lib/stdin.mjs';
import {
  LIST_TOOL_RE, MAIN, agentKey, isListTool, logRow, parseHookInput, readCounter, readList, skipped, syncList,
  notePromptIn, taskIdOf, todoHintMode, typeTools, updateShape, writeCounter,
} from './lib/jev-lista.mjs';
import { odbierzPrzypomnienie, podpowiedzZamknij, uruchomieniaAgentow, zarejestrujAgentow } from './lib/jev-zadania.mjs';

const QUIET = JSON.stringify({ continue: true, suppressOutput: true });
const NAMES_LOGGED = 20;
const PANEL_NAMED = /(?:^|,)\s*panel\s*(?::[^,]*)?(?:,|$)/; // same test as jev-panel.mjs: the panel module is loaded only when named
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

// Whether a list-tool call of the batch changed the agent's list: the saved list comes from it, or its input has a valid shape (a rejected
// lista_zadan or update_plan call changes nothing); TaskUpdate only for a task on this agent's list, TaskCreate only with a task id in its result.
function changesList(call, record) {
  if (call?.tool_use_id && call.tool_use_id === record?.tool_use_id) return true;
  const name = String(call?.tool_name);
  if (LIST_TOOL_RE.test(name) || name === 'mcp__ccd_turn__update_plan') return updateShape(call?.tool_input).ok;
  if (name === 'TaskUpdate') return Array.isArray(record?.items) && record.items.some((x) => x?.host_id !== undefined && x.host_id === String(call?.tool_input?.taskId));
  if (name === 'TaskCreate') return Boolean(taskIdOf(call?.tool_response));
  return true; // TodoWrite, wrap_up (main thread)
}

// The counters for the end-of-turn query of Jev (T5, coordinator 11.11.2026): calls since the last list change, the type of the agent, whether it
// has the list tool. Signals only: nothing here reminds anybody, there is no threshold and no cap (whether and what to remind is decided by Jev,
// jev-zadania.mjs; the reminder he decided on is delivered by deliverReminder below).
function listSignals(data, calls, key) {
  const sid = data.session_id;
  const listCalls = calls.filter((c) => isListTool(c?.tool_name, key));
  let counter = readCounter(sid, key) ?? {};
  if (typeof counter.lista !== 'boolean') {
    const tools = key === MAIN ? { lista: true, toolSearch: false } : typeTools(data.agent_type, data.cwd);
    counter = { ...counter, typ: data.agent_type ?? null, lista: tools.lista, toolSearch: Boolean(tools.toolSearch), agent: Boolean(tools.agent), zrodlo: tools.zrodlo ?? null };
    if (!counter.lista) {
      writeCounter(sid, key, counter); // written once: later batches of this agent read it and stop here (review M3)
      return;
    }
  }
  if (!counter.lista) return;
  if (key === MAIN && (counter.prompt_id ?? null) !== (data.prompt_id ?? null)) counter = { ...counter, prompt_id: data.prompt_id ?? null, od_listy: 0 };
  // the batch folds the events of its list calls under the lock (the list file catches up); a busy lock: the fold of a reader
  const synced = syncList(sid, key);
  const record = synced === false ? readList(sid, key) : synced;
  counter.podpowiedzi = count(counter.podpowiedzi);
  if (listCalls.some((c) => changesList(c, record))) counter.od_listy = 0;
  else counter.od_listy = count(counter.od_listy) + calls.length - listCalls.length;
  writeCounter(sid, key, counter);
}

// T5: after the batch, the facts of the task store: the list agrees with the host (E4 K2), the owner message of this batch is noted, the
// agents launched in the batch are registered with the tasks open at that moment; then the hint "close the task" from a verdict of Jev
// (jev-zadania.mjs; nothing here decides anything). Returns the hint text or ''.
function taskStore(data, calls, key, mode) {
  const sid = data.session_id;
  syncList(sid, key); // writes a difference to the host (and the upgrade of an old record) when there is one
  let record = readList(sid, key);
  if (!record) return '';
  if (typeof data.prompt_id === 'string' && data.prompt_id && notePromptIn(record, data.prompt_id)) syncList(sid, key, process.env, (r) => notePromptIn(r, data.prompt_id));
  const launches = uruchomieniaAgentow(calls);
  if (launches.length) zarejestrujAgentow(sid, key, launches, { prompt_id: data.prompt_id ?? null });
  if (mode === 'off') return '';
  record = readList(sid, key);
  const counter = readCounter(sid, key) ?? {};
  const hint = podpowiedzZamknij(record, counter.zamkniete ?? {});
  if (!hint) return '';
  writeCounter(sid, key, { ...counter, zamkniete: { ...(counter.zamkniete ?? {}), ...hint.versions } });
  logRow('todo-hint.jsonl', { etap: 'zamknij', tryb: mode, session_id: sid, agent: key, agent_type: data.agent_type ?? null, prompt_id: data.prompt_id ?? null, zadania: Object.keys(hint.versions), tekst: hint.text });
  return mode === 'active' ? hint.text : '';
}

async function main() {
  const raw = await readStdin();
  const data = parseHookInput(raw);
  if (!data || typeof data.session_id !== 'string') return QUIET;
  const calls = Array.isArray(data.tool_calls) ? data.tool_calls : [];
  const key = agentKey(data);
  const own = !skipped('post-tool-batch');
  const texts = [];
  if (own) {
    const mode = todoHintMode();
    try {
      if (mode !== 'off' && calls.length) listSignals(data, calls, key);
    } catch { /* the counters never break the hook */ }
    try {
      const hint = calls.length === 0 ? '' : taskStore(data, calls, key, mode);
      if (hint) texts.push(hint);
    } catch { /* the task store never breaks the hook */ }
  }
  let panel = false;
  if (own && PANEL_NAMED.test(String(process.env.OMC_JEV ?? ''))) { // OMC_SKIP_HOOKS=post-tool-batch turns off the panel here too
    panel = true;
    try {
      const { runPanel } = await import('./jev-panel.mjs');
      const text = await runPanel(data);
      if (text) texts.push(text);
    } catch { /* the panel never breaks the hook */ }
  }
  if (own) { // after the panel: a decision of Jev written by the panel query of this very batch is delivered in this batch
    try {
      const mode = todoHintMode();
      const reminder = mode === 'off' ? '' : odbierzPrzypomnienie(data.session_id, key, mode, { agent_type: data.agent_type ?? null, prompt_id: data.prompt_id ?? null });
      if (reminder) texts.push(reminder);
    } catch { /* the reminder never breaks the hook */ }
  }
  if (own) {
    logRow('paczki.jsonl', {
      session_id: data.session_id, agent: key, agent_id: typeof data.agent_id === 'string' ? data.agent_id.slice(0, 120) : null,
      agent_type: data.agent_type ?? null, prompt_id: data.prompt_id ?? null, n: calls.length,
      narzedzia: calls.slice(0, NAMES_LOGGED).map((c) => String(c?.tool_name ?? '?')), panel, ms: Math.round(process.uptime() * 1000),
    });
  }
  if (!texts.length) return QUIET;
  return JSON.stringify({ continue: true, hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: texts.join('\n') } });
}

main().then((out) => console.log(out), () => console.log(QUIET));
