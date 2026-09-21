#!/usr/bin/env node
/* global console, process */
/**
 * Jev shadow-log eval tool (ticket 10): the promotion engine.
 *
 * Reads the shared shadow log (JSONL, written by resolveJudgment) and produces
 * per-point promotion evidence: request count, mode distribution, twin-vs-Jev
 * agreement rate over COMPARABLE pairs only, bounded disagreement examples,
 * mean/p95 durationMs, and usage sums when lines carry usage data.
 *
 * Usage: node scripts/jev-eval.mjs [logPath] [--json]
 *   logPath  defaults to the state root's jev/shadow.jsonl (mirrors the
 *            resolution in src/hooks/jev/config.ts)
 *
 * Pure Node, zero dependencies, reads the log only. Never writes anything.
 * Exit codes: 0 on success (including empty/missing log), 1 on usage error.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveOmcStateRoot } from './lib/state-root.mjs';

const MODES = ['shadow', 'active', 'degraded', 'off', 'cap', 'circuit-open'];
const MAX_EXAMPLES = 5;
const BOUND_CHARS = 200;

/**
 * Mirror of the log-dir resolution in src/hooks/jev/config.ts:
 *   OMC_JEV_LOG_DIR || join(getOmcRoot(), 'state', 'jev')
 * Path resolution is delegated to resolveOmcStateRoot so workspace markers,
 * OMC_STATE_DIR branding and worktree common-dir resolution stay in one place.
 */
export async function defaultLogPath(env = process.env, cwd = process.cwd()) {
  if (env.OMC_JEV_LOG_DIR) return join(env.OMC_JEV_LOG_DIR, 'shadow.jsonl');
  // resolveOmcStateRoot owns workspace markers, OMC_STATE_DIR branding and
  // worktree common-dir resolution; deriving `.omc` here would fork that
  // contract (and trips scripts/ci/check-multirepo-paths.mjs).
  const omcRoot = await resolveOmcStateRoot(gitTopLevel(cwd) || cwd);
  return join(omcRoot, 'state', 'jev', 'shadow.jsonl');
}

function gitTopLevel(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 5000,
    }).trim() || null;
  } catch {
    return null;
  }
}


/**
 * Compare one twin answer against one Jev answer.
 * Returns true/false when the pair is comparable, null when incommensurable
 * (including missing Jev answer, e.g. degraded lines).
 * Comparable shapes: twin boolean <-> Jev Noul.noul; twin string <-> Jev
 * Choice.choice; twin number <-> Jev Score.score.
 */
export function comparePair(heuristic, jev) {
  if (jev === null || typeof jev !== 'object') return null;
  if (jev.type === 'Noul' && typeof heuristic === 'boolean' && typeof jev.noul === 'boolean') {
    return heuristic === jev.noul;
  }
  if (jev.type === 'Choice' && typeof heuristic === 'string' && typeof jev.choice === 'string') {
    return heuristic === jev.choice;
  }
  if (jev.type === 'Score' && typeof heuristic === 'number' && typeof jev.score === 'number') {
    return heuristic === jev.score;
  }
  return null;
}

