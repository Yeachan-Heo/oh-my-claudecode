#!/usr/bin/env node
/* global process, console */
// Experiment, off by default, NOT FOR MERGE (negative result, see docs/jev/negative-results/todo-hint.md).
//
// PostToolBatch hook: after every batch of tool calls it folds the batch into the thread's list state and, when OMC_TODO_HINT is shadow or
// active and OMC_JEV names the `todo-hint` point, asks Jev one choice question: remind this agent about the task list, and which reminder.
// Jev's answer is used only in the active mode of the point (`OMC_JEV=todo-hint:active`); the chosen reminder is delivered once, as
// additionalContext, only with OMC_TODO_HINT=active. Without OMC_TODO_HINT nothing runs. Nothing is blocked; every step is fail-open.
//
// Not registered in hooks/hooks.json. To try it, add to a settings file:
//   "hooks": { "PostToolBatch": [ { "hooks": [ { "type": "command", "command": "node <repo>/scripts/jev-todo-hint.mjs", "timeout": 10 } ] } ] }

import { resolveJevLogDir } from './jev-resolve.mjs';
import { appendJevLogLine, jevModeFor, recordJevShadow, setJevHookContext, setJevSessionId } from './lib/jev-shadow.mjs';
import {
  POINT, agentKey, foldBatch, pointNamed, przypomnienieQuestion, przypomnienieZOdpowiedzi, readState, sygnalyPrzypomnienia, tekstStaly, todoHintMode, writeState,
} from './lib/jev-todo-hint.mjs';

const QUIET = JSON.stringify({ continue: true, suppressOutput: true });
const NAMES_SENT = 12;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function parseInput(raw) {
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// The answer to the reminder question from an active result (by question name, never by position).
const answerOf = (result) => (result?.mode === 'active' && result.answers && Object.hasOwn(result.answers, 'przypomnienie') ? result.answers.przypomnienie : null);

async function main() {
  const mode = todoHintMode();
  if (mode === 'off') return QUIET;
  const data = parseInput(await readStdin());
  const calls = Array.isArray(data?.tool_calls) ? data.tool_calls : [];
  if (!data || typeof data.session_id !== 'string' || !calls.length) return QUIET;

  const logDir = await resolveJevLogDir(process.env);
  process.env.OMC_JEV_LOG_DIR ||= logDir; // appendJevLogLine and the resolver write next to the other Jev logs
  const sid = data.session_id;
  const key = agentKey(data);
  const now = Date.now();

  const state = foldBatch(readState(logDir, sid, key), data, calls, now);
  let text = '';

  if (pointNamed() && jevModeFor(POINT, process.env, data.permission_mode) !== 'off') {
    setJevSessionId(sid, data.agent_id);
    await setJevHookContext(data);
    const signals = sygnalyPrzypomnienia(logDir, sid, key, state, { now });
    const result = recordJevShadow({
      point: POINT,
      state: { przypomnienie: signals, ostatnie_wywolania: calls.slice(0, NAMES_SENT).map((c) => String(c?.tool_name ?? '?')) },
      questions: przypomnienieQuestion(),
      heuristic: 'zadne', // the twin never reminds: only Jev's answer can
      permissionMode: data.permission_mode,
    });
    const rodzaj = przypomnienieZOdpowiedzi(answerOf(result));
    if (rodzaj) {
      text = tekstStaly(key, rodzaj);
      const delivered = mode === 'active';
      state.podpowiedzi += 1;
      state.ostatnie = { rodzaj, ts: new Date(now).toISOString(), nr_tury: state.razem, dostarczone: delivered };
      appendJevLogLine('todo-hint.jsonl', {
        ts: new Date().toISOString(), etap: 'przypomnienie', tryb: mode, session_id: sid, agent: key, agent_type: data.agent_type ?? null,
        prompt_id: data.prompt_id ?? null, rodzaj, nr_tury: state.razem, kto: 'jev', uwaga: null, tekst: text,
      });
      if (!delivered) text = '';
    }
  }

  writeState(logDir, sid, key, state);
  if (!text) return QUIET;
  return JSON.stringify({ continue: true, hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: text } });
}

main().then((out) => console.log(out), () => console.log(QUIET));

