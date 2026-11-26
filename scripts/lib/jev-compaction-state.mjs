/* global process, Buffer */
/**
 * Classic-hook side of the Jev compaction module (hooks/jev-compaction.mjs, point `compaction`).
 *
 * Everything here runs only when OMC_JEV names the point `compaction` (named-only: `all` does not
 * enable it) and TYPESAFE_API_KEY is set, like the module itself. Every function is fail-open: an
 * error never changes what a hook outputs otherwise.
 *
 * 1. Work-state registry. PostToolUse (post-tool-verifier.mjs) and PostToolUseFailure
 *    (post-tool-use-failure.mjs) append small events per session and agent to
 *    <state dir>/compaction-registry/<session>--<agent|main>.jsonl: files changed by
 *    Write/Edit/MultiEdit/NotebookEdit, git commands that change a repository, open tasks (TodoWrite,
 *    TaskCreate, TaskUpdate, a plan tool's `items`) and the last tool error until a successful call of
 *    the same tool with the same key. Appending keeps parallel hooks from losing each other's events;
 *    the file is folded when read.
 * 2. Compaction log. The module cannot append, so it writes one JSON file per event to
 *    <state dir>/compaction-spool/<session>--*.json. SessionStart appends the files of its session to
 *    compaction.jsonl in the Jev log directory (next to shadow.jsonl) and removes them.
 * 3. After a compaction (SessionStart, source `compact`) the newest unclaimed module record of the
 *    session explains it. When the record says the built-in summary ran (fallback, shadow) or there is
 *    no record (`module_missing`), the registry goes to the model as additional context (at most
 *    REGISTRY_CHARS characters); after a Jev compaction the messages stayed verbatim, so it is left
 *    out. MISSING_TO_NOTIFY `module_missing` within a day give one systemMessage.
 *
 * 4. Pasted-text retention. With OMC_JEV_COMPACT_PASTES the module writes the pasted text it moves out of the conversation to
 *    <state dir>/compaction-pastes/<session>/<hash>.txt (see its header). SessionStart (any source but `compact`) first touches
 *    `.compaction` in the current session's directory, if there is one, then removes the other session directories whose newest
 *    file is older than OMC_JEV_PASTES_DAYS days (default 14; a whole number from 1 to 99999; `0` or any other value keeps
 *    everything). A link and anything outside that directory stay, and without a session id nothing is touched or removed. It
 *    runs only while the compaction point is enabled, and a session idle for longer than the days can find that a trace names a
 *    file that is gone.
 * 5. Archive retention. With OMC_JEV_COMPACT_ARCHIVE the module writes the calls and results it cuts to
 *    <state dir>/compaction-archive/<session>/<tool_use_id>.txt (see its header), and every compaction that archives touches
 *    `.compaction` in the session's directory. SessionStart (any source but `compact`) removes the other session directories whose
 *    newest file is older than OMC_JEV_ARCHIVE_DAYS days (default 14; a whole number from 1 to 99999; `0` or any other value keeps
 *    everything): the directory is renamed first, its plain files and then the empty directory are removed, a link is never followed
 *    or removed, the current session's directory stays, and nothing is removed without a session id. The work stops after
 *    ARCHIVE_SWEEP_MS (the rest waits for the next start); an error never changes what the hook outputs. A session idle for longer
 *    than the days can find that a trace names a file that is gone.
 *
 * <state dir> is OMC_JEV_LOG_DIR when set, else ~/.omc/state/jev: the module knows only the home
 * directory, not the project's state root. Registry text is masked with scripts/lib/jev-mask.mjs, the
 * masking the module uses for what it sends.
 */

import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { parseJevEnv, resolveJevLogMaxBytes, rotateJevLog } from '../jev-resolve.mjs';
import { atomicWriteFileSync } from './atomic-write.mjs';
import { maskSecrets } from './jev-mask.mjs';

