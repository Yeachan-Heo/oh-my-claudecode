/* global process, URL */
// Provider profile: file location, JSONC, profile selection, required fields, overrides,
// the test-only pair rule, defaults, validation, state paths and the advisor model.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { makeTmp, writeProfile } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const profile = require('../../../scripts/provider/lib/profile.cjs');

function codeOf(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return { code: error.code, exit: error.exit, message: error.message };
  }
}

describe.skipIf(process.platform === 'win32')('provider profile', () => {
  let tmp;
  beforeAll(() => {
    tmp = makeTmp('provider-profile-');
  });
  afterAll(() => {
    tmp.cleanup();
  });

  it('locates the profiles file: OMC_PROVIDER_PROFILES_FILE wins, then XDG_CONFIG_HOME, then HOME/.config', () => {
    expect(profile.profilesFilePath({ OMC_PROVIDER_PROFILES_FILE: '/fixture/p.jsonc', XDG_CONFIG_HOME: '/fixture/xdg', HOME: '/fixture/home' })).toBe('/fixture/p.jsonc');
    expect(profile.profilesFilePath({ XDG_CONFIG_HOME: '/fixture/xdg', HOME: '/fixture/home' })).toBe('/fixture/xdg/claude-omc/providers.jsonc');
    expect(profile.profilesFilePath({ HOME: '/fixture/home' })).toBe('/fixture/home/.config/claude-omc/providers.jsonc');
  });

  it('reads JSONC comments but keeps // inside string values', () => {
    const text = '{\n  // line comment\n  "url": "http://x.example//kept", /* block */\n  "n": 1\n}';
    expect(JSON.parse(profile.stripJsoncComments(text))).toEqual({ url: 'http://x.example//kept', n: 1 });
  });

  it('selects the profile: OMC_PROVIDER_PROFILE, then defaultProfile, then the only profile; an unknown name is a missing-profile error with exit 2', () => {
    const dir = join(tmp.dir, 'select');
    const { env } = writeProfile(dir);
    const file = env.OMC_PROVIDER_PROFILES_FILE;
    const doc = JSON.parse(profile.stripJsoncComments(readFileSync(file, 'utf8')));
    doc.profiles.other = { ...doc.profiles.acme, baseUrl: 'https://other.acme.example/anthropic' };
    doc.defaultProfile = undefined;
    writeFileSync(file, JSON.stringify(doc));
    expect(codeOf(() => profile.loadProfile(env))).toMatchObject({ code: 'missing_profile', exit: 2 });
    expect(profile.loadProfile({ ...env, OMC_PROVIDER_PROFILE: 'other' }).name).toBe('other');
    expect(codeOf(() => profile.loadProfile({ ...env, OMC_PROVIDER_PROFILE: 'nope' }))).toMatchObject({ code: 'missing_profile', exit: 2 });
    doc.defaultProfile = 'acme';
    writeFileSync(file, JSON.stringify(doc));
    expect(profile.loadProfile(env).name).toBe('acme');
  });

  it('requires baseUrl, one key source and the opus and sonnet models', () => {
    const dir = join(tmp.dir, 'required');
    const noBase = writeProfile(join(dir, 'a'));
    const doc = JSON.parse(readFileSync(noBase.file, 'utf8'));
    delete doc.profiles.acme.baseUrl;
    writeFileSync(noBase.file, JSON.stringify(doc));
    expect(codeOf(() => profile.loadProfile(noBase.env))).toMatchObject({ code: 'bad_field', exit: 2 });

    const twoKeys = writeProfile(join(dir, 'b'), { apiKey: { file: '/fixture/k', env: 'X' } });
    expect(codeOf(() => profile.loadProfile(twoKeys.env))).toMatchObject({ code: 'bad_field', exit: 2 });

    const noSonnet = writeProfile(join(dir, 'c'));
    const doc2 = JSON.parse(readFileSync(noSonnet.file, 'utf8'));
    delete doc2.profiles.acme.models.sonnet;
    writeFileSync(noSonnet.file, JSON.stringify(doc2));
    expect(codeOf(() => profile.loadProfile(noSonnet.env))).toMatchObject({ code: 'bad_field', exit: 2 });
  });

  it('applies neutral defaults from the table', () => {
    const { env } = writeProfile(join(tmp.dir, 'defaults'));
    const { profile: p } = profile.loadProfile(env);
    expect(p.contextWindow).toBe(200000);
    expect(p.limits).toEqual({ maxSessions: 6, slotWaitMs: 120000, taskTimeoutSeconds: 1800 });
    expect(p.quota.thresholds).toEqual({ pause: 96, stop: 99, weeklyAsWindow: true });
    expect(p.worker.model).toBe('sonnet');
    expect(p.worker.effort).toBe('high');
    expect(p.worker.maxToolCalls).toBe(0);
    expect(p.shellTimeoutMs).toBe(660000);
    expect(p.requestTimeoutMs).toBe(3000000);
    expect(p.quota.adapter).toBe('none');
    expect(p.rescue).toEqual({ mode: 'off', threshold: 2, advisorLimit: 2 });
    expect(p.guard.blockedCommands).toContain('provider-worker');
  });

  it('tuned non-default values are fixtures: a profile with them loads and keeps them', () => {
    const { env } = writeProfile(join(tmp.dir, 'tuned'), {}, { tuned: true });
    const { profile: p } = profile.loadProfile(env);
    expect(p.limits.maxSessions).toBe(16);
    expect(p.worker).toMatchObject({ model: 'haiku', effort: 'max' });
  });

  it('environment overrides win over the file when set and valid', () => {
    const { env } = writeProfile(join(tmp.dir, 'env-wins'));
    const { profile: p } = profile.loadProfile({ ...env, OMC_PROVIDER_ROLES: 'debugger,executor', OMC_PROVIDER_MAX_SESSIONS: '3' });
    expect(p.roles).toEqual(['debugger', 'executor']);
    expect(p.limits.maxSessions).toBe(3);
    const empty = profile.loadProfile({ ...env, OMC_PROVIDER_ROLES: '' });
    expect(empty.profile.roles).toEqual(['executor']);
    expect(codeOf(() => profile.loadProfile({ ...env, OMC_PROVIDER_MAX_SESSIONS: 'many' }))).toMatchObject({ code: 'bad_field', exit: 2 });
  });

  it('test pair: a loopback base URL needs the key file variable, the key file variable needs a loopback base URL, a foreign base URL is refused', () => {
    const { env } = writeProfile(join(tmp.dir, 'pair'));
    expect(profile.testBaseUrl(env)).toBeNull();
    expect(codeOf(() => profile.testBaseUrl({ ...env, OMC_PROVIDER_BASE_URL: 'http://127.0.0.1:9' }))).toMatchObject({ code: 'config', exit: 2 });
    expect(codeOf(() => profile.testBaseUrl({ ...env, OMC_PROVIDER_API_KEY_FILE: '/fixture/k' }))).toMatchObject({ code: 'config', exit: 2 });
    expect(codeOf(() => profile.testBaseUrl({ ...env, OMC_PROVIDER_BASE_URL: 'https://api.example.test', OMC_PROVIDER_API_KEY_FILE: '/fixture/k' }))).toMatchObject({ code: 'config', exit: 2 });
    expect(profile.testBaseUrl({ OMC_PROVIDER_BASE_URL: 'http://127.0.0.1:9', OMC_PROVIDER_API_KEY_FILE: '/fixture/k' })).toBe('http://127.0.0.1:9');
    const loaded = profile.loadProfile({ ...env, OMC_PROVIDER_BASE_URL: 'http://localhost:9', OMC_PROVIDER_API_KEY_FILE: '/fixture/k' });
    expect(loaded.profile.baseUrl).toBe('http://localhost:9');
    expect(loaded.profile.apiKey).toEqual({ file: '/fixture/k' });
  });

  it('a profile base URL without a loopback restriction is accepted from the file', () => {
    const { env } = writeProfile(join(tmp.dir, 'file-url'), { baseUrl: 'https://llm.acme.example/anthropic' });
    expect(profile.loadProfile(env).profile.baseUrl).toBe('https://llm.acme.example/anthropic');
  });

  it('a profile base URL must be https, or http for a loopback host; other hosts over http and other schemes exit 2 with the field name', () => {
    let index = 0;
    const load = (baseUrl) => {
      index += 1;
      const { env } = writeProfile(join(tmp.dir, `base-url-${index}`), { baseUrl });
      return codeOf(() => profile.loadProfile(env));
    };
    for (const accepted of ['https://llm.acme.example/anthropic', 'https://127.0.0.1:8443', 'http://127.0.0.1:3000', 'http://localhost:3000/x', 'http://[::1]:3000']) {
      expect(load(accepted), accepted).toBeNull();
    }
    for (const refused of ['http://llm.acme.example/anthropic', 'http://10.0.0.5:3000', 'http://127.0.0.1.acme.example', 'ftp://llm.acme.example', 'file:///etc/hosts', 'ws://127.0.0.1:3000', 'wss://llm.acme.example']) {
      expect(load(refused), refused).toMatchObject({ code: 'bad_field', exit: 2, message: expect.stringContaining('baseUrl') });
    }
    expect(load('http://llm.acme.example/anthropic').message).toMatch(/https URL/);
  });

  it('rejects wrong types and ranges with exit 2 and the field name in the message', () => {
    const bad = [
      [{ limits: { maxSessions: -1 } }, 'limits.maxSessions'],
      [{ quota: { thresholds: { pause: 'x', stop: 99, weeklyAsWindow: true } } }, 'quota.thresholds.pause'],
      [{ worker: { effort: 'huge' } }, 'worker.effort'],
    ];
    for (const [overrides, field] of bad) {
      const { env } = writeProfile(join(tmp.dir, `bad-${field}`), overrides);
      const result = codeOf(() => profile.loadProfile(env));
      expect(result, field).toMatchObject({ code: 'bad_field', exit: 2 });
      expect(result.message, field).toContain(field);
    }
  });

  it('proxy tuning parameters: defaults, values from the file and range errors with exit 2', () => {
    const names = ['retryMaxAttempts', 'retryBaseDelayMs', 'retryMaxDelayMs', 'retryAfterCapMs', 'retryJitterMs', 'maxBufferedBodyBytes', 'heldBodyCapBytes', 'connectTimeoutMs', 'responseHeaderTimeoutMs', 'stopGraceMs', 'logMaxBytes'];
    const defaults = writeProfile(join(tmp.dir, 'proxy-defaults'));
    expect(profile.loadProfile(defaults.env).profile.proxy).toMatchObject({
      retryMaxAttempts: 0, retryBaseDelayMs: 1000, retryMaxDelayMs: 30000, retryAfterCapMs: 120000, retryJitterMs: 0,
      maxBufferedBodyBytes: 64 * 1024 * 1024, heldBodyCapBytes: 64 * 1024, connectTimeoutMs: 30000, responseHeaderTimeoutMs: 300000,
      stopGraceMs: 2000, logMaxBytes: 8 * 1024 * 1024,
    });
    const tuned = writeProfile(join(tmp.dir, 'proxy-tuned'), { proxy: { retryMaxAttempts: 5, retryBaseDelayMs: 250, logMaxBytes: 1024, stopGraceMs: 0 } });
    expect(profile.loadProfile(tuned.env).profile.proxy).toMatchObject({ retryMaxAttempts: 5, retryBaseDelayMs: 250, logMaxBytes: 1024, stopGraceMs: 0, connectTimeoutMs: 30000 });
    for (const name of names) {
      const { env } = writeProfile(join(tmp.dir, `proxy-bad-${name}`), { proxy: { [name]: -1 } });
      const result = codeOf(() => profile.loadProfile(env));
      expect(result, name).toMatchObject({ code: 'bad_field', exit: 2 });
      expect(result.message, name).toContain(`proxy.${name}`);
    }
    for (const name of ['retryBaseDelayMs', 'retryMaxDelayMs', 'maxBufferedBodyBytes', 'heldBodyCapBytes', 'connectTimeoutMs', 'responseHeaderTimeoutMs', 'logMaxBytes']) {
      const { env } = writeProfile(join(tmp.dir, `proxy-zero-${name}`), { proxy: { [name]: 0 } });
      expect(codeOf(() => profile.loadProfile(env)), name).toMatchObject({ code: 'bad_field', exit: 2 });
    }
  });

  it('unknown fields are warnings, not errors', () => {
    const { env } = writeProfile(join(tmp.dir, 'unknown'), { surprise: true });
    const warnings = [];
    const loaded = profile.loadProfile(env, { onWarning: (text) => warnings.push(text) });
    expect(loaded.profile.name).toBe('acme');
    expect(warnings.join('\n')).toContain('surprise');
  });

  it('expands ~ in path fields', () => {
    const { env } = writeProfile(join(tmp.dir, 'tilde'), { apiKey: { file: '~/fixture-key' }, stateDir: '~/fixture-state' });
    const loaded = profile.loadProfile(env);
    expect(loaded.profile.apiKey.file).toBe(join(homedir(), 'fixture-key'));
    expect(loaded.profile.stateDir).toBe(join(homedir(), 'fixture-state'));
  });

  it('state paths come from the profile, OMC_PROVIDER_STATE_DIR wins, and the default sits under the home state directory', () => {
    const dir = join(tmp.dir, 'state');
    const { env } = writeProfile(dir);
    const { profile: p } = profile.loadProfile(env);
    expect(profile.stateDirOf(p, {})).toBe(join(dir, 'state'));
    expect(profile.stateDirOf(p, { OMC_PROVIDER_STATE_DIR: '/fixture/state-override' })).toBe('/fixture/state-override');
    expect(profile.statePath(p, {}, 'slots', 'x.json')).toBe(join(dir, 'state', 'slots', 'x.json'));
    const bare = { ...p, stateDir: null, name: 'acme' };
    expect(profile.stateDirOf(bare, {})).toBe(join(homedir(), '.omc', 'state', 'provider', 'acme'));
  });

  it('advisor model: default when empty, trimmed and lower-cased when valid, fable only when listed, null otherwise', () => {
    const { env } = writeProfile(join(tmp.dir, 'advisor'));
    const { profile: p } = profile.loadProfile(env);
    expect(profile.advisorModel(p, {})).toBe('opus');
    expect(profile.advisorModel(p, { OMC_PROVIDER_ADVISOR_MODEL: '   ' })).toBe('opus');
    expect(profile.advisorModel(p, { OMC_PROVIDER_ADVISOR_MODEL: ' SONNET ' })).toBe('sonnet');
    expect(profile.advisorModel(p, { OMC_PROVIDER_ADVISOR_MODEL: 'fable' })).toBe('fable');
    expect(profile.advisorModel({ ...p, advisor: { ...p.advisor, models: ['opus', 'sonnet'] } }, { OMC_PROVIDER_ADVISOR_MODEL: 'fable' })).toBeNull();
    expect(profile.advisorModel(p, { OMC_PROVIDER_ADVISOR_MODEL: 'gpt-fixture' })).toBeNull();
  });

  it('the example preset loads with its own values and the neutral defaults for everything else', () => {
    const preset = fileURLToPath(new URL('../../../examples/provider/zai.providers.jsonc', import.meta.url));
    const loaded = profile.loadProfile({ OMC_PROVIDER_PROFILES_FILE: preset }, { onWarning: () => {} });
    const profiles = JSON.parse(profile.stripJsoncComments(readFileSync(preset, 'utf8'))).profiles;
    const presetName = Object.keys(profiles)[0];
    expect(loaded.name).toBe(presetName);
    expect(loaded.profile.baseUrl).toBe(profiles[presetName].baseUrl);
    expect(loaded.profile.modelIdPrefixes).toHaveLength(1);
    expect(loaded.profile.errorCodes).toEqual({ quota: [1308, 1310], throttle: [1305] });
    expect(loaded.profile.worker.model).toBe('sonnet');
    expect(loaded.profile.quota.thresholds.stop).toBe(99);
  });

  it('opt-in: without a profiles file nothing is selected, nothing is created, and no profile applies', () => {
    const dir = join(tmp.dir, 'opt-in');
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const env = { PATH: process.env.PATH, HOME: home };
    expect(codeOf(() => profile.loadProfile(env))).toMatchObject({ code: 'missing_profile', exit: 2 });
    expect(existsSync(join(home, '.config'))).toBe(false);
    expect(existsSync(join(home, '.omc'))).toBe(false);
  });
});