/** Stringify a value for display, bounded to BOUND_CHARS. */
function bounded(value, max = BOUND_CHARS) {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function newPointStats(point) {
  const modes = {};
  for (const m of MODES) modes[m] = 0;
  return {
    point,
    requests: 0,
    modes,
    comparable: 0,
    agree: 0,
    disagree: 0,
    nonComparable: 0,
    agreementRate: null,
    durationMs: { mean: 0, p95: 0 },
    usage: undefined,
    disagreements: [],
  };
}

/**
 * Parse JSONL text and compute the full per-point report.
 * Malformed (unparseable or unattributable) lines are counted, never fatal.
 */
export function analyzeLog(text, logPath) {
  const byPoint = new Map();
  let totalLines = 0;
  let malformed = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    totalLines += 1;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    if (entry === null || typeof entry !== 'object' || typeof entry.point !== 'string' || typeof entry.mode !== 'string') {
      malformed += 1;
      continue;
    }
    let stats = byPoint.get(entry.point);
    if (!stats) {
      stats = newPointStats(entry.point);
      byPoint.set(entry.point, stats);
    }
    stats.requests += 1;
    if (Object.hasOwn(stats.modes, entry.mode)) {
      stats.modes[entry.mode] += 1;
    }
    const duration = typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs) ? entry.durationMs : 0;
    (stats._durations ??= []).push(duration);

    const verdict = comparePair(entry.heuristic, entry.jev);
    if (verdict === null) {
      stats.nonComparable += 1;
    } else if (verdict) {
      stats.comparable += 1;
      stats.agree += 1;
    } else {
      stats.comparable += 1;
      stats.disagree += 1;
      if (stats.disagreements.length < MAX_EXAMPLES) {
        stats.disagreements.push({
          state: bounded(entry.state),
          heuristic: bounded(entry.heuristic),
          jev: bounded(entry.jev),
        });
      }
    }
    if (entry.usage && typeof entry.usage === 'object') {
      stats.usage ??= { inputTokens: 0, outputTokens: 0 };
      stats.usage.inputTokens += typeof entry.usage.input_tokens === 'number' ? entry.usage.input_tokens : 0;
      stats.usage.outputTokens += typeof entry.usage.output_tokens === 'number' ? entry.usage.output_tokens : 0;
    }
  }

  const points = [...byPoint.values()].sort((a, b) => (a.point < b.point ? -1 : 1));
  for (const stats of points) {
    if (stats.comparable > 0) {
      stats.agreementRate = round2(stats.agree / stats.comparable);
    }
    const durations = stats._durations.sort((a, b) => a - b);
    const mean = durations.reduce((sum, d) => sum + d, 0) / durations.length;
    const p95Index = Math.max(0, Math.ceil(0.95 * durations.length) - 1);
    stats.durationMs = { mean: round2(mean), p95: durations[p95Index] };
    delete stats._durations;
  }

  return {
    logPath,
    totalLines,
    malformed,
    points,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Render the report as a human-readable table. */
export function formatReport(report) {
  const lines = [
    `jev shadow-log eval: ${report.logPath}`,
    `lines: ${report.totalLines}  malformed: ${report.malformed}  points: ${report.points.length}`,
    '',
  ];
  for (const stats of report.points) {
    const modeSummary = MODES.filter((m) => stats.modes[m] > 0)
      .map((m) => `${m}=${stats.modes[m]}`)
      .join(' ') || 'none';
    const rate = stats.agreementRate === null ? 'n/a (no comparable pairs)' : `${(stats.agreementRate * 100).toFixed(1)}%`;
    lines.push(`== ${stats.point} ==`);
    lines.push(`  requests: ${stats.requests}   modes: ${modeSummary}`);
    lines.push(`  comparable: ${stats.comparable}  agree: ${stats.agree}  disagree: ${stats.disagree}  nonComparable: ${stats.nonComparable}  agreement: ${rate}`);
    lines.push(`  durationMs: mean=${stats.durationMs.mean}  p95=${stats.durationMs.p95}`);
    if (stats.usage) {
      lines.push(`  usage: input=${stats.usage.inputTokens}  output=${stats.usage.outputTokens}`);
    }
    if (stats.disagreements.length > 0) {
      lines.push(`  disagreements (${stats.disagreements.length}, max ${MAX_EXAMPLES}):`);
      for (const ex of stats.disagreements) {
        lines.push(`    state=${ex.state}  heuristic=${ex.heuristic}  jev=${ex.jev}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function usage() {
  return 'usage: node scripts/jev-eval.mjs [logPath] [--json]';
}

async function main(argv, env = process.env, cwd = process.cwd()) {
  let json = false;
  let logPath = null;
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--')) {
      console.error(`unknown flag: ${arg}\n${usage()}`);
      return 1;
    } else if (logPath === null) {
      logPath = arg;
    } else {
      console.error(`unexpected argument: ${arg}\n${usage()}`);
      return 1;
    }
  }

  const path = logPath ?? await defaultLogPath(env, cwd);
  if (!existsSync(path)) {
    console.log(`no shadow log at ${path} — nothing to evaluate (exit 0)`);
    return 0;
  }
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) {
    console.log(`shadow log at ${path} is empty — nothing to evaluate (exit 0)`);
    return 0;
  }

  const report = analyzeLog(text, path);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
  return 0;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(await main(process.argv.slice(2)));