export const POINT = 'compaction';
export const REGISTRY_CHARS = 1500;
const MAX_FILES = 20;
const MAX_GIT = 5;
const MAX_TASKS = 15;
const MAX_REGISTRY_LINES = 5000;
// A module record older than this does not explain a compaction.
const RECORD_MATCH_MS = 15 * 60_000;
const MISSING_WINDOW_MS = 24 * 3600_000;
const MISSING_TO_NOTIFY = 3;
const MAX_AGE_MS = 7 * 24 * 3600_000;
const PASTES_DAYS_DEFAULT = 14;
const ARCHIVE_DAYS_DEFAULT = 14;
const ARCHIVE_SWEEP_MS = 200;
// A session directory the sweep renamed to be removed: the module names a session directory with [A-Za-z0-9_-] only, so this suffix never names a live one.
const ARCHIVE_DOOMED = '.removing';
// The file of a session directory that every compaction with the archive touches (the module's ARCHIVE_MARKER).
const ARCHIVE_MARKER = '.compaction';
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// git subcommands that change the repository or its remote (status, log and diff are not worth a line).
const GIT_CHANGE = /\bgit(?:\.exe)?(?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--[a-z-]+(?:=\S+)?))*\s+(commit|push|pull|fetch|merge|rebase|reset|checkout|switch|restore|add|rm|mv|stash|tag|cherry-pick|revert|apply|am|worktree|clone|init|branch\s+(?:-[dDmMcC]\b|--delete|--move|[^-\s]))/;
const MODULE_FILE = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'hooks', 'jev-compaction.mjs');

export const MISSING_MESSAGE =
  '[OMC] The Jev compaction module (hooks/jev-compaction.mjs) left no record for 3 compactions in the last day, so they used the built-in summary. ' +
  'Mods need Claude Code v2.1.287 or later and are off with disableAllHooks or --safe-mode; `claude plugin validate` on the plugin directory lists the loaded hooks module.';

/** Is the point enabled (shadow or active) for this environment? */
export function compactionEnabled(env = process.env) {
  try { return parseJevEnv(POINT, env) !== 'off'; } catch { return false; }
}

/** Directory of the registry and the module's spool. */
export function stateDirOf(env = process.env) {
  return env.OMC_JEV_LOG_DIR || join(homedir(), '.omc', 'state', 'jev');
}

const safeName = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);

// The directory name of a session in compaction-archive: the same as archiveSegment of hooks/jev-compaction.mjs (an id that had to change, a Windows device name or an id of
// more than 80 characters gets a hash of the original, so two ids never share a directory).
const archiveFnv = (text, seed = 0x811c9dc5) => {
  let h = seed;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
};
function archiveSegment(id) {
  const raw = String(id ?? '');
  if (!raw) return '';
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  if (clean === raw && clean.length <= 80 && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(clean)) return clean;
  return `${clean.slice(0, 63)}-${archiveFnv(raw) + archiveFnv(raw, 0x050c5d1f)}`;
}
const oneLine = (s, max) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1) + '…' : t; };
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ } };

export function registryPath(sessionId, agentId, env = process.env) {
  return join(stateDirOf(env), 'compaction-registry', `${safeName(sessionId)}--${agentId ? safeName(agentId) : 'main'}.jsonl`);
}

// Small whole-file state; a failed write keeps the old content (the next event writes again).
function writeAtomic(path, text) {
  try { atomicWriteFileSync(path, text); return true; } catch { return false; }
}

function readJson(path, fallback) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return fallback; sleepSync(3); }
  }
  return fallback;
}

function responseText(response) {
  if (typeof response === 'string') return response;
  try { return JSON.stringify(response ?? ''); } catch { return ''; }
}

// TaskCreate answers with the new id in its record or its text.
function taskIdOf(response) {
  const r = response && typeof response === 'object' ? response : {};
  const direct = r.task?.id ?? r.taskId ?? r.id;
  if (direct !== undefined && direct !== null) return String(direct);
  const m = /#\s*(\w+)|\btask\s+(?:id\s*)?[:#]?\s*(\w+)/i.exec(responseText(response));
  return m ? m[1] || m[2] : undefined;
}

