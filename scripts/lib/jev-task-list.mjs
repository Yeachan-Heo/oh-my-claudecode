/* global process, console */
// Task lists of agents: storage, update semantics and the PostToolUse entry point.
// Opt-in: the state hooks do nothing unless OMC_TASK_LIST=1 (see scripts/jev-task-list-state.mjs).
// The list of every agent is what the agent itself sent to a list tool (source of truth: the tool_input of a call that ran, as the
// PostToolUse hook gets it); nothing here judges the work.
//   <logdir>/lists/<session_id>/<agent_id|main>.json   the list of one agent (main = the main thread, no agent_id in the hook input)
//   <logdir>/lists/<session_id>/<key>.events/*.json    list calls not yet folded into <key>.json (event journal, see syncList)
//   <lists>/<session_id>/_task/<id>.json               which agent created a Task* task (the Task* store is one per session, without owner)
// <logdir> is OMC_TASK_LIST_LOG_DIR or ~/.omc/state/task-list. Every function is fail-open: it returns null/false and never throws.

import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { appendFileSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { atomicWriteFileSync } from './atomic-write.mjs';
import { rotateJevLog } from '../jev-resolve.mjs';

export const LIST_TOOL_RE = /^mcp__(?:plugin_oh-my-claudecode_)?t__task_list$/; // also the bare server name without the plugin prefix
export const MAIN = 'main';
export const LIST_RECORD_VERSION = 1;
export const ITEMS_MAX = 50;
export const CONTENT_MAX = 500;
export const NOTE_MAX = 600;
export const LISTS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export const LOG_MAX_BYTES = 50 * 1024 * 1024; // size at which task-list.jsonl and batches.jsonl are rotated
const SWEEP_EVERY_MS = 3600 * 1000;
const STATUSES = new Set(['pending', 'in_progress', 'completed']);
const SESSION_ID = /^(?!\.)[A-Za-z0-9._-]{1,200}$/; // a safe session id, never "." or ".." or a name starting with a dot
const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,40}$/;
// Own lock file (open 'wx' with a random token). The hook runner gives a 3 s hook 2.5 s, so the wait ends after 1.5 s;
// a lock older than 3 s belongs to a dead holder (a hook holds it for milliseconds).
const LOCK_WAIT_MS = 1500;
const LOCK_STALE_MS = 3000;
// The fold of the event journal (syncList) treats its lock as stale only after 60 s: a fold descheduled for seconds on a busy
// machine must not have its lock broken and then overwrite a newer fold; a held lock only delays folding.
const SYNC_STALE_MS = 60_000;
const LOCK_STEP_MS = 20;

// Tools whose call changes the list of the calling agent (the PostToolUse matcher shown in docs/HOOKS.md names exactly these).
// update_plan and wrap_up count only in the main thread: the host rejects them in subagents before they run.
export const LIST_TOOL_NAMES = ['mcp__plugin_oh-my-claudecode_t__task_list', 'mcp__t__task_list', 'TaskCreate', 'TaskUpdate', 'TodoWrite', 'mcp__ccd_turn__update_plan', 'mcp__ccd_turn__wrap_up'];
export function isListTool(name, key = MAIN) {
  if (typeof name !== 'string' || !LIST_TOOL_NAMES.includes(name)) return false;
  return key === MAIN || !name.startsWith('mcp__ccd_turn__');
}

// The log directory: OMC_TASK_LIST_LOG_DIR overrides the default under the user's state directory.
export const taskListLogDir = (env = process.env) => env.OMC_TASK_LIST_LOG_DIR || join(homedir(), '.omc', 'state', 'task-list');
export const listsDir = (env = process.env) => join(taskListLogDir(env), 'lists');
// The file key of an agent: main only when the hook input has no agent_id; an agent_id outside the safe pattern keeps its own key
// (unsafe characters as "_" plus a short sha256 of the original), so it never writes the main thread's list.
export function agentKey(data) {
  const raw = data?.agent_id;
  if (raw === undefined || raw === null || raw === '') return MAIN;
  const id = String(raw);
  if (AGENT_ID.test(id) && id !== MAIN) return id;
  return `${id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}-${createHash('sha256').update(id).digest('hex').slice(0, 10)}`;
}
const sessionDir = (sessionId, env) => (typeof sessionId === 'string' && SESSION_ID.test(sessionId) ? join(listsDir(env), sessionId) : null);
export function listPath(sessionId, key, env = process.env) {
  const dir = sessionDir(sessionId, env);
  return dir && (key === MAIN || AGENT_ID.test(key)) ? join(dir, `${key}.json`) : null;
}

