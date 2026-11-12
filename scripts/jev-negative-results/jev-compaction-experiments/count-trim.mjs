#!/usr/bin/env node
// Counter 1: what would an "output-trim" (result trimmer) have saved? Read-only, no network, no API key.
//
//   node count-trim.mjs --synthetic [--json]            built-in synthetic transcripts (deterministic)
//   node count-trim.mjs --transcripts <dir> [--since ISO] [--json]
//                                                       Claude Code transcripts (*.jsonl, recursive), numbers only
//
// For every Bash / PowerShell / Monitor / mcp__* tool result it counts the characters the model saw (the denominator), selects the
// results the trimmer's policy applies to (4,000 characters or more, not an error, not already stored by the host, not content the
// model asked for, not secret-looking) and runs the reference trimmer (output-trim/jev-trim.mjs) on them.
//   scenario A  the policy as designed (content, private directories and secret-looking results excluded)
//   scenario D  the ceiling: A without the content / private exclusions
// The experiment's decision threshold was 10 % of the characters of the covered tools. The script prints both shares.
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { trimText, contentReason, looksLikeSecret, mentionsPrivateDir, TRIM_MIN_CHARS } from './output-trim/jev-trim.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const THRESHOLD = 0.10;

const classOf = (name) => (name === 'Bash' || name === 'PowerShell' || name === 'Monitor' ? name : String(name).startsWith('mcp__') ? 'MCP' : null);
const CLASSES = ['Bash', 'PowerShell', 'Monitor', 'MCP'];
const mk = () => ({ n: 0, chars: 0, hostStored: 0, errors: 0, inScope: 0, content: 0, privateDir: 0, secret: 0, applied: 0, savedA: 0, savedD: 0 });
const stats = Object.fromEntries(CLASSES.map((c) => [c, mk()]));
const seen = new Set();
let randomChecked = 0;
let reviewFlags = 0;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

function handle(id, toolName, input, text, isError) {
  const cls = classOf(toolName);
  if (!cls || seen.has(id)) return;
  seen.add(id);
  const st = stats[cls];
  st.n++; st.chars += text.length;
  if (/^<persisted-output>/.test(text.slice(0, 40))) { st.hostStored++; return; }
  if (isError) { st.errors++; return; }
  if (text.length < TRIM_MIN_CHARS) return;
  st.inScope++;
  const command = input && (input.command ?? input.cmd) ? String(input.command ?? input.cmd) : '';
  const cwd = input && input.cwd ? String(input.cwd) : '';
  const content = contentReason(toolName, command, text);
  const isPrivate = mentionsPrivateDir(command, cwd);
  const secret = looksLikeSecret(text);
  if (content) st.content++;
  if (isPrivate) st.privateDir++;
  if (secret) st.secret++;
  const ceiling = trimText(text, {});
  st.savedD += ceiling.saved;
  if (content || isPrivate) return;
  const r = trimText(text, {});
  if (r.applied) {
    st.applied++; st.savedA += r.saved;
    // Invariant check: a short line that mentions an error word must survive the trimmer.
    const keep = new Set(r.text.split('\n'));
    randomChecked++;
    for (const l of text.split('\n')) if (l.length <= 2000 && /error|fail|exception|traceback|warn|fatal|denied/i.test(l) && !keep.has(l)) { reviewFlags++; break; }
  }
}

// ---------------------------------------------------------------- synthetic corpus (deterministic)

function* synthetic() {
  let seed = 20261112;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let id = 0;
  const mkId = () => `toolu_synth_${String(++id).padStart(5, '0')}`;
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
  const sentence = (n) => Array.from({ length: n }, () => pick(words)).join(' ');
  // 1. short outputs (most results): never in scope
  for (let i = 0; i < 3000; i++) yield [mkId(), 'Bash', { command: 'ls -la' }, sentence(20 + Math.floor(rnd() * 100)), false];
  // 2. file readers, large: content, excluded by policy
  for (let i = 0; i < 400; i++) yield [mkId(), 'Bash', { command: `cat notes-${i}.md` }, Array.from({ length: 200 }, () => sentence(12)).join('\n'), false];
  // 3. diffs, large: content
  for (let i = 0; i < 10; i++) yield [mkId(), 'Bash', { command: 'git diff' }, `diff --git a/f b/f\n@@ -1,3 +1,4 @@\n${Array.from({ length: 200 }, () => '+' + sentence(8)).join('\n')}`, false];
  // 4. progress bar rewritten with \r (lossless case)
  for (let i = 0; i < 4; i++) yield [mkId(), 'Bash', { command: 'git worktree add x' }, Array.from({ length: 400 }, (_, k) => `Updating files: ${Math.floor(k / 4)}% (${k}/400)\r`).join('') + 'done\n', false];
  // 5. long test run: series of success lines with one failure in the middle (must be kept)
  for (let i = 0; i < 6; i++) {
    const lines = Array.from({ length: 300 }, (_, k) => `PASS test ${k} (${i})`);
    lines[150] = 'FAIL test 150 error: expected 3 got 4';
    yield [mkId(), 'Bash', { command: 'npm test' }, lines.join('\n'), false];
  }
  // 6. repeated lines
  for (let i = 0; i < 5; i++) yield [mkId(), 'Bash', { command: 'tail -f log' }, Array.from({ length: 500 }, () => 'retrying connection').join('\n'), false];
  // 7. one very long line from a script (lossy: a shortened long line)
  for (let i = 0; i < 8; i++) yield [mkId(), 'Bash', { command: `python3 analyse.py ${i}` }, 'result: ' + sentence(900) + '\nok\n', false];
  // 8. errors and MCP snapshots
  for (let i = 0; i < 20; i++) yield [mkId(), 'Bash', { command: 'make' }, sentence(1200), true];
  for (let i = 0; i < 12; i++) yield [mkId(), 'mcp__browser__snapshot', {}, Array.from({ length: 60 }, (_, k) => `- link [${k}] ${sentence(6)} -> 200 OK`).join('\n'), false];
  // 9. host-stored output
  for (let i = 0; i < 5; i++) yield [mkId(), 'Bash', { command: 'find /' }, '<persisted-output>Output too large. Full output saved to: /x/y.txt\nPreview...', false];
}