/** What makes "the same call" for resolving an error: the file, the first two words of a command, the URL or the pattern. */
export function errorKey(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (typeof i.file_path === 'string') return i.file_path;
  if (typeof i.notebook_path === 'string') return i.notebook_path;
  if (typeof i.command === 'string') return i.command.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, '').trim().split(/\s+/).slice(0, 2).join(' ');
  if (typeof i.url === 'string') return i.url;
  if (typeof i.pattern === 'string') return `${i.pattern} ${i.path ?? ''}`.trim();
  return `${tool} ${responseText(i).slice(0, 100)}`;
}

/** Registry events of one PostToolUse ("post") or PostToolUseFailure ("failure") input. */
export function recordCompactionState(kind, data, env = process.env) {
  try {
    const sessionId = data?.session_id || data?.sessionId;
    if (!sessionId || !compactionEnabled(env)) return;
    const tool = String(data.tool_name || data.toolName || '');
    const rawInput = data.tool_input ?? data.toolInput;
    const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
    const path = registryPath(sessionId, data.agent_id || data.agentId, env);
    const marker = path.replace(/\.jsonl$/, '.open-error.json');
    const events = [];
    const key = errorKey(tool, input);
    if (kind === 'failure') {
      const what = input.command ?? input.file_path ?? input.url ?? input.pattern ?? responseText(input);
      events.push({ t: 'error', tool, key, input: oneLine(maskSecrets(what), 160), text: oneLine(maskSecrets(data.error ?? responseText(data.tool_response)), 300) });
      writeAtomic(marker, JSON.stringify({ tool, key }));
    } else {
      if (existsSync(marker)) {
        const open = readJson(marker, null);
        if (open && open.tool === tool && open.key === key) { events.push({ t: 'ok' }); try { rmSync(marker, { force: true }); } catch { /* resolved next time */ } }
      }
      if (FILE_TOOLS.has(tool)) {
        const file = input.file_path || input.notebook_path;
        if (typeof file === 'string' && file) events.push({ t: 'file', v: file });
      } else if (SHELL_TOOLS.has(tool) && typeof input.command === 'string' && GIT_CHANGE.test(input.command)) {
        events.push({ t: 'git', v: oneLine(maskSecrets(input.command, { keepGitHashes: true }), 200) });
      } else if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
        events.push({ t: 'tasks', v: input.todos.filter((x) => x && x.status !== 'completed').slice(0, MAX_TASKS).map((x) => ({ text: oneLine(x.content ?? x.activeForm, 150), status: String(x.status ?? '') })) });
      } else if (/(^|__)update_plan$/.test(tool) && Array.isArray(input.items)) {
        events.push({ t: 'tasks', v: input.items.filter((x) => x && x.status !== 'completed').slice(0, MAX_TASKS).map((x) => ({ text: oneLine(x.content, 150), status: String(x.status ?? '') })) });
      } else if (tool === 'TaskCreate' && (input.subject || input.description)) {
        events.push({ t: 'task+', id: taskIdOf(data.tool_response) ?? null, text: oneLine(input.subject || input.description, 150) });
      } else if (tool === 'TaskUpdate' && input.taskId !== undefined) {
        events.push({ t: 'task~', id: String(input.taskId), status: String(input.status ?? ''), ...(input.subject ? { text: oneLine(input.subject, 150) } : {}) });
      }
    }
    if (!events.length) return;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, events.map((ev) => JSON.stringify(ev)).join('\n') + '\n', 'utf8');
  } catch { /* the registry never breaks a hook */ }
}

/** The registry folded from its event file: {files, git, tasks, error}, or undefined without a file. */
export function foldRegistry(sessionId, agentId, env = process.env) {
  let text;
  try { text = readFileSync(registryPath(sessionId, agentId, env), 'utf8'); } catch { return undefined; }
  const reg = { files: [], git: [], tasks: [], error: null };
  for (const line of text.split('\n').slice(-MAX_REGISTRY_LINES)) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.t === 'file') reg.files = reg.files.filter((p) => p !== ev.v).concat(ev.v).slice(-MAX_FILES);
    else if (ev.t === 'git') reg.git = reg.git.concat(ev.v).slice(-MAX_GIT);
    else if (ev.t === 'tasks' && Array.isArray(ev.v)) reg.tasks = ev.v;
    else if (ev.t === 'task+') reg.tasks = reg.tasks.filter((x) => !ev.id || x.id !== ev.id).concat({ ...(ev.id ? { id: ev.id } : {}), text: ev.text, status: 'pending' }).slice(-MAX_TASKS);
    else if (ev.t === 'task~') {
      if (ev.status === 'completed' || ev.status === 'deleted') reg.tasks = reg.tasks.filter((x) => x.id !== ev.id);
      else reg.tasks = reg.tasks.map((x) => (x.id === ev.id ? { ...x, ...(ev.status ? { status: ev.status } : {}), ...(ev.text ? { text: ev.text } : {}) } : x));
    } else if (ev.t === 'error') reg.error = ev;
    else if (ev.t === 'ok') reg.error = null;
  }
  return reg;
}

