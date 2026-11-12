#!/usr/bin/env node
// Offline replay of the Jev panel on labelled cases, the way the panel was scored (T4, 2026-11-11).
//   node replay-labelled.mjs <labels.jsonl> <out.jsonl> [--scripts <scripts dir>] [--panel <panel.jsonl>] [--limit <n>] [--dry-run] [--no-end] [--states]
//
// For each row of the labels file (field `id`; the case fields `ts`, `session_id`, `agent_id`, `agent_type`, `transkrypt`, `poprzednie_zapytanie`,
// `wejscie.stan.powod` either in the row or in files cases*.jsonl of the labels directory, joined by `id`) the script rebuilds the moment of the
// query from the session transcript, calls the panel code (panelStateV2, panelSignals, panelQuestionsV2, panelAnswerV2) and the Jev resolver
// (resolveRequest), and writes the decision. It scores nothing and never reads the ground truth (`prawda`); metrics.py does that.
//
// Two moments per case:
//   paczka: a PostToolBatch query at the case's `ts`; the agent text is the window of the panel (texts after the mark, oldest first, up to the budget).
//   koniec: the first text that ends a turn after `ts` (an assistant row with stop_reason end_turn; in the main session before the next owner message),
//           event Stop or SubagentStop. One end-of-turn text is asked once and shared by the cases.
// Output: one JSON row per case { id, ts, agent, podpowiedzi, wybrane, paczka, koniec, decyzja }; decyzja[question] = { paczka, koniec, razem }
// (true: the hint would have been given; false: asked, no hint; null: not asked or no answer). The per-question modes (shadow) and the brake
// "once per task" are ignored: what is counted is whether a hint would have been given.
//
// Options: --scripts <dir> (default: the scripts directory of this tree), --panel <panel.jsonl> (moments of past queries, default ~/.omc/state/jev/panel.jsonl),
//   --limit <n> (first n cases), --dry-run (build the states only, no query to Jev: no key, no cost), --no-end (batch moment only),
//   --states (append the full state sent to Jev). Answers are cached in <out>.cache/ (by content of the query), the resolver log goes to <out>.log/;
//   the live Jev log is never touched. Transcripts are read only; copies up to the moment T go to a temporary directory and are removed.
// Cost: one Jev request per case and moment (about 2 per case), more when a state exceeds the window of Jev and is split. The key is TYPESAFE_API_KEY.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (name) => argv.includes(name);
const VALUE_OPTS = new Set(['--scripts', '--panel', '--limit']);
const plain = argv.filter((a, i) => !a.startsWith('--') && !VALUE_OPTS.has(argv[i - 1]));
if (plain.length !== 2) {
  console.error('Usage: node replay-labelled.mjs <labels.jsonl> <out.jsonl> [--scripts <dir>] [--panel <panel.jsonl>] [--limit <n>] [--dry-run] [--no-end] [--states]');
  process.exit(2);
}
const [ETYKIETY, WYJSCIE] = plain.map((p) => resolve(p));
const SKRYPTY = resolve(opt('--scripts') ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const PANEL = resolve(opt('--panel') ?? join(homedir(), '.omc', 'state', 'jev', 'panel.jsonl'));
const LIMIT = Number(opt('--limit')) > 0 ? Number(opt('--limit')) : Infinity;
const BEZ_JEVA = flag('--dry-run');
if (!BEZ_JEVA && !process.env.TYPESAFE_API_KEY) {
  console.error('TYPESAFE_API_KEY is not set: nothing would be asked of Jev. Set it, or pass --dry-run to build the states only.');
  process.exit(2);
}
const BEZ_KONCA = flag('--no-end');
const STANY = flag('--states');
const TMP = `${WYJSCIE}.tmp-${process.pid}`;
const CACHE = `${WYJSCIE}.cache`;
const LOG = `${WYJSCIE}.log`;
const MAIN_TAIL = 7 * 1024 * 1024; // the panel reads the last 6 MiB of the main session transcript

const load = (rel) => import(pathToFileURL(join(SKRYPTY, rel)).href);
const P = await load('lib/jev-panel-wejscie.mjs');
const L = await load('lib/jev-lista.mjs');
const R = await load('jev-resolve.mjs');
if (typeof P.textWindow !== 'function') { console.error(`${SKRYPTY}: not the panel (no textWindow)`); process.exit(2); }

const jsonl = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
const blockText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '');
const iso = (t) => (t > 0 ? new Date(t).toISOString() : null);
// as ownerTyped of the panel: a slash command without arguments and its output are not a message of the owner
function ownerTyped(text) {
  const inner = text.replace(/^<hc\b[^>]*>([\s\S]*)<\/hc>$/, '$1').trim();
  if (/^<command-message>/.test(inner)) return (/<command-args>([\s\S]*?)<\/command-args>/.exec(inner)?.[1] ?? '').trim();
  if (/^<(?:command-name|command-message|local-command)/.test(inner) || /^\/[\w:.-]+$/.test(inner)) return '';
  return inner;
}

