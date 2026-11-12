#!/usr/bin/env node
/* global process, console */
// Offline replay for the todo-hint negative result. Makes NO API call and needs no key.
//
// 1. Replays the synthetic batches (fixtures/batches.json) through the hook's own fold (foldBatch), seeds a log directory with the synthetic
//    reminder rows (fixtures/todo-hint.jsonl), and prints, for each scenario in fixtures/scenarios.json, the exact request body the hook
//    would send to Jev: state.przypomnienie (the signals and the reminder history) and the question, in both wordings.
// 2. Prints the five answers Jev gave in the live probe (fixtures/recorded-answers.json) and what each would have done.
//
//   node scripts/jev-negative-results/todo-hint/replay.mjs [--json]

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QUESTION_BEFORE_HISTORY, QUESTION_WITH_HISTORY, foldBatch, przypomnienieQuestion, przypomnienieZOdpowiedzi, sygnalyPrzypomnienia, tekstStaly,
} from '../../lib/jev-todo-hint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(HERE, 'fixtures', name), 'utf8');
const asJson = process.argv.includes('--json');

const logDir = mkdtempSync(join(tmpdir(), 'todo-hint-replay-'));
try {
  writeFileSync(join(logDir, 'todo-hint.jsonl'), fixture('todo-hint.jsonl'));
  const { session_id: sessionId, batches } = JSON.parse(fixture('batches.json'));
  const { scenarios } = JSON.parse(fixture('scenarios.json'));

  const report = [];
  for (const scenario of scenarios) {
    const at = Date.parse(scenario.query_at);
    let state = null;
    for (const b of batches.filter((x) => x.agent === scenario.agent && Date.parse(x.ts) <= at)) {
      state = foldBatch(state, { session_id: sessionId, agent_type: b.agent_type ?? null, prompt_id: 'p1', agent_id: b.agent === 'main' ? undefined : b.agent }, b.calls, Date.parse(b.ts));
    }
    // the reminders already sent to this thread, as the hook keeps them (podpowiedzi and ostatnie)
    const sent = readFileSync(join(logDir, 'todo-hint.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => r.agent === scenario.agent && Date.parse(r.ts) <= at);
    state.podpowiedzi = sent.length;
    if (sent.length) state.ostatnie = { rodzaj: sent.at(-1).rodzaj, ts: sent.at(-1).ts, nr_tury: sent.at(-1).nr_tury, dostarczone: true };
    const signals = sygnalyPrzypomnienia(logDir, sessionId, scenario.agent, state, { now: at });
    for (const [label, wording] of [['before-history', QUESTION_BEFORE_HISTORY], ['with-history', QUESTION_WITH_HISTORY]]) {
      // the wording before the history field was added was sent with a state without the three history fields
      const { historia_przypomnien: _h, starszych_pominietych: _s, dziennik_obciety: _c, ...withoutHistory } = signals;
      const body = { state: { przypomnienie: wording === QUESTION_WITH_HISTORY ? signals : withoutHistory }, questions: przypomnienieQuestion(wording) };
      report.push({ scenario: scenario.name, wording: label, chars: JSON.stringify(body).length, body });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ requests: report, recorded: JSON.parse(fixture('recorded-answers.json')) }, null, 1));
  } else {
    for (const r of report) {
      console.log(`\n=== ${r.scenario} / question ${r.wording}: ${r.chars} chars`);
      console.log(JSON.stringify(r.body.state.przypomnienie, null, 1));
    }
    console.log('\n=== answers of the live probe (fixtures/recorded-answers.json)');
    console.log('state | wording                                            | zadne | zaloz | krok | nieakt | notka | choice -> text delivered');
    for (const a of JSON.parse(fixture('recorded-answers.json'))) {
      const p = a.probabilities;
      const kind = przypomnienieZOdpowiedzi({ choice: a.choice });
      const key = a.state === 'a' ? 'sub-1' : 'main';
      console.log(`${a.state}     | ${a.wording.padEnd(50)} | ${p.zadne} | ${p.zaloz_liste} | ${p.wpisz_krok} | ${p.lista_nieaktualna} | ${p.notka} | ${a.choice} -> ${kind ? tekstStaly(key, kind) : '(nothing)'}`);
    }
  }
} finally {
  rmSync(logDir, { recursive: true, force: true });
}
