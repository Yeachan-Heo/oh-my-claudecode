/* global process, URL */
// Quota reads: the read-only CLI, the address rules of the test key pair, the gate without an adapter,
// and the gate on HTTP 200 with success false. Loopback servers run in this process; the CLI runs as a child.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp, PLACEHOLDER_KEY, writeProfile } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const LIB = fileURLToPath(new URL('../../../scripts/provider/lib/', import.meta.url));
const CLI = fileURLToPath(new URL('../../../scripts/provider/provider-quota.cjs', import.meta.url));
const { loadProfile } = require(join(LIB, 'profile.cjs'));
const { gate, quotaUrl, readBreaker, readQuota } = require(join(LIB, 'quota.cjs'));

const QUOTA_URL = 'https://quota.acme.example/api/monitor/usage/quota/limit';
const QUOTA_PATH = '/api/monitor/usage/quota/limit';
const limit5h = (percentage) => ({ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage, nextResetTime: Date.now() + 3600_000 });
const limitWeek = (percentage) => ({ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage, nextResetTime: Date.now() + 3 * 86400_000 });
const answer = (res, status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };

// Loopback endpoint in this process. hits records the path and the Authorization header of every request.
function serve(handler) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ url: req.url, authorization: req.headers.authorization ?? null });
    handler(req, res);
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({
    origin: `http://127.0.0.1:${server.address().port}`,
    hits,
    close: () => new Promise((closed) => server.close(() => closed())),
  })));
}

