/* global process, fetch */
// Self-check of the shared fixtures that later provider tasks rely on.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp, fakeClaude, fakeProvider, fakeQuotaServer, runNode, stubProxyProcess, writeProfile } from './_helpers.mjs';

describe.skipIf(process.platform === 'win32')('provider test fixtures', () => {
  it('fakeClaude records argv and environment names and exits with FAKE_EXIT', () => {
    const tmp = makeTmp('provider-fixture-claude-');
    try {
      const bin = fakeClaude(tmp.dir, { exit: 0 });
      const r = runNode(bin, ['-p', 'hello'], { env: { PATH: process.env.PATH, HOME: tmp.home, FAKE_EXIT: '7' } });
      expect(r.status).toBe(7);
      expect(JSON.parse(readFileSync(join(tmp.home, 'fake.argv'), 'utf8'))).toEqual(['-p', 'hello']);
      expect(JSON.parse(readFileSync(join(tmp.home, 'fake.env'), 'utf8'))).toContain('FAKE_EXIT');
    } finally {
      tmp.cleanup();
    }
  });

  it('writeProfile writes a profile file that loads and returns its env', () => {
    const tmp = makeTmp('provider-fixture-profile-');
    try {
      const { file, env } = writeProfile(tmp.dir);
      expect(existsSync(file)).toBe(true);
      expect(env.OMC_PROVIDER_PROFILES_FILE).toBe(file);
    } finally {
      tmp.cleanup();
    }
  });

  it('fakeProvider answers on loopback with the scenario in order and records requests', async () => {
    const provider = await fakeProvider([{ status: 429, body: 'slow' }, { status: 200, body: 'ok' }]);
    try {
      const first = await fetch(`${provider.url}/v1/messages`, { method: 'POST', body: '{"a":1}' });
      const second = await fetch(`${provider.url}/v1/messages`, { method: 'POST', body: '{"b":2}' });
      expect(first.status).toBe(429);
      expect(second.status).toBe(200);
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[0].body).toBe('{"a":1}');
    } finally {
      await provider.close();
    }
  });

  it('fakeQuotaServer answers with the limits and records the authorization header', async () => {
    const quota = await fakeQuotaServer([{ type: 'TOKENS_LIMIT', unit: 3, percentage: 12 }]);
    try {
      const response = await fetch(`${quota.url}/api/monitor/usage/quota/limit`, { headers: { authorization: 'Bearer fixture-token' } });
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.limits[0].percentage).toBe(12);
      expect(quota.hits[0].authorization).toBe('Bearer fixture-token');
    } finally {
      await quota.close();
    }
  });

  it('stubProxyProcess runs a process that stops on request', async () => {
    const tmp = makeTmp('provider-fixture-proxy-');
    try {
      const stub = stubProxyProcess(tmp.dir);
      expect(stub.pid).toBeGreaterThan(1);
      await stub.stop();
    } finally {
      tmp.cleanup();
    }
  });
});
