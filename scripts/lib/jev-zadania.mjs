// omc-lokalne T5 (11.11.2026): the Jev verdict on tasks (`ocena_jeva`), the agent registry and the data of the end-of-turn query about tasks.
// Category: 1. data storage and 3. record shape.
// Rule no. 1 of the plan (maximum of Jev): nothing here decides that a task is abandoned or done. The code counts facts (messages since a change,
// a report of an agent, the tasks open when an agent was launched) and hands them to Jev; his answer is stored by zapiszOceny. The only code
// judgement is ocenaRezerwowa (K3: the query was sent and Jev did not answer). Every function is fail-open and writes only under the list lock.
// Written from scratch (clean room).

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from './atomic-write.mjs';
import { SECRET_PATH, SECRET_PEM, maskSecretProse } from './jev-sekrety.mjs';
import { EVENTS_KEPT, LIST_TOOL, MAIN, hash8, itemVersion, listCallTimes, listPath, logRow, maskListText, noteVersion, readCounter, readList, startHint, stepHint, syncList, writeCounter, LAUNCHES_MAX } from './jev-lista.mjs';
import { shellLogDir } from './jev-panel-host.mjs';

const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const PATH_LINE = new RegExp(SECRET_PATH.source, SECRET_PATH.flags.replace(/[gy]/g, ''));
const PASS_VALUE = /\b([A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|PASS|PWD|SECRET|TOKEN|APIKEY|API_KEY)[A-Za-z0-9_.-]*)(\s*[=:]\s*)(["']?)[^\s"',;]+/gi;
const URL_PASS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(@)/gi;
// The mask for free text written to disk (agent prompt, description, Jev's remark): private key blocks, a line with the path of a secret file
// (as a marker, K2), values after secret words in prose and in NAME=value pairs, a password in an address; then the narrow mask of the lists.
export function maskFree(text) {
  let t = String(text ?? '').replace(SECRET_PEM, '$1***$2');
  t = t.split('\n').map((line) => (PATH_LINE.test(line) ? '[linia ze ścieżką pliku sekretu pominięta]' : line)).join('\n');
  t = maskSecretProse(t).replace(PASS_VALUE, '$1$2$3***').replace(URL_PASS, '$1***$2');
  return maskListText(t);
}
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const isYes = (p) => p === true || (typeof p === 'number' && Number.isFinite(p) && p >= 0.5); // rec-D F8: the larger of the two answers, no confidence threshold
const asBool = (v) => (v === true || v === false ? v : null);
const probability = (answer) => (typeof answer?.noul === 'boolean' ? (answer.noul ? 1 : 0) : typeof answer?.noul === 'number' && Number.isFinite(answer.noul) ? answer.noul : null);
export const numberOf = (zadanie) => String(zadanie ?? '').slice(String(zadanie ?? '').lastIndexOf(':') + 1);

// --- reading the verdict ------------------------------------------------------------------------

// The verdict that still applies to the item: porzucone and zrobione only for the same content and status, notka_nieaktualna only for the same
// note. null without a verdict. The code never deletes an old verdict; whether a stale one counts is decided here, in one place.
export function ocenaAktualna(x) {
  const o = x?.ocena_jeva;
  if (!o || typeof o !== 'object') return null;
  const same = o.wersja === itemVersion(x);
  return {
    porzucone: same ? asBool(o.porzucone) : null,
    zrobione: same ? asBool(o.zrobione) : null,
    notka_nieaktualna: o.wersja_notatki === noteVersion(x) ? asBool(o.notka_nieaktualna) : null,
  };
}
const hasCurrent = (x) => { const a = ocenaAktualna(x); return Boolean(a && (a.porzucone !== null || a.zrobione !== null)); };

// "Old" (S1 and F22): completed, or Jev judged it done or abandoned (for the current version of the item).
export function jestStare(x) {
  if (x?.status === 'completed') return true;
  const a = ocenaAktualna(x);
  return a?.porzucone === true || a?.zrobione === true;
}

// --- facts for Jev --------------------------------------------------------------------------------

export function raportOddany(sessionId, agentId, env = process.env) {
  try {
    return AGENT_ID.test(String(agentId)) && existsSync(join(shellLogDir(env), 'koniec-tury', sessionId, `${agentId}.json`));
  } catch {
    return false;
  }
}

// How many different owner messages came after the last change of the task; null when the change is not among the messages seen.
function messagesSinceChange(record, x) {
  const list = Array.isArray(record?.prompty) ? record.prompty : [];
  const at = x?.prompt_zmiany ? list.lastIndexOf(x.prompt_zmiany) : -1;
  return at < 0 ? null : list.length - 1 - at;
}

const open = (x) => x?.status !== 'completed';
const stateOf = (record, x, history, sessionId, env) => ({
  zadanie: x.zadanie,
  host_id: x.host_id ?? null,
  content: x.content,
  status: x.status,
  notatka: x.notatka ?? null,
  od: x.od ?? null,
  zmiana: x.zmiana ?? null,
  w_historii: history,
  powod: history ? (x.powod ?? null) : null,
  wiadomosci_od_zmiany: messagesSinceChange(record, x),
  agenci: (Array.isArray(x.agenci) ? x.agenci : []).map((id) => ({ id, raport_oddany: raportOddany(sessionId, id, env) })),
  wersja: itemVersion(x),
  wersja_notatki: noteVersion(x),
  ocena_poprzednia: x.ocena_jeva ?? null,
  ocena_aktualna: hasCurrent(x),
});

const yesNo = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });

