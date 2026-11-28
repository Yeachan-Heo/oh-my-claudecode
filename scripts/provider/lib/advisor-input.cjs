'use strict';
// Advisor input shaped by the worker. A question template with fields (DECISION required); the script adds the
// worktree `git diff` (and --stat), the files named in the FILES field with limits on count and bytes, embedding with
// line numbers `number<TAB>code`, trimming on whole ranges with an [OMITTED lines a-b] marker, a list `shown`
// {file: [[a,b],...]}, materials trimmed to head plus tail on whole lines, a hard input cap and component caps, path
// protection (realpath under the worktree, the credential pattern of the Bash guard) and journal metadata (input_hash
// SHA-256, size, files, shown, head, decision_chars). No network, no provider key.
// A question without the DECISION field is refused with exit code 2, status refused-missing-decision in the journal, a
// message with the template, no model call. A file over its own budget drops out whole (a marker with its name and
// size in the OMITTED section, not in the shown list). Path protection: realpath under OMC_TEAM_WORKTREE_PATH (or
// OMC_PROVIDER_FILE_ROOT, like the base of the file guard), symlinks leaving the worktree are rejected, the
// credential pattern is the one of the Bash guard (built from the configuration of the running session), the
// components .git/.claude/.omc under the worktree are refused; a rejection is exit code 2, status refused-path, no model
// call, and the file is read only after the path check passes. The caps are environment parameters (starting values,
// calibrate by measuring): OMC_PROVIDER_ADVISOR_CAP_INPUT 250 000 characters, _CAP_FILE 50 000 B per file and
// _CAP_FILES_TOTAL 200 000 B in total, _CAP_FILE_COUNT 6, _CAP_DIFF_FILE 24 000 characters, _CAP_MATERIAL_HEAD 1 800
// and _CAP_MATERIAL_TAIL 1 200 characters.
// Switch: enabled() (OMC_PROVIDER_ADVISOR_INPUT === '1'); off by default. The parameters are set by the lead or the
// worker wrapper (the Bash guard refuses setting them inline from a worker). The advisor model parameter
// (OMC_PROVIDER_ADVISOR_MODEL: opus|sonnet|fable) lives in the advisor script and the profile module; no second
// definition here.
const { createHash } = require('node:crypto');
const { readFileSync, realpathSync, statSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { basename, isAbsolute, join, relative } = require('node:path');
const { guardConfig } = require('../provider-bash-guard.cjs');
const { ADVISOR_STATUSES } = require('./vocab.cjs');

// Optional control token (the token parameter of buildInput): appended to the input as the line `INPUT TOKEN: <token>`
// (before the hard cap, so it survives tail trimming) and counted in the SHA-256 hash and in meta.token; the advisor
// quotes it in the first line of the answer and the parser compares it (advisor-verdict.cjs).
const enabled = (env = process.env) => env.OMC_PROVIDER_ADVISOR_INPUT === '1';

// Caps (parameters; starting values, calibrate by measuring).
function caps(env) {
  const number = (key, fallback) => { const v = Number(env[key]); return Number.isFinite(v) && v > 0 ? v : fallback; };
  return {
    input: number('OMC_PROVIDER_ADVISOR_CAP_INPUT', 250_000), // hard cap of the whole input, characters
    fileBytes: number('OMC_PROVIDER_ADVISOR_CAP_FILE', 50_000), // a named file, bytes
    filesTotalBytes: number('OMC_PROVIDER_ADVISOR_CAP_FILES_TOTAL', 200_000), // named files together, bytes
    fileCount: number('OMC_PROVIDER_ADVISOR_CAP_FILE_COUNT', 6), // limit on the number of named files
    diffFile: number('OMC_PROVIDER_ADVISOR_CAP_DIFF_FILE', 24_000), // diff of one file, characters
    materialHead: number('OMC_PROVIDER_ADVISOR_CAP_MATERIAL_HEAD', 1_800), // material: head, characters
    materialTail: number('OMC_PROVIDER_ADVISOR_CAP_MATERIAL_TAIL', 1_200), // material: tail, characters
  };
}

// The credential patterns of the Bash guard for file paths (the same function the guard uses; built from the running
// session configuration in the environment).
const credentialPatterns = (env = process.env) => guardConfig(env).fileCredentials;
// Components refused under the worktree (like the file guard); key files: .env and variants (.env, .env.name),
// certificates and PEM keys (*.pem), OpenSSH keys (id_rsa and id_rsa.name).
const FORBIDDEN_COMPONENTS = new Set(['.git', '.claude', '.omc']);
const KEY_NAME_PATTERN = /^\.env(\.|$)|\.pem$|^id_rsa(\.|$)/;
const UNDER_DIRECTORY = (path, directory) => { const s = String(path).replace(/\/+$/, ''); const k = String(directory).replace(/\/+$/, ''); return s === k || s.startsWith(`${k}/`); };
// A reserve for the trimming marker, so a result with the marker added does not exceed the cap.
const MARKER_RESERVE = 64;

// Verification of the path of a named file: the credential pattern on the raw path, then realpath (symlinks resolved),
// which must lie under realpath(the base directory); the components .git/.claude/.omc under the base are refused.
// Fail-closed: a path that cannot be resolved, is inaccessible or is outside the base is a refusal. Returns { real } or
// { refusal: reason }.
function verifyPath(raw, base, { realpathFn = realpathSync, env = process.env } = {}) {
  if (credentialPatterns(env).some((re) => re.test(raw))) return { refusal: 'credential pattern (login of the host, copies of the session settings, provider key and profile files)' };
  const absolute = isAbsolute(raw) ? raw : join(base, raw);
  let real;
  try { real = realpathFn(absolute); } catch { return { refusal: 'inaccessible (missing file, permissions or a broken symlink)' }; }
  let baseReal;
  try { baseReal = realpathFn(base); } catch { return { refusal: 'base directory inaccessible' }; }
  if (!UNDER_DIRECTORY(real, baseReal)) return { refusal: `outside the worktree (${base})` };
  const rel = relative(baseReal, real);
  if (rel.split('/').some((x) => FORBIDDEN_COMPONENTS.has(x))) return { refusal: 'component .git, .claude or .omc (shared repository state and session configuration)' };
  if (KEY_NAME_PATTERN.test(basename(rel))) return { refusal: 'key file (.env*, *.pem, id_rsa*)' };
  return { real };
}

// Question fields: a line `NAME: text` starts a field only when NAME is one of the template fields (TEMPLATE); other
// lines such as `FAIL:` or `ERROR:` stay as content of the current field, and text before the first field (the
// prologue) goes to the QUESTION field (it does not vanish). Returns { fields: {NAME: text}, order: [NAME, ...] }.
function parseFields(text) {
  const fieldPattern = new RegExp(`^(?:${FIELD_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}):[ \\t]?(.*)$`);
  const fields = {};
  const order = [];
  const add = (name, line) => { if (!(name in fields)) { fields[name] = []; order.push(name); } fields[name].push(line); };
  let current = null;
  for (const line of String(text).split('\n')) {
    const m = fieldPattern.exec(line);
    if (m) { current = line.slice(0, line.indexOf(':')); add(current, m[1]); continue; } // name = text before the colon (the pattern has no group for it)
    if (current) fields[current].push(line);
    else add('QUESTION', line);
  }
  const done = {};
  for (const [name, lines] of Object.entries(fields)) done[name] = lines.join('\n').replace(/\s+$/, '');
  return { fields: done, order };
}

// The question template (in the refusal message and as a pattern of fields); FIELD_NAMES is the closed list of fields
// recognised by parseFields (other lines `X:` do not split the value of a field).
const TEMPLATE = [
  'DECISION: what to decide and what the worker will do differently depending on the answer',
  'TRIED: what the worker tried and why it did not work',
  'TEST TAIL: the literal tail of the output of the last test (material, trimmed to head plus tail)',
  'HYPOTHESIS: an assumption to check before the advice',
  'EVIDENCE: evidence from the repository (rg results, git log, the project rules file)',
  'FILES: files to embed, separated by a space or a comma (optional)',
].join('\n');
const FIELD_NAMES = TEMPLATE.split('\n').map((l) => l.split(':')[0]).concat(['QUESTION']);

// Non-quotable material: trimming to head plus tail with a marker, on the boundary of whole lines (not characters).
function trimMaterial(text, head, tail) {
  const s = String(text ?? '');
  if (s.length <= head + tail) return { text: s, trimmed: false };
  const lines = s.split('\n');
  const headLines = []; let used = 0; let i = 0;
  while (i < lines.length && used + lines[i].length + 1 <= head) { headLines.push(lines[i]); used += lines[i].length + 1; i++; }
  const tailLines = []; let used2 = 0; let j = lines.length - 1;
  while (j >= i && used2 + lines[j].length + 1 <= tail) { tailLines.unshift(lines[j]); used2 += lines[j].length + 1; j--; }
  const skipped = lines.length - headLines.length - tailLines.length;
  const chars = s.length - used - used2;
  const marker = `[TRIMMED: skipped ${skipped} lines (${chars} characters)]`;
  return { text: [...headLines, marker, ...tailLines].join('\n'), trimmed: true };
}

// Ranges of shown line numbers: consecutive numbers merged into [a,b].
function rangesFromNumbers(nums) {
  const result = [];
  let a = null; let b = null;
  for (const n of nums) {
    if (a === null) { a = n; b = n; continue; }
    if (n <= b) continue; // duplicate (the diff and a named file may overlap)
    if (n === b + 1) { b = n; continue; }
    result.push([a, b]); a = n; b = n;
  }
  if (a !== null) result.push([a, b]);
  return result;
}

// Parsing the output of `git diff <base>`: returns [{ file, deleted, binary, hunks: [{ header, newStart, lines: [{sign, text}] }] }].
// The `+++` headers are recognised only outside a hunk (a diff row `+++ ...` as the content of an added line does not
// replace the file name and does not vanish from the hunk), and lines starting with `\` (the no-newline marker) are
// skipped entirely: no number, no entry in shown.
function parseDiff(text) {
  const files = [];
  let current = null;
  let hunk = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) { current = { file: '', deleted: false, binary: false, hunks: [] }; files.push(current); hunk = null; continue; }
    if (!current) continue;
    if (hunk === null && line.startsWith('+++ b/')) { current.file = line.slice(6); continue; }
    if (hunk === null && line === '+++ /dev/null') { current.deleted = true; continue; }
    if (hunk === null && line.startsWith('+++ ')) { current.file = line.slice(4); continue; }
    if (line.startsWith('Binary files ') && line.endsWith(' differ')) { current.binary = true; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { hunk = { header: line, newStart: Number(h[1]), lines: [] }; current.hunks.push(hunk); continue; }
    if (hunk && /^[ +\-]/.test(line)) { hunk.lines.push({ sign: line[0], text: line.slice(1) }); continue; }
    if (hunk && line.startsWith('\\')) continue; // `\ No newline at end of file`: no number and no shown entry
  }
  return files;
}

