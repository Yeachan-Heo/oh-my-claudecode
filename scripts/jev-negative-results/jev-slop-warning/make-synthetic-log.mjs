#!/usr/bin/env node
/**
 * Writes a synthetic Jev log directory (shadow.jsonl + applied.jsonl) so that
 * measure-decision-change.mjs can be run without any real traffic and without
 * an API key. Every value is generated from a seeded PRNG; no row contains real
 * tool input. The shape follows what the hooks write with OMC_JEV_LOG_CONTEXT=1
 * and OMC_JEV_APPLIED_LOG=1. The numbers are NOT measurements: they only exercise
 * the counting code, and the expected counts are printed so a test can compare.
 *
 *   node make-synthetic-log.mjs <output-dir> [--rows 5000] [--seed 1] [--threshold 0.8]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'SendMessage', 'TaskUpdate', 'Grep'];

export function generate({ rows = 5000, seed = 1, threshold = 0.8, day = '2026-01-15' } = {}) {
  const rand = mulberry32(seed);
  const shadow = [];
  const applied = [];
  const expected = { active: 0, added: 0, removed: 0, breaker: 0 };
  for (let i = 0; i < rows; i += 1) {
    const ts = new Date(Date.parse(`${day}T00:00:00Z`) + Math.floor((i / rows) * 86_400_000)).toISOString();
    const toolName = TOOLS[Math.floor(rand() * TOOLS.length)];
    if (rand() < 0.012) {
      shadow.push({ ts, point: 'slop-warning', mode: 'breaker', reason: 'rate-limit', durationMs: 0 });
      expected.breaker += 1;
      continue;
    }
    // Mostly low probabilities, a thin tail, as a rare-"yes" question produces.
    const r = rand();
    const noul = Math.round((r < 0.97 ? rand() * 0.45 : 0.45 + rand() * 0.55) * 100) / 100;
    const heuristic = rand() < 0.0005;
    const durationMs = Math.round(150 + rand() * 250 + (rand() < 0.03 ? 1500 * rand() : 0));
    shadow.push({
      ts,
      point: 'slop-warning',
      tool_use_id: `toolu_synthetic_${i}`,
      session_id: 'synthetic-session',
      mode: 'active',
      state: { toolName, toolInput: { synthetic: true } },
      heuristic,
      jev: { type: 'noul', noul },
      answers: { slop_advisory: { type: 'noul', noul } },
      durationMs,
    });
    expected.active += 1;
    const jevWarns = noul >= threshold;
    if (jevWarns !== heuristic) {
      applied.push({
        ts,
        point: 'slop-warning',
        tool_use_id: `toolu_synthetic_${i}`,
        applied: { action: { from: heuristic ? 'warn' : 'none', to: jevWarns ? 'warn' : 'none', noul } },
      });
      if (jevWarns) expected.added += 1;
      else expected.removed += 1;
    }
  }
  return { shadow, applied, expected };
}

function main() {
  const [dir, ...rest] = process.argv.slice(2);
  if (!dir) {
    console.error('usage: make-synthetic-log.mjs <output-dir> [--rows N] [--seed N] [--threshold X]');
    process.exit(2);
  }
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, '');
    if (!['rows', 'seed', 'threshold'].includes(key)) throw new Error(`unknown argument: ${rest[i]}`);
    opts[key] = Number(rest[i + 1]);
  }
  const { shadow, applied, expected } = generate(opts);
  mkdirSync(dir, { recursive: true });
  const lines = (list) => list.map((row) => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(join(dir, 'shadow.jsonl'), lines(shadow));
  writeFileSync(join(dir, 'applied.jsonl'), lines(applied));
  console.log(JSON.stringify({ dir, rows: shadow.length, expected }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