// The part of the end-of-turn query about the tasks of one thread: { state: { zadania, agenci_bez_zadania }, questions }. Every open task of the
// list is in it, every turn: who is suspect is for Jev to say. Tasks that left the list are in it only until they have a verdict.
// The question texts are fixed (no user text); the facts are in state.zadania.
export function zadaniaDoZapytania(sessionId, key = MAIN, env = process.env, opts = {}) {
  const empty = { state: { zadania: [], agenci_bez_zadania: [] }, questions: {} };
  try {
    const record = readList(sessionId, key, env);
    const reminder = przypomnienieDoZapytania(sessionId, key, env, opts);
    const items = Array.isArray(record?.items) ? record.items : [];
    const history = Array.isArray(record?.historia) ? record.historia : [];
    const zadania = [
      ...items.filter(open).map((x) => stateOf(record, x, false, sessionId, env)),
      ...history.filter((x) => open(x) && !hasCurrent(x)).map((x) => stateOf(record, x, true, sessionId, env)),
    ];
    const byKey = new Map([...items, ...history].map((x) => [x.zadanie, x]));
    const unassigned = rejestr(sessionId, key, record, env).filter((a) => a.przypisal !== 'jev' && a.przypisal !== 'brak');
    const agenci_bez_zadania = unassigned.map((a) => {
      const start = odczytajStartAgenta(sessionId, key, a.id, env);
      return {
        agent: a.id, ts: a.ts, opis: start?.opis ?? null, typ: start?.typ ?? null, prompt: start?.prompt ?? null,
        zadanie_z_faktu: a.zadanie ?? null, kandydat_jedyny: (a.kandydaci ?? []).length === 1,
        kandydaci: (a.kandydaci ?? []).map((k) => ({ zadanie: k, content: byKey.get(k)?.content ?? null })),
      };
    });
    const questions = {};
    for (const z of zadania) {
      const n = numberOf(z.zadanie);
      questions[`zadanie_${n}_zrobione`] = yesNo(`Czy zadanie ${z.zadanie} z listy state.zadania (pola content, status, notatka, agenci, wiadomosci_od_zmiany, ocena_poprzednia) jest już wykonane według odpowiedzi agenta i raportów w tym zapytaniu?`, 'Zadanie jest wykonane', 'Zadanie nie jest jeszcze wykonane');
      questions[`zadanie_${n}_porzucone`] = yesNo(`Czy zadanie ${z.zadanie} z listy state.zadania zostało porzucone: nie jest oznaczone jako wykonane, a nikt przy nim nie pracuje (pola agenci, wiadomosci_od_zmiany, zmiana, odpowiedz)?`, 'Zadanie jest porzucone', 'Zadanie nie jest porzucone');
      if (z.notatka) questions[`zadanie_${n}_notka`] = yesNo(`Czy notatka zadania ${z.zadanie} (pole notatka) jest nieaktualna wobec tego, co agent robi teraz (pola odpowiedz, zmiana)?`, 'Notatka jest nieaktualna', 'Notatka jest aktualna');
    }
    // the work of an agent may belong to a task that was closed (or left the list) before the question: all tasks of the thread are options
    const every = [...items, ...history];
    const optionsFor = (a) => {
      // a fact in the option text: the task was in progress when the agent was launched (no user text; the key is an identifier)
      const open = new Set((a.kandydaci ?? []).map((k) => k.zadanie));
      return Object.fromEntries([...every.map((x) => [x.zadanie, open.has(x.zadanie) ? `Zadanie ${x.zadanie} (było w toku, gdy uruchamiano agenta)` : `Zadanie ${x.zadanie}`]), ['brak', 'Żadne z zadań na liście']]);
    };
    for (const a of agenci_bez_zadania) {
      questions[`przypisz_${a.agent}`] = { type: 'choice', instructions: `Do którego zadania z listy state.zadania_wszystkie należy praca agenta ${a.agent}, albo do żadnego (brak)? Pola wpisu agenta w state.agenci_bez_zadania: opis, typ, prompt, raport, ts, kandydaci, zadanie_z_faktu, kandydat_jedyny. Pola zadań: status, utworzone, od, do, content albo ten_sam_co (klucz zadania o identycznej treści, której nie powtarzamy).`, criteria: optionsFor(a) };
    }
    if (reminder) questions.przypomnienie = reminder.question;
    // facts only, short because the request to Jev has a size limit: when the task was worked on and closed (to the minute), and for a text that an
    // earlier key already holds (a task written again after the host numbered anew) only a reference to that key, without the text again;
    // they let Jev match an agent to a task by time and by text, nothing is decided here
    // `utworzone` is left out when it equals the start (a smaller request)
    const minute = (t) => (typeof t === 'string' ? `${t.slice(0, 16)}Z` : null); // UTC, to the minute
    const first = new Map();
    const wszystkie = agenci_bez_zadania.length ? { zadania_wszystkie: every.map((x) => {
      const same = first.get(x.content);
      if (!same) first.set(x.content, x.zadanie);
      return { zadanie: x.zadanie, status: x.status, ...(x.utworzone && minute(x.utworzone) !== minute(x.od) ? { utworzone: minute(x.utworzone) } : {}), ...(x.od ? { od: minute(x.od) } : {}), ...(x.do ? { do: minute(x.do) } : {}), ...(same ? { ten_sam_co: same } : { content: x.content }), ...(items.includes(x) ? {} : { w_historii: true }) };
    }) } : {};
    return { state: { zadania, agenci_bez_zadania, ...wszystkie, ...(reminder ? { przypomnienie: reminder.state } : {}) }, questions };
  } catch {
    return empty;
  }
}

