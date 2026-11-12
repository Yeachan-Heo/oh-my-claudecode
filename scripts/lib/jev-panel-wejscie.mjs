// omc-lokalne A3: input and texts of the Jev panel (stage 4 of the Jev task-list plan).
// Category: 4. input for the agent (Jev) and 5. output formatting. The hook decides nothing itself: Jev answers yes/no questions,
// a hint goes out for a "yes" from THRESHOLD, each hint at most once per task. Mechanical shortening only (no language model here):
// tool input up to 300 characters, result head and tail up to 500, agent texts from the newest backwards up to 4000 characters in total
// (a text longer than the rest of the budget keeps its head and tail), the prompt head and tail up to 4000.
// Privacy (review rec-panel B1, H1): every string is masked before it is serialised (maskSecrets of jev-shell.mjs; the value of a key
// with a secret-like name is replaced whole whatever its type, review rec-A2b-panel BLOCKER 2); a tool call with a SECRET_PATH match in any
// string of its input (every tool, MCP too) sends only its name and a marker; a line matching SECRET_PATH in a result or a text is replaced
// by a marker; results only for the tools of RESULT_TOOLS; tools of SECRET_TOOL (names with vault, password, secret) send
// only their name. SECRET_PATH, SECRET_KEY and the JSON replacer come from jev-sekrety.mjs (one source, review rec-A2b-panel BLOCKER 1).

import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { atomicWriteFileSync } from './atomic-write.mjs';
import { maskSecrets } from './jev-panel-host.mjs';
import { SECRET_PATH, SECRET_PEM, cleanSecretText, maskSecretProse, secretJson, secretPathIn } from './jev-sekrety.mjs';
import { MAIN, agentKey, inProgress, listPath, readList, skipped, withFileLock } from './jev-lista.mjs';
import { readOwnerTask, subagentTranscriptPath } from './jev-task.mjs';

export const PANEL_POINT = 'panel';
export const PANEL_EVERY = 6; // at most one query per 6 tool calls of one task (plan, stage 4); OMC_JEV_PANEL_EVERY=1 asks after every batch (the budget of queries is for J0 to set, S5)
export const panelEvery = (env = process.env) => { const n = Number(env.OMC_JEV_PANEL_EVERY); return Number.isInteger(n) && n >= 1 ? n : PANEL_EVERY; };
export const PANEL_ERRORS = 2; // a query after the second tool error in a row
export const THRESHOLD = 0.7; // one threshold for every question (owner, 10.11.2026)
export const JOURNAL_CALLS = 6;
export const INPUT_MAX = 300;
export const RESULT_MAX = 500;
export const TEXT_BUDGET = 4000; // the same limit as PARENT_MESSAGE_MAX_CHARS in pre-tool-enforcer.mjs
export const PROMPT_MAX = 4000;
export const ERROR_MAX = 300;
export const ERRORS_KEPT = 20; // error texts of failed calls waiting for their batch (review M6)
export const GIVEN_TASKS_KEPT = 50; // tasks with given hints kept in the state (review L2)
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
export const AGENT_TAIL_BYTES = 2 * 1024 * 1024; // the tail of a subagent's transcript read for its texts (panel-v3)
const TRANSCRIPT_HEAD_BYTES = 256 * 1024;
const SCAN_STRINGS_MAX = 2000;
// Panel input 4 (6.10 F3, J1c): no mechanical shortening of what Jev judges. FIELD_MAX is only the safety ceiling of one string
// (the window of Jev); what it cuts is counted in `uciete_znaki` and counts as a failure, not as a rule.
export const FIELD_MAX = 100_000;
export const HISTORY_KEPT = 5; // hints of the current task shown to Jev with their effect (plan 3a, point 16)

// SECRET_PATH of jev-sekrety.mjs (hooks/jev-compaction.ts holds a copy of its block, testy/panel.mjs compares them). The panel checks
// every string of the input, so it covers every field of PATH_FIELDS there.
export { SECRET_PATH };
export const RESULT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'PowerShell', 'Edit', 'Write']);
export const SECRET_TOOL = /vault|password|secret/i;
const PATH_LINE = '[linia pominięta: ścieżka z sekretami]';
const PATH_CALL = '[pominięte: ścieżka z sekretami]';
// The error text of a tool outside RESULT_TOOLS is its output too (an MCP tool can echo data), so Jev gets only this mark.
const ERROR_MARK = '[błąd]';

// Head and tail of a long text with a marker in the middle (the form of headTail in jev-gate.mjs, which is not imported because that
// module loads the whole tool gate).
export function headTail(text, head, tail) {
  const s = String(text ?? '');
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)}\n[... pominięto ${s.length - head - tail} znaków ...]\n${s.slice(-tail)}`;
}
export const fit = (text, max) => headTail(text, Math.ceil(max * 0.6), Math.floor(max * 0.4));

// A text for Jev (cleanSecretText of jev-sekrety.mjs, review H1, B1, rec-N11-panel-sekrety HIGH 1): a text or a line that is JSON goes
// through the replacer below, every line with a SECRET_PATH match is replaced by a marker, the rest is masked (maskSecrets, then the
// name/value pairs, the values of secret keys in JSON text, private key blocks and long base64 runs), and a secret word with its value in
// free text ("password Abc12345", "PIN telefonu 482913") is masked by maskSecretProse (fala 3b, decision of the coordinator).
export function cleanText(text) {
  return cleanSecretText(text, (x) => maskSecretProse(maskSecrets(x)), PATH_LINE, maskSecrets);
}

// Every string of a value, cleaned before serialisation (review B1); the value of a key with a secret-like name is replaced whole, whatever
// its type, and so are the value of a name/value pair with a secret name and an argument after a secret flag (secretJsonReplacer of
// jev-sekrety.mjs, review rec-A2b-panel BLOCKER 2); the whole serialisation is masked again, like the compaction module does
// (rec-N11-panel-sekrety MEDIUM 1). LOW-2 of rec-3b: free text is masked by maskSecretProse on the strings only, before the serialisation (a value
// may hold a backslash, so on the serialised text it could eat the one before an escaped quote); the serialised text gets maskSecrets alone. M2 of
// the second round: maskSecrets can break the JSON text too (`password: ***\"` loses the backslash), so when the result does not parse the
// value is serialised again with the masks on the strings only.
export function safeJson(value) {
  const strings = (x) => maskSecretProse(maskSecrets(x));
  const whole = secretJson(value, strings, PATH_LINE, maskSecrets);
  try { JSON.parse(whole); return whole; } catch { return secretJson(value, strings, PATH_LINE, (x) => x); }
}

// Does any string of the value (keys too, nested objects and arrays) match SECRET_PATH (review H1)? Bounded walk; a value too large to
// walk counts as a match (fail closed: the call then sends only its name). secretPathIn also tests the string without quotes and
// backslashes and counts a glob in a hidden name (/.v*/x) as a match (rec-N11-panel-sekrety LOW 2).
export function anySecretPath(value) {
  let seen = 0;
  const walk = (v, depth) => {
    if (++seen > SCAN_STRINGS_MAX || depth > 8) return true;
    if (typeof v === 'string') return secretPathIn(v, true);
    if (Array.isArray(v)) return v.some((x) => walk(x, depth + 1));
    if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => secretPathIn(k, true) || walk(x, depth + 1));
    return false;
  };
  return walk(value, 0);
}

function responseText(response) {
  if (typeof response === 'string') return cleanText(response);
  const blocks = Array.isArray(response?.content) ? response.content : Array.isArray(response) ? response : null;
  if (blocks) {
    // A private key header in one block and its body in the next: the blocks are cleaned together, as the module does (N11h, review MEDIUM 1).
    const joined = blocks.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
    if (joined.search(SECRET_PEM) >= 0) return cleanText(joined);
    return blocks.map((b) => (typeof b?.text === 'string' ? cleanText(b.text) : '')).join('\n');
  }
  if (response === undefined || response === null) return '';
  return safeJson(response);
}

// One journal entry of a tool call; `error` is the error text of a failed call (PostToolUseFailure), `interrupted` an interrupted one.
export function callEntry(call, error, interrupted = false) {
  const tool = String(call?.tool_name ?? '?');
  if (SECRET_TOOL.test(tool)) return { narzedzie: tool };
  if (anySecretPath(call?.tool_input)) return { narzedzie: tool, wejscie: PATH_CALL };
  const input = typeof call?.tool_input === 'string' ? cleanText(call.tool_input) : safeJson(call?.tool_input ?? {});
  const entry = { narzedzie: tool, wejscie: fit(input, INPUT_MAX) };
  if (interrupted) entry.blad = '[przerwane przez użytkownika]';
  else if (typeof error === 'string') entry.blad = RESULT_TOOLS.has(tool) ? fit(cleanText(error), ERROR_MAX) : ERROR_MARK;
  else if (RESULT_TOOLS.has(tool)) entry.wynik = fit(responseText(call?.tool_response), RESULT_MAX);
  return entry;
}

// A string for Jev up to FIELD_MAX (panel input 4): { text, cut } with cut = the characters dropped (counted in uciete_znaki).
export function boundField(text, max = FIELD_MAX) {
  const s = String(text ?? '');
  if (s.length <= max) return { text: s, cut: 0 };
  return { text: fit(s, max), cut: s.length - max };
}

