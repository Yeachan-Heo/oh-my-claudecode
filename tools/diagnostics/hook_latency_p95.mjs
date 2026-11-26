#!/usr/bin/env node
// Offline p50, p95 and max of OMC hook run times (hooks that do not call a model), from the hook logs.
// Reads only the time field and the event discriminator of each row; no request content is read or printed.
// Standalone diagnostic run by hand: it reads files only (no network, no keys). It does not change OMC behaviour and is not
// shipped in the npm package (tools/ is not in the "files" list of package.json).
//
//   node tools/diagnostics/hook_latency_p95.mjs [--dir <log dir>] [--shell-checks-dir <dir>] [--days <N>] [--hook-max-ms <ms>]
//                             [--process-max-ms <ms>] [--total-max-ms <ms>] [--hooks-json <hooks.json or settings.json>]...
//                             [--now <ISO time>]
//   node tools/diagnostics/hook_latency_p95.mjs --help | -h     print the options and exit 0
//
// Configuration, highest precedence first:
//   log dir        --dir <dir>            | OMC_JEV_LOG_DIR            | <state root>/state/jev
//   shell checks   --shell-checks-dir <d> | OMC_SHELL_CHECKS_LOG_DIR   | <state root>/state/shell-checks
//   days           --days <N>             | HOOK_LATENCY_DAYS          | 7
//   per-hook limit --hook-max-ms <ms>     | HOOK_LATENCY_HOOK_MAX_MS   | 40
//   process limit  --process-max-ms <ms>  | OMC_HOOK_PROCESS_MAX_MS    | none (see hook-timing.jsonl below)
//   total limit    --total-max-ms <ms>    | HOOK_LATENCY_TOTAL_MAX_MS  | 60
//   now (tests)    --now <ISO time>       | HOOK_LATENCY_NOW           | the system clock
// <state root> is the one the hooks use for the current directory (scripts/lib/state-root.mjs, so it follows OMC_STATE_DIR); run the
// tool from the project root. When it cannot be resolved the home directory (<home>/.omc) is used. scripts/run.cjs does not resolve
// it: without OMC_JEV_LOG_DIR it writes hook-timing.jsonl to <home>/.omc/state/jev. So when neither --dir nor OMC_JEV_LOG_DIR is given,
// the tool also reads hook-timing*.jsonl from <home>/.omc/state/jev (a file reached through both directories is read once); give
// either of them, and set OMC_JEV_LOG_DIR the same way for the hooks, to read one directory only. A directory that was given (option or
// variable) must exist (exit 2 otherwise); a default directory that does not exist is skipped.
//
// Where a time exists; every other hook has NO time in any log and is listed with n=0 when --hooks-json is given (never guessed):
//   kind partial  checks.jsonl in the shell-checks dir, rows with point shell-check, field durationMs = the shell checks inside the
//                 PreToolUse enforcer only (Bash and PowerShell calls, node start and the rest of the enforcer not included): a lower
//                 bound for that hook
//   kind whole    hook-timing.jsonl in the log dir (written by scripts/run.cjs with OMC_HOOK_TIMING=1): rows {ts, hook, ms}, ms = the
//                 whole run.cjs process (node start included), grouped by the hook field (script name plus arguments). A group is named
//                 Event:script when a --hooks-json entry has the same script (exact arguments first, else the only entry of that
//                 script), so the listing below does not repeat it; without a match the name is the script and its arguments. The
//                 run.cjs row of a script that also has a partial row (the PreToolUse enforcer) is named "<name> (process)". These
//                 rows are judged against --process-max-ms only: no limit set (or an empty OMC_HOOK_PROCESS_MAX_MS) gives flag
//                 NO_PROCESS_LIMIT (no verdict against the per-hook limit), a limit with fewer than 30 samples gives
//                 TOO_FEW_SAMPLES, otherwise OVER above the limit. They are not part of the TOTAL row (see below).
//   kind model    compaction.jsonl in the log dir, rows with event compact, field duration_ms = the compaction module including its
//                 Jev model calls: shown, but not compared with the limits and not part of the total (a model wait has its own budget)
//   shadow.jsonl durationMs is the wait for a model answer, so it is not read at all.
// Rotated logs (name-YYYYMMDD-HHMMSS.jsonl, or name-YYYYMMDD-HHMMSS-<pid>.jsonl) are read too; files not modified inside the window are
// skipped.
//
// Output: TSV on stdout: hook, source, kind, n, p50_ms, p95_ms, max_ms, flag. Percentiles use the nearest-rank method. A partial hook
// gets OVER when its p95 is above --hook-max-ms and otherwise LOWER_BOUND_ONLY (the measured part is a lower bound, so it can never
// show that the hook meets the limit); a model hook gets n/a.
// The TOTAL row is the plain sum of the per-hook p95 over the measured hooks of kind whole and partial outside hook-timing.jsonl
// (hook logic time; the hook-timing.jsonl rows are whole-process times on another scale and are not in it; with the logs above this
// is the shell checks of the enforcer alone). It is NOT a p95 of a tool
// call and NOT a bound (percentiles are not additive, the hooks run at different rates, and hooks without a time are missing from it);
// its source column states the coverage (measured hooks of all listed hooks; the listing needs --hooks-json). It gets OVER above
// --total-max-ms, otherwise PARTIAL_COVERAGE. When hook-timing.jsonl has rows, a TOTAL_PROCESS row follows with the plain sum of
// their p95: information only, flag NO_VERDICT, with the same caveats as TOTAL and no limit applied to it.
// The window, the directories and files read, and the row counts go to stderr.
// Exit code: 0, also for empty data (all n are 0); 2 for a bad argument or an unreadable log dir or log file.