// The verdict object of S2 (field `ocena_jeva` of the end-of-turn file) from the answers of Jev: answers[name] = { type, noul | choice }.
// A question without an answer gives no field (null), never false.
// `stan` (optional): the state.zadania the query was built from; the verdict is then about the versions of the tasks Jev saw, not about a
// version that changed while he answered.
export function ocenaZOdpowiedzi(sessionId, key, answers, { nr_tury = null, kto = 'jev', stan = null } = {}) {
  const zadania = {};
  const notka_nieaktualna = {};
  const przypisania = {};
  for (const [name, answer] of Object.entries(answers && typeof answers === 'object' ? answers : {})) {
    let m = /^zadanie_(\d+)_(zrobione|porzucone)$/.exec(name);
    if (m) {
      const p = probability(answer);
      if (p === null) continue;
      const klucz = `${key}:${m[1]}`;
      zadania[klucz] = { ...(zadania[klucz] ?? {}), [m[2]]: isYes(p), noul: { ...(zadania[klucz]?.noul ?? {}), [m[2]]: p } };
      continue;
    }
    m = /^zadanie_(\d+)_notka$/.exec(name);
    if (m) {
      const p = probability(answer);
      if (p !== null) notka_nieaktualna[`${key}:${m[1]}`] = isYes(p);
      continue;
    }
    m = /^przypisz_([A-Za-z0-9_-]{1,100})$/.exec(name);
    if (m && typeof answer?.choice === 'string') przypisania[m[1]] = answer.choice === 'brak' ? null : answer.choice;
  }
  const wersje = Object.fromEntries((Array.isArray(stan) ? stan : []).filter((z) => z?.zadanie && z.wersja).map((z) => [z.zadanie, { wersja: z.wersja, wersja_notatki: z.wersja_notatki }]));
  return { zadania, notka_nieaktualna, przypisania, ...(Object.keys(wersje).length ? { wersje } : {}), nr_tury, kto };
}

// K3 (the query was sent, Jev did not answer; counted in the 5 % measure of the plan): the two-condition rule of the plan, nothing else.
// Abandoned only when the task has agents, all of them handed in their report, and at least 3 owner messages passed since the last change.
export function ocenaRezerwowa(sessionId, key = MAIN, { nr_tury = null } = {}, env = process.env) { // K3
  const zadania = {};
  try {
    const record = readList(sessionId, key, env);
    for (const x of Array.isArray(record?.items) ? record.items : []) {
      if (!x || !open(x) || !Array.isArray(x.agenci) || !x.agenci.length) continue;
      const since = messagesSinceChange(record, x);
      if (since !== null && since >= 3 && x.agenci.every((id) => raportOddany(sessionId, id, env))) zadania[x.zadanie] = { porzucone: true };
    }
    if (Object.keys(zadania).length) logRow('k3.jsonl', { punkt: 'porzucone', kto: 'k3', session_id: sessionId, agent: key, nr_tury, zadania: Object.keys(zadania) }, env);
  } catch { /* the reserve never breaks the hook */ }
  return { zadania, notka_nieaktualna: {}, przypisania: {}, nr_tury, kto: 'k3' };
}

// --- writing the verdict (under the lock of the list) ---------------------------------------------

