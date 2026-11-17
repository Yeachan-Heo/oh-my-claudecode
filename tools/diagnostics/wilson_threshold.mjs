#!/usr/bin/env node
// Threshold rule with a Wilson lower bound, a minimum support and a "no threshold" result.
//
// Offline measurement over a TSV file of outcome labels (the output of jev_outcome_labels.mjs, or any
// file with the same columns). No network, no keys, no reading of live logs: the input is always given
// with --input. It is a standalone diagnostic run by hand. It does not change OMC behaviour and is not
// shipped in the npm package (tools/ is not in the "files" list of package.json).
//
//   node tools/diagnostics/wilson_threshold.mjs --input <file.tsv or -> --target <0-1> [--min-support 30]
//        [--kind selective|per-query] [--direction lower|upper] [--group-by point,spec_version,jev_model] [--holdout <0-0.5>] [--json]
//
// Input: TSV, UTF-8, tab separated, with a header line. Column result (required): 1 or executed = hit,
// 0 or ignored = miss, empty or undetermined = outside the denominator (counted separately); any other value
// = invalid row. Optional columns: confidence (a number 0-1, a decimal comma is accepted), mode, point,
// spec_version, jev_model, session, ts (ISO 8601). Unknown columns are ignored.
// Rows with mode breaker, limit or degraded (skipped by the circuit breaker, by a limit, or a degraded
// response) are NOT a verdict: they are excluded from the denominator and counted per mode. The active,
// shadow and empty modes count normally. Every row falls into exactly one category, shown in the report
// per group and in total: denominator + excluded modes + undetermined + invalid + invalid_confidence +
// bad_format = rows. A row with an EMPTY confidence (in a file that has a confidence column) is not invalid:
// in its group it forms a "no confidence" subgroup measured as a single ratio (k/n, interval, bound, status),
// next to the threshold sweep over rows with a numeric confidence.
// Paths are taken ONLY from the arguments; a missing --input or --target is a usage error (exit 2); "-" reads stdin.
// The script prints only numbers, identifiers and timestamps.
//
// Output: a text report (default) or --json; decimal numbers use a dot. The report always gives n (the
// denominator), the rows in total, the period (smallest and largest ts, when the ts column is present) and the
// counts of all excluded rows (modes, undetermined, invalid, invalid_confidence, bad_format), per group and in
// total, so the closing equation can be checked from the report. A "small sample" warning is printed when
// n < 100; the warning does not change the status.
//
// Direction (--direction lower|upper, default lower): lower = the standard rule, the threshold is met when the
// one-sided lower Wilson bound (z = 1.645) is at least the target; upper = rules of the form "error below the
// target" (the one-sided upper bound must be below the target). In ratio mode the status is "threshold met"
// when the upper bound is below the target; in sweep mode (confidence column) upper is not allowed (exit 2).
//
// Modes of computation:
//   A. file has a confidence column: sweep over the thresholds equal to the distinct confidence values
//      (ascending); at threshold t the rows with confidence >= t are accepted. Table: threshold, accepted n,
//      hits k, coverage (n / all), hit rate (k/n), one-sided lower Wilson bound (z = 1.645), whether the
//      target is met. Threshold choice: the lowest threshold (largest coverage) with at least min_support
//      accepted rows and a hit rate (its lower bound when conservative, the default) at least the target;
//      otherwise status "no threshold", a VALID result, not an error.
//   B. file without a confidence column: one ratio k/n: two-sided 95 % interval (z = 1.96), one-sided lower
//      bound (z = 1.645); status: "too little data" (n < min_support), "threshold met" (lower >= target),
//      "threshold not met".
//
// Kind of error (--kind selective|per-query): selective = error among the accepted rows; per-query = error
// over all inputs = coverage times the selective error (a per-query error rate of a conformal-style threshold).
// The report shows the kind and the error in that kind.
//
// Fit/holdout split (--holdout <fraction 0-0.5>, requires the session column): sessions are split
// deterministically by the sha256 hash of the session identifier (first 16 hex digits / 2^64 < fraction ->
// holdout, otherwise fit); a whole session goes to one side. The threshold is chosen on the fit part; on the
// holdout part the status is "holdout_miss" when the holdout rate at the chosen threshold is on the wrong side of
// the target by more than SLACK_HOLDOUT = 0.02 (direction lower: the hit rate is below target - 0.02; direction
// upper: the rate, which counts errors, is above target + 0.02), otherwise "holdout_ok"; when the fit part has no
// threshold, the holdout checks nothing ("holdout without threshold"); when no holdout row reaches the chosen
// threshold, nothing was tested ("holdout unevaluable", not "holdout_ok"). With small samples only the Wilson
// rule applies, no holdout.
//
// Wilson score interval: p = k/n; centre = (p + z^2/(2n)) / (1 + z^2/n); half-width =
// z * sqrt(p(1-p)/n + z^2/(4n^2)) / (1 + z^2/n); lower = centre - half-width (not below 0); upper = centre +
// half-width (not above 1); n = 0 gives null, not 0. One-sided bound with z = 1.645; two-sided interval with z = 1.96.
// The certified-threshold floor 1/(n+1) is available as certifiedFloor(n). min_support defaults to 30.
// Numeric command-line values accept a dot or a decimal comma.
//
// Grouping (--group-by point,spec_version,jev_model; by default these three): a result for each group; a missing
// column or an empty value gives the group "no field". By default grouping happens only when the file has at least
// one of the three columns (a file without any of them, e.g. a plain ratio, is counted as one whole). With
// --group-by every given field is a dimension, also when the column is absent (value "no field").
// Allowed grouping fields: point, spec_version, jev_model, mode, session.
//
// Exit codes: 0 valid run (also a "no threshold" result); 2 input error (missing --input or --target, unreadable
// file, missing column result, bad argument, --holdout without a session column).
//
// Interface of the exported functions: wilsonLower(k, n, z), wilsonUpper(k, n, z), wilsonInterval(k, n, z),
// certifiedFloor(n), sweep(rows, { target }), selectThreshold(table, { target, minSupport, conservative }),
// splitFitHoldout(ids, fraction), parseTsv(text), analyze(parsed, options), textReport(report), parseArgs(argv),
// validateArgs(args). The CLI is a thin wrapper over them.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const Z_LOWER = 1.645;
export const Z_INTERVAL = 1.96;
export const DEFAULT_MIN_SUPPORT = 30;
export const SLACK_HOLDOUT = 0.02;
export const SMALL_SAMPLE = 100;
export const GROUP_FIELDS = ['point', 'spec_version', 'jev_model', 'mode', 'session'];
const EXCLUDED_MODES = ['breaker', 'limit', 'degraded'];

