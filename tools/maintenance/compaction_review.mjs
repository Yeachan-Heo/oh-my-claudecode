#!/usr/bin/env node
// Review of the compaction journal: did the host answer with API errors or placeholder results after a compaction that kept
// thinking blocks in the tail of an agent's messages?
//
//   node compaction_review.mjs --from <time> [--log <compaction.jsonl>] [--projects <dir>] [--json] [--full]
//
// --from      start of the record window (required; local time, for example 2026-01-01T10:00:00, or ISO with Z)
// --log       compaction journal (default $OMC_JEV_LOG_DIR/compaction.jsonl, else state/jev/compaction.jsonl under the state
//             root of the current directory, which follows OMC_STATE_DIR like the hooks; pass --log or set OMC_JEV_LOG_DIR
//             when the state root cannot be resolved)
// --projects  transcripts directory (default $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects)
// --json      also print the result as one JSON line
// --full      print every file (by default only files with a record or with an error after the boundary; the rest is in the sums)
// Exit code: 0 no 400 errors and no placeholder results after the boundaries, 1 at least one, 2 input error.
//
// What it does: takes the `event: compact` records with `kept_thinking > 0` from the journal, from --from on. For every transcript
// file (the main session `<project>/<session>.jsonl` and the agents `<project>/<session>/subagents/agent-<agent>.jsonl`) it counts
// the lines AFTER the earliest boundary with such a record (for a file with its own record) or after the earliest boundary of the
// session (the other agents of that session, separately), and for comparison the lines BEFORE the boundary in the same file:
//   - API errors: assistant lines with isApiErrorMessage=true or model `<synthetic>` whose text starts with `API Error`
//     (among them 400, and of those the ones with the word thinking/invalid), system lines with an API error;
//   - placeholder results: user lines with a tool_result whose content starts with `[Tool result missing`.
// Lines `api-request-blob`, `attachment` and `queue-operation` (request copies, hooks, queue) are skipped because they quote
// text; placeholder results in blobs are counted separately as information. Prints only counts, short ids (8 characters) and
// file names. Node 20+, built-in modules only. The transcript layout comes from the host and can change between host versions.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE = 'usage: node compaction_review.mjs --from <time> [--log <compaction.jsonl>] [--projects <dir>] [--json] [--full]\n'
  + 'default journal: $OMC_JEV_LOG_DIR/compaction.jsonl, else state/jev/compaction.jsonl under the state root of the current\n'
  + 'directory (the state root follows OMC_STATE_DIR); pass --log or set OMC_JEV_LOG_DIR when it cannot be resolved';

function parseArgs(argv) {
  const opts = { from: null, log: null, projects: null, json: false, full: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) { console.error(`missing value for ${a}`); process.exit(2); } return v; };
    if (a === '--from') opts.from = value();
    else if (a === '--log') opts.log = value();
    else if (a === '--projects') opts.projects = value();
    else if (a === '--json') opts.json = true;
    else if (a === '--full') opts.full = true;
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else { console.error(`unknown option: ${a}`); process.exit(2); }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.from === null) { console.error(`--from is required\n${USAGE}`); process.exit(2); }
const from = Date.parse(opts.from);
if (!Number.isFinite(from)) { console.error(`bad time for --from: ${opts.from}`); process.exit(2); }
// The default Jev log directory: the same state root the hooks use (it follows OMC_STATE_DIR).
async function defaultLogDir() {
  try {
    const { resolveOmcStateRoot } = await import('../../scripts/lib/state-root.mjs');
    return join(await resolveOmcStateRoot(process.cwd()), 'state', 'jev');
  } catch (e) {
    console.error(`cannot resolve the state root (${e && e.message ? e.message : e}); pass the journal with --log or set OMC_JEV_LOG_DIR`);
    process.exit(2);
  }
}
const logFile = opts.log || join(process.env.OMC_JEV_LOG_DIR || await defaultLogDir(), 'compaction.jsonl');
const projects = opts.projects || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
if (!existsSync(logFile)) { console.error(`missing journal: ${logFile}`); process.exit(2); }
if (!existsSync(projects)) { console.error(`missing transcripts directory: ${projects}`); process.exit(2); }

function jsonl(file, strict = false) {
  const rows = [];
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { rows.push(JSON.parse(l)); } catch { if (strict) continue; }
  }
  return rows;
}

