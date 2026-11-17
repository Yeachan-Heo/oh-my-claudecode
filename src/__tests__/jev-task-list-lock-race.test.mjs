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

// Wraps `fs` before the library is loaded. PAUSE_KIND:
//   lock-observed   after the first look at a file whose name ends in ".lock" (a stat of the path, or a stat of a handle opened on it for reading)
//   before-lock-rename  before a ".lock" file is renamed (the removal of a lock: the last moment before the file that is moved is fixed)
//   before-publish  before the fold of PAUSE_MATCH (a list file) decides or starts to publish: the second lstat of that path (the generation check
//                   of the fold) or, when there is none, the creation of the temporary file of the atomic write
// The process writes PAUSE_MARK and waits until PAUSE_GO exists.
const PRELOAD = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const { PAUSE_KIND, PAUSE_MATCH, PAUSE_MARK, PAUSE_GO } = process.env;
let fired = false;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const hold = () => {
  if (fired) return;
  fired = true;
  fs.writeFileSync(PAUSE_MARK, String(process.pid));
  for (let i = 0; i < 3000 && !fs.existsSync(PAUSE_GO); i += 1) Atomics.wait(sleeper, 0, 0, 10);
};
const isLock = (p) => typeof p === 'string' && p.endsWith('.lock');
if (PAUSE_KIND === 'lock-observed') {
  const lockFds = new Set();
  const open = fs.openSync;
  fs.openSync = (p, flags, ...rest) => { const fd = open(p, flags, ...rest); if (isLock(p) && (flags === undefined || flags === 'r')) lockFds.add(fd); return fd; };
  for (const name of ['statSync', 'lstatSync']) {
    const real = fs[name];
    fs[name] = (p, ...rest) => { const r = real(p, ...rest); if (isLock(p)) hold(); return r; };
  }
  const fstat = fs.fstatSync;
  fs.fstatSync = (fd, ...rest) => { const r = fstat(fd, ...rest); if (lockFds.has(fd)) hold(); return r; };
}
if (PAUSE_KIND === 'before-lock-rename') {
  const rename = fs.renameSync;
  fs.renameSync = (from, to, ...rest) => { if (isLock(from)) hold(); return rename(from, to, ...rest); };
}
if (PAUSE_KIND === 'before-publish') {
  let looks = 0;
  const lstat = fs.lstatSync;
  fs.lstatSync = (p, ...rest) => { if (p === PAUSE_MATCH && (looks += 1) === 2) hold(); return lstat(p, ...rest); };
  const open = fs.openSync;
  fs.openSync = (p, flags, ...rest) => { if (flags === 'wx' && typeof p === 'string' && p.startsWith(PAUSE_MATCH.replace(/[^/]*$/, '.')) && /\\.tmp\\.[0-9a-f-]+$/.test(p)) hold(); return open(p, flags, ...rest); };
}
syncBuiltinESMExports();
`;

// The process under test: waits for CHILD_WAIT, then runs the case named by CHILD_CASE and writes CHILD_DONE.
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
    if (cfg.holdUntil) { fs.writeFileSync(cfg.holdMark, '1'); waitFor(cfg.holdUntil, 8000); } else Atomics.wait(sleeper, 0, 0, 300);
    fs.appendFileSync(cfg.log, cfg.label + '-exit\\n');
  }, process.env, cfg.staleMs);
  fs.appendFileSync(cfg.log, cfg.label + '-result ' + ok + '\\n');
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
});

describe('task-list fold: an older fold does not overwrite a list another fold published', () => {
  const task = (subject, id) => ({
    session_id: 'race-session', tool_name: 'TaskCreate', tool_input: { subject }, tool_response: `Task #${id} created successfully: ${subject}`, tool_use_id: `toolu_${id}`,
  });

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