import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DAY_MS = 86_400_000;
const MIN_SAMPLES = 30; // a limit verdict needs at least this many samples per hook

export const SOURCES = [
  { hook: 'PreToolUse:pre-tool-enforcer', file: 'checks', dir: 'shell', field: 'durationMs', match: (r) => r.point === 'shell-check', kind: 'partial' },
  { hook: 'PreCompact:jev-compaction', file: 'compaction', field: 'duration_ms', match: (r) => r.event === 'compact', kind: 'model' },
];
// hook-timing.jsonl has no fixed hook: one group per value of the row field `hook` (see mapTimingGroups).
const TIMING = { file: 'hook-timing', field: 'ms', group: 'hook', kind: 'whole' };

const USAGE = `usage: node tools/diagnostics/hook_latency_p95.mjs [options]

Offline p50, p95 and max of OMC hook run times from the hook logs; TSV on stdout, window, directories and files read on stderr.

options (each takes a value; the variable in brackets is used when the option is not given):
  --dir <dir>               Jev log directory [OMC_JEV_LOG_DIR]; default <state root>/state/jev, plus <home>/.omc/state/jev for
                            hook-timing*.jsonl when neither the option nor the variable is given
  --shell-checks-dir <dir>  shell-checks directory [OMC_SHELL_CHECKS_LOG_DIR]; default <state root>/state/shell-checks
  --days <N>                window in days [HOOK_LATENCY_DAYS]; default 7
  --hook-max-ms <ms>        limit for the hook logic time [HOOK_LATENCY_HOOK_MAX_MS]; default 40
  --process-max-ms <ms>     limit for the whole-process time of hook-timing.jsonl rows [OMC_HOOK_PROCESS_MAX_MS]; default none
  --total-max-ms <ms>       limit for the TOTAL row [HOOK_LATENCY_TOTAL_MAX_MS]; default 60
  --hooks-json <file>       a hooks.json or settings.json whose hooks are listed (repeatable)
  --now <ISO time>          end of the window [HOOK_LATENCY_NOW]; default the system clock
  --help, -h                print this text and exit 0

exit code: 0 (also for empty data), 2 for a bad argument or an unreadable log directory or file
`;

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

function fmt(x) {
  return x === null ? '-' : String(Math.round(x * 10) / 10);
}

function logFiles(dir, name, cutoffMs) {
  const re = new RegExp(`^${name}(-\\d{8}-\\d{6}(-\\d+)?)?\\.jsonl$`);
  return readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f)).filter((p) => statSync(p).mtimeMs >= cutoffMs).sort();
}

async function readSamples(path, sources, cutoffMs, endMs, out, stats, groups) {
  try {
    await readSampleLines(path, sources, cutoffMs, endMs, out, stats, groups);
  } catch (e) { // a log file that cannot be read stops the run; the system message may not name the path
    if (e && e.code && !String(e.message).includes(path)) throw new Error(`cannot read ${path}: ${e.code}`);
    throw e;
  }
}