const STATUS_LABEL = { in_progress: 'in progress', pending: 'pending' };

/** The registry as text for the model, at most REGISTRY_CHARS characters; '' when there is nothing to say. */
export function renderRegistry(sessionId, agentId, env = process.env, writers) {
  const reg = foldRegistry(sessionId, agentId, env);
  if (!reg) return '';
  const lines = [];
  if (reg.tasks.length) lines.push('Open tasks: ' + reg.tasks.map((x) => `[${STATUS_LABEL[x.status] || x.status || '?'}] ${x.text}`).join('; '));
  if (reg.error) lines.push(`Last tool error with no later successful call of the same: ${reg.error.tool}(${reg.error.input}): ${reg.error.text}`);
  if (reg.git.length) lines.push('Recent git changes: ' + reg.git.join(' | '));
  // With the cleaning writers of the SessionStart hook a changed file is written exactly (escaped, not cleaned), and a text over
  // the limit is cut by whole lines.
  const files = writers ? reg.files.map((file) => writers.escapeIdentifier(file, 250)) : [...reg.files];
  if (!lines.length && !files.length) return '';
  const head = '[OMC: work state from before the compaction that the summary may have left out]';
  let text;
  for (;;) { // drop the oldest changed files first until the text fits
    const fileLine = files.length ? [`Changed files (newest last): ${files.join('; ')}`] : [];
    text = [head, ...lines, ...fileLine].join('\n');
    if (text.length <= REGISTRY_CHARS || !files.length) break;
    files.shift();
  }
  if (writers) return writers.fitLines(text, REGISTRY_CHARS);
  return text.length > REGISTRY_CHARS ? text.slice(0, REGISTRY_CHARS - 1) + '…' : text;
}

function appendRows(logDir, rows, env = process.env) {
  if (!rows.length) return true;
  try {
    mkdirSync(logDir, { recursive: true });
    const compactionPath = join(logDir, 'compaction.jsonl');
    // Apply the rotation limit to the compaction log like other Jev logs (OMC_JEV_LOG_MAX_MB)
    rotateJevLog(compactionPath, resolveJevLogMaxBytes(env));
    appendFileSync(compactionPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    return true;
  } catch { return false; }
}

// The agent whose transcript a SessionStart names (<session>/subagents/agent-<id>.jsonl), else undefined.
const agentOfTranscript = (path) => { const m = /[\\/]subagents[\\/]agent-([^\\/]+)\.jsonl$/.exec(String(path ?? '')); return m ? m[1] : undefined; };

// A session that started before the module file was installed runs the classic hooks of the new
// version but not the module (mods load at session start), so its compactions say nothing about it.
function startedBeforeModule(transcriptPath) {
  let installed;
  try { installed = statSync(MODULE_FILE).mtimeMs; } catch { return false; }
  if (!transcriptPath) return false;
  let head = '';
  try {
    const fd = openSync(transcriptPath, 'r');
    try { const buf = Buffer.alloc(65536); head = buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, 0)); } finally { closeSync(fd); }
  } catch { return false; }
  const m = /"timestamp"\s*:\s*"([^"]+)"/.exec(head);
  const started = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(started) && started < installed;
}

