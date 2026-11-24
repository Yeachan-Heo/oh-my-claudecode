/**
 * Task-list lock recovery under a real race. A lock left by a dead holder is broken by whoever finds it; the check
 * (age, token, identity) and the removal are separate steps, so two hooks can contend for the same leftover. Every case
 * runs real node processes against the real library; a process is held at a chosen point by a preload that wraps `fs`
 * and waits for a semaphore file, so the window the race needs is opened on purpose instead of hoped for.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LIB = pathToFileURL(join(ROOT, 'scripts', 'lib', 'jev-task-list.mjs')).href;
const TOTAL_MS = 60_000;

let TMP;
let L;
let counter = 0;

// Wraps `fs` before the library is loaded. PAUSE_KIND (kinds joined by "+" are held one after the other):
//   lock-observed       after the first look at a file whose name ends in ".lock" (a stat of the path, or a stat of a handle opened on it for reading)
//   before-lock-rename  before a ".lock" file is renamed (the removal of a lock: the last moment before the file that is moved is fixed)
//   after-lock-rename   right after a ".lock" file was renamed: the lock path is free and the moved file is not judged yet
//   before-publish      before the fold of PAUSE_MATCH (a list file) decides or starts to publish: the second lstat of that path (the generation check
//                       of the fold) or, when there is none, the creation of the temporary file of the list (see before-list-temp)
//   sweep-observed      right after the stat of the directory PAUSE_MATCH (the sweep reading the age of a session directory)
//   before-event-publish  before the temporary file of an event (<key>.events/<name>.json.tmp) is renamed to its name: the event is written
//                       and its call time is fixed, but it is not visible yet
//   short-writes        no hold: every writeSync of the process stores at most N bytes (N = PAUSE_MATCH; 0 stores none), as a disk that is filling up can
//   after-sweep-move    right after the sweep moved a session directory to its hidden name (<root>/.<session>.<hex>.sweeping): the session path is free and the
//                       moved tree is not judged yet
//   before-session-write  before the first file of a call is opened inside the session tree: the claim of a task number (<session>/_task/<id>.json) or the
//                       temporary file of an event; the directory of the writer was made just before, so the sweep can move it away now
//   before-list-temp   before the temporary file of the list PAUSE_MATCH (a file in the list's directory whose name holds the name of the list and
//                       does not end in ".lock") is created: the fold has made its last check of the lock and the list, and has written nothing
//   before-list-rename  before a file is renamed to the list PAUSE_MATCH: the temporary file is written and the fold has checked a last time
//   after-list-publish  right after a file was renamed to the list PAUSE_MATCH: the list is published and the events it folded are not removed yet
//   before-moved-event-check  before the first read of the token of a ".lock" file (the check that the lock is still the process's own): the merge of a moved
//                       tree holds the lock of the live list and has read the live record, and has not judged or moved any event yet
// The process writes PAUSE_MARK and waits until PAUSE_GO exists (with several kinds both names get the suffix ".<kind>").
const PRELOAD = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const { PAUSE_KIND, PAUSE_MATCH, PAUSE_MARK, PAUSE_GO } = process.env;
const kinds = PAUSE_KIND.split('+');
const fired = new Set();
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const hold = (kind) => {
  if (fired.has(kind)) return;
  fired.add(kind);
  const suffix = kinds.length > 1 ? '.' + kind : '';
  fs.writeFileSync(PAUSE_MARK + suffix, String(process.pid));
  for (let i = 0; i < 3000 && !fs.existsSync(PAUSE_GO + suffix); i += 1) Atomics.wait(sleeper, 0, 0, 10);
};
const isLock = (p) => typeof p === 'string' && p.endsWith('.lock');
if (kinds.includes('lock-observed')) {
  const lockFds = new Set();
  const open = fs.openSync;
  fs.openSync = (p, flags, ...rest) => { const fd = open(p, flags, ...rest); if (isLock(p) && (flags === undefined || flags === 'r')) lockFds.add(fd); return fd; };
  for (const name of ['statSync', 'lstatSync']) {
    const real = fs[name];
    fs[name] = (p, ...rest) => { const r = real(p, ...rest); if (isLock(p)) hold('lock-observed'); return r; };
  }
  const fstat = fs.fstatSync;
  fs.fstatSync = (fd, ...rest) => { const r = fstat(fd, ...rest); if (lockFds.has(fd)) hold('lock-observed'); return r; };
}
if (kinds.includes('before-lock-rename') || kinds.includes('after-lock-rename')) {
  const rename = fs.renameSync;
  fs.renameSync = (from, to, ...rest) => {
    if (isLock(from) && kinds.includes('before-lock-rename')) hold('before-lock-rename');
    const result = rename(from, to, ...rest);
    if (isLock(from) && kinds.includes('after-lock-rename')) hold('after-lock-rename');
    return result;
  };
}
if (kinds.includes('before-publish')) {
  let looks = 0;
  const lstat = fs.lstatSync;
  fs.lstatSync = (p, ...rest) => { if (p === PAUSE_MATCH && (looks += 1) === 2) hold('before-publish'); return lstat(p, ...rest); };
  const open = fs.openSync;
  const listDir = PAUSE_MATCH.replace(/[^/]*$/, '');
  fs.openSync = (p, flags, ...rest) => { if (flags === 'wx' && typeof p === 'string' && p.startsWith(listDir) && !p.slice(listDir.length).includes('/') && p.slice(listDir.length).includes(PAUSE_MATCH.slice(listDir.length)) && !p.endsWith('.lock')) hold('before-publish'); return open(p, flags, ...rest); };
}
if (kinds.includes('before-event-publish')) {
  const rename = fs.renameSync;
  fs.renameSync = (from, to, ...rest) => { if (typeof from === 'string' && /\\.events\\/[^/]+\\.json\\.tmp$/.test(from)) hold('before-event-publish'); return rename(from, to, ...rest); };
}
if (kinds.includes('short-writes')) {
  const write = fs.writeSync;
  const most = Number(PAUSE_MATCH);
  fs.writeSync = (fd, data, ...rest) => {
    if (typeof data === 'string') { const bytes = Buffer.from(data, 'utf8'); return most === 0 ? 0 : write(fd, bytes, 0, Math.min(bytes.length, most)); }
    const [offset = 0, length = data.length - offset, ...tail] = rest;
    return most === 0 ? 0 : write(fd, data, offset, Math.min(length, most), ...tail);
  };
}
if (kinds.includes('before-session-write')) {
  const open = fs.openSync;
  fs.openSync = (p, flags, ...rest) => { if (flags === 'wx' && typeof p === 'string' && /\\/(?:[^/]+\\.events\\/[^/]+\\.json\\.tmp|_task\\/[^/]+\\.json)$/.test(p)) hold('before-session-write'); return open(p, flags, ...rest); };
}
if (kinds.includes('after-sweep-move')) {
  const rename = fs.renameSync;
  fs.renameSync = (from, to, ...rest) => { const result = rename(from, to, ...rest); if (typeof to === 'string' && /\\.sweeping$/.test(to)) hold('after-sweep-move'); return result; };
}
if (kinds.includes('before-list-temp')) {
  const open = fs.openSync;
  const dir = PAUSE_MATCH.replace(/[^/]*$/, '');
  const base = PAUSE_MATCH.slice(dir.length);
  fs.openSync = (p, flags, ...rest) => {
    const name = typeof p === 'string' && p.startsWith(dir) ? p.slice(dir.length) : '';
    if (flags === 'wx' && name && !name.includes('/') && name.includes(base) && !name.endsWith('.lock')) hold('before-list-temp');
    return open(p, flags, ...rest);
  };
}
if (kinds.includes('before-list-rename') || kinds.includes('after-list-publish')) {
  const rename = fs.renameSync;
  fs.renameSync = (from, to, ...rest) => {
    if (to === PAUSE_MATCH && kinds.includes('before-list-rename')) hold('before-list-rename');
    const result = rename(from, to, ...rest);
    if (to === PAUSE_MATCH && kinds.includes('after-list-publish')) hold('after-list-publish');
    return result;
  };
}
if (kinds.includes('before-moved-event-check')) {
  const read = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => { if (isLock(p)) hold('before-moved-event-check'); return read(p, ...rest); };
}
if (kinds.includes('sweep-observed')) {
  const stat = fs.statSync;
  fs.statSync = (p, ...rest) => { const r = stat(p, ...rest); if (p === PAUSE_MATCH) hold('sweep-observed'); return r; };
}
syncBuiltinESMExports();
`;

// The process under test: waits for cfg.waitFor, runs the case named by cfg.kind (a lock, a sweep or a list call) and writes cfg.done.
const CHILD = `
import fs from 'node:fs';
const cfg = JSON.parse(process.env.CHILD_CFG);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const waitFor = (file, ms) => { for (let i = 0; i < ms / 10 && !fs.existsSync(file); i += 1) Atomics.wait(sleeper, 0, 0, 10); };
const L = await import(cfg.lib);
if (cfg.waitFor) waitFor(cfg.waitFor, 30000);
if (cfg.kind === 'lock') {
  const ok = L.withFileLock(cfg.path, () => {
    fs.appendFileSync(cfg.log, cfg.label + '-enter\\n');
    if (cfg.takeover) { fs.rmSync(cfg.path + '.lock'); fs.writeFileSync(cfg.path + '.lock', 'new-holder'); fs.writeFileSync(cfg.takeover, '1'); } // another hook took the lock over as stale
    if (cfg.holdUntil) { fs.writeFileSync(cfg.holdMark, '1'); waitFor(cfg.holdUntil, 8000); } else Atomics.wait(sleeper, 0, 0, 300);
    fs.appendFileSync(cfg.log, cfg.label + '-exit\\n');
  }, process.env, cfg.staleMs);
  fs.appendFileSync(cfg.log, cfg.label + '-result ' + ok + '\\n');
} else if (cfg.kind === 'sweep') {
  L.sweep(process.env, Date.now());
} else {
  L.recordListCall(cfg.data, process.env);
}
fs.writeFileSync(cfg.done, '1');
`;

beforeAll(async () => {
  TMP = mkdtempSync(join(tmpdir(), 'omc-task-list-race-'));
  writeFileSync(join(TMP, 'preload.mjs'), PRELOAD);
  writeFileSync(join(TMP, 'child.mjs'), CHILD);
  L = await import(LIB);
});

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

const waitUntil = async (file, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!existsSync(file)) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${file}`);
    await new Promise((done) => setTimeout(done, 10));
  }
};

const waitUntilAny = async (candidates, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!candidates.some((file) => existsSync(file))) {
    if (Date.now() > end) throw new Error(`timeout waiting for one of ${candidates.join(', ')}`);
    await new Promise((done) => setTimeout(done, 10));
  }
};

/** Starts a child; resolves with its exit code and stderr. `pause` holds it at a point of the library (see PRELOAD). */
function startChild(dir, cfg, pause, env) {
  const execArgv = pause ? ['--import', pathToFileURL(join(TMP, 'preload.mjs')).href] : [];
  const childEnv = { ...env, CHILD_CFG: JSON.stringify({ lib: LIB, ...cfg }), ...(pause ? { PAUSE_KIND: pause.kind, PAUSE_MATCH: pause.match ?? '', PAUSE_MARK: pause.mark, PAUSE_GO: pause.go } : {}) };
  const child = spawn(process.execPath, [...execArgv, join(TMP, 'child.mjs')], { cwd: dir, env: childEnv, windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const guard = setTimeout(() => child.kill(), 50_000);
  const exited = new Promise((done) => child.on('close', (code) => { clearTimeout(guard); done({ code, stderr }); }));
  return { child, exited };
}

const baseEnv = (logs) => Object.fromEntries(Object.entries({ ...process.env, OMC_TASK_LIST_LOG_DIR: logs, HOME: TMP, USERPROFILE: TMP }).filter(([k]) => !/^(OMC_(?!TASK_LIST_LOG_DIR)|DISABLE_OMC|TYPESAFE_|ANTHROPIC_|CLAUDE)/i.test(k)));

/** The sequence of "<label>-enter" and "<label>-exit" lines in the order written; true when one process entered while another was inside. */
function overlapped(log) {
  const inside = new Set();
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    const [label, what] = line.split('-');
    if (what === 'enter') {
      if (inside.size > 0) return true;
      inside.add(label);
    } else if (what === 'exit') {
      inside.delete(label);
    }
  }
  return false;
}

const task = (subject, id, sessionId = 'race-session') => ({
  session_id: sessionId, tool_name: 'TaskCreate', tool_input: { subject }, tool_response: `Task #${id} created successfully: ${subject}`, tool_use_id: `toolu_${id}`,
});

describe('task-list lock: two hooks contend for the lock a dead holder left', () => {
  it.each([
    ['right after it looked at the old lock', 'lock-observed'],
    ['right before it renames the old lock away', 'before-lock-rename'],
  ])('a hook held %s does not remove the lock the other hook took meanwhile', async (_when, kind) => {
    counter += 1;
    const dir = join(TMP, `lock-${counter}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'list.json');
    const lock = `${path}.lock`;
    const log = join(dir, 'log.txt');
    writeFileSync(log, '');
    writeFileSync(lock, 'dead-holder');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const env = baseEnv(join(dir, 'logs'));
    const files = (name) => join(dir, name);
    // A is held at the chosen point. B is started now and waits for its go, so that it needs only milliseconds later.
    const a = startChild(dir, { kind: 'lock', path, log, label: 'A', staleMs: 60_000, done: files('a-done') }, { kind, mark: files('a-paused'), go: files('a-go') }, env);
    const b = startChild(dir, { kind: 'lock', path, log, label: 'B', staleMs: 60_000, waitFor: files('b-go'), holdMark: files('b-holding'), holdUntil: files('a-done'), done: files('b-done') }, null, env);
    await waitUntil(files('a-paused'));
    writeFileSync(files('b-go'), '1');
    await waitUntil(files('b-holding')); // B broke the old lock, took its own and is inside
    writeFileSync(files('a-go'), '1');
    const [ra, rb] = await Promise.all([a.exited, b.exited]);
    expect([ra.code, rb.code]).toEqual([0, 0]);
    const lines = readFileSync(log, 'utf8');
    expect(overlapped(log), lines).toBe(false);
    expect(lines).toContain('A-result false');
    expect(lines).toContain('B-result true');
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(dir).filter((n) => n.endsWith('.moved'))).toEqual([]);
  }, TOTAL_MS);

  it('a lock refreshed by its holder after it was judged old is not removed (the age, token and identity come from one file)', () => {
    counter += 1;
    const dir = join(TMP, `lock-${counter}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'list.json');
    const lock = `${path}.lock`;
    writeFileSync(lock, 'holder-token');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    let ran = false;
    // inside the callback the lock file is the holder's own again: a second contender must not take it over, however old it looked
    const first = L.withFileLock(path, () => { ran = true; }, baseEnv(join(dir, 'logs')), 60_000);
    expect(first).toBe(true);
    expect(ran).toBe(true);
    // a fresh lock of another holder is waited for, not broken, and stays as it was
    writeFileSync(lock, 'live-holder');
    const started = Date.now();
    expect(L.withFileLock(path, () => { ran = 'again'; }, baseEnv(join(dir, 'logs')), 60_000)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(ran).toBe(true);
    expect(readFileSync(lock, 'utf8')).toBe('live-holder');
  }, TOTAL_MS);

  it('a holder that lost its lock does not remove the lock of the one who has it now', () => {
    counter += 1;
    const dir = join(TMP, `lock-${counter}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'list.json');
    const lock = `${path}.lock`;
    const env = baseEnv(join(dir, 'logs'));
    const ok = L.withFileLock(path, (owned) => {
      expect(owned()).toBe(true);
      rmSync(lock);
      writeFileSync(lock, 'new-holder'); // taken over as stale by another hook while this one was slow
      expect(owned()).toBe(false);
    }, env, 60_000);
    expect(ok).toBe(true);
    expect(readFileSync(lock, 'utf8')).toBe('new-holder');
    expect(readdirSync(dir).filter((n) => n.endsWith('.moved'))).toEqual([]);
  });

  it('a hook that finds the lock another hook took does not move it aside, so a third hook cannot take the free path', async () => {
    counter += 1;
    const dir = join(TMP, `lock-${counter}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'list.json');
    const lock = `${path}.lock`;
    const log = join(dir, 'log.txt');
    writeFileSync(log, '');
    writeFileSync(lock, 'dead-holder');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const env = baseEnv(join(dir, 'logs'));
    const files = (name) => join(dir, name);
    // A looked at the old lock and is held. B breaks it, takes its own and stays inside until A is done. A goes on: it must leave the
    // lock of B where it is. If it moves it aside it is held there with the path free, and C, a third hook, takes the path.
    const a = startChild(dir, { kind: 'lock', path, log, label: 'A', staleMs: 60_000, done: files('a-done') }, { kind: 'lock-observed+after-lock-rename', mark: files('a-paused'), go: files('a-go') }, env);
    const b = startChild(dir, { kind: 'lock', path, log, label: 'B', staleMs: 60_000, waitFor: files('b-go'), holdMark: files('b-holding'), holdUntil: files('a-done'), done: files('b-done') }, null, env);
    await waitUntil(files('a-paused.lock-observed'));
    writeFileSync(files('b-go'), '1');
    await waitUntil(files('b-holding'));
    writeFileSync(files('a-go.lock-observed'), '1');
    await waitUntilAny([files('a-done'), files('a-paused.after-lock-rename')]);
    const c = startChild(dir, { kind: 'lock', path, log, label: 'C', staleMs: 60_000, holdMark: files('c-holding'), holdUntil: files('a-done'), done: files('c-done') }, null, env);
    await waitUntil(files('c-holding'));
    writeFileSync(files('a-go.after-lock-rename'), '1');
    const results = await Promise.all([a.exited, b.exited, c.exited]);
    expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
    const lines = readFileSync(log, 'utf8');
    expect(overlapped(log), lines).toBe(false);
    expect(lines).toContain('A-result false');
    expect(lines).toContain('B-result true');
    expect(lines).toContain('C-result true');
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(dir).filter((n) => n.endsWith('.moved'))).toEqual([]);
  }, TOTAL_MS);

  it('a holder whose lock was taken over leaves the lock path alone when it ends, so another hook cannot take the free path', async () => {
    counter += 1;
    const dir = join(TMP, `lock-${counter}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'list.json');
    const lock = `${path}.lock`;
    const log = join(dir, 'log.txt');
    writeFileSync(log, '');
    const env = baseEnv(join(dir, 'logs'));
    const files = (name) => join(dir, name);
    // A takes the lock and another hook takes it over (the file is replaced by the lock of a live holder, which is not in the log). A ends.
    // If A moved that lock aside to look at it, it is held there with the path free and B, arriving now, takes the path.
    const a = startChild(dir, { kind: 'lock', path, log, label: 'A', staleMs: 60_000, takeover: files('a-took'), done: files('a-done') }, { kind: 'after-lock-rename', mark: files('a-paused'), go: files('a-go') }, env);
    await waitUntil(files('a-took'));
    await waitUntilAny([files('a-done'), files('a-paused')]);
    const b = startChild(dir, { kind: 'lock', path, log, label: 'B', staleMs: 60_000, holdMark: files('b-holding'), holdUntil: files('a-done'), done: files('b-done') }, null, env);
    await waitUntilAny([files('b-holding'), files('b-done')]);
    writeFileSync(files('a-go'), '1');
    const results = await Promise.all([a.exited, b.exited]);
    expect(results.map((r) => r.code)).toEqual([0, 0]);
    const lines = readFileSync(log, 'utf8');
    expect(lines).not.toContain('B-enter');
    expect(lines).toContain('B-result false');
    expect(readFileSync(lock, 'utf8')).toBe('new-holder');
    expect(readdirSync(dir).filter((n) => n.endsWith('.moved'))).toEqual([]);
  }, TOTAL_MS);

  it('a holder whose lock changes hands in the instant before its release moves the lock leaves the new holder the lock', async () => {
    counter += 1;
    const dir = join(TMP, `lock-${counter}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'list.json');
    const lock = `${path}.lock`;
    const log = join(dir, 'log.txt');
    writeFileSync(log, '');
    const env = baseEnv(join(dir, 'logs'));
    const files = (name) => join(dir, name);
    // A has read its own token in the lock file and is held right before it moves the file; the lock then changes hands.
    const a = startChild(dir, { kind: 'lock', path, log, label: 'A', staleMs: 60_000, done: files('a-done') }, { kind: 'before-lock-rename', mark: files('a-paused'), go: files('a-go') }, env);
    await waitUntil(files('a-paused'));
    rmSync(lock);
    writeFileSync(lock, 'new-holder');
    writeFileSync(files('a-go'), '1');
    expect((await a.exited).code).toBe(0);
    expect(readFileSync(lock, 'utf8')).toBe('new-holder');
    expect(readdirSync(dir).filter((n) => n.endsWith('.moved'))).toEqual([]);
  }, TOTAL_MS);
});

describe('task-list fold: an older fold does not overwrite a list another fold published', () => {
  it('the fold held before it publishes, its lock taken over and put back, finds the list changed and leaves it alone', async () => {
    counter += 1;
    const dir = join(TMP, `fold-${counter}`);
    mkdirSync(dir, { recursive: true });
    const logs = join(dir, 'logs');
    const env = baseEnv(logs);
    const listPath = join(logs, 'lists', 'race-session', 'main.json');
    const lock = `${listPath}.lock`;
    const files = (name) => join(dir, name);
    L.recordListCall(task('base', 1), env); // the list file exists: the fold under test reads it as its snapshot
    const b = startChild(dir, { kind: 'record', data: task('from-b', 2), done: files('b-done') }, { kind: 'before-publish', match: listPath, mark: files('b-paused'), go: files('b-go') }, env);
    await waitUntil(files('b-paused')); // B holds the lock, has folded its events from the list it read, and has not published
    const token = readFileSync(lock, 'utf8');
    rmSync(lock); // the lock is taken over (what a hook that misjudged B's lock as dead does) ...
    expect(L.recordListCall(task('from-parent', 3), env)).not.toBeNull(); // ... and the other fold publishes a newer list and removes its events
    writeFileSync(lock, token); // B's token is in the lock file again: its ownership check passes, only the list itself can tell it is older
    writeFileSync(files('b-go'), '1');
    const rb = await b.exited;
    expect(rb.code).toBe(0);
    const names = L.readList('race-session', 'main', env).items.map((x) => x.content).sort();
    expect(names).toEqual(['base', 'from-b', 'from-parent']);
  }, TOTAL_MS);
});

describe('task-list events: a hook held up before its event is visible', () => {
  const todo = (content) => ({ session_id: 'race-session', tool_name: 'TodoWrite', tool_input: { todos: [{ content, status: 'pending' }] }, tool_use_id: `toolu_${content}` });

  it('a TodoWrite held between its call time and its publication does not put its older list back over the one a later call folded meanwhile', async () => {
    counter += 1;
    const dir = join(TMP, `late-${counter}`);
    mkdirSync(dir, { recursive: true });
    const logs = join(dir, 'logs');
    const env = baseEnv(logs);
    const files = (name) => join(dir, name);
    const a = startChild(dir, { kind: 'record', data: todo('older list'), done: files('a-done') }, { kind: 'before-event-publish', mark: files('a-paused'), go: files('a-go') }, env);
    await waitUntil(files('a-paused')); // A has its call time and its event written, and nothing is visible yet
    await new Promise((done) => setTimeout(done, 30)); // the later call has a later time
    expect(L.recordListCall(todo('newer list'), env)).not.toBeNull(); // the later call folds, publishes and removes its event
    expect(L.readList('race-session', 'main', env).items.map((x) => x.content)).toEqual(['newer list']);
    writeFileSync(files('a-go'), '1');
    expect((await a.exited).code).toBe(0);
    const record = JSON.parse(readFileSync(join(logs, 'lists', 'race-session', 'main.json'), 'utf8'));
    expect(record.items.map((x) => x.content)).toEqual(['newer list']);
    expect(L.readList('race-session', 'main', env).items.map((x) => x.content)).toEqual(['newer list']);
    expect(readdirSync(join(logs, 'lists', 'race-session', 'main.events'))).toHaveLength(2); // both calls are in the window: the list is the replay of the two
  }, TOTAL_MS);

  it('the same held-up call, when it only changes part of the list, is applied: two TaskCreate calls sent together both stay', async () => {
    counter += 1;
    const dir = join(TMP, `late-${counter}`);
    mkdirSync(dir, { recursive: true });
    const logs = join(dir, 'logs');
    const env = baseEnv(logs);
    const files = (name) => join(dir, name);
    const a = startChild(dir, { kind: 'record', data: task('held up', 1), done: files('a-done') }, { kind: 'before-event-publish', mark: files('a-paused'), go: files('a-go') }, env);
    await waitUntil(files('a-paused'));
    await new Promise((done) => setTimeout(done, 30));
    expect(L.recordListCall(task('later', 2), env)).not.toBeNull();
    writeFileSync(files('a-go'), '1');
    expect((await a.exited).code).toBe(0);
    expect(L.readList('race-session', 'main', env).items.map((x) => x.content).sort()).toEqual(['held up', 'later']);
  }, TOTAL_MS);
});

describe('task-list sweep: a hook writes while the sweep judges the session directory', () => {
  const DAY = 24 * 3600 * 1000;
  // Every file and folder of the session looks eight days old (the retention is seven).
  const ageTree = (root, ms) => {
    const when = new Date(Date.now() - ms);
    const walk = (path) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(path, entry.name));
        utimesSync(join(path, entry.name), when, when);
      }
      utimesSync(path, when, when);
    };
    walk(root);
  };

  // 'race.sweeping' is a valid session id that ends like the hidden name of a tree the sweep moved aside: it is a session, not a leftover
  it.each(['race-session', 'race.sweeping'])('a session (%s) read as old by the sweep but written by a hook before the removal keeps what the hook wrote', async (sessionId) => {
    counter += 1;
    const dir = join(TMP, `sweep-${counter}`);
    mkdirSync(dir, { recursive: true });
    const logs = join(dir, 'logs');
    const env = baseEnv(logs);
    const session = join(logs, 'lists', sessionId);
    const files = (name) => join(dir, name);
    L.recordListCall(task('base', 1, sessionId), env);
    ageTree(session, 8 * DAY);
    rmSync(join(logs, 'lists', '.sweep'), { force: true }); // the sweep of the child is due
    const s = startChild(dir, { kind: 'sweep', done: files('s-done') }, { kind: 'sweep-observed', match: session, mark: files('s-paused'), go: files('s-go') }, env);
    await waitUntil(files('s-paused')); // the sweep has read the directory as old and has not moved it yet
    expect(L.recordListCall(task('from-hook', 2, sessionId), env)).not.toBeNull();
    writeFileSync(files('s-go'), '1');
    const rs = await s.exited;
    expect(rs.code).toBe(0);
    expect(existsSync(session)).toBe(true);
    const names = (L.readList(sessionId, 'main', env)?.items ?? []).map((x) => x.content).sort();
    expect(names).toEqual(['base', 'from-hook']);
    expect(readdirSync(join(logs, 'lists')).filter((n) => n.startsWith('.') && n.endsWith('.sweeping'))).toEqual([]);
  }, TOTAL_MS);

  it('a session nobody wrote to for eight days is removed with everything in it', async () => {
    counter += 1;
    const dir = join(TMP, `sweep-${counter}`);
    mkdirSync(dir, { recursive: true });
    const logs = join(dir, 'logs');
    const env = baseEnv(logs);
    const session = join(logs, 'lists', 'race-session');
    L.recordListCall(task('base', 1), env);
    ageTree(session, 8 * DAY);
    rmSync(join(logs, 'lists', '.sweep'), { force: true });
    const s = startChild(dir, { kind: 'sweep', done: join(dir, 's-done') }, null, env);
    expect((await s.exited).code).toBe(0);
    expect(existsSync(session)).toBe(false);
    expect(readdirSync(join(logs, 'lists')).filter((n) => n.endsWith('.sweeping'))).toEqual([]);
  }, TOTAL_MS);

  // The sweep moved an old session away and, judging the moved tree, found an event a hook had published into it (so the tree is in use and goes
  // back), but another hook made the session directory again in between: the rename back fails. The event published into the moved tree must
  // stay reachable from the live path (a reader of the live path scans nothing under the hidden name).
  it.each([
    ['the other hook folded its call', 'fold', ['base', 'fresh', 'second']],
    ['the other hook only published its event', 'publish', ['base', 'fresh', 'second']],
  ])('a session the sweep moved away and found in use goes back into the directory another hook made meanwhile, with the event published into it (%s)', async (_what, how, expected) => {
    counter += 1;
    const dir = join(TMP, `sweep-${counter}`);
    mkdirSync(dir, { recursive: true });
    const logs = join(dir, 'logs');
    const env = baseEnv(logs);
    const session = join(logs, 'lists', 'race-session');
    const files = (name) => join(dir, name);
    const publish = (subject, id, tick) => {
      const events = join(session, 'main.events');
      mkdirSync(events, { recursive: true });
      const event = { ts: new Date().toISOString(), pid: 1000 + tick, id: `${tick}`.padStart(8, '0'), session_id: 'race-session', tool_name: 'TaskCreate', tool_input: { subject }, task_id: String(id), agent_type: null, tool_use_id: null, prompt_id: null };
      writeFileSync(join(events, `${String(Date.now()).padStart(13, '0')}-${String(tick).padStart(20, '0')}-${event.pid}-${event.id}.json`), JSON.stringify(event));
    };
    L.recordListCall(task('base', 1), env);
    ageTree(session, 8 * DAY);
    publish('fresh', 2, 100); // a hook published this just before the sweep: the folder of the events is the only thing of the session that is not old
    rmSync(join(logs, 'lists', '.sweep'), { force: true });
    const s = startChild(dir, { kind: 'sweep', done: files('s-done') }, { kind: 'after-sweep-move', mark: files('s-paused'), go: files('s-go') }, env);
    await waitUntil(files('s-paused')); // the tree is under its hidden name; the session path is free and nothing is judged yet
    expect(existsSync(session)).toBe(false);
    if (how === 'fold') expect(L.recordListCall(task('second', 3), env)).not.toBeNull();
    else publish('second', 3, 200);
    writeFileSync(files('s-go'), '1');
    const rs = await s.exited;
    expect(rs.code, rs.stderr).toBe(0);
    expect(readdirSync(join(logs, 'lists')).filter((n) => n.endsWith('.sweeping'))).toEqual([]);
    // the list of the moved tree does not replace the live directory's own list: the live list had settled nothing, so the moved list is the base
    // the live events are replayed on, and the calls that made the moved list are events in their window that arrive with the merge: nothing is
    // set aside, and the list holds the calls of both trees
    const rows = existsSync(join(logs, 'task-list.jsonl')) ? readFileSync(join(logs, 'task-list.jsonl'), 'utf8') : '';
    expect(rows.includes('moved_list_set_aside')).toBe(false);
    expect(existsSync(join(session, 'main.json.moved'))).toBe(false);
    expect(L.readList('race-session', 'main', env).items.map((x) => x.content).sort()).toEqual(expected);
    L.syncList('race-session', 'main', env);
    expect(JSON.parse(readFileSync(join(session, 'main.json'), 'utf8')).items.map((x) => x.content).sort()).toEqual(expected);
    expect(readdirSync(join(session, 'main.events'))).toHaveLength(3); // the call of the first list, the one published into it, the one of the other hook: all in the window
    expect(readdirSync(join(session, '_task')).sort()).toEqual(how === 'fold' ? ['1.json', '3.json'] : ['1.json']);
  }, TOTAL_MS);

  // An older fold, held after it began to publish, meets a session directory that the sweep moved away and another hook made again with a newer
  // list. The sweep is held twice (after it read the age of the session, before the fold takes its lock, which would make the directory new; and
  // after it moved the directory away); the fold is held at `fold`; the other hook runs in this process while the path is free.
  describe('an older fold held while the sweep moves its session directory away and another hook makes the directory again', () => {
    const run = async (fold) => {
      counter += 1;
      const dir = join(TMP, `sweep-${counter}`);
      mkdirSync(dir, { recursive: true });
      const logs = join(dir, 'logs');
      const env = baseEnv(logs);
      const lists = join(logs, 'lists');
      const session = join(lists, 'race-session');
      const files = (name) => join(dir, name);
      mkdirSync(join(session, '_task'), { recursive: true });
      writeFileSync(join(session, '_task', '1.json'), JSON.stringify({ agent: 'main' }));
      ageTree(session, 8 * DAY); // an old session: no list, nothing the folds start from
      rmSync(join(lists, '.sweep'), { force: true }); // the sweep of the child is due
      const s = startChild(dir, { kind: 'sweep', done: files('s-done') }, { kind: 'sweep-observed+after-sweep-move', match: session, mark: files('s-paused'), go: files('s-go') }, env);
      await waitUntil(files('s-paused.sweep-observed')); // the sweep has read the directory as old and has not moved it yet
      const p = startChild(dir, { kind: 'record', data: task('from the older fold', 2), done: files('p-done') }, { kind: fold, match: join(session, 'main.json'), mark: files('p-paused'), go: files('p-go') }, env);
      await waitUntil(files('p-paused')); // the fold holds its lock in the directory the sweep is about to move
      writeFileSync(files('s-go.sweep-observed'), '1');
      await waitUntil(files('s-paused.after-sweep-move')); // the directory is under its hidden name, the path is free
      expect(existsSync(session)).toBe(false);
      expect(L.recordListCall(task('from the other hook', 3), env)).not.toBeNull(); // makes the directory again, folds, publishes, removes its event
      expect(L.readList('race-session', 'main', env).items.map((x) => x.content)).toEqual(['from the other hook']);
      // the fold held after it published removes its events after the merge brought them into the new directory; the others finish first
      const release = async (child, name) => {
        writeFileSync(files(name), '1');
        const r = await child.exited;
        expect(r.code, r.stderr).toBe(0);
      };
      if (fold === 'after-list-publish') {
        await release(s, 's-go.after-sweep-move');
        await release(p, 'p-go');
      } else {
        await release(p, 'p-go');
        await release(s, 's-go.after-sweep-move');
      }
      return { env, session, lists };
    };
    // the call of the older fold is an event in the moved tree; the merge brings it into the new directory, where a fold takes it
    const finish = ({ env, session, lists }) => {
      L.syncList('race-session', 'main', env);
      expect(JSON.parse(readFileSync(join(session, 'main.json'), 'utf8')).items.map((x) => x.content).sort()).toEqual(['from the older fold', 'from the other hook']);
      expect(readdirSync(join(session, 'main.events'))).toHaveLength(2); // the call of the older fold and the one of the other hook stay in the window
      expect(readdirSync(lists).filter((n) => n.endsWith('.sweeping'))).toEqual([]);
      expect(readdirSync(session).filter((n) => n.endsWith('.tmp') || n.includes('.tmp.'))).toEqual([]); // no temporary file of the older fold in the live directory
    };

    it('held before it creates the temporary file of the list: the newer list is not overwritten, and the older call is folded in the new directory', async () => {
      finish(await run('before-list-temp'));
    }, TOTAL_MS);

    it('held after it wrote the temporary file and checked, before the rename: the rename finds no source, the newer list stays and no temporary file reaches the new directory', async () => {
      finish(await run('before-list-rename'));
    }, TOTAL_MS);

    it('held after it published the list and before it removes the events: the events the merge brought into the new directory are not removed', async () => {
      finish(await run('after-list-publish'));
    }, TOTAL_MS);
  });

  // Two sweeps overlap: one merges a hidden tree into the live directory under the lock of the live list, and the live directory is moved away
  // meanwhile by the other; a hook makes it again and folds a newer call. The merge judged the events against the record it read before, which is
  // not the live record any more: an older event linked now would be applied last by the next fold, over the newer list. The merge keeps the tree.
  it('a merge of a hidden tree whose lock on the live list was lost links no event: the tree stays hidden, and a later sweep merges it against the newer list', async () => {
    counter += 1;
    const dir = join(TMP, `sweep-${counter}`);
    mkdirSync(dir, { recursive: true });
    const logs = join(dir, 'logs');
    const env = baseEnv(logs);
    const lists = join(logs, 'lists');
    const session = join(lists, 'race-session');
    const hidden = join(lists, '.race-session.0123456789ab.sweeping');
    const files = (name) => join(dir, name);
    const at = Date.now() - 120_000;
    const name = `${at}-${'7'.padStart(20, '0')}-11-aaaaaaaa.json`;
    const event = { ts: new Date(at).toISOString(), pid: 11, id: 'aaaaaaaa', session_id: 'race-session', agent_type: null, tool_use_id: null, prompt_id: null, tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Old list', status: 'pending' }] } };
    mkdirSync(join(hidden, 'main.events'), { recursive: true });
    writeFileSync(join(hidden, 'main.events', name), JSON.stringify(event));
    mkdirSync(join(session, '_task'), { recursive: true }); // the directory a hook made again: not empty, so the hidden tree is merged and not renamed over it
    writeFileSync(join(session, '_task', '9.json'), JSON.stringify({ agent: 'main' }));
    rmSync(join(lists, '.sweep'), { force: true }); // the sweep of the child is due
    const s = startChild(dir, { kind: 'sweep', done: files('s-done') }, { kind: 'before-moved-event-check', mark: files('s-paused'), go: files('s-go') }, env);
    await waitUntil(files('s-paused')); // the merge holds the lock of the live list and has read the live record (none)
    rmSync(join(session, 'main.json.lock'), { force: true }); // its lock is gone: the directory it took the lock in was moved away, and this is the directory made again
    const newer = { session_id: 'race-session', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Newer list', status: 'pending' }] }, tool_use_id: 'toolu_n1' };
    expect(L.recordListCall(newer, env)).not.toBeNull();
    writeFileSync(files('s-go'), '1');
    const rs = await s.exited;
    expect(rs.code, rs.stderr).toBe(0);
    expect(existsSync(hidden)).toBe(true); // kept: the merge was not complete
    expect(existsSync(join(hidden, 'main.events', name))).toBe(true); // the event was neither linked nor dropped
    expect(readdirSync(join(session, 'main.events')).some((n) => n === name)).toBe(false);
    L.syncList('race-session', 'main', env);
    expect(L.readList('race-session', 'main', env).items.map((x) => x.content)).toEqual(['Newer list']);
    rmSync(join(lists, '.sweep'), { force: true });
    L.sweep(env, Date.now()); // the next sweep merges the tree against the record that is there now: the old call is behind it and is dropped
    expect(existsSync(hidden)).toBe(false);
    expect(L.readList('race-session', 'main', env).items.map((x) => x.content)).toEqual(['Newer list']);
  }, TOTAL_MS);

  // The writer made its directory (a no-op for an old session) and is held before its first file; the sweep, run to its end meanwhile, reads
  // the session as idle, moves it away and removes it. The call of the writer is the newest thing the session has: it must be saved.
  it.each([
    ['TodoWrite: the temporary file of the event', { session_id: 'race-session', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'from the writer', status: 'pending' }] }, tool_use_id: 'toolu_w1' }, ['from the writer']],
    ['TaskCreate: the claim of the task number, then the event', task('from the writer', 2), ['from the writer']],
  ])('a writer held after its mkdir, while the sweep removes the idle session, saves its call (%s)', async (_what, data, expected) => {
    counter += 1;
    const dir = join(TMP, `sweep-${counter}`);
    mkdirSync(dir, { recursive: true });
    const logs = join(dir, 'logs');
    const env = baseEnv(logs);
    const session = join(logs, 'lists', 'race-session');
    const files = (name) => join(dir, name);
    L.recordListCall(task('base', 1), env);
    ageTree(session, 8 * DAY);
    rmSync(join(logs, 'lists', '.sweep'), { force: true }); // the sweep is due
    const w = startChild(dir, { kind: 'record', data, done: files('w-done') }, { kind: 'before-session-write', mark: files('w-paused'), go: files('w-go') }, env);
    await waitUntil(files('w-paused')); // the directory of the writer exists; no file of the call does
    L.sweep(env, Date.now());
    expect(existsSync(session)).toBe(false); // the old tree is gone, with the folder the writer had made
    writeFileSync(files('w-go'), '1');
    const rw = await w.exited;
    expect(rw.code, rw.stderr).toBe(0);
    const record = JSON.parse(readFileSync(join(session, 'main.json'), 'utf8'));
    expect(record.items.map((x) => x.content)).toEqual(expected);
    expect(readdirSync(join(session, 'main.events'))).toHaveLength(1); // the call of the writer, in the window
    if (data.tool_name === 'TaskCreate') expect(JSON.parse(readFileSync(join(session, '_task', '2.json'), 'utf8'))).toEqual({ agent: 'main' });
    const rows = existsSync(join(logs, 'task-list.jsonl')) ? readFileSync(join(logs, 'task-list.jsonl'), 'utf8') : '';
    expect(rows).not.toContain('event_write_failed');
    expect(readdirSync(join(logs, 'lists')).filter((n) => n.endsWith('.sweeping'))).toEqual([]);
  }, TOTAL_MS);
});

