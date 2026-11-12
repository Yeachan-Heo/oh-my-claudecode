// omc-lokalne A3: the Jev panel (stage 4 of the Jev task-list plan). Category: 2. arithmetic (call and error counters) and 4. input for Jev;
// the judgement is Jev's. A module, not a hook entry: one process per batch (review M3), so the PostToolBatch entry jev-lista-paczka.mjs and the
// PostToolUseFailure entry jev-panel-blad.mjs call runPanel(data). PostToolBatch: a query at most once per PANEL_EVERY tool calls of one task and
// when the task in progress changes; PostToolUseFailure: a query after the second tool error in a row (an interrupt is not an error). One query
// asks yes/no questions (osobna-sesja only in the main thread, deleguj only for an agent with the Agent tool) through the script resolver
// (jev-resolve.mjs via recordJevShadow) at point `panel`, which is off unless OMC_JEV names it (panel:shadow or panel:active; `all:active` does
// not turn it on). shadow: the resolver records the answers in shadow.jsonl, no hint. active: a hint for each "yes" from THRESHOLD, each hint at
// most once per task; a question whose hint was given in the task is not asked again (review M1). Nothing is blocked (decision 6).
// Switches: OMC_SKIP_HOOKS=jev-panel turns off the panel alone; turning off the lists (OMC_SKIP_HOOKS=jev-lista, DISABLE_OMC) turns off the
// panel too, because the panel reads the task in progress from them (review L10). Own row per query in panel.jsonl (log directory).
// OMC_JEV_PANEL_PYTANIA (owner, 10.11.2026) sets the mode of each question (questionModes in jev-panel-wejscie.mjs): off questions are not sent,
// shadow questions are sent and logged without a hint; every question this agent can be asked off ends the hook before the panel state and
// the resolver (review rec-A2b-panel L3). A bad entry of the variable is reported once, only when a query is due: on stderr and in the field
// pytania_ostrzezenia of the panel.jsonl row (review rec-A2b-panel L1, L2).

import { existsSync } from 'node:fs';
import { MAIN, agentKey, logRow, skipped, typeTools } from './lib/jev-lista.mjs';

export const PANEL_NAMED = /(?:^|,)\s*panel\s*(?::[^,]*)?(?:,|$)/; // the point is off unless named (OPT_IN_POINTS); parseJevEnv decides the mode
const PANEL_OFF = /(?:^|,)\s*panel\s*:\s*off\s*(?:,|$)/i;
export const PANEL_TIMEOUT_MS = 2000; // ceiling of OMC_JEV_TIMEOUT_MS for the panel's resolver process (review M3)

const hookMs = () => Math.round(process.uptime() * 1000);

// Steps shared by both versions (review rec-panel-v2 L12). The head of a panel.jsonl row (version 2 adds wersja: 2).
function rowHead(event, data, key, warnings, version = null) {
  return { zdarzenie: event, ...(version ? { wersja: version } : {}), session_id: data.session_id, agent: key, agent_id: typeof data.agent_id === 'string' ? data.agent_id.slice(0, 120) : null, agent_type: data.agent_type ?? null, ...(warnings.length ? { pytania_ostrzezenia: warnings } : {}) };
}
// review L2: the warnings once, with a query due; the warning about OMC_JEV_PANEL_WERSJA (review rec-panel-v2 L8) carries its own name
function printWarnings(warnings, versionWarning = null) {
  for (const warning of warnings) {
    process.stderr.write(warning === versionWarning ? `[jev-panel] ${warning}\n` : `[jev-panel] OMC_JEV_PANEL_PYTANIA: ${warning}, pominięte\n`);
  }
}
// review M2: an open breaker (all points, or the panel's own) means no state for Jev and no resolver process
async function breakerOpen(P, env) {
  return (await import('./lib/jev-panel-shadow.mjs')).panelBreakerOpen(env, P.PANEL_POINT);
}
// review M3: the resolver process of the panel never waits longer than PANEL_TIMEOUT_MS (it reads process.env); the end of a turn
// passes its own, shorter ceiling (review rec-panel-v3 H1)
function capTimeout(env, ceiling = PANEL_TIMEOUT_MS) {
  const timeout = String(Math.min(Number(env.OMC_JEV_TIMEOUT_MS) > 0 ? Number(env.OMC_JEV_TIMEOUT_MS) : ceiling, ceiling));
  process.env.OMC_JEV_TIMEOUT_MS = timeout;
  env.OMC_JEV_TIMEOUT_MS = timeout;
  return timeout;
}

// The window of Jev (T2 measured it: JEV_WINDOW_CHARS characters of the request body, the API refuses more with 400 max_tokens_exceeded and a
// refused query is a query without an answer): a state over it is shortened by the function of T2 (the longest strings to one common length,
// their beginnings stay) and what was cut is counted (uciete_znaki), never silent. { state, cut }.
async function fitToWindow(state, questions, env) {
  try {
    const R = await import('./jev-resolve.mjs');
    if (typeof R.fitStateToWindow !== 'function') return { state, cut: 0 };
    const rest = JSON.stringify({ state: null, questions: R.serializeQuestions(questions), model: 'jev-latest' }).length;
    const fitted = R.fitStateToWindow(state, Math.max(1000, R.resolveWindowChars(env) - rest));
    return { state: fitted.state, cut: fitted.cut };
  } catch { return { state, cut: 0 }; }
}

