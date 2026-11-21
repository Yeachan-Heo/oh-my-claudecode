/* global process, setTimeout, URL */
// Worker wrapper: the three modes (nested claude, team worker, plain claude), roles, settings of a provider worker,
// keys, fixed model and effort, role recovery from the team state, slots, integrity check and signals.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, writeProfile, waitProcessGone, PLACEHOLDER_KEY } from './_helpers.mjs';

const WORKER_SCRIPT = fileURLToPath(new URL('../../../scripts/provider/provider-worker.cjs', import.meta.url));
const PROVIDER_DIR = fileURLToPath(new URL('../../../scripts/provider/', import.meta.url));
const RULE_FILE = fileURLToPath(new URL('../../../templates/provider/worker-rule.md', import.meta.url));
const vocab = createRequire(import.meta.url)(join(PROVIDER_DIR, 'lib', 'vocab.cjs'));
const json = JSON.stringify;
const QUOTA_URL = 'https://quota.acme.example/api/monitor/usage/quota/limit';
const limit5h = (percentage) => ({ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage, nextResetTime: Date.now() + 3600_000 });
const limitWeek = (percentage) => ({ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage, nextResetTime: Date.now() + 3 * 86400_000 });

// Quota endpoint on loopback: `reply` gives { status, body } for each request; state.hits counts the requests.
function serveQuota(reply) {
  const state = { hits: 0, reply };
  const server = createServer((req, res) => {
    state.hits += 1;
    const { status = 200, body = {} } = state.reply();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(json(body));
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ state, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((closed) => server.close(() => closed())) })));
}
const limitsBody = (...limits) => ({ body: { success: true, data: { limits } } });
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const TEAM = { OMC_TEAM_WORKER: 'team-a/worker-1', OMC_TEAM_NAME: 'team-a', OMC_TEAM_ROLE: 'executor' };