// { record, broken }: record null and broken false when the file does not exist; broken true when it exists but cannot be read.
function readRecord(path) {
  try {
    if (!path || !existsSync(path)) return { record: null, broken: false };
    const link = lstatSync(path);
    if (link.isSymbolicLink() || !link.isFile() || link.size > 1024 * 1024) return { record: null, broken: true };
    const record = JSON.parse(readFileSync(path, 'utf8'));
    return record && typeof record === 'object' && !Array.isArray(record) ? { record, broken: false } : { record: null, broken: true };
  } catch {
    return { record: null, broken: true };
  }
}

// Appends one JSON row to a file of the log directory; a file above LOG_MAX_BYTES is rotated first. Never throws.
function appendLog(name, row, env = process.env) {
  try {
    const dir = taskListLogDir(env);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    rotateJevLog(path, LOG_MAX_BYTES);
    appendFileSync(path, JSON.stringify(row) + '\n', 'utf8');
  } catch { /* logging never breaks the hook */ }
}

// A failed lock or write leaves a row in task-list.jsonl; the row never breaks the hook.
function storeEvent(event, path, env) {
  appendLog('task-list.jsonl', { ts: new Date().toISOString(), event, file: basename(String(path)) }, env);
}

const readToken = (lockPath) => { try { return readFileSync(lockPath, 'utf8'); } catch { return null; } };

// A lock older than staleMs is moved aside under a unique name (only one process wins the rename); when the moved file is not the
// one that was seen as old (a new holder took the lock in between), it is linked back (link never overwrites) and the holder keeps it.
function breakStaleLock(lockPath, staleMs = LOCK_STALE_MS) {
  let seen;
  try {
    if (Date.now() - statSync(lockPath).mtimeMs <= staleMs) return;
    seen = readFileSync(lockPath, 'utf8');
  } catch { return; }
  const aside = `${lockPath}.${randomBytes(6).toString('hex')}.stale`;
  try { renameSync(lockPath, aside); } catch { return; }
  if (readToken(aside) !== seen) { try { linkSync(aside, lockPath); } catch { /* a third process holds the lock now */ } }
  try { unlinkSync(aside); } catch { /* already gone */ }
}

// Runs fn under <path>.lock (the lock file holds a random token; only its owner removes it). false when the lock was not taken in time
// or fn threw; the call then changes nothing. fn gets owned(): true while the lock file still holds this token. staleMs: the age after
// which a lock counts as a dead holder's.
export function withFileLock(path, fn, env = process.env, staleMs = LOCK_STALE_MS) {
  const lockPath = `${path}.lock`;
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try { writeSync(fd, token); } finally { closeSync(fd); }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') { storeEvent('lock_error', path, env); return false; }
      breakStaleLock(lockPath, staleMs);
      if (Date.now() > deadline) { storeEvent('lock_timeout', path, env); return false; }
      Atomics.wait(sleeper, 0, 0, LOCK_STEP_MS);
    }
  }
  try {
    fn(() => readToken(lockPath) === token);
    return true;
  } catch {
    return false;
  } finally {
    if (readToken(lockPath) === token) { try { unlinkSync(lockPath); } catch { /* moved aside as stale */ } }
  }
}

function writeJson(path, value, env = process.env) {
  try {
    atomicWriteFileSync(path, JSON.stringify(value, null, 1));
    return true;
  } catch {
    storeEvent('write_failed', path, env);
    return false;
  }
}

// --- record shape -------------------------------------------------------------------------

