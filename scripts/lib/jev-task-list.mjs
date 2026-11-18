/* global process, console, Buffer */
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
import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { atomicWriteFileSync } from './atomic-write.mjs';
import { rotateJevLog } from '../jev-resolve.mjs';

export const LIST_TOOL_RE = /^mcp__(?:plugin_oh-my-claudecode_)?t__task_list$/; // also the bare server name without the plugin prefix
export const MAIN = 'main';
export const LIST_RECORD_VERSION = 1;
export const ITEMS_MAX = 50;
export const CONTENT_MAX = 500;
export const NOTE_MAX = 600;
export const LISTS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export const RECORD_MAX_BYTES = 1024 * 1024; // the largest list or event file the reader accepts; the writers stay below it
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
    if (link.isSymbolicLink() || !link.isFile() || link.size > RECORD_MAX_BYTES) return { record: null, broken: true };
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

// A file by what survives a replacement: device, inode, modification time (ns) and size. A recycled inode alone proves nothing.
const statExact = (path) => { try { return lstatSync(path, { bigint: true }); } catch { return null; } };
const sameFile = (a, b) => a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.size === b.size && (process.platform === 'win32' || a.dev === b.dev);

// Removes the lock file only when isTarget(movedPath) confirms that the file moved is the one meant. The lock is moved to a unique name
// first (a rename has one winner, so one process judges and removes it); the moved file is judged, never the path, which another process
// may have taken since it was read. A lock that is another holder's is linked back (link never overwrites) and its holder keeps it.
function removeLockIf(lockPath, isTarget) {
  const aside = `${lockPath}.${randomBytes(6).toString('hex')}.moved`;
  try { renameSync(lockPath, aside); } catch { return; }
  let meant = false;
  try { meant = isTarget(aside); } catch { /* not judged to be the file meant */ }
  if (!meant) { try { linkSync(aside, lockPath); } catch { /* a third process holds the lock now */ } }
  try { unlinkSync(aside); } catch { /* already gone */ }
}

// A lock older than staleMs belongs to a dead holder. The age, the token and the identity of the file are read from one open handle,
// so none of them comes from a later file that took the path. Right before the rename the path must still name that file; after it, the
// moved file must be that file again (removeLockIf). A lock that a new holder took in between has another inode, modification time and
// token, and is put back. Mutual exclusion stays best effort for the instant between the move and the put back (a third contender can
// take the free path then); what the fold relies on is its own check before it publishes (see syncList).
function breakStaleLock(lockPath, staleMs = LOCK_STALE_MS) {
  let seen;
  let token;
  let fd;
  try {
    fd = openSync(lockPath, 'r');
    seen = fstatSync(fd, { bigint: true });
    if (!seen.isFile() || Date.now() - Number(seen.mtimeMs) <= staleMs) return;
    token = readFileSync(fd, 'utf8');
  } catch {
    return; // gone or unreadable: nothing to break
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
  }
  const named = statExact(lockPath);
  if (!named || !sameFile(named, seen)) return;
  removeLockIf(lockPath, (moved) => {
    const now = statExact(moved);
    return Boolean(now) && sameFile(now, seen) && readToken(moved) === token;
  });
}

