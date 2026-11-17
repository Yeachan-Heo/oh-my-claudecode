import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyze,
  certifiedFloor,
  parseTsv,
  selectThreshold,
  splitFitHoldout,
  sweep,
  textReport,
  wilsonInterval,
  wilsonLower,
  wilsonUpper,
} from '../../tools/diagnostics/wilson_threshold.mjs';

// Tests for tools/diagnostics/wilson_threshold.mjs on synthetic TSV fixtures (temp directory only, no network).
const SCRIPT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'tools', 'diagnostics', 'wilson_threshold.mjs');

const TOL = 1e-4;
const near = (a: number, b: number, tol = TOL) => Math.abs(a - b) < tol;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wilson-threshold-test-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let fileCounter = 0;
/** Writes a TSV into the test temp directory and returns its path. */
function writeTsvFile(text: string): string {
  fileCounter += 1;
  const file = join(dir, `labels-${fileCounter}.tsv`);
  writeFileSync(file, text, 'utf8');
  return file;
}

/** Builds TSV text: header + rows (arrays in header order). */
function tsv(header: string[], rows: string[][]): string {
  return [header.join('\t'), ...rows.map((r) => r.join('\t'))].join('\n') + '\n';
}

/** Runs the analysis on TSV text. */
function run(text: string, options: Parameters<typeof analyze>[1]) {
  return analyze(parseTsv(text), options);
}

