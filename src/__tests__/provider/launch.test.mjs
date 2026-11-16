/* global process, setTimeout, URL */
// Session launcher: key checks, settings copy, environment of the child, Jev switches, quota gate, signals and slots.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, writeProfile, stubProxyProcess, PLACEHOLDER_KEY } from './_helpers.mjs';

const LAUNCH = fileURLToPath(new URL('../../../scripts/provider/provider-launch.cjs', import.meta.url));
const QUOTA_URL = 'https://quota.acme.example/api/monitor/usage/quota/limit';
const limit5h = (percentage) => ({ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage, nextResetTime: Date.now() + 3600_000 });
const limitWeek = (percentage) => ({ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage, nextResetTime: Date.now() + 3 * 86400_000 });
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const json = JSON.stringify;

// Quota endpoint on loopback: `reply` gives { status, body } per request; hits counts the requests.
function serveQuota(reply) {
  const state = { hits: 0, reply };
  const server = createServer((req, res) => {
    state.hits += 1;
    const { status = 200, body = {} } = state.reply();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(json(body));
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({
    state,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((closed) => server.close(() => closed())),
  })));
}

describe.skipIf(process.platform === 'win32')('provider session launcher', () => {
  let tmp;
  let starter;
  let signalStarter;
  let counter = 0;
  beforeAll(() => {
    tmp = makeTmp('provider-launch-');
    // Fake `claude`: argv as JSON, env names, the value of OMC_JEV; the exit code comes from $HOME/fake.exit (an environment
    // allow-list removes test variables from the child env, so files in $HOME carry the data).
    starter = join(tmp.dir, 'fake-starter');
    writeFileSync(starter, [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      'const home = process.env.HOME;',
      'fs.writeFileSync(home + "/fake.argv", JSON.stringify(process.argv.slice(2)));',
      'fs.writeFileSync(home + "/fake.env", JSON.stringify(Object.keys(process.env).sort()));',
      'fs.writeFileSync(home + "/fake.omcjev", process.env.OMC_JEV ?? "");',
      'let code = 0; try { code = Number(fs.readFileSync(home + "/fake.exit", "utf8")); } catch { /* none */ }',
      'process.exit(code);',
      '',
    ].join('\n'), { mode: 0o755 });
    signalStarter = join(tmp.dir, 'fake-signal-starter');
    writeFileSync(signalStarter, `#!/bin/bash\nprintf '%s' $$ > "$HOME/signal.pid"\nexec sleep 30\n`, { mode: 0o755 });
    chmodSync(signalStarter, 0o755);
  });
  afterAll(() => tmp.cleanup());

  // A fresh fixture: profile, home, an original --settings file; run() starts the launcher and returns what the fake starter saw.
  const fixture = (overrides = {}, { settingsBody = { env: { SESSION_ROLE: 'lane', SESSION_NAME: 'Lane A', SESSION_LEAD: 'd7ec31aa' } } } = {}) => {
    const dir = join(tmp.dir, `f${++counter}`);
    mkdirSync(join(dir, 'home'), { recursive: true });
    const p = writeProfile(dir, overrides);
    const settingsDir = join(dir, 'session-settings');
    mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
    const original = join(settingsDir, 'lane.json');
    writeFileSync(original, `${json(settingsBody, null, 2)}\n`, { mode: 0o600 });
    const read = (name) => { try { return readFileSync(join(p.env.HOME, name), 'utf8'); } catch { return null; } };
    const run = (args, env = {}, { binary = starter } = {}) => new Promise((done) => {
      for (const name of ['fake.argv', 'fake.env', 'fake.exit', 'fake.omcjev']) { try { unlinkSync(join(p.env.HOME, name)); } catch { /* absent */ } }
      const { FAKE_EXIT: exit, ...rest } = env;
      if (exit !== undefined) writeFileSync(join(p.env.HOME, 'fake.exit'), String(exit));
      const merged = { ...p.env, OMC_PROVIDER_CLAUDE_BIN: binary, ...rest };
      for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
      const child = spawn(process.execPath, [LAUNCH, ...args], { env: merged, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => {
        const argv = read('fake.argv') && JSON.parse(read('fake.argv'));
        done({ status, stdout, stderr, called: argv !== null, argv, env: read('fake.env') && JSON.parse(read('fake.env')), omcjev: read('fake.omcjev') });
      });
    });
    const copyOf = (r) => JSON.parse(readFileSync(r.argv[r.argv.indexOf('--settings') + 1], 'utf8'));
    return { dir, ...p, original, settingsDir, run, copyOf };
  };
  const bg = (f, ...rest) => ['--bg', '--name', 'x', '--settings', f.original, ...rest];

  it('(1) missing key file: exit 3, claude not called, message without the key and the path', async () => {
    const f = fixture({ apiKey: { file: '/nonexistent/provider.key' } });
    const r = await f.run(bg(f, 'prompt'));
    expect(r.status).toBe(3);
    expect(r.called).toBe(false);
    expect(r.stderr).toMatch(/no usable provider API key/);
    expect(r.stderr).not.toContain('/nonexistent');
  });

  it('(2) empty key file: exit 3, claude not called', async () => {
    const f = fixture();
    writeFileSync(f.profile.apiKey.file, '');
    const r = await f.run(bg(f, 'prompt'));
    expect(r.status).toBe(3);
    expect(r.called).toBe(false);
  });

  it('(2b) key file with whitespace only: exit 3, claude not called, message without the file content (the same validation as the helper)', async () => {
    const f = fixture();
    writeFileSync(f.profile.apiKey.file, ' \n\t \r\n');
    const r = await f.run(bg(f, 'prompt'));
    expect(r.status).toBe(3);
    expect(r.called).toBe(false);
    expect(r.stderr).toMatch(/no usable provider API key/);
  });

  it('(3) no --settings in the arguments: exit 2, claude not called', async () => {
    const f = fixture();
    const r = await f.run(['--bg', '--name', 'x', 'prompt']);
    expect(r.status).toBe(2);
    expect(r.called).toBe(false);
  });

  it('(4) start: copy of --settings next to the original (0600) with the provider env, the role kept, the original unchanged, other arguments unchanged, child exit code passed on', async () => {
    const f = fixture();
    const before = readFileSync(f.original, 'utf8');
    const r = await f.run(['--bg', '--name', 'Lane A', '--settings', f.original, 'Read the brief and execute.'], { FAKE_EXIT: '0' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).not.toBeNull();
    const at = r.argv.indexOf('--settings');
    const copy = r.argv[at + 1];
    expect(copy).not.toBe(f.original);
    expect(dirname(copy)).toBe(dirname(f.original));
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(readFileSync(f.original, 'utf8')).toBe(before);
    expect(r.argv.slice(0, at)).toEqual(['--bg', '--name', 'Lane A']);
    expect(r.argv.at(-1)).toBe('Read the brief and execute.');
    const u = f.copyOf(r);
    expect(u.env.SESSION_ROLE).toBe('lane');
    expect(u.env.SESSION_LEAD).toBe('d7ec31aa');
    expect(u.env.SESSION_NAME).toBe('Lane A');
    expect(u.env.ANTHROPIC_BASE_URL).toBe('https://llm.acme.example/anthropic');
    expect(u.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('acme-large[1m]');
    expect(u.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('acme-large[1m]');
    expect(u.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('acme-small[1m]');
    expect(u.env.API_TIMEOUT_MS).toBe('3000000');
    for (const name of ['CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) expect(name in u.env, name).toBe(false);
    // The key in the env block excludes apiKeyHelper (a warning about two credential sources); the key is nowhere else.
    expect('apiKeyHelper' in u).toBe(false);
    expect(u.env.ANTHROPIC_AUTH_TOKEN).toBe(PLACEHOLDER_KEY);
    const withoutToken = { ...u, env: { ...u.env, ANTHROPIC_AUTH_TOKEN: undefined } };
    expect(JSON.stringify(withoutToken)).not.toContain(PLACEHOLDER_KEY);
    expect(r.stdout + r.stderr + r.argv.join(' ')).not.toContain(PLACEHOLDER_KEY);
  });

  it('(4c) the copy has the provider marker, a PATH with the shims and the Bash guard (PreToolUse); the session has no permissions.allow (only executors get it)', async () => {
    const f = fixture();
    const shims = join(f.dir, 'shim');
    const r = await f.run(bg(f, 'p'), { OMC_PROVIDER_SHIM_DIR: shims });
    const u = f.copyOf(r);
    const file = r.argv[r.argv.indexOf('--settings') + 1];
    expect(u.env.OMC_PROVIDER).toBe('acme');
    expect(u.env.OMC_PROVIDER_SETTINGS_FILE).toBe(file);
    expect(u.env.PATH.startsWith(`${shims}:`)).toBe(true);
    expect(u.hooks.PreToolUse.some((h) => h.matcher === 'Bash|Edit|Write|MultiEdit|NotebookEdit|Read|Grep|Glob' && h.hooks[0].command.includes('provider-bash-guard'))).toBe(true);
    expect('permissions' in u).toBe(false);
  });

  it('(4d) a test base URL of a foreign host: exit 2, claude not called (a forgotten test variable does not send the key to a foreign address)', async () => {
    const f = fixture();
    const r = await f.run(bg(f, 'p'), { OMC_PROVIDER_BASE_URL: 'https://foreign.example/api' });
    expect(r.status).toBe(2);
    expect(r.called).toBe(false);
  });

  it('(4f) a test base URL without a test key file: exit 2 (the test address only together with the key file)', async () => {
    const f = fixture();
    const r = await f.run(bg(f, 'p'), { OMC_PROVIDER_BASE_URL: 'http://127.0.0.1:1', OMC_PROVIDER_API_KEY_FILE: undefined });
    expect(r.status, r.stderr).toBe(2);
    expect(r.called).toBe(false);
  });

  it('(5) the env of the child comes from the allow-list: no ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN and no test variables; PATH and LANG stay, a random OTHER_VARIABLE does not pass', async () => {
    const f = fixture();
    const r = await f.run(bg(f, 'p'), { ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', CLAUDE_CODE_OAUTH_TOKEN: 'c', OTHER_VARIABLE: 'd', LANG: 'C.UTF-8' });
    expect(r.status, r.stderr).toBe(0);
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OMC_PROVIDER_CLAUDE_BIN', 'OMC_PROVIDER_PROFILES_FILE', 'OTHER_VARIABLE']) expect(r.env, name).not.toContain(name);
    for (const name of ['PATH', 'HOME', 'LANG']) expect(r.env, name).toContain(name);
  });

  it('(6) a repeated start on the same file (a repeat of the launcher without flags) overwrites the same copy, no new files', async () => {
    const f = fixture();
    const before = readdirSync(f.settingsDir).length;
    const a = await f.run(bg(f, 'p'));
    const b = await f.run(bg(f, 'p'));
    expect(a.argv[a.argv.indexOf('--settings') + 1]).toBe(b.argv[b.argv.indexOf('--settings') + 1]);
    expect(readdirSync(f.settingsDir).length).toBe(before + 1);
  });

  it('(7) the exit code of the child passes on (3 and 0); a missing binary gives 127', async () => {
    const f = fixture();
    const r3 = await f.run(bg(f, 'p'), { FAKE_EXIT: '3' });
    const r127 = await f.run(bg(f, 'p'), {}, { binary: join(f.dir, 'no-such-binary') });
    expect(r3.status).toBe(3);
    expect(r127.status).toBe(127);
    expect(r127.stderr).not.toContain(PLACEHOLDER_KEY);
  });

  it('(8) --settings is not a JSON object: exit 2, claude not called', async () => {
    const f = fixture();
    const bad = join(f.settingsDir, 'bad.json');
    writeFileSync(bad, '[1,2]');
    const r = await f.run(['--bg', '--name', 'x', '--settings', bad, 'p']);
    expect(r.status).toBe(2);
    expect(r.called).toBe(false);
  });

  it('(4g) copies older than 2 days (-provider.json) are removed at the start, foreign files stay', async () => {
    const f = fixture();
    const old = join(f.settingsDir, 'old-provider.json');
    const foreign = join(f.settingsDir, 'foreign.json');
    writeFileSync(old, '{}');
    writeFileSync(foreign, '{}');
    const long = new Date(Date.now() - 3 * 86400_000);
    utimesSync(old, long, long);
    utimesSync(foreign, long, long);
    const r = await f.run(bg(f, 'p'));
    expect(r.status).toBe(0);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
  });

  it('(11) the env allow-list of the session starter: sensitive variables do not pass; TERM, COLORTERM, SSH_AUTH_SOCK, CLAUDE_CONFIG_DIR, XDG_RUNTIME_DIR and the OMC_JEV prefix do; OTHER_VARIABLE does not', async () => {
    const f = fixture();
    const bad = { AWS_ACCESS_KEY_ID: 'a', AWS_REGION: 'b', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'x', ANTHROPIC_API_KEY: 'a', GH_TOKEN: 'g', MCP_TOOL_TIMEOUT: '1' };
    const session = { TERM: 'xterm-256color', COLORTERM: 'truecolor', SSH_AUTH_SOCK: '/tmp/agent', CLAUDE_CONFIG_DIR: join(f.dir, 'cc-dir'), XDG_RUNTIME_DIR: '/run/user/0', OMC_JEV_URL: 'http://127.0.0.1:9', OMC_JEV_LOG_DIR: join(f.dir, 'jev-log'), OMC_JEV: 'all:active' };
    const r = await f.run(bg(f, 'p'), { ...bad, ...session, LANG: 'C.UTF-8', OTHER_VARIABLE: 'd' });
    expect(r.status, r.stderr).toBe(0);
    expect(Object.keys(bad).filter((name) => r.env.includes(name))).toEqual([]);
    expect(Object.keys(session).every((name) => r.env.includes(name))).toBe(true);
    expect(r.env).not.toContain('OTHER_VARIABLE');
  });

  it('(12) the quiet variables DISABLE_AUTOUPDATER and DISABLE_ERROR_REPORTING from the parent reach the child env and are in the copy of --settings', async () => {
    const f = fixture();
    const r = await f.run(bg(f, 'p'), { DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1' });
    const u = f.copyOf(r);
    expect(r.status).toBe(0);
    for (const name of ['DISABLE_AUTOUPDATER', 'DISABLE_ERROR_REPORTING']) {
      expect(r.env).toContain(name);
      expect(u.env[name]).toBe('1');
    }
  });

  // Jev switches of the profile (launch.*): both are off by default.
  describe('Jev switches', () => {
    const switches = { launch: { disableJevInPrintMode: true, jevWithoutCompaction: true } };
    const current = 'all:active,compaction:active,tool-gate:off,intent:off,panel:off,slop-warning:off,task-size:shadow,session-routing:active';
    const afterwards = 'all:active,compaction:off,tool-gate:off,intent:off,panel:off,slop-warning:off,task-size:shadow,session-routing:active';

    it('(14) the copy has OMC_JEV with compaction:off (inherited from the process env, the other entries as in the input); a value from the --settings file is transformed too; the process env wins over the file; inherited off stays off; empty: no entry', async () => {
      const f = fixture(switches);
      const r = await f.run(bg(f, 'p'), { OMC_JEV: current });
      expect(r.status, r.stderr).toBe(0);
      expect(f.copyOf(r).env.OMC_JEV).toBe(afterwards);
      const withFile = fixture(switches, { settingsBody: { env: { SESSION_ROLE: 'lane', OMC_JEV: 'all:shadow,compaction:active' } } });
      expect(withFile.copyOf(await withFile.run(bg(withFile, 'p'))).env.OMC_JEV).toBe('all:shadow,compaction:off');
      expect(withFile.copyOf(await withFile.run(bg(withFile, 'p'), { OMC_JEV: 'all:active' })).env.OMC_JEV).toBe('all:active,compaction:off');
      expect(f.copyOf(await f.run(bg(f, 'p'), { OMC_JEV: 'off' })).env.OMC_JEV).toBe('off');
      expect('OMC_JEV' in f.copyOf(await f.run(bg(f, 'p'), { OMC_JEV: '' })).env).toBe(false);
    });

    it('(14b) -p without an inherited value: OMC_JEV=off in the env block of the copy and in the child env; the arguments with -p untouched', async () => {
      const f = fixture(switches);
      const r = await f.run(bg(f, '-p', 'prompt'));
      expect(r.status, r.stderr).toBe(0);
      expect(f.copyOf(r).env.OMC_JEV).toBe('off');
      expect(r.argv).toContain('-p');
      expect(r.argv.at(-1)).toBe('prompt');
      expect(r.omcjev).toBe('off');
    });

    it('(14c) --print without an inherited value: the same as -p', async () => {
      const f = fixture(switches);
      const r = await f.run(bg(f, '--print', 'prompt'));
      expect(f.copyOf(r).env.OMC_JEV).toBe('off');
      expect(r.omcjev).toBe('off');
    });

    it('(14d) -p with an inherited OMC_JEV=session-routing:active (the process env wins over the file): the copy and the child env are off', async () => {
      const f = fixture(switches);
      const r = await f.run(bg(f, '-p', 'prompt'), { OMC_JEV: 'session-routing:active' });
      expect(f.copyOf(r).env.OMC_JEV).toBe('off');
      expect(r.omcjev).toBe('off');
    });

    it('(14e) without -p: an inherited all:active gives a copy with compaction:off and a child env with the inherited value unchanged', async () => {
      const f = fixture(switches);
      const r = await f.run(bg(f, 'prompt'), { OMC_JEV: 'all:active' });
      expect(f.copyOf(r).env.OMC_JEV).toBe('all:active,compaction:off');
      expect(r.omcjev).toBe('all:active');
    });

    it('(14f) without -p and without an inherited value: no OMC_JEV in the copy and none in the child env', async () => {
      const f = fixture(switches);
      const r = await f.run(bg(f, 'prompt'));
      expect('OMC_JEV' in f.copyOf(r).env).toBe(false);
      expect(r.omcjev).toBe('');
    });

    it('(N1) both switches off (the default): -p and an inherited value change nothing in the copy and in the child env', async () => {
      const f = fixture();
      const r = await f.run(bg(f, '-p', 'prompt'), { OMC_JEV: current });
      expect(r.status, r.stderr).toBe(0);
      expect('OMC_JEV' in f.copyOf(r).env).toBe(false);
      expect(r.omcjev).toBe(current);
    });

    it('(N2) both switches off: an OMC_JEV value in the --settings file stays as it is', async () => {
      const f = fixture({}, { settingsBody: { env: { OMC_JEV: 'all:shadow,compaction:active' } } });
      const r = await f.run(bg(f, 'prompt'), { OMC_JEV: 'all:active,compaction:active' });
      expect(f.copyOf(r).env.OMC_JEV).toBe('all:shadow,compaction:active');
      expect(r.omcjev).toBe('all:active,compaction:active');
    });
  });

  // Quota gate: a loopback quota endpoint, the profile with the monitor-limits adapter.
  describe('quota gate', () => {
    const gated = () => fixture({ quota: { adapter: 'monitor-limits', url: QUOTA_URL } });
    const stateDirOf = (f) => join(f.dir, 'state');

    it('(15a) week at 100 %: exit 4 with level STOP, starter not called, message with the limit, breaker written (class quota, level)', async () => {
      const server = await serveQuota(() => ({ body: { success: true, data: { limits: [limit5h(12), limitWeek(100)] } } }));
      try {
        const f = gated();
        const r = await f.run(bg(f, 'p'), { OMC_PROVIDER_QUOTA_URL: server.origin });
        expect(r.status).toBe(4);
        expect(r.called).toBe(false);
        expect(r.stderr).toMatch(/level STOP/);
        expect(r.stderr).toMatch(/weekly window used at 100% \(threshold 99%\)/);
        expect(r.stderr).not.toContain(PLACEHOLDER_KEY);
        const breaker = JSON.parse(readFileSync(join(stateDirOf(f), 'breaker.json'), 'utf8'));
        expect(breaker.class).toBe('quota');
        expect(breaker.limit).toBe('week');
        expect(breaker.percent).toBe(100);
        expect(breaker.level).toBe('STOP');
        expect(breaker.until).toBeGreaterThan(Date.now());
      } finally { await server.close(); }
    });

    it('(15b) a second start with an active breaker: exit 4, the endpoint is not called again (counter 1 for 2 starts)', async () => {
      const server = await serveQuota(() => ({ body: { success: true, data: { limits: [limit5h(12), limitWeek(100)] } } }));
      try {
        const f = gated();
        const env = { OMC_PROVIDER_QUOTA_URL: server.origin };
        await f.run(bg(f, 'p'), env);
        const r = await f.run(bg(f, 'p'), env);
        expect(r.status).toBe(4);
        expect(r.called).toBe(false);
        expect(server.state.hits).toBe(1);
      } finally { await server.close(); }
    });

    it('(15c) below the thresholds (window 12 %, week 95 %): the start is allowed (below the pause threshold 96)', async () => {
      const server = await serveQuota(() => ({ body: { success: true, data: { limits: [limit5h(12), limitWeek(95)] } } }));
      try {
        const f = gated();
        const r = await f.run(bg(f, 'p'), { OMC_PROVIDER_QUOTA_URL: server.origin });
        expect(r.status, r.stderr).toBe(0);
        expect(r.called).toBe(true);
        expect(server.state.hits).toBe(1);
      } finally { await server.close(); }
    });

    it('(15d) HTTP 401: exit 4, a message about the key, starter not called', async () => {
      const server = await serveQuota(() => ({ status: 401, body: { success: false, msg: 'token expired' } }));
      try {
        const f = gated();
        const r = await f.run(bg(f, 'p'), { OMC_PROVIDER_QUOTA_URL: server.origin });
        expect(r.status).toBe(4);
        expect(r.called).toBe(false);
        expect(r.stderr).toMatch(/rejects the API key.*401/);
        expect(r.stderr).not.toContain(PLACEHOLDER_KEY);
      } finally { await server.close(); }
    });
  });

  // A signal sent to the launcher goes to the child (the fake `claude`); the launcher ends after it with 128 + the signal number, the slot is released.
  describe.each([['SIGTERM', 143, '16'], ['SIGINT', 130, '16b'], ['SIGHUP', 129, '16c']])('%s to the launcher', (signal, code, label) => {
    it(`(${label}) goes to the starter, the launcher exits with ${code}, the slot is released`, async () => {
      const f = fixture({ limits: { maxSessions: 2, slotWaitMs: 15000 } });
      const slots = join(f.dir, 'state', 'slots');
      const slotFiles = () => (existsSync(slots) ? readdirSync(slots).filter((n) => /^slot-/.test(n)) : []);
      const child = spawn(process.execPath, [LAUNCH, ...bg(f, 'p')], { env: { ...f.env, OMC_PROVIDER_CLAUDE_BIN: signalStarter }, stdio: 'ignore' });
      const closed = new Promise((done) => child.on('close', (c) => done(c)));
      try {
        for (let i = 0; i < 100 && !existsSync(join(f.env.HOME, 'signal.pid')); i += 1) await wait(50);
        expect(existsSync(join(f.env.HOME, 'signal.pid'))).toBe(true);
        expect(slotFiles().length).toBe(1);
        process.kill(child.pid, signal);
        expect(await closed).toBe(code);
        const starterPid = Number(readFileSync(join(f.env.HOME, 'signal.pid'), 'utf8'));
        let alive = true;
        try { process.kill(starterPid, 0); } catch { alive = false; }
        expect(alive).toBe(false);
        expect(slotFiles().length).toBe(0);
      } finally {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        try { process.kill(Number(readFileSync(join(f.env.HOME, 'signal.pid'), 'utf8')), 'SIGKILL'); } catch { /* gone */ }
      }
    });
  });

  it('(23) the launcher holds a slot during the session and releases it when the starter ends; a busy slot (limit 1, a live foreign owner, no wait): exit 3, starter not called; a bad limit value: exit 2, starter not called', async () => {
    const f = fixture({ limits: { maxSessions: 2, slotWaitMs: 15000 } });
    const slots = join(f.dir, 'state', 'slots');
    const count = () => (existsSync(slots) ? readdirSync(slots).filter((n) => /^slot-/.test(n)).length : 0);
    const waiting = join(f.dir, 'starter-waits');
    writeFileSync(waiting, `#!/bin/bash\nprintf '%s\\n' "$@" > "$HOME/w23.argv"\nwhile [ ! -f "$HOME/pstop" ]; do sleep 0.05; done\n`, { mode: 0o755 });
    const child = spawn(process.execPath, [LAUNCH, ...bg(f, 'prompt')], { env: { ...f.env, OMC_PROVIDER_CLAUDE_BIN: waiting }, stdio: 'ignore' });
    const closed = new Promise((done) => child.on('close', (c) => done(c)));
    for (let i = 0; i < 100 && count() === 0; i += 1) await wait(50);
    expect(count()).toBe(1);
    writeFileSync(join(f.env.HOME, 'pstop'), '');
    expect(await closed).toBe(0);
    expect(existsSync(join(f.env.HOME, 'w23.argv'))).toBe(true);
    expect(count()).toBe(0);
    unlinkSync(join(f.env.HOME, 'w23.argv'));
    const busy = fixture({ limits: { maxSessions: 1, slotWaitMs: 0 } });
    const busySlots = join(busy.dir, 'state', 'slots');
    mkdirSync(busySlots, { recursive: true, mode: 0o700 });
    const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      writeFileSync(join(busySlots, 'slot-foreign.json'), json({ pid: holder.pid, ts: Date.now() }));
      const refused = await busy.run(bg(busy, 'prompt'));
      expect(refused.status, refused.stderr).toBe(3);
      expect(refused.called).toBe(false);
      unlinkSync(join(busySlots, 'slot-foreign.json'));
      const bad = await busy.run(bg(busy, 'prompt'), { OMC_PROVIDER_MAX_SESSIONS: 'abc' });
      expect(bad.status, bad.stderr).toBe(2);
      expect(bad.called).toBe(false);
    } finally { holder.kill('SIGKILL'); }
  });

  it('(18c) the key and the token appear neither in the argv of the child nor in the process list while the session is alive', async () => {
    const f = fixture();
    const sleeper = join(f.dir, 'starter-ps');
    writeFileSync(sleeper, `#!/bin/bash\nprintf '%s' $$ > "$HOME/ps.pid"\nexec sleep 30\n`, { mode: 0o755 });
    const child = spawn(process.execPath, [LAUNCH, ...bg(f, 'p')], { env: { ...f.env, OMC_PROVIDER_CLAUDE_BIN: sleeper }, stdio: 'ignore' });
    try {
      for (let i = 0; i < 100 && !existsSync(join(f.env.HOME, 'ps.pid')); i += 1) await wait(50);
      expect(existsSync(join(f.env.HOME, 'ps.pid'))).toBe(true);
      const ps = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
      expect(ps.stdout).not.toContain(PLACEHOLDER_KEY);
    } finally {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      try { process.kill(Number(readFileSync(join(f.env.HOME, 'ps.pid'), 'utf8')), 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('(17) a start error of the binary (it does not exist): exit 127, the slot is released, no slots after the start', async () => {
    const f = fixture({ limits: { maxSessions: 2, slotWaitMs: 15000 } });
    const r = await f.run(bg(f, 'p'), {}, { binary: join(f.dir, 'no-such-binary') });
    const slots = join(f.dir, 'state', 'slots');
    expect(r.status).toBe(127);
    expect(r.stderr).toMatch(/no usable claude binary|cannot start/);
    expect(existsSync(slots) ? readdirSync(slots).filter((n) => /^slot-/.test(n)) : []).toEqual([]);
  });

  it('a start through a running proxy gives the copy the client token and the proxy address, never the key', async () => {
    const f = fixture();
    const proxyDir = join(f.dir, 'state', 'proxy');
    mkdirSync(proxyDir, { recursive: true });
    const stub = stubProxyProcess(proxyDir);
    try {
      writeFileSync(join(proxyDir, 'proxy.pid'), String(stub.pid));
      writeFileSync(join(proxyDir, 'proxy.port'), '33177');
      writeFileSync(join(proxyDir, 'client-token'), `${'ab'.repeat(32)}\n`, { mode: 0o600 });
      const r = await f.run(bg(f, 'p'));
      expect(r.status, r.stderr).toBe(0);
      const u = f.copyOf(r);
      expect(u.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:33177');
      expect(u.env.ANTHROPIC_AUTH_TOKEN).toBe('ab'.repeat(32));
      expect(u.env.OMC_ALLOW_LOOPBACK_PROXY_PORT).toBe('33177');
      expect(JSON.stringify(u)).not.toContain(PLACEHOLDER_KEY);
    } finally { await stub.stop(); }
  });

  it('(N3) without a profile file the launcher exits with 2 and does not call claude', async () => {
    const f = fixture();
    const r = await f.run(bg(f, 'p'), { OMC_PROVIDER_PROFILES_FILE: join(f.dir, 'missing.jsonc') });
    expect(r.status).toBe(2);
    expect(r.called).toBe(false);
  });
});
