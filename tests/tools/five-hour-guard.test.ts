// Behaviour tests of the five-hour limit guard (tools/five-hour-guard/five-hour-guard.py), its PreToolUse hook
// (five-hour-guard-hook.py) and the systemd unit template. Everything runs on a fake usage cache in a temporary directory
// (see five-hour-guard-support.ts); the guard runs with a 0.2 s tick and a 5 s heartbeat, the hook with a 0.1 s poll.
// The budgets of the waits are generous on purpose: the tests check what happens, not how fast.
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENV, CONFIG_DIR, HOME_DIR, GUARD, HOOK, UNIT, PYBIN, HAS_PYTHON3, cleanup, fixture, hookHeld, hookInput, hookPasses, now, pauseDoc,
  readJson, readText, runPyCode, runSync, sleep, spawnPy, spawnPyCode, startHook, waitFor, writeCache, writePause, type Fixture, type Proc,
} from './five-hour-guard-support.js';

afterAll(cleanup);

const HOUR_MS = 3600e3;
const MAX_RESET_AHEAD_MS = 5 * HOUR_MS + 900e3; // the guard believes no reset time further ahead than a window plus 15 minutes
// a pid that belonged to a process that has ended
function deadPid(): number {
  for (let i = 0; i < 20; i++) {
    const pid = Number(spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim());
    try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return pid; }
  }
  throw new Error('no dead pid found');
}
// the wall clock steps back an hour as soon as the flag file exists; the guard runs inside this wrapper
const CLOCK_STEP_DRIVER = [
  'import os, runpy, sys, time',
  'real, flag = time.time, sys.argv[1]',
  'time.time = lambda: real() - (3600 if os.path.exists(flag) else 0)',
  'sys.argv = sys.argv[2:]',
  "runpy.run_path(sys.argv[0], run_name='__main__')",
].join('\n');
// the hook with --poll 0 for three seconds, counted from its own hold-start line (a slow start under load must not shorten the hold); prints the processor time the hook used
const HOOK_CPU_DRIVER = [
  'import json, os, subprocess, sys, time',
  'p = subprocess.Popen([sys.executable, "-I", sys.argv[1], "--pause-file", sys.argv[2], "--log", sys.argv[3], "--poll", "0"], stdin=subprocess.PIPE)',
  'p.stdin.write(b\'{"session_id": "cpu00001", "tool_name": "Bash"}\')',
  'p.stdin.close()',
  'for _ in range(400):',
  '    if os.path.exists(sys.argv[3]) and "hold-start" in open(sys.argv[3]).read(): break',
  '    time.sleep(0.05)',
  'time.sleep(3)',
  'os.unlink(sys.argv[2])',
  'p.wait()',
  't = os.times()',
  'print(json.dumps({"cpu": t.children_user + t.children_system, "rc": p.returncode}))',
].join('\n');
const FAST = ['--interval', '0.2', '--heartbeat', '5', '--margin', '1'];
const guardArgs = (f: Fixture, extra: string[] = []) => ['--config', f.cfg, ...FAST, ...extra];
const startGuard = (f: Fixture, extra: string[] = []) => spawnPy(GUARD, guardArgs(f, extra));
function guardOnce(f: Fixture, extra: string[] = []) {
  const r = runSync(GUARD, guardArgs(f, ['--once', ...extra]));
  expect(r.status, `guard --once exited ${r.status}: ${r.stderr}`).toBe(0); // a guard that crashes on some input must not pass as "did nothing"
  return r;
}
async function stopGuard(g: Proc) {
  g.child.kill('SIGTERM');
  await Promise.race([g.done, sleep(10000)]);
  await g.stop();
}

describe('python3 for the five-hour guard tests', () => {
  it.skipIf(!process.env.CI)('is available when the tests run in CI, so that none of them is skipped', () => {
    expect(spawnSync('python3', ['--version'], { encoding: 'utf8' }).status, 'python3 --version').toBe(0);
  });
});