// Panel input 4: the journal entry of a call whole (input, result, error text), each string up to FIELD_MAX; `uciete` counts what was cut.
// The result and the error text of every tool go (masked by cleanText); only a call of a secret tool or with a secret path is sent without its
// input and result (the mask of the line, J1e of T2, will replace this), and the entry says so in `pominiete` (counted in the row).
export function callEntryFull(call, error, interrupted = false) {
  const tool = String(call?.tool_name ?? '?');
  if (SECRET_TOOL.test(tool)) return { narzedzie: tool, pominiete: 'narzedzie-sekretow' };
  if (anySecretPath(call?.tool_input)) return { narzedzie: tool, wejscie: PATH_CALL, pominiete: 'sciezka-sekretow' };
  let cut = 0;
  const take = (text) => { const b = boundField(text); cut += b.cut; return b.text; };
  const input = typeof call?.tool_input === 'string' ? cleanText(call.tool_input) : safeJson(call?.tool_input ?? {});
  const entry = { narzedzie: tool, wejscie: take(input) };
  if (interrupted) entry.blad = '[przerwane przez użytkownika]';
  else if (typeof error === 'string') entry.blad = take(cleanText(error));
  else if (call?.tool_response !== undefined) entry.wynik = take(responseText(call.tool_response));
  if (cut) entry.uciete = cut;
  return entry;
}

// --- panel state per agent (listy/<session>/<agent|main>.panel.json) ---------------------------------------------------------

export function panelPath(sessionId, key, env = process.env) {
  const p = listPath(sessionId, key, env);
  return p ? p.replace(/\.json$/, '.panel.json') : null;
}