// The query after a batch in as many parts as the window of Jev needs (rec-D F3: consecutive queries with the same questions, nothing left out): the
// calls of the journal are split into consecutive groups (oldest first), every part carries the whole rest of the state and the same questions
// (`czesc_wywolan`: "2 z 3"). The answers are merged: a yes/no question is the largest probability of any part (a part that sees the problem is
// enough), a choice question the part where the target (zrodlo, poboczne) is the answer with the highest probability, else the most confident
// part; `pokaz` and `przypomnienie` come from the last part (it holds the newest calls). A single call longer than the window is shortened by the
// window function and counted. Returns { result (merged, for jevAnswerOf), last (the last real result), cut, parts, ms }.
export async function askInParts(P, shadowLib, data, env, sent, questions) {
  let R = null;
  try { R = await import('./jev-resolve.mjs'); } catch { R = null; }
  const size = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8'); // the window of Jev is counted in bytes of the body (T2)
  const rest = size({ state: null, questions: R?.serializeQuestions ? R.serializeQuestions(questions) : questions, model: 'jev-latest' });
  const window = Math.max(1000, (R?.resolveWindowChars ? R.resolveWindowChars(env) : 56000) - rest);
  const calls = Array.isArray(sent.ostatnie_wywolania) ? sent.ostatnie_wywolania : [];
  const states = [sent];
  if (size(sent) > window && calls.length >= 1) {
    const { ostatnie_wywolania: _calls, ...others } = sent;
    const room = Math.max(1000, window - size({ ...others, ostatnie_wywolania: [], czesc_wywolan: '99 z 99' }));
    // a single call (its result, input or error) larger than a part is itself split: the longest field goes in consecutive slices, one per part
    // (`fragment: "wynik 2 z 3"`), the first slice with the rest of the call (rec-D F3: the content is divided over queries, not cut)
    const pieces = (call) => {
      if (size(call) <= room) return [call];
      const field = ['wynik', 'wejscie', 'blad'].filter((f) => typeof call[f] === 'string' && call[f].length).sort((a, b) => call[b].length - call[a].length)[0];
      if (!field) return [call];
      const text = call[field];
      const perChar = Math.max(1, size(text) / text.length);
      const chars = Math.max(500, Math.floor((room - size({ ...call, [field]: '' }) - 120) / perChar));
      if (text.length <= chars) return [call];
      const total = Math.ceil(text.length / chars);
      return Array.from({ length: total }, (_, i) => ({ ...(i === 0 ? call : { narzedzie: call.narzedzie }), [field]: text.slice(i * chars, (i + 1) * chars), fragment: `${field} ${i + 1} z ${total}` }));
    };
    const chunks = [];
    let chunk = [];
    let used = 0;
    for (const call of calls.flatMap(pieces)) {
      const n = size(call) + 1;
      if (chunk.length && used + n > room) { chunks.push(chunk); chunk = []; used = 0; }
      chunk.push(call);
      used += n;
    }
    if (chunk.length) chunks.push(chunk);
    states.length = 0;
    chunks.forEach((part, i) => states.push({ ...others, ostatnie_wywolania: part, ...(chunks.length > 1 ? { czesc_wywolan: `${i + 1} z ${chunks.length}` } : {}) }));
  }
  let cut = 0;
  let ms = 0;
  const results = [];
  for (const state of states) {
    const fitted = await fitToWindow(state, questions, env);
    cut += fitted.cut;
    const started = Date.now();
    results.push(await shadowLib.recordJevShadow({ point: P.PANEL_POINT, state: fitted.state, questions, heuristic: null, permissionMode: data.permission_mode })); // await: the replay tool sends asynchronously
    ms += Date.now() - started;
  }
  const active = results.filter((r) => r?.mode === 'active');
  const last = results.at(-1);
  if (results.length === 1) return { result: last, last, cut, parts: 1, ms };
  const answers = {};
  for (const name of Object.keys(questions)) {
    const given = active.map((r) => shadowLib.jevAnswerOf(r, name)).filter(Boolean);
    if (!given.length) continue;
    if (name === 'pokaz' || name === 'przypomnienie') { answers[name] = shadowLib.jevAnswerOf(active.at(-1), name) ?? given.at(-1); continue; }
    if (given[0].type === 'choice' || typeof given[0].choice === 'string') {
      const target = P.CHOICE_TARGET[name];
      const prob = (a) => (typeof a.probabilities?.[target] === 'number' ? a.probabilities[target] : a.choice === target ? (a.confidence ?? 1) : 0);
      const hits = target ? given.filter((a) => a.choice === target) : [];
      answers[name] = hits.length ? hits.reduce((b, a) => (prob(a) > prob(b) ? a : b)) : given.reduce((b, a) => ((a.confidence ?? 0) > (b.confidence ?? 0) ? a : b));
      continue;
    }
    const value = (a) => (typeof a.noul === 'boolean' ? (a.noul ? 1 : 0) : Number.isFinite(a.noul) ? a.noul : -1);
    answers[name] = given.reduce((b, a) => (value(a) > value(b) ? a : b));
  }
  return { result: { mode: active.length ? 'active' : (last?.mode ?? 'degraded'), answers }, last, cut, parts: states.length, ms };
}