// Line numbers actually present in the finished prompt (after the hard trimming): parsing the section headers
// `=== file <name> ===` and `=== diff file <name> ===` and the rows `number<TAB>`. The hard cap trims the middle of the
// prompt, so a shown list counted before trimming would name lines the advisor did not see; meta.shown counted from the
// finished prompt always matches what was embedded.
function shownFromPrompt(prompt) {
  const map = {};
  let current = null;
  for (const line of String(prompt).split('\n')) {
    const m = /^=== (?:file|diff file) (.+?)(?: \([^)]*\))? ===$/.exec(line);
    if (m) { current = m[1]; continue; }
    if (!current) continue;
    const n = /^(\d+)\t/.exec(line);
    if (n) map[current] = [...(map[current] ?? []), Number(n[1])];
  }
  return map;
}

// Embedding a named file: numbered lines `number<TAB>code`, trimming on whole lines to the character cap (the rest gets
// the marker [OMITTED lines a-b]).
function embedFile(content, capChars) {
  const cap = capChars - MARKER_RESERVE;
  const rows = String(content).split('\n');
  if (rows.at(-1) === '') rows.pop(); // the final newline is not an extra line
  const lines = []; const shown = []; let used = 0; let trimmed = false;
  for (let k = 0; k < rows.length; k++) {
    const w = rows[k].length + String(k + 1).length + 2;
    if (used + w > cap) { trimmed = true; break; }
    lines.push(`${k + 1}\t${rows[k]}`);
    shown.push(k + 1);
    used += w;
  }
  if (trimmed) lines.push(`[OMITTED lines ${(shown.at(-1) ?? 0) + 1}-${rows.length}]`);
  return { lines, shown, trimmed, lineCount: rows.length };
}