async function readSampleLines(path, sources, cutoffMs, endMs, out, stats, groups) {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { stats.bad++; continue; }
    const t = typeof row?.ts === 'string' ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(t)) { stats.bad++; continue; }
    if (t < cutoffMs || t > endMs) continue;
    for (const s of sources) {
      if (s.group) {
        const key = typeof row[s.group] === 'string' ? row[s.group].trim() : '';
        const v = row[s.field];
        if (!key || typeof v !== 'number' || !Number.isFinite(v) || v < 0) { stats.noTime++; continue; }
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(v);
        stats.rows++;
        continue;
      }
      if (!s.match(row)) continue;
      const v = row[s.field];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) { stats.noTime++; continue; }
      out.get(s.hook).push(v);
      stats.rows++;
    }
  }
}

// Hook entries ({name: Event:script, script, args}) listed in a hooks.json or settings.json, from its `hooks` section only. A hook is
// either one command text or, as in hooks/hooks.json, a program in `command` with its arguments in the array `args`; the two are joined.
// args is the text after the script path of the command, quotes dropped and spaces collapsed (empty when there is none).
export function listHookEntries(file) {
  const found = [];
  let hooks;
  try {
    hooks = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file))).hooks ?? {};
  } catch (e) { // the file is named on the command line: it must be readable, valid UTF-8 and JSON, and the message names it
    throw new Error(`cannot read ${file}: ${e && e.code === 'ERR_ENCODING_INVALID_ENCODED_DATA' ? 'not valid UTF-8' : e && e.code ? e.code : e.message}`);
  }
  for (const [event, entries] of Object.entries(hooks)) {
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        const command = [h.command ?? h.type ?? '', ...(Array.isArray(h.args) ? h.args : [])].map(String).join(' ');
        const last = [...command.matchAll(/[^\s"']+\.(?:mjs|cjs|js|py|sh|ts)\b/g)].pop();
        const script = last ? basename(last[0]).replace(/\.[^.]+$/, '') : String(h.type ?? 'inline');
        const args = last ? command.slice(last.index + last[0].length).replace(/["']/g, '').trim().replace(/\s+/g, ' ') : '';
        found.push({ name: `${event}:${script}`, script, args });
      }
    }
  }
  return found;
}

// Hook names (Event:script) listed in a hooks.json or settings.json, from its `hooks` section only.
export function listHooks(file) {
  return listHookEntries(file).map((e) => e.name);
}

// Names the hook-timing groups: script and arguments from the row field `hook` against the --hooks-json entries (see the header).
function mapTimingGroups(groups, entries) {
  const named = new Map();
  for (const [key, samples] of groups) {
    const [file, ...rest] = key.split(/\s+/);
    const script = file.replace(/\.[^.]+$/, '');
    const args = rest.join(' ');
    const candidates = entries.filter((e) => e.script === script);
    const pick = candidates.find((e) => e.args === args) ?? (candidates.length === 1 ? candidates[0] : null);
    const base = pick ? pick.name : key;
    const name = SOURCES.some((s) => s.hook === base) ? `${base} (process)` : base;
    if (!named.has(name)) named.set(name, { name, base, matched: Boolean(pick), samples: [] });
    for (const sample of samples) named.get(name).samples.push(sample); // a spread of a long array overflows the call stack
  }
  return [...named.values()].sort((x, y) => x.name.localeCompare(y.name));
}

export async function measure({ dir, shellDir = null, extraDirs = [], days, hookMax, processMax = null, totalMax, now, hooksJson = [] }) {
  const endMs = now;
  const cutoffMs = now - days * DAY_MS;
  const out = new Map(SOURCES.map((s) => [s.hook, []]));
  const groups = new Map();
  const stats = { rows: 0, bad: 0, noTime: 0, files: [], dirs: [] };
  const byFile = [...new Set(SOURCES.map((s) => s.file))].map((n) => [n, SOURCES.filter((s) => s.file === n)]);
  byFile.push([TIMING.file, [TIMING]]);
  const seenFiles = new Set(); // real paths: a file reached through two directories is read once
  for (const [name, sources] of byFile) {
    const wheres = sources[0].dir === 'shell' ? [shellDir] : name === TIMING.file ? [dir, ...extraDirs] : [dir];
    for (const where of wheres) {
      if (!where || !existsSync(where)) continue; // main() has already refused a directory that was given and does not exist
      const realDir = realpathSync(where);
      if (!stats.dirs.includes(realDir)) stats.dirs.push(realDir);
      for (const path of logFiles(where, name, cutoffMs)) {
        const real = realpathSync(path);
        if (seenFiles.has(real)) continue;
        seenFiles.add(real);
        stats.files.push(path);
        await readSamples(path, sources, cutoffMs, endMs, out, stats, groups);
      }
    }
  }
  const entries = hooksJson.flatMap(listHookEntries);
  const timing = mapTimingGroups(groups, entries);
  const rows = [];
  const counted = new Set(); // distinct hooks in the sum of logic times
  let total = null;
  let processTotal = null; // sum over the whole-process rows of hook-timing.jsonl: information only
  let processCount = 0;
  for (const s of SOURCES) {
    const v = out.get(s.hook).sort((a, b) => a - b);
    const p95 = percentile(v, 0.95);
    let flag = '';
    if (s.kind === 'model') flag = 'n/a';
    else if (p95 !== null) flag = p95 > hookMax ? 'OVER' : s.kind === 'partial' ? 'LOWER_BOUND_ONLY' : '';
    rows.push({ hook: s.hook, source: `${s.file}.jsonl:${s.field}`, kind: s.kind, n: v.length, p50: percentile(v, 0.5), p95, max: v.length ? v[v.length - 1] : null, flag });
    if (s.kind !== 'model' && p95 !== null) { total = (total ?? 0) + p95; counted.add(s.hook); }
  }
  const known = new Set(SOURCES.map((s) => s.hook));
  for (const g of timing) {
    const v = g.samples.sort((a, b) => a - b);
    const p95 = percentile(v, 0.95);
    let flag = '';
    if (p95 !== null) flag = processMax === null ? 'NO_PROCESS_LIMIT' : v.length < MIN_SAMPLES ? 'TOO_FEW_SAMPLES' : p95 > processMax ? 'OVER' : '';
    rows.push({ hook: g.name, source: `${TIMING.file}.jsonl:${TIMING.field}`, kind: TIMING.kind, n: v.length, p50: percentile(v, 0.5), p95, max: v[v.length - 1], flag });
    if (p95 !== null) { processTotal = (processTotal ?? 0) + p95; processCount++; }
    if (g.matched) known.add(g.base);
  }
  for (const e of entries) {
    if (known.has(e.name)) continue;
    known.add(e.name);
    rows.push({ hook: e.name, source: '-', kind: 'none', n: 0, p50: null, p95: null, max: null, flag: '' });
  }
  const listed = new Set(rows.filter((r) => r.kind !== 'model' && r.kind !== 'sum').map((r) => r.hook.replace(/ \(process\)$/, ''))).size;
  const measured = counted.size;
  const coverage = hooksJson.length ? `${measured} of ${listed} listed hooks` : `${measured} measured hooks, coverage unknown without --hooks-json`;
  rows.push({ hook: 'TOTAL', source: `sum of per-hook p95 over the measured subset, not a call p95 and not a bound; ${coverage}`, kind: 'sum', n: null, p50: null, p95: total, max: null, flag: total === null ? '' : total > totalMax ? 'OVER' : 'PARTIAL_COVERAGE' });
  if (processTotal !== null) rows.push({ hook: 'TOTAL_PROCESS', source: `sum of per-hook p95 of the whole-process times of hook-timing.jsonl (node start included), information only, no limit applied, not a call p95 and not a bound; ${processCount} hooks`, kind: 'sum', n: null, p50: null, p95: processTotal, max: null, flag: 'NO_VERDICT' });
  return { rows, stats, cutoffMs, endMs };
}

export function toTsv(rows) {
  const head = ['hook', 'source', 'kind', 'n', 'p50_ms', 'p95_ms', 'max_ms', 'flag'].join('\t');
  return [head, ...rows.map((r) => [r.hook, r.source, r.kind, r.n ?? '-', fmt(r.p50), fmt(r.p95), fmt(r.max), r.flag].join('\t'))].join('\n') + '\n';
}

// The default directories are those of the hooks: the state root of the current directory (it follows OMC_STATE_DIR), as in
// denial_log_summary.mjs; the home directory when the state root cannot be resolved.
async function defaultDirs() {
  let root = join(homedir(), '.omc');
  try {
    const { resolveOmcStateRoot } = await import('../../scripts/lib/state-root.mjs');
    root = await resolveOmcStateRoot(process.cwd());
  } catch { /* the home directory */ }
  return { jev: join(root, 'state', 'jev'), shell: join(root, 'state', 'shell-checks'), homeJev: join(homedir(), '.omc', 'state', 'jev') };
}

function parseArgs(argv, env, defaults) {
  const a = { dir: env.OMC_JEV_LOG_DIR || defaults.jev, dirGiven: Boolean(env.OMC_JEV_LOG_DIR), days: env.HOOK_LATENCY_DAYS ?? 7, hookMax: env.HOOK_LATENCY_HOOK_MAX_MS ?? 40, processMax: env.OMC_HOOK_PROCESS_MAX_MS || null, totalMax: env.HOOK_LATENCY_TOTAL_MAX_MS ?? 60, now: env.HOOK_LATENCY_NOW ?? null, hooksJson: [], shellDir: env.OMC_SHELL_CHECKS_LOG_DIR || defaults.shell, shellDirGiven: Boolean(env.OMC_SHELL_CHECKS_LOG_DIR) };
  const flags = { '--dir': 'dir', '--days': 'days', '--hook-max-ms': 'hookMax', '--process-max-ms': 'processMax', '--total-max-ms': 'totalMax', '--now': 'now', '--hooks-json': 'hooksJson', '--shell-checks-dir': 'shellDir' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]];
    if (!key || i + 1 >= argv.length) throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    if (key === 'hooksJson') a.hooksJson.push(argv[i + 1]); else a[key] = argv[i + 1];
    if (key === 'dir') a.dirGiven = true;
    if (key === 'shellDir') a.shellDirGiven = true;
  }
  for (const k of ['days', 'hookMax', 'processMax', 'totalMax']) {
    if (a[k] === null) continue; // processMax has no default: without it the whole-process rows get no verdict
    a[k] = Number(a[k]);
    if (!Number.isFinite(a[k]) || a[k] <= 0) throw new Error(`${k} must be a positive number`);
  }
  // scripts/run.cjs writes hook-timing.jsonl to the home directory unless OMC_JEV_LOG_DIR is set, so without a given directory that
  // place is read as well (main() skips it when it does not exist)
  a.extraDirs = a.dirGiven ? [] : [defaults.homeJev];
  a.now = a.now === null ? Date.now() : Date.parse(a.now);
  if (!Number.isFinite(a.now)) throw new Error('--now must be an ISO time');
  return a;
}

