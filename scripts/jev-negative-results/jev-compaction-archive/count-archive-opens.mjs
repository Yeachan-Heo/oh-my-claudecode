#!/usr/bin/env node
/* global console, process */
// Counts how often an agent opened the files that the Jev compaction module archived or moved out of the conversation.
//
// It reads Claude Code transcripts (*.jsonl; the main session and subagents/ files) under the given directories and looks for
// tool calls whose target holds the path of an archive directory:
//   - "opens": tool_use blocks of Read (input.file_path), Bash (input.command) and, counted apart, any other tool whose input names the path
//     (Grep, Glob, ...). Writes by the compaction module itself are done by the hooks host and never show up as tool calls.
//   - "references": a transcript line that names the path anywhere but in a tool call (the trace lines of the module, an agent quoting
//     a path). A reference is only a pointer that was shown to the model; an open is the model following it.
// With --archive-root <kind>=<directory> it also lists the files that exist in that archive directory and reports how many of them were
// opened by name (session directory plus file name); a call that names a directory or a glob counts as an open call only.
//
// Only counts are printed: no transcript text, no path, no file name. It makes no network calls.
//
//   node count-archive-opens.mjs --dir <transcript dir> [--dir ...] [--list <file with one transcript path per line>] [--since-days N] [--archive-root <kind>=<dir> ...] [--kind <name>=<path fragment> ...] [--json]
//   node count-archive-opens.mjs --synthetic        # builds synthetic transcripts in a temp directory, counts them, checks the expected numbers
//
// --kind adds or replaces a family of archive paths. Defaults: results=/compaction-archive/ and pastes=/compaction-pastes/ (the
// directories the code in this branch writes). A kind named twice keeps the last fragment.

import { createReadStream, existsSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const SKIP_DIRS = new Set(['node_modules', '.git', 'wt']);
const DEFAULT_KINDS = { results: '/compaction-archive/', pastes: '/compaction-pastes/' };
const PATH_CHAR = '[^\\s"\'`;|&<>()\\\\]*';

function parseArgs(argv) {
  const opts = { dirs: [], lists: [], kinds: { ...DEFAULT_KINDS }, sinceDays: undefined, archiveRoots: {}, json: false, synthetic: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') opts.dirs.push(argv[++i]);
    else if (a === '--list') opts.lists.push(argv[++i]);
    else if (a === '--since-days') opts.sinceDays = Number(argv[++i]);
    else if (a === '--archive-root') {
      const [name, ...rest] = String(argv[++i] ?? '').split('=');
      if (!name || !rest.length) throw new Error('--archive-root needs <kind>=<directory>');
      opts.archiveRoots[name] = rest.join('=');
    }
    else if (a === '--kind') {
      const [name, ...rest] = String(argv[++i] ?? '').split('=');
      if (!name || !rest.length) throw new Error('--kind needs <name>=<path fragment>');
      opts.kinds[name] = rest.join('=');
    } else if (a === '--json') opts.json = true;
    else if (a === '--synthetic') opts.synthetic = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.sinceDays !== undefined && !(opts.sinceDays > 0)) throw new Error('--since-days needs a positive number');
  return opts;
}

function* transcripts(dir, cutoff) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* transcripts(p, cutoff); }
    else if (e.isFile() && e.name.endsWith('.jsonl') && (cutoff === undefined || statSync(p).mtimeMs >= cutoff)) yield p;
  }
}

function* filesUnder(dir, base = dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* filesUnder(p, base);
    else if (e.isFile() && !e.name.startsWith('.')) yield p.slice(base.length + 1);
  }
}

const blocksOf = (row) => {
  const content = row?.message?.content ?? row?.content;
  return Array.isArray(content) ? content : [];
};

function targetOf(block) {
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  if (block.name === 'Read') return { tool: 'read', text: String(input.file_path ?? '') };
  if (block.name === 'Bash') return { tool: 'bash', text: String(input.command ?? '') };
  return { tool: 'other', text: JSON.stringify(input) };
}

const emptyKind = () => ({ files_with_reference: 0, files_with_open: 0, opens_read: 0, opens_bash: 0, opens_other: 0, opened_names: new Set(), calls: new Map() });