describe.skipIf(process.platform === 'win32')('provider worker wrapper', () => {
  let tmp;
  let realClaude;
  let counter = 0;
  beforeAll(() => {
    tmp = makeTmp('provider-worker-');
    // Fake real `claude`: argv as JSON, env names, the value of ANTHROPIC_AUTH_TOKEN, a stdout file, an optional transcript;
    // the exit code from $HOME/fake.exit, FAKE_REJECT-like behaviour from $HOME/fake.reject (a start with the argument `opus` fails).
    realClaude = join(tmp.dir, 'real-claude');
    writeFileSync(realClaude, [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      'const home = process.env.HOME;',
      'const argv = process.argv.slice(2);',
      'const read = (n) => { try { return fs.readFileSync(home + "/" + n, "utf8"); } catch { return null; } };',
      'if (read("fake.reject") !== null && argv.includes("opus")) { fs.appendFileSync(home + "/fake.rejected", "x"); process.exit(2); }',
      'fs.writeFileSync(home + "/fake.argv", JSON.stringify(argv));',
      'fs.writeFileSync(home + "/fake.env", JSON.stringify(Object.keys(process.env).sort()));',
      'if (process.env.ANTHROPIC_AUTH_TOKEN) fs.writeFileSync(home + "/fake.auth", process.env.ANTHROPIC_AUTH_TOKEN);',
      'fs.writeFileSync(home + "/fake.launch", process.env.OMC_WORKER_LAUNCH_ATTEMPT_ID ?? "");',
      'fs.writeFileSync(home + "/fake.omcstate", process.env.OMC_STATE_DIR ?? "");',
      'const out = read("fake.stdout"); if (out !== null) process.stdout.write(out);',
      'const transcript = read("fake.transcript");',
      'if (transcript !== null) { const i = argv.indexOf("--session-id"); const sid = i >= 0 ? argv[i + 1] : "none"; fs.mkdirSync(home + "/.claude/projects/atest", { recursive: true }); fs.writeFileSync(home + "/.claude/projects/atest/" + sid + ".jsonl", transcript + "\\n"); }',
      'const touch = read("fake.touch"); if (touch !== null) fs.appendFileSync(touch.trim(), "changed\\n");',
      'process.exit(Number(read("fake.exit") ?? 0));',
      '',
    ].join('\n'), { mode: 0o755 });
    chmodSync(realClaude, 0o755);
  });
  afterAll(() => tmp.cleanup());

  // A fresh profile fixture with the values of an installation that fixes the worker model and effort.
  const fixture = (overrides = {}) => {
    const dir = join(tmp.dir, `f${++counter}`);
    mkdirSync(join(dir, 'home'), { recursive: true });
    const p = writeProfile(dir, overrides, { tuned: true });
    const home = p.env.HOME;
    const state = join(dir, 'state');
    const rows = () => (existsSync(join(state, 'workers.jsonl')) ? readFileSync(join(state, 'workers.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
    const read = (name) => { try { return readFileSync(join(home, name), 'utf8'); } catch { return null; } };
    const run = (extraEnv = {}, args = ['--dangerously-skip-permissions', '--model', 'sonnet'], { script = WORKER_SCRIPT, binary = realClaude, fake = {}, cwd } = {}) => {
      for (const name of ['fake.argv', 'fake.env', 'fake.auth', 'fake.rejected', 'fake.reject', 'fake.exit', 'fake.stdout', 'fake.transcript', 'fake.touch']) { try { unlinkSync(join(home, name)); } catch { /* absent */ } }
      for (const [name, value] of Object.entries(fake)) writeFileSync(join(home, `fake.${name}`), String(value));
      const env = { ...p.env, OMC_PROVIDER_CLAUDE_BIN: binary, ...extraEnv };
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
      const r = spawnSync(script.endsWith('.cjs') ? process.execPath : script, script.endsWith('.cjs') ? [script, ...args] : args, { encoding: 'utf8', env, cwd });
      const argv = read('fake.argv') && JSON.parse(read('fake.argv'));
      return { ...r, called: argv !== null, argv, env: read('fake.env') && JSON.parse(read('fake.env')), auth: read('fake.auth'), rejected: read('fake.rejected') !== null };
    };
    const settingsOf = (r) => JSON.parse(readFileSync(r.argv[r.argv.lastIndexOf('--settings') + 1], 'utf8'));
    // The same start as run(), but asynchronous: an in-process quota server can answer while the wrapper runs.
    const runAsync = (extraEnv = {}, args = ['--dangerously-skip-permissions', '--model', 'sonnet'], { fake = {} } = {}) => new Promise((done) => {
      for (const name of ['fake.argv', 'fake.env', 'fake.auth', 'fake.exit', 'fake.stdout', 'fake.transcript']) { try { unlinkSync(join(home, name)); } catch { /* absent */ } }
      for (const [name, value] of Object.entries(fake)) writeFileSync(join(home, `fake.${name}`), String(value));
      const env = { ...p.env, OMC_PROVIDER_CLAUDE_BIN: realClaude, ...extraEnv };
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
      const child = spawn(process.execPath, [WORKER_SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => { const argv = read('fake.argv') && JSON.parse(read('fake.argv')); done({ status, stdout, stderr, called: argv !== null, argv }); });
    });
    return { dir, home, state, ...p, rows, read, run, runAsync, settingsOf };
  };

  it('(1) not a worker and not a provider process: arguments and env unchanged, claude called', () => {
    const f = fixture();
    const r = f.run({ ANTHROPIC_API_KEY: 'x' }, ['--version']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.called).toBe(true);
    expect(r.argv).toEqual(['--version']);
    expect(r.env).toContain('ANTHROPIC_API_KEY');
  });

  it('(2) executor worker: --settings with the provider env, marker, PATH with the shims, Bash guard, --session-id, an event row with the provider, the key only in the process env (not in the file, the log or the output)', () => {
    const f = fixture();
    const r = f.run({ ...TEAM, ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', CLAUDE_CODE_OAUTH_TOKEN: 'c' });
    expect(r.status, r.stderr).toBe(0);
    const at = r.argv.indexOf('--settings');
    const file = r.argv[at + 1];
    const sid = r.argv[r.argv.indexOf('--session-id') + 1];
    expect(at).toBeGreaterThan(0);
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(r.argv).not.toContain('--dangerously-skip-permissions');
    expect(r.argv[r.argv.indexOf('--model') + 1]).toBe('haiku');
    expect(r.argv[r.argv.indexOf('--effort') + 1]).toBe('max');
    const u = JSON.parse(readFileSync(file, 'utf8'));
    expect(u.env.ANTHROPIC_BASE_URL).toBe('https://llm.acme.example/anthropic');
    expect(u.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('acme-large[1m]');
    expect(u.env.OMC_PROVIDER).toBe('acme');
    expect(u.env.OMC_PROVIDER_SETTINGS_FILE).toBe(file);
    const shims = join(f.state, 'shims-worker');
    expect(u.env.PATH.startsWith(`${shims}:`)).toBe(true);
    expect(statSync(join(shims, 'claude')).mode & 0o100).toBeTruthy();
    expect('apiKeyHelper' in u).toBe(false);
    expect(u.hooks.PreToolUse[0].matcher).toBe('Bash|Edit|Write|MultiEdit|NotebookEdit|Read|Grep|Glob');
    expect(u.hooks.PreToolUse[0].hooks[0].command).toContain('provider-bash-guard');
    expect(u.permissions.allow).toEqual(['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob']);
    expect(r.auth).toBe(PLACEHOLDER_KEY);
    expect(r.env).toContain('ANTHROPIC_AUTH_TOKEN');
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OMC_PROVIDER_CLAUDE_BIN']) expect(r.env, name).not.toContain(name);
    const row = f.rows()[0];
    expect(row).toMatchObject({ point: 'team-worker', provider: 'acme', role: 'worker-executor', session_id: sid, name: 'team-a/worker-1' });
    expect(json(u) + r.stdout + r.stderr + json(row) + r.argv.join(' ')).not.toContain(PLACEHOLDER_KEY);
  });

  it('(3) code-reviewer worker: provider claude, no --settings, env unchanged (tokens stay), --session-id and a row', () => {
    const f = fixture();
    const r = f.run({ ...TEAM, OMC_TEAM_ROLE: 'code-reviewer', ANTHROPIC_API_KEY: 'a' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).not.toContain('--settings');
    expect(r.env).toContain('ANTHROPIC_API_KEY');
    expect(r.auth).toBeNull();
    const row = f.rows().at(-1);
    expect(row.provider).toBe('claude');
    expect(row.role).toBe('worker-code-reviewer');
    expect(row.session_id).toBe(r.argv[r.argv.indexOf('--session-id') + 1]);
  });

  it('(3b) a Claude role started from a process with a provider address in the env: provider variables stripped from the child env, a row with provider claude', () => {
    const f = fixture();
    const r = f.run({ ...TEAM, OMC_TEAM_ROLE: 'code-reviewer', ANTHROPIC_BASE_URL: 'https://llm.acme.example/anthropic', ANTHROPIC_MODEL: 'acme-large[1m]', ANTHROPIC_DEFAULT_SONNET_MODEL: 'acme-large[1m]', ANTHROPIC_AUTH_TOKEN: 'k' });
    expect(r.status, r.stderr).toBe(0);
    for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_AUTH_TOKEN']) expect(r.env, name).not.toContain(name);
    expect(f.rows().at(-1)).toMatchObject({ provider: 'claude', provider_env_stripped: true });
    const ok = f.run({ ...TEAM, OMC_TEAM_ROLE: 'code-reviewer', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });
    expect(ok.env).toContain('ANTHROPIC_BASE_URL');
  });

  it('(4) OMC_PROVIDER_ROLES changes the list of provider roles', () => {
    const f = fixture();
    const r = f.run({ ...TEAM, OMC_TEAM_ROLE: 'debugger', OMC_PROVIDER_ROLES: 'executor,debugger' });
    expect(r.argv).toContain('--settings');
    expect(f.rows().at(-1).provider).toBe('acme');
  });

  it('(5) provider worker without a key (missing, empty, whitespace only, whitespace inside): exit 3, claude not called, an aborted row, a message without the key path', () => {
    const f = fixture();
    const keyFile = f.profile.apiKey.file;
    for (const [label, content] of [['missing', null], ['empty', ''], ['blank', ' \n\t\n'], ['inside', 'AB\nCD\n']]) {
      if (content === null) { try { unlinkSync(keyFile); } catch { /* absent */ } } else writeFileSync(keyFile, content, { mode: 0o600 });
      const r = f.run({ ...TEAM });
      expect(r.status, label).toBe(3);
      expect(r.called, label).toBe(false);
      expect(r.stderr, label).toMatch(/no usable provider API key/);
      expect(r.stderr, label).not.toContain(keyFile);
      expect(f.rows().at(-1), label).toMatchObject({ result: 'aborted-no-key', session_id: null });
    }
  });

  it('(6) the test address only for a loopback host and only with a test key file: a foreign address and an address without the key file give exit 2', () => {
    const f = fixture();
    const a = f.run({ ...TEAM, OMC_PROVIDER_BASE_URL: 'https://foreign.example/api', OMC_PROVIDER_API_KEY_FILE: f.profile.apiKey.file });
    const b = f.run({ ...TEAM, OMC_PROVIDER_BASE_URL: 'http://127.0.0.1:1' });
    expect(a.status).toBe(2);
    expect(a.called).toBe(false);
    expect(b.status).toBe(2);
    expect(b.called).toBe(false);
  });

  it('(7) a nested claude in a provider process through the shim `claude`: --settings of the session at the end, session env (with ANTHROPIC_AUTH_TOKEN) unchanged, a --settings placed before `--`', () => {
    const f = fixture();
    const session = join(f.dir, 'session-settings.json');
    writeFileSync(session, '{}\n', { mode: 0o600 });
    expect(f.run({ ...TEAM }).status).toBe(0); // the start of a worker writes the shims
    const shim = join(f.state, 'shims-worker', 'claude');
    const r = f.run({ OMC_PROVIDER_SETTINGS_FILE: session, ANTHROPIC_AUTH_TOKEN: PLACEHOLDER_KEY }, ['-p', 'OK'], { script: shim });
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toEqual(['-p', 'OK', '--settings', session]);
    expect(r.auth).toBe(PLACEHOLDER_KEY);
    const own = f.run({ OMC_PROVIDER_SETTINGS_FILE: session }, ['-p', '--settings', '{"model":"sonnet"}', '--', 'x'], { script: shim });
    expect(own.argv).toEqual(['-p', '--settings', '{"model":"sonnet"}', '--settings', session, '--', 'x']);
  });

  it('(8) a nested claude whose session settings file is gone: exit 3, claude not called', () => {
    const f = fixture();
    const r = f.run({ OMC_PROVIDER_SETTINGS_FILE: join(f.dir, 'missing.json') }, ['-p', 'OK']);
    expect(r.status).toBe(3);
    expect(r.called).toBe(false);
  });

  it('(8b) plain mode with a provider address or a provider marker in the env and no session settings: exit 3, claude not called', () => {
    const f = fixture();
    const a = f.run({ ANTHROPIC_BASE_URL: 'https://llm.acme.example/anthropic' }, ['-p', 'OK']);
    const b = f.run({ OMC_PROVIDER: 'acme' }, ['-p', 'OK']);
    expect(a.status).toBe(3);
    expect(a.called).toBe(false);
    expect(b.status).toBe(3);
    expect(b.called).toBe(false);
  });

  it('(9) no real binary or the wrapper itself as the binary: exit 127 (no loop)', () => {
    const f = fixture();
    expect(f.run({}, ['--version'], { binary: join(f.dir, 'no-such-claude') }).status).toBe(127);
    expect(f.run({}, ['--version'], { binary: WORKER_SCRIPT }).status).toBe(127);
  });

  it('(9b) roles come from the profile file, the process env wins over the file', () => {
    const f = fixture({ roles: ['executor', 'debugger'] });
    const r = f.run({ ...TEAM, OMC_TEAM_ROLE: 'debugger' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toContain('--settings');
    expect(f.rows().at(-1).provider).toBe('acme');
    const r2 = f.run({ ...TEAM, OMC_TEAM_ROLE: 'debugger', OMC_PROVIDER_ROLES: 'executor' });
    expect(r2.argv).not.toContain('--settings');
    expect(f.rows().at(-1).provider).toBe('claude');
  });

  it('(9c) profile selection of a worker: passthrough to plain Claude only when nothing is configured (no profiles file, no OMC_PROVIDER_PROFILE); a profile named by OMC_PROVIDER_PROFILE or defaultProfile that is not defined, several profiles and no choice, or a named profile without a file: exit 2, claude not started, no key read', () => {
    const f = fixture();
    const missingFile = join(f.dir, 'no-such-providers.jsonc');
    // genuinely unconfigured: plain Claude, arguments unchanged
    const plain = f.run({ ...TEAM, OMC_PROVIDER_PROFILES_FILE: missingFile }, ['--version']);
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.argv).toEqual(['--version']);
    const refused = (r, pattern) => {
      expect(r.status, `${r.stderr}`).toBe(2);
      expect(r.called, 'claude must not start').toBe(false);
      expect(r.stderr).toMatch(pattern);
    };
    // OMC_PROVIDER_PROFILE misspelled, with a valid profiles file
    refused(f.run({ ...TEAM, OMC_PROVIDER_PROFILE: 'typo' }), /provider profile "typo" is not defined/);
    // OMC_PROVIDER_PROFILE names a profile but there is no profiles file
    refused(f.run({ ...TEAM, OMC_PROVIDER_PROFILES_FILE: missingFile, OMC_PROVIDER_PROFILE: 'acme' }), /no provider profiles file/);
    // defaultProfile renamed or removed
    const doc = JSON.parse(readFileSync(f.file, 'utf8'));
    writeFileSync(f.file, json({ ...doc, defaultProfile: 'gone' }));
    refused(f.run({ ...TEAM }), /provider profile "gone" is not defined/);
    // several profiles and no choice at all
    writeFileSync(f.file, json({ profiles: { ...doc.profiles, second: doc.profiles.acme } }));
    refused(f.run({ ...TEAM }), /no provider profile selected/);
    // control: the same file with a choice starts the provider worker
    const chosen = f.run({ ...TEAM, OMC_PROVIDER_PROFILE: 'second' });
    expect(chosen.status, chosen.stderr).toBe(0);
    expect(chosen.argv).toContain('--settings');
  });

  it('(9f-model) a provider role always gets the fixed model and effort of the profile; the environment overrides them; a value that is not allowed gives exit 2 with an aborted row and no start', () => {
    const f = fixture();
    const arg = (r, flag) => r.argv[r.argv.indexOf(flag) + 1];
    const r = f.run({ ...TEAM }, ['--dangerously-skip-permissions', '--model', 'opus', '--effort', 'low']);
    expect(arg(r, '--model')).toBe('haiku');
    expect(arg(r, '--effort')).toBe('max');
    expect(r.argv.filter((x) => x === '--model').length).toBe(1);
    expect(r.argv.filter((x) => x === '--effort').length).toBe(1);
    expect(r.argv).not.toContain('opus');
    expect(f.rows()[0].started_with).toEqual({ model: 'haiku', effort: 'max' });
    const r2 = f.run({ ...TEAM, OMC_PROVIDER_WORKER_MODEL: 'sonnet', OMC_PROVIDER_WORKER_EFFORT: 'high' });
    expect(arg(r2, '--model')).toBe('sonnet');
    expect(arg(r2, '--effort')).toBe('high');
    for (const bad of ['a b;rm', '--settings']) {
      const x = f.run({ ...TEAM, OMC_PROVIDER_WORKER_MODEL: bad });
      expect(x.status, bad).toBe(2);
      expect(x.called, bad).toBe(false);
      expect(f.rows().at(-1)).toMatchObject({ result: 'aborted-bad-config', provider: 'acme' });
    }
    // An effort outside the dictionary: exit 2, an aborted-bad-config row and the message, also without a key (the check runs before the key is read); a Claude role is not affected.
    const badEffort = f.run({ ...TEAM, OMC_PROVIDER_WORKER_EFFORT: 'ultra' });
    expect(badEffort.status).toBe(2);
    expect(badEffort.called).toBe(false);
    expect(badEffort.stderr).toMatch(/not allowed/);
    expect(f.rows().at(-1)).toMatchObject({ result: 'aborted-bad-config', provider: 'acme' });
    unlinkSync(f.profile.apiKey.file);
    const noKeyBad = f.run({ ...TEAM, OMC_PROVIDER_WORKER_EFFORT: 'ultra' });
    writeFileSync(f.profile.apiKey.file, `${PLACEHOLDER_KEY}\n`, { mode: 0o600 });
    expect(noKeyBad.status).toBe(2);
    expect(noKeyBad.stderr).toMatch(/not allowed/);
    expect(noKeyBad.stderr).not.toMatch(/no usable provider API key/);
    const reviewerBad = f.run({ ...TEAM, OMC_TEAM_ROLE: 'code-reviewer', OMC_PROVIDER_WORKER_EFFORT: 'ultra' });
    expect(reviewerBad.status, reviewerBad.stderr).toBe(0);
    expect(r.env).not.toContain('OMC_PROVIDER_WORKER_MODEL');
    const rejected = f.run({ ...TEAM, OMC_PROVIDER_WORKER_MODEL: 'opus' }, ['--dangerously-skip-permissions'], { fake: { reject: 1 } });
    expect(rejected.rejected).toBe(true);
    expect(rejected.status).toBe(2);
    expect(rejected.called).toBe(false);
  });

  // Provider worker slots: the start waits or refuses at the limit and the slot is released at the end.
  it('(23) the env allow-list of a provider role: 14 sensitive variables do not reach the child; the child env equals the allow-list (terminal variables of the parent: TERM, COLORTERM, TMUX, TMUX_PANE, SHELL, LOGNAME, plus PATH, HOME, OMC_TEAM_* and the explicit ANTHROPIC_AUTH_TOKEN)', () => {
    const f = fixture();
    const bad = { AWS_ACCESS_KEY_ID: 'a', AWS_REGION: 'b', VERTEX_REGION_CLAUDE_X: 'c', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'x', CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'r', CLAUDE_CODE_OAUTH_SCOPES: 's', CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '1', CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_EFFORT_LEVEL: 'max', MCP_TOOL_TIMEOUT: '1', ANTHROPIC_API_KEY: 'a', GH_TOKEN: 'g' };
    const terminal = { TERM: 'xterm-256color', COLORTERM: 'truecolor', TMUX: '/tmp/tmux-0/x', TMUX_PANE: '%3', SHELL: '/bin/bash', LOGNAME: 'worker' };
    const r = f.run({ ...TEAM, ...bad, ...terminal });
    expect(r.status, r.stderr).toBe(0);
    expect(Object.keys(bad).filter((name) => r.env.includes(name))).toEqual([]);
    expect(Object.keys(terminal).every((name) => r.env.includes(name))).toBe(true);
    expect(r.env).toEqual(['ANTHROPIC_AUTH_TOKEN', 'COLORTERM', 'HOME', 'LOGNAME', 'OMC_TEAM_NAME', 'OMC_TEAM_ROLE', 'OMC_TEAM_WORKER', 'PATH', 'SHELL', 'TERM', 'TMUX', 'TMUX_PANE']);
  });

  it('(23c) an env key source (apiKey.env): a provider role reads the key from the variable and passes it only as ANTHROPIC_AUTH_TOKEN (the variable itself is not in its child env); a Claude role does not keep the variable either; without that profile field a Claude role keeps its environment as before', () => {
    const KEY = 'ENV-SOURCE-KEY-0123456789';
    const f = fixture({ apiKey: { env: 'ACME_API_KEY' } });
    const provider = f.run({ ...TEAM, ACME_API_KEY: KEY });
    expect(provider.status, provider.stderr).toBe(0);
    expect(provider.auth).toBe(KEY);
    expect(provider.env).not.toContain('ACME_API_KEY');
    const reviewer = f.run({ ...TEAM, OMC_TEAM_ROLE: 'code-reviewer', ACME_API_KEY: KEY, ACME_OTHER: 'kept' });
    expect(reviewer.status, reviewer.stderr).toBe(0);
    expect(reviewer.env).not.toContain('ACME_API_KEY');
    expect(reviewer.env).toContain('ACME_OTHER');
    expect(f.rows().at(-1)).toMatchObject({ provider: 'claude', provider_env_stripped: true });
    const other = fixture();
    const plain = other.run({ ...TEAM, OMC_TEAM_ROLE: 'code-reviewer', ACME_API_KEY: 'unrelated' });
    expect(plain.env).toContain('ACME_API_KEY');
    expect(other.rows().at(-1).provider_env_stripped).toBeUndefined();
  });

  it('(23b) the quiet variables DISABLE_AUTOUPDATER and DISABLE_ERROR_REPORTING of the parent reach the child env of a provider role and are in the --settings file', () => {
    const f = fixture();
    const r = f.run({ ...TEAM, DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1' });
    const u = f.settingsOf(r);
    expect(r.status, r.stderr).toBe(0);
    for (const name of ['DISABLE_AUTOUPDATER', 'DISABLE_ERROR_REPORTING']) {
      expect(r.env).toContain(name);
      expect(u.env[name]).toBe('1');
    }
  });

  it('(23d) the prefix rule: LC_ALL and TMPDIR pass, OLDPWD does not; a Claude role keeps the full environment', () => {
    const f = fixture();
    const provider = f.run({ ...TEAM, LC_ALL: 'C.UTF-8', TMPDIR: tmp.dir, OLDPWD: '/tmp' });
    expect(provider.status, provider.stderr).toBe(0);
    expect(provider.env).toContain('LC_ALL');
    expect(provider.env).toContain('TMPDIR');
    expect(provider.env).not.toContain('OLDPWD');
    const claude = f.run({ ...TEAM, OMC_TEAM_ROLE: 'code-reviewer', SHLVL: '2', OLDPWD: '/tmp', OTHER: 'x' });
    expect(claude.status, claude.stderr).toBe(0);
    for (const name of ['SHLVL', 'OLDPWD', 'OTHER']) expect(claude.env, name).toContain(name);
  });

  // Failure classification of a provider worker (final row with the field class).
  describe('failure class', () => {
    const classed = (extra = {}) => fixture({ errorCodes: { quota: [1308, 1310], throttle: [1305] }, quota: { adapter: 'monitor-limits', url: QUOTA_URL }, ...extra });

    it('(failure-class-2) a failed provider worker (exit 1) without a transcript and with a failed quota read (closed port): exactly one final row with class other and exit_code 1', () => {
      const f = classed();
      const before = f.rows().length;
      const r = f.run({ ...TEAM, OMC_PROVIDER_QUOTA_URL: 'http://127.0.0.1:1' }, ['--model', 'sonnet'], { fake: { exit: 1 } });
      const rows = f.rows();
      expect(r.status, r.stderr).toBe(1);
      expect(rows.length).toBe(before + 2);
      const last = rows.at(-1);
      expect(last).toMatchObject({ result: 'end', exit_code: 1, class: 'other', provider: 'acme' });
      expect(last.session_id).toBe(rows.at(-2).session_id);
    });

    it('(failure-class-2b) a failed provider worker next to a quota endpoint: percentage 100 gives class quota (month window, which the start gate does not check); percentage 87 gives other', async () => {
      const outcome = async (limit) => {
        const server = await serveQuota(() => limitsBody(limit));
        try {
          const f = classed();
          const r = await f.runAsync({ ...TEAM, OMC_PROVIDER_QUOTA_URL: server.origin }, ['--model', 'sonnet'], { fake: { exit: 1 } });
          return { r, last: f.rows().at(-1) };
        } finally { await server.close(); }
      };
      const a = await outcome({ type: 'TOKENS_LIMIT', unit: 5, number: 1, percentage: 100, nextResetTime: 1800000000000 });
      expect(a.r.status).toBe(1);
      expect(a.last).toMatchObject({ result: 'end', class: 'quota', exit_code: 1 });
      const b = await outcome({ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 87, nextResetTime: Date.now() + 86400_000 });
      expect(b.r.status).toBe(1);
      expect(b.last).toMatchObject({ result: 'end', class: 'other' });
    });

    it('(failure-class-3) a failed provider worker with an error field in the transcript: 429 with code 1308 gives quota (no quota read); API Error: 429 gives throttle; API Error: 500 gives infra; authentication_failed gives auth', () => {
      const f = classed();
      const cases = [
        ['{"isApiErrorMessage":true,"text":"API Error: 429 {\\"error\\":{\\"code\\":1308}}"}', 'quota'],
        ['{"isApiErrorMessage":true,"text":"API Error: 429 (no provider code)"}', 'throttle'],
        ['{"isApiErrorMessage":true,"text":"API Error: 500"}', 'infra'],
        ['{"type":"assistant","isApiErrorMessage":true,"text":"authentication_failed: key rejected"}', 'auth'],
      ];
      for (const [transcript, expected] of cases) {
        const r = f.run({ ...TEAM, CLAUDE_CONFIG_DIR: join(f.home, '.claude'), OMC_PROVIDER_QUOTA_URL: 'http://127.0.0.1:1' }, ['--model', 'sonnet'], { fake: { exit: 1, transcript } });
        expect(r.status, transcript).toBe(1);
        expect(f.rows().at(-1), transcript).toMatchObject({ result: 'end', class: expected });
      }
    });

    it('(failure-class-4) the output of the worker does not change the class: a fake that prints 429 and exits with 1 gives class other (not throttle); with exit code 0 there is no final row', () => {
      const f = classed();
      const a = f.run({ ...TEAM, OMC_PROVIDER_QUOTA_URL: 'http://127.0.0.1:1' }, ['--model', 'sonnet'], { fake: { exit: 1, stdout: '429' } });
      expect(a.status).toBe(1);
      expect(f.rows().at(-1)).toMatchObject({ result: 'end', class: 'other', exit_code: 1 });
      const before = f.rows().length;
      const b = f.run({ ...TEAM, OMC_PROVIDER_QUOTA_URL: 'http://127.0.0.1:1' }, ['--model', 'sonnet'], { fake: { exit: 0, stdout: '429' } });
      const rows = f.rows();
      expect(b.status).toBe(0);
      expect(rows.length).toBe(before + 1);
      const session = rows.at(-1).session_id;
      expect(rows.filter((row) => row.session_id === session).some((row) => row.result === 'end')).toBe(false);
    });

    it('(failure-class-5) a Claude role that fails (exit 1) gets no final row with a class', () => {
      const f = classed();
      const r = f.run({ ...TEAM, OMC_TEAM_ROLE: 'code-reviewer' }, ['--model', 'sonnet'], { fake: { exit: 1 } });
      const rows = f.rows();
      const mine = rows.filter((row) => row.session_id === rows.at(-1).session_id);
      expect(r.status).toBe(1);
      expect(mine.length).toBeGreaterThanOrEqual(1);
      expect(mine.every((row) => row.provider === 'claude')).toBe(true);
      expect(mine.some((row) => row.result === 'end')).toBe(false);
    });
  });

  // End to end masking: a secret echoed by the provider in a refusal never reaches stderr of the commands.
  describe('masking of provider messages', () => {
    const startAsync = (script, args, env) => new Promise((done) => {
      const child = spawn(process.execPath, [join(PROVIDER_DIR, script), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => done({ status, stdout, stderr }));
    });

    it('(18) the quota command: a 401 answer whose message echoes a key leaves as [REDACTED], the secret is not on stderr, exit 4', async () => {
      const secret = 'sk-abc123def456ghi789';
      const blob = '6789012345abcdef6789012345abcdef67890123';
      const server = await serveQuota(() => ({ status: 401, body: { success: false, msg: `invalid api key ${secret} / ${blob}` } }));
      try {
        const f = fixture({ quota: { adapter: 'monitor-limits', url: QUOTA_URL } });
        const r = await startAsync('provider-quota.cjs', [], { ...f.env, OMC_PROVIDER_QUOTA_URL: server.origin });
        expect(r.status).toBe(4);
        expect(r.stderr).toMatch(/HTTP 401, invalid api key sk-\[REDACTED\]/);
        expect(r.stderr).not.toContain(secret);
        expect(r.stderr).not.toContain(blob);
        expect(r.stderr).not.toContain(PLACEHOLDER_KEY);
      } finally { await server.close(); }
    });

    it('(17b) a key of the form <hex>.<characters> from a 401 of the quota gate is masked on stderr of the launcher, the worker wrapper and the quota command (all exit 4)', async () => {
      const secret = '6789012345abcdef6789012345abcdef.AbCdEfGhIjKlMnOp';
      const server = await serveQuota(() => ({ status: 401, body: { success: false, msg: `invalid key ${secret}` } }));
      try {
        const f = fixture({ quota: { adapter: 'monitor-limits', url: QUOTA_URL } });
        const original = join(f.dir, 'masking-settings.json');
        writeFileSync(original, `${json({ env: {} })}\n`);
        const base = { ...f.env, OMC_PROVIDER_CLAUDE_BIN: realClaude, OMC_PROVIDER_QUOTA_URL: server.origin };
        const quota = await startAsync('provider-quota.cjs', [], base);
        const launch = await startAsync('provider-launch.cjs', ['--bg', '--name', 'x', '--settings', original, 'p'], base);
        const worker = await startAsync('provider-worker.cjs', ['--dangerously-skip-permissions'], { ...base, ...TEAM });
        for (const [label, r] of [['quota', quota], ['launch', launch], ['worker', worker]]) {
          expect(r.status, label).toBe(4);
          expect(r.stderr, label).toContain('[REDACTED]');
          expect(r.stderr, label).not.toContain(secret);
          expect(r.stderr, label).not.toContain(PLACEHOLDER_KEY);
        }
      } finally { await server.close(); }
    });
  });

  // The role of a worker started by a recovery of OMC (no OMC_TEAM_ROLE) comes from the persistent team state.
  describe('role from the team state', () => {
    let stateRoot;
    const writeState = (name, content) => writeFileSync(join(stateRoot, name), content, 'utf8');
    const clearState = () => { for (const name of ['config.json', 'manifest.json']) { try { unlinkSync(join(stateRoot, name)); } catch { /* absent */ } } };
    const recovery = () => ({ OMC_TEAM_WORKER: 'team-a/worker-1', OMC_TEAM_NAME: 'team-a', OMC_WORKER_AGENT_TYPE: 'claude', OMC_TEAM_STATE_ROOT: stateRoot, OMC_TEAM_LEADER_CWD: join(tmp.dir, 'leader-stub') }); // the env that a recovery builds (no OMC_TEAM_ROLE)
    beforeAll(() => { stateRoot = join(tmp.dir, 'team-state'); mkdirSync(stateRoot, { recursive: true }); });

    it('(state-role-a) a recovery env without OMC_TEAM_ROLE and config.json with the role executor: provider like with OMC_TEAM_ROLE=executor (haiku, max, --settings), role_source config', () => {
      const f = fixture();
      clearState();
      writeState('config.json', json({ workers: [{ name: 'worker-1', role: 'executor', worker_cli: 'claude', index: 1 }] }));
      const r = f.run({ ...recovery(), ANTHROPIC_API_KEY: 'a' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.argv).toContain('--settings');
      expect(r.argv[r.argv.indexOf('--model') + 1]).toBe('haiku');
      expect(r.argv[r.argv.indexOf('--effort') + 1]).toBe('max');
      expect(f.rows().at(-1)).toMatchObject({ provider: 'acme', role: 'worker-executor', role_source: 'config' });
    });

    it('(state-role-b) config.json without an entry of the worker and manifest.json with the role executor: provider, role_source manifest', () => {
      const f = fixture();
      clearState();
      writeState('config.json', json({ workers: [{ name: 'worker-2', role: 'code-reviewer', worker_cli: 'claude', index: 2 }] }));
      writeState('manifest.json', json({ workers: [{ name: 'worker-1', role: 'executor', worker_cli: 'claude', index: 1 }] }));
      const r = f.run({ ...recovery(), ANTHROPIC_API_KEY: 'a' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.argv).toContain('--settings');
      expect(f.rows().at(-1)).toMatchObject({ provider: 'acme', role: 'worker-executor', role_source: 'manifest' });
    });

    it('(state-role-c) the role code-reviewer from the state (not in the provider roles): Claude as with the env, role_source config', () => {
      const f = fixture();
      clearState();
      writeState('config.json', json({ workers: [{ name: 'worker-1', role: 'code-reviewer', worker_cli: 'claude', index: 1 }] }));
      const r = f.run({ ...recovery(), ANTHROPIC_API_KEY: 'a' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.argv).not.toContain('--settings');
      expect(f.rows().at(-1)).toMatchObject({ provider: 'claude', role: 'worker-code-reviewer', role_source: 'config' });
    });

    it('(state-role-d) refusal: both state files missing, or no entry of the worker in either: exit 5, claude not called, an aborted-no-role row', () => {
      const f = fixture();
      clearState();
      let r = f.run({ ...recovery(), ANTHROPIC_API_KEY: 'a' });
      expect(r.status).toBe(5);
      expect(r.called).toBe(false);
      expect(r.stderr).toContain('worker role unknown');
      expect(f.rows().at(-1).result).toBe('aborted-no-role');
      writeState('config.json', json({ workers: [{ name: 'worker-2', role: 'executor', worker_cli: 'claude', index: 2 }] }));
      writeState('manifest.json', '{ bad json\n');
      r = f.run({ ...recovery(), ANTHROPIC_API_KEY: 'a' });
      expect(r.status).toBe(5);
      expect(r.called).toBe(false);
      expect(f.rows().at(-1).result).toBe('aborted-no-role');
    });

    it('(state-role-e) OMC_TEAM_ROLE=code-reviewer in the env wins over the state (config executor): Claude, role_source env', () => {
      const f = fixture();
      clearState();
      writeState('config.json', json({ workers: [{ name: 'worker-1', role: 'executor', worker_cli: 'claude', index: 1 }] }));
      const r = f.run({ ...recovery(), OMC_TEAM_ROLE: 'code-reviewer', ANTHROPIC_API_KEY: 'a' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.argv).not.toContain('--settings');
      expect(f.rows().at(-1)).toMatchObject({ provider: 'claude', role: 'worker-code-reviewer', role_source: 'env' });
    });

    it('(state-role-f) without OMC_TEAM_ROLE and without OMC_TEAM_STATE_ROOT (mode 2 without state, mode 3 and mode 1): the start is as before, the state is not read', () => {
      const f = fixture();
      clearState();
      writeState('config.json', json({ workers: [{ name: 'worker-1', role: 'executor', worker_cli: 'claude', index: 1 }] })); // on disk: if it were read despite the missing STATE_ROOT, the worker would go to the provider
      const env = { OMC_TEAM_WORKER: 'team-a/worker-1', OMC_TEAM_NAME: 'team-a', ANTHROPIC_API_KEY: 'a' };
      let r = f.run(env);
      expect(r.status, r.stderr).toBe(0);
      expect(r.argv.map((x) => (/^[0-9a-f-]{36}$/.test(x) ? 'SID' : x))).toEqual(['--dangerously-skip-permissions', '--model', 'sonnet', '--session-id', 'SID']);
      expect(f.rows().at(-1)).toMatchObject({ provider: 'claude', role: 'worker-', role_source: null });
      r = f.run({ ANTHROPIC_API_KEY: 'a' }, ['--version']);
      expect(r.argv).toEqual(['--version']);
      const settingsFile = join(f.dir, 'provider-settings.json');
      writeFileSync(settingsFile, '{}', 'utf8');
      r = f.run({ OMC_PROVIDER_SETTINGS_FILE: settingsFile, ANTHROPIC_API_KEY: 'a' }, ['p']);
      expect(r.argv).toEqual(['p', '--settings', settingsFile]);
    });

    it('(state-role-g) a plain Claude team: a worker entry without a role (config, then manifest when config is unreadable): the Claude path, no refusal', () => {
      const f = fixture();
      clearState();
      writeState('config.json', json({ workers: [{ name: 'worker-1', worker_cli: 'claude', index: 1 }] }));
      let r = f.run({ ...recovery(), ANTHROPIC_API_KEY: 'a' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.argv).not.toContain('--settings');
      expect(f.rows().at(-1)).toMatchObject({ provider: 'claude', role: 'worker-', role_source: null });
      writeState('config.json', '{ bad json\n');
      writeState('manifest.json', json({ workers: [{ name: 'worker-1', worker_cli: 'claude', index: 1 }] }));
      r = f.run({ ...recovery(), ANTHROPIC_API_KEY: 'a' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.argv).not.toContain('--settings');
    });
  });

  // The text of the worker rule template: the result block, the dictionaries and the paragraph about questions to the lead.
  describe('worker rule text', () => {
    const rule = () => readFileSync(RULE_FILE, 'utf8');

    it('(worker-hooks-8) the result block: six canon lines literally, the status dictionary equal to the vocabulary without in_progress and unknown, the subagent line requirement, the cause dictionary; the block comes before the consultation block and the whole file reaches --append-system-prompt', () => {
      const text = rule();
      for (const line of ['Status: success', 'Summary: added function X and its test', 'Files: tools/x.cjs, tests/x.mjs', 'Verification: node --test tests/x.mjs 5/5', 'Risks: none', 'Subagent skip reason: worker protocol forbids nested subagents; completed focused task in-session']) expect(text).toContain(line);
      const statusLine = text.split('\n').find((l) => l.startsWith('Status comes from the dictionary'));
      const stated = statusLine.slice('Status comes from the dictionary:'.length).split('(')[0].replace(/`/g, '').split(',').map((v) => v.trim());
      expect(stated).toEqual(Object.values(vocab.STATUSES).filter((v) => v !== 'in_progress' && v !== 'unknown'));
      expect(text).toContain('Subagent skip reason:');
      expect(text).toContain('Subagent spawn evidence:');
      expect(text.split('\n').some((l) => l.startsWith('Optional keys') && l.includes('`Cause`'))).toBe(true);
      expect(text.indexOf('RESULT (format)')).toBeGreaterThanOrEqual(0);
      expect(text.indexOf('RESULT (format)')).toBeLessThan(text.indexOf('CONSULTING THE ADVISOR'));
      const f = fixture({ worker: { ruleFile: RULE_FILE } });
      const dir = join(tmp.dir, `scripts-copy-rule-${++counter}`);
      cpSync(PROVIDER_DIR, dir, { recursive: true });
      writeFileSync(join(dir, 'provider-advisor.cjs'), "'use strict';\nprocess.exit(0);\n");
      const e = f.run({ ...TEAM }, ['--model', 'sonnet'], { script: join(dir, 'provider-worker.cjs') });
      expect(e.argv[e.argv.indexOf('--append-system-prompt') + 1].endsWith(text.trim())).toBe(true);
    });

    it('(worker-hooks-9) the paragraph about questions to the lead: close with the failure call and an error field whose first line is NEED:, the status blocked only from the evaluation code, no other channel; the block sits between the consultation block and the escalation rule', () => {
      const text = rule();
      const block = text.split('\n\n').find((b) => b.startsWith('QUESTION TO THE LEAD'));
      expect(block).toContain('failure call');
      expect(block).toContain('`error` field');
      expect(block).toContain('NEED:');
      expect(block).toContain('the worker never sets it');
      expect(block).toContain('no other channel');
      const at = text.indexOf('QUESTION TO THE LEAD');
      expect(text.indexOf('CONSULTING THE ADVISOR')).toBeLessThan(at);
      expect(at).toBeLessThan(text.lastIndexOf('ESCALATE: <lane>'));
    });
  });

  // The rescue hooks in the settings of a provider worker.
  describe('rescue hooks in the worker settings', () => {
    const rescueCommands = (u, event) => (u.hooks[event] ?? []).filter((h) => h.hooks[0].command.includes('provider-hook-rescue'));

    it('(13) a provider worker in a task team: rescue hooks in --settings (active from the env), the task id and the parameters in the settings env', () => {
      const f = fixture();
      const r = f.run({ ...TEAM, OMC_TEAM_WORKER: 'ptask-abc12345/worker-1', OMC_PROVIDER_RESCUE: 'active' });
      expect(r.status, r.stderr).toBe(0);
      const u = f.settingsOf(r);
      const command = u.hooks.PreToolUse.at(-1).hooks[0].command;
      expect(command).toContain('provider-hook-rescue');
      expect(u.hooks.PostToolUse.at(-1).hooks[0].command).toBe(command);
      expect(u.hooks.PostToolUseFailure.at(-1).hooks[0].command).toBe(command);
      expect(u.hooks.PreToolUse.at(-1).matcher).toBe('Bash');
      expect(u.env.OMC_PROVIDER_TASK_ID).toBe('abc12345');
      expect(u.env).toMatchObject({ OMC_PROVIDER_RESCUE: 'active', OMC_PROVIDER_RESCUE_THRESHOLD: '2', OMC_PROVIDER_RESCUE_ADVISOR_LIMIT: '2', OMC_PROVIDER_ADVISOR_MODEL: 'opus' });
      expect(u.env.OMC_JEV).toBe('off');
      expect(u.env.OMC_PROVIDER).toBe('acme');
    });

    it('(14) with rescue off: no rescue hooks; the task id stays; the existing guard hook is untouched', () => {
      const f = fixture();
      const r = f.run({ ...TEAM, OMC_TEAM_WORKER: 'ptask-abc12345/worker-1' });
      expect(r.status, r.stderr).toBe(0);
      const u = f.settingsOf(r);
      expect(JSON.stringify(u.hooks.PreToolUse.map((h) => h.hooks[0].command))).not.toContain('provider-hook-rescue');
      expect(u.hooks.PreToolUse.some((h) => h.hooks[0].command.includes('provider-bash-guard'))).toBe(true);
      expect(u.env.OMC_PROVIDER_TASK_ID).toBe('abc12345');
      expect(u.env.OMC_PROVIDER_RESCUE).toBe('off');
    });

    it('(15) end to end: rescue shadow with threshold, advisor limit and advisor model gives rescue hooks and the parameters in --settings; a value outside the dictionary: the default off', () => {
      const f = fixture({ rescue: { mode: 'shadow', threshold: 3, advisorLimit: 1 } });
      const r = f.run({ ...TEAM, OMC_TEAM_WORKER: 'ptask-abc12345/worker-1', OMC_PROVIDER_ADVISOR_MODEL: 'fable' });
      expect(r.status, r.stderr).toBe(0);
      const u = f.settingsOf(r);
      expect(u.hooks.PreToolUse.some((h) => h.hooks[0].command.includes('provider-hook-rescue'))).toBe(true);
      expect(u.env).toMatchObject({ OMC_PROVIDER_RESCUE: 'shadow', OMC_PROVIDER_RESCUE_THRESHOLD: '3', OMC_PROVIDER_RESCUE_ADVISOR_LIMIT: '1', OMC_PROVIDER_ADVISOR_MODEL: 'fable' });
      const g = fixture();
      const r2 = g.run({ ...TEAM, OMC_TEAM_WORKER: 'ptask-abc12345/worker-1', OMC_PROVIDER_RESCUE: 'TURBO' });
      expect(r2.status, r2.stderr).toBe(0);
      const u2 = g.settingsOf(r2);
      expect(JSON.stringify(u2.hooks.PreToolUse.map((h) => h.hooks[0].command))).not.toContain('provider-hook-rescue');
      expect(u2.env.OMC_PROVIDER_RESCUE).toBe('off');
    });

    it('(16) with the call counter: a worker of the team ptask-0123abcd with rescue shadow: the guard is the first PreToolUse entry, the need entries (AskUserQuestion and the counter) come before the rescue entry (PreToolUse matcher Bash, PostToolUse, PostToolUseFailure), the task id is 0123abcd', () => {
      const f = fixture();
      const r = f.run({ ...TEAM, OMC_PROVIDER_RESCUE: 'shadow', OMC_TEAM_WORKER: 'ptask-0123abcd/worker-1' });
      expect(r.status, r.stderr).toBe(0);
      const u = f.settingsOf(r);
      const pre = u.hooks.PreToolUse;
      expect(pre[0].hooks[0].command).toContain('provider-bash-guard');
      const need = pre.map((h, i) => ({ h, i })).filter((x) => x.h.hooks[0].command.includes('provider-hook-need'));
      expect(need.length).toBe(2);
      expect(need[0].h.matcher).toBe('AskUserQuestion');
      expect(need[1].h.matcher).toBeUndefined();
      const rescue = pre.map((h, i) => ({ h, i })).filter((x) => x.h.hooks[0].command.includes('provider-hook-rescue'));
      expect(rescue.length).toBe(1);
      expect(rescue[0].h.matcher).toBe('Bash');
      expect(need[1].i).toBeLessThan(rescue[0].i);
      expect(rescueCommands(u, 'PostToolUse').length).toBe(1);
      expect(u.hooks.PostToolUse.length).toBe(1);
      expect(rescueCommands(u, 'PostToolUseFailure').length).toBe(1);
      expect(u.hooks.PostToolUseFailure.length).toBe(1);
      expect(u.env.OMC_PROVIDER_TASK_ID).toBe('0123abcd');
    });
  });

  it('(c) end to end: a provider worker passes OMC_WORKER_LAUNCH_ATTEMPT_ID and OMC_STATE_DIR to the child env with the value unchanged', () => {
    const f = fixture();
    const r = f.run({ ...TEAM, OMC_WORKER_LAUNCH_ATTEMPT_ID: 'abc-123', OMC_STATE_DIR: join(f.dir, 'omc-state') });
    expect(r.status, r.stderr).toBe(0);
    expect(r.called).toBe(true);
    expect(r.env).toContain('OMC_WORKER_LAUNCH_ATTEMPT_ID');
    expect(r.env).toContain('OMC_STATE_DIR');
    expect(f.read('fake.launch')).toBe('abc-123');
    expect(f.read('fake.omcstate')).toBe(join(f.dir, 'omc-state'));
  });

  it('(c2) positive control: the same run without the variables in the input env has none in the child env', () => {
    const f = fixture();
    const r = f.run({ ...TEAM });
    expect(r.status, r.stderr).toBe(0);
    expect(r.called).toBe(true);
    expect(r.env).not.toContain('OMC_WORKER_LAUNCH_ATTEMPT_ID');
    expect(r.env).not.toContain('OMC_STATE_DIR');
    expect(f.read('fake.launch')).toBe('');
    expect(f.read('fake.omcstate')).toBe('');
  });

  it('(18c) the key and the token appear neither in the argv of the child nor in the process list of the machine while the worker is alive', async () => {
    const f = fixture();
    const sleeper = join(f.dir, 'sleeper-ps');
    writeFileSync(sleeper, `#!/bin/bash\nprintf '%s' $$ > "$HOME/sleeper.pid"\nexec sleep 30\n`, { mode: 0o755 });
    const child = spawn(process.execPath, [WORKER_SCRIPT, '--model', 'sonnet'], { env: { ...f.env, OMC_PROVIDER_CLAUDE_BIN: sleeper, ...TEAM }, stdio: 'ignore' });
    try {
      for (let i = 0; i < 100 && !existsSync(join(f.home, 'sleeper.pid')); i += 1) await wait(50);
      expect(existsSync(join(f.home, 'sleeper.pid'))).toBe(true);
      const ps = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
      expect(ps.status).toBe(0);
      expect(ps.stdout).not.toContain(PLACEHOLDER_KEY);
      expect(ps.stdout).toContain('sleep 30');
    } finally {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      try { process.kill(Number(readFileSync(join(f.home, 'sleeper.pid'), 'utf8')), 'SIGKILL'); } catch { /* gone */ }
    }
  });

  // Cases without a number check behaviour that the numbered cases do not cover.
  it('settings of a provider worker: subagent model without Jev, AskUserQuestion hook and denial flag, call counter and rescue parameters, empty MCP configuration', () => {
    const f = fixture({ worker: { maxToolCalls: 40 }, rescue: { mode: 'shadow', threshold: 3, advisorLimit: 1 } });
    const r = f.run({ ...TEAM, OMC_TEAM_WORKER: 'ptask-0123abcd-x/worker-1' }, ['--dangerously-skip-permissions', '--model', 'sonnet', '--', 'positional']);
    expect(r.status, r.stderr).toBe(0);
    const u = f.settingsOf(r);
    expect(u.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('acme-small[1m]');
    expect(u.env.OMC_JEV).toBe('off');
    expect(u.env.OMC_PROVIDER_MAX_TOOL_CALLS).toBe('40');
    expect(u.env.OMC_PROVIDER_TASK_ID).toBe('0123abcd');
    expect(u.env).toMatchObject({ OMC_PROVIDER_RESCUE: 'shadow', OMC_PROVIDER_RESCUE_THRESHOLD: '3', OMC_PROVIDER_RESCUE_ADVISOR_LIMIT: '1' });
    expect(u.env.OMC_ALLOW_LOOPBACK_PROXY_PORT).toBeUndefined();
    expect(u.env.OMC_PROVIDER_MODEL_PREFIXES).toBe('acme-');
    expect(JSON.parse(u.env.OMC_PROVIDER_GUARD).blockedCommands).toContain('claude');
    const pre = u.hooks.PreToolUse;
    expect(pre.some((h) => h.matcher === 'AskUserQuestion')).toBe(true);
    expect(pre.some((h) => h.matcher === undefined && h.hooks[0].command.includes('provider-hook-need'))).toBe(true);
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) expect(u.hooks[event].some((h) => h.matcher === 'Bash' && h.hooks[0].command.includes('provider-hook-rescue'))).toBe(true);
    const dashes = r.argv.indexOf('--');
    expect(r.argv.indexOf('--disallowedTools')).toBeLessThan(dashes);
    expect(r.argv[r.argv.indexOf('--disallowedTools') + 1]).toBe('AskUserQuestion');
    expect(r.argv.indexOf('--strict-mcp-config')).toBeLessThan(dashes);
    expect(r.argv[r.argv.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
    expect(r.argv.slice(dashes, dashes + 2)).toEqual(['--', 'positional']);
    const own = f.run({ ...TEAM }, ['--mcp-config', '{"mcpServers":{"x":{}}}']);
    expect(own.argv.filter((x) => x === '--mcp-config').length).toBe(1);
    expect(own.argv).not.toContain('--strict-mcp-config');
  });

  // The advisor shim and the worker rule exist when the advisor script sits next to the wrapper: these tests use a copy of the scripts with a stub advisor.
  describe('advisor shim and worker rule', () => {
    let copyDir;
    let bareDir;
    beforeAll(() => {
      copyDir = join(tmp.dir, 'scripts-copy');
      cpSync(PROVIDER_DIR, copyDir, { recursive: true });
      writeFileSync(join(copyDir, 'provider-advisor.cjs'), "'use strict';\nprocess.exit(0);\n");
      bareDir = join(tmp.dir, 'scripts-bare', 'a', 'b');
      cpSync(PROVIDER_DIR, bareDir, { recursive: true });
      rmSync(join(bareDir, 'provider-advisor.cjs'), { force: true }); // the real tree has the advisor script now; the bare copy must not
    });
    const withRule = (overrides = {}) => fixture({ worker: { ruleFile: RULE_FILE }, ...overrides });
    const ruleText = () => readFileSync(RULE_FILE, 'utf8').trim();

    it('(25) an executor has the advisor shim on its PATH (executable, pointing at the advisor script); a code-reviewer gets no shims (the shim directory is not created)', () => {
      const f = withRule();
      const e = f.run({ ...TEAM }, ['--model', 'sonnet'], { script: join(copyDir, 'provider-worker.cjs') });
      expect(e.status, e.stderr).toBe(0);
      const u = f.settingsOf(e);
      const shim = join(f.state, 'shims-worker', 'provider-advisor');
      expect(u.env.PATH.startsWith(`${join(f.state, 'shims-worker')}:`)).toBe(true);
      expect(statSync(shim).mode & 0o100).toBeTruthy();
      expect(readFileSync(shim, 'utf8')).toContain(join(copyDir, 'provider-advisor.cjs'));
      expect(u.env.OMC_PROVIDER_ADVISOR_COMMAND).toBe('provider-advisor');
      const other = join(f.dir, 'shim-code-reviewer');
      const c = f.run({ ...TEAM, OMC_TEAM_ROLE: 'code-reviewer', OMC_PROVIDER_SHIM_DIR: other }, ['--model', 'sonnet'], { script: join(copyDir, 'provider-worker.cjs') });
      expect(c.status, c.stderr).toBe(0);
      expect(c.argv).not.toContain('--settings');
      expect(existsSync(other)).toBe(false);
    });

    it('(25b) an executor gets the worker rule at the end of the value of --append-system-prompt (one flag, with the git rule before it); a code-reviewer gets no such flag', () => {
      const f = withRule();
      const e = f.run({ ...TEAM }, ['--model', 'sonnet'], { script: join(copyDir, 'provider-worker.cjs') });
      const at = e.argv.indexOf('--append-system-prompt');
      expect(e.argv.filter((x) => x === '--append-system-prompt').length).toBe(1);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(e.argv[at + 1].endsWith(ruleText())).toBe(true);
      expect(e.argv[at + 1]).toContain('git config');
      const c = f.run({ ...TEAM, OMC_TEAM_ROLE: 'code-reviewer' }, ['--model', 'sonnet'], { script: join(copyDir, 'provider-worker.cjs') });
      expect(c.argv).not.toContain('--append-system-prompt');
    });

    it('(25c) without the advisor script and the rule file next to the wrapper a provider worker starts without the rule and without the advisor shim (the start does not die)', () => {
      const f = fixture();
      const shims = join(f.dir, 'shim-19');
      const r = f.run({ ...TEAM, OMC_PROVIDER_SHIM_DIR: shims }, ['-p', 'x'], { script: join(bareDir, 'provider-worker.cjs') });
      expect(r.status, r.stderr).toBe(0);
      expect(r.argv.some((x, k) => x === '--append-system-prompt' && String(r.argv[k + 1]).includes('CONSULTING THE ADVISOR'))).toBe(false);
      expect(existsSync(join(shims, 'provider-advisor'))).toBe(false);
    });
  });

  it('(21) a provider worker with the slot limit reached (a live foreign owner, no wait): exit 3, claude not called, an aborted-no-slot row; a bad limit value: exit 2 and an aborted-bad-config row', () => {
    const f = fixture({ limits: { maxSessions: 1, slotWaitMs: 0 } });
    const slots = join(f.state, 'slots');
    mkdirSync(slots, { recursive: true, mode: 0o700 });
    const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      writeFileSync(join(slots, 'slot-foreign.json'), json({ pid: holder.pid, ts: Date.now() }));
      const r = f.run({ ...TEAM });
      expect(r.status, r.stderr).toBe(3);
      expect(r.called).toBe(false);
      expect(f.rows().at(-1).result).toBe('aborted-no-slot');
      unlinkSync(join(slots, 'slot-foreign.json'));
      const bad = f.run({ ...TEAM, OMC_PROVIDER_MAX_SESSIONS: 'abc' });
      expect(bad.status, bad.stderr).toBe(2);
      expect(bad.called).toBe(false);
      expect(f.rows().at(-1).result).toBe('aborted-bad-config');
      expect(readdirSync(slots).filter((n) => /^slot-/.test(n))).toEqual([]);
    } finally { holder.kill('SIGKILL'); }
  });

  it('(22-slot) a provider worker holds a slot during the session and releases it at the end', async () => {
    const f = fixture();
    const slots = join(f.state, 'slots');
    const count = () => (existsSync(slots) ? readdirSync(slots).filter((n) => /^slot-/.test(n)).length : 0);
    const waiting = join(f.dir, 'claude-waits');
    writeFileSync(waiting, '#!/bin/bash\nsleep 0.4\n', { mode: 0o755 });
    const child = spawn(process.execPath, [WORKER_SCRIPT, '-p', 'x'], { env: { ...f.env, OMC_PROVIDER_CLAUDE_BIN: waiting, ...TEAM, OMC_PROVIDER_MAX_SESSIONS: '4', OMC_PROVIDER_SLOT_WAIT_MS: '15000' } });
    const started = Date.now();
    while (count() === 0 && Date.now() - started < 5000) await wait(25);
    expect(count()).toBe(1);
    await new Promise((done) => child.on('close', done));
    expect(count()).toBe(0);
  });

  it('(22) a provider worker: argv without --dangerously-skip-permissions, --tools exactly the six tools, --permission-mode dontAsk, the git rule in --append-system-prompt before --settings; a Claude role keeps its argv', () => {
    const f = fixture();
    const r = f.run({ ...TEAM }, ['--dangerously-skip-permissions', '--model', 'sonnet']);
    const arg = (flag) => r.argv[r.argv.indexOf(flag) + 1];
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).not.toContain('--dangerously-skip-permissions');
    expect(arg('--tools')).toBe('Bash,Read,Edit,Write,Grep,Glob');
    expect(r.argv.filter((x) => x === '--tools').length).toBe(1);
    expect(arg('--tools').split(',').length).toBe(6);
    expect(arg('--permission-mode')).toBe('dontAsk');
    expect(arg('--append-system-prompt')).toMatch(/git config/);
    expect(arg('--append-system-prompt')).toMatch(/git remote/);
    expect(r.argv.indexOf('--settings')).toBeGreaterThan(r.argv.indexOf('--append-system-prompt'));
    expect(r.argv.indexOf('--session-id')).toBeGreaterThan(r.argv.indexOf('--tools'));
    const c = f.run({ ...TEAM, OMC_TEAM_ROLE: 'code-reviewer' }, ['--dangerously-skip-permissions', '--model', 'sonnet']);
    expect(c.argv).toContain('--dangerously-skip-permissions');
    for (const flag of ['--tools', '--permission-mode', '--append-system-prompt']) expect(c.argv).not.toContain(flag);
  });

  it('(24b) the integrity check of the worker: an executor that changes .git/hooks gives exit 1, an integrity row (git_change, launcher_exit, session_id) and a message on stderr; no change: exit 0 and no such row; a failed run still gets the check; a working directory outside a repository: the check is skipped', () => {
    const f = fixture();
    const repo = join(f.dir, 'repo-integrity');
    spawnSync('git', ['init', repo], { encoding: 'utf8' });
    spawnSync('git', ['-C', repo, '-c', 'user.name=a', '-c', 'user.email=a@b', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'p'], { encoding: 'utf8' });
    const env = { ...TEAM, OMC_TEAM_WORKER_CWD: repo };
    const touch = { touch: join(repo, '.git', 'hooks', 'pre-commit') };
    const clean = f.run(env, ['--dangerously-skip-permissions', '--model', 'sonnet']);
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.called).toBe(true);
    expect(f.rows().at(-1).result).not.toBe('integrity');
    expect('git_change' in f.rows().at(-1)).toBe(false);
    const attack = f.run(env, ['--dangerously-skip-permissions', '--model', 'sonnet'], { fake: touch });
    expect(attack.status).toBe(1);
    expect(attack.called).toBe(true);
    expect(attack.stderr).toMatch(/hooks\/pre-commit/);
    expect(attack.stderr).toMatch(/integrity/);
    const row = f.rows().at(-1);
    expect(row.result).toBe('integrity');
    expect(row.git_change).toMatch(/hooks\/pre-commit/);
    expect(row.launcher_exit).toBe(0);
    expect(row.provider).toBe('acme');
    expect(row.session_id).toBe(attack.argv[attack.argv.indexOf('--session-id') + 1]);
    const failed = f.run(env, ['--dangerously-skip-permissions', '--model', 'sonnet'], { fake: { ...touch, exit: 3 } });
    expect(failed.status).toBe(1);
    expect(f.rows().at(-1).launcher_exit).toBe(3);
    const outside = f.run({ ...TEAM, OMC_TEAM_WORKER_CWD: tmp.dir }, ['--version']);
    expect(outside.status, outside.stderr).toBe(0);
    expect(outside.called).toBe(true);
  });

  it('(26) a provider role gets --strict-mcp-config with an empty --mcp-config, a settings file without mcpServers and with the subagent model and OMC_JEV=off; a Claude role gets no MCP flags; an own --mcp-config of the caller stays without a duplicate', () => {
    const f = fixture();
    const r = f.run({ ...TEAM, ANTHROPIC_API_KEY: 'a' });
    expect(r.status, r.stderr).toBe(0);
    const k = r.argv.indexOf('--settings');
    const i = r.argv.indexOf('--mcp-config');
    expect(r.argv).toContain('--strict-mcp-config');
    expect(i).toBeGreaterThan(0);
    expect(r.argv[i + 1]).toBe('{"mcpServers":{}}');
    expect(r.argv.indexOf('--strict-mcp-config')).toBeLessThan(k);
    const u = f.settingsOf(r);
    expect('mcpServers' in u).toBe(false);
    expect(u.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('acme-small[1m]');
    expect(u.env.OMC_JEV).toBe('off');
    expect(JSON.stringify(u)).not.toContain(PLACEHOLDER_KEY);
    const c = f.run({ ...TEAM, OMC_TEAM_ROLE: 'code-reviewer' });
    expect(c.status, c.stderr).toBe(0);
    expect(c.argv).not.toContain('--strict-mcp-config');
    expect(c.argv).not.toContain('--mcp-config');
    const w = f.run({ ...TEAM }, ['--dangerously-skip-permissions', '--mcp-config', './mcp.json']);
    expect(w.argv.filter((a) => a === '--mcp-config').length).toBe(1);
    expect(w.argv[w.argv.indexOf('--mcp-config') + 1]).toBe('./mcp.json');
    expect(w.argv).not.toContain('--strict-mcp-config');
  });

  // Quota gate of a provider worker, end to end against a loopback quota endpoint (fixture thresholds: pause 96, stop 99, week counted like the window).
  describe('quota gate', () => {
    const gated = (extra = {}) => fixture({ quota: { adapter: 'monitor-limits', url: QUOTA_URL, ...extra } });
    const breakerOf = (f) => JSON.parse(readFileSync(join(f.state, 'breaker.json'), 'utf8'));
    const pool = (name, markers = []) => { const dir = join(tmp.dir, `pool-${name}-${++counter}`); mkdirSync(dir, { recursive: true }); for (const marker of markers) writeFileSync(join(dir, marker), 'state\n'); return dir; };
    const withServer = async (reply, fn) => { const server = await serveQuota(reply); try { await fn(server); } finally { await server.close(); } };

    it('(27a) below the thresholds (window 89 %, week 34 %): the start is allowed, exit 0', async () => {
      await withServer(() => limitsBody(limit5h(89), limitWeek(34)), async (server) => {
        const f = gated();
        const r = await f.runAsync({ ...TEAM, OMC_PROVIDER_QUOTA_URL: server.origin });
        expect(r.status, r.stderr).toBe(0);
        expect(r.called).toBe(true);
        expect(server.state.hits).toBe(1);
      });
    });

    it('(27b) window at 96 %: exit 4 with level PAUSE, claude not called, an aborted-quota row, a message with the limit, percent, threshold and reset; the breaker is written with class quota and the level', async () => {
      await withServer(() => limitsBody(limit5h(96)), async (server) => {
        const f = gated();
        const r = await f.runAsync({ ...TEAM, OMC_PROVIDER_QUOTA_URL: server.origin });
        expect(r.status).toBe(4);
        expect(r.called).toBe(false);
        expect(r.stderr).toMatch(/level PAUSE/);
        expect(r.stderr).toMatch(/5 h window used at 96% \(threshold 96%\)/);
        expect(r.stderr).toMatch(/reset:/);
        expect(r.stderr).not.toContain(PLACEHOLDER_KEY);
        expect(r.stderr).not.toContain(tmp.dir);
        expect(f.rows().at(-1)).toMatchObject({ result: 'aborted-quota', provider: 'acme', session_id: null, role: 'worker-executor' });
        const b = breakerOf(f);
        expect(b).toMatchObject({ class: 'quota', limit: 'window', percent: 96, level: 'PAUSE' });
        expect(b.until).toBeGreaterThan(Date.now());
      });
    });

    it('(27c) week at 100 %: exit 4 with level STOP and the weekly message (threshold 99); week at 95 %: the start is allowed (below the pause threshold 96)', async () => {
      await withServer(() => limitsBody(limit5h(12), limitWeek(100)), async (server) => {
        const f = gated();
        const a = await f.runAsync({ ...TEAM, OMC_PROVIDER_QUOTA_URL: server.origin });
        expect(a.status).toBe(4);
        expect(a.stderr).toMatch(/level STOP/);
        expect(a.stderr).toMatch(/weekly window used at 100% \(threshold 99%\)/);
        expect(a.called).toBe(false);
      });
      await withServer(() => limitsBody(limit5h(12), limitWeek(95)), async (server) => {
        const f = gated();
        const b = await f.runAsync({ ...TEAM, OMC_PROVIDER_QUOTA_URL: server.origin });
        expect(b.status, b.stderr).toBe(0);
        expect(b.called).toBe(true);
      });
    });

    it('(27d) HTTP 401: exit 4, a message about the key (without the key and paths), an aborted-quota row, no cache written; the quota command exits with 4 and a refusal message', async () => {
      await withServer(() => ({ status: 401, body: { success: false, msg: 'token expired' } }), async (server) => {
        const f = gated();
        const r = await f.runAsync({ ...TEAM, OMC_PROVIDER_QUOTA_URL: server.origin });
        expect(r.status).toBe(4);
        expect(r.called).toBe(false);
        expect(r.stderr).toMatch(/rejects the API key.*401/);
        expect(r.stderr).not.toContain(PLACEHOLDER_KEY);
        expect(r.stderr).not.toContain(tmp.dir);
        expect(f.rows().at(-1).result).toBe('aborted-quota');
        expect(existsSync(join(f.state, 'quota-cache.json'))).toBe(false);
        const cli = await new Promise((done) => {
          const child = spawn(process.execPath, [join(PROVIDER_DIR, 'provider-quota.cjs')], { env: { ...f.env, OMC_PROVIDER_QUOTA_URL: server.origin }, stdio: ['ignore', 'pipe', 'pipe'] });
          let stderr = '';
          child.stderr.on('data', (d) => { stderr += d; });
          child.on('close', (status) => done({ status, stderr }));
        });
        expect(cli.status).toBe(4);
        expect(cli.stderr).toMatch(/401/);
      });
    });

    it('(27e) breaker: after one refusal ten further starts do not call the endpoint (counter 1); after the breaker expires exactly one attempt is made and a new refusal renews it', async () => {
      let reply = () => limitsBody(limit5h(97));
      await withServer(() => reply(), async (server) => {
        const f = gated();
        const env = { ...TEAM, OMC_PROVIDER_QUOTA_URL: server.origin };
        const first = await f.runAsync(env);
        expect(first.status).toBe(4);
        expect(server.state.hits).toBe(1);
        reply = () => limitsBody(limit5h(12));
        for (let i = 0; i < 10; i += 1) expect((await f.runAsync(env)).status).toBe(4);
        expect(server.state.hits).toBe(1);
        const file = join(f.state, 'breaker.json');
        const b = JSON.parse(readFileSync(file, 'utf8'));
        b.until = Date.now() - 1000;
        writeFileSync(file, `${json(b)}\n`);
        try { unlinkSync(join(f.state, 'quota-cache.json')); } catch { /* none */ }
        reply = () => limitsBody(limit5h(97));
        const probe = await f.runAsync(env);
        expect(probe.status).toBe(4);
        expect(server.state.hits).toBe(2);
        expect(JSON.parse(readFileSync(file, 'utf8')).until).toBeGreaterThan(Date.now());
        expect(probe.stderr).toMatch(/5 h window/);
        expect((await f.runAsync(env)).status).toBe(4);
        expect(server.state.hits).toBe(2);
      });
    });

    it('(27f) cache of 60 s: a second start inside the window does not call the endpoint (counter 1 for two starts, both exit 0)', async () => {
      await withServer(() => limitsBody(limit5h(12), limitWeek(34)), async (server) => {
        const f = gated();
        const env = { ...TEAM, OMC_PROVIDER_QUOTA_URL: server.origin };
        expect((await f.runAsync(env)).status).toBe(0);
        expect((await f.runAsync(env)).status).toBe(0);
        expect(server.state.hits).toBe(1);
      });
    });

    it('(27g) window at 95 % with a pool directory (fresh, no files): the start is allowed, exit 0', async () => {
      await withServer(() => limitsBody(limit5h(95), limitWeek(34)), async (server) => {
        const f = gated();
        const r = await f.runAsync({ ...TEAM, OMC_PROVIDER_QUOTA_URL: server.origin, OMC_PROVIDER_POOL_DIR: pool('27g') });
        expect(r.status, r.stderr).toBe(0);
        expect(r.called).toBe(true);
        expect(server.state.hits).toBe(1);
      });
    });

    it('(27h) window at 96 % and at 98 %: exit 4 with level PAUSE (threshold 96), claude not called', async () => {
      const dir = pool('27h');
      for (const percent of [96, 98]) {
        await withServer(() => limitsBody(limit5h(percent)), async (server) => {
          const f = gated();
          const r = await f.runAsync({ ...TEAM, OMC_PROVIDER_QUOTA_URL: server.origin, OMC_PROVIDER_POOL_DIR: dir });
          expect(r.status).toBe(4);
          expect(r.stderr).toMatch(/level PAUSE/);
          expect(r.stderr).toContain(`5 h window used at ${percent}% (threshold 96%)`);
          expect(r.called).toBe(false);
        });
      }
    });

    it('(27i) window at 99 %: exit 4 with level STOP (threshold 99), claude not called', async () => {
      await withServer(() => limitsBody(limit5h(99)), async (server) => {
        const f = gated();
        const r = await f.runAsync({ ...TEAM, OMC_PROVIDER_QUOTA_URL: server.origin, OMC_PROVIDER_POOL_DIR: pool('27i') });
        expect(r.status).toBe(4);
        expect(r.stderr).toMatch(/level STOP/);
        expect(r.stderr).toContain('5 h window used at 99% (threshold 99%)');
        expect(r.called).toBe(false);
      });
    });

    it('(27j) a PAUSE file in the pool blocks at low usage: the endpoint is not called, the file is untouched (content and mtime); STOP wins over PAUSE', async () => {
      await withServer(() => limitsBody(limit5h(12), limitWeek(34)), async (server) => {
        const dir = pool('27j', ['PAUSE']);
        const before = { content: readFileSync(join(dir, 'PAUSE'), 'utf8'), mtime: statSync(join(dir, 'PAUSE')).mtimeMs };
        const f = gated();
        const r = await f.runAsync({ ...TEAM, OMC_PROVIDER_QUOTA_URL: server.origin, OMC_PROVIDER_POOL_DIR: dir });
        expect(r.status).toBe(4);
        expect(r.stderr).toMatch(/pool level PAUSE/);
        expect(r.stderr).toMatch(/provider worker pool is at PAUSE/);
        expect(r.called).toBe(false);
        expect(server.state.hits).toBe(0);
        expect(readFileSync(join(dir, 'PAUSE'), 'utf8')).toBe(before.content);
        expect(statSync(join(dir, 'PAUSE')).mtimeMs).toBe(before.mtime);
        const both = pool('27j-b', ['PAUSE', 'STOP']);
        const g = gated();
        const rb = await g.runAsync({ ...TEAM, OMC_PROVIDER_QUOTA_URL: server.origin, OMC_PROVIDER_POOL_DIR: both });
        expect(rb.status).toBe(4);
        expect(rb.stderr).toMatch(/pool level STOP/);
        expect(rb.stderr).toMatch(/provider worker pool is at STOP/);
        expect(rb.called).toBe(false);
      });
    });

    it('(27k) without a pool directory the gate works on the thresholds alone: window at 96 % is refused with PAUSE', async () => {
      await withServer(() => limitsBody(limit5h(96)), async (server) => {
        const f = gated();
        const r = await f.runAsync({ ...TEAM, OMC_PROVIDER_QUOTA_URL: server.origin });
        expect(r.status).toBe(4);
        expect(r.stderr).toMatch(/level PAUSE/);
        expect(r.stderr).toMatch(/5 h window used at 96% \(threshold 96%\)/);
        expect(r.called).toBe(false);
      });
    });

    it('(27l) a failed quota read (HTTP 500): without a pool file the start goes on (fail open); with a PAUSE file it is still refused', async () => {
      await withServer(() => ({ status: 500, body: {} }), async (server) => {
        const f = gated();
        const r = await f.runAsync({ ...TEAM, OMC_PROVIDER_QUOTA_URL: server.origin });
        expect(r.status, r.stderr).toBe(0);
        expect(r.called).toBe(true);
        const g = gated();
        const rb = await g.runAsync({ ...TEAM, OMC_PROVIDER_QUOTA_URL: server.origin, OMC_PROVIDER_POOL_DIR: pool('27l', ['PAUSE']) });
        expect(rb.status).toBe(4);
        expect(rb.stderr).toMatch(/pool level PAUSE/);
        expect(rb.called).toBe(false);
      });
    });
  });

  // Registration of the hooks of a provider worker: the AskUserQuestion denial and the call counter.
  describe('worker hooks', () => {
    const needEntries = (u) => u.hooks.PreToolUse.filter((h) => h.hooks?.[0]?.command.includes('provider-hook-need'));
    const copyScripts = () => { const dir = join(tmp.dir, `scripts-copy-hooks-${++counter}`); cpSync(PROVIDER_DIR, dir, { recursive: true }); writeFileSync(join(dir, 'provider-advisor.cjs'), "'use strict';\nprocess.exit(0);\n"); return dir; };

    it('(worker-hooks-5) a provider worker: --disallowedTools AskUserQuestion once and before --, the tool list stays, the settings carry the need hook with the AskUserQuestion matcher (always) and the Bash guard, and --append-system-prompt contains the paragraph with NEED:', () => {
      const f = fixture({ worker: { ruleFile: RULE_FILE } });
      const copy = copyScripts();
      const r = f.run({ ...TEAM }, ['--dangerously-skip-permissions', '--model', 'sonnet', '--', 'PROMPT'], { script: join(copy, 'provider-worker.cjs') });
      expect(r.status, r.stderr).toBe(0);
      const arg = (flag) => r.argv[r.argv.indexOf(flag) + 1];
      const dash = r.argv.indexOf('--');
      const dis = r.argv.indexOf('--disallowedTools');
      expect(dis).toBeGreaterThan(0);
      expect(r.argv[dis + 1]).toBe('AskUserQuestion');
      expect(r.argv.filter((x) => x === '--disallowedTools').length).toBe(1);
      expect(dash < 0 || dis < dash).toBe(true);
      expect(arg('--tools')).toBe('Bash,Read,Edit,Write,Grep,Glob');
      expect(arg('--permission-mode')).toBe('dontAsk');
      const u = f.settingsOf(r);
      const entries = needEntries(u);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].matcher).toBe('AskUserQuestion');
      expect(u.hooks.PreToolUse.some((h) => h.hooks?.[0]?.command.includes('provider-bash-guard'))).toBe(true);
      const prompt = arg('--append-system-prompt');
      expect(prompt).toContain('NEED:');
      expect(prompt.endsWith(readFileSync(RULE_FILE, 'utf8').trim())).toBe(true);
    });

    it('(worker-hooks-6) registration of the counter: team team-a without a limit: only the AskUserQuestion hook; a limit of 4: the counter plus the value in the settings env; a team ptask-0123abcd-2 without a limit: the counter is registered', () => {
      const f = fixture();
      const none = f.run({ ...TEAM });
      expect(none.status, none.stderr).toBe(0);
      expect(needEntries(f.settingsOf(none)).map((h) => h.matcher)).toEqual(['AskUserQuestion']);
      const limited = f.run({ ...TEAM, OMC_PROVIDER_MAX_TOOL_CALLS: '4' });
      const u = f.settingsOf(limited);
      expect(needEntries(u).length).toBe(2);
      expect(needEntries(u)[1].matcher).toBeUndefined();
      expect(u.env.OMC_PROVIDER_MAX_TOOL_CALLS).toBe('4');
      const taskTeam = f.run({ ...TEAM, OMC_TEAM_WORKER: 'ptask-0123abcd-2/worker-1' });
      const t = f.settingsOf(taskTeam);
      expect(needEntries(t).length).toBe(2);
      expect(needEntries(t)[1].matcher).toBeUndefined();
      expect('OMC_PROVIDER_MAX_TOOL_CALLS' in t.env).toBe(false);
    });

    it('(worker-hooks-7) end to end: a tool-call limit in the profile file gives the counter hook and the value in the settings env block', () => {
      const f = fixture({ worker: { maxToolCalls: 4 } });
      const r = f.run({ ...TEAM });
      const u = f.settingsOf(r);
      expect(r.status, r.stderr).toBe(0);
      expect(needEntries(u).length).toBe(2);
      expect(u.env.OMC_PROVIDER_MAX_TOOL_CALLS).toBe('4');
    });

    it('(28) the value of --append-system-prompt of a provider role contains the ESCALATE: <lane> rule after the consultation block and ends with the whole rule; a Claude role has none', () => {
      const f = fixture({ worker: { ruleFile: RULE_FILE } });
      const copy = copyScripts();
      const e = f.run({ ...TEAM }, ['--model', 'sonnet'], { script: join(copy, 'provider-worker.cjs') });
      expect(e.status, e.stderr).toBe(0);
      const prompt = e.argv[e.argv.indexOf('--append-system-prompt') + 1];
      const whole = readFileSync(RULE_FILE, 'utf8').trim();
      expect(whole).toMatch(/ESCALATE: <lane>/);
      expect(prompt.endsWith(whole)).toBe(true);
      expect(prompt.indexOf('ESCALATE: <lane>')).toBeGreaterThan(prompt.indexOf('CONSULTING THE ADVISOR'));
      const c = f.run({ ...TEAM, OMC_TEAM_ROLE: 'code-reviewer' }, ['--model', 'sonnet'], { script: join(copy, 'provider-worker.cjs') });
      expect(c.argv).not.toContain('--append-system-prompt');
    });
  });

  // Cases without a number check behaviour that the numbered cases do not cover.
  it('quota gate of a provider worker: an active breaker gives exit 4 with an aborted-quota row and no start; a Claude role is not gated', () => {
    const f = fixture({ quota: { adapter: 'monitor-limits', url: 'https://quota.acme.example/limit' } });
    mkdirSync(f.state, { recursive: true });
    writeFileSync(join(f.state, 'breaker.json'), json({ until: Date.now() + 600_000, class: 'quota', limit: 'week', percent: 100, reset: Date.now() + 3600_000, level: 'STOP', ts: Date.now() }));
    const r = f.run({ ...TEAM });
    expect(r.status).toBe(4);
    expect(r.called).toBe(false);
    expect(r.stderr).toMatch(/quota gate/);
    expect(f.rows().at(-1)).toMatchObject({ result: 'aborted-quota', provider: 'acme', session_id: null });
    const reviewer = f.run({ ...TEAM, OMC_TEAM_ROLE: 'code-reviewer' });
    expect(reviewer.status, reviewer.stderr).toBe(0);
    expect(reviewer.called).toBe(true);
  });

  // Signal forwarding: a signal sent to the wrapper reaches the child claude; the wrapper ends with 128 plus the signal number.
  async function signalCase({ label, signal, code, args, env = () => ({}), slotsDuring = 0, endRow = false }) {
    const f = fixture();
    const fake = join(f.dir, `claude-signal-${label}`);
    const pidFile = join(f.home, `signal-${label}.pid`);
    writeFileSync(fake, `#!/bin/bash\nprintf '%s' $$ > "$HOME/signal-${label}.pid"\nexec sleep 30\n`, { mode: 0o755 });
    chmodSync(fake, 0o755);
    const slots = join(f.state, 'slots');
    const slotCount = () => (existsSync(slots) ? readdirSync(slots).filter((n) => /^slot-/.test(n)).length : 0);
    const child = spawn(process.execPath, [WORKER_SCRIPT, ...args], { env: { ...f.env, OMC_PROVIDER_CLAUDE_BIN: fake, ...env(f) } });
    try {
      const started = Date.now();
      while (!existsSync(pidFile) && Date.now() - started < 5000) await wait(50);
      expect(existsSync(pidFile), `the fake claude did not start (${label})`).toBe(true);
      expect(slotCount(), 'slots during the session').toBe(slotsDuring);
      child.kill(signal);
      const status = await new Promise((done) => child.on('close', done));
      expect(status, `wrapper exit code after ${signal}`).toBe(code);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(await waitProcessGone(pid), `the child claude is alive after ${signal} to the wrapper (pid ${pid})`).toBe(true);
      expect(slotCount(), 'slots after the end').toBe(0);
      if (endRow) expect(f.rows().at(-1)).toMatchObject({ result: 'end', class: 'other' });
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  const sessionSettings = (f) => { const file = join(f.dir, 'session-mode1.json'); writeFileSync(file, '{}\n'); return { OMC_PROVIDER_SETTINGS_FILE: file }; };

  it('(28 signal) SIGTERM to the wrapper of a provider worker reaches the child claude, exit code 143 (128 + SIGTERM), slot released, end row written', async () => {
    await signalCase({ label: '28', signal: 'SIGTERM', code: 143, args: ['--dangerously-skip-permissions'], env: () => TEAM, slotsDuring: 1, endRow: true });
  }, 30000);

  it('(29) SIGINT to the wrapper of a provider worker reaches the child claude, exit code 130 (128 + SIGINT), slot released, end row written', async () => {
    await signalCase({ label: '29', signal: 'SIGINT', code: 130, args: ['--dangerously-skip-permissions'], env: () => TEAM, slotsDuring: 1, endRow: true });
  }, 30000);

  it('(30) SIGHUP to the wrapper of a provider worker reaches the child claude, exit code 129 (128 + SIGHUP), slot released', async () => {
    await signalCase({ label: '30', signal: 'SIGHUP', code: 129, args: ['--dangerously-skip-permissions'], env: () => TEAM, slotsDuring: 1, endRow: true });
  }, 30000);

  it('(31) mode 1 (a nested claude with the settings of a provider session): SIGTERM reaches the child claude, exit code 143, the child is dead, no slots held in this mode', async () => {
    await signalCase({ label: '31', signal: 'SIGTERM', code: 143, args: ['-p', 'x'], env: sessionSettings, slotsDuring: 0 });
  }, 30000);

  it('(32) mode 3 (not a worker): SIGTERM reaches the child claude, exit code 143, the child is dead', async () => {
    await signalCase({ label: '32', signal: 'SIGTERM', code: 143, args: ['-p', 'x'], slotsDuring: 0 });
  }, 30000);

  it('(34) a signal in the quota gate window (the start waits for the quota answer): claude is not called, exit code 143, no slot held', async () => {
    const f = fixture({ quota: { adapter: 'monitor-limits', url: QUOTA_URL } });
    const asked = join(f.dir, 'quota-asked');
    const server = createServer((req, res) => {
      writeFileSync(asked, '1'); // marker: the gate is waiting for the answer
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(json({ success: true, data: { level: 'lite', limits: [limit5h(12), limitWeek(12)] } })); }, 2000);
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    try {
      for (const name of ['fake.argv']) { try { unlinkSync(join(f.home, name)); } catch { /* absent */ } }
      const child = spawn(process.execPath, [WORKER_SCRIPT, '--dangerously-skip-permissions'], { env: { ...f.env, OMC_PROVIDER_CLAUDE_BIN: realClaude, OMC_PROVIDER_QUOTA_URL: `http://127.0.0.1:${server.address().port}`, ...TEAM } });
      try {
        const started = Date.now();
        while (!existsSync(asked) && Date.now() - started < 5000) await wait(50);
        expect(existsSync(asked), 'the quota endpoint was not asked').toBe(true);
        child.kill('SIGTERM');
        const status = await new Promise((done) => child.on('close', done));
        expect(status, 'wrapper exit code after SIGTERM in the gate window').toBe(143);
        expect(f.read('fake.argv'), 'claude was called despite the signal in the gate window').toBeNull();
        const slots = join(f.state, 'slots');
        expect(existsSync(slots) ? readdirSync(slots).filter((n) => /^slot-/.test(n)).length : 0).toBe(0);
      } finally { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  }, 30000);

});
