/* global process */
// Client side of the proxy: liveness rule, base URL and token for tools, endpoint resolution.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { makeTmp, stubProxyProcess, writeProfile, fakeKeyFile } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const state = require('../../../scripts/provider/lib/proxy-state.cjs');
const { loadProfile } = require('../../../scripts/provider/lib/profile.cjs');

function writeState(dir, { pid, port, target = 'https://llm.acme.example/anthropic' }) {
  mkdirSync(dir, { recursive: true });
  if (pid !== undefined) writeFileSync(join(dir, 'proxy.pid'), `${pid}\n`);
  if (port !== undefined) writeFileSync(join(dir, 'proxy.port'), `${port}\n`);
  writeFileSync(join(dir, 'proxy.target'), `${target}\n`);
}

describe.skipIf(process.platform === 'win32')('provider proxy state (client side)', () => {
  let tmp;
  beforeAll(() => {
    tmp = makeTmp('provider-proxy-state-');
  });
  afterAll(() => {
    tmp.cleanup();
  });

  it('(30) readClient is null for a missing directory, a dead pid, a live pid without the marker and invalid numbers', async () => {
    expect(state.readClient(join(tmp.dir, 'missing'))).toBeNull();

    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await new Promise((done) => dead.on('close', done));
    writeState(join(tmp.dir, 'dead'), { pid: dead.pid, port: 41000 });
    expect(state.readClient(join(tmp.dir, 'dead'))).toBeNull();

    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      writeState(join(tmp.dir, 'stranger'), { pid: stranger.pid, port: 41001 });
      expect(state.isLive(state.readProxyState(join(tmp.dir, 'stranger')))).toBe(false);
      expect(state.readClient(join(tmp.dir, 'stranger'))).toBeNull();
    } finally {
      stranger.kill('SIGKILL');
    }

    const stub = stubProxyProcess(join(tmp.dir, 'stub-bad'));
    try {
      for (const [pid, port] of [['abc', 41002], [1, 41002], [stub.pid, 0], [stub.pid, 70000], [stub.pid, 'x'], [undefined, 41002]]) {
        const dir = join(tmp.dir, `bad-${pid}-${port}`);
        writeState(dir, { pid, port });
        expect(state.readClient(dir), `${pid}/${port}`).toBeNull();
      }
    } finally {
      await stub.stop();
    }
  });

  it('(30) readClient returns the base URL and the token for a live proxy; without a token file the placeholder', async () => {
    const stub = stubProxyProcess(join(tmp.dir, 'stub-live'));
    try {
      const dir = join(tmp.dir, 'live');
      writeState(dir, { pid: stub.pid, port: 41003 });
      expect(state.readClient(dir)).toEqual({
        baseUrl: 'http://127.0.0.1:41003', token: state.PROXY_PLACEHOLDER_TOKEN, pid: stub.pid, port: 41003,
      });
      writeFileSync(join(dir, 'client-token'), 'abcdef0123456789\n');
      expect(state.readClient(dir).token).toBe('abcdef0123456789');
      expect(state.readProxyState(dir)).toEqual({ pid: stub.pid, port: 41003, target: 'https://llm.acme.example/anthropic' });
    } finally {
      await stub.stop();
    }
  });

  it('the marker is the script name and the serve sub-command', () => {
    expect(state.PROXY_MARKER).toEqual(['provider-proxy', '_serve']);
    expect(state.PROXY_PLACEHOLDER_TOKEN).toBe('provider-proxy-placeholder');
  });

  it('opt-in: without a running proxy the endpoint is the provider base URL and no token is used', () => {
    const { env } = writeProfile(join(tmp.dir, 'optin'));
    const { profile } = loadProfile(env);
    expect(state.resolveEndpoint(profile, env)).toEqual({ baseUrl: 'https://llm.acme.example/anthropic', viaProxy: false, clientToken: null });
  });

  it('a running proxy of the profile state directory is used with its client token', async () => {
    const dir = join(tmp.dir, 'viaproxy');
    const { env } = writeProfile(dir);
    const { profile } = loadProfile(env);
    const proxyDir = state.proxyDir(profile, env);
    expect(proxyDir).toBe(join(dir, 'state', 'proxy'));
    const stub = stubProxyProcess(join(tmp.dir, 'stub-via'));
    try {
      writeState(proxyDir, { pid: stub.pid, port: 41004 });
      writeFileSync(join(proxyDir, 'client-token'), 'tok-0123456789\n');
      expect(state.resolveEndpoint(profile, env)).toEqual({ baseUrl: 'http://127.0.0.1:41004', viaProxy: true, clientToken: 'tok-0123456789' });
      expect(state.proxyDir(profile, { ...env, OMC_PROVIDER_PROXY_DIR: join(tmp.dir, 'elsewhere') })).toBe(join(tmp.dir, 'elsewhere'));
    } finally {
      await stub.stop();
    }
  });

  it('the test pair wins over a running proxy', async () => {
    const dir = join(tmp.dir, 'pair');
    const { env } = writeProfile(dir);
    const { profile } = loadProfile(env);
    const stub = stubProxyProcess(join(tmp.dir, 'stub-pair'));
    try {
      writeState(state.proxyDir(profile, env), { pid: stub.pid, port: 41005 });
      const pairEnv = { ...env, OMC_PROVIDER_BASE_URL: 'http://127.0.0.1:41999', OMC_PROVIDER_API_KEY_FILE: fakeKeyFile(join(dir, 'pair-key')) };
      expect(state.resolveEndpoint(profile, pairEnv)).toEqual({ baseUrl: 'http://127.0.0.1:41999', viaProxy: false, clientToken: null });
    } finally {
      await stub.stop();
    }
  });
});
