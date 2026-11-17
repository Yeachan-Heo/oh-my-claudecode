#!/usr/bin/env node
// Summary of the denial counter journal (denials.jsonl): counts per event kind and per subject (a Claude session,
// with its agent id when a subagent wrote the row): rows, degrees, results, p50/p95 of the decision-to-outcome time
// in ms, unique keys. It flags the same key with different facts, counts the same event from two journals once (by the
// stable event id) and skips unparseable (truncated) rows of rotated parts. It has no calibration column.
//
// Standalone diagnostic run by hand: it reads files only (no network, no keys). It does not change OMC behaviour and
// is not shipped in the npm package (tools/ is not in the "files" list of package.json).
//
//   node tools/diagnostics/denial_log_summary.mjs [--file <path>]... [--dir <dir>] [--json] [<path>...]
//
// Without file arguments it reads <OMC_JEV_LOG_DIR, else state/jev under the state root of the current directory>/denials.jsonl
// and its rotated parts (denials-YYYYMMDD-HHMMSS.jsonl or denials-YYYYMMDD-HHMMSS-<pid>.jsonl); run it from the project root.
// The state root comes from scripts/lib/state-root.mjs, so it follows OMC_STATE_DIR like the hooks do; when it cannot be
// resolved the tool asks for --dir or OMC_JEV_LOG_DIR.
// A file given on the command line that does not exist is reported with a warning on stderr; the summary and the exit
// code are not changed by it.
// Exit code: 0 summary printed, 2 no journal file found.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The closed vocabularies of the journal rows, as the denial counter writes them (scripts/lib/jev-denial-counter.mjs and the
// handoff rows of scripts/lib/jev-handoff.mjs in the session guards change). They are a copy on purpose: the tool runs from a
// plain repository checkout and must not import the hook library, so it also works on a machine that has only the journal.
export const KINDS = ['denial', 'release', 'state', 'outcome', 'handoff'];
export const RESULTS = ['denied', 'passed'];
export const HANDOFF_EVENTS = ['warning', 'handoff-allowed', 'handoff-subagent', 'handoff-refused', 'handed-over-refused']; // the "action" of a handoff row
export const REASON_CODES = ['guard_denial'];
export const STATES = ['ok', 'broken', 'nan', 'lock-unavailable'];
const DECISION_KINDS = ['denial', 'release', 'state']; // the decision rows; one outcome row references each of them

/** The schema validator of one journal row: returns { ok, errors: [...] }. Unknown extra fields are allowed;
 * required fields are checked per kind. */
export function validateRow(w) {
  const errors = [];
  if (!w || typeof w !== 'object' || Array.isArray(w)) return { ok: false, errors: ['row-not-object'] };
  if (typeof w.ts !== 'string' || Number.isNaN(Date.parse(w.ts))) errors.push('ts');
  if (typeof w.ts_ms !== 'number' || !Number.isFinite(w.ts_ms)) errors.push('ts_ms');
  if (w.point !== 'denial') errors.push('point');
  if (typeof w.id !== 'string' || !/^[0-9a-f]{16}$/.test(w.id)) errors.push('id');
  if (!KINDS.includes(w.kind)) errors.push('kind');
  if (w.session_id !== null && typeof w.session_id !== 'string') errors.push('session_id');
  if (w.agent_id !== null && typeof w.agent_id !== 'string') errors.push('agent_id');
  if (w.truncated !== undefined && w.truncated !== true) errors.push('truncated');
  if (DECISION_KINDS.includes(w.kind)) {
    if (typeof w.guard !== 'string' || !w.guard) errors.push('guard');
    if (typeof w.key !== 'string' || !/^[0-9a-f]{16}$/.test(w.key)) errors.push('key');
    if (w.n !== null && typeof w.n !== 'number') errors.push('n');
    if (w.sessionCount !== null && typeof w.sessionCount !== 'number') errors.push('sessionCount');
    if (typeof w.k !== 'number' || w.k < 1) errors.push('k');
    if (typeof w.maxSession !== 'number' || w.maxSession < 1) errors.push('maxSession');
    if (![0, 1, 2].includes(w.degree)) errors.push('degree');
    if (!RESULTS.includes(w.result)) errors.push('result');
    if (typeof w.action !== 'string' || !w.action) errors.push('action');
    if (w.reason_code !== undefined && !REASON_CODES.includes(w.reason_code)) errors.push('reason_code');
    if (w.effectiveness !== undefined && w.effectiveness !== null) errors.push('effectiveness');
    if (w.state !== undefined && !STATES.includes(w.state)) errors.push('state');
    if (w.tool_name !== undefined && w.tool_name !== null && typeof w.tool_name !== 'string') errors.push('tool_name');
    if (w.tool_use_id !== undefined && w.tool_use_id !== null && typeof w.tool_use_id !== 'string') errors.push('tool_use_id');
  }
  if (w.kind === 'handoff') {
    if (w.guard !== 'handoff') errors.push('guard');
    if (!HANDOFF_EVENTS.includes(w.action)) errors.push('action');
    if (!RESULTS.includes(w.result)) errors.push('result');
    if (w.tool_name !== null && typeof w.tool_name !== 'string') errors.push('tool_name');
    if (w.tool_use_id !== null && typeof w.tool_use_id !== 'string') errors.push('tool_use_id');
    if (w.bytes !== null && (typeof w.bytes !== 'number' || !Number.isFinite(w.bytes) || w.bytes < 0)) errors.push('bytes'); // a number, or null when the size is unknown (e.g. a subagent row)
  }
  if (w.kind === 'outcome') {
    if (typeof w.ref !== 'string' || !/^[0-9a-f]{16}$/.test(w.ref)) errors.push('ref');
    if (w.result !== undefined && !RESULTS.includes(w.result)) errors.push('result');
    if (w.effectiveness !== undefined && w.effectiveness !== null) errors.push('effectiveness-outcome');
  }
  return { ok: errors.length === 0, errors };
}

