/* global process */
// Environment for provider sessions: required tests of the environment specification
// (exact key set, string values, URL propagation, deny-list derivation, tier texts),
// plus the stripping helpers built on the same key set.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const env = require('../../../scripts/provider/lib/env.cjs');

const PROFILE = {
  name: 'acme',
  baseUrl: 'https://llm.acme.example/anthropic',
  models: {
    opus: { id: 'acme-large[1m]' },
    sonnet: { id: 'acme-large[1m]' },
    haiku: { id: 'acme-small[1m]' },
    default: 'sonnet',
  },
  contextWindow: 1000000,
  requestTimeoutMs: 3000000,
  shellTimeoutMs: 660000,
};

const EXPECTED_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
  'API_TIMEOUT_MS',
  'BASH_DEFAULT_TIMEOUT_MS',
  'BASH_MAX_TIMEOUT_MS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_AUTO_MODE_SERVER',
  'CLAUDE_CODE_AUTO_MODE_MODEL',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_AUTOUPDATER',
  'DISABLE_ERROR_REPORTING',
];

describe.skipIf(process.platform === 'win32')('provider environment specification', () => {
  it('has exactly the specified key set', () => {
    expect(Object.keys(env.providerEnv(PROFILE)).sort()).toEqual([...EXPECTED_KEYS].sort());
    expect([...env.PROVIDER_ENV_KEYS].sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  it('has the same key set when the optional haiku tier is absent', () => {
    const models = { opus: PROFILE.models.opus, sonnet: PROFILE.models.sonnet, default: 'sonnet' };
    expect(Object.keys(env.providerEnv({ ...PROFILE, models })).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  it('gives string values only', () => {
    for (const [name, value] of Object.entries(env.providerEnv(PROFILE))) {
      expect(typeof value, name).toBe('string');
    }
  });

  it('propagates the base URL from the profile and from an explicit argument', () => {
    expect(env.providerEnv(PROFILE).ANTHROPIC_BASE_URL).toBe(PROFILE.baseUrl);
    expect(env.providerEnv(PROFILE, 'http://127.0.0.1:3000').ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:3000');
  });

  it('sets the models, timeouts and flags from the profile', () => {
    const out = env.providerEnv(PROFILE);
    expect(out.ANTHROPIC_MODEL).toBe('acme-large[1m]');
    expect(out.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('acme-small[1m]');
    expect(out.API_TIMEOUT_MS).toBe('3000000');
    expect(out.BASH_DEFAULT_TIMEOUT_MS).toBe('660000');
    expect(out.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000');
    expect(out.CLAUDE_CODE_AUTO_MODE_SERVER).toBe('0');
    expect(out.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT).toBe('1');
    expect(out.DISABLE_AUTOUPDATER).toBe('1');
  });

  it('deny-list equals the key set plus credentials, markers and the fable model variable', () => {
    const expected = [...EXPECTED_KEYS, 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OMC_PROVIDER', 'OMC_PROVIDER_SETTINGS_FILE', 'ANTHROPIC_DEFAULT_FABLE_MODEL'];
    expect([...env.DENY_ENV].sort()).toEqual([...new Set(expected)].sort());
  });

  it('both Anthropic user credentials are in the deny-list', () => {
    expect(env.DENY_ENV).toContain('ANTHROPIC_API_KEY');
    expect(env.DENY_ENV).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('tier descriptions are non-empty and differ from the display names', () => {
    const out = env.providerEnv(PROFILE);
    for (const tier of ['OPUS', 'SONNET', 'HAIKU']) {
      const name = out[`ANTHROPIC_DEFAULT_${tier}_MODEL_NAME`];
      const description = out[`ANTHROPIC_DEFAULT_${tier}_MODEL_DESCRIPTION`];
      expect(description.length).toBeGreaterThan(0);
      expect(description).not.toBe(name);
    }
  });

  it('uses the profile text for names and descriptions when given', () => {
    const models = { ...PROFILE.models, opus: { id: 'acme-large[1m]', name: 'Acme Large', description: 'Acme large model for hard work.' } };
    const out = env.providerEnv({ ...PROFILE, models });
    expect(out.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME).toBe('Acme Large');
    expect(out.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION).toBe('Acme large model for hard work.');
  });
});

describe('stripping helpers', () => {
  it('stripProviderEnv removes every deny-listed name and keeps the rest', () => {
    const input = { PATH: '/bin', ANTHROPIC_BASE_URL: 'https://x.example', OMC_PROVIDER: 'acme', KEEP_ME: '1' };
    const out = env.stripProviderEnv(input);
    expect(out).toEqual({ PATH: '/bin', KEEP_ME: '1' });
  });

  it('stripOverrides removes credentials and every OMC_PROVIDER_* variable', () => {
    const input = { PATH: '/bin', ANTHROPIC_API_KEY: 'a', CLAUDE_CODE_OAUTH_TOKEN: 'b', OMC_PROVIDER_API_KEY_FILE: '/k', OMC_PROVIDER: 'acme', OMC_PROVIDERX: '1' };
    expect(env.stripOverrides(input)).toEqual({ PATH: '/bin', OMC_PROVIDERX: '1' });
  });

  it('isForeignProvider accepts Anthropic hosts and flags everything else', () => {
    expect(env.isForeignProvider({})).toBe(false);
    expect(env.isForeignProvider({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1' })).toBe(false);
    expect(env.isForeignProvider({ ANTHROPIC_BASE_URL: 'https://x.anthropic.com' })).toBe(false);
    expect(env.isForeignProvider({ ANTHROPIC_BASE_URL: 'https://anthropic.com.evil.example' })).toBe(true);
    expect(env.isForeignProvider({ ANTHROPIC_BASE_URL: 'https://llm.acme.example/anthropic' })).toBe(true);
    expect(env.isForeignProvider({ ANTHROPIC_BASE_URL: 'not a url' })).toBe(true);
  });
});