async function main() {
  if (process.argv.slice(2).some((x) => x === '--help' || x === '-h')) {
    process.stdout.write(USAGE);
    return;
  }
  let args;
  try {
    args = parseArgs(process.argv.slice(2), process.env, await defaultDirs());
    if (args.dirGiven && (!existsSync(args.dir) || !statSync(args.dir).isDirectory())) throw new Error(`log dir not found or not a directory: ${args.dir}`);
    if (args.shellDirGiven && (!existsSync(args.shellDir) || !statSync(args.shellDir).isDirectory())) throw new Error(`shell-checks dir not found or not a directory: ${args.shellDir}`);
    for (const f of args.hooksJson) if (!existsSync(f)) throw new Error(`file not found: ${f}`);
  } catch (e) {
    process.stderr.write(`hook_latency_p95: ${e.message}\n`);
    process.exit(2);
  }
  let result;
  try {
    result = await measure(args);
  } catch (e) {
    process.stderr.write(`hook_latency_p95: ${e.message}\n`);
    process.exit(2);
  }
  const { rows, stats, cutoffMs, endMs } = result;
  process.stdout.write(toTsv(rows));
  const note = `window ${new Date(cutoffMs).toISOString()} .. ${new Date(endMs).toISOString()} (${args.days} days); directories ${stats.dirs.length}: ${stats.dirs.join(' ') || '-'}; files ${stats.files.length}: ${stats.files.join(' ') || '-'}; samples ${stats.rows}; unparsable rows ${stats.bad}; rows without a usable time ${stats.noTime}; limits per hook ${args.hookMax} ms, process ${args.processMax === null ? 'no limit' : `${args.processMax} ms`}, total ${args.totalMax} ms`;
  process.stderr.write(note + '\n');
  if (stats.rows === 0) process.stderr.write('no samples in the window\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