/** One-sided lower Wilson bound (z = 1.645); n = 0 or bad data gives null. */
export function wilsonLower(k, n, z = Z_LOWER) {
  const bounds = wilsonInterval(k, n, z);
  return bounds === null ? null : bounds.lower;
}

/** One-sided upper Wilson bound (z = 1.645), for "error below target" rules; n = 0 or bad data gives null. */
export function wilsonUpper(k, n, z = Z_LOWER) {
  const bounds = wilsonInterval(k, n, z);
  return bounds === null ? null : bounds.upper;
}

/** Two-sided Wilson interval { lower, upper }; n = 0 or bad data gives null. */
export function wilsonInterval(k, n, z = Z_INTERVAL) {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0 || k < 0 || k > n) return null;
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { lower: Math.max(0, centre - halfWidth), upper: Math.min(1, centre + halfWidth) };
}

/** Floor of a certified threshold, 1/(n+1); bad data gives null. */
export function certifiedFloor(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  return 1 / (n + 1);
}

/**
 * Sweep over thresholds: rows { confidence, result } (result 1 or 0). Thresholds = distinct confidence values, ascending.
 * Returns rows { threshold, n, k, coverage, hitRate, lower, meetsTarget }; coverage = n / all rows.
 */
export function sweep(rows, { target } = {}) {
  if (!rows || rows.length === 0) return [];
  const thresholds = [...new Set(rows.map((r) => r.confidence))].sort((a, b) => a - b);
  const total = rows.length;
  const table = [];
  for (const threshold of thresholds) {
    let n = 0;
    let k = 0;
    for (const r of rows) {
      if (r.confidence >= threshold) {
        n += 1;
        k += r.result;
      }
    }
    const hitRate = n === 0 ? null : k / n;
    const lower = wilsonLower(k, n);
    table.push({
      threshold,
      n,
      k,
      coverage: total === 0 ? null : n / total,
      hitRate,
      lower,
      meetsTarget: target === undefined || target === null ? null : lower !== null && lower >= target,
    });
  }
  return table;
}