// Stores the verdict object of S2 in the tasks. { zapisane, przypisane, pominiete: [{ zadanie, powod }] }.
export function zapiszOceny(sessionId, key, ocena, { ts = new Date().toISOString() } = {}, env = process.env) {
  const result = { zapisane: 0, przypisane: 0, pominiete: [] };
  try {
    const nr = Number.isInteger(ocena?.nr_tury) ? ocena.nr_tury : null;
    const kto = ocena?.kto === 'k3' ? 'k3' : 'jev';
    const saved = syncList(sessionId, key, env, (record) => {
      if (!record) return null;
      const lists = { items: [...(record.items ?? [])], historia: [...(record.historia ?? [])] };
      const where = (klucz) => { for (const name of ['items', 'historia']) { const i = lists[name].findIndex((x) => x.zadanie === klucz); if (i >= 0) return [name, i]; } return null; };
      const keys = new Set([...Object.keys(ocena?.zadania ?? {}), ...Object.keys(ocena?.notka_nieaktualna ?? {})]);
      for (const klucz of keys) {
        const at = where(klucz);
        if (!at) { result.pominiete.push({ zadanie: klucz, powod: 'nieznany klucz' }); continue; }
        const x = lists[at[0]][at[1]];
        const given = ocena.zadania?.[klucz] ?? {};
        const version = ocena.wersje?.[klucz]?.wersja ?? itemVersion(x);
        const noteVer = ocena.wersje?.[klucz]?.wersja_notatki ?? noteVersion(x);
        const before = x.ocena_jeva;
        // fields this answer did not give stay from the earlier verdict about the same version (an answer without a field is not "no")
        const keep = (field, own, sameVersion) => (own !== null ? own : (before && sameVersion ? asBool(before[field]) : null));
        lists[at[0]][at[1]] = {
          ...x,
          ocena_jeva: {
            porzucone: keep('porzucone', asBool(given.porzucone), before?.wersja === version),
            zrobione: keep('zrobione', asBool(given.zrobione), before?.wersja === version),
            notka_nieaktualna: keep('notka_nieaktualna', asBool(ocena.notka_nieaktualna?.[klucz]), before?.wersja_notatki === noteVer),
            noul: { ...(before?.wersja === version ? (before.noul ?? {}) : {}), ...(given.noul ?? {}) }, nr_tury: nr, ts, kto, wersja: version, wersja_notatki: noteVer,
          },
        };
        result.zapisane += 1;
      }
      const agenci = rejestr(sessionId, key, record, env);
      for (const [agent, klucz] of Object.entries(ocena?.przypisania ?? {})) {
        const i = agenci.findIndex((a) => a.id === agent);
        if (i < 0) { result.pominiete.push({ zadanie: klucz, powod: `nieznany agent ${agent}` }); continue; }
        if (klucz === null) { agenci[i] = { ...agenci[i], zadanie: null, przypisal: 'brak', nr_tury: nr }; continue; }
        const at = where(klucz);
        if (!at) { result.pominiete.push({ zadanie: klucz, powod: 'nieznany klucz' }); continue; }
        const previous = agenci[i].zadanie;
        agenci[i] = { ...agenci[i], zadanie: klucz, przypisal: 'jev', nr_tury: nr };
        if (previous && previous !== klucz) { // Jev's answer replaces the provisional assignment from the fact
          const old = where(previous);
          if (old) lists[old[0]][old[1]] = { ...lists[old[0]][old[1]], agenci: (lists[old[0]][old[1]].agenci ?? []).filter((id) => id !== agent) };
        }
        const x = lists[at[0]][at[1]];
        lists[at[0]][at[1]] = { ...x, agenci: [...new Set([...(x.agenci ?? []), agent])] };
        result.przypisane += 1;
      }
      return result.zapisane || result.przypisane || agenci.some((a, i) => a !== (record.agenci ?? [])[i]) ? { ...record, ...lists, agenci: agenci.slice(-LAUNCHES_MAX) } : null;
    });
    if (saved === false) { result.zapisane = 0; result.przypisane = 0; result.pominiete.push({ zadanie: null, powod: 'blokada' }); }
  } catch {
    result.pominiete.push({ zadanie: null, powod: 'blad' });
  }
  return result;
}

// --- agent registry (K3 of E4): which tasks were open when an agent was launched ---------------------------

// The agent id of an Agent or Task call from its response ("agentId: a8a6..." of a background agent, "agent_id: ..." of a named one).
export function agentIdOf(response) {
  const own = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 3) return null;
    for (const k of ['agentId', 'agent_id']) if (typeof o[k] === 'string' && /^[A-Za-z0-9_-]{4,100}$/.test(o[k])) return o[k];
    for (const v of Array.isArray(o) ? o : Object.values(o)) { const f = own(v, depth + 1); if (f) return f; }
    return null;
  };
  const field = own(response, 0);
  if (field) return field;
  const texts = (v, depth = 0) => {
    if (typeof v === 'string') return [v];
    if (!v || typeof v !== 'object' || depth > 3) return [];
    return (Array.isArray(v) ? v : [v.text, v.content]).flatMap((x) => texts(x, depth + 1));
  };
  const text = texts(response).join('\n');
  // a line that begins with the name: a prompt quoted in the result (a teammate result carries it) does not start a line with "agentId:"
  const m = /^[ \t]*agent[_ ]?id[ \t]*[:=][ \t]*([A-Za-z0-9_-]{4,100})/im.exec(text);
  return m ? m[1] : null;
}

export function uruchomieniaAgentow(calls) {
  const out = [];
  for (const c of Array.isArray(calls) ? calls : []) {
    if (!AGENT_TOOLS.has(c?.tool_name)) continue;
    const id = agentIdOf(c.tool_response);
    const input = c.tool_input && typeof c.tool_input === 'object' ? c.tool_input : {};
    if (id) out.push({ id, wywolanie: typeof c.tool_use_id === 'string' ? c.tool_use_id : null, opis: typeof input.description === 'string' ? input.description : null, typ: typeof input.subagent_type === 'string' ? input.subagent_type : null, prompt: typeof input.prompt === 'string' ? input.prompt : null });
  }
  return out;
}

