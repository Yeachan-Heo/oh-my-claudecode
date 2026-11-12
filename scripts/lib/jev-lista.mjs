// omc-lokalne A3: task lists of agents for the Jev task-list plan (stages 2a, 2 and 3).
// Category : 1. data storage and 3. record shape. The list of every agent is what the agent itself sent to a list tool
// (source of truth: the tool_input of a call that ran, as the PostToolUse hook gets it); nothing here judges the work.
//   <logdir>/listy/<session_id>/<agent_id|main>.json   the list of one agent (main = the main thread, no agent_id in the hook input)
//   <logdir>/listy/<session_id>/<key>.zdarzenia/*.json list calls not yet folded into <key>.json (event journal, see syncList)
//   <logdir>/listy/<session_id>/<key>.licznik.json     counters of the step reminder (written only by the PostToolBatch hook)
//   <logdir>/listy/<session_id>/_task/<id>.json        which agent created a Task* task (the Task* store is one per session, without owner)
// Record v2 (T5): every task has a key `<file key>:<n>` (field `zadanie`, never reused), `host_id` (the Task* number), times of start and end,
// and later the Jev verdict `ocena_jeva` (written only by jev-zadania.mjs from a Jev answer; this file never judges a task). Tasks that left the
// list go to `historia`; the agents launched from the thread are in `agenci`; the owner messages seen in `prompty`.
// <logdir> is OMC_JEV_LOG_DIR or ~/.omc/state/jev (shellLogDir). Every function is fail-open: it returns null/false and never throws.
// Written from scratch (clean room).

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from './atomic-write.mjs';
import { appendShellLog, shellLogDir } from './jev-panel-host.mjs';

export const LIST_TOOL = 'mcp__plugin_oh-my-claudecode_t__lista_zadan'; // the name agents get in the hint (the plugin's own server)
export const LIST_TOOL_RE = /^mcp__(?:plugin_oh-my-claudecode_)?t__lista_zadan$/; // also the desktop app's copy of the server (mcp__t__)
export const MAIN = 'main';
export const LIST_RECORD_VERSION = 2; // 2: task keys, history, agent registry, ocena_jeva (T5, 11.11.2026)
export const HISTORY_MAX = 150;
export const LAUNCHES_MAX = 250;
export const PROMPTS_MAX = 200;
export const ITEMS_MAX = 50;
export const CONTENT_MAX = 500;
export const NOTE_MAX = 600;
export const LISTS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const SWEEP_EVERY_MS = 3600 * 1000;
const STATUSES = new Set(['pending', 'in_progress', 'completed']);
const SESSION_ID = /^(?!\.)[A-Za-z0-9._-]{1,200}$/; // as in jev-task.mjs, but never "." or ".." or a name starting with a dot (review L1)
const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,40}$/;
const AGENT_TYPE = /^(?!.*\.\.)[A-Za-z0-9_.-]{1,100}$/; // an agent type name used in a definition file path (review L6)
// Own lock file (open 'wx' with a random token): the state lock of atomic-write.mjs refuses backslash paths on one machine (file-lock
// fallback without better-sqlite3, failure kind "unverifiable", checked 10.11.2026). run.cjs gives a 3 s hook 2.5 s, so the wait ends after
// 1.5 s; a lock older than 3 s is a dead holder's (a hook holds it for milliseconds).
const LOCK_WAIT_MS = 1500;
const LOCK_STALE_MS = 3000;
// The fold of the event journal (syncList) treats its lock as stale only after 60 s: a fold descheduled for seconds on a busy machine
// (27.6 s hooks seen 10.11) must not have its lock broken and then overwrite a newer fold; a held lock only delays folding.
const SYNC_STALE_MS = 60_000;
const LOCK_STEP_MS = 20;

// Tools whose call changes the list of the calling agent (the PostToolUse matcher of hooks-dodatki.json names exactly these). update_plan and
// wrap_up count only in the main thread: the desktop app rejects them in subagents before they run (Z31). One rule for both hooks (review L8).
export const LIST_TOOL_NAMES = ['mcp__plugin_oh-my-claudecode_t__lista_zadan', 'mcp__t__lista_zadan', 'TaskCreate', 'TaskUpdate', 'TodoWrite', 'mcp__ccd_turn__update_plan', 'mcp__ccd_turn__wrap_up'];
export function isListTool(name, key = MAIN) {
  if (typeof name !== 'string' || !LIST_TOOL_NAMES.includes(name)) return false;
  return key === MAIN || !name.startsWith('mcp__ccd_turn__');
}