function noteMissing(stateDir, now) {
  const path = join(stateDir, 'compaction-missing.json');
  const state = readJson(path, {}) || {};
  const times = (Array.isArray(state.times) ? state.times : []).filter((t) => now - t < MISSING_WINDOW_MS).concat(now);
  const notify = times.length >= MISSING_TO_NOTIFY && !(state.notified_at && now - state.notified_at < MISSING_WINDOW_MS);
  try { writeAtomic(path, JSON.stringify({ times: times.slice(-20), notified_at: notify ? now : state.notified_at })); } catch { /* next time */ }
  return notify;
}

function sweep(dir, now) {
  try {
    for (const name of readdirSync(dir)) {
      try { if (now - statSync(join(dir, name)).mtimeMs > MAX_AGE_MS) rmSync(join(dir, name), { force: true }); } catch { /* gone */ }
    }
  } catch { /* no directory */ }
}

/** OMC_JEV_PASTES_DAYS: days a session directory of compaction-pastes is kept, a whole number from 1 to 99999 (unset or empty: the default); 0 or any other value: no removal. */
export function pastesDays(env = process.env) {
  const raw = String(env.OMC_JEV_PASTES_DAYS ?? '').trim();
  if (!raw) return PASTES_DAYS_DEFAULT;
  return /^[1-9]\d{0,4}$/.test(raw) ? Number(raw) : 0;
}

// Does the directory hold no file (nor itself) changed since `cutoff`? A directory that cannot be read counts as new.
function pastesDirIsOld(dir, cutoff) {
  try {
    if (statSync(dir).mtimeMs >= cutoff) return false;
    for (const name of readdirSync(dir)) if (lstatSync(join(dir, name)).mtimeMs >= cutoff) return false;
    return true;
  } catch { return false; }
}

/**
 * Marks the current session's directory of compaction-pastes as live (touches `.compaction` when the directory exists), then removes
 * the other session directories whose newest file is older than OMC_JEV_PASTES_DAYS days. Returns the number removed. A link stays;
 * without a session id nothing is touched or removed.
 */