/**
 * Threshold choice from a sweep table (sorted ascending by threshold): the lowest threshold with n >= minSupport and a
 * hit rate (or its lower Wilson bound when conservative) at least the target; otherwise null.
 */
export function selectThreshold(table, { target, minSupport = DEFAULT_MIN_SUPPORT, conservative = true } = {}) {
  if (!table || table.length === 0) return null;
  for (const row of table) {
    if (row.n < minSupport) continue;
    const measure = conservative ? row.lower : row.hitRate;
    if (measure !== null && measure >= target) return row;
  }
  return null;
}

/** Deterministic fit/holdout split of sessions: sha256 of the session id; fraction from the first 16 hex digits / 2^64 < fraction -> holdout, else fit. */
export function splitFitHoldout(ids, fraction) {
  const fit = new Set();
  const holdout = new Set();
  for (const id of ids) {
    const digest = createHash('sha256').update(String(id), 'utf8').digest('hex');
    const share = Number(BigInt('0x' + digest.slice(0, 16))) / 2 ** 64;
    if (share < fraction) holdout.add(id);
    else fit.add(id);
  }
  return { fit, holdout };
}

/** TSV parser with a header: { columns, rows }; rows with a wrong field count get the marker __badFormat (missing fields are undefined). */
export function parseTsv(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return { columns: [], rows: [] };
  const columns = lines[0].split('\t');
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const fields = lines[i].split('\t');
    const row = {};
    columns.forEach((name, j) => { row[name] = fields[j] ?? ''; });
    row.__badFormat = fields.length !== columns.length;
    rows.push(row);
  }
  return { columns, rows };
}

/** Confidence value: { state: 'ok', value }, { state: 'empty' } or { state: 'invalid' } (non-empty, not a number, or outside 0-1; a decimal comma is accepted). */
function parseConfidence(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { state: 'empty' };
  const number = Number(text.replace(',', '.'));
  if (Number.isFinite(number) && number >= 0 && number <= 1) return { state: 'ok', value: number };
  return { state: 'invalid' };
}

/** Result value: 1, 0, 'undetermined' or null (invalid row). */
function parseResult(raw) {
  const text = raw.trim();
  if (text === '1' || text === 'executed') return 1;
  if (text === '0' || text === 'ignored') return 0;
  if (text === '' || text === 'undetermined') return 'undetermined';
  const asNumber = Number(text);
  if (asNumber === 1) return 1;
  if (asNumber === 0) return 0;
  return null;
}

/**
 * Main analysis of the parsed rows (output of parseTsv). Each row falls into exactly one category: the denominator
 * (with a numeric confidence: sweep; with an empty confidence: the "no confidence" subgroup as a ratio) or excluded
 * (a mode without a verdict, undetermined, invalid result, invalid confidence, bad format). Counts per group and in
 * total; denominator + excluded = rows, per group and in total.
 */