// Runs node with arguments and an explicit environment; resolves with status, stdout and stderr.
function runAsync(args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

describe.skipIf(process.platform === 'win32')('provider quota reads', () => {
  let tmp;
  beforeAll(() => { tmp = makeTmp('provider-quota-cli-'); });
  afterAll(() => tmp.cleanup());

  const profileIn = (name, overrides = {}) => {
    const dir = join(tmp.dir, name);
    mkdirSync(dir, { recursive: true });
    return { dir, ...writeProfile(dir, { quota: { adapter: 'monitor-limits', url: QUOTA_URL }, ...overrides }) };
  };

  it('(16) provider-quota: Bearer key on the exact path, windows and percentages printed, key never printed; missing key: 3; foreign base address: 2', async () => {
    const srv = await serve((req, res) => answer(res, 200, {
      success: true,
      data: { level: 'lite', limits: [limit5h(12), limitWeek(34), { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 1, currentValue: 3, usage: 100, remaining: 97, nextResetTime: 1800000000000 }] },
    }));
    try {
      const p = profileIn('q16');
      const ok = await runAsync([CLI], { ...p.env, OMC_PROVIDER_QUOTA_URL: srv.origin });
      expect(ok.status, ok.stderr).toBe(0);
      expect(srv.hits[0].url).toBe(QUOTA_PATH);
      expect(srv.hits[0].authorization).toBe(`Bearer ${PLACEHOLDER_KEY}`);
      expect(ok.stdout).toMatch(/5 h window \(TOKENS_LIMIT\): 12% used/);
      expect(ok.stdout).toMatch(/weekly \(TOKENS_LIMIT\): 34% used/);
      expect(ok.stdout.includes(PLACEHOLDER_KEY) || ok.stderr.includes(PLACEHOLDER_KEY)).toBe(false);

      const missing = profileIn('q16-missing', { apiKey: { file: join(tmp.dir, 'q16-missing', 'no-such-key') } });
      const absent = await runAsync([CLI], missing.env);
      expect(absent.status).toBe(3);
      expect(absent.stderr.includes(tmp.dir)).toBe(false);

      const keyFile = p.profile.apiKey.file;
      const foreign = await runAsync([CLI], { ...p.env, OMC_PROVIDER_BASE_URL: 'https://foreign.example', OMC_PROVIDER_API_KEY_FILE: keyFile });
      expect(foreign.status).toBe(2);
    } finally {
      await srv.close();
    }
  }, 60_000);

  it('(16b) quota address: the test key pair takes the origin of the loopback base and the exact path from quota.url; the gate reads that path once', async () => {
    const srv = await serve((req, res) => {
      if (req.url === QUOTA_PATH) answer(res, 200, { success: true, data: { level: 'lite', limits: [limit5h(12), limitWeek(12)] } });
      else answer(res, 200, { success: false, msg: '404 NOT_FOUND' }); // HTTP 200 with success false, as the provider answers a wrong path
    });
    try {
      const p = profileIn('q16b');
      const pairEnv = { ...p.env, OMC_PROVIDER_BASE_URL: srv.origin, OMC_PROVIDER_API_KEY_FILE: p.profile.apiKey.file };
      const profile = loadProfile(pairEnv).profile;
      expect(quotaUrl(profile, pairEnv)).toBe(`${srv.origin}${QUOTA_PATH}`);
      expect(quotaUrl(loadProfile(p.env).profile, {})).toBe(QUOTA_URL);
      const result = await gate(profile, pairEnv, PLACEHOLDER_KEY);
      expect(result.refuse).toBe(false);
      expect(srv.hits.length).toBe(1);
      expect(srv.hits[0].url).toBe(QUOTA_PATH);
    } finally {
      await srv.close();
    }
  }, 60_000);

  it('(16d) quota.cacheSeconds of the selected profile is the lifetime of the response cache: 60 (default) serves the second read from the cache, 0 reads the endpoint every time, a larger value keeps a response that the default would have dropped', async () => {
    const srv = await serve((req, res) => answer(res, 200, { success: true, data: { level: 'lite', limits: [limit5h(12), limitWeek(12)] } }));
    try {
      for (const [name, seconds, secondFromCache] of [['q16d-default', undefined, true], ['q16d-zero', 0, false]]) {
        const p = profileIn(name, seconds === undefined ? {} : { quota: { adapter: 'monitor-limits', url: QUOTA_URL, cacheSeconds: seconds } });
        const env = { ...p.env, OMC_PROVIDER_QUOTA_URL: srv.origin };
        const profile = loadProfile(env).profile;
        const before = srv.hits.length;
        expect((await readQuota(profile, env, PLACEHOLDER_KEY)).fromCache).toBeFalsy();
        expect(Boolean((await readQuota(profile, env, PLACEHOLDER_KEY)).fromCache), name).toBe(secondFromCache);
        expect(srv.hits.length - before, name).toBe(secondFromCache ? 1 : 2);
      }
      // a cache entry older than the default lifetime stays valid under a longer one and is dropped under the default
      const p = profileIn('q16d-long', { quota: { adapter: 'monitor-limits', url: QUOTA_URL, cacheSeconds: 3600 } });
      const env = { ...p.env, OMC_PROVIDER_QUOTA_URL: srv.origin };
      const long = loadProfile(env).profile;
      expect((await readQuota(long, env, PLACEHOLDER_KEY)).fromCache).toBeFalsy();
      const cacheFile = join(p.dir, 'state', 'quota-cache.json');
      const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
      writeFileSync(cacheFile, JSON.stringify({ ...cache, ts: Date.now() - 600_000 }));
      expect((await readQuota(long, env, PLACEHOLDER_KEY)).fromCache, 'a 10 minute old entry under cacheSeconds 3600').toBe(true);
      const short = loadProfile({ ...env, OMC_PROVIDER_PROFILE: 'acme' }).profile;
      short.quota.cacheSeconds = 60;
      expect(Boolean((await readQuota(short, env, PLACEHOLDER_KEY)).fromCache), 'the same entry under cacheSeconds 60').toBe(false);
    } finally {
      await srv.close();
    }
  }, 60_000);
  it('(16c) HTTP 200 with success false is a read error: fail-open start allowed, no authentication refusal, no breaker written', async () => {
    const srv = await serve((req, res) => answer(res, 200, { success: false, msg: '404 NOT_FOUND' }));
    try {
      const p = profileIn('q16c');
      const env = { ...p.env, OMC_PROVIDER_QUOTA_URL: srv.origin };
      const profile = loadProfile(env).profile;
      const read = await readQuota(profile, env, PLACEHOLDER_KEY, { fresh: true });
      expect(read.error).toMatch(/quota endpoint refused/);
      expect(read.auth).toBe(false);
      const result = await gate(profile, env, PLACEHOLDER_KEY);
      expect(result.refuse).toBe(false);
      expect(readBreaker(profile, env)).toBeNull();
    } finally {
      await srv.close();
    }
  }, 60_000);

  it('(opt-in) profile without a quota adapter (the default): the gate refuses nothing, reads nothing and writes no breaker or cache file', async () => {
    const srv = await serve((req, res) => answer(res, 200, { success: true, data: { level: 'lite', limits: [limit5h(100), limitWeek(100)] } }));
    try {
      const p = profileIn('q-opt-in', { quota: { adapter: 'none', url: null } });
      const env = { ...p.env, OMC_PROVIDER_QUOTA_URL: srv.origin };
      const profile = loadProfile(env).profile;
      expect(profile.quota.adapter).toBe('none');
      expect((await gate(profile, env, PLACEHOLDER_KEY)).refuse).toBe(false);
      expect(srv.hits.length).toBe(0);
      expect(existsSync(join(p.dir, 'state', 'breaker.json'))).toBe(false);
      expect(existsSync(join(p.dir, 'state', 'quota-cache.json'))).toBe(false);
    } finally {
      await srv.close();
    }
  }, 60_000);
});