// ---------------------------------------------------------------- transcripts

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (name !== 'tool-results') yield* walk(p); } else if (name.endsWith('.jsonl')) yield p;
  }
}

async function fromTranscripts(dir, sinceMs) {
  let files = 0;
  for (const f of walk(dir)) {
    files++;
    const uses = new Map();
    const rl = createInterface({ input: createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length < 20 || line[0] !== '{') continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (sinceMs && r.timestamp && Date.parse(r.timestamp) < sinceMs) continue;
      const m = r.message;
      if (!m || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_use' && b.id) uses.set(b.id, { name: b.name, input: b.input });
        else if (b.type === 'tool_result' && b.tool_use_id) {
          const u = uses.get(b.tool_use_id);
          if (u) handle(b.tool_use_id, u.name, u.input, textOf(b.content), Boolean(b.is_error));
        }
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------- run

let source;
let files = 0;
if (flag('--synthetic')) {
  source = 'synthetic';
  for (const a of synthetic()) handle(...a);
} else if (val('--transcripts')) {
  source = 'transcripts';
  const since = val('--since');
  files = await fromTranscripts(val('--transcripts'), since ? Date.parse(since) : 0);
} else {
  console.error('usage: --synthetic | --transcripts <dir> [--since ISO]   [--json]');
  process.exit(2);
}

const tot = mk();
for (const c of CLASSES) for (const k of Object.keys(tot)) tot[k] += stats[c][k];
const out = {
  source, files, results: tot.n, chars: tot.chars, hostStored: tot.hostStored, errors: tot.errors, inScope: tot.inScope,
  excludedContent: tot.content, excludedPrivateDir: tot.privateDir, secretLooking: tot.secret,
  appliedA: tot.applied, savedCharsA: tot.savedA, shareA: tot.chars ? tot.savedA / tot.chars : 0,
  savedCharsCeilingD: tot.savedD, shareCeilingD: tot.chars ? tot.savedD / tot.chars : 0,
  threshold: THRESHOLD, invariantChecked: randomChecked, errorLineLost: reviewFlags,
  byClass: stats,
};
if (flag('--json')) console.log(JSON.stringify(out, null, 2));
else {
  const pct = (x) => (100 * x).toFixed(2) + ' %';
  console.log(`source: ${source}${files ? ` (${files} files)` : ''}`);
  console.log(`results of covered tools: ${out.results}, ${out.chars} characters (denominator)`);
  console.log(`  stored by the host: ${out.hostStored}; errors: ${out.errors}; in scope (>= ${TRIM_MIN_CHARS} chars, not error, not stored): ${out.inScope}`);
  console.log(`  excluded as content: ${out.excludedContent}; private directory: ${out.excludedPrivateDir}; secret-looking: ${out.secretLooking}`);
  console.log(`scenario A (policy as designed): applied to ${out.appliedA} results, saved ${out.savedCharsA} characters = ${pct(out.shareA)} of the denominator`);
  console.log(`scenario D (ceiling, no content/private exclusions): saved ${out.savedCharsCeilingD} characters = ${pct(out.shareCeilingD)}`);
  console.log(`decision threshold: ${pct(THRESHOLD)}; A is ${(100 * out.shareA / THRESHOLD).toFixed(1)} % of it`);
  console.log(`invariant (a short error-word line survives the trim): ${out.invariantChecked} trimmed results checked, ${out.errorLineLost} lost such a line`);
}