export function analyze({ columns, rows }, options = {}) {
  const { target, minSupport = DEFAULT_MIN_SUPPORT, kind = 'selective', groupBy = null, holdout = null, direction = 'lower' } = options;
  const hasConfidence = columns.includes('confidence');
  const hasTs = columns.includes('ts');

  const DEFAULT_GROUP_FIELDS = ['point', 'spec_version', 'jev_model'];
  const hasDefaults = DEFAULT_GROUP_FIELDS.some((p) => columns.includes(p));
  const groupFields = groupBy !== null ? groupBy : hasDefaults ? DEFAULT_GROUP_FIELDS : [];
  const groupKey = (row) => groupFields.map((p) => {
    const raw = p === 'mode' ? row.mode : p === 'session' ? row.session : row[p];
    const value = String(raw ?? '').trim();
    return value === '' ? 'no field' : value;
  });

  const groups = new Map();
  let periodFrom = null;
  let periodTo = null;
  for (const row of rows) {
    const tsRaw = hasTs ? (row.ts ?? '').trim() : '';
    if (tsRaw !== '') {
      const ts = Date.parse(tsRaw);
      if (Number.isFinite(ts)) {
        if (periodFrom === null || ts < periodFrom) periodFrom = ts;
        if (periodTo === null || ts > periodTo) periodTo = ts;
      }
    }
    const key = JSON.stringify(groupKey(row));
    let group = groups.get(key);
    if (!group) {
      group = { list: [], noConfidenceList: [], modes: {}, undetermined: 0, invalid: 0, invalidConfidence: 0, badFormat: 0, total: 0 };
      groups.set(key, group);
    }
    group.total += 1;
    if (row.__badFormat) {
      group.badFormat += 1;
      continue;
    }
    const mode = String(row.mode ?? '').trim();
    if (EXCLUDED_MODES.includes(mode)) {
      group.modes[mode] = (group.modes[mode] ?? 0) + 1;
      continue;
    }
    const result = parseResult(row.result ?? '');
    if (result === 'undetermined') {
      group.undetermined += 1;
      continue;
    }
    if (result === null) {
      group.invalid += 1;
      continue;
    }
    const working = { result, session: String(row.session ?? '').trim(), confidence: null };
    if (hasConfidence) {
      const confidence = parseConfidence(row.confidence);
      if (confidence.state === 'empty') {
        group.noConfidenceList.push(working);
        continue;
      }
      if (confidence.state === 'invalid') {
        group.invalidConfidence += 1;
        continue;
      }
      working.confidence = confidence.value;
    }
    group.list.push(working);
  }
  if (groups.size === 0) groups.set(JSON.stringify([]), { list: [], noConfidenceList: [], modes: {}, undetermined: 0, invalid: 0, invalidConfidence: 0, badFormat: 0, total: 0 });

  const statusForRatio = (n, k) => {
    if (n < minSupport) return 'too little data';
    if (direction === 'upper') return wilsonUpper(k, n) < target ? 'threshold met' : 'threshold not met';
    return wilsonLower(k, n) >= target ? 'threshold met' : 'threshold not met';
  };

  const resultGroups = [];
  for (const [key, group] of groups) {
    const label = JSON.parse(key);
    const list = group.list;
    const noConfidenceList = group.noConfidenceList;
    const n = list.length + noConfidenceList.length;
    const k = [...list, ...noConfidenceList].reduce((s, r) => s + r.result, 0);
    const hitRate = n === 0 ? null : k / n;
    const lower = wilsonLower(k, n);
    const interval = wilsonInterval(k, n);
    const upper = wilsonUpper(k, n);
    let status;
    let table = null;
    let threshold = null;
    if (!hasConfidence || list.length === 0) {
      // Ratio mode: a file without a confidence column, or a group in which no row has a numeric confidence.
      status = statusForRatio(n, k);
    } else {
      table = sweep(list, { target });
      threshold = selectThreshold(table, { target, minSupport });
      status = threshold === null ? 'no threshold' : 'threshold met';
    }
    // Error by kind, at the chosen threshold (if any): selective = 1 minus hit rate; per-query = coverage times
    // the selective error of the threshold; without a threshold: the error of the whole group.
    let error;
    if (threshold !== null) {
      const selectiveError = threshold.n === 0 ? null : 1 - threshold.k / threshold.n;
      error = kind === 'per-query' ? threshold.coverage * selectiveError : selectiveError;
    } else {
      const selectiveError = n === 0 ? null : 1 - k / n;
      error = selectiveError;
    }
    // "No confidence" subgroup: rows with an empty confidence, measured as a ratio next to the sweep.
    let noConfidence = null;
    if (noConfidenceList.length > 0) {
      const nB = noConfidenceList.length;
      const kB = noConfidenceList.reduce((s, r) => s + r.result, 0);
      noConfidence = {
        n: nB,
        k: kB,
        hitRate: kB / nB,
        lower: wilsonLower(kB, nB),
        interval: wilsonInterval(kB, nB),
        upper: wilsonUpper(kB, nB),
        status: statusForRatio(nB, kB),
      };
    }
    // Holdout: split of the group's sessions; threshold from the fit part (sweep or ratio); the rate on the holdout part at that threshold vs the target, with SLACK_HOLDOUT on the side that matters for the direction.
    let holdoutResult = null;
    if (holdout !== null) {
      const ids = [...new Set([...list, ...noConfidenceList].map((r) => r.session))];
      const { fit, holdout: holdoutSessions } = splitFitHoldout(ids, holdout);
      const fitRows = list.filter((r) => fit.has(r.session));
      const fitNoConfidence = noConfidenceList.filter((r) => fit.has(r.session));
      const holdoutRows = list.filter((r) => holdoutSessions.has(r.session));
      const holdoutNoConfidence = noConfidenceList.filter((r) => holdoutSessions.has(r.session));
      let fitThreshold = null;
      if (hasConfidence && fitRows.length > 0) {
        fitThreshold = selectThreshold(sweep(fitRows, { target }), { target, minSupport });
      }
      const nFit = fitRows.length + fitNoConfidence.length;
      const kFit = [...fitRows, ...fitNoConfidence].reduce((s, r) => s + r.result, 0);
      const fitRatioMet = nFit > 0 && nFit >= minSupport && (direction === 'upper' ? wilsonUpper(kFit, nFit) < target : wilsonLower(kFit, nFit) >= target);
      const hasThreshold = hasConfidence && fitRows.length > 0 ? fitThreshold !== null : fitRatioMet;
      let holdoutStatus;
      let thresholdValue = null;
      let nHoldout = null;
      let kHoldout = null;
      let holdoutHitRate = null;
      if (!hasThreshold) {
        holdoutStatus = 'holdout without threshold';
      } else if (holdoutRows.length + holdoutNoConfidence.length === 0) {
        holdoutStatus = 'holdout without rows';
      } else {
        thresholdValue = hasConfidence && fitRows.length > 0 && fitThreshold !== null ? fitThreshold.threshold : null;
        const accepted = thresholdValue !== null ? holdoutRows.filter((r) => r.confidence >= thresholdValue) : [...holdoutRows, ...holdoutNoConfidence];
        nHoldout = accepted.length;
        kHoldout = accepted.reduce((s, r) => s + r.result, 0);
        holdoutHitRate = nHoldout === 0 ? null : kHoldout / nHoldout;
        if (nHoldout === 0) holdoutStatus = 'holdout unevaluable';
        else if (direction === 'upper') holdoutStatus = holdoutHitRate > target + SLACK_HOLDOUT ? 'holdout_miss' : 'holdout_ok';
        else holdoutStatus = holdoutHitRate < target - SLACK_HOLDOUT ? 'holdout_miss' : 'holdout_ok';
      }
      holdoutResult = { fitSessions: fit.size, holdoutSessions: holdoutSessions.size, threshold: thresholdValue, nHoldout, kHoldout, hitRateHoldout: holdoutHitRate, status: holdoutStatus };
    }
    resultGroups.push({
      fields: groupFields,
      label,
      rows: group.total,
      modes: group.modes,
      undetermined: group.undetermined,
      invalid: group.invalid,
      invalidConfidence: group.invalidConfidence,
      badFormat: group.badFormat,
      n,
      k,
      hitRate,
      lower,
      interval,
      upper,
      error,
      status,
      smallSample: n < SMALL_SAMPLE,
      noConfidence,
      table,
      threshold,
      holdout: holdoutResult,
    });
  }

  const sumCategory = (field) => resultGroups.reduce((s, g) => s + g[field], 0);
  const totalModes = resultGroups.reduce((s, g) => {
    for (const [mode, count] of Object.entries(g.modes)) s[mode] = (s[mode] ?? 0) + count;
    return s;
  }, {});

  return {
    columns,
    hasConfidence,
    direction,
    rowsTotal: sumCategory('rows'),
    excludedModes: totalModes,
    undetermined: sumCategory('undetermined'),
    invalid: sumCategory('invalid'),
    invalidConfidence: sumCategory('invalidConfidence'),
    badFormat: sumCategory('badFormat'),
    period: periodFrom === null ? null : { from: new Date(periodFrom).toISOString(), to: new Date(periodTo).toISOString() },
    target,
    minSupport,
    kind,
    holdout: holdout === null ? null : { fraction: holdout },
    groups: resultGroups,
  };
}

