/* global process, URL */
// Quota guard: rounds against a loopback quota server (a separate process), pool markers, aborted-run records,
// process-tree stops and the level functions. Stop cases use dummy processes whose command line carries a unique marker,
// so only those dummies can match the stop pattern. POSIX only (/proc).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, writeProfile } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const LIB = fileURLToPath(new URL('../../../scripts/provider/lib/', import.meta.url));
const GUARD = fileURLToPath(new URL('../../../scripts/provider/provider-quota-guard.cjs', import.meta.url));
const { stopMatching, sendSigterm, descendantTree, checkCandidate } = require(GUARD);
const { levelOf, quotaLevel, poolLevel } = require(join(LIB, 'quota.cjs'));

const QUOTA_URL = 'https://quota.acme.example/api/monitor/usage/quota/limit';
const MARKER = `provider-quota-guard-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const THRESHOLDS = { pause: 96, stop: 99, weeklyAsWindow: true };
const js = JSON.stringify;
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const alive = (pid) => {
  try { const st = readFileSync(`/proc/${pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3) !== 'Z'; } catch { return false; }
};
const startOf = (pid) => readFileSync(`/proc/${pid}/stat`, 'utf8').slice(readFileSync(`/proc/${pid}/stat`, 'utf8').lastIndexOf(')') + 2).split(' ')[22 - 3];
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (file, ms) => {
  const t0 = Date.now();
  for (;;) {
    const text = readText(file);
    if (text && text.trim()) return text;
    if (Date.now() - t0 > ms) throw new Error(`no ${file} after ${ms} ms`);
    pause(50);
  }
};
const kill = (pid, signal = 'SIGKILL') => { try { process.kill(pid, signal); } catch { /* already gone */ } };
const killFromFile = (file, home) => { try { kill(Number(readFileSync(join(home, file), 'utf8'))); } catch { /* no file or gone */ } };

// Quota server in its own process (a synchronous child of this test process would block its event loop).
const SERVER = `import http from 'node:http'; import { readFileSync, writeFileSync } from 'node:fs';
const [scenarioFile, counter, portFile] = process.argv.slice(2);
let n = 0;
try { n = Number(readFileSync(counter, 'utf8').trim()) || 0; } catch { /* no file yet */ }
const s = http.createServer((q, r) => {
  n += 1; writeFileSync(counter, String(n));
  let sc = {};
  try { sc = JSON.parse(readFileSync(scenarioFile, 'utf8')); } catch { /* no scenario: empty limits */ }
  r.setHeader('content-type', 'application/json');
  if (sc.status) { r.statusCode = sc.status; r.end(sc.body ?? '{"success":false,"msg":"unauthorized"}'); return; }
  r.end(JSON.stringify({ success: true, data: { level: 'lite', limits: sc.limits ?? [] } }));
});
s.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(s.address().port)));
setTimeout(() => process.exit(0), 60000);`;

const limit5h = (percentage, nextResetTime = Date.now() + 3600_000) => ({ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage, nextResetTime });
const limitWeek = (percentage, nextResetTime = Date.now() + 3 * 86400_000) => ({ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage, nextResetTime });