// The registry of the agents launched from a thread. Source: one file per agent, <listy>/<sesja>/<key>.agenci/<agent>.json, written without a
// lock when the launch is seen (so a busy lock or a thread without a list loses nothing, review M3): the description and the whole prompt of the
// launching call (masked, not shortened), the time, the tasks in progress at that moment (`kandydaci`) and, when exactly one was, `zadanie_fakt`.
// The record keeps the merged entries and Jev's answers; a reader takes the record plus the files the record does not know yet.
const startPath = (sessionId, key, agentId, env) => { const p = listPath(sessionId, key, env); return p && AGENT_ID.test(agentId) ? join(p.replace(/\.json$/, '.agenci'), `${agentId}.json`) : null; };
function zapiszStartAgenta(sessionId, key, l, env) {
  try {
    const path = startPath(sessionId, key, l.id, env);
    if (!path || existsSync(path)) return;
    mkdirSync(join(path, '..'), { recursive: true });
    atomicWriteFileSync(path, JSON.stringify({ id: l.id, opis: l.opis ? maskFree(l.opis) : null, typ: l.typ ?? null, prompt: l.prompt ? maskFree(l.prompt) : null, ts: l.ts ?? null, wywolanie: l.wywolanie ?? null, prompt_id: l.prompt_id ?? null, kandydaci: l.kandydaci ?? [], zadanie_fakt: l.zadanie_fakt ?? null }));
  } catch { /* the launch file is the registry's source; a failure here loses one entry, never the hook */ }
}
function odczytajStartAgenta(sessionId, key, agentId, env) {
  try {
    const path = startPath(sessionId, key, agentId, env);
    return path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  } catch { return null; }
}
// The entries of the launch files that are not in the record yet, as registry entries.
function agenciZPlikow(sessionId, key, known, env) {
  try {
    const p = listPath(sessionId, key, env);
    const dir = p && p.replace(/\.json$/, '.agenci');
    if (!dir || !existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => AGENT_ID.test(id) && !known.has(id)).map((id) => {
      const f = odczytajStartAgenta(sessionId, key, id, env);
      return f ? { id, ts: f.ts, wywolanie: f.wywolanie, prompt_id: f.prompt_id, kandydaci: f.kandydaci ?? [], zadanie: f.zadanie_fakt ?? null, przypisal: f.zadanie_fakt ? 'fakt' : null, nr_tury: null } : null;
    }).filter(Boolean).sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
  } catch { return []; }
}
const rejestr = (sessionId, key, record, env) => {
  const own = Array.isArray(record?.agenci) ? record.agenci : [];
  return [...own, ...agenciZPlikow(sessionId, key, new Set(own.map((a) => a.id)), env)];
};

// Registers the launches of the thread. `zadanie` is set provisionally from a fact when exactly one task was in progress (`przypisal: "fakt"`);
// Jev still gets the question and his answer wins (zapiszOceny). With more tasks in progress (or none) the entry waits for Jev.
export function zarejestrujAgentow(sessionId, key, launches, { ts = new Date().toISOString(), prompt_id = null } = {}, env = process.env) {
  if (!launches.length) return null;
  const candidates = (readList(sessionId, key, env)?.items ?? []).filter((x) => x.status === 'in_progress').map((x) => x.zadanie);
  for (const l of launches) zapiszStartAgenta(sessionId, key, { ...l, ts, prompt_id, kandydaci: candidates, zadanie_fakt: candidates.length === 1 ? candidates[0] : null }, env);
  return syncList(sessionId, key, env, (record) => {
    if (!record) return null; // the files are the registry until the thread has a list
    const entries = agenciZPlikow(sessionId, key, new Set((record.agenci ?? []).map((a) => a.id)), env);
    if (!entries.length) return null;
    const items = (record.items ?? []).map((x) => {
      const mine = entries.filter((e) => e.zadanie === x.zadanie).map((e) => e.id);
      return mine.length ? { ...x, agenci: [...new Set([...(x.agenci ?? []), ...mine])] } : x;
    });
    return { ...record, items, agenci: [...(record.agenci ?? []), ...entries].slice(-LAUNCHES_MAX) };
  }, env);
}

// --- the hint "close the task" ----------------------------------------------------------------------------

// Fixed text with the name of the task; given only from a verdict of Jev (zrobione or porzucone, for the current version), once per version.
// { text, versions: { klucz: wersja } } or null. `given` is { klucz: wersja } already hinted.
export function podpowiedzZamknij(record, given = {}) {
  const parts = [];
  const versions = {};
  for (const x of Array.isArray(record?.items) ? record.items : []) {
    if (x.status !== 'in_progress') continue;
    const a = x.ocena_jeva?.kto === 'k3' ? null : ocenaAktualna(x); // the K3 reserve is a rule of the code, not a decision of Jev: no "Jev decided" text
    if (!a || (a.zrobione !== true && a.porzucone !== true)) continue;
    const version = hash8(`${itemVersion(x)}${a.zrobione === true ? 'z' : 'p'}`);
    if (given[x.zadanie] === version) continue;
    const name = String(x.content).replace(/\s+/g, ' ').slice(0, 90);
    parts.push(`Zadanie „${name}” (${x.zadanie}) Jev uznał za ${a.zrobione === true ? 'zrobione' : 'porzucone'}: oznacz je jako completed na liście albo dopisz w notatce, co jeszcze zostało.`);
    versions[x.zadanie] = version;
  }
  return parts.length ? { text: parts.join(' '), versions } : null;
}

// --- reminders about the list: Jev decides whether and what (T5, coordinator 11.11.2026, plan point 15) -----------------------------------

