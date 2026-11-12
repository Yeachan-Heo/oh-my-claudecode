#!/usr/bin/env node
/* global process, console, URL */
/**
 * Counts the decisions in a tool-gate log (gate.jsonl, one JSON row per call, as written by
 * scripts/lib/jev-tool-gate.mjs): decisions, denials, passes granted because Jev did not answer
 * (fail-open), and the time spent waiting for Jev.
 *
 *   node gate-log-stats.mjs <gate.jsonl> [--json]     count a real log (rows with point "tool-gate" only)
 *   node gate-log-stats.mjs --synthetic [--seed N] [--rows N] [--write <file>] [--json]
 *                                                     no API, no log needed: count a synthetic log
 *
 * Only counts and times are printed, never the commands. Rows of other points that share gate.jsonl
 * (for example shell checks) are ignored.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const FAIL_OPEN = new Set(['jev-degraded', 'jev-none', 'jev-budget', 'error']);

export function summarize(rows) {
  const gate = rows.filter((r) => r && r.point === 'tool-gate');
  const bySource = {};
  const byDecision = {};
  const denyAxis = {};
  const waits = [];
  let enforcedDenials = 0;
  let wouldDeny = 0;
  const denyRisks = [];
  for (const r of gate) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    byDecision[r.decision] = (byDecision[r.decision] ?? 0) + 1;
    if (typeof r.jev_ms === 'number') waits.push(r.jev_ms);
    if (r.decision === 'deny') {
      if (r.enforced) enforcedDenials++;
      const key = r.source === 'static' ? `static:${r.rule}` : `jev:${r.axis}`;
      denyAxis[key] = (denyAxis[key] ?? 0) + 1;
      if (r.source === 'jev' && typeof r.risk === 'number') denyRisks.push(r.risk);
    }
    if (r.would_deny) wouldDeny++;
  }
  waits.sort((a, b) => a - b);
  const q = (p) => (waits.length ? waits[Math.min(waits.length - 1, Math.floor(p * waits.length))] : null);
  const sum = waits.reduce((a, b) => a + b, 0);
  const failOpen = gate.filter((r) => FAIL_OPEN.has(r.source)).length;
  const attempted = gate.filter((r) => r.source === 'jev' || FAIL_OPEN.has(r.source)).length; // calls that needed an answer from Jev
  return {
    rows: gate.length,
    decisions: byDecision,
    by_source: bySource,
    denials: byDecision.deny ?? 0,
    denials_enforced: enforcedDenials,
    denials_by_rule_or_axis: denyAxis,
    jev_denial_risk_range: denyRisks.length ? [Math.min(...denyRisks), Math.max(...denyRisks)] : null,
    would_deny_advisory: wouldDeny,
    jev_queries: waits.length,
    fail_open: failOpen,
    fail_open_share_of_attempts: attempted ? Math.round((failOpen / attempted) * 1000) / 1000 : null,
    wait_ms: { median: q(0.5), p95: q(0.95), max: waits.at(-1) ?? null, total: Math.round(sum), total_hours: Math.round((sum / 3.6e6) * 100) / 100 },
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A synthetic log: made-up proportions, only to exercise the counting. It says nothing about Jev. */
export function syntheticRows(rows = 2000, seed = 1) {
  const rnd = mulberry32(seed);
  const out = [];
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const axes = ['sekret', 'niszczace', 'wyprowadzenie', 'uprawnienia', 'trwala'];
  for (let i = 0; i < rows; i++) {
    const x = rnd();
    const row = { ts: new Date(t0 + i * 2000).toISOString(), point: 'tool-gate', tool_name: 'Bash', mode: 'active' };
    if (x < 0.02) Object.assign(row, { decision: 'deny', enforced: true, source: 'static', rule: 'catastrophic-delete' });
    else if (x < 0.30) Object.assign(row, { decision: 'allow', enforced: false, source: 'safe' });
    else if (x < 0.45) Object.assign(row, { decision: 'allow', enforced: false, source: 'scope', tool_name: 'Read' });
    else if (x < 0.50) Object.assign(row, { decision: 'allow', enforced: false, source: 'jev-degraded', jev_ms: 4500 });
    else {
      const wait = Math.round(900 + rnd() * rnd() * 3600);
      Object.assign(row, { source: 'jev', jev_ms: wait, jev: 'active' });
      if (rnd() < 0.004) Object.assign(row, { decision: 'deny', enforced: true, axis: axes[Math.floor(rnd() * axes.length)], risk: Math.round((0.9 + rnd() * 0.08) * 100) / 100, ordered: 0.1 });
      else Object.assign(row, { decision: 'allow', enforced: false, risk: Math.round(rnd() * 0.3 * 100) / 100, ordered: 0.8 });
    }
    row.durationMs = (row.jev_ms ?? 2) + 1;
    out.push(row);
  }
  return out;
}

function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name, d) => (args.includes(name) ? args[args.indexOf(name) + 1] : d);
  let rows;
  if (flag('--synthetic')) {
    rows = syntheticRows(Number(value('--rows', 2000)), Number(value('--seed', 1)));
    if (flag('--write')) writeFileSync(value('--write'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  } else {
    const file = args.find((a) => !a.startsWith('--'));
    if (!file) { console.error('usage: gate-log-stats.mjs <gate.jsonl> | --synthetic'); process.exit(2); }
    rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  }
  const s = summarize(rows);
  if (flag('--json')) { console.log(JSON.stringify(s, null, 2)); return; }
  console.log(`rows (point tool-gate): ${s.rows}`);
  console.log(`decisions: ${JSON.stringify(s.decisions)}   by source: ${JSON.stringify(s.by_source)}`);
  console.log(`denials: ${s.denials} (enforced ${s.denials_enforced}); by rule or axis: ${JSON.stringify(s.denials_by_rule_or_axis)}`);
  console.log(`Jev queries: ${s.jev_queries}; passed because Jev did not answer: ${s.fail_open}`);
  console.log(`wait for Jev: median ${s.wait_ms.median} ms, p95 ${s.wait_ms.p95} ms, max ${s.wait_ms.max} ms, total ${s.wait_ms.total_hours} h`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main(process.argv);