// The longest the resolver waits for the point (its own ceiling, POINT_MAX_TIMEOUT_MS of jev-resolve.mjs, can be below the term asked for).
async function effectiveLimit(asked) {
  try { return Math.min(Number(asked), (await import('./jev-resolve.mjs')).POINT_MAX_TIMEOUT_MS?.[ 'panel' ] ?? Infinity); } catch { return Number(asked); }
}

// A swallowed failure leaves a row (name and message of the error only, no content), so a silent panel can be told from a broken one.
function logFailure(data, env, error, where = 'hook') {
  try {
    logRow('panel.jsonl', { zdarzenie: data?.hook_event_name ?? null, wejscie: 4, session_id: typeof data?.session_id === 'string' ? data.session_id : null, wynik: 'wyjatek', gdzie: where, blad: `${error?.name ?? 'Error'}: ${String(error?.message ?? error).slice(0, 160)}`, ms_hook: hookMs() }, env);
  } catch { /* the log never breaks the hook */ }
}

// The hint text for one hook call ('' when none). Never throws.
export async function runPanel(data, env = process.env) {
  try {
    const named = String(env.OMC_JEV ?? '');
    if (skipped('jev-panel', env) || !PANEL_NAMED.test(named) || PANEL_OFF.test(named) || !env.TYPESAFE_API_KEY) return '';
    const event = data?.hook_event_name;
    const end = event === 'Stop' || event === 'SubagentStop'; // panel-v3: the end of a turn, asked by version 2 only
    if (!data || typeof data.session_id !== 'string' || (event !== 'PostToolBatch' && event !== 'PostToolUseFailure' && !end)) return '';
    // review rec-panel-v3 M3: a subagent's end without its id would be judged as the main thread's text
    if (event === 'SubagentStop' && (typeof data.agent_id !== 'string' || !data.agent_id)) return '';
    const key = agentKey(data); // the same key as panelState and the panel state file (review L3)
    const main = key === MAIN;
    // review M4: an agent type without the list tool gets no panel, a type without the Agent tool no question deleguj
    const tools = main ? { lista: true, agent: true } : typeTools(data.agent_type, data.cwd, env);
    const P = await import('./lib/jev-panel-wejscie.mjs');
    if (!tools.lista && !P.panelV2(env)) return ''; // version 1 needs the list; version 2 supervises every agent (a type without the list tool is not asked about the list)
    if (P.panelV2(env)) return end ? await runEndOfTurn(P, data, env, { event, key, main }) : await runPanelV2(P, data, env, { event, key, main, tools }); // end of a turn: T3's query, no supervision questions (plan 15.1) // OMC_JEV_PANEL_WERSJA=2; without it nothing below changes
    if (end) return '';
    const perQuestion = P.questionModes(env);
    const versionWarning = P.panelVersionWarning(env);
    const warnings = versionWarning ? [...perQuestion.warnings, versionWarning] : perQuestion.warnings;
    const askable = Object.keys(P.panelQuestions(main, tools.agent !== false)); // review L3: only the questions this agent can be asked
    if (askable.every((name) => perQuestion.modes[name] === 'off')) return '';
    const { task } = P.currentTask(data.session_id, key, env);
    let reason = null;
    let journal = [];
    const state = P.updatePanelState(data.session_id, key, (st) => {
      const step = P.advance(st, event, data, task);
      reason = step.reason;
      journal = step.journal;
      return step.state;
    }, env);
    const row = rowHead(event, data, key, warnings);
    if (!state) {
      logRow('panel.jsonl', { ...row, wynik: 'stan-niezapisany', ms_hook: hookMs() }, env);
      return '';
    }
    if (!reason) return '';
    printWarnings(warnings, versionWarning);
    // the hint brake key: without prompt_id on this event (it is optional) the last id kept in the panel state
    const brake = P.taskKey(data, task, typeof state.prompt_id === 'string' ? state.prompt_id : '');
    if (await breakerOpen(P, env)) {
      logRow('panel.jsonl', { ...row, powod: reason, wynik: 'bezpiecznik', ms_hook: hookMs() }, env);
      return '';
    }
    const given = P.givenFor(state, brake);
    const questions = Object.fromEntries(Object.entries(P.panelQuestions(main, tools.agent !== false)).filter(([name]) => !given.has(name) && perQuestion.modes[name] !== 'off'));
    if (!Object.keys(questions).length) return '';
    const shadowLib = await import('./lib/jev-panel-shadow.mjs');
    const mode = shadowLib.jevModeFor(P.PANEL_POINT, env, data.permission_mode);
    if (mode === 'off') return '';
    const timeout = capTimeout(env);

    await shadowLib.setJevHookContext(data);
    const { state: jevState, transcript } = P.panelState(data, journal, reason, env);
    const started = Date.now();
    const result = shadowLib.recordJevShadow({ point: P.PANEL_POINT, state: jevState, questions, heuristic: null, permissionMode: data.permission_mode });
    const ms = Date.now() - started;
    let yes = [];
    const noul = {};
    if (mode === 'active') {
      for (const name of Object.keys(questions)) {
        const p = shadowLib.jevNoulOf(result, name);
        noul[name] = p ?? null;
        if (typeof p === 'number' && p >= P.THRESHOLD && perQuestion.modes[name] === 'active') yes.push(name); // a shadow question: answer logged, no hint
      }
    }
    // review L4: the brake must be saved before a hint goes out; without it the hint could repeat in the task, so none is given
    let saved = null;
    if (yes.length) {
      saved = Boolean(P.updatePanelState(data.session_id, key, (st) => P.markGiven(st, brake, yes), env));
      if (!saved) yes = [];
    }
    logRow('panel.jsonl', {
      ...row, tryb: mode, powod: reason, transkrypt: transcript, transkrypt_jest: Boolean(transcript && existsSync(transcript)),
      tekst_agenta_znakow: jevState.tekst_agenta.length, polecenie_znakow: jevState.polecenie?.length ?? 0, pytania: Object.keys(questions),
      ...(perQuestion.set ? { pytania_tryb: Object.fromEntries(Object.keys(P.panelQuestions(main, tools.agent !== false)).filter((name) => !given.has(name)).map((name) => [name, perQuestion.modes[name] === 'off' || mode === 'active' ? perQuestion.modes[name] : mode])) } : {}), // effective mode: never more active than the panel
      wynik: mode === 'active' ? (result?.mode ?? 'brak') : 'shadow', noul: mode === 'active' ? noul : undefined, podpowiedzi: yes,
      ...(saved === false ? { zapis_podanych: false } : {}), limit_ms: Number(timeout), ms, ms_hook: hookMs(),
    }, env);
    if (!yes.length) return '';
    shadowLib.recordJevApplied(result, P.PANEL_POINT, { powod: reason, podpowiedzi: yes, noul });
    return `Panel Jeva: ${yes.map((name) => P.panelHint(name, main)).join(' ')}`;
  } catch (error) {
    logFailure(data, env, error);
    return '';
  }
}