// Narrow masking for the task texts: the full secret masking of the shell checks also hides long words and plain "name: value"
// pairs, which destroys task names ("Passed: 26 tests"). Here: private key blocks (PEM, PGP, SSH2), known key prefixes, a Bearer token,
// and the value after "=" or ":" only when a segment of the name (split by _ . -) is KEY, TOKEN, SECRET, PASS (PASSWD, PASSWORD) or PWD.
const LIST_SECRET_RULES = [
  [/(-{4,5} ?BEGIN (?:[A-Z0-9]+[ -])*PRIVATE KEY(?: BLOCK)? ?-{4,5})[\s\S]*?(-{4,5} ?END (?:[A-Z0-9]+[ -])*PRIVATE KEY(?: BLOCK)? ?-{4,5}|$)/g, '$1***'],
  [/\b(sk-(?:ant-)?)[A-Za-z0-9_-]{8,}/g, '$1***'],
  [/\b(ghp_)[A-Za-z0-9]{8,}/g, '$1***'],
  [/\b(github_pat_)[A-Za-z0-9_]{8,}/g, '$1***'],
  [/\b(xox[a-z]-)[A-Za-z0-9-]{8,}/g, '$1***'],
  [/\b(AKIA)[0-9A-Z]{12,}/g, '$1***'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  [/(^|[^A-Za-z0-9])((?:[A-Za-z0-9]+[_.-])*(?:key|token|secret|pass|passwd|password|pwd)(?:[_.-][A-Za-z0-9]+)*)(\s*[=:]\s*)(["']?)[^\s"',;]+/gi, '$1$2$3$4***'],
];
export function maskListText(text) {
  let s = String(text ?? '');
  for (const [re, to] of LIST_SECRET_RULES) s = s.replace(re, to);
  return s;
}

const cut = (text, max) => {
  const s = maskListText(String(text ?? '').trim());
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// A model sometimes sends an array argument of an MCP tool as a JSON string.
function arrayOf(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : null; } catch { return null; }
  }
  return null;
}

const intOf = (value) => {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return Number.isInteger(n) && n >= 1 ? n : null;
};

// One item: { content, status, note?, id? } or null when the content is missing.
function itemOf(raw, noteField) {
  if (!raw || typeof raw !== 'object') return null;
  const content = cut(raw.content ?? raw.subject ?? '', CONTENT_MAX);
  if (!content) return null;
  const status = STATUSES.has(raw.status) ? raw.status : 'pending';
  const item = { content, status };
  const note = noteField ? raw[noteField] : undefined;
  if (typeof note === 'string' && note.trim()) item.note = cut(note, NOTE_MAX);
  return item;
}

// Is an update call well formed: items (a non-empty array of tasks) or at least one of advance, done, start. Used by the MCP tool too.
export function updateShape(input) {
  const items = input?.items === undefined ? undefined : arrayOf(input.items);
  if (input?.items !== undefined && (!items || items.length === 0 || items.length > ITEMS_MAX || items.some((x) => !itemOf(x, null) || !STATUSES.has(x.status)))) return { ok: false, why: 'items' };
  const done = input?.done === undefined ? undefined : arrayOf(input.done);
  if (input?.done !== undefined && (!done || done.some((n) => intOf(n) === null))) return { ok: false, why: 'done' };
  if (input?.start !== undefined && intOf(input.start) === null) return { ok: false, why: 'start' };
  if (input?.advance !== undefined && typeof input.advance !== 'boolean') return { ok: false, why: 'advance' };
  if (!items && !done && input?.start === undefined && input?.advance !== true) return { ok: false, why: 'empty' };
  return { ok: true, items, done: done?.map(intOf), start: input?.start === undefined ? undefined : intOf(input.start), advance: input?.advance === true };
}

// update_plan / task_list semantics (update_plan's own description): items replace the list; done marks 1-based numbers completed; start
// marks one in_progress and, as "Keep exactly one step in_progress" says, puts any other task in progress back to pending; advance
// completes the task in progress and starts the next pending one (the first pending after it, else the first pending).
// A note of a task sent again without a note is kept only when the content is the same and the task was and still is in progress.
// advance, done or start without an existing list change nothing (null), so an unreadable file never ends as an empty list.
export function applyUpdate(items, input, noteField) {
  const shape = updateShape(input);
  if (!shape.ok) return null;
  if (!shape.items && items.length === 0) return null;
  let list = items.map((x) => ({ ...x }));
  if (shape.items) {
    const old = new Map(list.map((x) => [x.content, x]));
    list = shape.items.map((raw) => itemOf(raw, noteField)).filter(Boolean).map((x) => {
      const before = old.get(x.content);
      return before?.note && !x.note && before.status === 'in_progress' && x.status === 'in_progress' ? { ...x, note: before.note } : x;
    });
  }
  for (const n of shape.done ?? []) if (list[n - 1]) list[n - 1].status = 'completed';
  if (shape.start && list[shape.start - 1]) {
    list.forEach((x, i) => { if (i !== shape.start - 1 && x.status === 'in_progress') x.status = 'pending'; });
    list[shape.start - 1].status = 'in_progress';
  }
  if (shape.advance) {
    const current = list.findIndex((x) => x.status === 'in_progress');
    if (current >= 0) list[current].status = 'completed';
    let next = list.findIndex((x, i) => i > current && x.status === 'pending');
    if (next < 0) next = list.findIndex((x) => x.status === 'pending');
    if (next >= 0) list[next].status = 'in_progress';
  }
  return list;
}

// The id of a task from the TaskCreate result: an object with an id (task.id, taskId, id) or the text "Task #<id> created successfully".
export function taskIdOf(response) {
  const fromObject = (o) => {
    if (!o || typeof o !== 'object') return null;
    for (const v of [o.task?.id, o.taskId, o.task_id, o.id]) if ((typeof v === 'string' || typeof v === 'number') && TASK_ID.test(String(v))) return String(v);
    return null;
  };
  const direct = fromObject(response);
  if (direct) return direct;
  let text = '';
  try { text = typeof response === 'string' ? response : JSON.stringify(response ?? ''); } catch { text = ''; }
  const m = /Task #([A-Za-z0-9_-]{1,40}) created/.exec(text);
  return m ? m[1] : null;
}

// --- ownership of Task* tasks -------------------------------------------------------------

function claimTask(sessionId, taskId, key, env) {
  const dir = sessionDir(sessionId, env);
  if (!dir || !TASK_ID.test(taskId)) return false;
  try {
    mkdirSync(join(dir, '_task'), { recursive: true });
    const fd = openSync(join(dir, '_task', `${taskId}.json`), 'wx', 0o600); // the first creator wins; the store numbers tasks once per session
    try { writeSync(fd, JSON.stringify({ agent: key })); } finally { closeSync(fd); }
    return true;
  } catch {
    return false;
  }
}

// --- the PostToolUse entry point ----------------------------------------------------------

// New list of one agent after a list-tool call, or null when the call does not change it. `record` is the current file (or null);
// `broken` (the file exists but cannot be read): only a call that replaces the whole list (items, TodoWrite) is saved.
export function nextList(record, data, env = process.env, broken = false) {
  const tool = data?.tool_name;
  const input = data?.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const items = Array.isArray(record?.items) ? record.items : [];
  const replaces = (LIST_TOOL_RE.test(tool) || tool === 'mcp__ccd_turn__update_plan') ? input.items !== undefined : tool === 'TodoWrite';
  if (broken && !replaces) return null;
  if (LIST_TOOL_RE.test(tool)) return applyUpdate(items, input, 'note');
  if (tool === 'mcp__ccd_turn__update_plan') return applyUpdate(items, input, null);
  if (tool === 'mcp__ccd_turn__wrap_up') return items.length ? items.map((x) => ({ ...x, status: 'completed' })) : null; // wrap_up checks off the task list (its description)
  if (tool === 'TodoWrite') {
    const todos = arrayOf(input.todos);
    return todos ? todos.map((raw) => itemOf(raw, null)).filter(Boolean) : null;
  }
  if (tool === 'TaskCreate') {
    // a journal event carries the task id claimed when it was written (the claim is not repeated when the journal is folded again)
    const claimed = typeof data.task_id === 'string';
    const id = claimed ? data.task_id : taskIdOf(data.tool_response);
    const item = itemOf({ content: input.subject, status: 'pending', note: input.description }, 'note');
    if (!id || !item || (!claimed && !claimTask(data.session_id, id, agentKey(data), env))) return null;
    return [...items.filter((x) => x.id !== id), { id, ...item }];
  }
  if (tool === 'TaskUpdate') {
    const id = input.taskId === undefined ? '' : String(input.taskId);
    const at = items.findIndex((x) => x.id === id);
    if (at < 0) return null; // a task of another agent (the store is shared) never moves to this agent's list
    const list = items.map((x) => ({ ...x }));
    if (input.status === 'deleted') return list.filter((_, i) => i !== at);
    if (STATUSES.has(input.status)) list[at].status = input.status;
    if (typeof input.subject === 'string' && input.subject.trim()) list[at].content = cut(input.subject, CONTENT_MAX);
    if (typeof input.description === 'string' && input.description.trim()) list[at].note = cut(input.description, NOTE_MAX);
    return list;
  }
  return null;
}

function sweep(env, now) {
  try {
    const root = listsDir(env);
    const marker = join(root, '.sweep');
    if (existsSync(marker) && now - statSync(marker).mtimeMs < SWEEP_EVERY_MS) return;
    mkdirSync(root, { recursive: true });
    writeJson(marker, { ts: new Date(now).toISOString() });
    for (const name of readdirSync(root)) {
      if (name.startsWith('.')) continue;
      const dir = join(root, name);
      try { if (now - statSync(dir).mtimeMs > LISTS_MAX_AGE_MS) rmSync(dir, { recursive: true, force: true }); } catch { /* next */ }
    }
  } catch { /* cleanup never breaks the hook */ }
}

// --- event journal ------------------------------------------------------------------------
// Every list call is one file <key>.events/<ms>-<pid>-<id>.json, written without a lock (temp file, then rename), so a lock that is not
// taken in time loses nothing. The list <key>.json is the fold of the events in name order (time of the call), written under the lock
// together with the names it folded (`folded`, the newest EVENTS_KEPT); the folded files are then removed. A reader folds the list plus
// the events not yet folded. One file per event instead of one appended journal: trimming an appended file while other processes append
// to it loses lines.
export const EVENTS_KEPT = 500;
const EVENTS_READ_MAX = 5000;
const EVENT_NAME = /^\d{13}-\d{1,10}-[0-9a-f]{8}\.json$/;
export const eventsDir = (path) => (path ? path.replace(/\.json$/, '.events') : null);

// Strings of a tool input masked before the event goes to disk (arrays sent as JSON text parsed first, so masking cannot break them).
function maskedInput(value, depth = 0) {
  if (typeof value === 'string') return maskListText(value);
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, ITEMS_MAX * 2).map((x) => maskedInput(x, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskedInput((k === 'items' || k === 'todos') ? (arrayOf(v) ?? v) : v, depth + 1)]));
}

// Writes the event of one list call; the TaskCreate claim happens here once, the event keeps the claimed id. false when nothing was written.
function writeEvent(dir, data, key, env, now) {
  let taskId;
  if (data.tool_name === 'TaskCreate') {
    taskId = taskIdOf(data.tool_response);
    if (!taskId || !claimTask(data.session_id, taskId, key, env)) return false;
  }
  const id = randomBytes(4).toString('hex');
  const event = {
    ts: new Date(now).toISOString(), pid: process.pid, id, session_id: data.session_id, tool_name: data.tool_name,
    tool_input: maskedInput(data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {}),
    agent_type: typeof data.agent_type === 'string' ? data.agent_type : null,
    tool_use_id: typeof data.tool_use_id === 'string' ? data.tool_use_id : null,
    prompt_id: typeof data.prompt_id === 'string' ? data.prompt_id : null,
    ...(taskId ? { task_id: taskId } : {}),
  };
  const name = `${String(now).padStart(13, '0')}-${process.pid}-${id}.json`;
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${name}.tmp`);
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify(event)); } finally { closeSync(fd); }
    renameSync(tmp, join(dir, name));
    return true;
  } catch {
    storeEvent('event_write_failed', join(dir, name), env);
    return false;
  }
}

// The events not yet folded into `record`, oldest first: [{ name, event }]. A file that cannot be read is skipped (it is retried later).
function pendingEvents(dir, record) {
  let names;
  try { names = readdirSync(dir).filter((n) => EVENT_NAME.test(n)).sort(); } catch { return []; }
  const folded = new Set(Array.isArray(record?.folded) ? record.folded : []);
  const out = [];
  for (const name of names.slice(0, EVENTS_READ_MAX)) {
    if (folded.has(name)) continue;
    const { record: event } = readRecord(join(dir, name));
    if (event) out.push({ name, event });
  }
  return out;
}

// The record after one event, or the same record when the event changes nothing (null stays null).
function applyEvent(record, event, key, env, broken) {
  const changed = nextList(record, event, env, broken);
  if (!changed) return record;
  // a completed task has no note; above ITEMS_MAX the newest tasks stay, the record counts the dropped ones
  const all = changed.map((x) => (x.status === 'completed' && x.note !== undefined ? (({ note, ...rest }) => rest)(x) : x));
  const items = all.slice(-ITEMS_MAX);
  return {
    v: LIST_RECORD_VERSION,
    session_id: event.session_id,
    agent: key,
    agent_type: event.agent_type ?? null,
    tool: event.tool_name,
    tool_use_id: event.tool_use_id ?? null,
    prompt_id: event.prompt_id ?? null,
    updated: event.ts,
    updates: (Number.isInteger(record?.updates) ? record.updates : 0) + 1,
    items,
    ...(all.length > items.length ? { dropped: all.length - items.length } : {}),
  };
}

// Folds the pending events into the list file. { record, broken, names, changed }: names are the events folded (all pending ones).
function fold(path, key, env) {
  const dir = eventsDir(path);
  const events = pendingEvents(dir, null); // listed before the snapshot is read: a fold in between has its names in folded
  const start = readRecord(path);
  const done = new Set(Array.isArray(start.record?.folded) ? start.record.folded : []);
  let record = start.record;
  let broken = start.broken;
  let changed = false;
  const names = [];
  for (const { name, event } of events) {
    if (done.has(name)) continue;
    const next = applyEvent(broken ? null : record, event, key, env, broken);
    if (next !== record && next) { record = next; broken = false; changed = true; }
    names.push(name);
  }
  return { record, broken, names, changed, done };
}

// Under the lock: fold, write the list with the folded names, then remove the folded event files (retention: the folder holds only the
// events that no fold under the lock has taken yet). false when the lock was not taken; the events then stay for the next fold or reader.
export function syncList(sessionId, key, env = process.env) {
  const path = listPath(sessionId, key, env);
  if (!path) return false;
  let waiting = [];
  try { waiting = readdirSync(eventsDir(path)).filter((n) => EVENT_NAME.test(n)); } catch { /* no events folder */ }
  if (!waiting.length) return readRecord(path).record; // nothing to fold: no lock (most batches)
  let saved = null;
  const remove = (names) => { for (const name of names) { try { unlinkSync(join(eventsDir(path), name)); } catch { /* removed by an earlier fold */ } } };
  const ok = withFileLock(path, (owned) => {
    const f = fold(path, key, env);
    saved = f.record;
    if (!f.names.length) return;
    // events that change nothing (also on a broken list without a replacing call) leave the list file as it is
    if (!owned()) return; // the lock was taken over: the newer fold writes
    if (!f.changed) { remove(f.names); return; }
    const next = { ...f.record, folded: [...f.done, ...f.names].slice(-Math.max(EVENTS_KEPT, f.names.length)) };
    if (!owned() || !writeJson(path, next, env)) return;
    saved = next;
    remove(f.names);
  }, env, SYNC_STALE_MS);
  return ok ? saved : false;
}

// Saves the list change of one PostToolUse call: the event first (no lock), then a fold under the lock. Returns the folded record (also
// when the lock was not taken: then the fold of a reader) or null when the call is not a list call of this agent.
export function recordListCall(data, env = process.env, now = Date.now()) {
  try {
    const key = agentKey(data);
    if (!isListTool(data?.tool_name, key)) return null;
    const path = listPath(data.session_id, key, env);
    if (!path) return null;
    if (!writeEvent(eventsDir(path), data, key, env, now)) return null;
    const saved = syncList(data.session_id, key, env);
    sweep(env, now);
    return saved === false ? readList(data.session_id, key, env) : saved;
  } catch {
    return null;
  }
}

// The list of one agent as the fold of its file and the events not yet folded (no write). null without a list.
export function readList(sessionId, key, env = process.env) {
  try {
    const path = listPath(sessionId, key, env);
    if (!path) return null;
    return fold(path, key, env).record;
  } catch {
    return null;
  }
}

export const logRow = (name, row, env = process.env) => appendLog(name, { ts: new Date().toISOString(), ...row }, env);

// Kill switches of OMC hooks: DISABLE_OMC=1|true, or OMC_SKIP_HOOKS with the event token or "task-list".
export function skipped(eventToken, env = process.env) {
  const tokens = String(env.OMC_SKIP_HOOKS || '').split(',').map((s) => s.trim());
  return env.DISABLE_OMC === '1' || env.DISABLE_OMC === 'true' || tokens.includes(eventToken) || tokens.includes('task-list');
}

// Parses the hook input read from stdin; null when it is not a JSON object.
export function parseHookInput(raw) {
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}
