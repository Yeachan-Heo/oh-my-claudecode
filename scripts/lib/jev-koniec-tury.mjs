// omc-lokalne T3 (S2): the one query at the end of a turn and its file. Category: 4. input for the
// agent (Jev) and 3. shape of a record. The hook decides nothing: it counts signals (tokens, growth, the cut a compaction would make, the
// lists) and hands them to Jev as the state of the query; the question about the moment is one question of the same query as the panel's
// The answer goes to
// <log dir>/koniec-tury/<session>/<main|agent_id>.json, which the compaction module reads in `turn.complete` (hooks/jev-compaction.ts).
// Owner's rule no. 1 (maximum of Jev): no gate, no threshold on the moment; `ponad_400` and `ile_zdjac_tok` are fields of the state.

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from './atomic-write.mjs';
import { shellLogDir } from './jev-panel-host.mjs';
import { MAIN, agentKey, inProgress, listsDir, readList } from './jev-lista.mjs';

export const KONIEC_DIR = 'koniec-tury';
export const FILE_VERSION = 1;
export const BAND_FROM = 200_000; // the band of the plan's table of thresholds (point 5): signals for Jev, not gates
export const BAND_TO = 400_000;
export const LIMIT_AFTER = 120_000; // the limit after a compaction (owner 16:00 no. 5); the code only says how much is to come off
export const YES_FROM = 0.5; // rec-D F8: the larger of the two answers; no minimal certainty
// Term of the query of the end of a turn: J0 of T0 (11.11, odbior/J0-WYNIK.md): p95 365 ms, max 457 ms, 0 % past 1 000 ms. Background evaluations: 3 000 ms (T2).
export const END_QUERY_MS = 1000;
const SESSION_ID = /^(?!\.)[A-Za-z0-9._-]{1,200}$/;
const RESOLVER_CHARS = 4000; // the resolver cuts a string of the panel's state at this length (jev-resolve.mjs POINT_DEFAULT_EXCERPT_CHARS); until T2/T4 lift it `uciete_znaki` says so
const TAIL_BYTES = 1024 * 1024; // the transcript tail read for the last usage row

export const koniecDir = (sessionId, env = process.env) => (typeof sessionId === 'string' && SESSION_ID.test(sessionId) ? join(shellLogDir(env), KONIEC_DIR, sessionId) : null);
export const koniecPath = (sessionId, key, env = process.env) => { const dir = koniecDir(sessionId, env); return dir && /^[A-Za-z0-9_-]{1,100}$/.test(key) ? join(dir, `${key}.json`) : null; };
export const modulPath = (sessionId, env = process.env) => { const dir = koniecDir(sessionId, env); return dir ? join(dir, 'modul.json') : null; };

