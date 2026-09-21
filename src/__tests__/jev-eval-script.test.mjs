/* global process */
/**
 * Tests for scripts/jev-eval.mjs (Jev shadow-log eval tool, ticket 10).
 *
 * Written in .mjs so vitest picks it up (src test include glob)
 * without tsc trying to typecheck imports of the untyped plain-Node script.
 * Covers: per-point stats, comparable-only agreement denominator, malformed
 * line counting, empty/missing-log exit 0, and the --json CLI shape.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { analyzeLog, comparePair, defaultLogPath, formatReport } from '../../scripts/jev-eval.mjs';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');
const NODE = process.execPath;
const SCRIPT = join(root, 'scripts', 'jev-eval.mjs');

const tmp = mkdtempSync(join(tmpdir(), 'jev-eval-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function entry(point, mode, heuristic, jev, durationMs, state = null) {
  return JSON.stringify({ ts: '2026-09-21T00:00:00.000Z', point, mode, state, heuristic, jev, durationMs });
}

const FIXTURE = [
  // interleaved points: model-routing and intent alternate
  entry('model-routing', 'shadow', 'haiku', { type: 'Choice', choice: 'haiku' }, 40),
  entry('intent', 'shadow', 'build', { type: 'Choice', choice: 'build' }, 10, { prompt: 'add a hook' }),
  entry('model-routing', 'degraded', 'haiku', null, 60),
  entry('intent', 'shadow', 'build', { type: 'Choice', choice: 'query' }, 20, { prompt: 'add a hook' }),
  // twin boolean vs Jev Noul: comparable, agrees
  entry('intent', 'shadow', true, { type: 'Noul', noul: true }, 30),
  // twin number vs Jev Score: comparable, agrees
  entry('intent', 'shadow', 3, { type: 'Score', score: 3 }, 40),
  // twin string vs Jev Score: incommensurable -> nonComparable, not disagreement
  entry('intent', 'shadow', 'build', { type: 'Score', score: 3 }, 50),
  // malformed lines: unparseable, and parsed but unattributable
  'not json at all',
  JSON.stringify({ point: 'intent', mode: 7, heuristic: 'x', jev: null, durationMs: 1 }),
].join('\n') + '\n';

function writeFixture(name, text) {
  const path = join(tmp, name);
  writeFileSync(path, text, 'utf8');
  return path;
}

function runCli(args) {
  return execFileSync(NODE, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

describe('comparePair commensurability', () => {
  it('twin boolean <-> Jev Noul.noul', () => {
    expect(comparePair(true, { type: 'Noul', noul: true })).toBe(true);
    expect(comparePair(false, { type: 'Noul', noul: true })).toBe(false);
  });
  it('twin string <-> Jev Choice.choice', () => {
    expect(comparePair('build', { type: 'Choice', choice: 'build' })).toBe(true);
    expect(comparePair('build', { type: 'Choice', choice: 'query' })).toBe(false);
  });
  it('twin number <-> Jev Score.score', () => {
    expect(comparePair(3, { type: 'Score', score: 3 })).toBe(true);
    expect(comparePair(3, { type: 'Score', score: 5 })).toBe(false);
  });
  it('incommensurable and missing answers return null', () => {
    expect(comparePair('build', { type: 'Score', score: 3 })).toBeNull();
    expect(comparePair(true, { type: 'Choice', choice: 'build' })).toBeNull();
    expect(comparePair('build', null)).toBeNull();
    expect(comparePair('build', undefined)).toBeNull();
  });
});

describe('analyzeLog per-point stats', () => {
  const report = analyzeLog(FIXTURE, 'fixture.jsonl');

  it('counts total and malformed lines', () => {
    expect(report.totalLines).toBe(9);
    expect(report.malformed).toBe(2);
  });

  it('produces correct stats for intent', () => {
    const intent = report.points.find((p) => p.point === 'intent');
    expect(intent).toBeDefined();
    expect(intent.requests).toBe(5);
    expect(intent.modes).toEqual({ shadow: 5, active: 0, degraded: 0, off: 0, cap: 0, 'circuit-open': 0 });
    // comparable: Choice agree + Choice disagree + Noul agree + Score agree;
    // only string-vs-Score and degraded-null are nonComparable
    expect(intent.comparable).toBe(4);
    expect(intent.agree).toBe(3);
    expect(intent.disagree).toBe(1);
    expect(intent.nonComparable).toBe(1);
    expect(intent.agreementRate).toBe(0.75);
    expect(intent.durationMs).toEqual({ mean: 30, p95: 50 });
    expect(intent.disagreements).toHaveLength(1);
    expect(intent.disagreements[0].heuristic).toBe('build');
    expect(JSON.parse(intent.disagreements[0].jev).choice).toBe('query');
  });

  it('produces correct stats for model-routing (interleaved)', () => {
    const mr = report.points.find((p) => p.point === 'model-routing');
    expect(mr.requests).toBe(2);
    expect(mr.modes.shadow).toBe(1);
    expect(mr.modes.degraded).toBe(1);
    expect(mr.comparable).toBe(1);
    expect(mr.agree).toBe(1);
    expect(mr.nonComparable).toBe(1);
    expect(mr.agreementRate).toBe(1);
    expect(mr.durationMs).toEqual({ mean: 50, p95: 60 });
  });

  it('bounds disagreement example state at 200 chars', () => {
    const longState = { prompt: 'x'.repeat(500) };
    const text = entry('intent', 'shadow', 'a', { type: 'Choice', choice: 'b' }, 1, longState) + '\n';
    const r = analyzeLog(text, 'long.jsonl');
    expect(r.points[0].disagreements[0].state.length).toBeLessThanOrEqual(203); // 200 + '...'
  });

  it('renders a human-readable report', () => {
    const text = formatReport(report);
    expect(text).toContain('== intent ==');
    expect(text).toContain('agreement: 75.0%');
    expect(text).toContain('malformed: 2');
  });
});

describe('CLI surface', () => {
  it('--json on a fixture log produces parseable per-point output', () => {
    const path = writeFixture('fixture.jsonl', FIXTURE);
    const out = runCli([path, '--json']);
    const report = JSON.parse(out);
    expect(Object.keys(report)).toEqual(['logPath', 'totalLines', 'malformed', 'points']);
    expect(report.totalLines).toBe(9);
    expect(report.malformed).toBe(2);
    const intent = report.points.find((p) => p.point === 'intent');
    expect(intent.agreementRate).toBe(0.75);
    expect(intent.durationMs.p95).toBe(50);
  });

  it('missing log exits 0 with a clear message', () => {
    const out = runCli([join(tmp, 'does-not-exist.jsonl')]);
    expect(out).toContain('no shadow log');
    expect(out).toContain('nothing to evaluate');
  });

  it('empty log exits 0 with a clear message', () => {
    const path = writeFixture('empty.jsonl', '');
    const out = runCli([path]);
    expect(out).toContain('is empty');
    expect(out).toContain('nothing to evaluate');
  });

  it('unknown flag exits non-zero with usage', () => {
    expect(() => runCli(['--bogus'])).toThrow(/usage: node scripts\/jev-eval\.mjs/);
  });
});

describe('defaultLogPath resolution', () => {
  it('honors OMC_JEV_LOG_DIR', async () => {
    expect(await defaultLogPath({ OMC_JEV_LOG_DIR: '/tmp/jevdir' })).toContain(join('/tmp/jevdir', 'shadow.jsonl'));
  });
  // Branding is resolved by resolveOmcStateRoot, which reads process.env for
  // OMC_STATE_DIR so every hook and script agrees on one state root.
  it('honors OMC_STATE_DIR with a project-id segment', async () => {
    const previous = process.env.OMC_STATE_DIR;
    process.env.OMC_STATE_DIR = '/tmp/omc-state';
    try {
      const p = await defaultLogPath({}, root);
      expect(p).toContain(join('/tmp/omc-state'));
      expect(p).toContain(join('state', 'jev', 'shadow.jsonl'));
    } finally {
      if (previous === undefined) delete process.env.OMC_STATE_DIR;
      else process.env.OMC_STATE_DIR = previous;
    }
  });
  it('falls back to the worktree .omc state root', async () => {
    const p = await defaultLogPath({}, root);
    expect(p).toContain(join(root, '.omc', 'state', 'jev', 'shadow.jsonl'));
  });
});