function readJson(path) {
  try {
    const value = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// The panel state as it is on disk ({} without one), read without the lock: for the end of a turn, which counts no call (review rec-panel-v3 L4).
export function readPanelState(sessionId, key, env = process.env) {
  const path = panelPath(sessionId, key, env);
  return (path && readJson(path)) || {};
}

// fn(state) under the lock of jev-lista.mjs (withFileLock: random token, stale lock after 3 s); the returned state is written.
// Returns the written state, or null when the lock was not taken in time or the write failed (the caller logs it).
export function updatePanelState(sessionId, key, fn, env = process.env) {
  const path = panelPath(sessionId, key, env);
  if (!path) return null;
  try { mkdirSync(dirname(path), { recursive: true }); } catch { return null; }
  let next = null;
  const ok = withFileLock(path, () => {
    const value = fn(readJson(path) ?? {});
    atomicWriteFileSync(path, JSON.stringify(value));
    next = value;
  }, env);
  return ok ? next : null;
}

// The task in progress of the agent's list ('' without one): the unit of the 6-call counter and of the hint brake.
export function currentTask(sessionId, key, env = process.env) {
  const record = readList(sessionId, key, env);
  const task = inProgress(record)[0];
  return { record, task: task ? String(task.content ?? '') : '', note: task && typeof task.notatka === 'string' ? task.notatka : null };
}

// The key of a task for the hint brake: in the main thread with the owner prompt id, because every request has its own plan (review L2).
// prompt_id is optional on every hook input; without it the last id seen in this agent's panel state (lastPrompt) keeps one key per task.
export const taskKey = (data, task, lastPrompt = '') => (agentKey(data) === MAIN ? `${typeof data?.prompt_id === 'string' ? data.prompt_id : lastPrompt}|${task}` : task);

// Hints given for a task key, and the state after marking more of them (at most GIVEN_TASKS_KEPT newest task keys stay).
export const givenFor = (state, key) => new Set(Array.isArray(state?.podane?.[key]) ? state.podane[key] : []);
export function markGiven(state, key, names) {
  const podane = state?.podane && typeof state.podane === 'object' ? { ...state.podane } : {};
  const list = new Set(Array.isArray(podane[key]) ? podane[key] : []);
  for (const name of names) list.add(name);
  delete podane[key];
  podane[key] = [...list]; // re-inserted: the newest key is last
  const keys = Object.keys(podane);
  for (const old of keys.slice(0, Math.max(0, keys.length - GIVEN_TASKS_KEPT))) delete podane[old];
  return { ...state, podane };
}

// One step of the panel state for one hook call (pure; review L9). Returns { state, reason, journal }: reason null means no query.
// PostToolUseFailure: an interrupt neither counts as an error nor ends a series (its id is kept so the batch does not count it as a
// success); an error counts, its masked text waits for the batch (at most ERRORS_KEPT); the PANEL_ERRORS-th error in a row asks.
// PostToolBatch: only a successful last call of the batch ends the error series (review L1); a change of the task in progress asks;
// else every PANEL_EVERY calls of one task.
// Version 2 (review rec-panel-v2 M1, L9): a query from errors asks at the PANEL_ERRORS-th error of a series and then at most every
// PANEL_ERRORS errors (blad_od: the count at the last such query), and only while no other query from errors of this agent is in flight
// (blad_zapytanie: its start, a lease of ERROR_LEASE_MS, released by releaseErrorQuery after the query); both are decided under the lock
// of the panel state, so parallel failed calls of one batch give one query.
export function advance(previous, event, data, task, v2 = false, now = Date.now(), listSig = '') {
  const st = previous && typeof previous === 'object' ? { ...previous } : {};
  if (typeof data?.prompt_id === 'string') st.prompt_id = data.prompt_id;
  const key = (v2 ? taskKeyV2 : taskKey)(data, task, typeof st.prompt_id === 'string' ? st.prompt_id : '');
  st.dziennik = Array.isArray(st.dziennik) ? st.dziennik : [];
  if (v2) st.znaki = Array.isArray(st.znaki) ? st.znaki : [];
  st.bledne = st.bledne && typeof st.bledne === 'object' && !Array.isArray(st.bledne) ? { ...st.bledne } : {};
  st.przerwane = Array.isArray(st.przerwane) ? st.przerwane : [];
  st.bledy = Number.isInteger(st.bledy) ? st.bledy : 0;
  st.od_pytania = Number.isInteger(st.od_pytania) ? st.od_pytania : 0;
  st.zadanie = typeof st.zadanie === 'string' ? st.zadanie : '';
  st.podane = st.podane && typeof st.podane === 'object' ? st.podane : {};
  const id = typeof data?.tool_use_id === 'string' ? data.tool_use_id : null;
  if (event === 'PostToolUseFailure') {
    if (data?.is_interrupt === true) {
      if (id) st.przerwane = [...st.przerwane, id].slice(-ERRORS_KEPT);
      return { state: st, reason: null, journal: [] };
    }
    st.bledy += 1;
    const errorText = cleanText(typeof data?.error === 'string' ? data.error : String(data?.error ?? ''));
    const error = v2 ? boundField(errorText).text : fit(errorText, ERROR_MAX);
    if (id) {
      st.bledne[id] = error;
      const ids = Object.keys(st.bledne);
      for (const old of ids.slice(0, Math.max(0, ids.length - ERRORS_KEPT))) delete st.bledne[old];
    }
    if (v2) {
      st.blad_od = Number.isInteger(st.blad_od) && st.blad_od <= st.bledy ? st.blad_od : 0;
      const leased = Number.isFinite(st.blad_zapytanie) && st.blad_zapytanie <= now && now - st.blad_zapytanie < ERROR_LEASE_MS;
      if (st.bledy - st.blad_od < PANEL_ERRORS || leased) return { state: st, reason: null, journal: [], flags: [] };
      st.blad_od = st.bledy;
      st.blad_zapytanie = now;
      const sinceQuery = Number(st.nowe || 0) + 1;
      st.nowe = 0; // the calls up to this error go to this query
      return { state: st, reason: 'blad', journal: [...st.dziennik, callEntryFull(data, error)].slice(-Math.max(JOURNAL_CALLS, sinceQuery)), flags: [...st.znaki, callFlags(data, true)].slice(-Math.max(JOURNAL_CALLS, sinceQuery)), since: sinceQuery };
    }
    if (st.bledy === PANEL_ERRORS) return { state: st, reason: 'blad', journal: [...st.dziennik, callEntry(data, error)].slice(-JOURNAL_CALLS), flags: [] };
    return { state: st, reason: null, journal: [] };
  }
  const calls = Array.isArray(data?.tool_calls) ? data.tool_calls : [];
  const failed = (c) => typeof c?.tool_use_id === 'string' && Object.hasOwn(st.bledne, c.tool_use_id);
  const interrupted = (c) => typeof c?.tool_use_id === 'string' && st.przerwane.includes(c.tool_use_id);
  const last = calls.at(-1);
  if (last && !failed(last) && !interrupted(last)) {
    st.bledy = 0;
    if (v2) st.blad_od = 0;
  }
  const entryOf = v2 ? callEntryFull : callEntry;
  for (const c of calls) st.dziennik.push(entryOf(c, failed(c) ? st.bledne[c.tool_use_id] : undefined, interrupted(c)));
  if (!v2) st.dziennik = st.dziennik.slice(-JOURNAL_CALLS);
  if (v2) {
    // panel input 4: counters that go to Jev as signals (no rule here): all calls, calls since the last query, calls since the list changed
    st.razem = (Number.isInteger(st.razem) ? st.razem : 0) + calls.length;
    st.nowe = (Number.isInteger(st.nowe) ? st.nowe : 0) + calls.length;
    // the state keeps the calls since the last query (at least JOURNAL_CALLS), the flags of the signals cover the same calls
    st.znaki = [...st.znaki, ...calls.map((c) => callFlags(c, failed(c) && !interrupted(c)))].slice(-Math.max(JOURNAL_CALLS, st.nowe));
    st.dziennik = st.dziennik.slice(-Math.max(JOURNAL_CALLS, st.nowe));
    if (listSig && listSig !== st.lista_sig) { st.lista_sig = listSig; st.lista_od = 0; } else st.lista_od = (Number.isInteger(st.lista_od) ? st.lista_od : 0) + calls.length;
  }
  st.bledne = {};
  st.przerwane = [];
  let reason = null;
  if (key !== st.zadanie) { // a new task (or a new owner prompt in the main thread): the counter starts with this batch
    if (task) reason = 'zmiana-zadania';
    st.zadanie = key;
    st.od_pytania = calls.length;
  } else {
    st.od_pytania += calls.length;
  }
  if (!reason && st.od_pytania >= (v2 ? panelEvery() : PANEL_EVERY)) reason = 'wywolania';
  if (reason) st.od_pytania = 0;
  if (!v2) return { state: st, reason, journal: reason ? st.dziennik : [], flags: [] };
  const since = Number(st.nowe || 0);
  if (reason) { // the notes repeat: queries in a row with the same list (this is a signal for Jev, the rule of card A is not applied here)
    st.ta_sama = st.sig_zapytania === st.lista_sig && st.lista_sig ? (Number.isInteger(st.ta_sama) ? st.ta_sama : 0) + 1 : 0;
    st.sig_zapytania = st.lista_sig ?? '';
    st.nowe = 0;
  }
  return { state: st, reason, journal: reason ? st.dziennik.slice(-Math.max(JOURNAL_CALLS, since)) : [], flags: reason ? st.znaki.slice(-Math.max(JOURNAL_CALLS, since)) : [], since };
}

// The state after a query from errors (version 2): the lease of advance released (review rec-panel-v2 M1).
export function releaseErrorQuery(state) {
  const next = { ...state };
  delete next.blad_zapytanie;
  return next;
}

// --- texts of the agent ----------------------------------------------------------------------------------------------------

// The transcript of the agent: the main thread's transcript_path; for a subagent agent_transcript_path, else its own file next to the
// session transcript (subagentTranscriptPath of jev-task.mjs), or transcript_path itself when it already is that file.
export function agentTranscript(data) {
  const tp = typeof data?.transcript_path === 'string' ? data.transcript_path : '';
  if (agentKey(data) === MAIN) return tp || null;
  if (typeof data.agent_transcript_path === 'string' && data.agent_transcript_path) return data.agent_transcript_path;
  if (tp && basename(tp).startsWith(`agent-${data.agent_id}`)) return tp;
  return subagentTranscriptPath(tp, data.agent_id);
}

function readPart(path, fromEnd, maxBytes) {
  let fd;
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink() || !link.isFile()) return '';
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    const n = readSync(fd, buffer, 0, length, fromEnd ? size - length : 0);
    const text = buffer.toString('utf8', 0, n);
    return fromEnd && size > length ? text.slice(text.indexOf('\n') + 1) : text; // the first line of a cut tail is partial
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// Assistant texts (the text the agent writes between tool calls) from the newest backwards, at most `budget` characters in total;
// a text longer than the rest of the budget goes through headTail and ends the walk. Returned oldest first. `separator` (version 2) is
// the length of the string the caller joins the texts with: it counts against the budget, and a cut text keeps within the rest of it
// (review rec-panel-v2 M2: 60 short texts went over 4000 and the resolver cut the end of the newest one).
export function agentTexts(path, budget = TEXT_BUDGET, since = 0, separator = 0) {
  if (!path) return [];
  const texts = [];
  for (const line of readPart(path, true, TRANSCRIPT_TAIL_BYTES).split('\n')) {
    if (!line.includes('"assistant"')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type !== 'assistant' || !Array.isArray(row.message?.content)) continue;
    if (since > 0) { const at = Date.parse(row.timestamp); if (Number.isFinite(at) && at < since) continue; } // v2: only the texts of the current turn
    const text = row.message.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
    if (text) texts.push(text);
  }
  return packTexts(texts, budget, separator);
}

// The newest texts that fit `budget`, oldest first, each cleaned (the walk of agentTexts, shared with textWindow of panel-v3);
// `head(i)` is a marker put before the cleaned text i, counted against the budget.
function packTexts(texts, budget, separator, head = null, acc = null) {
  const out = [];
  let left = budget;
  for (let i = texts.length - 1; i >= 0 && left > 0; i--) {
    let text = (head ? head(i) : '') + cleanText(texts[i]);
    if (acc && text.length > FIELD_MAX) { acc.cut += text.length - FIELD_MAX; text = fit(text, FIELD_MAX); }
    const room = separator && out.length ? left - separator : left;
    if (text.length <= room) {
      out.unshift(text);
      left = room - text.length;
    } else {
      if (!separator) out.unshift(fit(text, Math.max(left - 60, 100)));
      else if (room >= CUT_TEXT_MIN) { if (acc) acc.cut += text.length - (room - CUT_MARK_MAX); out.unshift(fit(text, room - CUT_MARK_MAX)); } // the marker of headTail is under CUT_MARK_MAX characters
      break;
    }
  }
  return out;
}

// The prompt of a subagent: the first user message (not a tool result) of its own transcript, the same file agentTranscript names (review L6).
function promptFromTranscript(path, main = false) {
  if (!path) return null;
  for (const line of readPart(path, false, TRANSCRIPT_HEAD_BYTES).split('\n')) {
    if (!line.includes('"user"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'user') continue;
    if (main && (entry.isMeta || entry.isSidechain || entry.isCompactSummary)) continue; // the main thread: not a system row, a side thread or a summary
    const content = entry.message?.content;
    if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) continue;
    const raw = typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
    const cleaned = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    const text = main ? ownerTyped(cleaned) : cleaned; // the main thread: a slash command is its arguments, or nothing
    if (text) return text;
  }
  return null;
}

// The task prompt: for a subagent the prompt of its transcript, for the main thread the latest owner message (keyword-detector.mjs).
export function taskPrompt(data, env = process.env, transcript = agentTranscript(data)) {
  const text = agentKey(data) !== MAIN ? promptFromTranscript(transcript) : readOwnerTask(data?.session_id, null, env)?.owner_messages?.at(-1) ?? null;
  return typeof text === 'string' && text ? fit(cleanText(text), PROMPT_MAX) : null;
}

// --- questions and hints ----------------------------------------------------------------------------------------------------

// The questions are static text (no user text inside, as the resolver requires); the facts are in the state.
const Q = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });
// main: the main thread (osobna-sesja only there); delegate: the agent has the Agent tool (deleguj only then, review M4).
export function panelQuestions(main, delegate = true) {
  const questions = {};
  if (delegate) {
    questions.deleguj = Q('Czy następne kroki bieżącego zadania (pola polecenie, lista, ostatnie_wywolania, tekst_agenta) to seria prostych czynności (przeszukanie, wypisanie, policzenie, przepisanie), które lżejszy agent zrobi bez własnych decyzji?',
      'Następne kroki to seria prostych czynności bez decyzji', 'Następne kroki wymagają decyzji albo to nie seria prostych czynności');
  }
  if (main) {
    questions['osobna-sesja'] = Q('Czy w ostatnich krokach (ostatnie_wywolania, tekst_agenta) pojawiła się osobna praca, niepotrzebna do bieżącego zadania z pola polecenie?',
      'Jest osobna praca niepotrzebna do bieżącego zadania', 'Ostatnie kroki służą bieżącemu zadaniu');
  }
  questions.pytanie = Q('Czy agent przyjmuje w ostatnich krokach fakt albo decyzję, której nie podał właściciel w poleceniu (pole polecenie) ani dokument z ostatnich wyników?',
    'Agent przyjmuje fakt albo decyzję bez źródła', 'Fakty i decyzje mają źródło w poleceniu albo dokumencie');
  questions.utknal = Q('Czy ostatnie wywołania (ostatnie_wywolania) powtarzają nieudaną próbę bez nowej informacji?',
    'Ostatnie wywołania powtarzają nieudaną próbę', 'Ostatnie wywołania nie powtarzają nieudanej próby');
  questions.zrobione = Q('Czy zadanie z pola zadanie_w_toku jest już wykonane według ostatnich wyników (ostatnie_wywolania, tekst_agenta)? Gdy pole jest puste, odpowiedz nie.',
    'Zadanie w toku jest już wykonane', 'Zadanie w toku nie jest jeszcze wykonane albo go nie ma');
  questions.notka = Q('Czy z listy (pole lista), notki (pole notka) i ostatnich kroków nie wynika jasno, co agent teraz robi i po co, więc potrzebna jest notka?',
    'Nie wynika jasno, co agent robi i po co; potrzebna notka', 'Wynika jasno, co agent robi i po co');
  return questions;
}

// Mode of each question (owner, 10.11.2026: questions are turned off one by one after their accuracy in panel.jsonl is judged).
// OMC_JEV_PANEL_PYTANIA=notka:off,deleguj:shadow in the style of OMC_JEV; a bare name or an empty mode (notka, notka:) means off; no variable
// means every question active. Names and modes ignore the case, and _ in a name stands for - (osobna_sesja). off: the question is not sent to
// Jev; shadow: sent, the answer goes to panel.jsonl, no hint; active: as before. The panel's own mode (panel:shadow) still wins: a question is
// never more active than the panel. An unknown name or mode, or an entry with more than one colon, is reported (warnings: stderr and the
// panel.jsonl row, jev-panel.mjs) and has no effect (review rec-A2b-panel L1).
export const PANEL_QUESTION_NAMES = ['deleguj', 'osobna-sesja', 'pytanie', 'utknal', 'zrobione', 'notka'];
const QUESTION_MODES = new Set(['off', 'shadow', 'active']);
export function questionModes(env = process.env, v2 = false) {
  const NAMES = v2 ? PANEL_QUESTION_NAMES_V2 : PANEL_QUESTION_NAMES;
  const modes = Object.fromEntries(NAMES.map((name) => [name, name === 'slop' ? 'shadow' : 'active'])); // port: pre-tool-enforcer of this tree is not wired to the panel, so slop is logged only by default
  const raw = String(env.OMC_JEV_PANEL_PYTANIA ?? '').trim();
  const warnings = [];
  for (const entry of raw ? raw.split(',') : []) {
    const text = entry.trim();
    if (!text) continue;
    const parts = text.split(':').map((part) => part.trim());
    if (parts.length > 2) { warnings.push(`zły wpis "${text}" (więcej niż jeden dwukropek)`); continue; }
    let name = parts[0].toLowerCase().replace(/_/g, '-');
    const alias = v2 && V2_ALIAS[name] ? name : null;
    if (alias) name = V2_ALIAS[name]; // the old names still switch their successors off or to shadow
    const label = alias ? `${parts[0]} (teraz ${name})` : name; // review rec-panel-v2 L7: the name the owner wrote and the question it switches
    const mode = parts[1] || 'off';
    const wanted = mode.toLowerCase();
    if (!NAMES.includes(name)) warnings.push(`nieznane pytanie "${parts[0]}"`);
    else if (!QUESTION_MODES.has(wanted)) warnings.push(`nieznany tryb "${mode}" pytania ${label}`);
    else if (alias && wanted === 'active') warnings.push(`stara nazwa "${parts[0]}" (teraz ${name}): tryb active tylko pod nową nazwą`); // review L7
    else modes[name] = wanted;
  }
  if (v2 && env.OMC_JEV_SLOP_PRETOOL === 'on') modes.slop = 'off'; // the old query of pre-tool-enforcer is back: the panel does not ask the same question again
  return { modes, set: raw !== '', warnings };
}

// Does the panel ask the question `slop` (the former point slop-warning) for this hook environment? The same conditions as runPanel and the hook of the
// batch have, so pre-tool-enforcer is silent only when the panel will really ask: version 2, the point named and not off, the hooks not skipped, the question
// `slop` active, the breaker closed. The caller has checked jevModeFor('panel') === 'active' (it lives in jev-shadow.mjs).
export async function panelAsksSlop(env = process.env) {
  if (!panelV2(env) || !env.TYPESAFE_API_KEY) return false;
  const named = String(env.OMC_JEV ?? '');
  if (!/(?:^|,)\s*panel\s*(?::[^,]*)?(?:,|$)/.test(named) || /(?:^|,)\s*panel\s*:\s*off\s*(?:,|$)/i.test(named)) return false;
  if (skipped('jev-panel', env) || skipped('post-tool-batch', env)) return false;
  if (questionModes(env, true).modes.slop !== 'active') return false;
  return true;
}

// Each hint is a sentence that stands alone, without the question it answers (review M5).
export function panelHint(name, main) {
  switch (name) {
    case 'deleguj': return 'Jeśli następne kroki tego zadania to seria prostych czynności, zleć je agentowi mechanik albo Explore, najwyżej jednemu naraz.';
    case 'osobna-sesja': return 'Pracę niepotrzebną do bieżącego zadania zaproponuj właścicielowi jako osobną sesję.';
    case 'pytanie': return main
      ? 'Faktu ani decyzji, których nie podał właściciel ani dokument, nie zgaduj: dopisz pytanie do listy pytań do właściciela.'
      : 'Faktu ani decyzji, których nie podało polecenie ani dokument, nie zgaduj: zwróć pytanie prowadzącemu w raporcie.';
    case 'utknal': return 'Gdy kolejna próba powtarza nieudaną bez nowej informacji, zmień podejście; w sesji ręcznej skonsultuj doradcę.';
    case 'zrobione': return 'Gdy zadanie w toku jest już wykonane, oznacz je na liście zadań jako zakończone.';
    case 'notka': return 'Dopisz do zadania w toku jedno zdanie notki: co robisz i po co.';
    default: return '';
  }
}

// The state sent to Jev for one query; every text goes through cleanText (review H1).
export function panelState(data, journal, reason, env = process.env) {
  const key = agentKey(data);
  const { record, task, note } = currentTask(data.session_id, key, env);
  const transcript = agentTranscript(data);
  return {
    state: {
      rola: key === MAIN ? 'sesja główna' : 'subagent',
      agent_type: typeof data?.agent_type === 'string' ? data.agent_type : null,
      powod: reason,
      polecenie: taskPrompt(data, env, transcript),
      lista: Array.isArray(record?.items) ? record.items.map((x) => ({ content: cleanText(x.content), status: x.status })) : null,
      zadanie_w_toku: task ? cleanText(task) : null,
      notka: note ? cleanText(note) : null,
      ostatnie_wywolania: journal,
      tekst_agenta: agentTexts(transcript).join('\n---\n'),
    },
    transcript,
  };
}

// --- panel version 2 (OMC_JEV_PANEL_WERSJA=2; N29 found 7 right hints of 65 in version 1) -------------------------------------
// What changes, each with its measured reason (report panel-od-nowa-stan.md):
// - the main thread's owner messages are read from the transcript (user rows and queued commands of origin human), because the task record
//   of jev-task.mjs is written only while the tool gate is on, so `polecenie` was null in 80 of 80 main-thread queries;
// - the hook counts signals from the last calls and asks a question only when there is something to judge (utknal after two errors,
//   deleguj after a run of reads, zrobione with a task in progress that did not just start, zrodlo after a write);
// - osobna-sesja and pytanie asked Jev to prove that something is absent; their successors poboczne and zrodlo are choice questions with the
//   harmless explanations as rival answers; notka needs no model (a task in progress without a note is a fact);
// - the brake key of the main thread has no prompt id (90 owner messages in 2.5 h reset it 43 times), every hint names what to do.
export const panelV2 = (env = process.env) => String(env.OMC_JEV_PANEL_WERSJA ?? '').trim() === '2';
// A set OMC_JEV_PANEL_WERSJA other than 1 or 2 runs version 1 and is reported (review rec-panel-v2 L8); null when the value is fine.
export function panelVersionWarning(env = process.env) {
  const value = String(env.OMC_JEV_PANEL_WERSJA ?? '').trim();
  return value && value !== '1' && value !== '2' ? `OMC_JEV_PANEL_WERSJA: nieznana wartość "${value.slice(0, 40)}", działa wersja 1` : null;
}
export const PANEL_QUESTION_NAMES_V2 = ['deleguj', 'poboczne', 'zrodlo', 'utknal', 'zrobione', 'notka', 'slop'];
// Plan v2, 6.10 F7: every question is active when the variable is missing or misspelt; shadow and off are set by the owner alone with
// OMC_JEV_PANEL_PYTANIA.
const V2_ALIAS = { pytanie: 'zrodlo', 'osobna-sesja': 'poboczne' };
export const OWNER_KEPT = 4; // owner messages sent to Jev (main thread)
export const OWNER_MAX = 1000;
export const BRIEF_CHUNK = 3900; // a subagent's brief goes in up to two strings, because the resolver cuts every string at 4000 characters
const BRIEF_MARK = 40; // room for the marker in the second string of a cut brief
export const TEXT_BUDGET_V2 = 18_000; // panel input 4: the texts of one query go whole (each up to FIELD_MAX) within about half of what the window of Jev leaves (40 000 bytes of the body, T2's measurement, minus the questions; the briefs, the calls and the list share the rest); what does not fit waits for the next query (`teksty_czekaja`), none is passed over
const OWNER_RAW_CHARS = 32 * 1024; // a long owner message is masked only in whole lines of its head and tail (review rec-panel-v2 L2)
export const ERROR_LEASE_MS = 10_000; // a query from errors in flight holds the series this long at most (the hook's limit is 8 s)
const CUT_TEXT_MIN = 160; // version 2: an older text is cut only when at least this much budget is left
const CUT_MARK_MAX = 60;
const TEXT_SEPARATOR = '\n---\n';
const OWNER_TAIL_BYTES = 6 * 1024 * 1024; // the 4th latest owner message lay up to 3.1 MiB from the end of a busy coordinator transcript (91 queries; 2 MiB reached it in 78); reading 6 MiB takes about 25 ms
const STATE_STRING_MAX = 4000;
const PURE_READ = new Set(['Read', 'Grep', 'Glob']);
const HANDS_OFF = /^(Edit|Write|NotebookEdit|Agent|Task|SendMessage|TaskCreate|TaskUpdate|TodoWrite)$|lista_zadan$|update_plan$/;
// An MCP tool writes when a segment of its name after __ is a verb of change (state_write, notepad_write_manual, trash_file, delete_draft;
// review rec-panel-v2 L3).
const WRITE_TOOL = /^(Edit|Write|NotebookEdit|SendMessage|Agent|Task)$|__(?:[a-z0-9]+_)*(?:create|send|update|reply|forward|write|delete|trash|remove)(?:_|$)/i;
// A shell command that writes, sends or changes something: tee, sed -i, perl -i, git and gh commands that change state, systemctl
// changes, rm, mv, cp, mkdir, touch and the like, dd of=, tar x/c, unzip, curl with a method or data, sqlite3 with a changing statement,
// python3 with a script. A reading command (grep, cat, ls, git log, git branch -a) does not match.
export const BASH_WRITES = /\btee\b|\b(?:sed|perl)\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*i|\bgit\s+(?:-[Cc]\s+\S+\s+)*(?:commit|push|merge|rebase|tag|reset|checkout|apply|am|cherry-pick|stash|add|rm|mv|restore|switch|clean|pull|branch\s+(?:-[dDmMcCf]\b|[^-\s]))|\bgh\s+(?:pr|issue|api|release)\b|\bsystemctl\s+(?:set-property|enable|disable|start|stop|restart|daemon-reload)\b|(?:^|[;&|\s(])(?:rm|mv|cp|chmod|chown|ln|patch|kill|pkill|crontab|growpart|resize2fs|install|mkdir|touch|truncate|unzip|rmdir|rsync)\s|\bdd\s[^|;&]*\bof=|\btar\s+-?[a-zA-Z]*[xcru]|\bcurl\b[^|;&]*(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\s(?:-d|--data[a-z-]*|-F|--form|-T|--upload-file)[\s=])|\bsqlite3\b[\s\S]*\b(?:INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|REPLACE|VACUUM)\b|\bpython3?\s+(?:-[a-zA-Z]+\s+)*(?!-)\S+\.py\b/;
// A redirect to a file, tested on the command without its quoted strings (=>, ->, a > b in awk, jq, python -c are not redirects): not to
// /dev/null, not 2>&1 or 2>file, not >> /dev/null.
const BASH_REDIRECT = /(?<![0-9&<>=-])>>?(?![>&])\s*(?!\/dev\/null(?![^\s;&|)]))\S/;
const unquoted = (command) => command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
export const writesCall = (name, input) => {
  if (WRITE_TOOL.test(String(name))) return true;
  if (name !== 'Bash' && name !== 'PowerShell') return false;
  const command = String(input?.command ?? '');
  return BASH_WRITES.test(command) || BASH_REDIRECT.test(unquoted(command));
};
// What the hook keeps of one call for the signals: the tool name, whether it writes, whether it failed, and (panel input 4, J6) whether it
// reads (a reading tool or a reading shell command: the run of reads that gates deleguj counts the shell too), whether a shell result
// reports a failure (FAIL, not ok, Error:, Traceback, a non-zero exit code: the test that fails four times in a Bash result has no tool
// error), and the command with its numbers and temporary paths removed (the same command failing again). These are signals that go to Jev as
// numbers in `sygnaly`; no rule decides on them.
const BASH_READS = /\b(?:grep|rg|cat|head|tail|ls|find|wc|jq|awk|cut|stat|diff|nl|file|tree|git\s+(?:log|diff|show|status|grep|branch)|sed\s+-n)\b/;
const RESULT_FAIL = /\bFAIL(?:ED|URE)?\b|\bnot ok\b|\bError:|\bTraceback\b|exit code [1-9]|\bERR!/;
const resultFlat = (response) => {
  if (typeof response === 'string') return response.slice(0, 20_000);
  try { return JSON.stringify(response ?? '').slice(0, 20_000); } catch { return ''; }
};
export const callFlags = (call, failed = false) => {
  const name = String(call?.tool_name ?? '?').slice(0, 80);
  const writes = writesCall(call?.tool_name, call?.tool_input);
  const shell = call?.tool_name === 'Bash' || call?.tool_name === 'PowerShell';
  const command = shell ? String(call?.tool_input?.command ?? '') : '';
  const flags = { n: name, z: writes ? 1 : 0, b: failed ? 1 : 0 };
  if (PURE_READ.has(name) || (shell && !writes && BASH_READS.test(command))) flags.r = 1;
  if (shell && !failed && RESULT_FAIL.test(resultFlat(call?.tool_response))) flags.w = 1;
  if (shell && (failed || flags.w)) flags.c = command.replace(/\/(?:tmp|var\/tmp)\/\S+/g, '/tmp/X').replace(/[0-9]+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 100);
  return flags;
};

// The brake key of version 2: the task alone; the prompt id only while the main thread has no task in progress.
export const taskKeyV2 = (data, task, lastPrompt = '') => (task || agentKey(data) !== MAIN ? task : `${typeof data?.prompt_id === 'string' ? data.prompt_id : lastPrompt}|`);

// Signals of the last calls (flags of advance), counted by the hook: errors, a write, a run of reads (at least 5 of the 6 last calls are
// Read, Grep or Glob and none edits, delegates or touches the list). `text` (panel-v3): the query has a new text of the agent.
export function panelSignals(flags, task, note, reason, main, delegate, text = false) {
  const list = Array.isArray(flags) ? flags : [];
  const names = list.map((f) => String(f?.n ?? ''));
  const repeats = new Map();
  for (const f of list) if (f?.c && (f.b || f.w)) repeats.set(f.c, (repeats.get(f.c) ?? 0) + 1);
  return {
    main, delegate, task: Boolean(task), note: Boolean(note), reason, text: Boolean(text),
    errors: list.filter((f) => f?.b).length,
    writes: list.some((f) => f?.z),
    readRun: names.length >= JOURNAL_CALLS && names.filter((n) => PURE_READ.has(n)).length >= JOURNAL_CALLS - 1 && !names.some((n) => HANDS_OFF.test(n)),
    // panel input 4 (J6): the gates of version 2 become numbers for Jev
    reads: list.filter((f) => f?.r).length,
    shellFails: list.filter((f) => f?.w).length,
    repeatedFail: Math.max(0, ...repeats.values()),
    edits: names.filter((n) => HANDS_OFF.test(n)).length,
  };
}

const C = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
const UTKNAL = Q('Czy w ostatnich wywołaniach (ostatnie_wywolania) ta sama czynność nie udała się co najmniej dwa razy (pole blad albo wynik z błędem, na przykład test, który pada), a ostatnia próba powtarza poprzednią bez istotnej zmiany? Pomaga sygnaly.powtorzone_niepowodzenie.',
  'Ta sama czynność zawodzi powtórnie bez zmiany podejścia', 'Błędy dotyczą różnych czynności albo agent po błędzie zmienił podejście albo błędów nie ma');
// The questions of version 2 for one query: static text, all six asked in every query (J6: the gates of version 2 became the
// numbers of `sygnaly`, which Jev reads with the whole input). `sig` is kept for the callers; nothing is decided by it here.
export function panelQuestionsV2(sig) { // eslint-disable-line no-unused-vars
  return {
    deleguj: Q('Czy ostatnie wywołania (ostatnie_wywolania; sygnaly.odczyty to liczba odczytów w ostatnich sześciu) to seria prostych czynności jednego rodzaju (odczyt kolejnych plików, przeszukiwanie, wypisywanie, liczenie), a z tekstu, listy albo wywołań wynika, że takich kroków zostało jeszcze co najmniej trzy, i nie wymagają one decyzji, więc nadają się do zlecenia agentowi Explore albo mechanik? Odpowiedz nie, gdy agent czyta kod do zmiany, którą zaraz robi sam, gdy kroki są różnego rodzaju, gdy seria się kończy, gdy agent już deleguje albo gdy pole moze_delegowac jest false.',
      'Seria prostych czynności jednego rodzaju bez decyzji i zostały jeszcze co najmniej trzy takie kroki', 'Kroki wymagają decyzji, są różnego rodzaju, seria się kończy, agent już deleguje albo nie może delegować'),
    poboczne: C('Czemu służą ostatnie wywołania agenta (ostatnie_wywolania, tekst_agenta)?', {
      polecenie: 'Wykonują jedno z poleceń z pola polecenia (właściciela albo zlecenie dla subagenta) albo odpowiadają na jego pytanie',
      lista: 'Wykonują zadanie z listy (pola lista, zadanie_w_toku), także aktualizację listy i planu',
      agenci: 'Obsługują pracę agentów: raporty, powiadomienia, wiadomości, zlecenia, recenzje, scalanie ich wyników',
      poboczne: 'To nowa praca znaleziona przy okazji (naprawa, porządki, ulepszenie), której nie ma w poleceniach ani na liście i o którą nikt nie prosił',
    }),
    zrodlo: C('Agent wykonuje zlecenie z pola polecenia. Wybierz najważniejszą wartość albo decyzję, którą agent podaje jako fakt albo wynik w swoim tekście (tekst_agenta, tekst_poprzedni: raport, wiadomość kończąca turę) albo zapisuje w ostatnich wywołaniach (ostatnie_wywolania: plik, konfiguracja, plan, wiadomość). Skąd ona pochodzi?', {
      zlecona: 'Wynika z poleceń (pole polecenia), listy zadań albo stałych zasad pracy: agent wykonuje to, co mu zlecono',
      odczytana: 'Pochodzi z wyniku narzędzia, pliku, pomiaru albo raportu innego agenta widocznego w polach ostatnie_wywolania lub tekst_agenta',
      'nic-nie-zapisuje': 'Agent nie podaje ani nie zapisuje żadnej konkretnej wartości ani rozstrzygnięcia: czyta, szuka, mierzy, uruchamia testy, opisuje kroki albo pyta',
      zalozona: 'Agent sam ją przyjął: konkretnej liczby, daty, godziny, limitu albo rozstrzygnięcia nie ma w poleceniach ani w wynikach, a agent podaje ją albo zapisuje jako fakt',
    }),
    utknal: UTKNAL,
    zrobione: Q('Czy zadanie z pola zadanie_w_toku albo inne niezakończone zadanie z pola lista jest już wykonane według ostatnich wyników (ostatnie_wywolania, tekst_agenta, tekst_poprzedni), a na liście nie jest oznaczone jako zakończone? Gdy nie ma listy ani niezakończonych zadań, odpowiedz nie. Pomaga sygnaly.wywolan_bez_zmiany_listy.',
      'Zadanie jest już wykonane, a na liście nie jest zakończone', 'Praca nad zadaniami trwa, zadania są już oznaczone albo nie ma listy'),
    // the former point slop-warning (pre-tool-enforcer asked Jev about every tool call in a query of its own): since 11.11 the same question is asked
    // here, once per query after a batch, about all the calls of the journal; the answer is logged as slop-warning in applied.jsonl (zrodlo: zapytanie-po-paczce)
    slop: Q('Czy któreś z ostatnich wywołań (ostatnie_wywolania: polecenie, treść zapisywanego albo edytowanego pliku, wiadomość) zawiera język obejścia (fallback, workaround, doraźna warstwa zgodności, shim, łatka pod jedno środowisko), który zasługuje na ostrzeżenie dla agenta? Odpowiedz nie, gdy to dokumentacja, instrukcja, tekst o samym ostrzeżeniu albo zwykły opis techniczny bez obejścia.',
      'Wywołanie zawiera język obejścia wart ostrzeżenia poza dokumentacją i tekstem o samym ostrzeżeniu', 'Brak języka obejścia wartego ostrzeżenia'),
    notka: Q('Czy lista zadań agenta jest nieaktualna? Tak, gdy zadanie w toku (zadanie_w_toku) albo jego notka (notka) nie opisują już tego, co agent robi w ostatnich krokach (ostatnie_wywolania, tekst_agenta), albo praca nad zadaniem jest faktycznie skończona, a zadanie nadal stoi w toku, albo agent pracuje nad zadaniem bez notki. Sygnały wywolan_bez_zmiany_listy i ta_sama_lista_zapytan pokazują tylko, jak dawno lista się nie zmieniała: sama długa cisza listy nie oznacza, że jest nieaktualna, jeśli praca nadal toczy się w opisanym zadaniu. Gdy agent nie ma zadania w toku, odpowiedz nie.',
      'Lista albo notka jest nieaktualna', 'Lista i notka opisują to, co agent teraz robi, albo nie ma zadania w toku'),
  };
}
// The names a role can be asked at all (for the early exit when all of them are off): since J6 all six, for every role.
export const askableV2 = () => [...PANEL_QUESTION_NAMES_V2];
// What the hint of each question says, in one sentence for the choice question `pokaz`: Jev picks which hint to show, or none (plan 6.10 F20).
const HINT_GIST = {
  deleguj: 'zlecić kolejne proste odczyty jednemu agentowi Explore albo mechanik',
  poboczne: 'dopisać pracę poboczną na listę albo zlecić ją w tle i wrócić do zadania',
  zrodlo: 'sprawdzić w źródle wartość, której nie ma w poleceniach ani wynikach, albo oznaczyć ją jako własne założenie',
  utknal: 'nie powtarzać nieudanej czynności i zmienić podejście',
  zrobione: 'zakończyć zadanie na liście albo dopisać, czego brakuje',
  notka: 'zaktualizować listę: dopisać albo poprawić notkę zadania w toku',
  slop: 'nie dokładać doraźnych warstw zgodności ani łatek pod jedno środowisko bez uzasadnienia, a założenia środowiskowe zapisać w raporcie',
};
// The question that lets Jev choose among the hints (one hint per batch, and none when the history of the task says it was given in vain);
// `names` are the questions asked in this query with the mode active. Static text.
export function pokazQuestion(names) {
  const criteria = { zadna: 'Podobna podpowiedź padła już niedawno w tym zadaniu i nic nie zmieniła (pole historia_podpowiedzi), albo agent już zrobił to, co zaleca podpowiedź' };
  for (const name of names) if (HINT_GIST[name]) criteria[name] = `Pokaż agentowi podpowiedź: ${HINT_GIST[name]}`;
  return C('Pozostałe pytania tego zapytania osądzają osobno, czy dana podpowiedź jest zasadna. Którą jedną podpowiedź pokazać agentowi teraz (stan: polecenia, lista, ostatnie_wywolania, tekst_agenta, sygnaly)? Gdy zasadnych jest kilka, wybierz tę, która agentowi najbardziej pomoże. Wybierz zadna tylko wtedy, gdy historia_podpowiedzi pokazuje podobną podpowiedź bez skutku albo agent już zrobił to, co zaleca podpowiedź.', criteria);
}
// notka without a model: a task in progress without a note after PANEL_EVERY calls in it. Since panel input 4 only the K3 reserve of the
// notka question (Jev gave no answer), logged with kto: k3.
export const noteRule = (sig) => sig.task && !sig.note && sig.reason === 'wywolania';
export const CHOICE_TARGET = { zrodlo: 'zalozona', poboczne: 'poboczne' };
// One answer of Jev as { p, yes, choice }: no threshold (plan 6.10 F8): a yes/no question says yes when the yes answer is the larger of
// the two, a choice question when its target is the answer Jev chose (the one with the highest probability). p is the probability of the
// yes (yes/no questions) or of the target answer (choice questions), null when the question got no answer.
export function panelAnswerV2(name, answer) {
  if (!answer || typeof answer !== 'object') return { p: null, yes: false };
  if (Object.hasOwn(CHOICE_TARGET, name)) {
    const target = CHOICE_TARGET[name];
    const raw = answer.probabilities?.[target];
    const p = typeof raw === 'number' && Number.isFinite(raw) ? raw : answer.choice === target && typeof answer.confidence === 'number' ? answer.confidence : answer.choice === target ? 1 : 0;
    return { p, yes: answer.choice === target, choice: typeof answer.choice === 'string' ? answer.choice.slice(0, 40) : null };
  }
  const p = typeof answer.noul === 'boolean' ? (answer.noul ? 1 : 0) : typeof answer.noul === 'number' && Number.isFinite(answer.noul) ? answer.noul : null;
  return { p, yes: p !== null && p >= 0.5 };
}
// The hint Jev chose among the offered ones: the name, 'zadna', or null when there is no usable answer.
export function pokazChoice(answer, offered) {
  const choice = typeof answer?.choice === 'string' ? answer.choice : null;
  return choice && (choice === 'zadna' || offered.includes(choice)) ? choice : null;
}

// Each hint names the action; the task name comes from the agent's own list and goes only back to that agent. `facts` (panel input 4):
// { stale } the calls since the list changed, for the one hint of an out-of-date list.
export function panelHintV2(name, main, task = '', facts = {}) {
  const named = task ? ` „${fit(cleanText(task), 90).replace(/\s+/g, ' ')}”` : '';
  switch (name) {
    case 'deleguj': return 'Ostatnie wywołania to seria odczytów i przeszukiwań. Jeśli zostało ich więcej, zleć je jednemu agentowi Explore albo mechanik: podaj mu listę plików i pytanie, na które ma odpowiedzieć.';
    case 'poboczne': return 'Ostatnie kroki to praca poboczna, której nie ma w poleceniach ani na liście. Dopisz ją na listę jako osobne zadanie albo zleć agentowi w tle i wróć do zadania w toku.';
    case 'zrodlo': return main
      ? 'Zapisujesz wartość albo decyzję, której nie ma w poleceniach ani w odczytanych wynikach. Sprawdź ją w źródle jednym poleceniem (plik, dziennik, pomiar); jeśli to Twój wybór, napisz to wprost obok tej wartości.'
      : 'Zapisujesz wartość albo decyzję, której nie ma w zleceniu ani w odczytanych wynikach. Sprawdź ją w źródle jednym poleceniem; jeśli to Twój wybór, oznacz ją w raporcie jako własne założenie.';
    case 'utknal': return 'Ta sama czynność nie udała się co najmniej dwa razy. Nie powtarzaj jej: przeczytaj treść błędu i zmień podejście (inne narzędzie, inna ścieżka, mniejszy krok), a blokadę hooka albo uprawnień zapisz w raporcie i idź dalej.';
    case 'slop': return `Ostrzeżenie: w ostatnich wywołaniach jest język obejścia (fallback, workaround). Nie dokładaj doraźnych warstw zgodności, shimów ani łatek pod jedno środowisko bez wyraźnego uzasadnienia; ${facts.delegate === false ? '' : 'przy kwestii architektury zleć projekt architektowi, a '}założenia środowiskowe zapisz w raporcie.`;
    case 'zrobione':
    case 'notka':
      if (name === 'notka' && facts.noNote) return `Zadanie w toku${named} nie ma notki. Dopisz jedno zdanie: co robisz i po co.`;
      // one hint for the out-of-date list, whichever question said it (plan 5, card A)
      return `Lista zadań jest nieaktualna: zadanie w toku${named} ma notkę sprzed ${facts.stale > 0 ? `co najmniej ${facts.stale} wywołań` : 'wielu wywołań'}. Oznacz je jako zakończone albo popraw notkę jednym zdaniem.`;
    default: return '';
  }
}

// The text of one owner message for Jev (review rec-panel-v2 L2): a message longer than 2 x OWNER_RAW_CHARS is masked only in the whole
// lines of its head and tail (a first or last line longer than that is dropped whole); a tail that starts inside a private key block
// loses everything up to its END line, so no key body passes without its header. Then head and tail as fit does it.
const KEY_END = /-{4,5} ?END (?:[A-Z0-9]+[ -])*PRIVATE KEY(?: BLOCK)? ?-{4,5}[^\n]*\n?/g;
function ownerText(raw) {
  if (raw.length <= 2 * OWNER_RAW_CHARS) return boundField(cleanText(raw));
  const head = raw.slice(0, raw.lastIndexOf('\n', OWNER_RAW_CHARS) + 1);
  const from = raw.indexOf('\n', raw.length - OWNER_RAW_CHARS - 1);
  let tail = from < 0 ? '' : raw.slice(from + 1);
  let end = 0;
  for (const m of tail.matchAll(KEY_END)) end = m.index + m[0].length;
  tail = tail.slice(end);
  const h = cleanText(head);
  const t = cleanText(tail);
  const dropped = raw.length - h.length - t.length;
  return { text: `${h}\n[... pominięto około ${dropped} znaków ...]\n${t}`, cut: dropped }; // masked in whole lines of head and tail only, so the middle is not sent
}

// What the owner typed (review rec-panel-v2 L6): the remote-control wrapper <hc from="..."> is removed, a skill call keeps its
// <command-args>; slash commands without arguments and their output are not messages ('' then).
function ownerTyped(text) {
  const inner = text.replace(/^<hc\b[^>]*>([\s\S]*)<\/hc>$/, '$1').trim();
  if (/^<command-message>/.test(inner)) return (/<command-args>([\s\S]*?)<\/command-args>/.exec(inner)?.[1] ?? '').trim();
  if (/^<(?:command-name|command-message|local-command)/.test(inner) || /^\/[\w:.-]+$/.test(inner)) return '';
  return inner;
}

// The latest owner messages of the main thread, oldest first, as { t, text }: user rows of origin human and queued commands of origin
// human (a message typed while the agent works arrives as an attachment and never passes UserPromptSubmit) from the tail of the
// transcript. Slash commands and their output are not messages. A host that writes no origin gives none (the caller falls back).
// The order is the time and then the place in the file; a row without a time takes the time of the row before it (review L5).
export function ownerMessages(path, kept = OWNER_KEPT, lines = null) {
  if (!path) return [];
  const seen = new Set();
  const found = [];
  let lastT = 0;
  for (const line of lines ?? tailLines(path, OWNER_TAIL_BYTES)) { // panel-v3: panelStateV2 reads the tail once for the messages and the texts
    if (!line.includes('"human"')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    let raw = null;
    if (row?.type === 'user' && row.origin?.kind === 'human' && !row.isMeta && !row.isSidechain) {
      const content = row.message?.content;
      if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) continue;
      raw = typeof content === 'string' ? content
        : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : null;
    } else if (row?.type === 'attachment' && row.attachment?.type === 'queued_command' && row.attachment.origin?.kind === 'human') {
      raw = typeof row.attachment.prompt === 'string' ? row.attachment.prompt : null;
    }
    if (typeof raw !== 'string') continue;
    const text = ownerTyped(raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim());
    if (!text) continue;
    const parsed = Date.parse(row.timestamp ?? row.attachment?.timestamp);
    const id = `${Number.isFinite(parsed) ? parsed : ''}|${text}`;
    if (seen.has(id)) continue; // a resumed session writes the same row again
    seen.add(id);
    if (Number.isFinite(parsed)) lastT = parsed;
    found.push({ t: lastT, i: found.length, text });
  }
  const sorted = found.sort((a, b) => a.t - b.t || a.i - b.i);
  const kept4 = sorted.slice(-kept).map((m) => { const o = ownerText(m.text); return { t: m.t, text: o.text, cut: o.cut }; });
  kept4.older = sorted.length - kept4.length; // the owner messages of the tail read that are not sent (a signal for Jev: polecenia_starsze)
  return kept4;
}

// A subagent's brief in at most two strings of BRIEF_CHUNK characters (the start and the end of a longer one).
export function briefChunks(text) {
  const s = cleanText(text);
  if (s.length <= BRIEF_CHUNK) return [s];
  if (s.length <= 2 * BRIEF_CHUNK) return [s.slice(0, BRIEF_CHUNK), s.slice(BRIEF_CHUNK)];
  return [s.slice(0, BRIEF_CHUNK), `[... pominięto ${s.length - BRIEF_CHUNK - (BRIEF_CHUNK - BRIEF_MARK)} znaków ...]\n${s.slice(-(BRIEF_CHUNK - BRIEF_MARK))}`]; // review rec-panel-v2 L4
}

// --- the texts of the agent for one query (panel-v3, 11.11.2026) -----------------------------------------------------------------
// Measured on the 100 queries of version 2 in panel.jsonl from 12:42Z: tekst_agenta was empty in 62. A subagent had written no text at
// all by the query in 57 of the 57 empty ones (it writes its report when its turn ends; the thinking is not in the transcript). In the
// main thread the text was there, but older than the last owner message (3 of 6: the report that ended the turn before) or beyond the
// 512 KiB tail, which one busy minute of the coordinator fills (3 of 6). So: the tail is read once and wide enough, a query from a batch
// gets the texts written since the last sent query of this agent (the mark tekst_do, tekst_wiersz of the panel state: every text is
// sent once), the text that ended the turn before included, and the end of a turn (Stop, SubagentStop) is a query of its own, without
// a hint and with its own mark (tekst_koniec_do, tekst_koniec_wiersz).
export const END_EVENTS = new Set(['Stop', 'SubagentStop']);
export const END_REASON = 'koniec-tury';
export const END_TIMEOUT_MS = 800; // the longest the end of a turn waits for Jev's answer (review rec-panel-v3 H1); the answer is only logged
const COPY_SLACK_MS = 1000; // a row a compaction wrote again carries a time up to this much after its boundary row (review M2)
const LAST_ROW_TRIES = 20;
const LAST_ROW_CHARS = 64 * 1024; // a longer line (an API request row) is not parsed just to read a time
const BEFORE_OWNER = '[tekst sprzed ostatniego polecenia właściciela]\n';
const tailLines = (path, bytes) => (path ? readPart(path, true, bytes).split('\n') : []);

// The assistant texts of transcript lines, oldest first, as { t, text, i, id }: the time, the index of the line and the uuid of the
// row; a row without a time takes the time of the row before it. A compaction writes the kept rows again after its boundary row, all
// with the time of the compaction (20 compactions of one session: 150 to 230 old texts each, 0.44 s before the boundary), so a row
// that follows a compact_boundary row and is not newer than it by more than COPY_SLACK_MS is a copy and is skipped.
export function textRows(lines) {
  const rows = [];
  let lastT = 0;
  let boundary = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('"assistant"') && !line.includes('"compact_boundary"')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const at = Date.parse(row?.timestamp);
    if (Number.isFinite(at)) lastT = at;
    if (row?.type === 'system' && row.subtype === 'compact_boundary') { boundary = lastT; continue; }
    if (row?.type !== 'assistant' || !Array.isArray(row.message?.content) || (boundary > 0 && lastT <= boundary + COPY_SLACK_MS)) continue;
    const text = row.message.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
    if (text) rows.push({ t: lastT, text, i, id: typeof row.uuid === 'string' ? row.uuid : '' });
  }
  return rows;
}