export function readJson(path) {
  try {
    const value = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function tailText(path, bytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

// The last assistant row of the transcript with a usage: the tokens the API counted for the request (input, cache read, cache creation) and
// the uuid of the last assistant row, which names the turn (`tura`). Null without one.
export function lastUsage(transcript) {
  if (!transcript) return null;
  const lines = tailText(transcript, TAIL_BYTES).split('\n');
  let tura = null;
  let text = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"assistant"')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type !== 'assistant' || row.isSidechain === true) continue;
    if (tura === null && typeof row.uuid === 'string') tura = row.uuid;
    if (!text && Array.isArray(row.message?.content)) text = row.message.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
    const u = row.message?.usage;
    if (!u || typeof u !== 'object') continue;
    const tokens = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    if (tokens > 0) return { tokens, tura, text: text ?? '' };
  }
  return tura === null ? null : { tokens: null, tura, text: text ?? '' };
}

// The names of the tasks of lists, in progress and closed (all, F3: no limit of the number or the length); other agents of the session with a task
// in progress. The names go through `clean` (the panel's cleanText: a line with a secret path is replaced, not dropped).
export function listSignals(sessionId, clean, env = process.env) {
  const record = readList(sessionId, MAIN, env);
  const items = Array.isArray(record?.items) ? record.items : [];
  const names = (rows) => rows.map((x) => clean(String(x?.content ?? '')));
  const agents = [];
  try {
    const dir = join(listsDir(env), sessionId);
    for (const file of readdirSync(dir)) {
      const m = /^([A-Za-z0-9_-]{1,100})\.json$/.exec(file);
      if (!m || m[1] === MAIN) continue;
      const task = inProgress(readList(sessionId, m[1], env))[0];
      if (task) agents.push({ agent_id: m[1], zadanie: clean(String(task.content ?? '')) });
    }
  } catch { /* no lists of agents */ }
  return {
    zadania_w_toku: names(items.filter((x) => x?.status === 'in_progress')),
    ostatnio_zamkniete: names(items.filter((x) => x?.status === 'completed')),
    agenci_w_toku: agents,
  };
}

export const MOMENT_QUESTION = {
  type: 'noul',
  instructions: 'Czy teraz jest dobry moment na kompakcję rozmowy tego agenta? Weź pod uwagę, w jakim stanie jest praca (odpowiedz, zadania_w_toku, ostatnio_zamkniete, agenci_w_toku), ile tokenów rozmowa ma (tokeny, w_pasmie, ponad_400), ile trzeba zdjąć do limitu (ile_zdjac_tok) i co da kompakcja (prognoza_ciecia, przyrost). Gdy ponad_400 jest prawdą, próg 400 tys. jest przekroczony: decyzja nadal należy do Ciebie.',
  criteria: {
    true: 'Dobry moment: praca doszła do końca etapu, szczegóły z ostatnich kroków nie będą zaraz potrzebne.',
    false: 'Zły moment: praca w toku, zaraz wróci do świeżych szczegółów, które właśnie czytała albo zmieniała.',
  },
};

// The part `moment` of the state: only signals, each from a measurement; `modul` is modul.json of the compaction module (or null).
export function momentState({ tokens, modul, lists, now = Date.now() }) {
  const ageSeconds = modul && typeof modul.ts === 'string' && Number.isFinite(Date.parse(modul.ts)) ? Math.max(0, Math.round((now - Date.parse(modul.ts)) / 1000)) : null;
  const after = modul?.po_ostatniej_kompakcji && Number.isFinite(modul.po_ostatniej_kompakcji.tokens) ? modul.po_ostatniej_kompakcji.tokens : null;
  const forecast = modul?.prognoza_ciecia && typeof modul.prognoza_ciecia === 'object' ? { ...modul.prognoza_ciecia, wiek_s: ageSeconds } : null;
  return {
    tokeny: tokens,
    okno: modul?.okno ?? null,
    prog_hosta: modul?.prog_hosta ?? null,
    pasmo_od: BAND_FROM,
    pasmo_do: BAND_TO,
    w_pasmie: tokens === null ? null : tokens >= BAND_FROM && tokens <= BAND_TO,
    ponad_400: tokens === null ? null : tokens > BAND_TO,
    limit_po_kompakcji: LIMIT_AFTER,
    ile_zdjac_tok: tokens === null ? null : Math.max(0, tokens - LIMIT_AFTER),
    przyrost: tokens !== null && after !== null ? Math.max(0, tokens - after) : null,
    tury_od_kompakcji: Number.isFinite(modul?.tury_od_kompakcji) ? modul.tury_od_kompakcji : null,
    tury_od_odmowy: Number.isFinite(modul?.tury_od_odmowy) ? modul.tury_od_odmowy : null,
    prosba_odrzucona: modul?.prosba_odrzucona ?? null,
    prognoza_ciecia: forecast,
    ...(forecast ? {} : { prognoza_ciecia_powod: modul ? 'modul_nie_liczyl' : 'brak_modul_json' }),
    host_bez_kompakcji: modul?.host_bez_kompakcji === true,
    droga_kompakcji: modul?.droga_kompakcji ?? null,
    zaleglosc_ocen: Number.isFinite(modul?.zaleglosc_ocen) ? modul.zaleglosc_ocen : null,
    czeka_kompakcja: modul?.czeka_kompakcja ?? null,
    ...lists,
  };
}

// Jev's answer to the question as { noul, tak } (null: no answer). rec-D F8: no minimal certainty, yes from YES_FROM.
export function momentAnswer(answer) {
  const raw = answer && typeof answer === 'object' ? answer.noul : undefined;
  const noul = typeof raw === 'boolean' ? (raw ? 1 : 0) : typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  return { noul, tak: noul === null ? null : noul >= YES_FROM };
}

// The file of the end of a turn. `prev` is the file as it was (kept one level deep as `poprzednia`, the module's reserve).
export function newRecord({ data, key, nrTury, tura, zadanie, moment, previous }) {
  const { poprzednia, ...before } = previous ?? {};
  return {
    wersja: FILE_VERSION, ts: new Date().toISOString(), sesja: data.session_id, agent: key, agent_type: typeof data.agent_type === 'string' ? data.agent_type : null,
    nr_tury: nrTury, tura: tura ?? null, zadanie: zadanie || null, wynik: 'w_toku', kto: 'jev', po_terminie: false,
    wejscie_pelne: true, uciete_znaki: 0, pola_puste: [], maska_miejsc: null,
    moment, panel: null, ocena_jeva: null,
    poprzednia: previous ? before : null,
  };
}

export function writeKoniec(sessionId, key, record, env = process.env) {
  const path = koniecPath(sessionId, key, env);
  if (!path) return false;
  try { mkdirSync(dirname(path), { recursive: true }); atomicWriteFileSync(path, JSON.stringify(record, null, 1)); return true; } catch { return false; }
}

export const readKoniec = (sessionId, key, env = process.env) => readJson(koniecPath(sessionId, key, env));
export const readModul = (sessionId, env = process.env) => readJson(modulPath(sessionId, env));
export const keyOf = (data) => agentKey(data);

// The end of a turn of one hook call. Counts the turn (nr_tury in the panel state), reads the file of the module (modul.json) and the lists,
// writes the first file (`w_toku`, so the module knows the question was put even before Jev answers) and returns the handle the hook fills:
//   .momentOn         the question about the moment is part of this query (main thread only: the module never compacts a turn of an agent)
//   .attach(state, questions)  adds the state { moment, odpowiedz } and the question `moment` (main thread); returns { state, questions }
//   .done({ answer, mode, ms, powod })  the answer (jevAnswerOf of the query) and its mode; .finish() writes the final file (never throws)
export function beginEnd(P, data, env, { key, main }) {
  const sessionId = data.session_id;
  const path = koniecPath(sessionId, key, env);
  if (!path) return null;
  try {
    let nr = 0;
    P.updatePanelState(sessionId, key, (s) => { nr = (Number(s.nr_tury) || 0) + 1; return { ...s, nr_tury: nr }; }, env);
    const transcript = P.agentTranscript(data);
    const usage = lastUsage(transcript);
    const tokens = main && usage ? usage.tokens : null;
    const modul = main ? readModul(sessionId, env) : null;
    // The text that ends the turn: the hook's last_assistant_message, else the last assistant row of the transcript (never an empty field when there is a text).
    const raw = typeof data.last_assistant_message === 'string' && data.last_assistant_message.trim() ? data.last_assistant_message : usage?.text ?? '';
    const answer = P.cleanText(raw);
    const state = main ? { moment: momentState({ tokens, modul, lists: listSignals(sessionId, P.cleanText, env) }), odpowiedz: answer } : null;
    // The module never compacts a turn of an agent: no moment for it (null).
    const moment = main
      ? { noul: null, tak: null, nr_tury: nr, ts: new Date().toISOString(), tokeny: tokens, ponad_400: state.moment.ponad_400, ile_zdjac_tok: state.moment.ile_zdjac_tok, kto: 'jev', powod: null }
      : null;
    // S1 key of the task (`main:<n>`) comes with T5; the text of the task is not a key.
    const record = newRecord({ data, key, nrTury: nr, tura: usage?.tura, zadanie: null, moment, previous: readJson(path) });
    const cut = main ? Math.max(0, answer.length - RESOLVER_CHARS) : 0;
    record.uciete_znaki = cut;
    record.wejscie_pelne = cut === 0;
    if (main && !answer.trim()) record.pola_puste = ['odpowiedz'];
    // Places the mask replaced in the text: lines named by a secret path and masked values (the count of *** the text gained).
    const count = (text, re) => (text.match(re) ?? []).length;
    record.maska_miejsc = main ? Math.max(0, count(answer, /\[linia pominięta[^\]]*\]/g) + count(answer, /\*\*\*/g) - count(raw, /\*\*\*/g)) : null;
    writeKoniec(sessionId, key, record, env);
    return {
      momentOn: main,
      state,
      record,
      // The question about the moment and its signals into the query of the hook: returns { state, questions } with `moment` added (main thread only).
      attach(queryState, questions) {
        if (!main) return { state: queryState, questions };
        return { state: Object.assign(queryState, state), questions: { ...questions, moment: MOMENT_QUESTION } };
      },
      // The result of the query. `mode` is the mode of the point ('active' or 'shadow'), `got` the mode the query ended in (result.mode).
      done({ answer, mode, got, ms, powod }) {
        const m = record.moment;
        record.ms = ms ?? null;
        record.ts_odpowiedzi = new Date().toISOString();
        if (!main) { record.wynik = got === 'active' ? 'ok' : 'degraded'; return; }
        const read = momentAnswer(answer);
        if (mode === 'active' && got === 'active' && read.noul !== null) { Object.assign(m, read, { powod: null }); record.wynik = 'ok'; return; }
        // The query went out and Jev did not answer: K3 (the module decides from the signal, the record says so).
        record.wynik = got === 'breaker' ? 'bezpiecznik' : 'degraded';
        m.powod = powod ?? (mode !== 'active' ? 'tryb_cichy' : got === 'breaker' ? 'bezpiecznik' : got === 'timeout' || got === 'resolver-timeout' ? 'czas' : 'blad_jeva');
        if (mode === 'active') record.kto = 'k3';
      },
      skip(wynik, powod, k3 = false) { record.wynik = wynik; if (main) record.moment.powod = powod; if (k3) record.kto = 'k3'; },
      finish(msHook) {
        try {
          if (record.wynik === 'w_toku') record.wynik = 'bez-pytan';
          if (main && record.moment.noul === null && !record.moment.powod) record.moment.powod = 'nie_pytano';
          record.ms_hook = msHook ?? null;
          writeKoniec(sessionId, key, record, env);
        } catch { /* the file never breaks the hook */ }
      },
    };
  } catch { return null; }
}
