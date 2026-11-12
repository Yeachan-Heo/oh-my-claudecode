#!/usr/bin/env node
// Writes a SYNTHETIC Jev shadow log and a matching labels file so that
// measure-intent.mjs can be run without an API key and without real data.
// Nothing here comes from a real session: prompts are "synthetic prompt N",
// timestamps and durations come from a fixed-seed generator.
//
// The row counts per stratum mirror the population published in
// Yeachan-Heo/oh-my-claudecode#4928 (576 eligible `intent` rows: 19 with noul
// 0.5 or more, 85 from 0.2 to 0.5, 216 below 0.2 with a prompt, 256 with an
// empty sanitized prompt), so the report can be checked by eye against the issue.
//
//   node make-synthetic.mjs <out-dir>
//
// Writes <out-dir>/shadow.jsonl and <out-dir>/labels.jsonl.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node make-synthetic.mjs <out-dir>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

let seed = 20261109;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

const START = Date.parse('2026-11-03T12:00:00.000Z');
const SPAN_MS = 6 * 24 * 3600 * 1000;
const usedTs = new Set();
const nextTs = () => {
  let t;
  do {
    t = START + Math.floor(rand() * SPAN_MS);
  } while (usedTs.has(t));
  usedTs.add(t);
  return new Date(t).toISOString();
};

// [stratum, rows, noul range, prompt empty?]
const strata = [
  ['A', 19, [0.5, 0.95], false],
  ['B', 85, [0.2, 0.49], false],
  ['C', 216, [0.01, 0.19], false],
  ['Z', 256, [0.01, 0.19], true],
];

const rows = [];
const labels = [];
let n = 0;
for (const [stratum, count, [lo, hi], empty] of strata) {
  for (let i = 0; i < count; i += 1) {
    n += 1;
    const ts = nextTs();
    // Two stratum-A rows model a user who typed the /intent slash command: the
    // heuristic is true, the skill is already selected, the answer adds nothing.
    const slash = stratum === 'A' && i < 2;
    const noul = Math.round((lo + rand() * (hi - lo)) * 100) / 100;
    rows.push({
      ts,
      point: 'intent',
      mode: 'active',
      prompt_id: `synthetic-${n}`,
      state: { prompt: empty ? '' : slash ? '/intent synthetic prompt' : `synthetic prompt ${n}`, mode_name: 'intent' },
      heuristic: slash,
      jev: { noul, type: 'noul' },
      durationMs: 800 + Math.floor(rand() * 1600),
    });
    if (!empty && (stratum === 'A' || i < 20)) labels.push({ ts, label: slash ? 'yes' : 'no' });
  }
}

// Rows the report must ignore or count apart from the 576.
// The first 40 prompts also got a skill-trigger and a task-size request, as the
// keyword-detector hook sends them one after the other.
for (let i = 0; i < 40; i += 1) {
  rows.push({ ts: nextTs(), point: 'task-size', mode: 'active', prompt_id: `synthetic-${i + 1}`, state: { prompt: `synthetic prompt ${i + 1}` }, heuristic: 'small', jev: { choice: 'small' }, durationMs: 900 });
  rows.push({ ts: nextTs(), point: 'skill-trigger', mode: 'active', prompt_id: `synthetic-${i + 1}`, state: { prompt: `synthetic prompt ${i + 1}` }, heuristic: [], jev: { choice: 'none' }, durationMs: 1000 });
}
for (let i = 0; i < 12; i += 1) {
  rows.push({ ts: nextTs(), point: 'intent', mode: 'shadow', state: { prompt: `synthetic prompt ${2000 + i}`, mode_name: 'intent' }, heuristic: false, jev: { noul: 0.1, type: 'noul' }, durationMs: 700 });
}
for (let i = 0; i < 3; i += 1) {
  rows.push({ ts: nextTs(), point: 'intent', mode: 'degraded', state: { prompt: `synthetic prompt ${3000 + i}`, mode_name: 'intent' }, heuristic: false, durationMs: 5000 });
}

rows.sort((a, b) => a.ts.localeCompare(b.ts));
writeFileSync(join(outDir, 'shadow.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
writeFileSync(join(outDir, 'labels.jsonl'), labels.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`wrote ${rows.length} rows to ${join(outDir, 'shadow.jsonl')} and ${labels.length} labels to ${join(outDir, 'labels.jsonl')}`);