// The oldest texts that fit `budget`, in order, each cleaned; the walk stops at the first text that does not fit, so none is passed
// over (review rec-panel-v3 M1). A first text longer than the whole budget is taken cut (head and tail), or it would hold the window for good.
function packOldest(texts, budget, separator, head = null, acc = null) {
  const out = [];
  let left = budget;
  for (let i = 0; i < texts.length && left > 0; i++) {
    let text = (head ? head(i) : '') + cleanText(texts[i]);
    if (acc && text.length > FIELD_MAX) { acc.cut += text.length - FIELD_MAX; text = fit(text, FIELD_MAX); }
    const room = out.length ? left - separator : left;
    if (text.length <= room) {
      out.push(text);
      left = room - text.length;
      continue;
    }
    if (!out.length) { if (acc) acc.cut += text.length - (room - CUT_MARK_MAX); out.push(fit(text, room - CUT_MARK_MAX)); }
    break;
  }
  return out;
}

// Does the transcript already hold the text that ends the turn (review rec-panel-v3 L2)? Whole in one of the newest rows, or split over
// them (one message written as several text rows), compared without regard to white space.
const squash = (text) => text.replace(/\s+/g, ' ').trim();
function holdsText(rows, last) {
  const want = squash(last);
  let joined = '';
  for (let i = rows.length - 1; i >= 0 && i >= rows.length - 8; i--) {
    const one = squash(rows[i].text);
    if (one === want) return true;
    joined = joined ? `${one} ${joined}` : one;
    if (joined === want) return true;
  }
  return false;
}