// ---------- records from the journal ----------
const records = jsonl(logFile, true)
  .filter((o) => o && o.event === 'compact' && typeof o.kept_thinking === 'number' && o.kept_thinking > 0 && Date.parse(o.ts) >= from)
  .map((o) => ({ ts: o.ts, t: Date.parse(o.ts), session: String(o.session_id || ''), agent: o.agent_id ? String(o.agent_id) : null, result: o.result ?? null, kept: o.kept_thinking, rev: typeof o.module_rev === 'string' ? o.module_rev.slice(0, 8) : null }));

// ---------- transcript files ----------
const projectDirs = readdirSync(projects).sort().map((n) => join(projects, n)).filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
function sessionFiles(session) {
  const found = { main: null, agents: new Map() };
  for (const p of projectDirs) {
    const m = join(p, `${session}.jsonl`);
    if (existsSync(m)) found.main = m;
    const sa = join(p, session, 'subagents');
    if (existsSync(sa)) for (const n of readdirSync(sa).sort()) if (n.startsWith('agent-') && n.endsWith('.jsonl')) found.agents.set(n.slice(6, -6), join(sa, n));
  }
  return found;
}

const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('') : '');
const messageText = (m) => (typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('') : '');
function placeholdersInRow(o) {
  const c = o?.message?.content;
  if (!Array.isArray(c)) return 0;
  let n = 0;
  for (const b of c) if (b && b.type === 'tool_result' && resultText(b.content).startsWith('[Tool result missing')) n++;
  return n;
}
function apiError(o) {
  if (o?.type === 'assistant') {
    const t = messageText(o.message);
    if (o.isApiErrorMessage === true || (o.message?.model === '<synthetic>' && t.startsWith('API Error'))) return t || 'API Error';
  } else if (o?.type === 'system' && /api.?error/i.test(String(o.subtype || '')) ) {
    return JSON.stringify(o.error ?? o.content ?? o.subtype);
  }
  return null;
}
const emptyCounts = () => ({ rows: 0, api_errors: 0, errors_400: 0, errors_400_thinking_invalid: 0, placeholders: 0, placeholders_in_blobs: 0 });
function count(rows, boundary) {
  const before = emptyCounts();
  const after = emptyCounts();
  for (const o of rows) {
    const t = Date.parse(o?.timestamp);
    const side = Number.isFinite(t) ? (t >= boundary ? after : before) : null;
    if (side === null) continue; // a row without a timestamp cannot be assigned to a side of the boundary
    if (o?.type === 'api-request-blob' || o?.type === 'attachment' || o?.type === 'queue-operation') continue;
    side.rows++;
    const e = apiError(o);
    if (e !== null) {
      side.api_errors++;
      if (/\b400\b/.test(e)) { side.errors_400++; if (/thinking|invalid/i.test(e)) side.errors_400_thinking_invalid++; }
    }
    if (o?.type === 'user') side.placeholders += placeholdersInRow(o);
  }
  return { before, after };
}
// blobs have no timestamp: counted together over the whole file, as information
function blobPlaceholders(rows) {
  let n = 0;
  for (const o of rows) if (o?.type === 'api-request-blob') n += placeholdersInRow(o);
  return n;
}

const recordsByFile = new Map(); // file -> {session, agent, boundary, records}
const sessions = new Map();
for (const r of records) {
  if (!sessions.has(r.session)) sessions.set(r.session, sessionFiles(r.session));
}
const result = { from: opts.from, log: logFile, records: records.length, sessions: sessions.size, files: [], missing_file: [], sums: {} };
for (const r of records) {
  const p = sessions.get(r.session);
  const file = r.agent ? p.agents.get(r.agent) : p.main;
  if (!file) { result.missing_file.push({ session: r.session.slice(0, 8), agent: r.agent, ts: r.ts }); continue; }
  const e = recordsByFile.get(file) || { file, session: r.session, agent: r.agent, boundary: r.t, records: [] };
  e.boundary = Math.min(e.boundary, r.t);
  e.records.push({ ts: r.ts, result: r.result, kept_thinking: r.kept, module_rev: r.rev });
  recordsByFile.set(file, e);
}

