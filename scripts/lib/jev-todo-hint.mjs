/* global process */
// Experiment, off by default, NOT FOR MERGE (negative result, see docs/jev/negative-results/todo-hint.md).
//
// Jev decides whether to remind an agent to create or update its task list. The code only counts facts (calls since the list changed,
// reminders already sent and what followed them) and hands them to Jev; no counter, threshold or cap triggers a reminder. The reminder
// is one choice question; its answer picks a kind (or `zadne` = none), and the fixed text of that kind is delivered once.
//
// Ported from a local patch (branch `kandydat-5` of the author's working repo). The question, the kinds, the signals, the reminder history
// and the fixed texts are the measured ones; what differs from the measured setup is listed in the document above ("Differences").
//
// Files, all under the Jev log directory (OMC_JEV_LOG_DIR, else <omc state root>/state/jev):
//   todo-hint/<session_id>/<main|agent_id>.json   per-thread state: the list as the hook saw it, counters, the last reminder
//   todo-hint.jsonl                               one row per reminder decision and delivery (the one log of reminders)

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from './atomic-write.mjs';

export const MAIN = 'main';
export const POINT = 'todo-hint';
export const REMINDER_KINDS = ['zaloz_liste', 'wpisz_krok', 'lista_nieaktualna', 'notka'];
export const EVENTS_KEPT = 500; // list-call times kept per thread
const HINT_LOG_TAIL = 4 * 1024 * 1024;
const HISTORY_REMINDERS_MAX = 20;
const ITEMS_MAX = 50;
const SESSION_ID = /^(?!\.)[A-Za-z0-9._-]{1,200}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const LIST_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite']);
const LIST_TOOL_RE = /^mcp__(?:plugin_oh-my-claudecode_)?t__lista_zadan$/; // the list tool of the local patch, if the host has it
const STATUSES = new Set(['pending', 'in_progress', 'completed']);

export const isListTool = (name) => typeof name === 'string' && (LIST_TOOLS.has(name) || LIST_TOOL_RE.test(name));

// OMC_TODO_HINT: off | shadow | active. Unset or unknown: off (the measured patch defaulted to shadow).
//   shadow: Jev is asked (when OMC_JEV names the point), decisions are logged to todo-hint.jsonl, nothing is delivered.
//   active: the reminder Jev chose is delivered once, as hook context.
export function todoHintMode(env = process.env) {
  const v = String(env.OMC_TODO_HINT ?? '').trim().toLowerCase();
  return v === 'shadow' || v === 'active' ? v : 'off';
}

// The point runs only when OMC_JEV names it (`all` never enables it, like `compaction`): `todo-hint` (shadow) or `todo-hint:active`.
// The reminder question is asked with the hook input of the batch only; an answer is used only in the `active` mode of the point.
export function pointNamed(env = process.env) {
  return String(env.OMC_JEV ?? '').split(',').some((entry) => {
    const token = entry.trim();
    return token === POINT || (token.startsWith(`${POINT}:`) && token.slice(POINT.length + 1).trim().toLowerCase() !== 'off');
  });
}

// --- per-thread state -------------------------------------------------------------------------------------------

const statePath = (logDir, sessionId, key) => (typeof sessionId === 'string' && SESSION_ID.test(sessionId) && AGENT_ID.test(key) ? join(logDir, 'todo-hint', sessionId, `${key}.json`) : null);

export function agentKey(data) {
  const id = typeof data?.agent_id === 'string' ? data.agent_id : '';
  return !id ? MAIN : AGENT_ID.test(id) ? id : `x_${id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}`;
}

export function readState(logDir, sessionId, key) {
  try {
    const path = statePath(logDir, sessionId, key);
    return path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  } catch {
    return null;
  }
}

