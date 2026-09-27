#!/usr/bin/env node

/**
 * SessionStart Hook: runs reconciler (P2 Part A).
 *
 * Reads the run ledger tail and surfaces completed unattended runs whose
 * closeout was never written — the advisory reconciliation that makes the
 * run ledger actionable. Doctrine: advisory only; it never mutates state
 * and never re-runs anything.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { readStdin } from './lib/stdin.mjs';
import { resolveOmcStateRoot } from './lib/state-root.mjs';

const LOOKBACK_MS = 7 * 24 * 3600_000;

function readLedgerTail(stateRoot, maxLines = 200) {
  const path = join(stateRoot, 'state', 'runs', 'ledger.jsonl');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((line) => line.trim().length > 0).slice(-maxLines);
  const entries = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry && entry.run && entry.event) entries.push(entry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

function reconcile(entries) {
  const now = Date.now();
  const lastEnd = new Map();
  const started = new Map();
  for (const entry of entries) {
    const key = `${entry.run}:${entry.sessionId ?? 'legacy'}`;
    if (entry.event === 'start') started.set(key, entry);
    if (entry.event === 'end') lastEnd.set(key, entry);
  }
  const findings = [];
  for (const [, entry] of lastEnd) {
    if (entry.closeoutWritten !== false) continue;
    const ts = Date.parse(entry.ts);
    if (!Number.isFinite(ts) || now - ts > LOOKBACK_MS) continue;
    findings.push(entry);
  }
  findings.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return findings;
}

async function main() {
  const raw = await readStdin(3000);
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }

  const cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

  let stateRoot;
  try {
    stateRoot = await resolveOmcStateRoot(cwd);
  } catch {
    stateRoot = null;
  }
  if (!stateRoot) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const findings = reconcile(readLedgerTail(stateRoot));
  if (findings.length === 0) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const lines = [
    `[RUN RECONCILIATION] ${findings.length} completed unattended run(s) never wrote their closeout — the run's friction was not captured:`,
    ...findings.map((entry) => `- ${entry.run}${entry.sessionId ? ` (session ${entry.sessionId})` : ''}: ended ${entry.ts} without a notepad closeout`),
    'Nothing was changed automatically. If a lesson was learned in those runs, record it now (the notepad is the refit surface); otherwise acknowledge and move on.',
  ];

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n'),
    },
  }));
}

await main();