/** Number as text with a dot decimal separator; null means no data. */
function numberText(x, digits = 4) {
  if (x === null || x === undefined) return 'none';
  return x.toFixed(digits);
}

/** One row of a sweep table as text. */
function tableRowText(t) {
  const met = t.meetsTarget === null ? '' : t.meetsTarget ? ' yes' : ' no';
  return [
    numberText(t.threshold, 3),
    String(t.n),
    String(t.k),
    numberText(t.coverage),
    numberText(t.hitRate),
    numberText(t.lower),
    met,
  ].join('\t');
}

/** Text report of the whole analysis (without --json). */
export function textReport(report) {
  const lines = [];
  lines.push(`threshold rule: target ${report.target}, min_support ${report.minSupport}, kind ${report.kind}, direction ${report.direction}${report.holdout !== null ? `, holdout ${report.holdout.fraction}` : ''}`);
  const modesText = Object.entries(report.excludedModes).map(([m, c]) => `${m} ${c}`).join(', ');
  const categories = [
    modesText,
    `undetermined ${report.undetermined}`,
    `invalid ${report.invalid}`,
    `invalid_confidence ${report.invalidConfidence}`,
    `bad_format ${report.badFormat}`,
  ].filter((part) => part !== '');
  lines.push(`denominator: ${report.groups.reduce((s, g) => s + g.n, 0)} (rows in total ${report.rowsTotal}; excluded: ${categories.join('; ')})`);
  if (report.period !== null) lines.push(`period: ${report.period.from} to ${report.period.to}`);
  for (const g of report.groups) {
    const labelText = g.fields.length === 0 ? '' : g.fields.map((p, i) => `${p}=${g.label[i]}`).join(' ') + ': ';
    const measure = report.direction === 'upper' ? `upper Wilson ${numberText(g.upper)}` : `lower Wilson ${numberText(g.lower)}`;
    const groupExcluded = [
      Object.entries(g.modes).map(([m, c]) => `${m} ${c}`).join(', '),
      `undetermined ${g.undetermined}`,
      `invalid ${g.invalid}`,
      `invalid_confidence ${g.invalidConfidence}`,
      `bad_format ${g.badFormat}`,
    ].filter((part) => part !== '' && (!/ 0$/.test(part) || part.startsWith('invalid_confidence') || part.startsWith('bad_format'))).join('; ');
    lines.push(`group ${labelText}n ${g.n}, hits ${g.k} (${numberText(g.hitRate)}), ${measure}, error ${report.kind}: ${numberText(g.error)}, status: ${g.status}`);
    if (g.smallSample) lines.push('  warning: threshold from a small sample (n < 100)');
    lines.push(`  rows of the group: ${g.rows} = n ${g.n} + excluded: ${groupExcluded}`);
    if (g.noConfidence !== null) {
      const b = g.noConfidence;
      lines.push(`  no confidence: n ${b.n}, hits ${b.k} (${numberText(b.hitRate)}), ${report.direction === 'upper' ? `upper Wilson ${numberText(b.upper)}` : `lower Wilson ${numberText(b.lower)}`}, status: ${b.status}`);
    }
    if (g.table !== null) {
      lines.push('  threshold\taccepted\thits\tcoverage\thit rate\tlower Wilson\ttarget');
      for (const t of g.table) lines.push(`  ${tableRowText(t)}`);
      if (g.threshold === null) lines.push(`  chosen threshold: none (status: no threshold); error ${report.kind}: ${numberText(g.error)}`);
      else {
        const t = g.threshold;
        lines.push(`  chosen threshold: ${numberText(t.threshold, 3)} (n ${t.n}, hits ${t.k}, coverage ${numberText(t.coverage)}, hit rate ${numberText(t.hitRate)}, lower ${numberText(t.lower)}); error ${report.kind}: ${numberText(g.error)}`);
      }
    }
    if (g.holdout !== null) {
      const h = g.holdout;
      lines.push(`  holdout: fit sessions ${h.fitSessions}, holdout sessions ${h.holdoutSessions}${h.threshold !== null ? `, threshold ${numberText(h.threshold, 3)}` : ''}${h.nHoldout !== null ? `, accepted ${h.nHoldout}, hits ${h.kHoldout}, hit rate ${numberText(h.hitRateHoldout)}` : ''}; status: ${h.status}`);
    }
  }
  return lines.join('\n');
}