// Version 2 of the panel (OMC_JEV_PANEL_WERSJA=2): the same switches, state files, breaker and log as version 1; the differences are in
// jev-panel-wejscie.mjs (signals, questions, answers, hints). A row of panel.jsonl carries wersja: 2, the signals and, for shadow
// questions, the hints that would have gone out (`bylyby`); `p` holds per question the probability of a yes (yes/no questions) or of the
// target answer (choice questions, review rec-panel-v2 L13), `ms_wejscie` the time of building the state for Jev (review L2). A query
// from errors holds a lease in the panel state (advance), released here in any case (M1).
// Panel input 4 (rows carry wejscie: 4; rule "the maximum of Jev", "Jev is the supervisor
// during the work"): the query after a batch of tools is where Jev supervises, in the main thread and in every agent. The code counts
// signals and gives Jev the whole input; Jev decides. All six questions are asked in every query (no gate; the gates of version 2 are
// numbers in `sygnaly`), every one is active unless OMC_JEV_PANEL_PYTANIA says otherwise (F7), an answer is read without a threshold (F8),
// and one more choice question (`pokaz`) lets Jev pick the one hint to show, or none, knowing the hints given in the task and what followed
// (F20, point 16; no brake "once per task" in code). The reminder of the list (start, step, note) is the question `przypomnienie` of
// jev-zadania.mjs (T5): its signals are in the state, its answer is stored for the hook of the batch to deliver once. The text of the
// agent goes whole (each text up to FIELD_MAX), with the newest earlier text; what is cut anywhere is counted in `uciete_znaki`, and
// `wejscie_pelne` is true when nothing was. The rule of the note (a task in progress without a note after PANEL_EVERY calls) is only the
// reserve K3: it hints when the question `notka` was sent and Jev gave no answer (`kto: k3` in the row). If an answer of Jev carries a
// `text` (`uwaga`), that sentence is the hint; the fixed text otherwise.
async function runPanelV2(P, data, env, { event, key, main, tools }) {
  const delegate = tools.agent !== false;
  const perQuestion = P.questionModes(env, true);
  // an agent type without the list tool is supervised too, but not asked about the list (it has none to be out of date)
  const names = P.askableV2().filter((name) => tools.lista || (name !== 'zrobione' && name !== 'notka'));
  if (names.every((name) => perQuestion.modes[name] === 'off')) return '';
  const current = P.currentTask(data.session_id, key, env);
  const { task, note } = current;
  let reason = null;
  let journal = [];
  let flags = [];
  let since = 0;
  const state = P.updatePanelState(data.session_id, key, (st) => {
    const step = P.advance(st, event, data, task, true, Date.now(), P.listSignature(current));
    reason = step.reason;
    journal = step.journal;
    flags = step.flags;
    since = step.since ?? 0;
    return step.state;
  }, env);
  const row = rowHead(event, data, key, perQuestion.warnings, 2);
  if (!state) {
    logRow('panel.jsonl', { ...row, wynik: 'stan-niezapisany', ms_hook: hookMs() }, env);
    return '';
  }
  if (!reason) return '';
  let leased = reason === 'blad';
  try {
    printWarnings(perQuestion.warnings);
    const brake = P.taskKeyV2(data, task, typeof state.prompt_id === 'string' ? state.prompt_id : '');
    if (await breakerOpen(P, env)) {
      logRow('panel.jsonl', { ...row, powod: reason, wynik: 'bezpiecznik', ms_hook: hookMs() }, env);
      return '';
    }
    const shadowLib = await import('./lib/jev-panel-shadow.mjs');
    const mode = shadowLib.jevModeFor(P.PANEL_POINT, env, data.permission_mode);
    if (mode === 'off') return '';
    const open = (name) => perQuestion.modes[name] !== 'off';
    const mark = P.textMark(state);
    const building = Date.now();
    const sig0 = P.panelSignals(flags, task, note, reason, main, delegate, false);
    const built = P.panelStateV2(data, journal, reason, env, current, mark, false, { sig: sig0, st: state, since, brake });
    const msInput = Date.now() - building;
    const textChars = built.state.tekst_agenta.reduce((sum, text) => sum + text.length, 0);
    const sig = { ...sig0, text: built.state.sygnaly?.nowy_tekst === true };
    const all = P.panelQuestionsV2(sig);
    const asked = names.filter(open);
    const offered = asked.filter((name) => perQuestion.modes[name] === 'active' && (name !== 'deleguj' || delegate)); // the hints Jev may pick from
    const questions = {};
    for (const name of asked) questions[name] = all[name];
    if (offered.length && mode === 'active') questions.pokaz = P.pokazQuestion(offered);
    const sent = built.state;
    // the reminder of the list (T5): the signals and the question of jev-zadania.mjs; absent without the library or for a type without the list tool
    let Z = null;
    try {
      Z = await import('./lib/jev-zadania.mjs');
      const zad = Z.zadaniaDoZapytania(data.session_id, key, env, { razem: Number.isInteger(state.razem) ? state.razem : null });
      if (zad.questions.przypomnienie) { questions.przypomnienie = zad.questions.przypomnienie; sent.przypomnienie = P.maskDeep(zad.state.przypomnienie); }
    } catch (error) { Z = null; logFailure(data, env, error, 'jev-zadania'); }
    const timeout = capTimeout(env, PANEL_TIMEOUT_MS);
    if (!env.OMC_JEV_EXCERPT_CHARS_PANEL) { process.env.OMC_JEV_EXCERPT_CHARS_PANEL = String(P.FIELD_MAX + 1000); env.OMC_JEV_EXCERPT_CHARS_PANEL = String(P.FIELD_MAX + 1000); } // the resolver bounds every string of the state; the state is whole
    await shadowLib.setJevHookContext(data);

    const asking = await askInParts(P, shadowLib, data, env, sent, questions);
    const { result, ms } = asking;
    built.cut += asking.cut;
    // the texts count as sent once the query is (shadow does not wait for the answer)
    const textTo = mode !== 'active' || result?.mode === 'active' ? built.textTo : null; // every question reads the text, so a query from errors uses it too
    const p = {};
    const wybor = {};
    const yes = [];
    let pokaz = null;
    let pokazAnswer = null;
    let reminder = null;
    if (mode === 'active') {
      for (const name of asked) {
        const answer = P.panelAnswerV2(name, shadowLib.jevAnswerOf(result, name));
        p[name] = answer.p;
        if (answer.choice !== undefined) wybor[name] = answer.choice;
        if (answer.yes) yes.push(name);
      }
      if (questions.pokaz) { pokazAnswer = shadowLib.jevAnswerOf(result, 'pokaz'); pokaz = P.pokazChoice(pokazAnswer, offered); }
      if (Z && questions.przypomnienie) {
        const counter = (await import('./lib/jev-lista.mjs')).readCounter(data.session_id, key, env) ?? {};
        reminder = Z.przypomnienieZOdpowiedzi(key, shadowLib.jevAnswerOf(result, 'przypomnienie'), counter);
        if (reminder) Z.zapiszPrzypomnienie(data.session_id, key, { rodzaj: reminder.rodzaj, tekst: reminder.tekst, nr_tury: Number.isInteger(state.razem) ? state.razem : null, kto: 'jev' }, env);
      }
    }
    // the reminder of the list Jev chose (T5) goes out in this batch, once, and then it is the one voice of the batch (a hint of the panel waits)
    let reminderText = '';
    if (reminder && Z) {
      try { reminderText = Z.odbierzPrzypomnienie(data.session_id, key, (await import('./lib/jev-lista.mjs')).todoHintMode(), { agent_type: data.agent_type ?? null, prompt_id: data.prompt_id ?? null }, env); } catch (error) { logFailure(data, env, error, 'przypomnienie'); }
    }
    const yesActive = yes.filter((name) => perQuestion.modes[name] === 'active');
    const would = yes.filter((name) => perQuestion.modes[name] !== 'active');
    // Jev picks the hint among his own yeses; "zadna" or no yes means none (his "zadna" stays a block). When `pokaz` names a question that is not among
    // his own yeses (measured by T3: `pokaz` named `zrodlo` in 32 of 46 such answers), his own numbers settle the contradiction: the most probable yes goes
    // and the row says so (`pokaz_sprzeczny`, `pokaz_wybor`, `pokaz_zrodlo`), so it can be counted; without any answer to `pokaz` the same, with kto k3.
    let pick = null;
    let kto = 'jev';
    let pokazSprzeczny = null;
    if (yesActive.length && pokaz !== 'zadna') {
      const best = yesActive.reduce((top, name) => ((p[name] ?? 0) > (p[top] ?? 0) ? name : top));
      if (pokaz && yesActive.includes(pokaz)) pick = pokaz;
      else if (!pokazAnswer || typeof pokazAnswer.choice !== 'string') { pick = best; kto = 'k3'; }
      else { pick = best; pokazSprzeczny = pokazAnswer.choice.slice(0, 40); }
    }
    // K3 (plan 1, zasada nr 1): the reserve of the question `notka` when it was sent and Jev did not answer it
    const rules = [];
    if (!pick && pokaz !== 'zadna' && mode === 'active' && offered.includes('notka') && p.notka === null && P.noteRule(sig)) { pick = 'notka'; kto = 'k3'; rules.push('notka'); }
    const facts = { stale: sent.sygnaly?.wywolan_bez_zmiany_listy ?? 0, noNote: !note, delegate };
    const uwaga = pick && pick === pokaz && typeof pokazAnswer?.text === 'string' ? P.cleanText(pokazAnswer.text).replace(/\s+/g, ' ').trim() : '';
    const hintText = pick ? (uwaga || P.panelHintV2(pick, main, task, facts)) : '';
    const hint = reminderText && (pick === 'zrobione' || pick === 'notka') ? '' : hintText; // one voice about the list: the reminder first; a hint of another topic (slop, utknal...) goes with it
    let saved = null;
    const moved = P.markMoves(textTo, mark);
    if (hint || moved) {
      // the hint given (history), the text mark and the lease released in one write; without the write no hint goes out (review L4) and the mark stays
      const written = Boolean(P.updatePanelState(data.session_id, key, (st) => {
        let next = !moved ? st : P.markTexts(st, textTo);
        if (hint) next = P.markHistory(next, brake, [pick]);
        return leased ? P.releaseErrorQuery(next) : next;
      }, env));
      if (hint) saved = written;
      if (written) leased = false;
    }
    const delivered = Boolean(hint) && saved !== false;
    // the former point slop-warning: Jev's answer of the question `slop` is recorded under that point with the source (comparable with the rows of the
    // time when pre-tool-enforcer asked about every call); the warning itself goes the way of every hint (the choice `pokaz`), after the calls were made
    if (mode === 'active' && yesActive.includes('slop')) {
      const shown = delivered && pick === 'slop';
      shadowLib.recordJevApplied(asking.last, 'slop-warning', {
        zrodlo: 'zapytanie-po-paczce', question: 'slop_advisory', kto, noul: p.slop, tool: journal.map((e) => e.narzedzie).find((n) => /^(?:Write|Edit|NotebookEdit|Bash|PowerShell)$/.test(n)) ?? journal.at(-1)?.narzedzie ?? null,
        narzedzia: journal.map((e) => e.narzedzie), tool_use_ids: (Array.isArray(data.tool_calls) ? data.tool_calls : []).map((c) => c?.tool_use_id).filter(Boolean),
        pokaz: pokaz ?? null, pokazano: shown, ...(shown ? {} : { powod_niepokazania: pokaz === 'zadna' ? 'zadna' : pick && pick !== 'slop' ? `wybrano-${pick}` : reminderText ? 'przypomnienie-listy' : 'brak-wyboru' }), warning: { from: null, to: shown },
      });
    }
    const empty = ['polecenia', 'lista', 'zadanie_w_toku', 'notka', 'ostatnie_wywolania', 'tekst_agenta', 'tekst_poprzedni'].filter((field) => {
      const value = built.state[field];
      return value === null || value === undefined || (Array.isArray(value) && !value.length);
    });
    logRow('panel.jsonl', {
      ...row, wejscie: 4, tryb: mode, powod: reason, transkrypt: built.transcript, transkrypt_jest: Boolean(built.transcript && existsSync(built.transcript)),
      tekst_agenta_znakow: textChars, tekst_poprzedni_znakow: built.state.tekst_poprzedni?.length ?? 0, ...(built.textLeft ? { tekst_czeka: built.textLeft } : {}), ...(built.textOld ? { tekst_stare: built.textOld } : {}),
      polecenie_znakow: (built.state.polecenia ?? []).reduce((sum, text) => sum + text.length, 0), wejscie_pelne: built.cut === 0, uciete_znaki: built.cut, pola_puste: empty, maska_miejsc: built.maskPlaces,
      sygnaly: { bledy: sig.errors, zapis: sig.writes, odczyty: sig.readRun, zadanie: sig.task, notka: sig.note, tekst: sig.text, ...built.state.sygnaly },
      pytania: asked, reguly: rules, kto,
      pytania_tryb: Object.fromEntries(asked.map((name) => [name, mode === 'active' ? perQuestion.modes[name] : mode])),
      wynik: mode === 'active' ? (result?.mode ?? 'brak') : 'shadow', p: mode === 'active' ? p : undefined, ...(pokaz ? { pokaz } : {}), ...(pokazSprzeczny ? { pokaz_sprzeczny: true, pokaz_wybor: pokazSprzeczny, pokaz_zrodlo: 'najwyzsze-p-z-tak' } : {}), ...(uwaga ? { uwaga } : {}),
      ...(questions.przypomnienie ? { przypomnienie: reminder ? reminder.rodzaj : mode === 'active' ? 'zadne' : null } : {}),
      ...(Object.keys(wybor).length ? { wybor } : {}), podpowiedzi: delivered ? [pick] : [], ...(pick && !delivered ? { czeka: pick } : {}), ...(would.length ? { bylyby: would } : {}),
      ...(reminderText ? { przypomnienie_dostarczone: true } : {}),
      ...(saved === false ? { zapis_podanych: false } : {}), limit_ms: await effectiveLimit(timeout), limit_zadany_ms: Number(timeout), ms, ...(asking.parts > 1 ? { zapytan: asking.parts } : {}), ms_wejscie: msInput, ms_hook: hookMs(),
    }, env);
    if (!delivered) return reminderText;
    const withReminder = (text) => (reminderText ? `${reminderText}\n${text}` : text);
    // review L10: a hint of a rule alone (no query) gets its applied.jsonl row too
    shadowLib.recordJevApplied(asking.last, P.PANEL_POINT, { powod: reason, podpowiedzi: [pick], p, ...(rules.length ? { reguly: rules } : {}) });
    return withReminder(`Panel Jeva: ${hint}`);
  } finally {
    if (leased) P.updatePanelState(data.session_id, key, (st) => P.releaseErrorQuery(st), env);
  }
}

