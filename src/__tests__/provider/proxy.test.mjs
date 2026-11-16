/* global process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval */
// Acceptance tests of the local provider proxy. Each case starts a real detached server with
// port 0 against a fake provider on 127.0.0.1 and talks to it over HTTP. Numbers follow the
// acceptance list of the proxy specification; (28) to (32) cover the client token, the
// listener address, profile layering and the opt-in behavior.
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { makeTmp, fakeKeyFile, processAlive, writeProfile, PLACEHOLDER_KEY } from './_helpers.mjs';
import { backoffDelayMs } from '../../../scripts/provider/provider-proxy.mjs';

const SCRIPT = fileURLToPath(new URL('../../../scripts/provider/provider-proxy.mjs', import.meta.url));
const CLIENT_CREDENTIAL = 'client-placeholder-credential';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(check, ms = 5000, step = 50) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await sleep(step);
  }
}

function freePort() {
  return new Promise((done) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

// Server processes (command line carries `_serve`) whose command line mentions the directory.
function serverProcesses(dir) {
  const found = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8');
      if (cmdline.includes('_serve') && cmdline.includes('provider-proxy') && cmdline.includes(dir)) found.push(Number(name));
    } catch { /* process gone */ }
  }
  return found;
}

function killServers(dir) {
  for (const pid of serverProcesses(dir)) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch { /* gone */ }
    }
  }
}