// The texts of one query as { texts, to, id, left, old }.
// Which: with a mark the texts after it (`after`: the line of the marked row when the tail still holds it, review L1; else the texts
// with a later time than `mark`), in the main thread not older than `floor` (the oldest owner message sent along: an older text
// has lost its context; `old` counts them); a text older than `since` (the last owner message) is marked as such, because it
// belongs to an earlier turn. Without a mark, as before: the texts from `since` on. `last` is the text that ends the turn
// (last_assistant_message of Stop and SubagentStop), added when the transcript does not hold it yet.
// How many: a query from a batch takes the oldest ones as far as the budget goes; `left` counts the texts that wait for the next
// query and `to`, `id` name the last one taken, which becomes the mark, so a text that did not fit is never passed over (review
// M1). The end of a turn (`newest`) takes the newest ones: it asks about the text that ends the turn and has a mark of its own.
export function textWindow(rows, { mark = 0, after = -1, since = 0, floor = 0, last = '', now = Date.now(), newest = false } = {}) {
  const all = last && !holdsText(rows, last) ? [...rows, { t: now, text: last, i: Infinity, id: '' }] : rows;
  const marked = mark > 0 || after >= 0;
  const later = after >= 0 ? all.filter((r) => r.i > after) : mark > 0 ? all.filter((r) => r.t > mark) : all.filter((r) => !(since > 0 && r.t > 0 && r.t < since));
  const fresh = marked && floor > 0 ? later.filter((r) => r.t >= floor) : later;
  const head = (i) => (marked && fresh[i].t < since ? BEFORE_OWNER : '');
  const raw = fresh.map((r) => r.text);
  const acc = { cut: 0 };
  const texts = newest ? packTexts(raw, TEXT_BUDGET_V2, TEXT_SEPARATOR.length, head, acc) : packOldest(raw, TEXT_BUDGET_V2, TEXT_SEPARATOR.length, head, acc);
  const end = newest ? fresh.at(-1) : fresh[texts.length - 1];
  // panel input 4: the newest text before the window (already sent once), so a query without a new text still shows what the agent said last
  let earlier = null;
  if (marked) {
    const inWindow = new Set(later);
    const before = all.filter((r) => !inWindow.has(r)).at(-1);
    if (before) {
      const cleaned = (before.t < since ? BEFORE_OWNER : '') + cleanText(before.text);
      const b = boundField(cleaned);
      acc.cut += b.cut;
      earlier = b.text;
    }
  }
  return { texts, to: end ? end.t : 0, id: end ? end.id : '', left: newest ? 0 : fresh.length - texts.length, old: later.length - fresh.length, earlier, cut: acc.cut };
}

