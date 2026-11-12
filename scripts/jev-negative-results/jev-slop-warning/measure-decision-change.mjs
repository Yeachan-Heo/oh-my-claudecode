#!/usr/bin/env node
/**
 * How often does the active `slop-warning` answer of Jev change the decision?
 *
 * Reads shadow.jsonl and (optionally) applied.jsonl from a Jev log directory
 * and prints counts only: no prompts, no tool input, no file contents are read
 * into the output. No network access, no API key.
 *
 *   node measure-decision-change.mjs [--dir .omc/state/jev]
 *        [--day YYYY-MM-DD] [--from ISO --to ISO] [--tz-offset-hours 0]
 *        [--threshold 0.8] [--point slop-warning] [--json]
 *
 * Two independent counts of the same thing:
 *   - "applied": rows of applied.jsonl for the point (written by the hook when
 *     OMC_JEV_SLOP_WARNING_APPLY=1 and OMC_JEV_APPLIED_LOG=1 changed the outcome);
 *   - "recomputed": rows of shadow.jsonl whose answer (noul >= threshold) differs
 *     from the logged heuristic decision. With the same threshold the two agree.
 *
 * Both row shapes of applied.jsonl are understood:
 *   upstream: {ts, point, applied: {action: {from: "warn"|"none", to, noul}}}
 *   older local patch: {ts, point, applied: {tool, warning: {from: bool, to: bool}, noul}}
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn last line is not a row */ }
  }
  return rows;
}

export function noulOf(row) {
  const answer = row?.answers?.slop_advisory ?? row?.jev;
  if (!answer || typeof answer !== 'object') return undefined;
  if (typeof answer.noul === 'number') return answer.noul;
  if (answer.noul === true) return 1;
  if (answer.noul === false) return 0;
  return undefined;
}

function warnFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'warn';
  return undefined;
}