// The decision is made by the panel query after a batch of tools (T4: the question `pokaz`, the card kinds below) and written with
// zapiszPrzypomnienie; the hook jev-lista-paczka.mjs delivers it once. There is no other source: no counter, threshold or cap triggers a
// reminder. The counters are only signals in the input of Jev (sygnalyPrzypomnienia).
export const REMINDER_KINDS = ['zaloz_liste', 'wpisz_krok', 'lista_nieaktualna', 'notka'];
const remindPath = (sessionId, key, env) => { const p = listPath(sessionId, key, env); return p ? p.replace(/\.json$/, '.przypomnienie.json') : null; };
const readJsonSafe = (path) => { try { return path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; } };

// The signals for the panel query: facts about the list of this thread. null when the agent type has no list tool.
export function sygnalyPrzypomnienia(sessionId, key = MAIN, env = process.env, { razem = null, now = Date.now(), bezHistorii = false } = {}) {
  try {
    const counter = readCounter(sessionId, key, env) ?? {};
    if (counter.lista === false && counter.zrodlo !== 'nieznany' && counter.zrodlo !== 'brak-typu') return null; // an unknown type may still have the tool
    const record = readList(sessionId, key, env);
    const last = readJsonSafe(remindPath(sessionId, key, env));
    const items = Array.isArray(record?.items) ? record.items : [];
    return {
      ma_liste: items.length > 0, zadan_w_toku: items.filter((x) => x.status === 'in_progress').length, zadan_otwartych: items.filter(open).length,
      wywolan_od_zmiany_listy: Number.isInteger(counter.od_listy) ? counter.od_listy : null, ostatnia_zmiana_listy: record?.updated ?? null,
      typ_agenta: counter.typ ?? null, typ_nieznany: counter.lista === false, sesja_glowna: key === MAIN, narzedzie_listy: key === MAIN ? 'TaskCreate i TaskUpdate' : LIST_TOOL,
      przypomnien_dotad: Number.isInteger(counter.podpowiedzi) ? counter.podpowiedzi : 0,
      ostatnie_przypomnienie: last ? { rodzaj: last.rodzaj, uwaga: last.uwaga ?? null, ts: last.ts, nr_tury: last.nr_tury ?? null, dostarczone: last.dostarczone === true } : null,
      ...(bezHistorii ? {} : historiaPrzypomnien(sessionId, key, record, { razem, now }, env)),
    };
  } catch {
    return null;
  }
}

// The history of the reminders this thread got (P2, 11.11.2026): Jev decides about a reminder blind to what he already sent to the same receiver and
// what came of it. Facts only: the reminders of this thread from todo-hint.jsonl (the one log of reminders; no new store) with the kind, the mode
// (active: the agent got it, shadow: only logged), the tool calls and seconds since it, and whether the thread called a list tool after it, up to the
// next reminder of the thread or up to now (the times of the list calls: listCallTimes). Nothing here triggers or blocks a reminder. What is not known
// is null, never a false "no": a log that could not be read (historia_przypomnien null), the part of the log before the tail that is read
// (dziennik_obciety), a reminder older than the kept list calls (lista_zmieniona_po_nim null). HISTORY_REMINDERS_MAX only bounds the size of the
// query (the newest ones are given, `starszych_pominietych` counts the rest).
const HINT_LOG_TAIL = 4 * 1024 * 1024;
const HISTORY_REMINDERS_MAX = 20;
function remindersOfThread(sessionId, key, env) {
  const path = join(shellLogDir(env), 'todo-hint.jsonl');
  if (!existsSync(path)) return { rows: [], cut: false };
  const fd = openSync(path, 'r');
  let text;
  let cut;
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - HINT_LOG_TAIL - 1); // one byte before the tail: its first character is then the end of a line or a cut one
    const buffer = Buffer.alloc(size - start);
    const got = readSync(fd, buffer, 0, buffer.length, start);
    text = buffer.toString('utf8', 0, got);
    cut = start > 0;
    if (cut) text = text.slice(text.indexOf('\n') + 1);
  } finally { closeSync(fd); }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"przypomnienie"')) continue;
    try {
      const r = JSON.parse(line);
      const at = Date.parse(r.ts);
      if (r.etap === 'przypomnienie' && r.session_id === sessionId && r.agent === key && !r.pominiete && REMINDER_KINDS.includes(r.rodzaj) && Number.isFinite(at)) rows.push({ ...r, at });
    } catch { /* a damaged row is not a reminder */ }
  }
  return { rows: rows.sort((a, b) => a.at - b.at), cut };
}