describe.skipIf(process.platform === 'win32')('provider quota guard', () => {
  let tmp;
  beforeAll(() => { tmp = makeTmp('provider-guard-'); });
  afterAll(() => tmp.cleanup());

  // Profile with the quota adapter, a pool directory and a stop pattern; HOME is a directory of its own.
  function fixture(name, { pattern = MARKER, pool: withPool = true } = {}) {
    const dir = join(tmp.dir, name);
    mkdirSync(dir, { recursive: true });
    const pool = join(dir, 'pool');
    if (withPool) mkdirSync(pool, { recursive: true });
    const quota = { adapter: 'monitor-limits', url: QUOTA_URL };
    if (pattern !== null) quota.stopPattern = pattern;
    if (withPool) quota.pool = { dir: pool };
    const { env } = writeProfile(dir, { quota });
    mkdirSync(env.HOME, { recursive: true });
    return { dir, pool, env, home: env.HOME };
  }

  // One --once round against a quota server in a separate process; OMC_PROVIDER_QUOTA_URL points the guard at it.
  function guardRun(fx, scenario, command = `node ${js(GUARD)} --once; echo CODE:$?`) {
    const mock = join(fx.dir, 'mock');
    mkdirSync(mock, { recursive: true });
    const serverFile = join(mock, 'server.mjs');
    writeFileSync(serverFile, SERVER);
    const rand = Math.random().toString(36).slice(2, 8);
    const scenarioFile = join(mock, `scenario-${rand}.json`);
    const portFile = join(mock, `port-${rand}`);
    const counter = join(mock, `counter-${rand}`);
    writeFileSync(scenarioFile, js(scenario));
    const sh = `node ${js(serverFile)} ${js(scenarioFile)} ${js(counter)} ${js(portFile)} >/dev/null 2>&1 & SRV=$!; for i in 1 2 3 4 5 6 7 8 9 10; do [ -s ${js(portFile)} ] && break; sleep 0.3; done; P=$(cat ${js(portFile)}); OMC_PROVIDER_QUOTA_URL=http://127.0.0.1:$P ${command}; kill $SRV 2>/dev/null`;
    const r = spawnSync('/bin/sh', ['-c', sh], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: fx.home, OMC_PROVIDER_PROFILES_FILE: fx.env.OMC_PROVIDER_PROFILES_FILE },
    });
    const n = Number(readText(counter)?.trim());
    return { requests: Number.isFinite(n) ? n : 0, out: r.stdout ?? '', err: r.stderr ?? '', status: r.status };
  }

  const pool = (dir) => ({
    pause: existsSync(join(dir, 'PAUSE')),
    stop: existsSync(join(dir, 'STOP')),
    state: readText(join(dir, 'QUOTA-STATE')),
    log: readText(join(dir, 'quota-guard.log')),
    aborted: readText(join(dir, 'aborted.tsv')),
  });

  // Dummy process whose command line carries the marker (argv0) and that stays alive.
  const dummy = (dir) => { const p = spawn('sleep', ['300'], { argv0: MARKER, detached: true, stdio: 'ignore', cwd: dir }); p.unref(); return p; };
  const plain = (dir) => { const p = spawn('sleep', ['300'], { detached: true, stdio: 'ignore', cwd: dir }); p.unref(); return p; };

  it('(1) without pool directory or stop pattern (also both empty): exit 2 with a message, nothing written to the pool', () => {
    const noPattern = fixture('w1a', { pattern: null });
    const a = spawnSync(process.execPath, [GUARD, '--once'], { encoding: 'utf8', env: noPattern.env });
    expect(a.status === 2 && /stop pattern/.test(a.stderr), js({ s: a.status, e: a.stderr })).toBe(true);
    const noPool = fixture('w1b', { pool: false });
    const b = spawnSync(process.execPath, [GUARD, '--once'], { encoding: 'utf8', env: noPool.env });
    expect(b.status === 2 && /pool directory/.test(b.stderr), js({ s: b.status, e: b.stderr })).toBe(true);
    // Empty variables are ignored (as in the profile loader), so a profile without pool and pattern refuses even with them set.
    const bare = fixture('w1c', { pattern: null, pool: false });
    const c = spawnSync(process.execPath, [GUARD, '--once'], { encoding: 'utf8', env: { ...bare.env, OMC_PROVIDER_POOL_DIR: '', OMC_PROVIDER_STOP_PATTERN: '' } });
    expect(c.status === 2 && /pool directory/.test(c.stderr), js({ s: c.status, e: c.stderr })).toBe(true);
    expect(existsSync(join(bare.dir, 'pool'))).toBe(false);
  }, 60_000);

  it('(2) profile without a key source: exit 2 before any round, nothing written', () => {
    const dir = join(tmp.dir, 'w2');
    mkdirSync(dir, { recursive: true });
    const pool = join(dir, 'pool');
    mkdirSync(pool, { recursive: true });
    const { env } = writeProfile(dir, { apiKey: {}, quota: { adapter: 'monitor-limits', url: QUOTA_URL, stopPattern: MARKER, pool: { dir: pool } } });
    const r = spawnSync(process.execPath, [GUARD, '--once'], { encoding: 'utf8', env });
    expect(r.status, r.stderr).toBe(2);
    expect(readdirSync(pool).length).toBe(0);
  }, 60_000);

  it('(3) --once at a 5 h window of 96 %: exit 0, PAUSE written, no STOP, state line and log start -> PAUSE', () => {
    const fx = fixture('w3');
    const r = guardRun(fx, { limits: [limit5h(96), limitWeek(12)] });
    const w = pool(fx.pool);
    expect(/CODE:0/.test(r.out) && w.pause && !w.stop, js({ wy: r.out.slice(0, 200), e: r.err.slice(0, 200), files: w })).toBe(true);
    expect(/^PAUSE 96 12 /.test(w.state ?? ''), js(w.state)).toBe(true);
    expect(/start -> PAUSE \(5 h window 96 %, week 12 %, thresholds 96\/99\)/.test(w.log ?? ''), js(w.log)).toBe(true);
  }, 60_000);

  it('(3b) --once at a weekly window of 96 % (5 h window 12 %): the week counts like a window, PAUSE without STOP', () => {
    const fx = fixture('w3b');
    const r = guardRun(fx, { limits: [limit5h(12), limitWeek(96)] });
    const w = pool(fx.pool);
    expect(/CODE:0/.test(r.out) && w.pause && !w.stop && /^PAUSE 12 96 /.test(w.state ?? ''), js({ wy: r.out.slice(0, 200), files: w })).toBe(true);
  }, 60_000);

  it('(4) --once at 99 %: PAUSE and STOP; SIGTERM only to the marked dummy (the plain one lives); aborted.tsv row; log with one aborted run', () => {
    const fx = fixture('w4');
    const targetProc = dummy(fx.dir);
    const quiet = plain(fx.dir);
    try {
      const r = guardRun(fx, { limits: [limit5h(99), limitWeek(12)] }, `OMC_PROVIDER_STOP_KILL_MS=500 node ${js(GUARD)} --once; echo CODE:$?`);
      const w = pool(fx.pool);
      expect(/CODE:0/.test(r.out) && w.pause && w.stop, js({ wy: r.out.slice(0, 300), files: w })).toBe(true);
      expect(/^STOP 99 12 /.test(w.state ?? ''), js(w.state)).toBe(true);
      expect(alive(targetProc.pid), `marked dummy alive (pid ${targetProc.pid})`).toBe(false);
      expect(alive(quiet.pid), `plain dummy stopped (pid ${quiet.pid})`).toBe(true);
      expect((w.aborted ?? '').split('\n').some((l) => l.split('\t')[1] === String(targetProc.pid)), js(w.aborted)).toBe(true);
      expect(/aborted runs: 1 \(see aborted\.tsv\)/.test(w.log ?? ''), js(w.log)).toBe(true);
      expect(r.requests).toBe(1);
    } finally {
      kill(quiet.pid);
      kill(targetProc.pid);
    }
  }, 60_000);

  it('(4b) parent shell skipped: pgrep matches the shell that runs the guard (its command line carries the marker), but that parent gets no SIGTERM', () => {
    const fx = fixture('w4b');
    const targetProc = dummy(fx.dir);
    try {
      const r = guardRun(fx, { limits: [limit5h(99), limitWeek(12)] }, `OMC_PROVIDER_STOP_KILL_MS=500 node ${js(GUARD)} --once; echo CODE:$? # ${MARKER}`);
      const w = pool(fx.pool);
      expect(/CODE:0/.test(r.out) && w.pause && w.stop, js({ wy: r.out.slice(0, 200), files: w })).toBe(true);
      const rows = (w.aborted ?? '').trim().split('\n').filter((l) => l.trim());
      expect(rows.length === 1 && rows[0].split('\t')[1] === String(targetProc.pid), `aborted rows: ${js(w.aborted)} (only the dummy ${targetProc.pid} expected)`).toBe(true);
    } finally {
      kill(targetProc.pid);
    }
  }, 60_000);

  it('(4c) error loop: a read-only pool does not end the guard after the first error (timeout 4 s gives exit 124, not 1)', () => {
    const fx = fixture('w4c');
    chmodSync(fx.pool, 0o555);
    const r = guardRun(fx, { limits: [limit5h(12), limitWeek(34)] }, `timeout 4 node ${js(GUARD)}; echo CODE:$?`);
    expect(/CODE:124/.test(r.out) && !/CODE:1\b/.test(r.out), `code: ${js(r.out.slice(0, 120))}, fail: ${js(r.err.slice(0, 200))}`).toBe(true);
    chmodSync(fx.pool, 0o755);
  }, 60_000);

  it('(4d) stop hits the wrapper: the wrapper and its child claude die, the --settings and session come from the child, an outside process lives', () => {
    const fx = fixture('w4d');
    const claudeStub = join(fx.dir, 'claude-stub-4d.cjs');
    writeFileSync(claudeStub, `require('node:fs').writeFileSync(process.env.HOME + '/claude-4d.pid', String(process.pid)); setTimeout(() => {}, 300000);\n`);
    const settings = join(fx.home, 'settings-4d.json');
    writeFileSync(settings, '{}\n', { mode: 0o600 });
    const wrapper = join(fx.dir, 'wrapper-4d.sh');
    writeFileSync(wrapper, `#!/bin/bash
printf '%s' $$ > "$HOME/wrapper-4d.pid"
node ${claudeStub} --settings ${settings} &
printf '%s' $! > "$HOME/claude-4d.pid"
wait
`, { mode: 0o755 });
    chmodSync(wrapper, 0o755);
    const escaped = fx.dir.replaceAll(/[/.]/g, '-');
    mkdirSync(join(fx.home, '.claude', 'projects', escaped), { recursive: true });
    writeFileSync(join(fx.home, '.claude', 'projects', escaped, 'session-test.jsonl'), '{}\n');
    const targetProc = spawn('bash', [wrapper], { argv0: MARKER, detached: true, stdio: 'ignore', cwd: fx.dir, env: { PATH: process.env.PATH, HOME: fx.home } });
    targetProc.unref();
    const quiet = plain(fx.dir);
    try {
      const pidWrapper = Number(waitFor(join(fx.home, 'wrapper-4d.pid'), 5000));
      const pidClaude = Number(waitFor(join(fx.home, 'claude-4d.pid'), 5000));
      expect(pidWrapper > 1 && pidClaude > 1).toBe(true);
      const r = guardRun(fx, { limits: [limit5h(99), limitWeek(12)] }, `OMC_PROVIDER_STOP_KILL_MS=500 node ${js(GUARD)} --once; echo CODE:$?`);
      const w = pool(fx.pool);
      expect(/CODE:0/.test(r.out) && w.pause && w.stop, js({ wy: r.out.slice(0, 200), e: r.err.slice(0, 200) })).toBe(true);
      expect(alive(pidWrapper), `wrapper alive (pid ${pidWrapper})`).toBe(false);
      expect(alive(pidClaude), `child claude alive (pid ${pidClaude})`).toBe(false);
      expect(alive(quiet.pid), `outside process stopped (pid ${quiet.pid})`).toBe(true);
      const rows = (w.aborted ?? '').trim().split('\n').filter((l) => l.trim());
      expect(rows.length === 1 && rows[0].split('\t')[1] === String(pidWrapper), `aborted rows: ${js(rows)}`).toBe(true);
      expect(rows[0].split('\t')[2], 'settings column').toBe(settings);
      expect(rows[0].split('\t')[4], 'session column').toBe('session-test');
      expect(/aborted runs: 1 \(see aborted\.tsv\)/.test(w.log ?? ''), js(w.log)).toBe(true);
    } finally {
      for (const file of ['wrapper-4d.pid', 'claude-4d.pid']) killFromFile(file, fx.home);
      kill(quiet.pid);
      kill(targetProc.pid);
    }
  }, 60_000);

  it('(4e) a child ignoring SIGTERM gets SIGKILL after OMC_PROVIDER_STOP_KILL_MS; the wrapper target dies at once', () => {
    const fx = fixture('w4e');
    const stubborn = join(fx.dir, 'stubborn-4e.sh');
    writeFileSync(stubborn, `#!/bin/bash
trap '' TERM
printf '%s' $$ > "$HOME/stubborn-4e.pid"
while :; do sleep 1; done
`, { mode: 0o755 });
    const wrapper = join(fx.dir, 'wrapper-4e.sh');
    writeFileSync(wrapper, `#!/bin/bash
bash ${stubborn} &
printf '%s' $! > "$HOME/stubborn-4e-parent.pid"
wait
`, { mode: 0o755 });
    const targetProc = spawn('bash', [wrapper], { argv0: MARKER, detached: true, stdio: 'ignore', cwd: fx.dir, env: { PATH: process.env.PATH, HOME: fx.home } });
    targetProc.unref();
    let pidStubborn = 0;
    try {
      pidStubborn = Number(waitFor(join(fx.home, 'stubborn-4e.pid'), 5000));
      expect(pidStubborn > 1, `stubborn pid ${pidStubborn}`).toBe(true);
      const before = Date.now();
      const r = guardRun(fx, { limits: [limit5h(99), limitWeek(12)] }, `OMC_PROVIDER_STOP_KILL_MS=500 node ${js(GUARD)} --once; echo CODE:$?`);
      expect(/CODE:0/.test(r.out), js(r.out.slice(0, 200))).toBe(true);
      expect(alive(targetProc.pid), `wrapper target alive (pid ${targetProc.pid})`).toBe(false);
      expect(alive(pidStubborn), `stubborn child alive after SIGKILL (pid ${pidStubborn})`).toBe(false);
      expect(Date.now() - before >= 500, 'the round did not wait for OMC_PROVIDER_STOP_KILL_MS').toBe(true);
    } finally {
      killFromFile('stubborn-4e.pid', fx.home);
      kill(targetProc.pid);
    }
  }, 60_000);

  it('(4f) stop with its own --settings in the command line and a child with another --settings: the aborted row keeps the ORIGINAL from the wrapper command line', () => {
    const fx = fixture('w4f');
    const claudeStub = join(fx.dir, 'claude-stub-4f.cjs');
    writeFileSync(claudeStub, `require('node:fs').writeFileSync(process.env.HOME + '/claude-4f.pid', String(process.pid)); setTimeout(() => {}, 300000);\n`);
    const originalSettings = join(fx.home, 'settings-original-4f.json');
    writeFileSync(originalSettings, '{}\n', { mode: 0o600 });
    const childSettings = join(fx.home, 'settings-child-4f.json');
    writeFileSync(childSettings, '{}\n', { mode: 0o600 });
    const wrapper = join(fx.dir, 'wrapper-4f.sh');
    writeFileSync(wrapper, `#!/bin/bash
printf '%s' $$ > "$HOME/wrapper-4f.pid"
node ${claudeStub} --settings ${childSettings} &
printf '%s' $! > "$HOME/claude-4f.pid"
wait
`, { mode: 0o755 });
    const targetProc = spawn('bash', [wrapper, '--settings', originalSettings], { argv0: MARKER, detached: true, stdio: 'ignore', cwd: fx.dir, env: { PATH: process.env.PATH, HOME: fx.home } });
    targetProc.unref();
    try {
      const pidWrapper = Number(waitFor(join(fx.home, 'wrapper-4f.pid'), 5000));
      const pidClaude = Number(waitFor(join(fx.home, 'claude-4f.pid'), 5000));
      const r = guardRun(fx, { limits: [limit5h(99), limitWeek(12)] }, `OMC_PROVIDER_STOP_KILL_MS=500 node ${js(GUARD)} --once; echo CODE:$?`);
      const w = pool(fx.pool);
      expect(/CODE:0/.test(r.out) && w.pause && w.stop, js({ wy: r.out.slice(0, 200), files: w })).toBe(true);
      expect(!alive(pidWrapper) && !alive(pidClaude), `wrapper or child alive (${pidWrapper}, ${pidClaude})`).toBe(true);
      const rows = (w.aborted ?? '').trim().split('\n').filter((l) => l.trim());
      expect(rows.length === 1 && rows[0].split('\t')[1] === String(pidWrapper), js(rows)).toBe(true);
      expect(rows[0].split('\t')[2], 'settings column').toBe(originalSettings);
    } finally {
      killFromFile('wrapper-4f.pid', fx.home);
      killFromFile('claude-4f.pid', fx.home);
      kill(targetProc.pid);
    }
  }, 60_000);

  it('(4g) an outer shell two levels up (argv0 marker) is protected: it gets no SIGTERM and no row; an unrelated marked dummy is stopped', () => {
    const fx = fixture('w4g');
    const mock = join(fx.dir, 'mock-4g');
    mkdirSync(mock, { recursive: true });
    const serverFile = join(mock, 'server.mjs');
    writeFileSync(serverFile, SERVER);
    const rand = Math.random().toString(36).slice(2, 8);
    const scenarioFile = join(mock, `scenario-${rand}.json`);
    const portFile = join(mock, `port-${rand}`);
    const counter = join(mock, `counter-${rand}`);
    writeFileSync(scenarioFile, js({ limits: [limit5h(99), limitWeek(12)] }));
    const shQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
    const innerSh = `printf '%s' $$ > ${js(join(fx.home, 'inner-4g.pid'))}; node ${js(serverFile)} ${js(scenarioFile)} ${js(counter)} ${js(portFile)} >/dev/null 2>&1 & SRV=$!; for i in 1 2 3 4 5 6 7 8 9 10; do [ -s ${js(portFile)} ] && break; sleep 0.3; done; P=$(cat ${js(portFile)}); OMC_PROVIDER_QUOTA_URL=http://127.0.0.1:$P OMC_PROVIDER_STOP_KILL_MS=500 node ${js(GUARD)} --once > /dev/null; echo CODE:$? > ${js(join(fx.home, 'code-4g'))}; kill $SRV 2>/dev/null`;
    const outerSh = `printf '%s' $$ > ${js(join(fx.home, 'outer-4g.pid'))}; /bin/sh -c ${shQuote(innerSh)}; sleep 2`;
    const outer = spawn('/bin/sh', ['-c', outerSh], { argv0: MARKER, detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: fx.home, OMC_PROVIDER_PROFILES_FILE: fx.env.OMC_PROVIDER_PROFILES_FILE } });
    outer.unref();
    const unrelated = dummy(fx.dir);
    try {
      waitFor(join(fx.home, 'code-4g'), 15000);
      expect(readText(join(fx.home, 'code-4g')).trim()).toBe('CODE:0');
      const pidOuter = Number(readText(join(fx.home, 'outer-4g.pid')));
      expect(alive(pidOuter), `outer shell (argv0 marker) was signalled (pid ${pidOuter})`).toBe(true);
      const rows = (readText(join(fx.pool, 'aborted.tsv')) ?? '').trim().split('\n').filter((l) => l.trim());
      expect(rows.length === 1 && rows[0].split('\t')[1] === String(unrelated.pid), js(rows)).toBe(true);
      expect(alive(unrelated.pid), 'unrelated marked dummy alive').toBe(false);
      expect(existsSync(join(fx.pool, 'STOP')) && existsSync(join(fx.pool, 'PAUSE')), 'PAUSE or STOP missing').toBe(true);
    } finally {
      killFromFile('outer-4g.pid', fx.home);
      killFromFile('inner-4g.pid', fx.home);
      kill(unrelated.pid);
    }
  }, 60_000);

  it('(4h) invalid OMC_PROVIDER_STOP_KILL_MS: the error comes before any signal (--once exit 1), the marked dummy lives, no aborted.tsv', () => {
    const fx = fixture('w4h');
    const targetProc = dummy(fx.dir);
    try {
      const r = guardRun(fx, { limits: [limit5h(99), limitWeek(12)] }, `OMC_PROVIDER_STOP_KILL_MS=abc node ${js(GUARD)} --once; echo CODE:$?`);
      const w = pool(fx.pool);
      expect(/CODE:1/.test(r.out) && w.pause && w.stop, js({ wy: r.out.slice(0, 300), files: w })).toBe(true);
      expect(/OMC_PROVIDER_STOP_KILL_MS has an invalid value/.test(w.log ?? ''), js(w.log)).toBe(true);
      expect(alive(targetProc.pid), `dummy got a signal despite the invalid value (pid ${targetProc.pid})`).toBe(true);
      expect(existsSync(join(fx.pool, 'aborted.tsv')), 'aborted.tsv was written').toBe(false);
    } finally {
      kill(targetProc.pid);
    }
  }, 60_000);

  it('(4i) a child started between SIGTERM and SIGKILL (by the trap of the target) gets SIGKILL from the second walk', () => {
    const fx = fixture('w4i');
    const target = join(fx.dir, 'target-4i.sh');
    writeFileSync(target, `#!/bin/bash
sleep 300 &
printf '%s' $! > "$HOME/first-4i.pid"
trap 'sleep 300 & printf "%s" $! > "$HOME/second-4i.pid"; wait' TERM
wait
`, { mode: 0o755 });
    const targetProc = spawn('bash', [target], { argv0: MARKER, detached: true, stdio: 'ignore', cwd: fx.dir, env: { PATH: process.env.PATH, HOME: fx.home } });
    targetProc.unref();
    try {
      waitFor(join(fx.home, 'first-4i.pid'), 5000);
      const before = Date.now();
      const r = guardRun(fx, { limits: [limit5h(99), limitWeek(12)] }, `OMC_PROVIDER_STOP_KILL_MS=500 node ${js(GUARD)} --once; echo CODE:$?`);
      expect(/CODE:0/.test(r.out), js(r.out.slice(0, 200))).toBe(true);
      expect(existsSync(join(fx.home, 'second-4i.pid')), 'no child was created in the signal window').toBe(true);
      const second = Number(readText(join(fx.home, 'second-4i.pid')));
      expect(alive(second), `child from the signal window alive (pid ${second})`).toBe(false);
      expect(alive(targetProc.pid), `target alive (pid ${targetProc.pid})`).toBe(false);
      expect(Date.now() - before >= 500, 'the round was shorter than OMC_PROVIDER_STOP_KILL_MS').toBe(true);
    } finally {
      killFromFile('first-4i.pid', fx.home);
      killFromFile('second-4i.pid', fx.home);
      kill(targetProc.pid);
    }
  }, 60_000);

  it('(4j) sendSigterm: a different start time gives no signal (dummy lives 500 ms); the matching start time gets SIGTERM (dummy dies)', () => {
    const dummyProc = spawn('sleep', ['30'], { detached: true, stdio: 'ignore', cwd: tmp.dir });
    dummyProc.unref();
    try {
      const start = startOf(dummyProc.pid);
      expect(/^\d+$/.test(start), `start time unreadable: ${js(start)}`).toBe(true);
      expect(sendSigterm([{ pid: dummyProc.pid, start: `${start}9` }])).toBe(0);
      pause(500);
      expect(alive(dummyProc.pid), 'dummy stopped although the start time did not match').toBe(true);
      expect(sendSigterm([{ pid: dummyProc.pid, start }])).toBe(1);
      const t0 = Date.now();
      while (alive(dummyProc.pid) && Date.now() - t0 < 2000) pause(50);
      expect(alive(dummyProc.pid), `dummy alive after SIGTERM with the matching start (pid ${dummyProc.pid})`).toBe(false);
    } finally {
      kill(dummyProc.pid);
    }
  }, 60_000);

  it('(4k) descendantTree: entries {pid, start} with the start time from /proc for living descendants of a two-level tree', () => {
    const home = join(tmp.dir, 'w4k', 'home');
    mkdirSync(home, { recursive: true });
    const middle = join(tmp.dir, 'w4k', 'middle-4k.sh');
    writeFileSync(middle, `#!/bin/bash
sleep 300 &
printf '%s' $! > "$HOME/leaf-4k.pid"
wait
`);
    chmodSync(middle, 0o755);
    const root = join(tmp.dir, 'w4k', 'root-4k.sh');
    writeFileSync(root, `#!/bin/bash
printf '%s' $$ > "$HOME/root-4k.pid"
sleep 300 &
printf '%s' $! > "$HOME/child-4k.pid"
bash ${middle} &
printf '%s' $! > "$HOME/middle-4k.pid"
wait
`);
    chmodSync(root, 0o755);
    const rootProc = spawn('bash', [root], { detached: true, stdio: 'ignore', cwd: tmp.dir, env: { PATH: process.env.PATH, HOME: home } });
    rootProc.unref();
    try {
      const pidLeaf = Number(waitFor(join(home, 'leaf-4k.pid'), 5000));
      const pidRoot = Number(waitFor(join(home, 'root-4k.pid'), 5000));
      const pidChild = Number(waitFor(join(home, 'child-4k.pid'), 5000));
      const pidMiddle = Number(waitFor(join(home, 'middle-4k.pid'), 5000));
      const expected = new Set([pidChild, pidMiddle, pidLeaf]);
      const tree = descendantTree(pidRoot);
      expect(tree.length === 3 && tree.every((w) => expected.has(w.pid)), js(tree)).toBe(true);
      for (const w of tree) {
        expect(alive(w.pid), `pid ${w.pid} from the tree is not alive`).toBe(true);
        expect(w.start === startOf(w.pid), `start of pid ${w.pid} differs from /proc`).toBe(true);
      }
      const order = [];
      const tokens = descendantTree(pidRoot, new Set(), (pid) => { order.push(pid); return `t${order.length}`; });
      expect(new Set(tokens.map((w) => w.start)).size).toBe(3);
      expect(order[order.length - 1], 'the leaf is not the last pid read').toBe(pidLeaf);
      expect(new Map(tokens.map((w) => [w.pid, w.start])).get(pidLeaf)).toBe('t3');
    } finally {
      for (const file of ['root-4k.pid', 'child-4k.pid', 'middle-4k.pid', 'leaf-4k.pid']) killFromFile(file, home);
      kill(rootProc.pid);
    }
  }, 60_000);

  it('(4l) checkCandidate: read order starttime, cmdline, starttime; a non-matching cmdline skips; a changed start time skips; NUL as spaces; invalid pattern skips', () => {
    const dummyProc = spawn('sleep', ['30'], { detached: true, stdio: 'ignore', cwd: tmp.dir });
    dummyProc.unref();
    try {
      const start = startOf(dummyProc.pid);
      expect(/^\d+$/.test(start), `start unreadable: ${js(start)}`).toBe(true);
      const log = [];
      const k = checkCandidate(dummyProc.pid, MARKER, {
        starttime: () => { log.push('start'); return startOf(dummyProc.pid); },
        cmdline: () => { log.push('cmd'); return `${MARKER}\0--settings\0/tmp/settings.json`; },
      });
      expect(k && k.pid === dummyProc.pid && k.start === start && String(k.cmd).includes(MARKER), js(k)).toBe(true);
      expect(js(log)).toBe(js(['start', 'cmd', 'start']));
      expect(checkCandidate(dummyProc.pid, MARKER, { starttime: () => start, cmdline: () => 'sleep\0' + '30' })).toBeNull();
      let first = true;
      expect(checkCandidate(dummyProc.pid, MARKER, {
        starttime: () => { const s = first ? start : `${start}9`; first = false; return s; },
        cmdline: () => `${MARKER}\0x`,
      })).toBeNull();
      expect(checkCandidate(dummyProc.pid, MARKER, { starttime: () => start, cmdline: () => '' })).toBeNull();
      expect(checkCandidate(dummyProc.pid, '(unclosed[', { starttime: () => start, cmdline: () => 'x' })).toBeNull();
      expect(checkCandidate(dummyProc.pid, 'S[0-9]', { starttime: () => start, cmdline: () => 'aa\0S7bb' })).not.toBeNull();
    } finally {
      kill(dummyProc.pid);
    }
  }, 60_000);

  it('(4m) stopMatching: the injected sendSigterm is called for the tree and the target; the aborted row comes only after the target signal; return value = target signal', () => {
    const fx = fixture('w4m');
    const claudeStub = join(fx.dir, 'claude-stub-4m.cjs');
    writeFileSync(claudeStub, `require('node:fs').writeFileSync(process.env.HOME + '/claude-4m.pid', String(process.pid)); setTimeout(() => {}, 300000);\n`);
    const settings = join(fx.home, 'settings-4m.json');
    writeFileSync(settings, '{}\n', { mode: 0o600 });
    const wrapper = join(fx.dir, 'wrapper-4m.sh');
    writeFileSync(wrapper, `#!/bin/bash
printf '%s' $$ > "$HOME/wrapper-4m.pid"
node ${claudeStub} --settings ${settings} &
printf '%s' $! > "$HOME/claude-4m.pid"
wait
`, { mode: 0o755 });
    const targetProc = spawn('bash', [wrapper], { argv0: MARKER, detached: true, stdio: 'ignore', cwd: fx.dir, env: { PATH: process.env.PATH, HOME: fx.home } });
    targetProc.unref();
    try {
      const pidWrapper = Number(waitFor(join(fx.home, 'wrapper-4m.pid'), 5000));
      const pidClaude = Number(waitFor(join(fx.home, 'claude-4m.pid'), 5000));
      const startWrapper = startOf(pidWrapper);
      const startClaude = startOf(pidClaude);
      const register = [];
      let calls = 0;
      const recordingSignal = (targets) => {
        const sent = sendSigterm(targets);
        register.push({ targets: targets.map((t) => ({ ...t })), rowExists: existsSync(join(fx.pool, 'aborted.tsv')), sent });
        calls += 1;
        return sent;
      };
      const n = stopMatching(MARKER, fx.pool, { HOME: fx.home, OMC_PROVIDER_STOP_KILL_MS: '300' }, { sendSigterm: recordingSignal });
      expect(calls, 'calls of the signal function').toBe(2);
      expect(n, 'returned count').toBe(1);
      const [tree, target] = register;
      expect(tree.targets.length === 1 && tree.targets[0].pid === pidClaude && tree.targets[0].start === startClaude, js(tree.targets)).toBe(true);
      expect(target.targets.length === 1 && target.targets[0].pid === pidWrapper && target.targets[0].start === startWrapper, js(target.targets)).toBe(true);
      expect(tree.rowExists === false && target.rowExists === false, 'aborted.tsv existed during the signals').toBe(true);
      expect(existsSync(join(fx.pool, 'aborted.tsv')), 'no aborted row after the run').toBe(true);
      expect(!alive(pidWrapper) && !alive(pidClaude), 'wrapper or child alive after the run').toBe(true);
    } finally {
      killFromFile('wrapper-4m.pid', fx.home);
      killFromFile('claude-4m.pid', fx.home);
      kill(targetProc.pid);
    }
  }, 60_000);

  it('(4n) pgrep window: a foreign sleep returned by a fake pgrep gets no signal and no row (n = 0, the sleep lives)', () => {
    const fx = fixture('w4n');
    const bin = join(fx.dir, 'bin-4n');
    mkdirSync(bin, { recursive: true });
    const foreign = spawn('sleep', ['30'], { detached: true, stdio: 'ignore', cwd: fx.dir });
    foreign.unref();
    const oldPath = process.env.PATH;
    try {
      expect(alive(foreign.pid), 'foreign sleep did not start').toBe(true);
      writeFileSync(join(bin, 'pgrep'), `#!/bin/sh\necho ${foreign.pid}\nexit 0\n`, { mode: 0o755 });
      process.env.PATH = `${bin}:${oldPath}`;
      let n;
      try {
        n = stopMatching('PATTERN-NOT-PRESENT', fx.pool, { OMC_PROVIDER_STOP_KILL_MS: '400' }, {});
      } finally {
        process.env.PATH = oldPath;
      }
      expect(n, 'foreign sleep was counted').toBe(0);
      expect(existsSync(join(fx.pool, 'aborted.tsv')), 'aborted row written for the foreign sleep').toBe(false);
      pause(300);
      expect(alive(foreign.pid), 'foreign sleep was signalled').toBe(true);
    } finally {
      process.env.PATH = oldPath;
      kill(foreign.pid);
    }
  }, 60_000);

  it('(5) --once below both thresholds (12 % / 34 %) after PAUSE and STOP were set: both markers removed, state WORK', () => {
    const fx = fixture('w5');
    writeFileSync(join(fx.pool, 'PAUSE'), '');
    writeFileSync(join(fx.pool, 'STOP'), '');
    const r = guardRun(fx, { limits: [limit5h(12), limitWeek(34)] });
    const w = pool(fx.pool);
    expect(/CODE:0/.test(r.out) && !w.pause && !w.stop && /^WORK 12 34 /.test(w.state ?? ''), js({ wy: r.out.slice(0, 200), files: w })).toBe(true);
    expect(/-> WORK \(5 h window 12 %, week 34 %, thresholds 96\/99\)/.test(w.log ?? ''), js(w.log)).toBe(true);
  }, 60_000);

  it('(6) read error (HTTP 500): markers and state unchanged, error line in the log', () => {
    const fx = fixture('w6');
    writeFileSync(join(fx.pool, 'PAUSE'), '');
    writeFileSync(join(fx.pool, 'STOP'), '');
    const r = guardRun(fx, { status: 500 });
    const w = pool(fx.pool);
    expect(/CODE:0/.test(r.out) && w.pause && w.stop, js({ wy: r.out.slice(0, 200), files: w })).toBe(true);
    expect(w.state, 'state written after a read error').toBeNull();
    expect(/error or incomplete quota read, state unchanged/.test(w.log ?? ''), js(w.log)).toBe(true);
  }, 60_000);

  it('(7) incomplete read (no weekly window in the answer): state unchanged, PAUSE kept', () => {
    const fx = fixture('w7');
    writeFileSync(join(fx.pool, 'PAUSE'), '');
    const r = guardRun(fx, { limits: [limit5h(12)] });
    const w = pool(fx.pool);
    expect(w.pause && !w.stop && w.state === null, js(w)).toBe(true);
    expect(/incomplete read \(no 5 h or weekly window\), state unchanged/.test(w.log ?? ''), js(w.log)).toBe(true);
    expect(/CODE:0/.test(r.out)).toBe(true);
  }, 60_000);

  it('(8) levels: 95/96/98/99/100 with the thresholds, weekly window like the 5 h window, STOP above PAUSE, pool without markers gives none', () => {
    expect(levelOf(95, THRESHOLDS)).toBeNull();
    expect(levelOf(96, THRESHOLDS)).toBe('PAUSE');
    expect(levelOf(98, THRESHOLDS)).toBe('PAUSE');
    expect(levelOf(99, THRESHOLDS)).toBe('STOP');
    expect(levelOf(100, THRESHOLDS)).toBe('STOP');
    expect(quotaLevel(95, 95, THRESHOLDS)).toBeNull();
    expect(quotaLevel(95, 96, THRESHOLDS)).toBe('PAUSE');
    expect(quotaLevel(96, 95, THRESHOLDS)).toBe('PAUSE');
    expect(quotaLevel(98, 12, THRESHOLDS)).toBe('PAUSE');
    expect(quotaLevel(99, 12, THRESHOLDS)).toBe('STOP');
    expect(quotaLevel(12, 99, THRESHOLDS)).toBe('STOP');
    expect(quotaLevel(97, 99, THRESHOLDS)).toBe('STOP');
    expect(quotaLevel(97, 98, THRESHOLDS)).toBe('PAUSE');
    const dir = join(tmp.dir, 'w8');
    mkdirSync(dir, { recursive: true });
    const markers = { pause: 'PAUSE', stop: 'STOP', state: 'QUOTA-STATE' };
    expect(poolLevel({ quota: { pool: { dir: null, markers } } })).toBeNull();
    expect(poolLevel({ quota: { pool: { dir, markers } } })).toBeNull();
    writeFileSync(join(dir, 'PAUSE'), '');
    expect(poolLevel({ quota: { pool: { dir, markers } } })).toBe('PAUSE');
    writeFileSync(join(dir, 'STOP'), '');
    expect(poolLevel({ quota: { pool: { dir, markers } } })).toBe('STOP');
    unlinkSync(join(dir, 'PAUSE'));
    unlinkSync(join(dir, 'STOP'));
  }, 60_000);
});
