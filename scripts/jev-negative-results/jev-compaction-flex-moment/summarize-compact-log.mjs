#!/usr/bin/env node
/* global console, process */
/**
 * Counts, in a hooks/jev-compaction.mjs log (compact.jsonl), what the moment chosen by Jev
 * (OMC_JEV_COMPACT_AT_PERCENT=jev) and the elastic target (OMC_JEV_COMPACT_FLEX) did.
 * Reads one file, prints counts only (no record text), writes nothing, needs no API key.
 *
 * Usage: node summarize-compact-log.mjs <compact.jsonl> [--json]
 *        node summarize-compact-log.mjs --sample        (the bundled synthetic file)
 *
 * It reads the field names of the module in this branch: `own_threshold` records with
 * `result` (requested | not_now | rejected), `reason`, `moment` (task | jev), `jev_noul`;
 * `compact` records with `own_request`, `target_source`, `target_why`. Logs of an earlier local
 * variant of the module used Polish values for the same things (zadanie, jev_nie,
 * host_odrzucil_ture); they are mapped to the English ones below.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

const args = process.argv.slice(2);
const file = args.includes('--sample') ? join(dirname(fileURLToPath(import.meta.url)), 'sample-compact.jsonl') : args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: summarize-compact-log.mjs <compact.jsonl> [--json] | --sample');
  process.exit(1);
}
const ALIAS = { zadanie: 'task', jev_nie: 'jev_no', host_odrzucil_ture: 'host_refused' };
const norm = (v) => (v === undefined || v === null ? '-' : (ALIAS[v] ?? String(v)));

const rows = [];
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try { rows.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
}
const count = (list, key) => {
  const out = {};
  for (const r of list) { const k = key(r); out[k] = (out[k] ?? 0) + 1; }
  return out;
};

const own = rows.filter((r) => r.event === 'own_threshold');
const compacts = rows.filter((r) => r.event === 'compact');
const asked = own.filter((r) => typeof r.jev_noul === 'number');
const summary = {
  records: rows.length,
  own_threshold: {
    total: own.length,
    by_result_reason_moment: count(own, (r) => `${norm(r.result)} / ${norm(r.reason)} / ${norm(r.moment)}`),
    jev_answers: asked.length,
    jev_yes_at_0_7_or_more: asked.filter((r) => r.jev_noul >= 0.7).length,
    jev_noul_max: asked.length ? Math.max(...asked.map((r) => r.jev_noul)) : null,
    answer_left_out: count(own.filter((r) => r.odpowiedz_pominieta || r.answer_skipped), (r) => String(r.answer_skipped ?? r.odpowiedz_pominieta)),
  },
  compact: {
    total: compacts.length,
    by_result: count(compacts, (r) => norm(r.result)),
    by_own_request: count(compacts.filter((r) => r.own_request), (r) => norm(r.own_request)),
    with_elastic_target_fields: compacts.filter((r) => r.target_source !== undefined).length,
    by_target_source: count(compacts.filter((r) => r.target_source !== undefined), (r) => `${norm(r.target_source)} / ${norm(r.target_why)}`),
  },
};
if (args.includes('--json')) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`file: ${basename(file)}\nrecords: ${summary.records}`);
  console.log(`own_threshold records: ${own.length}`);
  for (const [k, v] of Object.entries(summary.own_threshold.by_result_reason_moment)) console.log(`  ${k}: ${v}`);
  console.log(`  Jev answers with a number: ${asked.length}; at 0.7 or more: ${summary.own_threshold.jev_yes_at_0_7_or_more}; highest: ${summary.own_threshold.jev_noul_max}`);
  console.log(`  answer left out of the question: ${JSON.stringify(summary.own_threshold.answer_left_out)}`);
  console.log(`compact records: ${compacts.length} ${JSON.stringify(summary.compact.by_result)}`);
  console.log(`  asked for by the module (own_request): ${JSON.stringify(summary.compact.by_own_request)}`);
  console.log(`  with elastic-target fields: ${summary.compact.with_elastic_target_fields} ${JSON.stringify(summary.compact.by_target_source)}`);
}