describe('task-list writes: a write that stores fewer bytes than it was given', () => {
  const run = async (data, most) => {
    counter += 1;
    const dir = join(TMP, `short-${counter}`);
    mkdirSync(dir, { recursive: true });
    const logs = join(dir, 'logs');
    const env = baseEnv(logs);
    const files = (name) => join(dir, name);
    const w = startChild(dir, { kind: 'record', data, done: files('w-done') }, { kind: 'short-writes', match: String(most), mark: files('w-paused'), go: files('w-go') }, env);
    const result = await w.exited;
    expect(result.code, result.stderr).toBe(0);
    const session = join(logs, 'lists', 'race-session');
    const rows = existsSync(join(logs, 'task-list.jsonl')) ? readFileSync(join(logs, 'task-list.jsonl'), 'utf8') : '';
    return { session, rows };
  };

  // Everything the call writes goes through writeSync: the token of the lock, the claim of the task number and the event. Each is checked in
  // the file it ends in: a lock token cut short only stops the fold from publishing, and a claim is never read back by the library.
  it.each([
    ['TodoWrite', { session_id: 'race-session', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'from the writer', status: 'pending' }] }, tool_use_id: 'toolu_s1' }, false],
    ['TaskCreate', task('from the writer', 2), true],
  ])('a %s call written five bytes at a time is saved whole', async (_name, data, claims) => {
    const { session, rows } = await run(data, 5);
    const record = JSON.parse(readFileSync(join(session, 'main.json'), 'utf8'));
    expect(record.items.map((x) => x.content)).toEqual(['from the writer']);
    expect(readdirSync(join(session, 'main.events'))).toHaveLength(1); // the call, in the window
    if (claims) expect(JSON.parse(readFileSync(join(session, '_task', '2.json'), 'utf8'))).toEqual({ agent: 'main' });
    expect(rows).not.toMatch(/event_write_failed|lock_error|write_failed/);
  }, TOTAL_MS);

  it('a write that stores nothing ends the call at once: a log row, no event, no temporary file left', async () => {
    const { session, rows } = await run({ session_id: 'race-session', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'never stored', status: 'pending' }] }, tool_use_id: 'toolu_s2' }, 0);
    expect(rows).toContain('event_write_failed');
    expect(readdirSync(join(session, 'main.events'))).toEqual([]);
    expect(existsSync(join(session, 'main.json'))).toBe(false);
  }, TOTAL_MS);
});