// The newest transcript row that has a time, as { t, id } ({ t: 0 } without one): the mark a sent query leaves when its window took
// every text, also when the window was empty. Without it a main thread that writes only at the end of its turns would never get a
// mark, and every report would stay cut off as older than the last owner message.
function lastRow(lines) {
  for (let i = lines.length - 1, tried = 0; i >= 0 && tried < LAST_ROW_TRIES; i--) {
    if (!lines[i] || lines[i].length > LAST_ROW_CHARS) continue;
    tried++;
    try {
      const row = JSON.parse(lines[i]);
      const at = Date.parse(row?.timestamp ?? row?.attachment?.timestamp);
      if (Number.isFinite(at)) return { t: at, id: typeof row.uuid === 'string' ? row.uuid : '' };
    } catch { /* a partial or foreign line */ }
  }
  return { t: 0, id: '' };
}
// The index of the newest line that is the row with this uuid (-1: none, or no uuid).
function lineOf(lines, id) {
  if (!id) return -1;
  const needle = `"uuid":${JSON.stringify(id)}`;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes(needle)) return i;
  return -1;
}

// The marks in the panel state as { t, id } (the time and the uuid of the newest transcript row a sent query covered): textMark for
// the queries from batches, endMark for the end of a turn (never behind textMark), kept apart so that the end of a turn does not ask
// twice about one window (review rec-panel-v3 H2) and leaves the window of the batches alone. A mark only moves forward.
const markOf = (t, id) => ({ t: Number.isFinite(t) && t > 0 ? t : 0, id: typeof id === 'string' ? id : '' });
export const textMark = (state) => markOf(state?.tekst_do, state?.tekst_wiersz);
export function endMark(state) {
  const batch = textMark(state);
  const end = markOf(state?.tekst_koniec_do, state?.tekst_koniec_wiersz);
  return end.t > 0 && end.t >= batch.t ? end : batch;
}
export const markMoves = (mark, from) => Boolean(mark) && (mark.t > from.t || (mark.t > 0 && mark.t === from.t && Boolean(mark.id) && mark.id !== from.id));
export const markTexts = (state, mark) => (markMoves(mark, textMark(state)) ? { ...state, tekst_do: mark.t, tekst_wiersz: mark.id } : state);
export const markEnd = (state, mark) => (markMoves(mark, endMark(state)) ? { ...state, tekst_koniec_do: mark.t, tekst_koniec_wiersz: mark.id } : state);