/** Reading journal files: parseable rows only (a truncated tail of a rotated part is skipped),
 * deduplicated by the stable event id (the same event in two journals counts once). */
export function readJournal(files) {
  const byId = new Map();
  let duplicates = 0;
  let unparseable = 0;
  for (const file of files) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let w;
      try { w = JSON.parse(line); } catch { unparseable += 1; continue; }
      if (!w || typeof w !== 'object' || Array.isArray(w)) { unparseable += 1; continue; }
      const id = typeof w.id === 'string' ? w.id : '';
      if (id && byId.has(id)) { duplicates += 1; continue; }
      if (id) byId.set(id, w); else byId.set(`no-id#${byId.size}`, w);
    }
  }
  return { rows: [...byId.values()], duplicates, unparseable };
}

const percentile = (data, p) => {
  if (!data.length) return null;
  const s = [...data].sort((a, b) => a - b);
  return s[Math.min(s.length, Math.max(1, Math.ceil((p / 100) * s.length))) - 1];
};

const subjectOf = (w) => (w.session_id ? `session ${w.session_id}${w.agent_id ? `/${w.agent_id}` : ''}` : 'no-subject');

/** Aggregation of one group of rows (a kind group or a subject group). */
export function summarizeRows(rows) {
  const byKind = new Map();
  const bySubject = new Map();
  const decisions = new Map(); // id -> ts_ms
  const decisionRows = new Map(); // id -> the decision row
  const outcomes = new Map(); // ref -> delta ms
  const keyFacts = new Map(); // key -> Set(facts)
  // First pass: index all decisions (regardless of file order)
  for (const w of rows) {
    if (w.kind !== 'outcome' && typeof w.id === 'string') { decisions.set(w.id, w.ts_ms); decisionRows.set(w.id, w); }
  }
  // Second pass: process all rows and match outcomes to decisions
  for (const w of rows) {
    for (const [map, g] of [[byKind, w.kind || '?'], [bySubject, subjectOf(w)]]) {
      if (!map.has(g)) map.set(g, { count: 0, degree: {}, result: {}, keys: new Set() });
      const group = map.get(g);
      group.count += 1;
      if (w.degree !== undefined) group.degree[w.degree] = (group.degree[w.degree] || 0) + 1;
      if (w.result !== undefined) group.result[w.result] = (group.result[w.result] || 0) + 1;
      if (typeof w.key === 'string' && w.key) group.keys.add(w.key);
    }
    if (w.kind === 'outcome' && typeof w.ref === 'string' && decisions.has(w.ref) && typeof w.ts_ms === 'number') {
      const delta = w.ts_ms - decisions.get(w.ref);
      if (delta >= 0) outcomes.set(w.ref, delta);
    }
    if (typeof w.key === 'string' && w.key && DECISION_KINDS.includes(w.kind)) {
      if (!keyFacts.has(w.key)) keyFacts.set(w.key, new Set());
      keyFacts.get(w.key).add(`${w.guard || '?'}|${w.result || '?'}`);
    }
  }
  for (const [ref, delta] of outcomes) { // decision-to-outcome deltas go to both group views of the decision
    const d = decisionRows.get(ref);
    if (!d) continue;
    for (const [map, g] of [[byKind, d.kind || '?'], [bySubject, subjectOf(d)]]) {
      const group = map.get(g);
      if (!group) continue;
      group.p50 = group.p50 ?? []; group.p95 = group.p95 ?? [];
      group.p50.push(delta); group.p95.push(delta);
    }
  }
  const build = (map) => [...map.entries()].map(([g, group]) => ({
    group: g,
    count: group.count,
    degree: group.degree,
    result: group.result,
    keys: group.keys.size,
    p50_ms: percentile(group.p50 || [], 50),
    p95_ms: percentile(group.p95 || [], 95),
  })).sort((a, b) => b.count - a.count);
  const differentFacts = [...keyFacts.entries()].filter(([, f]) => f.size > 1).map(([k]) => k);
  return {
    kinds: build(byKind),
    subjects: build(bySubject),
    differentFacts,
    duplicates: null,
    unparseable: null,
  };
}

