#!/usr/bin/env node
// Counts what the `intent` judgment point cost and whether its answer could
// change anything, from a Jev shadow log (shadow.jsonl). Makes no API call and
// needs no key. Prints counts only, never prompt text.
//
//   node measure-intent.mjs <shadow.jsonl> [--since ISO] [--until ISO]
//                           [--labels labels.jsonl] [--json]
//
// labels.jsonl (optional): one JSON object per line, {"ts": "<ts of the row>",
// "label": "yes" | "no"}; "yes" means the prompt really is an Intent-intake
// request. Rows are joined on `ts`.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const asJson = args.includes('--json');
if (asJson) args.splice(args.indexOf('--json'), 1);
const since = flag('--since');
const until = flag('--until');
const labelsPath = flag('--labels');
const logPath = args[0];
if (!logPath) {
  console.error('usage: node measure-intent.mjs <shadow.jsonl> [--since ISO] [--until ISO] [--labels labels.jsonl] [--json]');
  process.exit(2);
}

async function* lines(path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      yield undefined; // counted as unreadable
    }
  }
}

const labels = new Map();
if (labelsPath) {
  for await (const row of lines(labelsPath)) {
    if (row && typeof row.ts === 'string' && (row.label === 'yes' || row.label === 'no')) labels.set(row.ts, row.label);
  }
}

const inRange = (ts) => (!since || ts >= since) && (!until || ts <= until);
const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);

let unreadable = 0;
let allRows = 0;
const byMode = {};
const intentActive = []; // answered or not
// The keyword-detector hook asks these three points one after the other for the
// same prompt; rows that carry a prompt_id can be summed per prompt.
const PROMPT_POINTS = new Set(['skill-trigger', 'intent', 'task-size']);
const perPrompt = new Map();
for await (const row of lines(logPath)) {
  if (!row) {
    unreadable += 1;
    continue;
  }
  if (typeof row.ts !== 'string' || !inRange(row.ts)) continue;
  allRows += 1;
  if (row.mode === 'active' && PROMPT_POINTS.has(row.point) && row.prompt_id && typeof row.durationMs === 'number') {
    const e = perPrompt.get(row.prompt_id) ?? { ms: 0, points: new Set() };
    e.ms += row.durationMs;
    e.points.add(row.point);
    perPrompt.set(row.prompt_id, e);
  }
  if (row.point !== 'intent') continue;
  byMode[row.mode] = (byMode[row.mode] ?? 0) + 1;
  if (row.mode === 'active') intentActive.push(row);
}

const answered = intentActive.filter((r) => typeof r.jev?.noul === 'number');
const emptyPrompt = answered.filter((r) => String(r.state?.prompt ?? '').trim() === '');
const durations = intentActive.map((r) => r.durationMs).filter((d) => typeof d === 'number').sort((a, b) => a - b);
const band = (r) => (r.jev.noul < 0.2 ? 'below 0.2' : r.jev.noul < 0.5 ? '0.2 to 0.5' : '0.5 and above');
const bands = { 'below 0.2': 0, '0.2 to 0.5': 0, '0.5 and above': 0 };
for (const r of answered) bands[band(r)] += 1;

// With OMC_JEV_INTENT_APPLY=1 an answer of 0.5 or more adds the intent skill
// unless it is already there. The slash heuristic (`/intent` typed at the start
// of the prompt) is what puts it there, so heuristic === true rows change nothing.
// Without the variable the answer changes nothing by construction.
const flagged = answered.filter((r) => r.jev.noul >= 0.5);
const flaggedHeuristicFalse = flagged.filter((r) => r.heuristic !== true);

const perMinute = new Map();
for (const r of intentActive) {
  const minute = r.ts.slice(0, 16);
  perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
}

const promptSums = [...perPrompt.values()].filter((e) => e.points.has('intent')).map((e) => e.ms).sort((a, b) => a - b);