export const listsDir = (env = process.env) => join(shellLogDir(env), 'listy');
// The file key of an agent: main only when the hook input has no agent_id; an agent_id outside the safe pattern keeps its own key
// (unsafe characters as "_" plus a short sha256 of the original), so it never writes the main thread's list (review M2).
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
export function counterPath(sessionId, key, env = process.env) {
  const p = listPath(sessionId, key, env);
  return p ? p.replace(/\.json$/, '.licznik.json') : null;
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
const readJson = (path) => readRecord(path).record;

// A failed lock or write leaves a row in todo-hint.jsonl (review L3); the row never breaks the hook.
function storeEvent(event, path, env) {
  try { appendShellLog('todo-hint.jsonl', { ts: new Date().toISOString(), event, plik: basename(String(path)) }, env); } catch { /* logging never breaks the hook */ }
}

const readToken = (lockPath) => { try { return readFileSync(lockPath, 'utf8'); } catch { return null; } };

// A lock older than LOCK_STALE_MS is moved aside under a unique name (only one process wins the rename); when the moved file is not the
// one that was seen as old (a new holder took the lock in between), it is linked back (link never overwrites) and the holder keeps it.
function breakStaleLock(lockPath, staleMs = LOCK_STALE_MS) {
  let seen;
  try {
    if (Date.now() - statSync(lockPath).mtimeMs <= staleMs) return;
    seen = readFileSync(lockPath, 'utf8');
  } catch { return; }
  const aside = `${lockPath}.${randomBytes(6).toString('hex')}.stara`;
  try { renameSync(lockPath, aside); } catch { return; }
  if (readToken(aside) !== seen) { try { linkSync(aside, lockPath); } catch { /* a third process holds the lock now */ } }
  try { unlinkSync(aside); } catch { /* already gone */ }
}

// Runs fn under <path>.lock (the lock file holds a random token; only its owner removes it). false when the lock was not taken in time
// or fn threw; the call then changes nothing. fn gets owned(): true while the lock file still holds this token. staleMs: the age after
// which a lock counts as a dead holder's. Exported for the panel state (jev-panel-wejscie.mjs).
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

// Narrow masking for the task texts (review M1): the full maskSecrets of jev-shell.mjs also hides long words and plain "name: value"
// pairs, which destroys task names ("Passed: 26 testow"). Here: private key blocks, known key prefixes, a Bearer token, and the value
// after "=" or ":" only when a segment of the name (split by _ . -) is KEY, TOKEN, SECRET, PASS (PASSWD, PASSWORD) or PWD.
// The panel input for Jev keeps the full maskSecrets.
const LIST_SECRET_RULES = [
  [/(-{4,5} ?BEGIN (?:[A-Z0-9]+[ -])*PRIVATE KEY(?: BLOCK)? ?-{4,5})[\s\S]*?(-{4,5} ?END (?:[A-Z0-9]+[ -])*PRIVATE KEY(?: BLOCK)? ?-{4,5}|$)/g, '$1***'], // as SECRET_PEM of jev-sekrety.mjs: PGP, SSH2, digits (N11h, review rec-N11h LOW 5)
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

// One item: { content, status, notatka? } or null when the content is missing.
function itemOf(raw, noteField) {
  if (!raw || typeof raw !== 'object') return null;
  const content = cut(raw.content ?? raw.subject ?? '', CONTENT_MAX);
  if (!content) return null;
  const status = STATUSES.has(raw.status) ? raw.status : 'pending';
  const item = { content, status };
  const note = noteField ? raw[noteField] : undefined;
  if (typeof note === 'string' && note.trim()) item.notatka = cut(note, NOTE_MAX);
  return item;
}

// Is an update call well formed: items (a non-empty array of tasks) or at least one of advance, done, start. Used by the MCP tool too (same rule).
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

// update_plan / lista_zadan semantics (update_plan's own description): items replace the list; done marks 1-based numbers completed; start marks
// one in_progress and, as "Keep exactly one step in_progress" says, puts any other task in progress back to pending (review O2); advance
// completes the task in progress and starts the next pending one (the first pending after it, else the first pending).
// A note of a task sent again without a note is kept only when the content is the same and the task was and still is in progress (review O3).
// advance, done or start without an existing list change nothing (null), so an unreadable file never ends as an empty list (review L4).
export function applyUpdate(items, input, noteField) {
  const shape = updateShape(input);
  if (!shape.ok) return null;
  if (!shape.items && items.length === 0) return null;
  let list = items.map((x) => ({ ...x }));
  if (shape.items) {
    const old = new Map(list.map((x) => [x.content, x]));
    list = shape.items.map((raw) => itemOf(raw, noteField)).filter(Boolean).map((x) => {
      const before = old.get(x.content);
      return before?.notatka && !x.notatka && before.status === 'in_progress' && x.status === 'in_progress' ? { ...x, notatka: before.notatka } : x;
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
    // the last creator of a number owns it: the host numbers tasks again from 1 after a reset (review B1, seen 11.11.2026 in the live session)
    atomicWriteFileSync(join(dir, '_task', `${taskId}.json`), JSON.stringify({ agent: key, ts: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

// --- the PostToolUse entry point ----------------------------------------------------------

// New list of one agent after a list-tool call, or null when the call does not change it. `record` is the current file (or null);
// `broken` (the file exists but cannot be read): only a call that replaces the whole list (items, TodoWrite) is saved (review L4).
export function nextList(record, data, env = process.env, broken = false) {
  const tool = data?.tool_name;
  const input = data?.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  const items = Array.isArray(record?.items) ? record.items : [];
  const replaces = (LIST_TOOL_RE.test(tool) || tool === 'mcp__ccd_turn__update_plan') ? input.items !== undefined : tool === 'TodoWrite';
  if (broken && !replaces) return null;
  if (LIST_TOOL_RE.test(tool)) return applyUpdate(items, input, 'notatka');
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
    const item = itemOf({ content: input.subject, status: 'pending', notatka: input.description }, 'notatka');
    if (!id || !item || (!claimed && !claimTask(data.session_id, id, agentKey(data), env))) return null;
    return [...items.filter((x) => x.host_id !== id), { host_id: id, ...item }];
  }
  if (tool === 'TaskUpdate') {
    const id = input.taskId === undefined ? '' : String(input.taskId);
    const at = items.findIndex((x) => x.host_id === id);
    if (at < 0) return null; // a task of another agent (the store is shared) never moves to this agent's list
    const list = items.map((x) => ({ ...x }));
    if (input.status === 'deleted') return list.filter((_, i) => i !== at);
    if (STATUSES.has(input.status)) list[at].status = input.status;
    if (typeof input.subject === 'string' && input.subject.trim()) list[at].content = cut(input.subject, CONTENT_MAX);
    if (typeof input.description === 'string' && input.description.trim()) list[at].notatka = cut(input.description, NOTE_MAX);
    return list;
  }
  return null;
}

// The next key numbers of a session's lists are kept in <listy>/.nast/<session>.json when the session folder is swept; a new record starts there.
function saveNast(root, session, dir) {
  const numbers = {};
  for (const name of readdirSync(dir)) {
    if (!/^[A-Za-z0-9_-]+\.json$/.test(name) || name.endsWith('.licznik.json') || name.endsWith('.panel.json') || name.endsWith('.przypomnienie.json')) continue;
    const record = readJson(join(dir, name));
    if (Number.isInteger(record?.nast)) numbers[name.replace(/\.json$/, '')] = record.nast;
  }
  if (!Object.keys(numbers).length) return;
  mkdirSync(join(root, '.nast'), { recursive: true });
  writeJson(join(root, '.nast', `${session}.json`), numbers);
}
function loadNast(sessionId, key, env) {
  const n = readJson(join(listsDir(env), '.nast', `${sessionId}.json`))?.[key];
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

function sweep(env, now) {
  try {
    const root = listsDir(env);
    const marker = join(root, '.sprzatanie');
    if (existsSync(marker) && now - statSync(marker).mtimeMs < SWEEP_EVERY_MS) return;
    mkdirSync(root, { recursive: true });
    writeJson(marker, { ts: new Date(now).toISOString() });
    for (const name of readdirSync(root)) {
      if (name.startsWith('.')) continue;
      const dir = join(root, name);
      try {
        if (now - statSync(dir).mtimeMs <= LISTS_MAX_AGE_MS) continue;
        saveNast(root, name, dir); // keys are never reused, also when the session is resumed after the cleanup (review L3)
        rmSync(dir, { recursive: true, force: true });
      } catch { /* next */ }
    }
  } catch { /* cleanup never breaks the hook */ }
}

// --- event journal (coordinator 10.11.2026, 22:4x: 3 of 10 parallel TaskCreate saved on a busy machine, lock_timeout) ----------
// Every list call is one file <key>.zdarzenia/<ms>-<pid>-<id>.json, written without a lock (temp file, then rename), so a lock that is not
// taken in time loses nothing. The list <key>.json is the fold of the events in name order (time of the call), written under the lock
// together with the names it folded (`zlozone`, the newest EVENTS_KEPT); the folded files are then removed. A reader folds the list plus
// the events not yet folded. One file per event instead of one appended journal: parallel appendFileSync did not interleave lines here
// (50 processes x 20 lines of 200 B, 3 KB and 20 KB, 10.11), but trimming an appended file while other processes append to it loses lines.
export const EVENTS_KEPT = 500;
const EVENTS_READ_MAX = 5000;
const EVENT_NAME = /^\d{13}-\d{1,10}-[0-9a-f]{8}\.json$/;
export const eventsDir = (path) => (path ? path.replace(/\.json$/, '.zdarzenia') : null);

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
  const folded = new Set(Array.isArray(record?.zlozone) ? record.zlozone : []);
  const out = [];
  for (const name of names.slice(0, EVENTS_READ_MAX)) {
    if (folded.has(name)) continue;
    const { record: event } = readRecord(join(dir, name));
    if (event) out.push({ name, event });
  }
  return out;
}

// --- record v2: keys, history, agreement with the host (T5) -----------------------------------------------------------------

export const hash8 = (text) => createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 8);
export const itemVersion = (x) => hash8(`${x?.content ?? ''}\u0000${x?.status ?? ''}`); // what a verdict about "abandoned" and "done" is about
export const noteVersion = (x) => hash8(x?.notatka ?? '');
const META = ['zadanie', 'utworzone', 'u_hosta', 'od', 'od_wywolanie', 'do', 'do_wywolanie', 'zmiana', 'prompt_zmiany', 'agenci', 'ocena_jeva'];
const pickMeta = (x) => Object.fromEntries(META.filter((k) => x?.[k] !== undefined).map((k) => [k, x[k]]));
export const keyOf = (key, n) => `${key}:${n}`;

// A record v1 (items with `id`, no keys) as v2: the keys follow the order of the items; deterministic, so a reader and the next writer agree.
// { record, changed }.
function migrate(record, key) {
  if (!record || (record.v === LIST_RECORD_VERSION && Number.isInteger(record.nast))) return { record, changed: false };
  let n = Number.isInteger(record.nast) ? record.nast : 1;
  const items = (Array.isArray(record.items) ? record.items : []).map((x) => {
    const { id, ...rest } = x ?? {};
    const host_id = rest.host_id ?? (id !== undefined ? String(id) : undefined);
    return { ...(x?.zadanie ? {} : { zadanie: keyOf(key, n++) }), ...rest, ...(host_id !== undefined ? { host_id } : {}) };
  });
  return { record: { ...record, v: LIST_RECORD_VERSION, nast: n, items, historia: Array.isArray(record.historia) ? record.historia : [], agenci: Array.isArray(record.agenci) ? record.agenci : [], prompty: Array.isArray(record.prompty) ? record.prompty : [] }, changed: true };
}

// Moves tasks out of `items` into `historia`, newest last.
function retire(record, gone, ts, powod) {
  if (!gone.length) return record;
  const old = Array.isArray(record.historia) ? record.historia : [];
  const moved = gone.map((x) => ({ ...x, zeszlo: ts, powod, ...(powod === 'poza_hostem' ? { poza_hostem: true } : {}) }));
  let all = [...old, ...moved];
  // the history is capped; completed tasks go first, an open task is dropped only when nothing else is left (review L13)
  for (let i = 0; all.length > HISTORY_MAX && i < all.length;) {
    if (all[i].status === 'completed') all.splice(i, 1); else i += 1;
  }
  if (all.length > HISTORY_MAX) all = all.slice(-HISTORY_MAX);
  return { ...record, historia: all };
}

// The new list `list` (what nextList returned) against the old items: keys, times, history. A task keeps its key when it is the same object
// (an in-place change) or has the same content and host number (a list sent again); a task that is not carried over goes to `historia`.
function carry(base, list, event, key, env) {
  const ts = event.ts ?? new Date().toISOString();
  const before = Array.isArray(base?.items) ? base.items : [];
  const archive = Array.isArray(base?.historia) ? base.historia : [];
  let n = Number.isInteger(base?.nast) ? base.nast : loadNast(event.session_id, key, env);
  const used = new Set();
  const restored = new Set();
  const items = list.map((x) => {
    let prev = x.zadanie ? before.find((b) => b.zadanie === x.zadanie) : null;
    if (!prev) prev = before.find((b) => !used.has(b.zadanie) && b.content === x.content && (b.host_id ?? null) === (x.host_id ?? null));
    if (!prev && x.status !== 'completed') {
      // a list sent again with a task that had left it (replaced, cut off) is the same task: its key and its verdict come back (review H1)
      prev = archive.find((b) => !restored.has(b.zadanie) && b.status !== 'completed' && b.powod !== 'poza_hostem' && b.content === x.content && (b.host_id ?? null) === (x.host_id ?? null)) ?? null;
      if (prev) restored.add(prev.zadanie);
    }
    if (prev) used.add(prev.zadanie);
    const item = prev ? { ...pickMeta(prev), ...x } : { ...x, zadanie: x.zadanie ?? keyOf(key, n++), utworzone: ts };
    const changed = !prev || prev.content !== item.content || prev.status !== item.status || (prev.notatka ?? '') !== (item.notatka ?? '');
    if (item.status === 'in_progress' && !item.od) { item.od = ts; item.od_wywolanie = event.tool_use_id ?? null; }
    if (item.status === 'completed' && prev?.status !== 'completed') { item.do = ts; item.do_wywolanie = event.tool_use_id ?? null; }
    if (item.status !== 'completed' && item.do) { delete item.do; delete item.do_wywolanie; }
    if (changed) { item.zmiana = ts; item.prompt_zmiany = event.prompt_id ?? null; }
    return item;
  });
  const gone = before.filter((b) => !used.has(b.zadanie));
  return { items, nast: n, gone, restored };
}

const removalReason = (event) => (event.tool_name === 'TaskUpdate' ? 'usuniete' : event.tool_name === 'TaskCreate' ? 'zastapione' : 'lista_zastapiona');

// The record after one event, or the same record when the event changes nothing (null stays null).
function applyEvent(record, event, key, env, broken) {
  // a task cut off by the item limit is still on the host: its update brings it back (review M2)
  if (record && event.tool_name === 'TaskUpdate' && event.tool_input?.taskId !== undefined) {
    const id = String(event.tool_input.taskId);
    const at = (record.historia ?? []).findLastIndex((x) => x.host_id === id && x.powod === 'obciete');
    if (at >= 0 && !record.items.some((x) => x.host_id === id)) {
      const { zeszlo, powod, ...back } = record.historia[at];
      record = { ...record, items: [...record.items, back], historia: record.historia.filter((_, i) => i !== at) };
    }
  }
  const changed = nextList(record, event, env, broken);
  if (!changed) return record;
  // a completed task has no note (review O3); above ITEMS_MAX the newest tasks stay, the record counts the dropped ones (review L10)
  const all = changed.map((x) => (x.status === 'completed' && x.notatka !== undefined ? (({ notatka, ...rest }) => rest)(x) : x));
  const kept = carry(record, all, event, key, env);
  // above ITEMS_MAX the oldest completed tasks leave first, then the oldest of the rest (review M2)
  const cut = [];
  for (let over = kept.items.length - ITEMS_MAX, i = 0; over > 0 && i < kept.items.length; i += 1) if (kept.items[i].status === 'completed') { cut.push(i); over -= 1; }
  for (let over = kept.items.length - ITEMS_MAX - cut.length, i = 0; over > 0 && i < kept.items.length; i += 1) if (!cut.includes(i)) { cut.push(i); over -= 1; }
  const overflow = cut.length;
  let next = {
    v: LIST_RECORD_VERSION,
    session_id: event.session_id,
    agent: key,
    agent_type: event.agent_type ?? null,
    tool: event.tool_name,
    tool_use_id: event.tool_use_id ?? null,
    prompt_id: event.prompt_id ?? null,
    updated: event.ts,
    updates: (Number.isInteger(record?.updates) ? record.updates : 0) + 1,
    nast: kept.nast,
    items: kept.items.filter((_, i) => !cut.includes(i)),
    historia: (Array.isArray(record?.historia) ? record.historia : []).filter((x) => !kept.restored.has(x.zadanie)),
    agenci: Array.isArray(record?.agenci) ? record.agenci : [],
    prompty: Array.isArray(record?.prompty) ? record.prompty : [],
    ...(overflow ? { obcieto: overflow } : {}),
  };
  next = retire(next, kept.gone, event.ts, removalReason(event));
  next = retire(next, cut.map((i) => kept.items[i]), event.ts, 'obciete');
  return notePromptIn(next, event.prompt_id) ?? next;
}

// The owner messages seen by this thread, in order (`prompt_id`): the count of messages since a change is a fact for Jev.
export function notePromptIn(record, promptId) {
  if (!record || typeof promptId !== 'string' || !promptId) return null;
  const list = Array.isArray(record.prompty) ? record.prompty : [];
  if (list.at(-1) === promptId) return null;
  return { ...record, prompty: [...list.filter((p) => p !== promptId), promptId].slice(-PROMPTS_MAX) };
}

// The Task* store of the host for this session: { tasks: Map of host id -> { status, subject }, oldest: mtime in ms of the oldest file }, or null
// when the directory is missing or a file cannot be read (then nothing is reconciled).
export function hostTasks(sessionId, env = process.env) {
  try {
    const dir = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'tasks', sessionId);
    if (!SESSION_ID.test(sessionId) || !existsSync(dir)) return null;
    const tasks = new Map();
    let oldest = Infinity;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const task = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const id = String(task?.id ?? name.replace(/\.json$/, ''));
      tasks.set(id, { status: STATUSES.has(task?.status) ? task.status : null, subject: typeof task?.subject === 'string' ? cut(task.subject, CONTENT_MAX) : null });
      oldest = Math.min(oldest, statSync(join(dir, name)).mtimeMs);
    }
    return { tasks, oldest };
  } catch {
    return null;
  }
}

// E4 K2: a task with a host number that the host no longer has goes to `historia` (`poza_hostem`); a host number that now holds another task
// (the host numbered again from 1) retires the old one as `zastapione`; the host's status wins over the store's (an event may have been lost).
// A task that was never seen at the host is retired only when the host's files are all newer than the task (the host writes to another
// folder, e.g. a team folder, in other sessions: a new task must not be sent to the history at once; review M1). { record, changed }.
function reconcile(record, sessionId, env) {
  if (!record || !Array.isArray(record.items) || !record.items.some((x) => x?.host_id !== undefined)) return { record, changed: false };
  const host = hostTasks(sessionId, env);
  if (!host) return { record, changed: false };
  const ts = new Date().toISOString();
  const gone = [];
  const replaced = [];
  let changed = false;
  const items = [];
  for (const x of record.items) {
    if (x.host_id === undefined) { items.push(x); continue; }
    const h = host.tasks.get(String(x.host_id));
    if (!h) {
      const created = Date.parse(x.utworzone ?? '');
      if (x.u_hosta === true || !Number.isFinite(created) || created < host.oldest) { gone.push(x); changed = true; } else items.push(x);
      continue;
    }
    if (h.subject !== null && h.subject !== x.content) { replaced.push(x); changed = true; continue; }
    let y = x;
    if (x.u_hosta !== true) { y = { ...y, u_hosta: true }; changed = true; }
    if (h.status && h.status !== x.status) {
      y = { ...y, status: h.status, zmiana: ts, prompt_zmiany: null };
      if (h.status === 'completed') { delete y.notatka; y.do ??= ts; } else { delete y.do; delete y.do_wywolanie; if (h.status === 'in_progress') y.od ??= ts; }
      changed = true;
    }
    items.push(y);
  }
  if (!changed) return { record, changed: false };
  return { record: retire(retire({ ...record, items }, gone, ts, 'poza_hostem'), replaced, ts, 'zastapione'), changed: true };
}

// Folds the pending events into the list file. { record, broken, names, changed }: names are the events folded (all pending ones).
function fold(path, key, env) {
  const dir = eventsDir(path);
  const events = pendingEvents(dir, null); // listed before the snapshot is read: a fold in between has its names in zlozone
  const start = readRecord(path);
  const done = new Set(Array.isArray(start.record?.zlozone) ? start.record.zlozone : []);
  const migrated = migrate(start.record, key);
  let record = migrated.record;
  let broken = start.broken;
  let changed = migrated.changed;
  const names = [];
  for (const { name, event } of events) {
    if (done.has(name)) continue;
    const next = applyEvent(broken ? null : record, event, key, env, broken);
    if (next !== record && next) { record = next; broken = false; changed = true; }
    names.push(name);
  }
  if (record && !broken) {
    const r = reconcile(record, basename(dirname(path)), env);
    if (r.changed) { record = r.record; changed = true; }
  }
  return { record, broken, names, changed, done };
}

// Under the lock: fold, write the list with the folded names, then remove the folded event files (retention: the folder holds only the
// events that no fold under the lock has taken yet). false when the lock was not taken; the events then stay for the next fold or reader.
// `mutate(record)` (T5: agent registry, owner messages) returns the new record or null; it runs on the folded record under the same lock.
// Without events, without mutate and without a difference to the host nothing is locked or written (most batches).
const SIZE_LIMIT = 900 * 1024; // readRecord refuses a file above 1 MB
function fitSize(record) {
  let r = record;
  for (let i = 0; i < 20 && JSON.stringify(r).length > SIZE_LIMIT; i += 1) {
    const h = Array.isArray(r.historia) ? r.historia : [];
    const a = Array.isArray(r.agenci) ? r.agenci : [];
    if (!h.length && !a.length) break;
    r = { ...r, historia: h.slice(Math.ceil(h.length / 4)), agenci: a.slice(Math.ceil(a.length / 4)) };
  }
  return r;
}

export function syncList(sessionId, key, env = process.env, mutate = null) {
  const path = listPath(sessionId, key, env);
  if (!path) return false;
  let waiting = [];
  try { waiting = readdirSync(eventsDir(path)).filter((n) => EVENT_NAME.test(n)); } catch { /* no events folder */ }
  if (!waiting.length && !mutate) {
    const quick = fold(path, key, env);
    if (!quick.changed) return quick.record;
  }
  let saved = null;
  let failed = false;
  const remove = (names) => { for (const name of names) { try { unlinkSync(join(eventsDir(path), name)); } catch { /* removed by an earlier fold */ } } };
  const ok = withFileLock(path, (owned) => {
    const f = fold(path, key, env);
    if (mutate) {
      const m = mutate(f.record);
      if (m) { f.record = m; f.changed = true; }
    }
    saved = f.record;
    if (!f.names.length && !f.changed) return;
    // events that change nothing (also on a broken list without a replacing call, review L4) leave the list file as it is
    if (!owned()) return; // the lock was taken over: the newer fold writes
    if (!f.changed) { remove(f.names); return; }
    const next = { ...f.record, zlozone: [...f.done, ...f.names].slice(-Math.max(EVENTS_KEPT, f.names.length)) };
    if (!owned()) return;
    // a file above the read limit would be unreadable: the oldest history and registry entries go first (review L4)
    const trimmed = fitSize(next);
    if (!writeJson(path, trimmed, env)) { failed = true; return; }
    saved = trimmed;
    remove(f.names);
  }, env, SYNC_STALE_MS);
  return ok && !failed ? saved : false;
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
// Times (ms) of the list calls of one agent, oldest first: the folded events (`zlozone`, the newest EVENTS_KEPT) and the ones not folded yet.
export function listCallTimes(sessionId, key, env = process.env) {
  try {
    const path = listPath(sessionId, key, env);
    if (!path) return [];
    const names = new Set(Array.isArray(readJson(path)?.zlozone) ? readJson(path).zlozone : []);
    try { for (const n of readdirSync(eventsDir(path))) if (EVENT_NAME.test(n)) names.add(n); } catch { /* no events folder */ }
    return [...names].map((n) => Number(/^(\d{13})-/.exec(String(n))?.[1])).filter(Number.isFinite).sort((a, b) => a - b);
  } catch {
    return [];
  }
}
export const readCounter = (sessionId, key, env = process.env) => readJson(counterPath(sessionId, key, env));
export function writeCounter(sessionId, key, value, env = process.env) {
  const path = counterPath(sessionId, key, env);
  if (!path) return false;
  try { mkdirSync(join(path, '..'), { recursive: true }); } catch { return false; }
  return writeJson(path, value, env);
}
export const inProgress = (record) => (Array.isArray(record?.items) ? record.items.filter((x) => x?.status === 'in_progress') : []);

// --- which agent types have the list tool (stage 2) ----------------------------------------

// Types without a definition file (built into Claude Code), with the tools the Agent tool lists for them in a session (10.11.2026):
// general-purpose and claude "Tools: *", Plan "All tools except Agent, ..., Edit, Write". Other built-in types have short read-only lists.
const BUILT_IN = {
  'general-purpose': { lista: true, toolSearch: true, agent: true },
  claude: { lista: true, toolSearch: true, agent: true },
  Plan: { lista: true, toolSearch: true, agent: false },
};
const PLUGIN_PREFIX = 'oh-my-claudecode:';
const PLUGIN_AGENTS = fileURLToPath(new URL('../../agents/', import.meta.url));

function frontmatterList(front, field) {
  const line = new RegExp(`^${field}:[ \\t]*(.*)$`, 'm').exec(front);
  if (!line) return null;
  const inline = line[1].trim().replace(/^\[|\]$/g, '');
  if (inline) return inline.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  const after = front.slice(line.index + line[0].length).split(/\r?\n/).slice(1);
  const items = [];
  for (const l of after) {
    const m = /^\s+-\s*(.+)$/.exec(l);
    if (!m) break;
    items.push(m[1].trim().replace(/^["']|["']$/g, ''));
  }
  return items;
}

function definitionOf(dir, name) {
  try {
    const direct = join(dir, `${name}.md`);
    const files = existsSync(direct) ? [direct] : readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => join(dir, f));
    for (const file of files) {
      const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      if (!m) continue;
      const own = /^name:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m.exec(m[1])?.[1];
      if (file === direct || own === name) return { file, front: m[1] };
    }
  } catch { /* no directory */ }
  return null;
}

// { lista, toolSearch, agent, zrodlo } for an agent type, or { lista: false, zrodlo: 'nieznany' } when nothing tells (the hint is skipped).
const SERVER_TOOLS = (t) => LIST_TOOL_RE.test(t) || t === 'mcp__plugin_oh-my-claudecode_t' || t === 'mcp__plugin_oh-my-claudecode_t__*';
export function typeTools(agentType, cwd, env = process.env) {
  const type = typeof agentType === 'string' ? agentType.trim() : '';
  if (!type) return { lista: false, zrodlo: 'brak-typu' };
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  let def = null;
  const own = type.startsWith(PLUGIN_PREFIX) ? type.slice(PLUGIN_PREFIX.length) : type;
  if (type.startsWith(PLUGIN_PREFIX)) def = AGENT_TYPE.test(own) ? definitionOf(PLUGIN_AGENTS, own) : null;
  else if (!type.includes(':') && AGENT_TYPE.test(type)) {
    def = (typeof cwd === 'string' && cwd ? definitionOf(join(cwd, '.claude', 'agents'), type) : null) ?? definitionOf(join(configDir, 'agents'), type);
  }
  if (!def) return BUILT_IN[type] ? { ...BUILT_IN[type], zrodlo: 'wbudowany' } : { lista: false, zrodlo: 'nieznany' };
  const tools = frontmatterList(def.front, 'tools');
  const denied = frontmatterList(def.front, 'disallowedTools') ?? [];
  // `tools: "*"` or `All` is the same as no tools field (review L5)
  if (tools && tools.length && !tools.some((t) => t === '*' || /^all$/i.test(t))) {
    const lista = tools.some(SERVER_TOOLS) && !denied.some(SERVER_TOOLS);
    return { lista, toolSearch: tools.includes('ToolSearch'), agent: tools.includes('Agent') || tools.includes('Task'), zrodlo: def.file };
  }
  return {
    lista: !denied.some((t) => SERVER_TOOLS(t) || t === 'ToolSearch'),
    toolSearch: true,
    agent: !denied.includes('Agent') && !denied.includes('Task'),
    zrodlo: def.file,
  };
}

// --- hint texts ---------------------------------------------------------------------------

export const HINT_MAX = 400;
export function startHint(tools) {
  const load = tools.toolSearch ? `ToolSearch select:${LIST_TOOL}, potem to narzędzie` : `narzędzie ${LIST_TOOL}`;
  const parts = [
    `Lista zadań: ${load} (nie update_plan).`,
    'Zapisz ją przed pracą; zadanie = jeden sprawdzalny wynik; in_progress przed pracą, completed po niej; zadanie w toku z notatką: co robisz i po co.',
  ];
  if (tools.agent) parts.push('Serię 3+ prostych kroków (wypisanie, liczenie, przepisanie, porównanie) zleć agentowi mechanik albo Explore, najwyżej jednemu naraz.');
  const text = parts.join(' ');
  return text.length > HINT_MAX ? `${text.slice(0, HINT_MAX - 1)}…` : text; // review L9
}
export const STEP_HINT_MAIN = 'Wpisz bieżący krok na listę zadań i oznacz go jako w toku.';
// The step reminder of a subagent names the tool, and how to load it when it is deferred (review L7).
export function stepHint(key, toolSearch = true) {
  if (key === MAIN) return STEP_HINT_MAIN;
  const load = toolSearch ? `; gdy niezaładowane: ToolSearch select:${LIST_TOOL}` : '';
  return `Wpisz bieżący krok na listę zadań (${LIST_TOOL}${load}) i oznacz go jako w toku.`;
}

// OMC_TODO_HINT: off | shadow | active. Since T5 it governs the delivery of the reminder Jev decided on (shadow: a row in todo-hint.jsonl, nothing is
// delivered; active: delivered once). Unset or unknown: shadow.
export function todoHintMode(env = process.env) {
  const v = String(env.OMC_TODO_HINT ?? '').trim().toLowerCase();
  return v === 'off' || v === 'active' ? v : 'shadow';
}

export const logRow = (name, row, env = process.env) => appendShellLog(name, { ts: new Date().toISOString(), ...row }, env);

// Kill switches of OMC hooks (as in post-tool-use-failure.mjs): DISABLE_OMC=1|true, or OMC_SKIP_HOOKS with the event token or "jev-lista".
export function skipped(eventToken, env = process.env) {
  const tokens = String(env.OMC_SKIP_HOOKS || '').split(',').map((s) => s.trim());
  return env.DISABLE_OMC === '1' || env.DISABLE_OMC === 'true' || tokens.includes(eventToken) || tokens.includes('jev-lista');
}

// T5 (coordinator, 11.11.2026): the counter of calls since the last list change, the agent type and the number of reminders given are SIGNALS
// in the input of Jev (zadaniaDoZapytania, state.przypomnienie). They trigger nothing and cap nothing: whether and what to remind an agent
// is decided by Jev in the shared query; jev-zadania.mjs stores his decision and jev-lista-paczka.mjs delivers it once.

// Parses the hook input read from stdin; null when it is not a JSON object.
export function parseHookInput(raw) {
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}