async function scanFile(file, kinds, totals) {
  const needles = Object.entries(kinds);
  const seenRef = new Set();
  const seenOpen = new Set();
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const hit = needles.filter(([, frag]) => line.includes(frag));
    if (!hit.length) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    for (const block of blocksOf(row)) {
      if (block?.type === 'tool_use') {
        const { tool, text } = targetOf(block);
        for (const [kind, frag] of hit) {
          if (!text.includes(frag)) continue;
          // A transcript copied from another one (a resumed or forked session) repeats the calls of the original with the same
          // tool_use id: such a call is counted once, and `calls` remembers in how many transcripts it was seen.
          const key = block.id ?? `${file}#${totals[kind].calls.size}`;
          const seen = totals[kind].calls.get(key);
          totals[kind].calls.set(key, (seen ?? 0) + 1);
          seenOpen.add(kind);
          if (seen !== undefined) continue;
          totals[kind][`opens_${tool}`]++;
          const names = text.match(new RegExp(`${PATH_CHAR}${frag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${PATH_CHAR}`, 'g')) ?? [];
          for (const n of names) totals[kind].opened_names.add(n);
        }
      } else if (block?.type === 'text' || block?.type === 'tool_result') {
        const text = JSON.stringify(block);
        for (const [kind, frag] of hit) if (text.includes(frag)) seenRef.add(kind);
      }
    }
  }
  for (const k of seenRef) totals[k].files_with_reference++;
  for (const k of seenOpen) totals[k].files_with_open++;
}

async function count(opts) {
  const cutoff = opts.sinceDays === undefined ? undefined : Date.now() - opts.sinceDays * 86_400_000;
  const totals = Object.fromEntries(Object.keys(opts.kinds).map((k) => [k, emptyKind()]));
  let scanned = 0;
  let withSubagents = 0;
  const files = function* () {
    for (const dir of opts.dirs) yield* transcripts(dir, cutoff);
    for (const list of opts.lists ?? []) for (const f of readFileSync(list, 'utf8').split('\n')) if (f.trim()) yield f.trim();
  };
  for (const file of files()) {
    scanned++;
    if (file.includes('/subagents/')) withSubagents++;
    try { await scanFile(file, opts.kinds, totals); } catch { scanned--; if (file.includes('/subagents/')) withSubagents--; }
  }
  const result = { transcripts_scanned: scanned, of_which_subagent_files: withSubagents, since_days: opts.sinceDays ?? null, kinds: {} };
  for (const [kind, t] of Object.entries(totals)) {
    const out = {
      path_fragment: opts.kinds[kind],
      files_with_reference: t.files_with_reference,
      files_with_open: t.files_with_open,
      opens_read: t.opens_read,
      opens_bash: t.opens_bash,
      opens_other_tools: t.opens_other,
      distinct_paths_opened: t.opened_names.size,
      calls_seen_in_more_than_one_transcript: [...t.calls.values()].filter((n) => n > 1).length,
    };
    if (opts.archiveRoots[kind]) {
      const root = opts.archiveRoots[kind];
      const existing = [...filesUnder(root)];
      const opened = existing.filter((rel) => {
        const tail = rel.split('/').slice(-2).join('/');
        return [...t.opened_names].some((n) => n.endsWith(`/${tail}`));
      });
      out.archived_files_on_disk = existing.length;
      out.archived_files_opened_by_name = opened.length;
    }
    result.kinds[kind] = out;
  }
  return result;
}

function print(result) {
  console.log(`transcripts scanned: ${result.transcripts_scanned} (subagent files among them: ${result.of_which_subagent_files})${result.since_days ? `, modified in the last ${result.since_days} days` : ''}`);
  for (const [kind, o] of Object.entries(result.kinds)) {
    console.log(`\n[${kind}] path fragment ${o.path_fragment}`);
    console.log(`  transcripts naming the path (trace or quote): ${o.files_with_reference}`);
    console.log(`  transcripts with at least one open: ${o.files_with_open}`);
    console.log(`  distinct open calls (by tool_use id): Read ${o.opens_read}, Bash ${o.opens_bash}, other tools ${o.opens_other_tools}; distinct paths named in them: ${o.distinct_paths_opened}; calls repeated in copied transcripts: ${o.calls_seen_in_more_than_one_transcript}`);
    if (o.archived_files_on_disk !== undefined) console.log(`  files on disk: ${o.archived_files_on_disk}; of them opened by name: ${o.archived_files_opened_by_name}`);
  }
}

// --- synthetic mode ---------------------------------------------------------------------------------------------------------------
const line = (obj) => `${JSON.stringify(obj)}\n`;
const user = (content) => line({ type: 'user', message: { role: 'user', content } });
const assistant = (content) => line({ type: 'assistant', message: { role: 'assistant', content } });
const use = (name, input, id) => ({ type: 'tool_use', id, name, input });
const result = (id, text) => ({ type: 'tool_result', tool_use_id: id, content: text });