export function sweepPastes(sessionId, now = Date.now(), env = process.env) {
  const days = pastesDays(env);
  if (!days || !sessionId) return 0;
  const root = join(stateDirOf(env), 'compaction-pastes');
  const current = safeName(sessionId);
  const cutoff = now - days * 24 * 3600_000;
  let removed = 0;
  try {
    // A session resumed after the days must not lose its files to the next start of another session.
    try {
      const marker = join(root, current, '.compaction');
      if (lstatSync(join(root, current)).isDirectory()) {
        writeFileSync(marker, `${new Date(now).toISOString()}\n`);
        utimesSync(marker, new Date(now), new Date(now));
      }
    } catch { /* no directory of this session */ }
    for (const name of readdirSync(root)) {
      if (name === current) continue;
      const dir = join(root, name);
      try {
        if (!lstatSync(dir).isDirectory() || !pastesDirIsOld(dir, cutoff)) continue;
        rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch { /* in use or gone: the next start tries again */ }
    }
  } catch { /* no directory */ }
  return removed;
}

/** OMC_JEV_ARCHIVE_DAYS: days a session directory of compaction-archive is kept, a whole number from 1 to 99999 (unset or empty: the default); 0 or any other value: no removal. */
export function archiveDays(env = process.env) {
  const raw = String(env.OMC_JEV_ARCHIVE_DAYS ?? '').trim();
  if (!raw) return ARCHIVE_DAYS_DEFAULT;
  return /^[1-9]\d{0,4}$/.test(raw) ? Number(raw) : 0;
}

// "old" when every plain file of the directory changed before the cutoff (the marker first), "new" when one is newer or the directory cannot be read, "stop" when `stop()` says the budget is
// over during the check (the directory waits for the next start).
function archiveFilesAge(dir, cutoff, stop) {
  try {
    const names = readdirSync(dir).sort((a, b) => (a === ARCHIVE_MARKER ? -1 : b === ARCHIVE_MARKER ? 1 : 0));
    for (const f of names) {
      if (stop()) return 'stop';
      const st = lstatSync(join(dir, f));
      if (st.isFile() && st.mtimeMs >= cutoff) return 'new';
    }
    return 'old';
  } catch { return 'new'; }
}

const insideDir = (path, dir) => path.toLowerCase().startsWith(dir.toLowerCase().replace(/[\\/]+$/, '') + sep);

/**
 * Removes the session directories of compaction-archive whose newest file is older than OMC_JEV_ARCHIVE_DAYS days: the directory is renamed to <name>.<random>.removing, its plain files are
 * removed, then the empty directory. Never the current session's directory, never a link (not followed, not removed), nothing outside the root (the real path stays inside it), nothing
 * without the current session's id. A directory already renamed is finished first, whatever its age. At most `budgetMs` of work (at least one file); the rest waits for the next start.
 * Returns the counts, or undefined when the retention is off, there is no root or no session id.
 */
export function sweepArchive(sessionId, now = Date.now(), env = process.env, budgetMs = ARCHIVE_SWEEP_MS) {
  const days = archiveDays(env);
  if (!days || !sessionId) return undefined;
  const t0 = performance.now();
  const root = join(stateDirOf(env), 'compaction-archive');
  let realRoot;
  try {
    if (lstatSync(root).isSymbolicLink()) return undefined;
    realRoot = realpathSync(root);
  } catch { return undefined; }
  const out = { days, removed_dirs: 0, removed_files: 0, removed_bytes: 0, links_skipped: 0, stopped: false, ms: 0 };
  const over = () => performance.now() - t0 >= budgetMs;
  const current = archiveSegment(sessionId);
  const cutoff = now - days * 24 * 3600_000;
  let names = [];
  try { names = readdirSync(root).sort(); } catch { return undefined; }
  const queue = names.filter((n) => n.endsWith(ARCHIVE_DOOMED));
  let checked = 0; // directories whose files were checked: the first check always runs
  for (const n of names) {
    if (n.endsWith(ARCHIVE_DOOMED) || n === current) continue;
    let st;
    try { st = lstatSync(join(root, n)); } catch { continue; }
    if (st.isSymbolicLink()) { out.links_skipped++; continue; }
    if (!st.isDirectory() || st.mtimeMs >= cutoff) continue;
    const age = archiveFilesAge(join(root, n), cutoff, () => over() && (checked > 0 || out.removed_files > 0));
    checked++;
    if (age === 'stop') { out.stopped = true; break; }
    if (age === 'old') queue.push(n);
  }
  for (let q = 0; q < queue.length; q++) {
    const n = queue[q];
    let dir = join(root, n);
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink()) { out.links_skipped++; continue; }
      if (!st.isDirectory() || !insideDir(realpathSync(dir), realRoot)) continue;
      if (!n.endsWith(ARCHIVE_DOOMED)) {
        const doomed = `${dir}.${Math.random().toString(36).slice(2, 8)}${ARCHIVE_DOOMED}`;
        renameSync(dir, doomed);
        dir = doomed;
      }
      let left = 0;
      let halted = false;
      for (const f of readdirSync(dir)) {
        if (over() && (out.removed_files || out.removed_dirs)) { out.stopped = true; halted = true; break; }
        const p = join(dir, f);
        const fst = lstatSync(p);
        if (fst.isSymbolicLink()) { out.links_skipped++; left++; continue; }
        if (!fst.isFile()) { left++; continue; }
        unlinkSync(p);
        out.removed_files++;
        out.removed_bytes += fst.size;
      }
      if (halted) break;
      if (!left) { rmdirSync(dir); out.removed_dirs++; }
    } catch { /* in use or removed meanwhile: the next start tries again */ }
    if (over()) { out.stopped = out.stopped || q < queue.length - 1; break; }
  }
  out.ms = Math.round(performance.now() - t0);
  return out;
}

// The session's spool files: [{name, record}], record undefined for an unreadable file.
function readSpool(spoolDir, sessionId) {
  let names = [];
  try { names = readdirSync(spoolDir).filter((n) => n.startsWith(`${safeName(sessionId)}--`) && n.endsWith('.json')).sort(); } catch { return []; }
  return names.map((name) => {
    let record;
    try { record = JSON.parse(readFileSync(join(spoolDir, name), 'utf8')); } catch { record = undefined; }
    return { name, record: record && typeof record === 'object' ? record : undefined };
  });
}