describe.skipIf(!HAS_PYTHON3)('five-hour guard', { timeout: 90000 }, () => {
  it('pauses at 97 %, not at 96.9 %, not on a stale cache or a reset time already past; --dry-run writes nothing', () => {
    const resetMs = Date.now() + HOUR_MS;
    const f = fixture('threshold', { cache: { pct: 97, resetMs } });
    const r = guardOnce(f);
    const p = readJson(f.pause);
    expect(p.paused).toBe(true);
    expect(p.v).toBe(2);
    expect(p.percent).toBe(97);
    expect(p.valid_until).toBeGreaterThan(now());
    expect(p.valid_until).toBeLessThanOrEqual(now() + 5.5); // heartbeat deadline = now + --heartbeat
    expect(Math.abs(p.resume_at - (resetMs / 1000 + 1))).toBeLessThan(0.5); // resume_at = reset time + margin
    expect(readJson(f.state).paused, 'state stored for a guard restart').toBe(true);
    expect(r.stdout).toMatch(/THRESHOLD: 5h 97\.0 %/);

    const below = fixture('below', { cache: { pct: 96.9, resetMs: Date.now() + HOUR_MS } });
    guardOnce(below);
    expect(existsSync(below.pause), '96.9 % does not pause').toBe(false);
    expect(existsSync(below.state)).toBe(false);

    const stale = fixture('stale', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS, ageMs: 200e3 } });
    guardOnce(stale);
    expect(existsSync(stale.pause), 'data older than --max-age is not acted on').toBe(false);

    const past = fixture('past', { cache: { pct: 99, resetMs: Date.now() - 60e3 } });
    guardOnce(past);
    expect(existsSync(past.pause), 'a reset time in the past (cache of the window that just ended) never re-pauses').toBe(false);

    const dry = fixture('dry', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    const d = guardOnce(dry, ['--dry-run']);
    expect(d.stdout).toMatch(/THRESHOLD/);
    expect(existsSync(dry.pause) || existsSync(dry.state) || existsSync(dry.log), '--dry-run writes nothing').toBe(false);
  });

  it('a refresh that failed or was rate limited keeps old data under a fresh timestamp: the age counts from the last success', () => {
    const resetMs = Date.now() + HOUR_MS;
    const oldSuccess = Date.now() - 600e3;
    // the real shapes: a 429 entry carries rateLimited, a network failure carries error; both keep the data of lastSuccessAt
    const rateLimited = fixture('copy-rate-limited', { cache: { pct: 99, resetMs, extra: { rateLimited: true, lastSuccessAt: oldSuccess } } });
    guardOnce(rateLimited);
    expect(existsSync(rateLimited.pause), 'data of a success ten minutes ago, behind a fresh rate-limited entry, is not acted on').toBe(false);

    const failed = fixture('copy-failed', { cache: { pct: 99, resetMs, extra: { error: true, errorReason: 'network', lastSuccessAt: oldSuccess } } });
    guardOnce(failed);
    expect(existsSync(failed.pause), 'the same for a failed refresh').toBe(false);

    const noSuccess = fixture('copy-no-success', { cache: { pct: 99, resetMs, extra: { error: true, lastSuccessAt: undefined } } });
    guardOnce(noSuccess);
    expect(existsSync(noSuccess.pause), 'a copy of old data without the time of its success is not acted on').toBe(false);

    const recent = fixture('copy-recent', { cache: { pct: 99, resetMs, extra: { rateLimited: true, lastSuccessAt: Date.now() - 30e3 } } });
    guardOnce(recent);
    expect(readJson(recent.pause).paused, 'data of a success 30 s ago is acted on, whatever the later refresh did').toBe(true);

    const legacy = fixture('copy-legacy', { cache: { pct: 99, resetMs, extra: { lastSuccessAt: undefined } } });
    guardOnce(legacy);
    expect(readJson(legacy.pause).paused, 'an entry without error flags and without lastSuccessAt counts from its timestamp').toBe(true);
  });

  it('usage_cache defaults to the OMC cache file under CLAUDE_CONFIG_DIR, else under the home directory', () => {
    const dryRun = (name: string, env: NodeJS.ProcessEnv) => {
      const f = fixture(name, { config: { usage_cache: undefined } });
      const r = runSync(GUARD, [...guardArgs(f, ['--once', '--dry-run'])], { env });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    };
    const cachePath = (root: string) => join(root, 'plugins', 'oh-my-claudecode', '.usage-cache-anthropic.json');
    const f = fixture('default-cache');
    mkdirSync(join(CONFIG_DIR, 'plugins', 'oh-my-claudecode'), { recursive: true });
    mkdirSync(join(HOME_DIR, '.claude', 'plugins', 'oh-my-claudecode'), { recursive: true });
    const inConfigDir = { ...f, cache: cachePath(CONFIG_DIR) };
    writeCache(inConfigDir, { pct: 98, resetMs: Date.now() + HOUR_MS });
    expect(dryRun('default-cache-config-dir', ENV)).toMatch(/THRESHOLD: 5h 98\.0 %/);
    const underHome = { ...f, cache: cachePath(join(HOME_DIR, '.claude')) };
    writeCache(underHome, { pct: 99, resetMs: Date.now() + HOUR_MS });
    const noConfigDir = { ...ENV };
    delete noConfigDir.CLAUDE_CONFIG_DIR;
    expect(dryRun('default-cache-home', noConfigDir)).toMatch(/THRESHOLD: 5h 99\.0 %/);
    unlinkSync(inConfigDir.cache);
    unlinkSync(underHome.cache);
  });

  it('says so loudly when the usage data is missing, unreadable, stale, without a percentage or implausible, and holds nothing then', () => {
    const run = (name: string, setup: (f: Fixture) => void) => {
      const f = fixture(name);
      setup(f);
      const r = guardOnce(f);
      expect(existsSync(f.pause), `${name}: nothing is held`).toBe(false);
      return r.stdout;
    };
    const entry = (data: unknown) => (f: Fixture) => writeFileSync(f.cache, JSON.stringify({ timestamp: Date.now(), data }), 'utf8');
    expect(run('warn-missing', () => {})).toMatch(/WARNING \(cache-missing\): the usage cache .* does not exist: .*omc wait/);
    expect(run('warn-unreadable', (f) => writeFileSync(f.cache, 'not json {', 'utf8'))).toMatch(/WARNING \(cache-unreadable\): cannot read the usage cache/);
    expect(run('warn-stale', (f) => writeCache(f, { pct: 99, resetMs: Date.now() + HOUR_MS, ageMs: 200e3 })))
      .toMatch(/WARNING \(cache-stale\): the usage data is 20\d s old, older than --max-age \(180 s\)/);
    expect(run('warn-null', entry({ fiveHourPercent: null }))).toMatch(/WARNING \(cache-no-percent\): .* has no fiveHourPercent/);
    expect(run('warn-nodata', entry(undefined))).toMatch(/WARNING \(cache-no-percent\)/);
    expect(run('warn-ok', (f) => writeCache(f, { pct: 50, resetMs: Date.now() + HOUR_MS })), 'a healthy cache: no warning').not.toMatch(/WARNING/);
  });

  it('repeats a warning only after --warn-every seconds', async () => {
    const count = (f: Fixture) => (readText(f.log).match(/WARNING \(cache-missing\)/g) ?? []).length;
    const f = fixture('warn-period'); // no usage cache at all
    const g = startGuard(f);
    try {
      await waitFor(() => count(f) >= 1, 20000, 'first warning');
      await sleep(1500); // seven more ticks of 0.2 s
      expect(count(f), 'one warning in 1.5 s with the default period of 10 minutes').toBe(1);
    } finally { await stopGuard(g); }
    const short = fixture('warn-period-short');
    const g2 = startGuard(short, ['--warn-every', '0.5']);
    try {
      await waitFor(() => count(short) >= 3, 20000, 'three warnings with a period of 0.5 s');
    } finally { await stopGuard(g2); }
  });

  it('a path key of the configuration that is not a string is a configuration error (exit 2, no traceback), not a crash', () => {
    const f = fixture('cfg-types');
    for (const key of ['pause_file', 'state_file', 'usage_cache', 'log_file', 'settings_file']) {
      for (const bad of [42, ['a'], { a: 1 }, true]) {
        writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, [key]: bad }), 'utf8');
        const r = runSync(GUARD, ['--config', f.cfg, '--once']);
        expect(r.status, `${key}=${JSON.stringify(bad)}: ${r.stderr}`).toBe(2);
        expect(r.stderr, `${key}`).toContain(`"${key}" must be a string`);
        expect(r.stderr).not.toContain('Traceback');
      }
    }
  });

  it('refuses at start a pause or state file in a directory that is not there; a directory that vanishes later is an ERROR, not the end of the guard', async () => {
    const f = fixture('no-dir');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: join(f.dir, 'missing', 'pause.json'), state_file: f.state }), 'utf8');
    const r = runSync(GUARD, ['--config', f.cfg, '--once']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/directory .*missing of pause_file does not exist or is not writable/);
    expect(runSync(GUARD, ['--config', f.cfg, '--test-pause', '1']).status, '--test-pause needs the directory of the pause file too').toBe(2);
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: join(f.dir, 'missing', 'state.json') }), 'utf8');
    const rs = runSync(GUARD, ['--config', f.cfg, '--once']);
    expect(rs.status).toBe(2);
    expect(rs.stderr).toMatch(/of state_file does not exist or is not writable/);

    const v = fixture('dir-vanishes', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const pauseDir = join(v.dir, 'pause-dir');
    mkdirSync(pauseDir);
    writeFileSync(v.cfg, JSON.stringify({ usage_cache: v.cache, pause_file: join(pauseDir, 'pause.json'), state_file: v.state, log_file: v.log }), 'utf8');
    const blocked = fixture('pause-blocked', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    // the replace of the pause file fails (a full disk): the write fails, and a single check says so by its status
    const once = runPyCode(['import os, runpy, sys', 'def full(*a, **k): raise OSError(28, "No space left on device")', 'os.replace = full',
      'sys.argv = sys.argv[1:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n'), [GUARD, ...guardArgs(blocked, ['--once'])]);
    expect(once.status, 'a failed tick under --once is status 1').toBe(1);
    expect(once.stdout).toMatch(/ERROR: tick failed/);

    const g = startGuard(v);
    try {
      await waitFor(() => /guard start/.test(readText(v.log)), 20000, 'start line');
      rmSync(pauseDir, { recursive: true });
      writeCache(v, { pct: 99, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => /ERROR: tick failed/.test(readText(v.log)), 20000, 'ERROR line');
      expect(g.exited, 'the guard keeps running after the failed write').toBe(false);
      mkdirSync(pauseDir);
      await waitFor(() => existsSync(join(pauseDir, 'pause.json')), 20000, 'the pause file once the directory is back');
      expect(g.exited).toBe(false);
    } finally { await stopGuard(g); }
  });

  it('does not believe a reset time more than 5 h 15 min ahead, in a new pause or in an extension of one', async () => {
    const near = fixture('reset-near', { cache: { pct: 99, resetMs: Date.now() + MAX_RESET_AHEAD_MS - 30e3 } });
    guardOnce(near);
    expect(readJson(near.pause).paused, 'a reset time just under the bound is acted on').toBe(true);
    const far = fixture('reset-far', { cache: { pct: 99, resetMs: Date.now() + MAX_RESET_AHEAD_MS + 30e3 } });
    const r = guardOnce(far);
    expect(existsSync(far.pause), 'a reset time just over the bound is not').toBe(false);
    expect(r.stdout).toMatch(/WARNING \(reset-too-far\): 5h 99\.0 %, but the reset time .* is more than 315 minutes ahead/);

    const f = fixture('slip-far', { cache: { pct: 97, resetMs: Date.now() + 3000 } });
    const g = startGuard(f, ['--margin', '0.5']);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'pause file');
      writeCache(f, { pct: 97, resetMs: Date.now() + 6 * HOUR_MS }); // the cache still shows the threshold, with an absurd reset time
      await waitFor(() => !existsSync(f.pause), 20000, 'the pause ends at its resume time');
      await waitFor(() => /RESUMED \(reset time reached\)/.test(readText(f.log)), 20000, 'resume line');
      expect(readText(f.log), 'the absurd reset time does not extend the pause').not.toMatch(/reset slipped/);
    } finally { await stopGuard(g); }
  });

  it('options outside their range are a configuration error (status 2); the ends of the ranges are accepted', async () => {
    const f = fixture('ranges', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const once = (args: string[]) => runSync(GUARD, ['--config', f.cfg, '--once', ...args]);
    const accepted = [['--margin', '1800'], ['--margin', '0'], ['--heartbeat', '1800'], ['--heartbeat', '0.4', '--interval', '0.2'],
      ['--interval', '0.1', '--heartbeat', '0.2'], ['--interval', '900', '--heartbeat', '1800'], ['--warn-every', '0'], ['--warn-every', '86400']];
    for (const args of accepted) expect(once(args).status, args.join(' ')).toBe(0);
    const refused = [['--margin', '1801'], ['--margin', '-1'], ['--heartbeat', '1801'], ['--heartbeat', '0.3', '--interval', '0.2'],
      ['--interval', '0.05'], ['--interval', '901', '--heartbeat', '1800'], ['--warn-every', '-1'], ['--warn-every', '86401'], ['--test-pause', '1801'], ['--test-pause', '-5']];
    for (const args of refused) {
      const r = once(args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr, args.join(' ')).toMatch(/must be (between|at least)/);
    }
    // NaN is in no range (every comparison with it is false) and infinity is in none that has an end: both are refused as numbers
    for (const option of ['--interval', '--margin', '--heartbeat', '--warn-every', '--threshold', '--max-age', '--resume-below']) {
      for (const bad of ['nan', 'inf']) {
        const r = once([option, bad]);
        expect(r.status, `${option} ${bad}`).toBe(2);
        expect(r.stderr, `${option} ${bad}`).toMatch(/is not a finite number/);
      }
    }
    // the upper end of --test-pause is accepted too (it starts a half-hour hold, so it is stopped as soon as the pause file shows up)
    const tp = spawnPy(GUARD, ['--config', f.cfg, '--test-pause', '1800']);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'test pause file at the upper end of the range');
      expect(readJson(f.pause).resume_at, 'held for 1800 s').toBeGreaterThan(now() + 1790);
    } finally { await stopGuard(tp); }
    expect(existsSync(f.pause), 'the stopped test pause removes its file').toBe(false);
    expect(tp.out).not.toMatch(/must be/);
  });

  it('one guard per state file; a pause file of a live process that is not ours refuses the start and stays, a dead one is removed', async () => {
    const f = fixture('two-guards', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const a = startGuard(f);
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'first guard');
      const b = runSync(GUARD, guardArgs(f, ['--once']));
      expect(b.status, 'a second guard with the same state file').toBe(2);
      expect(b.stderr).toMatch(/another guard holds .*state\.json\.lock: one guard per state file/);
    } finally { await stopGuard(a); }
    expect(runSync(GUARD, guardArgs(f, ['--once'])).status, 'the lock goes with the first guard').toBe(0);

    // a pid that is alive proves nothing (it may have been reused after a crash): only the lock on the pause file names a real owner
    const live = fixture('leftover-live', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    writePause(live, { pid: process.pid }); // the process of this test: alive, with a current heartbeat, and not holding the lock
    const takenOver = runSync(GUARD, guardArgs(live, ['--once']));
    expect(takenOver.status, `${takenOver.stdout}${takenOver.stderr}`).toBe(0);
    expect(readJson(live.pause).pid, 'the pause of a process that holds no lock is replaced by this guard').not.toBe(process.pid);
    const dead = fixture('leftover-dead', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writePause(dead, { pid: deadPid() });
    guardOnce(dead);
    expect(existsSync(dead.pause), 'the pause file of a dead process is removed').toBe(false);
  });

  it('a step of the wall clock does not stretch the wait between ticks', async () => {
    const f = fixture('clock-step', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const flag = join(f.dir, 'clock-steps-back');
    const g = spawnPyCode(CLOCK_STEP_DRIVER, [flag, GUARD, ...guardArgs(f)]);
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'start line');
      writeFileSync(flag, '');
      await sleep(600); // the clock is an hour back now; a wait counted by the wall clock would last an hour
      // the writer of the cache runs on the same machine, so it stamps the entry with the stepped clock: an hour back
      writeCache(f, { pct: 99, resetMs: Date.now() + HOUR_MS, ageMs: HOUR_MS });
      await waitFor(() => existsSync(f.pause), 20000, 'pause file: the guard still ticks');
    } finally { await stopGuard(g); }
  });

  it('an orderly stop releases the sessions; the restarted guard brings the pause back from a fresh reading of the cache, not from a stale one', async () => {
    const f = fixture('restart-after-stop', { cache: { pct: 97, resetMs: Date.now() + HOUR_MS } });
    const g = startGuard(f);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'pause file');
    } finally { await stopGuard(g); }
    expect(existsSync(f.pause), 'stopped: the sessions are released').toBe(false);
    writeCache(f, { pct: 97, resetMs: Date.now() + HOUR_MS, ageMs: 200e3 });
    guardOnce(f);
    expect(existsSync(f.pause), 'a stale reading does not bring the pause back').toBe(false);
    writeCache(f, { pct: 97, resetMs: Date.now() + HOUR_MS });
    guardOnce(f);
    expect(readJson(f.pause).paused, 'a fresh reading does').toBe(true);
  });

  it('resumes at the reset time plus margin, not before (the cache stays at 97 %, so the early-resume path is not taken)', async () => {
    const reset = Date.now() + 3000;
    const f = fixture('resume', { cache: { pct: 97, resetMs: reset } });
    const g = startGuard(f);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'pause file');
      const p = readJson(f.pause);
      expect(Math.abs(p.resume_at - (reset / 1000 + 1)), `resume_at ${p.resume_at} = reset + margin`).toBeLessThan(0.05);
      writeCache(f, { pct: 97, resetMs: reset }); // refresh the cache timestamp, same percent
      await waitFor(() => !existsSync(f.pause), 20000, 'pause file removal');
      expect(now(), 'not removed before the reset time plus margin').toBeGreaterThanOrEqual(p.resume_at - 0.01);
      await waitFor(() => /RESUMED \(reset time reached\)/.test(readText(f.log)), 20000, 'resume line (logged just after the file is removed)');
      await waitFor(() => readJson(f.state).paused === false, 20000, 'state cleared');
    } finally { await stopGuard(g); }
  });

  it('reset slipped: the pause is extended while the cache still shows the threshold with a later reset', async () => {
    const f = fixture('slip', { cache: { pct: 97, resetMs: Date.now() + 3500 } });
    const g = startGuard(f, ['--margin', '0.5']);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'pause file');
      const later = Date.now() + 4500;
      writeCache(f, { pct: 97, resetMs: later });
      await waitFor(() => /reset slipped/.test(readText(f.log)), 20000, 'slip line');
      expect(existsSync(f.pause), 'still paused after the first resume time').toBe(true);
      await waitFor(() => readJson(f.pause).resume_at >= later / 1000 + 0.45, 20000, 'new resume time = later reset + margin (published in the same tick as the log line)');
      writeCache(f, { pct: 97, resetMs: later });
      await waitFor(() => !existsSync(f.pause), 20000, 'removal at the new time');
    } finally { await stopGuard(g); }
  });

  it('resumes early when a fresh cache shows less than threshold - 10 percent', async () => {
    const f = fixture('early', { cache: { pct: 97, resetMs: Date.now() + HOUR_MS } });
    const g = startGuard(f);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'pause file');
      writeCache(f, { pct: 86, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => !existsSync(f.pause), 20000, 'early resume');
      await waitFor(() => /RESUMED \(window reset seen early: 5h 86\.0 %\)/.test(readText(f.log)), 20000, 'early resume line');
    } finally { await stopGuard(g); }
  });

  it('SIGTERM removes the pause file and clears the stored pause; a leftover pause file without state is removed at start', async () => {
    const f = fixture('sigterm', { cache: { pct: 97, resetMs: Date.now() + HOUR_MS } });
    const g = startGuard(f);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'pause file');
      g.child.kill('SIGTERM');
      await Promise.race([g.done, sleep(20000)]);
      expect(g.exited && g.code === 0, `exit ${g.code}`).toBe(true);
    } finally { await g.stop(); }
    expect(existsSync(f.pause), 'pause file removed on SIGTERM').toBe(false);
    expect(readJson(f.state).paused).toBe(false);
    expect(readText(f.log)).toMatch(/RESUMED \(guard stopping\)/);

    const once = fixture('once', { cache: { pct: 97, resetMs: Date.now() + HOUR_MS } });
    guardOnce(once);
    expect(existsSync(once.pause), '--once leaves the pause it started').toBe(true);

    const left = fixture('leftover', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writePause(left, { pid: deadPid() });
    guardOnce(left);
    expect(existsSync(left.pause), 'leftover pause file without state held nothing but is removed').toBe(false);
  });

  it('--test-pause: holds chosen sessions for a while, touches no state, never removes or overwrites a pause that is not its own', async () => {
    const t = fixture('test-pause');
    writeFileSync(t.cfg, JSON.stringify({ pause_file: t.pause, exclude: ['keep1'] }), 'utf8');
    const tp = spawnPy(GUARD, ['--config', t.cfg, '--test-pause', '1.2', '--test-only', 'aaa1,bbb2']);
    await waitFor(() => existsSync(t.pause), 20000, 'test pause file');
    const doc = readJson(t.pause);
    expect(doc.only).toEqual(['aaa1', 'bbb2']);
    expect(doc.exclude).toEqual(['keep1']);
    expect(doc.valid_until, 'test pause is valid for the whole test').toBeGreaterThan(now() + 1);
    await tp.done;
    expect(existsSync(t.pause), 'test pause file removed').toBe(false);
    expect(existsSync(t.state), '--test-pause touches no state').toBe(false);

    const foreign = fixture('test-pause-foreign');
    writeFileSync(foreign.cfg, JSON.stringify({ pause_file: foreign.pause }), 'utf8');
    const tp2 = spawnPy(GUARD, ['--config', foreign.cfg, '--test-pause', '1.5']);
    await waitFor(() => existsSync(foreign.pause), 20000, 'test pause file');
    writePause(foreign, { pid: 1 }); // a real pause starts while the test runs and takes over the file
    await tp2.done;
    expect(readJson(foreign.pause).pid, 'the end of the test does not remove a pause file that is not its own').toBe(1);
    expect(tp2.out).toMatch(/left alone/);

    writePause(t); // a pause in force: the test refuses instead of overwriting it and releasing it at the end
    const refused = runSync(GUARD, ['--config', t.cfg, '--test-pause', '1']);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/--test-pause refused/);
    expect(readJson(t.pause).paused, 'the pause file in force is untouched').toBe(true);
  });

  it('exclude: from the configuration, overridden by --exclude; configuration errors exit 2', () => {
    const f = fixture('exclude', { config: { exclude: ['cfg11111'] }, cache: { pct: 97, resetMs: Date.now() + HOUR_MS } });
    guardOnce(f);
    expect(readJson(f.pause).exclude).toEqual(['cfg11111']);
    unlinkSync(f.pause);
    unlinkSync(f.state);
    guardOnce(f, ['--exclude', 'cli11111,cli22222']);
    expect(readJson(f.pause).exclude).toEqual(['cli11111', 'cli22222']);

    const bad = fixture('missing-key');
    writeFileSync(bad.cfg, JSON.stringify({ usage_cache: bad.cache }), 'utf8');
    const r = runSync(GUARD, ['--config', bad.cfg, '--once']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/"pause_file" is not set/);

    const asString = fixture('exclude-string', { config: { exclude: 'ab12cd34,ef56ef56' }, cache: { pct: 97, resetMs: Date.now() + HOUR_MS } });
    guardOnce(asString);
    expect(readJson(asString.pause).exclude, 'a string is split at commas like --exclude, not into characters').toEqual(['ab12cd34', 'ef56ef56']);

    const wrongType = fixture('exclude-type', { config: { exclude: [123] }, cache: { pct: 97, resetMs: Date.now() + HOUR_MS } });
    const wt = runSync(GUARD, ['--config', wrongType.cfg, '--once']);
    expect(wt.status).toBe(2);
    expect(wt.stderr).toMatch(/"exclude" must be a list of session id prefixes/);
    expect(existsSync(wrongType.pause)).toBe(false);

    const inf = runSync(GUARD, ['--config', f.cfg, '--once', '--heartbeat', 'inf']);
    expect(inf.status, 'a non-finite option value is refused').toBe(2);

    const nofile = runSync(GUARD, ['--config', join(bad.dir, 'absent.json'), '--once']);
    expect(nofile.status).toBe(2);
    expect(nofile.stderr).toMatch(/cannot read configuration/);
  });

  it('heartbeat: valid_until is renewed on every tick while paused, so the hook never lets go of a pause that is alive', async () => {
    const f = fixture('heartbeat', { cache: { pct: 97, resetMs: Date.now() + HOUR_MS } });
    const g = startGuard(f, ['--heartbeat', '6']);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'pause file');
      const first = readJson(f.pause).valid_until;
      await sleep(1400);
      const second = readJson(f.pause).valid_until;
      expect(second, `valid_until renewed (${first} -> ${second})`).toBeGreaterThanOrEqual(first + 1);
      expect(second, 'and still ahead of the clock').toBeGreaterThan(now() + 0.5);
    } finally { await stopGuard(g); }
  });

  it('restart during a pause: a stored pause still in force is kept, one already over is released at start', () => {
    const f = fixture('restart-kept', { cache: { pct: 97, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.state, JSON.stringify({ paused: true, since: now() - 5, resume_at: now() + 600 }), 'utf8');
    writePause(f, { pid: deadPid() });
    const r = guardOnce(f);
    expect(r.stdout).toMatch(/start during a pause, resume at/);
    expect(readJson(f.pause).paused, 'the pause file stays in force across the restart').toBe(true);
    expect(r.stdout).not.toMatch(/RESUMED/);

    const g = fixture('restart-over', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(g.state, JSON.stringify({ paused: true, since: now() - 700, resume_at: now() - 10 }), 'utf8');
    writePause(g, { pid: deadPid() });
    const r2 = guardOnce(g);
    expect(r2.stdout).toMatch(/RESUMED \(stored pause already over at start\)/);
    expect(existsSync(g.pause), 'a pause that is already over is not carried into the new run').toBe(false);
  });

  it('refuses a threshold outside 0-100 and a resume level above the threshold (one tick would enter and the next leave the pause)', () => {
    const f = fixture('thresholds', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const refused = (args: string[], pattern: RegExp) => {
      const r = runSync(GUARD, guardArgs(f, ['--once', ...args]));
      expect(r.status, `${args.join(' ')}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, args.join(' ')).toMatch(pattern);
      expect(existsSync(f.pause), 'no pause was written').toBe(false);
    };
    refused(['--resume-below', '100', '--threshold', '97'], /--resume-below must be between 0 and the threshold/);
    refused(['--resume-below', '98'], /--resume-below must be between 0 and the threshold/);
    refused(['--resume-below', '-1'], /--resume-below must be between 0 and the threshold/);
    refused(['--threshold', '101'], /--threshold must be greater than 0 and at most 100/);
    refused(['--threshold', '0'], /--threshold must be greater than 0 and at most 100/);
    expect(guardOnce(f, ['--resume-below', '97']).status, 'resume level equal to the threshold is allowed').toBe(0);
  });

  it('the pause file must be an absolute path (the hook entry only accepts an absolute one)', () => {
    const f = fixture('relative-pause');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: 'pause.json', state_file: f.state }), 'utf8');
    const r = runSync(GUARD, ['--config', f.cfg, '--once']);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/"pause_file" must be an absolute path/);
  });

  it('configured files that are one file (same path, a link, a hard link) are refused before anything is removed or written', () => {
    const f = fixture('aliases', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const settingsText = JSON.stringify({ hooks: {}, env: { KEEP: '1' } });
    const run = (config: Record<string, unknown>) => {
      writeFileSync(f.settings, settingsText, 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${JSON.stringify(config)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/are the same file/);
      expect(readText(f.settings), 'settings.json is untouched').toBe(settingsText);
      expect(existsSync(f.settings)).toBe(true);
    };
    run({ pause_file: f.settings });                       // the pause file is settings.json
    run({ state_file: f.pause });                          // pause and state
    run({ usage_cache: f.pause });                         // pause and cache
    run({ log_file: f.state });                            // log and state
    run({ state_file: f.settings });                       // state and settings
    run({ pause_file: join(f.dir, '.', 'settings.json') }); // a different spelling of the same path
    const viaLink = join(f.dir, 'pause-link.json');
    rmSync(viaLink, { force: true });
    symlinkSync(f.settings, viaLink);
    run({ pause_file: viaLink });                          // a symbolic link to settings.json
    const hard = join(f.dir, 'pause-hard.json');
    rmSync(hard, { force: true });
    linkSync(f.settings, hard);
    run({ pause_file: hard });                             // a hard link to settings.json
    run({ hook_log_file: f.log });                         // the log of the hook is the log of the guard
    run({ log_file: f.state + '.lock' });                  // the log file is the lock file of the state file
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    expect(runSync(GUARD, ['--config', f.cfg, '--once']).status, 'distinct files start').toBe(0);
  });

  it('the configuration file itself is one of the files that must be distinct: an output path that names it is refused, the file is kept', () => {
    const f = fixture('alias-config', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    for (const key of ['pause_file', 'state_file', 'log_file', 'settings_file', 'usage_cache']) {
      const text = JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, [key]: f.cfg });
      writeFileSync(f.cfg, text, 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${key}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/are the same file/);
      expect(readText(f.cfg), `${key}: the configuration file is untouched`).toBe(text);
    }
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state }), 'utf8');
    const cli = runSync(GUARD, ['--config', f.cfg, '--once', '--pause-file', f.cfg]);
    expect(cli.status, 'an option names it too').toBe(2);
    expect(existsSync(f.cfg)).toBe(true);
  });

  it('the hook entry is checked again while a pause lasts (at most once per --warn-every): a hook removed after the pause began is reported', async () => {
    const f = fixture('wiring-during-pause', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const entry = (command: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } });
    writeFileSync(f.settings, entry(`[ -f ${f.pause} ] && [ -f ${HOOK} ] || exit 0; exec ${PYBIN} -I ${HOOK} --pause-file ${f.pause}`), 'utf8');
    const g = startGuard(f, ['--warn-every', '1']);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'the pause');
      expect(readText(f.log), 'a wired hook: no warning').not.toMatch(/WARNING/);
      writeFileSync(f.settings, JSON.stringify({ hooks: {} }), 'utf8');
      await waitFor(() => /WARNING \(pause\): hook five-hour-guard-hook\.py is NOT registered/.test(readText(f.log)), 20000, 'the wiring warning during the pause');
    } finally { await stopGuard(g); }
  });

  it('an existing pause file that is not a guard pause is never removed: refused at start with exit 2, the file is kept', () => {
    const f = fixture('not-a-pause', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    for (const text of ['my notes, not a pause\n', '', '{}', '{"paused": true}', '[1, 2]', '{"v": 2, "paused": "true", "pid": 1}',
      '{"v":0,"paused":false,"pid":999999}', '{"v":2,"paused":false,"pid":999999,"since":1,"resume_at":2,"valid_until":3}', '{"v":2,"paused":true,"pid":999999}',
      '{"v":1,"paused":true,"pid":999999,"since":1,"resume_at":2,"valid_until":3}']) {
      writeFileSync(f.pause, text, 'utf8');
      const r = runSync(GUARD, guardArgs(f, ['--once']));
      expect(r.status, `${JSON.stringify(text)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/is not a pause file of this guard/);
      expect(readText(f.pause), 'the file is untouched').toBe(text);
    }
    writePause(f, { pid: deadPid() });
    expect(runSync(GUARD, guardArgs(f, ['--once'])).status, 'a leftover pause of the guard is still removed').toBe(0);
    expect(existsSync(f.pause)).toBe(false);
  });

  it('a pause file or state file that is a directory is refused at start (exit 2)', () => {
    const f = fixture('dir-targets', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const dir = join(f.dir, 'a-directory');
    mkdirSync(dir);
    for (const [key, label] of [['pause_file', 'pause_file'], ['state_file', 'state_file']]) {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, [key]: dir }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${label}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(new RegExp(`"${label}" .* is not a regular file`));
    }
  });

  it('the hook entry check follows the same file name rule as add: a name that contains five-hour-guard-hook.py is checked', () => {
    const f = fixture('hook-name-rule', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `exec ${PYBIN} -I /nonexistent-dir/five-hour-guard-hook.py.copy --pause-file ${f.pause}` }] }] } }), 'utf8');
    expect(guardOnce(f).stdout).toMatch(/WARNING \(start\): the hook entry in .* names \/nonexistent-dir\/five-hour-guard-hook\.py\.copy, which does not exist/);
  });

  it('a state lock that cannot be opened is a configuration error (exit 2), not a traceback that the unit restarts', () => {
    const f = fixture('lock-dir', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    mkdirSync(f.state + '.lock');
    const r = runSync(GUARD, ['--config', f.cfg, '--once']);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/cannot open the lock file .*state\.json\.lock/);
    expect(r.stderr).not.toMatch(/Traceback/);
  });

  it('with no settings_file in the configuration the default settings.json counts as a configured file: a log or state file that is it is refused', () => {
    const f = fixture('alias-default-settings', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const configDir = join(f.dir, 'claude-config');
    mkdirSync(configDir, { recursive: true });
    const settings = join(configDir, 'settings.json');
    const text = JSON.stringify({ env: { KEEP: '1' } });
    for (const key of ['log_file', 'state_file', 'usage_cache']) {
      writeFileSync(settings, text, 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, [key]: settings }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once'], { env: { ...ENV, CLAUDE_CONFIG_DIR: configDir } });
      expect(r.status, `${key}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/are the same file/);
      expect(readText(settings), `${key}: settings.json is untouched`).toBe(text);
    }
  });

  it('two guards with one pause_file and different state files: the second one does not start, even when the first has published nothing yet', async () => {
    const a = fixture('pause-lock-a', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const b = fixture('pause-lock-b', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(b.cfg, JSON.stringify({ usage_cache: b.cache, pause_file: a.pause, state_file: b.state }), 'utf8');
    const first = startGuard(a);
    try {
      await waitFor(() => /guard start/.test(readText(a.log)), 20000, 'first guard');
      const second = runSync(GUARD, guardArgs(b, ['--once']));
      expect(second.status, `${second.stdout}${second.stderr}`).toBe(2);
      expect(second.stderr).toMatch(/another guard holds .*pause\.json\.lock: one guard per pause file/);
    } finally { await stopGuard(first); }
    expect(runSync(GUARD, guardArgs(b, ['--once'])).status, 'the lock goes with the first guard').toBe(0);
  });

  it('without fcntl (Windows) the pause file and state file are still locked, through msvcrt.locking: a second guard on one pause_file does not start', async () => {
    // the driver hides fcntl and offers an msvcrt whose locking is a byte-range lock on the file, here played by flock of the real fcntl
    const driver = ['import sys, runpy, types, fcntl as real', 'm = types.ModuleType("msvcrt")', 'm.LK_NBLCK = 2',
      'def locking(fd, mode, n):', '    assert mode == 2 and n == 1', '    real.flock(fd, real.LOCK_EX | real.LOCK_NB)',
      'm.locking = locking', 'sys.modules["msvcrt"] = m', 'sys.modules["fcntl"] = None', 'sys.argv = sys.argv[1:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const a = fixture('nofcntl-a', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const b = fixture('nofcntl-b', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(b.cfg, JSON.stringify({ usage_cache: b.cache, pause_file: a.pause, state_file: b.state }), 'utf8');
    const first = spawnPyCode(driver, [GUARD, ...guardArgs(a)]);
    try {
      await waitFor(() => /guard start/.test(readText(a.log)), 20000, 'first guard');
      const second = runPyCode(driver, [GUARD, ...guardArgs(b, ['--once'])]);
      expect(second.status, `${second.stdout}${second.stderr}`).toBe(2);
      expect(second.stderr).toMatch(/another guard holds .*pause\.json\.lock: one guard per pause file/);
    } finally { await stopGuard(first); }
  });

  it('the shell check of the hook entry is validated too: a stale file in `[ -f ... ]` would end the entry before Python on every call', () => {
    const f = fixture('preflight-drift', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const entry = (pauseTest: string, hookTest: string) => `[ -f ${pauseTest} ] && [ -f ${hookTest} ] && [ -x ${PYBIN} ] || exit 0; exec ${PYBIN} -I ${HOOK} --pause-file ${f.pause}`;
    const put = (command: string) => writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } }), 'utf8');
    put(entry(f.pause, HOOK));
    expect(guardOnce(f).stdout, 'the generated shape is accepted').not.toMatch(/WARNING/);
    for (const [pauseTest, hookTest] of [['/old/pause.json', HOOK], [f.pause, '/old/five-hour-guard-hook.py']]) {
      put(entry(pauseTest, hookTest));
      expect(guardOnce(f).stdout, `${pauseTest} ${hookTest}`).toMatch(/WARNING \(start\): the shell check of the hook entry .* tests the file \/old\//);
    }
  });

  it('a file that appears at pause_file after the start check is never removed as a leftover: exit 2, the file is kept', () => {
    // the driver puts the file in place when the guard first reads its state file, which is after the checks of the start and before the removal of a leftover
    const driver = ['import builtins, os, runpy, sys', 'real, target, text = builtins.open, sys.argv[1], sys.argv[2]', 'done = []',
      'def spy(path, *a, **k):', '    if str(path).endswith("state.json") and not done:', '        done.append(1)',
      '        with real(target, "w") as f: f.write(text)', '    return real(path, *a, **k)',
      'builtins.open = spy', 'sys.argv = sys.argv[3:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    for (const leftover of [false, true]) {
      const f = fixture(`pause-race-${leftover}`, { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
      if (leftover) writePause(f, { pid: deadPid() }); // a guard pause when the start looks, replaced before the removal
      const r = runPyCode(driver, [f.pause, 'my notes, not a pause\n', GUARD, ...guardArgs(f, ['--once'])]);
      expect(r.status, `${leftover}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/is not a pause file of this guard/);
      expect(readText(f.pause), 'the foreign file is untouched').toBe('my notes, not a pause\n');
    }
  });

  it('a log that is a symbolic link is never written through, by the guard or by the hook: the file it points to is left as it was and nothing is created', async () => {
    const f = fixture('log-link', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const victim = join(f.dir, 'victim.txt');
    writeFileSync(victim, 'victim\n', 'utf8');
    const absent = join(f.dir, 'not-created.txt');
    for (const target of [victim, absent]) {
      const link = join(f.dir, 'log-link.txt');
      rmSync(link, { force: true });
      symlinkSync(target, link);
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: link }), 'utf8');
      expect(runSync(GUARD, guardArgs(f, ['--once'])).status).toBe(0);
      expect(existsSync(absent), 'a link to a missing file does not create it').toBe(false);
      expect(readText(victim), 'the guard did not write through the link').toBe('victim\n');
      // the hook: held while a pause lasts, it logs hold-start and hold-end
      writePause(f, { pid: process.pid });
      const h = spawnPy(HOOK, ['--pause-file', f.pause, '--log', link, '--poll', '0.1'], { input: hookInput('linklog1') });
      try {
        await sleep(1500);
        expect(h.exited, 'the hook holds').toBe(false);
        unlinkSync(f.pause);
        await Promise.race([h.done, sleep(20000)]);
      } finally { await h.stop(); }
      expect(existsSync(absent)).toBe(false);
      expect(readText(victim), 'the hook did not write through the link').toBe('victim\n');
    }
  });

  it('a stop whose unpaused state cannot be written still removes the pause file: sessions are not left waiting for the heartbeat', async () => {
    const f = fixture('stop-state-write-fails', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const flag = join(f.dir, 'deny-state');
    const code = ['import os, runpy, sys', 'real = os.open', 'flag = sys.argv[1]',
      'def maybe(p, *a, **k):', '    if os.path.exists(flag) and "state.json" in str(p) and str(p).endswith(".tmp"): raise OSError(28, "No space left on device")', '    return real(p, *a, **k)',
      'os.open = maybe', 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const g = spawnPyCode(code, [flag, GUARD, ...guardArgs(f, ['--interval', '3', '--heartbeat', '10'])]);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'the pause');
      writeFileSync(flag, '', 'utf8');
      g.child.kill('SIGTERM');
      await Promise.race([g.done, sleep(20000)]);
      expect(g.exited && g.code === 0, `exit ${g.code}`).toBe(true);
    } finally { await g.stop(); }
    expect(existsSync(f.pause), 'the pause file is removed although the state could not be written').toBe(false);
    expect(readText(f.log)).toMatch(/RESUMED \(guard stopping, state not saved\)/);
  });

  it('the program that launches the hook is validated: it must be a Python that exists and the one the shell check tests', () => {
    const f = fixture('launcher-drift', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const other = join(f.dir, 'python3-other');
    writeFileSync(other, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(other, 0o755);
    const put = (launcher: string) => writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command',
      command: `[ -f ${f.pause} ] && [ -f ${HOOK} ] && [ -x ${PYBIN} ] || exit 0; exec ${launcher} -I ${HOOK} --pause-file ${f.pause}` }] }] } }), 'utf8');
    put(PYBIN);
    expect(guardOnce(f).stdout, 'the generated shape is accepted').not.toMatch(/WARNING/);
    put(process.execPath);
    expect(guardOnce(f).stdout, 'a launcher that is not a Python').toMatch(/WARNING \(start\): .* runs the hook with .*, which is not a Python/);
    put(join(f.dir, 'python3-missing'));
    expect(guardOnce(f).stdout, 'a launcher that is not there').toMatch(/runs the hook with .*python3-missing, which does not exist/);
    put(other);
    expect(guardOnce(f).stdout, 'a launcher other than the one tested').toMatch(/but its shell check tests .*: the two must be the same interpreter/);
  });

  it('the pause is stored before its file is published: a state write that fails at the first high reading publishes nothing a crash could leave behind', () => {
    const f = fixture('state-first', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const code = ['import os, runpy, sys', 'real = os.open',
      'def maybe(p, *a, **k):', '    if "state.json" in str(p) and str(p).endswith(".tmp"): raise OSError(28, "No space left on device")', '    return real(p, *a, **k)',
      'os.open = maybe', 'sys.argv = sys.argv[1:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const r = runPyCode(code, [GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.stdout).toMatch(/ERROR: tick failed/);
    expect(existsSync(f.pause), 'no pause file without a stored pause behind it').toBe(false);
    expect(guardOnce(f).stdout, 'it starts as soon as the state can be written').toMatch(/THRESHOLD/);
    expect(readJson(f.state).paused).toBe(true);
    expect(existsSync(f.pause)).toBe(true);
  });

  it('paths that differ only by case are one file where the platform ignores case, also when neither exists yet (checked with the case rules of Windows)', () => {
    const f = fixture('case-alias', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: join(f.dir, 'Pause-Case.json'), state_file: join(f.dir, 'pause-case.json') }), 'utf8');
    const driver = ['import os, runpy, sys', 'os.path.normcase = lambda p: p.lower()', 'sys.argv = sys.argv[1:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const r = runPyCode(driver, [GUARD, '--config', f.cfg, '--once']);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/are the same file/);
    expect(runSync(GUARD, ['--config', f.cfg, '--once']).status, 'on a case-sensitive platform they are two files').toBe(0);
  });

  it('the program that launches the hook is a protected file too, also without a shell check: a state file or log that is it is refused and the program kept', () => {
    const f = fixture('launcher-protected', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const wrapper = join(f.dir, 'python3-wrapper');
    writeFileSync(wrapper, '#!/bin/sh\nexec python3 "$@"\n', 'utf8');
    chmodSync(wrapper, 0o755);
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `exec ${wrapper} -I ${HOOK} --pause-file ${f.pause}` }] }] } }), 'utf8');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: wrapper, settings_file: f.settings }), 'utf8');
    const r = runSync(GUARD, ['--config', f.cfg, '--once']);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/are the same file/);
    expect(readText(wrapper)).toBe('#!/bin/sh\nexec python3 "$@"\n');
  });

  it('a hook entry that runs the script directly needs an executable file: a copy of mode 0644 is reported, one of mode 0755 is accepted', () => {
    const f = fixture('direct-script', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const copy = join(f.dir, 'five-hour-guard-hook.py');
    copyFileSync(HOOK, copy);
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `[ -f ${f.pause} ] && [ -f ${copy} ] || exit 0; exec ${copy} --pause-file ${f.pause}` }] }] } }), 'utf8');
    chmodSync(copy, 0o644);
    expect(guardOnce(f).stdout).toMatch(/WARNING \(start\): .* runs .* directly, but it is not an executable file/);
    chmodSync(copy, 0o755);
    expect(guardOnce(f).stdout).not.toMatch(/WARNING/);
  });

  it('a stored pause with times outside any window the guard writes is ignored, not a crash at start', () => {
    const f = fixture('state-bounds', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    for (const bad of [{ since: 1, resume_at: 1e300 }, { since: 1e300, resume_at: now() + 600 }, { since: -1e300, resume_at: now() + 600 }, { since: 1, resume_at: -1e300 },
      { since: now(), resume_at: now() + 30 * 86400 }, { since: now() - 10, resume_at: now() - 100 }, { since: now() + 60, resume_at: now() + 10 }, { since: now() + 7200, resume_at: now() + 7300 }]) {
      writeFileSync(f.state, JSON.stringify({ paused: true, ...bad }), 'utf8');
      const r = guardOnce(f);
      expect(r.stdout, JSON.stringify(bad)).toMatch(/guard start/);
      expect(r.stderr).not.toMatch(/Traceback/);
    }
  });

  it('the temporary file of a write is created exclusively and never through a link that was put in its place', () => {
    const f = fixture('tmp-symlink', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    const victim = join(f.dir, 'victim.txt');
    const victimState = join(f.dir, 'victim-state.txt');
    writeFileSync(victim, 'keep me', 'utf8');
    writeFileSync(victimState, 'keep me too', 'utf8');
    symlinkSync(victim, `${f.pause}.4242.tmp`);        // what another account could pre-create in a shared directory
    symlinkSync(victimState, `${f.state}.4242.tmp`);
    const code = ['import os, runpy, sys', 'os.getpid = lambda: 4242', 'sys.argv = sys.argv[1:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const r = runPyCode(code, [GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(readText(victim), 'the file behind the link is untouched').toBe('keep me');
    expect(readText(victimState), 'so is the one behind the state link').toBe('keep me too');
    expect(readJson(f.pause).paused, 'and the pause was written').toBe(true);
    expect(lstatSync(f.pause).isSymbolicLink(), 'as a regular file').toBe(false);
  });

  it('a path with a NUL character in the configuration is a configuration error (exit 2), not a traceback', () => {
    const f = fixture('nul-path');
    for (const key of ['pause_file', 'state_file', 'usage_cache', 'log_file', 'settings_file']) {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, [key]: `${f.dir}/a\u0000b` }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${key}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/NUL/);
      expect(r.stderr).not.toMatch(/Traceback/);
    }
  });

  it('a configuration file that is empty, not UTF-8, a directory or a list is a configuration error (exit 2), not a traceback', () => {
    const f = fixture('cfg-forms');
    const forms: Array<[string, () => string]> = [
      ['empty', () => { writeFileSync(f.cfg, ''); return f.cfg; }],
      ['not UTF-8', () => { writeFileSync(f.cfg, Buffer.from([0x7b, 0xff, 0xfe, 0x7d])); return f.cfg; }],
      ['a list', () => { writeFileSync(f.cfg, '[]'); return f.cfg; }],
      ['a directory', () => { const d = join(f.dir, 'cfg-dir'); mkdirSync(d, { recursive: true }); return d; }],
    ];
    for (const [label, make] of forms) {
      const r = runSync(GUARD, ['--config', make(), '--once']);
      expect(r.status, `${label}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, label).not.toMatch(/Traceback/);
    }
  });

  it('unreadable forms of the cache, state file and settings file are warnings or a fresh start, never a crash; a huge pid in a pause file is not a crash', () => {
    const f = fixture('input-forms');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x7b]);
    for (const make of [() => writeFileSync(f.cache, bytes), () => writeFileSync(f.cache, ''), () => { rmSync(f.cache, { force: true }); mkdirSync(f.cache); }]) {
      rmSync(f.cache, { recursive: true, force: true });
      make();
      const r = guardOnce(f);
      expect(r.stdout).toMatch(/WARNING \(cache-unreadable\)/);
      expect(r.stderr).not.toMatch(/Traceback/);
    }
    rmSync(f.cache, { recursive: true, force: true });
    writeCache(f, { pct: 50, resetMs: Date.now() + HOUR_MS });
    for (const content of [bytes, Buffer.from('')]) {
      writeFileSync(f.state, content);
      expect(guardOnce(f).stdout).toMatch(/guard start/);
    }
    writeFileSync(f.settings, bytes);
    expect(guardOnce(f).stdout).toMatch(/WARNING \(start\): cannot read the hook entries of/);
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'exec "unterminated five-hour-guard-hook.py' }] }] } }), 'utf8');
    expect(guardOnce(f).stdout, 'a command the shell cannot parse').toMatch(/WARNING \(start\): the hook entry command .* cannot be parsed/);
    rmSync(f.state, { force: true });
    writePause(f, { pid: 99999999999999999999 });
    const huge = guardOnce(f);
    expect(huge.stderr).not.toMatch(/Traceback/);
    expect(existsSync(f.pause), 'a pid no process can have: the leftover is removed').toBe(false);
  });

  it('a stored pause that is over at start is cleared even when the state file cannot be written: an ERROR line, not a traceback', () => {
    const f = fixture('start-write-fails', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.state, JSON.stringify({ paused: true, since: now() - 700, resume_at: now() - 10 }), 'utf8');
    const code = ['import os, runpy, sys', 'real = os.replace',
      'def fail_on_state(src, dst, *a, **k):', '    if str(dst).endswith("state.json"): raise OSError(30, "Read-only file system")', '    return real(src, dst, *a, **k)',
      'os.replace = fail_on_state', 'sys.argv = sys.argv[1:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const r = runPyCode(code, [GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1); // the tick tries again, the write fails again
    expect(r.stdout).toMatch(/ERROR: cannot leave the stored pause cleanly at start/);
    expect(r.stdout).toMatch(/ERROR: tick failed/);
    expect(r.stderr).not.toMatch(/Traceback/);
    expect(readJson(f.state).paused, 'the disk still says paused: the transition was not forgotten').toBe(true);
    const again = guardOnce(f);
    expect(again.stdout).toMatch(/RESUMED/);
    expect(readJson(f.state).paused, 'and the next run persists it').toBe(false);
  });

  it('a pause is left in this order: the state is written first, the pause file removed after, so a failed write leaves the pause in force (also across a restart)', async () => {
    const f = fixture('state-write-retry', { cache: { pct: 97, resetMs: Date.now() + 3000 } });
    const flag = join(f.dir, 'break-state');
    const code = ['import os, runpy, sys', 'real = os.replace', 'flag = sys.argv[1]',
      'def maybe_fail(src, dst, *a, **k):', '    if str(dst).endswith("state.json") and os.path.exists(flag): raise OSError(30, "Read-only file system")', '    return real(src, dst, *a, **k)',
      'os.replace = maybe_fail', 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const g = spawnPyCode(code, [flag, GUARD, ...guardArgs(f, ['--margin', '0.5'])]);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'pause file');
      writeFileSync(flag, '');                                   // the state file cannot be written from now on
      await sleep(4500);                                         // the reset time (3 s) plus the margin has passed: the guard tries to leave the pause and fails
      expect(g.out, 'the guard did not log RESUMED').not.toMatch(/RESUMED/);
      expect(existsSync(f.pause), 'the pause file is still there: it is removed only after the state was written').toBe(true);
      expect(readJson(f.state).paused, 'and the disk agrees').toBe(true);
      unlinkSync(flag);
      await waitFor(() => !existsSync(f.pause), 20000, 'the pause ends once the state can be written');
      expect(readJson(f.state).paused).toBe(false);
    } finally { await stopGuard(g); }
  });

  it('an early resume whose state write fails keeps the pause (file and disk) even when the cache turns stale; it ends when the write works and a reading shows it', async () => {
    const f = fixture('early-resume-retry', { cache: { pct: 97, resetMs: Date.now() + HOUR_MS } });
    const flag = join(f.dir, 'break-state');
    const code = ['import os, runpy, sys', 'real = os.replace', 'flag = sys.argv[1]',
      'def maybe_fail(src, dst, *a, **k):', '    if str(dst).endswith("state.json") and os.path.exists(flag): raise OSError(30, "Read-only file system")', '    return real(src, dst, *a, **k)',
      'os.replace = maybe_fail', 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const g = spawnPyCode(code, [flag, GUARD, ...guardArgs(f, ['--max-age', '3'])]);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'pause file');
      writeFileSync(flag, '');
      writeCache(f, { pct: 50, resetMs: Date.now() + HOUR_MS, ageMs: 2000 }); // the early resume, stale about a second later
      await waitFor(() => /ERROR: tick failed/.test(g.out), 20000, 'the failed state write');
      await sleep(2500);
      expect(existsSync(f.pause), 'the pause file was not removed before the state could be written').toBe(true);
      expect(readJson(f.state).paused).toBe(true);
      unlinkSync(flag);
      writeCache(f, { pct: 50, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => !existsSync(f.pause), 20000, 'the early resume once the write works');
      expect(readJson(f.state).paused).toBe(false);
    } finally { await stopGuard(g); }
  });

  it('the hook is recognised by its place in the command, not by any path that holds its file name: a pause file or log named like the hook is not "the registered hook"', () => {
    const f = fixture('operand-names', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const pause = join(f.dir, 'five-hour-guard-hook.py.pause');
    const hookLog = join(f.dir, 'five-hour-guard-hook.py.log');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: pause, state_file: f.state, log_file: f.log, settings_file: f.settings, hook_log_file: hookLog }), 'utf8');
    const command = `[ -f ${pause} ] && [ -f ${HOOK} ] && [ -x ${PYBIN} ] || exit 0; exec ${PYBIN} -I ${HOOK} --pause-file ${pause} --log ${hookLog}`;
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } }), 'utf8');
    const r = guardOnce(f);
    expect(r.stdout, 'no wiring warning: the hook file exists, the pause file need not').not.toMatch(/WARNING/);
  });

  it('a handler that is not a command (prompt, http) is not the hook, whatever its old command field says', () => {
    const f = fixture('handler-type', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const command = `[ -f ${f.pause} ] && [ -f ${HOOK} ] || exit 0; exec ${PYBIN} -I ${HOOK} --pause-file ${f.pause}`;
    for (const type of ['prompt', 'http', 'agent', undefined]) {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ ...(type ? { type } : {}), command }] }] } }), 'utf8');
      expect(guardOnce(f).stdout, String(type)).toMatch(/WARNING \(start\): hook five-hour-guard-hook\.py is NOT registered/);
    }
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } }), 'utf8');
    expect(guardOnce(f).stdout).not.toMatch(/WARNING/);
  });

  it('a command that names the hook file only as data is not "the registered hook": an operand-only entry and a foreign tool given the file are reported as not registered', () => {
    const f = fixture('operand-only', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const pause = join(f.dir, 'five-hour-guard-hook.py.pause');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    for (const command of [`exec /bin/true --pause-file ${pause}`, `/x/foreign-audit.py ${HOOK}`, `python3 /x/audit.py --target ${HOOK}`, `grep -c five-hour-guard-hook.py /var/log/audit.log`]) {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      expect(guardOnce(f).stdout, command).toMatch(/WARNING \(start\): hook five-hour-guard-hook\.py is NOT registered/);
    }
    const real = `[ -f ${pause} ] && [ -f ${HOOK} ] || exit 0; exec ${PYBIN} -I ${HOOK} --pause-file ${pause}`;
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: real }] }] } }), 'utf8');
    expect(guardOnce(f).stdout, 'the real entry is still found').not.toMatch(/WARNING/);
  });

  it('a NUL character in a path of the registered entry is a wiring warning, not a traceback that the unit restarts for ever', () => {
    const f = fixture('registered-nul', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    for (const command of [`exec ${PYBIN} -I /opt/five-hour-guard-hook.py\0 --pause-file ${f.pause}`, `[ -x ${PYBIN}\0 ] || exit 0; exec ${PYBIN} -I ${HOOK} --pause-file ${f.pause}`,
      `exec ${PYBIN} -I ${HOOK} --pause-file ${f.pause} --log /opt/hook\0.log`]) {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      const r = runSync(GUARD, guardArgs(f, ['--once']));
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout).toMatch(/WARNING \(start\): the hook entry command .* cannot be parsed/);
      expect(r.stderr).not.toMatch(/Traceback/);
    }
  });

  it('a dangling symbolic link at pause_file is somebody else\'s path: refused at start (and by --test-pause), the link is kept', () => {
    const f = fixture('dangling-pause', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    symlinkSync(join(f.dir, 'nowhere'), f.pause);
    for (const extra of [['--once'], ['--test-pause', '1']]) {
      const r = runSync(GUARD, guardArgs(f, extra));
      expect(r.status, `${extra}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(lstatSync(f.pause).isSymbolicLink(), 'the link is still there').toBe(true);
    }
  });

  it('a stop while the removal of the pause file is still pending makes the final removal attempt (the state is already unpaused)', async () => {
    const f = fixture('stop-with-pending-removal', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const deny = join(f.dir, 'deny-unlink');
    const code = ['import os, runpy, sys', 'real = os.unlink', 'flag = sys.argv[1]',
      'def maybe(p, *a, **k):', '    if os.path.exists(flag) and str(p).endswith("pause.json"): raise PermissionError(13, "denied")', '    return real(p, *a, **k)',
      'os.unlink = maybe', 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const g = spawnPyCode(code, [deny, GUARD, ...guardArgs(f, ['--interval', '3', '--heartbeat', '10'])]);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'the pause');
      writeFileSync(deny, '', 'utf8');
      writeCache(f, { pct: 50, resetMs: Date.now() + HOUR_MS }); // a fresh low reading ends the pause at the next tick, and the removal is denied
      await waitFor(() => /cannot remove pause file/.test(readText(f.log)), 30000, 'the denied removal');
      expect(readJson(f.state).paused, 'the unpaused state was written').toBe(false);
      expect(existsSync(f.pause)).toBe(true);
      unlinkSync(deny);
      g.child.kill('SIGTERM'); // before the next tick (3 s away): only the shutdown path can still remove the file
      await Promise.race([g.done, sleep(20000)]);
      expect(g.exited && g.code === 0, `exit ${g.code}`).toBe(true);
    } finally { await g.stop(); }
    expect(existsSync(f.pause), 'the pause file is removed by the shutdown').toBe(false);
    expect(readText(f.log)).toMatch(/RESUMED \(guard stopping\)/);
  });

  it('CLAUDE_CONFIG_DIR is resolved as OMC does: ~ and both ~/ and ~\\ forms are expanded, other ~name is left alone', () => {
    const f = fixture('tilde-backslash');
    const home = join(f.dir, 'home');
    const cache = join(home, 'prof', 'plugins', 'oh-my-claudecode', '.usage-cache-anthropic.json');
    mkdirSync(join(home, 'prof', 'plugins', 'oh-my-claudecode'), { recursive: true });
    writeCache({ ...f, cache }, { pct: 99, resetMs: Date.now() + HOUR_MS });
    writeFileSync(f.cfg, JSON.stringify({ pause_file: f.pause, state_file: f.state }), 'utf8');
    for (const dir of ['~/prof', '~\\prof', '  ~\\prof  ']) {
      const r = runSync(GUARD, ['--config', f.cfg, '--once', '--dry-run'], { env: { ...ENV, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: dir } });
      expect(r.status, `${dir}: ${r.stderr}`).toBe(0);
      expect(r.stdout, dir).toMatch(/THRESHOLD: 5h 99\.0 %/);
    }
  });

  it('registered runtime files are protected after the fact: a hook or interpreter named by the settings entry cannot be the state file or log', () => {
    const f = fixture('alias-registered', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    const dir = join(f.dir, 'custom');
    mkdirSync(dir, { recursive: true });
    const hook = join(dir, 'five-hour-guard-hook.py');
    const py = join(dir, 'my-python');
    copyFileSync(HOOK, hook);
    writeFileSync(py, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const hookText = readFileSync(hook, 'utf8');
    const oldLog = join(dir, 'old-hook.log');
    const command = `[ -f ${f.pause} ] && [ -f ${hook} ] && [ -x ${py} ] || exit 0; exec ${py} -I ${hook} --pause-file ${f.pause} --log ${oldLog}`;
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } }), 'utf8');
    for (const [key, target] of [['state_file', hook], ['log_file', hook], ['state_file', py], ['log_file', py], ['state_file', oldLog], ['log_file', oldLog]] as const) {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, [key]: target }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${key} -> ${target}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/are the same file/);
      expect(readFileSync(hook, 'utf8'), 'the registered hook is intact').toBe(hookText);
      expect(readFileSync(py, 'utf8'), 'the registered interpreter is intact').toBe('#!/bin/sh\nexit 0\n');
    }
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, hook_log_file: oldLog }), 'utf8');
    expect(runSync(GUARD, ['--config', f.cfg, '--once']).status, 'the hook log of the configuration may be the log of the entry').toBe(0);
  });

  it('the lock file of the usage cache (OMC serialises refreshes on <cache>.lock) is a configured file: a pause file that is it is refused', () => {
    const f = fixture('alias-cache-lock', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: `${f.cache}.lock`, state_file: f.state }), 'utf8');
    const r = runSync(GUARD, ['--config', f.cfg, '--once']);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/are the same file/);
    expect(existsSync(`${f.cache}.lock`)).toBe(false);
  });

  it('the hook entry check warns when the group matcher no longer covers every tool (an entry for Bash only), and accepts "*", empty and none', () => {
    const f = fixture('matcher-drift', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const command = `[ -f ${f.pause} ] && [ -f ${HOOK} ] || exit 0; exec ${PYBIN} -I ${HOOK} --pause-file ${f.pause}`;
    const group = (matcher?: string) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command }] });
    for (const matcher of ['Bash', 'Write|Edit', 'Bash(*)']) {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [group(matcher)] } }), 'utf8');
      expect(guardOnce(f).stdout, matcher).toMatch(/WARNING \(start\): the hook entry in .* has the matcher '.*', which does not cover every tool/);
    }
    for (const matcher of ['*', '', undefined]) {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [group(matcher)] } }), 'utf8');
      expect(guardOnce(f).stdout, String(matcher)).not.toMatch(/WARNING/);
    }
  });

  it('the running scripts are configured files too: a state file or log that is the guard script (or its hook) is refused, the script is kept', () => {
    const f = fixture('alias-script', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    const dir = join(f.dir, 'installed');
    mkdirSync(dir, { recursive: true });
    const guard = join(dir, 'five-hour-guard.py');
    const hook = join(dir, 'five-hour-guard-hook.py');
    copyFileSync(GUARD, guard);
    copyFileSync(HOOK, hook);
    const before = readFileSync(guard, 'utf8');
    for (const [key, target] of [['state_file', guard], ['log_file', guard], ['pause_file', guard], ['state_file', hook], ['log_file', hook]] as const) {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, [key]: target }), 'utf8');
      const r = runSync(guard, ['--config', f.cfg, '--once']);
      expect(r.status, `${key} -> ${target}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/are the same file/);
      expect(readFileSync(guard, 'utf8'), 'the installed script is intact').toBe(before);
    }
  });

  it('a pause file whose pid is a live process but whose heartbeat has lapsed is a leftover (a recycled pid does not block the start)', () => {
    const f = fixture('recycled-pid', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writePause(f, { pid: process.pid, valid_until: now() - 600, resume_at: now() - 300 });
    const r = runSync(GUARD, guardArgs(f, ['--once']));
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(existsSync(f.pause), 'the lapsed pause is removed').toBe(false);
  });

  it('a pause file that cannot be removed after the state was written: an ERROR, the removal is retried at the next tick and by the next start', () => {
    const f = fixture('unlink-fails', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.state, JSON.stringify({ paused: true, since: now() - 700, resume_at: now() - 10 }), 'utf8');
    writePause(f, { pid: deadPid() });
    const code = ['import os, runpy, sys', 'real = os.unlink',
      'def deny(p, *a, **k):', '    if str(p).endswith("pause.json"): raise PermissionError(13, "denied")', '    return real(p, *a, **k)',
      'os.unlink = deny', 'sys.argv = sys.argv[1:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const r = runPyCode(code, [GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.stdout).toMatch(/ERROR/);
    expect(readJson(f.state).paused, 'the unpaused state was written before the file was touched').toBe(false);
    expect(existsSync(f.pause)).toBe(true);
    const again = guardOnce(f);
    expect(again.stdout).toMatch(/guard start/);
    expect(existsSync(f.pause), 'removed as a leftover once the file can be removed').toBe(false);
  });

  it('--max-age must be positive: a negative one makes every entry stale and the guard fail open for ever', () => {
    const f = fixture('max-age', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    for (const bad of ['-1', '0']) {
      const r = runSync(GUARD, guardArgs(f, ['--once', '--max-age', bad]));
      expect(r.status, `${bad}: ${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/--max-age must be at least 1 seconds/);
    }
  });

  it('a state file of the wrong shape is a start from nothing, not a crash that the unit would restart for ever', () => {
    const f = fixture('bad-state', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    for (const bad of ['[]', '"paused"', '{"paused":"yes","resume_at":1}', '{"paused":true,"resume_at":"x","since":1}', '{"paused":true,"resume_at":' + (Date.now() / 1000 + 600) + '}',
      '{"paused":true,"resume_at":NaN,"since":1}', 'not json']) {
      writeFileSync(f.state, bad, 'utf8');
      const r = guardOnce(f);
      expect(r.stdout, `state ${bad}`).toMatch(/guard start/);
      expect(r.stdout, `state ${bad}`).not.toMatch(/ERROR/);
    }
  });

  it('a usage entry that cannot be believed is a warning and holds nothing: percentage not finite or negative, timestamp not a number, no reset time at a high percentage', () => {
    const run = (name: string, text: string) => {
      const f = fixture(name);
      writeFileSync(f.cache, text, 'utf8');
      const r = guardOnce(f);
      expect(existsSync(f.pause), `${name}: nothing is held`).toBe(false);
      return r.stdout;
    };
    const ts = Date.now();
    const reset = new Date(ts + HOUR_MS).toISOString();
    expect(run('bad-nan', `{"timestamp": ${ts}, "data": {"fiveHourPercent": NaN, "fiveHourResetsAt": "${reset}"}}`)).toMatch(/WARNING \(cache-invalid-percent\)/);
    expect(run('bad-101', `{"timestamp": ${ts}, "data": {"fiveHourPercent": 101, "fiveHourResetsAt": "${reset}"}}`), 'above 100: the producer clamps, so it is not believed').toMatch(/WARNING \(cache-invalid-percent\)/);
    expect(run('bad-ts-inf', `{"timestamp": Infinity, "data": {"fiveHourPercent": 99, "fiveHourResetsAt": "${reset}"}}`), 'an infinite timestamp is not a time').toMatch(/WARNING \(cache-stale\)/);
    expect(run('bad-lastsuccess-inf', `{"timestamp": ${ts}, "error": "x", "lastSuccessAt": Infinity, "data": {"fiveHourPercent": 99, "fiveHourResetsAt": "${reset}"}}`)).toMatch(/WARNING \(cache-stale\)/);
    expect(run('bad-ts-future', `{"timestamp": ${ts + 3600e3}, "data": {"fiveHourPercent": 99, "fiveHourResetsAt": "${reset}"}}`), 'a timestamp an hour ahead is not believed').toMatch(/WARNING \(cache-future\)/);
    const full = fixture('pct-100', { cache: { pct: 100, resetMs: ts + HOUR_MS } });
    guardOnce(full);
    expect(existsSync(full.pause), 'exactly 100 is a valid percentage: the pause starts').toBe(true);
    expect(run('bad-string', `{"timestamp": ${ts}, "data": {"fiveHourPercent": "99", "fiveHourResetsAt": "${reset}"}}`), 'a string is not a number').toMatch(/WARNING \(cache-invalid-percent\)/);
    expect(run('bad-bool', `{"timestamp": ${ts}, "data": {"fiveHourPercent": true, "fiveHourResetsAt": "${reset}"}}`), 'a boolean is not a number').toMatch(/WARNING \(cache-invalid-percent\)/);
    expect(run('bad-ts-string', `{"timestamp": "${ts}", "data": {"fiveHourPercent": 99, "fiveHourResetsAt": "${reset}"}}`), 'a timestamp that is text is not a number').toMatch(/WARNING \(cache-stale\)/);
    expect(run('bad-neg', `{"timestamp": ${ts}, "data": {"fiveHourPercent": -3, "fiveHourResetsAt": "${reset}"}}`)).toMatch(/WARNING \(cache-invalid-percent\)/);
    expect(run('bad-inf', `{"timestamp": ${ts}, "data": {"fiveHourPercent": Infinity, "fiveHourResetsAt": "${reset}"}}`)).toMatch(/WARNING \(cache-invalid-percent\)/);
    expect(run('bad-ts', `{"timestamp": NaN, "data": {"fiveHourPercent": 99, "fiveHourResetsAt": "${reset}"}}`)).toMatch(/WARNING \(cache-stale\)/);
    expect(run('no-reset', `{"timestamp": ${ts}, "data": {"fiveHourPercent": 99, "fiveHourResetsAt": null}}`)).toMatch(/WARNING \(reset-missing\): 5h 99\.0 %, but the usage cache has no reset time/);
    expect(run('no-reset-low', `{"timestamp": ${ts}, "data": {"fiveHourPercent": 50, "fiveHourResetsAt": null}}`), 'a low percentage without a reset time is fine').not.toMatch(/WARNING/);
  });

  it('the hook entry is checked when a stored pause is restored too, not only on a start without a pause', () => {
    const f = fixture('restore-check', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    writeFileSync(f.settings, JSON.stringify({ hooks: {} }), 'utf8');
    writeFileSync(f.state, JSON.stringify({ paused: true, since: now() - 60, resume_at: now() + 600 }), 'utf8');
    const r = guardOnce(f);
    expect(r.stdout).toMatch(/start during a pause, resume at/);
    expect(r.stdout, 'the restored pause is not observed by any hook: said so').toMatch(/WARNING \(start\): hook five-hour-guard-hook\.py is NOT registered/);
  });

  it('hook entry check: a loud warning when settings.json has no hook entry or the entry names a hook file that does not exist', () => {
    const f = fixture('hook-check', { config: {}, cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const entry = (command: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } });
    writeFileSync(f.settings, JSON.stringify({ hooks: {} }), 'utf8');
    expect(guardOnce(f).stdout).toMatch(/WARNING \(start\): hook five-hour-guard-hook\.py is NOT registered/);
    writeFileSync(f.settings, entry(`[ -f ${f.pause} ] && [ -f ${HOOK} ] || exit 0; exec ${PYBIN} -I ${HOOK} --pause-file ${f.pause}`), 'utf8');
    expect(guardOnce(f).stdout, 'an entry whose hook file exists: no warning').not.toMatch(/WARNING/);
    writeFileSync(f.settings, entry(`exec ${PYBIN} -I /nonexistent-dir/five-hour-guard-hook.py --pause-file ${f.pause}`), 'utf8');
    expect(guardOnce(f).stdout).toMatch(/WARNING \(start\): the hook entry in .* names \/nonexistent-dir\/five-hour-guard-hook\.py, which does not exist/);
    writeFileSync(f.settings, entry(`[ -f ${f.pause} ] && [ -f ${HOOK} ] || exit 0; exec ${PYBIN} -I ${HOOK} --pause-file ${f.dir}/old-pause.json`), 'utf8');
    expect(guardOnce(f).stdout, 'a hook that reads another pause file than the guard writes').toMatch(/WARNING \(start\): the hook entry in .* reads the pause file .*old-pause\.json, but the guard writes .*pause\.json/);
    for (const command of [`exec ${PYBIN} -I ${HOOK}`, `exec ${PYBIN} -I ${HOOK} --pause-file`, `exec ${PYBIN} -I ${HOOK} --log ${f.dir}/hook.log`]) {
      writeFileSync(f.settings, entry(command), 'utf8');
      expect(guardOnce(f).stdout, command).toMatch(/WARNING \(start\): the hook entry in .* has no value for --pause-file: the hook would start without a pause file and hold nothing/);
    }
    writeFileSync(f.settings, entry(`[ -f ${f.pause} ] && [ -f ${HOOK} ] && [ -x /nonexistent-dir/python3 ] || exit 0; exec /nonexistent-dir/python3 -I ${HOOK} --pause-file ${f.pause}`), 'utf8');
    expect(guardOnce(f).stdout, 'an interpreter that does not exist').toMatch(/WARNING \(start\): the hook entry in .* names the interpreter \/nonexistent-dir\/python3, which does not exist/);
  });
});