// --- transcript index: rows with file position and time, tool calls with results, owner messages, ends of turns ---------
const indeksy = new Map();
function indeks(path, key) {
  if (indeksy.has(path)) return indeksy.get(path);
  if (!existsSync(path)) { indeksy.set(path, null); return null; }
  const buf = readFileSync(path);
  const idx = { key, path, buf, wiersze: [], wywolania: [], ludzkie: [], konce: [], teksty: [] };
  const uses = new Map();
  const lines = [];
  let pos = 0;
  let t = 0;
  while (pos < buf.length) {
    let end = buf.indexOf(10, pos);
    if (end < 0) end = buf.length;
    const line = buf.toString('utf8', pos, end);
    pos = end + 1;
    lines.push(line);
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const x = Date.parse(r.timestamp ?? r.attachment?.timestamp ?? '');
    if (Number.isFinite(x)) t = x;
    idx.wiersze.push({ end: Math.min(pos, buf.length), t });
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      const text = r.message.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
      if (text && r.message.stop_reason === 'end_turn') idx.konce.push({ t, text });
      for (const b of r.message.content) if (b?.type === 'tool_use') uses.set(b.id, { name: b.name, input: b.input });
    } else if (r.type === 'user') {
      const c = r.message?.content;
      if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) {
        const results = c.filter((b) => b?.type === 'tool_result');
        for (const b of results) {
          const u = uses.get(b.tool_use_id);
          if (!u) continue;
          idx.wywolania.push({ ...u, tRes: t, nr: lines.length, isError: b.is_error === true, text: blockText(b.content), response: results.length === 1 && r.toolUseResult !== undefined ? r.toolUseResult : blockText(b.content) });
        }
      } else if (r.origin?.kind === 'human' && !r.isMeta && !r.isSidechain) {
        if (ownerTyped(blockText(c).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim())) idx.ludzkie.push(t);
      }
    } else if (r.type === 'attachment' && r.attachment?.type === 'queued_command' && r.attachment.origin?.kind === 'human' && typeof r.attachment.prompt === 'string') {
      if (ownerTyped(r.attachment.prompt.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim())) idx.ludzkie.push(t);
    }
  }
  idx.wywolania.sort((a, b) => a.tRes - b.tRes || a.nr - b.nr);
  idx.ludzkie.sort((a, b) => a - b);
  idx.teksty = P.textRows(lines); // texts as the panel sees them (without the copies after a compaction)
  indeksy.set(path, idx);
  return idx;
}

