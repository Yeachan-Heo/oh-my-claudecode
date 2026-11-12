#!/usr/bin/env node
/* global process, console */
// Reaction measure of the todo-hint experiment. Offline, no API call.
//
// For every delivered reminder (a todo-hint.jsonl row with etap "przypomnienie", tryb "active", not skipped) it asks: did the SAME recipient
// call a list tool after the reminder and before the next reminder to that recipient? It also reports the gap to the recipient's previous
// reminder. This is the measure behind "reminders without a reaction" in docs/jev/negative-results/todo-hint.md (the original ran as a
// Python script over the agent transcripts of the test cells; this one takes the list calls from a batches file).
//
//   node measure.mjs [--rows fixtures/todo-hint.jsonl] [--batches fixtures/batches.json]
//
// batches file: { "batches": [ { "ts": ISO, "agent": "main" | <agent id>, "calls": [ { "tool_name": ... } ] } ] }

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isListTool } from '../../lib/jev-todo-hint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const rows = readFileSync(arg('--rows', join(HERE, 'fixtures', 'todo-hint.jsonl')), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.etap === 'przypomnienie' && r.tryb === 'active' && !r.pominiete)
  .map((r) => ({ ...r, at: Date.parse(r.ts) }))
  .sort((a, b) => a.at - b.at);
const { batches } = JSON.parse(readFileSync(arg('--batches', join(HERE, 'fixtures', 'batches.json')), 'utf8'));
const listCalls = batches.filter((b) => b.calls.some((c) => isListTool(c.tool_name))).map((b) => ({ agent: b.agent, at: Date.parse(b.ts) }));

const out = [];
const previous = new Map();
rows.forEach((r, i) => {
  const next = rows.slice(i + 1).find((x) => x.agent === r.agent);
  const reaction = listCalls.find((c) => c.agent === r.agent && c.at >= r.at && (!next || c.at < next.at));
  out.push({
    recipient: r.agent, kind: r.rodzaj, ts: r.ts,
    gap_s: previous.has(r.agent) ? Math.round((r.at - previous.get(r.agent)) / 1000) : null,
    reacted: Boolean(reaction), after_s: reaction ? Math.round((reaction.at - r.at) / 1000) : null,
  });
  previous.set(r.agent, r.at);
});
console.table(out);
console.log(`delivered reminders: ${out.length}`);
console.log(`without a list call by the recipient before its next reminder: ${out.filter((x) => !x.reacted).length}`);
console.log(`with a gap under 60 s after the recipient's previous reminder: ${out.filter((x) => x.gap_s !== null && x.gap_s < 60).length}`);