export function writeState(logDir, sessionId, key, state) {
  try {
    const path = statePath(logDir, sessionId, key);
    if (!path) return false;
    mkdirSync(join(path, '..'), { recursive: true });
    atomicWriteFileSync(path, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

const cut = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const text = (v) => (typeof v === 'string' ? v : '');
function asItems(list) {
  return (Array.isArray(list) ? list : []).slice(0, ITEMS_MAX).map((x, i) => ({ id: String(x?.id ?? i + 1), status: STATUSES.has(x?.status) ? x.status : 'pending', content: cut(x?.content ?? x?.subject, 120) }));
}

// The task number from the result of a TaskCreate call ("Task #3 created ..." or an object with an id).
function taskIdOf(response) {
  const own = response && typeof response === 'object' ? (response.task?.id ?? response.id ?? response.taskId) : null;
  if (own !== null && own !== undefined) return String(own);
  const m = /#(\d{1,6})\b/.exec(typeof response === 'string' ? response : JSON.stringify(response ?? ''));
  return m ? m[1] : null;
}

// Applies one list-tool call to the saved items; returns the new items, or null when the call changes nothing (a rejected call, a malformed one).
export function applyListCall(items, call) {
  const name = String(call?.tool_name);
  const input = call?.tool_input && typeof call.tool_input === 'object' ? call.tool_input : {};
  if (name === 'TodoWrite') return Array.isArray(input.todos) ? asItems(input.todos) : null;
  if (LIST_TOOL_RE.test(name)) return Array.isArray(input.items) && input.items.length ? asItems(input.items) : items; // done/start/advance: a change we do not track item by item
  if (name === 'TaskCreate') {
    const id = taskIdOf(call.tool_response);
    return id ? [...items, { id, status: 'pending', content: cut(input.subject ?? input.content, 120) }].slice(-ITEMS_MAX) : null;
  }
  if (name === 'TaskUpdate') {
    const id = String(input.taskId ?? '');
    if (!items.some((x) => x.id === id)) return null;
    if (input.status === 'deleted') return items.filter((x) => x.id !== id);
    return STATUSES.has(input.status) ? items.map((x) => (x.id === id ? { ...x, status: input.status } : x)) : items;
  }
  return null;
}

// Folds one batch of tool calls into the thread state: the list as the hook saw it, the time of every list call, the number of calls since the
// list changed (reset by a list call, and for the main thread by a new owner message), the total number of calls (`razem`).
export function foldBatch(state, data, calls, now = Date.now()) {
  const next = { v: 1, typ: data.agent_type ?? null, items: [], updated: null, od_listy: 0, razem: 0, podpowiedzi: 0, wywolania_listy: [], ostatnie: null, ...(state ?? {}) };
  const key = agentKey(data);
  if (key === MAIN && (next.prompt_id ?? null) !== (data.prompt_id ?? null)) { next.prompt_id = data.prompt_id ?? null; next.od_listy = 0; }
  next.typ = data.agent_type ?? next.typ ?? null;
  let changed = false;
  for (const call of calls) {
    if (!isListTool(call?.tool_name)) continue;
    const items = applyListCall(next.items, call);
    if (!items) continue;
    next.items = items;
    next.wywolania_listy = [...next.wywolania_listy, now].slice(-EVENTS_KEPT);
    changed = true;
  }
  if (changed) { next.od_listy = 0; next.updated = new Date(now).toISOString(); }
  else next.od_listy += calls.length;
  next.razem += calls.length;
  return next;
}

// --- history of the reminders of one thread ---------------------------------------------------------------------

function remindersOfThread(logDir, sessionId, key) {
  const path = join(logDir, 'todo-hint.jsonl');
  if (!existsSync(path)) return { rows: [], cut: false };
  const fd = openSync(path, 'r');
  let body;
  let isCut;
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - HINT_LOG_TAIL - 1); // one byte before the tail: its first character is then the end of a line or a cut one
    const buffer = Buffer.alloc(size - start);
    const got = readSync(fd, buffer, 0, buffer.length, start);
    body = buffer.toString('utf8', 0, got);
    isCut = start > 0;
    if (isCut) body = body.slice(body.indexOf('\n') + 1);
  } finally { closeSync(fd); }
  const rows = [];
  for (const line of body.split('\n')) {
    if (!line.includes('"przypomnienie"')) continue;
    try {
      const r = JSON.parse(line);
      const at = Date.parse(r.ts);
      if (r.etap === 'przypomnienie' && r.session_id === sessionId && r.agent === key && !r.pominiete && REMINDER_KINDS.includes(r.rodzaj) && Number.isFinite(at)) rows.push({ ...r, at });
    } catch { /* a damaged row is not a reminder */ }
  }
  return { rows: rows.sort((a, b) => a.at - b.at), cut: isCut };
}

// The reminders this thread got (kind, mode, tool calls and seconds since it, whether the thread called a list tool after it up to the next
// reminder or up to now). Facts only; what is not known is null, never a false "no". `calls`: the times (ms) of the list calls of the thread.
export function historiaPrzypomnien(logDir, sessionId, key, calls, { razem = null, now = Date.now() } = {}) {
  try {
    const { rows: all, cut: wasCut } = remindersOfThread(logDir, sessionId, key);
    const known = all.filter((r) => r.at <= now); // the view as of `now`
    const rows = known.slice(-HISTORY_REMINDERS_MAX);
    const times = [...(Array.isArray(calls) ? calls : [])].sort((a, b) => a - b);
    const trimmed = times.length >= EVENTS_KEPT; // older list calls may have left the kept ones
    const history = rows.map((r, i) => {
      const until = i + 1 < rows.length ? rows[i + 1].at : now;
      const first = times.find((c) => c > r.at && c <= until);
      const unknown = first === undefined && trimmed && r.at < times[0];
      return {
        rodzaj: r.rodzaj,
        tryb: r.tryb ?? null,
        wywolan_narzedzi_temu: Number.isInteger(razem) && Number.isInteger(r.nr_tury) && razem >= r.nr_tury ? razem - r.nr_tury : null,
        sekund_temu: Math.max(0, Math.round((now - r.at) / 1000)),
        lista_zmieniona_po_nim: unknown ? null : first !== undefined,
        sekund_do_zmiany_listy: first !== undefined ? Math.round((first - r.at) / 1000) : null,
      };
    });
    return { historia_przypomnien: history, starszych_pominietych: known.length - rows.length, dziennik_obciety: wasCut };
  } catch {
    return { historia_przypomnien: null, starszych_pominietych: null, dziennik_obciety: null };
  }
}

// --- the signals and the question ---------------------------------------------------------------------------------

export function sygnalyPrzypomnienia(logDir, sessionId, key, state, { now = Date.now() } = {}) {
  const items = Array.isArray(state?.items) ? state.items : [];
  const last = state?.ostatnie ?? null;
  return {
    ma_liste: items.length > 0, zadan_w_toku: items.filter((x) => x.status === 'in_progress').length, zadan_otwartych: items.filter((x) => x.status !== 'completed').length,
    wywolan_od_zmiany_listy: Number.isInteger(state?.od_listy) ? state.od_listy : null, ostatnia_zmiana_listy: state?.updated ?? null,
    typ_agenta: state?.typ ?? null, sesja_glowna: key === MAIN, narzedzie_listy: key === MAIN ? 'TaskCreate i TaskUpdate' : 'narzędzie listy zadań',
    przypomnien_dotad: Number.isInteger(state?.podpowiedzi) ? state.podpowiedzi : 0,
    ostatnie_przypomnienie: last ? { rodzaj: last.rodzaj, uwaga: null, ts: last.ts, nr_tury: last.nr_tury ?? null, dostarczone: last.dostarczone === true } : null,
    ...historiaPrzypomnien(logDir, sessionId, key, state?.wywolania_listy, { razem: state?.razem ?? null, now }),
  };
}

// The question as it was last sent in the measured setup (patch branch `tor/P2`). The previous wording (before the history field was added) is
// QUESTION_BEFORE_HISTORY, kept for the A/B probe (scripts/jev-negative-results/todo-hint/probe.mjs).
const CRITERIA = {
  zadne: 'Nie przypominaj',
  zaloz_liste: 'Agent pracuje bez listy zadań: przypomnij o założeniu listy przed dalszą pracą',
  wpisz_krok: 'Lista jest, ale nie nadąża za pracą: przypomnij o wpisaniu bieżącego kroku jako w toku',
  lista_nieaktualna: 'Lista jest nieaktualna: przypomnij o zaktualizowaniu statusów i zamknięciu zrobionych zadań',
  notka: 'Zadanie w toku nie ma notki, co agent robi i po co: przypomnij o notce',
};
export const QUESTION_BEFORE_HISTORY = 'Czy przypomnieć agentowi o liście zadań (pole state.przypomnienie: ma_liste, zadan_w_toku, wywolan_od_zmiany_listy, typ_agenta, przypomnien_dotad, ostatnie_przypomnienie) i które, patrząc na jego ostatnią pracę (tekst agenta, lista, ostatnie wywołania)? Liczniki są tylko sygnałem; krótki agent na jedno zadanie może nie potrzebować listy.';
export const QUESTION_WITH_HISTORY = 'Czy przypomnieć agentowi o liście zadań (pole state.przypomnienie: ma_liste, zadan_w_toku, wywolan_od_zmiany_listy, typ_agenta, przypomnien_dotad, ostatnie_przypomnienie, historia_przypomnien: wcześniejsze przypomnienia dla tego agenta, każde z rodzajem, trybem (active: agent je dostał, shadow: tylko zapisane), liczbą wywołań narzędzi i sekund od niego oraz informacją, czy agent wywołał narzędzie listy między tym przypomnieniem a następnym albo do teraz; starszych_pominietych: liczba starszych przypomnień poza listą; dziennik_obciety: true, gdy dziennik był za duży i jego początek nie został odczytany; null oznacza, że nie wiadomo) i które, patrząc na jego ostatnią pracę (tekst agenta, lista, ostatnie wywołania)? Liczniki są tylko sygnałem; krótki agent na jedno zadanie może nie potrzebować listy.';

export function przypomnienieQuestion(instructions = QUESTION_WITH_HISTORY) {
  return { przypomnienie: { type: 'choice', instructions, criteria: CRITERIA } };
}

// The decision of Jev from his answer: a kind, or null for `zadne` / no usable answer.
export function przypomnienieZOdpowiedzi(answer) {
  const rodzaj = typeof answer?.choice === 'string' ? answer.choice : null;
  return rodzaj && REMINDER_KINDS.includes(rodzaj) ? rodzaj : null;
}

// The fixed text of a kind (the measured texts; the subagent variants do not name a tool, because the host decides which list tool an agent has).
export function tekstStaly(key, rodzaj) {
  switch (rodzaj) {
    case 'zaloz_liste': return key === MAIN
      ? 'Załóż listę zadań (TaskCreate): zadanie = jeden sprawdzalny wynik; w toku przed pracą, completed po niej.'
      : 'Zapisz listę zadań przed pracą; zadanie = jeden sprawdzalny wynik; in_progress przed pracą, completed po niej; zadanie w toku z notatką: co robisz i po co.';
    case 'wpisz_krok': return 'Wpisz bieżący krok na listę zadań i oznacz go jako w toku.';
    case 'lista_nieaktualna': return 'Lista zadań jest nieaktualna: zaktualizuj statusy, zamknij zrobione zadania i dopisz brakujące.';
    case 'notka': return 'Dopisz do zadania w toku notkę: co robisz i po co.';
    default: return '';
  }
}
