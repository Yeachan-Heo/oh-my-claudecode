/* global process, URL */
// Launcher and worker wrapper next to a running local proxy: they take its address and the client token (never the key);
// without a running proxy they use the provider address and the key; a test address pair wins over the proxy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, stubProxyProcess, writeProfile, PLACEHOLDER_KEY } from './_helpers.mjs';

const SCRIPTS = fileURLToPath(new URL('../../../scripts/provider/', import.meta.url));
const PORT = 33177;
const CLIENT_TOKEN = 'cd'.repeat(32);

describe.skipIf(process.platform === 'win32')('clients of a running local proxy', () => {
  let tmp;
  let claude;
  let counter = 0;
  let stub;
  let stubRunning = true;
  let fx;
  beforeAll(() => {
    tmp = makeTmp('provider-proxy-client-');
    // Fake `claude`: argv as JSON and the value of ANTHROPIC_AUTH_TOKEN.
    claude = join(tmp.dir, 'fake-claude');
    writeFileSync(claude, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.HOME + '/fake.argv', JSON.stringify(process.argv.slice(2)));\nif (process.env.ANTHROPIC_AUTH_TOKEN) fs.writeFileSync(process.env.HOME + '/fake.auth', process.env.ANTHROPIC_AUTH_TOKEN);\n`, { mode: 0o755 });
    chmodSync(claude, 0o755);
    const dir = join(tmp.dir, `f${++counter}`);
    mkdirSync(join(dir, 'home'), { recursive: true });
    fx = { dir, ...writeProfile(dir) };
    fx.proxyDir = join(dir, 'state', 'proxy');
    mkdirSync(fx.proxyDir, { recursive: true });
    stub = stubProxyProcess(fx.proxyDir);
    writeFileSync(join(fx.proxyDir, 'proxy.pid'), String(stub.pid));
    writeFileSync(join(fx.proxyDir, 'proxy.port'), String(PORT));
    writeFileSync(join(fx.proxyDir, 'client-token'), `${CLIENT_TOKEN}\n`, { mode: 0o600 });
  });
  afterAll(async () => { if (stubRunning) await stub.stop(); tmp.cleanup(); });

  const settingsFile = () => { const f = join(fx.dir, 'lane.json'); writeFileSync(f, '{}\n', { mode: 0o600 }); return f; };
  const start = (script, args, extra = {}) => {
    for (const name of ['fake.argv', 'fake.auth']) { try { unlinkSync(join(fx.env.HOME, name)); } catch { /* absent */ } }
    const env = { ...fx.env, OMC_PROVIDER_CLAUDE_BIN: claude, ...extra };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8', env });
    const read = (n) => { try { return readFileSync(join(fx.env.HOME, n), 'utf8'); } catch { return null; } };
    return { ...r, argv: read('fake.argv') && JSON.parse(read('fake.argv')), auth: read('fake.auth') };
  };
  const settingsOf = (r) => JSON.parse(readFileSync(r.argv[r.argv.lastIndexOf('--settings') + 1], 'utf8'));
  const TEAM = { OMC_TEAM_WORKER: 'team-a/worker-1', OMC_TEAM_NAME: 'team-a', OMC_TEAM_ROLE: 'executor' };

  it('(9) the launcher next to a running proxy: base URL = the proxy, token = the client token (not the key); the test pair wins over the proxy', () => {
    const r = start('provider-launch.cjs', ['--bg', '--settings', settingsFile(), 'p']);
    expect(r.status, r.stderr).toBe(0);
    const u = settingsOf(r);
    expect(u.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${PORT}`);
    expect(u.env.ANTHROPIC_AUTH_TOKEN).toBe(CLIENT_TOKEN);
    expect(u.env.OMC_ALLOW_LOOPBACK_PROXY_PORT).toBe(String(PORT));
    expect(JSON.stringify(u)).not.toContain(PLACEHOLDER_KEY);
    const pair = start('provider-launch.cjs', ['--bg', '--settings', settingsFile(), 'p'], { OMC_PROVIDER_BASE_URL: 'http://127.0.0.1:1', OMC_PROVIDER_API_KEY_FILE: fx.profile.apiKey.file });
    const u2 = settingsOf(pair);
    expect(u2.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1');
    expect(u2.env.ANTHROPIC_AUTH_TOKEN).toBe(PLACEHOLDER_KEY);
    expect('OMC_ALLOW_LOOPBACK_PROXY_PORT' in u2.env).toBe(false);
  });

  it('(10) a provider role of the worker next to a running proxy: base URL = the proxy in the settings, the client token in the child env (not the key); a Claude role unchanged', () => {
    const r = start('provider-worker.cjs', ['--model', 'sonnet'], TEAM);
    expect(r.status, r.stderr).toBe(0);
    const u = settingsOf(r);
    expect(u.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${PORT}`);
    expect(r.auth).toBe(CLIENT_TOKEN);
    expect(JSON.stringify(u)).not.toContain(PLACEHOLDER_KEY);
    const reviewer = start('provider-worker.cjs', ['--model', 'sonnet'], { ...TEAM, OMC_TEAM_ROLE: 'code-reviewer' });
    expect(reviewer.status, reviewer.stderr).toBe(0);
    expect(reviewer.argv).not.toContain('--settings');
  });

  it('(12) without a running proxy the launcher uses the provider address and the key from the helper again', async () => {
    await stub.stop();
    stubRunning = false;
    const r = start('provider-launch.cjs', ['--bg', '--settings', settingsFile(), 'p']);
    expect(r.status, r.stderr).toBe(0);
    const u = settingsOf(r);
    expect(u.env.ANTHROPIC_BASE_URL).toBe('https://llm.acme.example/anthropic');
    expect(u.env.ANTHROPIC_AUTH_TOKEN).toBe(PLACEHOLDER_KEY);
    const w = start('provider-worker.cjs', ['--model', 'sonnet'], TEAM);
    expect(settingsOf(w).env.ANTHROPIC_BASE_URL).toBe('https://llm.acme.example/anthropic');
    expect(w.auth).toBe(PLACEHOLDER_KEY);
  });

  it('(14) an incomplete or foreign test pair stops the launcher with exit 2 before anything starts', () => {
    const a = start('provider-launch.cjs', ['--bg', '--settings', settingsFile(), 'p'], { OMC_PROVIDER_BASE_URL: 'http://127.0.0.1:1' });
    const b = start('provider-launch.cjs', ['--bg', '--settings', settingsFile(), 'p'], { OMC_PROVIDER_API_KEY_FILE: fx.profile.apiKey.file });
    const c = start('provider-launch.cjs', ['--bg', '--settings', settingsFile(), 'p'], { OMC_PROVIDER_BASE_URL: 'https://foreign.example/api', OMC_PROVIDER_API_KEY_FILE: fx.profile.apiKey.file });
    for (const r of [a, b, c]) {
      expect(r.status).toBe(2);
      expect(r.argv).toBeNull();
      expect(r.stderr).not.toContain(tmp.dir);
    }
  });
});