export function historiaPrzypomnien(sessionId, key, record, { razem = null, now = Date.now() } = {}, env = process.env) {
  try {
    const { rows: all, cut } = remindersOfThread(sessionId, key, env);
    const known = all.filter((r) => r.at <= now); // the view as of `now` (a reminder logged later is not history yet)
    const rows = known.slice(-HISTORY_REMINDERS_MAX);
    const fromRecord = (Array.isArray(record?.zlozone) ? record.zlozone : []).map((name) => Number(/^(\d{13})-/.exec(String(name))?.[1])).filter(Number.isFinite);
    const calls = [...new Set([...fromRecord, ...listCallTimes(sessionId, key, env)])].sort((a, b) => a - b);
    const trimmed = calls.length >= EVENTS_KEPT; // older list calls may have left the kept ones
    const history = rows.map((r, i) => {
      const until = i + 1 < rows.length ? rows[i + 1].at : now;
      const first = calls.find((c) => c > r.at && c <= until);
      const unknown = first === undefined && trimmed && r.at < calls[0];
      return {
        rodzaj: r.rodzaj,
        tryb: r.tryb ?? null,
        wywolan_narzedzi_temu: Number.isInteger(razem) && Number.isInteger(r.nr_tury) && razem >= r.nr_tury ? razem - r.nr_tury : null,
        sekund_temu: Math.max(0, Math.round((now - r.at) / 1000)),
        lista_zmieniona_po_nim: unknown ? null : first !== undefined,
        sekund_do_zmiany_listy: first !== undefined ? Math.round((first - r.at) / 1000) : null,
      };
    });
    return { historia_przypomnien: history, starszych_pominietych: known.length - rows.length, dziennik_obciety: cut };
  } catch {
    return { historia_przypomnien: null, starszych_pominietych: null, dziennik_obciety: null };
  }
}

// The fixed text of a kind (used when Jev's `uwaga` is empty).
export function tekstStaly(key, rodzaj, counter = {}) {
  const tools = { toolSearch: counter.toolSearch !== false, agent: Boolean(counter.agent) };
  switch (rodzaj) {
    case 'zaloz_liste': return key === MAIN ? 'Załóż listę zadań (TaskCreate): zadanie = jeden sprawdzalny wynik; w toku przed pracą, completed po niej.' : startHint(tools);
    case 'wpisz_krok': return stepHint(key, tools.toolSearch);
    case 'lista_nieaktualna': return 'Lista zadań jest nieaktualna: zaktualizuj statusy, zamknij zrobione zadania i dopisz brakujące.';
    case 'notka': return 'Dopisz do zadania w toku notkę: co robisz i po co.';
    default: return '';
  }
}

// Stores the decision of Jev; one pending reminder per thread, a newer decision replaces an undelivered one. `uwaga`: one sentence of Jev for
// this situation (may be empty: the fixed text of the kind is used). Called by the panel (T4) with the answer of Jev; kto: 'jev' or 'k3'.
export function zapiszPrzypomnienie(sessionId, key, { rodzaj, uwaga = null, tekst = null, nr_tury = null, kto = 'jev' }, env = process.env) { // `tekst` is the older name of `uwaga`
  try {
    const path = remindPath(sessionId, key, env);
    if (!path || !REMINDER_KINDS.includes(rodzaj)) return false;
    mkdirSync(join(path, '..'), { recursive: true });
    const given = uwaga ?? tekst;
    const note = typeof given === 'string' && given.trim() ? maskFree(given.trim()) : null;
    atomicWriteFileSync(path, JSON.stringify({ rodzaj, uwaga: note, nr_tury, kto, ts: new Date().toISOString(), dostarczone: false }));
    return true;
  } catch { return false; }
}

// Delivery (PostToolBatch hook): the pending reminder once, in mode active; in shadow only a row in todo-hint.jsonl. Text: the `uwaga` of Jev,
// else the fixed text of the kind. Returns the text or ''. Without a decision of Jev nothing is delivered.
export function odbierzPrzypomnienie(sessionId, key, mode, meta = {}, env = process.env) {
  const path = remindPath(sessionId, key, env);
  const pending = readJsonSafe(path);
  if (!pending || pending.dostarczone === true || !REMINDER_KINDS.includes(pending.rodzaj)) return '';
  if (pending.kto === 'k3') { // a reminder without a decision of Jev is not sent (plan point 15.7); the row stays for the K3 measure
    atomicWriteFileSync(path, JSON.stringify({ ...pending, dostarczone: true, dostarczono: null, pominiete: 'k3' }));
    logRow('todo-hint.jsonl', { etap: 'przypomnienie', tryb: mode, session_id: sessionId, agent: key, rodzaj: pending.rodzaj, nr_tury: pending.nr_tury ?? null, kto: 'k3', pominiete: true }, env);
    return '';
  }
  const counter = readCounter(sessionId, key, env) ?? {};
  const tekst = pending.uwaga || tekstStaly(key, pending.rodzaj, counter);
  atomicWriteFileSync(path, JSON.stringify({ ...pending, dostarczone: true, dostarczono: new Date().toISOString(), tryb: mode }));
  writeCounter(sessionId, key, { ...counter, podpowiedzi: (Number.isInteger(counter.podpowiedzi) ? counter.podpowiedzi : 0) + 1 }, env);
  logRow('todo-hint.jsonl', { etap: 'przypomnienie', tryb: mode, session_id: sessionId, agent: key, agent_type: meta.agent_type ?? null, prompt_id: meta.prompt_id ?? null, rodzaj: pending.rodzaj, nr_tury: pending.nr_tury ?? null, kto: pending.kto ?? 'jev', uwaga: pending.uwaga ?? null, tekst }, env);
  return mode === 'active' ? tekst : '';
}

