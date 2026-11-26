/* global process */
// Allow-list of the executor environment: unit-level cases (the end-to-end cases through the worker launcher
// are in worker.test.mjs).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { executorEnv } = require('../../../scripts/provider/lib/env.cjs');

describe.skipIf(process.platform === 'win32')('executor environment allow-list', () => {
  it('(a) passes the worker variables added for the worker with their values unchanged (worker mode)', () => {
    for (const [name, value] of [['OMC_WORKER_LAUNCH_ATTEMPT_ID', 'abc-123'], ['OMC_STATE_DIR', '/fixture/state']]) {
      const result = executorEnv({ [name]: value }, {});
      expect(result[name], name).toBe(value);
    }
  });

  it('(a2) session mode drops the worker variables, keeps the session variables', () => {
    const input = {
      OMC_WORKER_LAUNCH_ATTEMPT_ID: 'abc-123',
      OMC_STATE_DIR: '/fixture/state',
      SSH_AUTH_SOCK: '/agent/socket',
      CLAUDE_CONFIG_DIR: '/claude-config',
      XDG_RUNTIME_DIR: '/runtime',
      FIXTURE_SESSION_KEY: 'fixture-session-key',
      OMC_JEV_LOG_LEVEL: 'info',
    };
    const profile = { envPassthrough: { names: ['FIXTURE_SESSION_KEY'], prefixes: [] } };
    const session = executorEnv(input, { session: true, profile });
    expect('OMC_WORKER_LAUNCH_ATTEMPT_ID' in session).toBe(false);
    expect('OMC_STATE_DIR' in session).toBe(false);
    for (const name of ['SSH_AUTH_SOCK', 'CLAUDE_CONFIG_DIR', 'XDG_RUNTIME_DIR', 'FIXTURE_SESSION_KEY']) {
      expect(session[name], `session pass-through lost: ${name}`).toBe(input[name]);
    }
    expect(session.OMC_JEV_LOG_LEVEL).toBe('info');
  });

  it('(a3) FIXTURE_SESSION_KEY passes in session mode only when the profile lists it', () => {
    const input = { FIXTURE_SESSION_KEY: 'fixture-session-key' };
    expect('FIXTURE_SESSION_KEY' in executorEnv(input, { session: true })).toBe(false);
    expect(executorEnv(input, { session: true, profile: { envPassthrough: { names: ['FIXTURE_SESSION_KEY'] } } }).FIXTURE_SESSION_KEY).toBe('fixture-session-key');
  });

  it('(c-cred) the Anthropic credentials of the user never reach the executor environment, in either mode and even when a profile lists them', () => {
    const input = { ANTHROPIC_API_KEY: 'fixture-api-key', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth-token', ANTHROPIC_AUTH_TOKEN: 'fixture-auth-token' };
    const listing = { envPassthrough: { names: Object.keys(input), prefixes: ['ANTHROPIC_', 'CLAUDE_CODE_'] } };
    for (const options of [{}, { session: true }, { profile: listing }, { session: true, profile: listing }]) {
      const out = executorEnv(input, options);
      for (const name of Object.keys(input)) {
        expect(name in out, `credential ${name} reached the executor environment with ${JSON.stringify(Object.keys(options))}`).toBe(false);
      }
    }
  });

  it('(b) keeps the allow-list: unknown worker variables, tokens, provider selectors, notification variables and factory secrets are removed', () => {
    const input = {
      OMC_WORKER_SOMETHING_ELSE: 'x',
      OMC_SLACK_WEBHOOK_URL: 'https://hooks.example/services/x/y/z',
      OMC_DISCORD_WEBHOOK: 'https://discord.example/api/webhooks/x/y',
      OMC_TELEGRAM_BOT_TOKEN: 'telegram-fixture',
      OMC_WEBHOOK_URL: 'https://w.example/hook',
      OMC_OPENCLAW_WEBHOOK: 'https://oc.example/hook',
      ANTHROPIC_API_KEY: 'a',
      CLAUDE_CODE_OAUTH_TOKEN: 'c',
      FIXTURE_SESSION_KEY: 'ts',
      GH_TOKEN: 'gh',
      GITHUB_TOKEN: 'gt',
      AWS_ACCESS_KEY_ID: 'ak',
      AWS_SECRET_ACCESS_KEY: 'sk',
      AWS_SESSION_TOKEN: 'st',
      VERTEX_REGION_ANTHROPIC: 'eu',
      VERTEX_REGION_CLAUDE: 'eu',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
      CLAUDE_CODE_SUBAGENT_MODEL: 'sub',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500',
      OMC_PROVIDER_API_KEY_FILE: '/x',
      OMC_PROVIDER_BASE_URL: 'https://foreign.example',
      OMC_PROVIDER_CLAUDE_BIN: '/x',
      ANTHROPIC_AUTH_TOKEN: 't',
      ANTHROPIC_BASE_URL: 'https://foreign.example/v1',
      OMC_RECOVERY_GATE_SPEC: '{"x":1}',
      OMC_WORKER_LAUNCH_SPEC_FILE: '/descriptor.json',
      OMC_FACTORY_HMAC_SECRET: 'hmac',
    };
    const worker = executorEnv(input, {});
    for (const name of Object.keys(input)) {
      expect(name in worker, `variable passed to the executor: ${name}`).toBe(false);
    }
    const session = executorEnv(input, { session: true });
    for (const name of Object.keys(input)) {
      if (name === 'FIXTURE_SESSION_KEY') continue; // session mode passes it only through profile.envPassthrough
      expect(name in session, `variable passed in session mode: ${name}`).toBe(false);
    }
    const base = executorEnv({ PATH: '/usr/bin', HOME: '/tmp/home-fixture', ...input }, {});
    expect(base.PATH).toBe('/usr/bin');
    expect(base.HOME).toBe('/tmp/home-fixture');
  });
});