/** The full summary over files: readJournal + summarizeRows with the duplicate and unparseable counts. */
export function summarize(files) {
  const { rows, duplicates, unparseable } = readJournal(files);
  const result = summarizeRows(rows);
  result.duplicates = duplicates;
  result.unparseable = unparseable;
  result.rows = rows.length;
  result.outOfSchema = rows.filter((w) => !validateRow(w).ok).length;
  return result;
}

const tableRow = (r) => {
  const degree = Object.entries(r.degree || {}).map(([s, l]) => `d${s}=${l}`).join(' ') || '-';
  const result = Object.entries(r.result || {}).map(([k, v]) => `${k}=${v}`).join(' ') || '-';
  return [r.group.slice(0, 40), r.count, degree, result, String(r.keys), r.p50_ms === null ? '-' : r.p50_ms, r.p95_ms === null ? '-' : r.p95_ms].join(' | ');
};

const HEADER = 'group | rows | degrees | results | keys | p50_ms | p95_ms';

const printTable = (title, rows) => {
  console.log(`== ${title}`);
  if (!rows.length) { console.log('  (none)'); return; }
  console.log(HEADER);
  for (const r of rows) console.log(tableRow(r));
};

const USAGE = 'usage: node denial_log_summary.mjs [--file <path>]... [--dir <dir>] [--json] [<path>...]\n'
  + 'default directory: $OMC_JEV_LOG_DIR, else state/jev under the state root of the current directory\n'
  + '(the state root follows OMC_STATE_DIR); pass --dir or set OMC_JEV_LOG_DIR when it cannot be resolved';

// The default Jev log directory: the same state root the hooks use (it follows OMC_STATE_DIR). The module is imported
// on demand so that reading explicit files or a given directory works without it.
async function defaultLogDir() {
  try {
    const { resolveOmcStateRoot } = await import('../../scripts/lib/state-root.mjs');
    return join(await resolveOmcStateRoot(process.cwd()), 'state', 'jev');
  } catch (e) {
    console.error(`denial_log_summary: cannot resolve the state root (${e && e.message ? e.message : e}); pass the journal directory with --dir or set OMC_JEV_LOG_DIR`);
    process.exit(2);
  }
}

export function parseArgs(argv) {
  const opts = { files: [], positional: [], dir: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') opts.files.push(argv[++i]);
    else if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--help') opts.help = true;
    else if (!a.startsWith('--')) opts.positional.push(a); // positional paths, a convenience
  }
  return opts;
}

const main = async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }
  const files = [...opts.files];
  let dir = opts.dir;
  if (!files.length && !dir) dir = process.env.OMC_JEV_LOG_DIR || await defaultLogDir();
  files.push(...opts.positional); // positional paths come after the default directory decision
  for (const file of files) {
    if (!existsSync(file)) console.error(`denial_log_summary: warning: file not found: ${file}`);
  }
  if (dir) {
    let names = [];
    try { names = readdirSync(dir).filter((n) => n === 'denials.jsonl' || /^denials-\d{8}-\d{6}(-\d+)?\.jsonl$/.test(n)).sort(); } catch { /* no directory */ }
    for (const n of names) files.push(join(dir, n));
  }
  if (!files.length) {
    console.error('denial_log_summary: no denials.jsonl journal files found');
    process.exit(2);
  }
  const result = summarize(files);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`files: ${files.length}, rows: ${result.rows}, duplicates (counted once): ${result.duplicates}, outside schema: ${result.outOfSchema}, unparseable (truncated): ${result.unparseable}`);
  for (const k of result.differentFacts) console.log(`DIFFERENT-FACTS key=${k}: the same key with different facts (guard/result)`);
  printTable('by event kind (kind)', result.kinds);
  printTable('by subject (session)', result.subjects);
};

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) await main();