// The compaction a SessionStart reports: the module record of the subagent its transcript names, else
// the newest main-loop record, else the newest record within RECORD_MATCH_MS. The last step is for a
// subagent's compaction whose SessionStart names no agent (its agent_id was empty in our runs): without
// it that compaction would count as module_missing.
function claim(entries, data, now) {
  const fresh = entries
    .filter((x) => x.record?.event === 'compact' && now - Date.parse(x.record.ts) < RECORD_MATCH_MS)
    .sort((a, b) => Date.parse(b.record.ts) - Date.parse(a.record.ts));
  const agent = agentOfTranscript(data.transcript_path);
  if (agent) {
    const exact = fresh.find((x) => x.record.agent_id === agent || x.record.agent_id === `agent-${agent}`);
    if (exact) return exact;
  }
  return fresh.find((x) => x.record.agent_id === null || x.record.agent_id === undefined) || fresh[0];
}

/**
 * SessionStart: move the session's module records to compaction.jsonl; after a compaction return
 * {context?, systemMessage?} for the hook output. `logDir` is the Jev log directory of the session's
 * state root (where shadow.jsonl goes). `writers` (optional) is the text cleaning module of the hook: with it
 * the changed files in the registry text are written exactly (see renderRegistry).
 */
export function afterSessionStart(data, { logDir, writers } = {}, env = process.env) {
  try {
    if (!compactionEnabled(env)) return {};
    const sessionId = data?.session_id || data?.sessionId;
    if (!sessionId) return {};
    const now = Date.now();
    const stateDir = stateDirOf(env);
    const spoolDir = join(stateDir, 'compaction-spool');
    const target = env.OMC_JEV_LOG_DIR || logDir || stateDir;
    const entries = readSpool(spoolDir, sessionId);
    const claimed = data.source === 'compact' ? claim(entries, data, now) : undefined;
    // Fresh compact records another SessionStart of this session will claim stay in the spool.
    const merged = entries.filter((x) => x === claimed || !(x.record?.event === 'compact' && now - Date.parse(x.record.ts) < RECORD_MATCH_MS && data.source === 'compact'));
    const rows = merged.map((x) => x.record ?? { ts: new Date(now).toISOString(), point: POINT, event: 'bad_module_file', session_id: sessionId, agent_id: null, file: x.name });
    const out = {};
    if (data.source === 'compact') {
      const agent = claimed ? claimed.record.agent_id : (agentOfTranscript(data.transcript_path) ?? data.agent_id ?? null);
      if (!claimed && startedBeforeModule(data.transcript_path)) {
        // The session started before the module was installed: not a missing module, but the built-in
        // summary ran, so the registry still goes in.
        rows.push({ ts: new Date(now).toISOString(), point: POINT, event: 'session_before_module', session_id: sessionId, agent_id: data.agent_id ?? null });
      } else if (!claimed) {
        rows.push({ ts: new Date(now).toISOString(), point: POINT, event: 'module_missing', session_id: sessionId, agent_id: data.agent_id ?? null, agent_type: data.agent_type ?? null });
        if (noteMissing(stateDir, now)) out.systemMessage = MISSING_MESSAGE;
      }
      if (!claimed || claimed.record.result !== 'jev') {
        const text = renderRegistry(sessionId, agent, env, writers);
        if (text) out.context = text;
      }
    }
    if (appendRows(target, rows, env)) {
      for (const x of merged) { try { rmSync(join(spoolDir, x.name), { force: true }); } catch { /* moved twice at worst */ } }
    }
    if (data.source === 'startup') {
      sweep(spoolDir, now);
      sweep(join(stateDir, 'compaction-registry'), now);
    }
    if (data.source !== 'compact') {
      sweepPastes(sessionId, now, env);
      // The archive's retention never changes what the hook outputs; a row says what it removed.
      try {
        const swept = sweepArchive(sessionId, now, env);
        if (swept && (swept.removed_dirs || swept.removed_files || swept.links_skipped || swept.stopped)) {
          appendRows(target, [{ ts: new Date(now).toISOString(), point: POINT, event: 'archive_retention', session_id: sessionId, agent_id: null, ...swept }], env);
        }
      } catch { /* retention never changes the hook output */ }
    }
    return out;
  } catch { return {}; }
}