// The step of the end of a turn: no call is counted and nothing is written (review rec-panel-v3 L4); the journal and the flags are the saved ones.
export const endStep = (state) => ({
  reason: END_REASON,
  journal: Array.isArray(state?.dziennik) ? state.dziennik.slice(-Math.max(JOURNAL_CALLS, Number(state.nowe) || 0)) : [], // every call since the last query (panel input 4)
  flags: Array.isArray(state?.znaki) ? state.znaki.slice(-JOURNAL_CALLS) : [],
  since: Number(state?.nowe) || 0,
});

// A short digest of the agent's list (tasks, statuses, notes): when it changes, the counter of calls without a change of the list restarts.
export function listSignature(current) {
  const items = Array.isArray(current?.record?.items) ? current.record.items : [];
  if (!items.length) return '';
  return createHash('sha256').update(JSON.stringify(items.map((x) => [x?.content, x?.status, x?.notatka ?? null]))).digest('hex').slice(0, 12);
}


// Every string of a value cleaned for Jev (K2: the mask replaces the value in place, the field stays): for the states other modules add to a
// query (the tasks of jev-zadania.mjs). Arrays and objects are walked, other values stay.
export function maskDeep(value, depth = 0) {
  if (typeof value === 'string') return cleanText(value);
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((x) => maskDeep(x, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, maskDeep(x, depth + 1)]));
}