describe.skipIf(process.platform === 'win32')('provider proxy', () => {
  let tmp;
  let counter = 0;
  const fakes = [];

  beforeAll(() => {
    tmp = makeTmp('provider-proxy-');
  });
  afterEach(async () => {
    killServers(tmp.dir);
    while (fakes.length) await fakes.pop().close();
  });
  afterAll(() => {
    killServers(tmp.dir);
    expect(serverProcesses(tmp.dir)).toEqual([]);
    tmp.cleanup();
  });

  // Control command, asynchronous so the fake provider in this process keeps answering.
  function run(args, { env = {}, timeoutMs = 40000 } = {}) {
    return new Promise((done) => {
      const child = spawn(process.execPath, [SCRIPT, ...args], {
        env: { PATH: process.env.PATH, HOME: tmp.home, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        done({ code, out, err });
      });
    });
  }

  function newCase(name) {
    counter++;
    const dir = join(tmp.dir, `${name}-${counter}`);
    mkdirSync(dir, { recursive: true });
    return { dir, stateDir: join(dir, 'state'), keyFile: fakeKeyFile(dir) };
  }

  // Fake provider: records every request; `respond(record, req, res, n)` answers it.
  function makeFake(respond = (rec, req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }, port = 0) {
    const requests = [];
    const state = { inflight: 0, maxInflight: 0 };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), at: Date.now() };
        requests.push(record);
        state.inflight++;
        state.maxInflight = Math.max(state.maxInflight, state.inflight);
        res.on('close', () => {
          state.inflight--;
          record.closedAt = Date.now();
          record.completed = res.writableFinished;
        });
        respond(record, req, res, requests.length);
      });
    });
    return new Promise((done) => {
      server.listen(port, '127.0.0.1', () => {
        const fake = {
          port: server.address().port,
          url: `http://127.0.0.1:${server.address().port}`,
          requests,
          get maxInflight() { return state.maxInflight; },
          close: () => new Promise((closed) => { server.closeAllConnections(); server.close(() => closed()); }),
        };
        fakes.push(fake);
        done(fake);
      });
    });
  }

  const startArgs = (c, fake, extra = [], { token = 'none' } = {}) => [
    'start', '--upstream', fake.url, '--api-key-file', c.keyFile, '--state-dir', c.stateDir, '--port', '0',
    '--idle-timeout', '120', '--retry-base-delay-ms', '5', '--retry-max-delay-ms', '20',
    ...(token === null ? [] : ['--client-token', token]), ...extra,
  ];
  const start = (c, fake, extra, options) => run(startArgs(c, fake, extra, options));
  const proxyPort = (c) => Number(readFileSync(join(c.stateDir, 'proxy.port'), 'utf8'));
  const proxyPid = (c) => Number(readFileSync(join(c.stateDir, 'proxy.pid'), 'utf8'));
  const status = async (c) => JSON.parse((await run(['status', '--json', '--state-dir', c.stateDir])).out);
  const health = (c) => new Promise((done) => {
    http.get({ host: '127.0.0.1', port: proxyPort(c), path: '/health' }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => done(JSON.parse(text)));
    });
  });

  // Client request through the proxy. Returns a promise with an abort() method.
  function call(c, { method = 'POST', path = '/v1/messages', headers = {}, body, host, onChunk } = {}) {
    const payload = body === undefined && method !== 'GET' ? '{}' : body;
    let req;
    const promise = new Promise((done) => {
      const began = Date.now();
      req = http.request({
        host: '127.0.0.1',
        port: proxyPort(c),
        method,
        path,
        headers: { authorization: `Bearer ${CLIENT_CREDENTIAL}`, ...(host ? { host } : {}), ...headers },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => {
          chunks.push(chunk);
          if (onChunk) onChunk(chunk, Date.now());
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          done({ status: res.statusCode, headers: res.headers, raw, text: raw.toString('utf8'), ms: Date.now() - began });
        });
        res.on('error', () => done({ status: res.statusCode, error: 'response' }));
        res.on('aborted', () => done({ status: res.statusCode, error: 'aborted' }));
      });
      req.on('error', (error) => done({ error: error.code ?? 'error' }));
      req.end(payload);
    });
    promise.abort = () => req.destroy();
    return promise;
  }

  const sse = (res) => res.writeHead(200, { 'content-type': 'text/event-stream' });

  it('(1) start prints pid, port and limit; status --json reports them; a second start leaves the server alone', async () => {
    const c = newCase('t1');
    const fake = await makeFake();
    const port = await freePort();
    const first = await start(c, fake, ['--port', String(port)]);
    expect(first.code, first.err).toBe(0);
    expect(first.out).toMatch(/^started pid=\d+ port=\d+ limit=4$/m);
    const info = await status(c);
    expect(info.running).toBe(true);
    expect(info.port).toBe(port);
    expect(typeof info.counters.total_requests).toBe('number');
    const pid = proxyPid(c);
    const second = await start(c, fake, ['--port', String(port)]);
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/already running pid=\d+ port=\d+ limit=4/);
    expect(proxyPid(c)).toBe(pid);
    const changed = await start(c, fake, ['--port', String(port), '--max-concurrency', '9']);
    expect(changed.out).toContain('changing the limit requires stop and start');
  });

  it('(2) the real key replaces client credentials; x-api-key is set only when the client sent it; cookies and forwarding headers are dropped', async () => {
    const c = newCase('t2');
    const fake = await makeFake();
    expect((await start(c, fake)).code).toBe(0);
    await call(c, {
      headers: {
        authorization: 'Bearer placeholder', 'x-api-key': 'placeholder', cookie: 'a=b', via: '1.1 x',
        'x-forwarded-for': '1.2.3.4', 'anthropic-version': '2023-06-01', 'accept-encoding': 'gzip',
      },
    });
    await call(c, { headers: { authorization: 'Bearer placeholder' } });
    const [both, only] = fake.requests;
    expect(both.headers.authorization).toBe(`Bearer ${PLACEHOLDER_KEY}`);
    expect(both.headers['x-api-key']).toBe(PLACEHOLDER_KEY);
    expect(JSON.stringify(both.headers)).not.toContain('placeholder');
    expect(both.headers.cookie).toBeUndefined();
    expect(both.headers.via).toBeUndefined();
    expect(both.headers['x-forwarded-for']).toBeUndefined();
    expect(both.headers['anthropic-version']).toBe('2023-06-01');
    expect(both.headers['accept-encoding']).toBe('gzip');
    expect(both.headers.host).toBe(`127.0.0.1:${fake.port}`);
    expect(only.headers.authorization).toBe(`Bearer ${PLACEHOLDER_KEY}`);
    expect(only.headers['x-api-key']).toBeUndefined();
  });

  it('(3) without a usable key start exits 3 and creates no state', async () => {
    const c = newCase('t3');
    const fake = await makeFake();
    const run3 = await run(['start', '--upstream', fake.url, '--api-key-file', join(c.dir, 'missing.key'), '--state-dir', c.stateDir, '--port', '0']);
    expect(run3.code).toBe(3);
    expect(run3.err).toContain('no usable API key');
    expect(existsSync(c.stateDir)).toBe(false);
    const none = await run(['start', '--upstream', fake.url, '--state-dir', c.stateDir, '--port', '0']);
    expect(none.code).toBe(3);
    expect(existsSync(c.stateDir)).toBe(false);
    const blank = join(c.dir, 'blank.key');
    writeFileSync(blank, '   \n');
    const empty = await run(['start', '--upstream', fake.url, '--api-key-file', blank, '--state-dir', c.stateDir, '--port', '0']);
    expect(empty.code).toBe(3);
    expect(empty.err).not.toContain(PLACEHOLDER_KEY);
  });

  it('(4) throttling is retried until the provider answers; counters show the retries', async () => {
    const c = newCase('t4');
    const fake = await makeFake((rec, req, res, n) => {
      if (n <= 2) {
        res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' });
        res.end('{"error":"rate limited"}');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }
    });
    expect((await start(c, fake)).code).toBe(0);
    const answer = await call(c);
    expect(answer.status).toBe(200);
    expect(answer.text).toBe('{"ok":true}');
    expect(fake.requests).toHaveLength(3);
    const counters = (await status(c)).counters;
    expect(counters.retry_attempts).toBeGreaterThanOrEqual(2);
    expect(counters.rate_limit_429).toBeGreaterThanOrEqual(2);
    expect(counters.retry_successes).toBe(1);
  });

  it('(5) a 429 that matches a non-retryable pattern is passed on after one attempt; an unmatched 429 is retried', async () => {
    const c = newCase('t5');
    const bodies = [
      '{"error":{"code":1311,"message":"no access to the model"}}',
      'Weekly usage limit reached',
    ];
    const fake = await makeFake((rec, req, res, n) => {
      if (n <= bodies.length) {
        res.writeHead(429, { 'content-type': 'text/plain' });
        res.end(bodies[n - 1]);
      } else {
        res.writeHead(200);
        res.end('ok');
      }
    });
    const patterns = ['--non-retryable-pattern', '"code"\\s*:\\s*1311', '--non-retryable-pattern', 'usage limit', '--retry-base-delay-ms', '2000', '--retry-max-delay-ms', '4000'];
    expect((await start(c, fake, patterns)).code).toBe(0);
    for (let i = 0; i < bodies.length; i++) {
      const answer = await call(c);
      expect(answer.status).toBe(429);
      expect(answer.text).toBe(bodies[i]);
      expect(answer.ms).toBeLessThan(1000);
      expect(fake.requests).toHaveLength(i + 1);
    }
    const counters = (await status(c)).counters;
    expect(counters.retry_attempts).toBe(0);
    expect(counters.rate_limit_429).toBe(2);
  });

  it('(5b) a compressed 429 body is decoded for matching and the client receives the original bytes', async () => {
    const c = newCase('t5b');
    const compressed = zlib.gzipSync('{"error":{"code":1311}}');
    const fake = await makeFake((rec, req, res) => {
      res.writeHead(429, { 'content-encoding': 'gzip', 'content-type': 'application/json' });
      res.end(compressed);
    });
    expect((await start(c, fake, ['--non-retryable-pattern', '"code"\\s*:\\s*1311'])).code).toBe(0);
    const answer = await call(c);
    expect(answer.status).toBe(429);
    expect(answer.raw.equals(compressed)).toBe(true);
    expect(fake.requests).toHaveLength(1);
  });

  it('(6) Retry-After is honored and clamped; a date in the past retries at once', async () => {
    const c = newCase('t6');
    const first = ['2', 'Thu, 01 Jan 1970 00:00:00 GMT'];
    let index = 0;
    const fake = await makeFake((rec, req, res, n) => {
      if (n % 2 === 1) {
        res.writeHead(429, { 'retry-after': first[index++] });
        res.end('slow down');
      } else {
        res.writeHead(200);
        res.end('ok');
      }
    });
    expect((await start(c, fake, ['--retry-after-cap-ms', '400', '--retry-base-delay-ms', '5000', '--retry-max-delay-ms', '5000'])).code).toBe(0);
    const clamped = await call(c);
    expect(clamped.status).toBe(200);
    expect(clamped.ms).toBeGreaterThanOrEqual(350);
    expect(clamped.ms).toBeLessThan(2500);
    const past = await call(c);
    expect(past.status).toBe(200);
    expect(past.ms).toBeLessThan(300);
  });

  it('(7) backoff arithmetic: 1, 2, 4, 30, 30, 30 seconds; never zero or negative', () => {
    expect([0, 1, 2, 5, 40, 200].map((n) => backoffDelayMs(n, 1000, 30000))).toEqual([1000, 2000, 4000, 30000, 30000, 30000]);
    for (let n = 0; n <= 10000; n++) {
      const delay = backoffDelayMs(n, 1000, 30000);
      if (!(delay > 0 && delay <= 30000)) throw new Error(`bad delay ${delay} for n=${n}`);
    }
  });

  it('(8) the retry limit ends with the last provider answer after 3 attempts', async () => {
    const c = newCase('t8');
    const fake = await makeFake((rec, req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('x');
    });
    expect((await start(c, fake, ['--retry-max-attempts', '2'])).code).toBe(0);
    const answer = await call(c);
    expect(answer.status).toBe(503);
    expect(answer.text).toBe('x');
    expect(fake.requests).toHaveLength(3);
  });

  it('(9) transport failures end with 502 after the configured retries; closing the client stops an unlimited loop', async () => {
    const c = newCase('t9');
    const fake = await makeFake();
    const port = fake.port;
    expect((await start(c, fake, ['--retry-max-attempts', '1'])).code).toBe(0);
    await fake.close();
    const refused = await call(c);
    expect(refused.status).toBe(502);

    const d = newCase('t9-loop');
    const again = await makeFake(undefined, port);
    expect((await start(d, again, ['--retry-base-delay-ms', '50', '--retry-max-delay-ms', '100'])).code).toBe(0);
    await again.close();
    const pending = call(d);
    await sleep(300);
    pending.abort();
    await pending;
    await sleep(500);
    const revived = await makeFake(undefined, port);
    await sleep(700);
    expect(revived.requests).toHaveLength(0);
  });

  it('(10) a 4xx other than 429 is final and passed through with its body', async () => {
    const c = newCase('t10');
    const fake = await makeFake((rec, req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"bad request"}');
    });
    expect((await start(c, fake)).code).toBe(0);
    const answer = await call(c);
    expect(answer.status).toBe(400);
    expect(answer.text).toBe('{"error":"bad request"}');
    expect(fake.requests).toHaveLength(1);
    expect((await status(c)).counters.retry_attempts).toBe(0);
  });

  it('(11) a server-sent event reaches the client before the provider has finished', async () => {
    const c = newCase('t11');
    const times = {};
    const fake = await makeFake((rec, req, res) => {
      sse(res);
      res.write('data: one\n\n');
      times.first = Date.now();
      setTimeout(() => {
        times.second = Date.now();
        res.end('data: two\n\n');
      }, 400);
    });
    expect((await start(c, fake)).code).toBe(0);
    let firstSeen = 0;
    const answer = await call(c, { onChunk: (chunk, at) => { if (!firstSeen && chunk.toString().includes('one')) firstSeen = at; } });
    expect(answer.text).toContain('data: two');
    expect(firstSeen).toBeGreaterThan(0);
    expect(firstSeen - times.first).toBeLessThan(250);
    expect(firstSeen).toBeLessThan(times.second);
  }, 20000);

  it('(12) never more requests in flight than the limit, exactly the limit at some moment, all clients served', async () => {
    const c = newCase('t12');
    const fake = await makeFake((rec, req, res) => {
      setTimeout(() => { res.writeHead(200); res.end('ok'); }, 600);
    });
    expect((await start(c, fake, ['--max-concurrency', '3'])).code).toBe(0);
    const calls = Array.from({ length: 8 }, () => call(c));
    await sleep(250);
    const sample = await health(c);
    expect(sample.active).toBe(3);
    expect(sample.queued).toBe(5);
    const answers = await Promise.all(calls);
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(fake.maxInflight).toBe(3);
  });

  it('(13) a request aborted while queued never reaches the provider', async () => {
    const c = newCase('t13');
    const fake = await makeFake((rec, req, res) => {
      setTimeout(() => { res.writeHead(200); res.end('ok'); }, 700);
    });
    expect((await start(c, fake, ['--max-concurrency', '1'])).code).toBe(0);
    const first = call(c);
    await sleep(100);
    const second = call(c);
    await sleep(150);
    second.abort();
    expect((await first).status).toBe(200);
    await sleep(400);
    expect(fake.requests).toHaveLength(1);
    const counters = (await status(c)).counters;
    expect(counters.active).toBe(0);
  });

  it('(14) a client that aborts during a stream closes the provider connection and frees the permit', async () => {
    const c = newCase('t14');
    const fake = await makeFake((rec, req, res) => {
      sse(res);
      res.write('data: first\n\n');
    });
    expect((await start(c, fake, ['--max-concurrency', '1'])).code).toBe(0);
    let seen = false;
    const handle = {};
    handle.pending = call(c, { onChunk: () => { if (!seen) { seen = true; setTimeout(() => handle.pending.abort(), 50); } } });
    await handle.pending;
    const closed = await waitFor(() => fake.requests[0] && fake.requests[0].closedAt, 3000);
    expect(closed).toBeTruthy();
    expect(fake.requests[0].completed).toBe(false);
    const active = await waitFor(async () => (await status(c)).counters.active === 0, 3000);
    expect(active).toBe(true);
  });

  it('(15) a body above the limit gets 413 and the provider sees nothing', async () => {
    const c = newCase('t15');
    const fake = await makeFake();
    expect((await start(c, fake, ['--max-body-bytes', '1024'])).code).toBe(0);
    const answer = await call(c, { body: 'x'.repeat(4096) });
    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.text).error.message).toContain('too large');
    expect(fake.requests).toHaveLength(0);
    expect((await call(c, { body: 'x'.repeat(100) })).status).toBe(200);
  });

  it('(16) the base path and the query string reach the provider as one joined path', async () => {
    const c = newCase('t16');
    const fake = await makeFake();
    const run16 = await run(startArgs(c, { url: `${fake.url}/prefix/` }));
    expect(run16.code, run16.err).toBe(0);
    const answer = await call(c, { path: '/v1/messages?beta=true', method: 'GET' });
    expect(answer.status, answer.error).toBe(200);
    expect(fake.requests[0].url).toBe('/prefix/v1/messages?beta=true');
    expect(fake.requests[0].headers['content-length']).toBeUndefined();
    expect(readFileSync(join(c.stateDir, 'proxy.target'), 'utf8').trim()).toBe(`${fake.url}/prefix`);
  });

  it('(17) /health has every field and no key; the counters file exists at start, stays valid and survives stop', async () => {
    const c = newCase('t17');
    const fake = await makeFake();
    expect((await start(c, fake)).code).toBe(0);
    const counters = join(c.stateDir, 'counters.json');
    expect(JSON.parse(readFileSync(counters, 'utf8')).total_requests).toBe(0);
    await call(c);
    await waitFor(() => JSON.parse(readFileSync(counters, 'utf8')).total_requests === 1, 3000);
    const written = JSON.parse(readFileSync(counters, 'utf8'));
    expect(written.total_requests).toBe(1);
    for (const field of ['ts', 'started_at', 'limit', 'total_requests', 'active', 'retry_attempts', 'retry_successes', 'rate_limit_429']) {
      expect(written).toHaveProperty(field);
    }
    const health = await new Promise((done) => {
      http.get({ host: '127.0.0.1', port: proxyPort(c), path: '/health' }, (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => done({ status: res.statusCode, type: res.headers['content-type'], text }));
      });
    });
    expect(health.status).toBe(200);
    expect(health.type).toContain('application/json');
    const doc = JSON.parse(health.text);
    for (const field of ['status', 'port', 'upstream', 'limit', 'active', 'queued', 'total_requests', 'uptime_sec', 'retry_attempts', 'retry_successes', 'rate_limit_429']) {
      expect(doc).toHaveProperty(field);
    }
    expect(doc.total_requests).toBe(1);
    expect(health.text).not.toContain(PLACEHOLDER_KEY);
    await run(['stop', '--state-dir', c.stateDir]);
    expect(existsSync(counters)).toBe(true);
  });

  it('(18) idle shutdown removes the state files; a stream longer than the idle timeout is not cut', async () => {
    const c = newCase('t18');
    const fake = await makeFake((rec, req, res) => {
      sse(res);
      let sent = 0;
      const timer = setInterval(() => {
        sent++;
        res.write(`data: ${sent}\n\n`);
        if (sent === 10) {
          clearInterval(timer);
          res.end();
        }
      }, 500);
    });
    expect((await start(c, fake, ['--idle-timeout', '2'])).code).toBe(0);
    const pid = proxyPid(c);
    const answer = await call(c);
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('data: 10');
    expect(processAlive(pid)).toBe(true);
    const gone = await waitFor(() => !processAlive(pid), 8000, 100);
    expect(gone).toBe(true);
    for (const name of ['proxy.pid', 'proxy.port', 'proxy.target']) expect(existsSync(join(c.stateDir, name))).toBe(false);
    expect(existsSync(join(c.stateDir, 'counters.json'))).toBe(true);
  }, 30000);

  it('(19) stop ends the server, keeps counters.json and is idempotent', async () => {
    const c = newCase('t19');
    const fake = await makeFake();
    expect((await start(c, fake)).code).toBe(0);
    const pid = proxyPid(c);
    const began = Date.now();
    const stopped = await run(['stop', '--state-dir', c.stateDir]);
    expect(stopped.code).toBe(0);
    expect(stopped.out).toContain(`stopped pid=${pid}`);
    expect(Date.now() - began).toBeLessThan(5000);
    expect(processAlive(pid)).toBe(false);
    for (const name of ['proxy.pid', 'proxy.port', 'proxy.target']) expect(existsSync(join(c.stateDir, name))).toBe(false);
    expect(existsSync(join(c.stateDir, 'counters.json'))).toBe(true);
    const again = await run(['stop', '--state-dir', c.stateDir]);
    expect(again.code).toBe(0);
    expect(again.out).toContain('not running');
  });

  it('(20) after SIGKILL status reports not running without deleting files and start recovers on the same port', async () => {
    const c = newCase('t20');
    const fake = await makeFake();
    const port = await freePort();
    expect((await start(c, fake, ['--port', String(port)])).code).toBe(0);
    const pid = proxyPid(c);
    process.kill(pid, 'SIGKILL');
    await waitFor(() => !processAlive(pid), 3000);
    const after = await run(['status', '--state-dir', c.stateDir]);
    expect(after.code).toBe(1);
    expect(existsSync(join(c.stateDir, 'proxy.pid'))).toBe(true);
    const restarted = await start(c, fake, ['--port', String(port)]);
    expect(restarted.code, restarted.err).toBe(0);
    expect(proxyPid(c)).not.toBe(pid);
    expect(proxyPort(c)).toBe(port);
  });

  it('(21) a pid file that points at an unrelated live process means not running, and that process is left alone', async () => {
    const c = newCase('t21');
    const fake = await makeFake();
    mkdirSync(c.stateDir, { recursive: true });
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      writeFileSync(join(c.stateDir, 'proxy.pid'), `${stranger.pid}\n`);
      writeFileSync(join(c.stateDir, 'proxy.port'), '45999\n');
      writeFileSync(join(c.stateDir, 'proxy.target'), `${fake.url}\n`);
      expect((await run(['status', '--state-dir', c.stateDir])).code).toBe(1);
      const started = await start(c, fake);
      expect(started.out).toMatch(/^started /);
      expect(proxyPid(c)).not.toBe(stranger.pid);
      expect(processAlive(stranger.pid)).toBe(true);
    } finally {
      stranger.kill('SIGKILL');
    }
  });

  it('(22) ten simultaneous starts leave exactly one server', async () => {
    const c = newCase('t22');
    const fake = await makeFake();
    const results = await Promise.all(Array.from({ length: 10 }, () => start(c, fake)));
    expect(results.every((r) => r.code === 0 || r.code === 3)).toBe(true);
    expect(results.some((r) => r.code === 0)).toBe(true);
    const pids = new Set(results.flatMap((r) => [...r.out.matchAll(/pid=(\d+)/g)].map((m) => m[1])));
    expect(pids.size).toBe(1);
    expect(serverProcesses(c.stateDir)).toHaveLength(1);
    expect(String(proxyPid(c))).toBe([...pids][0]);
  }, 60000);

  it('(23) a start with another upstream replaces the running server', async () => {
    const c = newCase('t23');
    const a = await makeFake();
    const b = await makeFake();
    expect((await start(c, a)).code).toBe(0);
    const old = proxyPid(c);
    const replaced = await start(c, b);
    expect(replaced.out).toMatch(/^started /);
    expect(readFileSync(join(c.stateDir, 'proxy.target'), 'utf8').trim()).toBe(b.url);
    expect(proxyPid(c)).not.toBe(old);
    expect(processAlive(old)).toBe(false);
    await call(c);
    expect(a.requests).toHaveLength(0);
    expect(b.requests).toHaveLength(1);
  });

  it('(24) a port that is already in use makes start fail fast and point at the output file', async () => {
    const c = newCase('t24');
    const fake = await makeFake();
    const holder = net.createServer();
    await new Promise((done) => holder.listen(0, '127.0.0.1', done));
    try {
      const began = Date.now();
      const failed = await start(c, fake, ['--port', String(holder.address().port)]);
      expect(failed.code).toBe(1);
      expect(Date.now() - began).toBeLessThan(8000);
      expect(failed.err).toContain('server.out');
      expect(readFileSync(join(c.stateDir, 'server.out'), 'utf8')).toContain('cannot listen');
      expect(existsSync(join(c.stateDir, 'start.lock'))).toBe(false);
    } finally {
      holder.close();
    }
  });

  it('(25) neither the key nor the client credential appears in logs, output files, /health or the server arguments', async () => {
    const c = newCase('t25');
    const fake = await makeFake((rec, req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(`{"error":"bad key ${PLACEHOLDER_KEY}","api_key":"${PLACEHOLDER_KEY}","authorization":"Bearer ${CLIENT_CREDENTIAL}"}`);
    });
    expect((await start(c, fake, ['--retry-max-attempts', '1'])).code).toBe(0);
    await call(c, { headers: { 'x-api-key': CLIENT_CREDENTIAL } });
    const pid = proxyPid(c);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const texts = [cmdline];
    for (const name of readdirSync(c.stateDir)) {
      const file = join(c.stateDir, name);
      try {
        if (statSync(file).isFile()) texts.push(readFileSync(file, 'utf8'));
      } catch { /* an atomic temp file of the counters write was renamed between the listing and the read */ }
    }
    for (const secret of [PLACEHOLDER_KEY, CLIENT_CREDENTIAL]) {
      for (const text of texts) expect(text).not.toContain(secret);
    }
    expect(readFileSync(join(c.stateDir, 'proxy.log'), 'utf8')).toContain('held status=429');
    expect(statSync(join(c.stateDir, 'proxy.log')).mode & 0o777).toBe(0o600);
    expect(statSync(join(c.stateDir, 'server.out')).mode & 0o777).toBe(0o600);
    expect(statSync(c.stateDir).mode & 0o777).toBe(0o700);
  });

  it('(26) a foreign Host header gets 403 and a wrong client token gets 401, without taking a permit', async () => {
    const c = newCase('t26');
    const fake = await makeFake();
    expect((await start(c, fake, [], { token: 'correct-shared-secret' })).code).toBe(0);
    const foreign = await call(c, { host: 'attacker.example', headers: { authorization: 'Bearer correct-shared-secret' } });
    expect(foreign.status).toBe(403);
    const local = await call(c, { host: `localhost:${proxyPort(c)}`, headers: { authorization: 'Bearer correct-shared-secret' } });
    expect(local.status).toBe(200);
    const wrong = await call(c, { headers: { authorization: 'Bearer wrong' } });
    expect(wrong.status).toBe(401);
    const viaKeyHeader = await call(c, { headers: { authorization: 'Bearer wrong', 'x-api-key': 'correct-shared-secret' } });
    expect(viaKeyHeader.status).toBe(200);
    expect(fake.requests).toHaveLength(2);
    expect((await status(c)).counters.total_requests).toBe(2);
  });

  it('(27) an insecure upstream or an upstream from the environment that is not loopback exits 2', async () => {
    const c = newCase('t27');
    const fake = await makeFake();
    const base = ['--api-key-file', c.keyFile, '--state-dir', c.stateDir, '--port', '0'];
    expect((await run(['start', '--upstream', 'http://example.com', ...base])).code).toBe(2);
    expect((await run(['start', '--upstream', 'ftp://127.0.0.1:1', ...base])).code).toBe(2);
    expect((await run(['start', '--upstream', 'https://user:pw@example.com', ...base])).code).toBe(2);
    expect((await run(['start', ...base], { env: { OMC_PROVIDER_PROXY_TEST_UPSTREAM: 'https://example.com' } })).code).toBe(2);
    expect((await run(['start', ...base], { env: { OMC_PROVIDER_PROXY_UPSTREAM: 'https://example.com' } })).code).toBe(2);
    expect(existsSync(c.stateDir)).toBe(false);
    const accepted = await run(['start', '--upstream', fake.url, ...base, '--client-token', 'none']);
    expect(accepted.code, accepted.err).toBe(0);
    await run(['stop', '--state-dir', c.stateDir]);
    const viaEnv = await run(['start', ...base, '--client-token', 'none'], { env: { OMC_PROVIDER_PROXY_TEST_UPSTREAM: fake.url } });
    expect(viaEnv.code, viaEnv.err).toBe(0);
  });

  it('(28) the automatic client token is created once, required from clients and kept out of arguments, logs and /health', async () => {
    const c = newCase('t28');
    const fake = await makeFake();
    expect((await start(c, fake, [], { token: null })).code).toBe(0);
    const file = join(c.stateDir, 'client-token');
    const token = readFileSync(file, 'utf8').trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await start(c, fake, [], { token: null })).out).toContain('already running');
    expect(readFileSync(file, 'utf8').trim()).toBe(token);
    const denied = await call(c, { headers: { authorization: 'Bearer nope' } });
    expect(denied.status).toBe(401);
    expect(fake.requests).toHaveLength(0);
    expect((await status(c)).counters.total_requests).toBe(0);
    const granted = await call(c, { headers: { authorization: `Bearer ${token}` } });
    expect(granted.status).toBe(200);
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${PLACEHOLDER_KEY}`);
    const pid = proxyPid(c);
    const texts = [readFileSync(`/proc/${pid}/cmdline`, 'utf8')];
    for (const name of ['proxy.log', 'counters.json', 'server.out']) texts.push(readFileSync(join(c.stateDir, name), 'utf8'));
    texts.push(JSON.stringify(await status(c)));
    for (const text of texts) expect(text).not.toContain(token);
    await run(['stop', '--state-dir', c.stateDir]);
    expect((await start(c, fake, [], { token: null })).code).toBe(0);
    expect(readFileSync(file, 'utf8').trim()).toBe(token);
  });

  it('(29) the server listens on the loopback address only', async () => {
    const c = newCase('t29');
    const fake = await makeFake();
    expect((await start(c, fake)).code).toBe(0);
    const hexPort = proxyPort(c).toString(16).toUpperCase().padStart(4, '0');
    const rows = readFileSync('/proc/net/tcp', 'utf8').split('\n').filter((line) => line.includes(`:${hexPort} `) && / 0A /.test(line));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.trim().split(/\s+/)[1]).toBe(`0100007F:${hexPort}`);
    const six = existsSync('/proc/net/tcp6') ? readFileSync('/proc/net/tcp6', 'utf8') : '';
    expect(six.split('\n').filter((line) => line.includes(`:${hexPort} `) && / 0A /.test(line))).toHaveLength(0);
  });

  it('(31) a profile supplies the upstream, the key, the limit and the patterns; the environment and the command line override it in that order', async () => {
    const dir = join(tmp.dir, 'profile-case');
    mkdirSync(dir, { recursive: true });
    const fake = await makeFake((rec, req, res) => {
      res.writeHead(429);
      res.end('{"error":{"code":1311}}');
    });
    const { env } = writeProfile(dir, {
      baseUrl: fake.url,
      proxy: { maxConcurrency: 2, clientToken: 'none', nonRetryableBodyPatterns: ['"code"\\s*:\\s*1311'] },
    });
    const stateDir = join(dir, 'state', 'proxy');
    const first = await run(['start', '--profile', 'acme', '--port', '0'], { env });
    expect(first.code, first.err).toBe(0);
    expect(first.out).toContain('limit=2');
    expect(existsSync(join(stateDir, 'proxy.pid'))).toBe(true);
    const info = JSON.parse((await run(['status', '--json', '--profile', 'acme'], { env })).out);
    expect(info.running).toBe(true);
    const answer = await new Promise((done) => {
      const req = http.request({ host: '127.0.0.1', port: info.port, method: 'POST', path: '/x', headers: { authorization: 'Bearer x' } }, (res) => {
        res.resume();
        res.on('end', () => done(res.statusCode));
      });
      req.end('{}');
    });
    expect(answer).toBe(429);
    expect(fake.requests).toHaveLength(1);
    expect((await run(['stop', '--profile', 'acme'], { env })).code).toBe(0);
    const viaEnv = await run(['start', '--profile', 'acme', '--port', '0'], { env: { ...env, OMC_PROVIDER_PROXY_MAX_CONCURRENCY: '3' } });
    expect(viaEnv.out).toContain('limit=3');
    await run(['stop', '--profile', 'acme'], { env });
    const viaFlag = await run(['start', '--profile', 'acme', '--port', '0', '--max-concurrency', '5'], { env: { ...env, OMC_PROVIDER_PROXY_MAX_CONCURRENCY: '3' } });
    expect(viaFlag.out).toContain('limit=5');
  });

  it('(33) retry parameters from the profile apply: a limit of one retry gives two upstream requests and the last 429 is passed on', async () => {
    const dir = join(tmp.dir, 'profile-retry');
    mkdirSync(dir, { recursive: true });
    const fake = await makeFake((rec, req, res) => {
      res.writeHead(429);
      res.end('{"error":{"message":"slow down"}}');
    });
    const { env } = writeProfile(dir, {
      baseUrl: fake.url,
      proxy: { clientToken: 'none', retryMaxAttempts: 1, retryBaseDelayMs: 5, retryMaxDelayMs: 5 },
    });
    const first = await run(['start', '--profile', 'acme', '--port', '0'], { env });
    expect(first.code, first.err).toBe(0);
    const info = JSON.parse((await run(['status', '--json', '--profile', 'acme'], { env })).out);
    const answer = await new Promise((done) => {
      const req = http.request({ host: '127.0.0.1', port: info.port, method: 'POST', path: '/x', headers: { authorization: 'Bearer x' } }, (res) => {
        res.resume();
        res.on('end', () => done(res.statusCode));
      });
      req.end('{}');
    });
    expect(answer).toBe(429);
    expect(fake.requests).toHaveLength(2);
    expect((await run(['stop', '--profile', 'acme'], { env })).code).toBe(0);
  });

  it('(34) concurrent requests with different paths and methods are each retried under their own path, method and body', async () => {
    const c = newCase('t34');
    const firstHits = new Map();
    const fake = await makeFake((rec, req, res) => {
      const hit = (firstHits.get(rec.url) ?? 0) + 1;
      firstHits.set(rec.url, hit);
      if (hit === 1 && rec.url === '/v1/a') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end('{"error":"slow down"}');
      } else if (hit === 1 && rec.url === '/v1/c') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":"unavailable"}');
      } else if (hit === 1 && rec.url === '/v1/d?x=1') {
        res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' });
        res.end('{"error":"slow down"}');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ served: `${rec.method} ${rec.url}`, body: rec.body }));
      }
    });
    expect((await start(c, fake, ['--retry-base-delay-ms', '400', '--retry-max-delay-ms', '400'])).code).toBe(0);

    const requests = [
      { method: 'POST', path: '/v1/a', body: '{"req":"A"}' },
      { method: 'GET', path: '/v1/b' },
      { method: 'PUT', path: '/v1/c', body: '{"req":"C"}' },
      { method: 'DELETE', path: '/v1/d?x=1', body: '' },
    ];
    const answers = [];
    for (const request of requests) {
      answers.push(call(c, request));
      await sleep(60);
    }
    const results = await Promise.all(answers);

    results.forEach((answer, index) => {
      const { method, path, body } = requests[index];
      expect(answer.status, `${method} ${path}`).toBe(200);
      expect(JSON.parse(answer.text)).toEqual({ served: `${method} ${path}`, body: body ?? '' });
    });
    // The provider saw every body only under the request it belongs to, and the throttled or
    // failing requests were retried exactly once each.
    const seenBy = (url) => fake.requests.filter((r) => r.url === url);
    expect(seenBy('/v1/a').map((r) => `${r.method} ${r.body}`)).toEqual(['POST {"req":"A"}', 'POST {"req":"A"}']);
    expect(seenBy('/v1/b').map((r) => `${r.method} ${r.body}`)).toEqual(['GET ']);
    expect(seenBy('/v1/c').map((r) => `${r.method} ${r.body}`)).toEqual(['PUT {"req":"C"}', 'PUT {"req":"C"}']);
    expect(seenBy('/v1/d?x=1').map((r) => `${r.method} ${r.body}`)).toEqual(['DELETE ', 'DELETE ']);
    expect(fake.requests).toHaveLength(7);
  });

  it('(32) without a start nothing runs and the control commands create no state', async () => {
    const c = newCase('t32');
    const status32 = await run(['status', '--state-dir', c.stateDir]);
    expect(status32.code).toBe(1);
    expect(status32.out).toContain('not running');
    const stop32 = await run(['stop', '--state-dir', c.stateDir]);
    expect(stop32.code).toBe(0);
    expect(existsSync(c.stateDir)).toBe(false);
    expect((await run(['start', '--api-key-file', c.keyFile, '--state-dir', c.stateDir])).code).toBe(2);
    expect((await run(['bogus'])).code).toBe(2);
    expect(serverProcesses(c.dir)).toEqual([]);
  });
});