async function synthetic() {
  const tmp = mkdtempSync(join(tmpdir(), 'archive-opens-'));
  try {
    const state = join(tmp, 'state');
    const archive = join(state, 'compaction-archive');
    const pastes = join(state, 'compaction-pastes');
    for (const f of ['s1/toolu_a.txt', 's1/toolu_b.txt', 's1/toolu_c.txt', 's2/toolu_d.txt', 's2/toolu_e.txt']) {
      mkdirSync(join(archive, f.split('/')[0]), { recursive: true });
      writeFileSync(join(archive, f), 'synthetic');
    }
    mkdirSync(join(pastes, 's1'), { recursive: true });
    writeFileSync(join(pastes, 's1', 'abc.txt'), 'synthetic');
    const projects = join(tmp, 'projects', 'p');
    mkdirSync(join(projects, 's1', 'subagents'), { recursive: true });
    const trace = `[result of 9000 chars removed; full call and result: ${archive}/s1/toolu_a.txt]`;
    // 1: a trace is shown, the agent reads the file (Read) and later a second one with cat (Bash).
    writeFileSync(join(projects, 't1.jsonl'),
      user([result('x1', trace)]) +
      assistant([use('Read', { file_path: `${archive}/s1/toolu_a.txt` }, 'u1')]) +
      assistant([use('Bash', { command: `cat ${archive}/s1/toolu_b.txt | head -50` }, 'u2')]));
    // 2: a trace is shown, never followed.
    writeFileSync(join(projects, 't2.jsonl'), user([result('x2', trace)]) + assistant([{ type: 'text', text: 'Carrying on.' }]));
    // 3: a pasted-text trace is followed with Bash; and the archive directory is listed with Grep (other tool).
    writeFileSync(join(projects, 't3.jsonl'),
      user([{ type: 'text', text: `[pasted text moved at compaction: 4000 chars, full text in ${pastes}/s1/abc.txt; start: "x"; end: "y"]` }]) +
      assistant([use('Bash', { command: `wc -c ${pastes}/s1/abc.txt` }, 'u3')]) +
      assistant([use('Grep', { pattern: 'needle', path: `${archive}/s2` }, 'u4')]));
    // 4: nothing to do with the archive.
    writeFileSync(join(projects, 't4.jsonl'), user([{ type: 'text', text: 'hello' }]) + assistant([use('Read', { file_path: '/tmp/other.txt' }, 'u5')]));
    // 5: a subagent file that reads one archive file (toolu_a again: still one distinct file) and one new one (toolu_d).
    writeFileSync(join(projects, 's1', 'subagents', 'agent-1.jsonl'),
      assistant([use('Read', { file_path: `${archive}/s1/toolu_a.txt` }, 'u6')]) +
      assistant([use('Read', { file_path: `${archive}/s2/toolu_d.txt` }, 'u7')]));
    // 6: a line that is not JSON and a truncated one must not stop the count.
    writeFileSync(join(projects, 't6.jsonl'), `not json ${archive}/s1/\n{"type":"user","message":{"content":[{"type":"text","text":"${archive}/s1/`);

    // 7: a copy of the start of transcript 1 (same tool_use id): counted once as a call, but the transcript has an open.
    writeFileSync(join(projects, 't7.jsonl'), assistant([use('Read', { file_path: `${archive}/s1/toolu_a.txt` }, 'u1')]));

    const got = await count({ dirs: [join(tmp, 'projects')], kinds: { ...DEFAULT_KINDS }, sinceDays: undefined, archiveRoots: { results: archive, pastes } });
    const r = got.kinds.results;
    const p = got.kinds.pastes;
    const expected = [
      ['transcripts_scanned', got.transcripts_scanned, 7],
      ['subagent files', got.of_which_subagent_files, 1],
      ['results: files with reference', r.files_with_reference, 2],
      ['results: files with open', r.files_with_open, 4],
      ['results: calls repeated in copies', r.calls_seen_in_more_than_one_transcript, 1],
      ['results: Read', r.opens_read, 3],
      ['results: Bash', r.opens_bash, 1],
      ['results: other', r.opens_other_tools, 1],
      ['results: distinct paths opened', r.distinct_paths_opened, 4],
      ['results: files on disk', r.archived_files_on_disk, 5],
      ['results: opened by name', r.archived_files_opened_by_name, 3],
      ['pastes: files with reference', p.files_with_reference, 1],
      ['pastes: files with open', p.files_with_open, 1],
      ['pastes: Bash', p.opens_bash, 1],
      ['pastes: files on disk', p.archived_files_on_disk, 1],
      ['pastes: opened by name', p.archived_files_opened_by_name, 1],
    ];
    print(got);
    let bad = 0;
    console.log('\nexpected values of the synthetic transcripts:');
    for (const [name, value, want] of expected) {
      const ok = value === want;
      if (!ok) bad++;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}: ${value} (expected ${want})`);
    }
    if (bad) { console.error(`${bad} mismatch(es)`); process.exitCode = 1; } else console.log('synthetic check passed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.synthetic) return synthetic();
  if (!opts.dirs.length && !opts.lists.length) throw new Error('give at least one --dir or --list (or --synthetic)');
  for (const d of opts.dirs) if (!existsSync(d)) throw new Error(`not a directory: ${d}`);
  const result = await count(opts);
  if (opts.json) console.log(JSON.stringify(result, null, 2)); else print(result);
}

main().catch((error) => { console.error(error.message); process.exitCode = 2; });
