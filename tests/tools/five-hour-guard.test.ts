// Behaviour tests of the five-hour limit guard (tools/five-hour-guard/five-hour-guard.py), its PreToolUse hook
// (five-hour-guard-hook.py) and the systemd unit template. Everything runs on a fake usage cache in a temporary directory
// (see five-hour-guard-support.ts); the guard runs with a 0.2 s tick and a 5 s heartbeat, the hook with a 0.1 s poll.
// The budgets of the waits are generous on purpose: the tests check what happens, not how fast.
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENV, CONFIG_DIR, HOME_DIR, GUARD, HOOK, UNIT, PYBIN, HAS_PYTHON3, cleanup, fixture, hookHeld, hookPasses, now, pauseDoc,
  readJson, readText, runPyCode, runSync, sleep, spawnPy, spawnPyCode, startHook, waitFor, writeCache, writePause, type Fixture, type Proc,
} from './five-hour-guard-support.js';

afterAll(cleanup);

const HOUR_MS = 3600e3;
const MAX_RESET_AHEAD_MS = 5 * HOUR_MS + 900e3; // the guard believes no reset time further ahead than a window plus 15 minutes
// a pid that belonged to a process that has ended
const DEAD_PID = Number(spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim());
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
    mkdirSync(blocked.pause); // a directory where the pause file belongs: the write fails, and a single check says so by its status
    const once = runSync(GUARD, guardArgs(blocked, ['--once']));
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

  it('one guard per state file; a pause file of a live process that is not ours stays at start, a dead one is removed', async () => {
    const f = fixture('two-guards', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const a = startGuard(f);
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'first guard');
      const b = runSync(GUARD, guardArgs(f, ['--once']));
      expect(b.status, 'a second guard with the same state file').toBe(2);
      expect(b.stderr).toMatch(/another guard holds .*state\.json\.lock: one guard per state file/);
    } finally { await stopGuard(a); }
    expect(runSync(GUARD, guardArgs(f, ['--once'])).status, 'the lock goes with the first guard').toBe(0);

    const live = fixture('leftover-live', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writePause(live, { pid: process.pid }); // the process of this test: alive, and not the guard
    expect(guardOnce(live).stdout).toMatch(/WARNING \(start\): the pause file .* belongs to the running process \d+, left in place/);
    expect(existsSync(live.pause), 'the pause file of a live process stays').toBe(true);
    const dead = fixture('leftover-dead', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writePause(dead, { pid: DEAD_PID });
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
      writeCache(f, { pct: 99, resetMs: Date.now() + HOUR_MS });
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
    writePause(left, { pid: DEAD_PID });
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
    writePause(f, { pid: 111 });
    const r = guardOnce(f);
    expect(r.stdout).toMatch(/start during a pause, resume at/);
    expect(readJson(f.pause).paused, 'the pause file stays in force across the restart').toBe(true);
    expect(r.stdout).not.toMatch(/RESUMED/);

    const g = fixture('restart-over', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(g.state, JSON.stringify({ paused: true, since: now() - 700, resume_at: now() - 10 }), 'utf8');
    writePause(g, { pid: 111 });
    const r2 = guardOnce(g);
    expect(r2.stdout).toMatch(/RESUMED \(stored pause already over at start\)/);
    expect(existsSync(g.pause), 'a pause that is already over is not carried into the new run').toBe(false);
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