// The numbers of the panel state that go to Jev as `sygnaly` (J6, card A and E): the gates of version 2 and the counters of the
// list rule, given as facts; nothing here decides. `st` is the panel state written for this query, `since` the calls since the last query.
export function signalFields(sig, st, since, reason) {
  return {
    powod: reason,
    wywolan_od_poprzedniego_zapytania: since ?? null,
    wywolan_bez_zmiany_listy: Number.isInteger(st?.lista_od) ? st.lista_od : null,
    ta_sama_lista_zapytan: Number.isInteger(st?.ta_sama) ? st.ta_sama : 0,
    bledy_narzedzi: sig.errors,
    niepowodzenia_w_wynikach_basha: sig.shellFails,
    powtorzone_niepowodzenie: sig.repeatedFail,
    zapisy: sig.writes,
    odczyty: sig.reads,
    nowy_tekst: sig.text,
  };
}

// The hints given in the current task with their effect, for Jev (plan 3a, point 16; up to HISTORY_KEPT): the name, the calls since, and
// whether the list changed afterwards (the reaction the hook can see).
export function historyFor(st, brake) {
  const list = Array.isArray(st?.historia) ? st.historia.filter((h) => h?.k === brake) : [];
  return list.slice(-HISTORY_KEPT).map((h) => ({
    podpowiedz: h.n,
    wywolan_temu: Math.max(0, (Number.isInteger(st?.razem) ? st.razem : 0) - (Number.isInteger(h.r) ? h.r : 0)),
    lista_zmieniona_od_podpowiedzi: (h.s ?? '') !== (st?.lista_sig ?? ''),
  }));
}
// The state after the hints `names` were shown for the task `brake` (the history keeps the 20 newest hints).
export function markHistory(st, brake, names) {
  const razem = Number.isInteger(st?.razem) ? st.razem : 0;
  const added = names.map((n) => ({ k: brake, n, r: razem, s: st?.lista_sig ?? '' }));
  return { ...st, historia: [...(Array.isArray(st?.historia) ? st.historia : []), ...added].slice(-20) };
}

// The prompt in the main thread when the transcript names no origin, whole (up to FIELD_MAX): { text, cut } or null. The task record of the
// tool gate first, and when it is not kept (tool-gate off in OMC_JEV) or absent, the first user message of the transcript: a session resumed
// by `claude -p` (rows without `origin`), started by a teammate message, or whose human messages lie beyond the tail, still gets its task.
function taskPromptFull(data, env, transcript) {
  const text = agentKey(data) !== MAIN ? promptFromTranscript(transcript) : readOwnerTask(data?.session_id, null, env)?.owner_messages?.at(-1) || promptFromTranscript(transcript, true);
  return typeof text === 'string' && text ? boundField(cleanText(text)) : null;
}

// The state of version 2: `polecenia` (a list) instead of `polecenie`, the agent's texts since its last query (textWindow; `mark`
// is textMark of the panel state, at the end of a turn endMark, and `end` says which). Every text is cleaned. `textTo` is the mark
// to save once the query is sent: the last text taken while others wait (`textLeft`), else the newest row read.
// `current` is the list the hook read for its signals ({ record, task, note } of currentTask), so Jev sees the same one (review L11).
// Panel input 4 (11.11.2026, J1c): `tekst_agenta` is a list of whole texts (each up to FIELD_MAX), `tekst_poprzedni` the newest text
// before them, the briefs and owner messages whole, the journal whole; `cut` counts the characters cut anywhere (uciete_znaki) and
// `ctx` ({ sig, st, since, brake }) adds the signals and the history of hints.
export function panelStateV2(data, journal, reason, env = process.env, current = currentTask(data.session_id, agentKey(data), env), mark = null, end = false, ctx = {}) {
  const key = agentKey(data);
  const main = key === MAIN;
  const { record, task, note } = current;
  const transcript = agentTranscript(data);
  const lines = tailLines(transcript, main ? OWNER_TAIL_BYTES : AGENT_TAIL_BYTES);
  let polecenia = null;
  let since = 0;
  let floor = 0;
  let cut = 0;
  let older = 0;
  if (main) {
    const messages = ownerMessages(transcript, OWNER_KEPT, lines);
    if (messages.length) {
      polecenia = messages.map((m) => m.text);
      older = messages.older ?? 0;
      cut += messages.reduce((sum, m) => sum + (m.cut || 0), 0);
      since = messages.at(-1).t;
      floor = messages[0].t;
    } else {
      const recorded = taskPromptFull(data, env, transcript); // the task record of the tool gate, when the transcript names no origin
      polecenia = recorded ? [recorded.text] : null;
      cut += recorded?.cut ?? 0;
    }
  } else {
    const brief = promptFromTranscript(transcript);
    const whole = brief ? boundField(cleanText(brief)) : null;
    polecenia = whole ? [whole.text] : null;
    cut += whole?.cut ?? 0;
  }
  const last = END_EVENTS.has(data?.hook_event_name) && typeof data.last_assistant_message === 'string' ? data.last_assistant_message.trim() : '';
  const from = markOf(mark?.t, mark?.id);
  const window = textWindow(textRows(lines), { mark: from.t, after: lineOf(lines, from.id), since, floor, last, newest: end });
  cut += window.cut;
  cut += (Array.isArray(journal) ? journal : []).reduce((sum, e) => sum + (e?.uciete || 0), 0);
  const seen = lastRow(lines);
  const sent = {
    rola: main ? 'sesja główna' : 'subagent',
    agent_type: typeof data?.agent_type === 'string' ? data.agent_type : null,
    powod: reason,
    moze_delegowac: ctx.sig ? Boolean(ctx.sig.delegate) : null,
    polecenia,
    lista: Array.isArray(record?.items) && record.items.length ? record.items.map((x) => ({ ...(x.zadanie ? { zadanie: x.zadanie } : {}), content: cleanText(x.content), status: x.status, ...(typeof x.notatka === 'string' && x.notatka ? { notatka: cleanText(x.notatka) } : {}) })) : null,
    zadanie_w_toku: task ? cleanText(task) : null,
    notka: note ? cleanText(note) : null,
    ostatnie_wywolania: journal,
    tekst_agenta: window.texts,
    tekst_poprzedni: window.earlier,
    niewyslane: { polecenia_starsze: older, teksty_starsze_niz_polecenia: window.old, teksty_czekaja: window.left },
    ...(ctx.sig ? { sygnaly: signalFields({ ...ctx.sig, text: window.texts.length > 0 }, ctx.st, ctx.since, reason), historia_podpowiedzi: historyFor(ctx.st, ctx.brake) } : {}),
  };
  const places = (JSON.stringify(sent).match(/\[linia pominięta: ścieżka z sekretami\]|\[pominięte: ścieżka z sekretami\]/g) || []).length;
  return {
    state: sent,
    transcript, task, note, cut, maskPlaces: places,
    textTo: window.left > 0 || window.to > seen.t ? { t: window.to, id: window.id } : seen,
    textLeft: window.left, textOld: window.old,
  };
}