const report = {
  log_rows_in_range: allRows,
  unreadable_lines: unreadable,
  intent_rows_by_mode: byMode,
  intent_active_rows: intentActive.length,
  intent_active_answered: answered.length,
  intent_share_of_all_rows: allRows ? intentActive.length / allRows : null,
  empty_sanitized_prompt: emptyPrompt.length,
  wait_ms: {
    rows_with_duration: durations.length,
    sum_s: Math.round(durations.reduce((a, b) => a + b, 0) / 100) / 10,
    median: quantile(durations, 0.5),
    p95: quantile(durations, 0.95),
    max: durations.length ? durations[durations.length - 1] : null,
  },
  prompts_with_intent_and_prompt_id: promptSums.length,
  keyword_detector_wait_per_prompt_ms: { median: quantile(promptSums, 0.5), p95: quantile(promptSums, 0.95), max: promptSums.length ? promptSums[promptSums.length - 1] : null, over_8000: promptSums.filter((ms) => ms > 8000).length },
  noul_bands: bands,
  answer_can_change_output: {
    without_INTENT_APPLY: 0,
    with_INTENT_APPLY_noul_ge_0_5: flagged.length,
    of_which_skill_not_already_selected_by_slash: flaggedHeuristicFalse.length,
  },
  peak_intent_requests_in_one_utc_minute: Math.max(0, ...perMinute.values()),
};

if (labelsPath) {
  const joined = answered.filter((r) => labels.has(r.ts));
  const at = (t) => {
    const f = joined.filter((r) => r.jev.noul >= t);
    const yes = f.filter((r) => labels.get(r.ts) === 'yes').length;
    return { flagged_and_labelled: f.length, labelled_yes: yes, labelled_no: f.length - yes };
  };
  report.labels = {
    labelled_rows_joined: joined.length,
    labelled_yes_total: joined.filter((r) => labels.get(r.ts) === 'yes').length,
    by_threshold: { '0.5': at(0.5), '0.7': at(0.7), '0.8': at(0.8) },
  };
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)} %` : 'n/a');
  const out = [];
  out.push(`log rows in range: ${allRows} (unreadable lines: ${unreadable})`);
  out.push(`intent rows by mode: ${JSON.stringify(byMode)}`);
  out.push(`intent active rows: ${intentActive.length} (${pct(intentActive.length, allRows)} of all rows), answered with a number: ${answered.length}`);
  out.push(`empty sanitized prompt among answered: ${emptyPrompt.length} (${pct(emptyPrompt.length, answered.length)})`);
  out.push(`resolver time logged, ms: n=${durations.length} sum=${report.wait_ms.sum_s} s median=${report.wait_ms.median} p95=${report.wait_ms.p95} max=${report.wait_ms.max}`);
  out.push(`prompts with an intent row and a prompt_id: ${promptSums.length}; resolver time summed over skill-trigger, intent and task-size per prompt, ms: median=${report.keyword_detector_wait_per_prompt_ms.median} p95=${report.keyword_detector_wait_per_prompt_ms.p95} max=${report.keyword_detector_wait_per_prompt_ms.max}, over 8000 (the run.cjs cap of keyword-detector.mjs): ${report.keyword_detector_wait_per_prompt_ms.over_8000}`);
  out.push(`noul bands: ${JSON.stringify(bands)}`);
  out.push(`answer can change the hook output: without OMC_JEV_INTENT_APPLY 0 of ${answered.length}; with it ${flagged.length} of ${answered.length} (${pct(flagged.length, answered.length)}), of which ${flaggedHeuristicFalse.length} where /intent was not already typed`);
  out.push(`peak intent requests in one UTC minute: ${report.peak_intent_requests_in_one_utc_minute}`);
  if (report.labels) {
    out.push(`labels joined: ${report.labels.labelled_rows_joined}, labelled yes in total: ${report.labels.labelled_yes_total}`);
    for (const [t, v] of Object.entries(report.labels.by_threshold)) {
      out.push(`  noul >= ${t}: ${v.flagged_and_labelled} flagged and labelled, ${v.labelled_yes} yes, ${v.labelled_no} no`);
    }
  }
  console.log(out.join('\n'));
}