// Embedding the diff of one file: hunk headers, numbered lines of the new file (`number<TAB>+code`), old lines (`-code`)
// without a number, markers for numbering gaps between hunks, trimming on whole lines to the character cap.
function embedDiffFile(wp, capChars) {
  if (wp.binary) return { lines: ['[binary file; content not embedded]'], shownNumbers: [], trimmed: false };
  const cap = capChars - MARKER_RESERVE;
  const lines = []; const shownNumbers = []; let used = 0; let trimmed = false;
  const lastHunk = wp.hunks.at(-1);
  let lastNumber = 0;
  if (lastHunk) { lastNumber = lastHunk.newStart; for (const l of lastHunk.lines) if (l.sign === ' ' || l.sign === '+') lastNumber++; lastNumber -= 1; }
  let previous = null;
  let first = true;
  let stop = false;
  for (const h of wp.hunks) {
    if (stop) break;
    if (!first && previous !== null && h.newStart > previous + 1) lines.push(`[OMITTED lines ${previous + 1}-${h.newStart - 1}]`);
    first = false;
    if (used + h.header.length + 1 > cap) { trimmed = true; stop = true; break; }
    lines.push(h.header);
    used += h.header.length + 1;
    let nr = h.newStart;
    for (const l of h.lines) {
      const hasNumber = l.sign === ' ' || l.sign === '+';
      const w = l.text.length + (hasNumber ? String(nr).length + 1 : 0) + 1;
      if (used + w > cap) { trimmed = true; stop = true; break; }
      if (l.sign === '-') { lines.push(`-${l.text}`); used += w; continue; }
      lines.push(`${nr}\t${l.sign}${l.text}`);
      shownNumbers.push(nr);
      previous = nr;
      nr += 1;
      used += w;
    }
  }
  if (trimmed && lastNumber > 0) lines.push(`[OMITTED lines ${previous === null ? 1 : previous + 1}-${lastNumber}]`);
  return { lines, shownNumbers, trimmed };
}