function usage() {
  console.error('usage: node tools/diagnostics/wilson_threshold.mjs --input <file.tsv or -> --target <0-1> [--min-support 30] [--kind selective|per-query] [--direction lower|upper] [--group-by point,spec_version,jev_model] [--holdout <0-0.5>] [--json]');
  console.error('  input: TSV with a header; column result (1|0|executed|ignored|undetermined); optional confidence (0-1), mode, point, spec_version, jev_model, session, ts (ISO 8601)');
  console.error('  --direction upper: in ratio mode the status is "threshold met" when the upper bound (z 1.645) is below the target; not allowed in sweep mode (a confidence column)');
  console.error('  the full description is in the header comment of wilson_threshold.mjs');
}

/** CLI argument parsing: { file, target, minSupport, kind, direction, groupBy, holdout, json }; an unknown argument gives null. */
export function parseArgs(argv) {
  const result = { file: null, target: null, minSupport: DEFAULT_MIN_SUPPORT, kind: 'selective', direction: 'lower', groupBy: null, holdout: null, json: false };
  const number = (text) => {
    if (text === undefined) return NaN;
    return Number(String(text).replace(',', '.'));
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') result.json = true;
    else if (a === '--input' && argv[i + 1] !== undefined) result.file = argv[++i];
    else if (a === '--target' && argv[i + 1] !== undefined) result.target = number(argv[++i]);
    else if (a === '--min-support' && argv[i + 1] !== undefined) result.minSupport = Number(argv[++i]);
    else if (a === '--kind' && argv[i + 1] !== undefined) result.kind = argv[++i];
    else if (a === '--direction' && argv[i + 1] !== undefined) result.direction = argv[++i];
    else if (a === '--group-by' && argv[i + 1] !== undefined) result.groupBy = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--holdout' && argv[i + 1] !== undefined) result.holdout = number(argv[++i]);
    else return null;
  }
  return result;
}