const sessionBoundary = new Map();
for (const e of recordsByFile.values()) sessionBoundary.set(e.session, Math.min(sessionBoundary.get(e.session) ?? Infinity, e.boundary));
const fileLabel = (file) => file.split('/').slice(-3).join('/');
for (const e of recordsByFile.values()) {
  const rows = jsonl(e.file);
  const { before, after } = count(rows, e.boundary);
  result.files.push({ role: e.agent ? 'agent with a record' : 'session with a record', session: e.session.slice(0, 8), agent: e.agent, file: fileLabel(e.file), records: e.records.length, record_results: [...new Set(e.records.map((x) => x.result))], boundary: new Date(e.boundary).toISOString(), before, after, placeholders_in_blobs: blobPlaceholders(rows) });
}
// the other files of a session (agents without a record of their own, and the main session when only agents had records): window from the earliest boundary of the session
for (const [session, p] of sessions) {
  const boundary = sessionBoundary.get(session);
  if (boundary === undefined) continue;
  const all = [];
  if (p.main) all.push({ file: p.main, agent: null });
  for (const [a, file] of p.agents) all.push({ file, agent: a });
  for (const x of all) {
    if (recordsByFile.has(x.file)) continue;
    const rows = jsonl(x.file);
    const { before, after } = count(rows, boundary);
    result.files.push({ role: x.agent ? 'other agent of the session' : 'main session (records of agents only)', session: session.slice(0, 8), agent: x.agent, file: fileLabel(x.file), records: 0, record_results: [], boundary: new Date(boundary).toISOString(), before, after, placeholders_in_blobs: blobPlaceholders(rows) });
  }
}

const sum = (role) => {
  const s = { files: 0, after: emptyCounts(), before: emptyCounts(), placeholders_in_blobs: 0 };
  for (const f of result.files) {
    if (!role(f.role)) continue;
    s.files++;
    s.placeholders_in_blobs += f.placeholders_in_blobs;
    for (const k of Object.keys(s.after)) { s.after[k] += f.after[k]; s.before[k] += f.before[k]; }
  }
  return s;
};
const hasRecord = (r) => r.endsWith('with a record') && !r.startsWith('main session');
result.sums.files_with_a_record = sum(hasRecord);
result.sums.other_files_of_the_sessions = sum((r) => !hasRecord(r));
result.sums.total = sum(() => true);
result.records_by_result = records.reduce((m, r) => { const k = r.result ?? 'none'; m[k] = (m[k] || 0) + 1; return m; }, {});

// ---------- output ----------
console.log(`Compaction review: records of the journal with kept_thinking > 0 from ${opts.from} (local time)`);
console.log(`journal: ${logFile}`);
console.log(`records: ${result.records} (result: ${JSON.stringify(result.records_by_result)}), sessions: ${result.sessions}, transcript files: ${result.files.length}, records without a file: ${result.missing_file.length}`);
for (const b of result.missing_file) console.log(`  NO FILE: session ${b.session} agent ${b.agent ?? '-'} ${b.ts}`);
const fmt = (c) => `rows ${c.rows}, API errors ${c.api_errors} (400: ${c.errors_400}, of them thinking/invalid: ${c.errors_400_thinking_invalid}), placeholders ${c.placeholders}`;
let skipped = 0;
for (const x of result.files) {
  if (!opts.full && x.records === 0 && x.after.api_errors === 0 && x.after.placeholders === 0) { skipped++; continue; }
  console.log(`- ${x.role}: session ${x.session}${x.agent ? ` agent ${x.agent}` : ''} (${x.file}), boundary ${x.boundary}, records ${x.records}${x.record_results.length ? ` [${x.record_results.join(',')}]` : ''}`);
  console.log(`    after the boundary:  ${fmt(x.after)}`);
  console.log(`    before the boundary: ${fmt(x.before)}`);
  if (x.placeholders_in_blobs) console.log(`    placeholders in api-request-blob (information, whole file): ${x.placeholders_in_blobs}`);
}
if (skipped) console.log(`(skipped ${skipped} files without a record and without an error after the boundary; --full shows all of them)`);
for (const [label, s] of [['files with a record', result.sums.files_with_a_record], ['other files of the sessions', result.sums.other_files_of_the_sessions], ['total', result.sums.total]]) {
  console.log(`SUM ${label} (${s.files} files): after the boundary: ${fmt(s.after)}; before the boundary: ${fmt(s.before)}`);
}
if (opts.json) console.log(JSON.stringify(result));
const bad = result.sums.total.after.errors_400 + result.sums.total.after.placeholders;
console.log(bad === 0 ? 'RESULT: 0 errors 400 and 0 placeholder results after the boundaries (without records there is no evidence: see the number of records).' : `RESULT: ${result.sums.total.after.errors_400} errors 400 and ${result.sums.total.after.placeholders} placeholder results after the boundaries: to be examined (if a resumed request fails with 400 after a record with kept_thinking > 0, returning the summary whenever keptThinking > 0 restores the earlier rule).`);
process.exit(bad === 0 ? 0 : 1);