export function appliedChange(row) {
  const a = row?.applied;
  if (!a) return undefined;
  const from = warnFlag(a.action?.from ?? a.warning?.from);
  const to = warnFlag(a.action?.to ?? a.warning?.to);
  if (from === undefined || to === undefined) return undefined;
  return { from, to, tool: typeof a.tool === 'string' ? a.tool : '(not logged)', noul: a.noul ?? a.action?.noul };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function pct(part, whole) {
  return whole ? Math.round((part / whole) * 10000) / 100 : null;
}

export function measure({ shadow, applied, point = 'slop-warning', from, to, tzOffsetHours = 0, day, threshold = 0.8 }) {
  const shift = (ts) => new Date(Date.parse(ts) + tzOffsetHours * 3600_000).toISOString();
  const inWindow = (row) => {
    if (typeof row.ts !== 'string' || Number.isNaN(Date.parse(row.ts))) return false;
    if (day && shift(row.ts).slice(0, 10) !== day) return false;
    if (from && Date.parse(row.ts) < Date.parse(from)) return false;
    if (to && Date.parse(row.ts) > Date.parse(to)) return false;
    return true;
  };

  const rows = shadow.filter((r) => r.point === point && inWindow(r));
  const byMode = {};
  for (const r of rows) byMode[r.mode] = (byMode[r.mode] ?? 0) + 1;

  const active = rows.filter((r) => r.mode === 'active' && noulOf(r) !== undefined);
  const durations = active.map((r) => r.durationMs).filter((d) => Number.isFinite(d)).sort((x, y) => x - y);
  const sumMs = durations.reduce((s, d) => s + d, 0);

  const bands = { '<0.2': 0, '0.2-0.5': 0, '0.5-0.7': 0, '0.7-0.8': 0, '>=0.8': 0 };
  for (const r of active) {
    const n = noulOf(r);
    bands[n < 0.2 ? '<0.2' : n < 0.5 ? '0.2-0.5' : n < 0.7 ? '0.5-0.7' : n < 0.8 ? '0.7-0.8' : '>=0.8'] += 1;
  }

  const recomputed = {};
  for (const t of new Set([0.5, 0.7, 0.8, threshold])) {
    let added = 0;
    let removed = 0;
    for (const r of active) {
      const heuristic = Boolean(r.heuristic);
      const jev = noulOf(r) >= t;
      if (jev && !heuristic) added += 1;
      if (!jev && heuristic) removed += 1;
    }
    recomputed[t] = { added, removed, changed: added + removed, percentOfAnswered: pct(added + removed, active.length) };
  }

  const changes = applied
    .filter((r) => r.point === point && inWindow(r))
    .map(appliedChange)
    .filter(Boolean);
  const byTool = {};
  for (const c of changes) byTool[c.tool] = (byTool[c.tool] ?? 0) + 1;
  const appliedAdded = changes.filter((c) => !c.from && c.to).length;
  const appliedRemoved = changes.filter((c) => c.from && !c.to).length;

  return {
    point,
    window: { day: day ?? null, from: from ?? null, to: to ?? null, tzOffsetHours },
    shadowRows: rows.length,
    rowsByMode: byMode,
    activeAnswered: active.length,
    heuristicWarnedInActiveRows: active.filter((r) => r.heuristic).length,
    noulBands: bands,
    latencyMs: {
      median: quantile(durations, 0.5),
      p95: quantile(durations, 0.95),
      max: durations.length ? durations[durations.length - 1] : null,
      sumOfPerCallDurationsHours: Math.round((sumMs / 3_600_000) * 100) / 100,
      note: 'sum of per-call durations; hooks of parallel subagents overlap, so this is not wall-clock time',
    },
    recomputedFromShadow: recomputed,
    applied: {
      rows: changes.length,
      added: appliedAdded,
      removed: appliedRemoved,
      percentOfAnswered: pct(changes.length, active.length),
      byTool: Object.fromEntries(Object.entries(byTool).sort((x, y) => y[1] - x[1])),
    },
  };
}

function parseArgs(argv) {
  const opts = { dir: '.omc/state/jev', threshold: 0.8, tzOffsetHours: 0, point: 'slop-warning', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--json') opts.json = true;
    else if (flag === '--dir') opts.dir = argv[++i];
    else if (flag === '--day') opts.day = argv[++i];
    else if (flag === '--from') opts.from = argv[++i];
    else if (flag === '--to') opts.to = argv[++i];
    else if (flag === '--point') opts.point = argv[++i];
    else if (flag === '--threshold') opts.threshold = Number(argv[++i]);
    else if (flag === '--tz-offset-hours') opts.tzOffsetHours = Number(argv[++i]);
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!(opts.threshold > 0 && opts.threshold <= 1)) throw new Error('--threshold must be a number above 0 up to 1');
  if (!Number.isFinite(opts.tzOffsetHours)) throw new Error('--tz-offset-hours must be a number');
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = measure({
    shadow: readJsonl(join(opts.dir, 'shadow.jsonl')),
    applied: readJsonl(join(opts.dir, 'applied.jsonl')),
    ...opts,
  });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const { applied, recomputedFromShadow: rc, latencyMs: lat } = result;
  console.log(`point ${result.point}, window ${JSON.stringify(result.window)}`);
  console.log(`shadow rows ${result.shadowRows} (by mode ${JSON.stringify(result.rowsByMode)}); active rows with an answer ${result.activeAnswered}`);
  console.log(`noul bands ${JSON.stringify(result.noulBands)}`);
  console.log(`latency of active calls: median ${lat.median} ms, p95 ${lat.p95} ms, max ${lat.max} ms, summed ${lat.sumOfPerCallDurationsHours} h (${lat.note})`);
  for (const [t, c] of Object.entries(rc)) {
    console.log(`recomputed at threshold ${t}: ${c.changed} changes (${c.added} warnings added, ${c.removed} removed) = ${c.percentOfAnswered} % of answered`);
  }
  console.log(`applied.jsonl: ${applied.rows} changes (${applied.added} added, ${applied.removed} removed) = ${applied.percentOfAnswered} % of answered; by tool ${JSON.stringify(applied.byTool)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