// The end of a turn (Stop, SubagentStop through jev-panel-koniec.mjs): the one query of T3 (lib/jev-koniec-tury.mjs): the moment of a compaction (main thread) and the state of the tasks (jev-zadania.mjs,
// T5). No supervision questions here (what helps an agent work is asked after a batch, never at the end of a turn). The answers
// go to the file of the end of a turn; the verdicts of the tasks to the store of the lists. Never throws; the file never stays at w_toku.
async function runEndOfTurn(P, data, env, { key, main }) {
  if (data.stop_hook_active === true) return ''; // review rec-panel-v3 H2: a stop another hook has just blocked does not end the turn
  let K;
  try { K = await import('./lib/jev-koniec-tury.mjs'); } catch { return ''; }
  const E = K.beginEnd(P, data, env, { key, main });
  if (!E) return '';
  try {
    if (await breakerOpen(P, env)) {
      logRow('panel.jsonl', { zdarzenie: data.hook_event_name, wersja: 2, session_id: data.session_id, agent: key, powod: P.END_REASON, wynik: 'bezpiecznik', ms_hook: hookMs() }, env);
      E.skip('bezpiecznik', 'bezpiecznik', true);
      return '';
    }
    const shadowLib = await import('./lib/jev-panel-shadow.mjs');
    const mode = shadowLib.jevModeFor(P.PANEL_POINT, env, data.permission_mode);
    if (mode === 'off') { E.skip('bez-pytan', 'tryb_off'); return ''; }
    let Z = null;
    let zad = { state: {}, questions: {} };
    try {
      Z = await import('./lib/jev-zadania.mjs');
      zad = Z.zadaniaDoZapytania(data.session_id, key, env, { bezHistorii: true }); // the reminder is not asked at the end of a turn
    } catch { Z = null; }
    const { przypomnienie: _later, ...tasksQuestions } = zad.questions; // the reminder is asked after a batch
    const { przypomnienie: _signals, ...tasksState } = zad.state;
    // the closing report of an agent without a task (its SubagentStop left it in its file) goes with the entry: with the report Jev can tell which task it served
    for (const a of tasksState.agenci_bez_zadania ?? []) {
      const reported = K.readKoniec(data.session_id, a.agent, env);
      if (typeof reported?.raport === 'string' && reported.raport) a.raport = reported.raport;
      const q = tasksQuestions[`przypisz_${a.agent}`];
      if (q && a.raport) q.instructions = `${q.instructions} Raport końcowy agenta jest w polu raport tego wpisu.`;
    }
    // the state of the tasks is the notes and the briefs of agents: every string through the mask (K2) before it goes to Jev
    const base = P.maskDeep(tasksState);
    // a subagent has no `odpowiedz` of T3 (main thread only): its closing report is the same field
    if (!main && typeof data.last_assistant_message === 'string') {
      base.odpowiedz = P.cleanText(data.last_assistant_message);
      E.record.raport = P.boundField(base.odpowiedz).text; // the closing report in the file of this agent: the main thread's query reads it to assign the agent to a task (jev-zadania.mjs, field raport)
    }
    // The query goes in parts when the state of the tasks does not fit the window of Jev (rec-D F3: consecutive queries, nothing left out; the split of T5);
    // the moment (T3) goes with the first part. A part that still does not fit is shortened by the window function and the cut is counted.
    let parts = [{ state: base, questions: { ...tasksQuestions } }];
    try { if (Z && typeof Z.podzielZapytanie === 'function') parts = Z.podzielZapytanie(parts[0]); } catch (error) { logFailure(data, env, error, 'podzial-zapytania'); }
    if (base.odpowiedz !== undefined) for (const part of parts) part.state.odpowiedz = base.odpowiedz;
    parts[0] = E.attach(parts[0].state, parts[0].questions);
    const askedNames = parts.flatMap((part) => Object.keys(part.questions));
    if (!askedNames.length) { E.skip('bez-pytan', 'nic_do_pytania'); return ''; }
    const endTerm = Number(env.OMC_JEV_KONIEC_TERMIN_MS) > 0 ? Number(env.OMC_JEV_KONIEC_TERMIN_MS) : K.END_QUERY_MS;
    capTimeout(env, endTerm);
    if (!env.OMC_JEV_EXCERPT_CHARS_PANEL) { process.env.OMC_JEV_EXCERPT_CHARS_PANEL = String(P.FIELD_MAX + 1000); env.OMC_JEV_EXCERPT_CHARS_PANEL = String(P.FIELD_MAX + 1000); }
    await shadowLib.setJevHookContext(data);
    const answers = {};
    let cutChars = 0;
    let masked = 0;
    let ms = 0;
    let firstResult = null;
    let allAnswered = true;
    for (const part of parts) {
      if (!Object.keys(part.questions).length) continue;
      if (typeof part.state.odpowiedz === 'string') { const b = P.boundField(part.state.odpowiedz); part.state.odpowiedz = b.text; cutChars += b.cut; } // the same cut as every other text of the panel, counted
      const fitted = await fitToWindow(part.state, part.questions, env);
      cutChars += fitted.cut;
      masked += (JSON.stringify(fitted.state).match(/\[linia pominięta: ścieżka z sekretami\]|\[pominięte: ścieżka z sekretami\]/g) || []).length;
      const started = Date.now();
      const result = shadowLib.recordJevShadow({ point: P.PANEL_POINT, state: fitted.state, questions: part.questions, heuristic: null, permissionMode: data.permission_mode });
      ms += Date.now() - started;
      firstResult ??= result;
      if (result?.mode !== 'active') allAnswered = false;
      for (const name of Object.keys(part.questions)) answers[name] = shadowLib.jevAnswerOf(result, name);
    }
    E.record.uciete_znaki = cutChars; // T3 counted against the default cap of the resolver; the query is whole up to FIELD_MAX (the cap is raised above)
    E.record.wejscie_pelne = cutChars === 0;
    E.record.maska_miejsc = masked;
    E.done({ answer: answers.moment, mode, got: firstResult?.mode, ms });
    try {
      if (Z && mode === 'active') {
        const verdict = allAnswered
          ? Z.ocenaZOdpowiedzi(data.session_id, key, Object.fromEntries(Object.entries(answers).filter(([name]) => name !== 'moment')), { nr_tury: E.record.nr_tury, kto: 'jev', stan: base.zadania }, env)
          : Z.ocenaRezerwowa(data.session_id, key, { nr_tury: E.record.nr_tury }, env); // K3: the query went out and Jev did not answer
        E.record.ocena_jeva = verdict;
        Z.zapiszOceny(data.session_id, key, verdict, {}, env);
      }
    } catch (error) { logFailure(data, env, error, 'ocena-zadan'); } // the moment is already answered; a failure of the verdicts must not turn it into K3
    logRow('panel.jsonl', {
      zdarzenie: data.hook_event_name, wersja: 2, wejscie: 4, session_id: data.session_id, agent: key, agent_id: typeof data.agent_id === 'string' ? data.agent_id.slice(0, 120) : null, agent_type: data.agent_type ?? null,
      tryb: mode, powod: P.END_REASON, pytania: askedNames, zapytan: parts.length, wynik: allAnswered ? (firstResult?.mode ?? 'brak') : 'degraded', wejscie_pelne: E.record.wejscie_pelne, uciete_znaki: E.record.uciete_znaki,
      limit_ms: await effectiveLimit(endTerm), limit_zadany_ms: endTerm, ms, ms_hook: hookMs(),
    }, env);
    return '';
  } catch (error) {
    logFailure(data, env, error, 'koniec-tury');
    if (E.record.wynik === 'w_toku') E.skip('blad', 'wyjatek'); // before the query went out: not K3 (only a query without an answer is)
    return '';
  } finally {
    E.finish(hookMs());
  }
}
