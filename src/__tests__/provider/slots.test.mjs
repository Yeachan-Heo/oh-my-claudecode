/* global process, URL, setTimeout */
// Session slots: limit, stale owners, waiting starts, release rules and parallel starts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, writeProfile } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const LIB = fileURLToPath(new URL('../../../scripts/provider/lib/', import.meta.url));
const { acquireSlot, releaseSlot } = require(join(LIB, 'slots.cjs'));
const { loadProfile } = require(join(LIB, 'profile.cjs'));

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

describe.skipIf(process.platform === 'win32')('provider session slots', () => {
  let tmp;
  let foreign; // live foreign process: its pid marks slots as owned by someone else
  beforeAll(() => {
    tmp = makeTmp('provider-slots-');
    foreign = spawn('sleep', ['300'], { stdio: 'ignore' });
  });
  afterAll(() => {
    try { foreign.kill('SIGKILL'); } catch { /* already gone */ }
    tmp.cleanup();
  });

  // Profile with a state directory of its own; the slot directory is <stateDir>/slots.
  const fixture = (name, options = {}, { tuned = false } = {}) => {
    const dir = join(tmp.dir, name);
    mkdirSync(dir, { recursive: true });
    const { env } = writeProfile(dir, { limits: options }, { tuned });
    const profile = loadProfile(env).profile;
    const slots = join(dir, 'state', 'slots');
    const slotFiles = () => (existsSync(slots) ? readdirSync(slots).filter((f) => /^slot-/.test(f)) : []);
    return { env, profile, slots, slotFiles };
  };

  it('(17) acquireSlot: own slot plus a live foreign slot at limit 2; a child refuses at once with wait 0; bad values throw; releaseSlot removes only own slot', () => {
    const f = fixture('s17', { maxSessions: 2, slotWaitMs: 0 });
    const own = acquireSlot(f.profile, f.env);
    expect(own.ok && own.waitedMs < 100, JSON.stringify(own)).toBe(true);
    const foreignFile = join(f.slots, 'slot-foreign.json');
    writeFileSync(foreignFile, JSON.stringify({ pid: foreign.pid, ts: Date.now() }));
    expect(f.slotFiles().length).toBe(2);
    const third = spawnSync(process.execPath, ['-e', `const p=require(${JSON.stringify(join(LIB, 'profile.cjs'))}); const s=require(${JSON.stringify(join(LIB, 'slots.cjs'))}); console.log(JSON.stringify(s.acquireSlot(p.loadProfile(process.env).profile, process.env)));`], { encoding: 'utf8', env: f.env });
    const answer = JSON.parse(third.stdout);
    expect(third.status === 0 && answer.ok === false && /no free provider session slot/.test(answer.reason), JSON.stringify({ s: third.status, o: third.stdout.slice(0, 200) })).toBe(true);
    expect(releaseSlot(own.file)).toBe(true);
    expect(existsSync(own.file)).toBe(false);
    expect(releaseSlot(foreignFile)).toBe(false);
    expect(existsSync(foreignFile)).toBe(true);
    expect(releaseSlot(join(f.slots, 'missing.json'))).toBe(false);
    for (const bad of [0, -1, 4.5, 99999, Number.NaN]) {
      expect(throws(() => acquireSlot({ limits: { maxSessions: bad, slotWaitMs: 0 } }, f.env)), `maxSessions=${bad}`).toBe(true);
    }
    expect(throws(() => acquireSlot({ limits: { maxSessions: 2, slotWaitMs: -5 } }, f.env)), 'slotWaitMs=-5').toBe(true);
    unlinkSync(foreignFile);
    expect(f.slotFiles().length).toBe(0);
  }, 60_000);

  it('(17b) default limit 16 (tuned fixture): 15 live foreign slots plus own = 16; the next start is refused with the limit in the reason; slots removed afterwards', () => {
    const f = fixture('s17b', {}, { tuned: true });
    const foreignFiles = [];
    for (let i = 0; i < 15; i += 1) {
      const p = join(f.slots, `slot-foreign-${i}.json`);
      mkdirSync(f.slots, { recursive: true });
      writeFileSync(p, JSON.stringify({ pid: foreign.pid, ts: Date.now() }));
      foreignFiles.push(p);
    }
    const s = acquireSlot(f.profile, f.env);
    expect(s.ok && f.slotFiles().length === 16, JSON.stringify({ ok: s.ok, live: f.slotFiles().length })).toBe(true);
    // A second start in this same process would take its own slot for a stale one (same pid), so the refusal runs in a child.
    const refusal = spawnSync(process.execPath, ['-e', `const p=require(${JSON.stringify(join(LIB, 'profile.cjs'))}); const s=require(${JSON.stringify(join(LIB, 'slots.cjs'))}); console.log(JSON.stringify(s.acquireSlot(p.loadProfile(process.env).profile, process.env)));`], { encoding: 'utf8', env: { ...f.env, OMC_PROVIDER_SLOT_WAIT_MS: '0' } });
    const result = JSON.parse(refusal.stdout);
    expect(refusal.status === 0 && result.ok === false && /limit 16/.test(result.reason), JSON.stringify({ s: refusal.status, o: refusal.stdout.slice(0, 200) })).toBe(true);
    releaseSlot(s.file);
    for (const p of foreignFiles) unlinkSync(p);
    expect(f.slotFiles().length).toBe(0);
  }, 60_000);

  it('(18) dead owner: a slot of an exited process is removed while a slot is taken (1 of 1)', () => {
    const f = fixture('s18', { maxSessions: 1, slotWaitMs: 0 });
    mkdirSync(f.slots, { recursive: true });
    const dead = spawnSync('true');
    const file = join(f.slots, `slot-dead-${Math.random().toString(36).slice(2, 8)}.json`);
    writeFileSync(file, JSON.stringify({ pid: dead.pid, ts: Date.now() }));
    expect(existsSync(file)).toBe(true);
    const s = acquireSlot(f.profile, f.env);
    expect(s.ok && !existsSync(file) && f.slotFiles().length === 1, JSON.stringify({ ok: s.ok, live: f.slotFiles().length })).toBe(true);
    releaseSlot(s.file);
  }, 60_000);

  it('(19) start above the limit waits: a child waiting for a live foreign slot takes it after the slot is removed, with waitedMs > 0', async () => {
    const f = fixture('s19', { maxSessions: 1, slotWaitMs: 15000 });
    mkdirSync(f.slots, { recursive: true });
    writeFileSync(join(f.slots, 'slot-foreign.json'), JSON.stringify({ pid: foreign.pid, ts: Date.now() }));
    const outFile = join(f.slots, '..', 'waiting-result.json');
    const child = spawn(process.execPath, ['-e', `const p=require(${JSON.stringify(join(LIB, 'profile.cjs'))}); const s=require(${JSON.stringify(join(LIB, 'slots.cjs'))}); const r=s.acquireSlot(p.loadProfile(process.env).profile, process.env); require('node:fs').writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(r)); if (r.ok) s.releaseSlot(r.file);`], { env: f.env, stdio: 'ignore' });
    await wait(500);
    expect(existsSync(join(f.slots, 'slot-foreign.json')), 'foreign slot disappeared before its removal').toBe(true);
    unlinkSync(join(f.slots, 'slot-foreign.json'));
    await new Promise((done) => child.on('close', done));
    const s = JSON.parse(readFileSync(outFile, 'utf8'));
    expect(s.ok === true && s.waitedMs >= 200, JSON.stringify(s)).toBe(true);
    expect(f.slotFiles().length).toBe(0);
  }, 60_000);

  it('(20) ten parallel starts with limit 4: exactly 4 run at once, the other 6 wait; slots are released afterwards', async () => {
    const f = fixture('s20', { maxSessions: 4, slotWaitMs: 20000 });
    const work = join(f.slots, '..', 'work-20');
    mkdirSync(work, { recursive: true });
    const worker = join(work, 'worker.cjs');
    writeFileSync(worker, `const p=require(${JSON.stringify(join(LIB, 'profile.cjs'))}); const s=require(${JSON.stringify(join(LIB, 'slots.cjs'))});
const i=process.argv[2]; const r=s.acquireSlot(p.loadProfile(process.env).profile, process.env);
if (!r.ok) process.exit(3);
require('node:fs').writeFileSync(${JSON.stringify(work)}+'/start-'+i, String(Date.now()));
setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(work)}+'/end-'+i, String(Date.now())); s.releaseSlot(r.file); }, 1200);`);
    const runs = Array.from({ length: 10 }, (_, i) => i + 1).map((i) => new Promise((done) => {
      const child = spawn(process.execPath, [worker, String(i)], { env: f.env, stdio: 'ignore' });
      child.on('close', (code) => done({ i, code }));
    }));
    const finished = await Promise.all(runs);
    expect(finished.every((r) => r.code === 0), JSON.stringify(finished.map((r) => r.code))).toBe(true);
    const times = readdirSync(work).flatMap((name) => {
      const m = /^start-(\d+)$/.exec(name);
      if (!m) return [];
      return [{ start: Number(readFileSync(join(work, name), 'utf8')), end: Number(readFileSync(join(work, `end-${m[1]}`), 'utf8')) }];
    });
    expect(times.length).toBe(10);
    const events = times.flatMap((c) => [{ t: c.start, delta: 1 }, { t: c.end, delta: -1 }]).sort((a, b) => a.t - b.t || a.delta - b.delta);
    let running = 0;
    let maximum = 0;
    for (const e of events) { running += e.delta; if (running > maximum) maximum = running; }
    const firstEnd = Math.min(...times.map((c) => c.end));
    const firstWave = times.filter((c) => c.start < firstEnd).length;
    expect(maximum, 'maximum overlap').toBe(4);
    expect(firstWave, 'starts in the first wave').toBe(4);
    expect(f.slotFiles().length).toBe(0);
  }, 90_000);
});
