#!/usr/bin/env node
// Counter 2: how often does "merging identical tool traces" (N14d) have anything to merge? Read-only, no network, no API key.
//
//   node count-merge-hits.mjs --synthetic [--json]
//   node count-merge-hits.mjs --transcripts <dir> [--json]      opportunity count on Claude Code transcripts
//   node count-merge-hits.mjs --compact-log <file.jsonl> [--json]   hits recorded by the compaction module itself
//
// The merge rule being counted: neighbouring tool calls of ONE API message, same tool, same complete input (canonical JSON), with no
// non-blank text between them, merge into one trace line with a counter. A "run" is two or more such calls. In a transcript one API
// message is spread over several rows that share message.id, so the calls are grouped by that id.
// --compact-log counts the fields `merged_traces` and `merged_items` of the module's compaction records (event "compact").
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

// canonical JSON: keys sorted, so the same input written in another key order is the same call
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));

// messages: Map messageId -> ordered list of blocks {type, name?, input?, text?}
function countRuns(messages) {
  const r = { apiMessages: messages.size, toolUses: 0, messagesWithTwoOrMore: 0, runs: 0, callsInRuns: 0 };
  for (const blocks of messages.values()) {
    const calls = blocks.filter((b) => b.type === 'tool_use');
    r.toolUses += calls.length;
    if (calls.length >= 2) r.messagesWithTwoOrMore++;
    let prev = null;
    let run = 0;
    const close = () => { if (run >= 2) { r.runs++; r.callsInRuns += run; } run = 0; prev = null; };
    for (const b of blocks) {
      if (b.type === 'text') { if (String(b.text || '').trim()) close(); continue; }
      if (b.type !== 'tool_use') continue;
      const key = `${b.name}\n${canon(b.input)}`;
      if (prev === key) run++; else { close(); prev = key; run = 1; }
    }
    close();
  }
  return r;
}

function synthetic() {
  const m = new Map();
  const add = (id, ...blocks) => m.set(id, blocks);
  const call = (name, input) => ({ type: 'tool_use', name, input });
  add('m1', call('Read', { file_path: 'a.txt' }), call('Read', { file_path: 'b.txt' }));                                  // different input: no run
  add('m2', call('Bash', { command: 'git status' }), call('Bash', { command: 'git status' }), call('Bash', { command: 'git status' })); // run of 3
  add('m3', call('Read', { file_path: 'a', offset: 1 }), call('Read', { offset: 1, file_path: 'a' }));                     // same input, other key order: run of 2
  add('m4', call('Bash', { command: 'ls' }), { type: 'text', text: 'checking' }, call('Bash', { command: 'ls' }));         // text between: no run
  add('m5', call('Bash', { command: 'ls' }), { type: 'text', text: '  ' }, call('Bash', { command: 'ls' }));               // blank text: run of 2
  add('m6', call('Edit', { file_path: 'x', old_string: 'a', new_string: 'b' }));                                            // single call
  for (let i = 0; i < 94; i++) add(`s${i}`, call('Read', { file_path: `f${i}.txt` }));                                      // ordinary traffic
  return { source: 'synthetic', ...countRuns(m), expected: { runs: 3, callsInRuns: 7 } };
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (name !== 'tool-results') yield* walk(p); } else if (name.endsWith('.jsonl')) yield p;
  }
}

async function transcripts(dir) {
  const messages = new Map();
  const seenUse = new Set();
  let files = 0;
  for (const f of walk(dir)) {
    files++;
    const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length < 20 || line[0] !== '{' || !line.includes('"assistant"')) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const m = r.message;
      if (r.type !== 'assistant' || !m || !m.id || !Array.isArray(m.content)) continue;
      const key = `${f}\n${m.id}`; // forks copy rows into other files, so a message is only merged within its own file
      if (!messages.has(key)) messages.set(key, []);
      for (const b of m.content) {
        if (!b) continue;
        if (b.type === 'tool_use') { if (seenUse.has(b.id)) continue; seenUse.add(b.id); messages.get(key).push({ type: 'tool_use', name: b.name, input: b.input }); }
        else if (b.type === 'text') messages.get(key).push({ type: 'text', text: b.text });
      }
    }
  }
  return { source: 'transcripts', files, ...countRuns(messages) };
}

function compactLog(file) {
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const withField = rows.filter((r) => r.event === 'compact' && 'merged_traces' in r);
  const byRev = {};
  for (const r of withField) {
    const rev = String(r.module_rev || 'unknown').slice(0, 8);
    byRev[rev] ??= { records: 0, mergedTracesSum: 0, mergedItemsSum: 0, recordsWithHit: 0 };
    const b = byRev[rev];
    b.records++; b.mergedTracesSum += Number(r.merged_traces) || 0; b.mergedItemsSum += Number(r.merged_items) || 0;
    if (Number(r.merged_traces) > 0) b.recordsWithHit++;
  }
  return {
    source: 'compact-log', lines: rows.length, compactRecords: rows.filter((r) => r.event === 'compact').length,
    recordsWithField: withField.length, recordsWithHit: withField.filter((r) => Number(r.merged_traces) > 0).length,
    mergedTracesSum: withField.reduce((s, r) => s + (Number(r.merged_traces) || 0), 0), byModuleRevision: byRev,
  };
}

let out;
if (flag('--synthetic')) out = synthetic();
else if (val('--transcripts')) out = await transcripts(val('--transcripts'));
else if (val('--compact-log')) out = compactLog(val('--compact-log'));
else { console.error('usage: --synthetic | --transcripts <dir> | --compact-log <file>   [--json]'); process.exit(2); }

if (flag('--json')) console.log(JSON.stringify(out, null, 2));
else if (out.source === 'compact-log') {
  console.log(`compaction log: ${out.lines} lines, ${out.compactRecords} compact records, ${out.recordsWithField} carry merged_traces`);
  console.log(`records with at least one merge: ${out.recordsWithHit} of ${out.recordsWithField}; merged traces in total: ${out.mergedTracesSum}`);
  for (const [rev, b] of Object.entries(out.byModuleRevision)) console.log(`  module ${rev}: ${b.records} records, ${b.recordsWithHit} with a hit`);
} else {
  console.log(`source: ${out.source}${out.files ? ` (${out.files} files)` : ''}`);
  console.log(`API messages: ${out.apiMessages}; tool calls: ${out.toolUses}; messages with 2 or more calls: ${out.messagesWithTwoOrMore}`);
  console.log(`runs of identical neighbouring calls: ${out.runs} (${out.callsInRuns} calls)`);
  if (out.expected) {
    const ok = out.runs === out.expected.runs && out.callsInRuns === out.expected.callsInRuns;
    console.log(`self-check against the synthetic construction (${out.expected.runs} runs, ${out.expected.callsInRuns} calls): ${ok ? 'OK' : 'FAILED'}`);
    if (!ok) process.exit(1);
  }
}