/** Argument validation: an error message, or null. */
export function validateArgs(a) {
  if (a === null) return 'unknown argument';
  if (!a.file) return 'missing --input';
  if (a.target === null || !Number.isFinite(a.target) || a.target < 0 || a.target > 1) return '--target must be a number 0-1';
  if (!Number.isFinite(a.minSupport) || a.minSupport < 0) return '--min-support must be a non-negative number';
  if (a.kind !== 'selective' && a.kind !== 'per-query') return '--kind: selective or per-query';
  if (a.direction !== 'lower' && a.direction !== 'upper') return '--direction: lower or upper';
  if (a.groupBy !== null && (a.groupBy.length === 0 || a.groupBy.some((p) => !GROUP_FIELDS.includes(p)))) return `--group-by: fields from ${GROUP_FIELDS.join(', ')}`;
  if (a.holdout !== null && (!Number.isFinite(a.holdout) || a.holdout <= 0 || a.holdout > 0.5)) return '--holdout: a fraction in (0, 0.5]';
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const problem = validateArgs(args);
  if (problem !== null) {
    console.error(`wilson_threshold: ${problem}`);
    usage();
    process.exitCode = 2;
    return;
  }
  let text;
  try {
    text = args.file === '-' ? readFileSync(0, 'utf8') : readFileSync(args.file, 'utf8');
  } catch (e) {
    console.error(`wilson_threshold: unreadable input file ${args.file}: ${e?.code ?? e?.message ?? e}`);
    process.exitCode = 2;
    return;
  }
  const data = parseTsv(text);
  if (data.columns.length === 0 || !data.columns.includes('result')) {
    console.error('wilson_threshold: file without a header or without the required column result');
    process.exitCode = 2;
    return;
  }
  if (args.holdout !== null && !data.columns.includes('session')) {
    console.error('wilson_threshold: --holdout requires the session column');
    process.exitCode = 2;
    return;
  }
  if (args.direction === 'upper' && data.columns.includes('confidence')) {
    console.error('wilson_threshold: --direction upper works only in ratio mode (a file without the confidence column)');
    process.exitCode = 2;
    return;
  }
  const report = analyze(data, { target: args.target, minSupport: args.minSupport, kind: args.kind, direction: args.direction, groupBy: args.groupBy, holdout: args.holdout });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(textReport(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