// Building the full advisor input. Returns { prompt, meta } or { refused: true, status, message }.
// The token is optional (random, from the advisor script), appended before the hash.
function buildInput({ env, question, planSection, context, token }) {
  const S = caps(env);
  const { fields, order } = parseFields(question);
  const decision = String(fields.DECISION ?? '').trim();
  if (!decision) return { refused: true, status: ADVISOR_STATUSES.REFUSED_MISSING_DECISION, message: `question without the DECISION field. Template:\n${TEMPLATE}` };
  // Base of the paths: the worktree of the team worker (OMC_TEAM_WORKTREE_PATH) or OMC_PROVIDER_FILE_ROOT, like the base of the file guard.
  const base = env.OMC_TEAM_WORKTREE_PATH || env.OMC_PROVIDER_FILE_ROOT || '';
  let baseReal = null;
  try { baseReal = base ? realpathSync(base) : null; } catch { baseReal = null; }
  // Named files (the FILES field): paths separated by a space or a comma; verified before any read (fail-closed).
  const names = String(fields.FILES ?? '').split(/[,\s]+/).filter(Boolean);
  const named = [];
  for (const raw of names) {
    const w = base ? verifyPath(raw, base, { env }) : { refusal: 'no base directory (OMC_TEAM_WORKTREE_PATH and OMC_PROVIDER_FILE_ROOT are not set)' };
    if (w.refusal) return { refused: true, status: ADVISOR_STATUSES.REFUSED_PATH, message: `path ${raw} refused (${w.refusal}); fix the question or remove the FILES field` };
    named.push({ raw, real: w.real });
  }
  // git worktree: HEAD, stat and diff (no shell, -C on the worktree); a git error is a section with information, not a refusal (the diff helps, it is not a condition).
  // The diff base is the parameter OMC_PROVIDER_ADVISOR_DIFF_BASE (HEAD by default); for a team task the lead sets the
  // start ref of the task, because `git diff HEAD` does not cover changes the worker already committed; untracked files
  // (git ls-files --others --exclude-standard) join the diff and are embedded like named files (the same count and byte
  // limits; the typical task result is new files).
  const diffBase = String(env.OMC_PROVIDER_ADVISOR_DIFF_BASE || 'HEAD').trim() || 'HEAD';
  const git = (args) => spawnSync('git', ['-C', base, ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const gitOk = (result) => result && result.status === 0 ? String(result.stdout || '') : null;
  const head = base ? gitOk(git(['rev-parse', 'HEAD']))?.trim() || null : null;
  const statText = base ? gitOk(git(['diff', diffBase, '--stat'])) : null;
  const diffText = base ? gitOk(git(['diff', diffBase])) : null;
  const untracked = base ? (gitOk(git(['ls-files', '--others', '--exclude-standard'])) || '').split('\n').filter(Boolean) : [];
  // Fixed sections: context, plan, question (fields; materials trimmed to head plus tail).
  const sections = [];
  if (context) sections.push(`WORKER CONTEXT:\n${context}\n`);
  sections.push(planSection || 'TASK PLAN FROM THE LEAD: none found.\n');
  // Question fields in the template order, then the remaining ones in input order; each value goes through the material trimming (head plus tail).
  const ORDER = ['DECISION', 'TRIED', 'TEST TAIL', 'HYPOTHESIS', 'EVIDENCE', 'FILES'];
  const emitted = new Set();
  const questionParts = ['WORKER QUESTION (question template):'];
  for (const name of ORDER) {
    if (fields[name] === undefined) continue;
    emitted.add(name);
    questionParts.push(`${name}: ${trimMaterial(fields[name], S.materialHead, S.materialTail).text}`);
  }
  for (const name of order) {
    if (emitted.has(name)) continue;
    questionParts.push(`${name}: ${trimMaterial(fields[name], S.materialHead, S.materialTail).text}`);
  }
  sections.push(`${questionParts.join('\n')}\n`);
  // Budget of the whole input: the core (context, plan, question) is subtracted from the cap; components join greedily.
  const core = sections.join('\n');
  let left = S.input - core.length;
  const skippedDiff = [];
  const skippedFiles = [];
  const skippedUntracked = [];
  const shown = {};
  const shownFiles = [];
  const addFile = (file) => { if (!shownFiles.includes(file)) shownFiles.push(file); };
  // TASK DIFF: header, then the stat and per file; the stat whole or with a marker.
  const diffParts = [];
  if (!base) diffParts.push('TASK DIFF: no worktree (OMC_TEAM_WORKTREE_PATH and OMC_PROVIDER_FILE_ROOT are not set); there is no diff.');
  else if (statText === null || diffText === null) diffParts.push('TASK DIFF: reading the diff failed (no git repository or a diff over the read buffer).');
  else if (!diffText.trim() && untracked.length === 0) diffParts.push(`TASK DIFF: no changes (git diff ${diffBase} is empty and there are no untracked files).`);
  else if (!diffText.trim()) diffParts.push(`TASK DIFF: the diff against ${diffBase} is empty (changes are committed; untracked files below).`);
  else {
    diffParts.push(`TASK DIFF (git diff ${diffBase} --stat):`);
    for (const row of statText.trimEnd().split('\n')) {
      if (row.length + 1 > left - MARKER_RESERVE) { diffParts.push('[OMITTED: the diff stat is over the input budget]'); left = 0; break; }
      diffParts.push(row);
      left -= row.length + 1;
    }
    for (const wp of parseDiff(diffText)) {
      if (wp.binary) { skippedDiff.push(`${wp.file} (binary)`); continue; }
      const embedded = embedDiffFile(wp, Infinity);
      const block = embedded.lines.join('\n');
      if (wp.deleted) {
        if (block.length + 48 > left) { skippedDiff.push(`${wp.file} (input budget exhausted)`); continue; }
        diffParts.push(`=== diff file ${wp.file} (deleted) ===\n${block}`);
        left -= block.length + 48;
        addFile(wp.file);
        continue;
      }
      if (block.length > S.diffFile) { skippedDiff.push(`${wp.file} (${block.length} characters of diff; over the diff budget of a file ${S.diffFile})`); continue; }
      // A scan for secret patterns on the diff block before embedding: a hit means the file is skipped with a reason
      // (no shown entry), and the secret does not go to the advisor or to the provider.
      if (secretsInText(block).length > 0) { skippedDiff.push(`${wp.file} (suspected secret in the diff)`); continue; }
      if (block.length <= left - MARKER_RESERVE) {
        diffParts.push(`=== diff file ${wp.file} ===\n${block}`);
        left -= block.length + 48;
        addFile(wp.file);
        continue;
      }
      // A component within its own budget but over the input budget: trimmed on whole lines to the rest of the budget.
      const cut = embedDiffFile(wp, left);
      if (cut.shownNumbers.length > 0) {
        diffParts.push(`=== diff file ${wp.file} (trimmed to the input budget) ===\n${cut.lines.join('\n')}`);
        addFile(wp.file);
      } else {
        skippedDiff.push(`${wp.file} (input budget exhausted)`);
      }
      left = 0;
    }
  }
  // NAMED FILES: count, bytes per file and in total, input budget; over its own budget a file drops out whole.
  const fileParts = [];
  let totalBytes = 0;
  let embeddedCount = 0;
  for (const { raw, real } of named) {
    const rel = baseReal ? relative(baseReal, real) : real;
    let st = null;
    try { st = statSync(real); } catch { st = null; }
    if (!st || !st.isFile()) return { refused: true, status: ADVISOR_STATUSES.REFUSED_PATH, message: `path ${raw} refused (not a regular file)` };
    if (embeddedCount >= S.fileCount) { skippedFiles.push(`${rel} (file count limit ${S.fileCount})`); continue; }
    const bytes = st.size;
    if (bytes > S.fileBytes) { skippedFiles.push(`${rel} (${bytes} B; over the file budget ${S.fileBytes} B)`); continue; }
    if (totalBytes + bytes > S.filesTotalBytes) { skippedFiles.push(`${rel} (${bytes} B; in total over the files budget ${S.filesTotalBytes} B)`); continue; }
    let content = null;
    try { content = readFileSync(real, 'utf8'); } catch { content = null; }
    if (content === null) { skippedFiles.push(`${rel} (inaccessible at read time)`); continue; }
    if (content.includes('\u0000')) { skippedFiles.push(`${rel} (binary)`); continue; }
    // A scan for secret patterns on the file content before embedding: a hit means the file is skipped.
    if (secretsInText(content).length > 0) { skippedFiles.push(`${rel} (suspected secret in the content)`); continue; }
    const embeddedFile = embedFile(content, Math.min(S.fileBytes * 4, left));
    if (!embeddedFile.lines.length) { skippedFiles.push(`${rel} (input budget exhausted)`); continue; }
    const n = embeddedFile.lineCount;
    fileParts.push(`=== file ${rel} (${n} ${n === 1 ? 'line' : 'lines'}) ===\n${embeddedFile.lines.join('\n')}`);
    addFile(rel);
    left -= embeddedFile.lines.join('\n').length + 64;
    embeddedCount += 1;
    totalBytes += bytes;
  }
  // Assembly of the whole, omission markers and metadata for the journal.
  const parts = [core];
  if (diffParts.length) parts.push(diffParts.join('\n') + '\n');
  if (fileParts.length || skippedFiles.length) {
    const filesBlock = [...fileParts];
    if (skippedFiles.length) filesBlock.push(`FILES OMITTED: ${skippedFiles.join('; ')}`);
    parts.push(`NAMED FILES (embedded by the script):\n${filesBlock.join('\n')}\n`);
  }
  // UNTRACKED FILES: the result of a task is often new files; embedded like named files (embedFile with line numbers,
  // the same count and byte limits, a separate budget counter) with line numbers and an entry in shown, so the advisor
  // may quote them legitimately.
  const untrackedParts = [];
  let untrackedBytes = 0;
  let untrackedCount = 0;
  for (const name of untracked) {
    const real = join(base, name);
    let st = null;
    try { st = statSync(real); } catch { st = null; }
    if (!st || !st.isFile()) { skippedUntracked.push(`${name} (inaccessible at read time)`); continue; }
    if (untrackedCount >= S.fileCount) { skippedUntracked.push(`${name} (file count limit ${S.fileCount})`); continue; }
    if (st.size > S.fileBytes) { skippedUntracked.push(`${name} (${st.size} B; over the file budget ${S.fileBytes} B)`); continue; }
    if (untrackedBytes + st.size > S.filesTotalBytes) { skippedUntracked.push(`${name} (${st.size} B; in total over the files budget ${S.filesTotalBytes} B)`); continue; }
    let content = null;
    try { content = readFileSync(real, 'utf8'); } catch { content = null; }
    if (content === null || content.includes('\u0000')) { skippedUntracked.push(`${name} (binary or inaccessible)`); continue; }
    if (secretsInText(content).length > 0) { skippedUntracked.push(`${name} (suspected secret in the content)`); continue; }
    const embeddedUntracked = embedFile(content, Math.min(S.fileBytes * 4, left));
    if (!embeddedUntracked.lines.length) { skippedUntracked.push(`${name} (input budget exhausted)`); continue; }
    untrackedParts.push(`=== file ${name} (untracked, ${embeddedUntracked.lineCount} lines) ===\n${embeddedUntracked.lines.join('\n')}`);
    addFile(name);
    left -= embeddedUntracked.lines.join('\n').length + 64;
    untrackedCount += 1;
    untrackedBytes += st.size;
  }
  if (untrackedParts.length || skippedUntracked.length) {
    const untrackedBlock = [...untrackedParts];
    if (skippedUntracked.length) untrackedBlock.push(`UNTRACKED FILES OMITTED: ${skippedUntracked.join('; ')}`);
    parts.push(`UNTRACKED FILES (embedded by the script):\n${untrackedBlock.join('\n')}\n`);
  }
  if (skippedDiff.length) parts.push(`FILES OMITTED FROM THE DIFF: ${skippedDiff.join('; ')}`);
  let prompt = parts.join('\n');
  if (token) prompt = `${prompt}\nINPUT TOKEN: ${token}\n`; // the token in the input (proof of reading); the tail survives the hard cap
  if (prompt.length > S.input) { // the final guarantee of the cap: head plus tail in proportion to the cap itself (with a reserve for the marker)
    const headChars = Math.floor(S.input * 0.6);
    prompt = trimMaterial(prompt, headChars, S.input - headChars - 80).text;
  }
  // shown is recomputed from the FINISHED prompt (after the hard trimming), not from the buffers before trimming: the
  // trimming removes lines, so a shown list from the embedded numbers would be too wide and the verdict validator
  // would treat a quote of a line the advisor did not see as valid.
  for (const [file, nums] of Object.entries(shownFromPrompt(prompt))) shown[file] = rangesFromNumbers(nums.sort((x, y) => x - y));
  const meta = {
    input_hash: createHash('sha256').update(prompt).digest('hex'),
    size: Buffer.byteLength(prompt, 'utf8'),
    files: shownFiles,
    shown,
    head,
    decision_chars: decision.length,
    token: token || null,
  };
  return { prompt, meta };
}

// --- Scan for secret patterns: the diff, named files and untracked files are scanned before embedding (a hit means the
// file is skipped), and the advice of the advisor is redacted before stdout and before the journal write
// (provider-advisor.cjs). No network, no key.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Za-z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Za-z ]*PRIVATE KEY-----/g, // PEM keys
  /sk-[A-Za-z0-9_\-]{20,}/g, // keys of the form sk-...
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/g, // temporary AWS access key id (the whole key only: "ASIA" also starts words in capitals)
  /\b(?:gsk_|xai-)[A-Za-z0-9]{20}[A-Za-z0-9_-]*/g, // 20 letters and digits: `gsk_` and `xai-` also start ordinary names
  /Bearer [A-Za-z0-9._\-]{20,}/g, // tokens of the Authorization header
  /(?:^|[+\- \t])([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)\s*=\s*(["']?)(\S{12,})\2\s*$/gm, // lines and diff rows NAME=long value
];
function secretsInText(text) {
  const s = String(text ?? '');
  const hits = [];
  for (const pattern of SECRET_PATTERNS) hits.push(...String(s).match(pattern) || []);
  return [...new Set(hits)].slice(0, 50); // unique, at most 50 hits (diagnostic text)
}
function redactPatterns(text) {
  let s = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) s = s.replace(new RegExp(pattern.source, pattern.flags), '[REDACTED]');
  return s;
}

// The diff set of a task: `git diff <diffBase>` plus untracked files (content with headers). The shared carrier of the
// stale hash in the advisor script and of the DIFF section in buildInput; returns { ok, text } or { ok: false } with no
// worktree or on a git failure.
function collectTaskDiff(base, diffBase = 'HEAD') {
  if (!base) return { ok: false, text: '' };
  const g = spawnSync('git', ['-C', base, 'diff', diffBase], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (!g || g.status !== 0) return { ok: false, text: '' };
  let text = String(g.stdout || '');
  const ls = spawnSync('git', ['-C', base, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (ls && ls.status === 0) {
    for (const name of String(ls.stdout || '').split('\n')) {
      if (!name.trim()) continue;
      let content = null;
      try { content = readFileSync(join(base, name), 'utf8'); } catch { continue; }
      if (content === null || content.includes('\u0000')) continue; // binary files stay out of the set
      text += `\n=== untracked ${name} ===\n${content}`;
    }
  }
  return { ok: true, text };
}

// Comparison of the diff hash of the start row with the current set. Returns true (STALE), false (fresh) or null
// (state unknown).
function compareDiffHash({ base, diffBase = 'HEAD', startHash, startHead = null, nowHead = null } = {}) {
  if (!startHash) return null;
  if (!base) return null;
  const z = collectTaskDiff(base, diffBase);
  if (!z.ok) return null;
  const hash = createHash('sha256').update(z.text).digest('hex');
  if (hash !== startHash) return true;
  if (startHead) {
    const g = nowHead !== null ? { status: 0, stdout: nowHead } : spawnSync('git', ['-C', base, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const h = g && g.status === 0 ? String(g.stdout || '').trim() : null;
    if (h && h !== startHead) return true;
  }
  return false;
}

module.exports = { enabled, caps, parseFields, trimMaterial, verifyPath, embedFile, embedDiffFile, parseDiff, shownFromPrompt, buildInput, secretsInText, redactPatterns, collectTaskDiff, compareDiffHash, TEMPLATE, FIELD_NAMES, credentialPatterns };
