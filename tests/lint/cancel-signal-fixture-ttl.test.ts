/**
 * Lint contract: cancel-signal fixtures must derive `expires_at` from the same
 * captured clock read as `requested_at` (issue #3712).
 *
 * `src/hooks/persistent-mode/index.ts` enforces
 * `expiresAt - requestedAt <= CANCEL_SIGNAL_TTL_MS` (30_000) for every cancel
 * signal. Test fixtures that build the two fields from two separate clock
 * reads can observe a 30_001ms window when a tick lands between the reads,
 * which makes `validateSignal` reject the signal and silently breaks the
 * expected cancellation — this exact pattern flaked exact-head CI (runs
 * 32550947694, 32549962350).
 *
 * The deterministic idiom is one captured timestamp:
 *   const requestedAt = Date.now();
 *   { requested_at: new Date(requestedAt).toISOString(),
 *     expires_at: new Date(requestedAt + 30_000).toISOString() }
 *
 * This guard scans all test sources under `src/` and `tests/` for inline
 * `cancel-signal-state` fixture literals and rejects any that still couple
 * `requested_at: new Date()` with `expires_at: new Date(Date.now() + N)`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SCAN_ROOTS = [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'tests')];
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mjs|js|mts|cts)$/;

/** Two separate clock reads: expires_at derived from a fresh Date.now() (+/- any offset expression). */
const TWO_CLOCK_READS_RE = /requested_at:\s*new Date\(\)\.toISOString\(\)[\s\S]{0,200}?expires_at:\s*new Date\(Date\.now\(\)\s*[+-]/;

function collectTestFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      collectTestFiles(full, out);
    } else if (TEST_FILE_RE.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function toForwardSlash(p: string): string {
  return p.split(sep).join('/');
}

describe('cancel-signal strict-TTL fixture guard (#3712)', () => {
  it('derives no cancel-signal fixture expiry from a second clock read', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of collectTestFiles(root)) {
        let source: string;
        try {
          source = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        if (TWO_CLOCK_READS_RE.test(source)) {
          offenders.push(toForwardSlash(relative(REPO_ROOT, file)));
        }
      }
    }
    expect(
      offenders,
      `Test fixtures deriving cancel-signal expires_at from a second clock read (issue #3712 flake).\n` +
        `Fix by capturing one timestamp and deriving both fields from it:\n` +
        `  const requestedAt = Date.now();\n` +
        `  { requested_at: new Date(requestedAt).toISOString(),\n` +
        `    expires_at: new Date(requestedAt + 30_000).toISOString() }\n` +
        `Offending files:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