// Writes all of `text` to the open file. writeSync may store fewer bytes than it was given without an error (a disk that is filling up, an
// interrupted call), and a file closed after that is cut short: a lock token that is not its owner's, a claim that is not JSON, and an event
// that would be published truncated and skipped by every reader for good. The count it returns is checked and the rest is written.
function writeAll(fd, text) {
  const bytes = Buffer.from(text, 'utf8');
  for (let at = 0; at < bytes.length;) {
    const written = writeSync(fd, bytes, at, bytes.length - at);
    if (!(written > 0)) throw new Error('write stored no bytes');
    at += written;
  }
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
      try { writeAll(fd, token); } finally { closeSync(fd); }
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
    // a lock taken over as stale is another holder's now: it is not touched. The move below checks the file again, so a lock that
    // changes hands between this read and the move is put back.
    if (readToken(lockPath) === token) removeLockIf(lockPath, (moved) => readToken(moved) === token);
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

// Publishes the list of a fold (path-based writes cannot be bound to a directory, so the order of the steps does it). The temporary file is
// written first, then stillCurrent() is asked (the lock is still this fold's and the list is the one it folded from), and only then is the
// file renamed over the list. The retention sweep may move the session directory away after the check of a fold, and another hook may make
// the directory again, fold a newer call and remove its event: a write that checked before it began would then put the older list over the
// newer one, for good. Here a directory that changed hands after the check has no such temporary file (it stays in the moved tree, which
// the merge of a put back does not take along: the name ends in .tmp), so the rename finds no source and fails; and one that changed hands
// before the temporary file was made fails the check, because the lock file this fold holds is in the moved tree. The directory is never
// made here: a fold whose directory is gone publishes nothing, and its events are folded by the next fold. false when nothing was
// published; a refusal by stillCurrent() is silent (the newer fold writes), a failed write is a row.
function publishJson(path, value, stillCurrent, env = process.env) {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  let fd;
  let published = false;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeAll(fd, JSON.stringify(value, null, 1));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (stillCurrent()) {
      renameSync(temp, path);
      published = true;
      try { const dirFd = openSync(dirname(path), 'r'); try { fsyncSync(dirFd); } finally { closeSync(dirFd); } } catch { /* a platform without directory fsync */ }
    }
  } catch {
    storeEvent('write_failed', path, env);
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
    if (!published) { try { unlinkSync(temp); } catch { /* never made, or moved away with its directory */ } }
  }
  return published;
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
];
// "name = value" pairs. The head is matched only where a name starts (the character before is not a name character), so the work
// per text is linear: a rule that may start inside a name and read on to its end costs the square of the length of "a-a-a-...".
// The name is a whole run of name characters, optionally quoted (a JSON field); a segment test decides whether it hides its value.
const ASSIGNMENT_HEAD = /(?<![A-Za-z0-9_.-])(["']?)([A-Za-z0-9_.-]+)(["']?)(\s*[=:]\s*)/g;
// The value: a quoted string through its closing quote (spaces, commas and semicolons included); a quote that is never closed takes the
// rest of its line; else a run up to whitespace, a quote, a comma or a semicolon. An empty quoted value is not a value. Sticky: it is
// read at the end of the head, never searched for.
const ASSIGNMENT_VALUE = /"(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+'|"(?!")[^\n]+|'(?!')[^\n]+|[^\s"',;]+/y;
const SECRET_SEGMENT = /^(?:key|token|secret|pass|passwd|password|pwd)$/i;
function maskAssignments(text) {
  let out = '';
  let from = 0;
  ASSIGNMENT_HEAD.lastIndex = 0;
  for (let head = ASSIGNMENT_HEAD.exec(text); head; head = ASSIGNMENT_HEAD.exec(text)) {
    const valueAt = head.index + head[0].length;
    // a name that hides nothing (or ends in a separator, which no name does): the scan goes on inside its value, which may hold a
    // name that does ("status:password=x")
    if (/[_.-]$/.test(head[2]) || !head[2].split(/[_.-]+/).some((segment) => SECRET_SEGMENT.test(segment))) continue;
    ASSIGNMENT_VALUE.lastIndex = valueAt;
    const value = ASSIGNMENT_VALUE.exec(text);
    if (!value) continue;
    const quote = value[0][0] === '"' || value[0][0] === "'" ? value[0][0] : '';
    const closed = quote && value[0].length > 1 && value[0].endsWith(quote);
    out += `${text.slice(from, valueAt)}${quote}***${closed ? quote : ''}`;
    from = valueAt + value[0].length;
    ASSIGNMENT_HEAD.lastIndex = from;
  }
  return out + text.slice(from);
}
export function maskListText(text) {
  let s = String(text ?? '');
  for (const [re, to] of LIST_SECRET_RULES) s = s.replace(re, to);
  return maskAssignments(s);
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

// Is an update call well formed: items (a non-empty array of tasks) or at least one of advance, done, start. With a noteField (the
// task_list tool) an item is held to the schema of the tool, as its handler checks it: content a string, note absent or a string; so the
// hook never saves a call as something other than it was sent (a note of another type dropped, a number turned into text).
export function updateShape(input, noteField = null) {
  const items = input?.items === undefined ? undefined : arrayOf(input.items);
  const typed = (x) => !noteField || (typeof x.content === 'string' && (x[noteField] === undefined || typeof x[noteField] === 'string'));
  if (input?.items !== undefined && (!items || items.length === 0 || items.length > ITEMS_MAX || items.some((x) => !itemOf(x, null) || !STATUSES.has(x.status) || !typed(x)))) return { ok: false, why: 'items' };
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
// advance, done or start without an existing list change nothing (null), so an unreadable file never ends as an empty list. `skip` (a set of task
// ids, from the fold of a held-up call) leaves the tasks it names as they are when `done` completes tasks.
export function applyUpdate(items, input, noteField, skip = null) {
  const shape = updateShape(input, noteField);
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
  for (const n of shape.done ?? []) if (list[n - 1] && !skip?.has(list[n - 1].id)) list[n - 1].status = 'completed';
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

// The retention sweep may move a session directory away between the mkdir of a writer and its next file operation (it judged the
// directory idle before the writer wrote anything in it), and the writer then gets ENOENT. The writer repeats the whole step from its
// mkdir, which makes the directory anew; the sweep runs at most once an hour, so a few tries are enough. Any other error is thrown at once.
const DIR_TRIES = 3;
function inSessionDir(step) {
  for (let attempt = 1; ; attempt += 1) {
    try { return step(); } catch (error) { if (error?.code !== 'ENOENT' || attempt >= DIR_TRIES) throw error; }
  }
}

function claimTask(sessionId, taskId, key, env) {
  const dir = sessionDir(sessionId, env);
  if (!dir || !TASK_ID.test(taskId)) return false;
  try {
    inSessionDir(() => {
      mkdirSync(join(dir, '_task'), { recursive: true });
      const fd = openSync(join(dir, '_task', `${taskId}.json`), 'wx', 0o600); // the first creator wins; the store numbers tasks once per session
      try { writeAll(fd, JSON.stringify({ agent: key })); } finally { closeSync(fd); }
    });
    return true;
  } catch {
    return false;
  }
}

// --- the PostToolUse entry point ----------------------------------------------------------

// Does the call replace the whole list (items of the list tools, TodoWrite) instead of changing part of it.
const replacesList = (tool, input) => ((LIST_TOOL_RE.test(tool) || tool === 'mcp__ccd_turn__update_plan') ? input?.items !== undefined : tool === 'TodoWrite');

// New list of one agent after a list-tool call, or null when the call does not change it. `record` is the current file (or null);
// `broken` (the file exists but cannot be read): only a call that replaces the whole list (items, TodoWrite) is saved.
export function nextList(record, data, env = process.env, broken = false, skip = null) {
  const tool = data?.tool_name;
  const input = data?.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const items = Array.isArray(record?.items) ? record.items : [];
  if (broken && !replacesList(tool, input)) return null;
  if (LIST_TOOL_RE.test(tool)) return applyUpdate(items, input, 'note', skip);
  if (tool === 'mcp__ccd_turn__update_plan') return applyUpdate(items, input, null, skip);
  if (tool === 'mcp__ccd_turn__wrap_up') return items.length ? items.map((x) => ({ ...x, status: skip?.has(x.id) ? x.status : 'completed' })) : null; // wrap_up checks off the task list (its description)
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

// The newest modification time in a session directory: the directory, its entries and the entries of its folders (<key>.events, _task).
// An event is written into a folder, which does not change the modification time of the session directory itself, so the directory
// alone does not tell that a hook wrote there lately.
function lastActivityMs(dir) {
  let newest = lstatSync(dir).mtimeMs;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, lstatSync(path).mtimeMs);
    if (entry.isDirectory()) for (const inner of readdirSync(path)) newest = Math.max(newest, lstatSync(join(path, inner)).mtimeMs);
  }
  return newest;
}

// A session directory goes only when nothing in it was touched for LISTS_MAX_AGE_MS. The age read from the path is not enough: a hook may
// write there between that read and the removal. The directory is moved to a unique hidden name first (a hook that arrives later makes a
// new directory instead of writing into the one being removed) and the moved tree is judged. A tree with recent activity is put back
// (putBack); a hook may have made the directory again by then, and the tree is then merged into it.
const SWEEPING = '.sweeping';
const HIDDEN_NAME = /^\.(.+)\.[0-9a-f]{12}\.sweeping$/; // the hidden name of a moved tree: .<session id>.<12 hex digits>.sweeping

// Moves what `from` holds into `to` without overwriting anything `to` has: link never replaces a file, so a list file, an event or a task
// claim that the live tree has stays the live tree's (a list file in the moved tree is older than the fold that wrote the live one), and
// every other file arrives, the events of the moved tree first of all. A folder both trees have is merged the same way. Lock files and
// temporary files are not moved: a lock a dead holder left would only stall the next fold, and a temporary file is never read. true when
// every entry was moved or deliberately left, false when one could not be moved (the moved tree is kept then).
function mergeTree(from, to) {
  let complete = true;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    try {
      if (entry.isDirectory()) {
        mkdirSync(target, { recursive: true });
        if (!mergeTree(source, target)) complete = false;
      } else if (entry.isFile() && !/\.(?:lock|tmp)$/.test(entry.name)) {
        try { linkSync(source, target); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
        unlinkSync(source);
      }
    } catch { complete = false; }
  }
  return complete;
}

// A moved tree with recent activity goes back to its own name: one rename when the name is free. When a hook has made the directory
// again, the rename fails and the tree is merged into the new one, so an event published into the old tree stays visible to the readers of
// the live path. A tree that cannot be merged completely stays under its hidden name; the next sweep tries again (see sweep).
function putBack(aside, dir) {
  try { renameSync(aside, dir); return; } catch { /* the name is taken: merge */ }
  try { if (mergeTree(aside, dir)) rmSync(aside, { recursive: true, force: true }); } catch { /* kept under its hidden name */ }
}

function removeIfIdle(root, name, now) {
  const dir = join(root, name);
  const aside = join(root, `.${name}.${randomBytes(6).toString('hex')}${SWEEPING}`);
  try { renameSync(dir, aside); } catch { return; }
  let idle = false;
  try { idle = now - lastActivityMs(aside) > LISTS_MAX_AGE_MS; } catch { /* not judged idle */ }
  if (idle) { rmSync(aside, { recursive: true, force: true }); return; }
  putBack(aside, dir);
}

export function sweep(env, now) {
  try {
    const root = listsDir(env);
    const marker = join(root, '.sweep');
    if (existsSync(marker) && now - statSync(marker).mtimeMs < SWEEP_EVERY_MS) return;
    mkdirSync(root, { recursive: true });
    writeJson(marker, { ts: new Date(now).toISOString() });
    for (const name of readdirSync(root)) {
      try {
        if (name.startsWith('.') && name.endsWith(SWEEPING)) { // a tree that could not be moved back (never a session id: those do not start with a dot)
          const aside = join(root, name);
          if (now - lastActivityMs(aside) > LISTS_MAX_AGE_MS) rmSync(aside, { recursive: true, force: true }); // removed once idle
          else if (HIDDEN_NAME.test(name)) putBack(aside, join(root, name.replace(HIDDEN_NAME, '$1'))); // in use: back to its own name
        } else if (!name.startsWith('.') && now - statSync(join(root, name)).mtimeMs > LISTS_MAX_AGE_MS) {
          removeIfIdle(root, name, now);
        }
      } catch { /* next */ }
    }
  } catch { /* cleanup never breaks the hook */ }
}

// --- event journal ------------------------------------------------------------------------
// Every list call is one file <key>.events/<ms>-<tick>-<pid>-<id>.json, written without a lock (temp file, then rename), so a lock that is not
// taken in time loses nothing. The list <key>.json is the fold of the events in name order (time of the call), written under the lock
// together with the names it folded (`folded`, the newest EVENTS_KEPT); the folded files are then removed. A reader folds the list plus
// the events not yet folded. One file per event instead of one appended journal: trimming an appended file while other processes append
// to it loses lines.
export const EVENTS_KEPT = 500;
const EVENTS_READ_MAX = 5000;
// An event is named after the time of its call, but it becomes visible only when its hook has written it; a hook held up in between
// (descheduled, masking a large payload) publishes after a hook with a later call has folded. How much older than a folded event a
// held-up hook can be is bounded by the host, which stops a hook after 3 s; an event more than LATE_EVENT_MS older than the newest
// one folded comes from a clock that was set back, not from a held-up hook, and is applied as any other.
export const LATE_EVENT_MS = 10_000;
// <tick> is the monotonic clock of the host in nanoseconds (shared by the processes of the machine), so that two calls of one millisecond
// have a fixed order in their names; a name without it (an event of an earlier version) is still read.
const EVENT_NAME = /^\d{13}-(?:\d{20}-)?\d{1,10}-[0-9a-f]{8}\.json$/;
export const eventsDir = (path) => (path ? path.replace(/\.json$/, '.events') : null);

// What of a tool input goes to disk in an event: only the fields nextList reads (and of a task only content, subject, status and note),
// strings masked (arrays sent as JSON text parsed first, so masking cannot break them) and then cut to the longest text a list keeps
// (NOTE_MAX; the cut comes after the masking, so a secret is never cut in half). An event stays small and holds nothing unmasked.
const LIST_INPUT_KEYS = ['items', 'todos', 'done', 'start', 'advance', 'subject', 'description', 'taskId', 'status'];
const TASK_KEYS = ['content', 'subject', 'status', 'note'];
const KEEP_CHARS = Math.max(CONTENT_MAX, NOTE_MAX);
const idText = (value) => (typeof value === 'string' ? value.slice(0, 200) : null);
function boundedValue(value) {
  if (typeof value === 'string') {
    const masked = maskListText(value);
    return masked.length > KEEP_CHARS ? `${masked.slice(0, KEEP_CHARS - 1)}…` : masked;
  }
  if (Array.isArray(value)) return value.map(boundedValue);
  return value === null || typeof value !== 'object' ? value : null;
}
const boundedTask = (raw) => (raw && typeof raw === 'object' && !Array.isArray(raw)
  ? Object.fromEntries(TASK_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, boundedValue(raw[k])]))
  : boundedValue(raw));

// The input of a list call as its event keeps it, small enough for the reader (RECORD_MAX_BYTES). The call changes the list as it did
// before: more than ITEMS_MAX items make task_list and update_plan refuse the call, so the first ITEMS_MAX + 1 are enough to refuse it
// again. A TodoWrite call replaces the list and the list keeps its newest ITEMS_MAX tasks (applyEvent): the event keeps those, in the form
// the list stores them, and `todos_total`, the number of tasks the call held. The retention is applied after the whole call is normalized.
function persistedInput(tool, input) {
  const source = input && typeof input === 'object' ? input : {};
  const kept = {};
  for (const k of LIST_INPUT_KEYS) {
    if (source[k] === undefined) continue;
    const list = k === 'items' || k === 'todos' ? arrayOf(source[k]) : null;
    kept[k] = list ? list.map(boundedTask) : boundedValue(source[k]);
  }
  if (Array.isArray(kept.items)) kept.items = kept.items.slice(0, ITEMS_MAX + 1);
  if (tool === 'TodoWrite' && Array.isArray(kept.todos)) {
    const tasks = kept.todos.map((raw) => itemOf(raw, null)).filter(Boolean);
    if (tasks.length > ITEMS_MAX) return { ...kept, todos: tasks.slice(-ITEMS_MAX), todos_total: tasks.length };
  }
  return kept;
}

// Writes the event of one list call; the TaskCreate claim happens here once, the event keeps the claimed id. false when nothing was written.
function writeEvent(dir, data, key, env, now) {
  const tick = process.hrtime.bigint().toString().padStart(20, '0'); // taken at the start of the call, before anything that can hold the hook up
  let taskId;
  if (data.tool_name === 'TaskCreate') {
    taskId = taskIdOf(data.tool_response);
    if (!taskId || !claimTask(data.session_id, taskId, key, env)) return false;
  }
  const id = randomBytes(4).toString('hex');
  const event = {
    ts: new Date(now).toISOString(), pid: process.pid, id, session_id: data.session_id, tool_name: data.tool_name,
    tool_input: persistedInput(data.tool_name, data.tool_input),
    agent_type: idText(data.agent_type),
    tool_use_id: idText(data.tool_use_id),
    prompt_id: idText(data.prompt_id),
    ...(taskId ? { task_id: taskId } : {}),
  };
  const name = `${String(now).padStart(13, '0')}-${tick}-${process.pid}-${id}.json`;
  try {
    const body = JSON.stringify(event);
    // an event the reader would refuse is never written: it would stay on disk, unread, for good
    if (Buffer.byteLength(body) > RECORD_MAX_BYTES) { storeEvent('event_too_large', join(dir, name), env); return false; }
    // the name (the time and the tick of the call) stays the same across the tries: the order of the calls is the order of the names
    inSessionDir(() => {
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `${name}.tmp`);
      try {
        const fd = openSync(tmp, 'wx', 0o600);
        try { writeAll(fd, body); } finally { closeSync(fd); }
        renameSync(tmp, join(dir, name));
      } catch (error) {
        try { unlinkSync(tmp); } catch { /* never created, or moved away with its directory */ }
        throw error;
      }
    });
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
function applyEvent(record, event, key, env, broken, skip = null) {
  const changed = nextList(record, event, env, broken, skip);
  if (!changed) return record;
  // a completed task has no note; above ITEMS_MAX the newest tasks stay, the record counts the dropped ones
  const all = changed.map((x) => (x.status === 'completed' && x.note !== undefined ? (({ note, ...rest }) => rest)(x) : x));
  const items = all.slice(-ITEMS_MAX);
  // a TodoWrite event keeps only the newest ITEMS_MAX tasks of the call and the number it held (persistedInput)
  const sent = event.tool_name === 'TodoWrite' && Number.isInteger(event.tool_input?.todos_total) ? Math.max(all.length, event.tool_input.todos_total) : all.length;
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
    ...(sent > items.length ? { dropped: sent - items.length } : {}),
  };
}

// The generation of the list file as a fold read it: the number of updates it holds (every fold that publishes raises it), or that it
// is unreadable or missing. A fold publishes only while the file still has the generation it folded from.
const generationOf = ({ record, broken }) => (broken ? 'broken' : record ? String(record.updates ?? 0) : 'none');

// The time of the call an event name starts with (13 digits of milliseconds).
const eventMs = (name) => Number(name.slice(0, 13));
// Is the call named `other` later than the call named `name`, by no more than a held-up hook can be behind (LATE_EVENT_MS)?
const laterWithin = (name, other) => {
  const gap = eventMs(other) - eventMs(name);
  return gap > 0 ? gap <= LATE_EVENT_MS : gap === 0 && name < other;
};

// What a call that changes part of the list acts on: one task (the id of a TaskUpdate, a deletion too), the whole list (EDIT_ALL: start and
// advance move tasks by position and state), tasks that it only marks completed (EDIT_COMPLETING: done, wrap_up), or nothing yet (null: a
// TaskCreate adds a task). A completing call acts on the tasks it names: the ones at the numbers of `done` or, for wrap_up, every task of
// the list it meets (completionTargets). `touched` keeps, for such a call, the marker EDIT_COMPLETING and one key `+<id>` for each task it
// completed (an id never starts with "+"); a TaskUpdate keeps its task id and start or advance EDIT_ALL. Two completing calls give the same
// list in either order, a completing call and a call on another task do too; every other two calls on one task or on the list do not.
const EDIT_ALL = '*';
const EDIT_COMPLETING = '+';
function editScope(event) {
  if (event.tool_name === 'TaskCreate') return null;
  if (event.tool_name === 'TaskUpdate') return event.tool_input?.taskId === undefined ? '' : String(event.tool_input.taskId);
  if (event.tool_name === 'mcp__ccd_turn__wrap_up') return EDIT_COMPLETING;
  return event.tool_input?.start !== undefined || event.tool_input?.advance === true ? EDIT_ALL : EDIT_COMPLETING;
}
// The tasks of `list` that a completing call marks completed (the ones at the numbers of `done`, or all for wrap_up).
function completionTargets(event, list) {
  if (event.tool_name === 'mcp__ccd_turn__wrap_up') return list;
  return (arrayOf(event.tool_input?.done) ?? []).map((n) => list[(intOf(n) ?? 0) - 1]).filter(Boolean);
}
// What the fold records in `touched` for an applied call that edits tasks, read from the list as it was before the call. A task without an id
// is not named: no call but a position call reaches it.
const touchedKeys = (event, items) => {
  const scope = editScope(event);
  if (scope !== EDIT_COMPLETING) return [scope];
  const named = completionTargets(event, Array.isArray(items) ? items : []).map((x) => x.id).filter((id) => typeof id === 'string');
  return [scope, ...named.map((id) => `${EDIT_COMPLETING}${id}`)];
};
// How the calls folded after a held-up call that edits tasks meet it. true: the call is overtaken, applying it would put an older state over
// a later one (a later call on its task, a later start or advance, for a TaskUpdate also a later completing call that named its task; for a
// completing call a later deletion, whichever task it removed, as the numbers of `done` may move, and every task it names having been edited
// by a later call). A Set: a completing call that names some tasks a later call edited; it is applied to the other tasks, as an in-order fold
// gives, and these ids are left as they are. false: nothing is in the way. A deletion is never overtaken (it gives the same list after a later
// call on its task, which then finds nothing), and a call that only adds a task is not either. `items` is the list the fold holds when the
// held-up call comes.
const fence = (touched, name, event, items) => {
  const scope = editScope(event);
  if (scope === null || (event.tool_name === 'TaskUpdate' && event.tool_input?.status === 'deleted')) return false;
  const list = Array.isArray(items) ? items : [];
  const ids = new Set(list.map((x) => x?.id));
  const targets = scope === EDIT_COMPLETING ? completionTargets(event, list) : [];
  const skip = new Set();
  for (const [key, at] of Object.entries(touched)) {
    if (!laterWithin(name, at)) continue;
    if (scope === EDIT_ALL || key === EDIT_ALL) return true;
    if (scope !== EDIT_COMPLETING) {
      if (key === scope || key === `${EDIT_COMPLETING}${scope}`) return true;
    } else if (!key.startsWith(EDIT_COMPLETING)) {
      if (!ids.has(key)) return true; // a task a later call edited is not on the list now: it was deleted
      if (targets.some((x) => x.id === key)) skip.add(key);
    }
  }
  if (!skip.size) return false;
  return targets.every((x) => skip.has(x.id)) ? true : skip;
};
// `touched` of the list file as the fold reads it: key (see editScope and touchedKeys) -> name of the newest call folded that edited it. The file
// is not trusted.
const touchedOf = (record) => {
  const stored = record?.touched;
  const touched = Object.create(null);
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) for (const [scope, at] of Object.entries(stored)) if (typeof at === 'string' && EVENT_NAME.test(at)) touched[scope] = at;
  return touched;
};

// Do the two lists hold the same tasks? (next is a list record, record the one it was made from, or null.)
const sameItems = (next, record) => next.items.length === (record?.items?.length ?? 0) && JSON.stringify(next.items) === JSON.stringify(record?.items ?? []);

// Folds the pending events into the list file. { record, broken, names, changed, done, generation, late }: names are the events folded
// (all pending ones, late ones included, except the ones that wait for an older call, see below), generation is the one of the file the fold
// started from, late counts the events not applied.
// A call that edits tasks (TaskUpdate, done, start, advance, wrap_up) and changes nothing may only be waiting for an older call that is not
// visible yet: the TaskCreate that makes its task, or the call that replaces the list it acts on. It is not acknowledged: it stays pending,
// in the order of its name, and the next fold that sees the older call applies both. It goes once no held-up call can precede it, that is
// when it is more than LATE_EVENT_MS behind the clock and behind the newest call seen. Acknowledging it at once would also move the time of the
// newest call folded forward, and the older call would then be dropped as late.
// The order of the events is the order of their calls, and a fold applies the pending ones in that order; but an event that becomes
// visible after a fold took a later one is older than the list it would change, and applying it would put the older state back. The
// record keeps the time of the newest call folded (lastEvent), of the newest call that replaced the whole list (lastReplace) and, in
// `touched`, the newest call that edited each task or the whole list. A late event is not applied (it is acknowledged and removed, so it
// never comes back) when it replaces the list and any later call has been folded; when it changes part of the list and a later call
// replaced the list (it changed a list that no longer exists); or when it edits tasks (TaskUpdate, done, start, advance, wrap_up) and a later
// call that edited the same task, or the whole list, was folded (see editScope: a completing call edits the tasks it names, not every task).
// A deletion, a TaskCreate, and calls on other tasks are applied after later calls of their kind: they do not undo each other, and the tasks
// of calls sent together all stay (a TaskCreate that is
// dropped for the later replacement leaves its claim in _task, which is harmless: TaskUpdate of an id the list does not hold changes
// nothing). A TaskCreate held up behind a wrap_up is applied and stays pending: the wrap_up folded before it did not see the task.
function fold(path, key, env) {
  const dir = eventsDir(path);
  const events = pendingEvents(dir, null); // listed before the snapshot is read: a fold in between has its names in folded
  const start = readRecord(path);
  const done = new Set(Array.isArray(start.record?.folded) ? start.record.folded : []);
  let record = start.record;
  let broken = start.broken;
  let changed = false;
  let lastEvent = Number.isFinite(start.record?.last_event_ms) ? start.record.last_event_ms : 0;
  let lastReplace = Number.isFinite(start.record?.last_replace_ms) ? start.record.last_replace_ms : 0;
  let lastEventName = typeof start.record?.last_event_name === 'string' ? start.record.last_event_name : '';
  let lastReplaceName = typeof start.record?.last_replace_name === 'string' ? start.record.last_replace_name : '';
  const touched = touchedOf(start.record);
  const horizon = Math.max(Date.now(), lastEvent, events.length ? eventMs(events[events.length - 1].name) : 0);
  let late = 0;
  const names = [];
  for (const { name, event } of events) {
    if (done.has(name)) continue;
    const ms = eventMs(name);
    const replaces = replacesList(event.tool_name, event.tool_input);
    const older = (replaces ? lastEvent : lastReplace) - ms;
    names.push(name);
    // within one millisecond the order of two calls is the order of their names (the tick, then the process), as when both are pending in one fold
    if (older > 0 ? older <= LATE_EVENT_MS : older === 0 && name < (replaces ? lastEventName : lastReplaceName)) { late += 1; continue; }
    const fenced = replaces ? false : fence(touched, name, event, broken ? null : record?.items);
    if (fenced === true) { late += 1; continue; }
    const next = applyEvent(broken ? null : record, event, key, env, broken, fenced || null);
    if (!replaces && editScope(event) !== null && ms + LATE_EVENT_MS >= horizon && !(next && next !== record && !sameItems(next, record))) {
      names.pop(); // changes nothing now, but an older call that is not visible yet may give it something to change
      continue;
    }
    if (next !== record && next) {
      const keys = replaces || editScope(event) === null ? [] : touchedKeys(event, broken ? null : record?.items); // the list before this call
      record = next;
      broken = false;
      changed = true;
      if (replaces) {
        lastReplace = Math.max(lastReplace, ms);
        if (ms === lastReplace && name > lastReplaceName) lastReplaceName = name;
      }
      for (const key of keys) if (!(touched[key] >= name)) touched[key] = name;
    }
    lastEvent = Math.max(lastEvent, ms);
    if (ms === lastEvent && name > lastEventName) lastEventName = name;
  }
  if (changed) {
    // a call more than LATE_EVENT_MS behind the newest one folded is no held-up hook, so its entry fences nothing
    for (const [scope, at] of Object.entries(touched)) if (eventMs(at) < lastEvent - LATE_EVENT_MS) delete touched[scope];
    record = { ...record, last_event_ms: lastEvent, last_replace_ms: lastReplace, last_event_name: lastEventName, last_replace_name: lastReplaceName, touched };
  }
  return { record, broken, names, changed, done, generation: generationOf(start), late };
}

// Under the lock: fold, write the list with the folded names, then remove the folded event files (retention: the folder holds only the
// events that no fold under the lock has taken yet). An event file whose name is already in `folded` is a leftover of a fold that was
// interrupted between the write of the list and the removal: it is removed too, always, before 500 newer names push its name out of
// `folded` and the file folds a second time. false when the lock was not taken; the events then stay for the next fold or reader.
export function syncList(sessionId, key, env = process.env) {
  const path = listPath(sessionId, key, env);
  if (!path) return false;
  let waiting = [];
  try { waiting = readdirSync(eventsDir(path)).filter((n) => EVENT_NAME.test(n)); } catch { /* no events folder */ }
  if (!waiting.length) return readRecord(path).record; // nothing to fold: no lock (most batches)
  let saved = null;
  const ok = withFileLock(path, (owned) => {
    const f = fold(path, key, env);
    saved = f.record;
    // What this fold decided rests on the list it read. It acts only while the lock is still its own and no other fold has published
    // since (the generation of the file is the one it folded from): a lock lost in a window no check closes must not let an older fold
    // overwrite the newer list, or delete events the newer list does not hold. The lock file is in the session directory, so it also tells
    // that the path still names the directory the fold started in: the retention sweep may move that directory away and another hook may
    // make it again. The check stands behind the removal of every event (a file of the moved tree that was merged into the new directory
    // is not removed, it is folded again there) and, after the temporary file is written, behind the publication (see publishJson).
    const current = () => owned() && generationOf(readRecord(path)) === f.generation;
    const remove = (names) => { for (const name of names) { if (!owned()) return; try { unlinkSync(join(eventsDir(path), name)); } catch { /* removed by an earlier fold */ } } };
    if (!current()) return; // the lock was taken over or another fold published: the newer fold writes
    if (f.late) storeEvent('late_event_dropped', path, env);
    remove(waiting.filter((name) => f.done.has(name)));
    if (!f.names.length) return;
    // events that change nothing (also on a broken list without a replacing call) leave the list file as it is
    if (!f.changed) { if (current()) remove(f.names); return; }
    const next = { ...f.record, folded: [...f.done, ...f.names].slice(-Math.max(EVENTS_KEPT, f.names.length)) };
    if (!publishJson(path, next, current, env)) return;
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

// A log row is small by design: every string of it (also in a list of strings) is cut to 200 characters, so an identifier the host sends
// cannot make a row of batches.jsonl large.
const rowText = (value) => (typeof value === 'string' ? value.slice(0, 200) : Array.isArray(value) ? value.map(rowText) : value);
export const logRow = (name, row, env = process.env) => appendLog(name, { ts: new Date().toISOString(), ...Object.fromEntries(Object.entries(row).map(([k, v]) => [k, rowText(v)])) }, env);

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
