#!/usr/bin/env node
/* global console, process */
/**
 * Offline arithmetic of the elastic compaction target (OMC_JEV_COMPACT_FLEX=active).
 * No network, no Jev, no API key: it imports the exported `elasticTarget` from
 * hooks/jev-compaction.mjs and feeds it a series of conversation sizes.
 *
 * Model (a simplification, stated so nobody reads more into the output): a compaction
 * leaves exactly `target x before` characters. The real module leaves what the results
 * it scored allow, so this shows the rule, not a measured outcome.
 *
 * Usage: node replay-elastic-target.mjs [--rule 0.5] [--start 300000] [--growth 20000,40000,80000,150000,150000] [--json]
 *   --rule    OMC_JEV_COMPACT_TARGET, the share a fixed compaction keeps (default 0.5)
 *   --start   characters of the first conversation before the first compaction (default 300000)
 *   --growth  characters added between one compaction and the next (default: a built-in series)
 */
import { elasticTarget } from '../../../hooks/jev-compaction.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const rule = Number(opt('--rule', '0.5'));
const start = Number(opt('--start', '300000'));
const growths = opt('--growth', '20000,40000,80000,150000,150000').split(',').map(Number);
if (![rule, start, ...growths].every(Number.isFinite) || rule <= 0 || rule >= 1) {
  console.error('usage: replay-elastic-target.mjs [--rule 0.5] [--start N] [--growth a,b,c] [--json]');
  process.exit(1);
}

const rows = [];
let fixedAfter;
let elasticAfter;
for (let i = 0; i <= growths.length; i++) {
  const fixedBefore = i === 0 ? start : fixedAfter + growths[i - 1];
  const elasticBefore = i === 0 ? start : elasticAfter + growths[i - 1];
  const el = elasticTarget(elasticBefore, rule, i === 0 ? undefined : { chars: elasticAfter });
  fixedAfter = Math.round(fixedBefore * rule);
  elasticAfter = Math.round(elasticBefore * el.target);
  rows.push({
    n: i + 1,
    fixed: { before: fixedBefore, after: fixedAfter, freed: fixedBefore - fixedAfter },
    elastic: { before: elasticBefore, after: elasticAfter, freed: elasticBefore - elasticAfter, target: Number(el.target.toFixed(3)), source: el.source, why: el.why },
  });
}

if (args.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(`rule target ${rule}; first conversation ${start} characters; a compaction leaves exactly target x before\n`);
  console.log('n  | fixed: before -> after (freed)   | elastic: before -> after (freed)  target source  why');
  for (const r of rows) {
    const f = `${r.fixed.before} -> ${r.fixed.after} (${r.fixed.freed})`;
    const e = `${r.elastic.before} -> ${r.elastic.after} (${r.elastic.freed})`;
    console.log(`${String(r.n).padEnd(2)} | ${f.padEnd(32)} | ${e.padEnd(34)} ${String(r.elastic.target).padEnd(6)} ${r.elastic.source}${r.elastic.why ? ' ' + r.elastic.why : ''}`);
  }
  const sum = (k, f) => rows.reduce((s, r) => s + r[k][f], 0);
  console.log(`\nfreed in total: fixed ${sum('fixed', 'freed')}, elastic ${sum('elastic', 'freed')} characters`);
  console.log('Elastic keeps more of the conversation after a small growth, never frees less than 30 % of the characters and never more than the fixed rule.');
}