// Copy of the transcript up to the moment T: the start of the file up to the first row with a time later than T (a resumed session appends
// rows with old times later, so "the last row with a time <= T" would reach too far); main session: only the tail the panel reads.
let kopie = 0;
function kopiaDo(idx, T, sid) {
  let cut = 0;
  for (const w of idx.wiersze) { if (w.t > T) break; cut = w.end; }
  let from = 0;
  if (idx.key === 'main' && cut > MAIN_TAIL) from = idx.buf.indexOf(10, cut - MAIN_TAIL) + 1;
  const dir = join(TMP, String(++kopie));
  const path = idx.key === 'main' ? join(dir, `${sid}.jsonl`) : join(dir, sid, 'subagents', `agent-${idx.key}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, idx.buf.subarray(from, cut));
  return { path, dir };
}

const wpis = (c) => {
  const call = { tool_name: c.name, tool_input: c.input, tool_response: c.response };
  return c.isError ? P.callEntryFull(call, c.text) : P.callEntryFull(call);
};
// list counters at the moment T (what the live hook keeps in the panel state): calls since the last list change, consecutive queries with the same list
function licznikiListy(idx, T, sid, chwile) {
  let lastChange = 0;
  for (const c of idx.wywolania) { if (c.tRes > T) break; if (L.isListTool(c.name, idx.key) && !c.isError) lastChange = c.tRes; }
  const lista_od = idx.wywolania.filter((c) => c.tRes > lastChange && c.tRes <= T).length;
  const sygn = (Tq) => { const cur = listaNa(idx, Tq, sid); return P.listSignature(cur); };
  const teraz = sygn(T);
  let ta_sama = 0;
  for (const Tq of chwile.filter((x) => x < T).reverse()) { if (teraz && sygn(Tq) === teraz) ta_sama++; else break; }
  return { lista_od, ta_sama, lista_sig: teraz, razem: idx.wywolania.filter((c) => c.tRes <= T).length };
}
function listaNa(idx, T, sid) {
  let items = [];
  const env = { ...process.env, OMC_JEV_LOG_DIR: LOG };
  for (const c of idx.wywolania) {
    if (c.tRes > T) break;
    if (!L.isListTool(c.name, idx.key) || c.isError) continue;
    const data = { tool_name: c.name, tool_input: c.input, tool_response: c.response, session_id: sid, ...(idx.key !== 'main' ? { agent_id: idx.key } : {}) };
    if (c.name === 'TaskCreate') { const id = L.taskIdOf(c.response) ?? L.taskIdOf(c.text); if (!id) continue; data.task_id = id; }
    let next = null;
    try { next = L.nextList({ items }, data, env); } catch { next = null; }
    if (next) items = next;
  }
  const cur = items.find((x) => x?.status === 'in_progress');
  return { record: { items }, task: cur ? String(cur.content ?? '') : '', note: cur && typeof cur.notatka === 'string' ? cur.notatka : null };
}

// --- Jev: the resolver of the plugin, a cache keyed by the content of the query --------------------------------------------
const licznik = { zapytan: 0, z_pamieci: 0, degraded: 0, ms: [] };
async function zapytaj(state, questions) {
  if (BEZ_JEVA) return { mode: 'dry-run', answers: null, ms: 0 };
  const h = createHash('sha256').update(JSON.stringify({ state, questions })).digest('hex').slice(0, 24);
  const file = join(CACHE, `${h}.json`);
  if (existsSync(file)) { licznik.z_pamieci++; return { ...JSON.parse(readFileSync(file, 'utf8')), pamiec: true }; }
  const env = { ...process.env, OMC_JEV: 'panel:active', OMC_JEV_LOG_DIR: LOG };
  env.OMC_JEV_EXCERPT_CHARS_PANEL = String(P.FIELD_MAX); delete env.OMC_JEV_BREAKER; delete env.OMC_JEV_MAX_RPM; delete env.OMC_JEV_DIAG;
  const result = await R.resolveRequest({ point: P.PANEL_POINT, state, questions, heuristic: null, context: { session_id: 'panel-replay' } }, env);
  licznik.zapytan++;
  licznik.ms.push(result.durationMs);
  const rec = { mode: result.mode, answers: result.answers ?? null, ms: result.durationMs };
  if (result.mode === 'active') writeFileSync(file, JSON.stringify(rec));
  else licznik.degraded++;
  return rec;
}

// --- the batch mark at the moment T ------------------------------------------------------------------------------------------
// The live panel moves the mark at every batch query: to the last text that fitted the budget while others wait, and when all fitted, to the
// newest row read. The replay rebuilds this chain in memory with textWindow of the panel for the successive query moments of this agent from
// panel.jsonl (PostToolBatch rows with questions) and the moments of the cases.
const lancuchy = new Map();
function znacznikPaczek(idx, sid, chwile, T) {
  const k = `${sid}|${idx.key}`;
  if (!lancuchy.has(k)) {
    const kroki = [];
    let mark = { t: 0, id: '', i: -1 };
    for (const Tq of chwile) {
      const rows = idx.teksty.filter((x) => x.t <= Tq);
      const ludzie = idx.key === 'main' ? idx.ludzkie.filter((t) => t <= Tq).slice(-P.OWNER_KEPT) : [];
      const w = P.textWindow(rows, { mark: mark.t, after: mark.i, since: ludzie.at(-1) ?? 0, floor: ludzie[0] ?? 0 });
      if (w.left > 0) { const ostatni = rows.find((x) => x.id === w.id && x.t === w.to) ?? rows.filter((x) => x.t === w.to).at(-1); mark = { t: w.to, id: w.id, i: ostatni ? ostatni.i : -1 }; } else mark = { t: Tq, id: '', i: -1 };
      kroki.push({ T: Tq, mark });
    }
    lancuchy.set(k, kroki);
  }
  return lancuchy.get(k).filter((x) => x.T < T).at(-1)?.mark ?? { t: 0, id: '', i: -1 };
}

// --- one panel query at the moment T ------------------------------------------------------------------------------------------
// mark: the panel mark { t, id } at the moment T (batch: znacznikPaczek; end of turn: the later of it and the previous end of turn).
async function zapytanie({ idx, sid, agentType, T, reason, event, mark, last = '', chwile = [] }) {
  const main = idx.key === 'main';
  const { path, dir } = kopiaDo(idx, T, sid);
  try {
    const prevT = chwile.filter((x) => x < T).at(-1) ?? 0;
    const upTo = idx.wywolania.filter((c) => c.tRes <= T);
    const sinceN = upTo.filter((c) => c.tRes > prevT).length;
    const calls = upTo.slice(-Math.max(P.JOURNAL_CALLS, sinceN));
    const journal = calls.map(wpis);
    const flags = upTo.slice(-P.JOURNAL_CALLS).map((c) => P.callFlags({ tool_name: c.name, tool_input: c.input, tool_response: c.response }, c.isError));
    const current = listaNa(idx, T, sid);
    const delegate = main || L.typeTools(agentType, process.cwd(), process.env).agent !== false;
    const data = { hook_event_name: event, session_id: sid, transcript_path: path, ...(main ? {} : { agent_id: idx.key, agent_type: agentType, agent_transcript_path: path }), ...(last ? { last_assistant_message: last } : {}) };
    const end = P.END_EVENTS.has(event);
    const st = licznikiListy(idx, T, sid, chwile);
    const sig0 = P.panelSignals(flags, current.task, current.note, reason, main, delegate, false);
    const built = P.panelStateV2(data, journal, reason, process.env, current, { t: mark.t, id: mark.id }, end, { sig: sig0, st, since: sinceN, brake: '' });
    // as in runPanelV2 (input 4): all questions without gates, the K3 note rule only without an answer, the choice question pokaz
    const sig = { ...sig0, text: built.state.sygnaly?.nowy_tekst === true };
    const reguly = [];
    const questions = P.panelQuestionsV2(sig);
    const asked = Object.keys(questions);
    const offered = [...asked];
    questions.pokaz = P.pokazQuestion(offered);
    const textChars = built.state.tekst_agenta.reduce((a, t) => a + t.length, 0);
    const out = {
      zdarzenie: event, ts: iso(T), powod: reason, pytania: asked, reguly, znacznik: iso(mark.t), tekst_agenta_znakow: textChars, tekst_poprzedni_znakow: built.state.tekst_poprzedni?.length ?? 0, uciete_znaki: built.cut, wejscie_pelne: built.cut === 0, tekst_czeka: built.textLeft, tekst_stare: built.textOld,
      polecenie_znakow: (built.state.polecenia ?? []).reduce((sum, text) => sum + text.length, 0),
      sygnaly: { bledy: sig.errors, zapis: sig.writes, odczyty: sig.readRun, zadanie: sig.task, notka: sig.note, tekst: sig.text, ...built.state.sygnaly },
      tekst_agenta: built.state.tekst_agenta, ...(STANY ? { stan: built.state } : {}),
    };
    if (!asked.length) return { ...out, wynik: end ? 'bez-tekstu' : 'bez-pytan', p: {}, wybor: {}, tak: [...reguly] };
    // as in the hook: a state over the window of Jev goes in several queries (askInParts of jev-panel.mjs), the answers merged
    const S = await load('lib/jev-panel-shadow.mjs');
    const PM = await load('jev-panel.mjs');
    const fake = { recordJevShadow: ({ state, questions: qs }) => zapytaj(state, qs), jevAnswerOf: S.jevAnswerOf };
    const asking = await PM.askInParts(P, fake, { permission_mode: undefined }, process.env, built.state, questions);
    out.uciete_znaki += asking.cut; out.wejscie_pelne = out.uciete_znaki === 0; out.zapytan = asking.parts;
    const result = { ...asking.result, ms: asking.ms };
    const p = {};
    const wybor = {};
    const tak = [];
    for (const name of asked) {
      const answer = P.panelAnswerV2(name, result.mode === 'active' ? result.answers?.[name] : undefined);
      p[name] = answer.p;
      if (answer.choice !== undefined) wybor[name] = answer.choice;
      if (answer.yes) tak.push(name);
    }
    const pokaz = result.mode === 'active' ? P.pokazChoice(result.answers?.pokaz, offered) : null;
    let pick = null;
    if (tak.length && pokaz !== 'zadna') pick = pokaz && tak.includes(pokaz) ? pokaz : tak.reduce((b, n) => ((p[n] ?? 0) > (p[b] ?? 0) ? n : b));
    if (!pick && result.mode === 'active' && p.notka === null && P.noteRule(sig)) { pick = 'notka'; reguly.push('notka'); }
    return { ...out, reguly, wynik: result.mode, ms: result.ms, p, wybor, tak: [...tak, ...reguly], pokaz, pick };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- cases ------------------------------------------------------------------------------------------------------------------
const katalog = dirname(ETYKIETY);
const przypadki = new Map();
for (const name of readdirSync(katalog).filter((n) => /^przypadki.*\.jsonl$/.test(n)).sort()) for (const row of jsonl(join(katalog, name))) if (row.id !== undefined) przypadki.set(String(row.id), row);
const etykiety = jsonl(ETYKIETY);
const panelRows = existsSync(PANEL) ? jsonl(PANEL).filter((r) => r.zdarzenie === 'PostToolBatch' && Array.isArray(r.pytania) && r.pytania.length) : [];
const zapytaniaAgenta = new Map(); // session|agent -> times of the PostToolBatch queries from panel.jsonl
for (const r of panelRows) {
  const k = `${r.session_id}|${r.agent === 'main' ? 'main' : r.agent_id}`;
  if (!zapytaniaAgenta.has(k)) zapytaniaAgenta.set(k, []);
  zapytaniaAgenta.get(k).push(Date.parse(r.ts));
}
// batch query moments of one agent: rows of panel.jsonl and case moments from the labels, ascending, without repeats
const chwilePrzypadkow = new Map();
for (const e of etykiety) {
  const c = { ...(przypadki.get(String(e.id)) ?? {}), ...e };
  const T = Date.parse(c.ts);
  if (!Number.isFinite(T) || typeof c.session_id !== 'string') continue;
  const k = `${c.session_id}|${c.agent_id ? String(c.agent_id) : 'main'}`;
  if (!chwilePrzypadkow.has(k)) chwilePrzypadkow.set(k, []);
  chwilePrzypadkow.get(k).push(T);
}
const chwileAgenta = (sid, key) => [...new Set([...(zapytaniaAgenta.get(`${sid}|${key}`) ?? []), ...(chwilePrzypadkow.get(`${sid}|${key}`) ?? [])])].sort((a, b) => a - b);
mkdirSync(TMP, { recursive: true });
mkdirSync(CACHE, { recursive: true });
mkdirSync(LOG, { recursive: true });

const konce = new Map(); // transcript|end time -> result of the end-of-turn query
const wyniki = [];
const widziane = new Set();
let pominiete = 0;
try {
  for (const etykieta of etykiety) {
    if (wyniki.length >= LIMIT) break;
    const id = etykieta.id === undefined ? null : String(etykieta.id);
    if (id === null || widziane.has(id)) { pominiete++; continue; } // one panel query per case, also when there are several labels
    widziane.add(id);
    const c = { ...(przypadki.get(id) ?? {}), ...Object.fromEntries(Object.entries(etykieta).filter(([, v]) => v !== null && v !== undefined)) };
    const T = Date.parse(c.ts);
    if (!Number.isFinite(T) || typeof c.session_id !== 'string' || typeof c.transkrypt !== 'string') { wyniki.push({ id, blad: 'missing case fields (ts, session_id, transkrypt)' }); continue; }
    const key = c.agent_id ? String(c.agent_id) : 'main';
    const base = basename(c.transkrypt).startsWith('agent-') ? dirname(dirname(dirname(c.transkrypt))) : dirname(c.transkrypt);
    const path = key === 'main' ? join(base, `${c.session_id}.jsonl`) : join(base, c.session_id, 'subagents', `agent-${key}.jsonl`);
    const idx = indeks(path, key);
    if (!idx) { wyniki.push({ id, ts: c.ts, blad: 'no transcript' }); continue; }
    const reason = c.powod ?? c.wejscie?.stan?.powod ?? 'wywolania';
    const chwile = chwileAgenta(c.session_id, key);
    const paczka = await zapytanie({ idx, sid: c.session_id, agentType: c.agent_type ?? null, T, reason, event: 'PostToolBatch', chwile, mark: znacznikPaczek(idx, c.session_id, chwile, T) });
    let koniec = null;
    if (!BEZ_KONCA) {
      const nextHuman = key === 'main' ? idx.ludzkie.find((t) => t > T) : undefined;
      const end = idx.konce.find((x) => x.t > T && (nextHuman === undefined || x.t <= nextHuman));
      if (end) {
        const k = `${path}|${end.t}`;
        // end-of-turn mark: the later of the batch mark at this moment and the previous end of turn of this agent (each end of turn is asked once)
        if (!konce.has(k)) {
          const zPaczek = znacznikPaczek(idx, c.session_id, chwile, end.t);
          const poprzedni = idx.konce.filter((x) => x.t < end.t).at(-1)?.t ?? 0;
          konce.set(k, await zapytanie({ idx, sid: c.session_id, agentType: c.agent_type ?? null, T: end.t, reason: P.END_REASON, event: key === 'main' ? 'Stop' : 'SubagentStop', chwile, mark: poprzedni > zPaczek.t ? { t: poprzedni, id: '' } : zPaczek, last: end.text }));
        }
        koniec = konce.get(k);
      }
    }
    // decyzja[question]: batch and end separately (true: the hint would have been given; false: asked, no hint; null: not asked or no answer;
    // notka is a rule without a model, counted in every batch). razem: the batch, and for zrodlo also the end, because the ground-truth labels
    // take the end-of-turn text into account only for zrodlo.
    const decyzja = {};
    for (const name of P.PANEL_QUESTION_NAMES_V2) {
      const one = (q) => (!q ? null : q.pytania.includes(name) && q.p[name] !== null && q.p[name] !== undefined ? q.tak.includes(name) : null);
      const a = one(paczka);
      const b = one(koniec);
      const zKoncem = name === 'zrodlo' ? b : null;
      decyzja[name] = { paczka: a, koniec: b, razem: a === true || zKoncem === true ? true : a === null && zKoncem === null ? null : false };
    }
    // podpowiedzi: questions with a "yes" (sensitivity and accuracy of the question); wybrane: the hint after Jev's choice (pokaz), batch and end separately
    const podpowiedzi = Object.keys(decyzja).filter((name) => decyzja[name].razem === true);
    wyniki.push({ id, ts: c.ts, session_id: c.session_id, agent: key, agent_type: c.agent_type ?? null, podpowiedzi, wybrane: { paczka: paczka?.pick ?? null, koniec: koniec?.pick ?? null }, paczka, koniec, decyzja });
    if (wyniki.length % 20 === 0) console.error(`cases ${wyniki.length}/${Math.min(etykiety.length, LIMIT)}, Jev requests ${licznik.zapytan}, from cache ${licznik.z_pamieci}`);
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
writeFileSync(WYJSCIE, wyniki.map((x) => JSON.stringify(x)).join('\n') + (wyniki.length ? '\n' : ''));
const ms = [...licznik.ms].sort((a, b) => a - b);
console.log(JSON.stringify({
  wyjscie: WYJSCIE, skrypty: SKRYPTY, przypadkow: wyniki.length, pominietych_wierszy_etykiet: pominiete, bledow: wyniki.filter((x) => x.blad).length,
  koncow_tury: konce.size, zapytan_jeva: licznik.zapytan, z_pamieci: licznik.z_pamieci, degraded: licznik.degraded, ms_mediana: ms.length ? ms[Math.floor(ms.length / 2)] : null,
  paczka_z_tekstem: wyniki.filter((x) => x.paczka?.tekst_agenta_znakow > 0).length, koniec_z_tekstem: wyniki.filter((x) => x.koniec?.tekst_agenta_znakow > 0).length,
}));
