#!/usr/bin/env node
// Writes a small SYNTHETIC example into <dir>: one session transcript, labels with ground truth, case fields, and a made-up replay output.
// Everything is invented; none of it comes from a real session and the numbers it yields mean nothing.
//   node example/make-example.mjs <dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'example-data');
mkdirSync(join(dir, 'transcripts'), { recursive: true });
const session = 'synthetic-session-1';
let t = Date.parse('2026-11-11T08:00:00Z');
const stamp = () => new Date((t += 5000)).toISOString();
const rows = [];
rows.push({ type: 'user', timestamp: stamp(), origin: { kind: 'human' }, message: { role: 'user', content: 'Update the changelog and fix the failing test.' } });
rows.push({ type: 'assistant', timestamp: stamp(), message: { role: 'assistant', content: [{ type: 'text', text: 'I will start with the test.' }] } });
let n = 0;
const call = (name, input, output) => {
  const id = `toolu_${++n}`;
  rows.push({ type: 'assistant', timestamp: stamp(), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
  rows.push({ type: 'user', timestamp: stamp(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] } });
};
call('TodoWrite', { todos: [{ content: 'Fix the failing test', status: 'in_progress', activeForm: 'Fixing the failing test' }] }, 'ok');
for (let i = 0; i < 8; i++) call('Read', { file_path: `/project/src/file${i}.ts` }, `contents of file ${i}`);
rows.push({ type: 'assistant', timestamp: stamp(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The test passes now and the changelog is updated.' }] } });
writeFileSync(join(dir, 'transcripts', `${session}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

const queryTime = new Date(t - 8000).toISOString();
const label = { id: 'c1', ts: queryTime, session_id: session, transkrypt: join(dir, 'transcripts', `${session}.jsonl`), agent_type: null, powod: 'wywolania', agent_id: null, wejscie: { stan: { powod: 'wywolania', zadanie_w_toku: 'Fix the failing test' } }, prawda: { zrobione: 'tak', notka: 'nie', zrodlo: 'nie', poboczne: 'nie', utknal: 'nie', deleguj: 'nie' } };
writeFileSync(join(dir, 'labels.example.jsonl'), `${JSON.stringify(label)}\n`);

// A made-up replay output in the shape replay-labelled.mjs writes, for metrics.py (two cases, invented decisions).
const decision = (yes) => Object.fromEntries(['deleguj', 'notka', 'poboczne', 'slop', 'utknal', 'zrobione', 'zrodlo'].map((q) => [q, { paczka: q === yes, koniec: null, razem: q === yes }]));
const out = [
  { id: 'c1', podpowiedzi: ['zrobione'], wybrane: { paczka: 'zrobione', koniec: null }, paczka: { wejscie_pelne: true, tekst_agenta_znakow: 50, wynik: 'active', ms: 900 }, koniec: null, decyzja: decision('zrobione') },
  { id: 'c2', podpowiedzi: ['zrobione'], wybrane: { paczka: 'zrobione', koniec: null }, paczka: { wejscie_pelne: true, tekst_agenta_znakow: 10, wynik: 'active', ms: 1100 }, koniec: null, decyzja: decision('zrobione') },
];
writeFileSync(join(dir, 'replay-output.example.jsonl'), `${out.map((r) => JSON.stringify(r)).join('\n')}\n`);
const labels = [label, { ...label, id: 'c2', prawda: { ...label.prawda, zrobione: 'nie' } }];
writeFileSync(join(dir, 'labels-for-metrics.example.jsonl'), `${labels.map((r) => JSON.stringify(r)).join('\n')}\n`);
console.log(`wrote ${dir}`);
