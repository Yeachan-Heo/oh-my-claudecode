// Behaviour tests of the five-hour limit guard (tools/five-hour-guard/five-hour-guard.py), its PreToolUse hook
// (five-hour-guard-hook.py) and the systemd unit template. Everything runs on a fake usage cache in a temporary directory
// (see five-hour-guard-support.ts); the guard runs with a 0.2 s tick and a 5 s heartbeat, the hook with a 0.1 s poll.
// The budgets of the waits are generous on purpose: the tests check what happens, not how fast.
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, openSync, truncateSync, linkSync, lstatSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ENV, CONFIG_DIR, HOME_DIR, ENTRY_MODULE, GUARD, HOOK, SETTINGS_TOOL, UNIT, PYBIN, generatedCommand, HAS_PYTHON3, cleanup, fixture, hookHeld, hookInput, hookPasses, now, pauseDoc,
  readJson, readText, runPyCode, runSync, shellQuote, sleep, spawnPy, spawnPyCode, startHook, waitFor, writeCache, writePause, type Fixture, type Proc,
} from './five-hour-guard-support.js';

afterAll(cleanup);

const HOUR_MS = 3600e3;
const MAX_RESET_AHEAD_MS = 5 * HOUR_MS + 900e3; // the guard believes no reset time further ahead than a window plus 15 minutes
// A command of another hook that is not read to its end. A state or pause file that holds something else than the guard writes there
// stops the start; a log file of that kind does not (the guard starts and appends nothing to it). The caller checks that the file is
// as it was.
function expectUnread(r: SpawnSyncReturns<string>, key: string, label: string, why?: RegExp) {
  if (key === 'log_file') {
    expect(r.status, `${label}: ${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout, label).toMatch(/WARNING \(hook-unread\): \d+ command\(s\) in .* are not read to their end/);
    expect(r.stdout, label).toMatch(/the log file .* is a program that a command in .* runs: nothing is appended to it/);
    if (why) expect(r.stdout, label).toMatch(why);
  } else {
    expect(r.status, `${label}: ${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr, label).toMatch(/not read to its end/);
    if (why) expect(r.stderr, label).toMatch(why);
  }
  expect(r.stderr, label).not.toMatch(/Traceback/);
}
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
// the quoting that builds the generated entry (shlex.quote, used by the wiring check to write the entry it compares with) fails inside the guard
const QUOTE_FAILS_DRIVER = [
  'import runpy, shlex, sys',
  'def quote(*args, **kwargs):',
  '    raise RuntimeError("lookup failed")',
  'shlex.quote = quote',
  'sys.argv = sys.argv[1:]',
  "runpy.run_path(sys.argv[0], run_name='__main__')",
].join('\n');
// the guard runs where os has no O_NOFOLLOW (Windows): the attribute is taken away before the script is loaded
const NO_NOFOLLOW_DRIVER = ['import os, runpy, sys', 'del os.O_NOFOLLOW', 'sys.argv = sys.argv[1:]', "runpy.run_path(sys.argv[0], run_name='__main__')"].join('\n');
// the same, and lstat reports the file named by argv[1] as a reparse point (a Windows file attribute that lstat has no way to show on other systems)
const NO_NOFOLLOW_REPARSE_DRIVER = [
  'import os, runpy, sys', 'del os.O_NOFOLLOW', 'real, marked = os.lstat, sys.argv[1]',
  'class Reparse:', '    def __init__(self, st):', '        self.st_mode, self.st_file_attributes = st.st_mode, 0x400',
  'def lstat(path, *args, **kwargs):', '    st = real(path, *args, **kwargs)', '    return Reparse(st) if path == marked else st',
  'os.lstat = lstat', 'sys.argv = sys.argv[2:]', "runpy.run_path(sys.argv[0], run_name='__main__')",
].join('\n');
// settings.json is rewritten, and the file at the log path replaced, at the moment the wiring check of the start opens settings.json: after the
// line "guard start" and before the check, whatever the speed of the machine (argv: settings.json, the document that replaces it, the log, the file copied to the log)
const REWRITE_AT_WIRING_CHECK_DRIVER = [
  'import builtins, runpy, shutil, sys',
  'real, settings, replacement, log, program = builtins.open, sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]',
  'done = []',
  'def spy(path, *args, **kw):',
  '    if str(path) == settings and not done and sys._getframe(1).f_code.co_name == "check_wiring":',
  '        done.append(1)',
  '        shutil.copyfile(replacement, settings)',
  '        shutil.copyfile(program, log)',
  '    return real(path, *args, **kw)',
  'builtins.open = spy',
  'sys.argv = sys.argv[5:]',
  "runpy.run_path(sys.argv[0], run_name='__main__')",
].join('\n');
// the guard runs in another working directory (a relative path of a settings entry is read from it)
const CHDIR_DRIVER = ['import os, runpy, sys', 'os.chdir(sys.argv[1])', 'sys.argv = sys.argv[2:]', "runpy.run_path(sys.argv[0], run_name='__main__')"].join('\n');
// the first reads of the usage cache from the given time on (argv: cache, time, count) see what a refresh of OMC shows in the middle: an empty file, then half a document
const TORN_CACHE_DRIVER = [
  'import builtins, io, runpy, sys, time',
  'real, cache, since, torn = builtins.open, sys.argv[1], float(sys.argv[2]), [int(sys.argv[3])]',
  'def spy(path, *args, **kw):',
  '    if str(path) == cache and time.time() >= since and torn[0] > 0:',
  '        torn[0] -= 1',
  '        return io.StringIO("" if torn[0] % 2 else \'{"timestamp": 17\')',
  '    return real(path, *args, **kw)',
  'builtins.open = spy',
  'sys.argv = sys.argv[4:]',
  "runpy.run_path(sys.argv[0], run_name='__main__')",
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

const HAS_BASH = spawnSync('bash', ['-c', 'true']).status === 0;

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
    // the temporary file of a write cannot be created (a full disk): the write fails, and a single check says so by its status
    const once = runPyCode(['import os, runpy, sys', 'real = os.open', 'def full(path, *a, **k):', '    if str(path).endswith(".tmp"): raise OSError(28, "No space left on device")', '    return real(path, *a, **k)', 'os.open = full',
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
    const accepted = [['--margin', '1800'], ['--margin', '0'], ['--heartbeat', '1800'], ['--heartbeat', '1.4', '--interval', '0.2'],
      ['--interval', '0.1', '--heartbeat', '1.2'], ['--interval', '899', '--heartbeat', '1800'], ['--warn-every', '0'], ['--warn-every', '86400']];
    for (const args of accepted) expect(once(args).status, args.join(' ')).toBe(0);
    const refused = [['--margin', '1801'], ['--margin', '-1'], ['--heartbeat', '1801'], ['--heartbeat', '0.3', '--interval', '0.2'], ['--heartbeat', '0.4', '--interval', '0.2'], ['--heartbeat', '1.39', '--interval', '0.2'],
      ['--interval', '0.05'], ['--interval', '900', '--heartbeat', '1800'], ['--interval', '901', '--heartbeat', '1800'], ['--warn-every', '-1'], ['--warn-every', '86401'], ['--test-pause', '1801'], ['--test-pause', '-5']];
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

  it('a slip that takes a pause beyond the hook timeout is reported once with what it means, and the pause is still extended (a cap would open a gap for the calls that arrive later)', async () => {
    const f = fixture('slip-beyond-timeout', { cache: { pct: 97, resetMs: Date.now() + 3000 * 1000 } });
    writeFileSync(f.state, JSON.stringify({ paused: true, since: now() - 21000, resume_at: now() + 2 }), 'utf8');
    const g = startGuard(f);
    try {
      await waitFor(() => /reset slipped/.test(readText(f.log)), 20000, 'slip line');
      const log = readText(f.log);
      expect(log).toMatch(/WARNING \(pause-beyond-timeout\): the pause now lasts .* longer than the 21600 s minimum timeout of the hook entry/);
      expect(existsSync(f.pause), 'the pause goes on').toBe(true);
      // the slip is logged before the pause file is rewritten: wait for the write (under load a read right after the line sees the old file)
      await waitFor(() => existsSync(f.pause) && readJson(f.pause).resume_at > now() + 2900, 20000, 'the pause file extended to the reset plus margin');
    } finally { await stopGuard(g); }

    const short = fixture('slip-within-timeout', { cache: { pct: 97, resetMs: Date.now() + 3000 * 1000 } });
    writeFileSync(short.state, JSON.stringify({ paused: true, since: now() - 1000, resume_at: now() + 2 }), 'utf8');
    const g2 = startGuard(short);
    try {
      await waitFor(() => /reset slipped/.test(readText(short.log)), 20000, 'slip line');
      expect(readText(short.log), 'a pause that stays within the timeout is not reported').not.toMatch(/minimum timeout/);
    } finally { await stopGuard(g2); }
  });

  it('a read of the usage cache that catches a refresh in the middle (an empty or a half-written document) is repeated: the tick that ends a pause does not take it for stale data and release the calls', async () => {
    const f = fixture('torn-read', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const resumeAt = now() + 2;
    writeFileSync(f.state, JSON.stringify({ paused: true, since: now() - 60, resume_at: resumeAt }), 'utf8');
    const g = spawnPyCode(TORN_CACHE_DRIVER, [f.cache, String(resumeAt), '3', GUARD, ...guardArgs(f)]);
    try {
      await waitFor(() => /reset slipped|RESUMED/.test(readText(f.log)), 20000, 'the tick after the resume time');
      expect(readText(f.log), 'the pause is extended: the reading is still high with a later reset').toMatch(/reset slipped: 5h still 98\.0 %/);
      expect(readText(f.log)).not.toMatch(/RESUMED|fail-open/);
      expect(existsSync(f.pause), 'the pause file is still there').toBe(true);
    } finally { await stopGuard(g); }

    // a cache that stays unreadable is not waited for for ever: the reads stop and the entry is stale as before
    const bad = fixture('torn-read-permanent', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const badResume = now() + 2;
    writeFileSync(bad.state, JSON.stringify({ paused: true, since: now() - 60, resume_at: badResume }), 'utf8');
    const gb = spawnPyCode(TORN_CACHE_DRIVER, [bad.cache, String(badResume), '1000', GUARD, ...guardArgs(bad)]);
    try {
      await waitFor(() => /RESUMED \(reset time reached \(cache stale, fail-open\)\)/.test(readText(bad.log)), 30000, 'the release on an unreadable cache');
      expect(readText(bad.log)).toMatch(/WARNING \(cache-unreadable\)/);
    } finally { await stopGuard(gb); }
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

  it('the default early-resume cutoff can be undercut for every allowed threshold: 10 under the threshold, never under half of it (a cutoff of 0 or less would end no pause early)', () => {
    const run = (f: Fixture, t: number) => runSync(GUARD, ['--config', f.cfg, '--once', '--threshold', String(t)]);
    const cutoffOf = (t: number) => (t - 10 >= t / 2 ? t - 10 : t / 2) || t;   // the rule as the README states it, from the threshold alone
    const thresholds = [Number.MIN_VALUE, 0.01, 1, 5, 9.99, 10, 10.01, 15, 19.99, 20, 20.01, 50, 97, 100];
    for (const t of thresholds) {
      const f = fixture(`resume-default-${t}`, { cache: { pct: t, resetMs: Date.now() + HOUR_MS } });
      const entered = run(f, t);
      expect(entered.status, `threshold ${t}: ${entered.stdout}${entered.stderr}`).toBe(0);
      expect(existsSync(f.pause), `threshold ${t}: the pause is entered at the threshold`).toBe(true);
      const cutoff = cutoffOf(t);
      expect(cutoff, `threshold ${t}: a cutoff that a percentage can undercut`).toBeGreaterThan(0);
      expect(cutoff, `threshold ${t}: and that is not above the threshold`).toBeLessThanOrEqual(t);
      if (cutoff < t) {   // a reading between the cutoff and the threshold keeps the pause
        writeCache(f, { pct: (cutoff + t) / 2, resetMs: Date.now() + HOUR_MS });
        const kept = run(f, t);
        expect(kept.status, `threshold ${t}: ${kept.stdout}${kept.stderr}`).toBe(0);
        expect(existsSync(f.pause), `threshold ${t}: a reading above the cutoff keeps the pause`).toBe(true);
      }
      writeCache(f, { pct: Math.max(0, cutoff - 0.5), resetMs: Date.now() + HOUR_MS });   // below the cutoff; 0 where the cutoff is under 0.5
      const resumed = run(f, t);
      expect(resumed.status, `threshold ${t}: ${resumed.stdout}${resumed.stderr}`).toBe(0);
      expect(resumed.stdout, `threshold ${t}: the early resume is logged`).toMatch(/RESUMED \(window reset seen early/);
      expect(existsSync(f.pause), `threshold ${t}: the pause file is gone after the early resume`).toBe(false);
    }
    // an explicit --resume-below still wins, 0 included (no early resume at all)
    const f = fixture('resume-explicit', { cache: { pct: 97, resetMs: Date.now() + HOUR_MS } });
    expect(runSync(GUARD, ['--config', f.cfg, '--once', '--resume-below', '0']).status).toBe(0);
    writeCache(f, { pct: 0, resetMs: Date.now() + HOUR_MS });
    expect(runSync(GUARD, ['--config', f.cfg, '--once', '--resume-below', '0']).status).toBe(0);
    expect(existsSync(f.pause), 'a cutoff of 0 ends no pause early').toBe(true);
  }, 120000);

  it('the default heartbeat follows the interval: every interval that a heartbeat can cover starts without --heartbeat, a longer one is refused, an explicit heartbeat is kept', () => {
    const published = (iv: number, extra: string[] = []) => {
      const f = fixture(`heartbeat-default-${iv}-${extra.join('')}`, { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
      const r = runSync(GUARD, ['--config', f.cfg, '--once', '--interval', String(iv), ...extra]);
      return { r, f };
    };
    for (const iv of [0.1, 1, 30, 149.5, 149.6, 150, 200, 449.5, 899, 899.5]) {
      const { r, f } = published(iv);
      expect(r.status, `--interval ${iv}: ${r.stdout}${r.stderr}`).toBe(0);
      const doc = readJson(f.pause);
      const heartbeat = Math.min(Math.max(300, 2 * iv + 1), 1800);   // 300 s, or two intervals plus a second when that is more, at most 1800
      expect(doc.valid_until - doc.since, `--interval ${iv}: the pause file is valid for the default heartbeat`).toBeGreaterThanOrEqual(heartbeat);
      expect(doc.valid_until - doc.since, `--interval ${iv}: and for no longer`).toBeLessThan(heartbeat + 10);
      expect(doc.valid_until - doc.since, `--interval ${iv}: and outlives two ticks`).toBeGreaterThan(2 * iv);
    }
    for (const iv of [899.6, 900, 1000]) {
      const { r, f } = published(iv);
      expect(r.status, `--interval ${iv}`).toBe(2);
      expect(r.stderr, `--interval ${iv}`).toMatch(/--heartbeat must be between/);
      expect(existsSync(f.pause), 'no pause was written').toBe(false);
    }
    const { r, f } = published(30, ['--heartbeat', '100']);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(readJson(f.pause).valid_until - readJson(f.pause).since, 'an explicit heartbeat is kept').toBeLessThan(110);
  }, 120000);

  it('the pause file must be an absolute path (the hook entry only accepts an absolute one)', () => {
    const f = fixture('relative-pause');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: 'pause.json', state_file: f.state }), 'utf8');
    const r = runSync(GUARD, ['--config', f.cfg, '--once']);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/"pause_file" must be an absolute path/);
  });

  it('hook_log_file of the configuration must be an absolute path too: the entry the guard offers to paste would carry it into every session', () => {
    const f = fixture('relative-hook-log-config', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, hook_log_file: 'logs/hook.log' }), 'utf8');
    const r = runSync(GUARD, ['--config', f.cfg, '--once']);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/"hook_log_file" must be an absolute path/);
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, hook_log_file: f.hookLog }), 'utf8');
    expect(guardOnce(f).status, 'an absolute hook log is accepted').toBe(0);
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
    const entry = (command: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } });
    writeFileSync(f.settings, entry(generatedCommand(f.pause, HOOK, PYBIN)), 'utf8');
    const g = startGuard(f, ['--warn-every', '1']);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'the pause');
      expect(readText(f.log), 'a wired hook: no warning').not.toMatch(/WARNING/);
      writeFileSync(f.settings, JSON.stringify({ hooks: {} }), 'utf8');
      await waitFor(() => /WARNING \(pause\): hook five-hour-guard-hook\.py is NOT registered/.test(readText(f.log)), 20000, 'the wiring warning during the pause');
    } finally { await stopGuard(g); }
  });

  it('a hook log that is a runtime file of the guard is reported at every wiring check, also when a settings rewrite after the start put it there: the entry to paste does not copy it', async () => {
    const f = fixture('wiring-log-alias', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const entry = (command: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } });
    writeFileSync(f.settings, entry(generatedCommand(f.pause, HOOK, PYBIN)), 'utf8');
    const g = startGuard(f, ['--warn-every', '1']);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'the pause');
      expect(readText(f.log), 'a wired hook: no warning').not.toMatch(/WARNING/);
      writeFileSync(f.settings, entry(generatedCommand(f.pause, HOOK, PYBIN, f.pause)), 'utf8');
      await waitFor(() => /WARNING \(pause\): the hook entry in .* names .*pause\.json, which is the pause_file of this guard/.test(readText(f.log)), 20000, 'the alias warning');
      const drift = readText(f.log).split('\n').filter((l) => /is not the entry this guard generates/.test(l));
      for (const line of drift) expect(line.endsWith(`: ${generatedCommand(f.pause, HOOK, PYBIN)}`), line).toBe(true);
    } finally { await stopGuard(g); }
  });

  it('a hook log that is the hook program or its launcher is reported when a settings rewrite after the start put it there, as the start would refuse it', async () => {
    const dir = join(fixture('wiring-log-program', {}).dir, 'custom');
    mkdirSync(dir, { recursive: true });
    const hook = join(dir, 'five-hour-guard-hook.py');
    const py = join(dir, 'my-python');
    copyFileSync(HOOK, hook);
    writeFileSync(py, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const cases: Array<[string, string, string, RegExp]> = [
      ['bundled-hook', HOOK, PYBIN, /names .*five-hour-guard-hook\.py, which is the hook script of this guard/],
      ['registered-hook', hook, PYBIN, /names .*custom\/five-hour-guard-hook\.py, which is the registered hook of this guard/],
      ['registered-launcher', hook, py, /names .*my-python, which is the registered interpreter of this guard/],
    ];
    for (const [name, entryHook, python, expected] of cases) {
      const f = fixture(`wiring-log-${name}`, { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
      const entry = (command: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } });
      writeFileSync(f.settings, entry(generatedCommand(f.pause, entryHook, python)), 'utf8');
      const hookBefore = readFileSync(entryHook, 'utf8');
      const g = startGuard(f, ['--warn-every', '1']);
      try {
        await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start');
        const logTarget = name === 'registered-launcher' ? python : entryHook;
        writeFileSync(f.settings, entry(generatedCommand(f.pause, entryHook, python, logTarget)), 'utf8');
        writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
        await waitFor(() => expected.test(readText(f.log)), 20000, `the alias warning (${name})`);
      } finally { await stopGuard(g); }
      expect(readFileSync(entryHook, 'utf8'), 'the program is intact').toBe(hookBefore);
    }
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

  it('where no lock is available a guard that finds a live guard\'s pause when it enters a pause leaves it alone: the pause stays with its owner and its stop does not remove it', async () => {
    // both guards start while the pause file is absent, so both pass the check of the start; the first one then publishes
    const noLocks = ['import runpy, sys', 'sys.modules["fcntl"] = None', 'sys.modules["msvcrt"] = None', 'sys.argv = sys.argv[1:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const a = fixture('nolock-owner-a', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const b = fixture('nolock-owner-b', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS }, config: { pause_file: a.pause } });
    const first = spawnPyCode(noLocks, [GUARD, ...guardArgs(a)]);
    const second = spawnPyCode(noLocks, [GUARD, ...guardArgs(b)]);
    try {
      await waitFor(() => /guard start/.test(readText(a.log)) && /guard start/.test(readText(b.log)), 20000, 'both guards started');
      writeCache(a, { pct: 99, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => existsSync(a.pause), 20000, 'the pause of the first guard');
      expect(readJson(a.pause).pid).toBe(first.child.pid);
      const late = runPyCode(noLocks, [GUARD, ...guardArgs(b, ['--once'])]);
      expect(late.status, 'a guard that starts when the pause of the first is there does not start').toBe(2);
      expect(late.stderr).toMatch(/belongs to the running process/);
      writeCache(b, { pct: 99, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => /belongs to the running process/.test(readText(b.log)), 20000, 'the second guard refuses to publish over the pause of the first');
      await sleep(600); // a few more ticks of both guards
      expect(readJson(a.pause).pid, 'the pause is still the first guard\'s').toBe(first.child.pid);
      await stopGuard(second);
      expect(existsSync(a.pause), 'stopping the second guard leaves the pause of the first in force').toBe(true);
    } finally { await stopGuard(second); await stopGuard(first); }
    expect(existsSync(a.pause), 'stopping the first guard removes its pause').toBe(false);
    expect(readJson(a.state).paused, 'and stores "not paused"').toBe(false);
  });

  it('where no lock is available two guards that cross their first publication leave the pause of the winner in force when the loser stops: the cleanup of the loser does not remove a pause that a live process published', async () => {
    // the loser has stored its pause and finds the winner's file at the moment it links its own into place (the driver writes it there)
    const driver = [
      'import os, runpy, sys', 'sys.modules["fcntl"] = None', 'sys.modules["msvcrt"] = None',
      'real, target, text = os.link, os.path.abspath(sys.argv[1]), sys.argv[2]',
      'def link(src, dst, *a, **k):', '    if os.path.abspath(str(dst)) == target and not os.path.lexists(target):',
      '        with open(target, "w") as f: f.write(text)', '    return real(src, dst, *a, **k)',
      'os.link = link', 'sys.argv = sys.argv[3:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const f = fixture('nolock-crossing', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const winner = JSON.stringify(pauseDoc({ pid: process.pid, valid_until: now() + 3600 }));   // the process of this test: alive, with a current heartbeat
    const loser = spawnPyCode(driver, [f.pause, winner, GUARD, ...guardArgs(f)]);
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start');
      writeCache(f, { pct: 99, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => /appeared meanwhile/.test(readText(f.log)), 20000, 'the loser finds the file of the winner at its link');
      expect(readJson(f.state).paused, 'the loser has stored a pause').toBe(true);
      expect(readJson(f.pause).pid, 'the pause file is the winner\'s').toBe(process.pid);
    } finally { await stopGuard(loser); }
    expect(existsSync(f.pause), 'stopping the loser leaves the pause of the winner in force').toBe(true);
    expect(readJson(f.pause).pid, 'it is still the winner\'s').toBe(process.pid);
    expect(readJson(f.state).paused, 'the loser does not store "not paused" under the pause of the winner').toBe(true);
  });

  it('the files that the guard reads are not read to their end: a pause file, a usage cache, a state file or a configuration larger than the limit is read like a document that cannot be decoded', () => {
    const big = 'x'.repeat(1100000);   // more than the 1 MiB limit, a valid document otherwise
    const f = fixture('oversized-documents', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    // a pause file of a dead guard is a leftover that the start removes; one over the limit is not a pause file of this guard, so it is kept and the start refuses
    writePause(f, { pid: deadPid() });
    expect(guardOnce(f).status).toBe(0);
    expect(existsSync(f.pause), 'a pause file within the limit is a leftover and is removed').toBe(false);
    writePause(f, { pid: deadPid(), exclude: [big] });
    const size = readText(f.pause).length;
    const refused = runSync(GUARD, ['--config', f.cfg, ...FAST, '--once']);
    expect(refused.status, `${refused.stdout}${refused.stderr}`).toBe(2);
    expect(refused.stderr).toMatch(/is not a pause file of this guard/);
    expect(readText(f.pause).length, 'the file is untouched').toBe(size);
    rmSync(f.pause, { force: true });
    // a usage cache over the limit is an unreadable cache, a state file over the limit is no stored state
    writeFileSync(f.cache, JSON.stringify({ ...f.cache, padding: big }), 'utf8');
    expect(guardOnce(f).stdout).toMatch(/WARNING \(cache-unreadable\)/);
    writeCache(f, { pct: 50, resetMs: Date.now() + HOUR_MS });
    writeFileSync(f.state, JSON.stringify({ paused: true, since: now() - 10, resume_at: now() + 600, padding: big }), 'utf8');
    guardOnce(f);
    expect(existsSync(f.pause), 'a stored pause over the limit is not restored').toBe(false);
    // a configuration over the limit is refused as a file that cannot be read
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, padding: big }), 'utf8');
    const config = runSync(GUARD, ['--config', f.cfg, ...FAST, '--once']);
    expect(config.status, `${config.stdout}${config.stderr}`).toBe(2);
    expect(config.stderr).toMatch(/cannot read configuration/);
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
      // without O_NOFOLLOW the open itself would follow the link: the link is refused before it
      const bare = runPyCode(NO_NOFOLLOW_DRIVER, [GUARD, ...guardArgs(f, ['--once'])]);
      expect(bare.status, `${bare.stdout}${bare.stderr}`).toBe(0);
      expect(existsSync(absent), 'without O_NOFOLLOW: a link to a missing file does not create it').toBe(false);
      expect(readText(victim), 'without O_NOFOLLOW: the guard did not write through the link').toBe('victim\n');
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
    // the refusal is for links only: an ordinary log is still written where os has no O_NOFOLLOW
    const plain = fixture('log-plain-no-nofollow', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const ok = runPyCode(NO_NOFOLLOW_DRIVER, [GUARD, ...guardArgs(plain, ['--once'])]);
    expect(ok.status, `${ok.stdout}${ok.stderr}`).toBe(0);
    expect(readText(plain.log), 'the log is written').toMatch(/guard start/);
  });

  it('where os has no O_NOFOLLOW (Windows) the hook refuses a log that is a link or a reparse point, and still writes an ordinary log', async () => {
    const f = fixture('hook-log-no-nofollow', {});
    const victim = join(f.dir, 'victim.txt');
    const absent = join(f.dir, 'not-created.txt');
    const marked = join(f.dir, 'reparse.txt');
    const link = join(f.dir, 'log-link.txt');
    const control = join(f.dir, 'control.log');
    writeFileSync(victim, 'victim\n', 'utf8');
    writeFileSync(marked, 'kept\n', 'utf8');
    // the hook under test holds while a pause lasts, next to one with an ordinary log, which shows that the hold has begun
    const hold = async (driver: string, lead: string[], log: string) => {
      rmSync(control, { force: true });
      writePause(f, { pid: process.pid });
      const h = spawnPyCode(driver, [...lead, HOOK, '--pause-file', f.pause, '--log', log, '--poll', '0.1'], { input: hookInput('nofollow-a') });
      const c = spawnPyCode(NO_NOFOLLOW_DRIVER, [HOOK, '--pause-file', f.pause, '--log', control, '--poll', '0.1'], { input: hookInput('nofollow-b') });
      try {
        await waitFor(() => /hold-start/.test(readText(control)), 20000, 'the hold-start of the hook with an ordinary log');
        await sleep(500);
        expect(h.exited, 'the hook holds').toBe(false);
        unlinkSync(f.pause);
        await Promise.race([h.done, sleep(20000)]);
        await Promise.race([c.done, sleep(20000)]);
      } finally { await h.stop(); await c.stop(); }
    };
    for (const target of [victim, absent]) {
      rmSync(link, { force: true });
      symlinkSync(target, link);
      await hold(NO_NOFOLLOW_DRIVER, [], link);
      expect(existsSync(absent), 'a link to a missing file does not create it').toBe(false);
      expect(readText(victim), 'the hook did not write through the link').toBe('victim\n');
    }
    await hold(NO_NOFOLLOW_REPARSE_DRIVER, [marked], marked);
    expect(readText(marked), 'a reparse point is not written').toBe('kept\n');
    // the refusal is for links and reparse points only: an ordinary log is written where os has no O_NOFOLLOW
    expect(readText(control), 'the ordinary log is written').toMatch(/hold-start/);
  });

  it('a held call is judged again against every pause document it sees: a replacement that excludes the session (a restart with another exclude, no gap) releases it', async () => {
    const f = fixture('hold-reevaluated', {});
    writePause(f, { pid: process.pid });
    const sid = 'abcd1234-held';
    const h = startHook(f, sid);
    try {
      await waitFor(() => /hold-start/.test(readText(h.log)), 20000, 'hold-start');
      await sleep(400);
      expect(h.exited, 'held while nothing excludes the session').toBe(false);
      writePause(f, { pid: process.pid, exclude: ['abcd'] });
      await Promise.race([h.done, sleep(20000)]);
      expect(h.exited && h.code === 0, `released, exit ${h.code}`).toBe(true);
      expect(readText(h.log)).toMatch(/hold-end/);
    } finally { await h.stop(); }
    const other = fixture('hold-reevaluated-only', {});
    writePause(other, { pid: process.pid });
    const h2 = startHook(other, 'zzzz9999-held');
    try {
      await waitFor(() => /hold-start/.test(readText(h2.log)), 20000, 'hold-start');
      writePause(other, { pid: process.pid, only: ['abcd'] });
      await Promise.race([h2.done, sleep(20000)]);
      expect(h2.exited && h2.code === 0, `released by a replacement that holds only other sessions, exit ${h2.code}`).toBe(true);
    } finally { await h2.stop(); }
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

  it('the hook reads a pause document of at most 1 MiB and lets the call pass when the file is larger, a sparse one included, without reading it to the end', async () => {
    const f = fixture('hook-size', {});
    const doc = JSON.stringify(pauseDoc({ pid: process.pid }));
    writeFileSync(f.pause, doc + ' '.repeat(512 * 1024), 'utf8');
    expect(await hookHeld(f, 'size-under'), 'a valid document of 512 KiB holds').toBe(true);
    writeFileSync(f.pause, doc + ' '.repeat(2 * 1024 * 1024), 'utf8');
    expect(await hookPasses(f, 'size-over'), 'the same valid document padded past 1 MiB is no pause').toBe(true);
    writeFileSync(f.pause, doc, 'utf8');
    truncateSync(f.pause, 512 * 1024 * 1024);
    const started = Date.now();
    expect(await hookPasses(f, 'size-sparse'), 'a sparse file of 512 MiB is no pause').toBe(true);
    expect(Date.now() - started, 'and it is not read to the end').toBeLessThan(10000);
  });

  it('the hook takes as a pause only what the guard would own: a regular file with v 2, paused true, numeric since, resume_at and valid_until and an integer pid', async () => {
    const f = fixture('hook-signature', {});
    const doc = () => pauseDoc({ pid: process.pid });
    const bad: Array<[string, Record<string, unknown>]> = [
      ['no since', { since: undefined }], ['since as text', { since: 'now' }], ['no pid', { pid: undefined }], ['pid as text', { pid: '1' }], ['pid as a boolean', { pid: true }], ['pid as a fraction', { pid: 1.5 }],
    ];
    for (const [name, over] of bad) {
      writeFileSync(f.pause, JSON.stringify({ ...doc(), ...over }), 'utf8');
      expect(await hookPasses(f, `sig-${name.replace(/\W/g, '')}`), `${name}: not a pause of the guard, the call passes`).toBe(true);
    }
    writeFileSync(f.pause, JSON.stringify(doc()), 'utf8');
    expect(await hookHeld(f, 'sig-complete'), 'the complete document holds').toBe(true);
  });

  it('a usage cache that names another provider as its source is not acted on, one that names Anthropic (or, as OMC always writes it, nothing else) is', () => {
    const other = fixture('cache-source-other', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS, extra: { source: 'zai' } } });
    const r = runSync(GUARD, guardArgs(other, ['--once']));
    expect(r.stdout).toMatch(/WARNING \(cache-source\): .*source 'zai'/);
    expect(existsSync(other.pause), 'no pause on the data of another provider').toBe(false);
    const own = fixture('cache-source-own', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    runSync(GUARD, guardArgs(own, ['--once']));
    expect(existsSync(own.pause), 'the Anthropic cache pauses').toBe(true);
  });

  it('a hook log that is the lock of the state file is reported after a settings rewrite, as the start refuses it', async () => {
    const f = fixture('wiring-log-state-lock', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const entry = (command: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } });
    writeFileSync(f.settings, entry(generatedCommand(f.pause, HOOK, PYBIN)), 'utf8');
    const g = startGuard(f, ['--warn-every', '1']);
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start');
      writeFileSync(f.settings, entry(generatedCommand(f.pause, HOOK, PYBIN, `${f.state}.lock`)), 'utf8');
      writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => /names .*state\.json\.lock, which is the state_file lock of this guard/.test(readText(f.log)), 20000, 'the alias warning');
    } finally { await stopGuard(g); }
  });

  it('a registered hook that a swap after the start made a link to another program of the guard is reported at the wiring pass', async () => {
    const f = fixture('wiring-hook-swapped', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const dir = join(f.dir, 'custom');
    mkdirSync(dir, { recursive: true });
    const hook = join(dir, 'five-hour-guard-hook.py');
    copyFileSync(HOOK, hook);
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, hook, PYBIN), timeout: 21600 }] }] } }), 'utf8');
    const g = startGuard(f, ['--warn-every', '1']);
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start');
      expect(readText(f.log), 'no file of the guard is named by the entry').not.toMatch(/WARNING.*which is the/);
      unlinkSync(hook);
      symlinkSync(ENTRY_MODULE, hook);
      writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => /WARNING \((pause start|pause|pause refused)\): the hook entry in .* names .*five-hour-guard-hook\.py, which is the entry module of this guard/.test(readText(f.log)), 20000, 'the swap warning');
    } finally { await stopGuard(g); }
  });

  it('a link at pause_file is no pause for the hook, whatever its target holds: the call is not held', async () => {
    const f = fixture('hook-link', {});
    const target = join(f.dir, 'foreign-pause.json');
    writeFileSync(target, JSON.stringify({ v: 2, paused: true, since: now(), resume_at: now() + 600, valid_until: now() + 60, exclude: [], percent: 97, pid: process.pid }), 'utf8');
    symlinkSync(target, f.pause);
    expect(await hookPasses(f, 'link0001'), 'a link to a live pause of another guard holds nobody').toBe(true);
    unlinkSync(f.pause);
    writePause(f, { pid: process.pid });
    expect(await hookHeld(f, 'link0002'), 'the same document as a regular file holds').toBe(true);
  });

  it('a regular pause file that is swapped for a link between the hook\'s first look and its read is not read through the link: the call is not held', async () => {
    const f = fixture('hook-swap-to-link', {});
    const other = join(f.dir, 'other-guard-pause.json');
    writeFileSync(other, JSON.stringify(pauseDoc({ pid: process.pid })), 'utf8');
    writePause(f, { valid_until: now() - 5 });   // a regular file that is no valid pause
    const driver = ['import os, runpy, sys', 'real = os.lstat', 'pause, other = sys.argv[1], sys.argv[2]', 'done = []',
      'def swap(path, *args, **kw):', '    found = real(path, *args, **kw)',
      '    if str(path) == pause and not done:', '        done.append(1)', '        os.unlink(pause)', '        os.symlink(other, pause)',
      '    return found',
      'os.lstat = swap', 'sys.argv = sys.argv[3:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const h = spawnPyCode(driver, [f.pause, other, HOOK, '--pause-file', f.pause, '--log', f.hookLog, '--poll', '0.1']);
    await Promise.race([h.done, sleep(20000)]);
    await h.stop();
    expect(h.exited && h.code === 0, 'the call passed').toBe(true);
    expect(lstatSync(f.pause).isSymbolicLink(), 'the swap happened').toBe(true);
    expect(readText(f.hookLog), 'the pause behind the link held nobody').not.toMatch(/hold-start/);
  });

  it('a hook that a settings rewrite during an active pause made the state file is not replaced by a renewal: every write of the state and of the pause file refuses a registered program', async () => {
    const f = fixture('program-is-state-renewal', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const state = join(f.dir, 'five-hour-guard-hook.py.state');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const entry = (hook: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, hook, PYBIN), timeout: 21600 }] }] } });
    writeFileSync(f.settings, entry(HOOK), 'utf8');
    const hookText = readFileSync(HOOK, 'utf8');
    const g = startGuard(f, ['--warn-every', '1']);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'the pause');
      writeFileSync(f.settings, entry(state), 'utf8');   // the registered hook is now the state path
      writeFileSync(state, hookText, 'utf8');            // and a real hook is installed there
      await waitFor(() => /ERROR: tick failed.*the file named by the hook entry .*five-hour-guard-hook\.py\.state is .*five-hour-guard-hook\.py\.state, a file this guard writes/.test(readText(f.log)) || readText(state) !== hookText, 20000, 'the refusal');
      await sleep(600);   // a few more renewals
    } finally { await stopGuard(g); }
    expect(readText(f.log), 'the renewal was refused').toMatch(/ERROR: tick failed.*a file this guard writes/);
    expect(readText(state), 'the hook is intact').toBe(hookText);
  });

  it('a relative hook that a settings rewrite after the start makes the state file, read from the working directory of the guard, is not replaced: the pause is refused, and the start refuses it too', async () => {
    const f = fixture('relative-program-is-state', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const state = join(f.dir, 'five-hour-guard-hook.py');   // the guard runs in f.dir
    writeFileSync(state, 'the program\n', 'utf8');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const entry = (hook: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, hook, PYBIN), timeout: 21600 }] }] } });
    writeFileSync(f.settings, entry(HOOK), 'utf8');
    const g = spawnPyCode(CHDIR_DRIVER, [f.dir, GUARD, ...guardArgs(f)]);
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start');
      writeFileSync(f.settings, entry('five-hour-guard-hook.py'), 'utf8');
      writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => /ERROR: tick failed.*(the hook entry in .* names five-hour-guard-hook\.py, which is the state_file of this guard|the registered hook five-hour-guard-hook\.py is the state_file of this guard)/.test(readText(f.log) + g.out) || readText(state) !== 'the program\n', 20000, 'the refusal');
      await sleep(600);
    } finally { await stopGuard(g); }
    expect(readText(f.log) + g.out, 'the pause was refused').toMatch(/ERROR: tick failed.*(the hook entry in .* names five-hour-guard-hook\.py, which is the state_file of this guard|the registered hook five-hour-guard-hook\.py is the state_file of this guard)/);
    expect(readText(state), 'the program is intact').toBe('the program\n');
    expect(existsSync(f.pause), 'no pause was published').toBe(false);
    const again = runSync(GUARD, ['--config', f.cfg, '--once'], { cwd: f.dir });   // the same settings at the start
    expect(again.status, `${again.stdout}${again.stderr}`).toBe(2);
    expect(again.stderr).toMatch(/are the same file|not read to its end/);
    expect(readText(state), 'still intact').toBe('the program\n');
  });

  it('nothing is appended to a log_file that a settings rewrite after the start made a registered hook: the notice goes to stdout, and the next tick looks again', async () => {
    const f = fixture('log-is-program', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const logPath = join(f.dir, 'five-hour-guard-hook.py.log');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: logPath, settings_file: f.settings }), 'utf8');
    const entry = (hook: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, hook, PYBIN), timeout: 21600 }] }] } });
    writeFileSync(f.settings, entry(HOOK), 'utf8');
    const hookText = readFileSync(HOOK, 'utf8');
    const g = startGuard(f);
    try {
      await waitFor(() => /guard start/.test(readText(logPath)), 20000, 'the start in the log (an unregistered log file is appended to)');
      writeFileSync(f.settings, entry(logPath), 'utf8');   // the registered hook is now the log path
      writeFileSync(logPath, hookText, 'utf8');            // and a real hook is installed there
      writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => /ERROR: tick failed/.test(g.out), 20000, 'the refusal of the pause');
      await sleep(800);   // a few more ticks, each with its own ERROR line
    } finally { await stopGuard(g); }
    expect(g.out, 'the notice is on stdout').toMatch(/the log file .*five-hour-guard-hook\.py\.log is a program that a command in .*settings\.json runs: nothing is appended to it/);
    expect(g.out.match(/ERROR: tick failed/g)?.length ?? 0, 'the failing ticks went on').toBeGreaterThan(1);
    expect(readText(logPath), 'the hook is intact').toBe(hookText);
    expect(existsSync(f.pause), 'no pause was published').toBe(false);
  });

  it('a settings.json that is rewritten between the line "guard start" and the wiring check of the start is read by that check: nothing is appended to a log_file that the rewrite made a registered hook, within a second of the line before', () => {
    const f = fixture('log-is-program-at-start', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const logPath = join(f.dir, 'five-hour-guard-hook.py.log');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: logPath, settings_file: f.settings }), 'utf8');
    const entry = (hook: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, hook, PYBIN), timeout: 21600 }] }] } });
    const replacement = join(f.dir, 'settings-after.json');
    writeFileSync(replacement, entry(logPath), 'utf8');
    writeFileSync(f.settings, entry(HOOK), 'utf8');
    const hookText = readFileSync(HOOK, 'utf8');
    const r = runPyCode(REWRITE_AT_WIRING_CHECK_DRIVER, [f.settings, replacement, logPath, HOOK, GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout, 'the start was logged before the rewrite').toMatch(/guard start/);
    expect(readText(f.settings), 'the driver rewrote settings.json').toBe(entry(logPath));
    expect(r.stdout, 'the wiring check of the start read the rewrite').toMatch(/WARNING \(start\): the hook entry in .* names .*five-hour-guard-hook\.py\.log, which is the log_file of this guard/);
    expect(r.stdout, 'the notice is on stdout').toMatch(/the log file .*five-hour-guard-hook\.py\.log is a program that a command in .*settings\.json runs: nothing is appended to it/);
    expect(readText(logPath), 'the hook is intact').toBe(hookText);
  });

  it('a launcher given by its bare name may be the file that the PATH of the session or a PATH of the settings resolves it to: a state file that is that program is not replaced, after a settings rewrite or at the start (the guard refuses to read it to its end, or names the file when the settings give the PATH)', async () => {
    const f = fixture('bare-launcher-is-state', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const bin = join(f.dir, 'bin');
    mkdirSync(bin);
    const state = join(bin, 'python3');
    writeFileSync(state, 'the program\n', 'utf8');
    chmodSync(state, 0o755);
    const env = { ...ENV, PATH: `${bin}:${process.env.PATH}` };
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const entry = (python: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, python), timeout: 21600 }] }] } });
    writeFileSync(f.settings, entry(PYBIN), 'utf8');
    const g = spawnPy(GUARD, guardArgs(f), { env });
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start');
      writeFileSync(f.settings, entry('python3'), 'utf8');
      writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => /ERROR: tick failed.*is not read to its end/.test(g.out) || readText(state) !== 'the program\n', 20000, 'the refusal');   // (the guard says it on its standard output, beside its log)
      await sleep(600);
    } finally { await stopGuard(g); }
    expect(g.out, 'the pause was refused: the PATH of the session decides which python3 runs, which the guard does not know').toMatch(/ERROR: tick failed.*is not read to its end.*bin\/python3: nothing is written/);
    expect(readText(state), 'the program is intact').toBe('the program\n');
    expect(existsSync(f.pause), 'no pause was published').toBe(false);
    const again = runSync(GUARD, ['--config', f.cfg, '--once'], { env });   // the same settings at the start
    expect(again.status, `${again.stdout}${again.stderr}`).toBe(2);
    expect(again.stderr).toMatch(/not read to its end/);
    expect(readText(state), 'still intact').toBe('the program\n');
    writeFileSync(f.settings, JSON.stringify({ env: { PATH: `${bin}:${process.env.PATH}` }, hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, 'python3'), timeout: 21600 }] }] } }), 'utf8');
    const given = runSync(GUARD, ['--config', f.cfg, '--once'], { env });   // a PATH of the settings is the PATH of the hook: the file is named
    expect(given.status, `${given.stdout}${given.stderr}`).toBe(2);
    expect(given.stderr).toMatch(/are the same file/);
    expect(given.stderr).not.toMatch(/not read to its end/);
    expect(readText(state), 'intact after the settings gave the PATH').toBe('the program\n');
  });

  it('a file at the old predictable temporary name of a write (the state path, the pid of the guard and .tmp), here the registered hook, is neither removed nor replaced: the write is made under a name of its own', async () => {
    const f = fixture('program-is-temp-file', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const state = join(f.dir, 'five-hour-guard-hook.py.state');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const entry = (hook: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, hook, PYBIN), timeout: 21600 }] }] } });
    writeFileSync(f.settings, entry(HOOK), 'utf8');
    const hookText = readFileSync(HOOK, 'utf8');
    const g = startGuard(f);
    const temp = `${state}.${g.child.pid}.tmp`;
    let published: unknown = null;
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start');
      writeFileSync(f.settings, entry(temp), 'utf8');   // the registered hook is now the old temporary name of the state write
      writeFileSync(temp, hookText, 'utf8');            // and a real hook is installed there
      writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => existsSync(f.pause), 20000, 'the pause');
      published = readJson(f.pause).paused;
    } finally { await stopGuard(g); }
    expect(readText(f.log), 'the write was not refused').not.toMatch(/ERROR: tick failed/);
    expect(readText(temp), 'the hook is intact').toBe(hookText);
    expect(published, 'the pause was published').toBe(true);
  });

  it('a file that is at the path a temporary file used to have (the pid and .tmp) is never removed by a write: the write goes to a name of its own', () => {
    const f = fixture('tmp-occupied', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    const foreign = [`${f.pause}.4242.tmp`, `${f.state}.4242.tmp`];
    for (const path of foreign) writeFileSync(path, 'a file of another process\n', 'utf8');
    const code = ['import os, runpy, sys', 'os.getpid = lambda: 4242', 'sys.argv = sys.argv[1:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const r = runPyCode(code, [GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    for (const path of foreign) expect(readText(path), `${path} is untouched`).toBe('a file of another process\n');
    expect(readJson(f.pause).paused, 'the pause was written').toBe(true);
    expect(readdirSync(f.dir).filter((n) => n.endsWith('.tmp') && !foreign.some((x) => x.endsWith(n))), 'no temporary file of the guard is left').toEqual([]);
  });

  it('a program that the command of another hook, of another event or of the status line runs is never a file the guard writes: refused at the start, and not appended to after a settings rewrite', async () => {
    const f = fixture('foreign-programs', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const tools = join(f.dir, 'tools');
    mkdirSync(tools);
    const scripts = { audit: join(tools, 'audit-hook.py'), notify: join(tools, 'notify.mjs'), status: join(tools, 'status.sh'), nested: join(tools, 'nested.sh') };
    for (const [name, path] of Object.entries(scripts)) writeFileSync(path, `# the program ${name}\n`, 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = JSON.stringify({
      hooks: {
        PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command: `${PYBIN} -I ${scripts.audit} --strict` }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: `env FOO=1 node ${scripts.notify} 2>&1 | tee -a /dev/null` }] }],
        Stop: [{ hooks: [{ type: 'command', command: `sh -c 'exec ${scripts.nested}'` }] }],
      },
      statusLine: { type: 'command', command: `bash ${scripts.status}` },
    });
    writeFileSync(f.settings, settings, 'utf8');
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    for (const [name, path] of Object.entries(scripts)) {
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: path });
        expect(r.status, `${name} as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${name} as ${key}`).toContain(`"${key}" (${path}) and "program of another hook" (${path}) are the same file`);
        expect(readText(path), `${name} as ${key}: the program is intact`).toBe(`# the program ${name}\n`);
      }
    }
    // the same interpreter as ours and the scripts of the guard itself are no collision
    writeFileSync(f.settings, JSON.stringify({
      hooks: {
        PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command: `${PYBIN} ${scripts.audit}` }, { type: 'command', command: `${PYBIN} ${SETTINGS_TOOL} check` }] }],
      },
    }), 'utf8');
    const quiet = start({});
    expect(quiet.status, `${quiet.stdout}${quiet.stderr}`).toBe(0);
    expect(readText(f.log), 'the log is written').toMatch(/guard start/);

    // a settings rewrite after the start: the log file becomes the program of another hook
    const logPath = join(f.dir, 'audit-log.py');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: logPath, settings_file: f.settings }), 'utf8');
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours] } }), 'utf8');
    const program = '# a hook of another tool\nprint("audit")\n';
    const g = startGuard(f);
    try {
      await waitFor(() => /guard start/.test(readText(logPath)), 20000, 'the start in the log');
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command: `${PYBIN} ${logPath}` }] }] } }), 'utf8');
      writeFileSync(logPath, program, 'utf8');
      writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => /ERROR: tick failed.*program of another hook .*audit-log\.py is the log_file of this guard/.test(g.out), 20000, 'the refusal of the pause');
      await sleep(800);
    } finally { await stopGuard(g); }
    expect(g.out, 'the notice is on stdout').toMatch(/the log file .*audit-log\.py is a program that a command in .*settings\.json runs: nothing is appended to it/);
    expect(readText(logPath), 'the program of the other hook is intact').toBe(program);
    expect(existsSync(f.pause), 'no pause was published').toBe(false);
  });

  it('a program that a scan of settings.json found stays protected until the guard is restarted, whether the file cannot be read or a readable one does not name the program any more: no pause is stored and nothing is appended to it', async () => {
    const f = fixture('settings-unreadable', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS, ageMs: 600e3 } });   // stale: the guard logs a warning at every tick and enters no pause
    const logPath = join(f.dir, 'audit-log.py');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: logPath, settings_file: f.settings }), 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours] } }), 'utf8');
    const g = startGuard(f, ['--warn-every', '0']);
    try {
      await waitFor(() => /guard start/.test(readText(logPath)), 20000, 'the start in the log');
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command: `${PYBIN} ${logPath}` }] }] } }), 'utf8');
      await waitFor(() => /nothing is appended to it/.test(g.out), 20000, 'a look that finds the log file named as a program');
      const before = readText(logPath);
      // the file cannot be read now (a rewrite in progress, a broken edit): what the last look found is still in force
      writeFileSync(f.settings, '{"hooks": {"PreToolUse": [', 'utf8');
      writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => /ERROR: tick failed/.test(g.out) || existsSync(f.pause), 20000, 'the refusal of the pause');
      expect(g.out, 'the pause is refused').toMatch(/ERROR: tick failed.*program of another hook .*audit-log\.py is the log_file of this guard/);
      await sleep(800);
      expect(existsSync(f.pause), 'no pause was published').toBe(false);
      expect(readText(logPath), 'nothing was appended to the program').toBe(before);
      // a readable file that does not name the program any more does not lift it: a session that loaded the entry keeps running the program until it restarts
      const mark = g.out.length;
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours] } }), 'utf8');
      await waitFor(() => /ERROR: tick failed.*program of another hook .*audit-log\.py is the log_file of this guard/.test(g.out.slice(mark)), 20000, 'the refusal after a readable file that does not name the program');
      await sleep(800);
      expect(existsSync(f.pause), 'no pause was published').toBe(false);
      expect(readText(logPath), 'nothing was appended to the program').toBe(before);
    } finally { await stopGuard(g); }
  });

  it('the commands of other hooks are read without a failure and at a bounded cost: hostile text, wrong shapes and very long commands, and a program after them is still protected', () => {
    const f = fixture('foreign-hostile', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const victim = join(f.dir, 'later-hook.py');
    writeFileSync(victim, '# a hook of another tool\n', 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const hostile = [
      `echo 'unbalanced ${'x'.repeat(50)}`,
      '('.repeat(40000),
      `python${'.'.repeat(30000)}x /tmp/a.py`,
      'a\u0000b',
      `${'bash -c "'.repeat(5)}x${'"'.repeat(5)}`,
      `echo ${'\\'.repeat(5000)}`,
      '\u202e\ud83d\ude00 emoji > /tmp/out <<EOF 2>&1 &',
      '',
      '   ',
      ';;; && || | & ( ) < >',
      `echo '' "" '' ${PYBIN} '' ''`,
    ];
    const overLimit = [`python3 ${'a;'.repeat(30000)}`, 'x'.repeat(70000), Array.from({ length: 5000 }, (_, i) => `/tmp/script-${i}.py`).join(' '), `${'$(python3 '.repeat(2000)}`];   // a command that a limit cuts short is not read to its end: the guard says so and goes on (see the test of the limits)
    const handlers = hostile.map((command) => ({ type: 'command', command }));
    const settings = {
      hooks: {
        PreToolUse: [ours, { matcher: 'x', hooks: handlers }, 'not a group', null, 7, { hooks: 'not a list' }, { hooks: [null, 3, 'x', { type: 'command' }, { type: 'command', command: 12 }, { command: `${PYBIN} /tmp/untyped.py` }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: `${PYBIN} ${victim}` }] }],
        PostToolUse: 'not a list',
        Stop: [{ hooks: handlers }],
        Notification: { not: 'a list' },
        SessionStart: [null, { hooks: [{ type: 'command', command: ['an', 'array'] }] }],
      },
      statusLine: 'not an object',
    };
    writeFileSync(f.settings, JSON.stringify(settings), 'utf8');
    const start = (logFile: string) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: logFile, settings_file: f.settings }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once'], { timeout: 60000 });
    };
    const refused = start(victim);
    expect(refused.status, `${refused.stdout}${refused.stderr}`).toBe(2);
    expect(refused.stderr, 'the program that comes after the hostile handlers is still protected').toMatch(/"log_file" .* and "program of another hook" \(.*later-hook\.py\) are the same file/);
    expect(refused.stderr).not.toMatch(/Traceback/);
    expect(readText(victim), 'the program is intact').toBe('# a hook of another tool\n');
    for (const command of overLimit) {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'x', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      const cut = start(f.log);
      expect(cut.status, `a command over a limit does not stop the guard: ${cut.stdout}${cut.stderr}`).toBe(0);
      expect(cut.stdout).toMatch(/WARNING \(hook-unread\)/);
      expect(cut.stderr).not.toMatch(/Traceback/);
      expectUnread(start(victim), 'log_file', 'beside a command over a limit');
      expect(readText(victim), 'a file that holds something else is intact').toBe('# a hook of another tool\n');
    }
    writeFileSync(f.settings, JSON.stringify(settings), 'utf8');
    const ok = start(f.log);
    expect(ok.status, `${ok.stdout}${ok.stderr}`).toBe(0);
    expect(ok.stderr).not.toMatch(/Traceback/);
    expect(readText(f.log), 'the guard ran').toMatch(/guard start/);
  });

  it('a program that runs next to the hook in a handler of this guard (before it, after it) is never a file the guard writes: the high reading does not replace it', () => {
    for (const [name, wrap] of [['before', (generated: string, audit: string) => `${audit}; ${generated}`], ['after', (generated: string, audit: string) => `${generated}; ${audit}`],
      ['both', (generated: string, audit: string) => `${audit} && ${generated} || ${audit}`]] as const) {
      const f = fixture(`companion-${name.replaceAll(' ', '-')}`, { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
      const audit = join(f.dir, 'audit');   // no suffix: only its place in the command makes it a program
      writeFileSync(audit, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: wrap(generatedCommand(f.pause, HOOK, PYBIN), audit), timeout: 21600 }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: audit, log_file: f.log, settings_file: f.settings }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${name}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, name).toContain(`"state_file" (${audit}) and "file named by the hook entry" (${audit}) are the same file`);
      expect(readText(audit), `${name}: the program is intact`).toBe('#!/bin/sh\nexit 0\n');
      expect(existsSync(f.pause), `${name}: no pause was published`).toBe(false);
    }
  });

  it('a status line given as a string (the form before v4.5, which the installer still reads) is a program of another tool as much as the object form: the high reading does not replace it', () => {
    const f = fixture('statusline-string', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    const hud = join(f.dir, 'omc-hud.mjs');
    writeFileSync(hud, '// the status line of another tool\n', 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours] }, statusLine: hud }), 'utf8');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: hud, log_file: f.log, settings_file: f.settings }), 'utf8');
    const r = runSync(GUARD, ['--config', f.cfg, '--once']);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toContain(`"state_file" (${hud}) and "program of another hook" (${hud}) are the same file`);
    expect(readText(hud), 'the program is intact').toBe('// the status line of another tool\n');
    expect(existsSync(f.pause), 'no pause was published').toBe(false);
  });

  it('the script of a Python is the first operand after the options that take a value (-W, -X): python3 -W ignore audit names audit, a file with no suffix and no execute bit', () => {
    // `run.py -W`: after the script, -W is an option of the script, not of the Python, so the word after it hides no program named like a script;
    // `perl -X`: only a Python takes a value with -X (for perl it disables warnings), so there the next word is the script
    const forms: Array<[string, string[], string]> = [[PYBIN, ['-W', 'ignore'], 'audit'], [PYBIN, ['-X', 'dev'], 'audit'], [PYBIN, ['-B', '-W', 'ignore', '-X', 'dev', '-u'], 'audit'],
      [PYBIN, ['-W', 'ignore', '-W', 'error'], 'audit'], [PYBIN, ['run.py', '-W'], 'audit.py'], ['perl', ['-X'], 'audit']];
    for (const [k, [launcher, options, name]] of forms.entries()) {
      const f = fixture(`python-option-values-${k}`, { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
      const audit = join(f.dir, name);   // `audit`: no suffix and no execute bit, only its place after the options makes it the script
      writeFileSync(audit, '# a program of another tool\n', 'utf8');
      const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
      const other = { matcher: 'Bash', hooks: [{ type: 'command', command: `${launcher} ${options.join(' ')} ${audit}` }] };
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, other] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: audit, log_file: f.log, settings_file: f.settings }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${launcher} ${options.join(' ')}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, options.join(' ')).toContain(`"state_file" (${audit}) and "program of another hook" (${audit}) are the same file`);
      expect(readText(audit), `${options.join(' ')}: the program is intact`).toBe('# a program of another tool\n');
      expect(existsSync(f.pause), `${options.join(' ')}: no pause was published`).toBe(false);
    }
  });

  it('the script of Node is the first operand after the options that take a value (-r, --require, --import): node --require preload audit names audit, a file with no suffix and no execute bit', () => {
    const forms = [(audit: string) => `node --require /tmp/preload.js ${audit}`, (audit: string) => `node -r /tmp/preload.js ${audit}`, (audit: string) => `node --import /tmp/hooks.mjs -r /tmp/p.js ${audit}`,
      (audit: string) => `nodejs --experimental-loader /tmp/loader.mjs ${audit}`, (audit: string) => `node -C development ${audit}`, (audit: string) => `node --require=/tmp/preload.js ${audit}`];
    for (const [k, build] of forms.entries()) {
      const f = fixture(`node-option-values-${k}`, { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
      const audit = join(f.dir, 'audit');   // no suffix and no execute bit: only its place after the options makes it the script
      writeFileSync(audit, '# a program of another tool\n', 'utf8');
      const command = build(audit);
      const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: audit, log_file: f.log, settings_file: f.settings }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain(`"state_file" (${audit}) and "program of another hook" (${audit}) are the same file`);
      expect(readText(audit), `${command}: the program is intact`).toBe('# a program of another tool\n');
      expect(existsSync(f.pause), `${command}: no pause was published`).toBe(false);
    }
  });

  it('a wrapper written with a path in front of the hook of this guard (/opt/env python3 hook) is a program that the entry needs: the high reading does not replace it', () => {
    for (const [k, build] of [(env: string, pause: string) => `${env} ${PYBIN} -I ${HOOK} --pause-file ${pause}`, (env: string, pause: string) => `[ -f ${pause} ] || exit 0; exec ${env} -i ${PYBIN} -I ${HOOK} --pause-file ${pause}`,
      (env: string, pause: string) => `FOO=1 ${env} ${PYBIN} -I ${HOOK} --pause-file ${pause}`].entries()) {
      const f = fixture(`own-wrapper-${k}`, { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
      const env = join(f.dir, 'env');   // a copy of a wrapper: its path is a program of the entry
      writeFileSync(env, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
      const command = build(env, f.pause);
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: env, log_file: f.log, settings_file: f.settings }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain(`"state_file" (${env}) and "file named by the hook entry" (${env}) are the same file`);
      expect(readText(env), `${command}: the wrapper is intact`).toBe('#!/bin/sh\nexec "$@"\n');
      expect(existsSync(f.pause), `${command}: no pause was published`).toBe(false);
    }
  });

  it('a bare word behind a command that runs it (timeout, nice, sudo, xargs) is looked up on the PATH of the command: PATH=dir timeout 5 audit names the program in dir, which the guard does not replace', () => {
    const forms: Array<(dir: string) => string> = [(dir) => `PATH=${dir}:/usr/bin /usr/bin/timeout 5 audit`, (dir) => `PATH=${dir} nice -n 5 audit`, (dir) => `env PATH=${dir} sudo -u root audit`,
      (dir) => `PATH=${dir} xargs -n1 audit`, (dir) => `PATH=${dir} ionice -c 3 nice audit --flag`];
    for (const [k, form] of forms.entries()) {
      const f = fixture(`bare-behind-${k}`, { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
      const bin = join(f.dir, 'hooks');
      mkdirSync(bin);
      const audit = join(bin, 'audit');   // not on the PATH of the guard: only the PATH of the command finds it
      writeFileSync(audit, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command: form(bin) }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: audit, log_file: f.log, settings_file: f.settings }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${form('DIR')}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, form('DIR')).toContain(`"state_file" (${audit}) and "program of another hook" (${audit}) are the same file`);
      expect(readText(audit), `${form('DIR')}: the program is intact`).toBe('#!/bin/sh\nexit 0\n');
      expect(existsSync(f.pause), `${form('DIR')}: no pause was published`).toBe(false);
    }
  });

  it('the file that . or source runs is the code of the hook: . audit and source audit (no suffix, no execute bit) name a program of another hook, which the guard does not replace', () => {
    const forms = [(audit: string) => `. ${audit}`, (audit: string) => `source ${audit}`, (audit: string) => `true && . ${audit} arg`, (audit: string) => `FOO=1 source ${audit}; true`];
    for (const [k, build] of forms.entries()) {
      const f = fixture(`dot-source-${k}`, { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
      const audit = join(f.dir, 'audit');   // no suffix and no execute bit: only the command word makes it code
      writeFileSync(audit, '# a program of another tool\n', 'utf8');
      const command = build(audit);
      const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: audit, log_file: f.log, settings_file: f.settings }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain(`"state_file" (${audit}) and "program of another hook" (${audit}) are the same file`);
      expect(readText(audit), `${command}: the program is intact`).toBe('# a program of another tool\n');
      expect(existsSync(f.pause), `${command}: no pause was published`).toBe(false);
    }
  });

  it('every word of the command of another hook is a file the guard does not write: php -c ini audit and PATH=dir . audit name /opt/audit and the audit in dir, whatever the program does with them', () => {
    const forms: Array<[(dir: string, audit: string) => string, boolean, boolean?]> = [[(_dir, audit) => `php -c /tmp/php.ini ${audit}`, false], [(_dir, audit) => `php -d display_errors=1 -f ${audit} -- arg`, false],
      [(dir) => `PATH=${dir} . audit`, false], [(dir) => `PATH=${dir}:/usr/bin source audit`, false], [() => `. audit`, true, true], [(dir) => `PATH=${dir} nice -n 5 audit`, false]];   // (`. audit` has no PATH: the word is a program that the PATH of the session may find, so it is refused, not read)
    for (const [k, [form, onGuardPath, refused]] of forms.entries()) {
      const f = fixture(`every-word-${k}`, { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
      const bin = join(f.dir, 'hooks');
      mkdirSync(bin);
      const audit = join(bin, 'audit');   // no suffix and no execute bit: nothing but the rule that every word counts finds it
      writeFileSync(audit, '# a program of another tool\n', 'utf8');
      const command = form(bin, audit);
      const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: audit, log_file: f.log, settings_file: f.settings }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once'], onGuardPath ? { env: { ...ENV, PATH: `${bin}:${process.env.PATH}` } } : {});
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      if (refused) expect(r.stderr, command).toMatch(/not read to its end/);
      else expect(r.stderr, command).toContain(`"state_file" (${audit}) and "program of another hook" (${audit}) are the same file`);
      expect(readText(audit), `${command}: the file is intact`).toBe('# a program of another tool\n');
      expect(existsSync(f.pause), `${command}: no pause was published`).toBe(false);
    }
  });

  it('false alarm: a file of the guard that another hook names as a plain argument, as the value after =, or inside a quoted word is refused like a program; a state_file that no other command names ends the alarm', () => {
    const f = fixture('false-alarm', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    const forms: Array<[string, (path: string) => string]> = [['a plain argument of tail', (p) => `tail -n 5 ${p}`], ['an argument of a script', (p) => `${PYBIN} /x/reader.py ${p} /tmp/other`],
      ['the value after =', (p) => `audit --output=${p}`], ['an assignment', (p) => `FOO=${p} audit`], ['a quoted word', (p) => `sh -c 'echo ${p} done'`], ['a word of a quoted string', (p) => `echo "${p} and more"`],
      ['a glued option value', (p) => `audit -o${p}`], ['text after env --help', (p) => `env --help ${p}`], ['printf', (p) => `printf ${p} --pause-file /tmp/p`], ['an operand of --pause-file', (p) => `exec /bin/true --pause-file ${p}`]];
    for (const key of ['state_file', 'pause_file', 'log_file']) {
      for (const [name, form] of forms) {
        const g = fixture(`false-alarm-${key}-${name.replaceAll(' ', '-')}`, { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
        const mine = join(g.dir, 'named.json');
        writeFileSync(g.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(g.pause, HOOK, PYBIN), timeout: 21600 }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: form(mine) }] }] } }), 'utf8');
        writeFileSync(g.cfg, JSON.stringify({ usage_cache: g.cache, pause_file: g.pause, state_file: g.state, log_file: g.log, settings_file: g.settings, [key]: mine }), 'utf8');
        const r = runSync(GUARD, ['--config', g.cfg, '--once']);
        expect(r.status, `${key} named as ${name}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${key} named as ${name}`).toContain(`"${key}" (${mine}) and "program of another hook" (${mine}) are the same file`);
        expect(existsSync(mine), `${key} named as ${name}: nothing was written`).toBe(false);
      }
    }
    // the way out that the README gives: paths of its own, which no other command names
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: `tail -n 5 ${f.state}` }, { type: 'command', command: `audit --output=${f.log} ${f.pause}` }] }] } }), 'utf8');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    expect(runSync(GUARD, ['--config', f.cfg, '--once']).status, 'the paths are named by another command: refused').toBe(2);
    const own = (name: string) => join(f.dir, name);
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: own('guard-own.pause'), state_file: own('guard-own.state'), log_file: own('guard-own.log'), settings_file: f.settings }), 'utf8');
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(own('guard-own.pause'), HOOK, PYBIN), timeout: 21600 }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: `tail -n 5 ${f.state}` }, { type: 'command', command: `audit --output=${f.log} ${f.pause}` }] }] } }), 'utf8');
    const ok = runSync(GUARD, ['--config', f.cfg, '--once']);
    expect(ok.status, `${ok.stdout}${ok.stderr}`).toBe(0);
    expect(readText(own('guard-own.log')), 'the guard ran').toMatch(/guard start/);
  });

  it('a command of another hook that names the settings file, the configuration file or the usage cache does not stop the guard, and one that names the state, pause or log file or the lock of the state or pause file still does', () => {
    for (const [name, key] of [['settings', 'settings_file'], ['configuration', 'configuration'], ['cache', 'usage_cache'], ['cache lock', 'usage_cache_lock']] as const) {
      const f = fixture(`read-only-named-${key}`, { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
      const named = { settings_file: f.settings, configuration: f.cfg, usage_cache: f.cache, usage_cache_lock: `${f.cache}.lock` }[key];
      const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command: `jq . ${named}` }, { type: 'command', command: `cat --number=${named}` }] }] },
        statusLine: { type: 'command', command: `sh -c 'wc -c ${named}'` } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${name} named by another hook: ${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stderr, name).not.toMatch(/program of another hook/);
      expect(r.stdout, name).not.toMatch(/program of another hook/);
      expect(readText(f.log), `${name}: the guard ran`).toMatch(/guard start/);
    }
    for (const [name, key] of [['state', 'state_file'], ['pause', 'pause_file'], ['log', 'log_file'], ['state lock', 'state_lock'], ['pause lock', 'pause_lock']] as const) {
      const f = fixture(`written-named-${key}`, { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
      const named = { state_file: f.state, pause_file: f.pause, log_file: f.log, state_lock: `${f.state}.lock`, pause_lock: `${f.pause}.lock` }[key];
      const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command: `jq . ${named}` }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${name} named by another hook: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, name).toContain(`"program of another hook" (${named}) are the same file`);
    }
  });

  it('a word of the command of another hook with *, ? or [ is every file that the shell expands it to: such a file is never a file the guard writes, at the start and after a settings rewrite, and a pattern that matches too many files is not read to its end', async () => {
    const f = fixture('foreign-glob', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const script = join(hooks, 'only-hook.py');
    writeFileSync(script, '# the one script that the pattern matches\n', 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (command: string) => JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    for (const pattern of [`${hooks}/*.py`, `${hooks}/only-hook.p?`, `${hooks}/only-[h]ook.py`]) {
      writeFileSync(f.settings, settings(`${PYBIN} ${pattern}`), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: script });
        expect(r.status, `${pattern} as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${pattern} as ${key}`).toContain(`"${key}" (${script}) and "program of another hook" (${script}) are the same file`);
        expect(readText(script), `${pattern} as ${key}: the program is intact`).toBe('# the one script that the pattern matches\n');
      }
    }
    // a pattern that matches no file, or only files that the guard never writes, is no collision
    writeFileSync(f.settings, settings(`grep x ${hooks}/*.log ${hooks}/none-*.py`), 'utf8');
    const quiet = start({});
    expect(quiet.status, `${quiet.stdout}${quiet.stderr}`).toBe(0);

    // a pattern that matches more than 4096 files is not read to its end
    const many = join(f.dir, 'many');
    mkdirSync(many);
    for (let i = 0; i < 4100; i++) writeFileSync(join(many, `f${i}`), '', 'utf8');
    writeFileSync(f.settings, settings(`cat ${many}/*`), 'utf8');
    const cut = start({ state_file: join(f.dir, 'elsewhere.state') });
    expect(cut.status, `${cut.stdout.slice(0, 300)}${cut.stderr.slice(0, 300)}`).toBe(0);
    expect(cut.stdout).toMatch(/WARNING \(hook-unread\)[^\n]*too many files to scan/);
    writeFileSync(join(many, 'f1'), '#!/bin/sh\n', 'utf8');
    const kept = start({ state_file: join(many, 'f1') });
    expect(kept.status, `${kept.stdout.slice(0, 300)}${kept.stderr.slice(0, 300)}`).toBe(2);
    expect(kept.stderr).toMatch(/too many files to scan/);
    expect(readText(join(many, 'f1'))).toBe('#!/bin/sh\n');

    // a settings rewrite after the start: the pattern now matches the log file
    const logPath = join(hooks, 'late-log.py');
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours] } }), 'utf8');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: logPath, settings_file: f.settings }), 'utf8');
    const program = '# a hook of another tool\nprint("audit")\n';
    const g = startGuard(f);
    try {
      await waitFor(() => /guard start/.test(readText(logPath)), 20000, 'the start in the log');
      writeFileSync(f.settings, settings(`${PYBIN} ${hooks}/late-*.py`), 'utf8');
      writeFileSync(logPath, program, 'utf8');
      writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => /ERROR: tick failed.*program of another hook .*late-log\.py is the log_file of this guard/.test(g.out), 20000, 'the refusal of the pause');
      await sleep(800);
    } finally { await stopGuard(g); }
    expect(readText(logPath), 'the program of the other hook is intact').toBe(program);
    expect(existsSync(f.pause), 'no pause was published').toBe(false);
  });

  it('a bare word of the command of another hook is also a file in each directory that another word of the same command names (cd DIR; prog, env -C DIR prog): never a file the guard writes, at the start and after a settings rewrite', async () => {
    const f = fixture('foreign-cd', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const script = join(hooks, 'audit');
    writeFileSync(script, '# the script that the command runs after cd\n', 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (command: string) => JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    // (a bare word that is the program is looked up on the PATH of the session, so a PATH of the command settles the directory; without one the guard refuses to read it: see the PATH tests)
    for (const command of [`cd ${hooks} && PATH=${hooks} audit`, `env -C ${hooks} PATH=${hooks} audit`, `PATH=${hooks} audit --directory ${hooks}`, `cd ${hooks}; PATH=${hooks} python3 audit`]) {
      writeFileSync(f.settings, settings(command), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: script });
        expect(r.status, `${command} as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${command} as ${key}`).toContain(`"${key}" (${script}) and "program of another hook" (${script}) are the same file`);
        expect(readText(script), `${command} as ${key}: the program is intact`).toBe('# the script that the command runs after cd\n');
      }
    }
    for (const command of [`cd ${hooks} && audit`, `audit --directory ${hooks}`, `env -C ${hooks} audit`, `cd ${hooks}; python3 audit`, `env -C ${hooks} sh -c 'python3 audit'`]) {   // (a bare word that is an argument is a program the wrapper may run: no PATH is given, so the guard refuses to read it)
      writeFileSync(f.settings, settings(command), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: script });
        expectUnread(r, key, `${command} as ${key}`);
        expect(readText(script), `${command} as ${key}: the program is intact`).toBe('# the script that the command runs after cd\n');
      }
    }
    // no directory is named: the bare word is no file of that directory, but it may be a program that a wrapper runs from the PATH of the session, so the guard refuses to read it; a name that no file of the guard has is quiet
    writeFileSync(f.settings, settings('python3 audit'), 'utf8');
    const quiet = start({ state_file: script });
    expect(quiet.status, `${quiet.stdout}${quiet.stderr}`).toBe(2);
    expect(quiet.stderr).toMatch(/not read to its end/);
    writeFileSync(f.settings, settings('python3 other'), 'utf8');
    expect(start({ state_file: script }).status, 'no file of the guard has the name').toBe(0);
    writeFileSync(script, '# the script that the command runs after cd\n', 'utf8');

    // a settings rewrite after the start: the command now changes into the directory of the log file
    const logPath = join(hooks, 'late');
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours] } }), 'utf8');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: logPath, settings_file: f.settings }), 'utf8');
    const program = '# a hook of another tool\nprint("audit")\n';
    const g = startGuard(f);
    try {
      await waitFor(() => /guard start/.test(readText(logPath)), 20000, 'the start in the log');
      writeFileSync(f.settings, settings(`cd ${hooks}; PATH=${hooks} late`), 'utf8');   // (a bare program is looked up on the PATH of the session: with a PATH of the command the directory is known)
      writeFileSync(logPath, program, 'utf8');
      writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => /ERROR: tick failed.*program of another hook .*late is the log_file of this guard/.test(g.out), 20000, 'the refusal of the pause');
      await sleep(800);
    } finally { await stopGuard(g); }
    expect(readText(logPath), 'the program of the other hook is intact').toBe(program);
    expect(existsSync(f.pause), 'no pause was published').toBe(false);
    writeFileSync(f.settings, settings(`cd ${hooks}; late`), 'utf8');   // without that PATH the program is not read to its end
    expectUnread(start({ log_file: logPath }), 'log_file', 'without the PATH');
    expect(readText(logPath), 'still intact').toBe(program);
    expect(existsSync(f.pause), 'and the pause is published beside it').toBe(true);
  });

  it('a guard that starts while settings.json cannot be read writes nothing until one read of it succeeds, and a missing settings.json is a read that succeeded', async () => {
    const f = fixture('no-scan-yet', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const script = join(f.dir, 'audit.py');
    const program = '# a hook of another tool\nprint("audit")\n';
    writeFileSync(script, program, 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: script, log_file: f.log, settings_file: f.settings }), 'utf8');
    writeFileSync(f.settings, '{"hooks": {"PreToolUse": [', 'utf8');
    const g = startGuard(f);
    try {
      await waitFor(() => /ERROR: tick failed.*cannot be read and no earlier read of it succeeded/.test(g.out), 20000, 'the refusal of the pause');
      await sleep(800);
      expect(g.out, 'the unreadable file is reported as before').toMatch(/WARNING \(start\): cannot read the hook entries/);
      expect(readText(script), 'the program of the hook is intact').toBe(program);
      expect(existsSync(f.pause), 'no pause was published').toBe(false);
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours] } }), 'utf8');
      await waitFor(() => existsSync(f.pause), 20000, 'the pause after a read that succeeded');
    } finally { await stopGuard(g); }

    const missing = fixture('no-settings-file', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    rmSync(missing.settings, { force: true });
    writeFileSync(missing.cfg, JSON.stringify({ usage_cache: missing.cache, pause_file: missing.pause, state_file: missing.state, log_file: missing.log, settings_file: missing.settings }), 'utf8');
    guardOnce(missing);
    expect(readJson(missing.pause).paused, 'no settings.json names no hook: the pause is published').toBe(true);
  });

  it('a relative path word of the command of another hook is also that path in each directory that another word of the same command names (cd DIR; ./prog, env -C DIR ./prog): never a file the guard writes', () => {
    const f = fixture('foreign-cd-relative', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(join(hooks, 'sub'), { recursive: true });
    const text = '# the script that the command runs after cd\n';
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (command: string) => JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    for (const [command, name] of [[`cd ${hooks}; ./audit`, 'audit'], [`cd ${hooks} && python3 sub/audit`, 'sub/audit'], [`env -C ${hooks} ./audit`, 'audit'], [`env --chdir ${hooks} ./audit`, 'audit']]) {
      const script = join(hooks, name);
      writeFileSync(script, text, 'utf8');
      writeFileSync(f.settings, settings(command), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: script });
        expect(r.status, `${command} as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${command} as ${key}`).toMatch(/"program of another hook" \(.*audit\) are the same file/);
        expect(readText(script), `${command} as ${key}: the program is intact`).toBe(text);
      }
    }
    // no directory is named: the shell runs it from the directory of the session, which the guard does not know, so a path that ends the path of a file of the guard is not read to its end
    writeFileSync(f.settings, settings('./audit'), 'utf8');
    const unknown = start({ state_file: join(hooks, 'audit') });
    expect(unknown.status, `${unknown.stdout}${unknown.stderr}`).toBe(2);
    expect(unknown.stderr).toMatch(/not read to its end/);
    const quiet = start({});
    expect(quiet.status, `a path that no file of the guard ends: ${quiet.stdout}${quiet.stderr}`).toBe(0);
  });

  it('a file name split by a line continuation in the command of another hook is that file (the shell removes a backslash and newline before it splits the words), and an escaped backslash before a newline is not a continuation', () => {
    const f = fixture('foreign-continuation', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const script = join(f.dir, 'audit');
    const text = '# a hook of another tool\n';
    writeFileSync(script, text, 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (command: string) => JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const cut = script.length - 2;
    for (const command of [`python3 ${script.slice(0, cut)}\\\n${script.slice(cut)}`, `python3 "${script.slice(0, cut)}\\\n${script.slice(cut)}"`, `echo x\\\\\n${script}`]) {
      writeFileSync(f.settings, settings(command), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: script });
        expect(r.status, `${JSON.stringify(command)} as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${JSON.stringify(command)} as ${key}`).toContain(`"${key}" (${script}) and "program of another hook" (${script}) are the same file`);
        expect(readText(script), `${JSON.stringify(command)} as ${key}: the program is intact`).toBe(text);
      }
    }
  });

  it('a variable that the command of another hook assigns is filled in with its value in the words of that command (DIR=/x; prog "$DIR/audit", cd "$DIR"; audit): never a file the guard writes', () => {
    const f = fixture('foreign-assigned', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const script = join(hooks, 'audit');
    const text = '# the script that the command runs\n';
    writeFileSync(script, text, 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (command: string) => JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    for (const command of [`DIR=${hooks}; python3 "$DIR/audit"`, `DIR=${hooks}; python3 \${DIR}/audit`, `A=/x B=${hooks}; FILE=audit; python3 "$B/$FILE"`, `DIR=${hooks}; cd "$DIR" && PATH=$DIR audit`, `DIR=${hooks}; sh -c 'python3 $DIR/audit'`]) {
      writeFileSync(f.settings, settings(command), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: script });
        expect(r.status, `${command} as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${command} as ${key}`).toContain(`"${key}" (${script}) and "program of another hook" (${script}) are the same file`);
        expect(readText(script), `${command} as ${key}: the program is intact`).toBe(text);
      }
    }
    // a name that is used before the assignment is the session's: the later value is not what the command runs, so the command is not read to its end (the assignments of the first list, after their use)
    for (const command of [`python3 "$DIR/audit"; DIR=${hooks}`, `A=/x B=${hooks}; python3 "$B/$FILE"; FILE=audit`]) {
      writeFileSync(f.settings, settings(command), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: script });
        expectUnread(r, key, `${command} as ${key}`);
        expect(readText(script), `${command} as ${key}: the program is intact`).toBe(text);
      }
    }
    // (the bare program that is that of a file of the guard, with no PATH given, is looked up on the PATH of the session: not read to its end)
    writeFileSync(f.settings, settings(`DIR=${hooks}; cd "$DIR" && audit`), 'utf8');
    for (const key of ['log_file', 'state_file', 'pause_file']) {
      const r = start({ [key]: script });
      expectUnread(r, key, `a program after cd as ${key}`);
    }
    // a variable that nothing assigns is the session's: a word that ends the path of the file is not read to its end, a word with another ending is read as before
    writeFileSync(f.settings, settings('python3 "$DIR/audit"'), 'utf8');
    const unknown = start({ state_file: script });
    expect(unknown.status, `${unknown.stdout}${unknown.stderr}`).toBe(2);
    expect(unknown.stderr).toMatch(/not read to its end/);
    writeFileSync(f.settings, settings('python3 "$DIR/other"'), 'utf8');
    const quiet = start({ state_file: script });
    expect(quiet.status, `${quiet.stdout}${quiet.stderr}`).toBe(0);
  });

  it('a default-value parameter in the command of another hook is filled in with both of its values (${NAME:-word}, ${NAME-word}, ${NAME:=word}, ${NAME:+word}, with a variable inside the word): never a file the guard writes', () => {
    const f = fixture('foreign-default-value', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const text = '# the hook script of another tool\n';
    const defaulted = join(HOME_DIR, '.claude', 'hooks', 'audit.mjs');   // the branch of the word when the variable is not set
    const valued = join(CONFIG_DIR, 'hooks', 'audit.mjs');   // the branch of the value of the variable
    for (const script of [defaulted, valued]) {
      mkdirSync(join(script, '..'), { recursive: true });
      writeFileSync(script, text, 'utf8');
    }
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (command: string) => JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    const withoutConfigDir = { ...ENV };
    delete withoutConfigDir.CLAUDE_CONFIG_DIR;
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once'], { env: withoutConfigDir });
    };
    for (const form of ['${CLAUDE_CONFIG_DIR:-$HOME/.claude}', '${CLAUDE_CONFIG_DIR-$HOME/.claude}', '${CLAUDE_CONFIG_DIR:=$HOME/.claude}', '${CLAUDE_CONFIG_DIR:-${HOME}/.claude}']) {
      for (const [script, where] of [[defaulted, 'the command assigns it, the file is the default word'], [valued, 'the command assigns it'], [defaulted, 'the guard has no CLAUDE_CONFIG_DIR']] as const) {
        const command = where === 'the guard has no CLAUDE_CONFIG_DIR' ? `node "${form}/hooks/audit.mjs"` : `CLAUDE_CONFIG_DIR=${CONFIG_DIR}; node "${form}/hooks/audit.mjs"`;
        writeFileSync(f.settings, settings(command), 'utf8');
        for (const key of ['log_file', 'state_file', 'pause_file']) {
          const r = start({ [key]: script });
          // (a name that nothing at that place gives a value to may be set in the session, so what ends the word decides: not read)
          if (where === 'the guard has no CLAUDE_CONFIG_DIR' && !form.includes('${HOME}')) expectUnread(r, key, `${command} as ${key}`);   // (the form with braces inside the word is read inside out, as before)
          else {
            expect(r.status, `${command} as ${key} (${where}): ${r.stdout}${r.stderr}`).toBe(2);
            expect(r.stderr, `${command} as ${key}`).toContain(`"${key}" (${script}) and "program of another hook" (${script}) are the same file`);
          }
          expect(readText(script), `${command} as ${key}: the program is intact`).toBe(text);
        }
      }
    }
    // the word of the + forms is the value when the variable is set, nothing when it is not
    writeFileSync(f.settings, settings(`node "$HOME/.claude/hooks/audit\${NAME:+.mjs}"`), 'utf8');
    expect(start({ state_file: defaulted }).status, 'the form with the word').toBe(2);
    // a default word that names no guard file leaves the guard free
    writeFileSync(f.settings, settings('node "${NOTHING_SET:-/nonexistent}/hooks/other.mjs"'), 'utf8');
    const quiet = start({ state_file: defaulted });
    expect(quiet.status, `${quiet.stdout}${quiet.stderr}`).toBe(0);
    // the same with the ending of the guard file: nothing gives the name a value, so the session may have one (refused, not read)
    writeFileSync(f.settings, settings('node "${NOTHING_SET:-/nonexistent}/hooks/audit.mjs"'), 'utf8');
    const refused = start({ state_file: defaulted });
    expect(refused.status, `${refused.stdout}${refused.stderr}`).toBe(2);
    expect(refused.stderr).toMatch(/not read to its end/);
  });

  it('nested default-value parameters are filled in to the end, however deep, and parameters that refer to each other in a cycle are a command that is not read to its end', () => {
    const f = fixture('foreign-nested-parameters', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const script = join(hooks, 'audit');
    const text = '# the script that the command runs\n';
    writeFileSync(script, text, 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (command: string) => JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const nested = (depth: number) => Array.from({ length: depth }, (_, i) => '${FHG_N' + i + ':-').join('') + hooks + '}'.repeat(depth);
    for (const depth of [4, 6, 12]) {
      writeFileSync(f.settings, settings(`python3 "${nested(depth)}/audit"`), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: script });
        expect(r.status, `${depth} levels as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${depth} levels as ${key}`).toContain(`"${key}" (${script}) and "program of another hook" (${script}) are the same file`);
        expect(readText(script), `${depth} levels as ${key}: the program is intact`).toBe(text);
      }
    }
    // a name with no value and no word stays as written and is the session's: refused where the word ends the path of the file, read as before where it does not
    writeFileSync(f.settings, settings('python3 "$FHG_NOBODY_SETS_THIS/audit"'), 'utf8');
    const unknown = start({ state_file: script });
    expect(unknown.status, `${unknown.stdout}${unknown.stderr}`).toBe(2);
    expect(unknown.stderr).toMatch(/not read to its end/);
    writeFileSync(f.settings, settings('python3 "$FHG_NOBODY_SETS_THIS/other"'), 'utf8');
    const quiet = start({ state_file: script });
    expect(quiet.status, `${quiet.stdout}${quiet.stderr}`).toBe(0);
    // parameters that refer to each other never reach an end: the command is not read to its end, so the guard does not start
    writeFileSync(f.settings, settings('FHG_X=$FHG_Y; FHG_Y=$FHG_X; python3 "$FHG_X/audit"'), 'utf8');
    const cycle = start({ state_file: script });
    expect(cycle.status, `${cycle.stdout}${cycle.stderr}`).toBe(2);
    expect(cycle.stderr).toMatch(/is not read to its end/);
    expect(readText(script), 'the program is intact').toBe(text);
  });

  it('the top-level env of settings.json gives values to the parameters of the commands of other hooks (the hook processes get it, the guard does not): never a file the guard writes; an env of the wrong shape does not spoil the scan', () => {
    const f = fixture('foreign-settings-env', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const script = join(f.dir, 'audit');
    const text = '# the script that the command runs\n';
    writeFileSync(script, text, 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (env: unknown, command = 'python3 "$FHG_AUDIT"') => JSON.stringify({ env, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    writeFileSync(f.settings, settings({ FHG_AUDIT: script }), 'utf8');
    for (const key of ['log_file', 'state_file', 'pause_file']) {
      const r = start({ [key]: script });
      expect(r.status, `as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, `as ${key}`).toContain(`"${key}" (${script}) and "program of another hook" (${script}) are the same file`);
      expect(readText(script), `as ${key}: the program is intact`).toBe(text);
    }
    // in a default word too, and next to values of the wrong shape
    writeFileSync(f.settings, settings({ FHG_AUDIT: 5, 'not a name': 'x', FHG_OTHER: script }, 'python3 "${FHG_AUDIT:-$FHG_OTHER}"'), 'utf8');
    expect(start({ state_file: script }).status, 'valid entries of an env with invalid ones').toBe(2);
    // an env that is no object, and values that are no text, give no value: the variable is the session's (refused as a whole word, read as before with another ending)
    for (const env of [5, 'FHG_AUDIT', ['FHG_AUDIT'], null, { FHG_AUDIT: 5 }, { FHG_AUDIT: [script] }]) {
      writeFileSync(f.settings, settings(env), 'utf8');
      const r = start({ state_file: script });
      expect(r.status, `env ${JSON.stringify(env)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, `env ${JSON.stringify(env)}`).toMatch(/not read to its end/);
      writeFileSync(f.settings, settings(env, 'python3 "$FHG_AUDIT/other"'), 'utf8');
      expect(start({ state_file: script }).status, `env ${JSON.stringify(env)}: another ending`).toBe(0);
    }
  });

  it('the word of ${NAME:=word} and ${NAME=word} is a value of NAME for the other words of the command (: "${DIR:=/x}"; prog "$DIR/audit"): never a file the guard writes; ${NAME:-word} assigns nothing and a cycle of them is not read to its end', () => {
    const f = fixture('foreign-assigning-default', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const script = join(hooks, 'audit');
    const text = '# the script that the command runs\n';
    writeFileSync(script, text, 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (command: string) => JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    for (const command of [`: "\${FHG_DIR:=${hooks}}/"; python3 "$FHG_DIR/audit"`, `: "\${FHG_DIR=${hooks}}/"; python3 "$FHG_DIR/audit"`, `echo "\${FHG_DIR:=${hooks}}/"; python3 "$FHG_DIR/audit"`]) {
      writeFileSync(f.settings, settings(command), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: script });
        expect(r.status, `${command} as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${command} as ${key}`).toContain(`"${key}" (${script}) and "program of another hook" (${script}) are the same file`);
        expect(readText(script), `${command} as ${key}: the program is intact`).toBe(text);
      }
    }
    // the expansion alone (nothing after it) is refused where the name is not settled before it: the session may have a value, and the shell then uses it; a use before the expansion is the session's too
    for (const command of [`: "\${FHG_DIR:=${hooks}}"; python3 "$FHG_DIR/audit"`, `: "\${FHG_DIR=${hooks}}"; python3 "$FHG_DIR/audit"`, `echo "\${FHG_DIR:=${hooks}}"; python3 "$FHG_DIR/audit"`, `python3 "$FHG_DIR/audit"; : "\${FHG_DIR:=${hooks}}/"`]) {
      writeFileSync(f.settings, settings(command), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: script });
        expectUnread(r, key, `${command} as ${key}`);
        expect(readText(script), `${command} as ${key}: the program is intact`).toBe(text);
      }
    }
    // ${NAME:-word} assigns nothing: $NAME stays as written for the later word, and is the session's (refused where the word ends the path of the file)
    writeFileSync(f.settings, settings(`: "\${FHG_DIR:-${hooks}}"; python3 "$FHG_DIR/audit"`), 'utf8');
    const unknown = start({ state_file: script });
    expect(unknown.status, `${unknown.stdout}${unknown.stderr}`).toBe(2);
    expect(unknown.stderr).toMatch(/not read to its end/);
    writeFileSync(f.settings, settings(`: "\${FHG_DIR:-${hooks}}/"; python3 "$FHG_DIR/other"`), 'utf8');
    const quiet = start({ state_file: script });
    expect(quiet.status, `${quiet.stdout}${quiet.stderr}`).toBe(0);
    // each takes the other's word: no end, so the command is not read to its end
    writeFileSync(f.settings, settings(': "${FHG_A:=$FHG_B}" "${FHG_B:=$FHG_A}"; python3 "$FHG_A/audit"'), 'utf8');
    const cycle = start({ state_file: script });
    expect(cycle.status, `${cycle.stdout}${cycle.stderr}`).toBe(2);
    expect(cycle.stderr).toMatch(/is not read to its end/);
  });

  it('a value that a parameter is filled in with is also split at its blanks, as the shell splits an unquoted expansion (env CMD="python3 /x/audit"; $CMD): each word of it is a file the guard never writes', () => {
    const f = fixture('foreign-split-value', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const script = join(f.dir, 'audit');
    const text = '# the script that the command runs\n';
    writeFileSync(script, text, 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (command: string, env: Record<string, string> = {}) => JSON.stringify({ env, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    for (const [command, env] of [['$FHG_CMD', { FHG_CMD: `python3 ${script}` }], ['"$FHG_CMD"', { FHG_CMD: `python3 ${script}` }], [`FHG_CMD="python3 ${script}"; $FHG_CMD`, {}], ['"${FHG_CMD:-python3 /nonexistent/x}" -u', { FHG_CMD: `python3 -u ${script}` }], [`: "\${FHG_CMD:=python3 ${script}}"; $FHG_CMD`, {}]] as Array<[string, Record<string, string>]>) {
      writeFileSync(f.settings, settings(command, env), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: script });
        expect(r.status, `${command} as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${command} as ${key}`).toContain(`"${key}" (${script}) and "program of another hook" (${script}) are the same file`);
        expect(readText(script), `${command} as ${key}: the program is intact`).toBe(text);
      }
    }
    // a value with blanks that names no existing file of the guard leaves it free
    writeFileSync(f.settings, settings('$FHG_CMD', { FHG_CMD: 'python3 /nonexistent/tool --flag value' }), 'utf8');
    const quiet = start({ state_file: script });
    expect(quiet.status, `${quiet.stdout}${quiet.stderr}`).toBe(0);
  });

  it('the PATH of the top-level env of settings.json is where a bare word of the command of another hook is looked up too (the hook processes get it, the guard does not): never a file the guard writes; a PATH that is no text leaves the guard free', () => {
    const f = fixture('foreign-settings-path', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const script = join(hooks, 'audit');
    const text = '# the script that the command runs\n';
    writeFileSync(script, text, 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (env: unknown, command = 'audit') => JSON.stringify({ env, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    for (const [path, command] of [[hooks, 'audit'], [`/nonexistent:${hooks}`, 'audit'], [`${hooks}:$PATH`, 'audit'], [hooks, 'env audit']]) {
      writeFileSync(f.settings, settings({ PATH: path }, command), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: script });
        expect(r.status, `PATH ${path}, ${command} as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `PATH ${path}, ${command} as ${key}`).toContain(`"${key}" (${script}) and "program of another hook" (${script}) are the same file`);
        expect(readText(script), `PATH ${path}, ${command} as ${key}: the program is intact`).toBe(text);
      }
    }
    // a PATH that is no text, or no PATH at all, names no directory: the program is looked up on the PATH of the session, which the guard does not know
    for (const env of [{ PATH: 5 }, { PATH: [hooks] }, { PATH: null }, {}]) {
      writeFileSync(f.settings, settings(env), 'utf8');
      const r = start({ state_file: script });
      expect(r.status, `env ${JSON.stringify(env)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, `env ${JSON.stringify(env)}`).toMatch(/not read to its end/);
      writeFileSync(f.settings, settings(env, 'sh'), 'utf8');
      expect(start({ state_file: script }).status, `env ${JSON.stringify(env)}: a program on the PATH of the guard`).toBe(0);
    }
  });

  it('a brace expression in a word of the command of another hook is expanded as Bash does ({a,b}, {1..3}, nested, before the parameters): each file it makes is never a file the guard writes; {} and {a} stay as they are and a range past the limit is not read to its end', () => {
    const f = fixture('foreign-braces', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '# the script that the command runs\n';
    for (const name of ['audit', 'audit2', 'other']) writeFileSync(join(hooks, name), text, 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (command: string) => JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const bash = spawnSync('bash', ['-c', `printf '%s\\n' ${hooks}/{audit,other} ${hooks}/audit{1..2} ${hooks}/{x,{audit,y}}`], { encoding: 'utf8' });
    if (bash.status === 0) expect(bash.stdout.split('\n').filter(Boolean).map((p) => p.slice(hooks.length + 1)), 'what Bash makes of these words').toEqual(['audit', 'other', 'audit1', 'audit2', 'x', 'audit', 'y']);
    const cases: Array<[string, string]> = [
      [`python3 ${hooks}/{audit,other}`, 'audit'], [`python3 ${hooks}/{other,audit}`, 'audit'], [`python3 ${hooks}/audit{1..2}`, 'audit2'],
      [`python3 ${hooks}/{x,{y,audit}}`, 'audit'], [`FHG_B=audit; python3 ${hooks}/{$FHG_B,z}`, 'audit'], [`python3 ${hooks}/audit{,2}`, 'audit2'],
    ];
    for (const [command, name] of cases) {
      const script = join(hooks, name);
      writeFileSync(f.settings, settings(command), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: script });
        expect(r.status, `${command} as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${command} as ${key}`).toContain(`"${key}" (${script}) and "program of another hook" (${script}) are the same file`);
        expect(readText(script), `${command} as ${key}: the program is intact`).toBe(text);
      }
    }
    // {} and {a} are no brace expansion (find -exec cmd {} \;): they name no file of the guard
    writeFileSync(f.settings, settings(`find . -name x -exec ${hooks}/tool {} \\; -o -name {a} -print`), 'utf8');
    const quiet = start({ state_file: join(hooks, 'audit') });
    expect(quiet.status, `${quiet.stdout}${quiet.stderr}`).toBe(0);
    // a range with more items than the limit is a command that is not read to its end
    writeFileSync(f.settings, settings('python3 x{1..100000}'), 'utf8');
    const long = start({ state_file: join(hooks, 'audit') });
    expect(long.status, `${long.stdout}${long.stderr}`).toBe(2);
    expect(long.stderr).toMatch(/is not read to its end/);
  });

  it('the suffix and prefix operators of a parameter (%, %%, #, ##, with patterns) cut the value the way a shell does, and every cut that the pattern can make is a file the guard never writes: ${NAME?word} gives the value, an unset name stays as written', () => {
    const f = fixture('foreign-trimmed-parameters', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(join(hooks, 'sub'), { recursive: true });
    const text = '# the script that the command runs\n';
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (command: string, env: Record<string, string>) => JSON.stringify({ env, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    // [the value of FHG_A, the expression, the file it makes]; what a shell makes of each is asked of sh below
    const cases: Array<[string, string, string]> = [
      [`${hooks}/audit.py`, '${FHG_A%.py}', join(hooks, 'audit')], [`${hooks}/audit.tar.gz`, '${FHG_A%.*}', join(hooks, 'audit.tar')],
      [`${hooks}/audit.tar.gz`, '${FHG_A%%.*}', join(hooks, 'audit')], [`${hooks}/audit`, '${FHG_A%.zzz}', join(hooks, 'audit')],
      [`${hooks}/sub/audit`, '${FHG_A#*/hooks/}', join(hooks, 'sub', 'audit')], [`${hooks}/sub/audit`, '${FHG_A##*/}', join(hooks, 'audit')],
      [`${hooks}/audit`, '${FHG_A?missing}', join(hooks, 'audit')], [`${hooks}/audit`, '${FHG_A:?missing}', join(hooks, 'audit')],
    ];
    for (const [value, expression, file] of cases) {
      const sh = spawnSync('sh', ['-c', `FHG_A='${value}'; printf %s "${expression}"`], { encoding: 'utf8' });
      const made = sh.stdout;
      // the files that a shell makes: the whole path, or a bare word that a cd to the directory of the file resolves
      expect(made === file || file === join(hooks, made), `sh makes ${made} of ${expression}`).toBe(true);
      writeFileSync(file, text, 'utf8');
      const command = made === file ? `python3 "${expression}"` : `cd ${hooks}; python3 "${expression}"`;
      writeFileSync(f.settings, settings(command, { FHG_A: value }), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: file });
        if (made.includes('/')) {
          expect(r.status, `${expression} of ${value} as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
          expect(r.stderr, `${expression} as ${key}`).toContain(`"${key}" (${file}) and "program of another hook" (${file}) are the same file`);
        } else expectUnread(r, key, `${expression} as ${key}: a bare word is a program that the PATH of the session may find`);   // (no PATH is given: the word is not read, as a collision is not written over)
        expect(readText(file), `${expression} as ${key}: the program is intact`).toBe(text);
      }
    }
    // a cut that no pattern makes names nothing; a name nobody sets stays as written
    writeFileSync(f.settings, settings('python3 "${FHG_A%.py}"', { FHG_A: `${hooks}/other.py` }), 'utf8');
    expect(start({ state_file: join(hooks, 'audit') }).status, 'the cut names another file').toBe(0);
    writeFileSync(f.settings, settings('python3 "${FHG_NOBODY%.py}" "${FHG_NOBODY#x}"', {}), 'utf8');
    expect(start({ state_file: join(hooks, 'audit') }).status, 'a name that is not set: a whole word of the session').toBe(2);
    writeFileSync(f.settings, settings('python3 "${FHG_NOBODY%.py}/x" "${FHG_NOBODY#x}/x"', {}), 'utf8');
    expect(start({ state_file: join(hooks, 'audit') }).status, 'a name that is not set, another ending').toBe(0);
  });

  it('a parameter in the pattern of a trimming expression is filled in before the cut (${NAME%$SUFFIX}, ${NAME%${SUFFIX}}, ${NAME#$PREFIX}); an unknown name there is refused, since the session may have it', () => {
    const f = fixture('foreign-trimmed-patterns', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '# the script that the command runs\n';
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (command: string, env: Record<string, string>) => JSON.stringify({ env, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    // [the env of settings.json, the expression, the file it makes]; what a shell makes of each is asked of sh below
    const cases: Array<[Record<string, string>, string, string]> = [
      [{ FHG_A: `${hooks}/audit.py`, FHG_S: '.py' }, '${FHG_A%$FHG_S}', join(hooks, 'audit')],
      [{ FHG_A: `${hooks}/audit.py`, FHG_S: '.py' }, '${FHG_A%${FHG_S}}', join(hooks, 'audit')],
      [{ FHG_A: `${hooks}/audit.py`, FHG_S: '.py' }, '${FHG_A%%$FHG_S}', join(hooks, 'audit')],
      [{ FHG_A: `${hooks}/audit.py`, FHG_P: `${hooks}/au` }, '${FHG_A#$FHG_P}', join(hooks, 'dit.py')],
      [{ FHG_A: `${hooks}/audit.py`, FHG_P: `${hooks}/au` }, '${FHG_A##$FHG_P}', join(hooks, 'dit.py')],
    ];
    for (const [env, expression, file] of cases) {
      const assign = Object.entries(env).map(([k, v]) => `${k}='${v}'`).join('; ');
      const made = spawnSync('sh', ['-c', `${assign}; printf %s "${expression}"`], { encoding: 'utf8' }).stdout;
      expect(made === file || file === join(hooks, made), `sh makes ${made} of ${expression}`).toBe(true);
      writeFileSync(file, text, 'utf8');
      writeFileSync(f.settings, settings(made === file ? `python3 "${expression}"` : `cd ${hooks}; python3 "${expression}"`, env), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: file });
        if (made.includes('/')) {
          expect(r.status, `${expression} as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
          expect(r.stderr, `${expression} as ${key}`).toContain(`"${key}" (${file}) and "program of another hook" (${file}) are the same file`);
        } else expectUnread(r, key, `${expression} as ${key}: a bare word is a program that the PATH of the session may find`);   // (no PATH is given: the word is not read, as a collision is not written over)
        expect(readText(file), `${expression} as ${key}: the program is intact`).toBe(text);
      }
    }
    // a name that nobody sets in the pattern cuts nothing for the shell of the hook, but the session may set it: the scan cannot know what is cut, so the command is not read to its end
    const unknown = '${FHG_A%$FHG_NOBODY}';
    expect(spawnSync('sh', ['-c', `FHG_A='${hooks}/audit.py'; printf %s "${unknown}"`], { encoding: 'utf8' }).stdout, 'sh cuts nothing').toBe(`${hooks}/audit.py`);
    writeFileSync(f.settings, settings(`python3 "${unknown}"`, { FHG_A: `${hooks}/audit.py` }), 'utf8');
    const refusal = start({ state_file: join(hooks, 'audit') });
    expect(refusal.status, 'an unknown name in a pattern').toBe(2);
    expect(refusal.stderr).toMatch(/not read to its end/);
  });

  it('a command substitution in the command of another hook (a dollar and a parenthesis, or a backtick, outside single quotes) is a command that is not read to its end: the guard keeps the file; text that is no substitution is read as before', () => {
    const f = fixture('foreign-substitution', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const audit = join(hooks, 'audit');
    writeFileSync(audit, '# the script that the command runs\n', 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, key: string) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, [key]: audit }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const sh = (command: string) => spawnSync('sh', ['-c', command], { encoding: 'utf8' }).stdout;
    expect(sh(`printf %s "$(printf ${hooks}/%s audit)"`), 'a substitution that makes the script').toBe(audit);
    expect(sh('printf %s \'$(x)\' "\\$(x)" $((1+2))'), 'no substitution in single quotes, after a backslash, in arithmetic').toBe('$(x)$(x)3');   // (the arithmetic is the shell's; the guard refuses it below)
    // refused, whichever file is meant: the result of the program is not known
    const substitutions = [
      `python3 "$(printf ${hooks}/%s audit)"`, `python3 $(printf ${hooks}/%s audit)`, 'python3 "`printf ' + hooks + '/%s audit`"', 'python3 `printf ' + hooks + '/%s audit`',
      `sh -c 'python3 "$(printf ${hooks}/%s audit)"'`, `true; python3 "a$(x)b"`, `python3 $'a' "$(x)"`, `true # note\npython3 "$(x)"`,
    ];
    for (const command of substitutions) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, key);
        expectUnread(r, key, `${JSON.stringify(command)} as ${key}`);
        expect(readText(audit), `${JSON.stringify(command)} as ${key}: the program is intact`).toBe('# the script that the command runs\n');
        expect(r.stderr).not.toMatch(/Traceback/);
      }
    }
    // read as before: no substitution
    const plain = [`python3 '$(x)'`, 'python3 "\\$(x)"', 'python3 "\\$((1+1))"', "python3 '$((1+1))'", 'python3 $FHG_NOBODY/x ${FHG_NOBODY:-x}/y', "python3 '`x`'", 'python3 \\`x', 'true # $(x)', "python3 $'$(x)'"];
    for (const command of plain) {
      const r = start(command, 'state_file');
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(0);
    }
    // a variable that nobody sets is the session's: a whole word of it is not read to its end
    expect(start('python3 $FHG_NOBODY ${FHG_NOBODY:-x}', 'state_file').status, 'a whole word that is a variable').toBe(2);
    // and a file that a plain command names is still protected
    const named = start(`python3 ${audit} '$(x)'`, 'state_file');
    expect(named.status, 'the file is named beside the single-quoted text').toBe(2);
    expect(named.stderr).toContain(`"state_file" (${audit}) and "program of another hook" (${audit}) are the same file`);
  });

  it('an arithmetic expansion in the command of another hook ($((...)) and $[...]) names a file like a substitution does, so the command is not read to its end: the guard keeps the file; single quotes and a backslash keep it text', () => {
    const f = fixture('foreign-arithmetic', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, file: string) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: file, log_file: f.log, settings_file: f.settings }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const a2 = join(hooks, 'a2');
    writeFileSync(a2, '# the script that the command runs\n', 'utf8');
    expect(spawnSync('sh', ['-c', `printf %s "${hooks}/a$((1+1))"`], { encoding: 'utf8' }).stdout, 'what the shell makes of the word').toBe(a2);
    expect(spawnSync('bash', ['-c', `printf %s "${hooks}/a$[1+1]"`], { encoding: 'utf8' }).stdout, 'the old form of Bash').toBe(a2);
    for (const command of [`python3 "${hooks}/a$((1+1))"`, `python3 ${hooks}/a$((1+1))`, `python3 "${hooks}/a$[1+1]"`, `sh -c 'python3 "${hooks}/a$((1+1))"'`, `true; python3 "a$((2-1))b"`]) {
      const r = start(command, a2);
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, JSON.stringify(command)).toMatch(/not read to its end/);
      expect(r.stderr).not.toMatch(/Traceback/);
    }
    for (const command of [`python3 '${hooks}/a$((1+1))'`, `python3 "${hooks}/a\\$((1+1))"`, `python3 '$[1+1]'`, `python3 "${hooks}/a$FHG_NOBODY/x"`, 'python3 "$ [1] $"']) {
      const r = start(command, a2);
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(0);
    }
    // a name that nobody sets at the end of the word may complete the file name: not read to its end
    expect(start(`python3 "${hooks}/a$FHG_NOBODY"`, a2).status, 'a variable of the session ends the word').toBe(2);
  });

  it('an extended glob pattern (@(a|b), ?(a), *(a), +(a), !(a)) outside quotes in the command of another hook is a word that the scan cannot expand, so the command is not read to its end: the guard keeps the file; a quoted pattern and the plain * and ? are read as before', () => {
    const f = fixture('foreign-extglob', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, file: string) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: file, log_file: f.log, settings_file: f.settings }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const audit = join(hooks, 'audit');
    writeFileSync(audit, '# the script that the command runs\n', 'utf8');
    if (HAS_BASH) {   // what Bash makes of the patterns where the option is on, and what it does not do with them
      for (const word of ['a@(udit|safe)', 'a?(x)udit', 'a*(x)udit', 'au+(d)it', '!(x)udit']) {
        expect(spawnSync('bash', ['-O', 'extglob', '-c', `printf %s ${hooks}/${word}`], { encoding: 'utf8' }).stdout, `the file that Bash runs for ${word}`).toBe(audit);
      }
      expect(spawnSync('bash', ['-c', `printf %s ${hooks}/'a@(udit|safe)'`], { encoding: 'utf8' }).stdout, 'a quoted pattern is text').toBe(`${hooks}/a@(udit|safe)`);
    }
    for (const command of [`bash -O extglob -c 'python3 ${hooks}/a@(udit|safe)'`, `python3 ${hooks}/a@(udit|safe)`, `python3 ${hooks}/a?(x)udit`, `python3 ${hooks}/a*(x)udit`, `python3 ${hooks}/au+(d)it`, `python3 ${hooks}/!(x)udit`, `bash -c 'shopt -s extglob\npython3 ${hooks}/a@(udit|safe)'`, `true; python3 "${hooks}"/a@(udit|safe)`]) {
      const r = start(command, audit);
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, JSON.stringify(command)).toMatch(/not read to its end/);
      expect(r.stderr).not.toMatch(/Traceback/);
    }
    for (const command of [`python3 ${hooks}/a*it`, `python3 ${hooks}/a?dit`]) {   // the plain patterns are still expanded: the file is found and is the state file
      const r = start(command, audit);
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, JSON.stringify(command)).toMatch(/are the same file/);
    }
    for (const command of [`python3 '${hooks}/a@(udit|safe)'`, `python3 "${hooks}/a@(udit|safe)"`, `python3 ${hooks}/a\\@\\(udit\\|safe\\)`, `python3 ${hooks}/other`, `echo '(a)' x`]) {
      const r = start(command, audit);
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('the name of a shell option that changes what a glob pattern matches (nocaseglob, dotglob, globstar) in the command of another hook is a mode that the scan does not model, so the command is not read to its end: the guard keeps the file, whether the option is given as -O, as shopt or in BASHOPTS; a command without such a name is read as before', () => {
    const f = fixture('foreign-glob-modes', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    const dots = join(f.dir, 'dots');
    mkdirSync(hooks);
    mkdirSync(dots);
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, file: string) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: file, log_file: f.log, settings_file: f.settings }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const audit = join(hooks, 'audit');
    const hidden = join(dots, '.audit');
    writeFileSync(audit, '# the script that the command runs\n', 'utf8');
    writeFileSync(hidden, '# the script that the command runs\n', 'utf8');
    if (HAS_BASH) {   // what Bash makes of the patterns where the option is on, and without it
      const bash = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync('bash', args, { encoding: 'utf8', env: { ...process.env, ...env } }).stdout;
      expect(bash(['-O', 'nocaseglob', '-c', `printf %s ${hooks}/AUD*`]), 'nocaseglob picks the file of the other case').toBe(audit);
      expect(bash(['-c', `printf %s ${hooks}/AUD*`]), 'and without it the pattern stays as it is').toBe(`${hooks}/AUD*`);
      expect(bash(['-O', 'dotglob', '-c', `printf %s ${dots}/*`]), 'dotglob matches a name that starts with a dot').toBe(hidden);
      expect(bash(['-O', 'globstar', '-c', `printf %s ${hooks}/**/audit`]), 'globstar lets ** match no directory').toBe(audit);
      expect(bash(['-c', `printf %s ${hooks}/**/audit`]), 'and without it the pattern stays as it is').toBe(`${hooks}/**/audit`);
      expect(bash(['-c', `printf %s ${hooks}/AUD*`], { BASHOPTS: 'nocaseglob' }), 'BASHOPTS in the environment turns an option on').toBe(audit);
    }
    for (const [command, file] of [[`bash -O nocaseglob -c 'python3 ${hooks}/AUD*'`, audit], [`bash -c 'shopt -s nocaseglob; python3 ${hooks}/AUD*'`, audit], [`env BASHOPTS=nocaseglob bash -c 'python3 ${hooks}/AUD*'`, audit],
      [`bash -O dotglob -c 'python3 ${dots}/*'`, hidden], [`bash -O globstar -c 'python3 ${hooks}/**/audit'`, audit], [`BASHOPTS=globstar python3 ${hooks}/**/audit`, audit]]) {
      const r = start(command, file);
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, JSON.stringify(command)).toMatch(/not read to its end/);
      expect(r.stderr).not.toMatch(/Traceback/);
    }
    for (const command of [`python3 ${hooks}/a*it`, `python3 ${hooks}/a?dit`]) {   // the plain patterns are still expanded: the file is found and is the state file
      const r = start(command, audit);
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, JSON.stringify(command)).toMatch(/are the same file/);
    }
    for (const command of [`python3 ${hooks}/other`, `bash -c 'python3 ${hooks}/other'`, `echo x`]) {
      const r = start(command, audit);
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('a builtin that assigns to a variable it is given by name (printf -v, read, let, mapfile, readarray, getopts, declare -n) in the command of another hook leaves the variable unknown, so the command is not read to its end: the guard keeps the file, also where the builtin stands in a quoted command; a command without such a builtin is read as before', () => {
    const f = fixture('foreign-name-setters', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '#!/bin/sh\necho ran\n';
    const audit = join(hooks, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, settingsEnv: Record<string, string> = {}) => {
      writeFileSync(f.settings, JSON.stringify({ env: settingsEnv, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: audit, log_file: f.log, settings_file: f.settings }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    if (HAS_BASH) {   // what Bash does: the variable that the settings give is replaced by the builtin, with a text that is not written in the command
      expect(spawnSync('bash', ['-c', `printf -v A "${hooks}/a\\x75dit"; printf %s "$A"`], { encoding: 'utf8', env: { ...process.env, A: '/tmp/safe' } }).stdout, 'printf -v computes the value').toBe(audit);
      expect(spawnSync('bash', ['-c', 'let A=1+1; printf %s "$A"'], { encoding: 'utf8', env: { ...process.env, A: '/tmp/safe' } }).stdout, 'let computes the value').toBe('2');
    }
    const settingsEnv = { A: '/tmp/safe' };
    const refused = [`bash -c 'printf -v A "${hooks}/a\\x75dit"; python3 "$A"'`, `printf -v A "${hooks}/a\\x75dit"; python3 "$A"`, `printf -vA "${hooks}/a\\x75dit"; python3 "$A"`, `printf -- -v; read A; python3 "$A"`,
      `read A; python3 "$A"`, `read -r A < input.txt; python3 "$A"`, `command read A; python3 "$A"`, `mapfile A; python3 "$A"`, `readarray -t A; python3 "$A"`, `getopts ab A; python3 "$A"`, `let A=1+1; python3 "$A"`,
      `declare -n R=A; R=${hooks}/audit; python3 "$A"`, `typeset -gn R=A; python3 "$A"`, `local -n R=A; python3 "$A"`, `true && read A`, `bash -c 'read A'`];
    for (const command of refused) {
      const r = start(command, settingsEnv);
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, JSON.stringify(command)).toMatch(/not read to its end/);
      expect(r.stderr).not.toMatch(/Traceback/);
      expect(readText(audit), `${JSON.stringify(command)}: the file is intact`).toBe(text);
    }
    // no such builtin, or no option that names a variable: read as before (the first of these runs the program that the settings name, so the file is not the state file here)
    for (const command of [`python3 "$A"`, `printf '%s\\n' -v`, `printf %s x`, `echo read A`, `python3 read.py`, `declare A=x; python3 other`, `declare -x A=x; python3 other`, `readonly B=x; python3 other`, `export A; python3 other`, `python3 ${hooks}/other`]) {
      const r = start(command, settingsEnv);
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('a BASHOPTS in the env of settings.json that names a shell option that changes what a glob pattern matches (nocaseglob, dotglob, globstar) makes every command a command that is not read to its end: the guard keeps the file, whatever the text of the command says; a BASHOPTS with other options, and no BASHOPTS, are read as before', () => {
    const f = fixture('foreign-inherited-bashopts', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '# the script that the command runs\n';
    const audit = join(hooks, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, env: Record<string, unknown>) => {
      writeFileSync(f.settings, JSON.stringify({ env, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: audit, log_file: f.log, settings_file: f.settings }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    if (HAS_BASH) {   // what Bash makes of the pattern with the option in the environment
      expect(spawnSync('bash', ['-c', `printf %s ${hooks}/AUD*`], { encoding: 'utf8', env: { ...process.env, BASHOPTS: 'nocaseglob' } }).stdout, 'BASHOPTS turns the option on').toBe(audit);
    }
    const command = `bash -c 'python3 ${hooks}/AUD*'`;
    for (const value of ['nocaseglob', 'dotglob', 'globstar', 'extglob:nocaseglob', 'dotglob:globstar']) {
      const r = start(command, { BASHOPTS: value });
      expect(r.status, `${value}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, value).toMatch(/not read to its end/);
      expect(r.stderr).not.toMatch(/Traceback/);
      expect(readText(audit), `${value}: the file is intact`).toBe(text);
    }
    // another option, no BASHOPTS, and a value that is no text name nothing: the command is read as before (its pattern does not match the file of the other case)
    for (const env of [{ BASHOPTS: 'extglob' }, {}, { BASHOPTS: 7 }, { OTHER: 'nocaseglob' }]) {
      const r = start(command, env);
      expect(r.status, `${JSON.stringify(env)}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('an append assignment NAME+=value in a command of another hook is not modelled, so the command is not read to its end: the guard keeps the file, also where it stands in a quoted command or after export or declare; a +=, outside quotes, in the middle of a word or in a word that is quoted, is read as before', () => {
    const f = fixture('foreign-append-assignment', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '#!/bin/sh\necho ran\n';
    const audit = join(hooks, 'audit');
    const appended = `${audit}.py`;
    writeFileSync(appended, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: appended, log_file: f.log, settings_file: f.settings }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    if (HAS_BASH) {   // what Bash makes of the append: the variable holds the two parts together
      expect(spawnSync('bash', ['-c', 'FHG_A=/x/audit; FHG_A+=.py; printf %s "$FHG_A"'], { encoding: 'utf8' }).stdout, 'the suffix is appended').toBe('/x/audit.py');
    }
    const refused = [`FHG_A=${audit}; FHG_A+=.py; python3 "$FHG_A"`, `bash -c 'FHG_A=${audit}; FHG_A+=.py; python3 "$FHG_A"'`, `FHG_A=${audit}\nFHG_A+=.py\npython3 "$FHG_A"`, `export FHG_A+=.py; python3 "$FHG_A"`,
      `declare FHG_A+=.py; python3 other`, `FHG_A+=.py python3 other`, `true && FHG_A+=x`, 'echo a+=b'];   // (the last is data to echo, which the scan cannot tell from an assignment: a false alarm)
    for (const command of refused) {
      const r = start(command);
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, JSON.stringify(command)).toMatch(/not read to its end/);
      expect(r.stderr).not.toMatch(/Traceback/);
      expect(readText(appended), `${JSON.stringify(command)}: the file is intact`).toBe(text);
    }
    // no append, or a += that is no assignment word: read as before
    for (const command of [`FHG_A=${audit}; python3 other`, 'echo "FHG_A+=.py"', "echo 'FHG_A+=.py'", `python3 ${hooks}/dir/FHG_A+=.py`, `python3 ${hooks}/other`, 'echo x']) {
      const r = start(command);
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('a state file is put in place like a pause file: a file that comes in at its path after the check of the settings and before the state is written is kept and the write fails, whether a state file was there or not; without one coming in the state is written as before', () => {
    // the arrival is injected when the temporary file of the write is created: after the check of the settings, before the file is put in place
    const driver = ['import os, runpy, sys', 'state, real, arrivals = sys.argv[1], os.open, []',
      'def late(path, *args, **kw):', '    if str(path).startswith(state + ".") and str(path).endswith(".tmp") and sys._getframe(1).f_code.co_name == "write_json" and not arrivals:',
      '        arrivals.append(1)', '        open(state + ".a", "w").write("foreign program\\n")', '        os.replace(state + ".a", state)',
      '    return real(path, *args, **kw)',
      'os.open = late', 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const f = fixture('state-late-arrival-existing', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.state, 'old state\n', 'utf8');
    const r = runPyCode(driver, [f.state, GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.stdout, `${r.stdout}${r.stderr}`).toMatch(/ERROR: tick failed.*changed since it was validated and is not replaced/);
    expect(readText(f.state), 'the file that came in over the old state is kept').toBe('foreign program\n');
    expect(readdirSync(f.dir).filter((n) => n.endsWith('.tmp')), 'no temporary file is left').toEqual([]);
    const g = fixture('state-late-arrival-absent', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const first = runPyCode(driver, [g.state, GUARD, ...guardArgs(g, ['--once'])]);
    expect(first.stdout, `${first.stdout}${first.stderr}`).toMatch(/ERROR: tick failed.*appeared meanwhile/);
    expect(readText(g.state), 'the file that came in where no state was is kept').toBe('foreign program\n');
    expect(readdirSync(g.dir).filter((n) => n.endsWith('.tmp')), 'no temporary file is left').toEqual([]);
    // nobody comes in: the first state is written, and a state that was there is replaced
    const h = fixture('state-clean-first', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    guardOnce(h);
    expect(readJson(h.state).paused, 'the first state is written').toBe(true);
    const k = fixture('state-clean-existing', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(k.state, 'old state\n', 'utf8');
    guardOnce(k);
    expect(readJson(k.state).paused, 'the old state is replaced').toBe(true);
    expect(readdirSync(k.dir).filter((n) => n.endsWith('.tmp')), 'no temporary file is left').toEqual([]);
  });

  it('where two paths cannot be exchanged (macOS, Windows) the state file and the renewal of the pause are put in place by a plain replace after one more look at the file, and a file that came in since the look is still kept', () => {
    // the C library cannot be loaded, so the guard has no exchange of two paths
    const none = ['import ctypes, os, runpy, sys', 'def none(*args, **kw):', '    raise OSError("no library")', 'ctypes.CDLL = none'];
    // a foreign file takes the path of the state file right after the look that write_json makes before it puts the file in place (the first look is the one at the start of the write)
    const arrival = ['state, real, looks = sys.argv[1], os.lstat, []', 'def look(path, *args, **kw):', '    found = real(path, *args, **kw)',
      '    if str(path) == state and sys._getframe(1).f_code.co_name == "write_json":', '        looks.append(1)', '        if len(looks) == 2:',
      '            open(state + ".a", "w").write("foreign program\\n")', '            os.replace(state + ".a", state)', '    return found', 'os.lstat = look'];
    const run = (lines: string[], f2: Fixture) => runPyCode([...none, ...lines, 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n'), [f2.state, GUARD, ...guardArgs(f2, ['--once'])]);
    const f = fixture('no-exchange-state-existing', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.state, 'old state\n', 'utf8');
    const first = run([], f);
    expect(first.stdout, `${first.stdout}${first.stderr}`).not.toContain('ERROR');
    expect(readJson(f.state).paused, 'the state that was there is replaced by the new one').toBe(true);
    expect(existsSync(f.pause), 'the first pause file is published by a hard link').toBe(true);
    const before = readJson(f.pause).valid_until;
    const renewal = run([], f);
    expect(renewal.stdout, `${renewal.stdout}${renewal.stderr}`).not.toContain('ERROR');
    expect(readJson(f.pause).valid_until, 'the pause is renewed without the exchange').toBeGreaterThan(before);
    expect(readdirSync(f.dir).filter((n) => n.endsWith('.tmp')), 'no temporary file is left').toEqual([]);
    const g = fixture('no-exchange-state-first', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const written = run([], g);
    expect(written.stdout, `${written.stdout}${written.stderr}`).not.toContain('ERROR');
    expect(readJson(g.state).paused, 'the first state is written').toBe(true);
    // the look at the file right before the plain replace keeps a file that came in after the look of write_json
    const h = fixture('no-exchange-state-arrival', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(h.state, 'old state\n', 'utf8');
    const late = run(arrival, h);
    expect(late.stdout, `${late.stdout}${late.stderr}`).toMatch(/ERROR: tick failed.*cannot be put in place/);
    expect(readText(h.state), 'the file that came in over the old state is kept').toBe('foreign program\n');
    expect(readdirSync(h.dir).filter((n) => n.endsWith('.tmp')), 'no temporary file is left').toEqual([]);
  });

  it('a relative entry of a PATH (of the command, of the env of settings.json) is looked up from each directory that the command names (cd DIR; PATH=bin audit), also with env -C, an entry of . or an empty one; a directory that does not exist adds nothing', () => {
    const f = fixture('foreign-relative-path', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(join(hooks, 'bin'), { recursive: true });
    const text = '#!/bin/sh\nexit 0\n';
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, file: string, env: Record<string, string> = {}) => {
      writeFileSync(f.settings, JSON.stringify({ env, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: file, log_file: f.log, settings_file: f.settings }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const inBin = join(hooks, 'bin', 'audit');
    const inHooks = join(hooks, 'audit');
    // what the shell runs: the script in bin below the directory that cd made the working directory
    const ran = (command: string, env: Record<string, string> = {}) => spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } }).stdout;
    writeFileSync(inBin, '#!/bin/sh\necho bin\n', { mode: 0o755 });
    writeFileSync(inHooks, '#!/bin/sh\necho here\n', { mode: 0o755 });
    expect(ran(`cd ${hooks}; PATH=bin audit`), 'a relative entry after cd').toBe('bin\n');
    expect(ran(`cd ${hooks}; PATH=. audit`), 'an entry of .').toBe('here\n');
    expect(ran('cd ' + hooks + '; audit', { PATH: 'bin' }), 'a relative entry of the environment after cd').toBe('bin\n');
    writeFileSync(inBin, text, { mode: 0o755 });
    writeFileSync(inHooks, text, { mode: 0o755 });
    const refused: Array<[string, string, Record<string, string>]> = [
      [`cd ${hooks}; PATH=bin audit`, inBin, {}], [`env -C ${hooks} PATH=bin audit`, inBin, {}], [`cd ${hooks}; audit`, inBin, { PATH: 'bin' }],
      [`cd ${hooks}; audit`, inBin, { PATH: '/usr/bin:bin' }], [`cd ${hooks}; PATH=. audit`, inHooks, {}], [`cd ${hooks}; PATH=:bin audit`, inBin, {}],
      [`cd ${hooks}; PATH=./bin audit`, inBin, {}],
    ];
    for (const [command, file, env] of refused) {
      const r = start(command, file, env);
      expect(r.status, `${JSON.stringify(command)} with ${JSON.stringify(env)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain(`"state_file" (${file}) and "program of another hook" (${file}) are the same file`);
      expect(readText(file), `${command}: the program is intact`).toBe(text);
    }
    // a directory that does not exist is no directory of the command: nothing is added
    const missing = start(`cd ${join(f.dir, 'nonexistent')}; PATH=bin audit`, inBin);
    expect(missing.status, `no such directory: the program is not found, and the session may find it: ${missing.stdout}${missing.stderr}`).toBe(2);
    expect(missing.stderr).toMatch(/not read to its end/);
  });

  it('a quoted word that starts with an operator character is a word and a file name (python3 \';audit\', \'&&audit\', \'|audit\', \'>audit\'); a real operator between two commands is no file of its own', () => {
    const f = fixture('foreign-operator-words', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '# the script that the command runs\n';
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (command: string) => JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    for (const name of [';audit', '&&audit', '|audit', '>audit', '(audit', 'audit;']) {
      const script = join(hooks, name);
      writeFileSync(script, text, 'utf8');
      for (const command of [`cd ${hooks}; PATH=${hooks} python3 '${name}'`, `python3 "${script}"`]) {   // (a bare word that is an operand may be a program of the PATH of the session: the PATH of the command settles it)
        writeFileSync(f.settings, settings(command), 'utf8');
        for (const key of ['log_file', 'state_file', 'pause_file']) {
          const r = start({ [key]: script });
          expect(r.status, `${command} as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
          expect(r.stderr, `${command} as ${key}`).toContain(`"${key}" (${script}) and "program of another hook" (${script}) are the same file`);
          expect(readText(script), `${command} as ${key}: the program is intact`).toBe(text);
        }
      }
    }
    // a real operator between two commands names no file of its own; a quoted one is a word, and the scanner does not tell them apart
    const operator = join(hooks, ';');
    writeFileSync(operator, text, 'utf8');
    for (const command of [`python3 x ; python3 y`, `cd ${hooks} && python3 x || python3 y`]) {
      writeFileSync(f.settings, settings(command), 'utf8');
      const r = start({ state_file: operator });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('a quoted word made only of operator characters (python3 \';\', \'&&\', \'|\', \'&\') is a script operand and a file name after a cd; a file that is no directory of the command joined with such a word is not', () => {
    const f = fixture('foreign-operator-only-words', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '# the script that the command runs\n';
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, file: string, key = 'state_file') => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, [key]: file }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    for (const word of [';', '&&', '|', '&']) {
      const script = join(hooks, word);
      writeFileSync(script, text, 'utf8');
      expect(spawnSync('sh', ['-c', `cd ${hooks}; printf %s '${word}'; true`], { encoding: 'utf8' }).stdout, `the shell passes ${word} as an operand`).toBe(word);
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start(`cd ${hooks}; python3 '${word}'`, script, key);
        expect(r.status, `${word} as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${word} as ${key}`).toContain(`"${key}" (${script}) and "program of another hook" (${script}) are the same file`);
        expect(readText(script), `${word} as ${key}: the program is intact`).toBe(text);
      }
    }
    // a file that is not a directory of the command joined with such a word
    const other = join(f.dir, 'other');
    mkdirSync(other);
    writeFileSync(join(other, ';'), text, 'utf8');
    expect(start(`cd ${hooks}; python3 ';'`, join(other, ';')).status, 'a directory that the command does not name').toBe(0);
  });

  it('the length of a parameter (${#NAME}) is filled in with the length of each value that NAME can have: from the command, from the env of settings.json; a name with no value stays as written and is no reason to refuse', () => {
    const f = fixture('foreign-parameter-length', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '# the script that the command runs\n';
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, file: string, env: Record<string, string> = {}) => {
      writeFileSync(f.settings, JSON.stringify({ env, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: file, log_file: f.log, settings_file: f.settings }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    // [the assignment before the word, the word, the file it makes, the env of settings.json]; what the shell makes of each is asked of sh below
    const cases: Array<[string, string, string, Record<string, string>]> = [
      ['X=ab', 'X', 'audit2', {}], ['X=abc', 'X', 'audit3', {}], ['', 'FHG_LEN', 'audit4', { FHG_LEN: 'abcd' }],
    ];
    for (const [assign, name, file, env] of cases) {
      const word = `${hooks}/audit\${#${name}}`;
      const made = spawnSync('/bin/sh', ['-c', `${assign || 'true'}; printf %s "${word}"`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } }).stdout;
      expect(made, `what sh makes of ${word}`).toBe(`${hooks}/${file}`);
      const script = join(hooks, file);
      writeFileSync(script, text, 'utf8');
      for (const command of [`${assign ? `${assign}; ` : ''}python3 "${word}"`, ...(assign ? [] : [`python3 ${word}`])]) {
        const r = start(command, script, env);
        expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, command).toContain(`"state_file" (${script}) and "program of another hook" (${script}) are the same file`);
        expect(readText(script), `${command}: the program is intact`).toBe(text);
      }
    }
    // an assignment in front of the command is not seen by the words of that command (the shell expands them first): sh makes audit0 of this word, and the guard cannot know the value, so the command is not read to its end
    expect(spawnSync('/bin/sh', ['-c', `X=ab true; printf %s "${hooks}/audit\${#X}"`], { encoding: 'utf8' }).stdout, 'sh does not see X').toBe(`${hooks}/audit0`);
    const scoped = start(`X=ab python3 ${hooks}/audit\${#X}`, join(hooks, 'audit2'));
    expect(scoped.status, 'a scoped assignment').toBe(2);
    expect(scoped.stderr).toMatch(/not read to its end/);
    // a length that no value has names another file; a name without a value stays as written
    expect(start(`X=ab; python3 "${hooks}/audit\${#X}"`, join(hooks, 'audit3')).status, 'another length').toBe(0);
    writeFileSync(join(hooks, 'audit0'), text, 'utf8');
    expect(start(`python3 "${hooks}/audit\${#FHG_NOBODY}"`, join(hooks, 'audit0')).status, 'a name that is not set ends the word: the session may give it any length').toBe(2);
    expect(start(`python3 "${hooks}/audit\${#FHG_NOBODY}x"`, join(hooks, 'audit0')).status, 'a name that is not set, another ending').toBe(0);
  });

  it('a PATH assignment is filled in with the values of its parameters before it is split into directories (PATH=$HOME/bin:/usr/bin audit, a name inside an entry); a name with no value stays as written; a relative entry that comes out of it is still joined with a directory that the command names', () => {
    const f = fixture('foreign-path-parameters', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const home = join(f.dir, 'home');
    mkdirSync(join(home, 'bin'), { recursive: true });
    mkdirSync(join(f.dir, 'hooks', 'bin'), { recursive: true });
    const text = '#!/bin/sh\nexit 0\n';
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, file: string, env: Record<string, string> = {}) => {
      writeFileSync(f.settings, JSON.stringify({ env, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: file, log_file: f.log, settings_file: f.settings }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const inHomeBin = join(home, 'bin', 'audit');
    const inHooksBin = join(f.dir, 'hooks', 'bin', 'audit');
    writeFileSync(inHomeBin, '#!/bin/sh\necho home\n', { mode: 0o755 });
    writeFileSync(inHooksBin, '#!/bin/sh\necho hooks\n', { mode: 0o755 });
    const ran = (command: string, env: Record<string, string>) => spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } }).stdout;
    expect(ran('PATH=$HOME/bin:/usr/bin audit', { HOME: home }), 'what sh runs').toBe('home\n');
    expect(ran(`cd ${f.dir}/hooks; PATH=$FHG_REL:/usr/bin audit`, { FHG_REL: 'bin' }), 'a relative entry that a variable gives').toBe('hooks\n');
    writeFileSync(inHomeBin, text, { mode: 0o755 });
    writeFileSync(inHooksBin, text, { mode: 0o755 });
    // [the command, the file it runs, the env of settings.json]
    const refused: Array<[string, string, Record<string, string>]> = [
      ['PATH=$HOME/bin:/usr/bin audit', inHomeBin, { HOME: home }], ['PATH=${HOME}/bin audit', inHomeBin, { HOME: home }], [`PATH=${f.dir}/$FHG_NAME/bin audit`, inHomeBin, { FHG_NAME: 'home' }],
      [`cd ${f.dir}/hooks; PATH=$FHG_REL:/usr/bin audit`, inHooksBin, { FHG_REL: 'bin' }],
    ];
    for (const [command, file, env] of refused) {
      const r = start(command, file, env);
      expect(r.status, `${command} with ${JSON.stringify(env)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain(`"state_file" (${file}) and "program of another hook" (${file}) are the same file`);
      expect(readText(file), `${command}: the program is intact`).toBe(text);
    }
    // a name with no value stays as written and no refusal comes of it (the program is looked up on the PATH of the session: refused below, as it is without any variable)
    expect(start('PATH=$FHG_NOBODY/bin:/usr/bin sh', inHomeBin).status, 'a name that nobody sets').toBe(0);
    expect(start('PATH=$FHG_NOBODY/bin:/usr/bin audit', inHomeBin).status, 'a name that nobody sets and a program that is not found').toBe(2);
  });

  it.skipIf(!HAS_BASH)('a Bash quote $\'...\' (and $"...") in the command of another hook is read as the text that Bash makes of it: hex, octal and Unicode escapes, a newline, an apostrophe, an unknown escape; quotes of other kinds are not decoded (needs bash: skipped where it is missing)', () => {
    const f = fixture('foreign-ansi-c', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '# the script that the command runs\n';
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, file: string, key = 'state_file') => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, [key]: file }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    // [the word as written, the file name that Bash makes of it (below the directory of the hooks)]
    const words: Array<[string, string]> = [
      [`$'${hooks}/a\\x75dit'`, 'audit'], [`$'${hooks}/a\\165dit'`, 'audit'], [`$'${hooks}/caf\\u00e9'`, 'caf\u00e9'], [`$'${hooks}/caf\\xc3\\xa9'`, 'caf\u00e9'],
      [`$'${hooks}/a\\nb'`, 'a\nb'], [`$'${hooks}/it\\'s'`, "it's"], [`$'${hooks}/a\\qb'`, 'a\\qb'], [`$"${hooks}/audit"`, 'audit'],
    ];
    for (const [word, name] of words) {
      const made = spawnSync('bash', ['-c', `printf %s ${word}`], { encoding: 'utf8' }).stdout;
      expect(made, `what Bash makes of ${word}`).toBe(`${hooks}/${name}`);
      const script = join(hooks, name);
      writeFileSync(script, text, 'utf8');
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(`python3 ${word}`, script, key);
        expect(r.status, `${word} as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${word} as ${key}`).toContain(`"${key}" (${script}) and "program of another hook" (${script}) are the same file`);
        expect(readText(script), `${word} as ${key}: the program is intact`).toBe(text);
      }
    }
    // not decoded: single quotes, double quotes, an escaped dollar sign, and a plain variable
    const audit = join(hooks, 'audit');
    for (const command of [`python3 '$a\\x75dit'`, `python3 "$'${hooks}/a\\x75dit'"`, `python3 \\$'${hooks}/a\\x75dit'`, `python3 $FHG_NOBODY'${hooks}/a\\x75dit'`]) {
      expect(start(command, audit).status, command).toBe(0);
    }
  });

  it('a backslash in the pattern of a trimming expression is an escape as in a shell: before a special character, in the longest cut and in a prefix, before an ordinary character; two of them are one backslash; patterns without a backslash cut as before', () => {
    const f = fixture('foreign-escaped-patterns', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '# the script that the command runs\n';
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (command: string, env: Record<string, string>) => JSON.stringify({ env, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    // [the value of FHG_A, the expression, the file it makes]; what a shell makes of each is asked of sh below
    const cases: Array<[string, string, string]> = [
      [`${hooks}/audit.py`, '${FHG_A%\\.py}', join(hooks, 'audit')], [`${hooks}/audit*`, '${FHG_A%\\*}', join(hooks, 'audit')], [`${hooks}/audit?`, '${FHG_A%\\?}', join(hooks, 'audit')],
      [`${hooks}/audit[`, '${FHG_A%\\[}', join(hooks, 'audit')], [`${hooks}/audit.tar.gz`, '${FHG_A%%\\.*}', join(hooks, 'audit')], [`${hooks}/audit.tar.gz`, '${FHG_A%%\\.t*z}', join(hooks, 'audit')],
      [`${hooks}/audit`, '${FHG_A##\\/*\\/}', join(hooks, 'audit')], [`${hooks}/audit.py`, '${FHG_A%\\.p\\y}', join(hooks, 'audit')], [`${hooks}/audit.py\\`, '${FHG_A%.py\\\\}', join(hooks, 'audit')],
    ];
    for (const [value, expression, file] of cases) {
      const made = spawnSync('sh', ['-c', `FHG_A='${value}'; printf %s "${expression}"`], { encoding: 'utf8' }).stdout;
      expect(made === file || file === join(hooks, made), `sh makes ${made} of ${expression}`).toBe(true);
      writeFileSync(file, text, 'utf8');
      writeFileSync(f.settings, settings(made === file ? `python3 "${expression}"` : `cd ${hooks}; python3 "${expression}"`, { FHG_A: value }), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: file });
        if (made.includes('/')) {
          expect(r.status, `${expression} of ${value} as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
          expect(r.stderr, `${expression} as ${key}`).toContain(`"${key}" (${file}) and "program of another hook" (${file}) are the same file`);
        } else expectUnread(r, key, `${expression} as ${key}: a bare word is a program that the PATH of the session may find`);   // (no PATH is given: the word is not read, as a collision is not written over)
        expect(readText(file), `${expression} as ${key}: the program is intact`).toBe(text);
      }
    }
    // an escaped special character is not a pattern: it cuts nothing from a value without it
    writeFileSync(f.settings, settings('python3 "${FHG_A%\\*}"', { FHG_A: `${hooks}/other.py` }), 'utf8');
    expect(start({ state_file: join(hooks, 'other') }).status, 'the escaped * is a character').toBe(0);
  });

  it('a control sequence in a Bash quote (dollar, apostrophe, backslash, c) is a command that is not read to its end: the guard keeps the file, also in a quoted command; the other escapes are decoded as before, and the same text as data is no reason to refuse', () => {
    const f = fixture('foreign-ansi-c-control', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '# the script that the command runs\n';
    const audit = join(hooks, 'audit');
    writeFileSync(audit, text, 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, key: string, file = audit) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, [key]: file }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    for (const command of [`python3 $'${hooks}/a\\cbdit'`, `python3 x $'\\cA'`, `sh -c "python3 $'${hooks}/a\\cbdit'"`]) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, key);
        expectUnread(r, key, `${JSON.stringify(command)} as ${key}`, /control sequence in a Bash quote/);
        expect(readText(audit), `${JSON.stringify(command)} as ${key}: the program is intact`).toBe('# the script that the command runs\n');
        expect(r.stderr).not.toMatch(/Traceback/);
      }
    }
    // not refused: a backslash twice before c (an escaped backslash and a c), single quotes, an escaped dollar sign, no Bash quote at all
    const other = join(hooks, 'other');
    for (const command of [`python3 $'${hooks}/ot\\\\cher'`, `python3 '\\cx'`, `python3 \\$'a\\cb'`, 'python3 a\\cb', `python3 "$'a\\cb'"`]) {
      const r = start(command, 'state_file', other);
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(0);
    }
    const decoded = start(`python3 $'${hooks}/a\\x75dit'`, 'state_file');
    expect(decoded.status, 'the other escapes are decoded as before').toBe(2);
    expect(decoded.stderr).toContain(`"state_file" (${audit}) and "program of another hook" (${audit}) are the same file`);
  });

  it('a quote in the pattern of a trimming expression, where the shell removes it and the scan would keep it as a character ("${A%\'.py\'}"), is a command that is not read to its end: the guard keeps the file; patterns without a quote, with a backslash or with an unquoted quote are read as before', () => {
    const f = fixture('foreign-trim-pattern-quotes', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '# the script that the command runs\n';
    const audit = join(hooks, 'audit');
    writeFileSync(audit, text, 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, key: string, file = audit) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, [key]: file }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const value = `A=${hooks}/audit.py;`;
    // what the shell makes of each: the quotes are removed from the pattern, and the cut is made
    const sh = (expression: string) => spawnSync('sh', ['-c', `A='${hooks}/audit.py'; printf %s ${expression}`], { encoding: 'utf8' }).stdout;
    expect(sh(`"\${A%'.py'}"`), 'a quote in the pattern in a quoted word').toBe(audit);
    expect(sh('"${A%%\\"x\\"}"'), 'an escaped double quote in the pattern').toBe(`${hooks}/audit.py`);
    expect(sh(`\${A%'.py'}`), 'a quote in the pattern in a bare word').toBe(audit);
    for (const command of [`${value} python3 "\${A%'.py'}"`, `${value} python3 "\${A%%\\"x\\"}"`, `${value} sh -c 'python3 "\${A%".py"}"'`]) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, key);
        expectUnread(r, key, `${JSON.stringify(command)} as ${key}`, /quote in the pattern of a trimming expression/);
        expect(readText(audit), `${JSON.stringify(command)} as ${key}: the program is intact`).toBe('# the script that the command runs\n');
        expect(r.stderr).not.toMatch(/Traceback/);
      }
    }
    // not refused: no quote, a backslash (decoded as before), the other forms with a quote in the word but not in the pattern
    const other = join(hooks, 'other');
    for (const command of [`${value} python3 "\${A%.py}"`, `${value} python3 "\${A%\\.py}"`, `${value} python3 "\${A:-'x'}"`, `${value} python3 '\${A%.py}'`]) {
      const r = start(command, 'state_file', other);
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(0);
    }
    // a quote that the scan removes before the word is read: the pattern arrives without it and the cut is found as before
    const bare = start(`${value} python3 \${A%'.py'}`, 'state_file');
    expect(bare.status, 'the bare quote is removed by the splitter: the cut is found').toBe(2);
    expect(bare.stderr).toContain(`"state_file" (${audit}) and "program of another hook" (${audit}) are the same file`);
  });

  it('a line continuation inside a command substitution, an arithmetic expansion, a Bash quote with a control sequence or the pattern of a trimming expression is removed before they are looked for: the command is refused like the same text on one line; an escaped backslash before the newline is no continuation', () => {
    const f = fixture('foreign-continued-substitution', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const audit = join(hooks, 'audit');
    writeFileSync(audit, '# the script that the command runs\n', 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, key: string) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, [key]: audit }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const sh = (command: string) => spawnSync('sh', ['-c', command], { encoding: 'utf8' }).stdout;
    const cont = '\\\n';   // a backslash and a newline
    expect(sh(`cd ${hooks}; printf %s "$${cont}(pwd)/audit"`), 'the shell removes the continuation first').toBe(audit);
    // refused, as the same text on one line is: [the command, the reason that the refusal names]
    const refused: Array<[string, RegExp]> = [
      [`cd ${hooks}; python3 "$${cont}(pwd)/audit"`, /command substitution/], [`cd ${hooks}; python3 "$(${cont}pwd)/audit"`, /command substitution/],
      [`python3 "${hooks}/a$${cont}((1+1))"`, /command substitution/], [`python3 "${hooks}/a$((${cont}1+1))"`, /command substitution/], [`python3 "${hooks}/a$${cont}[1+1]"`, /command substitution/],
      [`python3 $${cont}'${hooks}/a\\cbdit'`, /control sequence in a Bash quote/], [`A=${hooks}/audit.py; python3 "\${A%${cont}'.py'}"`, /quote in the pattern of a trimming expression/],
      [`sh -c 'cd ${hooks}; python3 "$${cont}(pwd)/audit"'`, /command substitution/],
    ];
    for (const [command, reason] of refused) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, key);
        expectUnread(r, key, `${JSON.stringify(command)} as ${key}`, reason);
        expect(readText(audit), `${JSON.stringify(command)} as ${key}: the program is intact`).toBe('# the script that the command runs\n');
        expect(r.stderr).not.toMatch(/Traceback/);
      }
    }
    // not refused: an escaped backslash before the newline is no continuation, and a continuation outside a substitution joins a path as before
    for (const command of [`python3 "$\\\\\n(pwd)/audit"`, `python3 "${hooks}/au${cont}dit2"`]) {
      const r = start(command, 'state_file');
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(0);
    }
    const joined = start(`python3 ${hooks}/au${cont}dit`, 'state_file');
    expect(joined.status, 'a path split in two lines is the file').toBe(2);
    expect(joined.stderr).toContain(`"state_file" (${audit}) and "program of another hook" (${audit}) are the same file`);
  });

  it('a shell comment in the command of another hook names no file (true # state is guard.state), and a # anywhere else is text: in quotes, inside a word, escaped, in a parameter; the next line of a command is still read', () => {
    const f = fixture('foreign-comments', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '# the script that the command runs\n';
    const audit = join(hooks, 'audit');
    const hashed = join(hooks, 'a#b');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (command: string) => JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    const start = (config: Record<string, string>) => {
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    // what a shell does with these texts
    const sh = (command: string) => spawnSync('sh', ['-c', command], { encoding: 'utf8' }).stdout;
    expect(sh('echo a # b'), 'a comment').toBe('a\n');
    expect(sh('echo a#b'), 'a # inside a word').toBe('a#b\n');
    expect(sh("echo '# b' \\# c"), 'quotes and a backslash').toBe('# b # c\n');
    // comments: the file named only in the comment is free
    for (const command of [`true # state is ${audit}`, `true;# ${audit}`, `python3 x # ${audit}\npython3 y`, `(true #${audit}\n)`]) {
      writeFileSync(f.settings, settings(command), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        rmSync(audit, { force: true });
        const r = start({ [key]: audit });
        expect(r.status, `${JSON.stringify(command)} as ${key}: ${r.stdout}${r.stderr}`).toBe(0);
      }
    }
    // not comments: the file is still named
    writeFileSync(audit, text, 'utf8');
    writeFileSync(hashed, text, 'utf8');
    const named: Array<[string, string]> = [
      [`python3 ${audit} # note`, audit], [`echo '# x ${audit}'`, audit], [`echo "a #b ${audit}"`, audit], [`python3 ${hashed}`, hashed], [`python3 \\# ${audit}`, audit],
      [`true # note\npython3 ${audit}`, audit], [`true; python3 ${audit} # note`, audit], [`echo \\$# ${audit}`, audit], ['FHG_A=1; python3 "${FHG_A#x}" ' + audit, audit],
      [`sh -c 'python3 ${audit} # note'`, audit], [`echo $'/a #x' ${audit}`, audit], [`cat <<EOF\n# ${audit}\nEOF`, audit],
    ];
    for (const [command, file] of named) {
      writeFileSync(f.settings, settings(command), 'utf8');
      for (const key of ['log_file', 'state_file', 'pause_file']) {
        const r = start({ [key]: file });
        expect(r.status, `${JSON.stringify(command)} as ${key}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${JSON.stringify(command)} as ${key}`).toContain(`"${key}" (${file}) and "program of another hook" (${file}) are the same file`);
        expect(readText(file), `${JSON.stringify(command)} as ${key}: the program is intact`).toBe(text);
      }
    }
  });

  it('a path of another hook that is relative where the command names no directory is run from the directory of the session, which the guard does not know: when it ends the path of a file the guard writes the guard keeps the file; a cd, an absolute path or a name that no file of the guard has settles it as before', () => {
    const f = fixture('foreign-session-directory', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const project = join(f.dir, 'project');   // the working directory of the session: the guard runs in another one
    mkdirSync(join(project, 'sub'), { recursive: true });
    const text = '# the script that the command runs\n';
    const files = { './audit': join(project, 'audit'), 'sub/audit': join(project, 'sub', 'audit'), '../project/audit': join(project, 'audit') };
    for (const file of new Set(Object.values(files))) writeFileSync(file, text, 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const cat = (path: string, cwd: string) => spawnSync('sh', ['-c', `cat ${path}`], { encoding: 'utf8', cwd });
    expect(cat('./audit', project).stdout, 'the shell takes a relative path from the directory of the session').toBe(text);
    expect(cat('./audit', f.dir).status, 'and from no other').not.toBe(0);
    // the guard cannot tell which directory that is, so a path that may be one of its files is refused, whichever file it is
    for (const [word, file] of Object.entries(files)) {
      for (const command of [`python3 ${word}`, `true; python3 ${word} x`, `sh -c 'python3 ${word}'`, `python3 -u --log=${word}`]) {
        for (const key of ['state_file', 'pause_file', 'log_file']) {
          const r = start(command, { [key]: file });
          expectUnread(r, key, `${command} as ${key}`);
          expect(r.stderr).not.toMatch(/Traceback/);
          expect(readText(file), `${command} as ${key}: the file is intact`).toBe(text);
        }
      }
    }
    // not refused for that: a path of another name, and a path that a directory of the command settles (that is the collision of an earlier test)
    expect(start('python3 ./audit', {}).status, 'no file of the guard ends it').toBe(0);
    expect(start('python3 ./audit-other', { state_file: files['./audit'] }).status, 'another name').toBe(0);
    for (const command of [`python3 ${files['./audit']}`, `cd ${project}; python3 ./audit`, `env -C ${project} python3 sub/audit`, `sh -c 'cd ${project} && ./audit'`, `env --chdir ${project} python3 ./audit`]) {
      const r = start(command, { state_file: command.includes('sub/') ? files['sub/audit'] : files['./audit'] });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain('are the same file');
      expect(r.stderr, command).not.toMatch(/not read to its end/);
    }
  });

  it('a directory that a word of the command only names (an argument) does not move the working directory: a relative path that ends the path of a file the guard writes is still run from the directory of the session and the guard keeps the file; a cd, pushd, -C, --directory or --chdir settles it as before', () => {
    const f = fixture('foreign-session-directory-argument', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const project = join(f.dir, 'project');   // the working directory of the session: the guard runs in another one
    const other = join(f.dir, 'other');   // a directory that the command names as an argument
    mkdirSync(join(project, 'sub'), { recursive: true });
    mkdirSync(other);
    const text = '# the script that the command runs\n';
    const files = { './audit': join(project, 'audit'), 'sub/audit': join(project, 'sub', 'audit') };
    for (const file of Object.values(files)) writeFileSync(file, text, 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const shell = (command: string, cwd: string) => spawnSync('sh', ['-c', command], { encoding: 'utf8', cwd }).stdout;
    expect(shell(`cat ./audit ${other}`, project), 'the shell runs ./audit from the directory of the session, whatever directory is an argument').toBe(text);
    expect(shell(`cd ${other}; cat ./audit`, project), 'and from the directory that a cd names').toBe('');
    for (const [word, file] of Object.entries(files)) {
      for (const command of [`python3 ${word} ${other}`, `python3 ${word} --flag ${other}`, `python3 ${other} ${word}`, `ls ${other}; python3 ${word}`, `sh -c 'python3 ${word} ${other}'`, `python3 -u --log=${word} --out ${other}`]) {
        for (const key of ['state_file', 'pause_file', 'log_file']) {
          const r = start(command, { [key]: file });
          expectUnread(r, key, `${command} as ${key}`);
          expect(r.stderr).not.toMatch(/Traceback/);
          expect(readText(file), `${command} as ${key}: the file is intact`).toBe(text);
        }
      }
    }
    // a construct that moves the working directory settles it: the file is that of the directory it names (the collision of an earlier test)
    for (const command of [`cd ${project}; python3 ./audit`, `pushd ${project} && python3 ./audit`, `env -C ${project} python3 ./audit`, `env --chdir ${project} python3 ./audit`, `env --chdir=${project} python3 ./audit`,
      `nohup env -C ${project} ./audit`, `env -i --chdir=${project} python3 ./audit`, `sh -c 'cd ${project} && ./audit'`, `cd ${other}; python3 ${other}/x; cd ${project}; ./audit`]) {
      const r = start(command, { state_file: files['./audit'] });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain('are the same file');
      expect(r.stderr, command).not.toMatch(/not read to its end/);
    }
    // the option of a program that is not a wrapper the scan knows (`make -C DIR`, `nice -n 5 env -C DIR`) follows the word that is run: it is an argument, so the directory of the session stays a candidate (a false alarm, here)
    for (const command of [`make -C ${project} ./audit`, `nice -n 5 env -C ${project} ./audit`]) {
      const r = start(command, { state_file: files['./audit'] });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toMatch(/not read to its end/);
    }
    // a construct that moves it to another directory: the file of the session is not the one that runs
    for (const command of [`cd ${other}; python3 ./audit`, `env -C ${other} python3 ./audit --directory ${other}`]) {
      const r = start(command, { state_file: files['./audit'] });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('a program of another hook that the PATH of the guard does not find is looked up on the PATH of the session, which the guard does not know: when its name is that of a file the guard writes the guard keeps the file; a PATH that the guard, the command or the settings has, or a name that no file of the guard has, settles it as before', () => {
    const f = fixture('foreign-session-path', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '#!/bin/sh\necho ran\n';
    const audit = join(hooks, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>, settingsEnv: Record<string, string> = {}, guardEnv: NodeJS.ProcessEnv = ENV) => {
      writeFileSync(f.settings, JSON.stringify({ env: settingsEnv, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once'], { env: guardEnv });
    };
    // the process of the session has the directory in its PATH, the process of the guard has not
    const sessionEnv = { ...process.env, PATH: `${hooks}:${process.env.PATH}` };
    expect(spawnSync('sh', ['-c', 'audit'], { encoding: 'utf8', env: sessionEnv }).stdout, 'the session runs the program').toBe('ran\n');
    expect(spawnSync('sh', ['-c', 'audit'], { encoding: 'utf8', env: ENV }).status, 'the guard does not find it').not.toBe(0);
    for (const command of ['audit', 'exec audit', 'command audit', 'env audit --flag', 'true; audit', 'if true; then audit; fi', "sh -c 'audit --flag'", 'FOO=1 audit', '[ -f x ] || audit']) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: audit });
        expectUnread(r, key, `${command} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit), `${command} as ${key}: the program is intact`).toBe(text);
      }
    }
    // settled as before: a PATH of the guard, of the settings or of the command that has the directory is the collision of an earlier test
    const settled: Array<[string, Record<string, string>, NodeJS.ProcessEnv]> = [['audit', { PATH: hooks }, ENV], [`PATH=${hooks} audit`, {}, ENV], [`env PATH=${hooks} audit`, {}, ENV]];
    for (const [command, settingsEnv, guardEnv] of settled) {
      const r = start(command, { state_file: audit }, settingsEnv, guardEnv);
      expect(r.status, `${command} with ${JSON.stringify(settingsEnv)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain(`"state_file" (${audit}) and "program of another hook" (${audit}) are the same file`);
      expect(r.stderr, command).not.toMatch(/not read to its end/);
    }
    // not refused: a name that no file of the guard has, and programs on the PATH of the guard
    expect(start('audit', {}).status, 'no file of the guard has the name').toBe(0);
    expect(start('sh -c "exit 0"; python3 -I x', { state_file: audit }).status, 'programs of the PATH of the guard').toBe(0);
  });

  it('a cd that does not move the working directory of the word after it (in a subshell, a pipe, the background, before ||, a group in a pipe) does not settle a relative path: the guard still takes the directory of the session as a candidate and keeps the file; a cd of the same chain (after ;, &&, a newline, in a group or a subshell that holds both), and -C, --directory and --chdir of the command itself settle it', () => {
    const f = fixture('foreign-session-directory-chain', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const project = join(f.dir, 'project');   // the working directory of the session: the guard runs in another one
    const other = join(f.dir, 'other');   // a directory that a cd names
    mkdirSync(project);
    mkdirSync(other);
    const text = '# the script that the command runs\n';
    const file = join(project, 'audit');
    writeFileSync(file, text, 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    // what the shell does: ./audit is the file of the directory of the session except where the cd moved this shell
    const shell = (command: string) => spawnSync('sh', ['-c', command], { encoding: 'utf8', cwd: project }).stdout;
    const refused = (cd: string) => [`(cd ${cd}); python3 ./audit`, `cd ${cd} | python3 ./audit`, `cd ${cd} & python3 ./audit`, `cd ${cd} || python3 ./audit`, `{ cd ${cd}; } | python3 ./audit`, `true || cd ${cd}; python3 ./audit`,
      `(cd ${cd} && true); python3 ./audit`, `true && (cd ${cd}); python3 ./audit`];
    const settled = (cd: string) => [`cd ${cd}; python3 ./audit`, `cd ${cd} && python3 ./audit`, `cd ${cd}\npython3 ./audit`, `(cd ${cd} && python3 ./audit)`, `{ cd ${cd}; python3 ./audit; }`, `true; cd ${cd} && python3 ./audit`, `true & cd ${cd}; python3 ./audit`,
      `env -C ${cd} python3 ./audit`, `env --chdir ${cd} python3 ./audit`, `env --chdir=${cd} python3 ./audit`];
    for (const command of refused(other).map((c) => c.replace('python3', 'cat'))) {
      expect(shell(command), `${command}: the shell runs ./audit of the directory of the session`).toBe(command.includes(` || cat`) && !command.startsWith('true') ? '' : text);   // (after a cd that succeeds, || does not run the next command at all)
    }
    expect(shell(`cd ${join(f.dir, 'nonexistent')} || cat ./audit`), 'and after a cd that fails the next command runs there').toBe(text);
    for (const command of settled(other).filter((c) => !c.includes('--')).map((c) => c.replace('python3', 'cat'))) {
      expect(shell(command), `${command}: the shell runs ./audit of the directory that the cd names`).toBe('');
    }
    for (const command of refused(other)) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: file });
        expectUnread(r, key, `${command} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(file), `${command} as ${key}: the file is intact`).toBe(text);
      }
    }
    // a move of the same chain (or of the command itself) names the file of the directory it moves to: with the directory of the session there is a collision, with another one the file is not the one that runs
    for (const command of settled(project)) {
      const r = start(command, { state_file: file });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain('are the same file');
      expect(r.stderr, command).not.toMatch(/not read to its end/);
    }
    for (const command of settled(other)) {
      const r = start(command, { state_file: file });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('a cd that stands after then, else, elif, do or case may not run, so it moves nothing that is known: the file of the directory of the session stays a candidate and the guard keeps the file, while the directory it names is one more candidate; a cd before the branch, and one in no branch, still move the chain', () => {
    const f = fixture('foreign-session-directory-branch', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const project = join(f.dir, 'project');   // the working directory of the session: the guard runs in another one
    const other = join(f.dir, 'other');   // a directory that a cd names
    mkdirSync(project);
    mkdirSync(other);
    const text = '# the script that the command runs\n';
    const file = join(project, 'audit');
    writeFileSync(file, text, 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const shell = (command: string) => spawnSync('sh', ['-c', command], { encoding: 'utf8', cwd: project }).stdout;
    const notRun = (cd: string) => [`if false; then cd ${cd}; fi; python3 ./audit`, `if true; then :; else cd ${cd}; fi; python3 ./audit`, `while false; do cd ${cd}; done; python3 ./audit`, `case x in y) cd ${cd};; esac; python3 ./audit`,
      `if false; then :; elif false; then cd ${cd}; fi; python3 ./audit`, `if false; then pushd ${cd}; fi; python3 ./audit`];
    const moved = (cd: string) => [`cd ${cd}; python3 ./audit`, `cd ${cd}; if true; then :; fi; python3 ./audit`];
    // what the shell does: a cd that does not run leaves ./audit in the directory of the session, one that is made moves it
    for (const command of notRun(other).filter((c) => !c.includes('pushd')).map((c) => c.replace('python3', 'cat'))) expect(shell(command), `${command}: the shell runs ./audit of the directory of the session`).toBe(text);
    for (const command of moved(other).map((c) => c.replace('python3', 'cat'))) expect(shell(command), `${command}: the shell runs ./audit of the directory that the cd names`).toBe('');
    for (const command of notRun(other)) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: file });
        expectUnread(r, key, `${command} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(file), `${command} as ${key}: the file is intact`).toBe(text);
      }
    }
    // a cd that is made names the file of the directory it moves to: with the directory of the session there is a collision, with another one the file is not the one that runs
    for (const command of moved(project)) {
      const r = start(command, { state_file: file });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain('are the same file');
      expect(r.stderr, command).not.toMatch(/not read to its end/);
    }
    for (const command of moved(other)) {
      const r = start(command, { state_file: file });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('an option or a cd word that stands after the word a simple command runs is an argument of the program and moves nothing (python3 ./audit --chdir DIR, -C DIR, --directory=DIR, echo cd; ./audit, python3 ./audit cd DIR): the guard keeps the directory of the session as a candidate and keeps the file; a wrapper option in front of the word (env -C DIR, env --chdir DIR, env --chdir=DIR) and a cd that the shell runs settle it as before', () => {
    const f = fixture('foreign-session-directory-position', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const project = join(f.dir, 'project');   // the working directory of the session: the guard runs in another one
    const other = join(f.dir, 'other');   // a directory that the command names
    mkdirSync(project);
    mkdirSync(other);
    const file = join(project, 'audit');
    writeFileSync(file, 'echo from-project\n', 'utf8');
    writeFileSync(join(other, 'audit'), 'echo from-other\n', 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const shell = (command: string) => spawnSync('sh', ['-c', command], { encoding: 'utf8', cwd: project }).stdout;
    const refused = (cd: string) => [`python3 ./audit --chdir ${cd}`, `python3 ./audit -C ${cd}`, `python3 ./audit --directory=${cd}`, `python3 ./audit --directory ${cd}`, `echo cd; ./audit`, `python3 ./audit cd ${cd}`, `echo pushd ${cd}; python3 ./audit`,
      `nice -n 5 env -C ${cd} ./audit`];
    const settled = (cd: string) => [`env -C ${cd} python3 ./audit`, `env --chdir ${cd} python3 ./audit`, `env --chdir=${cd} python3 ./audit`, `cd ${cd}; python3 ./audit`, `cd ${cd} && python3 ./audit`, `env -i -C ${cd} python3 ./audit`];
    // what the shell does: an argument after the script does not move it; the options of env before the program do
    expect(shell(`sh ./audit --chdir ${other}`), 'an argument of the script').toBe('from-project\n');
    expect(shell(`sh ./audit cd ${other}`), 'an argument of the script').toBe('from-project\n');
    expect(shell(`echo cd; sh ./audit`), 'a word of another command').toBe('cd\nfrom-project\n');
    expect(shell(`env -C ${other} sh ./audit`), 'the option of env moves').toBe('from-other\n');
    expect(shell(`cd ${other}; sh ./audit`), 'a cd moves').toBe('from-other\n');
    for (const command of refused(other)) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: file });
        expectUnread(r, key, `${command} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(file), `${command} as ${key}: the file is intact`).toBe('echo from-project\n');
      }
    }
    // the options of a wrapper and a cd of the shell name the file of the directory that they move to: the directory of the session is a collision, another directory is a file that is not the one that runs
    for (const command of settled(project)) {
      const r = start(command, { state_file: file });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain('are the same file');
      expect(r.stderr, command).not.toMatch(/not read to its end/);
    }
    for (const command of settled(other)) {
      const r = start(command, { state_file: file });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('a pattern of a trimming expression (%, %%, #, ##) that holds a parameter that nothing gives a value to is a pattern whose cut the scan cannot know (the session may have it), so the guard keeps the file; a pattern that the settings, the command or a default word fills in, and a pattern with no parameter, are read as before', () => {
    const f = fixture('foreign-trimming-pattern-parameter', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '#!/bin/sh\necho ran\n';
    const audit = join(hooks, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, env: Record<string, string>, config: Record<string, string>) => {
      writeFileSync(f.settings, JSON.stringify({ env, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const settings = { FHG_A: `${audit}.py`, FHG_B: `/prefix/audit` };   // what the settings give the hook; the session has FHG_S besides
    const session = (command: string) => spawnSync('sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, ...settings, FHG_S: '.py', FHG_P: '/prefix/' } }).stdout;
    expect(session(`printf %s "\${FHG_A%$FHG_S}"`), 'the shell cuts the suffix that only the session has').toBe(audit);
    expect(session(`printf %s "\${FHG_A%%$FHG_S}"`)).toBe(audit);
    expect(session(`printf %s "${hooks}/\${FHG_B#$FHG_P}"`), 'and the prefix').toBe(audit);
    expect(session(`printf %s "${hooks}/\${FHG_B##$FHG_P}"`)).toBe(audit);
    const refused = ['python3 "${FHG_A%$FHG_S}"', 'python3 "${FHG_A%%$FHG_S}"', `python3 "${hooks}/\${FHG_B#$FHG_P}"`, `python3 "${hooks}/\${FHG_B##$FHG_P}"`, 'python3 ${FHG_A%$FHG_S}', 'python3 "${FHG_A%$FHG_S$FHG_T}"'];
    for (const command of refused) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, settings, { [key]: audit });
        expectUnread(r, key, `${command} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit), `${command} as ${key}: the file is intact`).toBe(text);
      }
    }
    // read as before: a pattern without a parameter, one that the settings or the command give a value to, one with a default word (the file that it cuts to is a collision, not a refusal)
    for (const [command, env] of [['python3 "${FHG_A%.py}"', settings], ['python3 "${FHG_A%$FHG_S}"', { ...settings, FHG_S: '.py' }], ['FHG_S=.py; python3 "${FHG_A%$FHG_S}"', settings], ['python3 "${FHG_A%${FHG_S:-.py}}"', settings],
      [`python3 "${hooks}/\${FHG_B#$FHG_P}"`, { ...settings, FHG_P: '/prefix/' }]] as Array<[string, Record<string, string>]>) {
      const r = start(command, env, { state_file: audit });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain('are the same file');
      expect(r.stderr, command).not.toMatch(/not read to its end/);
    }
  });

  it('an assignment in front of a command (NAME=x cmd, env NAME=x cmd) is that command\'s alone, and unset takes a name away: a parameter that only such an assignment or the session gives is a word the scan cannot know, so the guard keeps the file; an assignment that stands alone, after export or as ${NAME:=word}, and an assignment that a quoted command in the same simple command gets, are read as before', () => {
    const f = fixture('foreign-assignment-scope', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '#!/bin/sh\necho ran\n';
    const audit = join(hooks, 'audit');
    const old = join(hooks, 'audit.old');
    writeFileSync(audit, text, { mode: 0o755 });
    writeFileSync(old, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const path = (command: string) => spawnSync('sh', ['-c', command.replace('python3', 'printf %s')], { encoding: 'utf8' }).stdout;
    const refused = [`FHG_S=.old true; python3 ${hooks}/audit$FHG_S`, `env FHG_S=.old true; python3 ${hooks}/audit$FHG_S`, `FHG_S=.old; unset FHG_S; python3 ${hooks}/audit$FHG_S`, `FHG_S=.old; unset -v FHG_S; python3 ${hooks}/audit$FHG_S`,
      `FHG_S=.old python3 ${hooks}/audit$FHG_S`, `FHG_S=.old true; python3 "${hooks}/audit$FHG_S"`, `FHG_S=.old true; sh -c 'python3 ${hooks}/audit$FHG_S'`, `: \${FHG_S:=.old}; python3 ${hooks}/audit$FHG_S`];
    const settled = [`FHG_S=.old; python3 ${hooks}/audit$FHG_S`, `export FHG_S=.old; python3 ${hooks}/audit$FHG_S`, `env FHG_S=.old sh -c 'python3 ${hooks}/audit$FHG_S'`, `: \${FHG_S:=.old}x; python3 ${hooks}/audit$FHG_S`,
      `FHG_S=.old\npython3 ${hooks}/audit$FHG_S`, `FHG_S=.old; true; python3 ${hooks}/audit\${FHG_S}`];
    for (const command of refused.slice(0, 5)) {
      expect(path(command).includes('.old'), `${command}: the shell does not give the name to this command`).toBe(false);
    }
    for (const command of settled.slice(0, 3).concat(settled.slice(4))) {
      expect(path(command), `${command}: the shell has the name`).toBe(old);
    }
    for (const command of refused) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: audit });
        expectUnread(r, key, `${command} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit), `${command} as ${key}: the file is intact`).toBe(text);
      }
    }
    // the name has a value for the command: the scan reads audit.old, which is the file when it is the state file
    for (const command of settled) {
      const r = start(command, { state_file: old });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain('are the same file');
      expect(r.stderr, command).not.toMatch(/not read to its end/);
    }
  });

  it('a standalone assignment, an export or a default-assigning expansion gives its name a value only to the commands and words after it: a name that is used before it is the one the session has, so the guard keeps the file; an assignment before the use settles it, as unset takes it away from the next command on', () => {
    const f = fixture('foreign-assignment-order', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '#!/bin/sh\necho ran\n';
    const audit = join(hooks, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const later = '/nonexistent/later';
    const ran = (command: string) => spawnSync('sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, FHG_AUDIT: audit } }).stdout.includes('ran');
    const used = [`"$FHG_AUDIT"; FHG_AUDIT=${later}`, `"$FHG_AUDIT"; export FHG_AUDIT=${later}`, `"$FHG_AUDIT"; : "\${FHG_AUDIT:=${later}}"`, `"$FHG_AUDIT"\nFHG_AUDIT=${later}`];
    const unsetBefore = `FHG_AUDIT=${later}; unset FHG_AUDIT; "$FHG_AUDIT"`;   // the shell runs nothing here (the name is gone); the scan does not know what the session would have, so it refuses
    const set = [`FHG_AUDIT=${later}; "$FHG_AUDIT"`, `export FHG_AUDIT=${later}; "$FHG_AUDIT"`, `unset FHG_AUDIT; FHG_AUDIT=${later}; "$FHG_AUDIT"`, `FHG_AUDIT=${later}; "$FHG_AUDIT"; unset FHG_AUDIT`];
    // what the shell does: the first command runs the file of the session, the others the name that was set before the use (which is no file)
    for (const command of used) expect(ran(command), `${JSON.stringify(command)}: the session's file runs`).toBe(true);
    for (const command of set) expect(ran(command), `${JSON.stringify(command)}: the name was set before the use`).toBe(false);
    for (const command of [...used, unsetBefore]) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: audit });
        expectUnread(r, key, `${JSON.stringify(command)} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit), `${JSON.stringify(command)} as ${key}: the file is intact`).toBe(text);
      }
    }
    for (const command of set) {
      const r = start(command, { state_file: audit });
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('an assignment gives its name a value for the commands after it only where the shell has made it: one that stands first or after a semicolon or a new line and that no pipe or ampersand follows, not one after && or || (that may be notMade), in a subshell, in a pipeline or in the background: the name is then still the one the session has, so the guard keeps the file', () => {
    const f = fixture('foreign-assignment-control', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '#!/bin/sh\necho ran\n';
    const audit = join(hooks, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const later = '/nonexistent/later';
    const ran = (command: string) => spawnSync('sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, FHG_AUDIT: audit } }).stdout.includes('ran');
    const notMade = [`false && FHG_AUDIT=${later}; "$FHG_AUDIT"`, `(FHG_AUDIT=${later}); "$FHG_AUDIT"`, `FHG_AUDIT=${later} | cat; "$FHG_AUDIT"`, `FHG_AUDIT=${later} & "$FHG_AUDIT"`, `false && : "\${FHG_AUDIT:=${later}}/"; "$FHG_AUDIT"`, `true | FHG_AUDIT=${later}; "$FHG_AUDIT"`];
    const afterAnd = [`true && FHG_AUDIT=${later}; "$FHG_AUDIT"`, `true && export FHG_AUDIT=${later}; "$FHG_AUDIT"`];   // the shell makes these (the command in front succeeds); the scan reads only the operator, so it does not know: a false alarm
    const made = [`FHG_AUDIT=${later}; "$FHG_AUDIT"`, `FHG_AUDIT=${later}\n"$FHG_AUDIT"`, `export FHG_AUDIT=${later} && "$FHG_AUDIT"`, `true; FHG_AUDIT=${later}; "$FHG_AUDIT"`, `: "\${FHG_AUDIT:=${later}}/"; "$FHG_AUDIT"`];
    // what the shell does: an assignment that it does not make (after a false &&, in a subshell, in a pipeline or in the background) leaves the file of the session; one that is made, the name that was set
    for (const command of notMade) expect(ran(command), `${JSON.stringify(command)}: the session's file runs`).toBe(true);
    for (const command of [...made, ...afterAnd].filter((c) => !c.includes(':='))) expect(ran(command), `${JSON.stringify(command)}: the name was set before the use`).toBe(false);   // (`:=` leaves a name that has a value: the scan counts it as set anyway)
    for (const command of [...notMade, ...afterAnd]) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: audit });
        expectUnread(r, key, `${JSON.stringify(command)} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit), `${JSON.stringify(command)} as ${key}: the file is intact`).toBe(text);
      }
    }
    // an assignment that is made settles the name, as before
    for (const command of made) {
      const r = start(command, { state_file: audit });
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('an assignment that stands in a branch or a loop body (after then, else, elif or do) settles no name for the commands after it, since the body may not run: the name is then still the one the session has, so the guard keeps the file; an assignment before the branch, and a command with no such word, are read as before', () => {
    const f = fixture('foreign-assignment-branch', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '#!/bin/sh\necho ran\n';
    const audit = join(hooks, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const later = '/nonexistent/later';
    const ran = (command: string) => spawnSync('sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, FHG_AUDIT: audit } }).stdout.includes('ran');
    const notMade = [`if false; then FHG_AUDIT=${later}; fi; "$FHG_AUDIT"`, `if false\nthen\n  FHG_AUDIT=${later}\nfi\n"$FHG_AUDIT"`, `if true; then :; else FHG_AUDIT=${later}; fi; "$FHG_AUDIT"`,
      `if false; then :; elif false; then FHG_AUDIT=${later}; fi; "$FHG_AUDIT"`, `while false; do FHG_AUDIT=${later}; done; "$FHG_AUDIT"`, `for i in; do FHG_AUDIT=${later}; done; "$FHG_AUDIT"`,
      `if false; then export FHG_AUDIT=${later}; fi; "$FHG_AUDIT"`];
    const made = [`FHG_AUDIT=${later}; "$FHG_AUDIT"`, `FHG_AUDIT=${later}; if true; then :; fi; "$FHG_AUDIT"`, `FHG_AUDIT=${later}\nif true; then :; fi\n"$FHG_AUDIT"`];
    // what the shell does: an assignment in a body that does not run leaves the file of the session; one that is made before the branch, the name that was set
    for (const command of notMade) expect(ran(command), `${JSON.stringify(command)}: the session's file runs`).toBe(true);
    for (const command of made) expect(ran(command), `${JSON.stringify(command)}: the name was set before the use`).toBe(false);
    for (const command of notMade) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: audit });
        expectUnread(r, key, `${JSON.stringify(command)} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit), `${JSON.stringify(command)} as ${key}: the file is intact`).toBe(text);
      }
    }
    // an assignment before the branch settles the name, as before, and so does a command with no branch word
    for (const command of made) {
      const r = start(command, { state_file: audit });
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('an assignment that stands in a case arm (after case) settles no name for the commands after it, as one in a branch does: the arm may not run, so the name is still the one the session has and the guard keeps the file; an assignment before the case, and a command with no case, are read as before', () => {
    const f = fixture('foreign-assignment-case', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '#!/bin/sh\necho ran\n';
    const audit = join(hooks, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const later = '/nonexistent/later';
    const ran = (command: string) => spawnSync('sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, FHG_AUDIT: audit } }).stdout.includes('ran');
    const notMade = [`case x in y) true; FHG_AUDIT=${later};; esac; "$FHG_AUDIT"`, `case x in y) FHG_AUDIT=${later};; esac; "$FHG_AUDIT"`, `case x in\\n  y)\\n    FHG_AUDIT=${later}\\n    ;;\\nesac\\n"$FHG_AUDIT"`.replace(/\\n/g, '\n'),
      `case x in y) export FHG_AUDIT=${later};; esac; "$FHG_AUDIT"`];
    const made = [`FHG_AUDIT=${later}; case x in y) true;; esac; "$FHG_AUDIT"`, `FHG_AUDIT=${later}; "$FHG_AUDIT"`];
    // what the shell does: an assignment in an arm that does not run leaves the file of the session; one that is made before the case, the name that was set
    for (const command of notMade) expect(ran(command), `${JSON.stringify(command)}: the session's file runs`).toBe(true);
    for (const command of made) expect(ran(command), `${JSON.stringify(command)}: the name was set before the use`).toBe(false);
    for (const command of notMade) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: audit });
        expectUnread(r, key, `${JSON.stringify(command)} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit), `${JSON.stringify(command)} as ${key}: the file is intact`).toBe(text);
      }
    }
    // an assignment before the case settles the name, as before
    for (const command of made) {
      const r = start(command, { state_file: audit });
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('a default or error operator (-, :-, =, :=, ?, :?) does not settle a parameter: where nothing at that place gives the name a value, the session may have one and the shell then uses it, so the guard keeps the file when the word is the whole expansion or ends the path of a file it writes; a name that the settings or an earlier assignment give, and an expansion with something else after it, are read as before', () => {
    const f = fixture('foreign-default-operator', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '#!/bin/sh\necho ran\n';
    const audit = join(hooks, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>, settingsEnv: Record<string, string> = {}) => {
      writeFileSync(f.settings, JSON.stringify({ env: settingsEnv, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const printed = (command: string) => spawnSync('sh', ['-c', command.replace('python3', 'printf %s')], { encoding: 'utf8', env: { ...process.env, FHG_AUDIT: audit } }).stdout;
    const refused = [`python3 "\${FHG_AUDIT:-/nonexistent/fallback}"`, `python3 "\${FHG_AUDIT-/nonexistent/fallback}"`, `python3 "\${FHG_AUDIT=/nonexistent/fallback}"`, `python3 "\${FHG_AUDIT:=/nonexistent/fallback}"`,
      `python3 "\${FHG_AUDIT?missing}"`, `python3 "\${FHG_AUDIT:?missing}"`, `python3 \${FHG_AUDIT:-/nonexistent/fallback}`];
    for (const command of refused) {
      expect(printed(command), `${command}: the shell takes the value of the session`).toBe(audit);
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: audit });
        expectUnread(r, key, `${command} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit), `${command} as ${key}: the file is intact`).toBe(text);
      }
    }
    // the name has a value here: an assignment before the use, or the settings (the session is given them too)
    for (const [command, env] of [[`FHG_AUDIT=/nonexistent/later; python3 "\${FHG_AUDIT:-/nonexistent/fallback}"`, {}], [`python3 "\${FHG_AUDIT:-/nonexistent/fallback}"`, { FHG_AUDIT: '/nonexistent/env' }],
      [`export FHG_AUDIT=/nonexistent/later; python3 "\${FHG_AUDIT:?missing}"`, {}]] as Array<[string, Record<string, string>]>) {
      const r = start(command, { state_file: audit }, env);
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(0);
    }
    // something else after the expansion: read as before (the form that the installer writes for the directory of the plugin)
    for (const command of [`node "\${FHG_ROOT:-x}/scripts/y.mjs"`, `python3 "\${FHG_AUDIT:-/nonexistent/fallback}.old"`]) {
      const r = start(command, { state_file: audit });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('a cd, a pushd or a chdir option moves the directory that a relative path is run from only when its target is known at that place: cd "$DIR/other" with DIR only in the session does not, so ./audit is checked against the directory of the session however many other directories the command names; a target that the command, the settings or the words give is settled as before', () => {
    const f = fixture('foreign-chdir-target', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const project = join(f.dir, 'project');   // what only the session has in FHG_DIR
    const other = join(project, 'other');
    const unrelated = join(f.dir, 'unrelated');   // a directory that the command names, and that has no audit
    mkdirSync(other, { recursive: true });
    mkdirSync(unrelated);
    const text = '#!/bin/sh\necho ran\n';
    const audit = join(other, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>, settingsEnv: Record<string, string> = {}) => {
      writeFileSync(f.settings, JSON.stringify({ env: settingsEnv, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const shellRuns = (command: string) => spawnSync('sh', ['-c', command], { encoding: 'utf8', cwd: f.dir, env: { ...process.env, FHG_DIR: project } }).stdout.includes('ran');
    const unknown = [`cd "$FHG_DIR/other"; ./audit ${unrelated}`, `env -C "$FHG_DIR/other" ./audit ${unrelated}`, `env --chdir="$FHG_DIR/other" ./audit ${unrelated}`, `cd "\${FHG_DIR:-/nonexistent}/other"; ./audit ${unrelated}`, `cd ${unrelated}; cd "$FHG_DIR/other"; ./audit ${unrelated}`];
    for (const command of unknown) expect(shellRuns(command), `${command}: the shell runs the file that the session finds`).toBe(true);
    for (const command of [...unknown, `pushd "$FHG_DIR/other"; ./audit ${unrelated}`]) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: audit });
        expectUnread(r, key, `${command} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit), `${command} as ${key}: the file is intact`).toBe(text);
      }
    }
    // the target is known: the directory is a candidate for the relative path, so the file is found and is the same file
    for (const [command, env] of [[`cd ${other}; ./audit ${unrelated}`, {}], [`env -C ${other} ./audit ${unrelated}`, {}], [`FHG_DIR=${project}; cd "$FHG_DIR/other"; ./audit ${unrelated}`, {}],
      [`cd "$FHG_DIR/other"; ./audit ${unrelated}`, { FHG_DIR: project }]] as Array<[string, Record<string, string>]>) {
      const r = start(command, { state_file: audit }, env);
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain('are the same file');
      expect(r.stderr, command).not.toMatch(/not read to its end/);
    }
    // another file name is no file of the guard
    expect(start(`cd "$FHG_DIR/other"; ./other ${unrelated}`, { state_file: audit }).status).toBe(0);
  });

  it('a cd, a pushd or a chdir option with a relative target moves nothing that is known: the target is run from a directory that is not known (cd child, and cd child after cd /dir), so ./audit is checked against the directory of the session however many other directories the command names; a target that is an absolute path in every way its parameters are filled in, after an option such as -P or --, is settled as before', () => {
    const f = fixture('foreign-chdir-relative', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const project = join(f.dir, 'project');   // the directory of the session
    const child = join(project, 'child');
    const unrelated = join(f.dir, 'unrelated');   // a directory that the command names, and that has no audit
    mkdirSync(child, { recursive: true });
    mkdirSync(unrelated);
    const text = '#!/bin/sh\necho ran\n';
    const audit = join(child, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const shellRuns = (command: string) => spawnSync('sh', ['-c', command], { encoding: 'utf8', cwd: project }).stdout.includes('ran');
    const relative = [`cd child; ./audit ${unrelated}`, `cd ${project}; cd child; ./audit ${unrelated}`, `env -C child ./audit ${unrelated}`, `env --chdir=child ./audit ${unrelated}`, `env --chdir child ./audit ${unrelated}`,
      `cd -P child; ./audit ${unrelated}`, `cd ./child; ./audit ${unrelated}`];
    for (const command of relative) expect(shellRuns(command), `${command}: the shell runs the file under the directory of the session`).toBe(true);
    for (const command of [...relative, `cd child; python3 ./audit ${unrelated}`, `env --directory child ./audit ${unrelated}`, `pushd child; ./audit ${unrelated}`, `cd; ./audit ${unrelated}`, `cd -; ./audit ${unrelated}`]) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: audit });
        expectUnread(r, key, `${command} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit), `${command} as ${key}: the file is intact`).toBe(text);
      }
    }
    // the target is an absolute path: the directory is a candidate for the relative path, so the file is found and is the same file
    for (const command of [`cd ${child}; ./audit ${unrelated}`, `env -C ${child} ./audit ${unrelated}`, `cd -P ${child}; ./audit ${unrelated}`, `cd -- ${child}; ./audit ${unrelated}`, `env --directory=${child} ./audit ${unrelated}`, `D=${child}; cd "$D"; ./audit ${unrelated}`]) {
      const r = start(command, { state_file: audit });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain('are the same file');
      expect(r.stderr, command).not.toMatch(/not read to its end/);
    }
    // a variable that makes the target relative is a relative target
    const viaName = start(`D=child; cd "$D"; ./audit ${unrelated}`, { state_file: audit });
    expect(viaName.status, `${viaName.stdout}${viaName.stderr}`).toBe(2);
    expect(viaName.stderr, 'a name that is set to a relative path').toMatch(/not read to its end/);
    // another file name is no file of the guard
    expect(start(`cd child; ./other ${unrelated}`, { state_file: audit }).status).toBe(0);
  });

  it('a PATH that the command or the settings give is the PATH of the hook only when no component of it holds a parameter that nothing gives a value to (PATH=$DIR:$PATH, DIR only in the session), and only in the simple command that has it (PATH=dir true; audit): the guard cannot tell which file a bare name runs, so it keeps the file; a PATH whose parameters the settings, the command or a default word fill in settles it as before', () => {
    const f = fixture('foreign-session-path-component', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const project = join(f.dir, 'project-bin');   // the directory that only the session has in FHG_DIR
    const usr = join(f.dir, 'usr-bin');   // on the PATH of the guard
    mkdirSync(project);
    mkdirSync(usr);
    const text = '#!/bin/sh\necho session\n';
    const audit = join(project, 'audit');
    const known = join(usr, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    writeFileSync(known, '#!/bin/sh\necho guard\n', { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const guardOnly = { ...ENV, PATH: `${usr}:${ENV.PATH}` };
    const start = (command: string, config: Record<string, string>, settingsEnv: Record<string, string> = {}) => {
      writeFileSync(f.settings, JSON.stringify({ env: settingsEnv, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once'], { env: guardOnly });
    };
    const sessionEnv = { ...process.env, PATH: `${usr}:${process.env.PATH}`, FHG_DIR: project };
    expect(spawnSync('sh', ['-c', 'PATH=$FHG_DIR:$PATH audit'], { encoding: 'utf8', env: sessionEnv }).stdout, 'the session has the directory in the component').toBe('session\n');
    expect(spawnSync('sh', ['-c', 'PATH=$FHG_DIR:$PATH audit'], { encoding: 'utf8', env: guardOnly }).stdout, 'the guard has none: it finds the other file').toBe('guard\n');
    expect(spawnSync('sh', ['-c', `PATH=${project} true; audit`], { encoding: 'utf8', env: guardOnly }).stdout, 'a PATH in front of another command is not the PATH of this one').toBe('guard\n');
    const refused: Array<[string, Record<string, string>]> = [['PATH=$FHG_DIR:$PATH audit', {}], ['PATH=$PATH:$FHG_DIR audit', {}], ['audit', { PATH: '$FHG_DIR:$PATH' }], ['PATH=${FHG_DIR}:$PATH exec audit', {}], ['true; PATH=$FHG_DIR:$PATH audit', {}],
      [`PATH=${project} true; audit`, {}], [`PATH=${project} true | audit`, {}], [`PATH=${project} true; env audit`, {}], ['FHG_DIR=x PATH=$FHG_DIR:$PATH audit', {}], [`PATH=\${FHG_DIR:-${project}}:$PATH audit`, {}],
      [`PATH=${usr}:$PATH audit`, {}], [`FHG_DIR=${project}; PATH=$FHG_DIR:$PATH audit`, {}], ['PATH=$FHG_DIR:$PATH audit', { FHG_DIR: project }]];   // (the last three: the $PATH after the directory is the PATH of the session, which the guard does not have, whatever the directory is)
    for (const [command, settingsEnv] of refused) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: audit }, settingsEnv);
        expectUnread(r, key, `${command} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit), `${command} as ${key}: the program is intact`).toBe(text);
      }
    }
    // a PATH whose components are all known settles which file is meant: the collision with the file of that directory
    const settled: Array<[string, Record<string, string>, string]> = [[`PATH=${usr}:$PATH audit`, { PATH: usr }, known], [`FHG_DIR=${project}; PATH=\${FHG_DIR:-/nonexistent}:$PATH audit`, { PATH: usr }, audit], ['PATH=$FHG_DIR:$PATH audit', { FHG_DIR: project, PATH: usr }, audit], ['audit', { PATH: `${project}:$PATH` }, audit],
      ['FHG_DIR=' + project + '; PATH=$FHG_DIR:$PATH audit', { PATH: usr }, audit], [`PATH=${project}; audit`, {}, audit], [`PATH=${usr} audit`, {}, known]];
    for (const [command, settingsEnv, file] of settled) {
      const r = start(command, { state_file: file }, settingsEnv);
      expect(r.status, `${command} with ${JSON.stringify(settingsEnv)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain(`"state_file" (${file}) and "program of another hook" (${file}) are the same file`);
      expect(r.stderr, command).not.toMatch(/not read to its end/);
    }
  });

  it('a PATH= word that stands after the program of a simple command is an argument, not the PATH of that program: the guard cannot tell which file a bare name runs and keeps the file, while a PATH= word in front of the program, also after env, settles it as before', () => {
    const f = fixture('foreign-path-argument', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const project = join(f.dir, 'project-bin');   // on the PATH of the session only
    const usr = join(f.dir, 'usr-bin');   // on the PATH of the guard
    mkdirSync(project);
    mkdirSync(usr);
    const text = '#!/bin/sh\necho session\n';
    const audit = join(project, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    writeFileSync(join(usr, 'audit'), '#!/bin/sh\necho guard\n', { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const guardOnly = { ...ENV, PATH: `${usr}:${ENV.PATH}` };
    const start = (command: string, config: Record<string, string>) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once'], { env: guardOnly });
    };
    const sessionEnv = { ...process.env, PATH: `${project}:${usr}:${process.env.PATH}` };
    expect(spawnSync('sh', ['-c', 'audit PATH=/nonexistent/safe'], { encoding: 'utf8', env: sessionEnv }).stdout, 'the word after the program is an argument: the session runs its own file').toBe('session\n');
    expect(spawnSync('sh', ['-c', `PATH=${usr} audit`], { encoding: 'utf8', env: sessionEnv }).stdout, 'a PATH= word in front of the program is its PATH').toBe('guard\n');
    expect(spawnSync('sh', ['-c', `env -C ${usr} PATH=${usr} audit`], { encoding: 'utf8', env: sessionEnv }).stdout, 'also after the option -C DIR of env').toBe('guard\n');
    for (const command of ['audit PATH=/nonexistent/safe', `audit PATH=${usr}`, 'audit --flag PATH=/nonexistent/safe', 'true; audit PATH=/nonexistent/safe']) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: audit });
        expectUnread(r, key, `${command} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit), `${command} as ${key}: the program is intact`).toBe(text);
      }
    }
    // a PATH= word in front of the program (also after env) gives the PATH of that program: the file of the session is not meant, so the guard starts
    for (const command of [`PATH=${usr} audit`, `env PATH=${usr} audit`, `PATH=/nonexistent/safe audit`, `FHG_X=1 PATH=${usr} audit --flag PATH=/nonexistent/other`, `env -C ${usr} PATH=${usr} audit`]) {
      const r = start(command, { state_file: audit });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('a $PATH in the value that a PATH= word gives is the PATH that the session has before the assignment, not the one the guard has: where no PATH is given before it the guard cannot tell which file a bare name runs, so it keeps the file; a PATH that the settings or an earlier assignment give, and a PATH= word with no $PATH in it, settle it as before', () => {
    const f = fixture('foreign-path-self-reference', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const project = join(f.dir, 'project-bin');   // on the PATH of the session only
    const usr = join(f.dir, 'usr-bin');   // on the PATH of the guard only
    mkdirSync(project);
    mkdirSync(usr);
    const text = '#!/bin/sh\necho session\n';
    const audit = join(project, 'audit');
    const known = join(usr, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    writeFileSync(known, '#!/bin/sh\necho guard\n', { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const guardOnly = { ...ENV, PATH: `${usr}:${ENV.PATH}` };
    const start = (command: string, config: Record<string, string>, settingsEnv: Record<string, string> = {}) => {
      writeFileSync(f.settings, JSON.stringify({ env: settingsEnv, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once'], { env: guardOnly });
    };
    const sessionEnv = { ...process.env, PATH: `${project}:${process.env.PATH}` };
    const refused = ['PATH=/nonexistent/safe:$PATH audit', 'PATH=/nonexistent/safe:${PATH} audit', 'PATH=$PATH:/nonexistent/safe audit', 'env PATH=/nonexistent/safe:$PATH audit', 'PATH=/nonexistent/safe:$PATH exec audit'];
    for (const command of refused) {
      expect(spawnSync('sh', ['-c', command], { encoding: 'utf8', env: sessionEnv }).stdout, `${command}: the shell takes the PATH of the session`).toBe('session\n');
      expect(spawnSync('sh', ['-c', command], { encoding: 'utf8', env: guardOnly }).stdout, `${command}: the guard has another PATH, and finds another file`).toBe('guard\n');
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: audit });
        expectUnread(r, key, `${command} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit), `${command} as ${key}: the program is intact`).toBe(text);
      }
    }
    // a PATH that is given before the $PATH: the settings (the session has them too), or an assignment that stands alone; a PATH= word without a $PATH is the PATH
    const settled: Array<[string, Record<string, string>]> = [['PATH=/nonexistent/safe:$PATH audit', { PATH: usr }], [`PATH=${usr}; PATH=/nonexistent/safe:$PATH audit`, {}], ['PATH=/nonexistent/safe:/nonexistent/other audit', {}], [`PATH=${usr}:/nonexistent/other audit`, {}]];
    for (const [command, settingsEnv] of settled) {
      const r = start(command, { state_file: known }, settingsEnv);
      expect(r.status, `${command} with ${JSON.stringify(settingsEnv)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain(`"state_file" (${known}) and "program of another hook" (${known}) are the same file`);
      expect(r.stderr, command).not.toMatch(/not read to its end/);
    }
    // no PATH is assigned at all: the word is read as before, a PATH that is only an argument is no program
    expect(start('echo "$PATH:/nonexistent/x"', { state_file: audit }).status, 'a PATH in an argument').toBe(0);
    expect(start('PATH=/nonexistent/safe:$PATH other', { state_file: audit }).status, 'a name that no file of the guard has').toBe(0);
  });

  it('a bare word anywhere in a simple command that has a command word is looked up on the PATH of the session as the program it may be (timeout 5 audit, nice -n 5 audit, stdbuf -oL audit, sudo audit): the guard cannot tell which words a wrapper runs, so it keeps the file when the word is the name of a file the guard writes and no PATH is given; an absolute path, a PATH of the command or a name that no file of the guard has settles it as before', () => {
    const f = fixture('foreign-wrapped-operand', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const project = join(f.dir, 'project-bin');   // on the PATH of the session only
    mkdirSync(project);
    const text = '#!/bin/sh\necho session\n';
    const audit = join(project, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>) => {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once'], { env: ENV });
    };
    const sessionEnv = { ...process.env, PATH: `${project}:${process.env.PATH}` };
    // what the shell does: the wrapper starts the word after its operands from the PATH of the session
    expect(spawnSync('sh', ['-c', 'timeout 5 audit'], { encoding: 'utf8', env: sessionEnv }).stdout, 'the session finds the file').toBe('session\n');
    expect(spawnSync('sh', ['-c', 'nice -n 5 audit'], { encoding: 'utf8', env: sessionEnv }).stdout).toBe('session\n');
    expect(spawnSync('sh', ['-c', 'timeout 5 audit'], { encoding: 'utf8', env: ENV }).stdout, 'the guard does not').toBe('');
    for (const command of ['timeout 5 audit', 'nice -n 5 audit', 'stdbuf -oL audit', 'sudo audit', 'setsid audit', 'xargs audit', 'timeout 5 env audit', 'true; timeout 5 audit --flag']) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: audit });
        expectUnread(r, key, `${command} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit), `${command} as ${key}: the program is intact`).toBe(text);
      }
    }
    // a bare word that is only an argument has the same name: the false alarm that the conservative rule costs
    expect(start('echo audit', { state_file: audit }).status, 'an argument with the name of a file of the guard').toBe(2);
    // settled as before: an absolute path, a PATH of the command (the collision of an earlier test), a name that no file of the guard has
    for (const command of [`timeout 5 ${audit}`, `PATH=${project} timeout 5 audit`, `PATH=${project}:/nonexistent/other nice -n 5 audit`]) {
      const r = start(command, { state_file: audit });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain('are the same file');
      expect(r.stderr, command).not.toMatch(/not read to its end/);
    }
    // a $PATH after the directory is the PATH of the session, which the guard does not have: not settled
    const selfReference = start(`PATH=${project}:$PATH nice -n 5 audit`, { state_file: audit });
    expect(selfReference.status, `${selfReference.stdout}${selfReference.stderr}`).toBe(2);
    expect(selfReference.stderr, 'a PATH with a $PATH in it').toMatch(/not read to its end/);
    for (const command of ['timeout 5 audit', 'nice -n 5 audit', 'echo audit', 'sudo audit --flag']) {
      expect(start(command, { state_file: join(project, 'other') }).status, `${command}: no file of the guard has the name`).toBe(0);
    }
  });

  it('an unbraced special parameter in the command of another hook (dollar and ?, $, !, #, *, @ or -), also inside double quotes, is a word that the scan cannot know, so the guard keeps the file; single quotes, a backslash, a dollar before a blank or at the end, the braced forms and the other parameters are read as before', () => {
    const f = fixture('foreign-special-parameter', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '#!/bin/sh\necho ran\n';
    const audit1 = join(hooks, 'audit1');
    writeFileSync(audit1, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>) => {
      writeFileSync(f.settings, JSON.stringify({ env: { FHG_V: audit1 }, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    expect(spawnSync('sh', ['-c', `false; printf %s ${hooks}/audit$?`], { encoding: 'utf8' }).stdout, 'the shell makes the path of the file out of the exit status').toBe(audit1);
    expect(spawnSync('sh', ['-c', `false; printf %s "${hooks}/audit$?"`], { encoding: 'utf8' }).stdout, 'also in double quotes').toBe(audit1);
    expect(spawnSync('sh', ['-c', `printf %s '${hooks}/audit$?'`], { encoding: 'utf8' }).stdout, 'but not in single quotes').toBe(`${hooks}/audit$?`);
    const refused = [`false; python3 ${hooks}/audit$?`, `python3 ${hooks}/audit$$`, `python3 ${hooks}/audit$!`, `python3 ${hooks}/audit$#`, `python3 ${hooks}/audit$*`, `python3 ${hooks}/audit$@`, `python3 ${hooks}/audit$-`,
      `false; python3 "${hooks}/audit$?"`, `python3 "$@"`, `python3 -u --log=${hooks}/audit$?`, `sh -c 'python3 ${hooks}/audit$?'`, `python3 ${hooks}/audit$1`, `python3 "$1"`,
      `python3 ${hooks}/audit\${?}`, `python3 ${hooks}/audit\${#}`, `python3 ${hooks}/audit\${@}`, `python3 ${hooks}/audit\${*}`, `python3 ${hooks}/audit\${-}`, `python3 ${hooks}/audit\${$}`, `python3 ${hooks}/audit\${!}`];
    for (const command of refused) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: audit1 });
        expectUnread(r, key, `${command} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit1), `${command} as ${key}: the file is intact`).toBe(text);
      }
    }
    // read as before: single quotes (the text), a backslash, a dollar before a blank or at the end of the word, other parameters
    for (const command of [`python3 '${hooks}/audit$?'`, `python3 '$$' '$@'`, `python3 ${hooks}/audit\\$?`, `python3 "${hooks}/audit\\$?"`, `python3 ${hooks}/audit$ x`, `python3 ${hooks}/audit$`, `python3 "${hooks}/audit$"`, `python3 $'${hooks}/audit$?'`]) {
      const r = start(command, { state_file: audit1 });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(0);
    }
    for (const command of ['python3 "$FHG_V"', 'python3 "${FHG_V}"', 'python3 "${FHG_V:-x}"']) {
      const r = start(command, { state_file: audit1 });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain(`"state_file" (${audit1}) and "program of another hook" (${audit1}) are the same file`);
    }
  });

  it('a program of another hook that the PATH of the guard does find is still looked up on the PATH of the session when the command and the settings give no PATH: a file that the guard knows does not tell which one runs, so the guard keeps the file when the name is that of a file the guard writes; a PATH of the command or of the settings settles it as before', () => {
    const f = fixture('foreign-session-path-shadow', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const project = join(f.dir, 'project-bin');   // first on the PATH of the session
    const usr = join(f.dir, 'usr-bin');   // on the PATH of the guard and after the first on the one of the session
    mkdirSync(project);
    mkdirSync(usr);
    const text = '#!/bin/sh\necho session\n';
    const audit = join(project, 'audit');
    const known = join(usr, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    writeFileSync(known, '#!/bin/sh\necho guard\n', { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>, settingsEnv: Record<string, string> = {}, guardEnv: NodeJS.ProcessEnv = guardOnly) => {
      writeFileSync(f.settings, JSON.stringify({ env: settingsEnv, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once'], { env: guardEnv });
    };
    const guardOnly = { ...ENV, PATH: `${usr}:${ENV.PATH}` };
    const sessionEnv = { ...process.env, PATH: `${project}:${usr}:${process.env.PATH}` };
    expect(spawnSync('sh', ['-c', 'audit'], { encoding: 'utf8', env: sessionEnv }).stdout, 'the session runs the file that is first on its PATH').toBe('session\n');
    expect(spawnSync('sh', ['-c', 'audit'], { encoding: 'utf8', env: guardOnly }).stdout, 'the guard finds the other one').toBe('guard\n');
    for (const command of ['audit', 'exec audit', 'command audit', 'env audit --flag', 'true; audit', "sh -c 'audit --flag'", 'FOO=1 audit', '[ -f x ] || audit']) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        for (const env of [guardOnly, sessionEnv]) {   // (a guard that has both directories, in either order, does not know the PATH of the session either)
          const r = start(command, { [key]: audit }, {}, env);
          expectUnread(r, key, `${command} as ${key}`);
          expect(r.stderr).not.toMatch(/Traceback/);
          expect(readText(audit), `${command} as ${key}: the program is intact`).toBe(text);
        }
      }
    }
    // a PATH that the command or the settings give is the PATH of the hook: it settles which file is meant (the collision of an earlier test)
    const settled: Array<[string, Record<string, string>, string]> = [[`PATH=${project}:${usr} audit`, {}, audit], [`env PATH=${project} audit`, {}, audit], ['audit', { PATH: `${project}:${usr}` }, audit],
      [`PATH=${usr} audit`, {}, known], ['audit', { PATH: usr }, known]];
    for (const [command, settingsEnv, file] of settled) {
      const r = start(command, { state_file: file }, settingsEnv);
      expect(r.status, `${command} with ${JSON.stringify(settingsEnv)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain(`"state_file" (${file}) and "program of another hook" (${file}) are the same file`);
      expect(r.stderr, command).not.toMatch(/not read to its end/);
    }
    // not refused: a name that no file of the guard has
    expect(start('audit', {}).status, 'no file of the guard has the name').toBe(0);
    expect(start('sh -c "exit 0"; python3 -I x', { state_file: audit }).status, 'programs that are no file of the guard').toBe(0);
  });

  it('a variable that only the session of the hook has (the guard, the settings and the command give it no value) is the session\'s: when the word is that variable alone or ends the path of a file the guard writes the guard keeps the file; a word with another ending, a default word and a variable that the guard, the settings or the command give a value are read as before', () => {
    const f = fixture('foreign-session-variable', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '#!/bin/sh\necho ran\n';
    const audit = join(hooks, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>, settingsEnv: Record<string, string> = {}, guardEnv: NodeJS.ProcessEnv = ENV) => {
      writeFileSync(f.settings, JSON.stringify({ env: settingsEnv, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once'], { env: guardEnv });
    };
    // the variables are in the environment of the session only
    const sessionEnv = { ...process.env, FHG_SESSION_AUDIT: audit, FHG_SESSION_DIR: hooks };
    expect(spawnSync('sh', ['-c', '"$FHG_SESSION_AUDIT"'], { encoding: 'utf8', env: sessionEnv }).stdout, 'the session runs the script that the variable names').toBe('ran\n');
    expect(spawnSync('sh', ['-c', '"$FHG_SESSION_DIR"/audit'], { encoding: 'utf8', env: sessionEnv }).stdout, 'and the one that a variable and a name make').toBe('ran\n');
    expect(spawnSync('sh', ['-c', '"$FHG_SESSION_AUDIT"'], { encoding: 'utf8', env: ENV }).status, 'the guard does not have them').not.toBe(0);
    for (const command of ['python3 "$FHG_SESSION_AUDIT"', 'python3 $FHG_SESSION_AUDIT', 'python3 "${FHG_SESSION_AUDIT}"', 'python3 ${FHG_SESSION_AUDIT}', 'python3 "$FHG_SESSION_DIR/audit"',
      'python3 ${FHG_SESSION_DIR}/audit', 'python3 -u --log=$FHG_SESSION_AUDIT', "sh -c 'python3 \"$FHG_SESSION_AUDIT\" x'", 'true; "$FHG_SESSION_AUDIT"']) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: audit });
        expectUnread(r, key, `${command} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit), `${command} as ${key}: the program is intact`).toBe(text);
      }
    }
    // a value from the guard, the settings, the command or a default word settles it: the collision of an earlier test
    const settled: Array<[string, Record<string, string>, NodeJS.ProcessEnv]> = [['python3 "$FHG_SESSION_AUDIT"', { FHG_SESSION_AUDIT: audit }, ENV],
      [`FHG_SESSION_AUDIT=${audit}; python3 "$FHG_SESSION_AUDIT"`, {}, ENV], [`FHG_SESSION_AUDIT=/nonexistent/x; python3 "\${FHG_SESSION_AUDIT:-${audit}}"`, {}, ENV]];
    for (const [command, settingsEnv, guardEnv] of settled) {
      const r = start(command, { state_file: audit }, settingsEnv, guardEnv);
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain(`"state_file" (${audit}) and "program of another hook" (${audit}) are the same file`);
      expect(r.stderr, command).not.toMatch(/not read to its end/);
    }
    // read as before: something else ends the word
    for (const command of ['bash "$FHG_SESSION_DIR"/tools/chmura/x.sh', 'python3 "$FHG_SESSION_DIR/other"', 'python3 "${FHG_SESSION_DIR}"/audit-other', 'python3 "${FHG_SESSION_AUDIT:-x}"/y']) {
      const r = start(command, { state_file: audit });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(0);
    }
    // a default word does not settle the name (the session may have a value): the expansion alone is refused
    for (const command of [`python3 "\${FHG_SESSION_AUDIT:-${audit}}"`, 'python3 "${FHG_SESSION_AUDIT:-x}"']) {
      const r = start(command, { state_file: audit });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toMatch(/not read to its end/);
    }
  });

  it('a variable that the guard has in its own environment is a candidate, not the value that the hook gets: a session that has another value (the guard has an old file, the session the file the guard writes) is not read to its end and the guard keeps the file; a value of the settings or of the command settles it, and the value of the guard stays a candidate beside it', () => {
    const f = fixture('foreign-session-other-value', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    const old = join(f.dir, 'old');
    mkdirSync(hooks);
    mkdirSync(old);
    const text = '#!/bin/sh\necho ran\n';
    const audit = join(hooks, 'audit');
    const oldAudit = join(old, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    writeFileSync(oldAudit, '#!/bin/sh\necho old\n', { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>, settingsEnv: Record<string, string>, guardEnv: NodeJS.ProcessEnv) => {
      writeFileSync(f.settings, JSON.stringify({ env: settingsEnv, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once'], { env: guardEnv });
    };
    // both processes have the variables, with other values
    const guardEnv = { ...ENV, FHG_OTHER_AUDIT: oldAudit, FHG_OTHER_DIR: old };
    const sessionEnv = { ...process.env, FHG_OTHER_AUDIT: audit, FHG_OTHER_DIR: hooks };
    expect(spawnSync('sh', ['-c', '"$FHG_OTHER_AUDIT"'], { encoding: 'utf8', env: sessionEnv }).stdout, 'the session runs the file that the guard writes').toBe('ran\n');
    expect(spawnSync('sh', ['-c', '"$FHG_OTHER_AUDIT"'], { encoding: 'utf8', env: guardEnv }).stdout, 'the process of the guard would run the old one').toBe('old\n');
    for (const command of ['python3 "$FHG_OTHER_AUDIT"', 'python3 $FHG_OTHER_AUDIT', 'python3 "${FHG_OTHER_AUDIT}"', 'python3 "$FHG_OTHER_DIR/audit"', 'python3 ${FHG_OTHER_DIR}/audit', "sh -c 'python3 \"$FHG_OTHER_AUDIT\" x'", 'true; "$FHG_OTHER_AUDIT"']) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: audit }, {}, guardEnv);
        expectUnread(r, key, `${command} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit), `${command} as ${key}: the file is intact`).toBe(text);
      }
    }
    // a value that the settings or the command give is the one the hook gets: the collision of an earlier test (and the value of the guard is a candidate still)
    for (const [command, settingsEnv, file] of [['python3 "$FHG_OTHER_AUDIT"', { FHG_OTHER_AUDIT: audit }, audit], [`FHG_OTHER_AUDIT=${audit}; python3 "$FHG_OTHER_AUDIT"`, {}, audit],
      ['python3 "$FHG_OTHER_AUDIT"', { FHG_OTHER_AUDIT: audit }, oldAudit]] as Array<[string, Record<string, string>, string]>) {
      const r = start(command, { state_file: file }, settingsEnv, guardEnv);
      expect(r.status, `${command} with ${file}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, `${command} with ${file}`).toContain(`"state_file" (${file}) and "program of another hook" (${file}) are the same file`);
      expect(r.stderr, command).not.toMatch(/not read to its end/);
    }
    // read as before: another ending of the word, and a default word
    for (const command of ['bash "$FHG_OTHER_DIR"/tools/chmura/x.sh', 'python3 "$FHG_OTHER_DIR/other"', 'python3 "${FHG_OTHER_AUDIT:-x}/y"']) {
      const r = start(command, { state_file: audit }, {}, guardEnv);
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(0);
    }
    expect(start('python3 "${FHG_OTHER_AUDIT:-x}"', { state_file: audit }, {}, guardEnv).status, 'the expansion alone: a default word does not settle the name').toBe(2);
  });

  it('a parameter expansion that the scan does not model (replacement, case change, a transformation with @, indirection, a slice, an array) is not read to its end, so the guard keeps the file; a plain ${NAME}, the modeled operators and braces without a dollar are read as before', () => {
    const f = fixture('foreign-unmodeled-expansion', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const hooks = join(f.dir, 'hooks');
    mkdirSync(hooks);
    const text = '#!/bin/sh\necho ran\n';
    const audit = join(hooks, 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settingsEnv = { FHG_X: `${audit}.py`, FHG_Y: 'FHG_X' };
    const start = (command: string, config: Record<string, string>) => {
      writeFileSync(f.settings, JSON.stringify({ env: settingsEnv, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const expansions = ['${FHG_X/.py/}', '${FHG_X//.py/}', '${FHG_X/#?/}', '${FHG_X/%.py/}', '${FHG_X^}', '${FHG_X^^}', '${FHG_X,}', '${FHG_X,,}', '${FHG_X@Q}', '${FHG_X@U}', '${!FHG_Y}', '${FHG_X:0:5}', '${FHG_X:2}', '${FHG_X[0]}', '${FHG_X[@]}',
      '${#FHG_X[@]}', '${FHG_X:-${FHG_X/.py/}}', '${FHG_X/${FHG_NOBODY}/y}'];
    if (HAS_BASH) {   // what the shell makes of the first two: the file that the guard writes
      const run = (expression: string) => spawnSync('bash', ['-c', `printf %s "${expression}"`], { encoding: 'utf8', env: { ...process.env, ...settingsEnv } });
      expect(run('${FHG_X/.py/}').stdout, 'the replacement runs the file').toBe(audit);
      expect(run('${FHG_X//.py/}').stdout).toBe(audit);
      for (const expression of expansions.slice(0, 16)) expect(run(expression).status, `${expression} is an expansion of the shell`).toBe(0);
    }
    for (const expression of expansions) {
      for (const command of [`python3 "${expression}"`, `bash -c 'python3 "${expression}"'`, `true; python3 -u --log=${expression}`]) {
        for (const key of ['state_file', 'pause_file', 'log_file']) {
          const r = start(command, { [key]: audit });
          expectUnread(r, key, `${command} as ${key}`);
          expect(r.stderr).not.toMatch(/Traceback/);
          expect(readText(audit), `${command} as ${key}: the file is intact`).toBe(text);
        }
      }
    }
    // read as before: the plain form and the operators that the scan models, whichever file is meant
    for (const expression of ['${FHG_X}', '${FHG_X:-x}', '${FHG_X-x}', '${FHG_X:=x}', '${FHG_X:+x}', '${FHG_X#x}', '${FHG_X##x}', '${#FHG_X}', '${FHG_X?x}']) {
      const r = start(`python3 "${expression}"`, { state_file: audit });
      expect(r.status, `${expression}: ${r.stdout}${r.stderr}`).toBe(0);
    }
    const trimmed = start('bash -c \'python3 "${FHG_X%.py}"\'', { state_file: audit });
    expect(trimmed.status, `${trimmed.stdout}${trimmed.stderr}`).toBe(2);
    expect(trimmed.stderr, 'a modeled operator names the file').toContain(`"state_file" (${audit}) and "program of another hook" (${audit}) are the same file`);
    for (const command of ['find . -name x -exec python3 {} \\;', 'python3 {a,b}', 'awk \'{print $1}\' x', 'python3 $FHG_X']) {
      const r = start(command, { state_file: audit });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('HOME and a leading ~ are the home directory of the session, which the guard does not know when a session has another one: the guard keeps the file when the word ends the path of a file the guard writes; another ending, and a HOME that the settings or the command give, are read as before', () => {
    const f = fixture('foreign-session-home', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const home = join(f.dir, 'home');   // the home directory of the session: the guard has another one (ENV)
    mkdirSync(join(home, 'bin'), { recursive: true });
    const text = '#!/bin/sh\necho ran\n';
    const audit = join(home, 'bin', 'audit');
    writeFileSync(audit, text, { mode: 0o755 });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const start = (command: string, config: Record<string, string>, settingsEnv: Record<string, string> = {}) => {
      writeFileSync(f.settings, JSON.stringify({ env: settingsEnv, hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...config }), 'utf8');
      return runSync(GUARD, ['--config', f.cfg, '--once']);
    };
    const run = (command: string, env: NodeJS.ProcessEnv) => spawnSync('sh', ['-c', command], { encoding: 'utf8', env });
    expect(run('~/bin/audit', { ...process.env, HOME: home }).stdout, 'the session runs the script of its home directory').toBe('ran\n');
    expect(run('"$HOME/bin/audit"', { ...process.env, HOME: home }).stdout).toBe('ran\n');
    expect(run('~/bin/audit', ENV).status, 'the guard has another home directory').not.toBe(0);
    for (const command of ['python3 ~/bin/audit', 'python3 $HOME/bin/audit', 'python3 "${HOME}/bin/audit"', "sh -c 'python3 ~/bin/audit x'", 'python3 -u --log=~/bin/audit']) {
      for (const key of ['state_file', 'pause_file', 'log_file']) {
        const r = start(command, { [key]: audit });
        expectUnread(r, key, `${command} as ${key}`);
        expect(r.stderr).not.toMatch(/Traceback/);
        expect(readText(audit), `${command} as ${key}: the program is intact`).toBe(text);
      }
    }
    // a HOME that the settings or the command give is a value like any other: the collision of an earlier test
    for (const [command, settingsEnv] of [['python3 "$HOME/bin/audit"', { HOME: home }], [`HOME=${home}; python3 "$HOME/bin/audit"`, {}]] as Array<[string, Record<string, string>]>) {
      const r = start(command, { state_file: audit }, settingsEnv);
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain(`"state_file" (${audit}) and "program of another hook" (${audit}) are the same file`);
    }
    for (const command of ['python3 ~/bin/other', 'python3 "$HOME/.claude/hooks/x.py"', 'python3 "${HOME}"/bin/audit-other']) {
      const r = start(command, { state_file: audit });
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it('a command of another hook that a limit cuts short is not read to its end, so the guard does not write over a file that it may name: more than 4096 words, 65536 characters, 4096 files or three levels of quoted commands', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `A${i}=x`).join(' ');
    const cases: Array<[string, (audit: string) => string, RegExp]> = [
      ['words', (audit) => `env ${words(4100)} ${audit}`, /too many words to scan/],
      ['characters', (audit) => `echo ${'x'.repeat(66000)} ${audit}`, /command too long to scan/],
      ['files', (audit) => `echo ${Array.from({ length: 2100 }, (_, i) => `x=/n/${i}`).join(' ')} ${audit}`, /too many files to scan/],
      ['nesting', (audit) => `sh -c "sh -c 'sh -c \\"echo ${audit}\\"'"`, /nested too deeply to scan/],
    ];
    for (const [name, build, why] of cases) {
      const f = fixture(`scan-limit-${name}`, { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
      const audit = join(f.dir, 'audit');
      writeFileSync(audit, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command: build(audit) }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: audit, log_file: f.log, settings_file: f.settings }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${name}: ${r.stdout.slice(0, 300)}${r.stderr.slice(0, 300)}`).toBe(2);
      expect(r.stderr, name).toMatch(why);
      expect(readText(audit), `${name}: the file is intact`).toBe('#!/bin/sh\nexit 0\n');
      expect(existsSync(f.pause), `${name}: no pause was published`).toBe(false);
    }
  });

  it('a command that grows past a limit after the start stops a write of the guard over a file that holds something else, and a command that stays within the limits does not', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `A${i}=x`).join(' ');
    const f = fixture('scan-limit-after-start', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    const settings = (command: string) => JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    writeFileSync(f.settings, settings(`env ${words(4000)} true`), 'utf8');   // within the limit: the guard pauses
    expect(runSync(GUARD, ['--config', f.cfg, '--once']).status).toBe(0);
    expect(readJson(f.pause).paused, 'a command of 4001 words is read to its end').toBe(true);
    rmSync(f.pause);
    writeFileSync(f.state, JSON.stringify({ v: 1 }), 'utf8');
    writeFileSync(f.settings, settings(`env ${words(4100)} true`), 'utf8');
    const r = runSync(GUARD, ['--config', f.cfg, '--once']);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/too many words to scan/);
  });

  it('the options of an interpreter end at its script: python3 audit -c config passes -c to the script, so audit (no suffix, no execute bit) is still a program of another hook; a shell still reads -c behind -o NAME', () => {
    const forms = [(audit: string) => `${PYBIN} ${audit} -c config`, (audit: string) => `${PYBIN} -I ${audit} -e x`, (audit: string) => `${PYBIN} -W ignore ${audit} -m mod`,
      (audit: string) => `sh ${audit} -c x`, (audit: string) => `node ${audit} -e x`, (audit: string) => `bash -o pipefail -c 'python3 ${audit}'`, (audit: string) => `bash -O extglob -c 'python3 ${audit}'`];
    for (const [k, build] of forms.entries()) {
      const f = fixture(`interpreter-options-end-${k}`, { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
      const audit = join(f.dir, 'audit');   // no suffix and no execute bit: only its place after the options makes it the script
      writeFileSync(audit, '# a program of another tool\n', 'utf8');
      const command = build(audit);
      const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: audit, log_file: f.log, settings_file: f.settings }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain(`"state_file" (${audit}) and "program of another hook" (${audit}) are the same file`);
      expect(readText(audit), `${command}: the program is intact`).toBe('# a program of another tool\n');
      expect(existsSync(f.pause), `${command}: no pause was published`).toBe(false);
    }
  });

  it('an interpreter behind a command that runs it (nice, timeout, sudo, xargs) runs its script: audit (no suffix, no execute bit) in nice python3 audit is a program of another hook, with code on the line it is not', () => {
    const forms = [(audit: string) => `nice ${PYBIN} ${audit}`, (audit: string) => `nice -n 5 ${PYBIN} -I ${audit} -c config`, (audit: string) => `timeout 5 node ${audit}`,
      (audit: string) => `sudo -u root ${PYBIN} -W ignore ${audit}`, (audit: string) => `echo x | xargs sh ${audit}`, (audit: string) => `ionice -c 3 nice ${PYBIN} ${audit}`];
    for (const [k, build] of forms.entries()) {
      const f = fixture(`behind-command-${k}`, { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
      const audit = join(f.dir, 'audit');   // no suffix and no execute bit: only its place behind the interpreter makes it the script
      writeFileSync(audit, '# a program of another tool\n', 'utf8');
      const command = build(audit);
      const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: audit, log_file: f.log, settings_file: f.settings }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain(`"state_file" (${audit}) and "program of another hook" (${audit}) are the same file`);
      expect(readText(audit), `${command}: the program is intact`).toBe('# a program of another tool\n');
      expect(existsSync(f.pause), `${command}: no pause was published`).toBe(false);
    }
    const f = fixture('behind-command-code', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    const data = join(f.dir, 'data');   // an argument of code given on the command line: no program, but the guard does not tell, so it is a false alarm
    writeFileSync(data, 'data\n', 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command: `nice ${PYBIN} -c 'pass' ${data}` }] }] } }), 'utf8');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: data, log_file: f.log, settings_file: f.settings }), 'utf8');
    const r = runSync(GUARD, ['--config', f.cfg, '--once']);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toContain(`"state_file" (${data}) and "program of another hook" (${data}) are the same file`);
    expect(readText(data), 'the file is intact').toBe('data\n');
  });

  it('a command word is looked up on the PATH that the command gives it: PATH=dir audit, env PATH=dir audit and a PATH among other assignments name the program in dir, which the guard does not replace; a $PATH in the value is the PATH of the session, not of the guard, so a PATH that has one is not read to its end', () => {
    // the forms with a $PATH (the fourth and the last) are the PATH of the session in that place, which the guard does not have: they are refused (the last would find the program only through the PATH of the guard)
    const withSelf = new Set([3, 5]);
    const forms: Array<(dir: string) => string> = [(dir) => `PATH=${dir} audit`, (dir) => `env PATH=${dir} audit`, (dir) => `FOO=1 PATH=${dir}:/usr/bin audit`,
      (dir) => `PATH=${dir}:$PATH audit`, (dir) => `exec env -i PATH=${dir} audit`, () => 'PATH=$PATH:/nonexistent audit'];
    for (const [k, form] of forms.entries()) {
      const f = fixture(`inline-path-${k}`, { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
      const bin = join(f.dir, 'hooks');
      mkdirSync(bin);
      const audit = join(bin, 'audit');   // not on the PATH of the guard: only the PATH of the command finds it
      writeFileSync(audit, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command: form(bin) }] }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: audit, log_file: f.log, settings_file: f.settings }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once'], k === forms.length - 1 ? { env: { ...ENV, PATH: `${bin}:${process.env.PATH}` } } : {});
      expect(r.status, `${form('DIR')}: ${r.stdout}${r.stderr}`).toBe(2);
      if (withSelf.has(k)) expect(r.stderr, form('DIR')).toMatch(/not read to its end/);
      else expect(r.stderr, form('DIR')).toContain(`"state_file" (${audit}) and "program of another hook" (${audit}) are the same file`);
      expect(readText(audit), `${form('DIR')}: the program is intact`).toBe('#!/bin/sh\nexit 0\n');
      expect(existsSync(f.pause), `${form('DIR')}: no pause was published`).toBe(false);
    }
  });

  it('a wrapper written with a path (/usr/bin/env, /usr/bin/nohup, /usr/bin/time) is a wrapper all the same: the script behind it is a program of the command, and so is the wrapper itself', () => {
    // [the wrapper that the command starts with, the command]
    const forms: Array<[string, (wrapper: string, audit: string) => string]> = [['env', (w, a) => `${w}/env python3 ${a}`], ['env', (w, a) => `${w}/env -i FOO=1 python3 ${a}`],
      ['nohup', (w, a) => `${w}/nohup python3 ${a}`], ['time', (w, a) => `${w}/time -p python3 ${a}`], ['command', (w, a) => `${w}/command -p python3 ${a}`],
      ['exec', (w, a) => `${w}/exec python3 ${a}`], ['env', (w, a) => `FOO=1 ${w}/env ${w}/nohup python3 ${a}`]];
    for (const [k, [first, form]] of forms.entries()) {
      for (const target of ['audit', 'wrapper']) {
        const f = fixture(`path-wrapper-${k}-${target}`, { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
        const bin = join(f.dir, 'bin');
        mkdirSync(bin);
        for (const name of ['env', 'nohup', 'time', 'command', 'exec']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const audit = join(f.dir, 'audit');   // no suffix and no execute bit: a program only as the script of the interpreter that the wrapper runs
        writeFileSync(audit, 'print("audit")\n', { mode: 0o644 });
        const forbidden = target === 'audit' ? audit : join(bin, first);
        const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
        writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command: form(bin, audit) }] }] } }), 'utf8');
        writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: forbidden, log_file: f.log, settings_file: f.settings }), 'utf8');
        const before = readText(forbidden);
        const r = runSync(GUARD, ['--config', f.cfg, '--once']);
        expect(r.status, `${form('DIR', 'AUDIT')} (${target}): ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${form('DIR', 'AUDIT')} (${target})`).toContain(`"state_file" (${forbidden}) and "program of another hook" (${forbidden}) are the same file`);
        expect(readText(forbidden), `${form('DIR', 'AUDIT')} (${target}): the program is intact`).toBe(before);
        expect(existsSync(f.pause), `${form('DIR', 'AUDIT')} (${target}): no pause was published`).toBe(false);
      }
    }
  });

  it('a program behind the options of env, exec, command and time, and behind the separators, groups, keywords and wrappers of a shell command, is found', () => {
    const wrappers = ['env -i', 'env --ignore-environment', 'env -u X', 'env --unset=X', 'env -C /', 'env --', 'env -i -- FOO=1', 'env -i FOO=1', 'FOO=1 env -i', 'exec -a name', 'command -p',
      'time -p', 'nohup', 'env -i exec'].map((form) => (audit: string) => `${form} ${audit}`);
    const syntax = ['true && AUDIT', 'false || AUDIT', 'echo x | AUDIT', 'true; AUDIT', 'true;AUDIT', 'AUDIT &', 'true & AUDIT', '(AUDIT)', 'AUDIT > AUDIT.out 2>&1', "sh -c 'AUDIT'", 'bash -lc "AUDIT"',
      "env -S 'AUDIT --flag'", "env -S 'env -i AUDIT'", "env --split-string 'AUDIT --flag'", "env --split-string='AUDIT --flag'", "env -S'AUDIT --flag'",
      "env --split='AUDIT --flag'", "env -i --split-string='env -S\"AUDIT\"'", 'if true; then AUDIT; fi', 'if false; then true; elif true; then AUDIT; fi', 'while true; do AUDIT; done',
      'case x in x) AUDIT;; esac', '{ AUDIT; }', '! AUDIT', 'sudo AUDIT', 'nice -n 5 AUDIT', 'timeout 5 AUDIT', 'xargs AUDIT', 'echo x | xargs -n1 AUDIT', 'env -iu X AUDIT'].map((form) => (audit: string) => form.replaceAll('AUDIT', audit));
    for (const [k, build] of [...wrappers, ...syntax].entries()) {
      const f = fixture(`wrapper-${k}`, { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
      const audit = join(f.dir, 'audit');
      writeFileSync(audit, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const command = build(audit);
      const other = { matcher: 'Bash', hooks: [{ type: 'command', command }] };
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] }, other] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: audit, log_file: f.log, settings_file: f.settings }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${command}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, command).toContain(`"state_file" (${audit}) and "program of another hook" (${audit}) are the same file`);
      expect(readText(audit), `${command}: the program is intact`).toBe('#!/bin/sh\nexit 0\n');
    }
    // an entry of this guard written by hand behind env -i is still the entry: the wiring check finds it
    const f = fixture('wrapper-own-entry', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `env -i ${PYBIN} -I ${HOOK} --pause-file ${f.pause}`, timeout: 21600 }] }] } }), 'utf8');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const own = runSync(GUARD, ['--config', f.cfg, '--once']);
    expect(own.status, `${own.stdout}${own.stderr}`).toBe(0);
    expect(own.stdout, 'the entry behind env -i is found').not.toMatch(/NOT registered/);
  });

  it('a registered hook or launcher that a settings rewrite made the state file is reported at every wiring pass, and the pause that would replace it is refused', async () => {
    const rewrite = (f: Fixture, program: string) => writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, program, PYBIN), timeout: 21600 }] }] } }), 'utf8');
    const config = (f: Fixture, state: string) => writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: state, log_file: f.log, settings_file: f.settings }), 'utf8');

    const paused = fixture('program-is-state-paused', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const stateA = join(paused.dir, 'five-hour-guard-hook.py.state');
    config(paused, stateA);
    writeFileSync(paused.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(paused.pause, HOOK, PYBIN), timeout: 21600 }] }] } }), 'utf8');
    const g = startGuard(paused, ['--warn-every', '1']);
    try {
      await waitFor(() => existsSync(paused.pause), 20000, 'the pause');
      rewrite(paused, stateA);
      await waitFor(() => /WARNING \(pause\): the hook entry in .* names .*five-hour-guard-hook\.py\.state, which is the state_file of this guard/.test(readText(paused.log)), 20000, 'the collision warning');
    } finally { await stopGuard(g); }

    const idle = fixture('program-is-state-idle', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const stateB = join(idle.dir, 'five-hour-guard-hook.py.state');
    config(idle, stateB);
    writeFileSync(idle.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(idle.pause, HOOK, PYBIN), timeout: 21600 }] }] } }), 'utf8');
    const g2 = startGuard(idle);
    try {
      await waitFor(() => /guard start/.test(readText(idle.log)), 20000, 'the start');
      writeFileSync(stateB, 'the program\n', 'utf8');
      rewrite(idle, stateB);
      writeCache(idle, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => /ERROR: tick failed.*is the state_file of this guard/.test(readText(idle.log)), 20000, 'the refusal');
    } finally { await stopGuard(g2); }
    expect(readText(stateB), 'the program is intact').toBe('the program\n');
    expect(existsSync(idle.pause), 'no pause was published').toBe(false);
  });

  it('an early stop of a test pause retries a failed removal and does not report it as done: a removal that never succeeds is an error with exit 1', async () => {
    const run = async (name: string, refusals: number) => {
      const f = fixture(name, {});
      const code = ['import os, runpy, sys', 'real = os.rename', 'target = sys.argv[1]', 'left = [int(sys.argv[2])]',
        'def maybe(p, *a, **k):', '    if str(p) == target and left[0] > 0:', '        left[0] -= 1', '        raise OSError(1, "Operation not permitted")', '    return real(p, *a, **k)',
        'os.rename = maybe', 'sys.argv = sys.argv[3:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
      const g = spawnPyCode(code, [f.pause, String(refusals), GUARD, ...guardArgs(f, ['--test-pause', '600'])]);
      try {
        await waitFor(() => existsSync(f.pause), 20000, 'the test pause');
        g.child.kill('SIGTERM');
        await Promise.race([g.done, sleep(30000)]);
      } finally { await g.stop(); }
      return { f, code: g.code, log: readText(f.log) + g.out };
    };
    const once = await run('test-pause-retry', 1);
    expect(existsSync(once.f.pause), 'the second try removed the file').toBe(false);
    expect(once.code).toBe(0);
    expect(once.log).toMatch(/test pause over: pause file removed/);
    const never = await run('test-pause-never', 99);
    expect(existsSync(never.f.pause), 'the file could not be removed').toBe(true);
    expect(never.code, 'exit 1').toBe(1);
    expect(never.log).toMatch(/ERROR: test pause over, but the pause file .* could not be removed/);
    expect(never.log, 'not reported as removed').not.toMatch(/test pause over: pause file removed/);
  });

  it('a stop whose first removal of the pause file fails tries once more: the state is already unpaused and the sessions are not left waiting for the heartbeat', async () => {
    const f = fixture('stop-unlink-fails', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const flag = join(f.dir, 'deny-unlink');
    const code = ['import os, runpy, sys', 'real = os.rename', 'flag = sys.argv[1]', 'target = sys.argv[2]',
      'def maybe(p, *a, **k):', '    if str(p) == target and os.path.exists(flag):', '        os.unlink(flag)', '        raise OSError(1, "Operation not permitted")', '    return real(p, *a, **k)',
      'os.rename = maybe', 'sys.argv = sys.argv[3:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const g = spawnPyCode(code, [flag, f.pause, GUARD, ...guardArgs(f, ['--interval', '3', '--heartbeat', '600'])]);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'the pause');
      writeFileSync(flag, '', 'utf8');
      g.child.kill('SIGTERM');
      await Promise.race([g.done, sleep(20000)]);
      expect(g.exited && g.code === 0, `exit ${g.code}`).toBe(true);
    } finally { await g.stop(); }
    expect(existsSync(flag), 'the first removal was refused').toBe(false);
    expect(existsSync(f.pause), 'the pause file is removed by the second try').toBe(false);
    expect(readJson(f.state).paused).toBe(false);
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
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', timeout: 21600, command: `exec ${wrapper} -I ${HOOK} --pause-file ${f.pause}` }] }] } }), 'utf8');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: wrapper, settings_file: f.settings }), 'utf8');
    const r = runSync(GUARD, ['--config', f.cfg, '--once']);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/are the same file/);
    expect(readText(wrapper)).toBe('#!/bin/sh\nexec python3 "$@"\n');
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
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', timeout: 21600, command: 'exec "unterminated # five-hour-guard-entry' }] }] } }), 'utf8');
    expect(guardOnce(f).stdout, 'a command the shell cannot parse').toMatch(/WARNING \(start\): the hook entry in .* is not the entry this guard generates/);
    rmSync(f.state, { force: true });
    writePause(f, { pid: 1e20 });
    const huge = guardOnce(f);
    expect(huge.stderr).not.toMatch(/Traceback/);
    expect(existsSync(f.pause), 'a pid no process can have: the leftover is removed').toBe(false);
    // where no lock is available the pid of a pause with a current heartbeat is probed: a pid that no process can have is not a crash
    const noLocks = ['import runpy, sys', 'sys.modules["fcntl"] = None', 'sys.modules["msvcrt"] = None', 'sys.argv = sys.argv[1:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    writePause(f, { pid: 1e20 });
    const unlocked = runPyCode(noLocks, [GUARD, ...guardArgs(f, ['--once'])]);
    expect(unlocked.status, `${unlocked.stdout}${unlocked.stderr}`).toBe(0);
    expect(unlocked.stderr).not.toMatch(/Traceback/);
    expect(existsSync(f.pause), 'the pause of a pid no process can have is a leftover also without locks').toBe(false);
  });

  it('a stored pause that is over at start is cleared even when the state file cannot be written: an ERROR line, not a traceback', () => {
    const f = fixture('start-write-fails', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.state, JSON.stringify({ paused: true, since: now() - 700, resume_at: now() - 10 }), 'utf8');
    const code = ['import os, runpy, sys', 'real = os.open',
      'def fail_on_state(path, *a, **k):', '    if "state.json." in str(path) and str(path).endswith(".tmp"): raise OSError(30, "Read-only file system")', '    return real(path, *a, **k)',
      'os.open = fail_on_state', 'sys.argv = sys.argv[1:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
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
    const code = ['import os, runpy, sys', 'real = os.open', 'flag = sys.argv[1]',
      'def maybe_fail(path, *a, **k):', '    if "state.json." in str(path) and str(path).endswith(".tmp") and os.path.exists(flag): raise OSError(30, "Read-only file system")', '    return real(path, *a, **k)',
      'os.open = maybe_fail', 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
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
    const code = ['import os, runpy, sys', 'real = os.open', 'flag = sys.argv[1]',
      'def maybe_fail(path, *a, **k):', '    if "state.json." in str(path) and str(path).endswith(".tmp") and os.path.exists(flag): raise OSError(30, "Read-only file system")', '    return real(path, *a, **k)',
      'os.open = maybe_fail', 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
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
    const command = generatedCommand(pause, HOOK, PYBIN, hookLog);
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } }), 'utf8');
    const r = guardOnce(f);
    expect(r.stdout, 'no wiring warning: the hook file exists, the pause file need not').not.toMatch(/WARNING/);
  });

  it('a handler that is not a command (prompt, http) is not the hook, whatever its old command field says', () => {
    const f = fixture('handler-type', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const command = generatedCommand(f.pause, HOOK, PYBIN);
    for (const type of ['prompt', 'http', 'agent', undefined]) {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ ...(type ? { type } : {}), command, timeout: 21600 }] }] } }), 'utf8');
      expect(guardOnce(f).stdout, String(type)).toMatch(/WARNING \(start\): hook five-hour-guard-hook\.py is NOT registered/);
    }
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } }), 'utf8');
    expect(guardOnce(f).stdout).not.toMatch(/WARNING/);
  });

  it('a NUL character in a path of the registered entry is a wiring warning, not a traceback that the unit restarts for ever', () => {
    const f = fixture('registered-nul', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    for (const command of [`exec ${PYBIN} -I /opt/five-hour-guard-hook.py\0 --pause-file ${f.pause} # five-hour-guard-entry`, `[ -x ${PYBIN}\0 ] || exit 0; exec ${PYBIN} -I ${HOOK} --pause-file ${f.pause} # five-hour-guard-entry`,
      `exec ${PYBIN} -I ${HOOK} --pause-file ${f.pause} --log /opt/hook\0.log # five-hour-guard-entry`]) {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } }), 'utf8');
      const r = runSync(GUARD, guardArgs(f, ['--once']));
      expect(r.status, `${JSON.stringify(command)}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout).toMatch(/WARNING \(start\): the hook entry in .* is not the entry this guard generates/);
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
    const code = ['import os, runpy, sys', 'real = os.rename', 'flag = sys.argv[1]',
      'def maybe(p, *a, **k):', '    if os.path.exists(flag) and str(p).endswith("pause.json"): raise PermissionError(13, "denied")', '    return real(p, *a, **k)',
      'os.rename = maybe', 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
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
    const command = `[ -f ${f.pause} ] && [ -f ${hook} ] && [ -x ${py} ] || exit 0; exec ${py} -I ${hook} --pause-file ${f.pause} --log ${oldLog} # five-hour-guard-entry`;
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } }), 'utf8');
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

  it('a malformed hook entry does not hide the entries after it: a state file that is a valid registered hook later in the list is still refused', () => {
    const f = fixture('alias-after-malformed', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    const dir = join(f.dir, 'custom');
    mkdirSync(dir, { recursive: true });
    const hook = join(dir, 'five-hour-guard-hook.py');
    copyFileSync(HOOK, hook);
    const hookText = readFileSync(hook, 'utf8');
    const malformed = `exec ${PYBIN} -I ${HOOK} --pause-file '${f.pause}`;
    const valid = generatedCommand(f.pause, hook, PYBIN);
    for (const commands of [[malformed, valid], [valid, malformed]]) {
      const handlers = commands.map((command) => ({ type: 'command', command, timeout: 21600 }));
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: handlers }] } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: hook, log_file: f.log, settings_file: f.settings }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${commands[0] === malformed ? 'malformed first' : 'valid first'}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/are the same file/);
      expect(readFileSync(hook, 'utf8'), 'the registered hook is intact').toBe(hookText);
    }
  });

  it('a registered hook that became a link to the interpreter of its own entry is refused at the start, while a hook that is run directly (its own launcher) is not', () => {
    const f = fixture('alias-hook-is-interpreter', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const put = (command: string) => writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } }), 'utf8');
    put(`[ -f ${f.pause} ] && [ -f ${HOOK} ] || exit 0; exec ${HOOK} --pause-file ${f.pause}`);
    expect(runSync(GUARD, ['--config', f.cfg, '--once']).status, 'the hook run directly').toBe(0);
    const hook = join(f.dir, 'as-python', 'five-hour-guard-hook.py');
    mkdirSync(join(f.dir, 'as-python'), { recursive: true });
    symlinkSync(PYBIN, hook);
    put(generatedCommand(f.pause, hook, PYBIN));
    const r = runSync(GUARD, ['--config', f.cfg, '--once']);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/are the same file/);
  });

  it('a registered hook that became a link to another program of the guard is refused at the start, while the bundled hook as the registered one is not', () => {
    const f = fixture('alias-cross-program', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const entryFor = (hook: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, hook, PYBIN), timeout: 21600 }] }] } });
    writeFileSync(f.settings, entryFor(HOOK), 'utf8');
    expect(runSync(GUARD, ['--config', f.cfg, '--once']).status, 'the bundled hook is the registered one').toBe(0);
    for (const [name, program] of [['entry module', ENTRY_MODULE], ['guard script', GUARD]] as const) {
      const dir = join(f.dir, `as-${name.replace(' ', '-')}`);
      mkdirSync(dir, { recursive: true });
      const hook = join(dir, 'five-hour-guard-hook.py');
      symlinkSync(program, hook);
      writeFileSync(f.settings, entryFor(hook), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${name}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/are the same file/);
    }
  });

  it('the lock file of the usage cache (OMC serialises refreshes on <cache>.lock) is a configured file: a pause file that is it is refused', () => {
    const f = fixture('alias-cache-lock', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: `${f.cache}.lock`, state_file: f.state }), 'utf8');
    const r = runSync(GUARD, ['--config', f.cfg, '--once']);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/are the same file/);
    expect(existsSync(`${f.cache}.lock`)).toBe(false);
  });

  it('the entry is recognised by its marker or by the exact path of the bundled hook, not by analysing a command: an old entry is registered, another tool\'s command with a similar name is not', () => {
    const f = fixture('entry-recognition', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const put = (...commands: string[]) => writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: commands.map((command) => ({ type: 'command', command, timeout: 21600 })) }] } }), 'utf8');
    const run = () => runSync(GUARD, guardArgs(f, ['--once'])).stdout;
    const old = `[ -f ${f.pause} ] && [ -f ${HOOK} ] || exit 0; exec ${PYBIN} -I ${HOOK} --pause-file ${f.pause}`;   // written by an earlier version of add: no marker
    put(old);
    expect(run(), 'an entry with the exact path of the hook is registered').not.toMatch(/NOT registered/);
    expect(run(), 'and it differs from the generated one: one warning with the entry to paste').toMatch(/is not the entry this guard generates.*# five-hour-guard-entry/);
    put(generatedCommand(f.pause, join(f.dir, 'custom-name.py'), PYBIN));
    expect(run(), 'a marker is enough, whatever the path').not.toMatch(/NOT registered/);
    for (const other of [`node --check ${HOOK}.js --pause-file /tmp/p`, 'python3 --version /opt/other/five-hour-guard-hook.py', 'bash -n /opt/other/five-hour-guard-hook.py', 'printf /opt/other/five-hour-guard-hook.py --pause-file /tmp/p']) {
      put(other);
      expect(run(), `${other}: not the entry of the guard`).toMatch(/WARNING \(start\): hook five-hour-guard-hook\.py is NOT registered/);
    }
  });

  it('the log of an entry that carries the marker is read from its words (--log after the generated format): it may not be the hook or interpreter of that entry, also with paths of its own, nor the hook of the guard when the command has no generated word', () => {
    const f = fixture('entry-log-roles', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const dir = join(f.dir, 'custom');
    mkdirSync(dir, { recursive: true });
    const hook = join(dir, 'my-hook.py');
    const py = join(dir, 'my-python');
    copyFileSync(HOOK, hook);
    writeFileSync(py, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const put = (command: string) => writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } }), 'utf8');
    const entry = (log: string, hookPath = hook, python = py) => `exec ${python} -I ${hookPath} --pause-file ${f.pause} --log ${log} # five-hour-guard-entry`;
    for (const [name, command] of [['its own hook', entry(hook)], ['its own interpreter', entry(py)], ['the hook of the guard, no generated word in the command', entry(HOOK)]] as const) {
      put(command);
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${name}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, name).toMatch(/"registered hook log" \(.*\) are the same file|and "registered hook log" \(/);
    }
    put(entry(join(dir, 'my-hook.log')));
    expect(runSync(GUARD, ['--config', f.cfg, '--once']).status, 'a log of its own is fine').toBe(0);
  });

  it('the log of a hook entry that carries the marker is no file that another word of the entry names: a positional script or an argument that is the --log file is refused, a log of its own is fine', () => {
    const f = fixture('entry-log-positional', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    const custom = join(f.dir, 'custom.py');
    const program = '# the script of the entry\nprint("hold")\n';
    writeFileSync(custom, program, 'utf8');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const put = (command: string) => writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } }), 'utf8');
    for (const [name, command] of [
      ['a positional script', `exec ${PYBIN} ${custom} --pause-file ${f.pause} --log ${custom} # five-hour-guard-entry`],
      ['an argument', `exec ${PYBIN} -I ${HOOK} --pause-file ${f.pause} --other ${custom} --log ${custom} # five-hour-guard-entry`],
    ] as const) {
      put(command);
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `${name}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, name).toMatch(/"registered hook log" \(.*custom\.py\) and "file named by the hook entry" \(.*custom\.py\) are the same file|"file named by the hook entry" \(.*custom\.py\) and "registered hook log" \(.*custom\.py\) are the same file/);
      expect(readText(custom), `${name}: the script is intact`).toBe(program);
      expect(existsSync(f.pause), `${name}: no pause was published`).toBe(false);
    }
    put(`exec ${PYBIN} ${custom} --pause-file ${f.pause} --log ${join(f.dir, 'custom.log')} # five-hour-guard-entry`);
    expect(runSync(GUARD, ['--config', f.cfg, '--once']).status, 'a log of its own is fine').toBe(0);
    expect(readText(custom), 'the script is intact').toBe(program);
  });

  it('a handler without the marker is not read for roles: its --log is a word like any other, a program of another hook for the guard', () => {
    const f = fixture('foreign-log-not-read', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const ours = { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] };
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [ours, { matcher: 'Bash', hooks: [{ type: 'command', command: `other-tool -I /x/other-hook.py --log ${f.state}` }] }] } }), 'utf8');
    const r = runSync(GUARD, ['--config', f.cfg, '--once']);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toContain(`"state_file" (${f.state}) and "program of another hook" (${f.state}) are the same file`);
    expect(r.stderr).not.toMatch(/registered hook log/);
  });

  it('the hook entry is compared with the generated one: an entry that differs warns once with the entry to paste, the generated entry (with or without a hook log) is silent', () => {
    const f = fixture('entry-drift', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const base = { usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings };
    const put = (command: string) => writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } }), 'utf8');
    const rel = (p: string) => relative(f.dir, p);
    const gen = (o: { pause?: string; hook?: string; python?: string; log?: string } = {}) => generatedCommand(o.pause ?? f.pause, o.hook ?? HOOK, o.python ?? PYBIN, o.log);
    const copy = join(f.dir, 'five-hour-guard-hook.py');
    copyFileSync(HOOK, copy);
    chmodSync(copy, 0o644);
    const exec644 = `[ -f ${f.pause} ] && [ -f ${copy} ] || exit 0; exec ${copy} --pause-file ${f.pause} # five-hour-guard-entry`;
    const cases: Array<{ name: string; command: string; paste: string; also?: RegExp; unread?: boolean }> = [
      { name: 'no shell check at all', command: `exec ${PYBIN} -I ${HOOK} --pause-file ${f.pause}`, paste: gen() },
      { name: 'no check of the interpreter', command: `[ -f ${f.pause} ] && [ -f ${HOOK} ] || exit 0; exec ${PYBIN} -I ${HOOK} --pause-file ${f.pause}`, paste: gen() },
      { name: 'a stale pause file in the shell check', command: gen().replace(`[ -f ${f.pause} ]`, '[ -f /old/pause.json ]'), paste: gen() },
      { name: 'a stale hook in the shell check', command: gen().replace(`[ -f ${HOOK} ]`, '[ -f /old/five-hour-guard-hook.py ]'), paste: gen() },
      { name: 'an interpreter in the shell check other than the one that runs', command: gen().replace(`[ -x ${PYBIN} ]`, '[ -x /bin/sh ]'), paste: gen() },
      { name: 'the script run directly (mode 0644)', command: exec644, paste: gen() },
      { name: 'a pause file other than the guard writes', command: gen({ pause: `${f.dir}/old-pause.json` }), paste: gen() },
      { name: 'no pause file at all', command: `exec ${PYBIN} -I ${HOOK}`, paste: gen() },
      { name: '--pause-file without a value', command: `exec ${PYBIN} -I ${HOOK} --pause-file`, paste: gen() },
      { name: 'a hook log and no pause file', command: `exec ${PYBIN} -I ${HOOK} --log ${f.dir}/hook.log`, paste: gen() },
      { name: 'a relative pause file', command: gen({ pause: rel(f.pause) }), paste: gen(), unread: true },   // (the bare name of the pause file is a word that the PATH of the session may find: the entry is not read to its end, which is said too)
      { name: 'a poll interval written by hand', command: `${gen()} --poll 3600`, paste: gen() },
    ];
    for (const key of [false, true]) {
      writeFileSync(f.cfg, JSON.stringify(key ? { ...base, hook_log_file: join(f.dir, 'hook.log') } : base), 'utf8');
      const run = () => runSync(GUARD, guardArgs(f, ['--once']), { cwd: f.dir }).stdout;
      put(gen({ log: key ? join(f.dir, 'hook.log') : undefined }));
      expect(run(), `the generated entry, hook log ${key}`).not.toMatch(/WARNING/);
      if (key) {
        put(gen());
        const drift = run().split('\n').filter((l) => /is not the entry this guard generates/.test(l));
        expect(drift, 'a configured hook log that the entry does not use: one warning').toHaveLength(1);
        expect(drift[0].endsWith(`: ${gen({ log: join(f.dir, 'hook.log') })}`), drift[0]).toBe(true);
        continue;
      }
      for (const c of cases) {
        put(c.command);
        const out = run();
        if (c.unread) expect(out, c.name).toMatch(/WARNING \(hook-unread\)/);
        const warnings = out.split('\n').filter((l) => /is not the entry this guard generates/.test(l));
        expect(warnings, `${c.name}: one drift warning`).toHaveLength(1);
        expect(warnings[0].endsWith(`: ${c.paste}`), `${c.name}: the entry to paste is ${c.paste}, got ${warnings[0]}`).toBe(true);
        if (c.also) expect(out, c.name).toMatch(c.also);
        // what the warning offers is itself silent
        put(c.paste);
        expect(run(), `${c.name}: the pasted entry`).not.toMatch(/WARNING/);
      }
    }
  });

  it('a handler that runs in the background or whose timeout does not cover a pause is reported (Claude Code would let the tool call go on); a long enough timeout in the foreground is silent', () => {
    const f = fixture('handler-attributes', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const command = generatedCommand(f.pause, HOOK, PYBIN);
    const put = (handler: Record<string, unknown>) => writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, ...handler }] }] } }), 'utf8');
    const table: Array<[string, Record<string, unknown>, RegExp | null]> = [
      ['21600 s in the foreground', { timeout: 21600 }, null],
      ['a longer timeout', { timeout: 30000 }, null],
      ['async false', { timeout: 21600, async: false }, null],
      ['async true', { timeout: 21600, async: true }, /is asynchronous/],
      ['async as a text', { timeout: 21600, async: 'true' }, /is asynchronous/],
      ['no timeout', {}, /timeout \(None\) is missing, not a finite number or below 21600/],
      ['a short timeout', { timeout: 60 }, /timeout \(60\) is missing, not a finite number or below 21600 s/],
      ['one second short', { timeout: 21599 }, /timeout \(21599\)/],
      ['a timeout that is a text', { timeout: '21600' }, /timeout \('21600'\)/],
      ['a timeout that is a boolean', { timeout: true }, /timeout \(True\)/],
    ];
    for (const [name, handler, want] of table) {
      put(handler);
      const out = guardOnce(f).stdout;
      if (want) expect(out, name).toMatch(want);
      else expect(out, name).not.toMatch(/WARNING/);
    }
  });

  it('a timeout that is an integer too large for a float (400 digits) is reported like a missing one: the guard starts, warns, and still enters the pause', () => {
    const f = fixture('handler-huge-timeout', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const entry = JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 'HUGE' }] }] } });
    writeFileSync(f.settings, entry.replace('"HUGE"', '9'.repeat(400)), 'utf8');
    const out = guardOnce(f).stdout;   // guardOnce: exit status 0
    expect(out, 'the start').toMatch(/WARNING \(start\): .*timeout \(9{40}\.\.\.\) is missing, not a finite number or below 21600/);
    expect(out, 'the pause start').toMatch(/WARNING \(pause start\): .*timeout \(9{40}\.\.\.\) is missing/);
    expect(readJson(f.pause).paused, 'the pause was entered').toBe(true);
  });

  it('a failure inside the check of the hook entry is reported and does not stop the guard: it starts and still enters the pause', () => {
    const f = fixture('wiring-check-fails', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] }] } }), 'utf8');
    const r = runPyCode(QUOTE_FAILS_DRIVER, [GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout, 'the start').toMatch(/WARNING \(start\): the check of the hook entry failed .*lookup failed/);
    expect(r.stdout, 'the pause start').toMatch(/WARNING \(pause start\): the check of the hook entry failed .*lookup failed/);
    expect(readJson(f.pause).paused, 'the pause was entered').toBe(true);
  });

  it('a file that appears at pause_file after the start is never replaced by a pause: the tick reports it and nothing is published or stored, also when it appears in the instant before the file is linked into place', async () => {
    const f = fixture('foreign-after-start', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const g = startGuard(f);
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start');
      writeFileSync(f.pause, 'notes of somebody else\n', 'utf8');
      writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => /ERROR: tick failed.*is not a pause file of this guard/.test(readText(f.log)), 20000, 'the refusal');
      expect(readText(f.pause), 'the foreign file is intact').toBe('notes of somebody else\n');
      expect(existsSync(f.state) ? readJson(f.state).paused : false, 'no pause was stored').toBe(false);
    } finally { await stopGuard(g); }
    expect(readText(f.pause)).toBe('notes of somebody else\n');

    const race = fixture('foreign-at-link', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const driver = ['import os, runpy, sys', 'real = os.link', 'target = sys.argv[1]',
      'def late(a, b, *args, **kw):', '    if b == target: open(b, "w").write("late foreign file\\n")', '    return real(a, b, *args, **kw)',
      'os.link = late', 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const r = runPyCode(driver, [race.pause, GUARD, ...guardArgs(race, ['--once'])]);
    expect(r.stdout).toMatch(/ERROR: tick failed.*appeared meanwhile/);
    expect(readText(race.pause), 'the file that appeared in the instant is not replaced').toBe('late foreign file\n');
  });

  it('a file that appears at pause_file in the instant between the ownership check and the choice of the exclusive write is not replaced either', () => {
    // the file is created right after the check of a publication has found no file: a second look at the path would find it and allow the replacing write
    const driver = ['import os, runpy, sys', 'real = os.lstat', 'target = sys.argv[1]',
      'def late(path, *args, **kw):', '    try:', '        return real(path, *args, **kw)', '    except FileNotFoundError:',
      '        if str(path) == target and sys._getframe(2).f_code.co_name == "publish": open(target, "w").write("late foreign file\\n")',
      '        raise',
      'os.lstat = late', 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const f = fixture('foreign-at-existence-check', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const r = runPyCode(driver, [f.pause, GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.stdout, `${r.stdout}${r.stderr}`).toMatch(/ERROR: tick failed.*appeared meanwhile/);
    expect(readText(f.pause), 'the file that appeared is not replaced').toBe('late foreign file\n');
  });

  it('a pause file that is swapped for a foreign file between the validation and the replacing write of a renewal is not replaced, and no temporary file is left', () => {
    const f = fixture('renewal-swap', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    guardOnce(f);   // enters the pause; the next run renews it
    expect(readJson(f.pause).paused, 'the pause is in force').toBe(true);
    // the swap happens when the temporary file of the pause has been written: the validation is behind, the rename ahead
    const driver = ['import json, os, runpy, sys', 'dump, opener, target, seen = json.dump, os.open, sys.argv[1], {}',
      'def spy(path, *args, **kw):', '    if str(path).startswith(target + ".") and str(path).endswith(".tmp"): seen["tmp"] = path',
      '    return opener(path, *args, **kw)',
      'def swapped(obj, handle, *args, **kw):', '    dump(obj, handle, *args, **kw)',
      '    if seen.pop("tmp", None) and os.path.lexists(target):',
      '        open(target + ".foreign", "w").write("foreign file\\n")', '        os.replace(target + ".foreign", target)',
      'os.open, json.dump = spy, swapped', 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const r = runPyCode(driver, [f.pause, GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.stdout, `${r.stdout}${r.stderr}`).toMatch(/ERROR: tick failed.*changed since it was validated and is not replaced/);
    expect(readText(f.pause), 'the foreign file is not replaced by the renewal').toBe('foreign file\n');
    expect(readdirSync(f.dir).filter((n) => n.endsWith('.tmp')), 'no temporary file is left').toEqual([]);
    // the same renewal without the swap goes through (the pause file is written again, with a later heartbeat)
    rmSync(f.pause);
    guardOnce(f);
    const before = readJson(f.pause).valid_until;
    guardOnce(f);
    expect(readJson(f.pause).valid_until, 'a renewal of an unchanged file still renews it').toBeGreaterThanOrEqual(before);
  });

  it('a pause file that is swapped for a foreign file right after the identity check of a renewal, before the file is put in place, is kept where it is: nothing at the path is destroyed, with the exchange of two paths and where the system cannot do it (a plain replace after one more look: the renewal goes through unless a file came in)', () => {
    const f = fixture('renewal-late-swap', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    guardOnce(f);   // enters the pause; the next run renews it
    expect(readJson(f.pause).paused, 'the pause is in force').toBe(true);
    // the swap follows the look at the path that write_json makes to compare it with the file that was validated: whatever puts the new file in place comes after it
    const swap = ['real, pause, looks = os.lstat, sys.argv[1], []',
      'def swap(path, *args, **kw):', '    found = real(path, *args, **kw)',
      '    if str(path) == pause and sys._getframe(1).f_code.co_name == "write_json" and not looks:', '        looks.append(1)',
      '        open(pause + ".foreign", "w").write("foreign file\\n")', '        os.replace(pause + ".foreign", pause)',
      '    return found',
      'os.lstat = swap'];
    // the system has no exchange of two paths (the C library cannot be loaded, as on macOS and Windows, or the file system refuses it)
    const noExchange = ['import ctypes', 'real_cdll, pause_path = ctypes.CDLL, sys.argv[1]', 'class NoSwap:', '    def __init__(self, library):', '        self.library = library',
      '    def renameat2(self, *args):', '        return -1 if os.fsdecode(args[3]) == pause_path else self.library.renameat2(*args)', 'ctypes.CDLL = lambda *args, **kw: NoSwap(real_cdll(*args, **kw))'];
    const run = (lines: string[], f2: Fixture) => runPyCode(['import os, runpy, sys', ...lines, 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n'), [f2.pause, GUARD, ...guardArgs(f2, ['--once'])]);
    const r = run(swap, f);
    expect(r.stdout, `${r.stdout}${r.stderr}`).toMatch(/ERROR: tick failed.*changed since it was validated and is not replaced/);
    expect(readText(f.pause), 'the file that came in after the check is still at the path, untouched').toBe('foreign file\n');
    expect(readdirSync(f.dir).filter((n) => n.endsWith('.tmp')), 'no temporary file is left').toEqual([]);
    // without the exchange the renewal goes through by a plain replace while the file is the one that was validated; a file that came in is still kept
    const g = fixture('renewal-no-exchange', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    guardOnce(g);
    const before = readJson(g.pause).valid_until;
    const renewed = run(noExchange, g);
    expect(renewed.stdout, `${renewed.stdout}${renewed.stderr}`).not.toContain('ERROR');
    expect(readJson(g.pause).valid_until, 'the pause file is renewed without the exchange').toBeGreaterThan(before);
    const late = run([...noExchange, ...swap], g);
    expect(late.stdout, `${late.stdout}${late.stderr}`).toMatch(/ERROR: tick failed.*cannot be put in place/);
    expect(readText(g.pause), 'a file that came in after the check survives where the exchange is missing').toBe('foreign file\n');
    expect(readdirSync(g.dir).filter((n) => n.endsWith('.tmp')), 'no temporary file is left').toEqual([]);
    // with the exchange and no competing file the renewal goes through, with a later heartbeat
    rmSync(f.pause);
    guardOnce(f);
    const first = readJson(f.pause).valid_until;
    guardOnce(f);
    expect(readJson(f.pause).valid_until, 'a renewal that finds the file it validated renews it').toBeGreaterThanOrEqual(first);
  });

  it('a pause file that is gone when a renewal looks at it is written like a first publication: a foreign file that comes in right after that look is kept and the write fails, and without one the pause is written again', () => {
    // the renewal validated an existing file; the look that write_json makes finds the path empty, and the foreign file comes in right after it, before the pause is written
    const driver = ['import os, runpy, sys', 'pause, late, real, looks = sys.argv[1], sys.argv[2] == "1", os.lstat, []',
      'def look(path, *args, **kw):', '    if str(path) == pause and sys._getframe(1).f_code.co_name == "write_json" and not looks:', '        looks.append(1)', '        os.unlink(pause)',
      '        try:', '            return real(path, *args, **kw)', '        finally:', '            if late:', '                open(pause, "w").write("foreign file\\n")',
      '    return real(path, *args, **kw)',
      'os.lstat = look', 'sys.argv = sys.argv[3:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const f = fixture('renewal-vanished-late-arrival', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    guardOnce(f);   // enters the pause; the next run renews it
    expect(readJson(f.pause).paused, 'the pause is in force').toBe(true);
    const r = runPyCode(driver, [f.pause, '1', GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.stdout, `${r.stdout}${r.stderr}`).toMatch(/ERROR: tick failed.*appeared meanwhile/);
    expect(readText(f.pause), 'the foreign file that came in after the look is not replaced').toBe('foreign file\n');
    expect(readdirSync(f.dir).filter((n) => n.endsWith('.tmp')), 'no temporary file is left').toEqual([]);
    // the same renewal with nobody coming in: the pause is written again
    const g = fixture('renewal-vanished-clean', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    guardOnce(g);
    const clean = runPyCode(driver, [g.pause, '0', GUARD, ...guardArgs(g, ['--once'])]);
    expect(clean.status, `${clean.stdout}${clean.stderr}`).toBe(0);
    expect(readJson(g.pause).paused, 'the pause is written again').toBe(true);
    expect(readdirSync(g.dir).filter((n) => n.endsWith('.tmp')), 'no temporary file is left').toEqual([]);
  });

  it('a second foreign file that takes the path of the pause file after the first exchange of a renewal is kept too: the file that the exchange back returns stays under the temporary name, and the log names it', () => {
    const f = fixture('renewal-two-arrivals', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    guardOnce(f);   // enters the pause; the next run renews it
    // file A takes the path right after the identity check; file B takes it right after the first exchange of the renewal, so the exchange back returns B
    const driver = ['import ctypes, os, runpy, sys', 'real_lstat, real_cdll, pause, looks, calls = os.lstat, ctypes.CDLL, sys.argv[1], [], []',
      'def swap(path, *args, **kw):', '    found = real_lstat(path, *args, **kw)',
      '    if str(path) == pause and sys._getframe(1).f_code.co_name == "write_json" and not looks:', '        looks.append(1)',
      '        open(pause + ".a", "w").write("foreign file A\\n")', '        os.replace(pause + ".a", pause)',
      '    return found',
      'class Library:', '    def __init__(self, library):', '        self.library = library',
      '    def renameat2(self, *args):', '        if os.fsdecode(args[3]) != pause:', '            return self.library.renameat2(*args)', '        done = self.library.renameat2(*args)', '        calls.append(1)',
      '        if len(calls) == 1:', '            open(pause + ".b", "w").write("foreign file B\\n")', '            os.replace(pause + ".b", pause)',
      '        return done',
      'os.lstat, ctypes.CDLL = swap, lambda *args, **kw: Library(real_cdll(*args, **kw))', 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const r = runPyCode(driver, [f.pause, GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.stdout, `${r.stdout}${r.stderr}`).toMatch(/ERROR: tick failed.*the file that came in is kept as .*\.tmp/);
    expect(readText(f.pause), 'the first file is back at the path').toBe('foreign file A\n');
    const kept = readdirSync(f.dir).filter((n) => n.endsWith('.tmp'));
    expect(kept, 'the second file is kept under the temporary name').toHaveLength(1);
    expect(readText(join(f.dir, kept[0])), 'with its content').toBe('foreign file B\n');
    expect(r.stdout, 'and the message names it').toContain(join(f.dir, kept[0]));
    expect(readText(f.log), 'the log has the name too').toContain(kept[0]);
  });

  it('a renewal whose exchange back fails keeps the file that came in under the temporary name, leaves the new pause in place, and the error and the log say so', () => {
    const f = fixture('renewal-exchange-back-fails', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    guardOnce(f);   // enters the pause; the next run renews it
    const before = readJson(f.pause).valid_until;
    // file A takes the path right after the identity check, so the first exchange takes it out; the exchange back (the second call) does not happen
    const driver = ['import ctypes, os, runpy, sys', 'real_lstat, real_cdll, pause, looks, calls = os.lstat, ctypes.CDLL, sys.argv[1], [], []',
      'def swap(path, *args, **kw):', '    found = real_lstat(path, *args, **kw)',
      '    if str(path) == pause and sys._getframe(1).f_code.co_name == "write_json" and not looks:', '        looks.append(1)',
      '        open(pause + ".a", "w").write("foreign file A\\n")', '        os.replace(pause + ".a", pause)',
      '    return found',
      'class Library:', '    def __init__(self, library):', '        self.library = library',
      '    def renameat2(self, *args):', '        if os.fsdecode(args[3]) != pause:', '            return self.library.renameat2(*args)', '        calls.append(1)', '        return self.library.renameat2(*args) if len(calls) == 1 else -1',
      'os.lstat, ctypes.CDLL = swap, lambda *args, **kw: Library(real_cdll(*args, **kw))', 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const r = runPyCode(driver, [f.pause, GUARD, ...guardArgs(f, ['--once'])]);
    const kept = readdirSync(f.dir).filter((n) => n.endsWith('.tmp'));
    expect(kept, 'the file that came in is kept under the temporary name').toHaveLength(1);
    expect(readText(join(f.dir, kept[0])), 'with its content').toBe('foreign file A\n');
    expect(r.stdout, `${r.stdout}${r.stderr}`).toMatch(/ERROR: tick failed.*exchange back failed.*kept as .*\.tmp.*new file is in place at/);
    expect(r.stdout, 'the message names the file that is kept').toContain(join(f.dir, kept[0]));
    expect(readText(f.log), 'the log names it too').toContain(kept[0]);
    expect(readJson(f.pause).valid_until, 'the new pause is at the path: the path is never empty').toBeGreaterThan(before);
  });

  it('where hard links are not supported a foreign file that takes the place of the reservation after the check of its identity, right before the pause is put in place, is kept: the write fails and nothing is lost', () => {
    const driver = ['import errno, os, runpy, sys', 'target, real, looks = sys.argv[1], os.lstat, []',
      'def nolink(a, b, *args, **kw):', '    raise OSError(errno.EPERM, "Operation not permitted")',
      'def swap(path, *args, **kw):', '    found = real(path, *args, **kw)',
      '    if str(path) == target and sys._getframe(1).f_code.co_name == "write_json" and not looks:', '        looks.append(1)',
      '        os.unlink(target)', '        open(target, "w").write("foreign file\\n")',
      '    return found',
      'os.link, os.lstat = nolink, swap', 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const f = fixture('no-link-late-reservation-swap', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const r = runPyCode(driver, [f.pause, GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.stdout, `${r.stdout}${r.stderr}`).toMatch(/ERROR: tick failed.*changed since it was validated and is not replaced/);
    expect(readText(f.pause), 'the foreign file that came in at the last moment is not replaced').toBe('foreign file\n');
    expect(readdirSync(f.dir).filter((n) => n.endsWith('.tmp')), 'no temporary file is left').toEqual([]);
  });

  it('a pause file that is swapped for a foreign file after the last look is not removed: the path is moved aside, found to be another file and put back', () => {
    const f = fixture('unlink-swap', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.state, JSON.stringify({ paused: true, since: now() - 700, resume_at: now() - 10 }), 'utf8');
    writePause(f, { pid: deadPid() });
    // the swap follows the second look of unpublish() (the one that compares the file with the first look); the removal comes after it
    const driver = ['import os, runpy, sys', 'real, pause, looks = os.lstat, sys.argv[1], []',
      'def swap(path, *args, **kw):', '    found = real(path, *args, **kw)',
      '    if str(path) == pause and sys._getframe(1).f_code.co_name == "unpublish":', '        looks.append(1)',
      '        if len(looks) == 2:', '            open(pause + ".foreign", "w").write("foreign file\\n")', '            os.replace(pause + ".foreign", pause)',
      '    return found',
      'os.lstat = swap', 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const r = runPyCode(driver, [f.pause, GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout, 'it is told that the file is not a pause of this guard').toMatch(/is not a pause file of this guard any more: left alone/);
    expect(readText(f.pause), 'the foreign file is where it was').toBe('foreign file\n');
    expect(readdirSync(f.dir).filter((n) => n.endsWith('.gone')), 'nothing is left aside').toEqual([]);
    expect(readJson(f.state).paused, 'the pause itself is over').toBe(false);
  });

  it('a file kept aside by one removal is never replaced by the quarantine of a later one: the name it is moved to is new every time', () => {
    const f = fixture('quarantine-names', {});
    // first removal: a foreign file takes the place after the last look, and another one is at the path again when the first is to be put back,
    // so the first is kept under its quarantine name; second removal: an ordinary one, in the same process
    const driver = ['import os, runpy, sys, time', 'guard, pause = sys.argv[1], sys.argv[2]', 'sys.argv = [guard] + sys.argv[3:]',
      'g = runpy.run_path(guard, run_name="guard_functions")', 'real_lstat, real_rename, looks = os.lstat, os.rename, []',
      'def swap(path, *args, **kw):', '    found = real_lstat(path, *args, **kw)',
      '    if str(path) == pause and sys._getframe(1).f_code.co_name == "unpublish":', '        looks.append(1)',
      '        if len(looks) == 2:', '            open(pause + ".x", "w").write("foreign one\\n")', '            os.replace(pause + ".x", pause)',
      '    return found',
      'def occupy(src, dst, *args, **kw):', '    real_rename(src, dst, *args, **kw)', '    if str(src) == pause and len(looks) == 2:', '        open(pause, "w").write("foreign two\\n")',
      'os.lstat, os.rename = swap, occupy', 'state = {"since": time.time(), "resume_at": time.time() + 60}',
      'g["publish"](state)', 'g["unpublish"]()', 'os.remove(pause)', 'g["publish"](state)', 'g["unpublish"]()'].join('\n');
    const r = runPyCode(driver, [GUARD, f.pause, ...guardArgs(f, ['--once'])]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout, 'the first file is reported as kept').toMatch(/is not a pause file of this guard and is kept as .*\.gone/);
    const kept = readdirSync(f.dir).filter((n) => n.endsWith('.gone'));
    expect(kept, 'the file kept by the first removal is still there').toHaveLength(1);
    expect(readText(join(f.dir, kept[0])), 'with its content').toBe('foreign one\n');
    expect(existsSync(f.pause), 'the second removal removed its pause').toBe(false);
  });

  it('where hard links are not supported a file that appears at pause_file is still never replaced, and without one the pause is published with nothing left behind', () => {
    const driver = ['import errno, os, runpy, sys', 'target = sys.argv[1]', 'foreign = sys.argv[2] == "1"',
      'def nolink(a, b, *args, **kw):', '    if foreign and b == target: open(b, "w").write("late foreign file\\n")', '    raise OSError(errno.EPERM, "Operation not permitted")',
      'os.link = nolink', 'sys.argv = sys.argv[3:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const race = fixture('foreign-no-link', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const r = runPyCode(driver, [race.pause, '1', GUARD, ...guardArgs(race, ['--once'])]);
    expect(r.stdout).toMatch(/ERROR: tick failed.*appeared meanwhile/);
    expect(readText(race.pause), 'the file that appeared is not replaced').toBe('late foreign file\n');

    const clean = fixture('no-link', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const ok = runPyCode(driver, [clean.pause, '0', GUARD, ...guardArgs(clean, ['--once'])]);
    expect(ok.status, `${ok.stdout}${ok.stderr}`).toBe(0);
    expect(readJson(clean.pause).paused, 'the pause is published').toBe(true);
    expect(readdirSync(clean.dir).filter((n) => n.endsWith('.tmp')), 'no temporary file is left').toEqual([]);
  });

  it('where hard links are not supported a file that takes the place of the reservation of the destination, before the pause is moved over it, is kept: the write fails and nothing is lost', () => {
    // the reservation (an empty file made exclusively) is removed and a foreign file put in its place right after it was made
    const driver = ['import errno, os, runpy, sys', 'target, real = sys.argv[1], os.open',
      'def nolink(a, b, *args, **kw):', '    raise OSError(errno.EPERM, "Operation not permitted")',
      'def swapped(path, flags, *args, **kw):', '    fd = real(path, flags, *args, **kw)',
      '    if str(path) == target and flags & os.O_EXCL:', '        os.unlink(target)', '        open(target, "w").write("foreign file\\n")',
      '    return fd',
      'os.link, os.open = nolink, swapped', 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const f = fixture('no-link-swapped-reservation', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const r = runPyCode(driver, [f.pause, GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.stdout, `${r.stdout}${r.stderr}`).toMatch(/ERROR: tick failed.*appeared meanwhile/);
    expect(readText(f.pause), 'the foreign file that took the place of the reservation is not replaced').toBe('foreign file\n');
    expect(readdirSync(f.dir).filter((n) => n.endsWith('.tmp')), 'no temporary file is left').toEqual([]);
  });

  it('where hard links are not supported and the pause cannot be put in place, the reservation is removed only while it is still the reservation: a foreign file that takes its place in the last moment before the removal is kept', () => {
    // the cleanup that follows a failed publication looks at the path (the second look of write_json: the first is the check of the reservation) and then takes the reservation away; the foreign file comes in right after that look
    // there is no exchange either, so the pause would be put in place by a plain replace: that is refused too, so that the publication fails after the reservation was made
    const driver = ['import ctypes, errno, os, runpy, sys', 'target, late, real_lstat, real_link, real_replace, real_cdll, looks = sys.argv[1], sys.argv[2] == "1", os.lstat, os.link, os.replace, ctypes.CDLL, []',
      'def nolink(a, b, *args, **kw):', '    if str(b) != target:', '        return real_link(a, b, *args, **kw)', '    raise OSError(errno.EPERM, "Operation not permitted")',
      'def noreplace(a, b, *args, **kw):', '    if str(b) != target:', '        return real_replace(a, b, *args, **kw)', '    raise OSError(errno.EPERM, "the file cannot be put in place")',
      'class NoSwap:', '    def __init__(self, library):', '        self.library = library',
      '    def renameat2(self, *args):', '        return -1 if os.fsdecode(args[3]) == target else self.library.renameat2(*args)',
      'def none(*args, **kw):', '    return NoSwap(real_cdll(*args, **kw))',
      'def look(path, *args, **kw):', '    found = real_lstat(path, *args, **kw)',
      '    if str(path) == target and sys._getframe(1).f_code.co_name == "write_json":', '        looks.append(1)', '        if late and len(looks) == 2:', '            os.unlink(target)', '            open(target, "w").write("foreign file\\n")',
      '    return found',
      'os.link, os.lstat, os.replace, ctypes.CDLL = nolink, look, noreplace, none', 'sys.argv = sys.argv[3:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const f = fixture('no-link-reservation-cleanup-swap', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const r = runPyCode(driver, [f.pause, '1', GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.stdout, `${r.stdout}${r.stderr}`).toMatch(/ERROR: tick failed.*cannot be put in place/);
    const left = [f.pause, ...readdirSync(f.dir).filter((n) => n.endsWith('.gone')).map((n) => join(f.dir, n))].filter((n) => existsSync(n));
    expect(left.map((n) => readText(n)), 'the foreign file that took the place of the reservation is still there, at the path or under its new name').toEqual(['foreign file\n']);
    expect(r.stdout, 'and the log says where it is').toMatch(/is not the reservation and is kept as .*\.gone/);
    expect(readdirSync(f.dir).filter((n) => n.endsWith('.tmp')), 'no temporary file is left').toEqual([]);
    // the same failure with nobody coming in: the reservation is removed, and nothing is left behind
    const g = fixture('no-link-reservation-cleanup-clean', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const clean = runPyCode(driver, [g.pause, '0', GUARD, ...guardArgs(g, ['--once'])]);
    expect(clean.stdout, `${clean.stdout}${clean.stderr}`).toMatch(/ERROR: tick failed.*cannot be put in place/);
    expect(existsSync(g.pause), 'the reservation is removed').toBe(false);
    expect(readdirSync(g.dir).filter((n) => n.endsWith('.gone') || n.endsWith('.tmp')), 'nothing is left aside').toEqual([]);
  });

  it('where hard links are not supported a foreign file that was moved aside by the removal of a pause is kept under its new name, whether the path is free or another file is there again, and also where a rename back would be refused: no rename puts it back', () => {
    // the foreign file takes the place after the last look of unpublish(), as in the test of the swap; the other runs put another file at the path after the move aside, or refuse the rename back
    const driver = ['import errno, os, runpy, sys', 'real_lstat, real_rename, pause, mode, looks = os.lstat, os.rename, sys.argv[1], sys.argv[2], []',
      'def nolink(a, b, *args, **kw):', '    raise OSError(errno.EPERM, "Operation not permitted")',
      'def swap(path, *args, **kw):', '    found = real_lstat(path, *args, **kw)',
      '    if str(path) == pause and sys._getframe(1).f_code.co_name == "unpublish":', '        looks.append(1)',
      '        if len(looks) == 2:', '            open(pause + ".foreign", "w").write("foreign one\\n")', '            os.replace(pause + ".foreign", pause)',
      '    return found',
      'def moved(src, dst, *args, **kw):', '    if mode == "refused" and str(dst) == pause and str(src).endswith(".gone"):', '        raise OSError(errno.EACCES, "Permission denied")',
      '    real_rename(src, dst, *args, **kw)',
      '    if mode == "occupied" and str(src) == pause and str(dst).endswith(".gone"):', '        open(pause, "w").write("foreign two\\n")',
      'os.link, os.lstat, os.rename = nolink, swap, moved', 'sys.argv = sys.argv[3:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    for (const mode of ['free', 'occupied', 'refused']) {
      const f = fixture(`no-link-unlink-swap-${mode}`, { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
      writeFileSync(f.state, JSON.stringify({ paused: true, since: now() - 700, resume_at: now() - 10 }), 'utf8');
      writePause(f, { pid: deadPid() });
      const r = runPyCode(driver, [f.pause, mode, GUARD, ...guardArgs(f, ['--once'])]);
      const kept = readdirSync(f.dir).filter((n) => n.endsWith('.gone'));
      expect(r.status, `${mode}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout, `${mode}: it is told that the file is not a pause of this guard`).toMatch(/is not a pause file of this guard any more: left alone/);
      expect(r.stdout, `${mode}: the file that was moved aside is reported as kept`).toMatch(/is not a pause file of this guard and is kept as .*\.gone/);
      expect(kept, `${mode}: the file that was moved aside is still there`).toHaveLength(1);
      expect(readText(join(f.dir, kept[0])), `${mode}: with its content`).toBe('foreign one\n');
      if (mode === 'occupied') expect(readText(f.pause), 'the file that is at the path is not replaced').toBe('foreign two\n');
      else expect(existsSync(f.pause), `${mode}: the path stays empty`).toBe(false);
      expect(readJson(f.state).paused, `${mode}: the pause itself is over`).toBe(false);
    }
  });

  it('where hard links are not supported a file that arrives at pause_file in the gap after the path was seen to be free is never replaced: the foreign file that was moved aside stays under its new name, and no rename of it over the pause path is made', () => {
    // the foreign file takes the place after the last look of unpublish(), as in the test of the swap; a third file arrives the instant after the check that the path is free (the check that the old code made before it renamed the file back)
    const driver = ['import errno, os, runpy, sys', 'real_lstat, real_rename, real_lexists, pause, looks = os.lstat, os.rename, os.path.lexists, sys.argv[1], []',
      'def nolink(a, b, *args, **kw):', '    raise OSError(errno.EPERM, "Operation not permitted")',
      'def swap(path, *args, **kw):', '    found = real_lstat(path, *args, **kw)',
      '    if str(path) == pause and sys._getframe(1).f_code.co_name == "unpublish":', '        looks.append(1)',
      '        if len(looks) == 2:', '            open(pause + ".foreign", "w").write("foreign one\\n")', '            os.replace(pause + ".foreign", pause)',
      '    return found',
      'def gap(path):', '    found = real_lexists(path)',
      '    if str(path) == pause and not found and sys._getframe(1).f_code.co_name == "unpublish":', '        open(pause, "w").write("late arrival\\n")',
      '    return found',
      'def moved(src, dst, *args, **kw):', '    if str(dst) == pause and str(src).endswith(".gone"):', '        open(pause + ".attempt", "w").write("a quarantined file is renamed over the pause path")',
      '    real_rename(src, dst, *args, **kw)',
      'os.link, os.lstat, os.rename, os.path.lexists = nolink, swap, moved, gap', 'sys.argv = sys.argv[2:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const f = fixture('no-link-unlink-gap', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.state, JSON.stringify({ paused: true, since: now() - 700, resume_at: now() - 10 }), 'utf8');
    writePause(f, { pid: deadPid() });
    const r = runPyCode(driver, [f.pause, GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(existsSync(`${f.pause}.attempt`), 'no rename of the quarantined file over the pause path is made').toBe(false);
    if (existsSync(f.pause)) expect(readText(f.pause), 'a file that arrives at the path is not replaced').toBe('late arrival\n');
    const kept = readdirSync(f.dir).filter((n) => n.endsWith('.gone'));
    expect(r.stdout, 'the file that was moved aside is reported as kept').toMatch(/is not a pause file of this guard and is kept as .*\.gone/);
    expect(kept, 'the file that was moved aside is still there').toHaveLength(1);
    expect(readText(join(f.dir, kept[0])), 'with its content').toBe('foreign one\n');
    expect(readJson(f.state).paused, 'the pause itself is over').toBe(false);
  });

  it('a link at pause_file that appeared after the start is never replaced, also when its target holds a valid pause document', async () => {
    const f = fixture('link-valid-target', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const target = join(f.dir, 'target-pause.json');
    writeFileSync(target, JSON.stringify({ v: 2, paused: true, since: now() - 5, resume_at: now() + 600, valid_until: now() + 60, exclude: [], percent: 97, pid: 1 }), 'utf8');
    const before = readText(target);
    const g = startGuard(f);
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start');
      symlinkSync(target, f.pause);
      writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => /ERROR: tick failed.*is not a pause file of this guard/.test(readText(f.log)), 20000, 'the refusal');
    } finally { await stopGuard(g); }
    expect(lstatSync(f.pause).isSymbolicLink(), 'the link is still there').toBe(true);
    expect(readText(target), 'the target is intact').toBe(before);
    expect(existsSync(f.state) ? readJson(f.state).paused : false, 'no pause was stored').toBe(false);
  });

  it('a regular pause file that is swapped for a link between the first look and the read is not read through the link, by the guard either', () => {
    const f = fixture('guard-swap-to-link', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const target = join(f.dir, 'foreign-pause.json');
    writeFileSync(target, JSON.stringify(pauseDoc({ pid: process.pid })), 'utf8');
    const before = readText(target);
    writePause(f, { pid: process.pid });
    // the first look at the file inside is_guard_pause() is followed by the swap
    const driver = ['import os, runpy, sys', 'real = os.lstat', 'pause, target = sys.argv[1], sys.argv[2]', 'done = []',
      'def swap(path, *args, **kw):', '    found = real(path, *args, **kw)',
      '    if str(path) == pause and not done and sys._getframe(1).f_code.co_name == "is_guard_pause":',
      '        done.append(1)', '        os.unlink(pause)', '        os.symlink(target, pause)',
      '    return found',
      'os.lstat = swap', 'sys.argv = sys.argv[3:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const r = runPyCode(driver, [f.pause, target, GUARD, ...guardArgs(f, ['--once'])]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr, 'refused at the first look: the file is not a pause file of this guard').toMatch(/exists and is not a pause file of this guard/);
    expect(lstatSync(f.pause).isSymbolicLink(), 'the link is still there').toBe(true);
    expect(readText(target), 'the target is intact').toBe(before);
  });

  it('an entry that is not an object, or a group that is not, does not hide the entries after it from the start check', () => {
    const f = fixture('alias-after-non-object', { cache: { pct: 99, resetMs: Date.now() + HOUR_MS } });
    const dir = join(f.dir, 'custom');
    mkdirSync(dir, { recursive: true });
    const hook = join(dir, 'five-hour-guard-hook.py');
    copyFileSync(HOOK, hook);
    const hookText = readFileSync(hook, 'utf8');
    const valid = { type: 'command', command: generatedCommand(f.pause, hook, PYBIN), timeout: 21600 };
    const layouts: unknown[] = [
      [{ matcher: '*', hooks: [5, null, 'text', valid] }],
      ['text', 7, null, { matcher: '*', hooks: [valid] }],
      [{ matcher: '*', hooks: 'text' }, { matcher: '*', hooks: [valid] }],
    ];
    for (const [i, groups] of layouts.entries()) {
      writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: groups } }), 'utf8');
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: hook, log_file: f.log, settings_file: f.settings }), 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.status, `layout ${i}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/are the same file/);
      expect(readFileSync(hook, 'utf8'), 'the registered hook is intact').toBe(hookText);
    }
  });

  it('a hook log that is the program of another recognised entry is reported, whichever entry comes first', async () => {
    const f = fixture('wiring-log-cross-entry', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const dir = join(f.dir, 'custom');
    mkdirSync(dir, { recursive: true });
    const hook = join(dir, 'five-hour-guard-hook.py');
    copyFileSync(HOOK, hook);
    const hookBefore = readFileSync(hook, 'utf8');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const entry = (...commands: string[]) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: commands.map((command) => ({ type: 'command', command, timeout: 21600 })) }] } });
    const plain = generatedCommand(f.pause, HOOK, PYBIN);
    const logging = generatedCommand(f.pause, hook, PYBIN, HOOK);   // its log is the bundled hook, which the other entry runs
    const g = startGuard(f, ['--warn-every', '1']);
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start');
      writeFileSync(f.settings, entry(logging, plain), 'utf8');
      writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => /names .*five-hour-guard-hook\.py, which is the (hook script|registered hook) of this guard/.test(readText(f.log)), 20000, 'the cross-entry alias warning');
    } finally { await stopGuard(g); }
    expect(readFileSync(hook, 'utf8')).toBe(hookBefore);
  });

  it('no pause is published while the hook log of a registered entry, put there by a settings rewrite after the start, is a file of the guard or a program: the hook would append to it', async () => {
    for (const [name, label] of [['state', 'state_file'], ['pause', 'pause_file'], ['program', 'program of another hook'], ['cache', 'usage_cache']]) {
      const f = fixture(`hook-log-refuses-${name}`, { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
      const audit = join(f.dir, 'audit');   // run by another hook of the settings
      writeFileSync(audit, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const target = { state: f.state, pause: f.pause, program: audit, cache: f.cache }[name] as string;
      writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
      const settings = (log?: string) => JSON.stringify({ hooks: { PreToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN, log), timeout: 21600 }] }, { matcher: 'Bash', hooks: [{ type: 'command', command: audit }] }] } });
      writeFileSync(f.settings, settings(), 'utf8');
      const before = name === 'cache' ? null : existsSync(target) ? readText(target) : null;   // (the usage cache is rewritten by the test itself)
      const g = startGuard(f, ['--warn-every', '1']);
      try {
        await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start');
        writeFileSync(f.settings, settings(target), 'utf8');
        writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
        await waitFor(() => new RegExp(`ERROR: tick failed.*names .*, which is the ${label} of this guard`).test(readText(f.log)), 20000, `the refusal (${name})`);
        await sleep(600);   // a few more ticks
        expect(existsSync(f.pause), `${name}: no pause was published`).toBe(false);
        expect(existsSync(f.state) ? readJson(f.state).paused : false, `${name}: no pause was stored`).toBe(false);
        writeFileSync(f.settings, settings(), 'utf8');   // a session that loaded the rewritten entry keeps appending to that log until it is restarted: the refusal stays too
        await sleep(800);
        expect(existsSync(f.pause), `${name}: still no pause after the entry was put right`).toBe(false);
      } finally { await stopGuard(g); }
      if (name !== 'cache') expect(existsSync(target) ? readText(target) : null, `${name}: the file is as it was`).toBe(before);
    }
  });

  it('a pause that is in force is not renewed once the hook log of a registered entry has become a file of the guard: the heartbeat is not extended', async () => {
    const f = fixture('hook-log-refuses-renewal', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const settings = (log?: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN, log), timeout: 21600 }] }] } });
    writeFileSync(f.settings, settings(), 'utf8');
    const g = startGuard(f, ['--warn-every', '1']);
    try {
      await waitFor(() => existsSync(f.pause), 20000, 'the pause');
      writeFileSync(f.settings, settings(f.state), 'utf8');
      await waitFor(() => /ERROR: tick failed.*the registered hook log .*state\.json is .*state\.json, a file this guard writes/.test(readText(f.log)), 20000, 'the refusal of a renewal');
      const seen = readJson(f.pause).valid_until;
      await sleep(1000);   // five ticks
      expect(readJson(f.pause).valid_until, 'the heartbeat of the pause is not extended').toBe(seen);
    } finally { await stopGuard(g); }
  });

  it('lock files that were removed and created again under a running guard are locked again by it, and a guard that finds another one on the new files stops without publishing or removing a pause', async () => {
    const f = fixture('lock-files-replaced', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const locks = [`${f.state}.lock`, `${f.pause}.lock`];
    const replace = () => { for (const lock of locks) { rmSync(lock); writeFileSync(lock, '', 'utf8'); } };
    const first = startGuard(f);
    let second: Proc | undefined;
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start of the first guard');
      // nobody else is there: the guard takes the new files and goes on, here into a pause
      replace();
      writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => existsSync(f.pause) && readJson(f.pause).pid === first.child.pid, 20000, 'the pause of the first guard');
      expect(first.exited, 'the first guard keeps running').toBe(false);
      // the first guard cannot look while it is stopped: another guard takes the new files and goes on with the pause
      first.child.kill('SIGSTOP');
      replace();
      second = startGuard(f);
      await waitFor(() => existsSync(f.pause) && readJson(f.pause).pid === second?.child.pid, 20000, 'the pause of the second guard');
      first.child.kill('SIGCONT');
      await Promise.race([first.done, sleep(10000)]);
      expect(first.exited, 'the first guard stopped').toBe(true);
      expect(first.code, 'it exits with an error, so that a service manager starts it again').toBe(1);
      expect(readText(f.log)).toMatch(/ERROR: a lock file of this guard was removed or replaced and another guard holds the new one/);
      await sleep(600);
      expect(readJson(f.pause).pid, 'the pause of the second guard is still there, not removed by the first').toBe(second.child.pid);
    } finally {
      await stopGuard(first);
      if (second) await stopGuard(second);
    }
  });

  it('a guard that gets SIGTERM before it has looked at its lock files again leaves the pause and the state of the guard that holds the new files alone', async () => {
    const f = fixture('lock-files-replaced-signal', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const locks = [`${f.state}.lock`, `${f.pause}.lock`];
    const replace = () => { for (const lock of locks) { rmSync(lock); writeFileSync(lock, '', 'utf8'); } };
    const first = startGuard(f);
    let second: Proc | undefined;
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start of the first guard');
      writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => existsSync(f.pause) && readJson(f.pause).pid === first.child.pid, 20000, 'the pause of the first guard');
      first.child.kill('SIGSTOP');
      replace();
      second = startGuard(f);
      await waitFor(() => existsSync(f.pause) && readJson(f.pause).pid === second?.child.pid, 20000, 'the pause of the second guard');
      // the signal is delivered when the first guard runs again, before its next tick: only the cleanup on the way out can still look at the locks
      first.child.kill('SIGTERM');
      first.child.kill('SIGCONT');
      await Promise.race([first.done, sleep(10000)]);
      expect(first.exited, 'the first guard stopped').toBe(true);
      expect(first.code, 'it exits with an error, so that a service manager starts it again').toBe(1);
      expect(readText(f.log)).toMatch(/ERROR: a lock file of this guard was removed or replaced and another guard holds the new one/);
      expect(readJson(f.pause).pid, 'the pause of the second guard is still there, not removed by the first').toBe(second.child.pid);
      expect(readJson(f.state).paused, 'the state of the second guard is still paused, not stored as resumed by the first').toBe(true);
    } finally {
      await stopGuard(first);
      if (second) await stopGuard(second);
    }
  });

  it('a guard that gets SIGTERM while one of its lock files cannot be looked at still looks at the others: the pause of the guard that holds a new lock is kept, and without another guard the pause is taken down as before', async () => {
    const f = fixture('lock-directory-gone-signal', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const config = (cfg: string, state: string) => writeFileSync(cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const stateDir = join(f.dir, 'state-of-a');
    const cfgB = join(f.dir, 'config-b.json');
    mkdirSync(stateDir);
    config(f.cfg, join(stateDir, 'state.json'));
    config(cfgB, f.state);   // another state file, the same pause file: one pause lock for both
    const first = startGuard(f);
    let second: Proc | undefined;
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start of the first guard');
      writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => existsSync(f.pause) && readJson(f.pause).pid === first.child.pid, 20000, 'the pause of the first guard');
      first.child.kill('SIGSTOP');
      rmSync(stateDir, { recursive: true });   // its first lock cannot be looked at now
      rmSync(`${f.pause}.lock`);
      second = startGuard({ ...f, cfg: cfgB });
      await waitFor(() => existsSync(f.pause) && readJson(f.pause).pid === second?.child.pid, 20000, 'the pause of the second guard');
      first.child.kill('SIGTERM');
      first.child.kill('SIGCONT');
      await Promise.race([first.done, sleep(10000)]);
      expect(first.exited, 'the first guard stopped').toBe(true);
      expect(first.code, 'it exits with an error, so that a service manager starts it again').toBe(1);
      expect(readText(f.log)).toMatch(/ERROR: a lock file of this guard was removed or replaced and another guard holds the new one/);
      expect(readJson(f.pause).pid, 'the pause of the second guard is still there, not removed by the first').toBe(second.child.pid);
    } finally {
      await stopGuard(first);
      if (second) await stopGuard(second);
    }
    // alone, with its state directory gone, the guard takes its pause down on SIGTERM (the sessions do not wait for the end of it)
    const g = fixture('lock-directory-gone-alone', { cache: { pct: 98, resetMs: Date.now() + HOUR_MS } });
    const dir = join(g.dir, 'state-of-a');
    mkdirSync(dir);
    writeFileSync(g.cfg, JSON.stringify({ usage_cache: g.cache, pause_file: g.pause, state_file: join(dir, 'state.json'), log_file: g.log, settings_file: g.settings }), 'utf8');
    const alone = startGuard(g);
    try {
      await waitFor(() => existsSync(g.pause) && readJson(g.pause).pid === alone.child.pid, 20000, 'the pause of the single guard');
      rmSync(dir, { recursive: true });
      alone.child.kill('SIGTERM');
      await Promise.race([alone.done, sleep(10000)]);
      expect(alone.exited, 'the single guard stopped').toBe(true);
      expect(existsSync(g.pause), 'its pause is taken down').toBe(false);
    } finally { await stopGuard(alone); }
  });

  it('a guard whose tick is held up in the read of the usage cache, after it looked at its lock files, looks at them again before it leaves the pause: the state and the pause of the guard that holds the new lock files are left alone', async () => {
    const f = fixture('lock-files-replaced-in-tick', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    const cacheB = join(f.dir, 'usage-cache-b.json');
    const cacheLow = join(f.dir, 'usage-cache-low.json');
    const cfgB = join(f.dir, 'config-b.json');
    const config = (cfg: string, cache: string) => writeFileSync(cfg, JSON.stringify({ usage_cache: cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    config(f.cfg, f.cache);
    config(cfgB, cacheB);   // the second guard reads a cache of its own: the first one is held up on the file of the first
    writeCache({ ...f, cache: cacheB }, { pct: 98, resetMs: Date.now() + HOUR_MS });
    const locks = [`${f.state}.lock`, `${f.pause}.lock`];
    const replace = () => { for (const lock of locks) { rmSync(lock); writeFileSync(lock, '', 'utf8'); } };
    const first = startGuard(f);
    let second: Proc | undefined;
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start of the first guard');
      writeCache(f, { pct: 98, resetMs: Date.now() + HOUR_MS });
      await waitFor(() => existsSync(f.pause) && readJson(f.pause).pid === first.child.pid, 20000, 'the pause of the first guard');
      // the cache is a named pipe now: the next tick of the first guard looks at its locks, then waits in the open of the cache until somebody writes to it
      rmSync(f.cache);
      expect(spawnSync('mkfifo', [f.cache]).status, 'mkfifo').toBe(0);
      let beat = -1;
      let since = Date.now();
      await waitFor(() => {
        const seen = readJson(f.pause).valid_until;
        if (seen !== beat) { beat = seen; since = Date.now(); return false; }
        return Date.now() - since > 1500;
      }, 20000, 'the first guard waiting in the read of the cache (its heartbeat stands still)');
      replace();
      second = startGuard({ ...f, cfg: cfgB });
      await waitFor(() => existsSync(f.pause) && readJson(f.pause).pid === second?.child.pid, 20000, 'the pause of the second guard');
      // the first guard goes on: the window is over in its cache, so it leaves the pause, and its locks are not the ones that are held now
      writeCache({ ...f, cache: cacheLow }, { pct: 5, resetMs: Date.now() + HOUR_MS });
      writeFileSync(f.cache, readFileSync(cacheLow));
      await Promise.race([first.done, sleep(10000)]);
      expect(first.exited, 'the first guard stopped').toBe(true);
      expect(first.code, 'it exits with an error, so that a service manager starts it again').toBe(1);
      const log = readText(f.log);
      expect(log, 'it saw that the locks were lost before it wrote or removed anything').toMatch(/ERROR: tick failed.*a lock file of this guard was removed or replaced and another guard holds the new one: no state is written and no pause is removed/);
      expect(log, 'it did not leave the pause of the second guard').not.toMatch(/RESUMED \(window reset seen early/);
      await sleep(600);
      expect(readJson(f.pause).pid, 'the pause of the second guard is still there').toBe(second.child.pid);
    } finally {
      try { closeSync(openSync(f.cache, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK)); } catch { /* nobody waits in the open of the pipe */ }
      await stopGuard(first);
      if (second) await stopGuard(second);
    }
  });

  it('a timeout that is NaN or Infinity (raw tokens that Python reads and standard JSON does not) is a wiring problem, like a missing one', () => {
    const f = fixture('wiring-timeout-nonfinite', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const command = generatedCommand(f.pause, HOOK, PYBIN);
    for (const token of ['NaN', 'Infinity', '-Infinity']) {
      writeFileSync(f.settings, `{"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": ${JSON.stringify(command)}, "timeout": ${token}}]}]}}`, 'utf8');
      const r = runSync(GUARD, ['--config', f.cfg, '--once']);
      expect(r.stdout, token).toMatch(/WARNING \(start\): the hook entry in .*: its timeout \(.*\) is missing, not a finite number or below 21600 s/);
    }
  });

  it('the hook entry check warns when the group matcher no longer covers every tool (an entry for Bash only), and accepts "*", empty and none', () => {
    const f = fixture('matcher-drift', { cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const command = generatedCommand(f.pause, HOOK, PYBIN);
    const group = (matcher?: string) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command, timeout: 21600 }] });
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
    copyFileSync(ENTRY_MODULE, join(dir, 'five_hour_guard_entry.py'));
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
    const code = ['import os, runpy, sys', 'real = os.rename',
      'def deny(p, *a, **k):', '    if str(p).endswith("pause.json"): raise PermissionError(13, "denied")', '    return real(p, *a, **k)',
      'os.rename = deny', 'sys.argv = sys.argv[1:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
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

  it('hook entry check: a loud warning when settings.json has no hook entry; the generated entry is silent', () => {
    const f = fixture('hook-check', { config: {}, cache: { pct: 50, resetMs: Date.now() + HOUR_MS } });
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings }), 'utf8');
    const entry = (command: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } });
    writeFileSync(f.settings, JSON.stringify({ hooks: {} }), 'utf8');
    expect(guardOnce(f).stdout).toMatch(/WARNING \(start\): hook five-hour-guard-hook\.py is NOT registered/);
    writeFileSync(f.settings, entry(generatedCommand(f.pause, HOOK, PYBIN)), 'utf8');
    expect(guardOnce(f).stdout, 'an entry whose hook file exists: no warning').not.toMatch(/WARNING/);
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

  it('a Bedrock or Vertex session (routing flag, no base URL) passes; the flag set to anything but 1 or true does not exempt', async () => {
    const f = fixture('hook-cloud');
    writePause(f);
    expect(await hookPasses(f, 'other0001', { env: { ...ENV, CLAUDE_CODE_USE_BEDROCK: '1' } }), 'Bedrock flag passes').toBe(true);
    expect(await hookPasses(f, 'other0001', { env: { ...ENV, CLAUDE_CODE_USE_VERTEX: '1' } }), 'Vertex flag passes').toBe(true);
    expect(await hookPasses(f, 'other0001', { env: { ...ENV, CLAUDE_CODE_USE_BEDROCK: 'true' } }), 'the flag as true passes').toBe(true);
    expect(await hookPasses(f, 'other0001', { env: { ...ENV, CLAUDE_CODE_USE_VERTEX: ' TRUE ' } }), 'the flag as TRUE with blanks passes').toBe(true);
    expect(await hookHeld(f, 'other0001', { env: { ...ENV, CLAUDE_CODE_USE_BEDROCK: 'yes', CLAUDE_CODE_USE_VERTEX: 'false' } }), 'other values hold').toBe(true);
    expect(await hookHeld(f, 'other0001', { env: { ...ENV, CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '' } }), 'flags that are off hold').toBe(true);
  });

  it('a Bedrock or Vertex session known only by its model variables passes (the provider rule of src/config/models.ts): the direct model decides, the tier models only when no direct model is set', async () => {
    const f = fixture('hook-provider-model');
    writePause(f);
    const bedrock = 'us.anthropic.claude-sonnet-4-6-v1:0';
    const passes: Array<[string, Record<string, string>]> = [
      ['a Bedrock id in CLAUDE_MODEL', { CLAUDE_MODEL: bedrock }],
      ['a Bedrock id in ANTHROPIC_MODEL', { ANTHROPIC_MODEL: 'global.anthropic.claude-sonnet-4-6-v1:0' }],
      ['the region prefix eu', { CLAUDE_MODEL: 'eu.anthropic.claude-sonnet-4-6-v1:0' }],
      ['the region prefix ap', { CLAUDE_MODEL: 'ap.anthropic.claude-sonnet-4-6-v1:0' }],
      ['the region prefix apac', { CLAUDE_MODEL: 'apac.anthropic.claude-sonnet-4-6-v1:0' }],
      ['no region prefix', { CLAUDE_MODEL: 'anthropic.claude-3-haiku-20240307-v1:0' }],
      ['upper case', { CLAUDE_MODEL: 'US.ANTHROPIC.CLAUDE-SONNET-4-6-V1:0' }],
      ['an inference profile ARN of a Claude model', { CLAUDE_MODEL: 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6-v1:0' }],
      ['an application inference profile ARN in another partition', { ANTHROPIC_MODEL: 'arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:application-inference-profile/claude-profile' }],
      ['a Vertex id', { CLAUDE_MODEL: 'vertex_ai/claude-sonnet-4-6' }],
      ['a Vertex id in upper case', { ANTHROPIC_MODEL: 'VERTEX_AI/claude-sonnet-4-6' }],
      ['a blank CLAUDE_MODEL, the Bedrock id in ANTHROPIC_MODEL', { CLAUDE_MODEL: '   ', ANTHROPIC_MODEL: bedrock }],
      ['an id with blanks around it', { CLAUDE_MODEL: `  ${bedrock}  ` }],
      ['no direct model, the sonnet default of Claude Code is a Bedrock id', { ANTHROPIC_DEFAULT_SONNET_MODEL: bedrock }],
      ['no direct model, OMC_MODEL_HIGH is a Vertex id', { OMC_MODEL_HIGH: 'vertex_ai/claude-opus-4-8' }],
      ['no direct model, the Bedrock haiku variable', { CLAUDE_CODE_BEDROCK_HAIKU_MODEL: 'anthropic.claude-3-haiku-20240307-v1:0' }],
      ['no direct model, medium is Claude and low is a Bedrock id', { OMC_MODEL_MEDIUM: 'claude-sonnet-5', OMC_MODEL_LOW: 'us.anthropic.claude-haiku-4-5-v1:0' }],
    ];
    for (const [name, env] of passes) expect(await hookPasses(f, 'other0001', { env: { ...ENV, ...env } }), `${name}: passes`).toBe(true);
    const holds: Array<[string, Record<string, string>]> = [
      ['a plain Claude id', { CLAUDE_MODEL: 'claude-sonnet-5' }],
      ['a tier alias', { ANTHROPIC_MODEL: 'sonnet' }],
      ['the direct model wins over a stale tier default', { CLAUDE_MODEL: 'claude-sonnet-5', ANTHROPIC_DEFAULT_SONNET_MODEL: bedrock }],
      ['the first direct variable that is not blank wins', { CLAUDE_MODEL: 'claude-opus-4-8', ANTHROPIC_MODEL: bedrock }],
      ['within one tier the first variable wins', { OMC_MODEL_MEDIUM: 'claude-sonnet-5', ANTHROPIC_DEFAULT_SONNET_MODEL: bedrock }],
      ['an id that only contains the words', { CLAUDE_MODEL: 'my-anthropic.claude-gateway' }],
      ['an ARN that is no inference profile', { CLAUDE_MODEL: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0' }],
    ];
    for (const [name, env] of holds) expect(await hookHeld(f, 'other0001', { env: { ...ENV, ...env } }), `${name}: held`).toBe(true);
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

  it('a large --poll is capped: a held call is released within seconds of the removal of the pause file and of the lapse of valid_until, not after the hour the option asks for', async () => {
    const heldBy = async (name: string, poll: string, over: Record<string, unknown> = {}) => {
      const f = fixture(name);
      writePause(f, over);
      const log = join(f.dir, 'hook-poll.log');
      const h = spawnPy(HOOK, ['--pause-file', f.pause, '--log', log, '--poll', poll], { input: hookInput('other0001') });
      await waitFor(() => /hold-start/.test(readText(log)) || h.exited, 20000, 'hold-start');
      expect(h.exited, `--poll ${poll}: held`).toBe(false);
      return { f, h };
    };
    for (const poll of ['3600', '1e300']) {   // a finite hour, and a finite number far beyond any pause
      const { f, h } = await heldBy(`hook-poll-cap-removed-${poll}`, poll);
      unlinkSync(f.pause);
      await Promise.race([h.done, sleep(25000)]);
      expect(h.exited && h.code === 0, `--poll ${poll}: released within seconds of the removal of the pause file`).toBe(true);
      await h.stop();
    }
    const lapsing = await heldBy('hook-poll-cap-lapsed', '3600', { valid_until: now() + 4 });   // nobody renews it: the guard is dead
    await Promise.race([lapsing.h.done, sleep(25000)]);
    expect(lapsing.h.exited && lapsing.h.code === 0, '--poll 3600: released within seconds of the lapse of valid_until').toBe(true);
    await lapsing.h.stop();
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
    for (const line of ['Type=simple', 'Restart=on-failure', 'RestartSec=10s', 'RestartPreventExitStatus=2', 'WantedBy=default.target', 'ExecStart="/usr/bin/python3" -I "/opt/x/five-hour-guard.py" --config "/etc/x.json"']) {
      expect(lines.includes(line), line).toBe(true);
    }
    // a path with a space is one argument of the command line, which systemd splits on whitespace outside quotes
    const spaced = body.replace(/@PYTHON_BIN@/g, '/opt/my tools/bin/python3').replace(/@INSTALL_DIR@/g, '/opt/my tools/guard').replace(/@CONFIG_FILE@/g, '/etc/my tools/x.json');
    const execStart = spaced.split('\n').find((l) => l.startsWith('ExecStart=')) ?? '';
    const argv = Array.from(execStart.slice('ExecStart='.length).matchAll(/"([^"]*)"|(\S+)/g), (m) => m[1] ?? m[2]);
    expect(argv, 'the executable, the script and the configuration file are one argument each').toEqual(['/opt/my tools/bin/python3', '-I', '/opt/my tools/guard/five-hour-guard.py', '--config', '/etc/my tools/x.json']);
  });
});

// helpers of the describe blocks below
const PROGRAM_TEXT = '#!/bin/sh\necho a program of another tool\n';
const guardEntry = (f: Fixture) => ({ matcher: '*', hooks: [{ type: 'command', command: generatedCommand(f.pause, HOOK, PYBIN), timeout: 21600 }] });
const writeBeside = (f: Fixture, command: string) =>
  writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [guardEntry(f), { matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }), 'utf8');
const writeConfig = (f: Fixture, over: Record<string, unknown> = {}) =>
  writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, settings_file: f.settings, ...over }), 'utf8');
const nearLimit = (name: string, pct = 98) => fixture(name, { cache: { pct, resetMs: Date.now() + HOUR_MS } });
const setUsage = (f: Fixture, pct: number) => writeCache(f, { pct, resetMs: Date.now() + HOUR_MS });

describe.skipIf(!HAS_PYTHON3)('five-hour guard beside a hook command that is not read to its end', { timeout: 90000 }, () => {
  const UNREAD = ['echo "$(date)" >/dev/null', 'echo `date` >/dev/null', 'read -r line', 'echo "$?"'];

  it('a hook or status line whose command is not read to its end does not stop the guard: --dry-run exits 0, the guard pauses at the threshold, renews the pause, ends it and says which command it cannot read', () => {
    const forms: Array<[string, (f: Fixture) => void]> = [
      ...UNREAD.map((command): [string, (f: Fixture) => void] => [command, (f) => writeBeside(f, command)]),
      ['echo "$(whoami)"', (f) => writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [guardEntry(f)] }, statusLine: { type: 'command', command: 'echo "$(whoami)"' } }), 'utf8')],
    ];
    forms.forEach(([command, write], i) => {
      const f = nearLimit(`unread-start-${i}`);
      writeConfig(f);
      write(f);
      const dry = runSync(GUARD, guardArgs(f, ['--dry-run']));
      expect(dry.status, `${command}: ${dry.stdout}${dry.stderr}`).toBe(0);
      expect(dry.stdout, command).toMatch(/WARNING \(hook-unread\): 1 command\(s\) in .*settings\.json are not read to their end/);
      expect(dry.stdout, 'the warning shows the command').toContain(command.slice(0, 14));
      expect(existsSync(f.pause), '--dry-run writes nothing').toBe(false);
      const first = guardOnce(f);
      expect(first.stdout, command).not.toMatch(/ERROR/);
      const published = readJson(f.pause);
      expect(published.paused, command).toBe(true);
      expect(readJson(f.state).paused, command).toBe(true);
      const renewal = guardOnce(f);
      expect(renewal.stdout, command).not.toMatch(/ERROR/);
      expect(readJson(f.pause).valid_until, `${command}: the pause is renewed`).toBeGreaterThan(published.valid_until);
      expect(readText(f.log), 'the guard appends to its own log').toMatch(/WARNING \(hook-unread\)[\s\S]*THRESHOLD/);
      setUsage(f, 10);
      const end = guardOnce(f);
      expect(end.stdout, command).not.toMatch(/ERROR/);
      expect(existsSync(f.pause), `${command}: the pause ends`).toBe(false);
      expect(readJson(f.state).paused, command).toBe(false);
    });
  });

  it('such a command that appears in settings.json after the start stops neither the pause nor its renewal nor its end', async () => {
    const f = nearLimit('unread-after-start', 50);
    writeConfig(f);
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [guardEntry(f)] } }), 'utf8');
    const g = startGuard(f);
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start');
      writeBeside(f, 'echo "$(date)"');
      setUsage(f, 98);
      await waitFor(() => existsSync(f.pause), 20000, 'the pause');
      const first = readJson(f.pause).valid_until;
      await waitFor(() => readJson(f.pause).valid_until > first, 20000, 'the renewal');
      setUsage(f, 10);
      await waitFor(() => !existsSync(f.pause), 20000, 'the end of the pause');
    } finally { await stopGuard(g); }
    expect(g.out).not.toMatch(/ERROR/);
    expect(g.out).toMatch(/WARNING \(hook-unread\)/);
    expect(g.out).toMatch(/RESUMED \(window reset seen early/);
  });

  it('beside such a command a state or pause file that holds something else stops the start and stays as it is, and a log with other text is not appended to while the pause goes on', () => {
    const foreign: Array<[string, string]> = [
      ['state_file', PROGRAM_TEXT], ['state_file', '{"paused": "no"}'], ['state_file', '{"paused": false, "since": "yesterday"}'], ['state_file', '[true]'],
      ['pause_file', PROGRAM_TEXT], ['pause_file', '{"paused": false}'],
    ];
    foreign.forEach(([key, text], i) => {
      const f = nearLimit(`unread-foreign-${i}`);
      const target = join(f.dir, 'program');
      writeFileSync(target, text, 'utf8');
      writeConfig(f, { [key]: target });
      writeBeside(f, 'echo "$(date)"');
      const r = runSync(GUARD, guardArgs(f, ['--once']));
      expect(r.status, `${key} ${text}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, `${key} ${text}`).toMatch(new RegExp(`is not read to its end, and "${key}" \\(.*program\\) holds something else`));
      expect(readText(target), `${key}: kept`).toBe(text);
    });
    const linked = nearLimit('unread-linked-state');
    writeFileSync(join(linked.dir, 'real-state'), '{"paused": false}', 'utf8');
    symlinkSync(join(linked.dir, 'real-state'), linked.state);
    writeConfig(linked);
    writeBeside(linked, 'echo "$(date)"');
    const link = runSync(GUARD, guardArgs(linked, ['--once']));
    expect(link.status, `a link is not what the guard writes: ${link.stdout}${link.stderr}`).toBe(2);
    expect(lstatSync(linked.state).isSymbolicLink()).toBe(true);

    for (const text of [PROGRAM_TEXT, 'plain notes\n']) {
      const f = nearLimit('unread-foreign-log');
      const target = join(f.dir, 'program');
      writeFileSync(target, text, 'utf8');
      writeConfig(f, { log_file: target });
      writeBeside(f, 'echo "$(date)"');
      const r = guardOnce(f);
      expect(readJson(f.pause).paused, 'the pause goes on').toBe(true);
      expect(readText(target), 'the log with other text is kept').toBe(text);
      expect(r.stdout).toMatch(/the log file .*program is a program that a command in .*settings\.json runs: nothing is appended to it/);
      unlinkSync(f.pause);
      unlinkSync(f.state);
    }
  });

  it('beside such a command the files that the guard wrote before are its own: a stored state, an empty file and a log of its lines are written', () => {
    const states = ['{"paused": false}', '{"paused": false, "since": null, "resume_at": null}', ''];
    states.forEach((text, i) => {
      const f = nearLimit(`unread-own-${i}`);
      writeFileSync(f.state, text, 'utf8');
      writeFileSync(f.log, i === 2 ? '' : '2026-01-02 03:04:05 an earlier line\n', 'utf8');
      writeConfig(f);
      writeBeside(f, 'echo "$(date)"');
      const r = guardOnce(f);
      expect(r.stdout, JSON.stringify(text)).not.toMatch(/ERROR/);
      expect(readJson(f.pause).paused, JSON.stringify(text)).toBe(true);
      expect(readJson(f.state).paused, JSON.stringify(text)).toBe(true);
      expect(readText(f.log), JSON.stringify(text)).toMatch(/THRESHOLD/);
    });
  });

  it('beside such a command the log is looked at before every line: one that becomes something else right after a line is not appended to', () => {
    // two lines within the second for which a look is otherwise kept (the clock of that is stopped), the log replaced between them
    const driver = ['import os, runpy, sys, time', 'time.monotonic = lambda: 1000.0', 'guard, log, text = sys.argv[1], sys.argv[2], sys.argv[3]', 'sys.argv = [guard] + sys.argv[4:]',
      'g = runpy.run_path(guard, run_name="guard_functions")', 'g["log"]("first line")', 'print("appended:", "first line" in open(log).read(), flush=True)',
      'with open(log + ".new", "w") as f: f.write(text)', 'os.replace(log + ".new", log)', 'g["log"]("second line")', 'g["log"]("third line")'].join('\n');
    const f = nearLimit('unread-log-between-lines', 50);
    writeConfig(f);
    writeBeside(f, 'echo "$(date)"');
    const r = runPyCode(driver, [GUARD, f.log, PROGRAM_TEXT, ...guardArgs(f)]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout, 'the log of the guard was written').toMatch(/appended: True/);
    expect(readText(f.log), 'the file that took its place is kept').toBe(PROGRAM_TEXT);
    expect(r.stdout.match(/nothing is appended to it/g), 'a look that refuses is still kept: one notice').toHaveLength(1);
  });

  it('beside such a command a state file that becomes something else under a running guard is not written: the pause is refused with an error that names the command', async () => {
    const f = nearLimit('unread-state-turns-foreign', 50);
    writeConfig(f);
    writeBeside(f, 'echo "$(date)"');
    const g = startGuard(f);
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start');
      writeFileSync(f.state, PROGRAM_TEXT, 'utf8');
      setUsage(f, 98);
      await waitFor(() => /ERROR: tick failed/.test(g.out) || readText(f.state) !== PROGRAM_TEXT, 20000, 'the refusal');
      await sleep(600);
    } finally { await stopGuard(g); }
    expect(g.out).toMatch(/ERROR: tick failed.*echo "\$\(date\)".*is not read to its end and .*state\.json holds something else than what this guard writes there/);
    expect(readText(f.state), 'the program is intact').toBe(PROGRAM_TEXT);
    expect(existsSync(f.pause), 'no pause was published').toBe(false);
  });

  it('the hook log and the files that an entry with the marker runs stay protected when the entry is not read to its end', () => {
    const f = nearLimit('unread-entry');
    writeConfig(f);
    const command = generatedCommand(f.pause, HOOK, PYBIN, f.state).replace(' # five-hour-guard-entry', ' "$(true)" # five-hour-guard-entry');
    writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } }), 'utf8');
    const r = runSync(GUARD, guardArgs(f, ['--once']));
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/"state_file" .* and "registered hook log" .* are the same file/);
    expect(existsSync(f.state)).toBe(false);
  });
});

describe.skipIf(!HAS_PYTHON3)('five-hour guard and an entry of an installation that moved', { timeout: 90000 }, () => {
  const movedForms: Array<[string, (f: Fixture, hook: string) => string]> = [
    ['with the checks of the hook and the interpreter, without the marker', (f, hook) => generatedCommand(f.pause, hook, PYBIN, f.hookLog).replace(' # five-hour-guard-entry', '')],
    ['the older form without those checks', (f, hook) => `[ -f ${shellQuote(f.pause)} ] && [ -f ${shellQuote(hook)} ] || exit 0; exec ${shellQuote(PYBIN)} -I ${shellQuote(hook)} --pause-file ${shellQuote(f.pause)} --log ${shellQuote(f.hookLog)}`],
    ['the older form without a hook log', (f, hook) => `[ -f ${shellQuote(f.pause)} ] && [ -f ${shellQuote(hook)} ] || exit 0; exec ${shellQuote(PYBIN)} -I ${shellQuote(hook)} --pause-file ${shellQuote(f.pause)}`],
  ];
  const installElsewhere = (f: Fixture) => {
    const dir = join(f.dir, 'old install');
    mkdirSync(dir, { recursive: true });
    const hook = join(dir, 'five-hour-guard-hook.py');
    copyFileSync(HOOK, hook);
    return { dir, hook };
  };
  const onlyEntry = (f: Fixture, command: string) => writeFileSync(f.settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 21600 }] }] } }), 'utf8');

  it('an entry that add wrote for this pause file with the scripts in another directory is the entry of this guard: it starts and pauses, asks to replace the entry, and says so when its hook is gone', () => {
    movedForms.forEach(([name, build], i) => {
      const f = nearLimit(`moved-entry-${i}`);
      const old = installElsewhere(f);
      writeConfig(f, { hook_log_file: f.hookLog });
      onlyEntry(f, build(f, old.hook));
      const r = runSync(GUARD, guardArgs(f, ['--once']));
      expect(r.status, `${name}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(readJson(f.pause).paused, name).toBe(true);
      expect(r.stdout, name).toMatch(/is not the entry this guard generates/);
      expect(r.stdout, name).not.toMatch(/NOT registered/);
      expect(r.stdout, name).not.toMatch(/is missing or cannot be/);
      rmSync(old.dir, { recursive: true });
      unlinkSync(f.pause);
      unlinkSync(f.state);
      const gone = guardOnce(f);
      expect(gone.stdout, name).toMatch(/WARNING \(start\): the hook entry in .*: its hook .*old install\/five-hour-guard-hook\.py is missing or cannot be read, so the entry lets every call through during a pause/);
    });
  });

  it('a command that only resembles such an entry is another tool\'s: with one more word or another file name it names the pause file as a foreign hook does', () => {
    const variants: Array<[string, (f: Fixture, hook: string) => string]> = [
      ['one more command', (f, hook) => `${movedForms[0][1](f, hook)} ; true`],
      ['one more word', (f, hook) => `${movedForms[1][1](f, hook)} --poll 1`],
      ['another file name', (f, hook) => movedForms[0][1](f, `${hook}.old`)],
    ];
    variants.forEach(([name, build], i) => {
      const f = nearLimit(`moved-lookalike-${i}`);
      const old = installElsewhere(f);
      writeConfig(f, { hook_log_file: f.hookLog });
      onlyEntry(f, build(f, old.hook));
      const r = runSync(GUARD, guardArgs(f, ['--once']));
      expect(r.status, `${name}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, name).toMatch(/"pause_file" .* and "program of another hook" .* are the same file/);
    });
  });

  it('the wiring check names a hook or an interpreter of the entry that is not there, and not one given by a relative path or with a variable', () => {
    const f = nearLimit('entry-files-missing');
    writeConfig(f);
    const gone = join(f.dir, 'gone', 'five-hour-guard-hook.py');
    onlyEntry(f, generatedCommand(f.pause, gone, PYBIN));
    const noHook = guardOnce(f);
    expect(noHook.stdout).toMatch(/its hook .*gone\/five-hour-guard-hook\.py is missing or cannot be read/);
    expect(noHook.stdout).not.toMatch(/its interpreter/);
    const plain = join(f.dir, 'not-executable');
    writeFileSync(plain, PROGRAM_TEXT, 'utf8');
    onlyEntry(f, generatedCommand(f.pause, HOOK, plain));
    const noPython = guardOnce(f);
    expect(noPython.stdout).toMatch(/its interpreter .*not-executable is missing or cannot be run/);
    expect(noPython.stdout).not.toMatch(/its hook/);
    for (const [hook, python] of [['hooks/five-hour-guard-hook.py', 'python3'], ['/nonexistent/$TOOLS/five-hour-guard-hook.py', '/nonexistent/${PY}/python3']]) {
      onlyEntry(f, generatedCommand(f.pause, hook, python));
      const unknown = guardOnce(f);
      expect(unknown.stdout, hook).not.toMatch(/is missing or cannot be/);
    }
  });
});

// a program for pause_command (argv: mode, report file): it reports its start and the end of its input. "quit" ends at once with status 3,
// "outlive" goes on after the end of its input until it is terminated, "deaf" also ignores that and has to be killed, "linger" goes on for a
// few seconds after the end of its input and then ends by itself
const PAUSE_PROGRAM = [
  'import os, signal, sys, time',
  'mode, report = sys.argv[1], sys.argv[2]',
  'def note(text):',
  "    with open(report, 'a') as f:",
  "        f.write(text + '\\n')",
  'def terminated(*args):',
  "    note('terminated')",
  '    sys.exit(0)',
  "if mode == 'deaf':",
  '    signal.signal(signal.SIGTERM, signal.SIG_IGN)',
  "elif mode == 'outlive':",
  '    signal.signal(signal.SIGTERM, terminated)',
  "note('start %d' % os.getpid())",
  "if mode == 'quit':",
  '    sys.exit(3)',
  'sys.stdin.read()',
  "note('end of input')",
  "if mode in ('outlive', 'deaf'):",
  '    time.sleep(40)',
  "elif mode == 'linger':",
  '    time.sleep(6)',
  "note('left')",
].join('\n');
describe.skipIf(!HAS_PYTHON3)('five-hour guard pause_command', { timeout: 90000 }, () => {
  const pauseProgram = (f: Fixture, mode: string) => {
    const program = join(f.dir, 'pause-program.py');
    writeFileSync(program, PAUSE_PROGRAM, 'utf8');
    const report = join(f.dir, `report-${mode}.txt`);
    return { report, command: [PYBIN, '-I', program, mode, report] };
  };
  const starts = (report: string) => readText(report).match(/^start /gm)?.length ?? 0;

  it('pause_command runs for as long as a pause lasts, once, and reads the end of its input when the pause is over', async () => {
    const f = nearLimit('pause-command', 50);
    const p = pauseProgram(f, 'wait');
    writeFileSync(f.cfg, JSON.stringify({ usage_cache: f.cache, pause_file: f.pause, state_file: f.state, log_file: f.log, pause_command: [...p.command, f.pause] }), 'utf8');
    const g = startGuard(f);
    try {
      await waitFor(() => /guard start/.test(readText(f.log)), 20000, 'the start');
      await sleep(600);
      expect(starts(p.report), 'not run while there is no pause').toBe(0);
      setUsage(f, 98);
      await waitFor(() => starts(p.report) === 1, 20000, 'the start of the command');
      const first = readJson(f.pause).valid_until;
      await waitFor(() => readJson(f.pause).valid_until > first + 0.5, 20000, 'a few renewals');
      expect(starts(p.report), 'one process for the whole pause').toBe(1);
      expect(readText(p.report), 'its input is open while the pause lasts').not.toMatch(/end of input/);
      setUsage(f, 10);
      await waitFor(() => /left/.test(readText(p.report)), 20000, 'the end of the command');
      await waitFor(() => /pause_command ended \(status 0\)/.test(readText(f.log)), 20000, 'the line in the log');
      expect(existsSync(f.pause)).toBe(false);
    } finally { await stopGuard(g); }
    expect(g.out).toMatch(/pause_command started \(pid \d+\)/);
    expect(g.out).not.toMatch(/ERROR|WARNING \(pause-command/);
  });

  it.each([
    ['an early resume', 0],
    ['the resume time', 7200],
  ])('pause_command ends with the pause also when the state cannot be written at %s, and the error is still reported', async (name, ahead) => {
    // argv: flag file, seconds; while the flag file is there the state cannot be written and the clock of the guard is that far ahead
    const driver = ['import os, runpy, sys, time', 'real_open, real_time, flag, ahead = os.open, time.time, sys.argv[1], int(sys.argv[2])',
      'def broken(path, *a, **k):', '    if "state.json." in str(path) and str(path).endswith(".tmp") and os.path.exists(flag): raise OSError(30, "Read-only file system")', '    return real_open(path, *a, **k)',
      'os.open = broken', 'time.time = lambda: real_time() + (ahead if os.path.exists(flag) else 0)', 'sys.argv = sys.argv[3:]', 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n');
    const f = nearLimit(`pause-command-unwritable-${ahead}`);
    const p = pauseProgram(f, 'wait');
    writeConfig(f, { pause_command: p.command, settings_file: '' });
    const flag = join(f.dir, 'break-state');
    const g = spawnPyCode(driver, [flag, String(ahead), GUARD, ...guardArgs(f)]);
    try {
      await waitFor(() => starts(p.report) === 1, 20000, 'the start of the command');
      writeFileSync(flag, '');
      if (!ahead) setUsage(f, 10);
      await waitFor(() => /end of input/.test(readText(p.report)), 20000, `the end of the command at ${name}`);
      await waitFor(() => /pause_command ended \(status 0\)[\s\S]*ERROR: tick failed.*Read-only file system/.test(g.out), 20000, 'the error of the failed write');
      await sleep(600); // a few more tries to leave the pause
      expect(starts(p.report), 'not run again while the end of the pause is tried again').toBe(1);
      expect(existsSync(f.pause), 'the pause file is not removed before the state is written').toBe(true);
      expect(readJson(f.state).paused).toBe(true);
      expect(g.out).not.toMatch(/RESUMED/);
      unlinkSync(flag);
      if (ahead) {
        await waitFor(() => starts(p.report) === 2, 20000, 'a pause that goes on runs it again');
        setUsage(f, 10);
      }
      await waitFor(() => !existsSync(f.pause), 20000, 'the pause ends once the state can be written');
    } finally { await stopGuard(g); }
  });

  it('pause_command ends with a guard that is stopped, and with one that is killed, and does not keep the locks of the guard', async () => {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const f = nearLimit(`pause-command-${signal}`);
      const p = pauseProgram(f, signal === 'SIGKILL' ? 'linger' : 'wait');
      writeConfig(f, { pause_command: p.command, settings_file: '' });
      const g = startGuard(f);
      try {
        await waitFor(() => starts(p.report) === 1, 20000, 'the start of the command');
        g.child.kill(signal);
        await waitFor(() => /end of input/.test(readText(p.report)), 20000, `the end of the input after ${signal}`);
        if (signal === 'SIGKILL') {
          expect(readText(p.report), 'the command is still running').not.toMatch(/left/);
          const next = runSync(GUARD, guardArgs(f, ['--once']));
          expect(next.status, `a new guard starts while the old command still runs: ${next.stdout}${next.stderr}`).toBe(0);
        }
      } finally { await stopGuard(g); }
      await waitFor(() => /left/.test(readText(p.report)), 20000, 'the command ends by itself');
    }
  });

  it('a pause_command that ends while the pause lasts is run again at the next check, with a warning, and the pause goes on', async () => {
    const f = nearLimit('pause-command-quits');
    const p = pauseProgram(f, 'quit');
    writeConfig(f, { pause_command: p.command, settings_file: '' });
    const g = startGuard(f);
    try {
      await waitFor(() => starts(p.report) >= 3, 30000, 'the command run again');
      expect(readJson(f.pause).paused).toBe(true);
    } finally { await stopGuard(g); }
    expect(g.out).toMatch(/WARNING \(pause-command-ended\): pause_command ended with status 3 while the pause lasts: it is run again/);
    expect(g.out).not.toMatch(/ERROR/);
  });

  it('the first start of pause_command in a pause is logged; a start again in the same pause is a warning that --warn-every limits', async () => {
    const f = nearLimit('pause-command-started');
    const p = pauseProgram(f, 'quit');
    writeConfig(f, { pause_command: p.command, settings_file: '' });
    const g = startGuard(f);
    const first = () => g.out.match(/ pause_command started \(pid \d+\)/g)?.length ?? 0;
    const again = () => g.out.match(/WARNING \(pause-command-started\): pause_command started again \(pid \d+\)/g)?.length ?? 0;
    try {
      await waitFor(() => starts(p.report) >= 4, 30000, 'the command run again and again');
      setUsage(f, 10);
      await waitFor(() => /RESUMED/.test(g.out), 20000, 'the end of the first pause');
      expect(first(), g.out).toBe(1);
      expect(again(), g.out).toBe(1);
      const before = starts(p.report);
      setUsage(f, 98);
      await waitFor(() => starts(p.report) >= before + 3, 30000, 'the command of the second pause run again');
    } finally { await stopGuard(g); }
    expect(first(), 'the first start of the second pause is logged').toBe(2);
    expect(again(), 'the limit holds across pauses, as for any warning').toBe(1);
  });

  it('a pause_command that goes on after the end of its input is terminated, and one that ignores that is killed', async () => {
    for (const [mode, line] of [['outlive', /pause_command ended \(status 0\)/], ['deaf', /pause_command ended \(status -9\)/]] as const) {
      const f = nearLimit(`pause-command-${mode}`);
      const p = pauseProgram(f, mode);
      writeConfig(f, { pause_command: p.command, settings_file: '' });
      const g = startGuard(f);
      try {
        await waitFor(() => starts(p.report) === 1, 20000, 'the start of the command');
        setUsage(f, 10);
        await waitFor(() => line.test(g.out), 40000, `${mode}: the end of the command`);
        expect(existsSync(f.pause), 'the waiting calls were released').toBe(false);
      } finally { await stopGuard(g); }
      expect(/terminated/.test(readText(p.report)), mode).toBe(mode === 'outlive');
    }
  });

  it('pause_command is not run by --dry-run or --test-pause; --once runs it and ends it with the process; a program that cannot be run is a warning and the pause goes on', () => {
    const f = nearLimit('pause-command-modes');
    const p = pauseProgram(f, 'wait');
    writeConfig(f, { pause_command: p.command, settings_file: '' });
    expect(runSync(GUARD, guardArgs(f, ['--dry-run'])).status).toBe(0);
    expect(runSync(GUARD, guardArgs(f, ['--test-pause', '0.3'])).status).toBe(0);
    expect(starts(p.report)).toBe(0);
    const once = guardOnce(f);
    expect(once.stdout).toMatch(/pause_command started[\s\S]*pause_command ended/);
    const g = nearLimit('pause-command-broken');
    const broken = join(g.dir, 'broken');
    writeFileSync(broken, '#!/nonexistent-interpreter\n', 'utf8');
    chmodSync(broken, 0o755);
    writeConfig(g, { pause_command: [broken], settings_file: '' });
    const r = guardOnce(g);
    expect(r.stdout).toMatch(/WARNING \(pause-command\): cannot run pause_command .*: the pause goes on without it/);
    expect(readJson(g.pause).paused).toBe(true);
  });

  it('a pause_command that is not a list of an executable file and arguments, or that names a file the guard writes, stops the start; the pause file may be named', () => {
    const f = nearLimit('pause-command-config', 50);
    const plain = join(f.dir, 'not-executable');
    writeFileSync(plain, PROGRAM_TEXT, 'utf8');
    const bad: Array<[unknown, RegExp]> = [
      ['/bin/true', /"pause_command" must be a list of strings/],
      [['/bin/true', 3], /"pause_command" must be a list of strings/],
      [['/bin/true', ''], /"pause_command" must be a list of strings/],
      [{}, /"pause_command" must be a list of strings/],
      [['true'], /is not the absolute path of an executable file/],
      [[plain], /is not the absolute path of an executable file/],
      [[join(f.dir, 'nothing-here')], /is not the absolute path of an executable file/],
      [[PYBIN, f.state], /"pause_command" names .*state\.json, which is the state_file of this guard/],
      [[PYBIN, f.log], /"pause_command" names .*guard\.log, which is the log_file of this guard/],
      [[PYBIN, `${f.pause}.lock`], /which is the lock of the pause file of this guard/],
    ];
    for (const [value, message] of bad) {
      writeConfig(f, { pause_command: value, settings_file: '' });
      const r = runSync(GUARD, guardArgs(f, ['--once']));
      expect(r.status, `${JSON.stringify(value)}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, JSON.stringify(value)).toMatch(message);
      expect(r.stderr).not.toMatch(/Traceback/);
    }
    for (const value of [[], null, [PYBIN, '-c', 'pass', f.pause]]) {
      writeConfig(f, { pause_command: value, settings_file: '' });
      const r = runSync(GUARD, guardArgs(f, ['--once']));
      expect(r.status, `${JSON.stringify(value)}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });
});

// the guard runs where two paths cannot be exchanged (macOS, Windows), and the first `count` renames or replaces of the pause file are refused as
// Windows refuses them while another process holds the file open (argv: pause file, replace or rename, count, "arrival" to put a foreign file there)
const HELD_OPEN_DRIVER = [
  'import ctypes, os, runpy, sys',
  'def none(*args, **kw):',
  '    raise OSError("no library")',
  'ctypes.CDLL = none',
  'pause, what, left, arrival = sys.argv[1], sys.argv[2], [int(sys.argv[3])], sys.argv[4]',
  'real = getattr(os, what)',
  'def step(source, target, *args, **kw):',
  "    if str(target if what == 'replace' else source) == pause and left[0] > 0:",
  '        left[0] -= 1',
  "        if arrival == 'arrival':",
  "            open(pause + '.a', 'w').write('foreign file\\n')",
  "            os.rename(pause + '.a', pause)",
  "        raise PermissionError(13, 'the file is open in another process')",
  '    return real(source, target, *args, **kw)',
  'setattr(os, what, step)',
  'sys.argv = sys.argv[5:]',
  "runpy.run_path(sys.argv[0], run_name='__main__')",
].join('\n');

describe.skipIf(!HAS_PYTHON3)('five-hour guard where a replace or a rename is refused', { timeout: 90000 }, () => {
  it('a replace or a rename of the pause file that is refused while another process holds it open is tried again, a file that came in meanwhile is kept, and a refusal that stays is an error', () => {
    const run = (f: Fixture, what: string, count: number, arrival = '') => runPyCode(HELD_OPEN_DRIVER, [f.pause, what, String(count), arrival, GUARD, ...guardArgs(f, ['--once'])]);
    const f = nearLimit('held-open-renewal');
    guardOnce(f);
    let before = readJson(f.pause).valid_until;
    const brief = run(f, 'replace', 3);
    expect(brief.stdout, `${brief.stdout}${brief.stderr}`).not.toMatch(/ERROR/);
    expect(readJson(f.pause).valid_until, 'renewed after the refusals').toBeGreaterThan(before);
    before = readJson(f.pause).valid_until;
    const lasting = run(f, 'replace', 1000);
    expect(lasting.stdout).toMatch(/ERROR: tick failed.*PermissionError/);
    expect(readJson(f.pause).valid_until, 'the pause that was there stays').toBe(before);
    expect(readdirSync(f.dir).filter((n) => n.endsWith('.tmp')), 'no temporary file is left').toEqual([]);
    setUsage(f, 10);
    const end = run(f, 'rename', 3);
    expect(end.stdout, `${end.stdout}${end.stderr}`).not.toMatch(/ERROR|cannot remove/);
    expect(existsSync(f.pause), 'removed after the refusals').toBe(false);
    const g = nearLimit('held-open-arrival');
    guardOnce(g);
    const late = run(g, 'replace', 1, 'arrival');
    expect(late.stdout).toMatch(/ERROR: tick failed.*cannot be put in place/);
    expect(readText(g.pause), 'the file that came in between two tries is kept').toBe('foreign file\n');
  });
});