describe.skipIf(!HAS_PYTHON3)('five-hour guard hook', { timeout: 90000 }, () => {
  it('holds while the pause is in force and returns when the pause file is removed; nothing is printed', async () => {
    const f = fixture('hook-hold');
    writePause(f);
    const h = startHook(f, 'other0001');
    await sleep(500);
    expect(h.exited, 'held').toBe(false);
    const t = Date.now();
    unlinkSync(f.pause);
    await Promise.race([h.done, sleep(20000)]);
    expect(h.exited && h.code === 0 && h.out === '' && h.err === '', 'exit 0, no output').toBe(true);
    // the pause above would hold for 60 s (valid_until): returning within seconds shows the hook notices the removed file
    expect(Date.now() - t, 'released by the poll, not by a deadline').toBeLessThan(20000);
  });

  it('an excluded prefix passes, another session is held; a test pause with "only" holds just those sessions', async () => {
    const f = fixture('hook-exclude');
    writePause(f, { exclude: ['5e1ec7ed'] });
    expect(await hookPasses(f, '5e1ec7ed-1111-2222-3333-444444444444'), 'excluded prefix passes').toBe(true);
    expect(await hookHeld(f, '7e1ec7ed-1111-2222-3333-444444444444'), 'another session is held').toBe(true);
    expect(await hookHeld(f, 'x'), 'a session id with no prefix in the list is held').toBe(true);

    const o = fixture('hook-only');
    writePause(o, { only: ['aaa1'] });
    expect(await hookHeld(o, 'aaa1-session'), 'the targeted session is held').toBe(true);
    expect(await hookPasses(o, 'bbb2-session'), 'a session outside "only" passes').toBe(true);
    writePause(o, { only: ['aaa1'], exclude: ['aaa1'] });
    expect(await hookPasses(o, 'aaa1-session'), 'exclude wins over only').toBe(true);
  });

  it('a session routed to another provider passes; the same call to anthropic.com is held', async () => {
    const f = fixture('hook-provider');
    writePause(f);
    expect(await hookPasses(f, 'other0001', { env: { ...ENV, ANTHROPIC_BASE_URL: 'https://gateway.example.test/api' } })).toBe(true);
    expect(await hookHeld(f, 'other0001', { env: { ...ENV, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } })).toBe(true);
  });

  it('a Bedrock or Vertex session (routing flag, no base URL) passes; the flag set to anything but 1 does not exempt', async () => {
    const f = fixture('hook-cloud');
    writePause(f);
    expect(await hookPasses(f, 'other0001', { env: { ...ENV, CLAUDE_CODE_USE_BEDROCK: '1' } }), 'Bedrock flag passes').toBe(true);
    expect(await hookPasses(f, 'other0001', { env: { ...ENV, CLAUDE_CODE_USE_VERTEX: '1' } }), 'Vertex flag passes').toBe(true);
    expect(await hookHeld(f, 'other0001', { env: { ...ENV, CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '' } }), 'flags that are off hold').toBe(true);
  });

  it('the provider is decided by the host of the base URL: case, subdomains, a scheme-less value and look-alike hosts', async () => {
    const f = fixture('hook-host');
    writePause(f);
    const withUrl = (url: string) => ({ env: { ...ENV, ANTHROPIC_BASE_URL: url } });
    for (const url of ['https://API.ANTHROPIC.COM', 'https://eu.api.anthropic.com:8443/v1', 'api.anthropic.com', 'https://anthropic.com']) {
      expect(await hookHeld(f, 'other0001', withUrl(url)), `${url} is Anthropic: held`).toBe(true);
    }
    for (const url of ['https://proxy-anthropic.com', 'https://anthropic.com.gateway.example.test', 'https://gateway.example.test/anthropic.com', 'gateway.example.test:8080']) {
      expect(await hookPasses(f, 'other0001', withUrl(url)), `${url} is not Anthropic: passes`).toBe(true);
    }
  });

  it('a session that does not draw on the subscription passes: API key, auth token, Foundry; a blank value or an OAuth token does not exempt', async () => {
    const f = fixture('hook-auth');
    writePause(f);
    const withEnv = (env: Record<string, string>) => ({ env: { ...ENV, ...env } });
    expect(await hookPasses(f, 'other0001', withEnv({ ANTHROPIC_API_KEY: 'sk-test-0000' })), 'API key').toBe(true);
    expect(await hookPasses(f, 'other0001', withEnv({ ANTHROPIC_AUTH_TOKEN: 'token-test-0000' })), 'auth token').toBe(true);
    expect(await hookPasses(f, 'other0001', withEnv({ CLAUDE_CODE_USE_FOUNDRY: '1' })), 'Foundry flag').toBe(true);
    expect(await hookHeld(f, 'other0001', withEnv({ ANTHROPIC_API_KEY: '  ', ANTHROPIC_AUTH_TOKEN: '' })), 'blank values hold').toBe(true);
    expect(await hookHeld(f, 'other0001', withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-0000' })), 'a subscription token holds').toBe(true);
  });

  it('a pause file with a value of the wrong type is not a pause: paused must be true, times numbers, exclude and only lists of strings', async () => {
    const f = fixture('hook-types');
    expect(await hookPasses(f, 'other0001'), 'no pause file: passes').toBe(true);
    for (const over of [{ paused: 'false' }, { paused: 'true' }, { paused: 1 }, { valid_until: String(now() + 60) }, { resume_at: String(now() + 600) },
      { valid_until: true }, { only: 'other0001' }, { exclude: 'zzz' }, { exclude: [5] }, { only: [null] }]) {
      writePause(f, over);
      expect(await hookPasses(f, 'other0001'), `${JSON.stringify(over)} passes`).toBe(true);
    }
    writePause(f);
    expect(await hookHeld(f, 'other0001'), 'a well-formed pause holds').toBe(true);
  });

  it('an event on stdin that is not a JSON object (a list, a text, null) is held like any other call, not passed by an exception', async () => {
    const f = fixture('hook-event-shape');
    writePause(f);
    for (const input of ['[]', '"text"', 'null', '42']) {
      const log = join(f.dir, `hook-event-${Buffer.from(input).toString('hex')}.log`);
      const h = spawnPy(HOOK, ['--pause-file', f.pause, '--log', log, '--poll', '0.1'], { env: ENV, input });
      try {
        await waitFor(() => /hold-start/.test(readText(log)) || h.exited, 20000, `hold-start for ${input}`);
        await sleep(300);
        expect(!h.exited && /hold-start/.test(readText(log)), `${input} is held`).toBe(true);
      } finally { await h.stop(); }
    }
  });

  it('a pause file without the published version (missing, other, text) is not a pause; unreadable forms of the file pass too', async () => {
    const f = fixture('hook-version');
    for (const over of [{ v: undefined }, { v: 1 }, { v: 3 }, { v: '2' }, { v: 2.5 }]) {
      writePause(f, over);
      expect(await hookPasses(f, 'other0001'), `${JSON.stringify(over)} passes`).toBe(true);
    }
    writePause(f);
    expect(await hookHeld(f, 'other0001'), 'version 2 holds').toBe(true);
    writeFileSync(f.pause, Buffer.from([0xff, 0xfe, 0x00, 0x7b]));
    expect(await hookPasses(f, 'other0001'), 'a file that is not UTF-8 passes').toBe(true);
    writeFileSync(f.pause, '');
    expect(await hookPasses(f, 'other0001'), 'an empty file passes').toBe(true);
    rmSync(f.pause, { force: true });
    mkdirSync(f.pause);
    expect(await hookPasses(f, 'other0001'), 'a directory passes').toBe(true);
  });

  it('a valid pause holds for as long as it lasts (2.5 s of polling), exit 0 only after the pause file is gone', async () => {
    const f = fixture('hook-long');
    writePause(f);
    const h = startHook(f, 'other0001');
    for (let i = 1; i <= 10; i++) {
      await sleep(250);
      expect(h.exited, `still held after ${i * 250} ms`).toBe(false);
    }
    unlinkSync(f.pause);
    await Promise.race([h.done, sleep(20000)]);
    expect(h.exited && h.code === 0, 'released with exit 0 once the pause file is gone').toBe(true);
    expect(readText(h.log)).toMatch(/hold-start other000 Bash/);
    const waited = /hold-end other000 Bash waited=(\d+)s/.exec(readText(h.log));
    expect(waited, 'hold-end line').not.toBeNull();
    expect(Number(waited?.[1]), 'waited at least the 2.5 s it was held').toBeGreaterThanOrEqual(2);
  });

  it('a --poll that is not a usable number does not crash the hook: it holds and releases as usual', async () => {
    for (const poll of ['abc', 'nan', 'inf']) {
      const f = fixture(`hook-poll-${poll}`);
      writePause(f);
      const h = spawnPy(HOOK, ['--pause-file', f.pause, '--poll', poll], { input: JSON.stringify({ session_id: 'other0001', tool_name: 'Bash' }) });
      await sleep(600);
      expect(h.exited, `--poll ${poll}: held, not crashed`).toBe(false);
      unlinkSync(f.pause);
      await Promise.race([h.done, sleep(20000)]);
      expect(h.exited && h.code === 0 && h.err === '', `--poll ${poll}: released`).toBe(true);
    }
  });

  it('--poll 0 does not spin a processor: three seconds of waiting cost a fraction of a second of processor time', () => {
    const f = fixture('hook-cpu');
    writePause(f, { valid_until: now() + 120 });
    const r = runPyCode(HOOK_CPU_DRIVER, [HOOK, f.pause, f.hookLog]);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.rc).toBe(0);
    expect(readText(f.hookLog), 'the hook was held for the three seconds').toMatch(/hold-end cpu00001 Bash waited=[3-9]s/);
    // measured on the scripts: 0.03 s with the floor of 0.1 s, 0.22 s with a floor of 1 ms, 0.9 s with no floor; the limit has a margin of four over the first
    expect(out.cpu, `processor time ${out.cpu} s`).toBeLessThan(0.12);
  });

  it('deadlines further ahead than the guard ever writes them are not believed: valid_until over an hour, resume_at over six hours', async () => {
    const f = fixture('hook-caps');
    writePause(f, { valid_until: now() + 3600 - 30 });
    expect(await hookHeld(f, 'other0001'), 'valid_until just under an hour ahead is held').toBe(true);
    writePause(f, { valid_until: now() + 3600 + 30 });
    expect(await hookPasses(f, 'other0001'), 'valid_until just over an hour ahead passes').toBe(true);
    writePause(f, { resume_at: now() + 21600 - 30 });
    expect(await hookHeld(f, 'other0001'), 'resume_at just under six hours ahead is held').toBe(true);
    writePause(f, { resume_at: now() + 21600 + 30 });
    expect(await hookPasses(f, 'other0001'), 'resume_at just over six hours ahead passes').toBe(true);
  });

  it('fail-open: no file, no pause argument, bad file, no heartbeat, deadline plus grace passed; a valid pause is the control', async () => {
    const f = fixture('hook-failopen');
    expect(await hookPasses(f, 'other0001'), 'no pause file').toBe(true);
    const noArg = spawnPy(HOOK, [], { input: JSON.stringify({ session_id: 'other0001', tool_name: 'Bash' }) });
    await Promise.race([noArg.done, sleep(20000)]);
    expect(noArg.exited && noArg.code === 0, 'no --pause-file').toBe(true);
    await noArg.stop();
    const cases: Array<[string, string]> = [
      ['not json', 'not json {'],
      ['empty object', '{}'],
      ['paused without deadlines', JSON.stringify({ paused: true })],
      ['paused without valid_until', JSON.stringify({ paused: true, resume_at: now() + 600 })],
      ['valid_until not a number', JSON.stringify({ paused: true, resume_at: now() + 600, valid_until: 'soon' })],
      ['not paused', JSON.stringify(pauseDoc({ paused: false }))],
      ['NaN deadlines (would compare false for ever)', '{"paused": true, "valid_until": NaN, "resume_at": NaN}'],
      ['infinite deadlines', '{"paused": true, "valid_until": Infinity, "resume_at": Infinity}'],
      ['no heartbeat (valid_until passed)', JSON.stringify(pauseDoc({ valid_until: now() - 1 }))],
      ['resume time passed by more than the grace period', JSON.stringify(pauseDoc({ resume_at: now() - 901 }))],
    ];
    for (const [label, text] of cases) {
      writeFileSync(f.pause, text, 'utf8');
      expect(await hookPasses(f, 'other0001'), `fail-open: ${label}`).toBe(true);
    }
    writePause(f, { resume_at: now() - 800 }); // inside the grace period: still held
    expect(await hookHeld(f, 'other0001'), 'resume time passed by less than the grace period is still held').toBe(true);
    writePause(f);
    expect(await hookHeld(f, 'other0001'), 'control: a valid pause holds the same session').toBe(true);
  });

  it('a pause that appears while sessions work holds them and releases them when the guard lets go (guard and hook together)', async () => {
    const f = fixture('together', { cache: { pct: 97, resetMs: Date.now() + 3500 } });
    const g = startGuard(f, ['--margin', '0.5']);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'pause file');
      const h = startHook(f, 'other0001');
      await waitFor(() => /hold-start/.test(readText(h.log)), 20000, 'hold-start');
      expect(h.exited, 'held while the guard keeps the pause').toBe(false);
      writeCache(f, { pct: 97, resetMs: Date.now() + 3500 }); // keep the cache fresh at the same percent
      await waitFor(() => !existsSync(f.pause), 20000, 'pause file removal at the reset time');
      await Promise.race([h.done, sleep(20000)]);
      expect(h.exited && h.code === 0, 'released with the pause file').toBe(true);
    } finally { await stopGuard(g); }
  });
});

