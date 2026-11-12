#!/usr/bin/env node
// Prints the exact questions the panel sends to Jev (static text; the facts travel in the state), as JSON:
//   node print-questions.mjs            -> { batch: {...}, pokaz: {...}, przypomnienie: {...}, endOfTurnMoment: {...}, hints: {...} }
// Nothing is sent anywhere.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const scripts = join(new URL('.', import.meta.url).pathname, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'jev-panel-questions-'));
process.env.OMC_JEV_LOG_DIR = tmp;
const load = (rel) => import(pathToFileURL(join(scripts, rel)).href);
try {
  const P = await load('lib/jev-panel-wejscie.mjs');
  const L = await load('lib/jev-lista.mjs');
  const Z = await load('lib/jev-zadania.mjs');
  const K = await load('lib/jev-koniec-tury.mjs');
  const batch = P.panelQuestionsV2({});
  const pokaz = P.pokazQuestion(Object.keys(batch));
  L.recordListCall({ session_id: 'q', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'x', status: 'in_progress', activeForm: 'x' }] }, tool_use_id: 'toolu_q' });
  const reminder = Z.przypomnienieDoZapytania('q', 'main', process.env, {});
  const hints = Object.fromEntries(Object.keys(batch).map((name) => [name, P.panelHintV2(name, true, 'TASK', { stale: 12 })]));
  console.log(JSON.stringify({ batch, pokaz, przypomnienie: reminder?.question ?? null, endOfTurnMoment: K.MOMENT_QUESTION, hints }, null, 2));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
