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
 * <state dir> is OMC_JEV_LOG_DIR when set, else ~/.omc/state/jev: the module knows only the home
 * directory, not the project's state root. Registry text is masked with scripts/lib/jev-mask.mjs, the
 * masking the module uses for what it sends.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJevEnv } from '../jev-resolve.mjs';
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
    const input = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
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
        events.push({ t: 'git', v: oneLine(maskSecrets(input.command), 200) });
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
export function renderRegistry(sessionId, agentId, env = process.env) {
  const reg = foldRegistry(sessionId, agentId, env);
  if (!reg) return '';
  const lines = [];
  if (reg.tasks.length) lines.push('Open tasks: ' + reg.tasks.map((x) => `[${STATUS_LABEL[x.status] || x.status || '?'}] ${x.text}`).join('; '));
  if (reg.error) lines.push(`Last tool error with no later successful call of the same: ${reg.error.tool}(${reg.error.input}): ${reg.error.text}`);
  if (reg.git.length) lines.push('Recent git changes: ' + reg.git.join(' | '));
  const files = [...reg.files];
  if (!lines.length && !files.length) return '';
  const head = '[OMC: work state from before the compaction that the summary may have left out]';
  let text;
  for (;;) { // drop the oldest changed files first until the text fits
    const fileLine = files.length ? [`Changed files (newest last): ${files.join('; ')}`] : [];
    text = [head, ...lines, ...fileLine].join('\n');
    if (text.length <= REGISTRY_CHARS || !files.length) break;
    files.shift();
  }
  return text.length > REGISTRY_CHARS ? text.slice(0, REGISTRY_CHARS - 1) + '…' : text;
}

function appendRows(logDir, rows) {
  if (!rows.length) return true;
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'compaction.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
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
 * state root (where shadow.jsonl goes).
 */
export function afterSessionStart(data, { logDir } = {}, env = process.env) {
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
        const text = renderRegistry(sessionId, agent, env);
        if (text) out.context = text;
      }
    }
    if (appendRows(target, rows)) {
      for (const x of merged) { try { rmSync(join(spoolDir, x.name), { force: true }); } catch { /* moved twice at worst */ } }
    }
    if (data.source === 'startup') {
      sweep(spoolDir, now);
      sweep(join(stateDir, 'compaction-registry'), now);
    }
    return out;
  } catch { return {}; }
}