// The panel query after a batch (T4) and the zadaniaDoZapytania of the end-of-turn query share the signals; the question is fixed text, the facts
// are in state.przypomnienie. Jev picks `zadne` or the kind of reminder (and may add one sentence, `uwaga`, to his answer).
export function przypomnienieDoZapytania(sessionId, key = MAIN, env = process.env, opts = {}) {
  const state = sygnalyPrzypomnienia(sessionId, key, env, opts);
  if (!state) return null;
  return {
    state,
    question: {
      type: 'choice',
      instructions: 'Czy przypomnieć agentowi o liście zadań (pole state.przypomnienie: ma_liste, zadan_w_toku, wywolan_od_zmiany_listy, typ_agenta, przypomnien_dotad, ostatnie_przypomnienie, historia_przypomnien: wcześniejsze przypomnienia dla tego agenta, każde z rodzajem, trybem (active: agent je dostał, shadow: tylko zapisane), liczbą wywołań narzędzi i sekund od niego oraz informacją, czy agent wywołał narzędzie listy między tym przypomnieniem a następnym albo do teraz; starszych_pominietych: liczba starszych przypomnień poza listą; dziennik_obciety: true, gdy dziennik był za duży i jego początek nie został odczytany; null oznacza, że nie wiadomo) i które, patrząc na jego ostatnią pracę (tekst agenta, lista, ostatnie wywołania)? Liczniki są tylko sygnałem; krótki agent na jedno zadanie może nie potrzebować listy.',
      criteria: {
        zadne: 'Nie przypominaj',
        zaloz_liste: 'Agent pracuje bez listy zadań: przypomnij o założeniu listy przed dalszą pracą',
        wpisz_krok: 'Lista jest, ale nie nadąża za pracą: przypomnij o wpisaniu bieżącego kroku jako w toku',
        lista_nieaktualna: 'Lista jest nieaktualna: przypomnij o zaktualizowaniu statusów i zamknięciu zrobionych zadań',
        notka: 'Zadanie w toku nie ma notki, co agent robi i po co: przypomnij o notce',
      },
    },
  };
}

// The decision of Jev from his answer to the question `przypomnienie`: { rodzaj, uwaga } for a kind, null for `zadne`. `uwaga`: the sentence of
// Jev (field `uwaga`, or `text`, of the answer) or null (then the fixed text of the kind is used at delivery).
export function przypomnienieZOdpowiedzi(...args) {
  const answer = typeof args[0] === 'string' ? args[1] : args[0]; // the first draft of the contract took (key, answer, counter); both calls work
  const rodzaj = typeof answer?.choice === 'string' ? answer.choice : null;
  if (!rodzaj || !REMINDER_KINDS.includes(rodzaj)) return null;
  const given = typeof answer.uwaga === 'string' && answer.uwaga.trim() ? answer.uwaga : typeof answer.text === 'string' && answer.text.trim() ? answer.text : null;
  const uwaga = given ? maskFree(given.trim()) : null;
  return { rodzaj, uwaga, tekst: uwaga };
}

// --- size of one query (T5 probe 11.11.2026: the Jev API answers HTTP 400 for a request of about 58 KB of JSON; 56 KB passed) --------------------

// Splits the query of zadaniaDoZapytania into several, each with a request body of at most `maxChars` characters (state + questions), so that no
// open task, agent or question is left out: every task with its questions, every agent entry with its question and the compact list of all tasks
// (zadania_wszystkie) that its choice refers to. The reminder (state and question) goes with the first part. A single agent whose prompt alone is
// longer than maxChars is a part of its own (cutting it is for the caller, rec-D F3). Returns an array of { state, questions }.
export function podzielZapytanie(q, maxChars = 40000) {
  const size = (v) => JSON.stringify(v).length;
  const { zadania = [], agenci_bez_zadania: agenci = [], zadania_wszystkie, ...rest } = q.state ?? {};
  const parts = [];
  const open = () => { const part = { state: { ...(parts.length ? {} : rest), zadania: [], agenci_bez_zadania: [] }, questions: parts.length ? {} : (q.questions.przypomnienie ? { przypomnienie: q.questions.przypomnienie } : {}) }; parts.push(part); return part; };
  let part = open();
  const fits = (extra) => size(part.state) + size(part.questions) + extra <= maxChars;
  for (const z of zadania) {
    const names = Object.keys(q.questions).filter((n) => new RegExp(`^zadanie_${numberOf(z.zadanie)}_`).test(n));
    const extra = size(z) + names.reduce((a, n) => a + size(q.questions[n]), 0);
    if (!fits(extra) && part.state.zadania.length + part.state.agenci_bez_zadania.length) part = open();
    part.state.zadania.push(z);
    for (const n of names) part.questions[n] = q.questions[n];
  }
  for (const a of agenci) {
    const name = `przypisz_${a.agent}`;
    const extra = size(a) + size(q.questions[name] ?? {}) + (part.state.zadania_wszystkie ? 0 : size(zadania_wszystkie ?? []));
    if (!fits(extra) && part.state.zadania.length + part.state.agenci_bez_zadania.length) part = open();
    part.state.agenci_bez_zadania.push(a);
    if (zadania_wszystkie) part.state.zadania_wszystkie = zadania_wszystkie;
    if (q.questions[name]) part.questions[name] = q.questions[name];
  }
  return parts;
}