describe('five-hour guard unit template', () => {
  it('three placeholders, a user service that restarts on failure but not on a configuration error', () => {
    const text = readFileSync(UNIT, 'utf8');
    const body = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n');
    for (const name of ['@PYTHON_BIN@', '@INSTALL_DIR@', '@CONFIG_FILE@']) expect(body.includes(name), `${name} is used`).toBe(true);
    const filled = body.replace(/@PYTHON_BIN@/g, '/usr/bin/python3').replace(/@INSTALL_DIR@/g, '/opt/x').replace(/@CONFIG_FILE@/g, '/etc/x.json');
    expect(filled.includes('@'), 'no other placeholder is left in the unit lines').toBe(false);
    const lines = filled.split('\n');
    expect(text.split('\n').some((l) => /^#\s*Environment=CLAUDE_CONFIG_DIR=/.test(l)), 'a commented Environment line for CLAUDE_CONFIG_DIR').toBe(true);
    expect(body.includes('Environment='), 'which is not active by default').toBe(false);
    for (const line of ['Type=simple', 'Restart=on-failure', 'RestartSec=10s', 'RestartPreventExitStatus=2', 'WantedBy=default.target', 'ExecStart=/usr/bin/python3 -I /opt/x/five-hour-guard.py --config /etc/x.json']) {
      expect(lines.includes(line), line).toBe(true);
    }
  });
});