/** Runs the CLI with the given arguments and stdin text. */
function cli(args: string[], input = '') {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', input });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('wilson_threshold', () => {
  it('Wilson vectors shared with the join tool, and the certified floor', () => {
    const lower = [
      [22, 22, 0.8905],
      [20, 22, 0.7591],
      [18, 22, 0.651],
      [10, 10, 0.787],
      [245, 245, 0.9891],
      [15, 30, 0.3562],
      [941, 1019, 0.9086],
      [0, 30, 0.0],
    ];
    for (const [k, n, expected] of lower) expect(near(wilsonLower(k, n) as number, expected), `wilsonLower(${k}, ${n})`).toBe(true);
    const intervals = [
      [22, 22, 0.8513, 1.0],
      [20, 22, 0.7218, 0.9747],
      [15, 30, 0.3315, 0.6685],
      [941, 1019, 0.9055, 0.9382],
    ];
    for (const [k, n, lo, hi] of intervals) {
      const p = wilsonInterval(k, n) as { lower: number; upper: number };
      expect(near(p.lower, lo) && near(p.upper, hi), `wilsonInterval(${k}, ${n})`).toBe(true);
    }
    expect(wilsonLower(5, 0)).toBeNull();
    expect(wilsonInterval(5, 0)).toBeNull();
    expect(near(certifiedFloor(22) as number, 0.0435)).toBe(true);
    expect(near(certifiedFloor(245) as number, 0.0041)).toBe(true);
    expect(certifiedFloor(0)).toBe(1);
  });

  it('planning arithmetic: 10 of 10 and 22 of 22 do not meet the 0.95 target', () => {
    expect(wilsonLower(10, 10)! < 0.95).toBe(true);
    expect(near(wilsonLower(10, 10) as number, 0.787)).toBe(true);
    expect(wilsonLower(22, 22)! < 0.95).toBe(true);
    expect(near(wilsonLower(22, 22) as number, 0.8905)).toBe(true);
    // Ratio mode through analyze on a TSV without confidence: 10 rows with result 1.
    const text = tsv(['result'], Array.from({ length: 10 }, () => ['1']));
    const g = run(text, { target: 0.95, minSupport: 1 }).groups[0];
    expect(g.status).toBe('threshold not met');
    expect(near(g.lower as number, 0.787)).toBe(true);
    // The same set with min_support 30: too little data.
    expect(run(text, { target: 0.95, minSupport: 30 }).groups[0].status).toBe('too little data');
    // 22 of 22 in ratio mode: lower 0.8905, still below 0.95.
    const g22 = run(tsv(['result'], Array.from({ length: 22 }, () => ['1'])), { target: 0.95, minSupport: 1 }).groups[0];
    expect(near(g22.lower as number, 0.8905)).toBe(true);
    expect(g22.status).toBe('threshold not met');
  });

  it('sweep: a table over distinct thresholds ascending, with coverage, hit rate and lower Wilson bound', () => {
    const rows: { confidence: number; result: number }[] = [];
    for (let i = 0; i < 20; i += 1) rows.push({ confidence: 0.5, result: i < 8 ? 1 : 0 });
    for (let i = 0; i < 30; i += 1) rows.push({ confidence: 0.7, result: i < 24 ? 1 : 0 });
    for (let i = 0; i < 40; i += 1) rows.push({ confidence: 0.9, result: 1 });
    const table = sweep(rows, { target: 0.9 });
    expect(table).toHaveLength(3);
    expect(near(table[0].threshold, 0.5) && table[0].n === 90 && table[0].k === 72).toBe(true);
    expect(near(table[0].lower as number, 0.7223)).toBe(true);
    expect(near(table[0].coverage as number, 1.0)).toBe(true);
    expect(near(table[1].threshold, 0.7) && table[1].n === 70 && table[1].k === 64).toBe(true);
    expect(near(table[1].lower as number, 0.8427)).toBe(true);
    expect(near(table[2].threshold, 0.9) && table[2].n === 40 && table[2].k === 40).toBe(true);
    expect(near(table[2].lower as number, 0.9366)).toBe(true);
    expect(table[2].meetsTarget).toBe(true);
    expect(table[0].meetsTarget).toBe(false);
    expect(table[1].meetsTarget).toBe(false);
  });

  it('selectThreshold: the lowest threshold with min_support and a lower bound at least the target; a too small set gives null', () => {
    const rows: { confidence: number; result: number }[] = [];
    for (let i = 0; i < 20; i += 1) rows.push({ confidence: 0.5, result: i < 8 ? 1 : 0 });
    for (let i = 0; i < 30; i += 1) rows.push({ confidence: 0.7, result: i < 24 ? 1 : 0 });
    for (let i = 0; i < 40; i += 1) rows.push({ confidence: 0.9, result: 1 });
    const table = sweep(rows, { target: 0.9 });
    const chosen = selectThreshold(table, { target: 0.9 });
    expect(chosen).not.toBeNull();
    expect(near(chosen!.threshold, 0.9)).toBe(true);
    // conservative = false: the raw hit rate counts, so the 0.7 threshold (hit rate 0.914) qualifies earlier
    const raw = selectThreshold(table, { target: 0.9, conservative: false });
    expect(raw !== null && near(raw.threshold, 0.7)).toBe(true);
    // A too small set: 22 accepted (below min_support 30), all hits: null.
    const small = Array.from({ length: 22 }, () => ({ confidence: 0.9, result: 1 }));
    expect(selectThreshold(sweep(small, { target: 0.95 }), { target: 0.95 })).toBeNull();
  });

  it('mixed modes: breaker, limit and degraded outside the denominator and counted separately; undetermined and empty results outside the denominator', () => {
    const text = tsv(['result', 'mode'], [
      ['1', 'active'],
      ['0', 'shadow'],
      ['1', ''],
      ['1', 'breaker'],
      ['1', 'breaker'],
      ['1', 'limit'],
      ['0', 'degraded'],
      ['undetermined', 'active'],
      ['', 'active'],
    ]);
    const report = run(text, { target: 0.9, minSupport: 1 });
    expect(report.excludedModes).toEqual({ breaker: 2, limit: 1, degraded: 1 });
    expect(report.undetermined).toBe(2);
    expect(report.groups[0].n).toBe(3);
    expect(report.groups[0].k).toBe(2);
    expect(report.groups[0].status).toBe('threshold not met');
    expect(report.rowsTotal).toBe(9);
    // Closing equation: denominator + all excluded = rows in total.
    const modesTotal = Object.values(report.excludedModes).reduce((s, c) => s + c, 0);
    expect(report.groups[0].n + modesTotal + report.undetermined + report.invalid + report.invalidConfidence + report.badFormat).toBe(report.rowsTotal);
  });

  it('groups: a missing spec_version or jev_model column gives "no field"; two points give two groups', () => {
    const text = tsv(['result', 'point'], [
      ['1', 'point-a'],
      ['1', 'point-a'],
      ['0', 'point-a'],
      ['1', 'point-b'],
      ['1', 'point-b'],
      ['1', 'point-b'],
      ['1', 'point-b'],
      ['1', 'point-b'],
    ]);
    const report = run(text, { target: 0.9 });
    expect(report.groups).toHaveLength(2);
    expect(report.groups[0].fields).toEqual(['point', 'spec_version', 'jev_model']);
    expect(report.groups[0].label).toEqual(['point-a', 'no field', 'no field']);
    expect(report.groups[1].label).toEqual(['point-b', 'no field', 'no field']);
    expect(report.groups[0].n).toBe(3);
    expect(report.groups[1].n).toBe(5);
    // groupBy given explicitly: mode is a dimension; a missing mode column gives "no field"
    const explicit = run(text, { target: 0.9, groupBy: ['mode'] });
    expect(explicit.groups[0].label).toEqual(['no field']);
  });

  it('per-query: error per query = coverage times selective error, worked by hand', () => {
    // 10 rows with confidence 0.8 (7 hits), 10 rows with confidence 0.3 (3 hits).
    // At threshold 0.8: coverage 0.5, hit rate 0.7, selective error 0.3, per-query error 0.15.
    const rows: { confidence: number; result: number }[] = [];
    for (let i = 0; i < 7; i += 1) rows.push({ confidence: 0.8, result: 1 });
    for (let i = 0; i < 3; i += 1) rows.push({ confidence: 0.8, result: 0 });
    for (let i = 0; i < 3; i += 1) rows.push({ confidence: 0.3, result: 1 });
    for (let i = 0; i < 7; i += 1) rows.push({ confidence: 0.3, result: 0 });
    const table = sweep(rows, { target: 0.5 });
    const row08 = table.find((t) => near(t.threshold, 0.8));
    expect(row08).toBeDefined();
    expect(near(row08!.coverage as number, 0.5)).toBe(true);
    expect(near(row08!.hitRate as number, 0.7)).toBe(true);
    const byHand = 0.5 * 0.3;
    expect(near((row08!.coverage as number) * (1 - (row08!.hitRate as number)), byHand)).toBe(true);
    expect(near(byHand, 0.15)).toBe(true);
  });

  it('analyze with kind per-query reports the error at the chosen threshold as coverage times selective error', () => {
    const text = tsv(['result', 'confidence'], [
      ['1', '0.8'], ['1', '0.8'], ['1', '0.8'], ['1', '0.8'], ['1', '0.8'], ['1', '0.8'], ['1', '0.8'],
      ['0', '0.8'], ['0', '0.8'], ['0', '0.8'],
      ['1', '0.3'], ['1', '0.3'], ['1', '0.3'],
      ['0', '0.3'], ['0', '0.3'], ['0', '0.3'], ['0', '0.3'], ['0', '0.3'], ['0', '0.3'], ['0', '0.3'],
    ]);
    const report = run(text, { target: 0.35, minSupport: 10, kind: 'per-query' });
    const g = report.groups[0];
    expect(report.kind).toBe('per-query');
    expect(g.threshold).not.toBeNull();
    expect(near(g.threshold!.threshold, 0.8)).toBe(true);
    expect(near(g.threshold!.coverage as number, 0.5)).toBe(true);
    expect(near(g.error as number, 0.15)).toBe(true);
    const selective = run(text, { target: 0.35, minSupport: 10, kind: 'selective' });
    expect(near(selective.groups[0].error as number, 0.3)).toBe(true);
  });

  it('holdout: deterministic split by the sha256 of the session', () => {
    const ids = Array.from({ length: 60 }, (_, i) => `session-${i}`);
    const split1 = splitFitHoldout(ids, 0.4);
    const split2 = splitFitHoldout(ids, 0.4);
    expect(split1.fit.size + split1.holdout.size).toBe(60);
    expect(split1.fit.size > 0 && split1.holdout.size > 0).toBe(true);
    expect([...split1.fit].sort()).toEqual([...split2.fit].sort());
    expect([...split1.holdout].sort()).toEqual([...split2.holdout].sort());
    // A larger fraction: the holdout cannot shrink.
    const split3 = splitFitHoldout(ids, 0.5);
    expect(split3.holdout.size).toBeGreaterThanOrEqual(split1.holdout.size);
  });

  it('holdout_miss: fit all hits, holdout all misses; two runs identical', () => {
    const ids = Array.from({ length: 120 }, (_, i) => `session-${i}`);
    const split = splitFitHoldout(ids, 0.4);
    const rows = ids.map((s) => (split.fit.has(s) ? ['1', '0.9', s] : ['0', '0.9', s]));
    const text = tsv(['result', 'confidence', 'session'], rows);
    const options = { target: 0.9, minSupport: 30, holdout: 0.4 };
    const r1 = run(text, options);
    const r2 = run(text, options);
    expect(r1).toEqual(r2);
    const g = r1.groups[0];
    // The overall status may be "no threshold"; the holdout check uses the threshold chosen on the fit part.
    expect(g.holdout!.threshold).not.toBeNull();
    expect(near(g.holdout!.threshold as number, 0.9)).toBe(true);
    expect(g.holdout!.status).toBe('holdout_miss');
    expect(g.holdout!.kHoldout).toBe(0);
    expect(g.holdout!.nHoldout!).toBeGreaterThan(0);
    // without holdout there is no holdout status
    const r3 = run(text, { target: 0.9, minSupport: 30 });
    expect(r3.groups[0].holdout).toBeNull();
  });

  it('holdout unevaluable when no rows meet threshold', () => {
    // Create fit with high confidence threshold and holdout with low confidences
    const ids = Array.from({ length: 150 }, (_, i) => `session-${i}`);
    const split = splitFitHoldout(ids, 0.4);
    const rows = ids.map((s) => {
      if (split.fit.has(s)) {
        // Fit: all with high confidence and hits
        return ['1', '0.95', s];
      } else {
        // Holdout: all with low confidence (below the chosen threshold)
        return ['0', '0.1', s];
      }
    });
    const text = tsv(['result', 'confidence', 'session'], rows);
    const r = run(text, { target: 0.9, minSupport: 30, holdout: 0.4 });
    const g = r.groups[0];
    expect(g.holdout).not.toBeNull();
    // The threshold will be 0.95 (from fit); no holdout rows meet this, so nHoldout = 0
    expect(g.holdout!.nHoldout).toBe(0);
    // Status should be unevaluable, not holdout_ok
    expect(g.holdout!.status).toBe('holdout unevaluable');
  });

  it('holdout with direction upper compares the error rate to the target from above', () => {
    const ids = Array.from({ length: 150 }, (_, i) => `session-${i}`);
    const split = splitFitHoldout(ids, 0.4);
    const options = { target: 0.1, minSupport: 30, holdout: 0.4, direction: 'upper' as const };
    // The fit part has no errors, so the upper bound is below the target and a threshold exists.
    const errorsInHoldout = tsv(['result', 'session'], ids.map((s) => [split.fit.has(s) ? '0' : '1', s]));
    const bad = run(errorsInHoldout, options).groups[0];
    expect(bad.holdout!.status).toBe('holdout_miss');
    expect(bad.holdout!.nHoldout!).toBeGreaterThan(0);
    expect(bad.holdout!.kHoldout).toBe(bad.holdout!.nHoldout);
    const cleanHoldout = tsv(['result', 'session'], ids.map((s) => ['0', s]));
    const good = run(cleanHoldout, options).groups[0];
    expect(good.holdout!.status).toBe('holdout_ok');
    expect(good.holdout!.kHoldout).toBe(0);
    // The slack is on the upper side: an error rate of exactly the target plus 0.02 is still ok.
    const holdoutIds = ids.filter((s) => !split.fit.has(s));
    const kAtLimit = Math.floor(holdoutIds.length * (options.target + 0.02));
    const errorSessions = new Set(holdoutIds.slice(0, kAtLimit));
    const atLimit = tsv(['result', 'session'], ids.map((s) => [errorSessions.has(s) ? '1' : '0', s]));
    expect(run(atLimit, options).groups[0].holdout!.status).toBe('holdout_ok');
  });

  it('holdout with direction lower still compares the hit rate to the target from below', () => {
    const ids = Array.from({ length: 150 }, (_, i) => `session-${i}`);
    const split = splitFitHoldout(ids, 0.4);
    const options = { target: 0.8, minSupport: 30, holdout: 0.4, direction: 'lower' as const };
    const text = tsv(['result', 'session'], ids.map((s) => [split.fit.has(s) ? '1' : '0', s]));
    expect(run(text, options).groups[0].holdout!.status).toBe('holdout_miss');
    const allHits = tsv(['result', 'session'], ids.map((s) => ['1', s]));
    expect(run(allHits, options).groups[0].holdout!.status).toBe('holdout_ok');
  });

  it('small sample: n < 100 gives a warning in the text report and does not change the status', () => {
    const text = tsv(['result', 'confidence'], Array.from({ length: 40 }, () => ['1', '0.9']));
    const report = run(text, { target: 0.9, minSupport: 30 });
    const g = report.groups[0];
    expect(g.smallSample).toBe(true);
    expect(g.status).toBe('threshold met');
    expect(textReport(report)).toMatch(/small sample/);
    // n = 100 and above: no warning.
    const text100 = tsv(['result', 'confidence'], Array.from({ length: 100 }, () => ['1', '0.9']));
    const report100 = run(text100, { target: 0.9, minSupport: 30 });
    expect(report100.groups[0].smallSample).toBe(false);
    expect(textReport(report100)).not.toMatch(/small sample/);
  });

  it('period from the ts column and counts of invalid rows', () => {
    const text = tsv(['result', 'ts'], [
      ['1', '2026-11-01T10:00:00Z'],
      ['0', '2026-11-03T10:00:00Z'],
      ['1', ''],
      ['bad', '2026-11-05T10:00:00Z'],
    ]);
    const report = run(text, { target: 0.9 });
    const g = report.groups[0];
    // The period is taken from all rows with a parsable ts, including excluded ones (here the invalid row of 5 Nov).
    expect(report.period).toEqual({ from: '2026-11-01T10:00:00.000Z', to: '2026-11-05T10:00:00.000Z' });
    expect(g.n).toBe(3);
    expect(g.k).toBe(2);
    expect(report.invalid).toBe(1);
    // A row with the wrong number of fields: bad_format, included in the closing equation.
    const text2 = tsv(['result', 'mode'], [['1', 'active'], ['1']]);
    const report2 = run(text2, { target: 0.9 });
    expect(report2.rowsTotal).toBe(2);
    expect(report2.badFormat).toBe(1);
    expect(report2.groups[0].n).toBe(1);
    // A non-empty unparsable or out-of-range confidence: invalidConfidence; an empty one: the no-confidence subgroup.
    const text3 = tsv(['result', 'confidence'], [['1', '0.9'], ['1', 'abc'], ['1', '1.5'], ['1', '']]);
    const report3 = run(text3, { target: 0.9 });
    expect(report3.invalidConfidence).toBe(2);
    expect(report3.groups[0].n).toBe(2);
    expect(report3.groups[0].noConfidence).not.toBeNull();
    expect(report3.groups[0].noConfidence!.n).toBe(1);
  });

  it('CLI: exit 2 without arguments and with bad arguments; --json gives valid JSON; stdin works', () => {
    const none = cli([]);
    expect(none.status).toBe(2);
    expect(none.stderr).toMatch(/usage/);
    expect(cli(['--input', '-', '--target', '0.9', '--unknown']).status).toBe(2);
    expect(cli(['--input', '-', '--target', '1.5']).status).toBe(2);
    expect(cli(['--input', '-', '--target', '0.9', '--kind', 'other']).status).toBe(2);
    expect(cli(['--input', join(dir, 'does-not-exist.tsv'), '--target', '0.9']).status).toBe(2);
    const noResult = cli(['--input', '-', '--target', '0.9'], 'confidence\n0.9\n');
    expect(noResult.status).toBe(2);
    expect(noResult.stderr).toMatch(/result/);
    // A set where the lower bound at threshold 0.9 meets the target 0.9 (40 hits with confidence 0.9).
    const rows: string[][] = [];
    for (let i = 0; i < 8; i += 1) rows.push(['1', '0.5']);
    for (let i = 0; i < 12; i += 1) rows.push(['0', '0.5']);
    for (let i = 0; i < 24; i += 1) rows.push(['1', '0.7']);
    for (let i = 0; i < 6; i += 1) rows.push(['0', '0.7']);
    for (let i = 0; i < 40; i += 1) rows.push(['1', '0.9']);
    const text = tsv(['result', 'confidence'], rows);
    const viaStdin = cli(['--input', '-', '--target', '0.9'], text);
    expect(viaStdin.status).toBe(0);
    expect(viaStdin.stdout).toMatch(/threshold met/);
    const file = writeTsvFile(text);
    const viaJson = cli(['--input', file, '--target', '0,9', '--json']);
    expect(viaJson.status).toBe(0);
    const report = JSON.parse(viaJson.stdout);
    expect(report.groups).toHaveLength(1);
    expect(near(report.target, 0.9)).toBe(true);
    expect(near(report.groups[0].threshold.threshold, 0.9)).toBe(true);
    expect(report.groups[0].status).toBe('threshold met');
    // holdout needs the session column
    expect(cli(['--input', file, '--target', '0.9', '--holdout', '0.3']).status).toBe(2);
  });

  it('parseTsv: CRLF and unknown columns are handled; the executed, ignored and undetermined words are accepted', () => {
    const data = parseTsv('result\textra\r\n1\tx\r\n0\ty\r\n');
    expect(data.columns).toEqual(['result', 'extra']);
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0].result).toBe('1');
    const text = tsv(['result', 'mode'], [['executed', 'active'], ['ignored', 'active'], ['undetermined', 'active'], ['2', 'active']]);
    const report = run(text, { target: 0.9 });
    expect(report.groups[0].n).toBe(2);
    expect(report.groups[0].k).toBe(1);
    expect(report.undetermined).toBe(1);
    expect(report.invalid).toBe(1);
  });

  it('closing equation per group and in total, and the text report shows the counts', () => {
    const text = tsv(['result', 'confidence', 'mode', 'point'], [
      ['1', '0.9', 'active', 'point-a'],
      ['0', '0.7', 'active', 'point-a'],
      ['1', 'abc', 'active', 'point-a'],
      ['1', '2.0', 'active', 'point-a'],
      ['1', '', 'active', 'point-a'],
      ['1', 'breaker', 'breaker', 'point-a'],
      ['undetermined', '', 'active', 'point-a'],
      ['0', '0.5', 'limit', 'point-a'],
      ['1', '0.9', 'active', 'point-a'],
    ]);
    const report = run(text, { target: 0.9 });
    expect(report.rowsTotal).toBe(9);
    expect(report.invalidConfidence).toBe(2);
    expect(report.undetermined).toBe(1);
    expect(report.excludedModes).toEqual({ breaker: 1, limit: 1 });
    expect(report.badFormat).toBe(0);
    const g = report.groups[0];
    expect(g.rows).toBe(9);
    expect(g.invalidConfidence).toBe(2);
    expect(g.badFormat).toBe(0);
    const modesGroup = Object.values(g.modes).reduce((s, c) => s + c, 0);
    expect(g.n + modesGroup + g.undetermined + g.invalid + g.invalidConfidence + g.badFormat).toBe(g.rows);
    const total = report.groups.reduce((s, x) => s + x.n, 0) + Object.values(report.excludedModes).reduce((s, c) => s + c, 0) + report.undetermined + report.invalid + report.invalidConfidence + report.badFormat;
    expect(total).toBe(report.rowsTotal);
    const reportText = textReport(report);
    expect(reportText).toMatch(/invalid_confidence 2/);
    expect(reportText).toMatch(/bad_format 0/);
    expect(reportText).toMatch(/rows in total 9/);
    // A row with the wrong field count goes to bad_format and into the closing equation.
    const short = run('result\tconfidence\n1\t0.9\n1\n', { target: 0.9 });
    expect(short.rowsTotal).toBe(2);
    expect(short.badFormat).toBe(1);
    expect(short.groups[0].n).toBe(1);
    const shortSum = Object.values(short.excludedModes).reduce((s, c) => s + c, 0);
    expect(short.groups[0].n + shortSum + short.undetermined + short.invalid + short.invalidConfidence + short.badFormat).toBe(short.rowsTotal);
  });

  it('a learner-extraction file with a confidence column and an agent-type file with an empty confidence: both groups visible', () => {
    const text = tsv(['result', 'confidence', 'mode', 'point', 'spec_version', 'jev_model', 'session', 'ts'], [
      ['1', '0.9', 'active', 'learner-extraction', 'sp1', 'jev-latest', 's1', '2026-11-01T10:00:00Z'],
      ['1', '0.9', 'active', 'learner-extraction', 'sp1', 'jev-latest', 's2', '2026-11-01T10:01:00Z'],
      ['0', '0.7', 'active', 'learner-extraction', 'sp1', 'jev-latest', 's3', '2026-11-01T10:02:00Z'],
      ['1', '', 'active', 'agent-type', 'sp1', 'jev-latest', 's4', '2026-11-01T10:03:00Z'],
      ['0', '', 'active', 'agent-type', 'sp1', 'jev-latest', 's5', '2026-11-01T10:04:00Z'],
      ['1', '', 'active', 'agent-type', 'sp1', 'jev-latest', 's6', '2026-11-01T10:05:00Z'],
    ]);
    const report = run(text, { target: 0.9 });
    expect(report.groups).toHaveLength(2);
    const learner = report.groups.find((g) => g.label[0] === 'learner-extraction')!;
    const agentType = report.groups.find((g) => g.label[0] === 'agent-type')!;
    expect(learner).toBeDefined();
    expect(agentType).toBeDefined();
    // learner: sweep over 3 rows with a confidence
    expect(learner.table).not.toBeNull();
    expect(learner.n).toBe(3);
    expect(learner.noConfidence).toBeNull();
    // agent-type: no sweep, the "no confidence" subgroup as a ratio
    expect(agentType.table).toBeNull();
    expect(agentType.n).toBe(3);
    expect(agentType.noConfidence!.n).toBe(3);
    expect(agentType.noConfidence!.k).toBe(2);
    expect(agentType.status).toBe('too little data');
    expect(agentType.noConfidence!.status).toBe('too little data');
    const modesTotal = Object.values(report.excludedModes).reduce((s, c) => s + c, 0);
    expect(report.groups.reduce((s, x) => s + x.n, 0) + modesTotal + report.undetermined + report.invalid + report.invalidConfidence + report.badFormat).toBe(report.rowsTotal);
    const reportText = textReport(report);
    expect(reportText).toMatch(/point=learner-extraction/);
    expect(reportText).toMatch(/point=agent-type/);
    expect(reportText).toMatch(/no confidence: n 3/);
  });

  it('wilsonUpper vectors and the ratio-mode statuses with direction upper', () => {
    const vectors = [
      [0, 30, 0.0827],
      [0, 100, 0.0263],
      [0, 133, 0.0199],
      [0, 245, 0.0109],
      [5, 100, 0.0992],
      [6, 100, 0.1118],
    ];
    for (const [k, n, expected] of vectors) expect(near(wilsonUpper(k, n) as number, expected), `wilsonUpper(${k}, ${n})`).toBe(true);
    expect(wilsonUpper(3, 0)).toBeNull();
    // 5 errors in 100 meets the 0.10 target (upper 0.0992); 6 errors do not (0.1118).
    const five = tsv(['result'], [...Array(5).fill(['1']), ...Array(95).fill(['0'])]);
    const six = tsv(['result'], [...Array(6).fill(['1']), ...Array(94).fill(['0'])]);
    const r5 = run(five, { target: 0.1, direction: 'upper' });
    expect(r5.groups[0].status).toBe('threshold met');
    expect(near(r5.groups[0].upper as number, 0.0992)).toBe(true);
    const r6 = run(six, { target: 0.1, direction: 'upper' });
    expect(r6.groups[0].status).toBe('threshold not met');
    expect(near(r6.groups[0].upper as number, 0.1118)).toBe(true);
    // Default direction lower: the same data does not meet the 0.10 target from below (lower bound about 0.0223).
    expect(run(five, { target: 0.1 }).groups[0].status).toBe('threshold not met');
  });

  it('CLI --direction upper requires the ratio mode (exit 2 with a confidence column); value validation', () => {
    const withConfidence = cli(['--input', '-', '--target', '0.1', '--direction', 'upper'], 'result\tconfidence\n1\t0.9\n');
    expect(withConfidence.status).toBe(2);
    expect(withConfidence.stderr).toMatch(/direction upper/);
    const ratioOnly = cli(['--input', '-', '--target', '0.1', '--direction', 'upper'], 'result\n1\n0\n1\n');
    expect(ratioOnly.status).toBe(0);
    expect(ratioOnly.stdout).toMatch(/direction upper/);
    const badValue = cli(['--input', '-', '--target', '0.1', '--direction', 'side']);
    expect(badValue.status).toBe(2);
    expect(badValue.stderr).toMatch(/--direction: lower or upper/);
  });

  it('confidence 1.0, 1.00 and 0,8 accepted; 1.5 and abc counted as invalid confidence', () => {
    const text = tsv(['result', 'confidence'], [
      ['1', '1.0'],
      ['1', '1.00'],
      ['1', '0,8'],
      ['1', '1.5'],
      ['1', 'abc'],
    ]);
    const report = run(text, { target: 0.9 });
    expect(report.invalidConfidence).toBe(2);
    const g = report.groups[0];
    expect(g.n).toBe(3);
    const thresholds = g.table!.map((t) => t.threshold);
    expect(thresholds).toContain(1.0);
    expect(thresholds).toContain(0.8);
    expect(thresholds.every((p) => Number.isFinite(p))).toBe(true);
  });

  it('ratio report gives the error in the chosen kind', () => {
    const text = tsv(['result'], [['1'], ['1'], ['1'], ['0']]);
    const report = run(text, { target: 0.9, minSupport: 1 });
    expect(textReport(report)).toMatch(/error selective: 0.2500/);
    const perQuery = run(text, { target: 0.9, minSupport: 1, kind: 'per-query' });
    expect(textReport(perQuery)).toMatch(/error per-query: 0.2500/);
  });
});
